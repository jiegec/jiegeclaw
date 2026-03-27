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
    if (this.channels.some((c) => c.id === channel.id)) {
      throw new Error(`Duplicate channel id: ${channel.id}`);
    }
    this.channels.push(channel);
  }

  async start(): Promise<void> {
    for (const channel of this.channels) {
      const stream = this.createStreamHandler(channel);
      this.handler.setStream(channel.id, stream);
    }

    const promises = this.channels.map((channel) =>
      channel.listen(async (msg: InboundMessage) => {
        const pendingId = await this.tryResolvePendingReply(msg.text, msg.from, channel);
        if (pendingId) return;

        try {
          const truncIn = msg.text.length > 100 ? "..." : "";
          console.log(`[${channel.id}] <${msg.from}: ${msg.text.slice(0, 100)}${truncIn}`);

          const slashMatch = msg.text.match(/^\/(\S+)\s*(.*)/);
          if (slashMatch) {
            const cmd = slashMatch[1];
            const args = slashMatch[2].trim();

            if (cmd === "cd") {
              if (!args) {
                await channel.send({ to: msg.from, text: "Usage: `/cd <path>`", contextToken: msg.contextToken });
                return;
              }
              await this.handler.cd(channel.id, args);
              await channel.send({ to: msg.from, text: `📁 Switched to ${args}`, contextToken: msg.contextToken });
              return;
            } else if (cmd === "help") {
              await channel.send({ to: msg.from, text: "**Available commands:**\n\n- `/cd <path>`: Switch to a different project directory\n- `/help`: Show this help message", contextToken: msg.contextToken });
              return;
            }

            await channel.send({ to: msg.from, text: `Unknown command: \`/${cmd}\`\nType \`/help\` to see available commands.`, contextToken: msg.contextToken });
            return;
          }

          if (!this.handler.hasDirectory(channel.id)) {
            console.log(`[${channel.id}] No directory set, prompting user`);
            await channel.send({ to: msg.from, text: "No directory set. Use `/cd <path>` to select a project directory.", contextToken: msg.contextToken });
            return;
          }

          await this.handler.ensureSession(channel.id);

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
      if (pending.validChoices && !pending.validChoices.includes(text)) {
        console.log(`[${channel.id}] Invalid reply from ${from}: "${text}" (valid: ${pending.validChoices.join(", ")})`);
        const prompt = `Invalid choice. Valid options: ${pending.validChoices.join(", ")}\nPlease try again:`;
        await channel.send({ to: pending.to, text: prompt, contextToken: "" });
        return id;
      }
      this.pendingReplies.delete(id);
      console.log(`[${channel.id}] Resolved pending reply from ${from}: "${text}"`);
      pending.resolve(text);
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
