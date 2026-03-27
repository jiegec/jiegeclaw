import type { Channel, InboundMessage, OutboundMessage } from "../types.js";
import AiBot from "@wecom/aibot-node-sdk";
import { generateReqId, type WsFrame, type TextMessage } from "@wecom/aibot-node-sdk";
import type { WecomChannelConfig } from "./wecom-types.js";
import { createRl, question } from "../readline.js";

export class WecomChannel implements Channel {
  readonly id: string;
  private botId?: string;
  private secret?: string;
  private onConfigUpdate: (index: number, update: Partial<WecomChannelConfig>) => void;
  private channelIndex: number;
  private wsClient?: AiBot.WSClient;

  constructor(
    config: WecomChannelConfig,
    index: number,
    onConfigUpdate: (index: number, update: Partial<WecomChannelConfig>) => void,
  ) {
    this.channelIndex = index;
    this.id = config.botId ?? `wecom-${index}`;
    this.botId = config.botId;
    this.secret = config.secret;
    this.onConfigUpdate = onConfigUpdate;
  }

  async onboard(): Promise<void> {
    if (this.botId && this.secret) {
      console.log("WeCom already configured. Bot:", this.botId);
      return;
    }

    const rl = createRl();
    const botId = await question(rl, "WeCom Bot ID: ");
    const secret = await question(rl, "WeCom Bot Secret: ");
    rl.close();

    if (!botId || !secret) {
      throw new Error("Bot ID and Secret are required");
    }

    this.botId = botId;
    this.secret = secret;

    this.onConfigUpdate(this.channelIndex, {
      botId: this.botId,
      secret: this.secret,
    });
    console.log("\nWeCom connected successfully!");
  }

  async listen(onMessage: (msg: InboundMessage) => void): Promise<void> {
    const wsClient = new AiBot.WSClient({
      botId: this.botId!,
      secret: this.secret!,
    });
    this.wsClient = wsClient;

    wsClient.on("authenticated", () => {
      console.log(`[${this.id}] WeCom authenticated`);
    });

    wsClient.on("message.text", (frame: WsFrame<TextMessage>) => {
      const body = frame.body as TextMessage;
      if (!body.text?.content?.trim()) return;

      const from = body.from?.userid ?? body.chatid ?? "";
      const contextToken = frame;

      onMessage({
        id: body.msgid,
        from,
        text: body.text.content,
        contextToken,
      });
    });

    wsClient.connect();

    return new Promise(() => {});
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (this.wsClient === undefined) return;

    if (msg.contextToken) {
      await this.wsClient.replyStream(msg.contextToken, generateReqId("stream"), msg.text, true);
      return;
    }

    await this.wsClient.sendMessage(msg.to, {
      msgtype: "markdown",
      markdown: { content: msg.text },
    });
  }

  stop(): void {
    this.wsClient?.disconnect();
  }
}
