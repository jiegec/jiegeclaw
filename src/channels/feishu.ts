/**
 * Feishu (Lark) messaging channel.
 *
 * Connects to Feishu via the Lark SDK using WebSocket events for receiving
 * messages and the REST API for sending replies. Messages are formatted
 * as Feishu "post" type with markdown content.
 */

import type { Channel, InboundMessage, OutboundMessage } from "../types.js";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "./feishu-types.js";
import { createRl, question } from "../readline.js";

export class FeishuChannel implements Channel {
  readonly id: string;
  private appId = "";
  private appSecret = "";
  /** Lazily initialized REST client for sending messages. */
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

  /**
   * Interactive setup: prompt for App ID and App Secret if not already configured.
   * Credentials are saved to config via the onConfigUpdate callback.
   */
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

  /**
   * Start listening for incoming Feishu messages via WebSocket.
   * Parses the message content (which comes as JSON with a "text" field)
   * and forwards text messages to the onMessage callback.
   */
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

          // Feishu message content is JSON-encoded; try to extract the text field
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

  /**
   * Send a message to a Feishu chat.
   * If contextToken is set, replies in-thread to the original message.
   * Otherwise, sends a new message to the chat specified by msg.to.
   * Messages are formatted as "post" type with markdown content.
   */
  async send(msg: OutboundMessage): Promise<void> {
    if (this.client === undefined) {
      this.client = new Lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
    }

    // Build the post content with markdown formatting
    const content = JSON.stringify({
      en_us: {
        content: [[{ tag: "md", text: msg.text }]],
      },
    });

    if (msg.contextToken) {
      // Reply in-thread to the original message
      await this.client.im.v1.message.reply({
        path: { message_id: msg.contextToken },
        data: {
          msg_type: "post",
          content,
        },
      });
    } else {
      // Send a new standalone message to the chat
      await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: msg.to,
          msg_type: "post",
          content,
        },
      });
    }
  }

  /**
   * Streaming send for Feishu.
   * Feishu doesn't support streaming replies, so we only send when finish=true.
   */
  async streamSend(streamId: string, msg: OutboundMessage, finish: boolean): Promise<void> {
    if (finish) {
      await this.send(msg);
    }
  }

  /** No-op: Feishu WSClient doesn't have a clean stop method. */
  stop(): void { }
}
