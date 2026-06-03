#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const DEFAULT_PORT = 9333;
const DEFAULT_TIMEOUT_MS = 20000;

function normalizePort(value, label = "--port") {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${label} must be a TCP port number`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be between 1 and 65535`);
  }
  return port;
}

function normalizePositiveInt(value, label) {
  const raw = String(value ?? "").trim();
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readTextFile(path) {
  return fs.readFileSync(path, "utf8");
}

function parseArgs(argv, env = process.env) {
  const parsed = {
    port: normalizePort(env.CODEX_DESKTOP_CDP_PORT || DEFAULT_PORT),
    text: env.CODEX_DESKTOP_CDP_TEXT || "",
    checkOnly: false,
    json: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--port":
        index += 1;
        if (index >= argv.length) throw new Error("--port requires a value");
        parsed.port = normalizePort(argv[index]);
        break;
      case "--text":
        index += 1;
        if (index >= argv.length) throw new Error("--text requires a value");
        parsed.text = argv[index];
        break;
      case "--text-file":
        index += 1;
        if (index >= argv.length) throw new Error("--text-file requires a path");
        parsed.text = readTextFile(argv[index]);
        break;
      case "--check":
        parsed.checkOnly = true;
        break;
      case "--timeout-ms":
        index += 1;
        if (index >= argv.length) throw new Error("--timeout-ms requires a value");
        parsed.timeoutMs = normalizePositiveInt(argv[index], "--timeout-ms");
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!parsed.checkOnly && parsed.text.length === 0 && !parsed.help) {
    throw new Error("Provide --text, --text-file, CODEX_DESKTOP_CDP_TEXT, or --check");
  }

  return parsed;
}

function chooseSendButton(candidates, viewport) {
  const visible = candidates.filter((candidate) => candidate.visible && !candidate.disabled);
  const labelled = visible.find((candidate) => String(candidate.label || "").toLowerCase().includes("send"));
  if (labelled) return labelled;

  const compactControls = visible.filter((candidate) => (
    candidate.w <= 48
    && candidate.h <= 48
    && candidate.x > viewport.width * 0.55
    && candidate.y > viewport.height * 0.45
  ));
  compactControls.sort((a, b) => (
    (b.x + b.w) - (a.x + a.w)
    || (b.y + b.h) - (a.y + a.h)
  ));
  return compactControls[0] || null;
}

function sanitizeResult(result) {
  const allowed = {};
  for (const key of [
    "ok",
    "port",
    "textLength",
    "composerFound",
    "sendButtonFound",
    "clicked",
    "composerCleared",
    "checkOnly",
    "attempts",
    "targetCount",
    "pageCount",
    "error",
  ]) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      allowed[key] = key === "error" ? sanitizeErrorMessage(result[key]) : result[key];
    }
  }
  return allowed;
}

function sanitizeErrorMessage(value) {
  return String(value ?? "")
    .replace(/\b(?:ws|wss|http|https):\/\/[^\s)"']+/gi, "[redacted]")
    .replace(/\bprivate(?:\s+prompt|\s+dom)?\b/gi, "[redacted]")
    .slice(0, 240);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) {
    throw new Error(`CDP HTTP ${response.status}`);
  }
  return response.json();
}

function connectWebSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let nextId = 1;
    let closed = false;

    const client = {
      call(method, params = {}) {
        if (closed) return Promise.reject(new Error("CDP websocket is closed"));
        const id = nextId;
        nextId += 1;
        ws.send(JSON.stringify({ id, method, params }));
        return new Promise((res, rej) => pending.set(id, { res, rej }));
      },
      close() {
        if (closed) return Promise.resolve();
        closed = true;
        for (const { rej } of pending.values()) {
          rej(new Error("CDP websocket closed"));
        }
        pending.clear();
        return new Promise((res) => {
          const timer = setTimeout(res, 100);
          ws.addEventListener("close", () => {
            clearTimeout(timer);
            res();
          }, { once: true });
          try {
            ws.close();
          } catch {
            clearTimeout(timer);
            res();
          }
        });
      },
    };

    ws.addEventListener("open", () => resolve(client), { once: true });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const pendingCall = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) {
        pendingCall.rej(new Error(message.error.message || "CDP command failed"));
      } else {
        pendingCall.res(message.result);
      }
    });
    ws.addEventListener("error", reject, { once: true });
    ws.addEventListener("close", () => {
      closed = true;
      for (const { rej } of pending.values()) {
        rej(new Error("CDP websocket closed"));
      }
      pending.clear();
    });
  });
}

async function evaluate(cdp, expression) {
  return cdp.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
}

