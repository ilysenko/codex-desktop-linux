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
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");
const { inspectMainLocalConfigSite } = require("../../scripts/patches/lib/main-local-config-sites.js");
const { localConfigGraph, localConfigFixture } = require("../../scripts/patches/lib/fixtures/main-local-config-graph.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

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
  const runtime = createAccountSwitcher({ electron, clients: () => clients, home, reload: () => { reloaded++; return options.reload?.(); }, runSecretTool });
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

// rspack/SWC webview chunk: module factories keyed by hashed ids, imports as
// module-scope `var x=n("id")` bindings, double-quoted strings. The sidebar
// branch reuses the menu-item module alias for the pet callback.
const UI_MODULE = 'Ab12(e,t,n){n.d(t,{Profile:()=>Profile});var UI=n("jsx"),Menu=n("menu"),Bus=n("bus"),Text=n("text");' +
  'function Profile(props){let label,settings,group,{sidebarFooter:footer,onClose:close}=props,fmt=intl();' +
  'fmt.formatMessage({id:"codex.profileDropdown.copyUserIdForEmail",defaultMessage:"Copy user ID for {email}"},{email:"a"});' +
  'label=(0,UI.jsx)(Text.A,{id:"codex.profileDropdown.settingsPage",defaultMessage:"Settings",description:"Menu item to open Codex settings page"});' +
  'settings=(0,UI.jsx)(Menu.tJ,{leftIconAsset:asset.T,keyboardShortcut:shortcut,onClick:settingsClick,children:label});' +
  'group=(0,UI.jsxs)(UI.Fragment,{children:[divider,identity,null,settings]});' +
  'if(null!=footer){let Menu=petEnabled?()=>{close(),Bus.O1.dispatchMessage("avatar-overlay-open",{})}:void 0;' +
  'return(0,UI.jsx)(Layout,{accountIcon:icon,accountSwitcher:switcher,additionalItems:items,onCloseMenu:close,onTogglePet:Menu})}' +
  'return(0,UI.jsxs)("div",{children:[group,workspace,analytics,more]})}}';
const UI_CHUNK = `export const __rspack_esm_id=1;export const __rspack_esm_ids=[1];export const __webpack_modules__={Zz99(e,t,n){n.d(t,{other:()=>1})},${UI_MODULE}};`;

test("profile complete-state validation rejects wrong bridge methods, helper scope and callback bindings", t => {
  const warnings = [];
  t.mock.method(console, "warn", message => warnings.push(message));
  const patched = applyUi(UI_CHUNK);
  assert.notEqual(patched, UI_CHUNK);
  const marker = "/*codexLinuxAccountSwitcherUi*/";
  const start = patched.indexOf(marker);
  const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
  const items = patched.indexOf("function codexLinuxAccountSwitcherItems(", start);
  const end = findMatchingBrace(patched, patched.indexOf("{", items)) + 1;
  const helpers = patched.slice(start, end), rest = patched.slice(0, start) + patched.slice(end);
  const damaged = [
    patched.replace('method:"community/accountSwitcher"', 'method:"community/wrongAccountSwitcher"'),
    patched.replace('hostId:"local"', 'hostId:"remote"'),
    patched.replace('params:{locale:intl.locale}', 'params:{locale:wrong.locale}'),
    patched.replace('close();Bus.O1', 'wrongClose();Bus.O1'),
    patched.replace('additionalItems:codexLinuxAccountSwitcherItems(items,close,fmt)', 'additionalItems:codexLinuxAccountSwitcherItems(items,wrongClose,fmt)'),
    patched.replace('codexLinuxAccountSwitcherRow(close,fmt)]', 'codexLinuxAccountSwitcherRow(close,wrongIntl)]'),
    patched.replace('var UI=n("jsx")', 'var UI=wrongLoader("jsx")'),
    rest.replace('var UI=', `function inaccessible(){${helpers}}var UI=`),
    rest + helpers,
    patched.replace(marker, ""),
    patched + ';codexLinuxAccountSwitcherRow(close,fmt);',
    UI_CHUNK + '/*codexLinuxAccountSwitcherUi*/',
  ];
  for (const source of damaged) {
    warnings.length = 0;
    assert.doesNotThrow(() => new vm.Script(source.replace(/export const /g, "var ")));
    assert.equal(applyUi(source), source);
    assert.equal(warnings.length, 1);
  }
  const extra = patched + ';const codexLinuxAccountSwitcherRowColor="kept";';
  warnings.length = 0;
  assert.equal(applyUi(extra), extra);
  assert.deepEqual(warnings, []);

  // The corrupted canonical-looking helper actually dispatches the wrong RPC.
  const wrong = damaged[0];
  const rowStart = wrong.indexOf("function codexLinuxAccountSwitcherRow(");
  const rowEnd = findMatchingBrace(wrong, wrong.indexOf("{", rowStart));
  const sent = [];
  const row = vm.runInNewContext(`(${wrong.slice(rowStart, rowEnd + 1)})`, {
    UI: { jsx: (type, props) => ({ type, props }) }, Menu: { tJ: "menu" },
    Bus: { O1: { dispatchMessage: (...args) => sent.push(args) } },
  })(() => {}, { locale: "en" });
  row.props.onClick();
  assert.equal(sent[0][1].request.method, "community/wrongAccountSwitcher");
});

function profileWorkspace(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-module-copies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

function runProfileDescriptor(root) {
  const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
  const { createPatchReport } = require("../../scripts/lib/patch-report.js");
  const descriptors = require("./patch.js").descriptors.filter(({ id }) => id === "account-switcher-profile-menu");
  const report = createPatchReport();
  applyExtractedAppPatchDescriptors(root, descriptors, {}, report, descriptors[0].phase);
  return report.patches[0];
}

test("normal profile descriptor updates all same-ID copies and refuses damaged or mixed replicas", t => {
  t.mock.method(console, "warn", () => {});
  const root = profileWorkspace(t, { "async/one.js": UI_CHUNK, "nested/two.js": UI_CHUNK });
  assert.equal(runProfileDescriptor(root).status, "applied");
  assert.equal(runProfileDescriptor(root).status, "already-applied");
  for (const bad of [
    applyUi(UI_CHUNK),
    applyUi(UI_CHUNK).replace('method:"community/accountSwitcher"', 'method:"community/wrongAccountSwitcher"'),
    UI_CHUNK.replace('codex.profileDropdown.settingsPage', 'missing-setting-anchor'),
    UI_CHUNK.replace('Ab12(e,t,n)', 'OtherProfile(e,t,n)'),
  ]) {
    const one = path.join(root, "webview/assets/async/one.js"), two = path.join(root, "webview/assets/nested/two.js");
    fs.writeFileSync(one, UI_CHUNK);fs.writeFileSync(two, bad);
    assert.equal(runProfileDescriptor(root).status, "skipped-optional");
    assert.equal(fs.readFileSync(one, "utf8"), UI_CHUNK);
    assert.equal(fs.readFileSync(two, "utf8"), bad);
  }
});

test("profile replica writes restore original bytes and stop when rollback cannot be verified", t => {
  t.mock.method(console, "warn", () => {});
  for (const breakRollback of [false, true]) {
    const root = profileWorkspace(t, { "async/one.js": UI_CHUNK, "nested/two.js": UI_CHUNK });
    const originalWrite = fs.writeFileSync;let calls = 0;
    const mock = t.mock.method(fs, "writeFileSync", (...args) => {
      calls++;
      if (calls === 2) { originalWrite(args[0], "partial");throw Error("second profile write"); }
      if (breakRollback && calls === 3) throw Error("rollback profile write");
      return originalWrite(...args);
    });
    try {
      if (breakRollback) assert.throws(() => runProfileDescriptor(root), { code: "PATCH_INTEGRITY_FAILURE" });
      else assert.equal(runProfileDescriptor(root).status, "skipped-optional");
    } finally { mock.mock.restore(); }
    assert.equal(fs.readFileSync(path.join(root, "webview/assets/async/one.js"), "utf8"), UI_CHUNK);
    assert.equal(fs.readFileSync(path.join(root, "webview/assets/nested/two.js"), "utf8"), breakRollback ? "partial" : UI_CHUNK);
  }
});

// Loads the fixture chunk like the rspack runtime: run the module factory with
// a require function resolving its import bindings.
function loadProfile(source, context, imports) {
  const sandbox = { ...context };
  vm.runInNewContext(source.replace(/export const /g, "var "), sandbox);
  const exports = {};
  const load = id => imports[id];
  load.d = (target, getters) => {
    for (const [key, getter] of Object.entries(getters)) Object.defineProperty(target, key, { get: getter });
  };
  sandbox.__webpack_modules__.Ab12({}, exports, load);
  return exports.Profile;
}

const NATIVE_MCP_CASE = "case\"mcp-request\":{ze().debug(\"app_server.bridge_received\",{safe:{messageType:\"mcp-request\",requestId:String(t.request.id),method:t.request.method,originWebcontentsId:e.id,originHostId:t.hostId},sensitive:{}});let r=t.request;if((0,ei.ZJQ)(t.hostId)){let n=Ew.send(t.request);if(\"response\"===n.type){this.sendAppServerResponseToView(e,t.hostId,t.request.method,n.response,t.request.trace,t.priority);break}r=n.request}try{let n=()=>this.getAppServerConnection(t.hostId).handleClientRequest(new QR(e,this.chunkedMessageSender),r,{coalesce:t.coalesce,priority:t.priority,source:t.source,timeoutMs:t.timeoutMs,expiresAtMs:t.expiresAtMs,widget:t.widget},t.retainResponse,t.savedEnvironmentConfig,t.threadAccess,t.environmentDraftReplacement,t.persistentSideConversation,t.executorAccess);null==r.trace?await n():await (0,ei.f5g)({attributes:{\"app_server.method\":r.method},name:\"electron.ipc_request_delivery\",op:\"codex.app_server.ipc_request_delivery\",startTimeMs:t.dispatchedAtMs,trace:r.trace},n)}catch(r){if(t.retainResponse){this.sendMessageToView(e,{type:\"mcp-request-delivery\",hostId:t.hostId,update:{type:\"failed\",delivery:{requestId:t.request.id,method:t.request.method,stage:\"not-sent\"},message:r instanceof Error?r.message:\"Desktop app server request failed\"}});break}this.sendAppServerResponseToView(e,t.hostId,t.request.method,{id:t.request.id,error:{code:-32e3,message:r instanceof Error?r.message:\"Desktop app server request failed\"}},t.request.trace,t.priority)}break}";

function accountMainFixture() {
  const body = localConfigGraph()
    .replace('case"mcp-response":break;', 'case"mcp-response":break;' + NATIVE_MCP_CASE)
    .replace('this.options=e,this.scopedState=e.globalState', 'this.options=e,this.appState=e.appGlobalState,this.scopedState=e.globalState')
    .replace('this.seen=[]', 'let appViews=e.appViewsByWebContentsId;this.seen=[]');
  return localConfigFixture(body);
}
function quietMain(callback) {
  const original = console.warn, warnings = [];
  console.warn = (...values) => warnings.push(values.join(" "));
  try { return { value: callback(), warnings }; }
  finally { console.warn = original; }
}
function mainCallback(source) {
  const site = inspectMainLocalConfigSite(source); assert.equal(site.ok, true, site.reason);
  return { site, text: source.slice(site.overrides.start, site.overrides.end) };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function accountOwnedParts(source) {
  const graph = inspectMainRequestSites(source), config = mainCallback(source);
  assert.equal(graph.ok, true, graph.reason);
  const routeStart = source.indexOf("/*codexLinuxAccountSwitcherMain*/", graph.viewFetch.methodBodyStart);
  assert(routeStart >= graph.viewFetch.methodBodyStart && routeStart < graph.viewFetch.methodBodyEnd);
  const routeOpen = source.indexOf("{", routeStart), routeEnd = findMatchingBrace(source, routeOpen) + 1;
  const producer = ",this.messageHandler.codexLinuxAccountSwitcherMainCtx={windowManager:this.options.windowManager,getAppViews:()=>this.options.appViewsByWebContentsId}";
  const producerStart = source.indexOf(producer, graph.scope.hostStart); assert(producerStart < graph.scope.hostEnd && producerStart > graph.scope.hostStart);
  const suffixStart = config.site.overrides.nativePrefixEnd, suffixEnd = config.site.overrides.arrayEnd - 1;
  return { graph, config, routeStart, routeEnd, route: source.slice(routeStart, routeEnd), producer, producerStart,
    suffix: source.slice(suffixStart, suffixEnd), edits: [
      { start: routeStart, end: routeEnd }, { start: producerStart, end: producerStart + producer.length },
      { start: suffixStart, end: suffixEnd },
    ] };
}
function currentReload(source = applyMain(accountMainFixture())) {
  const start = source.indexOf("async function reloadCurrentAppViews("); assert(start > 0);
  const open = source.indexOf("{", start), end = findMatchingBrace(source, open) + 1;
  return vm.runInNewContext(`(${source.slice(start, end)})`);
}
function accountMainWorkspace(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-main-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite", "build"); fs.mkdirSync(build, { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(build, name), source);
  return { root, build, read: name => fs.readFileSync(path.join(build, name), "utf8") };
}
function normalAccountMain(root, context = {}) {
  const config = path.join(root, "features.json"); fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
  const all = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config });
  const descriptor = all.find(item => item.id.endsWith(":account-switcher-main")); assert(descriptor);
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  const report = createPatchReport(); report.enabledFeatures = ["account-switcher"];
  quietMain(() => applyExtractedAppPatchDescriptors(root, [descriptor], context, report, descriptor.phase));
  assert.equal(report.patches.length, 1); return { patch: report.patches[0], report };
}
function nineteenAccountChunks(source) {
  const files = { "early-bootstrap-45-aaaaaaaaaaaaaaaa.js": source };
  for (let index = 0; index < 18; index++) files[`early-bootstrap-${100 + index}-bbbbbbbbbbbbbbbb.js`] =
    `exports.ids=[${100 + index}],exports.modules={${90000 + index}(e,t,r){return false}};`;
  return files;
}

test("main account Adapter preserves three native ranges and binds live native context", () => {
  const original = accountMainFixture(), patched = applyMain(original), own = accountOwnedParts(patched);
  let recovered = patched;
  for (const edit of [...own.edits].sort((a, b) => b.start - a.start)) recovered = recovered.slice(0, edit.start) + recovered.slice(edit.end);
  assert.equal(recovered, original);
  const before = mainCallback(original);
  assert.equal(patched.slice(own.config.site.overrides.arrayStart + 1, own.config.site.overrides.nativePrefixEnd),
    original.slice(before.site.overrides.arrayStart + 1, before.site.overrides.nativePrefixEnd));
  const firstViews = new Map(), nextViews = new Map(), manager = {};
  const host = { options: { windowManager: manager, appViewsByWebContentsId: firstViews }, messageHandler: {} };
  const attach = vm.runInNewContext(`(function(){${own.producer.slice(1)};return this.messageHandler.codexLinuxAccountSwitcherMainCtx;})`);
  const context = attach.call(host); assert.equal(context.windowManager, manager); assert.equal(context.getAppViews(), firstViews);
  host.options.appViewsByWebContentsId = nextViews; assert.equal(context.getAppViews(), nextViews);
  const renamed = original.replace(/\be\b/gu, "viewInput").replace(/\bt\b/gu, "requestInput");
  assert.notEqual(quietMain(() => applyMain(renamed)).value, renamed);
  const opaque = original.replace("plugins.codex-app-tools@openai-bundled", "codexLinuxAccountSwitcherMain-opaque-source-data");
  assert.notEqual(quietMain(() => applyMain(opaque)).value, opaque);
});

test("main account community action uses actual local host fields and current registered sender", async () => {
  const own = accountOwnedParts(applyMain(accountMainFixture())), site = own.graph.viewFetch;
  for (const testCase of [
    { kind: "local", id: "local", allowed: true }, { kind: "local", id: "durable" },
    { kind: "local", id: "local", busy: true, method: "thread/read" },
    { kind: "ssh", id: "local" }, { kind: "ssh", id: "remote" }, { kind: "remote-control", id: "local" },
    { kind: "local", id: "local", covered: true }, { kind: "local", id: "local", unregistered: true },
    { kind: "local", id: "local", destroyed: true }, { kind: "local", id: "local", replaced: true },
  ]) {
    const origin = { id: 11, isDestroyed: () => Boolean(testCase.destroyed) }, trace = {}, window = {};
    const method = testCase.method ?? "community/accountSwitcher";
    const replies = [], opened = []; let lookups = 0;
    const client = { id: testCase.allowed ? "durable" : "local", hostConfig: { kind: testCase.kind, id: testCase.id } };
    const electron = { webContents: { fromId: () => testCase.replaced ? {} : origin }, BrowserWindow: { fromWebContents: () => window } };
    const receiver = {
      codexLinuxAccountSwitcherMainCtx: { windowManager: { hasRegisteredWebContents: () => !testCase.unregistered,
        accountWindows: { isCovered: () => Boolean(testCase.covered) } }, getAppViews: () => new Map() },
      codexLinuxAccountSwitcher: { isBusy: () => Boolean(testCase.busy), async open(...args) { opened.push(args); } },
      getAppServerConnection() { lookups++; return client; },
      sendAppServerResponseToView(...args) { replies.push(args); },
    };
    const run = vm.runInNewContext(`(async function(${site.webContentsVar},${site.requestVar}){switch(${site.requestVar}.type){case"mcp-request":{${own.route}}}})`, { require: name => { assert.equal(name, "electron"); return electron; } });
    await run.call(receiver, origin, { type: "mcp-request", hostId: testCase.id, priority: "high", request: { id: 42, method, trace, params: { locale: "zh-CN" } } });
    assert.equal(replies.length, 1); assert.equal(replies[0][0], origin); assert.equal(replies[0][1], testCase.id);
    assert.equal(replies[0][2], method); assert.equal(replies[0][3].id, 42);
    assert.equal(replies[0][4], trace); assert.equal(replies[0][5], "high");
    assert.equal(opened.length, testCase.allowed ? 1 : 0, JSON.stringify(testCase));
    if (testCase.allowed) { assert.equal(opened[0][0], client); assert.equal(opened[0][1], window); assert.equal(opened[0][2], "zh-CN"); }
    else assert.equal(replies[0][3].error.code, -32000);
    if (testCase.busy || testCase.covered || testCase.unregistered || testCase.destroyed || testCase.replaced) assert.equal(lookups, 0);
  }
});

test("native pending reload selects current registered app views including inactive tabs", async () => {
  const run = currentReload(), calls = [], contents = new Map(), views = new Map(), registered = new Set([1, 2, 3, 4, 6]);
  const state = { generation: 0, pending: undefined, isCovered: item => item.id === 6 };
  for (const id of [1, 2, 3, 4, 5, 6, 8]) contents.set(id, { id, isDestroyed: () => id === 4,
    reload() { calls.push(id); if (id === 2) views.set(3, {}); } });
  for (const id of [1, 2, 3, 4, 5, 6, 7]) views.set(id, { active: id !== 2 });
  const ctx = { windowManager: { accountWindows: state, hasRegisteredWebContents: item => registered.has(item.id) }, getAppViews: () => views };
  await run(ctx, { webContents: { fromId: id => contents.get(id) } });
  assert.deepEqual(calls, [1, 2]);
  const first = deferred(), second = deferred(); state.pending = first.promise;
  let done = false; const waiting = run(ctx, { webContents: { fromId: id => contents.get(id) } }).then(() => { done = true; });
  state.pending = second.promise; state.generation++;
  first.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(done, false);
  state.pending = undefined; second.resolve(); await waiting; assert.equal(done, true);
  const failure = Error("inert native restore failure"); state.pending = Promise.reject(failure);
  await assert.rejects(run(ctx, { webContents: { fromId: id => contents.get(id) } }), error => error === failure);
  state.pending = undefined; calls.length = 0;
  contents.get(1).reload = () => { calls.push(1); state.generation++; };
  await run(ctx, { webContents: { fromId: id => contents.get(id) } }); assert.deepEqual(calls, [1]);
  calls.length = 0; const next = deferred();
  contents.get(1).reload = () => { calls.push(1); state.pending = next.promise; };
  await run(ctx, { webContents: { fromId: id => contents.get(id) } }); assert.deepEqual(calls, [1]);
  state.pending = undefined; next.resolve();
});

for (const action of ["switch", "add"]) {
  test(`runtime awaits ${action} reload and keeps accepted credentials after reload rejection`, async t => {
    for (const reject of [false, true]) {
      const entered = deferred(), finished = deferred();
      const f = fixture(t, { ...(action === "add" ? { login: "second" } : {}), reload: () => { entered.resolve(); return finished.promise; } });
      if (action === "switch") { await f.open(3); f.seedSecond(); }
      let settled = false; const opening = f.open(1).then(() => { settled = true; });
      await entered.promise; assert.equal(f.runtime.isBusy(), true); assert.equal(settled, false);
      assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("second"));
      if (reject) finished.reject(Error("inert renderer failure")); else finished.resolve();
      await opening; assert.equal(f.runtime.isBusy(), false); assert.equal(settled, true);
      assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("second"));
      assert.equal(f.calls.filter(call => call === "restart").length, action === "switch" ? 1 : 0);
      assert.equal(f.calls.includes("account/login/cancel"), false);
      if (reject) assert.equal(f.dialogs.at(-1).type, "error");
    }
  });
}

