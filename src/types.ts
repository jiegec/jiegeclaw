export interface InboundMessage {
  id: string;
  from: string;
  text: string;
  contextToken?: string;
}

export interface OutboundMessage {
  to: string;
  text: string;
  contextToken?: string;
}

export interface Channel {
  readonly id: string;

  onboard(): Promise<void>;

  listen(onMessage: (msg: InboundMessage) => void): Promise<void>;

  send(msg: OutboundMessage): Promise<void>;

  stop(): void;
}
