/**
 * Shared utilities for opencode handler modules.
 */

import type { ChannelState } from "./types.js";
import type { OutboundMessage } from "../types.js";

/**
 * Build an outbound message template from the currently active inbound message.
 * Returns undefined if there's no active message (e.g., between requests).
 */
export function createBaseMsg(state: ChannelState): OutboundMessage | undefined {
  if (!state.activeMsg) return undefined;
  return { to: state.activeMsg.from, text: "", contextToken: state.activeMsg.contextToken };
}
