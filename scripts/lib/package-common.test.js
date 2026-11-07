"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function runPackageCommon(script, appDir, sourceRoot = repoRoot) {
  return childProcess.execFileSync("bash", ["-c", [
    "set -euo pipefail",
    `REPO_DIR=${JSON.stringify(sourceRoot)}`,
    `APP_DIR=${JSON.stringify(appDir)}`,
    `. ${JSON.stringify(path.join(repoRoot, "scripts/lib/package-common.sh"))}`,
    script,
  ].join("\n")], { encoding: "utf8" });
}

function copyFeatureHelpers(sourceRoot, targetRoot) {
  fs.mkdirSync(path.join(targetRoot, "scripts/lib"), { recursive: true });
  for (const name of ["linux-features.js", "gentoo-dependencies.js"]) {
    fs.copyFileSync(path.join(sourceRoot, "scripts/lib", name), path.join(targetRoot, "scripts/lib", name));
  }
}

for (const [fileMode, directoryMode] of [[0o644, 0o755], [0o600, 0o700], [0o755, 0o755]]) {
  test(`package permission restoration traverses directory resources with mode ${fileMode.toString(8)}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-package-directory-mode-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const app = path.join(root, "opt/codex-desktop");
    const featuresRoot = path.join(root, "linux-features");
    const featureDir = path.join(featuresRoot, "fixture");
    const target = ".codex-linux/features/fixture/extension";
    fs.mkdirSync(path.join(featureDir, "extension/nested"), { recursive: true });
    fs.writeFileSync(path.join(featureDir, "extension/extension.js"), "companion source\n");
    fs.writeFileSync(path.join(featureDir, "extension/nested/metadata.json"), "{}\n");
    fs.writeFileSync(path.join(featureDir, "README.md"), "Fixture\n");
    fs.writeFileSync(path.join(featureDir, "feature.json"), JSON.stringify({
      id: "fixture", title: "Fixture", description: "Directory mode regression", defaultEnabled: false,
      resources: [{ source: "extension", target, mode: fileMode.toString(8) }],
    }));
    const featuresConfigPath = path.join(featuresRoot, "features.json");
    fs.writeFileSync(featuresConfigPath, JSON.stringify({ enabled: ["fixture"] }));
    require("./linux-features.js").stageEnabledLinuxFeatureInstall(app, { featuresRoot, featuresConfigPath });
    runPackageCommon([
      "PACKAGE_NAME=codex-desktop",
      `normalize_package_payload_permissions ${JSON.stringify(root)}`,
      `restore_linux_feature_payload_permissions ${JSON.stringify(root)}`,
    ].join("\n"), app);
    for (const relative of ["", "nested"]) {
      assert.equal(fs.statSync(path.join(app, target, relative)).mode & 0o777, directoryMode);
    }
    for (const [relative, content] of [["extension.js", "companion source\n"], ["nested/metadata.json", "{}\n"]]) {
      const file = path.join(app, target, relative);
      assert.equal(fs.statSync(file).mode & 0o777, fileMode);
      assert.equal(fs.readFileSync(file, "utf8"), content);
    }
    const archive = path.join(root, "payload.tar");
    childProcess.execFileSync("tar", ["-cf", archive, "-C", root, "opt"]);
    const entries = childProcess.execFileSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.match(entries, /extension\/extension\.js/);
    assert.match(entries, /extension\/nested\/metadata\.json/);
  });
}

test("updater binary source recovers the Linux deleted-path marker", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-updater-deleted-path-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "minimal-update-builder");
  const updater = path.join(root, "codex-update-manager");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(updater, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const output = runPackageCommon([
    `UPDATER_BINARY_SOURCE=${JSON.stringify(`${updater} (deleted)`)}`,
    "ensure_updater_binary",
    'printf "%s\\n" "$UPDATER_BINARY_SOURCE"',
  ].join("\n"), root, sourceRoot);

  assert.equal(output, `${updater}\n`);
});

test("package metadata is read from the staged official Linux control file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-package-common-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadataDir = path.join(root, ".codex-linux/upstream-package");
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, "control"), [
    "Package: chatgpt",
    "Architecture: arm64",
    "Depends: first (>= 1),",
    " second | third",
    "",
  ].join("\n"));

  assert.equal(runPackageCommon("upstream_linux_control_field Depends", root), "first (>= 1), second | third");
  assert.equal(runPackageCommon("official_payload_deb_architecture", root), "arm64\n");
});

test("package metadata rejects architectures without an official package", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-package-common-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const metadataDir = path.join(root, ".codex-linux/upstream-package");
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(path.join(metadataDir, "control"), "Architecture: armhf\n");

  const result = childProcess.spawnSync("bash", ["-c", [
    "set -euo pipefail",
    `REPO_DIR=${JSON.stringify(repoRoot)}`,
    `APP_DIR=${JSON.stringify(root)}`,
    `. ${JSON.stringify(path.join(repoRoot, "scripts/lib/package-common.sh"))}`,
    "official_payload_deb_architecture",
  ].join("\n")], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected amd64 or arm64/);
});

test("Debian package control inherits dependency fields from upstream", () => {
  const template = fs.readFileSync(path.join(repoRoot, "packaging/linux/control"), "utf8");
  const builder = fs.readFileSync(path.join(repoRoot, "scripts/build-deb.sh"), "utf8");
  assert.match(template, /^Depends: __UPSTREAM_DEPENDENCIES__/m);
  assert.match(template, /^Recommends: __UPSTREAM_RECOMMENDS__$/m);
  assert.match(template, /^Suggests: __UPSTREAM_SUGGESTS__$/m);
  for (const field of ["Depends", "Recommends", "Suggests"]) {
    assert.match(builder, new RegExp(`upstream_linux_control_field ${field}`));
  }
});

test("non-Debian package formats map the official runtime libraries", () => {
  const rpm = fs.readFileSync(path.join(repoRoot, "packaging/linux/codex-desktop.spec"), "utf8");
  const pacman = fs.readFileSync(path.join(repoRoot, "packaging/linux/PKGBUILD.template"), "utf8");
  const flake = fs.readFileSync(path.join(repoRoot, "flake.nix"), "utf8");

  for (const soname of [
    "libatspi.so.0",
    "libnotify.so.4",
    "libssl.so.3",
    "libtss2-esys.so.0",
    "libtss2-mu.so.0",
    "libtss2-tcti-device.so.0",
    "libusb-1.0.so.0",
    "libX11-xcb.so.1",
  ]) {
    assert.match(rpm, new RegExp(soname.replaceAll(".", "\\.")));
  }
  for (const packageName of ["libnotify", "libusb", "openssl", "systemd-libs", "tpm2-tss", "xz"]) {
    assert.match(pacman, new RegExp(`'${packageName}'`));
  }
  assert.match(rpm, /Requires:.*\bxz\b/);
  for (const packageName of ["graphite2", "libglvnd", "openssl", "tpm2-tss", "xz"]) {
    assert.match(flake, new RegExp(`\\b${packageName}\\b`));
  }
});

test("RPM updater selects the distro-specific GnuPG package", () => {
  const rpm = fs.readFileSync(path.join(repoRoot, "packaging/linux/codex-desktop.spec"), "utf8");
  assert.match(
    rpm,
    /%if __PACKAGE_WITH_UPDATER__\nRequires:\s+polkit, curl, dpkg, nodejs, xdg-utils\n%if 0%\{\?suse_version\}\nRequires:\s+gpg2\n%else\nRequires:\s+gnupg2\n%endif\n%else\nRequires:\s+xdg-utils\n%endif/,
  );
});

test("update-builder copies staged native feature artifacts without Cargo workspaces", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source", "helper");
  const target = path.join(root, "builder", "target", "release", "helper");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  runPackageCommon(
    `stage_update_builder_native_artifact ${JSON.stringify(source)} ${JSON.stringify(target)} test-helper`,
    root,
  );

  assert.equal(fs.readFileSync(target, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(fs.statSync(target).mode & 0o777, 0o755);

  const common = fs.readFileSync(path.join(repoRoot, "scripts/lib/package-common.sh"), "utf8");
  assert.doesNotMatch(common, /cp -a "\$REPO_DIR\/\$consumer"/);
  for (const artifact of [
    "codex-computer-use-linux",
    "codex-computer-use-cosmic",
    "codex-computer-use-indicator",
    "codex-global-dictation-linux",
    "codex-mcp-helper-reaper",
    "codex-pet-kwin",
    "codex-read-aloud-linux",
    "codex-record-replay-linux",
  ]) {
    assert.match(common, new RegExp(artifact));
  }
});

test("Mini packaging retains its helper independently of global shortcuts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-pet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json"), app = path.join(root, "app"), builder = path.join(root, "builder");
  const helper = path.join(app, "resources/native/codex-pet-kwin");
  fs.writeFileSync(config, JSON.stringify({ enabled: ["pet-overlay"] }));
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  runPackageCommon(`export CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)}; stage_update_builder_linux_features_tree ${JSON.stringify(builder)}; stage_enabled_native_feature_artifacts ${JSON.stringify(builder)}`, app);
  const retained = path.join(builder, "linux-features/pet-overlay/kwin-helper/target/release/codex-pet-kwin");
  assert.equal(fs.readFileSync(retained, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(fs.statSync(retained).mode & 0o777, 0o755);
  const feature = path.join(builder, "linux-features/pet-overlay");
  for (const relative of ["kwin-helper/src", "kwin-helper/tests", "kwin-helper/Cargo.toml", "kwin-helper/Cargo.lock"])
    assert.equal(fs.existsSync(path.join(feature, relative)), false, relative);
  for (const relative of ["patch.js", "native-kwin.cjs", "kwin-bridge.cjs", "kwin-script.cjs", "stage.sh"])
    assert.equal(fs.existsSync(path.join(feature, relative)), true, relative);
});

test("Chronicle-only packaging retains the shared backend for updater rebuilds", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-chronicle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  const backend = path.join(root, "app/resources/native/codex-record-replay-linux");
  const builder = path.join(root, "builder");
  fs.writeFileSync(config, `${JSON.stringify({ enabled: ["chronicle-skysight"] })}\n`);
  fs.mkdirSync(path.dirname(backend), { recursive: true });
  fs.writeFileSync(backend, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  runPackageCommon(
    `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_enabled_native_feature_artifacts ${JSON.stringify(builder)}`,
    path.join(root, "app"),
  );

  const retainedBackend = path.join(builder, "target/release/codex-record-replay-linux");
  assert.equal(fs.readFileSync(retainedBackend, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(fs.statSync(retainedBackend).mode & 0o777, 0o755);
});

for (const enabled of [[], ["global-dictation"], ["wayland-global-shortcuts"], ["global-dictation", "wayland-global-shortcuts"]]) {
  test(`shortcut helper packaging and build selection: ${enabled.join(",") || "disabled"}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-shortcuts-package-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const config = path.join(root, "features.json"), builder = path.join(root, "builder");
    const app = path.join(root, "app"), helper = path.join(app, "resources/native/codex-global-dictation-linux");
    const binDir = path.join(root, "bin"), cargoLog = path.join(root, "cargo.log");
    fs.writeFileSync(config, JSON.stringify({enabled}));
    fs.mkdirSync(path.dirname(helper), {recursive: true});
    fs.writeFileSync(helper, "#!/bin/sh\nexit 0\n", {mode: 0o755});
    runPackageCommon(
      `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_enabled_native_feature_artifacts ${JSON.stringify(builder)}\n` +
      `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_update_builder_linux_features_tree ${JSON.stringify(builder)}`,
      app,
    );
    const retained = path.join(builder, "global-dictation-linux/target/release/codex-global-dictation-linux");
    assert.equal(fs.existsSync(retained), enabled.length > 0);
    if (enabled.length) assert.equal(fs.statSync(retained).mode & 0o777, 0o755);
    fs.cpSync(path.join(repoRoot, "scripts/patches"), path.join(builder, "scripts/patches"), {recursive: true});
    for (const id of ["global-dictation", "wayland-global-shortcuts"]) {
      const feature = path.join(builder, "linux-features", id);
      assert.equal(fs.existsSync(feature), enabled.includes(id));
      if (enabled.includes(id)) assert.equal(require(path.join(feature, "patch.js")).descriptors.length, 1);
    }
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "cargo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CARGO_LOG"\n', {mode: 0o755});
    const result = childProcess.spawnSync("make", ["build-native-feature-helpers"], {
      cwd: repoRoot, encoding: "utf8", env: {...process.env, CODEX_LINUX_FEATURES_CONFIG: config,
        CARGO_LOG: cargoLog, PATH: `${binDir}:${process.env.PATH}`},
    });
    assert.equal(result.status, 0, result.stderr);
    const builds = fs.existsSync(cargoLog) ? fs.readFileSync(cargoLog, "utf8").trim().split("\n") : [];
    assert.equal(builds.length, enabled.length ? 1 : 0);
    if (builds.length) assert.match(builds[0], /--manifest-path global-dictation-linux\/Cargo.toml/);
    const common = fs.readFileSync(path.join(repoRoot, "scripts/lib/package-common.sh"), "utf8");
    assert.match(common, /\n\s+stage-global-shortcuts\.sh \\/);
  });
}

