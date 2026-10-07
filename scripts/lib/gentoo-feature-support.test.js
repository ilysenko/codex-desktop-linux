"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { validateGentooAtom, gentooFeatureDependencies, DEPENDENCY_PHASES } = require("./gentoo-dependencies.js");
const { gentooFeaturePlan, validateGentooFeatureSnapshot, restoreGentooFeaturePayloadPermissions, renderGentooEbuild } = require("./gentoo-feature-support.js");
const { stageEnabledLinuxFeatureInstall, stageEnabledLinuxFeaturePackageResources } = require("./linux-features.js");

const validAtoms = [
  "sys-apps/util-linux", ">=net-libs/nodejs-22.12.0[npm]", "dev-libs/glib:2",
  "dev-libs/openssl:0/3", "dev-libs/libusb:1=", "dev-libs/libusb:=", "dev-libs/libusb:*",
  "media-libs/mesa[opengl(+),gbm(+),-test(-)]", "~dev-lang/rust-1.90.0",
  "=dev-lang/rust-1.90*", "<dev-lang/rust-1.91.0_rc1-r2", "=dev-lang/python-3.14.0b_p1",
];
test("Gentoo atoms accept bounded version, slot/subslot and fixed USE requirements", () => {
  for (const atom of validAtoms) assert.equal(validateGentooAtom(atom), atom);
  assert.throws(() => validateGentooAtom("dev-libs/libusb:1=", "bootstrap", "bootstrap"), /Invalid/);
});

test("Gentoo atoms refuse shell expansion, expressions, conditional USE and malformed constraints", () => {
  for (const atom of [
    null, 42, "", " sys-apps/util-linux", "sys-apps/util-linux ", "sys-apps/util-linux\n",
    "$(id)", "sys-apps/util-linux;id", "sys-apps/util-linux\"", "${RDEPEND}", "`id`",
    "|| ( dev-lang/rust dev-lang/rust-bin )", "!dev-lang/rust", "dev-lang/rust::gentoo",
    "dev-lang/rust-1.90.0", ">=dev-lang/rust", ">=dev-lang/rust-1.90*", "dev-lang/rust:0/",
    "dev-lang/rust[npm?]", "dev-lang/rust[npm=]", "dev-lang/rust[]", "dev-lang/rust[npm,,test]",
    "dev-lang/rust[npm](test)", "dev-lang/rust:[npm]", "dev-lang/rust:0:1", "dev-lang/rust/extra",
  ]) assert.throws(() => validateGentooAtom(atom), /Invalid/, String(atom));
});

test("Gentoo dependency phases are explicit, deduplicated and keep the runtime shorthand", () => {
  const feature = { id: "fixture", manifest: { gentoo: { dependencies: {
    bootstrap: [">=net-libs/nodejs-22.12.0[npm]"], BDEPEND: ["app-arch/xz-utils"],
    DEPEND: ["dev-libs/libusb:1"], RDEPEND: ["sys-apps/util-linux", "sys-apps/util-linux"],
    IDEPEND: ["sys-apps/usbutils"],
  } } } };
  const deps = gentooFeatureDependencies(feature);
  assert.deepEqual(Object.keys(deps), DEPENDENCY_PHASES);
  assert.deepEqual(deps.RDEPEND, ["sys-apps/util-linux"]);
  feature.manifest.gentoo.dependencies = ["sys-apps/util-linux"];
  assert.deepEqual(gentooFeatureDependencies(feature).RDEPEND, deps.RDEPEND);
  feature.manifest.gentoo.dependencies = { runtime: [] };
  assert.throws(() => gentooFeatureDependencies(feature), /unknown.*phase/);
  feature.manifest.gentoo.dependencies = { RDEPEND: "sys-apps/util-linux" };
  assert.throws(() => gentooFeatureDependencies(feature), /must be an array/);
});

function fixture(t, metadata = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "gentoo-feature-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const featuresRoot = path.join(dir, "linux-features"), featureDir = path.join(featuresRoot, "fixture");
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, "README.md"), "Test feature\n");
  fs.writeFileSync(path.join(featureDir, "feature.json"), JSON.stringify({
    id: "fixture", defaultEnabled: false, gentoo: { supported: true }, ...metadata,
  }));
  const featuresConfigPath = path.join(featuresRoot, "features.json");
  fs.writeFileSync(featuresConfigPath, '{"enabled":["fixture"]}');
  const options = { featuresRoot, featuresConfigPath };
  const app = path.join(dir, "app"); fs.mkdirSync(path.join(app, ".codex-linux"), { recursive: true });
  fs.writeFileSync(path.join(app, ".codex-linux/build-info.json"), '{"linuxFeatures":{"enabled":["fixture"]}}');
  fs.writeFileSync(path.join(app, ".codex-linux/patch-report.json"), '{"enabledFeatures":["fixture"],"patches":[]}');
  const stage = () => stageEnabledLinuxFeatureInstall(app, options);
  return { dir, featuresRoot, featureDir, featuresConfigPath, app, options, stage };
}

