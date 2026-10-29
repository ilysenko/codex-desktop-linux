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
    "getNativeTrayMenuItems(){let{pinnedThreads:e,recentThreads:t,runningThreads:r,unreadThreads:n,usageLimits:",
    `${alias}}=this.trayMenuThreads,s=this.nativeIntl.formatMessage({messageId:l6,defaultMessage:l5}),o=[e_C({label:a}),`,
    `"darwin"!==process.platform||0===${alias}.length?[]:[{label:this.nativeIntl.formatMessage({messageId:"trayMenu.usage",defaultMessage:"Usage"}),enabled:!1},...${alias}.map(({label:e})=>({label:e,enabled:!1}))]`,
    '].filter(e=>e.length>0).flatMap((e,t)=>0===t?e:[{type:"separator"},...e]);return[...o]}',
  ].join("");
}

function rspackChunk(body) {
  return `"use strict";exports.ids=[916],exports.modules={35575(e,t,r){"use strict";r.d(t,{x:()=>a});class a{${body}}}};`;
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
  assert.match(patched, /"darwin"!==process\.platform&&"linux"!==process\.platform\|\|0===i\.length\?\[\]:/);
  assert.equal(applyTrayUsageMainPatch(patched), patched);
});

test("main-process patch preserves minified aliases", () => {
  const patched = applyTrayUsageMainPatch(officialMainFixture("usage"));
  assert.equal(trayUsageMainContract(patched), "patched");
  assert.match(patched, /"darwin"!==process\.platform&&"linux"!==process\.platform\|\|0===usage\.length/);
  assert.equal(applyTrayUsageMainPatch(patched), patched);
});

test("drifted, duplicate, and mixed contracts remain byte-identical", () => {
  const current = officialMainFixture();
  const patched = applyTrayUsageMainPatch(current);
  const drifted = current.replace('"darwin"!==process.platform', '"darwin"===process.platform');
  const unrelatedLookalike =
    'function unrelated(){let x=["darwin"!==process.platform||0===i.length?[]:[...i.map(({label:e})=>({label:e,enabled:!1}))]];return[x]}';
  const retiredTemplateShape = current.replace(
    '"darwin"!==process.platform||0===i.length',
    "process.platform!==`darwin`||i.length===0",
  );
  const unrelatedChunk = rspackChunk("getTrayIcon(){return null}");
  const sources = [
    drifted,
    retiredTemplateShape,
    unrelatedChunk,
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

test("main-process patch applies only to the rspack chunk that owns the tray menu", () => {
  const owner = rspackChunk(officialMainFixture());
  const patched = applyTrayUsageMainPatch(owner);
  assert.notEqual(patched, owner);
  assert.equal(trayUsageMainContract(patched), "patched");
  assert.equal(captureWarnings(() => applyTrayUsageMainPatch(patched)).warnings.length, 0);
});

test(
  "main-process patch matches exactly one current signed main-process chunk",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const buildDir = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, ".vite", "build");
    const chunks = fs.readdirSync(buildDir).filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]{16})?\.js$/.test(name));
    assert.ok(chunks.length > 0);
    const owners = chunks.filter((name) => {
      const source = fs.readFileSync(path.join(buildDir, name), "utf8");
      return trayUsageMainContract(source) === "current";
    });
    assert.equal(owners.length, 1);
    const source = fs.readFileSync(path.join(buildDir, owners[0]), "utf8");
    const patched = captureWarnings(() => applyTrayUsageMainPatch(source));
    assert.deepEqual(patched.warnings, []);
    assert.equal(trayUsageMainContract(patched.value), "patched");
    assert.equal(applyTrayUsageMainPatch(patched.value), patched.value);
  },
);
