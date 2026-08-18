#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  applySharedAppServerSocketPatch,
  descriptors,
  sharedTransportClassSource,
} = require("./patch.js");

const socketEnvHook = path.join(__dirname, "socket-env.sh");
const orphanReaper = path.join(__dirname, "orphan-reaper.js");
const unixSocketPathMaxBytes = 107;

function makeSocketTempDir(prefix, socketRelativePath = "app-server.sock") {
  for (const root of [...new Set([os.tmpdir(), "/tmp"])]) {
    const template = path.join(root, prefix);
    const longestGeneratedPath = path.join(`${template}XXXXXX`, socketRelativePath);
    if (Buffer.byteLength(longestGeneratedPath) <= unixSocketPathMaxBytes) {
      return fs.mkdtempSync(template);
    }
  }
  throw new Error("could not create a temporary directory with room for a Unix socket path");
}

function createProcessSnapshotFs(processesByPid) {
  const snapshotsByPid = new Map();
  const processForPath = (procPath) => {
    const match = procPath.match(/^\/proc\/(\d+)(?:\/(stat|cmdline))?$/);
    if (match == null) throw new Error(`unexpected proc path: ${procPath}`);
    const pid = Number(match[1]);
    const file = match[2];
    if (file == null) {
      const entry = processesByPid.get(pid);
      const processInfo = typeof entry === "function" ? entry() : entry;
      if (processInfo != null) snapshotsByPid.set(pid, processInfo);
    }
    const processInfo = snapshotsByPid.get(pid);
    if (processInfo == null) {
      const error = new Error(`process ${pid} does not exist`);
      error.code = "ENOENT";
      throw error;
    }
    return { processInfo, file };
  };

  return {
    statSync(procPath) {
      return { uid: processForPath(procPath).processInfo.uid };
    },
    readFileSync(procPath) {
      const { processInfo, file } = processForPath(procPath);
      if (file === "stat") {
        return `0 (${processInfo.comm ?? path.basename(processInfo.commandLine[0])}) ${processInfo.state} ${processInfo.ppid} ${Array(17)
          .fill("0")
          .join(" ")} ${processInfo.startTime}`;
      }
      if (file === "cmdline") return Buffer.from(`${processInfo.commandLine.join("\0")}\0`);
      throw new Error(`unexpected proc file read: ${procPath}`);
    },
  };
}

function loadOrphanReaperVerifier(processesByPid) {
  const source = fs.readFileSync(orphanReaper, "utf8");
  const verifierSource = source.replace(
    /reapOrphan\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/,
    "globalThis.orphanReaperVerifier = { verifiedOrphanTargets };\n",
  );
  assert.notEqual(verifierSource, source, "orphan reaper entrypoint must remain replaceable");

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const mockFs = createProcessSnapshotFs(processesByPid);
  const context = {
    process: {
      argv: [process.execPath, orphanReaper, "/test/app-server.sock"],
      getuid: () => uid,
    },
    require(id) {
      if (id === "node:fs") return mockFs;
      if (id === "node:path") return path;
      throw new Error(`unexpected orphan reaper dependency: ${id}`);
    },
  };
  vm.runInNewContext(verifierSource, context, { filename: orphanReaper });
  return context.orphanReaperVerifier.verifiedOrphanTargets;
}

function loadOrphanReaperAdoptionPredicate() {
  const source = fs.readFileSync(orphanReaper, "utf8");
  const predicateSource = source.replace(
    /reapOrphan\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/,
    "globalThis.orphanReaperAdoption = { readProcess, hasExpectedOrphanAdoption };\n",
  );
  assert.notEqual(predicateSource, source, "orphan reaper entrypoint must remain replaceable");

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const context = {
    process: {
      argv: [process.execPath, orphanReaper, "/test/app-server.sock"],
      getuid: () => uid,
    },
    require(id) {
      if (id === "node:fs") return fs;
      if (id === "node:path") return path;
      throw new Error(`unexpected orphan reaper dependency: ${id}`);
    },
  };
  vm.runInNewContext(predicateSource, context, { filename: orphanReaper });
  return context.orphanReaperAdoption;
}

const orphanReaperAdoption = loadOrphanReaperAdoptionPredicate();

