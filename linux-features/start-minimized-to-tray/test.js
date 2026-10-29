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
const {
  SETTINGS_COMMAND_KEY: AGENT_WORKSPACE_COMMAND_KEY,
  SETTINGS_PERMISSIONS_KEY: AGENT_WORKSPACE_PERMISSIONS_KEY,
  applyAgentWorkspaceMainBridgePatch,
} = require("../agent-workspace/patch.js");
const { applyMainBundlePatch: applyReadAloudMainBundlePatch } = require("../read-aloud/patch.js");

// Signed stable 26.1027.30824 (rspack) startup contracts, with Electron services
// supplied by the harness. This exercises the actual patched control flow and handlers.
const windowModeFixture = 'class MessageHandler{' + "setPrimaryWindowMode(e,t){let r=ea.BrowserWindow.fromWebContents(e);if(!r||r.isDestroyed())return;let n=this.windowManager.getPrimaryWindow();if(!n||n.isDestroyed()||n.id!==r.id)return;if(!this.shouldShowPrimaryWindow()&&!r.isVisible())return void r.once(\"show\",()=>this.setPrimaryWindowMode(e,t));let i=\"onboarding\"!==t.mode?null:\"v2\"===t.onboardingVariant?{width:1090,height:760}:{width:560,height:560};if(ra()(this.primaryWindowMode,t)){null!=i&&this.showPrimaryWindow(r);return}if(this.primaryWindowMode=t,null!=i){null==this.primaryWindowRestoreBounds&&(this.primaryWindowRestoreBounds={bounds:r.getNormalBounds(),wasMaximized:r.isMaximized(),wasFullScreen:r.isFullScreen()}),r.isFullScreen()&&r.setFullScreen(!1),r.isMaximized()&&r.unmaximize(),r.setResizable(!0);let e=ea.screen.getDisplayMatching(r.getNormalBounds()).workAreaSize,t=\"win32\"===process.platform?{width:Math.max(0,r.getBounds().width-r.getContentBounds().width),height:Math.max(0,r.getBounds().height-r.getContentBounds().height)}:{width:0,height:0},n={width:e.width-t.width,height:e.height-t.height},s={width:Math.min(i.width,n.width),height:Math.min(i.height,n.height)},a=\"win32\"===process.platform,o=a&&(s.width>=.9*n.width||s.height>=.9*n.height),l=this.windowManager.getPrimaryMinimumSize();r.setMaximizable(a),r.setFullScreenable(!1),r.setMinimumSize(Math.min(l.width,s.width),Math.min(l.height,s.height)),r.setSize(s.width,s.height),o||r.center(),this.showPrimaryWindow(r),o&&r.maximize();return}if(r.setResizable(!0),r.setMaximizable(!0),r.setFullScreenable(!0),this.primaryWindowRestoreBounds){let{bounds:e,wasMaximized:t,wasFullScreen:n}=this.primaryWindowRestoreBounds;this.primaryWindowRestoreBounds=null;let i=this.windowManager.getPrimaryMinimumSize();r.setMinimumSize(i.width,i.height);let s={...e,width:Math.max(e.width,i.width),height:Math.max(e.height,i.height)};r.isMaximized()&&r.unmaximize(),r.setBounds(s),t&&r.maximize(),n&&r.setFullScreen(!0)}this.windowManager.syncPrimaryMinimumSize(),this.showPrimaryWindow(r)}showPrimaryWindow(e){e.isVisible()||(e.show(),e.focus())}" + '}';

