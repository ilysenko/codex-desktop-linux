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
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
  STORAGE_KEY,
  applyPersistentStatusPanelPatch,
  descriptors,
  matchesPersistentStatusPanelContract,
} = require("./patch.js");

const currentComposerSource =
  "function nW(e){let t=(0,iW.c)(26),{conversationId:n,threadId:r,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=(0,aW.useState)(!1),{activeMode:l}=vm(n),u=l?.settings.model??null,d=Pn(Bc,n),f;t[0]===d?f=t[1]:(f=nR(d),t[0]=d,t[1]=f);let y,b;t[10]===a?(y=t[11],b=t[12]):(y=async()=>{c(!0),a?.(!0)},b=[a],t[10]=a,t[11]=y,t[12]=b);let v=o.formatMessage({id:`composer.statusSlashCommand.description`,defaultMessage:`Show task id, context usage, and rate limits`,description:`Description for the status slash command`}),x={id:`status`,title:`Status`,description:v,requiresEmptyComposer:!1,Icon:rE,onSelect:y,dependencies:b};if(CS(x),!s)return null;let S;t[18]===a?S=t[19]:(S=()=>{c(!1),a?.(!1)},t[18]=a,t[19]=S);return FU({threadId:r,onClose:S})}";

const liftedStatusStateComposerSource =
  "function nW(){let[yt,bt]=(0,R3.useState)(!1),v=o.formatMessage({id:`composer.statusSlashCommand.description`});return jsx(Menu,{setIsStatusMenuOpen:bt,content:jsx(StatusPanel,{onClose:()=>bt(!1)}),open:yt,description:v})}";

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

test("retired component-local status state is rejected byte-identically", () => {
  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(currentComposerSource),
  );

  assert.equal(patched, currentComposerSource);
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel state - skipping persistent status panel patch",
  ]);
});

test("status panel preference follows the current lifted menu state", () => {
  const patched = applyPersistentStatusPanelPatch(liftedStatusStateComposerSource);

  assert.notEqual(patched, liftedStatusStateComposerSource);
  assert.match(patched, new RegExp(`localStorage\\.getItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.match(patched, new RegExp(`localStorage\\.setItem\\(\\\`${STORAGE_KEY}\\\`,\\\`1\\\`\\)`));
  assert.match(patched, new RegExp(`localStorage\\.removeItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});

test("status state remains correlated across the current large composer function", () => {
  const source = liftedStatusStateComposerSource.replace(
    ",v=o.formatMessage",
    `,/*${"x".repeat(70_000)}*/v=o.formatMessage`,
  );
  const patched = applyPersistentStatusPanelPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(`localStorage\\.getItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});

test("same-alias status consumers in adjacent functions do not cross owner boundaries", () => {
  const source =
    "function stateOwner(){let[yt,bt]=(0,R3.useState)(!1),v=o.formatMessage({id:`composer.statusSlashCommand.description`});return yt}" +
    "function menuOwner(){return jsx(Menu,{setIsStatusMenuOpen:bt})}" +
    "function panelOwner(){return jsx(StatusPanel,{onClose:()=>bt(!1)})}";

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel state - skipping persistent status panel patch",
  ]);
});

test("descriptor locates and patches the current semantic composer status bundle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-status-panel-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    const assetPath = path.join(
      assetsDir,
      "composer-content-a0bff570446b.js",
    );
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(assetPath, liftedStatusStateComposerSource);

    fs.writeFileSync(path.join(assetsDir, "app-primary-other.js"), "const unrelated=true");
    const result = patchUniqueAssetFile(
      tempDir,
      descriptors[0].pattern,
      descriptors[0].assetMatch,
      descriptors[0].apply,
      "missing",
      "ambiguous",
    );
    const patched = fs.readFileSync(assetPath, "utf8");

    assert.deepEqual(result, {
      matched: 1,
      changed: 1,
      assetName: "composer-content-a0bff570446b.js",
    });
    assert.match(patched, new RegExp(`localStorage\\.getItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
    assert.match(patched, new RegExp(`localStorage\\.setItem\\(\\\`${STORAGE_KEY}\\\`,\\\`1\\\`\\)`));
    assert.match(patched, new RegExp(`localStorage\\.removeItem\\(\\\`${STORAGE_KEY}\\\`\\)`));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persistent status descriptor recognizes pristine and patched semantic contracts", () => {
  assert.equal(matchesPersistentStatusPanelContract(liftedStatusStateComposerSource), true);
  assert.equal(
    matchesPersistentStatusPanelContract(applyPersistentStatusPanelPatch(liftedStatusStateComposerSource)),
    true,
  );
  assert.equal(matchesPersistentStatusPanelContract(currentComposerSource), false);
});

test("partial, duplicate, and unrelated persistent markers fail closed byte-identically", () => {
  const complete = applyPersistentStatusPanelPatch(liftedStatusStateComposerSource);
  const variants = [
    complete.replace("localStorage.setItem", "localStorage.changedSetItem"),
    complete + complete,
    liftedStatusStateComposerSource.replace(
      "function nW(){",
      `function unrelated(){return \`${STORAGE_KEY}\`}function nW(){`,
    ),
  ];

  for (const source of variants) {
    const { value: patched, warnings } = captureWarns(() =>
      applyPersistentStatusPanelPatch(source),
    );
    assert.equal(patched, source);
    assert.equal(matchesPersistentStatusPanelContract(source), false);
    assert.deepEqual(warnings, [
      "WARN: Found incomplete or ambiguous persistent status panel patch - leaving bundle unchanged",
    ]);
  }
});

test("ambiguous lifted status state owners are unchanged", () => {
  const ambiguousSource = liftedStatusStateComposerSource +
    liftedStatusStateComposerSource.replaceAll("yt", "xt").replaceAll("bt", "ct");

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(ambiguousSource),
  );

  assert.equal(patched, ambiguousSource);
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel state - skipping persistent status panel patch",
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
