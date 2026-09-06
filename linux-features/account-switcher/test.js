#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

// Keep feature tests independent of the environment of the app or agent
// running the suite. Individual tests set any account-switcher state they need.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("CODEX_LINUX_ACCOUNT_SWITCHER_") ||
      name === "CODEX_ELECTRON_USER_DATA_PATH" ||
      name === "CODEX_HOME") {
    delete process.env[name];
  }
}

function processIdentity(pid = process.pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(") ") + 2).trim().split(/\s+/);
  return {
    pid,
    start: fields[19],
    boot: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
  };
}

function directFinalExitHandoff(lines) {
  const owner = processIdentity();
  return lines
    .replace("phase=requested", "phase=cleanup")
    .replace("\nfrom_id=", `\nowner_pid=${owner.pid}\nowner_start=${owner.start}\nowner_boot=${owner.boot}\nfrom_id=`);
}

const {
  MAIN_MARKER,
  PRELOAD_MARKER,
  MENU_MARKER,
  RUNTIME_MARKER,
  applyMainBundlePatch,
  applyPreloadPatch,
  applyProfileMenuPatch,
} = require("./patch.js");
const { loadLinuxFeaturePatchDescriptors, stageEnabledLinuxFeatureInstall } = require("../../scripts/lib/linux-features.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

function withFeatureConfig(enabled, fn) {
  const original = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
  try {
    return fn();
  } finally {
    if (original == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = original;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function stageSharedStateHelper(appDir) {
  const target = path.join(appDir, ".codex-linux", "features", "account-switcher");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "shared-state.sh"), path.join(target, "shared-state.sh"));
  fs.copyFileSync(path.join(__dirname, "shared-state-json.js"), path.join(target, "shared-state-json.js"));
  fs.copyFileSync(path.join(__dirname, "shared-state-sqlite.js"), path.join(target, "shared-state-sqlite.js"));
}

function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  assert.equal(fs.existsSync(filePath), true, `timed out waiting for ${filePath}`);
}

function runLogoutMonitorScenario({ activeAuth, fallbackAuth, loginPendingMs = null, removeActiveAuth = false, expectIdle = false }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-logout-"));
  const home = path.join(tempDir, "home");
  const configHome = path.join(home, ".config");
  const dataHome = path.join(home, ".local", "share");
  const configDir = path.join(configHome, "codex-desktop");
  const baseCodexHome = path.join(home, ".codex");
  const workCodexHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
  const actionPath = path.join(home, "monitor-action");
  const activeAuthPath = path.join(workCodexHome, "auth.json");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(baseCodexHome, { recursive: true });
  fs.mkdirSync(workCodexHome, { recursive: true });
  const profiles = [
    { id: "default", name: "Default", contextMode: "isolated", contextId: "default" },
    {
      id: "work",
      name: "Work",
      contextMode: "isolated",
      contextId: "default",
      ...(loginPendingMs != null ? { loginPendingUntil: new Date(Date.now() + loginPendingMs).toISOString() } : {}),
    },
  ];
  fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, previousProfileId: "default", profiles }, null, 2)}\n`);
  fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n");
  const auth = `${JSON.stringify({ tokens: { access_token: "fixture-token" } })}\n`;
  if (activeAuth) fs.writeFileSync(activeAuthPath, auth);
  if (fallbackAuth) fs.writeFileSync(path.join(baseCodexHome, "auth.json"), auth);

  const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let beforeQuit=null;
const l={app:{whenReady:()=>Promise.resolve(),once:(name,handler)=>{if(name==="before-quit")beforeQuit=handler},quit:()=>{beforeQuit?.();fs.writeFileSync(${JSON.stringify(actionPath)},"quit");process.exit(0)},focus:()=>{fs.writeFileSync(${JSON.stringify(actionPath)},"focus");process.exit(0)}},ipcMain:{handle:()=>{}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
${removeActiveAuth ? `setTimeout(()=>fs.rmSync(${JSON.stringify(activeAuthPath)},{force:true}),100);` : ""}
setTimeout(()=>{${expectIdle ? `fs.writeFileSync(${JSON.stringify(actionPath)},"idle");process.exit(0)` : "process.exit(91)"}},1800);
`;
  const patched = applyMainBundlePatch(fixture);
  const result = spawnSync(process.execPath, ["-e", patched], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      CODEX_HOME: workCodexHome,
      CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME: baseCodexHome,
      CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE: "work",
      CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT: "isolated",
      CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID: "default",
    },
    encoding: "utf8",
    timeout: 5000,
  });
  const output = {
    result,
    action: fs.existsSync(actionPath) ? fs.readFileSync(actionPath, "utf8") : null,
    active: fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"),
    handoff: fs.existsSync(path.join(configDir, "account-switcher.handoff"))
      ? fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8")
      : null,
    registry: JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8")),
  };
  fs.rmSync(tempDir, { recursive: true, force: true });
  return output;
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot }).some((entry) => entry.featureId === "account-switcher"), false);
  });
  withFeatureConfig(["account-switcher"], () => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).map((entry) => entry.id),
      [
        "feature:account-switcher:main-profile-ipc",
        "feature:account-switcher:preload-profile-bridge",
        "feature:account-switcher:account-switcher-ui",
      ],
    );
  });
});

test("main patch is idempotent and fails closed on anchor drift", () => {
  const fixture = "let _e=!1,ve=()=>null,ye=()=>null,be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);ure({});";
  const patched = applyMainBundlePatch(fixture);
  assert.match(patched, new RegExp(MAIN_MARKER));
  assert.equal(applyMainBundlePatch(patched), patched);
  const currentAlias = applyMainBundlePatch("trusted=e=>H.isTrustedIpcSender(e.sender,e.senderFrame??null);");
  assert.match(currentAlias, new RegExp(MAIN_MARKER));
  assert.match(currentAlias, /if\(!trusted\(codexLinuxAccountSwitcherEvent\)\)/);
  const missing = fixture.replace("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);", "");
  assert.equal(applyMainBundlePatch(missing), missing);
  assert.equal(applyMainBundlePatch(fixture + fixture), fixture + fixture);
});

