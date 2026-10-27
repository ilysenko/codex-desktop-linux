#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  enabledFeatureIdsFromBuildInfo,
  disabledLinuxFeatureCleanupHooks,
  discoverLinuxFeatureManifests,
  enabledLinuxFeaturesConfig,
  enabledLinuxFeatureStageHooks,
  enabledLinuxFeaturePackageDependencies,
  enabledLinuxFeaturePackageFiles,
  enabledLinuxFeaturePackagePlan,
  loadLinuxFeaturePatchDescriptors,
  loadEnabledLinuxFeatures,
  linuxFeaturesConfig,
  restoreEnabledLinuxFeaturePackageResourcePermissions,
  stageEnabledLinuxFeaturePackageResources,
  stageEnabledLinuxFeatureInstall,
} = require("./linux-features.js");

const manifestCases = require("../../tests/fixtures/linux-features/manifest-validation.json");

test("internal accepts only omission or booleans for repository and local manifests", (t) => {
  for (const origin of ["repo", "local"]) {
    for (const scenario of manifestCases.internal) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-feature-internal-${origin}-${scenario.label}-`));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const featureDir = path.join(root, origin === "local" ? "local/probe" : "probe");
      fs.mkdirSync(featureDir, { recursive: true });
      const manifest = { id: "probe" };
      if (Object.prototype.hasOwnProperty.call(scenario, "value")) manifest.internal = scenario.value;
      fs.writeFileSync(path.join(featureDir, "feature.json"), JSON.stringify(manifest));
      fs.writeFileSync(path.join(featureDir, "README.md"), "# Internal fixture\n");
      if (scenario.error) {
        assert.throws(() => discoverLinuxFeatureManifests({ featuresRoot: root }), (failure) => {
          assert.ok(failure.message.includes(scenario.error), failure.message);
          return true;
        });
      } else {
        const [feature] = discoverLinuxFeatureManifests({ featuresRoot: root });
        assert.equal(feature.manifest.internal, scenario.value === true);
      }
    }
  }
});

test("defaultEnabled accepts only omission or boolean false for repository, local, and internal features", (t) => {
  for (const origin of ["repo", "local", "internal"]) {
    for (const scenario of manifestCases.defaultEnabled) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-feature-default-${origin}-${scenario.label}-`));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const featureDir = path.join(root, origin === "local" ? "local/probe" : "probe");
      fs.mkdirSync(featureDir, { recursive: true });
      const manifest = { id: "probe", internal: origin === "internal" };
      if (Object.prototype.hasOwnProperty.call(scenario, "value")) manifest.defaultEnabled = scenario.value;
      fs.writeFileSync(path.join(featureDir, "feature.json"), JSON.stringify(manifest));
      fs.writeFileSync(path.join(featureDir, "README.md"), "# Default fixture\n");
      fs.writeFileSync(path.join(root, "features.json"), '{"enabled":[]}');
      if (scenario.error) {
        assert.throws(() => discoverLinuxFeatureManifests({ featuresRoot: root }), (failure) => {
          assert.ok(failure.message.includes(scenario.error), failure.message);
          assert.match(failure.message, /probe/);
          return true;
        });
      } else {
        const [feature] = discoverLinuxFeatureManifests({ featuresRoot: root });
        assert.equal(feature.manifest.defaultEnabled, false);
        assert.deepEqual(loadEnabledLinuxFeatures({ featuresRoot: root }), []);
      }
    }
  }
});

test("feature IDs match their declaring directory in public, local, and alternate roots", (t) => {
  for (const scenario of manifestCases.directories) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-feature-directory-${scenario.label}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const featuresRoot = path.join(root, scenario.root ?? "linux-features");
    const featureDir = path.join(featuresRoot, scenario.directory);
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, "feature.json"), JSON.stringify({ id: scenario.id }));
    fs.writeFileSync(path.join(featureDir, "README.md"), "# Directory fixture\n");
    const config = path.join(featuresRoot, "features.json");
    fs.writeFileSync(config, JSON.stringify({ enabled: [scenario.id] }));
    if (scenario.error) {
      assert.throws(() => loadEnabledLinuxFeatures({ featuresRoot }), (failure) => {
        assert.ok(failure.message.includes(scenario.id), failure.message);
        assert.ok(failure.message.includes(path.basename(featureDir)), failure.message);
        assert.match(failure.message, /must match.*directory/);
        return true;
      });
    } else {
      const [feature] = loadEnabledLinuxFeatures({ featuresRoot });
      assert.equal(feature.id, scenario.id);
      assert.equal(feature.relativeDir, scenario.directory);
      const result = childProcess.spawnSync(process.execPath, [__dirname + "/linux-features.js", "--enabled-feature-dirs0"], {
        encoding: "utf8",
        env: { ...process.env, CODEX_LINUX_FEATURES_ROOT: featuresRoot, CODEX_LINUX_FEATURES_CONFIG: config },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${scenario.id}\0${scenario.directory}\0`);
    }
  }
});

test("directory matching uses the declaration path and preserves duplicate and reserved-directory rules", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-directory-rules-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresRoot = path.join(root, "features");
  const target = path.join(root, "differently-named-target");
  fs.mkdirSync(featuresRoot);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "feature.json"), '{"id":"linked"}');
  fs.writeFileSync(path.join(target, "README.md"), "# Linked\n");
  fs.symlinkSync(target, path.join(featuresRoot, "linked"));
  for (const name of [".ignored", "README.md"]) {
    fs.mkdirSync(path.join(featuresRoot, name));
    fs.writeFileSync(path.join(featuresRoot, name, "feature.json"), '{"id":"INVALID"}');
  }
  assert.deepEqual(discoverLinuxFeatureManifests({ featuresRoot }).map(({ id }) => id), ["linked"]);
  const localDir = path.join(featuresRoot, "local/linked");
  fs.mkdirSync(localDir, { recursive: true });
  fs.copyFileSync(path.join(target, "feature.json"), path.join(localDir, "feature.json"));
  fs.copyFileSync(path.join(target, "README.md"), path.join(localDir, "README.md"));
  assert.throws(() => discoverLinuxFeatureManifests({ featuresRoot }), /Duplicate Linux feature id 'linked'/);
});

test("manifest discovery validates entrypoint declarations without executing modules", (t) => {
  for (const { label, error, ...manifest } of manifestCases.entrypoints) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `codex-entrypoints-${label}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { featureDir, featuresRoot } = makeFeatureRoot(root, {
      id: "unsafe-link", ...manifest, featureOwned: { keep: true },
    });
    fs.writeFileSync(path.join(featureDir, "patch.js"), "throw Error('metadata discovery must not load modules');");
    const options = { featuresRoot };
    if (error) {
      for (const load of [discoverLinuxFeatureManifests, loadEnabledLinuxFeatures, loadLinuxFeaturePatchDescriptors]) {
        assert.throws(() => load(options), (failure) => {
          assert.ok(failure.message.includes(path.join(featureDir, "feature.json")), failure.message);
          assert.ok(failure.message.includes(error), failure.message);
          if (!error.includes("must be an object")) {
            assert.match(failure.message, /patchDescriptors, stageHook, cleanupHook/);
          }
          return true;
        });
      }
    } else {
      const [feature] = discoverLinuxFeatureManifests(options);
      assert.deepEqual(feature.manifest.featureOwned, { keep: true });
      assert.deepEqual(loadEnabledLinuxFeatures(options).map(({ id }) => id), ["unsafe-link"]);
    }
  }
});

