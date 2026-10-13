"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const net = require("node:net");
const os = require("node:os");

const HOST_URL = "app://-/community-web-host.html";
const CHANNEL = "community:web-ui";
const HEARTBEAT_MS = 30_000;
const PROTOCOL = "community-web-ui";
const TOKEN_PROTOCOL = "community-web-ui.cap.";
const TYPES = new Set(["invoke", "subscribe", "unsubscribe", "connect", "rpc"]);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
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

function parseHost(value = "0.0.0.0") {
  if (net.isIP(value) === 0) throw Error("CODEX_WEB_UI_HOST must be an IPv4 or IPv6 address");
  return value;
}

// The Host header is reflected into the CSP and compared with Origin. Accept
// only a plain host[:port] authority; the capability token is the access gate.
const AUTHORITY = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;
const requestHost = req => typeof req.headers.host === "string" && AUTHORITY.test(req.headers.host) ? req.headers.host : null;

function secretEqual(left, right) {
  if (typeof left !== "string") return false;
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isDirectory(file) {
  try { return fs.statSync(file).isDirectory(); } catch { return false; }
}

function listDirectories(directory) {
  if (directory !== null && (typeof directory !== "string" || !path.isAbsolute(directory) || directory.includes("\0"))) {
    throw Error("Choose an absolute path on the host computer.");
  }
  const current = fs.realpathSync(directory ?? os.homedir());
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .filter(entry => !entry.name.startsWith(".") && (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(current, entry.name)))))
    .map(entry => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { path: current, parent: path.dirname(current), entries };
}

