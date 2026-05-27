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
const MCP_RESOURCE_URI = "codex-parity://resource/ping";
const MCP_BLOB_RESOURCE_URI = "codex-parity://resource/blob";
const MCP_BLOB_RESOURCE_BASE64 = "Y29kZXgtcGFyaXR5LXJlc291cmNlLWJsb2I=";

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
  return redactKeyValueFields(
    redactKeyValueFields(
      String(value ?? "")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
        .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
        .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, "<jwt-redacted>")
        .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "<private-key-redacted>")
        .replace(/https?:\/\/[^\s"',)]+/g, "<url-redacted>")
        .replace(/\bdata:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "data:image/<redacted>")
        .replace(/\bchrome-extension:\/\/[a-p]{32}\/?/g, "chrome-extension://<extension-id>/"),
      String.raw`(?:qr|pairing|device|client|installation|environment|key)[_-]?(?:code|id|secret|token|payload|fingerprint|key)`,
    ),
    String.raw`(?:screenshot|browserTab|tabTitle|tabUrl|conversationText|threadPreview)`,
  );
}

function redactKeyValueFields(input, fieldNamePattern) {
  return input
    .replace(
      new RegExp(`(["'])\\b(${fieldNamePattern})\\b\\1\\s*([:=])\\s*(["'])(?:\\\\.|(?!\\4)[\\s\\S])*\\4`, "gi"),
      (_match, keyQuote, key, separator, valueQuote) => `${keyQuote}${key}${keyQuote}${separator}${valueQuote}<redacted>${valueQuote}`,
    )
    .replace(
      new RegExp(`(["'])\\b(${fieldNamePattern})\\b\\1\\s*([:=])\\s*[^"',\\s}\\]]+`, "gi"),
      (_match, keyQuote, key, separator) => `${keyQuote}${key}${keyQuote}${separator}<redacted>`,
    )
    .replace(
      new RegExp(`\\b(${fieldNamePattern})\\b\\s*([:=])\\s*(["'])(?:\\\\.|(?!\\3)[\\s\\S])*\\3`, "gi"),
      (_match, key, separator, valueQuote) => `${key}${separator}${valueQuote}<redacted>${valueQuote}`,
    )
    .replace(
      new RegExp(`\\b(${fieldNamePattern})\\b\\s*([:=])\\s*[^"',\\s}\\]]+`, "gi"),
      (_match, key, separator) => `${key}${separator}<redacted>`,
    );
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

function findExecutable(name) {
  if (name.includes(path.sep)) {
    return fs.existsSync(name) ? name : null;
  }
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue scanning PATH.
    }
  }
  return null;
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

function createSkillConfigFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-skill-config-"));
  const repoDir = path.join(fixtureDir, "repo");
  const skillName = "codex-parity-toggle-skill";
  const skillDir = path.join(repoDir, ".codex", "skills", skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  for (const directory of ["codex-home", "home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache"]) {
    fs.mkdirSync(path.join(fixtureDir, directory), { recursive: true });
  }
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${skillName}`,
      "description: Temporary desktop parity skill config fixture.",
      "---",
      "",
      "# Codex Parity Toggle Skill",
      "",
    ].join("\n"),
    "utf8",
  );
  return {
    codexHome: path.join(fixtureDir, "codex-home"),
    fixtureDir,
    repoDir,
    skillName,
  };
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

function createPluginInstallFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-plugin-install-"));
  const repoDir = path.join(fixtureDir, "repo");
  const marketplaceDir = path.join(repoDir, ".agents", "plugins");
  const marketplacePath = path.join(marketplaceDir, "marketplace.json");
  const pluginName = "codex-parity-plugin";
  const pluginDir = path.join(repoDir, "plugins", pluginName);
  const skillDir = path.join(pluginDir, "skills", "codex-parity-plugin-skill");

  fs.mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  for (const directory of ["codex-home", "home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache"]) {
    fs.mkdirSync(path.join(fixtureDir, directory), { recursive: true });
  }

  fs.writeFileSync(
    path.join(pluginDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({
      name: pluginName,
      version: "0.0.0",
      description: "Temporary desktop parity plugin fixture.",
      author: { name: "Codex Parity" },
      license: "MIT",
      skills: "./skills/",
      interface: {
        displayName: "Codex Parity Plugin",
        shortDescription: "Temporary desktop parity plugin fixture.",
        longDescription: "Temporary desktop parity plugin fixture.",
        developerName: "Codex Parity",
        category: "Engineering",
        capabilities: ["Read"],
        screenshots: [],
      },
    }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: codex-parity-plugin-skill",
      "description: Temporary plugin install parity fixture skill.",
      "---",
      "",
      "# Codex Parity Plugin Skill",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.writeFileSync(
    marketplacePath,
    JSON.stringify({
      name: "codex-parity-marketplace",
      interface: { displayName: "Codex Parity Marketplace" },
      plugins: [{
        name: pluginName,
        source: { source: "local", path: `./plugins/${pluginName}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Engineering",
      }],
    }, null, 2) + "\n",
    "utf8",
  );

  return {
    codexHome: path.join(fixtureDir, "codex-home"),
    fixtureDir,
    marketplacePath,
    pluginName,
    repoDir,
  };
}

function createMcpServerFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-mcp-live-"));
  const serverPath = path.join(fixtureDir, "server.js");
  fs.writeFileSync(
    serverPath,
    [
      "#!/usr/bin/env node",
      '"use strict";',
      'const readline = require("node:readline");',
      `const TEXT_RESOURCE_URI = ${JSON.stringify(MCP_RESOURCE_URI)};`,
      `const BLOB_RESOURCE_URI = ${JSON.stringify(MCP_BLOB_RESOURCE_URI)};`,
      "const rl = readline.createInterface({ input: process.stdin });",
      "function send(message) {",
      '  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");',
      "}",
      'rl.on("line", (line) => {',
      "  let message;",
      "  try { message = JSON.parse(line); } catch { return; }",
      '  if (!Object.prototype.hasOwnProperty.call(message, "id")) return;',
      '  if (message.method === "initialize") {',
      "    send({",
      "      id: message.id,",
      "      result: {",
      '        protocolVersion: message.params?.protocolVersion || "2024-11-05",',
      "        capabilities: { resources: {}, tools: {} },",
      '        serverInfo: { name: "codex-parity-mcp", version: "0.0.0" },',
      "      },",
      "    });",
      '  } else if (message.method === "resources/list") {',
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        resources: [{",
      "          uri: TEXT_RESOURCE_URI,",
      '          name: "codex-parity-resource",',
      '          description: "Read-only desktop parity fixture resource.",',
      '          mimeType: "text/plain",',
      "        }, {",
      "          uri: BLOB_RESOURCE_URI,",
      '          name: "codex-parity-blob-resource",',
      '          description: "Read-only binary desktop parity fixture resource.",',
      '          mimeType: "application/octet-stream",',
      "        }],",
      "      },",
      "    });",
      "  } else if (message.method === \"resources/read\" && message.params?.uri === TEXT_RESOURCE_URI) {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        contents: [{",
      "          uri: message.params.uri,",
      '          mimeType: "text/plain",',
      '          text: "codex-parity-resource-pong",',
      "        }],",
      "      },",
      "    });",
      "  } else if (message.method === \"resources/read\" && message.params?.uri === BLOB_RESOURCE_URI) {",
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        contents: [{",
      "          uri: message.params.uri,",
      '          mimeType: "application/octet-stream",',
      `          blob: ${JSON.stringify(MCP_BLOB_RESOURCE_BASE64)},`,
      "        }],",
      "      },",
      "    });",
      '  } else if (message.method === "tools/list") {',
      "    send({",
      "      id: message.id,",
      "      result: {",
      "        tools: [{",
      '          name: "codex_parity_ping",',
      '          description: "No-op desktop parity fixture tool.",',
      '          inputSchema: { type: "object", properties: {}, additionalProperties: false },',
      "        }],",
      "      },",
      "    });",
      '  } else if (message.method === "tools/call" && message.params?.name === "codex_parity_ping") {',
      "    send({",
      "      id: message.id,",
      "      result: {",
      '        content: [{ type: "text", text: "codex-parity-pong" }],',
      "        structuredContent: { ok: true },",
      "      },",
      "    });",
      "  } else {",
      '    send({ id: message.id, error: { code: -32601, message: "method not found" } });',
      "  }",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(serverPath, 0o755);
  return { fixtureDir, serverPath };
}

function removeFixture(fixtureDir) {
  if (fixtureDir) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
}

class AppServerClient {
  constructor({ codexBin, command = codexBin, args = null, cwd = REPO_DIR, extraArgs = [], env = process.env }) {
    const childArgs = args ?? ["app-server", "--remote-control", ...extraArgs];
    this.child = spawn(command, childArgs, {
      cwd,
      env: { ...env, NO_COLOR: "1" },
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
        const detail = this.stderr ? `: ${summarizeErrorText(this.stderr)}` : "";
        this.failAll(new Error(`app-server exited early with code=${code} signal=${signal}${detail}`));
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

function summarizePluginInstalled(result) {
  const marketplaces = Array.isArray(result.marketplaces) ? result.marketplaces : [];
  let pluginCount = 0;
  let installedCount = 0;
  for (const marketplace of marketplaces) {
    for (const plugin of Array.isArray(marketplace?.plugins) ? marketplace.plugins : []) {
      pluginCount += 1;
      if (plugin?.installed === true) {
        installedCount += 1;
      }
    }
  }
  return {
    installed: installedCount,
    loadErrors: safeArrayLength(result.marketplaceLoadErrors) || 0,
    marketplaces: marketplaces.length,
    plugins: pluginCount,
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

function summarizeMcpStatus(result) {
  const entries = Array.isArray(result.data) ? result.data : [];
  const fixture = entries.find((entry) => entry && entry.name === "codex_parity_mcp");
  const tools = hasObject(fixture?.tools) ? Object.keys(fixture.tools) : [];
  return {
    count: entries.length,
    fixturePresent: fixture != null,
    fixtureToolPresent: tools.includes("codex_parity_ping"),
    hasNextCursor: !!result.nextCursor,
  };
}

function extractThreadId(result) {
  const thread = hasObject(result.thread) ? result.thread : null;
  return typeof thread?.id === "string" && thread.id.length > 0 ? thread.id : null;
}

function summarizeMcpToolCall(result) {
  const content = Array.isArray(result.content) ? result.content : [];
  const textContent = content.filter((item) => item && item.type === "text" && typeof item.text === "string");
  return {
    contentCount: content.length,
    isError: result.isError === true,
    structuredOk: hasObject(result.structuredContent) && result.structuredContent.ok === true,
    textPongObserved: textContent.some((item) => item.text === "codex-parity-pong"),
  };
}

function summarizeMcpResourceRead(result) {
  const contents = Array.isArray(result.contents) ? result.contents : [];
  const textContents = contents.filter((item) => item && typeof item.text === "string");
  const blobContents = contents.filter((item) => item && typeof item.blob === "string");
  return {
    blobContentCount: blobContents.length,
    blobMimeTypeObserved: blobContents.some((item) => item.mimeType === "application/octet-stream"),
    blobObserved: blobContents.some((item) => item.blob === MCP_BLOB_RESOURCE_BASE64),
    blobUriObserved: contents.some((item) => item && item.uri === MCP_BLOB_RESOURCE_URI),
    contentCount: contents.length,
    textContentCount: textContents.length,
    mimeTypeObserved: textContents.some((item) => item.mimeType === "text/plain"),
    textPongObserved: textContents.some((item) => item.text === "codex-parity-resource-pong"),
    textUriObserved: contents.some((item) => item && item.uri === MCP_RESOURCE_URI),
  };
}

function summarizeModelProviderCapabilities(result) {
  return {
    imageGenerationKnown: typeof result.imageGeneration === "boolean",
    namespaceToolsKnown: typeof result.namespaceTools === "boolean",
    webSearchKnown: typeof result.webSearch === "boolean",
  };
}

function summarizeExperimentalFeatures(result) {
  const features = Array.isArray(result.data) ? result.data : [];
  return {
    count: features.length,
    defaultEnabled: features.filter((feature) => feature?.defaultEnabled === true).length,
    enabled: features.filter((feature) => feature?.enabled === true).length,
    hasNextCursor: !!result.nextCursor,
  };
}

function summarizePermissionProfiles(result) {
  return {
    count: safeArrayLength(result.data),
    hasNextCursor: !!result.nextCursor,
  };
}

function summarizeCollaborationModes(result) {
  return {
    count: safeArrayLength(result.data),
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

function summarizeRemoteE2e({ remoteStatusRead, remoteStatusNotification }) {
  const read = summarizeRemoteStatus(remoteStatusRead);
  const notification = summarizeRemoteStatus(remoteStatusNotification);
  return {
    browserBridgeStatusKnown: true,
    computerUseBridgeStatusKnown: true,
    notificationObserved: notification != null,
    remoteHostAvailable: read != null,
    status: read?.status || notification?.status || "unknown",
    statusReadObserved: read != null,
  };
}

function findPluginSummary(result, pluginName) {
  for (const marketplace of Array.isArray(result.marketplaces) ? result.marketplaces : []) {
    for (const plugin of Array.isArray(marketplace.plugins) ? marketplace.plugins : []) {
      if (plugin?.name === pluginName) {
        return {
          idPresent: typeof plugin.id === "string" && plugin.id.length > 0,
          installed: plugin.installed === true,
          marketplacePresent: typeof marketplace.name === "string" && marketplace.name.length > 0,
          pluginId: plugin.id,
        };
      }
    }
  }
  return null;
}

function findRepoSkillSummary(result, cwd, skillName) {
  const cwdEntries = Array.isArray(result.data) ? result.data : [];
  const fixtureEntry = cwdEntries.find((entry) => entry && entry.cwd === cwd);
  const skills = Array.isArray(fixtureEntry?.skills) ? fixtureEntry.skills : [];
  return skills.find((skill) => skill && skill.name === skillName) || null;
}

function summarizePluginRead(result) {
  const plugin = hasObject(result.plugin) ? result.plugin : {};
  const summary = hasObject(plugin.summary) ? plugin.summary : {};
  return {
    appsEmpty: safeArrayLength(plugin.apps) === 0,
    hooksEmpty: safeArrayLength(plugin.hooks) === 0,
    marketplaceNamePresent: typeof plugin.marketplaceName === "string" && plugin.marketplaceName.length > 0,
    mcpServersEmpty: safeArrayLength(plugin.mcpServers) === 0,
    skillsArrayKnown: Array.isArray(plugin.skills),
    summaryInstalledKnown: typeof summary.installed === "boolean",
    summaryPresent: hasObject(plugin.summary),
  };
}

async function runSkillConfigFixtureSmoke({ codexBin }) {
  const fixture = createSkillConfigFixture();
  const isolatedEnv = {
    ...process.env,
    CODEX_HOME: fixture.codexHome,
    HOME: path.join(fixture.fixtureDir, "home"),
    XDG_CACHE_HOME: path.join(fixture.fixtureDir, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(fixture.fixtureDir, "xdg-config"),
    XDG_DATA_HOME: path.join(fixture.fixtureDir, "xdg-data"),
    XDG_STATE_HOME: path.join(fixture.fixtureDir, "xdg-state"),
  };

  try {
    const client = new AppServerClient({
      codexBin,
      cwd: fixture.repoDir,
      env: isolatedEnv,
    });
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "codex_linux_desktop_skill_config_fixture",
          title: "Codex Linux Desktop Skill Config Fixture",
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
      client.notify("initialized", {});

      const before = findRepoSkillSummary(
        await client.request("skills/list", { cwds: [fixture.repoDir], forceReload: true }),
        fixture.repoDir,
        fixture.skillName,
      );
      const disabled = await client.request("skills/config/write", {
        enabled: false,
        name: fixture.skillName,
      });
      const afterDisable = findRepoSkillSummary(
        await client.request("skills/list", { cwds: [fixture.repoDir], forceReload: true }),
        fixture.repoDir,
        fixture.skillName,
      );
      const enabled = await client.request("skills/config/write", {
        enabled: true,
        name: fixture.skillName,
      });
      const afterEnable = findRepoSkillSummary(
        await client.request("skills/list", { cwds: [fixture.repoDir], forceReload: true }),
        fixture.repoDir,
        fixture.skillName,
      );

      const details = {
        disabledAfterWrite: afterDisable?.enabled === false,
        disableEffectiveFalse: disabled.effectiveEnabled === false,
        enableEffectiveTrue: enabled.effectiveEnabled === true,
        enabledAfterWrite: afterEnable?.enabled === true,
        enabledBeforeWrite: before?.enabled === true,
        fixturePresent: before != null && afterDisable != null && afterEnable != null,
        isolatedCodexHome: isolatedEnv.CODEX_HOME === fixture.codexHome,
        repoScoped: before?.scope === "repo" && afterDisable?.scope === "repo" && afterEnable?.scope === "repo",
      };
      return {
        details,
        status: Object.values(details).every((value) => value === true) ? "pass" : "fail",
      };
    } finally {
      await client.close();
    }
  } catch (error) {
    return {
      details: { error: summarizeErrorText(error.message) },
      status: "fail",
    };
  } finally {
    removeFixture(fixture.fixtureDir);
  }
}

async function runPluginInstallFixtureSmoke({ codexBin }) {
  const fixture = createPluginInstallFixture();
  const pluginListParams = { cwds: [fixture.repoDir], marketplaceKinds: ["local"] };
  const pluginInstalledParams = {
    cwds: [fixture.repoDir],
    installSuggestionPluginNames: [fixture.pluginName],
  };
  const isolatedEnv = {
    ...process.env,
    CODEX_HOME: fixture.codexHome,
    HOME: path.join(fixture.fixtureDir, "home"),
    XDG_CACHE_HOME: path.join(fixture.fixtureDir, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(fixture.fixtureDir, "xdg-config"),
    XDG_DATA_HOME: path.join(fixture.fixtureDir, "xdg-data"),
    XDG_STATE_HOME: path.join(fixture.fixtureDir, "xdg-state"),
  };

  try {
    const client = new AppServerClient({
      codexBin,
      cwd: fixture.repoDir,
      env: isolatedEnv,
    });
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "codex_linux_desktop_plugin_fixture",
          title: "Codex Linux Desktop Plugin Fixture",
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
      client.notify("initialized", {});

      const before = findPluginSummary(await client.request("plugin/list", pluginListParams), fixture.pluginName);
      const installedBefore = findPluginSummary(
        await client.request("plugin/installed", pluginInstalledParams),
        fixture.pluginName,
      );
      const pluginRead = summarizePluginRead(await client.request("plugin/read", {
        marketplacePath: fixture.marketplacePath,
        pluginName: fixture.pluginName,
        remoteMarketplaceName: null,
      }));
      const install = await client.request("plugin/install", {
        marketplacePath: fixture.marketplacePath,
        pluginName: fixture.pluginName,
        remoteMarketplaceName: null,
      });
      const after = findPluginSummary(await client.request("plugin/list", pluginListParams), fixture.pluginName);
      const installedAfter = findPluginSummary(
        await client.request("plugin/installed", pluginInstalledParams),
        fixture.pluginName,
      );
      if (!after?.pluginId) {
        return {
          details: {
            afterInstallPresent: false,
            isolatedCodexHome: isolatedEnv.CODEX_HOME === fixture.codexHome,
            notInstalledBeforeInstall: before?.installed === false,
          },
          status: "fail",
        };
      }

      await client.request("plugin/uninstall", { pluginId: after.pluginId });
      const final = findPluginSummary(await client.request("plugin/list", pluginListParams), fixture.pluginName);
      const installedFinal = findPluginSummary(
        await client.request("plugin/installed", pluginInstalledParams),
        fixture.pluginName,
      );
      const details = {
        appsNeedingAuthCount: safeArrayLength(install.appsNeedingAuth),
        authPolicyOnUse: install.authPolicy === "ON_USE",
        fixturePresent: before != null && after != null && final != null,
        installedSummaryAfterInstall: installedAfter?.installed === true,
        installedSummaryBeforeInstall: installedBefore?.installed === false,
        installedSummaryFinalUninstalled: installedFinal?.installed === false,
        installedAfterInstall: after.installed === true,
        isolatedCodexHome: isolatedEnv.CODEX_HOME === fixture.codexHome,
        notInstalledBeforeInstall: before?.installed === false,
        pluginIdPresent: before?.idPresent === true && after.idPresent === true && final?.idPresent === true,
        pluginReadAppsEmpty: pluginRead.appsEmpty === true,
        pluginReadHooksEmpty: pluginRead.hooksEmpty === true,
        pluginReadMarketplaceNamePresent: pluginRead.marketplaceNamePresent === true,
        pluginReadMcpServersEmpty: pluginRead.mcpServersEmpty === true,
        pluginReadSkillsArrayKnown: pluginRead.skillsArrayKnown === true,
        pluginReadSummaryInstalledKnown: pluginRead.summaryInstalledKnown === true,
        pluginReadSummaryPresent: pluginRead.summaryPresent === true,
        uninstalledAfterUninstall: final?.installed === false,
      };
      return {
        details,
        status: Object.values(details).every((value) => value === true || value === 0) ? "pass" : "fail",
      };
    } finally {
      await client.close();
    }
  } catch (error) {
    return {
      details: { error: summarizeErrorText(error.message) },
      status: "fail",
    };
  } finally {
    removeFixture(fixture.fixtureDir);
  }
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

function createRequirementsFixture() {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-parity-requirements-"));
  const etcCodexDir = path.join(fixtureDir, "etc-codex");
  fs.mkdirSync(etcCodexDir, { recursive: true });
  for (const directory of ["codex-home", "home", "xdg-config", "xdg-data", "xdg-state", "xdg-cache"]) {
    fs.mkdirSync(path.join(fixtureDir, directory), { recursive: true });
  }
  fs.writeFileSync(
    path.join(etcCodexDir, "requirements.toml"),
    [
      'allowed_sandbox_modes = ["read-only", "workspace-write"]',
      'allowed_approval_policies = ["never"]',
      'allowed_approvals_reviewers = ["user"]',
      'allowed_web_search_modes = ["cached"]',
      "allow_managed_hooks_only = true",
      "",
      "[computer_use]",
      "allow_locked_computer_use = false",
      "",
      "[features]",
      "apps = false",
      "",
      "[experimental_network]",
      "enabled = true",
      "managed_allowed_domains_only = true",
      "allow_local_binding = false",
      "",
      "[experimental_network.domains]",
      '"api.example.com" = "allow"',
      '"blocked.example.com" = "deny"',
      "",
    ].join("\n"),
    "utf8",
  );
  return { etcCodexDir, fixtureDir };
}

function bwrapAppServerCommand({ codexBin, fixtureDir, etcCodexDir }) {
  const bwrap = findExecutable("bwrap");
  if (!bwrap || process.platform !== "linux") {
    return null;
  }

  const args = [
    "--ro-bind",
    "/",
    "/",
    "--bind",
    fixtureDir,
    fixtureDir,
    "--tmpfs",
    "/etc",
  ];
  for (const file of ["/etc/passwd", "/etc/group", "/etc/hosts", "/etc/resolv.conf"]) {
    if (fs.existsSync(file)) {
      args.push("--ro-bind", file, file);
    }
  }
  args.push("--ro-bind", etcCodexDir, "/etc/codex", "--", codexBin, "app-server", "--remote-control");
  return { args, command: bwrap };
}

function summarizeRequirementsFixture(result) {
  const requirements = hasObject(result.requirements) ? result.requirements : null;
  const network = hasObject(requirements?.network) ? requirements.network : {};
  const features = hasObject(requirements?.featureRequirements) ? requirements.featureRequirements : {};
  const computerUse = hasObject(requirements?.computerUse) ? requirements.computerUse : {};
  return {
    allowedApprovalPolicies: Array.isArray(requirements?.allowedApprovalPolicies)
      ? requirements.allowedApprovalPolicies
      : [],
    allowedSandboxModes: Array.isArray(requirements?.allowedSandboxModes)
      ? requirements.allowedSandboxModes
      : [],
    allowedWebSearchModes: Array.isArray(requirements?.allowedWebSearchModes)
      ? requirements.allowedWebSearchModes
      : [],
    allowLockedComputerUse: computerUse.allowLockedComputerUse === false ? false : null,
    allowManagedHooksOnly: requirements?.allowManagedHooksOnly === true,
    appsFeaturePinnedOff: features.apps === false,
    managedAllowedDomainsOnly: network.managedAllowedDomainsOnly === true,
    networkEnabled: network.enabled === true,
  };
}

function requirementsFixturePassed(details) {
  return (
    details.allowManagedHooksOnly === true &&
    details.allowLockedComputerUse === false &&
    details.appsFeaturePinnedOff === true &&
    details.networkEnabled === true &&
    details.managedAllowedDomainsOnly === true &&
    details.allowedApprovalPolicies.includes("never") &&
    details.allowedSandboxModes.includes("read-only") &&
    details.allowedSandboxModes.includes("workspace-write") &&
    details.allowedWebSearchModes.includes("cached") &&
    details.allowedWebSearchModes.includes("disabled")
  );
}

async function runRequirementsFixtureSmoke({ codexBin }) {
  const fixture = createRequirementsFixture();
  try {
    const wrapped = bwrapAppServerCommand({
      codexBin,
      etcCodexDir: fixture.etcCodexDir,
      fixtureDir: fixture.fixtureDir,
    });
    if (!wrapped) {
      return {
        details: { reason: "bwrap unavailable; skipping isolated /etc/codex fixture" },
        status: "skip",
      };
    }

    const client = new AppServerClient({
      codexBin,
      command: wrapped.command,
      args: wrapped.args,
      env: {
        ...process.env,
        CODEX_HOME: path.join(fixture.fixtureDir, "codex-home"),
        HOME: path.join(fixture.fixtureDir, "home"),
        XDG_CACHE_HOME: path.join(fixture.fixtureDir, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(fixture.fixtureDir, "xdg-config"),
        XDG_DATA_HOME: path.join(fixture.fixtureDir, "xdg-data"),
        XDG_STATE_HOME: path.join(fixture.fixtureDir, "xdg-state"),
      },
    });
    try {
      await client.request("initialize", {
        clientInfo: {
          name: "codex_linux_desktop_requirements_fixture",
          title: "Codex Linux Desktop Requirements Fixture",
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
      client.notify("initialized", {});
      const result = await client.request("configRequirements/read", {});
      const details = summarizeRequirementsFixture(result);
      return {
        details,
        status: requirementsFixturePassed(details) ? "pass" : "fail",
      };
    } finally {
      await client.close();
    }
  } catch (error) {
    const message = summarizeErrorText(error.message);
    return {
      details: { error: message },
      status: /operation not permitted|no permissions|permission denied|user namespace/i.test(message)
        ? "skip"
        : "fail",
    };
  } finally {
    removeFixture(fixture.fixtureDir);
  }
}

async function runAppServerSmoke(options) {
  const mcpFixture = createMcpServerFixture();
  const client = new AppServerClient({
    codexBin: options.codexBin,
    extraArgs: [
      "-c",
      `mcp_servers.codex_parity_mcp.command=${JSON.stringify(process.execPath)}`,
      "-c",
      `mcp_servers.codex_parity_mcp.args=[${JSON.stringify(mcpFixture.serverPath)}]`,
      "-c",
      "mcp_servers.codex_parity_mcp.startup_timeout_sec=3",
      "-c",
      "mcp_servers.codex_parity_mcp.tool_timeout_sec=3",
      "-c",
      'mcp_servers.codex_parity_mcp.enabled_tools=["codex_parity_ping"]',
    ],
  });
  const checks = [];
  let mcpThreadId = null;

  const record = (name, status, details = {}) => {
    checks.push({ name, status, details });
  };

  const ensureMcpThread = async () => {
    if (mcpThreadId) {
      return mcpThreadId;
    }
    const threadStart = await client.request("thread/start", {
      approvalPolicy: "never",
      cwd: REPO_DIR,
      ephemeral: true,
      sandbox: "read-only",
    });
    mcpThreadId = extractThreadId(threadStart);
    return mcpThreadId;
  };

  try {
    const requirementsFixture = await runRequirementsFixtureSmoke({ codexBin: options.codexBin });
    record("managed requirements fixture", requirementsFixture.status, requirementsFixture.details);

    const pluginInstallFixture = await runPluginInstallFixtureSmoke({ codexBin: options.codexBin });
    record("isolated plugin install fixture", pluginInstallFixture.status, pluginInstallFixture.details);

    const skillConfigFixture = await runSkillConfigFixtureSmoke({ codexBin: options.codexBin });
    record("isolated skill config fixture", skillConfigFixture.status, skillConfigFixture.details);

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
        name: "installed plugin summary",
        method: "plugin/installed",
        params: { cwds: [REPO_DIR], installSuggestionPluginNames: [] },
        summarize: summarizePluginInstalled,
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
        summarize: summarizeMcpStatus,
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
        name: "model provider capabilities",
        method: "modelProvider/capabilities/read",
        params: {},
        summarize: summarizeModelProviderCapabilities,
      },
      {
        name: "experimental feature list",
        method: "experimentalFeature/list",
        params: { limit: 50 },
        summarize: summarizeExperimentalFeatures,
      },
      {
        name: "permission profile list",
        method: "permissionProfile/list",
        params: { cwd: REPO_DIR, limit: 50 },
        summarize: summarizePermissionProfiles,
      },
      {
        name: "collaboration mode list",
        method: "collaborationMode/list",
        params: {},
        summarize: summarizeCollaborationModes,
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
        } else if (probe.method === "plugin/installed" && details.loadErrors > 0) {
          record(probe.name, "fail", details);
        } else if (
          probe.method === "mcpServerStatus/list" &&
          (!details.fixturePresent || !details.fixtureToolPresent)
        ) {
          record(probe.name, "fail", details);
        } else if (
          probe.method === "modelProvider/capabilities/read" &&
          (!details.imageGenerationKnown || !details.namespaceToolsKnown || !details.webSearchKnown)
        ) {
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

    try {
      const threadId = await ensureMcpThread();
      if (!threadId) {
        record("mcp tool call fixture", "fail", { threadStarted: false });
      } else {
        const toolCall = await client.request("mcpServer/tool/call", {
          arguments: {},
          server: "codex_parity_mcp",
          threadId,
          tool: "codex_parity_ping",
        });
        const details = summarizeMcpToolCall(toolCall);
        record(
          "mcp tool call fixture",
          details.contentCount > 0 &&
            details.isError === false &&
            details.structuredOk === true &&
            details.textPongObserved === true
            ? "pass"
            : "fail",
          {
            contentCount: details.contentCount,
            isError: details.isError,
            structuredOk: details.structuredOk,
            textPongObserved: details.textPongObserved,
            threadStarted: true,
          },
        );
      }
    } catch (error) {
      record("mcp tool call fixture", "fail", { error: summarizeErrorText(error.message) });
    }

    try {
      const threadId = await ensureMcpThread();
      if (!threadId) {
        record("mcp resource read fixture", "fail", { threadStarted: false });
      } else {
        const textResourceRead = await client.request("mcpServer/resource/read", {
          server: "codex_parity_mcp",
          threadId,
          uri: MCP_RESOURCE_URI,
        });
        const blobResourceRead = await client.request("mcpServer/resource/read", {
          server: "codex_parity_mcp",
          threadId,
          uri: MCP_BLOB_RESOURCE_URI,
        });
        const details = summarizeMcpResourceRead({
          contents: [
            ...(Array.isArray(textResourceRead.contents) ? textResourceRead.contents : []),
            ...(Array.isArray(blobResourceRead.contents) ? blobResourceRead.contents : []),
          ],
        });
        record(
          "mcp resource read fixture",
          details.textContentCount > 0 &&
            details.blobContentCount > 0 &&
            details.mimeTypeObserved === true &&
            details.textPongObserved === true &&
            details.textUriObserved === true &&
            details.blobMimeTypeObserved === true &&
            details.blobObserved === true &&
            details.blobUriObserved === true
            ? "pass"
            : "fail",
          {
            blobContentCount: details.blobContentCount,
            blobMimeTypeObserved: details.blobMimeTypeObserved,
            blobObserved: details.blobObserved,
            blobUriObserved: details.blobUriObserved,
            contentCount: details.contentCount,
            mimeTypeObserved: details.mimeTypeObserved,
            textContentCount: details.textContentCount,
            textPongObserved: details.textPongObserved,
            threadStarted: true,
            textUriObserved: details.textUriObserved,
          },
        );
      }
    } catch (error) {
      record("mcp resource read fixture", "fail", { error: summarizeErrorText(error.message) });
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

    const remoteE2e = summarizeRemoteE2e({
      remoteStatusRead: remoteStatusReadResult,
      remoteStatusNotification,
    });
    record(
      "remote redacted e2e summary",
      options.requireRemoteConnected && remoteE2e.status !== "connected" ? "fail" : "pass",
      remoteE2e,
    );

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
    removeFixture(mcpFixture.fixtureDir);
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

module.exports = {
  redactText,
  summarizeErrorText,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(redactText(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
