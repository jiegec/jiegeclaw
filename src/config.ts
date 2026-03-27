import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, stringify } from "yaml";
import { FeishuChannelConfig } from "./channels/feishu-types.js";
import { WeixinChannelConfig } from "./channels/weixin-types.js";
import { WecomChannelConfig } from "./channels/wecom-types.js";

const CONFIG_DIR = path.join(os.homedir(), ".jiegeclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");
const SESSIONS_PATH = path.join(CONFIG_DIR, "sessions.yaml");


export type ChannelConfig = FeishuChannelConfig | WeixinChannelConfig | WecomChannelConfig | { type: string;[key: string]: unknown };

export interface OpenCodeConfig {
  baseUrl?: string;
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

type Sessions = Record<string, string>;

export function loadSessions(): Sessions {
  try {
    const raw = fs.readFileSync(SESSIONS_PATH, "utf-8");
    const sessions = parse(raw) as Sessions;
    if (typeof sessions !== "object" || sessions === null) return {};
    return sessions;
  } catch {
    return {};
  }
}

export function saveSession(channelId: string, sessionID: string): void {
  const sessions = loadSessions();
  sessions[channelId] = sessionID;
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_PATH, stringify(sessions), "utf-8");
}
