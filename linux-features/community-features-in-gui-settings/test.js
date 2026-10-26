"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { UI, descriptors, settingsContract, settingComponent, applySettingsPatch } = require("./patch.js");
const { buildFeatureTree, renderCommunityFeaturesInGuiSettings } = require("./runtime.js");
const { loadLocaleResources, createTranslator } = require("./i18n.js");
const { CATALOG_ASSET, CATALOG_NAME, SNAPSHOT_NAME, buildCatalog, validateCatalog,
  readCatalogFromAsar, prepareUpdateBuilderCatalog } = require("./catalog.js");
const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport, enabledFeatureFailuresFromReport } = require("../../scripts/lib/patch-report.js");

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "community-features-in-gui-settings-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manifest(root, id, extra = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "feature.json"), JSON.stringify({
    id, title: `${id} title`, description: `${id} description`, defaultEnabled: false, ...extra,
  }));
  fs.writeFileSync(path.join(dir, "README.md"), id);
  return dir;
}

function settingsFixture() {
  return 'function menu(e){let i=intlHook(),{platform:p}=platformHook(),v=useSetting(keys.macMenuBarEnabled);if(p!==`macOS`)return null;let label=i.formatMessage({id:`settings.general.macMenuBar.ariaLabel`});let c=(0,j.jsx)(Toggle,{checked:v,onChange:change,ariaLabel:label});return(0,j.jsx)(Row,{label:title,description:description,control:c})}' +
    'function another(){let[e,t]=(0,React.useState)(!1)}var React=reactFactory();' +
    'function general(){let header=(0,j.jsx)(Section.Header,{title:(0,j.jsx)(Message,{id:`settings.general.groupTitle`,defaultMessage:`General`})});return(0,j.jsxs)(Section,{children:[header,(0,j.jsx)(Section.Content,{children:(0,j.jsxs)(Stack,{children:[(0,j.jsx)(menu,{appName:appName})]})})]})}' +
    'function generalPage(){let n=(0,j.jsx)(general,{}),title=(0,j.jsx)(PageTitle,{slug:`general-settings`}),i=(0,j.jsx)(Other,{});return(0,j.jsxs)(Page,{title:title,children:[n,i]})}var page=generalPage();/*settings.general.macMenuBar.description*/' +
    'function licenses(){let label=`settings.openSourceLicenses.view`;return(0,j.jsx)(Button,{color:`secondary`,size:`toolbar`,onClick:show,children:label})}';
}

function fixture(t) {
  const dir = temporary(t), root = path.join(dir, "linux-features");
  const featureDir = manifest(root, "community-features-in-gui-settings");
  manifest(root, "alpha", { requires: ["beta"] });
  manifest(root, "beta", { conflicts: ["gamma"] });
  manifest(root, "internal", { internal: true });
  manifest(root, "plain");
  manifest(path.join(root, "local"), "private");
  const assets = path.join(dir, "app/webview/assets");
  fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, "renamed-general.js");
  fs.writeFileSync(target, settingsFixture());
  const context = { feature: { dir: featureDir }, featurePatchOptions: { featuresRoot: root }, enabledFeatureIds: ["alpha", "community-features-in-gui-settings"] };
  return { dir, root, featureDir, assets, target, app: path.join(dir, "app"), context };
}

function builderSnapshot(f, catalog = buildCatalog(f.context)) {
  fs.writeFileSync(path.join(f.featureDir, CATALOG_NAME), JSON.stringify(catalog));
}

test("public entries include disabled features while local metadata requires explicit selection", (t) => {
  const f = fixture(t), catalog = buildCatalog(f.context);
  assert.deepEqual(catalog.features.map((feature) => feature.id), ["alpha", "beta", "community-features-in-gui-settings", "plain"]);
  assert.deepEqual(catalog.features.filter((feature) => feature.enabled).map((feature) => feature.id), ["alpha", "community-features-in-gui-settings"]);
  assert.deepEqual(catalog.features[0].requires, ["beta"]);
  assert.deepEqual(catalog.features[1].conflicts, ["gamma"]);
  assert.equal(catalog.features.some((feature) => feature.origin === "local"), false);
  const withLocal = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "private"] });
  assert.equal(withLocal.features.find((feature) => feature.id === "private").enabled, true);
  assert.equal(withLocal.features.find((feature) => feature.id === "private").origin, "local");
  assert.equal(fs.existsSync(path.join(f.featureDir, CATALOG_NAME)), false);
});

test("disabled private metadata and legacy snapshots never enter the renderer", (t) => {
  const f = fixture(t), marker = "DO-NOT-PUBLISH-DISABLED-PRIVATE-METADATA", warnings = [];
  manifest(path.join(f.root, "local"), "private", { title: marker, description: marker });
  fs.writeFileSync(path.join(f.featureDir, SNAPSHOT_NAME), JSON.stringify({
    schemaVersion: 1, sourceCommit: null, features: [{ id: "private", title: marker, description: marker,
      origin: "local", requires: [], conflicts: [], enabled: true }],
  }));
  t.mock.method(console, "warn", (warning) => warnings.push(warning));
  assert.equal(applySettingsPatch(f.app, f.context).changed, true);
  const generated = fs.readFileSync(path.join(f.app, CATALOG_ASSET), "utf8");
  assert.equal(generated.includes(marker), false);
  assert.equal(fs.readFileSync(f.target, "utf8").includes(marker), false);
  assert.equal(JSON.parse(generated).features.some((feature) => feature.id === "private"), false);
  manifest(path.join(f.root, "local"), "private", { title: "", description: false });
  manifest(f.root, "unrelated-invalid", { title: "" });
  assert.equal(applySettingsPatch(f.app, f.context).changed, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unrelated-invalid/);
});

