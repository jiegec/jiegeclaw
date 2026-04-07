/**
 * Slash command handlers for the server.
 *
 * Processes user commands like /cd, /status, /projects, etc.
 */

import path from "node:path";
import os from "node:os";
import type { Channel, InboundMessage } from "../types.js";
import type { OpencodeHandler } from "../opencode/index.js";
import type { CronScheduler, CronJob } from "../utils/cron-scheduler.js";

export interface CommandContext {
  channel: Channel;
  msg: InboundMessage;
  handler: OpencodeHandler;
  cron: CronScheduler;
}

export type CommandHandler = (ctx: CommandContext, args: string) => Promise<boolean>;

const commands = new Map<string, CommandHandler>();

export function registerCommand(name: string, handler: CommandHandler): void {
  commands.set(name, handler);
}

export function getCommand(name: string): CommandHandler | undefined {
  return commands.get(name);
}

export function hasCommand(name: string): boolean {
  return commands.has(name);
}

// Register built-in commands
registerCommand("cd", async ({ channel, msg, handler }, args) => {
  if (!args) {
    await channel.send({ to: msg.from, text: "Usage: `/cd <path>`", contextToken: msg.contextToken });
    return true;
  }
  const dir = args.replace(/^~/, os.homedir());
  const resolved = path.resolve(dir);
  await handler.cd(channel.id, resolved);
  await channel.send({ to: msg.from, text: `📁 Switched to ${resolved}`, contextToken: msg.contextToken });
  return true;
});

registerCommand("status", async ({ channel, msg, handler }) => {
  const status = handler.getStatus(channel.id);
  const lines: string[] = [];
  if (status.directory) {
    lines.push(`- **Directory:** \`${status.directory}\``);
  } else {
    lines.push("- **Directory:** not set");
  }
  if (status.sessionID) {
    lines.push(`- **Session:** \`${status.sessionID.slice(0, 8)}\``);
    const tokens = await handler.getContextTokens(channel.id);
    if (tokens !== undefined) {
      lines.push(`- **Context:** ~${tokens.toLocaleString()} tokens`);
    }
  } else {
    lines.push("- **Session:** not connected");
  }
  await channel.send({ to: msg.from, text: "Status:\n\n" + lines.join("\n"), contextToken: msg.contextToken });
  return true;
});

registerCommand("projects", async ({ channel, msg, handler }) => {
  const projects = await handler.getProjects(channel.id);
  if (!projects.length) {
    await channel.send({ to: msg.from, text: "No projects found. Start a session first with `/cd <path>`.", contextToken: msg.contextToken });
    return true;
  }
  const lines = projects.map((p) => {
    const name = p.name ?? p.worktree.split("/").pop() ?? p.id;
    return `- **${name}** \`${p.worktree}\``;
  });
  await channel.send({ to: msg.from, text: `**Projects (${projects.length}):**\n\n${lines.join("\n")}`, contextToken: msg.contextToken });
  return true;
});

registerCommand("restart", async ({ channel, msg }) => {
  await channel.send({ to: msg.from, text: "Restarting...", contextToken: msg.contextToken });
  setTimeout(() => {
    process.kill(process.pid, "SIGUSR2");
  }, 1000);
  return true;
});

registerCommand("reset", async ({ channel, msg, handler }) => {
  const newSessionID = await handler.resetSession(channel.id);
  await channel.send({ to: msg.from, text: `Session reset. New session: \`${newSessionID.slice(0, 8)}\``, contextToken: msg.contextToken });
  return true;
});

registerCommand("abort", async ({ channel, msg, handler }) => {
  const success = await handler.abort(channel.id);
  if (success) {
    await channel.send({ to: msg.from, text: "✅ **Abort completed**", contextToken: msg.contextToken });
  } else {
    await channel.send({ to: msg.from, text: "❌ No active session to abort", contextToken: msg.contextToken });
  }
  return true;
});

registerCommand("help", async ({ channel, msg }) => {
  await channel.send({ to: msg.from, text: "**Available commands:**\n\n- `/cd <path>`: Switch to a different project directory\n- `/status`: Show current session status\n- `/projects`: List opencode projects\n- `/compact`: Compact the session context\n- `/reset`: Reset to a new opencode session\n- `/abort`: Abort the current generation\n- `/restart`: Restart the bot\n- `/cron list`: List all cron jobs\n- `/cron add <name> <schedule> <prompt>`: Add a named cron job\n- `/cron remove <id|name>`: Remove a cron job\n- `/cron trigger <id|name>`: Manually trigger a cron job\n- `/help`: Show this help message", contextToken: msg.contextToken });
  return true;
});

registerCommand("compact", async ({ channel, msg, handler }) => {
  const status = handler.getStatus(channel.id);
  if (!status.sessionID) {
    await channel.send({ to: msg.from, text: "No active session to compact.", contextToken: msg.contextToken });
    return true;
  }
  // Notify user that compaction is in progress (it may take a while).
  await channel.send({ to: msg.from, text: "Compacting session...", contextToken: msg.contextToken });
  try {
    const summary = await handler.compact(channel.id);
    if (summary) {
      // Include the compaction summary so the user can see what was preserved.
      await channel.send({ to: msg.from, text: `Compaction finished. Summary:\n\n${summary}`, contextToken: msg.contextToken });
    } else {
      await channel.send({ to: msg.from, text: "Compaction finished.", contextToken: msg.contextToken });
    }
  } catch (err) {
    await channel.send({ to: msg.from, text: `Failed to compact: ${err}`, contextToken: msg.contextToken });
  }
  return true;
});

