/**
 * Shared types for opencode handler modules.
 */

import type { ChildProcess } from "node:child_process";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import type { InboundMessage, OutboundMessage } from "../types.js";

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
export interface ServerProcess {
  proc: ChildProcess;
  /** The HTTP URL the server is listening on. */
  url: string;
  /** Kill the server process. */
  close(): void;
}

/** Per-channel state tracking the active session and server process. */
export interface ChannelState {
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
  /** The active opencode session title. */
  sessionTitle?: string;
  /** The inbound message currently being processed (used for reply addressing). */
  activeMsg?: InboundMessage;
  /** Set of subagent (child) session IDs spawned by the main session. */
  childSessionIDs?: Set<string>;
  /** Controller to abort the event loop when switching directories or stopping. */
  abortController?: AbortController;
}
