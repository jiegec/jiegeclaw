/**
 * Configuration and session persistence for jiegeclaw.
 *
 * Two YAML files are stored under ~/.jiegeclaw/:
 * - config.yaml: Channel configurations (Feishu, WeCom, Weixin credentials)
 * - sessions.yaml: Per-channel session state (working directory, session IDs)
 *
 * Both files are created with mode 0o600 (owner-only read/write) to protect secrets.
 */

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


/**
 * Union type of all supported channel configurations.
 * Falls back to a generic type for unknown channel types.
 */
export type ChannelConfig = FeishuChannelConfig | WeixinChannelConfig | WecomChannelConfig | { type: string;[key: string]: unknown };

/** Top-level application configuration containing all channels. */
export interface AppConfig {
  channels: ChannelConfig[];
}

/** Returns the default (empty) configuration. */
function defaultConfig(): AppConfig {
  return { channels: [] };
}

/**
 * Load application config from ~/.jiegeclaw/config.yaml.
 * Returns a default empty config if the file doesn't exist or is malformed.
 */
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

/**
 * Save application config to ~/.jiegeclaw/config.yaml.
 * Creates the config directory if it doesn't exist.
 * File is written with mode 0o600 to protect secrets.
 */
export function saveConfig(config: AppConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, stringify(config), { mode: 0o600, encoding: "utf-8" });
}

/**
 * Per-channel session data, tracking the last used directory,
 * the last user who sent a message (for restore notifications),
 * and a mapping of directory -> session ID for quick reuse.
 */
interface ChannelSessions {
  /** The most recently used working directory for this channel. */
  lastDir?: string;
  /** The user ID of the last person who sent a message, used to send session restore notifications. */
  lastFrom?: string;
  /** Map of working directory path -> opencode session ID. */
  dirs: Record<string, string>;
}

/** Map of channel ID -> channel session data. */
type Sessions = Record<string, ChannelSessions>;

/**
 * Load session state from ~/.jiegeclaw/sessions.yaml.
 * Returns an empty object if the file doesn't exist or is malformed.
 */
export function loadSessions(): Sessions {
  try {
    const raw = fs.readFileSync(SESSIONS_PATH, "utf-8");
    const sessions = parse(raw) as Sessions;
    if (typeof sessions !== "object") return {};
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

/**
 * Save session state to ~/.jiegeclaw/sessions.yaml.
 * File is written with mode 0o600.
 */
export function saveSessions(sessions: Sessions): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_PATH, stringify(sessions), { mode: 0o600, encoding: "utf-8" });
}

/**
 * Get the last used working directory for a channel.
 * Returns undefined if no directory has been set.
 */
export function getLastDir(channelId: string, sessions: Sessions): string | undefined {
  return sessions[channelId]?.lastDir;
}

/** Get the user ID of the last person who sent a message on a channel. */
export function getLastFrom(channelId: string, sessions: Sessions): string | undefined {
  return sessions[channelId]?.lastFrom;
}

/**
 * Get the saved opencode session ID for a specific channel + directory combination.
 * Returns undefined if no session exists for that directory.
 */
export function getSessionIdForDir(channelId: string, directory: string, sessions: Sessions): string | undefined {
  return sessions[channelId]?.dirs[directory];
}

/**
 * Update the session state for a channel, recording the current directory
 * and its associated opencode session ID. Persists to disk immediately.
 * Optionally records the sender's user ID for session restore notifications.
 */
export function updateChannelSession(channelId: string, directory: string, sessionID: string, from?: string): void {
  const sessions = loadSessions();
  if (!sessions[channelId]) {
    sessions[channelId] = { lastDir: directory, dirs: {} };
  }
  const ch = sessions[channelId];
  ch.lastDir = directory;
  if (from !== undefined) ch.lastFrom = from;
  ch.dirs[directory] = sessionID;
  saveSessions(sessions);
}
