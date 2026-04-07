/**
 * Core message routing server.
 *
 * The Server class ties channels to the OpencodeHandler:
 * - Routes incoming channel messages to opencode sessions (or handles slash commands)
 * - Implements the StreamHandler interface so opencode can send messages back through channels
 * - Manages pending reply state for permission requests and questions
 */

import type { Channel, InboundMessage } from "../types.js";
import { OpencodeHandler } from "../opencode/index.js";
import { loadConfig, createChannel } from "../config.js";
import { getCommand, hasCommand } from "./commands.js";
import { PendingReplyManager, ChannelStreamHandler } from "./stream-handler.js";
import { CronScheduler } from "../utils/cron-scheduler.js";
import logger from "../utils/logger.js";

export class Server {
  private channels: Channel[] = [];
  private handler: OpencodeHandler;
  private replyManager: PendingReplyManager;
  private cron: CronScheduler;

  constructor(handler: OpencodeHandler) {
    this.handler = handler;
    this.replyManager = new PendingReplyManager();
    this.cron = new CronScheduler(async (job) => {
      const channel = this.channels.find((c) => c.id === job.channelId);
      if (!channel) {
        logger.error(`Cron job "${job.name}" (${job.id}): channel ${job.channelId} not found`);
        return;
      }
      try {
        await channel.send({ to: job.to, text: `⏰ **[${job.name}]** Running...` });
        const response = await this.handler.runPrompt(job.directory, job.prompt);
        await channel.send({ to: job.to, text: `⏰ **[${job.name}]**\n\n${response}` });
      } catch (err) {
        logger.error(`Cron job "${job.name}" (${job.id}) failed: ${(err as Error).message}`);
        try {
          await channel.send({ to: job.to, text: `⏰ **[${job.name}]** Failed: ${(err as Error).message}` });
        } catch {
          // ignore send errors
        }
      }
    });
  }

  addChannel(channel: Channel): void {
    if (this.channels.some((c) => c.id === channel.id)) {
      throw new Error(`Duplicate channel id: ${channel.id}`);
    }
    this.channels.push(channel);
  }

  async start(): Promise<void> {
    this.cron.start();

    // Create and register stream handlers for each channel
    for (const channel of this.channels) {
      const stream = new ChannelStreamHandler(channel, this.replyManager);
      this.handler.setStream(channel.id, stream);
    }

    // Resume sessions for channels that have a saved working directory
    for (const channel of this.channels) {
      try {
        await this.handler.ensureSession(channel.id);
      } catch (err) {
        logger.info(`[${channel.id}] No saved session to resume: ${(err as Error).message}`);
      }
    }

    // Start listening on all channels
    const promises = this.channels.map((channel) =>
      channel.listen(async (msg: InboundMessage) => {
        // Check if this message resolves a pending reply
        const result = await this.replyManager.tryResolve(msg.text, msg.from, channel);
        if (result) {
          // If it was an invalid choice, we've already sent the re-prompt
          return;
        }

        try {
          const truncIn = msg.text.length > 100 ? "..." : "";
          let imagesDesc = "";
          if (msg.images !== undefined && msg.images.length > 0) {
            imagesDesc = ` (with ${msg.images.length} image attachments)`;
          }
          logger.info(`[${channel.id}] <${msg.from}${imagesDesc}: ${msg.text.slice(0, 100)}${truncIn}`);

          // Handle slash commands
          const slashMatch = msg.text.match(/^\/(\S+)\s*(.*)/);
          if (slashMatch) {
            const cmd = slashMatch[1];
            const args = slashMatch[2].trim();

            if (hasCommand(cmd)) {
              const handled = await getCommand(cmd)!({ channel, msg, handler: this.handler, cron: this.cron }, args);
              if (handled) return;
            }

            await channel.send({ to: msg.from, text: `Unknown command: \`/${cmd}\`\nType \`/help\` to see available commands.`, contextToken: msg.contextToken });
            return;
          }

          // Require a working directory before forwarding to opencode
          if (!this.handler.hasDirectory(channel.id)) {
            logger.info(`[${channel.id}] No directory set, prompting user`);
            await channel.send({ to: msg.from, text: "No directory set. Use `/cd <path>` to select a project directory.", contextToken: msg.contextToken });
            return;
          }

          // Ensure an opencode session is running, then forward the message
          await this.handler.ensureSession(channel.id);
          await this.handler.handle(channel.id, msg);
        } catch (err) {
          logger.error(`[${channel.id}] Error handling message from ${msg.from}: ${(err as Error).message}`);
          try {
            await channel.send({
              to: msg.from,
              text: `Error: ${(err as Error).message}`,
              contextToken: msg.contextToken,
            });
          } catch {
            logger.error(`[${channel.id}] Failed to send error message`);
          }
        }
      })
    );

    await Promise.all(promises);
  }

  async stop(): Promise<void> {
    this.cron.stop();
    await this.handler.stop();
    this.replyManager.clearAll();
    for (const channel of this.channels) {
      await channel.stop();
    }
  }
}

export async function runServer(): Promise<void> {
  const config = loadConfig();

  if (!config.channels.length) {
    logger.error("No channels configured. Run `jiegeclaw setup` first.");
    process.exit(1);
  }

  const opencode = new OpencodeHandler();
  const server = new Server(opencode);

  for (const channelConfig of config.channels) {
    const channel = createChannel(channelConfig);
    server.addChannel(channel);
  }

  logger.info(`Starting jiegeclaw with ${config.channels.length} channel(s)...`);

  const shutdown = async () => {
    logger.info("\nShutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGUSR2", async () => {
    logger.info("\nRestarting...");
    await server.stop();
    process.exit(42);
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.start();
}

runServer().catch((err) => {
  logger.error(`Fatal error: ${(err as Error).message}`);
  process.exit(1);
});