async function findComposerTarget(options) {
  const started = Date.now();
  let attempts = 0;
  let lastCounts = { targetCount: 0, pageCount: 0 };

  while (Date.now() - started < options.timeoutMs) {
    attempts += 1;
    let targets = [];
    try {
      targets = await getJson(options.port, "/json/list");
    } catch {
      await delay(250);
      continue;
    }
    const pages = targets.filter((target) => (
      target.type === "page"
      && typeof target.webSocketDebuggerUrl === "string"
      && !String(target.url || "").startsWith("devtools://")
    ));
    lastCounts = { targetCount: targets.length, pageCount: pages.length };

    for (const target of pages) {
      let cdp;
      try {
        cdp = await connectWebSocket(target.webSocketDebuggerUrl);
        const result = await evaluate(
          cdp,
          "(() => ({ hasComposer: !!document.querySelector('[data-codex-composer], [contenteditable=\"true\"]') }))()",
        );
        if (result.result.value?.hasComposer) {
          return { cdp, attempts, ...lastCounts };
        }
      } catch {
        if (cdp) await cdp.close();
        continue;
      }
      await cdp.close();
    }
    await delay(250);
  }

  throw new Error(`composer not found before timeout (targets=${lastCounts.targetCount}, pages=${lastCounts.pageCount})`);
}

async function inspectButtons(cdp) {
  const result = await evaluate(cdp, `(() => {
    const buttons = [...document.querySelectorAll('button')];
    const candidates = buttons.map((button, index) => {
      const rect = button.getBoundingClientRect();
      const label = [
        button.getAttribute('aria-label') || '',
        button.getAttribute('title') || '',
        button.textContent || '',
      ].join(' ').toLowerCase();
      return {
        index,
        visible: rect.width > 0 && rect.height > 0,
        disabled: button.disabled,
        x: rect.x,
        y: rect.y,
        w: rect.width,
        h: rect.height,
        cx: rect.x + rect.width / 2,
        cy: rect.y + rect.height / 2,
        label,
      };
    });
    return { width: window.innerWidth, height: window.innerHeight, candidates };
  })()`);
  return result.result.value;
}

async function inspectComposerCleared(cdp) {
  const result = await evaluate(cdp, `(() => {
    const el = document.querySelector(
      '[data-codex-composer] [contenteditable="true"], [data-codex-composer] textarea, [contenteditable="true"], textarea, [data-codex-composer]'
    );
    if (!el) return { found: false, cleared: false };
    const text = typeof el.value === 'string' ? el.value : (el.textContent || '');
    return { found: true, cleared: text.trim().length === 0 };
  })()`);
  return Boolean(result.result.value?.cleared);
}

async function compose(options) {
  const found = await findComposerTarget(options);
  const cdp = found.cdp;
  try {
    await cdp.call("Runtime.enable");
    await evaluate(
      cdp,
      "(() => { const el = document.querySelector('[data-codex-composer], [contenteditable=\"true\"]'); if (!el) return { found: false }; el.focus(); return { found: true }; })()",
    );

    if (options.checkOnly) {
      return sanitizeResult({
        ok: true,
        port: options.port,
        textLength: 0,
        composerFound: true,
        checkOnly: true,
        attempts: found.attempts,
        targetCount: found.targetCount,
        pageCount: found.pageCount,
      });
    }

    await cdp.call("Input.insertText", { text: options.text });
    let sendButton = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const buttonState = await inspectButtons(cdp);
      sendButton = chooseSendButton(buttonState.candidates, {
        width: buttonState.width,
        height: buttonState.height,
      });
      if (sendButton) break;
      await delay(100);
    }

    if (!sendButton) {
      throw new Error("send button not found");
    }

    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: sendButton.cx,
      y: sendButton.cy,
      button: "none",
    });
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: sendButton.cx,
      y: sendButton.cy,
      button: "left",
      clickCount: 1,
    });
    await cdp.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: sendButton.cx,
      y: sendButton.cy,
      button: "left",
      clickCount: 1,
    });

    let composerCleared = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      composerCleared = await inspectComposerCleared(cdp);
      if (composerCleared) break;
      await delay(100);
    }

    return sanitizeResult({
      ok: true,
      port: options.port,
      textLength: options.text.length,
      composerFound: true,
      sendButtonFound: true,
      clicked: true,
      composerCleared,
      attempts: found.attempts,
      targetCount: found.targetCount,
      pageCount: found.pageCount,
    });
  } finally {
    await cdp.close();
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/cdp-compose.js --check [--port 9333]",
    "  node scripts/cdp-compose.js --text TEXT [--port 9333]",
    "  node scripts/cdp-compose.js --text-file PATH [--port 9333]",
    "",
    "Output is always sanitized JSON and never includes prompt text, DOM text, screenshots, or websocket URLs.",
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) {
      console.log(usage());
      return 0;
    }
    const result = await compose(options);
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify(sanitizeResult({ ok: false, error: message })));
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 20).unref();
  });
}

module.exports = {
  chooseSendButton,
  compose,
  parseArgs,
  sanitizeResult,
};
