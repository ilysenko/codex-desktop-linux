#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyPetOverlayPatch,
} = require("../linux-features/pet-overlay/patch.js");

// Pin the feature config so a developer's local gitignored features.json
// cannot change which patch descriptors these core tests exercise.
process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(
  __dirname,
  "..",
  "linux-features",
  "features.example.json",
);

const {
  applyAutomationScheduleMultiTimePatch,
  patchAutomationScheduleAssets,
} = require("./patches/impl/automation-schedule.js");
const {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxNativeDesktopAppsHandlerPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  isComputerUseUiEnabled,
} = require("./patches/impl/computer-use.js");
const {
  keybindsSettingsAsset,
  linuxDesktopSettingsAsset,
  applyLinuxDesktopSettingsIndexPatch,
  applyLinuxShortcutPhysicalKeyFallbackPatch,
  applyLinuxDesktopSettingsSectionsPatch,
  applyLinuxDesktopSettingsSharedPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  patchKeybindsSettingsAssets,
} = require("./patches/impl/keybinds-settings.js");
const {
  applyLinuxAvatarOverlayMousePassthroughPatch,
} = require("./patches/impl/avatar-overlay.js");
const {
  applyBrowserUseNodeReplApprovalPatch,
  applyBrowserUseNodeReplApprovalAssets,
  applyLinuxBundledPluginCopyPermissionsPatch,
  applyLinuxBundledPluginReconcileStaleSnapshotPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxExternalOpenEnvPatch,
} = require("./patches/impl/main-process/browser.js");
const {
  applyLinuxChromeNativeHostRuntimePatch,
  applyLinuxChromePluginAutoInstallPatch,
} = require("./patches/impl/chrome-plugin.js");
const {
  applyLinuxAboutDialogPatch,
  applyLinuxApplicationMenuPatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxSetIconPatch,
  applyLinuxWindowOptionsPatch,
} = require("./patches/impl/main-process/window.js");
const {
  applyLinuxBuildInfoTrayPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
} = require("./patches/impl/main-process/tray.js");
const {
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
} = require("./patches/impl/main-process/quit-lifecycle.js");
const {
  applyLinuxHostProcessEnvironmentPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxLocalAppServerFeatureEnablementHandlerPatch,
  applyLinuxOwlFeatureBindingFallbackPatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxTerminalHostEnvironmentPatch,
  applyLinuxTerminalUserPathPatch,
  applyLinuxWorkerFileManagerPatch,
  applyLinuxXdgDocumentsDirPatch,
  applyLinuxX11ProjectPickerPatch,
  patchLinuxOwlFeatureBindingFallbackAssets,
  patchLinuxHostProcessEnvironmentTargets,
} = require("./patches/impl/main-process/misc.js");
const {
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxSettingsPersistencePatch,
} = require("./patches/impl/launch-actions.js");
const {
  applyLinuxMultiInstanceBootstrapPatch,
} = require("./patches/impl/bootstrap.js");
const {
  applyLinuxProjectlessXdgDocumentsDirPatch,
  patchProjectlessDocumentsAssets,
} = require("./patches/impl/projectless-documents.js");
const {
  patchPackageJson,
  resolveDesktopName,
} = require("./patches/impl/package-json.js");
const {
  patchExtractedApp,
  patchMainBundleSource,
  corePatchDescriptors,
  featurePatchDescriptors,
} = require("./patches/runner.js");
const {
  discoverCorePatchDescriptors,
  normalizePatchDescriptors,
} = require("./patches/engine.js");
const {
  detectLinuxTargetContext,
  linuxTargetSummary,
  parseOsRelease,
} = require("./lib/linux-target-context.js");
const {
  enabledLinuxFeatureIds,
} = require("./lib/linux-features.js");
const {
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  patchLinuxAppUpdaterBridge,
} = require("./lib/linux-update-bridge-patch.js");
const {
  validateReport,
} = require("./ci/validate-patch-report.js");
const {
  buildInfo,
  githubCommitUrl,
  packageProfile,
  sourceInfo,
} = require("./lib/build-info.js");
const {
  createPatchReport,
  criticalFailuresFromReport,
  optionalDriftFromReport,
  summarizePatchReport,
} = require("./lib/patch-report.js");
const {
  applyBrowserAnnotationScreenshotPatch,
  applyLocalEnvironmentActionModalDraftPatch,
  applyPersistentRateLimitFooterPatch,
  applyLinuxAppServerBackfillWaitPatch,
  applyLinuxAppServerFeatureEnablementPatch,
  applyAutomationUpdateEagerToolPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxBrowserUseAvailabilityPatch,
  applyLinuxBrowserUseExternalAvailabilityPatch,
  applyLinuxBrowserUseNonLocalNavigationPatch,
  applyLinuxChatSearchHydrationPatch,
  applyLinuxConfigWriteVersionConflictPatch,
  applyLinuxFastModeModelGuardPatch,
  applyLinuxI18nGatePatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxSafeMonospaceFontStackPatch,
  applyLinuxSettingsSearchVisibilityPatch,
  applyLinuxSkillsListDedupePatch,
  applyLinuxThreadSidePanelNativeTooltipPatch,
  applyLinuxTooltipWindowControlsCollisionPatch,
  applyLinuxWindowControlsSafeAreaPatch,
  applySubagentNicknameMetadataPatch,
} = require("./patches/impl/webview/index.js");
const {
  findCodexRequestWebviewAsset,
  patchAssetFiles,
} = require("./patches/lib/assets.js");

const mainBundlePrefix =
  "let s=require(`node:url`),n=require(`electron`);n=e.o(n);let i=require(`node:path`);i=e.o(i);let o=require(`node:fs`);o=e.o(o);";
const currentMainBundlePrefix =
  "const e={o:e=>e};let s=require(`node:url`),c=require(`electron`);c=e.o(c);let l=require(`node:os`);l=e.o(l);let u=require(`node:path`);u=e.o(u);let d=require(`node:util`),f=require(`node:crypto`),p=require(`node:fs`);p=e.o(p);";
const workerBundlePrefix =
  "let i=require(`node:path`),o=require(`node:fs`);";
const fileManagerBundle =
  "var lu=jl({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>il(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:uu,args:e=>il(e),open:async({path:e})=>du(e)}});function uu(){}";
const terminalEnvBundle =
  "var Q0=`xterm-256color`;var t={t(e){return e}};var Backend=class{isLocalTerminalSession(e){return e?.type===`local`}async getWorktreeShellEnvironmentForCwd(e){return null}async buildTerminalEnv(e,n,r){let i={...process.env};if(n!=null&&(i.CODEX_APP_TITLE=n),this.isLocalTerminalSession(r)){let t=await this.getWorktreeShellEnvironmentForCwd(e);if(t!=null){for(let e of t.exclude)delete i[e];Object.assign(i,t.set)}}return process.platform!==`win32`&&(i.TERM=Q0,delete i.TERMINFO,delete i.TERMINFO_DIRS),t.t(i)}};";
const obsoleteTerminalEnvBundle =
  "var Q0=`xterm-256color`;var t={$r(e){return e}};var Backend=class{isLocalTerminalSession(e){return e?.type===`local`}async getWorktreeShellEnvironmentForCwd(e){return null}async buildTerminalEnv(e,n,r){let i={...process.env};if(n!=null&&(i.CODEX_APP_TITLE=n),this.isLocalTerminalSession(r)){let t=await this.getWorktreeShellEnvironmentForCwd(e);if(t!=null){for(let e of t.exclude)delete i[e];Object.assign(i,t.set)}}return process.platform!==`win32`&&(i.TERM=Q0,delete i.TERMINFO,delete i.TERMINFO_DIRS),t.$r(i)}};";
const currentOpaqueWindowSurfaceBackgroundHelper =
  "var W4=`#00000000`,G4=`#000000`,K4=`#f9f9f9`;function g3(e){return e===`avatarOverlay`||e===`browserCommentPopup`||e===`globalDictation`||e===`hotkeyWindowHome`||e===`hotkeyWindowThread`||e===`hud`}function v3({appearance:e,opaqueWindowsEnabled:t,platform:n}){return t&&!g3(e)&&(n===`darwin`||n===`win32`)}function S3({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?G4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!g3(t)?{backgroundColor:W4,backgroundMaterial:`mica`}:{backgroundColor:W4,backgroundMaterial:null}}";
const currentOpaqueWindowSurfaceBackgroundBundle =
  `${currentOpaqueWindowSurfaceBackgroundHelper}class k3{isOpaqueWindowsEnabled(){return theme?.opaqueWindows===!0}shouldUseOpaqueWindowSurface(e,t,n){return this.shouldAlwaysUseOpaqueWindowSurface(e)}shouldAlwaysUseOpaqueWindowSurface(e){return v3({appearance:e,opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!BA()&&!g3(e)}}`;
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cryptoHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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

function automationScheduleBundleFixture() {
  return [
    "var Cc={MO:1,TU:2,WE:3,TH:4,FR:5,SA:6,SU:0};",
    "function wc(e){let t=Tc(e.byhour),n=Tc(e.byminute);return t!=null&&n!=null?{hour:t,minute:n}:e.dtstart?{hour:e.dtstart.getHours(),minute:e.dtstart.getMinutes()}:null}",
    "function Tc(e){return Array.isArray(e)?typeof e[0]==`number`?e[0]:null:typeof e==`number`?e:null}",
    "function Ec(e,t){let n=new Date(e),r=new Date(n.getFullYear(),n.getMonth(),n.getDate(),t.hour,t.minute,0,0);return r.getTime()<=e&&r.setDate(r.getDate()+1),r.getTime()}",
    "function Dc(e,t,n){let r=new Date(e),i=r.getDay(),a=n.length>0?n:[0,1,2,3,4,5,6];for(let n=0;n<=7;n+=1){let o=(i+n)%7;if(!a.includes(o))continue;let s=new Date(r.getFullYear(),r.getMonth(),r.getDate()+n,t.hour,t.minute,0,0);if(s.getTime()>e)return s.getTime()}return e}",
    "function Oc(e){return e?(Array.isArray(e)?e:[e]).map(e=>{if(typeof e==`number`)return Ac(e);if(kc(e))return Ac(e.weekday);let t=String(e);return t in Cc?Cc[t]:null}).filter(e=>e!=null):[]}",
    "function kc(e){return typeof e!=`object`||!e||!(`weekday`in e)?!1:typeof e.weekday==`number`}",
    "function Ac(e){return!Number.isInteger(e)||e<0||e>6?null:(e+1)%7}",
    "var jc=`codex_chronicle`;",
  ].join("");
}

function currentAutomationScheduleBundleFixture() {
  return [
    "var K={MINUTELY:1,HOURLY:2,DAILY:3,WEEKLY:4},q=[`SU`,`MO`,`TU`,`WE`,`TH`,`FR`,`SA`],X=Array.from(q),Ht=[`MO`,`TU`,`WE`,`TH`,`FR`],Ut=[`SA`,`SU`],Wt=`09:00`,Gt=`MO`,Kt=new Set([`freq`,`interval`,`dtstart`,`tzid`]),qt=new Set([...Kt,`byweekday`,`byminute`]),Jt=new Set([...qt,`byhour`]);",
    "function Mt(e,t){return t.formatTime(e)}function Y(e,t){return e.length===t.length}function on(e){return e.length>0?e:X}function Sn(){return `minute`}function xn(){return `hour`}function wn({timeLabel:e}){return e}",
    "function Tn(e,t,n){let r=En(e),i=En(t);return r!=null&&i!=null?Mn(r,i):n.dtstart?Mn(n.dtstart.getHours(),n.dtstart.getMinutes()):Wt}function En(e){return Array.isArray(e)?typeof e[0]==`number`?e[0]:null:typeof e==`number`?e:null}",
    "function $(e){let t=yt(e,{forceset:!0,tzid:Nn()??void 0}),n=t.rrules()[0],r=n.options,i=Dn(r.byweekday)??On(e)??X,a=En(r.byminute);return{freq:r.freq,isStandaloneRrule:n.origOptions.dtstart==null&&t.rrules().length===1&&t.rdates().length===0&&t.exrules().length===0&&t.exdates().length===0,hasMultipleTimeValues:Array.isArray(r.byhour)&&r.byhour.length>1||Array.isArray(r.byminute)&&r.byminute.length>1,interval:Math.max(1,Math.round(r.interval??1)),minute:a,origOptions:n.origOptions,rruleText:e,time:Tn(r.byhour,r.byminute,r),weekdays:i}}",
    "function bn(e,t){if(!e||e.hasMultipleTimeValues)return null;let n=on(e.weekdays),r=n.length===q.length;if(e.freq===K.MINUTELY)return Sn({intervalMinutes:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq===K.HOURLY)return xn({intervalHours:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq!==K.DAILY&&e.freq!==K.WEEKLY)return null;let i=Mt(e.time,t);return i?wn({intl:t,isEveryDay:r,timeLabel:i,weekdays:n}):null}",
  ].join("");
}

function currentAutomationScheduleBundleWithDollarIdentifierFixture() {
  return [
    "var TJ={MINUTELY:1,HOURLY:2,DAILY:3,WEEKLY:4},PJ=[`SU`,`MO`,`TU`,`WE`,`TH`,`FR`,`SA`],XJ=`09:00`;",
    "function Flt(e){return e.length>0?e:PJ}function Ylt(){return `minute`}function Jlt(){return `hour`}function Qlt({timeLabel:e}){return e}function xlt(e,t){return t.formatTime(e)}function KJ(e,t){return`${e}:${t}`}",
    "function HJ(e){if(!e)return null;try{let t=DJ(e,{forceset:!0,tzid:iut()??void 0}),n=t.rrules()[0];if(!n)return null;let r=n.options,i=eut(r.byweekday)??tut(e)??PJ,a=WJ(r.byminute);return{freq:r.freq,isStandaloneRrule:n.origOptions.dtstart==null&&t.rrules().length===1&&t.rdates().length===0&&t.exrules().length===0&&t.exdates().length===0,hasMultipleTimeValues:Array.isArray(r.byhour)&&r.byhour.length>1||Array.isArray(r.byminute)&&r.byminute.length>1,interval:Math.max(1,Math.round(r.interval??1)),minute:a,origOptions:n.origOptions,rruleText:e,time:$lt(r.byhour,r.byminute,r),weekdays:i}}catch{return null}}",
    "function qlt(e,t){if(!e||e.hasMultipleTimeValues)return null;let n=Flt(e.weekdays),r=n.length===PJ.length;if(e.freq===TJ.MINUTELY)return Ylt({intervalMinutes:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq===TJ.HOURLY)return Jlt({intervalHours:e.interval,intl:t,isEveryDay:r,weekdays:n});if(e.freq!==TJ.DAILY&&e.freq!==TJ.WEEKLY)return null;let i=xlt(e.time,t);return i?Qlt({intl:t,isEveryDay:r,timeLabel:i,weekdays:n}):null}",
    "function $lt(e,t,n){let r=WJ(e),i=WJ(t);return r!=null&&i!=null?KJ(r,i):n.dtstart?KJ(n.dtstart.getHours(),n.dtstart.getMinutes()):XJ}function WJ(e){return Array.isArray(e)?typeof e[0]==`number`?e[0]:null:typeof e==`number`?e:null}",
  ].join("");
}

function evaluateAutomationSchedule(source, now, options) {
  const context = { now, options, result: null };
  vm.runInNewContext(
    `${source};result=Dc(now,wc(options),Oc(options.byweekday));`,
    context,
  );
  return context.result;
}

test("automation schedule patch honors multiple BYHOUR values", () => {
  const patched = applyPatchTwice(applyAutomationScheduleMultiTimePatch, automationScheduleBundleFixture());
  const options = {
    byhour: [11, 14, 17, 20],
    byminute: [0],
    byweekday: ["MO", "TU", "WE", "TH", "FR"],
    dtstart: new Date(2026, 4, 22, 16, 27, 0, 0),
  };

  assert.match(patched, /function codexLinuxNormalizeRruleNumbers/);
  assert.equal(
    evaluateAutomationSchedule(patched, new Date(2026, 4, 22, 16, 27, 0, 0).getTime(), options),
    new Date(2026, 4, 22, 17, 0, 0, 0).getTime(),
  );
  assert.equal(
    evaluateAutomationSchedule(patched, new Date(2026, 4, 22, 20, 1, 0, 0).getTime(), options),
    new Date(2026, 4, 25, 11, 0, 0, 0).getTime(),
  );
});

test("automation schedule asset patch updates workspace-root bundle", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-schedule-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const bundlePath = path.join(buildDir, "workspace-root-drop-handler-test.js");
    fs.writeFileSync(bundlePath, automationScheduleBundleFixture(), "utf8");

    assert.deepEqual(patchAutomationScheduleAssets(tempRoot), { matched: 1, changed: 1 });
    const patched = fs.readFileSync(bundlePath, "utf8");
    assert.match(patched, /function codexLinuxRruleTimes/);
    assert.deepEqual(patchAutomationScheduleAssets(tempRoot), { matched: 1, changed: 0 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("automation schedule asset patch updates current webview automation bundle", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-automation-schedule-current-"));
  try {
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const bundlePath = path.join(assetsDir, "automation-schedule-test.js");
    fs.writeFileSync(bundlePath, currentAutomationScheduleBundleFixture(), "utf8");

    assert.deepEqual(patchAutomationScheduleAssets(tempRoot), { matched: 1, changed: 1 });
    const patched = fs.readFileSync(bundlePath, "utf8");
    assert.match(patched, /function codexLinuxRruleTimes/);
    assert.match(patched, /timeValues:codexLinuxRruleTimes/);
    assert.match(patched, /codexLinuxAutomationTimeLabel/);
    assert.deepEqual(patchAutomationScheduleAssets(tempRoot), { matched: 1, changed: 0 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("automation schedule patch handles current dollar-prefixed helper names", () => {
  const patched = applyPatchTwice(
    applyAutomationScheduleMultiTimePatch,
    currentAutomationScheduleBundleWithDollarIdentifierFixture(),
  );

  assert.match(patched, /function codexLinuxRruleTimes/);
  assert.match(patched, /timeValues:codexLinuxRruleTimes/);
  assert.match(patched, /codexLinuxAutomationTimeLabel/);
  assert.doesNotMatch(patched, /if\(!e\|\|e\.hasMultipleTimeValues\)return null/);
});

test("asset patch helpers match every file when passed a global regex", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-asset-global-"));
  try {
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "index-a.js"), "a", "utf8");
    fs.writeFileSync(path.join(assetsDir, "index-b.js"), "b", "utf8");

    const result = patchAssetFiles(
      tempRoot,
      /^index-.*\.js$/g,
      (source) => source.toUpperCase(),
      "missing index bundle",
    );

    assert.deepEqual(result, { matched: 2, changed: 2 });
    assert.equal(fs.readFileSync(path.join(assetsDir, "index-a.js"), "utf8"), "A");
    assert.equal(fs.readFileSync(path.join(assetsDir, "index-b.js"), "utf8"), "B");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Linux safe monospace font stack patch prioritizes Linux mono families", () => {
  const source = "var e=`ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace`;export{e as t};";
  const patched = applyPatchTwice(applyLinuxSafeMonospaceFontStackPatch, source);

  assert.match(
    patched,
    /`"Noto Sans Mono", "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", ui-monospace,/,
  );
  assert.doesNotMatch(patched, /var e=`ui-monospace, "SFMono-Regular"/);
});

test("Linux safe monospace font stack patch accepts upstream-safe stacks", () => {
  const source =
    "var e=`DejaVu Sans Mono, ui-monospace, \"SFMono-Regular\", Menlo, Consolas, monospace`;export{e as t};";
  const { value, warnings } = captureWarns(() =>
    applyLinuxSafeMonospaceFontStackPatch(source),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("Linux safe monospace font stack patch warns when the unsafe stack drifts", () => {
  const source = "var e=buildFontStack(`ui-monospace`,`monospace`);export{e as t};";
  const { value, warnings } = captureWarns(() =>
    applyLinuxSafeMonospaceFontStackPatch(source),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not find Linux monospace font stack insertion point/);
});

test("Linux settings search hides controls that cannot render", () => {
  const source = [
    "function qn(e){let t=(0,Zn.c)(17),n=re(),r=Bn(e),{data:i}=_(e),a=i?.isSystemBackdropSupported!==!1,o=i?.platform===`darwin`,{data:s}=T(k,e.selectedHostId),c,l=c;if(a){let e;e=e=>e.sectionSlug===`appearance`&&!a?{...e,messages:e.messages.filter(Jn)}:e.sectionSlug===`agent`?{...e,terms:[]}:e,m=r.map(e)}else m=r;return m}",
    "function Jn(e){return!Qn.includes(e.id)}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxSettingsSearchVisibilityPatch, source);

  assert.match(patched, /function codexLinuxFilterSettingsSearchSection\(/);
  assert.match(patched, /settings\.general\.appearance\.dockIcon\.label/);
  assert.match(
    patched,
    /return m\.map\(e=>codexLinuxFilterSettingsSearchSection\(e,o\)\)/,
  );
  assert.equal(
    (patched.match(/function codexLinuxFilterSettingsSearchSection\(/g) || []).length,
    1,
  );

  const helperStart = patched.indexOf(
    "var codexLinuxDarwinOnlySettingsSearchMessageIds",
  );
  const helperEnd = patched.indexOf("function qn", helperStart);
  const context = {};
  vm.runInNewContext(
    `${patched.slice(helperStart, helperEnd)};globalThis.filter=codexLinuxFilterSettingsSearchSection`,
    context,
  );
  const dockMessage = {
    id: "settings.general.appearance.dockIcon.label",
  };
  const themeMessage = {
    id: "settings.general.appearance.theme",
  };
  assert.deepEqual(
    Array.from(context.filter({
      sectionSlug: "appearance",
      messages: [dockMessage, themeMessage],
    }, false).messages, (message) => message.id),
    [themeMessage.id],
  );
  assert.deepEqual(
    Array.from(context.filter({
      sectionSlug: "appearance",
      messages: [dockMessage, themeMessage],
    }, true).messages, (message) => message.id),
    [dockMessage.id, themeMessage.id],
  );
});

test("Linux settings search visibility patch warns on current-bundle drift", () => {
  const source =
    'import{aG as h}from"./app-current.js";function qn(e){return settingsSearchDocuments}';
  const { value, warnings } = captureWarns(() =>
    applyLinuxSettingsSearchVisibilityPatch(source),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /settings search visibility insertion point/);
});

test("subagent nickname metadata patch accepts session metadata shape", () => {
  const source = [
    "function j(e){return e}",
    "function B(e){if(e==null||typeof e==`string`)return null;let t=Mi(e);return t==null?null:Ni(t)}",
    "function Mi(e){return`subAgent`in e?e.subAgent:null}",
    "function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}",
    "function Pi(){return{parentThreadId:null,depth:null,agentNickname:null,agentRole:null}}",
    "function Xl(e){return e==null?null:Zl(e.agentNickname)??Zl(B(e.source)?.agentNickname)}",
    "function Zl(e){if(e==null)return null;let t=e.trim();return t.length===0?null:t}",
  ].join("");
  const patched = applyPatchTwice(applySubagentNicknameMetadataPatch, source);

  assert.match(patched, /`subAgent`in e\?e\.subAgent:`subagent`in e\?e\.subagent:null/);
  assert.match(patched, /Zl\(e\.agentNickname\)\?\?Zl\(e\.agent_nickname\)\?\?Zl\(B\(e\.source\)\?\.agentNickname\)/);

  const sandbox = {
    result: null,
  };
  vm.runInNewContext(
    `${patched};result={top:Xl({agent_nickname:\`Ned\`}),source:Xl({source:{subagent:{thread_spawn:{parent_thread_id:\`parent\`,depth:1,agent_nickname:\`Pepper Potts\`,agent_role:\`worker\`}}}}),role:B({subagent:{thread_spawn:{parent_thread_id:\`parent\`,depth:1,agent_nickname:\`Pepper Potts\`,agent_role:\`worker\`}}}).agentRole};`,
    sandbox,
  );

  assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), {
    top: "Ned",
    source: "Pepper Potts",
    role: "worker",
  });
});

test("subagent nickname metadata patch accepts current upstream patched aliases", () => {
  const source = [
    "function P(e){return e}",
    "function jo(e){if(e==null||typeof e==`string`)return null;let t=Mo(e);return t==null?null:No(t)}",
    "function Mo(e){return`subAgent`in e?e.subAgent:`subagent`in e?e.subagent:null}",
    "function No(e){return typeof e==`string`?Po():`thread_spawn`in e?{parentThreadId:P(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Po()}",
    "function Po(){return{parentThreadId:null,depth:null,agentNickname:null,agentRole:null}}",
    "function Fo(e){return e==null?null:Io(e.agentNickname)??Io(e.agent_nickname)??Io(jo(e.source)?.agentNickname)}",
    "function Io(e){if(e==null)return null;let t=e.trim();return t.length===0?null:t}",
  ].join("");
  const { value, warnings } = captureWarns(() =>
    applySubagentNicknameMetadataPatch(source),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("subagent metadata descriptor ignores matching sibling bundles without metadata", () => {
  const descriptor = corePatchDescriptors().find((candidate) =>
    candidate.id === "subagent-nickname-metadata-shape",
  );
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-subagent-metadata-sibling-"));
  try {
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const siblingSource = "export const hostConfig={local:!0};";
    const metadataSource = [
      "function j(e){return e}",
      "function B(e){if(e==null||typeof e==`string`)return null;let t=Mi(e);return t==null?null:Ni(t)}",
      "function Mi(e){return`subAgent`in e?e.subAgent:null}",
      "function Ni(e){return typeof e==`string`?Pi():`thread_spawn`in e?{parentThreadId:j(e.thread_spawn.parent_thread_id),depth:e.thread_spawn.depth,agentNickname:e.thread_spawn.agent_nickname,agentRole:e.thread_spawn.agent_role}:Pi()}",
      "function Pi(){return{parentThreadId:null,depth:null,agentNickname:null,agentRole:null}}",
      "function Xl(e){return e==null?null:Zl(e.agentNickname)??Zl(B(e.source)?.agentNickname)}",
      "function Zl(e){if(e==null)return null;let t=e.trim();return t.length===0?null:t}",
    ].join("");
    fs.writeFileSync(path.join(assetsDir, "app-server-manager-signals-test.js"), siblingSource);
    fs.writeFileSync(path.join(assetsDir, "use-host-config-test.js"), metadataSource);

    const { value: result, warnings } = captureWarns(() =>
      patchAssetFiles(tempRoot, descriptor.pattern, descriptor.apply, "missing subagent metadata bundle"),
    );

    assert.deepEqual(result, { matched: 2, changed: 1 });
    assert.deepEqual(warnings, []);
    assert.equal(fs.readFileSync(path.join(assetsDir, "app-server-manager-signals-test.js"), "utf8"), siblingSource);
    assert.match(
      fs.readFileSync(path.join(assetsDir, "use-host-config-test.js"), "utf8"),
      /Zl\(e\.agentNickname\)\?\?Zl\(e\.agent_nickname\)\?\?Zl\(B\(e\.source\)\?\.agentNickname\)/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

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

test("build info captures DMG hash, features, distro profile, and source revision", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-info-"));
  // This test reads features.json from its own featuresRoot, which the
  // file-level CODEX_LINUX_FEATURES_CONFIG pin would otherwise override.
  const pinnedFeaturesConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  delete process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    const dmgPath = path.join(tempRoot, "Codex.dmg");
    fs.writeFileSync(dmgPath, "fake dmg payload", "utf8");

    const appDir = path.join(tempRoot, "Codex.app");
    fs.mkdirSync(path.join(appDir, "Contents"), { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "Contents", "Info.plist"),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        "<key>CFBundleShortVersionString</key><string>1.2.3</string>",
        "</dict></plist>",
      ].join("\n"),
      "utf8",
    );

    const featuresRoot = path.join(tempRoot, "linux-features");
    fs.mkdirSync(featuresRoot, { recursive: true });
    fs.writeFileSync(
      path.join(featuresRoot, "features.json"),
      JSON.stringify({ enabled: ["read-aloud", "open-target-discovery"] }),
      "utf8",
    );

    const info = buildInfo({
      repoDir: tempRoot,
      dmgPath,
      appDir,
      electronVersion: "41.3.0",
      appId: "codex-desktop",
      appDisplayName: "ChatGPT Desktop",
      featuresRoot,
      env: {
        CODEX_LINUX_SOURCE_COMMIT: "abcdef1234567890",
        CODEX_LINUX_SOURCE_BRANCH: "main",
        CODEX_LINUX_SOURCE_REMOTE: "https://ghp_secret-token@github.com/example/codex-desktop-linux.git",
        SOURCE_DATE_EPOCH: "1710000000",
      },
      linuxTarget: detectLinuxTargetContext({
        osReleaseFields: {
          ID: "ubuntu",
          ID_LIKE: "debian",
          VERSION_ID: "24.04",
          PRETTY_NAME: "Ubuntu 24.04 LTS",
        },
        env: { PATH: "" },
      }),
    });

    assert.equal(info.generatedAt, new Date(1710000000 * 1000).toISOString());
    assert.equal(info.upstreamDmg.path, undefined);
    assert.equal(info.upstreamDmg.sha256, "e33df8d941faed4fdc3bb688fea70572931e81a6e0c2603b810338177148dfa2");
    assert.equal(info.upstreamDmg.appVersion, "1.2.3");
    assert.equal(info.source.shortCommit, "abcdef123456");
    assert.equal(info.source.remote, "https://github.com/example/codex-desktop-linux.git");
    assert.equal(info.source.commitUrl, "https://github.com/example/codex-desktop-linux/commit/abcdef1234567890");
    assert.equal(info.packageProfile.id, "debian-family");
    assert.equal(info.packageProfile.packageManager, "apt");
    assert.deepEqual(info.linuxFeatures.enabled, ["read-aloud", "open-target-discovery"]);
    assert.equal(info.linuxFeatures.configPath, undefined);
  } finally {
    if (pinnedFeaturesConfig != null) {
      process.env.CODEX_LINUX_FEATURES_CONFIG = pinnedFeaturesConfig;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("build info sanitizes staged source metadata from packaged update-builder", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-build-info-staged-source-"));
  try {
    const sourceInfoDir = path.join(tempRoot, ".codex-linux");
    fs.mkdirSync(sourceInfoDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceInfoDir, "source-info.json"),
      JSON.stringify({
        commit: "0123456789abcdef",
        shortCommit: "0123456789ab",
        branch: "main",
        remote: "https://user:secret@example.com/org/repo.git",
        sourceInfoPath: "/home/builder/codex/.codex-linux/source-info.json",
        provenance: "packaged-update-builder",
      }),
      "utf8",
    );

    const info = sourceInfo(tempRoot, {});
    assert.equal(info.remote, "https://example.com/org/repo.git");
    assert.equal(info.commitUrl, null);
    assert.equal(info.sourceInfoPath, undefined);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("build info derives GitHub commit links from common remote forms", () => {
  assert.equal(
    githubCommitUrl("git@github.com:ilysenko/codex-desktop-linux.git", "0123456789abcdef"),
    "https://github.com/ilysenko/codex-desktop-linux/commit/0123456789abcdef",
  );
  assert.equal(
    githubCommitUrl("ssh://git@github.com/ilysenko/codex-desktop-linux.git", "fedcba9876543210"),
    "https://github.com/ilysenko/codex-desktop-linux/commit/fedcba9876543210",
  );
  assert.equal(githubCommitUrl("https://example.com/org/repo.git", "0123456789abcdef"), null);
  assert.equal(githubCommitUrl("https://github.com/org/repo.git", "not-a-sha"), null);
});

test("package profile distinguishes Fedora package managers by major version", () => {
  const fedora40 = detectLinuxTargetContext({
    osReleaseFields: { ID: "fedora", VERSION_ID: "40", PRETTY_NAME: "Fedora Linux 40" },
    env: { PATH: "" },
    atomic: false,
  });
  const fedora41 = detectLinuxTargetContext({
    osReleaseFields: { ID: "fedora", VERSION_ID: "41", PRETTY_NAME: "Fedora Linux 41" },
    env: { PATH: "" },
    atomic: false,
  });

  assert.equal(packageProfile(fedora40).packageManager, "dnf");
  assert.equal(packageProfile(fedora41).packageManager, "dnf5");
});

test("package profile identifies Fedora Atomic hosts that use rpm-ostree", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-fedora-atomic-target-"));
  try {
    const binDir = path.join(tempRoot, "bin");
    const ostreeBootedPath = path.join(tempRoot, "ostree-booted");
    fs.mkdirSync(binDir, { recursive: true });
    for (const command of ["rpm-ostree", "rpmbuild"]) {
      const commandPath = path.join(binDir, command);
      fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(commandPath, 0o755);
    }
    fs.writeFileSync(ostreeBootedPath, "", "utf8");

    const fedoraAtomic = detectLinuxTargetContext({
      osReleaseFields: {
        ID: "fedora",
        ID_LIKE: "",
        VERSION_ID: "44",
        PRETTY_NAME: "Fedora Linux 44 (KDE Plasma Desktop Edition)",
      },
      env: {
        PATH: binDir,
        OSTREE_BOOTED_FILE: ostreeBootedPath,
      },
    });

    assert.equal(fedoraAtomic.atomic, true);
    assert.equal(fedoraAtomic.packageFormat, "rpm");
    assert.equal(fedoraAtomic.packageManager, "rpm-ostree");
    assert.equal(fedoraAtomic.packageManagerIs("rpm-ostree"), true);
    assert.equal(packageProfile(fedoraAtomic).id, "fedora-atomic");
    assert.equal(packageProfile(fedoraAtomic).packageManager, "rpm-ostree");

    const fedoraInvalidAtomicOverride = detectLinuxTargetContext({
      osReleaseFields: {
        ID: "fedora",
        ID_LIKE: "",
        VERSION_ID: "44",
      },
      env: {
        PATH: binDir,
        CODEX_LINUX_TARGET_ATOMIC: "maybe",
        OSTREE_BOOTED_FILE: ostreeBootedPath,
      },
    });

    assert.equal(fedoraInvalidAtomicOverride.atomic, true);
    assert.equal(fedoraInvalidAtomicOverride.packageManager, "rpm-ostree");

    const fedoraAtomicOverrideOff = detectLinuxTargetContext({
      osReleaseFields: {
        ID: "fedora",
        ID_LIKE: "",
        VERSION_ID: "44",
      },
      env: {
        PATH: binDir,
        CODEX_LINUX_TARGET_ATOMIC: "0",
        OSTREE_BOOTED_FILE: ostreeBootedPath,
      },
    });

    assert.equal(fedoraAtomicOverrideOff.atomic, false);
    assert.equal(fedoraAtomicOverrideOff.packageManager, "unknown");
    assert.equal(packageProfile(fedoraAtomicOverrideOff).id, "fedora-41-plus");

    const fedoraRegular = detectLinuxTargetContext({
      osReleaseFields: {
        ID: "fedora",
        ID_LIKE: "",
        VERSION_ID: "44",
        PRETTY_NAME: "Fedora Linux 44",
      },
      env: {
        PATH: binDir,
        OSTREE_BOOTED_FILE: path.join(tempRoot, "missing-ostree-booted"),
      },
    });

    assert.equal(fedoraRegular.atomic, false);
    assert.equal(fedoraRegular.packageManager, "unknown");
    assert.equal(packageProfile(fedoraRegular).id, "fedora-41-plus");
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
    "linux-ready-to-show-window-state",
    "linux-explicit-quit-prompt-bypass",
    "linux-explicit-quit-drain-timeout",
    "linux-explicit-tray-quit",
    "linux-explicit-ipc-quit",
    "linux-window-options",
    "linux-about-dialog",
    "linux-native-titlebar",
    "linux-menu",
    "linux-multi-instance-bootstrap-lock",
    "linux-set-icon",
    "linux-resize-repaint",
    "linux-opaque-background",
    "linux-owl-feature-binding-fallback",
    "linux-avatar-overlay-mouse-passthrough",
    "linux-browser-use-availability",
    "linux-browser-use-non-local-navigation",
    "linux-browser-use-external-availability",
    "linux-chat-search-hydration",
    "linux-file-manager",
    "linux-host-child-process-environment",
    "linux-terminal-host-environment",
    "linux-worker-file-manager",
    "linux-terminal-user-path",
    "linux-tray",
    "linux-build-info-tray",
    "linux-single-instance",
    "linux-computer-use-ui-feature",
    "linux-computer-use-plugin-gate",
    "linux-computer-use-native-desktop-apps",
    "linux-chrome-plugin-auto-install",
    "linux-chrome-native-host-runtime",
    "browser-use-node-repl-approval",
    "linux-bundled-plugin-reconcile-stale-snapshot",
    "linux-bundled-plugin-copy-permissions",
    "linux-browser-use-route-liveness",
    "linux-chrome-extension-status",
    "linux-notification-actions",
    "linux-local-app-server-feature-enablement-handler",
    "linux-remote-control-config-preservation",
    "linux-app-updater-menu",
    "linux-settings-persistence",
    "linux-launch-actions",
    "linux-hotkey-window-prewarm",
    "linux-git-origins-source-fallback",
    "linux-external-open-env",
    "linux-xdg-documents-dir",
    "linux-projectless-xdg-documents-dir",
    "linux-workspace-root-open-targets",
    "linux-settings-search-visibility",
    "linux-i18n-gate",
    "automation-schedule-multi-time-rrule",
    "automation-update-eager-tool",
    "linux-app-sunset-gate",
    "linux-app-server-feature-enablement",
    "linux-app-server-backfill-wait",
    "linux-skills-list-dedupe",
    "linux-config-write-version-conflict",
    "linux-application-menu",
    "linux-x11-project-picker",
    "opaque-window-default-general-settings",
    "opaque-window-default-webview-index",
    "linux-window-controls-safe-area",
    "linux-tooltip-window-controls-collision",
    "linux-thread-side-panel-native-tooltip",
    "linux-fast-mode-model-guard",
    "linux-safe-monospace-font-stack",
    "subagent-nickname-metadata-shape",
    "local-environment-action-modal-draft",
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
    "extracted-app:post-webview",
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-owl-feature-binding-fallback")?.phase,
    "extracted-app:pre-webview",
  );
  assert.match(
    descriptors.find((descriptor) => descriptor.id === "linux-chrome-plugin-auto-install")?.sourcePath,
    /main-process[\\/]browser-integrations[\\/]patch\.js$/,
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "local-environment-action-modal-draft")?.ciPolicy,
    "optional",
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-host-child-process-environment")
      ?.ciPolicy,
    "optional",
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-terminal-host-environment")?.ciPolicy,
    "optional",
  );
  assert.equal(
    descriptors.find(
      (descriptor) => descriptor.id === "linux-bundled-plugin-reconcile-stale-snapshot",
    )?.ciPolicy,
    "optional",
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-x11-project-picker")?.ciPolicy,
    "optional",
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-computer-use-native-desktop-apps")?.ciPolicy,
    "opt-in",
  );
  const computerUseInstallFlow = descriptors.find((descriptor) => descriptor.id === "linux-computer-use-install-flow");
  assert.equal(
    computerUseInstallFlow.pattern.test(
      "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-current.js",
    ),
    true,
  );
  for (const legacyName of [
    "app-initial~app-main~pull-request-code-review~onboarding-page~hotkey-window-thread-page~cha~b76hmflu-current.js",
    "app-initial~app-main~remote-conversation-page~new-thread-panel-page~onboarding-page~appgen-~current.js",
    "plugins-availability-current.js",
    "use-plugin-install-flow-current.js",
    "app-initial~app-main~remote-conversation-page~plugin-detail-page~new-thread-panel-page~current.js",
    "app-initial~app-main~remote-conversation-page~pull-requests-page~plug~current.js",
  ]) {
    assert.equal(computerUseInstallFlow.pattern.test(legacyName), false, legacyName);
  }
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-terminal-user-path")?.ciPolicy,
    "optional",
  );
  for (const id of [
    "linux-window-options",
    "linux-native-titlebar",
    "linux-opaque-background",
    "linux-avatar-overlay-mouse-passthrough",
    "linux-tray",
  ]) {
    assert.equal(
      descriptors.find((descriptor) => descriptor.id === id)?.ciPolicy,
      "required-upstream",
      `${id} should block upstream builds when it drifts`,
    );
  }
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-external-open-env")?.ciPolicy,
    "optional",
    "external URL handoff drift should warn without blocking install/rebuild",
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "linux-workspace-root-open-targets")?.ciPolicy,
    "optional",
    "workspace-root open targets should not block app builds when upstream removes the File Manager insertion point",
  );

  const descriptorOrder = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor.order]));
  assert.ok(
    descriptorOrder.get("linux-native-titlebar") > descriptorOrder.get("linux-opaque-background"),
    "linux-native-titlebar must run after linux-opaque-background so it can reuse the inserted Linux background branch aliases",
  );
});

test("app-server feature enablement descriptor matches current app-main chunks", () => {
  const descriptor = corePatchDescriptors().find(
    (descriptor) => descriptor.id === "linux-app-server-feature-enablement",
  );

  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("app-main-DxUcMyo0.js"), true);
  assert.equal(
    descriptor.pattern.test("app-initial~app-main~automations-page-BfqUlSo6.js"),
    true,
  );
  assert.equal(descriptor.pattern.test("experimental-feature-visibility-Bvp90zWX.js"), false);
});

test("window controls safe-area descriptor matches current app shell chunks", () => {
  const descriptor = corePatchDescriptors().find(
    (descriptor) => descriptor.id === "linux-window-controls-safe-area",
  );

  assert.ok(descriptor);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~appgen-settings-page~settings-page~skills-settings~plugins-settings~re~old.js",
    ),
    false,
  );
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-current.js",
    ),
    true,
  );
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~hotkey-window-thread-page~thread-app-shell-chrome~header~remote-conver~current.js",
    ),
    false,
  );
});

test("patch descriptors reject unsupported ciPolicy values", () => {
  assert.throws(
    () =>
      normalizePatchDescriptors([
        {
          id: "unsupported-policy",
          ciPolicy: "required",
          apply: (source) => source,
        },
      ]),
    /unsupported ciPolicy 'required'/,
  );
});

test("opt-in patch descriptors are recognized as non-critical drift", () => {
  const [descriptor] = normalizePatchDescriptors([
    {
      id: "opt-in-policy",
      ciPolicy: "opt-in",
      apply: (source) => source,
    },
  ]);
  assert.equal(descriptor.ciPolicy, "opt-in");

  const report = {
    patches: [
      {
        name: "opt-in-policy",
        status: "skipped-optional",
        ciPolicy: "opt-in",
        reason: "enable gate disabled",
      },
    ],
  };
  assert.deepEqual(criticalFailuresFromReport(report), []);
  assert.deepEqual(optionalDriftFromReport(report), [
    { name: "opt-in-policy", status: "skipped-optional", reason: "enable gate disabled" },
  ]);
});

test("fast-mode guard descriptor follows upstream service-tier bundle names", () => {
  const descriptor = corePatchDescriptors().find((descriptor) =>
    descriptor.id === "linux-fast-mode-model-guard",
  );

  assert.ok(descriptor.pattern.test("use-is-fast-mode-enabled-abc.js"));
  assert.ok(descriptor.pattern.test("read-service-tier-for-request-BJ8QN0Q7.js"));
  assert.ok(descriptor.pattern.test("use-service-tier-settings-DFXPADNF.js"));
  assert.ok(descriptor.pattern.test("app-server-manager-signals-BOGyjFm3.js"));
  assert.equal(descriptor.pattern.test("service-tier-icons-CsNhab5W.js"), false);
});

test("subagent nickname metadata descriptor follows upstream metadata bundle names", () => {
  const descriptor = corePatchDescriptors().find((descriptor) =>
    descriptor.id === "subagent-nickname-metadata-shape",
  );

  assert.ok(descriptor.pattern.test("app-server-manager-signals-BOGyjFm3.js"));
  assert.ok(descriptor.pattern.test("use-host-config-Dpd_LQBD.js"));
  assert.equal(descriptor.pattern.test("thread-context-inputs-D5uMjcUB.js"), false);
});

function trayBundleFixture() {
  return [
    "async function Hw(e){return process.platform!==`win32`&&process.platform!==`darwin`?null:(zw=!0,Lw??Rw??(Rw=(async()=>{let r=await Ww(e.buildFlavor,e.appBrand,e.repoRoot),i=new n.Tray(r.defaultIcon);return i})()))}",
    "async function Ww(e,t,i){if(process.platform===`darwin`){return null}let r=K9(e,t,i);return r==null?{defaultIcon:await n.app.getFileIcon(process.execPath,{size:`small`}),chronicleRunningIcon:null}:{defaultIcon:r,chronicleRunningIcon:null}}",
    "function K9(e,t,r){let a=[(0,i.join)(r,`electron`,`src`,`icons`,`tray.png`)];for(let e of a){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return t}return null}",
    "var pb=class{nativeTrayClickSuppressionReason=null;clearNativeTrayClickSuppressionTimeout=null;chronicleTrayIconRefreshInterval=null;chronicleTrayIconState=`default`;isNativeTrayMenuOpen=!1;trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(){this.tray={on(){},setContextMenu(){},popUpContextMenu(){}};this.onTrayButtonClick=()=>{};this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}async handleMessage(e){switch(e.type){case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return}}openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}updateChronicleTrayIcon(){}getNativeTrayMenuItems(){return[]}}",
    "v&&k.on(`close`,e=>{this.persistPrimaryWindowBounds(k);let t=this.getPrimaryWindows().some(e=>e!==k);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}if(process.platform===`darwin`&&!this.isAppQuitting&&!t){e.preventDefault(),k.hide()}});",
    "let oe=async()=>{O=!0;try{await Hw({appBrand:a.U(),buildFlavor:b,repoRoot:j.repoRoot})}catch(e){O=!1,v.reportNonFatal(e instanceof Error?e:`Failed to set up tray`,{kind:`tray-setup-failed`,tags:{errorType:`tray-setup-failed`}}),N.ensureWindow()}};E&&oe();",
  ].join("");
}

function currentTrayMenuBundleFixture() {
  return [
    "var sW=class{trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(){this.tray={on(){},setContextMenu(){},popUpContextMenu(){}}}getNativeTrayMenuItems(){let{pinnedThreads:e,recentThreads:t,runningThreads:r,unreadThreads:i,usageLimits:a}=this.trayMenuThreads,o=this.nativeIntl.formatMessage({messageId:vc,defaultMessage:yc}),s=this.nativeIntl.formatMessage({messageId:gc,defaultMessage:_c}),c=uW({label:this.nativeIntl.formatMessage({messageId:oc,defaultMessage:sc}),moreLabel:s,threads:r,projectlessLabel:o,onOpenThread:this.onTrayMenuOpenRecentThread}),h=[c].filter(e=>e.length>0).flatMap((e,t)=>t===0?e:[{type:`separator`},...e]);return[...h,...h.length>0?[{type:`separator`}]:[],{label:this.nativeIntl.formatMessage({messageId:nc,defaultMessage:rc}),click:()=>{this.onTrayMenuOpenNewThread()}},{type:`separator`},{label:fW(this.appName),click:()=>{n.app.quit()}}]}};",
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
    "n.app.on(`will-quit`,e=>{if(g=!0,!h){if(i.shouldSkipDrainBeforeQuit()){mB({hotkeyWindowLifecycleManager:c,globalDictationLifecycleManager:l,flushAndDisposeContexts:d,disposables:f});return}e.preventDefault(),h=!0,c.dispose(),l.dispose(),Promise.all([u.flush(),p.flush()]).finally(()=>{d(),f.dispose(),n.app.quit()})}});",
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
    "var lt=`browser-use`,ut=`chrome`,dt=`chrome-internal`,xt=`chrome-dev`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:rr},{forceReload:!0,name:xt,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,env:t,features:n})=>Ar(e,t)&&n.externalBrowserUseAllowed},{forceReload:!0,name:dt,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,env:t,features:n})=>jr(e,t)&&n.externalBrowserUseAllowed},{forceReload:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&$n(e)},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{forceReload:!0,installWhenMissing:!0,name:ft,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.T.isInternal(e)&&r===`win32`&&n.computerUse},{name:pt,isAvailable:()=>!0}];",
  ].join("");
}

function currentChromePluginGateBundleFixture() {
  return [
    "var o={c:`chrome`,s:`chrome-dev`},n={Cs:e=>!0};",
    "var Kr=[{forceReload:!0,name:o.s,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,env:t,features:r})=>Ar(e,t)&&r.externalBrowserUseAllowed},{forceReload:!0,name:o.c,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&n.Cs(e)}];",
  ].join("");
}

function currentBundledPluginCopyBundleFixture() {
  return (
    "let p=require(`node:path`);" +
    "let m=require(`node:fs/promises`);m={default:m};" +
    "let g={default:{platform:process.platform}};" +
    "async function fl(e,t){if(g.default.platform===`darwin`){return}if(g.default.platform!==`win32`){await m.default.cp(e,t,{recursive:!0,verbatimSymlinks:!0});return}}"
  );
}

function chromeNativeHostRuntimeBundleFixture() {
  return [
    "let r=require(`node:path`),o=require(`node:fs`);",
    "function Mc({resourcesPath:e,executableName:t}){if(!e)return null;let n=(0,r.join)(e,t);try{return(0,o.statSync)(n).isFile()?n:null}catch{return null}}",
    "function Pc(e){return Mc({resourcesPath:e,executableName:process.platform===`win32`?`node_repl.exe`:`node_repl`})}",
    "function Fc(e){return Mc({resourcesPath:e,executableName:process.platform===`win32`?`node.exe`:`node`})}",
    "function Ic(e){return Mc({resourcesPath:e,executableName:process.platform===`win32`?`codex.exe`:`codex`})}",
    "function Qp(e){let t=Ic(e.resourcesPath)??$p(e.devRuntimeRepoRoot,[`extension`,`bin`,process.platform===`win32`?`codex.exe`:`codex`]),n=Fc(e.resourcesPath)??$p(e.devRuntimeRepoRoot,[`electron`,`bin`,process.platform===`win32`?`node.exe`:`node`]),r=Pc(e.resourcesPath)??$p(e.devRuntimeRepoRoot,[`electron`,`bin`,process.platform===`win32`?`node_repl.exe`:`node_repl`]),i=[t==null?`codex`:null,n==null?`node`:null,r==null?`node_repl`:null].filter(e=>e!=null);if(i.length>0)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}: ${i.join(`, `)} (resourcesPath: ${e.resourcesPath}).`);if(t==null||n==null||r==null)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}.`);return{codexCliPath:t,nodePath:n,nodeReplPath:r}}",
    "function $p(e,t){if(e==null)return null;let n=(0,r.join)(e,...t);try{return(0,o.statSync)(n).isFile()?n:null}catch{return null}}",
  ].join("");
}

function currentChromeNativeHostRuntimeBundleFixture() {
  return [
    "let r=require(`node:path`),o=require(`node:fs`);",
    "function Mc({resourcesPath:e,executableName:t}){if(!e)return null;let n=(0,r.join)(e,t);try{return(0,o.statSync)(n).isFile()?n:null}catch{return null}}",
    "function Oj(e){return Mc({resourcesPath:e,executableName:process.platform===`win32`?`node_repl.exe`:`node_repl`})}",
    "function kj(e){return Mc({resourcesPath:e,executableName:process.platform===`win32`?`node.exe`:`node`})}",
    "function Nj(e){return Mc({resourcesPath:e,executableName:process.platform===`win32`?`codex.exe`:`codex`})}",
    "function QL(e){let t=Nj(e.resourcesPath)??$L(e.devRuntimeRepoRoot,[`extension`,`bin`,process.platform===`win32`?`codex.exe`:`codex`]),n=kj(e.resourcesPath),r=Oj(e.resourcesPath),i=[t==null?`codex`:null,n==null?`node`:null,r==null?`node_repl`:null].filter(e=>e!=null);if(i.length>0)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}: ${i.join(`, `)} (resourcesPath: ${e.resourcesPath}).`);if(t==null||n==null||r==null)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}.`);return{codexCliPath:t,nodePath:n,nodeModuleDirs:Aj(e.resourcesPath),nodeReplPath:r}}",
    "function $L(e,t){if(e==null)return null;let n=(0,r.join)(e,...t);try{return(0,o.statSync)(n).isFile()?n:null}catch{return null}}",
    "function Aj(e){return []}",
  ].join("");
}

function currentBrowserUseTrustedHashesRuntimeBuilderFixture() {
  return "\"use strict\";let l=require(`node:fs`),s=require(`node:path`),u=require(`node:crypto`);function build({codexHome:t,nodePath:i,nodeReplPath:a,trustedBrowserClientSha256s:h=[],shouldUseWslPaths:f}){return h}";
}

const currentBrowserUseTrustedHashesInsertionRegex =
  /trustedBrowserClientSha256s:h=\[\],shouldUseWslPaths:f\}\)\{h=codexLinuxTrustedBrowserClientSha256s\(h\);return h/;

function electron42BrowserUseRuntimeResolverBundleFixture() {
  return [
    "let s=require(`node:path`),l=require(`node:fs`);",
    "function tt({resourcesPath:e}){return e}",
    "function Kn(e){return e===`linux`?`/primary/node`:null}",
    "function Hn({env:e=process.env,isPackaged:n=!0,platform:r=process.platform,repoRoot:i=process.cwd(),resolveCodexPath:a=t.Wn,resolveNodePath:o=t.Gn,resolveNodeReplPath:s=t.Kn,resolvePrimaryRuntimeNodePath:c=Kn,resourcesPath:l}){let u=l??tt({env:e,resourcesPath:process.resourcesPath}),d=c(r),f=Gn({platform:r,rawValue:e.CODEX_CLI_PATH,resolveWindowsAppsPath:a})??Wn({devRelativePathSegments:[`extension`,`bin`,`codex`],isPackaged:n,platform:r,repoRoot:i,resolveBundledPath:a,resourcesPath:u}),p=Wn({devRelativePathSegments:null,isPackaged:n,platform:r,repoRoot:i,resolveBundledPath:o,resourcesPath:u}),m=Gn({platform:r,rawValue:e.CODEX_BROWSER_USE_NODE_PATH,resolveWindowsAppsPath:o})??(p.path==null&&d!=null?{path:d,source:`primary-runtime`}:p),h=Gn({platform:r,rawValue:e.CODEX_NODE_REPL_PATH,resolveWindowsAppsPath:s})??Wn({devRelativePathSegments:null,isPackaged:n,platform:r,repoRoot:i,resolveBundledPath:s,resourcesPath:u});return{codexCliPath:f.path,codexCliPathSource:f.source,nodeModuleDirs:t.Vn(u),nodePath:m.path,nodePathSource:m.source,nodeReplPath:h.path,nodeReplPathSource:h.source,platform:r}}",
    "function Wn(e){return{path:null,source:`missing`}}function Gn({rawValue:e}){return e==null?null:{path:e,source:`env-override`}}",
  ].join("");
}

function currentChromePluginAppServerRuntimeBundleFixture() {
  return [
    "let r=require(`node:path`),o=require(`node:fs`);",
    "async function XB(e){let t=ZB(e),n=NM(e.resourcesPath),r=MM(e.resourcesPath),i=[t==null?`codex`:null,n==null?`node`:null,r==null?`node_repl`:null].filter(e=>e!=null);if(i.length>0)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}: ${i.join(`, `)} (resourcesPath: ${e.resourcesPath}).`);if(t==null||n==null||r==null)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}.`);return{codexCliPath:await fz({codexCliPath:t,codexHome:e.codexHome,nativeHostName:e.nativeHostName}),nodePath:n,nodeModuleDirs:PM(e.resourcesPath),nodeReplPath:r}}",
    "function ZB(e){return LM(e.resourcesPath)??QB(e.devRuntimeRepoRoot,[`extension`,`bin`,process.platform===`win32`?`codex.exe`:`codex`])}function NM(e){return null}function MM(e){return null}function PM(e){return []}function QB(e,t){return null}function LM(e){return null}async function fz({codexCliPath:e}){return e}",
  ].join("");
}

function currentChromePluginCodexAppServerRuntimeBundleFixture() {
  return [
    "let r=require(`node:path`),o=require(`node:fs`);",
    "async function VH(e){let t=_U(e);if(t==null)throw Error(`Missing bundled Electron Codex runtime required to sync Chrome plugin app server for ${e.nativeHostName} (resourcesPath: ${e.resourcesPath??`<none>`}).`);return AV({codexCliPath:t,codexHome:e.codexHome,nativeHostName:e.nativeHostName})}",
    "function _U(e){return tM(e.resourcesPath)??vU(e.devRuntimeRepoRoot,[`extension`,`bin`,process.platform===`win32`?`codex.exe`:`codex`])}function vU(e,t){return null}function tM(e){return null}async function AV({codexCliPath:e}){return{codexCliPath:e}}",
  ].join("");
}

function currentChromePluginIsolatedAppServerRuntimeBundleFixture() {
  const runtime = currentChromePluginCodexAppServerRuntimeBundleFixture().replace(
    "async function AV({codexCliPath:e}){return{codexCliPath:e}}",
    "async function AV(e){let t=e.nativeHostName===nU,n=e.codexCliPath,r=process.env.ISSUE805_ISOLATED_CLI;o.copyFileSync(n,r);o.chmodSync(r,448);return r}",
  );
  return [
    "async function decoy(e){let t=e.nativeHostName===nU;return `decoy`}",
    "var tU=`.plugin-appserver`,nU=`com.openai.codexextension`;",
    runtime,
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

function currentChromeExtensionStatusAliasCollisionBundleFixture() {
  return [
    "let a=require(`node:os`),t=require(`node:path`),o=require(`node:fs`);",
    "var nm=`com.google.Chrome`,rm=`/usr/bin/open`,im=/^[a-p]{32}$/;",
    "function am(e){return`chrome://extensions/?id=${um(e)}`}",
    "function om({extensionId:e,homeDir:n=(0,a.homedir)(),localAppDataDir:r=process.env.LOCALAPPDATA,platform:a=process.platform}){let s=um(e),c=dm({homeDir:n,localAppDataDir:r,platform:a});return c==null||!(0,o.existsSync)(c)?!1:(0,o.readdirSync)(c,{withFileTypes:!0}).some(e=>e.isDirectory()&&(0,o.existsSync)((0,t.join)(c,e.name,`Extensions`,s)))}async function sm({extensionId:e,platform:t=process.platform,detectChromeCommand:n=cm,runCommand:r=zp}){if(t===`darwin`){await r(rm,[`-b`,nm,am(e)]);return}if(t===`win32`){let t=n();if(t==null)throw Error(`Google Chrome is not installed`);await r(t,[am(e)]);return}throw Error(`Opening Chrome extension settings is only supported on macOS and Windows`)}function cm(){return Fp(`chrome.exe`)}",
    "function lm(){return null}function um(e){let t=e.trim();if(!im.test(t))throw Error(`Invalid Chrome extension id`);return t}function dm({homeDir:e,localAppDataDir:n,platform:r}){return r===`darwin`?(0,t.join)(e,`Library`,`Application Support`,`Google`,`Chrome`):r===`win32`?(0,t.join)(n??(0,t.join)(e,`AppData`,`Local`),`Google`,`Chrome`,`User Data`):null}",
    "function Fp(e){return e}async function zp(){}",
  ].join("");
}

function currentLaunchActionBundleFixture() {
  return [
    "const e={gr:e=>({default:e,...e})};let n=require(`electron`);let i=require(`node:path`);i=e.gr(i);let o=require(`node:fs`);o=e.gr(o);let f=require(`node:net`);f=e.gr(f);",
    "async function CN(){let{setSecondInstanceArgsHandler:l}=t.y(),g={reportNonFatal(){}},k=new t.In;k.add(x);let j={globalState:{get(){return true}},repoRoot:`/tmp`,codexHome:`/tmp`},M={hotkeyWindowLifecycleManager:{hide(){},ensureHotkeyWindowController(){}},getPrimaryWindow(){},createFreshLocalWindow(){},ensureHostWindow(){},windowManager:{sendMessageToWindow(){}}},B=`local`,R={desktopNotificationManager:{dismissByNavigationPath(){}},getOrCreateContext(){},localHost:B},z={deepLinks:{queueProcessArgs(){},flushPendingDeepLinks(){}},navigateToRoute(){}};let A=Date.now(),w=()=>{},ae=e=>{e.isMinimized()&&e.restore(),e.show(),e.focus()},le=async()=>{try{M.hotkeyWindowLifecycleManager.hide();let e=M.getPrimaryWindow()??await M.createFreshLocalWindow(`/`);if(e==null)return;ae(e)}catch(e){g.reportNonFatal(e instanceof Error?e:`Failed to open window on second instance`,{kind:`second-instance-open-window-failed`})}};l(e=>{let n=t.t(t.g(e));if(z.deepLinks.queueProcessArgs(e)){n&&le();return}if(n){le();return}le()});let ue=async(e,t)=>{M.hotkeyWindowLifecycleManager.hide();let n=M.getPrimaryWindow(),r=n??await M.createFreshLocalWindow(e);r!=null&&(R.desktopNotificationManager.dismissByNavigationPath(e),n!=null&&t.navigateExistingWindow&&z.navigateToRoute(r,e),ae(r))};let ce=async()=>{};E&&ce();let be=await M.ensureHostWindow(B);be&&ae(be),w(`local window ensured`,A,{hostId:B,localWindowVisible:be?.isVisible()??!1}),A=Date.now(),await z.deepLinks.flushPendingDeepLinks();}",
  ].join("");
}

function currentLaunchActionBundleWithWindowApiDriftFixture() {
  return currentLaunchActionBundleFixture()
    .replaceAll("createFreshLocalWindow", "createFreshWindow")
    .replace("getPrimaryWindow()??await M.createFreshWindow(`/`)", "getPrimaryWindow()??await M.createFreshWindow(`/`)")
    .replace("let n=M.getPrimaryWindow(),r=n??await M.createFreshWindow(e);", "let n=M.getPrimaryWindow(),r=n??await M.createFreshWindow(e);");
}

function settingsPersistenceBundleFixture() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`);",
    "var s=`.codex-global-state.json`;",
    "const h={\"set-global-state\":async({key:a,value:b,origin:c})=>(this.globalState.set(a,b),Promise.resolve())};",
  ].join("");
}

function currentSettingsPersistenceBundleFixture() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`);",
    "var s=`.codex-global-state.json`,c=`config.toml`;",
    "const h={\"set-global-state\":async({key:a,value:b,origin:c})=>(this.setGlobalStateValue(a,b,c),{success:!0})};",
  ].join("");
}

function legacySettingsPersistenceBundleFixture() {
  return [
    "let i=require(`node:path`),o=require(`node:fs`);",
    "var s=`.codex-global-state.json`;function codexLinuxSettingsPath(){let e=process.env.XDG_CONFIG_HOME||process.env.HOME&&i.join(process.env.HOME,`.config`);return e?i.join(e,`codex-desktop`,`settings.json`):null}function codexLinuxReadSettingsFile(){let e=codexLinuxSettingsPath();if(!e||!o.existsSync(e))return{};try{let t=o.readFileSync(e,`utf8`),n=JSON.parse(t);return n&&typeof n===`object`&&!Array.isArray(n)?n:{}}catch(e){return{}}}function codexLinuxPersistSettingsState(e,t){if(process.platform!==`linux`||![`codex-linux-prompt-window-enabled`,`codex-linux-system-tray-enabled`,`codex-linux-warm-start-enabled`].includes(e))return;try{let n=codexLinuxSettingsPath();if(!n)return;let r=codexLinuxReadSettingsFile();t===void 0?delete r[e]:r[e]=t,o.mkdirSync(i.dirname(n),{recursive:!0,mode:448}),o.writeFileSync(n,JSON.stringify(r,null,2)+`\\n`,`utf8`)}catch(e){}}",
    "const h={\"set-global-state\":async({key:a,value:b,origin:c})=>(this.globalState.set(a,b),codexLinuxPersistSettingsState(a,b),Promise.resolve())};",
  ].join("");
}

function runSettingsPersistence(patchedSource, env, key, value) {
  vm.runInNewContext(
    `${patchedSource};codexLinuxPersistSettingsState(${JSON.stringify(key)},${JSON.stringify(value)});`,
    {
      console,
      JSON,
      Promise,
      require,
      process: { env, platform: "linux" },
    },
  );
}

function keybindsIndexBundleFixture() {
  return [
    'import{n as routeModule,s as routeToESM}from"./rolldown-runtime-A.js";',
    'import{I as routeJsxFactory,R as routeReactFactory}from"./shared-runtime-A.js";',
    "function Z(e){let r=(0,RouteReact.lazy)(e);function SettingsRouteWrapper(){let t=(0,RouteReact.useState)(null);return (0,RouteJsx.jsx)(r,{children:t})}return SettingsRouteWrapper}",
    "var RouteReact,RouteJsx;routeModule(()=>{RouteReact=routeToESM(routeReactFactory(),1),RouteJsx=routeJsxFactory()})();",
    "var Kge={\"general-settings\":xh,appearance:Pf,\"git-settings\":t1};",
    "var i_e={\"general-settings\":Z(async()=>(await s(async()=>{let{GeneralSettings:e}=await import(`./general-settings-DsLl9t6Z.js`);return{GeneralSettings:e}},[],import.meta.url)).GeneralSettings),appearance:Z(async()=>(await s(async()=>{let{Appearance:e}=await import(`./appearance.js`);return{Appearance:e}},[],import.meta.url)).Appearance)};",
    "qge=[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`];",
    "Jge=[{key:`app`,heading:H7.appHeading,slugs:[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`]}];",
    "switch(e){case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;}",
    "switch(e){case`usage`:k=g;break bb0;case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;}",
    "export{SettingsRouteWrapper};",
  ].join("");
}

function settingsSharedBundleFixture() {
  return [
    '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},appearance:{id:`settings.nav.appearance`,defaultMessage:`Appearance`,description:`Title for appearance settings section`},',
    "function titleForSection(e){switch(e){case`general-settings`:{let e;return t[2]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(n,{id:`settings.section.general-settings`,defaultMessage:`General`,description:`Title for general settings section`}),t[2]=e):e=t[2],e}case`appearance`:return (0,d.jsx)(n,{id:`settings.section.appearance`,defaultMessage:`Appearance`,description:`Title for appearance settings section`})}}",
  ].join("");
}

// Same bundle as settingsSharedBundleFixture() but with the minified JSX message
// component bound to `r` instead of `n` (and the memo cache as `o[5]`), mirroring
// the identifiers shipped in Codex 26.601.21317 (settings-shared-BibDzP9i.js).
// The minifier picks these letters arbitrarily, so the patch must not hardcode them.
function settingsSharedBundleWithDriftingJsxAliasFixture() {
  return [
    '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},appearance:{id:`settings.nav.appearance`,defaultMessage:`Appearance`,description:`Title for appearance settings section`},',
    "function titleForSection(e){switch(e){case`general-settings`:{let e;return o[5]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(r,{id:`settings.section.general-settings`,defaultMessage:`General`,description:`Title for general settings section`}),o[5]=e):e=o[5],e}case`appearance`:return (0,d.jsx)(r,{id:`settings.section.appearance`,defaultMessage:`Appearance`,description:`Title for appearance settings section`})}}",
  ].join("");
}

function linuxDesktopRouteBundleFixture() {
  return [
    'import{n as routeModule,s as routeToESM}from"./rolldown-runtime-A.js";',
    'import{I as routeJsxFactory,R as routeReactFactory}from"./shared-runtime-A.js";',
    "function $(e){let r=(0,RouteReact.lazy)(e);function SettingsRouteWrapper(){let t=(0,RouteReact.useState)(null);return (0,RouteJsx.jsx)(r,{children:t})}return SettingsRouteWrapper}",
    "var RouteReact,RouteJsx;routeModule(()=>{RouteReact=routeToESM(routeReactFactory(),1),RouteJsx=routeJsxFactory()})();",
    "var DE={",
    '"general-settings":$(async()=>(await Xr(async()=>{let{GeneralSettings:e}=await import(`./general-settings-A.js`);return{GeneralSettings:e}},[],import.meta.url)).GeneralSettings),',
    "profile:$(async()=>(await Xr(async()=>{let{Profile:e}=await import(`./profile-A.js`);return{Profile:e}},[],import.meta.url)).Profile),",
    '"keyboard-shortcuts":$(async()=>(await Xr(async()=>{let{KeyboardShortcutsSettings:e}=await import(`./keyboard-shortcuts-settings-A.js`);return{KeyboardShortcutsSettings:e}},[],import.meta.url)).KeyboardShortcutsSettings)',
    "};",
    "export{SettingsRouteWrapper};",
  ].join("");
}

function linuxDesktopNavigationBundleFixture() {
  return [
    'var ye={"general-settings":q,profile:ee,"keyboard-shortcuts":ve,appearance:le};',
    "var xe=[`general-settings`,`profile`,`appearance`,`keyboard-shortcuts`];",
    "var Se=[{key:`app`,slugs:[`general-settings`,`profile`,`appearance`]},{key:`connection`,slugs:[`agent`,`keyboard-shortcuts`}]}];",
    "function visible(e){switch(e.slug){case`appearance`:return!0;case`general-settings`:case`agent`:case`personalization`:return!0;case`keyboard-shortcuts`:return!0}}",
    "function loading(H){let W=!1;if(H)bb0:switch(H.slug){case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`personalization`:W=!1;break bb0;case`keyboard-shortcuts`:W=!1;break bb0}return W}",
  ].join("");
}

function createModernNativeKeyboardShortcutsSettingsFixture() {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-modern-native-shortcuts-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const writeAsset = (name, source = "") => {
    fs.writeFileSync(path.join(assetsDir, name), source, "utf8");
  };

  writeAsset("rolldown-runtime-A.js", "function n(e){return e}function s(e){return e}export{n,s};");
  writeAsset(
    "shared-runtime-A.js",
    'import{s as s}from"./rolldown-runtime-A.js";function jsxFactory(){return{jsx(){},jsxs(){},Fragment:"Fragment"}}function reactFactory(){return{useState(){},useCallback(){},useEffect(){}}}function memoCache(){}export{jsxFactory as I,memoCache as L,reactFactory as R};',
  );
  writeAsset(
    "setting-storage-A.js",
    'async function requestCodex(...args){let[request]=args,{params:params,source:source}=request;return send("vscode://codex/",params)}export{requestCodex as z};',
  );
  writeAsset(
    "toggle-A.js",
    'function t({checked,disabled,onChange,ariaLabel}){return {role:"switch","aria-checked":checked,"aria-label":ariaLabel,disabled,onClick:()=>onChange(!checked)}}export{t};',
  );
  writeAsset(
    "settings-row-A.js",
    "function a(e){let{label:t,description:n,control:r}=e;return null}export{a as r};",
  );
  writeAsset("settings-content-layout-A.js", "export{n,r,t};");
  writeAsset("settings-group-A.js", "export{n,t};");
  writeAsset("settings-surface-A.js", "export{t};");
  writeAsset(
    "keyboard-shortcuts-settings-A.js",
    [
      'import{n as __module,s as __toESM}from"./rolldown-runtime-A.js";',
      'import{I as __jsxFactory,L as __memoCache,R as __reactFactory}from"./shared-runtime-A.js";',
      "function KeyboardShortcutsSettings(){let t=(0,React.useState)(null);return (0,$.jsx)(`div`,{children:t})}",
      "var React,$;__module(()=>{React=__toESM(__reactFactory(),1),$=__jsxFactory()})();",
      "slug:`keyboard-shortcuts`;export{KeyboardShortcutsSettings};",
    ].join(""),
  );
  writeAsset(
    "settings-page-A.js",
    [
      'import{n as routeModule,s as routeToESM}from"./rolldown-runtime-A.js";',
      'import{I as routeJsxFactory,R as routeReactFactory}from"./shared-runtime-A.js";',
      "function DecoyState(){let t=(0,DecoyReact.useState)(null);return t}",
      "function DecoyView(){return (0,DecoyJsx.jsx)(`div`,{})}",
      "var DecoyReact,DecoyJsx;routeModule(()=>{DecoyReact=routeToESM(routeReactFactory(),1)});routeModule(()=>{DecoyJsx=routeJsxFactory()})();",
      "function Ya(e){let r=(0,RouteReact.lazy)(e);function SettingsRouteWrapper(){let t=(0,RouteReact.useState)(null);return (0,RouteJsx.jsx)(r,{children:t})}return SettingsRouteWrapper}",
      "var RouteReact,RouteJsx;routeModule(()=>{RouteReact=routeToESM(routeReactFactory(),1),RouteJsx=routeJsxFactory()})();",
      'var Zn={"general-settings":Ya(async()=>(await Pr(async()=>{let{GeneralSettings:e}=await import(`./general-settings-A.js`);return{GeneralSettings:e}},[],import.meta.url)).GeneralSettings),"keyboard-shortcuts":Ya(async()=>(await Pr(async()=>{let{KeyboardShortcutsSettings:e}=await import(`./keyboard-shortcuts-settings-A.js`);return{KeyboardShortcutsSettings:e}},[],import.meta.url)).KeyboardShortcutsSettings)};',
      'var Hn={"general-settings":wt,"keyboard-shortcuts":xn};',
      "var Wn=[`general-settings`,`profile`,`keyboard-shortcuts`];",
      "var Qn=[{key:`app`,slugs:[`general-settings`,`profile`,`keyboard-shortcuts`]}];",
      "function visible(e){switch(e.slug){case`general-settings`:case`agent`:case`personalization`:return!0;case`keyboard-shortcuts`:return!0}}",
      "function loading(H){let W=!1;if(H)bb0:switch(H.slug){case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`personalization`:W=!1;break bb0;case`keyboard-shortcuts`:W=!1;break bb0}return W}",
      "export{SettingsRouteWrapper};",
    ].join(""),
  );
  writeAsset(
    "app-initial~app-main~page~remote-conversation-page~new-thread-panel-page~settings-page~shared-A.js",
    settingsSharedBundleFixture(),
  );
  writeAsset(
    "app-initial~app-main~remote-conversation-page~settings-page~hotkey-window-thread-page~mcp-s-A.js",
    [
      "var c,l=e((()=>{c=`general-settings.import.profile.keyboard-shortcuts.codex-micro.appshots.appearance.pets.agent.git-settings.data-controls.cloud-settings.cloud-environments.code-review.personalization.usage.browser-use.computer-use.local-environments.worktrees.environments.mcp-settings.hooks-settings.connections.plugins-settings.skills-settings`.split(`.`)})),u,d,f,p=e((()=>{",
      "l(),u=`general-settings`,d=function(e){return e.String=`string`,e.Array=`array`,e.Record=`record`,e}({}),",
      "f=[{slug:`general-settings`},{slug:`import`},{slug:`profile`},{slug:`appearance`},{slug:`pets`},{slug:`appshots`},{slug:`git-settings`},{slug:`connections`},{slug:`cloud-settings`},{slug:`cloud-environments`},{slug:`code-review`},{slug:`local-environments`},{slug:`worktrees`},{slug:`agent`},{slug:`personalization`},{slug:`keyboard-shortcuts`},{slug:`usage`},{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`},{slug:`hooks-settings`},{slug:`plugins-settings`},{slug:`skills-settings`},{slug:`data-controls`}]",
      "}));",
    ].join(""),
  );

  return { extractedDir, assetsDir };
}

function evaluateGeneratedSettingsModule(source, bindings, exportExpression) {
  const executable = source
    .replace(/import\{[^}]*\}from"[^"]+";/g, "")
    .replace(/export\{[^}]*\};?/g, "")
    .replace(/\/\/# sourceMappingURL=.*$/gm, "");
  const context = vm.createContext({ ...bindings });
  vm.runInContext(`${executable}\nglobalThis.__generatedExport=${exportExpression};`, context);
  return context.__generatedExport;
}

function renderGeneratedSettingsTree(element, Component) {
  if (element == null || typeof element === "boolean") {
    return [];
  }
  if (Array.isArray(element)) {
    return element.flatMap((child) => renderGeneratedSettingsTree(child, Component));
  }
  if (typeof element !== "object") {
    return [element];
  }
  if (typeof element.type === "function") {
    const rendered = element.type.prototype instanceof Component
      ? new element.type(element.props).render()
      : element.type(element.props);
    return renderGeneratedSettingsTree(rendered, Component);
  }
  return [
    element,
    ...renderGeneratedSettingsTree(element.props?.children, Component),
  ];
}

// The current route map can be hoisted into a hashed app chunk while the
// settings-page bundle carries only navigation metadata.
function createSplitRouteNativeKeyboardShortcutsSettingsFixture({
  routeChunkName = "app-initial~app-main~automations-page-A.js",
} = {}) {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-split-route-shortcuts-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const writeAsset = (name, source = "") => {
    fs.writeFileSync(path.join(assetsDir, name), source, "utf8");
  };

  writeAsset("rolldown-runtime-A.js", "function n(e){return e}function s(e){return e}export{n,s};");
  writeAsset(
    "shared-runtime-A.js",
    'import{s as s}from"./rolldown-runtime-A.js";function jsxFactory(){return{jsx(){},jsxs(){},Fragment:"Fragment"}}function reactFactory(){return{useState(){},useCallback(){},useEffect(){}}}function memoCache(){}export{jsxFactory as I,memoCache as L,reactFactory as R};',
  );
  writeAsset(
    "setting-storage-A.js",
    'async function requestCodex(...args){let[request]=args,{params:params,source:source}=request;return send("vscode://codex/",params)}export{requestCodex as z};',
  );
  writeAsset(
    "toggle-A.js",
    'function t({checked,disabled,onChange,ariaLabel}){return {role:"switch","aria-checked":checked,"aria-label":ariaLabel,disabled,onClick:()=>onChange(!checked)}}export{t};',
  );
  writeAsset(
    "settings-row-A.js",
    "function a(e){let{label:t,description:n,control:r}=e;return null}export{a as r};",
  );
  writeAsset("settings-content-layout-A.js", "export{n,r,t};");
  writeAsset("settings-group-A.js", "export{n,t};");
  writeAsset("settings-surface-A.js", "export{t};");
  writeAsset(
    "keyboard-shortcuts-settings-A.js",
    [
      'import{n as __module,s as __toESM}from"./rolldown-runtime-A.js";',
      'import{I as __jsxFactory,L as __memoCache,R as __reactFactory}from"./shared-runtime-A.js";',
      "function KeyboardShortcutsSettings(){let t=(0,React.useState)(null);return (0,$.jsx)(`div`,{children:t})}",
      "var React,$;__module(()=>{React=__toESM(__reactFactory(),1),$=__jsxFactory()})();",
      "slug:`keyboard-shortcuts`;export{KeyboardShortcutsSettings};",
    ].join(""),
  );
  // The icon/navigation bundle: no lazy route map lives here, only the slug -> icon
  // component map plus the order, group, visibility, and loading metadata.
  writeAsset(
    "settings-page-A.js",
    [
      'var Hn={"general-settings":wt,"keyboard-shortcuts":xn};',
      "var Wn=[`general-settings`,`profile`,`keyboard-shortcuts`];",
      "var Qn=[{key:`app`,slugs:[`general-settings`,`profile`,`keyboard-shortcuts`]}];",
      "function visible(e){switch(e.slug){case`general-settings`:case`agent`:case`personalization`:return!0;case`keyboard-shortcuts`:return!0}}",
      "function loading(H){let W=!1;if(H)bb0:switch(H.slug){case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`personalization`:W=!1;break bb0;case`keyboard-shortcuts`:W=!1;break bb0}return W}",
    ].join(""),
  );
  // The hoisted async route map is assigned inside an IIFE body.
  writeAsset(
    routeChunkName,
    [
      'import{n as routeModule,s as routeToESM}from"./rolldown-runtime-A.js";',
      'import{I as routeJsxFactory,R as routeReactFactory}from"./shared-runtime-A.js";',
      "function Ya(e){let r=(0,RouteReact.lazy)(e);function SettingsRouteWrapper(){let t=(0,RouteReact.useState)(null);return (0,RouteJsx.jsx)(r,{children:t})}return SettingsRouteWrapper}",
      "var RouteReact,RouteJsx;routeModule(()=>{RouteReact=routeToESM(routeReactFactory(),1),RouteJsx=routeJsxFactory()})();",
      "var Bn,Ya,Pr,FW,Xn=e((()=>{Bn=s(),Ya=t(f(),1),Pr=o(),",
      'FW={"general-settings":Ya(async()=>(await Pr(async()=>{let{GeneralSettings:e}=await import(`./general-settings-A.js`);return{GeneralSettings:e}},[],import.meta.url)).GeneralSettings),',
      '"keyboard-shortcuts":Ya(async()=>(await Pr(async()=>{let{KeyboardShortcutsSettings:e}=await import(`./keyboard-shortcuts-settings-A.js`);return{KeyboardShortcutsSettings:e}},[],import.meta.url)).KeyboardShortcutsSettings)}',
      "}));",
      "export{SettingsRouteWrapper};",
    ].join(""),
  );
  writeAsset(
    "app-initial~app-main~page~remote-conversation-page~new-thread-panel-page~settings-page~shared-A.js",
    settingsSharedBundleFixture(),
  );
  writeAsset(
    "app-initial~app-main~remote-conversation-page~settings-page~hotkey-window-thread-page~mcp-s-A.js",
    [
      "var c,l=e((()=>{c=`general-settings.import.profile.keyboard-shortcuts.codex-micro.appshots.appearance.pets.agent.git-settings.data-controls.cloud-settings.cloud-environments.code-review.personalization.usage.browser-use.computer-use.local-environments.worktrees.environments.mcp-settings.hooks-settings.connections.plugins-settings.skills-settings`.split(`.`)})),u,d,f,p=e((()=>{",
      "l(),u=`general-settings`,d=function(e){return e.String=`string`,e.Array=`array`,e.Record=`record`,e}({}),",
      "f=[{slug:`general-settings`},{slug:`import`},{slug:`profile`},{slug:`appearance`},{slug:`pets`},{slug:`appshots`},{slug:`git-settings`},{slug:`connections`},{slug:`cloud-settings`},{slug:`cloud-environments`},{slug:`code-review`},{slug:`local-environments`},{slug:`worktrees`},{slug:`agent`},{slug:`personalization`},{slug:`keyboard-shortcuts`},{slug:`usage`},{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`},{slug:`hooks-settings`},{slug:`plugins-settings`},{slug:`skills-settings`},{slug:`data-controls`}]",
      "}));",
    ].join(""),
  );

  return { extractedDir, assetsDir };
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

function currentBootstrapUpdaterBundleWithParametrizedQuitFixture() {
  return [
    "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`),u=require(`node:child_process`);",
    "c({onUpdateReadyChanged:e=>{a.sendMessageToAllRegisteredWindows({type:`app-update-ready-changed`,isUpdateReady:e})}});",
    "var rK={enabled:!1,running:!1,state:`disabled`};",
    "async function iK(){",
    "let{startedAtMs:r,buildFlavor:a,desktopSentry:o,sparkleManager:s,setSparkleBridgeHandlers:c,setSecondInstanceArgsHandler:l}=t.x(),d=t.T.shouldIncludeSparkle(a,process.platform,process.env);",
    "let M=oG({});let ee=pB(),te=null,ne=e=>{if(e?.quitImmediately===!1){ee.allowQuitTemporarilyForUpdateInstall();return}ee.allowQuitTemporarilyForUpdateInstall(),n.app.quit()};",
    "c({onInstallProgressChanged:e=>{E&&M.sendMessageToAllRegisteredWindows({type:`app-update-install-progress-changed`,installProgressPercent:e})},onUpdateReadyChanged:e=>{M.sendMessageToAllRegisteredWindows({type:`app-update-ready-changed`,isUpdateReady:e})},onUpdateLifecycleStateChanged:e=>{M.sendMessageToAllRegisteredWindows({type:`app-update-lifecycle-state-changed`,lifecycleState:e})},onInstallUpdatesRequested:e=>{ne(e)},isTrustedIpcEvent:N});",
    "}",
  ].join("");
}

function currentBootstrapUpdaterBundleWithAppUpdateStateBroadcastFixture() {
  return [
    "let r=require(`electron`),i=require(`node:path`),o=require(`node:fs`),u=require(`node:child_process`);",
    "var g6={enabled:!1,running:!1,state:`disabled`};",
    "async function v6(){",
    "let{startedAtMs:e,buildFlavor:i,desktopSentry:o,sparkleManager:s,setSparkleBridgeHandlers:c,setSecondInstanceArgsHandler:l}=n.k(),d=n.P.shouldIncludeSparkle(i,process.platform,process.env)||process.platform===`linux`;",
    "let ee=FZ(),P=null,te=e=>{if(e?.quitImmediately===!1){ee.allowQuitTemporarilyForUpdateInstall();return}ee.allowQuitTemporarilyForUpdateInstall(),r.app.quit()};let F=F3({}),oe=iZ({}),se=oe.getWindowContext();",
    "c({onDownloadProgressChanged:()=>{se.broadcastAppUpdateState()},onInstallProgressChanged:()=>{T&&se.broadcastAppUpdateState()},onUpdateReadyChanged:()=>{se.broadcastAppUpdateState()},onUpdateLifecycleStateChanged:()=>{se.broadcastAppUpdateState()},onRelaunchNoticeChanged:()=>{se.broadcastAppUpdateState()},onInstallUpdatesRequested:e=>{te(e)},isTrustedIpcEvent:M});",
    "}",
  ].join("");
}

function latestAvatarOverlayBundleFixture() {
  return [
    "let c=require(`electron`),h=require(`node:child_process`);",
    "var d5=`/avatar-overlay`,of={width:356,height:320},m5={width:112,height:121},y5={width:0,height:0},v5={width:276,height:131};",
    "var fV=class{window=null;layout=null;mascotSize=m5;traySize=null;pointerInteractive=!1;mousePassthroughEnabled=!1;layoutMode=`native`;compositionHost={setOverlayWindow(){},isNativeMaterialAttached(){return!1},getCursorPosition(){return null},performWindowDrag(){return!1},updateMascotRect(){},publishRemoteHostedPIPContentHost(){}};nativePositionController={clear(){}};",
    "startDrag(e,t,n=!1){let r=this.window;if(r==null||r.isDestroyed()||r.webContents.id!==e)return;this.cancelMomentum();let i=this.getLayout(r),a=this.compositionHost.getCursorPosition(),o=t.pointerScreenX!=null?{x:t.pointerScreenX,y:t.pointerScreenY}:c.screen.getCursorScreenPoint();this.dragState=new a5(a==null?`renderer`:`native`,t.pointerWindowX-i.mascot.left,t.pointerWindowY-i.mascot.top,c.screen.getDisplayNearestPoint(o).bounds,n),this.windowServerDragActive=this.layoutMode===`native`&&!n&&this.compositionHost.performWindowDrag(),this.windowServerDragActive||(this.windowServerDragWindowX=null)}",
    "endDrag(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;let r=this.dragState,i=this.windowServerDragActive,a=null;this.dragState=null,this.windowServerDragActive=!1,this.windowServerDragWindowX=null,i?this.persistWindowBounds(n,a??this.getCurrentDisplay()):this.reclampWindowToVisibleDisplay({shouldPersist:!0});let o=this.dockTarget;o!=null&&this.dockPresentation(o.anchor,o.onDock)}",
    "setElementSize(e,{elementSizeRevision:t,isTrayVisible:n,mascot:r,nativeCompositionEnabled:i,tray:a}){let o=this.window;if(o==null||o.isDestroyed()||o.webContents.id!==e)return;this.mascotSize=r,this.traySize=a,this.applyLatestElementSizes(o),this.stageWindowForNativePresentation(o),this.showWindowIfReady(o)}",
    "async createWindow(){let e=await this.windowManager.createWindow({title:c.app.getName(),width:of.width,height:of.height,appearance:`avatarOverlay`,focusable:!1,show:!1,initialRoute:d5});return this.window=e,this.compositionHost.setOverlayWindow(e),this.dragState=null,this.layout=null,this.mousePassthroughEnabled=!1,this.traySize=null,e.on(`closed`,()=>{if(this.window!==e)return;let t=this.presentationVisibility!=null;this.cancelMomentum(),this.clearMovedWindowPersist(),this.window=null,this.dragState=null,this.pointerInteractive=!1,this.mousePassthroughEnabled=!1,this.compositionHost.setOverlayWindow(null),this.broadcastOpenState()}),e}",
    "getLayoutForDisplay(e){return pf({anchor:this.anchor,displayBounds:this.layoutMode===`native`?e.workArea:e.bounds,mode:this.layoutMode,mascotSize:this.mascotSize,nativeMaterialAttached:this.compositionHost.isNativeMaterialAttached(),previousPlacement:this.placement,traySize:this.traySize??(this.layoutMode===`native`?y5:v5)})}",
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1,r=!0,i=null){if(e.isDestroyed())return;let a=this.getLayoutForDisplay(t);this.layout=a,this.setWindowBounds(e,a.windowBounds,n,r),this.compositionHost.updateMascotRect(a.mascot),this.sendLayoutToRenderer(e,i),this.computerUseCursorLocation!=null&&this.dragState==null&&this.sendComputerUseCursorLocationToRenderer(e)}",
    "showWindow(e){if(e.isDestroyed())return;let t=this.isOpen();e.moveTop(),e.showInactive(),this.compositionHost.publishRemoteHostedPIPContentHost(),!t&&this.isOpen()&&this.broadcastOpenState()}",
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}",
    "setComputerUseCursorLocation(e){this.computerUseCursorLocation=e,this.computerUseCursorPoint=e.isActive?{x:e.x,y:e.y}:null}",
    "sendComputerUseCursorLocationToRenderer(e){this.windowManager.sendMessageToWebContents(e.webContents,{type:`avatar-overlay-computer-use-cursor-changed`})}",
    "refreshCursorAtCurrentMousePosition(e){let t=c.screen.getCursorScreenPoint();return this.sendCursorPointToAvatarOverlay(e,t,!1)}",
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

test("opens the project picker without a parent window on Linux X11", async () => {
  const source =
    "class T{async pickLocalWorkspaceRoots(e,t=!1){if(this.host.id!==`local`)throw Error(`local only`);let n=[`openDirectory`,`createDirectory`];t&&n.push(`multiSelections`),await this.shouldShowHiddenFilesInPicker()&&n.push(`showHiddenFiles`);let r={properties:n,title:`Select Project Root`},i=c.BrowserWindow.fromWebContents(e),a=i==null?await c.dialog.showOpenDialog(r):await c.dialog.showOpenDialog(i,r);return a.canceled?[]:(await Promise.all(a.filePaths.map(e=>this.resolveWorkspaceRoot(e)))).filter(e=>e!=null)}}";
  const patched = applyPatchTwice(applyLinuxX11ProjectPickerPatch, source);

  assert.match(patched, /codexLinuxUseUnparentedX11ProjectPicker/);

  async function run(platform, env) {
    const calls = [];
    const context = {
      process: { platform, env },
      calls,
      c: {
        BrowserWindow: { fromWebContents: () => ({ id: "parent" }) },
        dialog: {
          showOpenDialog: async (...args) => {
            calls.push(args);
            return { canceled: false, filePaths: ["/tmp/project"] };
          },
        },
      },
    };
    vm.runInNewContext(
      `${patched};manager=new T;manager.host={id:\`local\`};manager.shouldShowHiddenFilesInPicker=async()=>false;manager.resolveWorkspaceRoot=async e=>e`,
      context,
    );
    const roots = await context.manager.pickLocalWorkspaceRoots({});
    return { argumentCount: calls[0].length, roots: Array.from(roots) };
  }

  assert.deepEqual(await run("linux", { XDG_SESSION_TYPE: " X11 ", DISPLAY: ":0" }), {
    argumentCount: 1,
    roots: ["/tmp/project"],
  });
  assert.deepEqual(await run("linux", { DISPLAY: ":0" }), {
    argumentCount: 1,
    roots: ["/tmp/project"],
  });
  assert.deepEqual(await run("linux", { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }), {
    argumentCount: 2,
    roots: ["/tmp/project"],
  });
  assert.deepEqual(await run("linux", { XDG_SESSION_TYPE: "unknown", DISPLAY: ":0" }), {
    argumentCount: 1,
    roots: ["/tmp/project"],
  });
  assert.deepEqual(
    await run("linux", { XDG_SESSION_TYPE: "unknown", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }),
    { argumentCount: 2, roots: ["/tmp/project"] },
  );
  assert.deepEqual(await run("linux", { XDG_SESSION_TYPE: " Wayland ", DISPLAY: ":0" }), {
    argumentCount: 2,
    roots: ["/tmp/project"],
  });
  assert.deepEqual(
    await run("linux", { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }),
    { argumentCount: 2, roots: ["/tmp/project"] },
  );
  assert.deepEqual(await run("darwin", {}), {
    argumentCount: 2,
    roots: ["/tmp/project"],
  });
});

test("adds Linux file manager support to the worker open target registry", () => {
  const source = `${workerBundlePrefix}${fileManagerBundle}`;

  const patched = applyPatchTwice(applyLinuxWorkerFileManagerPatch, source);

  assert.match(patched, /linux:\{label:`File Manager`/);
  assert.match(patched, /detect:\(\)=>`linux-file-manager`/);
  assert.match(patched, /o\.existsSync\(t\)/);
  assert.match(patched, /i\.dirname\(t\)/);
  assert.doesNotMatch(patched, /open:async\(\{path:e\}\)=>\{let [^}]*require\(`node:fs`\)/);
  assert.match(patched, /import\(`electron`\)\)\.shell\.openPath\(t\)/);
});

function evaluatePatchedHostProcessEnvironment(env) {
  const source =
    '"use strict";const shellError=`Failed to load shell env`,cliError=`Unable to locate the Codex CLI binary`;async function ky(){let a=new AbortController,s=await n.rr({interactive:!0,extraEnv:{[n.ir]:`1`},signal:a.signal}).then(e=>({status:`loaded`,userEnv:e}));if(s.status===`loaded`)return Object.assign(process.env,s.userEnv),s}function cB(e){let r={...process.env,LOG_FORMAT:`json`,RUST_LOG:process.env.RUST_LOG??`warn`,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:e.defaultOriginator??`Codex Desktop`},a=`next`;return{executablePath:`codex`,args:[`app-server`],env:t.t(r),a}}';
  const patched = applyPatchTwice(applyLinuxHostProcessEnvironmentPatch, source);
  const context = {
    AbortController: class {
      signal = {};
    },
    process: { platform: "linux", env: { ...env } },
    n: {
      ir: "CODEX_SHELL",
      rr: async ({ extraEnv }) =>
        context.shellUserEnv ??
        Object.fromEntries(
          Object.entries({ ...context.process.env, ...extraEnv }).filter(([, value]) => value !== undefined),
        ),
    },
    t: { t: (value) => value },
  };
  vm.runInNewContext(
    `${patched};globalThis.hostConfig=cB({});globalThis.createHostConfig=cB;globalThis.loadShell=ky`,
    context,
  );
  return { context, patched };
}

test("restores inherited library paths only at known Linux host-process boundaries", async () => {
  const { context, patched } = evaluatePatchedHostProcessEnvironment({
    PATH: "/usr/bin",
    LD_LIBRARY_PATH: "/nix/app:/nix/runtime",
    CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE: "unset",
    CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE: "",
  });

  assert.match(patched, /codexLinuxHostProcessEnv/);
  assert.doesNotMatch(patched, /PatchChildProcessEnvironment/);
  assert.doesNotMatch(patched, /require\(`node:child_process`\)/);
  assert.equal(Object.hasOwn(context.hostConfig.env, "LD_LIBRARY_PATH"), false);

  const shellResult = await context.loadShell();
  assert.equal(Object.hasOwn(shellResult.userEnv, "LD_LIBRARY_PATH"), false);
  assert.equal(context.process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE, "unset");
  assert.equal(
    context.process.env.LD_LIBRARY_PATH,
    "/nix/app:/nix/runtime",
    "loading the user shell must not discard Electron's packaged runtime path",
  );
});

test("preserves empty and non-empty user LD_LIBRARY_PATH values for inherited host environments", () => {
  for (const [state, value] of [
    ["empty", ""],
    ["value", "/home/user/lib:/opt/vendor/lib"],
  ]) {
    const { context } = evaluatePatchedHostProcessEnvironment({
      LD_LIBRARY_PATH: `/nix/app:${value}`,
      CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE: state,
      CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE: value,
    });
    assert.equal(context.hostConfig.env.LD_LIBRARY_PATH, value);
  }
});

test("preserves a user LD_LIBRARY_PATH discovered by the login shell", async () => {
  const { context } = evaluatePatchedHostProcessEnvironment({
    LD_LIBRARY_PATH: "/nix/app:/nix/runtime",
    CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE: "unset",
    CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE: "",
  });
  context.shellUserEnv = {
    PATH: "/home/user/bin:/usr/bin",
    LD_LIBRARY_PATH: "/home/user/profile-lib",
  };

  await context.loadShell();

  assert.equal(
    context.process.env.LD_LIBRARY_PATH,
    "/nix/app:/nix/runtime",
    "shell discovery must leave the packaged Electron runtime intact",
  );
  assert.equal(context.process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE, "value");
  assert.equal(
    context.process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE,
    "/home/user/profile-lib",
  );
  assert.equal(context.createHostConfig({}).env.LD_LIBRARY_PATH, "/home/user/profile-lib");
});

test("preserves development shell and CLI environments without launcher snapshot markers", async () => {
  const { context } = evaluatePatchedHostProcessEnvironment({
    LD_LIBRARY_PATH: "/developer/lib",
    CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE: "unset",
    CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE: "/stale/host/lib",
  });
  assert.equal(context.hostConfig.env.LD_LIBRARY_PATH, "/developer/lib");
  assert.equal(
    Object.hasOwn(context.hostConfig.env, "CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE"),
    false,
  );
  const shellResult = await context.loadShell();
  assert.equal(shellResult.userEnv.LD_LIBRARY_PATH, "/developer/lib");
  assert.equal(
    Object.hasOwn(shellResult.userEnv, "CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE"),
    false,
  );
  assert.equal(context.process.env.LD_LIBRARY_PATH, "/developer/lib");
});

test("patches startup shell and Codex CLI environments in separate Vite bundles", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-host-env-bundles-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main-current.js"),
      '"use strict";const shellError=`Failed to load shell env`;async function ky(){let a=new AbortController,s=await n.rr({interactive:!0,extraEnv:{[n.ir]:`1`},signal:a.signal}).then(e=>({status:`loaded`,userEnv:e}));if(s.status===`loaded`)return Object.assign(process.env,s.userEnv),s}',
    );
    fs.writeFileSync(
      path.join(buildDir, "src-current.js"),
      '"use strict";const cliError=`Unable to locate the Codex CLI binary`;function cB(e){let r={...process.env,LOG_FORMAT:`json`,RUST_LOG:process.env.RUST_LOG??`warn`,CODEX_INTERNAL_ORIGINATOR_OVERRIDE:e.defaultOriginator??`Codex Desktop`},a=`next`;return{env:t.t(r),a}}',
    );

    const result = patchLinuxHostProcessEnvironmentTargets(tempRoot);
    const mainSource = fs.readFileSync(path.join(buildDir, "main-current.js"), "utf8");
    const sharedSource = fs.readFileSync(path.join(buildDir, "src-current.js"), "utf8");
    assert.deepEqual(result, { matched: 2, changed: 2 });
    assert.match(mainSource, /extraEnv:codexLinuxLoginShellExtraEnv/);
    assert.match(mainSource, /codexLinuxShellEnvResult/);
    assert.match(sharedSource, /let r=codexLinuxHostProcessEnv\(\{\.\.\.process\.env/);
    assert.deepEqual(patchLinuxHostProcessEnvironmentTargets(tempRoot), {
      matched: 2,
      changed: 0,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("restores the user PATH for Linux local terminal sessions", () => {
  const source = `${mainBundlePrefix}${terminalEnvBundle}`;

  const patched = applyPatchTwice(applyLinuxTerminalUserPathPatch, source);

  assert.match(patched, /function codexLinuxRestoreUserTerminalPath/);
  assert.match(patched, /CODEX_LINUX_USER_PATH/);
  assert.match(
    patched,
    /process\.platform===`linux`&&this\.isLocalTerminalSession\(r\)&&codexLinuxRestoreUserTerminalPath\(i\)/,
  );
  assert.doesNotMatch(patched, /CODEX_LINUX_USER_PATH;n\(i\)/);

  const helperSource = patched.match(
    /function codexLinuxRestoreUserTerminalPath\(e\)\{[\s\S]*?return e\}/,
  )?.[0];
  assert.ok(helperSource);

  const managedRuntime = "/opt/codex-desktop/resources/node-runtime";
  const managedBin = `${managedRuntime}/bin`;
  const runHelper = (terminalPath, processPath = `${managedBin}:/usr/bin:/bin`) => {
    const terminalEnv = {
      PATH: terminalPath,
      CODEX_LINUX_USER_PATH: "/usr/bin:/bin",
    };
    vm.runInNewContext(`${helperSource};codexLinuxRestoreUserTerminalPath(terminalEnv);`, {
      process: {
        env: {
          CODEX_LINUX_USER_PATH: "/usr/bin:/bin",
          CODEX_MANAGED_NODE_RUNTIME_DIR: managedRuntime,
          PATH: processPath,
        },
      },
      terminalEnv,
    });
    return terminalEnv;
  };

  assert.deepEqual(runHelper(`${managedBin}:/usr/bin:/bin`), { PATH: "/usr/bin:/bin" });
  assert.deepEqual(
    runHelper(`/worktree/bin:${managedBin}:/custom/bin`, `${managedBin}:/usr/bin:/bin`),
    { PATH: "/worktree/bin:/usr/bin:/bin:/custom/bin" },
  );
  assert.deepEqual(runHelper("/worktree/bin:/custom/bin"), {
    PATH: "/worktree/bin:/custom/bin",
  });
});

test("rejects the obsolete 26.623 terminal sanitizer shape", () => {
  const source = `${mainBundlePrefix}${obsoleteTerminalEnvBundle}`;

  const patched = applyPatchTwice(applyLinuxTerminalUserPathPatch, source);

  assert.equal(patched, source);
  assert.doesNotMatch(patched, /function codexLinuxRestoreUserTerminalPath/);
});

test("sanitizes the terminal base before applying worktree environment overrides", async () => {
  const patched = applyPatchTwice(
    applyLinuxTerminalHostEnvironmentPatch,
    terminalEnvBundle,
  );
  const context = {
    process: {
      platform: "linux",
      env: {
        PATH: "/usr/bin",
        LD_LIBRARY_PATH: "/nix/app:/nix/runtime",
        CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE: "unset",
        CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE: "",
      },
    },
  };
  vm.runInNewContext(`${patched};globalThis.Backend=Backend`, context);
  const backend = new context.Backend();
  backend.getWorktreeShellEnvironmentForCwd = async () => ({
    exclude: [],
    set: { LD_LIBRARY_PATH: "/project/lib", PROJECT_ONLY: "1" },
  });

  const terminalEnv = await backend.buildTerminalEnv("/worktree", null, { type: "local" });

  assert.equal(terminalEnv.LD_LIBRARY_PATH, "/project/lib");
  assert.equal(terminalEnv.PROJECT_ONLY, "1");
  assert.equal(Object.hasOwn(terminalEnv, "CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE"), false);

  backend.getWorktreeShellEnvironmentForCwd = async () => ({ exclude: [], set: {} });
  for (const [state, value] of [
    ["empty", ""],
    ["value", "/home/user/lib"],
  ]) {
    context.process.env.CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE = state;
    context.process.env.CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE = value;
    const inheritedEnv = await backend.buildTerminalEnv("/worktree", null, { type: "local" });
    assert.equal(inheritedEnv.LD_LIBRARY_PATH, value);
  }

  delete context.process.env.CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE;
  delete context.process.env.CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE;
  context.process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE = "unset";
  context.process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE = "/stale/host/lib";
  context.process.env.LD_LIBRARY_PATH = "/developer/lib";
  const developmentEnv = await backend.buildTerminalEnv("/worktree", null, { type: "local" });
  assert.equal(developmentEnv.LD_LIBRARY_PATH, "/developer/lib");
  assert.equal(Object.hasOwn(developmentEnv, "CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE"), false);
});

test("patchExtractedApp patches worker file manager support", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-file-manager-"));
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
        currentOpaqueWindowSurfaceBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(path.join(buildDir, "worker.js"), `${workerBundlePrefix}${fileManagerBundle}`);
    fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const worker = fs.readFileSync(path.join(buildDir, "worker.js"), "utf8");
    assert.match(worker, /linux:\{label:`File Manager`/);
    assert.match(worker, /o\.existsSync\(t\)/);
    assert.match(worker, /i\.dirname\(t\)/);
    assert.doesNotMatch(worker, /open:async\(\{path:e\}\)=>\{let [^}]*require\(`node:fs`\)/);
    assert.match(worker, /import\(`electron`\)\)\.shell\.openPath\(t\)/);
    assert.equal(
      report.patches.find((patch) => patch.name === "linux-worker-file-manager")?.status,
      "applied",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patchExtractedApp reports worker file manager patch drift", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-file-manager-drift-"));
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
        currentOpaqueWindowSurfaceBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(
      path.join(buildDir, "worker.js"),
      "const workerRegistry={target:`other`,note:`id:`fileManager``};",
    );
    fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const workerPatch = report.patches.find((patch) => patch.name === "linux-worker-file-manager");
    assert.equal(workerPatch?.status, "skipped-optional");
    assert.equal(workerPatch?.reason, "fileManager target found but patchable block not found");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("uses XDG user documents directory for projectless Codex folders on Linux", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-xdg-documents-"));
  try {
    const configDir = path.join(tempRoot, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "user-dirs.dirs"),
      'XDG_DOCUMENTS_DIR="$HOME/My\\ Documents"\n',
      "utf8",
    );

    const source = [
      "let i={default:require(`node:path`)},o=require(`node:fs`);",
      "function ST(e,t,n){let r=CT(n),i=r.resolve(e),a=r.resolve(t);return n===`win32`?i.toLowerCase()===a.toLowerCase():i===a}",
      "function CT(e){return e===`win32`?i.default.win32:i.default.posix}",
      "function vT({desktopPaths:e,homeDir:t,platform:n}){return ST(t,e.getPath(`home`),n)?e.getPath(`documents`):CT(n).join(t,`Documents`)}",
    ].join("");

    const patched = applyPatchTwice(applyLinuxXdgDocumentsDirPatch, source);
    const context = {
      home: "/home/example",
      process: { env: { XDG_CONFIG_HOME: configDir } },
      require,
      result: null,
    };

    vm.runInNewContext(
      `${patched};result=vT({desktopPaths:{getPath:e=>e===\`home\`?home:e===\`documents\`?home+\`/Documents\`:null},homeDir:home,platform:\`linux\`});`,
      context,
    );

    assert.match(patched, /codexLinuxXdgDocumentsDir/);
    assert.match(patched, /`\$1`/);
    assert.equal(context.result, "/home/example/My Documents");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("uses XDG user documents directory for generated projectless workspaces", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-projectless-xdg-documents-"));
  try {
    const configDir = path.join(tempRoot, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "user-dirs.dirs"),
      'XDG_DOCUMENTS_DIR="$HOME/My\\ Documents"\n',
      "utf8",
    );

    const source =
      "function Mb({homeDirectory:e,path:t}){return t.join(e,`Documents`,`Codex`)}function Lb({homeDirectory:e,path:t}){return Mb({homeDirectory:e,path:t})}function Rb(e){return e}";
    const patched = applyPatchTwice(applyLinuxProjectlessXdgDocumentsDirPatch, source);
    const context = {
      home: "/home/example",
      process: { platform: "linux", env: { XDG_CONFIG_HOME: configDir } },
      require,
      result: null,
    };

    vm.runInNewContext(
      `${patched};result=Mb({homeDirectory:home,path:require(\`node:path\`).posix});`,
      context,
    );

    assert.match(patched, /codexLinuxProjectlessDocumentsDir/);
    assert.match(patched, /`\$1`/);
    assert.equal(context.result, "/home/example/My Documents/Codex");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("projectless documents asset patch updates Vite build bundle", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-projectless-xdg-asset-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const bundlePath = path.join(buildDir, "src-test.js");
    fs.writeFileSync(
      bundlePath,
      "function Mb({homeDirectory:e,path:t}){return t.join(e,`Documents`,`Codex`)}async function Lb(){throw Error(`Projectless thread directory must be a real directory`)}",
      "utf8",
    );

    assert.deepEqual(patchProjectlessDocumentsAssets(tempRoot), { matched: 1, changed: 1 });
    const patched = fs.readFileSync(bundlePath, "utf8");
    assert.match(patched, /function codexLinuxProjectlessDocumentsDir/);
    assert.deepEqual(patchProjectlessDocumentsAssets(tempRoot), { matched: 1, changed: 0 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("projectless documents descriptor surfaces resolver drift as skipped optional", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-projectless-xdg-drift-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), mainBundlePrefix, "utf8");
    fs.writeFileSync(
      path.join(buildDir, "src-test.js"),
      "function Mb({homeDirectory:e,path:t}){return t.resolve(e,`Documents`,`Codex`)}async function Lb(){throw Error(`Projectless thread directory must be a real directory`)}",
      "utf8",
    );

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const patch = report.patches.find((patch) =>
      patch.name === "linux-projectless-xdg-documents-dir",
    );
    assert.equal(patch.status, "skipped-optional");
    assert.match(patch.reason, /projectless documents directory resolver/);
    assert.ok(
      patch.warnings.some((warning) =>
        warning.includes("projectless documents directory resolver"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("preserves user-enabled remote_control config on Linux", () => {
  const source = [
    "async function mV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await hV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),pV))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
    "async function vV({codexHome:e,hostConfig:n,logger:r=t.Jr()}){if(n.kind===`local`)try{await yV(i.default.join(e??t.Rr({hostConfig:n,preferWsl:t.Kr(n)}),_V))&&r.info(`Removed remote_control from config before app-server start`)}catch(e){r.warning(`Failed to remove remote_control before app-server start`,{safe:{},sensitive:{error:e}})}}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxRemoteControlConfigPreservationPatch, source);

  assert.match(patched, /mV\(\{codexHome:e,hostConfig:n,logger:r=t\.Jr\(\)\}\)\{if\(n\.kind===`local`&&process\.platform!==`linux`\)try\{/);
  assert.match(patched, /vV\(\{codexHome:e,hostConfig:n,logger:r=t\.Jr\(\)\}\)\{if\(n\.kind===`local`&&process\.platform!==`linux`\)try\{/);
  assert.equal((patched.match(/process\.platform!==`linux`/g) ?? []).length, 2);
});

test("warns when upstream still strips remote_control but the guard shape drifts", () => {
  const source =
    "async()=>{await yV(path)&&logger.info(`Removed remote_control from config before app-server start`)}";

  const { value, warnings } = captureWarns(() =>
    applyLinuxRemoteControlConfigPreservationPatch(source),
  );

  assert.equal(value, source);
  assert.match(warnings.join("\n"), /remote-control config stripper guard/);
});

test("registers local app-server feature enablement in internal and Electron handlers", () => {
  const source = [
    "function create(){let f=new t.wn(this.options.messageChannel,{sharedObjectRepository:this.sharedObjectRepository});",
    "return f.registerInternalServerRequestHandler({methods:[`item/commandExecution/requestApproval`,`mcpServer/elicitation/request`],handler:t=>(this.messageHandler.revealWindowsReviewRequest(e,t),null)}),",
    "f.registerInternalServerRequestHandler({methods:[`attestation/generate`],handler:be({bundleIdentifier:n.k(this.options.buildFlavor),resourcesPath:l})}),f}",
    "var oN=class{handlers={\"set-vs-context\":async()=>{throw new rN},\"linux-read-aloud\":async(e)=>codexLinuxReadAloudHandle(e)};",
    "handleVSCodeRequest(e,n,r,i,a){let o=n,s=this.handlers[o];if(typeof s!=`function`)throw Error(`${n} not implemented in the current Electron process. Restart Codex to load the latest Electron handlers.`);return s({...r,origin:e,signal:a})}}",
  ].join("");

  const patched = applyPatchTwice(
    applyLinuxLocalAppServerFeatureEnablementHandlerPatch,
    source,
  );

  assert.match(patched, /methods:\[`set-local-app-server-feature-enablement`\]/);
  assert.match(patched, /"set-local-app-server-feature-enablement":async/);
  assert.match(patched, /local_app_server_feature_enablement/);
  assert.match(patched, /local_remote_control_enabled/);
  assert.match(patched, /`mentions_v2`/);
  assert.match(patched, /`tool_search`/);
  assert.match(patched, /enablement/);
  assert.equal(
    (patched.match(/set-local-app-server-feature-enablement/g) ?? []).length,
    2,
  );
});

test("adds the Linux quit guard to the current comma-declared Electron prelude", () => {
  const source = currentMainBundlePrefix;

  const patched = applyPatchTwice(applyLinuxQuitGuardPatch, source);

  assert.match(patched, /codexLinuxQuitInProgress=!1/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxMarkQuitInProgress=\(\)=>\{codexLinuxQuitInProgress=!0,codexLinuxDestroyTray\(\)\}/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /codexLinuxShouldBypassQuitPrompt=\(\)=>codexLinuxExplicitQuitApproved===!0/);
  assert.match(patched, /codexLinuxIsQuitInProgress=\(\)=>codexLinuxQuitInProgress===!0/);
});

test("keeps the current Linux quit guard module-scoped after helper declarations", () => {
  const source = `function upstreamHelper(){return!0}${currentMainBundlePrefix}`;

  const patched = applyPatchTwice(applyLinuxQuitGuardPatch, source);

  assert.match(patched, /p=e\.o\(p\);let codexLinuxTray=null/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.equal((patched.match(/codexLinuxQuitInProgress=!1/g) ?? []).length, 1);
});

test("adds the Linux quit guard for the current interleaved bundler prelude", () => {
  const source = `${currentMainBundlePrefix}let m=require(\`node:fs/promises\`);`;

  const patched = applyPatchTwice(applyLinuxQuitGuardPatch, source);

  assert.match(patched, /let m=require\(`node:fs\/promises`\);/);
  assert.match(patched, /p=e\.o\(p\);let codexLinuxTray=null/);
  assert.match(patched, /codexLinuxExplicitQuitApproved=!1/);
  assert.match(patched, /codexLinuxPrepareForExplicitQuit=\(\)=>\{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress\(\)\}/);
  assert.equal((patched.match(/codexLinuxQuitInProgress=!1/g) ?? []).length, 1);
});

test("destroys the registered Linux tray before the app exits", () => {
  const source = `${currentMainBundlePrefix}${trayBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxTrayPatch,
    applyLinuxQuitGuardPatch(source),
    null,
  );

  assert.match(patched, /codexLinuxRegisterTray=e=>\(codexLinuxTray=e,e\)/);
  assert.match(patched, /codexLinuxDestroyTray=\(\)=>\{if\(process\.platform!==`linux`\)return;/);
  assert.match(patched, /codexLinuxTray=null;try\{e\?\.destroy\(\)\}catch\{\}/);
  assert.match(patched, /codexLinuxMarkQuitInProgress=\(\)=>\{codexLinuxQuitInProgress=!0,codexLinuxDestroyTray\(\)\}/);
  assert.match(patched, /c\.app\.on\(`before-quit`,\(\)=>codexLinuxDestroyTray\(\)\)/);
  assert.match(patched, /i=typeof codexLinuxRegisterTray===`function`\?codexLinuxRegisterTray\(new n\.Tray\(r\.defaultIcon\)\):new n\.Tray\(r\.defaultIcon\)/);
  assert.doesNotMatch(patched, /codexLinuxTrayQuitDelayMs/);

  const helperStart = patched.indexOf("let codexLinuxTray=null");
  const helperEnd = patched.indexOf(";c.app.on(`before-quit`", helperStart) + 1;
  const helperSource = patched.slice(helperStart, helperEnd);
  const runDestroy = new Function(
    "process",
    `${helperSource}let calls=0;codexLinuxRegisterTray({destroy(){calls+=1}});codexLinuxMarkQuitInProgress();codexLinuxMarkQuitInProgress();return calls;`,
  );
  assert.equal(runDestroy({ platform: "linux" }), 1);
});

test("bypasses the upstream before-quit confirmation after a Linux explicit quit", () => {
  const source = `${currentMainBundlePrefix}${beforeQuitConfirmationBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxExplicitQuitPromptBypassPatch,
    applyLinuxQuitGuardPatch(source),
  );

  assert.match(
    patched,
    /if\(\(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt\(\)\)\|\|e\|\|i\.canQuitWithoutPrompt\(\)\|\|r\|\|!s&&!c\)\{process\.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),g=!0,a\.markAppQuitting\(\);return\}/,
  );
  assert.match(
    patched,
    /process\.platform===`linux`&&typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),i\.markQuitApproved\(\),g=!0,a\.markAppQuitting\(\)/,
  );
});

test("adds a bounded will-quit drain fallback for Linux explicit quit", () => {
  const source = `${currentMainBundlePrefix}${willQuitDrainBundleFixture()}`;
  const patched = applyPatchTwice(
    applyLinuxWillQuitDrainTimeoutPatch,
    applyLinuxQuitGuardPatch(source),
  );

  assert.match(patched, /codexLinuxExplicitQuitDrainTimeoutMs=3e3/);
  assert.match(patched, /\(\(\)=>\{let codexLinuxFinalizeQuit=\(\)=>\{d\(\),f\.dispose\(\),n\.app\.quit\(\)\},codexLinuxDrainPromise=Promise\.all\(\[u\.flush\(\),p\.flush\(\)\]\);/);
  assert.match(patched, /if\(process\.platform===`linux`&&\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)\)\{Promise\.race\(\[codexLinuxDrainPromise,new Promise\(e=>setTimeout\(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===`number`\?codexLinuxExplicitQuitDrainTimeoutMs:3e3\)\)\]\)\.finally\(codexLinuxFinalizeQuit\);return\}/);
  assert.doesNotMatch(patched, /\\`number\\`/);
  assert.match(patched, /codexLinuxDrainPromise\.finally\(codexLinuxFinalizeQuit\)\}\)\(\)/);
  assert.doesNotThrow(() => new Function(patched));
});

test("marks Linux quit-in-progress for the tray quit path", () => {
  const source = `${currentMainBundlePrefix}${explicitQuitBundleFixture()}`;
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
  const source = `${currentMainBundlePrefix}${explicitQuitBundleFixture()}`;
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

test("patches remaining explicit quit handlers when another copy is already patched", () => {
  const quitMarkerExpression =
    "typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
  const patchedTrayQuit = `{label:rB(this.appName),click:()=>{${quitMarkerExpression}n.app.quit()}}`;
  const unpatchedTrayQuit = "{label:rB(this.appName),click:()=>{n.app.quit()}}";
  const patchedIpcQuit = `if(o.type===\`quit-app\`){${quitMarkerExpression}n.app.quit();return}`;
  const unpatchedIpcQuit = "if(o.type===`quit-app`){n.app.quit();return}";

  const patchedTray = applyPatchTwice(
    applyLinuxExplicitTrayQuitPatch,
    `${patchedTrayQuit}function createSecondTray(){return ${unpatchedTrayQuit}}`,
  );
  const patchedIpc = applyPatchTwice(
    applyLinuxExplicitIpcQuitPatch,
    `${patchedIpcQuit}function createSecondIpc(){${unpatchedIpcQuit}}`,
  );

  assert.equal((patchedTray.match(/codexLinuxPrepareForExplicitQuit\(\)/g) ?? []).length, 2);
  assert.match(
    patchedTray,
    /function createSecondTray\(\)\{return \{label:rB\(this\.appName\),click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\)\}\}\}/,
  );
  assert.equal((patchedIpc.match(/codexLinuxPrepareForExplicitQuit\(\)/g) ?? []).length, 2);
  assert.match(
    patchedIpc,
    /function createSecondIpc\(\)\{if\(o\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),n\.app\.quit\(\);return\}\}/,
  );
});

test("uses the frameless native Codex titlebar for primary Linux windows", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeTitlebarPatch, source);

  assert.match(
    patched,
    /function codexLinuxTitleBarOverlay\(e=1\)\{return\{color:a\.nativeTheme\.shouldUseDarkColors\?`#111111`:o2,symbolColor:a\.nativeTheme\.shouldUseDarkColors\?v2:_2,height:Math\.round\(30\*e\)\}\}/,
  );
  assert.match(
    patched,
    /titleBarOverlay:n===`linux`\?codexLinuxTitleBarOverlay\(r\):b2\(r\),\.\.\.e===`quickChat`/,
  );
  assert.match(patched, /\.\.\.t\?\{\}:\{vibrancy:`menu`\}/);
  assert.doesNotMatch(patched, /titleBarOverlay:b2\(r\),\.\.\.e===`quickChat`/);
});

test("uses a module-scoped Linux native titlebar helper when aliases shadow Electron", () => {
  const source = [
    "function A3(e){return e===`avatarOverlay`}",
    "function I3({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A3(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?L4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A3(t)?{backgroundColor:r?L4:K4,backgroundMaterial:null}:{backgroundColor:W4,backgroundMaterial:null}}",
    "function o3(e=1){return{color:W4,symbolColor:r.nativeTheme.shouldUseDarkColors?i3:r3,height:Math.round(g3*e)}}",
    "function T3({appearance:e,opaqueWindowSurfaceEnabled:t,platform:n,windowZoom:r=1}){switch(e){case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:a3(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:o3(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};}}",
  ].join("");
  const { value, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxNativeTitlebarPatch, source),
  );

  assert.match(
    value,
    /function codexLinuxTitleBarOverlay\(e=1\)\{return\{color:r\.nativeTheme\.shouldUseDarkColors\?`#111111`:K4,symbolColor:r\.nativeTheme\.shouldUseDarkColors\?i3:r3,height:Math\.round\(30\*e\)\}\}/,
  );
  assert.match(
    value,
    /titleBarOverlay:n===`linux`\?codexLinuxTitleBarOverlay\(r\):o3\(r\),\.\.\.e===`quickChat`/,
  );
  assert.doesNotMatch(value, /titleBarOverlay:\{color:r\.nativeTheme\.shouldUseDarkColors/);
  assert.deepEqual(warnings, []);
});

test("updates the Linux native titlebar overlay when nativeTheme changes", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeTitlebarPatch, source);

  assert.match(
    patched,
    /if\(process\.platform!==`win32`&&process\.platform!==`linux`\|\|t!==`primary`&&t!==`quickChat`\)return/,
  );
  assert.match(
    patched,
    /e\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(e\.id\)\):b2\(this\.windowZooms\.get\(e\.id\)\)\)/,
  );
  assert.doesNotMatch(patched, /webContents\.executeJavaScript\(/);
  assert.doesNotMatch(patched, /data-codex-window-type/);
});

test("redirects the renamed Linux-aware titlebar overlay sync away from the transparent win32 helper", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
    "process.platform===`darwin`?n.setWindowButtonPosition(y2(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(b2(t)))",
  ].join("");
  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxNativeTitlebarPatch, source),
  );

  assert.match(
    patched,
    /titleBarOverlay:n===`linux`\?codexLinuxTitleBarOverlay\(r\):b2\(r\),\.\.\.e===`quickChat`/,
  );
  assert.match(
    patched,
    /installApplicationMenuTitleBarOverlaySync\(e,t\)\{if\(process\.platform!==`win32`&&process\.platform!==`linux`\|\|t!==`primary`&&t!==`quickChat`\)return/,
  );
  assert.match(
    patched,
    /e\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(e\.id\)\):b2\(this\.windowZooms\.get\(e\.id\)\)\)/,
  );
  assert.match(
    patched,
    /n\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(t\):b2\(t\)\)/,
  );
  assert.doesNotMatch(patched, /setTitleBarOverlay\(b2\(/);
  assert.deepEqual(warnings, []);
});


test("updates every Linux zoom titlebar overlay refresh call site", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "case`quickChat`:case`primary`:return n===`darwin`?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r),...e===`quickChat`?{hasShadow:!0,resizable:!0,transparent:!0}:{},...t?{}:{vibrancy:`menu`}}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}};",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
    "process.platform===`darwin`?n.setWindowButtonPosition(y2(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(b2(t)))",
    "process.platform===`darwin`?o.setWindowButtonPosition(y2(i)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(o.id,i),o.setTitleBarOverlay(b2(i)))",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeTitlebarPatch, source);

  assert.equal(
    (patched.match(/setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay/g) ?? []).length,
    3,
  );
  assert.doesNotMatch(
    patched,
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\([^)]+\),[A-Za-z_$][\w$]*\.setTitleBarOverlay\(b2\([^)]+\)\)\)/,
  );
});

test("adds a right-side safe area for Linux window controls in application menu chrome", () => {
  const source = [
    "var l=Object.freeze({default:Object.freeze({left:0,right:0}),mac:Object.freeze({legacy:Object.freeze({left:66+c,right:0}),modern:Object.freeze({left:76+c,right:0})}),applicationMenu:Object.freeze({left:0,right:0})});",
    "var m=Object.freeze({applicationMenu:Object.freeze({left:0,right:0})});",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowControlsSafeAreaPatch, source);

  assert.equal(
    (patched.match(/applicationMenu:Object\.freeze\(\{left:0,right:138\}\)/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(
    patched,
    /applicationMenu:Object\.freeze\(\{left:0,right:0\}\)/,
  );
});

test("patches remaining Linux window controls safe areas when another copy is already patched", () => {
  const source = [
    "var l=Object.freeze({applicationMenu:Object.freeze({left:0,right:138})});",
    "var m=Object.freeze({applicationMenu:Object.freeze({left:0,right:0})});",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowControlsSafeAreaPatch, source);

  assert.equal(
    (patched.match(/applicationMenu:Object\.freeze\(\{left:0,right:138\}\)/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(
    patched,
    /applicationMenu:Object\.freeze\(\{left:0,right:0\}\)/,
  );
});

test("keeps tooltips out of the Linux window controls titlebar area", () => {
  const middleware =
    "middleware:[a({mainAxis:C,crossAxis:t}),c({padding:8}),l({padding:8}),u({padding:8,apply({availableWidth:e,availableHeight:t,elements:n,rects:r}){n.floating.style.setProperty(`--radix-tooltip-trigger-width`,`1px`)}})]";
  const source = `${middleware};${middleware}`;

  const patched = applyPatchTwice(applyLinuxTooltipWindowControlsCollisionPatch, source);

  assert.equal(
    (patched.match(/padding:\{top:44,right:8,bottom:8,left:8\}/g) ?? []).length,
    6,
  );
  assert.doesNotMatch(patched, /[,(]\{padding:8\}/);
});

test("patches remaining tooltip collision middleware when another copy is already patched", () => {
  const patchedMiddleware =
    "middleware:[a({mainAxis:C,crossAxis:t}),c({padding:{top:44,right:8,bottom:8,left:8}}),l({padding:{top:44,right:8,bottom:8,left:8}}),u({padding:{top:44,right:8,bottom:8,left:8},apply({availableWidth:e,availableHeight:t,elements:n,rects:r}){n.floating.style.setProperty(`--radix-tooltip-trigger-width`,`1px`)}})]";
  const defaultMiddleware =
    "middleware:[a({mainAxis:C,crossAxis:t}),c({padding:8}),l({padding:8}),u({padding:8,apply({availableWidth:e,availableHeight:t,elements:n,rects:r}){n.floating.style.setProperty(`--radix-tooltip-trigger-width`,`1px`)}})]";
  const source = `${patchedMiddleware};${defaultMiddleware}`;

  const patched = applyPatchTwice(applyLinuxTooltipWindowControlsCollisionPatch, source);

  assert.equal(
    (patched.match(/padding:\{top:44,right:8,bottom:8,left:8\}/g) ?? []).length,
    6,
  );
  assert.doesNotMatch(patched, /[,(]\{padding:8\}/);
});

test("keeps tooltip collision padding after middleware alias drift", () => {
  const source =
    "middleware:[o({mainAxis:ne,crossAxis:t}),l({padding:8}),u({padding:8}),d({padding:8,apply({availableWidth:e,availableHeight:t,elements:n,rects:r}){n.floating.style.setProperty(`--radix-tooltip-trigger-width`,`1px`)}})]";

  const patched = applyPatchTwice(applyLinuxTooltipWindowControlsCollisionPatch, source);

  assert.match(patched, /o\(\{mainAxis:ne,crossAxis:t\}\),l\(\{padding:\{top:44,right:8,bottom:8,left:8\}\}\),u\(\{padding:\{top:44,right:8,bottom:8,left:8\}\}\),d\(\{padding:\{top:44,right:8,bottom:8,left:8\},apply/);
  assert.doesNotMatch(patched, /[,(]\{padding:8\}/);
});

test("removes native title tooltip from the thread side panel toolbar action", () => {
  const toolbar =
    "function dt(e){let t=(0,X.c)(11),{children:n,disabled:r,label:i,onClick:a,color:o,pressed:s,shortcut:c}=e,l=r===void 0?!1:r,u=o===`outline`?s?`outlineActive`:`outline`:s?`secondary`:`ghost`,d;t[0]!==n||t[1]!==l||t[2]!==i||t[3]!==a||t[4]!==s||t[5]!==u?(d=(0,q.jsx)(R,{size:`toolbar`,color:u,\"aria-label\":i,\"aria-pressed\":s,disabled:l,title:i,onClick:a,uniform:!0,children:n}),t[0]=n,t[1]=l,t[2]=i,t[3]=a,t[4]=s,t[5]=u,t[6]=d):d=t[6];let f;return t[7]!==i||t[8]!==c||t[9]!==d?(f=(0,q.jsx)(L,{tooltipContent:i,shortcut:c,delayOpen:!0,children:d}),t[7]=i,t[8]=c,t[9]=d,t[10]=f):f=t[10],f}var Rt=j({toggleSidePanel:{id:`thread.sidePanel.toggle`,defaultMessage:`Toggle side panel`,description:`Toggles the thread side panel in a local or new thread`}});";
  const source = `${toolbar}${toolbar}`;

  const patched = applyPatchTwice(applyLinuxThreadSidePanelNativeTooltipPatch, source);

  assert.match(patched, /"aria-label":i/);
  assert.match(patched, /tooltipContent:i/);
  assert.doesNotMatch(patched, /title:i/);
});

test("removes the Linux menu next to Windows removeMenu calls", () => {
  const source = "process.platform===`win32`&&k.removeMenu(),";
  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal(
    patched,
    "process.platform===`linux`&&k.removeMenu(),process.platform===`win32`&&k.removeMenu(),",
  );
});

test("patches remaining Windows menu snippets when another copy is already Linux-patched", () => {
  const windowsMenuSnippet = "process.platform===`win32`&&k.removeMenu(),";
  const linuxMenuPatch = "process.platform===`linux`&&k.removeMenu(),";
  const source = `${linuxMenuPatch}${windowsMenuSnippet}function createSecondWindow(){${windowsMenuSnippet}}`;

  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal((patched.match(/removeMenu\(\)/g) ?? []).length, 4);
  assert.match(
    patched,
    /function createSecondWindow\(\)\{process\.platform===`linux`&&k\.removeMenu\(\),process\.platform===`win32`&&k\.removeMenu\(\),\}/,
  );
});

test("upgrades legacy Linux menu snippets to remove the menu", () => {
  const source =
    "process.platform===`linux`&&(k.setMenuBarVisibility(!1),k.removeMenu?.()),process.platform===`win32`&&k.removeMenu(),";

  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal(
    patched,
    "process.platform===`linux`&&k.removeMenu(),process.platform===`win32`&&k.removeMenu(),",
  );
  assert.doesNotMatch(patched, /setMenuBarVisibility/);
});

test("recognizes the Linux removeMenu snippet as already applied", () => {
  const source =
    "process.platform===`linux`&&k.removeMenu(),process.platform===`win32`&&k.removeMenu(),";

  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal(patched, source);
  assert.equal((patched.match(/process\.platform===`linux`&&k\.removeMenu\(\),/g) ?? []).length, 1);
});

test("preserves the global application menu on Linux for accelerators", () => {
  const source =
    "let $e=[{role:`help`,submenu:[]}],et=n.Menu.buildFromTemplate($e);n.Menu.setApplicationMenu(et);";
  const patched = applyPatchTwice(applyLinuxApplicationMenuPatch, source);

  assert.equal(patched, source);
});

test("migrates a Linux-suppressed application menu back to the real menu", () => {
  const source =
    "let et=n.Menu.buildFromTemplate($e);n.Menu.setApplicationMenu(process.platform===`linux`?null:et);";

  const patched = applyPatchTwice(applyLinuxApplicationMenuPatch, source);

  assert.equal(patched, "let et=n.Menu.buildFromTemplate($e);n.Menu.setApplicationMenu(et);");
});

test("patches current opaque window surface background helper shape for Linux", () => {
  const patched = applyPatchTwice(applyLinuxOpaqueBackgroundPatch, currentOpaqueWindowSurfaceBackgroundBundle);

  assert.match(
    patched,
    /:e===`linux`&&!g3\(t\)\?\{backgroundColor:r\?G4:K4,backgroundMaterial:null\}:e===`win32`&&!g3\(t\)\?/,
  );
  assert.match(
    patched,
    /shouldAlwaysUseOpaqueWindowSurface\(e\)\{return process\.platform===`linux`&&!g3\(e\)\|\|v3\(\{appearance:e,opaqueWindowsEnabled:this\.isOpaqueWindowsEnabled\(\),platform:process\.platform\}\)\|\|!BA\(\)&&!g3\(e\)\}/,
  );
  assert.match(patched, /opaqueWindowSurfaceEnabled:n/);
});

test("keeps the opaque background patch idempotent after pet overlay composition", () => {
  const source = `${latestAvatarOverlayBundleFixture()}${currentOpaqueWindowSurfaceBackgroundBundle}`;
  const corePatched = applyLinuxOpaqueBackgroundPatch(source);
  const petPatched = applyPetOverlayPatch(corePatched);
  const { value: rerun, warnings } = captureWarns(() =>
    applyLinuxOpaqueBackgroundPatch(petPatched),
  );

  assert.notEqual(petPatched, corePatched);
  assert.equal(rerun, petPatched);
  assert.deepEqual(warnings, []);
});

test("patches an opaque background helper composed by pet overlay first", () => {
  const source = `${latestAvatarOverlayBundleFixture()}${currentOpaqueWindowSurfaceBackgroundBundle}`;
  const petPatched = applyPetOverlayPatch(source);
  const { value: corePatched, warnings } = captureWarns(() =>
    applyLinuxOpaqueBackgroundPatch(petPatched),
  );

  assert.notEqual(corePatched, petPatched);
  assert.match(
    corePatched,
    /t===`avatarOverlay`\?\{backgroundColor:`#00000000`,backgroundMaterial:null\}:n\?[^;]+:e===`linux`&&!g3\(t\)\?\{backgroundColor:r\?G4:K4,backgroundMaterial:null\}:/,
  );
  assert.deepEqual(warnings, []);
});

test("reports drift in a malformed opaque background helper after pet overlay composition", () => {
  const source = `${latestAvatarOverlayBundleFixture()}${currentOpaqueWindowSurfaceBackgroundBundle}`;
  const composed = applyPetOverlayPatch(applyLinuxOpaqueBackgroundPatch(source));
  const drifted = composed.replace(
    ":e===`linux`&&!g3(t)?{backgroundColor:r?G4:K4,backgroundMaterial:null}:",
    ":e===`linux`?{backgroundColor:r?G4:K4,backgroundMaterial:null}:",
  );
  const { value: rerun, warnings } = captureWarns(() =>
    applyLinuxOpaqueBackgroundPatch(drifted),
  );

  assert.notEqual(drifted, composed);
  assert.equal(rerun, drifted);
  assert.deepEqual(warnings, [
    "WARN: Could not find BrowserWindow background function signature — skipping background patch",
  ]);
});

test("does not mistake an unrelated Linux background branch for the current patched helper", () => {
  const unrelatedLinuxBackground =
    "function legacy({platform:e,appearance:t,prefersDarkColors:r}){return e===`linux`&&!x(t)?{backgroundColor:r?D:L,backgroundMaterial:null}:null}";
  const patched = applyPatchTwice(
    applyLinuxOpaqueBackgroundPatch,
    `${unrelatedLinuxBackground}${currentOpaqueWindowSurfaceBackgroundBundle}`,
  );

  assert.match(
    patched,
    /function S3\([^}]+\}\)\{return n\?[^;]+:e===`linux`&&!g3\(t\)\?\{backgroundColor:r\?G4:K4,backgroundMaterial:null\}:e===`win32`&&!g3\(t\)\?/,
  );
  assert.match(patched, new RegExp(escapeRegExp(unrelatedLinuxBackground)));
});

test("reports drift when the current opaque background helper has no surface predicate", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxOpaqueBackgroundPatch(currentOpaqueWindowSurfaceBackgroundHelper),
  );

  assert.equal(patched, currentOpaqueWindowSurfaceBackgroundHelper);
  assert.deepEqual(warnings, [
    "WARN: Could not find opaque surface mode predicate — skipping Linux opaque surface patch",
  ]);
});

test("patches current webview opaque window default bundle shapes", () => {
  const settingsSource =
    "function sn(){let{canImportThemeString:u,setThemePatch:b,theme:x}=p(t),S=vn(r,t),k=[{label:i}],A=[];return x.opaqueWindows}";

  const patchedSettings = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, settingsSource);

  assert.match(
    patchedSettings,
    /navigator\.userAgent\.includes\(`Linux`\)&&x\?\.opaqueWindows==null&&\(x=\{\.\.\.x,opaqueWindows:!0\}\);let S=/,
  );
});

test("patches current comment preload screenshot anchor and marker shapes", () => {
  const source = [
    "let Xe=(M?j?.kind===`comment`?ge:[]:Ye==null?ge:ge.filter(e=>e.id!==Ye.id)).flatMap(e=>{let t=pe.get(e.id);if(t==null)return[];return[{comment:e,commentNumber:t}]}),",
    "let at=null,ot=`hover-box`,st;if(M&&j?.annotation.anchor.kind===`element`){let e=tt==null?null:ed(tt);at=e?.rect??Td(j.annotation.anchor),st=e?.borderRadius,ot=Wd(j.annotation.anchor,at,S.width,S.height)}else if(M&&j?.kind===`comment`&&j.annotation.anchor.kind===`region`)at=Td(j.annotation.anchor),ot=Hd(j.annotation.anchor,at,S.width,S.height);",
  ].join("");

  const patched = applyPatchTwice(applyBrowserAnnotationScreenshotPatch, source);

  assert.match(
    patched,
    /Xe=\(M\?j\?\.kind===`comment`\?ge\.filter\(e=>e\.id===j\.annotation\.id\):\[\]:Ye==null\?ge:ge\.filter\(e=>e\.id!==Ye\.id\)\)\.flatMap/,
  );
  assert.match(
    patched,
    /if\(M&&j\?\.annotation\.anchor\.kind===`element`\)\{at=Td\(j\.annotation\.anchor\),st=void 0,ot=Wd\(j\.annotation\.anchor,at,S\.width,S\.height\)\}/,
  );
});

test("patches drifted comment preload screenshot anchor helper names", () => {
  const source =
    "let rect=null,css=`hover-box`,radius;if(enabled&&selected?.annotation.anchor.kind===`element`){let e=node==null?null:measure(node);rect=e?.rect??anchorRect(selected.annotation.anchor),radius=e?.borderRadius,css=highlight(selected.annotation.anchor,rect,viewport.width,viewport.height)}";

  const patched = applyPatchTwice(applyBrowserAnnotationScreenshotPatch, source);

  assert.match(
    patched,
    /if\(enabled&&selected\?\.annotation\.anchor\.kind===`element`\)\{rect=anchorRect\(selected\.annotation\.anchor\),radius=void 0,css=highlight\(selected\.annotation\.anchor,rect,viewport\.width,viewport\.height\)\}/,
  );
  assert.doesNotMatch(patched, /\bWd\(/);
  assert.doesNotMatch(patched, /\bS\.width\b/);
});

test("patches current comment preload screenshot marker selection list", () => {
  const source =
    "let Ue=M?.annotation.id??null,We=M?.kind===`comment`?[M.annotation]:he,Ge=M!=null&&g!=null,Ke=m?.target.mode===`create`?oo(m.anchor):null,qe=m?.target.mode===`create`&&m.anchor.type===`element`?m.anchor.viewportSize:void 0,Je=Ke==null?null:he.find(e=>le(e.anchor,Ke))??null,Ye=(Ge?M?.kind===`comment`?he:[]:Je==null?he:he.filter(e=>e.id!==Je.id)).flatMap(e=>{let t=fe.get(e.id);if(t==null)return[];return[{comment:e,commentNumber:t}]})";

  const patched = applyPatchTwice(applyBrowserAnnotationScreenshotPatch, source);

  assert.match(
    patched,
    /Ye=\(Ge\?M\?\.kind===`comment`\?We:\[\]:Je==null\?he:he\.filter\(e=>e\.id!==Je\.id\)\)\.flatMap/,
  );
  assert.doesNotMatch(patched, /Ge\?M\?\.kind===`comment`\?he:\[\]/);
});

test("patches Electron 42 comment preload screenshot marker selection list", () => {
  const source =
    "let Ue=g==null?null:ge.find(e=>e.id===g)??null,We=g==null?null:we.find(e=>e.id===g)??null,A=Ue==null?We==null?null:{kind:`design`,annotation:We}:{kind:`comment`,annotation:Ue},Ge=A?.annotation.id??null,Ke=A?.kind===`comment`?[A.annotation]:ge,qe=A!=null&&g!=null,Je=m?.target.mode===`create`?ho(m.anchor):null,Ye=m?.target.mode===`create`&&m.anchor.type===`element`?m.anchor.viewportSize:void 0,Xe=Je==null?null:ge.find(e=>ue(e.anchor,Je))??null,Ze=(qe?A?.kind===`comment`?ge:[]:Xe==null?ge:ge.filter(e=>e.id!==Xe.id)).flatMap(e=>{let t=fe.get(e.id);if(t==null)return[];return[{comment:e,commentNumber:t}]})";

  const patched = applyPatchTwice(applyBrowserAnnotationScreenshotPatch, source);

  assert.match(
    patched,
    /Ze=\(qe\?A\?\.kind===`comment`\?Ke:\[\]:Xe==null\?ge:ge\.filter\(e=>e\.id!==Xe\.id\)\)\.flatMap/,
  );
  assert.doesNotMatch(patched, /qe\?A\?\.kind===`comment`\?ge:\[\]/);
});

test("guards fast-mode model tier lookup when serviceTiers is missing", () => {
  const source =
    "function m(e){return e.serviceTiers.length>0||e.additionalSpeedTiers?.includes(u)===!0}";

  const patched = applyPatchTwice(applyLinuxFastModeModelGuardPatch, source);

  assert.match(patched, /\(e\?\.serviceTiers\?\.length\?\?0\)>0/);
  assert.doesNotMatch(patched, /e\.serviceTiers\.length/);
});

test("guards drifted fast-mode tier lookup shapes", () => {
  const source = [
    "function y(t){return t.serviceTiers.length > 0 || t.additionalSpeedTiers?.includes(`fast`)}",
    "const z=e=>e.serviceTiers.length>0||e.additionalSpeedTiers.includes(\"fast\")===!0;",
  ].join(";");

  const patched = applyPatchTwice(applyLinuxFastModeModelGuardPatch, source);

  assert.match(patched, /\(t\?\.serviceTiers\?\.length\?\?0\)>0\|\|t\?\.additionalSpeedTiers\?\.includes\(`fast`\)===!0/);
  assert.match(patched, /\(e\?\.serviceTiers\?\.length\?\?0\)>0\|\|e\?\.additionalSpeedTiers\?\.includes\("fast"\)===!0/);
  assert.doesNotMatch(patched, /[te]\.serviceTiers\.length/);
});

test("warns when the fast-mode tier lookup is recognizable but unpatchable", () => {
  const { value, warnings } = captureWarns(() =>
    applyLinuxFastModeModelGuardPatch(
      "function m(e){return currentModel().serviceTiers.length > 0 || e.additionalSpeedTiers?.includes(u)===!0}",
    ),
  );

  assert.equal(
    value,
    "function m(e){return currentModel().serviceTiers.length > 0 || e.additionalSpeedTiers?.includes(u)===!0}",
  );
  assert.deepEqual(warnings, [
    "WARN: Could not find fast-mode model guard insertion point — skipping fast-mode crash guard patch",
  ]);
});

test("treats current service-tier helper bundles as already guarded", () => {
  const source = [
    "function sA(e,t){return t==null?null:t===`fast`?uA(e):e?.serviceTiers?.find(e=>e.id===t)??null}",
    "function cA(e){return[{description:tA.standardDescription},...(e?.serviceTiers??[]).map(e=>({tier:e,value:e.id}))]}",
    "function uA(e){return e?.serviceTiers?.find(e=>rA(e.id,e.name)===`fast`)??null}",
  ].join("");

  const { value, warnings } = captureWarns(() => applyLinuxFastModeModelGuardPatch(source));

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("dedupes flattened skills lists across repeated cwd buckets", () => {
  const source = [
    "const handlers={\"list-skills-for-host\":()=>null};",
    "function FJ(){let y=[",
    "{skills:[{path:`/skills/a/SKILL.md`,name:`A`},{path:`/skills/b/SKILL.md`,name:`B`},{name:`Loose`}]},",
    "{skills:[{path:`/skills/a/SKILL.md`,name:`A duplicate`},{id:`skill-c`,name:`C`},{name:`Loose duplicate`}]},",
    "{skills:[{id:`skill-c`,name:`C duplicate`},{privateIdentity:`plugin-d`,name:`D`},{privateIdentity:`plugin-d`,name:`D duplicate`}]}",
    "],b;b=y.flatMap(IJ);return b}",
    "function IJ(e){return e.skills}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxSkillsListDedupePatch, source);

  assert.match(patched, /function codexLinuxDedupeSkills/);
  assert.match(patched, /b=codexLinuxDedupeSkills\(y\.flatMap\(IJ\)\)/);

  const result = vm.runInNewContext(`${patched};FJ();`);
  const names = Array.from(result, (skill) => skill.name);
  assert.deepEqual(
    names,
    ["A", "B", "Loose", "C", "Loose duplicate", "D"],
  );
});

test("warns when the skills hook is recognizable but the flatten shape drifted", () => {
  const source = [
    "const handlers={\"list-skills-for-host\":()=>null};",
    "function FJ(){let y=[],b;b=y.flatMap(e=>e.skills);return b}",
    "function IJ(e){return e.skills}",
  ].join("");

  const { value, warnings } = captureWarns(() => applyLinuxSkillsListDedupePatch(source));

  assert.equal(value, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find skills list flatten insertion point — skipping Linux skills dedupe patch",
  ]);
});

test("adds Linux avatar overlay mouse passthrough recovery", () => {
  const patched = applyPatchTwice(
    applyLinuxAvatarOverlayMousePassthroughPatch,
    latestAvatarOverlayBundleFixture(),
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
  assert.match(patched, /h\.execFile\(`xdotool`,\[`search`,`--pid`,String\(process\.pid\)\]/);
  assert.match(patched, /h\.execFile\(`xwininfo`,\[`-id`,e\]/);
  assert.match(patched, /h\.execFile\(`xprop`/);
  assert.match(patched, /_GTK_FRAME_EXTENTS/);
  assert.match(patched, /Override Redirect State/);
  assert.match(patched, /Absolute upper-left X/);
  assert.match(patched, /Number\(__codexAvatarX\)!==t\.x/);
  assert.match(patched, /Number\(__codexAvatarY\)!==t\.y/);
  assert.match(patched, /Number\(__codexAvatarWidth\)!==t\.width/);
  assert.match(patched, /Number\(__codexAvatarHeight\)!==t\.height/);
  assert.doesNotMatch(patched, /let\[,l,h,d,f\]=c/);
  assert.doesNotMatch(patched, /this\.codexLinuxIsI3Session\(\)\)\{this\.codexLinuxStopAvatarPassthroughRecovery\(\),this\.codexLinuxAvatarInputShapeKey=null,this\.pointerInteractive=!0,this\.mousePassthroughEnabled&&\(this\.mousePassthroughEnabled=!1\),e\.setIgnoreMouseEvents\(!1\);return\}/);
  assert.match(patched, /if\(this\.codexLinuxIsAvatarShapeBackend\(\)&&typeof e\.setShape==`function`\)\{/);
  assert.match(patched, /if\(this\.codexLinuxIsAvatarShapeBackend\(\)&&typeof e\.setShape==`function`\)\{this\.codexLinuxStartAvatarPassthroughRecovery\(\),/);
  assert.match(patched, /codexLinuxIsAvatarShapeBackend\(\)\{/);
  assert.match(patched, /getSwitchValue\(`ozone-platform`\)/);
  assert.match(patched, /return e===`x11`\|\|e===``&&!process\.env\.WAYLAND_DISPLAY/);
  assert.doesNotMatch(patched, /XDG_SESSION_TYPE/);
  assert.doesNotMatch(patched, /if\(process\.platform===`linux`&&typeof e\.setShape==`function`\)\{this\.codexLinuxStopAvatarPassthroughRecovery\(\),/);
  assert.doesNotMatch(patched, /typeof e\.setShape==`function`&&!this\.codexLinuxIsI3Session\(\)/);
  assert.match(patched, /if\(t==null\)return null/);
  assert.match(patched, /try\{let t=this\.codexLinuxBuildAvatarInputShape\(e\);if\(t==null\)return!1;let n=JSON\.stringify\(t\)/);
  assert.match(patched, /e\.setShape\(t\),this\.codexLinuxAvatarInputShapeKey=n;return!0/);
  assert.match(patched, /return\[i\(t\.mascot\),i\(t\.tray\)\]\.filter\(Boolean\)/);
  assert.match(patched, /process\.platform!==`linux`/);
  assert.match(patched, /setInterval\(\(\)=>\{let e=this\.window/);
  assert.match(patched, /\},32\)/);
  assert.doesNotMatch(patched, /typeof e\.setShape==`function`\)return;this\.codexLinuxAvatarPassthroughRecoveryTimer=setInterval/);
  assert.match(patched, /this\.dragState!=null/);
  assert.match(patched, /this\.codexLinuxIsCursorInAvatarInteractiveRegion\(e\)/);
  assert.match(patched, /__codexWindowHit=__codexX>=0&&__codexY>=0&&__codexX<=__codexBounds\.width&&__codexY<=__codexBounds\.height/);
  assert.match(patched, /return __codexHit\(t\.mascot\)\|\|__codexHit\(t\.tray\)/);
  assert.doesNotMatch(patched, /return __codexHit\(t\.mascot\)\|\|__codexHit\(t\.tray\)\|\|__codexWindowHit/);
  assert.doesNotMatch(patched, /let r=r\.screen\.getCursorScreenPoint\(\)/);
  assert.match(patched, /catch\{t=!0\}/);
  assert.match(patched, /this\.pointerInteractive=t/);
  assert.match(patched, /this\.windowServerDragActive\|\|\(this\.windowServerDragWindowX=null\),process\.platform===`linux`&&\(this\.pointerInteractive=!0,this\.applyPointerInteractivityPolicy\(\)\)\}endDrag\(e,t\)/);
  assert.match(patched, /this\.dockPresentation\(o\.anchor,o\.onDock\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)\}setElementSize/);
  assert.match(patched, /this\.applyLatestElementSizes\(o\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /this\.codexLinuxAvatarCompositorHintsApplied=!1,this\.codexLinuxAvatarCompositorHintsApplying=!1,this\.compositionHost\.setOverlayWindow\(e\)/);
  assert.match(patched, /traySize:process\.platform===`linux`&&typeof this\.codexLinuxIsI3Session==`function`&&this\.codexLinuxIsI3Session\(\)\?this\.traySize:this\.traySize\?\?\(this\.layoutMode===`native`\?y5:v5\)/);
  assert.match(patched, /this\.sendComputerUseCursorLocationToRenderer\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)\}showWindow/);
  assert.match(patched, /e\.moveTop\(\),e\.showInactive\(\),process\.platform===`linux`&&this\.codexLinuxApplyAvatarCompositorHints\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.doesNotMatch(patched, /codexLinuxRecoverAvatarPointerInteractivity/);
  assert.match(patched, /if\(this\.window!==e\)return;let t=this\.presentationVisibility!=null;this\.codexLinuxStopAvatarPassthroughRecovery\(\),this\.codexLinuxAvatarInputShapeKey=null,this\.codexLinuxAvatarCompositorHintsApplied=!1,this\.codexLinuxAvatarCompositorHintsApplying=!1,this\.cancelMomentum\(\)/);
});

test("keeps the avatar overlay core patch idempotent after pet overlay composition", () => {
  const source = `${latestAvatarOverlayBundleFixture()}${currentOpaqueWindowSurfaceBackgroundBundle}`;
  const corePatched = applyLinuxOpaqueBackgroundPatch(
    applyLinuxAvatarOverlayMousePassthroughPatch(source),
  );
  const petPatched = applyPetOverlayPatch(corePatched);
  const { value: rerun, warnings } = captureWarns(() =>
    applyLinuxAvatarOverlayMousePassthroughPatch(petPatched),
  );

  assert.notEqual(petPatched, corePatched);
  assert.equal(rerun, petPatched);
  assert.deepEqual(warnings, []);
});

test("keeps Linux avatar overlay above the app while reply inputs are focusable", () => {
  const patched = applyPatchTwice(
    applyLinuxAvatarOverlayMousePassthroughPatch,
    latestAvatarOverlayBundleFixture(),
  );

  assert.match(
    patched,
    /appearance:`avatarOverlay`,alwaysOnTop:process\.platform===`linux`,skipTaskbar:process\.platform===`linux`,focusable:process\.platform===`linux`\?!0:!1,show:!1/,
  );
  assert.doesNotMatch(patched, /appearance:`avatarOverlay`,focusable:!1,show:!1/);

  const nonAvatarSource = "async createWindow(){return this.windowManager.createWindow({appearance:`main`,focusable:!1,show:!1})}";
  assert.equal(
    applyPatchTwice(applyLinuxAvatarOverlayMousePassthroughPatch, nonAvatarSource),
    nonAvatarSource,
  );
});

test("Linux avatar overlay interactivity is bounded to avatar regions", () => {
  const patched = applyPatchTwice(
    applyLinuxAvatarOverlayMousePassthroughPatch,
    latestAvatarOverlayBundleFixture(),
  );
  const cursor = { x: 5843, y: 1036 };
  let ozonePlatform = "";
  const context = {
    globalThis: {},
    process: {
      env: {},
      pid: 123,
      platform: "linux",
    },
    require(moduleName) {
      if (moduleName === "node:child_process") {
        return { execFile() {} };
      }
      assert.equal(moduleName, "electron");
      return {
      app: {
        getName: () => "Codex",
        commandLine: { getSwitchValue: () => ozonePlatform },
      },
      screen: {
        getCursorScreenPoint: () => cursor,
        getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 800, height: 600 } }),
      },
      };
    },
  };
  vm.runInNewContext(`${patched};globalThis.AvatarOverlayController=fV;`, context);

  const controller = new context.globalThis.AvatarOverlayController(
    { sendMessageToAllRegisteredWindows() {} },
    { set() {} },
  );
  controller.layout = {
    mascot: { left: 220, top: 190, width: 113, height: 122 },
    tray: { left: 57, top: 55, width: 276, height: 131 },
  };

  assert.equal(
    controller.codexLinuxIsCursorInAvatarInteractiveRegion({
      getContentBounds: () => ({ x: 5743, y: 936, width: 356, height: 320 }),
    }),
    true,
  );
  cursor.x = 5765;
  cursor.y = 1088;
  assert.equal(
    controller.codexLinuxIsCursorInAvatarInteractiveRegion({
      getContentBounds: () => ({ x: 5743, y: 936, width: 356, height: 320 }),
    }),
    false,
  );
  assert.equal(
    controller.codexLinuxIsCursorInAvatarInteractiveRegion({
      getContentBounds: () => ({ x: 6000, y: 936, width: 100, height: 100 }),
    }),
    false,
  );

  const overlayWindow = {
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 5743, y: 936, width: 356, height: 320 }),
    setShape() {},
  };
  const serializeShape = (shape) => JSON.parse(JSON.stringify(shape));
  assert.deepEqual(serializeShape(controller.codexLinuxBuildAvatarInputShape(overlayWindow)), [
    { x: 220, y: 190, width: 113, height: 122 },
    { x: 57, y: 55, width: 276, height: 131 },
  ]);
  controller.pointerInteractive = true;
  assert.deepEqual(serializeShape(controller.codexLinuxBuildAvatarInputShape(overlayWindow)), [
    { x: 220, y: 190, width: 113, height: 122 },
    { x: 57, y: 55, width: 276, height: 131 },
  ]);
  controller.dragState = {};
  assert.deepEqual(serializeShape(controller.codexLinuxBuildAvatarInputShape(overlayWindow)), [
    { x: 0, y: 0, width: 356, height: 320 },
  ]);
  controller.dragState = null;
  context.process.env.WAYLAND_DISPLAY = "wayland-0";
  assert.equal(controller.codexLinuxIsAvatarShapeBackend(), false);
  assert.equal(controller.codexLinuxApplyAvatarInputShape(overlayWindow), false);
  let setShapeCalls = 0;
  ozonePlatform = "x11";
  assert.equal(controller.codexLinuxIsAvatarShapeBackend(), true);
  assert.equal(
    controller.codexLinuxApplyAvatarInputShape({
      ...overlayWindow,
      setShape() {
        setShapeCalls += 1;
      },
    }),
    true,
  );
  assert.equal(setShapeCalls, 1);
  ozonePlatform = "wayland";
  assert.equal(controller.codexLinuxIsAvatarShapeBackend(), false);
  ozonePlatform = "x11";
  let failingBoundsCalls = 0;
  assert.equal(
    controller.codexLinuxApplyAvatarInputShape({
      isDestroyed: () => false,
      getContentBounds: () => {
        failingBoundsCalls += 1;
        throw new Error("drift");
      },
      setShape() {},
    }),
    false,
  );
  assert.equal(failingBoundsCalls, 1);
  controller.codexLinuxAvatarInputShapeKey = null;
  let failingSetShapeCalls = 0;
  assert.equal(
    controller.codexLinuxApplyAvatarInputShape({
      isDestroyed: () => false,
      getContentBounds: () => ({ x: 5743, y: 936, width: 356, height: 320 }),
      setShape() {
        failingSetShapeCalls += 1;
        throw new Error("unsupported");
      },
    }),
    false,
  );
  assert.equal(failingSetShapeCalls, 1);
});

test("patches the latest avatar overlay class without depending on adjacent methods", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(
      applyLinuxAvatarOverlayMousePassthroughPatch,
      latestAvatarOverlayBundleFixture(),
    ),
  );

  assert.deepEqual(warnings, []);
  assert.match(patched, /codexLinuxIsI3Session\(\)/);
  assert.match(patched, /setComputerUseCursorLocation\(e\)\{this\.computerUseCursorLocation=e/);
  assert.match(patched, /sendComputerUseCursorLocationToRenderer\(e\)\{this\.windowManager\.sendMessageToWebContents/);
  assert.match(patched, /this\.windowServerDragActive=!1[\s\S]*?process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)\}setElementSize/);
  assert.match(patched, /this\.applyLatestElementSizes\(o\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /this\.compositionHost\.updateMascotRect\(a\.mascot\)[\s\S]*?process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)\}showWindow/);
  assert.match(patched, /if\(this\.window!==e\)return;let t=this\.presentationVisibility!=null;this\.codexLinuxStopAvatarPassthroughRecovery\(\)/);
  assert.match(patched, /traySize:process\.platform===`linux`&&typeof this\.codexLinuxIsI3Session==`function`/);
});

test("scopes avatar overlay method matching away from unrelated earlier classes", () => {
  const unrelatedClass =
    "var Unrelated=class{startDrag(e){this.dragState=null}endDrag(e){this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0})}showWindow(e){e.moveTop(),e.showInactive(),this.broadcastOpenState()}};";

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(
      applyLinuxAvatarOverlayMousePassthroughPatch,
      `${unrelatedClass}${latestAvatarOverlayBundleFixture()}`,
    ),
  );

  assert.deepEqual(warnings, []);
  assert.match(
    patched,
    /var Unrelated=class\{startDrag\(e\)\{this\.dragState=null\}endDrag\(e\)\{this\.dragState=null,this\.reclampWindowToVisibleDisplay\(\{shouldPersist:!0\}\)\}showWindow\(e\)\{e\.moveTop\(\),e\.showInactive\(\),this\.broadcastOpenState\(\)\}\};/,
  );
  assert.match(
    patched,
    /this\.windowServerDragActive\|\|\(this\.windowServerDragWindowX=null\),process\.platform===`linux`&&\(this\.pointerInteractive=!0,this\.applyPointerInteractivityPolicy\(\)\)/,
  );
});

test("bounds avatar overlay method matching to the overlay class body", () => {
  const unrelatedClass =
    "var Other=class{startDrag(e,t){this.dragState={fake:!0}}endDrag(e,t){this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0})}setElementSize(e,{mascot:t,tray:n}){this.applyLayout(e)}applyLayout(e){this.setWindowBounds(e,o.windowBounds),this.sendLayoutToRenderer(e)}showWindow(e){e.moveTop(),e.showInactive(),this.broadcastOpenState()}};";
  const source = latestAvatarOverlayBundleFixture().replace(
    "var fV=class",
    `${unrelatedClass}var fV=class`,
  );

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(
      applyLinuxAvatarOverlayMousePassthroughPatch,
      source,
    ),
  );

  assert.deepEqual(warnings, []);
  assert.equal(patched.includes(unrelatedClass), true);
  assert.match(
    patched,
    /this\.windowServerDragActive\|\|\(this\.windowServerDragWindowX=null\),process\.platform===`linux`&&\(this\.pointerInteractive=!0,this\.applyPointerInteractivityPolicy\(\)\)/,
  );
});

test("adds Linux window icon handling when an icon asset is available", () => {
  const iconAsset = "app-test.png";
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const windowOptionsSource =
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},";
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
      currentOpaqueWindowSurfaceBackgroundBundle,
      fileManagerBundle,
      trayBundleFixture(),
      singleInstanceBundleFixture(),
    ].join(""),
    iconAsset,
  );

  assert.match(patchedWindowOptions, /process\.platform===`win32`\?\{autoHideMenuBar:!0\}:process\.platform===`linux`/);
  assert.doesNotMatch(patchedWindowOptions, /process\.platform===`win32`\|\|process\.platform===`linux`/);
  assert.match(patchedWindowOptions, new RegExp(`icon:${escapeRegExp(iconPathExpression)}`));
  assert.equal(
    patchedSetIcon,
    `process.platform===\`linux\`&&D.setIcon(${iconPathExpression}),${readyToShowSource}`,
  );
  assert.match(patchedMain, new RegExp(`icon:${escapeRegExp(iconPathExpression)}`));
  assert.doesNotMatch(patchedMain, /process\.platform===`win32`\|\|process\.platform===`linux`\?\{autoHideMenuBar:!0/);
  assert.match(patchedMain, new RegExp(`D\\.setIcon\\(${escapeRegExp(iconPathExpression)}\\)`));
});

test("adds Linux window icon handling to current Linux autoHideMenuBar options", () => {
  const iconAsset = "app-test.png";
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const windowOptionsSource =
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},";

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, windowOptionsSource, iconAsset);

  assert.match(patched, /process\.platform===`win32`\?\{autoHideMenuBar:!0\}:process\.platform===`linux`/);
  assert.doesNotMatch(patched, /process\.platform===`win32`\|\|process\.platform===`linux`/);
  assert.match(patched, new RegExp(`icon:${escapeRegExp(iconPathExpression)}`));
});

test("omits undefined BrowserWindow options in the current window manager bundle", () => {
  const iconAsset = "app-test.png";
  const source = [
    "let M=new a.BrowserWindow({width:b,height:x,...S===void 0||C===void 0?{}:{x:S,y:C},",
    "title:n??a.app.getName(),backgroundColor:A,show:l,parent:p,...m===void 0?{}:{focusable:m},",
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},",
    "backgroundMaterial:j??void 0,...D,minWidth:T?.width,minHeight:T?.height,webPreferences:k});",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, source, iconAsset);

  assert.match(patched, /show:l,\.\.\.p===void 0\?\{\}:\{parent:p\},\.\.\.m===void 0\?\{\}:\{focusable:m\}/);
  assert.match(patched, /\.\.\.j==null\?\{\}:\{backgroundMaterial:j\},\.\.\.D,\.\.\.T==null\?\{\}:\{minWidth:T\.width,minHeight:T\.height\},webPreferences:k/);
  assert.doesNotMatch(patched, /show:l,parent:p,\.\.\.m===void 0/);
  assert.doesNotMatch(patched, /backgroundMaterial:j\?\?void 0/);
  assert.doesNotMatch(patched, /minWidth:T\?\.width/);
});

test("keeps the latest primary BrowserWindow focusable without an icon asset", () => {
  const source = [
    "async createWindow(e={}){let{appearance:c=`primary`,show:l=!0,parent:p,focusable:m}=e,",
    "M=new a.BrowserWindow({width:b,height:x,title:n??a.app.getName(),backgroundColor:A,",
    "show:l,parent:p,...m===void 0?{}:{focusable:m},",
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},",
    "backgroundMaterial:j??void 0,...D,minWidth:T?.width,minHeight:T?.height,webPreferences:k});}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, source, null);

  assert.match(
    patched,
    /\.\.\.process\.platform===`linux`&&c===`primary`\?\{focusable:!0\}:m===void 0\?\{\}:\{focusable:m\}/,
  );
  assert.match(
    patched,
    /\.\.\.process\.platform===`win32`\|\|process\.platform===`linux`\?\{autoHideMenuBar:!0\}:\{\}/,
  );
  assert.match(patched, /\.\.\.p===void 0\?\{\}:\{parent:p\}/);
  assert.match(patched, /\.\.\.j==null\?\{\}:\{backgroundMaterial:j\}/);
  assert.match(patched, /\.\.\.T==null\?\{\}:\{minWidth:T\.width,minHeight:T\.height\}/);
});

test("forces Linux primary BrowserWindow to be focusable", () => {
  const iconAsset = "app-test.png";
  const source = [
    "async createWindow(e={}){let{title:n,width:i=1280,height:o=820,appearance:c=`primary`,",
    "show:l=!0,parent:p,focusable:m}=e,D={},M=new a.BrowserWindow({width:b,height:x,",
    "...S===void 0||C===void 0?{}:{x:S,y:C},title:n??a.app.getName(),backgroundColor:A,",
    "show:l,parent:p,...m===void 0?{}:{focusable:m},",
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},",
    "backgroundMaterial:j??void 0,...D,minWidth:T?.width,minHeight:T?.height,webPreferences:k});}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, source, iconAsset);

  assert.match(
    patched,
    /show:l,\.\.\.p===void 0\?\{\}:\{parent:p\},\.\.\.process\.platform===`linux`&&c===`primary`\?\{focusable:!0\}:m===void 0\?\{\}:\{focusable:m\}/,
  );
  assert.match(patched, /\.\.\.j==null\?\{\}:\{backgroundMaterial:j\},\.\.\.D/);
  assert.doesNotMatch(patched, /show:l,parent:p,\.\.\.m===void 0/);
});

test("preserves nullish BrowserWindow option semantics", () => {
  const source = [
    "function makeOptions(j,T){let l=!0,p,m,D={},k={};return{show:l,parent:p,...m===void 0?{}:{focusable:m},",
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},",
    "backgroundMaterial:j??void 0,...D,minWidth:T?.width,minHeight:T?.height,webPreferences:k}}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, source, "app-test.png");
  const makeOptions = new Function(
    "process",
    `${patched};return makeOptions`,
  )({ platform: "linux", resourcesPath: "/tmp/resources" });
  const options = makeOptions(null, null);

  assert.match(patched, /\.\.\.j==null\?\{\}:\{backgroundMaterial:j\}/);
  assert.match(
    patched,
    /\.\.\.T==null\?\{\}:\{minWidth:T\.width,minHeight:T\.height\}/,
  );
  assert.doesNotMatch(patched, /\.\.\.T===void 0/);
  assert.equal("backgroundMaterial" in options, false);
  assert.equal("minWidth" in options, false);
  assert.equal("minHeight" in options, false);
});

test("ignores unrelated BrowserWindow focusable candidates while patching the primary window", () => {
  const source = [
    "new a.BrowserWindow({acceptFirstMouse:!0,focusable:!1,webPreferences:u});",
    "async createWindow(e={}){let{title:n,appearance:c=`primary`,focusable:m}=e,",
    "M=new a.BrowserWindow({width:b,height:x,title:n??a.app.getName(),...m===void 0?{}:{focusable:m},",
    "...process.platform===`win32`?{autoHideMenuBar:!0}:process.platform===`linux`?{icon:process.resourcesPath+`/../content/webview/assets/app-test.png`}:{},webPreferences:k});}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, source, "app-test.png");

  assert.match(patched, /acceptFirstMouse:!0,focusable:!1,webPreferences:u/);
  assert.match(
    patched,
    /\.\.\.process\.platform===`linux`&&c===`primary`\?\{focusable:!0\}:m===void 0\?\{\}:\{focusable:m\}/,
  );
});

test("keeps current focusable destructuring valid while patching the BrowserWindow spread", () => {
  const source = [
    "async createWindow(e={}){let{title:n,width:i=1280,height:o=820,appearance:c=`primary`,",
    "focusable:m}=e,M=new a.BrowserWindow({width:b,height:x,...m===void 0?{}:{focusable:m},",
    "...process.platform===`win32`?{autoHideMenuBar:!0}:process.platform===`linux`?{icon:process.resourcesPath+`/../content/webview/assets/app-test.png`}:{},webPreferences:k});}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxWindowOptionsPatch, source, "app-test.png");

  assert.match(patched, /appearance:c=`primary`,focusable:m\}=e/);
  assert.match(
    patched,
    /new a\.BrowserWindow\(\{width:b,height:x,\.\.\.process\.platform===`linux`&&c===`primary`\?\{focusable:!0\}:m===void 0\?\{\}:\{focusable:m\},/,
  );
});

test("fails loudly when primary BrowserWindow focusable shape cannot be patched", () => {
  const source = [
    "async createWindow(e={}){let{appearance:c=`primary`}=e,",
    "M=new a.BrowserWindow({width:b,height:x,focusable:getFocusable(),webPreferences:k});}",
  ].join("");

  assert.throws(
    () => applyLinuxWindowOptionsPatch(source, null),
    /Could not patch primary BrowserWindow focusable option for Linux/,
  );
});

test("patches remaining Linux window icon snippets when another window is already patched", () => {
  const iconAsset = "app-test.png";
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const windowOptionsSource =
    "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},";
  const patchedWindowOptionsNeedle =
    `...process.platform===\`win32\`?{autoHideMenuBar:!0}:process.platform===\`linux\`?{icon:${iconPathExpression}}:{},`;
  const readyToShowSource = "D.once(`ready-to-show`,()=>{})";
  const readyToShowSource2 = "E.once(`ready-to-show`,()=>{})";
  const patchedSetIconNeedle =
    `process.platform===\`linux\`&&D.setIcon(${iconPathExpression}),${readyToShowSource}`;

  const patchedWindowOptions = applyPatchTwice(
    applyLinuxWindowOptionsPatch,
    `${patchedWindowOptionsNeedle}function createSecondWindow(){return {${windowOptionsSource}}}`,
    iconAsset,
  );
  const patchedSetIcon = applyPatchTwice(
    applyLinuxSetIconPatch,
    `${patchedSetIconNeedle}function createSecondWindow(){${readyToShowSource2}}`,
    iconAsset,
  );

  assert.equal((patchedWindowOptions.match(/icon:process\.resourcesPath/g) ?? []).length, 2);
  assert.match(
    patchedWindowOptions,
    /function createSecondWindow\(\)\{return \{\.\.\.process\.platform===`win32`\?\{autoHideMenuBar:!0\}:process\.platform===`linux`\?\{icon:process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/app-test\.png`\}:\{\},\}\}/,
  );
  assert.equal((patchedSetIcon.match(/\.setIcon\(/g) ?? []).length, 2);
  assert.match(
    patchedSetIcon,
    /function createSecondWindow\(\)\{process\.platform===`linux`&&E\.setIcon\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/app-test\.png`\),E\.once\(`ready-to-show`,\(\)=>\{\}\)\}/,
  );
});

test("recognizes current Linux setIcon coverage as window icon handling", () => {
  const iconAsset = "app-test.png";
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const source = `process.platform===\`linux\`&&D.setIcon(${iconPathExpression}),D.once(\`ready-to-show\`,()=>{})`;

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxWindowOptionsPatch, source, iconAsset),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("lets ready-to-show icon insertion cover current window options drift", () => {
  const iconAsset = "app-test.png";
  const source = "D.once(`ready-to-show`,()=>{})";

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxWindowOptionsPatch, source, iconAsset),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("adds Linux tray support including the platform guard", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const packagedTrayIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop-tray.png`";
  const packagedAppIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop.png`";
  const patched = applyPatchTwice(
    applyLinuxTrayPatch,
    `${mainBundlePrefix}${trayBundleFixture()}`,
    iconPathExpression,
  );

  assert.match(
    patched,
    /process\.platform!==`win32`&&process\.platform!==`darwin`&&process\.platform!==`linux`\?null:/,
  );
  assert.match(
    patched,
    new RegExp(`nativeImage\\.createFromPath\\(${escapeRegExp(packagedTrayIconPathExpression)}\\)`),
  );
  assert.match(
    patched,
    new RegExp(`nativeImage\\.createFromPath\\(${escapeRegExp(packagedAppIconPathExpression)}\\)`),
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
    /process\.platform===`linux`&&\(codexLinuxSetTrayController\(this\),this\.setLinuxTrayContextMenu\(\)\),this\.tray\.on\(`click`/,
  );
  assert.match(
    patched,
    /codexLinuxTrayRecoveryHandler=\(\)=>\{let e=codexLinuxTrayController;e\?\.setLinuxTrayContextMenu\?\.\(\)\}/,
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

test("refreshes only the live Linux tray controller after session recovery", () => {
  const source = `${mainBundlePrefix}${trayBundleFixture()
    .replace(
      "this.tray={on(){},setContextMenu(){},popUpContextMenu(){}}",
      "this.tray=globalThis.createTray()",
    )
    .replace("}}v&&", "}};v&&")
    .replace(";E&&oe();", ";")}`;
  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);
  const powerMonitor = new EventEmitter();
  const app = new EventEmitter();
  const trays = [];
  const context = {
    E: false,
    v: false,
    e: { o: (value) => value },
    process: { platform: "linux", resourcesPath: "", execPath: "" },
    require: (name) => {
      if (name !== "electron") {
        return {};
      }
      return {
        app,
        powerMonitor,
        Menu: { buildFromTemplate: () => ({}) },
      };
    },
    createTray: () => {
      const tray = {
        destroyed: false,
        menuSetCount: 0,
        on() {},
        setContextMenu() {
          if (this.destroyed) {
            throw new Error("destroyed tray");
          }
          this.menuSetCount += 1;
        },
        popUpContextMenu() {},
        destroy() {
          this.destroyed = true;
        },
      };
      trays.push(tray);
      return tray;
    },
  };

  vm.runInNewContext(`${patched};globalThis.TrayController=pb;`, context);
  assert.equal(powerMonitor.listenerCount("unlock-screen"), 0);
  assert.equal(powerMonitor.listenerCount("resume"), 0);
  const firstController = new context.TrayController();
  assert.equal(powerMonitor.listenerCount("unlock-screen"), 1);
  assert.equal(powerMonitor.listenerCount("resume"), 1);
  const firstTray = trays[0];
  firstTray.destroy();
  const liveController = new context.TrayController();
  const liveTray = trays[1];

  assert.doesNotThrow(() => {
    powerMonitor.emit("unlock-screen");
    powerMonitor.emit("resume");
  });
  assert.equal(firstTray.menuSetCount, 1);
  assert.equal(liveTray.menuSetCount, 3);

  app.emit("before-quit");
  powerMonitor.emit("unlock-screen");
  assert.equal(liveTray.menuSetCount, 4);
  assert.equal(powerMonitor.listenerCount("unlock-screen"), 1);
  assert.equal(powerMonitor.listenerCount("resume"), 1);

  app.emit("will-quit");
  powerMonitor.emit("unlock-screen");
  assert.equal(liveTray.menuSetCount, 4);
  assert.equal(powerMonitor.listenerCount("unlock-screen"), 0);
  assert.equal(powerMonitor.listenerCount("resume"), 0);
  assert.ok(firstController);
  assert.ok(liveController);
});

test("keeps Linux tray setup fail-soft when recovery helper insertion drifts", () => {
  const source = `${mainBundlePrefix}${trayBundleFixture().replace(
    "var pb=class{nativeTrayClickSuppressionReason=",
    "var pb=class extends globalThis.TrayBase{nativeTrayClickSuppressionReason=",
  )}`;

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxTrayPatch, source, null),
  );

  assert.ok(
    warnings.includes(
      "WARN: Could not find tray controller class — skipping Linux tray power-monitor refresh patch",
    ),
  );
  assert.match(patched, /setLinuxTrayContextMenu\(\)\{/);
  assert.match(
    patched,
    /process\.platform===`linux`&&this\.setLinuxTrayContextMenu\(\),this\.tray\.on\(`click`/,
  );
  assert.doesNotMatch(patched, /codexLinuxSetTrayController\(this\)/);
  assert.doesNotMatch(patched, /codexLinuxTrayRecoveryHandler=/);
});

test("uses collision-proof Linux tray icon variables when Electron alias is r", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const source = [
    "let r=require(`electron`),i=require(`node:path`);",
    "async function Hw(e){return process.platform!==`win32`&&process.platform!==`darwin`?null:(zw=!0,Lw??Rw??(Rw=(async()=>{let t=await Ww(e.appBrand,e.buildFlavor,e.repoRoot),i=new r.Tray(t.defaultIcon);return i})()))}",
    "async function Ww(e,t,n){if(process.platform===`darwin`){return null}let o=K9(e,t,n);return o==null?{defaultIcon:await r.app.getFileIcon(process.execPath,{size:`small`}),chronicleRunningIcon:null}:{defaultIcon:o,chronicleRunningIcon:null}}",
    "function K9(e,t,n){let a=[(0,i.join)(n,`electron`,`src`,`icons`,`tray.png`)];for(let e of a){let t=r.nativeImage.createFromPath(e);if(!t.isEmpty())return t}return null}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, iconPathExpression);

  assert.doesNotMatch(patched, /let r=r\.nativeImage/);
  assert.match(
    patched,
    /let __codexLinuxUpstreamTrayIcon=r\.nativeImage\.createFromPath\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/app-test\.png`\)/,
  );
});

test("adds Linux tray icon fallback when current upstream uses small file icon fallback", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const source = `${mainBundlePrefix}${trayBundleFixture()}`;

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxTrayPatch, source, iconPathExpression),
  );

  assert.deepEqual(warnings, []);
  assert.match(patched, /__codexLinuxTrayIcon=n\.nativeImage\.createFromPath/);
  assert.match(patched, /let r=K9\(e,t,i\);if\(r!=null\)return\{defaultIcon:r,chronicleRunningIcon:null\};if\(process\.platform===`linux`\)/);
  assert.match(patched, /n\.app\.getFileIcon\(process\.execPath,\{size:`small`\}\)/);
});

test("adds Linux tray support even when About dialog already uses the bundled icon path", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const packagedTrayIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop-tray.png`";
  const source = [
    mainBundlePrefix,
    trayBundleFixture(),
    "async function bZ(){let t=process.execPath;return process.platform===`linux`?Promise.resolve((()=>{let __codexLinuxAboutIcon=n.nativeImage.createFromPath(process.resourcesPath+`/../content/webview/assets/app-test.png`);return __codexLinuxAboutIcon.isEmpty()?null:__codexLinuxAboutIcon})()):n.app.getFileIcon(t,{size:process.platform===`win32`?`large`:`normal`}).catch(()=>null)}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, iconPathExpression);

  assert.match(
    patched,
    new RegExp(`nativeImage\\.createFromPath\\(${escapeRegExp(packagedTrayIconPathExpression)}\\)`),
  );
});

test("adds Linux build information to the tray menu", () => {
  const patched = applyPatchTwice(applyLinuxBuildInfoTrayPatch, `${mainBundlePrefix}${trayBundleFixture()}`);

  assert.match(patched, /function codexLinuxShowBuildInfo\(\)/);
  assert.match(patched, /codex-linux-build-info\.json/);
  assert.match(patched, /label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}/);
  assert.match(patched, /Enabled features:/);
  assert.match(patched, /Upstream DMG SHA256:/);
  assert.match(patched, /Linux source commit:/);
  assert.match(patched, /Source commit URL:/);
  assert.match(patched, /Open Source Commit/);
  assert.match(patched, /Open Metadata File/);
  assert.match(patched, /shell\?\.openExternal/);
  assert.match(patched, /shell\?\.openPath/);
});

test("adds Linux build information request handlers for renderer settings", () => {
  const source =
    "let n=require(`electron`),o=require(`node:fs`),i=require(`node:path`),e={bn:{help:`help`}};const h={\"get-global-state\":async({key:a})=>({value:this.globalState.get(a)}),\"set-global-state\":async({key:a,value:b,origin:c})=>(this.setGlobalStateValue(a,b,c),{success:!0})};let $e=[{role:`help`,id:e.bn.help,submenu:[{label:`Codex Documentation`,click:()=>{n.shell.openExternal(`https://developers.openai.com/codex/app`)}}]}],et=n.Menu.buildFromTemplate($e);n.Menu.setApplicationMenu(et);";
  const patched = applyPatchTwice(applyLinuxBuildInfoTrayPatch, source);

  assert.match(patched, /function codexLinuxGetBuildInfo\(\)/);
  assert.match(patched, /"codex-linux-get-build-info":async\(\)=>codexLinuxGetBuildInfo\(\)/);
  assert.match(
    patched,
    /"codex-linux-open-build-info-commit":async\(\)=>codexLinuxOpenBuildInfoCommit\(\)/,
  );
  assert.match(
    patched,
    /"codex-linux-show-build-info":async\(\)=>\{await codexLinuxShowBuildInfo\(\);return\{success:!0\}\}/,
  );
});

test("Linux build information helper locals do not shadow minified module bindings", () => {
  const source =
    "let a=require(`electron`),l=require(`node:fs`),s=require(`node:path`),e={bn:{help:`help`}};const h={\"get-global-state\":async({key:a})=>({value:this.globalState.get(a)}),\"set-global-state\":async({key:a,value:b,origin:c})=>(this.setGlobalStateValue(a,b,c),{success:!0})};let $e=[{role:`help`,id:e.bn.help,submenu:[{label:`Codex Documentation`,click:()=>{a.shell.openExternal(`https://developers.openai.com/codex/app`)}}]}],et=a.Menu.buildFromTemplate($e);a.Menu.setApplicationMenu(et);";
  const patched = applyPatchTwice(applyLinuxBuildInfoTrayPatch, source);

  assert.match(patched, /await a\.dialog\?\.showMessageBox/);
  assert.match(patched, /\(0,s\.join\)\(process\.resourcesPath/);
  assert.match(patched, /l\.existsSync\(__codexBuildInfoPath\)/);
  assert.doesNotMatch(patched, /let a=await a\.dialog/);
  assert.doesNotMatch(patched, /let s=\[\]/);
});

test("Linux build information request handlers are inserted into the handler table", () => {
  const source =
    "let a=require(`electron`),l=require(`node:fs`),s=require(`node:path`),e={bn:{help:`help`}};const h={\"is-copilot-api-available\":async()=>({available:!1}),\"get-global-state\":async({key:e})=>({value:this.globalState.get(e)}),\"set-global-state\":async({key:e,value:t,origin:n})=>(this.setGlobalStateValue(e,t,n),{success:!0})};let $e=[{role:`help`,id:e.bn.help,submenu:[{label:`Codex Documentation`,click:()=>{a.shell.openExternal(`https://developers.openai.com/codex/app`)}}]}],et=a.Menu.buildFromTemplate($e);a.Menu.setApplicationMenu(et);";
  const patched = applyPatchTwice(applyLinuxBuildInfoTrayPatch, source);

  assert.match(
    patched,
    /"is-copilot-api-available":async\(\)=>\(\{available:!1\}\),"codex-linux-get-build-info":async\(\)=>codexLinuxGetBuildInfo\(\),"codex-linux-open-build-info-commit"/,
  );
  assert.doesNotMatch(patched, /"is-copilot-api-available":async\(\)=>\(\{"codex-linux-get-build-info"/);
});

test("adds Linux build information to current tray menu shape", () => {
  const patched = applyPatchTwice(applyLinuxBuildInfoTrayPatch, `${mainBundlePrefix}${currentTrayMenuBundleFixture()}`);

  assert.match(patched, /function codexLinuxShowBuildInfo\(\)/);
  assert.match(
    patched,
    /getNativeTrayMenuItems\(\)\{let\{pinnedThreads:e,[^]*?;return\[\.\.\.process\.platform===`linux`\?\[\{label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}\},\{type:`separator`\}\]:\[\],\.\.\.h/,
  );
});

test("adds Linux build information to the app Help menu", () => {
  const source =
    "let n=require(`electron`),o=require(`node:fs`),i=require(`node:path`),e={bn:{help:`help`}};let $e=[{role:`help`,id:e.bn.help,submenu:[{label:`Codex Documentation`,click:()=>{n.shell.openExternal(`https://developers.openai.com/codex/app`)}}]}],et=n.Menu.buildFromTemplate($e);n.Menu.setApplicationMenu(et);";
  const patched = applyPatchTwice(applyLinuxBuildInfoTrayPatch, source);

  assert.match(patched, /function codexLinuxShowBuildInfo\(\)/);
  assert.doesNotThrow(() => new Function(patched));
  assert.match(
    patched,
    /\{role:`help`,id:e\.bn\.help,submenu:\[\.\.\.process\.platform===`linux`\?\[\{label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}\},\{type:`separator`\}\]:\[\],\{label:`Codex Documentation`/,
  );
});

function currentAboutDialogBundleFixture() {
  return [
    "let c=require(`electron`),a={s:()=>null};",
    "var q6=`codex.aboutDialog.title`,i8=72;",
    "async function h8(e){let t=process.platform===`darwin`,n=process.platform===`win32`,r=process.execPath;t?r=a.s():n&&(r=`icon`);let[i,o]=await Promise.all([t?GD(r):null,n?c.nativeImage.createFromPath(r):c.app.getFileIcon(r,{size:`normal`})]);return{htmlIconDataUrl:i??(o.isEmpty()?null:o.resize({width:i8,height:i8,quality:`best`}).toDataURL()),windowIcon:o}}",
    "let p={windowIcon:null},S={...p.windowIcon.isEmpty()?{}:{icon:p.windowIcon}};",
  ].join("");
}

test("makes the current About dialog prefer the bundled Linux icon asset", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const patched = applyPatchTwice(
    applyLinuxAboutDialogPatch,
    currentAboutDialogBundleFixture(),
    iconPathExpression,
  );

  assert.match(
    patched,
    new RegExp(`nativeImage\\.createFromPath\\(${escapeRegExp(iconPathExpression)}\\)`),
  );
  assert.match(patched, /process\.platform===`linux`\?null:t\?GD\(r\):null/);
  assert.match(patched, /:n\?c\.nativeImage\.createFromPath\(r\):c\.app\.getFileIcon/);
  assert.match(patched, /p\.windowIcon==null\|\|p\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:p\.windowIcon\}/);
  assert.match(patched, /o==null\|\|o\.isEmpty\(\)\?null:o\.resize\(/);
  assert.match(patched, /windowIcon:o\?\?null/);
  assert.match(patched, /let p=\{windowIcon:null\}/);
  assert.doesNotMatch(patched, /null\?\?null/);
  assert.doesNotThrow(() => new Function(patched));
});

test("keeps the current no-icon About dialog patch idempotent", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(
      applyLinuxAboutDialogPatch,
      currentAboutDialogBundleFixture(),
      null,
    ),
  );

  assert.deepEqual(warnings, []);
  assert.match(
    patched,
    /:c\.app\.getFileIcon\(r,\{size:`normal`\}\)\.catch\(\(\)=>null\)\]/,
  );
  assert.match(patched, /o==null\|\|o\.isEmpty\(\)\?null:o\.resize\(/);
  assert.equal((patched.match(/o==null\|\|/g) ?? []).length, 1);
  assert.match(patched, /windowIcon:o\?\?null/);
  assert.match(patched, /p\.windowIcon==null\|\|p\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:p\.windowIcon\}/);
  assert.match(patched, /let p=\{windowIcon:null\}/);
  assert.doesNotMatch(patched, /null\?\?null/);
  assert.doesNotThrow(() => new Function(patched));
});

test("rejects the obsolete pre-26.623 About dialog shape", () => {
  const source = [
    "let a=require(`electron`);",
    "var $X=`codex.aboutDialog.title`,uZ=72;",
    "async function bZ(){let e=process.platform===`darwin`,t=e?`icon`:process.execPath,[n,i]=await Promise.all([e?Fw(t):null,a.app.getFileIcon(t,{size:process.platform===`win32`?`large`:`normal`})]);return{htmlIconDataUrl:n??(i.isEmpty()?null:i.resize({width:uZ,height:uZ,quality:`best`}).toDataURL()),windowIcon:i}}",
    "let d={windowIcon:null},q={...d.windowIcon.isEmpty()?{}:{icon:d.windowIcon}};",
  ].join("");
  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxAboutDialogPatch(source, null),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, ["WARN: Could not patch About dialog icon fallback for Linux"]);
});

test("does not partially patch current About shapes with mismatched result aliases", () => {
  const malformedSources = [
    currentAboutDialogBundleFixture().replace("windowIcon:o}", "windowIcon:z}"),
    currentAboutDialogBundleFixture().replace("{icon:p.windowIcon}", "{icon:q.windowIcon}"),
  ];

  for (const source of malformedSources) {
    const { value: patched, warnings } = captureWarns(() =>
      applyLinuxAboutDialogPatch(source, null),
    );
    assert.equal(patched, source);
    assert.deepEqual(warnings, ["WARN: Could not patch About dialog icon fallback for Linux"]);
  }
});

test("adds Linux tray support for current minified window and startup identifiers", () => {
  const source = [
    mainBundlePrefix,
    "v&&j.on(`close`,e=>{this.persistPrimaryWindowBounds(j);let t=this.getPrimaryWindows().some(e=>e!==j);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t){e.preventDefault(),j.hide();return}});",
    "async function eN(e){let t=await Ww(e.buildFlavor,e.appBrand,e.repoRoot),r=new n.Tray(t.defaultIcon);return r}",
    "let ce$=async()=>{O=!0;try{await eN({appBrand:a.U(),buildFlavor:b,repoRoot:j.repoRoot})}catch(e){O=!1}};E&&ce$();",
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
  assert.match(
    patched,
    /catch\(e\)\{O=!1;process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
  );
  assert.equal((patched.match(/\[codex-linux\] Failed to set up system tray/g) ?? []).length, 1);
});

test("adds Linux tray startup support for current appBrand initializer", () => {
  const source = [
    "let a=require(`electron`);",
    "async function H5(e){let t=await W5(e.appBrand,e.repoRoot),n=new a.Tray(t.defaultIcon);return n}",
    "let ye=async()=>{O=!0;try{await H5({appBrand:r.et(),repoRoot:j.repoRoot})}catch(e){O=!1,_.reportNonFatal(e instanceof Error?e:`Failed to set up tray`,{kind:`tray-setup-failed`,tags:{errorType:`tray-setup-failed`}}),ee()}};E&&ye();",
  ].join("");

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxTrayPatch, source, null),
  );

  assert.deepEqual(warnings.filter((warning) => warning.includes("tray startup")), []);
  assert.match(
    patched,
    /\(E\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&ye\(\);/,
  );
  assert.match(
    patched,
    /ee\(\);process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
  );
});

test("scopes dynamic tray startup matching to the tray initializer", () => {
  const source = [
    mainBundlePrefix,
    "async function aa(e){return e.buildFlavor}",
    "let startOther=async()=>{A=!0;try{await aa({buildFlavor:a})}catch(e){A=!1}};U&&startOther();",
    "async function eN(e){let t=await Ww(e.buildFlavor,e.appBrand,e.repoRoot),r=new n.Tray(t.defaultIcon);return r}",
    "let ce$=async()=>{O=!0;try{await eN({appBrand:a.U(),buildFlavor:b,repoRoot:j.repoRoot})}catch(e){O=!1}};E&&ce$();",
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
  assert.match(patched, /catch\(e\)\{A=!1\}\};U&&startOther\(\);/);
  assert.match(
    patched,
    /catch\(e\)\{O=!1;process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
  );
});

test("logs Linux tray setup failures when the catch body contains nested objects", () => {
  const source = [
    "let a=require(`electron`);",
    "async function s4(e){let t=await l4(e.buildFlavor,e.appBrand,e.repoRoot),n=new a.Tray(t.defaultIcon);return n}",
    "let _e=async()=>{k=!0;try{await s4({appBrand:r.U(),buildFlavor:o,repoRoot:M.repoRoot})}catch(e){k=!1,v.reportNonFatal(e instanceof Error?e:`Failed to set up tray`,{kind:`tray-setup-failed`,tags:{errorType:`tray-setup-failed`}}),N.ensureWindow()}};D&&_e();",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);

  assert.match(
    patched,
    /\(D\|\|process\.platform===`linux`&&\(typeof codexLinuxIsTrayEnabled!==`function`\|\|codexLinuxIsTrayEnabled\(\)\)\)&&_e\(\);/,
  );
  assert.match(
    patched,
    /N\.ensureWindow\(\);process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
  );
});

test("scopes close-to-tray already-patched detection to the handler", () => {
  const source = [
    mainBundlePrefix,
    "let unrelated=(process.platform===`win32`||process.platform===`linux`)&&x===`local`;",
    "v&&j.on(`close`,e=>{this.persistPrimaryWindowBounds(j);let t=this.getPrimaryWindows().some(e=>e!==j);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t){e.preventDefault(),j.hide();return}});",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, null);

  assert.match(
    patched,
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLastWindowToTray\?\.\(\)===!0&&!t\)\{e\.preventDefault\(\),j\.hide\(\);return\}/,
  );
});

test("adds Linux single-instance lock and second-instance handoff", () => {
  const patched = applyPatchTwice(applyLinuxSingleInstancePatch, singleInstanceBundleFixture());

  assert.match(
    patched,
    /process\.platform===`linux`&&process\.env\.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n\.app\.requestSingleInstanceLock\(\)/,
  );
  assert.match(patched, /n\.app\.quit\(\);return/);
  assert.match(patched, /codexLinuxBeforeQuitHandler=\(\)=>\{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\)\}/);
  assert.match(patched, /n\.app\.on\(`before-quit`,codexLinuxBeforeQuitHandler\)/);
  assert.match(patched, /n\.app\.off\(`before-quit`,codexLinuxBeforeQuitHandler\)/);
  assert.match(patched, /codexLinuxSecondInstanceHandler/);
  assert.match(patched, /n\.app\.on\(`second-instance`,codexLinuxSecondInstanceHandler\)/);
  assert.match(patched, /n\.app\.off\(`second-instance`,codexLinuxSecondInstanceHandler\)/);
});

test("forces the bootstrap single-instance lock on Linux even when upstream disables it", () => {
  const source =
    "var S=t.x({isMacOS:b,isPackaged:n.app.isPackaged});if(!(!S||n.app.requestSingleInstanceLock()))t.Jr().info(`Exiting second desktop instance`,{safe:{packaged:n.app.isPackaged,platform:process.platform}}),n.app.exit(0);else{let e=t.C(x);}";
  const patched = applyPatchTwice(applyLinuxMultiInstanceBootstrapPatch, source);

  assert.match(
    patched,
    /if\(!\(process\.platform===`linux`\?process\.env\.CODEX_LINUX_MULTI_LAUNCH===`1`\|\|n\.app\.requestSingleInstanceLock\(\):!S\|\|n\.app\.requestSingleInstanceLock\(\)\)\)/,
  );
  assert.match(patched, /Exiting second desktop instance/);
});

test("upgrades the legacy guarded bootstrap single-instance lock to the enforced form", () => {
  const source =
    "var $=r.D({isMacOS:Z,isPackaged:e.app.isPackaged});if(!(!$||process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH===`1`||e.app.requestSingleInstanceLock()))t.Vr().info(`Exiting second desktop instance`,{}),e.app.exit(0);";
  const patched = applyPatchTwice(applyLinuxMultiInstanceBootstrapPatch, source);

  assert.match(
    patched,
    /if\(!\(process\.platform===`linux`\?process\.env\.CODEX_LINUX_MULTI_LAUNCH===`1`\|\|e\.app\.requestSingleInstanceLock\(\):!\$\|\|e\.app\.requestSingleInstanceLock\(\)\)\)/,
  );
  assert.ok(!patched.includes("&&process.env.CODEX_LINUX_MULTI_LAUNCH"));
});

test("enforced bootstrap lock takes the Linux lock with upstream flag off and exits the loser", () => {
  const source =
    "var S=t.x({isMacOS:b,isPackaged:n.app.isPackaged});if(!(!S||n.app.requestSingleInstanceLock()))n.app.exit(0);";
  const patched = applyLinuxMultiInstanceBootstrapPatch(source);

  const run = ({ lockResult, multiLaunch }) => {
    const calls = { lock: 0, exit: 0 };
    const t = { x: () => false };
    const n = {
      app: {
        isPackaged: true,
        requestSingleInstanceLock: () => {
          calls.lock += 1;
          return lockResult;
        },
        exit: () => {
          calls.exit += 1;
        },
      },
    };
    const previous = process.env.CODEX_LINUX_MULTI_LAUNCH;
    if (multiLaunch) {
      process.env.CODEX_LINUX_MULTI_LAUNCH = "1";
    } else {
      delete process.env.CODEX_LINUX_MULTI_LAUNCH;
    }
    try {
      new Function("t", "n", "b", patched)(t, n, false);
    } finally {
      if (previous == null) {
        delete process.env.CODEX_LINUX_MULTI_LAUNCH;
      } else {
        process.env.CODEX_LINUX_MULTI_LAUNCH = previous;
      }
    }
    return calls;
  };

  // process.platform is linux in CI and on dev machines for this repo.
  const winner = run({ lockResult: true, multiLaunch: false });
  assert.equal(winner.lock, 1);
  assert.equal(winner.exit, 0);

  const loser = run({ lockResult: false, multiLaunch: false });
  assert.equal(loser.lock, 1);
  assert.equal(loser.exit, 1);

  const sideBySide = run({ lockResult: true, multiLaunch: true });
  assert.equal(sideBySide.lock, 0);
  assert.equal(sideBySide.exit, 0);
});

test("recognizes bootstrap-owned single-instance handoff in current bundles", () => {
  const source = "let{setSecondInstanceArgsHandler:l}=t.y();l(e=>{let n=t.t(t.g(e));if(z.deepLinks.queueProcessArgs(e)){n&&le();return}if(n){le();return}le()});";
  const patched = applyPatchTwice(applyLinuxSingleInstancePatch, source);

  assert.equal(patched, source);
});

test("persists Linux settings to the launcher-provided settings file", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-path-"));
  try {
    const settingsFile = path.join(tempRoot, "config", "codex-cua-lab", "settings.json");
    const patched = applyPatchTwice(applyLinuxSettingsPersistencePatch, settingsPersistenceBundleFixture());

    assert.match(patched, /process\.env\.CODEX_LINUX_SETTINGS_FILE/);
    runSettingsPersistence(
      patched,
      {
        CODEX_LINUX_APP_ID: "codex-cua-lab",
        CODEX_LINUX_SETTINGS_FILE: settingsFile,
        HOME: path.join(tempRoot, "home"),
      },
      "codex-linux-warm-start-enabled",
      false,
    );

    assert.equal(
      JSON.parse(fs.readFileSync(settingsFile, "utf8"))["codex-linux-warm-start-enabled"],
      false,
    );
    assert.equal(fs.existsSync(path.join(tempRoot, "home", ".config", "codex-desktop", "settings.json")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("persists Linux settings under the effective side-by-side app id", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-app-id-"));
  try {
    const xdgConfig = path.join(tempRoot, "xdg-config");
    const patched = applyPatchTwice(applyLinuxSettingsPersistencePatch, settingsPersistenceBundleFixture());

    assert.match(patched, /process\.env\.CODEX_LINUX_APP_ID\|\|process\.env\.CODEX_APP_ID/);
    runSettingsPersistence(
      patched,
      {
        CODEX_LINUX_APP_ID: "codex-cua-lab",
        XDG_CONFIG_HOME: xdgConfig,
      },
      "codex-linux-system-tray-enabled",
      false,
    );

    assert.equal(
      JSON.parse(fs.readFileSync(path.join(xdgConfig, "codex-cua-lab", "settings.json"), "utf8"))["codex-linux-system-tray-enabled"],
      false,
    );
    assert.equal(fs.existsSync(path.join(xdgConfig, "codex-desktop", "settings.json")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("persists Linux settings with current setGlobalStateValue handler shape", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-current-shape-"));
  try {
    const settingsFile = path.join(tempRoot, "config", "codex-desktop", "settings.json");
    const patched = applyPatchTwice(applyLinuxSettingsPersistencePatch, currentSettingsPersistenceBundleFixture());

    assert.match(patched, /var s=`\.codex-global-state\.json`;function codexLinuxSettingsAppId/);
    assert.match(patched, /var c=`config\.toml`/);
    assert.match(patched, /this\.setGlobalStateValue\(a,b,c\),codexLinuxPersistSettingsState\(a,b\)/);
    runSettingsPersistence(
      patched,
      {
        CODEX_LINUX_SETTINGS_FILE: settingsFile,
        HOME: path.join(tempRoot, "home"),
      },
      "codex-linux-read-aloud-enabled",
      true,
    );
    runSettingsPersistence(
      patched,
      {
        CODEX_LINUX_SETTINGS_FILE: settingsFile,
        HOME: path.join(tempRoot, "home"),
      },
      "codex-linux-read-aloud-kokoro-speed",
      1.15,
    );

    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert.equal(settings["codex-linux-read-aloud-enabled"], true);
    assert.equal(settings["codex-linux-read-aloud-kokoro-speed"], 1.15);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("migrates already-patched Linux settings persistence away from codex-desktop", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-migrate-"));
  try {
    const xdgConfig = path.join(tempRoot, "xdg-config");
    const patched = applyPatchTwice(applyLinuxSettingsPersistencePatch, legacySettingsPersistenceBundleFixture());

    assert.match(patched, /process\.env\.CODEX_LINUX_SETTINGS_FILE/);
    assert.doesNotMatch(patched, /join\(e,`codex-desktop`,`settings\.json`\)/);
    runSettingsPersistence(
      patched,
      {
        CODEX_LINUX_APP_ID: "codex-cua-lab",
        XDG_CONFIG_HOME: xdgConfig,
      },
      "codex-linux-prompt-window-enabled",
      false,
    );

    assert.equal(
      JSON.parse(fs.readFileSync(path.join(xdgConfig, "codex-cua-lab", "settings.json"), "utf8"))["codex-linux-prompt-window-enabled"],
      false,
    );
    runSettingsPersistence(
      patched,
      {
        CODEX_LINUX_APP_ID: "codex-cua-lab",
        XDG_CONFIG_HOME: xdgConfig,
      },
      "codex-linux-read-aloud-enabled",
      true,
    );

    assert.equal(
      JSON.parse(fs.readFileSync(path.join(xdgConfig, "codex-cua-lab", "settings.json"), "utf8"))["codex-linux-read-aloud-enabled"],
      true,
    );
    assert.equal(fs.existsSync(path.join(xdgConfig, "codex-desktop", "settings.json")), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("adds Linux settings persistence after current global-state handler drift", () => {
  const patched = applyPatchTwice(
    applyLinuxSettingsPersistencePatch,
    currentSettingsPersistenceBundleFixture(),
  );

  assert.match(patched, /function codexLinuxSettingsAppId\(\)/);
  assert.match(patched, /var c=`config\.toml`;/);
  assert.match(
    patched,
    /"set-global-state":async\(\{key:a,value:b,origin:c\}\)=>\(this\.setGlobalStateValue\(a,b,c\),codexLinuxPersistSettingsState\(a,b\),\{success:!0\}\)/,
  );
});

test("adds Linux settings persistence when upstream removed the state-file marker", () => {
  const source = [
    "\"use strict\";",
    "let i=require(`node:path`),o=require(`node:fs`);",
    "const h={\"set-global-state\":async({key:a,value:b,origin:c})=>(this.setGlobalStateValue(a,b,c),{success:!0})};",
  ].join("");

  const patched = applyPatchTwice(applyLinuxSettingsPersistencePatch, source);

  assert.match(patched, /^"use strict";function codexLinuxSettingsAppId\(\)/);
  assert.match(
    patched,
    /"set-global-state":async\(\{key:a,value:b,origin:c\}\)=>\(this\.setGlobalStateValue\(a,b,c\),codexLinuxPersistSettingsState\(a,b\),\{success:!0\}\)/,
  );
});

test("adds Linux launch actions through current setSecondInstanceArgsHandler bundles", () => {
  const launchPatched = applyPatchTwice(
    applyLinuxLaunchActionArgsPatch,
    currentLaunchActionBundleFixture(),
  );
  const prewarmPatched = applyPatchTwice(applyLinuxHotkeyWindowPrewarmPatch, launchPatched);

  assert.match(launchPatched, /codexLinuxGetSetting=e=>process\.platform!==`linux`\|\|j\.globalState\.get\(e\)!==!1/);
  assert.match(launchPatched, /codexLinuxStartLaunchActionSocket=\(\)=>/);
  assert.match(launchPatched, /codexLinuxDefaultLaunchActionSocket=\(\)=>/);
  assert.match(launchPatched, /process\.env\.CODEX_DESKTOP_LAUNCH_ACTION_SOCKET\?\.trim\(\)\|\|codexLinuxDefaultLaunchActionSocket\(\)/);
  assert.match(launchPatched, /process\.env\.CODEX_LINUX_INSTANCE_ID\?\.trim\(\)/);
  assert.match(launchPatched, /let n=require\(`node:path`\),r=require\(`node:fs`\),i=require\(`node:net`\);r\.mkdirSync\(n\.dirname\(e\)/);
  assert.match(launchPatched, /let a=i\.createServer/);
  assert.doesNotMatch(launchPatched, /f\.default\.createServer/);
  assert.doesNotMatch(launchPatched, /o\.mkdirSync\(i\.default\.dirname\(e\)/);
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

test("uses collision-safe modules for launch-action socket in shadowed startup scopes", () => {
  const source = currentLaunchActionBundleFixture().replace(
    "async function CN(){let{setSecondInstanceArgsHandler:l}=t.y(),g={reportNonFatal(){}}",
    "async function CN(){let{desktopSentry:o,setSecondInstanceArgsHandler:l}=t.y(),f=n.O.allowDebugMenu(),g={reportNonFatal(){}}",
  );

  const patched = applyPatchTwice(applyLinuxLaunchActionArgsPatch, source);

  assert.match(patched, /codexLinuxStartLaunchActionSocket=\(\)=>\{if\(process\.platform!==`linux`\)return;try\{/);
  assert.match(patched, /let n=require\(`node:path`\),r=require\(`node:fs`\),i=require\(`node:net`\);r\.mkdirSync\(n\.dirname\(e\)/);
  assert.match(patched, /let a=i\.createServer/);
  assert.match(patched, /t\.on\(`error`,e=>\{g\.reportNonFatal\(e instanceof Error\?e:`Failed Linux launch action socket client`,\{kind:`linux-launch-action-socket-client-error`\}\)\}\)/);
  assert.doesNotMatch(patched, /o\.mkdirSync/);
  assert.doesNotMatch(patched, /f\.default\.createServer/);
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
  assert.match(patched, /codexLinuxDefaultLaunchActionSocket=\(\)=>/);
  assert.match(patched, /codexLinuxPrewarmHotkeyWindow=\(\)=>/);
  assert.match(patched, /e\.includes\(`--new-chat`\)/);
  assert.match(patched, /e\.includes\(`--quick-chat`\)/);
  assert.match(patched, /e\.includes\(`--prompt-chat`\)/);
  assert.match(patched, /e\.includes\(`--hotkey-window`\)/);
});

test("adds Linux launch actions after current window API drift", () => {
  const source = currentLaunchActionBundleFixture()
    .replaceAll("createFreshLocalWindow", "createFreshWindow");

  const patched = applyPatchTwice(applyLinuxLaunchActionArgsPatch, source);

  assert.match(patched, /codexLinuxHandleLaunchActionArgs/);
  assert.match(patched, /let n=M\.getPrimaryWindow\(B\),r=n\?\?await M\.createFreshWindow\(e\);/);
  assert.match(patched, /let e=M\.getPrimaryWindow\(B\),t=e\?\?await M\.createFreshWindow\(`/);
});

test("adds Linux launch actions when current upstream wraps fresh window creation", () => {
  const source = currentLaunchActionBundleFixture()
    .replaceAll("createFreshLocalWindow", "createFreshWindow")
    .replace(
      "let A=Date.now(),w=()=>{}",
      "let enabled=!0,ee=e=>enabled?M.createFreshWindow(e):Promise.resolve(null),A=Date.now(),w=()=>{}",
    )
    .replace("M.getPrimaryWindow()??await M.createFreshWindow(`/`)", "M.getPrimaryWindow()??await ee(`/`)")
    .replace("r=n??await M.createFreshWindow(e)", "r=n??await ee(e)");

  const patched = applyPatchTwice(applyLinuxLaunchActionArgsPatch, source);

  assert.match(patched, /codexLinuxHandleLaunchActionArgs/);
  assert.match(patched, /let n=M\.getPrimaryWindow\(B\),r=n\?\?await ee\(e\);/);
  assert.match(patched, /let e=M\.getPrimaryWindow\(B\),t=e\?\?await ee\(`\/`\);/);
});

test("prewarms the hotkey window after startup marker drift", () => {
  const launchPatched = applyPatchTwice(
    applyLinuxLaunchActionArgsPatch,
    currentLaunchActionBundleFixture()
      .replaceAll("createFreshLocalWindow", "createFreshWindow")
      .replace(
        "let be=await M.ensureHostWindow(B);be&&ae(be),w(`local window ensured`,A,{hostId:B,localWindowVisible:be?.isVisible()??!1}),A=Date.now(),await z.deepLinks.flushPendingDeepLinks();",
        "let be=await M.ensureHostWindow(B);be&&ae(be),w(`window ensured`,A,{windowVisible:be?.isVisible()??!1}),A=Date.now(),await z.deepLinks.flushPendingDeepLinks();",
      ),
  );

  const prewarmPatched = applyPatchTwice(applyLinuxHotkeyWindowPrewarmPatch, launchPatched);

  assert.match(
    prewarmPatched,
    /w\(`window ensured`,A,\{windowVisible:be\?\.isVisible\(\)\?\?!1\}\),process\.platform===`linux`&&codexLinuxPrewarmHotkeyWindow\(\),A=Date\.now\(\),await z\.deepLinks\.flushPendingDeepLinks\(\)/,
  );
});

test("gates ready-to-show maximize behind restored maximized state", () => {
  const source = [
    "let E=x?.isMaximized===!0,D={once(){},isDestroyed(){return false},maximize(){},setIcon(){}};",
    "E&&process.platform===`linux`&&D.setIcon(process.resourcesPath+`/../content/webview/assets/app-test.png`),",
    "D.once(`ready-to-show`,()=>{D.isDestroyed()||D.maximize()});",
  ].join("");

  const patched = applyPatchTwice(applyLinuxReadyToShowWindowStatePatch, source);

  assert.match(
    patched,
    /E&&D\.once\(`ready-to-show`,\(\)=>\{D\.isDestroyed\(\)\|\|D\.maximize\(\)\}\);/,
  );
  assert.doesNotMatch(
    patched,
    /(^|[^&])D\.once\(`ready-to-show`,\(\)=>\{D\.isDestroyed\(\)\|\|D\.maximize\(\)\}\);/,
  );
});

test("installs Linux resize repaint hook without ungating ready-to-show maximize", () => {
  const source = [
    "let E=x?.isMaximized===!0,D={handlers:{},once(){},on(e,t){this.handlers[e]=t},isDestroyed(){return false},maximize(){},webContents:{isDestroyed(){return false},invalidate(){globalThis.__resizeRepaintCalls++}}},F={once(){},on(){},isDestroyed(){return false},webContents:{invalidate(){}}};",
    "E&&D.once(`ready-to-show`,()=>{D.isDestroyed()||D.maximize()});",
    "F.once(`ready-to-show`,()=>{});",
    "globalThis.__resizeRepaintWindow=D;",
  ].join("");

  const patched = applyPatchTwice(
    applyLinuxResizeRepaintPatch,
    applyLinuxReadyToShowWindowStatePatch(source),
  );

  assert.match(patched, /function codexLinuxInstallResizeRepaintHook\(e\)/);
  assert.match(
    patched,
    /process\.platform===`linux`&&codexLinuxInstallResizeRepaintHook\(D\),E&&D\.once\(`ready-to-show`,\(\)=>\{D\.isDestroyed\(\)\|\|D\.maximize\(\)\}\);/,
  );
  assert.match(
    patched,
    /process\.platform===`linux`&&codexLinuxInstallResizeRepaintHook\(F\),F\.once\(`ready-to-show`,\(\)=>\{\}\);/,
  );
  assert.match(
    patched,
    /setTimeout\(\(\)=>\{if\(__codexResizeRepaintScheduled=!1,e\.isDestroyed\(\)\)return;let __codexWebContents=e\.webContents;__codexWebContents==null\|\|__codexWebContents\.isDestroyed\?\.\(\)\|\|typeof __codexWebContents\.invalidate==`function`&&__codexWebContents\.invalidate\(\)\},16\)/,
  );

  const context = {
    __resizeRepaintCalls: 0,
    process: { platform: "linux" },
    setTimeout(callback) {
      callback();
    },
    x: { isMaximized: true },
  };
  context.globalThis = context;
  vm.runInNewContext(
    `${patched};codexLinuxInstallResizeRepaintHook(globalThis.__resizeRepaintWindow);globalThis.__resizeRepaintWindow.handlers.resize();`,
    context,
  );
  assert.equal(context.__resizeRepaintCalls, 1);
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

test("registers bundled Computer Use on Linux while preserving the macOS rollout", () => {
  const patched = applyPatchTwice(
    applyLinuxComputerUsePluginGatePatch,
    computerUseGateBundleFixture(),
  );

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:tn,isEnabled:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse/,
  );
  assert.doesNotMatch(patched, /=>t===`darwin`&&e\.computerUse/);
});

test("returns Linux native desktop apps from the Computer Use backend", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-native-apps-"));
  try {
    const backendPath = path.join(tempRoot, "codex-computer-use-linux");
    const dataHome = path.join(tempRoot, "share");
    const desktopDir = path.join(dataHome, "applications");
    const iconDir = path.join(dataHome, "icons", "hicolor", "scalable", "apps");
    const desktopPath = path.join(desktopDir, "org.example.Terminal.desktop");
    const iconPath = path.join(iconDir, "example-terminal.svg");
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
    fs.writeFileSync(
      desktopPath,
      [
        "[Desktop Entry]",
        "Name=Example Terminal",
        "Exec=example-terminal",
        "Icon=example-terminal",
        "StartupWMClass=ExampleTerminal",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(iconPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    fs.writeFileSync(
      backendPath,
      [
        "#!/usr/bin/env node",
        "if (process.argv[2] === 'windows') {",
        "  console.log(JSON.stringify({ backend: 'test', windows: [{",
        "    app_id: 'org.example.Terminal',",
        "    wm_class: 'ExampleTerminal',",
        "    title: 'Project - Example Terminal',",
        "    pid: 123,",
        "    window_id: 77,",
        "    focused: true,",
        "    client_type: 'wayland',",
        "    backend: 'test'",
        "  }] }));",
        "} else {",
        "  console.log(JSON.stringify({}));",
        "}",
        "",
      ].join("\n"),
    );
    fs.chmodSync(backendPath, 0o755);

    const source = [
      "\"use strict\";",
      "let cp=require(`node:child_process`),fs=require(`node:fs`),p=require(`node:path`),os=require(`node:os`);",
      "var h={handlers:{\"computer-use-native-desktop-app-icon\":async()=>({iconSmall:`mac-icon`}),\"native-desktop-apps\":async()=>({apps:[{bundleId:`mac`,appPath:`/Applications/Mac.app`,displayName:`Mac App`}]})}};",
    ].join("");
    const patched = applyPatchTwice(applyLinuxNativeDesktopAppsHandlerPatch, source);
    const sandbox = {
      Buffer,
      require,
      console,
      process: {
        env: {
          CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE: backendPath,
          HOME: tempRoot,
          PATH: process.env.PATH,
          XDG_DATA_HOME: dataHome,
          XDG_DATA_DIRS: "",
        },
        platform: "linux",
        resourcesPath: path.join(tempRoot, "missing-resources"),
      },
    };

    const result = await vm.runInNewContext(
      `(async()=>{${patched};return h.handlers["native-desktop-apps"]({params:{order:"usage"}})})()`,
      sandbox,
    );
    assert.equal(result.apps.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(result.apps[0])), {
      appPath: desktopPath,
      backend: "test",
      bundleId: "org.example.Terminal",
      clientType: "wayland",
      description: "Window: Project - Example Terminal",
      displayName: "Example Terminal",
      focused: true,
      iconSmall: "",
      linuxAppId: "org.example.Terminal",
      pid: 123,
      windowId: 77,
      wmClass: "ExampleTerminal",
    });

    const icon = await vm.runInNewContext(
      `(async()=>{${patched};return h.handlers["computer-use-native-desktop-app-icon"]({params:{appPath:${JSON.stringify(desktopPath)}}})})()`,
      sandbox,
    );
    assert.match(icon.iconSmall, /^data:image\/svg\+xml;base64,/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not resolve the native desktop apps backend from relative PATH entries", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-native-apps-path-"));
  const originalCwd = process.cwd();
  try {
    const relativeBin = path.join(tempRoot, "relative-bin");
    const backendPath = path.join(relativeBin, "codex-computer-use-linux");
    const markerPath = path.join(tempRoot, "backend-ran");
    fs.mkdirSync(relativeBin, { recursive: true });
    fs.writeFileSync(
      backendPath,
      [
        "#!/bin/sh",
        `touch ${JSON.stringify(markerPath)}`,
        "printf '%s\\n' '{\"windows\":[{\"app_id\":\"relative.backend\",\"focused\":true}]}'",
        "",
      ].join("\n"),
    );
    fs.chmodSync(backendPath, 0o755);
    process.chdir(tempRoot);

    const source = [
      "\"use strict\";",
      "let cp=require(`node:child_process`),fs=require(`node:fs`),p=require(`node:path`),os=require(`node:os`);",
      "var h={handlers:{\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = applyPatchTwice(applyLinuxNativeDesktopAppsHandlerPatch, source);
    const result = await vm.runInNewContext(
      `(async()=>{${patched};return h.handlers["native-desktop-apps"]({params:{}})})()`,
      {
        Buffer,
        require,
        console,
        process: {
          env: {
            HOME: tempRoot,
            PATH: `relative-bin:/usr/bin:/bin`,
            XDG_DATA_HOME: path.join(tempRoot, "share"),
            XDG_DATA_DIRS: "",
          },
          platform: "linux",
          resourcesPath: path.join(tempRoot, "missing-resources"),
        },
      },
    );

    assert.deepEqual(JSON.parse(JSON.stringify(result)), { apps: [] });
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("keeps native desktop apps delegated to upstream outside Linux", async () => {
  const source = [
    "\"use strict\";",
    "let cp=require(`node:child_process`),fs=require(`node:fs`),p=require(`node:path`),os=require(`node:os`);",
    "var h={handlers:{\"native-desktop-apps\":async()=>({apps:[{bundleId:`mac`,appPath:`/Applications/Mac.app`,displayName:`Mac App`}]})}};",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeDesktopAppsHandlerPatch, source);
  const result = await vm.runInNewContext(
    `(async()=>{${patched};return h.handlers["native-desktop-apps"]({params:{}})})()`,
    {
      Buffer,
      require,
      console,
      process: { env: {}, platform: "darwin", resourcesPath: "/Applications/Codex.app/Contents/Resources" },
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    apps: [{ appPath: "/Applications/Mac.app", bundleId: "mac", displayName: "Mac App" }],
  });
});

test("inserts native desktop app icon handler before a final native apps handler", async () => {
  const source = [
    "\"use strict\";",
    "let cp=require(`node:child_process`),fs=require(`node:fs`),p=require(`node:path`),os=require(`node:os`);",
    "var h={handlers:{\"native-desktop-apps\":async(e)=>{return {apps:[{bundleId:`mac`,appPath:`/Applications/Mac.app`,displayName:`Mac App`,order:e?.params?.order??null}]}}}};",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeDesktopAppsHandlerPatch, source);

  assert.equal((patched.match(/"computer-use-native-desktop-app-icon"/g) ?? []).length, 1);
  assert.ok(
    patched.indexOf("\"computer-use-native-desktop-app-icon\"") <
      patched.indexOf("\"native-desktop-apps\""),
  );

  const darwinResult = await vm.runInNewContext(
    `(async()=>{${patched};return h.handlers["native-desktop-apps"]({params:{order:"usage"}})})()`,
    {
      Buffer,
      require,
      console,
      process: { env: {}, platform: "darwin", resourcesPath: "/Applications/Codex.app/Contents/Resources" },
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(darwinResult)), {
    apps: [
      {
        appPath: "/Applications/Mac.app",
        bundleId: "mac",
        displayName: "Mac App",
        order: "usage",
      },
    ],
  });

  const linuxIcon = await vm.runInNewContext(
    `(async()=>{${patched};return h.handlers["computer-use-native-desktop-app-icon"]({params:{appPath:"/tmp/missing.desktop"}})})()`,
    {
      Buffer,
      require,
      console,
      process: {
        env: { HOME: os.tmpdir(), PATH: process.env.PATH, XDG_DATA_DIRS: "" },
        platform: "linux",
        resourcesPath: "/missing-resources",
      },
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(linuxIcon)), { iconSmall: "" });
});

test("adds Linux desktop settings route when upstream owns Keyboard Shortcuts", () => {
  const patched = applyPatchTwice(
    applyLinuxDesktopSettingsIndexPatch,
    keybindsIndexBundleFixture(),
  );

  assert.match(
    patched,
    /var i_e=\{"linux-desktop":Z\(async\(\)=>\(await s\(async\(\)=>\{let\{LinuxDesktopSettings:e\}=await import\(`\.\/linux-desktop-settings-linux\.js`\)/,
  );
  assert.match(patched, /var Kge=\{"linux-desktop":xh,"general-settings":xh,/);
  assert.match(patched, /qge=\[`general-settings`,`linux-desktop`,`appearance`/);
  assert.match(patched, /slugs:\[`general-settings`,`linux-desktop`,`appearance`/);
  assert.match(patched, /case`linux-desktop`:return l===`electron`/);
  assert.match(patched, /case`linux-desktop`:k=!1;break bb0;/);
  assert.doesNotMatch(patched, /codexLinuxKeybindOverridesRuntime/);
});

test("adds physical-key fallback for current native shortcut runtime", () => {
  const source = [
    "function Ie({altKey:e,code:t,key:n}){return!e||t==null?n:Be?.[t]??Re(t)??n}",
    "function Re(e){return/^Key[A-Z]$/.test(e)?e.slice(3).toLowerCase():/^Digit[0-9]$/.test(e)?e.slice(5):ze.get(e)??null}",
    "var ze=new Map([[`BracketLeft`,`[`],[`Slash`,`/`]]),Be=null;",
  ].join("");
  const patched = applyPatchTwice(applyLinuxShortcutPhysicalKeyFallbackPatch, source);

  const sandbox = {};
  vm.runInNewContext(
    `${patched};this.press=(event)=>Ie(event);`,
    sandbox,
  );

  assert.equal(sandbox.press({ ctrlKey: true, code: "KeyK", key: "л", altKey: false, metaKey: false }), "k");
  assert.equal(sandbox.press({ ctrlKey: true, code: "Digit5", key: "(", altKey: false, metaKey: false }), "5");
  assert.equal(sandbox.press({ ctrlKey: true, code: "BracketLeft", key: "х", altKey: false, metaKey: false }), "[");
  assert.equal(sandbox.press({ ctrlKey: false, code: "KeyK", key: "л", altKey: false, metaKey: false }), "л");
  assert.equal(
    sandbox.press({
      ctrlKey: true,
      altKey: true,
      code: "KeyQ",
      key: "@",
      metaKey: false,
      getModifierState: (name) => name === "AltGraph",
    }),
    "@",
  );
});

test("patches physical-key fallback through native Keyboard Shortcuts asset scan", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  const shortcutRuntimeAsset = path.join(assetsDir, "app-initial~app-main~keyboard-shortcuts-runtime-A.js");
  try {
    fs.writeFileSync(
      shortcutRuntimeAsset,
      [
        "function Ie({altKey:e,code:t,key:n}){return!e||t==null?n:Be?.[t]??Re(t)??n}",
        "function Re(e){return/^Key[A-Z]$/.test(e)?e.slice(3).toLowerCase():/^Digit[0-9]$/.test(e)?e.slice(5):ze.get(e)??null}",
        "var ze=new Map([[`BracketLeft`,`[`],[`Slash`,`/`]]),Be=null;",
      ].join(""),
      "utf8",
    );

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);

    const patchedSource = fs.readFileSync(shortcutRuntimeAsset, "utf8");
    assert.match(patchedSource, /codexLinuxShortcutPhysicalKeyFallbackEvent/);

    const sandbox = {};
    vm.runInNewContext(
      `${patchedSource};this.press=(event)=>Ie(event);`,
      sandbox,
    );
    assert.equal(sandbox.press({ metaKey: true, code: "KeyB", key: "и", altKey: false, ctrlKey: false }), "b");
    assert.equal(sandbox.press({ shiftKey: true, code: "KeyB", key: "И", altKey: false, ctrlKey: false, metaKey: false }), "И");

    const secondResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(secondResult.matched, true);
    assert.equal(secondResult.changed, 0);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

function runLinuxKeybindRuntimeEvent(eventInit) {
  const dispatched = [];
  const listeners = {};
  const Element = class {
    closest() {
      return null;
    }
  };
  const target = new Element();
  const event = {
    altKey: false,
    code: "",
    ctrlKey: false,
    defaultPrevented: false,
    key: "",
    metaKey: false,
    repeat: false,
    shiftKey: false,
    target,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...eventInit,
  };
  const patched = applyPatchTwice(
    applyLinuxKeybindOverridesRuntimePatch,
    "var Ct={openCommandMenu:`CmdOrCtrl+K`,settings:`CmdOrCtrl+,`,copySessionId:`CmdOrCtrl+Alt+C`};",
  );

  vm.runInNewContext(patched, {
    Element,
    navigator: { platform: "Linux x86_64" },
    localStorage: {
      getItem() {
        return "{}";
      },
    },
    window: {
      addEventListener(type, listener) {
        listeners[type] = listener;
      },
    },
    E: {
      dispatchHostMessage(message) {
        dispatched.push(message);
        return true;
      },
      dispatchMessage(type, params) {
        dispatched.push({ type, params });
        return true;
      },
    },
  });

  listeners.keydown(event);
  return { dispatched, event };
}

test("Linux keybind runtime falls back to physical Latin key codes for defaults", () => {
  const { dispatched, event } = runLinuxKeybindRuntimeEvent({
    code: "KeyK",
    ctrlKey: true,
    key: "л",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), [{ type: "command-menu", query: "" }]);
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopped, true);
});

test("Linux keybind runtime leaves logical default shortcuts to upstream", () => {
  const { dispatched, event } = runLinuxKeybindRuntimeEvent({
    code: "KeyK",
    ctrlKey: true,
    key: "k",
  });

  assert.deepEqual(dispatched, []);
  assert.equal(event.defaultPrevented, false);
});

test("Linux keybind runtime maps physical punctuation codes for defaults", () => {
  const { dispatched, event } = runLinuxKeybindRuntimeEvent({
    code: "Comma",
    ctrlKey: true,
    key: "б",
  });

  assert.deepEqual(JSON.parse(JSON.stringify(dispatched)), [
    { type: "show-settings", params: { section: "general-settings" } },
  ]);
  assert.equal(event.defaultPrevented, true);
});

test("Linux keybind runtime leaves AltGraph chords to text input", () => {
  const { dispatched, event } = runLinuxKeybindRuntimeEvent({
    altKey: true,
    code: "KeyC",
    ctrlKey: true,
    getModifierState: (name) => name === "AltGraph",
    key: "©",
  });

  assert.deepEqual(dispatched, []);
  assert.equal(event.defaultPrevented, false);
});

test("finds a unique current Codex request API asset outside legacy vscode-api chunks", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-request-api-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  try {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(assetsDir, "app-initial~settings-page-A.js"),
      'function requestCodex(...args){let[request]=args,{params:params,select:select,signal:signal,source:source}=request??{};return rawCodex("method",params,select,signal,source)}async function rawCodex(method,params,select,signal,source){return transport.post(`vscode://codex/${method}`,params,source,signal)}export{requestCodex as R};',
      "utf8",
    );

    assert.deepEqual(findCodexRequestWebviewAsset(assetsDir), {
      assetName: "app-initial~settings-page-A.js",
      exportName: "R",
    });
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("fails loudly when current Codex request API asset detection is ambiguous", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-request-api-ambiguous-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const requestSource =
    'function requestCodex(...args){let[request]=args,{params:params,select:select,signal:signal,source:source}=request??{};return rawCodex("method",params,select,signal,source)}async function rawCodex(method,params,select,signal,source){return transport.post(`vscode://codex/${method}`,params,source,signal)}export{requestCodex as R};';
  try {
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "app-a.js"), requestSource, "utf8");
    fs.writeFileSync(path.join(assetsDir, "app-b.js"), requestSource, "utf8");

    assert.throws(
      () => findCodexRequestWebviewAsset(assetsDir),
      /Found multiple Codex request API assets \(app-a\.js, app-b\.js\)/,
    );
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("renders the generated Linux desktop settings page with working switches", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    const result = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(result.matched, true);

    class Component {
      constructor(props) {
        this.props = props;
        this.state = {};
      }

      setState(next) {
        const update = typeof next === "function" ? next(this.state, this.props) : next;
        this.state = { ...this.state, ...update };
      }
    }

    const jsxRuntime = {
      jsx: (type, props = {}) => ({ type, props }),
      jsxs: (type, props = {}) => ({ type, props }),
    };
    const React = { Component, Fragment: "fragment" };
    const routeSettingsSource = fs.readFileSync(
      path.join(assetsDir, "settings-page-A.js"),
      "utf8",
    );
    assert.match(
      routeSettingsSource,
      /RouteReact as codexLinuxReact,RouteJsx as codexLinuxJsx/,
    );
    assert.doesNotMatch(
      routeSettingsSource,
      /DecoyReact as codexLinuxReact|DecoyJsx as codexLinuxJsx/,
    );
    const nativeRuntime = { React, $: jsxRuntime };
    assert.equal(nativeRuntime.React, React);
    assert.equal(nativeRuntime.$, jsxRuntime);
    const Toggle = evaluateGeneratedSettingsModule(
      fs.readFileSync(path.join(assetsDir, "linux-settings-toggle-linux.js"), "utf8"),
      { $: nativeRuntime.$ },
      "t",
    );
    const SettingsPage = ({ title, subtitle, children }) =>
      jsxRuntime.jsxs("main", { children: [title, subtitle, children] });
    const SettingsRow = ({ label, description, control }) =>
      jsxRuntime.jsxs("div", { children: [label, description, control] });
    const SettingsSection = ({ children }) => jsxRuntime.jsx("section", { children });
    SettingsSection.Header = ({ title }) => jsxRuntime.jsx("h3", { children: title });
    SettingsSection.Content = ({ children }) => jsxRuntime.jsx("div", { children });
    const SettingsGroup = ({ children }) => jsxRuntime.jsx("div", { children });
    const LinuxDesktopSettings = evaluateGeneratedSettingsModule(
      fs.readFileSync(path.join(assetsDir, linuxDesktopSettingsAsset), "utf8"),
      {
        $: nativeRuntime.$,
        React: nativeRuntime.React,
        SettingsGroup,
        SettingsPage,
        SettingsRow,
        SettingsSection,
        Toggle,
        __post: () => Promise.resolve({}),
      },
      "LinuxDesktopSettings",
    );

    const rendered = renderGeneratedSettingsTree(LinuxDesktopSettings({}), Component);
    const text = rendered.filter((value) => typeof value === "string");
    assert.ok(text.includes("Linux desktop"));
    assert.ok(text.includes("Compact prompt window"));
    assert.ok(text.includes("System tray"));
    assert.ok(text.includes("Warm start"));
    assert.ok(text.includes("Install updates when you close ChatGPT"));

    const switches = rendered.filter(
      (value) => typeof value === "object" && value.type === "button" && value.props.role === "switch",
    );
    assert.equal(switches.length, 4);
    assert.deepEqual(
      switches.map((element) => element.props["aria-label"]),
      [
        "Compact prompt window",
        "System tray",
        "Warm start",
        "Install updates when you close ChatGPT",
      ],
    );

    let changedTo = null;
    const interactiveSwitch = Toggle({
      checked: false,
      disabled: false,
      onChange: (value) => {
        changedTo = value;
      },
      ariaLabel: "Test setting",
    });
    interactiveSwitch.props.onClick();
    assert.equal(changedTo, true);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("skips old Keybinds settings generation when native Keyboard Shortcuts are missing", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    fs.rmSync(path.join(assetsDir, "keyboard-shortcuts-settings-A.js"));

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, false);
    assert.match(result.reason, /current upstream Keyboard Shortcuts settings route is missing/);
    assert.ok(warnings.some((warning) => warning.includes("current upstream Keyboard Shortcuts settings route is missing")));
    assert.equal(fs.existsSync(path.join(assetsDir, keybindsSettingsAsset)), false);
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), false);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("skips Linux settings without writing assets when the active route runtime cannot be inferred", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    const nativeSettingsPath = path.join(assetsDir, "settings-page-A.js");
    const nativeSettingsSource = fs.readFileSync(nativeSettingsPath, "utf8").replace(
      "(0,RouteReact.useState)(null)",
      "RouteReact.useState(null)",
    );
    fs.writeFileSync(nativeSettingsPath, nativeSettingsSource, "utf8");
    const assetsBefore = new Map(
      fs.readdirSync(assetsDir).map((name) => [
        name,
        fs.readFileSync(path.join(assetsDir, name), "utf8"),
      ]),
    );

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, false);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /could not infer the active React runtime/);
    assert.ok(warnings.some((warning) => warning.includes("could not infer the active React runtime")));
    assert.deepEqual(
      new Map(
        fs.readdirSync(assetsDir).map((name) => [
          name,
          fs.readFileSync(path.join(assetsDir, name), "utf8"),
        ]),
      ),
      assetsBefore,
    );
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), false);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-toggle-linux.js")), false);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(extractedDir, { report }));
    const reportEntry = report.patches.find((patch) => patch.name === "keybinds-settings");
    assert.equal(reportEntry.status, "skipped-optional");
    assert.equal(reportEntry.ciPolicy, "optional");
    assert.match(reportEntry.reason, /could not infer the active React runtime/);
    assert.ok(
      optionalDriftFromReport(report).some((drift) => drift.name === "keybinds-settings"),
    );
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("writes only missing Linux settings fallback components after required checks pass", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    fs.rmSync(path.join(assetsDir, "settings-row-A.js"));
    fs.rmSync(path.join(assetsDir, "settings-content-layout-A.js"));

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-row-linux.js")), true);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-page-linux.js")), true);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-section-linux.js")), false);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-group-linux.js")), false);
    assert.match(
      fs.readFileSync(path.join(assetsDir, linuxDesktopSettingsAsset), "utf8"),
      /import\{n as SettingsRow\}from"\.\/linux-settings-row-linux\.js\?v=[a-f0-9]{12}"/,
    );

    const settingsPageSource = fs.readFileSync(
      path.join(assetsDir, "linux-settings-page-linux.js"),
      "utf8",
    );
    assert.match(settingsPageSource, /h-full min-h-0 w-full overflow-y-auto/);
    assert.match(settingsPageSource, /mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6/);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("uses a themed fallback toggle when upstream settings toggle is unavailable", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    fs.rmSync(path.join(assetsDir, "toggle-A.js"));

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-toggle-linux.js")), true);

    const linuxDesktopSource = fs.readFileSync(
      path.join(assetsDir, linuxDesktopSettingsAsset),
      "utf8",
    );
    assert.match(linuxDesktopSource, /import\{t as Toggle\}from"\.\/linux-settings-toggle-linux\.js\?v=[a-f0-9]{12}"/);
    assert.match(
      linuxDesktopSource,
      /control:\$\.jsx\(Toggle,\{checked:value,disabled:isLoading,onChange:this\.update,ariaLabel:label\}\)/,
    );
    assert.doesNotMatch(linuxDesktopSource, /function LinuxSwitch/);
    assert.doesNotMatch(linuxDesktopSource, /bg-token-text-primary/);
    assert.doesNotMatch(linuxDesktopSource, /translate-x-4/);

    const toggleSource = fs.readFileSync(
      path.join(assetsDir, "linux-settings-toggle-linux.js"),
      "utf8",
    );
    assert.match(toggleSource, /--color-token-radio-active-foreground/);
    assert.match(toggleSource, /width:"32px"/);
    assert.match(toggleSource, /height:"20px"/);
    assert.match(toggleSource, /translateX\(12px\)/);

    const secondResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(secondResult.matched, true);
    assert.equal(secondResult.changed, 0);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("ignores settings row and toggle icon decoys from the current DMG", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    fs.rmSync(path.join(assetsDir, "settings-row-A.js"));
    fs.rmSync(path.join(assetsDir, "toggle-A.js"));
    fs.writeFileSync(
      path.join(assetsDir, "settings-row-disclosure-A.js"),
      "function a(e){let{children:n,content:r,contentId:i,expanded:o}=e;return null}function c(){}export{c as n,a as t};",
      "utf8",
    );
    fs.writeFileSync(
      path.join(assetsDir, "toggle-left-A.js"),
      "function createIcon(e,t){return{e,t}}var r=createIcon(`ToggleLeft`,[[`rect`,{width:`20`,height:`12`}]]);function i(){}export{i as n,r as t};",
      "utf8",
    );

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-row-linux.js")), true);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-toggle-linux.js")), true);

    const linuxDesktopSource = fs.readFileSync(
      path.join(assetsDir, linuxDesktopSettingsAsset),
      "utf8",
    );
    assert.match(
      linuxDesktopSource,
      /import\{n as SettingsRow\}from"\.\/linux-settings-row-linux\.js\?v=[a-f0-9]{12}"/,
    );
    assert.match(
      linuxDesktopSource,
      /import\{t as Toggle\}from"\.\/linux-settings-toggle-linux\.js\?v=[a-f0-9]{12}"/,
    );
    assert.doesNotMatch(linuxDesktopSource, /settings-row-disclosure-A\.js/);
    assert.doesNotMatch(linuxDesktopSource, /toggle-left-A\.js/);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("does not import an upstream settings toggle with private lazy initialization", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    fs.rmSync(path.join(assetsDir, "toggle-A.js"));
    fs.writeFileSync(path.join(assetsDir, "shared-toggle-A.js"), "function vn(){}export{vn};", "utf8");
    fs.writeFileSync(
      path.join(assetsDir, "general-settings-A.js"),
      'import{vn as Fe}from"./shared-toggle-A.js";function GeneralSettings(){return (0,Y.jsx)(W,{label:"Default permissions",description:"",control:(0,Y.jsx)(Fe,{checked:!0,disabled:!0,onChange:e=>{save(e)},ariaLabel:"Default permissions"})})}export{GeneralSettings};',
      "utf8",
    );

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-toggle-linux.js")), true);

    const linuxDesktopSource = fs.readFileSync(
      path.join(assetsDir, linuxDesktopSettingsAsset),
      "utf8",
    );
    assert.match(
      linuxDesktopSource,
      /import\{t as Toggle\}from"\.\/linux-settings-toggle-linux\.js\?v=[a-f0-9]{12}"/,
    );
    assert.doesNotMatch(linuxDesktopSource, /shared-toggle-A\.js/);
    assert.match(
      linuxDesktopSource,
      /control:\$\.jsx\(Toggle,\{checked:value,disabled:isLoading,onChange:this\.update,ariaLabel:label\}\)/,
    );
    assert.doesNotMatch(linuxDesktopSource, /function LinuxSwitch/);
    assert.doesNotMatch(linuxDesktopSource, /bg-token-text-primary/);
    assert.doesNotMatch(linuxDesktopSource, /translate-x-4/);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("does not leave generated Linux settings fallbacks when later current-DMG route checks fail", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    fs.rmSync(path.join(assetsDir, "settings-row-A.js"));
    fs.writeFileSync(
      path.join(assetsDir, "settings-page-A.js"),
      "settings.nav.keyboard-shortcuts;var icons={\"general-settings\":wt,\"keyboard-shortcuts\":xn};",
      "utf8",
    );

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, false);
    assert.match(result.reason, /could not find Linux desktop settings route bundle/);
    assert.ok(warnings.some((warning) => warning.includes("could not find Linux desktop settings route bundle")));
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), false);
    assert.equal(fs.existsSync(path.join(assetsDir, "linux-settings-row-linux.js")), false);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("adds Linux desktop settings when native shortcuts use a consolidated settings bundle", () => {
  const { extractedDir, assetsDir } = createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.ok(result.changed >= 2);
    assert.match(result.reason, /upstream keyboard shortcuts settings are present/);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, keybindsSettingsAsset)), false);
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), true);

    const linuxDesktopSource = fs.readFileSync(
      path.join(assetsDir, linuxDesktopSettingsAsset),
      "utf8",
    );
    assert.match(linuxDesktopSource, /Linux desktop/);
    assert.match(linuxDesktopSource, /Build information/);
    assert.match(linuxDesktopSource, /codex-linux-get-build-info/);
    assert.match(linuxDesktopSource, /Open on GitHub/);
    assert.match(linuxDesktopSource, /href:url/);
    assert.doesNotMatch(linuxDesktopSource, /Source commit URL/);
    assert.match(
      linuxDesktopSource,
      /import\{codexLinuxReact as React,codexLinuxJsx as \$\}from"\.\/settings-page-A\.js"/,
    );
    assert.doesNotMatch(linuxDesktopSource, /__reactFactory|__jsxFactory/);
    const settingsRouteSource = fs.readFileSync(
      path.join(assetsDir, "settings-page-A.js"),
      "utf8",
    );
    assert.match(
      settingsRouteSource,
      /RouteReact as codexLinuxReact,RouteJsx as codexLinuxJsx/,
    );
    assert.match(
      linuxDesktopSource,
      /import\{t as Toggle\}from"\.\/linux-settings-toggle-linux\.js\?v=[a-f0-9]{12}"/,
    );
    assert.doesNotMatch(linuxDesktopSource, /function LinuxSwitch/);

    const settingsPageSource = fs.readFileSync(path.join(assetsDir, "settings-page-A.js"), "utf8");
    const linuxDesktopDigest = crypto
      .createHash("sha256")
      .update(linuxDesktopSource)
      .digest("hex")
      .slice(0, 12);
    assert.match(
      settingsPageSource,
      new RegExp(`linux-desktop-settings-linux\\.js\\?v=${linuxDesktopDigest}`),
    );
    const fallbackToggleSource = fs.readFileSync(
      path.join(assetsDir, "linux-settings-toggle-linux.js"),
      "utf8",
    );
    const fallbackToggleDigest = crypto
      .createHash("sha256")
      .update(fallbackToggleSource)
      .digest("hex")
      .slice(0, 12);
    assert.match(
      linuxDesktopSource,
      new RegExp(`linux-settings-toggle-linux\\.js\\?v=${fallbackToggleDigest}`),
    );
    assert.match(settingsPageSource, /linux-desktop-settings-linux\.js/);
    assert.match(settingsPageSource, /"linux-desktop":[A-Za-z_$][\w$]*,"general-settings"/);
    assert.match(settingsPageSource, /=\[`general-settings`,`linux-desktop`,`profile`/);
    assert.match(settingsPageSource, /slugs:\[`general-settings`,`linux-desktop`,`profile`/);
    assert.match(settingsPageSource, /case`linux-desktop`:case`general-settings`/);

    const splitSharedSource = fs.readFileSync(
      path.join(
        assetsDir,
        "app-initial~app-main~page~remote-conversation-page~new-thread-panel-page~settings-page~shared-A.js",
      ),
      "utf8",
    );
    assert.match(splitSharedSource, /settings\.nav\.linux-desktop/);
    assert.match(splitSharedSource, /settings\.section\.linux-desktop/);

    const splitSectionsSource = fs.readFileSync(
      path.join(
        assetsDir,
        "app-initial~app-main~remote-conversation-page~settings-page~hotkey-window-thread-page~mcp-s-A.js",
      ),
      "utf8",
    );
    assert.match(splitSectionsSource, /general-settings\.linux-desktop\.import\.profile\.keyboard-shortcuts/);
    assert.match(splitSectionsSource, /\{slug:`linux-desktop`\},\{slug:`import`\}/);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("adds Linux desktop settings when the lazy route map is hoisted into a separate app chunk", () => {
  const { extractedDir, assetsDir } = createSplitRouteNativeKeyboardShortcutsSettingsFixture();
  try {
    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.ok(result.changed >= 3);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), true);

    const linuxDesktopSource = fs.readFileSync(
      path.join(assetsDir, linuxDesktopSettingsAsset),
      "utf8",
    );
    assert.match(
      linuxDesktopSource,
      /import\{t as Toggle\}from"\.\/linux-settings-toggle-linux\.js\?v=[a-f0-9]{12}"/,
    );
    assert.doesNotMatch(linuxDesktopSource, /function LinuxSwitch/);

    // The icon/navigation bundle must reuse the general-settings icon for the new
    // entry and must NOT receive the lazy page component as a nav icon (the bug
    // that rendered a broken floating "Linux desktop" box over the settings page).
    const settingsPageSource = fs.readFileSync(path.join(assetsDir, "settings-page-A.js"), "utf8");
    assert.match(settingsPageSource, /"linux-desktop":wt,"general-settings":wt/);
    assert.doesNotMatch(settingsPageSource, /linux-desktop-settings-linux\.js/);
    assert.doesNotMatch(settingsPageSource, /codexLinuxDesktopSettings/);
    assert.match(settingsPageSource, /=\[`general-settings`,`linux-desktop`,`profile`/);
    assert.match(settingsPageSource, /slugs:\[`general-settings`,`linux-desktop`,`profile`/);
    assert.match(settingsPageSource, /case`linux-desktop`:case`general-settings`/);

    // The lazy route is registered in the hoisted app chunk, reusing the bundle's
    // own lazy/preload aliases against the bare (no `var`) map assignment.
    const routeChunkSource = fs.readFileSync(
      path.join(assetsDir, "app-initial~app-main~automations-page-A.js"),
      "utf8",
    );
    assert.match(
      routeChunkSource,
      /"linux-desktop":Ya\(async\(\)=>\(await Pr\(async\(\)=>\{let\{LinuxDesktopSettings:e\}=await import\(`\.\/linux-desktop-settings-linux\.js\?v=[a-f0-9]{12}`\);return\{LinuxDesktopSettings:e\}\},\[\],import\.meta\.url\)\)\.LinuxDesktopSettings\),"general-settings":/,
    );

    const secondResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(secondResult.matched, true);
    assert.equal(secondResult.changed, 0);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("composes Linux desktop section metadata and route patches in the same asset", () => {
  const routeChunkName = "app-initial~app-main~automations-page-A.js";
  const { extractedDir, assetsDir } = createSplitRouteNativeKeyboardShortcutsSettingsFixture({
    routeChunkName,
  });
  const routeChunkPath = path.join(assetsDir, routeChunkName);
  try {
    fs.writeFileSync(
      routeChunkPath,
      [
        fs.readFileSync(routeChunkPath, "utf8"),
        "var Bj=`general-settings.import.profile.keyboard-shortcuts.codex-micro.appshots.appearance.pets.agent.git-settings.data-controls.cloud-settings.cloud-environments.code-review.personalization.usage.browser-use.computer-use.local-environments.worktrees.environments.mcp-settings.hooks-settings.connections.plugins-settings.skills-settings`.split(`.`);",
        "var Uj=[{slug:`general-settings`},{slug:`import`},{slug:`profile`},{slug:`appearance`},{slug:`pets`},{slug:`appshots`},{slug:`git-settings`},{slug:`connections`},{slug:`cloud-settings`},{slug:`cloud-environments`},{slug:`code-review`},{slug:`local-environments`},{slug:`worktrees`},{slug:`agent`},{slug:`personalization`},{slug:`keyboard-shortcuts`},{slug:`usage`},{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`},{slug:`hooks-settings`},{slug:`plugins-settings`},{slug:`skills-settings`},{slug:`data-controls`}];",
      ].join(""),
      "utf8",
    );

    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);

    const routeChunkSource = fs.readFileSync(routeChunkPath, "utf8");
    assert.match(
      routeChunkSource,
      /"linux-desktop":Ya\(async\(\)=>\(await Pr\(async\(\)=>\{let\{LinuxDesktopSettings:e\}=await import\(`\.\/linux-desktop-settings-linux\.js\?v=[a-f0-9]{12}`\);return\{LinuxDesktopSettings:e\}\},\[\],import\.meta\.url\)\)\.LinuxDesktopSettings\),"general-settings":/,
    );
    assert.match(routeChunkSource, /Bj=`general-settings\.linux-desktop\.import\.profile\.keyboard-shortcuts/);
    assert.match(routeChunkSource, /Uj=\[\{slug:`general-settings`\},\{slug:`linux-desktop`\},\{slug:`import`\}/);

    const secondResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(secondResult.matched, true);
    assert.equal(secondResult.changed, 0);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("finds Linux desktop settings route map in hashed settings-page chunks", () => {
  const routeChunkName = "app-initial~settings-page-A.js";
  const { extractedDir, assetsDir } = createSplitRouteNativeKeyboardShortcutsSettingsFixture({
    routeChunkName,
  });
  try {
    const { value: result, warnings } = captureWarns(() => patchKeybindsSettingsAssets(extractedDir));

    assert.equal(result.matched, true);
    assert.deepEqual(warnings, []);
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), true);

    const routeChunkSource = fs.readFileSync(path.join(assetsDir, routeChunkName), "utf8");
    assert.match(
      routeChunkSource,
      /"linux-desktop":Ya\(async\(\)=>\(await Pr\(async\(\)=>\{let\{LinuxDesktopSettings:e\}=await import\(`\.\/linux-desktop-settings-linux\.js\?v=[a-f0-9]{12}`\);return\{LinuxDesktopSettings:e\}\},\[\],import\.meta\.url\)\)\.LinuxDesktopSettings\),"general-settings":/,
    );

    const settingsPageSource = fs.readFileSync(path.join(assetsDir, "settings-page-A.js"), "utf8");
    assert.match(settingsPageSource, /"linux-desktop":wt,"general-settings":wt/);
    assert.doesNotMatch(settingsPageSource, /codexLinuxDesktopSettings/);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("adds Linux desktop section to current native Keyboard Shortcuts sections bundle", () => {
  const source =
    "var e=[`general-settings`,`profile`,`keyboard-shortcuts`,`account`],t=`general-settings`,n=function(){},r=[{slug:`general-settings`},{slug:`profile`},{slug:`appearance`},{slug:`keyboard-shortcuts`}];";

  const patched = applyPatchTwice(applyLinuxDesktopSettingsSectionsPatch, source);

  assert.match(patched, /e=\[`general-settings`,`linux-desktop`,`profile`,`keyboard-shortcuts`/);
  assert.match(patched, /r=\[\{slug:`general-settings`\},\{slug:`linux-desktop`\},\{slug:`profile`\}/);
});

test("adds Linux desktop section to split current section metadata bundle", () => {
  const source = [
    "var Bj=`general-settings.import.profile.keyboard-shortcuts.codex-micro.appshots.appearance.pets.agent.git-settings.data-controls.cloud-settings.cloud-environments.code-review.personalization.usage.browser-use.computer-use.local-environments.worktrees.environments.mcp-settings.hooks-settings.connections.plugins-settings.skills-settings`.split(`.`);",
    "var Uj=[{slug:`general-settings`},{slug:`import`},{slug:`profile`},{slug:`appearance`},{slug:`pets`},{slug:`appshots`},{slug:`git-settings`},{slug:`connections`},{slug:`cloud-settings`},{slug:`cloud-environments`},{slug:`code-review`},{slug:`local-environments`},{slug:`worktrees`},{slug:`agent`},{slug:`personalization`},{slug:`keyboard-shortcuts`},{slug:`usage`},{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`},{slug:`hooks-settings`},{slug:`plugins-settings`},{slug:`skills-settings`},{slug:`data-controls`}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxDesktopSettingsSectionsPatch, source);

  assert.match(patched, /Bj=`general-settings\.linux-desktop\.import\.profile\.keyboard-shortcuts/);
  assert.match(patched, /Uj=\[\{slug:`general-settings`\},\{slug:`linux-desktop`\},\{slug:`import`\}/);
});

test("adds Linux desktop section to duplicate section metadata shapes in one asset", () => {
  const source = [
    "var e=[`general-settings`,`profile`,`keyboard-shortcuts`,`account`],r=[`general-settings`,`import`,`keyboard-shortcuts`,`usage`];",
    "var Bj=`general-settings.profile.keyboard-shortcuts`.split(`.`),Cj=`general-settings.import.keyboard-shortcuts`.split(`.`);",
    "var Uj=[{slug:`general-settings`},{slug:`profile`},{slug:`keyboard-shortcuts`}],Vj=[{slug:`general-settings`},{slug:`appearance`},{slug:`keyboard-shortcuts`}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxDesktopSettingsSectionsPatch, source);

  assert.equal([...patched.matchAll(/=\[`general-settings`,`linux-desktop`,/g)].length, 2);
  assert.equal([...patched.matchAll(/`general-settings\.linux-desktop\.[^`]*keyboard-shortcuts[^`]*`\.split\(`\.`\)/g)].length, 2);
  assert.equal([...patched.matchAll(/=\[\{slug:`general-settings`\},\{slug:`linux-desktop`\},/g)].length, 2);
});

test("adds the Linux desktop section title when the JSX message component identifier drifts", () => {
  const patched = applyLinuxDesktopSettingsSharedPatch(
    settingsSharedBundleWithDriftingJsxAliasFixture(),
  );

  // The injected case must reuse the bundle's actual identifiers (r / o[5]),
  // not a hardcoded `n`, otherwise the section title renders blank.
  assert.match(
    patched,
    /case`linux-desktop`:\{return \(0,d\.jsx\)\(r,\{id:`settings\.section\.linux-desktop`,defaultMessage:`Linux desktop`,description:`Title for Linux desktop settings section`\}\)\}/,
  );
  // The original general-settings case is preserved untouched.
  assert.match(patched, /case`general-settings`:\{let e;return o\[5\]===Symbol\.for\(`react\.memo_cache_sentinel`\)/);
});

test("keeps local environment action modal inputs editable inside stored modal content", () => {
  const source =
    "function gd(e){let t=(0,Z.c)(101),{action:n,configPath:r,environment:i,hostConfig:a,onOpenSettings:o,onRunAction:s,onSaved:c,onUpdate:l,workspaceRoot:u}=e,d=Gt(),f=Pt(),p=Jt(`local-environment-config-save`),m,h,g,_,v,y,b,x,S,C,w,T,E,D,O,k;if(t[0]!==n||t[1]!==r||t[2]!==i||t[3]!==a||t[4]!==d||t[5]!==s||t[6]!==c||t[7]!==l||t[8]!==f||t[9]!==p||t[10]!==u){let e;t[27]===d?e=t[28]:(e=e=>({ariaLabel:d.formatMessage(e.message),icon:(0,$.jsx)(Zs,{icon:e.value}),value:e.value}),t[27]=d,t[28]=e);let o=Js.map(e),A=o.find(e=>e.value===n.icon)??o[0],j;t[29]!==d||t[30]!==u?(j=po(u)??d.formatMessage({id:`settings.localEnvironments.environment.defaultName`,defaultMessage:`local`,description:`Fallback name for the local environment`}),t[29]=d,t[30]=u,t[31]=j):j=t[31];let M=j,N;t[32]===n.name?N=t[33]:(N=n.name.trim(),t[32]=n.name,t[33]=N);let P=N,F;t[34]===n.command?F=t[35]:(F=n.command.trim(),t[34]=n.command,t[35]=F);let I=F;v=P.length===0||I.length===0||p.isPending,g=`local-env-action-name-${n.id}`;let L;t[36]!==n||t[37]!==r||t[38]!==M||t[39]!==i||t[40]!==a||t[41]!==s||t[42]!==c||t[43]!==f||t[44]!==p||t[45]!==v||t[46]!==I||t[47]!==P||t[48]!==u?(L=e=>{if(e.preventDefault(),v)return;let t=i.environment,o={...n,command:I,name:P},l={command:I,icon:n.icon,name:P,...n.platform?{platform:n.platform}:{}},d=Ks({actions:[...Xs(t.actions??[]),o],cleanupPlatformScripts:qs(t.cleanup),cleanupScript:t.cleanup?.script??``,name:t.name||M,setupPlatformScripts:qs(t.setup),setupScript:t.setup.script??``,version:t.version??1});p.mutate({configPath:r,hostId:a.id,raw:d},{onSuccess:()=>{f.invalidateQueries({queryKey:Qt(`local-environment-config`,{configPath:r,hostId:a.id})}),f.invalidateQueries({queryKey:Qt(`local-environment`,{configPath:r,hostId:a.id})}),u!=null&&f.invalidateQueries({queryKey:Qt(`local-environments`,{hostId:a.id,workspaceRoot:u})}),c(),s(l)}})},t[36]=n,t[37]=r,t[38]=M,t[39]=i,t[40]=a,t[41]=s,t[42]=c,t[43]=f,t[44]=p,t[45]=v,t[46]=I,t[47]=P,t[48]=u,t[49]=L):L=t[49],_=L,h=Sl,O=n.command,t[50]===Symbol.for(`react.memo_cache_sentinel`)?(k=(0,$.jsx)(X,{id:`threadPage.runAction.setup.commandLabel`,defaultMessage:`Command to run`,description:`Label for run action command input`}),t[50]=k):k=t[50],t[51]===d?b=t[52]:(b=d.formatMessage({id:`threadPage.runAction.setup.placeholder`,defaultMessage:`eg:\\nnpm install\\nnpm run`,description:`Placeholder text for the run action command input`}),t[51]=d,t[52]=b),t[53]===Symbol.for(`react.memo_cache_sentinel`)?(x=(0,$.jsx)(X,{id:`settings.localEnvironments.actions.add.description`,defaultMessage:`Create a new command to run from the toolbar.`,description:`Description for adding a local environment action`}),t[53]=x):x=t[53],E=`flex w-full flex-col gap-2`;let R;t[54]===Symbol.for(`react.memo_cache_sentinel`)?(R=(0,$.jsx)(X,{id:`settings.localEnvironments.actions.item.name`,defaultMessage:`Name`,description:`Label for local environment action name`}),t[54]=R):R=t[54],t[55]===g?D=t[56]:(D=(0,$.jsx)(`label`,{className:`text-xs font-medium tracking-wide text-token-text-secondary uppercase`,htmlFor:g,children:R}),t[55]=g,t[56]=D),T=`flex items-center gap-2`,m=ua,y=`start`,S=`icon`,C=(0,$.jsx)(Pn,{id:`local-env-action-icon-${n.id}`,\"aria-label\":A.ariaLabel,className:`w-12 justify-center text-sm`,color:`secondary`,size:`toolbar`,children:A.icon});let z;t[57]===l?z=t[58]:(z=e=>(0,$.jsx)(la.Item,{tooltipText:e.ariaLabel,onSelect:()=>{l({icon:e.value})},children:e.icon},e.value),t[57]=l,t[58]=z),w=o.map(z),t[0]=n,t[1]=r,t[2]=i,t[3]=a,t[4]=d,t[5]=s,t[6]=c,t[7]=l,t[8]=f,t[9]=p,t[10]=u,t[11]=m,t[12]=h,t[13]=g,t[14]=_,t[15]=v,t[16]=y,t[17]=b,t[18]=x,t[19]=S,t[20]=C,t[21]=w,t[22]=T,t[23]=E,t[24]=D,t[25]=O,t[26]=k}else m=t[11],h=t[12],g=t[13],_=t[14],v=t[15],y=t[16],b=t[17],x=t[18],S=t[19],C=t[20],w=t[21],T=t[22],E=t[23],D=t[24],O=t[25],k=t[26];let A;t[59]!==m||t[60]!==y||t[61]!==S||t[62]!==C||t[63]!==w?(A=(0,$.jsx)(m,{align:y,contentWidth:S,triggerButton:C,children:w}),t[59]=m,t[60]=y,t[61]=S,t[62]=C,t[63]=w,t[64]=A):A=t[64];let j;t[65]===l?j=t[66]:(j=e=>{l({name:e.target.value})},t[65]=l,t[66]=j);let M;t[67]!==n.name||t[68]!==g||t[69]!==j?(M=(0,$.jsx)(`div`,{className:`flex-1`,children:(0,$.jsx)(`input`,{id:g,className:`w-full`,value:n.name,onChange:j})}),t[67]=n.name,t[68]=g,t[69]=j,t[70]=M):M=t[70];let V;t[86]===l?V=t[87]:(V=e=>{l({command:e})},t[86]=l,t[87]=V);return (0,$.jsx)(h,{command:O,onCommandChange:V})}var _d=_t(`local-env-recent-actions-by-key`,{});function Ml(){return n.name+n.command+n.icon}";

  const patched = applyPatchTwice(applyLocalEnvironmentActionModalDraftPatch, source);

  assert.match(patched, /\[codexLinuxActionDraft,codexLinuxSetActionDraft\]=\(0,Q\.useState\)\(\(\)=>n\)/);
  assert.match(patched, /t\[0\]!==codexLinuxActionDraft\|\|t\[0\]!==n/);
  assert.match(patched, /codexLinuxActionDraft\.name\.trim\(\)/);
  assert.match(patched, /codexLinuxActionDraft\.command\.trim\(\)/);
  assert.match(patched, /\{\.\.\.codexLinuxActionDraft,command:I,name:P\}/);
  assert.match(patched, /codexLinuxUpdateActionDraft\(\{name:e\.target\.value\}\)/);
  assert.match(patched, /codexLinuxUpdateActionDraft\(\{command:e\}\)/);
  assert.match(patched, /t\[67\]!==codexLinuxActionDraft\.name/);
  assert.match(patched, /var _d=_t\(`local-env-recent-actions-by-key`,\{\}\);function Ml\(\)\{return n\.name\+n\.command\+n\.icon\}/);
});

test("keeps local environment action modal inputs editable after component alias drift", () => {
  const source = [
    "function Existing(){return (0,Z.useState)(!1)}",
    "function lf(e){let t=(0,X.c)(101),{action:n,configPath:r,environment:i,hostConfig:a,onOpenSettings:o,onRunAction:s,onSaved:c,onUpdate:l,workspaceRoot:u}=e,d=on(),f=v(),p=w(`local-environment-config-save`),g,y,j;if(t[0]!==n||t[7]!==l){let label={id:`threadPage.runAction.setup.commandLabel`},desc={id:`settings.localEnvironments.actions.add.description`},A={ariaLabel:`a`,icon:null,value:n.icon},N=`local`,P=n.name.trim(),F=P,I=n.command.trim(),L=I;y=F.length===0||L.length===0||p.isPending,g=`local-env-action-name-${n.id}`;let R;t[36]!==n?(R=e=>{if(e.preventDefault(),y)return;let t=i.environment,o={...n,command:L,name:F},l={command:L,icon:n.icon,name:F,...n.platform?{platform:n.platform}:{}},d=mu({actions:[...vu(t.actions??[]),o]});p.mutate({configPath:r,hostId:a.id,raw:d},{onSuccess:()=>{c(),s(l)}})},t[36]=n,t[49]=R):R=t[49],j=n.command;let z=e=>{l({icon:e.value})},M=e=>{l({name:e.target.value})},V=e=>{l({command:e})};return {label,desc,g,j,z,M,V}}return null}",
  ].join("");

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLocalEnvironmentActionModalDraftPatch, source),
  );

  assert.deepEqual(warnings, []);
  assert.match(patched, /\[codexLinuxActionDraft,codexLinuxSetActionDraft\]=\(0,Z\.useState\)\(\(\)=>n\)/);
  assert.match(patched, /\{\.\.\.codexLinuxActionDraft,command:L,name:F\}/);
  assert.match(patched, /codexLinuxActionDraft\.name\.trim\(\)/);
  assert.match(patched, /codexLinuxUpdateActionDraft\(\{command:e\}\)/);
});

test("skips local environment action modal patch when a critical replacement needle drifts", () => {
  const source =
    "function gd(e){let t=(0,Z.c)(101),{action:n,configPath:r,environment:i,hostConfig:a,onOpenSettings:o,onRunAction:s,onSaved:c,onUpdate:l,workspaceRoot:u}=e,d=Gt(),f=Pt(),p=Jt(`local-environment-config-save`),m,h,g,_,v,y,b,x,S,C,w,T,E,D,O,k;if(t[0]!==n||t[1]!==r||t[2]!==i||t[3]!==a||t[4]!==d||t[5]!==s||t[6]!==c||t[7]!==l||t[8]!==f||t[9]!==p||t[10]!==u){let e;t[27]===d?e=t[28]:(e=e=>({ariaLabel:d.formatMessage(e.message),icon:(0,$.jsx)(Zs,{icon:e.value}),value:e.value}),t[27]=d,t[28]=e);let o=Js.map(e),A=o.find(e=>e.value===n.icon)??o[0],j;t[29]!==d||t[30]!==u?(j=po(u)??d.formatMessage({id:`settings.localEnvironments.environment.defaultName`,defaultMessage:`local`,description:`Fallback name for the local environment`}),t[29]=d,t[30]=u,t[31]=j):j=t[31];let M=j,N;t[32]===n.name?N=t[33]:(N=n.name.trim(),t[32]=n.name,t[33]=N);let P=N,F;t[34]===n.command?F=t[35]:(F=n.command.trim(),t[34]=n.command,t[35]=F);let I=F;v=P.length===0||I.length===0||p.isPending,g=`local-env-action-name-${n.id}`;let L;t[36]!==n||t[37]!==r||t[38]!==M||t[39]!==i||t[40]!==a||t[41]!==s||t[42]!==c||t[43]!==f||t[44]!==p||t[45]!==v||t[46]!==I||t[47]!==P||t[48]!==u?(L=e=>{if(e.preventDefault(),v)return;let t=i.environment,o={...n,command:I,name:P},l={command:I,icon:n.icon,name:P,...n.platform?{platform:n.platform}:{}},d=Ks({actions:[...Xs(t.actions??[]),o],cleanupPlatformScripts:qs(t.cleanup),cleanupScript:t.cleanup?.script??``,name:t.name||M,setupPlatformScripts:qs(t.setup),setupScript:t.setup.script??``,version:t.version??1});p.mutate({configPath:r,hostId:a.id,raw:d},{onSuccess:()=>{f.invalidateQueries({queryKey:Qt(`local-environment-config`,{configPath:r,hostId:a.id})}),f.invalidateQueries({queryKey:Qt(`local-environment`,{configPath:r,hostId:a.id})}),u!=null&&f.invalidateQueries({queryKey:Qt(`local-environments`,{hostId:a.id,workspaceRoot:u})}),c(),s(l)}})},t[36]=n,t[37]=r,t[38]=M,t[39]=i,t[40]=a,t[41]=s,t[42]=c,t[43]=f,t[44]=p,t[45]=v,t[46]=I,t[47]=P,t[48]=u,t[49]=L):L=t[49],_=L,h=Sl,O=n.command,t[50]===Symbol.for(`react.memo_cache_sentinel`)?(k=(0,$.jsx)(X,{id:`threadPage.runAction.setup.commandLabel`,defaultMessage:`Command to run`,description:`Label for run action command input`}),t[50]=k):k=t[50],t[51]===d?b=t[52]:(b=d.formatMessage({id:`threadPage.runAction.setup.placeholder`,defaultMessage:`eg:\\nnpm install\\nnpm run`,description:`Placeholder text for the run action command input`}),t[51]=d,t[52]=b),t[53]===Symbol.for(`react.memo_cache_sentinel`)?(x=(0,$.jsx)(X,{id:`settings.localEnvironments.actions.add.description`,defaultMessage:`Create a new command to run from the toolbar.`,description:`Description for adding a local environment action`}),t[53]=x):x=t[53],E=`flex w-full flex-col gap-2`;let R;t[54]===Symbol.for(`react.memo_cache_sentinel`)?(R=(0,$.jsx)(X,{id:`settings.localEnvironments.actions.item.name`,defaultMessage:`Name`,description:`Label for local environment action name`}),t[54]=R):R=t[54],t[55]===g?D=t[56]:(D=(0,$.jsx)(`label`,{className:`text-xs font-medium tracking-wide text-token-text-secondary uppercase`,htmlFor:g,children:R}),t[55]=g,t[56]=D),T=`flex items-center gap-2`,m=ua,y=`start`,S=`icon`,C=(0,$.jsx)(Pn,{id:`local-env-action-icon-${n.id}`,\"aria-label\":A.ariaLabel,className:`w-12 justify-center text-sm`,color:`secondary`,size:`toolbar`,children:A.icon});let z;t[57]===l?z=t[58]:(z=e=>(0,$.jsx)(la.Item,{tooltipText:e.ariaLabel,onSelect:()=>{l({icon:e.value})},children:e.icon},e.value),t[57]=l,t[58]=z),w=o.map(z),t[0]=n,t[1]=r,t[2]=i,t[3]=a,t[4]=d,t[5]=s,t[6]=c,t[7]=l,t[8]=f,t[9]=p,t[10]=u,t[11]=m,t[12]=h,t[13]=g,t[14]=_,t[15]=v,t[16]=y,t[17]=b,t[18]=x,t[19]=S,t[20]=C,t[21]=w,t[22]=T,t[23]=E,t[24]=D,t[25]=O,t[26]=k}else m=t[11],h=t[12],g=t[13],_=t[14],v=t[15],y=t[16],b=t[17],x=t[18],S=t[19],C=t[20],w=t[21],T=t[22],E=t[23],D=t[24],O=t[25],k=t[26];let A;t[59]!==m||t[60]!==y||t[61]!==S||t[62]!==C||t[63]!==w?(A=(0,$.jsx)(m,{align:y,contentWidth:S,triggerButton:C,children:w}),t[59]=m,t[60]=y,t[61]=S,t[62]=C,t[63]=w,t[64]=A):A=t[64];let j;t[65]===l?j=t[66]:(j=e=>{l({name:e.target.value})},t[65]=l,t[66]=j);let M;t[67]!==n.name||t[68]!==g||t[69]!==j?(M=(0,$.jsx)(`div`,{className:`flex-1`,children:(0,$.jsx)(`input`,{id:g,className:`w-full`,value:n.name,onChange:j})}),t[67]=n.name,t[68]=g,t[69]=j,t[70]=M):M=t[70];let V;t[86]===l?V=t[87]:(V=e=>{l({commandValue:e})},t[86]=l,t[87]=V);return (0,$.jsx)(h,{command:O,onCommandChange:V})}var _d=_t(`local-env-recent-actions-by-key`,{});";

  const { value: patched, warnings } = captureWarns(() =>
    applyLocalEnvironmentActionModalDraftPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find local environment action modal command update callback — skipping action input patch",
  ]);
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

test("allows explicit locale overrides through the webview i18n provider gate on Linux", () => {
  const source =
    "function eP(e){let a=Ma(`72216192`),o;o=a?.get(`enable_i18n`,!1);let c=o,l=a?.get(`locale_source`,`IDE`),u=js(s.localeOverride);return c?u:null}";

  const patched = applyPatchTwice(applyLinuxI18nGatePatch, source);

  assert.match(patched, /o=a\?\.get\(`enable_i18n`,!1\);let l=a\?\.get\(`locale_source`,`IDE`\),u=js\(s\.localeOverride\),c=o\|\|u!=null/);
  assert.equal((patched.match(/js\(s\.localeOverride\)/g) ?? []).length, 1);
  assert.match(patched, /localeOverride/);
});

test("keeps React compiler cache hook order in the webview i18n provider gate patch", () => {
  const source =
    "function eP(e){let t=(0,Z.c)(21),a=Ma(`72216192`),o;t[0]===a?o=t[1]:(o=a?.get(`enable_i18n`,!1),t[0]=a,t[1]=o);let c=o,l=a?.get(`locale_source`,`IDE`),u=js(s.localeOverride),d=r?.ideLocale;return c?u:d}";

  const patched = applyPatchTwice(applyLinuxI18nGatePatch, source);

  assert.match(
    patched,
    /o=a\?\.get\(`enable_i18n`,!1\),t\[0\]=a,t\[1\]=o\);let l=a\?\.get\(`locale_source`,`IDE`\),u=js\(s\.localeOverride\),c=o\|\|u!=null/,
  );
  assert.equal((patched.match(/js\(s\.localeOverride\)/g) ?? []).length, 1);
});

test("allows explicit locale overrides through the settings language row i18n gate on Linux", () => {
  const source =
    "function Or(){let r=F(),i=re(`72216192`)?.get(`enable_i18n`,!0),s=H(t.localeOverride);if(!i)return null;return r.locale+s}";

  const patched = applyPatchTwice(applyLinuxI18nGatePatch, source);

  assert.match(
    patched,
    /i=re\(`72216192`\)\?\.get\(`enable_i18n`,!0\),s=H\(t\.localeOverride\);i=i\|\|s!=null;if\(!i\)/,
  );
  assert.equal((patched.match(/H\(t\.localeOverride\)/g) ?? []).length, 1);
});

test("recognizes current app i18n provider gate as already patched", () => {
  const source =
    "function MI(e){let t=(0,Q.c)(21),{children:n}=e,{data:r}=p(AI),i=d(m),a=yo(`72216192`),o;t[0]===a?o=t[1]:(o=a?.get(`enable_i18n`,!1),t[0]=a,t[1]=o);let c=a?.get(`locale_source`,`IDE`),l=za(G.localeOverride),s=o||l!=null,u=r?.ideLocale;return s?u:n}";
  const { value, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxI18nGatePatch, source),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("recognizes current settings language row i18n gate as already patched", () => {
  const source =
    "function Jn(){let e=(0,Z.c)(48),t=a(s),n=P(),r=oe(`72216192`)?.get(`enable_i18n`,!0),[i,o]=(0,Q.useState)(``),c=W(_.localeOverride);r=r||c!=null;let l;if(!r)return null;return l}";
  const { value, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxI18nGatePatch, source),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("keeps automation_update eager in dynamic tools built during thread start", () => {
  const source =
    "async function pUt(){return[{type:`namespace`,name:cX,description:`Tools provided by the Codex app.`,tools:[...h?[_ee()]:[],...[],...i?.open_in_codex===!0?[TBt]:[],...h&&d?[SBt]:[],lu,...h&&y?[Ra]:[],...[],...g?AHt({availableHandoffHosts:e,availableModels:b,crossHostHandoffEnabled:n,forkThreadEnabled:!0}):[],...h&&_?[PBt,FBt]:[],...m===`conversational_onboarding`?[yoe]:[],...v&&m!==`conversational_onboarding`?[...vee,bu]:[]].map(e=>({type:`function`,...e,..._Ut.has(e.name)?{}:{deferLoading:!0}}))}]}async sendRequest(e,t,n){if(e===`config/read`)return this.sendConfigReadRequest(t,n);let{request:r,promise:i}=this.createRequest(e,t,n);return i}";

  const patched = applyPatchTwice(applyAutomationUpdateEagerToolPatch, source);

  assert.match(patched, /e\.name===`automation_update`&&delete t\.deferLoading/);
  assert.match(patched, /\{deferLoading:!0\}/);
  assert.doesNotMatch(patched, /codex-linux-automation-dynamic-tools-diagnostics/);
});

test("removes unsupported features from default app-server feature sync", () => {
  const source = [
    "var GF=[`apps`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`mentions_v2`,`plugins`,`remote_control`,`remote_plugin`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,te];",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r}).catch(n=>{q.error(`Failed to sync experimental feature enablement`,{sensitive:{error:n}})})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e){let t={};for(let n of GF){let r=e[n];r!=null&&(t[n]=r)}return t}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.match(
    patched,
    /var GF=\[`apps`,`memories`,`mentions_v2`,`plugins`,`remote_control`,`remote_plugin`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`\];/,
  );
  assert.doesNotMatch(patched, /`auth_elicitation`/);
  assert.doesNotMatch(patched, /`enable_mcp_apps`/);
  assert.match(patched, /`tool_search`/);
  assert.doesNotMatch(patched, /,te\]/);
});

test("patches the matched app-server feature sync array when an identical array appears earlier", () => {
  const unsupportedFeatureArray =
    "var GF=[`apps`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,te];";
  const supportedFeatureArray =
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`];";
  const source = [
    unsupportedFeatureArray,
    "function OF(){return GF}",
    unsupportedFeatureArray,
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.equal(patched.indexOf(unsupportedFeatureArray), 0);
  assert.match(patched, new RegExp(`${escapeRegExp(unsupportedFeatureArray)}function OF`));
  assert.match(patched, new RegExp(`function OF\\(\\)\\{return GF\\}${escapeRegExp(supportedFeatureArray)}function KF`));
});

test("preserves supported dynamic remote_plugin in current app-server feature sync", () => {
  const source = [
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`],vI=`remote_plugin`;",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n,!0);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r}).catch(n=>{q.error(`Failed to sync experimental feature enablement`,{sensitive:{error:n}})})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e,t){let n={};for(let r of GF){let i=e[r];i!=null&&(n[r]=i)}return n[vI]=t,n}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.equal(patched, source);
  assert.match(patched, /n\[vI\]=t/);
});

test("sanitizes unsupported features in current dynamic app-server feature sync", () => {
  const source = [
    "var BV=[`apps_mcp_path_override`,`auth_elicitation`,`memories`,`tool_suggest`],VV=`4218407052`,HV=`remote_plugin`;",
    "function UV(){let e=(0,Q.c)(7),t=f(g),[n]=ft(`statsig_default_enable_features`),r=So(VV),i=Ho(),a=on(),o,s;",
    "return e[0]!==i||e[1]!==r||e[2]!==n||e[3]!==a||e[4]!==t?(o=()=>{let e=new Map,o=()=>{if(nt(`set-default-feature-overrides`,{overrides:n??null}),n==null)return;let i=WV(n,r),o=t.get(Ft),s=new Set(t.get(gt).filter(e=>e===o||Ut(t,e).state===`connected`));for(let t of e.keys())s.has(t)||e.delete(t);let c=t.get(gt).filter(e=>s.has(e)).flatMap(t=>(0,zb.default)(e.get(t),i)?[]:(e.set(t,i),[nt(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:i}).catch(n=>{e.delete(t),cn.error(`Failed to sync experimental feature enablement`,{safe:{hostId:t},sensitive:{error:n}})})]));c.length!==0&&Promise.all(c).then(()=>{a.invalidateQueries({queryKey:ll})})};return o(),i.addRegistryCallback(o)},s=[i,r,n,a,t],e[0]=i,e[1]=r,e[2]=n,e[3]=a,e[4]=t,e[5]=o,e[6]=s):(o=e[5],s=e[6]),(0,$.useEffect)(o,s),null}",
    "function WV(e,t){let n={};for(let t of BV){let r=e[t];r!=null&&(n[t]=r)}return n[HV]=t,n}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.match(patched, /var BV=\[`memories`,`tool_suggest`\],VV=`4218407052`,HV=`remote_plugin`/);
  assert.match(patched, /n\[HV\]=t,n/);
  assert.doesNotMatch(patched, /`apps_mcp_path_override`/);
  assert.doesNotMatch(patched, /`auth_elicitation`/);
});

test("sanitizes unsupported features in assignment-style dynamic app-server feature sync", () => {
  const source = [
    "function iae(e,t){let n={};for(let t of k7){let r=e[t];r!=null&&(n[t]=r)}return n[j7]=t,n}",
    "var E7,D7,O7,k7,A7,j7,aae=e((()=>{E7=s(),k7=[`apps_mcp_path_override`,`auth_elicitation`,`memories`,`tool_suggest`],A7=`4218407052`,j7=`remote_plugin`}));",
    "function rae(){let e=(0,E7.c)(7),t=M(J),[n]=Y_(`statsig_default_enable_features`),r=Kd(A7),i=Kh(),a=rt(),o,s;",
    "return e[0]!==i||e[1]!==r||e[2]!==n||e[3]!==a||e[4]!==t?(o=()=>{let e=new Map,o=()=>{if(vd(`set-default-feature-overrides`,{overrides:n??null}),n==null)return;let i=iae(n,r),o=t.get(Kp),s=new Set(t.get(nm).filter(e=>e===o||pm(t,e).state===`connected`));for(let t of e.keys())s.has(t)||e.delete(t);let c=t.get(nm).filter(e=>s.has(e)).flatMap(t=>(0,D7.default)(e.get(t),i)?[]:(e.set(t,i),[vd(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:i}).catch(n=>{e.delete(t),l.error(`Failed to sync experimental feature enablement`,{safe:{hostId:t},sensitive:{error:n}})})]));c.length!==0&&Promise.all(c).then(()=>{a.invalidateQueries({queryKey:$te})})};return o(),i.addRegistryCallback(o)},s=[i,r,n,a,t],e[0]=i,e[1]=r,e[2]=n,e[3]=a,e[4]=t,e[5]=o,e[6]=s):(o=e[5],s=e[6]),(0,O7.useEffect)(o,s),null}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.match(patched, /k7=\[`memories`,`tool_suggest`\]/);
  assert.match(patched, /n\[j7\]=t,n/);
  assert.doesNotMatch(patched, /`apps_mcp_path_override`/);
  assert.doesNotMatch(patched, /`auth_elicitation`/);
});

test("does not sanitize assignment-style feature arrays inside longer identifiers", () => {
  const source = [
    "var Xk7=[`apps_mcp_path_override`,`auth_elicitation`];",
    "function iae(e,t){let n={};for(let t of k7){let r=e[t];r!=null&&(n[t]=r)}return n[j7]=t,n}",
    "var E7,D7,O7,k7,A7,j7,aae=e((()=>{E7=s(),k7=[`apps_mcp_path_override`,`auth_elicitation`,`memories`,`tool_suggest`],A7=`4218407052`,j7=`remote_plugin`}));",
    "function rae(){let e=(0,E7.c)(7),t=M(J),[n]=Y_(`statsig_default_enable_features`),r=Kd(A7),i=Kh(),a=rt(),o,s;",
    "return e[0]!==i||e[1]!==r||e[2]!==n||e[3]!==a||e[4]!==t?(o=()=>{let e=new Map,o=()=>{if(vd(`set-default-feature-overrides`,{overrides:n??null}),n==null)return;let i=iae(n,r),o=t.get(Kp),s=new Set(t.get(nm).filter(e=>e===o||pm(t,e).state===`connected`));for(let t of e.keys())s.has(t)||e.delete(t);let c=t.get(nm).filter(e=>s.has(e)).flatMap(t=>(0,D7.default)(e.get(t),i)?[]:(e.set(t,i),[vd(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:i}).catch(n=>{e.delete(t),l.error(`Failed to sync experimental feature enablement`,{safe:{hostId:t},sensitive:{error:n}})})]));c.length!==0&&Promise.all(c).then(()=>{a.invalidateQueries({queryKey:$te})})};return o(),i.addRegistryCallback(o)},s=[i,r,n,a,t],e[0]=i,e[1]=r,e[2]=n,e[3]=a,e[4]=t,e[5]=o,e[6]=s):(o=e[5],s=e[6]),(0,O7.useEffect)(o,s),null}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.match(patched, /Xk7=\[`apps_mcp_path_override`,`auth_elicitation`\]/);
  assert.match(patched, /,k7=\[`memories`,`tool_suggest`\]/);
  assert.match(patched, /n\[j7\]=t,n/);
});

test("preserves dynamic remote_plugin when the minified feature key contains regex syntax", () => {
  const source = [
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`],v$I=`remote_plugin`;",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n,!0);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e,t){let n={};for(let r of GF){let i=e[r];i!=null&&(n[r]=i)}return n[v$I]=t,n}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.equal(patched, source);
  assert.match(patched, /n\[v\$I\]=t/);
});

test("keeps already-sanitized dynamic app-server feature sync quiet", () => {
  const source = [
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`],vI=`remote_plugin`;",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n,!0);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e,t){let n={};for(let r of GF){let i=e[r];i!=null&&(n[r]=i)}return n}",
  ].join("");

  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxAppServerFeatureEnablementPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("warns when app-server feature sync still has unsupported features but the list shape drifts", () => {
  const source = [
    "var GF=new Set([`apps`,unsupportedAuthFeature]);",
    "function KF(){let e=ts(`statsig_default_enable_features`);",
    "return qn(`set-experimental-feature-enablement-for-host`,{enablement:{name:`auth_elicitation`}})}",
  ].join("");

  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxAppServerFeatureEnablementPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find app-server feature enablement list — skipping unsupported feature compatibility patch",
  ]);
});

test("drops stale expectedVersion from Linux webview config writes", () => {
  const source = [
    "async function X(e,t,n){await o(`write-config-value`,{hostId:r,keyPath:t,value:n,mergeStrategy:`upsert`,filePath:B.filePath,expectedVersion:B.expectedVersion})}",
    "async function Y(e){await qn(`batch-write-config-value`,{hostId:h,edits:e,filePath:v?.configWriteTarget?.filePath??null,expectedVersion:v?.configWriteTarget?.expectedVersion??null,reloadUserConfig:!0})}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxConfigWriteVersionConflictPatch, source);

  assert.match(patched, /write-config-value/);
  assert.equal((patched.match(/expectedVersion:null/g) || []).length, 2);
  assert.equal(patched.includes("expectedVersion:B.expectedVersion"), false);
  assert.equal(patched.includes("expectedVersion:v?.configWriteTarget?.expectedVersion??null"), false);
});

test("leaves already-null config write versions unchanged", () => {
  const source = "async function X(){await o(`write-config-value`,{expectedVersion:null})}";

  const patched = applyPatchTwice(applyLinuxConfigWriteVersionConflictPatch, source);

  assert.equal(patched, source);
});

test("extends app-server startup waits while state db backfill is running", () => {
  const source = [
    "var Js=`Please continue this conversation on the window where it was started.`,Ys=3e4,Xs=2e3;",
    "class RequestClient{createRequest(e,t,n){let r=P(B()),i=n?.timeoutMs??0,a=Da(t),o=this.requestPromises.size,s=Date.now();return{request:{id:r,method:e,params:t},conversationId:a,pending:o,startedAtMs:s,timeoutMs:i}}}",
    "function za(e){let t=La.safeParse(e);return t.success?new Ba(t.data):e}",
    "function Np(e){if(e.startsWith(`Parse Error`))return{code:`restart-required`};let t=Mp(e);return t==null?e.startsWith(`codex-app-server-version-unsupported:`)?{code:`update-required`,minRequiredVersion:Dp,currentVersion:e.slice(37)}:{code:`connection-failed`,message:e}:{code:`restart-required`,currentVersion:t.currentVersion,installedVersion:t.installedVersion}}",
  ].join("");

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxAppServerBackfillWaitPatch, source),
  );

  assert.deepEqual(warnings, []);
  assert.match(patched, /function codexLinuxIsStateDbBackfillMessage\(e\)/);
  assert.match(patched, /function codexLinuxAppServerBackfillTimeoutMs\(e,t\)/);
  assert.match(patched, /i=codexLinuxAppServerBackfillTimeoutMs\(e,i\);let a=Da\(t\)/);
  assert.match(
    patched,
    /if\(codexLinuxIsStateDbBackfillMessage\(e\)\)return\{code:`connection-failed`,message:codexLinuxStateDbBackfillMessage\(e\)\}/,
  );

  const context = {};
  vm.runInNewContext(
    `${patched};result=Np("state db backfill is running at /home/user/.codex");startupTimeout=codexLinuxAppServerBackfillTimeoutMs("thread/start",3e4);turnTimeout=codexLinuxAppServerBackfillTimeoutMs("turn/start",3e4);`,
    context,
  );
  assert.equal(context.result.code, "connection-failed");
  assert.match(context.result.message, /state database backfill is still running/);
  assert.equal(context.startupTimeout, 3e5);
  assert.equal(context.turnTimeout, 3e4);
});

test("extends app-server startup waits in current manager signals bundle", () => {
  const source =
    "var gi=e(oi(),1),_i=z({code:Pe([He(),I()]),message:I().min(1)}).passthrough(),vi=class{requestLifecycleListeners=new Set;requestPromises=new Map;createRequest(e,t,n){let r=F(V()),i=n?.timeoutMs??0,a=si(t),o=this.requestPromises.size,s=Date.now();return{request:{id:r,method:e,params:t},conversationId:a,pending:o,startedAtMs:s,timeoutMs:i}}};";

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxAppServerBackfillWaitPatch, source),
  );

  assert.deepEqual(warnings, []);
  assert.match(
    patched,
    /function codexLinuxIsStateDbBackfillMessage\(e\)[\s\S]*var gi=e\(oi\(\),1\),_i=z/,
  );
  assert.match(patched, /i=codexLinuxAppServerBackfillTimeoutMs\(e,i\);let a=si\(t\)/);
});

test("keeps current app-server backfill helpers visible outside the Sentry handler", () => {
  const source =
    "function fi(e,t){let n=hi(t.originalException);return n==null?e:{...e,...n,extra:{...e.extra,...n.extra}}}var gi=e(oi(),1),_i=z({code:Pe([He(),I()]),message:I().min(1)}).passthrough(),vi=class{requestLifecycleListeners=new Set;requestPromises=new Map;createRequest(e,t,n){let r=F(V()),i=n?.timeoutMs??0,a=si(t),o=this.requestPromises.size,s=Date.now();return{request:{id:r,method:e,params:t},conversationId:a,pending:o,startedAtMs:s,timeoutMs:i}}};";

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxAppServerBackfillWaitPatch, source),
  );

  assert.deepEqual(warnings, []);
  assert.match(
    patched,
    /^function codexLinuxIsStateDbBackfillMessage\(e\)[\s\S]*function fi\(e,t\)\{let n=hi\(t\.originalException\);/,
  );
  assert.doesNotMatch(
    patched,
    /function fi\(e,t\)\{let n=hi\(t\.originalException\);function codexLinuxIsStateDbBackfillMessage/,
  );
  assert.match(patched, /i=codexLinuxAppServerBackfillTimeoutMs\(e,i\);let a=si\(t\)/);

  const helperPrefix = patched.slice(0, patched.indexOf("function fi("));
  const context = {};
  vm.runInNewContext(
    `${helperPrefix};startupTimeout=codexLinuxAppServerBackfillTimeoutMs("thread/start",3e4);turnTimeout=codexLinuxAppServerBackfillTimeoutMs("turn/start",3e4);`,
    context,
  );
  assert.equal(context.startupTimeout, 3e5);
  assert.equal(context.turnTimeout, 3e4);
});

test("keeps remote conversation hydration out of core", () => {
  const descriptors = corePatchDescriptors();

  for (const removedPatchId of [
    "linux-app-server-conversation-hydration",
    "linux-completed-resume-recovery",
    "linux-unowned-turn-claim",
    "linux-completed-item-recovery",
    "linux-remote-terminal-status-recovery",
  ]) {
    assert.equal(
      descriptors.some((patch) => patch.id === removedPatchId),
      false,
    );
  }
});

test("skips app-server timeout rewrite when the helper insertion anchor drifts", () => {
  const source =
    "class RequestClient{createRequest(e,t,n){let r=P(B()),i=n?.timeoutMs??0,a=Da(t),o=this.requestPromises.size;return{request:{id:r,method:e,params:t},conversationId:a,pending:o,timeoutMs:i}}}";

  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxAppServerBackfillWaitPatch(source),
  );

  assert.equal(patched, source);
  assert.match(warnings.join("\n"), /Could not insert app-server backfill wait helper/);
  assert.doesNotMatch(patched, /codexLinuxAppServerBackfillTimeoutMs\(/);
});

test("adds Linux package updater behind the existing app updater manager", () => {
  const patched = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, appUpdaterBundleFixture());

  assert.match(patched, /function codexLinuxGetElectronModule\(\)/);
  assert.match(patched, /function codexLinuxReadUpdateState\(\)/);
  assert.match(patched, /function codexLinuxUpdateLifecycleState\(e\)/);
  assert.match(patched, /function codexLinuxUpdateManagerPath\(\)/);
  assert.match(patched, /function codexLinuxUpdateManagerEnv\(\)/);
  assert.match(patched, /async function codexLinuxShowUpdateMessage\(codexLinuxMessage,codexLinuxDetail\)/);
  assert.match(patched, /function codexLinuxInstallAfterQuit\(\)/);
  assert.match(patched, /function codexLinuxQuitForUpdate\(\)/);
  assert.match(patched, /let e=codexLinuxGetElectronModule\(\);if\(!e\)return;await e\.dialog\?\.showMessageBox\(\{type:`info`/);
  assert.match(patched, /u\.spawn\(`\/bin\/sh`/);
  assert.match(patched, /install-ready\|\|exit \$\?/);
  assert.match(patched, /grep -q "\^status: WaitingForAppExit"/);
  assert.match(patched, /status: Installing/);
  assert.match(patched, /grep -q "\^status: Installed"/);
  assert.match(patched, /\/usr\/bin\/codex-desktop >\/dev\/null 2>&1 &/);
  assert.match(patched, /detached:!0,stdio:`ignore`/);
  assert.match(patched, /windowsHide:!0,env:codexLinuxUpdateManagerEnv\(\)/);
  assert.match(patched, /codexLinuxInstallAfterQuit\(\);let t=codexLinuxGetElectronModule\(\);if\(!t\)return;let e=setTimeout/);
  assert.match(patched, /t\.app\?\.quit\?\.\(\)/);
  assert.match(patched, /t\.app\?\.exit\?\.\(0\)/);
  assert.match(patched, /execFile\(codexLinuxUpdateManagerPath\(\),e/);
  assert.match(patched, /encoding:`utf8`,windowsHide:!0,env:codexLinuxUpdateManagerEnv\(\)/);
  assert.match(patched, /async function codexLinuxProbeUpdateManager\(\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`--help`\]\)/);
  assert.match(patched, /async function codexLinuxRefreshUpdateState\(\)/);
  assert.match(patched, /async function codexLinuxRefreshUpdateState\(\)\{return codexLinuxReadUpdateState\(\)\}/);
  assert.doesNotMatch(patched, /codexLinuxRunUpdateManager\(\[`status`,`--json`\]\)/);
  assert.match(patched, /await codexLinuxProbeUpdateManager\(\),e\(\)/);
  assert.match(patched, /if\(!this\.options\.enableUpdater&&process\.platform!==`linux`\)/);
  assert.match(patched, /process\.platform===`linux`\?await this\.initializeLinuxPackageUpdater\(\)/);
  assert.match(patched, /async initializeLinuxPackageUpdater\(\)/);
  assert.match(patched, /this\.updater=\{setAutomaticBackgroundDownloadsEnabled:\(\)=>\{\},checkForUpdates/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`check-now`\]\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`install-ready`\]\)/);
  assert.match(patched, /this\.setInstallProgressPercent\(0\),this\.setUpdateLifecycleState\(`installing`\)/);
  assert.match(patched, /this\.setInstallProgressPercent\(null\),codexLinuxQuitForUpdate\(\)/);
  assert.doesNotMatch(patched, /this\.options\.onInstallUpdatesRequested\?\.\(\)/);
  assert.match(patched, /n\.stdout\?\.includes\(`already installed`\)\?await codexLinuxShowUpdateMessage/);
  assert.match(patched, /if\(t\?\.status===`waiting_for_app_exit`\)/);
});

test("restores host LD_LIBRARY_PATH for Electron updater bridge commands", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(appUpdaterBundleFixture());
  const helperSource = patched.match(
    /function codexLinuxUpdateManagerEnv\(\)\{[\s\S]*?return e\}/,
  )?.[0];
  assert.ok(helperSource);

  const runHelper = (env) => {
    const context = { process: { env: { ...env } } };
    vm.runInNewContext(`${helperSource};globalThis.result=codexLinuxUpdateManagerEnv()`, context);
    return context.result;
  };

  for (const [state, value, expected] of [
    ["unset", "", undefined],
    ["empty", "", ""],
    ["value", "/home/user/lib", "/home/user/lib"],
  ]) {
    const result = runHelper({
      LD_LIBRARY_PATH: "/nix/app:/nix/runtime",
      CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE: state,
      CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE: value,
    });
    assert.equal(result.LD_LIBRARY_PATH, expected);
    assert.equal(Object.hasOwn(result, "CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE"), false);
  }

  const developmentResult = runHelper({
    LD_LIBRARY_PATH: "/developer/lib",
    CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE: "unset",
  });
  assert.equal(developmentResult.LD_LIBRARY_PATH, "/developer/lib");
  assert.equal(Object.hasOwn(developmentResult, "CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE"), false);
});

test("migrates updater helpers away from captured Electron aliases", () => {
  const patched = applyLinuxAppUpdaterBridgePatch(appUpdaterBundleFixture());
  const oldPatched = patched
    .replace(
      "function codexLinuxGetElectronModule(){try{return require(`electron`)}catch{return null}}",
      "",
    )
    .replace(
      "async function codexLinuxShowUpdateMessage(codexLinuxMessage,codexLinuxDetail){try{let e=codexLinuxGetElectronModule();if(!e)return;await e.dialog?.showMessageBox({type:`info`,buttons:[`OK`],defaultId:0,noLink:!0,message:codexLinuxMessage,detail:codexLinuxDetail})}catch{}}",
      "async function codexLinuxShowUpdateMessage(codexLinuxMessage,codexLinuxDetail){try{await electron.dialog?.showMessageBox({type:`info`,buttons:[`OK`],defaultId:0,noLink:!0,message:codexLinuxMessage,detail:codexLinuxDetail})}catch{}}",
    )
    .replace(
      "function codexLinuxQuitForUpdate(){try{codexLinuxInstallAfterQuit();let t=codexLinuxGetElectronModule();if(!t)return;let e=setTimeout(()=>t.app?.exit?.(0),1500);e.unref?.(),t.app?.quit?.()}catch{}}",
      "function codexLinuxQuitForUpdate(){try{codexLinuxInstallAfterQuit();let e=setTimeout(()=>electron.app?.exit?.(0),1500);e.unref?.(),electron.app?.quit?.()}catch{}}",
    );

  const migrated = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, oldPatched);

  assert.match(migrated, /function codexLinuxGetElectronModule\(\)\{try\{return require\(`electron`\)\}catch\{return null\}\}/);
  assert.match(migrated, /function codexLinuxQuitForUpdate\(\)\{try\{codexLinuxInstallAfterQuit\(\);let t=codexLinuxGetElectronModule\(\);if\(!t\)return;let e=setTimeout\(\(\)=>t\.app\?\.exit\?\.\(0\),1500\);e\.unref\?\.\(\),t\.app\?\.quit\?\.\(\)\}catch\{\}\}/);
  assert.doesNotMatch(migrated, /setTimeout\(\(\)=>electron\.app\?\.exit\?\.\(0\),1500\)/);
  assert.doesNotMatch(migrated, /await electron\.dialog\?\.showMessageBox/);
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
  assert.match(patched, /manager:\{setAutomaticBackgroundDownloadsEnabled:\(\)=>\{\}/);
  assert.match(patched, /getIsUpdateReady:\(\)=>s&&t/);
  assert.match(patched, /checkForUpdates:async\(\)=>\{if\(!await c\)return;n=`checking`/);
  assert.match(patched, /installUpdatesIfAvailable:async\(\)=>\{if\(!await c\)\{a\(\);return\}i\(\);if\(!t\)\{a\(\);return\}/);
  assert.match(patched, /e\.stdout\?\.includes\(`Manual install required:`\)\?await codexLinuxShowUpdateMessage/);
  assert.match(patched, /refresh:async\(\)=>\{if\(await c\)\{try\{await codexLinuxRefreshUpdateState\(\)\}/);
  assert.doesNotMatch(patched, /codexLinuxRunUpdateManager\(\[`status`,`--json`\]\)/);
});

test("adds Linux package updater to current bootstrap updater wiring after callback drift", () => {
  const patched = applyPatchTwice(
    applyLinuxAppUpdaterBridgePatch,
    currentBootstrapUpdaterBundleWithParametrizedQuitFixture(),
  );

  assert.match(patched, /function codexLinuxCreatePackageUpdateManager\(/);
  assert.match(patched, /codexLinuxPackageUpdateBridge=process\.platform===`linux`/);
  assert.match(patched, /s=codexLinuxPackageUpdateBridge\.manager/);
  assert.match(patched, /ne=codexLinuxPackageUpdateBridge\.quitForUpdate/);
  assert.match(patched, /send:e=>M\.sendMessageToAllRegisteredWindows\(e\)/);
});

test("adds Linux package updater to current bootstrap updater wiring after broadcast drift", () => {
  const patched = applyPatchTwice(
    applyLinuxAppUpdaterBridgePatch,
    currentBootstrapUpdaterBundleWithAppUpdateStateBroadcastFixture(),
  );

  assert.match(patched, /function codexLinuxCreatePackageUpdateManager\(/);
  assert.match(patched, /codexLinuxPackageUpdateBridge=process\.platform===`linux`/);
  assert.match(patched, /send:\(\)=>se\.broadcastAppUpdateState\(\)/);
  assert.match(patched, /s=codexLinuxPackageUpdateBridge\.manager/);
  assert.match(patched, /te=codexLinuxPackageUpdateBridge\.quitForUpdate/);
  assert.doesNotMatch(patched, /send:e=>se\.sendMessageToAllRegisteredWindows/);
});

test("adds Linux package updater to current bootstrap updater wiring when dispatcher is farther away", () => {
  const source = [
    "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`),u=require(`node:child_process`);",
    "c({onUpdateReadyChanged:e=>{a.sendMessageToAllRegisteredWindows({type:`app-update-ready-changed`,isUpdateReady:e})}});",
    "var rK={enabled:!1,running:!1,state:`disabled`};",
    "async function iK(){",
    "let{startedAtMs:r,buildFlavor:a,desktopSentry:o,sparkleManager:s,setSparkleBridgeHandlers:c,setSecondInstanceArgsHandler:l}=t.x(),d=t.T.shouldIncludeSparkle(a,process.platform,process.env);",
    "let M=oG({});let ee=pB(),te=()=>{ee.allowQuitTemporarilyForUpdateInstall(),n.app.quit()};",
    "c({onInstallProgressChanged:e=>{E&&M.sendMessageToAllRegisteredWindows({type:`app-update-install-progress-changed`,installProgressPercent:e})},onUpdateReadyChanged:e=>{M.sendMessageToAllRegisteredWindows({type:`app-update-ready-changed`,isUpdateReady:e})},onUpdateLifecycleStateChanged:e=>{M.sendMessageToAllRegisteredWindows({type:`app-update-lifecycle-state-changed`,lifecycleState:e})},",
    "let codexLinuxPadding=`" + "x".repeat(2000) + "`;",
    "onInstallUpdatesRequested:()=>{te()},isTrustedIpcEvent:N});",
    "}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, source);

  assert.match(patched, /function codexLinuxCreatePackageUpdateManager\(/);
  assert.match(patched, /send:e=>M\.sendMessageToAllRegisteredWindows\(e\)/);
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
      /function codexLinuxQuitForUpdate\(\)\{try\{codexLinuxInstallAfterQuit\(\);let t=codexLinuxGetElectronModule\(\);if\(!t\)return;let e=setTimeout\(\(\)=>t\.app\?\.exit\?\.\(0\),1500\);e\.unref\?\.\(\),t\.app\?\.quit\?\.\(\)\}catch\{\}\}/,
      "function codexLinuxQuitForUpdate(){try{let e=setTimeout(()=>t.app?.exit?.(0),1500);e.unref?.(),t.app?.quit?.()}catch{}}",
    )
    .replace("codexLinuxQuitForUpdate();return", "this.options.onInstallUpdatesRequested?.();return");
  assert.doesNotMatch(oldPatched, /function codexLinuxInstallAfterQuit\(\)/);
  assert.match(oldPatched, /this\.options\.onInstallUpdatesRequested\?\.\(\)/);
  const migrated = applyLinuxAppUpdaterBridgePatch(oldPatched);

  assert.match(migrated, /function codexLinuxInstallAfterQuit\(\)/);
  assert.match(migrated, /function codexLinuxQuitForUpdate\(\)/);
  assert.match(migrated, /codexLinuxInstallAfterQuit\(\);let t=codexLinuxGetElectronModule\(\);if\(!t\)return;let e=setTimeout/);
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

test("upgrades a rollout-gated Linux Computer Use descriptor", () => {
  const source = computerUseGateBundleFixture().replace(
    "{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:wn}",
    "{name:tn,isEnabled:({features:e,platform:t})=>(t===`darwin`||t===`linux`)&&e.computerUse,migrate:wn}",
  );

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /installWhenMissing:!0,name:tn/);
  assert.match(patched, /=>t===`linux`\|\|t===`darwin`&&e\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:tn/g) || []).length, 1);
});

test("patches marketplace selector Computer Use gate to keep Linux legacy MCP", () => {
  const source = [
    "function dl(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(
    patched,
    /if\(!\(\(\s*e.platform!==`darwin`&&e.platform!==`linux`\)\|\|!e.marketplacePluginNames.includes\(`computer-use`\)\)\)return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/,
  );
  assert.doesNotMatch(
    patched,
    /if\(!\(e.platform!==`darwin`\|\|!e.marketplacePluginNames.includes\(`computer-use`\)\)\)return e.desktopFeatureAvailability.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/,
  );
});

test("patches marketplace selector and plugin gate in one pass", () => {
  const source = [
    "var tn=`computer-use`;",
    "function dl(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}",
    "var $n=[{name:tn,isEnabled:({features:n,platform:r})=>r===`darwin`&&n.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(
    patched,
    /if\(!\(\(\s*e.platform!==`darwin`&&e.platform!==`linux`\)\|\|!e.marketplacePluginNames.includes\(`computer-use`\)\)\)return e.platform===`darwin`&&e.desktopFeatureAvailability.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/,
  );
  assert.match(
    patched,
    /installWhenMissing:!0,name:tn,isEnabled:\(\{features:n,platform:r\}\)=>r===`linux`\|\|r===`darwin`&&n\.computerUse,migrate:wn/,
  );
  assert.doesNotMatch(patched, /=>r===`darwin`&&n\.computerUse/);
});

test("keeps scanning Computer Use gates after an already patched match", () => {
  const source = [
    "var tn=`computer-use`;",
    "var $n=[{installWhenMissing:!0,name:tn,isEnabled:({features:e,platform:t})=>t===`linux`||t===`darwin`&&e.computerUse,migrate:on},{name:tn,isEnabled:({features:n,platform:r})=>r===`darwin`&&n.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(
    patched,
    /name:tn,isEnabled:\(\{features:n,platform:r\}\)=>r===`linux`\|\|r===`darwin`&&n\.computerUse,migrate:wn/,
  );
  assert.equal((patched.match(/installWhenMissing:!0,name:tn/g) || []).length, 2);
  assert.doesNotMatch(patched, /=>r===`darwin`&&n\.computerUse/);
});

test("patches all unpatched Computer Use gates in one pass", () => {
  const source = [
    "var tn=`computer-use`;",
    "var $n=[{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:on},{name:tn,isEnabled:({features:n,platform:r})=>r===`darwin`&&n.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyLinuxComputerUsePluginGatePatch(source);

  assert.equal((patched.match(/installWhenMissing:!0,name:tn/g) || []).length, 2);
  assert.match(patched, /t===`linux`\|\|t===`darwin`&&e\.computerUse/);
  assert.match(patched, /r===`linux`\|\|r===`darwin`&&n\.computerUse/);
  assert.doesNotMatch(patched, /=>[tr]===`darwin`&&/);
});

test("handles reordered Computer Use gate destructuring", () => {
  const darwinOnlySource = [
    "var tn=`computer-use`;",
    "var $n=[{name:tn,isEnabled:({platform:t,features:e})=>t===`darwin`&&e.computerUse,migrate:wn}];",
  ].join("");
  const alreadyLinuxEnabledSource = [
    "var tn=`computer-use`;",
    "var $n=[{installWhenMissing:!0,name:tn,isEnabled:({features:e,platform:t})=>t===`linux`||t===`darwin`&&e.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, darwinOnlySource);

  assert.match(
    patched,
    /\{installWhenMissing:!0,name:tn,isEnabled:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse,migrate:wn\}/,
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
    /name:`computer-use`,isEnabled:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse,migrate:wn/,
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
  assert.match(patchedBoundName, /t===`linux`\|\|t===`darwin`&&e\.computerUse/);
  assert.match(patchedLiteralName, /installWhenMissing:!0,name:'computer-use'/);
  assert.match(patchedLiteralName, /t===`linux`\|\|t===`darwin`&&e\.computerUse/);
});

test("patches the current Computer Use gate without touching the Windows-internal descriptor", () => {
  const source = [
    "var Ye=`browser-use`,Xe=`chrome-internal`,Ze=`computer-use`,Qe=`latex-tectonic`;",
    "var Dr=[{forceReload:!0,installWhenMissing:!0,name:Ye,isEnabled:({features:e})=>e.browserAgentAvailable,migrate:In},{forceReload:!0,name:Xe,isEnabled:({buildFlavor:e})=>Mn(e)},{name:Ze,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:Qn},{installWhenMissing:!0,name:Ze,isEnabled:({buildFlavor:e,features:n,platform:r})=>t.C.isInternal(e)&&r===`win32`&&n.computerUse},{name:Qe,isEnabled:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /name:Ze,isEnabled:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse,migrate:Qn/);
  assert.match(patched, /t\.C\.isInternal\(e\)&&r===`win32`&&n\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:Ze/g) || []).length, 2);
});

test("patches the current isAvailable Computer Use gate shape", () => {
  const source = currentPluginGateBundleFixture();

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /name:ft,isAvailable:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse,migrate:vr/);
  assert.match(patched, /t\.T\.isInternal\(e\)&&r===`win32`&&n\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:ft/g) || []).length, 2);
});

test("patches the Electron 42 Computer Use gate with descriptor metadata fields", () => {
  const source = [
    "var t={Oo:`computer-use`,No:e=>e};",
    "var Ua=[{autoInstallOptOutKey:t.No(t.Oo),installWhenMissing:!0,installWhenMissingRequiresOptIn:!0,name:t.Oo,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:ha},{autoInstallOptOutKey:t.No(t.Oo),installWhenMissing:!0,installWhenMissingRequiresOptIn:!0,name:t.Oo,isAvailable:({features:e,platform:t})=>t===`win32`&&e.computerUse}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /autoInstallOptOutKey:t\.No\(t\.Oo\),installWhenMissing:!0,installWhenMissingRequiresOptIn:!0,name:t\.Oo/);
  assert.match(patched, /isAvailable:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse,migrate:ha/);
  assert.match(patched, /isAvailable:\(\{features:e,platform:t\}\)=>t===`win32`&&e\.computerUse/);
});

test("auto-installs the current Chrome plugin gate shape", () => {
  const patched = applyPatchTwice(
    applyLinuxChromePluginAutoInstallPatch,
    currentChromePluginGateBundleFixture(),
  );

  assert.match(
    patched,
    /\{forceReload:!0,installWhenMissing:!0,name:o\.c,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,features:t\}\)=>process\.platform===`linux`\|\|\(t\.externalBrowserUseAllowed&&n\.Cs\(e\)\)\}/,
  );
  assert.match(patched, /name:o\.s,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,env:t,features:r\}\)=>Ar\(e,t\)&&r\.externalBrowserUseAllowed/);
  assert.equal((patched.match(/installWhenMissing:!0,name:o\.c/g) || []).length, 1);
  assert.equal((patched.match(/installWhenMissing:!0,name:o\.s/g) || []).length, 0);
});

test("makes Linux bundled plugin staging writable after copying read-only resources", async () => {
  const patched = applyPatchTwice(
    applyLinuxBundledPluginCopyPermissionsPatch,
    currentBundledPluginCopyBundleFixture(),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bundled-plugin-permissions-"));
  const sourcePlugin = path.join(root, "source-plugin");
  const sourceManifestDir = path.join(sourcePlugin, ".codex-plugin");
  const sourceManifest = path.join(sourceManifestDir, "plugin.json");
  const externalFile = path.join(root, "external-read-only-file");
  const sourceLink = path.join(sourcePlugin, "external-link");
  const targetPlugin = path.join(root, "target-plugin");
  const targetManifest = path.join(targetPlugin, ".codex-plugin", "plugin.json");
  const targetLink = path.join(targetPlugin, "external-link");

  try {
    fs.mkdirSync(sourceManifestDir, { recursive: true });
    fs.writeFileSync(sourceManifest, '{"name":"computer-use"}\n');
    fs.writeFileSync(externalFile, "external\n");
    fs.chmodSync(externalFile, 0o444);
    fs.symlinkSync(externalFile, sourceLink);
    fs.chmodSync(sourceManifest, 0o444);
    fs.chmodSync(sourceManifestDir, 0o555);
    fs.chmodSync(sourcePlugin, 0o555);

    const copyPlugin = new Function("process", "require", `${patched};return fl;`)(
      { platform: "linux" },
      require,
    );
    await copyPlugin(sourcePlugin, targetPlugin);
    fs.appendFileSync(targetManifest, "\n");

    assert.match(patched, /async function codexLinuxMakeBundledPluginTreeWritable/);
    assert.equal(fs.statSync(targetPlugin).mode & 0o200, 0o200);
    assert.equal(fs.statSync(targetManifest).mode & 0o200, 0o200);
    assert.equal(fs.lstatSync(targetLink).isSymbolicLink(), true);
    assert.equal(fs.statSync(externalFile).mode & 0o200, 0);
  } finally {
    fs.chmodSync(sourcePlugin, 0o755);
    fs.chmodSync(sourceManifestDir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function bundledPluginReconcileRaceFixture({
  capturedHashVar = "c",
  capturedSnapshotVar = "n",
  featureStateVar = "p",
  forceVar = "e",
  latestHashVar = "h",
  pendingVar = "v",
  reasonVar = "t",
  workerArgVar = "t",
  workerVar = "j",
} = {}) {
  return [
    `let ${featureStateVar}=null,${pendingVar}=Promise.resolve(),${latestHashVar}=null,calls=[],releasePreflight,preflightCount=0,markPreflightStarted;`,
    "let preflightStarted=new Promise(e=>{markPreflightStarted=e});",
    "let L=()=>({info(){}});",
    "let preflight=()=>++preflightCount===1?(markPreflightStarted(),new Promise(e=>{releasePreflight=e})):Promise.resolve();",
    "let destructive=async({appServerConnection:e,desktopFeatureAvailability:t})=>{calls.push(t);return {}};",
    `let E=({force:${forceVar},reason:${reasonVar}})=>{if(${featureStateVar}==null)return L().info(\`bundled_plugins_reconcile_skipped_features_unavailable\`,{safe:{reason:${reasonVar}},sensitive:{}}),${pendingVar};let ${capturedSnapshotVar}=${featureStateVar},${capturedHashVar}=JSON.stringify({externalBrowserUse:${capturedSnapshotVar}.externalBrowserUse,inAppBrowserUse:${capturedSnapshotVar}.inAppBrowserUse});if(!${forceVar}&&${latestHashVar}===${capturedHashVar})return ${pendingVar};${latestHashVar}=${capturedHashVar};return ${pendingVar}=${pendingVar}.catch(()=>{}).then(async()=>{L().info(\`bundled_plugins_reconcile_started\`,{safe:{reason:${reasonVar}},sensitive:{}});await ${workerVar}({desktopFeatureAvailability:${capturedSnapshotVar},reason:${reasonVar}})}),${pendingVar}};`,
    `let ${workerVar}=async ${workerArgVar}=>{await preflight();let v=async()=>{},y,h=\`shadowed-worker-local\`;try{y=await destructive({appServerConnection:null,desktopFeatureAvailability:${workerArgVar}.desktopFeatureAvailability})}finally{await v()}};`,
    `function setFeatures(e){${featureStateVar}=e;return E({force:!1,reason:\`startup\`})}`,
    "function getCalls(){return calls}",
    "function release(){releasePreflight()}",
    "function waitForPreflight(){return preflightStarted}",
  ].join("");
}

function bundledPluginReconcileRaceApi(source) {
  const patched = applyPatchTwice(
    applyLinuxBundledPluginReconcileStaleSnapshotPatch,
    source,
  );
  return {
    api: new Function(
      `${patched};return {setFeatures,getCalls,release,waitForPreflight};`,
    )(),
    patched,
  };
}

test("skips a queued bundled plugin reconcile that captured a stale feature snapshot", async () => {
  const { api, patched } = bundledPluginReconcileRaceApi(
    bundledPluginReconcileRaceFixture(),
  );

  api.setFeatures({ externalBrowserUse: false, inAppBrowserUse: false });
  await api.waitForPreflight();
  const latestReconcile = api.setFeatures({
    externalBrowserUse: true,
    inAppBrowserUse: true,
  });
  api.release();
  await latestReconcile;

  assert.deepEqual(api.getCalls(), [
    { externalBrowserUse: true, inAppBrowserUse: true },
  ]);
  assert.equal(
    (patched.match(/codex-linux-skip-stale-bundled-plugin-reconcile/g) || []).length,
    1,
  );
});

test("reconciles an authoritative disabled bundled plugin snapshot", async () => {
  const { api } = bundledPluginReconcileRaceApi(
    bundledPluginReconcileRaceFixture(),
  );

  const reconcile = api.setFeatures({
    externalBrowserUse: false,
    inAppBrowserUse: false,
  });
  await api.waitForPreflight();
  api.release();
  await reconcile;

  assert.deepEqual(api.getCalls(), [
    { externalBrowserUse: false, inAppBrowserUse: false },
  ]);
});

test("escapes dollar-prefixed bundled plugin reconcile identifiers", async () => {
  const { api, patched } = bundledPluginReconcileRaceApi(
    bundledPluginReconcileRaceFixture({
      capturedHashVar: "$c",
      capturedSnapshotVar: "$n",
      featureStateVar: "$p",
      forceVar: "$force",
      latestHashVar: "$h",
      pendingVar: "$v",
      reasonVar: "$reason",
      workerArgVar: "$t",
      workerVar: "$j",
    }),
  );

  api.setFeatures({ externalBrowserUse: false, inAppBrowserUse: false });
  await api.waitForPreflight();
  const latestReconcile = api.setFeatures({
    externalBrowserUse: true,
    inAppBrowserUse: true,
  });
  api.release();
  await latestReconcile;

  assert.deepEqual(api.getCalls(), [
    { externalBrowserUse: true, inAppBrowserUse: true },
  ]);
  assert.equal(
    (patched.match(/codex-linux-skip-stale-bundled-plugin-reconcile/g) || []).length,
    1,
  );
});

test("fails closed when the bundled plugin reconcile worker is ambiguous", () => {
  const source =
    bundledPluginReconcileRaceFixture() +
    "j=async q=>{let y;try{y=await destructive({appServerConnection:null})}finally{}};";
  const { value, warnings } = captureWarns(() =>
    applyLinuxBundledPluginReconcileStaleSnapshotPatch(source),
  );
  assert.equal(value, source);
  assert.match(warnings[0], /Expected one bundled plugin reconcile worker definition/);
});

test("fails closed when bundled plugin reconcile insertion order drifts", () => {
  const source = bundledPluginReconcileRaceFixture()
    .replace("h=c;return v=", "return v=")
    .replace("let j=async", "h=c;let j=async");
  const { value, warnings } = captureWarns(() =>
    applyLinuxBundledPluginReconcileStaleSnapshotPatch(source),
  );
  assert.equal(value, source);
  assert.match(warnings[0], /insertion order drifted/);
});

test("uses Linux managed runtime paths for Chrome native host sync", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    chromeNativeHostRuntimeBundleFixture(),
  );
  const files = new Set([
    "/opt/codex/resources/node-runtime/bin/node",
    "/opt/codex/resources/node_repl",
    "/home/josh/.local/bin/codex",
  ]);

  const result = vm.runInNewContext(
    `${patched};Qp({resourcesPath:"/opt/codex/resources",devRuntimeRepoRoot:null,nativeHostName:"com.openai.codexextension"});`,
    {
      require(moduleName) {
        if (moduleName === "node:path") {
          return path;
        }
        if (moduleName === "node:fs") {
          return {
            statSync(filePath) {
              if (!files.has(filePath)) {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              }
              return { isFile: () => true };
            },
          };
        }
        return require(moduleName);
      },
      process: {
        platform: "linux",
        env: {
          CODEX_CLI_PATH: "/home/josh/.local/bin/codex",
        },
      },
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    codexCliPath: "/home/josh/.local/bin/codex",
    nodePath: "/opt/codex/resources/node-runtime/bin/node",
    nodeReplPath: "/opt/codex/resources/node_repl",
  });
});

test("uses Linux managed runtime paths for current Chrome native host sync shape", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    currentChromeNativeHostRuntimeBundleFixture(),
  );
  const files = new Set([
    "/opt/codex/resources/node-runtime/bin/node",
    "/opt/codex/resources/node_repl",
    "/home/josh/.local/bin/codex",
  ]);

  const result = vm.runInNewContext(
    `${patched};QL({resourcesPath:"/opt/codex/resources",devRuntimeRepoRoot:null,nativeHostName:"com.openai.codexextension"});`,
    {
      require(moduleName) {
        if (moduleName === "node:path") {
          return path;
        }
        if (moduleName === "node:fs") {
          return {
            statSync(filePath) {
              if (!files.has(filePath)) {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              }
              return { isFile: () => true };
            },
          };
        }
        return require(moduleName);
      },
      process: {
        platform: "linux",
        env: {
          CODEX_CLI_PATH: "/home/josh/.local/bin/codex",
        },
      },
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    codexCliPath: "/home/josh/.local/bin/codex",
    nodeModuleDirs: [],
    nodePath: "/opt/codex/resources/node-runtime/bin/node",
    nodeReplPath: "/opt/codex/resources/node_repl",
  });
});

test("uses Linux managed runtime paths for Electron 42 Browser Use runtime resolver", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    electron42BrowserUseRuntimeResolverBundleFixture(),
  );

  assert.match(
    patched,
    /codexLinuxChromeNativeHostRuntimeEntry\(codexLinuxChromeNativeHostRuntimePath\(`codex`\),`linux-path`\)\?\?Wn/,
  );
  assert.match(
    patched,
    /codexLinuxChromeNativeHostRuntimeFile\(u,\[\[`node-runtime`,`bin`,r===`win32`\?`node\.exe`:`node`\]\]\)/,
  );
  assert.match(
    patched,
    /codexLinuxChromeNativeHostRuntimeFile\(u,\[\[r===`win32`\?`node_repl\.exe`:`node_repl`\]\]\)/,
  );
});

test("uses Linux managed runtime paths for current Chrome plugin app-server sync", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    currentChromePluginAppServerRuntimeBundleFixture(),
  );

  assert.match(patched, /ZB\(e\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_CLI_PATH`\)\?\?codexLinuxChromeNativeHostRuntimePath\(`codex`\)/);
  assert.match(patched, /NM\(e\.resourcesPath\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_BROWSER_USE_NODE_PATH`\)/);
  assert.match(patched, /codexLinuxChromeNativeHostRuntimeFile\(e\.resourcesPath,\[\[`node-runtime`,`bin`,process\.platform===`win32`\?`node\.exe`:`node`\]\]\)/);
  assert.match(patched, /MM\(e\.resourcesPath\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_NODE_REPL_PATH`\)/);
});

test("uses Linux Codex CLI path for Chrome plugin app-server sync", async () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    currentChromePluginCodexAppServerRuntimeBundleFixture(),
  );
  const files = new Set(["/home/josh/.local/bin/codex"]);

  const result = await vm.runInNewContext(
    `${patched};VH({resourcesPath:"/opt/codex/resources",devRuntimeRepoRoot:null,nativeHostName:"com.openai.codexextension"});`,
    {
      require(moduleName) {
        if (moduleName === "node:path") {
          return path;
        }
        if (moduleName === "node:fs") {
          return {
            statSync(filePath) {
              if (!files.has(filePath)) {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              }
              return { isFile: () => true };
            },
          };
        }
        return require(moduleName);
      },
      process: {
        platform: "linux",
        env: {
          CODEX_CLI_PATH: "/home/josh/.local/bin/codex",
          PATH: "",
        },
      },
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    codexCliPath: "/home/josh/.local/bin/codex",
  });
});

test("keeps the original Linux CLI path when Chrome plugin app-server sync would isolate it", async () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    currentChromePluginIsolatedAppServerRuntimeBundleFixture(),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-esm-cli-"));
  try {
    const packageDir = path.join(root, "CLI installs");
    const cliPath = path.join(packageDir, "codex");
    const isolatedPath = path.join(root, "isolated", "codex");
    fs.mkdirSync(path.dirname(isolatedPath), { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(packageDir, "dependency.js"), 'export const version = "esm-ok";\n');
    fs.writeFileSync(
      cliPath,
      '#!/usr/bin/env node\nimport { version } from "./dependency.js";\nconsole.log(version);\n',
    );
    fs.chmodSync(cliPath, 0o700);

    const result = await vm.runInNewContext(
      `${patched};VH({resourcesPath:"/opt/codex/resources",devRuntimeRepoRoot:null,nativeHostName:"com.openai.codexextension"});`,
      {
        require,
        process: {
          platform: "linux",
          env: {
            CODEX_CLI_PATH: cliPath,
            ISSUE805_ISOLATED_CLI: isolatedPath,
            PATH: "",
          },
        },
      },
    );

    assert.equal(result, cliPath);
    assert.equal(fs.existsSync(isolatedPath), false);
    assert.match(patched, /async function decoy\(e\)\{let t=e\.nativeHostName===nU;return `decoy`\}/);
    const execution = spawnSync(result, [], { encoding: "utf8" });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout.trim(), "esm-ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preserves Chrome plugin app-server isolation outside Linux", async () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    currentChromePluginIsolatedAppServerRuntimeBundleFixture(),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-non-linux-cli-"));
  try {
    const sourcePath = path.join(root, "source-codex");
    const isolatedPath = path.join(root, "isolated-codex");
    fs.writeFileSync(sourcePath, "source");

    const result = await vm.runInNewContext(
      `${patched};AV({codexCliPath:${JSON.stringify(sourcePath)},nativeHostName:"com.openai.codexextension"});`,
      {
        require,
        process: {
          platform: "darwin",
          env: { ISSUE805_ISOLATED_CLI: isolatedPath },
        },
      },
    );

    assert.equal(result, isolatedPath);
    assert.equal(fs.readFileSync(isolatedPath, "utf8"), "source");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patches multiple Chrome runtime resolvers in one Electron 42 bundle", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeNativeHostRuntimePatch,
    [
      electron42BrowserUseRuntimeResolverBundleFixture(),
      currentChromePluginCodexAppServerRuntimeBundleFixture(),
      currentChromePluginAppServerRuntimeBundleFixture(),
    ].join(""),
  );

  assert.match(
    patched,
    /codexLinuxChromeNativeHostRuntimeEntry\(codexLinuxChromeNativeHostRuntimePath\(`codex`\),`linux-path`\)\?\?Wn/,
  );
  assert.match(patched, /_U\(e\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_CLI_PATH`\)\?\?codexLinuxChromeNativeHostRuntimePath\(`codex`\)/);
  assert.match(patched, /ZB\(e\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_CLI_PATH`\)\?\?codexLinuxChromeNativeHostRuntimePath\(`codex`\)/);
  assert.match(patched, /NM\(e\.resourcesPath\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_BROWSER_USE_NODE_PATH`\)/);
  assert.equal((patched.match(/function codexLinuxChromeNativeHostRuntimeFile/g) || []).length, 1);
});

test("reports drifted Chrome native host runtime resolver as optional drift", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-chrome-runtime-drift-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        "let r=require(`node:path`),o=require(`node:fs`);",
        "function Qp(e){throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}.`)}",
      ].join(""),
    );

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const runtimePatch = report.patches.find((patch) => patch.name === "linux-chrome-native-host-runtime");
    assert.equal(runtimePatch.status, "skipped-optional");
    assert.match(runtimePatch.reason, /Could not identify Chrome native host runtime resolver shape/);
    assert.ok(
      !validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-chrome-native-host-runtime:"),
      ),
      "browser integration drift must not fail the build",
    );
    assert.ok(
      optionalDriftFromReport(report).some((drift) => drift.name === "linux-chrome-native-host-runtime"),
      "the drift must still be surfaced in the optional-drift summary",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("adds Linux availability to an already auto-installed Chrome plugin gate", () => {
  const source = currentChromePluginGateBundleFixture().replace(
    "{forceReload:!0,name:o.c,syncInstallStateWithChromeExtension:!0,isAvailable:",
    "{forceReload:!0,installWhenMissing:!0,name:o.c,syncInstallStateWithChromeExtension:!0,isAvailable:",
  );

  const patched = applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source);

  assert.match(
    patched,
    /installWhenMissing:!0,name:o\.c,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,features:t\}\)=>process\.platform===`linux`\|\|\(t\.externalBrowserUseAllowed&&n\.Cs\(e\)\)/,
  );
});

test("keeps a fully Linux-enabled Chrome plugin gate unchanged", () => {
  const source = currentChromePluginGateBundleFixture().replace(
    "{forceReload:!0,name:o.c,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&n.Cs(e)}",
    "{forceReload:!0,installWhenMissing:!0,name:o.c,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>process.platform===`linux`||(t.externalBrowserUseAllowed&&n.Cs(e))}",
  );

  assert.equal(applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source), source);
});

test("reports missing Chrome plugin auto-install gate as optional drift", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-chrome-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), `${mainBundlePrefix}var plugins=[];`);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const pluginGatePatch = report.patches.find((patch) => patch.name === "linux-chrome-plugin-auto-install");
    assert.equal(pluginGatePatch.status, "skipped-optional");
    assert.match(pluginGatePatch.reason, /Could not find Chrome plugin auto-install gate/);
    assert.ok(
      !validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-chrome-plugin-auto-install:"),
      ),
      "browser integration drift must not fail the build",
    );
    assert.ok(
      optionalDriftFromReport(report).some((drift) => drift.name === "linux-chrome-plugin-auto-install"),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("registers Linux Computer Use independently of the upstream rollout", () => {
  const source = [
    "var lt=`computer-use`;",
    "var Ur=[{autoInstallOptOutKey:e.Nn(e.Dn),forceReload:!0,installWhenMissing:!0,name:e.Dn,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:$n},{name:e.kn,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:mr},{installWhenMissing:!0,name:e.kn,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.T.isInternal(e)&&r===`win32`&&n.computerUse},{name:e.An,isAvailable:()=>!0}];",
  ].join("");

  const patched = applyPatchTwice(applyLinuxComputerUsePluginGatePatch, source);

  assert.match(patched, /installWhenMissing:!0,name:e\.kn,isAvailable:\(\{features:e,platform:t\}\)=>t===`linux`\|\|t===`darwin`&&e\.computerUse,migrate:mr/);
  assert.match(patched, /t\.T\.isInternal\(e\)&&r===`win32`&&n\.computerUse/);
  assert.equal((patched.match(/installWhenMissing:!0,name:e\.kn/g) || []).length, 2);
});

test("fails hard when the Computer Use gate is recognizable but unpatchable", () => {
  assert.throws(
    () => applyLinuxComputerUsePluginGatePatch("var tn=`computer-use`;var x=[{name:tn,isEnabled:({features:e,platform:t})=>isMac(t)&&e.computerUse,migrate:wn}];"),
    /Required Linux Computer Use plugin gate patch failed/,
  );
});

test("reports missing Computer Use plugin gate as optional drift", () => {
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
      !validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-computer-use-plugin-gate:"),
      ),
      "Computer Use is a feature — its drift must not fail the build",
    );
    assert.ok(
      optionalDriftFromReport(report).some((drift) => drift.name === "linux-computer-use-plugin-gate"),
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

test("enables nested current Computer Use desktop features on Linux", () => {
  const source =
    "function Ve(e,{buildFlavor:t=n.F.resolve(),env:r=p.default.env,platform:i=p.default.platform}={}){let a=i===`darwin`&&!n.F.isInternal(t)&&e.computerUseNodeRepl!=null?{...e,computerUseNodeRepl:!1}:e,o=i===`win32`&&e.computerUse===!0?{...a,computerUseNodeRepl:!0}:a,s=i===`win32`&&r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...o,computerUse:!0,computerUseNodeRepl:!0}:o,c=t===n.F.Dev?He(r):null;return c==null?{...s,deviceAttestation:ve({platform:i})}:{...s,...c,deviceAttestation:ve({platform:i})}}";

  const patched = applyPatchTwice(applyLinuxComputerUseFeaturePatch, source);

  assert.match(
    patched,
    /,s=i===`linux`\?\{\.\.\.o,computerUse:!0,computerUseNodeRepl:!0\}:i===`win32`&&r\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.o,computerUse:!0,computerUseNodeRepl:!0\}:o,/,
  );
  assert.match(patched, /i===`darwin`&&!n\.F\.isInternal\(t\)/);
  assert.match(patched, /i===`win32`&&e\.computerUse===!0/);
});

test("patches all Computer Use desktop feature gates in one pass", () => {
  const patchedFeature =
    "function A(e,{env:t=process.env,platform:n=process.platform}={}){return n===`linux`?{...e,computerUse:!0,computerUseNodeRepl:!0}:n!==`win32`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?e:{...e,computerUse:!0,computerUseNodeRepl:!0}}";
  const unpatchedFeature =
    "function B(e,{env:r=process.env,platform:i=process.platform}={}){return i!==`win32`||r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?e:{...e,computerUse:!0,computerUseNodeRepl:!0}}";

  const patched = applyLinuxComputerUseFeaturePatch(`${patchedFeature}${unpatchedFeature}`);

  assert.equal((patched.match(/===`linux`/g) || []).length, 2);
  assert.doesNotMatch(
    patched,
    /function B\(e,\{env:r=process\.env,platform:i=process\.platform\}=\{\}\)\{return i!==`win32`/,
  );
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

test("shows current Computer Use hook UI on Linux", () => {
  const source =
    "function p(e){return e===`macOS`||e===`windows`}" +
    "function m(e){let t=(0,d.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,{isLoading:o,platform:s}=l(),u=c(`1506311413`),m;t[0]===r?m=t[1]:(m={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=m);let h=f(m),g;t[2]===s?g=t[3]:(g=p(s),t[2]=s,t[3]=g);let _=a&&i&&u&&(o||g),v=_&&!o&&h.enabled&&!h.isLoading,y=_&&h.isLoading,b=_&&(o||h.isLoading),x;return x}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /function p\(e\)\{return e===`macOS`\|\|e===`windows`\|\|e===`linux`\}/);
  assert.match(
    patched,
    /let _=a&&i&&\(s===`linux`\|\|u&&\(o\|\|g\)\),v=_&&!o&&\(s===`linux`\|\|h\.enabled\)&&!h\.isLoading,y=_&&s!==`linux`&&h\.isLoading,b=_&&\(o\|\|s!==`linux`&&h\.isLoading\),x;/,
  );
});

test("enables Browser Use availability on Linux when only the Statsig gate is disabled", () => {
  const source =
    "function h(n){let r=(0,l.c)(13),{hostId:a}=n,s=t(c),d=i(`410262010`),f;r[0]===a?f=r[1]:(f={featureName:`browser_use`,hostId:a},r[0]=a,r[1]=f);let p=u(f),m=o(e.runCodexInWsl),h=p.enabled&&!p.isLoading,_=p.isLoading,v=m===!0,y;r[2]!==d||r[3]!==s||r[4]!==h||r[5]!==_||r[6]!==v?(y=g({isBrowserAgentGateEnabled:d,isBrowserSidebarEnabled:s,isBrowserUseEnabled:h,isLoading:_,runCodexInWsl:v,windowType:`electron`}),r[2]=d,r[3]=s,r[4]=h,r[5]=_,r[6]=v,r[7]=y):y=r[7];return y}";

  const patched = applyPatchTwice(applyLinuxBrowserUseAvailabilityPatch, source);

  assert.match(
    patched,
    /y=g\(\{isBrowserAgentGateEnabled:!0,isBrowserSidebarEnabled:s,isBrowserUseEnabled:h,isLoading:_,runCodexInWsl:v,windowType:`electron`\}\)/,
  );
  assert.match(patched, /isBrowserUseEnabled:h/);
  assert.match(patched, /featureName:`browser_use`/);
});

test("enables external Browser Use availability on Linux without the upstream rollout flag", () => {
  const source =
    "function m(e){let t=(0,l.c)(5),{hostId:n,windowType:r}=e,a=r===void 0?`electron`:r,o=i(`410065390`),s;t[0]===n?s=t[1]:(s={featureName:`browser_use_external`,hostId:n},t[0]=n,t[1]=s);let c=u(s),d=a===`chrome-extension`||o&&c.enabled&&!c.isLoading,f=a===`chrome-extension`?!1:c.isLoading,p;return t[2]!==d||t[3]!==f?(p={allowed:d,available:d,isLoading:f},t[2]=d,t[3]=f,t[4]=p):p=t[4],p}";

  const patched = applyPatchTwice(applyLinuxBrowserUseExternalAvailabilityPatch, source);

  assert.match(
    patched,
    /d=a===`chrome-extension`\|\|navigator\.userAgent\.includes\(`Linux`\)\|\|o&&c\.enabled&&!c\.isLoading/,
  );
  assert.match(
    patched,
    /f=a===`chrome-extension`\|\|navigator\.userAgent\.includes\(`Linux`\)\?!1:c\.isLoading/,
  );
  assert.match(patched, /featureName:`browser_use_external`/);
  assert.match(patched, /i\(`410065390`\)/);
});

test("keeps already patched external Browser Use availability unchanged", () => {
  const source =
    "function m(e){let t=(0,l.c)(5),{hostId:n,windowType:r}=e,a=r===void 0?`electron`:r,o=i(`410065390`),s;t[0]===n?s=t[1]:(s={featureName:`browser_use_external`,hostId:n},t[0]=n,t[1]=s);let c=u(s),d=a===`chrome-extension`||navigator.userAgent.includes(`Linux`)||o&&c.enabled&&!c.isLoading,f=a===`chrome-extension`||navigator.userAgent.includes(`Linux`)?!1:c.isLoading,p;return p}";

  assert.equal(applyPatchTwice(applyLinuxBrowserUseExternalAvailabilityPatch, source), source);
});

test("external Browser Use availability descriptor matches the current bundle name", () => {
  const descriptor = require("./patches/core/all-linux/webview/browser-use-external-availability/patch.js");

  assert.match("use-is-plugins-enabled-current.js", descriptor.pattern);
  assert.match("use-in-app-browser-use-availability-B4Bdb14G.js", descriptor.pattern);
});

test("allows Browser Use non-local navigation on Linux without the upstream rollout flag", () => {
  const source =
    "function mx(){let e=(0,Z.c)(20),t=q(Ss).value,n;e[0]===t?n=e[1]:(n=vs(t),e[0]=t,e[1]=n);let r=n,i=J(fl.activeTab$),a=J(Xn),o=ka(`3903563814`),s=ka(`2327881676`),c,l;e[2]!==i||e[3]!==r||e[4]!==a||e[5]!==t.pathname||e[6]!==t.search?(c=()=>{if(r==null)return;let e=ml(i,r);ci.dispatchMessage(`browser-sidebar-owner-sync`,{conversationId:r})},l=[i,r,a,t.pathname,t.search],e[2]=i,e[3]=r,e[4]=a,e[5]=t.pathname,e[6]=t.search,e[7]=c,e[8]=l):(c=e[7],l=e[8]),(0,$.useLayoutEffect)(c,l);let u,d;e[9]===o?(u=e[10],d=e[11]):(u=()=>{ux||ci.dispatchMessage(`browser-use-non-local-sites-allowed-changed`,{allowed:o})},d=[o],e[9]=o,e[10]=u,e[11]=d),(0,$.useEffect)(u,d);return null}";

  const patched = applyPatchTwice(applyLinuxBrowserUseNonLocalNavigationPatch, source);

  assert.match(
    patched,
    /dispatchMessage\(`browser-use-non-local-sites-allowed-changed`,\{allowed:!0\}\)/,
  );
  assert.match(patched, /ka\(`3903563814`\)/);
});

test("patches later Browser Use navigation dispatches when an earlier one is already patched", () => {
  const source =
    "function first(){let o=ka(`3903563814`);return()=>ci.dispatchMessage(`browser-use-non-local-sites-allowed-changed`,{allowed:!0})}" +
    "function second(){let p=ka(`3903563814`);return()=>ci.dispatchMessage(`browser-use-non-local-sites-allowed-changed`,{allowed:p})}";

  const patched = applyPatchTwice(applyLinuxBrowserUseNonLocalNavigationPatch, source);

  assert.equal(
    (patched.match(/browser-use-non-local-sites-allowed-changed`,\{allowed:!0\}/g) || []).length,
    2,
  );
  assert.doesNotMatch(patched, /browser-use-non-local-sites-allowed-changed`,\{allowed:p\}/);
});

test("hydrates local chat search results before navigating", () => {
  const source = [
    "function FS(e,t,n){let r=A(e);if(r!=null){t(r);return}n(L(e))}",
    "function tF({cloudTasks:e,conversationsMeta:t,hostIds:n}){return[...t.flatMap(e=>{if(!n.has(e.hostId??`local`))return[];let t=e.cwd??``,r=ye(e),i=(E(e)??t)||e.id,a=Dn(e.id);return[{kind:`local`,threadKey:Le(a),conversationId:a,threadId:e.id,title:r,searchTitle:i,cwd:t,branch:e.gitInfo?.branch??``,updatedAt:e.updatedAt,searchPreview:null}]}),...e?.map(e=>({kind:`remote`,threadKey:de(e.id)}))??[]]}",
    "function aF(e){let t=Dn(e.threadId);return{kind:`local`,threadKey:Le(t),conversationId:t,threadId:e.threadId,title:e.title,searchTitle:e.title,cwd:e.cwd,branch:``,updatedAt:e.updatedAt,searchPreview:e.searchPreview}}",
    "function MF(){let y=[He],C=`abc`,T=9;return $t({queryKey:[`command-menu-thread-search`,y,C,T],queryFn:async()=>(await Promise.allSettled(y.map(e=>nt(`search-threads-for-host`,{hostId:e,query:C,limit:T})))).flatMap(IF)})}",
    "function NF(e){return e.threadKey}function PF(e){return e.threadKey}",
    "function qF(e){let t=(0,Q.c)(40),{close:r,navigateToLocalConversation:o,result:s}=e,d=Fc(),v;t[20]!==r||t[21]!==d||t[22]!==o||t[23]!==s.threadKey?(v=()=>{FS(s.threadKey,o,d),r()},t[20]=r,t[21]=d,t[22]=o,t[23]=s.threadKey,t[24]=v):v=t[24];return v}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxChatSearchHydrationPatch, source);

  assert.match(patched, /function codexLinuxHydrateSearchConversation/);
  assert.match(
    patched,
    /nt\(`load-recent-conversation-ids-for-host`,\{hostId:n,conversationIds:\[t\]\}\)/,
  );
  assert.match(
    patched,
    /async function FS\(e,t,n\)\{let codexLinuxRouteKey=codexLinuxSearchThreadKey\(e\),r=A\(codexLinuxRouteKey\);if\(r!=null\)\{await codexLinuxHydrateSearchConversation\(e,r\);t\(r\);return\}n\(L\(codexLinuxRouteKey\)\)\}/,
  );
  assert.match(
    patched,
    /nt\(`search-threads-for-host`,\{hostId:e,query:C,limit:T\}\)\.then\(codexLinuxSearchResults=>codexLinuxSearchResults\.map\(codexLinuxSearchResult=>\(\{\.\.\.codexLinuxSearchResult,hostId:e\}\)\)\)/,
  );
  assert.match(patched, /return\[\{kind:`local`,hostId:e\.hostId\?\?`local`,threadKey:/);
  assert.match(patched, /return\{kind:`local`,hostId:e\.hostId\?\?`local`,threadKey:/);
  assert.match(patched, /function NF\(e\)\{return e\}function PF\(e\)\{return e\}/);
  assert.match(
    patched,
    /t\[20\]!==r\|\|t\[21\]!==d\|\|t\[22\]!==o\|\|t\[23\]!==s\?\(v=\(\)=>\{FS\(s,o,d\),r\(\)\},t\[20\]=r,t\[21\]=d,t\[22\]=o,t\[23\]=s,t\[24\]=v\):v=t\[24\]/,
  );
  assert.doesNotMatch(patched, /t\[23\]!==s\.threadKey/);
  assert.doesNotMatch(patched, /t\[23\]=s\.threadKey/);
});

test("hydrates current local chat search route helper before navigating", () => {
  const source = [
    "function MF(){let g=[He],b=`abc`,S=9;return $t({queryKey:[`command-menu-thread-search`,g,b,S],queryFn:async()=>(await Promise.allSettled(g.map(e=>_(`search-threads-for-host`,{hostId:e,query:b,limit:S})))).flatMap(e=>e.status===`fulfilled`?e.value:[])})}",
    "function MI(e,t,n,r){switch(e.kind){case`local`:case`remote`:Yh(e.threadKey,t,n);return;case`chatgpt`:return}}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxChatSearchHydrationPatch, source);

  assert.match(patched, /function codexLinuxHydrateSearchConversation/);
  assert.match(
    patched,
    /_\(`search-threads-for-host`,\{hostId:e,query:b,limit:S\}\)\.then\(codexLinuxSearchResults=>codexLinuxSearchResults\.map\(codexLinuxSearchResult=>\(\{\.\.\.codexLinuxSearchResult,hostId:e\}\)\)\)/,
  );
  assert.match(
    patched,
    /async function MI\(e,t,n,r\)\{switch\(e\.kind\)\{case`local`:await codexLinuxHydrateSearchConversation\(e,e\.threadKey\);Yh\(e\.threadKey,t,n\);return;case`remote`:Yh\(e\.threadKey,t,n\);return;case`chatgpt`:return\}\}/,
  );
});

test("resolves the requested live Linux Browser Use route window by id", () => {
  const source =
    "var kK=t.Ur(`browser-sidebar-manager`);" +
    "function AK({ensureWindowState:e,windowId:t,windows:n}){let i=n.get(t)??null;if(i==null){let n=r.BrowserWindow.fromId(t);n!=null&&!n.isDestroyed()&&!n.webContents.isDestroyed()&&(i=e(n,n.webContents))}return i==null||i.window.isDestroyed()||i.owner.isDestroyed()?(kK().warning(`IAB_LIFECYCLE route window is not live`,{safe:{hasWindowState:i!=null,ownerDestroyed:i?.owner.isDestroyed()??null,windowDestroyed:i?.window.isDestroyed()??null,windowId:t},sensitive:{}}),null):i}";

  const patched = applyPatchTwice(applyLinuxBrowserUseRouteLivenessPatch, source);

  assert.match(patched, /function codexLinuxResolveLiveBrowserUseRouteWindow/);
  assert.match(patched, /i==null&&\(i=codexLinuxResolveLiveBrowserUseRouteWindow\(e,t,n,r\)\);return/);
  assert.equal((patched.match(/codexLinuxResolveLiveBrowserUseRouteWindow/g) || []).length, 2);

  const requestedWebContents = { isDestroyed: () => false };
  const unrelatedWebContents = { isDestroyed: () => false };
  const requestedWindow = { id: 42, isDestroyed: () => false, webContents: requestedWebContents };
  const unrelatedWindow = { id: 7, isDestroyed: () => false, webContents: unrelatedWebContents };
  let warnings = 0;
  let getAllWindowsCalls = 0;
  const context = {
    process: { platform: "linux" },
    r: {
      BrowserWindow: {
        fromId: (id) => (id === 42 ? requestedWindow : null),
        getAllWindows: () => {
          getAllWindowsCalls += 1;
          return [unrelatedWindow];
        },
      },
    },
    t: { Ur: () => () => ({ warning: () => { warnings += 1; } }) },
  };
  const result = vm.runInNewContext(
    `${patched};AK({ensureWindowState:(window,owner)=>({owner,threads:new Map,window}),windowId:42,windows:new Map})`,
    context,
  );

  assert.equal(result.window.id, 42);
  assert.equal(result.owner, requestedWebContents);
  assert.equal(warnings, 0);
  assert.equal(getAllWindowsCalls, 0);
});

test("does not fall back to an unrelated single live Linux Browser Use route window", () => {
  const source =
    "var kK=t.Ur(`browser-sidebar-manager`);" +
    "function AK({ensureWindowState:e,windowId:t,windows:n}){let i=n.get(t)??null;if(i==null){let n=r.BrowserWindow.fromId(t);n!=null&&!n.isDestroyed()&&!n.webContents.isDestroyed()&&(i=e(n,n.webContents))}return i==null||i.window.isDestroyed()||i.owner.isDestroyed()?(kK().warning(`IAB_LIFECYCLE route window is not live`,{safe:{hasWindowState:i!=null,ownerDestroyed:i?.owner.isDestroyed()??null,windowDestroyed:i?.window.isDestroyed()??null,windowId:t},sensitive:{}}),null):i}";

  const patched = applyPatchTwice(applyLinuxBrowserUseRouteLivenessPatch, source);
  const webContents = { isDestroyed: () => false };
  const unrelatedWindow = { id: 7, isDestroyed: () => false, webContents };
  let warnings = 0;
  let getAllWindowsCalls = 0;
  const context = {
    process: { platform: "linux" },
    r: {
      BrowserWindow: {
        fromId: () => null,
        getAllWindows: () => {
          getAllWindowsCalls += 1;
          return [unrelatedWindow];
        },
      },
    },
    t: { Ur: () => () => ({ warning: () => { warnings += 1; } }) },
  };
  const result = vm.runInNewContext(
    `${patched};AK({ensureWindowState:(window,owner)=>({owner,window}),windowId:42,windows:new Map})`,
    context,
  );

  assert.equal(result, null);
  assert.equal(warnings, 1);
  assert.equal(getAllWindowsCalls, 0);
});

test("keeps Browser Use route liveness fallback inactive when ambiguous", () => {
  const source =
    "var kK=t.Ur(`browser-sidebar-manager`);" +
    "function AK({ensureWindowState:e,windowId:t,windows:n}){let i=n.get(t)??null;if(i==null){let n=r.BrowserWindow.fromId(t);n!=null&&!n.isDestroyed()&&!n.webContents.isDestroyed()&&(i=e(n,n.webContents))}return i==null||i.window.isDestroyed()||i.owner.isDestroyed()?(kK().warning(`IAB_LIFECYCLE route window is not live`,{safe:{hasWindowState:i!=null,ownerDestroyed:i?.owner.isDestroyed()??null,windowDestroyed:i?.window.isDestroyed()??null,windowId:t},sensitive:{}}),null):i}";
  const patched = applyLinuxBrowserUseRouteLivenessPatch(source);
  const webContents = { isDestroyed: () => false };
  const windows = [
    { id: 7, isDestroyed: () => false, webContents },
    { id: 8, isDestroyed: () => false, webContents },
  ];
  let warnings = 0;
  const context = {
    process: { platform: "linux" },
    r: { BrowserWindow: { fromId: () => null, getAllWindows: () => windows } },
    t: { Ur: () => () => ({ warning: () => { warnings += 1; } }) },
  };
  const result = vm.runInNewContext(
    `${patched};AK({ensureWindowState:(window,owner)=>({owner,window}),windowId:42,windows:new Map})`,
    context,
  );

  assert.equal(result, null);
  assert.equal(warnings, 1);
});

test("shows object-helper Computer Use plugin UI on Linux", () => {
  const source =
    "function m(e){return e===`macOS`||e===`windows`}" +
    "function h(e){let n=(0,f.c)(15),{enabled:r,hostId:i}=e,a=r===void 0?!0:r,{isLoading:o,platform:s}=u(),c=t(i).kind===`local`,d=l(`1506311413`),h;n[0]===i?h=n[1]:(h={featureName:`computer_use`,hostId:i},n[0]=i,n[1]=h);let _=p(h),v;n[2]!==_.enabled||n[3]!==_.isLoading||n[4]!==a||n[5]!==d||n[6]!==c||n[7]!==o||n[8]!==s?(v=g({enabled:a,isComputerUseFeatureEnabled:_.enabled,isComputerUseFeatureLoading:_.isLoading,isComputerUseGateEnabled:d,isHostCompatiblePlatform:m(s),isHostLocal:c,isPlatformLoading:o,windowType:`electron`}),n[2]=_.enabled,n[3]=_.isLoading,n[4]=a,n[5]=d,n[6]=c,n[7]=o,n[8]=s,n[9]=v):v=n[9];return v}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /function m\(e\)\{return e===`macOS`\|\|e===`windows`\|\|e===`linux`\}/);
  assert.match(
    patched,
    /v=g\(\{enabled:a,isComputerUseFeatureEnabled:s===`linux`\|\|_\.enabled,isComputerUseFeatureLoading:s!==`linux`&&_\.isLoading,isComputerUseGateEnabled:s===`linux`\|\|d,isHostCompatiblePlatform:s===`linux`\|\|m\(s\),isHostLocal:c,isPlatformLoading:o,windowType:`electron`\}\)/,
  );
});

test("shows object-helper Computer Use plugin UI on Linux without host-local field", () => {
  const source =
    "function d(e){return e===`macOS`||e===`windows`}" +
    "function f(e){let t=(0,l.c)(14),{enabled:n,hostId:r}=e,i=n===void 0?!0:n,{isLoading:o,platform:c}=s(),f=a(`1506311413`),m;t[0]===r?m=t[1]:(m={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=m);let h=u(m),g;t[2]!==h.enabled||t[3]!==h.isLoading||t[4]!==i||t[5]!==f||t[6]!==o||t[7]!==c?(g=p({enabled:i,isComputerUseFeatureEnabled:h.enabled,isComputerUseFeatureLoading:h.isLoading,isComputerUseGateEnabled:f,isHostCompatiblePlatform:d(c),isPlatformLoading:o,windowType:`electron`}),t[2]=h.enabled,t[3]=h.isLoading,t[4]=i,t[5]=f,t[6]=o,t[7]=c,t[8]=g):g=t[8];return g}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /function d\(e\)\{return e===`macOS`\|\|e===`windows`\|\|e===`linux`\}/);
  assert.match(
    patched,
    /g=p\(\{enabled:i,isComputerUseFeatureEnabled:c===`linux`\|\|h\.enabled,isComputerUseFeatureLoading:c!==`linux`&&h\.isLoading,isComputerUseGateEnabled:c===`linux`\|\|f,isHostCompatiblePlatform:c===`linux`\|\|d\(c\),isPlatformLoading:o,windowType:`electron`\}\)/,
  );
  assert.doesNotMatch(patched, /isHostLocal:/);
});

test("shows required-features Computer Use plugin UI on Linux", () => {
  const source =
    "function d(e){return e===`macOS`||e===`windows`}" +
    "function f(e){let t=(0,l.c)(16),{enabled:n,hostId:r}=e,i=n===void 0?!0:n,{isLoading:o,platform:c}=s(),f=a(`1506311413`),m;t[0]===r?m=t[1]:(m={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=m);let h=u(m),g;t[2]===r?g=t[3]:(g={featureName:`windows_computer_use`,hostId:r},t[2]=r,t[3]=g);let _=u(g),v=c===`windows`&&!o,y=h.isLoading||v&&_.isLoading,b=h.enabled&&(!v||_.enabled),x;t[4]!==b||t[5]!==i||t[6]!==y||t[7]!==f||t[8]!==o||t[9]!==c?(x=p({areRequiredFeaturesEnabled:b,enabled:i,isAnyFeatureLoading:y,isComputerUseGateEnabled:f,isHostCompatiblePlatform:d(c),isPlatformLoading:o,windowType:`electron`}),t[4]=b,t[5]=i,t[6]=y,t[7]=f,t[8]=o,t[9]=c,t[10]=x):x=t[10];return x}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /function d\(e\)\{return e===`macOS`\|\|e===`windows`\|\|e===`linux`\}/);
  assert.match(
    patched,
    /x=p\(\{areRequiredFeaturesEnabled:c===`linux`\|\|b,enabled:i,isAnyFeatureLoading:c===`linux`\?!1:y,isComputerUseGateEnabled:c===`linux`\|\|f,isHostCompatiblePlatform:c===`linux`\|\|d\(c\),isPlatformLoading:o,windowType:`electron`\}\)/,
  );
  assert.match(patched, /featureName:`windows_computer_use`/);
});

test("keeps object-helper Computer Use host compatibility on Linux when platform predicate drifts", () => {
  const source =
    "function m(e){return e===`macOS`||e===`windows`||q(e)}" +
    "function h(e){let n=(0,f.c)(15),{enabled:r,hostId:i}=e,a=r===void 0?!0:r,{isLoading:o,platform:s}=u(),c=t(i).kind===`local`,d=l(`1506311413`),h;n[0]===i?h=n[1]:(h={featureName:`computer_use`,hostId:i},n[0]=i,n[1]=h);let _=p(h),v;n[2]!==_.enabled||n[3]!==_.isLoading||n[4]!==a||n[5]!==d||n[6]!==c||n[7]!==o||n[8]!==s?(v=g({enabled:a,isComputerUseFeatureEnabled:_.enabled,isComputerUseFeatureLoading:_.isLoading,isComputerUseGateEnabled:d,isHostCompatiblePlatform:m(s),isHostLocal:c,isPlatformLoading:o,windowType:`electron`}),n[2]=_.enabled,n[3]=_.isLoading,n[4]=a,n[5]=d,n[6]=c,n[7]=o,n[8]=s,n[9]=v):v=n[9];return v}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /function m\(e\)\{return e===`macOS`\|\|e===`windows`\|\|q\(e\)\}/);
  assert.match(
    patched,
    /v=g\(\{enabled:a,isComputerUseFeatureEnabled:s===`linux`\|\|_\.enabled,isComputerUseFeatureLoading:s!==`linux`&&_\.isLoading,isComputerUseGateEnabled:s===`linux`\|\|d,isHostCompatiblePlatform:s===`linux`\|\|m\(s\),isHostLocal:c,isPlatformLoading:o,windowType:`electron`\}\)/,
  );
});

test("Computer Use availability descriptor matches the current settings bundle name", () => {
  const [descriptor] = require("./patches/core/all-linux/webview/computer-use-ui/patch.js");

  assert.match("computer-use-settings-B1QCeMSP.js", descriptor.pattern);
  assert.doesNotMatch("use-model-settings-5PHNqYL4.js", descriptor.pattern);
  assert.doesNotMatch("use-is-plugins-enabled-current.js", descriptor.pattern);
  assert.doesNotMatch("use-native-apps.electron-DhuUEit1.js", descriptor.pattern);
});

test("keeps current Computer Use settings availability enabled on Linux", () => {
  const source =
    "let availability=useAvailability(arg),{platform:platform}=usePlatform();" +
    "let props={computerUseAvailability:availability,platform:platform};" +
    "availability.available&&render(props);";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(
    patched,
    /platform===`linux`&&\(availability=\{\.\.\.availability,available:!0,isFetching:!1,isLoading:!1\}\);/,
  );
});

test("does not give synthetic Computer Use plugin cards an invalid marketplace directory path", () => {
  const source =
    "let {computerUseAvailability:availability,platform:platform}=state;" +
    "let pluginsQuery=usePlugins(selectedHost,emptyPlugins),marketplacePath=useMarketplacePath(selectedHost),featureFlag=useFeatureFlag(featureFlagArg),computerUsePlugin;" +
    "computerUsePlugin=selectPlugin(pluginsQuery.availablePlugins,pluginName,marketplacePath);";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /marketplaceName:`openai-bundled`/);
  assert.doesNotMatch(patched, /marketplaceName:`openai-curated`/);
  assert.match(patched, /marketplacePath:marketplacePath/);
  assert.doesNotMatch(patched, /marketplacePath:`openai-bundled\/plugins\/computer-use`/);
});

test("warns without partially patching when Computer Use renderer availability gate drifts", () => {
  const source =
    "function g(e){return e===`macOS`||e===`windows`}" +
    "const isComputerUseAvailable=true;" +
    "function _(e){let t=(0,d.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,{isLoading:o,platform:c}=u(),l=s(`1506311413`),f;t[0]===r?f=t[1]:(f={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=f);let p=h(f),m;t[2]===c?m=t[3]:(m=g(c),t[2]=c,t[3]=m);let _=a&&i&&l&&(o||m||drifted),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;return x}";

  const { value: patched, warnings } = captureWarns(() =>
    applyLinuxComputerUseRendererAvailabilityPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find Computer Use renderer availability gate — skipping Linux Computer Use UI availability patch",
  ]);
});

test("patches all Computer Use renderer availability gates in one pass", () => {
  const source = [
    "let m=a&&(i||l===`linux`)&&s===`electron`&&(l===`linux`||u&&(c||p)),h=m&&!c&&(l===`linux`||f.enabled)&&!f.isLoading,g=m&&l!==`linux`&&f.isLoading,_=m&&(c||l!==`linux`&&f.isLoading),v;",
    "let _=a&&i&&l&&(o||m),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;",
  ].join("");

  const patched = applyLinuxComputerUseRendererAvailabilityPatch(source);

  assert.match(patched, /c===`linux`\|\|l&&\(o\|\|m\)/);
  assert.doesNotMatch(patched, /let _=a&&i&&l&&\(o\|\|m\)/);
});

test("enables native app mentions on Linux in the current Computer Use picker", () => {
  const source =
    "function Iz(e){let t=(0,Lz.c)(9),{enabled:n}=e,{platform:r,isLoading:i}=yt(),a=n&&(r===`macOS`||r===`windows`),o;t[0]===Symbol.for(`react.memo_cache_sentinel`)?(o={order:`usage`},t[0]=o):o=t[0];let s;t[1]===a?s=t[2]:(s={params:o,queryConfig:{enabled:a,staleTime:fe.FIVE_MINUTES,refetchOnWindowFocus:!1}},t[1]=a,t[2]=s);let c=Ce(`native-desktop-apps`,s),l;t[3]!==c||t[4]!==a?(l=a?c.data?.apps??[]:[],t[3]=c,t[4]=a,t[5]=l):l=t[5];let u=i||a&&c.isLoading,d;return t[6]!==l||t[7]!==u?(d={nativeApps:l,isLoading:u},t[6]=l,t[7]=u,t[8]=d):d=t[8],d}" +
    "function Ope(e){let{platform:u}=yt(),v=l.formatMessage({id:`computerUse.label`,defaultMessage:`Computer use`}),y=n[0]??null,b=[{description:l.formatMessage({id:`computerUse.nativeApps.microsoftExcel.detail`,defaultMessage:`Live workbook control`})}],D;t[4]===r?D=t[5]:(D=e=>({queryKey:ve(`computer-use-native-desktop-app-icon`,{appPath:e.appPath}),queryFn:()=>ie(`computer-use-native-desktop-app-icon`,{params:{appPath:e.appPath}}),enabled:r!=null,staleTime:fe.INFINITE,refetchOnWindowFocus:!1}),t[4]=r,t[5]=D);return v}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /a=n&&\(r===`macOS`\|\|r===`windows`\|\|r===`linux`\)/);
  assert.doesNotMatch(patched, /a=n&&\(r===`macOS`\|\|r===`windows`\)/);
});

test("enables native app usage queries on Linux when Computer Use labels move out of the chunk", () => {
  const source =
    "function Iz(e){let t=(0,Lz.c)(9),{enabled:n}=e,{platform:r,isLoading:i}=yt(),a=n&&(r===`macOS`||r===`windows`),o;t[0]===Symbol.for(`react.memo_cache_sentinel`)?(o={order:`usage`},t[0]=o):o=t[0];let s;t[1]===a?s=t[2]:(s={params:o,queryConfig:{enabled:a,staleTime:fe.FIVE_MINUTES,refetchOnWindowFocus:!1}},t[1]=a,t[2]=s);let c=Ce(`native-desktop-apps`,s),l;t[3]!==c||t[4]!==a?(l=a?c.data?.apps??[]:[],t[3]=c,t[4]=a,t[5]=l):l=t[5];let u=i||a&&c.isLoading,d;return t[6]!==l||t[7]!==u?(d={nativeApps:l,isLoading:u},t[6]=l,t[7]=u,t[8]=d):d=t[8],d}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);

  assert.match(patched, /a=n&&\(r===`macOS`\|\|r===`windows`\|\|r===`linux`\)/);
  assert.doesNotMatch(patched, /a=n&&\(r===`macOS`\|\|r===`windows`\)/);
});

test("scopes unlabeled native app usage gate patch away from adjacent platform gates", () => {
  const source =
    "function unrelated(e){let{enabled:n}=e,{platform:r}=yt(),a=n&&(r===`macOS`||r===`windows`);return a}" +
    "function Iz(e){let t=(0,Lz.c)(9),{enabled:o}=e,{platform:c,isLoading:l}=yt(),u=o&&(c===`macOS`||c===`windows`),p;t[0]===Symbol.for(`react.memo_cache_sentinel`)?(p={order:`usage`},t[0]=p):p=t[0];let s;t[1]===u?s=t[2]:(s={params:p,queryConfig:{enabled:u,staleTime:fe.FIVE_MINUTES,refetchOnWindowFocus:!1}},t[1]=u,t[2]=s);let h=Ce(`native-desktop-apps`,s),g;t[3]!==h||t[4]!==u?(g=u?h.data?.apps??[]:[],t[3]=h,t[4]=u,t[5]=g):g=t[5];let m=l||u&&h.isLoading,d;return t[6]!==g||t[7]!==m?(d={nativeApps:g,isLoading:m},t[6]=g,t[7]=m,t[8]=d):d=t[8],d}";

  const patched = applyPatchTwice(applyLinuxComputerUseRendererAvailabilityPatch, source);
  const unrelatedFunction = patched.slice(
    patched.indexOf("function unrelated"),
    patched.indexOf("function Iz"),
  );

  assert.match(unrelatedFunction, /a=n&&\(r===`macOS`\|\|r===`windows`\)/);
  assert.doesNotMatch(unrelatedFunction, /`linux`/);
  assert.match(patched, /u=o&&\(c===`macOS`\|\|c===`windows`\|\|c===`linux`\)/);
});

test("does not enable unrelated native desktop app queries on Linux", () => {
  const source =
    "function useNativeApps(e){let{enabled:n}=e,{platform:r,isLoading:i}=yt(),a=n&&(r===`macOS`||r===`windows`),o={params:{order:`usage`},queryConfig:{enabled:a}};return Ce(`native-desktop-apps`,o)}";

  assert.equal(applyLinuxComputerUseRendererAvailabilityPatch(source), source);
});

test("allows the current Computer Use platform while preserving upstream gates", () => {
  const source =
    "function Rj(e){return e===`macOS`||e===`windows`}" +
    "function zj(e){let t=(0,Uj.c)(16),{enabled:n,hostId:r}=e,i=n===void 0?!0:n,{isLoading:a,platform:o}=Xt(),s=cn(`1506311413`),c;t[0]===r?c=t[1]:(c={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=c);let l=Fj(c),u=o===`windows`&&!a,d=i&&u,f;t[2]===d?f=t[3]:(f={enabled:d},t[2]=d,t[3]=f);let p=Bj(f),m=l.isLoading||u&&p.isLoading,h=l.enabled&&(!u||p.enabled),g;t[4]!==h||t[5]!==i||t[6]!==m||t[7]!==s||t[8]!==a||t[9]!==o?(g=Hj({areRequiredFeaturesEnabled:h,enabled:i,isAnyFeatureLoading:m,isComputerUseGateEnabled:s,isHostCompatiblePlatform:Rj(o),isPlatformLoading:a,windowType:`electron`}),t[4]=h,t[5]=i,t[6]=m,t[7]=s,t[8]=a,t[9]=o,t[10]=g):g=t[10];return g}";

  const patched = applyPatchTwice(applyLinuxComputerUseInstallFlowPatch, source);

  assert.match(
    patched,
    /g=Hj\(\{areRequiredFeaturesEnabled:h,enabled:i,isAnyFeatureLoading:m,isComputerUseGateEnabled:s,isHostCompatiblePlatform:o===`linux`\|\|Rj\(o\),isPlatformLoading:a,windowType:`electron`\}\)/,
  );
  assert.doesNotMatch(patched, /areRequiredFeaturesEnabled:o===`linux`|isComputerUseGateEnabled:o===`linux`/);
});

function externalOpenChildClosingWith(code) {
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit("close", code));
  return child;
}

function externalOpenChildFailingWith(error) {
  const child = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => child.emit("error", error));
  return child;
}

function evaluatePatchedExternalOpen({
  env = {},
  platform = "linux",
  spawn = () => {
    throw new Error("unexpected xdg-open spawn");
  },
  originalOpenExternal = async () => undefined,
} = {}) {
  const originalCalls = [];
  const electron = {
    shell: {
      openExternal(url, options) {
        originalCalls.push({ url, options });
        return originalOpenExternal(url, options);
      },
    },
  };
  const source =
    "\"use strict\";let e=require(`electron`);async function openExternal(url,options){return e.shell.openExternal(url,options)}";
  const patched = applyPatchTwice(applyLinuxExternalOpenEnvPatch, source);
  const openExternal = vm.runInNewContext(`${patched};openExternal`, {
    require(moduleName) {
      if (moduleName === "electron") return electron;
      if (moduleName === "node:child_process") return { spawn };
      throw new Error(`unexpected module: ${moduleName}`);
    },
    process: { platform, env },
    setTimeout,
    clearTimeout,
  });
  return { openExternal, originalCalls };
}

test("sanitizes Linux external-open environment before xdg-open", async () => {
  const spawnCalls = [];
  const env = {
    PATH: "/usr/bin",
    DISPLAY: ":1",
    LD_LIBRARY_PATH: "/tmp/bad",
    LD_PRELOAD: "/tmp/preload.so",
    NODE_OPTIONS: "--require /tmp/hook.js",
    CODEX_LINUX_WEBVIEW_PORT: "1234",
  };
  const { openExternal, originalCalls } = evaluatePatchedExternalOpen({
    env,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return externalOpenChildClosingWith(0);
    },
  });

  await openExternal("https://example.test/docs");

  assert.deepEqual(originalCalls, []);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "xdg-open");
  assert.deepEqual(Array.from(spawnCalls[0].args), ["https://example.test/docs"]);
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.stdio, "ignore");
  assert.equal(spawnCalls[0].options.env.PATH, "/usr/bin");
  assert.equal(spawnCalls[0].options.env.DISPLAY, ":1");
  for (const key of [
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "NODE_OPTIONS",
    "CODEX_LINUX_WEBVIEW_PORT",
  ]) {
    assert.equal(Object.hasOwn(spawnCalls[0].options.env, key), false);
  }
});

test("delegates non-string Linux external-open targets to Electron", async () => {
  const target = { href: "https://example.test/docs" };
  const options = { activate: false };
  const { openExternal, originalCalls } = evaluatePatchedExternalOpen({
    originalOpenExternal: async () => "delegated",
  });

  assert.equal(await openExternal(target, options), "delegated");
  assert.deepEqual(originalCalls, [{ url: target, options }]);
});

test("delegates Linux external-open calls with options to Electron", async () => {
  const options = { activate: false };
  const { openExternal, originalCalls } = evaluatePatchedExternalOpen({
    originalOpenExternal: async () => "delegated",
  });

  assert.equal(await openExternal("https://example.test/docs", options), "delegated");
  assert.deepEqual(originalCalls, [{ url: "https://example.test/docs", options }]);
});

test("falls back to Electron when sanitized xdg-open spawning fails", async () => {
  const { openExternal, originalCalls } = evaluatePatchedExternalOpen({
    spawn: () => externalOpenChildFailingWith(new Error("xdg-open missing")),
    originalOpenExternal: async () => "fallback",
  });

  assert.equal(await openExternal("https://example.test/docs"), "fallback");
  assert.deepEqual(originalCalls, [{ url: "https://example.test/docs", options: undefined }]);
});

test("keeps already-applied Linux external-open patch quiet", () => {
  const source =
    "\"use strict\";let e=require(`electron`);async function openExternal(url,options){return e.shell.openExternal(url,options)}";
  const patched = applyLinuxExternalOpenEnvPatch(source);
  const { value, warnings } = captureWarns(() => applyLinuxExternalOpenEnvPatch(patched));

  assert.equal(value, patched);
  assert.deepEqual(warnings, []);
});

test("warns when Linux external-open helper exists without wrapped Electron require", () => {
  const source =
    "\"use strict\";function codexLinuxPatchExternalOpen(e){return e}let {shell:e}=require(`electron`);";
  const { value, warnings } = captureWarns(() => applyLinuxExternalOpenEnvPatch(source));

  assert.equal(value, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find Electron require initializer — skipping Linux external open environment patch",
  ]);
});

test("disables xdg-open path when CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH=1", async () => {
  const spawnCalls = [];
  const { openExternal, originalCalls } = evaluatePatchedExternalOpen({
    env: { CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH: "1" },
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return externalOpenChildClosingWith(0);
    },
    originalOpenExternal: async () => "delegated",
  });

  assert.equal(await openExternal("https://example.test/docs"), "delegated");
  assert.equal(spawnCalls.length, 0, "should not spawn xdg-open when env var is set");
  assert.deepEqual(originalCalls, [{ url: "https://example.test/docs", options: undefined }]);
});

test("uses xdg-open path when CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH is not 1", async () => {
  const spawnCalls = [];
  const env = {
    PATH: "/usr/bin",
    DISPLAY: ":1",
    CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH: "0",
  };
  const { openExternal, originalCalls } = evaluatePatchedExternalOpen({
    env,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return externalOpenChildClosingWith(0);
    },
  });

  await openExternal("https://example.test/docs");

  assert.deepEqual(originalCalls, []);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "xdg-open");
});

test("trusts the current direct Browser Use node_repl runtime config builder", () => {
  const source = currentBrowserUseTrustedHashesRuntimeBuilderFixture();

  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyBrowserUseNodeReplApprovalPatch, source),
  );

  assert.deepEqual(warnings, []);
  assert.doesNotMatch(patched, /tools:\{js:\{approval_mode:`approve`\}\}/);
  assert.match(patched, currentBrowserUseTrustedHashesInsertionRegex);
  assert.equal(
    (patched.match(/function codexLinuxTrustedBrowserClientSha256s/g) || []).length,
    1,
  );
});

test("ignores the removed Browser Use async trusted-hash setup shape", () => {
  const source =
    "\"use strict\";let l=require(`node:fs`),s=require(`node:path`),u=require(`node:crypto`),d=[`upstream-hash`];async function build({resourcesPath:p,trustedBrowserClientSha256s:h=d}){return h}";
  const { value, warnings } = captureWarns(() =>
    applyBrowserUseNodeReplApprovalPatch(source),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("ignores Browser Use schema-only trusted hash fields", () => {
  const source =
    "var schema={nodePath:EH,nodeReplPath:EH,platform:G().catch(`unknown`),trustedBrowserClientSha256s:DH};";
  const { value, warnings } = captureWarns(() =>
    applyBrowserUseNodeReplApprovalPatch(source),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("patches re-chunked Browser Use trust hash and approval assets", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-rechunked-"));
  try {
    const buildDir = path.join(extractedDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const mainChunk = path.join(buildDir, "main-current.js");
    const srcChunk = path.join(buildDir, "src-current.js");
    fs.writeFileSync(
      mainChunk,
      currentBrowserUseTrustedHashesRuntimeBuilderFixture(),
      "utf8",
    );
    fs.writeFileSync(
      srcChunk,
      "return{[`mcp_servers.${pt}`]:{args:[],command:i,env:n,startup_timeout_sec:120}}",
      "utf8",
    );

    const result = applyBrowserUseNodeReplApprovalAssets(extractedDir);

    assert.deepEqual(result, { matched: 2, changed: 2 });
    const patchedMain = fs.readFileSync(mainChunk, "utf8");
    const patchedSrc = fs.readFileSync(srcChunk, "utf8");
    assert.match(patchedMain, /function codexLinuxTrustedBrowserClientSha256s/);
    assert.match(patchedMain, currentBrowserUseTrustedHashesInsertionRegex);
    assert.match(patchedSrc, /tools:\{js:\{approval_mode:`approve`\}\}/);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("trusts Linux patched bundled Browser Use clients through the current direct builder", async () => {
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-current-browser-client-hash-"));
  try {
    const browserClient = path.join(
      resourcesRoot,
      "plugins",
      "openai-bundled",
      "plugins",
      "browser",
      "scripts",
      "browser-client.mjs",
    );
    const chromeClient = path.join(
      resourcesRoot,
      "plugins",
      "openai-bundled",
      "plugins",
      "chrome",
      "scripts",
      "browser-client.mjs",
    );
    fs.mkdirSync(path.dirname(browserClient), { recursive: true });
    fs.mkdirSync(path.dirname(chromeClient), { recursive: true });
    fs.writeFileSync(browserClient, "patched current browser client\n", "utf8");
    fs.writeFileSync(chromeClient, "patched current chrome client\n", "utf8");
    const browserHash = cryptoHash("patched current browser client\n");
    const chromeHash = cryptoHash("patched current chrome client\n");
    const source = currentBrowserUseTrustedHashesRuntimeBuilderFixture();

    const patched = applyPatchTwice(applyBrowserUseNodeReplApprovalPatch, source);

    assert.match(patched, /^"use strict";function codexLinuxTrustedBrowserClientSha256s/);
    assert.doesNotMatch(patched, /tools:\{js:\{approval_mode:`approve`\}\}/);
    assert.match(patched, currentBrowserUseTrustedHashesInsertionRegex);
    assert.equal(
      (patched.match(/function codexLinuxTrustedBrowserClientSha256s/g) || []).length,
      1,
    );
    const linuxHashes = await vm.runInNewContext(
      `${patched};build({trustedBrowserClientSha256s:[\`upstream-hash\`]});`,
      {
        require,
        process: { platform: "linux", resourcesPath: resourcesRoot },
      },
    );
    assert.deepEqual(Array.from(linuxHashes), ["upstream-hash", browserHash, chromeHash]);
  } finally {
    fs.rmSync(resourcesRoot, { recursive: true, force: true });
  }
});

test("patchMainBundleSource does not force the in-app browser panel visible", () => {
  const source =
    "var CF=class{async createTabForBrowserUse(e){let t=this.getActiveBrowserUseTab(e,{assertCurrentPageAllowed:!1});if(t!=null)return await this.navigateTabToInitialPage(t),this.serializeTab(t);let n=this.getRequiredBrowserHost(e);n.setBrowserUseActive(!0,e.turnId);let r=await n.openPageForBrowserUse({startingUrl:this.initialPageUrl,turnId:e.turnId}),i=this.updateTabForPage(r,n.routeKey);return SF().info(`IAB_LIFECYCLE iab createTab mapped page to tab`,{}),this.markBrowserUseCommandForTab(e,i),this.selectedTabIdsByRouteKey.set(n.routeKey,i.cdpTabId),this.serializeTab(i)}};";

  const patched = patchMainBundleSource(source, null);

  assert.equal(patched, source);
  assert.doesNotMatch(patched, /setBrowserVisibleForBrowserUse/);
  assert.doesNotMatch(patched, /codexLinuxBrowserUseAutoVisible/);
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
    /if\(__codexPlatform===`linux`\)return codexLinuxChromeHasExtension\(\{extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform\}\)/,
  );
  assert.match(
    patched,
    /if\(__codexPlatform===`linux`\)\{let __codexChromeCommand=codexLinuxChromeCommand\(\)\?\?__codexDetectChromeCommand\(\);if\(__codexChromeCommand==null\)throw Error\(`Google Chrome, Brave, or Chromium is not installed`\);await __codexRunCommand\(__codexChromeCommand,\[cm\(__codexExtensionId\)\]\);return\}/,
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
  assert.match(
    patched,
    /let __codexValidatedExtensionId=um\(__codexExtensionId\);for\(let __codexProfileRoot of codexLinuxChromeProfileRoots/,
  );
  assert.match(
    patched,
    /function om\(\{extensionId:__codexExtensionId,homeDir:__codexHomeDir=\(0,r\.homedir\)\(\)/,
  );
  assert.match(
    patched,
    /__codexProfileDir=dm\(\{homeDir:__codexHomeDir,localAppDataDir:__codexLocalAppDataDir,platform:__codexPlatform\}\)/,
  );
  assert.match(
    patched,
    /async function sm\(\{extensionId:__codexExtensionId,platform:__codexPlatform=process\.platform,detectChromeCommand:__codexDetectChromeCommand=cm,runCommand:__codexRunCommand=zp\}\)/,
  );
  assert.match(patched, /await __codexRunCommand\(rm,\[`-b`,nm,am\(__codexExtensionId\)\]\)/);
  assert.match(
    patched,
    /if\(__codexPlatform===`linux`\)\{let __codexChromeCommand=codexLinuxChromeCommand\(\)\?\?__codexDetectChromeCommand\(\);if\(__codexChromeCommand==null\)throw Error\(`Google Chrome, Brave, or Chromium is not installed`\);await __codexRunCommand\(__codexChromeCommand,\[am\(__codexExtensionId\)\]\);return\}/,
  );
});

test("opens Linux Chrome extension settings without command helper TDZ", async () => {
  const patched = applyPatchTwice(
    applyLinuxChromeExtensionStatusPatch,
    currentChromeExtensionStatusBundleFixture(),
  );
  const commands = [];

  await vm.runInNewContext(
    `${patched};sm({extensionId:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",platform:"linux",detectChromeCommand:()=>null,runCommand:async(e,t)=>commands.push([e,t])});`,
    {
      commands,
      require(moduleName) {
        if (moduleName === "node:os") {
          return { homedir: () => "/home/josh" };
        }
        if (moduleName === "node:path") {
          return path;
        }
        if (moduleName === "node:fs") {
          return {
            existsSync: (filePath) => filePath === "/opt/bin/brave-browser",
            statSync: (filePath) => {
              if (filePath !== "/opt/bin/brave-browser") {
                throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
              }
              return { isFile: () => true };
            },
            readdirSync: () => [],
          };
        }
        return require(moduleName);
      },
      process: {
        platform: "linux",
        env: { PATH: "/opt/bin" },
      },
    },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
    ["/opt/bin/brave-browser", ["chrome://extensions/?id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]],
  ]);
});

test("checks Linux Chrome extension status when minifier aliases collide", () => {
  const patched = applyPatchTwice(
    applyLinuxChromeExtensionStatusPatch,
    currentChromeExtensionStatusAliasCollisionBundleFixture(),
  );

  const result = vm.runInNewContext(
    `${patched};om({extensionId:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",platform:"linux"});`,
    {
      require(moduleName) {
        if (moduleName === "node:os") {
          return { homedir: () => "/home/josh" };
        }
        if (moduleName === "node:path") {
          return path;
        }
        if (moduleName === "node:fs") {
          return {
            existsSync: () => false,
            readdirSync: () => [],
          };
        }
        return require(moduleName);
      },
      process: {
        platform: "linux",
        env: {},
      },
    },
  );

  assert.equal(result, false);
});

function withIsolatedHome(body) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-cu-ui-test-"));
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousAppId = process.env.CODEX_APP_ID;
  const previousLinuxAppId = process.env.CODEX_LINUX_APP_ID;
  const previousSettingsFile = process.env.CODEX_LINUX_SETTINGS_FILE;
  const previousFlag = process.env[COMPUTER_USE_UI_ENV_VAR];
  process.env.HOME = tempHome;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.CODEX_APP_ID;
  delete process.env.CODEX_LINUX_APP_ID;
  delete process.env.CODEX_LINUX_SETTINGS_FILE;
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
    if (previousSettingsFile == null) {
      delete process.env.CODEX_LINUX_SETTINGS_FILE;
    } else {
      process.env.CODEX_LINUX_SETTINGS_FILE = previousSettingsFile;
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

test("isComputerUseUiEnabled prefers CODEX_LINUX_APP_ID settings", () => {
  withIsolatedHome((home) => {
    process.env.CODEX_LINUX_APP_ID = "codex-cua-lab";
    process.env.CODEX_APP_ID = "codex-desktop";
    writeSettingsFile(home, JSON.stringify({ [COMPUTER_USE_UI_SETTINGS_KEY]: true }), "codex-cua-lab");
    assert.equal(isComputerUseUiEnabled(), true);
  });
});

test("isComputerUseUiEnabled honours CODEX_LINUX_SETTINGS_FILE", () => {
  withIsolatedHome((home) => {
    const settingsFile = path.join(home, "custom-settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ [COMPUTER_USE_UI_SETTINGS_KEY]: true }), "utf8");
    process.env.CODEX_LINUX_SETTINGS_FILE = settingsFile;
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
    assert.match(patched, /t===`linux`\|\|t===`darwin`&&e\.computerUse/);
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
    assert.match(patched, /t===`linux`\|\|t===`darwin`&&e\.computerUse/);
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
    currentMainBundlePrefix,
    "process.platform===`win32`&&k.removeMenu(),",
    currentOpaqueWindowSurfaceBackgroundBundle,
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
  assert.match(patched, /process\.platform===`linux`&&k\.removeMenu\(\)/);
  assert.match(patched, /linux:\{label:`File Manager`/);
  assert.match(
    patched,
    /process\.platform!==`win32`&&process\.platform!==`darwin`&&process\.platform!==`linux`\?null:/,
  );
  assert.match(
    patched,
    /process\.platform===`linux`&&process\.env\.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n\.app\.requestSingleInstanceLock\(\)/,
  );
  assert.match(patched, /t===`linux`\|\|t===`darwin`&&e\.computerUse/);
  assert.doesNotMatch(patched, /setIcon\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\//);
  assert.doesNotMatch(
    patched,
    /nativeImage\.createFromPath\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\//,
  );
});

test("patchMainBundleSource stays idempotent after wrapping the Electron require", () => {
  const source = [
    currentMainBundlePrefix,
    trayBundleFixture().replaceAll("n.", "c."),
  ].join("");

  const patched = patchMainBundleSource(source, "app-test.png");

  assert.equal(patchMainBundleSource(patched, "app-test.png"), patched);
  assert.match(
    patched,
    /setLinuxTrayContextMenu\(\)\{let e=c\.Menu\.buildFromTemplate/,
  );
  assert.doesNotMatch(
    patched,
    /setLinuxTrayContextMenu\(\)\{let e=n\.Menu\.buildFromTemplate/,
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

test("falls back when Electron Owl feature binding is absent on Linux", () => {
  const source =
    "var Ge={parse:e=>e};function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)throw Error(`Owl feature binding is unavailable`);return Ge.parse(e.call(process,`electron_common_owl_features`))}";

  const patched = applyPatchTwice(applyLinuxOwlFeatureBindingFallbackPatch, source);

  assert.match(patched, /No such binding was linked/);
  assert.match(patched, /isOwlFeatureEnabled:\(\)=>!1/);
  assert.match(patched, /throw t/);

  const sandbox = {
    process: {
      _linkedBinding() {
        throw new Error("No such binding was linked: electron_common_owl_features");
      },
    },
    result: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${patched};result=Qe().isOwlFeatureEnabled(\`SomeOwlFlag\`);`, sandbox);

  assert.equal(sandbox.result, false);
});

test("preserves real Electron Owl feature binding when available", () => {
  const source =
    "var Ge={parse:e=>e};function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)throw Error(`Owl feature binding is unavailable`);return Ge.parse(e.call(process,`electron_common_owl_features`))}";

  const patched = applyPatchTwice(applyLinuxOwlFeatureBindingFallbackPatch, source);
  const sandbox = {
    process: {
      _linkedBinding(name) {
        assert.equal(name, "electron_common_owl_features");
        return { isOwlFeatureEnabled: (feature) => feature === "EnabledOwlFlag" };
      },
    },
    enabled: null,
    disabled: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${patched};enabled=Qe().isOwlFeatureEnabled(\`EnabledOwlFlag\`);disabled=Qe().isOwlFeatureEnabled(\`OtherOwlFlag\`);`,
    sandbox,
  );

  assert.equal(sandbox.enabled, true);
  assert.equal(sandbox.disabled, false);
});

test("patches Electron Owl feature binding fallback outside the main bundle", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-owl-feature-build-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const bundlePath = path.join(buildDir, "workspace-root-drop-handler-test.js");
    fs.writeFileSync(
      bundlePath,
      "var Ge={parse:e=>e};function Qe(){let e=process._linkedBinding;if(typeof e!=`function`)throw Error(`Owl feature binding is unavailable`);return Ge.parse(e.call(process,`electron_common_owl_features`))}",
      "utf8",
    );

    assert.deepEqual(patchLinuxOwlFeatureBindingFallbackAssets(tempRoot), {
      matched: 1,
      changed: 1,
    });
    assert.match(fs.readFileSync(bundlePath, "utf8"), /isOwlFeatureEnabled:\(\)=>!1/);
    assert.deepEqual(patchLinuxOwlFeatureBindingFallbackAssets(tempRoot), {
      matched: 1,
      changed: 0,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
        currentOpaqueWindowSurfaceBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(
      path.join(assetsDir, "general-settings-test.js"),
      "function sn(){let{canImportThemeString:u,setThemePatch:b,theme:x}=p(t),S=vn(r,t),k=[{label:i}],A=[];return x.opaqueWindows}",
    );
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    patchExtractedApp(tempRoot);

    const patchedMainPath = path.join(buildDir, "main.js");
    const patchedThemePath = path.join(assetsDir, "general-settings-test.js");
    const patchedPackagePath = path.join(tempRoot, "package.json");
    const patchedMain = fs.readFileSync(patchedMainPath, "utf8");
    const patchedTheme = fs.readFileSync(patchedThemePath, "utf8");
    const patchedPackageRaw = fs.readFileSync(patchedPackagePath, "utf8");
    const patchedPackage = JSON.parse(patchedPackageRaw);

    patchExtractedApp(tempRoot);

    assert.match(patchedMain, /linux:\{label:`File Manager`/);
    assert.match(patchedTheme, /includes\(`Linux`\)/);
    assert.equal(patchedPackage.desktopName, "codex-desktop.desktop");
    assert.equal(fs.readFileSync(patchedMainPath, "utf8"), patchedMain);
    assert.equal(fs.readFileSync(patchedThemePath, "utf8"), patchedTheme);
    assert.equal(fs.readFileSync(patchedPackagePath, "utf8"), patchedPackageRaw);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patchExtractedApp scans current Computer Use settings bundles when UI is enabled", () => {
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
          currentOpaqueWindowSurfaceBackgroundBundle,
          fileManagerBundle,
          trayBundleFixture(),
          singleInstanceBundleFixture(),
        ].join(""),
      );
      fs.writeFileSync(
        path.join(assetsDir, "computer-use-settings-apps-current.js"),
        "function g(e){return e===`macOS`||e===`windows`}" +
          "function _(e){let t=(0,d.c)(8),{enabled:n,hostId:r,isHostLocal:i}=e,a=n===void 0?!0:n,{isLoading:o,platform:c}=u(),l=s(`1506311413`),f;t[0]===r?f=t[1]:(f={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=f);let p=h(f),m;t[2]===c?m=t[3]:(m=g(c),t[2]=c,t[3]=m);let _=a&&i&&l&&(o||m),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;return x}",
      );
      fs.writeFileSync(
        path.join(assetsDir, "computer-use-settings-plugins-current.js"),
        "function p(e){return e===`macOS`||e===`windows`}" +
          "function m(e){let n=(0,f.c)(15),{enabled:r,hostId:i}=e,a=r===void 0?!0:r,{isLoading:o,platform:s}=u(),c=t(i).kind===`local`,d=l(`1506311413`),h;n[0]===i?h=n[1]:(h={featureName:`computer_use`,hostId:i},n[0]=i,n[1]=h);let _=p(h),v;n[2]!==_.enabled||n[3]!==_.isLoading||n[4]!==a||n[5]!==d||n[6]!==c||n[7]!==o||n[8]!==s?(v=g({enabled:a,isComputerUseFeatureEnabled:_.enabled,isComputerUseFeatureLoading:_.isLoading,isComputerUseGateEnabled:d,isHostCompatiblePlatform:p(s),isHostLocal:c,isPlatformLoading:o,windowType:`electron`}),n[2]=_.enabled,n[3]=_.isLoading,n[4]=a,n[5]=d,n[6]=c,n[7]=o,n[8]=s,n[9]=v):v=n[9];return v}",
      );
      fs.writeFileSync(
        path.join(
          assetsDir,
          "computer-use-settings-native-apps-current.js",
        ),
        "function Iz(e){let t=(0,Lz.c)(9),{enabled:n}=e,{platform:r,isLoading:i}=yt(),a=n&&(r===`macOS`||r===`windows`),o;t[0]===Symbol.for(`react.memo_cache_sentinel`)?(o={order:`usage`},t[0]=o):o=t[0];let s;t[1]===a?s=t[2]:(s={params:o,queryConfig:{enabled:a,staleTime:fe.FIVE_MINUTES,refetchOnWindowFocus:!1}},t[1]=a,t[2]=s);let c=Ce(`native-desktop-apps`,s),l;t[3]!==c||t[4]!==a?(l=a?c.data?.apps??[]:[],t[3]=c,t[4]=a,t[5]=l):l=t[5];let u=i||a&&c.isLoading,d;return t[6]!==l||t[7]!==u?(d={nativeApps:l,isLoading:u},t[6]=l,t[7]=u,t[8]=d):d=t[8],d}" +
          "function Ope(e){let{platform:u}=yt(),v=l.formatMessage({id:`computerUse.label`,defaultMessage:`Computer use`}),y=n[0]??null,b=[{description:l.formatMessage({id:`computerUse.nativeApps.microsoftExcel.detail`,defaultMessage:`Live workbook control`})}],D;t[4]===r?D=t[5]:(D=e=>({queryKey:ve(`computer-use-native-desktop-app-icon`,{appPath:e.appPath}),queryFn:()=>ie(`computer-use-native-desktop-app-icon`,{params:{appPath:e.appPath}}),enabled:r!=null,staleTime:fe.INFINITE,refetchOnWindowFocus:!1}),t[4]=r,t[5]=D);return v}",
      );
      fs.writeFileSync(
        path.join(
          assetsDir,
          "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-current.js",
        ),
        "function _p(e){return e===`macOS`||e===`windows`}" +
          "function vp(e){let t=(0,Sp.c)(16),{enabled:n,hostId:r}=e,i=n===void 0?!0:n,{isLoading:a,platform:o}=ba(),s=gr(`1506311413`),c;t[0]===r?c=t[1]:(c={featureName:`computer_use`,hostId:r},t[0]=r,t[1]=c);let l=mp(c),u=o===`windows`&&!a,d=i&&u,f;t[2]===d?f=t[3]:(f={enabled:d},t[2]=d,t[3]=f);let p=yp(f),m=l.isLoading||u&&p.isLoading,h=l.enabled&&(!u||p.enabled),g;t[4]!==h||t[5]!==i||t[6]!==m||t[7]!==s||t[8]!==a||t[9]!==o?(g=xp({areRequiredFeaturesEnabled:h,enabled:i,isAnyFeatureLoading:m,isComputerUseGateEnabled:s,isHostCompatiblePlatform:_p(o),isPlatformLoading:a,windowType:`electron`}),t[4]=h,t[5]=i,t[6]=m,t[7]=s,t[8]=a,t[9]=o,t[10]=g):g=t[10];return g}",
      );
      fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

      patchExtractedApp(tempRoot);

      assert.match(
        fs.readFileSync(path.join(assetsDir, "computer-use-settings-apps-current.js"), "utf8"),
        /let _=a&&i&&\(c===`linux`\|\|l&&\(o\|\|m\)\),v=_&&!o&&\(c===`linux`\|\|p\.enabled\)&&!p\.isLoading/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "computer-use-settings-plugins-current.js"), "utf8"),
        /v=g\(\{enabled:a,isComputerUseFeatureEnabled:s===`linux`\|\|_\.enabled,isComputerUseFeatureLoading:s!==`linux`&&_\.isLoading,isComputerUseGateEnabled:s===`linux`\|\|d,isHostCompatiblePlatform:s===`linux`\|\|p\(s\),isHostLocal:c,isPlatformLoading:o,windowType:`electron`\}\)/,
      );
      assert.match(
        fs.readFileSync(
          path.join(
            assetsDir,
            "computer-use-settings-native-apps-current.js",
          ),
          "utf8",
        ),
        /a=n&&\(r===`macOS`\|\|r===`windows`\|\|r===`linux`\)/,
      );
      assert.match(
        fs.readFileSync(
          path.join(
            assetsDir,
            "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-current.js",
          ),
          "utf8",
        ),
        /g=xp\(\{areRequiredFeaturesEnabled:h,enabled:i,isAnyFeatureLoading:m,isComputerUseGateEnabled:s,isHostCompatiblePlatform:o===`linux`\|\|_p\(o\),isPlatformLoading:a,windowType:`electron`\}\)/,
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
        currentOpaqueWindowSurfaceBackgroundBundle,
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
    assert.deepEqual(report.enabledFeatures, enabledLinuxFeatureIds());
    // Browser/Computer Use integration drift is optional, but window-shell
    // drift is critical: this partial fixture lacks the titlebar shape.
    assert.ok(
      report.patches.some(
        (patch) =>
          patch.name === "main-process-ui" &&
          patch.status === "failed-required" &&
          patch.sourceKind === "core" &&
          Array.isArray(patch.warnings) &&
          patch.warnings.some((warning) => warning.includes("Linux native titlebar patch")),
      ),
    );
    assert.ok(
      criticalFailuresFromReport(report).some((failure) => failure.name === "linux-native-titlebar"),
    );
    assert.ok(
      optionalDriftFromReport(report).some((drift) => drift.name === "linux-chrome-plugin-auto-install"),
    );
    assert.ok(report.patches.some((patch) => patch.name === "keybinds-settings" && patch.status === "skipped-optional"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("feature patch descriptors honor explicit feature config overrides", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-patch-override-"));
  try {
    const featuresRoot = path.join(tempRoot, "linux-features");
    const featureDir = path.join(featuresRoot, "temp-feature");
    const featureConfigPath = path.join(tempRoot, "custom-features.json");
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), JSON.stringify({ enabled: [] }));
    fs.writeFileSync(
      path.join(featureDir, "feature.json"),
      JSON.stringify({
        id: "temp-feature",
        title: "Temp Feature",
        defaultEnabled: false,
        entrypoints: { patchDescriptors: "./patch.js" },
      }),
    );
    fs.writeFileSync(path.join(featureDir, "README.md"), "# Temp Feature\n");
    fs.writeFileSync(
      path.join(featureDir, "patch.js"),
      [
        "\"use strict\";",
        "module.exports=[{",
        "id:\"temp-feature-main-bundle\",",
        "phase:\"main-bundle\",",
        "ciPolicy:\"optional\",",
        "apply:(source)=>source",
        "}];",
      ].join("\n"),
    );
    fs.writeFileSync(featureConfigPath, JSON.stringify({ enabled: ["temp-feature"] }));

    const descriptors = featurePatchDescriptors({ featuresRoot, featuresConfigPath: featureConfigPath });
    assert.ok(descriptors.some((descriptor) => descriptor.id === "feature:temp-feature:temp-feature-main-bundle"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patchExtractedApp report honors explicit feature config overrides", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-feature-override-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    const assetsDir = path.join(tempRoot, "webview", "assets");
    const featuresRoot = path.join(tempRoot, "linux-features");
    const featureDir = path.join(featuresRoot, "temp-feature");
    const featureConfigPath = path.join(tempRoot, "custom-features.json");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        mainBundlePrefix,
        "process.platform===`win32`&&k.removeMenu(),",
        "codexTempFeatureDisabled()",
      ].join(""),
    );
    fs.writeFileSync(path.join(assetsDir, "app-test.png"), "");
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));
    fs.writeFileSync(path.join(featuresRoot, "features.example.json"), JSON.stringify({ enabled: [] }));
    fs.writeFileSync(
      path.join(featureDir, "feature.json"),
      JSON.stringify({
        id: "temp-feature",
        title: "Temp Feature",
        defaultEnabled: false,
        entrypoints: { patchDescriptors: "./patch.js" },
      }),
    );
    fs.writeFileSync(path.join(featureDir, "README.md"), "# Temp Feature\n");
    fs.writeFileSync(
      path.join(featureDir, "patch.js"),
      [
        "\"use strict\";",
        "module.exports=[{",
        "id:\"temp-feature-main-bundle\",",
        "phase:\"main-bundle\",",
        "ciPolicy:\"optional\",",
        "apply:(source)=>source.includes(\"codexTempFeatureDisabled()\")?source.replace(\"codexTempFeatureDisabled()\",\"codexTempFeatureEnabled()\"):(source)",
        "}];",
      ].join("\n"),
    );
    fs.writeFileSync(featureConfigPath, JSON.stringify({ enabled: ["temp-feature"] }));

    const report = createPatchReport();
    patchExtractedApp(tempRoot, { report, featuresRoot, featuresConfigPath: featureConfigPath });

    assert.deepEqual(report.enabledFeatures, ["temp-feature"]);
    assert.ok(
      report.patches.some(
        (patch) =>
          patch.name === "feature:temp-feature:temp-feature-main-bundle" && patch.status === "applied",
      ),
    );
    assert.match(fs.readFileSync(path.join(buildDir, "main.js"), "utf8"), /codexTempFeatureEnabled\(\)/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch report summary separates required core, optional core, and optional feature drift", () => {
  const summary = summarizePatchReport({
    enabledFeatures: ["remote-mobile-control"],
    patches: [
      { name: "main-process-ui", status: "applied", sourceKind: "core", ciPolicy: "required-upstream" },
      { name: "linux-app-updater-bridge", status: "skipped-optional", sourceKind: "core", ciPolicy: "optional" },
      {
        name: "feature:remote-mobile-control:linux-remote-mobile-conversation-hydration",
        status: "applied-with-warnings",
        sourceKind: "feature",
        featureId: "remote-mobile-control",
        ciPolicy: "optional",
      },
    ],
  });

  assert.deepEqual(summary.enabledFeatures, ["remote-mobile-control"]);
  assert.deepEqual(summary.groups.requiredCore.statusCounts, { applied: 1 });
  assert.deepEqual(summary.groups.optionalCore.statusCounts, { "skipped-optional": 1 });
  assert.deepEqual(summary.groups.optionalFeatures.statusCounts, { "applied-with-warnings": 1 });
  assert.equal(summary.groups.optionalFeatures.byFeature["remote-mobile-control"].count, 1);
});

test("main-process-ui aggregate ignores optional main-bundle drift warnings", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-optional-main-drift-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    const coreRoot = path.join(tempRoot, "core-patches");
    const requiredPatchDir = path.join(coreRoot, "all-linux", "main-process", "required-test");
    const optionalPatchDir = path.join(coreRoot, "all-linux", "main-process", "optional-test");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(requiredPatchDir, { recursive: true });
    fs.mkdirSync(optionalPatchDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "codexRequiredPatchOff()");
    fs.writeFileSync(
      path.join(requiredPatchDir, "patch.js"),
      [
        "\"use strict\";",
        "module.exports=[{",
        "id:\"required-main-bundle-test\",",
        "phase:\"main-bundle\",",
        "ciPolicy:\"required-upstream\",",
        "apply:(source)=>source.replace(\"codexRequiredPatchOff()\",\"codexRequiredPatchOn()\")",
        "}];",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(optionalPatchDir, "patch.js"),
      [
        "\"use strict\";",
        "module.exports=[{",
        "id:\"optional-background-avatar-drift-test\",",
        "phase:\"main-bundle\",",
        "ciPolicy:\"optional\",",
        "apply:(source)=>{console.warn(\"WARN: optional background/avatar drift\"); return source;}",
        "}];",
      ].join("\n"),
    );

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report, corePatchRoot: coreRoot }));

    const optionalPatch = report.patches.find((patch) => patch.name === "optional-background-avatar-drift-test");
    const aggregate = report.patches.find((patch) => patch.name === "main-process-ui");
    assert.equal(optionalPatch.status, "skipped-optional");
    assert.equal(aggregate.status, "applied");
    assert.equal(aggregate.warnings, undefined);
    assert.ok(
      !validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("main-process-ui:"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch report marks missing required webview assets as required failures", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-webview-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), mainBundlePrefix);
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const sunsetPatch = report.patches.find((patch) => patch.name === "linux-app-sunset-gate");
    assert.equal(sunsetPatch.status, "failed-required");
    assert.match(sunsetPatch.reason, /Could not find webview assets directory/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-app-sunset-gate: failed-required"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch report marks missing required package metadata as required failure", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-package-json-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), mainBundlePrefix);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const packagePatch = report.patches.find((patch) => patch.name === "package-desktop-name");
    assert.equal(packagePatch.status, "failed-required");
    assert.match(packagePatch.reason, /package\.json missing or unreadable/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("package-desktop-name: failed-required"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch report marks missing Owl feature binding bundle as required failure", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-owl-feature-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), mainBundlePrefix);
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const owlPatch = report.patches.find((patch) => patch.name === "linux-owl-feature-binding-fallback");
    assert.equal(owlPatch.status, "failed-required");
    assert.match(owlPatch.reason, /Owl feature binding loader bundle missing/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-owl-feature-binding-fallback: failed-required"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patch report marks warned asset patches as required failures", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-warned-asset-"));
  try {
    const assetsDir = path.join(tempRoot, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "index-test.js"), appSunsetBundleWithDriftingGateFixture());

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const sunsetPatch = report.patches.find((patch) => patch.name === "linux-app-sunset-gate");
    assert.equal(sunsetPatch.status, "failed-required");
    assert.match(sunsetPatch.reason, /Could not find app sunset gate needle/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-app-sunset-gate: failed-required"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("persistent rate limit footer descriptor ignores external footer chunks", () => {
  const descriptor = corePatchDescriptors().find(
    (candidate) => candidate.id === "composer-persistent-rate-limit-footer",
  );

  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("composer-D1QtVouy.js"), true);
  descriptor.pattern.lastIndex = 0;
  assert.equal(descriptor.pattern.test("composer-external-footer-0Iw5VZtp.js"), false);
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

test("persistent rate limit footer adapts to current composer status toolbar shape", () => {
  const source = [
    "function zg(e){let t=(0,$.c)(29),{conversationId:n,threadId:r,rateLimit:i,onOpenChange:a}=e,o=Et(),[s,c]=(0,Z.useState)(!1),{activeMode:l}=or(n),u=l?.settings.model??null,d=Ct(E,n),f;t[0]===d?f=t[1]:(f=wc(d),t[0]=d,t[1]=f);let p=f,m,h;if(t[2]!==i||t[3]!==u){let e=sa(i),n=ta(i),r=da(e,{activeLimitName:n,selectedModel:u});m=Oo(r),h=la(r,{activeLimitName:n,selectedModel:u}),t[2]=i,t[3]=u,t[4]=m,t[5]=h}else m=t[4],h=t[5];let g=h;return g}",
    "function Bg(e){let t=(0,$.c)(110),{agentMode:n,composerMode:i,currentLocalExecutionCwd:o,currentLocalExecutionHostId:s,effectiveIdeContextStatus:c,effectiveIsAutoContextOn:l,isGoalActionAvailable:u,onOpenGoalEditor:d,resolvedCwd:f,setIsAutoContextOn:p,setIsStatusMenuOpen:m,skillLookupRoots:h}=e,g=Ot(Y),_=pc(),v=qt(),y=dc(_,Vg),b=Dt(Zn),x=b?.type===`local`?b.localConversationId:null,S=Jt(),{data:w}=Dt(le),T=k(s),E=yr(x),D;t[0]===E.hostId?D=t[1]:(D={hostId:E.hostId},t[0]=E.hostId,t[1]=D);let O=1,A=2,j=3,M=4,N=5,P=6,F=7,L=8,te=9,ne=10,re=11,ie=`thread`,R=12,z=13,B=14,V=15,ae=16,oe=17,U=18,se=19,ce=20,ue=21,de=22,W=23,fe=24,pe=25,me=26,G=27,he=28,_e=29,ve=30,ye=31,xe=32,Se=33,Ce=34,we=35,Te=36,Ee=37,De=w??null,Oe;t[73]!==x||t[74]!==m||t[75]!==ie||t[76]!==De?(Oe=(0,Q.jsx)(zg,{conversationId:x,threadId:ie,rateLimit:De,onOpenChange:m}),t[73]=x,t[74]=m,t[75]=ie,t[76]=De,t[77]=Oe):Oe=t[77];let Ae=38,je=39,Me=40,Ne;return t[91]!==W||t[92]!==pe||t[93]!==G||t[94]!==he||t[95]!==_e||t[96]!==ve||t[97]!==ye||t[98]!==xe||t[99]!==Se||t[100]!==Ce||t[101]!==we||t[102]!==Te||t[103]!==Ee||t[104]!==Oe||t[105]!==Ae||t[106]!==je||t[107]!==Me||t[108]!==ue?(Ne=(0,Q.jsxs)(Q.Fragment,{children:[ue,de,W,fe,pe,me,G,he,_e,ve,ye,xe,Se,Ce,we,Te,Ee,Oe,Ae,je,Me]}),t[91]=W,t[92]=pe,t[93]=G,t[94]=he,t[95]=_e,t[96]=ve,t[97]=ye,t[98]=xe,t[99]=Se,t[100]=Ce,t[101]=we,t[102]=Te,t[103]=Ee,t[104]=Oe,t[105]=Ae,t[106]=je,t[107]=Me,t[108]=ue,t[109]=Ne):Ne=t[109],Ne}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(
    patched,
    /function codexLinuxRateLimitFooter\(\{conversationId:e,rateLimit:t\}\)\{try\{let n=Et\(\),\{activeMode:r\}=or\(e\),i=r\?\.settings\.model\?\?null,a=sa\(t\),o=ta\(t\),s=da\(a,\{activeLimitName:o,selectedModel:i\}\),c=s\.filter\(kg\)\.slice\(0,2\);/,
  );
  assert.match(
    patched,
    /children:\[ue,de,W,fe,pe,me,G,he,_e,ve,ye,xe,Se,Ce,we,Te,Ee,De==null\?null:\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:x,rateLimit:De\}\),Oe,Ae,je,Me\]/,
  );
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

test("persistent rate limit footer adapts to current composer permissions footer shape", () => {
  const source = [
    "var $=qt();var Q=Hr();",
    "function Xv({activeCollaborationMode:t}){let Te=t?.settings.model??null,{data:De}=Y(de),Ie=_a(De),ze=da(De),Be=ma(Ie,{activeLimitName:ze,selectedModel:Te}),Ue=ya(Ie,{activeLimitName:ze,selectedModel:Te});return Be??Ue}",
    "function Sm(e){return e}",
    "function Lm(e){let t=(0,$.c)(34),{composerMode:d,conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,permissionsHostId:C,permissionsCwdOverride:w,showPermissions:T}=e,E=T===void 0?!0:T,k=(0,Q.jsx)(Co,{conversationId:f}),A;t[22]!==d||t[23]!==f||t[24]!==y||t[25]!==b||t[26]!==x||t[27]!==w||t[28]!==C||t[29]!==E?(A=d===`cloud`?null:(0,Q.jsx)(Q.Fragment,{children:E?(0,Q.jsxs)(Q.Fragment,{children:[(0,Q.jsx)(Sm,{conversationId:f,hostId:C,cwdOverride:w}),(0,Q.jsx)(Rm,{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0})]}):null}),t[22]=d,t[23]=f,t[24]=y,t[25]=b,t[26]=x,t[27]=w,t[28]=C,t[29]=E,t[30]=A):A=t[30];let j;return t[31]!==k||t[32]!==A?(j=(0,Q.jsxs)(`div`,{className:`flex min-w-0 items-center gap-[5px]`,children:[k,A]}),t[31]=k,t[32]=A,t[33]=j):j=t[33],j}",
    "function Rm(e){let t=(0,$.c)(16),{conversationId:n,hasGoal:r,isGoalActionAvailable:i,onClearGoal:a,showDivider:o}=e,{activeMode:s,modes:c,setSelectedMode:l}=cr(n);return l}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter\(\{conversationId:e\}\)/);
  assert.match(
    patched,
    /\{data:n\}=Y\(de\),r=_a\(n\),i=da\(n\),a=ya\(r,\{activeLimitName:i,selectedModel:t\}\)/,
  );
  assert.match(
    patched,
    /\(0,Q\.jsx\)\(Sm,\{conversationId:f,hostId:C,cwdOverride:w\}\),\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:f\}\),\(0,Q\.jsx\)\(Rm,\{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0\}\)/,
  );
});

test("persistent rate limit footer adapts to latest composer footer controls without conversation guard", () => {
  const source = [
    "var $=qt();var Q=Hr();",
    "function Mm(e){let t=(0,$.c)(12),{addContextButton:n,conversationId:s}=e,Ke=null,qe;t[0]!==n||t[1]!==Ke?(qe=(0,Q.jsxs)(Pp.FooterInlineControls,{gap:`normal`,children:[n,Ke]}),t[0]=n,t[1]=Ke,t[2]=qe):qe=t[2];return qe}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter\(\)/);
  assert.doesNotMatch(patched, /selectedModel:r/);
  assert.doesNotMatch(patched, /\.filter\(og\)/);
  assert.match(patched, /t=f\(Ae\)\?\.data,n=t\?\.rate_limit,r=\[n\?\.primary_window,n\?\.secondary_window\]\.filter/);
  assert.match(patched, /Math\.max\(0,100-\(e\.used_percent\?\?0\)\)/);
  assert.match(patched, /if\(r\.length===0\)return null/);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.doesNotMatch(patched, /children:`Usage limits`/);
  assert.match(patched, /className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1\.5 rounded-full border border-token-border-light bg-transparent px-2 py-1 text-xs text-token-text-secondary dark:border-white\/10`/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[n,Ke,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:s\}\)\]\}/,
  );
  assert.doesNotMatch(patched, /s==null\?null:\(0,Q\.jsx\)\(codexLinuxRateLimitFooter/);
});

test("persistent rate limit footer detects latest rate-limit query symbols", () => {
  const source = [
    "var $=qt();var Q=Hr();",
    "function ef(e){let t=(0,$.c)(23),{selectedModel:n}=e,{data:r}=wr(),{data:i}=Dr(Qk),a=ru(),o;if(t[0]!==i){o=go({rateLimitStatus:i,isWorkspaceAccount:!0}),t[0]=i,t[1]=o}else o=t[1];return o}",
    "function Mm(e){let t=(0,$.c)(12),{addContextButton:n,conversationId:s}=e,Ke=null,qe;t[0]!==n||t[1]!==Ke?(qe=(0,Q.jsxs)(Pp.FooterInlineControls,{gap:`normal`,children:[n,Ke]}),t[0]=n,t[1]=Ke,t[2]=qe):qe=t[2];return qe}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /t=Dr\(Qk\)\?\.data,n=t\?\.rate_limit/);
  assert.doesNotMatch(patched, /t=f\(Ae\)\?\.data/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[n,Ke,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:s\}\)\]\}/,
  );
});

test("persistent rate limit footer removes broad inline controls patch without assuming cache variable", () => {
  const source = [
    "var $=qt();var Q=Hr();",
    "function ef(e){let t=(0,$.c)(23),{selectedModel:n}=e,{data:r}=wr(),{data:i}=Dr(Qk),a=ru(),o;if(t[0]!==i){o=go({rateLimitStatus:i,isWorkspaceAccount:!0}),t[0]=i,t[1]=o}else o=t[1];return o}",
    "var Pp=Object.assign(Fp,{FooterInlineControls:Wp});",
    "function Wp(e){let r=(0,$.c)(6),{children:n,gap:i,ref:a}=e,o=(i===void 0?`compact`:i)===`compact`?`gap-1`:`gap-[5px]`,s;r[0]===o?s=r[1]:(s=J(`flex min-w-0 items-center`,o),r[0]=o,r[1]=s);let c;return c=(0,Q.jsxs)(`div`,{ref:a,className:s,children:[n,(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:null})]}),c}",
    "function Mm(e){let t=(0,$.c)(12),{addContextButton:n,conversationId:s}=e,Ke=null,qe;t[0]!==n||t[1]!==Ke?(qe=(0,Q.jsxs)(Pp.FooterInlineControls,{gap:`normal`,children:[n,Ke]}),t[0]=n,t[1]=Ke,t[2]=qe):qe=t[2];return qe}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(
    patched,
    /let c;return c=\(0,Q\.jsx\)\(`div`,\{ref:a,className:s,children:n\}\),c\}/,
  );
  assert.doesNotMatch(patched, /return t\[2\]/);
  assert.doesNotMatch(patched, /conversationId:null/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[n,Ke,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:s\}\)\]\}/,
  );
});

test("persistent rate limit footer migrates latest composer footer away from conversation guard", () => {
  const oldHelper =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,$.c)(8),{activeMode:n}=or(e),r=n?.settings.model??null,{data:i}=St(ue),a=ma(i),o=la(i),s=da(a,{activeLimitName:o,selectedModel:r}).filter(og).slice(0,2);if(s.length===0)return null;let c=ht(),l;if(t[0]!==s||t[1]!==c){l=s.map(e=>`${Xh(e.bucket.windowDurationMins??null,c)} ${c.formatNumber(Sa(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `),t[0]=s,t[1]=c,t[2]=l}else l=t[2];let u;return t[3]!==l?(u=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l}),t[3]=l,t[4]=u):u=t[4],u}catch(e){return null}}";
  const source = [
    "var $=qt();var Q=Hr();",
    oldHelper,
    "function Mm(e){let t=(0,$.c)(12),{addContextButton:n,conversationId:s}=e,Ke=null,qe;t[0]!==n||t[1]!==Ke?(qe=(0,Q.jsxs)(Pp.FooterInlineControls,{gap:`normal`,children:[n,s==null?null:(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:s}),Ke]}),t[0]=n,t[1]=Ke,t[2]=qe):qe=t[2];return qe}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.equal((patched.match(/function codexLinuxRateLimitFooter/g) || []).length, 1);
  assert.doesNotMatch(patched, /selectedModel:null/);
  assert.doesNotMatch(patched, /a=ma\(i\)/);
  assert.match(patched, /t=f\(Ae\)\?\.data,n=t\?\.rate_limit,r=\[n\?\.primary_window,n\?\.secondary_window\]\.filter/);
  assert.match(patched, /Math\.max\(0,100-\(e\.used_percent\?\?0\)\)/);
  assert.match(patched, /if\(r\.length===0\)return null/);
  assert.doesNotMatch(patched, /children:`Usage limits`/);
  assert.match(patched, /className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1\.5 rounded-full border border-token-border-light bg-transparent px-2 py-1 text-xs text-token-text-secondary dark:border-white\/10`/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[n,Ke,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:s\}\)\]\}/,
  );
  assert.doesNotMatch(patched, /s==null\?null:\(0,Q\.jsx\)\(codexLinuxRateLimitFooter/);
});

test("persistent rate limit footer preserves intervening latest composer functions when replacing helper", () => {
  const oldHelper =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{return e}catch(e){return null}}";
  const source = [
    "var $=qt();var Q=Hr();",
    oldHelper,
    "function lh(){return `keep me`}",
    "function Mm(e){let t=(0,$.c)(12),{addContextButton:n,conversationId:s}=e,Ke=null,qe;t[0]!==n||t[1]!==Ke?(qe=(0,Q.jsxs)(Pp.FooterInlineControls,{gap:`normal`,children:[n,(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:s}),Ke]}),t[0]=n,t[1]=Ke,t[2]=qe):qe=t[2];return qe}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.equal((patched.match(/function codexLinuxRateLimitFooter/g) || []).length, 1);
  assert.match(patched, /function codexLinuxRateLimitFooter\(\)/);
  assert.match(patched, /function lh\(\)\{return `keep me`\}/);
  assert.doesNotMatch(patched, /try\{return e\}/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[n,Ke,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:s\}\)\]\}/,
  );
});

test("persistent rate limit footer keeps latest model fallback numeric-only", () => {
  const oldHelper =
    "function codexLinuxRateLimitFooter({conversationId:e}){try{let t=(0,$.c)(8),{activeMode:n}=or(e),r=n?.settings.model??null,{data:i}=St(ue),a=ma(i),o=la(i),s=da(a,{activeLimitName:o,selectedModel:r}).filter(og).slice(0,2);s.length===0&&(s=da(a,{activeLimitName:o,selectedModel:null}).filter(og).slice(0,2));if(s.length===0)return null;let c=ht(),l;if(t[0]!==s||t[1]!==c){l=s.map(e=>`${Xh(e.bucket.windowDurationMins??null,c)} ${c.formatNumber(Sa(e.bucket.usedPercent??0),{maximumFractionDigits:0})}%`).join(` / `),t[0]=s,t[1]=c,t[2]=l}else l=t[2];let u;return t[3]!==l?(u=(0,Q.jsx)(`span`,{className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1.5 rounded-full border border-token-border-light bg-token-main-surface-primary/80 px-2 py-1 text-xs text-token-text-secondary shadow-sm dark:border-white/10`,children:l}),t[3]=l,t[4]=u):u=t[4],u}catch(e){return null}}";
  const source = [
    "var $=qt();var Q=Hr();",
    oldHelper,
    "function Mm(e){let t=(0,$.c)(12),{addContextButton:n,conversationId:s}=e,Ke=null,qe;t[0]!==n||t[1]!==Ke?(qe=(0,Q.jsxs)(Pp.FooterInlineControls,{gap:`normal`,children:[n,(0,Q.jsx)(codexLinuxRateLimitFooter,{conversationId:s}),Ke]}),t[0]=n,t[1]=Ke,t[2]=qe):qe=t[2];return qe}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.equal((patched.match(/function codexLinuxRateLimitFooter/g) || []).length, 1);
  assert.doesNotMatch(patched, /a=ma\(i\)/);
  assert.match(patched, /t=f\(Ae\)\?\.data,n=t\?\.rate_limit,r=\[n\?\.primary_window,n\?\.secondary_window\]\.filter/);
  assert.match(patched, /Math\.max\(0,100-\(e\.used_percent\?\?0\)\)/);
  assert.match(patched, /if\(r\.length===0\)return null/);
  assert.match(patched, /catch\(e\)\{return null\}/);
  assert.doesNotMatch(patched, /children:`Usage limits`/);
  assert.match(patched, /className:`composer-footer__label--sm inline-flex shrink-0 items-center gap-1\.5 rounded-full border border-token-border-light bg-transparent px-2 py-1 text-xs text-token-text-secondary dark:border-white\/10`/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[n,Ke,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:s\}\)\]\}/,
  );
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
        currentOpaqueWindowSurfaceBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));
    fs.writeFileSync(
      path.join(assetsDir, "settings-page-bad-linux-patch.js"),
      'var icons={"agent-workspaces":codexLinuxAgentWorkspaceSettingsIcon,worktrees:WorktreesIcon};',
    );

    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "patch-linux-window-ui.js"), "--report-json", reportPath, tempRoot],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(report.mainBundle, "main.js");
    assert.ok(report.patches.some((patch) => patch.name === "main-process-ui"));
    assert.equal(report.postPatchIntegrity.findingCount, 1);
    assert.match(report.postPatchIntegrity.findings[0].symbol, /codexLinuxAgentWorkspaceSettingsIcon/);
    assert.match(report.postPatchIntegrity.findings[0].path, /settings-page-bad-linux-patch\.js$/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function writeCorePatchFixture(root, relativeDir, descriptorSource) {
  const patchDir = path.join(root, relativeDir);
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, "patch.js"), descriptorSource);
}

test("engine catches a throwing optional patch and continues with later patches", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-optional-core-"));
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-optional-app-"));
  try {
    writeCorePatchFixture(coreRoot, "sample/throwing", [
      "\"use strict\";",
      "module.exports = {",
      "  id: \"throwing-optional-sample\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"optional\",",
      "  order: 100,",
      "  apply: () => { throw new Error(\"boom-optional\"); },",
      "};",
    ].join("\n"));
    writeCorePatchFixture(coreRoot, "sample/following", [
      "\"use strict\";",
      "module.exports = {",
      "  id: \"following-optional-sample\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"optional\",",
      "  order: 200,",
      "  apply: (source) => source.replace(\"codexLinuxFollowUp()\", \"codexLinuxFollowedUp()\"),",
      "};",
    ].join("\n"));

    const buildDir = path.join(tempApp, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "codexLinuxFollowUp()");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempApp, { report, corePatchRoot: coreRoot }));

    const throwing = report.patches.find((patch) => patch.name === "throwing-optional-sample");
    assert.equal(throwing?.status, "skipped-optional");
    assert.equal(throwing?.error, true);
    assert.match(throwing?.reason ?? "", /boom-optional/);

    const following = report.patches.find((patch) => patch.name === "following-optional-sample");
    assert.equal(following?.status, "applied", "engine must continue after an optional patch throws");
    assert.match(fs.readFileSync(path.join(buildDir, "main.js"), "utf8"), /codexLinuxFollowedUp/);

    assert.ok(
      !criticalFailuresFromReport(report).some((failure) => failure.name === "throwing-optional-sample"),
    );
    assert.ok(
      !validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("throwing-optional-sample:"),
      ),
    );
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("engine records a throwing critical patch as failed-required without aborting", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-critical-core-"));
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-critical-app-"));
  try {
    writeCorePatchFixture(coreRoot, "sample/critical", [
      "\"use strict\";",
      "module.exports = {",
      "  id: \"throwing-critical-sample\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"required-upstream\",",
      "  order: 100,",
      "  apply: () => { throw new Error(\"boom-critical\"); },",
      "};",
    ].join("\n"));

    const buildDir = path.join(tempApp, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const originalSource = "codexLinuxCriticalFixture()";
    fs.writeFileSync(path.join(buildDir, "main.js"), originalSource);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempApp, { report, corePatchRoot: coreRoot }));

    const entry = report.patches.find((patch) => patch.name === "throwing-critical-sample");
    assert.equal(entry?.status, "failed-required");
    assert.equal(entry?.error, true);
    assert.match(entry?.reason ?? "", /boom-critical/);
    assert.equal(
      fs.readFileSync(path.join(buildDir, "main.js"), "utf8"),
      originalSource,
      "a throwing patch must contribute no partial edit",
    );

    assert.ok(
      criticalFailuresFromReport(report).some((failure) => failure.name === "throwing-critical-sample"),
    );
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("throwing-critical-sample:"),
      ),
    );
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("a throwing webview-asset patch leaves no partially patched assets", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-asset-core-"));
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-asset-app-"));
  try {
    writeCorePatchFixture(coreRoot, "sample/asset", [
      "\"use strict\";",
      "module.exports = {",
      "  id: \"throwing-asset-sample\",",
      "  phase: \"webview-asset\",",
      "  ciPolicy: \"optional\",",
      "  order: 100,",
      "  pattern: /^demo-.*\\.js$/,",
      "  apply: (source) => {",
      "    if (source.includes(\"second\")) { throw new Error(\"boom-asset\"); }",
      "    return source.replace(\"first\", \"first-patched\");",
      "  },",
      "};",
    ].join("\n"));

    const buildDir = path.join(tempApp, ".vite", "build");
    const assetsDir = path.join(tempApp, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "codexLinuxAssetFixture()");
    fs.writeFileSync(path.join(assetsDir, "demo-a.js"), "first asset");
    fs.writeFileSync(path.join(assetsDir, "demo-b.js"), "second asset");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempApp, { report, corePatchRoot: coreRoot }));

    const entry = report.patches.find((patch) => patch.name === "throwing-asset-sample");
    assert.equal(entry?.status, "skipped-optional");
    assert.equal(entry?.error, true);
    assert.equal(fs.readFileSync(path.join(assetsDir, "demo-a.js"), "utf8"), "first asset");
    assert.equal(fs.readFileSync(path.join(assetsDir, "demo-b.js"), "utf8"), "second asset");
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("criticalFailuresFromReport agrees with validateReport and skips non-applicable statuses", () => {
  const report = {
    patches: [
      { name: "req-bad", status: "failed-required", ciPolicy: "required-upstream", reason: "anchor drifted" },
      { name: "req-good", status: "applied", ciPolicy: "required-upstream" },
      { name: "req-not-applicable", status: "skipped-target", ciPolicy: "required-upstream" },
      { name: "opt-bad", status: "skipped-optional", ciPolicy: "optional", reason: "optional drift" },
    ],
  };

  assert.deepEqual(criticalFailuresFromReport(report), [
    { name: "req-bad", status: "failed-required", reason: "anchor drifted" },
  ]);
  assert.deepEqual(optionalDriftFromReport(report), [
    { name: "opt-bad", status: "skipped-optional", reason: "optional drift" },
  ]);

  const failures = validateReport(report, "upstream-build");
  assert.ok(failures.some((failure) => failure.startsWith("req-bad:")));
  assert.ok(!failures.some((failure) => failure.startsWith("req-not-applicable:")));
  assert.ok(!failures.some((failure) => failure.startsWith("opt-bad:")));
});

test("validateReport can require enabled features and successful patch entries", () => {
  const report = {
    enabledFeatures: ["remote-mobile-control"],
    patches: [
      {
        name: "feature:remote-mobile-control:linux-remote-control-load-gate",
        status: "applied",
        ciPolicy: "optional",
      },
      {
        name: "linux-app-server-conversation-hydration",
        status: "already-applied",
        ciPolicy: "optional",
      },
      {
        name: "feature:remote-mobile-control:linux-remote-mobile-projectless-remote-task",
        status: "skipped-optional",
        ciPolicy: "optional",
        reason: "missing sidebar project groups bundle",
      },
    ],
  };

  const failures = validateReport(report, "feature-probe", {
    requiredAppliedPatches: [
      "feature:remote-mobile-control:linux-remote-control-load-gate",
      "linux-app-server-conversation-hydration",
    ],
    requiredEnabledFeatures: ["remote-mobile-control", "missing-feature"],
    requiredSuccessfulPatches: [
      "feature:remote-mobile-control:linux-remote-control-load-gate",
      "linux-app-server-conversation-hydration",
      "feature:remote-mobile-control:linux-remote-mobile-projectless-remote-task",
      "feature:remote-mobile-control:missing-entry",
    ],
  });

  assert.ok(
    !failures.some((failure) =>
      failure.startsWith("feature:remote-mobile-control:linux-remote-control-load-gate:"),
    ),
  );
  assert.ok(
    failures.includes(
      "linux-app-server-conversation-hydration: expected applied, got already-applied",
    ),
  );
  assert.ok(failures.includes("feature missing-feature: not enabled in patch report"));
  assert.ok(
    failures.some((failure) =>
      failure.startsWith(
        "feature:remote-mobile-control:linux-remote-mobile-projectless-remote-task: skipped-optional",
      ),
    ),
  );
  assert.ok(failures.includes("feature:remote-mobile-control:missing-entry: missing from patch report"));
});

test("terminal user PATH patch drift is reported as optional", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-terminal-path-optional-core-"));
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-terminal-path-optional-app-"));
  try {
    writeCorePatchFixture(coreRoot, "sample/terminal-path", [
      "\"use strict\";",
      "const { applyLinuxTerminalUserPathPatch } = require(",
      `  ${JSON.stringify(path.join(__dirname, "patches", "impl", "main-process", "misc.js"))},`,
      ");",
      "module.exports = {",
      "  id: \"linux-terminal-user-path\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"optional\",",
      "  apply: applyLinuxTerminalUserPathPatch,",
      "};",
    ].join("\n"));

    const buildDir = path.join(tempApp, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "async buildTerminalEnv(){return null}// node-pty");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempApp, { report, corePatchRoot: coreRoot }));

    const entry = report.patches.find((patch) => patch.name === "linux-terminal-user-path");
    assert.equal(entry?.ciPolicy, "optional");
    assert.equal(entry?.status, "skipped-optional");
    assert.ok(
      optionalDriftFromReport(report).some((drift) => drift.name === "linux-terminal-user-path"),
      "terminal PATH drift should stay visible as optional drift",
    );
    assert.ok(
      !criticalFailuresFromReport(report).some((failure) => failure.name === "linux-terminal-user-path"),
    );
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("patchMainBundleSource survives a throwing optional patch without a report", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-throwing-no-report-core-"));
  try {
    writeCorePatchFixture(coreRoot, "sample/throwing", [
      "\"use strict\";",
      "module.exports = {",
      "  id: \"throwing-no-report-sample\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"optional\",",
      "  order: 100,",
      "  apply: () => { throw new Error(\"boom-no-report\"); },",
      "};",
    ].join("\n"));

    const source = "codexLinuxNoReportFixture()";
    const { value: patched } = captureWarns(() =>
      patchMainBundleSource(source, null, { corePatchRoot: coreRoot }),
    );
    assert.equal(patched, source);
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
  }
});

test("patcher CLI --enforce-critical exits non-zero with an aggregated message", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-enforce-critical-cli-test-"));
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
        currentOpaqueWindowSurfaceBackgroundBundle,
        fileManagerBundle,
        trayBundleFixture(),
        singleInstanceBundleFixture(),
      ].join(""),
    );
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "patch-linux-window-ui.js"),
        "--enforce-critical",
        "--report-json",
        reportPath,
        tempRoot,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Critical patch failures \(\d+\):/);
    assert.match(result.stderr, /failed-required/);
    // The report must still be written for CI artifact upload despite the failure.
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.ok(criticalFailuresFromReport(report).length > 0);

    // Without the flag the same fixture must keep exiting 0 (fail-soft default).
    const lenient = spawnSync(
      process.execPath,
      [path.join(__dirname, "patch-linux-window-ui.js"), tempRoot],
      { encoding: "utf8" },
    );
    assert.equal(lenient.status, 0, lenient.stderr);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("patcher CLI --enforce-critical treats window-shell drift as critical", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-critical-window-shell-cli-test-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    const assetsDir = path.join(tempRoot, "webview", "assets");
    const reportPath = path.join(tempRoot, "reports", "patch-report.json");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), mainBundlePrefix);
    fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "patch-linux-window-ui.js"),
        "--enforce-critical",
        "--report-json",
        reportPath,
        tempRoot,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /linux-opaque-background \(failed-required\)/);
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.ok(
      criticalFailuresFromReport(report).some(
        (failure) => failure.name === "linux-opaque-background" && failure.status === "failed-required",
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a disabled patch is recorded as skipped-disabled and never counts as a critical failure", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-disabled-core-"));
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-disabled-app-"));
  try {
    writeCorePatchFixture(coreRoot, "sample/disabled", [
      "\"use strict\";",
      "module.exports = {",
      "  id: \"disabled-required-sample\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"required-upstream\",",
      "  order: 100,",
      "  enabled: () => false,",
      "  apply: () => { throw new Error(\"must never run\"); },",
      "};",
    ].join("\n"));

    const buildDir = path.join(tempApp, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "codexLinuxDisabledFixture()");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempApp, { report, corePatchRoot: coreRoot }));

    const entry = report.patches.find((patch) => patch.name === "disabled-required-sample");
    assert.equal(entry?.status, "skipped-disabled");
    assert.ok(
      !criticalFailuresFromReport(report).some((failure) => failure.name === "disabled-required-sample"),
      "a disabled patch is not applicable, so it must not fail the build",
    );
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("strategy telemetry recorded during apply lands on the patch report entry", () => {
  const coreRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-strategy-core-"));
  const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-strategy-app-"));
  try {
    const telemetryPath = path.join(__dirname, "patches", "strategy-telemetry.js");
    writeCorePatchFixture(coreRoot, "sample/instrumented", [
      "\"use strict\";",
      `const { recordStrategy } = require(${JSON.stringify(telemetryPath)});`,
      "module.exports = {",
      "  id: \"instrumented-sample\",",
      "  phase: \"main-bundle\",",
      "  ciPolicy: \"optional\",",
      "  order: 100,",
      "  apply: (source) => {",
      "    recordStrategy(\"sample-group\", \"upstream-alt-shape\");",
      "    return source.replace(\"codexLinuxStrategyFixture()\", \"codexLinuxStrategyPatched()\");",
      "  },",
      "};",
    ].join("\n"));

    const buildDir = path.join(tempApp, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "codexLinuxStrategyFixture()");

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempApp, { report, corePatchRoot: coreRoot }));

    const entry = report.patches.find((patch) => patch.name === "instrumented-sample");
    assert.equal(entry?.status, "applied");
    assert.deepEqual(entry?.strategies, [{ group: "sample-group", strategy: "upstream-alt-shape" }]);
  } finally {
    fs.rmSync(coreRoot, { recursive: true, force: true });
    fs.rmSync(tempApp, { recursive: true, force: true });
  }
});

test("persistent rate limit footer adapts to the latest composer footer controls shape", () => {
  const source = [
    "var $=qt();var Q=Hr();",
    "function Wm(e){let t=(0,$.c)(12),{addContextButton:Ab,conversationId:n}=e,r=Qd(n),i=qd(n);",
    "return (0,Q.jsx)(FooterInlineControls,{gap:`normal`,children:[Ab,Cb]})}",
  ].join("");

  const patched = applyPatchTwice(applyPersistentRateLimitFooterPatch, source);

  assert.match(patched, /function codexLinuxRateLimitFooter\(\)/);
  assert.match(patched, /t=f\(Ae\)\?\.data,n=t\?\.rate_limit/);
  assert.match(
    patched,
    /FooterInlineControls,\{gap:`normal`,children:\[Ab,Cb,\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:n\}\)\]\}/,
  );
  assert.equal((patched.match(/codexLinuxRateLimitFooter,\{conversationId:n\}/g) || []).length, 1);
});

test("persistent rate limit footer warns when composer footer controls drift", () => {
  const source =
    "function Wm(e){let t=(0,$.c)(12);return (0,Q.jsx)(FooterInlineControls,{gap:`wide`,children:[Ab,Cb,Db]})}";

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentRateLimitFooterPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, [
    "WARN: Could not insert persistent rate limit footer helper — skipping composer footer limit patch",
  ]);
});
