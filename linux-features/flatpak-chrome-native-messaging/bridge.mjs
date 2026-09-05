#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.openai.codexextension";
const MAX_PRELUDE_BYTES = 4096;
const AUTH_TIMEOUT_MS = 2000;
const MAX_CLIENTS = 8;
const START_TIMEOUT_MS = 5000;
const OWNER_POLL_MS = 500;
const BRIDGE_WRAPPER_NAME = `${HOST_NAME}-codex-desktop-bridge`;

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  for (const key of ["app-dir", "codex-home", "state-dir", "flatpak-root", "owner-pid"]) {
    if (!options[key]) throw new Error(`missing --${key}`);
  }
  const ownerPid = Number.parseInt(options["owner-pid"], 10);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 1) throw new Error("invalid --owner-pid");
  return {
    command,
    appDir: path.resolve(options["app-dir"]),
    codexHome: path.resolve(options["codex-home"]),
    stateDir: path.resolve(options["state-dir"]),
    flatpakRoot: path.resolve(options["flatpak-root"]),
    ownerPid,
  };
}

function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime ? `${pid}:${startTime}` : null;
  } catch {
    return null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function writePrivateAtomic(target, contents, mode = 0o600) {
  privateDirectory(path.dirname(target));
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  fs.writeFileSync(temporary, contents, { mode, flag: "wx" });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, target);
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function pathsFor(options) {
  const nativeDirectory = path.join(
    options.flatpakRoot,
    "config",
    "google-chrome",
    "NativeMessagingHosts",
  );
  return {
    stateFile: path.join(options.stateDir, "bridge-state.json"),
    backupFile: path.join(options.stateDir, "original-manifest.json"),
    lockDirectory: path.join(options.stateDir, "startup.lock"),
    logFile: path.join(options.stateDir, "bridge.log"),
    nativeDirectory,
    manifestPath: path.join(nativeDirectory, `${HOST_NAME}.json`),
    wrapperPath: path.join(nativeDirectory, BRIDGE_WRAPPER_NAME),
  };
}

function loadExtensionRegistry(appDir) {
  const target = path.join(
    appDir,
    "resources",
    "plugins",
    "openai-bundled",
    "plugins",
    "chrome",
    "scripts",
    "extension-ids.json",
  );
  const registry = readJson(target);
  if (registry.extensionHostName !== HOST_NAME || !Array.isArray(registry.extensionIds)) {
    throw new Error(`unsupported Chrome extension registry: ${target}`);
  }
  const origins = registry.extensionIds.map((id) => `chrome-extension://${id}/`);
  if (origins.length === 0 || origins.some((origin) => !/^chrome-extension:\/\/[a-p]{32}\/$/.test(origin))) {
    throw new Error(`invalid Chrome extension ids: ${target}`);
  }
  return { origins };
}

function bridgeManifest(wrapperPath, origins) {
  return {
    name: HOST_NAME,
    description: "ChatGPT Community Flatpak Chrome bridge",
    path: wrapperPath,
    type: "stdio",
    allowed_origins: origins,
  };
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecognizedUpstreamManifest(manifest, options, origins) {
  if (
    manifest?.name !== HOST_NAME ||
    manifest?.type !== "stdio" ||
    !Array.isArray(manifest.allowed_origins) ||
    manifest.allowed_origins.length !== origins.length ||
    !origins.every((origin) => manifest.allowed_origins.includes(origin)) ||
    typeof manifest.path !== "string" ||
    path.basename(manifest.path) !== "extension-host"
  ) return false;
  const candidate = path.resolve(manifest.path);
  return [
    path.join(options.codexHome, "plugins", "cache", "openai-bundled", "chrome"),
    path.join(options.appDir, "resources", "plugins", "openai-bundled", "plugins", "chrome"),
  ].some((root) => isPathInside(root, candidate));
}

function assertManifestCanBeReplaced(options, origins) {
  const paths = pathsFor(options);
  if (!fs.existsSync(paths.manifestPath)) return;
  let current;
  try {
    current = readJson(paths.manifestPath);
  } catch {
    throw new Error(`refusing to replace invalid manifest: ${paths.manifestPath}`);
  }
  if (current?.path === paths.wrapperPath) {
    if (!fs.existsSync(paths.backupFile)) {
      throw new Error(`bridge manifest has no recovery record: ${paths.manifestPath}`);
    }
    return;
  }
  if (!isRecognizedUpstreamManifest(current, options, origins)) {
    throw new Error(`refusing to replace an unrecognized native host manifest: ${paths.manifestPath}`);
  }
}

function wrapperSource(port, token) {
  return `#!/usr/bin/bash
# Managed by ChatGPT Community feature flatpak-chrome-native-messaging.
set -u
reader_pid=
writer_pid=
cleanup() {
    trap - EXIT HUP INT TERM
    [ -n "$reader_pid" ] && kill "$reader_pid" 2>/dev/null || true
    [ -n "$writer_pid" ] && kill "$writer_pid" 2>/dev/null || true
    exec 3>&- 3<&-
    [ -n "$reader_pid" ] && wait "$reader_pid" 2>/dev/null || true
    [ -n "$writer_pid" ] && wait "$writer_pid" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
exec 3<>/dev/tcp/127.0.0.1/${port} || exit 1
printf '%s\\n%s\\n' '${token}' "\${1:-}" >&3 || exit 1
cat <&3 >&1 & reader_pid=$!
cat <&0 >&3 & writer_pid=$!
wait -n "$reader_pid" "$writer_pid"
status=$?
cleanup
exit "$status"
`;
}

function prepareManifest(options, state) {
  const paths = pathsFor(options);
  privateDirectory(options.stateDir);
  privateDirectory(paths.nativeDirectory);

  let currentText = null;
  if (fs.existsSync(paths.manifestPath)) {
    currentText = fs.readFileSync(paths.manifestPath, "utf8");
  }

  assertManifestCanBeReplaced(options, state.origins);
  if (!fs.existsSync(paths.backupFile)) {
    writePrivateAtomic(paths.backupFile, `${JSON.stringify({ existed: currentText != null, contents: currentText })}\n`);
  }

  writePrivateAtomic(paths.wrapperPath, wrapperSource(state.port, state.token), 0o700);
  writePrivateAtomic(paths.manifestPath, `${JSON.stringify(bridgeManifest(paths.wrapperPath, state.origins), null, 2)}\n`);
}

function restoreManifest(options) {
  const paths = pathsFor(options);
  let current;
  try { current = readJson(paths.manifestPath); } catch { current = null; }
  if (current?.path !== paths.wrapperPath) {
    fs.rmSync(paths.wrapperPath, { force: true });
    fs.rmSync(paths.backupFile, { force: true });
    return;
  }

  let backup;
  try { backup = readJson(paths.backupFile); } catch { backup = null; }
  if (backup?.existed === true && typeof backup.contents === "string") {
    writePrivateAtomic(paths.manifestPath, backup.contents);
  } else if (backup?.existed === false) {
    fs.rmSync(paths.manifestPath, { force: true });
  } else {
    return;
  }
  fs.rmSync(paths.wrapperPath, { force: true });
  fs.rmSync(paths.backupFile, { force: true });
}

function sameRealPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function readRuntimeHost(options, origin) {
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  const registryPath = process.env.CODEX_CHROME_NATIVE_HOST_REGISTRY || path.join(
    stateHome,
    "openai-codex",
    "chrome-native-hosts-v2.json",
  );
  const registry = readJson(registryPath);
  const extensionId = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin)?.[1];
  const entries = registry?.schemaVersion === 2 && Array.isArray(registry.entries)
    ? registry.entries
    : [];
  const matchingEntries = entries.filter((entry) => (
    entry?.schemaVersion === 2 &&
    entry.nativeHostNames?.includes(HOST_NAME) &&
    entry.extensionIds?.includes(extensionId) &&
    sameRealPath(entry.paths?.codexHome, options.codexHome) &&
    sameRealPath(entry.paths?.resourcesPath, path.join(options.appDir, "resources"))
  ));
  matchingEntries.sort((left, right) => (
    String(right.presence?.lastSeenAt || "").localeCompare(String(left.presence?.lastSeenAt || ""))
  ));
  const candidate = matchingEntries[0]?.paths?.extensionHostPath;
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new Error(`official Chrome native host is not registered for this app: ${registryPath}`);
  }
  const resolved = fs.realpathSync(candidate);
  const trustedRoots = [
    path.join(options.codexHome, "plugins", "cache", "openai-bundled", "chrome"),
    path.join(options.appDir, "resources", "plugins", "openai-bundled", "plugins", "chrome"),
  ].filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root));
  if (!trustedRoots.some((root) => isPathInside(root, resolved))) {
    throw new Error(`registered Chrome native host is outside trusted roots: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile() || (stat.mode & 0o111) === 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`registered Chrome native host has unsafe permissions: ${resolved}`);
  }
  if (stat.uid !== process.getuid() && stat.uid !== 0) {
    throw new Error(`registered Chrome native host has an unexpected owner: ${resolved}`);
  }
  return resolved;
}

function parsePrelude(socket, onAuthenticated) {
  let buffered = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
  timer.unref();
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const first = buffered.indexOf(0x0a);
    const second = first < 0 ? -1 : buffered.indexOf(0x0a, first + 1);
    if (second < 0) {
      if (buffered.length > MAX_PRELUDE_BYTES) socket.destroy();
      return;
    }
    if (second + 1 > MAX_PRELUDE_BYTES) return socket.destroy();
    socket.off("data", onData);
    clearTimeout(timer);
    onAuthenticated(
      buffered.subarray(0, first).toString("utf8"),
      buffered.subarray(first + 1, second).toString("utf8"),
      buffered.subarray(second + 1),
    );
  };
  socket.on("data", onData);
}

function connectHost(socket, initialPayload, origin, options, hostChildren) {
  let child;
  try {
    child = spawn(readRuntimeHost(options, origin), [origin], {
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
  } catch {
    socket.destroy();
    return;
  }
  hostChildren.add(child);
  let terminationTimer;
  let killTimer;
  const terminateChild = (graceMilliseconds = 0) => {
    if (child.exitCode != null || child.signalCode != null || terminationTimer) return;
    terminationTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
      killTimer.unref();
    }, graceMilliseconds);
    terminationTimer.unref();
  };
  const abort = () => {
    socket.destroy();
    terminateChild();
  };
  child.on("error", abort);
  child.on("close", () => {
    if (terminationTimer) clearTimeout(terminationTimer);
    if (killTimer) clearTimeout(killTimer);
    hostChildren.delete(child);
  });
  child.stdout.on("error", abort);
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") abort();
  });
  socket.on("error", abort);
  socket.on("close", () => terminateChild(250));
  socket.on("end", () => child.stdin.end());
  if (initialPayload.length > 0) child.stdin.write(initialPayload);
  socket.pipe(child.stdin, { end: true });
  child.stdout.pipe(socket, { end: true });
}

function probe(state, request = "@ping") {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 500);
    timer.unref();
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${state.token}\n${request}\n`));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => { clearTimeout(timer); resolve(response === "ok\n"); });
    socket.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

