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
  SETTINGS_KEY, BOOT_ONLY_SETTINGS_KEY, ROUTE_URL, applyMainPatch, applySettingsPatch, settingComponent,
  settingsPostSource, codexLinuxStartMinimizedRoute,
  codexLinuxStartMinimizedTrayReady, codexLinuxStartMinimizedAutostart,
  LABEL_IDS, LABEL_TRANSLATIONS, DESCRIPTION_IDS, DESCRIPTION_TRANSLATIONS,
} = require("./patch.js");
const { applyAgentWorkspaceMainBridgePatch } = require("../agent-workspace/patch.js");
const { applyMainBundlePatch: applyReadAloudMainBundlePatch } = require("../read-aloud/patch.js");

// Signed stable 26.1103.31037 (rspack) startup and view-message contracts, with
// Electron services supplied by the harness. This exercises the actual patched
// control flow and the preference route.
const windowModeFixture = 'class MessageHandler{' + "setPrimaryWindowMode(e,t){let r=ea.BrowserWindow.fromWebContents(e);if(!r||r.isDestroyed())return;let n=this.windowManager.getPrimaryWindow();if(!n||n.isDestroyed()||n.id!==r.id)return;if(!this.shouldShowPrimaryWindow()&&!r.isVisible())return void r.once(\"show\",()=>this.setPrimaryWindowMode(e,t));let i=\"onboarding\"!==t.mode?null:\"v2\"===t.onboardingVariant?{width:1090,height:760}:{width:560,height:560};if(ra()(this.primaryWindowMode,t)){null!=i&&this.showPrimaryWindow(r);return}if(this.primaryWindowMode=t,null!=i){null==this.primaryWindowRestoreBounds&&(this.primaryWindowRestoreBounds={bounds:r.getNormalBounds(),wasMaximized:r.isMaximized(),wasFullScreen:r.isFullScreen()}),r.isFullScreen()&&r.setFullScreen(!1),r.isMaximized()&&r.unmaximize(),r.setResizable(!0);let e=ea.screen.getDisplayMatching(r.getNormalBounds()).workAreaSize,t=\"win32\"===process.platform?{width:Math.max(0,r.getBounds().width-r.getContentBounds().width),height:Math.max(0,r.getBounds().height-r.getContentBounds().height)}:{width:0,height:0},n={width:e.width-t.width,height:e.height-t.height},s={width:Math.min(i.width,n.width),height:Math.min(i.height,n.height)},a=\"win32\"===process.platform,o=a&&(s.width>=.9*n.width||s.height>=.9*n.height),l=this.windowManager.getPrimaryMinimumSize();r.setMaximizable(a),r.setFullScreenable(!1),r.setMinimumSize(Math.min(l.width,s.width),Math.min(l.height,s.height)),r.setSize(s.width,s.height),o||r.center(),this.showPrimaryWindow(r),o&&r.maximize();return}if(r.setResizable(!0),r.setMaximizable(!0),r.setFullScreenable(!0),this.primaryWindowRestoreBounds){let{bounds:e,wasMaximized:t,wasFullScreen:n}=this.primaryWindowRestoreBounds;this.primaryWindowRestoreBounds=null;let i=this.windowManager.getPrimaryMinimumSize();r.setMinimumSize(i.width,i.height);let s={...e,width:Math.max(e.width,i.width),height:Math.max(e.height,i.height)};r.isMaximized()&&r.unmaximize(),r.setBounds(s),t&&r.maximize(),n&&r.setFullScreen(!0)}this.windowManager.syncPrimaryMinimumSize(),this.showPrimaryWindow(r)}showPrimaryWindow(e){e.isVisible()||(e.show(),e.focus())}" + '}';