test("new and changed public declarations appear without generated source files", (t) => {
  const f = fixture(t), original = buildCatalog(f.context);
  assert.equal(fs.existsSync(path.join(f.featureDir, CATALOG_NAME)), false);
  manifest(f.root, "plain", { title: "Updated public title", requires: ["beta"] });
  const added = manifest(f.root, "added-feature", { entrypoints: { patchDescriptors: "./patch.js" } });
  fs.writeFileSync(path.join(added, "patch.js"), 'throw Error("must not execute");');
  const changed = buildCatalog(f.context);
  assert.equal(changed.features.length, original.features.length + 1);
  assert.equal(changed.features.find((feature) => feature.id === "plain").title, "Updated public title");
  assert.deepEqual(changed.features.find((feature) => feature.id === "plain").requires, ["beta"]);
  assert.equal(changed.features.find((feature) => feature.id === "added-feature").enabled, false);
  assert.equal(fs.existsSync(path.join(f.featureDir, CATALOG_NAME)), false);
});

test("invalid unrelated public display metadata is diagnosed without hiding valid entries", (t) => {
  const f = fixture(t), warnings = [];
  manifest(f.root, "bad-description", { description: 42 });
  manifest(f.root, "bad-subfeatures", { catalogSubfeatures: [{ id: "broken" }] });
  manifest(path.join(f.root, "local"), "private", { title: "", description: false });
  const catalog = buildCatalog(f.context, (warning) => warnings.push(warning));
  assert.deepEqual(catalog.features.map((feature) => feature.id), ["alpha", "beta", "community-features-in-gui-settings", "plain"]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /bad-description/);
  assert.match(warnings[1], /bad-subfeatures/);
});

test("invalid selected local metadata stays nonfatal without weakening patch warnings", (t) => {
  const f = fixture(t), id = "community-features-in-gui-settings";
  manifest(path.join(f.root, "local"), "bad-title", { title: "" });
  f.context.enabledFeatureIds.push("bad-title");
  t.mock.method(console, "warn", () => {});
  const descriptor = { ...descriptors[0], id: `feature:${id}:general-list`, featureId: id, sourceKind: "feature", enforceWhenEnabled: true };
  const run = (patch = descriptor) => {
    const report = createPatchReport();
    report.enabledFeatures = [id];
    applyExtractedAppPatchDescriptors(f.app, [patch], f.context, report, patch.phase);
    return report;
  };
  const applied = run();
  assert.equal(applied.patches[0].status, "applied");
  assert.equal(applied.patches[0].warnings.length, 1);
  assert.deepEqual(enabledFeatureFailuresFromReport(applied), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.app, CATALOG_ASSET), "utf8")).features.some((feature) => feature.id === "bad-title"), false);
  const repeated = run();
  assert.equal(repeated.patches[0].status, "already-applied");
  assert.deepEqual(enabledFeatureFailuresFromReport(repeated), []);
  const unexpected = run({ ...descriptor, apply: (...args) => {
    const result = descriptor.apply(...args);
    console.warn("WARN: unexpected native settings drift");
    return result;
  } });
  assert.equal(enabledFeatureFailuresFromReport(unexpected).length, 1);
});

test("builder snapshots reject malformed data and disabled local metadata", (t) => {
  const f = fixture(t), original = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "private"] });
  builderSnapshot(f, original);
  const file = path.join(f.featureDir, CATALOG_NAME);
  assert.equal(buildCatalog(f.context).features.some((feature) => feature.id === "private"), false);
  for (const mutate of [
    (catalog) => { catalog.schemaVersion = 2; },
    (catalog) => { catalog.features[0].title = ""; },
    (catalog) => { catalog.features.find((feature) => feature.id === "private").enabled = false; },
  ]) {
    const invalid = JSON.parse(JSON.stringify(original));
    mutate(invalid);
    fs.writeFileSync(file, JSON.stringify(invalid));
    assert.throws(() => buildCatalog(f.context), /invalid.*catalog|disabled local/);
  }
});

test("updater workspace copies retain disabled public descriptions, provenance and current local metadata", (t) => {
  const f = fixture(t), original = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "private"] });
  original.sourceCommit = "0123456789abcdef".repeat(4);
  builderSnapshot(f, original);
  // copy_builder_bundle() copies linux-features/ but not root .codex-linux/.
  assert.equal(fs.existsSync(path.join(f.dir, ".codex-linux")), false);
  for (const id of ["alpha", "beta", "plain"]) fs.rmSync(path.join(f.root, id), { recursive: true });
  const context = { ...f.context, enabledFeatureIds: ["community-features-in-gui-settings"] };
  const rebuilt = buildCatalog(context);
  assert.equal(rebuilt.sourceCommit, original.sourceCommit);
  assert.deepEqual(rebuilt.features.map((feature) => feature.id), ["alpha", "beta", "community-features-in-gui-settings", "plain"]);
  assert.equal(rebuilt.features.find((feature) => feature.id === "alpha").enabled, false);
  assert.deepEqual(rebuilt.features.find((feature) => feature.id === "alpha").requires, ["beta"]);
  manifest(path.join(f.root, "local"), "private", { title: "Current selected local title" });
  const selected = buildCatalog({ ...context, enabledFeatureIds: [...context.enabledFeatureIds, "private"] });
  assert.equal(selected.features.find((feature) => feature.id === "private").title, "Current selected local title");
  fs.rmSync(path.join(f.root, "local"), { recursive: true });
  fs.writeFileSync(path.join(f.featureDir, SNAPSHOT_NAME), "malformed retired snapshot");
  assert.deepEqual(buildCatalog(context), rebuilt);
});

test("Nix dirty revisions retain their commit hash without relaxing snapshot validation", (t) => {
  const f = fixture(t), commits = ["c0d3ac1dc70652dcf9034896efb6e212b02b4b1f", "0123456789abcdef".repeat(4)];
  const script = `const fs=require("node:fs"),{buildCatalog}=require(${JSON.stringify(path.join(__dirname, "catalog.js"))});process.stdout.write(JSON.stringify(buildCatalog(JSON.parse(fs.readFileSync(0,"utf8")))));`;
  const build = (revision) => spawnSync(process.execPath, ["-e", script], {
    input: JSON.stringify(f.context), encoding: "utf8",
    env: { ...process.env, CODEX_LINUX_SOURCE_COMMIT: revision },
  });
  for (const commit of commits) for (const revision of [commit, `${commit}-dirty`]) {
    const result = build(revision);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sourceCommit, commit);
  }
  assert.notEqual(build("invalid-dirty").status, 0);
  const invalid = JSON.parse(build(commits[0]).stdout);
  invalid.sourceCommit = `${commits[0]}-dirty`;
  assert.throws(() => validateCatalog(invalid), /invalid catalog/);
});

