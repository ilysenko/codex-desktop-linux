#!/usr/bin/env node
"use strict";

// The setup wizard's feature step (scripts/bootstrap-wizard.sh) must treat
// feature ids the way the build loader does (scripts/lib/linux-features.js):
// aliases from the checkout's linux-features/compatibility.json map to their
// target, ids retired there are ignored, and typos or other unknown ids keep
// failing. Otherwise a config the build accepts is rejected or mangled by
// `make setup-native`, and a saved config keeps carrying ids the build
// silently drops.

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const WIZARD = path.resolve(__dirname, "bootstrap-wizard.sh");
const TARGET_DETECT = path.resolve(__dirname, "lib", "linux-target-detect.sh");
const COMPATIBILITY = {
  aliases: { "old-alpha": "alpha", "legacy-gone": "gone" },
  retired: ["gone", "dropped"],
};

function writeFeatures(featuresRoot, ids) {
  for (const id of ids) {
    const dir = path.join(featuresRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "feature.json"),
      JSON.stringify({ id, title: `${id} title`, defaultEnabled: false }),
    );
    fs.writeFileSync(path.join(dir, "README.md"), `# ${id}\n`);
  }
}

// A throwaway checkout: scripts/bootstrap-wizard.sh (without its final
// main "$@"), the library it sources, and linux-features/ with feature
// manifests, compatibility.json (a string is written verbatim; null leaves it
// out) and features.json.
function fixture(t, config, { features = ["alpha", "beta", "gamma"], compatibility = COMPATIBILITY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wizard-feature-ids-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fs.readFileSync(WIZARD, "utf8");
  const library = source.replace(/\nmain "\$@"\n$/, "\n");
  assert.notEqual(library, source, 'bootstrap-wizard.sh must end with main "$@"');
  const scriptPath = path.join(root, "scripts", "bootstrap-wizard.sh");
  fs.mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(scriptPath, library);
  fs.copyFileSync(TARGET_DETECT, path.join(root, "scripts", "lib", "linux-target-detect.sh"));

  const featuresRoot = path.join(root, "linux-features");
  writeFeatures(featuresRoot, features);
  if (compatibility !== null) {
    fs.writeFileSync(
      path.join(featuresRoot, "compatibility.json"),
      typeof compatibility === "string" ? compatibility : JSON.stringify(compatibility),
    );
  }
  const configPath = path.join(featuresRoot, "features.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  return { root, featuresRoot, configPath, scriptPath };
}

// Runs one wizard function the way `make setup-native` reaches it
// non-interactively, with $0 pointing at the fixture checkout's script.
function wizard(fx, args, env = {}) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("CODEX_LINUX_") || key.startsWith("CODEX_BOOTSTRAP_")) delete childEnv[key];
  }
  const result = childProcess.spawnSync(
    "bash",
    // The wizard parses "$@" at top level, so source it with no arguments.
    ["-c", 'lib="$1"; shift; call=("$@"); set --; source "$lib"; "${call[@]}"', fx.scriptPath, fx.scriptPath, ...args],
    {
      cwd: fx.root,
      encoding: "utf8",
      env: {
        ...childEnv,
        CODEX_BOOTSTRAP_NONINTERACTIVE: "1",
        CODEX_BOOTSTRAP_COLOR: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function featureStep(fx, { enable = "", disable = "" } = {}, env = {}) {
  return wizard(fx, ["prompt_for_feature_changes"], {
    CODEX_LINUX_FEATURES: enable,
    CODEX_LINUX_DISABLE_FEATURES: disable,
    ...env,
  });
}

const readConfig = (fx) => JSON.parse(fs.readFileSync(fx.configPath, "utf8"));

test("enable list maps aliases and ignores retired ids", (t) => {
  const fx = fixture(t, { enabled: [] });
  const run = featureStep(fx, { enable: "old-alpha,gone,legacy-gone,beta" });
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /Unknown Linux feature id/);
  assert.deepEqual(readConfig(fx).enabled, ["alpha", "beta"]);
});

test("disable list maps aliases and ignores retired ids", (t) => {
  const fx = fixture(t, { enabled: ["alpha", "beta"] });
  const run = featureStep(fx, { disable: "dropped,old-alpha" });
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /Unknown Linux feature id/);
  assert.deepEqual(readConfig(fx).enabled, ["beta"]);
});

test("numbered picks map aliases and ignore retired ids", (t) => {
  // Manifests left behind for a retired id and an alias source are listed
  // (alpha=1, beta=2, gamma=3, gone=4, old-alpha=5), but picking them by
  // number must behave like picking them by name.
  const features = ["alpha", "beta", "gamma", "gone", "old-alpha"];
  const enabled = fixture(t, { enabled: [] }, { features });
  const enableRun = featureStep(enabled, { enable: "4-5,2" });
  assert.equal(enableRun.status, 0, enableRun.output);
  assert.match(enableRun.output, /Ignoring retired Linux feature id\(s\): gone/);
  assert.deepEqual(readConfig(enabled).enabled, ["alpha", "beta"]);

  const disabled = fixture(t, { enabled: ["alpha", "beta"] }, { features });
  const disableRun = featureStep(disabled, { disable: "5" });
  assert.equal(disableRun.status, 0, disableRun.output);
  assert.deepEqual(readConfig(disabled).enabled, ["beta"]);
});

test("the checkout's compatibility table applies when CODEX_LINUX_FEATURES_ROOT points elsewhere", (t) => {
  // The loader always reads the checkout's linux-features/compatibility.json,
  // so another features root's own table (or its lack of one) changes nothing.
  for (const otherCompatibility of [{ aliases: {}, retired: [] }, null]) {
    const fx = fixture(t, { enabled: [] });
    const otherRoot = path.join(fx.root, "other-features");
    writeFeatures(otherRoot, ["alpha", "beta", "gamma"]);
    if (otherCompatibility !== null) {
      fs.writeFileSync(path.join(otherRoot, "compatibility.json"), JSON.stringify(otherCompatibility));
    }
    const otherConfig = path.join(otherRoot, "features.json");
    fs.writeFileSync(otherConfig, '{"enabled":[]}\n');
    const run = featureStep(fx, { enable: "old-alpha,gone" }, { CODEX_LINUX_FEATURES_ROOT: otherRoot });
    const label = otherCompatibility === null ? "no table" : "own table";
    assert.equal(run.status, 0, `${label}: ${run.output}`);
    assert.doesNotMatch(run.output, /Unknown Linux feature id/, label);
    assert.deepEqual(JSON.parse(fs.readFileSync(otherConfig, "utf8")).enabled, ["alpha"], label);
  }
});

test("the smart picker is skipped when the features root's table differs from the checkout's", (t) => {
  // scripts/feature-picker.py reads the features root's compatibility.json;
  // if that is not the checkout's table it would show a different enabled
  // state than the wizard applies, so the wizard must fall back.
  const cases = [
    { label: "default root", otherCompatibility: undefined, pickerRuns: true },
    { label: "root with another table", otherCompatibility: { aliases: {}, retired: [] }, pickerRuns: false },
    { label: "root without a table", otherCompatibility: null, pickerRuns: false },
  ];
  for (const { label, otherCompatibility, pickerRuns } of cases) {
    const fx = fixture(t, { enabled: ["alpha"] });
    const marker = path.join(fx.root, "picker-ran");
    // Stand-in for the GTK picker: records that it ran, then reports "cancelled".
    fs.writeFileSync(
      path.join(fx.root, "scripts", "feature-picker.py"),
      `import pathlib\npathlib.Path(${JSON.stringify(marker)}).write_text("ran")\nraise SystemExit(2)\n`,
    );
    const env = {};
    if (otherCompatibility !== undefined) {
      const otherRoot = path.join(fx.root, "other-features");
      writeFeatures(otherRoot, ["alpha", "beta", "gamma"]);
      if (otherCompatibility !== null) {
        fs.writeFileSync(path.join(otherRoot, "compatibility.json"), JSON.stringify(otherCompatibility));
      }
      fs.writeFileSync(path.join(otherRoot, "features.json"), '{"enabled":["alpha"]}\n');
      env.CODEX_LINUX_FEATURES_ROOT = otherRoot;
    }
    const run = wizard(fx, ["prompt_for_feature_changes_smart_gui"], env);
    assert.equal(fs.existsSync(marker), pickerRuns, `${label}: ${run.output}`);
    if (pickerRuns) {
      assert.equal(run.status, 0, `${label}: ${run.output}`);
    } else {
      assert.notEqual(run.status, 0, `${label}: ${run.output}`);
      assert.match(run.output, /Smart GTK feature picker skipped/, label);
    }
  }
});

test("a missing or malformed compatibility table is a setup error", (t) => {
  for (const compatibility of [null, "not json", JSON.stringify({ retired: [] })]) {
    const fx = fixture(t, { enabled: ["alpha"] }, { compatibility });
    const before = fs.readFileSync(fx.configPath, "utf8");
    const run = featureStep(fx, { enable: "beta" });
    assert.notEqual(run.status, 0, `${JSON.stringify(compatibility)}: ${run.output}`);
    assert.match(run.output, /Linux feature compatibility table/);
    assert.equal(fs.readFileSync(fx.configPath, "utf8"), before);
  }
});

test("saving normalises persisted enabled ids and settings keys in order", (t) => {
  const fx = fixture(t, {
    enabled: ["gamma", "legacy-gone", "old-alpha", "dropped"],
    settings: {
      "old-alpha": { k: 1 },
      gone: { x: 1 },
      beta: { keep: true },
      mystery: { m: 1 },
    },
    installer: { withUpdater: false },
  });
  const run = featureStep(fx, { enable: "beta" });
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /not found in this checkout/);
  assert.deepEqual(readConfig(fx), {
    enabled: ["gamma", "alpha", "beta"],
    settings: { alpha: { k: 1 }, beta: { keep: true }, mystery: { m: 1 } },
    installer: { withUpdater: false },
  });
});

