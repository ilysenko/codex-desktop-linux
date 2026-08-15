"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "../..");

function runPackageCommon(script, appDir) {
  return childProcess.execFileSync("bash", ["-c", [
    "set -euo pipefail",
    `REPO_DIR=${JSON.stringify(repoRoot)}`,
    `APP_DIR=${JSON.stringify(appDir)}`,
    `. ${JSON.stringify(path.join(repoRoot, "scripts/lib/package-common.sh"))}`,
    script,
  ].join("\n")], { encoding: "utf8" });
}

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

  for (const soname of ["libatspi.so.0", "libnotify.so.4", "libssl.so.3", "libusb-1.0.so.0", "libX11-xcb.so.1"]) {
    assert.match(rpm, new RegExp(soname.replaceAll(".", "\\.")));
  }
  for (const packageName of ["libnotify", "libusb", "openssl", "systemd-libs", "xz"]) {
    assert.match(pacman, new RegExp(`'${packageName}'`));
  }
  assert.match(rpm, /Requires:.*\bxz\b/);
  for (const packageName of ["graphite2", "libglvnd", "openssl", "xz"]) {
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
    "codex-global-dictation-linux",
    "codex-mcp-helper-reaper",
    "codex-read-aloud-linux",
    "codex-record-replay-linux",
  ]) {
    assert.match(common, new RegExp(artifact));
  }
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
  fs.mkdirSync(path.join(builder, "scripts/lib"), { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "scripts/lib/linux-features.js"),
    path.join(builder, "scripts/lib/linux-features.js"),
  );
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
