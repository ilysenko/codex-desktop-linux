"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { loadLinuxFeaturePatchDescriptors, stageEnabledLinuxFeatureInstall } = require("../../scripts/lib/linux-features.js");
const {
  SETTINGS_KEY, BOOT_ONLY_SETTINGS_KEY, applyMainPatch, applySettingsPatch, settingComponent,
  codexLinuxStartMinimizedTrayReady, codexLinuxStartMinimizedAutostart,
  LABEL_IDS, LABEL_TRANSLATIONS, DESCRIPTION_IDS, DESCRIPTION_TRANSLATIONS,
} = require("./patch.js");

// Current upstream startup contract. The feature delegates hidden-window
// behavior to the native background-launch path after verifying tray readiness.
function startupFixture() {
  return `async function startup(e={isBackgroundLaunch:!1}){let V=await m.O({moduleDir:__dirname}),unused=0;
let options={canHideLastWindowToTray:Z9,isRemoteHostedPIPEnabled:noop};
let Ye=process.env.CODEX_ELECTRON_START_IN_BACKGROUND===\`1\`,Xe=(e,t=!0)=>{if(!t){e.showInactive();return}e.isMinimized()&&e.restore(),e.show(),e.focus()},Ze=async()=>{U.hotkeyWindowLifecycleManager.hide();let e=U.getPrimaryWindow()??await U.ensureWindow({background:!1});e!=null&&Xe(e)},Qe=()=>setup;
(L||process.platform===\`linux\`)&&Qe();
let ut=await U.ensureWindow({background:e.isBackgroundLaunch});ut?.once(\`show\`,()=>{_e.handleInitialWindowVisible()}),ut!=null&&!e.isBackgroundLaunch&&(Xe(ut,!Ye),_e.handleInitialWindowVisible());
let trayOpen=async()=>Ze();w(args=>{We.deepLinks.queueProcessArgs(args)&&Ze()});await beforeFinish?.(Ze,trayOpen);return {secondInstance:Ze,trayOpen}}`;
}
async function runStartup({ preference = true, onlyOnBoot = false, env = {}, cgroup = "0::/user.slice/app.slice/app-codex.scope\n", platform = "linux", argv = ["ChatGPT"], ready = true, existing = false, setup = Promise.resolve(), beforeFinish = null, background = false } = {}) {
  const calls = [];
  const mockWindow = {
    show: () => calls.push("show"), showInactive: () => calls.push("showInactive"),
    focus: () => calls.push("focus"), restore: () => calls.push("restore"),
    isDestroyed: () => false, isMinimized: () => false, once: () => {},
  };
  let primary = existing ? mockWindow : null;
  const U = {
    windowManager: {},
    getPrimaryWindow: () => primary,
    ensureWindow: async ({ background = false } = {}) => {
      if (primary && !background) { primary.show(); primary.focus(); }
      else if (!primary) primary = mockWindow;
      return primary;
    },
    hotkeyWindowLifecycleManager: { hide: () => calls.push("hideHotkey") },
  };
  const context = {
    process: { platform, argv, env: { ...env, CODEX_ELECTRON_START_IN_BACKGROUND: background ? "1" : "0" } },
    m: { O: async () => ({ globalState: { getStored: key => {
      if (key === SETTINGS_KEY) return preference;
      assert.equal(key, BOOT_ONLY_SETTINGS_KEY); return onlyOnBoot;
    } } }) },
    require: name => { assert.equal(name, "node:fs"); return { readFileSync: (file, encoding) => {
      assert.equal(file, "/proc/self/cgroup"); assert.equal(encoding, "utf8");
      if (cgroup instanceof Error) throw cgroup;
      return cgroup;
    } }; },
    U, Z9: () => ready, setup, beforeFinish,
    L: platform === "win32", noop: () => {}, __dirname: "/bundle",
    We: { deepLinks: { queueProcessArgs: () => true } },
    _e: { handleInitialWindowVisible: () => calls.push("attribution") },
    setTimeout, clearTimeout,
    w: callback => { context.secondInstanceArgs = callback; },
  };
  const patched = applyMainPatch(startupFixture());
  assert.notEqual(patched, startupFixture());
  const handlers = await vm.runInNewContext(`${patched};startup()`, context);
  return { calls, handlers, secondInstanceArgs: context.secondInstanceArgs };
}