test("stage and disabled cleanup entrypoints remain discoverable without executing hooks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-entrypoints-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link", entrypoints: { stageHook: "./stage.sh", cleanupHook: "./cleanup.sh" },
  });
  for (const name of ["stage.sh", "cleanup.sh"]) {
    fs.writeFileSync(path.join(featureDir, name), "exit 99\n");
  }
  assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot }), [
    { id: "unsafe-link", path: path.join(featureDir, "stage.sh") },
  ]);
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":[]}');
  assert.deepEqual(disabledLinuxFeatureCleanupHooks({ featuresRoot }), [
    { id: "unsafe-link", path: path.join(featureDir, "cleanup.sh") },
  ]);
});

test("known retired feature ids are ignored while arbitrary unknown ids fail", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-retired-feature-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresRoot = path.join(root, "linux-features");
  fs.mkdirSync(featuresRoot);
  const configPath = path.join(featuresRoot, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: [
      "codex-wrapper-updater",
      "conversation-delete",
      "conversation-mode",
      "deferred-update-build",
      "example-feature",
      "open-target-discovery",
      "ssh-command-wrapper",
      "x11-ewmh-computer-use",
      "zed-opener",
    ],
    settings: { "open-target-discovery": { stale: true } },
  }));

  assert.deepEqual(linuxFeaturesConfig({ featuresRoot, featuresConfigPath: configPath }), {
    enabled: [], settings: {}, configPath,
  });
  assert.deepEqual(loadEnabledLinuxFeatures({ featuresRoot, featuresConfigPath: configPath }), []);

  fs.writeFileSync(configPath, JSON.stringify({ enabled: ["open-target-discovry"] }));
  assert.throws(
    () => loadEnabledLinuxFeatures({ featuresRoot, featuresConfigPath: configPath }),
    /not found.*open-target-discovry/,
  );
});

test("enabled feature dependencies are added for persisted and explicit selections", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-dependency-closure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresRoot = path.join(root, "linux-features");
  const configPath = path.join(featuresRoot, "features.json");
  fs.mkdirSync(featuresRoot);
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled: ["recording"] })}\n`);
  for (const [id, requires] of [
    ["chronicle", []],
    ["recording", ["chronicle"]],
  ]) {
    const featureDir = path.join(featuresRoot, id);
    fs.mkdirSync(featureDir);
    fs.writeFileSync(path.join(featureDir, "README.md"), `# ${id}\n`);
    fs.writeFileSync(
      path.join(featureDir, "feature.json"),
      `${JSON.stringify({ id, title: id, requires }, null, 2)}\n`,
    );
  }

  assert.deepEqual(
    linuxFeaturesConfig({ featuresRoot, featuresConfigPath: configPath }).enabled,
    ["chronicle", "recording"],
  );
  assert.deepEqual(
    loadEnabledLinuxFeatures({ featuresRoot, enabledFeatureIds: ["recording"] })
      .map((feature) => feature.id),
    ["chronicle", "recording"],
  );
});

function makeFeatureRoot(root, featureManifest) {
  const featuresRoot = path.join(root, "linux-features");
  const featureDir = path.join(featuresRoot, "unsafe-link");
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["unsafe-link"]}\n');
  fs.writeFileSync(path.join(featureDir, "README.md"), "# Unsafe Link\n");
  fs.writeFileSync(path.join(featureDir, "feature.json"), `${JSON.stringify(featureManifest, null, 2)}\n`);
  return { featureDir, featuresRoot };
}

