/**
 * Logging configuration using Pino.
 *
 * Features:
 * - Pretty print to console for development
 * - File logging with rotation for production
 * - Structured JSON logs
 * - Multiple log levels (trace, debug, info, warn, error, fatal)
 */

import pino from "pino";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import os from "node:os";

const LOG_DIR = join(os.homedir(), ".jiegeclaw", "logs");

// Ensure log directory exists
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch (err) {
  console.error("Failed to create log directory:", err);
}

// Create file transport for rotation
const fileTransport = pino.transport({
  targets: [
    // Console output with pretty printing
    {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:STANDARD",
        ignore: "pid,hostname",
        messageFormat: "{msg}",
      },
      level: process.env.LOG_LEVEL || "info",
    },
    // File output with rotation
    {
      target: "pino-roll",
      options: {
        file: join(LOG_DIR, "app"),
        extension: ".log",
        frequency: "daily",
        maxSize: "100m",
        maxFiles: 7, // Keep 7 days of logs
        mkdir: true,
        sync: false, // Async logging for better performance
      },
      level: "debug",
    },
  ],
});

// Create the main logger
export const logger = pino(
  {
    level: process.env.LOG_LEVEL || "info",
    base: {
      pid: process.pid,
      hostname: os.hostname(),
    },
    // Redact sensitive fields
    redact: {
      paths: ["*.secret", "*.token", "*.password", "appSecret", "secret"],
      remove: true,
    },
  },
  fileTransport
);


export default logger;
