"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const { detectLinuxTargetContext } = require("./lib/linux-target-context.js");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "gentoo-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Gentoo wins over available dpkg tooling in both detectors", t => {
  const dir = fixture(t);
  const release = path.join(dir, "os-release");
  fs.writeFileSync(release, 'ID=gentoo\n');
  const env = { ...process.env, OS_RELEASE_FILE: release };
  assert.equal(cp.execFileSync("bash", ["scripts/lib/detect-package-format.sh"], { cwd: root, env, encoding: "utf8" }).trim(), "ebuild");
  const target = detectLinuxTargetContext({ env, osReleasePaths: [release] });
  assert.equal(target.packageFormat, "ebuild");
  assert.equal(target.packageManager, "emerge");
});

test("local ebuild rejects updater and optional features before packaging", t => {
  const dir = fixture(t), config = path.join(dir, "features.json");
  fs.writeFileSync(config, '{"enabled":[]}');
  let env = { ...process.env, CODEX_LINUX_FEATURES_CONFIG: config, PACKAGE_WITH_UPDATER: "1" };
  let r = cp.spawnSync("bash", ["scripts/build-gentoo.sh", "--preflight"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Portage owns native updates/);
  fs.writeFileSync(config, '{"enabled":["pet-overlay"]}');
  env.PACKAGE_WITH_UPDATER = "0";
  r = cp.spawnSync("bash", ["scripts/build-gentoo.sh", "--preflight"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty feature configuration/);
});

test("generated ebuild payload and Manifest use the shared native layout", t => {
  const dir = fixture(t), app = path.join(dir, "app"), bin = path.join(dir, "bin"), dist = path.join(dir, "dist");
  fs.mkdirSync(path.join(app, ".codex-linux/upstream-package"), { recursive: true });
  fs.mkdirSync(path.join(app, "resources"), { recursive: true });
  fs.mkdirSync(bin);
  for (const name of ["ChatGPT", "start.sh", "resources/codex"]) fs.writeFileSync(path.join(app, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "resources/app.asar"), "official fixture ASAR");
  fs.writeFileSync(path.join(app, ".codex-linux/upstream-package/control"), "Package: chatgpt\nArchitecture: amd64\n");
  const m = { version: "26.930.31730", architecture: "amd64", sha256: "a".repeat(64), size: 42 };
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(app, ".codex-linux/build-info.json"), JSON.stringify({ upstreamLinuxPackage: { ...m, sizeBytes: m.size } }));
  fs.writeFileSync(path.join(dir, "features.json"), '{"enabled":[]}');
  // Mock only network discovery, leaving the builder, provenance comparison,
  // common staging, archive and Manifest generation real.
  const nodeWrapper = `#!/bin/bash\nif [[ "$1" == */upstream-linux-package.js ]]; then\n shift\n while [ "$#" -gt 0 ]; do if [ "$1" = --metadata ]; then cp "$GENTOO_TEST_METADATA" "$2"; exit 0; fi; shift; done\n exit 1\nfi\nexec "$GENTOO_TEST_NODE" "$@"\n`;
  fs.writeFileSync(path.join(bin, "node"), nodeWrapper, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: dir,
    APP_DIR_OVERRIDE: app, DIST_DIR_OVERRIDE: dist, PACKAGE_WITH_UPDATER: "0",
    CODEX_LINUX_FEATURES_CONFIG: path.join(dir, "features.json"), GENTOO_TEST_METADATA: path.join(dir, "metadata.json"), GENTOO_TEST_NODE: process.execPath };
  const r = cp.spawnSync("bash", ["scripts/build-gentoo.sh"], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const pkg = path.join(dist, "gentoo/repository/app-misc/codex-desktop");
  const archiveName = fs.readdirSync(path.join(dist, "gentoo")).find(n => n.endsWith('.tar.xz'));
  const archive = path.join(dist, "gentoo", archiveName), bytes = fs.readFileSync(archive);
  assert.match(fs.readFileSync(path.join(pkg, "Manifest"), "utf8"), new RegExp(`DIST ${archiveName.replaceAll('.', '\\.')} ${bytes.length} BLAKE2B ${crypto.createHash('blake2b512').update(bytes).digest('hex')}`));
  const unpack = path.join(dir, "unpacked");fs.mkdirSync(unpack);
  cp.execFileSync("tar", ["-xJf", archive, "-C", unpack]);
  assert.equal(fs.readFileSync(path.join(unpack, "opt/codex-desktop/resources/app.asar"), "utf8"), "official fixture ASAR");
  assert.match(fs.readFileSync(path.join(unpack, "usr/bin/codex-desktop"), "utf8"), /exec \/opt\/codex-desktop\/start.sh/);
  assert.match(fs.readFileSync(path.join(unpack, "usr/share/applications/codex-desktop.desktop"), "utf8"), /^Name=ChatGPT Community$/m);
  assert.equal(fs.statSync(path.join(unpack, "opt/codex-desktop/ChatGPT")).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(unpack, "usr/bin/codex-update-manager")), false);
  assert.equal(fs.existsSync(path.join(unpack, "opt/codex-desktop/update-builder")), false);
  assert.equal(fs.existsSync(path.join(unpack, "etc/apt")), false);
  m.sha256 = "b".repeat(64);fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(m));
  const rejected = cp.spawnSync("bash", ["scripts/build-gentoo.sh"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /latest signed stable/);
});