test("hidden cold launch avoids show/focus and attribution, even with an existing window", async () => {
  for (const existing of [false, true]) {
    const { calls, handlers } = await runStartup({ existing });
    assert.deepEqual(calls, []);
    await handlers.trayOpen("/", {});
    assert.deepEqual(calls, ["hideHotkey", "show", "focus"]);
  }
});

test("second launch reveals the hidden window through the upstream handler", async () => {
  const { calls, handlers } = await runStartup();
  await handlers.secondInstance();
  assert.deepEqual(calls, ["hideHotkey", "show", "focus"]);
});

test("boot-only works independently, overrides all-starts preference, and leaves manual starts visible", async () => {
  for (const preference of [true, false, null]) {
    assert.deepEqual((await runStartup({ preference, onlyOnBoot: true })).calls, ["show", "focus", "attribution"]);
    for (const marker of [
      { argv: ["ChatGPT", "--codex-autostart", "--ozone-platform=wayland"] },
      { env: { DESKTOP_AUTOSTART_ID: "session-client" } },
      { cgroup: "0::/user.slice/user@1000.service/app.slice/app-codex\\x2ddesktop@autostart.service\n" },
      { cgroup: "1:name=systemd:/user.slice/app-other@autostart.service/child\n0::/other\n" },
    ]) {
      const hidden = await runStartup({ preference, onlyOnBoot: true, ...marker });
      assert.deepEqual(hidden.calls, []);
      await hidden.handlers.secondInstance();
      assert.deepEqual(hidden.calls, ["hideHotkey", "show", "focus"]);
    }
  }
});

test("boot-only still falls back on unavailable tray, reveals on activation, and respects files and deep links", async () => {
  const options = { onlyOnBoot: true, preference: false, argv: ["ChatGPT", "--codex-autostart"] };
  const tray = await runStartup(options);
  await tray.handlers.trayOpen("/", {});
  assert.deepEqual(tray.calls, ["hideHotkey", "show", "focus"]);
  for (const overrides of [
    { ready: false }, { platform: "win32" },
    { argv: [...options.argv, "codex://threads/123"] },
    { argv: [...options.argv, "/home/user/file.txt"] },
    { argv: ["ChatGPT"], cgroup: Error("unavailable") },
  ]) assert.deepEqual((await runStartup({ ...options, ...overrides })).calls, ["show", "focus", "attribution"]);
  for (const onlyOnBoot of [false, null, "true"]) {
    assert.deepEqual((await runStartup({ ...options, onlyOnBoot })).calls, ["show", "focus", "attribution"]);
  }
});

test("autostart detection uses explicit signals, never uptime, background mode, or ordinary service names", () => {
  for (const cgroup of ["", "0::/app-codex.scope", "0::/autostart.service", "0::/app-codex@autostart.service.bak", "0::/app-codex@autostart.service-other"]) {
    assert.equal(codexLinuxStartMinimizedAutostart({ platform: "linux", argv: ["ChatGPT", "--codex-autostart=false"], env: { DESKTOP_AUTOSTART_ID: " ", CODEX_ELECTRON_START_IN_BACKGROUND: "1" } }, () => cgroup), false);
  }
  assert.equal(codexLinuxStartMinimizedAutostart({ platform: "darwin", argv: ["ChatGPT", "--codex-autostart"], env: {} }, () => { throw Error(); }), false);
});

