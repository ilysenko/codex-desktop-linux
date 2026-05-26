#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const { Buffer } = require("node:buffer");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const REPO_DIR = path.resolve(__dirname, "..");
const COMMAND_SENTINEL = "codex-linux-smoke";

function usage() {
  return [
    "Usage: desktop-parity-smoke.js [options]",
    "",
    "Runs non-sensitive Codex Desktop parity probes against app-server.",
    "",
    "Options:",
    "  --json                       Print sanitized JSON instead of text",
    "  --skip-cdp                   Skip optional Electron CDP UI checks",
    "  --strict                     Fail if optional UI parity checks are not configured",
    "  --cdp-origin URL             Include UI checks through an existing CDP endpoint",
    "  --codex-bin PATH             Codex CLI binary to spawn (default: codex)",
    "  --require-remote-connected   Fail unless remote-control status is connected",
    "  -h, --help                   Show this message",
    "",
    "Environment:",
    "  CODEX_DESKTOP_CDP_ORIGIN     Same as --cdp-origin",
    "  CODEX_PARITY_CODEX_BIN       Same as --codex-bin",
    "  CODEX_PARITY_REQUIRE_REMOTE_CONNECTED=1",
    "  CODEX_PARITY_STRICT=1",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    cdpOrigin: process.env.CODEX_DESKTOP_CDP_ORIGIN || null,
    codexBin: process.env.CODEX_PARITY_CODEX_BIN || "codex",
    json: false,
    requireRemoteConnected: process.env.CODEX_PARITY_REQUIRE_REMOTE_CONNECTED === "1",
    skipCdp: false,
    strict: process.env.CODEX_PARITY_STRICT === "1",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--skip-cdp") {
      options.skipCdp = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--require-remote-connected") {
      options.requireRemoteConnected = true;
    } else if (arg === "--cdp-origin") {
      options.cdpOrigin = argv[index + 1];
      if (!options.cdpOrigin) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--codex-bin") {
      options.codexBin = argv[index + 1];
      if (!options.codexBin) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  if (options.skipCdp) {
    if (options.strict) {
      throw new Error("--skip-cdp cannot be combined with --strict");
    }
    options.cdpOrigin = null;
  }

  return options;
}

function redactText(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, "<jwt-redacted>");
}

function summarizeErrorText(value) {
  const text = redactText(value).replace(/\s+/g, " ").trim();
  const httpStatus = text.match(/Request failed with status\s+(\d+)\s*([^:<]*)/i);
  if (httpStatus) {
    const reason = httpStatus[2]?.trim();
    return `request failed with status ${httpStatus[1]}${reason ? ` ${reason}` : ""}`;
  }
  if (/<html|<!doctype|challenge-platform|cloudflare/i.test(text)) {
    return "HTML error response redacted";
  }
  return text.slice(0, 300) || "unknown error";
}

function safeArrayLength(value) {
  return Array.isArray(value) ? value.length : null;
}

function hasObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createSkillFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-skills-"));
  const skillDir = path.join(fixtureDir, ".codex", "skills", "codex-parity-skill");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: codex-parity-skill",
      "description: Temporary desktop parity fixture skill.",
      "---",
      "",
      "# Codex Parity Skill",
      "",
      "This fixture verifies repo-scoped skill discovery.",
      "",
    ].join("\n"),
    "utf8",
  );
  return fixtureDir;
}

function createProjectConfigFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-config-"));
  fs.mkdirSync(path.join(fixtureDir, ".git"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, ".codex", "config.toml"),
    [
      "desktop_parity_fixture = true",
      "",
    ].join("\n"),
    "utf8",
  );
  return fixtureDir;
}

function createExternalAgentFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-external-agent-"));
  fs.mkdirSync(path.join(fixtureDir, ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "CLAUDE.md"),
    [
      "# Codex Parity External Agent Fixture",
      "",
      "This temporary file verifies safe migration detection only.",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(fixtureDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { "codex-parity-mcp": { command: "true" } } }, null, 2) + "\n",
    "utf8",
  );
  return fixtureDir;
}

