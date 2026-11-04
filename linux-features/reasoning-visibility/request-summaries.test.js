"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyRequestSummariesPatch: apply, requestSummariesDescriptor: descriptor } = require("./request-summaries.js");
const { RUNTIME } = require("./runtime.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");

const source = 'function options(e,u){return{reasoningSummaryOverride:!0===e.getDefaultFeatureOverride("concurrent_reasoning_summaries")||u?"detailed":null,getRequestModel:e=>e,getRequestCollaborationMode(e){return e}}}';
// Verbatim current turn-start precedence statements. The wrapper supplies the
// durable, conversation, feature-option, config, and per-turn objects directly.
const precedence = 'eZ=Q?.summary??"none";H?.summary!==void 0&&(eZ=H.summary),null!=s.reasoningSummaryOverride&&(eZ=s.reasoningSummaryOverride),eZ=null==eV?null:eV.model_reasoning_summary??eZ,void 0!==h.summary&&(eZ=h.summary);';
const resolve = vm.runInNewContext(`(function(Q,H,s,eV,h){let ${precedence}return eZ})`);
function options(current, enabled) {
  return vm.runInNewContext(`${current};options`, { localStorage: { getItem: () => enabled ? "1" : null } });
}

test("setting changes only the current summary fallback and keeps the original rollout/durable defaults when off", () => {
  const patched = apply(source);
  assert.notEqual(patched, source);
  assert.equal(apply(patched), patched);
  assert.equal(javascriptSourceParses(patched), true);
  for (const gate of [false, true, null, 1]) {
    const client = { getDefaultFeatureOverride: key => {
      assert.equal(key, "concurrent_reasoning_summaries");
      return gate;
    } };
    for (const durable of [false, true]) {
      const original = options(source)(client, durable);
      const off = options(patched, false)(client, durable);
      const on = options(patched, true)(client, durable);
      assert.equal(off.reasoningSummaryOverride, original.reasoningSummaryOverride);
      assert.equal(on.reasoningSummaryOverride, "detailed");
      const model = { id: "provider-model" }, mode = { kind: "default" };
      assert.equal(on.getRequestModel(model), model);
      assert.equal(on.getRequestCollaborationMode(mode), mode);
    }
  }
});

test("actual upstream precedence keeps explicit config and per-turn summary choices ahead of local durable defaults", () => {
  const getOptions = options(apply(source), true);
  for (const durable of [false, true]) {
    const feature = getOptions({ getDefaultFeatureOverride: () => false }, durable);
    for (const stored of [undefined, "none", "concise", "detailed"]) {
      for (const conversation of [undefined, "none", "concise", "detailed"]) {
        assert.equal(resolve({ summary: stored }, { summary: conversation }, feature, {}, {}), "detailed");
        for (const configured of ["none", "concise", "detailed"]) {
          assert.equal(resolve({ summary: stored }, { summary: conversation }, feature,
            { model_reasoning_summary: configured }, {}), configured);
          for (const selected of [null, "none", "concise", "detailed"]) {
            assert.equal(resolve({ summary: stored }, { summary: conversation }, feature,
              { model_reasoning_summary: configured }, { summary: selected }), selected);
          }
        }
      }
    }
    assert.equal(resolve(null, null, feature, null, {}), null, "an unavailable config retains upstream null behavior");
  }
});

test("summary request patch rejects missing, duplicate, partial runtime, and changed variable contracts", t => {
  t.mock.method(console, "warn", () => {});
  const patched = apply(source);
  for (const invalid of [
    "const unrelated=true;", source + source, patched + source, patched + patched,
    patched.replace("/*community-reasoning-visibility-request-summaries*/", ""),
    patched.replace(RUNTIME, ""), RUNTIME + patched,
    source + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}",
    patched.replace('codexLinuxReasoningVisibilityEnabled()?"detailed"', 'codexLinuxReasoningVisibilityEnabled()?"none"'),
    source.replace('!0===e.getDefaultFeatureOverride', 'e.getDefaultFeatureOverride'),
    source.replace("getRequestModel:e=>e", "getRequestModel:e=>other"),
  ]) {
    assert.notEqual(invalid, source);
    assert.equal(apply(invalid), invalid);
  }
  const renamed = source.replace(/\be\b/g, "freshClient").replace(/\bu\b/g, "$durable");
  assert.notEqual(apply(renamed), renamed);
  assert.equal(apply(apply(renamed)), apply(renamed));
});

