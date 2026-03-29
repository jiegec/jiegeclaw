/**
 * Permission and question handlers for opencode sessions.
 *
 * Handles user interactions for permission requests and multi-choice questions.
 */

import type { OpencodeClient, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";
import type { ChannelState, StreamHandler } from "./types.js";
import { createBaseMsg } from "./utils.js";
import logger from "../utils/logger.js";

/**
 * Handle a permission request from opencode (e.g., tool approval).
 * Presents the permission question to the user and waits for a response.
 */
export async function handlePermission(
  channelId: string,
  client: OpencodeClient,
  stream: StreamHandler,
  state: ChannelState,
  permission: PermissionRequest,
): Promise<void> {
  const baseMsg = createBaseMsg(state);
  if (!baseMsg) return;

  const questionText =
    `❓ ${permission.permission}\n\n` +
    `1. **Allow once**\n2. **Always allow**\n3. **Reject**\n\n` +
    `Reply with number or label:`;

  const reply = await stream.waitForReply(
    { ...baseMsg, text: questionText },
    ["once", "always", "reject", "1", "2", "3", "allow once", "always allow", "reject"],
  );

  const choice = mapReplyToChoice(reply);
  if (choice === undefined) {
    logger.warn(`[${channelId}] Unrecognized permission reply: "${reply}"`);
    return;
  }

  try {
    logger.info(`[${channelId}] Permission reply: ${choice} (request ${permission.id})`);
    await client.permission.reply({
      requestID: permission.id,
      reply: choice,
    });
  } catch (err) {
    logger.error(`Failed to respond to permission ${permission.id}: ${(err as Error).message}`);
  }
}

/** Map a user's text reply to a permission choice. */
function mapReplyToChoice(reply: string): "once" | "always" | "reject" | undefined {
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
export async function handleQuestion(
  channelId: string,
  client: OpencodeClient,
  stream: StreamHandler,
  state: ChannelState,
  request: QuestionRequest,
): Promise<void> {
  const baseMsg = createBaseMsg(state);
  if (!baseMsg) return;

  // Process each question in the request sequentially
  const answers = [];
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
    logger.info(`[${channelId}] Question answered: "${answer}"`);
    answers.push([answer]);
  }

  try {
    await client.question.reply({
      requestID: request.id,
      answers: answers,
    });
  } catch (err) {
    logger.error(`Failed to reply to question ${request.id}: ${(err as Error).message}`);
  }
}