registerCommand("cron", async ({ channel, msg, handler, cron }, args) => {
  if (!cron) {
    await channel.send({ to: msg.from, text: "Cron scheduler is not available.", contextToken: msg.contextToken });
    return true;
  }

  const subCmd = args.match(/^(\S+)/)?.[1];
  const rest = args.replace(/^\S+\s*/, "").trim();

  function resolveId(input: string): string | string[] | undefined {
    const jobs = cron.list();
    const exact = jobs.filter((j) => j.id === input);
    if (exact.length === 1) return exact[0].id;
    const named = jobs.filter((j) => j.name === input);
    if (named.length === 0) return undefined;
    if (named.length === 1) return named[0].id;
    return named.map((j) => `\`${j.name}\` (\`${j.id}\`)`);
  }

  if (subCmd === "list") {
    const jobs = cron.list();
    if (!jobs.length) {
      await channel.send({ to: msg.from, text: "No cron jobs.", contextToken: msg.contextToken });
      return true;
    }
    const lines = jobs.map((j: CronJob) => {
      const nextRun = j.nextRun ? new Date(j.nextRun).toLocaleString() : "—";
      return `- **${j.name}** (\`${j.id}\`) \`${j.schedule}\` in \`${j.directory}\`, scheduled to run on ${nextRun}`;
    });
    await channel.send({ to: msg.from, text: `**Cron jobs (${jobs.length}):**\n\n${lines.join("\n")}`, contextToken: msg.contextToken });
    return true;
  }

  if (subCmd === "add") {
    const firstSpace = rest.indexOf(" ");
    if (firstSpace === -1) {
      await channel.send({ to: msg.from, text: "Usage: `/cron add <name> <schedule> <prompt>`\n\nSchedule examples:\n- `0 9 * * *` — every day at 9:00\n- `*/30 * * * *` — every 30 minutes\n- `0 */2 * * 1-5` — every 2 hours on weekdays", contextToken: msg.contextToken });
      return true;
    }
    const name = rest.slice(0, firstSpace);
    const afterName = rest.slice(firstSpace + 1).trim();
    const tokens = afterName.split(/\s+/);

    if (tokens.length < 6) {
      await channel.send({ to: msg.from, text: "Usage: `/cron add <name> <schedule> <prompt>`\n\nSchedule must be a 5-field cron expression, e.g. `0 9 * * *`", contextToken: msg.contextToken });
      return true;
    }

    const schedule = tokens.slice(0, 5).join(" ");
    const prompt = tokens.slice(5).join(" ");

    const directory = handler.getStatus(channel.id).directory;
    if (!directory) {
      await channel.send({ to: msg.from, text: "No directory set. Use `/cd <path>` first.", contextToken: msg.contextToken });
      return true;
    }

    try {
      const job = cron.add({ name, schedule, prompt, channelId: channel.id, directory, to: msg.from });
      await channel.send({ to: msg.from, text: `Cron job **${job.name}** (\`${job.id}\`) added with schedule \`${job.schedule}\``, contextToken: msg.contextToken });
    } catch (err) {
      await channel.send({ to: msg.from, text: `Failed to add cron job: ${(err as Error).message}`, contextToken: msg.contextToken });
    }
    return true;
  }

  if (subCmd === "remove") {
    if (!rest) {
      await channel.send({ to: msg.from, text: "Usage: `/cron remove <id|name>`", contextToken: msg.contextToken });
      return true;
    }
    const resolved = resolveId(rest);
    if (!resolved) {
      await channel.send({ to: msg.from, text: `Cron job \`${rest}\` not found.`, contextToken: msg.contextToken });
      return true;
    }
    if (Array.isArray(resolved)) {
      await channel.send({ to: msg.from, text: `Multiple cron jobs match \`${rest}\`, use an id:\n${resolved.join("\n")}`, contextToken: msg.contextToken });
      return true;
    }
    const removed = cron.remove(resolved);
    if (removed) {
      await channel.send({ to: msg.from, text: `Cron job \`${rest}\` (\`${resolved}\`) removed.`, contextToken: msg.contextToken });
    } else {
      await channel.send({ to: msg.from, text: `Cron job \`${rest}\` not found.`, contextToken: msg.contextToken });
    }
    return true;
  }

  if (subCmd === "trigger") {
    if (!rest) {
      await channel.send({ to: msg.from, text: "Usage: `/cron trigger <id|name>`", contextToken: msg.contextToken });
      return true;
    }
    const resolved = resolveId(rest);
    if (!resolved) {
      await channel.send({ to: msg.from, text: `Cron job \`${rest}\` not found.`, contextToken: msg.contextToken });
      return true;
    }
    if (Array.isArray(resolved)) {
      await channel.send({ to: msg.from, text: `Multiple cron jobs match \`${rest}\`, use an id:\n${resolved.join("\n")}`, contextToken: msg.contextToken });
      return true;
    }
    try {
      await cron.trigger(resolved);
      await channel.send({ to: msg.from, text: `Cron job \`${rest}\` (\`${resolved}\`) triggered.`, contextToken: msg.contextToken });
    } catch (err) {
      await channel.send({ to: msg.from, text: `Failed to trigger: ${(err as Error).message}`, contextToken: msg.contextToken });
    }
    return true;
  }

  await channel.send({ to: msg.from, text: "Usage: `/cron <list|add|remove|trigger> ...`\n\n- `/cron list`: List all cron jobs\n- `/cron add <name> <schedule> <prompt>`: Add a cron job\n- `/cron remove <id|name>`: Remove a cron job\n- `/cron trigger <id|name>`: Manually trigger a cron job", contextToken: msg.contextToken });
  return true;
});
