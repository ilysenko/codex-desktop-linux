#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const {
  applyMainBundlePatch,
  applyNativeOpenTargetSelectionPatch,
  applyOpenInTargetCommandPatch,
  applyOpenInTargetRegistryCommandPatch,
  applyOpenInTargetsBridgeDetectionPatch,
  applyOpenInTargetsAvailabilityPatch,
  applyOpenInTargetsDirectoryModePatch,
  descriptors,
} = require("./patch.js");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patches/runner.js");

const mainBundlePrefix =
  "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`),u=require(`node:child_process`);";
const fileManagerBundle =
  "function jl(e){return e}function il(e){return [e]}var lu=jl({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>il(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:uu,args:e=>il(e),open:async({path:e})=>du(e)}});function uu(){}";
const terminalOpenTargetBundle =
  "var uh={id:`terminal`,platforms:{darwin:{label:`Terminal`,icon:`apps/terminal.png`,kind:`terminal`,detect:()=>`open`,args:e=>[`-a`,`Terminal`,e]},win32:{label:`Terminal`,icon:`apps/microsoft-terminal.png`,kind:`terminal`,detect:vh,iconPath:()=>null,args:yh,open:({command:e,path:t})=>bh(e,yh(t))}}};function vh(){return `wt.exe`}function yh(e){return[`-d`,e]}async function bh(){}";
const ideOpenTargetsBundle =
  "function ih({id:e,label:t,icon:n,darwinDetect:r,win32Detect:i,darwinEnv:a,darwinArgs:o,hidden:s}){return{id:e,platforms:{darwin:r?{label:t,icon:n,kind:`editor`,hidden:s,detect:r,env:a,args:o??ah,supportsSsh:!0}:void 0,win32:i?{label:t,icon:n,kind:`editor`,hidden:s,detect:i,args:ah,supportsSsh:!0}:void 0}}}var ah=(e,t)=>t?[`${e}:${t.line}:${t.column}`]:[e];var Og=ih({id:`vscode`,label:`VS Code`,icon:`apps/vscode.png`,darwinDetect:()=>`open`,win32Detect:()=>`Code.exe`});var jh=ih({id:`cursor`,label:`Cursor`,icon:`apps/cursor.png`,darwinDetect:()=>`open`,win32Detect:()=>`Cursor.exe`});function sg({id:e,label:t,icon:n,toolboxTarget:r,macExecutable:i,windowsPathCommands:a,windowsInstallDirPrefixes:o,windowsInstallExecutables:s}){return{id:e,platforms:{darwin:{label:t,icon:n,kind:`editor`,detect:()=>`open`,args:mg},win32:a&&o&&s?{label:t,icon:n,kind:`editor`,detect:()=>`idea.exe`,args:mg}:void 0}}}function mg(e,t){return t?[`--line`,t.line.toString(),`--column`,t.column.toString(),e]:[e]}var $h=sg({id:`intellij`,label:`IntelliJ IDEA`,icon:`apps/intellij.png`,toolboxTarget:`intellij`,macExecutable:`idea`,windowsPathCommands:[`idea`],windowsInstallDirPrefixes:[`idea`],windowsInstallExecutables:[`idea`]});var Wg={id:`zed`,platforms:{darwin:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Gg,args:hg},win32:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Kg,args:hg}}};function Gg(){}function Kg(){}function hg(e,t){return t?[`${e}:${t.line}:${t.column}`]:[e]}var Xg=[Og,jh,Wg,$h];";
const openTargetsBundle = `${mainBundlePrefix}${fileManagerBundle}${terminalOpenTargetBundle}${ideOpenTargetsBundle}`;
const collidingPathAliasBundle =
  "let n=require(`electron`),o=require(`node:path`),c=require(`node:fs`),u=require(`node:child_process`);" +
  fileManagerBundle +
  terminalOpenTargetBundle +
  ideOpenTargetsBundle;
const currentIconResolverBundle =
  "async function VN(e,t,n){return e===`win32`?Promise.all(t.map(async e=>{let t=n?.get(e.id)??null,r=e.iconPath?e.iconPath(t):t;return{id:e.id,label:e.label,icon:await WN(r,e.icon),kind:e.kind,hidden:e.hidden,supportsSsh:e.supportsSsh}})):HN(t)}function HN(e){return e.map(({id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a})=>({id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a}))}async function WN(e,t){if(!e)return t;try{let r=e.toLowerCase().endsWith(`.lnk`)?await UN(e):await n.app.getFileIcon(e,{size:`normal`});return!r||r.isEmpty()?t:r.toDataURL()}catch(e){return t}}async function UN(e){return n.nativeImage.createFromPath(e)}";
const currentAppRegistryFunction =
  "function QN(e){let t=e.getEffective(`customFileHandlers`);if(t==null)return PN;let r=BN.get(t);if(r!=null)return r;let i=t,a=i.length===0?PN:[...PN,...i];return BN.set(t,a),a}";
const currentAppOpenTargetPrelude =
  `var PN=[],FN=async e=>\`shortcut:\${e}\`,BN=new WeakMap;function RN(e){return e.map(({id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a})=>({id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a}))}function HN(e){return RN(QN(e))}function UN(e,t){let n=QN(e).find(e=>e.id===t);return n?.configuredCommand==null||n.configuredIcon==null?{target:t}:{target:t,customTarget:{command:n.configuredCommand,icon:n.configuredIcon}}}${currentAppRegistryFunction}async function LN(e,t,{detectedCommand:r,targets:c=PN}={}){let l=c.find(t=>t.id===e);if(!l)throw Error(\`Unknown open target "\${e}"\`);let u=r??await l.detect(FN);if(!u)throw Error(\`Open target "\${e}" is not available\`);return u}var WRONG={};async function unrelated(e){return await e.detect(WRONG)}function zN(){return{error(){},warning(){}}}`;
const currentAppOpenInCommandBundle =
  `${currentAppOpenTargetPrelude}class App{constructor(e,t){this.settingsStore=e;this.requestOpenInWorker=t}getSettingsStore(){return this.settingsStore}getOpenInWorker(){return this.requestOpenInWorker}async getOpenInTargetCommand(e){let{command:t}=await this.getOpenInWorker()({method:\`get-target-command\`,params:UN(this.getSettingsStore(),e)});if(t==null)throw Error(\`Open target "\${e}" is not available\`);return t}}`;
const currentAppOpenInAvailabilityBundle =
  `${currentAppOpenTargetPrelude}async function WN(e,t){let n=await Promise.all(HN(e).map(async n=>{let r=UN(e,n.id),[i,a]=await Promise.all([t({method:\`get-target-command\`,params:r}).then(e=>e.command).catch(e=>(zN().error(\`Failed to detect open target\`,{safe:{},sensitive:{id:n.id,error:e}}),null)),process.platform===\`win32\`?t({method:\`load-target-icon\`,params:r}).then(e=>e.icon).catch(e=>(zN().warning(\`Failed to resolve open target icon\`,{safe:{},sensitive:{id:n.id,error:e}}),n.icon)):n.icon]);return{command:i,metadata:{...n,icon:a}}}));return{allAvailableTargets:n.flatMap(({command:e,metadata:t})=>e==null?[]:[t.id]),targetMetadata:n.map(({metadata:e})=>e)}}`;