test("SHA-256 source commits remain valid in packaged ASAR metadata", (t) => {
  const f = fixture(t), catalog = buildCatalog(f.context);
  catalog.sourceCommit = "0123456789abcdef".repeat(4);
  const asar = path.join(f.dir, "app.asar");
  writeAsar(asar, catalog);
  assert.deepEqual(readCatalogFromAsar(asar), catalog);
  for (const invalid of ["g".repeat(64), "f".repeat(65), "f".repeat(6)]) {
    assert.throws(() => validateCatalog({ ...catalog, sourceCommit: invalid }), /invalid catalog/);
  }
});

test("current manifests can hide internal and invalid entries from a builder snapshot", (t) => {
  const f = fixture(t), file = path.join(f.root, "alpha/feature.json");
  builderSnapshot(f);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.internal = true;
  fs.writeFileSync(file, JSON.stringify(data));
  const catalog = buildCatalog({ ...f.context, enabledFeatureIds: ["community-features-in-gui-settings"] });
  assert.equal(catalog.features.some((feature) => feature.id === "alpha"), false);
  manifest(f.root, "plain", { title: "" });
  const warnings = [];
  assert.equal(buildCatalog({ ...f.context, enabledFeatureIds: ["community-features-in-gui-settings"] }, (warning) => warnings.push(warning)).features.some((feature) => feature.id === "plain"), false);
  assert.equal(warnings.length, 1);
});

function uiTweaksFixture(t) {
  const f = fixture(t), source = require("../ui-tweaks/feature.json");
  const dir = manifest(f.root, source.id, source);
  // Catalog discovery must never evaluate feature implementations.
  fs.writeFileSync(path.join(dir, "patch.js"), 'throw Error("must not execute");');
  return f;
}

test("UI Tweaks exposes nine independently counted modules with parent-gated defaults and overrides", (t) => {
  const f = uiTweaksFixture(t);
  const parent = (catalog) => catalog.features.find((feature) => feature.id === "ui-tweaks");
  const disabled = buildCatalog(f.context);
  assert.equal(parent(disabled).subfeatures.length, 9);
  const paths = (object, prefix = "tweaks") => Object.entries(object).flatMap(([key, value]) =>
    key === "enabled" ? [`${prefix}.enabled`] : value && typeof value === "object" ? paths(value, `${prefix}.${key}`) : []);
  assert.deepEqual(parent(disabled).subfeatures.map((item) => item.settingPath).sort(),
    paths(require("../ui-tweaks/feature.json").tweaks).sort());
  assert.equal(parent(disabled).subfeatures.some((item) => item.enabled), false);
  assert.equal(buildFeatureTree(disabled).total, 13); // Four plain features and nine subfeatures.
  const enabledContext = { ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "ui-tweaks"] };
  assert.deepEqual(parent(buildCatalog(enabledContext)).subfeatures.filter((item) => item.enabled).map((item) => item.id),
    ["english-effort-labels", "sidebar-project-name"]);
  const config = path.join(f.root, "features.json");
  fs.writeFileSync(config, JSON.stringify({ enabled: enabledContext.enabledFeatureIds, settings: { "ui-tweaks": { tweaks: {
    appearance: { dockIcon: { enabled: true }, customFontInput: { enabled: true } },
    reasoning: { keepEffortLabelsEnglish: { enabled: false } }, sidebar: { projectName: { enabled: false } },
  } } } }));
  const configured = buildCatalog({ ...enabledContext, featurePatchOptions: { ...f.context.featurePatchOptions, featuresConfigPath: config } });
  assert.deepEqual(parent(configured).subfeatures.filter((item) => item.enabled).map((item) => item.id), ["dock-icon", "custom-font-input"]);
  assert.equal(buildFeatureTree(configured).enabled, 4);
  assert.equal(buildFeatureTree(configured).independentCount, 11);
  const render = uiHarness(configured);
  assert.equal(summaryRow(render()).props.description, "本次构建安装 4 项 · 支持 13 项");
  summaryRow(render()).props.control.props.onClick();
  item(render(), "independent").children[0].props.onClick(clickEvent());
  const folder = item(render(), "independent/ui-tweaks");
  assert.equal(folder.props["aria-expanded"], false);
  folder.children[0].children[0].props.onClick(clickEvent());
  const module = item(render(), "independent/ui-tweaks/ui-tweaks/dock-icon");
  assert.equal(module.props["aria-level"], 3);
  assert.equal(module.props["aria-label"], "Dock 图标，已安装");
  module.children[0].props.onClick(clickEvent());
  const detail = collect(render(), (node) => node.type === "native-row").at(-1);
  assert.equal(detail.props.label, "Dock 图标");
  assert.ok(JSON.stringify(detail.props.description).includes("所属功能：UI Tweaks"));
  assert.ok(JSON.stringify(detail.props.description).includes("ui-tweaks/dock-icon"));
});