function runLoginHook(cgroupFile, { env = {}, args = [] } = {}) {
  const result = spawnSync("bash", ["-c", 'source "$1"; shift; codex_start_minimized_login_hook "$@"',
    "login-hook-test", path.join(__dirname, "launcher-hook.sh"), cgroupFile, ...args], {
    encoding: "utf8", env: { ...process.env, DESKTOP_AUTOSTART_ID: "", ...env },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("launcher captures login autostart before the native process moves into a Chromium scope", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-login-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cgroupFile = path.join(root, "cgroup");
  const nativeScope = "0::/user.slice/user@1000.service/app.slice/app-org.chromium.Chromium-123.scope\n";
  for (const cgroup of [
    "0::/user.slice/user@1000.service/app.slice/app-codex\\x2ddesktop@autostart.service\n",
    "1:name=systemd:/user.slice/app-codex@autostart.service/child\n0::/other",
  ]) {
    fs.writeFileSync(cgroupFile, cgroup);
    const directive = runLoginHook(cgroupFile);
    assert.equal(directive, "electron-arg --codex-autostart\n");
    const args = ["ChatGPT", directive.trim().slice("electron-arg ".length)];
    assert.deepEqual((await runStartup({ preference: false, onlyOnBoot: true, argv: args, cgroup: nativeScope })).calls, []);
    assert.deepEqual((await runStartup({ preference: false, onlyOnBoot: false, argv: args, cgroup: nativeScope })).calls, ["show", "focus", "attribution"]);
    assert.deepEqual((await runStartup({ onlyOnBoot: true, argv: [...args, "codex://threads/123"], cgroup: nativeScope })).calls, ["show", "focus", "attribution"]);
  }
  for (const cgroup of [nativeScope, "0::/app-codex@autostart.service.bak\n", "0::/autostart.service\n", "malformed:/app-codex@autostart.service\n", ""]) {
    fs.writeFileSync(cgroupFile, cgroup);
    assert.equal(runLoginHook(cgroupFile), "");
  }
  assert.equal(runLoginHook(path.join(root, "missing")), "");
  assert.equal(runLoginHook(cgroupFile, { env: { DESKTOP_AUTOSTART_ID: " \t" } }), "");
  assert.equal(runLoginHook(cgroupFile, { env: { DESKTOP_AUTOSTART_ID: "session-client" } }), "electron-arg --codex-autostart\n");
  assert.equal(runLoginHook(cgroupFile, { env: { DESKTOP_AUTOSTART_ID: "session-client" }, args: ["--codex-autostart"] }), "");
});

test("declarative staging installs the executable login hook only when the feature is enabled", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-hook-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresConfigPath = path.join(root, "features.json");
  const options = { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath };
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: ["start-minimized-to-tray"] }));
  const app = path.join(root, "app");
  stageEnabledLinuxFeatureInstall(app, options);
  const staged = path.join(app, ".codex-linux/launcher.d/start-minimized-to-tray-login.sh");
  assert.equal(fs.readFileSync(staged, "utf8"), fs.readFileSync(path.join(__dirname, "launcher-hook.sh"), "utf8"));
  assert.equal(fs.statSync(staged).mode & 0o777, 0o755);
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: [] }));
  stageEnabledLinuxFeatureInstall(app, options);
  assert.equal(fs.existsSync(staged), false);
});