function startupFixture() {
  return windowModeFixture + `class FetchWrapper{options;constructor(e){this.options=e}async handleRequest(e,t){if("/codex/dictation-stream-connect-info"===t.url)return void await this.handleDictationStreamConnectInfoRequest(e,t);throw Error("HTTP requests must use the HTTP fetch service.")}async handleDictationStreamConnectInfoRequest(e,t){this.options.chunkedMessageSender.sendInlineMessageForView(e,{type:"fetch-response",responseType:"success",requestId:t.requestId,status:200,headers:{"content-type":"application/json"},bodyJsonString:"{}"})}cancelRequest(){}}
class ViewMessageHandler{hostId;windowManager;chunkedMessageSender;fetchWrapper;globalState;constructor(e,t,r){this.fetchWrapper=e,this.globalState=t,this.chunkedMessageSender=r}async handleMessage(e,t){switch(t.type){case"mcp-response":break;case"fetch":await this.fetchWrapper.handleRequest(e,t);break;case"cancel-fetch":this.fetchWrapper.cancelRequest(e,t);break;case"show-diff":break}}}
class WindowManager{install(F,x){if(x){this.pendingRestoredMaximization=new Set;this.pendingRestoredMaximization.add(F);let e=()=>{F.isDestroyed()||(F.maximize(),this.pendingRestoredMaximization.delete(F))};F.once("ready-to-show",()=>{F.isDestroyed()||(F.isVisible()?e():F.once("show",e))})}}}
function eR7(){return eR5&&eR2?.isReady()===!0}
async function startup(e={isBackgroundLaunch:false}){let V=await (0,m.O)({moduleDir:__dirname}),unused=0;
let options={canHideLastWindowToTray:eR7,isRemoteHostedPIPEnabled:noop,shouldShowPrimaryWindow:()=>!e.isBackgroundLaunch};
let Ke="1"===process.env.CODEX_ELECTRON_START_IN_BACKGROUND,qe=(e,t=!0)=>{if(!t){e.showInactive(),_e.handleInitialWindowVisible();return}e.isMinimized()&&e.restore(),e.show(),_e.handleInitialWindowVisible(),e.focus()},Je=async(e,t)=>{try{U.hotkeyWindowLifecycleManager.hide();let t=U.getPrimaryWindow()??await Ce("/");if(null==t)return;qe(t)}catch(e){throw e}},Ye=async(e,t)=>{let r=await (async(e,t)=>{if(!xe)return null;U.hotkeyWindowLifecycleManager.hide();let n=U.getPrimaryWindow(),r=n??await Ce(e);return null==r?null:(qe(r),r)})(e,t);return r},Qe=()=>setup;(L||"linux"===process.platform)&&Qe();
let st=We.deepLinks.isWakeOnlyLaunch()&&!eX?null:await U.ensureWindow({background:e.isBackgroundLaunch});st?.once("show",()=>{_e.handleInitialWindowVisible()}),null==st||e.isBackgroundLaunch||qe(st,!Ke);
e.onInteractiveLaunch=()=>{null==st||st.isDestroyed()||qe(st),noop()};
let backfill={shouldShow:()=>!e.isBackgroundLaunch&&!We.deepLinks.isWakeOnlyLaunch()},progress={shouldShow:()=>!e.isBackgroundLaunch&&!We.deepLinks.isWakeOnlyLaunch()};
await beforeFinish?.(Je,Ye,e.onInteractiveLaunch);
let gt=st;if(null==gt&&(!We.deepLinks.isWakeOnlyLaunch()||eX)?gt=await U.ensureWindow({background:e.isBackgroundLaunch}):gt?.isDestroyed()&&(gt=null),gt){gt!==st&&gt.once("show",()=>{_e.handleInitialWindowVisible()}),gt===st||e.isBackgroundLaunch||qe(gt,!Ke)}
xe=!0,w(e=>{let n=!1;if(We.deepLinks.queueProcessArgs(e)){n&&Je();return}n?Je():Je({channel:"shortcut"})});
return {secondInstance:Je,trayOpen:Ye,interactive:e.onInteractiveLaunch,shouldShow:options.shouldShowPrimaryWindow,backfill:backfill.shouldShow,progress:progress.shouldShow};}`;
}

