"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_MARKER,
  CODEX_MICRO_HOTPLUG_MARKER,
  applyCodexMicroFeatureGatePatch,
  descriptors,
  matchesCodexMicroFeatureGateContract,
  patchCodexMicroHotplugSource,
} = require("./patch.js");

test("official Linux node-hid is reused without a native binding descriptor", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    "linux-hid-hotplug",
    "webview-feature-gate",
  ]);
});

test("Codex Micro feature gate patches every current callsite", () => {
  const source = [
    "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
    "function settings(){return gg(`3207467860`)&&`codex-micro-settings`}",
  ].join(";");
  const patched = applyCodexMicroFeatureGatePatch(source);

  assert.equal(matchesCodexMicroFeatureGateContract(source), true);
  assert.equal(patched.includes(CODEX_MICRO_GATE_ID), false);
  assert.equal(
    patched.split(CODEX_MICRO_GATE_MARKER).length - 1,
    2,
  );
  assert.doesNotThrow(() => new Function(patched));
  assert.equal(matchesCodexMicroFeatureGateContract(patched), true);
  assert.equal(applyCodexMicroFeatureGatePatch(patched), patched);
});

test("Codex Micro feature gate rejects incomplete or drifted contracts", () => {
  const marker = `!0/*${CODEX_MICRO_GATE_MARKER}*/`;
  const cases = {
    incomplete:
      "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
    partial: [
      "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
      "function settings(){return gg(`3207467860`&&`codex-micro-settings`}",
    ].join(";"),
    member: [
      "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
      "function settings(){return gates.gg(`3207467860`)&&`codex-micro-settings`}",
    ].join(";"),
    duplicate: [
      "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
      "gg(`3207467860`);gg(`3207467860`)",
    ].join(";"),
    mixed: [
      "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
      `function settings(){return ${marker}&&\`codex-micro-settings\`}`,
    ].join(";"),
    unrecognized: [
      "function route(){return gg(`3207467860`)?`/settings/codex-micro`:null}",
      "const gateId=`3207467860`",
    ].join(";"),
    partiallyPatched: [
      `function route(){return ${marker}?\`/settings/codex-micro\`:null}`,
      "function settings(){return false&&`codex-micro-settings`}",
    ].join(";"),
    malformedPatched: [
      `function route(){return ${marker}?\`/settings/codex-micro\`:null}`,
      `function settings(){return false/*${CODEX_MICRO_GATE_MARKER}*/}`,
    ].join(";"),
  };

  for (const [name, source] of Object.entries(cases)) {
    assert.equal(
      matchesCodexMicroFeatureGateContract(source),
      false,
      `${name} must not match the asset contract`,
    );
    assert.equal(
      applyCodexMicroFeatureGatePatch(source),
      source,
      `${name} must remain byte-identical`,
    );
  }
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
