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

test("workspace root dropdown adds Linux open targets alongside File Manager", () => {
  const mainSource = [
    "function codexLinuxIdeCommand(){}",
    "var lM={id:`vscode`};",
    "var iN={id:`vscodeInsiders`};",
    "var wN={id:`zed`,platforms:{linux:{label:`Zed`}}};",
    "var Hj={id:`terminal`,platforms:{linux:{label:`Terminal`}}};",
  ].join("");
  const source = [
    "function WorkspaceRootMenu(){",
    "let t=[],a=()=>{},v=`/tmp/project`,S=Zt(`open-file`),C;",
    "t[7]!==v||t[8]!==a||t[9]!==S?",
    "(C=()=>{if(v==null)return;let e=lr(v);El({path:v,cwd:e,target:`fileManager`,openFile:S.mutate}),a(!1)},t[7]=v,t[8]=a,t[9]=S,t[10]=C):C=t[10];",
    "let T;t[11]!==C?(T=(0,Z.jsx)(uv.Item,{LeftIcon:iy,onSelect:C,children:`File Manager`}),t[11]=C,t[12]=T):T=t[12];",
    "return (0,Z.jsxs)(Z.Fragment,{children:[T]})",
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
  assert.equal(applyWorkspaceRootOpenTargetsPatch(patched, targets), patched);
});

test("workspace root dropdown patches every File Manager item in a shared chunk", () => {
  const targets = [
    { id: "vscode", label: "VS Code" },
    { id: "zed", label: "Zed" },
  ];
  const source = [
    "function FirstWorkspaceRootMenu(){",
    "let a=()=>{},v=`/tmp/one`,S=Zt(`open-file`),C,T;",
    "C=()=>{if(v==null)return;let e=lr(v);El({path:v,cwd:e,target:`fileManager`,openFile:S.mutate}),a(!1)};",
    "T=(0,Z.jsx)(uv.Item,{LeftIcon:iy,onSelect:C,children:`File Manager`});",
    "return T",
    "}",
    "function SecondWorkspaceRootMenu(){",
    "let b=()=>{},p=`/tmp/two`,M=Qt(`open-file`),D,U;",
    "D=()=>{if(p==null)return;let c=lr(p);Op({path:p,cwd:c,target:`fileManager`,openFile:M.mutate}),b(!1)};",
    "U=(0,Z.jsx)(uv.Item,{LeftIcon:iy,onSelect:D,children:`File Manager`});",
    "return U",
    "}",
  ].join("");

  const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);

  assert.notEqual(patched, source);
  assert.equal((patched.match(/codexLinuxWorkspaceRootOpenTarget:vscode/g) ?? []).length, 2);
  assert.equal((patched.match(/codexLinuxWorkspaceRootOpenTarget:zed/g) ?? []).length, 2);
  assert.equal((patched.match(/target:`vscode`/g) ?? []).length, 2);
  assert.equal((patched.match(/target:`zed`/g) ?? []).length, 2);
  assert.equal((patched.match(/target:`fileManager`/g) ?? []).length, 2);
  assert.equal(applyWorkspaceRootOpenTargetsPatch(patched, targets), patched);
});

test("workspace root dropdown follows aliased File Manager callbacks", () => {
  const targets = [
    { id: "vscode", label: "VS Code" },
    { id: "zed", label: "Zed" },
    { id: "terminal", label: "Terminal" },
  ];
  const source = [
    "function CurrentWorkspaceMenu(){",
    "let _=`/tmp/project`,a=()=>{},x=A(`open-file`),C,w,E;",
    "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`,openFile:x.mutate}),a(!1)};",
    "w=C;",
    "E=_==null?null:(0,$.jsx)(di.Item,{LeftIcon:em,onSelect:w,children:(0,$.jsx)(Gh,{platform:m})});",
    "return (0,$.jsxs)($.Fragment,{children:[E]})",
    "}",
  ].join("");

  const patched = applyWorkspaceRootOpenTargetsPatch(source, targets);

  assert.notEqual(patched, source);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:vscode/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:zed/);
  assert.match(patched, /codexLinuxWorkspaceRootOpenTarget:terminal/);
  assert.match(patched, /onSelect:\(\)=>\{Ta\(\{path:_,cwd:e,target:`vscode`,openFile:x\.mutate\}\),a\(!1\)\}/);
  assert.match(patched, /target:`fileManager`,openFile:x\.mutate/);
  assert.match(patched, /\(0,\$\.jsx\)\(di\.Item,\{LeftIcon:em,onSelect:w/);
  assert.equal(applyWorkspaceRootOpenTargetsPatch(patched, targets), patched);
});

test("workspace root open targets patch scans current shared app main project chunks", () => {
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
    const sharedChunkName = "app-initial~app-main~projects-index-page~remote-conversation-page-current.js";
    fs.writeFileSync(
      path.join(assetsDir, sharedChunkName),
      [
        "function CurrentWorkspaceMenu(){",
        "let _=`/tmp/project`,a=()=>{},x=A(`open-file`),C,w,E;",
        "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`,openFile:x.mutate}),a(!1)};",
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
      path.join(assetsDir, "app-main-current.js"),
      [
        "function CurrentWorkspaceMenu(){",
        "let _=`/tmp/project`,a=()=>{},x=A(`open-file`),C,E;",
        "C=()=>{if(_==null)return;let e=S(_);Ta({path:_,cwd:e,target:`fileManager`,openFile:x.mutate}),a(!1)};",
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
      path.join(assetsDir, "app-main-current.js"),
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
