"use strict";
const assert = require("node:assert/strict");
const vm = require("node:vm");
const test = require("node:test");
const descriptors = require("./patch.js");

// The current selector boundary: unified prerequisites, platform, feature flag,
// and the legacy macOS service, followed by independent browser selection.
const selector = 'function select(f,l,t,u){let p=f&&l.platform===`darwin`&&t.computerUse&&u.enabled&&u.paths.serviceAppPath!=null,m=t.computerUse&&(!t.browserUseTinysky||l.platform!==`darwin`||u.enabled),h=[];return f&&t.browser&&h.push(`browser`),p&&h.push(`computer`),{computerUse:m,cuaReplSurfaces:h}}function configure(e){let i=pluginRoot(),a=path.default.join(i,`.mcp.json`),l={};e.surfaces.includes(`computer`)&&(l.sky=`@oai/sky/service`);let c={env:{CUA_REPL_ENABLED_SURFACES:e.surfaces.join(`,`),[constants.Il]:JSON.stringify(l)}};return c}';
function patch(source) {
  return descriptors.filter(d => ["ui-feature", "unified-runtime"].includes(d.id))
    .reduce((s, d) => d.apply(s), source);
}
function surfaces(source, platform, { ready = true, enabled = true, legacy = false, nativeEnabled = true } = {}) {
  const select = vm.runInNewContext(`(${source.slice(0, source.indexOf("function configure"))})`);
  return Array.from(select(ready, { platform }, { computerUse: enabled, browser: true },
    { enabled: platform === "linux" ? nativeEnabled : legacy, paths: { serviceAppPath: legacy ? "/service" : null } }).cuaReplSurfaces);
}
test("unified Linux native selection uses the native setting and retains browser control", () => {
  assert.deepEqual(surfaces(selector, "linux"), ["browser"]);
  assert.deepEqual(surfaces(patch(selector), "linux"), ["browser", "computer"]);
  assert.match(patch(selector), /\.sky=path\.default\.join\(i,`scripts`,`native-service\.mjs`\)/);
  assert.match(patch(selector), /NODE_REPL_JS_BANNER:.*native-client\.mjs/);
  assert.match(patch(selector), /CODEX_LINUX_CUA_HOST_SOCKET:process\.env\.CODEX_LINUX_CUA_HOST_SOCKET/);
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
  assert.throws(() => patch(selector.replace("@oai/sky/service", "@oai/sky/changed")), /unified.*contract/i);
  assert.throws(() => patch(selector.replace("CUA_REPL_ENABLED_SURFACES:e.surfaces", "CUA_REPL_ENABLED_SURFACES:other.surfaces")), /unified.*contract/i);
});

test("disabled native access does not leave a second native Node REPL service enabled", () => {
  const patched = patch(selector);
  const select = vm.runInNewContext(`(${patched.slice(0, patched.indexOf("function configure"))})`);
  assert.equal(select(true, { platform: "linux" }, { computerUse: true },
    { enabled: false, paths: {} }).computerUse, false);
});

test("unified mode rejects appended gates and changed companion selectors", () => {
  for (const source of [selector, patch(selector)]) {
    const changed = source.replace(",h=[]", "&&t.newRequiredGate,h=[]");
    assert.throws(() => patch(changed), /unified.*contract/i);
    assert.throws(() => patch(selector + changed), /unified.*contract/i);
  }
});

test("unified service patch scopes the plugin root and current env-key alias to its owner", () => {
  const current =
    "function unrelated(){let other=path.default.join(otherRoot,`.mcp.json`);return other}" +
    selector.replace("[constants.Il]", "[constants.Gl]");
  const patched = patch(current);

  assert.match(patched, /path\.default\.join\(i,`scripts`,`native-service\.mjs`\)/u);
  assert.match(patched, /\[constants\.Gl\]:JSON\.stringify\(l\)/u);
  assert.doesNotMatch(patched, /path\.default\.join\(otherRoot,`scripts`,`native-service\.mjs`\)/u);
  assert.equal(patch(patched), patched);
});

test("unified banner patch edits only the validated service owner", () => {
  const unrelatedBanner =
    "function unrelated(e){let constants={},l={};return{env:{CUA_REPL_ENABLED_SURFACES:e.surfaces.join(`,`),[constants.Il]:JSON.stringify(l)}}}";
  const current = unrelatedBanner + selector;
  const patched = patch(current);

  assert.equal(patched.slice(0, unrelatedBanner.length), unrelatedBanner);
  assert.equal((patched.match(/NODE_REPL_JS_BANNER:/gu) ?? []).length, 1);
});

test("unified banner patch rejects duplicate banners inside the service owner", () => {
  const duplicate = selector.replace(
    ";return c}",
    ";let d={env:{CUA_REPL_ENABLED_SURFACES:e.surfaces.join(`,`),[constants.Il]:JSON.stringify(l)}};return c}",
  );

  assert.throws(() => patch(duplicate), /unified.*contract/i);
});
