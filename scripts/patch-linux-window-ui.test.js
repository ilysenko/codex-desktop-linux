#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyKeybindsSettingsIndexPatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxBrowserUseIabVisibleOnCreatePatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxChromePluginAutoInstallPatch,
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxMenuPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayCloseSettingPatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
  isComputerUseUiEnabled,
  patchMainBundleSource,
  patchExtractedApp,
  patchPackageJson,
  patchLinuxAppUpdaterBridge,
  createPatchReport,
  corePatchDescriptors,
  detectLinuxTargetContext,
  discoverCorePatchDescriptors,
  linuxTargetSummary,
  normalizePatchDescriptors,
  parseOsRelease,
  resolveDesktopName,
} = require("./patch-linux-window-ui.js");
const {
  validateReport,
} = require("./ci/validate-patch-report.js");
const {
  applyPersistentRateLimitFooterPatch,
} = require("./patches/webview-assets.js");

const mainBundlePrefix =
  "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);";
const fileManagerBundle =
  "var lu=jl({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>il(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:uu,args:e=>il(e),open:async({path:e})=>du(e)}});function uu(){}";
const alreadyOpaqueBackgroundBundle =
  "process.platform===`linux`?{backgroundColor:e?t:n,backgroundMaterial:null}:{backgroundColor:r,backgroundMaterial:null}";
const opaqueBackgroundBundleWithDriftingGw =
  "var cM=`#00000000`,lM=`#000000`,uM=`#f9f9f9`;function OM(e){return e===`avatarOverlay`||e===`browserCommentPopup`}function jM({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return e===`win32`&&!OM(t)?n?{backgroundColor:r?lM:uM,backgroundMaterial:`none`}:{backgroundColor:cM,backgroundMaterial:`mica`}:{backgroundColor:cM,backgroundMaterial:null}}function gw(e){return e.page==null?e.snapshot.url:mw(e.page)}";
const currentOpaqueBackgroundBundle =
  "var QK=`#00000000`,$K=`#000000`,eq=`#f9f9f9`;function vq(e){return e===`avatarOverlay`||e===`browserCommentPopup`||e===`globalDictation`||e===`hotkeyWindowHome`||e===`hotkeyWindowThread`}function xq({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!vq(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?$K:eq,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!vq(t)?{backgroundColor:QK,backgroundMaterial:`mica`}:{backgroundColor:QK,backgroundMaterial:null}}";
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyPatchTwice(patchFn, source, ...args) {
  const patched = patchFn(source, ...args);
  assert.equal(patchFn(patched, ...args), patched);
  return patched;
}

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("Linux target context parses distro, package, and desktop details", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-target-"));
  try {
    const osReleasePath = path.join(tempRoot, "os-release");
    fs.writeFileSync(
      osReleasePath,
      [
        "ID=ubuntu",
        "ID_LIKE=\"debian\"",
        "VERSION_ID=\"24.04\"",
        "PRETTY_NAME=\"Ubuntu 24.04 LTS\"",
      ].join("\n"),
    );

    const target = detectLinuxTargetContext({
      env: {
        OS_RELEASE_FILE: osReleasePath,
        PATH: "",
        XDG_CURRENT_DESKTOP: "KDE:GNOME",
        XDG_SESSION_TYPE: "wayland",
        WAYLAND_DISPLAY: "wayland-0",
      },
    });

    assert.deepEqual(parseOsRelease(fs.readFileSync(osReleasePath, "utf8")).ID_LIKE, "debian");
    assert.equal(target.distro.id, "ubuntu");
    assert.deepEqual(target.distro.idLike, ["debian"]);
    assert.equal(target.distro.versionMajor, 24);
    assert.equal(target.packageFormat, "deb");
    assert.equal(target.packageManager, "apt");
    assert.equal(target.matchesId("debian"), true);
    assert.equal(target.matchesId(["ubuntu", "fedora"]), true);
    assert.equal(target.packageFormatIs("deb"), true);
    assert.equal(target.desktopMatches("kde"), true);
    assert.equal(target.desktopMatches(["plasma", "gnome"]), true);
    assert.equal(target.versionAtLeast("24.04"), true);
    assert.equal(target.versionAtLeast("24.10"), false);
    assert.equal(target.wayland, true);
    assert.match(linuxTargetSummary(target), /^ubuntu:24\.04\/deb:/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("auto-discovered core patches can target a specific Linux distro", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-core-patch-root-"));
  try {
    const patchDir = path.join(tempRoot, "gentoo", "sample");
    fs.mkdirSync(patchDir, { recursive: true });
    fs.writeFileSync(
      path.join(patchDir, "patch.js"),
      [
        "\"use strict\";",
        "module.exports = {",
        "  id: \"gentoo-only-sample\",",
        "  phase: \"main-bundle\",",
        "  ciPolicy: \"required-upstream\",",
        "  order: 30000,",
        "  appliesTo: (context) => context.linux.matchesId(\"gentoo\"),",
        "  apply: (source) => source.replace(\"codexLinuxGentooDisabled()\", \"codexLinuxGentooEnabled()\"),",
        "};",
      ].join("\n"),
    );

    const descriptors = discoverCorePatchDescriptors({ root: tempRoot });
    assert.equal(descriptors.length, 1);
    assert.equal(descriptors[0].id, "gentoo-only-sample");

    const gentoo = detectLinuxTargetContext({
      env: {
        CODEX_LINUX_TARGET_ID: "gentoo",
        CODEX_LINUX_TARGET_PACKAGE_FORMAT: "unknown",
        PATH: "",
      },
    });
    const ubuntu = detectLinuxTargetContext({
      env: {
        CODEX_LINUX_TARGET_ID: "ubuntu",
        CODEX_LINUX_TARGET_ID_LIKE: "debian",
        PATH: "",
      },
    });

    assert.match(
      captureWarns(() =>
        patchMainBundleSource("codexLinuxGentooDisabled()", null, {
          corePatchRoot: tempRoot,
          linuxTarget: gentoo,
        }),
      ).value,
      /codexLinuxGentooEnabled/,
    );
    assert.doesNotMatch(
      captureWarns(() =>
        patchMainBundleSource("codexLinuxGentooDisabled()", null, {
          corePatchRoot: tempRoot,
          linuxTarget: ubuntu,
        }),
      ).value,
      /codexLinuxGentooEnabled/,
    );

    const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-skipped-target-report-"));
    try {
      const buildDir = path.join(tempApp, ".vite", "build");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, "main.js"), "codexLinuxGentooDisabled()");
      const report = createPatchReport();
      captureWarns(() =>
        patchExtractedApp(tempApp, {
          report,
          corePatchRoot: tempRoot,
          linuxTarget: ubuntu,
        }),
      );
      assert.equal(
        report.patches.find((patch) => patch.name === "gentoo-only-sample")?.status,
        "skipped-target",
      );
      assert.equal(report.linuxTarget.distro.id, "ubuntu");
    } finally {
      fs.rmSync(tempApp, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch descriptor normalization rejects duplicate ids", () => {
  assert.throws(
    () => normalizePatchDescriptors([
      { id: "duplicate", apply: (source) => source },
      { id: "duplicate", apply: (source) => source },
    ]),
    /Duplicate patch descriptor id 'duplicate'/,
  );
});

test("default core patch descriptors are grouped and unique", () => {
  const descriptors = corePatchDescriptors();
  const ids = descriptors.map((descriptor) => descriptor.id);
  const expectedIds = [
    "linux-quit-guard",
    "linux-explicit-quit-prompt-bypass",
    "linux-explicit-quit-drain-timeout",
    "linux-explicit-tray-quit",
    "linux-explicit-ipc-quit",
    "linux-window-options",
    "linux-menu",
    "linux-set-icon",
    "linux-opaque-background",
    "linux-avatar-overlay-mouse-passthrough",
    "linux-file-manager",
    "linux-tray",
    "linux-single-instance",
    "linux-computer-use-ui-feature",
    "linux-computer-use-plugin-gate",
    "linux-chrome-plugin-auto-install",
    "browser-use-node-repl-approval",
    "linux-browser-use-iab-visible-on-create",
    "linux-chrome-extension-status",
    "linux-app-updater-menu",
    "linux-tray-close-setting",
    "linux-settings-persistence",
    "linux-launch-actions",
    "linux-hotkey-window-prewarm",
    "linux-git-origins-source-fallback",
    "linux-app-sunset-gate",
    "opaque-window-default-general-settings",
    "opaque-window-default-webview-index",
    "opaque-window-default-resolved-theme",
    "linux-computer-use-ui-availability",
    "linux-computer-use-install-flow",
    "linux-app-updater-bridge",
    "browser-annotation-screenshot",
    "composer-persistent-rate-limit-footer",
    "keybinds-settings",
    "package-desktop-name",
  ];

  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), [...expectedIds].sort());
  assert.ok(descriptors.every((descriptor) => descriptor.sourcePath.includes(`${path.sep}core${path.sep}`)));
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "package-desktop-name")?.phase,
    "extracted-app",
  );
  assert.match(
    descriptors.find((descriptor) => descriptor.id === "linux-chrome-plugin-auto-install")?.sourcePath,
    /main-process[\\/]browser-integrations[\\/]patch\.js$/,
  );
});

function trayBundleFixture() {
  return [
    "async function Hw(e){return process.platform!==`win32`&&process.platform!==`darwin`?null:(zw=!0,Lw??Rw??(Rw=(async()=>{let r=await Ww(e.buildFlavor,e.repoRoot),i=new n.Tray(r.defaultIcon);return i})()))}",
    "async function Ww(e,t){if(process.platform===`darwin`){return null}let r=process.platform===`win32`?`.ico`:`.png`,a=Nw(e,process.platform),o=[...n.app.isPackaged?[(0,i.join)(process.resourcesPath,`${a}${r}`)]:[],(0,i.join)(t,`electron`,`src`,`icons`,`${a}${r}`)];for(let e of o){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await n.app.getFileIcon(process.execPath,{size:process.platform===`win32`?`small`:`normal`}),chronicleRunningIcon:null}}",
    "var pb=class{trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(){this.tray={on(){},setContextMenu(){},popUpContextMenu(){}};this.onTrayButtonClick=()=>{};this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}async handleMessage(e){switch(e.type){case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return}}openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}updateChronicleTrayIcon(){}getNativeTrayMenuItems(){return[]}}",
    "v&&k.on(`close`,e=>{this.persistPrimaryWindowBounds(k,f);let t=this.getPrimaryWindows(f).some(e=>e!==k);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}if(process.platform===`darwin`&&!this.isAppQuitting&&!t){e.preventDefault(),k.hide()}});",
    "let E=process.platform===`win32`;E&&oe();",
  ].join("");
}

function singleInstanceBundleFixture() {
  return [
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});let A=Date.now();await n.app.whenReady();",
    "l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=",
  ].join("");
}

function explicitQuitBundleFixture() {
  return [
    "var pb=class{getNativeTrayMenuItems(){return[{label:rB(this.appName),click:()=>{n.app.quit()}}]}};",
    "if(o.type===`quit-app`){n.app.quit();return}",
  ].join("");
}

function beforeQuitConfirmationBundleFixture() {
  return [
    "n.app.on(`before-quit`,o=>{let s=BI(),c=t.sr().some(e=>e.status===`ACTIVE`);if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}let l=n.app.getName();if(n.dialog.showMessageBoxSync({type:`warning`,buttons:[`Quit`,`Cancel`],defaultId:0,cancelId:1,noLink:!0,title:`Quit ${l}?`,message:`Quit ${l}?`,detail:vB({hasInProgressLocalConversation:s,hasEnabledAutomations:c})})!==0){o.preventDefault();return}i.markQuitApproved(),g=!0,a.markAppQuitting()});",
  ].join("");
}

function willQuitDrainBundleFixture() {
  return [
    "n.app.on(`will-quit`,e=>{if(g=!0,!h){if(i.shouldSkipDrainBeforeQuit()){mB({hotkeyWindowLifecycleManager:c,globalDictationLifecycleManager:l,flushAndDisposeContexts:d,disposables:f});return}e.preventDefault(),h=!0,c.dispose(),l.dispose(),Promise.all([...u.values()].map(e=>e.flush())).finally(()=>{d(),f.dispose(),n.app.quit()})}});",
  ].join("");
}

function computerUseGateBundleFixture() {
  return [
    "var Qt=`openai-bundled`,$t=`browser-use`,en=`chrome-internal`,tn=`computer-use`,nn=`latex-tectonic`;",
    "var $n=[{forceReload:!0,installWhenMissing:!0,name:$t,isEnabled:({features:e})=>e.browserAgentAvailable,migrate:cn},{name:en,isEnabled:({buildFlavor:e})=>rn(e)},{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:wn},{name:nn,isEnabled:()=>!0}];",
  ].join("");
}

function currentPluginGateBundleFixture() {
  return [
    "var lt=`browser-use`,ut=`chrome`,dt=`chrome-internal`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:rr},{forceReload:!0,name:dt,isAvailable:({buildFlavor:e,features:t})=>Qn(e)&&t.externalBrowserUseAllowed},{forceReload:!0,name:ut,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&$n(e)},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{installWhenMissing:!0,name:ft,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.T.isInternal(e)&&r===`win32`&&n.computerUse},{name:pt,isAvailable:()=>!0}];",
  ].join("");
}

function computerUseFeatureBundleFixture() {
  return "function me(e,{env:t=process.env,platform:n=process.platform}={}){return n!==`win32`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?e:{...e,computerUse:!0,computerUseNodeRepl:!0}}";
}

function currentComputerUseFeatureBundleFixture() {
  return "function ye(e,{buildFlavor:n=t.D.resolve(),env:r=d.default.env,platform:i=d.default.platform}={}){let a=i===`win32`&&r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...e,computerUse:!0,computerUseNodeRepl:!0}:e,o=n===t.D.Dev?be(r):null;return o==null?a:{...a,...o}}";
}

function computerUseRendererAvailabilityBundleFixture() {
  return [
    "function hae(e){return e===`macOS`||e===`windows`}",
    "function LS(e){let t=(0,q.c)(10),{hostId:n,featureName:r,defaultEnabled:i}=e,a=i===void 0?!0:i,{data:o,isLoading:s}=N(Wa,n),c;t[0]===o?c=t[1]:(c=o===void 0?[]:o,t[0]=o,t[1]=c);let l=c,u;if(t[2]!==r||t[3]!==l){let e;t[5]===r?e=t[6]:(e=e=>e.name===r,t[5]=r,t[6]=e),u=l.find(e),t[2]=r,t[3]=l,t[4]=u}else u=t[4];let d=u?.enabled??a,f;return t[7]!==s||t[8]!==d?(f={enabled:d,isLoading:s},t[7]=s,t[8]=d,t[9]=f):f=t[9],f}",
    "function RS(e){let t=(0,q.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,o=r===void 0?R:r,s=Kn(),{isLoading:c,platform:l}=Hr(),u=Vn(`1506311413`),d;t[0]===o?d=t[1]:(d={featureName:`computer_use`,hostId:o},t[0]=o,t[1]=d);let f=LS(d),p;t[2]===l?p=t[3]:(p=hae(l),t[2]=l,t[3]=p);let m=a&&i&&s===`electron`&&u&&(c||p),h=m&&!c&&f.enabled&&!f.isLoading,g=m&&f.isLoading,_=m&&(c||f.isLoading),v;return t[4]!==h||t[5]!==g||t[6]!==_?(v={available:h,isFetching:g,isLoading:_},t[4]=h,t[5]=g,t[6]=_,t[7]=v):v=t[7],v}",
  ].join("");
}

