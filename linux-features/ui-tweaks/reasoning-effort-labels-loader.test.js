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
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  captureWarnings,
  createPatchReport,
  enabledFeatureFailuresFromReport,
} = require("../../scripts/lib/patch-report.js");
const { ENGLISH_REASONING_LABELS } = require("./patches/reasoning-effort-labels.js");

const LABEL_ID = "feature:ui-tweaks:reasoning-effort-labels-english";
const FONT_ID = "feature:ui-tweaks:extended-ui-font-size";
const PHASE = "extracted-app:post-webview";
const LABELS = {
  "composer.mode.local.reasoning.none.label": "无",
  "composer.mode.local.reasoning.minimal.label": "极低",
  "composer.mode.local.reasoning.medium.label": "中",
  "composer.mode.local.reasoning.high.label": "高",
  "composer.mode.local.reasoning.xhigh.label": "极高",
  "composer.mode.local.reasoning.max.label": "Max",
  "composer.mode.local.reasoning.ultra.label": "Ultra",
  "composer.mode.local.reasoning.persistent.label": "持续",
  title: "推理设置",
  unrelated: "keep this text",
};

function catalog(dictionary, chunk, moduleId) {
  const encoded = JSON.stringify(dictionary)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'");
  return `export const __rspack_esm_ids=[${chunk}];export const __webpack_modules__={${moduleId}(e){e.exports=JSON.parse('${encoded}')}};`;
}

function fontRegistry() {
  return [
    "function settingsRegistry(schema,setting){",
    "let sansMin=11,sansMax=16,codeMin=8,codeMax=24,settings={",
    'sansFontSize:setting({key:"sansFontSize",schema:schema.number().min(sansMin).max(sansMax)}),',
    'codeFontSize:setting({key:"codeFontSize",schema:schema.number().min(codeMin).max(codeMax)})',
    "};return settings}",
  ].join("");
}

function workspace(t, variant, labelsEnabled) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "effort-label-loader-"));
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

  const chunk = variant === "renamed" ? 503113 : 101;
  const moduleId = variant === "renamed" ? "CurrentRenamedZhCn" : "ZhCn";
  const localeKey = variant === "bad-route" ? "zh-Hans" : "zh-CN";
  const entry = path.join(assets, "entry.js");
  fs.writeFileSync(entry,
    `export const __webpack_modules__={Loader(e,t,i){const locales={"../locales/${localeKey}.json":function(){return i.e(${chunk}).then(i.t.bind(i,"${moduleId}",19))}}}};`);
  const localeFiles = [entry];
  let target;
  if (variant !== "missing") {
    target = path.join(assets, `async/${chunk}.abcdef1234.js`);
    fs.writeFileSync(target, catalog(LABELS, chunk, moduleId));
    localeFiles.push(target);
  }
  if (variant === "duplicate") {
    const duplicate = path.join(assets, `async/${chunk}.fedcba4321.js`);
    fs.copyFileSync(target, duplicate);
    localeFiles.push(duplicate);
  }
  const traditional = path.join(assets, "async/102.abcdef1234.js");
  fs.writeFileSync(traditional, catalog({ ...LABELS, title: "繁體中文" }, 102, "ZhTw"));
  localeFiles.push(traditional);
  const before = new Map(localeFiles.map(file => [file, {
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
          reasoning: { keepEffortLabelsEnglish: { enabled: labelsEnabled } },
        },
      },
    },
  }) + "\n");
  const options = {
    featuresRoot,
    featuresConfigPath: configPath,
    strictConfig: true,
  };
  const features = loadEnabledLinuxFeatures(options);
  const descriptors = normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors(options)
    .filter(descriptor => descriptor.id === LABEL_ID || descriptor.id === FONT_ID));
  assert.deepEqual(descriptors.map(descriptor => descriptor.id).sort(), [FONT_ID, LABEL_ID].sort());
  assert.ok(descriptors.every(descriptor => descriptor.phase === PHASE));
  assert.equal(descriptors.find(descriptor => descriptor.id === LABEL_ID).enabled({}), labelsEnabled);
  assert.equal(descriptors.find(descriptor => descriptor.id === FONT_ID).enabled({}), true);

  function run() {
    const report = createPatchReport();
    report.enabledFeatures = features.map(feature => feature.id);
    const { warnings } = captureWarnings(() =>
      applyExtractedAppPatchDescriptors(root, descriptors, {}, report, PHASE));
    assert.equal(report.patches.length, 2);
    assert.ok(report.patches.every(patch => patch.sourceKind === "feature" && patch.featureId === "ui-tweaks"));
    return { report, warnings, rows: new Map(report.patches.map(patch => [patch.name, patch])) };
  }

  return { fonts, target, before, traditional, run };
}

