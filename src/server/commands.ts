/**
 * Slash command handlers for the server.
 *
 * Processes user commands like /cd, /status, /projects, etc.
 */

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
  await handler.cd(channel.id, args);
  await channel.send({ to: msg.from, text: `📁 Switched to ${args}`, contextToken: msg.contextToken });
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

registerCommand("help", async ({ channel, msg }) => {
  await channel.send({ to: msg.from, text: "**Available commands:**\n\n- `/cd <path>`: Switch to a different project directory\n- `/status`: Show current session status\n- `/projects`: List opencode projects\n- `/reset`: Reset to a new opencode session\n- `/restart`: Restart the bot\n- `/help`: Show this help message", contextToken: msg.contextToken });
  return true;
});
