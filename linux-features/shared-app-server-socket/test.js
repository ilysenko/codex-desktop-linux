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
const attachedCli = path.join(__dirname, "attached-cli.sh");
const unixSocketPathMaxBytes = 107;
const testRuntimeRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "shared-app-server-socket-test-runtime-"),
);
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
const originalStateDir = process.env.CODEX_LINUX_APP_STATE_DIR;
process.env.XDG_RUNTIME_DIR = testRuntimeRoot;
process.env.CODEX_LINUX_APP_STATE_DIR = testRuntimeRoot;
test.after(() => {
  if (originalRuntimeDir == null) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
  if (originalStateDir == null) delete process.env.CODEX_LINUX_APP_STATE_DIR;
  else process.env.CODEX_LINUX_APP_STATE_DIR = originalStateDir;
  fs.rmSync(testRuntimeRoot, { recursive: true, force: true });
});

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

function procStat(pid, { state = "S", ppid, startTime, utime = "0" }) {
  const fields = Array(17).fill("0");
  fields[9] = utime;
  return `${pid} (codex) ${state} ${ppid} ${fields.join(" ")} ${startTime}\n`;
}

function writeAttachedCliFixtureFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, mode);
}

function createAttachedCliFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-attached-cli-"));
  const appId = "codex-desktop";
  const ownerPid = 41001;
  const authorityPid = 41002;
  const ownerStartTime = "7001";
  const authorityStartTime = "7002";
  const listenerInode = "9001";
  const recordDir = path.join(root, "runtime", appId, "app-server-bridge");
  const socketDir = path.join(root, "runtime", appId, "socket-private");
  const socketPath = path.join(socketDir, "app-server.sock");
  const lockPath = `${socketPath}.lock`;
  const recordPath = path.join(recordDir, "attached-cli-v1");
  const procRoot = path.join(root, "proc");
  const appDir = path.join(root, "app");
  const desktopPath = path.join(root, "bin", "ChatGPT");
  const codexPath = path.join(appDir, "resources", "codex");

  fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(recordDir, 0o700);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  writeAttachedCliFixtureFile(desktopPath, "desktop fixture\n", 0o755);
  writeAttachedCliFixtureFile(
    codexPath,
    "#!/usr/bin/env bash\nprintf '%s\\0' \"$@\" >\"${ATTACHED_TEST_ARGV_FILE:?}\"\nif [[ -n ${ATTACHED_TEST_READY_FILE:-} ]]; then\n  : >\"$ATTACHED_TEST_READY_FILE\"\n  exec sleep 60\nfi\nexit \"${ATTACHED_TEST_EXIT_STATUS:-0}\"\n",
    0o755,
  );
  writeAttachedCliFixtureFile(socketPath, "socket fixture\n", 0o600);
  writeAttachedCliFixtureFile(
    lockPath,
    `${ownerPid} ${ownerStartTime} ${authorityPid} ${authorityStartTime}\n`,
    0o600,
  );
  writeAttachedCliFixtureFile(
    recordPath,
    [
      "version=1",
      `app_id=${appId}`,
      `socket=${socketPath}`,
      `desktop=${desktopPath}`,
      `codex=${codexPath}`,
      "",
    ].join("\n"),
    0o600,
  );

  for (const [pid, processInfo] of [
    [ownerPid, { ppid: 1, startTime: ownerStartTime, executable: desktopPath }],
    [authorityPid, { ppid: ownerPid, startTime: authorityStartTime, executable: codexPath }],
  ]) {
    const processDir = path.join(procRoot, String(pid));
    fs.mkdirSync(processDir, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(processDir, "fd"), { mode: 0o700 });
    writeAttachedCliFixtureFile(
      path.join(processDir, "stat"),
      procStat(pid, processInfo),
      0o444,
    );
    const commandLine =
      pid === ownerPid
        ? [desktopPath]
        : [
            codexPath,
            "-c",
            "model=fixture",
            "app-server",
            "--listen",
            `unix://${socketPath}`,
          ];
    writeAttachedCliFixtureFile(
      path.join(processDir, "cmdline"),
      Buffer.from(`${commandLine.join("\0")}\0`),
      0o444,
    );
    fs.symlinkSync(processInfo.executable, path.join(processDir, "exe"));
    if (pid === authorityPid) {
      fs.symlinkSync(`socket:[${listenerInode}]`, path.join(processDir, "fd", "5"));
    }
    fs.chmodSync(path.join(processDir, "fd"), 0o500);
    fs.chmodSync(processDir, 0o555);
  }
  writeAttachedCliFixtureFile(
    path.join(procRoot, "net", "unix"),
    `0000000000000000: 00000002 00000000 00010000 0001 01 ${listenerInode} ${socketPath}\n`,
    0o444,
  );

  return {
    appDir,
    appId,
    authorityPid,
    authorityStartTime,
    codexPath,
    desktopPath,
    listenerInode,
    lockPath,
    ownerPid,
    ownerStartTime,
    procRoot,
    recordDir,
    recordPath,
    root,
    socketDir,
    socketPath,
  };
}

function attachedCliMetadata(filePath, fixture, changes = {}) {
  const metadata = fs.lstatSync(filePath);
  let kind;
  if (filePath === fixture.socketPath) kind = "socket";
  else if (metadata.isSymbolicLink()) kind = "symbolic link";
  else if (metadata.isDirectory()) kind = "directory";
  else if (metadata.isFile()) kind = "regular file";
  else kind = "unknown";
  return [
    changes.kind ?? kind,
    changes.mode ?? (metadata.mode & 0o777).toString(8),
    String(changes.uid ?? metadata.uid),
    String(changes.dev ?? metadata.dev),
    String(changes.ino ?? metadata.ino),
    changes.linkTarget ?? (metadata.isSymbolicLink() ? fs.readlinkSync(filePath) : ""),
  ].join("\t");
}