test("Chronicle-only native helper setup builds the shared backend", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-native-helper-chronicle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  const binDir = path.join(root, "bin");
  const cargoLog = path.join(root, "cargo.log");
  fs.writeFileSync(config, `${JSON.stringify({ enabled: ["chronicle-skysight"] })}\n`);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "cargo"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CARGO_LOG\"\n",
    { mode: 0o755 },
  );

  const result = childProcess.spawnSync("make", ["build-native-feature-helpers"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_LOG: cargoLog,
      CODEX_LINUX_FEATURES_CONFIG: config,
      PATH: `${binDir}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(cargoLog), true);
  assert.match(fs.readFileSync(cargoLog, "utf8"), /build .*--release -p codex-record-replay-linux/);
});

test("update-builder carries the shared feature compatibility registry", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-features-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const builder = path.join(root, "builder");

  runPackageCommon(
    `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(path.join(repoRoot, "linux-features/features.example.json"))} stage_update_builder_linux_features_tree ${JSON.stringify(builder)}`,
    root,
  );

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(builder, "linux-features/compatibility.json"), "utf8")),
    JSON.parse(fs.readFileSync(path.join(repoRoot, "linux-features/compatibility.json"), "utf8")),
  );
  copyFeatureHelpers(repoRoot, builder);
  assert.equal(
    childProcess.execFileSync(
      process.execPath,
      [path.join(builder, "scripts/lib/linux-features.js"), "--enabled"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_LINUX_FEATURES_CONFIG: path.join(builder, "linux-features/features.example.json"),
        },
      },
    ),
    "",
  );
});

test("update-builder preserves enabled local features for future rebuilds", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-local-feature-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const featuresRoot = path.join(sourceRoot, "linux-features");
  const builder = path.join(root, "builder");
  copyFeatureHelpers(repoRoot, sourceRoot);
  fs.mkdirSync(path.join(featuresRoot, "local/selected-feature"), { recursive: true });
  fs.mkdirSync(path.join(featuresRoot, "local/disabled-feature"), { recursive: true });
  fs.mkdirSync(path.join(featuresRoot, "selected-feature"));
  for (const name of ["features.example.json", "compatibility.json"]) {
    fs.copyFileSync(path.join(repoRoot, "linux-features", name), path.join(featuresRoot, name));
  }
  for (const id of ["selected-feature", "disabled-feature"]) {
    const featureDir = path.join(featuresRoot, "local", id);
    fs.writeFileSync(path.join(featureDir, "feature.json"), `${JSON.stringify({ id, defaultEnabled: false })}\n`);
    fs.writeFileSync(path.join(featureDir, "README.md"), `${id}\n`);
  }
  fs.writeFileSync(path.join(featuresRoot, "local/selected-feature/patch.js"), "module.exports = [];\n");
  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["selected-feature"]}\n');

  runPackageCommon(
    `stage_update_builder_linux_features_tree ${JSON.stringify(builder)}\n` +
      `stage_update_builder_linux_features_config ${JSON.stringify(builder)}`,
    root,
    sourceRoot,
  );

  assert.equal(fs.existsSync(path.join(builder, "linux-features/local/selected-feature/feature.json")), true);
  assert.equal(fs.existsSync(path.join(builder, "linux-features/local/selected-feature/patch.js")), true);
  assert.equal(fs.existsSync(path.join(builder, "linux-features/selected-feature")), false);
  assert.equal(fs.existsSync(path.join(builder, "linux-features/local/disabled-feature")), false);
  fs.mkdirSync(path.join(builder, "scripts/lib"), { recursive: true });
  copyFeatureHelpers(sourceRoot, builder);
  assert.equal(
    childProcess.execFileSync(
      process.execPath,
      [path.join(builder, "scripts/lib/linux-features.js"), "--enabled"],
      { encoding: "utf8" },
    ),
    "selected-feature\n",
  );

  fs.writeFileSync(path.join(featuresRoot, "features.json"), '{"enabled":["missing-feature"]}\n');
  assert.throws(
    () => runPackageCommon(
      `stage_update_builder_linux_features_tree ${JSON.stringify(path.join(root, "invalid-builder"))}`,
      root,
      sourceRoot,
    ),
    /Failed to discover enabled Linux features for the update-builder/,
  );
});

test("update-builder stages the attached CLI resource", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-attached-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  const builder = path.join(root, "builder");
  fs.writeFileSync(config, `${JSON.stringify({ enabled: ["shared-app-server-socket"] })}\n`);

  runPackageCommon(
    `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_update_builder_linux_features_tree ${JSON.stringify(builder)}\n` +
      `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_update_builder_linux_features_config ${JSON.stringify(builder)}`,
    root,
  );

  const staged = path.join(
    builder,
    "linux-features/shared-app-server-socket/attached-cli.sh",
  );
  assert.equal(fs.lstatSync(staged).isFile(), true);
  assert.equal(fs.statSync(staged).mode & 0o777, 0o755);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(builder, "linux-features/features.json"), "utf8")),
    { enabled: ["shared-app-server-socket"] },
  );
});

test("update-builder omits directory-watch acceptance-only evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-watchbound-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  const builder = path.join(root, "builder");
  fs.writeFileSync(
    config,
    `${JSON.stringify({ enabled: ["directory-only-working-tree-watch"] })}\n`,
  );

  runPackageCommon(
    `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_update_builder_linux_features_tree ${JSON.stringify(builder)}`,
    root,
  );

  const stagedFeature = path.join(
    builder,
    "linux-features/directory-only-working-tree-watch",
  );
  for (const runtimeInput of [
    "feature.json",
    "patch.js",
    "watchbound-artifacts.json",
    "watchbound-package.js",
  ]) {
    assert.equal(fs.existsSync(path.join(stagedFeature, runtimeInput)), true);
  }
  assert.equal(fs.existsSync(path.join(stagedFeature, "acceptance")), false);
});

test("update-builder stages only plugin templates consumed by enabled feature hooks", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-plugins-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "features.json");
  fs.writeFileSync(config, `${JSON.stringify({ enabled: ["computer-use-linux", "read-aloud-mcp"] })}\n`);
  const builder = path.join(root, "builder");

  runPackageCommon(
    `CODEX_LINUX_FEATURES_CONFIG=${JSON.stringify(config)} stage_update_builder_enabled_plugin_templates ${JSON.stringify(builder)}`,
    root,
  );

  for (const pluginId of ["computer-use", "read-aloud"]) {
    assert.equal(
      fs.existsSync(path.join(builder, "plugins/openai-bundled/plugins", pluginId, ".codex-plugin/plugin.json")),
      true,
    );
  }
  assert.deepEqual(
    fs.readdirSync(path.join(builder, "plugins/openai-bundled/plugins")).sort(),
    ["computer-use", "read-aloud"],
  );
});

test("update-builder omits test-only files without changing private features or sources", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-update-builder-test-files-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  for (const relative of ["install.sh", "scripts", "launcher", "packaging/linux", "assets"]) {
    fs.cpSync(path.join(repoRoot, relative), path.join(source, relative), { recursive: true });
  }
  const features = path.join(source, "linux-features");
  fs.mkdirSync(features);
  for (const name of ["features.example.json", "compatibility.json"]) {
    fs.copyFileSync(path.join(repoRoot, "linux-features", name), path.join(features, name));
  }
  fs.writeFileSync(path.join(features, "features.json"), JSON.stringify({ enabled: ["public-fixture", "private-fixture"] }));
  const trees = ["linux-features/public-fixture", "linux-features/local/private-fixture", "scripts/patches/filter-fixture"];
  const omitted = ["test.js", "nested/example.test.js", "nested/example.test-helpers.js", "fixtures/input.json", "nested/fixtures/input.json"];
  const retained = ["patch.js", "nested/runtime.js", "fixtures.json", "nested/tests/runtime.js"];
  const original = new Map();
  for (const relative of trees) {
    const dir = path.join(source, relative);
    for (const name of [...omitted, ...retained]) {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${relative}/${name}\n`, { mode: 0o640 });
      original.set(file, { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 });
    }
  }
  for (const [relative, id] of [[trees[0], "public-fixture"], [trees[1], "private-fixture"]]) {
    fs.writeFileSync(path.join(source, relative, "feature.json"), JSON.stringify({ id, defaultEnabled: false }));
    fs.writeFileSync(path.join(source, relative, "README.md"), `${id}\n`);
  }
  const external = path.join(root, "external");
  fs.mkdirSync(path.join(external, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(external, "fixtures/test.js"), "external test data\n");
  for (const relative of trees) {
    fs.symlinkSync(external, path.join(source, relative, "linked-directory"));
    fs.symlinkSync(path.join(external, "fixtures/test.js"), path.join(source, relative, "linked.test.js"));
  }

  const packageRoot = path.join(root, "package");
  runPackageCommon([
    "unset CODEX_LINUX_FEATURES_ROOT CODEX_LINUX_FEATURES_CONFIG",
    "PACKAGE_NAME=codex-desktop",
    `stage_update_builder_bundle ${JSON.stringify(packageRoot)}`,
  ].join("\n"), root, source);
  const builder = path.join(packageRoot, "opt/codex-desktop/update-builder");
  for (const relative of trees) {
    const privateFeature = relative.startsWith("linux-features/local/");
    for (const name of omitted) {
      assert.equal(fs.existsSync(path.join(builder, relative, name)), privateFeature, `${relative}/${name}`);
    }
    for (const name of privateFeature ? [...omitted, ...retained] : retained) {
      const expected = original.get(path.join(source, relative, name));
      const staged = path.join(builder, relative, name);
      assert.deepEqual(fs.readFileSync(staged), expected.bytes, staged);
      assert.equal(fs.statSync(staged).mode & 0o777, expected.mode, staged);
    }
    assert.equal(fs.readlinkSync(path.join(builder, relative, "linked-directory")), external);
    assert.equal(fs.existsSync(path.join(builder, relative, "linked.test.js")), privateFeature);
  }
  for (const [file, expected] of original) {
    assert.deepEqual(fs.readFileSync(file), expected.bytes, file);
    assert.equal(fs.statSync(file).mode & 0o777, expected.mode, file);
  }
  assert.equal(fs.readFileSync(path.join(external, "fixtures/test.js"), "utf8"), "external test data\n");
  const inventory = fs.readFileSync(path.join(builder, ".codex-linux/update-builder-manifest.txt"), "utf8").split("\n");
  assert.equal(inventory.includes("linux-features/public-fixture/test.js"), false);
  assert.equal(inventory.includes("linux-features/local/private-fixture/test.js"), true);
  assert.equal(inventory.includes("scripts/patches/filter-fixture/nested/example.test.js"), false);
});