const currentAppOpenInBridgeBundle =
  `${currentAppOpenTargetPrelude}class App{constructor(e,t){this.settingsStore=e;this.requestOpenInWorker=t}#n(){return this.requestOpenInWorker}async detectTarget({target:e}){let{command:t}=await this.#n()({method:\`get-target-command\`,params:UN(this.settingsStore,e)});return{available:t!=null}}}`;
const currentAppOpenInTargetsBundle =
  '"open-in-targets":async({cwd:e,deferEnrichment:t=!1,hostId:r,nativeBrowserDiscovery:i=`scan`,path:a})=>{let o=this.getRequestAppServerClient(r??void 0),s=this.getSettingsStore();if(t&&a==null){let t=XN(s,e);return{preferredTarget:t,availableTargets:[],mode:`editor`,targets:uj(HN(s),o.hostConfig)}}let{allAvailableTargets:c,targetMetadata:l}=await WN(s,this.getOpenInWorker()),u=a?.replace(/^([ab])[\\\\/]/,``)??null,d=u!=null&&xF(u)&&!n.eo(o.hostConfig),f=u==null||d||n.eo(o.hostConfig)?null:this.resolveOpenFilePath(u,e),p=lj(o.hostConfig,c,l),m=new Set(p),h=YN(s,e,m),g=d||f!=null&&n.ys(f),_=f!=null&&KA(f),v=f!=null&&JA(f),y=g?await yF(i):_?await vF({filePath:f}):[];return{preferredTarget:h,availableTargets:Array.from(m),mode:g||v?`native`:`editor`,targets:l}}';
const currentAppOpenTargetSelectionBundle =
  "function lQ({targets:e,availableTargets:t,includeHiddenTargets:n=!1,mode:r=`editor`}){let i=e.filter(e=>e.appPath!=null);if(i.length>0)return i;if(r===`native`)return e.filter(e=>e.target===`systemDefault`||e.target===`fileManager`);let a=new Set(t);return e.filter(e=>a.has(e.target)&&(n||!e.hidden))}function uQ({preferredTarget:e,targets:t,availableTargets:n,includeHiddenTargets:r=!0,mode:i=`editor`}){let a=lQ({targets:t,availableTargets:n,includeHiddenTargets:r,mode:i});return a.length===0?null:e?a.find(t=>t.target===e)??a[0]??null:a[0]??null}function jnr(e){return e.appPath==null&&e.kind===`editor`}";

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

function currentAppSettingsStore(targets) {
  return {
    getEffective(key) {
      assert.equal(key, "customFileHandlers");
      return targets;
    },
  };
}

function makeExecutable(dir, name) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return file;
}

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-open-target-feature-"));
  let cleanup = true;
  try {
    const result = fn(dir);
    if (result && typeof result.then === "function") {
      cleanup = false;
      return result.finally(() => fs.rmSync(dir, { recursive: true, force: true }));
    }
    return result;
  } finally {
    if (cleanup) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function createSpawnRecorder({ failCommands = [], recordOptions = false, execFileSync } = {}) {
  const calls = [];
  const failures = new Set(failCommands);
  return {
    calls,
    execFileSync(command, args, options) {
      if (execFileSync) return execFileSync(command, args, options);
      throw new Error(`unexpected execFileSync: ${command} ${args.join(" ")}`);
    },
    spawn(command, args, options) {
      calls.push(recordOptions ? { command, args, options } : { command, args });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit("close", failures.has(command) ? 1 : 0));
      return child;
    },
  };
}

function requireStub(spawnRecorder = createSpawnRecorder(), openPathCalls = []) {
  return (name) => {
    if (name === "node:fs") return fs;
    if (name === "node:path") return path;
    if (name === "node:url") return { pathToFileURL };
    if (name === "node:child_process") return spawnRecorder;
    if (name === "electron") {
      return {
        shell: {
          openPath: async (target) => {
            openPathCalls.push(target);
            return "";
          },
        },
      };
    }
    return require(name);
  };
}

function evaluatePatched(source, env, expression, spawnRecorder, openPathCalls) {
  const patched = applyPatchTwice(applyMainBundlePatch, source);
  assert.doesNotThrow(() => new Function("require", "process", `${patched};return ${expression};`));
  return new Function("require", "process", `${patched};return ${expression};`)(
    requireStub(spawnRecorder, openPathCalls),
    { platform: "linux", env },
  );
}

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const root = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-open-target-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }, null, 2));
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withLinuxFeatureRootEnv(root, fn) {
  const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (originalRoot == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
    }
  }
}

test("open-target discovery directly adds file manager, terminal, and IDE support", () => {
  const patched = applyPatchTwice(applyMainBundlePatch, openTargetsBundle);

  assert.match(patched, /codexLinuxOpenFileManager\(e\)/);
  assert.match(patched, /linux:\{label:`Terminal`/);
  assert.match(patched, /linux:codexLinuxIdePlatform\(/);
  assert.match(patched, /linux:codexLinuxJetBrainsIdePlatform\(/);
  assert.match(patched, /\.\.\.codexLinuxDiscoveredIdeTargets\(\)/);
});

test("open-target discovery prefers xdg-terminal-exec for Terminal", () => {
  withTempDir((tmp) => {
    const binDir = path.join(tmp, "bin");
    const xdgTerminal = makeExecutable(binDir, "xdg-terminal-exec");
    const terminal = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: binDir },
      "uh.platforms.linux",
    );

    assert.equal(terminal.detect(), xdgTerminal);
    assert.deepEqual(terminal.args(tmp), []);
  });
});

test("open-target discovery finds terminal emulators from desktop entries", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const terminalCommand = makeExecutable(path.join(tmp, "terminal", "bin"), "toolbox-terminal");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.writeFileSync(
      path.join(appsDir, "org.example.Terminal.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Toolbox Terminal",
        `Exec=${terminalCommand} --new-window %U`,
        "Categories=System;TerminalEmulator;",
        "X-TerminalArgDir=--cwd=",
      ].join("\n"),
    );

    const terminal = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: path.join(tmp, "bin"), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "uh.platforms.linux",
    );

    assert.equal(terminal.detect(), terminalCommand);
    assert.deepEqual(terminal.args(tmp), ["--new-window", `--cwd=${tmp}`]);
  });
});

test("open-target discovery finds IDEs from desktop entries", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "fleet");
    const projectFile = path.join(tmp, "project", "src", "main.rs");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, "");
    fs.writeFileSync(
      path.join(appsDir, "com.example.Fleet.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Fleet IDE",
        `Exec=${editorCommand} --goto %f`,
        "Categories=Development;IDE;",
      ].join("\n"),
    );

    const targets = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: path.join(tmp, "bin"), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[{id:target.id,label:platform.label,command:platform.detect?.(),args:platform.args}]:[]})",
    );
    const fleet = targets.find((target) => target.label === "Fleet IDE");

    assert.ok(fleet);
    assert.equal(fleet.command, editorCommand);
    assert.deepEqual(fleet.args(projectFile), ["--goto", projectFile]);
  });
});