function startOrphanReaperWithChangedAdopter() {
  const socketPath = "/test/app-server.sock";
  const lockPath = `${socketPath}.lock`;
  const lockContents = "99999999 1 2001 100\n";
  const uid = process.getuid();
  const authority = {
    pid: 2001,
    uid,
    state: "S",
    ppid: 1235,
    startTime: "100",
    comm: "codex",
    commandLine: ["/usr/bin/codex", "app-server", "--listen", `unix://${socketPath}`],
  };
  const validAdopter = {
    pid: 1235,
    uid,
    state: "S",
    ppid: 1,
    startTime: "99",
    comm: "systemd",
    commandLine: ["/nix/store/0123456789abcdef-systemd-257.6/lib/systemd/systemd", "--user"],
  };
  const changedAdopter = { ...validAdopter, ppid: 321 };
  let adopterReads = 0;
  const processesByPid = new Map([
    [authority.pid, authority],
    [validAdopter.pid, () => (adopterReads++ < 2 ? validAdopter : changedAdopter)],
  ]);
  const procFs = createProcessSnapshotFs(processesByPid);
  const socket = { dev: 1, ino: 2, uid, isSocket: () => true };
  const lock = { dev: 3, ino: 4 };
  const listenerInode = "9876";
  const signals = [];
  const mockFs = {
    openSync(filePath) {
      if (filePath === lockPath) return 17;
      throw new Error(`unexpected open: ${filePath}`);
    },
    fstatSync(descriptor) {
      if (descriptor === 17) return lock;
      throw new Error(`unexpected descriptor: ${descriptor}`);
    },
    closeSync() {},
    statSync: procFs.statSync,
    lstatSync(filePath) {
      if (filePath === socketPath) return socket;
      if (filePath === lockPath) return lock;
      const error = new Error(`missing path: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    },
    readFileSync(filePath) {
      if (filePath === 17 || filePath === lockPath) return lockContents;
      if (filePath === "/proc/net/unix") {
        return `0000000000000000: 00000002 00000000 00010000 0001 01 ${listenerInode} ${socketPath}\n`;
      }
      return procFs.readFileSync(filePath);
    },
    readdirSync(filePath) {
      if (filePath === "/proc") {
        return [{ name: String(authority.pid), isDirectory: () => true }];
      }
      if (filePath === `/proc/${authority.pid}/fd`) return ["5"];
      throw new Error(`unexpected directory read: ${filePath}`);
    },
    readlinkSync(filePath) {
      if (filePath === `/proc/${authority.pid}/fd/5`) return `socket:[${listenerInode}]`;
      throw new Error(`unexpected link read: ${filePath}`);
    },
  };
  const source = fs.readFileSync(orphanReaper, "utf8");
  const reaperSource = source.replace(
    /reapOrphan\(\)\.catch\(\(error\) => \{[\s\S]*?\n\}\);\s*$/,
    "globalThis.reaperPromise = reapOrphan();\n",
  );
  assert.notEqual(reaperSource, source, "orphan reaper entrypoint must remain replaceable");
  const context = {
    process: {
      argv: [process.execPath, orphanReaper, socketPath],
      getuid: () => uid,
      kill(pid, signal) {
        signals.push({ pid, signal });
        return true;
      },
    },
    console: { error() {} },
    require(id) {
      if (id === "node:fs") return mockFs;
      if (id === "node:path") return path;
      throw new Error(`unexpected orphan reaper dependency: ${id}`);
    },
  };
  vm.runInNewContext(reaperSource, context, { filename: orphanReaper });
  return { reaperPromise: context.reaperPromise, signals };
}

function authorityProcess({ pid, ppid }) {
  return {
    pid,
    uid: process.getuid(),
    state: "S",
    ppid,
    startTime: "100",
    commandLine: ["/usr/bin/codex", "app-server", "--listen", "unix:///test/app-server.sock"],
  };
}

function lockedAuthority(authority) {
  return {
    authorityPid: authority.pid,
    authorityStartTime: authority.startTime,
  };
}

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function waitForSocket(socketPath, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      throw new Error(`app-server exited before creating its socket (${child.exitCode})`);
    }
    try {
      if (fs.statSync(socketPath).isSocket()) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the app-server socket");
}

async function readWebSocketUpgrade(child) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for WebSocket upgrade")),
      5000,
    );
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks).toString("utf8");
      if (response.includes("\r\n\r\n")) finish(null, response);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
  });
}

async function stopChild(child) {
  if (child == null || child.exitCode != null || child.signalCode != null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await closed;
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return child;
}

function loadInjectedTransport({ spawnImpl, WebSocketImpl = null, fsImpl = fs, timeoutCapMs = null } = {}) {
  class DefaultWebSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      this.stream = options.createConnection();
      queueMicrotask(() => this.emit("open"));
    }

    terminate() {
      this.terminated = true;
      this.stream?.destroy();
    }
  }
  class Adapter {
    constructor(socket) {
      this.socket = socket;
    }
  }
  const namespace = {
    WS: WebSocketImpl ?? DefaultWebSocket,
    keepAlive() {},
    Adapter,
  };
  const source = sharedTransportClassSource({
    namespace: "n",
    webSocketClass: "WS",
    webSocketUrl: "url",
    keepAlive: "keepAlive",
    adapterClass: "Adapter",
  });
  const context = {
    n: namespace,
    url: "ws://localhost/rpc",
    process,
    console,
    require(id) {
      if (id === "node:child_process") return { spawn: spawnImpl };
      if (id === "node:fs") return fsImpl;
      return require(id);
    },
    setTimeout(callback, delay, ...args) {
      const timer = setTimeout(
        callback,
        timeoutCapMs == null ? delay : Math.min(delay, timeoutCapMs),
        ...args,
      );
      if (timeoutCapMs != null) timer.unref = () => timer;
      return timer;
    },
    clearTimeout,
  };
  vm.runInNewContext(`${source};globalThis.Transport=CodexLinuxSharedAppServerSocketTransport`, context);
  return { Transport: context.Transport, namespace };
}

async function listenUnix(socketPath) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function closeServer(server) {
  if (server == null) return;
  await new Promise((resolve) => server.close(resolve));
}

function processStartTime(pid) {
  try {
    const rawStat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = rawStat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return rawStat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function hasLegitimateOrphanAdoption(pid) {
  const authority = orphanReaperAdoption.readProcess(pid);
  return authority != null && orphanReaperAdoption.hasExpectedOrphanAdoption(authority);
}

function unixListenerInodes(socketPath) {
  const inodes = new Set();
  for (const line of fs.readFileSync("/proc/net/unix", "utf8").split("\n")) {
    const match = line.match(
      /^\S+:\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(\d+)(?:\s+(.*))?$/,
    );
    if (
      match != null &&
      match[1] === "0001" &&
      match[2] === "01" &&
      match[4] === socketPath
    ) {
      inodes.add(match[3]);
    }
  }
  return [...inodes];
}

async function waitForCondition(predicate, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function spawnOrphanAuthority(socketPath) {
  const listenerScript = [
    'const net=require("node:net");',
    'const socketPath=process.argv.at(-1).replace("unix://","");',
    "const server=net.createServer();",
    "server.listen(socketPath);",
    'process.on("SIGTERM",()=>server.close(()=>process.exit(0)));',
  ].join("");
  const wrapperScript = [
    'const {spawn}=require("node:child_process");',
    "const child=spawn(process.execPath,",
    '[ "-e",process.env.LISTENER_SCRIPT,"app-server","--listen",process.env.LISTEN_URL],',
    '{stdio:"ignore",env:process.env});',
    'process.on("SIGTERM",()=>{',
    '  try{child.kill("SIGTERM")}catch{}',
    "  child.once('exit',()=>process.exit(0));",
    "  setTimeout(()=>process.exit(0),1000).unref();",
    "});",
    "setInterval(()=>{},1000);",
  ].join("");
  const bootstrapScript = [
    'const {spawn}=require("node:child_process");',
    "const child=spawn(process.execPath,",
    '[ "-e",process.env.WRAPPER_SCRIPT,"app-server","--listen",process.env.LISTEN_URL],',
    '{detached:true,stdio:"ignore",env:process.env});',
    "process.stdout.write(`${child.pid}\\n`);",
    "child.unref();",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", bootstrapScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      LISTENER_SCRIPT: listenerScript,
      LISTEN_URL: `unix://${socketPath}`,
      WRAPPER_SCRIPT: wrapperScript,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const pid = Number(result.stdout.trim());
  assert.equal(Number.isSafeInteger(pid), true);
  const startTime = processStartTime(pid);
  assert.notEqual(startTime, null);
  await waitForCondition(
    () => hasLegitimateOrphanAdoption(pid) && fs.existsSync(socketPath),
    "detached authority to be adopted by PID 1 or the systemd user manager",
  );
  return { pid, startTime };
}

function syntheticBundle() {
  return [
    "var gC=class{options;kind=`websocket`;logger=i.i(`AppServerTransportSshWebsocket`);proxyStreams=new Set;hasConnected=!1;supportsReconnect(){return!0}",
    "async connect(){let t={current:null},r=new n.kn(qae,{perMessageDeflate:!1,createConnection:()=>",
    "(t.current=this.createSshProxyStream(),t.current)});r.once(`close`,()=>{t.current?.destroy()});try{await Xae(r)}catch(e){throw r.once(`error`,()=>void 0),t.current?.destroy(),r.terminate(),e}",
    "return n.Dn(r,{onPongTimeout:()=>{r.terminate()}}),this.hasConnected=!0,new n.On(r)}};",
    "function b5(e){let t=_C(e.hostConfig);if(t)return v5.info(`[ssh-websocket-v0] selected app-server transport`),new gC(t);",
    "if(e.transportKind===`remote-control`)return new Remote(e);",
    "if(n.no(e.hostConfig))return new hoe({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator});",
    "let r=x5(e.hostConfig);if(r){e.desktopAuthAppServerClient;let t=vbe(e.hostConfig,r);return new n.Tn({hostConfig:e.hostConfig,websocketUrl:r,getWebsocketProtocols:void 0,...t==null?{}:{socksProxyUrl:t}})}",
    "return new n.Cn({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator})}function afterFactory(){}",
  ].join("");
}

test("shared-app-server-socket stays disabled until explicitly enabled", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((entry) => entry.id),
      ["feature:shared-app-server-socket:main-process-shared-app-server-socket"],
    );
  });
});

