"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { patchExtractedApp } = require("../../scripts/patches/runner.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");

const fixed = new Set([
  "feature:authored-message-visibility:persistent-messages",
  ...["persistent", "request-summaries", "standalone", "transcript", "expanded", "general-setting"].map(id => `feature:reasoning-visibility:${id}`),
]);

test("full normal reasoning/authored pipeline applies every migrated contract then recognizes all applied copies", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  t.mock.method(console, "warn", () => {});
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "reasoning-full-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const originalAssets = path.join(original, "webview", "assets");
  const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const assets = listWebviewAssetFiles(originalAssets, /\.js$/);
  const hashes = new Map(assets.map(name => [name, hash(path.join(originalAssets, name))]));
  const app = path.join(root, "app");
  fs.cpSync(original, app, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["reasoning-visibility", "authored-message-visibility"] }));
  const run = () => {
    const report = createPatchReport();
    patchExtractedApp(app, { featuresRoot: path.resolve(__dirname, ".."), featuresConfigPath: config, report });
    return report;
  };
  const first = run(), second = run();
  for (const [report, expected] of [[first, "applied"], [second, "already-applied"]]) {
    const selected = report.patches.filter(patch => fixed.has(patch.name));
    assert.equal(selected.length, fixed.size);
    for (const patch of selected) assert.equal(patch.status, expected, `${patch.name}: ${patch.reason ?? patch.status}`);
  }
  // Upstream General settings is retained and participates in both passes.
  const changed = assets.filter(name => hash(path.join(app, "webview", "assets", name)) !== hashes.get(name));
  assert.ok(changed.length > 0);
  for (const [name, expected] of hashes) assert.equal(hash(path.join(originalAssets, name)), expected, `trusted input changed: ${name}`);
});