test("the standard launcher forwards automatic and explicit login markers without changing URIs or duplicating the flag", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresConfigPath = path.join(root, "features.json");
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: ["start-minimized-to-tray"] }));
  const app = path.join(root, "app");
  stageEnabledLinuxFeatureInstall(app, { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath });
  const launcher = path.join(app, "start.sh");
  fs.writeFileSync(launcher, fs.readFileSync(path.resolve(__dirname, "../../launcher/start.sh.template"), "utf8")
    .replaceAll("__CODEX_LINUX_APP_ID__", "codex-desktop")
    .replaceAll("__CODEX_LINUX_APP_DISPLAY_NAME__", "ChatGPT Community"), { mode: 0o755 });
  fs.writeFileSync(path.join(app, "ChatGPT"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
  const uri = "codex://threads/test";
  for (const [autostart, explicit] of [[false, false], [true, false], [true, true], [false, true]]) {
    const result = spawnSync(launcher, [...(explicit ? ["--codex-autostart"] : []), uri], {
      encoding: "utf8", env: { ...process.env, DESKTOP_AUTOSTART_ID: autostart ? "session-client" : "",
        CODEX_HOME: path.join(root, "codex-home"), XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
        CODEX_LINUX_DISABLE_USAGE_REPORTING: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(result.stdout);
    assert.equal(args.filter(arg => arg === "--codex-autostart").length, autostart || explicit ? 1 : 0);
    assert.equal(args.at(-1), uri);
  }
});

test("a queued second-instance deep link also reveals the hidden window", async () => {
  const { calls, secondInstanceArgs } = await runStartup();
  secondInstanceArgs(["ChatGPT", "codex://threads/123"]);
  assert.deepEqual(calls, ["hideHotkey", "show", "focus"]);
  const normal = await runStartup({ preference: false });
  normal.secondInstanceArgs(["ChatGPT", "codex://threads/123"]);
  assert.deepEqual(normal.calls, ["show", "focus", "attribution", "hideHotkey", "show", "focus"]);
});

test("tray and second-instance activation reveal an existing hidden window before host readiness", async () => {
  for (const activate of [(second) => second(), (_, tray) => tray("/", {})]) {
    const { calls } = await runStartup({ beforeFinish: activate });
    assert.deepEqual(calls, ["hideHotkey", "show", "focus"]);
  }
  const { calls } = await runStartup({ preference: false, beforeFinish: (second) => second() });
  assert.deepEqual(calls, ["show", "focus", "attribution", "hideHotkey", "show", "focus"]);
});

test("disabled/unset/invalid preference, non-Linux, files, and URIs preserve visible startup", async () => {
  for (const options of [
    { preference: false }, { preference: null }, { preference: "true" },
    { platform: "win32" }, { platform: "darwin" },
    { argv: ["ChatGPT", "codex://threads/123"] },
    { argv: ["ChatGPT", "/home/user/file.txt"] },
  ]) {
    const { calls } = await runStartup(options);
    assert.deepEqual(calls, ["show", "focus", "attribution"]);
  }
  assert.deepEqual((await runStartup({ preference: false, background: true })).calls,
    ["showInactive", "attribution"]);
  assert.deepEqual((await runStartup({ argv: ["ChatGPT", "--ozone-platform=wayland"] })).calls, []);
});

test("failed or unavailable tray leaves the window visible", async () => {
  const rejection = Promise.reject(Error("no tray"));
  rejection.catch(() => {});
  for (const options of [{ ready: false }, { setup: rejection, ready: false }]) {
    assert.deepEqual((await runStartup(options)).calls, ["show", "focus", "attribution"]);
  }
});

test("tray wait is bounded and clears the timer on success or failure", async () => {
  assert.equal(await codexLinuxStartMinimizedTrayReady(Promise.resolve(), () => true, 10), true);
  assert.equal(await codexLinuxStartMinimizedTrayReady(Promise.reject(Error()), () => false, 10), false);
  assert.equal(await codexLinuxStartMinimizedTrayReady(new Promise(() => {}), () => false, 10), false);
});

function captureWarnings(callback) {
  const warnings = [], previous = console.warn;
  console.warn = message => warnings.push(message);
  try { return { value: callback(), warnings }; } finally { console.warn = previous; }
}

test("main patch is idempotent, preserves aliases, and fails closed on absent/ambiguous contracts", () => {
  const source = startupFixture(), patched = applyMainPatch(source);
  assert.equal(applyMainPatch(patched), patched);
  const renamed = source.replaceAll("Ye", "bgAlias").replaceAll("Xe", "showAlias").replaceAll("U.", "serviceAlias.");
  assert.notEqual(applyMainPatch(renamed), renamed);
  const patchedRelationships = [
    "let codexLinuxStartMinimizedPreferences=codexLinuxStartMinimizedPreference(V.globalState);",
    "let codexLinuxStartMinimized=codexLinuxStartMinimizedPreferences.requested;",
    "console.info(`[start-minimized-to-tray] startup preference`,codexLinuxStartMinimizedPreferences);",
    "let codexLinuxStartMinimizedTraySetup=(L||process.platform===`linux`)?Qe():null;",
    "if(codexLinuxStartMinimized){let ready=await codexLinuxStartMinimizedTrayReady(codexLinuxStartMinimizedTraySetup,Z9);",
    "console.info(`[start-minimized-to-tray] tray readiness`,{ready});",
    "codexLinuxStartMinimized=codexLinuxStartMinimized&&ready;e.isBackgroundLaunch=e.isBackgroundLaunch||codexLinuxStartMinimized/*codexLinuxStartMinimizedNativeBackground*/",
    "let ut=await U.ensureWindow({background:e.isBackgroundLaunch});",
    "ut?.once(`show`,()=>{_e.handleInitialWindowVisible()}),",
    "ut!=null&&!e.isBackgroundLaunch&&(Xe(ut,!Ye),_e.handleInitialWindowVisible())",
  ];
  for (const relationship of patchedRelationships) {
    for (const drift of [patched.replace(relationship, ""), `${patched}${relationship}`]) {
      const result = captureWarnings(() => applyMainPatch(drift));
      assert.equal(result.value, drift);
      assert.equal(result.warnings.length, 1, relationship);
    }
  }
  for (const drift of [source + source, patched + source, patched + patched,
    source + `function codexLinuxStartMinimizedTrayReady(){}`,
    patched.replace("codexLinuxStartMinimizedNativeBackground", "changedNativeBackground"),
    patched.replace("codexLinuxStartMinimizedPreference(V.globalState)", "codexLinuxStartMinimizedPreference(other.globalState)"),
    patched.replace("only-on-boot", "changed-boot-key"),
    source.replace("canHideLastWindowToTray", "changed"),
    source.replace("moduleDir:__dirname", "moduleDir:changed"),
    source.replace("ensureWindow({background:e.isBackgroundLaunch})", "ensureWindow()"),
    source.replace("handleInitialWindowVisible", "changedInitialWindowVisible"),
    source.replace("(L||process.platform===`linux`)&&Qe();", "Qe();")]) {
    const result = captureWarnings(() => applyMainPatch(drift));
    assert.equal(result.value, drift);
    assert.equal(result.warnings.length, 1);
  }
});

function settingsFixture() {
  return 'function menu(e){let i=intlHook(),{platform:p}=platformHook(),v=useSetting(keys.macMenuBarEnabled);if(p!==`macOS`)return null;let label=i.formatMessage({id:`settings.general.macMenuBar.ariaLabel`,defaultMessage:`Show in menu bar`});let c=(0,j.jsx)(Toggle,{checked:v,onChange:change,ariaLabel:label});return(0,j.jsx)(Row,{label:title,description:description,control:c})}' +
    'function another(){let[e,t]=(0,React.useState)(!1)}var React=reactFactory();' +
    'var page=(0,j.jsx)(menu,{appName:appName});/*settings.general.macMenuBar.description*/';
}

function catalogFixture(alias = "messages") {
  return `var ${alias}={"settings.general.macMenuBar.label":"Existing translated toggle","unrelated":"Unchanged"};export{${alias} as default};`;
}

test("settings patch discovers semantic assets and request export, is idempotent, and fails without writes", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets"); fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, "renamed-settings.js"), source = settingsFixture();
  fs.writeFileSync(target, source);
  const catalog = path.join(assets, "pl-PL-current.js"), originalCatalog = catalogFixture();
  fs.writeFileSync(catalog, originalCatalog);
  fs.writeFileSync(path.join(assets, "request-renamed.js"),
    'async function post(...e){let[t,n]=e,{params:r,select:i,signal:a,source:o,responsePriority:s}=n??{};return raw(t,r,i,a,o,s)}async function raw(e){return client.post(`vscode://codex/${e}`)}export{post as fetchRequest};');
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  const patched = fs.readFileSync(target, "utf8");
  assert.match(patched, /import\{fetchRequest as codexLinuxStartMinimizedPost\}/);
  assert.match(patched, /Start minimized to tray/);
  assert.match(patched, /Start minimized to tray only on boot/);
  assert.match(patched, /codexLinuxStartMinimizedBootOnlySetting,\{\}/);
  const patchedCatalog = fs.readFileSync(catalog, "utf8");
  assert.ok(patchedCatalog.includes(JSON.stringify(LABEL_TRANSLATIONS["pl-PL"][0])));
  assert.ok(patchedCatalog.endsWith(originalCatalog.slice(originalCatalog.indexOf("{") + 1)));
  assert.deepEqual(applySettingsPatch(root), { changed: false });
  assert.equal(fs.readFileSync(target, "utf8"), patched);
  assert.equal(fs.readFileSync(catalog, "utf8"), patchedCatalog);
  for (const drift of [source + source, source.replace("if(p!==`macOS`)", "if(p===`macOS`)"),
    source.replace("appName:appName", "name:appName"), source.replace("i.formatMessage", "i.changed")]) {
    fs.writeFileSync(target, drift);
    assert.throws(() => applySettingsPatch(root), /contract missing or ambiguous/);
    assert.equal(fs.readFileSync(target, "utf8"), drift);
  }
  fs.writeFileSync(target, source);
  for (const drift of [originalCatalog + originalCatalog,
    originalCatalog.replace("messages as default", "messages as named"),
    patchedCatalog.replace(LABEL_TRANSLATIONS["pl-PL"][0], "changed")]) {
    fs.writeFileSync(catalog, drift);
    assert.throws(() => applySettingsPatch(root), /contract missing or ambiguous/);
    assert.equal(fs.readFileSync(target, "utf8"), source);
    assert.equal(fs.readFileSync(catalog, "utf8"), drift);
  }
  for (const drift of [
    patchedCatalog.replace(DESCRIPTION_TRANSLATIONS["pl-PL"][0], "changed"),
    patchedCatalog.replace(JSON.stringify(DESCRIPTION_IDS[1]), '"missing-description"'),
  ]) {
    fs.writeFileSync(catalog, drift);
    assert.throws(() => applySettingsPatch(root), /contract missing or ambiguous/);
    assert.equal(fs.readFileSync(target, "utf8"), source);
    assert.equal(fs.readFileSync(catalog, "utf8"), drift);
  }
  fs.writeFileSync(catalog, originalCatalog);
  const unknownCatalog = path.join(assets, "xx-XX-current.js");
  fs.writeFileSync(unknownCatalog, originalCatalog);
  assert.throws(() => applySettingsPatch(root), /translations missing for xx-XX/);
  assert.equal(fs.readFileSync(target, "utf8"), source);
  assert.equal(fs.readFileSync(catalog, "utf8"), originalCatalog);
});

function componentHarness(post, bootOnly = false, platform = "linux", messages = {}) {
  const state = [], effects = [];
  let cursor = 0, mounted = false;
  const React = {
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], v => { state[index] = v; }]; },
    useEffect(callback) { if (!mounted) effects.push(callback); },
  };
  const context = { reactFactory: () => React, platformHook: () => ({ platform }),
    intlHook: () => ({ formatMessage: ({ id, defaultMessage }) => messages[id] ?? defaultMessage }),
    j: { jsx: (type, props) => ({ type, props }) }, Row: "row", Toggle: "toggle", codexLinuxStartMinimizedPost: post };
  const renderFn = vm.runInNewContext(`${settingComponent({row:"Row",toggle:"Toggle",reactFactory:"reactFactory",platformHook:"platformHook",jsx:"j",intlHook:"intlHook"}, bootOnly)};${bootOnly ? "codexLinuxStartMinimizedBootOnlySetting" : "codexLinuxStartMinimizedSetting"}`, context);
  const render = () => { cursor = 0; const result = renderFn(); mounted = true; return result; };
  return { render, load: async () => { effects.forEach(callback => callback()); await new Promise(resolve => setImmediate(resolve)); } };
}

