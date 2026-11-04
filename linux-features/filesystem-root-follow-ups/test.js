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
const { applyFilesystemRootFollowUpsPatch: applyPatch, descriptors } = require("./patch.js");

// Current signed 26.1029.61003 amd64/arm64 composer submission state: the
// workspace guard is compiled as an inline function called with the state
// object whose local follow-up the sibling workspace-status check reads.
const guard = 'isMissingWorkspaceRoots:function({composerMode:e,workspaceRootsLoading:s,workspaceRootsForSubmit:t,canUseProjectlessThreads:i,isProjectlessConversation:n,isBrowserEnvironmentSelectionActive:a,isRemoteProjectExecution:r}){let d=(0,o.wW)(t),l=t.some(e=>"/"!==e);return"cloud"!==e&&!s&&!((l||r)&&!d)&&!("local"===e&&(n||i&&d))&&!("local"===e&&a)}(e)';
const sibling = 'isWorkspaceStatusUnavailable:"local"===e.composerMode&&"unavailable"===e.localWorkspaceMaterialization&&!(e.isLocalModeOnRemoteHost&&e.followUp?.type==="local")';
const state = `function submitState(e){return{${guard},${sibling}}}`;
const predicate = 'function isRootless(roots){return roots.length===0||roots.length===1&&"~"===roots[0]}';
const chunk = (id, body) => `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={Ab12(e,t,n){var o=n("Pred");${body}n.d(t,{s:()=>submitState})}};`;
const base = {
  composerMode: "local", workspaceRootsLoading: false,
  workspaceRootsForSubmit: ["/"], canUseProjectlessThreads: false,
  isProjectlessConversation: false, isBrowserEnvironmentSelectionActive: false,
  isRemoteProjectExecution: false, followUp: { type: "local" },
};

function evaluate(source, alias = "o") {
  const end = source.indexOf("n.d(t,{s:");
  const body = source.slice(source.indexOf("function submitState"), end < 0 ? source.length : end);
  return vm.runInNewContext(`var ${alias}={wW:${predicate}};${body};input=>submitState(input).isMissingWorkspaceRoots`);
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
  assert.equal(evaluate(state)(base), true);
  assert.equal(evaluate(applyPatch(state))(base), false);
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
    assert.equal(evaluate(state)(input), blocked);
    assert.equal(evaluate(applyPatch(state))(input), blocked);
  });
}

test("supports renamed minified symbols and is idempotent", () => {
  const renamed = state.replace(/\b[a-t]\b/g, (name) => `${name}$renamed`);
  const patched = applyPatch(renamed);
  assert.notEqual(patched, renamed);
  assert.equal(evaluate(patched, "o$renamed")(base), false);
  const second = captureWarnings(() => applyPatch(patched));
  assert.equal(second.value, patched);
  assert.deepEqual(second.warnings, []);
});

test("drift, ambiguity, partial patches and alias collisions remain byte-identical", () => {
  const patched = applyPatch(state);
  for (const source of [
    state.replace('"/"!==e', '"~"!==e'),
    state.replace("&&!s&&", "&&s&&"),
    state.replace("&&a)}", "&&!a)}"),
    state.replace("}(e),", "}(other),"),
    state.replace('e.followUp?.type==="local"', 'e.followUp?.type==="cloud"'),
    state + state,
    state + state.replace('"/"!==e', '"~"!==e'),
    state + patched,
    patched + patched,
    patched.replace(",followUp:codexLinuxRootFollowUp", ""),
    state.replace("isRemoteProjectExecution:r}", "isRemoteProjectExecution:r,followUp:codexLinuxRootFollowUp}"),
    state.replace("l=t.some", "codexLinuxRootFollowUp=t.some").replace("((l||r)", "((codexLinuxRootFollowUp||r)"),
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
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  const config = path.join(dir, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["filesystem-root-follow-ups"] }));
  const options = {
    featuresRoot: path.resolve(__dirname, ".."),
    featuresConfigPath: config,
    corePatchRoot: path.join(dir, "empty-core"),
  };
  try {
    fn({ dir, assets, config, options });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("disabled feature preserves chunks, enabled feature patches every duplicated chunk", () => {
  withApp(({ dir, assets, config, options }) => {
    // rspack duplicates the composer module into several lazily loaded chunks.
    const files = ["async/17982.d438990d71.js", "async/271446.f0bc8fd171.js"].map((name) => path.join(assets, name));
    for (const [index, filename] of files.entries()) fs.writeFileSync(filename, chunk(index, state));
    const unrelated = path.join(assets, "async/1.0000000000.js");
    fs.writeFileSync(unrelated, chunk(9, "function other(){}"));
    fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
    assert.equal(loadLinuxFeaturePatchDescriptors(options).length, 0);
    patchExtractedApp(dir, options);
    for (const [index, filename] of files.entries()) assert.equal(fs.readFileSync(filename, "utf8"), chunk(index, state));

    fs.writeFileSync(config, JSON.stringify({ enabled: ["filesystem-root-follow-ups"] }));
    const report = createPatchReport();
    patchExtractedApp(dir, { ...options, report });
    assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].status, "applied");
    for (const filename of files) assert.equal(evaluate(fs.readFileSync(filename, "utf8"))(base), false);
    assert.equal(fs.readFileSync(unrelated, "utf8"), chunk(9, "function other(){}"));
  });
});

test("enabled feature reports a missing or drifted duplicate chunk", () => {
  for (const sources of [[], [state, state.replace('"/"!==e', '"~"!==e')]]) {
    withApp(({ dir, assets, options }) => {
      const files = sources.map((source, index) => [path.join(assets, `async/${index + 1}.0000000000.js`), chunk(index, source)]);
      if (files.length === 0) files.push([path.join(assets, "async/1.0000000000.js"), chunk(0, "function other(){}")]);
      for (const [filename, source] of files) fs.writeFileSync(filename, source);
      const report = createPatchReport();
      captureWarnings(() => patchExtractedApp(dir, { ...options, report }));
      assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
    });
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("every signed official chunk carrying the guard is patchable", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const assets = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles);
  assert.ok(assets.length > 0);
  for (const name of assets) {
    const source = fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8");
    const { value, warnings } = captureWarnings(() => applyPatch(source));
    assert.deepEqual(warnings, [], name);
    assert.notEqual(value, source, name);
    assert.equal(applyPatch(value), value, name);
  }
});