function startupFixture() {
  return windowModeFixture + `class IpcHost{handlers={"set-remote-wsl-connections-enabled":async()=>({})}}
class WindowManager{install(F,x){if(x){this.pendingRestoredMaximization=new Set;this.pendingRestoredMaximization.add(F);let e=()=>{F.isDestroyed()||(F.maximize(),this.pendingRestoredMaximization.delete(F))};F.once("ready-to-show",()=>{F.isDestroyed()||(F.isVisible()?e():F.once("show",e))})}}}
function eR7(){return eR5&&eR2?.isReady()===!0}
async function startup(e={isBackgroundLaunch:false}){let V=await (0,m.O)({moduleDir:__dirname}),unused=0;
let options={canHideLastWindowToTray:eR7,isRemoteHostedPIPEnabled:noop,shouldShowPrimaryWindow:()=>!e.isBackgroundLaunch};
let Ke="1"===process.env.CODEX_ELECTRON_START_IN_BACKGROUND,qe=(e,t=!0)=>{if(!t){e.showInactive(),_e.handleInitialWindowVisible();return}e.isMinimized()&&e.restore(),e.show(),_e.handleInitialWindowVisible(),e.focus()},Je=async(e,t)=>{try{U.hotkeyWindowLifecycleManager.hide();let t=U.getPrimaryWindow()??await Ce("/");if(null==t)return;qe(t)}catch(e){throw e}},Ye=async(e,t)=>{if(!xe)return null;U.hotkeyWindowLifecycleManager.hide();let n=U.getPrimaryWindow(),r=n??await Ce(e);return null==r?null:(qe(r),r)},Qe=()=>setup;(L||"linux"===process.platform)&&Qe();
let st=We.deepLinks.isWakeOnlyLaunch()&&!eX?null:await U.ensureWindow({background:e.isBackgroundLaunch});st?.once("show",()=>{_e.handleInitialWindowVisible()}),null==st||e.isBackgroundLaunch||qe(st,!Ke);
e.onInteractiveLaunch=()=>{null==st||st.isDestroyed()||qe(st),noop()};
let backfill={shouldShow:()=>!e.isBackgroundLaunch&&!We.deepLinks.isWakeOnlyLaunch()},progress={shouldShow:()=>!e.isBackgroundLaunch&&!We.deepLinks.isWakeOnlyLaunch()};
await beforeFinish?.(Je,Ye,e.onInteractiveLaunch);
let gt=st;if(null==gt&&(!We.deepLinks.isWakeOnlyLaunch()||eX)?gt=await U.ensureWindow({background:e.isBackgroundLaunch}):gt?.isDestroyed()&&(gt=null),gt){gt!==st&&gt.once("show",()=>{_e.handleInitialWindowVisible()}),gt===st||e.isBackgroundLaunch||qe(gt,!Ke)}
xe=!0,w(e=>{let n=!1;if(We.deepLinks.queueProcessArgs(e)){n&&Je();return}n?Je():Je({channel:"shortcut"})});
return {secondInstance:Je,trayOpen:Ye,interactive:e.onInteractiveLaunch,shouldShow:options.shouldShowPrimaryWindow,backfill:backfill.shouldShow,progress:progress.shouldShow};}`;
}

test("main patch restores exactly one working global-state handler pair", async () => {
  const source = startupFixture();
  const patched = applyMainPatch(source);
  assert.equal(patched.split('"get-global-state":async').length - 1, 1);
  assert.equal(patched.split('"set-global-state":async').length - 1, 1);
  const IpcHost = vm.runInNewContext(`${patched};IpcHost`, { setTimeout, clearTimeout });
  const values = new Map();
  const host = new IpcHost();
  host.globalState = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const handlers = host.handlers;
  assert.deepEqual(
    JSON.parse(JSON.stringify(await handlers["get-global-state"]({ params: { key: SETTINGS_KEY } }))),
    {},
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await handlers["set-global-state"]({ params: { key: SETTINGS_KEY, value: true } }))),
    { success: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await handlers["get-global-state"]({ params: { key: SETTINGS_KEY } }))),
    { value: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(await handlers["set-global-state"]({ params: { key: BOOT_ONLY_SETTINGS_KEY, value: true } }))),
    { success: true },
  );
  await assert.rejects(handlers["get-global-state"]({ params: { key: "setting" } }), /Unsupported global-state key/);
  await assert.rejects(handlers["set-global-state"]({ params: { key: "setting", value: true } }), /Unsupported global-state key/);
  assert.equal(values.has("setting"), false);
});

