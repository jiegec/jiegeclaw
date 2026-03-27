# jiegeclaw

A personal AI assistant that bridges OpenCode with WeChat, Feishu, and WeCom.

## How it works

The architecture is straightforward: messaging channels receive user messages, forward them to a locally running OpenCode server, and send the responses back.

Three channels are supported right now:

- **WeChat**: Uses `@tencent-weixin/openclaw-weixin` with QR code login and long-polling
- **Feishu**: Uses `@larksuiteoapi/node-sdk` with WebSocket push and reply-in-thread support
- **WeCom**: Uses `@wecom/aibot-node-sdk` with WebSocket and streaming reply support

Each channel uses its own OpenCode session, so conversations are isolated per channel. Sessions are persisted to `~/.jiegeclaw/sessions.yaml` and reused across restarts. When a channel reconnects, it resumes the previous session if it still exists on the OpenCode server, otherwise creates a new one.

## Setup

Requires Node.js >= 22 and a running OpenCode server. Make sure to start OpenCode separately in your project directory using `opencode serve` before launching jiegeclaw.

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
opencode:
  baseUrl: http://127.0.0.1:4096
```

`opencode.baseUrl` is optional and defaults to `http://127.0.0.1:4096`. You don't need to edit this file manually — just use the CLI setup commands.

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

### List configured channels

```bash
npm start setup
```

## License

MIT