test("General toggle loads and persists the profile preference, and disables while pending", async () => {
  for (const bootOnly of [false, true]) {
    const writes = [];
    const harness = componentHarness(async (method, { params }) => {
      assert.equal(params.key, bootOnly ? BOOT_ONLY_SETTINGS_KEY : SETTINGS_KEY);
      if (method === "get-global-state") return { value: true };
      writes.push(params.value); return { success: true };
    }, bootOnly);
    assert.equal(harness.render().props.control.props.disabled, true);
    await harness.load();
    let row = harness.render();
    assert.equal(row.props.control.props.checked, true);
    const saving = row.props.control.props.onChange(false);
    assert.equal(harness.render().props.control.props.disabled, true);
    await saving;
    assert.deepEqual(writes, [false]);
    row = harness.render();
    assert.equal(row.props.control.props.checked, false);
    assert.equal(row.props.control.props.disabled, false);
  }
});

test("both toggle names, descriptions and accessibility labels use the active locale, with unchanged English fallback", () => {
  assert.deepEqual(Object.keys(DESCRIPTION_TRANSLATIONS).sort(), Object.keys(LABEL_TRANSLATIONS).sort());
  for (const bootOnly of [false, true]) {
    const messages = {};
    const harness = componentHarness(async () => ({ value: false }), bootOnly, "linux", messages);
    const english = harness.render();
    assert.equal(english.props.label, bootOnly ? "Start minimized to tray only on boot" : "Start minimized to tray");
    assert.equal(english.props.description, bootOnly
      ? "Hide the main window only when started automatically at login. Manual launches open normally. Takes priority over Start minimized to tray; does not enable autostart."
      : "Start with the main window hidden in the system tray. Applies after quitting and restarting the app, unless the boot-only option is enabled.");
    for (const [locale, labels] of Object.entries(LABEL_TRANSLATIONS)) {
      const descriptions = DESCRIPTION_TRANSLATIONS[locale];
      assert.equal(labels.length, 2, locale);
      assert.equal(descriptions.length, 2, locale);
      assert.ok(labels.every(label => typeof label === "string" && label.trim()), locale);
      assert.ok(descriptions.every(text => typeof text === "string" && text.trim()), locale);
      LABEL_IDS.forEach((id, index) => { messages[id] = labels[index]; });
      DESCRIPTION_IDS.forEach((id, index) => { messages[id] = descriptions[index]; });
      const translated = harness.render();
      assert.equal(translated.props.label, labels[Number(bootOnly)], locale);
      assert.equal(translated.props.control.props.ariaLabel, translated.props.label, locale);
      assert.equal(translated.props.description, descriptions[Number(bootOnly)], locale);
      assert.equal(translated.props.control.props.disabled, english.props.control.props.disabled, locale);
    }
    LABEL_IDS.forEach(id => { delete messages[id]; });
    DESCRIPTION_IDS.forEach(id => { delete messages[id]; });
    assert.equal(harness.render().props.label, english.props.label);
    assert.equal(harness.render().props.description, english.props.description);
  }
});

