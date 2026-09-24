# AGENTS.md

Minimal web terminal: single Node server (`server.js`) + static client (`public/`). No framework, no build step, no TypeScript.

## Commands

- Install: `pnpm install` (Node 18+, pnpm 9+)
- Run: `pnpm start` → `http://localhost:7654`
- Flags: `pnpm start -- --port 8080 --shell /bin/zsh --timeout 600000` (env fallbacks: `PORT`, `SHELL`)
- No lint, typecheck, test, or CI. Verify by starting the server and exercising the terminal in a browser.

`node-pty` is a native addon; builds are allowlisted in `pnpm-workspace.yaml` under `allowBuilds` (pnpm 11+ ignores `package.json` `pnpm.onlyBuiltDependencies`). If install fails with `ERR_PNPM_IGNORED_BUILDS`, fix that file.

After install, `prebuilds/*/spawn-helper` may lack the execute bit (pnpm strips it) → every PTY spawn dies with `posix_spawnp failed`. The `postinstall` script chmods it; if shells won't start, check `/tmp/miniwerm.log` for that error.

## Architecture

- `server.js` — HTTP static file server (from `public/`) + WebSocket server + PTY sessions. Entry point; everything server-side lives here.
- `public/index.html` — all client logic inline (no bundler, no modules beyond vendored lib).
- `public/lib/@wterm/` — vendored copy of [wterm](https://github.com/vercel-labs/wterm) (dist builds + CSS). Not a package dependency; do not add to `package.json` or `node_modules`.

## Protocol (WebSocket)

Mixed binary + JSON; easy to break if you change one side only:

- First message must be JSON `{type:"session", id, cols, rows, bg}`. Server closes the socket otherwise.
- Binary frames: 1-byte type prefix (`0x01` input, `0x02` output) + UTF-8 payload. Input goes to the PTY; output is coalesced (5ms flush).
- JSON control after handshake: `{type:"input"|"resize"|"bg", ...}`. Server replies `{type:"connected"|"exit"}`.
- `ws` always delivers Buffers — server distinguishes binary vs JSON by checking the first byte, not by message type.

## Behavior worth preserving

- **Localhost-only**: server binds `127.0.0.1` and rejects WS connections from non-loopback IPs. Don't "fix" this to listen on `0.0.0.0`.
- **Session resume**: client ID lives in `localStorage`; PTY survives disconnect and is reattached on reconnect. Idle sessions are killed after `--timeout` (default 30 min).
- **OSC 10/11 interception**: server answers terminal color queries with the theme background so apps match the theme. Client sends `bg` on connect/`bg` messages.
- Path traversal on static files is guarded by a `startsWith(PUBLIC_DIR)` check — keep it if you touch the HTTP handler.

## Style

Vanilla CommonJS (`require`), no semicolon-free style, no lint config. Match the existing single-file procedural style; don't introduce a build tool or framework.
