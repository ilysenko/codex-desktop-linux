"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  featuresJsonSummary,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
  enabledFeatureFailuresFromReport,
  optionalDriftFromReport,
  reportHasPatchChanges,
} = require("../../scripts/lib/patch-report.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const {
  STAGING_PATCH_MARKER,
  EXECUTOR_PATCH_MARKER,
  HELPER_MARKER,
  applyBundledMarketplaceStagingCopyPermissions,
  applyExecutorPluginCopyPermissions,
} = require("./patch.js");

const FEATURE_ID = "nix-store-bundled-marketplace-permissions";
const STAGING_DESCRIPTOR_ID = `feature:${FEATURE_ID}:bundled-marketplace-staging-copy-permissions`;
const EXECUTOR_DESCRIPTOR_ID = `feature:${FEATURE_ID}:executor-plugin-copy-permissions`;
const STAGING_FIXTURE = `async function Mne(source,destination){if(S.default.platform===\`darwin\`){await ditto(\`ditto\`,[source,destination]);return}if(S.default.platform!==\`win32\`){await y.default.cp(source,destination,{recursive:!0,verbatimSymlinks:!0});return}let{copyDirectoryAllowDecryptedDestinationOnEncryptionFailure:copy}=await Promise.resolve().then(()=>require("./windows-file-copy-Bw9CB6bJ.js"));await copy({copy:()=>y.default.cp(source,destination,{recursive:!0,verbatimSymlinks:!0}),destination,source})}
async function copyPlugins(source,destination){const staging=\`openai-bundled.staging-\${randomUUID()}\`;const target=\`\${staging}/plugin\`;await Mne(source,target);return destination}`;
const EXECUTOR_FIXTURE = `async function executor({executorPluginRoot:destination,resourcesPath:resources}){let config=await lookup(resources);return config==null?null:(await y.default.cp(config.cwd,destination,{recursive:!0}),config.env={CODEX_APP_TOOLS_CALLER_HOST_ID:hostId},await y.default.writeFile(join(destination,\`.mcp.json\`),\`{}\`,\`utf8\`),destination)}`;
const FIXTURE = `${STAGING_FIXTURE}\n${EXECUTOR_FIXTURE}`;

function fakeFs({ cpError = null, chmodError = null, missing = false } = {}) {
  const nodes = new Map([
    ["destination", { kind: "directory", mode: 0o555, entries: ["nested", "file", "link", "special"] }],
    ["destination/nested", { kind: "directory", mode: 0o555, entries: [] }],
    ["destination/file", { kind: "file", mode: 0o444 }],
    ["destination/link", { kind: "symlink", mode: 0o777 }],
    ["destination/special", { kind: "special", mode: 0o600 }],
  ]);
  const fsPromises = {
    async cp() { if (cpError) throw cpError; },
    async lstat(target) {
      const node = missing ? null : nodes.get(target);
      if (node == null) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return {
        mode: node.mode,
        isDirectory: () => node.kind === "directory",
        isFile: () => node.kind === "file",
        isSymbolicLink: () => node.kind === "symlink",
      };
    },
    async chmod(target, mode) {
      if (chmodError) throw chmodError;
      nodes.get(target).mode = mode;
    },
    async readdir(target) { return [...nodes.get(target).entries]; },
  };
  return { fs: fsPromises, nodes };
}

function materialize(source, fsPromises) {
  const context = {
    S: { default: { platform: "linux" } },
    y: { default: fsPromises },
    randomUUID: () => "uuid",
  };
  vm.runInNewContext(`${source};globalThis.materialize=Mne;`, context);
  return context.materialize;
}

function descriptorsFor(enabled) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nix-marketplace-feature-"));
  const configPath = path.join(tempDir, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled }));
  try {
    return loadLinuxFeaturePatchDescriptors({
      featuresRoot: path.resolve(__dirname, ".."),
      featuresConfigPath: configPath,
      internalFeatureIds: enabled.includes(FEATURE_ID) ? [FEATURE_ID] : [],
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature loads only when enabled with both prefixed optional descriptors", () => {
  assert.deepEqual(descriptorsFor([]), []);
  const descriptors = descriptorsFor([FEATURE_ID]);
  assert.deepEqual(descriptors.map(({ id }) => id), [STAGING_DESCRIPTOR_ID, EXECUTOR_DESCRIPTOR_ID]);
  for (const [index, descriptor] of descriptors.entries()) {
    assert.equal(descriptor.sourceKind, "feature");
    assert.equal(descriptor.featureId, FEATURE_ID);
    assert.equal(descriptor.ciPolicy, "optional");
    assert.equal(descriptor.enforceWhenEnabled, false);
    assert.equal(descriptor.order, 20_170 + index);
  }
});

test("feature stays hidden from public configuration", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-marketplace-public-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: [FEATURE_ID] }));
  const featuresRoot = path.resolve(__dirname, "..");

  assert.throws(
    () => loadLinuxFeaturePatchDescriptors({ featuresRoot, featuresConfigPath: configPath }),
    /is internal and cannot be enabled through public feature configuration/,
  );
  assert.equal(featuresJsonSummary({ featuresRoot }).some(({ id }) => id === FEATURE_ID), false);
});

