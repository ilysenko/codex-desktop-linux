#!/usr/bin/env node

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyAutomationScheduleMultiTimePatch,
  applyKeybindsSettingsIndexPatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxDesktopSettingsIndexPatch,
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxBrowserUseIabVisibleOnCreatePatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxChromeNativeHostRuntimePatch,
  applyLinuxChromePluginAutoInstallPatch,
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  applyLinuxAboutDialogPatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxMultiInstanceBootstrapPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxBrowserUseAvailabilityPatch,
  applyLinuxBrowserUseExternalAvailabilityPatch,
  applyLinuxBrowserUseNonLocalNavigationPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxFastModeModelGuardPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxSetIconPatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayCloseSettingPatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
  applySubagentNicknameMetadataPatch,
  isComputerUseUiEnabled,
  patchMainBundleSource,
  patchExtractedApp,
  patchPackageJson,
  patchLinuxAppUpdaterBridge,
  patchKeybindsSettingsAssets,
  patchAutomationScheduleAssets,
  createPatchReport,
  corePatchDescriptors,
  detectLinuxTargetContext,
  discoverCorePatchDescriptors,
  enabledLinuxFeatureIds,
  linuxTargetSummary,
  normalizePatchDescriptors,
  parseOsRelease,
  resolveDesktopName,
} = require("./patch-linux-window-ui.js");
const {
  keybindsSettingsAsset,
  linuxDesktopSettingsAsset,
  applyLinuxDesktopSettingsSectionsPatch,
  applyKeybindsSettingsSharedPatch,
  applyLinuxDesktopSettingsSharedPatch,
} = require("./patches/keybinds-settings.js");
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
  summarizePatchReport,
} = require("./lib/patch-report.js");
const {
  applyBrowserAnnotationScreenshotPatch,
  applyLocalEnvironmentActionModalDraftPatch,
  applyPersistentRateLimitFooterPatch,
  applyLinuxAppServerFeatureEnablementPatch,
  applyLinuxConfigWriteVersionConflictPatch,
  applyLinuxI18nGatePatch,
  applyLinuxProfileSettingsMenuPatch,
  applyLinuxSafeMonospaceFontStackPatch,
  applyLinuxThreadSidePanelNativeTooltipPatch,
  applyLinuxTooltipWindowControlsCollisionPatch,
  applyLinuxWindowControlsSafeAreaPatch,
} = require("./patches/webview-assets.js");
const { patchAssetFiles } = require("./patches/shared.js");
const { featurePatchDescriptors } = require("./patches/registry.js");

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
const currentOpaqueWindowSurfaceBackgroundBundle =
  "var W4=`#00000000`,G4=`#000000`,K4=`#f9f9f9`;function g3(e){return e===`avatarOverlay`||e===`browserCommentPopup`||e===`globalDictation`||e===`hotkeyWindowHome`||e===`hotkeyWindowThread`||e===`hud`}function v3({appearance:e,opaqueWindowsEnabled:t,platform:n}){return t&&!g3(e)&&(n===`darwin`||n===`win32`)}function S3({platform:e,appearance:t,opaqueWindowSurfaceEnabled:n,prefersDarkColors:r}){return n?{backgroundColor:r?G4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`win32`&&!g3(t)?{backgroundColor:W4,backgroundMaterial:`mica`}:{backgroundColor:W4,backgroundMaterial:null}}class k3{isOpaqueWindowsEnabled(){return theme?.opaqueWindows===!0}shouldUseOpaqueWindowSurface(e,t,n){return this.shouldAlwaysUseOpaqueWindowSurface(e)}shouldAlwaysUseOpaqueWindowSurface(e){return v3({appearance:e,opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!BA()&&!g3(e)}}";
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
      JSON.stringify({ enabled: ["read-aloud", "zed-opener"] }),
      "utf8",
    );

    const info = buildInfo({
      repoDir: tempRoot,
      dmgPath,
      appDir,
      electronVersion: "41.3.0",
      appId: "codex-desktop",
      appDisplayName: "Codex Desktop",
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
    assert.deepEqual(info.linuxFeatures.enabled, ["read-aloud", "zed-opener"]);
    assert.equal(info.linuxFeatures.configPath, undefined);
  } finally {
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
  });
  const fedora41 = detectLinuxTargetContext({
    osReleaseFields: { ID: "fedora", VERSION_ID: "41", PRETTY_NAME: "Fedora Linux 41" },
    env: { PATH: "" },
  });

  assert.equal(packageProfile(fedora40).packageManager, "dnf");
  assert.equal(packageProfile(fedora41).packageManager, "dnf5");
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
    "linux-avatar-overlay-mouse-passthrough",
    "linux-browser-use-availability",
    "linux-browser-use-non-local-navigation",
    "linux-browser-use-external-availability",
    "linux-file-manager",
    "linux-tray",
    "linux-build-info-tray",
    "linux-single-instance",
    "linux-computer-use-ui-feature",
    "linux-computer-use-plugin-gate",
    "linux-chrome-plugin-auto-install",
    "linux-chrome-native-host-runtime",
    "browser-use-node-repl-approval",
    "linux-browser-use-route-liveness",
    "linux-chrome-extension-status",
    "linux-remote-control-config-preservation",
    "linux-app-updater-menu",
    "linux-tray-close-setting",
    "linux-settings-persistence",
    "linux-launch-actions",
    "linux-hotkey-window-prewarm",
    "linux-git-origins-source-fallback",
    "linux-i18n-gate",
    "linux-profile-settings-menu",
    "automation-schedule-multi-time-rrule",
    "linux-app-sunset-gate",
    "linux-app-server-feature-enablement",
    "linux-config-write-version-conflict",
    "opaque-window-default-general-settings",
    "opaque-window-default-webview-index",
    "opaque-window-default-resolved-theme",
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
    "extracted-app",
  );
  assert.match(
    descriptors.find((descriptor) => descriptor.id === "linux-chrome-plugin-auto-install")?.sourcePath,
    /main-process[\\/]browser-integrations[\\/]patch\.js$/,
  );
  assert.equal(
    descriptors.find((descriptor) => descriptor.id === "local-environment-action-modal-draft")?.ciPolicy,
    "optional",
  );

  const descriptorOrder = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor.order]));
  assert.ok(
    descriptorOrder.get("linux-native-titlebar") > descriptorOrder.get("linux-opaque-background"),
    "linux-native-titlebar must run after linux-opaque-background so it can reuse the inserted Linux background branch aliases",
  );
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