test("open-target discovery finds Linuxbrew VS Code outside GUI PATH", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const emptyBin = path.join(tmp, "empty-bin");
    const linuxbrewPrefix = path.join(tmp, "linuxbrew", ".linuxbrew");
    const code = makeExecutable(path.join(linuxbrewPrefix, "bin"), "code");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(emptyBin, { recursive: true });
    fs.writeFileSync(
      path.join(appsDir, "code.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Visual Studio Code",
        "Exec=code --reuse-window %U",
        "Categories=Development;IDE;",
      ].join("\n"),
    );

    const targets = evaluatePatched(
      openTargetsBundle,
      {
        HOME: tmp,
        PATH: emptyBin,
        HOMEBREW_PREFIX: linuxbrewPrefix,
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: path.join(tmp, "empty"),
      },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[{id:target.id,label:platform.label,command:platform.detect?.()}]:[]})",
    );

    const vscode = targets.find((target) => target.id === "vscode");
    assert.ok(vscode);
    assert.equal(vscode.command, code);
    assert.equal(targets.some((target) => target.id === "linux-desktop-code"), false);
  });
});

test("open-target discovery finds IDEs from symlinked desktop entries", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const linkedAppsDir = path.join(tmp, "linked-applications");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "zed-appimage");
    const desktopFile = path.join(linkedAppsDir, "dev.zed.Zed.desktop");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(linkedAppsDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Zed",
        `Exec=${editorCommand} %U`,
        "Categories=Development;IDE;",
      ].join("\n"),
    );
    fs.symlinkSync(desktopFile, path.join(appsDir, "dev.zed.Zed.desktop"));

    const targets = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: path.join(tmp, "bin"), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[{id:target.id,label:platform.label,command:platform.detect?.()}]:[]})",
    );

    assert.ok(targets.some((target) => target.id === "linux-desktop-dev-zed-zed" && target.command === editorCommand));
  });
});

function writeDesktopEntry(appsDir, fileName, lines) {
  fs.mkdirSync(appsDir, { recursive: true });
  fs.writeFileSync(path.join(appsDir, fileName), ["[Desktop Entry]", "Type=Application", ...lines].join("\n"));
}

test("open-target discovery applies TryExec filters to desktop entries", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const binDir = path.join(tmp, "bin");
    const cursor = makeExecutable(binDir, "cursor");
    const terminal = makeExecutable(binDir, "workspace-terminal");
    makeExecutable(binDir, "env");
    makeExecutable(binDir, "flatpak");
    makeExecutable(binDir, "sh");
    fs.mkdirSync(path.join(tmp, ".local", "share", "flatpak", "app", "com.example.Terminal"), { recursive: true });
    fs.mkdirSync(path.join(tmp, ".local", "share", "flatpak", "app", "it.mijorus.gearlever"), { recursive: true });
    writeDesktopEntry(appsDir, "a-broken-terminal.desktop", [
      "Name=Broken Terminal",
      "TryExec=sh -c 'command -v missing-terminal >/dev/null 2>&1'",
      `Exec=${path.join(tmp, "missing-terminal")} --cwd %D`,
      "Categories=System;TerminalEmulator;",
    ]);
    writeDesktopEntry(appsDir, "b-workspace-terminal.desktop", [
      "Name=Workspace Terminal",
      "TryExec=sh -c 'flatpak info com.example.Terminal > /dev/null 2>&1'",
      `Exec=${terminal} --cwd %D`,
      "Categories=System;TerminalEmulator;",
    ]);
    writeDesktopEntry(appsDir, "broken-cursor.desktop", [
      "Name=Broken Cursor",
      "TryExec=sh -c 'command -v missing-cursor >/dev/null 2>&1'",
      `Exec=${path.join(tmp, "missing-cursor")} %U`,
      "Categories=Development;IDE;",
    ]);
    writeDesktopEntry(appsDir, "cursor.desktop", [
      "Name=Cursor",
      "TryExec=env -i flatpak info --show-location it.mijorus.gearlever",
      `Exec=${cursor} %U`,
      "Categories=Development;IDE;",
    ]);

    const result = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: binDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "({terminal:uh.platforms.linux.detect(),ides:Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[{label:platform.label,command:platform.detect?.()}]:[]})})",
    );

    assert.equal(result.terminal, terminal);
    assert.ok(result.ides.some((target) => target.label === "Cursor" && target.command === cursor));
    assert.ok(!result.ides.some((target) => target.label === "Broken Cursor"));
  });
});

function tryExecEnv(tmp, { binNames = [], flatpakApps = [], setup } = {}) {
  const binDir = path.join(tmp, "bin");
  for (const executable of binNames) makeExecutable(binDir, executable);
  for (const appId of flatpakApps) fs.mkdirSync(path.join(tmp, ".local", "share", "flatpak", "app", appId), { recursive: true });
  setup?.({ tmp, binDir });
  return { HOME: tmp, PATH: binDir, XDG_DATA_HOME: path.join(tmp, "share"), XDG_DATA_DIRS: path.join(tmp, "empty") };
}

const tryExecCases = [
  [false, "env /missing/Cursor.AppImage", ["env"]],
  [false, "sh -c '/missing/Cursor.AppImage'", ["sh"]],
  [true, "env -u GTK_USE_PORTAL bash -lc 'command -v cursor >/dev/null 2>&1 && exec cursor'", ["env", "bash", "cursor"]],
  [true, "bash --login -c 'command -v cursor >/dev/null 2>&1 && : >/dev/null'", ["bash", "cursor"]],
  [true, "sh -c 'test -x \"$HOME/AppImages/Cursor.AppImage\" && exec \"$HOME/AppImages/Cursor.AppImage\"'", ["sh"], ({ tmp }) => makeExecutable(path.join(tmp, "AppImages"), "Cursor.AppImage")],
  [true, "bash -lc 'test -x $HOME/Tools\\ Beta/Cursor\\ AppImage'", ["bash"], ({ tmp }) => makeExecutable(path.join(tmp, "Tools Beta"), "Cursor AppImage")],
  [true, "bash -lc '[[ -x \"$HOME/AppImages/Cursor.AppImage\" ]]'", ["bash"], ({ tmp }) => makeExecutable(path.join(tmp, "AppImages"), "Cursor.AppImage")],
  [false, "sh -c '[[ -x \"$HOME/AppImages/Cursor.AppImage\" ]]'", ["sh"], ({ tmp }) => makeExecutable(path.join(tmp, "AppImages"), "Cursor.AppImage")],
  [false, "bash -lc 'test -x \"~/.local/bin/cursor\"'", ["bash"], ({ tmp }) => makeExecutable(path.join(tmp, ".local", "bin"), "cursor")],
  [true, "sh -c 'command -v cursor >/dev/null 2>&1 || command -v codium >/dev/null 2>&1'", ["sh", "codium"]],
  [false, "sh -c 'command -v workspace-terminal >/dev/null 2>&1 || command -v fallback-terminal >/dev/null 2>&1 && test -x /missing/workspace-terminal'", ["sh", "workspace-terminal", "fallback-terminal"]],
  [false, "sh -c 'command -v cursor >/dev/null 2>&1 && test -x /missing/Cursor.AppImage'", ["sh", "cursor"]],
  [true, "sh -c 'test -x \"$HOME/Terminal && Tools/Workspace Terminal\"'", ["sh"], ({ tmp }) => makeExecutable(path.join(tmp, "Terminal && Tools"), "Workspace Terminal")],
  [false, "sh -c 'false # comment'", ["sh", "false"]],
  [false, "sh -c 'command -v cursor >/dev/null 2>&1; exit 1'", ["sh", "cursor"]],
  [false, "sh -c '! command -v cursor >/dev/null 2>&1'", ["sh", "cursor"]],
  [false, "sh -c 'which /bin/ls >/dev/null 2>&1'", ["sh"]],
  [false, "bash", []],
  [true, "sh -c 'exec true && false'", ["sh", "true"]],
  [false, "sh -c 'exec /missing/cursor || true'", ["sh"]],
  [false, "missing-wrapper bash -lc 'command -v cursor >/dev/null 2>&1'", ["bash", "cursor"]],
  [false, "fish -C 'hash cursor >/dev/null 2>&1'", ["fish", "cursor"]],
  [true, "env -i flatpak info --show-location it.mijorus.gearlever", ["env", "flatpak"], null, ["it.mijorus.gearlever"]],
  [true, "sh -c 'flatpak info com.example.Terminal > /dev/null 2>&1'", ["sh", "flatpak"], null, ["com.example.Terminal"]],
  [false, "sh -c 'flatpak info it.mijorus.gearlever > /dev/null 2>&1'", ["sh"], null, ["it.mijorus.gearlever"]],
  [false, "flatpak --verbose info com.example.MissingIde", ["flatpak"], null, ["it.mijorus.gearlever"]],
  [false, "flatpak --installation=extra info it.mijorus.gearlever", ["flatpak"], null, ["it.mijorus.gearlever"]],
  [true, "flatpak run com.visualstudio.code", ["flatpak"], null, ["com.visualstudio.code"]],
  [true, "flatpak", ["flatpak"]],
  [false, "flatpak --installation=extra run com.visualstudio.code", ["flatpak"], null, ["com.visualstudio.code"]],
  [false, "flatpak run --command=missing-helper com.visualstudio.code", ["flatpak"], null, ["com.visualstudio.code"]],
  [false, "flatpak run --command=sh com.visualstudio.code -c 'command -v missing-helper >/dev/null 2>&1'", ["flatpak"], null, ["com.visualstudio.code"]],
  [false, "flatpak run --command=bash com.visualstudio.code -c true", ["flatpak"], null, ["com.visualstudio.code"]],
  [false, "env -i --unset=GTK_USE_PORTAL GTK_USE_PORTAL=0 flatpak run --command=sh com.visualstudio.code -c 'command -v cursor >/dev/null 2>&1'", ["env", "flatpak", "cursor"]],
];

