/**
 * Opencode session manager.
 *
 * Manages per-channel opencode sessions by spawning a dedicated opencode server
 * process for each channel's working directory. Each server runs on its own port
 * and sessions are persisted across restarts so conversations can be resumed.
 *
 * Key responsibilities:
 * - Spawning and managing opencode server child processes
 * - Creating/reusing opencode sessions per channel+directory
 * - Subscribing to the event stream and forwarding assistant messages to channels
 * - Handling permission requests and questions by delegating to the channel's reply mechanism
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { OpencodeClient, Event, Part, ToolPart, PermissionRequest, QuestionRequest, Message } from "@opencode-ai/sdk/v2";
import { stringify, parse } from "yaml";
import type { InboundMessage, OutboundMessage } from "./types.js";
import {
  loadSessions,
  getLastDir,
  getLastFrom,
  getSessionIdForDir,
  updateChannelSession,
} from "./config.js";

/**
 * Interface for sending messages and waiting for user replies on a channel.
 * Implemented by the Server class, which bridges opencode events to channel sends.
 */
export interface StreamHandler {
  /** Send a message to the channel. */
  send(msg: OutboundMessage): Promise<void>;
  /**
   * Send a message and wait for a reply from the user.
   * Optionally restrict valid replies to a set of choices.
   */
  waitForReply(msg: OutboundMessage, validChoices?: string[]): Promise<string>;
}

/** Represents a running opencode server child process. */
interface ServerProcess {
  proc: ChildProcess;
  /** The HTTP URL the server is listening on. */
  url: string;
  /** Kill the server process. */
  close(): void;
}

/** Per-channel state tracking the active session and server process. */
interface ChannelState {
  /** The stream handler for sending messages back to the channel. */
  stream: StreamHandler;
  /** The working directory for this channel's opencode session. */
  directory?: string;
  /** The running opencode server process. */
  server?: ServerProcess;
  /** The opencode SDK client connected to the server. */
  client?: OpencodeClient;
  /** The active opencode session ID. */
  sessionID?: string;
  /** The inbound message currently being processed (used for reply addressing). */
  activeMsg?: InboundMessage;
  /** Set of subagent (child) session IDs spawned by the main session. */
  childSessionIDs?: Set<string>;
  /** Controller to abort the event loop when switching directories or stopping. */
  abortController?: AbortController;
}

export class OpencodeHandler {
  private channelStates: Map<string, ChannelState> = new Map();
  /** Counter for assigning unique ports to each spawned server. */
  private portCounter = 4096;

  /**
   * Set or update the stream handler for a channel.
   * Called during server startup before the channel starts listening.
   */
  setStream(channelId: string, stream: StreamHandler): void {
    const existing = this.channelStates.get(channelId);
    if (existing) {
      existing.stream = stream;
    } else {
      this.channelStates.set(channelId, { stream } as ChannelState);
    }
  }

  /** Check if a channel has a configured working directory (from saved sessions). */
  hasDirectory(channelId: string): boolean {
    return getLastDir(channelId) !== undefined;
  }

  /** Get the current status of a channel (directory and optional session ID). */
  getStatus(channelId: string): { directory?: string; sessionID?: string } {
    const state = this.channelStates.get(channelId);
    if (!state) {
      const lastDir = getLastDir(channelId);
      return { directory: lastDir };
    }
    return { directory: state.directory, sessionID: state.sessionID };
  }

  async getProjects(channelId: string): Promise<Array<{ id: string; name?: string; worktree: string }>> {
    await this.ensureSession(channelId);
    const state = this.channelStates.get(channelId);
    if (!state || !state.client) return [];
    const result = await state.client.project.list();
    return (result.data ?? []).map((p) => ({ id: p.id, name: p.name, worktree: p.worktree }));
  }

