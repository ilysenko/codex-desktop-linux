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
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features");

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
  const safeStorage = {
    isEncryptionAvailable: () => options.encryption !== false,
    getSelectedStorageBackend: () => options.backend ?? "kwallet6",
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
  const electron = { safeStorage, dialog, shell: { openExternal: async url => calls.push(url) }, Menu: {
    buildFromTemplate: template => ({ popup: ({ callback }) => {
      menus.push(template);
      const selectable = template.filter(item => item.value !== undefined && item.enabled !== false);
      const selected = selectable[choices.shift()];
      if (selected) selected.click();
      callback();
    } }),
  }};
  const runtime = createAccountSwitcher({ electron, clients: () => [client], home, reload: () => { reloaded++; } });
  return {
    home, authPath, vault, safeStorage, dialogs, menus, choices, calls, runtime, client,
    open: async response => { choices.push(response); await runtime.open(client); },
    seedSecond: () => {
      const stored = JSON.parse(fs.readFileSync(vault));
      const text = credentials("second");
      const id = crypto.createHash("sha256").update(JSON.stringify(["user-second", "account-second"])).digest("hex");
      stored.accounts.push({ id, encrypted: safeStorage.encryptString(text).toString("base64") });
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

for (const options of [{ encryption: false }, { backend: "basic_text" }]) {
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

test("semantic contracts preserve renamed symbols, reject partial drift, and route the Polish menu action", () => {
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
