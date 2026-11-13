"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { locateSummaryLayer } = require("./summary-contract.js");
const { RUNTIME } = require("./runtime.js");
const { applyRequestSummariesPatch, requestSummariesDescriptor } = require("./request-summaries.js");
const { prepareSummaryLayerSource } = require("./summary-contract.js");
const { nativeCarrier, selectedRuntime } = require("./summary-contract.test-helpers.js");
const { reasoningVisibilitySnapshot } = require("./runtime.js");
const data = require("./summary-contract-data.js");

test("summary producer uses the existing renderer-session snapshot without another preference read", () => {
  assert.equal(data.snapshotExpression, `(${reasoningVisibilitySnapshot.toString()})(globalThis)`);
  const source = applyRequestSummariesPatch(nativeCarrier());
  for (const enabled of [false, true]) {
    let reads = 0, getterCalls = 0;
    const scope = { __codexCommunityReasoningVisibility: { enabled }, localStorage: { getItem() { reads++; throw Error("cached preference must not be reread"); } } };
    const resolve = selectedRuntime(source, scope);
    const manager = { getDefaultFeatureOverride() { getterCalls++; return false; } };
    assert.equal(resolve(manager, false, undefined, undefined, {}, {}), enabled ? "detailed" : "none");
    assert.equal(reads, 0);
    assert.equal(getterCalls, enabled ? 0 : 1);
    scope.__codexCommunityReasoningVisibility.enabled = !enabled;
    assert.equal(resolve(manager, false, undefined, undefined, {}, {}), enabled ? "detailed" : "none", "factory-owned snapshot remains fixed for its renderer session");
  }
});

test("unavailable preference storage retains upstream automatic choices", () => {
  const source = applyRequestSummariesPatch(nativeCarrier());
  let reads = 0;
  const resolve = selectedRuntime(source, { localStorage: { getItem() { reads++; throw Error("controlled preference read failure"); } } });
  assert.equal(resolve({ getDefaultFeatureOverride: () => false }, false, undefined, undefined, {}, {}), "none");
  assert.equal(resolve({ getDefaultFeatureOverride: () => true }, false, undefined, undefined, {}, {}), "detailed");
  assert.equal(resolve({ getDefaultFeatureOverride: () => false }, true, undefined, undefined, {}, {}), "detailed");
  assert.equal(reads, 1);
});

test("request descriptor owns the complete extracted cohort and retains its stable order", () => {
  assert.equal(requestSummariesDescriptor.id, "request-summaries");
  assert.equal(requestSummariesDescriptor.phase, "extracted-app:pre-webview");
  assert.equal(requestSummariesDescriptor.order, 20_745);
  assert.equal(requestSummariesDescriptor.ciPolicy, "optional");
  const native = nativeCarrier(), patched = applyRequestSummariesPatch(native);
  assert.notEqual(patched, native);
  assert.equal(applyRequestSummariesPatch(patched), patched);
  assert.equal(prepareSummaryLayerSource(patched, "visibility", false).patchedSource, native);
});


test("selected native precedence retains stored, effective, model and per-turn values together", () => {
  const patched = applyRequestSummariesPatch(nativeCarrier());
  const values = [undefined, null, "none", "concise", "detailed", "future-value"];
  let cases = 0;
  for (const enabled of [false, true]) {
    const resolve = selectedRuntime(patched, { localStorage: { getItem: () => enabled ? "1" : null } });
    for (const stored of values) for (const effective of values) for (const configured of values) for (const selected of values) {
      let expected = stored ?? "none";
      if (effective !== undefined) expected = effective;
      if (enabled) expected = "detailed";
      expected = configured ?? expected;
      if (selected !== undefined) expected = selected;
      const actual = resolve({ getDefaultFeatureOverride: () => false }, false, { summary: stored }, { summary: effective }, { model_reasoning_summary: configured }, { summary: selected });
      assert.equal(actual, expected);
      cases++;
    }
  }
  assert.equal(cases, 2592);
});

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-summary-requests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, source) => {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, [requestSummariesDescriptor], {}, report, "extracted-app:pre-webview");
    return report.patches[0];
  };
  return { write, run };
}

test("foreign global, sibling, nested and dead helpers cannot approve an incomplete summary owner", t => {
  t.mock.method(console, "warn", () => {});
  const incomplete = nativeCarrier().replace('getDefaultFeatureOverride("concurrent_reasoning_summaries")', 'getDefaultFeatureOverride("foreign")');
  for (const source of [RUNTIME + incomplete, incomplete + `function unrelated(){${RUNTIME}}`, incomplete + `if(false){${RUNTIME}}`, incomplete + `export const sibling={Other(e,t,n){${RUNTIME}}};`]) {
    assert.equal(applyRequestSummariesPatch(source), source);
    const { write, run } = workspace(t), file = write("async/incomplete.js", source);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(file, "utf8"), source);
  }
});

test("registered extracted summary descriptor reports numeric peers and hidden same-ID drift atomically", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t), native = nativeCarrier();
  const first = write("async/24191.hash.js", native);
  const second = write("other/24191.hash.js", native);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(first, "utf8");
  assert.equal(fs.readFileSync(second, "utf8"), patched);
  assert.equal(run().status, "already-applied");
  const damaged = native.replace("Reasoning summary turn-start config resolved", "hidden damaged peer");
  fs.writeFileSync(second, damaged);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(first, "utf8"), patched);
  assert.equal(fs.readFileSync(second, "utf8"), damaged);
});

test("signed summary owner retains native precedence and applies once on independent selected copies", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview/assets");
  const plan = locateSummaryLayer(assets, "visibility");
  assert.ok(plan.edits.length > 0);
  const { write, run } = workspace(t);
  for (const [index, edit] of plan.edits.entries()) {
    const nativePrecedence = plan.proofs[index].parts.flow[0];
    assert.ok(edit.source.includes(nativePrecedence));
    assert.ok(edit.patchedSource.includes(nativePrecedence));
    write(edit.assetName, edit.source);
  }
  assert.equal(run().status, "applied");
  assert.equal(run().status, "already-applied");
  for (const edit of plan.edits) assert.equal(fs.readFileSync(path.join(assets, edit.assetName), "utf8"), edit.source);
});
