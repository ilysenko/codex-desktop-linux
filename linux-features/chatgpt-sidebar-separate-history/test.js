"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { normalizePatchDescriptors, applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { STORAGE_KEY, applySidebarHistoryPatch, matchesSidebarHistoryContract, descriptors } = require("./patch.js");

// Reduced rspack chunk shaped like the signed stable Linux 26.1029 webview:
// the preference module declares the persisted sidebar settings and the
// in-memory source atom; the sidebar module requires it and reads that atom
// only for the ChatGPT product. Other state and the Codex branch stay intact.
const PREFERENCES = 'RFDv(e,t,n){var r=n("ATOM"),u=n("SCOP"),f=n("PERS");' +
  'let g=(0,f.m3)("sidebar-organize-mode-v1",void 0),O=(0,r.vP)(u.u,{codex:0,work:0}),' +
  'R=(0,r.vP)(u.u,"all"),S=(0,r.vP)(u.u,"all");n.d(t,{},{MT:g,uM:R,vv:O,xx:S})}';
const SIDEBAR = 'sHm2(e,t,n){var C=n("SCOP"),M=n("RFDv");' +
  'function o(e,t){let l="chatgpt"===e?t(M.uM):"codex";return l}n.d(t,{select:()=>o})}';
const chunk = (...modules) => "export const __rspack_esm_id=24191;export const __rspack_esm_ids=[24191];" +
  `export const __webpack_modules__={${modules.join(",")}};`;
const CURRENT = chunk(PREFERENCES, SIDEBAR);

function load(source, saved = new Map()) {
  const marker = "export const __webpack_modules__=";
  const factories = vm.runInNewContext(`(${source.slice(source.indexOf(marker) + marker.length).replace(/;$/, "")})`);
  const externals = {
    SCOP: { u: {} },
    ATOM: { vP: (_, value) => ({ value }) },
    PERS: {
      m3: (key, fallback, options) => ({
        get value() {
          const value = saved.has(key) ? saved.get(key) : fallback;
          return options?.coerceStoredValue ? options.coerceStoredValue(value) : value;
        },
        set value(value) { saved.set(key, value); },
      }),
    },
  };
  const cache = new Map();
  function require(id) {
    if (Object.hasOwn(externals, id)) return externals[id];
    if (!cache.has(id)) {
      const module = { exports: {} };
      cache.set(id, module);
      factories[id](module, module.exports, require);
    }
    return cache.get(id).exports;
  }
  require.d = (exports, getters, values = {}) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(exports, key, { get, enumerable: true });
    Object.assign(exports, values);
  };
  return { ...require("RFDv"), select: require("sHm2").select };
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
  assert.equal(patched.xx.value, "all");
});

test("explicit All and Work selections survive renderer recreation", () => {
  const source = applySidebarHistoryPatch(CURRENT);
  const saved = new Map();
  for (const choice of ["all", "codex", "chatgpt"]) {
    const first = load(source, saved);
    first.uM.value = choice;
    const second = load(source, saved);
    assert.equal(second.select("chatgpt", atom => atom.value), choice);
    assert.equal(saved.get(STORAGE_KEY), choice);
  }
});

test("invalid preferences fall back to Chat", () => {
  for (const invalid of [null, false, 1, "unknown", {}, ["all"]]) {
    const scope = load(applySidebarHistoryPatch(CURRENT), new Map([[STORAGE_KEY, invalid]]));
    assert.equal(scope.uM.value, "chatgpt");
  }
});

test("matching follows renamed aliases and applying twice is idempotent", () => {
  const renamed = chunk(
    PREFERENCES.replaceAll("R=", "$R=").replace("uM:R", "uM:$R").replaceAll("f.m3", "$f.m3").replace("f=n(", "$f=n("),
    SIDEBAR.replaceAll("M.uM", "$M.uM").replace("M=n(", "$M=n("),
  );
  for (const source of [CURRENT, renamed]) {
    const patched = applySidebarHistoryPatch(source);
    assert.notEqual(patched, source);
    assert.equal(matchesSidebarHistoryContract(patched), true);
    assert.equal(applySidebarHistoryPatch(patched), patched);
    assert.ok(patched.endsWith(source.slice(source.indexOf("sHm2("))));
  }
});

test("missing, ambiguous, drifted, and partly patched contracts fail closed", () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    for (const source of [
      "const unrelated=true;",
      CURRENT.replace("}};", `},${SIDEBAR.replace("sHm2", "sHm3")}};`),
      CURRENT.replace('R=(0,r.vP)(u.u,"all")', 'R=(0,r.vP)(u.u,"codex")'),
      CURRENT.replace('uM:R', "uM:S").replace('S=(0,r.vP)(u.u,"all")', 'S=(0,r.vP)(u.u,"codex")'),
      CURRENT.replace('M=n("RFDv")', 'M=n("ZZZZ")'),
      CURRENT.replace("sidebar-organize-mode-v1", "sidebar-organize-mode-v2"),
      CURRENT.replace("}};", `},XXXX(e,t,n){const stray="${STORAGE_KEY}"}};`),
      applySidebarHistoryPatch(CURRENT).replace("S=(0,r.vP)", 'R=(0,r.vP)(u.u,"all"),S=(0,r.vP)'),
      CURRENT.replace("export const __webpack_modules__=", "export const modules="),
    ]) {
      assert.equal(matchesSidebarHistoryContract(source), false);
      assert.equal(applySidebarHistoryPatch(source), source);
    }
  } finally { console.warn = original; }
});

test("feature is opt-in and the descriptor selects one semantic rspack chunk", () => {
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
    fs.mkdirSync(path.join(assets, "async"), { recursive: true });
    const target = path.join(assets, "async", "24191.7b05d5cf83.js");
    fs.writeFileSync(target, CURRENT);
    fs.writeFileSync(path.join(assets, "async", "1.0000000000.js"), chunk('AAAA(e,t,n){let x=":\\"codex\\""}'));
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(dir, normalizePatchDescriptors(descriptors), {}, report);
    assert.deepEqual(report.patches.map(({ status }) => status), ["applied"]);
    assert.equal(fs.readFileSync(target, "utf8"), applySidebarHistoryPatch(CURRENT));
  } finally {
    if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
test("the signed official webview has one patchable sidebar source contract", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  const assets = findWebviewAssetsContaining(signedApp, descriptors[0].assetNeedles);
  const sources = assets.map((name) => fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8"));
  const matching = sources.filter(matchesSidebarHistoryContract);
  assert.equal(matching.length, 1);
  const patched = applySidebarHistoryPatch(matching[0]);
  assert.notEqual(patched, matching[0]);
  assert.equal(applySidebarHistoryPatch(patched), patched);
});
