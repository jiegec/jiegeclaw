/**
 * Event loop for opencode sessions.
 *
 * Subscribes to the opencode event stream and dispatches events:
 * - Streams assistant message parts back to the channel
 * - Handles permission requests and questions by prompting the user
 * - Tracks subagent (child) sessions and notifies the channel of their status
 *
 * Automatically reconnects on errors with a 1-second delay.
 */

import type { Event, Message, TextPart, ToolPart } from "@opencode-ai/sdk/v2";
import type { ChannelState, StreamHandler } from "./types.js";
import { partToText, formatStreamingContent, formatToolPart } from "./formatting.js";
import { handlePermission, handleQuestion } from "./handlers.js";
import { createBaseMsg } from "./utils.js";
import logger from "../utils/logger.js";

interface StreamingPart {
  streamId: string;
  content: string;
  messageId: string;
  partId: string;
  partType: string;
  // For tool parts, track the current state status
  toolState?: string;
}

/**
 * Main event loop for a channel's opencode session.
 */
export async function runEventLoop(
  channelId: string,
  state: ChannelState,
): Promise<void> {
  logger.info(`[${channelId}] Event loop started`);
  if (!state) {
    logger.info(`[${channelId}] Event loop exiting: no state`);
    return;
  }

  const { client, sessionID, abortController, stream } = state;
  // Track full messages to determine the role (user vs assistant) of parts
  const messages: Map<string, Message> = new Map();
  // Track streaming parts by part ID (each part has its own streaming)
  const streamingParts: Map<string, StreamingPart> = new Map();

  while (!abortController!.signal.aborted) {
    try {
      const result = await client!.event.subscribe();
      logger.info(`[${channelId}] Event stream connected`);

      for await (const event of result.stream) {
        if (abortController!.signal.aborted) break;
        const baseMsg = createBaseMsg(state);
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
            logger.info(`[${channelId}] Tracking child session ${e.properties.sessionID}`);
          }
        } else if (e.type === "session.status" && e.properties.sessionID !== sessionID && state.childSessionIDs!.has(e.properties.sessionID)) {
          // Notify when a subagent finishes its work
          const status = e.properties.status;
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
          logger.error(`[${channelId}] Session error: ${errMsg}`);
        } else if (e.type === "permission.asked" && isOwnEvent(e.properties.sessionID)) {
          // Handle permission requests (ask user to approve/deny tool execution)
          await handlePermission(channelId, client!, stream, state, e.properties);
        } else if (e.type === "question.asked" && isOwnEvent(e.properties.sessionID)) {
          // Handle questions (ask user to choose from options)
          await handleQuestion(channelId, client!, stream, state, e.properties);
        } else if (e.type === "message.updated" && isOwnEvent(e.properties.sessionID)) {
          // Track full message metadata for role detection
          messages.set(e.properties.info.id, e.properties.info);
        } else if (e.type === "message.part.delta" && isOwnEvent(e.properties.sessionID)) {
          // Handle streaming delta updates for each part
          const props = e.properties;
          const role = messages.get(props.messageID)?.role;
          if (role !== "assistant") continue;

          // Get the streaming part - it should have been created by the first message.part.updated
          const streamingPart = streamingParts.get(props.partID);
          if (!streamingPart) {
            logger.warn(`[${channelId}] message.part.delta received for part ${props.partID} but no streamingPart found`);
            continue;
          }

          // Append delta content (delta contains the text diff)
          if (props.field === "text") {
            streamingPart.content += props.delta;
          }

          // Send streaming update (finish=false) with proper formatting
          if (baseMsg !== undefined) {
            const displayContent = formatStreamingContent(streamingPart.content, streamingPart.partType);
            await stream.streamSend(streamingPart.streamId, { ...baseMsg, text: displayContent }, false);
          }
        } else if (e.type === "message.part.updated" && isOwnEvent(e.properties.part.sessionID)) {
          // Stream assistant message parts back to the channel
          const part = e.properties.part;
          const role = messages.get(part.messageID)?.role;
          if (role !== "assistant") continue;

          // Process text and reasoning parts for streaming display
          if (part.type === "text" || part.type === "reasoning") {
            // Check if we have a streaming part for this (tracked by partID)
            const streamingPart = streamingParts.get(part.id);

            if (!streamingPart) {
              // First message.part.updated - create the streamingPart (part is created)
              const newStreamingPart = {
                streamId: crypto.randomUUID(),
                content: part.text,
                messageId: part.messageID,
                partId: part.id,
                partType: part.type,
              };
              streamingParts.set(part.id, newStreamingPart);

              // Send initial update (finish=false)
              if (baseMsg !== undefined) {
                const displayContent = formatStreamingContent(newStreamingPart.content, newStreamingPart.partType);
                await stream.streamSend(newStreamingPart.streamId, { ...baseMsg, text: displayContent }, false);
              }
            } else if (part.time?.end) {
              // Part is complete (has end time) - send final update with finish=true
              if (part.text) {
                streamingPart.content = part.text;
              }

              if (baseMsg !== undefined) {
                const displayContent = formatStreamingContent(streamingPart.content, streamingPart.partType);
                await stream.streamSend(streamingPart.streamId, { ...baseMsg, text: displayContent }, true);
              }
              streamingParts.delete(part.id);
            }
          } else if (part.type === "tool") {
            // Tool parts also support streaming (pending -> running -> completed/error)
            const toolPart = part as ToolPart;
            const currentState = toolPart.state.status;
            const isComplete = currentState === "completed" || currentState === "error";

            let streamingPart = streamingParts.get(part.id);

            if (!streamingPart) {
              // First time seeing this tool - create streamingPart
              streamingPart = {
                streamId: crypto.randomUUID(),
                content: formatToolPart(toolPart),
                messageId: part.messageID,
                partId: part.id,
                partType: part.type,
                toolState: currentState,
              };
              streamingParts.set(part.id, streamingPart);
            } else {
              // Tool state changed - update content and send update
              streamingPart.content = formatToolPart(toolPart);
              streamingPart.toolState = currentState;

            }

            // Send update
            if (baseMsg !== undefined) {
              await stream.streamSend(streamingPart.streamId, { ...baseMsg, text: streamingPart.content }, isComplete);
            }

            // If complete, clean up
            if (isComplete) {
              streamingParts.delete(part.id);
            }
          } else {
            // Other parts (agents, subtasks, etc.) - send directly
            const text = partToText(part);
            if (text !== undefined && text.length > 0 && baseMsg !== undefined) {
              await stream.send({ ...baseMsg, text });
            }
          }
        }
      }
    } catch (err) {
      logger.error(`[${channelId}] Event loop error, reconnecting: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  logger.info(`[${channelId}] Event loop exited`);
}
