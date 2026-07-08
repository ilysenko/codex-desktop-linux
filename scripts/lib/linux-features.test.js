#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
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
