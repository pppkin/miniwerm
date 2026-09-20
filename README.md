# miniwerm

A minimal web-based terminal. Opens your shell in the browser at `http://localhost:7654`.

Powered by [wterm](https://github.com/vercel-labs/wterm) — renders to the DOM for native text selection, copy/paste, and browser find.

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [pnpm](https://pnpm.io/) 9+

## Setup

```bash
pnpm install
pnpm start
```

Then open `http://localhost:7654` in your browser.

## Features

- Full shell access via WebSocket + node-pty
- DOM-rendered terminal (native selection, copy/paste, Ctrl+F find)
- **Persistent sessions** — shell survives browser disconnects (mobile lock screen, network drop, etc.)
- Auto-reconnect with backoff on disconnect
- Catppuccin themes (Mocha, Macchiato, Frappé, Latte)
- FiraCode font, adjustable font size
- Localhost-only by default (not accessible from other devices)

## How Sessions Work

Each browser gets a unique session ID stored in `localStorage`. When the WebSocket disconnects (e.g. phone locks), the server keeps the PTY process alive. When the browser reconnects, it resumes the same shell session.

Sessions time out after 30 minutes of disconnection (configurable with `--timeout`).

## Customization

| Flag | Env | Default | Example |
|------|-----|---------|---------|
| `--port` | `PORT` | `7654` | `pnpm start -- --port 8080` |
| `--shell` | `SHELL` | `/bin/bash` | `pnpm start -- --shell /bin/zsh` |
| `--timeout` | — | `1800000` (30m) | `pnpm start -- --timeout 600000` |
