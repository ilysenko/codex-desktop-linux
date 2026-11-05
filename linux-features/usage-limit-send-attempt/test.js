#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const {
  applyUsageLimitSendAttemptPatch,
  applyUsageLimitSendAttemptAppPatch,
  descriptors,
} = require("./patch.js");

// Reduced fixture of the current signed Linux webview composer. The account
// usage value remains available to its other consumers after this patch.
const composer = 'let{agentMode:os,permissionProfileId:ol,shouldSendPermissionOverrides:od}=(0,eK.Ap)(H),' +
  'oc=(0,i.Ul)(null==tq?null:P.Gq),om=(0,ei.r9)(),op=(0,i.Ul)("local"===nB&&R.U),oh=om===ei.O$?"codex_work_desktop":null;' +
  'let oT=void 0!==tm&&tm||ou||nN||nA&&nP||nK||ot&&n3||or?.isLoading===!0||nO||op;' +
  'return{usageBanner:R.U,submitDisabled:oT,onSubmitLocal:of}';

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
  assert.equal(patched.replace("op=!1/*codexLinuxUsageLimitSendAttempt*/", 'op=(0,i.Ul)("local"===nB&&R.U)'), composer);
  assert.match(patched, /\|\|nO\|\|op/);
  assert.match(patched, /usageBanner:R\.U/);
});

test("patches every matching composer asset without relying on chunk or module IDs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-send-attempt-layout-"));
  const assets = path.join(directory, "webview", "assets", "async");
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "first.js"), composer);
    fs.writeFileSync(path.join(assets, "second.js"), composer.replaceAll("op", "am").replaceAll("R.U", "I.X"));
    fs.writeFileSync(path.join(assets, "other.js"), "return{submitDisabled:true}");
    const result = applyUsageLimitSendAttemptAppPatch(directory);
    assert.equal(result.changed, 2);
    assert.match(fs.readFileSync(path.join(assets, "first.js"), "utf8"), /codexLinuxUsageLimitSendAttempt/);
    assert.match(fs.readFileSync(path.join(assets, "second.js"), "utf8"), /codexLinuxUsageLimitSendAttempt/);
    assert.equal(fs.readFileSync(path.join(assets, "other.js"), "utf8"), "return{submitDisabled:true}");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one drifted composer asset prevents partial writes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-limit-send-attempt-drift-"));
  const assets = path.join(directory, "webview", "assets", "async");
  try {
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "first.js"), composer);
    const drifted = composer.replace("||op;", "||anotherFlag;");
    fs.writeFileSync(path.join(assets, "second.js"), drifted);
    assert.equal(applyUsageLimitSendAttemptAppPatch(directory).changed, 0);
    assert.equal(fs.readFileSync(path.join(assets, "first.js"), "utf8"), composer);
    assert.equal(fs.readFileSync(path.join(assets, "second.js"), "utf8"), drifted);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("ambiguous or drifted composer rules remain byte-identical", () => {
  assert.equal(applyUsageLimitSendAttemptPatch(composer + composer), composer + composer);
  const renamed = composer.replace("agentMode:os", "agentModeChanged:os");
  assert.equal(applyUsageLimitSendAttemptPatch(renamed), renamed);
  const disconnected = composer.replace("||op;", "||otherFlag;");
  assert.equal(applyUsageLimitSendAttemptPatch(disconnected), disconnected);
  const nonLocal = composer.replace('"local"===nB', '"remote"===nB');
  assert.equal(applyUsageLimitSendAttemptPatch(nonLocal), nonLocal);
});