function trayBundleFixture() {
  return [
    "async function Hw(e){return process.platform!==`win32`&&process.platform!==`darwin`?null:(zw=!0,Lw??Rw??(Rw=(async()=>{let r=await Ww(e.buildFlavor,e.repoRoot),i=new n.Tray(r.defaultIcon);return i})()))}",
    "async function Ww(e,t){if(process.platform===`darwin`){return null}let r=process.platform===`win32`?`.ico`:`.png`,a=Nw(e,process.platform),o=[...n.app.isPackaged?[(0,i.join)(process.resourcesPath,`${a}${r}`)]:[],(0,i.join)(t,`electron`,`src`,`icons`,`${a}${r}`)];for(let e of o){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await n.app.getFileIcon(process.execPath,{size:process.platform===`win32`?`small`:`normal`}),chronicleRunningIcon:null}}",
    "var pb=class{trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(){this.tray={on(){},setContextMenu(){},popUpContextMenu(){}};this.onTrayButtonClick=()=>{};this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}async handleMessage(e){switch(e.type){case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return}}openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}updateChronicleTrayIcon(){}getNativeTrayMenuItems(){return[]}}",
    "v&&k.on(`close`,e=>{this.persistPrimaryWindowBounds(k,f);let t=this.getPrimaryWindows(f).some(e=>e!==k);if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}if(process.platform===`darwin`&&!this.isAppQuitting&&!t){e.preventDefault(),k.hide()}});",
    "let E=process.platform===`win32`;E&&oe();",
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
    "var lt=`browser-use`,ut=`chrome`,dt=`chrome-internal`,xt=`chrome-dev`,ft=`computer-use`,pt=`latex-tectonic`;",
    "var Kr=[{forceReload:!0,installWhenMissing:!0,name:lt,isAvailable:({features:e})=>e.inAppBrowserUseAllowed,migrate:rr},{forceReload:!0,name:xt,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,env:t,features:n})=>Ar(e,t)&&n.externalBrowserUseAllowed},{forceReload:!0,name:dt,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,env:t,features:n})=>jr(e,t)&&n.externalBrowserUseAllowed},{forceReload:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&$n(e)},{name:ft,isAvailable:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:vr},{forceReload:!0,installWhenMissing:!0,name:ft,isAvailable:({buildFlavor:e,features:n,platform:r})=>t.T.isInternal(e)&&r===`win32`&&n.computerUse},{name:pt,isAvailable:()=>!0}];",
  ].join("");
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
    "var Kge={\"general-settings\":xh,appearance:Pf,\"git-settings\":t1};",
    "var i_e={\"general-settings\":(0,Z.lazy)(()=>s(()=>import(`./general-settings-DsLl9t6Z.js`),[],import.meta.url)),appearance:(0,Z.lazy)(()=>s(()=>import(`./appearance.js`),[],import.meta.url))};",
    "qge=[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`];",
    "Jge=[{key:`app`,heading:H7.appHeading,slugs:[`general-settings`,`appearance`,`connections`,`git-settings`,`usage`]}];",
    "switch(e){case`appearance`:case`git-settings`:case`worktrees`:case`local-environments`:case`data-controls`:case`environments`:return l===`electron`;}",
    "switch(e){case`usage`:k=g;break bb0;case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`account`:case`data-controls`:case`personalization`:k=!1;break bb0;}",
  ].join("");
}

function keybindsIndexBundleWithLazyAliasDriftFixture() {
  return keybindsIndexBundleFixture().replaceAll(
    "(0,Z.lazy)(()=>s(",
    "(0,R.lazy)(()=>q(",
  );
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
    "var DE={",
    '"read-aloud-settings":(0,$.lazy)(()=>Xr(()=>import(`./general-settings-read.js`),[],import.meta.url)),',
    '"general-settings":(0,$.lazy)(()=>Xr(()=>import(`./general-settings-A.js`),[],import.meta.url)),',
    "profile:(0,$.lazy)(()=>Xr(()=>import(`./profile-A.js`),[],import.meta.url)),",
    '"keyboard-shortcuts":(0,$.lazy)(()=>Xr(()=>import(`./keyboard-shortcuts-settings-A.js`),[],import.meta.url))',
    "};",
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

function createNativeKeyboardShortcutsSettingsFixture() {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-shortcuts-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const writeAsset = (name, source = "") => {
    fs.writeFileSync(path.join(assetsDir, name), source, "utf8");
  };

  writeAsset("chunk-A.js", "");
  writeAsset(
    "jsx-runtime-A.js",
    'import{s as s}from"./chunk-A.js";function n(){return{}}function t(){return{jsx(){},jsxs(){},Fragment:"Fragment"}}react.transitional.element;export{n,t};',
  );
  writeAsset(
    "setting-storage-A.js",
    'async function requestCodex(...args){let[request]=args,{params:params,source:source}=request;return send("vscode://codex/",params)}export{requestCodex as z};',
  );
  writeAsset("general-settings-A.js", "hotkey-window-hotkey-state");
  writeAsset("toggle-A.js", "export{t};");
  writeAsset("settings-row-A.js", "export{n};");
  writeAsset("settings-content-layout-A.js", "export{n,r,t};");
  writeAsset("settings-group-A.js", "export{n,t};");
  writeAsset("settings-surface-A.js", "export{t};");
  writeAsset(
    "settings-sections-A.js",
    "var e=`general-settings`,t=`mcp-settings`,n=[{slug:e},{slug:`appearance`},{slug:`keyboard-shortcuts`}];",
  );
  writeAsset("settings-shared-A.js", settingsSharedBundleFixture());
  writeAsset("app-main-A.js", linuxDesktopRouteBundleFixture());
  writeAsset("settings-page-A.js", linuxDesktopNavigationBundleFixture());
  writeAsset("keyboard-shortcuts-settings-A.js", "export default function KeyboardShortcutsSettings(){}");

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

function currentAvatarOverlayBundleFixture() {
  return [
    "let r=require(`electron`),f=require(`node:child_process`);",
    "var rV=`/avatar-overlay`,zB={width:356,height:320},oV={width:112,height:121},u1={width:0,height:0},l1={width:276,height:131};",
    "var fV=class{window=null;rendererReady=!1;layout=null;mascotSize=oV;traySize=null;pointerInteractive=!1;mousePassthroughEnabled=!1;windowStagedForNativePresentation=!1;layoutMode=`native`;compositionHost={setOverlayWindow(){},isNativeMaterialAttached(){return!1}};",
    "constructor(e,t){this.windowManager=e,this.globalState=t}",
    "isOpen(){let e=this.window;return e!=null&&!e.isDestroyed()&&e.isVisible()&&!this.windowStagedForNativePresentation}",
    "startDrag(e,{pointerWindowX:t,pointerWindowY:n}){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e)return;this.cancelMomentum(),this.clearDetachedDisplayRestore();let a=this.getLayout(i);this.dragState={pointerAnchorX:t-a.mascot.left,pointerAnchorY:n-a.mascot.top,hasMoved:!1,displayBounds:r.screen.getDisplayNearestPoint(r.screen.getCursorScreenPoint()).bounds},process.platform===`linux`&&(this.pointerInteractive=!0,this.applyPointerInteractivityPolicy())}",
    "moveDrag(e){return e}",
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}),process.platform===`linux`&&this.applyPointerInteractivityPolicy())}",
    "setElementSize(e,{isTrayVisible:t,mascot:n,tray:r}){let i=this.window;i==null||i.isDestroyed()||i.webContents.id!==e||(this.cancelMomentum(),this.layoutMode=t==null?`native`:`legacy`,this.mascotSize=n,this.traySize=r,this.applyLatestElementSizes(i),this.stageWindowForNativePresentation(i),this.showWindowIfReady(i))}",
    "applyLatestElementSizes(e){this.anchor={...this.anchor,width:this.mascotSize.width,height:this.mascotSize.height},this.applyLayout(e)}",
    "async createWindow(e){let t=await this.windowManager.createWindow({title:r.app.getName(),width:zB.width,height:zB.height,appearance:`avatarOverlay`,focusable:!1,show:!1,initialRoute:rV});return this.window=t,this.compositionHost.setOverlayWindow(t),this.rendererReady=this.windowManager.isWebContentsReady(t.webContents.id),this.dragState=null,this.layout=null,this.mascotSize=oV,this.mousePassthroughEnabled=!1,this.traySize=null,t.on(`closed`,()=>{this.window===t&&(this.cancelMomentum(),this.clearMovedWindowPersist(),this.window=null,this.dragState=null,this.layout=null,this.rendererReady=!1,this.pointerInteractive=!1,this.mousePassthroughEnabled=!1,this.compositionHost.setOverlayWindow(null),this.broadcastOpenState())}),t}",
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1,r=!0){if(e.isDestroyed())return;let a=UB({anchor:this.anchor,displayBounds:t.bounds,mascotSize:this.mascotSize,previousPlacement:this.placement,traySize:this.traySize??(this.layoutMode===`native`?u1:l1)});this.anchor=a.anchor,this.layout=a,this.placement=a.placement,this.setWindowBounds(e,a.windowBounds,n,r),this.sendLayoutToRenderer(e)}getLayout(e){if(this.layout??this.applyLayout(e),this.layout==null)throw Error(`Expected avatar overlay layout`);return this.layout}",
    "showWindow(e){if(e.isDestroyed())return;let t=this.isOpen();this.windowStagedForNativePresentation&&=(e.setOpacity(1),!1),e.moveTop(),e.showInactive(),!t&&this.isOpen()&&this.broadcastOpenState()}showWindowIfReady(e){!this.rendererReady||this.initialPresentationState!==`ready`||(this.showWindow(e),this.applyPointerInteractivityPolicy())}stageWindowForNativePresentation(e){e.isDestroyed()||this.applyPointerInteractivityPolicy()}broadcastOpenState(){this.windowManager.sendMessageToAllRegisteredWindows({type:`avatar-overlay-open-state-changed`,isOpen:this.isOpen()})}",
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}refreshCursorAtCurrentMousePosition(e){let t=r.screen.getCursorScreenPoint()}",
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

