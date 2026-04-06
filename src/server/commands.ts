/**
 * Slash command handlers for the server.
 *
 * Processes user commands like /cd, /status, /projects, etc.
 */

import path from "node:path";
import os from "node:os";
import type { Channel, InboundMessage } from "../types.js";
import type { OpencodeHandler } from "../opencode/index.js";

export interface CommandContext {
  channel: Channel;
  msg: InboundMessage;
  handler: OpencodeHandler;
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
  await channel.send({ to: msg.from, text: "**Available commands:**\n\n- `/cd <path>`: Switch to a different project directory\n- `/status`: Show current session status\n- `/projects`: List opencode projects\n- `/compact`: Compact the session context\n- `/reset`: Reset to a new opencode session\n- `/abort`: Abort the current generation\n- `/restart`: Restart the bot\n- `/help`: Show this help message", contextToken: msg.contextToken });
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