test("every supported translation catalog gains only the two names and descriptions and remains idempotent", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-labels-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets"); fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "general.js"), settingsFixture());
  fs.writeFileSync(path.join(assets, "request.js"),
    'async function post(...e){let[t,n]=e,{params:r,select:i,signal:a,source:o,responsePriority:s}=n??{};return raw(t,r,i,a,o,s)}async function raw(e){return client.post(`vscode://codex/${e}`)}export{post as fetchRequest};');
  for (const locale of Object.keys(LABEL_TRANSLATIONS)) {
    fs.writeFileSync(path.join(assets, `${locale}-current.js`), catalogFixture("dict"));
  }
  fs.writeFileSync(path.join(assets, "pl-unrelated.js"), "export default {unrelated:true};");
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  for (const [locale, labels] of Object.entries(LABEL_TRANSLATIONS)) {
    const source = fs.readFileSync(path.join(assets, `${locale}-current.js`), "utf8");
    const { default: catalog } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
    assert.deepEqual(catalog, {
      [LABEL_IDS[0]]: labels[0], [LABEL_IDS[1]]: labels[1],
      [DESCRIPTION_IDS[0]]: DESCRIPTION_TRANSLATIONS[locale][0],
      [DESCRIPTION_IDS[1]]: DESCRIPTION_TRANSLATIONS[locale][1],
      "settings.general.macMenuBar.label": "Existing translated toggle", unrelated: "Unchanged",
    }, locale);
  }
  assert.deepEqual(applySettingsPatch(root), { changed: false });
  assert.equal(fs.readFileSync(path.join(assets, "pl-unrelated.js"), "utf8"), "export default {unrelated:true};");
});

