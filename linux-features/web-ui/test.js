"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { apply } = require("./patch");
const { listDirectories, parsePort, startServer } = require("./runtime");
const { stageEnabledLinuxFeatureInstall, loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-web-ui-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

class StubServer {
  constructor() { this.clients = new Set(); StubServer.current = this; }
  handleUpgrade(_req, socket, _head, callback) {
    const client = new EventEmitter();
    client.readyState = 1;
    client.send = value => { client.lastSent = value; };
    client.close = (code, reason) => { client.closed = { code, reason }; client.readyState = 3; client.emit("close"); };
    client.terminate = () => client.close(1001, "Stopped");
    this.clients.add(client);
    this.lastClient = client;
    callback(client);
    socket.end("HTTP/1.1 418 Accepted by test adapter\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  }
  close(callback) { callback(); }
}

async function service(t) {
  const root = directory(t), view = path.join(root, "webview");
  fs.mkdirSync(view);
  fs.writeFileSync(path.join(view, "index.html"), '<head><meta content="connect-src &#39;self&#39;;"></head><body>Official UI</body>');
  fs.writeFileSync(path.join(view, "asset.js"), "officialAsset()");
  fs.writeFileSync(path.join(root, "private"), "secret");
  fs.symlinkSync(path.join(root, "private"), path.join(view, "escape.txt"));
  const messages = [];
  const server = await startServer({ webviewRoot: view, WebSocketServer: StubServer, port: 0, sendToHost: value => messages.push(value) });
  t.after(() => server.close());
  const ws = StubServer.current;
  const login = await fetch(server.url, { redirect: "manual" });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  return { ...server, messages, cookie, ws };
}

function upgrade(server, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${server.origin}/_community/bridge`, { headers: { Connection: "Upgrade", Upgrade: "websocket", ...headers } });
    request.on("response", response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.end();
  });
}

function status(url, headers) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, response => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
}

test("capability exchange, Host checks, protected assets and filesystem confinement", async t => {
  const server = await service(t);
  const login = await fetch(server.url, { redirect: "manual" });
  assert.equal(login.status, 303);
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal(login.headers.get("location"), "/");
  for (const route of ["/", "/asset.js", "/_community/bootstrap", "/_community/browser.js"]) {
    assert.equal((await fetch(server.origin + route)).status, 403, route);
  }
  const headers = { Cookie: server.cookie };
  assert.equal(await status(server.origin, { ...headers, Host: "attacker.invalid" }), 421);
  assert.equal((await fetch(server.origin + "/asset.js", { headers, method: "POST" })).status, 405);
  assert.equal((await fetch(server.origin + "/_community/bootstrap", { headers })).status, 503);
  const index = await fetch(server.origin, { headers });
  assert.match(await index.text(), /script src="\/_community\/browser.js"/);
  assert.equal(index.headers.get("cache-control"), "no-store");
  for (const route of ["/escape.txt", "/%2e%2e%2fprivate", "/.vite/build/main.js", "/community-web-host.html", "/%00private"]) {
    assert.notEqual((await fetch(server.origin + route, { headers })).status, 200, route);
  }
  assert.equal((await fetch(server.origin + "/asset.js", { headers, method: "HEAD" })).headers.get("content-length"), "15");
});

test("WebSocket rejects cross-origin access, missing secrets, and a second browser; forwards valid messages", async t => {
  const server = await service(t);
  const headers = { Cookie: server.cookie, Origin: server.origin };
  assert.equal(await upgrade(server, headers), 403, "host must become ready");
  server.receive({ type: "bootstrap", value: { sharedObjectSnapshot: { initial: 1 } } });
  assert.equal(await upgrade(server, { Origin: server.origin }), 403);
  assert.equal(await upgrade(server, { Cookie: server.cookie, Origin: "https://attacker.invalid" }), 403);
  assert.equal(await upgrade(server, { ...headers, Host: "attacker.invalid" }), 403);
  assert.equal(await upgrade(server, headers), 418);
  const client = server.ws.lastClient;
  client.emit("message", Buffer.from(JSON.stringify({ type: "invoke", id: "1", method: "sendMessageFromView", args: [] })), false);
  assert.equal(server.messages.at(-1).id, "1");
  server.receive({ type: "result", id: "1", ok: true, value: 42 });
  assert.equal(JSON.parse(client.lastSent).value, 42);
  await upgrade(server, headers);
  assert.equal(server.ws.lastClient.closed.code, 1013);
  server.receive({ type: "notification", value: { type: "shared-object-updated", key: "initial", value: 2 } });
  const bootstrap = await fetch(server.origin + "/_community/bootstrap", { headers: { Cookie: server.cookie } }).then(response => response.json());
  assert.equal(bootstrap.sharedObjectSnapshot.initial, 2, "reload gets current shared state");
  client.emit("message", Buffer.from('{"type":"rpc","value":{"not":"string codec"}}'), false);
  assert.equal(client.closed.code, 1007);
  assert.equal(server.messages.at(-1).type, "disconnect");
  assert.equal(await upgrade(server, headers), 418, "reload can reconnect");
});

test("strict port validation and address-in-use errors", async t => {
  for (const port of ["-1", "65536", "1.2", "01", "", "4310junk"]) assert.throws(() => parsePort(port));
  assert.equal(parsePort("0"), 0);
  const server = await service(t);
  await assert.rejects(startServer({ webviewRoot: directory(t), WebSocketServer: StubServer, port: new URL(server.origin).port, sendToHost() {} }), { code: "EADDRINUSE" });
});

test("folder chooser lists host directories and validates absolute paths", t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, "visible"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "file.txt"), "not a directory");
  const result = listDirectories(root);
  assert.deepEqual(result.entries.map(entry => entry.name), ["visible"]);
  assert.equal(result.path, fs.realpathSync(root));
  assert.throws(() => listDirectories("relative"));
  assert.throws(() => listDirectories(root + "\0"));
  assert.throws(() => listDirectories(path.join(root, "file.txt")));
});

function bundle(t) {
  const root = directory(t);
  const put = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  put(".vite/build/main-test.js", 'const network=require("./network.js");let le=t.u(p);if(!e.app.isPackaged){L.loadURL(e.toString())};encodingLevel=`structuredClonable`;' + ["send", "sendInline", "sendCritical"].map(method => `${method}(e,t,n){e.isDestroyed()||this.sender.${method}(e,{channel:t,payload:n})}`).join(""));
  put(".vite/build/preload.js", 'A=e.ipcRenderer.sendSync(`codex_desktop:get-shared-object-snapshot`)??{};e.contextBridge.exposeInMainWorld(`electronBridge`,bridge)');
  put(".vite/build/network.js", 'server=r.t(((e,t)=>{var n=require("http");t.exports=class extends n{noServer:!1,backlog:null,server:null,host:null,path:null,port:null}}))');
  put("webview/assets/app-shared-test.js", 'connect-app-host;encodingLevel=`structuredClonable`');
  put("webview/index.html", '<head>connect-src </head>');
  return { root, put };
}

test("entire adaptation is idempotent and missing/ambiguous anchors cause zero writes", t => {
  const valid = bundle(t);
  assert.equal(apply(valid.root).changed, true);
  assert.equal(apply(valid.root).changed, false);
  for (const breakage of ["missing", "ambiguous", "codec"]) {
    const fixture = bundle(t);
    if (breakage === "missing") fixture.put(".vite/build/preload.js", "unsupportedPreload()");
    if (breakage === "ambiguous") fixture.put(".vite/build/other-preload.js", fs.readFileSync(path.join(fixture.root, ".vite/build/preload.js")));
    if (breakage === "codec") fixture.put("webview/assets/app-shared-test.js", "connect-app-host;encodingLevel=`changed`");
    const before = fs.readFileSync(path.join(fixture.root, ".vite/build/main-test.js"));
    assert.throws(() => apply(fixture.root));
    assert.deepEqual(fs.readFileSync(path.join(fixture.root, ".vite/build/main-test.js")), before);
    assert.equal(fs.existsSync(path.join(fixture.root, "webview/community-web-host.html")), false);
  }
});

test("feature discovery, declarative staging and disabling remove only owned resources", t => {
  const root = directory(t), app = path.join(root, "app"), config = path.join(root, "features.json");
  fs.mkdirSync(app);
  fs.writeFileSync(config, JSON.stringify({ enabled: ["web-ui"] }));
  const options = { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config };
  assert.equal(loadLinuxFeaturePatchDescriptors(options).length, 1);
  stageEnabledLinuxFeatureInstall(app, options);
  assert.ok(fs.existsSync(path.join(app, ".codex-linux/features/web-ui/runtime.js")));
  assert.equal(fs.statSync(path.join(app, ".codex-linux/launcher.d/web-ui-web-ui.sh")).mode & 0o777, 0o755);
  fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
  stageEnabledLinuxFeatureInstall(app, options);
  assert.equal(fs.existsSync(path.join(app, ".codex-linux/features/web-ui/runtime.js")), false);
});

test("minimal update-builder carries the complete patch and runtime without external dependencies", t => {
  const root = directory(t), builder = path.join(root, "builder"), config = path.join(root, "features.json");
  const repo = path.resolve(__dirname, "../..");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["web-ui"] }));
  // Paths are arguments to bash, never interpolated into executable text.
  execFileSync("bash", ["-c", 'set -euo pipefail\nREPO_DIR="$1"\n. "$REPO_DIR/scripts/lib/package-common.sh"\nstage_update_builder_linux_features_tree "$2"\nstage_update_builder_linux_features_config "$2"', "web-ui-test", repo, builder], {
    env: { ...process.env, CODEX_LINUX_FEATURES_CONFIG: config },
  });
  const feature = path.join(builder, "linux-features/web-ui");
  assert.equal(require(path.join(feature, "patch.js")).descriptors.length, 1);
  assert.equal(typeof require(path.join(feature, "runtime.js")).startServer, "function");
  const staged = path.join(root, "rebuilt-app");
  fs.mkdirSync(staged);
  stageEnabledLinuxFeatureInstall(staged, {
    featuresRoot: path.join(builder, "linux-features"),
    featuresConfigPath: path.join(builder, "linux-features/features.json"),
  });
  for (const name of ["runtime.js", "browser.js"]) {
    assert.deepEqual(fs.readFileSync(path.join(staged, ".codex-linux/features/web-ui", name)), fs.readFileSync(path.join(__dirname, name)));
  }
  assert.equal(fs.existsSync(path.join(builder, "node_modules")), false);
});
