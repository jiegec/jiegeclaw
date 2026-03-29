/**
 * Feishu (Lark) messaging channel with streaming card support.
 *
 * Connects to Feishu via the Lark SDK using WebSocket events for receiving
 * messages and the REST API for sending replies. Supports streaming updates
 * via Feishu Cards with rate limiting.
 */

import type { Channel, InboundMessage, OutboundMessage } from "../types.js";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "./feishu-types.js";
import { createRl, question } from "../readline.js";
import { RateLimiter, type RateLimitedItem } from "../utils/rate-limiter.js";

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
    const client = this.ensureClient();

    // Build the post content with markdown formatting
    const content = JSON.stringify({
      en_us: {
        content: [[{ tag: "md", text: msg.text }]],
      },
    });

    if (msg.contextToken) {
      // Reply in-thread to the original message
      await client.im.v1.message.reply({
        path: { message_id: msg.contextToken },
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

    if (msg.contextToken) {
      // Reply to the original message
      await client.im.v1.message.reply({
        path: { message_id: msg.contextToken },
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
