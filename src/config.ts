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

export interface AppConfig {
  channels: ChannelConfig[];
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
  fs.writeFileSync(CONFIG_PATH, stringify(config), { mode: 0o600, encoding: "utf-8" });
}

interface ChannelSessions {
  lastDir?: string;
  dirs: Record<string, string>;
}

type Sessions = Record<string, ChannelSessions>;

export function loadSessions(): Sessions {
  try {
    const raw = fs.readFileSync(SESSIONS_PATH, "utf-8");
    const sessions = parse(raw) as Sessions;
    if (typeof sessions !== "object" || sessions === null) return {};
    for (const ch of Object.values(sessions)) {
      if (!ch || typeof ch !== "object" || typeof (ch as ChannelSessions).dirs !== "object") {
        return {};
      }
    }
    return sessions;
  } catch {
    return {};
  }
}

export function saveSessions(sessions: Sessions): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_PATH, stringify(sessions), { mode: 0o600, encoding: "utf-8" });
}

export function getLastDir(channelId: string, sessions: Sessions): string | undefined {
  return sessions[channelId]?.lastDir;
}

export function getSessionIdForDir(channelId: string, directory: string, sessions: Sessions): string | undefined {
  return sessions[channelId]?.dirs[directory];
}

export function updateChannelSession(channelId: string, directory: string, sessionID: string, sessions: Sessions): Sessions {
  if (!sessions[channelId]) {
    sessions[channelId] = { lastDir: directory, dirs: {} };
  }
  const ch = sessions[channelId];
  ch.lastDir = directory;
  ch.dirs[directory] = sessionID;
  saveSessions(sessions);
  return sessions;
}
