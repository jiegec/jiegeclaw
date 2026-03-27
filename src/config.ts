import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, stringify } from "yaml";
import { FeishuChannelConfig } from "./channels/feishu-types.js";
import { WeixinChannelConfig } from "./channels/weixin-types.js";

const CONFIG_DIR = path.join(os.homedir(), ".jiegeclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");


export type ChannelConfig = FeishuChannelConfig | WeixinChannelConfig | { type: string;[key: string]: unknown };

export interface OpenCodeConfig {
  baseUrl?: string;
  directory?: string;
}

export interface AppConfig {
  channels: ChannelConfig[];
  opencode?: OpenCodeConfig;
}

function defaultConfig(): AppConfig {
  return { channels: [] };
}

export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const cfg = parse(raw) as AppConfig;
    if (!Array.isArray(cfg.channels)) return defaultConfig();
    return cfg;
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, stringify(config), "utf-8");
}
