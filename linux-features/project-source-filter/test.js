#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const { applyProjectSourceFilterPatch, descriptors } = require("./patch.js");

const fixture = [
  "function Sidebar(e){\"use forget\";let t=(0,cache.c)(131),{catalogPageScope:n,catalogSourcesReady:r,codexFeaturesAllowed:i,conversationSections:a,unreadsOnly:o,sidebarMode:s,workCloudSidebarContentVisible:c,workLocalSidebarContentVisible:l}=e,u=a!==void 0&&a,d=o!==void 0&&o,f=ml(Z),{accountId:p,authMethod:m}=Ao(),",
  "yt=Hl(xO,gt.activeConversationId??gt.activeServerConversationId),bt=pt;",
  "let on=(0,M3.jsx)(p3,{heading:`Projects`,titleActions:(0,M3.jsx)(xra,{chatGptProjectCrudStatus:gt.projectCrudStatus,menuRef:S,mode:`project`,sidebarMode:s,onCreateChatGptProject:gt.handleCreateProjectOpen}),titleActionsOnHover:!0,children:bt.projectKeys});return on}",
  "function Following(e){let{key:t}=e;return t}",
].join("");

function captureWarnings(callback) {
  const original = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try { return { result: callback(), warnings }; }
  finally { console.warn = original; }
}

function withFeatureConfig(enabled, callback) {
  const original = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-source-filter-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(directory, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return callback();
  } finally {
    if (original == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("feature stays disabled by default and loads when selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  const selected = () => loadLinuxFeaturePatchDescriptors({ featuresRoot }).some(
    (descriptor) => descriptor.id === "feature:project-source-filter:projects-sidebar-source-filter",
  );
  withFeatureConfig([], () => assert.equal(selected(), false));
  withFeatureConfig(["project-source-filter"], () => assert.equal(selected(), true));
});

test("patch adds a saved source control to ChatGPT-mode Projects only", () => {
  const patched = applyProjectSourceFilterPatch(fixture);
  assert.notEqual(patched, fixture);
  assert.equal(applyProjectSourceFilterPatch(patched), patched);
  assert.match(patched, /codexLinuxProjectSourceFilterAtom=us\(`codex-linux-project-source-filter-v1`,`all`\)/);
  assert.match(patched, /codexLinuxProjectSourceMode=Q\(codexLinuxGetProjectSourceFilterAtom\(\)\)/);
  assert.match(patched, /titleActions:s===`chatgpt`\?/);
  assert.match(patched, /titleActionsOnHover:s!==`chatgpt`/);
  assert.match(patched, /"aria-label":o/);
  assert.match(patched, /type:`radio`/);
});

test("project keys are filtered by source only in ChatGPT project grouping", () => {
  const patched = applyProjectSourceFilterPatch(fixture);
  const expression = patched.match(/,bt=(s===`chatgpt`&&ae===`project`.+?:pt);/)?.[1];
  assert.ok(expression);
  const select = new Function("s", "ae", "codexLinuxProjectSourceMode", "pt", `return ${expression};`);
  const layout = { projectKeys: ["chatgpt:project:one", "codex:project:two", "codex:project:three"] };
  assert.equal(select("chatgpt", "project", "all", layout), layout);
  assert.deepEqual(select("chatgpt", "project", "chatgpt", layout).projectKeys, ["chatgpt:project:one"]);
  assert.deepEqual(select("chatgpt", "project", "codex", layout).projectKeys, ["codex:project:two", "codex:project:three"]);
  assert.equal(select("codex", "project", "chatgpt", layout), layout);
  assert.equal(select("chatgpt", "list", "codex", layout), layout);
  assert.deepEqual(layout.projectKeys, ["chatgpt:project:one", "codex:project:two", "codex:project:three"]);
});

test("missing, duplicate, and partially patched anchors preserve the asset", () => {
  for (const source of [
    fixture.replace("titleActions:(0,M3.jsx)(xra", "titleActions:(0,M3.jsx)(other"),
    `${fixture}${fixture}`,
    fixture.replace("f=ml(Z)", "codexLinuxProjectSourceMode=Q(codexLinuxGetProjectSourceFilterAtom())"),
    applyProjectSourceFilterPatch(fixture).replace("titleActions:s===`chatgpt`?", "titleActions:missing?"),
  ]) {
    const { result, warnings } = captureWarnings(() => applyProjectSourceFilterPatch(source));
    assert.equal(result, source);
    assert.equal(warnings.length, 1);
  }
});

test("descriptor patches only the initial sidebar asset", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "project-source-filter-assets-"));
  try {
    const assets = path.join(directory, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const target = path.join(assets, "app-initial-example.js");
    const other = path.join(assets, "another-example.js");
    fs.writeFileSync(target, fixture);
    fs.writeFileSync(other, fixture);
    assert.deepEqual(patchAssetFiles(directory, descriptors[0].pattern, descriptors[0].apply, "missing"), { matched: 1, changed: 1 });
    assert.notEqual(fs.readFileSync(target, "utf8"), fixture);
    assert.equal(fs.readFileSync(other, "utf8"), fixture);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