test("open-target discovery evaluates TryExec parser", () => {
  for (const [expected, command, binNames, setup, flatpakApps] of tryExecCases) withTempDir((tmp) => {
    const quoted = JSON.stringify(command);
    const result = evaluatePatched(
      openTargetsBundle,
      tryExecEnv(tmp, { binNames, flatpakApps, setup }),
      "[codexLinuxDesktopTryExecAvailable(" + quoted + "),codexLinuxTerminalTryExecAvailable(" + quoted + ")]",
    );
    assert.deepEqual(result, [expected, expected], command);
  });
});

test("open-target discovery tolerates path and fs aliases used by helper locals", () => {
  withTempDir((tmp) => {
    const command = "env /missing/Cursor.AppImage";
    const result = evaluatePatched(
      collidingPathAliasBundle,
      tryExecEnv(tmp, { binNames: ["env"] }),
      "[codexLinuxDesktopTryExecAvailable(" + JSON.stringify(command) + "),codexLinuxTerminalTryExecAvailable(" + JSON.stringify(command) + ")]",
    );

    assert.deepEqual(result, [false, false]);
  });
});

test("open-target discovery launches desktop entries through gio when available", async () => {
  await withTempDir(async (tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const binDir = path.join(tmp, "bin");
    const gio = makeExecutable(binDir, "gio");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "workspace-agent");
    const desktopFile = path.join(appsDir, "workspace-agent.desktop");
    const projectDir = path.join(tmp, "project");
    const spawnRecorder = createSpawnRecorder();
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Workspace Agent",
        `Exec=${editorCommand} %U`,
        "Categories=Development;",
        "Comment=Coordinate coding agents across workspaces",
      ].join("\n"),
    );

    const platform = evaluatePatched(
      openTargetsBundle,
      {
        HOME: tmp,
        PATH: `${binDir}:${path.dirname(editorCommand)}`,
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: path.join(tmp, "empty"),
      },
      "Xg.find((target)=>target.platforms.linux?.label===`Workspace Agent`).platforms.linux",
      spawnRecorder,
    );

    await platform.open({ command: editorCommand, path: projectDir });

    assert.deepEqual(spawnRecorder.calls, [
      { command: gio, args: ["launch", desktopFile, projectDir] },
    ]);
  });
});

test("open-target discovery falls back to gtk-launch when gio fails", async () => {
  await withTempDir(async (tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const binDir = path.join(tmp, "bin");
    const gio = makeExecutable(binDir, "gio");
    const gtkLaunch = makeExecutable(binDir, "gtk-launch");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "workspace-agent");
    const desktopFile = path.join(appsDir, "workspace-agent.desktop");
    const projectDir = path.join(tmp, "project");
    const spawnRecorder = createSpawnRecorder({ failCommands: [gio] });
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Workspace Agent",
        `Exec=${editorCommand} %U`,
        "Categories=Development;",
        "Comment=Coordinate coding agents across workspaces",
      ].join("\n"),
    );

    const platform = evaluatePatched(
      openTargetsBundle,
      {
        HOME: tmp,
        PATH: `${binDir}:${path.dirname(editorCommand)}`,
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: path.join(tmp, "empty"),
      },
      "Xg.find((target)=>target.platforms.linux?.label===`Workspace Agent`).platforms.linux",
      spawnRecorder,
    );

    await platform.open({ command: editorCommand, path: projectDir });

    assert.deepEqual(spawnRecorder.calls, [
      { command: gio, args: ["launch", desktopFile, projectDir] },
      { command: gtkLaunch, args: ["workspace-agent", pathToFileURL(projectDir).toString()] },
    ]);
  });
});

test("open-target discovery falls back to the Exec command", async () => {
  await withTempDir(async (tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "workspace-agent");
    const desktopFile = path.join(appsDir, "workspace-agent.desktop");
    const projectDir = path.join(tmp, "project");
    const spawnRecorder = createSpawnRecorder({
      failCommands: [
        "/home/linuxbrew/.linuxbrew/bin/gio",
        "/home/linuxbrew/.linuxbrew/bin/gtk-launch",
        "/var/home/linuxbrew/.linuxbrew/bin/gio",
        "/var/home/linuxbrew/.linuxbrew/bin/gtk-launch",
      ],
    });
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Workspace Agent",
        `Exec=${editorCommand} --goto %f`,
        "Categories=Development;",
        "Comment=Coordinate coding agents across workspaces",
      ].join("\n"),
    );

    const platform = evaluatePatched(
      openTargetsBundle,
      {
        HOME: tmp,
        PATH: path.dirname(editorCommand),
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: path.join(tmp, "empty"),
      },
      "Xg.find((target)=>target.platforms.linux?.label===`Workspace Agent`).platforms.linux",
      spawnRecorder,
    );

    await platform.open({ command: editorCommand, path: projectDir });

    assert.deepEqual(spawnRecorder.calls.at(-1), { command: editorCommand, args: ["--goto", projectDir] });
  });
});