test("feature stages its socket hooks and orphan reaper", () => {
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, path.basename(hook.target), hook.mode.toString(8)]),
        [
          ["launcher", "shared-app-server-socket-socket-env.sh", "755"],
          ["afterExit", "shared-app-server-socket-socket-cleanup.sh", "755"],
        ],
      );
      assert.deepEqual(
        plan.resources.map((resource) => [
          resource.target,
          resource.mode.toString(8),
        ]),
        [[
          ".codex-linux/features/shared-app-server-socket/orphan-reaper.js",
          "644",
        ]],
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("patch selects the bridge only for the local host and is idempotent", () => {
  const source = syntheticBundle();
  const patched = applySharedAppServerSocketPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applySharedAppServerSocketPatch(patched), patched);
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/);
  assert.match(patched, /hostConfig\.kind===`local`/);
  assert.match(patched, /app-server`,\s*`proxy`,\s*`--sock`/);
  assert.match(patched, /app-server`,\s*`--listen`,\s*`unix:\/\//);
  assert.match(patched, /await this\.ensureAuthority\(\)/);
  assert.match(patched, /e\.once\(`close`,t\);try\{e\.kill\(\)/);
  assert.match(patched, /openSync\(this\.lockPath,`wx`,384\)/);
  assert.match(patched, /\/proc\/\$\{e\}\/stat/);
  assert.match(patched, /reclaimStaleLock/);
  assert.match(patched, /this\.sameIdentity\(this\.socketIdentity,e\)/);
  assert.match(patched, /requires CODEX_CLI_PATH/);
  assert.match(patched, /new n\.kn\(qae,/);
  assert.match(patched, /new n\.On\(/);
  assert.match(patched, /supportsReconnect\(\)\{return!0\}/);
});

test("patch leaves unsupported bundle shapes unchanged with a warning", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch("unrelated bundle"), "unrelated bundle");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /shared app-server socket/i);
});

test("patch rejects the previous SSH transport class shape", () => {
  const source = syntheticBundle().replace(
    "class{options;kind=`websocket`;logger=i.i(`AppServerTransportSshWebsocket`);",
    "class{kind=`websocket`;",
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /SSH WebSocket transport/);
});

test("descriptor is optional and targets the main bundle", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["main-process-shared-app-server-socket", "main-bundle", "optional"]],
  );
});

test("socket hook exports an instance-scoped path without starting a process", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-runtime-"));
  const appDir = path.join(tempDir, "app");
  const env = {
    ...process.env,
    CODEX_LINUX_APP_DIR: appDir,
    CODEX_LINUX_APP_ID: "codex-bridge-test",
    CODEX_LINUX_APP_STATE_DIR: path.join(tempDir, "state"),
    XDG_RUNTIME_DIR: tempDir,
  };
  delete env.CODEX_CLI_PATH;
  delete env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET;
  try {
    const result = spawnSync(socketEnvHook, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      [
        `env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${tempDir}/codex-bridge-test/app-server-bridge/app-server.sock`,
        `env CODEX_CLI_PATH=${appDir}/resources/codex`,
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("socket hook preserves an explicit real Codex CLI path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-explicit-cli-"));
  const explicitCli = path.join(tempDir, "real codex");
  const env = {
    ...process.env,
    CODEX_CLI_PATH: explicitCli,
    CODEX_LINUX_APP_DIR: path.join(tempDir, "app"),
    CODEX_LINUX_APP_ID: "codex-bridge-test",
    CODEX_LINUX_APP_STATE_DIR: path.join(tempDir, "state"),
    XDG_RUNTIME_DIR: tempDir,
  };
  delete env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET;
  try {
    const result = spawnSync(socketEnvHook, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim().split("\n").at(-1),
      `env CODEX_CLI_PATH=${explicitCli}`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("socket hook emits no launcher environment during after-exit cleanup", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-after-exit-"));
  const env = {
    ...process.env,
    CODEX_LINUX_APP_ID: "codex-bridge-test",
    CODEX_LINUX_APP_STATE_DIR: path.join(tempDir, "state"),
    CODEX_LINUX_FEATURE_HOOK_PHASE: "after-exit",
    XDG_RUNTIME_DIR: tempDir,
  };
  delete env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET;
  try {
    const result = spawnSync(socketEnvHook, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orphan reaper preserves a live owner and its listener", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-live-reaper-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const selfStat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const selfStartTime = selfStat.slice(selfStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  const server = await listenUnix(socketPath);
  fs.writeFileSync(lockPath, `${process.pid} ${selfStartTime}\n`, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [orphanReaper, socketPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid} ${selfStartTime}\n`);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orphan reaper fails closed on an unknown live listener", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-foreign-reaper-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const server = await listenUnix(socketPath);
  const selfStartTime = processStartTime(process.pid);
  fs.writeFileSync(lockPath, `99999999 1 ${process.pid} ${selfStartTime}\n`, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [orphanReaper, socketPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not the expected reparented Codex process/);
    assert.equal(
      fs.readFileSync(lockPath, "utf8"),
      `99999999 1 ${process.pid} ${selfStartTime}\n`,
    );
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orphan reaper accepts an authority adopted directly by PID 1", () => {
  const authority = authorityProcess({ pid: 2001, ppid: 1 });
  const verifiedOrphanTargets = loadOrphanReaperVerifier(new Map([[authority.pid, authority]]));

  assert.deepEqual(
    Array.from(verifiedOrphanTargets(lockedAuthority(authority), [])).map((target) => target.pid),
    [authority.pid],
  );
});

