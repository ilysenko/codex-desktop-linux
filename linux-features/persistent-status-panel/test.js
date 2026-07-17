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
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  STORAGE_KEY,
  applyPersistentStatusPanelPatch,
  descriptors,
} = require("./patch.js");

const currentComposerSource =
  "function nW(e){let t=(0,iW.c)(26),{conversationId:n,threadId:r,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=(0,aW.useState)(!1),{activeMode:l}=vm(n),u=l?.settings.model??null,d=Pn(Bc,n),f;t[0]===d?f=t[1]:(f=nR(d),t[0]=d,t[1]=f);let y,b;t[10]===a?(y=t[11],b=t[12]):(y=async()=>{c(!0),a?.(!0)},b=[a],t[10]=a,t[11]=y,t[12]=b);let v=o.formatMessage({id:`composer.statusSlashCommand.description`,defaultMessage:`Show task id, context usage, and rate limits`,description:`Description for the status slash command`}),x={id:`status`,title:`Status`,description:v,requiresEmptyComposer:!1,Icon:rE,onSelect:y,dependencies:b};if(CS(x),!s)return null;let S;t[18]===a?S=t[19]:(S=()=>{c(!1),a?.(!1)},t[18]=a,t[19]=S);return FU({threadId:r,onClose:S})}";

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
  const patched = applyPersistentStatusPanelPatch(currentComposerSource);

  assert.notEqual(patched, currentComposerSource);
  assert.match(patched, new RegExp(`localStorage\\.getItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.match(patched, new RegExp(`localStorage\\.setItem\\(\\\`${STORAGE_KEY}\\\`,\\\`1\\\`\\)`));
  assert.match(patched, new RegExp(`localStorage\\.removeItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});

test("descriptor patches the current app-initial composer status bundle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-status-panel-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    const assetPath = path.join(
      assetsDir,
      "app-initial~app-main~settings-command-menu-section-items~new-thread-panel-page~settings-pag~unq8yzli-twtaboLE.js",
    );
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(assetPath, currentComposerSource);

    const result = patchAssetFiles(tempDir, descriptors[0].pattern, descriptors[0].apply, "missing");
    const patched = fs.readFileSync(assetPath, "utf8");

    assert.deepEqual(result, { matched: 1, changed: 1 });
    assert.match(patched, new RegExp(`localStorage\\.getItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
    assert.match(patched, new RegExp(`localStorage\\.setItem\\(\\\`${STORAGE_KEY}\\\`,\\\`1\\\`\\)`));
    assert.match(patched, new RegExp(`localStorage\\.removeItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ambiguous status panel handler needles are unchanged", () => {
  const ambiguousSource = currentComposerSource.replace(
    "let v=o.formatMessage",
    "let extraOpen=async()=>{c(!0),a?.(!0)},extraClose=()=>{c(!1),a?.(!1)},v=o.formatMessage",
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
  const changedStateSource = currentComposerSource.replace(
    "{conversationId:n,threadId:r,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=(0,aW.useState)(!1),",
    "{threadId:r,conversationId:n,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=aW.useState(!1),",
  );

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(changedStateSource),
  );

  assert.equal(patched, changedStateSource);
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel state - skipping persistent status panel patch",
  ]);
});

test("target bundle without status marker is unchanged and warns", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch("unrelated bundle"),
  );

  assert.equal(patched, "unrelated bundle");
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel bundle marker - skipping persistent status panel patch",
  ]);
});
