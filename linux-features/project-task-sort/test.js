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
  applyProjectTaskSortPatch,
  matchesProjectTaskSortContract,
  descriptors,
} = require("./patch.js");

// Current signed shape: the project task sorter compiles its local-only
// timestamp selector as an inline function expression.
const comparator =
  'function(e,t){if("local"===e.kind)return null==e.summary?e.at:"updated_at"===t?e.summary.recencyAt??e.summary.updatedAt:e.summary.createdAt}';
const currentProjectSource = `function u(e,t){return e.map((e,n)=>({task:e,timestamp:${comparator}(e,t),index:n}))}`;
const chunk = (body) => "export const __rspack_esm_id=24191;export const __rspack_esm_ids=[24191];" +
  `export const __webpack_modules__={YZnq(e,t,n){${body}n.d(t,{u:()=>u})}};`;

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
  vm.runInNewContext(`${patched};globalThis.timestamp=(task,mode)=>u([task],mode)[0].timestamp`, context);
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
    summary: { recencyAt: 400 },
  };
  const newer = {
    key: "local:019f0000-0000-7000-8000-000000000002",
    kind: "local",
    at: 1,
    summary: { recencyAt: 100 },
  };

  assert.ok(timestamp(newer, "created_at") > timestamp(older, "created_at"));
  assert.equal(timestamp(older, "updated_at"), 400);
});

test("explicit, pending, legacy, invalid, and non-local timestamps retain upstream behavior", () => {
  const timestamp = timestampFunction();
  const local = {
    key: "local:019e0000-0000-7000-8000-000000000001",
    kind: "local",
    at: 900,
    summary: { recencyAt: 400, updatedAt: 300 },
  };

  assert.equal(timestamp({ ...local, summary: { ...local.summary, createdAt: 123 } }, "created_at"), 123);
  assert.equal(timestamp({ ...local, summary: null }, "created_at"), 900);
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
  assert.equal(timestamp(remote, "created_at"), undefined);
  assert.equal(timestamp(remote, "updated_at"), undefined);
});

test("semantic comparator matching is independent of minified aliases", () => {
  const renamed = currentProjectSource
    .replace("function(e,t){if", "function createdComparator(task,mode){if")
    .replaceAll("e.summary", "task.summary").replaceAll("e.at", "task.at")
    .replace('"local"===e.kind', '"local"===task.kind')
    .replaceAll("===t?", "===mode?");
  const timestamp = timestampFunction(renamed);
  assert.equal(
    timestamp({
      key: "local:019e0000-0000-7000-8000-000000000001",
      kind: "local",
      summary: {},
    }, "created_at"),
    Number.parseInt("019e00000000", 16),
  );
});

test("drift and duplicate semantic comparators fail closed byte-identically", () => {
  const drifted = currentProjectSource.replace("e.at:", "e.pendingWorktree.createdAt:");
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

test("descriptor locates one semantic rspack chunk and rejects missing or ambiguous chunks", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "project-task-sort-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
    const target = path.join(assetsDir, "async", "24191.7b05d5cf83.js");
    fs.writeFileSync(target, chunk(currentProjectSource));
    fs.writeFileSync(path.join(assetsDir, "async", "1.0000000000.js"), chunk("function other(){}"));
    const run = () => {
      const report = createPatchReport();
      const { warnings } = captureWarns(() =>
        applyWebviewAssetPatchDescriptors(tempDir, normalizePatchDescriptors(descriptors), {}, report));
      return { report: report.patches[0], warnings };
    };

    let result = run();
    assert.equal(result.report.status, "applied");
    assert.equal(result.report.assetName, "async/24191.7b05d5cf83.js");
    assert.equal(fs.readFileSync(target, "utf8"), chunk(applyProjectTaskSortPatch(currentProjectSource)));
    assert.equal(run().report.status, "already-applied");

    fs.writeFileSync(target, chunk(currentProjectSource));
    const duplicate = path.join(assetsDir, "async", "2.0000000000.js");
    fs.writeFileSync(duplicate, chunk(currentProjectSource));
    result = run();
    assert.notEqual(result.report.status, "applied");
    assert.equal(fs.readFileSync(target, "utf8"), chunk(currentProjectSource));
    assert.equal(fs.readFileSync(duplicate, "utf8"), chunk(currentProjectSource));

    fs.rmSync(duplicate);
    fs.rmSync(target);
    result = run();
    assert.notEqual(result.report.status, "applied");
    assert.equal(result.warnings.length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
