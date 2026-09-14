import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const maxMessageBytes = 8 * 1024 * 1024;
const componentPattern = /^[A-Za-z0-9._-]+$/;

function processInfo(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return {
      pid,
      state: fields[0],
      startTime: fields[19],
      uid: fs.statSync(`/proc/${pid}`).uid,
      commandLine: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw error;
  }
}

function sameProcess(pid, startTime) {
  const current = processInfo(pid);
  return current != null && current.state !== 'Z' && current.startTime === startTime;
}

function ensurePrivateDirectory(directory, parent, uid) {
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (uid != null && parentStat.uid !== uid) || (parentStat.mode & 0o077) !== 0) {
    throw new Error(`unsafe Linux Computer Use runtime directory: ${parent}`);
  }
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid != null && stat.uid !== uid)) {
    throw new Error(`unsafe Linux Computer Use bridge directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

export function bridgeSocketPath(env = process.env) {
  const runtimeRoot = env.XDG_RUNTIME_DIR?.trim();
  if (!runtimeRoot || !path.isAbsolute(runtimeRoot)) throw new Error('Linux Computer Use requires an absolute XDG_RUNTIME_DIR');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const appIdCandidate = (env.CODEX_LINUX_APP_ID || 'codex-desktop').trim();
  const appId = componentPattern.test(appIdCandidate) ? appIdCandidate : 'codex-desktop';
  const instanceId = env.CODEX_LINUX_INSTANCE_ID?.trim() || '';
  if (instanceId && !componentPattern.test(instanceId)) throw new Error('invalid Linux Computer Use instance id');
  const appDir = path.join(runtimeRoot, appId);
  ensurePrivateDirectory(appDir, runtimeRoot, uid);
  let socketDir = appDir;
  if (instanceId) {
    const instancesDir = path.join(appDir, 'instances');
    ensurePrivateDirectory(instancesDir, appDir, uid);
    socketDir = path.join(instancesDir, instanceId);
    ensurePrivateDirectory(socketDir, instancesDir, uid);
  }
  const socketPath = path.join(socketDir, 'computer-use-native.sock');
  if (Buffer.byteLength(socketPath, 'utf8') > 100) throw new Error('Linux Computer Use host socket path is too long');
  return socketPath;
}

function listenerExists(socketPath) {
  try {
    return fs.readFileSync('/proc/net/unix', 'utf8').split('\n').some(line => {
      const fields = line.trim().split(/\s+/);
      return fields.length >= 8 && fields[5] === '01' && fields.at(-1) === socketPath;
    });
  } catch { return false; }
}

function readLock(socketPath) {
  const lockPath = `${socketPath}.lock`;
  try {
    const stat = fs.lstatSync(lockPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    return { ...value, identity: { dev: stat.dev, ino: stat.ino }, lockPath };
  } catch { return null; }
}

function isAuthority(lock, scriptPath, socketPath) {
  if (!lock || !Number.isSafeInteger(lock.pid) || typeof lock.startTime !== 'string') return false;
  const current = processInfo(lock.pid);
  if (current == null || current.state === 'Z' || current.startTime !== lock.startTime) return false;
  if (typeof process.getuid === 'function' && current.uid !== process.getuid()) return false;
  return current.commandLine.includes(scriptPath) && current.commandLine.includes('serve') && current.commandLine.includes(socketPath);
}

function removeStalePath(filePath, allowedTypes) {
  try {
    const stat = fs.lstatSync(filePath);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if ((uid != null && stat.uid !== uid) || !allowedTypes.some(type => stat[type]())) {
      throw new Error(`refusing to remove unsafe Linux Computer Use path: ${filePath}`);
    }
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function exactBackendPath(env) {
  const appDir = env.CODEX_LINUX_APP_DIR;
  const override = env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE?.trim();
  const backend = override || (appDir && path.join(appDir, 'resources/plugins/openai-bundled/plugins/unified-computer-use/bin/codex-computer-use-linux'));
  if (!backend || !path.isAbsolute(backend)) throw new Error('Linux Computer Use backend path is unavailable');
  const stat = fs.statSync(backend);
  if (!stat.isFile()) throw new Error('Linux Computer Use backend is not a regular file');
  fs.accessSync(backend, fs.constants.X_OK);
  return backend;
}

function exactBackendModulePath(env) {
  const appDir = env.CODEX_LINUX_APP_DIR;
  const modulePath = appDir && path.join(appDir, 'resources/plugins/openai-bundled/plugins/unified-computer-use/scripts/native-backend-service.mjs');
  if (!modulePath || !path.isAbsolute(modulePath) || !fs.statSync(modulePath).isFile()) {
    throw new Error('Linux Computer Use backend service module is unavailable');
  }
  return modulePath;
}

function writeResponse(socket, response) {
  const encoded = Buffer.from(`${JSON.stringify(response)}\n`);
  if (encoded.length > maxMessageBytes) throw new Error('Linux Computer Use host bridge response is too large');
  socket.write(encoded);
}

export async function createHostBridgeServer({ socketPath, backendPath, backendModulePath, backendArgs = ['mcp'], ownerPid, ownerStartTime, token }) {
  const scriptPath = fs.realpathSync(new URL(import.meta.url));
  const lockPath = `${socketPath}.lock`;
  const descriptor = fs.openSync(lockPath, 'wx', 0o600);
  const startTime = processInfo(process.pid)?.startTime;
  const lockValue = { pid: process.pid, startTime, ownerPid, ownerStartTime, token };
  fs.writeFileSync(descriptor, `${JSON.stringify(lockValue)}\n`);
  fs.closeSync(descriptor);
  const lockStat = fs.lstatSync(lockPath);
  const lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
  const { createNativeBackendService } = await import(pathToFileURL(backendModulePath));
  const services = new Set();
  const owners = new Map([[token, { pid: ownerPid, startTime: ownerStartTime }]]);
  let socketIdentity;
  const server = net.createServer(socket => {
    let buffered = Buffer.alloc(0);
    let chain = Promise.resolve();
    let service;
    const getService = () => {
      if (!service) {
        service = createNativeBackendService({ command: backendPath, args: backendArgs });
        services.add(service);
      }
      return service;
    };
    const stop = () => {
      if (service) { services.delete(service); service.shutdown(); }
    };
    socket.on('close', stop);
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        const newline = buffered.indexOf(10);
        if (newline < 0) {
          if (buffered.length > maxMessageBytes) socket.destroy(new Error('request too large'));
          break;
        }
        if (newline > maxMessageBytes) { socket.destroy(new Error('request too large')); return; }
        const line = buffered.subarray(0, newline).toString('utf8');
        buffered = buffered.subarray(newline + 1);
        chain = chain.then(async () => {
          let message;
          try { message = JSON.parse(line); }
          catch { throw new Error('invalid host bridge request'); }
          if (!Number.isSafeInteger(message?.id) || message.id < 1) throw new Error('invalid host bridge request id');
          if (message.control === 'register') {
            if (!Number.isSafeInteger(message.ownerPid) || typeof message.ownerStartTime !== 'string' ||
                !sameProcess(message.ownerPid, message.ownerStartTime)) throw new Error('invalid Linux Computer Use launcher registration');
            const ownerToken = randomBytes(24).toString('hex');
            owners.set(ownerToken, { pid: message.ownerPid, startTime: message.ownerStartTime });
            writeResponse(socket, { id: message.id, result: { ownerToken } });
            return;
          }
          if (message.control === 'unregister') {
            if (typeof message.ownerToken !== 'string' || !owners.delete(message.ownerToken)) {
              throw new Error('invalid Linux Computer Use launcher unregister request');
            }
            writeResponse(socket, { id: message.id, result: { removed: true } });
            return;
          }
          if (message.control !== undefined) throw new Error('invalid Linux Computer Use host control request');
          try { writeResponse(socket, { id: message.id, result: await getService().handleRpc(message.input) }); }
          catch (error) { writeResponse(socket, { id: message.id, error: error instanceof Error ? error.message : String(error) }); }
        }).catch(() => socket.destroy());
      }
    });
  });
  server.maxConnections = 8;
  const cleanup = () => {
    clearInterval(ownerTimer);
    for (const service of services) service.shutdown();
    services.clear();
    try { server.close(); } catch {}
    try {
      const stat = fs.lstatSync(socketPath);
      if (socketIdentity && stat.dev === socketIdentity.dev && stat.ino === socketIdentity.ino && stat.isSocket()) fs.unlinkSync(socketPath);
    } catch {}
    try {
      const stat = fs.lstatSync(lockPath);
      if (stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino) fs.unlinkSync(lockPath);
    } catch {}
  };
  const ownerTimer = setInterval(() => {
    for (const [ownerToken, owner] of owners) {
      if (!sameProcess(owner.pid, owner.startTime)) owners.delete(ownerToken);
    }
    if (owners.size === 0) { cleanup(); process.exit(0); }
  }, 1000);
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, 0o600);
        const stat = fs.lstatSync(socketPath);
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        if (!stat.isSocket() || (uid != null && stat.uid !== uid)) throw new Error('unsafe Linux Computer Use host socket');
        socketIdentity = { dev: stat.dev, ino: stat.ino };
        resolve();
      } catch (error) { reject(error); }
    });
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { cleanup(); process.exit(0); });
  process.once('exit', cleanup);
  try { await ready; }
  catch (error) { cleanup(); throw error; }
  return { server, cleanup, scriptPath };
}

async function waitForAuthority(socketPath, scriptPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = readLock(socketPath);
    if (isAuthority(lock, scriptPath, socketPath) && listenerExists(socketPath)) return lock;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Linux Computer Use host bridge did not become ready');
}

function hostControl(socketPath, message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = Buffer.alloc(0);
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Linux Computer Use host control timed out')), timeoutMs);
    socket.once('connect', () => socket.write(`${JSON.stringify({ id: 1, ...message })}\n`));
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('Linux Computer Use host control connection closed')));
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0) {
        if (buffered.length > maxMessageBytes) finish(new Error('Linux Computer Use host control response is too large'));
        return;
      }
      if (newline > maxMessageBytes) { finish(new Error('Linux Computer Use host control response is too large')); return; }
      let response;
      try { response = JSON.parse(buffered.subarray(0, newline).toString('utf8')); }
      catch { finish(new Error('invalid Linux Computer Use host control response')); return; }
      if (response?.id !== 1 || typeof response.error === 'string') {
        finish(new Error(response?.error || 'invalid Linux Computer Use host control response'));
      } else finish(null, response.result);
    });
  });
}

async function registerOwner(socketPath, owner) {
  const result = await hostControl(socketPath, { control: 'register', ownerPid: owner.pid, ownerStartTime: owner.startTime });
  if (typeof result?.ownerToken !== 'string' || !/^[a-f0-9]{48}$/.test(result.ownerToken)) {
    throw new Error('invalid Linux Computer Use host owner token');
  }
  return result.ownerToken;
}

export async function launchHostBridge(env = process.env) {
  const socketPath = bridgeSocketPath(env);
  const scriptPath = fs.realpathSync(new URL(import.meta.url));
  const ownerPid = Number(env.CODEX_LINUX_LAUNCHER_PID);
  const owner = Number.isSafeInteger(ownerPid) ? processInfo(ownerPid) : null;
  if (owner == null || owner.state === 'Z') throw new Error('Linux Computer Use launcher identity is unavailable');
  const existing = readLock(socketPath);
  if (isAuthority(existing, scriptPath, socketPath)) {
    try {
      await waitForAuthority(socketPath, scriptPath);
      return { socketPath, ownerToken: await registerOwner(socketPath, owner) };
    } catch {
      if (isAuthority(readLock(socketPath), scriptPath, socketPath)) {
        throw new Error('Linux Computer Use host authority did not accept its launcher registration');
      }
    }
  }
  if (listenerExists(socketPath)) throw new Error('unrecognized Linux Computer Use host socket is already listening');
  removeStalePath(socketPath, ['isSocket', 'isSymbolicLink']);
  removeStalePath(`${socketPath}.lock`, ['isFile']);
  const backendPath = exactBackendPath(env);
  const backendModulePath = exactBackendModulePath(env);
  const token = randomBytes(24).toString('hex');
  const child = spawn(process.execPath, [scriptPath, 'serve', socketPath, backendPath, backendModulePath, String(ownerPid), owner.startTime, token], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  const authority = await waitForAuthority(socketPath, scriptPath);
  return { socketPath, ownerToken: authority.token === token ? token : await registerOwner(socketPath, owner) };
}

export async function cleanupOwnedBridge(env = process.env) {
  const token = env.CODEX_LINUX_CUA_HOST_OWNER_TOKEN;
  if (!token) return false;
  const socketPath = bridgeSocketPath(env);
  const scriptPath = fs.realpathSync(new URL(import.meta.url));
  const lock = readLock(socketPath);
  if (!isAuthority(lock, scriptPath, socketPath)) return false;
  try {
    const result = await hostControl(socketPath, { control: 'unregister', ownerToken: token });
    return result?.removed === true;
  } catch { return false; }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  const mode = process.argv[2];
  if (mode === 'launcher') {
    const { socketPath, ownerToken } = await launchHostBridge();
    process.stdout.write(`env CODEX_LINUX_CUA_HOST_SOCKET=${socketPath}\n`);
    process.stdout.write(`env CODEX_LINUX_CUA_HOST_OWNER_TOKEN=${ownerToken}\n`);
  } else if (mode === 'cleanup') {
    await cleanupOwnedBridge();
  } else if (mode === 'serve') {
    const [, , , socketPath, backendPath, backendModulePath, ownerPid, ownerStartTime, token] = process.argv;
    await createHostBridgeServer({ socketPath, backendPath, backendModulePath, ownerPid: Number(ownerPid), ownerStartTime, token });
  } else {
    throw new Error('unknown Linux Computer Use host service mode');
  }
}
