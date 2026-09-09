"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { applyFilesystemRootFollowUpsPatch: applyPatch } = require("./patch.js");

// Current signed 26.903.61454 amd64/arm64 guard, with descriptive helper names.
const guard = "function missingWorkspace({composerMode:e,workspaceRootsLoading:t,workspaceRootsForSubmit:n,canUseProjectlessThreads:r,isProjectlessConversation:i,isBrowserEnvironmentSelectionActive:a,isRemoteProjectExecution:o}){let s=isRootless(n),c=e===`local`&&(i||r&&s),l=(n.some(e=>e!==`/`)||o)&&!s;return e!==`cloud`&&!t&&!l&&!c&&!(e===`local`&&a)}";
const predicate = "function isRootless(roots){return roots.length===0||roots.length===1&&roots[0]===`~`}";
const base = {
  composerMode: "local", workspaceRootsLoading: false,
  workspaceRootsForSubmit: ["/"], canUseProjectlessThreads: false,
  isProjectlessConversation: false, isBrowserEnvironmentSelectionActive: false,
  isRemoteProjectExecution: false, followUp: { type: "local" },
};

function evaluate(source) {
  return vm.runInNewContext(`${predicate};${source};missingWorkspace`);
}

function captureWarnings(fn) {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

test("reproduces the root follow-up blocker and permits the existing local task", () => {
  assert.equal(evaluate(guard)(base), true);
  assert.equal(evaluate(applyPatch(guard))(base), false);
});

for (const [name, overrides, blocked] of [
  ["ordinary project", { workspaceRootsForSubmit: ["/work/project"] }, false],
  ["empty roots", { workspaceRootsForSubmit: [] }, true],
  ["new root placeholder", { followUp: undefined }, true],
  ["null follow-up", { followUp: null }, true],
  ["cloud follow-up in local mode", { followUp: { type: "cloud" } }, true],
  ["worktree placeholder", { composerMode: "worktree" }, true],
  ["projectless disabled", { workspaceRootsForSubmit: ["~"] }, true],
  ["projectless enabled", { workspaceRootsForSubmit: ["~"], canUseProjectlessThreads: true }, false],
  ["existing projectless conversation", { workspaceRootsForSubmit: [], isProjectlessConversation: true }, false],
  ["remote root", { isRemoteProjectExecution: true }, false],
  ["browser environment", { isBrowserEnvironmentSelectionActive: true }, false],
  ["cloud mode", { composerMode: "cloud" }, false],
  ["loading roots", { workspaceRootsLoading: true }, false],
]) {
  test(`preserves ${name}`, () => {
    const input = { ...base, ...overrides };
    assert.equal(evaluate(guard)(input), blocked);
    assert.equal(evaluate(applyPatch(guard))(input), blocked);
  });
}

test("supports renamed minified symbols and is idempotent", () => {
  const renamed = guard.replace(/\b[e-n]\b|\b[o-st]\b/g, (name) => `${name}$renamed`);
  const patched = applyPatch(renamed);
  assert.notEqual(patched, renamed);
  assert.equal(evaluate(patched)(base), false);
  const second = captureWarnings(() => applyPatch(patched));
  assert.equal(second.value, patched);
  assert.deepEqual(second.warnings, []);
});

test("drift, ambiguity, partial patches and alias collisions remain byte-identical", () => {
  const patched = applyPatch(guard);
  for (const source of [
    guard.replace("!==`/`", "!==`~`"),
    guard.replace("&&!t", "&&t"),
    guard.replace("&&a)", "&&!a)"),
    guard + guard,
    guard + guard.replace("!==`/`", "!==`~`"),
    guard + patched,
    patched + patched,
    patched.replace(",followUp:codexLinuxRootFollowUp", ""),
    guard.replace("isRemoteProjectExecution:o", "isRemoteProjectExecution:o,followUp:codexLinuxRootFollowUp"),
    guard.replaceAll("missingWorkspace", "codexLinuxRootFollowUp"),
    "const unrelated = true;",
  ]) {
    const { value, warnings } = captureWarnings(() => applyPatch(source));
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

function withApp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "filesystem-root-follow-ups-"));
  const assets = path.join(dir, "webview/assets");
  fs.mkdirSync(assets, { recursive: true });
  const config = path.join(dir, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["filesystem-root-follow-ups"] }));
  const options = { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config };
  try {
    fn({ dir, assets, config, options });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("disabled feature preserves assets, enabled feature patches through the runner", () => {
  withApp(({ dir, assets, config, options }) => {
    const filename = path.join(assets, "app-primary-current.js");
    fs.writeFileSync(filename, guard);
    fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
    assert.equal(loadLinuxFeaturePatchDescriptors(options).length, 0);
    patchExtractedApp(dir, options);
    assert.equal(fs.readFileSync(filename, "utf8"), guard);

    fs.writeFileSync(config, JSON.stringify({ enabled: ["filesystem-root-follow-ups"] }));
    const report = createPatchReport();
    patchExtractedApp(dir, { ...options, report });
    assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
    assert.equal(report.patches.length, 1);
    assert.equal(evaluate(fs.readFileSync(filename, "utf8"))(base), false);
  });
});

test("enabled feature reports drift and ambiguous assets without writing either", () => {
  for (const copies of [0, 2]) {
    withApp(({ dir, assets, options }) => {
      const files = copies === 0 ? ["unrelated.js"] : ["app-primary-one.js", "app-primary-two.js"];
      for (const filename of files) fs.writeFileSync(path.join(assets, filename), guard);
      const report = createPatchReport();
      captureWarnings(() => patchExtractedApp(dir, { ...options, report }));
      assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
      for (const filename of files) assert.equal(fs.readFileSync(path.join(assets, filename), "utf8"), guard);
    });
  }
});
