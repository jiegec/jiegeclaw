import type { Channel, InboundMessage, OutboundMessage } from "../types.js";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "./feishu-types.js";
import * as readline from "node:readline";

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stderr });
}

function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

export class FeishuChannel implements Channel {
  readonly id: string;
  private appId = "";
  private appSecret = "";
  private client?: Lark.Client;
  private onConfigUpdate: (index: number, update: Partial<FeishuChannelConfig>) => void;
  private channelIndex: number;

  constructor(
    config: FeishuChannelConfig,
    index: number,
    onConfigUpdate: (index: number, update: Partial<FeishuChannelConfig>) => void,
  ) {
    this.channelIndex = index;
    this.id = config.appId ?? `feishu-${index}`;
    this.appId = config.appId ?? "";
    this.appSecret = config.appSecret ?? "";
    this.onConfigUpdate = onConfigUpdate;
  }

  async onboard(): Promise<void> {
    if (this.appId && this.appSecret) {
      console.log("Feishu already configured. App:", this.appId);
      return;
    }

    const rl = createRl();
    const appId = await question(rl, "Feishu App ID: ");
    const appSecret = await question(rl, "Feishu App Secret: ");
    rl.close();

    if (!appId || !appSecret) {
      throw new Error("App ID and App Secret are required");
    }

    this.appId = appId;
    this.appSecret = appSecret;

    this.onConfigUpdate(this.channelIndex, {
      appId: this.appId,
      appSecret: this.appSecret,
    });
    console.log("\nFeishu connected successfully!");
  }

  async listen(onMessage: (msg: InboundMessage) => void): Promise<void> {
    const wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
          const { message } = data;
          if (!message?.content) return;

          let text: string;
          try {
            const parsed = JSON.parse(message.content);
            text = parsed.text ?? "";
          } catch {
            text = message.content;
          }

          if (!text.trim()) return;

          onMessage({
            id: message.message_id ?? String(Date.now()),
            from: message.chat_id ?? "",
            text,
            contextToken: message.message_id ?? undefined,
          });
        },
      }),
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.client === undefined) {
      this.client = new Lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
    }

    if (msg.contextToken) {
      await this.client.im.v1.message.reply({
        path: { message_id: msg.contextToken },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: msg.text }),
        },
      });
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: msg.to,
          msg_type: "text",
          content: JSON.stringify({ text: msg.text }),
        },
      });
    }
  }

  stop(): void {
  }
}
