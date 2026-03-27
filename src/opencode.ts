import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient, Event, Part, ToolPart, PermissionRequest, QuestionRequest, Message } from "@opencode-ai/sdk/v2";
import { stringify, parse } from "yaml";
import type { InboundMessage, OutboundMessage } from "./types.js";
import {
  loadSessions,
  getLastDir,
  getSessionIdForDir,
  updateChannelSession,
} from "./config.js";

export interface StreamHandler {
  send(msg: OutboundMessage): Promise<void>;
  waitForReply(msg: OutboundMessage, validChoices?: string[]): Promise<string>;
}

interface ServerProcess {
  proc: ChildProcess;
  url: string;
  close(): void;
}

interface ChannelState {
  stream: StreamHandler;
  directory: string;
  server: ServerProcess;
  client: OpencodeClient;
  sessionID: string;
  activeMsg: InboundMessage | null;
  childSessionIDs: Set<string>;
  abortController: AbortController;
}

export class OpencodeHandler {
  private channelStates: Map<string, ChannelState> = new Map();
  private portCounter = 4096;

  setStream(channelId: string, stream: StreamHandler): void {
    const existing = this.channelStates.get(channelId);
    if (existing) {
      existing.stream = stream;
    } else {
      this.channelStates.set(channelId, { stream } as ChannelState);
    }
  }

  hasDirectory(channelId: string): boolean {
    return getLastDir(channelId, loadSessions()) !== undefined;
  }

  async ensureSession(channelId: string): Promise<void> {
    const existing = this.channelStates.get(channelId);
    if (existing?.server) return;
    const sessions = loadSessions();
    const lastDir = getLastDir(channelId, sessions);
    if (!lastDir) throw new Error(`No directory for channel ${channelId}`);
    await this.cd(channelId, lastDir);
  }

  async cd(channelId: string, directory: string): Promise<void> {
    const existing = this.channelStates.get(channelId);
    const stream = existing?.stream;
    if (!stream) throw new Error(`No stream for channel ${channelId}`);

    if (existing?.server) {
      console.log(`[${channelId}] Tearing down old server in ${existing.directory}`);
      existing.abortController.abort();
      existing.activeMsg = null;
      existing.server.close();
    }

    const sessions = loadSessions();
    const savedSessionID = getSessionIdForDir(channelId, directory, sessions);

    const port = this.portCounter++;
    console.log(`[${channelId}] Spawning opencode serve on port ${port}...`);
    const server = await this.spawnServer(directory, port);
    console.log(`[${channelId}] Server started at ${server.url}`);
    const client = createOpencodeClient({ baseUrl: server.url });

    let sessionID: string;
    if (savedSessionID !== undefined) {
      try {
        await client.session.get({ sessionID: savedSessionID });
        sessionID = savedSessionID;
        console.log(`[${channelId}] Reusing session ${sessionID} for ${directory}`);
      } catch {
        console.log(`[${channelId}] Saved session ${savedSessionID} not found, creating new one`);
        const session = await client.session.create();
        const id = session.data?.id;
        if (id === undefined) throw new Error("Failed to create session");
        sessionID = id;
        console.log(`[${channelId}] Created new session ${sessionID}`);
      }
    } else {
      const session = await client.session.create();
      const id = session.data?.id;
      if (id === undefined) throw new Error("Failed to create session");
      sessionID = id;
      console.log(`[${channelId}] Created new session ${sessionID}`);
    }

    updateChannelSession(channelId, directory, sessionID, sessions);

    this.channelStates.set(channelId, {
      stream,
      directory,
      server,
      client,
      sessionID,
      activeMsg: null,
      childSessionIDs: new Set(),
      abortController: new AbortController(),
    });

    console.log(`[${channelId}] Session ${sessionID} in ${directory}`);
    this.runEventLoop(channelId);
  }

  async handle(channelId: string, msg: InboundMessage): Promise<void> {
    const state = this.channelStates.get(channelId);
    if (!state) throw new Error(`No session for channel ${channelId}`);

    state.activeMsg = msg;

    await state.client.session.promptAsync({
      sessionID: state.sessionID,
      parts: [{ type: "text" as const, text: msg.text }],
    });
  }

