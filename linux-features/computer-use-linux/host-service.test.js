const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function currentStartTime() {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
}

function rpc(socket) {
  let buffered = '';
  const pending = new Map();
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  let sequence = 0;
  return input => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ id, input })}\n`);
  });
}

test('host bridge validates requests before launching the unsandboxed backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socketPath = path.join(root, 'native.sock');
  const backend = path.join(root, 'backend.cjs');
  const marker = path.join(root, 'backend-started');
  fs.writeFileSync(backend, `
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
const readline = require('node:readline');
let initialized = false;
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
  if(request.method === 'initialize') return reply({protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
  if(request.method === 'notifications/initialized') { initialized=true; return; }
  if(!initialized) process.exit(8);
  reply({content:[{type:'text',text:JSON.stringify({windows:[{window_id:22,title:'Editor',app_id:'editor',focused:true}]})}]});
});
`);
  const modulePath = path.join(__dirname, 'native-backend-service.mjs');
  const { createHostBridgeServer } = await import('./host-service.mjs');
  const host = await createHostBridgeServer({
    socketPath,
    backendPath: process.execPath,
    backendModulePath: modulePath,
    backendArgs: [backend],
    ownerPid: process.pid,
    ownerStartTime: currentStartTime(),
    token: 'test-owner',
  });
  t.after(() => host.cleanup());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  t.after(() => socket.destroy());
  const request = rpc(socket);
  const rejected = await request({ method: 'drag', app: 'editor', params: {} });
  assert.match(rejected.error, /not supported/);
  assert.equal(fs.existsSync(marker), false);

  const listed = await request({ method: 'list_apps' });
  assert.deepEqual(listed.result, [{ id: 'linux-window:22', displayName: 'editor', title: 'Editor', isRunning: true, focused: true }]);
  assert.equal(fs.existsSync(marker), true);
});

test('bridge socket path requires a private absolute runtime directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const { bridgeSocketPath } = await import('./host-service.mjs');
  const socketPath = bridgeSocketPath({ XDG_RUNTIME_DIR: root, CODEX_LINUX_APP_ID: 'codex-test' });
  assert.equal(socketPath, path.join(root, 'codex-test', 'computer-use-native.sock'));
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.throws(() => bridgeSocketPath({ XDG_RUNTIME_DIR: 'relative' }), /absolute/);
});

test('launcher hook leaves the app usable when XDG_RUNTIME_DIR is unavailable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-no-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeBin = path.join(root, 'app/resources/cua_node/bin/node');
  const featuresDir = path.join(root, 'features');
  const marker = path.join(root, 'node-started');
  fs.mkdirSync(path.dirname(nodeBin), { recursive: true });
  fs.mkdirSync(path.join(featuresDir, 'computer-use-linux'), { recursive: true });
  fs.writeFileSync(nodeBin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  fs.chmodSync(nodeBin, 0o755);
  fs.writeFileSync(path.join(featuresDir, 'computer-use-linux/host-service.mjs'), '');
  const result = require('node:child_process').spawnSync('bash', [path.join(__dirname, 'host-service-hook.sh')], {
    encoding: 'utf8',
    env: {
      CODEX_LINUX_APP_DIR: path.join(root, 'app'),
      CODEX_LINUX_FEATURES_DIR: featuresDir,
      CODEX_LINUX_FEATURE_HOOK_PHASE: 'launcher',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /unavailable without an absolute XDG_RUNTIME_DIR/);
  assert.equal(fs.existsSync(marker), false);
});

test('launcher reuses one host authority and only its owner token can stop it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-launcher-'));
  let cleanup;
  t.after(() => {
    try { cleanup?.(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtime = path.join(root, 'runtime');
  const appDir = path.join(root, 'app');
  const scripts = path.join(appDir, 'resources/plugins/openai-bundled/plugins/unified-computer-use/scripts');
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['native-backend-service.mjs', 'native-protocol.mjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  }
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    CODEX_LINUX_APP_DIR: appDir,
    CODEX_LINUX_APP_ID: 'codex-test',
    CODEX_LINUX_LAUNCHER_PID: String(process.pid),
    CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE: process.execPath,
  };
  const { cleanupOwnedBridge, launchHostBridge } = await import('./host-service.mjs');
  const first = await launchHostBridge(env);
  cleanup = () => cleanupOwnedBridge({ ...env, CODEX_LINUX_CUA_HOST_OWNER_TOKEN: first.ownerToken });
  assert.match(first.ownerToken, /^[a-f0-9]{48}$/);
  const second = await launchHostBridge(env);
  assert.equal(second.socketPath, first.socketPath);
  assert.match(second.ownerToken, /^[a-f0-9]{48}$/);
  assert.notEqual(second.ownerToken, first.ownerToken);
  assert.equal(await cleanupOwnedBridge({ ...env, CODEX_LINUX_CUA_HOST_OWNER_TOKEN: '' }), false);
  assert.equal(await cleanupOwnedBridge({ ...env, CODEX_LINUX_CUA_HOST_OWNER_TOKEN: second.ownerToken }), true);
  assert.equal(fs.existsSync(first.socketPath), true);
  assert.equal(await cleanupOwnedBridge({ ...env, CODEX_LINUX_CUA_HOST_OWNER_TOKEN: first.ownerToken }), true);
  const deadline = Date.now() + 3000;
  while (fs.existsSync(first.socketPath) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(fs.existsSync(first.socketPath), false);
});

test('launcher registers a new owner while the previous launcher exits', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-use-restart-'));
  let cleanup;
  t.after(() => {
    try { cleanup?.(); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtime = path.join(root, 'runtime');
  const appDir = path.join(root, 'app');
  const scripts = path.join(appDir, 'resources/plugins/openai-bundled/plugins/unified-computer-use/scripts');
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.mkdirSync(scripts, { recursive: true });
  for (const name of ['native-backend-service.mjs', 'native-protocol.mjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(scripts, name));
  }
  const owner = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.after(() => { try { owner.kill('SIGKILL'); } catch {} });
  const deadline = Date.now() + 3000;
  let ownerStartTime;
  while (!ownerStartTime && Date.now() < deadline) {
    try {
      const stat = fs.readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
      ownerStartTime = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    } catch {}
    if (!ownerStartTime) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(ownerStartTime);
  const baseEnv = {
    ...process.env,
    XDG_RUNTIME_DIR: runtime,
    CODEX_LINUX_APP_DIR: appDir,
    CODEX_LINUX_APP_ID: 'codex-test',
    CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE: process.execPath,
  };
  const { cleanupOwnedBridge, launchHostBridge } = await import('./host-service.mjs');
  const first = await launchHostBridge({ ...baseEnv, CODEX_LINUX_LAUNCHER_PID: String(owner.pid) });
  owner.kill('SIGKILL');
  await new Promise(resolve => owner.once('exit', resolve));

  const secondEnv = { ...baseEnv, CODEX_LINUX_LAUNCHER_PID: String(process.pid) };
  const second = await launchHostBridge(secondEnv);
  cleanup = () => cleanupOwnedBridge({ ...secondEnv, CODEX_LINUX_CUA_HOST_OWNER_TOKEN: second.ownerToken });
  assert.match(second.ownerToken, /^[a-f0-9]{48}$/);
  assert.notEqual(second.ownerToken, first.ownerToken);
});