function makePackageFeatureRoot(root, featureManifest) {
  const id = "package-framework-fixture";
  const featuresRoot = path.join(root, "linux-features");
  const featureDir = path.join(featuresRoot, id);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}\n');
  fs.writeFileSync(path.join(featuresRoot, "features.json"), `{"enabled":["${id}"]}\n`);
  fs.writeFileSync(path.join(featureDir, "README.md"), "# Package Framework Fixture\n");
  fs.writeFileSync(
    path.join(featureDir, "feature.json"),
    `${JSON.stringify({ ...featureManifest, id, title: "Package Framework Fixture" }, null, 2)}\n`,
  );
  return { featureDir, featuresRoot, id };
}

function writeBuildInfoSnapshot(appDir, enabled) {
  const buildInfoPath = path.join(appDir, ".codex-linux", "build-info.json");
  fs.mkdirSync(path.dirname(buildInfoPath), { recursive: true });
  fs.writeFileSync(
    buildInfoPath,
    `${JSON.stringify({ schemaVersion: 1, linuxFeatures: { enabled } }, null, 2)}\n`,
  );
  return buildInfoPath;
}

function stageFeature(root, featuresRoot) {
  stageEnabledLinuxFeatureInstall(path.join(root, "app"), {
    featuresConfigPath: path.join(featuresRoot, "features.json"),
    featuresRoot,
  });
}

function writeStagedManifest(appDir, manifest) {
  const manifestPath = path.join(appDir, ".codex-linux", "linux-features-staged.json");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("Linux feature asset matchers receive feature settings", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-asset-match-context-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    entrypoints: { patchDescriptors: "./patch.js" },
  });
  fs.writeFileSync(
    path.join(featuresRoot, "features.json"),
    JSON.stringify({
      enabled: ["unsafe-link"],
      settings: { "unsafe-link": { expectedContract: "current-contract" } },
    }),
  );
  fs.writeFileSync(
    path.join(featureDir, "patch.js"),
    [
      "module.exports = [{",
      "  id: 'settings-aware-asset',",
      "  phase: 'webview-asset',",
      "  pattern: /^app-.*\\.js$/,",
      "  assetMatch: (source, assetName, context) =>",
      "    source === context.feature.settings.expectedContract && assetName === 'app-current.js',",
      "  apply: (source) => source,",
      "}];",
      "",
    ].join("\n"),
  );

  const [descriptor] = loadLinuxFeaturePatchDescriptors({ featuresRoot });
  assert.equal(descriptor.assetMatch("current-contract", "app-current.js", {}), true);
});

test("enabled patch descriptor load errors are fatal", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-invalid-descriptor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    entrypoints: { patchDescriptors: "./patch.js" },
  });
  const descriptorModule = path.join(__dirname, "..", "patches", "descriptor.js");
  fs.writeFileSync(
    path.join(featureDir, "patch.js"),
    [
      `const { mainBundlePatch } = require(${JSON.stringify(descriptorModule)});`,
      "module.exports = mainBundlePatch({",
      "  id: 'invalid-required-bypass',",
      "  ciPolicy: 'required-upstream',",
      "  enforceWhenEnabled: false,",
      "  apply: (source) => source,",
      "});",
      "",
    ].join("\n"),
  );

  assert.throws(
    () => loadLinuxFeaturePatchDescriptors({ featuresRoot }),
    /Could not load Linux feature 'unsafe-link' patchDescriptors:.*only with ciPolicy 'optional'/,
  );
});

test("Linux feature staging rejects duplicate resource targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-duplicate-resource-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const appDir = path.join(root, "app");
  const preservedTarget = ".codex-linux/features/preserved/payload.txt";
  const target = ".codex-linux/features/unsafe-link/payload.txt";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      { source: "first.txt", target, mode: "0644" },
      { source: "second.txt", target, mode: "0644" },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "first.txt"), "first\n");
  fs.writeFileSync(path.join(featureDir, "second.txt"), "second\n");
  fs.mkdirSync(path.dirname(path.join(appDir, preservedTarget)), { recursive: true });
  fs.writeFileSync(path.join(appDir, preservedTarget), "preserved\n");
  writeStagedManifest(appDir, {
    version: 1,
    resources: [{ id: "preserved", type: "resource", target: preservedTarget, mode: "0644" }],
    runtimeHooks: [],
  });

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /duplicate Linux feature install target/i,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
  assert.equal(fs.readFileSync(path.join(appDir, preservedTarget), "utf8"), "preserved\n");
});

test("Linux feature staging rejects ancestor and descendant target overlaps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-target-overlap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const parentTarget = ".codex-linux/features/unsafe-link/payload";
  const childTarget = `${parentTarget}/nested.txt`;
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      { source: "payload", target: parentTarget, mode: "0644" },
      { source: "nested.txt", target: childTarget, mode: "0644" },
    ],
  });
  fs.mkdirSync(path.join(featureDir, "payload"));
  fs.writeFileSync(path.join(featureDir, "payload", "nested.txt"), "parent\n");
  fs.writeFileSync(path.join(featureDir, "nested.txt"), "child\n");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /overlapping Linux feature install target/i,
  );
  assert.equal(fs.existsSync(path.join(root, "app", parentTarget)), false);
});