test("save errors still override the translated description and retain the confirmed preference", async () => {
  const messages = Object.fromEntries(DESCRIPTION_IDS.map((id, index) => [id, DESCRIPTION_TRANSLATIONS["pl-PL"][index]]));
  for (const bootOnly of [false, true]) {
    const harness = componentHarness(async method => {
      if (method === "get-global-state") return { value: false };
      throw Error("disk full");
    }, bootOnly, "linux", messages);
    harness.render(); await harness.load();
    assert.equal(harness.render().props.description, DESCRIPTION_TRANSLATIONS["pl-PL"][Number(bootOnly)]);
    await harness.render().props.control.props.onChange(true);
    assert.match(harness.render().props.description, /disk full/);
    assert.equal(harness.render().props.control.props.checked, false);
  }
});

test("save rejection or unsuccessful response keeps the confirmed preference and displays an error", async () => {
  for (const bootOnly of [false, true]) {
    for (const failure of [() => Promise.reject(Error("disk full")), async () => ({ success: false })]) {
      const harness = componentHarness((method) => method === "get-global-state" ? Promise.resolve({ value: false }) : failure(), bootOnly);
      harness.render(); await harness.load();
      await harness.render().props.control.props.onChange(true);
      const row = harness.render();
      assert.equal(row.props.control.props.checked, false);
      assert.equal(row.props.control.props.disabled, false);
      assert.match(row.props.description, /disk full|Could not save/);
    }
  }
});

test("both settings default to off, reject invalid saved values, and remain Linux-only", async () => {
  for (const bootOnly of [false, true]) {
    for (const value of [undefined, null, "true", 1]) {
      const harness = componentHarness(async () => ({ value }), bootOnly);
      harness.render(); await harness.load();
      assert.equal(harness.render().props.control.props.checked, false);
    }
    const harness = componentHarness(async () => ({ value: true }), bootOnly, "macOS");
    assert.equal(harness.render(), null);
  }
});

test("manifest is disabled by default and both descriptors are enforced only when enabled", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresConfigPath = path.join(root, "features.json");
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: [] }));
  const options = { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath };
  assert.deepEqual(loadLinuxFeaturePatchDescriptors(options), []);
  fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: ["start-minimized-to-tray"] }));
  assert.equal(loadLinuxFeaturePatchDescriptors(options).length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"))).defaultEnabled, false);
});