  /**
   * Helper to create a new opencode session and return its ID.
   * Throws if session creation fails.
   */
  private async createSession(channelId: string, client: OpencodeClient): Promise<string> {
    const session = await client.session.create();
    const sessionID = session.data?.id;
    if (sessionID === undefined) throw new Error("Failed to create session");
    console.log(`[${channelId}] Created new session ${sessionID}`);
    return sessionID;
  }

  /**
   * Reset the session for a channel by creating a new opencode session.
   * The old session is abandoned (not deleted) and a new one is created.
   * Returns the new session ID.
   */
  async resetSession(channelId: string): Promise<string> {
    const state = this.channelStates.get(channelId);
    if (!state || !state.client || !state.directory) throw new Error(`No active session for channel ${channelId}`);

    // Tear down the old event loop
    state.abortController?.abort();
    state.activeMsg = undefined;

    // Create a new session
    const newSessionID = await this.createSession(channelId, state.client);

    // Update the channel state with the new session ID and reset child sessions
    state.sessionID = newSessionID;
    state.childSessionIDs = new Set();
    state.abortController = new AbortController();

    // Persist the new session mapping
    updateChannelSession(channelId, state.directory, newSessionID);

    console.log(`[${channelId}] Reset to new session ${newSessionID}`);

    // Launch a new event loop for the new session
    this.runEventLoop(channelId);

    return newSessionID;
  }

  /**
   * Ensure a session exists for the channel.
   * If the channel already has an active server, this is a no-op.
   * Otherwise, it changes to the last used directory.
   */
  async ensureSession(channelId: string): Promise<void> {
    const existing = this.channelStates.get(channelId);
    if (existing?.server) return;
    const lastDir = getLastDir(channelId);
    if (!lastDir) throw new Error(`No directory for channel ${channelId}`);
    await this.cd(channelId, lastDir);

    // Send a restore notification to the last user who interacted with this channel
    const state = this.channelStates.get(channelId);
    const lastFrom = getLastFrom(channelId);
    if (state && lastFrom) {
      await state.stream.send({
        to: lastFrom,
        text: `Session restored in \`${state.directory}\` (${state.sessionID?.slice(0, 8)})`,
      });
    }
  }

  /**
   * Change the working directory for a channel.
   * Tears down any existing server, spawns a new opencode server in the target
   * directory, and creates or reuses a session. Session state is persisted.
   */
  async cd(channelId: string, directory: string): Promise<void> {
    const existing = this.channelStates.get(channelId);
    const stream = existing?.stream;
    if (!stream) throw new Error(`No stream for channel ${channelId}`);

    // Tear down any existing server for this channel
    if (existing?.server) {
      console.log(`[${channelId}] Tearing down old server in ${existing.directory}`);
      existing.abortController?.abort();
      existing.activeMsg = undefined;
      existing.server.close();
    }

    // Check if we have a saved session for this directory
    const sessions = loadSessions();
    const savedSessionID = getSessionIdForDir(channelId, directory, sessions);

    // Spawn a new opencode server on a unique port
    const port = this.portCounter++;
    console.log(`[${channelId}] Spawning opencode serve on port ${port}...`);
    const server = await this.spawnServer(directory, port);
    console.log(`[${channelId}] Server started at ${server.url}`);
    const client = createOpencodeClient({ baseUrl: server.url });

    // Try to reuse the saved session, or create a new one
    let sessionID: string;
    if (savedSessionID !== undefined) {
      try {
        await client.session.get({ sessionID: savedSessionID });
        sessionID = savedSessionID;
        console.log(`[${channelId}] Reusing session ${sessionID} for ${directory}`);
      } catch {
        console.log(`[${channelId}] Saved session ${savedSessionID} not found, creating new one`);
        sessionID = await this.createSession(channelId, client);
      }
    } else {
      sessionID = await this.createSession(channelId, client);
    }

    // Persist the session mapping
    updateChannelSession(channelId, directory, sessionID);

    this.channelStates.set(channelId, {
      stream,
      directory,
      server,
      client,
      sessionID,
      activeMsg: undefined,
      childSessionIDs: new Set(),
      abortController: new AbortController(),
    });

    console.log(`[${channelId}] Session ${sessionID} in ${directory}`);
    this.runEventLoop(channelId);
  }

