"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { applyForkSidebarFallback } = require("./patch.js");

// Reduced background settings owner from the current official Linux package.
const READER = 'read:e=>(p(),"sidebarCustomSectionsEnabled"===e)?null!=d():' +
  'i.getReadyClient()?.checkGate("codex-app-server-custom-sections")';
const FIXTURE = `function settings(){return{readExperimentPersonality(){return null},${READER}}}`;

function settings(source, { client, accountId = null, assertCurrent = () => {} } = {}) {
  return Function("p", "d", "i", `${source};return settings()`)(
    assertCurrent, () => accountId, { getReadyClient: () => client },
  );
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

test("an unavailable sidebar rollout no longer leaves fork placement not-ready", () => {
  const forkStatus = (reader) => reader.read("sidebarCustomSectionsEnabled") === undefined ||
    reader.read("useAppServerCustomSections") === undefined
    ? "execution-config-loading" : "ready";
  assert.equal(forkStatus(settings(FIXTURE)), "execution-config-loading");
  const patched = settings(applyForkSidebarFallback(FIXTURE));
  assert.equal(patched.read("useAppServerCustomSections"), false);
  assert.equal(forkStatus(patched), "ready");
});

test("ready rollout values and local section eligibility retain their meaning", () => {
  for (const enabled of [false, true]) {
    for (const accountId of [null, "account-1"]) {
      const gateCalls = [];
      const reader = settings(applyForkSidebarFallback(FIXTURE), {
        accountId,
        client: { checkGate: (key) => { gateCalls.push(key); return enabled; } },
      });
      assert.equal(reader.read("sidebarCustomSectionsEnabled"), accountId != null);
      assert.deepEqual(gateCalls, []);
      assert.equal(reader.read("useAppServerCustomSections"), enabled);
      assert.deepEqual(gateCalls, ["codex-app-server-custom-sections"]);
    }
  }
});

test("the same reader observes a rollout client becoming ready later", () => {
  let client;
  const reader = Function("p", "d", "i", `${applyForkSidebarFallback(FIXTURE)};return settings()`)(
    () => {}, () => "account-1", { getReadyClient: () => client },
  );
  assert.equal(reader.read("useAppServerCustomSections"), false);
  client = { checkGate: () => true };
  assert.equal(reader.read("useAppServerCustomSections"), true);
  client = { checkGate: () => false };
  assert.equal(reader.read("useAppServerCustomSections"), false);
});

test("retired-owner and rollout errors still propagate", () => {
  const failure = new Error("owner retired");
  const reader = settings(applyForkSidebarFallback(FIXTURE), {
    assertCurrent: () => { throw failure; },
  });
  assert.throws(() => reader.read("useAppServerCustomSections"), (error) => error === failure);
  const gateFailure = new Error("rollout failed");
  const failingGate = settings(applyForkSidebarFallback(FIXTURE), {
    client: { checkGate() { throw gateFailure; } },
  });
  assert.throws(() => failingGate.read("useAppServerCustomSections"), (error) => error === gateFailure);
});

test("patch changes only the fallback, survives renamed bindings, and is idempotent", () => {
  const renamed = FIXTURE.replaceAll("p()", "$assert()").replaceAll("d()", "$account()")
    .replaceAll("i.getReadyClient", "$rollout.getReadyClient").replaceAll("read:e", "read:$key")
    .replaceAll('===e)', '===$key)');
  for (const source of [FIXTURE, renamed]) {
    const patched = applyForkSidebarFallback(source);
    assert.equal(patched.replace("??!1", ""), source);
    assert.deepEqual(captureWarnings(() => applyForkSidebarFallback(patched)), {
      value: patched, warnings: [],
    });
  }
});

test("missing, ambiguous, partial, and drifted readers are preserved with a warning", () => {
  const patched = applyForkSidebarFallback(FIXTURE);
  for (const source of [
    "function unrelated(){}", FIXTURE + FIXTURE, patched + FIXTURE,
    patched.replace("??!1", "??!0"),
    FIXTURE.replace("codex-app-server-custom-sections", "other-gate"),
    FIXTURE.replace("getReadyClient()", "getClient()"),
    FIXTURE.replace("null!=d()", "d()"),
    FIXTURE + FIXTURE.replace("getReadyClient()", "getClient()"),
    patched + FIXTURE.replace("getReadyClient()", "getClient()"),
    FIXTURE + FIXTURE.replace("read:e=>", "read:(e)=>"),
    FIXTURE + FIXTURE.replace(READER, `read:e=>{return ${READER.slice(8)}}`),
  ]) {
    const result = captureWarnings(() => applyForkSidebarFallback(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
  }
});

test("feature is disabled by default and rejects ambiguous or drifted chunk sets before writing", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fork-sidebar-fallback-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const config = path.join(temp, "features.json");
  const options = { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config };
  fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
  assert.equal(loadLinuxFeaturePatchDescriptors(options).some((item) =>
    item.id === "feature:fork-sidebar-fallback:sidebar-settings"), false);
  fs.writeFileSync(config, JSON.stringify({ enabled: ["fork-sidebar-fallback"] }));
  const enabled = normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors(options));
  assert.equal(enabled.length, 1);
  const patched = applyForkSidebarFallback(FIXTURE);
  const drifted = FIXTURE.replace("getReadyClient()", "getClient()");
  const parenthesized = FIXTURE.replace("read:e=>", "read:(e)=>");
  const block = FIXTURE.replace(READER, `read:e=>{return ${READER.slice(8)}}`);
  const unrelated = "function other(){}";
  const build = path.join(temp, ".vite", "build");
  fs.mkdirSync(build, { recursive: true });
  const run = (sources) => {
    fs.rmSync(build, { recursive: true });
    fs.mkdirSync(build);
    const files = sources.map((source, index) => {
      const file = path.join(build, `early-bootstrap-${index}-abcdef.js`);
      fs.writeFileSync(file, source);
      return file;
    });
    const report = createPatchReport();
    report.enabledFeatures = ["fork-sidebar-fallback"];
    captureWarnings(() => applyExtractedAppPatchDescriptors(
      temp, enabled, {}, report, "extracted-app:pre-webview",
    ));
    return { report, sources: files.map((file) => fs.readFileSync(file, "utf8")) };
  };
  const applied = run([unrelated, FIXTURE]);
  assert.deepEqual(applied.sources, [unrelated, patched]);
  assert.equal(applied.report.patches[0].status, "applied");
  assert.deepEqual(enabledFeatureFailuresFromReport(applied.report), []);
  const repeated = run(applied.sources);
  assert.deepEqual(repeated.sources, applied.sources);
  assert.equal(repeated.report.patches[0].status, "already-applied");
  for (const sources of [
    [], [unrelated], [drifted], [FIXTURE, FIXTURE], [FIXTURE, drifted],
    [patched, FIXTURE], [patched, drifted], [patched, patched],
    [FIXTURE + drifted], [patched + drifted],
    [FIXTURE, parenthesized], [FIXTURE, block],
    [patched, parenthesized], [patched, block],
    [FIXTURE + parenthesized], [FIXTURE + block],
    [patched.replace("??!1", "??!0")],
  ]) {
    const rejected = run(sources);
    assert.deepEqual(rejected.sources, sources);
    assert.equal(enabledFeatureFailuresFromReport(rejected.report).length, 1);
  }
});

test("current signed official fork placement advances only after the sidebar fallback", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const dir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
  const owners = fs.readdirSync(dir).filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: fs.readFileSync(path.join(dir, name), "utf8") }))
    .filter(({ source }) => source.includes('"codex-app-server-custom-sections"'));
  assert.equal(owners.length, 1);
  const [{ source }] = owners;
  const { value: patched, warnings } = captureWarnings(() => applyForkSidebarFallback(source));
  assert.deepEqual(warnings, []);
  assert.notEqual(patched, source);
  assert.equal(patched.replace('checkGate("codex-app-server-custom-sections")??!1',
    'checkGate("codex-app-server-custom-sections")'), source);
  assert.equal(applyForkSidebarFallback(patched), patched);

  // Execute the shipped reader and placement function together, rather than
  // recreating the readiness condition in a fixture.
  const ident = String.raw`[A-Za-z_$][\w$]*`;
  const readerPattern = new RegExp(
    String.raw`read:(?<key>${ident})=>\((?<assertCurrent>${ident})\(\),"sidebarCustomSectionsEnabled"===\k<key>\)` +
      String.raw`\?null!=(?<accountId>${ident})\(\):(?<evaluations>${ident})\.getReadyClient\(\)` +
      String.raw`\?\.checkGate\("codex-app-server-custom-sections"\)(?:\?\?!1)?`,
    "g",
  );
  const placementMatches = [...source.matchAll(new RegExp(
    String.raw`readPlacement:${ident}=>\((?<placement>function\([^)]*\)\{.*?)\)\(${ident},${ident}\),prependProjectThread:`,
    "gs",
  ))];
  assert.equal(placementMatches.length, 1);
  const placementSource = placementMatches[0].groups.placement;
  const schemaNames = [...new Set([...placementSource.matchAll(new RegExp(
    String.raw`(${ident})\.(?:safeParse|object)\(`, "g",
  ))].map((match) => match[1]))];
  assert.equal(schemaNames.length, 2);
  const schema = {
    safeParse: (value) => ({ data: value }),
    optional: () => ({}),
    object: () => schema,
  };
  const readPlacement = Function(...schemaNames, `return (${placementSource})`)(...schemaNames.map(() => schema));
  for (const [candidate, expected] of [[source, "not-ready"], [patched, "ready"]]) {
    const readers = [...candidate.matchAll(readerPattern)];
    assert.equal(readers.length, 1);
    const [reader] = readers;
    const { assertCurrent, accountId, evaluations } = reader.groups;
    const read = Function(assertCurrent, accountId, evaluations, `return ({${reader[0]}}).read`)(
      () => {}, () => null, { getReadyClient: () => undefined },
    );
    const storageReads = [];
    const result = readPlacement({
      readSetting: read,
      accountId: () => null,
      storage: { readValue(key) { storageReads.push(key); } },
    }, "source-thread");
    assert.equal(result.status, expected);
    if (expected === "not-ready") {
      assert.equal(result.reason, "execution-config-loading");
      assert.deepEqual(storageReads, []);
    } else {
      assert.deepEqual(result.placement, { prependToManualProject: false, customSection: null });
      assert.deepEqual(storageReads, ["codex-sidebar-sort-mode-v1", "flat-project-sidebar-preferences-v1"]);
    }
  }
  const syntax = spawnSync(process.execPath, ["--check"], { input: patched, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});
