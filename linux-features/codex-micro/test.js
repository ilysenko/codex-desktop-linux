"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CODEX_MICRO_GATE_MARKER,
  CODEX_MICRO_HOTPLUG_MARKER,
  applyCodexMicroFeatureGatePatch,
  descriptors,
  patchCodexMicroHotplugSource,
} = require("./patch.js");

test("official Linux node-hid is reused without a native binding descriptor", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    "linux-hid-hotplug",
    "webview-feature-gate",
  ]);
});

test("Codex Micro feature gate remains an opt-in product extension", () => {
  const source = [
    "function gg(e){let t=(0,Kit.c)(2);Git(typeof e==`string`);let n;return t[0]===e?n=t[1]:(n=typeof e==`boolean`?e:{cache:`signal`,resolve(t,n){return pg.resolve(t,n,e).atom},scope:pg.scope},t[0]=e,t[1]=n),Y(n)}",
    "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
  ].join(";");
  const patched = applyCodexMicroFeatureGatePatch(source);
  assert.match(patched, new RegExp(CODEX_MICRO_GATE_MARKER));
  assert.equal(applyCodexMicroFeatureGatePatch(patched), patched);
});

test("Linux hot-plug watcher is narrow and idempotent", () => {
  const source = [
    "const a=`hid-topology-watcher.node`,b=`hid_topology_watcher.node`;",
    "function w(e){return l().watch(e)}",
    "l().findCodexMicroInterfaces();scheduleTopologyFallbackScan();",
  ].join("");
  const result = patchCodexMicroHotplugSource(source);
  assert.equal(result.changed, 1);
  assert.match(result.source, new RegExp(CODEX_MICRO_HOTPLUG_MARKER));
  assert.match(result.source, /\/dev/);
  assert.equal(patchCodexMicroHotplugSource(result.source).changed, 0);
});
