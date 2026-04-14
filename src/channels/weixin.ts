/**
 * Weixin (微信) messaging channel using the open platform API.
 *
 * Uses QR code login to authenticate, then polls for updates via long polling
 * (getUpdates API). Messages are sent via the sendMessage API.
 *
 * A sync buffer is persisted to disk to avoid re-processing messages
 * across restarts.
 */

import type { Channel, InboundMessage, OutboundMessage, ImageAttachment } from "../types.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "@tencent-weixin/openclaw-weixin/src/auth/login-qr.js";
import { getUpdates, sendMessage as sendMessageApi, sendTyping, getConfig } from "@tencent-weixin/openclaw-weixin/src/api/api.js";
import { MessageItemType, MessageType, MessageState } from "@tencent-weixin/openclaw-weixin/src/api/types.js";
import type { WeixinMessage, MessageItem, ImageItem } from "@tencent-weixin/openclaw-weixin/src/api/types.js";
import { DEFAULT_BASE_URL } from "@tencent-weixin/openclaw-weixin/src/auth/accounts.js";
import { downloadAndDecryptBuffer } from "@tencent-weixin/openclaw-weixin/src/cdn/pic-decrypt.js";
import { StreamingMarkdownFilter } from "@tencent-weixin/openclaw-weixin/src/messaging/send.js";
import type { WeixinChannelConfig } from "./weixin-types.js";
import qrcodeTerminal from "qrcode-terminal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logger from "../utils/logger.js";
import { bufferToImageAttachment } from "../utils/image.js";

const CONFIG_DIR = path.join(os.homedir(), ".jiegeclaw");
const SYNC_BUF_PATH = path.join(CONFIG_DIR, "weixin-sync-buf.txt");

/** Load the sync buffer from disk, or return empty string if it doesn't exist. */
function loadSyncBuf(): string {
  try {
    return fs.readFileSync(SYNC_BUF_PATH, "utf-8");
  } catch {
    return "";
  }
}

/** Persist the sync buffer to disk so we can resume polling after restarts. */
function saveSyncBuf(buf: string): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SYNC_BUF_PATH, buf, { mode: 0o600, encoding: "utf-8" });
}

/**
 * Extract text content from a Weixin message's item list.
 * Handles both text items and voice-to-text items.
 */
function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  let res = "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text !== undefined) {
      res += item.text_item.text + "\n";
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text !== undefined) {
      res += item.voice_item.text + "\n";
    }
  }
  return res.trim();
}

/**
 * Extract image items from a Weixin message's item list.
 */
function extractImages(itemList?: MessageItem[]): ImageItem[] {
  if (!itemList?.length) return [];
  const images: ImageItem[] = [];
  for (const item of itemList) {
    if (item.type === MessageItemType.IMAGE && item.image_item) {
      images.push(item.image_item);
    }
  }
  return images;
}

export class WeixinChannel implements Channel {
  readonly id: string;
  private token: string;
  private accountId: string;
  private abortController?: AbortController;
  /** Cache of typing tickets per user (userId -> typingTicket) */
  private typingTickets: Map<string, string> = new Map();

  constructor(config: WeixinChannelConfig) {
    this.id = config.accountId;
    this.token = config.token;
    this.accountId = config.accountId;
  }