test("only enabled and explicitly audited Gentoo features contribute dependencies", t => {
  const f = fixture(t, { gentoo: { supported: true, dependencies: { bootstrap: ["dev-lang/rust"], RDEPEND: ["sys-apps/util-linux"] } },
    packageDependencies: { ebuild: ["sys-apps/util-linux", ">=net-libs/nodejs-22.12.0[npm]"] } });
  const plan = gentooFeaturePlan(f.options);
  assert.deepEqual(plan.enabled, ["fixture"]);
  assert.deepEqual(plan.dependencies.bootstrap, ["dev-lang/rust"]);
  assert.deepEqual(plan.dependencies.RDEPEND, [">=net-libs/nodejs-22.12.0[npm]", "sys-apps/util-linux"]);
  fs.writeFileSync(f.featuresConfigPath, '{"enabled":[]}');
  assert.deepEqual(gentooFeaturePlan(f.options).dependencies, Object.fromEntries(DEPENDENCY_PHASES.map(phase => [phase, []])));
  fs.writeFileSync(f.featuresConfigPath, '{"enabled":["fixture"]}');
  fs.writeFileSync(path.join(f.featureDir, "feature.json"), '{"id":"fixture","defaultEnabled":false}');
  assert.throws(() => gentooFeaturePlan(f.options), /does not support.*fixture/);
});

test("Gentoo snapshot validates app resources/hooks, ownership, modes, config and patch success", t => {
  const f = fixture(t, { resources: [{ source: "resource", target: ".codex-linux/features/fixture/resource", mode: "0640" }],
    runtimeHooks: { prelaunch: "hook.sh" } });
  fs.writeFileSync(path.join(f.featureDir, "resource"), "payload\n");
  fs.writeFileSync(path.join(f.featureDir, "hook.sh"), "#!/bin/sh\nexit 0\n");
  f.stage();
  assert.deepEqual(validateGentooFeatureSnapshot(f.app, f.options).enabled, ["fixture"]);
  const resource = path.join(f.app, ".codex-linux/features/fixture/resource");
  fs.chmodSync(resource, 0o644);
  assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /mode mismatch/);
  fs.chmodSync(resource, 0o640);
  const stagedPath = path.join(f.app, ".codex-linux/linux-features-staged.json");
  const staged = JSON.parse(fs.readFileSync(stagedPath));
  staged.resources[0].id = "disabled";
  fs.writeFileSync(stagedPath, JSON.stringify(staged));
  assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /snapshot.*match/);
  f.stage();
  fs.writeFileSync(path.join(f.app, ".codex-linux/patch-report.json"), JSON.stringify({
    enabledFeatures: ["fixture"], patches: [{ sourceKind: "feature", featureId: "fixture", status: "missing-anchor" }],
  }));
  assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /failed enabled/);
  fs.writeFileSync(f.featuresConfigPath, '{"enabled":[]}');
  assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /snapshot.*match/);
});

test("Gentoo snapshot and package hooks reject symbolic-link escapes", t => {
  const f = fixture(t, { resources: [{ source: "resource", target: "fixture/resource", mode: "0644" }] });
  fs.writeFileSync(path.join(f.featureDir, "resource"), "payload\n"); f.stage();
  fs.renameSync(path.join(f.app, "fixture"), path.join(f.dir, "outside"));
  fs.symlinkSync(path.join(f.dir, "outside"), path.join(f.app, "fixture"));
  assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /links/);
  fs.symlinkSync(path.join(f.dir, "outside"), path.join(f.featureDir, "linked"));
  fs.writeFileSync(path.join(f.featureDir, "feature.json"), JSON.stringify({
    id: "fixture", defaultEnabled: false, gentoo: { supported: true }, packageHooks: [{ source: "linked/resource", formats: ["ebuild"] }],
  }));
  assert.throws(() => gentooFeaturePlan(f.options), /links/);
});

