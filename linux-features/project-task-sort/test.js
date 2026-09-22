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
  applyProjectTaskSortPatch,
  matchesProjectTaskSortContract,
  descriptors,
} = require("./patch.js");

const currentProjectSource =
  "function CQr(e,t){switch(e.kind){case`local`:return e.conversation==null?e.at:t===`updated_at`?e.conversation.recencyAt??e.conversation.updatedAt:e.conversation.createdAt;case`remote`:return((t===`updated_at`?e.task.updated_at??e.task.created_at:e.task.created_at??e.task.updated_at)??0)*1e3}}";

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
  const patched = applyProjectTaskSortPatch(source);
  const { value: secondPass, warnings } = captureWarns(() =>
    applyProjectTaskSortPatch(patched),
  );
  assert.equal(secondPass, patched);
  assert.deepEqual(warnings, []);
  return patched;
}

function timestampFunction(source = currentProjectSource) {
  const patched = applyPatchTwice(source);
  const context = {};
  const functionName = patched.match(/^function ([A-Za-z_$][\w$]*)/)?.[1];
  vm.runInNewContext(`${patched};globalThis.timestamp=${functionName}`, context);
  return context.timestamp;
}

function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-task-sort-"));
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

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id === "feature:project-task-sort:creation-time"),
      false,
    );
  });
  withFeatureConfig(["project-task-sort"], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id === "feature:project-task-sort:creation-time"),
      true,
    );
  });
});

test("populated local conversations recover Created time from UUIDv7 keys", () => {
  const timestamp = timestampFunction();
  const older = {
    key: "local:019e0000-0000-7000-8000-000000000001",
    kind: "local",
    at: 900,
    conversation: { recencyAt: 400 },
  };
  const newer = {
    key: "local:019f0000-0000-7000-8000-000000000002",
    kind: "local",
    at: 1,
    conversation: { recencyAt: 100 },
  };

  assert.ok(timestamp(newer, "created_at") > timestamp(older, "created_at"));
  assert.equal(timestamp(older, "updated_at"), 400);
});

test("explicit, pending, legacy, invalid, and remote timestamps retain upstream behavior", () => {
  const timestamp = timestampFunction();
  const local = {
    key: "local:019e0000-0000-7000-8000-000000000001",
    kind: "local",
    at: 900,
    conversation: { recencyAt: 400, updatedAt: 300 },
  };

  assert.equal(timestamp({ ...local, conversation: { ...local.conversation, createdAt: 123 } }, "created_at"), 123);
  assert.equal(timestamp({ ...local, conversation: null }, "created_at"), 900);
  assert.equal(timestamp({ ...local, key: "local:legacy-id" }, "created_at"), 400);
  assert.equal(
    timestamp({ ...local, key: "local:019e0000-0000-7000-7000-000000000001" }, "created_at"),
    400,
  );
  assert.equal(
    timestamp({ ...local, key: "local:019e0000-0000-7garbage" }, "created_at"),
    400,
  );

  const remote = { kind: "remote", task: { created_at: 10, updated_at: 20 } };
  assert.equal(timestamp(remote, "created_at"), 10_000);
  assert.equal(timestamp(remote, "updated_at"), 20_000);
});

test("semantic comparator matching is independent of minified aliases", () => {
  const renamed = currentProjectSource
    .replace("CQr(e,t)", "createdComparator(task,mode)")
    .replaceAll("e.", "task.")
    .replaceAll("t===", "mode===");
  const timestamp = timestampFunction(renamed);
  assert.equal(
    timestamp({
      key: "local:019e0000-0000-7000-8000-000000000001",
      kind: "local",
      conversation: {},
    }, "created_at"),
    Number.parseInt("019e00000000", 16),
  );
});

test("drift and duplicate semantic comparators fail closed byte-identically", () => {
  const drifted = currentProjectSource.replace("e.at", "e.pendingWorktree.createdAt");
  for (const source of [
    drifted,
    `${currentProjectSource}${currentProjectSource}`,
    `${currentProjectSource}${drifted}`,
    `${applyProjectTaskSortPatch(currentProjectSource)}${currentProjectSource}`,
  ]) {
    const { value, warnings } = captureWarns(() => applyProjectTaskSortPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /one unique current project task timestamp comparator/);
    assert.equal(matchesProjectTaskSortContract(source), false);
  }
});

test("descriptor locates one semantic asset and rejects missing or ambiguous assets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-task-sort-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "renamed-project-chunk.js"), currentProjectSource);
    fs.writeFileSync(path.join(assetsDir, "unrelated.js"), "export const value=1;");

    const patch = () => patchUniqueAssetFile(
      tempDir,
      descriptors[0].pattern,
      descriptors[0].assetMatch,
      descriptors[0].apply,
      "missing",
      "ambiguous",
    );
    assert.deepEqual(patch(), {
      matched: 1,
      changed: 1,
      assetName: "renamed-project-chunk.js",
    });
    assert.equal(matchesProjectTaskSortContract(
      fs.readFileSync(path.join(assetsDir, "renamed-project-chunk.js"), "utf8"),
    ), true);

    fs.writeFileSync(path.join(assetsDir, "duplicate-project-chunk.js"), currentProjectSource);
    const { value, warnings } = captureWarns(patch);
    assert.deepEqual(value, { matched: 2, changed: 0, assetName: null });
    assert.deepEqual(warnings, [
      "ambiguous: duplicate-project-chunk.js, renamed-project-chunk.js",
    ]);

    fs.rmSync(path.join(assetsDir, "duplicate-project-chunk.js"));
    fs.rmSync(path.join(assetsDir, "renamed-project-chunk.js"));
    const missing = captureWarns(patch);
    assert.deepEqual(missing.value, { matched: 0, changed: 0, assetName: null });
    assert.deepEqual(missing.warnings, ["missing"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
