import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { InboundMessage } from "./types.js";

export class OpencodeHandler {
  private client: OpencodeClient;
  private sessionId: string | null = null;

  constructor(opencodeBaseUrl: string | undefined) {
    this.client = createOpencodeClient(
      opencodeBaseUrl ? { baseUrl: opencodeBaseUrl } : undefined,
    );
  }

  async initialize(): Promise<void> {
    const session = await this.client.session.create();
    this.sessionId = session.data?.id ?? null;
    console.log(`Created OpenCode session ${this.sessionId}`);
  }

  async handle(msg: InboundMessage): Promise<string> {
    if (!this.sessionId) {
      await this.initialize();
    }
    if (!this.sessionId) {
      throw new Error("Failed to get or create session");
    }

    const result = await this.client.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: "text" as const, text: msg.text }],
      },
    });

    const parts = result.data?.parts ?? [];
    if (parts.length === 0) return "(no response)";

    const lines: string[] = [];
    for (const p of parts) {
      switch (p.type) {
        case "text":
          lines.push(p.text);
          break;
        case "reasoning":
          lines.push(`💭 ${p.text}`);
          break;
        case "tool":
          lines.push(formatToolPart(p));
          break;
        case "patch":
          lines.push(`📝 Patch ${p.hash}: ${p.files.join(", ")}`);
          break;
        case "file":
          lines.push(`📎 ${p.filename ?? p.url} (${p.mime})`);
          break;
        case "agent":
          lines.push(`🤖 Agent: ${p.name}`);
          break;
        case "retry":
          lines.push(`🔁 Retry #${p.attempt}: ${p.error.data.message ?? "unknown error"}`);
          break;
        case "subtask":
          lines.push(`📋 Subtask [${p.agent}]: ${p.description}`);
          break;
        case "step-start":
          lines.push(`▶️ Step started`);
          break;
        case "step-finish":
          lines.push(
            `⏹️ Step finished (${p.reason}): ${p.tokens?.input ?? "?"}in / ${p.tokens?.output ?? "?"}out, $${p.cost?.toFixed(4) ?? "?"}`,
          );
          break;
        case "snapshot":
          lines.push(`📸 Snapshot: ${p.snapshot.slice(0, 8)}`);
          break;
        case "compaction":
          lines.push(`📦 Compaction${p.auto ? " (auto)" : ""}`);
          break;
        default:
          lines.push(JSON.stringify(p));
          break;
      }
    }
    return lines.join("\n");
  }
}

function formatToolPart(p: {
  tool: string;
  callID: string;
  state: { status: string; title?: string; output?: string; error?: string; input?: unknown };
}): string {
  const title = p.state.title ?? p.tool;
  switch (p.state.status) {
    case "pending":
      return `🔧 ${title}...`;
    case "running":
      return `⚙️ ${title}...`;
    case "completed":
      return `✅ ${title}: ${p.state.output !== undefined ? p.state.output.slice(0, 200) : "(no output)"}`;
    case "error":
      return `❌ ${title}: ${p.state.error ?? "unknown error"}`;
    default:
      return `🔧 ${title} (${p.state.status})`;
  }
}
