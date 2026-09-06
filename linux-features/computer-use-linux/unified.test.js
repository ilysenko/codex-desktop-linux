"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const descriptors = require("./patch.js");

// The current selector boundary: unified prerequisites, platform, feature flag,
// and the legacy macOS service, followed by independent browser selection.
const selector = 'function select(f,l,t,u){let p=f&&l.platform===`darwin`&&t.computerUse&&u.enabled&&u.paths.serviceAppPath!=null,m=t.computerUse&&(t.computerUseNodeRepl||p)&&(!t.browserUseTinysky||l.platform!==`darwin`||u.enabled),h=[];return f&&t.browser&&h.push(`browser`),p&&h.push(`computer`),{computerUse:m,cuaReplSurfaces:h}}';
function patch(source) {
  return descriptors.filter(d => ["ui-feature", "unified-runtime"].includes(d.id))
    .reduce((s, d) => d.apply(s), source);
}
function surfaces(source, platform, { ready = true, enabled = true, legacy = false, nativeEnabled = true } = {}) {
  const select = vm.runInNewContext(`(${source})`);
  return Array.from(select(ready, { platform }, { computerUse: enabled, browser: true },
    { enabled: platform === "linux" ? nativeEnabled : legacy, paths: { serviceAppPath: legacy ? "/service" : null } }).cuaReplSurfaces);
}
test("unified Linux native selection uses the native setting and retains browser control", () => {
  assert.deepEqual(surfaces(selector, "linux"), ["browser"]);
  assert.deepEqual(surfaces(patch(selector), "linux"), ["browser", "computer"]);
});
test("unified prerequisites, native feature flag, and other platforms retain their gates", () => {
  const result = patch(selector);
  assert.deepEqual(surfaces(result, "linux", { ready: false }), []);
  assert.deepEqual(surfaces(result, "linux", { enabled: false }), ["browser"]);
  assert.deepEqual(surfaces(result, "linux", { nativeEnabled: false }), ["browser"]);
  assert.deepEqual(surfaces(result, "darwin"), ["browser"]);
  assert.deepEqual(surfaces(result, "darwin", { legacy: true }), ["browser", "computer"]);
  assert.deepEqual(surfaces(result, "win32", { legacy: true }), ["browser"]);
  assert.equal(patch(result), result);
});
test("unified selector drift and ambiguous owners fail the build", () => {
  assert.throws(() => patch(selector.replace("serviceAppPath!=null", "serviceAppPath")), /unified.*contract/i);
  assert.throws(() => patch(selector + selector), /unified.*contract/i);
});

test("disabled native access does not leave a second native Node REPL service enabled", () => {
  const select = vm.runInNewContext(`(${patch(selector)})`);
  assert.equal(select(true, { platform: "linux" }, { computerUse: true, computerUseNodeRepl: true },
    { enabled: false, paths: {} }).computerUse, false);
});

test("unified mode rejects appended gates and changed companion selectors", () => {
  for (const source of [selector, patch(selector)]) {
    const changed = source.replace(",h=[]", "&&t.newRequiredGate,h=[]");
    assert.throws(() => patch(changed), /unified.*contract/i);
    assert.throws(() => patch(selector + changed), /unified.*contract/i);
  }
});