test("independent descriptors are idempotent and share one helper in either order", () => {
  const repairs = [applyBundledMarketplaceStagingCopyPermissions, applyExecutorPluginCopyPermissions];
  for (const order of [repairs, repairs.toReversed()]) {
    const patched = order.reduce((source, apply) => apply(source), FIXTURE);
    assert.match(patched, new RegExp(STAGING_PATCH_MARKER));
    assert.match(patched, new RegExp(EXECUTOR_PATCH_MARKER));
    assert.equal(patched.split(HELPER_MARKER).length - 1, 1);
    assert.equal(patched.split("async function codexLinuxMakeBundledPluginStageNodesWritable(").length - 1, 1);
    assert.equal(order.reduce((source, apply) => apply(source), patched), patched);
    assert.doesNotThrow(() => new vm.Script(patched));
  }
});

test("Computer Use composition has one Nix staging permission owner", () => {
  const descriptors = descriptorsFor(["computer-use-linux", FEATURE_ID]);
  const stagingDescriptors = descriptors.filter(({ id }) =>
    id.includes("staging") && id.includes("permission"));
  assert.deepEqual(stagingDescriptors.map(({ id }) => id), [STAGING_DESCRIPTOR_ID]);
  assert.match(stagingDescriptors[0].apply(FIXTURE), new RegExp(STAGING_PATCH_MARKER));
});

function patchFixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-marketplace-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const mainPath = path.join(buildDir, "main-fixture.js");
  fs.writeFileSync(mainPath, source);
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: [FEATURE_ID] }));

  const report = createPatchReport();
  patchExtractedApp(root, {
    report,
    corePatchRoot: path.join(root, "empty-core-registry"),
    featuresConfigPath: configPath,
    featuresRoot: path.resolve(__dirname, ".."),
    internalFeatureIds: [FEATURE_ID],
  });

  return { report, patched: fs.readFileSync(mainPath, "utf8") };
}

const stagingContracts = {
  valid: STAGING_FIXTURE,
  missing: STAGING_FIXTURE.replaceAll("ditto", "other"),
  duplicate: STAGING_FIXTURE + STAGING_FIXTURE.replaceAll("Mne", "Nne"),
};
const executorContracts = {
  valid: EXECUTOR_FIXTURE,
  missing: EXECUTOR_FIXTURE.replace("CODEX_APP_TOOLS_CALLER_HOST_ID", "CHANGED"),
  duplicate: EXECUTOR_FIXTURE + EXECUTOR_FIXTURE,
};
for (const [staging, stagingSource] of Object.entries(stagingContracts)) {
  for (const [executor, executorSource] of Object.entries(executorContracts)) {
    test(`runner isolates staging ${staging} and executor ${executor} contracts`, t => {
      const source = `${stagingSource}\n${executorSource}`;
      const { report, patched } = patchFixture(t, source);
      const contracts = [
        [STAGING_DESCRIPTOR_ID, STAGING_PATCH_MARKER, staging],
        [EXECUTOR_DESCRIPTOR_ID, EXECUTOR_PATCH_MARKER, executor],
      ];
      assert.equal(report.patches.length, 2);
      for (const [id, marker, state] of contracts) {
        const entry = report.patches.find(({ name }) => name === id);
        assert.equal(entry.status, state === "valid" ? "applied" : "skipped-optional");
        assert.equal(entry.enforceWhenEnabled, false);
        assert.equal(patched.includes(marker), state === "valid");
        if (state !== "valid") {
          assert.match(entry.reason, new RegExp(`contract matched ${state === "missing" ? 0 : 2} times`));
        }
      }
      const applied = contracts.filter(([, , state]) => state === "valid").length;
      assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
      assert.equal(optionalDriftFromReport(report).length, 2 - applied);
      assert.equal(reportHasPatchChanges(report), applied > 0);
      assert.equal(patched.split(HELPER_MARKER).length - 1, applied > 0 ? 1 : 0);
      if (applied === 0) assert.equal(patched, source);
      const second = patchFixture(t, patched);
      assert.equal(second.patched, patched);
      assert.deepEqual(second.report.patches.map(({ status }) => status),
        contracts.map(([, , state]) => state === "valid" ? "already-applied" : "skipped-optional"));
    });
  }
}