test("applied summary options reject a helper hidden in a sibling factory or ordinary nested scope", t => {
  t.mock.method(console, "warn", () => {});
  const body = apply(source).replace(RUNTIME + "\n", "");
  const sibling = `export const __webpack_modules__={Owner(e,t,n){${body};return options},Sibling(e,t,n){${RUNTIME}}};`;
  const nested = `${body}function unused(){${RUNTIME}}`;
  const client = { getDefaultFeatureOverride: () => false };
  const siblingOptions = vm.runInNewContext(sibling.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner()");
  const nestedOptions = vm.runInNewContext(`${nested};options`);
  assert.throws(() => siblingOptions(client, false), /codexLinuxReasoningVisibilityEnabled is not defined/);
  assert.throws(() => nestedOptions(client, false), /codexLinuxReasoningVisibilityEnabled is not defined/);
  for (const current of [sibling, nested, `${body}if(false){${RUNTIME}}`, `${body}/*${RUNTIME}*/`,
    source + ";function orphan(){return codexLinuxReasoningVisibilityEnabled()}"]) {
    assert.equal(apply(current), current);
    const { write, run } = workspace(t);
    const file = write("async/wrong-helper-scope.js", current);
    assert.equal(run().status, "skipped-optional");
    assert.equal(fs.readFileSync(file, "utf8"), current);
  }
});

test("summary options accept their own factory helper with outer and sibling helper copies", t => {
  const body = apply(source).replace(RUNTIME + "\n", "");
  for (const outer of ["", RUNTIME]) {
    const current = `${outer}export const __webpack_modules__={Owner(e,t,n){${RUNTIME}${body};return options},Sibling(e,t,n){${RUNTIME}}};`;
    assert.equal(apply(current), current);
    const getOptions = vm.runInNewContext(current.replace("export const __webpack_modules__=", "const modules=") + ";modules.Owner()", {
      localStorage: { getItem: () => "1" },
    });
    assert.equal(getOptions({ getDefaultFeatureOverride: () => false }, false).reasoningSummaryOverride, "detailed");
    const { write, run } = workspace(t);
    const file = write("async/visible-helper-scope.js", current);
    assert.equal(run().status, "already-applied");
    assert.equal(fs.readFileSync(file, "utf8"), current);
  }
});

function workspace(t) {
  const base = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "reasoning-summary-requests-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, text) => {
    const file = path.join(root, "webview", "assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const run = () => {
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(root, [descriptor], {}, report);
    return report.patches[0];
  };
  return { write, run };
}

test("summary production descriptor handles numeric async chunks and rejects ambiguity without writes", t => {
  t.mock.method(console, "warn", () => {});
  const { write, run } = workspace(t);
  const first = write("async/24191.hash.js", source);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(first, "utf8");
  assert.equal(run().status, "already-applied");
  const partial = patched.replace('codexLinuxReasoningVisibilityEnabled()?"detailed"', 'codexLinuxReasoningVisibilityEnabled()?"none"');
  const second = write("other/24191.hash.js", partial);
  assert.equal(run().status, "skipped-optional");
  assert.equal(fs.readFileSync(first, "utf8"), patched);
  assert.equal(fs.readFileSync(second, "utf8"), partial);
});

test("signed owner retains the exact resolver precedence and patches idempotently on an independent copy", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const owners = listWebviewAssetFiles(assets, /\.js$/).map(assetName => ({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")})).filter(({source}) => descriptor.assetMatch(source));
  assert.equal(owners.length,1);
  const owner=owners[0];
  assert.ok(owner.source.includes(precedence), "precedence fixture must match the real current resolver");
  const { write, run } = workspace(t);
  const file = write(owner.assetName, owner.source);
  assert.equal(run().status, "applied");
  const patched = fs.readFileSync(file, "utf8");
  assert.equal(javascriptSourceParses(patched), true);
  assert.ok(patched.includes(precedence), "the resolver remains byte-identical");
  assert.equal(run().status, "already-applied");
  assert.equal(fs.readFileSync(path.join(assets, owner.assetName), "utf8"), owner.source);
});
