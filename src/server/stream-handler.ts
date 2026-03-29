/**
 * Stream handler for channels.
 *
 * Implements StreamHandler interface to bridge opencode events to channel sends.
 */

import type { Channel, OutboundMessage } from "../types.js";
import type { StreamHandler } from "../opencode/types.js";

interface PendingReply {
  resolve: (reply: string) => void;
  to: string;
  validChoices?: string[];
}

/**
 * Manages pending replies for all channels.
 */
export class PendingReplyManager {
  private pendingReplies: Map<string, PendingReply> = new Map();

  /**
   * Register a new pending reply.
   */
  register(id: string, to: string, validChoices?: string[]): Promise<string> {
    return new Promise<string>((resolve) => {
      this.pendingReplies.set(id, { resolve, to, validChoices });
    });
  }

  /**
   * Try to resolve a pending reply with the incoming message.
   * Returns the pending ID if resolved (including invalid choice case), undefined otherwise.
   */
  async tryResolve(
    text: string,
    from: string,
    channel: Channel,
  ): Promise<{ id: string; isValid: boolean } | undefined> {
    for (const [id, pending] of this.pendingReplies) {
      if (pending.to !== from) continue;
      
      if (pending.validChoices && !pending.validChoices.includes(text)) {
        console.log(`[${channel.id}] Invalid reply from ${from}: "${text}" (valid: ${pending.validChoices.join(", ")})`);
        const prompt = `Invalid choice. Valid options: ${pending.validChoices.join(", ")}\nPlease try again:`;
        await channel.send({ to: pending.to, text: prompt });
        return { id, isValid: false };
      }
      
      this.pendingReplies.delete(id);
      console.log(`[${channel.id}] Resolved pending reply from ${from}: "${text}"`);
      pending.resolve(text);
      return { id, isValid: true };
    }
    return undefined;
  }

  /**
   * Clear all pending replies and resolve them with "reject".
   */
  clearAll(): void {
    for (const [, pending] of this.pendingReplies) {
      pending.resolve("reject");
    }
    this.pendingReplies.clear();
  }
}

/**
 * Stream handler implementation for a specific channel.
 * Implements the StreamHandler interface.
 */
export class ChannelStreamHandler implements StreamHandler {
  private channel: Channel;
  private replyManager: PendingReplyManager;

  constructor(channel: Channel, replyManager: PendingReplyManager) {
    this.channel = channel;
    this.replyManager = replyManager;
  }

  async send(msg: OutboundMessage): Promise<void> {
    await this.channel.send(msg);
    const truncOut = msg.text.length > 200 ? "..." : "";
    console.log(`[${this.channel.id}] >${msg.to}: ${msg.text.slice(0, 200)}${truncOut}`);
  }

  async waitForReply(msg: OutboundMessage, validChoices?: string[]): Promise<string> {
    const id = crypto.randomUUID();
    console.log(`[${this.channel.id}] Waiting for reply from ${msg.to}${validChoices ? ` (choices: ${validChoices.join(", ")})` : ""}`);
    await this.channel.send(msg);
    return this.replyManager.register(id, msg.to, validChoices);
  }

  async streamSend(streamId: string, msg: OutboundMessage, finish: boolean): Promise<void> {
    await this.channel.streamSend(streamId, msg, finish);
    if (finish) {
      const truncOut = msg.text.length > 200 ? "..." : "";
      console.log(`[${this.channel.id}] >${msg.to}: ${msg.text.slice(0, 200)}${truncOut}`);
    }
  }
}