const readAloudPluginPath = "resources/plugins/openai-bundled/plugins/read-aloud";
const readAloudRunnerPaths = ["bin/kokoro-stdin", "bin/kokoro_stdin.py", "install-kokoro-runtime.sh"];
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

function createReadAloudBuilderFixture(t, enabled, installer = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "read-aloud-builder-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  for (const relative of [
    "install.sh", "launcher", "scripts/lib", "scripts/patches", "scripts/patch-linux-window-ui.js",
    "scripts/build-deb.sh", "scripts/build-rpm.sh", "scripts/build-pacman.sh", "packaging/linux", "assets",
    "linux-features/read-aloud", "linux-features/read-aloud-mcp",
    "linux-features/features.example.json", "linux-features/compatibility.json",
    "plugins/openai-bundled/plugins/read-aloud",
  ]) {
    fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    fs.cpSync(path.join(repoRoot, relative), path.join(source, relative), { recursive: true });
  }
  if (!installer) fs.unlinkSync(path.join(source, "linux-features/read-aloud/install-kokoro-runtime.sh"));
  fs.writeFileSync(path.join(source, "linux-features/features.json"), JSON.stringify({ enabled }));
  const marker = path.join(root, "executed");
  const inert = `#!/bin/sh\ntouch ${shellQuote(marker)}\nexit 99\n`;
  const backend = path.join(source, "target/release/codex-read-aloud-linux");
  fs.mkdirSync(path.dirname(backend), { recursive: true });
  fs.writeFileSync(backend, inert, { mode: 0o755 });
  const tools = path.join(root, "tools");
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, "cargo"), inert, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${tools}:${process.env.PATH}`,
    CODEX_LINUX_FEATURES_ROOT: "",
    CODEX_LINUX_FEATURES_CONFIG: "",
    CODEX_LINUX_READ_ALOUD_MCP_SOURCE: "",
  };
  const files = new Map(readAloudRunnerPaths.filter((relative) => installer || relative.startsWith("bin/")).map((relative) => {
    const file = path.join(source, "linux-features/read-aloud", relative);
    return [path.basename(relative), { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 }];
  }));
  files.set("codex-read-aloud-linux", { bytes: Buffer.from(inert), mode: 0o755 });
  return { root, source, env, marker, files };
}

function assertReadAloudFile(file, expected) {
  assert.deepEqual(fs.readFileSync(file), expected.bytes, file);
  const mode = fs.statSync(file).mode & 0o777;
  // Packaging retains owner access and read/execute bits, while removing
  // group/other write access from executable hooks and runners.
  assert.equal(mode & 0o022, 0, `${file}: group/other write access`);
  assert.equal(mode, expected.mode & ~0o022, `${file}: packaged permissions`);
}

function stageReadAloudApp(source, app, env) {
  const helper = path.join(source, "scripts/lib/linux-features.js");
  const hooks = childProcess.execFileSync(process.execPath, [helper, "--stage-hooks"], { cwd: source, env, encoding: "utf8" });
  for (const line of hooks.trim().split("\n").filter(Boolean)) {
    const [, hook] = line.split("\t");
    childProcess.execFileSync("bash", [hook], {
      cwd: source, env: { ...env, SCRIPT_DIR: source, INSTALL_DIR: app, ICON_SOURCE: "" }, stdio: "pipe",
    });
  }
}

function stageReadAloudBuilder(source, app, packageRoot, env) {
  childProcess.execFileSync("bash", ["-euc", [
    `REPO_DIR=${shellQuote(source)}`,
    `APP_DIR=${shellQuote(app)}`,
    "PACKAGE_NAME=codex-desktop",
    `. ${shellQuote(path.join(source, "scripts/lib/package-common.sh"))}`,
    `stage_update_builder_bundle ${shellQuote(packageRoot)}`,
  ].join("\n")], { cwd: source, env, stdio: "pipe" });
  return path.join(packageRoot, "opt/codex-desktop/update-builder");
}

for (const [label, enabled, alternate, rebuilds = 1] of [
  ["MCP-only", ["read-aloud-mcp"], null, 2],
  ["both features", ["read-aloud", "read-aloud-mcp"]],
  ["UI-only", ["read-aloud"]],
  ["disabled", []],
  ["MCP-only alternate feature root without sibling resources", ["read-aloud-mcp"], "missing"],
  ["MCP-only alternate feature root with different sibling resources", ["read-aloud-mcp"], "different"],
  ["both features with independently customized UI runners", ["read-aloud", "read-aloud-mcp"], "different", 2],
]) {
  test(`${label}: ${rebuilds} packaged rebuild(s) without original source or Cargo`, (t) => {
    const f = createReadAloudBuilderFixture(t, enabled);
    const alternateRoot = path.join(f.root, "alternate-features");
    if (alternate) {
      fs.mkdirSync(alternateRoot);
      for (const relative of [...enabled, "features.json", "features.example.json", "compatibility.json"]) {
        fs.cpSync(path.join(f.source, "linux-features", relative), path.join(alternateRoot, relative), { recursive: true });
      }
      if (alternate === "different") {
        for (const relative of readAloudRunnerPaths) {
          const file = path.join(alternateRoot, "read-aloud", relative);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, "alternate tree does not own MCP runners\n", { mode: 0o600 });
        }
      }
      f.env.CODEX_LINUX_FEATURES_ROOT = alternateRoot;
    }
    const mcp = enabled.includes("read-aloud-mcp");
    const ui = enabled.includes("read-aloud");
    let app = path.join(f.root, "app-0");
    stageReadAloudApp(f.source, app, f.env);
    let builder = stageReadAloudBuilder(f.source, app, path.join(f.root, "package-0"), f.env);
    fs.rmSync(f.source, { recursive: true });
    fs.rmSync(alternateRoot, { recursive: true, force: true });
    f.env.CODEX_LINUX_FEATURES_ROOT = "";

    for (let generation = 1; generation <= rebuilds; generation++) {
      const featuresRoot = path.join(builder, "linux-features");
      const helper = require(path.join(builder, "scripts/lib/linux-features.js"));
      const options = { featuresRoot };
      assert.deepEqual(helper.enabledLinuxFeaturesConfig(options).enabled.sort(), [...enabled].sort());
      assert.equal(fs.existsSync(path.join(featuresRoot, "read-aloud")), ui);

      app = path.join(f.root, `app-${generation}`);
      stageReadAloudApp(builder, app, f.env);
      if (mcp) {
        for (const [name, expected] of f.files) {
          const retained = name === "codex-read-aloud-linux" ? "target/release" : "plugins/openai-bundled/plugins/read-aloud/bin";
          assertReadAloudFile(path.join(builder, retained, name), expected);
          assertReadAloudFile(path.join(app, readAloudPluginPath, "bin", name), expected);
        }
      } else {
        assert.equal(fs.existsSync(path.join(builder, "target")), false);
        assert.equal(fs.existsSync(path.join(builder, "plugins")), false);
      }

      assert.equal(fs.existsSync(path.join(app, "resources/read-aloud")), ui);
      if (ui) {
        for (const name of ["kokoro-stdin", "kokoro_stdin.py"]) {
          const expected = { ...f.files.get(name) };
          if (alternate === "different") expected.bytes = Buffer.from("alternate tree does not own MCP runners\n");
          assertReadAloudFile(path.join(app, "resources/read-aloud", name), expected);
        }
      }
      assert.equal(fs.existsSync(path.join(app, readAloudPluginPath)), mcp);
      if (generation < rebuilds) {
        builder = stageReadAloudBuilder(builder, app, path.join(f.root, `package-${generation}`), f.env);
      }
      assert.equal(fs.existsSync(f.marker), false, "staging must not execute the backend or Cargo");
    }
  });
}

for (const relative of ["bin/kokoro-stdin", "bin/kokoro_stdin.py"]) {
  test(`MCP builder rejects a missing required ${relative} during packaging`, (t) => {
    const f = createReadAloudBuilderFixture(t, ["read-aloud-mcp"]);
    const app = path.join(f.root, "app");
    stageReadAloudApp(f.source, app, f.env);
    const missing = path.join(app, readAloudPluginPath, relative);
    fs.unlinkSync(missing);
    assert.throws(() => stageReadAloudBuilder(f.source, app, path.join(f.root, "package"), f.env),
      (error) => error.status !== 0 && error.stderr.toString().includes(`Missing Read Aloud MCP runner: ${missing}`));
    assert.equal(fs.existsSync(f.marker), false);
  });
}

test("MCP preserves source installer absence and removes a stale template installer", (t) => {
  const f = createReadAloudBuilderFixture(t, ["read-aloud-mcp"], false);
  const installer = "bin/install-kokoro-runtime.sh";
  const app = path.join(f.root, "app-0");
  stageReadAloudApp(f.source, app, f.env);
  assert.equal(fs.existsSync(path.join(app, readAloudPluginPath, installer)), false);
  fs.writeFileSync(path.join(f.source, "plugins/openai-bundled/plugins/read-aloud", installer), "stale installer\n");
  const builder = stageReadAloudBuilder(f.source, app, path.join(f.root, "package-0"), f.env);
  fs.rmSync(f.source, { recursive: true });
  const rebuiltApp = path.join(f.root, "app-1");
  stageReadAloudApp(builder, rebuiltApp, f.env);
  assert.equal(fs.existsSync(path.join(builder, "plugins/openai-bundled/plugins/read-aloud", installer)), false);
  assert.equal(fs.existsSync(path.join(rebuiltApp, readAloudPluginPath, installer)), false);
  assert.equal(fs.existsSync(f.marker), false);
});
