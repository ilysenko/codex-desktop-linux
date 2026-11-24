#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const {
  applyUsageLimitSendAttemptPatch,
  applyUsageLimitSendAttemptAppPatch,
  descriptors,
} = require("./patch.js");

// Reduced fixture of the current signed shared disabled-reason selector.
const composer = 'let c=usageLimitAtom,p=(0,r.i1)(a.u,(e,{get:t})=>' +
  '[t(l.F9,e)&&"reserve-limit","local"===e&&t(c)&&"usage-limit"].filter(Boolean).join(","));' +
  'exportReason(p);';

test("feature is disabled by default and registered when enabled", () => {
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-send-attempt-"));
  const config = path.join(directory, "features.json");
  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = config;
    fs.writeFileSync(config, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, "..") }), []);
    fs.writeFileSync(config, '{"enabled":["usage-limit-send-attempt"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot: path.resolve(__dirname, "..") });
    assert.deepEqual(loaded.map(({ id }) => id), ["feature:usage-limit-send-attempt:usage-limit-send-attempt-ui"]);
    assert.equal(descriptors[0].phase, "extracted-app:post-webview");
  } finally {
    if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("local Codex usage does not disable Send while other blocks remain", () => {
  const patched = applyUsageLimitSendAttemptPatch(composer);
  assert.notEqual(patched, composer);
  assert.equal(applyUsageLimitSendAttemptPatch(patched), patched);
  assert.equal(patched.replace("!1/*codexLinuxUsageLimitSendAttempt*/", '"local"===e&&t(c)&&"usage-limit"'), composer);
  assert.match(patched, /t\(l\.F9,e\)&&"reserve-limit"/);
  assert.match(patched, /\.filter\(Boolean\)\.join\(","\)/);
});

test("patches the unique shared reason selector without relying on chunk or module IDs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-send-attempt-layout-"));
  const assets = path.join(directory, "webview", "assets", "async");
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "first.js"), composer);
    fs.writeFileSync(path.join(assets, "second.js"), 'const label="usage-limit";');
    fs.writeFileSync(path.join(assets, "other.js"), "return{submitDisabled:true}");
    const result = applyUsageLimitSendAttemptAppPatch(directory);
    assert.equal(result.changed, 1);
    assert.match(fs.readFileSync(path.join(assets, "first.js"), "utf8"), /codexLinuxUsageLimitSendAttempt/);
    assert.doesNotMatch(fs.readFileSync(path.join(assets, "second.js"), "utf8"), /codexLinuxUsageLimitSendAttempt/);
    assert.equal(fs.readFileSync(path.join(assets, "other.js"), "utf8"), "return{submitDisabled:true}");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a pristine owner plus a drifted relevant owner prevents every write", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-send-attempt-drift-"));
  const assets = path.join(directory, "webview", "assets", "async");
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "first.js"), composer);
    const drifted = composer.replace("t(c)&&\"usage-limit\"", "blocked(c)&&\"usage-limit\"");
    fs.writeFileSync(path.join(assets, "second.js"), drifted);
    assert.equal(applyUsageLimitSendAttemptAppPatch(directory).changed, 0);
    assert.equal(fs.readFileSync(path.join(assets, "first.js"), "utf8"), composer);
    assert.equal(fs.readFileSync(path.join(assets, "second.js"), "utf8"), drifted);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous or drifted reason selectors remain byte-identical", () => {
  assert.equal(applyUsageLimitSendAttemptPatch(composer + composer), composer + composer);
  const disconnected = composer.replace("t(l.F9,e)", "t(l.F9,otherHost)");
  assert.equal(applyUsageLimitSendAttemptPatch(disconnected), disconnected);
  const renamedReason = composer.replace('"usage-limit"', '"quota-limit"');
  assert.equal(applyUsageLimitSendAttemptPatch(renamedReason), renamedReason);
  const nonLocal = composer.replace('"local"===e', '"remote"===e');
  assert.equal(applyUsageLimitSendAttemptPatch(nonLocal), nonLocal);
});

test(
  "current signed composer assets match uniquely and remain valid JavaScript",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  t => {
    const signed = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets", "async");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-send-attempt-signed-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const assets = path.join(directory, "webview", "assets", "async");
    fs.mkdirSync(assets, { recursive: true });
    const relevant = [];
    for (const name of fs.readdirSync(signed).filter(file => file.endsWith(".js"))) {
      const source = fs.readFileSync(path.join(signed, name), "utf8");
      if (!source.includes('"reserve-limit"') || !source.includes('"usage-limit"')) continue;
      fs.writeFileSync(path.join(assets, name), source);
      relevant.push(name);
    }
    const result = applyUsageLimitSendAttemptAppPatch(directory);
    assert.equal(relevant.length, 1);
    assert.equal(result.changed, 1);
    for (const name of relevant) {
      const patched = fs.readFileSync(path.join(assets, name), "utf8");
      assert.equal(patched.split("codexLinuxUsageLimitSendAttempt").length, 2);
      const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        input: patched, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
      });
      assert.equal(check.status, 0, `${name}: ${check.stderr}`);
    }
  },
);
