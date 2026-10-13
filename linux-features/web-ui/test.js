"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { apply, patchMain, patchRenderer, patchCatalogRenderer, patchDictationRenderer } = require("./patch");
const vm = require("node:vm");
const { listDirectories, parseHost, parsePort, startServer } = require("./runtime");
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
  fs.writeFileSync(path.join(view, "worker.mjs"), "export {}");
  fs.writeFileSync(path.join(root, "private"), "secret");
  fs.symlinkSync(path.join(root, "private"), path.join(view, "escape.txt"));
  const messages = [];
  const server = await startServer({ webviewRoot: view, WebSocketServer: StubServer, port: 0, host: "127.0.0.1", sendToHost: value => messages.push(value) });
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
  // 200 + same-origin refresh, not a redirect: a cross-site click would make a
  // redirect cross-site and SameSite=Strict would withhold the new cookie.
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie"), /^community_web_ui_[0-9a-f]{12}=[\w-]+; HttpOnly; SameSite=Strict; Path=\/$/);
  assert.match(await login.text(), /http-equiv="refresh" content="0;url=\/"/);
  const other = await service(t);
  assert.notEqual(other.cookie.split("=")[0], server.cookie.split("=")[0], "hosts sharing a hostname keep separate cookies");
  for (const route of ["/", "/asset.js", "/_community/bootstrap", "/_community/browser.js"]) {
    assert.equal((await fetch(server.origin + route)).status, 403, route);
  }
  const headers = { Cookie: server.cookie };
  // Published Docker ports, LAN addresses and proxies present other Hosts;
  // the capability cookie, not the Host, authorizes them.
  assert.equal(await status(server.origin, { ...headers, Host: "codex.lan:8080" }), 200);
  assert.equal(await status(server.origin, { Host: "codex.lan:8080" }), 403);
  assert.equal(await status(server.origin, { ...headers, Host: "bad host\"><script>" }), 400);
  const proxied = await new Promise((resolve, reject) => http.get(server.origin, { headers: { ...headers, Host: "codex.lan:8080" } }, response => {
    let body = ""; response.on("data", chunk => { body += chunk; }).on("end", () => resolve(body));
  }).on("error", reject));
  assert.match(proxied, /connect-src ws:\/\/codex\.lan:8080 wss:\/\/codex\.lan:8080 &#39;self/);
  assert.equal((await fetch(server.origin + "/asset.js", { headers, method: "POST" })).status, 405);
  assert.equal((await fetch(server.origin + "/_community/bootstrap", { headers })).status, 503);
  const index = await fetch(server.origin, { headers });
  assert.match(await index.text(), /script src="\/_community\/browser.js"/);
  assert.equal(index.headers.get("cache-control"), "no-store");
  for (const route of ["/escape.txt", "/%2e%2e%2fprivate", "/.vite/build/main.js", "/community-web-host.html", "/%00private"]) {
    assert.notEqual((await fetch(server.origin + route, { headers })).status, 200, route);
  }
  assert.equal((await fetch(server.origin + "/asset.js", { headers, method: "HEAD" })).headers.get("content-length"), "15");
  assert.equal((await fetch(server.origin + "/worker.mjs", { headers })).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal(await status(server.origin, { ...headers, Host: "codex_desktop:4310" }), 200, "container names may contain underscores");
});

test("WebSocket rejects cross-origin access, missing secrets, and a second browser; forwards valid messages", async t => {
  const server = await service(t);
  const headers = { Cookie: server.cookie, Origin: server.origin };
  assert.equal(await upgrade(server, headers), 403, "host must become ready");
  server.receive({ type: "bootstrap", value: { sharedObjectSnapshot: { initial: 1 } } });
  assert.equal(await upgrade(server, { Origin: server.origin }), 403);
  assert.equal(await upgrade(server, { Cookie: server.cookie, Origin: "https://attacker.invalid" }), 403);
  assert.equal(await upgrade(server, { ...headers, Host: "attacker.invalid" }), 403);
  assert.equal(await upgrade(server, { Cookie: server.cookie, Host: "codex.lan:8080", Origin: "http://other.lan:8080" }), 403);
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
  server.ws.lastClient.emit("close");
  assert.equal(await upgrade(server, { Cookie: server.cookie, Host: "codex.lan:8080", Origin: "http://codex.lan:8080" }), 418, "same-origin access through a published port");
});