test("all three features compose their owned global-state keys in every patch order", async () => {
  const patches = [applyMainPatch, applyReadAloudMainBundlePatch, applyAgentWorkspaceMainBridgePatch];
  const orders = [
    [patches[0], patches[1], patches[2]],
    [patches[0], patches[2], patches[1]],
    [patches[1], patches[0], patches[2]],
    [patches[1], patches[2], patches[0]],
    [patches[2], patches[0], patches[1]],
    [patches[2], patches[1], patches[0]],
  ];
  const allowedKeys = [
    SETTINGS_KEY,
    BOOT_ONLY_SETTINGS_KEY,
    "codex-linux-read-aloud-enabled",
    "codex-linux-read-aloud-kokoro-speed",
    AGENT_WORKSPACE_COMMAND_KEY,
    AGENT_WORKSPACE_PERMISSIONS_KEY,
  ];
  for (const order of orders) {
    const patched = order.reduce((source, patch) => patch(source), startupFixture());
    assert.equal(order.reduce((source, patch) => patch(source), patched), patched);
    assert.equal(patched.split('"get-global-state":async').length - 1, 1);
    assert.equal(patched.split('"set-global-state":async').length - 1, 1);
    const IpcHost = new Function("require", "process", `${patched};return IpcHost;`)(require, {
      platform: "linux",
      env: {},
    });
    const values = new Map();
    let reads = 0;
    let writes = 0;
    const host = new IpcHost();
    host.globalState = {
      get(key) {
        reads += 1;
        return values.get(key);
      },
      set(key, value) {
        writes += 1;
        values.set(key, value);
      },
    };
    const handlers = host.handlers;
    for (const key of allowedKeys) {
      assert.deepEqual(await handlers["set-global-state"]({ params: { key, value: key } }), { success: true });
      assert.deepEqual(await handlers["get-global-state"]({ params: { key } }), { value: key });
    }
    assert.equal(reads, allowedKeys.length);
    assert.equal(writes, allowedKeys.length);
    await assert.rejects(handlers["get-global-state"]({ params: { key: "setting" } }), /Unsupported global-state key/);
    await assert.rejects(handlers["set-global-state"]({ params: { key: "setting", value: true } }), /Unsupported global-state key/);
    assert.equal(reads, allowedKeys.length);
    assert.equal(writes, allowedKeys.length);
    assert.equal(values.has("setting"), false);
  }
});

test("main patch fails closed when the global-state handler owner is missing or duplicated", () => {
  const source = startupFixture();
  const missing = source.replace('"set-remote-wsl-connections-enabled":', '"changed-handler":');
  const duplicate = source + 'class OtherIpcHost{handlers(){return {"set-remote-wsl-connections-enabled":async()=>({})}}}';
  for (const drift of [missing, duplicate]) {
    const result = captureWarnings(() => applyMainPatch(drift));
    assert.equal(result.value, drift);
    assert.deepEqual(result.warnings, ["WARN: Start minimized to tray global-state handler owner missing or ambiguous"]);
  }
});

async function runStartup({ preference = true, onlyOnBoot = false, env = {}, cgroup = "0::/user.slice/app.slice/app-codex.scope\n", platform = "linux", argv = ["ChatGPT"], ready = true, existing = false, setup = Promise.resolve(), beforeFinish = null, background = false, upstreamBackground = false } = {}) {
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
    ensureWindow: async ({background = false} = {}) => {
      if (primary && !background) { primary.show(); primary.focus(); }
      else primary = mockWindow;
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
    U, eR5: true, eR2: { isReady: () => ready }, setup, beforeFinish, launch: { isBackgroundLaunch: upstreamBackground },
    We: { deepLinks: { isWakeOnlyLaunch: () => false, queueProcessArgs: () => true } }, eX: false,
    L: platform === "win32", xe: false, noop: () => {}, __dirname: "/bundle",
    Ce: async () => mockWindow, _e: { handleInitialWindowVisible: () => calls.push("attribution") },
    setTimeout, clearTimeout,
    w: callback => { context.secondInstanceArgs = callback; },
  };
  const patched = applyMainPatch(startupFixture());
  assert.notEqual(patched, startupFixture());
  const handlers = await vm.runInNewContext(`${patched};startup(launch)`, context);
  return { calls, handlers, secondInstanceArgs: context.secondInstanceArgs };
}