for (const mode of ["0640", "0644", "0750", "0770"]) {
  test(`Gentoo directory resource ${mode} validates and recursively restores directory/file modes`, t => {
    const f = fixture(t, { resources: [{ source: "tree", target: "fixture/tree", mode }] });
    fs.mkdirSync(path.join(f.featureDir, "tree/nested"), { recursive: true });
    fs.writeFileSync(path.join(f.featureDir, "tree/nested/child"), "payload\n");
    f.stage();
    const root = path.join(f.app, "fixture/tree"), nested = path.join(root, "nested"), file = path.join(nested, "child");
    const fileMode = parseInt(mode, 8), directoryMode = fileMode | ((fileMode & 0o444) >> 2);
    assert.doesNotThrow(() => validateGentooFeatureSnapshot(f.app, f.options));
    assert.equal(fs.statSync(root).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(nested).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(file).mode & 0o777, fileMode);
    fs.chmodSync(nested, 0o700);
    assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /mode mismatch/);
    for (const path of [root, nested, file]) fs.chmodSync(path, 0o755);
    restoreGentooFeaturePayloadPermissions(f.app, f.options);
    assert.equal(fs.statSync(root).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(nested).mode & 0o777, directoryMode);
    assert.equal(fs.statSync(file).mode & 0o777, fileMode);
    assert.doesNotThrow(() => validateGentooFeatureSnapshot(f.app, f.options));
    fs.chmodSync(file, 0o600);
    assert.throws(() => validateGentooFeatureSnapshot(f.app, f.options), /mode mismatch/);
  });
}

test("Gentoo package hooks refuse unknown formats instead of silently omitting a typo", t => {
  const f = fixture(t, { packageHooks: [{ source: "package.sh", formats: ["ebuld"] }] });
  fs.writeFileSync(path.join(f.featureDir, "package.sh"), "#!/bin/sh\nexit 0\n");
  assert.throws(() => gentooFeaturePlan(f.options), /Unsupported.*ebuld/);
});

test("Gentoo package resources honor format filters and reject omitted roots before staging", t => {
  const f = fixture(t, { packageResources: [{ source: "rule", target: "usr/lib/udev/rules.d/70-fixture.rules", mode: "0640", formats: ["ebuild"] }] });
  fs.writeFileSync(path.join(f.featureDir, "rule"), "fixture rule\n");
  const packageRoot = path.join(f.dir, "package");
  gentooFeaturePlan(f.options);
  stageEnabledLinuxFeaturePackageResources(packageRoot, { ...f.options, packageFormat: "ebuild" });
  assert.equal(fs.statSync(path.join(packageRoot, "usr/lib/udev/rules.d/70-fixture.rules")).mode & 0o777, 0o640);
  assert.deepEqual(stageEnabledLinuxFeaturePackageResources(path.join(f.dir, "deb"), { ...f.options, packageFormat: "deb" }).resources, []);
  const manifestPath = path.join(f.featureDir, "feature.json"), manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.packageResources[0].target = "var/lib/fixture";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => gentooFeaturePlan(f.options), /below usr.*etc/);
});

test("Gentoo template rendering separates phases without putting bootstrap tools into the package", () => {
  const deps = Object.fromEntries(DEPENDENCY_PHASES.map(phase => [phase, []]));
  deps.bootstrap = ["dev-lang/rust"]; deps.BDEPEND = ["sys-apps/file"];
  deps.DEPEND = ["dev-libs/libusb:1"]; deps.RDEPEND = [">=net-libs/nodejs-22.12.0[npm]"];
  deps.IDEPEND = ["sys-apps/usbutils"];
  const template = fs.readFileSync(path.join(__dirname, "../../packaging/gentoo/codex-desktop.ebuild.template"), "utf8");
  const output = renderGentooEbuild(template, { dependencies: deps }, "amd64", "payload.tar.xz");
  for (const phase of DEPENDENCY_PHASES.slice(1)) {
    const metadata = output.match(new RegExp(`^${phase}="([^\"]*)"`, "m"))[1];
    assert.ok(metadata.includes(deps[phase][0]), phase);
    assert.ok(!metadata.includes("dev-lang/rust"));
  }
  assert.ok(!output.includes("__FEATURE_"));
  assert.throws(() => renderGentooEbuild("bad template", { dependencies: deps }, "amd64", "payload"), /Missing.*token/);
  deps.DEPEND = [];
  assert.ok(!/^DEPEND=/m.test(renderGentooEbuild(template, { dependencies: deps }, "amd64", "payload.tar.xz")));
});

test("host Portage accepts the supported atom subset with EAPI 8", t => {
  const hasPortage = cp.spawnSync("python3", ["-c", "import portage"], { encoding: "utf8" });
  if (hasPortage.status !== 0) return t.skip("Portage is not installed on this test host");
  const validator = path.join(__dirname, "validate-gentoo-dependencies.py");
  const result = cp.spawnSync("python3", [validator], { input: JSON.stringify({ dependencies: { RDEPEND: validAtoms } }), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const invalid = cp.spawnSync("python3", [validator], { input: '{"dependencies":{"RDEPEND":["dev-lang/rust::gentoo"]}}', encoding: "utf8" });
  assert.notEqual(invalid.status, 0);
});