test("patches remaining before-quit and drain guards when another copy is already patched", () => {
  const promptBypassExpression =
    "(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt())||";
  const patchedPrompt = `if(${promptBypassExpression}e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}`;
  const unpatchedPrompt =
    "if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}";
  const patchedPromptSource = applyPatchTwice(
    applyLinuxExplicitQuitPromptBypassPatch,
    `${patchedPrompt}function secondPrompt(){${unpatchedPrompt}}`,
  );
  assert.equal((patchedPromptSource.match(/codexLinuxShouldBypassQuitPrompt\(\)/g) ?? []).length, 2);
  assert.match(
    patchedPromptSource,
    /function secondPrompt\(\)\{if\(\(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt\(\)\)\|\|e\|\|i\.canQuitWithoutPrompt\(\)\|\|r\|\|!s&&!c\)\{g=!0,a\.markAppQuitting\(\);return\}\}/,
  );

  const unpatchedDrain =
    "Promise.all([...u.values()].map(e=>e.flush())).finally(()=>{d(),f.dispose(),n.app.quit()})";
  const patchedDrain =
    "(()=>{let codexLinuxFinalizeQuit=()=>{d(),f.dispose(),n.app.quit()},codexLinuxDrainPromise=Promise.all([...u.values()].map(e=>e.flush()));if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===`number`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()";
  const patchedDrainSource = applyPatchTwice(
    applyLinuxWillQuitDrainTimeoutPatch,
    `${patchedDrain}function secondDrain(){${unpatchedDrain}}`,
  );
  assert.equal((patchedDrainSource.match(/codexLinuxDrainPromise=Promise\.all/g) ?? []).length, 2);
  assert.match(
    patchedDrainSource,
    /function secondDrain\(\)\{\(\(\)=>\{let codexLinuxFinalizeQuit=\(\)=>\{d\(\),f\.dispose\(\),n\.app\.quit\(\)\},codexLinuxDrainPromise=Promise\.all\(\[\.\.\.u\.values\(\)\]\.map\(e=>e\.flush\(\)\)\);/,
  );
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
    "case`primary`:return n===`darwin`?t?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r)}:{titleBarStyle:`default`};",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeTitlebarPatch, source);

  assert.match(
    patched,
    /function codexLinuxTitleBarOverlay\(e=1\)\{return\{color:a\.nativeTheme\.shouldUseDarkColors\?`#111111`:o2,symbolColor:a\.nativeTheme\.shouldUseDarkColors\?v2:_2,height:Math\.round\(30\*e\)\}\}/,
  );
  assert.match(
    patched,
    /n===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay\(r\)\}/,
  );
  assert.doesNotMatch(patched, /n===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:b2\(r\)\}:\{titleBarStyle:`default`\}/);
  assert.doesNotMatch(patched, /n===`win32`\|\|n===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:b2\(r\)\}/);
});

test("uses a module-scoped Linux native titlebar helper when aliases shadow Electron", () => {
  const source = [
    "function A3(e){return e===`avatarOverlay`}",
    "function I3({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A3(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?L4:K4,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A3(t)?{backgroundColor:r?L4:K4,backgroundMaterial:null}:{backgroundColor:W4,backgroundMaterial:null}}",
    "function o3(e=1){return{color:W4,symbolColor:r.nativeTheme.shouldUseDarkColors?i3:r3,height:Math.round(g3*e)}}",
    "function T3({appearance:e,opaqueWindowSurfaceEnabled:t,platform:n,windowZoom:r=1}){switch(e){case`primary`:return n===`darwin`?t?{titleBarStyle:`hiddenInset`,trafficLightPosition:a3(r)}:{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:a3(r)}:n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:o3(r)}:{titleBarStyle:`default`};}}",
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
    /n===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay\(r\)\}/,
  );
  assert.doesNotMatch(value, /titleBarOverlay:\{color:r\.nativeTheme\.shouldUseDarkColors/);
  assert.deepEqual(warnings, []);
});

