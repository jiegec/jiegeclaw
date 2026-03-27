# jiegeclaw

A personal AI assistant that bridges OpenCode with WeChat and Feishu.

## How it works

The architecture is straightforward: messaging channels receive user messages, forward them to a locally running OpenCode server, and send the responses back.

Two channels are supported right now:

- **WeChat**: Uses `@tencent-weixin/openclaw-weixin` with QR code login and long-polling
- **Feishu**: Uses `@larksuiteoapi/node-sdk` with WebSocket push and reply-in-thread support

All channels share a single OpenCode session, so conversations are continuous.

## Setup

Requires Node.js >= 22 and a running OpenCode server.

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
opencode:
  baseUrl: http://127.0.0.1:4096
```

`opencode.baseUrl` is optional and defaults to `http://127.0.0.1:4096`. You don't need to edit this file manually — just use the CLI setup commands.

## Usage

### Add a channel

```bash
# Feishu: follow the prompts to enter App ID and App Secret
npm run start -- setup add feishu

# WeChat: scan the QR code displayed in the terminal
npm run start -- setup add weixin
```

### Start the bot

```bash
npm start
```

### List configured channels

```bash
npm run start -- setup
```

## License

MIT