function viewMessageHarness(patched, values = new Map()) {
  const { FetchWrapper, ViewMessageHandler } = new Function("require", "process",
    `${patched};return{FetchWrapper,ViewMessageHandler};`)(require, { platform: "linux", env: {} });
  const responses = [], forwarded = [];
  const sender = { sendInlineMessageForView: (webContents, message) => responses.push({ webContents, message }) };
  const wrapper = new FetchWrapper({ chunkedMessageSender: sender });
  const handleRequest = wrapper.handleRequest.bind(wrapper);
  wrapper.handleRequest = async (webContents, request) => { forwarded.push(request.url); return handleRequest(webContents, request); };
  const globalState = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const handler = new ViewMessageHandler(wrapper, globalState, sender);
  let serial = 0;
  const request = async (body, url = ROUTE_URL) => {
    const requestId = `request-${++serial}`, webContents = { id: serial };
    await handler.handleMessage(webContents, { type: "fetch", requestId, method: "POST", url,
      body: typeof body === "string" ? body : JSON.stringify(body) });
    const response = responses.find(entry => entry.message.requestId === requestId);
    assert.equal(response?.webContents, webContents);
    return JSON.parse(JSON.stringify(response.message));
  };
  return { request, values, forwarded };
}

const success = body => ({ type: "fetch-response", responseType: "success", status: 200,
  headers: { "content-type": "application/json" }, bodyJsonString: JSON.stringify(body) });

test("main patch answers only the owned preference route in the view-message handler", async () => {
  const patched = applyMainPatch(startupFixture());
  assert.equal(patched.split("/*codex-linux-start-minimized-to-tray-route*/").length, 2);
  const harness = viewMessageHarness(patched);
  const strip = ({ requestId, ...message }) => message;
  assert.deepEqual(strip(await harness.request({ action: "get", key: SETTINGS_KEY })), success({}));
  assert.deepEqual(strip(await harness.request({ action: "set", key: SETTINGS_KEY, value: true })), success({ success: true }));
  assert.deepEqual(strip(await harness.request({ action: "get", key: SETTINGS_KEY })), success({ value: true }));
  assert.deepEqual(strip(await harness.request({ action: "set", key: BOOT_ONLY_SETTINGS_KEY, value: "true" })), success({ success: true }));
  assert.equal(harness.values.get(BOOT_ONLY_SETTINGS_KEY), false);
  for (const [body, error] of [
    [{ action: "get", key: "setting" }, /Unsupported start minimized to tray preference/],
    [{ action: "set", key: "setting", value: true }, /Unsupported start minimized to tray preference/],
    [{ action: "delete", key: SETTINGS_KEY }, /Unsupported start minimized to tray action/],
    ["{", /Invalid start minimized to tray request/],
  ]) {
    const response = await harness.request(body);
    assert.equal(response.responseType, "error");
    assert.equal(response.status, 500);
    assert.match(response.error, error);
  }
  assert.equal(harness.values.has("setting"), false);
  assert.deepEqual(harness.forwarded, []);
  const dictation = await harness.request({}, "/codex/dictation-stream-connect-info");
  assert.equal(dictation.responseType, "success");
  assert.deepEqual(harness.forwarded, ["/codex/dictation-stream-connect-info"]);
});