test("updates the Linux native titlebar overlay when nativeTheme changes", () => {
  const source = [
    "function A2(e){return e===`avatarOverlay`}",
    "function I2({platform:e,appearance:t,opaqueWindowsEnabled:n,prefersDarkColors:r}){return n&&!A2(t)&&(e===`darwin`||e===`win32`)?{backgroundColor:r?a2:o2,backgroundMaterial:e===`win32`?`none`:null}:e===`linux`&&!A2(t)?{backgroundColor:r?a2:o2,backgroundMaterial:null}:{backgroundColor:i2,backgroundMaterial:null}}",
    "function b2(e=1){return{color:i2,symbolColor:a.nativeTheme.shouldUseDarkColors?v2:_2,height:Math.round(g2*e)}}",
    "case`primary`:return n===`darwin`?t?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r)}:{titleBarStyle:`default`};",
    "installWindowsTitleBarOverlaySync(e,t){if(process.platform!==`win32`||t!==`primary`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
  ].join("");
  const patched = applyPatchTwice(applyLinuxNativeTitlebarPatch, source);

  assert.match(
    patched,
    /if\(\(process\.platform!==`win32`&&process\.platform!==`linux`\)\|\|t!==`primary`\)return/,
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
    "case`primary`:return n===`darwin`?t?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r)}:{titleBarStyle:`default`};",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
    "process.platform===`darwin`?n.setWindowButtonPosition(y2(t)):(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(b2(t)))",
  ].join("");
  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxNativeTitlebarPatch, source),
  );

  assert.match(
    patched,
    /n===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:codexLinuxTitleBarOverlay\(r\)\}/,
  );
  assert.match(
    patched,
    /installApplicationMenuTitleBarOverlaySync\(e,t\)\{if\(\(process\.platform!==`win32`&&process\.platform!==`linux`\)\|\|t!==`primary`\)return/,
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
    "case`primary`:return n===`darwin`?t?{titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:y2(r)}:n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:b2(r)}:{titleBarStyle:`default`};",
    "installApplicationMenuTitleBarOverlaySync(e,t){if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(b2(this.windowZooms.get(e.id)))};return a.nativeTheme.on(`updated`,n),n(),()=>{a.nativeTheme.off(`updated`,n)}}",
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

test("adds Linux menu hiding next to Windows removeMenu calls", () => {
  const source = "process.platform===`win32`&&k.removeMenu(),";
  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal(
    patched,
    "process.platform===`linux`&&k.setMenuBarVisibility(!1),process.platform===`win32`&&k.removeMenu(),",
  );
});

test("patches remaining Windows menu snippets when another copy is already Linux-patched", () => {
  const windowsMenuSnippet = "process.platform===`win32`&&k.removeMenu(),";
  const linuxMenuPatch = "process.platform===`linux`&&k.setMenuBarVisibility(!1),";
  const source = `${linuxMenuPatch}${windowsMenuSnippet}function createSecondWindow(){${windowsMenuSnippet}}`;

  const patched = applyPatchTwice(applyLinuxMenuPatch, source);

  assert.equal((patched.match(/setMenuBarVisibility\(!1\)/g) ?? []).length, 2);
  assert.match(
    patched,
    /function createSecondWindow\(\)\{process\.platform===`linux`&&k\.setMenuBarVisibility\(!1\),process\.platform===`win32`&&k\.removeMenu\(\),\}/,
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

test("patches current webview opaque window default bundle shapes", () => {
  const resolvedThemeSource =
    "function oe(e,t){let n=o[t];return{accent:p(e?.accent)??n.accent,contrast:se(e?.contrast,n.contrast),fonts:le(e?.fonts),ink:p(e?.ink)??n.ink,opaqueWindows:e?.opaqueWindows??n.opaqueWindows,semanticColors:ue(e?.semanticColors,n.semanticColors),surface:p(e?.surface)??n.surface}}";
  const runtimeSource =
    "let{data:c}=Qc(y.APPEARANCE_LIGHT_CHROME_THEME,s),l;let{data:u}=Qc(y.APPEARANCE_DARK_CHROME_THEME,l),d;let x=b,S;let C=o===`light`?x:S,w;if(C.opaqueWindows&&!ba()){e.classList.add(`electron-opaque`)}";
  const appMainRuntimeSource =
    "document.querySelector(`[data-codex-window-type=\"electron\"]`);if(e){if((g.opaqueWindows||i)&&!pc()){e.classList.add(`electron-opaque`);return}e.classList.remove(`electron-opaque`)}";
  const settingsSource =
    "function sn(){let{canImportThemeString:u,setThemePatch:b,theme:x}=p(t),S=vn(r,t),k=[{label:i}],A=[];return x.opaqueWindows}";

  const patchedResolvedTheme = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, resolvedThemeSource);
  const patchedRuntime = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, runtimeSource);
  const patchedAppMainRuntime = applyPatchTwice(applyLinuxOpaqueWindowsDefaultPatch, appMainRuntimeSource);
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
  assert.match(
    patchedAppMainRuntime,
    /document\.documentElement\.dataset\.codexOs===`linux`&&g\.opaqueWindows==null&&\(g=\{\.\.\.g,opaqueWindows:!0\}\),\(g\.opaqueWindows\|\|i\)&&!pc\(\)/,
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

test("warns when a matched webview opaque bundle has no known insertion point", () => {
  const { warnings } = captureWarns(() =>
    applyLinuxOpaqueWindowsDefaultPatch("function runtime(){let C=theme;if(C.opaqueWindows&&!ba()){}}"),
  );

  assert.deepEqual(warnings, [
    "WARN: Could not find Linux opaque window default insertion point — skipping settings default patch",
  ]);
});

test("does not treat unrelated Linux userAgent checks as opaque window patches", () => {
  const { warnings } = captureWarns(() =>
    applyLinuxOpaqueWindowsDefaultPatch(
      "function unrelated(){return navigator.userAgent.includes(`Linux`)&&ready}function runtime(){let C=theme;if(C.opaqueWindows&&!ba()){}}",
    ),
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

test("keeps avatar overlay layout sync working after layout alias drift", () => {
  const source = avatarOverlayBundleFixture().replaceAll("r.windowBounds", "n.windowBounds");

  const patched = applyPatchTwice(applyLinuxAvatarOverlayMousePassthroughPatch, source);

  assert.match(
    patched,
    /this\.setWindowBounds\(e,n\.windowBounds\),this\.sendLayoutToRenderer\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)\}getLayout\(e\)\{/,
  );
});

test("keeps avatar overlay interactivity working after native presentation drift", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(
      applyLinuxAvatarOverlayMousePassthroughPatch,
      currentAvatarOverlayBundleFixture(),
    ),
  );

  assert.deepEqual(warnings, []);
  assert.match(patched, /this\.applyLatestElementSizes\(i\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /this\.codexLinuxAvatarCompositorHintsApplied=!1,this\.codexLinuxAvatarCompositorHintsApplying=!1,this\.compositionHost\.setOverlayWindow\(t\)/);
  assert.match(patched, /traySize:process\.platform===`linux`&&typeof this\.codexLinuxIsI3Session==`function`&&this\.codexLinuxIsI3Session\(\)\?this\.traySize:this\.traySize\?\?\(this\.layoutMode===`native`\?u1:l1\)/);
  assert.match(patched, /this\.setWindowBounds\(e,a\.windowBounds,n,r\),this\.sendLayoutToRenderer\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/);
  assert.match(patched, /e\.moveTop\(\),e\.showInactive\(\),process\.platform===`linux`&&this\.codexLinuxApplyAvatarCompositorHints\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\),!t&&this\.isOpen\(\)&&this\.broadcastOpenState\(\)\}showWindowIfReady/);
  assert.match(patched, /this\.cancelMomentum\(\),this\.clearMovedWindowPersist\(\),this\.window=null/);
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

test("patches remaining Linux window icon snippets when another window is already patched", () => {
  const iconAsset = "app-test.png";
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const windowOptionsSource = "...process.platform===`win32`?{autoHideMenuBar:!0}:{},";
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

test("adds Linux tray support including the platform guard", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const packagedTrayIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop-tray.png`";
  const packagedAppIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop.png`";
  const patched = applyPatchTwice(applyLinuxTrayPatch, trayBundleFixture(), iconPathExpression);

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

test("uses collision-proof Linux tray icon variables when Electron alias is r", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const source = [
    "let r=require(`electron`),i=require(`node:path`);",
    "async function Hw(e){return process.platform!==`win32`&&process.platform!==`darwin`?null:(zw=!0,Lw??Rw??(Rw=(async()=>{let t=await Ww(e.buildFlavor,e.repoRoot),i=new r.Tray(t.defaultIcon);return i})()))}",
    "async function Ww(e,t){if(process.platform===`darwin`){return null}let n=process.platform===`win32`?`.ico`:`.png`,a=Nw(e,process.platform),o=[...r.app.isPackaged?[(0,i.join)(process.resourcesPath,`${a}${n}`)]:[],(0,i.join)(t,`electron`,`src`,`icons`,`${a}${n}`)];for(let e of o){let t=r.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await r.app.getFileIcon(process.execPath,{size:process.platform===`win32`?`small`:`normal`}),chronicleRunningIcon:null}}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxTrayPatch, source, iconPathExpression);

  assert.doesNotMatch(patched, /let r=r\.nativeImage/);
  assert.match(
    patched,
    /let __codexLinuxUpstreamTrayIcon=r\.nativeImage\.createFromPath\(process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/app-test\.png`\)/,
  );
});

test("adds Linux tray support even when About dialog already uses the bundled icon path", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const packagedTrayIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop-tray.png`";
  const source = [
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

test("makes About dialog prefer the bundled Linux icon asset", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const source = [
    "let a=require(`electron`),r={T:()=>null,V:()=>({formatMessage:({defaultMessage:e})=>e})},t={dt:()=>null,Kr:()=>null};",
    "var $X=`codex.aboutDialog.title`,eZ=`About {appName}`,tZ=`codex.aboutDialog.ok`,nZ=`codex.aboutDialog.versionLine`,rZ=`Version {version}`,iZ=`codex.aboutDialog.versionLineWithDate`,aZ=`Version {version} • Released {releaseDate}`,oZ=`codex.aboutDialog.buildInfoLabel`,sZ=`Build information`,cZ=380,lZ=360,uZ=72,pZ=null;",
    "async function bZ(){let e=process.platform===`darwin`,t=e?r.T():process.execPath,[n,i]=await Promise.all([e?Fw(t):null,a.app.getFileIcon(t,{size:process.platform===`win32`?`large`:`normal`})]);return{htmlIconDataUrl:n??(i.isEmpty()?null:i.resize({width:uZ,height:uZ,quality:`best`}).toDataURL()),windowIcon:i}}",
    "let d={windowIcon:null},q={...d.windowIcon.isEmpty()?{}:{icon:d.windowIcon}};",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAboutDialogPatch, source, iconPathExpression);

  assert.match(
    patched,
    new RegExp(`nativeImage\\.createFromPath\\(${escapeRegExp(iconPathExpression)}\\)`),
  );
  assert.match(patched, /process\.platform===`linux`\?null:e\?Fw\(t\):null/);
  assert.match(patched, /windowIcon==null\|\|d\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:d\.windowIcon\}/);
  assert.match(patched, /i==null\|\|i\.isEmpty\(\)\?null:i\.resize\(/);
  assert.match(patched, /windowIcon:i\?\?null/);
  assert.doesNotThrow(() => new Function(patched));
});

test("upgrades partially patched About dialog icon fallbacks after alias drift", () => {
  const iconPathExpression = "process.resourcesPath+`/../content/webview/assets/app-test.png`";
  const source = [
    "let r=require(`electron`),n={T:()=>null};",
    "var UZ=`codex.aboutDialog.title`,eQ=72;",
    "async function dQ(){let e=process.platform===`darwin`,t=e?n.T():process.execPath,[i,a]=await Promise.all([",
    "process.platform===`linux`?null:e?tT(t):null,",
    "process.platform===`linux`?Promise.resolve((()=>{let __codexLinuxAboutIcon=r.nativeImage.createFromPath(process.resourcesPath+`/../content/webview/assets/app-test.png`);return __codexLinuxAboutIcon.isEmpty()?null:__codexLinuxAboutIcon})()):r.app.getFileIcon(t,{size:process.platform===`win32`?`large`:`normal`}).catch(()=>null)",
    "]);return{htmlIconDataUrl:i??(a.isEmpty()?null:a.resize({width:eQ,height:eQ,quality:`best`}).toDataURL()),windowIcon:a}}",
    "let f={windowIcon:null},x={...f.windowIcon.isEmpty()?{}:{icon:f.windowIcon}};",
  ].join("");
  const { value: patched, warnings } = captureWarns(() =>
    applyPatchTwice(applyLinuxAboutDialogPatch, source, iconPathExpression),
  );

  assert.deepEqual(warnings, []);
  assert.match(patched, /a==null\|\|a\.isEmpty\(\)\?null:a\.resize\(/);
  assert.match(patched, /windowIcon:a\?\?null/);
  assert.match(patched, /f\.windowIcon==null\|\|f\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:f\.windowIcon\}/);
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
  assert.match(
    patched,
    /catch\(e\)\{O=!1;process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
  );
  assert.equal((patched.match(/\[codex-linux\] Failed to set up system tray/g) ?? []).length, 1);
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
  assert.match(patched, /catch\(e\)\{A=!1\}\};U&&startOther\(\);/);
  assert.match(
    patched,
    /catch\(e\)\{O=!1;process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
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
  assert.match(
    patched,
    /catch\(e\)\{O=!1;process\.platform===`linux`&&console\.warn\(`\[codex-linux\] Failed to set up system tray`,e\)\}/,
  );
});

test("logs Linux tray setup failures when the catch body contains nested objects", () => {
  const source = [
    "async function s4(e){let t=await l4(e.buildFlavor,e.repoRoot),n=new a.Tray(t.defaultIcon);return n}",
    "let _e=async()=>{k=!0;try{await s4({buildFlavor:o,repoRoot:M.repoRoot})}catch(e){k=!1,v.reportNonFatal(e instanceof Error?e:`Failed to set up tray`,{kind:`tray-setup-failed`,tags:{errorType:`tray-setup-failed`}}),N.ensureWindow()}};D&&_e();",
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

test("lets explicit Linux multi-instance launches bypass the bootstrap single-instance lock", () => {
  const source =
    "var S=t.x({isMacOS:b,isPackaged:n.app.isPackaged});if(!(!S||n.app.requestSingleInstanceLock()))t.Jr().info(`Exiting second desktop instance`,{safe:{packaged:n.app.isPackaged,platform:process.platform}}),n.app.exit(0);else{let e=t.C(x);}";
  const patched = applyPatchTwice(applyLinuxMultiInstanceBootstrapPatch, source);

  assert.match(
    patched,
    /if\(!\(!S\|\|process\.platform===`linux`&&process\.env\.CODEX_LINUX_MULTI_LAUNCH===`1`\|\|n\.app\.requestSingleInstanceLock\(\)\)\)/,
  );
  assert.match(patched, /Exiting second desktop instance/);
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

test("adds Keybinds settings route with current lazy and preload aliases", () => {
  const patched = applyPatchTwice(
    applyKeybindsSettingsIndexPatch,
    keybindsIndexBundleWithLazyAliasDriftFixture(),
  );

  assert.match(
    patched,
    /var i_e=\{keybinds:\(0,R\.lazy\)\(\(\)=>q\(\(\)=>import\(`\.\/keybinds-settings-linux\.js`\)/,
  );
  assert.doesNotMatch(patched, /keybinds:\(0,Z\.lazy\)\(\(\)=>s\(/);
});

test("adds Linux desktop settings route when upstream owns Keyboard Shortcuts", () => {
  const patched = applyPatchTwice(
    applyLinuxDesktopSettingsIndexPatch,
    keybindsIndexBundleFixture(),
  );

  assert.match(
    patched,
    /var i_e=\{"linux-desktop":\(0,Z\.lazy\)\(\(\)=>s\(\(\)=>import\(`\.\/linux-desktop-settings-linux\.js`\)/,
  );
  assert.match(patched, /var Kge=\{"linux-desktop":xh,"general-settings":xh,/);
  assert.match(patched, /qge=\[`general-settings`,`linux-desktop`,`appearance`/);
  assert.match(patched, /slugs:\[`general-settings`,`linux-desktop`,`appearance`/);
  assert.match(patched, /case`linux-desktop`:return l===`electron`/);
  assert.match(patched, /case`linux-desktop`:k=!1;break bb0;/);
  assert.doesNotMatch(patched, /codexLinuxKeybindOverridesRuntime/);
});

test("keeps Linux desktop toggles visible with native Keyboard Shortcuts", () => {
  const { extractedDir, assetsDir } = createNativeKeyboardShortcutsSettingsFixture();
  try {
    const result = patchKeybindsSettingsAssets(extractedDir);

    assert.equal(result.matched, true);
    assert.ok(result.changed >= 4);
    assert.match(result.reason, /upstream keyboard shortcuts settings are present/);
    assert.equal(fs.existsSync(path.join(assetsDir, keybindsSettingsAsset)), false);
    assert.equal(fs.existsSync(path.join(assetsDir, linuxDesktopSettingsAsset)), true);

    const linuxDesktopSource = fs.readFileSync(
      path.join(assetsDir, linuxDesktopSettingsAsset),
      "utf8",
    );
    assert.match(linuxDesktopSource, /Linux desktop/);
    assert.match(linuxDesktopSource, /Compact prompt window/);
    assert.match(linuxDesktopSource, /System tray/);
    assert.match(linuxDesktopSource, /Warm start/);
    assert.match(linuxDesktopSource, /Install updates when you close Codex/);
    assert.match(linuxDesktopSource, /Build information/);
    assert.match(linuxDesktopSource, /Linux source commit/);
    assert.match(linuxDesktopSource, /Copy commit/);
    assert.match(linuxDesktopSource, /Open commit/);
    assert.match(linuxDesktopSource, /codex-linux-get-build-info/);
    assert.match(linuxDesktopSource, /codex-linux-system-tray-enabled/);
    assert.match(linuxDesktopSource, /codex-linux-auto-update-on-exit/);
    assert.match(linuxDesktopSource, /import\{z as __post\}from"\.\/setting-storage-A\.js"/);

    assert.match(
      fs.readFileSync(path.join(assetsDir, "settings-sections-A.js"), "utf8"),
      /slug:`linux-desktop`/,
    );
    assert.match(
      fs.readFileSync(path.join(assetsDir, "settings-shared-A.js"), "utf8"),
      /settings\.nav\.linux-desktop/,
    );
    const appMainSource = fs.readFileSync(path.join(assetsDir, "app-main-A.js"), "utf8");
    assert.match(appMainSource, /linux-desktop-settings-linux\.js/);
    assert.doesNotMatch(appMainSource, /keybinds-settings-linux\.js/);
    const settingsPageSource = fs.readFileSync(path.join(assetsDir, "settings-page-A.js"), "utf8");
    assert.match(settingsPageSource, /"linux-desktop":q,"general-settings":q/);
    assert.match(settingsPageSource, /slugs:\[`general-settings`,`linux-desktop`,`profile`/);
    assert.match(settingsPageSource, /case`linux-desktop`:case`general-settings`/);

    const secondResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(secondResult.matched, true);
    assert.equal(secondResult.changed, 0);
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

test("adds the keybinds section title when the JSX message component identifier drifts", () => {
  const patched = applyKeybindsSettingsSharedPatch(
    settingsSharedBundleWithDriftingJsxAliasFixture(),
  );

  assert.match(
    patched,
    /case`keybinds`:\{return \(0,d\.jsx\)\(r,\{id:`settings\.section\.keybinds`,defaultMessage:`Keybinds`,description:`Title for keybinds settings section`\}\)\}/,
  );
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

test("shows the profile dropdown settings route on Linux", () => {
  const source =
    "function E(){let Ct=se(`4166894088`),Pt=Ct,Ft=f(De,`settings`),U=Pt&&(0,C.jsx)(S,{LeftIcon:ye,keyboardShortcut:Ft,onClick:()=>{v(`/settings/general-settings`)},children:(0,C.jsx)(g,{id:`codex.profileDropdown.settingsPage`,defaultMessage:`Settings`})});return U}";

  const patched = applyPatchTwice(applyLinuxProfileSettingsMenuPatch, source);

  assert.match(patched, /let Ct=!0,Pt=Ct,Ft=f\(De,`settings`\)/);
  assert.match(patched, /\/settings\/general-settings/);
  assert.match(patched, /codex\.profileDropdown\.settingsPage/);
});

test("removes unsupported features from default app-server feature sync", () => {
  const source = [
    "var GF=[`apps`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`mentions_v2`,`plugins`,`remote_control`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,te];",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r}).catch(n=>{q.error(`Failed to sync experimental feature enablement`,{sensitive:{error:n}})})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e){let t={};for(let n of GF){let r=e[n];r!=null&&(t[n]=r)}return t}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.match(
    patched,
    /var GF=\[`apps`,`memories`,`mentions_v2`,`plugins`,`remote_control`,`tool_call_mcp_elicitation`,`tool_suggest`\];/,
  );
  assert.doesNotMatch(patched, /`auth_elicitation`/);
  assert.doesNotMatch(patched, /`enable_mcp_apps`/);
  assert.doesNotMatch(patched, /`tool_search`/);
  assert.doesNotMatch(patched, /,te\]/);
});

test("patches the matched app-server feature sync array when an identical array appears earlier", () => {
  const unsupportedFeatureArray =
    "var GF=[`apps`,`auth_elicitation`,`enable_mcp_apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_search`,`tool_suggest`,te];";
  const supportedFeatureArray =
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`];";
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

test("removes unsupported dynamic extra from current app-server feature sync", () => {
  const source = [
    "var GF=[`apps`,`memories`,`plugins`,`tool_call_mcp_elicitation`,`tool_suggest`],vI=`remote_plugin`;",
    "function KF(){let e=(0,Z.c)(6),t=K(G),[n]=ts(`statsig_default_enable_features`),r=Lc(),i=Io(),a,o;",
    "return e[0]!==r?(a=()=>{let r=qF(n,!0);qn(`set-experimental-feature-enablement-for-host`,{hostId:t,enablement:r}).catch(n=>{q.error(`Failed to sync experimental feature enablement`,{sensitive:{error:n}})})},o=[r],e[0]=r,e[1]=a,e[2]=o):(a=e[1],o=e[2]),null}",
    "function qF(e,t){let n={};for(let r of GF){let i=e[r];i!=null&&(n[r]=i)}return n[vI]=t,n}",
  ].join("");

  const patched = applyPatchTwice(applyLinuxAppServerFeatureEnablementPatch, source);

  assert.notEqual(patched, source);
  assert.match(patched, /function qF\(e,t\)\{let n=\{\};for\(let r of GF\)\{let i=e\[r\];i!=null&&\(n\[r\]=i\)\}return n\}/);
  assert.doesNotMatch(patched, /n\[vI\]=t/);
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

test("adds Linux package updater behind the existing app updater manager", () => {
  const patched = applyPatchTwice(applyLinuxAppUpdaterBridgePatch, appUpdaterBundleFixture());

  assert.match(patched, /function codexLinuxGetElectronModule\(\)/);
  assert.match(patched, /function codexLinuxReadUpdateState\(\)/);
  assert.match(patched, /function codexLinuxUpdateLifecycleState\(e\)/);
  assert.match(patched, /function codexLinuxUpdateManagerPath\(\)/);
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
  assert.match(patched, /codexLinuxInstallAfterQuit\(\);let t=codexLinuxGetElectronModule\(\);if\(!t\)return;let e=setTimeout/);
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
  assert.match(patched, /this\.updater=\{setAutomaticBackgroundDownloadsEnabled:\(\)=>\{\},checkForUpdates/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`check-now`\]\)/);
  assert.match(patched, /codexLinuxRunUpdateManager\(\[`install-ready`\]\)/);
  assert.match(patched, /this\.setInstallProgressPercent\(0\),this\.setUpdateLifecycleState\(`installing`\)/);
  assert.match(patched, /this\.setInstallProgressPercent\(null\),codexLinuxQuitForUpdate\(\)/);
  assert.doesNotMatch(patched, /this\.options\.onInstallUpdatesRequested\?\.\(\)/);
  assert.match(patched, /n\.stdout\?\.includes\(`already installed`\)\?await codexLinuxShowUpdateMessage/);
  assert.match(patched, /if\(t\?\.status===`waiting_for_app_exit`\)/);
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

test("patches all unpatched Computer Use gates in one pass", () => {
  const source = [
    "var tn=`computer-use`;",
    "var $n=[{name:tn,isEnabled:({features:e,platform:t})=>t===`darwin`&&e.computerUse,migrate:on},{name:tn,isEnabled:({features:n,platform:r})=>r===`darwin`&&n.computerUse,migrate:wn}];",
  ].join("");

  const patched = applyLinuxComputerUsePluginGatePatch(source);

  assert.equal((patched.match(/installWhenMissing:!0,name:tn/g) || []).length, 2);
  assert.match(patched, /\(t===`darwin`\|\|t===`linux`\)&&e\.computerUse/);
  assert.match(patched, /\(r===`darwin`\|\|r===`linux`\)&&n\.computerUse/);
  assert.doesNotMatch(patched, /===`darwin`&&/);
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
    /\{forceReload:!0,installWhenMissing:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,features:t\}\)=>process\.platform===`linux`\|\|\(t\.externalBrowserUseAllowed&&\$n\(e\)\)\}/,
  );
  assert.match(patched, /name:xt,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,env:t,features:n\}\)=>Ar\(e,t\)&&n\.externalBrowserUseAllowed/);
  assert.match(patched, /name:dt,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,env:t,features:n\}\)=>jr\(e,t\)&&n\.externalBrowserUseAllowed/);
  assert.equal((patched.match(/installWhenMissing:!0,name:ut/g) || []).length, 1);
  assert.equal((patched.match(/installWhenMissing:!0,name:dt/g) || []).length, 0);
  assert.equal((patched.match(/installWhenMissing:!0,name:xt/g) || []).length, 0);
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

test("reports drifted Chrome native host runtime resolver as required upstream failure", () => {
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
    assert.equal(runtimePatch.status, "failed-required");
    assert.match(runtimePatch.reason, /Could not identify Chrome native host runtime resolver shape/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-chrome-native-host-runtime: failed-required"),
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("adds Linux availability to an already auto-installed Chrome plugin gate", () => {
  const source = currentPluginGateBundleFixture().replace(
    "{forceReload:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:",
    "{forceReload:!0,installWhenMissing:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:",
  );

  const patched = applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source);

  assert.match(
    patched,
    /installWhenMissing:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:e,features:t\}\)=>process\.platform===`linux`\|\|\(t\.externalBrowserUseAllowed&&\$n\(e\)\)/,
  );
});

test("keeps a fully Linux-enabled Chrome plugin gate unchanged", () => {
  const source = currentPluginGateBundleFixture().replace(
    "{forceReload:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&$n(e)}",
    "{forceReload:!0,installWhenMissing:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:({buildFlavor:e,features:t})=>process.platform===`linux`||(t.externalBrowserUseAllowed&&$n(e))}",
  );

  assert.equal(applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source), source);
});

test("does not treat unrelated Linux platform checks as Chrome plugin availability", () => {
  const source = currentPluginGateBundleFixture()
    .replace(
      "{forceReload:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:",
      "{forceReload:!0,installWhenMissing:!0,name:ut,syncInstallStateWithChromeExtension:!0,isAvailable:",
    )
    .replace(
      "({buildFlavor:e,features:t})=>t.externalBrowserUseAllowed&&$n(e)}",
      "function({features:t}){return t.externalBrowserUseAllowed}}",
    ) + "var __codexOtherLinuxPatch=process.platform===`linux`;";

  assert.throws(
    () => applyLinuxChromePluginAutoInstallPatch(source),
    /Required Linux Chrome plugin auto-install patch failed/,
  );
});

test("handles literal Chrome plugin gate names", () => {
  const source =
    "var Kr=[{forceReload:!0,name:'chrome',isEnabled:({features:t})=>t.externalBrowserUseAllowed},{forceReload:!0,name:'chrome-internal',isEnabled:({features:t})=>t.externalBrowserUseAllowed}];";

  const patched = applyPatchTwice(applyLinuxChromePluginAutoInstallPatch, source);

  assert.match(patched, /installWhenMissing:!0,name:'chrome'/);
  assert.match(patched, /process\.platform===`linux`\|\|\(t\.externalBrowserUseAllowed\)/);
  assert.doesNotMatch(patched, /installWhenMissing:!0,name:'chrome-internal'/);
});

test("reports missing required Chrome plugin auto-install gate as required upstream validation failure", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-chrome-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), `${mainBundlePrefix}var plugins=[];`);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const pluginGatePatch = report.patches.find((patch) => patch.name === "linux-chrome-plugin-auto-install");
    assert.equal(pluginGatePatch.status, "failed-required");
    assert.match(pluginGatePatch.reason, /Could not find Chrome plugin gate literal/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-chrome-plugin-auto-install: failed-required"),
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

test("reports missing required Computer Use plugin gate as required upstream validation failure", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-patch-report-missing-computer-use-"));
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), `${mainBundlePrefix}var plugins=[];`);

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));

    const pluginGatePatch = report.patches.find((patch) => patch.name === "linux-computer-use-plugin-gate");
    assert.equal(pluginGatePatch.status, "failed-required");
    assert.match(pluginGatePatch.reason, /Could not find Computer Use plugin gate literal/);
    assert.ok(
      validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-computer-use-plugin-gate: failed-required"),
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

test("shows current use-is-plugins-enabled Computer Use UI on Linux", () => {
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

test("falls back to the single live Linux Browser Use route window", () => {
  const source =
    "var kK=t.Ur(`browser-sidebar-manager`);" +
    "function AK({ensureWindowState:e,windowId:t,windows:n}){let i=n.get(t)??null;if(i==null){let n=r.BrowserWindow.fromId(t);n!=null&&!n.isDestroyed()&&!n.webContents.isDestroyed()&&(i=e(n,n.webContents))}return i==null||i.window.isDestroyed()||i.owner.isDestroyed()?(kK().warning(`IAB_LIFECYCLE route window is not live`,{safe:{hasWindowState:i!=null,ownerDestroyed:i?.owner.isDestroyed()??null,windowDestroyed:i?.window.isDestroyed()??null,windowId:t},sensitive:{}}),null):i}";

  const patched = applyPatchTwice(applyLinuxBrowserUseRouteLivenessPatch, source);

  assert.match(patched, /function codexLinuxResolveLiveBrowserUseRouteWindow/);
  assert.match(patched, /i==null&&\(i=codexLinuxResolveLiveBrowserUseRouteWindow\(e,t,n,r\)\);return/);
  assert.equal((patched.match(/codexLinuxResolveLiveBrowserUseRouteWindow/g) || []).length, 2);

  const webContents = { isDestroyed: () => false };
  const window = { id: 7, isDestroyed: () => false, webContents };
  const context = {
    process: { platform: "linux" },
    r: { BrowserWindow: { fromId: () => null, getAllWindows: () => [window] } },
    t: { Ur: () => () => ({ warning: () => assert.fail("fallback should avoid warning") }) },
  };
  const result = vm.runInNewContext(
    `${patched};AK({ensureWindowState:(window,owner)=>({owner,threads:new Map,window}),windowId:42,windows:new Map})`,
    context,
  );

  assert.equal(result.window.id, 7);
  assert.equal(result.owner, webContents);
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

test("patches all Computer Use install flow gates in one pass", () => {
  const source = [
    "ne=f({featureName:`computer_use`,hostId:t}),re=!ne.isLoading&&ne.enabled||navigator.userAgent.includes(`Linux`),",
    "xe=g({featureName:`computer_use`,hostId:o}),ye=!xe.isLoading&&xe.enabled,",
  ].join("");

  const patched = applyLinuxComputerUseInstallFlowPatch(source);

  assert.equal((patched.match(/navigator\.userAgent\.includes\(`Linux`\)/g) || []).length, 2);
  assert.doesNotMatch(patched, /ye=!xe\.isLoading&&xe\.enabled,/);
});

test("auto-approves the app-provided Browser Use node_repl bridge", () => {
  const source =
    "return{[`mcp_servers.${pt}`]:{command:i.nodeReplPath,args:[],startup_timeout_sec:120,env:{[dt]:l,[ft]:i.nodePath}}}";

  const patched = applyPatchTwice(applyBrowserUseNodeReplApprovalPatch, source);

  assert.match(patched, /tools:\{js:\{approval_mode:`approve`\}\}/);
  assert.match(patched, /env:\{\[dt\]:l,\[ft\]:i\.nodePath/);
});

test("patches all Browser Use node_repl approval configs in one pass", () => {
  const source = [
    "startup_timeout_sec:120,tools:{js:{approval_mode:`approve`}},env:{[dt]:l}",
    "startup_timeout_sec:120,env:{[ft]:i.nodePath}",
  ].join("");

  const patched = applyBrowserUseNodeReplApprovalPatch(source);

  assert.equal((patched.match(/approval_mode:`approve`/g) || []).length, 2);
  assert.doesNotMatch(patched, /startup_timeout_sec:120,env:\{/);
});

test("auto-approves the current Browser Use node_repl runtime config builder", () => {
  const source =
    "return e.Dn({codexCliPath:o.codexCliPath,nodePath:o.nodePath,nodeReplPath:o.nodeReplPath,platform:o.platform})";

  const patched = applyPatchTwice(applyBrowserUseNodeReplApprovalPatch, source);

  assert.match(
    patched,
    /e\.Dn\(\{codexCliPath:o\.codexCliPath,nodePath:o\.nodePath,nodeReplPath:o\.nodeReplPath,tools:\{js:\{approval_mode:`approve`\}\},platform:o\.platform\}\)/,
  );
});

test("trusts Linux patched bundled Browser Use clients by hashing staged files", () => {
  const resourcesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-client-hash-"));
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
    fs.writeFileSync(browserClient, "patched browser client\n", "utf8");
    fs.writeFileSync(chromeClient, "patched chrome client\n", "utf8");
    const browserHash = cryptoHash("patched browser client\n");
    const chromeHash = cryptoHash("patched chrome client\n");
    const source =
      "\"use strict\";let o=require(`node:fs`),i=require(`node:path`),s=require(`node:crypto`),nt=[`upstream-hash`];function nn({trustedBrowserClientSha256s:e}){return e}function build(){let p=!0,v=!1,f=nt;return nn({trustedBrowserClientSha256s:p||v?f:[]})}";

    const patched = applyPatchTwice(applyBrowserUseNodeReplApprovalPatch, source);

    assert.match(patched, /^"use strict";function codexLinuxTrustedBrowserClientSha256s/);
    assert.equal(
      (patched.match(/function codexLinuxTrustedBrowserClientSha256s/g) || []).length,
      1,
    );
    assert.match(patched, /codexLinuxTrustedBrowserClientSha256s\(f\)/);
    const linuxHashes = vm.runInNewContext(`${patched};build();`, {
      require,
      process: { platform: "linux", resourcesPath: resourcesRoot },
    });
    assert.deepEqual(Array.from(linuxHashes), ["upstream-hash", browserHash, chromeHash]);
    const darwinHashes = vm.runInNewContext(`${patched};build();`, {
      require,
      process: { platform: "darwin", resourcesPath: resourcesRoot },
    });
    assert.deepEqual(Array.from(darwinHashes), ["upstream-hash"]);
  } finally {
    fs.rmSync(resourcesRoot, { recursive: true, force: true });
  }
});

test("keeps removed IAB visible patch export as a no-op", () => {
  const source = "class BrowserSessionRegistry{}";

  assert.equal(applyLinuxBrowserUseIabVisibleOnCreatePatch(source), source);
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
  assert.match(
    patched,
    /process\.platform===`linux`&&process\.env\.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n\.app\.requestSingleInstanceLock\(\)/,
  );
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
      fs.writeFileSync(
        path.join(assetsDir, "use-is-plugins-enabled-current.js"),
        "function p(e){return e===`macOS`||e===`windows`}" +
          "function m(e){let n=(0,f.c)(15),{enabled:r,hostId:i}=e,a=r===void 0?!0:r,{isLoading:o,platform:s}=u(),c=t(i).kind===`local`,d=l(`1506311413`),h;n[0]===i?h=n[1]:(h={featureName:`computer_use`,hostId:i},n[0]=i,n[1]=h);let _=p(h),v;n[2]!==_.enabled||n[3]!==_.isLoading||n[4]!==a||n[5]!==d||n[6]!==c||n[7]!==o||n[8]!==s?(v=g({enabled:a,isComputerUseFeatureEnabled:_.enabled,isComputerUseFeatureLoading:_.isLoading,isComputerUseGateEnabled:d,isHostCompatiblePlatform:p(s),isHostLocal:c,isPlatformLoading:o,windowType:`electron`}),n[2]=_.enabled,n[3]=_.isLoading,n[4]=a,n[5]=d,n[6]=c,n[7]=o,n[8]=s,n[9]=v):v=n[9];return v}",
      );
      fs.writeFileSync(path.join(tempRoot, "package.json"), JSON.stringify({ name: "codex" }));

      patchExtractedApp(tempRoot);

      assert.match(
        fs.readFileSync(path.join(assetsDir, "apps-current.js"), "utf8"),
        /let _=a&&i&&\(c===`linux`\|\|l&&\(o\|\|m\)\),v=_&&!o&&\(c===`linux`\|\|p\.enabled\)&&!p\.isLoading/,
      );
      assert.match(
        fs.readFileSync(path.join(assetsDir, "use-is-plugins-enabled-current.js"), "utf8"),
        /v=g\(\{enabled:a,isComputerUseFeatureEnabled:s===`linux`\|\|_\.enabled,isComputerUseFeatureLoading:s!==`linux`&&_\.isLoading,isComputerUseGateEnabled:s===`linux`\|\|d,isHostCompatiblePlatform:s===`linux`\|\|p\(s\),isHostLocal:c,isPlatformLoading:o,windowType:`electron`\}\)/,
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
    assert.deepEqual(report.enabledFeatures, enabledLinuxFeatureIds());
    assert.ok(
      report.patches.some(
        (patch) =>
          patch.name === "main-process-ui" &&
          patch.status === "failed-required" &&
          patch.sourceKind === "core" &&
          Array.isArray(patch.warnings) &&
          patch.warnings.length > 0,
      ),
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
        entrypoints: { patches: "./patch.js" },
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
        entrypoints: { patches: "./patch.js" },
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
    /\(0,Q\.jsx\)\(Sm,\{conversationId:f,hostId:C,cwdOverride:w\}\),f==null\?null:\(0,Q\.jsx\)\(codexLinuxRateLimitFooter,\{conversationId:f\}\),\(0,Q\.jsx\)\(Rm,\{conversationId:f,hasGoal:y,isGoalActionAvailable:b,onClearGoal:x,showDivider:!0\}\)/,
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
