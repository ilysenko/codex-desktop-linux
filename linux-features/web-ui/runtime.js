"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const os = require("node:os");

const HOST_URL = "app://-/community-web-host.html";
const CHANNEL = "community:web-ui";
const TYPES = new Set(["invoke", "subscribe", "unsubscribe", "connect", "rpc"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".woff": "font/woff", ".woff2": "font/woff2", ".wasm": "application/wasm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".webm": "video/webm",
};

function parsePort(value = "4310") {
  if (!/^(0|[1-9]\d{0,4})$/.test(String(value)) || Number(value) > 65535) {
    throw Error("CODEX_WEB_UI_PORT must be an integer from 0 to 65535");
  }
  return Number(value);
}

function secretEqual(left, right) {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function listDirectories(directory) {
  if (directory !== null && (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0"))) {
    throw Error("Choose an absolute path on the host computer.");
  }
  const current = fs.realpathSync(directory ?? os.homedir());
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".") && entry.isDirectory())
    .map(entry => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { path: current, parent: path.dirname(current), entries };
}

// This HTTP service is also testable without Electron. IPC never crosses the
// network directly: only the registered host's preload can handle relay calls.
async function startServer({ webviewRoot, WebSocketServer, port = 4310, sendToHost, browserScript = path.join(__dirname, "browser.js") }) {
  const capability = crypto.randomBytes(32).toString("base64url");
  const cookieName = "community_web_ui";
  let origin, bootstrap, browser, closed = false;
  const sockets = new Set();
  const root = fs.realpathSync(webviewRoot);
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false });
  const authorized = req => (req.headers.cookie ?? "").split(";").some(cookie => {
    const [name, ...value] = cookie.trim().split("=");
    return name === cookieName && secretEqual(value.join("="), capability);
  });
  const expectedHost = req => req.headers.host === new URL(origin).host;
  function reply(req, res, status, body, type = "text/plain; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // Block cross-origin scripts from using capability-authenticated assets.
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (!expectedHost(req)) return reply(req, res, 421, "Unexpected Host");
    if (!["GET", "HEAD"].includes(req.method)) return reply(req, res, 405, "Method not allowed");
    try {
      const url = new URL(req.url, origin);
      if (url.pathname === "/" && secretEqual(url.searchParams.get("cap"), capability)) {
        res.writeHead(303, { "Set-Cookie": `${cookieName}=${capability}; HttpOnly; SameSite=Strict; Path=/`, Location: "/" });
        res.end(); return;
      }
      if (!authorized(req)) return reply(req, res, 403, "Use the complete connection URL printed by ChatGPT Community.");
      if (url.pathname === "/_community/bootstrap") {
        return reply(req, res, bootstrap ? 200 : 503, bootstrap ? JSON.stringify(bootstrap) : "Host not ready", bootstrap ? MIME[".json"] : undefined);
      }
      if (url.pathname === "/_community/browser.js") return reply(req, res, 200, fs.readFileSync(browserScript), MIME[".js"]);
      if (url.pathname.startsWith("/_community/") || url.pathname === "/community-web-host.html") return reply(req, res, 404, "Not found");
      const decoded = decodeURIComponent(url.pathname);
      if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").some(part => part === ".." || part.startsWith("."))) {
        return reply(req, res, 400, "Invalid asset path");
      }
      const file = path.join(root, decoded === "/" ? "index.html" : decoded);
      // realpath also prevents a staged symlink from exposing host files.
      const real = fs.realpathSync(file);
      if (!real.startsWith(`${root}${path.sep}`) || !fs.statSync(real).isFile()) return reply(req, res, 404, "Not found");
      let body = fs.readFileSync(real);
      const type = MIME[path.extname(real)] ?? "application/octet-stream";
      if (real === path.join(root, "index.html")) {
        let html = body.toString();
        // Explicit WebSocket origin for Chromium versions whose 'self' does not
        // cover ws:. Preserve the upstream CSP's other source restrictions.
        html = html.replace("connect-src ", `connect-src ${origin.replace("http:", "ws:")} `);
        html = html.replace(/<title>[^<]*<\/title>/, "<title>ChatGPT Community</title>");
        html = html.replace("</head>", '<script src="/_community/browser.js"></script></head>');
        body = Buffer.from(html);
      }
      reply(req, res, 200, body, type);
    } catch {
      reply(req, res, 404, "Not found");
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    if (!expectedHost(req) || req.headers.origin !== origin || !authorized(req) || req.url !== "/_community/bridge" || !bootstrap) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    ws.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      if (browser) { client.close(1013, "One browser session is already connected"); return; }
      browser = client;
      client.on("message", (bytes, binary) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (binary || !message || !TYPES.has(message.type)) throw Error("Invalid message");
          if (message.type === "rpc" && message.value !== null && typeof message.value !== "string") throw Error("Invalid RPC");
          if (message.type === "invoke" && message.method === "listDirectories") {
            try {
              if (typeof message.id !== "string" || !Array.isArray(message.args) || message.args.length !== 1) throw Error("Invalid folder request");
              client.send(JSON.stringify({ type: "result", id: message.id, ok: true, value: listDirectories(message.args[0]) }));
            } catch {
              client.send(JSON.stringify({ type: "result", id: message.id, ok: false, error: "This folder is unavailable. Enter an absolute path on the host computer." }));
            }
            return;
          }
          sendToHost(message);
        } catch { client.close(1007, "Invalid bridge message"); }
      });
      client.on("close", () => {
        if (browser === client) { browser = undefined; sendToHost({ type: "disconnect" }); }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsePort(port), "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, url: `${origin}/?cap=${capability}`,
    receive(message) {
      if (message.type === "bootstrap") {
        bootstrap = message.value;
        return;
      }
      if (message.type === "notification" && message.value?.type === "shared-object-updated" && bootstrap) {
        const { key, value } = message.value;
        if (value === undefined) delete bootstrap.sharedObjectSnapshot[key];
        else bootstrap.sharedObjectSnapshot[key] = value;
      }
      if (message.type === "disconnect") { browser?.close(1011, "Host bridge failed"); return; }
      if (["result", "notification", "worker", "rpc"].includes(message.type) && browser?.readyState === 1) {
        browser.send(JSON.stringify(message));
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      bootstrap = undefined;
      for (const client of ws.clients) client.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise(resolve => ws.close(resolve)), new Promise(resolve => server.close(resolve))]);
    },
  };
}

