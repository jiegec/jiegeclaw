/**
 * Core interfaces for the channel messaging system.
 * All messaging channels (Feishu, WeCom, Weixin) implement the Channel interface,
 * and messages flow through InboundMessage / OutboundMessage.
 */

/** A message received from a user via a messaging channel. */
export interface InboundMessage {
  /** Unique message identifier from the channel platform. */
  id: string;
  /** Sender identifier (user ID or chat ID, depending on the channel). */
  from: string;
  /** The text content of the message. */
  text: string;
  /**
   * Platform-specific token used for replying in-thread or as a direct reply.
   * For example, Feishu uses the message_id to reply to a specific message.
   */
  contextToken?: any;
}

/** A message to be sent back to a user via a messaging channel. */
export interface OutboundMessage {
  /** Target identifier (user ID or chat ID) to send the message to. */
  to: string;
  /** The text content of the message (may contain markdown). */
  text: string;
  /**
   * If set, the channel will reply to this specific message instead of
   * sending a new standalone message.
   */
  contextToken?: any;
}

/**
 * Interface that all messaging channels must implement.
 * Each channel connects to a different platform (Feishu, WeCom, Weixin)
 * and provides a unified way to send/receive messages.
 */
export interface Channel {
  /** Unique channel identifier, typically derived from the platform config. */
  readonly id: string;

  /**
   * Interactive setup flow for first-time configuration.
   * Prompts the user for required credentials and saves them to config.
   */
  onboard(): Promise<void>;

  /**
   * Start listening for incoming messages.
   * Calls the `onMessage` callback for each incoming message.
   * This should block until the channel is stopped.
   */
  listen(onMessage: (msg: InboundMessage) => void): Promise<void>;

  /** Send a message to a user on this channel. */
  send(msg: OutboundMessage): Promise<void>;

  /** Stop listening and clean up resources. */
  stop(): void;
}
