import { createOpencodeClient } from "@opencode-ai/sdk";
import type { OpencodeClient } from "@opencode-ai/sdk";
import type { InboundMessage } from "./types.js";

export class OpencodeHandler {
  private client: OpencodeClient;
  private sessionId: string | null = null;
  private directory: string;

  constructor(opencodeBaseUrl: string | undefined, directory: string) {
    this.client = createOpencodeClient(
      opencodeBaseUrl ? { baseUrl: opencodeBaseUrl } : undefined,
    );
    this.directory = directory;
  }

  async initialize(): Promise<void> {
    const session = await this.client.session.create();
    this.sessionId = session.data?.id ?? null;
    console.log(`Created OpenCode session ${this.sessionId}`);
  }

  async handle(msg: InboundMessage): Promise<string> {
    if (!this.sessionId) {
      await this.initialize();
    }
    if (!this.sessionId) {
      throw new Error("Failed to get or create session");
    }

    const result = await this.client.session.prompt({
      path: { id: this.sessionId },
      body: {
        parts: [{ type: "text" as const, text: msg.text }],
      },
    });

    const textParts = result.data?.parts?.filter(
      (p) => p.type === "text",
    );
    return textParts?.map((p) => p.text).join("\n") ?? "(no response)";
  }
}