test("main account Adapter rejects partial context, source-role and suffix drift before writing", () => {
  const raw = accountMainFixture(), patched = applyMain(raw), own = accountOwnedParts(patched);
  const config = mainCallback(raw);
  const unknownSuffix = raw.slice(0, config.site.overrides.arrayEnd - 1) + ',"unknown.policy=true"' + raw.slice(config.site.overrides.arrayEnd - 1);
  const broken = [
    raw.replace("this.appState=e.appGlobalState", "this.appState=e.globalState"),
    raw.replace("let appViews=e.appViewsByWebContentsId", "let appViews=e.otherViews"),
    raw.replace("originWebcontentsId:e.id", "originWebcontentsId:other.id"),
    raw.replace("n.response,t.request.trace,t.priority", "n.response,t.request.trace,t.otherPriority"),
    unknownSuffix,
    patched.slice(0, own.routeStart) + patched.slice(own.routeEnd),
    patched.replace(own.producer, ""),
    patched.replace(own.suffix, ""),
    patched.replace(own.producer, own.producer.replace("this.options.windowManager", "this.otherWindowManager")),
    patched.replace(own.producer, own.producer.replace("this.options.appViewsByWebContentsId", "this.options.otherViews")),
    patched.replace(own.suffix, own.suffix.replace('id===`local`', 'id===`durable`')),
    patched.replace("await reload();", "reload();"),
  ];
  const afterProducer = own.producerStart + own.producer.length;
  for (const setter of [
    ',this.messageHandler.codexLinuxAccountSwitcherMainCtx={}',
    String.raw`,this.messageHandler.\u0063odexLinuxAccountSwitcherMainCtx={}`,
    ',this.messageHandler["codexLinuxAccountSwitcherMainCtx"]={}',
    String.raw`,this.messageHandler["\u0063odexLinuxAccountSwitcherMainCtx"]={}`,
  ]) broken.push(patched.slice(0, afterProducer) + setter + patched.slice(afterProducer));
  for (const source of broken) {
    assert.doesNotThrow(() => new vm.Script(source));
    const result = quietMain(() => applyMain(source));
    assert.equal(result.value, source); assert.equal(result.warnings.length, 1);
  }
});

