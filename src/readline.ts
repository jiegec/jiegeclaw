import * as readline from "node:readline";

/** Create a readline interface that reads from stdin and writes to stderr. */
export function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stderr });
}

/**
 * Prompt the user with a question and return the trimmed answer.
 * Wraps the callback-based rl.question in a Promise.
 */
export function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}
