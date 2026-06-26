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
  STORAGE_KEY,
  applyPersistentStatusPanelPatch,
} = require("./patch.js");

const composerSource =
  "function av(e){let t=(0,$.c)(26),{conversationId:n,threadId:r,rateLimit:i,onOpenChange:o}=e,s=Wt(),[c,l]=(0,Z.useState)(!1),p;t[0]===s&&(p=1);let b,x;t[10]===o?(b=t[11],x=t[12]):(b=async()=>{l(!0),o?.(!0)},x=[o]);let y=s.formatMessage({id:`composer.statusSlashCommand.description`});if(!c)return null;let C;t[18]===o?C=t[19]:(C=()=>{l(!1),o?.(!1)});return C}";

function captureWarns(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => {
    warnings.push(message);
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-status-panel-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return fn();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id === "feature:persistent-status-panel:composer-status-state"),
      false,
    );
  });
  withFeatureConfig(["persistent-status-panel"], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id === "feature:persistent-status-panel:composer-status-state"),
      true,
    );
  });
});

test("status panel preference survives component remounts", () => {
  const patched = applyPersistentStatusPanelPatch(composerSource);

  assert.notEqual(patched, composerSource);
  assert.match(patched, new RegExp(`localStorage\\.getItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.match(patched, new RegExp(`localStorage\\.setItem\\(\\\`${STORAGE_KEY}\\\`,\\\`1\\\`\\)`));
  assert.match(patched, new RegExp(`localStorage\\.removeItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});

test("restored status panel state notifies composer layout", () => {
  const patched = applyPersistentStatusPanelPatch(composerSource);

  assert.match(patched, /\(0,Z\.useEffect\)\(\(\)=>\{c&&o\?\.\(!0\)\},\[c,o\]\);/);
  assert.match(
    patched,
    /\(0,Z\.useState\)\(\(\)=>\{try\{return localStorage\.getItem\(`codex-linux-persistent-status-panel-open`\)===`1`\}catch\{return!1\}\}\),p;\(0,Z\.useEffect\)/,
  );
});

test("ambiguous status panel handler needles are unchanged", () => {
  const ambiguousSource = composerSource.replace(
    "let y=s.formatMessage",
    "let extraOpen=async()=>{l(!0),o?.(!0)},extraClose=()=>{l(!1),o?.(!1)},y=s.formatMessage",
  );

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(ambiguousSource),
  );

  assert.equal(patched, ambiguousSource);
  assert.deepEqual(warnings, [
    "WARN: Found 2 Codex status panel open handler occurrences - skipping persistent status panel patch",
  ]);
});

test("composer bundle with changed status state shape is unchanged", () => {
  const changedStateSource = composerSource.replace(
    "{conversationId:n,threadId:r,rateLimit:i,onOpenChange:o}=e,s=Wt(),[c,l]=(0,Z.useState)(!1),",
    "{threadId:r,conversationId:n,rateLimit:i,onOpenChange:o}=e,s=Wt(),[c,l]=Z.useState(!1),",
  );

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(changedStateSource),
  );

  assert.equal(patched, changedStateSource);
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel state - skipping persistent status panel patch",
  ]);
});

test("unknown composer bundle is unchanged", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch("unrelated bundle"),
  );

  assert.equal(patched, "unrelated bundle");
  assert.deepEqual(warnings, []);
});