function removeFixture(fixtureDir) {
  if (fixtureDir) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

class AppServerClient {
  constructor({ codexBin }) {
    this.child = spawn(codexBin, ["app-server", "--remote-control"], {
      cwd: REPO_DIR,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = new Map();
    this.notificationWaiters = new Map();
    this.serverRequestMethods = new Map();
    this.stderr = "";
    this.closed = false;

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr = redactText(`${this.stderr}${chunk}`).slice(-4000);
    });

    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      if (this.pending.size > 0) {
        this.failAll(new Error(`app-server exited early with code=${code} signal=${signal}`));
      }
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(new Error("app-server emitted a non-JSON stdout line"));
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${summarizeErrorText(message.error.message || "JSON-RPC error")}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && message.method) {
      this.recordServerRequest(message.method);
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message: "desktop parity smoke does not handle server-initiated requests",
        },
      });
      return;
    }

    if (message.method) {
      this.recordNotification(message.method, message.params ?? {});
    }
  }

  recordServerRequest(method) {
    this.serverRequestMethods.set(method, (this.serverRequestMethods.get(method) || 0) + 1);
  }

  recordNotification(method, params) {
    const bucket = this.notifications.get(method) || [];
    bucket.push(params);
    this.notifications.set(method, bucket);

    const waiters = this.notificationWaiters.get(method);
    if (waiters) {
      this.notificationWaiters.delete(method);
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(params);
      }
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) {
      throw new Error("app-server stdin is closed");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = 10000) {
    const id = this.nextId;
    this.nextId += 1;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timer });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  waitForNotification(method, timeoutMs = 1500) {
    const existing = this.notifications.get(method);
    if (existing && existing.length > 0) {
      return Promise.resolve(existing[existing.length - 1]);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.notificationWaiters.get(method) || [];
        this.notificationWaiters.set(
          method,
          waiters.filter((waiter) => waiter.resolve !== resolve),
        );
        resolve(null);
      }, timeoutMs);
      const waiters = this.notificationWaiters.get(method) || [];
      waiters.push({ resolve, timer });
      this.notificationWaiters.set(method, waiters);
    });
  }

  latestNotification(method) {
    const values = this.notifications.get(method);
    return values && values.length > 0 ? values[values.length - 1] : null;
  }

  async close() {
    this.rl.close();
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }

    const exited = new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve(true);
        return;
      }
      this.child.once("exit", () => resolve(true));
    });

    if (this.child.stdin.writable) {
      this.child.stdin.end();
    }
    this.child.kill("SIGTERM");

    const exitedAfterTerm = await Promise.race([
      exited.then(() => true),
      wait(250).then(() => false),
    ]);
    if (!exitedAfterTerm && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([exited, wait(250)]);
    }
  }
}

function summarizePluginList(result) {
  return {
    apps: safeArrayLength(result.apps),
    data: safeArrayLength(result.data),
    featured: safeArrayLength(result.featuredPluginIds),
    loadErrors: safeArrayLength(result.marketplaceLoadErrors) || 0,
    marketplaces: safeArrayLength(result.marketplaces),
  };
}

function summarizeConfig(result) {
  const config = hasObject(result.config) ? result.config : {};
  return {
    hasConfig: hasObject(result.config),
    hasAppsConfig: hasObject(config.apps),
    hasMcpServersConfig: hasObject(config.mcp_servers),
    hasPluginsConfig: hasObject(config.plugins),
  };
}

function hasProjectConfigLayer(result, fixtureDir) {
  const layers = Array.isArray(result.layers) ? result.layers : [];
  return layers.some((layer) => (
    hasObject(layer) &&
    hasObject(layer.name) &&
    layer.name.type === "project" &&
    layer.name.dotCodexFolder === path.join(fixtureDir, ".codex")
  ));
}

