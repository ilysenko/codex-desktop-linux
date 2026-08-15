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
  PATCH_MARKER,
  applyBundledMarketplaceStagingCopyPermissions,
} = require("./patch.js");

const FEATURE_ID = "nix-store-bundled-marketplace-permissions";
const DESCRIPTOR_ID = `feature:${FEATURE_ID}:bundled-marketplace-staging-copy-permissions`;
const FIXTURE = `async function Mne(source,destination){if(S.default.platform===\`darwin\`){await ditto(\`ditto\`,[source,destination]);return}if(S.default.platform!==\`win32\`){await y.default.cp(source,destination,{recursive:!0,verbatimSymlinks:!0});return}let{copyDirectoryAllowDecryptedDestinationOnEncryptionFailure:copy}=await Promise.resolve().then(()=>require("./windows-file-copy-Bw9CB6bJ.js"));await copy({copy:()=>y.default.cp(source,destination,{recursive:!0,verbatimSymlinks:!0}),destination,source})}
async function copyPlugins(source,destination){const staging=\`openai-bundled.staging-\${randomUUID()}\`;const target=\`\${staging}/plugin\`;await Mne(source,target);return destination}`;

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

test("feature loads only when enabled with its prefixed optional descriptor", () => {
  assert.deepEqual(descriptorsFor([]), []);
  const [descriptor] = descriptorsFor([FEATURE_ID]);
  assert.equal(descriptor.id, DESCRIPTOR_ID);
  assert.equal(descriptor.sourceKind, "feature");
  assert.equal(descriptor.featureId, FEATURE_ID);
  assert.equal(descriptor.ciPolicy, "optional");
  assert.equal(descriptor.enforceWhenEnabled, false);
  assert.equal(descriptor.order, 20_170);
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

test("descriptor anchor is unique and patching is idempotent", () => {
  const patched = applyBundledMarketplaceStagingCopyPermissions(FIXTURE);
  assert.match(patched, new RegExp(PATCH_MARKER));
  assert.match(patched, /try\{await y\.default\.cp/);
  assert.equal(applyBundledMarketplaceStagingCopyPermissions(patched), patched);
  assert.throws(() => applyBundledMarketplaceStagingCopyPermissions(FIXTURE.replaceAll("ditto", "other")), /matched 0 times/);
  assert.throws(() => applyBundledMarketplaceStagingCopyPermissions(`${FIXTURE}${FIXTURE.replaceAll("Mne", "Nne")}`), /matched 2 times/);
});

test("Computer Use composition has one Nix staging permission owner", () => {
  const descriptors = descriptorsFor(["computer-use-linux", FEATURE_ID]);
  const stagingDescriptors = descriptors.filter(({ id }) =>
    id.includes("staging") && id.includes("permission"));
  assert.deepEqual(stagingDescriptors.map(({ id }) => id), [DESCRIPTOR_ID]);
  assert.match(stagingDescriptors[0].apply(FIXTURE), new RegExp(PATCH_MARKER));
});

test("upstream drift is reported but does not fail enabled-feature acceptance", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-marketplace-drift-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const buildDir = path.join(root, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const mainPath = path.join(buildDir, "main-fixture.js");
  const drifted = FIXTURE.replaceAll("ditto", "other");
  fs.writeFileSync(mainPath, drifted);
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: [FEATURE_ID] }));

  const report = createPatchReport();
  patchExtractedApp(root, {
    report,
    featuresConfigPath: configPath,
    featuresRoot: path.resolve(__dirname, ".."),
    internalFeatureIds: [FEATURE_ID],
  });

  const [entry] = report.patches;
  assert.equal(entry.name, DESCRIPTOR_ID);
  assert.equal(entry.status, "skipped-optional");
  assert.equal(entry.enforceWhenEnabled, false);
  assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
  assert.equal(optionalDriftFromReport(report).length, 1);
  assert.equal(reportHasPatchChanges(report), false);
  assert.equal(fs.readFileSync(mainPath, "utf8"), drifted);
});

test("missing main bundle is reported as best-effort drift", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nix-marketplace-missing-main-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({ enabled: [FEATURE_ID] }));
  const report = createPatchReport();

  patchExtractedApp(root, {
    report,
    featuresConfigPath: configPath,
    featuresRoot: path.resolve(__dirname, ".."),
    internalFeatureIds: [FEATURE_ID],
  });

  assert.equal(report.patches[0].name, DESCRIPTOR_ID);
  assert.equal(report.patches[0].status, "skipped-optional");
  assert.equal(report.patches[0].unavailable, true);
  assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
  assert.equal(optionalDriftFromReport(report).length, 1);
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
