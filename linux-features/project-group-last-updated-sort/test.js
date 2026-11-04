#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { applyWebviewAssetPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  applyProjectGroupLastUpdatedSortPatch,
  descriptors,
} = require("./patch.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

// Current signed 26.1029.61003 shape: both sidebar sorters are compiled as
// inline function expressions in the same declaration list.
const projectOrderFunction = "function(e,t){let n=new Set(e.map(e=>e.projectId)),r=(t??[]).filter(e=>n.has(e)),i=new Set(r),o=[...e.map(e=>e.projectId).filter(e=>!i.has(e)),...r],s=new Map(o.map((e,t)=>[e,t]));return[...e].sort((e,t)=>(s.get(e.projectId)??2**53-1)-(s.get(t.projectId)??2**53-1))}";
const sidebarSource = (sorter) => [
  "let{chatSortMode:X,projectSortMode:Q}=t(f.by),Z=new Map,J=e=>recency(e),",
  "{pinnedGroups:el,unpinnedGroups:eu}=(0,y.Cy)(ea,er),ed=q({groups:el,items:V}),",
  sorter,
  ",ep=function({explicitChatThreadKeys:e,getRecencyAt:t,items:n,projectGroups:r,projectlessThreadIds:i}){let o=new Set(r.flatMap(e=>e.threadKeys));return n.filter(e=>!o.has(e.key)).map(e=>e.key)}",
  "({explicitChatThreadKeys:es,getRecencyAt:J,items:V,projectGroups:ea,projectlessThreadIds:new Set(en??[])});",
].join("");
const currentProjectSource = sidebarSource(
  "ec=function({groups:e,projectOrder:t}){return(0,a.n)(e,t)}({groups:q({groups:eu,items:V}),projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER)})",
);
const officialLinuxProjectSource = sidebarSource(
  "ec=function({groups:e,projectOrder:t}){return A6i(e,t)}({groups:q({groups:eu,items:V}),projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER)})",
);
const chunk = (body) => "export const __rspack_esm_id=24191;export const __rspack_esm_ids=[24191];" +
  `export const __webpack_modules__={uSdb(e,t,n){var a=n("PORD");function U(e,t){${body}return ec}n.d(t,{U:()=>U})}};`;

function captureWarns(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function applyPatchTwice(source) {
  const patched = applyProjectGroupLastUpdatedSortPatch(source);
  const { value: secondPass, warnings } = captureWarns(() =>
    applyProjectGroupLastUpdatedSortPatch(patched),
  );
  assert.equal(secondPass, patched);
  assert.deepEqual(warnings, []);
  return patched;
}

function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "project-group-last-updated-sort-"),
  );
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return fn();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// Evaluates the (patched) inline project-group sorter function expression.
function evaluateGroupSorter(source) {
  const start = source.indexOf("ec=function(") + "ec=".length;
  const close = findMatchingBrace(source, source.indexOf("{", source.indexOf(")", start)));
  return vm.runInNewContext(`var a={n:${projectOrderFunction}};(${source.slice(start, close + 1)})`);
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
        (descriptor) =>
          descriptor.id ===
          "feature:project-group-last-updated-sort:last-updated-project-groups",
      ),
      false,
    );
  });
  withFeatureConfig(["project-group-last-updated-sort"], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
        (descriptor) =>
          descriptor.id ===
          "feature:project-group-last-updated-sort:last-updated-project-groups",
      ),
      true,
    );
  });
});

