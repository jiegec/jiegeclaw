import * as readline from "node:readline/promises";

/** Create a readline interface that reads from stdin and writes to stderr. */
export function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stderr });
}

/**
 * Prompt the user with a question and return the trimmed answer.
 * Uses the Promise-based readline/promises API.
 */
export async function question(rl: readline.Interface, prompt: string): Promise<string> {
  const answer = await rl.question(prompt);
  return answer.trim();
}
