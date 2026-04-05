/**
 * CLI entry point for jiegeclaw.
 *
 * Supports two commands:
 * - `start`: Launch the server as a managed child process, auto-restarting on crashes
 *   and restart signals (/restart). The parent process supervises the child.
 * - `setup`: Interactive configuration for adding new channels.
 *
 * Sensitive fields (tokens, secrets) are masked when displaying config.
 */

import { spawn } from "node:child_process";
import { loadConfig, saveConfig, createChannel } from "./config.js";
import { registry } from "./channels/registry.js";
import type { ChannelConfig } from "./config.js";
import { stringify } from "yaml";
import logger from "./utils/logger.js";
import { install } from "./install.js";

/** Config field names that contain secrets and should be masked in output. */
const SECRET_KEYS = ["token", "userId", "appSecret", "secret"];

/**
 * Mask sensitive fields in channel configs for safe display.
 * Replaces all but the first 2 and last 2 characters with asterisks.
 */
function maskSecrets(config: ChannelConfig[]): ChannelConfig[] {
  return config.map((ch) => {
    const masked = { ...ch };
    for (const key of SECRET_KEYS) {
      if (key in masked && typeof (masked as Record<string, unknown>)[key] === "string") {
        const val = (masked as Record<string, unknown>)[key] as string;
        (masked as Record<string, unknown>)[key] = val.length > 4
          ? val.slice(0, 2) + "*".repeat(val.length - 4) + val.slice(-2)
          : "****";
      }
    }
    return masked;
  });
}

const command = process.argv[2] ?? "start";

async function main(): Promise<void> {
  switch (command) {
    case "start":
      await supervise();
      break;
    case "setup":
      await setupChannels();
      break;
    case "install":
      await install();
      break;
    default:
      logger.error(`Unknown command: ${command}`);
      logger.error("Usage: jiegeclaw [start|setup|install]");
      process.exit(1);
  }
}

/** Exit code used by the child to signal a restart. */
const RESTART_EXIT_CODE = 42;

/**
 * Parent process: spawn and supervise the server child process.
 * Relaunches the child on restart signals (exit code 42) and crashes.
 */
function supervise(): Promise<void> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;

    function launch() {
      child = spawn("tsx", ["src/server/index.ts"], {
        stdio: "inherit",
        env: process.env,
      });

      child.on("exit", (code) => {
        if (code === RESTART_EXIT_CODE) {
          logger.info("[supervisor] Child requested restart, relaunching...");
          launch();
        } else if (code === 0) {
          logger.info("[supervisor] Child exited cleanly.");
          resolve();
        } else {
          logger.error(`[supervisor] Child crashed with code ${code}, relaunching in 3s...`);
          setTimeout(launch, 3000);
        }
      });

      child.on("error", (err) => {
        logger.error(`[supervisor] Failed to spawn child: ${err.message}`);
        setTimeout(launch, 3000);
      });
    }

    launch();
  });
}

/**
 * Interactive channel setup.
 * - `jiegeclaw setup`: List all configured channels (with masked secrets).
 * - `jiegeclaw setup add <type>`: Add a new channel by running its onboard flow.
 */
async function setupChannels(): Promise<void> {
  const config = loadConfig();
  const action = process.argv[3];
  const type = process.argv[4];

  if (action === "add" && type) {
    const onboard = registry.getOnboard(type);
    if (!onboard) {
      logger.error(`Unknown channel type: ${type}`);
      logger.error(`Supported types: ${registry.getTypes().join(", ")}`);
      process.exit(1);
    }

    try {
      const newConfig = await onboard();
      config.channels.push(newConfig);
      saveConfig(config);
      logger.info(`${type} channel added successfully!`);
    } catch (err) {
      logger.error(`Failed to setup ${type}: ${(err as Error).message}`);
      process.exit(1);
    }
    return;
  }

  if (!action) {
    // List configured channels
    if (!config.channels.length) {
      logger.info("No channels configured. Add one with:");
      logger.info("  jiegeclaw setup add <type>");
      return;
    }
    logger.info("Configured channels:");
    logger.info(stringify(maskSecrets(config.channels)));
    return;
  }

  logger.error(`Usage: jiegeclaw setup [add <type>]`);
  process.exit(1);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