test("open-target discovery sanitizes desktop launch environment", async () => {
  await withTempDir(async (tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const binDir = path.join(tmp, "bin");
    const gio = makeExecutable(binDir, "gio");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "workspace-agent");
    const desktopFile = path.join(appsDir, "workspace-agent.desktop");
    const projectDir = path.join(tmp, "project");
    const spawnRecorder = createSpawnRecorder({ recordOptions: true });
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Workspace Agent",
        `Exec=${editorCommand} %U`,
        "Categories=Development;",
        "Comment=Coordinate coding agents across workspaces",
      ].join("\n"),
    );

    const platform = evaluatePatched(
      openTargetsBundle,
      {
        HOME: tmp,
        PATH: `${binDir}:${path.dirname(editorCommand)}`,
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: path.join(tmp, "empty"),
        LD_LIBRARY_PATH: "/codex/electron/lib",
        LD_PRELOAD: "/codex/electron/lib/libhook.so",
        CHROME_DESKTOP: "codex-open-target-launchers.desktop",
        ELECTRON_RENDERER_URL: "http://127.0.0.1:5203/",
        CODEX_ELECTRON_USER_DATA_DIR: path.join(
          tmp,
          ".local",
          "state",
          "codex-open-target-launchers",
          "electron-user-data",
        ),
        XDG_CONFIG_HOME: path.join(tmp, ".local", "state", "codex-open-target-launchers", "xdg-config"),
      },
      "Xg.find((target)=>target.platforms.linux?.label===`Workspace Agent`).platforms.linux",
      spawnRecorder,
    );

    await platform.open({ command: editorCommand, path: projectDir });

    assert.equal(spawnRecorder.calls[0].command, gio);
    assert.equal(spawnRecorder.calls[0].options.cwd, tmp);
    assert.equal(spawnRecorder.calls[0].options.env.LD_LIBRARY_PATH, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.LD_PRELOAD, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.CHROME_DESKTOP, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.ELECTRON_RENDERER_URL, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.CODEX_ELECTRON_USER_DATA_DIR, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.CODEX_LINUX_APP_ID, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.XDG_CONFIG_HOME, undefined);
  });
});

test("open-target discovery preserves user-scoped XDG_CONFIG_HOME", async () => {
  await withTempDir(async (tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const binDir = path.join(tmp, "bin");
    const gio = makeExecutable(binDir, "gio");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "workspace-agent");
    const desktopFile = path.join(appsDir, "workspace-agent.desktop");
    const projectDir = path.join(tmp, "project");
    const userConfigHome = path.join(tmp, "user-config");
    const spawnRecorder = createSpawnRecorder({ recordOptions: true });
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Workspace Agent",
        `Exec=${editorCommand} %U`,
        "Categories=Development;",
        "Comment=Coordinate coding agents across workspaces",
      ].join("\n"),
    );

    const platform = evaluatePatched(
      openTargetsBundle,
      {
        HOME: tmp,
        PATH: `${binDir}:${path.dirname(editorCommand)}`,
        XDG_CONFIG_HOME: userConfigHome,
        XDG_DATA_HOME: dataHome,
        XDG_DATA_DIRS: path.join(tmp, "empty"),
        CODEX_ELECTRON_USER_DATA_DIR: path.join(tmp, "codex-user-data"),
      },
      "Xg.find((target)=>target.platforms.linux?.label===`Workspace Agent`).platforms.linux",
      spawnRecorder,
    );

    await platform.open({ command: editorCommand, path: projectDir });

    assert.equal(spawnRecorder.calls[0].command, gio);
    assert.equal(spawnRecorder.calls[0].options.env.CODEX_ELECTRON_USER_DATA_DIR, undefined);
    assert.equal(spawnRecorder.calls[0].options.env.XDG_CONFIG_HOME, userConfigHome);
  });
});

test("open-target discovery uses desktop entry icons when available", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const iconDir = path.join(dataHome, "icons", "hicolor", "256x256", "apps");
    const editorCommand = makeExecutable(path.join(tmp, "toolbox", "bin"), "workspace-agent");
    const iconPath = path.join(iconDir, "workspace-agent.png");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
    fs.writeFileSync(iconPath, "png");
    fs.writeFileSync(
      path.join(appsDir, "workspace-agent.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Workspace Agent",
        `Exec=${editorCommand} %U`,
        "Icon=workspace-agent",
        "Categories=Development;",
        "Comment=Coordinate coding agents across workspaces",
      ].join("\n"),
    );

    const targets = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: path.join(tmp, "bin"), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[{label:platform.label,iconPath:platform.iconPath?.()}]:[]})",
    );
    const agent = targets.find((target) => target.label === "Workspace Agent");

    assert.ok(agent);
    assert.equal(agent.iconPath, iconPath);
  });
});

test("open-target discovery follows symlinked desktop entry icons", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const iconDir = path.join(dataHome, "icons", "hicolor", "128x128", "apps");
    const targetIconPath = path.join(tmp, "flatpak-app", "export", "icons", "hicolor", "128x128", "apps", "com.example.Agent.png");
    const symlinkIconPath = path.join(iconDir, "com.example.Agent.png");
    const editorCommand = makeExecutable(path.join(tmp, "flatpak", "exports", "bin"), "com.example.Agent");
    fs.mkdirSync(appsDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetIconPath), { recursive: true });
    fs.writeFileSync(targetIconPath, "png");
    fs.symlinkSync(targetIconPath, symlinkIconPath);
    fs.writeFileSync(
      path.join(appsDir, "com.example.Agent.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Flatpak Agent",
        `Exec=${editorCommand} %U`,
        "Icon=com.example.Agent",
        "Categories=Development;",
      ].join("\n"),
    );

    const targets = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: path.join(tmp, "bin"), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[{label:platform.label,iconPath:platform.iconPath?.()}]:[]})",
    );
    const agent = targets.find((target) => target.label === "Flatpak Agent");

    assert.ok(agent);
    assert.equal(agent.iconPath, symlinkIconPath);
  });
});

test("open-target discovery resolves iconPath on current upstream bundle shape", async () => {
  const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
  const iconPath = path.join(os.tmpdir(), "codex-current-open-target-icon.svg");
  fs.writeFileSync(iconPath, "<svg/>");
  let nativeImageUsed = false;
  const electron = {
    app: {
      getFileIcon: async () => {
        throw new Error("should not need getFileIcon for image files");
      },
    },
    nativeImage: {
      createFromPath: (target) => {
        nativeImageUsed = true;
        assert.equal(target, iconPath);
        return {
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,converted-svg",
        };
      },
    },
  };
  const targets = [
    {
      id: "linux-desktop-agent",
      label: "Agent",
      icon: "apps/terminal.png",
      kind: "editor",
      iconPath: () => iconPath,
    },
  ];

  assert.match(patched, /return\(e===`win32`\|\|e===`linux`\)\?Promise\.all/);
  assert.match(patched, /function codexLinuxOpenTargetIconImage/);
  const result = await new Function("require", "process", `${patched};return VN('linux', arguments[2], new Map());`)(
    (name) => (name === "electron" ? electron : require(name)),
    { platform: "linux", env: {} },
    targets,
  );

  assert.equal(nativeImageUsed, true);
  assert.equal(result[0].icon, "data:image/png;base64,converted-svg");
  fs.rmSync(iconPath, { force: true });
});

