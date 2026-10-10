"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawn, execFileSync } = require("node:child_process");
const { createAccountSwitcher } = require("./runtime");
const { applyMain, applyUi } = require("./patch");
const { loadLinuxFeaturePatchDescriptors, enabledLinuxFeaturePackagePlan } = require("../../scripts/lib/linux-features");

function credentials(name) {
  const token = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  return JSON.stringify({ auth_mode: "chatgpt", tokens: {
    id_token: token({ sub: `user-${name}`, email: `${name}@example.invalid`, "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } }),
    access_token: token({ "https://api.openai.com/auth": { chatgpt_account_id: `account-${name}`, chatgpt_user_id: `user-${name}` } }),
    refresh_token: `private-refresh-${name}`, account_id: `account-${name}`,
  }});
}

function fixture(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const authPath = path.join(home, "auth.json");
  const vault = path.join(home, ".community-account-switcher/accounts.json");
  fs.writeFileSync(authPath, credentials("first"), { mode: 0o600 });
  const key = crypto.randomBytes(32);
  const cipher = {
    encryptString: text => {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([cipher.update(text), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString: buffer => {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(0, 12));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString();
    },
  };
  const dialogs = [], menus = [], choices = [], calls = [];
  let reloaded = 0, notification, active = "first", restartFails = false;
  let ready = options.lazyConnection !== true;
  const dialog = { showMessageBox: async settings => {
    dialogs.push(settings);
    if (settings.signal) {
      if (options.login) {
        const name = options.login;
        fs.writeFileSync(authPath, credentials(name)); active = name;
        notification({ method: "account/login/completed", params: { loginId: "login-1", success: true } });
        return new Promise(resolve => settings.signal.addEventListener("abort", () => resolve({ response: 0 }), { once: true }));
      }
      return { response: 0 };
    }
    return { response: choices.shift() ?? settings.cancelId ?? 0 };
  }};
  const client = {
    hostConfig: { id: "local", kind: "local" },
    ensureReady: async () => { ready = true; calls.push("ensureReady"); },
    getPendingRequestCount: () => options.pending ?? 0,
    getAuthenticatedPrincipal: async () => ({ accountId: `account-${active}`, userId: `user-${active}` }),
    clearAuthTokenCache: () => calls.push("clearCache"),
    restart: async () => {
      calls.push("restart");
      const name = JSON.parse(fs.readFileSync(authPath)).tokens.account_id.slice(8);
      if (restartFails && name === "second") throw new Error("secret upstream error");
      active = name;
    },
    registerInternalNotificationHandler: callback => { notification = callback; return () => { notification = undefined; }; },
    sendInternalRequest: async request => {
      if (!ready) throw new Error("Codex app-server is not available");
      calls.push(request.method);
      if (options.rpcFails) return { error: { message: "upstream-secret" } };
      switch (request.method) {
        case "thread/loaded/list": return { result: { data: options.activeTask ? ["working"] : [], nextCursor: null } };
        case "thread/read": return { result: { thread: { status: { type: "active" } } } };
        case "account/read": return { result: { account: { type: "chatgpt" } } };
        case "account/login/start": return { result: { type: "chatgpt", loginId: "login-1", authUrl: options.authUrl ?? "https://auth.openai.com/oauth/authorize?test=1" } };
        case "account/login/cancel": return { result: {} };
        default: throw new Error(`unexpected request: ${request.method}`);
      }
    },
  };
  client.sendAppServerRequest = async (method, params) => {
    await client.ensureReady();
    const response = await client.sendInternalRequest({ method, params });
    if (response.error) throw new Error("sensitive upstream error");
    return response.result;
  };
  const electron = { get safeStorage() { throw new Error("No such binding was linked: electron_browser_safe_storage"); }, dialog, shell: { openExternal: async url => calls.push(url) }, Menu: {
    buildFromTemplate: template => ({ popup: ({ callback }) => {
      menus.push(template);
      const selectable = template.filter(item => item.value !== undefined && item.enabled !== false);
      const selected = selectable[choices.shift()];
      if (selected) selected.click();
      callback();
    } }),
  }};
  const keyringCalls = [];
  let savedKey = options.keyInitiallyMissing ? null : key.toString("hex");
  const runSecretTool = async (args, input) => {
    keyringCalls.push({ args, input });
    if (options.missingExecutable) { const e = new Error("sensitive test error"); e.code = "ENOENT"; throw e; }
    if (options.keyringUnavailable) return { code: 2, stdout: "" };
    if (args[0] === "store") {
      if (options.storeFails) return { code: 1, stdout: "" };
      if (!options.keyRetainFails) savedKey = input;
      return { code: 0, stdout: "" };
    }
    return { code: savedKey ? 0 : 1, stdout: options.malformedKey ? "invalid" : savedKey ?? "" };
  };
  const clients = [client];
  const runtime = createAccountSwitcher({ electron, clients: () => clients, home, reload: () => { reloaded++; }, runSecretTool });
  return {
    home, authPath, vault, cipher, keyringCalls, dialogs, menus, choices, calls, runtime, client, clients,
    open: async response => { choices.push(response); await runtime.open(client); },
    seedSecond: () => {
      const stored = JSON.parse(fs.readFileSync(vault));
      const text = credentials("second");
      const id = crypto.createHash("sha256").update(JSON.stringify(["user-second", "account-second"])).digest("hex");
      stored.accounts.push({ id, encrypted: cipher.encryptString(text).toString("base64") });
      fs.writeFileSync(vault, JSON.stringify(stored));
    },
    failSecondRestart: () => { restartFails = true; },
    reloaded: () => reloaded,
  };
}

test("feature is opt-in, has both contracts and rejects a shared server", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, "features.json");
  const options = { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config };
  fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
  assert.deepEqual(loadLinuxFeaturePatchDescriptors(options), []);
  fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
  assert.equal(loadLinuxFeaturePatchDescriptors(options).length, 2);
  fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher", "shared-app-server-socket"] }));
  assert.throws(() => loadLinuxFeaturePatchDescriptors(options), /conflict/);
});

for (const options of [{ keyringUnavailable: true }, { keyInitiallyMissing: true, storeFails: true }]) {
  test(`rejects unsafe encryption ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await f.open(1);
    assert.equal(fs.existsSync(f.vault), false);
    assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
    assert.equal(f.reloaded(), 0);
    assert.match(f.dialogs.at(-1).detail, /keyring/);
  });
}

test("cancel stores only encrypted tokens, with private permissions", async t => {
  const f = fixture(t);
  await f.open(3);
  assert.equal(f.reloaded(), 0);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
  const stored = fs.readFileSync(f.vault, "utf8");
  assert.ok(!stored.includes("private-refresh-first"));
  assert.ok(!stored.includes("access_token"));
  assert.equal(fs.statSync(f.vault).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.vault)).mode & 0o777, 0o700);
});

test("creates and verifies a profile-specific Secret Service key without putting it in argv", async t => {
  const f = fixture(t, { keyInitiallyMissing: true });
  await f.open(3);
  assert.equal(f.dialogs.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.vault)).version, 2);
  assert.deepEqual(f.keyringCalls.map(call => call.args[0]), ["lookup", "store", "lookup"]);
  const stored = f.keyringCalls[1];
  assert.match(stored.input, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(stored.args).includes(stored.input));
  assert.ok(!JSON.stringify(f.keyringCalls).includes("private-refresh-first"));
  assert.equal(stored.args.at(-1), crypto.createHash("sha256").update(fs.realpathSync(f.home)).digest("hex"));
});

for (const options of [{ malformedKey: true }, { keyInitiallyMissing: true, keyRetainFails: true }]) {
  test(`keyring failure leaves credentials unchanged ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await f.open(3);
    assert.equal(fs.existsSync(f.vault), false);
    assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
    assert.equal(f.menus.length, 0);
    assert.match(f.dialogs.at(-1).detail, /key/);
  });
}

test("missing key never replaces an existing vault; corrupted ciphertext is rejected", async t => {
  const f = fixture(t, { keyInitiallyMissing: true });
  fs.mkdirSync(path.dirname(f.vault), { mode: 0o700 });
  fs.writeFileSync(f.vault, '{"version":2,"accounts":[]}', { mode: 0o600 });
  await f.open(3);
  assert.deepEqual(f.keyringCalls.map(call => call.args[0]), ["lookup"]);
  assert.match(f.dialogs.at(-1).detail, /key is unavailable/);
  const g = fixture(t);
  await g.open(3);
  const saved = JSON.parse(fs.readFileSync(g.vault));
  const ciphertext = Buffer.from(saved.accounts[0].encrypted, "base64");
  ciphertext[15] ^= 1;
  saved.accounts[0].encrypted = ciphertext.toString("base64");
  const corrupted = JSON.stringify(saved);
  fs.writeFileSync(g.vault, corrupted);
  await g.open(3);
  assert.equal(fs.readFileSync(g.vault, "utf8"), corrupted);
  assert.match(g.dialogs.at(-1).detail, /could not be decrypted/);
});

test("missing secret-tool reports the dependency without touching login credentials", t => {
  const f = fixture(t);
  const program = `const {createAccountSwitcher}=require(${JSON.stringify(path.join(__dirname, "runtime.js"))});
    const dialogs=[];const runtime=createAccountSwitcher({home:process.argv[1],clients:()=>[],reload(){},
      electron:{dialog:{showMessageBox:async o=>dialogs.push(o.detail)},Menu:{},shell:{}}});
    runtime.open({}).then(()=>process.stdout.write(JSON.stringify(dialogs)));`;
  const result = execFileSync(process.execPath, ["-e", program, f.home], { env: { ...process.env, PATH: "" }, timeout: 5_000 });
  assert.match(JSON.parse(result)[0], /Install secret-tool/);
  assert.equal(fs.existsSync(f.vault), false);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
});

test("native package plans declare the Secret Service CLI dependency", t => {
  const f = fixture(t);
  const config = path.join(f.home, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
  for (const [format, dependency] of [["deb", "libsecret-tools"], ["rpm", "libsecret"], ["pacman", "libsecret"]]) {
    const plan = enabledLinuxFeaturePackagePlan({ packageFormat: format, featuresConfigPath: config });
    assert.ok(plan.dependencies.includes(dependency), format);
    assert.equal(plan.resources.length, 0);
  }
  assert.throws(() => require("../../scripts/lib/gentoo-feature-support").gentooFeaturePlan({ featuresConfigPath: config }),
    /Gentoo does not support.*account-switcher/);
});

test("switches to a saved account and restores refreshed current credentials later", async t => {
  const f = fixture(t);
  await f.open(3); f.seedSecond();
  const refreshed = credentials("first").replace("private-refresh-first", "refreshed-private-first");
  fs.writeFileSync(f.authPath, refreshed);
  await f.open(1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("second"));
  assert.equal(f.reloaded(), 1);
  await f.open(0);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), refreshed);
  assert.equal(f.reloaded(), 2);
});