test("preload bridge patch is idempotent and fails closed", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-preload-"));
  try {
    const buildDir = path.join(tempDir, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    const target = path.join(buildDir, "preload.js");
    fs.writeFileSync(target, "let e=require(\"electron\");var F={usesOwlAppShell:()=>E};e.ipcRenderer.on(\"x\",()=>{});e.contextBridge.exposeInMainWorld(`electronBridge`,F);");
    assert.equal(applyPreloadPatch(tempDir).changed, 1);
    const patched = fs.readFileSync(target, "utf8");
    assert.match(patched, new RegExp(PRELOAD_MARKER));
    assert.match(patched, /refreshLinuxAccountProfiles/);
    assert.match(patched, /action:"refresh"/);
    assert.match(patched, /removeLinuxAccountProfile/);
    assert.match(patched, /action:"remove"/);
    assert.match(patched, /setLinuxAccountSwitcherSettings/);
    assert.match(patched, /action:"set-settings"/);
    assert.equal(applyPreloadPatch(tempDir).changed, 0);
    fs.writeFileSync(target, "let e=require(\"electron\");var F={};e.ipcRenderer.on(\"x\",()=>{});e.contextBridge.exposeInMainWorld(`electronBridge`,F);e.contextBridge.exposeInMainWorld(`electronBridge`,F);");
    assert.equal(applyPreloadPatch(tempDir).changed, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("duplicate preload anchors are reported as enabled-feature drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-report-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
    fs.writeFileSync(path.join(buildDir, "preload.js"), "let e=require(\"electron\");var F={};e.ipcRenderer.on(\"x\",()=>{});e.contextBridge.exposeInMainWorld(`electronBridge`,F);e.contextBridge.exposeInMainWorld(`electronBridge`,F);");
    const config = path.join(root, "features.json");
    fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
    const report = createPatchReport();
    patchExtractedApp(root, { report, featuresConfigPath: config });
    const failure = enabledFeatureFailuresFromReport(report).find((entry) => entry.name.includes("preload-profile-bridge"));
    assert.equal(failure?.status, "skipped-optional");
    assert.match(failure?.reason ?? "", /found 2/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a missing preload anchor is reported as enabled-feature drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-report-missing-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
    fs.writeFileSync(path.join(buildDir, "preload.js"), "const preloadBridge={unrelated:true};");
    const config = path.join(root, "features.json");
    fs.writeFileSync(config, JSON.stringify({ enabled: ["account-switcher"] }));
    const report = createPatchReport();
    patchExtractedApp(root, { report, featuresConfigPath: config });
    const failure = enabledFeatureFailuresFromReport(report).find((entry) => entry.name.includes("preload-profile-bridge"));
    assert.equal(failure?.status, "skipped-optional");
    assert.match(failure?.reason ?? "", /found 0/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("profile menu adds Switch account below Log out and appends runtime once", () => {
  const fixture = "let T;T=l==null?null:(0,u7.jsx)(mI,{LeftIcon:$Kl,onClick:l,children:(0,u7.jsx)(Z,{id:`codex.profileDropdown.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`})});return (0,u7.jsxs)(`div`,{className:`flex w-full min-w-0 flex-col`,children:[v,y,o,b,h,S,i,w,T]})";
  const patched = applyProfileMenuPatch(fixture);
  assert.match(patched, new RegExp(MENU_MARKER));
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, /\(0,u7\.jsx\)\(mI,\{onClick:/);
  assert.match(patched, /children:\(0,u7\.jsx\)\(Z,\{id:`codex\.profileDropdown\.switchAccount`/);
  assert.doesNotMatch(patched, /\(0,l7\.jsx\)\(fI|LeftIcon:KGl/);
  assert.match(patched, /profile\.login/);
  assert.match(patched, /profile\.signedIn===false\?"Signed out"/);
  assert.match(patched, /active · signed out/);
  assert.match(patched, /profile\.removable&&api\.removeLinuxAccountProfile/);
  assert.match(patched, /remove\.textContent="×"/);
  assert.match(patched, /removeLinuxAccountProfile\(\{id:profile\.id\}\)/);
  assert.match(patched, /data-codex-linux-signed-out-switcher/);
  assert.match(patched, /button\.textContent="Switch account"/);
  assert.match(patched, /active\?\.signedIn===false&&state\.profiles\.length>1/);
  assert.match(patched, /setInterval\(codexLinuxSyncSignedOutSwitcher,2000\)/);
  assert.match(patched, /profile\.usagePercent/);
  assert.match(patched, /Usage: /);
  assert.match(patched, /const cachedRequest=api\.getLinuxAccountProfiles\(\),refreshRequest=api\.refreshLinuxAccountProfiles\?\.\(\)/);
  assert.match(patched, /if\(name\.textContent!==nextName\)name\.textContent=nextName/);
  assert.match(patched, /if\(meta\.textContent!==nextMeta\)meta\.textContent=nextMeta/);
  assert.match(patched, /refreshRequest\.then\(\(state\)=>cachedRequest\.then/);
  assert.match(patched, /als-switch/);
  assert.match(patched, /Keep local projects and threads/);
  assert.match(patched, /keepLocalProjectsThreads/);
  assert.match(patched, /shared\.checked=state\.keepLocalProjectsThreads===true/);
  assert.match(patched, /persistSharedState/);
  assert.match(patched, /sharedState\.textContent=shared\.checked\?\"On\":\"Off\"/);
  assert.equal(applyProfileMenuPatch(patched), patched);
  assert.equal(applyProfileMenuPatch("profile menu drift"), "profile menu drift");
});

test("profile menu patch fails closed on duplicate semantic or container anchors", () => {
  const logout = "(0,u7.jsx)(mI,{LeftIcon:$Kl,onClick:l,children:(0,u7.jsx)(Z,{id:`codex.profileDropdown.logOut`,defaultMessage:`Log out`,description:`Menu item to log out of ChatGPT`})})";
  const container = "(0,u7.jsxs)(`div`,{className:`flex w-full min-w-0 flex-col`,children:[v,y,o,b,h,S,i,w,T]})";
  assert.equal(applyProfileMenuPatch(`${logout};${logout};${container}`), `${logout};${logout};${container}`);
  assert.equal(applyProfileMenuPatch(`${logout};${container};${container}`), `${logout};${container};${container}`);
});

test("account handoff quits through the launcher and waits for readiness", () => {
  const fixture = "l.ipcMain.handle(\"codex_linux_account_switcher\",async()=>null);";
  const patched = applyMainBundlePatch(fixture.replace(
    "l.ipcMain.handle",
    "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);l.ipcMain.handle",
  ));
  assert.match(patched, /codexLinuxAccountSwitcherKeepLocalProjectsThreads/);
  assert.match(patched, /if\(action==="list"\)\{\s+const details=registry\.profiles\.map/);
  assert.match(patched, /if\(action==="refresh"\)/);
  assert.match(patched, /codexLinuxAccountSwitcherCachedDetails/);
  assert.match(patched, /const signedIn=codexLinuxAccountSwitcherHasAuth\(profile\)/);
  assert.match(patched, /removable:profile\.id!=="default"&&!signedIn/);
  assert.match(patched, /action==="set-settings"/);
  assert.match(patched, /action==="remove"/);
  assert.match(patched, /The default account profile cannot be removed/);
  assert.match(patched, /Sign out before removing this account profile/);
  assert.match(patched, /Sign in to another account before removing the active profile/);
  assert.match(patched, /codexLinuxAccountSwitcherDeleteProfile\(profile\)/);
  assert.match(patched, /codexLinuxAccountSwitcherRelaunch\(outcome\.relaunch\.target,outcome\.relaunch\.source,outcome\.relaunch\.removeId\)/);
  assert.match(patched, /codexLinuxAccountSwitcherFinalizeRemoval/);
  assert.match(patched, /latest\.profiles=latest\.profiles\.filter\(\(entry\)=>entry\.id!==profile\.id\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWriteHandoff/);
  assert.match(patched, /codexLinuxAccountSwitcherProcessIdentity\(process\.ppid\)/);
  assert.match(patched, /l\.app\.quit\(\)/);
  const relaunchStart = patched.indexOf("function codexLinuxAccountSwitcherRelaunch");
  assert.ok(patched.indexOf("codexLinuxAccountSwitcherWriteHandoff", relaunchStart) < patched.indexOf("codexLinuxAccountSwitcherWriteActive(profile)", relaunchStart));
  assert.match(patched, /const outcome=await codexLinuxAccountSwitcherWithLock[\s\S]*return codexLinuxAccountSwitcherRelaunch\(outcome\.profile/);
  assert.doesNotMatch(patched, /SIGTERM|SIGKILL|codexLinuxAccountSwitcherDescendantPids/);
  assert.match(patched, /l\.app\.quit\(\)/);
});

test("usage refresh returns the percentage persisted on the profile", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-usage-refresh-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const outputPath = path.join(tempDir, "result.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      profiles: [{
        id: "default",
        name: "Current account",
        usagePercent: 37,
        usageUpdatedAt: "2026-08-24T00:00:00.000Z",
      }],
    })}\n`);

    const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let handler=null;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{if(name==="codex_linux_account_switcher")handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{try{const result=await handler({sender:{}},{action:"refresh"});fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify(result));process.exit(0)}catch(error){console.error(error);process.exit(1)}});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const response = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(response.profiles[0].usagePercent, 37);
    assert.equal(response.profiles[0].usageUpdatedAt, "2026-08-24T00:00:00.000Z");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a late usage refresh does not overwrite a newer profile mutation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-refresh-race-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const codexHome = path.join(home, ".codex");
    const outputPath = path.join(tempDir, "result.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      profiles: [{ id: "default", name: "Current account", contextMode: "isolated", contextId: "default" }],
    })}\n`);
    fs.writeFileSync(path.join(codexHome, "auth.json"), `${JSON.stringify({
      tokens: { access_token: "fixture-token", account_id: "fixture-account" },
    })}\n`);

    const fixture = `
const fs=require("node:fs");
const {EventEmitter}=require("node:events");
const https=require("node:https");
https.request=(url,options,callback)=>{const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};request.end=()=>setTimeout(()=>{const response=new EventEmitter();response.statusCode=200;response.setEncoding=()=>{};callback(response);response.emit("data",JSON.stringify({email:"late@example.com",rate_limit:{primary_window:{used_percent:61}}}));response.emit("end")},100);return request};
const V={isTrustedIpcSender:()=>true};
let handler=null;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{if(name==="codex_linux_account_switcher")handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{try{const refresh=handler({sender:{}},{action:"refresh"});await new Promise(resolve=>setTimeout(resolve,20));await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:true});const result=await refresh;fs.writeFileSync(${JSON.stringify(outputPath)},JSON.stringify(result));process.exit(0)}catch(error){console.error(error);process.exit(1)}});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: codexHome },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.equal(registry.keepLocalProjectsThreads, true);
    assert.equal(registry.profiles[0].contextMode, "shared-local");
    assert.equal(registry.profiles[0].usagePercent, undefined);
    assert.equal(registry.profiles[0].email, undefined);
    const response = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(response.profiles[0].contextMode, "shared-local");
    assert.equal(response.profiles[0].usagePercent, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("removing an inactive signed-out profile deletes its exact managed root", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remove-inactive-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const dataHome = path.join(home, ".local", "share");
    const configDir = path.join(configHome, "codex-desktop");
    const profileRoot = path.join(dataHome, "codex-desktop", "account-profiles", "work");
    const resultPath = path.join(tempDir, "result.json");
    fs.mkdirSync(path.join(profileRoot, "electron"), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "sentinel"), "delete me");
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, profiles: [
      { id: "default", name: "Default", contextMode: "isolated", contextId: "default" },
      { id: "work", name: "Work", contextMode: "isolated", contextId: "default" },
    ] })}\n`);
    const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let handler;
const l={app:{whenReady:()=>Promise.resolve(),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setTimeout(async()=>{try{const value=await handler({sender:{},senderFrame:{}},{action:"remove",id:"work"});fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:true,value}));process.exit(0)}catch(error){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({ok:false,error:error.message}));process.exit(1)}},50);
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome, CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE: "default" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.existsSync(profileRoot), false);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.deepEqual(registry.profiles.map((profile) => profile.id), ["default"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a removal completion marker repairs the registry after a crash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remove-recovery-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, previousProfileId: "work", profiles: [
      { id: "default", name: "Default", contextMode: "isolated", contextId: "default" },
      { id: "work", name: "Work", contextMode: "isolated", contextId: "default" },
    ] })}\n`);
    fs.writeFileSync(path.join(configDir, "account-switcher.remove-complete"), "work\n");
    const fixture = `
const V={isTrustedIpcSender:()=>true};
const l={app:{whenReady:()=>Promise.resolve(),once:()=>{}},ipcMain:{handle:()=>{}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setTimeout(()=>process.exit(0),100);
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.deepEqual(registry.profiles.map((profile) => profile.id), ["default"]);
    assert.equal(registry.previousProfileId, undefined);
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.remove-complete")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("logout falls back to the previous authenticated profile through the launcher handoff", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: true,
    fallbackAuth: true,
    removeActiveAuth: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "quit");
  assert.equal(outcome.active, "default\nisolated\ndefault\n");
  assert.match(outcome.handoff ?? "", /from_id=work/);
  assert.match(outcome.handoff ?? "", /target_id=default/);
  assert.equal(outcome.registry.previousProfileId, "work");
  assert.equal(outcome.registry.profiles.find((profile) => profile.id === "work").loginPendingUntil, undefined);
});

test("logout with no authenticated fallback keeps the login screen focused", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: true,
    fallbackAuth: false,
    removeActiveAuth: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "focus");
  assert.equal(outcome.active, "work\nisolated\ndefault\n");
  assert.equal(outcome.handoff, null);
});

test("cold restart repairs a logged-out active profile when another profile is authenticated", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: false,
    fallbackAuth: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "quit");
  assert.equal(outcome.active, "default\nisolated\ndefault\n");
  assert.match(outcome.handoff ?? "", /target_id=default/);
});

test("a newly selected logged-out profile keeps its bounded login window", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: false,
    fallbackAuth: true,
    loginPendingMs: 60_000,
    expectIdle: true,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "idle");
  assert.equal(outcome.active, "work\nisolated\ndefault\n");
  assert.equal(outcome.handoff, null);
});

test("an expired login-pending window falls back without a restart", () => {
  const outcome = runLogoutMonitorScenario({
    activeAuth: false,
    fallbackAuth: true,
    loginPendingMs: 200,
  });
  assert.equal(outcome.result.status, 0, `${outcome.result.stderr}\n${outcome.result.stdout}`);
  assert.equal(outcome.action, "quit");
  assert.equal(outcome.active, "default\nisolated\ndefault\n");
  assert.match(outcome.handoff ?? "", /target_id=default/);
});

test("the first registry mutation creates its parent before acquiring the lock", () => {
  const patched = applyMainBundlePatch("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
  const functionStart = patched.indexOf("function codexLinuxAccountSwitcherWithLock");
  const parentCreate = patched.indexOf("mkdirSync(codexLinuxAccountSwitcherConfigDir", functionStart);
  const lockCreate = patched.indexOf("openSync(lock", functionStart);
  assert.ok(functionStart >= 0);
  assert.ok(parentCreate > functionStart);
  assert.ok(lockCreate > parentCreate);
  assert.match(patched, /spawn\(flock,\["-x","-w","5","\/proc\/self\/fd\/3"/);
});

test("registry mutation uses a crash-releasing advisory lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-stale-registry-lock-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const lock = path.join(configDir, "account-switcher.json.lock");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(lock, "99999999", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({ version: 1, profiles: [{ id: "default", contextMode: "isolated", contextId: "default" }] })}\n`);
    const fixture = `
const V={isTrustedIpcSender:()=>true};let handler;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:true});process.exit(0)});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fs.readFileSync(lock, "utf8"), "99999999");
    assert.match(applyMainBundlePatch("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);"), /codexLinuxAccountSwitcherResolveExecutable\("flock"\)/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared mode uses a generated context and never includes credential-bearing state", () => {
  const fixture = "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);";
  const patched = applyMainBundlePatch(fixture);
  assert.match(patched, /registry\.sharedContextId=\"shared-\"\+Date\.now\(\)\.toString\(36\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWriteActive\(outcome\.active\)/);
  assert.match(patched, /codexLinuxAccountSwitcherWithLock/);
  assert.doesNotMatch(patched, /shell_snapshots|session_index|codex-global-state/);
});

test("first-run shared settings seed and route the default profile under the registry lock", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-first-settings-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const fixture = `
const V={isTrustedIpcSender:()=>true};let handler;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:true});process.exit(0)});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.equal(registry.profiles.length, 1);
    assert.equal(registry.profiles[0].id, "default");
    assert.equal(registry.profiles[0].contextMode, "shared-local");
    assert.equal(registry.profiles[0].contextId, registry.sharedContextId);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), `default\nshared-local\n${registry.sharedContextId}\n`);
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /^from_mode=isolated$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("synchronous quit observes the durable registry after the mutation lock is released", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-durable-before-quit-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const registryPath = path.join(configDir, "account-switcher.json");
    const outputPath = path.join(tempDir, "quit-observation.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({
      version: 1,
      profiles: [
        { id: "default", contextMode: "isolated", contextId: "default" },
        { id: "work", contextMode: "isolated", contextId: "default" },
      ],
    }));
    const fixture = `
const fs=require("node:fs"),cp=require("node:child_process");
const V={isTrustedIpcSender:()=>true};let handler;
const registryPath=${JSON.stringify(registryPath)},outputPath=${JSON.stringify(outputPath)};
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{const registry=JSON.parse(fs.readFileSync(registryPath,"utf8"));const lockAvailable=cp.spawnSync("flock",["-n",registryPath+".lock","true"]).status===0;fs.writeFileSync(outputPath,JSON.stringify({registry,lockAvailable,handoff:fs.existsSync(${JSON.stringify(path.join(configDir, "account-switcher.handoff"))})}));process.exit(0)}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(()=>handler({sender:{}},{action:"switch",id:"work"}).catch((error)=>{console.error(error);process.exit(1)}));
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const observed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(observed.registry.previousProfileId, "default");
    assert.equal(typeof observed.registry.profiles.find((profile) => profile.id === "work").loginPendingUntil, "string");
    assert.equal(observed.lockAvailable, true);
    assert.equal(observed.handoff, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("disabling shared mode relaunches with the retained context as detachment input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-disable-shared-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      keepLocalProjectsThreads: true,
      sharedContextId: "shared-old",
      profiles: [{ id: "default", name: "Default", contextMode: "shared-local", contextId: "shared-old" }],
    })}\n`);
    const fixture = `
const V={isTrustedIpcSender:()=>true};let handler;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:false});process.exit(0)});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const handoff = fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8");
    assert.match(handoff, /^from_mode=shared-local$/m);
    assert.match(handoff, /^from_context=shared-old$/m);
    assert.match(handoff, /^target_mode=isolated$/m);
    assert.match(handoff, /^target_context=default$/m);
    assert.match(handoff, /^target_previous_context=shared-old$/m);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("disabling and re-enabling shared mode retains its managed context until detachment", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-context-toggle-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const outputPath = path.join(tempDir, "result.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      keepLocalProjectsThreads: true,
      sharedContextId: "shared-old",
      profiles: [{ id: "default", name: "Default", contextMode: "shared-local", contextId: "shared-old" }],
    })}\n`);
    const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};
