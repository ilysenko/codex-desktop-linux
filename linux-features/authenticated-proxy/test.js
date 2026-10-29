#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  applyAuthenticatedProxyPatch,
  descriptors,
} = require("./patch.js");

const hookPath = path.join(__dirname, "launcher-hook.sh");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function applyPatchTwiceWithoutWarnings(patchFn, source) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const patched = applyPatchTwice(patchFn, source);
    assert.deepEqual(warnings, []);
    return patched;
  } finally {
    console.warn = originalWarn;
  }
}

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "authenticated-proxy-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runHook(env, args = []) {
  const result = spawnSync("bash", [hookPath, ...args], {
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? os.homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...env,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return {
    stdout: result.stdout.split(/\n/).filter(Boolean),
    stderr: result.stderr,
  };
}

function protocolMap(lines) {
  const env = new Map();
  const electronArgs = [];

  for (const line of lines) {
    if (line.startsWith("env ")) {
      const assignment = line.slice("env ".length);
      const index = assignment.indexOf("=");
      assert.notEqual(index, -1);
      env.set(assignment.slice(0, index), assignment.slice(index + 1));
    } else if (line.startsWith("electron-arg ")) {
      electronArgs.push(line.slice("electron-arg ".length));
    } else {
      assert.fail(`unexpected hook output: ${line}`);
    }
  }

  return { env, electronArgs };
}

test("authenticated-proxy stays disabled until listed in features.json", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["authenticated-proxy"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [["feature:authenticated-proxy:main-process-proxy-auth", "main-bundle", "optional"]],
    );
  });
});