test("hidden cold launch avoids show/focus and attribution, even with an existing window", async () => {
  for (const existing of [false, true]) {
    const { calls, handlers } = await runStartup({ existing });
    assert.deepEqual(calls, []);
    await handlers.trayOpen("/", {});
    assert.deepEqual(calls, ["hideHotkey", "show", "attribution", "focus"]);
  }
});

test("current background guards suppress progress windows until interactive activation", async () => {
  const hidden = await runStartup();
  for (const guard of [hidden.handlers.shouldShow, hidden.handlers.backfill, hidden.handlers.progress]) {
    assert.equal(guard(), false);
  }
  hidden.handlers.interactive();
  assert.deepEqual(hidden.calls, ["show", "attribution", "focus"]);
  for (const guard of [hidden.handlers.shouldShow, hidden.handlers.backfill, hidden.handlers.progress]) {
    assert.equal(guard(), true);
  }
  const visible = await runStartup({ preference: false });
  assert.equal(visible.handlers.shouldShow(), true);
  assert.equal(visible.handlers.progress(), true);
});

test("upstream background-launch state remains independent from the feature preference", async () => {
  for (const preference of [false, true]) {
    const background = await runStartup({ preference, upstreamBackground: true });
    assert.deepEqual(background.calls, []);
    assert.equal(background.handlers.shouldShow(), false);
    await background.handlers.secondInstance();
    assert.deepEqual(background.calls, ["hideHotkey", "show", "attribution", "focus"]);
    // Clearing our preference decision cannot rewrite upstream launch state.
    assert.equal(background.handlers.shouldShow(), false);
    assert.equal(background.handlers.backfill(), false);
  }
});

test("second launch reveals the hidden window through the upstream handler", async () => {
  const { calls, handlers } = await runStartup();
  await handlers.secondInstance();
  assert.deepEqual(calls, ["hideHotkey", "show", "attribution", "focus"]);
});

test("boot-only works independently, overrides all-starts preference, and leaves manual starts visible", async () => {
  for (const preference of [true, false, null]) {
    assert.deepEqual((await runStartup({ preference, onlyOnBoot: true })).calls, ["show", "attribution", "focus"]);
    for (const marker of [
      { argv: ["ChatGPT", "--codex-autostart", "--ozone-platform=wayland"] },
      { env: { DESKTOP_AUTOSTART_ID: "session-client" } },
      { cgroup: "0::/user.slice/user@1000.service/app.slice/app-codex\\x2ddesktop@autostart.service\n" },
      { cgroup: "1:name=systemd:/user.slice/app-other@autostart.service/child\n0::/other\n" },
    ]) {
      const hidden = await runStartup({ preference, onlyOnBoot: true, ...marker });
      assert.deepEqual(hidden.calls, []);
      await hidden.handlers.secondInstance();
      assert.deepEqual(hidden.calls, ["hideHotkey", "show", "attribution", "focus"]);
    }
  }
});