  /**
   * Send a user prompt to the opencode session.
   * The prompt is processed asynchronously; the event loop will handle
   * streaming the response back to the channel.
   */
  async handle(channelId: string, msg: InboundMessage): Promise<void> {
    const state = this.channelStates.get(channelId);
    if (!state) throw new Error(`No session for channel ${channelId}`);

    state.activeMsg = msg;

    // Persist the sender's ID so we can notify them on session restore after restart
    updateChannelSession(channelId, state.directory!, state.sessionID!, msg.from);

    await state.client!.session.promptAsync({
      sessionID: state.sessionID!,
      parts: [{ type: "text" as const, text: msg.text }],
    });
  }

  /**
   * Spawn an opencode server child process in the given directory.
   * Waits up to 15 seconds for the server to start and output its listening URL.
   * Rejects if the server exits or times out.
   */
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
        // Parse the server URL from the startup output
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

  /**
   * Build an outbound message template from the currently active inbound message.
   * Returns undefined if there's no active message (e.g., between requests).
   */
  private createBaseMsg(state: ChannelState): OutboundMessage | undefined {
    if (!state.activeMsg) return undefined;
    return { to: state.activeMsg.from, text: "", contextToken: state.activeMsg.contextToken };
  }

  /**
   * Main event loop for a channel's opencode session.
   * Subscribes to the opencode event stream and dispatches events:
   * - Streams assistant message parts back to the channel
   * - Handles permission requests and questions by prompting the user
   * - Tracks subagent (child) sessions and notifies the channel of their status
   *
   * Automatically reconnects on errors with a 1-second delay.
   */
  private async runEventLoop(channelId: string): Promise<void> {
    const state = this.channelStates.get(channelId);
    if (!state) return;

    const { client, sessionID, abortController, stream } = state;
    // Track full messages to determine the role (user vs assistant) of parts
    const messages: Map<string, Message> = new Map();

    while (!abortController!.signal.aborted) {
      try {
        const result = await client!.event.subscribe();
        console.log(`[${channelId}] Event stream connected`);

        for await (const event of result.stream) {
          if (abortController!.signal.aborted) break;
          const baseMsg = this.createBaseMsg(state);

          const e = event as Event;

          // Track subagent sessions spawned by this channel's main session
          if (e.type === "session.updated") {
            const info = e.properties.info;
            if (info.parentID === sessionID && e.properties.sessionID !== sessionID) {
              const isNew = !state.childSessionIDs!.has(e.properties.sessionID);
              state.childSessionIDs!.add(e.properties.sessionID);
              if (isNew && baseMsg !== undefined) {
                const title = info.title ?? "subagent";
                await stream.send({ ...baseMsg, text: `🤖 Launching subagent: **${title}**` });
              }
              console.log(`[${channelId}] Tracking child session ${e.properties.sessionID}`);
            }
          } else if (e.type === "session.status" && e.properties.sessionID !== sessionID && state.childSessionIDs!.has(e.properties.sessionID)) {
            // Notify when a subagent finishes its work
            const status = (e.properties as { status: { type: string } }).status;
            if (status.type === "idle" && baseMsg !== undefined) {
              await stream.send({ ...baseMsg, text: `✅ **Subagent finished**` });
            }
          }

          // Helper to check if an event belongs to this channel's session tree
          const isOwnEvent = (sid: string | undefined) =>
            sid === sessionID || (sid !== undefined && state.childSessionIDs!.has(sid));

          // Handle session errors (forward to user)
          if (e.type === "session.error" && isOwnEvent(e.properties.sessionID)) {
            const errObj = e.properties.error;
            let errMsg = "unknown error";
            if (errObj && "data" in errObj && (errObj as { data: { message?: string } }).data?.message) {
              errMsg = (errObj as { data: { message?: string } }).data.message!;
            }
            if (baseMsg !== undefined) {
              await stream.send({ ...baseMsg, text: `Error: ${errMsg}` });
            }
            state.activeMsg = undefined;
            console.error(`[${channelId}] Session error: ${errMsg}`);
          } else if (e.type === "permission.asked" && isOwnEvent(e.properties.sessionID)) {
            // Handle permission requests (ask user to approve/deny tool execution)
            await this.handlePermission(channelId, client!, stream, state, e.properties);
          } else if (e.type === "question.asked" && isOwnEvent(e.properties.sessionID)) {
            // Handle questions (ask user to choose from options)
            await this.handleQuestion(channelId, client!, stream, state, e.properties);
          } else if (e.type === "message.updated" && isOwnEvent(e.properties.sessionID)) {
            // Track full message metadata for role detection
            messages.set(e.properties.info.id, e.properties.info);
          } else if (e.type === "message.part.updated" && isOwnEvent(e.properties.part.sessionID)) {
            // Stream assistant message parts back to the channel
            const part = e.properties.part;
            const text = partToText(part);
            const role = messages.get(e.properties.part.messageID)?.role;
            // Only forward assistant messages (not user messages echoing back)
            if (role === "assistant" && text !== undefined && text.length > 0 && baseMsg !== undefined) {
              await stream.send({ ...baseMsg, text });
            }
            // Clear cached message once we've processed parts from it
            if (text !== undefined && text.length > 0) {
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

  /**
   * Handle a permission request from opencode (e.g., tool approval).
   * Presents the permission question to the user and waits for a response.
   */
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
    if (choice === undefined) {
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

  /** Map a user's text reply to a permission choice. */
  private mapReplyToChoice(reply: string): "once" | "always" | "reject" | undefined {
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
        return undefined;
    }
  }

  /**
   * Handle a question event from opencode (e.g., asking the user to choose
   * between multiple options). Presents each question and waits for a response.
   */
  private async handleQuestion(
    channelId: string,
    client: OpencodeClient,
    stream: StreamHandler,
    state: ChannelState,
    request: QuestionRequest,
  ): Promise<void> {
    const baseMsg = this.createBaseMsg(state);
    if (!baseMsg) return;

    // Process each question in the request sequentially
    let answers = [];
    for (const question of request.questions) {
      let questionText =
        `❓ **${question.header}**\n\n${question.question}\n\n`;
      const labels = [];
      for (const option of question.options) {
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

  /** Stop all opencode sessions and kill all server processes. */
  async stop(): Promise<void> {
    for (const [channelId, state] of this.channelStates) {
      console.log(`[${channelId}] Stopping session ${state.sessionID}`);
      state.activeMsg = undefined;
      if (state.client !== undefined) {
        await state.client!.global.dispose();
        state.abortController!.abort();
        state.server!.close();
      }
    }
  }
}

/**
 * Convert an opencode message part to a human-readable text representation.
 * Returns undefined for parts that shouldn't be displayed (e.g., pending/running tools).
 */
function partToText(part: Part): string | undefined {
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
    default: return undefined;
  }
}

/**
 * Format a tool execution part for display.
 * Pending and running tools return undefined (not yet ready to display).
 * Completed tools show the tool name, title, input, and output.
 * Errored tools show the error message.
 */
function formatToolPart(p: ToolPart): string | undefined {
  switch (p.state.status) {
    case "pending": return undefined;
    case "running": return undefined;
    case "completed": {
      const out = p.state.output;
      // Special formatting for todowrite tool: show a checklist instead of raw YAML
      if (p.tool === "todowrite") {
        const formatted = formatTodoWrite(p.state.title, out);
        if (formatted !== undefined) {
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
