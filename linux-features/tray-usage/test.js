#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const {
  applyTrayUsageMainPatch,
  descriptors,
  trayUsageMainContract,
} = require("./patch.js");

function officialMainFixture(alias = "i") {
  return [
    "getNativeTrayMenuItems(){let{pinnedThreads:e,recentThreads:t,runningThreads:n,unreadThreads:r,usageLimits:",
    `${alias}}=this.trayMenuThreads,a=[{label:\`Threads\`}],s=[...a,`,
    `process.platform!==\`darwin\`||${alias}.length===0?[]:[{label:\`Usage\`,enabled:!1},...${alias}.map(({label:e})=>({label:e,enabled:!1}))]`,
    "].filter(e=>e.length>0).flatMap((e,t)=>t===0?e:[{type:`separator`},...e]);return[...s]}",
  ].join("");
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function withFeatureConfig(enabled, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tray-usage-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
  process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
  try {
    return callback(path.resolve(__dirname, ".."));
  } finally {
    if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("tray-usage is disabled by default and exposes one optional main descriptor", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["tray-usage"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
      [["feature:tray-usage:linux-tray-usage-main-process", "main-bundle", "optional"]],
    );
  });

  assert.deepEqual(
    descriptors.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
    [["linux-tray-usage-main-process", "main-bundle", "optional"]],
  );
});

test("main-process patch enables usage labels on Linux and is idempotent", () => {
  const source = officialMainFixture();
  assert.equal(trayUsageMainContract(source), "current");
  const patched = applyTrayUsageMainPatch(source);
  assert.notEqual(patched, source);
  assert.equal(trayUsageMainContract(patched), "patched");
  assert.match(patched, /process\.platform!==`darwin`&&process\.platform!==`linux`\|\|i\.length===0/);
  assert.equal(applyTrayUsageMainPatch(patched), patched);
});

test("main-process patch preserves minified aliases", () => {
  const patched = applyTrayUsageMainPatch(officialMainFixture("usage"));
  assert.equal(trayUsageMainContract(patched), "patched");
  assert.match(patched, /process\.platform!==`darwin`&&process\.platform!==`linux`\|\|usage\.length===0/);
  assert.equal(applyTrayUsageMainPatch(patched), patched);
});

test("drifted, duplicate, and mixed contracts remain byte-identical", () => {
  const current = officialMainFixture();
  const patched = applyTrayUsageMainPatch(current);
  const drifted = current.replace("process.platform!==`darwin`", "process.platform===`darwin`");
  const unrelatedLookalike =
    "function unrelated(){let x=process.platform!==`darwin`||i.length===0?[]:[...i.map(({label:e})=>({label:e,enabled:!1}))];return[x]}";
  const retiredAssignedShape = current.replace("process.platform", "f=process.platform");
  const sources = [
    drifted,
    retiredAssignedShape,
    current + current,
    patched + patched,
    current + patched,
    drifted + unrelatedLookalike,
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applyTrayUsageMainPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current Linux tray-usage main-process contract/);
  }
});
