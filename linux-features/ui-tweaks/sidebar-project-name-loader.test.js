"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyExtractedAppPatchDescriptors,
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  captureWarnings,
  createPatchReport,
  enabledFeatureFailuresFromReport,
} = require("../../scripts/lib/patch-report.js");
const {
  DEFAULT_PROJECT_NAME_STYLE,
  RUNTIME_MARKER,
  sidebarProjectNameCss,
} = require("./patches/sidebar-project-name.js");

const SIDEBAR_ID = "feature:ui-tweaks:sidebar-project-name-style";
const FONT_ID = "feature:ui-tweaks:extended-ui-font-size";
const CUSTOM_STYLE = "font-weight: 800 !important; color: red;";
const INVALID_STYLE = "color: red; } body { display: none;";
const CURRENT_SIDEBAR = [
  'const attrs={sidebarProjectRow:"data-app-action-sidebar-project-row",sidebarProjectLabel:"data-app-action-sidebar-project-label"};',
  'const selectors={sidebarProjectRow:`[${attrs.sidebarProjectRow}]`};',
  "const actions={sidebarProjectRow:({collapsed:e,label:t,projectId:n})=>({collapsed:e,label:t,projectId:n})};",
  'function marquee(){return {"data-marquee-text":!0}}',
].join("");

function fontRegistry() {
  return [
    "function settingsRegistry(schema,setting){",
    "let sansMin=11,sansMax=16,codeMin=8,codeMax=24,settings={",
    'sansFontSize:setting({key:"sansFontSize",schema:schema.number().min(sansMin).max(sansMax)}),',
    'codeFontSize:setting({key:"codeFontSize",schema:schema.number().min(codeMin).max(codeMax)})',
    "};return settings}",
  ].join("");
}

function workspace(t, variant, sidebarEnabled, style = CUSTOM_STYLE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-loader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const featuresRoot = path.join(root, "linux-features");
  const featureDir = path.join(featuresRoot, "ui-tweaks");
  fs.mkdirSync(featureDir, { recursive: true });
  for (const name of ["feature.json", "README.md", "patch.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(featureDir, name));
  }
  fs.cpSync(path.join(__dirname, "patches"), path.join(featureDir, "patches"), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, "../../scripts"), path.join(root, "scripts"), "dir");

  const assets = path.join(root, "webview/assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  fs.mkdirSync(path.join(root, ".vite/build"), { recursive: true });
  const fonts = [
    path.join(root, ".vite/build/early-bootstrap.js"),
    path.join(root, ".vite/build/worker.js"),
    path.join(assets, "async/410.abcdef.js"),
    path.join(assets, "async/411.abcdef.js"),
  ];
  for (const file of fonts) fs.writeFileSync(file, fontRegistry());
  const sidebarFiles = [];
  if (variant === "missing") {
    const unrelated = path.join(assets, "async/sidebar-unrelated.js");
    fs.writeFileSync(unrelated, "const unrelatedSidebar=true;");
    sidebarFiles.push(unrelated);
  } else {
    const owner = path.join(assets, "async/sidebar-owner.js");
    fs.writeFileSync(owner, CURRENT_SIDEBAR);
    sidebarFiles.push(owner);
    if (variant === "duplicate") {
      const duplicate = path.join(assets, "async/sidebar-owner-copy.js");
      fs.copyFileSync(owner, duplicate);
      sidebarFiles.push(duplicate);
    }
  }
  const before = new Map(sidebarFiles.map(file => [file, {
    source: fs.readFileSync(file, "utf8"),
    mode: fs.statSync(file).mode & 0o777,
  }]));
  const configPath = path.join(root, "features.json");
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: ["ui-tweaks"],
    settings: {
      "ui-tweaks": {
        tweaks: {
          appearance: { uiFontSize: { enabled: true, max: 32 } },
          sidebar: { projectName: { enabled: sidebarEnabled, style } },
        },
      },
    },
  }) + "\n");
  const options = { featuresRoot, featuresConfigPath: configPath, strictConfig: true };
  const features = loadEnabledLinuxFeatures(options);
  const descriptors = normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors(options)
    .filter(descriptor => descriptor.id === SIDEBAR_ID || descriptor.id === FONT_ID));
  assert.deepEqual(descriptors.map(descriptor => descriptor.id).sort(), [FONT_ID, SIDEBAR_ID].sort());
  assert.equal(descriptors.find(descriptor => descriptor.id === SIDEBAR_ID).phase, "webview-asset");
  assert.equal(descriptors.find(descriptor => descriptor.id === FONT_ID).enabled({}), true);

  function run() {
    const report = createPatchReport();
    report.enabledFeatures = features.map(feature => feature.id);
    const { warnings } = captureWarnings(() => {
      applyWebviewAssetPatchDescriptors(root, descriptors, {}, report);
      applyExtractedAppPatchDescriptors(root, descriptors, {}, report, "extracted-app:post-webview");
    });
    assert.equal(report.patches.length, 2);
    assert.ok(report.patches.every(patch => patch.sourceKind === "feature" && patch.featureId === "ui-tweaks"));
    return { report, warnings, rows: new Map(report.patches.map(patch => [patch.name, patch])) };
  }
  return { fonts, sidebarFiles, before, run };
}

