"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  CODEX_MICRO_GATE_CONTRACTS,
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_MARKER,
  CODEX_MICRO_HOTPLUG_MARKER,
  applyCodexMicroFeatureGatePatch,
  descriptors,
  findCodexMicroFeatureGateAssets,
  matchesCodexMicroFeatureGateContract,
  patchCodexMicroFeatureGateAssets,
  patchCodexMicroHotplugSource,
} = require("./patch.js");

const [appShellContract, settingsContract, debugPanelContract] =
  CODEX_MICRO_GATE_CONTRACTS;

function appShellSource(gates = 5) {
  return [
    "const onboarding=`codex-micro-onboarding-host-current.js`",
    "const bridge=`codex-micro-bridge-current.js`",
    "const firstRoute=`/settings/codex-micro`",
    "const secondRoute=`/settings/codex-micro`",
    ...Array.from(
      { length: gates },
      (_, index) => `const gate${index}=gg(\`3207467860\`)`,
    ),
  ].join(";");
}

function settingsVisibilitySource() {
  return [
    'const sections={"codex-micro":true}',
    "function visible(section){switch(section){case`codex-micro`:return gg(`3207467860`)}}",
  ].join(";");
}

function debugPanelSource() {
  return [
    "const message=`codexMicro.onboarding.debugStatus`",
    "const enabled=gg(`3207467860`)",
  ].join(";");
}

function createExtractedApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-test-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "shell.js"), appShellSource(), "utf8");
  fs.writeFileSync(
    path.join(assets, "settings.js"),
    settingsVisibilitySource(),
    "utf8",
  );
  fs.writeFileSync(path.join(assets, "debug.js"), debugPanelSource(), "utf8");
  fs.writeFileSync(path.join(assets, "unrelated.js"), "const unrelated=true", "utf8");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { assets, root };
}

test("official Linux node-hid is reused without a native binding descriptor", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    "linux-hid-hotplug",
    "webview-feature-gate",
  ]);
});

test("Codex Micro feature gate patches every current callsite", () => {
  const currentContracts = [
    [appShellSource(), appShellContract],
    [settingsVisibilitySource(), settingsContract],
    [debugPanelSource(), debugPanelContract],
  ];

  let patchedCallsites = 0;
  for (const [source, contract] of currentContracts) {
    const patched = applyCodexMicroFeatureGatePatch(source, contract);
    assert.equal(
      matchesCodexMicroFeatureGateContract(source, contract),
      true,
    );
    assert.equal(patched.includes(CODEX_MICRO_GATE_ID), false);
    assert.equal(
      patched.split(CODEX_MICRO_GATE_MARKER).length - 1,
      contract.gateCount,
    );
    patchedCallsites += contract.gateCount;
    assert.doesNotThrow(() => new Function(patched));
    assert.equal(
      matchesCodexMicroFeatureGateContract(patched, contract),
      true,
    );
    assert.equal(
      applyCodexMicroFeatureGatePatch(patched, contract),
      patched,
    );
  }
  assert.equal(patchedCallsites, 7);
});

test("Codex Micro feature gate rejects incomplete or drifted contracts", () => {
  const marker = `!0/*${CODEX_MICRO_GATE_MARKER}*/`;
  const cases = {
    incomplete: appShellSource(4),
    member: appShellSource().replace(
      "gg(`3207467860`)",
      "gates.gg(`3207467860`)",
    ),
    duplicate: `${appShellSource()};const extra=\`3207467860\``,
    mixed: appShellSource()
      .replace("gg(`3207467860`)", marker),
    malformedPatched: applyCodexMicroFeatureGatePatch(
      appShellSource(),
      appShellContract,
    ).replace(marker, `false/*${CODEX_MICRO_GATE_MARKER}*/`),
  };

  for (const [name, source] of Object.entries(cases)) {
    assert.equal(
      matchesCodexMicroFeatureGateContract(source, appShellContract),
      false,
      `${name} must not match the asset contract`,
    );
    assert.equal(
      applyCodexMicroFeatureGatePatch(source, appShellContract),
      source,
      `${name} must remain byte-identical`,
    );
  }
});

test("Codex Micro feature gate discovers and patches all current semantic bundles", (t) => {
  const { assets, root } = createExtractedApp(t);
  const discovery = findCodexMicroFeatureGateAssets(root);
  assert.equal(discovery.reason, null);
  assert.deepEqual(
    discovery.matches.map(({ assetName }) => assetName).sort(),
    ["debug.js", "settings.js", "shell.js"],
  );

  const result = patchCodexMicroFeatureGateAssets(root);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 3);
  const patched = ["debug.js", "settings.js", "shell.js"]
    .map((name) => fs.readFileSync(path.join(assets, name), "utf8"))
    .join(";");
  assert.equal(patched.includes(CODEX_MICRO_GATE_ID), false);
  assert.equal(
    patched.split(CODEX_MICRO_GATE_MARKER).length - 1,
    7,
  );
  assert.deepEqual(patchCodexMicroFeatureGateAssets(root), {
    matched: 1,
    changed: 0,
    reason: null,
    targets: ["shell.js", "settings.js", "debug.js"],
  });
});

test("Codex Micro feature gate fails closed on an extra current callsite", (t) => {
  const { assets, root } = createExtractedApp(t);
  fs.writeFileSync(
    path.join(assets, "drift.js"),
    "const unexpected=gg(`3207467860`)",
    "utf8",
  );
  const result = patchCodexMicroFeatureGateAssets(root);
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /Found 4 Codex Micro feature-gate bundles/);
  assert.equal(
    fs.readFileSync(path.join(assets, "shell.js"), "utf8"),
    appShellSource(),
  );
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