test("Last updated sorts project groups by their newest task", () => {
  const patched = applyPatchTwice(currentProjectSource);
  const sortProjectGroups = evaluateGroupSorter(patched);
  const groups = [
    { projectId: "nix", threadKeys: ["nix-task"] },
    { projectId: "delta", threadKeys: ["delta-task"] },
    { projectId: "multi", threadKeys: ["multi-task"] },
    { projectId: "chezmoi", threadKeys: ["chezmoi-task"] },
    { projectId: "tapas", threadKeys: ["tapas-task"] },
  ];
  const items = [
    { key: "nix-task", recencyAt: 1 },
    { key: "delta-task", recencyAt: 2 },
    { key: "multi-task", recencyAt: 3 },
    { key: "chezmoi-task", recencyAt: 4 },
    { key: "tapas-task", recencyAt: 5 },
  ];
  const projectOrder = ["nix", "delta", "multi", "chezmoi", "tapas"];

  assert.deepEqual(
    Array.from(
      sortProjectGroups({ groups, getRecencyAt: key => items.find(item => item.key === key)?.recencyAt, projectOrder, sortMode: "updated_at" }),
      (group) => group.projectId,
    ),
    ["tapas", "chezmoi", "multi", "delta", "nix"],
  );
});

test("non-updated modes preserve the upstream saved project order", () => {
  const patched = applyPatchTwice(currentProjectSource);
  const sortProjectGroups = evaluateGroupSorter(patched);
  const groups = [
    { projectId: "newer", threadKeys: ["newer-task"] },
    { projectId: "older", threadKeys: ["older-task"] },
  ];
  const items = [
    { key: "newer-task", recencyAt: 2 },
    { key: "older-task", recencyAt: 1 },
  ];
  const projectOrder = ["older", "newer"];

  for (const sortMode of ["manual", "priority"]) {
    assert.deepEqual(
      Array.from(
        sortProjectGroups({ groups, getRecencyAt: key => items.find(item => item.key === key)?.recencyAt, projectOrder, sortMode }),
        (group) => group.projectId,
      ),
      ["older", "newer"],
    );
  }
});

test("current sidebar references use upstream recency without task objects", () => {
  const sort = evaluateGroupSorter(applyPatchTwice(currentProjectSource));
  const groups = [
    { projectId: "old", threadKeys: ["old", "missing"] },
    { projectId: "new", threadKeys: ["new"] },
    { projectId: "empty", threadKeys: [], projectUpdatedAt: 5 },
  ];
  const timestamps = new Map([["old", 1], ["new", 9]]);
  const sorted = sort({ groups, getRecencyAt: key => timestamps.get(key), sortMode: "updated_at" });
  assert.deepEqual(Array.from(sorted, group => group.projectId), ["new", "empty", "old"]);
  assert.equal(sorted[0], groups[1]);
  assert.deepEqual(groups.map(group => group.projectId), ["old", "new", "empty"]);
});