  /**
   * Interactive setup: perform QR code login.
   * Displays a QR code in the terminal and waits for the user to scan it.
   * Returns the channel config with token, accountId, and userId.
   */
  static async onboard(): Promise<WeixinChannelConfig> {
    logger.info("Starting Weixin QR login...");
    const startResult = await startWeixinLoginWithQr({
      apiBaseUrl: DEFAULT_BASE_URL,
    });

    if (!startResult.qrcodeUrl) {
      throw new Error(`Failed to get QR code: ${startResult.message}`);
    }

    // Display the QR code in the terminal
    logger.info("Scan the QR code with Weixin:\n");
    await new Promise<void>((resolve) => {
      qrcodeTerminal.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        logger.info(`\n${qr}`);
        logger.info("Or open this URL to scan:");
        logger.info(startResult.qrcodeUrl!);
        resolve();
      });
    });

    // Wait for the user to scan the QR code and approve the login
    logger.info("Waiting for scan result...");
    const waitResult = await waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: DEFAULT_BASE_URL,
    });

    if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId || !waitResult.userId) {
      throw new Error(`Login failed: ${waitResult.message}`);
    }

    logger.info("Weixin connected successfully!");

    return {
      type: "weixin",
      token: waitResult.botToken,
      accountId: waitResult.accountId,
      userId: waitResult.userId,
    };
  }

  /**
   * Start polling for Weixin messages using long polling (getUpdates).
   * The sync buffer is used to avoid re-processing messages seen in previous polls.
   * Runs until the abort controller is triggered by stop().
   */
  async listen(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.abortController = new AbortController();
    let getUpdatesBuf = loadSyncBuf();

    logger.info(`Listening for Weixin messages (account: ${this.accountId})...`);

    let timeoutMs = 35_000;
    while (!this.abortController.signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: DEFAULT_BASE_URL,
          token: this.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: timeoutMs,
        });

        if (resp.ret !== undefined && resp.ret !== 0) {
          logger.error(`getUpdates error: ret=${resp.ret} errmsg=${resp.errmsg}`);
          await sleep(5000, this.abortController.signal);
          continue;
        }

        if (resp.errcode !== undefined && resp.errcode !== 0) {
          logger.error(`getUpdates error: errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          await sleep(5_000, this.abortController.signal);
          continue;
        }

        // Persist the sync buffer to avoid re-processing on restart
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
        }

        // Respect long polling timeout from server
        if (resp.longpolling_timeout_ms !== undefined) {
          timeoutMs = resp.longpolling_timeout_ms;
        }

        // Process each new message
        for (const raw of resp.msgs ?? []) {
          if (!isUserMessage(raw)) continue;

          const text = extractText(raw.item_list);
          const imageItems = extractImages(raw.item_list);

          // Skip if no text and no images
          if (text.trim().length === 0 && imageItems.length === 0) continue;

          logger.info(`[${this.id}] Received message from ${raw.from_user_id}: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"${imageItems.length ? ` +${imageItems.length} image(s)` : ""}`);

          // Download all images
          const images: ImageAttachment[] = [];
          for (const imageItem of imageItems) {
            const image = await this.downloadImage(imageItem);
            if (image) {
              images.push(image);
            }
          }

          onMessage({
            from: raw.from_user_id ?? "",
            text,
            contextToken: raw.context_token ? { channel: "weixin", contextToken: raw.context_token } : undefined,
            images: images.length > 0 ? images : undefined,
          });
        }
      } catch (err) {
        if (this.abortController.signal.aborted) break;
        logger.error(`getUpdates error: ${(err as Error).message}`);
        await sleep(5000, this.abortController.signal);
      }
    }
  }

  /**
   * Send a message to a Weixin user.
   * Messages are sent as BOT type with FINISH state (no streaming).
   * Markdown is converted to plain text since Weixin doesn't support markdown.
   * The contextToken is forwarded for in-thread reply context.
   */
  async send(msg: OutboundMessage): Promise<void> {
    const clientId = crypto.randomUUID();
    // Convert markdown to plain text for Weixin using StreamingMarkdownFilter
    const filter = new StreamingMarkdownFilter();
    const plainText = filter.feed(msg.text) + filter.flush();
    const itemList = plainText
      ? [{ type: MessageItemType.TEXT, text_item: { text: plainText } }]
      : [];

    logger.info(`[${this.id}] Sending to ${msg.to} (${plainText.length} chars): "${plainText.slice(0, 100)}${plainText.length > 100 ? "..." : ""}"`);

    await sendMessageApi({
      baseUrl: DEFAULT_BASE_URL,
      token: this.token,
      timeoutMs: 15_000,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: msg.to,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: itemList.length ? itemList : undefined,
          context_token: msg.contextToken?.channel === "weixin" ? msg.contextToken.contextToken : undefined,
        },
      },
    });
  }

  /**
   * Streaming send for Weixin.
   * Weixin doesn't support true streaming, but we can send a "typing" indicator
   * while generating content, then send the final message when finish=true.
   */
  async streamSend(streamId: string, msg: OutboundMessage, finish: boolean): Promise<void> {
    if (finish) {
      await this.send(msg);
    } else {
      // Get or refresh typing ticket for this user
      let typingTicket = this.typingTickets.get(msg.to);
      if (!typingTicket) {
        try {
          const config = await getConfig({
            baseUrl: DEFAULT_BASE_URL,
            token: this.token,
            ilinkUserId: msg.to,
            contextToken: msg.contextToken?.channel === "weixin" ? msg.contextToken.contextToken : undefined,
          });
          if (config.typing_ticket) {
            typingTicket = config.typing_ticket;
            this.typingTickets.set(msg.to, typingTicket);
          }
        } catch (err) {
          logger.warn(`[${this.id}] Failed to get typing ticket: ${(err as Error).message}`);
        }
      }

      // Send typing indicator to show that the bot is generating a response
      if (typingTicket) {
        await sendTyping({
          baseUrl: DEFAULT_BASE_URL,
          token: this.token,
          body: {
            ilink_user_id: msg.to,
            typing_ticket: typingTicket,
            status: 1, // TYPING
          },
        });
      }
    }
  }

  /**
   * Download and decrypt an image from Weixin CDN.
   * Returns the image as an ImageAttachment or null if download fails.
   */
  private async downloadImage(imageItem: ImageItem): Promise<ImageAttachment | null> {
    try {
      const media = imageItem.media;
      if (!media?.full_url || !media.aes_key) {
        logger.warn(`[${this.id}] Image item missing required fields: full_url=${!!media?.full_url}, aes_key=${!!media?.aes_key}`);
        return null;
      }

      const buffer = await downloadAndDecryptBuffer(
        media.encrypt_query_param ?? "",
        media.aes_key,
        "", // cdnBaseUrl not needed when full_url is provided
        `[${this.id}]`,
        media.full_url
      );

      return await bufferToImageAttachment(buffer, `weixin_image_${Date.now()}`);
    } catch (err) {
      logger.error(`[${this.id}] Failed to download image: ${(err as Error).message}`);
      return null;
    }
  }

  /** Abort the long-polling loop. */
  async stop(): Promise<void> {
    this.abortController?.abort();
  }
}

/** Check if a Weixin message is a user-initiated message (type 1 with a from_user_id). */
function isUserMessage(msg: WeixinMessage): boolean {
  return msg.message_type === 1 && !!msg.from_user_id;
}

/** Sleep for the specified duration, rejecting early if the abort signal fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
