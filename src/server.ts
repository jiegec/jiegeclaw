import type { Channel, InboundMessage, OutboundMessage } from "./types.js";
import { OpencodeHandler, type StreamHandler } from "./opencode.js";

export class Server {
  private channels: Channel[] = [];
  private handler: OpencodeHandler;
  private pendingReplies: Map<
    string,
    { resolve: (reply: string) => void; channel: Channel; to: string; validChoices?: string[] }
  > = new Map();
  private streamMap: Map<string, StreamHandler> = new Map();

  constructor(handler: OpencodeHandler) {
    this.handler = handler;
  }

  addChannel(channel: Channel): void {
    if (this.channels.some((c) => c.id === channel.id)) {
      throw new Error(`Duplicate channel id: ${channel.id}`);
    }
    this.channels.push(channel);
  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      const stream = this.createStreamHandler(channel);
      this.streamMap.set(channel.id, stream);
      await this.handler.createSession(channel.id, stream);
    }

    const promises = this.channels.map((channel) =>
      channel.listen(async (msg: InboundMessage) => {
        const pendingId = await this.tryResolvePendingReply(msg.text, msg.from, channel);
        if (pendingId) return;

        try {
          const truncIn = msg.text.length > 100 ? "..." : "";
          console.log(`[${channel.id}] <${msg.from}: ${msg.text.slice(0, 100)}${truncIn}`);

          await this.handler.handle(channel.id, msg);
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

  private createStreamHandler(channel: Channel): StreamHandler {
    return {
      send: async (outMsg: OutboundMessage) => {
        await channel.send(outMsg);
        const truncOut = outMsg.text.length > 100 ? "..." : "";
        console.log(`[${channel.id}] >${outMsg.to}: ${outMsg.text.slice(0, 100)}${truncOut}`);
      },
      waitForReply: (outMsg: OutboundMessage, validChoices?: string[]) =>
        this.waitForReply(channel, outMsg, validChoices),
    };
  }

  private async waitForReply(
    channel: Channel,
    msg: OutboundMessage,
    validChoices?: string[],
  ): Promise<string> {
    const id = crypto.randomUUID();
    console.log(`[${channel.id}] Waiting for reply from ${msg.to}${validChoices ? ` (choices: ${validChoices.join(", ")})` : ""}`);
    await channel.send(msg);
    return new Promise<string>((resolve) => {
      this.pendingReplies.set(id, { resolve, channel, to: msg.to, validChoices });
    });
  }

  private async tryResolvePendingReply(text: string, from: string, channel: Channel): Promise<string | null> {
    for (const [id, pending] of this.pendingReplies) {
      if (pending.channel !== channel || pending.to !== from) continue;
      const lower = text.trim().toLowerCase();
      if (pending.validChoices && !pending.validChoices.includes(lower)) {
        console.log(`[${channel.id}] Invalid reply from ${from}: "${lower}" (valid: ${pending.validChoices.join(", ")})`);
        const prompt = `Invalid choice. Valid options: ${pending.validChoices.join(", ")}\nPlease try again:`;
        await channel.send({ to: pending.to, text: prompt, contextToken: "" });
        return id;
      }
      this.pendingReplies.delete(id);
      console.log(`[${channel.id}] Resolved pending reply from ${from}: "${lower}"`);
      pending.resolve(lower);
      return id;
    }
    return null;
  }

  stop(): void {
    this.handler.stop();
    for (const [, pending] of this.pendingReplies) {
      pending.resolve("reject");
    }
    this.pendingReplies.clear();
    for (const channel of this.channels) {
      channel.stop();
    }
  }
}