test("orphan reaper accepts an authority adopted by the verified systemd user manager", () => {
  const adopter = {
    pid: 1235,
    uid: process.getuid(),
    state: "S",
    ppid: 1,
    startTime: "99",
    comm: "systemd",
    commandLine: ["/usr/lib/systemd/systemd", "--user", "--deserialize=10"],
  };
  const authority = authorityProcess({ pid: 2001, ppid: adopter.pid });
  const verifiedOrphanTargets = loadOrphanReaperVerifier(
    new Map([
      [authority.pid, authority],
      [adopter.pid, adopter],
    ]),
  );

  assert.deepEqual(
    Array.from(verifiedOrphanTargets(lockedAuthority(authority), [])).map((target) => target.pid),
    [authority.pid],
  );
});

test("orphan reaper accepts an authority adopted by a verified Nix systemd user manager", () => {
  const adopter = {
    pid: 1235,
    uid: process.getuid(),
    state: "S",
    ppid: 1,
    startTime: "99",
    comm: "systemd",
    commandLine: [
      "/nix/store/0123456789abcdef-systemd-257.6/lib/systemd/systemd",
      "--user",
      "--deserialize=10",
    ],
  };
  const authority = authorityProcess({ pid: 2001, ppid: adopter.pid });
  const verifiedOrphanTargets = loadOrphanReaperVerifier(
    new Map([
      [authority.pid, authority],
      [adopter.pid, adopter],
    ]),
  );

  assert.deepEqual(
    Array.from(verifiedOrphanTargets(lockedAuthority(authority), [])).map((target) => target.pid),
    [authority.pid],
  );
});

