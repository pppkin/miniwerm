const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const PORT = parseInt(getArg("--port") || process.env.PORT || "7654", 10);
const SHELL = getArg("--shell") || process.env.SHELL || "/bin/bash";
const TIMEOUT_MS = parseInt(getArg("--timeout") || "1800000", 10);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
};

const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(PUBLIC_DIR, url.pathname === "/" ? "index.html" : url.pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

const sessions = new Map();

const TYPE_INPUT = 0x01;
const TYPE_OUTPUT = 0x02;

function sendBinary(ws, type, data) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  const buf = Buffer.from(data, "utf-8");
  const frame = Buffer.alloc(1 + buf.length);
  frame[0] = type;
  buf.copy(frame, 1);
  ws.send(frame);
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function hexToRgb16(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const to16 = (c) => Math.round(c * 65535 / 255).toString(16).padStart(4, "0");
  return `rgb:${to16(r)}/${to16(g)}/${to16(b)}`;
}

const BEL = "\x07";
const ST = "\x1b\\";

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
    console.warn(`Rejected connection from non-localhost: ${ip}`);
    ws.close();
    return;
  }

  let sessionId = null;
  let session = null;

  ws.on("message", (raw) => {
    let msg = null;
    const isBinary = Buffer.isBuffer(raw);

    if (!isBinary) {
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
    }

    if (!sessionId) {
      if (!msg || msg.type !== "session" || !msg.id) {
        ws.close();
        return;
      }

      sessionId = msg.id;
      const existing = sessions.get(sessionId);

      if (existing && !existing.pty.killed) {
        clearTimeout(existing.timeout);
        existing.timeout = null;
        existing.ws = ws;
        if (msg.bg) existing.bgColor = msg.bg;
        session = existing;
        send(ws, { type: "connected", id: sessionId, reconnected: true });
      } else {
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        const ptyProcess = pty.spawn(SHELL, ["-l"], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.env.HOME || "/",
          env: { ...process.env, TERM: "xterm-256color" },
        });

        session = { pty: ptyProcess, timeout: null, cols, rows, ws, bgColor: msg.bg || "#1e1e2e" };
        sessions.set(sessionId, session);

        let oscBuf = "";
        let outBuf = "";
        let outTimer = null;

        function flushOutput() {
          outTimer = null;
          const s = sessions.get(sessionId);
          if (s && outBuf) sendBinary(s.ws, TYPE_OUTPUT, outBuf);
          outBuf = "";
        }

        ptyProcess.onData((data) => {
          const s = sessions.get(sessionId);
          if (!s) return;

          oscBuf += data;
          const parts = [];
          let last = 0;

          for (let i = 0; i < oscBuf.length; i++) {
            if (oscBuf[i] === "\x1b" && oscBuf[i + 1] === "]") {
              if (i > last) parts.push(oscBuf.slice(last, i));
              let end = oscBuf.indexOf(BEL, i + 2);
              let term = BEL;
              if (end === -1) {
                const stEnd = oscBuf.indexOf(ST, i + 2);
                if (stEnd !== -1) { end = stEnd; term = ST; }
              }
              if (end === -1) { parts.push(oscBuf.slice(i)); last = oscBuf.length; break; }
              const seq = oscBuf.slice(i + 2, end);
              const semi = seq.indexOf(";");
              if (semi !== -1) {
                const code = seq.slice(0, semi);
                const param = seq.slice(semi + 1);
                if ((code === "10" || code === "11") && param === "?") {
                  const rgb = hexToRgb16(s.bgColor);
                  s.pty.write(`\x1b]${code};${rgb}${term}`);
                } else {
                  parts.push(oscBuf.slice(i, end + term.length));
                }
              } else {
                parts.push(oscBuf.slice(i, end + term.length));
              }
              last = end + term.length;
              i = last - 1;
            }
          }
          if (last < oscBuf.length) parts.push(oscBuf.slice(last));
          oscBuf = "";

          const filtered = parts.join("");
          if (!filtered) return;

          outBuf += filtered;
          if (!outTimer) {
            outTimer = setTimeout(flushOutput, 5);
          }
        });

        ptyProcess.onExit(({ exitCode, signal }) => {
          if (outTimer) { clearTimeout(outTimer); flushOutput(); }
          const s = sessions.get(sessionId);
          if (s) send(s.ws, { type: "exit", exitCode, signal });
          sessions.delete(sessionId);
        });

        send(ws, { type: "connected", id: sessionId, reconnected: false });
      }
      return;
    }

    if (!session) return;

    if (Buffer.isBuffer(raw) && raw.length > 1 && raw[0] === TYPE_INPUT) {
      session.pty.write(raw.slice(1).toString("utf-8"));
    } else if (msg.type === "input" && typeof msg.data === "string") {
      session.pty.write(msg.data);
    } else if (msg.type === "resize") {
      session.cols = msg.cols || session.cols;
      session.rows = msg.rows || session.rows;
      session.pty.resize(session.cols, session.rows);
    } else if (msg.type === "bg" && typeof msg.color === "string") {
      session.bgColor = msg.color;
    }
  });

  ws.on("close", () => {
    if (!sessionId || !session) return;

    if (session.timeout) clearTimeout(session.timeout);

    session.timeout = setTimeout(() => {
      const s = sessions.get(sessionId);
      if (s) {
        s.pty.kill();
        sessions.delete(sessionId);
      }
    }, TIMEOUT_MS);
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Use --port to choose another.`);
  } else {
    console.error("Server error:", err.message);
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`miniwerm running at http://localhost:${PORT}`);
  console.log(`Session timeout: ${TIMEOUT_MS / 1000}s (use --timeout to change)`);
});

function shutdown() {
  for (const [id, s] of sessions) {
    s.pty.kill();
  }
  sessions.clear();
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