test("open-target discovery rasterizes undecodable SVG iconPath", async () => {
  const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
  const iconPath = path.join(os.tmpdir(), "codex-current-open-target-empty-svg.svg");
  const svg = "<svg><rect width=\"16\" height=\"16\" /></svg>";
  fs.writeFileSync(iconPath, svg);
  const electron = {
    app: {
      getFileIcon: async () => {
        throw new Error("should not fall back to file type icons for SVG iconPath");
      },
    },
    nativeImage: {
      createFromPath: (target) => {
        assert.equal(target, iconPath);
        return { isEmpty: () => true };
      },
    },
    BrowserWindow: class {
      webContents = {
        capturePage: async () => ({
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,rasterized-svg",
          getSize: () => ({ width: 64, height: 64 }),
        }),
      };
      async loadURL(url) {
        assert.match(url, /^data:text\/html;charset=utf-8,/);
      }
      destroy() {}
    },
  };
  const targets = [
    {
      id: "linux-desktop-agent",
      label: "Agent",
      icon: "apps/terminal.png",
      kind: "editor",
      iconPath: () => iconPath,
    },
  ];

  const result = await new Function("require", "process", `${patched};return VN('linux', arguments[2], new Map());`)(
    (name) => (name === "electron" ? electron : require(name)),
    { platform: "linux", env: {} },
    targets,
  );

  assert.equal(result[0].icon, "data:image/png;base64,rasterized-svg");
  fs.rmSync(iconPath, { force: true });
});

test("open-target discovery keeps built-in icons for Linux targets without iconPath", async () => {
  const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
  const commandPath = path.join(os.tmpdir(), "codex-current-open-target-command");
  fs.writeFileSync(commandPath, "binary");
  const electron = {
    app: {
      getFileIcon: async () => {
        throw new Error("should not inspect command paths for Linux targets without iconPath");
      },
    },
    nativeImage: {
      createFromPath: () => {
        throw new Error("should not inspect command paths for Linux targets without iconPath");
      },
    },
  };
  const targets = [
    {
      id: "webstorm",
      label: "WebStorm",
      icon: "apps/webstorm.svg",
      kind: "editor",
    },
  ];

  const result = await new Function("require", "process", `${patched};return VN('linux', arguments[2], arguments[3]);`)(
    (name) => (name === "electron" ? electron : require(name)),
    { platform: "linux", env: {} },
    targets,
    new Map([["webstorm", commandPath]]),
  );

  assert.equal(result[0].icon, "apps/webstorm.svg");
  fs.rmSync(commandPath, { force: true });
});

test("open-target discovery preserves bundled SVG fallback icons in Linux open menus", async () => {
  withTempDir(async (tmp) => {
    const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
    const electron = {
      app: {
        getFileIcon: async () => {
          throw new Error("should not inspect command paths for Linux targets without iconPath");
        },
      },
      nativeImage: {
        createFromPath: () => {
          throw new Error("should not convert bundled fallback icons");
        },
      },
    };
    const targets = [
      {
        id: "webstorm",
        label: "WebStorm",
        icon: "apps/webstorm.svg",
        kind: "editor",
      },
    ];

    const result = await new Function("require", "process", `${patched};return VN('linux', arguments[2], new Map());`)(
      (name) => (name === "electron" ? electron : require(name)),
      { platform: "linux", env: {} },
      targets,
    );

    assert.equal(result[0].icon, "apps/webstorm.svg");
  });
});

test("open-target discovery rasterizes bundled SVG fallback icons when available", async () => {
  withTempDir(async (tmp) => {
    const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
    const resourcesPath = path.join(tmp, "resources");
    const bundledIconPath = path.join(resourcesPath, "app.asar", "webview", "apps", "webstorm.svg");
    fs.mkdirSync(path.dirname(bundledIconPath), { recursive: true });
    fs.writeFileSync(bundledIconPath, "<svg><rect width=\"16\" height=\"16\" /></svg>");
    const electron = {
      app: {
        getFileIcon: async () => {
          throw new Error("should not inspect command paths for bundled fallback icons");
        },
      },
      nativeImage: {
        createFromPath: (target) => {
          assert.equal(target, bundledIconPath);
          return { isEmpty: () => true };
        },
      },
      BrowserWindow: class {
        webContents = {
          capturePage: async () => ({
            isEmpty: () => false,
            toDataURL: () => "data:image/png;base64,bundled-webstorm",
            getSize: () => ({ width: 64, height: 64 }),
          }),
        };
        async loadURL(url) {
          assert.match(url, /^data:text\/html;charset=utf-8,/);
        }
        destroy() {}
      },
    };
    const targets = [
      {
        id: "webstorm",
        label: "WebStorm",
        icon: "apps/webstorm.svg",
        kind: "editor",
      },
    ];

    const result = await new Function("require", "process", `${patched};return VN('linux', arguments[2], new Map());`)(
      (name) => (name === "electron" ? electron : require(name)),
      { platform: "linux", env: {}, resourcesPath },
      targets,
    );

    assert.equal(result[0].icon, "data:image/png;base64,bundled-webstorm");
  });
});

test("open-target discovery resolves iconPath in Linux target summaries", async () => {
  const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
  const iconPath = path.join(os.tmpdir(), "codex-current-open-target-summary-icon.png");
  fs.writeFileSync(iconPath, "summary");
  const electron = {
    app: {
      getFileIcon: async () => {
        throw new Error("should prefer direct data URL for Linux summaries");
      },
    },
    nativeImage: {
      createFromPath: () => {
        throw new Error("should not need nativeImage for PNG summaries");
      },
    },
  };
  const targets = [
    {
      id: "linux-desktop-agent",
      label: "Agent",
      icon: "apps/terminal.png",
      kind: "editor",
      iconPath: () => iconPath,
    },
  ];

  assert.match(patched, /function codexLinuxOpenTargetSummaryIcon/);
  const result = new Function("require", "process", `${patched};return HN(arguments[2]);`)(
    (name) => (name === "electron" ? electron : require(name)),
    { platform: "linux", env: {} },
    targets,
  );

  assert.equal(Array.isArray(result), true);
  assert.equal(result[0].icon, `data:image/png;base64,${Buffer.from("summary").toString("base64")}`);
  fs.rmSync(iconPath, { force: true });
});

