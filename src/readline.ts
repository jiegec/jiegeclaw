import * as readline from "node:readline";

export function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stderr });
}

export function question(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}
