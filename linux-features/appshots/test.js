#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  descriptors,
} = require("./patch.js");

test("appshots stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const featuresRoot = path.resolve(__dirname, "..");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(configPath, '{"enabled":["appshots"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });

    assert.equal(loaded.length, 4);
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id).sort(),
      [
        "feature:appshots:linux-appshots-availability",
        "feature:appshots:linux-appshots-hotkey",
        "feature:appshots:linux-appshots-main-process",
        "feature:appshots:linux-appshots-settings-hotkey",
      ].sort(),
    );
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("appshots feature descriptors are optional", () => {
  assert.equal(descriptors.length, 4);
  assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy == null));
});
