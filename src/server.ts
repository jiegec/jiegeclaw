import type { Channel, InboundMessage, OutboundMessage } from "./types.js";
import { OpencodeHandler, type StreamHandler } from "./opencode.js";

export class Server {
  private channels: Channel[] = [];
  private handler: OpencodeHandler;
  private pendingReplies: Map<
    string,
    { resolve: (reply: string) => void; channel: Channel; to: string; validChoices?: string[] }
  > = new Map();

  constructor(handler: OpencodeHandler) {
    this.handler = handler;
  }

  addChannel(channel: Channel): void {
    this.channels.push(channel);
  }

  async start(): Promise<void> {
    const promises = this.channels.map((channel) =>
      channel.listen(async (msg: InboundMessage) => {
        const pendingId = this.tryResolvePendingReply(msg.text, msg.from, channel);
        if (pendingId) return;

        try {
          const truncIn = msg.text.length > 100 ? "..." : "";
          console.log(`[${channel.id}] <${msg.from}: ${msg.text.slice(0, 100)}${truncIn}`);

          const stream: StreamHandler = {
            send: async (outMsg: OutboundMessage) => {
              await channel.send(outMsg);

              const truncOut = outMsg.text.length > 100 ? "..." : "";
              console.log(`[${channel.id}] >${msg.from}: ${outMsg.text.slice(0, 100)}${truncOut}`);
            },
            waitForReply: (outMsg: OutboundMessage, validChoices?: string[]) =>
              this.waitForReply(channel, outMsg, validChoices),
          };

          await this.handler.handle(msg, stream);
        } catch (err) {
          console.error(`[${channel.id}] Error handling message from ${msg.from}:`, (err as Error).message);
          try {
            await channel.send({
              to: msg.from,
              text: `Error: ${(err as Error).message}`,
              contextToken: msg.contextToken,
            });
          } catch {
            console.error(`[${channel.id}] Failed to send error message`);
          }
        }
      })
    );

    await Promise.all(promises);
  }

  private async waitForReply(
    channel: Channel,
    msg: OutboundMessage,
    validChoices?: string[],
  ): Promise<string> {
    const id = crypto.randomUUID();
    await channel.send(msg);
    return new Promise<string>((resolve) => {
      this.pendingReplies.set(id, { resolve, channel, to: msg.to, validChoices });
    });
  }

  private tryResolvePendingReply(text: string, from: string, channel: Channel): string | null {
    for (const [id, pending] of this.pendingReplies) {
      if (pending.channel !== channel || pending.to !== from) continue;
      const lower = text.trim().toLowerCase();
      if (pending.validChoices && !pending.validChoices.includes(lower)) continue;
      this.pendingReplies.delete(id);
      pending.resolve(lower);
      return id;
    }
    return null;
  }

  stop(): void {
    this.handler.abort();
    for (const [, pending] of this.pendingReplies) {
      pending.resolve("reject");
    }
    this.pendingReplies.clear();
    for (const channel of this.channels) {
      channel.stop();
    }
  }
}