test("boot-only still falls back on unavailable tray, reveals on activation, and respects files and deep links", async () => {
  const options = { onlyOnBoot: true, preference: false, argv: ["ChatGPT", "--codex-autostart"] };
  const tray = await runStartup(options);
  await tray.handlers.trayOpen("/", {});
  assert.deepEqual(tray.calls, ["hideHotkey", "show", "attribution", "focus"]);
  for (const overrides of [
    { ready: false }, { platform: "win32" },
    { argv: [...options.argv, "codex://threads/123"] },
    { argv: [...options.argv, "/home/user/file.txt"] },
    { argv: ["ChatGPT"], cgroup: Error("unavailable") },
  ]) assert.deepEqual((await runStartup({ ...options, ...overrides })).calls, ["show", "attribution", "focus"]);
  for (const onlyOnBoot of [false, null, "true"]) {
    assert.deepEqual((await runStartup({ ...options, onlyOnBoot })).calls, ["show", "attribution", "focus"]);
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
    assert.deepEqual((await runStartup({ preference: false, onlyOnBoot: false, argv: args, cgroup: nativeScope })).calls, ["show", "attribution", "focus"]);
    assert.deepEqual((await runStartup({ onlyOnBoot: true, argv: [...args, "codex://threads/123"], cgroup: nativeScope })).calls, ["show", "attribution", "focus"]);
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
  assert.deepEqual(calls, ["hideHotkey", "show", "attribution", "focus"]);
  const normal = await runStartup({ preference: false });
  normal.secondInstanceArgs(["ChatGPT", "codex://threads/123"]);
  assert.deepEqual(normal.calls, ["show", "attribution", "focus"]);
});

test("tray and second-instance activation reveal an existing hidden window before host readiness", async () => {
  for (const activate of [(second) => second(), (_, tray) => tray("/", {})]) {
    const { calls } = await runStartup({ beforeFinish: activate });
    assert.deepEqual(calls, ["hideHotkey", "show", "attribution", "focus"]);
  }
  const { calls } = await runStartup({ preference: false, beforeFinish: (second) => second() });
  assert.deepEqual(calls, ["show", "attribution", "focus", "hideHotkey", "show", "attribution", "focus"]);
});

test("saved maximization waits for explicit reveal instead of showing a hidden startup window", () => {
  const Manager = vm.runInNewContext(`${applyMainPatch(startupFixture())};WindowManager`, {setTimeout,clearTimeout});
  for (const hidden of [true, false]) {
    const events = new Map(), calls = [];
    const window = { once: (name, callback) => events.set(name, callback), isDestroyed:()=>false,
      isVisible:()=>!hidden, maximize:()=>calls.push("maximize") };
    const manager = new Manager();
    manager.install(window, true);
    events.get("ready-to-show")();
    assert.deepEqual(calls, hidden ? [] : ["maximize"]);
    if (hidden) { events.get("show")(); assert.deepEqual(calls, ["maximize"]); }
  }
});

function windowModeHarness(hidden, initiallyVisible = !hidden) {
  const calls = [], events = new Map();
  let visible = initiallyVisible, destroyed = false, maximized = true;
  const window = {
    id: 1, isDestroyed: () => destroyed, isVisible: () => visible,
    once: (name, callback) => { events.set(name, [...(events.get(name) ?? []), callback]); },
    show: () => { calls.push("show"); visible = true; }, focus: () => calls.push("focus"),
    getNormalBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    isMaximized: () => maximized, isFullScreen: () => false,
    unmaximize: () => { calls.push("unmaximize"); maximized = false; },
    maximize: () => { calls.push("maximize"); maximized = true; visible = true; },
    setFullScreen: () => { calls.push("fullscreen"); visible = true; },
  };
  for (const method of ["setResizable", "setMaximizable", "setFullScreenable", "setMinimumSize", "setSize", "center", "setBounds"]) {
    window[method] = () => calls.push(method);
  }
  const manager = { codexLinuxStartMinimized: hidden, getPrimaryWindow: () => window,
    getPrimaryMinimumSize: () => ({ width: 500, height: 500 }),
    syncPrimaryMinimumSize: () => calls.push("syncPrimaryMinimumSize") };
  const context = {
    ea: { BrowserWindow: { fromWebContents: () => window }, screen: { getDisplayMatching: () => ({ workAreaSize: { width: 1280, height: 800 } }) } },
    ra: () => (a, b) => JSON.stringify(a) === JSON.stringify(b),
    process: { platform: "linux" }, setTimeout, clearTimeout,
  };
  const Handler = vm.runInNewContext(`${applyMainPatch(startupFixture())};MessageHandler`, context);
  const handler = new Handler(); handler.windowManager = manager; handler.shouldShowPrimaryWindow = () => true;
  const emit = name => { const callbacks = events.get(name) ?? []; events.delete(name); callbacks.forEach(fn => fn()); };
  return { handler, calls, events,
    setMode: mode => handler.setPrimaryWindowMode({}, mode),
    reveal: () => { manager.codexLinuxStartMinimized = false; visible = true; emit("show"); },
    close: () => { destroyed = true; emit("closed"); } };
}

test("late renderer app/onboarding mode never reveals or resizes the hidden startup window", () => {
  for (const mode of [{ mode: "app" }, { mode: "onboarding", onboardingVariant: "v2" }]) {
    const h = windowModeHarness(true);
    h.setMode(mode);
    assert.deepEqual(h.calls, []);
    assert.equal(h.handler.primaryWindowMode, undefined);
    h.reveal();
    assert.deepEqual(JSON.parse(JSON.stringify(h.handler.primaryWindowMode)), mode);
    assert.ok(h.calls.includes(mode.mode === "app" ? "syncPrimaryMinimumSize" : "setSize"));
    assert.equal(h.calls.includes("show"), false);
    h.setMode({ mode: "app" });
    assert.ok(h.calls.includes("syncPrimaryMinimumSize"));
  }
});

test("mode updates coalesce until reveal, including transitions from saved onboarding geometry", () => {
  const h = windowModeHarness(true);
  h.handler.primaryWindowRestoreBounds = { bounds: { x: 0, y: 0, width: 1000, height: 700 }, wasMaximized: true, wasFullScreen: true };
  h.setMode({ mode: "onboarding" });
  h.setMode({ mode: "app" });
  assert.deepEqual(h.calls, []);
  assert.equal(h.events.get("show").length, 1);
  h.reveal();
  assert.ok(h.calls.includes("maximize"));
  assert.ok(h.calls.includes("fullscreen"));
  assert.equal(h.calls.includes("setSize"), false);
  assert.equal(h.handler.codexLinuxStartMinimizedWindowMode, null);
});

test("disabled feature state preserves the renderer mode behavior and destroyed windows discard deferred state", () => {
  const visible = windowModeHarness(false);
  visible.setMode({ mode: "app" });
  assert.deepEqual(visible.calls, ["setResizable", "setMaximizable", "setFullScreenable", "syncPrimaryMinimumSize"]);
  const normalHidden = windowModeHarness(false, false);
  normalHidden.setMode({ mode: "app" });
  assert.deepEqual(normalHidden.calls.slice(-2), ["show", "focus"]);
  const closed = windowModeHarness(true);
  closed.setMode({ mode: "app" });
  closed.close();
  assert.equal(closed.handler.codexLinuxStartMinimizedWindowMode, null);
  closed.reveal();
  assert.deepEqual(closed.calls, []);
});

test("disabled/unset/invalid preference, non-Linux, files, and URIs preserve visible startup", async () => {
  for (const options of [
    { preference: false }, { preference: null }, { preference: "true" },
    { platform: "win32" }, { platform: "darwin" },
    { argv: ["ChatGPT", "codex://threads/123"] },
    { argv: ["ChatGPT", "/home/user/file.txt"] },
  ]) {
    const { calls } = await runStartup(options);
    assert.deepEqual(calls, ["show", "attribution", "focus"]);
  }
  assert.deepEqual((await runStartup({ preference: false, background: true })).calls,
    ["showInactive", "attribution"]);
  assert.deepEqual((await runStartup({ argv: ["ChatGPT", "--ozone-platform=wayland"] })).calls, []);
});

test("failed or unavailable tray leaves the window visible", async () => {
  const rejection = Promise.reject(Error("no tray"));
  rejection.catch(() => {});
  for (const options of [{ ready: false }, { setup: rejection, ready: false }]) {
    assert.deepEqual((await runStartup(options)).calls, ["show", "attribution", "focus"]);
  }
});

test("activation during startup cancels the hidden decision before final reveal", async () => {
  // A second-instance activation arrives while asynchronous tray setup waits.
  let activate;
  let finishTray;
  const setup = new Promise(resolve => { finishTray = resolve; });
  const patched = applyMainPatch(startupFixture()).replace("let codexLinuxStartMinimizedTraySetup=", "activate=()=>Je();let codexLinuxStartMinimizedTraySetup=");
  const calls = [];
  const window = { show:()=>calls.push("show"), focus:()=>{}, isMinimized:()=>false, isDestroyed:()=>false, once(){} };
  const context = { process:{platform:"linux",argv:["ChatGPT"],env:{}},m:{O:async()=>({globalState:{getStored:key=>key===SETTINGS_KEY}})},
    U:{windowManager:{},ensureWindow:async()=>window,getPrimaryWindow:()=>null,hotkeyWindowLifecycleManager:{hide(){}}},
    eR5:true,eR2:{isReady:()=>true},We:{deepLinks:{isWakeOnlyLaunch:()=>false,queueProcessArgs:()=>true}},eX:false,L:false,xe:false,setup,Ce:async()=>null,noop(){},__dirname:"/",_e:{handleInitialWindowVisible(){}},
    setTimeout,clearTimeout,beforeFinish:null,w(){},set activate(value){activate=value;} };
  const running = vm.runInNewContext(`${patched};startup()`,context);
  await new Promise(resolve=>setImmediate(resolve));
  await activate();
  finishTray();
  await running;
  assert.deepEqual(calls,["show"]);
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
  const reapplied = captureWarnings(() => applyMainPatch(patched));
  assert.equal(reapplied.value, patched);
  assert.deepEqual(reapplied.warnings, []);
  const renamed = source.replaceAll("Ke", "bgAlias").replaceAll("qe", "showAlias").replaceAll("U.", "serviceAlias.");
  assert.notEqual(applyMainPatch(renamed), renamed);
  for (const drift of [source + source, patched + source, patched + patched,
    patched.replace("if(this.windowManager.codexLinuxStartMinimized===!0", "if(this.windowManager.codexLinuxStartMinimized===!1"),
    patched.replace("codexLinuxStartMinimizedPreference(V.globalState)", "codexLinuxStartMinimizedPreference(other.globalState)"),
    patched.replace("only-on-boot", "changed-boot-key"),
    patched.replace("codexLinuxStartMinimized=!1;", "codexLinuxStartMinimized=!0;"),
    patched.replace("e.onInteractiveLaunch=()=>{", "e.onInteractiveLaunch=()=>{};changed=()=>{"),
    source + "e.isBackgroundLaunch;",
    source.replace("CODEX_ELECTRON_START_IN_BACKGROUND", "CHANGED"),
    source.replace("canHideLastWindowToTray", "changed"), source.replace("gt===st||", "gt!==st||"),
    source.replace("moduleDir:__dirname", "moduleDir:changed"), source.replace("Ye=async", "Ye=changed"),
    source.replace("setPrimaryWindowMode(e,t){", "setPrimaryWindowMode(e,other){"),
    source.replace("this.windowManager.syncPrimaryMinimumSize()", "this.windowManager.changed()"),
    source.replace("F.isVisible()?e()", "F.isVisible()?changed()"),
    source.replace("shouldShow:()=>!e.isBackgroundLaunch", "shouldShow:()=>false"),
    source.replace("if(!this.shouldShowPrimaryWindow()", "if(this.shouldShowPrimaryWindow()")]) {
    const result = captureWarnings(() => applyMainPatch(drift));
    assert.equal(result.value, drift);
    assert.equal(result.warnings.length, 1);
  }
});

test("partial startup declarations are rejected before inserting another feature copy", () => {
  const source = startupFixture();
  for (const declaration of [
    "codexLinuxStartMinimizedPreferences=codexLinuxStartMinimizedPreference(V.globalState),",
    "codexLinuxStartMinimizedPreferences={},codexLinuxStartMinimized=!0,",
    "codexLinuxStartMinimizedRequested=!0,",
  ]) {
    const partial = source.replace("let V=await (0,m.O)({moduleDir:__dirname}),",
      `let V=await (0,m.O)({moduleDir:__dirname}),${declaration}`);
    const result = captureWarnings(() => applyMainPatch(partial));
    assert.equal(result.value, partial);
    assert.deepEqual(result.warnings, ["WARN: Start minimized to tray patched startup contract missing or ambiguous"]);
    assert.equal(result.value.includes("function codexLinuxStartMinimizedTrayReady("), false);
  }
});

test("complete patched startup validates renderer replay, readiness and each activation reset", () => {
  const patched = applyMainPatch(startupFixture());
  const replacements = [
    ["pending.mode=t;return", "return"],
    ["webContents:e,mode:t", "webContents:other,mode:t"],
    ["this.setPrimaryWindowMode(pending.webContents,pending.mode)", "this.setPrimaryWindowMode(pending.webContents,other)"],
    ["if(this.codexLinuxStartMinimizedWindowMode?.window===r)this.codexLinuxStartMinimizedWindowMode=null", "this.codexLinuxStartMinimizedWindowMode=null"],
    ["U.windowManager.codexLinuxStartMinimized=codexLinuxStartMinimized;", ""],
    ["codexLinuxStartMinimized=codexLinuxStartMinimized&&ready", "codexLinuxStartMinimized=ready"],
    ["if(!xe&&(!codexLinuxStartMinimizedRequested||U.getPrimaryWindow()==null))", "if(!xe)"],
    ["(n||codexLinuxStartMinimizedRequested)&&Je()", "n&&Je()"],
  ];
  const partials = replacements.map(([needle, replacement]) => {
    assert.equal(patched.split(needle).length, 2, needle);
    return patched.replace(needle, replacement);
  });
  const clear = "codexLinuxStartMinimized=!1;U.windowManager.codexLinuxStartMinimized=!1;";
  const resets = [...patched.matchAll(new RegExp(clear.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))];
  assert.equal(resets.length, 3);
  for (const reset of resets) {
    partials.push(patched.slice(0, reset.index) + "codexLinuxStartMinimized=!1;" + patched.slice(reset.index + clear.length));
  }
  for (const partial of partials) {
    const result = captureWarnings(() => applyMainPatch(partial));
    assert.equal(result.value, partial);
    assert.deepEqual(result.warnings, ["WARN: Start minimized to tray patched startup contract missing or ambiguous"]);
  }
  const renamed = patched.replaceAll("U.", "serviceAlias.").replaceAll("qe", "showAlias");
  const valid = captureWarnings(() => applyMainPatch(renamed));
  assert.equal(valid.value, renamed);
  assert.deepEqual(valid.warnings, []);
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

test(
  "startup patch changes exactly one current signed main-process chunk and stays idempotent",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
    const chunks = fs.readdirSync(buildDir).filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name));
    const changed = [];
    for (const name of chunks) {
      const source = fs.readFileSync(path.join(buildDir, name), "utf8");
      const result = captureWarnings(() => applyMainPatch(source));
      if (result.value === source) {
        assert.equal(result.warnings.length, 1, name);
        continue;
      }
      assert.deepEqual(result.warnings, [], name);
      new vm.Script(result.value, { filename: name });
      assert.equal(result.value.split("codexLinuxStartMinimizedRequested=codexLinuxStartMinimized,").length, 2);
      const reapplied = captureWarnings(() => applyMainPatch(result.value));
      assert.equal(reapplied.value, result.value);
      assert.deepEqual(reapplied.warnings, []);
      changed.push(name);
    }
    assert.equal(changed.length, 1);
  },
);