function summarizeRemoteStatus(params) {
  if (!hasObject(params)) {
    return null;
  }
  return {
    environmentIdPresent: typeof params.environmentId === "string" && params.environmentId.length > 0,
    installationIdPresent: typeof params.installationId === "string" && params.installationId.length > 0,
    serverNamePresent: typeof params.serverName === "string" && params.serverName.length > 0,
    status: typeof params.status === "string" ? params.status : "unknown",
  };
}

function notificationMethodCounts(client) {
  const counts = {};
  for (const [method, values] of client.notifications.entries()) {
    counts[method] = values.length;
  }
  return counts;
}

async function waitForRemoteStatus(client, requireConnected) {
  const deadline = Date.now() + (requireConnected ? 5000 : 2500);
  let latest = client.latestNotification("remoteControl/status/changed");
  while (Date.now() < deadline) {
    const status = summarizeRemoteStatus(latest);
    if (status && (!requireConnected || status.status === "connected")) {
      return latest;
    }
    await wait(250);
    latest = client.latestNotification("remoteControl/status/changed");
  }
  return latest;
}

async function runAppServerSmoke(options) {
  const client = new AppServerClient({ codexBin: options.codexBin });
  const checks = [];

  const record = (name, status, details = {}) => {
    checks.push({ name, status, details });
  };

  try {
    const initialize = await client.request("initialize", {
      clientInfo: {
        name: "codex_linux_desktop_parity_smoke",
        title: "Codex Linux Desktop Parity Smoke",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [
          "account/updated",
          "account/rateLimits/updated",
          "thread/started",
          "thread/status/changed",
        ],
      },
    });
    record("initialize", "pass", {
      platformFamily: initialize.platformFamily || null,
      platformOs: initialize.platformOs || null,
      userAgentPresent: typeof initialize.userAgent === "string" && initialize.userAgent.length > 0,
    });

    client.notify("initialized", {});
    await client.waitForNotification("remoteControl/status/changed", 2500);

    const probes = [
      {
        name: "thread list",
        method: "thread/list",
        params: { limit: 1 },
        summarize: (result) => ({ count: safeArrayLength(result.data), hasNextCursor: !!result.nextCursor }),
      },
      {
        name: "loaded thread list",
        method: "thread/loaded/list",
        params: {},
        summarize: (result) => ({
          count: safeArrayLength(result.threadIds) ?? safeArrayLength(result.data),
        }),
      },
      {
        name: "plugin list",
        method: "plugin/list",
        params: {},
        summarize: summarizePluginList,
      },
      {
        name: "app list",
        method: "app/list",
        params: { forceRefetch: false, limit: 20 },
        summarize: (result) => ({ count: safeArrayLength(result.data), hasNextCursor: !!result.nextCursor }),
      },
      {
        name: "mcp server status list",
        method: "mcpServerStatus/list",
        params: { detail: "toolsAndAuthOnly", limit: 20 },
        summarize: (result) => ({ count: safeArrayLength(result.data), hasNextCursor: !!result.nextCursor }),
      },
      {
        name: "skills list",
        method: "skills/list",
        params: { cwds: [REPO_DIR], forceReload: false },
        summarize: (result) => ({ cwdEntries: safeArrayLength(result.data) }),
      },
      {
        name: "model list",
        method: "model/list",
        params: { includeHidden: false, limit: 20 },
        summarize: (result) => ({ count: safeArrayLength(result.data), hasNextCursor: !!result.nextCursor }),
      },
      {
        name: "config read",
        method: "config/read",
        params: { includeLayers: false },
        summarize: summarizeConfig,
      },
      {
        name: "config requirements read",
        method: "configRequirements/read",
        params: {},
        summarize: (result) => ({ hasRequirements: hasObject(result.requirements) }),
      },
      {
        name: "external agent config detect",
        method: "externalAgentConfig/detect",
        params: { includeHome: false, cwds: [REPO_DIR] },
        summarize: (result) => ({ count: safeArrayLength(result.items) }),
      },
    ];

    for (const probe of probes) {
      try {
        const result = await client.request(probe.method, probe.params);
        const details = probe.summarize(result);
        if (probe.method === "plugin/list" && details.loadErrors > 0) {
          record(probe.name, "fail", details);
        } else {
          record(probe.name, "pass", details);
        }
      } catch (error) {
        const errorSummary = summarizeErrorText(error.message);
        const status =
          probe.method === "app/list" && /request failed with status (403|429|5\d\d)/.test(errorSummary)
            ? "info"
            : "fail";
        record(probe.name, status, { error: errorSummary });
      }
    }

    const skillFixtureDir = createSkillFixture();
    try {
      const result = await client.request("skills/list", { cwds: [skillFixtureDir], forceReload: true });
      const cwdEntries = Array.isArray(result.data) ? result.data : [];
      const fixtureEntry = cwdEntries.find((entry) => entry && entry.cwd === skillFixtureDir);
      const skills = Array.isArray(fixtureEntry?.skills) ? fixtureEntry.skills : [];
      const fixtureSkill = skills.find((skill) => skill && skill.name === "codex-parity-skill");
      record("repo skill fixture", fixtureSkill?.enabled === true && fixtureSkill.scope === "repo" ? "pass" : "fail", {
        cwdEntries: cwdEntries.length,
        fixtureSkillPresent: fixtureSkill != null,
        fixtureSkillRepoScoped: fixtureSkill?.scope === "repo",
      });
    } catch (error) {
      record("repo skill fixture", "fail", { error: summarizeErrorText(error.message) });
    } finally {
      removeFixture(skillFixtureDir);
    }

    const configFixtureDir = createProjectConfigFixture();
    try {
      const result = await client.request("config/read", { cwd: configFixtureDir, includeLayers: true });
      const projectLayerPresent = hasProjectConfigLayer(result, configFixtureDir);
      record("project config fixture", projectLayerPresent ? "pass" : "fail", {
        hasConfig: hasObject(result.config),
        layerCount: safeArrayLength(result.layers),
        projectLayerPresent,
      });
    } catch (error) {
      record("project config fixture", "fail", { error: summarizeErrorText(error.message) });
    } finally {
      removeFixture(configFixtureDir);
    }

    const externalAgentFixtureDir = createExternalAgentFixture();
    try {
      const result = await client.request("externalAgentConfig/detect", {
        includeHome: false,
        cwds: [externalAgentFixtureDir],
      });
      const items = Array.isArray(result.items) ? result.items : [];
      const itemTypes = new Set(items.map((item) => item && item.itemType).filter(Boolean));
      const mcpItem = items.find((item) => item && item.itemType === "MCP_SERVER_CONFIG");
      const mcpNames = Array.isArray(mcpItem?.details?.mcpServers)
        ? mcpItem.details.mcpServers.map((server) => server && server.name).filter(Boolean)
        : [];
      const agentsMdDetected = itemTypes.has("AGENTS_MD");
      const mcpDetected = itemTypes.has("MCP_SERVER_CONFIG") && mcpNames.includes("codex-parity-mcp");
      record("external agent fixture detect", agentsMdDetected && mcpDetected ? "pass" : "fail", {
        itemCount: items.length,
        agentsMdDetected,
        mcpDetected,
      });
    } catch (error) {
      record("external agent fixture detect", "fail", { error: summarizeErrorText(error.message) });
    } finally {
      removeFixture(externalAgentFixtureDir);
    }

    const commandResult = await client.request("command/exec", {
      command: ["bash", "-lc", `printf '%s\\n' ${COMMAND_SENTINEL}`],
      cwd: REPO_DIR,
      outputBytesCap: 1024,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      timeoutMs: 10000,
    });
    const commandPassed =
      commandResult.exitCode === 0 &&
      commandResult.stdout === `${COMMAND_SENTINEL}\n` &&
      commandResult.stderr === "";
    record("sandbox command exec", commandPassed ? "pass" : "fail", {
      exitCode: Number.isInteger(commandResult.exitCode) ? commandResult.exitCode : null,
      stderrEmpty: commandResult.stderr === "",
      stdoutMatchesSentinel: commandResult.stdout === `${COMMAND_SENTINEL}\n`,
    });

    const remoteStatusReadResult = await client.request("remoteControl/status/read", {});
    const remoteStatusRead = summarizeRemoteStatus(remoteStatusReadResult);
    if (remoteStatusRead) {
      const status =
        options.requireRemoteConnected && remoteStatusRead.status !== "connected" ? "fail" : "pass";
      record("remote control status read", status, remoteStatusRead);
    } else {
      record("remote control status read", "fail", { observed: false });
    }

    const remoteStatusNotification = await waitForRemoteStatus(client, options.requireRemoteConnected);
    const remoteStatus = summarizeRemoteStatus(remoteStatusNotification);
    if (remoteStatus) {
      const status = options.requireRemoteConnected && remoteStatus.status !== "connected" ? "fail" : "pass";
      record("remote control status notification", status, remoteStatus);
    } else {
      const status = options.requireRemoteConnected ? "fail" : "info";
      record("remote control status notification", status, { observed: false });
    }

    if (client.serverRequestMethods.size > 0) {
      record("server-initiated requests", "fail", {
        methods: Object.fromEntries(client.serverRequestMethods.entries()),
      });
    } else {
      record("server-initiated requests", "pass", { count: 0 });
    }

    return {
      checks,
      notificationCounts: notificationMethodCounts(client),
      stderrEmpty: client.stderr.length === 0,
    };
  } finally {
    await client.close();
  }
}