test("subfeature parents show zero, partial and complete installation counts while collapsed and selected", (t) => {
  const f = uiTweaksFixture(t);
  const original = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "ui-tweaks"] });
  for (const [locale, suffix, installedWord, absentWord, punctuation] of [
    ["zh-CN", "已安装", "已安装", "未安装", "，"],
    ["en-US", "installed", "Installed", "Not installed", ", "],
    ["de-DE", "installed", "Installed", "Not installed", ", "],
  ]) for (const [enabled, count] of [[false, 0], [true, 0], [true, 1], [true, 9]]) {
    const catalog = structuredClone(original), parent = catalog.features.find(feature => feature.id === "ui-tweaks");
    parent.enabled = enabled;
    for (const subfeature of parent.subfeatures) {
      subfeature.enabled = count === 9 || count === 1 && subfeature.id === "custom-font-input";
    }
    const before = JSON.stringify(catalog), expected = `${count}/9 ${suffix}`;
    const render = uiHarness(catalog, locale);
    summaryRow(render()).props.control.props.onClick();
    item(render(), "independent").children[0].props.onClick(clickEvent());
    const row = item(render(), "independent/ui-tweaks"), status = row.children[0].children.at(-1);
    assert.equal(row.props["aria-expanded"], false);
    assert.equal(status.children[0], expected, `${locale}: ${enabled}/${count}`);
    assert.equal(row.props["aria-label"], `UI Tweaks${punctuation}${expected}`);
    assert.equal(status.props.style.color, count > 0 ? "var(--color-text-success)" : undefined);
    assert.equal(row.children[0].children.some(node => node?.type === "span" && node.children[0] === "9"), false);
    row.children[0].props.onClick(clickEvent());
    assert.equal(collect(render(), node => node.type === "native-row").at(-1).props.control.children[0], expected);
    row.children[0].children[0].props.onClick(clickEvent());
    const font = item(render(), "independent/ui-tweaks/ui-tweaks/custom-font-input");
    assert.equal(font.children[0].children.at(-1).children[0], count > 0 ? installedWord : absentWord);
    assert.equal(buildFeatureTree(catalog).enabled, count + 2);
    assert.equal(buildFeatureTree(catalog).total, 13);
    assert.equal(JSON.stringify(catalog), before);
  }
});

test("a parent's subfeature status excludes dependent features and leaves their leaf statuses unchanged", (t) => {
  const f = uiTweaksFixture(t);
  manifest(f.root, "dependent", { requires: ["ui-tweaks"] });
  const catalog = buildCatalog({ ...f.context,
    enabledFeatureIds: ["community-features-in-gui-settings", "ui-tweaks", "dependent"] });
  const parent = catalog.features.find(feature => feature.id === "ui-tweaks");
  for (const subfeature of parent.subfeatures) subfeature.enabled = subfeature.id === "custom-font-input";
  const render = uiHarness(catalog);
  summaryRow(render()).props.control.props.onClick();
  assert.equal(item(render(), "dependencies/ui-tweaks").children[0].children.at(-1).children[0], "1/9 已安装");
  assert.equal(item(render(), "dependencies/ui-tweaks/dependent").children[0].children.at(-1).children[0], "已安装");
});

test("public subfeature metadata survives enabled-only update builders and never reports a child of a disabled parent installed", (t) => {
  const f = uiTweaksFixture(t);
  const original = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "ui-tweaks"] });
  builderSnapshot(f, original);
  fs.rmSync(path.join(f.root, "ui-tweaks"), { recursive: true });
  const rebuilt = buildCatalog(f.context), modules = rebuilt.features.find((feature) => feature.id === "ui-tweaks").subfeatures;
  assert.equal(modules.length, 9);
  assert.equal(modules.some((item) => item.enabled), false);
  assert.equal(modules.find((item) => item.id === "english-effort-labels").defaultEnabled, true);
  assert.equal(buildFeatureTree(rebuilt).total, buildFeatureTree(original).total);
  assert.equal(buildFeatureTree(rebuilt).enabled, buildFeatureTree(original).enabled - 2);
  for (const mutate of [
    (item) => { item.enabled = true; },
    (item) => { item.settingPath = "constructor.prototype.enabled"; },
    (item) => { item.defaultEnabled = "yes"; },
  ]) {
    const invalid = JSON.parse(JSON.stringify(rebuilt));
    mutate(invalid.features.find((feature) => feature.id === "ui-tweaks").subfeatures[0]);
    assert.throws(() => validateCatalog(invalid), /subfeature/);
  }
});

test("semantic settings injection is self-contained, idempotent and leaves other assets unchanged", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.assets, "unrelated.js"), "unchanged");
  assert.equal(applySettingsPatch(f.app, f.context).changed, true);
  const patched = fs.readFileSync(f.target, "utf8");
  assert.ok(patched.includes(`function ${UI}()`));
  assert.ok(patched.includes(`children:[(0,j.jsx)(${UI},{}),n,i]`));
  assert.ok(patched.includes('children:[(0,j.jsx)(menu,{appName:appName})]'));
  const jsx = (type, props) => ({ type, props });
  const page = vm.runInNewContext(patched + ';page', {
    j: { jsx, jsxs: jsx, Fragment: "fragment" }, appName: "ChatGPT Community", reactFactory: () => ({}),
    Page: "page", PageTitle: "page-title", Other: "other",
  });
  assert.equal(page.props.children.length, 3);
  assert.equal(page.props.children[0].type.name, UI);
  assert.equal(page.props.children[1].type.name, "general");
  assert.equal(page.props.children[2].type, "other");
  const general = vm.runInNewContext(patched + ';general()', {
    j: { jsx, jsxs: jsx }, appName: "ChatGPT Community", reactFactory: () => ({}),
    Page: "page", PageTitle: "page-title", Other: "other", Section: { Header: "header", Content: "content" },
    Message: "message", Stack: "stack",
  });
  assert.equal(general.props.children[0].type, "header");
  assert.equal(general.props.children[1].props.children.props.children[0].type.name, "menu");
  assert.equal(fs.readFileSync(path.join(f.assets, "unrelated.js"), "utf8"), "unchanged");
  assert.equal(applySettingsPatch(f.app, f.context).changed, false);
  assert.equal(fs.readFileSync(f.target, "utf8"), patched);
  const component = settingComponent(settingsContract(settingsFixture()), buildCatalog(f.context));
  assert.doesNotThrow(() => new vm.Script(component));
});