let handler=null;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{if(name==="codex_linux_account_switcher")handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:false});await handler({sender:{}},{action:"set-settings",keepLocalProjectsThreads:true});fs.writeFileSync(${JSON.stringify(outputPath)},fs.readFileSync(${JSON.stringify(path.join(configDir, "account-switcher.json"))},"utf8"));process.exit(0)});
`;
    const result = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const registry = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(registry.sharedContextId, "shared-old");
    assert.equal(registry.profiles[0].contextMode, "shared-local");
    assert.equal(registry.profiles[0].contextId, "shared-old");
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nshared-local\nshared-old\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("profile identity lookup keeps the base account home stable after relaunch", () => {
  const fixture = "const child_process=require(\"node:child_process\");l.ipcMain.handle(\"codex_linux_account_switcher\",async()=>null);";
  const patched = applyMainBundlePatch(fixture.replace(
    "l.ipcMain.handle",
    "be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);l.ipcMain.handle",
  ));
  assert.match(patched, /CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME/);
  assert.match(patched, /profile\.id===\"default\"\?codexLinuxAccountSwitcherBaseCodexHome/);
  assert.doesNotMatch(patched, /delete environment\.CODEX_HOME/);
});

test("launcher routes the active named profile", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-launcher-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const script = path.join(__dirname, "launcher-hook.sh");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], {
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "env CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD=1",
      `env CODEX_LINUX_ACCOUNT_SWITCHER_BASE_CODEX_HOME=${path.join(home, ".codex")}`,
      `env CODEX_HOME=${path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work", "codex")}`,
      `env CODEX_ELECTRON_USER_DATA_PATH=${path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work", "electron")}`,
      "env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=work",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=shared-local",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=team",
      `electron-arg --user-data-dir=${path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work", "electron")}`,
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher rejects a caller user-data override for a managed profile", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-user-data-override-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh"), "--user-data-dir=/tmp/unmanaged"], {
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing caller-supplied --user-data-dir/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("default profile rejects a caller user-data override", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-default-user-data-override-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh"), "--user-data-dir", "/tmp/unmanaged"], {
      env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing caller-supplied --user-data-dir for profile default/);
    assert.equal(result.stdout, "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("JS and shell reject profile IDs outside the path-contained contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-profile-id-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    for (const id of ["../escape", ".", ".."]) {
      fs.writeFileSync(path.join(configDir, "account-switcher.active"), `${id}\nisolated\ndefault\n`, { mode: 0o600 });
      const shellResult = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], {
        env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
        encoding: "utf8",
      });
      assert.equal(shellResult.status, 1, `shell accepted ${id}`);
      assert.match(shellResult.stderr, /refusing invalid profile id/);
    }

    const patched = applyMainBundlePatch("be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);");
    assert.match(patched, /const codexLinuxAccountSwitcherIdPattern=\/\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$\//);
    assert.match(patched, /value!=="\."&&value!=="\.\."&&codexLinuxAccountSwitcherIdPattern\.test\(value\)/);
    const resultPath = path.join(tempDir, "js-id-results.json");
    const fixture = `
const fs=require("node:fs");
const V={isTrustedIpcSender:()=>true};let handler;
const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{},quit:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};
let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);
setImmediate(async()=>{const rejected=[];for(const id of [".",".."])try{await handler({sender:{},senderFrame:{}},{action:"create",id,name:id});rejected.push(false)}catch{rejected.push(true)}const valid=await handler({sender:{},senderFrame:{}},{action:"create",id:"work",name:"Work"});fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({rejected,valid:valid.profile.id}));process.exit(0)});
`;
    const jsResult = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(jsResult.status, 0, `${jsResult.stderr}\n${jsResult.stdout}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(resultPath, "utf8")), { rejected: [true, true], valid: "work" });
    const sharedState = fs.readFileSync(path.join(__dirname, "shared-state.sh"), "utf8");
    assert.match(sharedState, /ACCOUNT_SWITCHER_ID_RE='\^\[a-z0-9\]\[a-z0-9\._-\]\{0,63\}\$'/);
    assert.match(sharedState, /"\$\{1:-\}" != \. && "\$\{1:-\}" != \.\./);
    const launcher = fs.readFileSync(path.join(__dirname, "launcher-hook.sh"), "utf8");
    assert.match(launcher, /account_switcher_validate_id "\$profile_id"/);
    assert.doesNotMatch(launcher, /\[a-z0-9\]\[a-z0-9\._-\]/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher removes stale Chromium singleton links despite an unrelated reused PID", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-singletons-"));
  try {
    const home = path.join(tempDir, "home");
    const configDir = path.join(home, ".config", "codex-desktop");
    const dataHome = path.join(home, ".local", "share");
    const profileDir = path.join(dataHome, "codex-desktop", "account-profiles", "work", "electron");
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      fs.symlinkSync(name === "SingletonLock" ? "retired-container-999999" : path.join(tempDir, `missing-${name}`), path.join(profileDir, name));
    }
    const script = path.join(__dirname, "launcher-hook.sh");
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome };
    const staleResult = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(staleResult.status, 0, staleResult.stderr);
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      assert.throws(() => fs.lstatSync(path.join(profileDir, name)), { code: "ENOENT" });
    }

    fs.symlinkSync(`${os.hostname()}-${process.pid}`, path.join(profileDir, "SingletonLock"));
    fs.symlinkSync(path.join(tempDir, "missing-live-socket"), path.join(profileDir, "SingletonSocket"));
    const liveResult = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(liveResult.status, 0, liveResult.stderr);
    assert.equal(fs.existsSync(path.join(profileDir, "SingletonLock")), false);
    assert.equal(fs.existsSync(path.join(profileDir, "SingletonSocket")), false);
    const staleSocket = path.join(tempDir, "stale-singleton.sock");
    const socketResult = spawnSync("python3", ["-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()", staleSocket], { encoding: "utf8" });
    assert.equal(socketResult.status, 0, socketResult.stderr);
    fs.symlinkSync("retired-container-999999", path.join(profileDir, "SingletonLock"));
    fs.symlinkSync(staleSocket, path.join(profileDir, "SingletonSocket"));
    fs.symlinkSync(path.join(tempDir, "stale-cookie"), path.join(profileDir, "SingletonCookie"));
    const staleSocketResult = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(staleSocketResult.status, 0, staleSocketResult.stderr);
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      assert.throws(() => fs.lstatSync(path.join(profileDir, name)), { code: "ENOENT" });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher recovers the real upstream default Electron profile after a cold restart", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-default-singletons-"));
  try {
    const home = path.join(tempDir, "home");
    const configHome = path.join(home, ".config");
    const profileDir = path.join(configHome, "Codex");
    fs.mkdirSync(profileDir, { recursive: true });
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      fs.symlinkSync(name === "SingletonLock" ? "retired-container-999999" : path.join(tempDir, `missing-default-${name}`), path.join(profileDir, name));
    }

    const script = path.join(__dirname, "launcher-hook.sh");
    const env = { HOME: home, XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: path.join(home, ".local", "share") };
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(script)}`], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, [
      "unset-env CODEX_ELECTRON_USER_DATA_PATH",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD=1",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=default",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=isolated",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=default",
      "",
    ].join("\n"));
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      assert.throws(() => fs.lstatSync(path.join(profileDir, name)), { code: "ENOENT" });
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prelaunch ignores inherited routing that is not owned by a live handoff", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-selected-source-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const targetJournal = path.join(targetHome, "sqlite", "codex.db-journal");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetJournal), { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(path.join(targetHome, "sqlite", "codex.db"), "target catalog");
    fs.writeFileSync(targetJournal, "target hot journal");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: dataHome,
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_LINUX_APP_DIR: appDir,
        CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE: "default",
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT: "isolated",
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID: "default",
      },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing migration while a SQLite rollback journal exists/);
    assert.equal(fs.readFileSync(targetJournal, "utf8"), "target hot journal");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prelaunch routes a concurrent requested handoff to its authenticated source", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-prelaunch-live-source-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const targetJournal = path.join(targetHome, "sqlite", "codex.db-journal");
    const owner = processIdentity();
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetJournal), { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), [
      "version=1", "phase=requested", `owner_pid=${owner.pid}`, `owner_start=${owner.start}`, `owner_boot=${owner.boot}`,
      "from_id=default", "from_mode=isolated", "from_context=default",
      "target_id=work", "target_mode=shared-local", "target_context=team",
    ].join("\n") + "\n", { mode: 0o600 });
    fs.writeFileSync(path.join(targetHome, "sqlite", "codex.db"), "target catalog");
    fs.writeFileSync(targetJournal, "target hot journal");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(targetJournal, "utf8"), "target hot journal");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("prelaunch ignores an inherited prepared flag without live handoff ownership", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-stale-prepared-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const profileHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const journal = path.join(profileHome, "sqlite", "codex.db-journal");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(path.join(profileHome, "sqlite", "codex.db"), "catalog");
    fs.writeFileSync(journal, "hot journal");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_LINUX_APP_DIR: appDir, CODEX_LINUX_ACCOUNT_SWITCHER_MIGRATION_PREPARED: "1" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing migration while a SQLite rollback journal exists/);
    assert.equal(fs.readFileSync(journal, "utf8"), "hot journal");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared prelaunch promotes the newer isolated catalog before relinking", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-shared-hook-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const profileHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    const target = path.join(profileHome, "sqlite", "codex.db");
    const sharedWal = `${shared}-wal`;
    const targetWal = `${target}-wal`;
    const sharedDev = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex-dev.db");
    const targetDev = path.join(profileHome, "sqlite", "codex-dev.db");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.join(home, ".config", "codex-desktop"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "codex-desktop", "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(target, "profile catalog");
    fs.writeFileSync(shared, "shared catalog");
    fs.writeFileSync(sharedWal, "stale shared wal");
    fs.writeFileSync(targetDev, "profile dev catalog");
    fs.writeFileSync(sharedDev, "shared dev catalog");
    fs.writeFileSync(path.join(profileHome, ".codex-global-state.json"), JSON.stringify({ unrelated: "profile project state" }));
    fs.mkdirSync(path.join(profileHome, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(profileHome, "sessions", "rollout.jsonl"), "profile rollout");
    fs.writeFileSync(path.join(profileHome, "session_index.jsonl"), "profile session index");
    const sharedRoot = path.dirname(shared);
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sharedRoot, "sessions", "existing-rollout.jsonl"), "existing shared rollout");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "existing shared session index\n");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: {
        HOME: home,
        XDG_DATA_HOME: dataHome,
        CODEX_HOME: profileHome,
        CODEX_LINUX_APP_DIR: appDir,
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT: "shared-local",
        CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID: "team",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readlinkSync(target), shared);
    assert.equal(fs.existsSync(`${target}.isolated-backup`), false);
    assert.equal(fs.readFileSync(shared, "utf8"), "profile catalog");
    assert.equal(fs.existsSync(sharedWal), false);
    assert.equal(fs.existsSync(targetWal), false);
    assert.equal(fs.readlinkSync(targetDev), sharedDev);
    assert.equal(fs.existsSync(`${targetDev}.isolated-backup`), false);
    assert.equal(fs.readFileSync(sharedDev, "utf8"), "profile dev catalog");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profileHome, ".codex-global-state.json"), "utf8")), { unrelated: "profile project state", "electron-persisted-atom-state": {} });
    assert.equal(fs.lstatSync(path.join(profileHome, "sessions")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(sharedRoot, "sessions", "rollout.jsonl"), "utf8"), "profile rollout");
    assert.equal(fs.readFileSync(path.join(sharedRoot, "sessions", "existing-rollout.jsonl"), "utf8"), "existing shared rollout");
    assert.equal(fs.statSync(path.join(profileHome, "sessions", "rollout.jsonl")).ino, fs.statSync(path.join(sharedRoot, "sessions", "rollout.jsonl")).ino);
    assert.equal(fs.lstatSync(path.join(profileHome, "session_index.jsonl")).isSymbolicLink(), false);
    assert.equal(fs.statSync(path.join(profileHome, "session_index.jsonl")).ino, fs.statSync(path.join(sharedRoot, "session_index.jsonl")).ino);
    assert.match(fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8"), /existing shared session index/);
    assert.match(fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8"), /profile session index/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rejoining-catalog promotion rolls back to both offline copies", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-catalog-promotion-rollback-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const codexHome = path.join(home, ".codex");
    const target = path.join(codexHome, "sqlite", "codex.db");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const shared = path.join(sharedRoot, "codex.db");
    const sharedWal = `${shared}-wal`;
    const targetWal = `${target}-wal`;
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.writeFileSync(target, "new isolated catalog");
    fs.writeFileSync(shared, "older retained catalog");
    fs.writeFileSync(sharedWal, "older retained wal");
    const prepared = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_prepare_shared ${JSON.stringify(codexHome)} ${JSON.stringify(codexHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const journal = prepared.stdout.trim();
    assert.equal(fs.readlinkSync(target), shared);
    assert.equal(fs.readFileSync(shared, "utf8"), "new isolated catalog");
    assert.equal(fs.existsSync(sharedWal), false);
    assert.equal(fs.existsSync(targetWal), false);
    const rolledBack = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_rollback_prepared team ${JSON.stringify(journal)}`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "new isolated catalog");
    assert.equal(fs.readFileSync(shared, "utf8"), "older retained catalog");
    assert.equal(fs.readFileSync(sharedWal, "utf8"), "older retained wal");
    assert.equal(fs.existsSync(targetWal), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launch guard serializes simultaneous cold prelaunch migrations until Electron appears", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-cold-launch-guard-"));
  let appProcess;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const configHome = path.join(home, ".config");
    const configDir = path.join(configHome, "codex-desktop");
    const appDir = path.join(tempDir, "app");
    const codexHome = path.join(home, ".codex");
    const database = path.join(codexHome, "sqlite", "codex.db");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(database, "catalog");
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
      CODEX_HOME: codexHome,
      CODEX_LINUX_APP_DIR: appDir,
      CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD: "1",
    };
    const runHook = () => spawn("bash", [path.join(__dirname, "prelaunch-hook.sh")], { env });
    const waitChild = (child) => new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (status) => resolve({ status, stderr }));
    });
    const first = await waitChild(runHook());
    assert.equal(first.status, 0, first.stderr);
    const secondChild = runHook();
    let secondClosed = false;
    const secondPromise = waitChild(secondChild).then((result) => { secondClosed = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(secondClosed, false, "second cold launch must wait for the first Electron startup");
    const appPath = path.join(appDir, "ChatGPT");
    appProcess = spawn("bash", ["-c", `exec -a ${JSON.stringify(appPath)} sleep 5`]);
    const second = await secondPromise;
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readlinkSync(database), path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db"));
  } finally {
    appProcess?.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared mode carries local project metadata without copying account-scoped state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-local-state-"));
  try {
    const source = path.join(tempDir, "source", ".codex-global-state.json");
    const target = path.join(tempDir, "target", ".codex-global-state.json");
    const shared = path.join(tempDir, "shared", "local-project-state.json");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, JSON.stringify({
      "local-projects": { project: { id: "project", name: "Shared project", rootPaths: ["/tmp/shared-project"] } },
      "project-order": ["project"],
      "thread-project-assignments": { thread: { projectKind: "local", projectId: "project" } },
      "electron-persisted-atom-state": {
        "thread-reference-capability:thread": true,
        "thread-client-id-v1:local%3Athread": "client-thread",
        "thread-descriptions-v1": { thread: "Shared thread" },
        "heartbeat-thread-permissions-by-id": { thread: "account-one-only" },
      },
      "account-scoped-value": "must-not-copy",
    }));
    fs.writeFileSync(target, JSON.stringify({
      unrelated: "account-two",
      "electron-persisted-atom-state": {
        "heartbeat-thread-permissions-by-id": { own: "account-two-only" },
      },
    }));
    const helper = path.join(__dirname, "shared-state-json.js");
    const result = spawnSync(process.execPath, [helper, "prepare", source, target, shared], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const merged = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.equal(merged.unrelated, "account-two");
    assert.deepEqual(merged["local-projects"], { project: { id: "project", name: "Shared project", rootPaths: ["/tmp/shared-project"] } });
    assert.deepEqual(merged["thread-project-assignments"], { thread: { projectKind: "local", projectId: "project" } });
    assert.equal(merged["electron-persisted-atom-state"]["thread-reference-capability:thread"], true);
    assert.equal(merged["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"].own, "account-two-only");
    assert.equal(merged["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"].thread, undefined);
    const sharedState = JSON.parse(fs.readFileSync(shared, "utf8"));
    assert.equal(sharedState["account-scoped-value"], undefined);
    assert.equal(sharedState.atom["heartbeat-thread-permissions-by-id"], undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a profile without global state preserves existing shared project metadata", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-missing-local-state-"));
  try {
    const source = path.join(tempDir, "new-profile", ".codex-global-state.json");
    const target = path.join(tempDir, "target", ".codex-global-state.json");
    const shared = path.join(tempDir, "shared", "local-project-state.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ unrelated: "keep" }));
    fs.writeFileSync(shared, JSON.stringify({
      version: 1,
      "local-projects": { existing: { id: "existing" } },
      atom: { "thread-descriptions-v1": { thread: "Existing thread" } },
    }));
    const result = spawnSync(process.execPath, [path.join(__dirname, "shared-state-json.js"), "prepare", source, target, shared], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const sharedState = JSON.parse(fs.readFileSync(shared, "utf8"));
    const targetState = JSON.parse(fs.readFileSync(target, "utf8"));
    assert.deepEqual(sharedState["local-projects"], { existing: { id: "existing" } });
    assert.deepEqual(sharedState.atom["thread-descriptions-v1"], { thread: "Existing thread" });
    assert.deepEqual(targetState["local-projects"], { existing: { id: "existing" } });
    assert.deepEqual(targetState["electron-persisted-atom-state"]["thread-descriptions-v1"], { thread: "Existing thread" });
    assert.equal(targetState.unrelated, "keep");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared migration keeps SQLite sidecars with a real database family", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-sqlite-family-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const sourceDb = path.join(sourceHome, "sqlite", "codex.db");
    const targetDb = path.join(targetHome, "sqlite", "codex.db");
    const sharedDb = path.join(sharedRoot, "codex.db");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(path.dirname(sourceDb), { recursive: true });
    fs.mkdirSync(path.dirname(targetDb), { recursive: true });
    fs.mkdirSync(sharedRoot, { recursive: true });
    // This orphaned source WAL must never be adopted by the shared family.
    fs.writeFileSync(`${sourceDb}-wal`, "orphaned source wal");
    fs.writeFileSync(targetDb, "target database");
    fs.writeFileSync(`${targetDb}-wal`, "target wal");
    fs.writeFileSync(`${targetDb}-shm`, "target shm");
    fs.writeFileSync(`${targetDb}-wal.isolated-backup`, "older target wal backup");
    fs.writeFileSync(sharedDb, "existing shared database");
    fs.writeFileSync(`${sharedDb}-wal`, "existing shared wal");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_migrate_shared ${JSON.stringify(sourceHome)} ${JSON.stringify(targetHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(sharedDb, "utf8"), "existing shared database");
    assert.equal(fs.readFileSync(`${sharedDb}-wal`, "utf8"), "existing shared wal");
    assert.equal(fs.readFileSync(`${sourceDb}-wal`, "utf8"), "orphaned source wal");
    assert.equal(fs.readFileSync(`${targetDb}.isolated-backup`, "utf8"), "target database");
    assert.equal(fs.readFileSync(`${targetDb}-wal.isolated-backup`, "utf8"), "target wal");
    assert.equal(fs.readFileSync(`${targetDb}-shm.isolated-backup`, "utf8"), "target shm");
    assert.equal(fs.existsSync(`${sharedDb}-shm`), false);
    const preservedWal = fs.readdirSync(path.dirname(targetDb)).find((name) => name.startsWith("codex.db-wal.isolated-backup.preserved."));
    assert.equal(fs.readFileSync(path.join(path.dirname(targetDb), preservedWal), "utf8"), "older target wal backup");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("target-only SQLite rows merge into an existing shared catalog", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-sqlite-merge-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const targetDb = path.join(targetHome, "sqlite", "codex.db");
    const sharedDb = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    fs.mkdirSync(path.dirname(targetDb), { recursive: true });
    fs.mkdirSync(path.dirname(sharedDb), { recursive: true });
    for (const [file, id] of [[targetDb, "target-only"], [sharedDb, "shared-only"]]) {
      const db = new DatabaseSync(file);
      db.exec("create table projects(id text primary key, title text)");
      db.prepare("insert into projects values (?, ?)").run(id, id);
      db.close();
    }
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(path.join(__dirname, "shared-state.sh"))}; account_switcher_migrate_shared ${JSON.stringify(sourceHome)} ${JSON.stringify(targetHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const merged = new DatabaseSync(sharedDb, { readOnly: true });
    assert.deepEqual(merged.prepare("select id from projects order by id").all().map((row) => row.id), ["shared-only", "target-only"]);
    merged.close();
    assert.equal(fs.lstatSync(targetDb).isSymbolicLink(), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a source database without WAL does not inherit target WAL or lose its backup", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-sqlite-no-wal-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const sourceDb = path.join(sourceHome, "sqlite", "codex.db");
    const targetDb = path.join(targetHome, "sqlite", "codex.db");
    const sharedDb = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    const sharedWal = `${sharedDb}-wal`;
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(path.dirname(sourceDb), { recursive: true });
    fs.mkdirSync(path.dirname(targetDb), { recursive: true });
    fs.writeFileSync(sourceDb, "source database rows");
    fs.writeFileSync(targetDb, "target database rows");
    fs.writeFileSync(`${targetDb}-wal`, "target-only WAL");
    fs.mkdirSync(path.dirname(sharedDb), { recursive: true });
    fs.writeFileSync(sharedDb, "previous shared database");
    fs.writeFileSync(sharedWal, "previous shared WAL");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_migrate_shared ${JSON.stringify(sourceHome)} ${JSON.stringify(targetHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(sharedDb, "utf8"), "source database rows");
    assert.equal(fs.existsSync(`${sharedDb}-wal`), false);
    assert.equal(fs.readFileSync(`${targetDb}-wal.isolated-backup`, "utf8"), "target-only WAL");
    assert.equal(fs.readFileSync(`${targetDb}.isolated-backup`, "utf8"), "target database rows");
    const preserved = fs.readdirSync(path.dirname(sharedDb)).filter((name) => name.startsWith(".account-switcher-preserved-"));
    assert.equal(preserved.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(sharedDb), preserved[0], "codex.db"), "utf8"), "previous shared database");
    assert.equal(fs.readFileSync(path.join(path.dirname(sharedDb), preserved[0], "codex.db-wal"), "utf8"), "previous shared WAL");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("committed shared migration preserves sparse metadata and divergent rollout files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-shared-preservation-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const sourceState = path.join(sourceHome, ".codex-global-state.json");
    const targetState = path.join(targetHome, ".codex-global-state.json");
    const sharedState = path.join(sharedRoot, "local-project-state.json");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(path.dirname(sourceState), { recursive: true });
    fs.mkdirSync(path.dirname(targetState), { recursive: true });
    fs.mkdirSync(path.join(sourceHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(sourceState, JSON.stringify({ "local-projects": { source: { id: "source" } }, "project-order": ["source"], "electron-persisted-atom-state": { "thread-descriptions-v1": { sourceThread: "source" } } }));
    fs.writeFileSync(targetState, JSON.stringify({ "local-projects": { target: { id: "target" } }, "project-order": ["target"], "electron-persisted-atom-state": { "thread-descriptions-v1": { targetThread: "target" } } }));
    fs.writeFileSync(sharedState, JSON.stringify({ version: 1, "local-projects": { existing: { id: "existing" } }, "project-order": ["existing"], atom: { "thread-descriptions-v1": { existingThread: "existing" } } }));
    fs.writeFileSync(path.join(sourceHome, "sessions", "divergent.jsonl"), "source continuation");
    fs.writeFileSync(path.join(sharedRoot, "sessions", "divergent.jsonl"), "existing continuation");
    fs.writeFileSync(path.join(sharedRoot, "sessions", "shared-only.jsonl"), "shared-only continuation");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_migrate_shared ${JSON.stringify(sourceHome)} ${JSON.stringify(targetHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const shared = JSON.parse(fs.readFileSync(sharedState, "utf8"));
    const target = JSON.parse(fs.readFileSync(targetState, "utf8"));
    assert.deepEqual(shared["local-projects"], { existing: { id: "existing" }, source: { id: "source" } });
    assert.deepEqual(shared["project-order"], ["existing", "source"]);
    assert.deepEqual(shared.atom["thread-descriptions-v1"], { existingThread: "existing", sourceThread: "source" });
    assert.deepEqual(target["local-projects"], { target: { id: "target" }, existing: { id: "existing" }, source: { id: "source" } });
    assert.deepEqual(target["project-order"], ["target", "existing", "source"]);
    assert.equal(fs.readFileSync(path.join(sharedRoot, "sessions", "divergent.jsonl"), "utf8"), "existing continuation");
    assert.equal(fs.readFileSync(path.join(sourceHome, "sessions", "divergent.jsonl"), "utf8"), "source continuation");
    assert.equal(fs.readFileSync(path.join(targetHome, "sessions", "shared-only.jsonl"), "utf8"), "shared-only continuation");
    assert.equal(fs.readdirSync(sharedRoot).some((name) => name.startsWith(".account-switcher-migration-")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("after-exit handoff uses the launcher readiness protocol and rolls back failures", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    const launcher = path.join(appDir, "start.sh");
    const unrelatedAppImage = path.join(tempDir, "unrelated.AppImage");
    fs.writeFileSync(launcher, "#!/bin/sh\nprintf '%s' \"$CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE\" > \"$HOME/started-profile\"\nprintf '%s' \"$#\" > \"$HOME/started-arg-count\"\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    fs.writeFileSync(unrelatedAppImage, "#!/bin/sh\nprintf launched > \"$HOME/unrelated-launched\"\n", { mode: 0o755 });
    const hook = path.join(__dirname, "after-exit-hook.sh");
    const handoff = directFinalExitHandoff(["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=isolated", "target_context=default", "nonce=test"].join("\n") + "\n");
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir, APPIMAGE: unrelatedAppImage };
    const success = spawnSync("bash", [hook, "codex://thread/from-original-launch", "--new-window"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(success.status, 0, `${success.stderr}\n${success.stdout}`);
    assert.equal(fs.readFileSync(path.join(home, "started-profile"), "utf8"), "work");
    assert.equal(fs.readFileSync(path.join(home, "started-arg-count"), "utf8"), "0");
    assert.equal(fs.existsSync(path.join(home, "unrelated-launched")), false);
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);

    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const failed = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /phase=failed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an unready live default replacement retains ownership and blocks WAL rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-live-default-failure-"));
  let ownerPid;
  let activeDb;
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const fakeBin = path.join(tempDir, "bin");
    const configDir = path.join(home, ".config", "codex-desktop");
    const database = path.join(home, ".codex", "state_5.sqlite");
    const holder = path.join(tempDir, "holder.js");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(database), { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.001\n", { mode: 0o755 });
    activeDb = new DatabaseSync(database);
    activeDb.exec("pragma journal_mode=WAL;create table if not exists held(value text);begin immediate;insert into held values ('live')");
    assert.equal(fs.existsSync(`${database}-wal`), true);
    fs.writeFileSync(holder, "setInterval(()=>{},1000);\n");
    fs.writeFileSync(path.join(appDir, "start.sh"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(holder)} >/dev/null 2>&1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), directFinalExitHandoff([
      "version=1", "phase=requested", "from_id=work", "from_mode=isolated", "from_context=default",
      "target_id=default", "target_mode=isolated", "target_context=default", "target_previous_mode=isolated",
      "target_previous_context=default", "nonce=test",
    ].join("\n") + "\n"), { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_LINUX_APP_DIR: appDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
    };
    const failed = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1, `${failed.stderr}\n${failed.stdout}`);
    assert.match(failed.stderr, /deferred catalog rollback until it exits/);
    const pending = fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8");
    assert.match(pending, /^phase=failed$/m);
    ownerPid = Number(pending.match(/^owner_pid=([0-9]+)$/m)?.[1]);
    assert.equal(Number.isInteger(ownerPid) && ownerPid > 1, true);
    process.kill(ownerPid, 0);

    const cold = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], { env, encoding: "utf8" });
    assert.notEqual(cold.status, 0);
    assert.match(cold.stderr, /account handoff is still active under pid/);
    assert.equal(fs.existsSync(`${database}-wal`), true);
  } finally {
    if (activeDb) {
      try { activeDb.exec("rollback"); } catch {}
      try { activeDb.close(); } catch {}
    }
    if (ownerPid) {
      try { process.kill(ownerPid); } catch {}
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a post-readiness commit failure preserves intent for cold-start recovery", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-commit-recovery-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    stageSharedStateHelper(appDir);
    fs.appendFileSync(
      path.join(appDir, ".codex-linux", "features", "account-switcher", "shared-state.sh"),
      "\naccount_switcher_commit_prepared() { return 1; }\n",
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(sourceHome, "sqlite"), { recursive: true });
    fs.mkdirSync(path.join(targetHome, "sqlite"), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, "sqlite", "codex.db"), "source catalog");
    fs.writeFileSync(path.join(targetHome, "sqlite", "codex.db"), "target catalog");
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/bash\nprintf '%s\\n' \"$$\" > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\nsleep 0.2\n", { mode: 0o755 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), directFinalExitHandoff([
      "version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default",
      "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated",
      "target_previous_context=default", "nonce=test",
    ].join("\n") + "\n"), { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const env = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: dataHome,
      CODEX_HOME: sourceHome,
      CODEX_LINUX_APP_DIR: appDir,
    };
    const failed = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /preserved commit-pending recovery metadata/);
    const pending = fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8");
    assert.match(pending, /^phase=commit-pending$/m);
    assert.match(pending, /^migration_count=1$/m);
    const journalName = pending.match(/^migration_0_journal=(.+)$/m)?.[1];
    assert.ok(journalName);
    const journal = path.join(dataHome, "codex-desktop", "account-contexts", "team", journalName);
    assert.equal(fs.statSync(journal).isDirectory(), true);

    stageSharedStateHelper(appDir);
    const recovered = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, /env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=work/);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "work\nshared-local\nteam\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared handoff merges source and target rollout files into an existing context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-session-merge-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(sourceHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(targetHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sourceHome, "sessions", "source-rollout.jsonl"), "source rollout");
    fs.writeFileSync(path.join(targetHome, "sessions", "target-rollout.jsonl"), "target rollout");
    fs.writeFileSync(path.join(sharedRoot, "sessions", "existing-rollout.jsonl"), "existing rollout");
    fs.writeFileSync(path.join(sourceHome, "session_index.jsonl"), "source index\n");
    fs.writeFileSync(path.join(targetHome, "session_index.jsonl"), "target index\n");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "existing index\n");
    fs.writeFileSync(path.join(sourceHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": { shared: true }, "source-account-only": true }));
    fs.writeFileSync(path.join(targetHome, ".codex-global-state.json"), JSON.stringify({ unrelated: "preserve-target", "electron-persisted-atom-state": { "target-account-only": true } }));
    const staleSharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "old-team");
    const stateDb = new DatabaseSync(path.join(targetHome, "state_5.sqlite"));
    stateDb.exec("create table threads (id text primary key, rollout_path text not null)");
    stateDb.exec("create table backfill_state (id integer primary key, status text not null)");
    stateDb.prepare("insert into backfill_state (id, status) values (?, ?)").run(1, "complete");
    stateDb.prepare("insert into threads (id, rollout_path) values (?, ?)").run("thread-path", `${sharedRoot}/sessions/source-rollout.jsonl`);
    stateDb.prepare("insert into threads (id, rollout_path) values (?, ?)").run("stale-thread-path", `${staleSharedRoot}/sessions/stale-rollout.jsonl`);
    stateDb.close();
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/sh\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), directFinalExitHandoff([
      "version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default",
      "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated",
      "target_previous_context=default", "nonce=test",
    ].join("\n") + "\n"), { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: sourceHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    for (const name of ["source-rollout.jsonl", "target-rollout.jsonl", "existing-rollout.jsonl"]) {
      assert.equal(fs.existsSync(path.join(sharedRoot, "sessions", name)), true);
    }
    const index = fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8");
    for (const line of ["source index", "target index", "existing index"]) assert.match(index, new RegExp(line));
    assert.equal(fs.lstatSync(path.join(sourceHome, "sessions")).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(targetHome, "sessions")).isSymbolicLink(), false);
    assert.equal(fs.statSync(path.join(targetHome, "sessions", "source-rollout.jsonl")).ino, fs.statSync(path.join(sharedRoot, "sessions", "source-rollout.jsonl")).ino);
    const rewrittenDb = new DatabaseSync(path.join(targetHome, "state_5.sqlite"));
    assert.equal(rewrittenDb.prepare("select rollout_path from threads where id = ?").get("thread-path").rollout_path, `${targetHome}/sessions/source-rollout.jsonl`);
    assert.equal(rewrittenDb.prepare("select rollout_path from threads where id = ?").get("stale-thread-path").rollout_path, `${targetHome}/sessions/stale-rollout.jsonl`);
    assert.equal(rewrittenDb.prepare("select id from backfill_state where id = 1").get(), undefined);
    rewrittenDb.close();
    const targetGlobal = JSON.parse(fs.readFileSync(path.join(targetHome, ".codex-global-state.json"), "utf8"));
    assert.equal(targetGlobal.unrelated, "preserve-target");
    assert.equal(targetGlobal["electron-persisted-atom-state"]["target-account-only"], true);
    assert.deepEqual(targetGlobal["local-projects"], { shared: true });
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed migration restores the source selection and records the failed handoff", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-migration-failure-"));
  let fd;
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const wal = path.join(home, ".codex", "sqlite", "codex.db-wal");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(wal), { recursive: true });
    fs.writeFileSync(wal, "active wal");
    fd = fs.openSync(wal, "r");
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      directFinalExitHandoff(["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated", "target_previous_context=default", "nonce=test"].join("\n") + "\n"),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /shared catalog migration failed; restored default/);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /phase=failed/);
  } finally {
    if (fd != null) fs.closeSync(fd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed shared handoff rolls back migration and restores target registry context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-handoff-migration-rollback-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const source = path.join(home, ".codex", "sqlite", "codex.db");
    const target = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, "source catalog");
    fs.writeFileSync(target, "target catalog");
    fs.writeFileSync(path.join(configDir, "account-switcher.json"), `${JSON.stringify({
      version: 1,
      profiles: [
        { id: "default", contextMode: "isolated", contextId: "default" },
        { id: "work", contextMode: "shared-local", contextId: "team" },
      ],
    })}\n`);
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/bash\nexit 17\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      directFinalExitHandoff(["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=default", "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated", "target_previous_context=default", "nonce=test"].join("\n") + "\n"),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(source, "utf8"), "source catalog");
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "target catalog");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.existsSync(shared), false);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /phase=failed/);

    const fixture = `
const V={isTrustedIpcSender:()=>true};let handler;const l={app:{whenReady:()=>new Promise(()=>{}),once:()=>{}},ipcMain:{handle:(name,value)=>{handler=value}}};let be;be=e=>V.isTrustedIpcSender(e.sender,e.senderFrame??null);setImmediate(async()=>{await handler({sender:{}},{action:"list"});process.exit(0)});
`;
    const recovered = spawnSync(process.execPath, ["-e", applyMainBundlePatch(fixture)], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(recovered.status, 0, `${recovered.stderr}\n${recovered.stdout}`);
    const registry = JSON.parse(fs.readFileSync(path.join(configDir, "account-switcher.json"), "utf8"));
    assert.deepEqual(registry.profiles.find((profile) => profile.id === "work"), { id: "work", contextMode: "isolated", contextId: "default" });
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isolated handoff detaches source and target from their previous shared context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-isolation-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    const source = path.join(home, ".codex", "sqlite", "codex.db");
    const target = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db");
    const sharedWal = `${shared}-wal`;
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(shared, "shared catalog");
    fs.writeFileSync(sharedWal, "shared wal from a different generation");
    const sharedRoot = path.dirname(shared);
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(sharedRoot, "sessions", "rollout.jsonl"), "shared rollout");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "shared session index");
    fs.writeFileSync(`${source}.isolated-backup`, "source catalog");
    fs.writeFileSync(`${target}.isolated-backup`, "target catalog");
    fs.symlinkSync(shared, source);
    fs.symlinkSync(shared, target);
    fs.symlinkSync(sharedWal, `${source}-wal`);
    fs.symlinkSync(sharedWal, `${target}-wal`);
    fs.mkdirSync(path.join(home, ".codex", "sessions.isolated-backup"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "sessions.isolated-backup", "source.txt"), "source sessions");
    fs.mkdirSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions.isolated-backup"), { recursive: true });
    fs.writeFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions.isolated-backup", "target.txt"), "target sessions");
    fs.writeFileSync(path.join(home, ".codex", "session_index.jsonl.isolated-backup"), "source index");
    fs.writeFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "session_index.jsonl.isolated-backup"), "target index");
    fs.symlinkSync(path.join(sharedRoot, "sessions"), path.join(home, ".codex", "sessions"));
    fs.symlinkSync(path.join(sharedRoot, "sessions"), path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions"));
    fs.symlinkSync(path.join(sharedRoot, "session_index.jsonl"), path.join(home, ".codex", "session_index.jsonl"));
    fs.symlinkSync(path.join(sharedRoot, "session_index.jsonl"), path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "session_index.jsonl"));
    fs.writeFileSync(path.join(appDir, "start.sh"), "#!/bin/bash\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(configDir, "account-switcher.handoff"),
      directFinalExitHandoff(["version=1", "phase=requested", "from_id=default", "from_mode=isolated", "from_context=team", "target_id=work", "target_mode=isolated", "target_context=default", "target_previous_mode=shared-local", "target_previous_context=team", "nonce=test"].join("\n") + "\n"),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "after-exit-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(source, "utf8"), "source catalog");
    assert.equal(fs.existsSync(`${source}-wal`), false);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "target catalog");
    assert.equal(fs.existsSync(`${target}-wal`), false);
    assert.equal(fs.lstatSync(path.join(home, ".codex", "sessions")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(home, ".codex", "sessions", "source.txt"), "utf8"), "source sessions");
    assert.equal(fs.lstatSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions")).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sessions", "target.txt"), "utf8"), "target sessions");
    assert.equal(fs.readFileSync(path.join(home, ".codex", "session_index.jsonl"), "utf8"), "source index");
    assert.equal(fs.readFileSync(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "session_index.jsonl"), "utf8"), "target index");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stage-only AppImage composes account-switcher hooks and readiness through AppRun", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-appimage-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const sourceApp = path.join(tempDir, "source-app");
    const appDirRoot = path.join(tempDir, "staged.AppDir");
    const appDir = path.join(appDirRoot, "opt", "codex-desktop");
    const configDir = path.join(home, ".config", "codex-desktop");
    const configPath = path.join(tempDir, "features.json");
    const icon = path.join(tempDir, "icon.png");
    fs.mkdirSync(path.join(sourceApp, "resources"), { recursive: true });
    const launcher = fs.readFileSync(path.join(__dirname, "..", "..", "launcher", "start.sh.template"), "utf8")
      .replaceAll("__CODEX_LINUX_APP_ID__", "codex-desktop")
      .replaceAll("__CODEX_LINUX_APP_DISPLAY_NAME__", "ChatGPT Community");
    fs.writeFileSync(path.join(sourceApp, "start.sh"), launcher, { mode: 0o755 });
    fs.writeFileSync(path.join(sourceApp, "resources", "app.asar"), "fixture");
    fs.writeFileSync(path.join(sourceApp, "resources", "codex"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(icon, "fixture icon");
    fs.writeFileSync(configPath, JSON.stringify({ enabled: ["account-switcher"] }));
    fs.writeFileSync(path.join(sourceApp, "ChatGPT"), `#!/bin/bash
set -eu
if [ -n "\${CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE:-}" ]; then
    printf 'replacement\n' >> "\$HOME/lifecycle-order"
    printf '%s\n' "\$\$" > "\$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE"
    sleep 0.2
    exit 0
fi
rest="\$(sed 's/^.*) //' "/proc/\$PPID/stat")"
set -- \$rest
owner_start="\${20}"
owner_boot="\$(cat /proc/sys/kernel/random/boot_id)"
mkdir -p "\$XDG_CONFIG_HOME/codex-desktop"
printf '%s\n' version=1 phase=requested "owner_pid=\$PPID" "owner_start=\$owner_start" "owner_boot=\$owner_boot" from_id=default from_mode=isolated from_context=default target_id=work target_mode=isolated target_context=default target_previous_mode=isolated target_previous_context=default nonce=test > "\$XDG_CONFIG_HOME/codex-desktop/account-switcher.handoff"
printf 'work\nisolated\ndefault\n' > "\$XDG_CONFIG_HOME/codex-desktop/account-switcher.active"
printf 'initial\n' >> "\$HOME/lifecycle-order"
`, { mode: 0o755 });
    stageEnabledLinuxFeatureInstall(sourceApp, {
      featuresRoot: path.join(__dirname, ".."),
      featuresConfigPath: configPath,
    });
    const upstreamMetadata = path.join(sourceApp, ".codex-linux", "upstream-package");
    fs.mkdirSync(upstreamMetadata, { recursive: true });
    fs.writeFileSync(path.join(upstreamMetadata, "control"), "Package: chatgpt\nVersion: 1.0.0\nArchitecture: amd64\n");
    const cleanupHook = path.join(sourceApp, ".codex-linux", "after-exit.d", "zz-test-cleanup");
    fs.mkdirSync(path.dirname(cleanupHook), { recursive: true });
    fs.writeFileSync(cleanupHook, "#!/bin/sh\nprintf 'cleanup\\n' >> \"$HOME/lifecycle-order\"\n", { mode: 0o755 });
    const build = spawnSync("bash", [path.join(__dirname, "..", "..", "scripts", "build-appimage.sh")], {
      env: {
        ...process.env,
        APP_DIR_OVERRIDE: sourceApp,
        APPIMAGE_APPDIR_OVERRIDE: appDirRoot,
        APPIMAGE_STAGE_ONLY: "1",
        DIST_DIR_OVERRIDE: path.join(tempDir, "dist"),
        PACKAGE_ICON_SOURCE: icon,
      },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(build.status, 0, `${build.stderr}\n${build.stdout}`);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    const result = spawnSync(path.join(appDirRoot, "AppRun"), [], {
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        CODEX_HOME: path.join(home, ".codex"),
        CODEX_LINUX_DISABLE_USAGE_REPORTING: "1",
      },
      encoding: "utf8",
      timeout: 20000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.stderr, "");
    assert.deepEqual(fs.readFileSync(path.join(home, "lifecycle-order"), "utf8").trim().split("\n").slice(0, 3), ["initial", "cleanup", "replacement"]);
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.handoff")), false);
    for (const relative of [
      ".codex-linux/launcher.d/account-switcher-account-switcher-launcher.sh",
      ".codex-linux/prelaunch.d/account-switcher-account-switcher-prelaunch.sh",
      ".codex-linux/exit-claim.d/account-switcher-account-switcher-exit-claim.sh",
      ".codex-linux/final-exit.d/account-switcher-account-switcher-final-exit.sh",
      ".codex-linux/features/account-switcher/shared-state.sh",
      ".codex-linux/codex-packaged-runtime.sh",
    ]) assert.equal(fs.existsSync(path.join(appDir, relative)), true, relative);
    assert.equal(fs.statSync(path.join(appDir, ".codex-linux", "final-exit.d", "account-switcher-account-switcher-final-exit.sh")).mode & 0o111, 0o111);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("active profile removal waits for replacement readiness and preserves rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remove-active-"));
  try {
    const home = path.join(tempDir, "home");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const profileRoot = path.join(home, ".local", "share", "codex-desktop", "account-profiles", "work");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    const launcher = path.join(appDir, "start.sh");
    const hook = path.join(__dirname, "after-exit-hook.sh");
    const handoff = directFinalExitHandoff(["version=1", "phase=requested", "from_id=work", "from_mode=isolated", "from_context=default", "target_id=default", "target_mode=isolated", "target_context=default", "remove_id=work", "nonce=test"].join("\n") + "\n");
    const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir };

    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "sentinel"), "delete me");
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(launcher, "#!/bin/sh\n: > \"$CODEX_LINUX_ACCOUNT_SWITCHER_READY_FILE\"\n", { mode: 0o755 });
    const success = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(success.status, 0, `${success.stderr}\n${success.stdout}`);
    assert.equal(fs.existsSync(profileRoot), false);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.remove-complete"), "utf8"), "work\n");

    fs.rmSync(path.join(configDir, "account-switcher.remove-complete"), { force: true });
    fs.mkdirSync(profileRoot, { recursive: true });
    fs.writeFileSync(path.join(profileRoot, "sentinel"), "preserve me");
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), handoff, { mode: 0o600 });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
    const failed = spawnSync("bash", [hook], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.equal(fs.readFileSync(path.join(profileRoot, "sentinel"), "utf8"), "preserve me");
    assert.equal(fs.existsSync(path.join(configDir, "account-switcher.remove-complete")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared migration refuses an active state SQLite WAL handle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-wal-"));
  let fd;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    const db = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "state_5.sqlite-wal");
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db.slice(0, -4), "database");
    fs.writeFileSync(db, "wal");
    fd = fs.openSync(db, "r");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: { HOME: home, XDG_DATA_HOME: dataHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /state SQLite path is open/);
  } finally {
    if (fd != null) fs.closeSync(fd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared migration refuses a closed hot rollback journal", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-rollback-journal-"));
  try {
    const home = path.join(tempDir, "home");
    const codexHome = path.join(home, ".codex");
    const journal = path.join(codexHome, "sqlite", "codex.db-journal");
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "sqlite", "codex.db"), "database");
    fs.writeFileSync(journal, "hot journal");
    const helper = path.join(__dirname, "shared-state.sh");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_assert_offline ${JSON.stringify(codexHome)}`], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SQLite rollback journal exists/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("untouched isolated startup leaves a rollback journal for SQLite recovery", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-isolated-journal-"));
  try {
    const home = path.join(tempDir, "home");
    const codexHome = path.join(home, ".codex");
    const appDir = path.join(tempDir, "app");
    const configDir = path.join(home, ".config", "codex-desktop");
    const journal = path.join(codexHome, "sqlite", "codex.db-journal");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    fs.writeFileSync(path.join(codexHome, "sqlite", "codex.db"), "database");
    fs.writeFileSync(journal, "hot journal");
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(journal, "utf8"), "hot journal");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isolated prelaunch flushes profile-local shared updates before detaching", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-flush-before-detach-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const codexHome = path.join(home, ".codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(path.join(codexHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(sharedRoot, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(codexHome, "sqlite"), { recursive: true });
    fs.writeFileSync(path.join(codexHome, "sessions", "new.jsonl"), "new rollout");
    fs.writeFileSync(path.join(codexHome, ".codex-global-state.json"), JSON.stringify({ "local-projects": { newProject: true } }));
    fs.writeFileSync(path.join(sharedRoot, "codex.db"), "shared catalog");
    fs.symlinkSync(path.join(sharedRoot, "codex.db"), path.join(codexHome, "sqlite", "codex.db"));
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\nteam\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: codexHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(sharedRoot, "sessions", "new.jsonl"), "utf8"), "new rollout");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sharedRoot, "local-project-state.json"), "utf8"))["local-projects"], { newProject: true });
    assert.equal(fs.lstatSync(path.join(codexHome, "sqlite", "codex.db")).isSymbolicLink(), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("isolated preparation preserves private sessions and rollback restores shared hardlinks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-session-detach-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const codexHome = path.join(home, ".codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const sharedFile = path.join(sharedRoot, "sessions", "shared.jsonl");
    const targetShared = path.join(codexHome, "sessions", "shared.jsonl");
    const privateFile = path.join(codexHome, "sessions", "private.jsonl");
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.mkdirSync(path.dirname(privateFile), { recursive: true });
    fs.writeFileSync(sharedFile, "shared");
    fs.linkSync(sharedFile, targetShared);
    fs.writeFileSync(privateFile, "private");
    const helper = path.join(__dirname, "shared-state.sh");
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: dataHome };
    const prepared = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_prepare_isolated ${JSON.stringify(codexHome)} team`], { env, encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const journal = prepared.stdout.trim();
    assert.equal(fs.readFileSync(privateFile, "utf8"), "private");
    assert.notEqual(fs.statSync(targetShared).ino, fs.statSync(sharedFile).ino);

    const rolledBack = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_rollback_prepared team ${JSON.stringify(journal)}`], { env, encoding: "utf8" });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(fs.readFileSync(privateFile, "utf8"), "private");
    assert.equal(fs.statSync(targetShared).ino, fs.statSync(sharedFile).ino);
    assert.equal(fs.existsSync(journal), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("leaving a freshly seeded shared context materializes its catalog", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-catalog-detach-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const codexHome = path.join(home, ".codex");
    const shared = path.join(dataHome, "codex-desktop", "account-contexts", "team", "codex.db");
    const target = path.join(codexHome, "sqlite", "codex.db");
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(shared, "seed catalog");
    fs.symlinkSync(shared, target);
    const helper = path.join(__dirname, "shared-state.sh");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_detach_isolated ${JSON.stringify(codexHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "seed catalog");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("copied rollouts reconcile active updates back into the shared context", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-rollout-copy-"));
  try {
    const source = path.join(tempDir, "source");
    const shared = path.join(tempDir, "shared");
    const journal = path.join(tempDir, "journal");
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(source, "rollout.jsonl"), "new active content");
    fs.writeFileSync(path.join(shared, "rollout.jsonl"), "stale shared content");
    const helper = path.join(__dirname, "shared-state.sh");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_merge_session_tree ${JSON.stringify(source)} ${JSON.stringify(shared)} ${JSON.stringify(journal)} 0 1`], {
      env: { ...process.env, HOME: path.join(tempDir, "home") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(shared, "rollout.jsonl"), "utf8"), "new active content");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("materialization replaces stale copied rollouts and rolls them back transactionally", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-rollout-materialize-"));
  try {
    const target = path.join(tempDir, "target");
    const shared = path.join(tempDir, "shared");
    const journal = path.join(tempDir, "journal");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(journal, { recursive: true });
    fs.writeFileSync(path.join(target, "rollout.jsonl"), "stale target content");
    fs.writeFileSync(path.join(shared, "rollout.jsonl"), "selected shared content");
    const helper = path.join(__dirname, "shared-state.sh");
    const prepared = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_materialize_session_tree ${JSON.stringify(target)} ${JSON.stringify(shared)} ${JSON.stringify(journal)} 0`], {
      env: { ...process.env, HOME: path.join(tempDir, "home") },
      encoding: "utf8",
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.equal(fs.readFileSync(path.join(target, "rollout.jsonl"), "utf8"), "selected shared content");
    assert.equal(fs.statSync(path.join(target, "rollout.jsonl")).ino, fs.statSync(path.join(shared, "rollout.jsonl")).ino);
    const rolledBack = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_restore_journal ${JSON.stringify(journal)}`], {
      env: { ...process.env, HOME: path.join(tempDir, "home") },
      encoding: "utf8",
    });
    assert.equal(rolledBack.status, 0, rolledBack.stderr);
    assert.equal(fs.readFileSync(path.join(target, "rollout.jsonl"), "utf8"), "stale target content");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rollback distinguishes an interrupted backup from a completed backup", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-backup-crash-"));
  try {
    const helper = path.join(__dirname, "shared-state.sh");
    const target = path.join(tempDir, "state.json");

    fs.writeFileSync(target, "original before pending record");
    let journal = path.join(tempDir, "pending-before-copy");
    fs.mkdirSync(journal);
    let result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_write_record ${JSON.stringify(journal)} 1 ${JSON.stringify(target)} '' ${JSON.stringify(path.join(journal, "state-1.backup"))} restore-pending; account_switcher_restore_journal ${JSON.stringify(journal)}`], {
      env: { ...process.env, HOME: path.join(tempDir, "home") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), "original before pending record");

    journal = path.join(tempDir, "pending-after-copy");
    fs.mkdirSync(journal);
    const backup = path.join(journal, "state-1.backup");
    fs.writeFileSync(backup, "durable original backup");
    fs.rmSync(target);
    result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_write_record ${JSON.stringify(journal)} 1 ${JSON.stringify(target)} '' ${JSON.stringify(backup)} restore-pending; account_switcher_restore_journal ${JSON.stringify(journal)}`], {
      env: { ...process.env, HOME: path.join(tempDir, "home") },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(target, "utf8"), "durable original backup");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("interrupted committed-journal cleanup cannot re-enter rollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-commit-cleanup-crash-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const journal = path.join(sharedRoot, ".account-switcher-migration-fixture");
    const target = path.join(home, ".codex", "session_index.jsonl");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(journal, { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "committed state must survive");
    const interrupted = spawnSync("bash", ["-c", `
source ${JSON.stringify(helper)}
account_switcher_write_record ${JSON.stringify(journal)} 1 ${JSON.stringify(target)} '' '' session-link
rm() { for argument in "$@"; do [[ "$argument" == *account-switcher-committed-* ]] && return 88; done; command rm "$@"; }
account_switcher_commit_prepared team ${JSON.stringify(journal)} && exit 7
exit 0
`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(interrupted.status, 0, interrupted.stderr);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.readdirSync(sharedRoot).some((name) => name.startsWith(".account-switcher-committed-")), true);
    assert.equal(fs.readFileSync(target, "utf8"), "committed state must survive");

    const recovered = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; lock=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); account_switcher_recover_context ${JSON.stringify(sharedRoot)}; account_switcher_context_lock_release "$lock"`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.readdirSync(sharedRoot).some((name) => name.startsWith(".account-switcher-committed-")), false);
    assert.equal(fs.readFileSync(target, "utf8"), "committed state must survive");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("session-index merge I/O failure aborts and restores the transaction", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-index-merge-failure-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const codexHome = path.join(home, ".codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const fakeBin = path.join(tempDir, "bin");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "session_index.jsonl"), "source index\n");
    fs.writeFileSync(path.join(sharedRoot, "session_index.jsonl"), "shared index\n");
    fs.writeFileSync(path.join(fakeBin, "awk"), "#!/bin/sh\nprintf 'partial output\\n'\nexit 28\n", { mode: 0o755 });
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_prepare_shared ${JSON.stringify(codexHome)} ${JSON.stringify(codexHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, PATH: `${fakeBin}:${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(codexHome, "session_index.jsonl"), "utf8"), "source index\n");
    assert.equal(fs.readFileSync(path.join(sharedRoot, "session_index.jsonl"), "utf8"), "shared index\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared contexts are private even with a permissive caller umask", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-private-context-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const codexHome = path.join(home, ".codex");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const helper = path.join(__dirname, "shared-state.sh");
    const result = spawnSync("bash", ["-c", `umask 022; source ${JSON.stringify(helper)}; account_switcher_migrate_shared ${JSON.stringify(codexHome)} ${JSON.stringify(codexHome)} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.statSync(sharedRoot).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared-context lock serializes migration recovery", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-context-lock-"));
  let holder;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const ready = path.join(tempDir, "lock-ready");
    const helper = path.join(__dirname, "shared-state.sh");
    const holderScript = `source ${JSON.stringify(helper)}; lock=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); : > ${JSON.stringify(ready)}; sleep 0.4; account_switcher_context_lock_release "$lock"`;
    holder = spawn("bash", ["-c", holderScript], { env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome } });
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fs.existsSync(ready), true);
    const startedAt = Date.now();
    const migration = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_migrate_shared ${JSON.stringify(path.join(home, ".codex"))} ${JSON.stringify(path.join(home, ".codex"))} team`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(migration.status, 0, migration.stderr);
    assert.ok(Date.now() - startedAt >= 250, "migration should wait for the live context owner");
    assert.equal(fs.existsSync(path.join(sharedRoot, ".account-switcher.lock")), false);
  } finally {
    holder?.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shared-context lock reclaims a legacy ownerless lock atomically", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-ownerless-context-lock-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const lock = path.join(sharedRoot, ".account-switcher.lock");
    fs.mkdirSync(lock, { recursive: true });
    const helper = path.join(__dirname, "shared-state.sh");
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; acquired=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); account_switcher_context_lock_release "$acquired"`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock recovery never admits two context owners", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-stale-context-lock-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const critical = path.join(tempDir, "critical");
    const lock = path.join(sharedRoot, ".account-switcher.lock");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(sharedRoot, { recursive: true });
    fs.writeFileSync(lock, "99999999\n", { mode: 0o600 });
    const script = `source ${JSON.stringify(helper)}; acquired=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); mkdir ${JSON.stringify(critical)}; sleep 0.15; rmdir ${JSON.stringify(critical)}; account_switcher_context_lock_release "$acquired"`;
    const env = { ...process.env, HOME: home, XDG_DATA_HOME: dataHome };
    const children = [spawn("bash", ["-c", script], { env }), spawn("bash", ["-c", script], { env })];
    const results = await Promise.all(children.map((child) => new Promise((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("close", (status) => resolve({ status, stderr }));
    })));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(lock), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an abandoned migration journal is rolled back after a crash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-migration-crash-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const source = path.join(home, ".codex", "sqlite", "codex.db");
    const target = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex", "sqlite", "codex.db");
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const shared = path.join(sharedRoot, "codex.db");
    const helper = path.join(__dirname, "shared-state.sh");
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(source, "source before crash");
    fs.writeFileSync(target, "target before crash");
    const crashed = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_prepare_shared ${JSON.stringify(path.join(home, ".codex"))} ${JSON.stringify(path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex"))} team >/dev/null; exit 99`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(crashed.status, 99);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), true);
    const recovered = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; lock=$(account_switcher_context_lock_acquire ${JSON.stringify(sharedRoot)}); account_switcher_recover_context ${JSON.stringify(sharedRoot)}; account_switcher_context_lock_release "$lock"`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(source, "utf8"), "source before crash");
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(target, "utf8"), "target before crash");
    assert.equal(fs.existsSync(shared), false);
    assert.deepEqual(fs.readdirSync(sharedRoot).filter((name) => name.startsWith(".account-switcher-migration-")), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cold launcher recovery rolls back an interrupted handoff before profile selection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-handoff-crash-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const configDir = path.join(home, ".config", "codex-desktop");
    const appDir = path.join(tempDir, "app");
    const sourceHome = path.join(home, ".codex");
    const targetHome = path.join(dataHome, "codex-desktop", "account-profiles", "work", "codex");
    const source = path.join(sourceHome, "sqlite", "codex.db");
    const target = path.join(targetHome, "sqlite", "codex.db");
    const helper = path.join(__dirname, "shared-state.sh");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(source, "source before interrupted handoff");
    fs.writeFileSync(target, "target before interrupted handoff");
    const crashed = spawnSync("bash", ["-c", `source ${JSON.stringify(helper)}; account_switcher_prepare_shared ${JSON.stringify(sourceHome)} ${JSON.stringify(targetHome)} team >/dev/null; exit 99`], {
      env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome },
      encoding: "utf8",
    });
    assert.equal(crashed.status, 99);
    const sharedRoot = path.join(dataHome, "codex-desktop", "account-contexts", "team");
    const journalsBefore = fs.readdirSync(sharedRoot).filter((name) => name.startsWith(".account-switcher-migration-"));
    assert.equal(journalsBefore.length, 1);
    const abandonedOwner = fs.readFileSync(path.join(sharedRoot, journalsBefore[0], "pid"), "utf8").trim();
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nshared-local\nteam\n", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), [
      "version=1", "phase=launching", "owner_pid=99999999", "from_id=default", "from_mode=isolated", "from_context=default",
      "target_id=work", "target_mode=shared-local", "target_context=team", "target_previous_mode=isolated", "target_previous_context=default",
    ].join("\n") + "\n", { mode: 0o600 });
    const recovered = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: sourceHome, CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(recovered.stdout, [
      "unset-env CODEX_ELECTRON_USER_DATA_PATH",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_LAUNCH_GUARD=1",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=default",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT=isolated",
      "env CODEX_LINUX_ACCOUNT_SWITCHER_CONTEXT_ID=default",
      "",
    ].join("\n"));
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /phase=failed/);
    const journalsAfter = fs.readdirSync(sharedRoot).filter((name) => name.startsWith(".account-switcher-migration-"));
    assert.equal(fs.lstatSync(source).isSymbolicLink(), false, `owner=${abandonedOwner} journals=${JSON.stringify(journalsAfter)}\n${recovered.stderr}`);
    assert.equal(fs.readFileSync(source, "utf8"), "source before interrupted handoff");
    assert.equal(fs.readFileSync(target, "utf8"), "target before interrupted handoff");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher routes a concurrent invocation to the live handoff source", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-live-requested-handoff-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const configDir = path.join(home, ".config", "codex-desktop");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    const owner = processIdentity();
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), [
      "version=1", "phase=requested", `owner_pid=${owner.pid}`, `owner_start=${owner.start}`, `owner_boot=${owner.boot}`, "from_id=work", "from_mode=isolated", "from_context=default",
      "target_id=default", "target_mode=isolated", "target_context=default", "target_previous_mode=isolated", "target_previous_context=default",
    ].join("\n") + "\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=work/);
    assert.match(result.stdout, /electron-arg --user-data-dir=.*account-profiles\/work\/electron/);
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /phase=requested/);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "default\nisolated\ndefault\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher rejects a requested handoff whose PID identity was reused", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-reused-handoff-pid-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const configDir = path.join(home, ".config", "codex-desktop");
    const appDir = path.join(tempDir, "app");
    const owner = processIdentity();
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nisolated\ndefault\n", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), [
      "version=1", "phase=requested", `owner_pid=${owner.pid}`, `owner_start=${Number(owner.start) + 1}`, `owner_boot=${owner.boot}`,
      "from_id=work", "from_mode=isolated", "from_context=default", "target_id=default", "target_mode=isolated", "target_context=default",
    ].join("\n") + "\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_HOME: path.join(home, ".codex"), CODEX_LINUX_APP_DIR: appDir },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=work/);
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /phase=failed/);
    assert.equal(fs.readFileSync(path.join(configDir, "account-switcher.active"), "utf8"), "work\nisolated\ndefault\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("launcher rejects a live handoff PID without start and boot identity", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-missing-handoff-identity-"));
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const configDir = path.join(home, ".config", "codex-desktop");
    const appDir = path.join(tempDir, "app");
    stageSharedStateHelper(appDir);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "work\nisolated\ndefault\n", { mode: 0o600 });
    fs.writeFileSync(path.join(configDir, "account-switcher.handoff"), [
      "version=1", "phase=requested", `owner_pid=${process.pid}`,
      "from_id=default", "from_mode=isolated", "from_context=default",
      "target_id=work", "target_mode=isolated", "target_context=default",
    ].join("\n") + "\n", { mode: 0o600 });
    const result = spawnSync("bash", [path.join(__dirname, "launcher-hook.sh")], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: dataHome, CODEX_LINUX_APP_DIR: appDir }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /env CODEX_LINUX_ACCOUNT_SWITCHER_PROFILE=default/);
    assert.match(fs.readFileSync(path.join(configDir, "account-switcher.handoff"), "utf8"), /^phase=failed$/m);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("default profile ownership survives an AppImage remount", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-remount-owner-"));
  let appProcess;
  try {
    const home = path.join(tempDir, "home");
    const oldAppDir = path.join(tempDir, ".mount-old", "opt", "codex-desktop");
    const newAppDir = path.join(tempDir, ".mount-new", "opt", "codex-desktop");
    const oldBinary = path.join(oldAppDir, "ChatGPT");
    fs.mkdirSync(oldAppDir, { recursive: true });
    fs.mkdirSync(newAppDir, { recursive: true });
    fs.copyFileSync(process.execPath, oldBinary);
    fs.copyFileSync("/bin/true", path.join(newAppDir, "ChatGPT"));
    fs.chmodSync(oldBinary, 0o755);
    fs.chmodSync(path.join(newAppDir, "ChatGPT"), 0o755);
    appProcess = spawn(oldBinary, ["-e", "setTimeout(() => {}, 30000)"], { env: { ...process.env, CODEX_LINUX_APP_ID: "codex-desktop", CODEX_LINUX_APP_DIR: oldAppDir, APPIMAGE: path.join(tempDir, "old.AppImage") } });
    await new Promise((resolve, reject) => { appProcess.once("spawn", resolve); appProcess.once("error", reject); });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (fs.readlinkSync(`/proc/${appProcess.pid}/exe`).includes("ChatGPT")) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    fs.unlinkSync(oldBinary);
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(path.join(__dirname, "shared-state.sh"))}; account_switcher_assert_offline ${JSON.stringify(path.join(home, ".codex"))} ${JSON.stringify(path.join(home, ".config", "Codex"))}`], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), CODEX_LINUX_APP_DIR: newAppDir, CODEX_LINUX_APP_ID: "codex-desktop" }, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /profile is still owned by a live Electron process/);
  } finally {
    appProcess?.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("every live AppImage invocation bypasses migration across remounts for upstream handoff", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "account-switcher-deep-link-"));
  let appProcess;
  let fd;
  try {
    const home = path.join(tempDir, "home");
    const dataHome = path.join(home, ".local", "share");
    const appDir = path.join(tempDir, ".mount-new", "opt", "codex-desktop");
    stageSharedStateHelper(appDir);
    const configDir = path.join(home, ".config", "codex-desktop");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "account-switcher.active"), "default\nshared-local\nteam\n", { mode: 0o600 });
    const db = path.join(home, ".codex", "sqlite", "codex.db");
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, "open");
    const appPath = path.join(tempDir, ".mount-old", "opt", "codex-desktop", "ChatGPT");
    const appImage = path.join(tempDir, "codex-desktop.AppImage");
    fs.mkdirSync(path.dirname(appPath), { recursive: true });
    fs.copyFileSync("/bin/sleep", appPath);
    fs.chmodSync(appPath, 0o755);
    appProcess = spawn(appPath, ["30"], { argv0: "ChatGPT", env: { ...process.env, APPIMAGE: appImage } });
    await new Promise((resolve, reject) => {
      appProcess.once("spawn", resolve);
      appProcess.once("error", reject);
    });
    fs.unlinkSync(appPath);
    fd = fs.openSync(db, "r");
    const env = { HOME: home, XDG_DATA_HOME: dataHome, CODEX_LINUX_APP_DIR: appDir, CODEX_HOME: path.join(home, ".codex"), APPIMAGE: appImage };
    const result = spawnSync("bash", [path.join(__dirname, "prelaunch-hook.sh")], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    if (fd != null) fs.closeSync(fd);
    appProcess?.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
