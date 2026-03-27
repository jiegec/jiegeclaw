import { loadConfig, saveConfig } from "./config.js";
import type { ChannelConfig } from "./config.js";
import { WeixinChannel } from "./channels/weixin.js";
import type { WeixinChannelConfig } from "./channels/weixin-types.js";
import { FeishuChannel } from "./channels/feishu.js";
import type { FeishuChannelConfig } from "./channels/feishu-types.js";
import { WecomChannel } from "./channels/wecom.js";
import type { WecomChannelConfig } from "./channels/wecom-types.js";
import { OpencodeHandler } from "./opencode.js";
import { Server } from "./server.js";
import type { Channel } from "./types.js";
import { stringify } from "yaml";

function createChannel(
  cfg: ChannelConfig,
  index: number,
  onConfigUpdate: (index: number, update: Record<string, unknown>) => void,
): Channel {
  switch (cfg.type) {
    case "weixin":
      return new WeixinChannel(cfg as WeixinChannelConfig, index, onConfigUpdate as never);
    case "feishu":
      return new FeishuChannel(cfg as FeishuChannelConfig, index, onConfigUpdate as never);
    case "wecom":
      return new WecomChannel(cfg as WecomChannelConfig, index, onConfigUpdate as never);
    default:
      throw new Error(`Unknown channel type: ${cfg.type}`);
  }
}

function makeConfigUpdater(config: ChannelConfig[]): (index: number, update: Record<string, unknown>) => void {
  return (index, update) => {
    config[index] = { ...config[index], ...update };
    const appConfig = loadConfig();
    appConfig.channels = config;
    saveConfig(appConfig);
  };
}

const command = process.argv[2] ?? "start";

async function main(): Promise<void> {
  switch (command) {
    case "start":
      await startServer();
      break;
    case "setup":
      await setupChannels();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: jiegeclaw [start|setup]");
      process.exit(1);
  }
}

async function startServer(): Promise<void> {
  const config = loadConfig();

  if (!config.channels.length) {
    console.error("No channels configured. Run `jiegeclaw setup` first.");
    process.exit(1);
  }

  const updater = makeConfigUpdater(config.channels as ChannelConfig[]);

  const opencode = new OpencodeHandler(
    config.opencode?.baseUrl ?? "http://127.0.0.1:4096",
  );

  const server = new Server(opencode);

  for (let i = 0; i < config.channels.length; i++) {
    const channel = createChannel(config.channels[i], i, updater);
    server.addChannel(channel);
  }

  console.log(`Starting jiegeclaw with ${config.channels.length} channel(s)...`);

  const cleanup = () => {
    console.log("\nShutting down...");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  await server.start();
}

async function setupChannels(): Promise<void> {
  const config = loadConfig();
  const action = process.argv[3];
  const type = process.argv[4];

  if (action === "add" && type) {
    const base: ChannelConfig = { type };
    const tempConfig = [...config.channels, base];
    const updater = makeConfigUpdater(tempConfig as ChannelConfig[]);
    const index = tempConfig.length - 1;
    const channel = createChannel(base, index, updater);

    try {
      await channel.onboard();
    } catch (err) {
      console.error(`Failed to setup ${type}: ${(err as Error).message}`);
      process.exit(1);
    }

    // Save config
    const appConfig = loadConfig();
    appConfig.channels = tempConfig;
    saveConfig(appConfig);
    return;
  }

  if (!action) {
    if (!config.channels.length) {
      console.log("No channels configured. Add one with:");
      console.log("  jiegeclaw setup add <type>");
      return;
    }
    console.log("Configured channels:");
    console.log(stringify(config.channels));
    return;
  }

  console.error(`Usage: jiegeclaw setup [add <type>]`);
  process.exit(1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