test("missing or ambiguous anchors fail before changing settings or writing a catalog", (t) => {
  const cases = [
    (s) => s.replace(".macMenuBarEnabled", ".changedPreference"),
    (s) => s.replace("settings.openSourceLicenses.view", "changed.action"),
    (s) => s + 'var duplicate=(0,j.jsx)(menu,{appName:other});',
    (s) => s.replace("size:`toolbar`", "size:`changed`"),
    (s) => s.replace('title:title,children:[n,i]', 'title:title,children:n'),
    (s) => s.replace('settings.general.groupTitle', 'settings.general.changedGroup'),
    (s) => s.replace('slug:`general-settings`', 'slug:`different-page`'),
    (s) => s.replace('Section.Content', 'Changed.Content'),
    (s) => s + 'function duplicatePage(){let title=(0,j.jsx)(PageTitle,{slug:`general-settings`})}',
    (s) => s.replace('return(0,j.jsx)(Button,', 'var duplicate=(0,j.jsx)(Button,{color:`secondary`,size:`toolbar`,onClick:show,children:label});return(0,j.jsx)(Button,'),
  ];
  for (const change of cases) {
    const f = fixture(t), source = change(settingsFixture());
    fs.writeFileSync(f.target, source);
    assert.throws(() => applySettingsPatch(f.app, f.context), /(?:asset|contract) missing or ambiguous/);
    assert.equal(fs.readFileSync(f.target, "utf8"), source);
    assert.equal(fs.existsSync(path.join(f.app, CATALOG_ASSET)), false);
  }
  const f = fixture(t);
  fs.writeFileSync(path.join(f.assets, "duplicate.js"), settingsFixture());
  assert.throws(() => applySettingsPatch(f.app, f.context), /asset missing or ambiguous/);
  assert.equal(fs.readFileSync(f.target, "utf8"), settingsFixture());
});

test("incomplete patches and a changed candidate selection are rejected without partial repairs", (t) => {
  const f = fixture(t);
  applySettingsPatch(f.app, f.context);
  const original = fs.readFileSync(f.target, "utf8");
  assert.throws(() => applySettingsPatch(f.app, { ...f.context, enabledFeatureIds: ["community-features-in-gui-settings"] }), /inconsistent/);
  assert.equal(fs.readFileSync(f.target, "utf8"), original);
  fs.unlinkSync(path.join(f.app, CATALOG_ASSET));
  assert.throws(() => applySettingsPatch(f.app, f.context), /inconsistent/);
  assert.equal(fs.existsSync(path.join(f.app, CATALOG_ASSET)), false);
});

test("other General rows remain in place and an existing patch moved into the inner group is rejected", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.target, settingsFixture().replace('children:[(0,j.jsx)(menu,', 'children:[(0,j.jsx)(OtherSetting,{}),(0,j.jsx)(menu,'));
  applySettingsPatch(f.app, f.context);
  const patched = fs.readFileSync(f.target, "utf8");
  assert.ok(patched.includes('children:[(0,j.jsx)(OtherSetting,{}),(0,j.jsx)(menu,'));
  const moved = patched.replace(`children:[(0,j.jsx)(${UI},{}),n,i]`, 'children:[n,i]')
    .replace('children:[(0,j.jsx)(OtherSetting,{}),', `children:[(0,j.jsx)(${UI},{}),(0,j.jsx)(OtherSetting,{}),`);
  fs.writeFileSync(f.target, moved);
  assert.throws(() => applySettingsPatch(f.app, f.context), /inconsistent/);
  assert.equal(fs.readFileSync(f.target, "utf8"), moved);
});

function uiHarness(catalog, locale = "zh-CN", platform = "linux", resources = loadLocaleResources()) {
  const values = [];
  let index = 0;
  const React = {
    Fragment: "fragment", useState: (initial) => {
      const position = index++;
      if (!(position in values)) values[position] = typeof initial === "function" ? initial() : initial;
      return [values[position], (change) => { values[position] = typeof change === "function" ? change(values[position]) : change; }];
    },
    useId: () => "community-panel",
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((child) => child !== false && child != null) }),
  };
  return () => { index = 0; return renderCommunityFeaturesInGuiSettings({ React, Row: "native-row", Button: "native-button",
    Section: { Header: "native-header", Content: "native-content" }, Stack: "native-stack",
    catalog, locale, platform, resources, translate: createTranslator }); };
}

function collect(node, predicate) {
  if (typeof node !== "object" || node == null) return [];
  return [...(predicate(node) ? [node] : []),
    ...[...(node.children ?? []), node.props?.control, node.props?.description]
      .flatMap((child) => collect(child, predicate))];
}

const clickEvent = () => ({ stopPropagation() {}, currentTarget: { closest: () => ({ focus() {} }) } });
const items = (tree) => collect(tree, (node) => node.props.role === "treeitem");
const item = (tree, key) => items(tree).find((node) => node.props["data-path"] === key);
const summaryRow = (tree) => collect(tree, (node) => node.type === "native-row")[0];

test("English and zh_Hans_CN resources cover every interface message with locale aliases", () => {
  const resources = loadLocaleResources();
  assert.deepEqual(Object.keys(resources), ["en", "zh_Hans_CN"]);
  assert.deepEqual(Object.keys(resources.zh_Hans_CN.messages).sort(), Object.keys(resources.en.messages).sort());
  for (const locale of ["zh_Hans_CN", "zh-Hans-CN", "zh-CN", "zh_CN", "zh-Hans-SG", "zh"]) {
    const language = createTranslator(locale, resources);
    assert.equal(language.locale, "zh_Hans_CN", locale);
    assert.equal(language.format("summary", { enabled: 0, total: 47 }), "本次构建安装 0 项 · 支持 47 项");
  }
  for (const locale of ["en", "en-US", "en_GB", "de-DE", "zh-TW", "zh_Hant_TW", "zh-Hant-CN", "???", null, undefined]) {
    assert.equal(createTranslator(locale, resources).locale, "en", String(locale));
  }
  assert.equal(createTranslator("en", resources).format("expand", { name: "<b>$& {total}</b>" }), "Expand <b>$& {total}</b>");
});

function localeFixture(t) {
  const directory = path.join(temporary(t), "locales");
  fs.cpSync(path.join(__dirname, "locales"), directory, { recursive: true });
  return directory;
}