test("orphan reaper rejects every invalid systemd user manager adopter identity", () => {
  const validAdopter = {
    pid: 1235,
    uid: process.getuid(),
    state: "S",
    ppid: 1,
    startTime: "99",
    comm: "systemd",
    commandLine: ["/nix/store/0123456789abcdef-systemd-257.6/lib/systemd/systemd", "--user"],
  };
  const cases = [
    ["wrong uid", () => ({ ...validAdopter, uid: validAdopter.uid + 1 })],
    ["zombie", () => ({ ...validAdopter, state: "Z" })],
    ["missing", () => null],
    ["reused pid", () => {
      let reads = 0;
      return () => ({ ...validAdopter, startTime: reads++ === 0 ? "99" : "100" });
    }],
    ["non-init parent", () => ({ ...validAdopter, ppid: 321 })],
    ["wrong comm", () => ({ ...validAdopter, comm: "init" })],
    ["missing --user", () => ({ ...validAdopter, commandLine: [validAdopter.commandLine[0]] })],
    ["relative executable", () => ({ ...validAdopter, commandLine: ["systemd", "--user"] })],
    ["wrong executable basename", () => ({
      ...validAdopter,
      commandLine: ["/nix/store/0123456789abcdef-systemd-257.6/lib/systemd/systemd-wrapper", "--user"],
    })],
  ];

  for (const [description, makeAdopter] of cases) {
    const authority = authorityProcess({ pid: 2001, ppid: validAdopter.pid });
    const adopter = makeAdopter();
    const processes = new Map([[authority.pid, authority]]);
    if (adopter != null) processes.set(validAdopter.pid, adopter);
    const verifiedOrphanTargets = loadOrphanReaperVerifier(processes);

    assert.throws(
      () => verifiedOrphanTargets(lockedAuthority(authority), []),
      /not the expected reparented Codex process/,
      description,
    );
  }
});

test("orphan reaper rechecks adopter identity before signaling", async () => {
  const { reaperPromise, signals } = startOrphanReaperWithChangedAdopter();

  await assert.rejects(reaperPromise, /ownership changed during orphan verification/);
  assert.deepEqual(signals, []);
});

test("orphan reaper rejects an authority adopted by an unrelated live parent", () => {
  const adopter = {
    pid: 1235,
    uid: process.getuid(),
    state: "S",
    ppid: 1,
    startTime: "99",
    comm: "node",
    commandLine: ["/usr/bin/node", "supervisor.js"],
  };
  const authority = authorityProcess({ pid: 2001, ppid: adopter.pid });
  const verifiedOrphanTargets = loadOrphanReaperVerifier(
    new Map([
      [authority.pid, authority],
      [adopter.pid, adopter],
    ]),
  );

  assert.throws(
    () => verifiedOrphanTargets(lockedAuthority(authority), []),
    /not the expected reparented Codex process/,
  );
});