test("failed selected-account restart rolls back without exposing upstream errors", async t => {
  const f = fixture(t);
  await f.open(3); f.seedSecond(); f.failSecondRestart();
  await f.open(1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
  assert.equal(f.reloaded(), 0);
  assert.equal(f.calls.filter(c => c === "restart").length, 2);
  assert.match(f.dialogs.at(-1).detail, /previous account was restored/);
  assert.ok(!f.dialogs.at(-1).detail.includes("secret"));
});

for (const options of [{ activeTask: true }, { pending: 1 }, { rpcFails: true }]) {
  test(`busy or unverifiable backend refuses switching ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await f.open(3); f.seedSecond();
    await f.open(1);
    assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
    assert.equal(f.calls.includes("restart"), false);
    assert.equal(f.reloaded(), 0);
    assert.equal(f.dialogs.at(-1).type, "error");
  });
}

test("cancelled browser login returns to the remembered account", async t => {
  const f = fixture(t);
  await f.open(1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
  assert.ok(f.calls.includes("account/login/cancel"));
  assert.equal(f.reloaded(), 0);
});

test("successful official login remembers the new account without logging out the old one", async t => {
  const f = fixture(t, { login: "second" });
  await f.open(1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("second"));
  assert.equal(JSON.parse(fs.readFileSync(f.vault)).accounts.length, 2);
  assert.equal(f.reloaded(), 1);
  assert.ok(!f.calls.includes("account/logout"));
});

test("adding an account initializes a lazy backend before checking tasks and starting OAuth", async t => {
  const f = fixture(t, { lazyConnection: true });
  await f.open(1);
  assert.equal(f.dialogs.filter(dialog => dialog.type === "error").length, 0);
  assert.ok(f.calls.includes("account/login/start"));
  assert.ok(f.calls.includes("account/login/cancel"));
  assert.ok(f.calls.indexOf("ensureReady") < f.calls.indexOf("thread/loaded/list"));
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
});

for (const action of ["add", "switch"]) {
  for (const pending of [0, 1]) {
    test(`cloud work in other apps does not gate ${action}; own pending requests=${pending}`, async t => {
      const f = fixture(t);
      const reads = [];
      f.clients.push({
        hostConfig: { id: "durable", kind: "local" }, getPendingRequestCount: () => pending,
        sendAppServerRequest: async method => {
          reads.push(method);
          // A catalog would contain a permanently active task from another
          // profile. Even an unavailable cloud catalog must not gate login.
          if (method === "thread/list") return { data: [{ status: { type: "active" } }], nextCursor: null };
          throw new Error("gateway unavailable; sensitive upstream response");
        },
      });
      if (action === "switch") { await f.open(3); f.seedSecond(); }
      await f.open(1);
      assert.deepEqual(reads, [], "do not query or cancel independent cloud work");
      if (pending === 0) {
        assert.equal(f.dialogs.filter(dialog => dialog.type === "error").length, 0);
        if (action === "add") assert.ok(f.calls.includes("account/login/start"));
        else assert.equal(f.reloaded(), 1);
      } else {
        assert.equal(f.calls.includes("account/login/start"), false);
        assert.equal(f.calls.includes("restart"), false);
        assert.equal(f.reloaded(), 0);
        assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
        assert.match(f.dialogs.at(-1).detail, /pending requests/);
      }
    });
  }
}

test("login setup errors name the phase without exposing upstream error details", async t => {
  const f = fixture(t);
  f.client.registerInternalNotificationHandler = () => { throw new Error("private-error-token"); };
  await f.open(1);
  const detail = f.dialogs.at(-1).detail;
  assert.match(detail, /subscribing to login completion/);
  assert.ok(!detail.includes("private-error-token"));
  assert.ok(!f.calls.includes("account/login/start"));
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
});

test("refuses an unexpected OAuth destination and restores current login", async t => {
  const f = fixture(t, { authUrl: "https://example.invalid/steal" });
  await f.open(1);
  assert.ok(!f.calls.some(c => c.startsWith("https://")));
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
});

test("forget only removes saved credentials and cannot remove the active account", async t => {
  const f = fixture(t);
  await f.open(3); f.seedSecond(); f.choices.push(3, 0);
  await f.runtime.open(f.client);
  assert.equal(JSON.parse(fs.readFileSync(f.vault)).accounts.length, 1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("first"));
  assert.equal(f.calls.includes("restart"), false);
});

test("does not follow credential symlinks or overwrite corrupt vaults", async t => {
  const f = fixture(t);
  await f.open(3);
  fs.writeFileSync(f.vault, "corrupt");
  await f.open(1);
  assert.equal(fs.readFileSync(f.vault, "utf8"), "corrupt");
  fs.rmSync(f.authPath);
  const target = path.join(f.home, "untouched.json");
  fs.writeFileSync(target, credentials("first"), { mode: 0o600 });
  fs.symlinkSync(target, f.authPath);
  fs.rmSync(f.vault);
  await f.open(1);
  assert.equal(fs.existsSync(f.vault), false);
  assert.equal(fs.readFileSync(target, "utf8"), credentials("first"));
});

test("refuses mismatched active authority rather than saving a stale login", async t => {
  const f = fixture(t);
  f.client.getAuthenticatedPrincipal = async () => ({ accountId: "different", userId: "different" });
  await f.open(1);
  assert.equal(fs.existsSync(f.vault), false);
  assert.match(f.dialogs.at(-1).detail, /does not match/);
});

test("identity uses the current desktop user_id authority ahead of chatgpt_user_id", async t => {
  const f = fixture(t);
  const auth = JSON.parse(credentials("first"));
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "account-first", user_id: "canonical-user", chatgpt_user_id: "legacy-user" } };
  auth.tokens.access_token = `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  fs.writeFileSync(f.authPath, JSON.stringify(auth));
  f.client.getAuthenticatedPrincipal = async () => ({ accountId: "account-first", userId: "canonical-user" });
  await f.open(3);
  assert.equal(JSON.parse(fs.readFileSync(f.vault)).accounts.length, 1);
  assert.equal(f.dialogs.length, 0);
});

test("semantic contracts preserve renamed symbols, reject partial drift, and route the Polish menu action", async () => {
  const main = 'async function handle(view,message){switch(message.type){case`mcp-request`:{log().debug(`app_server.bridge_received`,{safe:{messageType:`mcp-request`,requestId:String(message.request.id),method:message.request.method,originWebcontentsId:view.id,originHostId:message.hostId}});this.sendAppServerResponseToView();this.appServerConnectionRegistry.getAllHostIds();break}}}async function config(options){return[...helpers.computeConfig(options.globalState,options.hostConfig),...await options.secretAuthStorageConfigOverrides,...await extras(options),mode(options)]}';
  const ui = 'function Profile(props){let memo=(0,Cache.c)(275),{sidebarFooter:footer,ambientUsage:usage,hideUsage:hidden,open:opened,onClose:close}=props,disabled=hidden!==void 0,scope=read(atom);let fmt=intl();fmt.formatMessage({id:`codex.profileDropdown.copyUserIdForEmail`});let label=`codex.profileDropdown.settingsPage`;let settings=(0,UI.jsx)(Item,{leftIconAsset:asset,keyboardShortcut:shortcut,onClick:settingsClick,children:label});let alternate=(0,UI.jsx)(Layout,{accountIcon:icon,accountSwitcher:switcher,additionalItems:items,onCloseMenu:close});Bridge.dispatchMessage(`avatar-overlay-open`,{});return(0,UI.jsxs)(`div`,{children:[identity,divider,settings,null,workspace,analytics,null,null,more]})}';
  for (const [source, apply, drift] of [[main, applyMain, "secretAuthStorageConfigOverrides"], [ui, applyUi, "accountSwitcher"]]) {
    const patched = apply(source);
    assert.notEqual(patched, source);
    new vm.Script(patched);
    assert.equal(apply(patched), patched);
    assert.equal(apply(source + source), source + source);
    assert.equal(apply(source.replace(drift, "retired")), source.replace(drift, "retired"));
  }
  const patched = applyUi(ui);
  const config = vm.runInNewContext(applyMain(main) + ";config", {
    helpers: { computeConfig: () => ["base"] }, extras: async () => ["extras"], mode: () => "mode",
  });
  for (const id of ["local", "ssh-test", "durable"]) {
    const overrides = await config({ hostConfig: { id }, globalState: {}, secretAuthStorageConfigOverrides: ["policy"] });
    assert.deepEqual(Array.from(overrides), ["base", "policy", "extras", "mode",
      ...(id === "local" ? ['cli_auth_credentials_store="file"', "features.secret_auth_storage=false"] : [])]);
  }
  const rows = [...patched.matchAll(/\(0,UI\.jsx\)\(Item,\{onClick:\(\)=>\{close\(\);Bridge\.dispatchMessage[\s\S]*?`Switch account…`\}\)/g)];
  assert.equal(rows.length, 2);
  const sent = [];
  let closed = 0;
  for (const [row] of rows) {
    const rendered = vm.runInNewContext(row, { UI: { jsx: (_, props) => props }, Item: {}, close: () => closed++, Bridge: { dispatchMessage: (...args) => sent.push(args) }, fmt: { locale: "pl-PL" } });
    assert.equal(rendered.children, "Przełącz konto…");
    rendered.onClick();
  }
  assert.equal(closed, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0][0], "mcp-request");
  assert.equal(sent[0][1].hostId, "local");
  assert.equal(sent[0][1].request.method, "community/accountSwitcher");
  assert.equal(sent[0][1].request.params.locale, "pl-PL");
});

test("native account menu follows the app locale and marks the current account", async t => {
  const f = fixture(t);
  f.choices.push(3);
  await f.runtime.open(f.client, undefined, "pl-PL");
  assert.equal(f.menus[0][0].label, "Przełącz konto ChatGPT");
  assert.equal(f.menus[0].filter(item => item.checked).length, 1);
  assert.ok(f.menus[0].some(item => item.label === "Dodaj konto…"));
});

test("latest bundled CLI decodes the isolated OAuth file and supports the idle-check protocol", {
  skip: !process.env.CODEX_ACCOUNT_SWITCHER_CLI,
  timeout: 20_000,
}, async t => {
  const f = fixture(t);
  const env = { ...process.env, CODEX_HOME: f.home };
  // login status parses the synthetic file locally. A real server login cannot
  // be simulated: initialization discovers workspace routing on OpenAI's API.
  execFileSync(process.env.CODEX_ACCOUNT_SWITCHER_CLI, ["login", "status"], { env, stdio: "pipe", timeout: 5_000 });
  fs.rmSync(f.authPath);
  const child = spawn(process.env.CODEX_ACCOUNT_SWITCHER_CLI, ["app-server", "-c", 'cli_auth_credentials_store="file"', "-c", "features.secret_auth_storage=false"], {
    env, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill()); // Only this disposable test's child process.
  let buffer = "", id = 0;
  const pending = new Map();
  child.stdout.on("data", bytes => {
    buffer += bytes;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const response = pending.get(message.id);
      if (response) { pending.delete(message.id); response(message); }
    }
  });
  child.stderr.resume();
  const request = (method, params) => new Promise(resolve => {
    const requestId = ++id; pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  });
  const initialized = await request("initialize", { clientInfo: { name: "community_account_switcher_test", version: "1" }, capabilities: { experimentalApi: true } });
  assert.equal(initialized.error, undefined);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
  const loaded = await request("thread/loaded/list", { cursor: null, limit: 100 });
  assert.equal(loaded.error, undefined);
  assert.deepEqual(loaded.result.data, []);
  const account = await request("account/read", { refreshToken: false });
  assert.equal(account.error, undefined);
  assert.equal(account.result.account, null);
  // Generate and immediately cancel only this disposable server's OAuth flow.
  // Never launch a browser or send real account credentials in this test.
  const login = await request("account/login/start", { type: "chatgpt", appBrand: "chatgpt", useHostedLoginSuccessPage: true });
  assert.ok(!login.error, "The bundled server must accept the browser-login parameters");
  assert.equal(login.result.type, "chatgpt");
  assert.equal(new URL(login.result.authUrl).hostname, "auth.openai.com");
  const cancelled = await request("account/login/cancel", { loginId: login.result.loginId });
  assert.ok(!cancelled.error, "The disposable login flow must cancel successfully");
});

// Use exact current signed-bundle fixtures when supplied by local or CI validation.
const official = process.env.CODEX_ACCOUNT_SWITCHER_OFFICIAL_DIR;
test("official main and both profile layouts patch uniquely and remain valid JavaScript", { skip: !official }, () => {
  for (const [prefix, apply] of [["main-", applyMain], ["profile-dropdown-items-", applyUi]]) {
    const name = fs.readdirSync(official).find(file => file.startsWith(prefix) && file.endsWith(".js"));
    const source = fs.readFileSync(path.join(official, name), "utf8");
    const patched = apply(source);
    assert.notEqual(patched, source);
    assert.equal(apply(patched), patched);
    if (prefix === "main-") {
      new vm.Script(patched);
      assert.equal(patched.split("app.quit(").length, source.split("app.quit(").length);
      assert.equal(patched.split("app.relaunch(").length, source.split("app.relaunch(").length);
    } else {
      assert.equal(patched.match(/method:`community\/accountSwitcher`/g).length, 2);
    }
    for (const invalid of [source + source, source.replaceAll("mcp-request", "retired-request").replaceAll("accountSwitcher", "retiredSwitcher")]) {
      assert.equal(apply(invalid), invalid);
    }
  }
});

test("official Owl reaches OAuth and reopens an encrypted vault without querying independent cloud work", {
  skip: !process.env.CODEX_ACCOUNT_SWITCHER_NATIVE_APP || !process.env.CODEX_ACCOUNT_SWITCHER_ASAR_CLI,
  timeout: 30_000,
}, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "account-native-"));
  const app = process.env.CODEX_ACCOUNT_SWITCHER_NATIVE_APP;
  const home = path.join(dir, "home"), profile = path.join(dir, "profile");
  const probe = path.join(dir, "app"), source = path.join(dir, "source");
  fs.mkdirSync(path.join(probe, "resources"), { recursive: true });
  fs.mkdirSync(source);
  t.after(() => {
    if (fs.existsSync(home)) {
      const id = crypto.createHash("sha256").update(fs.realpathSync(home)).digest("hex");
      try { execFileSync("secret-tool", ["clear", "application", "codex-desktop", "feature", "account-switcher", "profile", id], { stdio: "ignore", timeout: 5_000 }); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.copyFileSync(path.join(app, "ChatGPT"), path.join(probe, "ChatGPT"));
  fs.chmodSync(path.join(probe, "ChatGPT"), 0o755);
  for (const name of fs.readdirSync(app)) {
    if (["ChatGPT", "resources", "start.sh", ".codex-linux"].includes(name)) continue;
    fs.symlinkSync(path.join(app, name), path.join(probe, name));
  }
  for (const name of ["owl-app.ini", "owl-electron-app.json"]) fs.copyFileSync(path.join(app, "resources", name), path.join(probe, "resources", name));
  fs.copyFileSync(path.join(__dirname, "native-probe.js"), path.join(source, "probe.js"));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "account-native-probe", version: "1.0.0", main: "probe.js" }));
  execFileSync(process.execPath, [process.env.CODEX_ACCOUNT_SWITCHER_ASAR_CLI, "pack", source, path.join(probe, "resources/app.asar")], { stdio: "pipe", timeout: 5_000 });
  const result = path.join(dir, "result.json");
  execFileSync(path.join(probe, "ChatGPT"), [`--user-data-dir=${profile}`], {
    env: { ...process.env, TMPDIR: process.env.XDG_RUNTIME_DIR || "/tmp", CODEX_HOME: home, CODEX_ELECTRON_USER_DATA_PATH: profile,
      ACCOUNT_SWITCHER_PROBE_RUNTIME: process.env.CODEX_ACCOUNT_SWITCHER_PROBE_RUNTIME || path.join(__dirname, "runtime.js"), ACCOUNT_SWITCHER_PROBE_RESULT: result,
      ACCOUNT_SWITCHER_PROBE_NATIVE_APP: app },
    stdio: "pipe", timeout: 20_000,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(result)), { menus: 3, encryptedVault: true, errors: [], openedLogin: 1, readyChecks: 4, cloudUntouched: true });
});
