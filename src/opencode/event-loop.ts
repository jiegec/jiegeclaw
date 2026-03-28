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

import type { Event, Message } from "@opencode-ai/sdk/v2";
import type { ChannelState, StreamHandler } from "./types.js";
import { partToText } from "./formatting.js";
import { handlePermission, handleQuestion } from "./handlers.js";
import { createBaseMsg } from "./utils.js";

/**
 * Main event loop for a channel's opencode session.
 */
export async function runEventLoop(
  channelId: string,
  state: ChannelState,
): Promise<void> {
  console.log(`[${channelId}] Event loop started`);
  if (!state) {
    console.log(`[${channelId}] Event loop exiting: no state`);
    return;
  }

  const { client, sessionID, abortController, stream } = state;
  // Track full messages to determine the role (user vs assistant) of parts
  const messages: Map<string, Message> = new Map();

  while (!abortController!.signal.aborted) {
    try {
      const result = await client!.event.subscribe();
      console.log(`[${channelId}] Event stream connected`);

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
          await handlePermission(channelId, client!, stream, state, e.properties);
        } else if (e.type === "question.asked" && isOwnEvent(e.properties.sessionID)) {
          // Handle questions (ask user to choose from options)
          await handleQuestion(channelId, client!, stream, state, e.properties);
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