test("authenticated-proxy stages a launcher hook", () => {
  withFeatureConfig(["authenticated-proxy"], (featuresRoot) => {
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "authenticated-proxy-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, hook.target, hook.mode.toString(8)]),
        [["launcher", ".codex-linux/launcher.d/authenticated-proxy-authenticated-proxy.sh", "755"]],
      );
      assert.equal(
        fs.statSync(path.join(appDir, ".codex-linux", "launcher.d", "authenticated-proxy-authenticated-proxy.sh")).mode & 0o777,
        0o755,
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("authenticated-proxy descriptor is optional and patch entrypoint is valid", () => {
  assert.deepEqual(
    descriptors.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
    [["main-process-proxy-auth", "main-bundle", "optional"]],
  );
});

test("launcher hook derives Electron args from explicit CODEX_LINUX_PROXY env", () => {
  const result = runHook({
    CODEX_LINUX_PROXY_SERVER: "http://192.0.2.20:8080",
    CODEX_LINUX_PROXY_USERNAME: "user",
    CODEX_LINUX_PROXY_PASSWORD: "p@ss word",
  });
  const protocol = protocolMap(result.stdout);

  assert.deepEqual(protocol.electronArgs, ["--proxy-server=http://192.0.2.20:8080"]);
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_SERVER"), "http://192.0.2.20:8080");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_AUTH_HOST"), "192.0.2.20");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_AUTH_PORT"), "8080");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_USERNAME"), "user");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_PASSWORD"), "p@ss word");
});

test("launcher hook derives proxy config from standard proxy env", () => {
  const result = runHook({
    https_proxy: "http://user:p%40ss@198.51.100.10:3128",
    no_proxy: "localhost,127.0.0.1",
  });
  const protocol = protocolMap(result.stdout);

  assert.deepEqual(protocol.electronArgs, [
    "--proxy-server=http://198.51.100.10:3128",
    "--proxy-bypass-list=localhost;127.0.0.1",
  ]);
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_SERVER"), "http://198.51.100.10:3128");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_BYPASS_LIST"), "localhost;127.0.0.1");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_AUTH_HOST"), "198.51.100.10");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_AUTH_PORT"), "3128");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_USERNAME"), "user");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_PASSWORD"), "p@ss");
  assert.match(result.stderr, /Derived CODEX_LINUX_PROXY_SERVER from https_proxy/);
});

test("launcher hook does not override an explicit --proxy-server arg", () => {
  const result = runHook(
    {
      CODEX_LINUX_PROXY_SERVER: "http://192.0.2.20:8080",
      CODEX_LINUX_PROXY_USERNAME: "user",
      CODEX_LINUX_PROXY_PASSWORD: "secret",
    },
    ["--proxy-server=http://203.0.113.10:8888"],
  );
  const protocol = protocolMap(result.stdout);

  assert.deepEqual(protocol.electronArgs, []);
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_AUTH_HOST"), "");
  assert.equal(protocol.env.get("CODEX_LINUX_PROXY_AUTH_PORT"), "");
  assert.equal(protocol.env.has("CODEX_LINUX_PROXY_SERVER"), false);
  assert.match(result.stderr, /Ignoring CODEX_LINUX_PROXY_\* env/);
});

test("launcher hook shell syntax is valid", () => {
  const result = spawnSync("bash", ["-n", hookPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

// rspack chunk fixture: CommonJS chunk, Electron reached through a module-local
// alias, double-quoted strings and `null==x` comparisons as in the signed bundle.
const READY = 'async function boot(){let eT=Date.now();if(await ea.app.whenReady(),ew("main app.whenReady resolved",eT),!1){}return eT}';
const FETCH = 'class Fetcher{constructor(){this.options={applicationNetwork:ea.net}}async performDesktopFetch(){let o={},n="GET",i=null,l="https://chatgpt.com/wham/usage",h={aborted:!1,addEventListener(){},removeEventListener(){}},m=!0,v=null,s="follow",C=()=>null,e;if(null==i){let t={method:n,headers:o,body:C(),redirect:null==v?s:"error",signal:h,credentials:m?"include":"same-origin"};e=await this.options.applicationNetwork.fetch(l,t)}else e=await this.performProgressRequest({body:C(),headers:o,method:n,onUploadProgress:i,resolvedUrl:l,redirect:null==v?void 0:"error",signal:h,useSessionCookies:m});return e}';
const REQUEST = 'performProgressRequest({body:e,headers:t,method:r,onUploadProgress:n,resolvedUrl:i,redirect:s,signal:a,useSessionCookies:o}){return new Promise((l,c)=>{let d=this.options.applicationNetwork.request({method:r,url:i,redirect:s,headers:t,useSessionCookies:o}),u=-1,h=()=>{let e=d.getUploadProgress();e.started&&e.current!==u&&(u=e.current,n({loaded:e.current,total:e.total}))},p=setInterval(h,50),m=()=>{clearInterval(p)},g=()=>{m(),a.removeEventListener("abort",f)},f=()=>{g(),d.abort(),c(new DOMException("The operation was aborted","AbortError"))};if(a.addEventListener("abort",f,{once:!0}),a.aborted)return void f();d.on("error",e=>{g(),c(e)}),d.on("response",e=>{h(),m();let t=[];e.on("data",e=>{t.push(e)}),e.on("error",e=>{g(),c(e)}),e.on("end",()=>{g();let r=Buffer.concat(t),n=new Headers;for(let[t,r]of Object.entries(e.headers))for(let e of Array.isArray(r)?r:[r])n.append(t,e);l(new Response(0===r.length?null:r,{status:e.statusCode,statusText:e.statusMessage,headers:n}))})});let _=e instanceof ArrayBuffer?Buffer.from(e):e;d.end(_)})}}';

function chunk(body) {
  return `exports.ids=[916],exports.modules={35575(e,t,r){"use strict";r.d(t,{boot:()=>boot,Fetcher:()=>Fetcher});var ea=r(4482),ew=()=>{};${body}}};`;
}

const CURRENT = chunk(READY + FETCH + REQUEST);

function withWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

// Load a chunk the way the rspack runtime does: run the CommonJS file, then
// call the module factory with a require function that resolves externals.
function loadChunk(source, context) {
  const chunkExports = {};
  vm.runInNewContext(source, { ...context, exports: chunkExports, require: undefined });
  const moduleExports = {};
  const load = (id) => {
    assert.equal(id, 4482);
    return context.electron;
  };
  load.d = (target, getters) => {
    for (const [key, getter] of Object.entries(getters)) Object.defineProperty(target, key, { get: getter });
  };
  chunkExports.modules[35575]({}, moduleExports, load);
  return moduleExports;
}

function proxyEnv() {
  return {
    CODEX_LINUX_PROXY_AUTH_HOST: "proxy.example",
    CODEX_LINUX_PROXY_AUTH_PORT: "8080",
    CODEX_LINUX_PROXY_USERNAME: "user",
    CODEX_LINUX_PROXY_PASSWORD: "p@ss",
  };
}

test("registers Linux proxy authentication before Electron app ready", async () => {
  const patched = applyPatchTwiceWithoutWarnings(applyAuthenticatedProxyPatch, CURRENT);
  assert.ok(patched.startsWith("function codexLinuxProxyAuthHost("), "helpers live at chunk scope");
  assert.match(patched, /if\(\(codexLinuxInstallProxyAuthHandler\(ea\),await ea\.app\.whenReady\(\)\),ew\("main app\.whenReady resolved"/);
  assert.doesNotThrow(() => new vm.Script(patched));

  const handlers = {};
  const order = [];
  const app = {
    on(event, handler) {
      order.push(`on:${event}`);
      handlers[event] = handler;
    },
    whenReady() {
      order.push("whenReady");
      return Promise.resolve();
    },
  };
  const module = loadChunk(patched, {
    Date,
    process: { platform: "linux", env: proxyEnv() },
    electron: { app, net: {} },
  });
  await module.boot();
  assert.deepEqual(order, ["on:login", "whenReady"]);

  let prevented = 0;
  let credentials = null;
  const login = (authInfo) => {
    credentials = null;
    handlers.login(
      { preventDefault() { prevented += 1; } },
      null,
      null,
      authInfo,
      (username, password) => {
        credentials = { username, password };
      },
    );
    return credentials;
  };

  assert.deepEqual(login({ isProxy: true, host: "PROXY.EXAMPLE", port: 8080 }), { username: "user", password: "p@ss" });
  assert.equal(prevented, 1);
  assert.equal(login({ isProxy: false, host: "proxy.example", port: 8080 }), null);
  assert.equal(login({ isProxy: true, host: "proxy.example" }), null);
  assert.equal(prevented, 1);
});

test("Linux proxy authentication stays inert without credentials", async () => {
  const patched = applyAuthenticatedProxyPatch(CURRENT);
  const app = {
    on() {
      assert.fail("no login handler without configured credentials");
    },
    whenReady() {
      return Promise.resolve();
    },
  };
  const module = loadChunk(patched, { Date, process: { platform: "linux", env: {} }, electron: { app, net: {} } });
  await module.boot();
});

test("ClientRequest proxy authentication refuses unrelated challenges", () => {
  const patched = applyAuthenticatedProxyPatch(CURRENT);
  const context = { globalThis: {}, process: { platform: "linux", env: proxyEnv() }, exports: {} };
  vm.runInNewContext(`${patched};globalThis.attachProxyAuth=codexLinuxAttachProxyAuthToRequest`, context);

  function credentialsFor(authInfo) {
    let handler = null;
    context.globalThis.attachProxyAuth({
      on(event, callback) {
        assert.equal(event, "login");
        handler = callback;
      },
    });
    assert.equal(typeof handler, "function");
    let args = null;
    handler(authInfo, (...values) => {
      args = values;
    });
    return args;
  }

  assert.deepEqual(credentialsFor({ isProxy: false, host: "proxy.example", port: 8080 }), []);
  assert.deepEqual(credentialsFor({ isProxy: true, host: "other.example", port: 8080 }), []);
  assert.deepEqual(credentialsFor({ isProxy: true, host: "proxy.example", port: 3128 }), []);
  assert.deepEqual(credentialsFor({ isProxy: true, host: "proxy.example" }), []);
  assert.deepEqual(credentialsFor({ isProxy: true, host: "PROXY.EXAMPLE", port: 8080 }), ["user", "p@ss"]);
});

test("leaves an incomplete existing proxy helper set untouched", () => {
  const source = "function codexLinuxInstallProxyAuthHandler(e){return e}" + CURRENT;
  const { result, warnings } = withWarnings(() => applyAuthenticatedProxyPatch(source));
  assert.equal(result, source);
  assert.deepEqual(warnings, ["WARN: Found incomplete Linux proxy authentication helpers - skipping patch"]);
});

test("routes current authenticated proxy desktop fetch shape through ClientRequest", async () => {
  const patched = applyPatchTwiceWithoutWarnings(applyAuthenticatedProxyPatch, CURRENT);
  assert.match(patched, /if\(null==i&&!codexLinuxProxyAuthEntry\(\)\)\{let t=/);
  assert.match(patched, /codexLinuxAttachProxyAuthToRequest\(d\);let u=-1,h=\(\)=>\{if\(n==null\)return;/);

  let fetchCalls = 0;
  const plain = loadChunk(patched, {
    Date,
    Response,
    process: { platform: "linux", env: {} },
    electron: {
      app: { on() {}, whenReady() { return Promise.resolve(); } },
      net: {
        fetch() {
          fetchCalls += 1;
          return Promise.resolve(new Response("fetch"));
        },
        request() {
          assert.fail("ClientRequest must stay unused without proxy credentials");
        },
      },
    },
  });
  const response = await new plain.Fetcher().performDesktopFetch();
  assert.equal(fetchCalls, 1);
  assert.equal(await response.text(), "fetch");

  let requestCalls = 0;
  let credentials = null;
  const authenticated = loadChunk(patched, {
    ArrayBuffer,
    Buffer,
    DOMException,
    Date,
    Headers,
    Response,
    clearInterval,
    setInterval,
    process: { platform: "linux", env: proxyEnv() },
    electron: {
      app: { on() {}, whenReady() { return Promise.resolve(); } },
      net: {
        fetch() {
          assert.fail("net.fetch must be bypassed when proxy credentials are configured");
        },
        request() {
          requestCalls += 1;
          const handlers = {};
          return {
            abort() {},
            end() {
              handlers.login?.(
                { isProxy: true, host: "PROXY.EXAMPLE", port: 8080 },
                (username, password) => {
                  credentials = { username, password };
                },
              );
              const responseHandlers = {};
              handlers.response?.({
                statusCode: 200,
                statusMessage: "OK",
                headers: { "content-type": "text/plain" },
                on(event, handler) {
                  responseHandlers[event] = handler;
                  return this;
                },
              });
              responseHandlers.data?.(Buffer.from("request"));
              responseHandlers.end?.();
            },
            getUploadProgress() {
              return { started: false, current: 0, total: 0 };
            },
            on(event, handler) {
              handlers[event] = handler;
              return this;
            },
          };
        },
      },
    },
  });
  const authenticatedResponse = await new authenticated.Fetcher().performDesktopFetch();
  assert.equal(requestCalls, 1);
  assert.equal(authenticatedResponse.status, 200);
  assert.equal(await authenticatedResponse.text(), "request");
  assert.deepEqual(credentials, { username: "user", password: "p@ss" });
});

test("chunks without the app ready point stay untouched", () => {
  for (const source of [chunk(FETCH + REQUEST), chunk("function other(){return 1}")]) {
    const { result, warnings } = withWarnings(() => applyAuthenticatedProxyPatch(source));
    assert.equal(result, source);
    assert.ok(warnings.some((warning) => warning.includes("app ready point")));
  }
});

test("authenticated-proxy current contracts fail closed when missing, duplicate, or ambiguous", () => {
  const patched = applyAuthenticatedProxyPatch(CURRENT);
  const variants = {
    missingFetch: chunk(READY + "class Fetcher{" + REQUEST),
    missingRequest: chunk(READY + FETCH + "}"),
    duplicateReady: chunk(READY + READY.replace("boot", "boot2") + FETCH + REQUEST),
    duplicateNetwork: chunk(READY + FETCH + REQUEST + FETCH + REQUEST),
    ambiguous: patched + FETCH + REQUEST,
    retiredQuotes: chunk(READY + FETCH.replace('"include":"same-origin"', "`include`:`same-origin`") + REQUEST),
  };
  for (const [name, source] of Object.entries(variants)) {
    const { result, warnings } = withWarnings(() => applyAuthenticatedProxyPatch(source));
    assert.equal(result, source, name);
    assert.ok(warnings.some((warning) => warning.includes("unique current app ready and applicationNetwork")), name);
  }
});

test("authenticated-proxy patched request contracts fail closed when damaged or duplicated", () => {
  const patched = applyAuthenticatedProxyPatch(CURRENT);
  const patchedOwner = "let d=this.options.applicationNetwork.request({method:r,url:i,redirect:s,headers:t,useSessionCookies:o});codexLinuxAttachProxyAuthToRequest(d);let u=-1,h=()=>{if(n==null)return;let e=d.getUploadProgress();!e.started||e.current===u||(u=e.current,n({loaded:e.current,total:e.total}))}";
  assert.ok(patched.includes(patchedOwner));

  const variants = {
    mismatched: patched.replace("n({loaded:e.current,total:e.total})", "wrong({loaded:e.current,total:e.total})"),
    truncated: patched.replace("(u=e.current,n({loaded:e.current,total:e.total}))}", "(u=e.current"),
    partial: patched.replace("if(n==null)return;", ""),
    duplicate: patched.replace(patchedOwner, patchedOwner + patchedOwner),
    unready: patched.replace("(codexLinuxInstallProxyAuthHandler(ea),await ea.app.whenReady())", "await ea.app.whenReady()"),
  };
  for (const [name, source] of Object.entries(variants)) {
    assert.notEqual(source, patched, name);
    const { result, warnings } = withWarnings(() => applyAuthenticatedProxyPatch(source));
    assert.equal(result, source, name);
    assert.ok(warnings.some((warning) => warning.includes("unique current app ready and applicationNetwork")), name);
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("signed main-process chunks patch exactly one chunk", { skip: !signedApp }, () => {
  const directory = path.join(signedApp, ".vite/build");
  const changed = [];
  withWarnings(() => {
    for (const name of fs.readdirSync(directory).filter((file) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(file))) {
      const source = fs.readFileSync(path.join(directory, name), "utf8");
      const patched = applyAuthenticatedProxyPatch(source);
      if (patched !== source) changed.push({ name, patched });
    }
  });
  assert.equal(changed.length, 1);
  const [{ patched }] = changed;
  assert.doesNotThrow(() => new vm.Script(patched));
  const { result, warnings } = withWarnings(() => applyAuthenticatedProxyPatch(patched));
  assert.equal(result, patched);
  assert.deepEqual(warnings, []);
  assert.equal(patched.match(/codexLinuxInstallProxyAuthHandler\(/g).length, 2);
  assert.equal(patched.match(/codexLinuxAttachProxyAuthToRequest\(/g).length, 2);
  assert.equal(patched.match(/!codexLinuxProxyAuthEntry\(\)/g).length, 1);
});
