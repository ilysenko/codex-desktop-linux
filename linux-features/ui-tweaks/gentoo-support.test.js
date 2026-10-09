"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const test = require("node:test");
const {
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  gentooFeaturePlan,
  validateGentooFeatureSnapshot,
  restoreGentooFeaturePayloadPermissions,
  renderGentooEbuild,
} = require("../../scripts/lib/gentoo-feature-support.js");

const root = path.resolve(__dirname, "../..");
const featuresRoot = path.join(root, "linux-features");
const hasPortageParser = cp.spawnSync("python3", ["-c", "from portage.dep import Atom"], { stdio: "ignore" }).status === 0;

function fixture(t, enabled = ["ui-tweaks"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui-tweaks-gentoo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const featuresConfigPath = path.join(dir, "features.json");
  const writeConfig = (ids) => fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: ids }));
  writeConfig(enabled);
  return { dir, options: { featuresRoot, featuresConfigPath }, writeConfig };
}

test("Gentoo ui-tweaks declares only an enabled runtime flock dependency", (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  assert.equal(manifest.defaultEnabled, false);
  assert.equal(manifest.gentoo.supported, true);
  assert.deepEqual(manifest.gentoo.dependencies, { RDEPEND: ["sys-apps/util-linux"] });
  const plan = gentooFeaturePlan(f.options);
  assert.deepEqual(plan.enabled, ["ui-tweaks"]);
  assert.deepEqual(plan.dependencies, {
    bootstrap: [], BDEPEND: [], DEPEND: [], RDEPEND: ["sys-apps/util-linux"], IDEPEND: [],
  });
  f.writeConfig([]);
  assert.deepEqual(gentooFeaturePlan(f.options).dependencies, {
    bootstrap: [], BDEPEND: [], DEPEND: [], RDEPEND: [], IDEPEND: [],
  });
});

test("Gentoo ui-tweaks runtime atom passes the host Portage parser", { skip: !hasPortageParser }, (t) => {
  const f = fixture(t), plan = gentooFeaturePlan(f.options);
  const validator = path.join(root, "scripts/lib/validate-gentoo-dependencies.py");
  const result = cp.spawnSync("python3", [validator], { input: JSON.stringify(plan), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("Gentoo ui-tweaks support keeps updater and unaudited features rejected", (t) => {
  const f = fixture(t);
  const run = (updater) => cp.spawnSync("bash", ["scripts/build-gentoo.sh", "--preflight"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, CODEX_LINUX_FEATURES_CONFIG: f.options.featuresConfigPath, PACKAGE_WITH_UPDATER: updater },
  });
  const enabled = run("0");
  assert.equal(enabled.status, 0, enabled.stderr);
  const updater = run("1");
  assert.notEqual(updater.status, 0);
  assert.match(updater.stderr, /Portage owns native updates/);
  f.writeConfig(["ui-tweaks", "pet-overlay"]);
  const unsupported = run("0");
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /does not support.*pet-overlay/);
});

test("Gentoo ui-tweaks stages the owned cleanup hook and preserves its permissions", (t) => {
  const f = fixture(t), app = path.join(f.dir, "app"), state = path.join(app, ".codex-linux");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, "build-info.json"), JSON.stringify({ linuxFeatures: { enabled: ["ui-tweaks"] } }));
  fs.writeFileSync(path.join(state, "patch-report.json"), JSON.stringify({ enabledFeatures: ["ui-tweaks"], patches: [] }));
  stageEnabledLinuxFeatureInstall(app, f.options);
  const hook = path.join(state, "prelaunch.d/ui-tweaks-dock-icon-cleanup.sh");
  assert.equal(fs.readFileSync(hook, "utf8"), fs.readFileSync(path.join(__dirname, "sync-desktop-icon.sh"), "utf8"));
  assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
  assert.deepEqual(validateGentooFeatureSnapshot(app, f.options).enabled, ["ui-tweaks"]);
  fs.chmodSync(hook, 0o644);
  assert.throws(() => validateGentooFeatureSnapshot(app, f.options), /mode mismatch/);
  restoreGentooFeaturePayloadPermissions(app, f.options);
  assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
  f.writeConfig([]);
  assert.throws(() => validateGentooFeatureSnapshot(app, f.options), /snapshot.*match/);
});

test("Gentoo ebuild puts the ui-tweaks dependency in RDEPEND only", (t) => {
  const f = fixture(t), template = fs.readFileSync(path.join(root, "packaging/gentoo/codex-desktop.ebuild.template"), "utf8");
  const enabled = renderGentooEbuild(template, gentooFeaturePlan(f.options), "amd64", "fixture.tar.xz");
  const dependencyBlock = (source, phase) => source.match(new RegExp(`^${phase}="([\\s\\S]*?)"`, "m"))?.[1] ?? "";
  assert(dependencyBlock(enabled, "RDEPEND").includes("sys-apps/util-linux"));
  for (const phase of ["BDEPEND", "DEPEND", "IDEPEND"]) {
    assert(!dependencyBlock(enabled, phase).includes("sys-apps/util-linux"));
  }
  f.writeConfig([]);
  assert(!renderGentooEbuild(template, gentooFeaturePlan(f.options), "amd64", "fixture.tar.xz").includes("sys-apps/util-linux"));
});