function computerUseInstallFlowBundleFixture() {
  return "function Qe({forceReloadPlugins:e,hostId:t}){let ne=f({featureName:`computer_use`,hostId:t}),re=!ne.isLoading&&ne.enabled,[L,R]=(0,Z.useState)({});return re}";
}

function chromeExtensionStatusBundleFixture() {
  return [
    "let r=require(`node:os`),i=require(`node:path`),o=require(`node:fs`);",
    "var am=`com.google.Chrome`,om=`/usr/bin/open`,sm=/^[a-p]{32}$/;",
    "function pm(e){if(!sm.test(e))throw Error(`Invalid extension id`);return e}",
    "function cm(e){return`chrome://extensions/?id=${pm(e)}`}",
    "function lm({extensionId:e,homeDir:t=(0,r.homedir)(),localAppDataDir:n=process.env.LOCALAPPDATA,platform:a=process.platform}){let s=pm(e),c=mm({homeDir:t,localAppDataDir:n,platform:a});return c==null||!(0,o.existsSync)(c)?!1:(0,o.readdirSync)(c,{withFileTypes:!0}).some(e=>e.isDirectory()&&(0,o.existsSync)((0,i.join)(c,e.name,`Extensions`,s)))}async function um({extensionId:e,platform:t=process.platform,detectChromeCommand:n=dm,runCommand:r=Hp}){if(t===`darwin`){await r(om,[`-b`,am,cm(e)]);return}if(t===`win32`){let t=n();if(t==null)throw Error(`Google Chrome is not installed`);await r(t,[cm(e)]);return}throw Error(`Opening Chrome extension settings is only supported on macOS and Windows`)}function dm(){return Rp(`google-chrome`)}",
    "function mm({homeDir:e,localAppDataDir:t,platform:n}){return n===`darwin`?(0,i.join)(e,`Library`,`Application Support`,`Google`,`Chrome`):n===`win32`?(0,i.join)(t??(0,i.join)(e,`AppData`,`Local`),`Google`,`Chrome`,`User Data`):null}",
    "function Rp(e){return e}async function Hp(){}",
  ].join("");
}

function currentChromeExtensionStatusBundleFixture() {
  return [
    "let r=require(`node:os`),i=require(`node:path`),o=require(`node:fs`);",
    "var nm=`com.google.Chrome`,rm=`/usr/bin/open`,im=/^[a-p]{32}$/;",
    "function am(e){return`chrome://extensions/?id=${um(e)}`}",
    "function om({extensionId:e,homeDir:t=(0,r.homedir)(),localAppDataDir:n=process.env.LOCALAPPDATA,platform:a=process.platform}){let s=um(e),c=dm({homeDir:t,localAppDataDir:n,platform:a});return c==null||!(0,o.existsSync)(c)?!1:(0,o.readdirSync)(c,{withFileTypes:!0}).some(e=>e.isDirectory()&&(0,o.existsSync)((0,i.join)(c,e.name,`Extensions`,s)))}async function sm({extensionId:e,platform:t=process.platform,detectChromeCommand:n=cm,runCommand:r=zp}){if(t===`darwin`){await r(rm,[`-b`,nm,am(e)]);return}if(t===`win32`){let t=n();if(t==null)throw Error(`Google Chrome is not installed`);await r(t,[am(e)]);return}throw Error(`Opening Chrome extension settings is only supported on macOS and Windows`)}function cm(){return Fp(`chrome.exe`)}",
    "function lm(){return null}function um(e){let t=e.trim();if(!im.test(t))throw Error(`Invalid Chrome extension id`);return t}function dm({homeDir:e,localAppDataDir:t,platform:n}){return n===`darwin`?(0,i.join)(e,`Library`,`Application Support`,`Google`,`Chrome`):n===`win32`?(0,i.join)(t??(0,i.join)(e,`AppData`,`Local`),`Google`,`Chrome`,`User Data`):null}",
    "function Fp(e){return e}async function zp(){}",
  ].join("");
}

function currentLaunchActionBundleFixture() {
  return [
    "const e={gr:e=>({default:e,...e})};let n=require(`electron`);let i=require(`node:path`);i=e.gr(i);let o=require(`node:fs`);o=e.gr(o);let f=require(`node:net`);f=e.gr(f);",
    "async function CN(){let{setSecondInstanceArgsHandler:l}=t.y(),g={reportNonFatal(){}},k=new t.In;k.add(x);let j={globalState:{get(){return true}},repoRoot:`/tmp`,codexHome:`/tmp`},M={hotkeyWindowLifecycleManager:{hide(){},ensureHotkeyWindowController(){}},getPrimaryWindow(){},createFreshLocalWindow(){},ensureHostWindow(){},windowManager:{sendMessageToWindow(){}}},B=`local`,R={desktopNotificationManager:{dismissByNavigationPath(){}},getOrCreateContext(){},localHost:B},z={deepLinks:{queueProcessArgs(){},flushPendingDeepLinks(){}},navigateToRoute(){}};let A=Date.now(),w=()=>{},ae=e=>{e.isMinimized()&&e.restore(),e.show(),e.focus()},le=async()=>{try{M.hotkeyWindowLifecycleManager.hide();let e=M.getPrimaryWindow()??await M.createFreshLocalWindow(`/`);if(e==null)return;ae(e)}catch(e){g.reportNonFatal(e instanceof Error?e:`Failed to open window on second instance`,{kind:`second-instance-open-window-failed`})}};l(e=>{let n=t.t(t.g(e));if(z.deepLinks.queueProcessArgs(e)){n&&le();return}if(n){le();return}le()});let ue=async(e,t)=>{M.hotkeyWindowLifecycleManager.hide();let n=M.getPrimaryWindow(),r=n??await M.createFreshLocalWindow(e);r!=null&&(R.desktopNotificationManager.dismissByNavigationPath(e),n!=null&&t.navigateExistingWindow&&z.navigateToRoute(r,e),ae(r))};let ce=async()=>{};E&&ce();let be=await M.ensureHostWindow(B);be&&ae(be),w(`local window ensured`,A,{hostId:B,localWindowVisible:be?.isVisible()??!1}),A=Date.now(),await z.deepLinks.flushPendingDeepLinks();}",
  ].join("");
}

function keybindsIndexBundleFixture() {
  return [
    "var Kge={\"general-settings\":xh,appearance:Pf,\"git-settings\":t1};",
    "var i_e={\"general-settings\":(0,Z.lazy)(()=>s(()=>import(`./general-settings-DsLl9t6Z.js`),[],import.meta.url)),appearance:(0,Z.lazy)(()=>s(()=>import(`./appearance.js`),[],import.meta.url))};",
    "qge=[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`];",
    "Jge=[{key:`app`,heading:H7.appHeading,slugs:[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`]}];",
    "switch(e){case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;}",
    "switch(e){case`usage`:k=g;break bb0;case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;}",
  ].join("");
}

function appSunsetBundleFixture() {
  return [
    "function IT(){return null}",
    "function LT(e){let t=(0,Z.c)(3),{children:n}=e;if(ms(`2929582856`)){let e;return t[0]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,$.jsx)(IT,{}),t[0]=e):e=t[0],e}let r;return t[1]===n?r=t[2]:(r=(0,$.jsx)($.Fragment,{children:n}),t[1]=n,t[2]=r),r}",
  ].join("");
}

function appSunsetBundleWithDriftingAliasFixture() {
  return appSunsetBundleFixture().replace("if(ms(`2929582856`)){", "if(xs(`2929582856`)){");
}

function appSunsetBundleWithDriftingGateFixture() {
  return appSunsetBundleFixture().replace("if(ms(`2929582856`)){", "if(ms?.(`2929582856`)){");
}

function appUpdaterBundleFixture() {
  return [
    "let t=require(`electron`),i=require(`node:path`),s=require(`node:fs`),u=require(`node:child_process`);",
    "var ZE=()=>({warning(){},error(){}});",
    "var tD=class{updater=null;isUpdateReady=!1;updateLifecycleState=`idle`;installProgressPercent=null;lastUnavailableReason=null;constructor(e){this.options=e}async initialize(){if(!this.options.enableUpdater){this.lastUnavailableReason=process.platform!==`darwin`&&process.platform!==`win32`?`unsupported platform`:`disabled for build flavor (${this.options.buildFlavor})`;return}try{if(process.platform===`win32`?await this.initializeWindowsUpdater():await this.initializeMacSparkle(),t.ipcMain.handle(`codex_desktop:check-for-updates`,async e=>{this.options.isTrustedIpcEvent(e)&&await this.checkForUpdates()}),this.hasUpdater())return}catch(e){this.lastUnavailableReason=`updater initialization failed`,this.updater=null}}hasUpdater(){return this.updater!=null}getIsUpdateReady(){return this.isUpdateReady}getInstallProgressPercent(){return this.installProgressPercent}getUpdateLifecycleState(){return this.updateLifecycleState}async checkForUpdates(){if(!this.updater)return;try{await this.updater.checkForUpdates()}catch(e){}}async installUpdatesIfAvailable(){if(!this.updater)return;try{this.isUpdateReady&&this.setUpdateLifecycleState(`installing`),await this.updater.installUpdatesIfAvailable()}catch(e){}}getUnavailableReason(){return this.lastUnavailableReason}async initializeWindowsUpdater(){}async initializeMacSparkle(){}setUpdateReady(e){this.isUpdateReady=e}setUpdateLifecycleState(e){this.updateLifecycleState=e}setInstallProgressPercent(e){this.installProgressPercent=e}};",
  ].join("");
}

function currentBootstrapUpdaterBundleFixture() {
  return [
    "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`),u=require(`node:child_process`);",
    "c({onUpdateReadyChanged:e=>{a.sendMessageToAllRegisteredWindows({type:`app-update-ready-changed`,isUpdateReady:e})}});",
    "var rK={enabled:!1,running:!1,state:`disabled`};",
    "async function iK(){",
    "let{startedAtMs:r,buildFlavor:a,desktopSentry:o,sparkleManager:s,setSparkleBridgeHandlers:c,setSecondInstanceArgsHandler:l}=t.x(),d=t.T.shouldIncludeSparkle(a,process.platform,process.env);",
    "let M=oG({});let ee=pB(),te=()=>{ee.allowQuitTemporarilyForUpdateInstall(),n.app.quit()};",
    "c({onInstallProgressChanged:e=>{E&&M.sendMessageToAllRegisteredWindows({type:`app-update-install-progress-changed`,installProgressPercent:e})},onUpdateReadyChanged:e=>{M.sendMessageToAllRegisteredWindows({type:`app-update-ready-changed`,isUpdateReady:e})},onUpdateLifecycleStateChanged:e=>{M.sendMessageToAllRegisteredWindows({type:`app-update-lifecycle-state-changed`,lifecycleState:e})},onInstallUpdatesRequested:()=>{te()},isTrustedIpcEvent:N});",
    "}",
  ].join("");
}

function avatarOverlayBundleFixture() {
  return [
    "let u=require(`node:child_process`);",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},sV={width:276,height:131};",
    "var fV=class{window=null;openingWindowPromise=null;anchor=pV({x:0,y:0,...zB},oV);dragState=null;layout=null;mascotSize=oV;momentumTimer=null;mousePassthroughEnabled=!1;placement=`top-end`;pointerInteractive=!1;rendererReady=!1;traySize=null;",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "isOpen(){let e=this.window;return e!=null&&!e.isDestroyed()&&e.isVisible()}",
    "startDrag(e,{pointerWindowX:t,pointerWindowY:r}){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e)return;this.cancelMomentum();let a=this.getLayout(i);this.dragState={pointerAnchorX:t-a.mascot.left,pointerAnchorY:r-a.mascot.top,hasMoved:!1,displayBounds:n.screen.getDisplayNearestPoint(n.screen.getCursorScreenPoint()).bounds}}",
    "moveDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||this.dragState==null||(this.cancelMomentum(),this.dragState.hasMoved=!0,this.moveDragToCurrentCursor(t))}",
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}))}",
    "setElementSize(e,{mascot:t,tray:n}){let r=this.window;r==null||r.isDestroyed()||r.webContents.id!==e||(this.cancelMomentum(),this.anchor={...this.anchor,width:t.width,height:t.height},this.mascotSize=t,this.traySize=n,this.applyLayout(r))}",
    "async createWindow(e){let t=await this.windowManager.createWindow({title:n.app.getName(),width:zB.width,height:zB.height,appearance:`avatarOverlay`,focusable:!1,show:!1,initialRoute:rV,hostId:this.windowManager.getHostIdForWebContents(e)??`local`});return this.window=t,this.rendererReady=this.windowManager.isWebContentsReady(t.webContents.id),this.dragState=null,this.layout=null,this.mascotSize=oV,this.mousePassthroughEnabled=!1,this.placement=`top-end`,this.pointerInteractive=!1,this.traySize=null,t.once(`ready-to-show`,()=>{t.isDestroyed()||!this.rendererReady||(this.showWindow(t),this.applyPointerInteractivityPolicy())}),t.on(`closed`,()=>{this.window===t&&(this.cancelMomentum(),this.window=null,this.dragState=null,this.layout=null,this.rendererReady=!1,this.pointerInteractive=!1,this.mousePassthroughEnabled=!1,this.globalState.set(Te,!1),this.broadcastOpenState())}),t}",
    "applyLayout(e,t=n.screen.getDisplayNearestPoint(hV(this.anchor)).bounds){if(e.isDestroyed())return;let r=UB({anchor:this.anchor,displayBounds:t,mascotSize:this.mascotSize,previousPlacement:this.placement,traySize:this.traySize??sV});this.anchor=r.anchor,this.layout=r,this.placement=r.placement,this.setWindowBounds(e,r.windowBounds),this.sendLayoutToRenderer(e)}getLayout(e){if(this.layout??this.applyLayout(e),this.layout==null)throw Error(`Expected avatar overlay layout`);return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;let t=this.isOpen();e.moveTop(),e.showInactive(),!t&&this.isOpen()&&this.broadcastOpenState()}broadcastOpenState(){this.windowManager.sendMessageToAllRegisteredWindows({type:`avatar-overlay-open-state-changed`,isOpen:this.isOpen()})}",
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}",
    "refreshCursorAtCurrentMousePosition(e){if(e.isDestroyed())return;let t=n.screen.getCursorScreenPoint(),r=e.getContentBounds(),i=t.x-r.x,a=t.y-r.y;i<0||a<0||i>r.width||a>r.height||e.webContents.sendInputEvent({type:`mouseMove`,x:i,y:a,movementX:0,movementY:0})}",
    "};",
  ].join("");
}

