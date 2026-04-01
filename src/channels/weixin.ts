/**
 * Weixin (微信) messaging channel using the open platform API.
 *
 * Uses QR code login to authenticate, then polls for updates via long polling
 * (getUpdates API). Messages are sent via the sendMessage API.
 *
 * A sync buffer is persisted to disk to avoid re-processing messages
 * across restarts.
 */

import type { Channel, InboundMessage, OutboundMessage, WeixinContextToken } from "../types.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "@tencent-weixin/openclaw-weixin/src/auth/login-qr.js";
import { getUpdates, sendMessage as sendMessageApi } from "@tencent-weixin/openclaw-weixin/src/api/api.js";
import { MessageItemType, MessageType, MessageState } from "@tencent-weixin/openclaw-weixin/src/api/types.js";
import type { WeixinMessage, MessageItem } from "@tencent-weixin/openclaw-weixin/src/api/types.js";
import { DEFAULT_BASE_URL } from "@tencent-weixin/openclaw-weixin/src/auth/accounts.js";
import type { WeixinChannelConfig } from "./weixin-types.js";
import qrcodeTerminal from "qrcode-terminal";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import logger from "../utils/logger.js";

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
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != undefined) {
      return String(item.text_item?.text);
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export class WeixinChannel implements Channel {
  readonly id: string;
  private onConfigUpdate: (index: number, update: Partial<WeixinChannelConfig>) => void;
  private channelIndex: number;

  private token?;
  private accountId?;
  private userId?;
  private abortController?: AbortController;

  constructor(
    config: WeixinChannelConfig,
    index: number,
    onConfigUpdate: (index: number, update: Partial<WeixinChannelConfig>) => void,
  ) {
    this.channelIndex = index;
    this.onConfigUpdate = onConfigUpdate;
    this.id = config.accountId ?? `weixin-${index}`;

    if (config.token) {
      this.token = config.token;
      this.accountId = config.accountId;
      this.userId = config.userId;
    }
  }

  /**
   * Interactive setup: perform QR code login if no token is stored.
   * Displays a QR code in the terminal and waits for the user to scan it.
   * The resulting token, accountId, and userId are saved to config.
   */
  async onboard(): Promise<void> {
    if (this.token) {
      logger.info(`Weixin already configured. Account: ${this.accountId}`);
      return;
    }

    logger.info("Starting Weixin QR login...");
    const startResult = await startWeixinLoginWithQr({
      apiBaseUrl: DEFAULT_BASE_URL,
    });

    if (!startResult.qrcodeUrl) {
      throw new Error(`Failed to get QR code: ${startResult.message}`);
    }

    // Display the QR code in the terminal
    logger.info("\nScan the QR code with Weixin:\n");
    await new Promise<void>((resolve) => {
      qrcodeTerminal.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        logger.info(`\n${qr}`);
        logger.info("\nOr open this URL to scan:");
        logger.info(startResult.qrcodeUrl!);
        resolve();
      });
    });

    // Wait for the user to scan the QR code and approve the login
    logger.info("\nWaiting for scan result...");
    const waitResult = await waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: DEFAULT_BASE_URL,
    });

    if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) {
      throw new Error(`Login failed: ${waitResult.message}`);
    }

    this.token = waitResult.botToken;
    this.accountId = waitResult.accountId;
    this.userId = waitResult.userId;

    this.onConfigUpdate(this.channelIndex, {
      token: this.token,
      accountId: this.accountId,
      userId: this.userId,
    });
    logger.info("\nWeixin connected successfully!");
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

    while (!this.abortController.signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: DEFAULT_BASE_URL,
          token: this.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: 35_000,
        });

        if (resp.ret !== undefined && resp.ret !== 0) {
          logger.error(`getUpdates error: ret=${resp.ret} errmsg=${resp.errmsg}`);
          await sleep(5000, this.abortController.signal);
          continue;
        }

        // Persist the sync buffer to avoid re-processing on restart
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
        }

        // Process each new message
        for (const raw of resp.msgs ?? []) {
          if (!isUserMessage(raw)) continue;

          const text = extractText(raw.item_list);
          if (!text.trim()) continue;

          onMessage({
            id: String(raw.message_id ?? Date.now()),
            from: raw.from_user_id ?? "",
            text,
            contextToken: raw.context_token ? { channel: "weixin", contextToken: raw.context_token } : undefined,
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
   * The contextToken is forwarded for in-thread reply context.
   */
  async send(msg: OutboundMessage): Promise<void> {
    const clientId = crypto.randomUUID();
    const itemList = msg.text
      ? [{ type: MessageItemType.TEXT, text_item: { text: msg.text } }]
      : [];

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
   * Weixin doesn't support streaming, so we only send when finish=true.
   */
  async streamSend(streamId: string, msg: OutboundMessage, finish: boolean): Promise<void> {
    if (finish) {
      await this.send(msg);
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