function removeAttachedCliFixture(fixture) {
  for (const pid of [fixture.ownerPid, fixture.authorityPid]) {
    const processDir = path.join(fixture.procRoot, String(pid));
    try {
      fs.chmodSync(processDir, 0o700);
      fs.chmodSync(path.join(processDir, "fd"), 0o700);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function writeAttachedCliProcessFile(fixture, pid, name, contents) {
  const filePath = path.join(fixture.procRoot, String(pid), name);
  fs.chmodSync(filePath, 0o644);
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o444);
}

function replaceAttachedCliProcessExe(fixture, pid, executable) {
  const processDir = path.join(fixture.procRoot, String(pid));
  const exePath = path.join(processDir, "exe");
  fs.chmodSync(processDir, 0o755);
  fs.unlinkSync(exePath);
  fs.symlinkSync(executable, exePath);
  fs.chmodSync(processDir, 0o555);
}

function selectAttachedCliSymlink(fixture) {
  const selected = path.join(fixture.root, "selected-codex");
  fs.symlinkSync(fixture.codexPath, selected);
  fs.writeFileSync(fixture.recordPath,
    fs.readFileSync(fixture.recordPath, "utf8").replace(`codex=${fixture.codexPath}`, `codex=${selected}`));
  const cmdline = path.join(fixture.procRoot, String(fixture.authorityPid), "cmdline");
  writeAttachedCliProcessFile(fixture, fixture.authorityPid, "cmdline",
    fs.readFileSync(cmdline).toString("utf8").replace(fixture.codexPath, selected));
  return selected;
}

const attachedCliSourcedTestPrelude = [
  'source "$1"',
  "attached_cli_effective_uid() {",
  "  printf '%s\\n' \"$ATTACHED_TEST_UID\"",
  "}",
  "attached_cli_filesystem_metadata() {",
  "  local target=$1 metadata kind link= _mode _uid _dev _ino",
  '  if [[ -n ${ATTACHED_TEST_MISSING_PATH:-} && $target == "$ATTACHED_TEST_MISSING_PATH" ]]; then',
  "    return 1",
  "  fi",
  '  if [[ -n ${ATTACHED_TEST_OVERRIDE_PATH:-} && $target == "$ATTACHED_TEST_OVERRIDE_PATH" ]]; then',
  "    printf '%s\\n' \"$ATTACHED_TEST_OVERRIDE_METADATA\"",
  "    return 0",
  "  fi",
  "  metadata=$(stat -c $'%F\\t%a\\t%u\\t%d\\t%i' -- \"$target\" 2>/dev/null) || return 1",
  "  kind=${metadata%%$'\\t'*}",
  '  if [[ $target == "$ATTACHED_TEST_SOCKET" ]]; then',
  "    metadata=\"socket\"$'\\t'\"${metadata#*$'\\t'}\"",
  "    kind=socket",
  "  fi",
  // Regular fixture symlinks have mode 777; real read/write proc FD links have mode 700.
  '  if [[ $target == "$ATTACHED_TEST_PROC"/*/fd/* && $kind == "symbolic link" ]]; then',
  "    IFS=$'\\t' read -r kind _mode _uid _dev _ino <<<\"$metadata\"",
  "    metadata=\"$kind\"$'\\t'700$'\\t'\"$_uid\"$'\\t'\"$_dev\"$'\\t'\"$_ino\"",
  "  fi",
  '  if [[ $kind == "symbolic link" ]]; then',
  '    link=$(readlink -- "$target" 2>/dev/null) || return 1',
  "  fi",
  "  printf '%s\\t%s\\n' \"$metadata\" \"$link\"",
  "}",
].join("\n");

function runAttachedCliSnapshot(fixture, options = {}) {
  const script = [
    attachedCliSourcedTestPrelude,
    'attached_cli_snapshot "$2" "$3"',
  ].join("\n");
  return spawnSync(
    "bash",
    ["-c", script, "attached-cli-test", attachedCli, fixture.recordDir, fixture.procRoot],
    {
      encoding: "utf8",
      env: attachedCliTestEnvironment(fixture, options),
    },
  );
}

function attachedCliTestEnvironment(fixture, options = {}) {
  return {
    ...process.env,
    ...options.environment,
    ATTACHED_TEST_ARGV_FILE: path.join(fixture.root, "codex.argv"),
    ATTACHED_TEST_MISSING_PATH: options.missingPath ?? "",
    ATTACHED_TEST_OVERRIDE_METADATA: options.overrideMetadata ?? "",
    ATTACHED_TEST_OVERRIDE_PATH: options.overridePath ?? "",
    ATTACHED_TEST_PROC: fixture.procRoot,
    ATTACHED_TEST_SOCKET: fixture.socketPath,
    ATTACHED_TEST_UID: String(process.getuid()),
    CODEX_LINUX_APP_DIR: fixture.appDir,
  };
}

async function waitForAttachedCliFile(filePath, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode != null) {
      throw new Error(`attached CLI exited before creating ${path.basename(filePath)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

function attachedCliMainCommand() {
  return [
    attachedCliSourcedTestPrelude,
    "record_dir=$2",
    "proc_root=$3",
    "shift 3",
    'attached_cli_main "$record_dir" "$proc_root" "$@"',
  ].join("\n");
}

function runAttachedCliMain(fixture, arguments_ = [], options = {}) {
  return spawnSync(
    "bash",
    [
      "-c",
      attachedCliMainCommand(),
      "attached-cli-test",
      attachedCli,
      fixture.recordDir,
      fixture.procRoot,
      ...arguments_,
    ],
    {
      encoding: "utf8",
      env: attachedCliTestEnvironment(fixture, options),
    },
  );
}

function spawnAttachedCliMain(fixture, arguments_ = [], options = {}) {
  return spawn(
    "bash",
    [
      "-c",
      attachedCliMainCommand(),
      "attached-cli-test",
      attachedCli,
      fixture.recordDir,
      fixture.procRoot,
      ...arguments_,
    ],
    {
      env: attachedCliTestEnvironment(fixture, options),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function attachedCliChildResult(child) {
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [code, signal] = await once(child, "exit");
  return {
    code,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function readNulArguments(filePath) {
  const parts = fs.readFileSync(filePath).toString("utf8").split("\0");
  assert.equal(parts.pop(), "");
  return parts;
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
  const InjectedTransport = context.Transport;
  class Transport extends InjectedTransport {
    constructor(socketPath, getConfigOverrides = async () => []) {
      super(socketPath, getConfigOverrides);
    }
  }
  return { InjectedTransport, Transport, namespace };
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

async function withAttachedCliEnvironment(values, callback) {
  const keys = [
    "CODEX_CLI_PATH",
    "CODEX_LINUX_APP_ID",
    "CODEX_LINUX_APP_STATE_DIR",
    "XDG_RUNTIME_DIR",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (values[key] == null) delete process.env[key];
      else process.env[key] = values[key];
    }
    return await callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
    "return new n.Cn({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator,getConfigOverrides:()=>Ope(e)})}function afterFactory(){}",
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

test("feature stages its socket hooks, orphan reaper, and attached CLI", () => {
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
        [
          [
            ".codex-linux/features/shared-app-server-socket/orphan-reaper.js",
            "644",
          ],
          [
            ".codex-linux/features/shared-app-server-socket/attached-cli.sh",
            "755",
          ],
        ],
      );
      const target = ".codex-linux/features/shared-app-server-socket/attached-cli.sh";
      const staged = path.join(appDir, target);
      assert.equal(fs.lstatSync(staged).isFile(), true);
      assert.equal(fs.statSync(staged).mode & 0o777, 0o755);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("attached CLI metadata is locale stable in sourced and direct modes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-app-server-attached-cli-locale-"));
  try {
    const runtimeRoot = path.join(root, "runtime");
    const recordDir = path.join(runtimeRoot, "codex-desktop", "app-server-bridge");
    const binDir = path.join(root, "bin");
    const statWrapper = path.join(binDir, "stat");
    const realStat = spawnSync("bash", ["-c", "command -v stat"], { encoding: "utf8" });
    assert.equal(realStat.status, 0, realStat.stderr);
    fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(recordDir, 0o700);
    writeAttachedCliFixtureFile(
      statWrapper,
      [
        "#!/usr/bin/env bash",
        'metadata=$("$ATTACHED_TEST_REAL_STAT" "$@") || exit $?',
        "if [[ ${LANGUAGE-} == de && ${LC_ALL-} != C ]]; then",
        "  metadata=${metadata/#directory/Verzeichnis}",
        "fi",
        "printf '%s\\n' \"$metadata\"",
        "",
      ].join("\n"),
      0o755,
    );
    const environment = {
      ...process.env,
      ATTACHED_TEST_REAL_STAT: realStat.stdout.trim(),
      CODEX_LINUX_APP_ID: "codex-desktop",
      LANG: "C",
      LANGUAGE: "de",
      PATH: `${binDir}:${process.env.PATH}`,
      XDG_RUNTIME_DIR: runtimeRoot,
    };
    delete environment.LC_ALL;
    const sourced = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; attached_cli_main "$2" /proc exec',
        "attached-cli-locale-test",
        attachedCli,
        recordDir,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(sourced.status, 1, sourced.stderr);
    assert.equal(sourced.stdout, "");
    assert.equal(sourced.stderr, "codex-desktop: Desktop shared app server is not available\n");

    const direct = spawnSync("bash", [attachedCli, "exec"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(direct.status, 1, direct.stderr);
    assert.equal(direct.stdout, "");
    assert.equal(
      direct.stderr,
      "codex-desktop: Desktop shared app server is not available\n",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attached CLI verifier accepts real Linux listeners and accepted connections", async (t) => {
  const root = makeSocketTempDir("attached-cli-kernel-");
  const recordDir = path.join(root, "codex-desktop", "app-server-bridge");
  const socketPath = path.join(root, "app-server.sock");
  const readyPath = path.join(root, "ready");
  const acceptedPath = path.join(root, "accepted");
  const executable = fs.readlinkSync(`/proc/${process.pid}/exe`);
  const selectedExecutable = path.join(root, "selected-codex");
  let authority;
  let client;
  try {
    fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(executable, selectedExecutable);
    writeAttachedCliFixtureFile(path.join(root, "app-server"), [
      'const fs = require("node:fs");',
      'const net = require("node:net");',
      'const socketPath = process.argv.at(-1).replace("unix://", "");',
      // Keep a real write-only descriptor open alongside the read/write listener.
      'fs.openSync("output", "w");',
      'const server = net.createServer(() => fs.writeFileSync("accepted", ""));',
      'server.listen(socketPath, () => {',
      '  fs.chmodSync(socketPath, 0o600);',
      '  fs.writeFileSync("ready", "");',
      '});',
    ].join("\n"), 0o600);
    authority = spawn(selectedExecutable, ["app-server", "--listen", `unix://${socketPath}`], {
      cwd: root,
      stdio: "ignore",
    });
    await waitForAttachedCliFile(readyPath, authority);
    const ownerStart = processStartTime(process.pid);
    const authorityStart = processStartTime(authority.pid);
    assert.notEqual(ownerStart, null);
    assert.notEqual(authorityStart, null);
    writeAttachedCliFixtureFile(`${socketPath}.lock`,
      `${process.pid} ${ownerStart} ${authority.pid} ${authorityStart}\n`, 0o600);
    writeAttachedCliFixtureFile(path.join(recordDir, "attached-cli-v1"), [
      "version=1", "app_id=codex-desktop", `socket=${socketPath}`,
      `desktop=${executable}`, `codex=${selectedExecutable}`, "",
    ].join("\n"), 0o600);

    for (const connected of [false, true]) {
      await t.test(connected ? "with an accepted stream" : "with a write-only FD", async () => {
        if (connected) {
          client = net.createConnection(socketPath);
          await once(client, "connect");
          await waitForAttachedCliFile(acceptedPath, authority);
          const rows = fs.readFileSync("/proc/net/unix", "utf8").split("\n")
            .filter((line) => line.endsWith(` ${socketPath}`));
          assert.ok(rows.some((line) => / 00010000 0001 01 /.test(line)), "listener row");
          assert.ok(rows.some((line) => / 00000000 0001 03 /.test(line)), "accepted stream row");
        }
        const fdDir = `/proc/${authority.pid}/fd`;
        const modes = fs.readdirSync(fdDir)
          .map((fd) => fs.lstatSync(path.join(fdDir, fd)).mode & 0o777);
        assert.ok(modes.includes(0o300));
        assert.ok(modes.includes(0o700));
        const result = spawnSync("bash", ["-c",
          'source "$1"; attached_cli_snapshot "$2" /proc',
          "attached-cli-kernel-test", attachedCli, recordDir,
        ], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
      });
    }
  } finally {
    client?.destroy();
    if (authority != null && authority.exitCode == null) {
      authority.kill("SIGKILL");
      await once(authority, "exit");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attached CLI executes the verified target of a selected symlink and rejects retargeting", () => {
  const fixture = createAttachedCliFixture();
  try {
    const selected = selectAttachedCliSymlink(fixture);
    const argvPath = path.join(fixture.root, "codex.argv");
    const executedPath = path.join(fixture.root, "executed");
    fs.writeFileSync(fixture.codexPath,
      fs.readFileSync(fixture.codexPath, "utf8").replace(
        "#!/usr/bin/env bash\n", '#!/usr/bin/env bash\nprintf "%s" "$0" >"$ATTACHED_TEST_EXECUTED"\n'));
    const result = runAttachedCliMain(fixture, ["exec", "prompt"], {
      environment: { ATTACHED_TEST_EXECUTED: executedPath },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(executedPath, "utf8"), fixture.codexPath);
    assert.deepEqual(readNulArguments(argvPath), ["--remote", `unix://${fixture.socketPath}`, "exec", "prompt"]);

    fs.unlinkSync(selected);
    fs.symlinkSync(fixture.desktopPath, selected);
    fs.unlinkSync(argvPath);
    const rejected = runAttachedCliMain(fixture, ["exec", "prompt"]);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.stderr, "codex-desktop: shared app-server authority does not match Desktop\n");
    assert.equal(fs.existsSync(argvPath), false);
  } finally {
    removeAttachedCliFixture(fixture);
  }
});

test("attached CLI verifier rejects record metadata", () => {
  const fixtureFiles = (fixture) => [
    fixture.recordPath,
    fixture.lockPath,
    path.join(fixture.procRoot, String(fixture.ownerPid), "stat"),
    path.join(fixture.procRoot, String(fixture.ownerPid), "cmdline"),
    path.join(fixture.procRoot, String(fixture.authorityPid), "stat"),
    path.join(fixture.procRoot, String(fixture.authorityPid), "cmdline"),
    path.join(fixture.procRoot, "net", "unix"),
  ];
  const runCase = ({ expected, mutate, missingPath, metadataPath, metadataChanges }) => {
    const fixture = createAttachedCliFixture();
    try {
      mutate?.(fixture);
      const before = fixtureFiles(fixture).map((filePath) => fs.readFileSync(filePath));
      const overrideMetadata = metadataPath
        ? attachedCliMetadata(metadataPath(fixture), fixture, metadataChanges)
        : undefined;
      const result = runAttachedCliSnapshot(fixture, {
        missingPath: missingPath?.(fixture),
        overrideMetadata,
        overridePath: metadataPath?.(fixture),
      });
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual(
        fixtureFiles(fixture).map((filePath) => fs.readFileSync(filePath)),
        before,
      );
    } finally {
      removeAttachedCliFixture(fixture);
    }
  };

  runCase({ expected: 0 });

  const validRecord = (fixture) => fs.readFileSync(fixture.recordPath, "utf8").trimEnd().split("\n");
  for (const mutate of [
    (fixture) => {
      const fields = validRecord(fixture);
      [fields[1], fields[2]] = [fields[2], fields[1]];
      fs.writeFileSync(fixture.recordPath, `${fields.join("\n")}\n`);
    },
    (fixture) => {
      const fields = validRecord(fixture);
      fields[1] = "app_id=";
      fs.writeFileSync(fixture.recordPath, `${fields.join("\n")}\n`);
    },
    (fixture) => {
      const fields = validRecord(fixture);
      fields.splice(3, 0, fields[2]);
      fs.writeFileSync(fixture.recordPath, `${fields.join("\n")}\n`);
    },
    (fixture) => {
      const fields = validRecord(fixture);
      fields.splice(3, 0, "injected=value");
      fs.writeFileSync(fixture.recordPath, `${fields.join("\n")}\n`);
    },
    (fixture) => {
      fs.writeFileSync(fixture.recordPath, validRecord(fixture).join("\n"));
    },
    (fixture) => {
      const contents = fs.readFileSync(fixture.recordPath);
      fs.writeFileSync(fixture.recordPath, Buffer.concat([contents, Buffer.from([0])]));
    },
    (fixture) => {
      const contents = fs.readFileSync(fixture.recordPath);
      fs.writeFileSync(fixture.recordPath, Buffer.concat([contents, Buffer.from("trailing")]));
    },
  ]) {
    runCase({ expected: 11, mutate });
  }

  for (const [metadataPath, metadataChanges] of [
    [(fixture) => fixture.recordPath, { kind: "symbolic link", linkTarget: "/unsafe" }],
    [(fixture) => fixture.recordPath, { kind: "directory" }],
    [(fixture) => fixture.recordPath, { mode: "644" }],
    [(fixture) => fixture.recordPath, { uid: process.getuid() + 1 }],
    [(fixture) => fixture.recordDir, { kind: "symbolic link", linkTarget: "/unsafe" }],
    [(fixture) => fixture.recordDir, { kind: "regular file" }],
    [(fixture) => fixture.recordDir, { mode: "755" }],
    [(fixture) => fixture.recordDir, { uid: process.getuid() + 1 }],
    [(fixture) => fixture.socketDir, { kind: "symbolic link", linkTarget: "/unsafe" }],
    [(fixture) => fixture.socketDir, { kind: "regular file" }],
    [(fixture) => fixture.socketDir, { mode: "755" }],
    [(fixture) => fixture.socketDir, { uid: process.getuid() + 1 }],
    [(fixture) => fixture.socketPath, { kind: "symbolic link", linkTarget: "/unsafe" }],
    [(fixture) => fixture.socketPath, { kind: "regular file" }],
    [(fixture) => fixture.socketPath, { mode: "660" }],
    [(fixture) => fixture.socketPath, { uid: process.getuid() + 1 }],
    [(fixture) => path.join(fixture.procRoot, String(fixture.authorityPid), "fd", "5"), { uid: process.getuid() + 1 }],
    [(fixture) => path.join(fixture.procRoot, String(fixture.authorityPid), "fd", "5"), { mode: "777" }],
    [(fixture) => path.join(fixture.procRoot, String(fixture.authorityPid), "fd", "5"), { kind: "regular file" }],
    [(fixture) => fixture.lockPath, { kind: "symbolic link", linkTarget: "/unsafe" }],
    [(fixture) => fixture.lockPath, { kind: "directory" }],
    [(fixture) => fixture.lockPath, { mode: "644" }],
    [(fixture) => fixture.lockPath, { uid: process.getuid() + 1 }],
    [
      (fixture) => path.join(fixture.procRoot, String(fixture.ownerPid)),
      { kind: "symbolic link", linkTarget: "/unsafe" },
    ],
    [
      (fixture) => path.join(fixture.procRoot, String(fixture.ownerPid)),
      { kind: "regular file" },
    ],
    [(fixture) => path.join(fixture.procRoot, String(fixture.ownerPid)), { mode: "500" }],
    [
      (fixture) => path.join(fixture.procRoot, String(fixture.ownerPid)),
      { uid: process.getuid() + 1 },
    ],
  ]) {
    runCase({ expected: 11, metadataPath, metadataChanges });
  }

  for (const lockContents of [
    "",
    "41001 7001 41002\n",
    "41001 7001 41002 7002 trailing\n",
    "41001 07001 41002 7002\n",
    "41001 7001 41002 7002\n41003 7003 41004 7004\n",
    "41001 7001 41002 7002\ntrailing",
  ]) {
    runCase({
      expected: 11,
      mutate(fixture) {
        fs.writeFileSync(fixture.lockPath, lockContents);
      },
    });
  }

  for (const missingPath of [
    (fixture) => fixture.recordPath,
    (fixture) => fixture.lockPath,
    (fixture) => fixture.socketPath,
    (fixture) => path.join(fixture.procRoot, String(fixture.ownerPid)),
    (fixture) => path.join(fixture.procRoot, String(fixture.authorityPid)),
  ]) {
    runCase({ expected: 10, missingPath });
  }
});

test("attached CLI verifier rejects stale authority identity", () => {
  const runCase = ({ expected, mutate }) => {
    const fixture = createAttachedCliFixture();
    try {
      mutate?.(fixture);
      const recordBefore = fs.readFileSync(fixture.recordPath);
      const lockBefore = fs.readFileSync(fixture.lockPath);
      const result = runAttachedCliSnapshot(fixture);
      assert.equal(result.status, expected, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual(fs.readFileSync(fixture.recordPath), recordBefore);
      assert.deepEqual(fs.readFileSync(fixture.lockPath), lockBefore);
    } finally {
      removeAttachedCliFixture(fixture);
    }
  };
  const writeAuthorityArguments = (fixture, arguments_) => {
    writeAttachedCliProcessFile(
      fixture,
      fixture.authorityPid,
      "cmdline",
      Buffer.from(`${arguments_.join("\0")}\0`),
    );
  };
  const writeListenerTable = (fixture, contents) => {
    writeAttachedCliProcessFile(fixture, "net", "unix", contents);
  };

  runCase({
    expected: 0,
    mutate(fixture) {
      writeAuthorityArguments(fixture, [
        fixture.codexPath,
        "app-server",
        "--listen",
        `unix://${fixture.socketPath}`,
      ]);
    },
  });
  runCase({
    expected: 0,
    mutate(fixture) {
      writeAuthorityArguments(fixture, [
        fixture.codexPath,
        "-c",
        "model=fixture",
        "-c",
        "approval_policy=never",
        "app-server",
        "--listen",
        `unix://${fixture.socketPath}`,
      ]);
    },
  });

  for (const mutate of [
    (fixture) =>
      writeAttachedCliProcessFile(
        fixture,
        fixture.ownerPid,
        "stat",
        procStat(fixture.ownerPid, {
          state: "Z",
          ppid: 1,
          startTime: fixture.ownerStartTime,
        }),
      ),
    (fixture) =>
      writeAttachedCliProcessFile(
        fixture,
        fixture.authorityPid,
        "stat",
        procStat(fixture.authorityPid, {
          state: "Z",
          ppid: fixture.ownerPid,
          startTime: fixture.authorityStartTime,
        }),
      ),
  ]) {
    runCase({ expected: 10, mutate });
  }

  for (const mutate of [
    (fixture) =>
      writeAttachedCliProcessFile(
        fixture,
        fixture.ownerPid,
        "stat",
        procStat(fixture.ownerPid, { ppid: 1, startTime: "8001" }),
      ),
    (fixture) =>
      writeAttachedCliProcessFile(
        fixture,
        fixture.authorityPid,
        "stat",
        procStat(fixture.authorityPid, { ppid: fixture.ownerPid, startTime: "8002" }),
      ),
    (fixture) => replaceAttachedCliProcessExe(fixture, fixture.ownerPid, fixture.codexPath),
    (fixture) =>
      writeAttachedCliProcessFile(
        fixture,
        fixture.authorityPid,
        "stat",
        procStat(fixture.authorityPid, { ppid: 1, startTime: fixture.authorityStartTime }),
      ),
    (fixture) => replaceAttachedCliProcessExe(fixture, fixture.authorityPid, fixture.desktopPath),
  ]) {
    runCase({ expected: 12, mutate });
  }

  for (const argumentsForAuthority of [
    (f) => ["wrong-codex", "app-server", "--listen", `unix://${f.socketPath}`],
    (f) => [f.codexPath, "-c", "model=fixture", "app-server", "--listen"],
    (f) => [f.codexPath, "app-server", "--listen", "unix:///wrong.sock"],
    (f) => [f.codexPath, "app-server", `--listen=unix://${f.socketPath}`],
    (f) => [f.codexPath, "-c", "model=fixture", "-c", "app-server", "--listen", `unix://${f.socketPath}`],
    (f) => [f.codexPath, "app-server", "--listen", `unix://${f.socketPath}`, "trailing"],
    (f) => [f.codexPath, "mcp-server", "--listen", `unix://${f.socketPath}`],
  ]) {
    runCase({
      expected: 12,
      mutate(fixture) {
        writeAuthorityArguments(fixture, argumentsForAuthority(fixture));
      },
    });
  }

  runCase({
    expected: 10,
    mutate(fixture) {
      writeListenerTable(fixture, "");
    },
  });
  runCase({
    expected: 10,
    mutate(fixture) {
      writeListenerTable(
        fixture,
        `0000000000000000: 00000003 00000000 00000000 0001 03 ${fixture.listenerInode} ${fixture.socketPath}\n`,
      );
    },
  });
  runCase({
    expected: 12,
    mutate(fixture) {
      writeListenerTable(
        fixture,
        `0000000000000000: 00000002 00000000 00000000 0001 01 ${fixture.listenerInode} ${fixture.socketPath}\n`,
      );
    },
  });
  runCase({
    expected: 0,
    mutate(fixture) {
      const line = `0000000000000000: 00000002 00000000 00010000 0001 01 ${fixture.listenerInode} ${fixture.socketPath}\n`;
      writeListenerTable(fixture, `${line}${line}`);
    },
  });
  runCase({
    expected: 12,
    mutate(fixture) {
      const line = `0000000000000000: 00000002 00000000 00010000 0001 01 ${fixture.listenerInode} ${fixture.socketPath}\n`;
      writeListenerTable(
        fixture,
        `${line}0000000000000001: 00000002 00000000 00010000 0001 01 9002 ${fixture.socketPath}\n`,
      );
    },
  });
  runCase({
    expected: 12,
    mutate(fixture) {
      const fdDir = path.join(fixture.procRoot, String(fixture.authorityPid), "fd");
      fs.chmodSync(fdDir, 0o700);
      fs.unlinkSync(path.join(fdDir, "5"));
      fs.symlinkSync("socket:[9999]", path.join(fdDir, "5"));
      fs.chmodSync(fdDir, 0o500);
    },
  });
});

test("attached CLI verifier reports redacted failure categories", () => {
  const cases = [
    {
      expected: "codex-desktop: Desktop shared app server is not available\n",
      mutate(fixture) {
        writeAttachedCliProcessFile(
          fixture,
          fixture.ownerPid,
          "stat",
          procStat(fixture.ownerPid, {
            state: "Z",
            ppid: 1,
            startTime: fixture.ownerStartTime,
          }),
        );
      },
    },
    {
      expected: "codex-desktop: Desktop shared app-server state is unsafe\n",
      options(fixture) {
        return {
          overrideMetadata: attachedCliMetadata(fixture.recordPath, fixture, { mode: "644" }),
          overridePath: fixture.recordPath,
        };
      },
    },
    {
      expected: "codex-desktop: shared app-server authority does not match Desktop\n",
      mutate(fixture) {
        replaceAttachedCliProcessExe(fixture, fixture.authorityPid, fixture.desktopPath);
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createAttachedCliFixture();
    try {
      testCase.mutate?.(fixture);
      const secretArgument = "caller-secret-argument";
      const result = runAttachedCliMain(
        fixture,
        ["exec", secretArgument],
        testCase.options?.(fixture),
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, testCase.expected);
      assert.equal(fs.existsSync(path.join(fixture.root, "codex.argv")), false);
    } finally {
      removeAttachedCliFixture(fixture);
    }
  }
});

for (const { name, owner = false, changes, accepted = false, retarget = false } of [
  { name: "accepts owner CPU accounting changes", owner: true, changes: { utime: "1" }, accepted: true },
  { name: "accepts authority scheduling changes", changes: { state: "R" }, accepted: true },
  { name: "rejects final snapshot identity change", changes: { startTime: "9999" } },
  { name: "rejects authority death between snapshots", changes: { state: "Z" } },
  { name: "rejects selected symlink replacement during verification", changes: {}, retarget: true },
]) {
  test(`attached CLI verifier ${name}`, async () => {
    const fixture = createAttachedCliFixture();
    let writer;
    try {
      const selected = retarget ? selectAttachedCliSymlink(fixture) : "";
      const pid = owner ? fixture.ownerPid : fixture.authorityPid;
      const ppid = owner ? 1 : fixture.ownerPid;
      const startTime = owner ? fixture.ownerStartTime : fixture.authorityStartTime;
      const statPath = path.join(fixture.procRoot, String(pid), "stat");
      const processDir = path.dirname(statPath);
      const initial = procStat(pid, { ppid, startTime });
      const changed = procStat(pid, { ppid, startTime, ...changes });
      fs.chmodSync(processDir, 0o755);
      fs.unlinkSync(statPath);
      const fifo = spawnSync("mkfifo", [statPath], { encoding: "utf8" });
      assert.equal(fifo.status, 0, fifo.stderr);
      fs.chmodSync(statPath, 0o644);
      fs.chmodSync(processDir, 0o555);

      writer = spawn(
        "bash",
        [
          "-c",
          'printf "%s" "$2" >"$1"; sleep 0.1; if [[ -n $5 ]]; then ln -sfn -- "$4" "$5"; fi; printf "%s" "$3" >"$1"',
          "attached-cli-fifo-writer",
          statPath,
          initial,
          changed,
          fixture.desktopPath,
          selected,
        ],
        { stdio: "ignore" },
      );
      const fifoMetadata = attachedCliMetadata(statPath, fixture, {
        kind: "regular empty file",
        mode: "444",
      });
      const result = await attachedCliChildResult(
        spawnAttachedCliMain(fixture, ["exec", "final-snapshot-secret"], {
          overrideMetadata: fifoMetadata,
          overridePath: statPath,
        }),
      );
      if (writer.exitCode == null) {
        writer.kill("SIGKILL");
        await once(writer, "exit");
      }
      writer = null;
      assert.equal(result.code, accepted ? 0 : 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, accepted ? "" : "codex-desktop: Desktop shared app-server state is unsafe\n");
      const argvPath = path.join(fixture.root, "codex.argv");
      assert.equal(fs.existsSync(argvPath), accepted);
      if (accepted) {
        assert.deepEqual(readNulArguments(argvPath), [
          "--remote", `unix://${fixture.socketPath}`, "exec", "final-snapshot-secret",
        ]);
      }
    } finally {
      if (writer != null && writer.exitCode == null) writer.kill("SIGKILL");
      removeAttachedCliFixture(fixture);
    }
  });
}

test("attached CLI verifier rejects caller authority grammar", () => {
  const forbiddenArguments = [
    ["--remote"],
    ["--remote=unix:///caller.sock"],
    ["--remote-auth-token-env"],
    ["--remote-auth-token-env=CALLER_TOKEN"],
    ["--sock"],
    ["--sock=/caller.sock"],
    ["--listen"],
    ["--listen=unix:///caller.sock"],
    ["unix:///caller.sock"],
    ["ws://caller.invalid"],
    ["wss://caller.invalid"],
    ["app-server"],
    ["remote-control"],
    ["mcp-server"],
    ["exec-server"],
    ["help", "--remote=unix:///caller.sock"],
  ];
  for (const arguments_ of forbiddenArguments) {
    const fixture = createAttachedCliFixture();
    try {
      const result = runAttachedCliMain(fixture, arguments_, {
        missingPath: fixture.recordPath,
      });
      assert.equal(result.status, 2, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "codex-desktop: --cli does not accept caller endpoint or authority options\n",
      );
      assert.equal(fs.existsSync(path.join(fixture.root, "codex.argv")), false);
    } finally {
      removeAttachedCliFixture(fixture);
    }
  }

  const fixture = createAttachedCliFixture();
  try {
    const literalArguments = [
      "exec",
      "--",
      "--remote",
      "unix:///literal.sock",
      "app-server",
      "caller-literal",
    ];
    const result = runAttachedCliMain(fixture, literalArguments);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(readNulArguments(path.join(fixture.root, "codex.argv")), [
      "--remote", `unix://${fixture.socketPath}`, ...literalArguments,
    ]);
  } finally {
    removeAttachedCliFixture(fixture);
  }
});

test("attached CLI verifier bypasses only stock introspection", () => {
  for (const arguments_ of [
    ["-h"],
    ["--help"],
    ["-V"],
    ["--version"],
    ["help"],
    ["help", "exec"],
    ["help", "--", "--remote=literal"],
  ]) {
    const fixture = createAttachedCliFixture();
    try {
      const argvFile = path.join(fixture.root, "codex.argv");
      const result = runAttachedCliMain(fixture, arguments_, {
        missingPath: fixture.recordPath,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.deepEqual(readNulArguments(argvFile), arguments_);
    } finally {
      removeAttachedCliFixture(fixture);
    }
  }

  for (const arguments_ of [[], ["helpish"], ["--help=all"], ["-h", "extra"], ["--version", "extra"]]) {
    const fixture = createAttachedCliFixture();
    try {
      const result = runAttachedCliMain(fixture, arguments_, {
        missingPath: fixture.recordPath,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "codex-desktop: Desktop shared app server is not available\n",
      );
      assert.equal(fs.existsSync(path.join(fixture.root, "codex.argv")), false);
    } finally {
      removeAttachedCliFixture(fixture);
    }
  }

  const fixture = createAttachedCliFixture();
  try {
    const argvFile = path.join(fixture.root, "codex.argv");
    const result = spawnSync(attachedCli, ["--help"], {
      encoding: "utf8",
      env: {
        ...process.env,
        ATTACHED_TEST_ARGV_FILE: argvFile,
        CODEX_LINUX_APP_DIR: fixture.appDir,
        CODEX_LINUX_APP_ID: fixture.appId,
        XDG_RUNTIME_DIR: path.join(fixture.root, "runtime"),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(readNulArguments(argvFile), ["--help"]);
  } finally {
    removeAttachedCliFixture(fixture);
  }
});

test("attached CLI verifier preserves stock exec and signals", async () => {
  const exitFixture = createAttachedCliFixture();
  try {
    const originalArguments = [
      "exec",
      "--ephemeral",
      "prompt with spaces",
      "--",
      "--remote=literal-after-delimiter",
    ];
    const result = runAttachedCliMain(exitFixture, originalArguments, {
      environment: { ATTACHED_TEST_EXIT_STATUS: "37" },
    });
    assert.equal(result.status, 37, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(readNulArguments(path.join(exitFixture.root, "codex.argv")), [
      "--remote",
      `unix://${exitFixture.socketPath}`,
      ...originalArguments,
    ]);
  } finally {
    removeAttachedCliFixture(exitFixture);
  }

  const signalFixture = createAttachedCliFixture();
  let child;
  try {
    const readyFile = path.join(signalFixture.root, "codex.ready");
    child = spawnAttachedCliMain(signalFixture, ["exec", "signal fixture"], {
      environment: { ATTACHED_TEST_READY_FILE: readyFile },
    });
    const resultPromise = attachedCliChildResult(child);
    await waitForAttachedCliFile(readyFile, child);
    assert.equal(child.kill("SIGTERM"), true);
    const result = await resultPromise;
    child = null;
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.deepEqual(readNulArguments(path.join(signalFixture.root, "codex.argv")), [
      "--remote",
      `unix://${signalFixture.socketPath}`,
      "exec",
      "signal fixture",
    ]);
  } finally {
    if (child != null && child.exitCode == null) child.kill("SIGKILL");
    removeAttachedCliFixture(signalFixture);
  }
});

test("patch selects the bridge only for the local host and is idempotent", () => {
  const source = syntheticBundle();
  const patched = applySharedAppServerSocketPatch(source);
  assert.notEqual(patched, source);
  assert.equal(applySharedAppServerSocketPatch(patched), patched);
  assert.match(patched, /CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET/);
  assert.match(patched, /hostConfig\.kind===`local`/);
  assert.match(
    patched,
    /CodexLinuxSharedAppServerSocketTransport\(process\.env\.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET,\(\)=>Ope\(e\)\)/,
  );
  assert.match(patched, /app-server`,\s*`proxy`,\s*`--sock`/);
  assert.match(patched, /flatMap\(e=>\[`-c`,e\]\).*app-server`,\s*`--listen`,\s*`unix:\/\//);
  assert.doesNotMatch(patched, /mcp_servers\.codex_app/);
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

test("patch rejects a current transport whose semantic SSH anchor is missing", () => {
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

test("patch leaves a current transport with no config override callback byte-identical", () => {
  const source = syntheticBundle().replace(
    ",getConfigOverrides:()=>Ope(e)",
    "",
  );
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /config override callback.*found 0/i);
});

test("patch leaves an ambiguous config override callback byte-identical", () => {
  const callbackTransport =
    "return new n.Cn({hostConfig:e.hostConfig,repoRoot:e.repoRoot,resourcesPath:e.resourcesPath,defaultOriginator:e.defaultOriginator,getConfigOverrides:()=>Ope(e)})";
  const source = syntheticBundle().replace(callbackTransport, `${callbackTransport};${callbackTransport}`);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applySharedAppServerSocketPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join("\n"), /config override callback.*found 2/i);
});

test("injected transport requires the captured config override callback", () => {
  const { InjectedTransport } = loadInjectedTransport();
  assert.throws(
    () => new InjectedTransport("/unused/socket"),
    /requires a config override callback/,
  );
});

test("descriptor is optional and targets the main bundle", () => {
  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["main-process-shared-app-server-socket", "main-bundle", "optional"]],
  );
});

test("attached CLI record publishes atomically for default and override sockets", async () => {
  const root = makeSocketTempDir("shared-app-server-attached-cli-record-", "runtime/bridge/app-server.sock");
  try {
    for (const [name, appId, runtimeRoot, socketPath] of [
      [
        "default",
        "codex-desktop",
        path.join(root, "state"),
        path.join(root, "state", "codex-desktop", "app-server-bridge", "app-server.sock"),
      ],
      [
        "override",
        "codex-bridge-test",
        path.join(root, "runtime"),
        path.join(root, "override", "app-server.sock"),
      ],
    ]) {
      const bridgeDir = path.join(runtimeRoot, appId, "app-server-bridge");
      const recordPath = path.join(bridgeDir, "attached-cli-v1");
      const priorRecord = "version=1\napp_id=prior\nsocket=/prior\ndesktop=/prior\ncodex=/prior\n";
      fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(bridgeDir, 0o700);
      fs.writeFileSync(recordPath, priorRecord, { mode: 0o600 });
      const renameCalls = [];
      const fsImpl = Object.create(fs);
      fsImpl.renameSync = (from, to) => {
        renameCalls.push({ from, to, lock: fs.readFileSync(`${socketPath}.lock`, "utf8") });
        return fs.renameSync(from, to);
      };
      let server;
      let child;
      const { Transport } = loadInjectedTransport({
        fsImpl,
        spawnImpl(_command, args) {
          child = fakeChild();
          // Publication must retain the executable selected before asynchronous startup.
          process.env.CODEX_CLI_PATH = "/fake/replacement-codex";
          const target = args.at(-1).replace("unix://", "");
          queueMicrotask(async () => {
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            server = await listenUnix(target);
          });
          return child;
        },
      });
      await withAttachedCliEnvironment({
        CODEX_CLI_PATH: "/fake/codex",
        CODEX_LINUX_APP_ID: name === "default" ? null : appId,
        CODEX_LINUX_APP_STATE_DIR: runtimeRoot,
        XDG_RUNTIME_DIR: name === "default" ? null : runtimeRoot,
      }, async () => {
        const transport = new Transport(socketPath);
        try {
          await transport.ensureAuthority();

          assert.equal(fs.lstatSync(bridgeDir).isDirectory(), true);
          assert.equal(fs.statSync(bridgeDir).mode & 0o777, 0o700);
          assert.equal(fs.lstatSync(recordPath).isFile(), true);
          assert.equal(fs.statSync(recordPath).mode & 0o777, 0o600);
          assert.equal(
            fs.readFileSync(recordPath, "utf8"),
            [
              "version=1",
              `app_id=${appId}`,
              `socket=${socketPath}`,
              `desktop=${process.execPath}`,
              "codex=/fake/codex",
              "",
            ].join("\n"),
          );
          assert.equal(renameCalls.length, 1);
          assert.equal(path.dirname(renameCalls[0].from), bridgeDir);
          assert.equal(renameCalls[0].to, recordPath);
          assert.match(renameCalls[0].lock, new RegExp(`^${process.pid} \\d+ ${process.pid} \\d+\\n$`));
        } finally {
          await closeServer(server);
          server = null;
          if (child != null) {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          }
        }
      });
      await closeServer(server);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("attached CLI publication failure is nonfatal", async () => {
  const root = makeSocketTempDir("shared-app-server-attached-cli-failure-", "runtime/bridge/app-server.sock");
  const runtimeRoot = path.join(root, "runtime");
  const appId = "codex-bridge-test";
  const bridgeDir = path.join(runtimeRoot, appId, "app-server-bridge");
  const recordPath = path.join(bridgeDir, "attached-cli-v1");
  const socketPath = path.join(root, "socket", "app-server.sock");
  const priorRecord = "version=1\napp_id=prior\nsocket=/prior\ndesktop=/prior\ncodex=/prior\n";
  fs.mkdirSync(bridgeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(bridgeDir, 0o700);
  fs.writeFileSync(recordPath, priorRecord, { mode: 0o600 });
  const fsImpl = Object.create(fs);
  let failTemporaryFstat = false;
  let failedTemporaryDescriptor = null;
  fsImpl.openSync = (target, ...args) => {
    const descriptor = fs.openSync(target, ...args);
    if (failTemporaryFstat && path.basename(target).startsWith(".attached-cli-v1.")) {
      failedTemporaryDescriptor = descriptor;
    }
    return descriptor;
  };
  fsImpl.fstatSync = (descriptor, ...args) => {
    if (failTemporaryFstat && descriptor === failedTemporaryDescriptor) {
      throw new Error("fstat failed");
    }
    return fs.fstatSync(descriptor, ...args);
  };
  fsImpl.renameSync = () => {
    throw new Error("rename failed");
  };
  let server;
  let child;
  const { Transport } = loadInjectedTransport({
    fsImpl,
    spawnImpl(_command, args) {
      child = fakeChild();
      const target = args.at(-1).replace("unix://", "");
      queueMicrotask(async () => {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        server = await listenUnix(target);
      });
      return child;
    },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  const environment = {
    CODEX_CLI_PATH: "/fake/codex",
    CODEX_LINUX_APP_ID: appId,
    CODEX_LINUX_APP_STATE_DIR: runtimeRoot,
    XDG_RUNTIME_DIR: runtimeRoot,
  };
  try {
    for (const failure of ["rename", "fstat"]) {
      warnings.length = 0;
      failTemporaryFstat = failure === "fstat";
      await withAttachedCliEnvironment(environment, async () => {
        const transport = new Transport(socketPath);
        try {
          await transport.ensureAuthority();
          assert.equal(fs.lstatSync(socketPath).isSocket(), true, failure);
          assert.match(
            fs.readFileSync(`${socketPath}.lock`, "utf8"),
            new RegExp(`^${process.pid} \\d+ ${process.pid} \\d+\\n$`),
            failure,
          );
          assert.equal(fs.readFileSync(recordPath, "utf8"), priorRecord, failure);
          assert.deepEqual(fs.readdirSync(bridgeDir), ["attached-cli-v1"], failure);
          if (failTemporaryFstat) {
            assert.throws(() => fs.fstatSync(failedTemporaryDescriptor), { code: "EBADF" });
          }
          assert.deepEqual(warnings, ["WARN: attached CLI discovery record was not published"], failure);
        } finally {
          await closeServer(server);
          server = null;
          if (child != null) {
            child.exitCode = 0;
            child.emit("exit", 0, null);
          }
        }
      });
    }

    warnings.length = 0;
    failTemporaryFstat = false;
    await withAttachedCliEnvironment({
      ...environment,
      CODEX_LINUX_APP_ID: "unsafe\nid",
    }, async () => {
      const transport = new Transport(path.join(root, "unsafe", "app-server.sock"));
      try {
        await transport.ensureAuthority();
        assert.equal(fs.lstatSync(path.join(root, "unsafe", "app-server.sock")).isSocket(), true);
        assert.deepEqual(warnings, ["WARN: attached CLI discovery record was not published"]);
        assert.equal(fs.existsSync(path.join(runtimeRoot, "unsafe\nid")), false);
      } finally {
        await closeServer(server);
        server = null;
        if (child != null) {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }
      }
    });
  } finally {
    console.warn = originalWarn;
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
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

for (const [name, overrides, expectedArgs] of [
  [
    "ordered config overrides",
    ["mcp_servers.example={command=\"/bin/true\"}", "features.example=true"],
    [
      "-c",
      "mcp_servers.example={command=\"/bin/true\"}",
      "-c",
      "features.example=true",
      "app-server",
      "--listen",
    ],
  ],
  ["an empty config override list", [], ["app-server", "--listen"]],
]) {
  test(`injected transport forwards ${name} before the authority subcommand`, async () => {
    const tempDir = makeSocketTempDir("shared-app-server-overrides-");
    const socketPath = path.join(tempDir, "app-server.sock");
    let observedArgs;
    const { Transport } = loadInjectedTransport({
      spawnImpl(_command, args) {
        observedArgs = args;
        throw new Error("stop after argument capture");
      },
    });
    const transport = new Transport(socketPath, async () => overrides);
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/fake/codex";
    try {
      await assert.rejects(transport.ensureAuthority(), /stop after argument capture/);
      assert.deepEqual(
        Array.from(observedArgs),
        [...expectedArgs, `unix://${socketPath}`],
      );
      assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

for (const [name, getConfigOverrides, expectedError] of [
  ["a synchronous callback failure", () => { throw new Error("override failure"); }, /override failure/],
  ["an asynchronous callback failure", async () => { throw new Error("override rejection"); }, /override rejection/],
  ["a non-array callback result", async () => ({}), /invalid config overrides/],
  ["a non-string callback member", async () => ["valid=true", 42], /invalid config overrides/],
]) {
  test(`injected transport rejects ${name} before ownership or spawn`, async () => {
    const tempDir = makeSocketTempDir("shared-app-server-invalid-overrides-");
    const socketPath = path.join(tempDir, "app-server.sock");
    let spawnCalls = 0;
    const { Transport } = loadInjectedTransport({
      spawnImpl() {
        spawnCalls += 1;
        return fakeChild();
      },
    });
    const transport = new Transport(socketPath, getConfigOverrides);
    const originalCli = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "/fake/codex";
    try {
      await assert.rejects(transport.ensureAuthority(), expectedError);
      assert.equal(spawnCalls, 0);
      assert.equal(fs.existsSync(socketPath), false);
      assert.equal(fs.existsSync(`${socketPath}.lock`), false);
    } finally {
      if (originalCli == null) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = originalCli;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

test("disposing while config overrides resolve prevents ownership and spawn", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-dispose-overrides-");
  const socketPath = path.join(tempDir, "app-server.sock");
  let resolveOverrides;
  let spawnCalls = 0;
  const overridesReady = new Promise((resolve) => {
    resolveOverrides = resolve;
  });
  const { Transport } = loadInjectedTransport({
    spawnImpl() {
      spawnCalls += 1;
      return fakeChild();
    },
  });
  const transport = new Transport(socketPath, () => overridesReady);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    const startup = transport.ensureAuthority();
    transport.dispose();
    resolveOverrides([]);
    await assert.rejects(startup, /disposed during startup/);
    assert.equal(spawnCalls, 0);
    assert.equal(fs.existsSync(socketPath), false);
    assert.equal(fs.existsSync(`${socketPath}.lock`), false);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a restarted authority resolves fresh config overrides", async () => {
  const tempDir = makeSocketTempDir("shared-app-server-restart-overrides-");
  const socketPath = path.join(tempDir, "app-server.sock");
  const children = [];
  const servers = [];
  const observedArgs = [];
  let overrideCalls = 0;
  const { Transport } = loadInjectedTransport({
    spawnImpl(_command, args) {
      observedArgs.push(args);
      const child = fakeChild();
      children.push(child);
      queueMicrotask(async () => {
        servers.push(await listenUnix(socketPath));
      });
      return child;
    },
  });
  const transport = new Transport(socketPath, async () => [`restart.count=${++overrideCalls}`]);
  const originalCli = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/fake/codex";
  try {
    await transport.ensureAuthority();
    await closeServer(servers.shift());
    children[0].exitCode = 0;
    children[0].emit("exit", 0, null);
    await transport.ensureAuthority();
    assert.equal(overrideCalls, 2);
    assert.deepEqual(observedArgs.map((args) => Array.from(args.slice(0, 2))), [
      ["-c", "restart.count=1"],
      ["-c", "restart.count=2"],
    ]);
  } finally {
    if (originalCli == null) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = originalCli;
    for (const server of servers) await closeServer(server);
    for (const child of children) {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }
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

test("stock Codex proxy connects to a real authority", { timeout: 15000 }, async (t) => {
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
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.mkdirSync(path.dirname(socketPath), { mode: 0o700 });
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
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

    proxy = spawn(codexCli, ["app-server", "proxy", "--sock", socketPath], {
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