test("listing a stale config reports only live ids and leaves the file alone", (t) => {
  const fx = fixture(t, { enabled: ["alpha", "gone", "legacy-gone"] });
  const before = fs.readFileSync(fx.configPath, "utf8");
  const run = featureStep(fx);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /^\[setup\] Enabled Linux features: alpha$/m);
  assert.doesNotMatch(run.output, /not found in this checkout/);
  assert.equal(fs.readFileSync(fx.configPath, "utf8"), before);
});

test("picker listing marks the target of a persisted alias as enabled", (t) => {
  const fx = fixture(t, { enabled: ["old-alpha"] });
  const run = wizard(fx, ["run_feature_config_python", "", "", "0", "tsv"]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(run.output.trim().split("\n"), [
    "alpha\talpha title\t1",
    "beta\tbeta title\t0",
    "gamma\tgamma title\t0",
  ]);
});

test("unknown ids that are not enabled still fail in the enable or disable list without saving", (t) => {
  for (const selector of [{ enable: "alfa" }, { disable: "alfa" }]) {
    const fx = fixture(t, { enabled: ["alpha"] });
    const before = fs.readFileSync(fx.configPath, "utf8");
    const run = featureStep(fx, selector);
    assert.notEqual(run.status, 0, `${JSON.stringify(selector)}: ${run.output}`);
    assert.match(run.output, /Unknown Linux feature id: alfa/);
    assert.equal(fs.readFileSync(fx.configPath, "utf8"), before);
  }
});

test("an unknown id that is already enabled can still be disabled", (t) => {
  const fx = fixture(t, { enabled: ["alpha", "mystery"] });
  const run = featureStep(fx, { disable: "mystery" });
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(readConfig(fx).enabled, ["alpha"]);
});

test("an unknown persisted id is kept on save and still reported", (t) => {
  const fx = fixture(t, { enabled: ["alpha", "mystery"] });
  const run = featureStep(fx, { enable: "beta" });
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /Enabled feature ids not found in this checkout: mystery/);
  assert.deepEqual(readConfig(fx).enabled, ["alpha", "mystery", "beta"]);
});