test("a new resource file adds a locale and feature translations with per-message English fallback", (t) => {
  const directory = localeFixture(t);
  fs.writeFileSync(path.join(directory, "fr.json"), JSON.stringify({ aliases: ["fr-FR"], messages: {
    title: "Fonctionnalités communautaires", summary: "{total} disponibles · {enabled} activées",
  }, features: { alpha: { title: "Alpha traduit", description: "Description traduite" }, beta: { title: "Bêta" } } }));
  const resources = loadLocaleResources(directory), language = createTranslator("fr-CA", resources);
  assert.equal(language.locale, "fr");
  assert.equal(language.messages.show, "Show");
  assert.equal(language.format("summary", { enabled: 1, total: 4 }), "4 disponibles · 1 activées");
  assert.equal(language.format("subfeatureStatus", { enabled: 1, total: 9 }), "1/9 installed");
  const catalog = buildCatalog(fixture(t).context), original = JSON.stringify(catalog);
  const render = uiHarness(catalog, "fr-CA", "linux", resources);
  assert.equal(collect(render(), (node) => node.type === "native-header")[0].props.title, "Fonctionnalités communautaires");
  summaryRow(render()).props.control.props.onClick();
  assert.equal(item(render(), "dependencies/beta/alpha").props["aria-label"], "Alpha traduit, Installed");
  item(render(), "dependencies/beta/alpha").children[0].props.onClick(clickEvent());
  const detail = collect(render(), (node) => node.type === "native-row").at(-1);
  assert.equal(detail.props.label, "Alpha traduit");
  assert.ok(JSON.stringify(detail.props.description).includes("Description traduite"));
  assert.ok(JSON.stringify(detail.props.description).includes("Requires: Bêta"));
  assert.equal(JSON.stringify(catalog), original);
});

test("invalid locale aliases, messages, placeholders and feature overrides fail during build preparation", (t) => {
  for (const change of [
    (resource) => { resource.messages.summary = "{enabled}"; },
    (resource) => { resource.messages.typo = "invalid"; },
    (resource) => { resource.aliases = ["en"]; },
    (resource) => { resource.aliases = ["invalid_@"]; },
    (resource) => { resource.features.alpha = { enabled: true }; },
  ]) {
    const directory = localeFixture(t), file = path.join(directory, "zh_Hans_CN.json");
    const resource = JSON.parse(fs.readFileSync(file, "utf8"));
    change(resource); fs.writeFileSync(file, JSON.stringify(resource));
    assert.throws(() => loadLocaleResources(directory), /community-features-in-gui-settings:/);
  }
  const directory = localeFixture(t);
  fs.unlinkSync(path.join(directory, "en.json"));
  assert.throws(() => loadLocaleResources(directory), /English fallback/);
});

test("dependency graph nests dependents under prerequisites and keeps independent features separate", (t) => {
  const model = buildFeatureTree(buildCatalog(fixture(t).context));
  assert.deepEqual(model.roots, ["beta"]);
  assert.deepEqual(model.children.get("beta"), ["alpha"]);
  assert.deepEqual(model.independent, ["community-features-in-gui-settings", "plain"]);
  assert.equal(model.familyCount, 2);
});

test("the embedded renderer carries its graph helper without depending on another renderer global", (t) => {
  const catalog = buildCatalog(fixture(t).context);
  const component = settingComponent(settingsContract(settingsFixture()), catalog);
  const jsx = (type, props, ...children) => ({ type, props: props ?? {}, children });
  const result = vm.runInNewContext(component + `;${UI}()`, {
    reactFactory: () => ({ Fragment: "fragment", createElement: jsx, useId: () => "tree-panel",
      useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}] }),
    platformHook: () => ({ platform: "linux" }), intlHook: () => ({ locale: "zh-CN" }), Row: "row", Button: "button",
    Section: { Header: "native-header", Content: "native-content" }, Stack: "native-stack",
  });
  assert.equal(result.children[0].props.title, "社区功能");
});

function graphCatalog(edges) {
  return { schemaVersion: 1, sourceCommit: null, features: Object.entries(edges).map(([id, requires]) => ({
    id, title: id, description: `${id} description`, requires, conflicts: [], enabled: false, origin: "repo",
  })) };
}

test("shared prerequisites retain every edge, count features once and include missing metadata", () => {
  const model = buildFeatureTree(graphCatalog({ a: [], b: [], child: ["a", "b"], missing: ["external"] }));
  assert.deepEqual(model.roots, ["a", "b", "external"]);
  assert.deepEqual(model.children.get("a"), ["child"]);
  assert.deepEqual(model.children.get("b"), ["child"]);
  assert.equal(model.familyCount, 4);
  assert.equal(model.nodes.get("external").enabled, null);
  const catalog = graphCatalog({ a: [], b: [], child: ["a", "b"] });
  catalog.features[2].subfeatures = [{ id: "one", enabled: true }, { id: "two", enabled: false }];
  const subfeatures = buildFeatureTree(catalog);
  assert.equal(subfeatures.total, 4);
  assert.equal(subfeatures.familyCount, 4);
  assert.equal(subfeatures.enabled, 1);
  assert.deepEqual(subfeatures.children.get("child"), ["child/one", "child/two"]);
});

test("native section wraps the catalog and installed statuses use the theme's green in tree and detail", (t) => {
  const render = uiHarness(buildCatalog(fixture(t).context));
  const section = render();
  assert.equal(section.children[0].type, "native-header");
  assert.equal(section.children[0].props.title, "社区功能");
  assert.equal(section.children[1].type, "native-content");
  assert.equal(section.children[1].children[0].type, "native-stack");
  summaryRow(section).props.control.props.onClick();
  const installed = item(render(), "dependencies/beta/alpha"), absent = item(render(), "dependencies/beta");
  assert.equal(installed.children[0].children.at(-1).props.style.color, "var(--color-text-success)");
  assert.equal(absent.children[0].children.at(-1).props.style.color, undefined);
  installed.children[0].props.onClick(clickEvent());
  assert.equal(collect(render(), (node) => node.type === "native-row").at(-1).props.control.props.style.color, "var(--color-text-success)");
});

