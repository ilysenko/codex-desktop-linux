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
  attachmentTransportClassSource,
  applyExternalAppServerAttachmentPatch,
  descriptors,
} = require("./patch.js");

const socketEnvHook = path.join(__dirname, "socket-env.sh");
const descriptorReader = path.join(__dirname, "descriptor-reader.js");
const expectedPatchSentinel = "/*codex-linux:external-app-server-attachment:v1*/";
const unixSocketPathMaxBytes = 107;

function loadDescriptorReader() {
  assert.equal(
    fs.existsSync(descriptorReader),
    true,
    "descriptor reader must exist before its behavior can be used",
  );
  return require(descriptorReader);
}

function withDescriptorTree(callback, { appId = "desktop-attachment-test" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-descriptor-"));
  const configRoot = path.join(root, "config");
  const descriptorDir = path.join(configRoot, appId);
  const descriptorPath = path.join(descriptorDir, "app-server-attachment.json");
  fs.mkdirSync(descriptorDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(descriptorDir, 0o700);
  try {
    return callback({ appId, configRoot, descriptorDir, descriptorPath, root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeDescriptor(descriptorPath, source, mode = 0o600) {
  fs.writeFileSync(descriptorPath, source, { mode });
  fs.chmodSync(descriptorPath, mode);
}

function descriptorSource(socketPath, { transport = "unix", version = 1 } = {}) {
  return `${JSON.stringify({ schemaVersion: version, socketPath, transport })}\n`;
}

function copyStatWithUid(stat, uid) {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid });
}

function withUidMismatch(targetPath, callback) {
  const originalFstat = fs.fstatSync;
  const originalLstat = fs.lstatSync;
  const originalOpen = fs.openSync;
  const targetFds = new Set();
  fs.lstatSync = (candidate, ...args) => {
    const stat = originalLstat(candidate, ...args);
    const mismatchUid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1;
    return candidate === targetPath ? copyStatWithUid(stat, mismatchUid) : stat;
  };
  fs.openSync = (candidate, ...args) => {
    const fd = originalOpen(candidate, ...args);
    if (candidate === targetPath) targetFds.add(fd);
    return fd;
  };
  fs.fstatSync = (fd, ...args) => {
    const stat = originalFstat(fd, ...args);
    const mismatchUid = typeof stat.uid === "bigint" ? stat.uid + 1n : stat.uid + 1;
    return targetFds.has(fd) ? copyStatWithUid(stat, mismatchUid) : stat;
  };
  try {
    return callback();
  } finally {
    fs.fstatSync = originalFstat;
    fs.lstatSync = originalLstat;
    fs.openSync = originalOpen;
  }
}

function hookEnvironment(tree) {
  const appDir = path.join(tree.root, "app");
  const managedNode = path.join(appDir, "resources", "node-runtime", "bin", "node");
  fs.mkdirSync(path.dirname(managedNode), { recursive: true, mode: 0o700 });
  fs.symlinkSync(process.execPath, managedNode);
  const env = {
    ...process.env,
    CODEX_LINUX_APP_DIR: appDir,
    CODEX_LINUX_APP_ID: tree.appId,
    CODEX_LINUX_FEATURES_DIR: path.resolve(__dirname, ".."),
    HOME: tree.root,
    XDG_CONFIG_HOME: tree.configRoot,
  };
  delete env.CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY;
  delete env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET;
  return env;
}

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-app-server-attachment-feature-"));
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

function makeUnixSocketTempDir() {
  return fs.mkdtempSync("/tmp/cas-");
}

function assertUnixSocketPath(socketPath) {
  const byteLength = Buffer.byteLength(socketPath);
  if (byteLength > unixSocketPathMaxBytes) {
    throw new RangeError(
      `Unix socket path is ${byteLength} bytes; maximum is ${unixSocketPathMaxBytes}: ${socketPath}`,
    );
  }
}

function captureBoundedStderr(stream, maxBytes = 4000) {
  let stderr = Buffer.alloc(0);
  stream?.on("data", (chunk) => {
    stderr = Buffer.concat([stderr, Buffer.from(chunk)]);
    if (stderr.length > maxBytes) stderr = stderr.subarray(stderr.length - maxBytes);
  });
  return () => stderr.toString("utf8");
}

async function waitForSocket(socketPath, child, readStderr = () => "") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode != null) {
      const stderr = readStderr().trim();
      throw new Error(
        `app-server exited before creating its socket (${child.exitCode})${
          stderr === "" ? "" : `\n${stderr}`
        }`,
      );
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

function loadInjectedAttachmentTransport({
  processImpl = process,
  spawnImpl,
  WebSocketImpl = null,
  fsImpl = fs,
} = {}) {
  assert.equal(
    typeof attachmentTransportClassSource,
    "function",
    "attachment-only transport source must be exported",
  );
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
  class DefaultAdapter {
    constructor(socket) {
      this.socket = socket;
    }
  }
  const namespace = {
    WS: WebSocketImpl ?? DefaultWebSocket,
    keepAlive() {},
    Adapter: DefaultAdapter,
  };
  const source = attachmentTransportClassSource({
    namespace: "n",
    webSocketClass: "WS",
    webSocketUrl: "url",
    keepAlive: "keepAlive",
    adapterClass: "Adapter",
  });
  const context = {
    n: namespace,
    url: "ws://localhost/rpc",
    process: processImpl,
    console,
    require(id) {
      if (id === "node:child_process") return { spawn: spawnImpl };
      if (id === "node:fs") return fsImpl;
      return require(id);
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(
    `${source};globalThis.Transport=CodexLinuxExternalAppServerSocketTransport`,
    context,
  );
  return context.Transport;
}

function pathIdentity(candidate) {
  try {
    const stat = fs.lstatSync(candidate);
    return {
      device: stat.dev,
      inode: stat.ino,
      mode: stat.mode,
      type: stat.isSocket() ? "socket" : stat.isSymbolicLink() ? "symlink" : "other",
    };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function trackedAttachmentFs({ afterFstat = null } = {}) {
  const opened = [];
  const openFds = new Set();
  const closed = [];
  const fsImpl = {
    ...fs,
    openSync(candidate, flags, ...args) {
      const fd = fs.openSync(candidate, flags, ...args);
      opened.push({ candidate, fd, flags });
      openFds.add(fd);
      return fd;
    },
    fstatSync(fd, ...args) {
      const stat = fs.fstatSync(fd, ...args);
      afterFstat?.(fd, stat);
      return stat;
    },
    closeSync(fd) {
      const result = fs.closeSync(fd);
      if (openFds.delete(fd)) closed.push(fd);
      return result;
    },
  };
  return { closed, fsImpl, opened, openFds };
}

async function assertAttachmentValidationRejects({
  expectedError,
  fsImpl = fs,
  processImpl = process,
  socketPath,
}) {
  const before = pathIdentity(socketPath);
  let spawnCalls = 0;
  const Transport = loadInjectedAttachmentTransport({
    fsImpl,
    processImpl,
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath);
  try {
    await assert.rejects(transport.connect(), expectedError);
    assert.equal(spawnCalls, 0, "validation rejection must happen before proxy spawn");
    assert.deepEqual(
      pathIdentity(socketPath),
      before,
      "validation rejection must preserve the configured endpoint inode and path",
    );
    assert.equal(
      fs.existsSync(`${socketPath}.lock`),
      false,
      "attachment validation must never create a bridge ownership lock",
    );
  } finally {
    transport.dispose();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function listenUnix(socketPath) {
  assertUnixSocketPath(socketPath);
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

async function withAttachmentSocket(callback, { parentMode = 0o700, socketMode = 0o600 } = {}) {
  const tempDir = makeUnixSocketTempDir();
  const socketPath = path.join(tempDir, "app-server.sock");
  const server = await listenUnix(socketPath);
  fs.chmodSync(tempDir, parentMode);
  fs.chmodSync(socketPath, socketMode);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    return await callback({ socketPath });
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("external-app-server-attachment stays disabled until explicitly enabled", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });
  withFeatureConfig(["external-app-server-attachment"], (featuresRoot) => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((entry) => entry.id),
      ["feature:external-app-server-attachment:main-process-external-app-server-attachment"],
    );
  });
});

test("feature stages the descriptor reader resource and executable socket hook", () => {
  withFeatureConfig(["external-app-server-attachment"], (featuresRoot) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "external-app-server-attachment-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.resources.map((resource) => [resource.target, resource.mode.toString(8)]),
        [[".codex-linux/features/external-app-server-attachment/descriptor-reader.js", "644"]],
      );
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, path.basename(hook.target), hook.mode.toString(8)]),
        [["launcher", "external-app-server-attachment-external-app-server-attachment.sh", "755"]],
      );
      assert.equal(
        fs.statSync(
          path.join(
            appDir,
            ".codex-linux",
            "features",
            "external-app-server-attachment",
            "descriptor-reader.js",
          ),
        ).mode & 0o777,
        0o644,
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("descriptor reader accepts the exact schema regardless of key order or whitespace", () => {
  const reader = loadDescriptorReader();
  withDescriptorTree((tree) => {
    const socketPath = "/tmp/attachment-test.sock";
    writeDescriptor(
      tree.descriptorPath,
      ` \n { \"transport\" : \"unix\", \"socketPath\" : \"${socketPath}\", \"schemaVersion\" : 1 } \n`,
    );
    const descriptor = reader.readAttachmentDescriptor(tree.descriptorPath);
    assert.deepEqual(descriptor, { socketPath });
  });
});

test("descriptor reader treats only an absent descriptor as an ordinary no-op", () => {
  const reader = loadDescriptorReader();
  withDescriptorTree((tree) => {
    assert.equal(reader.readAttachmentDescriptor(tree.descriptorPath), null);
  });
});

test("descriptor reader rejects schema and socket-path violations", async (t) => {
  const cases = [
    ["non-object", "[]"],
    ["missing key", JSON.stringify({ schemaVersion: 1, socketPath: "/tmp/socket" })],
    [
      "extra key",
      JSON.stringify({ schemaVersion: 1, socketPath: "/tmp/socket", transport: "unix", extra: true }),
    ],
    ["noninteger version", descriptorSource("/tmp/socket", { version: 1.5 })],
    ["wrong version", descriptorSource("/tmp/socket", { version: 2 })],
    ["wrong transport", descriptorSource("/tmp/socket", { transport: "tcp" })],
    ["empty socket path", descriptorSource("")],
    ["relative socket path", descriptorSource("relative/socket")],
    ["nonnormal socket path", descriptorSource("/tmp/../tmp/socket")],
    ["NUL socket path", descriptorSource("/tmp/socket\u0000suffix")],
  ];
  for (const [name, source] of cases) {
    await t.test(name, () => {
      const reader = loadDescriptorReader();
      withDescriptorTree((tree) => {
        writeDescriptor(tree.descriptorPath, source);
        assert.throws(
          () => reader.readAttachmentDescriptor(tree.descriptorPath),
          /attachment descriptor/i,
        );
      });
    });
  }
});

test("descriptor reader independently rejects parent and descriptor owner mismatches", async (t) => {
  await t.test("parent owner mismatch", () => {
    const reader = loadDescriptorReader();
    withDescriptorTree((tree) => {
      writeDescriptor(tree.descriptorPath, descriptorSource("/tmp/socket"));
      withUidMismatch(tree.descriptorDir, () => {
        assert.throws(
          () => reader.readAttachmentDescriptor(tree.descriptorPath),
          /parent has an unexpected owner/i,
        );
      });
    });
  });

  await t.test("descriptor owner mismatch", () => {
    const reader = loadDescriptorReader();
    withDescriptorTree((tree) => {
      writeDescriptor(tree.descriptorPath, descriptorSource("/tmp/socket"));
      withUidMismatch(tree.descriptorPath, () => {
        assert.throws(
          () => reader.readAttachmentDescriptor(tree.descriptorPath),
          /has an unexpected owner/i,
        );
      });
    });
  });
});

test("descriptor reader rejects unsafe descriptor files and parents", async (t) => {
  const cases = [
    ["wrong mode", (tree) => {
      fs.chmodSync(tree.descriptorPath, 0o644);
      return {};
    }],
    ["nonregular descriptor", (tree) => {
      fs.rmSync(tree.descriptorPath);
      fs.mkdirSync(tree.descriptorPath, { mode: 0o700 });
      return {};
    }],
    ["descriptor symlink", (tree) => {
      const target = path.join(tree.root, "descriptor-target.json");
      fs.renameSync(tree.descriptorPath, target);
      fs.symlinkSync(target, tree.descriptorPath);
      return {};
    }],
    ["unsafe writable parent", (tree) => {
      fs.chmodSync(tree.descriptorDir, 0o722);
      return {};
    }],
  ];
  for (const [name, prepare] of cases) {
    await t.test(name, () => {
      const reader = loadDescriptorReader();
      withDescriptorTree((tree) => {
        writeDescriptor(tree.descriptorPath, descriptorSource("/tmp/socket"));
        const options = prepare(tree);
        assert.throws(
          () => reader.readAttachmentDescriptor(tree.descriptorPath, options.expectedUid),
          /attachment descriptor/i,
        );
      });
    });
  }
});

test("descriptor reader rejects replacement races before opening the descriptor", () => {
  const reader = loadDescriptorReader();
  withDescriptorTree((tree) => {
    const replacement = path.join(tree.root, "replacement.json");
    writeDescriptor(tree.descriptorPath, descriptorSource("/tmp/original.sock"));
    writeDescriptor(replacement, descriptorSource("/tmp/replacement.sock"));
    const originalOpen = fs.openSync;
    const originalReadFile = fs.readFileSync;
    let readDescriptor = false;
    let replaced = false;
    fs.openSync = (candidate, ...args) => {
      if (!replaced && candidate === tree.descriptorPath) {
        fs.renameSync(replacement, tree.descriptorPath);
        replaced = true;
      }
      return originalOpen(candidate, ...args);
    };
    fs.readFileSync = (target, ...args) => {
      if (typeof target === "number") readDescriptor = true;
      return originalReadFile(target, ...args);
    };
    try {
      assert.throws(
        () => reader.readAttachmentDescriptor(tree.descriptorPath),
        /attachment descriptor/i,
      );
      assert.equal(replaced, true, "test must replace the descriptor immediately before its open");
      assert.equal(readDescriptor, false, "pre-open replacement must reject before reading the replacement");
    } finally {
      fs.openSync = originalOpen;
      fs.readFileSync = originalReadFile;
    }
  });
});

test("descriptor reader promptly rejects a FIFO swapped immediately before open", { timeout: 2000 }, (t) => {
  if (process.platform !== "linux") {
    t.skip("FIFO race coverage is Linux-specific");
    return;
  }
  withDescriptorTree((tree) => {
    const fifoPath = path.join(tree.root, "replacement.fifo");
    writeDescriptor(tree.descriptorPath, descriptorSource("/tmp/original.sock"));
    const mkfifo = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const source = [
      "const fs=require('node:fs');",
      "const descriptorPath=process.argv[1];",
      "const fifoPath=process.argv[2];",
      "const readerPath=process.argv[3];",
      "const openSync=fs.openSync;",
      "let swapped=false;",
      "fs.openSync=(candidate,flags,...args)=>{if(!swapped&&candidate===descriptorPath){fs.renameSync(fifoPath,descriptorPath);swapped=true}return openSync(candidate,flags,...args)};",
      "const {readAttachmentDescriptor,routingRecords}=require(readerPath);",
      "try{const descriptor=readAttachmentDescriptor(descriptorPath);if(descriptor)process.stdout.write(`${routingRecords(descriptor).join('\\n')}\\n`)}catch{process.stderr.write('descriptor rejected\\n');process.exitCode=1}",
    ].join("");
    const result = spawnSync(
      process.execPath,
      ["-e", source, tree.descriptorPath, fifoPath, descriptorReader],
      { encoding: "utf8", timeout: 1000 },
    );
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, result.stderr);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "descriptor rejected\n");
  });
});

test("descriptor reader rejects replacement races after reading before path reinspection", () => {
  const reader = loadDescriptorReader();
  withDescriptorTree((tree) => {
    const replacement = path.join(tree.root, "replacement.json");
    writeDescriptor(tree.descriptorPath, descriptorSource("/tmp/original.sock"));
    writeDescriptor(replacement, descriptorSource("/tmp/replacement.sock"));
    const originalReadFile = fs.readFileSync;
    let replaced = false;
    fs.readFileSync = (target, ...args) => {
      const source = originalReadFile(target, ...args);
      if (!replaced && typeof target === "number") {
        fs.renameSync(replacement, tree.descriptorPath);
        replaced = true;
      }
      return source;
    };
    const routing = [];
    let failure = null;
    try {
      const descriptor = reader.readAttachmentDescriptor(tree.descriptorPath);
      routing.push(...reader.routingRecords(descriptor));
    } catch (error) {
      failure = error;
    } finally {
      fs.readFileSync = originalReadFile;
    }
    assert.equal(replaced, true, "test must replace the descriptor after its real file descriptor is read");
    assert.match(failure?.message ?? "", /attachment descriptor/i);
    assert.deepEqual(routing, [], "post-read revalidation rejection must emit no routing records");
  });
});

test("descriptor reader rejects same-inode mutation during the descriptor read", () => {
  const reader = loadDescriptorReader();
  withDescriptorTree((tree) => {
    const originalSource = descriptorSource("/tmp/original.sock");
    const mutatedSource = descriptorSource("/tmp/changed0.sock");
    assert.equal(Buffer.byteLength(mutatedSource), Buffer.byteLength(originalSource));
    writeDescriptor(tree.descriptorPath, originalSource);
    const before = fs.lstatSync(tree.descriptorPath, { bigint: true });
    const originalReadFile = fs.readFileSync;
    let mutated = false;
    fs.readFileSync = (target, ...args) => {
      const source = originalReadFile(target, ...args);
      if (!mutated && typeof target === "number") {
        fs.writeFileSync(tree.descriptorPath, mutatedSource);
        mutated = true;
      }
      return source;
    };
    const routing = [];
    let failure = null;
    try {
      const descriptor = reader.readAttachmentDescriptor(tree.descriptorPath);
      routing.push(...reader.routingRecords(descriptor));
    } catch (error) {
      failure = error;
    } finally {
      fs.readFileSync = originalReadFile;
    }
    const after = fs.lstatSync(tree.descriptorPath, { bigint: true });
    assert.equal(mutated, true, "test must mutate the descriptor after its file descriptor is read");
    assert.equal(before.dev, after.dev);
    assert.equal(before.ino, after.ino);
    assert.match(failure?.message ?? "", /attachment descriptor/i);
    assert.deepEqual(routing, [], "same-inode mutation rejection must emit no routing records");
  });
});

test("socket hook routes nothing when the descriptor is absent", () => {
  withDescriptorTree((tree) => {
    const result = spawnSync(socketEnvHook, [], {
      encoding: "utf8",
      env: hookEnvironment(tree),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});

test("socket hook emits exactly the attachment routing records for a valid descriptor", () => {
  withDescriptorTree((tree) => {
    const socketPath = "/tmp/selected-by-descriptor.sock";
    writeDescriptor(tree.descriptorPath, descriptorSource(socketPath));
    const result = spawnSync(socketEnvHook, [], {
      encoding: "utf8",
      env: hookEnvironment(tree),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "env CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY=1\n" +
        `env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=${socketPath}\n`,
    );
    assert.equal(result.stderr, "");
  });
});

test("socket hook rejects invalid descriptors with one redaction-safe diagnostic and no routing", () => {
  withDescriptorTree((tree) => {
    const unsafeSocketPath = "relative\nsecret";
    writeDescriptor(tree.descriptorPath, descriptorSource(unsafeSocketPath));
    const result = spawnSync(socketEnvHook, [], {
      encoding: "utf8",
      env: hookEnvironment(tree),
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /attachment descriptor/i);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.equal(result.stderr.includes(tree.root), false);
    assert.equal(result.stderr.includes(unsafeSocketPath), false);
  });
});

test("socket hook preserves explicitly configured development routing without reading a descriptor", () => {
  for (const explicitEnv of [
    { CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1" },
    { CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: "/tmp/explicit-development.sock" },
  ]) {
    withDescriptorTree((tree) => {
      writeDescriptor(tree.descriptorPath, "not valid JSON");
      const result = spawnSync(socketEnvHook, [], {
        encoding: "utf8",
        env: { ...hookEnvironment(tree), ...explicitEnv },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    });
  }
});

test("patch accepts the additional supported SSH transport lifecycle", () => {
  const directLifecycle =
    "return n.Ln(r,{onPongTimeout:()=>r.terminate()}),new n.Rn(r)";
  const source = syntheticBundle().replace(
    directLifecycle,
    "return n.Ln(r,{onPongTimeout:()=>r.terminate()}),this.hasConnected=!0,new n.Rn(r)",
  );
  const patched = applyExternalAppServerAttachmentPatch(source);

  assert.notEqual(patched, source);
});

test("patch rejects ambiguous SSH transport lifecycles", () => {
  const directLifecycle =
    "return n.Ln(r,{onPongTimeout:()=>r.terminate()}),new n.Rn(r)";
  const connectedLifecycle =
    "return n.Ln(r,{onPongTimeout:()=>r.terminate()}),this.hasConnected=!0,new n.Rn(r)";
  const connectedSource = syntheticBundle().replace(directLifecycle, connectedLifecycle);
  const source = connectedSource.replace(
    "new n.Rn(r)}};",
    "new n.Rn(r)}duplicate(){return n.Ln(r,{onPongTimeout:()=>r.terminate()}),this.hasConnected=!0,new n.Rn(r)}};",
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applyExternalAppServerAttachmentPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /SSH WebSocket transport/);
});

test("patch selects the bridge only for the local host and is idempotent", () => {
  const source = syntheticBundle();
  const patched = applyExternalAppServerAttachmentPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applyExternalAppServerAttachmentPatch(patched), patched);
  assert.equal(patched.split(expectedPatchSentinel).length - 1, 1);
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/);
  assert.match(patched, /app-server`,\s*`proxy`,\s*`--sock`/);
  assert.match(patched, /requires CODEX_CLI_PATH/);
  assert.match(patched, /new n\.zn\(Fy,/);
  assert.match(patched, /new n\.Rn\(/);
  assert.match(patched, /supportsReconnect\(\)\{return!0\}/);
});

test("patch selects attachment-only transport only for explicit local mode and fails closed", () => {
  const patched = applyExternalAppServerAttachmentPatch(syntheticBundle());
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY===`1`/);
  assert.match(patched, /new CodexLinuxExternalAppServerSocketTransport/);

  const select = (env, hostKind = "local") => {
    const context = {
      process: { env },
      require,
      console,
      setTimeout,
      clearTimeout,
      r: { i: () => null },
      r6: () => null,
      Z: { info() {} },
      Jy: () => null,
      n: {
        io: () => false,
        Nn: class LocalAppServerTransport {},
        WS: class {},
        keepAlive() {},
        Adapter: class {},
      },
      Fy: "ws://localhost/rpc",
    };
    vm.runInNewContext(`${patched};globalThis.selectTransport=n6`, context);
    return context.selectTransport({ hostConfig: { kind: hostKind } });
  };

  const socketPath = "/tmp/gate4-attachment-only.sock";
  const attachment = select({
    CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1",
    CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: socketPath,
  });
  assert.equal(attachment.constructor.name, "CodexLinuxExternalAppServerSocketTransport");
  assert.equal(attachment.socketPath, socketPath);

  const ordinary = select({
    CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: socketPath,
  });
  assert.equal(ordinary.constructor.name, "LocalAppServerTransport");

  assert.throws(
    () => select({ CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1" }),
    /requires CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/,
  );
  assert.throws(
    () =>
      select(
        {
          CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY: "1",
          CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET: socketPath,
        },
        "ssh",
      ),
    /requires a local host/,
  );
});

test("attachment-only transport inode-binds the validated parent across a path swap", async () => {
  const tempDir = makeUnixSocketTempDir();
  const parentDir = path.join(tempDir, "authority");
  const heldParentDir = path.join(tempDir, "authority-held");
  const replacementDir = path.join(tempDir, "replacement");
  const socketPath = path.join(parentDir, "app-server.sock");
  const replacementSocketPath = path.join(replacementDir, "app-server.sock");
  fs.mkdirSync(parentDir, { mode: 0o700 });
  fs.mkdirSync(replacementDir, { mode: 0o700 });
  const originalServer = await listenUnix(socketPath);
  const replacementServer = await listenUnix(replacementSocketPath);
  fs.chmodSync(socketPath, 0o600);
  fs.chmodSync(replacementSocketPath, 0o600);
  const originalIdentity = pathIdentity(socketPath);
  const replacementIdentity = pathIdentity(replacementSocketPath);
  let swapped = false;
  const tracking = trackedAttachmentFs({
    afterFstat() {
      if (swapped) return;
      fs.renameSync(parentDir, heldParentDir);
      fs.renameSync(replacementDir, parentDir);
      swapped = true;
    },
  });
  const proxy = fakeChild();
  let spawnedSocketPath = null;
  let spawnedSocketIdentity = null;
  const Transport = loadInjectedAttachmentTransport({
    fsImpl: tracking.fsImpl,
    spawnImpl(_command, args) {
      spawnedSocketPath = args.at(-1);
      spawnedSocketIdentity = pathIdentity(spawnedSocketPath);
      return proxy;
    },
  });
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";

  try {
    const transport = new Transport(socketPath);
    await transport.connect();
    assert.equal(swapped, true, "test must replace the configured parent after its fd is bound");
    assert.match(
      spawnedSocketPath,
      new RegExp(`^/proc/${process.pid}/fd/\\d+/app-server\\.sock$`),
    );
    assert.deepEqual(spawnedSocketIdentity, originalIdentity);
    assert.deepEqual(pathIdentity(socketPath), replacementIdentity);
    assert.equal(tracking.openFds.size, 0, "validation fd must close after WebSocket open");
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    const proxyClosed = once(proxy, "close");
    transport.dispose();
    await proxyClosed;
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    await Promise.all([closeServer(originalServer), closeServer(replacementServer)]);
    for (const fd of tracking.openFds) fs.closeSync(fd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("attachment-only transport closes each validation fd on every connect exit", async (t) => {
  await withAttachmentSocket(async ({ socketPath }) => {
    async function runCase(name, {
      assertAfterConnect = () => {},
      expectedError = null,
      spawnImpl = () => fakeChild(),
      WebSocketImpl = null,
    }) {
      await t.test(name, async () => {
        const tracking = trackedAttachmentFs();
        const Transport = loadInjectedAttachmentTransport({
          fsImpl: tracking.fsImpl,
          spawnImpl,
          WebSocketImpl,
        });
        const transport = new Transport(socketPath);
        try {
          if (expectedError == null) await transport.connect();
          else await assert.rejects(transport.connect(), expectedError);
          await assertAfterConnect(transport);
          assert.equal(tracking.opened.length, 1);
          assert.equal(tracking.opened[0].flags & 3, fs.constants.O_RDONLY);
          assert.notEqual(tracking.opened[0].flags & fs.constants.O_DIRECTORY, 0);
          assert.notEqual(tracking.opened[0].flags & fs.constants.O_NOFOLLOW, 0);
          assert.equal(tracking.openFds.size, 0);
          assert.deepEqual(tracking.closed, [tracking.opened[0].fd]);
        } finally {
          transport.dispose();
          for (const fd of tracking.openFds) fs.closeSync(fd);
        }
      });
    }

    class ConstructorFailureWebSocket {
      constructor(_url, options) {
        options.createConnection();
        throw new Error("constructor failure");
      }
    }
    await runCase("successful WebSocket open", {});
    let failedProxy;
    await runCase("WebSocket construction failure after proxy creation", {
      assertAfterConnect: async (transport) => {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(failedProxy.killed, true);
        assert.equal(transport.proxyStreams.size, 0);
      },
      expectedError: /constructor failure/,
      spawnImpl() {
        failedProxy = fakeChild();
        return failedProxy;
      },
      WebSocketImpl: ConstructorFailureWebSocket,
    });

    await t.test("dispose while WebSocket open is pending", async () => {
      const tracking = trackedAttachmentFs();
      let webSocket;
      class PendingWebSocket extends EventEmitter {
        constructor(_url, options) {
          super();
          webSocket = this;
          this.stream = options.createConnection();
        }

        terminate() {
          this.stream.destroy();
        }
      }
      const Transport = loadInjectedAttachmentTransport({
        fsImpl: tracking.fsImpl,
        spawnImpl: () => fakeChild(),
        WebSocketImpl: PendingWebSocket,
      });
      const transport = new Transport(socketPath);
      const pending = transport.connect();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tracking.openFds.size, 1);
      transport.dispose();
      assert.equal(tracking.openFds.size, 0);
      webSocket.emit("close");
      await assert.rejects(pending, /closed before opening/);
      assert.deepEqual(tracking.closed, [tracking.opened[0].fd]);
    });
  });
});

test("concurrent attachment connects own independent validation fds", async () => {
  await withAttachmentSocket(async ({ socketPath }) => {
    const tracking = trackedAttachmentFs();
    const webSockets = [];
    class PendingWebSocket extends EventEmitter {
      constructor(_url, options) {
        super();
        this.stream = options.createConnection();
        webSockets.push(this);
      }

      terminate() {
        this.stream.destroy();
      }
    }
    const Transport = loadInjectedAttachmentTransport({
      fsImpl: tracking.fsImpl,
      spawnImpl: () => fakeChild(),
      WebSocketImpl: PendingWebSocket,
    });
    const transport = new Transport(socketPath);
    const first = transport.connect();
    const second = transport.connect();
    assert.equal(tracking.openFds.size, 2);
    assert.notEqual(tracking.opened[0].fd, tracking.opened[1].fd);
    webSockets[0].emit("open");
    await first;
    assert.equal(tracking.openFds.size, 1);
    webSockets[1].emit("open");
    await second;
    assert.equal(tracking.openFds.size, 0);
    assert.equal(new Set(tracking.closed).size, 2);
    transport.dispose();
    for (const fd of tracking.openFds) fs.closeSync(fd);
  });
});

test("attachment-only transport disposes its proxy without changing the external socket", async () => {
  await withAttachmentSocket(async ({ socketPath }) => {
    const before = fs.lstatSync(socketPath);
    const spawnCalls = [];
    const proxy = fakeChild();
    const Transport = loadInjectedAttachmentTransport({
      spawnImpl(command, args) {
        spawnCalls.push({ command, args: Array.from(args) });
        return proxy;
      },
    });
    const transport = new Transport(socketPath);
    await transport.connect();
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, "/fake/codex");
    assert.deepEqual(spawnCalls[0].args.slice(0, -1), ["app-server", "proxy", "--sock"]);
    assert.match(
      spawnCalls[0].args.at(-1),
      new RegExp(`^/proc/${process.pid}/fd/\\d+/app-server\\.sock$`),
    );

    const proxyClosed = once(proxy, "close");
    transport.dispose();
    await proxyClosed;

    const after = fs.lstatSync(socketPath);
    assert.equal(`${after.dev}:${after.ino}`, `${before.dev}:${before.ino}`);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    assert.equal(proxy.killed, true);
  }, { parentMode: 0o755, socketMode: 0o700 });
});

test("attachment-only transport rejects every untrusted endpoint without mutation", async (t) => {
  async function withEndpointFixture(callback) {
    const tempDir = makeUnixSocketTempDir();
    const socketPath = path.join(tempDir, "app-server.sock");
    const servers = [];
    const listen = async (candidate = socketPath, mode = 0o600) => {
      const server = await listenUnix(candidate);
      servers.push(server);
      fs.chmodSync(candidate, mode);
      return server;
    };
    try {
      return await callback({
        listen,
        reject: (options) => assertAttachmentValidationRejects({ socketPath, ...options }),
        socketPath,
        tempDir,
      });
    } finally {
      await Promise.all(servers.map(closeServer));
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async function rejectEndpoint(name, expectedError, prepare = () => ({})) {
    await t.test(name, () =>
      withEndpointFixture(async (fixture) =>
        fixture.reject({ expectedError, ...(await prepare(fixture)) }),
      ),
    );
  }

  await rejectEndpoint("missing socket", /ENOENT|does not exist/);
  await rejectEndpoint("relative configured path", /requires an absolute path/, async ({ listen, socketPath }) => {
    await listen();
    return { socketPath: path.relative(process.cwd(), socketPath) };
  });
  await rejectEndpoint("lexical parent alias", /parent path is not canonical/, async ({ listen, tempDir }) => {
      const parentDir = path.join(tempDir, "authority");
      fs.mkdirSync(parentDir, { mode: 0o700 });
      const socketPath = path.join(parentDir, "app-server.sock");
      await listen(socketPath);
      return { socketPath: `${parentDir}/../authority/app-server.sock` };
  });
  await rejectEndpoint("direct parent symlink", /parent is not a real directory/, async ({ listen, tempDir }) => {
      const realParent = path.join(tempDir, "real");
      const linkedParent = path.join(tempDir, "linked");
      fs.mkdirSync(realParent, { mode: 0o700 });
      fs.symlinkSync(realParent, linkedParent);
      await listen(path.join(realParent, "app-server.sock"));
      return { socketPath: path.join(linkedParent, "app-server.sock") };
  });
  await rejectEndpoint("intermediate parent symlink", /parent path contains a symlink/, async ({ listen, tempDir }) => {
      const realRoot = path.join(tempDir, "real-root");
      const realParent = path.join(realRoot, "nested");
      const linkedRoot = path.join(tempDir, "linked-root");
      fs.mkdirSync(realParent, { recursive: true, mode: 0o700 });
      fs.symlinkSync(realRoot, linkedRoot);
      await listen(path.join(realParent, "app-server.sock"));
      return { socketPath: path.join(linkedRoot, "nested", "app-server.sock") };
  });
  await rejectEndpoint("leaf symlink", /endpoint is not a real Unix socket/, async ({ listen, socketPath, tempDir }) => {
      const realSocketPath = path.join(tempDir, "real.sock");
      await listen(realSocketPath);
      fs.symlinkSync(realSocketPath, socketPath);
  });
  await rejectEndpoint("current UID unavailable", /current UID is unavailable/, async ({ listen }) => {
    await listen();
    return { processImpl: { env: process.env } };
  });

  for (const [name, inspectedPath] of [
    ["wrong-owner parent", "parent"],
    ["wrong-owner socket", "socket"],
  ]) {
    await rejectEndpoint(
      name,
      inspectedPath === "parent" ? /parent has unexpected owner/ : /socket has unexpected owner/,
      async ({ listen, socketPath, tempDir }) => {
        await listen();
        const wrongOwnerPath = inspectedPath === "parent" ? tempDir : socketPath;
        const wrongOwnerFs = {
          ...fs,
          lstatSync(candidate, ...args) {
            const stat = fs.lstatSync(candidate, ...args);
            const isInspectedSocket =
              inspectedPath === "socket" &&
              (candidate === wrongOwnerPath ||
                /^\/proc\/self\/fd\/\d+\/app-server\.sock$/.test(candidate));
            if (candidate !== wrongOwnerPath && !isInspectedSocket) return stat;
            return new Proxy(stat, {
              get(target, property, receiver) {
                if (property === "uid") return target.uid + 1;
                return Reflect.get(target, property, receiver);
              },
            });
          },
        };
        return { fsImpl: wrongOwnerFs };
      },
    );
  }

  for (const [name, property, value, expectedError] of [
    ["opened parent inode changed", "ino", (stat) => stat.ino + 1, /parent changed during validation/],
    ["opened parent owner changed", "uid", (stat) => stat.uid + 1, /parent has unexpected owner/],
    [
      "opened parent owner access changed",
      "mode",
      (stat) => (stat.mode & ~0o777) | 0o300,
      /parent owner read and execute permissions are required/,
    ],
    [
      "opened parent became group-writable",
      "mode",
      (stat) => stat.mode | 0o020,
      /parent has unsafe permissions/,
    ],
  ]) {
    await rejectEndpoint(name, expectedError, async ({ listen }) => {
        await listen();
        const fstatFs = {
          ...fs,
          fstatSync(fd, ...args) {
            const stat = fs.fstatSync(fd, ...args);
            return new Proxy(stat, {
              get(target, candidate, receiver) {
                if (candidate === property) return value(target);
                return Reflect.get(target, candidate, receiver);
              },
            });
          },
        };
        return { fsImpl: fstatFs };
      });
  }

  await rejectEndpoint("group-writable parent", /parent has unsafe permissions/, async ({ listen, tempDir }) => {
      await listen();
      fs.chmodSync(tempDir, 0o720);
  });

  await rejectEndpoint(
    "parent owner execute bit missing",
    /parent owner read and execute permissions are required/,
    async ({ listen, tempDir }) => {
      await listen();
      const modeFs = {
        ...fs,
        lstatSync(candidate, ...args) {
          const stat = fs.lstatSync(candidate, ...args);
          if (candidate !== tempDir) return stat;
          return new Proxy(stat, {
            get(target, property, receiver) {
              if (property === "mode") return (target.mode & ~0o777) | 0o400;
              return Reflect.get(target, property, receiver);
            },
          });
        },
      };
      return { fsImpl: modeFs };
    },
  );

  await rejectEndpoint("parent is not a directory", /parent is not a real directory/, async ({ tempDir }) => {
      const parentPath = path.join(tempDir, "authority");
      fs.writeFileSync(parentPath, "", { mode: 0o600 });
      return { socketPath: path.join(parentPath, "app-server.sock") };
  });

  await rejectEndpoint("endpoint is not a socket", /endpoint is not a real Unix socket/, async ({ socketPath }) => {
      fs.writeFileSync(socketPath, "", { mode: 0o600 });
  });

  await rejectEndpoint("owner write bit missing", /socket owner read and write permissions are required/, async ({ listen, socketPath }) => {
      await listen(socketPath, 0o400);
  });

  await rejectEndpoint("group write bit", /socket has unsafe group or other permissions/, async ({ listen, socketPath }) => {
      await listen(socketPath, 0o620);
  });
});

test("patch leaves unsupported bundle shapes unchanged with a warning", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applyExternalAppServerAttachmentPatch("unrelated bundle"), "unrelated bundle");
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /external app-server attachment/i);
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
    assert.equal(applyExternalAppServerAttachmentPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /SSH WebSocket transport/);
});

test("descriptor is required-upstream and targets the main bundle", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["main-process-external-app-server-attachment", "main-bundle", "required-upstream"]],
  );
});


test("socket environment hook shell syntax is valid", () => {
  const result = spawnSync("bash", ["-n", socketEnvHook], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("real Codex proxy attaches through the Desktop parent-PID proc fd path", { timeout: 15000 }, async (t) => {
  const codexCli = process.env.CODEX_CLI_PATH;
  if (codexCli == null) {
    t.skip("set CODEX_CLI_PATH to run the real Codex app-server integration test");
    return;
  }

  const tempDir = makeUnixSocketTempDir();
  const codexHome = path.join(tempDir, "codex-home");
  const socketPath = path.join(tempDir, "authority", "app-server.sock");
  const parentDir = path.dirname(socketPath);
  const binDir = path.join(tempDir, "bin");
  const wrapperPath = path.join(binDir, "codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.mkdirSync(parentDir, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  const parentFd = fs.openSync(
    parentDir,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  const procSocketPath = `/proc/${process.pid}/fd/${parentFd}/${path.basename(socketPath)}`;
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
    DESKTOP_SOCKET: procSocketPath,
    PATH: `${binDir}:${process.env.PATH}`,
    REAL_CODEX: codexCli,
  };
  assertUnixSocketPath(socketPath);
  const authority = spawn(codexCli, ["app-server", "--listen", `unix://${socketPath}`], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const readAuthorityStderr = captureBoundedStderr(authority.stderr);
  let proxy;

  try {
    await waitForSocket(socketPath, authority, readAuthorityStderr);
    assert.equal(
      fs.statSync(socketPath).mode & 0o077,
      0,
      "app-server socket must not grant group/other access",
    );
    assert.deepEqual(pathIdentity(procSocketPath), pathIdentity(socketPath));

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
    fs.closeSync(parentFd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