test("Linux feature staging rejects resource and runtime hook target collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-hook-collision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = ".codex-linux/prelaunch.d/unsafe-link-hook.sh";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      { source: "payload.sh", target, mode: "0755" },
    ],
    runtimeHooks: {
      prelaunch: { source: "hook.sh", name: "hook.sh", mode: "0755" },
    },
  });
  fs.writeFileSync(path.join(featureDir, "payload.sh"), "resource\n");
  fs.writeFileSync(path.join(featureDir, "hook.sh"), "hook\n");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /duplicate Linux feature install target/i,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
});

test("Linux feature staging rejects framework manifest targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-manifest-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = ".codex-linux/linux-features-staged.json";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [{ source: "payload.json", target, mode: "0644" }],
  });
  fs.writeFileSync(path.join(featureDir, "payload.json"), "payload\n");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /Linux feature staging framework/,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
});

test("Linux feature staging rejects normalized target aliases across features", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-cross-feature-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = ".codex-linux/features/shared/payload.txt";
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [{ source: "first.txt", target, mode: "0644" }],
  });
  const secondFeatureDir = path.join(featuresRoot, "second");
  fs.mkdirSync(secondFeatureDir);
  fs.writeFileSync(path.join(featureDir, "first.txt"), "first\n");
  fs.writeFileSync(path.join(secondFeatureDir, "README.md"), "# Second\n");
  fs.writeFileSync(path.join(secondFeatureDir, "second.txt"), "second\n");
  fs.writeFileSync(path.join(secondFeatureDir, "feature.json"), `${JSON.stringify({
    id: "second",
    title: "Second",
    resources: [{ source: "second.txt", target: ".codex-linux\\features\\shared\\payload.txt", mode: "0644" }],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["unsafe-link","second"]}\n');

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /feature 'second'.*feature 'unsafe-link'/,
  );
  assert.equal(fs.existsSync(path.join(root, "app", target)), false);
});

test("Linux feature staging rejects symlinked resource sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload-link",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");
  fs.symlinkSync(outside, path.join(featureDir, "payload-link"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must not contain symbolic links/,
  );
  assert.equal(
    fs.existsSync(path.join(root, "app", ".codex-linux", "features", "unsafe-link", "payload.txt")),
    false,
  );
});

test("Linux feature staging rejects symlinked install target parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const appDir = path.join(root, "app");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload.txt",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux", "features"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "features", "unsafe-link"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must stay inside the install directory/,
  );
  assert.equal(fs.existsSync(path.join(outside, "payload.txt")), false);
});

test("Linux feature staging rejects symlinked install target ancestors before creating parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-target-ancestor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const appDir = path.join(root, "app");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload.txt",
        target: ".codex-linux/features/unsafe-link/nested/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux", "features"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "features", "unsafe-link"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must (stay inside the install directory|not contain symbolic links)/,
  );
  assert.equal(fs.existsSync(path.join(outside, "nested")), false);
});

test("Linux feature staging does not clean stale manifest targets through symlinked parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-manifest-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const appDir = path.join(root, "app");
  const { featureDir, featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
    resources: [
      {
        source: "payload.txt",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux", "features"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "features", "unsafe-link"), "junction");
  writeStagedManifest(appDir, {
    version: 1,
    resources: [
      {
        id: "unsafe-link",
        type: "resource",
        target: ".codex-linux/features/unsafe-link/payload.txt",
        mode: "0644",
      },
    ],
    runtimeHooks: [],
  });

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must (stay inside the install directory|not contain symbolic links)/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "payload.txt"), "utf8"), "outside\n");
});

test("Linux feature staging does not clean legacy hooks through symlinked hook dirs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-symlink-hook-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside-hooks");
  const appDir = path.join(root, "app");
  const { featuresRoot } = makeFeatureRoot(root, {
    id: "unsafe-link",
    title: "Unsafe Link",
  });
  fs.mkdirSync(path.join(appDir, ".codex-linux"), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "unsafe-link-old-hook.sh"), "outside\n");
  fs.symlinkSync(outside, path.join(appDir, ".codex-linux", "prelaunch.d"), "junction");

  assert.throws(
    () => stageFeature(root, featuresRoot),
    /must (stay inside the install directory|not contain symbolic links)/,
  );
  assert.equal(fs.readFileSync(path.join(outside, "unsafe-link-old-hook.sh"), "utf8"), "outside\n");
});

test("disabled Linux features do not add package resources or dependencies", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-disabled-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      {
        source: "fixture.txt",
        target: "usr/share/codex-package-framework/fixture.txt",
        mode: "0644",
        formats: ["deb", "rpm", "pacman"],
      },
    ],
    packageDependencies: {
      deb: ["fixture-deb-runtime"],
      rpm: ["fixture-rpm-runtime"],
      pacman: ["fixture-pacman-runtime"],
    },
  });
  fs.writeFileSync(path.join(featureDir, "fixture.txt"), "fixture payload\n");
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":[]}\n');

  const options = { featuresRoot, packageFormat: "deb" };
  assert.deepEqual(enabledLinuxFeaturePackagePlan(options), {
    resources: [],
    dependencies: [],
  });
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(options), []);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(options), []);

  const packageRoot = path.join(root, "package-root");
  fs.mkdirSync(packageRoot);
  fs.writeFileSync(path.join(packageRoot, "sentinel"), "preserved\n");
  assert.deepEqual(stageEnabledLinuxFeaturePackageResources(packageRoot, options), {
    resources: [],
    dependencies: [],
  });
  assert.deepEqual(fs.readdirSync(packageRoot), ["sentinel"]);
});

test("enabled Linux features stage package resources with exact modes and reject payload collisions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-stage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const target = "usr/share/codex-package-framework/fixture.txt";
  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      {
        source: "fixture.txt",
        target,
        mode: "0640",
        formats: ["deb", "rpm"],
      },
    ],
    packageDependencies: {
      deb: ["fixture-deb-runtime"],
      rpm: ["fixture-rpm-runtime"],
      pacman: ["fixture-pacman-runtime"],
    },
  });
  const payload = "fixture payload\n";
  fs.writeFileSync(path.join(featureDir, "fixture.txt"), payload);

  const options = { featuresRoot, packageFormat: "deb" };
  const plan = enabledLinuxFeaturePackagePlan(options);
  assert.deepEqual(plan.dependencies, ["fixture-deb-runtime"]);
  assert.equal(plan.resources.length, 1);
  assert.equal(plan.resources[0].id, "package-framework-fixture");
  assert.equal(plan.resources[0].target, target);
  assert.equal(plan.resources[0].mode, 0o640);
  assert.deepEqual(plan.resources[0].formats, ["deb", "rpm"]);
  const packageRoot = path.join(root, "package-root");
  assert.deepEqual(stageEnabledLinuxFeaturePackageResources(packageRoot, options), plan);
  const stagedTarget = path.join(packageRoot, target);
  assert.equal(fs.readFileSync(stagedTarget, "utf8"), payload);
  assert.equal(fs.statSync(stagedTarget).mode & 0o777, 0o640);

  fs.writeFileSync(stagedTarget, "tampered\n");
  fs.chmodSync(stagedTarget, 0o777);
  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(packageRoot, options),
    /conflicts with existing package payload/i,
  );
  assert.equal(fs.readFileSync(stagedTarget, "utf8"), "tampered\n");
  assert.equal(fs.statSync(stagedTarget).mode & 0o777, 0o777);
});

test("Linux feature package dependencies and files are sorted, deduplicated, and format-specific", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-lists-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      {
        source: "90-last.txt",
        target: "usr/share/codex-package-framework/90-last.txt",
        formats: ["rpm", "deb", "deb"],
      },
      {
        source: "70-first.txt",
        target: "etc/codex-package-framework/70-first.txt",
        formats: ["deb"],
      },
      {
        source: "80-shared.txt",
        target: "usr/share/codex-package-framework/80-shared.txt",
      },
    ],
    packageDependencies: {
      deb: ["zlib1g", "fixture-deb-runtime", "zlib1g"],
      rpm: ["zlib", "fixture-rpm-runtime", "zlib"],
      pacman: ["zlib", "fixture-pacman-runtime", "zlib"],
    },
  });
  for (const name of ["90-last.txt", "70-first.txt", "80-shared.txt"]) {
    fs.writeFileSync(path.join(featureDir, name), `${name}\n`);
  }

  const debOptions = { featuresRoot, packageFormat: "deb" };
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(debOptions), ["fixture-deb-runtime", "zlib1g"]);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(debOptions), [
    "/etc/codex-package-framework/70-first.txt",
    "/usr/share/codex-package-framework/80-shared.txt",
    "/usr/share/codex-package-framework/90-last.txt",
  ]);
  assert.deepEqual(
    enabledLinuxFeaturePackagePlan(debOptions).resources.map((resource) => resource.target),
    [
      "etc/codex-package-framework/70-first.txt",
      "usr/share/codex-package-framework/80-shared.txt",
      "usr/share/codex-package-framework/90-last.txt",
    ],
  );

  const rpmOptions = { featuresRoot, packageFormat: "rpm" };
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(rpmOptions), ["fixture-rpm-runtime", "zlib"]);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(rpmOptions), [
    "/usr/share/codex-package-framework/80-shared.txt",
    "/usr/share/codex-package-framework/90-last.txt",
  ]);

  const pacmanOptions = { featuresRoot, packageFormat: "pacman" };
  assert.deepEqual(enabledLinuxFeaturePackageDependencies(pacmanOptions), ["fixture-pacman-runtime", "zlib"]);
  assert.deepEqual(enabledLinuxFeaturePackageFiles(pacmanOptions), [
    "/usr/share/codex-package-framework/80-shared.txt",
  ]);
});

test("Linux feature package resources reject traversal and package-root targets", () => {
  const cases = [
    { target: ".", error: /must not target the package root/i },
    { target: "./", error: /must not target the package root/i },
    { target: "../escape.txt", error: /must stay inside the package root/i },
    { target: "usr/share/codex/../../escape.txt", error: /must stay inside the package root/i },
    { target: "DEBIAN", error: /reserved Debian control namespace/i },
    { target: "DEBIAN/preinst", error: /reserved Debian control namespace/i },
    { target: ".PKGINFO", format: "pacman", error: /reserved pacman package namespace/i },
    { target: ".BUILDINFO", format: "pacman", error: /reserved pacman package namespace/i },
    { target: ".MTREE", format: "pacman", error: /reserved pacman package namespace/i },
    { target: ".INSTALL", format: "pacman", error: /reserved pacman package namespace/i },
    { target: ".CHANGELOG", format: "pacman", error: /reserved pacman package namespace/i },
    { target: ".INSTALL/hooks", format: "pacman", error: /reserved pacman package namespace/i },
    { target: "usr/share/codex-package-framework/bad\npath.txt", error: /unsafe package path component/i },
    { target: "usr/%{_libdir}/bad.txt", error: /unsafe package path component/i },
    { target: "usr/share/codex-package-framework/*.txt", error: /unsafe package path component/i },
    { target: "usr/share/codex-package-framework/-bad.txt", error: /unsafe package path component/i },
  ];

  for (const { target, format = "deb", error } of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-target-"));
    try {
      const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
        id: "package-framework-fixture",
        title: "Package Framework Fixture",
        packageResources: [{ source: "payload.txt", target, mode: "0644", formats: [format] }],
      });
      fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");

      assert.throws(
        () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: format }),
        error,
        target,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Linux feature package resources reject ancestor and descendant target overlaps", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-overlap-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      { source: "parent.txt", target: "usr/share/package-framework-fixture", mode: "0644", formats: ["deb"] },
      { source: "child.txt", target: "usr/share/package-framework-fixture/child.txt", mode: "0644", formats: ["deb"] },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "parent.txt"), "parent\n");
  fs.writeFileSync(path.join(featureDir, "child.txt"), "child\n");

  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
    /overlapping Linux feature package target/i,
  );
});

test("Linux feature package resources cannot target the packaged app directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-app-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featureDir, featuresRoot, id } = makePackageFeatureRoot(root, {
    packageResources: [
      {
        source: "payload.txt",
        target: "opt/codex-desktop/feature-owned.txt",
        mode: "0644",
        formats: ["deb"],
      },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  const packageRoot = path.join(root, "package-root");
  const appDir = path.join(packageRoot, "opt", "codex-desktop");
  writeBuildInfoSnapshot(appDir, [id]);

  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(
      packageRoot,
      { appDir, featuresRoot, packageFormat: "deb" },
    ),
    /must stay outside the packaged app directory/i,
  );
  assert.equal(fs.existsSync(path.join(appDir, "feature-owned.txt")), false);
});

test("Linux feature package resources cannot target an ancestor of the packaged app directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-app-ancestor-target-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featureDir, featuresRoot, id } = makePackageFeatureRoot(root, {
    packageResources: [
      {
        source: "payload.txt",
        target: "opt",
        mode: "0644",
        formats: ["deb"],
      },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  const packageRoot = path.join(root, "package-root");
  const appDir = path.join(packageRoot, "opt", "codex-desktop");
  const buildInfoPath = writeBuildInfoSnapshot(appDir, [id]);

  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(
      packageRoot,
      { appDir, featuresRoot, packageFormat: "deb" },
    ),
    /must stay outside the packaged app directory/i,
  );
  assert.equal(fs.existsSync(buildInfoPath), true);
});

test("Linux feature package resources must use regular file sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-source-type-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    packageResources: [
      {
        source: "payload",
        target: "usr/share/codex-package-framework/payload",
        mode: "0644",
        formats: ["deb"],
      },
    ],
  });
  fs.mkdirSync(path.join(featureDir, "payload"));
  fs.writeFileSync(path.join(featureDir, "payload", "nested.txt"), "nested\n");

  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
    /source must be a regular file/i,
  );
});

test("Linux feature package staging rejects symlinked resource sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-source-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside.txt");
  const target = "usr/share/codex-package-framework/fixture.txt";
  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      { source: "payload-link.txt", target, mode: "0644", formats: ["deb"] },
    ],
  });
  fs.writeFileSync(outside, "outside\n");
  fs.symlinkSync(outside, path.join(featureDir, "payload-link.txt"));

  const packageRoot = path.join(root, "package-root");
  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(packageRoot, { featuresRoot, packageFormat: "deb" }),
    /must not contain symbolic links/i,
  );
  assert.equal(fs.existsSync(path.join(packageRoot, target)), false);
});

test("Linux feature package staging rejects symlinked source ancestors", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-source-ancestor-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const target = "usr/share/codex-package-framework/fixture.txt";
  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      { source: "linked/payload.txt", target, mode: "0644", formats: ["deb"] },
    ],
  });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "payload.txt"), "outside\n");
  fs.symlinkSync(outside, path.join(featureDir, "linked"), "junction");

  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
    /must not contain symbolic links/i,
  );
});

test("Linux feature package staging rejects symlinked target parents", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-target-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside");
  const packageRoot = path.join(root, "package-root");
  const target = "usr/share/codex-package-framework/fixture.txt";
  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    id: "package-framework-fixture",
    title: "Package Framework Fixture",
    packageResources: [
      { source: "payload.txt", target, mode: "0644", formats: ["deb"] },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.mkdirSync(path.join(packageRoot, "usr", "share"), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(packageRoot, "usr", "share", "codex-package-framework"), "junction");

  assert.throws(
    () => stageEnabledLinuxFeaturePackageResources(packageRoot, { featuresRoot, packageFormat: "deb" }),
    /must (stay inside the package root|not contain symbolic links)/i,
  );
  assert.equal(fs.existsSync(path.join(outside, "fixture.txt")), false);
});

test("Linux feature package permission restoration rejects symlinked targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-restore-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const outside = path.join(root, "outside.txt");
  const packageRoot = path.join(root, "package-root");
  const target = "usr/share/codex-package-framework/payload.txt";
  const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
    packageResources: [
      { source: "payload.txt", target, mode: "0640", formats: ["deb"] },
    ],
  });
  fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
  fs.writeFileSync(outside, "outside\n");
  fs.chmodSync(outside, 0o600);

  const options = { featuresRoot, packageFormat: "deb" };
  stageEnabledLinuxFeaturePackageResources(packageRoot, options);
  fs.rmSync(path.join(packageRoot, target));
  fs.symlinkSync(outside, path.join(packageRoot, target));

  assert.throws(
    () => restoreEnabledLinuxFeaturePackageResourcePermissions(packageRoot, options),
    /must not contain symbolic links/i,
  );
  assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
});

test("Linux feature package resources reject invalid modes and formats", () => {
  const invalidResources = [
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: 644,
        formats: ["deb"],
      },
      error: /file mode must be a quoted octal string/i,
    },
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: "0899",
        formats: ["deb"],
      },
      error: /file mode must be a quoted octal string/i,
    },
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: "4755",
        formats: ["deb"],
      },
      error: /special permission bits are not allowed/i,
    },
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: "2755",
        formats: ["deb"],
      },
      error: /special permission bits are not allowed/i,
    },
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: "1777",
        formats: ["deb"],
      },
      error: /special permission bits are not allowed/i,
    },
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: "0644",
        formats: ["deb", "appimage"],
      },
      error: /unsupported package format.*appimage/i,
    },
    {
      resource: {
        source: "payload.txt",
        target: "usr/share/codex-package-framework/payload.txt",
        mode: "0644",
        formats: "deb",
      },
      error: /formats must be an array/i,
    },
  ];

  for (const { resource, error } of invalidResources) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-invalid-resource-"));
    try {
      const { featureDir, featuresRoot } = makePackageFeatureRoot(root, {
        id: "package-framework-fixture",
        title: "Package Framework Fixture",
        packageResources: [resource],
      });
      fs.writeFileSync(path.join(featureDir, "payload.txt"), "payload\n");
      assert.throws(
        () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
        error,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-invalid-format-"));
  try {
    const { featuresRoot } = makePackageFeatureRoot(root, {
      id: "package-framework-fixture",
      title: "Package Framework Fixture",
    });
    assert.throws(
      () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "appimage" }),
      /unsupported package format.*appimage/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux feature package dependencies reject unsafe tokens and unsupported formats", () => {
  const invalidDependencies = [
    { packageDependencies: { deb: ["fixture-deb-runtime;curl"] }, error: /invalid.*dependency/i },
    { packageDependencies: { deb: [""] }, error: /invalid.*dependency/i },
    { packageDependencies: { deb: "fixture-deb-runtime" }, error: /dependencies.*array/i },
    { packageDependencies: { appimage: ["fixture-deb-runtime"] }, error: /unsupported package format.*appimage/i },
    { packageDependencies: { rpm: ["runtime.so.1%(id)"] }, error: /invalid.*dependency/i },
    { packageDependencies: { rpm: ["runtime.so.1%{_libdir}"] }, error: /invalid.*dependency/i },
    {
      packageDependencies: { rpm: ["runtime.so.1%{codex_elf_suffix}%(id)"] },
      error: /invalid.*dependency/i,
    },
  ];

  for (const { packageDependencies, error } of invalidDependencies) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-invalid-dependency-"));
    try {
      const { featuresRoot } = makePackageFeatureRoot(root, {
        id: "package-framework-fixture",
        title: "Package Framework Fixture",
        packageDependencies,
      });
      assert.throws(
        () => enabledLinuxFeaturePackagePlan({ featuresRoot, packageFormat: "deb" }),
        error,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("native package plans require the app feature snapshot to match the current config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const { featureDir, featuresRoot, id } = makePackageFeatureRoot(root, {
    packageResources: [
      {
        source: "fixture.txt",
        target: "usr/share/codex-package-framework/fixture.txt",
        mode: "0644",
      },
    ],
    packageDependencies: {
      deb: ["fixture-deb-runtime"],
    },
  });
  fs.writeFileSync(path.join(featureDir, "fixture.txt"), "fixture\n");

  const appDir = path.join(root, "app");
  writeBuildInfoSnapshot(appDir, [id]);
  const matchingPlan = enabledLinuxFeaturePackagePlan({
    appDir,
    featuresRoot,
    packageFormat: "deb",
  });
  assert.deepEqual(matchingPlan.dependencies, ["fixture-deb-runtime"]);
  assert.deepEqual(
    matchingPlan.resources.map((resource) => resource.target),
    ["usr/share/codex-package-framework/fixture.txt"],
  );

  writeBuildInfoSnapshot(appDir, []);
  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ appDir, featuresRoot, packageFormat: "deb" }),
    /app snapshot: \[\][\s\S]*current config: \["package-framework-fixture"\]/,
  );

  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":[]}\n');
  writeBuildInfoSnapshot(appDir, [id]);
  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ appDir, featuresRoot, packageFormat: "deb" }),
    /app snapshot: \["package-framework-fixture"\][\s\S]*current config: \[\]/,
  );
});

test("native package plans strictly validate the current feature config", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-config-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featuresRoot } = makePackageFeatureRoot(root, {});
  const appDir = path.join(root, "app");
  writeBuildInfoSnapshot(appDir, []);
  const configPath = path.join(featuresRoot, "features.json");
  const options = { appDir, featuresRoot, packageFormat: "deb" };

  fs.writeFileSync(configPath, '{"enabled":[]}\n');
  assert.deepEqual(enabledLinuxFeaturePackagePlan(options), {
    resources: [],
    dependencies: [],
  });

  fs.writeFileSync(configPath, '{"enabled":[}\n');
  assert.throws(
    () => enabledLinuxFeaturePackagePlan(options),
    /could not read Linux features config/i,
  );

  fs.writeFileSync(configPath, '{"enabled":"package-framework-fixture"}\n');
  assert.throws(
    () => enabledLinuxFeaturePackagePlan(options),
    /must contain an enabled array/i,
  );

  fs.writeFileSync(configPath, '{"enabled":["INVALID"]}\n');
  assert.throws(
    () => enabledLinuxFeaturePackagePlan(options),
    /invalid Linux feature id/i,
  );

  fs.writeFileSync(
    configPath,
    '{"enabled":["package-framework-fixture","package-framework-fixture"]}\n',
  );
  assert.throws(
    () => enabledLinuxFeaturePackagePlan(options),
    /duplicate Linux feature id/i,
  );

  fs.rmSync(configPath);
  assert.throws(
    () => enabledLinuxFeaturePackagePlan(
      { ...options, featuresConfigPath: configPath },
    ),
    /could not read Linux features config.*file does not exist/i,
  );
});

test("strict settings validation rejects malformed input in config and every native package plan", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-settings-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featuresRoot, id } = makePackageFeatureRoot(root, {});
  const appDir = path.join(root, "app");
  writeBuildInfoSnapshot(appDir, [id]);
  const configPath = path.join(featuresRoot, "features.json");
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  const invalid = [
    ...[[], "bad", 0, false].map((value) => [value, /settings must be an object/]),
    ...[[], "bad", 0, false, null].map((value) => [
      { [id]: value }, /package-framework-fixture.*settings.*must be an object/,
    ]),
    [{ INVALID: {} }, /Invalid Linux feature settings id.*INVALID/],
    [{ "bad key": {} }, /Invalid Linux feature settings id.*bad key/],
  ];
  for (const [settings, reason] of invalid) {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: [id], settings }));
    const diagnostic = (error) => {
      assert.ok(error.message.includes(configPath), error.message);
      assert.match(error.message, reason);
      return true;
    };
    assert.throws(() => linuxFeaturesConfig({ featuresRoot, strictConfig: true }), diagnostic);
    for (const packageFormat of ["deb", "rpm", "pacman", "ebuild"]) {
      assert.throws(() => enabledLinuxFeaturePackagePlan({
        featuresRoot, appDir, packageFormat,
      }), diagnostic);
    }
    assert.equal(warnings.length, 0, "strict settings validation throws without warning and ignoring");
    assert.deepEqual(linuxFeaturesConfig({ featuresRoot }).settings, {});
    assert.equal(warnings.length, 1);
    assert.match(warnings.pop(), reason);
  }
});

test("valid settings preserve nested values, disabled settings, aliases, and enabled-only export", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-valid-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featuresRoot, id } = makePackageFeatureRoot(root, {});
  const configPath = path.join(featuresRoot, "features.json");
  const appDir = path.join(root, "app");
  writeBuildInfoSnapshot(appDir, [id]);
  const options = { featuresRoot, strictConfig: true };
  const nested = { nested: { list: [1, null, false], featureOwned: null } };
  for (const settings of [undefined, null, {}, { [id]: nested }]) {
    fs.writeFileSync(configPath, JSON.stringify({ enabled: [id], settings }));
    assert.deepEqual(linuxFeaturesConfig(options).settings, settings ?? {});
    assert.deepEqual(enabledLinuxFeaturePackagePlan({ ...options, appDir, packageFormat: "deb" }), {
      resources: [], dependencies: [],
    });
  }
  const warnings = [];
  t.mock.method(console, "warn", (message) => warnings.push(message));
  fs.writeFileSync(configPath, JSON.stringify({ enabled: [id], settings: {
    [id]: nested,
    dormant: { keep: true },
    "open-target-discovery": null,
    "zed-opener": [],
    "conversation-mode": "retired",
  } }));
  assert.deepEqual(linuxFeaturesConfig(options).settings, { [id]: nested, dormant: { keep: true } });
  assert.deepEqual(enabledLinuxFeaturesConfig(options), { enabled: [id], settings: { [id]: nested } });
  assert.deepEqual(warnings, []);

  fs.writeFileSync(configPath, JSON.stringify({ enabled: [id], settings: {
    [id]: nested, dormant: [], INVALID: {},
  } }));
  assert.deepEqual(linuxFeaturesConfig({ featuresRoot }).settings, { [id]: nested });
  assert.equal(warnings.length, 2, "non-strict reading retains valid entries while warning about invalid ones");
});

test("native package plans reject missing or malformed app feature snapshots", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-package-build-info-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { featuresRoot } = makePackageFeatureRoot(root, {});
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":[]}\n');
  const appDir = path.join(root, "app");

  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ appDir, featuresRoot, packageFormat: "deb" }),
    /could not read packaged app build info/i,
  );

  const buildInfoPath = writeBuildInfoSnapshot(appDir, []);
  assert.deepEqual(enabledFeatureIdsFromBuildInfo(appDir), []);
  fs.writeFileSync(buildInfoPath, '{"linuxFeatures":{}}\n');
  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ appDir, featuresRoot, packageFormat: "deb" }),
    /must contain linuxFeatures\.enabled/i,
  );
  fs.writeFileSync(buildInfoPath, '{"linuxFeatures":{"enabled":["INVALID"]}}\n');
  assert.throws(
    () => enabledLinuxFeaturePackagePlan({ appDir, featuresRoot, packageFormat: "deb" }),
    /must match/i,
  );
  writeBuildInfoSnapshot(appDir, [
    "package-framework-fixture",
    "package-framework-fixture",
  ]);
  assert.throws(
    () => enabledFeatureIdsFromBuildInfo(appDir),
    /duplicate Linux feature id/i,
  );
});