function normalizeCdpOrigin(origin) {
  if (!origin) {
    return null;
  }
  const url = new URL(origin);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.json();
}

async function cdpCommand(socket, state, method, params = {}) {
  const id = state.nextId;
  state.nextId += 1;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`${method}: timed out`));
    }, 5000);
    state.pending.set(id, { method, reject, resolve, timer });
  });
}

async function withCdpSocket(webSocketDebuggerUrl, callback) {
  if (typeof WebSocket !== "function") {
    throw new Error("Node.js global WebSocket is unavailable; use Node 22+ for CDP UI checks");
  }

  const socket = new WebSocket(webSocketDebuggerUrl);
  const state = { nextId: 1, pending: new Map() };

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      return;
    }
    const pending = state.pending.get(message.id);
    if (!pending) {
      return;
    }
    state.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(`${pending.method}: ${message.error.message || "CDP error"}`));
    } else {
      pending.resolve(message.result ?? {});
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP WebSocket open timed out")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP WebSocket failed to open"));
    }, { once: true });
  });

  try {
    return await callback(socket, state);
  } finally {
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP socket closed"));
    }
    state.pending.clear();
    socket.close();
  }
}

async function runCdpSmoke(cdpOrigin, strict) {
  if (!cdpOrigin) {
    return {
      status: strict ? "fail" : "skip",
      details: {
        reason: strict
          ? "strict mode requires CODEX_DESKTOP_CDP_ORIGIN or --cdp-origin"
          : "set CODEX_DESKTOP_CDP_ORIGIN or --cdp-origin to include UI checks",
      },
    };
  }

  const origin = normalizeCdpOrigin(cdpOrigin);
  const targets = await fetchJson(`${origin}/json/list`);
  if (!Array.isArray(targets)) {
    throw new Error("CDP target list was not an array");
  }
  const target = targets.find((entry) => (
    entry &&
    entry.type === "page" &&
    typeof entry.webSocketDebuggerUrl === "string" &&
    typeof entry.url === "string" &&
    entry.url.startsWith("http://127.0.0.1:")
  ));
  if (!target) {
    throw new Error("No Codex webview page target found in CDP target list");
  }

  const expression = String.raw`
(() => {
  const visibleText = (document.body?.innerText || "");
  const controls = Array.from(document.querySelectorAll("button,[role='button'],input,textarea,a"))
    .map((element) => [
      element.getAttribute("aria-label"),
      element.getAttribute("title"),
      element.getAttribute("placeholder"),
      element.textContent,
    ].filter(Boolean).join(" "))
    .join("\n");
  const combined = visibleText + "\n" + controls;
  const has = (pattern) => pattern.test(combined);
  return {
    hasAutomations: has(/\bAutomations\b/i),
    hasComposer: has(/What should we work on/i),
    hasDefaultPermissions: has(/Default permissions/i),
    hasMobileEntry: has(/Open Codex mobile/i),
    hasModelText: has(/\b(5\.5|GPT-5\.5|5\.4|GPT-5\.4)\b/i),
    hasNewChat: has(/New chat/i),
    hasPlugins: has(/\bPlugins\b/i),
    hasProjects: has(/\bProjects\b/i),
    hasSearch: has(/\bSearch\b/i),
    hasSettings: has(/\bSettings\b/i),
    textLength: visibleText.length,
  };
})()
`;

  return withCdpSocket(target.webSocketDebuggerUrl, async (socket, state) => {
    await cdpCommand(socket, state, "Runtime.enable");
    const evaluation = await cdpCommand(socket, state, "Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    const value = evaluation.result && evaluation.result.value;
    if (!hasObject(value)) {
      throw new Error("CDP Runtime.evaluate did not return an object by value");
    }

    const required = [
      "hasNewChat",
      "hasSearch",
      "hasPlugins",
      "hasAutomations",
      "hasProjects",
      "hasSettings",
      "hasMobileEntry",
      "hasComposer",
      "hasDefaultPermissions",
      "hasModelText",
    ];
    const missing = required.filter((key) => value[key] !== true);
    return {
      status: missing.length === 0 && value.textLength > 100 ? "pass" : "fail",
      details: {
        controls: Object.fromEntries(required.map((key) => [key, value[key] === true])),
        missing,
        textLength: Number.isInteger(value.textLength) ? value.textLength : null,
      },
    };
  });
}

function summarize(results) {
  const allChecks = [
    ...results.appServer.checks,
    { name: "electron cdp ui", status: results.cdp.status, details: results.cdp.details },
  ];
  const counts = { fail: 0, info: 0, pass: 0, skip: 0 };
  for (const check of allChecks) {
    counts[check.status] = (counts[check.status] || 0) + 1;
  }
  return {
    ok: counts.fail === 0,
    counts,
    checks: allChecks,
    notificationCounts: results.appServer.notificationCounts,
    stderrEmpty: results.appServer.stderrEmpty,
  };
}

function printText(summary) {
  console.log(
    `[parity] result=${summary.ok ? "pass" : "fail"} pass=${summary.counts.pass} info=${summary.counts.info} skip=${summary.counts.skip} fail=${summary.counts.fail}`,
  );
  for (const check of summary.checks) {
    console.log(`[parity] ${check.status.toUpperCase()} ${check.name}: ${JSON.stringify(check.details)}`);
  }
  console.log(`[parity] notifications: ${JSON.stringify(summary.notificationCounts)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const appServer = await runAppServerSmoke(options);
  let cdp;
  try {
    cdp = await runCdpSmoke(options.cdpOrigin, options.strict);
  } catch (error) {
    cdp = {
      status: "fail",
      details: { error: redactText(error instanceof Error ? error.message : String(error)) },
    };
  }

  const summary = summarize({ appServer, cdp });
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printText(summary);
  }
  if (!summary.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(redactText(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
