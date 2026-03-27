import type { Channel, InboundMessage, OutboundMessage } from "./types.js";
import { OpencodeHandler } from "./opencode.js";

export class Server {
  private channels: Channel[] = [];
  private handler: OpencodeHandler;

  constructor(handler: OpencodeHandler) {
    this.handler = handler;
  }

  addChannel(channel: Channel): void {
    this.channels.push(channel);
  }

  async start(): Promise<void> {
    const promises = this.channels.map((channel) =>
      channel.listen(async (msg: InboundMessage) => {
        try {
          const truncIn = msg.text.length > 100 ? "..." : "";
          console.log(`[${channel.id}] <${msg.from}: ${msg.text.slice(0, 100)}${truncIn}`);
          const reply = await this.handler.handle(msg);
          await channel.send({
            to: msg.from,
            text: reply,
            contextToken: msg.contextToken,
          });
          const truncOut = reply.length > 100 ? "..." : "";
          console.log(`[${channel.id}] >${msg.from}: ${reply.slice(0, 100)}${truncOut}`);
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

  stop(): void {
    for (const channel of this.channels) {
      channel.stop();
    }
  }
}