test("orphan reaper stops an exact reparented authority and removes stale ownership", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-orphan-reaper-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const orphan = await spawnOrphanAuthority(socketPath);
  fs.writeFileSync(lockPath, `99999999 1 ${orphan.pid} ${orphan.startTime}\n`, { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [orphanReaper, socketPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Stopped orphaned shared app-server authority/);
    await waitForCondition(
      () => processStartTime(orphan.pid) !== orphan.startTime,
      "orphaned authority to exit",
    );
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    if (processStartTime(orphan.pid) === orphan.startTime) {
      try {
        process.kill(orphan.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("orphan reaper refuses two live listener inodes for the same pathname", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-rebind-reaper-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const orphan = await spawnOrphanAuthority(socketPath);
  const lockContents = `99999999 1 ${orphan.pid} ${orphan.startTime}\n`;
  fs.writeFileSync(lockPath, lockContents, { mode: 0o600 });
  fs.unlinkSync(socketPath);
  const replacement = await listenUnix(socketPath);
  try {
    await waitForCondition(
      () => unixListenerInodes(socketPath).length === 2,
      "old and replacement listener inodes",
    );
    const result = spawnSync(process.execPath, [orphanReaper, socketPath], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /multiple live listener inodes/);
    assert.equal(processStartTime(orphan.pid), orphan.startTime);
    assert.equal(fs.readFileSync(lockPath, "utf8"), lockContents);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await closeServer(replacement);
    if (processStartTime(orphan.pid) === orphan.startTime) {
      try {
        process.kill(orphan.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport rejects an existing socket without unlinking it", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-existing-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  let spawnCalls = 0;
  const { Transport } = loadInjectedTransport({
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await assert.rejects(transport.ensureAuthority(), /path already exists/);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport serializes startup and removes only its owned socket", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-owner-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const servers = new Map();
  const children = [];
  let replacement;
  let replacementError;
  let installReplacementBeforeChildClose = false;
  const identityFs = {
    ...fs,
    lstatSync(candidate, ...args) {
      const stat = fs.lstatSync(candidate, ...args);
      if (candidate !== socketPath || !installReplacementBeforeChildClose) return stat;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === "ino") return target.ino + 1;
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
  const { Transport } = loadInjectedTransport({
    fsImpl: identityFs,
    spawnImpl(_command, args) {
      const child = fakeChild();
      children.push(child);
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        const server = await listenUnix(target);
        servers.set(child, server);
        child.kill = () => {
          child.killed = true;
          child.signalCode = "SIGTERM";
          server.close(() => {
            setImmediate(() => {
              Promise.resolve()
                .then(async () => {
                  if (installReplacementBeforeChildClose) replacement = await listenUnix(target);
                })
                .catch((error) => {
                  replacementError = error;
                })
                .finally(() => {
                  child.emit("close", null, "SIGTERM");
                });
            });
          });
          return true;
        };
      });
      return child;
    },
  });
  const first = new Transport(socketPath);
  const second = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await first.ensureAuthority();
    assert.equal(fs.existsSync(`${socketPath}.lock`), true);
    assert.match(
      fs.readFileSync(`${socketPath}.lock`, "utf8"),
      new RegExp(`^${process.pid} \\d+ ${process.pid} \\d+\\n$`),
    );
    await assert.rejects(second.ensureAuthority(), /already owned/);

    installReplacementBeforeChildClose = true;
    const childClosed = once(children[0], "close");
    first.dispose();
    await childClosed;
    assert.ifError(replacementError);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true, "replacement socket must survive dispose");
    await closeServer(replacement);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport shares one readiness promise across concurrent connections", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-concurrent-");
  const socketPath = path.join(tempDir, "app-server.sock");
  let spawnCalls = 0;
  let server;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      spawnCalls += 1;
      const child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      setTimeout(async () => {
        server = await listenUnix(target);
        child.kill = () => {
          child.signalCode = "SIGTERM";
          server.close(() => child.emit("close", null, "SIGTERM"));
          return true;
        };
      }, 25);
      return child;
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const first = transport.ensureAuthority();
    const second = transport.ensureAuthority();
    let resolvedEarly = false;
    second.then(() => {
      resolvedEarly = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(resolvedEarly, false, "concurrent callers must wait for socket readiness");
    await Promise.all([first, second]);
    assert.equal(spawnCalls, 1);
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
    transport.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport fails closed on a live owner's lock", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-live-lock-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const selfStat = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const selfStartTime = selfStat.slice(selfStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  fs.writeFileSync(lockPath, `${process.pid} ${selfStartTime}\n`, { mode: 0o600 });
  let spawnCalls = 0;
  const { Transport } = loadInjectedTransport({
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await assert.rejects(transport.ensureAuthority(), /already owned/);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.readFileSync(lockPath, "utf8"), `${process.pid} ${selfStartTime}\n`);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport reclaims a dead owner's lock when no socket exists", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-dead-lock-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "99999999 1\n", { mode: 0o600 });
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    await transport.acquireOwnership();
    assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`));
    transport.releaseOwnedPaths();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport preserves a dead owner's lock while its socket is live", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-orphan-socket-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "99999999 1\n", { mode: 0o600 });
  const server = await listenUnix(socketPath);
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  try {
    await assert.rejects(new Transport(socketPath).acquireOwnership(), /already owned/);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "99999999 1\n");
    assert.equal(fs.lstatSync(socketPath).isSocket(), true);
  } finally {
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport reclaims a dead owner's unbound socket inode", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-stale-socket-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const stalePath = `${socketPath}.stale`;
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "99999999 1\n", { mode: 0o600 });
  const server = await listenUnix(socketPath);
  fs.renameSync(socketPath, stalePath);
  await closeServer(server);
  fs.renameSync(stalePath, socketPath);
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    await transport.acquireOwnership();
    assert.equal(fs.existsSync(socketPath), false);
    assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`));
    transport.releaseOwnedPaths();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport reclaims an old legacy lock but preserves a recent one", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-legacy-lock-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  try {
    fs.writeFileSync(lockPath, "", { mode: 0o600 });
    await assert.rejects(new Transport(socketPath).acquireOwnership(), /already owned/);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const transport = new Transport(socketPath);
    await transport.acquireOwnership();
    assert.match(fs.readFileSync(lockPath, "utf8"), new RegExp(`^${process.pid} \\d+\\n$`));
    transport.releaseOwnedPaths();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport preserves a replacement lock inode", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-lock-replace-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const oldLockPath = `${lockPath}.old`;
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    await transport.acquireOwnership();
    fs.renameSync(lockPath, oldLockPath);
    fs.writeFileSync(lockPath, "replacement\n", { mode: 0o600 });
    transport.releaseOwnedPaths();
    assert.equal(fs.readFileSync(lockPath, "utf8"), "replacement\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

for (const [failureKind, spawnImpl] of [
  ["asynchronous", () => {
    const child = fakeChild();
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
    return child;
  }],
  ["synchronous", () => {
    throw new Error("spawn failed");
  }],
]) {
  test(`injected transport releases ownership after ${failureKind} spawn failure`, async () => {
    const tempDir = makeSocketTempDir("shared-app-server-spawn-failure-");
    const socketPath = path.join(tempDir, "app-server.sock");
    const { Transport } = loadInjectedTransport({ spawnImpl });
    const transport = new Transport(socketPath);
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/missing/codex";
    try {
      await assert.rejects(transport.ensureAuthority(), /spawn failed/);
      assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

test("injected transport does not release ownership until authority exit is verified", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-stop-error-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const child = fakeChild();
  child.kill = () => {
    queueMicrotask(() => child.emit("error", new Error("kill failed")));
    return false;
  };
  const { Transport } = loadInjectedTransport({ spawnImpl: () => child, timeoutCapMs: 10 });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await assert.rejects(transport.ensureAuthority(), /creation timed out/);
    assert.equal(fs.existsSync(`${socketPath}.lock`), true, "unverified child retains ownership lock");
    assert.match(
      fs.readFileSync(`${socketPath}.lock`, "utf8"),
      new RegExp(`^${process.pid} \\d+ ${process.pid} \\d+\\n$`),
      "the lock binds cleanup to the spawned authority before socket readiness",
    );
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normal authority exit releases its owned socket and lock", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-normal-exit-");
  const socketPath = path.join(tempDir, "app-server.sock");
  let server;
  let child;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        server = await listenUnix(target);
      });
      return child;
    },
  });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await transport.ensureAuthority();
    await closeServer(server);
    server = null;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("disposing before async startup resumes releases ownership without spawning", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-dispose-startup-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const child = fakeChild();
  child.kill = () => {
    child.signalCode = "SIGTERM";
    setTimeout(() => child.emit("close", null, "SIGTERM"), 10);
    return true;
  };
  const { Transport } = loadInjectedTransport({ spawnImpl: () => child });
  const transport = new Transport(socketPath);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const startup = transport.ensureAuthority();
    transport.dispose();
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    await assert.rejects(startup, /disposed during startup/);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    assert.equal(child.signalCode, null);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-start authority errors close active proxy streams without crashing", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-runtime-error-");
  const socketPath = path.join(tempDir, "app-server.sock");
  let server;
  let child;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        server = await listenUnix(target);
        child.kill = () => {
          child.signalCode = "SIGTERM";
          server.close(() => child.emit("close", null, "SIGTERM"));
          return true;
        };
      });
      return child;
    },
  });
  const transport = new Transport(socketPath);
  const proxy = {
    destroyed: false,
    destroy(error) {
      this.destroyed = true;
      this.error = error;
    },
  };
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await transport.ensureAuthority();
    transport.proxyStreams.add(proxy);
    assert.doesNotThrow(() => child.emit("error", new Error("runtime failure")));
    assert.equal(proxy.destroyed, true);
    assert.match(proxy.error.message, /runtime failure/);
    transport.dispose();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("asynchronous cleanup failures warn instead of escaping Electron callbacks", () => {
  const warnings = [];
  const originalWarn = console.warn;
  const fsImpl = {
    ...fs,
    lstatSync() {
      const error = new Error("cleanup denied");
      error.code = "EACCES";
      throw error;
    },
  };
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild(), fsImpl });
  const transport = new Transport("/unused/socket");
  transport.socketIdentity = { dev: 1, ino: 1 };
  transport.lockIdentity = { dev: 2, ino: 2 };
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.doesNotThrow(() => transport.releaseOwnedPaths(true));
    assert.match(warnings.join("\n"), /cleanup failed/);
    assert.deepEqual(transport.socketIdentity, { dev: 1, ino: 1 });
    assert.deepEqual(transport.lockIdentity, { dev: 2, ino: 2 });
  } finally {
    console.warn = originalWarn;
  }
});

test("injected transport connects through its proxy and disposes the proxy stream", async () => {
  const proxy = fakeChild();
  const { Transport, namespace } = loadInjectedTransport({ spawnImpl: () => proxy });
  const transport = new Transport("/unused/socket");
  transport.ensureAuthority = async () => {};
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const adapter = await transport.connect();
    assert.equal(adapter instanceof namespace.Adapter, true);
    assert.equal(transport.proxyStreams.size, 1);
    adapter.socket.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(proxy.killed, true);
    assert.equal(transport.proxyStreams.size, 0);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
  }
});

for (const failure of ["error", "timeout"]) {
  test(`injected transport cleans up proxy and WebSocket on pre-open ${failure}`, async () => {
    let socket;
    class FailingWebSocket extends EventEmitter {
      constructor(_url, options) {
        super();
        socket = this;
        this.stream = options.createConnection();
        if (failure === "error") queueMicrotask(() => this.emit("error", new Error("open failed")));
      }

      terminate() {
        this.terminated = true;
        this.stream.destroy();
      }
    }
    const proxy = fakeChild();
    const { Transport } = loadInjectedTransport({
      spawnImpl: () => proxy,
      WebSocketImpl: FailingWebSocket,
      timeoutCapMs: 10,
    });
    const transport = new Transport("/unused/socket");
    transport.ensureAuthority = async () => {};
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/fake/codex";
    try {
      await assert.rejects(
        transport.connect(),
        failure === "error" ? /open failed/ : /open timed out/,
      );
      assert.equal(socket.terminated, true);
      assert.equal(proxy.killed, true);
      assert.equal(transport.proxyStreams.size, 0);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
    }
  });
}

test("socket environment hook shell syntax is valid", () => {
  const result = spawnSync("bash", ["-n", socketEnvHook], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("orphan reaper JavaScript syntax is valid", () => {
  const result = spawnSync(process.execPath, ["--check", orphanReaper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("documented wrapper attaches to a real Codex authority through the stock proxy", { timeout: 15000 }, async (t) => {
  const codexCli = process.env.CODEX_CLI_PATH;
  if (codexCli == null) {
    t.skip("set CODEX_CLI_PATH to run the real Codex app-server integration test");
    return;
  }

  const tempDir = makeSocketTempDir(
    "shared-app-server-socket-integration-",
    path.join("authority", "app-server.sock"),
  );
  const codexHome = path.join(tempDir, "codex-home");
  const socketPath = path.join(tempDir, "authority", "app-server.sock");
  const binDir = path.join(tempDir, "bin");
  const wrapperPath = path.join(binDir, "codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.mkdirSync(path.dirname(socketPath), { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env bash",
      "set -eu",
      'if [ "$#" -eq 2 ] && [ "$1" = "app-server" ] && [ "$2" = "proxy" ]; then',
      '  exec "$REAL_CODEX" app-server proxy --sock "$DESKTOP_SOCKET"',
      "fi",
      'exec "$REAL_CODEX" "$@"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    DESKTOP_SOCKET: socketPath,
    PATH: `${binDir}:${process.env.PATH}`,
    REAL_CODEX: codexCli,
  };
  const authority = spawn(codexCli, ["app-server", "--listen", `unix://${socketPath}`], {
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let proxy;

  try {
    await waitForSocket(socketPath, authority);
    assert.equal(
      fs.statSync(socketPath).mode & 0o077,
      0,
      "app-server socket must not grant group/other access",
    );

    proxy = spawn("bash", ["-c", "codex app-server proxy"], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const responsePromise = readWebSocketUpgrade(proxy);
    proxy.stdin.end(
      [
        "GET /rpc HTTP/1.1",
        "Host: localhost",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    const response = await responsePromise;
    assert.match(response, /^HTTP\/1\.1 101 /);
    assert.match(response.toLowerCase(), /upgrade: websocket/);
  } finally {
    await Promise.all([stopChild(proxy), stopChild(authority)]);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
