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
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
  applyProjectGroupLastUpdatedSortPatch,
  descriptors,
} = require("./patch.js");

const currentProjectSource = [
  "function U6i(e,t){let n=new Set(e.map(e=>e.projectId)),r=(t??[]).filter(e=>n.has(e)),i=new Set(r);return[...e.map(e=>e.projectId).filter(e=>!i.has(e)),...r]}",
  "function G6i(e,t){let n=U6i(e,t),r=new Map(n.map((e,t)=>[e,t]));return[...e].sort((e,t)=>(r.get(e.projectId)??2**53-1)-(r.get(t.projectId)??2**53-1))}",
  "function p5o({groups:e,projectOrder:t}){return G6i(e,t)}",
  "const prioritySortId=`sidebarElectron.sortMenu.priority`;",
  "const updatedSortId=`sidebarElectron.sortMenu.updated`;",
  "const manualSortId=`sidebarElectron.sortMenu.manual`;",
  "let{chatSortMode:j,projectSortMode:M}=t(xH),N=p5o({groups:fon({groups:D,items:f}),projectOrder:jm(t,_u.PROJECT_ORDER)}),chats=chatSorter({explicitChatThreadKeys:mirror,getRecencyAt:recency,items:f,projectGroups:D,projectlessThreadIds:new Set(ids??[])});",
].join("");

const officialLinuxProjectSource = [
  "function A6i(e,t){return e}",
  "function O8o({groups:e,projectOrder:t}){return A6i(e,t)}",
  "let{chatSortMode:j,projectSortMode:M}=t(IH),N=O8o({groups:fon({groups:D,items:f}),projectOrder:Dm(t,yu.PROJECT_ORDER)}),chats=chatSorter({explicitChatThreadKeys:mirror,getRecencyAt:recency,items:f,projectGroups:D,projectlessThreadIds:new Set(ids??[])});",
].join("");

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

function evaluateGroupSorter(source) {
  const context = {};
  const sorterSource = source.slice(0, source.indexOf("const prioritySortId"));
  vm.runInNewContext(`${sorterSource};globalThis.sortProjectGroups=p5o`, context);
  return context.sortProjectGroups;
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
    currentProjectSource.replace("getRecencyAt:recency", "unknown:recency"),
    currentProjectSource.replace("getRecencyAt:recency,items:f", "getRecencyAt:recency,items:other"),
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
      "projectOrder:jm(t,_u.PROJECT_ORDER),getRecencyAt:recency,sortMode:M",
    ),
  );
});

test("patch matches the current official project sorter semantically", () => {
  const patched = applyPatchTwice(officialLinuxProjectSource);

  assert.match(
    patched,
    /function O8o\(\{groups:e,getRecencyAt:t,projectOrder:n,sortMode:codexLinuxProjectSortMode\}\)/,
  );
  assert.match(
    patched,
    /O8o\(\{groups:fon\(\{groups:D,items:f\}\),projectOrder:Dm\(t,yu\.PROJECT_ORDER\),getRecencyAt:recency,sortMode:M\}\)/,
  );
});

test("drift leaves the asset byte-identical", () => {
  const source = currentProjectSource.replace(
    "function p5o({groups:e,projectOrder:t})",
    "function p5o({groups:e,projectOrder:t,unknown:o})",
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
    "projectOrder:jm(t,_u.PROJECT_ORDER)",
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
    patched.replace("projectOrder:jm(t,_u.PROJECT_ORDER),getRecencyAt:recency", "projectOrder:jm(t,_u.PROJECT_ORDER),getRecencyAt:other"),
    patched.replace("getRecencyAt:recency,sortMode:M", "getRecencyAt:recency,sortMode:j"),
    patched.replace("getRecencyAt:recency,items:f", "getRecencyAt:other,items:f"),
    patched.replace("getRecencyAt:recency,items:f", "getRecencyAt:recency,items:other"),
  ]) {
    const { value, warnings } = captureWarns(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("partial helper or call-site patches are rejected without modifying bytes", () => {
  const patched = applyPatchTwice(currentProjectSource);
  const oldHelper = "function p5o({groups:e,projectOrder:t}){return G6i(e,t)}";
  const newHelper = patched.slice(patched.indexOf("function p5o("), patched.indexOf("const prioritySortId"));
  for (const source of [
    currentProjectSource.replace(oldHelper, newHelper),
    patched.replace(newHelper, oldHelper),
    currentProjectSource.replace("{chatSortMode:j,projectSortMode:M}", "{unrelated:j,projectSortMode:M}"),
  ]) {
    const { value, warnings } = captureWarns(() => applyProjectGroupLastUpdatedSortPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("descriptor selects the unique sidebar contract independently of chunk name", t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-group-last-updated-sort-assets-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const assetsDir = path.join(tempDir, "webview", "assets");
  const assetPath = path.join(assetsDir, "renamed-sidebar.js");
  const unrelated = path.join(assetsDir, "app-initial-unrelated.js");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(assetPath, currentProjectSource);
  fs.writeFileSync(unrelated, "function unrelated(){}");
  const patch = () => patchUniqueAssetFile(tempDir, descriptors[0].pattern,
    descriptors[0].assetMatch, descriptors[0].apply, "missing", "ambiguous");
  assert.deepEqual(patch(), { matched: 1, changed: 1, assetName: "renamed-sidebar.js" });
  assert.deepEqual(patch(), { matched: 1, changed: 0, assetName: "renamed-sidebar.js" });
  assert.equal(fs.readFileSync(unrelated, "utf8"), "function unrelated(){}");

  fs.writeFileSync(path.join(assetsDir, "duplicate.js"), currentProjectSource);
  const before = fs.readFileSync(assetPath, "utf8");
  const { value, warnings } = captureWarns(patch);
  assert.deepEqual(value, { matched: 2, changed: 0, assetName: null });
  assert.equal(warnings.length, 1);
  assert.equal(fs.readFileSync(assetPath, "utf8"), before);
  assert.equal(fs.readFileSync(path.join(assetsDir, "duplicate.js"), "utf8"), currentProjectSource);
});