function assertUnchanged(app, except) {
  for (const [file, original] of app.before) {
    if (file !== except) assert.equal(fs.readFileSync(file, "utf8"), original.source);
    assert.equal(fs.statSync(file).mode & 0o777, original.mode);
  }
}

function assertActiveFont(app, result, status) {
  assert.equal(result.rows.get(FONT_ID).status, status);
  for (const file of app.fonts) {
    assert.match(fs.readFileSync(file, "utf8"), /sansMax=32\/\*codex-linux-ui-font-size-max\*\//);
  }
}

for (const variant of ["missing", "duplicate", "renamed"]) {
  test(`real loader skips disabled English labels before ${variant} locale discovery while font tweak stays active`, t => {
    const app = workspace(t, variant, false);
    const first = app.run();
    assert.equal(first.rows.get(LABEL_ID).status, "skipped-disabled");
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(enabledFeatureFailuresFromReport(first.report), []);
    assertActiveFont(app, first, "applied");
    assertUnchanged(app);

    const repeat = app.run();
    assert.equal(repeat.rows.get(LABEL_ID).status, "skipped-disabled");
    assert.deepEqual(repeat.warnings, []);
    assert.deepEqual(enabledFeatureFailuresFromReport(repeat.report), []);
    assertActiveFont(app, repeat, "already-applied");
    assertUnchanged(app);
  });
}

for (const variant of ["standard", "renamed"]) {
  test(`real loader applies and repeats enabled English labels through the ${variant} native locale route`, t => {
    const app = workspace(t, variant, true);
    const original = app.before.get(app.target).source;
    let expected = original;
    for (const [key, label] of Object.entries(ENGLISH_REASONING_LABELS)) {
      expected = expected.replace(
        `${JSON.stringify(key)}:${JSON.stringify(LABELS[key])}`,
        `${JSON.stringify(key)}:${JSON.stringify(label)}`);
    }
    const first = app.run();
    assert.equal(first.rows.get(LABEL_ID).status, "applied");
    assert.deepEqual(first.warnings, []);
    assert.deepEqual(enabledFeatureFailuresFromReport(first.report), []);
    assert.equal(fs.readFileSync(app.target, "utf8"), expected);
    assertActiveFont(app, first, "applied");
    assertUnchanged(app, app.target);

    const repeat = app.run();
    assert.equal(repeat.rows.get(LABEL_ID).status, "already-applied");
    assert.deepEqual(repeat.warnings, []);
    assert.deepEqual(enabledFeatureFailuresFromReport(repeat.report), []);
    assert.equal(fs.readFileSync(app.target, "utf8"), expected);
    assertActiveFont(app, repeat, "already-applied");
    assertUnchanged(app, app.target);
  });
}

for (const variant of ["missing", "duplicate", "bad-route"]) {
  test(`real loader retains strict enabled-label failure for ${variant} locale state`, t => {
    const app = workspace(t, variant, true);
    const result = app.run();
    assert.equal(result.rows.get(LABEL_ID).status, "skipped-optional");
    assert.ok(result.warnings.some(warning => /Simplified Chinese locale/.test(warning)));
    const failures = enabledFeatureFailuresFromReport(result.report);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, LABEL_ID);
    assertActiveFont(app, result, "applied");
    assertUnchanged(app);
  });
}
