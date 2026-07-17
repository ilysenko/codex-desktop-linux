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

function syntheticBundle() {
  return [
    "var Ky=class{options;kind=`websocket`;logger=r.i(`AppServerTransportSshWebsocket`);proxyStreams=new Set;supportsReconnect(){return!0}",
    "async connect(){let t={current:null},r=new n.zn(Fy,{perMessageDeflate:!1,createConnection:()=>",
    "(t.current=this.createSshProxyStream(),t.current)});return n.Ln(r,{onPongTimeout:()=>r.terminate()}),new n.Rn(r)}};",
    "function n6(e){let t=Jy(e.hostConfig);if(t)return Z.info(`selected app-server transport`),new Ky(t);",
    "if(e.transportKind===`remote-control`)return new Remote(e);",
    "if(n.io(e.hostConfig))return new Wsl({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator});",
    "let r=r6(e.hostConfig);if(r){e.desktopAuthAppServerClient;let t=p8(e.hostConfig,r);return new n.Fn({hostConfig:e.hostConfig,websocketUrl:r,getWebsocketProtocols:void 0,...t==null?{}:{socksProxyUrl:t}})}",
    "return new n.Nn({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator})}function afterFactory(){}",
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

test("feature stages only the socket environment hook", () => {
  withFeatureConfig(["shared-app-server-socket"], (featuresRoot) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, path.basename(hook.target), hook.mode.toString(8)]),
        [["launcher", "shared-app-server-socket-socket-env.sh", "755"]],
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
  assert.match(patched, /this\.sameIdentity\(this\.socketIdentity,e\)/);
  assert.match(patched, /requires CODEX_CLI_PATH/);
  assert.match(patched, /new n\.zn\(Fy,/);
  assert.match(patched, /new n\.Rn\(/);
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
    "class{options;kind=`websocket`;logger=r.i(`AppServerTransportSshWebsocket`);",
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
  const env = {
    ...process.env,
    CODEX_LINUX_APP_ID: "codex-bridge-test",
    CODEX_LINUX_APP_STATE_DIR: path.join(tempDir, "state"),
    XDG_RUNTIME_DIR: tempDir,
  };
  try {
    const result = spawnSync(socketEnvHook, [], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      `env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${tempDir}/codex-bridge-test/app-server-bridge/app-server.sock`,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport rejects an existing socket without unlinking it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-existing-"));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-owner-"));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-concurrent-"));
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

test("injected transport fails closed on a pre-existing lock", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-stale-lock-"));
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  fs.writeFileSync(lockPath, "preserved\n", { mode: 0o600 });
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
    assert.equal(fs.readFileSync(lockPath, "utf8"), "preserved\n");
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("injected transport preserves a replacement lock inode", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-lock-replace-"));
  const socketPath = path.join(tempDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const oldLockPath = `${lockPath}.old`;
  const { Transport } = loadInjectedTransport({ spawnImpl: () => fakeChild() });
  const transport = new Transport(socketPath);
  try {
    transport.acquireOwnership();
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-spawn-failure-"));
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-stop-error-"));
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
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normal authority exit releases its owned socket and lock", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-normal-exit-"));
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

test("disposing during startup waits for child close before releasing ownership", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-dispose-startup-"));
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
    assert.equal(fs.existsSync(`${socketPath}.lock`), true);
    await assert.rejects(startup, /exited before socket creation/);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("post-start authority errors close active proxy streams without crashing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-runtime-error-"));
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

test("documented wrapper attaches to a real Codex authority through the stock proxy", { timeout: 15000 }, async (t) => {
  const codexCli = process.env.CODEX_CLI_PATH;
  if (codexCli == null) {
    t.skip("set CODEX_CLI_PATH to run the real Codex app-server integration test");
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-socket-integration-"));
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
