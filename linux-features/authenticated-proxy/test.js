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

test("registers Linux proxy authentication before Electron app ready", async () => {
  const source = [
    "let n=require(`electron`);",
    "async function boot(){",
    "t.Er().info(`Launching app`,{safe:{agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});",
    "let A=Date.now();",
    "await n.app.whenReady();",
    "return A}",
  ].join("");
  const patched = applyPatchTwiceWithoutWarnings(applyAuthenticatedProxyPatch, source);

  assert.match(patched, /function codexLinuxInstallProxyAuthHandler\(e\)/);
  assert.match(patched, /codexLinuxInstallProxyAuthHandler\(n\);await n\.app\.whenReady\(\)/);

  const handlers = {};
  const calls = { whenReady: 0 };
  const app = {
    on(event, handler) {
      handlers[event] = handler;
    },
    whenReady() {
      calls.whenReady += 1;
      return Promise.resolve();
    },
  };
  const context = {
    Date,
    process: {
      platform: "linux",
      env: {
        CODEX_LINUX_PROXY_AUTH_HOST: "proxy.example",
        CODEX_LINUX_PROXY_AUTH_PORT: "8080",
        CODEX_LINUX_PROXY_USERNAME: "user",
        CODEX_LINUX_PROXY_PASSWORD: "p@ss",
      },
    },
    require(name) {
      assert.equal(name, "electron");
      return { app };
    },
    t: {
      Er() {
        return { info() {} };
      },
    },
  };

  await vm.runInNewContext(`${patched};boot()`, context);
  assert.equal(calls.whenReady, 1);
  assert.equal(typeof handlers.login, "function");

  let prevented = 0;
  let credentials = null;
  handlers.login(
    { preventDefault() { prevented += 1; } },
    null,
    null,
    { isProxy: true, host: "PROXY.EXAMPLE", port: 8080 },
    (username, password) => {
      credentials = { username, password };
    },
  );

  assert.equal(prevented, 1);
  assert.deepEqual(credentials, { username: "user", password: "p@ss" });

  credentials = null;
  handlers.login(
    { preventDefault() { prevented += 1; } },
    null,
    null,
    { isProxy: false, host: "proxy.example", port: 8080 },
    (username, password) => {
      credentials = { username, password };
    },
  );

  assert.equal(prevented, 1);
  assert.equal(credentials, null);

  handlers.login(
    { preventDefault() { prevented += 1; } },
    null,
    null,
    { isProxy: true, host: "proxy.example" },
    (username, password) => {
      credentials = { username, password };
    },
  );

  assert.equal(prevented, 1);
  assert.equal(credentials, null);
});

test("ClientRequest proxy authentication refuses unrelated challenges", () => {
  const source = [
    "let n=require(`electron`);",
    "async function boot(){await n.app.whenReady()}",
  ].join("");
  const patched = applyPatchTwiceWithoutWarnings(applyAuthenticatedProxyPatch, source);
  const context = {
    globalThis: {},
    process: {
      platform: "linux",
      env: {
        CODEX_LINUX_PROXY_AUTH_HOST: "proxy.example",
        CODEX_LINUX_PROXY_AUTH_PORT: "8080",
        CODEX_LINUX_PROXY_USERNAME: "user",
        CODEX_LINUX_PROXY_PASSWORD: "p@ss",
      },
    },
    require(name) {
      assert.equal(name, "electron");
      return { app: { on() {}, whenReady() { return Promise.resolve(); } } };
    },
  };
  vm.runInNewContext(
    `${patched};globalThis.attachProxyAuth=codexLinuxAttachProxyAuthToRequest`,
    context,
  );

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
  assert.deepEqual(credentialsFor({ isProxy: true, host: "PROXY.EXAMPLE", port: 8080 }), [
    "user",
    "p@ss",
  ]);
});

test("leaves an incomplete existing proxy helper set untouched", () => {
  const source = [
    "let c=require(`electron`);",
    "function codexLinuxInstallProxyAuthHandler(e){return e}",
    "async function boot(){await c.app.whenReady()}",
    "class Fetcher{",
    "async performDesktopFetch(){let t={},r=`GET`,i=null,a=`https://example.test`,o={},s=false,m=()=>null;let n=this.cloneHeaders(t);let f=i==null?await c.net.fetch(a,{method:r,headers:n,body:m(),signal:o,credentials:s?`include`:`same-origin`}):await this.performProgressRequest({body:m(),headers:n,method:r,onUploadProgress:i,resolvedUrl:a,signal:o,useSessionCookies:s});return f}",
    "performProgressRequest({body:e,headers:t,method:n,onUploadProgress:r,resolvedUrl:i,signal:a,useSessionCookies:o}){let u=c.net.request({method:n,url:i,headers:t,useSessionCookies:o}),d=-1,f=()=>{let e=u.getUploadProgress();!e.started||e.current===d||(d=e.current,r({loaded:e.current,total:e.total}))}}",
    "cloneHeaders(e){return e}",
    "}",
  ].join("");
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.equal(applyAuthenticatedProxyPatch(source), source);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [
    "WARN: Found incomplete Linux proxy authentication helpers - skipping patch",
  ]);
});

