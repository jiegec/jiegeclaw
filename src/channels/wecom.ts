/**
 * WeCom (企业微信) AI bot messaging channel.
 *
 * Connects to WeCom via the @wecom/aibot-node-sdk using WebSocket for
 * bidirectional communication. Supports streaming replies via replyStream
 * and markdown-formatted messages.
 */

import type { Channel, InboundMessage, OutboundMessage, ImageAttachment, WecomContextToken } from "../types.js";
import AiBot from "@wecom/aibot-node-sdk";
import { generateReqId, type WsFrame, type TextMessage, type ImageMessage, type MixedMessage, MessageType } from "@wecom/aibot-node-sdk";
import type { WecomChannelConfig } from "./wecom-types.js";
import { createRl, question } from "../readline.js";
import { RateLimiter, RateLimitedItem } from "../utils/rate-limiter.js";
import { bufferToImageAttachment } from "../utils/image.js";
import logger from "../utils/logger.js";

interface StreamContext {
  streamId: string;
  content: string;
  frame: WsFrame<TextMessage>;
  finish: boolean;
}

const RATE_LIMIT_MS = 200; // Minimum time between stream sends

export class WecomChannel implements Channel {
  readonly id: string;
  private botId?: string;
  private secret?: string;
  private onConfigUpdate: (index: number, update: Partial<WecomChannelConfig>) => void;
  private channelIndex: number;
  private wsClient?: AiBot.WSClient;
  private queuedMessages: Array<OutboundMessage>;
  private authenticated: boolean;
  private rateLimiter: RateLimiter<StreamContext>;

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
    this.rateLimiter = new RateLimiter(RATE_LIMIT_MS, this.flushStreams.bind(this));
  }

  /**
   * Interactive setup: prompt for Bot ID and Secret if not already configured.
   * Credentials are saved to config via the onConfigUpdate callback.
   */
  async onboard(): Promise<void> {
    if (this.botId && this.secret) {
      logger.info(`WeCom already configured. Bot: ${this.botId}`);
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
    logger.info("\nWeCom connected successfully!");
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
      logger.info(`[${this.id}] WeCom authenticated`);
      this.authenticated = true;
      this.flush();
    });

    this.wsClient!.on("message.text", (frame: WsFrame<TextMessage>) => {
      const body = frame.body as TextMessage;
      if (!body.text?.content?.trim()) return;

      // Use the WeCom user ID as the sender, falling back to chat ID
      const from = body.from?.userid ?? body.chatid ?? "";
      // Store the full WsFrame as contextToken for reply streaming
      const contextToken: WecomContextToken = { channel: "wecom", frame };

      onMessage({
        id: body.msgid,
        from,
        text: body.text.content,
        contextToken,
      });
    });

    this.wsClient!.on("message.image", async (frame: WsFrame<ImageMessage>) => {
      const body = frame.body as ImageMessage;
      const from = body.from?.userid ?? body.chatid ?? "";

      // Download and decrypt the image using SDK
      const images: ImageAttachment[] = [];
      try {
        const { buffer, filename } = await this.wsClient!.downloadFile(body.image.url, body.image.aeskey);
        const image = await bufferToImageAttachment(buffer, filename ?? `image_${Date.now()}`);
        if (image) {
          images.push(image);
        }
      } catch (err) {
        logger.error(`[${this.id}] Failed to download image: ${(err as Error).message}`);
      }

      const contextToken: WecomContextToken = { channel: "wecom", frame };

      onMessage({
        id: body.msgid,
        from,
        text: "",
        contextToken,
        images,
      });
    });

    this.wsClient!.on("message.mixed", async (frame: WsFrame<MixedMessage>) => {
      const body = frame.body as MixedMessage;
      const from = body.from?.userid ?? body.chatid ?? "";

      // Extract text and images from mixed message
      let text = "";
      const images: ImageAttachment[] = [];

      for (const item of body.mixed.msg_item) {
        if (item.msgtype === "text" && item.text) {
          text += item.text.content;
        } else if (item.msgtype === "image" && item.image) {
          try {
            const { buffer, filename } = await this.wsClient!.downloadFile(item.image.url, item.image.aeskey);
            const image = await bufferToImageAttachment(buffer, filename ?? `image_${Date.now()}`);
            if (image) {
              images.push(image);
            }
          } catch (err) {
            logger.error(`[${this.id}] Failed to download image: ${(err as Error).message}`);
          }
        }
      }

      if (!text.trim() && images.length === 0) return;

      const contextToken: WecomContextToken = { channel: "wecom", frame };

      onMessage({
        id: body.msgid,
        from,
        text,
        contextToken,
        images,
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

  /**
   * Streaming send for WeCom.
   * Uses replyStream to update the message in real-time with rate limiting.
   * @param streamId Unique identifier for this stream (passed to replyStream)
   * @param msg The message to send
   * @param finish Whether this is the final message in the stream
   */
  async streamSend(streamId: string, msg: OutboundMessage, finish: boolean): Promise<void> {
    if (msg.contextToken?.channel !== "wecom") {
      return;
    }
    const frame = msg.contextToken.frame;

    if (!frame) {
      logger.warn(`[${this.id}] streamSend called without valid WeCom contextToken`);
      return;
    }

    // Add to rate limiter - only latest content per stream is kept
    this.rateLimiter.add(streamId, {
      streamId,
      content: msg.text,
      frame,
      finish,
    });
  }

  private async flush(): Promise<void> {
    while (this.authenticated) {
      const newMsg = this.queuedMessages.shift();
      if (newMsg === undefined) {
        break;
      } else if (newMsg.contextToken && newMsg.contextToken.channel === "wecom") {
        // Stream reply to the original message frame (non-streaming, one-shot)
        await this.wsClient!.replyStream(newMsg.contextToken.frame, generateReqId("stream"), newMsg.text, true);
      } else {
        // Send a new standalone markdown message
        await this.wsClient!.sendMessage(newMsg.to, {
          msgtype: "markdown",
          markdown: { content: newMsg.text },
        });
      }
    }
  }

  /**
   * Flush pending stream updates.
   */
  private async flushStreams(items: Map<string, RateLimitedItem<StreamContext>>): Promise<void> {
    for (const [streamId, item] of items) {
      const ctx = item.data;
      try {
        await this.wsClient!.replyStream(ctx.frame, ctx.streamId, ctx.content, ctx.finish);
      } catch (err) {
        logger.error(`[${this.id}] Failed to send stream ${streamId}: ${(err as Error).message}`);
      }
    }
  }

  /** Disconnect the WeCom WebSocket client. */
  async stop(): Promise<void> {
    // Force flush any pending stream updates
    await this.rateLimiter.forceFlush();
    // Flush any remaining non-streaming messages
    await this.flush();
    this.wsClient?.disconnect();
  }
}