test("cycles remain discoverable without infinite rendering or hiding unrelated components", () => {
  const catalog = graphCatalog({ a: ["b"], b: ["a"], c: ["d"], d: ["c"] });
  assert.deepEqual(buildFeatureTree(catalog).roots, ["a", "c"]);
  const render = uiHarness(catalog);
  summaryRow(render()).props.control.props.onClick();
  item(render(), "dependencies/a/b").children[0].children[0].props.onClick(clickEvent());
  const reference = item(render(), "dependencies/a/b/a");
  assert.equal(reference.props["aria-expanded"], undefined);
  assert.ok(JSON.stringify(reference).includes("循环引用"));
  assert.ok(items(render()).length < 10);
});

function pressTreeKey(render, key, path) {
  const current = render(), virtual = items(current);
  let focused;
  const dom = virtual.map((node) => ({
    dataset: { path: node.props["data-path"], parent: node.props["data-parent"], feature: node.props["data-feature"] },
    getAttribute: (name) => node.props[name] === undefined ? null : String(node.props[name]),
    focus() { focused = this.dataset.path; node.props.onFocus({ target: this, currentTarget: this }); },
  }));
  const target = dom.find((node) => node.dataset.path === path);
  let prevented = false, stopped = false;
  collect(current, (node) => node.props.role === "tree")[0].props.onKeyDown({
    key, target: { closest: () => target }, currentTarget: { querySelectorAll: () => dom },
    preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
  });
  assert.ok(prevented && stopped);
  return focused;
}

test("keyboard navigation expands folders, selects details and collapses without stranding focus", (t) => {
  const render = uiHarness(buildCatalog(fixture(t).context));
  summaryRow(render()).props.control.props.onClick();
  assert.equal(item(render(), "independent").props["aria-expanded"], false);
  pressTreeKey(render, "ArrowRight", "independent");
  assert.equal(item(render(), "independent").props["aria-expanded"], true);
  assert.equal(pressTreeKey(render, "ArrowDown", "independent"), "independent/community-features-in-gui-settings");
  assert.equal(collect(render(), (node) => node.type === "native-row").at(-1).props.label, "community-features-in-gui-settings title");
  assert.equal(pressTreeKey(render, "End", "independent/community-features-in-gui-settings"), "independent/plain");
  assert.equal(pressTreeKey(render, "ArrowLeft", "independent/plain"), "independent");
  pressTreeKey(render, "ArrowLeft", "independent");
  assert.equal(item(render(), "independent").props.tabIndex, 0);
  assert.equal(item(render(), "independent/plain"), undefined);
  assert.equal(pressTreeKey(render, "Home", "independent"), "dependencies");
});

test("read-only tree uses the active locale, per-node status and selectable native detail rows", (t) => {
  const catalog = buildCatalog(fixture(t).context);
  for (const [locale, title, show, punctuation] of [["zh-CN", "社区功能", "展开", "，"], ["zh_Hans_CN", "社区功能", "展开", "，"],
    ["zh-Hans-CN", "社区功能", "展开", "，"], ["en-US", "Community features", "Show", ", "], ["de", "Community features", "Show", ", "]]) {
    const render = uiHarness(catalog, locale);
    let tree = render(), button = collect(tree, (node) => node.type === "native-button")[0];
    assert.equal(collect(tree, (node) => node.type === "native-header")[0].props.title, title);
    assert.equal(button.children[0], show);
    assert.equal(button.props["aria-expanded"], false);
    assert.equal(collect(tree, (node) => node.props.role === "region").length, 0);
    button.props.onClick();
    tree = render();
    assert.equal(collect(tree, (node) => node.props.role === "tree").length, 1);
    assert.equal(items(tree).length, 4);
    assert.equal(item(tree, "dependencies/beta/alpha").props["aria-level"], 3);
    assert.equal(item(tree, "dependencies/beta/alpha").props["aria-label"], `alpha title${punctuation}${title === "社区功能" ? "已安装" : "Installed"}`);
    assert.equal(item(tree, "dependencies/beta").props["aria-label"], `beta title${punctuation}${title === "社区功能" ? "未安装" : "Not installed"}`);
    item(tree, "dependencies/beta/alpha").children[0].props.onClick(clickEvent());
    const detailRows = collect(render(), (node) => node.type === "native-row");
    assert.equal(detailRows.at(-1).props.label, "alpha title");
    assert.ok(JSON.stringify(detailRows.at(-1).props.description).includes("beta title"));
    assert.equal(collect(tree, (node) => node.props.role === "region")[0].props.id, "community-panel");
    collect(tree, (node) => node.type === "native-button")[0].props.onClick();
    assert.equal(collect(render(), (node) => node.props.role === "region").length, 0);
  }
  assert.equal(uiHarness(catalog, "en", "macOS")(), null);
  assert.equal(summaryRow(uiHarness(catalog)()).props.control.props["aria-expanded"], false);
});

test("empty groups render clearly and no metadata is interpreted as markup", () => {
  const feature = { id: "test", title: "<script>title</script>", description: "<img onerror=bad>", origin: "repo", enabled: false, requires: [], conflicts: [] };
  const catalog = validateCatalog({ schemaVersion: 1, sourceCommit: null, features: [feature] });
  const render = uiHarness(catalog), collapsed = render();
  summaryRow(collapsed).props.control.props.onClick();
  item(render(), "independent").children[0].props.onClick(clickEvent());
  item(render(), "independent/test").children[0].props.onClick(clickEvent());
  const rows = collect(render(), (node) => node.type === "native-row");
  assert.equal(rows[1].props.label, feature.title);
  assert.equal(rows[1].props.description.children[0].children[0], feature.description);
  assert.equal(collect(render(), (node) => node.props.dangerouslySetInnerHTML != null).length, 0);
});

