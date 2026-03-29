/**
 * Message formatting utilities for opencode events.
 *
 * Converts opencode message parts to human-readable text representations
 * for display in chat channels.
 */

import type { Part, ToolPart } from "@opencode-ai/sdk/v2";
import { stringify, parse } from "yaml";

/**
 * Convert an opencode message part to a human-readable text representation.
 * Returns undefined for parts that shouldn't be displayed (e.g., step-start/step-finish).
 */
export function partToText(part: Part): string | undefined {
  switch (part.type) {
    case "tool": return formatToolPart(part);
    case "agent": return `🤖 **Agent:** ${part.name}`;
    case "subtask": return `📋 **Subtask** \`${part.agent}\`: ${part.description}`;
    case "retry":
      return `🔁 **Retry** #${part.attempt}: ${part.error.data.message}`;
    case "patch": return `📝 **Patch** \`${part.hash}\`: \`${part.files.join("`, `")}\``;
    case "file": return `📎 [${part.filename ?? part.url}](${part.url ?? ""}) (${part.mime})`;
    case "snapshot": return `📸 **Snapshot:** \`${part.snapshot.slice(0, 8)}\``;
    case "compaction": return `📦 **Compaction**${part.auto ? " (auto)" : ""}`;
    case "reasoning": return formatReasoning(part.text);
    case "text": return part.text;
    case "step-start": return undefined;
    case "step-finish": return undefined;
    default: return undefined;
  }
}

/**
 * Format reasoning text with blockquote style.
 */
function formatReasoning(text: string): string {
  return `💭 ${text}`;
}

/**
 * Format content based on part type for streaming.
 * This applies the same formatting as partToText but works with raw content.
 */
export function formatStreamingContent(content: string, partType: string): string {
  switch (partType) {
    case "reasoning": return formatReasoning(content);
    case "text": return content;
    default: return content;
  }
}

/**
 * Format a tool execution part for display.
 * All states (pending/running/completed/error) return displayable text for streaming.
 */
export function formatToolPart(p: ToolPart): string {
  switch (p.state.status) {
    case "pending": {
      const inputStr = stringify(p.state.input).trim();
      if (inputStr !== "{}") {
        const truncatedInput = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
        return `⏳ **[${p.tool}]** Pending...\n\`\`\`\n${truncatedInput}\n\`\`\``;
      } else {
        return `⏳ **[${p.tool}]** Pending...`;
      }
    }
    case "running": {
      const title = p.state.title ?? "Running...";
      const inputStr = stringify(p.state.input).trim();
      const truncatedInput = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
      return `🔄 **[${p.tool}]** ${title}\n\`\`\`\n${truncatedInput}\n\`\`\``;
    }
    case "completed": {
      const out = p.state.output;
      // Special formatting for todowrite tool: show a checklist instead of raw YAML
      if (p.tool === "todowrite") {
        const formatted = formatTodoWrite(p.state.title, out);
        if (formatted !== undefined) {
          return formatted;
        }
      }
      const inputStr = stringify(p.state.input).trim();
      const truncatedInput = inputStr.length > 500 ? inputStr.slice(0, 500) + "..." : inputStr;
      const truncatedOut = out.length > 500;
      const outPreview = out.trim().slice(0, 500);
      return `✅ **[${p.tool}]** ${p.state.title}\n\`\`\`\n${truncatedInput}\n\`\`\`\n**Output:**\n\`\`\`\n${outPreview}${truncatedOut ? "..." : ""}\n\`\`\``;
    }
    case "error": return `❌ **Error** [${p.tool}]: ${p.state.error}`;
  }
}

/**
 * Special formatting for the todowrite tool.
 * Parses the YAML output into a checklist with status icons and priority labels.
 */
function formatTodoWrite(title: string, output: string): string | undefined {
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
    return undefined;
  }
}
