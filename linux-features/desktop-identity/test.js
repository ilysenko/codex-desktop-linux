#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const {
  UPSTREAM_DESKTOP_NAME,
  patchDesktopNameSource,
  patchPackageDesktopName,
  resolveDesktopName,
} = require("./patch.js");

const FEATURE_ID = "desktop-identity";
const DESCRIPTOR_ID = `feature:${FEATURE_ID}:package-desktop-name`;
// Shape of the signed official package.json tail, including its 2-space style.
const OFFICIAL_PACKAGE_JSON = `{
  "name": "openai-codex-electron",
  "productName": "ChatGPT",
  "scripts": {
    "desktop:owl-types": {
      "command": "node ./scripts/ensure-owl-electron-types.mjs"
    }
  },
  "codexBuildFlavor": "prod",
  "codexBuildNumber": "21747",
  "desktopName": "${UPSTREAM_DESKTOP_NAME}"
}`;

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  return withTempDir("desktop-identity-config-", (dir) => {
    process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(dir, "features.json");
    try {
      fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
      return fn(process.env.CODEX_LINUX_FEATURES_CONFIG);
    } finally {
      if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
      else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
  });
}

function withAppId(appId, fn) {
  const original = process.env.CODEX_APP_ID;
  if (appId == null) delete process.env.CODEX_APP_ID;
  else process.env.CODEX_APP_ID = appId;
  try {
    return fn();
  } finally {
    if (original == null) delete process.env.CODEX_APP_ID;
    else process.env.CODEX_APP_ID = original;
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  const ids = () => loadLinuxFeaturePatchDescriptors({ featuresRoot })
    .map((descriptor) => descriptor.id)
    .filter((id) => id.startsWith(`feature:${FEATURE_ID}:`));
  withFeatureConfig([], () => assert.deepEqual(ids(), []));
  withFeatureConfig([FEATURE_ID], () => assert.deepEqual(ids(), [DESCRIPTOR_ID]));
});

test("desktop name follows CODEX_APP_ID and rejects unsafe ids", () => {
  assert.equal(resolveDesktopName({}), "codex-desktop.desktop");
  assert.equal(resolveDesktopName({ CODEX_APP_ID: "codex-cua-lab" }), "codex-cua-lab.desktop");
  assert.throws(() => resolveDesktopName({ CODEX_APP_ID: "bad/app" }), /CODEX_APP_ID must contain only/);
});

test("only the upstream desktopName value changes", () => {
  const result = patchDesktopNameSource(OFFICIAL_PACKAGE_JSON, "codex-desktop.desktop");
  assert.equal(result.matched, 1);
  assert.equal(result.changed, 1);
  assert.equal(
    result.source,
    OFFICIAL_PACKAGE_JSON.replace(`"desktopName": "${UPSTREAM_DESKTOP_NAME}"`, `"desktopName": "codex-desktop.desktop"`),
  );
  assert.equal(JSON.parse(result.source).desktopName, "codex-desktop.desktop");

  const again = patchDesktopNameSource(result.source, "codex-desktop.desktop");
  assert.deepEqual(again, { source: result.source, matched: 1, changed: 0 });
});

test("unexpected package metadata fails closed", () => {
  const cases = [
    ["not json", /not valid JSON/],
    ["[]", /not a JSON object/],
    [JSON.stringify({ name: "x" }), /not the upstream chatgpt\.desktop contract/],
    [JSON.stringify({ desktopName: "other.desktop" }), /not the upstream chatgpt\.desktop contract/],
    [
      `{"nested":{"desktopName":"${UPSTREAM_DESKTOP_NAME}"},"desktopName":"${UPSTREAM_DESKTOP_NAME}"}`,
      /expected one desktopName field.*found 2/,
    ],
  ];
  for (const [source, reason] of cases) {
    const result = patchDesktopNameSource(source, "codex-desktop.desktop");
    assert.equal(result.matched, 0, source);
    assert.equal(result.changed, 0, source);
    assert.equal(result.source, source);
    assert.match(result.reason, reason);
  }
});

test("missing package.json is reported without writing", () => {
  withTempDir("desktop-identity-missing-", (dir) => {
    const result = patchPackageDesktopName(dir, {});
    assert.equal(result.matched, 0);
    assert.match(result.reason, /missing/);
    assert.equal(fs.existsSync(path.join(dir, "package.json")), false);
  });
});

function runPatcher(extractedDir, enabled, appId) {
  return withAppId(appId, () => withFeatureConfig(enabled, (featuresConfigPath) => {
    const report = createPatchReport();
    patchExtractedApp(extractedDir, {
      report,
      featuresRoot: path.resolve(__dirname, ".."),
      featuresConfigPath,
      corePatchRoot: path.join(extractedDir, "no-core-patches"),
    });
    return report;
  }));
}

test("enabled feature rewrites the extracted app and reports success", () => {
  withTempDir("desktop-identity-app-", (dir) => {
    const packageJsonPath = path.join(dir, "package.json");
    fs.writeFileSync(packageJsonPath, OFFICIAL_PACKAGE_JSON);

    const report = runPatcher(dir, [FEATURE_ID], "codex-cua-lab");
    const entry = report.patches.find((patch) => patch.name === DESCRIPTOR_ID);
    assert.equal(entry?.status, "applied");
    assert.deepEqual(enabledFeatureFailuresFromReport(report), []);
    assert.equal(JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).desktopName, "codex-cua-lab.desktop");
  });
});

test("enabled feature fails the build when upstream drops the contract", () => {
  withTempDir("desktop-identity-drift-", (dir) => {
    const drifted = JSON.stringify({ name: "openai-codex-electron", desktopName: "openai-chatgpt.desktop" });
    fs.writeFileSync(path.join(dir, "package.json"), drifted);

    const report = runPatcher(dir, [FEATURE_ID], null);
    const failures = enabledFeatureFailuresFromReport(report);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, DESCRIPTOR_ID);
    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), drifted);
  });
});

test("disabled feature leaves the official package metadata untouched", () => {
  withTempDir("desktop-identity-disabled-", (dir) => {
    fs.writeFileSync(path.join(dir, "package.json"), OFFICIAL_PACKAGE_JSON);
    runPatcher(dir, [], null);
    assert.equal(fs.readFileSync(path.join(dir, "package.json"), "utf8"), OFFICIAL_PACKAGE_JSON);
  });
});
