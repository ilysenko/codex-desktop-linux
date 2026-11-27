"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { once, EventEmitter } = require("node:events");
const { MessageChannel } = require("node:worker_threads");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { attach } = require("./bridge-main");
const utility = require("./bridge-utility");
const { patchExtractedApp, patchMain, patchHost } = require("./patch");

class PortAdapter extends EventEmitter {
  constructor(port) {
    super(); this.port = port;
    port.on("message", (data) => this.emit("message", { data }));
    port.on("close", () => this.emit("close"));
  }
  start() { this.port.start(); }
  close() { this.port.close(); }
  postMessage(data) { this.port.postMessage(data); }
}
class ChannelAdapter {
  constructor() {
    const { port1, port2 } = new MessageChannel();
    this.port1 = new PortAdapter(port1); this.port2 = new PortAdapter(port2);
  }
}
const worker = new EventEmitter();
worker.postMessage = (data, ports) => utility.accept({ data, ports });
const cleanup = attach(worker, { MessageChannelMain: ChannelAdapter });
test.after(() => cleanup());

async function output(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test("bridge forwards stdio with backpressure and exit status", async () => {
  const script = 'process.stdin.pipe(process.stdout);process.stdin.on("end",()=>{process.stderr.write("done");process.exitCode=7})';
  const child = await utility.spawn(process.execPath, ["-e", script], { env: process.env });
  const stdout = output(child.stdout), stderr = output(child.stderr), exit = once(child, "exit");
  const input = "zażółć 🐈".repeat(70_000);
  child.stdin.end(input);
  assert.equal(await stdout, input);
  assert.equal(await stderr, "done");
  assert.deepEqual(await exit, [7, null]);
});

test("bridge reports spawn failures", async () => {
  await assert.rejects(utility.spawn("/nonexistent/codex", [], { env: process.env }), /ENOENT/);
});

test("bridge preserves the requested working directory and environment", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-cwd-"));
  try {
    const child = await utility.spawn(process.execPath, ["-e", 'process.stdout.write(JSON.stringify([process.cwd(),process.env.BRIDGE_TEST_VALUE]))'], {
      cwd, env: { ...process.env, BRIDGE_TEST_VALUE: "chosen value" },
    });
    const stdout = output(child.stdout), exit = once(child, "exit");
    assert.deepEqual(JSON.parse(await stdout), [cwd, "chosen value"]);
    assert.deepEqual(await exit, [0, null]);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test("bridge preserves the main process no-new-privileges state", { skip: process.platform !== "linux" }, async () => {
  const mainStatus = fs.readFileSync("/proc/self/status", "utf8").match(/^NoNewPrivs:\s*(\d+)/m)[1];
  const script = 'process.stdout.write(require("fs").readFileSync("/proc/self/status","utf8").match(/^NoNewPrivs:\\s*(\\d+)/m)[1])';
  const child = await utility.spawn(process.execPath, ["-e", script], { env: process.env });
  const stdout = output(child.stdout);
  const exit = once(child, "exit");
  assert.equal(await stdout, mainStatus);
  assert.deepEqual(await exit, [0, null]);
});

test("bridge terminates the owned child", async () => {
  const child = await utility.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env });
  const exit = once(child, "exit");
  assert.equal(child.kill(), true);
  assert.deepEqual(await exit, [null, "SIGTERM"]);
});

test("patches the utility fork only at a unique current anchor", () => {
  const main = '"App server utility started";function(e){let{entry:t,serviceName:r}=s[e];return i.utilityProcess.fork((0,n.join)(__dirname,t),[],{serviceName:r})}';
  assert.match(patchMain(main), /app-server-host.*bridge-main\.js/);
  assert.equal(patchMain(main + main), null);
});

test("patches only the local app-server stdio path", () => {
  const host = 'process.parentPort.on("message",e=>{});this.spawnProcess();spawnProcess(){let i=(0,n.spawn)(t,r,{stdio:["pipe","pipe","pipe"],env:this.options.env,cwd:this.options.cwd});if(!i.pid)throw Error(`Failed to spawn Codex CLI`)};new G({...t,args:[...t.args,...n??[]]},this.ioStatsTracker)';
  const patched = patchHost(host);
  assert.match(patched, /codexLinuxLocalAppServer:this\.options\.hostConfig\.kind===\"local\"/);
  assert.match(patched, /bridge-utility\.js/);
  const condition = patched.match(/codexLinuxLocalAppServer:(.*?),args:\[/)?.[1];
  assert.ok(condition);
  const useBridge = new Function("t", `return (${condition})`); // eslint-disable-line no-new-func
  const selected = (hostConfig, options = {}, launch = {}) =>
    useBridge.call({ options: { hostConfig, ...options } }, launch);
  assert.equal(selected({ kind: "local", id: "local" }), true);
  assert.equal(selected({ kind: "local", id: "durable" }), false);
  assert.equal(selected({ kind: "ssh", id: "local" }), false);
  assert.equal(selected({ kind: "local", id: "local" }, { startupCommand: {} }), false);
  assert.equal(selected({ kind: "local", id: "local" }, {}, { spawnCommand: "ssh" }), false);
  assert.equal(patchHost(host.replace("spawnProcess(){", "spawnProcessChanged(){")), null);
  assert.equal(patchHost(host.replace("if(!i.pid)", "if(i.pid==null)")), null);
});

test("patches both launch sites in the signed upstream bundle", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, async () => {
  const build = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
  const chunks = fs.readdirSync(build).filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/.test(name));
  const patched = chunks.map((name) => patchMain(fs.readFileSync(path.join(build, name), "utf8"))).filter(Boolean);
  assert.equal(patched.length, 1);
  const host = patchHost(fs.readFileSync(path.join(build, "app-server-host.js"), "utf8"));
  assert.ok(host);
  new vm.Script(patched[0]);
  new vm.Script(host);
  // Closing while the main-process spawn is still in flight must kill the
  // eventual child instead of reopening an already closed connection.
  const methodStart = host.indexOf("async spawnProcess(){");
  const methodEnd = host.indexOf("}onProcessError=", methodStart);
  assert.ok(methodStart >= 0 && methodEnd > methodStart);
  const method = host.slice(methodStart, methodEnd + 1);
  let resolveSpawn;
  const bridge = { spawn: () => new Promise((resolve) => { resolveSpawn = resolve; }) };
  const load = (name) => name === "node:path" ? { join: () => "bridge" } : bridge;
  const spawnProcess = new Function("h", "n", "I", "p", "a", "require", // eslint-disable-line no-new-func
    `return (class {${method}}).prototype.spawnProcess`)(
    { K: { resolve: () => null } }, {}, { vj: { Connecting: 0, Closed: 3 } }, {}, {}, load,
  );
  const connection = { options: { executablePath: "/codex", args: [], env: {}, codexLinuxLocalAppServer: true }, readyState: 0 };
  let killed = false;
  const starting = spawnProcess.call(connection);
  connection.readyState = 3;
  resolveSpawn({ pid: 123, kill: () => { killed = true; } });
  await starting;
  assert.equal(killed, true);
  assert.equal(connection.proc, undefined);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-patch-"));
  try {
    const target = path.join(temp, ".vite", "build");
    fs.mkdirSync(target, { recursive: true });
    for (const name of [...chunks, "app-server-host.js"]) fs.copyFileSync(path.join(build, name), path.join(target, name));
    assert.deepEqual(patchExtractedApp(temp), { matched: true, changed: true });
    assert.deepEqual(patchExtractedApp(temp), { matched: true, changed: false });
    const hostFile = path.join(target, "app-server-host.js");
    const damaged = fs.readFileSync(hostFile, "utf8").replace("codexLinuxLocalAppServer:", "incompleteBridge:");
    fs.writeFileSync(hostFile, damaged);
    assert.equal(patchExtractedApp(temp).matched, false);
    assert.equal(fs.readFileSync(hostFile, "utf8"), damaged);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("closing the utility port terminates children and rejects further launches", async () => {
  const child = await utility.spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: process.env });
  const pid = child.pid;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.on("error", () => {});
  worker.emit("exit", 0);
  await closed;
  await assert.rejects(utility.spawn(process.execPath, [], { env: process.env }), /disconnected/);
  child.stdin.on("error", () => {});
  const writeError = await new Promise((resolve) => child.stdin.write("late input", resolve));
  assert.match(writeError.message, /bridge disconnected/);
  assert.equal(child.kill(), false);
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("child survived its utility process");
});