test("adds Linux file manager support without relying on exact minified variable names", () => {
  const source = `${mainBundlePrefix}${fileManagerBundle}`;

  const patched = applyPatchTwice(applyLinuxFileManagerPatch, source);

  assert.match(patched, /linux:\{label:`File Manager`/);
  assert.match(patched, /detect:\(\)=>`linux-file-manager`/);
  assert.match(patched, /n\.shell\.openPath\(__codexOpenTarget\)/);
});

test("adds the Linux quit guard when electron/path/fs requires are split across statements", () => {
  const source =
    "const e={gr:e=>({default:e,...e})};let n=require(`electron`);let i=require(`node:path`);i=e.gr(i);let o=require(`node:fs`);o=e.gr(o);";

  const patched = applyPatchTwice(applyLinuxQuitGuardPatch, source);

  assert.match(patched, /let codexLinuxQuitInProgress=!1/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxMarkQuitInProgress=\(\)=>\{codexLinuxQuitInProgress=!0\}/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /codexLinuxShouldBypassQuitPrompt=\(\)=>codexLinuxExplicitQuitApproved===!0/);
  assert.match(patched, /codexLinuxIsQuitInProgress=\(\)=>codexLinuxQuitInProgress===!0/);
});

test("adds the Linux quit guard when only the Electron require is recognizable", () => {
  const source =
    "const e=require(`./app-session.js`);let t=require(`electron`);class WindowManager{}";

  const patched = applyPatchTwice(applyLinuxQuitGuardPatch, source);

  assert.match(patched, /^let codexLinuxQuitInProgress=!1/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxMarkQuitInProgress=\(\)=>\{codexLinuxQuitInProgress=!0\}/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /codexLinuxShouldBypassQuitPrompt=\(\)=>codexLinuxExplicitQuitApproved===!0/);
  assert.match(patched, /codexLinuxIsQuitInProgress=\(\)=>codexLinuxQuitInProgress===!0/);
  assert.equal((patched.match(/codexLinuxQuitInProgress=!1/g) ?? []).length, 1);
});

test("upgrades the legacy Linux quit guard helper when re-patching older bundles", () => {
  const source =
    "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;var x=1;";

  const patched = applyPatchTwice(applyLinuxQuitGuardPatch, source);

  assert.doesNotMatch(patched, /let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=\(\)=>\{codexLinuxQuitInProgress=!0\},codexLinuxIsQuitInProgress=\(\)=>codexLinuxQuitInProgress===!0;/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /codexLinuxShouldBypassQuitPrompt=\(\)=>codexLinuxExplicitQuitApproved===!0/);
});

test("bypasses the upstream before-quit confirmation after a Linux explicit quit", () => {
  const source = `${mainBundlePrefix}${beforeQuitConfirmationBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxExplicitQuitPromptBypassPatch,
    applyLinuxQuitGuardPatch(source),
  );

  assert.match(
    patched,
    /if\(\(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt\(\)\)\|\|e\|\|i\.canQuitWithoutPrompt\(\)\|\|r\|\|!s&&!c\)\{g=!0,a\.markAppQuitting\(\);return\}/,
  );
});

test("adds a bounded will-quit drain fallback for Linux explicit quit", () => {
  const source = `${mainBundlePrefix}${willQuitDrainBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxWillQuitDrainTimeoutPatch,
    applyLinuxQuitGuardPatch(source),
  );

  assert.match(patched, /codexLinuxExplicitQuitDrainTimeoutMs=3e3/);
  assert.match(patched, /\(\(\)=>\{let codexLinuxFinalizeQuit=\(\)=>\{d\(\),f\.dispose\(\),n\.app\.quit\(\)\},codexLinuxDrainPromise=Promise\.all\(\[\.\.\.u\.values\(\)\]\.map\(e=>e\.flush\(\)\)\);/);
  assert.match(patched, /if\(process\.platform===`linux`&&\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)\)\{Promise\.race\(\[codexLinuxDrainPromise,new Promise\(e=>setTimeout\(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===`number`\?codexLinuxExplicitQuitDrainTimeoutMs:3e3\)\)\]\)\.finally\(codexLinuxFinalizeQuit\);return\}/);
  assert.doesNotMatch(patched, /\\`number\\`/);
  assert.match(patched, /codexLinuxDrainPromise\.finally\(codexLinuxFinalizeQuit\)\}\)\(\)/);
  assert.doesNotThrow(() => new Function(patched));
});

test("marks Linux quit-in-progress for the tray quit path", () => {
  const source = `${mainBundlePrefix}${explicitQuitBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxExplicitTrayQuitPatch,
    applyLinuxQuitGuardPatch(source),
  );

  assert.match(
    patched,
    /\{label:rB\(this\.appName\),click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\)\}\}/,
  );
});

test("marks Linux quit-in-progress for the quit-app IPC path", () => {
  const source = `${mainBundlePrefix}${explicitQuitBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxExplicitIpcQuitPatch,
    applyLinuxQuitGuardPatch(source),
  );

  assert.match(
    patched,
    /if\(o\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\);return\}/,
  );
});

test("supports explicit tray quit patching when minified aliases drift", () => {
  const source =
    "let x=require(`electron`);var q=class{getNativeTrayMenuItems(){return[{label:rB(this.appName),click:()=>{x.app.quit()}}]}};if(m.type===`quit-app`){x.app.quit();return}";
  const patched = applyPatchTwice(applyLinuxExplicitTrayQuitPatch, source);

  assert.match(
    patched,
    /\{label:rB\(this\.appName\),click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),x\.app\.quit\(\)\}\}/,
  );
});

test("supports explicit tray quit patching when upstream renames the quit label helper", () => {
  const source =
    "let n=require(`electron`);var q=class{getNativeTrayMenuItems(){return[{label:mH(this.appName),click:()=>{n.app.quit()}}]}};function mH(e){let t=n.Menu.buildFromTemplate([{role:`quit`}]);return(Array.isArray(t)?t:t.items)[0]?.label??`Quit ${e}`}";
  const patched = applyPatchTwice(applyLinuxExplicitTrayQuitPatch, source);

  assert.match(
    patched,
    /\{label:mH\(this\.appName\),click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\)\}\}/,
  );
});

test("supports explicit IPC quit patching when minified aliases drift", () => {
  const source =
    "let x=require(`electron`);var q=class{getNativeTrayMenuItems(){return[{label:rB(this.appName),click:()=>{x.app.quit()}}]}};if(m.type===`quit-app`){x.app.quit();return}";
  const patched = applyPatchTwice(applyLinuxExplicitIpcQuitPatch, source);

  assert.match(
    patched,
    /if\(m\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),x\.app\.quit\(\);return\}/,
  );
});

test("adds Linux menu hiding next to Windows removeMenu calls", () => {
  const source = "process.platform===`win32`&&k.removeMenu(),k.on(`closed`,()=>{})";
  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal(
    patched,
    "process.platform===`linux`&&k.setMenuBarVisibility(!1),process.platform===`win32`&&k.removeMenu(),k.on(`closed`,()=>{})",
  );
});

test("recognizes already-applied Linux opaque background patch", () => {
  const patched = applyPatchTwice(applyLinuxOpaqueBackgroundPatch, alreadyOpaqueBackgroundBundle);
  assert.equal(patched, alreadyOpaqueBackgroundBundle);
});

test("uses the local transparent appearance predicate for Linux opaque backgrounds", () => {
  const patched = applyPatchTwice(
    applyLinuxOpaqueBackgroundPatch,
    opaqueBackgroundBundleWithDriftingGw,
  );

  assert.match(patched, /e===`linux`&&!OM\(t\)\?\{backgroundColor:r\?lM:uM/);
  assert.doesNotMatch(patched, /process\.platform===`linux`&&!gw\(t\)/);
});

test("patches current BrowserWindow background helper shape for Linux opaque backgrounds", () => {
  const patched = applyPatchTwice(applyLinuxOpaqueBackgroundPatch, currentOpaqueBackgroundBundle);

  assert.match(
    patched,
    /:e===`linux`&&!vq\(t\)\?\{backgroundColor:r\?\$K:eq,backgroundMaterial:null\}:e===`win32`&&!vq\(t\)\?/,
  );
  assert.match(patched, /vq\(e\).*hotkeyWindowThread/);
});

test("patches current webview opaque window default bundle shapes", () => {
  const resolvedThemeSource =
    "function oe(e,t){let n=o[t];return{accent:p(e?.accent)??n.accent,contrast:se(e?.contrast,n.contrast),fonts:le(e?.fonts),ink:p(e?.ink)??n.ink,opaqueWindows:e?.opaqueWindows??n.opaqueWindows,semanticColors:ue(e?.semanticColors,n.semanticColors),surface:p(e?.surface)??n.surface}}";
  const runtimeSource =
    "let{data:c}=Qc(y.APPEARANCE_LIGHT_CHROME_THEME,s),l;let{data:u}=Qc(y.APPEARANCE_DARK_CHROME_THEME,l),d;let x=b,S;let C=o===`light`?x:S,w;if(C.opaqueWindows&&!ba()){e.classList.add(`electron-opaque`)}";
  const settingsSource =
    "function sn(){let{canImportThemeString:u,setThemePatch:b,theme:x}=p(t),S=vn(r,t),k=[{label:i}],A=[];return x.opaqueWindows}";

  const patchedResolvedTheme = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, resolvedThemeSource);
  const patchedRuntime = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, runtimeSource);
  const patchedSettings = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, settingsSource);

  assert.match(patchedResolvedTheme, /opaqueWindows:e\?\.opaqueWindows\?\?\(typeof navigator<`u`&&/);
  assert.match(
    patchedRuntime,
    /document\.documentElement\.dataset\.codexOs===`linux`&&\(\(o===`light`\?c:u\)\?\.opaqueWindows==null&&\(C=\{\.\.\.C,opaqueWindows:!0\}\)\)/,
  );
  assert.match(
    patchedSettings,
    /navigator\.userAgent\.includes\(`Linux`\)&&x\?\.opaqueWindows==null&&\(x=\{\.\.\.x,opaqueWindows:!0\}\);let S=/,
  );
});

test("warns when a matched webview opaque bundle has no known insertion point", () => {
  const { warnings } = captureWarns(() =>
    applyLinuxOpaqueWindowsDefaultPatch("function runtime(){let C=theme;if(C.opaqueWindows&&!ba()){}}"),
  );

  assert.deepEqual(warnings, [
    "WARN: Could not find Linux opaque window default insertion point — skipping settings default patch",
  ]);
});

