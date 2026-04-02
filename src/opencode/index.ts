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

import { spawn } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { FilePartInput, OpencodeClient, TextPartInput } from "@opencode-ai/sdk/v2";
import type { InboundMessage } from "../types.js";
import {
  loadSessions,
  getLastDir,
  getLastFrom,
  getSessionIdForDir,
  updateChannelSession,
} from "../config.js";
import type { StreamHandler, ServerProcess, ChannelState } from "./types.js";
import { runEventLoop } from "./event-loop.js";
import logger from "../utils/logger.js";
import { stringify } from "yaml";

export type { StreamHandler } from "./types.js";

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
    logger.info(`[${channelId}] Created new session ${sessionID}`);
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

    logger.info(`[${channelId}] Reset to new session ${newSessionID}`);

    // Launch a new event loop for the new session
    runEventLoop(channelId, state);

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
        text: `Session restored in \`${state.directory}\` (${state.sessionID?.slice(0, 8)}): ${state.sessionTitle}`,
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
      logger.info(`[${channelId}] Tearing down old server in ${existing.directory}`);
      existing.abortController?.abort();
      existing.activeMsg = undefined;
      existing.server.close();
    }

    // Check if we have a saved session for this directory
    const sessions = loadSessions();
    const savedSessionID = getSessionIdForDir(channelId, directory, sessions);

    // Spawn a new opencode server on a unique port
    const port = this.portCounter++;
    logger.info(`[${channelId}] Spawning opencode serve on port ${port}...`);
    const server = await this.spawnServer(directory, port);
    logger.info(`[${channelId}] Server started at ${server.url} (PID: ${server.proc.pid})`);
    const client = createOpencodeClient({ baseUrl: server.url });

    // Try to reuse the saved session, or create a new one
    let sessionID: string;
    let sessionTitle: string | undefined;
    if (savedSessionID !== undefined) {
      try {
        const session = await client.session.get({ sessionID: savedSessionID });
        sessionID = savedSessionID;
        sessionTitle = session.data?.title;
        logger.info(`[${channelId}] Reusing session ${sessionID} for ${directory}: ${sessionTitle}`);
      } catch {
        logger.info(`[${channelId}] Saved session ${savedSessionID} not found, creating new one`);
        sessionID = await this.createSession(channelId, client);
      }
    } else {
      sessionID = await this.createSession(channelId, client);
    }

    // Persist the session mapping
    updateChannelSession(channelId, directory, sessionID);

    const state: ChannelState = {
      stream,
      directory,
      server,
      client,
      sessionID,
      sessionTitle,
      activeMsg: undefined,
      childSessionIDs: new Set(),
      abortController: new AbortController(),
    };
    this.channelStates.set(channelId, state);

    logger.info(`[${channelId}] Session ${sessionID} in ${directory}`);
    runEventLoop(channelId, state);
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

    // Build parts array with text and optional image attachments
    const parts: Array<TextPartInput | FilePartInput> = [];

    // Add text part if non-empty
    if (msg.text.length > 0) {
      parts.push({ type: "text", text: msg.text });
    }

    // Add image attachments as file parts with data URLs
    if (msg.images && msg.images.length > 0) {
      for (const image of msg.images) {
        parts.push({
          type: "file",
          mime: image.mimeType,
          filename: image.filename,
          url: image.dataUrl,
        });
      }
    }

    // Ensure at least one part exists
    if (parts.length === 0) {
      return;
    }

    try {
      await state.client!.session.promptAsync({
        sessionID: state.sessionID!,
        parts,
        variant: "max"
      });
    } catch (err) {
      logger.warn(`[${channelId}] Failed to prompt: ${err}`);
    }
  }

  /**
   * Abort the current running generation in the opencode session.
   * This will stop any ongoing LLM generation or tool execution.
   * Returns true if abort was successful, false if there was no active session.
   */
  async abort(channelId: string): Promise<boolean> {
    const state = this.channelStates.get(channelId);
    if (!state || !state.client || !state.sessionID) {
      return false;
    }

    try {
      await state.client.session.abort({
        sessionID: state.sessionID,
      });
      logger.info(`[${channelId}] Aborted session ${state.sessionID}`);
      return true;
    } catch (err) {
      logger.error(`[${channelId}] Failed to abort: ${err}`);
      return false;
    }
  }

  /**
   * Spawn an opencode server child process in the given directory.
   * Waits up to 15 seconds for the server to start and output its listening URL.
   * Rejects if the server exits or times out.
   */
  private spawnServer(directory: string, port: number): Promise<ServerProcess> {
    return new Promise((resolve, reject) => {
      const proc = spawn("opencode", [`serve`, `--hostname=127.0.0.1`, `--port=${port}`], {
        // Create in a separate process group
        detached: true,
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
          resolve({
            proc, url: match[1], close() {
              // Kill the whole process group
              process.kill(-proc.pid!, "SIGINT");
            }
          });
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

  /** Compact the session context by generating an AI summary, then return the summary text. */
  async compact(channelId: string): Promise<string | null> {
    const state = this.channelStates.get(channelId);
    if (!state || !state.client || !state.sessionID) return null;

    // Find providerID/modelID from the most recent assistant message,
    // as session.summarize() requires both.
    const result = await state.client.session.messages({ sessionID: state.sessionID });
    const msgs = result.data ?? [];
    let lastProviderID: string | undefined;
    let lastModelID: string | undefined;
    for (const { info } of msgs) {
      if (info.role === "assistant") {
        lastProviderID = info.providerID;
        lastModelID = info.modelID;
      }
    }
    if (!lastProviderID || !lastModelID) throw new Error("No model/provider found in session history");

    // Trigger compaction via summarize(). Returns error if it fails.
    const cmdResult = await state.client.session.summarize({
      sessionID: state.sessionID,
      providerID: lastProviderID,
      modelID: lastModelID,
    });
    if (cmdResult.error !== undefined) {
      throw new Error(`Compaction failed:\n${stringify(cmdResult.error)}`);
    }

    // After summarizing, the newest assistant message with summary=true
    // contains the compaction result. Fetch it and extract its text parts.
    const msgsAfter = await state.client.session.messages({ sessionID: state.sessionID });
    const summaryMsg = [...(msgsAfter.data ?? [])].reverse().find(
      (m) => m.info.role === "assistant" && m.info.summary === true,
    );
    if (!summaryMsg) return null;

    const detail = await state.client.session.message({
      sessionID: state.sessionID,
      messageID: summaryMsg.info.id,
    });
    if (detail.error !== undefined) return null;

    const texts = detail.data.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text);
    return texts.join("\n") || null;
  }

  /** Stop all opencode sessions and kill all server processes. */
  async stop(): Promise<void> {
    const stopPromises: Promise<void>[] = [];
    for (const [channelId, state] of this.channelStates) {
      logger.info(`[${channelId}] Stopping session ${state.sessionID}`);
      state.activeMsg = undefined;
      if (state.client !== undefined) {
        await state.client!.global.dispose();
        state.abortController!.abort();

        const server = state.server!;
        logger.info(`[${channelId}] Killing opencode server process (PID: ${server.proc.pid})`);
        server.close();
        // Wait for the process to actually exit
        const waitPromise = new Promise<void>((resolve) => {
          server.proc.on("exit", () => {
            logger.info(`[${channelId}] Opencode server process exited`);
            resolve();
          });
          // Also resolve if process already exited
          if (server.proc.exitCode !== null) {
            logger.info(`[${channelId}] Opencode server process already exited (code: ${server.proc.exitCode})`);
            resolve();
          }
        });
        stopPromises.push(waitPromise);
      }
    }

    await Promise.all(stopPromises);
    logger.info("All opencode server processes stopped");
  }
}