async function acquireLock(lockDirectory) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  const ownerIdentity = processIdentity(process.pid);
  const temporary = `${lockDirectory}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  while (true) {
    try {
      fs.mkdirSync(temporary, { mode: 0o700 });
      fs.writeFileSync(
        path.join(temporary, "owner.json"),
        `${JSON.stringify({ pid: process.pid, identity: ownerIdentity })}\n`,
        { mode: 0o600 },
      );
      fs.renameSync(temporary, lockDirectory);
      return () => {
        try {
          const owner = readJson(path.join(lockDirectory, "owner.json"));
          if (owner.pid === process.pid && owner.identity === ownerIdentity) {
            fs.rmSync(lockDirectory, { recursive: true, force: true });
          }
        } catch {}
      };
    } catch (error) {
      fs.rmSync(temporary, { recursive: true, force: true });
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      try {
        const owner = readJson(path.join(lockDirectory, "owner.json"));
        if (processIdentity(owner.pid) !== owner.identity) {
          fs.rmSync(lockDirectory, { recursive: true, force: true });
          continue;
        }
      } catch {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error("timed out waiting for bridge startup lock");
      await delay(50);
    }
  }
}

function loadState(options) {
  try {
    const state = readJson(pathsFor(options).stateFile);
    if (
      state?.version !== 1 ||
      !Number.isSafeInteger(state.serverPid) ||
      typeof state.serverIdentity !== "string" ||
      !Number.isSafeInteger(state.ownerPid) ||
      !Number.isSafeInteger(state.port) ||
      !/^[a-f0-9]{64}$/.test(state.token || "") ||
      typeof state.ownerIdentity !== "string" ||
      !path.isAbsolute(state.appDir || "") ||
      !path.isAbsolute(state.codexHome || "") ||
      !path.isAbsolute(state.flatpakRoot || "")
    ) return null;
    return state;
  } catch {
    return null;
  }
}

async function ensure(options) {
  privateDirectory(options.stateDir);
  const release = await acquireLock(pathsFor(options).lockDirectory);
  try {
    const stateFileExists = fs.existsSync(pathsFor(options).stateFile);
    const existing = loadState(options);
    if (stateFileExists && !existing) {
      throw new Error("refusing to replace an invalid Flatpak Chrome bridge state file");
    }
    let startOptions = options;
    if (existing) {
      const existingOptions = {
        ...options,
        appDir: existing.appDir,
        codexHome: existing.codexHome,
        flatpakRoot: existing.flatpakRoot,
        ownerPid: existing.ownerPid,
      };
      const ownerIsAlive = processIdentity(existing.ownerPid) === existing.ownerIdentity;
      const serverIsAlive = processIdentity(existing.serverPid) === existing.serverIdentity;
      const existingResponds = await probe(existing);
      if (ownerIsAlive && existingResponds) return;
      if (ownerIsAlive && serverIsAlive) {
        throw new Error("live Flatpak Chrome bridge did not answer its health check");
      }
      if (ownerIsAlive) startOptions = existingOptions;
      if (serverIsAlive) {
        if (existingResponds) {
          await probe(existing, `@shutdown:${existing.ownerIdentity}`);
        } else {
          process.kill(existing.serverPid, "SIGTERM");
        }
        const shutdownDeadline = Date.now() + 2000;
        while (
          processIdentity(existing.serverPid) === existing.serverIdentity &&
          Date.now() < shutdownDeadline
        ) {
          await delay(25);
        }
        if (processIdentity(existing.serverPid) === existing.serverIdentity) {
          throw new Error("stale Flatpak Chrome bridge did not shut down");
        }
      }
      restoreManifest(existingOptions);
      fs.rmSync(pathsFor(options).stateFile, { force: true });
    }
    const extension = loadExtensionRegistry(startOptions.appDir);
    assertManifestCanBeReplaced(startOptions, extension.origins);
    const ownerIdentity = processIdentity(startOptions.ownerPid);
    if (!ownerIdentity) throw new Error(`owner process ${startOptions.ownerPid} is not running`);
    const logFd = fs.openSync(pathsFor(options).logFile, "a", 0o600);
    const argumentsForServe = [
      fileURLToPath(import.meta.url), "serve",
      "--app-dir", startOptions.appDir,
      "--codex-home", startOptions.codexHome,
      "--state-dir", startOptions.stateDir,
      "--flatpak-root", startOptions.flatpakRoot,
      "--owner-pid", String(startOptions.ownerPid),
    ];
    const child = spawn(process.execPath, argumentsForServe, {
      detached: true,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    fs.closeSync(logFd);

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = loadState(options);
      if (state?.ownerIdentity === ownerIdentity && await probe(state)) return;
      await delay(50);
    }
    throw new Error("Flatpak Chrome bridge did not become ready");
  } finally {
    release();
  }
}

async function serve(options) {
  const ownerIdentity = processIdentity(options.ownerPid);
  if (!ownerIdentity) throw new Error(`owner process ${options.ownerPid} is not running`);
  const extension = loadExtensionRegistry(options.appDir);
  const token = crypto.randomBytes(32).toString("hex");
  let clients = 0;
  let stopping = false;
  const sockets = new Set();
  const hostChildren = new Set();
  const state = {
    version: 1,
    serverPid: process.pid,
    serverIdentity: processIdentity(process.pid),
    ownerPid: options.ownerPid,
    ownerIdentity,
    appDir: options.appDir,
    codexHome: options.codexHome,
    flatpakRoot: options.flatpakRoot,
    port: 0,
    token,
    origins: extension.origins,
  };
  let ownerTimer;

  const server = net.createServer((socket) => {
    if (clients >= MAX_CLIENTS) return socket.destroy();
    clients += 1;
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clients -= 1; sockets.delete(socket); });
    parsePrelude(socket, (providedToken, origin, initialPayload) => {
      const providedTokenBuffer = Buffer.from(providedToken);
      const tokenBuffer = Buffer.from(token);
      if (
        providedTokenBuffer.length !== tokenBuffer.length ||
        !crypto.timingSafeEqual(providedTokenBuffer, tokenBuffer)
      ) return socket.destroy();
      if (origin === "@ping") { socket.end("ok\n"); return; }
      if (origin === `@shutdown:${ownerIdentity}`) { socket.end("ok\n"); stop(); return; }
      if (!extension.origins.includes(origin)) return socket.destroy();
      connectHost(socket, initialPayload, origin, options, hostChildren);
    });
  });

  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (ownerTimer) clearInterval(ownerTimer);
    for (const socket of sockets) socket.destroy();
    server.close();
    for (const child of hostChildren) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      for (const child of hostChildren) child.kill("SIGKILL");
    }, 500);
    killTimer.unref();
    const finishDeadline = Date.now() + 1000;
    const finishTimer = setInterval(() => {
      if (hostChildren.size > 0 && Date.now() < finishDeadline) return;
      clearInterval(finishTimer);
      restoreManifest(options);
      fs.rmSync(pathsFor(options).stateFile, { force: true });
      process.exit(0);
    }, 25);
  };

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  try {
    state.port = server.address().port;
    prepareManifest(options, state);
    writePrivateAtomic(pathsFor(options).stateFile, `${JSON.stringify(state)}\n`);
  } catch (error) {
    server.close();
    throw error;
  }
  ownerTimer = setInterval(() => {
    if (processIdentity(options.ownerPid) !== ownerIdentity) stop();
  }, OWNER_POLL_MS);
  ownerTimer.unref();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}

async function cleanup(options) {
  const state = loadState(options);
  const ownerIdentity = processIdentity(options.ownerPid);
  if (!state || !ownerIdentity || state.ownerIdentity !== ownerIdentity) return;
  await probe(state, `@shutdown:${ownerIdentity}`);
}

export {
  bridgeManifest,
  loadExtensionRegistry,
  parsePrelude,
  pathsFor,
  processIdentity,
  wrapperSource,
};

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.command === "ensure") await ensure(options);
    else if (options.command === "serve") await serve(options);
    else if (options.command === "cleanup") await cleanup(options);
    else throw new Error(`unsupported command: ${options.command}`);
  } catch (error) {
    console.error(`flatpak-chrome-native-messaging: ${error.message}`);
    process.exitCode = 1;
  }
}