test("adds Linux avatar overlay mouse passthrough recovery", () => {
  const patched = applyPatchTwice(
    applyLinuxAvatarOverlayMousePassthroughPatch,
    avatarOverlayBundleFixture(),
  );

  assert.match(patched, /codexLinuxAvatarPassthroughRecoveryTimer/);
  assert.match(patched, /codexLinuxStartAvatarPassthroughRecovery\(\)/);
  assert.match(patched, /codexLinuxStopAvatarPassthroughRecovery\(\)/);
  assert.match(patched, /codexLinuxSyncAvatarPointerInteractivity\(e\)/);
  assert.match(patched, /codexLinuxBuildAvatarInputShape\(e\)/);
  assert.match(patched, /codexLinuxApplyAvatarInputShape\(e\)/);
  assert.match(patched, /codexLinuxIsI3Session\(\)/);
  assert.match(patched, /process\.env\.I3SOCK/);
  assert.match(patched, /codexLinuxApplyAvatarCompositorHints\(e\)/);
  assert.match(patched, /getNativeWindowHandle\?\.\(\)/);
  assert.match(patched, /u\.execFile\(`xdotool`,\[`search`,`--pid`,String\(process\.pid\)\]/);
  assert.match(patched, /u\.execFile\(`xwininfo`,\[`-id`,e\]/);
  assert.match(patched, /u\.execFile\(`xprop`/);
  assert.match(patched, /_GTK_FRAME_EXTENTS/);
  assert.match(patched, /Override Redirect State/);
  assert.match(patched, /Absolute upper-left X/);
  assert.match(patched, /Number\(l\)!==t\.x/);
  assert.match(patched, /Number\(h\)!==t\.y/);
  assert.match(patched, /Number\(d\)!==t\.width/);
  assert.doesNotMatch(patched, /let\[,l,u,d,f\]=c/);
  assert.doesNotMatch(patched, /this\.codexLinuxIsI3Session\(\)\)\{this\.codexLinuxStopAvatarPassthroughRecovery\(\),this\.codexLinuxAvatarInputShapeKey=null,this\.pointerInteractive=!0,this\.mousePassthroughEnabled&&\(this\.mousePassthroughEnabled=!1\),e\.setIgnoreMouseEvents\(!1\);return\}/);
  assert.match(patched, /if\(process\.platform===`linux`&&typeof e\.setShape==`function`\)\{/);
  assert.doesNotMatch(patched, /typeof e\.setShape==`function`&&!this\.codexLinuxIsI3Session\(\)/);
  assert.match(patched, /if\(t==null\)return null/);
  assert.match(patched, /if\(t==null\)return!1;let n=JSON\.stringify\(t\)/);
  assert.match(patched, /e\.setShape\(t\),this\.codexLinuxAvatarInputShapeKey=n;return!0/);
  assert.match(patched, /return\[i\(t\.mascot\),i\(t\.tray\)\]\.filter\(Boolean\)/);
  assert.match(patched, /process\.platform!==`linux`/);
  assert.match(patched, /setInterval\(\(\)=>\{let e=this\.window/);
  assert.match(patched, /\},32\)/);
  assert.doesNotMatch(patched, /typeof e\.setShape==`function`\)return;this\.codexLinuxAvatarPassthroughRecoveryTimer=setInterval/);
  assert.match(patched, /this\.dragState!=null/);
  assert.match(patched, /this\.codexLinuxIsCursorInAvatarInteractiveRegion\(e\)/);
  assert.match(patched, /catch\{t=!0\}/);
  assert.match(patched, /this\.pointerInteractive=t/);
  assert.match(patched, /displayBounds:n\.screen\.getDisplayNearestPoint\(n\.screen\.getCursorScreenPoint\(\)\)\.bounds\},process\.platform===`linux`&&\(this\.pointerInteractive=!0,this\.applyPointerInteractivityPolicy\(\)\)\}moveDrag\(e\)/);
  assert.match(patched, /this\.dragState=null,this\.reclampWindowToVisibleDisplay\(\{shouldPersist:!0\}\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /this\.applyLayout\(r\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /this\.codexLinuxAvatarCompositorHintsApplied=!1,this\.codexLinuxAvatarCompositorHintsApplying=!1,this\.rendererReady=/);
  assert.match(patched, /traySize:process\.platform===`linux`&&typeof this\.codexLinuxIsI3Session==`function`&&this\.codexLinuxIsI3Session\(\)\?this\.traySize:this\.traySize\?\?sV/);
  assert.match(patched, /this\.setWindowBounds\(e,r\.windowBounds\),this\.sendLayoutToRenderer\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /e\.moveTop\(\),e\.showInactive\(\),process\.platform===`linux`&&this\.codexLinuxApplyAvatarCompositorHints\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.doesNotMatch(patched, /codexLinuxRecoverAvatarPointerInteractivity/);
  assert.match(patched, /this\.window===t&&\(this\.codexLinuxStopAvatarPassthroughRecovery\(\),this\.codexLinuxAvatarInputShapeKey=null,this\.codexLinuxAvatarCompositorHintsApplied=!1,this\.codexLinuxAvatarCompositorHintsApplying=!1,this\.cancelMomentum\(\)/);
});

test("adds Linux window icon handling when an icon asset is available", () => {
  const iconAsset = "app-test.png";
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const windowOptionsSource = "...process.platform===`win32`?{autoHideMenuBar:!0}:{},";
  const readyToShowSource = "D.once(`ready-to-show`,()=>{})";

  const patchedWindowOptions = applyPatchTwice(
    applyLinuxWindowOptionsPatch,
    windowOptionsSource,
    iconAsset,
  );
  const patchedSetIcon = applyPatchTwice(applyLinuxSetIconPatch, readyToShowSource, iconAsset);
  const patchedMain = applyPatchTwice(
    patchMainBundleSource,
    [
      mainBundlePrefix,
      windowOptionsSource,
      "process.platform===`win32`&&k.removeMenu(),",
      readyToShowSource,
      alreadyOpaqueBackgroundBundle,
      fileManagerBundle,
      trayBundleFixture(),
      singleInstanceBundleFixture(),
    ].join(""),
    iconAsset,
  );

  assert.match(patchedWindowOptions, /process\.platform===`win32`\|\|process\.platform===`linux`/);
  assert.match(patchedWindowOptions, new RegExp(`icon:${escapeRegExp(iconPathExpression)}`));
  assert.equal(
    patchedSetIcon,
    `process.platform===\`linux\`&&D.setIcon(${iconPathExpression}),${readyToShowSource}`,
  );
  assert.match(patchedMain, new RegExp(`icon:${escapeRegExp(iconPathExpression)}`));
  assert.match(patchedMain, new RegExp(`D\\.setIcon\\(${escapeRegExp(iconPathExpression)}\\)`));
});

test("adds Linux tray support including the platform guard", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const patched = applyPatchTwice(applyLinuxTrayPatch, trayBundleFixture(), iconPathExpression);

  assert.match(
    patched,
    /process\.platform!==`win32`&&process\.platform!==`darwin`&&process\.platform!==`linux`\?null:/,
  );
  assert.match(
    patched,
    new RegExp(`nativeImage\\.createFromPath\\(${escapeRegExp(iconPathExpression)}\\)`),
  );
  assert.match(
    patched,
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)/,
  );
  assert.match(patched, /setLinuxTrayContextMenu\(\)\{let e=n\.Menu\.buildFromTemplate/);
  assert.match(
    patched,
    /process\.platform===`linux`&&this\.setLinuxTrayContextMenu\(\),this\.tray\.on\(`click`/,
  );
  assert.match(
    patched,
    /openNativeTrayMenu\(\)\{if\(process\.platform===`linux`&&\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)\)return;/,
  );
  assert.match(patched, /if\(process\.platform===`linux`\)return;e\.once\(`menu-will-show`/);
  assert.match(
    patched,
    /this\.trayMenuThreads=e\.trayMenuThreads,process\.platform===`linux`&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.setLinuxTrayContextMenu\?\.\(\)/,
  );
  assert.match(
    patched,
    /\(E\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&oe\(\);/,
  );
  assert.doesNotMatch(patched, /process\.platform===`linux`&&codexLinuxIsTrayEnabled\(\)/);
});

test("adds Linux tray support for current minified window and startup identifiers", () => {
  const source = [
    "v&&j.on(`close`,e=>{this.persistPrimaryWindowBounds(j,f);let t=this.getPrimaryWindows(f).some(e=>e!==j);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),j.hide();return}});",
    "async function eN(e){let t=await Ww(e.buildFlavor,e.repoRoot),r=new n.Tray(t.defaultIcon);return r}",
    "let ce$=async()=>{O=!0;try{await eN({buildFlavor:a,repoRoot:j.repoRoot})}catch(e){O=!1}};E&&ce$();",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);

  assert.match(
    patched,
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)/,
  );
  assert.match(patched, /e\.preventDefault\(\),j\.hide\(\);return/);
  assert.match(
    patched,
    /\(E\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&ce\$\(\);/,
  );
});

test("scopes dynamic tray startup matching to the tray initializer", () => {
  const source = [
    "async function aa(e){return e.buildFlavor}",
    "let startOther=async()=>{A=!0;try{await aa({buildFlavor:a})}catch(e){A=!1}};U&&startOther();",
    "async function eN(e){let t=await Ww(e.buildFlavor,e.repoRoot),r=new n.Tray(t.defaultIcon);return r}",
    "let ce$=async()=>{O=!0;try{await eN({buildFlavor:a,repoRoot:j.repoRoot})}catch(e){O=!1}};E&&ce$();",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);

  assert.match(patched, /U&&startOther\(\);/);
  assert.doesNotMatch(
    patched,
    /\(U\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&startOther\(\);/,
  );
  assert.match(
    patched,
    /\(E\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&ce\$\(\);/,
  );
});

test("migrates Linux tray startup patch to tolerate missing settings helper", () => {
  const source = [
    "async function eN(e){let t=await Ww(e.buildFlavor,e.repoRoot),r=new n.Tray(t.defaultIcon);return r}",
    "let ce$=async()=>{O=!0;try{await eN({buildFlavor:a,repoRoot:j.repoRoot})}catch(e){O=!1}};(E||process.platform===`linux`&&codexLinuxIsTrayEnabled())&&ce$();",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);

  assert.match(
    patched,
    /\(E\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&ce\$\(\);/,
  );
});

test("scopes close-to-tray already-patched detection to the handler", () => {
  const source = [
    "let unrelated=(process.platform===`win32`||process.platform===`linux`)&&x===`local`;",
    "v&&j.on(`close`,e=>{this.persistPrimaryWindowBounds(j,f);let t=this.getPrimaryWindows(f).some(e=>e!==j);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),j.hide();return}});",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);

  assert.match(
    patched,
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLastLocalWindowToTray\?\.\(\)===!0&&!t\)\{e\.preventDefault\(\),j\.hide\(\);return\}/,
  );
});

test("adds Linux single-instance lock and second-instance handoff", () => {
  const patched = applyPatchTwice(applyLinuxSingleInstancePatch, singleInstanceBundleFixture());

  assert.match(patched, /process\.platform===`linux`&&!n\.app\.requestSingleInstanceLock\(\)/);
  assert.match(patched, /n\.app\.quit\(\);return/);
  assert.match(patched, /codexLinuxBeforeQuitHandler=\(\)=>\{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /n\.app\.on\(`before-quit`,codexLinuxBeforeQuitHandler\)/);
  assert.match(patched, /n\.app\.off\(`before-quit`,codexLinuxBeforeQuitHandler\)/);
  assert.match(patched, /codexLinuxSecondInstanceHandler/);
  assert.match(patched, /n\.app\.on\(`second-instance`,codexLinuxSecondInstanceHandler\)/);
  assert.match(patched, /n\.app\.off\(`second-instance`,codexLinuxSecondInstanceHandler\)/);
});

test("recognizes bootstrap-owned single-instance handoff in current bundles", () => {
  const source = "let{setSecondInstanceArgsHandler:l}=t.y();l(e=>{let n=t.t(t.g(e));if(z.deepLinks.queueProcessArgs(e)){n&&le();return}if(n){le();return}le()});";
  const patched = applyPatchTwice(applyLinuxSingleInstancePatch, source);

  assert.equal(patched, source);
});

test("adds Linux launch actions through current setSecondInstanceArgsHandler bundles", () => {
  const launchPatched = applyPatchTwice(
    applyLinuxLaunchActionArgsPatch,
    currentLaunchActionBundleFixture(),
  );
  const prewarmPatched = applyPatchTwice(applyLinuxHotkeyWindowPrewarmPatch, launchPatched);

  assert.match(launchPatched, /codexLinuxGetSetting=e=>process\.platform!==`linux`\|\|j\.globalState\.get\(e\)!==!1/);
  assert.match(launchPatched, /codexLinuxStartLaunchActionSocket=\(\)=>/);
  assert.match(launchPatched, /f\.default\.createServer/);
  assert.match(launchPatched, /o\.mkdirSync\(i\.default\.dirname\(e\)/);
  assert.match(launchPatched, /R\.desktopNotificationManager\.dismissByNavigationPath\(e\)/);
  assert.match(launchPatched, /codexLinuxHasDeepLink\(e\)&&z\.deepLinks\.queueProcessArgs\(e\)/);
  assert.match(launchPatched, /e\.includes\(`--prompt-chat`\)/);
  assert.match(launchPatched, /e\.includes\(`--quick-chat`\)/);
  assert.match(launchPatched, /e\.includes\(`--new-chat`\)/);
  assert.match(launchPatched, /process\.platform===`linux`&&codexLinuxStartLaunchActionSocket\(\);l\(e=>/);
  assert.doesNotMatch(launchPatched, /l\(e=>\{z\.deepLinks\.queueProcessArgs\(e\)\|\|oe\(\)\}\)/);
  assert.match(
    prewarmPatched,
    /process\.platform===`linux`&&codexLinuxPrewarmHotkeyWindow\(\),A=Date\.now\(\),await z\.deepLinks\.flushPendingDeepLinks\(\)/,
  );
});

test("adds Linux launch actions when captured window identifiers contain dollar signs", () => {
  const source = currentLaunchActionBundleFixture().replace(
    "let ue=async(e,t)=>{M.hotkeyWindowLifecycleManager.hide();let n=M.getPrimaryWindow(),r=n??await M.createFreshLocalWindow(e);r!=null&&(R.desktopNotificationManager.dismissByNavigationPath(e),n!=null&&t.navigateExistingWindow&&z.navigateToRoute(r,e),ae(r))};",
    "let ue=async(e,t)=>{M.hotkeyWindowLifecycleManager.hide();let n=M.getPrimaryWindow(),r$=n??await M.createFreshLocalWindow(e);r$!=null&&(R.desktopNotificationManager.dismissByNavigationPath(e),n!=null&&t.navigateExistingWindow&&z.navigateToRoute(r$,e),ae(r$))};",
  );

  const patched = applyPatchTwice(applyLinuxLaunchActionArgsPatch, source);

  assert.match(patched, /codexLinuxHandleLaunchActionArgs/);
  assert.match(patched, /z\.navigateToRoute\(r\$,e\),ae\(r\$\)/);
  assert.match(patched, /codexLinuxQuitInProgress=!1/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxMarkQuitInProgress=\(\)=>\{codexLinuxQuitInProgress=!0\}/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /codexLinuxShouldBypassQuitPrompt=\(\)=>codexLinuxExplicitQuitApproved===!0/);
  assert.match(patched, /codexLinuxIsQuitInProgress=\(\)=>codexLinuxQuitInProgress===!0/);
  assert.match(patched, /codexLinuxGetSetting=e=>/);
  assert.match(patched, /codexLinuxHandleLaunchActionArgs=async e=>/);
  assert.match(patched, /codexLinuxHandleLaunchActionArgs=async e=>\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)\?!0:/);
  assert.match(patched, /codexLinuxHandleLaunchActionArgsFallback=\(e,t\)=>\{if\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)return;/);
  assert.match(patched, /codexLinuxStartLaunchActionSocket=\(\)=>/);
  assert.match(patched, /codexLinuxPrewarmHotkeyWindow=\(\)=>/);
  assert.match(patched, /e\.includes\(`--new-chat`\)/);
  assert.match(patched, /e\.includes\(`--quick-chat`\)/);
  assert.match(patched, /e\.includes\(`--prompt-chat`\)/);
  assert.match(patched, /e\.includes\(`--hotkey-window`\)/);
});

test("skips the launch-action patch without throwing when upstream startup architecture changes", () => {
  const source = [
    "async function Sg(){",
    "let{startedAtMs:r,setSparkleBridgeHandlers:s,setSecondInstanceArgsHandler:c}=e.o(),",
    "F=Lp({windowServices:M,ensureHostWindow:M.ensureHostWindow});",
    "e.mn().info(`Launching app`,{safe:{platform:process.platform,agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});",
    "let k=Date.now();",
    "await n.app.whenReady();",
    "let M=ng({windowManager:S}),",
    "te=zf();",
    "s({onInstallUpdatesRequested:te.allowQuitTemporarilyForUpdateInstall,isTrustedIpcEvent:A});",
    "c(e=>{F.deepLinks.queueProcessArgs(e)}),",
    "k=Date.now(),",
    "F.deepLinks.registerProtocolClient(),",
    "k=Date.now();",
    "let ie=await M.ensureHostWindow(y);",
    "ie&&(ie.isMinimized()&&ie.restore(),ie.show(),ie.focus()),",
    "k=Date.now(),",
    "await F.deepLinks.flushPendingDeepLinks(),",
    "w(`startup complete`,r)}",
  ].join("");

  assert.doesNotThrow(() => applyLinuxLaunchActionArgsPatch(source));
});

test("gates current close-to-tray setting through the captured global state", () => {
  const source = "let j=KD({moduleDir:__dirname});let M=FM({buildFlavor:a,globalState:j.globalState,canHideLastLocalWindowToTray:()=>O,disposables:k});t.Mr().info(`Launching app`);";
  const patched = applyPatchTwice(applyLinuxTrayCloseSettingPatch, source);

  assert.match(
    patched,
    /canHideLastLocalWindowToTray:\(\)=>O&&\(process\.platform!==`linux`\|\|j\.globalState\.get\(`codex-linux-system-tray-enabled`\)!==!1\),disposables:k/,
  );
  assert.doesNotMatch(patched, /M\.globalState\.get/);
});

test("does not treat unrelated Linux setting references as close-to-tray patched", () => {
  const source = [
    "let j=KD({moduleDir:__dirname});",
    "let M=FM({buildFlavor:a,globalState:j.globalState,canHideLastLocalWindowToTray:()=>O,disposables:k});",
    "let codexLinuxGetSetting=e=>process.platform!==`linux`||j.globalState.get(`codex-linux-system-tray-enabled`)!==!1;",
    "t.Mr().info(`Launching app`);",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayCloseSettingPatch, source);

  assert.match(
    patched,
    /canHideLastLocalWindowToTray:\(\)=>O&&\(process\.platform!==`linux`\|\|j\.globalState\.get\(`codex-linux-system-tray-enabled`\)!==!1\),disposables:k/,
  );
});

test("chooses the nearest globalState alias for close-to-tray settings", () => {
  const source = [
    "let stale={globalState:{get(){return false}}};",
    "let j=KD({moduleDir:__dirname});",
    "let M=FM({buildFlavor:a,globalState:j.globalState,canHideLastLocalWindowToTray:()=>O,disposables:k});",
    "t.Mr().info(`Launching app`);",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayCloseSettingPatch, source);

  assert.match(
    patched,
    /canHideLastLocalWindowToTray:\(\)=>O&&\(process\.platform!==`linux`\|\|j\.globalState\.get\(`codex-linux-system-tray-enabled`\)!==!1\),disposables:k/,
  );
  assert.doesNotMatch(patched, /stale\.globalState\.get\(`codex-linux-system-tray-enabled`\)/);
});

test("allows bundled Computer Use on Linux as well as macOS", () => {
  const patched = applyPatchTwice(
    applyLinuxComputerUsePluginGatePatch,
    computerUseGateBundleFixture(),
  );

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:tn,isEnabled:\(\{features:e,platform:t\}\)=>\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/,
  );
  assert.doesNotMatch(patched, /t===`darwin`&&e\.computerUse/);
});

test("adds Keybinds settings route after upstream minified variable drift", () => {
  const patched = applyPatchTwice(applyKeybindsSettingsIndexPatch, keybindsIndexBundleFixture());

  assert.match(
    patched,
    /var i_e=\{keybinds:\(0,Z\.lazy\)\(\(\)=>s\(\(\)=>import\(`\.\/keybinds-settings-linux\.js`\)/,
  );
  assert.match(patched, /var Kge=\{keybinds:xh,"general-settings":xh,/);
  assert.match(patched, /qge=\[`general-settings`,`keybinds`,`appearance`/);
  assert.match(patched, /slugs:\[`general-settings`,`keybinds`,`appearance`/);
  assert.match(patched, /case`keybinds`:return l===`electron`/);
  assert.match(patched, /case`keybinds`:k=!1;break bb0;/);
  assert.match(patched, /codexLinuxKeybindOverridesRuntime/);
});

test("disables the upstream app sunset gate in the Linux wrapper webview", () => {
  const patched = applyPatchTwice(applyLinuxAppSunsetPatch, appSunsetBundleFixture());

  assert.match(patched, /if\(!1&&ms\(`2929582856`\)\)\{/);
  assert.doesNotMatch(patched, /if\(ms\(`2929582856`\)\)\{/);
});

test("disables the upstream app sunset gate after minified alias drift", () => {
  const patched = applyPatchTwice(applyLinuxAppSunsetPatch, appSunsetBundleWithDriftingAliasFixture());

  assert.match(patched, /if\(!1&&xs\(`2929582856`\)\)\{/);
  assert.doesNotMatch(patched, /if\(xs\(`2929582856`\)\)\{/);
});

test("warns when the app sunset key is present but the gate shape drifts", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxAppSunsetPatch(appSunsetBundleWithDriftingGateFixture()),
  );

  assert.equal(patched, appSunsetBundleWithDriftingGateFixture());
  assert.deepEqual(warnings, [
    "WARN: Could not find app sunset gate needle — skipping Linux app sunset patch",
  ]);
});

test("adds Linux package updater behind the existing app updater manager", () => {
  const patched = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, appUpdaterBundleFixture());

  assert.match(patched, /function codexLinuxReadUpdateState\(\)/);
  assert.match(patched, /function codexLinuxUpdateLifecycleState\(e\)/);
  assert.match(patched, /function codexLinuxUpdateManagerPath\(\)/);
  assert.match(patched, /async function codexLinuxShowUpdateMessage\(codexLinuxMessage,codexLinuxDetail\)/);
  assert.match(patched, /function codexLinuxInstallAfterQuit\(\)/);
  assert.match(patched, /function codexLinuxQuitForUpdate\(\)/);
  assert.match(patched, /t\.dialog\?\.showMessageBox\(\{type:`info`/);
  assert.match(patched, /u\.spawn\(`\/bin\/sh`/);
  assert.match(patched, /install-ready\|\|exit \$\?/);
  assert.match(patched, /grep -q "\^status: WaitingForAppExit"/);
  assert.match(patched, /status: Installing/);
  assert.match(patched, /grep -q "\^status: Installed"/);
  assert.match(patched, /\/usr\/bin\/codex-desktop >\/dev\/null 2>&1 &/);
  assert.match(patched, /detached:!0,stdio:`ignore`/);
  assert.match(patched, /codexLinuxInstallAfterQuit\(\);let e=setTimeout/);
  assert.match(patched, /t\.app\?\.quit\?\.\(\)/);
  assert.match(patched, /t\.app\?\.exit\?\.\(0\)/);
  assert.match(patched, /execFile\(codexLinuxUpdateManagerPath\(\),e/);
  assert.match(patched, /async function codexLinuxProbeUpdateManager\(\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`--help`\]\)/);
  assert.match(patched, /async function codexLinuxRefreshUpdateState\(\)/);
  assert.match(patched, /async function codexLinuxRefreshUpdateState\(\)\{return codexLinuxReadUpdateState\(\)\}/);
  assert.doesNotMatch(patched, /codexLinuxRunUpdateManager\(\[`status`,`--json`\]\)/);
  assert.match(patched, /await codexLinuxProbeUpdateManager\(\),e\(\)/);
  assert.match(patched, /if\(!this\.options\.enableUpdater&&process\.platform!==`linux`\)/);
  assert.match(patched, /process\.platform===`linux`\?await this\.initializeLinuxPackageUpdater\(\)/);
  assert.match(patched, /async initializeLinuxPackageUpdater\(\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`check-now`\]\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`install-ready`\]\)/);
  assert.match(patched, /this\.setInstallProgressPercent\(0\),this\.setUpdateLifecycleState\(`installing`\)/);
  assert.match(patched, /this\.setInstallProgressPercent\(null\),codexLinuxQuitForUpdate\(\)/);
  assert.doesNotMatch(patched, /this\.options\.onInstallUpdatesRequested\?\.\(\)/);
  assert.match(patched, /n\.stdout\?\.includes\(`already installed`\)\?await codexLinuxShowUpdateMessage/);
  assert.match(patched, /if\(t\?\.status===`waiting_for_app_exit`\)/);
});

test("does not run bootstrap probe-state migration on class-style updater bundles", () => {
  const source = `function unrelated(){i();let o=1;return o}${appUpdaterBundleFixture()}`;
  const patched = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, source);

  assert.match(patched, /function unrelated\(\)\{i\(\);let o=1;return o\}/);
  assert.match(patched, /await codexLinuxProbeUpdateManager\(\),e\(\)/);
  assert.doesNotMatch(patched, /let s=!1,c=codexLinuxProbeUpdateManager/);
  assert.doesNotMatch(patched, /getIsUpdateReady:\(\)=>s&&t/);
});

test("adds Linux package updater to current bootstrap updater wiring", () => {
  const patched = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, currentBootstrapUpdaterBundleFixture());

  assert.match(patched, /function codexLinuxCreatePackageUpdateManager\(/);
  assert.match(patched, /codexLinuxPackageUpdateBridge=process\.platform===`linux`/);
  assert.match(patched, /send:e=>M\.sendMessageToAllRegisteredWindows\(e\)/);
  assert.doesNotMatch(patched, /send:e=>a\.sendMessageToAllRegisteredWindows\(e\)/);
  assert.match(patched, /s=codexLinuxPackageUpdateBridge\.manager/);
  assert.match(patched, /te=codexLinuxPackageUpdateBridge\.quitForUpdate/);
  assert.match(patched, /async function codexLinuxProbeUpdateManager\(\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`--help`\]\)/);
  assert.match(patched, /async function codexLinuxRefreshUpdateState\(\)\{return codexLinuxReadUpdateState\(\)\}/);
  assert.match(patched, /codexLinuxProbeUpdateManager\(\)\.then\(\(\)=>\{s=!0,i\(\),a\(\);return!0\}\)/);
  assert.match(patched, /getIsUpdateReady:\(\)=>s&&t/);
  assert.match(patched, /checkForUpdates:async\(\)=>\{if\(!await c\)return;n=`checking`/);
  assert.match(patched, /installUpdatesIfAvailable:async\(\)=>\{if\(!await c\)\{a\(\);return\}i\(\);if\(!t\)\{a\(\);return\}/);
  assert.match(patched, /refresh:async\(\)=>\{if\(await c\)\{try\{await codexLinuxRefreshUpdateState\(\)\}/);
  assert.doesNotMatch(patched, /codexLinuxRunUpdateManager\(\[`status`,`--json`\]\)/);
});

test("migrates already-patched bootstrap updater bridge to probe before enabling UI", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(currentBootstrapUpdaterBundleFixture());
  const oldPatched = patched
    .replace(
      "let s=!1,c=codexLinuxProbeUpdateManager().then(()=>{s=!0,i(),a();return!0}).catch(()=>{s=!1,t=!1,n=`idle`,a();return!1});let o=",
      "i(),codexLinuxRefreshUpdateState().then(()=>{i(),a()}).catch(()=>{});let o=",
    )
    .replace(
      "getIsUpdateReady:()=>s&&t,getUpdateLifecycleState:()=>s?n:`idle`,",
      "getIsUpdateReady:()=>t,getUpdateLifecycleState:()=>n,",
    )
    .replace(
      "checkForUpdates:async()=>{if(!await c)return;n=`checking`,a();try{",
      "checkForUpdates:async()=>{n=`checking`,a();try{",
    )
    .replace(
      "installUpdatesIfAvailable:async()=>{if(!await c){a();return}i();if(!t){a();return}",
      "installUpdatesIfAvailable:async()=>{i();if(!t)return;",
    )
    .replace(
      "refresh:async()=>{if(await c){try{await codexLinuxRefreshUpdateState()}catch{}i()}else t=!1,n=`idle`;a()}",
      "refresh:async()=>{try{await codexLinuxRefreshUpdateState()}catch{}i(),a()}",
    );

  const migrated = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, oldPatched);

  assert.match(migrated, /codexLinuxProbeUpdateManager\(\)\.then\(\(\)=>\{s=!0,i\(\),a\(\);return!0\}\)/);
  assert.match(migrated, /getIsUpdateReady:\(\)=>s&&t/);
  assert.match(migrated, /installUpdatesIfAvailable:async\(\)=>\{if\(!await c\)\{a\(\);return\}i\(\);if\(!t\)\{a\(\);return\}/);
});

test("migrates previous bootstrap updater bridge without leaving undefined probe state", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(currentBootstrapUpdaterBundleFixture());
  const oldPatched = patched
    .replace(
      "async function codexLinuxProbeUpdateManager(){await codexLinuxRunUpdateManager([`--help`])}",
      "",
    )
    .replace(
      "async function codexLinuxRefreshUpdateState(){return codexLinuxReadUpdateState()}",
      "",
    )
    .replace(
      ",s=!1,c=codexLinuxProbeUpdateManager().then(()=>{s=!0,i(),a();return!0}).catch(()=>{s=!1,t=!1,n=`idle`,a();return!1});let o=",
      ";i();let o=",
    )
    .replace(
      "getIsUpdateReady:()=>s&&t,getUpdateLifecycleState:()=>s?n:`idle`,",
      "getIsUpdateReady:()=>t,getUpdateLifecycleState:()=>n,",
    )
    .replace(
      "checkForUpdates:async()=>{if(!await c)return;n=`checking`,a();try{",
      "checkForUpdates:async()=>{n=`checking`,a();try{",
    )
    .replace(
      "installUpdatesIfAvailable:async()=>{if(!await c){a();return}i();if(!t){a();return}",
      "installUpdatesIfAvailable:async()=>{i();if(!t)return;",
    )
    .replace(
      "refresh:async()=>{if(await c){try{await codexLinuxRefreshUpdateState()}catch{}i()}else t=!1,n=`idle`;a()}",
      "refresh:()=>{i(),a()}",
    );

  assert.doesNotMatch(oldPatched, /codexLinuxProbeUpdateManager/);
  assert.doesNotMatch(oldPatched, /codexLinuxRefreshUpdateState/);
  assert.match(oldPatched, /i\(\);let o=/);

  const migrated = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, oldPatched);

  assert.match(migrated, /async function codexLinuxProbeUpdateManager\(\)\{await codexLinuxRunUpdateManager\(\[`--help`\]\)\}/);
  assert.match(migrated, /async function codexLinuxRefreshUpdateState\(\)\{return codexLinuxReadUpdateState\(\)\}/);
  assert.match(migrated, /let s=!1,c=codexLinuxProbeUpdateManager\(\)\.then/);
  assert.match(migrated, /getIsUpdateReady:\(\)=>s&&t/);
  assert.match(migrated, /checkForUpdates:async\(\)=>\{if\(!await c\)return;n=`checking`/);
  assert.match(migrated, /installUpdatesIfAvailable:async\(\)=>\{if\(!await c\)\{a\(\);return\}i\(\);if\(!t\)\{a\(\);return\}/);
  assert.match(migrated, /refresh:async\(\)=>\{if\(await c\)\{try\{await codexLinuxRefreshUpdateState\(\)\}/);
});

test("migrates already-patched Linux updater bridge to probe without mutating refresh", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(appUpdaterBundleFixture());
  const oldPatched = patched
    .replace(
      "async function codexLinuxProbeUpdateManager(){await codexLinuxRunUpdateManager([`--help`])}",
      "",
    )
    .replace(
      "async function codexLinuxRefreshUpdateState(){return codexLinuxReadUpdateState()}",
      "async function codexLinuxRefreshUpdateState(){await codexLinuxRunUpdateManager([`status`,`--json`]);return codexLinuxReadUpdateState()}",
    )
    .replace(
      "await codexLinuxProbeUpdateManager(),e()",
      "await codexLinuxRefreshUpdateState(),e()",
    );

  const migrated = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, oldPatched);

  assert.match(migrated, /async function codexLinuxProbeUpdateManager\(\)\{await codexLinuxRunUpdateManager\(\[`--help`\]\)\}/);
  assert.match(migrated, /async function codexLinuxRefreshUpdateState\(\)\{return codexLinuxReadUpdateState\(\)\}/);
  assert.match(migrated, /await codexLinuxProbeUpdateManager\(\),e\(\)/);
  assert.doesNotMatch(migrated, /codexLinuxRunUpdateManager\(\[`status`,`--json`\]\)/);
});

test("migrates an already-patched Linux updater bridge to quit before install", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(appUpdaterBundleFixture());
  const oldPatched = patched
    .replace(/function codexLinuxInstallAfterQuit\(\)\{try\{let e=u\.spawn\(`\/bin\/sh`,\[`-c`,[^]*?\);e\.unref\?\.\(\)\}catch\{\}\}/, "")
    .replace(
      /function codexLinuxQuitForUpdate\(\)\{try\{codexLinuxInstallAfterQuit\(\);let e=setTimeout\(\(\)=>t\.app\?\.exit\?\.\(0\),1500\);e\.unref\?\.\(\),t\.app\?\.quit\?\.\(\)\}catch\{\}\}/,
      "function codexLinuxQuitForUpdate(){try{let e=setTimeout(()=>t.app?.exit?.(0),1500);e.unref?.(),t.app?.quit?.()}catch{}}",
    )
    .replace("codexLinuxQuitForUpdate();return", "this.options.onInstallUpdatesRequested?.();return");
  assert.doesNotMatch(oldPatched, /function codexLinuxInstallAfterQuit\(\)/);
  assert.match(oldPatched, /this\.options\.onInstallUpdatesRequested\?\.\(\)/);
  const migrated = applyLinuxAppUpdaterBridgePatch(oldPatched);

  assert.match(migrated, /function codexLinuxInstallAfterQuit\(\)/);
  assert.match(migrated, /function codexLinuxQuitForUpdate\(\)/);
  assert.match(migrated, /codexLinuxInstallAfterQuit\(\);let e=setTimeout/);
  assert.match(migrated, /this\.setInstallProgressPercent\(null\),codexLinuxQuitForUpdate\(\)/);
  assert.doesNotMatch(migrated, /this\.options\.onInstallUpdatesRequested\?\.\(\)/);
});

test("migrates an already-patched Linux updater bridge to relaunch after install", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(appUpdaterBundleFixture());
  const oldHelper =
    "function codexLinuxInstallAfterQuit(){try{let e=u.spawn(`/bin/sh`,[`-c`,`for i in 1 2 3 4 5 6 7 8 9 10;do sleep 1;\"$1\" install-ready||exit $?;\"$1\" status|grep -q \"^status: WaitingForAppExit\"||exit 0;done`,`codex-linux-update-install`,codexLinuxUpdateManagerPath()],{detached:!0,stdio:`ignore`,windowsHide:!0});e.unref?.()}catch{}}";
  const oldPatched = patched.replace(
    /function codexLinuxInstallAfterQuit\(\)\{try\{let e=u\.spawn\(`\/bin\/sh`,\[`-c`,[^]*?e\.unref\?\.\(\)\}catch\{\}\}/,
    oldHelper,
  );
  assert.doesNotMatch(oldPatched, /\/usr\/bin\/codex-desktop/);

  const migrated = applyLinuxAppUpdaterBridgePatch(oldPatched);

  assert.match(migrated, /grep -q "\^status: Installed"/);
  assert.match(migrated, /\/usr\/bin\/codex-desktop >\/dev\/null 2>&1 &/);
});

test("enables the existing app update menu on Linux", () => {
  const source =
    "let{startedAtMs:r,buildFlavor:a,desktopSentry:o,sparkleManager:s,setSparkleBridgeHandlers:c,setSecondInstanceArgsHandler:l}=t.y(),u=t.Z(a),d=t.C.shouldIncludeSparkle(a,process.platform,process.env),f=t.C.shouldIncludeUpdater(a,process.platform,process.env);Yb({enableSparkle:d});";
  const patched = applyPatchTwice(applyLinuxAppUpdaterMenuPatch, source);

  assert.match(
    patched,
    /d=t\.C\.shouldIncludeSparkle\(a,process\.platform,process\.env\)\|\|process\.platform===`linux`/,
  );
});

test("patchLinuxAppUpdaterBridge scans build bundles and stays idempotent", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-bridge-test-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "workspace-root-drop-handler.js"), appUpdaterBundleFixture());
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      "let{startedAtMs:r,buildFlavor:a,desktopSentry:o,sparkleManager:s,setSparkleBridgeHandlers:c,setSecondInstanceArgsHandler:l}=t.y(),u=t.Z(a),d=t.C.shouldIncludeSparkle(a,process.platform,process.env),f=t.C.shouldIncludeUpdater(a,process.platform,process.env);Yb({enableSparkle:d});",
    );

    const first = patchLinuxAppUpdaterBridge(tempRoot);
    const manager = fs.readFileSync(path.join(buildDir, "workspace-root-drop-handler.js"), "utf8");
    const main = fs.readFileSync(path.join(buildDir, "main.js"), "utf8");
    const second = patchLinuxAppUpdaterBridge(tempRoot);

    assert.deepEqual(first, { matched: 2, changed: 2 });
    assert.deepEqual(second, { matched: 2, changed: 0 });
    assert.match(manager, /initializeLinuxPackageUpdater/);
    assert.match(main, /\|\|process\.platform===`linux`/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("adds installWhenMissing to an already Linux-enabled Computer Use gate", () => {
  const source = computerUseGateBundleFixture().replace(
    "{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:wn}",
    "{name:tn,isEnabled:({features:e,platform:t})=>(t===`darwin`||t===`linux`)&&e.computerUse,migrate:wn}",
  );

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /installWhenMissing:!0,name:tn/);
  assert.equal((patched.match(/installWhenMissing:!0,name:tn/g) || []).length, 1);
});

test("keeps scanning Computer Use gates after an already patched match", () => {
  const source = [
    "var tn=`computer-use`;",
    "var $n=[{installWhenMissing:!0,name:tn,isEnabled:({features:e,platform:t})=>(t===`darwin`||t===`linux`)&&e.computerUse,migrate:on},{name:tn,isEnabled:({features:n,platform:r})=>r===`darwin`&&n.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(
    patched,
    /name:tn,isEnabled:\(\{features:n,platform:r\}\)=>\(r===`darwin`\|\|r===`linux`\)&&n\.computerUse,migrate:wn/,
  );
  assert.equal((patched.match(/installWhenMissing:!0,name:tn/g) || []).length, 2);
  assert.doesNotMatch(patched, /r===`darwin`&&n\.computerUse/);
});

test("handles reordered Computer Use gate destructuring", () => {
  const darwinOnlySource = [
    "var tn=`computer-use`;",
    "var $n=[{name:tn,isEnabled:({platform:t,features:e})=>t===`darwin`&&e.computerUse,migrate:wn}];",
  ].join("");
  const alreadyLinuxEnabledSource = [
    "var tn=`computer-use`;",
    "var $n=[{installWhenMissing:!0,name:tn,isEnabled:({platform:t,features:e})=>(t===`darwin`||t===`linux`)&&e.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, darwinOnlySource);

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:tn,isEnabled:\(\{features:e,platform:t\}\)=>\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse,migrate:wn\}/,
  );
  assert.equal(applyPatchTwice(applyLinuxComputerUsePluginGatePatch, alreadyLinuxEnabledSource), alreadyLinuxEnabledSource);
});

test("targets literal Computer Use gate names without patching unrelated descriptors", () => {
  const source = [
    "var other=`other-plugin`;",
    "var $n=[{name:other,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:on},{name:`computer-use`,isEnabled:({platform:t,features:e})=>t===`darwin`&&e.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /name:other,isEnabled:\(\{features:e,platform:t\}\)=>t===`darwin`&&e\.computerUse,migrate:on/);
  assert.match(
    patched,
    /name:`computer-use`,isEnabled:\(\{features:e,platform:t\}\)=>\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse,migrate:wn/,
  );
});

test("handles quoted Computer Use gate names", () => {
  const boundNameSource = [
    "var tn=\"computer-use\";",
    "var $n=[{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:wn}];",
  ].join("");
  const literalNameSource = "var $n=[{name:'computer-use',isEnabled:({platform:t,features:e})=>t===`darwin`&&e.computerUse,migrate:wn}];";

  const patchedBoundName = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, boundNameSource);
  const patchedLiteralName = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, literalNameSource);

  assert.match(patchedBoundName, /installWhenMissing:!0,name:tn/);
  assert.match(patchedBoundName, /\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/);
  assert.match(patchedLiteralName, /installWhenMissing:!0,name:'computer-use'/);
  assert.match(patchedLiteralName, /\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/);
});

test("patches the current Computer Use gate without touching the Windows-internal descriptor", () => {
  const source = [
    "var Ye=`browser-use`,Xe=`chrome-internal`,Ze=`computer-use`,Qe=`latex-tectonic`;",
    "var Dr=[{forceReload:!0,installWhenMissing:!0,name:Ye,isEnabled:({features:e})=>e.browserAgentAvailable,migrate:In},{forceReload:!0,name:Xe,isEnabled:({buildFlavor:e})=>Mn(e)},{name:Ze,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:Qn},{installWhenMissing:!0,name:Ze,isEnabled:({buildFlavor:e,features:n,platform:r})=>t.C.isInternal(e)&&r===`win32`&&n.computerUse},{name:Qe,isEnabled:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /name:Ze,isEnabled:\(\{features:e,platform:t\}\)=>\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse,migrate:Qn/);
  assert.match(patched, /t\.C\.isInternal\(e\)&&r===`win32`&&n\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:Ze/g) || []).length, 2);
});

test("patches the current isAvailable Computer Use gate shape", () => {
  const source = currentPluginGateBundleFixture();

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /name:ft,isAvailable:\(\{features:e,platform:t\}\)=>\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse,migrate:vr/);
  assert.match(patched, /t\.T\.isInternal\(e\)&&r===`win32`&&n\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:ft/g) || []).length, 2);
});

test("auto-installs the current Chrome plugin gate shape", () => {
  const patched = applyPatchTwice(
    applyLinuxChromePluginAutoInstallPatch,
    currentPluginGateBundleFixture(),
  );

  assert.match(
    patched,
    /\{forceReload:!0,installWhenMissing:!0,name:ut,isAvailable:\(\{buildFlavor:e,features:t\}\)=>t\.externalBrowserUseAllowed&&\$n\(e\)\}/,
  );
  assert.match(patched, /name:dt,isAvailable:\(\{buildFlavor:e,features:t\}\)=>Qn\(e\)&&t\.externalBrowserUseAllowed/);
  assert.equal((patched.match(/installWhenMissing:!0,name:ut/g) || []).length, 1);
  assert.equal((patched.match(/installWhenMissing:!0,name:dt/g) || []).length, 0);
});

test("keeps an already auto-installed Chrome plugin gate unchanged", () => {
  const source = currentPluginGateBundleFixture().replace(
    "{forceReload:!0,name:ut,isAvailable:",
    "{forceReload:!0,installWhenMissing:!0,name:ut,isAvailable:",
  );

  assert.equal(applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source), source);
});

test("handles literal Chrome plugin gate names", () => {
  const source =
    "var Kr=[{forceReload:!0,name:'chrome',isEnabled:({features:t})=>t.externalBrowserUseAllowed},{forceReload:!0,name:'chrome-internal',isEnabled:({features:t})=>t.externalBrowserUseAllowed}];";

  const patched = applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source);

  assert.match(patched, /installWhenMissing:!0,name:'chrome'/);
  assert.doesNotMatch(patched, /installWhenMissing:!0,name:'chrome-internal'/);
});

test("reports missing required Chrome plugin auto-install gate as upstream validation failure", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-chrome-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), `${mainBundlePrefix}var plugins=[];`);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const pluginGatePatch = report.patches.find((patch) => patch.name === "linux-chrome-plugin-auto-install");
    assert.equal(pluginGatePatch.status, "skipped-optional");
    assert.match(pluginGatePatch.reason, /Could not find Chrome plugin gate literal/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-chrome-plugin-auto-install: skipped-optional"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patches Computer Use gates that use imported namespace constants", () => {
  const source = [
    "var lt=`computer-use`;",
    "var Ur=[{autoInstallOptOutKey:e.Nn(e.Dn),forceReload:!0,installWhenMissing:!0,name:e.Dn,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:$n},{name:e.kn,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:mr},{installWhenMissing:!0,name:e.kn,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.T.isInternal(e)&&r===`win32`&&n.computerUse},{name:e.An,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /installWhenMissing:!0,name:e\.kn,isAvailable:\(\{features:e,platform:t\}\)=>\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse,migrate:mr/);
  assert.match(patched, /t\.T\.isInternal\(e\)&&r===`win32`&&n\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:e\.kn/g) || []).length, 2);
});

test("fails hard when the Computer Use gate is recognizable but unpatchable", () => {
  assert.throws(
    () => applyLinuxComputerUsePluginGatePatch("var tn=`computer-use`;var x=[{name:tn,isEnabled:({features:e,platform:t})=>isMac(t)&&e.computerUse,migrate:wn}];"),
    /Required Linux Computer Use plugin gate patch failed/,
  );
});

test("reports missing required Computer Use plugin gate as upstream validation failure", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-computer-use-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), `${mainBundlePrefix}var plugins=[];`);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const pluginGatePatch = report.patches.find((patch) => patch.name === "linux-computer-use-plugin-gate");
    assert.equal(pluginGatePatch.status, "skipped-optional");
    assert.match(pluginGatePatch.reason, /Could not find Computer Use plugin gate literal/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-computer-use-plugin-gate: skipped-optional"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("enables Computer Use desktop features on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxComputerUseFeaturePatch,
    computerUseFeatureBundleFixture(),
  );

  assert.match(
    patched,
    /return n===`linux`\?\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}:n!==`win32`\|\|t\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`\?e:\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}/,
  );
  assert.match(patched, /CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE/);
});

test("enables current Computer Use desktop features on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxComputerUseFeaturePatch,
    currentComputerUseFeatureBundleFixture(),
  );

  assert.match(
    patched,
    /let a=i===`linux`\?\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}:i===`win32`&&r\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}:e,o=n===t\.D\.Dev\?be\(r\):null;return o==null\?a:\{\.\.\.a,\.\.\.o\}/,
  );
  assert.match(patched, /CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE/);
});

test("shows Computer Use plugin UI on Linux without the upstream rollout flag", () => {
  const patched = applyPatchTwice(
    applyLinuxComputerUseRendererAvailabilityPatch,
    computerUseRendererAvailabilityBundleFixture(),
  );

  assert.match(patched, /function hae\(e\)\{return e===`macOS`\|\|e===`windows`\|\|e===`linux`\}/);
  assert.match(
    patched,
    /let m=a&&\(i\|\|l===`linux`\)&&s===`electron`&&\(l===`linux`\|\|u&&\(c\|\|p\)\),h=m&&!c&&\(l===`linux`\|\|f\.enabled\)&&!f\.isLoading,g=m&&l!==`linux`&&f\.isLoading,_=m&&\(c\|\|l!==`linux`&&f\.isLoading\),v;/,
  );
});

test("shows current Computer Use plugin UI on Linux without the upstream rollout flag", () => {
  const source =
    "function g(e){return e===`macOS`||e===`windows`}" +
    "function _(e){let t=(0,d.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,{isLoading:o,platform:c}=u(),l=s(`1506311413`),f;t[0]===r?f=t[1]:(f={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=f);let p=h(f),m;t[2]===c?m=t[3]:(m=g(c),t[2]=c,t[3]=m);let _=a&&i&&l&&(o||m),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;return x}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /function g\(e\)\{return e===`macOS`\|\|e===`windows`\|\|e===`linux`\}/);
  assert.match(
    patched,
    /let _=a&&i&&\(c===`linux`\|\|l&&\(o\|\|m\)\),v=_&&!o&&\(c===`linux`\|\|p\.enabled\)&&!p\.isLoading,y=_&&c!==`linux`&&p\.isLoading,b=_&&\(o\|\|c!==`linux`&&p\.isLoading\),x;/,
  );
});

test("allows Computer Use install flow on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxComputerUseInstallFlowPatch,
    computerUseInstallFlowBundleFixture(),
  );

  assert.match(
    patched,
    /re=!ne\.isLoading&&ne\.enabled\|\|navigator\.userAgent\.includes\(`Linux`\)/,
  );
});

test("allows current Computer Use install flow on Linux", () => {
  const source =
    "te=ne({featureName:`computer_use`,hostId:t}),z=B({hostId:t,isHostLocal:m}),ie=re({hostId:t,isHostLocal:m}),U=!te.isLoading&&te.enabled,G=z.available,oe=ie.available,";

  const patched = applyPatchTwice(applyLinuxComputerUseInstallFlowPatch, source);

  assert.equal(
    patched,
    "te=ne({featureName:`computer_use`,hostId:t}),z=B({hostId:t,isHostLocal:m}),ie=re({hostId:t,isHostLocal:m}),U=!te.isLoading&&te.enabled||navigator.userAgent.includes(`Linux`),G=z.available,oe=ie.available,",
  );
});

test("auto-approves the app-provided Browser Use node_repl bridge", () => {
  const source =
    "return{[`mcp_servers.${pt}`]:{command:i.nodeReplPath,args:[],startup_timeout_sec:120,env:{[dt]:l,[ft]:i.nodePath}}}";

  const patched = applyPatchTwice(applyBrowserUseNodeReplApprovalPatch, source);

  assert.match(patched, /tools:\{js:\{approval_mode:`approve`\}\}/);
  assert.match(patched, /env:\{\[dt\]:l,\[ft\]:i\.nodePath/);
});

test("shows the Linux IAB panel after Browser Use creates or reuses a tab", () => {
  const source =
    "var CF=class{async createTabForBrowserUse(e){let t=this.getActiveBrowserUseTab(e,{assertCurrentPageAllowed:!1});if(t!=null)return await this.navigateTabToInitialPage(t),this.serializeTab(t);let n=this.getRequiredBrowserHost(e);n.setBrowserUseActive(!0,e.turnId);let r=await n.openPageForBrowserUse({startingUrl:this.initialPageUrl,turnId:e.turnId}),i=this.updateTabForPage(r,n.routeKey);return SF().info(`IAB_LIFECYCLE iab createTab mapped page to tab`,{}),this.markBrowserUseCommandForTab(e,i),this.selectedTabIdsByRouteKey.set(n.routeKey,i.cdpTabId),this.serializeTab(i)}};";

  const patched = applyPatchTwice(applyLinuxBrowserUseIabVisibleOnCreatePatch, source);

  assert.match(
    patched,
    /this\.getRequiredBrowserHost\(e\)\.setBrowserVisibleForBrowserUse\(!0,e\.turnId\)/,
  );
  assert.match(patched, /n\.setBrowserVisibleForBrowserUse\(!0,e\.turnId\)/);
  assert.match(patched, /codexLinuxBrowserUseAutoVisible/);
  assert.match(
    patched,
    /return \(\(\)=>\{try\{n\.setBrowserVisibleForBrowserUse\(!0,e\.turnId\)\}/,
  );
});

test("detects Chrome extension installation from Linux browser profiles", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeExtensionStatusPatch,
    chromeExtensionStatusBundleFixture(),
  );

  assert.match(patched, /function codexLinuxChromeProfileRoots/);
  assert.match(patched, /`BraveSoftware`,`Brave-Browser`/);
  assert.match(patched, /`google-chrome-unstable`/);
  assert.match(
    patched,
    /if\(a===`linux`\)return codexLinuxChromeHasExtension\(\{extensionId:e,homeDir:t,platform:a\}\)/,
  );
  assert.match(
    patched,
    /if\(t===`linux`\)\{let t=codexLinuxChromeCommand\(\)\?\?n\(\);if\(t==null\)throw Error\(`Google Chrome, Brave, or Chromium is not installed`\);await r\(t,\[cm\(e\)\]\);return\}/,
  );
  assert.match(patched, /process\.env\.PATH\?\?``/);
  assert.doesNotMatch(patched, /function codexLinuxChromeCommand\(\)\{for\(let e of\[[^\]]+\]\)\{let t=Rp/);
});

test("detects Chrome extension installation after upstream minifier renames", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeExtensionStatusPatch,
    currentChromeExtensionStatusBundleFixture(),
  );

  assert.match(patched, /function codexLinuxChromeProfileRoots/);
  assert.match(patched, /let r=um\(e\);for\(let e of codexLinuxChromeProfileRoots/);
  assert.match(patched, /function om\(\{extensionId:e,homeDir:t=\(0,r\.homedir\)\(\)/);
  assert.match(patched, /c=dm\(\{homeDir:t,localAppDataDir:n,platform:a\}\)/);
  assert.match(
    patched,
    /async function sm\(\{extensionId:e,platform:t=process\.platform,detectChromeCommand:n=cm,runCommand:r=zp\}\)/,
  );
  assert.match(patched, /await r\(rm,\[`-b`,nm,am\(e\)\]\)/);
  assert.match(
    patched,
    /if\(t===`linux`\)\{let t=codexLinuxChromeCommand\(\)\?\?n\(\);if\(t==null\)throw Error\(`Google Chrome, Brave, or Chromium is not installed`\);await r\(t,\[am\(e\)\]\);return\}/,
  );
});

function withIsolatedHome(body) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cu-ui-test-"));
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousAppId = process.env.CODEX_APP_ID;
  const previousLinuxAppId = process.env.CODEX_LINUX_APP_ID;
  const previousFlag = process.env[COMPUTER_USE_UI_ENV_VAR];
  process.env.HOME = tempHome;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CODEX_APP_ID;
  delete process.env.CODEX_LINUX_APP_ID;
  delete process.env[COMPUTER_USE_UI_ENV_VAR];
  try {
    return body(tempHome);
  } finally {
    if (previousHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdg == null) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdg;
    }
    if (previousAppId == null) {
      delete process.env.CODEX_APP_ID;
    } else {
      process.env.CODEX_APP_ID = previousAppId;
    }
    if (previousLinuxAppId == null) {
      delete process.env.CODEX_LINUX_APP_ID;
    } else {
      process.env.CODEX_LINUX_APP_ID = previousLinuxAppId;
    }
    if (previousFlag == null) {
      delete process.env[COMPUTER_USE_UI_ENV_VAR];
    } else {
      process.env[COMPUTER_USE_UI_ENV_VAR] = previousFlag;
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
}

function writeSettingsFile(home, content, appId = "codex-desktop") {
  const dir = path.join(home, ".config", appId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), content, "utf8");
}

test("isComputerUseUiEnabled defaults to false without env var or settings flag", () => {
  withIsolatedHome(() => {
    assert.equal(isComputerUseUiEnabled(), false);
  });
});

test("isComputerUseUiEnabled honours the env var", () => {
  withIsolatedHome(() => {
    process.env[COMPUTER_USE_UI_ENV_VAR] = "1";
    assert.equal(isComputerUseUiEnabled(), true);
    process.env[COMPUTER_USE_UI_ENV_VAR] = "true";
    assert.equal(isComputerUseUiEnabled(), false, "only the literal string '1' should opt in");
  });
});

test("isComputerUseUiEnabled honours the persisted settings flag", () => {
  withIsolatedHome((home) => {
    writeSettingsFile(home, JSON.stringify({ [COMPUTER_USE_UI_SETTINGS_KEY]: true }));
    assert.equal(isComputerUseUiEnabled(), true);
  });
});

test("isComputerUseUiEnabled honours side-by-side CODEX_APP_ID settings", () => {
  withIsolatedHome((home) => {
    process.env.CODEX_APP_ID = "codex-cua-lab";
    writeSettingsFile(home, JSON.stringify({ [COMPUTER_USE_UI_SETTINGS_KEY]: true }), "codex-cua-lab");
    assert.equal(isComputerUseUiEnabled(), true);
  });
});

test("isComputerUseUiEnabled treats settings flag false/missing as opt-out", () => {
  withIsolatedHome((home) => {
    writeSettingsFile(home, JSON.stringify({ [COMPUTER_USE_UI_SETTINGS_KEY]: false }));
    assert.equal(isComputerUseUiEnabled(), false);
    writeSettingsFile(home, JSON.stringify({ unrelated: true }));
    assert.equal(isComputerUseUiEnabled(), false);
  });
});

test("isComputerUseUiEnabled fails closed when settings.json is malformed", () => {
  withIsolatedHome((home) => {
    writeSettingsFile(home, "{not valid json");
    assert.equal(isComputerUseUiEnabled(), false);
  });
});

test("patchMainBundleSource skips Computer Use feature patch by default", () => {
  withIsolatedHome(() => {
    const source = [
      mainBundlePrefix,
      computerUseFeatureBundleFixture(),
      computerUseGateBundleFixture(),
    ].join("");

    const patched = patchMainBundleSource(source, null);

    assert.doesNotMatch(
      patched,
      /return n===`linux`\?\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}/,
    );
    assert.match(patched, /\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/);
  });
});

test("patchMainBundleSource applies Computer Use feature patch when env var is set", () => {
  withIsolatedHome(() => {
    process.env[COMPUTER_USE_UI_ENV_VAR] = "1";
    const source = [
      mainBundlePrefix,
      computerUseFeatureBundleFixture(),
      computerUseGateBundleFixture(),
    ].join("");

    const patched = patchMainBundleSource(source, null);

    assert.match(
      patched,
      /return n===`linux`\?\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}/,
    );
    assert.match(patched, /\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/);
  });
});

test("patchMainBundleSource applies Computer Use feature patch when settings.json flag is set", () => {
  withIsolatedHome((home) => {
    writeSettingsFile(home, JSON.stringify({ [COMPUTER_USE_UI_SETTINGS_KEY]: true }));
    const source = [
      mainBundlePrefix,
      computerUseFeatureBundleFixture(),
      computerUseGateBundleFixture(),
    ].join("");

    const patched = patchMainBundleSource(source, null);

    assert.match(
      patched,
      /return n===`linux`\?\{\.\.\.e,computerUse:!0,computerUseNodeRepl:!0\}/,
    );
  });
});

test("uses CODEX_APP_ID for Electron desktopName", () => {
  assert.equal(resolveDesktopName({}), "codex-desktop.desktop");
  assert.equal(resolveDesktopName({ CODEX_APP_ID: "codex-cua-lab" }), "codex-cua-lab.desktop");
  assert.throws(
    () => resolveDesktopName({ CODEX_APP_ID: "bad/app" }),
    /CODEX_APP_ID must contain only/,
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-desktop-name-test-"));
  const previousAppId = process.env.CODEX_APP_ID;
  try {
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));
    process.env.CODEX_APP_ID = "codex-cua-lab";

    assert.equal(patchPackageJson(tempRoot), "codex-cua-lab.desktop");
    assert.equal(patchPackageJson(tempRoot), "codex-cua-lab.desktop");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(tempRoot, "package.json"), "utf8")).desktopName,
      "codex-cua-lab.desktop",
    );
  } finally {
    if (previousAppId == null) {
      delete process.env.CODEX_APP_ID;
    } else {
      process.env.CODEX_APP_ID = previousAppId;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patchMainBundleSource keeps non-icon patches active without an icon asset", () => {
  const source = [
    mainBundlePrefix,
    "process.platform===`win32`&&k.removeMenu(),",
    alreadyOpaqueBackgroundBundle,
    fileManagerBundle,
    trayBundleFixture(),
    singleInstanceBundleFixture(),
    computerUseGateBundleFixture(),
  ].join("");

  const patched = applyPatchTwice(patchMainBundleSource, source, null);

  assert.match(patched, /codexLinuxQuitInProgress=!1/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxIsQuitInProgress=\(\)=>codexLinuxQuitInProgress===!0/);
  assert.match(patched, /codexLinuxShouldBypassQuitPrompt=\(\)=>codexLinuxExplicitQuitApproved===!0/);
  assert.match(patched, /n\.app\.on\(`before-quit`,codexLinuxBeforeQuitHandler\)/);
  assert.match(patched, /process\.platform===`linux`&&k\.setMenuBarVisibility\(!1\)/);
  assert.match(patched, /linux:\{label:`File Manager`/);
  assert.match(
    patched,
    /process\.platform!==`win32`&&process\.platform!==`darwin`&&process\.platform!==`linux`\?null:/,
  );
  assert.match(patched, /process\.platform===`linux`&&!n\.app\.requestSingleInstanceLock\(\)/);
  assert.match(patched, /\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/);
  assert.doesNotMatch(patched, /setIcon\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\//);
  assert.doesNotMatch(
    patched,
    /nativeImage\.createFromPath\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\//,
  );
});

test("adds a fallback source for renderer git-origins requests without weakening other git operations", () => {
  const source =
    "handleVSCodeRequest(n,r,i,a,o){try{let s=r,c=this.handlers[s];if(typeof c!=`function`)throw Error(`${r} not implemented in the current Electron process. Restart Codex to load the latest Electron handlers.`);let l=()=>c({...a,origin:n,windowHostId:i});if(o==null){if(e.qt(r))throw Error(`Missing git operation source for ${r}`);return l()}return t.Kt({source:o,requestKind:r},l)}catch(e){throw e}}";

  const patched = applyPatchTwice(applyLinuxGitOriginsSourceFallbackPatch, source);

  assert.match(
    patched,
    /if\(r===`git-origins`\)return t\.Kt\(\{source:`linux_git_origins_missing_source_fallback`,requestKind:r\},l\)/,
  );
  assert.match(patched, /throw Error\(`Missing git operation source for \$\{r\}`\)/);
});

test("missing icon asset skips only icon patches", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-test-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        mainBundlePrefix,
        "process.platform===`win32`&&k.removeMenu(),",
        alreadyOpaqueBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    for (const name of [
      "code-theme-test.js",
      "general-settings-test.js",
      "index-test.js",
      "use-resolved-theme-variant-test.js",
    ]) {
      fs.writeFileSync(
        path.join(assetsDir, name),
        "opaqueWindows:e?.opaqueWindows??n.opaqueWindows,semanticColors:",
      );
    }
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    patchExtractedApp(tempRoot);

    const patchedMainPath = path.join(buildDir, "main.js");
    const patchedThemePath = path.join(assetsDir, "use-resolved-theme-variant-test.js");
    const patchedPackagePath = path.join(tempRoot, "package.json");
    const patchedMain = fs.readFileSync(patchedMainPath, "utf8");
    const patchedTheme = fs.readFileSync(patchedThemePath, "utf8");
    const patchedPackageRaw = fs.readFileSync(patchedPackagePath, "utf8");
    const patchedPackage = JSON.parse(patchedPackageRaw);

    patchExtractedApp(tempRoot);

    assert.match(patchedMain, /linux:\{label:`File Manager`/);
    assert.match(patchedTheme, /includes\(`linux`\)/);
    assert.equal(patchedPackage.desktopName, "codex-desktop.desktop");
    assert.equal(fs.readFileSync(patchedMainPath, "utf8"), patchedMain);
    assert.equal(fs.readFileSync(patchedThemePath, "utf8"), patchedTheme);
    assert.equal(fs.readFileSync(patchedPackagePath, "utf8"), patchedPackageRaw);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patchExtractedApp scans apps bundles for Computer Use availability when UI is enabled", () => {
  withIsolatedHome(() => {
    process.env[COMPUTER_USE_UI_ENV_VAR] = "1";
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-computer-use-apps-assets-test-"));
    try {
      const buildDir = path.join(tempRoot, ".vite", "build");
      const assetsDir = path.join(tempRoot, "webview", "assets");
      fs.mkdirSync(buildDir, { recursive: true });
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(
        path.join(buildDir, "main.js"),
        [
          mainBundlePrefix,
          "process.platform===`win32`&&k.removeMenu(),",
          alreadyOpaqueBackgroundBundle,
          fileManagerBundle,
          trayBundleFixture(),
          singleInstanceBundleFixture(),
        ].join(""),
      );
      fs.writeFileSync(
        path.join(assetsDir, "apps-current.js"),
        "function g(e){return e===`macOS`||e===`windows`}" +
          "function _(e){let t=(0,d.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,{isLoading:o,platform:c}=u(),l=s(`1506311413`),f;t[0]===r?f=t[1]:(f={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=f);let p=h(f),m;t[2]===c?m=t[3]:(m=g(c),t[2]=c,t[3]=m);let _=a&&i&&l&&(o||m),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;return x}",
      );
      fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

      patchExtractedApp(tempRoot);

      assert.match(
        fs.readFileSync(path.join(assetsDir, "apps-current.js"), "utf8"),
        /let _=a&&i&&\(c===`linux`\|\|l&&\(o\|\|m\)\),v=_&&!o&&\(c===`linux`\|\|p\.enabled\)&&!p\.isLoading/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

test("patchExtractedApp records a structured patch report", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-test-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        mainBundlePrefix,
        "process.platform===`win32`&&k.removeMenu(),",
        alreadyOpaqueBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    const report = createPatchReport();
    patchExtractedApp(tempRoot, { report });

    assert.equal(report.mainBundle, "main.js");
    assert.equal(report.iconAsset, "app-test.png");
    assert.equal(report.desktopName, "codex-desktop.desktop");
    assert.ok(report.patches.some((patch) => patch.name === "main-process-ui" && patch.status === "applied"));
    assert.ok(report.patches.some((patch) => patch.name === "keybinds-settings" && patch.status === "skipped-optional"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch report marks warned asset patches as skipped", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-warned-asset-"));
  try {
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "index-test.js"), appSunsetBundleWithDriftingGateFixture());

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const sunsetPatch = report.patches.find((patch) => patch.name === "linux-app-sunset-gate");
    assert.equal(sunsetPatch.status, "skipped-optional");
    assert.match(sunsetPatch.reason, /Could not find app sunset gate needle/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-app-sunset-gate: skipped-optional"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("persistent rate limit footer uses existing account signal without dropdown copy", () => {
  const source = [
    'import{A as Do,E as Oo,I as ko,L as Ao,M as jo,N as Mo,P as No,S as Po,W as Fo,_ as Io,a as Lo,c as Ro,d as zo,f as Bo,g as Vo,h as Ho,j as Uo,l as Wo,m as Go,o as Ko,p as qo,r as Jo,s as Yo,t as Xo,u as Zo,v as Qo,x as $o,y as es}from"./rate-limit-rows-HF3Xhn3F.js";',
    "function TF(e){let t=(0,Z.c)(148),",
    "t[131]!==Ut||t[132]!==Wt||t[133]!==Gt?(Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,Wt,Gt]}),t[131]=Ut,t[132]=Wt,t[133]=Gt,t[134]=Kt):Kt=t[134]",
    "(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w}),(0,Q.jsx)(vz,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter/);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.match(patched, /\{data:a=null\}=li\(Fn\)/);
  assert.match(patched, /c=Xo\(Jo\(o,\{activeLimitName:s,selectedModel:i\}\)\)\.slice\(0,2\)/);
  assert.doesNotMatch(patched, /codexLinuxUseRateLimitStatus/);
  assert.doesNotMatch(patched, /codex-linux-rate-limit-footer/);
  assert.equal((patched.match(/Rate limits remaining/g) || []).length, 1);
});

test("persistent rate limit footer skips current footer group when conversation id is missing", () => {
  const source = [
    "var Z=Ai();var Q=Hr();",
    "function H_(e){let t=(0,Z.c)(6),{minutes:n,variant:r}=e,i=$i(),a;t[0]!==i||t[1]!==n||t[2]!==r?(a=Uo({intl:i,minutes:n,variant:r}),t[0]=i,t[1]=n,t[2]=r,t[3]=a):a=t[3];let o;return t[4]===a?o=t[5]:(o=(0,Q.jsx)(Q.Fragment,{children:a}),t[4]=a,t[5]=o),o}",
    "function U_(e){let t=(0,Z.c)(75),{rateLimits:n,activeLimitName:r,planType:i,suppressUpsell:a,selectedModel:o}=e;return null}",
    "function IG({activeCollaborationMode:t}){let le=t?.settings.model??null,{data:ue}=Oc(),{data:de}=ci(jn),fe=Qo(de),pe=Bo(de,le),me=de?.rate_limit_reached_type?.type,he=me!=null&&me!==`rate_limit_reached`,ge=ue?.structure===`workspace`&&Io(de)&&!es(de)&&!he,_e=fe&&!ge,ve=pe&&!ge,ye=Ro(de),be=Zo(de),xe=Ko(ye,{activeLimitName:be,selectedModel:le}),Se=Lo(ye,{activeLimitName:be,selectedModel:le});",
    "let Ut=xt,Wt=null,Gt=yt,Kt;t[131]!==Ut||t[132]!==Wt||t[133]!==Gt?(Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,Wt,Gt]}),t[131]=Ut,t[132]=Wt,t[133]=Gt,t[134]=Kt):Kt=t[134];return Kt}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter\(\{conversationId:e\}\)/);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.match(patched, /\{activeMode:n\}=Bi\(e\),r=n\?\.settings\.model\?\?null,\{data:i\}=ci\(jn\)/);
  assert.doesNotMatch(patched, /codexLinuxRateLimitFooter,\{conversationId:z\}/);
  assert.match(patched, /children:\[Ut,Wt,Gt\]/);
  assert.match(patched, /\(0,Q\.jsx\)\(H_,\{minutes:e\.bucket\.windowDurationMins,variant:`summary`\}\)/);
  assert.doesNotMatch(patched, /w===`home`\?\(0,Q\.jsx\)\(codexLinuxRateLimitFooter/);
  assert.doesNotMatch(patched, /rateLimitEntries:ye/);
});

test("persistent rate limit footer adapts to current composer conversation id symbols", () => {
  const source = [
    "var Z=Ai();var Q=Hr();",
    "function H_(e){let t=(0,Z.c)(6),{minutes:n,variant:r}=e,i=$i(),a;t[0]!==i||t[1]!==n||t[2]!==r?(a=Uo({intl:i,minutes:n,variant:r}),t[0]=i,t[1]=n,t[2]=r,t[3]=a):a=t[3];let o;return t[4]===a?o=t[5]:(o=(0,Q.jsx)(Q.Fragment,{children:a}),t[4]=a,t[5]=o),o}",
    "function U_(e){let t=(0,Z.c)(75),{rateLimits:n,activeLimitName:r,planType:i,suppressUpsell:a,selectedModel:o}=e;return null}",
    "function EF(e){let t=(0,Z.c)(148),{conversationId:a,activeCollaborationMode:o}=e,r=o?.settings.model??null,{data:de}=ci(jn),ye=Ro(de),be=Zo(de),xe=Ko(ye,{activeLimitName:be,selectedModel:r}),Se=Lo(ye,{activeLimitName:be,selectedModel:r}),R=M?.type===`local`?M.localConversationId:null,z=R??a,B=oi(fn,z);",
    "let Ut=xt,Wt=null,Gt=yt,Kt;t[131]!==Ut||t[132]!==Wt||t[133]!==Gt?(Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,Wt,Gt]}),t[131]=Ut,t[132]=Wt,t[133]=Gt,t[134]=Kt):Kt=t[134];return Kt}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter\(\{conversationId:e\}\)/);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.match(patched, /codexLinuxRateLimitFooter,\{conversationId:z\}/);
  assert.match(patched, /Kt=\(0,Q\.jsxs\)\(`div`,\{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:\[Ut,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:z\}\),Wt,Gt\]\}\)/);
  assert.doesNotMatch(patched, /t\[131\]!==Ut\|\|t\[132\]!==Wt\|\|t\[133\]!==Gt\?\(Kt=.*codexLinuxRateLimitFooter/);
  assert.doesNotMatch(patched, /children:\[Ut,Wt,Gt\]/);
});

test("persistent rate limit footer migrates broken current composer calls", () => {
  const source = [
    "var Z=Ai();var Q=Hr();",
    "function H_(e){let t=(0,Z.c)(6),{minutes:n,variant:r}=e,i=$i(),a;t[0]!==i||t[1]!==n||t[2]!==r?(a=Uo({intl:i,minutes:n,variant:r}),t[0]=i,t[1]=n,t[2]=r,t[3]=a):a=t[3];let o;return t[4]===a?o=t[5]:(o=(0,Q.jsx)(Q.Fragment,{children:a}),t[4]=a,t[5]=o),o}",
    "function U_(e){let t=(0,Z.c)(75),{rateLimits:n,activeLimitName:r,planType:i,suppressUpsell:a,selectedModel:o}=e;return null}",
    "function IG({activeCollaborationMode:t}){let z=ci(Zt),le=t?.settings.model??null,{data:ue}=Oc(),{data:de}=ci(jn),fe=Qo(de),pe=Bo(de,le),me=de?.rate_limit_reached_type?.type,he=me!=null&&me!==`rate_limit_reached`,ge=ue?.structure===`workspace`&&Io(de)&&!es(de)&&!he,_e=fe&&!ge,ve=pe&&!ge,ye=Ro(de),be=Zo(de),xe=Ko(ye,{activeLimitName:be,selectedModel:le}),Se=Lo(ye,{activeLimitName:be,selectedModel:le});",
    "let Ut=xt,Wt=null,Gt=yt,Kt;Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,w===`home`?(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:z}):null,Wt,Gt]});return Kt}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter/);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.match(patched, /codexLinuxRateLimitFooter,\{conversationId:z\}/);
  assert.doesNotMatch(patched, /w===`home`\?\(0,Q\.jsx\)\(codexLinuxRateLimitFooter/);
  assert.doesNotMatch(patched, /codexLinuxRateLimitFooter,\{rateLimitEntries:/);
});

test("persistent rate limit footer upgrades existing current helper to guarded helper", () => {
  const oldHelper =
    "function codexLinuxRateLimitFooter({conversationId:e}){let t=(0,Z.c)(22),{activeMode:n}=Bi(e),r=n?.settings.model??null,{data:i}=ci(jn);return null}";
  const source = [
    "var Z=Ai();var Q=Hr();",
    "function H_(e){let t=(0,Z.c)(6),{minutes:n,variant:r}=e,i=$i(),a;t[0]!==i||t[1]!==n||t[2]!==r?(a=Uo({intl:i,minutes:n,variant:r}),t[0]=i,t[1]=n,t[2]=r,t[3]=a):a=t[3];let o;return t[4]===a?o=t[5]:(o=(0,Q.jsx)(Q.Fragment,{children:a}),t[4]=a,t[5]=o),o}",
    oldHelper,
    "function U_(e){let t=(0,Z.c)(75),{rateLimits:n,activeLimitName:r,planType:i,suppressUpsell:a,selectedModel:o}=e;return null}",
    "function IG({activeCollaborationMode:t}){let z=ci(Zt),le=t?.settings.model??null,{data:ue}=Oc(),{data:de}=ci(jn),fe=Qo(de),pe=Bo(de,le),me=de?.rate_limit_reached_type?.type,he=me!=null&&me!==`rate_limit_reached`,ge=ue?.structure===`workspace`&&Io(de)&&!es(de)&&!he,_e=fe&&!ge,ve=pe&&!ge,ye=Ro(de),be=Zo(de),xe=Ko(ye,{activeLimitName:be,selectedModel:le}),Se=Lo(ye,{activeLimitName:be,selectedModel:le});",
    "let Ut=xt,Wt=null,Gt=yt,Kt;Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:z}),Wt,Gt]});return Kt}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.equal((patched.match(/function codexLinuxRateLimitFooter/g) || []).length, 1);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.match(patched, /\{activeMode:n\}=Bi\(e\),r=n\?\.settings\.model\?\?null,\{data:i\}=ci\(jn\)/);
  assert.doesNotMatch(patched, /function codexLinuxRateLimitFooter\(\{conversationId:e\}\)\{let t=/);
});

test("persistent rate limit footer repairs incorrectly adapted current composer calls", () => {
  const brokenHelper =
    "function codexLinuxRateLimitFooter({rateLimitEntries:e,activeLimitName:t,selectedModel:n}){let r=(0,Z.c)(20),i=Jo(e,{activeLimitName:t,selectedModel:n}),a=Xo(i).slice(0,2);if(a.length===0)return null;return a}";
  const source = [
    "var Z=Ai();var Q=Hr();",
    "function H_(e){let t=(0,Z.c)(6),{minutes:n,variant:r}=e,i=$i(),a;t[0]!==i||t[1]!==n||t[2]!==r?(a=Uo({intl:i,minutes:n,variant:r}),t[0]=i,t[1]=n,t[2]=r,t[3]=a):a=t[3];let o;return t[4]===a?o=t[5]:(o=(0,Q.jsx)(Q.Fragment,{children:a}),t[4]=a,t[5]=o),o}",
    brokenHelper,
    "function U_(e){let t=(0,Z.c)(75),{rateLimits:n,activeLimitName:r,planType:i,suppressUpsell:a,selectedModel:o}=e;return null}",
    "function IG({activeCollaborationMode:t}){let z=ci(Zt),le=t?.settings.model??null,{data:ue}=Oc(),{data:de}=ci(jn),fe=Qo(de),pe=Bo(de,le),me=de?.rate_limit_reached_type?.type,he=me!=null&&me!==`rate_limit_reached`,ge=ue?.structure===`workspace`&&Io(de)&&!es(de)&&!he,_e=fe&&!ge,ve=pe&&!ge,ye=Ro(de),be=Zo(de),xe=Ko(ye,{activeLimitName:be,selectedModel:le}),Se=Lo(ye,{activeLimitName:be,selectedModel:le});",
    "let Ut=xt,Wt=null,Gt=yt,Kt;Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,w===`home`?(0,Q.jsx)(codexLinuxRateLimitFooter,{rateLimitEntries:ye,activeLimitName:be,selectedModel:le}):null,Wt,Gt]});return Kt}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter\(\{conversationId:e\}\)/);
  assert.match(patched, /codexLinuxRateLimitFooter,\{conversationId:z\}/);
  assert.doesNotMatch(patched, /w===`home`\?\(0,Q\.jsx\)\(codexLinuxRateLimitFooter/);
  assert.doesNotMatch(patched, /rateLimitEntries:e/);
  assert.doesNotMatch(patched, /rateLimitEntries:ye/);
});

test("persistent rate limit footer skips composer patch when helper cannot be inserted", () => {
  const source = [
    "function Cz(e){let t=(0,Z.c)(148),",
    "t[131]!==Ut||t[132]!==Wt||t[133]!==Gt?(Kt=(0,Q.jsxs)(`div`,{className:`flex min-w-0 flex-1 flex-nowrap items-center gap-1`,children:[Ut,Wt,Gt]}),t[131]=Ut,t[132]=Wt,t[133]=Gt,t[134]=Kt):Kt=t[134]",
    "(0,Q.jsx)(nz,{conversationId:f,hostId:C,cwdOverride:w}),(0,Q.jsx)(vz,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.equal(patched, source);
  assert.doesNotMatch(patched, /codexLinuxRateLimitFooter/);
});

test("patcher CLI writes --report-json output", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-cli-test-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    const assetsDir = path.join(tempRoot, "webview", "assets");
    const reportPath = path.join(tempRoot, "reports", "patch-report.json");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        mainBundlePrefix,
        "process.platform===`win32`&&k.removeMenu(),",
        alreadyOpaqueBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "patch-linux-window-ui.js"), "--report-json", reportPath, tempRoot],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.mainBundle, "main.js");
    assert.ok(report.patches.some((patch) => patch.name === "main-process-ui"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