// This HTTP service is also testable without Electron. IPC never crosses the
// network directly: only the registered host's preload can handle relay calls.
async function startServer({ webviewRoot, WebSocketServer, port = 4310, host = "0.0.0.0", sendToHost, browserScript = path.join(__dirname, "browser.js") }) {
  const capability = crypto.randomBytes(32).toString("base64url");
  let origin, bootstrap, browser, closed = false;
  const sockets = new Set();
  const root = fs.realpathSync(webviewRoot);
  const ws = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, handleProtocols: () => PROTOCOL });
  // No ambient credential: cookies are scoped to a hostname, not a port, so any
  // other service on that hostname would receive and could replay one. The
  // browser keeps the capability in origin-scoped (port-isolated) storage and
  // presents it explicitly: a bearer header for bootstrap and a WebSocket
  // subprotocol for the bridge, which browsers cannot attach on another
  // origin's behalf.
  const bearer = req => {
    const match = /^Bearer ([\w-]+)$/.exec(req.headers.authorization ?? "");
    return secretEqual(match?.[1], capability);
  };
  const offeredToken = req => {
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    return offered.includes(PROTOCOL) && offered.some(value => value.startsWith(TOKEN_PROTOCOL) && secretEqual(value.slice(TOKEN_PROTOCOL.length), capability));
  };
  // Same-origin WebSocket only: blocks cross-site WebSocket hijacking whatever
  // address (loopback, LAN, Docker-published port, proxy) the browser used.
  const sameOrigin = req => {
    const authority = requestHost(req);
    return authority !== null && [`http://${authority}`, `https://${authority}`].includes(req.headers.origin);
  };
  function reply(req, res, status, body, type = "text/plain; charset=utf-8") {
    res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  }
  const server = http.createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const authority = requestHost(req);
    if (authority === null) return reply(req, res, 400, "Invalid Host");
    if (!["GET", "HEAD"].includes(req.method)) return reply(req, res, 405, "Method not allowed");
    try {
      const url = new URL(req.url, `http://${authority}`);
      if (url.pathname === "/_community/bootstrap") {
        if (!bearer(req)) return reply(req, res, 403, "Use the complete connection URL printed by ChatGPT Community.");
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
        // CSP host-sources cannot contain '_' (container names); 'self' covers those.
        if (!authority.includes("_")) html = html.replace("connect-src ", `connect-src ws://${authority} wss://${authority} `);
        html = html.replace(/<title>[^<]*<\/title>/, "<title>ChatGPT Community</title>");
        // Run the adapter before upstream's scripts so it can stop the page
        // when no capability is available.
        const shim = '<script src="/_community/browser.js"></script>';
        html = html.includes("<script") ? html.replace("<script", `${shim}<script`) : html.replace("</head>", `${shim}</head>`);
        body = Buffer.from(html);
      }
      reply(req, res, 200, body, type);
    } catch {
      reply(req, res, 404, "Not found");
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    // Node removes its own socket error handler before 'upgrade'; a peer reset
    // must not become an uncaught exception in the app's main process.
    socket.on("error", () => {});
    if (!sameOrigin(req) || !offeredToken(req) || req.url !== "/_community/bridge" || !bootstrap) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    ws.handleUpgrade(req, socket, head, client => {
      client.on("error", () => {});
      if (browser) { client.close(1013, "One browser session is already connected"); return; }
      browser = client;
      // Release the single-session slot when a remote browser vanishes
      // without closing (sleep, network change): no pong, no session.
      let alive = true;
      client.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) { client.terminate(); return; }
        alive = false;
        try { client.ping(); } catch {}
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
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
        clearInterval(heartbeat);
        if (browser === client) { browser = undefined; sendToHost({ type: "disconnect" }); }
      });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(parsePort(port), parseHost(host), resolve);
  });
  const bound = server.address();
  // A wildcard bind is reachable through any local address; print loopback.
  const shown = net.isIPv6(bound.address) ? (bound.address === "::" ? "[::1]" : `[${bound.address}]`) : (bound.address === "0.0.0.0" ? "127.0.0.1" : bound.address);
  origin = `http://${shown}:${bound.port}`;
  return {
    // The fragment never reaches the server, proxies, logs or Referer headers.
    origin, url: `${origin}/#cap=${capability}`, wildcard: ["0.0.0.0", "::"].includes(bound.address),
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
  if (instance) {
    // Upstream already built and registered this extra window (overlay, detached
    // chat); destroy it so its owner's cleanup runs instead of leaking it.
    if (!window.isDestroyed()) window.destroy();
    throw Error("Web UI supports one host window; use the browser to navigate between chats.");
  }
  instance = true;
  let service, readyTimer;
  const contents = window.webContents;
  const receive = (event, message) => {
    if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== HOST_URL) return;
    service.receive(message);
    if (message.type === "bootstrap") {
      clearTimeout(readyTimer);
      process.stdout.write(`ChatGPT Community Web UI: ${service.url}\n`);
      if (service.wildcard) process.stdout.write("Listening on all interfaces; from another machine or a published container port, replace the host:port in this URL and keep its #cap= fragment.\n");
    }
  };
  try {
    service = await startServer({
      webviewRoot: path.join(electron.app.getAppPath(), "webview"),
      WebSocketServer, port: process.env.CODEX_WEB_UI_PORT ?? "4310", host: process.env.CODEX_WEB_UI_HOST ?? "0.0.0.0",
      sendToHost: message => { if (!contents.isDestroyed()) contents.send(CHANNEL, message); },
    });
  } catch (error) {
    // Headless: upstream's startup error dialog is invisible. Report and exit.
    process.stderr.write(`ChatGPT Community Web UI failed to start: ${error?.message ?? error}\n`);
    electron.app.exit(1);
    throw error;
  }
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
  // will-quit fires only when no before-quit handler (e.g. upstream's
  // in-progress-work confirmation) cancelled the quit.
  electron.app.once("will-quit", shutdown);
  contents.once("destroyed", shutdown);
  contents.once("render-process-gone", () => { shutdown(); electron.app.exit(1); });
  electron.ipcMain.on(CHANNEL, receive);
  readyTimer = setTimeout(() => { process.stderr.write("Web UI preload did not become ready\n"); shutdown(); electron.app.exit(1); }, 30_000);
  readyTimer.unref();
  await window.loadURL(HOST_URL);
}

module.exports = { listDirectories, loadHost, parseHost, parsePort, startServer };
