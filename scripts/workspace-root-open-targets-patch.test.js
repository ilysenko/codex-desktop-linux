#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const workspaceRootOpenTargetsPatch = require("./patches/core/all-linux/extracted-app/workspace-root-open-targets/patch.js");
const {
  apply: patchWorkspaceRootOpenTargets,
  applyWorkspaceRootOpenTargetsPatch,
  enabledWorkspaceRootTargets,
} = workspaceRootOpenTargetsPatch;

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { result: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

test("current workspace root dropdown adds Linux open targets alongside File Manager", () => {
  const mainSource = [
    "function codexLinuxIdeCommand(){}",
    "var lM={id:`vscode`};",
    "var iN={id:`vscodeInsiders`};",
    "var wN={id:`zed`,platforms:{linux:{label:`Zed`}}};",
    "var Hj={id:`terminal`,platforms:{linux:{label:`Terminal`}}};",
  ].join("");
  const source = [
    "function CurrentWorkspaceMenu(){",
    "let _=`/tmp/project`,a=()=>{},C,w,E;",
    "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`}),a(!1)};",
    "w=C;",
    "E=_==null?null:(0,$.jsx)(di.Item,{LeftIcon:em,onSelect:w,children:(0,$.jsx)(Gh,{platform:m})});",
    "return (0,$.jsxs)($.Fragment,{children:[E]})",
    "}",
  ].join("");

  const targets = enabledWorkspaceRootTargets(mainSource);
  const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);

  assert.deepEqual(targets, [
    { id: "vscode", label: "VS Code" },
    { id: "vscodeInsiders", label: "VS Code Insiders" },
    { id: "zed", label: "Zed" },
    { id: "terminal", label: "Terminal" },
  ]);
  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscode/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscodeInsiders/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:zed/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:terminal/);
  assert.match(patched, /target:`vscode`/);
  assert.match(patched, /target:`vscodeInsiders`/);
  assert.match(patched, /target:`zed`/);
  assert.match(patched, /target:`terminal`/);
  assert.match(patched, /target:`fileManager`/);
  assert.match(patched, /onSelect:\(\)=>\{Ta\(\{path:_,cwd:e,target:`vscode`\}\),a\(!1\)\}/);
  assert.match(patched, /path:_,cwd:e,target:`fileManager`/);
  assert.match(patched, /\(0,\$\.jsx\)\(di\.Item,\{LeftIcon:em,onSelect:w/);
  assert.equal(applyWorkspaceRootOpenTargetsPatch(patched, targets), patched);
});

test("workspace root open targets patch scans the current app page chunk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-root-open-targets-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        "function codexLinuxIdeCommand(){}",
        "var lM={id:`vscode`};",
        "var iN={id:`vscodeInsiders`};",
        "var wN={id:`zed`,platforms:{linux:{label:`Zed`}}};",
        "var Hj={id:`terminal`,platforms:{linux:{label:`Terminal`}}};",
      ].join(""),
    );
    fs.writeFileSync(
      path.join(assetsDir, "app-main-current.js"),
      "function decoy(){return{target:`fileManager`}}",
    );
    const sharedChunkName =
      "app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~current.js";
    fs.writeFileSync(
      path.join(assetsDir, sharedChunkName),
      [
        "function CurrentWorkspaceMenu(){",
        "let _=`/tmp/project`,a=()=>{},C,w,E;",
        "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`}),a(!1)};",
        "w=C;",
        "E=_==null?null:(0,$.jsx)(di.Item,{LeftIcon:em,onSelect:w,children:(0,$.jsx)(Gh,{platform:m})});",
        "return (0,$.jsxs)($.Fragment,{children:[E]})",
        "}",
      ].join(""),
    );

    const first = captureWarnings(() => patchWorkspaceRootOpenTargets(root));
    const patched = fs.readFileSync(path.join(assetsDir, sharedChunkName), "utf8");

    assert.equal(first.result.changed, 1);
    assert.deepEqual(first.warnings, []);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscode/);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscodeInsiders/);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:zed/);
    assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:terminal/);

    const second = captureWarnings(() => patchWorkspaceRootOpenTargets(root));
    assert.equal(second.result.changed, 0);
    assert.deepEqual(second.warnings, []);
    assert.equal(workspaceRootOpenTargetsPatch.status(second.result, second.warnings), "already-applied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace root open targets patch is not applicable without Linux targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-root-open-targets-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "main.js"), "var lM={id:`vscode`};");
    fs.writeFileSync(
      path.join(
        assetsDir,
        "app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~current.js",
      ),
      [
        "function CurrentWorkspaceMenu(){",
        "let _=`/tmp/project`,a=()=>{},C,E;",
        "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`}),a(!1)};",
        "E=(0,$.jsx)(di.Item,{LeftIcon:em,onSelect:C,children:`File Manager`});",
        "return E",
        "}",
      ].join(""),
    );

    const result = patchWorkspaceRootOpenTargets(root);

    assert.deepEqual(result, {
      matched: 0,
      changed: 0,
      status: "skipped-target",
      reason: "No Linux editor or terminal open targets are enabled",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace root open targets patch reports optional drift when Linux targets are enabled but the File Manager chunk is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-root-open-targets-"));
  try {
    const buildDir = path.join(root, ".vite", "build");
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      [
        "function codexLinuxIdeCommand(){}",
        "var lM={id:`vscode`};",
        "var wN={id:`zed`,platforms:{linux:{label:`Zed`}}};",
      ].join(""),
    );
    fs.writeFileSync(
      path.join(
        assetsDir,
        "app-initial~notebook-preview-panel~app-main~pull-request-route~projects-index-page~cloud-en~current.js",
      ),
      [
        "function CurrentWorkspaceMenu(){",
        "let _=`/tmp/project`,a=()=>{},x=A(`open-file`);",
        "return (0,$.jsx)(di.Item,{onSelect:a,children:`Project`})",
        "}",
      ].join(""),
    );

    const result = patchWorkspaceRootOpenTargets(root);
    const expectedReason = "Workspace-root File Manager open action is not present in this upstream build";

    assert.deepEqual(result, {
      matched: 0,
      changed: 0,
      status: "skipped-optional",
      reason: expectedReason,
    });
    assert.deepEqual(workspaceRootOpenTargetsPatch.status(result, []), {
      status: "skipped-optional",
      reason: expectedReason,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
