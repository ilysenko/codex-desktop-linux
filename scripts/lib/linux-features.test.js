#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  discoverLinuxFeatureManifests,
  stageEnabledLinuxFeatureInstall,
} = require("./linux-features.js");

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

test("Linux feature discovery can exclude local manifests", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-feature-repo-only-discovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const featuresRoot = path.join(root, "linux-features");
  const featureDir = path.join(featuresRoot, "alpha");
  const localDir = path.join(featuresRoot, "local", "broken");
  fs.mkdirSync(featureDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "README.md"), "# Alpha\n");
  fs.writeFileSync(path.join(featureDir, "feature.json"), '{"id":"alpha","title":"Alpha"}\n');
  fs.writeFileSync(path.join(localDir, "README.md"), "# Broken\n");
  fs.writeFileSync(path.join(localDir, "feature.json"), "{broken-json\n");

  const features = discoverLinuxFeatureManifests({ featuresRoot, includeLocal: false });

  assert.deepEqual(features.map((feature) => feature.id), ["alpha"]);
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