test("registered account main Adapter validates all nineteen same-ID copies atomically", t => {
  const current = accountMainFixture(), canonical = applyMain(current), owner = "early-bootstrap-45-aaaaaaaaaaaaaaaa.js";
  for (const peer of [
    current, canonical, 'exports.ids=[46],exports.modules={82820(e,t,r){return false}};',
    current.replace("globalState:this.appState", "globalState:this.scopedState"),
    "/*codexLinuxAccountSwitcherMain*/const orphan=true;",
  ]) {
    const files = { ...nineteenAccountChunks(current), "early-bootstrap-46-cccccccccccccccc.js": peer }, app = accountMainWorkspace(t, files);
    const { patch, report } = normalAccountMain(app.root);
    assert.equal(patch.status, "skipped-optional"); assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
    for (const [name, source] of Object.entries(files)) assert.equal(app.read(name), source);
  }
  const files = nineteenAccountChunks(current), app = accountMainWorkspace(t, files); assert.equal(Object.keys(files).length, 19);
  let writes = 0;
  const failed = normalAccountMain(app.root, { writeFileSync(file, bytes) {
    if (++writes === 1) { fs.writeFileSync(file, "partial account main"); throw Error("interrupted account main write"); }
    fs.writeFileSync(file, bytes);
  } });
  assert.equal(failed.patch.status, "skipped-optional"); assert.equal(enabledFeatureFailuresFromReport(failed.report).length, 1);
  for (const [name, source] of Object.entries(files)) assert.equal(app.read(name), source);
  assert.equal(normalAccountMain(app.root).patch.status, "applied");
  assert.equal(normalAccountMain(app.root).patch.status, "already-applied");
  for (const [name, source] of Object.entries(files)) assert.equal(app.read(name), name === owner ? canonical : source);
});

