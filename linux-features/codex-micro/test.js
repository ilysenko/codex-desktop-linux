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
  findCodexMicroServiceBundle,
  matchesCodexMicroFeatureGateContract,
  patchCodexMicroFeatureGateAssets,
  patchCodexMicroHotplugSource,
  patchCodexMicroService,
} = require("./patch.js");

const [appShellContract, dictationContract, composerContract, settingsContract] =
  CODEX_MICRO_GATE_CONTRACTS;

function appShellSource(gates = 3) {
  return [
    "const onboarding=`codex-micro-onboarding-host-current.js`",
    "const bridge=`codex-micro-bridge-current.js`",
    "const service=`codexMicro.currentService`",
    "const routes=[`/settings/codex-micro`,`/settings/codex-micro`]",
    ...Array.from(
      { length: gates },
      (_, index) => `const gate${index}=gg(\`3207467860\`)`,
    ),
  ].join(";");
}

function dictationSource() {
  return [
    "const route=`/settings/codex-micro`",
    "const onDictationTranscriptInsert=insert",
    "const waveformVariant=`compact`",
    "const enabled=gg(`3207467860`)",
  ].join(";");
}

function composerSource() {
  return "const request={surface:`composer`},mode={effectiveMode:`code`},enabled=gg(`3207467860`)";
}

function settingsVisibilitySource() {
  return [
    'const sections={"codex-micro":true}',
    "function visible(section){switch(section){case`codex-micro`:return gg(`3207467860`)}}",
  ].join(";");
}

function createExtractedApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-test-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "shell.js"), appShellSource(), "utf8");
  fs.writeFileSync(path.join(assets, "dictation.js"), dictationSource(), "utf8");
  fs.writeFileSync(path.join(assets, "composer.js"), composerSource(), "utf8");
  fs.writeFileSync(
    path.join(assets, "settings.js"),
    settingsVisibilitySource(),
    "utf8",
  );
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
    [dictationSource(), dictationContract],
    [composerSource(), composerContract],
    [settingsVisibilitySource(), settingsContract],
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
  assert.equal(patchedCallsites, 6);
});

test("Codex Micro feature gate rejects incomplete or drifted contracts", () => {
  const marker = `!0/*${CODEX_MICRO_GATE_MARKER}*/`;
  const cases = {
    incomplete: appShellSource(2),
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
    ["composer.js", "dictation.js", "settings.js", "shell.js"],
  );

  const result = patchCodexMicroFeatureGateAssets(root);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 4);
  const patched = ["composer.js", "dictation.js", "settings.js", "shell.js"]
    .map((name) => fs.readFileSync(path.join(assets, name), "utf8"))
    .join(";");
  assert.equal(patched.includes(CODEX_MICRO_GATE_ID), false);
  assert.equal(
    patched.split(CODEX_MICRO_GATE_MARKER).length - 1,
    6,
  );
  assert.deepEqual(patchCodexMicroFeatureGateAssets(root), {
    matched: 1,
    changed: 0,
    reason: null,
    targets: ["shell.js", "dictation.js", "composer.js", "settings.js"],
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
  assert.match(result.reason, /Found 5 Codex Micro feature-gate bundles/);
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

function codexMicroServiceChunk() {
  return [
    '"use strict";exports.ids=[683],exports.modules={55006(t,e,i){',
    "i.d(e,{CodexMicroService:()=>U});var a=i(4482);",
    "function u(t){return g().watch(t)}",
    "function g(){let p=[`hid-topology-watcher.node`,`hid_topology_watcher.node`];return p}",
    "async function f(){return await g().findCodexMicroInterfaces()}",
    "class U{scan(){this.scheduleTopologyFallbackScan()}}",
    "}};",
  ].join("");
}

function createMainProcessChunks(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-chunks-"));
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(
    path.join(buildDir, "early-bootstrap.js"),
    '"use strict";var m={4482(e){e.exports=require("electron")}};',
    "utf8",
  );
  fs.writeFileSync(
    path.join(buildDir, "early-bootstrap-916-0123456789abcdef.js"),
    '"use strict";exports.ids=[916],exports.modules={1(e,t,n){n.e(683).then(n.bind(n,55006))}};',
    "utf8",
  );
  fs.writeFileSync(
    path.join(buildDir, "early-bootstrap-683-fedcba9876543210.js"),
    codexMicroServiceChunk(),
    "utf8",
  );
  // The worker build is not a main-process chunk and must be ignored.
  fs.writeFileSync(
    path.join(buildDir, "worker.js"),
    codexMicroServiceChunk(),
    "utf8",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { buildDir, root };
}

test("Linux hot-plug watcher patches only the owning rspack chunk", (t) => {
  const { buildDir, root } = createMainProcessChunks(t);
  const discovery = findCodexMicroServiceBundle(root);
  assert.equal(discovery.reason, null);
  assert.equal(
    path.basename(discovery.target),
    "early-bootstrap-683-fedcba9876543210.js",
  );

  const result = patchCodexMicroService(root);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 1);
  assert.equal(
    result.target,
    path.join(".vite", "build", "early-bootstrap-683-fedcba9876543210.js"),
  );
  const patched = fs.readFileSync(
    path.join(buildDir, "early-bootstrap-683-fedcba9876543210.js"),
    "utf8",
  );
  assert.equal(patched.split(CODEX_MICRO_HOTPLUG_MARKER).length - 1, 1);
  assert.match(patched, /require\(`node:fs`\)\.watch\(`\/dev`/);
  assert.equal(
    fs.readFileSync(path.join(buildDir, "worker.js"), "utf8"),
    codexMicroServiceChunk(),
  );

  const again = patchCodexMicroService(root);
  assert.equal(again.matched, 1);
  assert.equal(again.changed, 0);
});

test("Linux hot-plug watcher fails closed on duplicate service chunks", (t) => {
  const { buildDir, root } = createMainProcessChunks(t);
  fs.writeFileSync(
    path.join(buildDir, "early-bootstrap-87-00112233445566aa.js"),
    codexMicroServiceChunk(),
    "utf8",
  );
  const result = patchCodexMicroService(root);
  assert.equal(result.matched, 0);
  assert.match(result.reason, /Found 2 current Codex Micro service bundles/);
});

test(
  "signed upstream main process exposes exactly one Codex Micro watcher chunk",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const root = process.env.CODEX_SIGNED_EXTRACTED_APP;
    const discovery = findCodexMicroServiceBundle(root);
    assert.equal(discovery.reason, null);
    assert.match(
      path.basename(discovery.target),
      /^early-bootstrap-\d+-[0-9a-f]+\.js$/,
    );
    assert.equal(discovery.result.changed, 1);
    assert.doesNotThrow(() => new Function(
      "exports",
      "require",
      "__filename",
      discovery.result.source,
    ));
  },
);
