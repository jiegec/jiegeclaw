/**
 * Prompt error formatting utilities.
 */

import type {
  ProviderAuthError,
  UnknownError,
  MessageOutputLengthError,
  MessageAbortedError,
  StructuredOutputError,
  ContextOverflowError,
  ApiError,
} from "@opencode-ai/sdk/v2";

export type PromptError =
  | ProviderAuthError
  | UnknownError
  | MessageOutputLengthError
  | MessageAbortedError
  | StructuredOutputError
  | ContextOverflowError
  | ApiError;

export function formatPromptError(error: PromptError): string {
  switch (error.name) {
    case "ProviderAuthError":
      return `Provider auth error (${error.data.providerID}): ${error.data.message}`;
    case "UnknownError":
      return `Unknown error: ${error.data.message}`;
    case "MessageOutputLengthError":
      return `Message output length error: ${JSON.stringify(error.data)}`;
    case "MessageAbortedError":
      return `Message aborted: ${error.data.message}`;
    case "StructuredOutputError":
      return `Structured output error (retries: ${error.data.retries}): ${error.data.message}`;
    case "ContextOverflowError":
      return `Context overflow: ${error.data.message}`;
    case "APIError": {
      const { statusCode, message, isRetryable } = error.data;
      return `API error${statusCode !== undefined ? ` (${statusCode})` : ""}: ${message}${isRetryable ? " (retryable)" : ""}`;
    }
  }
}
