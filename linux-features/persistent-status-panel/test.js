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
  findWebviewAssetsContaining,
  patchUniqueAssetFile,
} = require("../../scripts/patches/lib/assets.js");
const {
  STORAGE_KEY,
  applyPersistentStatusPanelPatch,
  descriptors,
  matchesPersistentStatusPanelContract,
} = require("./patch.js");

// Rspack/SWC shape: module factories inside `__webpack_modules__`, double-quoted
// strings and member-call React hooks.
const rspackChunk = (factoryBody) =>
  "export const __rspack_esm_id=589850;export const __rspack_esm_ids=[589850];" +
  `export const __webpack_modules__={Ab12(e,t,n){var g=n("zd8w");${factoryBody}}};`;

const currentComposerSource = rspackChunk(
  'function nW(e){let t=(0,iW.c)(26),{conversationId:n,threadId:r,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=(0,g.useState)(!1),{activeMode:l}=vm(n),u=l?.settings.model??null,d=Pn(Bc,n),f;t[0]===d?f=t[1]:(f=nR(d),t[0]=d,t[1]=f);let y,b;t[10]===a?(y=t[11],b=t[12]):(y=async()=>{c(!0),a?.(!0)},b=[a],t[10]=a,t[11]=y,t[12]=b);let v=o.formatMessage({id:"composer.statusSlashCommand.description",defaultMessage:"Show chat ID, context usage, and rate limits",description:"Description for the status slash command"}),x={id:"status",title:"Status",description:v,requiresEmptyComposer:!1,Icon:rE,onSelect:y,dependencies:b};if(CS(x),!s)return null;let S;t[18]===a?S=t[19]:(S=()=>{c(!1),a?.(!1)},t[18]=a,t[19]=S);return FU({threadId:r,onClose:S})}',
);

const liftedStatusStateComposerSource = rspackChunk(
  'function nW(){let ia=(0,iW.c)(9),[db,dx]=(0,g.useState)(!1),dy=(0,u._U)(uA.t,s5),v=o.formatMessage({id:"composer.statusSlashCommand.description"});return ia[0]!==db?(0,o.jsx)(Menu,{setIsStatusMenuOpen:dx,content:db?(0,o.jsx)(StatusPanel,{conversationId:s5,onClose:()=>dx(!1)}):null,open:db,description:v,pending:dy}):null}',
);

const STORAGE_LITERAL = JSON.stringify(STORAGE_KEY);
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const GET_PATTERN = new RegExp(`"1"===localStorage\\.getItem\\(${escapeRegExp(STORAGE_LITERAL)}\\)`);
const SET_PATTERN = new RegExp(`localStorage\\.setItem\\(${escapeRegExp(STORAGE_LITERAL)},"1"\\)`);
const REMOVE_PATTERN = new RegExp(`localStorage\\.removeItem\\(${escapeRegExp(STORAGE_LITERAL)}\\)`);

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
  assert.match(patched, GET_PATTERN);
  assert.match(patched, SET_PATTERN);
  assert.match(patched, REMOVE_PATTERN);
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});

test("status state remains correlated across the current large composer function", () => {
  const source = liftedStatusStateComposerSource.replace(
    ",v=o.formatMessage",
    `,/*${"x".repeat(70_000)}*/v=o.formatMessage`,
  );
  const patched = applyPersistentStatusPanelPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, GET_PATTERN);
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});

test("same-alias status consumers in adjacent functions do not cross owner boundaries", () => {
  const source =
    'function stateOwner(){let[yt,bt]=(0,g.useState)(!1),v=o.formatMessage({id:"composer.statusSlashCommand.description"});return yt}' +
    "function menuOwner(){return(0,o.jsx)(Menu,{setIsStatusMenuOpen:bt})}" +
    "function panelOwner(){return(0,o.jsx)(StatusPanel,{onClose:()=>bt(!1)})}";

  const { value: patched, warnings } = captureWarns(() =>
    applyPersistentStatusPanelPatch(source),
  );

  assert.equal(patched, source);
  assert.deepEqual(warnings, [
    "WARN: Could not find Codex status panel state - skipping persistent status panel patch",
  ]);
});

test("descriptor locates the rspack composer chunk by content needles", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "persistent-status-panel-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    const assetName = "async/589850.1c7db979c6.js";
    const assetPath = path.join(assetsDir, assetName);
    fs.mkdirSync(path.dirname(assetPath), { recursive: true });
    fs.writeFileSync(assetPath, liftedStatusStateComposerSource);
    // Locale chunks carry the message id but not the lifted menu prop.
    fs.writeFileSync(
      path.join(assetsDir, "async", "127249.5ba5cd61c0.js"),
      '{"composer.statusSlashCommand.description":"Status"}',
    );
    fs.writeFileSync(path.join(assetsDir, "158624.372d9fdf73.js"), "const unrelated=true");

    const [descriptor] = descriptors;
    assert.equal(descriptor.pattern, undefined);
    const candidates = findWebviewAssetsContaining(tempDir, descriptor.assetNeedles);
    assert.deepEqual(candidates, [assetName]);
    const result = patchUniqueAssetFile(
      tempDir,
      null,
      descriptor.assetMatch,
      descriptor.apply,
      "missing",
      "ambiguous",
      candidates,
    );
    const patched = fs.readFileSync(assetPath, "utf8");

    assert.deepEqual(result, {
      matched: 1,
      changed: 1,
      assetName,
      changedAssets: [assetName],
    });
    assert.match(patched, GET_PATTERN);
    assert.match(patched, SET_PATTERN);
    assert.match(patched, REMOVE_PATTERN);
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
      `function unrelated(){return ${STORAGE_LITERAL}}function nW(){`,
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
    liftedStatusStateComposerSource.replaceAll("db", "xt").replaceAll("dx", "ct");

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
    "{conversationId:n,threadId:r,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=(0,g.useState)(!1),",
    "{threadId:r,conversationId:n,rateLimit:i,onOpenChange:a}=e,o=Wr(),[s,c]=g.useState(!1),",
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

test("signed official webview has exactly one patchable composer status owner", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP ? false : "CODEX_SIGNED_EXTRACTED_APP is not set",
}, () => {
  const appDir = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const [descriptor] = descriptors;
  const matches = findWebviewAssetsContaining(appDir, descriptor.assetNeedles)
    .map((assetName) => fs.readFileSync(path.join(appDir, "webview", "assets", assetName), "utf8"))
    .filter((source) => descriptor.assetMatch(source));
  assert.equal(matches.length, 1);
  const patched = applyPersistentStatusPanelPatch(matches[0]);
  assert.notEqual(patched, matches[0]);
  assert.match(patched, GET_PATTERN);
  assert.equal(applyPersistentStatusPanelPatch(patched), patched);
});