test("semantic contracts preserve renamed symbols, reject partial drift, and route the Polish menu action", async () => {
  const main = accountMainFixture();
  for (const [source, apply, drift] of [[main, applyMain, "secretAuthStorageConfigOverrides"], [UI_CHUNK, applyUi, "accountSwitcher"]]) {
    const patched = apply(source);
    assert.notEqual(patched, source);
    new vm.Script(patched.replace(/export const /g, "var "));
    assert.equal(apply(patched), patched);
    assert.equal(apply(source + source), source + source);
    assert.equal(apply(source.replace(drift, "retired")), source.replace(drift, "retired"));
  }
  const { text: callback } = mainCallback(applyMain(main));
  for (const id of ["local", "ssh-test", "durable"]) {
    const options = { hostConfig: { id, kind: id === "ssh-test" ? "ssh" : "local" }, globalState: {}, secretAuthStorageConfigOverrides: ["policy"] };
    const config = vm.runInNewContext(`(${callback})`, {
      e: options, KS: { s1: () => ["base"] }, ed: { cPM: () => false }, sd: async () => null,
    });
    assert.deepEqual(Array.from(await config()), ["base", "policy",
      ...(id === "ssh-test" ? [] : ["plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=false"]),
      ...(id === "local" ? ['cli_auth_credentials_store="file"', "features.secret_auth_storage=false"] : [])]);
  }
  const raw = mainCallback(main), iife = raw.text.indexOf("...await async function");
  const retiredCallback = raw.text.slice(0, iife) + "...await extras(e)]";
  const retired = main.slice(0, raw.site.overrides.start) + retiredCallback + main.slice(raw.site.overrides.end);
  assert.equal(quietMain(() => applyMain(retired)).value, retired);

  const invalid = {
    unboundMenuModule: UI_CHUNK.replace('Menu=n("menu"),', ""),
    unboundBus: UI_CHUNK.replace(',Bus=n("bus")', ""),
    // Sites split across module factories cannot share the injected helper.
    splitModules: UI_CHUNK.replace('fmt.formatMessage({id:"codex.profileDropdown.copyUserIdForEmail"', 'fmt.x}},Cd34(e,t,n){fmt.formatMessage({id:"codex.profileDropdown.copyUserIdForEmail"').replace("other:()=>1})}", "other:()=>1})}"),
    retiredTemplateLiterals: UI_CHUNK.replace('"avatar-overlay-open"', "`avatar-overlay-open`"),
  };
  for (const [name, source] of Object.entries(invalid)) assert.equal(applyUi(source), source, name);
  const renamed = UI_CHUNK.replace(/\bMenu\b/g, "RenamedMenu").replaceAll(".tJ", ".zQ").replace(/\bBus\b/g, "Wire").replaceAll(".O1", ".k9");
  assert.match(applyUi(renamed), /\(0,UI\.jsx\)\(RenamedMenu\.zQ,\{onClick:\(\)=>\{close\(\);Wire\.k9\.dispatchMessage\("mcp-request"/);
  const patched = applyUi(UI_CHUNK);
  assert.equal(patched.match(/method:"community\/accountSwitcher"/g).length, 1);
  assert.match(patched, /additionalItems:codexLinuxAccountSwitcherItems\(items,close,fmt\),/);
  assert.match(patched, /children:\[divider,identity,null,settings,codexLinuxAccountSwitcherRow\(close,fmt\)\]/);
});

test("rendering either profile layout cannot invoke a shadowing pet callback", () => {
  const patched = applyUi(UI_CHUNK);
  assert.notEqual(patched, UI_CHUNK);
  for (const sidebarFooter of [null, {}]) for (const petEnabled of [true, false]) {
    const sent = [], rows = [];
    let closed = 0, petClick;
    const jsx = (type, props) => ({ type, props });
    const MenuItem = props => { rows.push(props); return null; };
    const profile = loadProfile(patched, {
      petEnabled, intl: () => ({ locale: "pl", formatMessage() {} }),
      Layout: props => { petClick = props.onTogglePet; return props.additionalItems; },
      asset: { T: null }, shortcut: null, settingsClick() {}, icon: null, switcher: null,
      items: null, identity: null, divider: null, workspace: null, analytics: null, more: null,
    }, {
      jsx: { jsx, jsxs: jsx, Fragment: "fragment" }, menu: { tJ: MenuItem },
      bus: { O1: { dispatchMessage: (...args) => sent.push(args) } }, text: { A: () => null },
    });
    const render = node => {
      if (Array.isArray(node)) return node.forEach(render);
      if (!node || typeof node !== "object") return;
      if (typeof node.type === "function") render(node.type(node.props));
      else render(node.props.children);
    };
    for (let opening = 0; opening < 3; opening++) {
      rows.length = 0;
      render(profile({ sidebarFooter, onClose: () => closed++ }));
      assert.equal(closed, 0, "opening the menu must not close it");
      assert.equal(sent.length, 0, "rendering must not open the pet or switch accounts");
      assert.equal(rows.filter(row => row.children === "Przełącz konto…").length, 1);
    }
    rows.find(row => row.children === "Przełącz konto…").onClick();
    assert.equal(closed, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0][0], "mcp-request");
    assert.equal(sent[0][1].hostId, "local");
    assert.equal(sent[0][1].request.method, "community/accountSwitcher");
    assert.equal(sent[0][1].request.params.locale, "pl");
    if (sidebarFooter && petEnabled) {
      petClick();
      assert.equal(closed, 2);
      assert.equal(sent[1][0], "avatar-overlay-open", "the explicit pet action must remain available");
    }
  }
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
const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("official main and profile dropdown chunks patch uniquely and remain valid JavaScript", { skip: !official && !signedApp }, () => {
  const { descriptors } = require("./patch");
  const needles = descriptors.find(descriptor => descriptor.id === "account-switcher-profile-menu").assetNeedles;
  for (const [kind, apply] of [["main", applyMain], ["webview", applyUi]]) {
    const directory = official || path.join(signedApp, kind === "main" ? ".vite/build" : "webview/assets");
    // rspack spreads the main process and the webview over chunks; exactly one must hold the contract.
    const names = kind === "main"
      ? fs.readdirSync(directory).filter(file => file.startsWith("early-bootstrap") && file.endsWith(".js"))
      : official ? fs.readdirSync(directory).filter(file => file.endsWith(".js"))
        : findWebviewAssetsContaining(signedApp, needles);
    const changed = names.filter(name => {
      const source = fs.readFileSync(path.join(directory, name), "utf8");
      return apply(source) !== source;
    });
    assert.equal(changed.length, 1, `expected a unique ${kind} chunk`);
    const source = fs.readFileSync(path.join(directory, changed[0]), "utf8");
    const patched = apply(source);
    assert.notEqual(patched, source);
    assert.equal(apply(patched), patched);
    if (kind === "main") {
      new vm.Script(patched);
      assert.equal(patched.split("app.quit(").length, source.split("app.quit(").length);
      assert.equal(patched.split("app.relaunch(").length, source.split("app.relaunch(").length);
    } else {
      assert.equal(patched.match(/method:"community\/accountSwitcher"/g).length, 1);
      assert.equal(patched.match(/codexLinuxAccountSwitcherItems\(/g).length, 2);
      assert.equal(patched.match(/codexLinuxAccountSwitcherRow\(/g).length, 3);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-signed-descriptor-"));
      try {
        const target = path.join(root, "webview/assets", changed[0]);
        fs.mkdirSync(path.dirname(target), { recursive: true });fs.writeFileSync(target, source);
        assert.equal(runProfileDescriptor(root).status, "applied");
        assert.equal(runProfileDescriptor(root).status, "already-applied");
        const wrong = patched.replace('method:"community/accountSwitcher"', 'method:"community/wrongAccountSwitcher"');
        fs.writeFileSync(target, wrong);
        assert.equal(runProfileDescriptor(root).status, "skipped-optional");
        assert.equal(fs.readFileSync(target, "utf8"), wrong);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }

      execFileSync(process.execPath, ["--input-type=module", "--check"], { input: patched, stdio: "pipe" });
      // Execute the injected module-scope rows with inert JSX and transport
      // bindings named exactly as the signed module's import bindings.
      const ident = "[A-Za-z_$][\\w$]*";
      const helper = patched.match(new RegExp(
        `/\\*codexLinuxAccountSwitcherUi\\*/function codexLinuxAccountSwitcherRow\\(close,intl\\)\\{return\\(0,(${ident})\\.jsx\\)\\((${ident})\\.(${ident}),` +
        `\\{onClick:\\(\\)=>\\{close\\(\\);(${ident})\\.(${ident})\\.dispatchMessage[\\s\\S]*?function codexLinuxAccountSwitcherItems\\(items,close,intl\\)\\{[^{}]*\\{[^{}]*\\}\\)\\}`));
      assert.ok(helper, "injected module-scope helper");
      const [code, jsxAlias, menuModule, menuExport, busModule, busExport] = helper;
      for (const name of [jsxAlias, menuModule, busModule]) {
        assert.match(source, new RegExp(`[,\\s]${name.replace(/\$/g, "\\$")}=[A-Za-z_$][\\w$]*\\("[^"]+"\\)`), `${name} is a module import binding`);
      }
      const sent = [], rendered = [];
      let closed = 0;
      const component = props => { rendered.push(props); return null; };
      const jsx = (type, props) => ({ type, props });
      const items = vm.runInNewContext(`${code};codexLinuxAccountSwitcherItems`, {
        [jsxAlias]: { jsx, jsxs: jsx, Fragment: "fragment" }, [menuModule]: { [menuExport]: component },
        [busModule]: { [busExport]: { dispatchMessage: (...args) => sent.push(args) } },
      });
      const element = items("existing", () => closed++, { locale: "pl" });
      assert.equal(element.props.children[0], "existing");
      const row = element.props.children[1];
      assert.equal(row.type, component);
      row.type(row.props);
      assert.equal(rendered.length, 1);
      assert.equal(rendered[0].children, "Przełącz konto…");
      assert.equal(closed, 0);
      assert.equal(sent.length, 0);
      rendered[0].onClick();
      assert.equal(closed, 1);
      assert.deepEqual([sent.length, sent[0][0], sent[0][1].request.method], [1, "mcp-request", "community/accountSwitcher"]);
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

test("switching waits for the principal invalidated by the reconnect", async t => {
  const f = fixture(t);
  await f.open(3); f.seedSecond();
  const settled = f.client.getAuthenticatedPrincipal;
  let lookupsAfterRestart = 0;
  f.client.getAuthenticatedPrincipal = async () => {
    if (!f.calls.includes("restart")) return settled();
    return ++lookupsAfterRestart < 3 ? null : settled();
  };
  await f.open(1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("second"));
  assert.equal(f.calls.filter(c => c === "restart").length, 1);
  assert.equal(lookupsAfterRestart, 3);
});

test("login completion waits for the principal invalidated by upstream account notifications", async t => {
  const f = fixture(t, { login: "second" });
  const settled = f.client.getAuthenticatedPrincipal;
  let lookupsAfterLogin = 0;
  f.client.getAuthenticatedPrincipal = async () => {
    if (!fs.readFileSync(f.authPath, "utf8").includes("account-second")) return settled();
    return ++lookupsAfterLogin < 3 ? null : settled();
  };
  await f.open(1);
  assert.equal(fs.readFileSync(f.authPath, "utf8"), credentials("second"));
  assert.equal(JSON.parse(fs.readFileSync(f.vault)).accounts.length, 2);
});