function writeAsar(file, catalog) {
  const data = Buffer.from(JSON.stringify(catalog));
  const header = Buffer.from(JSON.stringify({ files: { webview: { files: { assets: { files: {
    "community-features-in-gui-settings-catalog.json": { offset: "0", size: data.length },
  } } } } } }));
  const headerSize = Math.ceil((header.length + 8) / 4) * 4;
  const prefix = Buffer.alloc(8 + headerSize);
  prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(headerSize, 4);
  prefix.writeUInt32LE(headerSize - 4, 8); prefix.writeUInt32LE(header.length, 12);
  header.copy(prefix, 16);
  fs.writeFileSync(file, Buffer.concat([prefix, data]));
}

test("native hooks generate builder snapshots and remove only the staged legacy file", (t) => {
  const f = fixture(t), catalog = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "private"] });
  const sourceLegacy = path.join(f.featureDir, SNAPSHOT_NAME);
  fs.writeFileSync(sourceLegacy, "source legacy file must remain untouched");
  for (const format of ["deb", "rpm", "pacman"]) {
    const app = path.join(temporary(t), "opt/codex-desktop"), builder = path.join(app, "update-builder");
    const feature = path.join(builder, "linux-features/community-features-in-gui-settings");
    const manifestFile = path.join(builder, ".codex-linux/update-builder-manifest.txt");
    fs.mkdirSync(path.join(app, "resources"), { recursive: true });
    fs.cpSync(f.featureDir, feature, { recursive: true });
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(path.join(feature, "keep.txt"), "unrelated owned resource");
    fs.writeFileSync(manifestFile, `install.sh\nlinux-features/community-features-in-gui-settings/${SNAPSHOT_NAME}\n`);
    writeAsar(path.join(app, "resources/app.asar"), catalog);
    const run = spawnSync("bash", [path.join(__dirname, "package.sh")], {
      env: { ...process.env, PACKAGE_FORMAT: format, PACKAGE_APP_DIR: app }, encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(feature, CATALOG_NAME), "utf8")), catalog);
    assert.equal(fs.existsSync(path.join(feature, SNAPSHOT_NAME)), false);
    assert.equal(fs.readFileSync(sourceLegacy, "utf8"), "source legacy file must remain untouched");
    assert.equal(fs.existsSync(path.join(f.featureDir, CATALOG_NAME)), false);
    assert.equal(fs.readFileSync(path.join(feature, "keep.txt"), "utf8"), "unrelated owned resource");
    assert.equal(fs.readFileSync(manifestFile, "utf8"), "install.sh\nlinux-features/community-features-in-gui-settings/catalog.json\n");
    prepareUpdateBuilderCatalog(app);
    assert.equal(fs.readFileSync(manifestFile, "utf8").split(CATALOG_NAME).length, 2);
    fs.rmSync(path.join(builder, ".codex-linux"), { recursive: true });
    const rebuilt = buildCatalog({ feature: { dir: feature }, featurePatchOptions: { featuresRoot: path.join(builder, "linux-features") },
      enabledFeatureIds: ["community-features-in-gui-settings"] });
    assert.deepEqual(rebuilt.features.map((item) => item.id), catalog.features.filter((item) => item.origin === "repo").map((item) => item.id));
    assert.equal(rebuilt.features.filter((item) => item.enabled).length, 1);
  }
  assert.equal(prepareUpdateBuilderCatalog(temporary(t)), false);
});

test("native packaging rejects disabled private metadata before changing staged files", (t) => {
  const f = fixture(t), catalog = buildCatalog({ ...f.context, enabledFeatureIds: [...f.context.enabledFeatureIds, "private"] });
  catalog.features.find((feature) => feature.id === "private").enabled = false;
  const app = path.join(temporary(t), "app"), builder = path.join(app, "update-builder");
  const feature = path.join(builder, "linux-features/community-features-in-gui-settings");
  const manifestFile = path.join(builder, ".codex-linux/update-builder-manifest.txt");
  fs.mkdirSync(path.join(app, "resources"), { recursive: true });
  fs.mkdirSync(feature, { recursive: true });
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(path.join(feature, CATALOG_NAME), "unchanged staged snapshot");
  fs.writeFileSync(path.join(feature, SNAPSHOT_NAME), "legacy snapshot");
  fs.writeFileSync(manifestFile, "unchanged\n");
  writeAsar(path.join(app, "resources/app.asar"), catalog);
  assert.throws(() => prepareUpdateBuilderCatalog(app), /disabled local metadata/);
  assert.equal(fs.readFileSync(manifestFile, "utf8"), "unchanged\n");
  assert.equal(fs.readFileSync(path.join(feature, CATALOG_NAME), "utf8"), "unchanged staged snapshot");
  assert.equal(fs.readFileSync(path.join(feature, SNAPSHOT_NAME), "utf8"), "legacy snapshot");
});

test("malformed ASAR/catalog snapshots fail before writing builder files", (t) => {
  const file = path.join(temporary(t), "app.asar");
  fs.writeFileSync(file, "broken");
  assert.throws(() => readCatalogFromAsar(file), /ASAR header/);
  writeAsar(file, { schemaVersion: 2, sourceCommit: null, features: [] });
  assert.throws(() => readCatalogFromAsar(file), /invalid catalog/);
  writeAsar(file, { schemaVersion: 1, sourceCommit: null, features: [] });
  fs.truncateSync(file, fs.statSync(file).size - 1);
  assert.throws(() => readCatalogFromAsar(file), /catalog bounds/);
});

test("feature remains disabled by default and enabled descriptors require no other feature", (t) => {
  const config = path.join(temporary(t), "features.json");
  fs.writeFileSync(config, '{"enabled":[]}');
  assert.equal(loadLinuxFeaturePatchDescriptors({ featuresConfigPath: config }).some((patch) => patch.featureId === "community-features-in-gui-settings"), false);
  fs.writeFileSync(config, '{"enabled":["community-features-in-gui-settings"]}');
  assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresConfigPath: config }).map((patch) => patch.id), ["feature:community-features-in-gui-settings:general-list"]);
});