function permutations(items) {
  return items.length <= 1 ? [items] : items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

// account-switcher shape: a helper declaring its own class is injected into a
// view-message handler method ahead of the "fetch" case, so the nearest
// "class " keyword no longer names the handler.
function injectHandlerHelperClass(source) {
  const helper = "this.codexLinuxFixtureHelper??=(function(){class SwitcherError extends Error{}return SwitcherError})();";
  return source.includes(helper) ? source : source.replace("async handleMessage(e,t){", `async handleMessage(e,t){${helper}`);
}

test("the preference route composes with other Linux fetch routes and handler helpers in every patch order", async () => {
  const patches = [applyMainPatch, applyReadAloudMainBundlePatch, applyAgentWorkspaceMainBridgePatch, injectHandlerHelperClass];
  for (const order of permutations([0, 1, 2, 3])) {
    const apply = source => order.reduce((current, index) => {
      const result = captureWarnings(() => patches[index](current));
      assert.deepEqual(result.warnings, [], `${order.join()}: ${index}`);
      return result.value;
    }, source);
    const patched = apply(startupFixture());
    assert.equal(apply(patched), patched, order.join());
    for (const marker of ["/*codex-linux-start-minimized-to-tray-route*/", "/*codex-linux-read-aloud-route*/", "/*codex-linux-agent-workspace-route*/"]) {
      assert.equal(patched.split(marker).length, 2, `${order.join()}: ${marker}`);
    }
    const harness = viewMessageHarness(patched);
    assert.equal((await harness.request({ action: "set", key: SETTINGS_KEY, value: true })).responseType, "success");
    assert.equal(harness.values.get(SETTINGS_KEY), true, order.join());
  }
});

test("main patch fails closed when the fetch route owner is missing, duplicated or unrecognized", () => {
  const source = startupFixture();
  const forward = 'case"fetch":await this.fetchWrapper.handleRequest(e,t);break;case"cancel-fetch":';
  for (const drift of [
    source.replace(forward, 'case"fetch":await this.fetchWrapper.handleRequest(e,t);break;case"other":'),
    source + `class OtherHandler{fetchWrapper;globalState;chunkedMessageSender;handle(e,t){switch(t.type){${forward}}}}`,
    source.replace("fetchWrapper;globalState;", "fetchWrapper;"),
    source.replace(forward, 'case"fetch":log(t);await this.fetchWrapper.handleRequest(e,t);break;case"cancel-fetch":'),
  ]) {
    const result = captureWarnings(() => applyMainPatch(drift));
    assert.equal(result.value, drift);
    assert.deepEqual(result.warnings, ["WARN: Start minimized to tray fetch route owner missing or ambiguous"]);
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

test("an explicit desktop New Window launch opens visibly with tray startup enabled", async () => {
  const argv = ["ChatGPT", "--codex-community-new-window"];
  const regular = await runStartup({ argv });
  const autostart = await runStartup({ onlyOnBoot: true, argv: [...argv, "--codex-autostart"] });
  for (const { calls } of [regular, autostart]) {
    assert.deepEqual(calls, ["show", "attribution", "focus"]);
  }
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

// Shapes of the signed 26.1103.31037 rspack General settings chunk, locale
// loader and catalog chunks.
function settingsFixture() {
  return 'export const __rspack_esm_id=572868;export const __rspack_esm_ids=[572868];export const __webpack_modules__={' +
    'G3wX(e,t,a){let s;a.d(t,{GeneralSettings:()=>aR});var n=a("ABep"),r=a("QosV"),m=a("zd8w"),x=a("oyxz"),b=a("Wf1j"),ed=a("iRMi"),F=a("RxZZ"),f=a("DBCl"),N=a("F0xz"),P=a("AWNZ");' +
    'function aJ(e){let t,a,s,i,o,l,c=(0,r.c)(15),{appName:d}=e,h=(0,b.A)(),{platform:p}=(0,ed.V)(),m=(0,F.iK)(f.U6S.macMenuBarEnabled);if("macOS"!==p)return null;' +
    't=(0,n.jsx)(x.A,{id:"settings.general.macMenuBar.label"}),a=(0,n.jsx)(x.A,{id:"settings.general.macMenuBar.description",values:{appName:d}});let y=!1!==m;' +
    'i=h.formatMessage({id:"settings.general.macMenuBar.ariaLabel",defaultMessage:"Show {appName} in the menu bar"},{appName:d}),o=(0,n.jsx)(N.l,{checked:y,onChange:s,ariaLabel:i}),l=(0,n.jsx)(P.ic,{label:t,description:a,control:o});return l}' +
    'function a1(){let[e,t]=(0,m.useState)(!1);return e}' +
    'function aR(){return(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(aJ,{appName:v.C}),(0,n.jsx)(t6,{})]})}' +
    'function az(){return(0,n.jsxs)(n.Fragment,{children:[(0,n.jsx)(aJ,{appName:"ChatGPT"}),(0,n.jsx)(aK,{})]})}' +
    '},Other(e,t,a){var q=a("zzzz")}};\n//# sourceMappingURL=572868.36a6c86221.js.map';
}

function localeLoaderFixture(locales) {
  const entries = locales.map((locale, index) =>
    `"../locales/${locale}.json":function(){return i.e(${700000 + index}).then(i.t.bind(i,"cat${index}",19))}`);
  return `export const __rspack_esm_id=496175;export const __webpack_modules__={Loc1(e,t,i){e.exports={${entries.join(",")}}}};`;
}

function catalogFixture(index) {
  return `export const __rspack_esm_id=${700000 + index};export const __rspack_esm_ids=[${700000 + index}];export const __webpack_modules__={cat${index}(e){e.exports=JSON.parse('{"settings.general.macMenuBar.label":"Existing translated toggle","unrelated":"Don\\'t \\\\"change\\\\""}')}};\n//# sourceMappingURL=${700000 + index}.abc.js.map`;
}

function evaluateCatalog(source, index) {
  const modules = new Function(source
    .replace(/^export const __rspack_esm_id=[^;]+;export const __rspack_esm_ids=[^;]+;export const __webpack_modules__=/, "return ")
    .replace(/\n\/\/# sourceMappingURL=.*$/, ""))();
  const module = { exports: {} };
  modules[`cat${index}`](module);
  return module.exports;
}

function settingsApp(t, locales = ["pl-PL"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asyncDir = path.join(root, "webview/assets/async");
  fs.mkdirSync(asyncDir, { recursive: true });
  const settings = path.join(asyncDir, "572868.36a6c86221.js");
  fs.writeFileSync(settings, settingsFixture());
  fs.writeFileSync(path.join(asyncDir, "496175.cf5ad221c1.js"), localeLoaderFixture(locales));
  const catalogs = locales.map((locale, index) => {
    const file = path.join(asyncDir, `${700000 + index}.abc.js`);
    fs.writeFileSync(file, catalogFixture(index));
    return { locale, index, file };
  });
  fs.writeFileSync(path.join(root, "webview/assets/348410.09aab3f377.js"), "export{v as __webpack_require__};");
  return { root, asyncDir, settings, catalogs };
}

test("settings patch injects both toggles into the owning module factory, is idempotent, and fails without writes", t => {
  const { root, settings, catalogs: [catalog] } = settingsApp(t);
  const source = settingsFixture(), originalCatalog = fs.readFileSync(catalog.file, "utf8");
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  const patched = fs.readFileSync(settings, "utf8");
  assert.doesNotMatch(patched, /\bimport\b/);
  assert.match(patched, /return l\}function codexLinuxStartMinimizedPost\(/);
  assert.match(patched, /\(0,ed\.V\)\(\),\[codexLinuxEnabled,codexLinuxSetEnabled\]=\(0,m\.useState\)\(!1\)/);
  assert.match(patched, /codexLinuxIntl=\(0,b\.A\)\(\)/);
  assert.match(patched, /\(0,n\.jsx\)\(P\.ic,\{label:codexLinuxLabel,/);
  assert.match(patched, /\(0,n\.jsx\)\(N\.l,\{checked:codexLinuxEnabled,/);
  for (const appName of ["v.C", '"ChatGPT"']) {
    assert.ok(patched.includes(`(0,n.jsx)(aJ,{appName:${appName}}),(0,n.jsx)(codexLinuxStartMinimizedSetting,{}),(0,n.jsx)(codexLinuxStartMinimizedBootOnlySetting,{})`), appName);
  }
  assert.ok(patched.indexOf("function codexLinuxStartMinimizedBootOnlySetting(") < patched.indexOf("},Other(e,t,a)"));
  const check = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: patched, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const patchedCatalog = fs.readFileSync(catalog.file, "utf8");
  assert.deepEqual(evaluateCatalog(patchedCatalog, 0), {
    [LABEL_IDS[0]]: LABEL_TRANSLATIONS["pl-PL"][0], [LABEL_IDS[1]]: LABEL_TRANSLATIONS["pl-PL"][1],
    [DESCRIPTION_IDS[0]]: DESCRIPTION_TRANSLATIONS["pl-PL"][0], [DESCRIPTION_IDS[1]]: DESCRIPTION_TRANSLATIONS["pl-PL"][1],
    "settings.general.macMenuBar.label": "Existing translated toggle", unrelated: 'Don\'t "change"',
  });
  assert.deepEqual(applySettingsPatch(root), { changed: false });
  assert.equal(fs.readFileSync(settings, "utf8"), patched);
  assert.equal(fs.readFileSync(catalog.file, "utf8"), patchedCatalog);
  for (const drift of [
    source.replace("},Other(e,t,a)", "},Other(e,t,a){}},Dup(e,t,a){" + source.slice(source.indexOf("function aJ"), source.indexOf("function a1")) + "}," + "Other2(e,t,a)"),
    source.replace('if("macOS"!==p)', 'if("macOS"===p)'),
    source.replaceAll("appName:v.C", "name:v.C").replaceAll('appName:"ChatGPT"', 'name:"ChatGPT"'),
    source.replace("h.formatMessage", "h.changed"),
    source.replace('m=a("zd8w"),', ""),
    source.replace("(0,m.useState)", "(0,useState)"),
  ]) {
    fs.writeFileSync(settings, drift);
    assert.throws(() => applySettingsPatch(root), /contract missing or ambiguous|asset missing or ambiguous/);
    assert.equal(fs.readFileSync(settings, "utf8"), drift);
  }
  fs.writeFileSync(settings, patched.replace("(0,n.jsx)(codexLinuxStartMinimizedBootOnlySetting,{})", ""));
  assert.throws(() => applySettingsPatch(root), /patched General settings contract missing or ambiguous/);
  fs.writeFileSync(settings, source);
  for (const drift of [
    originalCatalog.replace("cat0(e){e.exports=JSON.parse(", "cat0(e){e.exports=(0,JSON.parse)("),
    patchedCatalog.replace(LABEL_TRANSLATIONS["pl-PL"][0], "changed"),
    patchedCatalog.replace(JSON.stringify(DESCRIPTION_IDS[1]), '"missing-description"'),
  ]) {
    fs.writeFileSync(catalog.file, drift);
    assert.throws(() => applySettingsPatch(root), /contract missing or ambiguous/);
    assert.equal(fs.readFileSync(settings, "utf8"), source);
    assert.equal(fs.readFileSync(catalog.file, "utf8"), drift);
  }
});

test("settings patch rejects unknown locales, missing catalog chunks and ambiguous loaders without writes", t => {
  const { root, asyncDir, settings, catalogs: [catalog] } = settingsApp(t, ["pl-PL", "xx-XX"]);
  assert.throws(() => applySettingsPatch(root), /translations missing for xx-XX/);
  assert.equal(fs.readFileSync(settings, "utf8"), settingsFixture());
  assert.equal(fs.readFileSync(catalog.file, "utf8"), catalogFixture(0));
  fs.writeFileSync(path.join(asyncDir, "496175.cf5ad221c1.js"), localeLoaderFixture(["pl-PL"]));
  fs.renameSync(catalog.file, `${catalog.file}.moved`);
  assert.throws(() => applySettingsPatch(root), /pl-PL label catalog chunk missing or ambiguous/);
  fs.renameSync(`${catalog.file}.moved`, catalog.file);
  fs.writeFileSync(path.join(asyncDir, "1.copy.js"), localeLoaderFixture(["pl-PL"]));
  assert.throws(() => applySettingsPatch(root), /locale loader missing or ambiguous/);
  assert.equal(fs.readFileSync(settings, "utf8"), settingsFixture());
});

function postHarness({ timers = null } = {}) {
  const listeners = new Map(), sent = [], dispatched = [];
  class CustomEvent { constructor(type, { detail }) { this.type = type; this.detail = detail; } }
  const window = {
    addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    dispatchEvent: event => dispatched.push(event),
    electronBridge: { sendMessageFromView: async payload => { sent.push(payload); } },
  };
  const context = { window, CustomEvent, globalThis: null, Date: { now: () => 42 }, Promise, JSON, Error, Map,
    setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout };
  context.globalThis = context;
  const post = vm.runInNewContext(`${settingsPostSource()};codexLinuxStartMinimizedPost`, context);
  const deliver = data => (listeners.get("message") ?? []).forEach(listener => listener({ data }));
  return { post, sent, dispatched, deliver, listeners };
}

test("the settings client posts through the view bridge and resolves only its own route responses", async () => {
  const timers = [];
  const harness = postHarness({ timers: { setTimeout: callback => timers.push(callback), clearTimeout: () => {} } });
  const values = new Map();
  const pending = harness.post({ action: "set", key: SETTINGS_KEY, value: true });
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.dispatched[0].type, "codex-message-from-view");
  assert.equal(harness.dispatched[0].__codexForwardedViaBridge, true);
  const [payload] = harness.sent;
  assert.deepEqual({ ...payload, requestId: null }, { type: "fetch", requestId: null, method: "POST", url: ROUTE_URL,
    body: JSON.stringify({ action: "set", key: SETTINGS_KEY, value: true }) });
  harness.deliver({ type: "fetch-response", responseType: "success", requestId: "other", bodyJsonString: "{}" });
  codexLinuxStartMinimizedRoute(payload, { get: key => values.get(key), set: (key, value) => values.set(key, value) }, harness.deliver);
  assert.deepEqual(await pending, { success: true });
  assert.equal(values.get(SETTINGS_KEY), true);
  const failing = harness.post({ action: "get", key: "other" });
  codexLinuxStartMinimizedRoute(harness.sent[1], { get: () => true, set: () => {} }, harness.deliver);
  await assert.rejects(failing, /Unsupported start minimized to tray preference/);
  const unanswered = harness.post({ action: "get", key: SETTINGS_KEY });
  assert.equal(harness.listeners.get("message").length, 1);
  timers.at(-1)();
  await assert.rejects(unanswered, /Timed out/);
});

test("the settings client times out and forgets an unanswered request", async () => {
  const scheduled = [];
  const harness = postHarness({ timers: { setTimeout: callback => scheduled.push(callback), clearTimeout: () => {} } });
  const pending = harness.post({ action: "get", key: SETTINGS_KEY });
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  await assert.rejects(pending, /Timed out/);
  harness.deliver({ type: "fetch-response", responseType: "success", requestId: harness.sent[0].requestId, bodyJsonString: "{}" });
});

function componentHarness(post, bootOnly = false, platform = "linux", messages = {}) {
  const state = [], effects = [];
  let cursor = 0, mounted = false;
  const React = {
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], v => { state[index] = v; }]; },
    useEffect(callback) { if (!mounted) effects.push(callback); },
  };
  const context = { React, platformHook: () => ({ platform }),
    intlHook: () => ({ formatMessage: ({ id, defaultMessage }) => messages[id] ?? defaultMessage }),
    j: { jsx: (type, props) => ({ type, props }) }, Row: "row", Toggle: "toggle", codexLinuxStartMinimizedPost: post };
  const renderFn = vm.runInNewContext(`${settingComponent({row:"Row",toggle:"Toggle",react:"React",platformHook:"platformHook",jsx:"j",intlHook:"intlHook"}, bootOnly)};${bootOnly ? "codexLinuxStartMinimizedBootOnlySetting" : "codexLinuxStartMinimizedSetting"}`, context);
  const render = () => { cursor = 0; const result = renderFn(); mounted = true; return result; };
  return { render, load: async () => { effects.forEach(callback => callback()); await new Promise(resolve => setImmediate(resolve)); } };
}

test("General toggle loads and persists the profile preference, and disables while pending", async () => {
  for (const bootOnly of [false, true]) {
    const writes = [];
    const harness = componentHarness(async ({ action, key, value }) => {
      assert.equal(key, bootOnly ? BOOT_ONLY_SETTINGS_KEY : SETTINGS_KEY);
      if (action === "get") return { value: true };
      assert.equal(action, "set");
      writes.push(value); return { success: true };
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

test("every supported translation catalog gains only the two names and descriptions and remains idempotent", t => {
  const locales = Object.keys(LABEL_TRANSLATIONS);
  const { root, asyncDir, catalogs } = settingsApp(t, locales);
  const unrelated = path.join(asyncDir, "699999.abc.js");
  fs.writeFileSync(unrelated, 'export const __webpack_modules__={u(e){e.exports=JSON.parse(\'{"unrelated":true}\')}};');
  assert.deepEqual(applySettingsPatch(root), { changed: true });
  for (const { locale, index, file } of catalogs) {
    const labels = LABEL_TRANSLATIONS[locale];
    assert.deepEqual(evaluateCatalog(fs.readFileSync(file, "utf8"), index), {
      [LABEL_IDS[0]]: labels[0], [LABEL_IDS[1]]: labels[1],
      [DESCRIPTION_IDS[0]]: DESCRIPTION_TRANSLATIONS[locale][0],
      [DESCRIPTION_IDS[1]]: DESCRIPTION_TRANSLATIONS[locale][1],
      "settings.general.macMenuBar.label": "Existing translated toggle", unrelated: 'Don\'t "change"',
    }, locale);
  }
  assert.deepEqual(applySettingsPatch(root), { changed: false });
  assert.equal(fs.readFileSync(unrelated, "utf8"), 'export const __webpack_modules__={u(e){e.exports=JSON.parse(\'{"unrelated":true}\')}};');
});

test("save errors still override the translated description and retain the confirmed preference", async () => {
  const messages = Object.fromEntries(DESCRIPTION_IDS.map((id, index) => [id, DESCRIPTION_TRANSLATIONS["pl-PL"][index]]));
  for (const bootOnly of [false, true]) {
    const harness = componentHarness(async ({ action }) => {
      if (action === "get") return { value: false };
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
      const harness = componentHarness(({ action }) => action === "get" ? Promise.resolve({ value: false }) : failure(), bootOnly);
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

test(
  "signed startup chunk composes the preference route with every other Linux view-message route in both orders",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
    const descriptor = (feature, id) => require(`../${feature}/patch.js`).descriptors.find(entry => entry.id === id);
    // account-switcher injects helpers declaring their own classes into the
    // view-message handler; Chronicle and Read aloud route inside the fetch wrapper.
    const patches = [
      descriptor("account-switcher", "account-switcher-main"),
      descriptor("agent-workspace", "main-bridge"),
      descriptor("chronicle-skysight", "linux-chronicle-skysight-main-bridge"),
      descriptor("read-aloud", "main-handler"),
      descriptor("start-minimized-to-tray", "startup"),
    ];
    const markers = ["start-minimized-to-tray", "agent-workspace", "chronicle-skysight", "read-aloud"]
      .map(id => `/*codex-linux-${id}-route*/`);
    const owners = fs.readdirSync(buildDir).filter(name => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name))
      .map(name => ({ name, source: fs.readFileSync(path.join(buildDir, name), "utf8") }))
      .filter(({ source }) => source.includes('case"fetch":await this.fetchWrapper.handleRequest('));
    assert.equal(owners.length, 1);
    const [{ name, source }] = owners;
    for (const order of [patches, [...patches].reverse()]) {
      const apply = start => order.reduce((current, { id, apply: patch }) => {
        const result = captureWarnings(() => patch(current, {}));
        assert.deepEqual(result.warnings, [], id);
        return result.value;
      }, start);
      const patched = apply(source);
      for (const marker of markers) assert.equal(patched.split(marker).length, 2, marker);
      new vm.Script(patched, { filename: name });
      assert.equal(apply(patched), patched);
    }
  },
);

test(
  "settings patch changes the signed General settings chunk and every locale catalog",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  t => {
    const signed = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "start-minimized-signed-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const asyncDir = path.join(root, "webview", "assets", "async");
    fs.mkdirSync(asyncDir, { recursive: true });
    const copied = [];
    for (const name of fs.readdirSync(path.join(signed, "async")).filter(file => file.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(signed, "async", name), "utf8");
      if (['"settings.general.macMenuBar.label"', '"../locales/', ".macMenuBarEnabled"].some(needle => source.includes(needle))) {
        fs.writeFileSync(path.join(asyncDir, name), source);
        copied.push(name);
      }
    }
    assert.deepEqual(applySettingsPatch(root), { changed: true });
    const changed = copied.filter(name =>
      fs.readFileSync(path.join(asyncDir, name), "utf8") !== fs.readFileSync(path.join(signed, "async", name), "utf8"));
    assert.equal(changed.length, Object.keys(LABEL_TRANSLATIONS).length + 1);
    const settings = changed.map(name => fs.readFileSync(path.join(asyncDir, name), "utf8"))
      .filter(source => source.includes("function codexLinuxStartMinimizedSetting("));
    assert.equal(settings.length, 1);
    const check = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: settings[0], encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    assert.deepEqual(applySettingsPatch(root), { changed: false });
  },
);