let instance;
async function loadHost(window, { electron, WebSocketServer }) {
  if (instance) throw Error("Web UI supports one host window; use the browser to navigate between chats.");
  instance = true;
  let service, readyTimer;
  const contents = window.webContents;
  const receive = (event, message) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== HOST_URL) return;
    service.receive(message);
    if (message.type === "bootstrap") {
      clearTimeout(readyTimer);
      process.stdout.write(`ChatGPT Community Web UI: ${service.url}\n`);
    }
  };
  service = await startServer({
    webviewRoot: path.join(electron.app.getAppPath(), "webview"),
    WebSocketServer, port: process.env.CODEX_WEB_UI_PORT ?? "4310",
    sendToHost: message => { if (!contents.isDestroyed()) contents.send(CHANNEL, message); },
  });
  const shutdown = () => {
    clearTimeout(readyTimer);
    electron.ipcMain.removeListener(CHANNEL, receive);
    electron.shell.openExternal = openExternal;
    service.close().catch(() => {});
  };
  const openExternal = electron.shell.openExternal;
  electron.shell.openExternal = async value => {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      throw Error("This link requires the desktop interface.");
    }
    service.receive({ type: "notification", value: { type: "community-open-external", url: url.href } });
  };
  electron.app.once("before-quit", shutdown);
  contents.once("destroyed", shutdown);
  contents.once("render-process-gone", () => { shutdown(); electron.app.exit(1); });
  electron.ipcMain.on(CHANNEL, receive);
  readyTimer = setTimeout(() => { process.stderr.write("Web UI preload did not become ready\n"); shutdown(); electron.app.exit(1); }, 30_000);
  readyTimer.unref();
  await window.loadURL(HOST_URL);
}

module.exports = { listDirectories, loadHost, parsePort, startServer };