function assertFont(app, result, status) {
  assert.equal(result.rows.get(FONT_ID).status, status);
  for (const file of app.fonts) {
    assert.match(fs.readFileSync(file, "utf8"), /sansMax=32\/\*codex-linux-ui-font-size-max\*\//);
  }
}

function assertSidebarUnchanged(app) {
  for (const [file, before] of app.before) {
    assert.equal(fs.readFileSync(file, "utf8"), before.source);
    assert.equal(fs.statSync(file).mode & 0o777, before.mode);
  }
}

for (const variant of ["missing", "duplicate", "present"]) {
  test(`real loader skips disabled sidebar style before ${variant} owner discovery while another tweak applies`, t => {
    const app = workspace(t, variant, false, INVALID_STYLE);
    const first = app.run();
    assert.equal(first.rows.get(SIDEBAR_ID).status, "skipped-disabled");
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(enabledFeatureFailuresFromReport(first.report), []);
    assertSidebarUnchanged(app);
    assertFont(app, first, "applied");

    const repeat = app.run();
    assert.equal(repeat.rows.get(SIDEBAR_ID).status, "skipped-disabled");
    assert.deepEqual(repeat.warnings, []);
    assert.deepEqual(enabledFeatureFailuresFromReport(repeat.report), []);
    assertSidebarUnchanged(app);
    assertFont(app, repeat, "already-applied");
  });
}

test("real loader applies valid sidebar style and repeats through the native owner", t => {
  const app = workspace(t, "present", true);
  const first = app.run();
  assert.equal(first.rows.get(SIDEBAR_ID).status, "applied");
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(enabledFeatureFailuresFromReport(first.report), []);
  assertFont(app, first, "applied");
  const after = fs.readFileSync(app.sidebarFiles[0], "utf8");
  assert.ok(after.startsWith(CURRENT_SIDEBAR + "\n"));
  assert.equal(after.split(RUNTIME_MARKER).length - 1, 1);
  assert.ok(after.includes(JSON.stringify(sidebarProjectNameCss(CUSTOM_STYLE))));
  assert.equal(fs.statSync(app.sidebarFiles[0]).mode & 0o777, app.before.get(app.sidebarFiles[0]).mode);

  const repeat = app.run();
  assert.equal(repeat.rows.get(SIDEBAR_ID).status, "already-applied");
  assert.deepEqual(repeat.warnings, []);
  assert.deepEqual(enabledFeatureFailuresFromReport(repeat.report), []);
  assert.equal(fs.readFileSync(app.sidebarFiles[0], "utf8"), after);
  assertFont(app, repeat, "already-applied");
});

for (const variant of ["missing", "duplicate"]) {
  test(`real loader retains strict enabled-sidebar refusal for ${variant} native owner`, t => {
    const app = workspace(t, variant, true);
    const result = app.run();
    assert.equal(result.rows.get(SIDEBAR_ID).status, "skipped-optional");
    assert.ok(result.warnings.length > 0);
    const failures = enabledFeatureFailuresFromReport(result.report);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, SIDEBAR_ID);
    assertSidebarUnchanged(app);
    assertFont(app, result, "applied");
  });
}

test("real loader validates enabled sidebar CSS once and retains its safe fallback", t => {
  const app = workspace(t, "present", true, INVALID_STYLE);
  const result = app.run();
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /safe CSS declaration list/);
  assert.equal(result.rows.get(SIDEBAR_ID).status, "applied-with-warnings");
  assertFont(app, result, "applied");
  const after = fs.readFileSync(app.sidebarFiles[0], "utf8");
  assert.ok(after.includes(JSON.stringify(sidebarProjectNameCss(DEFAULT_PROJECT_NAME_STYLE))));
  assert.equal(after.split(RUNTIME_MARKER).length - 1, 1);
  assert.doesNotMatch(after, /body \{ display: none/);
});
