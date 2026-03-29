/**
 * Feishu (Lark) messaging channel with streaming card support.
 *
 * Connects to Feishu via the Lark SDK using WebSocket events for receiving
 * messages and the REST API for sending replies. Supports streaming updates
 * via Feishu Cards with rate limiting.
 */

import type { Channel, InboundMessage, OutboundMessage, ImageAttachment, FeishuContextToken } from "../types.js";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "./feishu-types.js";
import { createRl, question } from "../readline.js";
import { RateLimiter, type RateLimitedItem } from "../utils/rate-limiter.js";
import { bufferToImageAttachment } from "../utils/image.js";

interface StreamContext {
  cardId: string;
  elementId: string;
  sequence: number;
  content: string;
}

const RATE_LIMIT_MS = 200; // Minimum time between card updates
const STREAMING_ELEMENT_ID = "streaming_content";

export class FeishuChannel implements Channel {
  readonly id: string;
  private appId = "";
  private appSecret = "";
  /** Lazily initialized REST client for sending messages. */
  private client?: Lark.Client;
  private onConfigUpdate: (index: number, update: Partial<FeishuChannelConfig>) => void;
  private channelIndex: number;
  private rateLimiter: RateLimiter<StreamContext>;
  /** Map of streamId to card info */
  private streamContexts: Map<string, StreamContext> = new Map();

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
    this.rateLimiter = new RateLimiter(RATE_LIMIT_MS, this.flushStreams.bind(this));
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

  private ensureClient(): Lark.Client {
    if (this.client === undefined) {
      this.client = new Lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
    }
    return this.client;
  }

  /**
   * Download an image from Feishu and convert it to a data URL.
   */
  private async downloadImage(messageId: string, imageKey: string): Promise<ImageAttachment | null> {
    try {
      const client = this.ensureClient();
      const response = await client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: imageKey },
        params: {
          type: "image"
        }
      });

      // Get the readable stream and convert to buffer
      const stream = response.getReadableStream();
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }

      const buffer = Buffer.concat(chunks);

      return await bufferToImageAttachment(buffer, `image_${imageKey}`);
    } catch (err) {
      console.error(`[${this.id}] Error downloading image ${imageKey}:`, (err as Error).message);
      return null;
    }
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

          // Feishu message content is JSON-encoded
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(message.content);
          } catch {
            parsed = {};
          }

          const msgType = message.message_type as string;
          const images: ImageAttachment[] = [];

          // Handle image messages (only image, no text)
          if (msgType === "image" && parsed.image_key) {
            const image = await this.downloadImage(message.message_id, parsed.image_key as string);
            if (image) {
              images.push(image);
            }
            // Image messages have no text content, use empty string
            onMessage({
              id: message.message_id ?? String(Date.now()),
              from: message.chat_id ?? "",
              text: "",
              contextToken: message.message_id ? { channel: "feishu", messageId: message.message_id } : undefined,
              images,
            });
            return;
          }

          // Handle text messages (may contain images in rich text)
          let text: string = "";
          if (msgType === "text") {
            text = (parsed.text as string) ?? "";
          } else if (msgType === "post") {
            for (const paragraph of (parsed.content as Record<string, unknown>[][])) {
              for (const content of (paragraph as Record<string, unknown>[])) {
                if (content.tag === "img") {
                  const image = await this.downloadImage(message.message_id, content.image_key as string);
                  if (image) {
                    images.push(image);
                  }
                } else if (content.tag === "text") {
                  text += content.text ?? "";
                }
              }
            }
          } else {
            // Other message types - skip for now
            return;
          }

          if (!text.trim() && images.length === 0) return;

          onMessage({
            id: message.message_id ?? String(Date.now()),
            from: message.chat_id ?? "",
            text,
            contextToken: message.message_id ? { channel: "feishu", messageId: message.message_id } : undefined,
            images,
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
    const client = this.ensureClient();

    // Build the post content with markdown formatting
    const content = JSON.stringify({
      en_us: {
        content: [[{ tag: "md", text: msg.text }]],
      },
    });

    if (msg.contextToken && msg.contextToken.channel === "feishu") {
      // Reply in-thread to the original message
      await client.im.v1.message.reply({
        path: { message_id: msg.contextToken.messageId },
        data: {
          msg_type: "post",
          content,
        },
      });
    } else {
      // Send a new standalone message to the chat
      await client.im.v1.message.create({
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
   * Streaming send for Feishu using Cards.
   * Creates a card and updates it with rate limiting for streaming effect.
   */
  async streamSend(streamId: string, msg: OutboundMessage, finish: boolean): Promise<void> {
    let context = this.streamContexts.get(streamId);

    if (!context) {
      // First message - create a new card
      context = await this.createStreamingCard(msg, streamId);
      this.streamContexts.set(streamId, context);
    }

    // Update content
    context.content = msg.text;
    context.sequence += 1;

    // Add to rate limiter
    this.rateLimiter.add(streamId, context);

    // Clean up if finished
    if (finish) {
      this.streamContexts.delete(streamId);
    }
  }

  /**
   * Create a new streaming card entity.
   */
  private async createStreamingCard(msg: OutboundMessage, streamId: string): Promise<StreamContext> {
    const client = this.ensureClient();

    // Create card JSON with streaming mode enabled
    const cardData = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        streaming_config: {
          print_frequency_ms: {
            default: 100
          },
          print_step: {
            default: 5
          },
          print_strategy: "fast"
        }
      },
      body: {
        elements: [
          {
            tag: "markdown",
            content: msg.text,
            element_id: STREAMING_ELEMENT_ID,
          },
        ],
      },
    };

    // Create card entity using SDK
    const createResponse = await client.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(cardData),
      },
    });

    if (createResponse.code !== 0) {
      throw new Error(`Failed to create card: ${createResponse.msg}`);
    }

    const cardId = createResponse.data?.card_id;
    if (!cardId) {
      throw new Error("Failed to get card_id from create response");
    }

    // Send the card as a message
    const cardContent = JSON.stringify({
      type: "card",
      data: {
        card_id: cardId,
      },
    });

    if (msg.contextToken && msg.contextToken.channel === "feishu") {
      // Reply to the original message
      await client.im.v1.message.reply({
        path: { message_id: msg.contextToken.messageId },
        data: {
          msg_type: "interactive",
          content: cardContent,
        },
      });
    } else {
      // Send to chat
      await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: msg.to,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }

    return {
      cardId,
      elementId: STREAMING_ELEMENT_ID,
      sequence: 0,
      content: "",
    };
  }

  /**
   * Flush pending stream updates with rate limiting.
   */
  private async flushStreams(items: Map<string, RateLimitedItem<StreamContext>>): Promise<void> {
    const client = this.ensureClient();

    for (const [, item] of items) {
      const ctx = item.data;

      try {
        // Update card element content using SDK
        await client.cardkit.v1.cardElement.content({
          path: {
            card_id: ctx.cardId,
            element_id: ctx.elementId,
          },
          data: {
            content: ctx.content,
            sequence: ctx.sequence,
          },
        });
      } catch (err) {
        console.error(`[${this.id}] Failed to update card ${ctx.cardId}:`, (err as Error).message);
      }
    }
  }

  /** Stop listening and clean up resources. */
  async stop(): Promise<void> {
    // Force flush any pending updates
    await this.rateLimiter.forceFlush();
  }
}