  private spawnServer(directory: string, port: number): Promise<ServerProcess> {
    return new Promise((resolve, reject) => {
      const proc = spawn("opencode", [`serve`, `--hostname=127.0.0.1`, `--port=${port}`], {
        cwd: directory,
        env: process.env,
      });

      const timeout = setTimeout(() => {
        proc.kill();
        reject(new Error(`Timeout waiting for opencode server in ${directory}`));
      }, 15000);

      let output = "";
      const onOutput = (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/opencode server listening on\s+(https?:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timeout);
          proc.stdout?.off("data", onOutput);
          proc.stderr?.off("data", onOutput);
          resolve({ proc, url: match[1], close() { proc.kill(); } });
        }
      };

      proc.stdout?.on("data", onOutput);
      proc.stderr?.on("data", onOutput);
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`opencode server exited with code ${code}`));
      });
      proc.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  private createBaseMsg(state: ChannelState): OutboundMessage | null {
    if (!state.activeMsg) return null;
    return { to: state.activeMsg.from, text: "", contextToken: state.activeMsg.contextToken };
  }

  private async runEventLoop(channelId: string): Promise<void> {
    const state = this.channelStates.get(channelId);
    if (!state) return;

    const { client, sessionID, abortController, stream } = state;
    const messages: Map<string, Message> = new Map();

    while (!abortController.signal.aborted) {
      try {
        const result = await client.event.subscribe();
        console.log(`[${channelId}] Event stream connected`);

        for await (const event of result.stream) {
          if (abortController.signal.aborted) break;

          const e = event as Event;

          if (e.type === "session.updated") {
            const info = e.properties.info;
            if (info.parentID === sessionID && e.properties.sessionID !== sessionID) {
              const isNew = !state.childSessionIDs.has(e.properties.sessionID);
              state.childSessionIDs.add(e.properties.sessionID);
              const baseMsg = this.createBaseMsg(state);
              if (isNew && baseMsg !== null) {
                const title = info.title ?? "subagent";
                await stream.send({ ...baseMsg, text: `🤖 Launching subagent: **${title}**` });
              }
              console.log(`[${channelId}] Tracking child session ${e.properties.sessionID}`);
            }
          } else if (e.type === "session.status" && e.properties.sessionID !== sessionID && state.childSessionIDs.has(e.properties.sessionID)) {
            const status = (e.properties as { status: { type: string } }).status;
            const baseMsg = this.createBaseMsg(state);
            if (status.type === "idle" && baseMsg !== null) {
              await stream.send({ ...baseMsg, text: `✅ **Subagent finished**` });
            }
          }

          const isOwnEvent = (sid: string | undefined) =>
            sid === sessionID || (sid !== undefined && state.childSessionIDs.has(sid));

          if (e.type === "session.error" && isOwnEvent(e.properties.sessionID)) {
            const errObj = e.properties.error;
            let errMsg = "unknown error";
            if (errObj && "data" in errObj && (errObj as { data: { message?: string } }).data?.message) {
              errMsg = (errObj as { data: { message?: string } }).data.message!;
            }
            const baseMsg = this.createBaseMsg(state);
            if (baseMsg !== null) {
              await stream.send({ ...baseMsg, text: `Error: ${errMsg}` });
            }
            state.activeMsg = null;
            console.error(`[${channelId}] Session error: ${errMsg}`);
          } else if (e.type === "permission.asked" && isOwnEvent(e.properties.sessionID)) {
            await this.handlePermission(channelId, client, stream, state, e.properties);
          } else if (e.type === "question.asked" && isOwnEvent(e.properties.sessionID)) {
            await this.handleQuestion(channelId, client, stream, state, e.properties);
          } else if (e.type === "message.updated" && isOwnEvent(e.properties.sessionID)) {
            messages.set(e.properties.info.id, e.properties.info);
          } else if (e.type === "message.part.updated" && isOwnEvent(e.properties.part.sessionID)) {
            const part = e.properties.part;
            const text = partToText(part);
            const baseMsg = this.createBaseMsg(state);
            const role = messages.get(e.properties.part.messageID)?.role;
            if (role === "assistant" && text !== null && text.length > 0 && baseMsg !== null) {
              await stream.send({ ...baseMsg, text });
            }
            if (text !== null && text.length > 0) {
              messages.delete(e.properties.part.messageID);
            }
          }
        }
      } catch (err) {
        console.error(`[${channelId}] Event loop error, reconnecting:`, (err as Error).message);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    console.log(`[${channelId}] Event loop exited`);
  }

  private async handlePermission(
    channelId: string,
    client: OpencodeClient,
    stream: StreamHandler,
    state: ChannelState,
    permission: PermissionRequest,
  ): Promise<void> {
    const baseMsg = this.createBaseMsg(state);
    if (!baseMsg) return;

    const questionText =
      `❓ ${permission.permission}\n\n` +
      `1. **Allow once**\n2. **Always allow**\n3. **Reject**\n\n` +
      `Reply with number or label:`;

    const reply = await stream.waitForReply(
      { ...baseMsg, text: questionText },
      ["once", "always", "reject", "1", "2", "3", "allow once", "always allow", "reject"],
    );

    const choice = this.mapReplyToChoice(reply);
    if (!choice) {
      console.warn(`[${channelId}] Unrecognized permission reply: "${reply}"`);
      return;
    }

    try {
      console.log(`[${channelId}] Permission reply: ${choice} (request ${permission.id})`);
      await client.permission.reply({
        requestID: permission.id,
        reply: choice,
      });
    } catch (err) {
      console.error(`Failed to respond to permission ${permission.id}:`, (err as Error).message);
    }
  }

  private mapReplyToChoice(reply: string): "once" | "always" | "reject" | null {
    switch (reply) {
      case "once":
      case "1":
      case "allow once":
        return "once";
      case "always":
      case "2":
      case "always allow":
        return "always";
      case "reject":
      case "3":
        return "reject";
      default:
        return null;
    }
  }

  private async handleQuestion(
    channelId: string,
    client: OpencodeClient,
    stream: StreamHandler,
    state: ChannelState,
    request: QuestionRequest,
  ): Promise<void> {
    const baseMsg = this.createBaseMsg(state);
    if (!baseMsg) return;

    let answers = [];
    for (let question of request.questions) {
      let questionText =
        `❓ **${question.header}**\n\n${question.question}\n\n`;
      let labels = [];
      for (let option of question.options) {
        questionText += `- **${option.label}**: ${option.description}\n`;
        labels.push(option.label);
      }
      questionText += `\nReply with label:`;

      const answer = await stream.waitForReply(
        { ...baseMsg, text: questionText },
        labels,
      );
      console.log(`[${channelId}] Question answered: "${answer}"`);
      answers.push([answer]);
    }

    try {
      await client.question.reply({
        requestID: request.id,
        answers: answers,
      });
    } catch (err) {
      console.error(`Failed to reply to question ${request.id}:`, (err as Error).message);
    }
  }

  stop(): void {
    for (const [channelId, state] of this.channelStates) {
      console.log(`[${channelId}] Stopping session ${state.sessionID}`);
      state.activeMsg = null;
      state.abortController.abort();
      state.server?.close();
    }
  }
}

function partToText(part: Part): string | null {
  switch (part.type) {
    case "tool": return formatToolPart(part);
    case "agent": return `🤖 **Agent:** ${part.name}`;
    case "subtask": return `📋 **Subtask** \`${part.agent}\`: ${part.description}`;
    case "retry":
      return `🔁 **Retry** #${part.attempt}: ${part.error.data.message ?? "unknown error"}`;
    case "patch": return `📝 **Patch** \`${part.hash}\`: \`${part.files.join("`, `")}\``;
    case "file": return `📎 [${part.filename ?? part.url}](${part.url ?? ""}) (${part.mime})`;
    case "snapshot": return `📸 **Snapshot:** \`${part.snapshot.slice(0, 8)}\``;
    case "compaction": return `📦 **Compaction**${part.auto ? " (auto)" : ""}`;
    case "reasoning": return `> 💭 *${part.text}*`;
    case "text": return part.text;
    default: return null;
  }
}

function formatToolPart(p: ToolPart): string | null {
  switch (p.state.status) {
    case "pending": return null;
    case "running": return null;
    case "completed": {
      const out = p.state.output;
      if (p.tool === "todowrite") {
        const formatted = formatTodoWrite(p.state.title, out);
        if (formatted !== null) {
          return formatted;
        }
      }
      const truncatedOut = out.length > 200;
      const inputStr = stringify(p.state.input).trim();
      const truncatedInput = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
      const outPreview = out.trim().slice(0, 200);
      return `✅ **[${p.tool}]** ${p.state.title}\n\`\`\`\n${truncatedInput}\n\`\`\`\n**Output:**\n\`\`\`\n${outPreview}${truncatedOut ? "..." : ""}\n\`\`\``;
    }
    case "error": return `❌ **Error** [${p.tool}]: ${p.state.error}`;
  }
}

function formatTodoWrite(title: string, output: string): string | null {
  try {
    const todos = parse(output) as Array<{ content: string; priority: string; status: string }>;
    const statusIcon: Record<string, string> = {
      completed: "✅",
      in_progress: "🔄",
      pending: "⬜",
      cancelled: "❌",
    };
    const lines = todos.map((t) => {
      const icon = statusIcon[t.status] ?? "⬜";
      return `- ${icon} **[${t.priority}]** ${t.content}`;
    });
    return `✅ **[todowrite]** **${title}**\n\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}
