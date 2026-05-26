#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { applyMainBundlePatch } = require("./patch.js");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeatureMainBundlePatches,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  patchExtractedApp,
  patchMainBundleSource,
} = require("../../scripts/patch-linux-window-ui.js");

const mainBundlePrefix =
  "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`),u=require(`node:child_process`);";
const fileManagerBundle =
  "function jl(e){return e}function il(e){return [e]}var lu=jl({id:`fileManager`,label:`Finder`,icon:`apps/finder.png`,kind:`fileManager`,darwin:{detect:()=>`open`,args:e=>il(e)},win32:{label:`File Explorer`,icon:`apps/file-explorer.png`,detect:uu,args:e=>il(e),open:async({path:e})=>du(e)}});function uu(){}";
const terminalOpenTargetBundle =
  "var uh={id:`terminal`,platforms:{darwin:{label:`Terminal`,icon:`apps/terminal.png`,kind:`terminal`,detect:()=>`open`,args:e=>[`-a`,`Terminal`,e]},win32:{label:`Terminal`,icon:`apps/microsoft-terminal.png`,kind:`terminal`,detect:vh,iconPath:()=>null,args:yh,open:({command:e,path:t})=>bh(e,yh(t))}}};function vh(){return `wt.exe`}function yh(e){return[`-d`,e]}async function bh(){}";
const ideOpenTargetsBundle =
  "function ih({id:e,label:t,icon:n,darwinDetect:r,win32Detect:i,darwinEnv:a,darwinArgs:o,hidden:s}){return{id:e,platforms:{darwin:r?{label:t,icon:n,kind:`editor`,hidden:s,detect:r,env:a,args:o??ah,supportsSsh:!0}:void 0,win32:i?{label:t,icon:n,kind:`editor`,hidden:s,detect:i,args:ah,supportsSsh:!0}:void 0}}}var ah=(e,t)=>t?[`${e}:${t.line}:${t.column}`]:[e];var Og=ih({id:`vscode`,label:`VS Code`,icon:`apps/vscode.png`,darwinDetect:()=>`open`,win32Detect:()=>`Code.exe`});var jh=ih({id:`cursor`,label:`Cursor`,icon:`apps/cursor.png`,darwinDetect:()=>`open`,win32Detect:()=>`Cursor.exe`});function sg({id:e,label:t,icon:n,toolboxTarget:r,macExecutable:i,windowsPathCommands:a,windowsInstallDirPrefixes:o,windowsInstallExecutables:s}){return{id:e,platforms:{darwin:{label:t,icon:n,kind:`editor`,detect:()=>`open`,args:mg},win32:a&&o&&s?{label:t,icon:n,kind:`editor`,detect:()=>`idea.exe`,args:mg}:void 0}}}function mg(e,t){return t?[`--line`,t.line.toString(),`--column`,t.column.toString(),e]:[e]}var $h=sg({id:`intellij`,label:`IntelliJ IDEA`,icon:`apps/intellij.png`,toolboxTarget:`intellij`,macExecutable:`idea`,windowsPathCommands:[`idea`],windowsInstallDirPrefixes:[`idea`],windowsInstallExecutables:[`idea`]});var Wg={id:`zed`,platforms:{darwin:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Gg,args:hg},win32:{label:`Zed`,icon:`apps/zed.png`,kind:`editor`,detect:Kg,args:hg}}};function Gg(){}function Kg(){}function hg(e,t){return t?[`${e}:${t.line}:${t.column}`]:[e]}var Xg=[Og,jh,Wg,$h];";
const openTargetsBundle = `${mainBundlePrefix}${fileManagerBundle}${terminalOpenTargetBundle}${ideOpenTargetsBundle}`;
const iconResolverBundle =
  "async function c_(e,t,a){return e===`win32`?Promise.all(t.map(async e=>{let t=a?.get(e.id)??null,r=e.iconPath?e.iconPath(t):t;return{id:e.id,label:e.label,icon:await d_(r,e.icon),kind:e.kind,hidden:e.hidden,supportsSsh:e.supportsSsh}})):l_(t)}function l_(e){return e.map(({id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a})=>({id:e,label:t,icon:n,kind:r,hidden:i,supportsSsh:a}))}async function d_(e,t){if(!e)return t;try{let r=e.toLowerCase().endsWith(`.lnk`)?await f_(e):await n.app.getFileIcon(e,{size:`normal`});return!r||r.isEmpty()?t:r.toDataURL()}catch(e){return t}}async function f_(e){return n.nativeImage.createFromPath(e)}";

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
  [true, "sh -c 'exec /bin/true && false'", ["sh"]],
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
    const spawnRecorder = createSpawnRecorder();
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

    assert.deepEqual(spawnRecorder.calls, [
      { command: editorCommand, args: ["--goto", projectDir] },
    ]);
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

test("open-target discovery resolves iconPath on Linux", async () => {
  const patched = applyPatchTwice(applyMainBundlePatch, `${mainBundlePrefix}${iconResolverBundle}`);
  const iconPath = "/tmp/codex-icon.png";
  const image = {
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,codex",
  };
  const electron = {
    app: {
      getFileIcon: async () => {
        throw new Error("should prefer nativeImage for image files");
      },
    },
    nativeImage: {
      createFromPath: (target) => {
        assert.equal(target, iconPath);
        return image;
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
  const result = await new Function("require", "process", `${patched};return c_('linux', arguments[2], new Map());`)(
    (name) => (name === "electron" ? electron : require(name)),
    { platform: "linux", env: {} },
    targets,
  );

  assert.equal(result[0].icon, "data:image/png;base64,codex");
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
      ["codex-desktop", "Codex Desktop", "Run Codex Desktop on Linux", "Development;"],
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
    assert.deepEqual(loadLinuxFeatureMainBundlePatches({ featuresRoot: root }), []);

    withLinuxFeatureRootEnv(root, () => {
      const patched = captureWarns(() => patchMainBundleSource(openTargetsBundle, null)).value;
      assert.doesNotMatch(patched, /linux:\{label:`Terminal`/);
      assert.doesNotMatch(patched, /\.\.\.codexLinuxDiscoveredIdeTargets\(\)/);
      assert.doesNotMatch(patched, /codexLinuxOpenFileManager\(e\)/);
    });
  });
});

test("open-target discovery participates in feature loading and patch reports", () => {
  withTempFeatureConfig(["open-target-discovery"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["open-target-discovery"]);
    assert.equal(loadLinuxFeatureMainBundlePatches({ featuresRoot: root }).length, 1);

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
          report.patches.some((patch) => patch.name === "feature:open-target-discovery" && patch.status === "applied"),
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
