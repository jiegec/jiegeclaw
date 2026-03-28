/**
 * WeCom (企业微信) AI bot messaging channel.
 *
 * Connects to WeCom via the @wecom/aibot-node-sdk using WebSocket for
 * bidirectional communication. Supports streaming replies via replyStream
 * and markdown-formatted messages.
 */

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
  private queuedMessages: Array<OutboundMessage>;
  private authenticated: boolean;

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
    this.queuedMessages = [];
    this.authenticated = false;
  }

  /**
   * Interactive setup: prompt for Bot ID and Secret if not already configured.
   * Credentials are saved to config via the onConfigUpdate callback.
   */
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

  ensureClient() {
    if (this.wsClient === undefined) {
      this.wsClient = new AiBot.WSClient({
        botId: this.botId!,
        secret: this.secret!,
      });
      this.wsClient.connect();
    }
  }

  /**
   * Start listening for WeCom messages via WebSocket.
   * The WebSocket client connects and dispatches text messages to the callback.
   * The returned promise never resolves (blocks until stop() is called).
   */
  async listen(onMessage: (msg: InboundMessage) => void): Promise<void> {
    this.ensureClient();

    this.wsClient!.on("authenticated", () => {
      console.log(`[${this.id}] WeCom authenticated`);
      this.authenticated = true;
      this.flush();
    });

    this.wsClient!.on("message.text", (frame: WsFrame<TextMessage>) => {
      const body = frame.body as TextMessage;
      if (!body.text?.content?.trim()) return;

      // Use the WeCom user ID as the sender, falling back to chat ID
      const from = body.from?.userid ?? body.chatid ?? "";
      // Store the full WsFrame as contextToken for reply streaming
      const contextToken = frame;

      onMessage({
        id: body.msgid,
        from,
        text: body.text.content,
        contextToken,
      });
    });

    // Block forever — the listener runs until stop() disconnects the WebSocket
    return new Promise(() => { });
  }

  /**
   * Send a message to a WeCom user.
   * If contextToken is set (a WsFrame), uses replyStream for in-thread streaming.
   * Otherwise, sends a markdown message to the specified user/chat.
   */
  async send(msg: OutboundMessage): Promise<void> {
    // Queue messages before authentication
    this.queuedMessages.push(msg);
    await this.flush();
  }

  async flush(): Promise<void> {
    while (this.authenticated) {
      const newMsg = this.queuedMessages.shift();
      if (newMsg === undefined) {
        break;
      } else if (newMsg.contextToken) {
        // Stream reply to the original message frame
        await this.wsClient!.replyStream(newMsg.contextToken, generateReqId("stream"), newMsg.text, true);
      } else {
        // Send a new standalone markdown message
        await this.wsClient!.sendMessage(newMsg.to, {
          msgtype: "markdown",
          markdown: { content: newMsg.text },
        });
      }
    }
  }

  /** Disconnect the WeCom WebSocket client. */
  stop(): void {
    this.wsClient?.disconnect();
  }
}
