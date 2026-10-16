"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const { STORAGE_KEY, applySidebarHistoryPatch, matchesSidebarHistoryContract, descriptors } = require("./patch.js");

// Reduced producer and consumer contracts from the signed stable Linux bundle.
// Other state, account capabilities, and the Codex branch must stay intact.
const CURRENT = "var G7n,i9n,other;G7n=Ig(`sidebar-organize-mode-v1`,void 0),i9n=nc(q,`all`),other=nc(q,`all`);" +
  "function select(e,t){let o=e===`chatgpt`?t(i9n):`codex`;return o}";

function load(source, saved = new Map()) {
  const context = {
    q: {},
    nc: (_, value) => ({ value }),
    Ig: (key, fallback, options) => ({
      get value() {
        const value = saved.has(key) ? saved.get(key) : fallback;
        return options?.coerceStoredValue ? options.coerceStoredValue(value) : value;
      },
      set value(value) { saved.set(key, value); },
    }),
  };
  vm.runInNewContext(source, context);
  return context;
}

test("Business Work availability makes the upstream All default mix histories", () => {
  const upstream = load(CURRENT);
  const patched = load(applySidebarHistoryPatch(CURRENT));
  const conversations = [{ id: "chat", source: "chatgpt" }, { id: "task", source: "codex" }];
  const visible = (scope, workAllowed) => {
    const source = scope.select("chatgpt", atom => atom.value);
    return conversations.filter(item => item.source === "chatgpt" || workAllowed)
      .filter(item => source === "all" || item.source === source).map(item => item.id);
  };
  assert.deepEqual(visible(upstream, true), ["chat", "task"]);
  assert.deepEqual(visible(upstream, false), ["chat"]);
  assert.deepEqual(visible(patched, true), ["chat"]);
  assert.deepEqual(visible(patched, false), ["chat"]);
  assert.equal(patched.select("codex", () => { throw Error("Codex must not read the Chat filter"); }), "codex");
  assert.equal(patched.other.value, "all");
});

test("explicit All and Work selections survive renderer recreation", () => {
  const source = applySidebarHistoryPatch(CURRENT);
  const saved = new Map();
  for (const choice of ["all", "codex", "chatgpt"]) {
    const first = load(source, saved);
    first.i9n.value = choice;
    const second = load(source, saved);
    assert.equal(second.select("chatgpt", atom => atom.value), choice);
    assert.equal(saved.get(STORAGE_KEY), choice);
  }
});

test("invalid preferences fall back to Chat", () => {
  for (const invalid of [null, false, 1, "unknown", {}, ["all"]]) {
    const scope = load(applySidebarHistoryPatch(CURRENT), new Map([[STORAGE_KEY, invalid]]));
    assert.equal(scope.i9n.value, "chatgpt");
  }
});

test("matching follows renamed aliases and applying twice is idempotent", () => {
  for (const source of [CURRENT, CURRENT.replaceAll("i9n", "$source").replaceAll("Ig", "$persist")]) {
    const patched = applySidebarHistoryPatch(source);
    assert.notEqual(patched, source);
    assert.equal(matchesSidebarHistoryContract(patched), true);
    assert.equal(applySidebarHistoryPatch(patched), patched);
    assert.ok(patched.endsWith(source.slice(source.indexOf("function select"))));
  }
});

test("missing, ambiguous, drifted, and partly patched contracts fail closed", () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    for (const source of [
      "const unrelated=true;",
      CURRENT + CURRENT,
      CURRENT.replace("i9n=nc(q,`all`)", "i9n=nc(q,`codex`)"),
      CURRENT.replace("i9n=nc(q,`all`)", "other_i9n=nc(q,`all`)"),
      CURRENT.replace("sidebar-organize-mode-v1", "sidebar-organize-mode-v2"),
      CURRENT + `;const stray=\`${STORAGE_KEY}\`;`,
      applySidebarHistoryPatch(CURRENT) + ";i9n=nc(q,`all`);",
    ]) {
      assert.equal(matchesSidebarHistoryContract(source), false);
      assert.equal(applySidebarHistoryPatch(source), source);
    }
  } finally { console.warn = original; }
});

test("feature is opt-in and the descriptor selects one semantic asset", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "separate-chatgpt-sidebar-"));
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;
  try {
    const config = path.join(dir, "features.json");
    process.env.CODEX_LINUX_FEATURES_CONFIG = config;
    const featuresRoot = path.resolve(__dirname, "..");
    const selected = () => loadLinuxFeaturePatchDescriptors({ featuresRoot })
      .filter(d => d.id === "feature:chatgpt-sidebar-separate-history:source-preference");
    fs.writeFileSync(config, JSON.stringify({ enabled: [] }));
    assert.equal(selected().length, 0);
    fs.writeFileSync(config, JSON.stringify({ enabled: ["chatgpt-sidebar-separate-history"] }));
    assert.equal(selected().length, 1);
    const assets = path.join(dir, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(assets, "renamed-bundle.js"), CURRENT);
    const d = descriptors[0];
    const result = patchUniqueAssetFile(dir, d.pattern, d.assetMatch, d.apply, "missing", "ambiguous");
    assert.equal(result.matched, 1);
    assert.equal(result.changed, 1);
  } finally {
    if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
