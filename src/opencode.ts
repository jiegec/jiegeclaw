import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient, Event, Part, ToolPart, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { InboundMessage, OutboundMessage } from "./types.js";

export interface StreamHandler {
  send(msg: OutboundMessage): Promise<void>;
  waitForReply(msg: OutboundMessage, validChoices?: string[]): Promise<string>;
}

export class OpencodeHandler {
  private client: OpencodeClient;
  private sessionID: string | null = null;
  private eventAbortController: AbortController | null = null;

  constructor(opencodeBaseUrl: string | undefined) {
    this.client = createOpencodeClient(
      opencodeBaseUrl ? { baseUrl: opencodeBaseUrl } : undefined,
    );
  }

  async initialize(): Promise<void> {
    const session = await this.client.session.create();
    this.sessionID = session.data?.id ?? null;
    console.log(`Created OpenCode session ${this.sessionID}`);
  }

  private async ensureSession(): Promise<string> {
    if (!this.sessionID) {
      await this.initialize();
    }
    if (!this.sessionID) {
      throw new Error("Failed to get or create session");
    }
    return this.sessionID;
  }

  async handle(msg: InboundMessage, stream: StreamHandler): Promise<void> {
    const sessionID = await this.ensureSession();

    await this.client.session.promptAsync({
      sessionID: sessionID,
      parts: [{ type: "text" as const, text: msg.text }],
    });

    const baseMsg: OutboundMessage = { to: msg.from, text: "", contextToken: msg.contextToken };

    try {
      await this.processEvents(sessionID, stream, baseMsg);
    } finally {
      this.eventAbortController = null;
    }
  }

  private async processEvents(
    sessionID: string,
    stream: StreamHandler,
    baseMsg: OutboundMessage,
  ): Promise<void> {
    this.eventAbortController = new AbortController();

    try {
      const result = await this.client.event.subscribe();

      for await (const event of result.stream) {
        const e = event as Event;

        if (e.type === "session.idle" && e.properties.sessionID === sessionID) {
          return;
        } else if (e.type === "session.error") {
          const errObj = e.properties.error;
          let errMsg = "unknown error";
          if (errObj && "data" in errObj && (errObj as { data: { message?: string } }).data?.message) {
            errMsg = (errObj as { data: { message?: string } }).data.message!;
          }
          await stream.send({ ...baseMsg, text: `Error: ${errMsg}` });
          return;
        } else if (e.type === "permission.asked" && e.properties.sessionID === sessionID) {
          await this.handlePermission(e.properties, stream, baseMsg);
        } else if (e.type === "question.asked" && e.properties.sessionID === sessionID) {
          await this.handleQuestion(e.properties, stream, baseMsg);
        } else if (e.type === "message.part.updated" && e.properties.part.sessionID === sessionID) {
          const part = e.properties.part;
          if (part.type === "tool" && part.tool === "question" && part.state.status === "running") {

          } else {
            const text = partToText(part);
            if (text) await stream.send({ ...baseMsg, text });
          }
        }
      }
    } finally {
      this.eventAbortController = null;
    }
  }

  private async handlePermission(
    permission: PermissionRequest,
    stream: StreamHandler,
    baseMsg: OutboundMessage,
  ): Promise<void> {
    const questionText =
      `❓ ${permission.permission}\n\n` +
      `1. Allow once\n2. Always allow\n3. Reject\n\n` +
      `Reply with number or label:`;

    const reply = await stream.waitForReply(
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
    request: QuestionRequest,
    stream: StreamHandler,
    baseMsg: OutboundMessage,
  ): Promise<void> {
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

      // TODO: multiple choices
      const answer = await stream.waitForReply(
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

  abort(): void {
    this.eventAbortController?.abort();
  }
}

function partToText(part: Part): string | null {
  switch (part.type) {
    case "tool": return formatToolPart(part);
    case "agent": return `🤖 Agent: ${part.name}`;
    case "subtask": return `📋 Subtask [${part.agent}]: ${part.description}`;
    case "retry":
      return `🔁 Retry #${part.attempt}: ${part.error.data.message ?? "unknown error"}`;
    case "patch": return `📝 Patch ${part.hash}: ${part.files.join(", ")}`;
    case "file": return `📎 ${part.filename ?? part.url} (${part.mime})`;
    case "snapshot": return `📸 Snapshot: ${part.snapshot.slice(0, 8)}`;
    case "compaction": return `📦 Compaction${part.auto ? " (auto)" : ""}`;
    case "reasoning": return `💭 ${part.text}`;
    case "text": return part.text;
    default: return null;
  }
}

function formatToolPart(p: ToolPart): string | null {
  switch (p.state.status) {
    case "pending": return null;
    case "running": return `⚙️ ${p.tool} with args ${JSON.stringify(p.state.input)}`;
    case "completed": return `✅ ${p.tool}: ${p.state.output !== undefined ? p.state.output.slice(0, 200) : "(no output)"}`;
    case "error": return `❌ ${p.tool}: ${p.state.error}`;
  }
}