test("a peer resetting a rejected upgrade does not raise an uncaught error", async t => {
  const server = await service(t);
  const failures = [];
  const record = error => failures.push(error);
  process.on("uncaughtException", record);
  t.after(() => process.off("uncaughtException", record));
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => {
      const { port } = new URL(server.origin);
      const socket = require("node:net").connect(port, "127.0.0.1", () => {
        socket.write(`GET /_community/bridge HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
        socket.resetAndDestroy();
        setTimeout(resolve, 50);
      });
      socket.on("error", () => {});
    });
  }
  assert.deepEqual(failures, []);
});

test("strict port validation and address-in-use errors", async t => {
  for (const port of ["-1", "65536", "1.2", "01", "", "4310junk"]) assert.throws(() => parsePort(port));
  assert.equal(parsePort("0"), 0);
  const server = await service(t);
  await assert.rejects(startServer({ webviewRoot: directory(t), WebSocketServer: StubServer, port: new URL(server.origin).port, host: "127.0.0.1", sendToHost() {} }), { code: "EADDRINUSE" });
  for (const host of ["localhost", "", "0.0.0.0:1", "example.com"]) assert.throws(() => parseHost(host));
  for (const host of ["0.0.0.0", "127.0.0.1", "::", "::1"]) assert.equal(parseHost(host), host);
});

test("folder chooser lists host directories and validates absolute paths", t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, "visible"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "file.txt"), "not a directory");
  fs.symlinkSync(path.join(root, "visible"), path.join(root, "linked"));
  fs.symlinkSync(path.join(root, "file.txt"), path.join(root, "linked-file"));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "dangling"));
  assert.deepEqual(listDirectories(root).entries.map(entry => entry.name), ["linked", "visible"], "symlinked folders are listed");
  for (const name of ["linked", "linked-file", "dangling"]) fs.unlinkSync(path.join(root, name));
  const result = listDirectories(root);
  assert.deepEqual(result.entries.map(entry => entry.name), ["visible"]);
  assert.equal(result.path, fs.realpathSync(root));
  assert.throws(() => listDirectories("relative"));
  assert.throws(() => listDirectories(root + "\0"));
  assert.throws(() => listDirectories(path.join(root, "file.txt")));
});

const { requestWithBrowserProfile } = require("./catalog");

const catalogFixture = 'getChatGptReadInputs=e=>null;createSource:e=>makeSource(e,(e,t)=>this.fetchWrapper.fetchAuthenticatedJson(e,t));';

const catalogRendererFixture = 'async function loadProfile(){let{getChatGptRequestProfile:factory}=await Promise.resolve({getChatGptRequestProfile:()=>({kind:"chatgpt-browser"})});return factory()}' +
  'function existingOwner(){let service=client?.accessInputs,t=null;service.publishChatGptRequestProfile(t)}' +
  'function enable(){let disposed=!1,selection={kind:`chatgpt`,accountId:account};return catalog.setSourceEnabled(selection,!0).then(()=>"enabled")}';

const dictationFixture = 'async function transcribe(audio,options={}){let boundary="test-boundary",bytes=await multipart(audio,boundary);return retry(()=>client.getInstance().fetch(`/transcribe`,{method:`POST`,body:bytes,headers:{"Content-Type":`multipart/form-data; boundary=${boundary}`,...nativeHeaders()},signal:options.signal,retry:!1}).then(e=>e.json()),options.signal)}';

test("dictation uses upstream browser headers, preserving audio, cancellation and explicit Retry; desktop keeps native headers", async () => {
  for (const web of [false, true]) {
    const calls = [], audio = Buffer.from("synthetic audio bytes"), controller = new AbortController();
    let loads = 0;
    const context = vm.createContext({ electronBridge: { communityWebUi: web },
      multipart: async value => value, retry: operation => operation(),
      nativeHeaders: () => ({ originator: "Codex Desktop", "X-OpenAI-Attach-Auth": "1" }),
      loadHeadersModule: async () => { loads++; return { getChatGPTRequestHeaders: route => { assert.equal(route, "/transcribe"); return { originator: "Codex Browser", "User-Agent": "actual browser", "oai-did": "browser-device", "X-OpenAI-Attach-Auth": "1" }; } }; },
      client: { getInstance: () => ({ fetch: async (route, options) => {
        assert.equal(route, "/transcribe"); calls.push(options);
        if (calls.length === 1) throw Error("injected upload failure");
        return { json: async () => ({ text: "Synthetic dictation test." }) };
      } }) },
    });
    const source = patchDictationRenderer(dictationFixture, "requests.js");
    assert.equal(patchDictationRenderer(source, "requests.js"), source);
    vm.runInContext(source.replace('import("./requests.js")', "loadHeadersModule()"), context);
    await assert.rejects(context.transcribe(audio, { signal: controller.signal }), /injected upload failure/);
    assert.equal((await context.transcribe(audio, { signal: controller.signal })).text, "Synthetic dictation test.");
    assert.equal(loads, web ? 2 : 0);
    for (const options of calls) {
      assert.equal(options.body, audio);
      assert.equal(options.signal, controller.signal);
      assert.equal(options.retry, false);
      assert.equal(options.headers["Content-Type"], "multipart/form-data; boundary=test-boundary");
      assert.equal(options.headers.originator, web ? "Codex Browser" : "Codex Desktop");
      assert.equal(options.headers["X-OpenAI-Attach-Auth"], "1");
    }
  }
});

test("web catalog publishes the real browser profile before activation; desktop retains its original call", async () => {
  for (const web of [false, true]) {
    const calls = [];
    const context = vm.createContext({ console: { warn() {} }, electronBridge: { communityWebUi: web }, account: "account", catalog: { setSourceEnabled: async () => calls.push("enable") }, client: { accessInputs: {
      readAccountInfo: async () => { calls.push("read"); return { status: "ready", data: { accountId: "account", authenticatedUserId: "user" } }; },
      publishChatGptRequestProfile: async value => { calls.push("profile"); assert.equal(value.userId, "user"); assert.equal(value.profile.kind, "chatgpt-browser"); return true; },
    } } });
    vm.runInContext(patchCatalogRenderer(catalogRendererFixture), context);
    assert.equal(await vm.runInContext("enable()", context), "enabled");
    assert.deepEqual(calls, web ? ["read", "profile", "enable"] : ["enable"]);
    if (web) {
      context.client.accessInputs.publishChatGptRequestProfile = async () => false;
      calls.length = 0;
      await assert.rejects(vm.runInContext("enable()", context), /profile changed/);
      assert.equal(calls.includes("enable"), false);
    }
  }
});

test("minified catalog host and URL bindings stay separate in web and desktop requests", async t => {
  const fixture = bundle(t);
  const patched = patchMain(fs.readFileSync(path.join(fixture.root, ".vite/build/main-test.js"), "utf8"), "network.js");
  const callback = patched.match(/createSource:([^;]+)/)[1];
  for (const web of [false, true]) {
    const principal = { accountId: "account", userId: "user" }, profile = { kind: "chatgpt-browser" };
    const options = { signal: new AbortController().signal };
    const context = vm.createContext({ process: { resourcesPath: "/app/application/resources", env: { CODEX_WEB_UI: web ? "1" : "0" } }, makeSource: (id, fetch) => ({ id, fetch }),
      require: name => name === "node:path" ? path : { requestWithBrowserProfile },
      owner: {
        appServerConnectionRegistry: { getConnection: () => ({ getCachedAuthenticatedPrincipal: () => principal }) },
        accessInputs: { getChatGptReadInputs: () => ({ profile, signal: new AbortController().signal }) },
        fetchWrapper: { fetchAuthenticatedJson: (url, options) => ({ url, options }) },
      },
    });
    const source = vm.runInContext(`(function(){return (${callback})}).call(owner)("chatgpt:account:user")`, context);
    assert.equal(source.id, "chatgpt:account:user");
    const result = await source.fetch("/conversations?offset=0", options);
    assert.equal(result.url, "/conversations?offset=0");
    if (web) assert.equal(result.options.requestProfile, profile);
    else assert.equal(result.options, options, "desktop request options are untouched");
  }
});

test("catalog reuses the validated browser profile, preserving method/body and principal binding", async () => {
  const principal = { accountId: "account", userId: "user" };
  const profile = { kind: "chatgpt-browser", userAgent: "real-browser" };
  const controller = new AbortController(), inputsController = new AbortController();
  const body = { conversation_ids: ["test"] };
  let reads = 0;
  const result = await requestWithBrowserProfile("chatgpt:account:user", { signal: controller.signal, method: "POST", body }, {
    readPrincipal: () => principal,
    readInputs: identity => {
      assert.deepEqual(identity, { kind: "chatgpt", ...principal });
      return ++reads === 1 ? null : { profile, signal: inputsController.signal };
    },
    fetch: options => options,
  });
  assert.equal(reads, 2, "waits for the renderer instead of sending a headless request");
  assert.equal(result.requestProfile, profile);
  assert.equal(result.expectedPrincipal, principal);
  assert.equal(result.body, body);
  assert.equal(result.method, "POST");
  inputsController.abort();
  assert.equal(result.signal.aborted, true, "sign-out retires the request");
});

test("catalog waits are bounded, cancellable, and never fetch with a different principal", async () => {
  const controller = new AbortController();
  const services = { readPrincipal: () => ({ accountId: "account", userId: "user" }), readInputs: () => null, fetch: () => { throw Error("must not fetch"); } };
  await assert.rejects(requestWithBrowserProfile("chatgpt:other:user", { signal: controller.signal }, services), { name: "AbortError" });
  const pending = requestWithBrowserProfile("chatgpt:account:user", { signal: controller.signal }, services);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(requestWithBrowserProfile("chatgpt:account:user", { signal: new AbortController().signal }, services, 10), error => error.name === "AbortError" || error.name === "TimeoutError");
  // A cold principal defers to upstream's request, which refreshes the token.
  const options = { signal: new AbortController().signal };
  assert.equal(await requestWithBrowserProfile("chatgpt:account:user", options, { ...services, readPrincipal: () => undefined, fetch: value => value }), options);
});

const capabilityFixture = 'function capability(e){let n=registry[e.name];if(n==null||!supported(n))return{isLoading:!1,isError:!1,isCapable:!1};let r=[...n.accessPolicies.map(e=>e)];return{isLoading:!1,isError:!1,isCapable:!0}}';

test("web mode disables only the embedded browser capability; desktop and coding tools retain upstream results", () => {
  const source = patchRenderer(capabilityFixture + ';let encodingLevel=`structuredClonable`;');
  for (const web of [false, true]) {
    const context = vm.createContext({ electronBridge: { communityWebUi: web }, registry: {
      "browser.in-app": { accessPolicies: [] }, "desktop.local-executor": { accessPolicies: [] },
    }, supported: () => true });
    vm.runInContext(source, context);
    assert.equal(vm.runInContext('capability({name:"browser.in-app"}).isCapable', context), !web);
    assert.equal(vm.runInContext('capability({name:"desktop.local-executor"}).isCapable', context), true);
    assert.equal(vm.runInContext('capability({name:"unknown"}).isCapable', context), false);
    assert.equal(vm.runInContext('encodingLevel', context), web ? "string" : "structuredClonable");
  }
});

function bundle(t) {
  const root = directory(t);
  const put = (file, value) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  put(".vite/build/main-test.js", 'const network=require("./network.js");let le=t.u(p);if(!e.app.isPackaged){L.loadURL(e.toString())};encodingLevel=`structuredClonable`;' + catalogFixture + ["send", "sendInline", "sendCritical"].map(method => `${method}(e,t,n){e.isDestroyed()||this.sender.${method}(e,{channel:t,payload:n})}`).join(""));
  put(".vite/build/preload.js", 'A=e.ipcRenderer.sendSync(`codex_desktop:get-shared-object-snapshot`)??{};e.contextBridge.exposeInMainWorld(`electronBridge`,bridge)');
  put(".vite/build/network.js", 'server=r.t(((e,t)=>{var n=require("http");t.exports=class extends n{noServer:!1,backlog:null,server:null,host:null,path:null,port:null}}))');
  put("webview/assets/app-shared-test.js", 'connect-app-host;encodingLevel=`structuredClonable`;' + capabilityFixture);
  put("webview/assets/app-initial-test.js", catalogRendererFixture + dictationFixture);
  put("webview/assets/requests-test.js", 'export{headers as getChatGPTRequestHeaders,profile as getChatGptRequestProfile};');
  put("webview/index.html", '<head>connect-src </head>');
  return { root, put };
}

test("entire adaptation is idempotent and missing/ambiguous anchors cause zero writes", t => {
  const valid = bundle(t);
  assert.equal(apply(valid.root).changed, true);
  assert.equal(apply(valid.root).changed, false);
  for (const breakage of ["missing", "ambiguous", "codec", "capability", "duplicate-capability", "catalog", "duplicate-catalog", "request-profile", "catalog-activation", "dictation", "duplicate-dictation", "request-exports", "shared-bundle", "unparseable-dictation"]) {
    const fixture = bundle(t);
    if (breakage === "missing") fixture.put(".vite/build/preload.js", "unsupportedPreload()");
    if (breakage === "ambiguous") fixture.put(".vite/build/other-preload.js", fs.readFileSync(path.join(fixture.root, ".vite/build/preload.js")));
    if (breakage === "codec") fixture.put("webview/assets/app-shared-test.js", "connect-app-host;encodingLevel=`changed`");
    if (breakage === "capability") fixture.put("webview/assets/app-shared-test.js", "connect-app-host;encodingLevel=`structuredClonable`");
    if (breakage === "duplicate-capability") fixture.put("webview/assets/app-shared-test.js", "connect-app-host;encodingLevel=`structuredClonable`;" + capabilityFixture + capabilityFixture);
    if (breakage === "catalog-activation") fixture.put("webview/assets/app-initial-test.js", catalogRendererFixture.replace("setSourceEnabled", "changed"));
    if (breakage === "dictation") fixture.put("webview/assets/app-initial-test.js", catalogRendererFixture);
    if (breakage === "duplicate-dictation") fixture.put("webview/assets/app-initial-test.js", catalogRendererFixture + dictationFixture + dictationFixture);
    if (breakage === "shared-bundle") {
      fixture.put("webview/assets/app-shared-test.js", "connect-app-host;encodingLevel=`structuredClonable`;" + capabilityFixture + catalogRendererFixture + dictationFixture);
      fixture.put("webview/assets/app-initial-test.js", "initial()");
    }
    if (breakage === "unparseable-dictation") fixture.put("webview/assets/app-initial-test.js", catalogRendererFixture + dictationFixture.replace("return retry(", "if(audio)return retry("));
    if (breakage === "request-exports") fixture.put("webview/assets/requests-test.js", "unsupportedExports()");
    const mainFile = path.join(fixture.root, ".vite/build/main-test.js");
    if (breakage === "catalog") fixture.put(".vite/build/main-test.js", fs.readFileSync(mainFile, "utf8").replace(catalogFixture, ""));
    if (breakage === "duplicate-catalog") fixture.put(".vite/build/main-test.js", fs.readFileSync(mainFile, "utf8") + catalogFixture);
    if (breakage === "request-profile") fixture.put(".vite/build/main-test.js", fs.readFileSync(mainFile, "utf8").replace("getChatGptReadInputs=", "changed="));
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
  for (const name of ["runtime.js", "browser.js", "catalog.js"]) {
    assert.deepEqual(fs.readFileSync(path.join(staged, ".codex-linux/features/web-ui", name)), fs.readFileSync(path.join(__dirname, name)));
  }
  assert.equal(fs.existsSync(path.join(builder, "node_modules")), false);
});
