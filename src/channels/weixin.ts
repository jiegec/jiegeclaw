import type { Channel, InboundMessage, OutboundMessage } from "../types.js";
import { startWeixinLoginWithQr, waitForWeixinLogin } from "@tencent-weixin/openclaw-weixin/src/auth/login-qr.js";
import { getUpdates, sendMessage as sendMessageApi } from "@tencent-weixin/openclaw-weixin/src/api/api.js";
import { MessageItemType, MessageType, MessageState } from "@tencent-weixin/openclaw-weixin/src/api/types.js";
import type { WeixinMessage, MessageItem } from "@tencent-weixin/openclaw-weixin/src/api/types.js";
import { DEFAULT_BASE_URL } from "@tencent-weixin/openclaw-weixin/src/auth/accounts.js";
import type { WeixinChannelConfig } from "./weixin-types.js";
import qrcodeTerminal from "qrcode-terminal";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = path.join(os.homedir(), ".jiegeclaw");
const SYNC_BUF_PATH = path.join(DATA_DIR, "weixin-sync-buf.txt");

function loadSyncBuf(): string {
  try {
    return fs.readFileSync(SYNC_BUF_PATH, "utf-8");
  } catch {
    return "";
  }
}

function saveSyncBuf(buf: string): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SYNC_BUF_PATH, buf, "utf-8");
}

function extractText(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
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

  private token = "";
  private accountId = "";
  private userId = "";
  private abortController: AbortController | null = null;

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
      this.accountId = config.accountId ?? "";
      this.userId = config.userId ?? "";
    }
  }

  async onboard(): Promise<void> {
    if (this.token) {
      console.log(`WeChat already configured. Account: ${this.accountId}`);
      return;
    }

    console.log("Starting WeChat QR login...");
    const startResult = await startWeixinLoginWithQr({
      apiBaseUrl: DEFAULT_BASE_URL,
    });

    if (!startResult.qrcodeUrl) {
      throw new Error(`Failed to get QR code: ${startResult.message}`);
    }

    console.log("\nScan the QR code with WeChat:\n");
    await new Promise<void>((resolve) => {
      qrcodeTerminal.generate(startResult.qrcodeUrl!, { small: true }, (qr: string) => {
        console.log(qr);
        console.log("\nOr open this URL to scan:");
        console.log(startResult.qrcodeUrl!);
        resolve();
      });
    });

    console.log("\nWaiting for scan result...");
    const waitResult = await waitForWeixinLogin({
      sessionKey: startResult.sessionKey,
      apiBaseUrl: DEFAULT_BASE_URL,
    });

    if (!waitResult.connected || !waitResult.botToken || !waitResult.accountId) {
      throw new Error(`Login failed: ${waitResult.message}`);
    }

    this.token = waitResult.botToken;
    this.accountId = waitResult.accountId;
    this.userId = waitResult.userId ?? "";

    this.onConfigUpdate(this.channelIndex, {
      token: this.token,
      accountId: this.accountId,
      userId: this.userId || undefined,
    });
    console.log("\nWeChat connected successfully!");
  }

  async listen(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.abortController = new AbortController();
    let getUpdatesBuf = loadSyncBuf();

    console.log(`Listening for WeChat messages (account: ${this.accountId})...`);

    while (!this.abortController.signal.aborted) {
      try {
        const resp = await getUpdates({
          baseUrl: DEFAULT_BASE_URL,
          token: this.token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: 35_000,
        });

        if (resp.ret !== undefined && resp.ret !== 0) {
          console.error(`getUpdates error: ret=${resp.ret} errmsg=${resp.errmsg}`);
          await sleep(5000, this.abortController.signal);
          continue;
        }

        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
        }

        for (const raw of resp.msgs ?? []) {
          if (!isUserMessage(raw)) continue;

          const text = extractText(raw.item_list);
          if (!text.trim()) continue;

          onMessage({
            id: String(raw.message_id ?? Date.now()),
            from: raw.from_user_id ?? "",
            text,
            contextToken: raw.context_token,
          });
        }
      } catch (err) {
        if (this.abortController.signal.aborted) break;
        console.error("getUpdates error:", (err as Error).message);
        await sleep(5000, this.abortController.signal);
      }
    }
  }

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
          context_token: msg.contextToken,
        },
      },
    });
  }

  stop(): void {
    this.abortController?.abort();
  }
}

function isUserMessage(msg: WeixinMessage): boolean {
  return msg.message_type === 1 && !!msg.from_user_id;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
