#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
  APP_INITIAL_ASSET_PATTERN,
  HOVER_SCROLLBAR_CSS,
  RUNTIME_MARKER,
  STYLE_ID,
  applyHoverScrollbarsPatch,
  descriptors,
  hoverScrollbarsContract,
} = require("./patch.js");

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

function fixture() {
  return [
    "const ids={sidebarScroll:`data-app-action-sidebar-scroll`};",
    "className:`vertical-scroll-fade-mask overflow-y-auto`",
  ].join("");
}

test("hover-scrollbars is disabled by default and exposes a standalone descriptor", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hover-scrollbars-"));
  try {
    const config = path.join(temp, "features.json");
    fs.writeFileSync(config, '{"enabled":[]}\n');
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({
        featuresRoot: path.join(__dirname, ".."),
        featuresConfigPath: config,
      }),
      [],
    );
    fs.writeFileSync(config, '{"enabled":["hover-scrollbars"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({
      featuresRoot: path.join(__dirname, ".."),
      featuresConfigPath: config,
    });
    assert.deepEqual(
      loaded.map(({ id, phase, ciPolicy }) => [id, phase, ciPolicy]),
      [["feature:hover-scrollbars:app-initial-style", "webview-asset", "optional"]],
    );
    assert.deepEqual(
      descriptors.map(({ id, phase }) => [id, phase]),
      [["app-initial-style", "webview-asset"]],
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("injects hover scrollbar CSS once and is idempotent", () => {
  const source = fixture();
  assert.equal(hoverScrollbarsContract(source), "current");
  const patched = applyHoverScrollbarsPatch(source);
  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(STYLE_ID));
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.ok(patched.includes(JSON.stringify(HOVER_SCROLLBAR_CSS)));
  assert.match(patched, /scrollbar-color:transparent transparent!important/);
  assert.match(patched, /scrollbar-gutter:auto/);
  assert.equal(hoverScrollbarsContract(patched), "patched");
  assert.equal(applyHoverScrollbarsPatch(patched), patched);
});

test("rejects unrecognized contracts byte-identically", () => {
  for (const source of ["export{app}", "overflow-y-auto only"]) {
    const result = captureWarnings(() => applyHoverScrollbarsPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current hover-scrollbars app-initial contract/);
  }
});

test("descriptor selects the current official app-initial bundle", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hover-scrollbars-assets-"));
  try {
    const assetsDir = path.join(temp, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "app-initial-iMhn6nFd.js"), fixture());
    fs.writeFileSync(path.join(assetsDir, "chatgpt-conversation-page-ChLif5-T.js"), fixture());
    const result = patchUniqueAssetFile(
      temp,
      APP_INITIAL_ASSET_PATTERN,
      descriptors[0].assetMatch,
      applyHoverScrollbarsPatch,
      "missing",
      "ambiguous",
    );
    const patched = fs.readFileSync(path.join(assetsDir, "app-initial-iMhn6nFd.js"), "utf8");
    const skipped = fs.readFileSync(path.join(assetsDir, "chatgpt-conversation-page-ChLif5-T.js"), "utf8");
    assert.deepEqual(result, { matched: 1, changed: 1, assetName: "app-initial-iMhn6nFd.js" });
    assert.match(patched, new RegExp(STYLE_ID));
    assert.equal(skipped, fixture());
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