test("missing or mismatched recency contract fails closed", () => {
  for (const source of [
    currentProjectSource.replace("getRecencyAt:J", "unknown:J"),
    currentProjectSource.replace("getRecencyAt:J,items:V", "getRecencyAt:J,items:other"),
  ]) {
    const { value, warnings } = captureWarns(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("patch passes the selected project sort mode into the group sorter", () => {
  const patched = applyPatchTwice(currentProjectSource);
  assert.ok(
    patched.includes(
      "projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER),getRecencyAt:J,sortMode:Q})",
    ),
  );
});

test("patch matches the current official project sorter semantically", () => {
  const patched = applyPatchTwice(officialLinuxProjectSource);

  assert.match(
    patched,
    /ec=function\(\{groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode\}\)\{if\(codexLinuxProjectSortMode!=="updated_at"\)return A6i\(e,n\);/,
  );
  assert.match(
    patched,
    /\}\(\{groups:q\(\{groups:eu,items:V\}\),projectOrder:\(0,o\.F6\)\(t,i\.Q2Y\.PROJECT_ORDER\),getRecencyAt:J,sortMode:Q\}\),ep=function/,
  );
});

test("drift leaves the asset byte-identical", () => {
  const source = currentProjectSource.replace(
    "ec=function({groups:e,projectOrder:t})",
    "ec=function({groups:e,projectOrder:t,unknown:o})",
  );
  const { value, warnings } = captureWarns(() =>
    applyProjectGroupLastUpdatedSortPatch(source),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /project group sorting insertion points/);
});

test("missing current call site leaves the asset byte-identical", () => {
  const source = currentProjectSource.replace(
    "projectOrder:(0,o.F6)(t,i.Q2Y.PROJECT_ORDER)",
    "projectOrder:unknownProjectOrder",
  );
  const { value, warnings } = captureWarns(() =>
    applyProjectGroupLastUpdatedSortPatch(source),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /project group sorting insertion points/);
});

test("mixed patched and clean helpers are rejected byte-identically", () => {
  const mixed = `${applyProjectGroupLastUpdatedSortPatch(
    currentProjectSource,
  )}${currentProjectSource}`;
  const { value, warnings } = captureWarns(() =>
    applyProjectGroupLastUpdatedSortPatch(mixed),
  );

  assert.equal(value, mixed);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /project group sorting insertion points/);
});

test("already patched sorter rejects a changed body, getter, or selected mode", () => {
  const patched = applyPatchTwice(currentProjectSource);
  for (const source of [
    patched.replace("Math.max(e,t(n)??0)", "Math.min(e,t(n)??0)"),
    patched.replace("PROJECT_ORDER),getRecencyAt:J", "PROJECT_ORDER),getRecencyAt:other"),
    patched.replace("getRecencyAt:J,sortMode:Q", "getRecencyAt:J,sortMode:X"),
    patched.replace("getRecencyAt:J,items:V", "getRecencyAt:other,items:V"),
    patched.replace("getRecencyAt:J,items:V", "getRecencyAt:J,items:other"),
  ]) {
    const { value, warnings } = captureWarns(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("partial helper or call-site patches are rejected without modifying bytes", () => {
  const patched = applyPatchTwice(currentProjectSource);
  const oldHelper = "function({groups:e,projectOrder:t}){return(0,a.n)(e,t)}";
  const newHelper = patched.slice(patched.indexOf("ec=function(") + 3, patched.indexOf("}({groups:q(") + 1);
  for (const source of [
    currentProjectSource.replace(oldHelper, newHelper),
    patched.replace(newHelper, oldHelper),
    currentProjectSource.replace("{chatSortMode:X,projectSortMode:Q}", "{unrelated:X,projectSortMode:Q}"),
    currentProjectSource.replace("ec=function({groups:e,projectOrder:t}){return(0,a.n)(e,t)}", "ec=function({groups:e,projectOrder:t}){return(0,n.n)(e,t)}"),
  ]) {
    const { value, warnings } = captureWarns(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("descriptor selects the unique sidebar chunk independently of chunk name", t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-group-last-updated-sort-assets-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const assetsDir = path.join(tempDir, "webview", "assets", "async");
  const assetPath = path.join(assetsDir, "24191.7b05d5cf83.js");
  const unrelated = path.join(assetsDir, "1.0000000000.js");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(assetPath, chunk(currentProjectSource));
  fs.writeFileSync(unrelated, chunk("let ec=null;"));
  const patch = () => {
    const report = createPatchReport();
    const { warnings } = captureWarns(() =>
      applyWebviewAssetPatchDescriptors(tempDir, normalizePatchDescriptors(descriptors), {}, report));
    return { entry: report.patches[0], warnings };
  };
  assert.equal(patch().entry.status, "applied");
  assert.equal(fs.readFileSync(assetPath, "utf8"), chunk(applyProjectGroupLastUpdatedSortPatch(currentProjectSource)));
  assert.equal(patch().entry.status, "already-applied");
  assert.equal(fs.readFileSync(unrelated, "utf8"), chunk("let ec=null;"));

  fs.writeFileSync(assetPath, chunk(currentProjectSource));
  fs.writeFileSync(path.join(assetsDir, "2.0000000000.js"), chunk(currentProjectSource));
  const { entry, warnings } = patch();
  assert.notEqual(entry.status, "applied");
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(assetPath, "utf8"), chunk(currentProjectSource));
  assert.equal(fs.readFileSync(path.join(assetsDir, "2.0000000000.js"), "utf8"), chunk(currentProjectSource));
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("the signed official webview has one patchable project-group sorter", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const sources = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles)
    .map((name) => fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8"))
    .filter(descriptors[0].assetMatch);
  assert.equal(sources.length, 1);
  const patched = applyPatchTwice(sources[0]);
  assert.notEqual(patched, sources[0]);
});