test("open-target discovery resolves SVG iconPath in Linux target summaries", async () => {
  const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${currentIconResolverBundle}`);
  const iconPath = path.join(os.tmpdir(), "codex-current-open-target-summary-icon.svg");
  const svg = "<svg><rect width=\"16\" height=\"16\" /></svg>";
  fs.writeFileSync(iconPath, svg);
  const electron = {
    app: {
      getFileIcon: async () => {
        throw new Error("should prefer direct SVG data URL for Linux summaries");
      },
    },
    nativeImage: {
      createFromPath: () => {
        throw new Error("summary mapping should stay synchronous");
      },
    },
  };
  const targets = [
    {
      id: "linux-desktop-agent",
      label: "Agent",
      icon: "apps/terminal.png",
      kind: "editor",
      iconPath: () => iconPath,
    },
  ];

  const result = new Function("require", "process", `${patched};return HN(arguments[2]);`)(
    (name) => (name === "electron" ? electron : require(name)),
    { platform: "linux", env: {} },
    targets,
  );

  assert.equal(Array.isArray(result), true);
  assert.equal(result[0].icon, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  fs.rmSync(iconPath, { force: true });
});

test("open-target discovery patches current app command lookup through its registry", async () => {
  let workerCalls = 0;
  const settingsStore = currentAppSettingsStore([
    {
      id: "linux-desktop-agent",
      detect: async (readShortcutLink) =>
        typeof readShortcutLink === "function" && await readShortcutLink("entry") === "shortcut:entry"
          ? "main-command"
          : null,
    },
    { id: "broken", detect: async () => { throw new Error("probe failed"); } },
  ]);
  const patched = applyPatchTwice(applyOpenInTargetCommandPatch, currentAppOpenInCommandBundle);
  const app = new Function("process", `${patched};return new App(arguments[1],arguments[2]);`)(
    { platform: "linux" },
    settingsStore,
    async () => {
      workerCalls += 1;
      return { command: "worker-command" };
    },
  );

  assert.equal(await app.getOpenInTargetCommand("linux-desktop-agent"), "main-command");
  await assert.rejects(() => app.getOpenInTargetCommand("broken"), /not available/);
  assert.equal(workerCalls, 0);
  assert.match(patched, /n\.detect\(FN\)/);
  assert.doesNotMatch(patched, /n\.detect\(WRONG\)|n\.detect\(void 0\)/);

  const darwinApp = new Function("process", `${patched};return new App(arguments[1],arguments[2]);`)(
    { platform: "darwin" },
    settingsStore,
    async () => {
      workerCalls += 1;
      return { command: "worker-command" };
    },
  );
  assert.equal(await darwinApp.getOpenInTargetCommand("linux-desktop-agent"), "worker-command");
  assert.equal(workerCalls, 1);
});

test("open-target discovery patches current app availability through its registry", async () => {
  let workerCalls = 0;
  const settingsStore = currentAppSettingsStore([
    {
      id: "linux-desktop-agent",
      label: "Agent",
      icon: "apps/terminal.png",
      kind: "editor",
      detect: async (readShortcutLink) =>
        typeof readShortcutLink === "function" && await readShortcutLink("entry") === "shortcut:entry"
          ? "/usr/bin/agent"
          : null,
    },
    {
      id: "missing",
      label: "Missing",
      icon: "apps/terminal.png",
      kind: "editor",
      detect: async () => null,
    },
    {
      id: "broken",
      label: "Broken",
      icon: "apps/terminal.png",
      kind: "editor",
      detect: async () => { throw new Error("probe failed"); },
    },
  ]);
  const patched = applyPatchTwice(applyOpenInTargetsAvailabilityPatch, currentAppOpenInAvailabilityBundle);
  const result = await new Function(
    "process",
    `${patched};return WN(arguments[1],arguments[2]);`,
  )({ platform: "linux" }, settingsStore, async () => {
    workerCalls += 1;
    return { command: "worker-command" };
  });

  assert.deepEqual(result.allAvailableTargets, ["linux-desktop-agent"]);
  assert.deepEqual(result.targetMetadata.map((target) => target.id), ["linux-desktop-agent", "missing", "broken"]);
  assert.equal(workerCalls, 0);
});

test("open-target discovery patches current app bridge detection through its registry", async () => {
  let workerCalls = 0;
  const settingsStore = currentAppSettingsStore([
    {
      id: "linux-desktop-agent",
      detect: async (readShortcutLink) =>
        typeof readShortcutLink === "function" && await readShortcutLink("entry") === "shortcut:entry"
          ? "main-command"
          : null,
    },
    { id: "missing", detect: async () => null },
    { id: "broken", detect: async () => { throw new Error("probe failed"); } },
  ]);
  const patched = applyPatchTwice(applyOpenInTargetsBridgeDetectionPatch, currentAppOpenInBridgeBundle);
  const app = new Function("process", `${patched};return new App(arguments[1],arguments[2]);`)(
    { platform: "linux" },
    settingsStore,
    async () => {
      workerCalls += 1;
      return { command: "worker-command" };
    },
  );

  assert.deepEqual(await app.detectTarget({ target: "linux-desktop-agent" }), { available: true });
  assert.deepEqual(await app.detectTarget({ target: "missing" }), { available: false });
  assert.deepEqual(await app.detectTarget({ target: "broken" }), { available: false });
  assert.equal(workerCalls, 0);
  assert.match(patched, /if\(process\.platform===`linux`\)\{let t=await codexLinuxOpenTargetRegistryCommand/);
});

test("open-target discovery inserts shared Linux registry command helper", async () => {
  const patched = applyPatchTwice(applyOpenInTargetRegistryCommandPatch, currentAppOpenTargetPrelude);
  const settingsStore = currentAppSettingsStore([
    {
      id: "kate",
      detect: async (readShortcutLink) => await readShortcutLink("kate") === "shortcut:kate" ? "/usr/bin/kate" : null,
    },
  ]);
  const command = await new Function(
    "process",
    `${patched};return codexLinuxOpenTargetRegistryCommand(arguments[1], 'kate');`,
  )({ platform: "linux" }, settingsStore);

  assert.match(patched, /async function codexLinuxOpenTargetRegistryCommand/);
  assert.match(patched, /n\.detect\(FN\)/);
  assert.equal(command, "/usr/bin/kate");
});

test("open-target discovery inserts registry helper in the registry module scope", async () => {
  const source =
    `function codexLinuxPatchExternalOpen(){async function __codexOpenExternal(){}}` +
    currentAppOpenTargetPrelude;
  const patched = applyPatchTwice(applyOpenInTargetRegistryCommandPatch, source);
  const settingsStore = currentAppSettingsStore([
    {
      id: "kate",
      detect: async () => "/usr/bin/kate",
    },
  ]);
  const command = await new Function(
    "process",
    `${patched};return codexLinuxOpenTargetRegistryCommand(arguments[1], 'kate');`,
  )({ platform: "linux" }, settingsStore);

  assert.match(
    patched,
    /async function codexLinuxOpenTargetRegistryCommand[\s\S]*?function QN\(e\)/,
  );
  assert.equal(command, "/usr/bin/kate");
});

test("open-target discovery reports missing current registry once per main patch", () => {
  const source =
    mainBundlePrefix +
    currentAppOpenInAvailabilityBundle.replace(currentAppRegistryFunction, "");
  const { warnings } = captureWarns(() => applyMainBundlePatch(source));

  assert.equal(warnings.filter((warning) => warning.includes("Could not find open target registry")).length, 1);
});

test("open-target discovery patches current app directory mode expression", () => {
  const patched = applyPatchTwice(applyOpenInTargetsDirectoryModePatch, currentAppOpenInTargetsBundle);

  assert.match(patched, /codexLinuxOpenTargetIsDirectory/);
  assert.match(patched, /f!=null&&codexLinuxOpenTargetIsDirectory\(f\)/);
  assert.match(patched, /g=d\|\|[^,]+\|\|f!=null&&n\.ys\(f\)/);
});

test("open-target discovery native selector includes available directory-capable targets", () => {
  const patched = applyPatchTwice(applyNativeOpenTargetSelectionPatch, currentAppOpenTargetSelectionBundle);
  const { selectTargets } = new Function(`${patched};return {selectTargets:lQ};`)();
  const targets = [
    { target: "fileManager", appPath: "/usr/bin/dolphin" },
    { target: "systemDefault", appPath: "/usr/share/applications/kate.desktop" },
    { target: "terminal", available: true, kind: "terminal" },
    { target: "vscode", available: true, kind: "editor" },
    { target: "linux-desktop-kate", available: true, kind: "editor" },
    { target: "linux-desktop-hidden", available: false, kind: "editor" },
  ];

  assert.deepEqual(
    selectTargets({
      targets,
      availableTargets: targets.map((target) => target.target),
      mode: "native",
    }).map((target) => target.target),
    ["fileManager", "systemDefault", "terminal", "vscode", "linux-desktop-kate"],
  );
});

test("open-target discovery respects hidden desktop entry overrides", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "user-share");
    const userAppsDir = path.join(dataHome, "applications");
    const systemShare = path.join(tmp, "system-share");
    const systemAppsDir = path.join(systemShare, "applications");
    const electronCommand = makeExecutable(path.join(tmp, "bin"), "electron37");
    fs.mkdirSync(userAppsDir, { recursive: true });
    fs.mkdirSync(systemAppsDir, { recursive: true });
    fs.writeFileSync(path.join(userAppsDir, "electron37.desktop"), "[Desktop Entry]\nHidden=true\n");
    fs.writeFileSync(
      path.join(systemAppsDir, "electron37.desktop"),
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Electron 37",
        `Exec=${electronCommand} %u`,
        "Categories=Development;GTK;",
      ].join("\n"),
    );

    const targets = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: path.join(tmp, "bin"), XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: systemShare },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[platform.label]:[]})",
    );

    assert.equal(targets.includes("Electron 37"), false);
  });
});

test("open-target discovery filters broad non-IDE desktop entries", () => {
  withTempDir((tmp) => {
    const dataHome = path.join(tmp, "share");
    const appsDir = path.join(dataHome, "applications");
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(appsDir, { recursive: true });

    const entries = [
      ["typora", "Typora", "Markdown Editor", "Office;WordProcessor;"],
      ["onlyoffice", "ONLYOFFICE", "Document Editor", "Office;WordProcessor;Spreadsheet;Presentation;"],
      ["gedit", "gedit", "Text Editor", "GNOME;GTK;Utility;TextEditor;"],
      ["kdenlive", "Kdenlive", "Video Editor", "Qt;KDE;AudioVideo;AudioVideoEditing;"],
      ["pinta", "Pinta", "Image Editor", "Graphics;2DGraphics;RasterGraphics;GTK;"],
      ["electron37", "Electron 37", "", "Development;GTK;"],
      ["cmake-gui", "CMake", "Cross-platform buildsystem", "Development;Building;"],
      ["codex-desktop", "ChatGPT", "Run ChatGPT Desktop on Linux", "Development;"],
      ["codex-monitor", "Codex Monitor", "Orchestrate Codex agents across local workspaces", "Development;"],
      ["stably-orca", "Orca", "Agentic Coding IDE", "Development;IDE;TextEditor;"],
    ];

    for (const [id, name, genericName, categories] of entries) {
      makeExecutable(binDir, id);
      fs.writeFileSync(
        path.join(appsDir, `${id}.desktop`),
        [
          "[Desktop Entry]",
          "Type=Application",
          `Name=${name}`,
          genericName ? `GenericName=${genericName}` : "",
          `Exec=${path.join(binDir, id)} %U`,
          `Categories=${categories}`,
        ].filter(Boolean).join("\n"),
      );
    }

    const targets = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: binDir, XDG_DATA_HOME: dataHome, XDG_DATA_DIRS: path.join(tmp, "empty") },
      "Xg.flatMap((target)=>{let platform=target.platforms.linux;return platform?[platform.label]:[]})",
    );

    assert.deepEqual(targets.filter((label) => entries.map((entry) => entry[1]).includes(label)), [
      "Codex Monitor",
      "Orca",
    ]);
  });
});

test("open-target discovery upgrades the baseline file manager target", async () => {
  await withTempDir(async (tmp) => {
    const binDir = path.join(tmp, "bin");
    const dolphin = makeExecutable(binDir, "dolphin");
    const file = path.join(tmp, "project", "src", "main.rs");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    const spawnRecorder = createSpawnRecorder();
    const fileManager = evaluatePatched(
      openTargetsBundle,
      { HOME: tmp, PATH: binDir },
      "lu.platforms?.linux??lu.linux",
      spawnRecorder,
    );

    assert.equal(fileManager.detect(), dolphin);
    await fileManager.open({ path: file });
    assert.deepEqual(spawnRecorder.calls, [{ command: dolphin, args: ["--select", file] }]);
  });
});

test("open-target discovery stays disabled until listed in features.json", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);

    withLinuxFeatureRootEnv(root, () => {
      const patched = captureWarns(() => patchMainBundleSource(openTargetsBundle, null)).value;
      assert.doesNotMatch(patched, /linux:\{label:`Terminal`/);
      assert.doesNotMatch(patched, /\.\.\.codexLinuxDiscoveredIdeTargets\(\)/);
      assert.doesNotMatch(patched, /codexLinuxOpenFileManager\(e\)/);
    });
  });
});

test("open-target discovery targets only the current native selector bundle", () => {
  const descriptor = descriptors.find(
    (candidate) => candidate.id === "webview-native-open-target-selection",
  );

  assert.ok(descriptor);
  assert.match(
    "app-initial~artifact-tab-content.electron~notebook-preview-panel~app-main~pull-request-rout~ns5rw1zk-CI7AKGww.js",
    descriptor.pattern,
  );
  assert.doesNotMatch(
    "app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~gwqc41kz-CnQKtQ6U.js",
    descriptor.pattern,
  );
  assert.doesNotMatch(
    "app-initial~app-main~quick-chat-window-page~work-home-page~chatgpt-conversation-page-BqLP6EDd.js",
    descriptor.pattern,
  );
  assert.doesNotMatch(
    "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-MXsOJYYa.js",
    descriptor.pattern,
  );
  assert.doesNotMatch(
    "app-initial~app-main~new-thread-panel-page~onboarding-page~appgen-library-page~hotkey-windo~nrw3o0ql-CI1_Z0oj.js",
    descriptor.pattern,
  );
  assert.doesNotMatch("open-target-selection-legacy.js", descriptor.pattern);
  assert.doesNotMatch(
    "app-initial~app-main~pull-request-code-review~onboarding-page~hotkey-window-thread-page~cha~b76hmflu-y0KJWbm3.js",
    descriptor.pattern,
  );
});

test("open-target discovery participates in feature loading and patch reports", () => {
  withTempFeatureConfig(["open-target-discovery"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["open-target-discovery"]);
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot: root })
        .filter((patch) => patch.phase === "main-bundle").length,
      1,
    );

    withLinuxFeatureRootEnv(root, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-open-target-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), openTargetsBundle);
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));

        const report = createPatchReport();
        captureWarns(() => patchExtractedApp(tempApp, { report }));
        const patched = fs.readFileSync(path.join(buildDir, "main.js"), "utf8");

        assert.match(patched, /linux:\{label:`Terminal`/);
        assert.match(patched, /\.\.\.codexLinuxDiscoveredIdeTargets\(\)/);
        assert.ok(
          report.patches.some((patch) =>
            patch.name === "feature:open-target-discovery:main-bundle-open-target-discovery" &&
            patch.status === "applied",
          ),
        );
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});

test("open-target discovery does not add a second built-in Zed target", () => {
  const zedAlreadyLinux = openTargetsBundle.replace(
    "win32:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Kg,args:hg}}",
    "win32:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Kg,args:hg},linux:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Gg,args:hg}}",
  );
  const patched = applyPatchTwice(applyMainBundlePatch, zedAlreadyLinux);

  assert.equal((patched.match(/linux:\{label:`Zed`/g) || []).length, 1);
});