test("missing main bundle is reported as best-effort drift", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-marketplace-missing-main-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: [FEATURE_ID] }));
  const report = createPatchReport();

  patchExtractedApp(root, {
    report,
    corePatchRoot: path.join(root, "empty-core-registry"),
    featuresConfigPath: configPath,
    featuresRoot: path.resolve(__dirname, ".."),
    internalFeatureIds: [FEATURE_ID],
  });

  assert.deepEqual(report.patches.map(({ name }) => name), [STAGING_DESCRIPTOR_ID, EXECUTOR_DESCRIPTOR_ID]);
  for (const entry of report.patches) {
    assert.equal(entry.status, "skipped-optional");
    assert.equal(entry.unavailable, true);
  }
  assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
  assert.equal(optionalDriftFromReport(report).length, 2);
  assert.equal(reportHasPatchChanges(report), false);
});

test("finally repairs copied real files and directories, including after copy failure", async () => {
  const patched = applyBundledMarketplaceStagingCopyPermissions(FIXTURE);
  const copyError = new Error("copy failed");
  const { fs: fsPromises, nodes } = fakeFs({ cpError: copyError });
  await assert.rejects(materialize(patched, fsPromises)("source", "destination"), copyError);
  assert.equal(nodes.get("destination").mode, 0o755);
  assert.equal(nodes.get("destination/nested").mode, 0o755);
  assert.equal(nodes.get("destination/file").mode, 0o644);
  assert.equal(nodes.get("destination/link").mode, 0o777);
  assert.equal(nodes.get("destination/special").mode, 0o600);
});

test("missing copied destination is harmless and repair errors propagate", async () => {
  const patched = applyBundledMarketplaceStagingCopyPermissions(FIXTURE);
  const missing = fakeFs({ missing: true });
  await materialize(patched, missing.fs)("source", "destination");
  const repairError = new Error("chmod failed");
  const failing = fakeFs({ chmodError: repairError });
  await assert.rejects(materialize(patched, failing.fs)("source", "destination"), repairError);
});

test("executor refresh repairs read-only cache without changing source or symlink targets", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-executor-permissions-"));
  t.after(() => {
    for (const directory of [root, ...fs.readdirSync(root).map(name => path.join(root, name))]) {
      if (fs.statSync(directory).isDirectory()) fs.chmodSync(directory, 0o755);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "untouched"), "external", { mode: 0o444 });
  fs.chmodSync(outside, 0o555);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "plugin.json"), "new", { mode: 0o444 });
  fs.writeFileSync(path.join(source, ".mcp.json"), "source", { mode: 0o444 });
  fs.chmodSync(source, 0o555);
  fs.mkdirSync(destination);
  fs.writeFileSync(path.join(destination, "plugin.json"), "old", { mode: 0o444 });
  fs.writeFileSync(path.join(destination, ".mcp.json"), "old", { mode: 0o444 });
  fs.symlinkSync(outside, path.join(destination, "link"));
  fs.chmodSync(destination, 0o555);
  const context = {
    y: { default: fs.promises }, lookup: async () => ({ cwd: source }),
    hostId: "local", join: path.join,
  };
  vm.runInNewContext(`${applyExecutorPluginCopyPermissions(EXECUTOR_FIXTURE)};globalThis.copyExecutor=executor`, context);
  for (let attempt = 0; attempt < 2; attempt++) {
    await context.copyExecutor({ executorPluginRoot: destination, resourcesPath: "resources" });
    assert.equal(fs.readFileSync(path.join(destination, "plugin.json"), "utf8"), "new");
    assert.equal(fs.readFileSync(path.join(destination, ".mcp.json"), "utf8"), "{}");
    assert.ok(fs.statSync(destination).mode & 0o200);
    assert.ok(fs.statSync(path.join(destination, "plugin.json")).mode & 0o200);
    assert.ok(fs.lstatSync(path.join(destination, "link")).isSymbolicLink());
    assert.equal(fs.realpathSync(path.join(destination, "link")), outside);
  }
  assert.equal(fs.statSync(source).mode & 0o222, 0);
  assert.equal(fs.statSync(path.join(source, "plugin.json")).mode & 0o222, 0);
  assert.equal(fs.statSync(path.join(source, ".mcp.json")).mode & 0o222, 0);
  assert.equal(fs.readFileSync(path.join(source, ".mcp.json"), "utf8"), "source");
  assert.equal(fs.statSync(outside).mode & 0o222, 0);
  assert.equal(fs.statSync(path.join(outside, "untouched")).mode & 0o222, 0);
});
