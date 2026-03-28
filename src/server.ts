/**
 * Core message routing server.
 *
 * The Server class ties channels to the OpencodeHandler:
 * - Routes incoming channel messages to opencode sessions (or handles slash commands)
 * - Implements the StreamHandler interface so opencode can send messages back through channels
 * - Manages pending reply state for permission requests and questions
 *   (when opencode needs a user response, the Server holds the promise
 *    and resolves it when the user's reply comes back through the channel)
 */

import { spawn } from "node:child_process";
import type { Channel, InboundMessage, OutboundMessage } from "./types.js";
import { OpencodeHandler, type StreamHandler } from "./opencode.js";

export class Server {
  private channels: Channel[] = [];
  private handler: OpencodeHandler;
  /**
   * Map of pending reply IDs to their resolution state.
   * Used when opencode asks a question or permission and we need to wait
   * for the user's reply to come through the channel message listener.
   */
  private pendingReplies: Map<
    string,
    { resolve: (reply: string) => void; channel: Channel; to: string; validChoices?: string[] }
  > = new Map();

  constructor(handler: OpencodeHandler) {
    this.handler = handler;
  }

  /** Register a channel. Throws if a channel with the same ID already exists. */
  addChannel(channel: Channel): void {
    if (this.channels.some((c) => c.id === channel.id)) {
      throw new Error(`Duplicate channel id: ${channel.id}`);
    }
    this.channels.push(channel);
  }

  /**
   * Start the server: wire up stream handlers for each channel and begin
   * listening for incoming messages on all channels concurrently.
   */
  async start(): Promise<void> {
    // Create and register stream handlers for each channel
    for (const channel of this.channels) {
      const stream = this.createStreamHandler(channel);
      this.handler.setStream(channel.id, stream);
    }

    // Resume sessions for channels that have a saved working directory
    for (const channel of this.channels) {
      try {
        await this.handler.ensureSession(channel.id);
      } catch (err) {
        console.log(`[${channel.id}] No saved session to resume: ${(err as Error).message}`);
      }
    }

    // Start listening on all channels and process messages as they arrive
    const promises = this.channels.map((channel) =>
      channel.listen(async (msg: InboundMessage) => {
        // First, check if this message resolves a pending reply (permission/question)
        const pendingId = await this.tryResolvePendingReply(msg.text, msg.from, channel);
        if (pendingId) return;

        try {
          const truncIn = msg.text.length > 100 ? "..." : "";
          console.log(`[${channel.id}] <${msg.from}: ${msg.text.slice(0, 100)}${truncIn}`);

          // Handle slash commands
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
            } else if (cmd === "status") {
              const status = this.handler.getStatus(channel.id);
              const lines: string[] = [];
              if (status.directory) {
                lines.push(`- **Directory:** \`${status.directory}\``);
              } else {
                lines.push("- **Directory:** not set");
              }
              if (status.sessionID) {
                lines.push(`- **Session:** \`${status.sessionID.slice(0, 8)}\``);
              } else {
                lines.push("- **Session:** not connected");
              }
              await channel.send({ to: msg.from, text: "Status:\n\n" + lines.join("\n"), contextToken: msg.contextToken });
              return;
            } else if (cmd === "projects") {
              const projects = await this.handler.getProjects(channel.id);
              if (!projects.length) {
                await channel.send({ to: msg.from, text: "No projects found. Start a session first with `/cd <path>`.", contextToken: msg.contextToken });
                return;
              }
              const lines = projects.map((p) => {
                const name = p.name ?? p.worktree.split("/").pop() ?? p.id;
                return `- **${name}** \`${p.worktree}\``;
              });
              await channel.send({ to: msg.from, text: `**Projects (${projects.length}):**\n\n${lines.join("\n")}`, contextToken: msg.contextToken });
              return;
            } else if (cmd === "restart") {
              await channel.send({ to: msg.from, text: "Restarting...", contextToken: msg.contextToken });
              setTimeout(async () => {
                await this.stop();
                const child = spawn("npm", ["start"], {
                  detached: true,
                  stdio: "inherit",
                  env: process.env,
                });
                child.unref();
                process.exit(0);
              }, 1000);
              return;
            } else if (cmd === "help") {
              await channel.send({ to: msg.from, text: "**Available commands:**\n\n- `/cd <path>`: Switch to a different project directory\n- `/status`: Show current session status\n- `/projects`: List opencode projects\n- `/restart`: Restart the bot\n- `/help`: Show this help message", contextToken: msg.contextToken });
              return;
            }

            await channel.send({ to: msg.from, text: `Unknown command: \`/${cmd}\`\nType \`/help\` to see available commands.`, contextToken: msg.contextToken });
            return;
          }

          // Require a working directory before forwarding to opencode
          if (!this.handler.hasDirectory(channel.id)) {
            console.log(`[${channel.id}] No directory set, prompting user`);
            await channel.send({ to: msg.from, text: "No directory set. Use `/cd <path>` to select a project directory.", contextToken: msg.contextToken });
            return;
          }

          // Ensure an opencode session is running, then forward the message
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

  /**
   * Create a StreamHandler for a channel.
   * This is the bridge between opencode events and channel message sends.
   */
  private createStreamHandler(channel: Channel): StreamHandler {
    return {
      /** Send a message through the channel and log it. */
      send: async (outMsg: OutboundMessage) => {
        await channel.send(outMsg);
        const truncOut = outMsg.text.length > 100 ? "..." : "";
        console.log(`[${channel.id}] >${outMsg.to}: ${outMsg.text.slice(0, 100)}${truncOut}`);
      },
      /**
       * Send a message and wait for a user reply.
       * Creates a pending entry that will be resolved by tryResolvePendingReply
       * when the user's next message comes in.
       */
      waitForReply: (outMsg: OutboundMessage, validChoices?: string[]) =>
        this.waitForReply(channel, outMsg, validChoices),
    };
  }

  /**
   * Send a message to the channel and return a promise that resolves
   * when the user replies. The promise is stored in pendingReplies
   * and resolved by tryResolvePendingReply.
   */
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

  /**
   * Try to resolve a pending reply with the incoming message.
   * If the message is from the right user on the right channel and matches
   * the valid choices (if any), the pending promise is resolved.
   * Returns the pending ID if resolved, undefined otherwise.
   */
  private async tryResolvePendingReply(text: string, from: string, channel: Channel): Promise<string | undefined> {
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
    return undefined;
  }

  /** Stop all channels and resolve any pending replies with "reject". */
  async stop(): Promise<void> {
    await this.handler.stop();
    for (const [, pending] of this.pendingReplies) {
      pending.resolve("reject");
    }
    this.pendingReplies.clear();
    for (const channel of this.channels) {
      channel.stop();
    }
  }
}
