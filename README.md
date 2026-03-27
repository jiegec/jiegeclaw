# jiegeclaw

A personal AI assistant that bridges OpenCode with WeChat, Feishu, and WeCom.

## How it works

The architecture is straightforward: messaging channels receive user messages, forward them to OpenCode, and send the responses back.

Three channels are supported right now:

- **WeChat**: Uses `@tencent-weixin/openclaw-weixin` with QR code login and long-polling
- **Feishu**: Uses `@larksuiteoapi/node-sdk` with WebSocket push and reply-in-thread support
- **WeCom**: Uses `@wecom/aibot-node-sdk` with WebSocket and streaming reply support

jiegeclaw manages OpenCode instances automatically. Each channel gets its own OpenCode server process, launched on demand in the selected project directory. On first use, send `/cd <path>` to select a project directory; this creates or resumes a session. Subsequent messages reuse the existing server and session.

Sessions are persisted to `~/.jiegeclaw/sessions.yaml`. When you `/cd` to a directory you've used before, the previous session is resumed. The last opened directory per channel is remembered so it's automatically reconnected on the next message after a restart.

## Setup

Requires Node.js >= 22 and [opencode](https://opencode.ai) installed and available in `$PATH`.

```bash
npm install
```

## Configuration

Config lives at `~/.jiegeclaw/config.yaml`:

```yaml
channels:
  - type: feishu
    appId: cli_xxxxxxxxxxxxxxxx
    appSecret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  - type: weixin
    accountId: xxxxxxxxxxxx
    token: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    userId: xxxxxxxxxxxx
  - type: wecom
    botId: xxxxxxxxxxxx
    secret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

You don't need to edit this file manually — just use the CLI setup commands.

## Usage

### Add a channel

```bash
# Feishu: follow the prompts to enter App ID and App Secret
npm start setup add feishu

# WeChat: scan the QR code displayed in the terminal
npm start setup add weixin

# WeCom: follow the prompts to enter Bot ID and Secret
npm start setup add wecom
```

### Start the bot

```bash
npm start
```

### Slash commands

Send these in any messaging channel:

- `/cd <path>` — Switch to a different project directory. Tears down the previous server and launches a new one in the target directory, resuming or creating a session. Use this first before sending any messages.
- `/help` — Show available commands.

### List configured channels

```bash
npm start setup
```

## License

MIT
