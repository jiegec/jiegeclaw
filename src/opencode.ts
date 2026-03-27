import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient, Event, Part, ToolPart, PermissionRequest, QuestionRequest, Message } from "@opencode-ai/sdk/v2";
import { stringify, parse } from "yaml";
import type { InboundMessage, OutboundMessage } from "./types.js";
import { loadSessions, saveSession } from "./config.js";

export interface StreamHandler {
  send(msg: OutboundMessage): Promise<void>;
  waitForReply(msg: OutboundMessage, validChoices?: string[]): Promise<string>;
}

interface SessionEntry {
  sessionID: string;
  activeMsg: InboundMessage | null;
  stream: StreamHandler;
  childSessionIDs: Set<string>;
}

export class OpencodeHandler {
  private client: OpencodeClient;
  private sessions: Map<string, SessionEntry> = new Map();

  constructor(opencodeBaseUrl: string | undefined) {
    this.client = createOpencodeClient(
      opencodeBaseUrl ? { baseUrl: opencodeBaseUrl } : undefined,
    );
  }

  async createSession(channelId: string, stream: StreamHandler): Promise<void> {
    const sessions = loadSessions();
    const savedSessionID = sessions[channelId];
    let sessionID: string;

    if (savedSessionID !== undefined) {
      try {
        await this.client.session.get({ sessionID: savedSessionID });
        sessionID = savedSessionID;
        console.log(`[${channelId}] Reusing existing OpenCode session ${sessionID}`);
      } catch {
        console.log(`[${channelId}] Saved session ${savedSessionID} not found, creating new one`);
        const session = await this.client.session.create();
        const id = session.data?.id;
        if (id === undefined) throw new Error("Failed to create session");
        sessionID = id;
      }
    } else {
      const session = await this.client.session.create();
      const id = session.data?.id;
      if (id === undefined) throw new Error("Failed to create session");
      sessionID = id;
    }

    saveSession(channelId, sessionID);

    const entry: SessionEntry = {
      sessionID,
      activeMsg: null,
      stream,
      childSessionIDs: new Set(),
    };
    this.sessions.set(channelId, entry);

    if (sessionID !== savedSessionID) {
      console.log(`[${channelId}] Created OpenCode session ${sessionID}`);
    }

    this.runEventLoop(channelId, entry);
  }

  async handle(channelId: string, msg: InboundMessage): Promise<void> {
    const entry = this.sessions.get(channelId);
    if (!entry) throw new Error(`No session for channel ${channelId}`);

    entry.activeMsg = msg;

    await this.client.session.promptAsync({
      sessionID: entry.sessionID,
      parts: [{ type: "text" as const, text: msg.text }],
    });
  }

  private async runEventLoop(channelId: string, entry: SessionEntry): Promise<void> {
    const messages: Map<string, Message> = new Map();
    while (true) {
      try {
        const result = await this.client.event.subscribe();

        for await (const event of result.stream) {
          const e = event as Event;

          if (e.type === "session.updated") {
            const info = e.properties.info;
            if (info.parentID === entry.sessionID && e.properties.sessionID !== entry.sessionID) {
              const isNew = !entry.childSessionIDs.has(e.properties.sessionID);
              entry.childSessionIDs.add(e.properties.sessionID);
              const baseMsg = this.createBaseMsg(entry);
              if (isNew && baseMsg !== null) {
                const title = info.title ?? "subagent";
                await entry.stream.send({ ...baseMsg, text: `🤖 Launching subagent: ${title}` });
              }
              console.log(`[${channelId}] Tracking child session ${e.properties.sessionID}`);
            }
          } else if (e.type === "session.status" && e.properties.sessionID !== entry.sessionID && entry.childSessionIDs.has(e.properties.sessionID)) {
            const status = (e.properties as { status: { type: string } }).status;
            const baseMsg = this.createBaseMsg(entry);
            if (status.type === "idle" && baseMsg !== null) {
              await entry.stream.send({ ...baseMsg, text: `✅ Subagent finished` });
            }
          }

          const isOwnEvent = (sessionID: string | undefined) =>
            sessionID === entry.sessionID || (sessionID !== undefined && entry.childSessionIDs.has(sessionID));

          if (e.type === "session.error" && isOwnEvent(e.properties.sessionID)) {
            const errObj = e.properties.error;
            let errMsg = "unknown error";
            if (errObj && "data" in errObj && (errObj as { data: { message?: string } }).data?.message) {
              errMsg = (errObj as { data: { message?: string } }).data.message!;
            }
            const baseMsg = this.createBaseMsg(entry);
            if (baseMsg !== null) {
              await entry.stream.send({ ...baseMsg, text: `Error: ${errMsg}` });
            }
            entry.activeMsg = null;
          } else if (e.type === "permission.asked" && isOwnEvent(e.properties.sessionID)) {
            await this.handlePermission(entry, e.properties);
          } else if (e.type === "question.asked" && isOwnEvent(e.properties.sessionID)) {
            await this.handleQuestion(entry, e.properties);
          } else if (e.type === "message.updated" && isOwnEvent(e.properties.sessionID)) {
            messages.set(e.properties.info.id, e.properties.info);
          } else if (e.type === "message.part.updated" && isOwnEvent(e.properties.part.sessionID)) {
            const part = e.properties.part;
            const text = partToText(part);
            const baseMsg = this.createBaseMsg(entry);
            const role = messages.get(e.properties.part.messageID)?.role;
            if (role === "assistant" && text !== null && text.length > 0 && baseMsg !== null) {
              await entry.stream.send({ ...baseMsg, text });
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
  }

  private createBaseMsg(entry: SessionEntry): OutboundMessage | null {
    if (!entry.activeMsg || !entry.stream) return null;
    return { to: entry.activeMsg.from, text: "", contextToken: entry.activeMsg.contextToken };
  }

  private async handlePermission(
    entry: SessionEntry,
    permission: PermissionRequest,
  ): Promise<void> {
    const baseMsg = this.createBaseMsg(entry);
    if (!baseMsg) return;

    const questionText =
      `❓ ${permission.permission}\n\n` +
      `1. Allow once\n2. Always allow\n3. Reject\n\n` +
      `Reply with number or label:`;

    const reply = await entry.stream!.waitForReply(
      { ...baseMsg, text: questionText },
      ["once", "always", "reject", "1", "2", "3", "allow once", "always allow", "reject"],
    );

    const choice = this.mapReplyToChoice(reply);
    if (!choice) return;

    try {
      await this.client.permission.reply({
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
    entry: SessionEntry,
    request: QuestionRequest,
  ): Promise<void> {
    const baseMsg = this.createBaseMsg(entry);
    if (!baseMsg) return;

    let answers = [];
    for (let question of request.questions) {
      let questionText =
        `❓ ${question.header}\n\n${question.question}\n\n`;
      let labels = [];
      for (let option of question.options) {
        questionText += `${option.label}: ${option.description}\n`;
        labels.push(option.label);
      }
      questionText += `Reply with label:`;

      const answer = await entry.stream!.waitForReply(
        { ...baseMsg, text: questionText },
        labels,
      );
      answers.push([answer]);
    }

    try {
      await this.client.question.reply({
        requestID: request.id,
        answers: answers,
      });
    } catch (err) {
      console.error(`Failed to reply to question ${request.id}:`, (err as Error).message);
    }
  }

  stop(): void {
    for (const [, entry] of this.sessions) {
      entry.activeMsg = null;
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
      return `${icon} **[${t.priority}]** ${t.content}`;
    });
    return `✅ **[todowrite]** **${title}**\n\n${lines.join("\n")}`;
  } catch {
    return null;
  }
}
