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
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  applyProjectGroupLastUpdatedSortPatch,
  descriptors,
} = require("./patch.js");

const currentProjectSource = [
  "function ue(e,t){let n=new Map(t.map((e,t)=>[e,t]));return[...e].sort((e,t)=>(n.get(e.projectId)??2**53-1)-(n.get(t.projectId)??2**53-1))}",
  "function Re(e,t){let n=e.projectUpdatedAt??0;for(let r of e.threadKeys)n=Math.max(n,t.get(r)??0);return n}",
  "function Fe({groups:e,items:t,projectOrder:n}){let r=new Map(t.map(e=>[e.task.key,e.recencyAt]));return ue(e.map((e,t)=>({group:e,index:t,recencyAt:Re(e,r)})).sort((e,t)=>t.recencyAt-e.recencyAt||e.index-t.index).map(({group:e})=>e),n)}",
  "const prioritySortId=`sidebarElectron.sortMenu.priority`;",
  "const updatedSortId=`sidebarElectron.sortMenu.updated`;",
  "const manualSortId=`sidebarElectron.sortMenu.manual`;",
  "T=Fe({groups:Pe({groups:S,items:c}),items:c,projectOrder:f(t,o.PROJECT_ORDER)});",
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
  vm.runInNewContext(`${sorterSource};globalThis.sortProjectGroups=Fe`, context);
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
    { task: { key: "nix-task" }, recencyAt: 1 },
    { task: { key: "delta-task" }, recencyAt: 2 },
    { task: { key: "multi-task" }, recencyAt: 3 },
    { task: { key: "chezmoi-task" }, recencyAt: 4 },
    { task: { key: "tapas-task" }, recencyAt: 5 },
  ];
  const projectOrder = ["nix", "delta", "multi", "chezmoi", "tapas"];

  assert.deepEqual(
    Array.from(
      sortProjectGroups({ groups, items, projectOrder, sortMode: "updated_at" }),
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
    { task: { key: "newer-task" }, recencyAt: 2 },
    { task: { key: "older-task" }, recencyAt: 1 },
  ];
  const projectOrder = ["older", "newer"];

  for (const sortMode of ["manual", "priority"]) {
    assert.deepEqual(
      Array.from(
        sortProjectGroups({ groups, items, projectOrder, sortMode }),
        (group) => group.projectId,
      ),
      ["older", "newer"],
    );
  }
});

test("patch passes the selected project sort mode into the group sorter", () => {
  const patched = applyPatchTwice(currentProjectSource);
  assert.ok(
    patched.includes(
      "projectOrder:f(t,o.PROJECT_ORDER),sortMode:t(C).projectSortMode",
    ),
  );
});

test("drift leaves the asset byte-identical", () => {
  const source = currentProjectSource.replace(
    "function Fe({groups:e,items:t,projectOrder:n})",
    "function Fe({groups:e,items:t,projectOrder:n,unknown:o})",
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
    "projectOrder:f(t,o.PROJECT_ORDER)",
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

test("descriptor targets and patches only the current project sidebar chunk", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "project-group-last-updated-sort-assets-"),
  );
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    const assetPath = path.join(
      assetsDir,
      "app-initial~app-main~onboarding-page~projects-index-page~quick-chat-window-page~codex-micro~iqsnin5k-demo.js",
    );
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(assetPath, currentProjectSource);

    const result = patchAssetFiles(
      tempDir,
      descriptors[0].pattern,
      descriptors[0].apply,
      "missing",
    );

    assert.deepEqual(result, { matched: 1, changed: 1 });
    assert.notEqual(fs.readFileSync(assetPath, "utf8"), currentProjectSource);
    assert.equal(
      descriptors[0].pattern.test(
        "app-initial~app-main~projects-index-page~remote-conversation-page-old.js",
      ),
      false,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
