"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createHash } = require("node:crypto");
const { isPatchIntegrityError } = require("../../scripts/patches/integrity-error.js");
const { applyExtractedAppPatchDescriptors, normalizeDescriptor } = require("../../scripts/patches/engine.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

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

const [
  appShellContract,
  sidebarContract,
  dictationContract,
  composerContract,
  settingsContract,
] = CODEX_MICRO_GATE_CONTRACTS;

function gate(namespace = "N") {
  return `(0,${namespace}.Zj)("3207467860")`;
}

function appShellSource(gates = 2) {
  return [
    'const onboarding={id:"codex-micro-onboarding"}',
    "const service=D.appServices.codexMicro",
    ...Array.from(
      { length: gates },
      (_, index) => `const gate${index}=${gate()}`,
    ),
  ].join(";");
}

function sidebarSource() {
  return [
    'const active=h.pathname.startsWith("/settings/codex-micro")',
    'const open=()=>{p("/settings/codex-micro")}',
    "const status=c.codexMicro",
    `const enabled=${gate("n3")}`,
  ].join(";");
}

function dictationSource(namespace = "Q") {
  return [
    "const micro={onCodexMicroStop:stopDictation}",
    "const props={onDictationTranscriptInsert:insert,waveformVariant:eZ}",
    `const enabled=${gate(namespace)}`,
  ].join(";");
}

function composerSource() {
  return `const request={surface:"composer"},mode={effectiveMode:"code"},enabled=${gate("t_")}`;
}

function settingsVisibilitySource() {
  return [
    'const sections={"codex-micro":true}',
    `function visible(section){let enabled=${gate("I")};switch(section){case"codex-micro":return enabled}}`,
  ].join(";");
}

const GATE_FIXTURES = {
  "async/216127.shell.js": () => appShellSource(),
  "async/91641.sidebar.js": () => sidebarSource(),
  "async/4317.dictation.js": () => dictationSource("Q"),
  "async/637431.dictation.js": () => dictationSource("W"),
  "async/589850.composer.js": () => composerSource(),
  "async/61039.settings.js": () => settingsVisibilitySource(),
};

function createExtractedApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-test-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  for (const [name, source] of Object.entries(GATE_FIXTURES)) {
    fs.writeFileSync(path.join(assets, name), source(), "utf8");
  }
  fs.writeFileSync(path.join(assets, "async", "1.unrelated.js"), "const unrelated=true", "utf8");
  fs.writeFileSync(
    path.join(assets, "async", "2.route-only.js"),
    'const route="/settings/codex-micro"',
    "utf8",
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { assets, root };
}

test("current dictation gate discovery requires the native Micro stop callback", (t) => {
  const app=createExtractedApp(t),target=path.join(app.assets,"async/4317.dictation.js");
  const native=fs.readFileSync(target,"utf8");
  fs.writeFileSync(target,native.replace("onCodexMicroStop:stopDictation","onUnrelatedStop:stopDictation")+";const retired={dictationSoundsEnabled:true}");
  const found=findCodexMicroFeatureGateAssets(app.root);
  assert.equal(found.matches,null);assert.match(found.reason,/matches 0 semantic contracts/);
  assert.equal(fs.readFileSync(target,"utf8"),native.replace("onCodexMicroStop:stopDictation","onUnrelatedStop:stopDictation")+";const retired={dictationSoundsEnabled:true}");
});

test("official Linux node-hid is reused without a native binding descriptor", () => {
  assert.deepEqual(descriptors.map((descriptor) => descriptor.id), [
    "linux-hid-hotplug",
    "webview-feature-gate",
  ]);
});

test("Codex Micro feature gate patches every current callsite", () => {
  const currentContracts = [
    [appShellSource(), appShellContract],
    [sidebarSource(), sidebarContract],
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
  for (const [source, contract] of currentContracts) {
    const owners = CODEX_MICRO_GATE_CONTRACTS.filter((expected) =>
      expected.anchor(source));
    assert.deepEqual(owners, [contract]);
  }
});

test("Codex Micro feature gate rejects incomplete or drifted contracts", () => {
  const marker = `!0/*${CODEX_MICRO_GATE_MARKER}*/`;
  const cases = {
    incomplete: appShellSource(1),
    member: appShellSource().replace(gate(), `gates${gate()}`),
    legacyTemplate: appShellSource().replace(gate(), "gg(`3207467860`)"),
    duplicate: `${appShellSource()};const extra="3207467860"`,
    mixed: appShellSource().replace(gate(), marker),
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

test("Codex Micro feature gate discovers and patches every rspack copy", (t) => {
  const { assets, root } = createExtractedApp(t);
  const owners = Object.keys(GATE_FIXTURES).sort();
  const discovery = findCodexMicroFeatureGateAssets(root);
  assert.equal(discovery.reason, null);
  assert.deepEqual(
    discovery.matches.map(({ assetName }) => assetName),
    owners,
  );

  const result = patchCodexMicroFeatureGateAssets(root);
  assert.equal(result.matched, 1);
  assert.equal(result.changed, owners.length);
  const patched = owners
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
    targets: owners,
  });
});

function gateDescriptorReport(root, context = {}) {
  const original = descriptors.find(descriptor => descriptor.id === "webview-feature-gate");
  const descriptor = normalizeDescriptor({
    ...original,
    id: "feature:codex-micro:webview-feature-gate",
    name: "feature:codex-micro:webview-feature-gate",
    featureId: "codex-micro",
    sourceKind: "feature",
  });
  const report = createPatchReport();
  report.enabledFeatures = ["codex-micro"];
  applyExtractedAppPatchDescriptors(root, [descriptor], context, report, descriptor.phase);
  return report;
}

function gateBytes(assets) {
  return Object.fromEntries(Object.keys(GATE_FIXTURES).sort().map(name =>
    [name, fs.readFileSync(path.join(assets, name))]));
}

test("all six gates roll back interrupted and silently corrupted writes, then retry completely", t => {
  for (const failure of ["interruption", "silent corruption"]) {
    for (let failAt = 1; failAt <= 6; failAt++) {
      const { assets, root } = createExtractedApp(t);
      const originals = gateBytes(assets);
      const unrelated = fs.readFileSync(path.join(assets, "async/1.unrelated.js"));
      let writes = 0;
      assert.throws(() => patchCodexMicroFeatureGateAssets(root, {
        writeFileSync(file, bytes) {
          writes++;
          if (writes === failAt && failure === "silent corruption") {
            fs.writeFileSync(file, "silently corrupted asset");
            return;
          }
          fs.writeFileSync(file, bytes);
          if (writes === failAt) throw new Error("interrupted gate write");
        },
      }), failure === "interruption" ? /interrupted gate write/ : /write byte verification failed/);
      assert.deepEqual(gateBytes(assets), originals, `${failure} at ${failAt}`);
      assert.deepEqual(fs.readFileSync(path.join(assets, "async/1.unrelated.js")), unrelated);
      const retried = patchCodexMicroFeatureGateAssets(root);
      assert.equal(retried.changed, 6);
      for (const match of findCodexMicroFeatureGateAssets(root).matches) {
        const before = originals[match.assetName].toString("utf8");
        assert.equal(match.source, applyCodexMicroFeatureGatePatch(before, match.expected));
      }
      assert.equal(patchCodexMicroFeatureGateAssets(root).changed, 0);
    }
  }
});

test("unverifiable rollback is fatal through the normal extracted-app descriptor phase", t => {
  for (const failure of ["throws", "silent"]) {
    const { assets, root } = createExtractedApp(t);
    const originals = gateBytes(assets);
    let writes = 0;
    assert.throws(() => gateDescriptorReport(root, {
      writeFileSync(file, bytes) {
        writes++;
        if (writes > 2) {
          if (failure === "throws") throw new Error("rollback denied");
          return;
        }
        fs.writeFileSync(file, bytes);
        if (writes === 2) throw new Error("interrupted second gate write");
      },
    }), error => isPatchIntegrityError(error) && /could not restore original bytes/.test(error.message));
    assert.notDeepEqual(gateBytes(assets), originals);
  }
});

test("a transaction refusing invalid generated syntax is never reported as already-applied", t => {
  const { assets, root } = createExtractedApp(t);
  const source = appShellSource().replace(gate(), "new " + gate());
  assert.doesNotThrow(() => new Function(source));
  fs.writeFileSync(path.join(assets, "async/216127.shell.js"), source);
  const originals = gateBytes(assets);
  assert.throws(() => patchCodexMicroFeatureGateAssets(root), /did not commit every prepared change/);
  assert.deepEqual(gateBytes(assets), originals);
  const report = gateDescriptorReport(root);
  assert.equal(report.patches[0].status, "skipped-optional");
  assert.match(report.patches[0].reason, /did not commit every prepared change/);
  assert.equal(enabledFeatureFailuresFromReport(report).length, 1);
  assert.deepEqual(gateBytes(assets), originals);
});

test("Codex Micro feature gate fails closed on an extra current callsite", (t) => {
  const { assets, root } = createExtractedApp(t);
  fs.writeFileSync(
    path.join(assets, "async", "3.drift.js"),
    `const unexpected=${gate()}`,
    "utf8",
  );
  const result = patchCodexMicroFeatureGateAssets(root);
  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /async\/3\.drift\.js matches 0 semantic contracts/);
  assert.equal(
    fs.readFileSync(path.join(assets, "async", "216127.shell.js"), "utf8"),
    appShellSource(),
  );
});

test("Codex Micro feature gate fails closed when a semantic owner disappears", (t) => {
  const { assets, root } = createExtractedApp(t);
  fs.rmSync(path.join(assets, "async", "589850.composer.js"));
  const result = patchCodexMicroFeatureGateAssets(root);
  assert.equal(result.matched, 0);
  assert.match(result.reason, /Found 0 current Codex Micro composer gate bundles/);
});

test(
  "signed upstream webview exposes every Codex Micro gate owner",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const discovery = findCodexMicroFeatureGateAssets(
      process.env.CODEX_SIGNED_EXTRACTED_APP,
    );
    assert.equal(discovery.reason, null);
    for (const expected of CODEX_MICRO_GATE_CONTRACTS) {
      assert.ok(discovery.matches.some((match) => match.expected === expected));
    }
    for (const match of discovery.matches) {
      assert.equal(match.contract.state, "unpatched");
      const patched = applyCodexMicroFeatureGatePatch(match.source, match.expected);
      assert.equal(patched.includes(CODEX_MICRO_GATE_ID), false);
      assert.equal(
        patched.split(CODEX_MICRO_GATE_MARKER).length - 1,
        match.expected.gateCount,
      );
    }
  },
);

test("the actual official six-asset descriptor preserves native output and becomes already-applied", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, t => {
  const originalRoot = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const { matches, reason } = findCodexMicroFeatureGateAssets(originalRoot);
  assert.equal(reason, null);
  assert.equal(matches.length, 6);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-signed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets");
  const originals = new Map();
  for (const match of matches) {
    const target = path.join(assets, match.assetName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, match.source);
    originals.set(match.assetName, createHash("sha256").update(match.source).digest("hex"));
  }
  const first = gateDescriptorReport(root);
  assert.equal(first.patches.length, 1);
  assert.equal(first.patches[0].status, "applied");
  for (const match of matches) {
    assert.equal(fs.readFileSync(path.join(assets, match.assetName), "utf8"),
      applyCodexMicroFeatureGatePatch(match.source, match.expected));
    assert.equal(createHash("sha256").update(fs.readFileSync(match.assetPath)).digest("hex"), originals.get(match.assetName));
  }
  const second = gateDescriptorReport(root);
  assert.equal(second.patches[0].status, "already-applied");
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