test("routes current authenticated proxy desktop fetch shape through ClientRequest", async () => {
  const source = [
    "let c=require(`electron`);",
    "async function boot(){await c.app.whenReady()}",
    "class Fetcher{",
    "async performDesktopFetch(){let t={},r=`GET`,i=null,a=`https://chatgpt.com/wham/usage`,o={aborted:false,addEventListener(){},removeEventListener(){}},s=true,m=()=>null,h=async e=>{let n=this.cloneHeaders(t);let f=i==null?await c.net.fetch(a,{method:r,headers:n,body:m(),signal:o,credentials:s?`include`:`same-origin`}):await this.performProgressRequest({body:m(),headers:n,method:r,onUploadProgress:i,resolvedUrl:a,signal:o,useSessionCookies:s});return f};return h({})}",
    "performProgressRequest({body:e,headers:t,method:n,onUploadProgress:r,resolvedUrl:i,signal:a,useSessionCookies:o}){return new Promise((s,l)=>{let u=c.net.request({method:n,url:i,headers:t,useSessionCookies:o}),d=-1,f=()=>{let e=u.getUploadProgress();!e.started||e.current===d||(d=e.current,r({loaded:e.current,total:e.total}))},p=setInterval(f,50),m=()=>{clearInterval(p)},h=()=>{m(),a.removeEventListener(`abort`,g)},g=()=>{h(),u.abort(),l(new DOMException(`The operation was aborted`,`AbortError`))};if(a.addEventListener(`abort`,g,{once:!0}),a.aborted){g();return}u.on(`error`,e=>{h(),l(e)}),u.on(`response`,e=>{f(),m();let t=[];e.on(`data`,e=>{t.push(e)}),e.on(`error`,e=>{h(),l(e)}),e.on(`end`,()=>{h();let n=Buffer.concat(t),r=new Headers;for(let[t,n]of Object.entries(e.headers))for(let e of Array.isArray(n)?n:[n])r.append(t,e);s(new Response(n.length===0?null:n,{status:e.statusCode,statusText:e.statusMessage,headers:r}))})});let _=e instanceof ArrayBuffer?Buffer.from(e):e;u.end(_)})}",
    "cloneHeaders(e){return e}",
    "}",
    "globalThis.Fetcher=Fetcher;",
  ].join("");
  const patched = applyPatchTwiceWithoutWarnings(applyAuthenticatedProxyPatch, source);

  assert.match(patched, /i==null&&!codexLinuxProxyAuthEntry\(\)\?await c\.net\.fetch/);
  assert.match(
    patched,
    /codexLinuxAttachProxyAuthToRequest\(u\);let d=-1,f=\(\)=>\{if\(r==null\)return;/,
  );

  let fetchCalls = 0;
  const context = {
    Response,
    globalThis: {},
    process: { platform: "linux", env: {} },
    require(name) {
      assert.equal(name, "electron");
      return {
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
      };
    },
  };
  await vm.runInNewContext(`${patched};boot()`, context);
  const response = await vm.runInNewContext(
    "new globalThis.Fetcher().performDesktopFetch()",
    context,
  );

  assert.equal(fetchCalls, 1);
  assert.equal(await response.text(), "fetch");

  let requestCalls = 0;
  let credentials = null;
  const authContext = {
    ArrayBuffer,
    Buffer,
    DOMException,
    Headers,
    Response,
    clearInterval,
    globalThis: {},
    process: {
      platform: "linux",
      env: {
        CODEX_LINUX_PROXY_AUTH_HOST: "proxy.example",
        CODEX_LINUX_PROXY_AUTH_PORT: "8080",
        CODEX_LINUX_PROXY_USERNAME: "user",
        CODEX_LINUX_PROXY_PASSWORD: "p@ss",
      },
    },
    require(name) {
      assert.equal(name, "electron");
      return {
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
      };
    },
    setInterval,
  };
  await vm.runInNewContext(`${patched};boot()`, authContext);
  const authenticatedResponse = await vm.runInNewContext(
    "new globalThis.Fetcher().performDesktopFetch()",
    authContext,
  );

  assert.equal(requestCalls, 1);
  assert.equal(authenticatedResponse.status, 200);
  assert.equal(await authenticatedResponse.text(), "request");
  assert.deepEqual(credentials, { username: "user", password: "p@ss" });
});

test("authenticated-proxy tests fail when current desktop fetch shape drifts", () => {
  const source = [
    "let a=require(`electron`);",
    "async function boot(){await a.app.whenReady()}",
    "class Fetcher{",
    "async performDesktopFetch(){let d=await a.net.fetch(`https://example.test`,{})}",
    "performProgressRequest(){let u=a.net.request({url:`https://example.test`})}",
    "}",
  ].join("");

  assert.throws(
    () => applyPatchTwiceWithoutWarnings(applyAuthenticatedProxyPatch, source),
    /Could not route Linux proxy-auth desktop fetches through ClientRequest|Expected values to be strictly deep-equal/,
  );
});
