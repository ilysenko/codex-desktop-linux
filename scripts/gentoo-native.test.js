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
const { stageEnabledLinuxFeatureInstall } = require("./lib/linux-features.js");

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

test("bootstrap preflight works without Node before dependency installation", t => {
  const dir = fixture(t), bin = path.join(dir, 'bin'), release = path.join(dir, 'os-release');
  fs.mkdirSync(bin); fs.writeFileSync(release, 'ID=gentoo\n');
  const log = path.join(dir, 'node-called');
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nprintf called > "$GENTOO_TEST_NODE_LOG"\nexit 127\n', { mode: 0o755 });
  const result = cp.spawnSync('make', ['native-bootstrap-preflight'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, OS_RELEASE_FILE: release,
      PACKAGE_WITH_UPDATER: '0', GENTOO_TEST_NODE_LOG: log } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(log), false);
});

test("Gentoo bootstrap does not treat installed Node 20 as satisfying ASAR tooling", () => {
  const script = fs.readFileSync(path.join(root, 'scripts/install-deps.sh'), 'utf8');
  const fn = script.match(/^install_emerge\(\) \{[\s\S]*?^\}/m)[0];
  const result = cp.spawnSync('bash', ['-c', 'portageq(){ if [[ "$3" == *net-libs/nodejs* ]]; then if [[ "$3" == ">=net-libs/nodejs-20[npm]" ]]; then printf "nodejs-20\\n"; fi; else printf "installed\\n"; fi; }; info(){ :; }; run_privileged(){ printf "%s\\n" "$@"; }; eval "$1"; install_emerge', '--', fn], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.split('\n').includes('>=net-libs/nodejs-22.12.0[npm]'));
});

test("explicit Gentoo packaging on another distro defaults updater off and honors overrides", t => {
  const dir = fixture(t), release = path.join(dir, 'os-release');
  fs.writeFileSync(release, 'ID=debian\n');
  const env = { ...process.env, OS_RELEASE_FILE: release };
  delete env.PACKAGE_WITH_UPDATER;
  const output = cp.execFileSync('make', ['-n', 'gentoo'], { cwd: root, env, encoding: 'utf8' });
  assert.match(output, /PACKAGE_WITH_UPDATER="0"/);
  const explicit = cp.execFileSync('make', ['-n', 'gentoo', 'PACKAGE_WITH_UPDATER=1'], { cwd: root, env, encoding: 'utf8' });
  assert.match(explicit, /PACKAGE_WITH_UPDATER="1"/);
  const inherited = cp.execFileSync('make', ['-n', 'gentoo'], { cwd: root, env: { ...env, PACKAGE_WITH_UPDATER: '1' }, encoding: 'utf8' });
  assert.match(inherited, /PACKAGE_WITH_UPDATER="1"/);
});

test("Gentoo graphical entry delegates to canonical terminal bootstrap", t => {
  const dir = fixture(t), bin = path.join(dir, 'bin'), release = path.join(dir, 'os-release');
  fs.mkdirSync(bin); fs.writeFileSync(release, 'ID=gentoo\n');
  const log = path.join(dir, 'make-called'), gui = path.join(dir, 'gui-called');
  fs.writeFileSync(path.join(bin, 'make'), '#!/bin/bash\nprintf "%s\\n" "$*" > "$GENTOO_TEST_MAKE_LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/bash\nprintf called > "$GENTOO_TEST_GUI_LOG"\nexit 1\n', { mode: 0o755 });
  const result = cp.spawnSync('bash', ['install-community'], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, OS_RELEASE_FILE: release,
      DISPLAY: ':fixture', GENTOO_TEST_MAKE_LOG: log, GENTOO_TEST_GUI_LOG: gui } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), `-C ${root} bootstrap-native`);
  assert.equal(fs.existsSync(gui), false);
});

test("stable audit maps a relocated or symlinked repository profile into its chroot", t => {
  const dir = fixture(t), repository = path.join(dir, 'srv/gentoo');
  const profile = path.join(repository, 'profiles/default/linux/amd64/23.0');
  fs.mkdirSync(profile, { recursive: true });
  const alias = path.join(dir, 'gentoo-link'); fs.symlinkSync(repository, alias);
  for (const repo of [repository, alias]) {
    const result = cp.spawnSync('bash', ['tests/gentoo_stable_dependencies.sh', '--map-profile', repo, profile], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '/var/db/repos/gentoo/profiles/default/linux/amd64/23.0');
  }
  const outside = cp.spawnSync('bash', ['tests/gentoo_stable_dependencies.sh', '--map-profile', repository, dir], { cwd: root, encoding: 'utf8' });
  assert.notEqual(outside.status, 0);
});

test("runtime dependency constraints require the Mesa flags providing upstream libgbm", () => {
  const template = fs.readFileSync(path.join(root, 'packaging/gentoo/codex-desktop.ebuild.template'), 'utf8');
  assert.match(template, /media-libs\/mesa\[opengl\(\+\),gbm\(\+\)\]/);
  assert.match(template, /sys-devel\/gcc\[cxx\]/);
});

test("audit loader layout supports merged-usr, split-usr, and absent optional lib64", t => {
  const dir = fixture(t), host = path.join(dir, 'host'), guest = path.join(dir, 'guest');
  fs.mkdirSync(host); fs.mkdirSync(guest);
  for (const name of ['bin', 'sbin', 'lib']) fs.mkdirSync(path.join(host, name));
  fs.symlinkSync('lib', path.join(host, 'lib64'));
  const library = path.join(root, 'tests/lib/gentoo-audit.sh');
  const result = cp.spawnSync('bash', ['-c', '. "$1"; fake_bind(){ printf "%s -> %s\\n" "$1" "$2"; }; gentoo_audit_usr_layout "$2" "$3" fake_bind', '--', library, guest, host], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['bin', 'sbin', 'lib']) {
    assert.ok(fs.statSync(path.join(guest, name)).isDirectory());
    assert.ok(result.stdout.includes(`${host}/${name} -> ${guest}/${name}`));
  }
  assert.equal(fs.readlinkSync(path.join(guest, 'lib64')), 'lib');
  const merged = path.join(dir, 'merged'), mergedGuest = path.join(dir, 'merged-guest');
  fs.mkdirSync(merged); fs.mkdirSync(mergedGuest);
  for (const name of ['bin', 'sbin', 'lib']) fs.symlinkSync(`usr/${name}`, path.join(merged, name));
  const mirrored = cp.spawnSync('bash', ['-c', '. "$1"; fake_bind(){ exit 99; }; gentoo_audit_usr_layout "$2" "$3" fake_bind', '--', library, mergedGuest, merged], { encoding: 'utf8' });
  assert.equal(mirrored.status, 0, mirrored.stderr);
  assert.equal(fs.readlinkSync(path.join(mergedGuest, 'bin')), 'usr/bin');
  assert.equal(fs.existsSync(path.join(mergedGuest, 'lib64')), false);
});

test("Gentoo postinst loads active host AppArmor policy and skips alternate ROOT", t => {
  const dir = fixture(t), bin = path.join(dir, 'bin'), log = path.join(dir, 'parser-called');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'aa-enabled'), '#!/bin/bash\nexit "${GENTOO_TEST_AA_STATUS:-0}"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'apparmor_parser'), '#!/bin/bash\nprintf "%s\\n" "$*" > "$GENTOO_TEST_PARSER_LOG"\nexit "${GENTOO_TEST_PARSER_STATUS:-0}"\n', { mode: 0o755 });
  const template = fs.readFileSync(path.join(root, 'packaging/gentoo/codex-desktop.ebuild.template'), 'utf8');
  const fn = template.slice(template.indexOf('pkg_postinst() {'));
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, ROOT: '/', EROOT: dir, GENTOO_TEST_PARSER_LOG: log };
  const run = extra => cp.spawnSync('bash', ['-c', 'xdg_pkg_postinst(){ :; }; elog(){ :; }; ewarn(){ printf "%s\\n" "$*"; }; eval "$1"; pkg_postinst', '--', fn], { encoding: 'utf8', env: { ...env, ...extra } });
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(log, 'utf8').trim(), `-r -W -T ${dir}/etc/apparmor.d/codex-desktop`);
  fs.unlinkSync(log);
  assert.equal(run({ ROOT: '/another-root' }).status, 0);
  assert.equal(fs.existsSync(log), false);
  assert.equal(run({ GENTOO_TEST_AA_STATUS: '1' }).status, 0);
  assert.equal(fs.existsSync(log), false);
  const failed = run({ GENTOO_TEST_PARSER_STATUS: '42' });
  assert.equal(failed.status, 0);
  assert.match(failed.stdout, /Could not reload/);
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
  assert.match(r.stderr, /does not support.*pet-overlay/);
});

function nativePackageFixture(t) {
  const dir = fixture(t), app = path.join(dir, "app"), bin = path.join(dir, "bin"), dist = path.join(dir, "dist");
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  fs.mkdirSync(path.join(app, ".codex-linux/upstream-package"), { recursive: true });
  fs.mkdirSync(path.join(app, "resources"), { recursive: true });
  fs.mkdirSync(bin);
  for (const name of ["ChatGPT", "start.sh", "resources/codex"]) fs.writeFileSync(path.join(app, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "resources/app.asar"), "official fixture ASAR");
  fs.writeFileSync(path.join(app, ".codex-linux/upstream-package/control"), `Package: chatgpt\nArchitecture: ${architecture}\n`);
  const m = { version: "26.930.31730", architecture, sha256: "a".repeat(64), size: 42 };
  fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(m));
  const buildInfo = { upstreamLinuxPackage: { ...m, sizeBytes: m.size }, linuxFeatures: { enabled: [] } };
  const staged = { version: 1, resources: [], runtimeHooks: [] };
  fs.writeFileSync(path.join(app, ".codex-linux/build-info.json"), JSON.stringify(buildInfo));
  fs.writeFileSync(path.join(app, ".codex-linux/linux-features-staged.json"), JSON.stringify(staged));
  fs.writeFileSync(path.join(app, ".codex-linux/patch-report.json"), JSON.stringify({ enabledFeatures: [], patches: [] }));
  fs.writeFileSync(path.join(dir, "features.json"), '{"enabled":[]}');
  // Mock network discovery, leaving provenance comparison, common staging,
  // archive and Manifest generation real. On non-Gentoo CI hosts only, mock
  // the host-specific Portage parser (covered separately when installed).
  const nodeWrapper = `#!/bin/bash\nif [[ "$1" == */upstream-linux-package.js ]]; then\n shift\n while [ "$#" -gt 0 ]; do if [ "$1" = --metadata ]; then cp "$GENTOO_TEST_METADATA" "$2"; exit 0; fi; shift; done\n exit 1\nfi\nexec "$GENTOO_TEST_NODE" "$@"\n`;
  fs.writeFileSync(path.join(bin, "node"), nodeWrapper, { mode: 0o755 });
  if (cp.spawnSync('python3', ['-c', 'import portage']).status !== 0) {
    fs.writeFileSync(path.join(bin, 'python3'), '#!/bin/bash\n[[ "$1" == */validate-gentoo-dependencies.py ]] || exit 99\nexit 0\n', { mode: 0o755 });
  }
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, TMPDIR: dir,
    APP_DIR_OVERRIDE: app, DIST_DIR_OVERRIDE: dist, PACKAGE_WITH_UPDATER: "0",
    CODEX_LINUX_FEATURES_CONFIG: path.join(dir, "features.json"), GENTOO_TEST_METADATA: path.join(dir, "metadata.json"), GENTOO_TEST_NODE: process.execPath };
  return { dir, app, bin, dist, architecture, m, buildInfo, staged, env };
}

test("generated ebuild payload and Manifest use the shared native layout", t => {
  const { dir, app, dist, m, buildInfo, staged, env } = nativePackageFixture(t);
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
  buildInfo.linuxFeatures.enabled = ['codex-micro'];
  fs.writeFileSync(path.join(app, '.codex-linux/build-info.json'), JSON.stringify(buildInfo));
  const stale = cp.spawnSync('bash', ['scripts/build-gentoo.sh'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /snapshot.*match/);
  buildInfo.linuxFeatures.enabled = [];
  fs.writeFileSync(path.join(app, '.codex-linux/build-info.json'), JSON.stringify(buildInfo));
  staged.runtimeHooks = [{ id: 'codex-micro' }];
  fs.writeFileSync(path.join(app, '.codex-linux/linux-features-staged.json'), JSON.stringify(staged));
  const staleHooks = cp.spawnSync('bash', ['scripts/build-gentoo.sh'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(staleHooks.status, 0);
  assert.match(staleHooks.stderr, /snapshot.*match/);
  staged.runtimeHooks = [];
  fs.writeFileSync(path.join(app, '.codex-linux/linux-features-staged.json'), JSON.stringify(staged));
  m.sha256 = "b".repeat(64);fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(m));
  const rejected = cp.spawnSync("bash", ["scripts/build-gentoo.sh"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /latest signed stable/);
});

test("future audited Gentoo feature packages phases, resources and user-space hooks end to end", t => {
  const { dir, app, dist, buildInfo, env } = nativePackageFixture(t);
  const featuresRoot = path.join(dir, 'linux-features'), featureDir = path.join(featuresRoot, 'fixture');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'README.md'), 'Test fixture\n');
  fs.writeFileSync(path.join(featureDir, 'feature.json'), JSON.stringify({
    id: 'fixture', defaultEnabled: false,
    gentoo: { supported: true, dependencies: {
      bootstrap: ['dev-lang/rust'], BDEPEND: ['sys-apps/file'], DEPEND: ['dev-libs/libusb:1'],
      RDEPEND: ['>=net-libs/nodejs-22.12.0[npm]'], IDEPEND: ['sys-apps/usbutils'],
    } },
    resources: [{ source: 'app-resource', target: '.codex-linux/features/fixture/resource', mode: '0640' },
      { source: 'tree', target: '.codex-linux/features/fixture/tree', mode: '0770' },
      { source: 'tree', target: '.codex-linux/features/fixture/readable-tree', mode: '0640' }],
    runtimeHooks: { prelaunch: { source: 'prelaunch.sh', mode: '0750' } },
    packageResources: [{ source: 'rule', target: 'usr/lib/udev/rules.d/70-fixture.rules', mode: '0640', formats: ['ebuild'] }],
    packageHooks: [{ source: 'package.sh', formats: ['ebuild'] }],
  }));
  fs.writeFileSync(path.join(featureDir, 'rule'), 'fixture rule\n');
  fs.writeFileSync(path.join(featureDir, 'app-resource'), 'fixture app resource\n');
  fs.mkdirSync(path.join(featureDir, 'tree/nested'), { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'tree/nested/child'), 'fixture directory resource\n');
  fs.writeFileSync(path.join(featureDir, 'prelaunch.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(featureDir, 'package.sh'), '#!/bin/bash\nset -eu\n[ "$PACKAGE_FORMAT" = ebuild ]\n[ "$PACKAGE_VERSION" = 26.930.31730 ]\n[ -f "$PACKAGE_ROOT/usr/lib/udev/rules.d/70-fixture.rules" ]\nprintf "%s\\n" "$PACKAGE_VERSION" > "$PACKAGE_ROOT/etc/fixture-version"\n');
  fs.writeFileSync(env.CODEX_LINUX_FEATURES_CONFIG, '{"enabled":["fixture"]}');
  env.CODEX_LINUX_FEATURES_ROOT = featuresRoot;
  buildInfo.linuxFeatures.enabled = ['fixture'];
  fs.writeFileSync(path.join(app, '.codex-linux/build-info.json'), JSON.stringify(buildInfo));
  fs.writeFileSync(path.join(app, '.codex-linux/patch-report.json'), '{"enabledFeatures":["fixture"],"patches":[]}');
  stageEnabledLinuxFeatureInstall(app, { featuresRoot, featuresConfigPath: env.CODEX_LINUX_FEATURES_CONFIG });
  const run = () => cp.spawnSync('bash', ['scripts/build-gentoo.sh'], { cwd: root, env, encoding: 'utf8' });
  const result = run(); assert.equal(result.status, 0, result.stderr);
  const gentooDir = path.join(dist, 'gentoo'), packageDir = path.join(gentooDir, 'repository/app-misc/codex-desktop');
  const ebuild = fs.readFileSync(path.join(packageDir, 'codex-desktop-26.930.31730.ebuild'), 'utf8');
  assert.ok(!ebuild.includes('dev-lang/rust'));
  const archive = path.join(gentooDir, fs.readdirSync(gentooDir).find(n => n.endsWith('.tar.xz')));
  const unpack = path.join(dir, 'unpacked'); fs.mkdirSync(unpack);
  const srcUnpack = ebuild.match(/^src_unpack\(\) \{[\s\S]*?^\}/m)[0];
  const unpacked = cp.spawnSync('bash', ['-c', 'umask 022; die(){ exit 99; }; eval "$1"; src_unpack', '--', srcUnpack], {
    env: { ...process.env, A: path.basename(archive), DISTDIR: gentooDir, WORKDIR: unpack }, encoding: 'utf8',
  });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  for (const file of ['usr/lib/udev/rules.d/70-fixture.rules', 'opt/codex-desktop/.codex-linux/features/fixture/resource']) {
    assert.equal(fs.statSync(path.join(unpack, file)).mode & 0o777, 0o640);
  }
  assert.equal(fs.statSync(path.join(unpack, 'opt/codex-desktop/.codex-linux/prelaunch.d/fixture-prelaunch.sh')).mode & 0o777, 0o750);
  assert.equal(fs.readFileSync(path.join(unpack, 'etc/fixture-version'), 'utf8'), '26.930.31730\n');
  for (const [name, dirMode, fileMode] of [['tree', 0o770, 0o770], ['readable-tree', 0o750, 0o640]]) {
    assert.equal(fs.statSync(path.join(unpack, 'opt/codex-desktop/.codex-linux/features/fixture', name, 'nested')).mode & 0o777, dirMode);
    assert.equal(fs.statSync(path.join(unpack, 'opt/codex-desktop/.codex-linux/features/fixture', name, 'nested/child')).mode & 0o777, fileMode);
  }
  // Exercise the generated src_install directly into a fixture image, not the
  // host filesystem, to prove external package resources reach Portage's D.
  const image = path.join(dir, 'image'); fs.mkdirSync(image);
  const srcInstall = ebuild.match(/^src_install\(\) \{[\s\S]*?^\}/m)[0];
  const installed = cp.spawnSync('bash', ['-c', 'die(){ exit 99; }; dostrip(){ :; }; docompress(){ :; }; eval "$1"; src_install', '--', srcInstall], {
    env: { ...process.env, S: unpack, D: image }, encoding: 'utf8',
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(fs.readFileSync(path.join(image, 'etc/fixture-version'), 'utf8'), '26.930.31730\n');
  for (const [name, dirMode, fileMode] of [['tree', 0o770, 0o770], ['readable-tree', 0o750, 0o640]]) {
    assert.equal(fs.statSync(path.join(image, 'opt/codex-desktop/.codex-linux/features/fixture', name, 'nested')).mode & 0o777, dirMode);
    assert.equal(fs.statSync(path.join(image, 'opt/codex-desktop/.codex-linux/features/fixture', name, 'nested/child')).mode & 0o777, fileMode);
  }
  const manifest = fs.readFileSync(path.join(packageDir, 'Manifest'), 'utf8');
  // A failed hook or un-installable root must not publish a new repository.
  for (const hook of ['exit 42\n', 'mkdir -p "$PACKAGE_ROOT/var/lib/fixture"\n', 'mkdir -p "$PACKAGE_ROOT/..unsupported"\n']) {
    fs.writeFileSync(path.join(featureDir, 'package.sh'), '#!/bin/bash\n' + hook);
    assert.notEqual(run().status, 0);
    assert.equal(fs.readFileSync(path.join(packageDir, 'Manifest'), 'utf8'), manifest);
  }
});

test("feature bootstrap resolves constrained atoms before helper builds and never installs runtime-only packages", t => {
  const { dir, env } = nativePackageFixture(t);
  const featuresRoot = path.join(dir, 'linux-features'), featureDir = path.join(featuresRoot, 'fixture');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'README.md'), 'Test fixture\n');
  fs.writeFileSync(path.join(featureDir, 'feature.json'), JSON.stringify({
    id: 'fixture', defaultEnabled: false, gentoo: { supported: true, dependencies: {
      bootstrap: ['>=net-libs/nodejs-22.12.0[npm]'], RDEPEND: ['sys-apps/usbutils'],
    } },
  }));
  fs.writeFileSync(env.CODEX_LINUX_FEATURES_CONFIG, '{"enabled":["fixture"]}');
  env.CODEX_LINUX_FEATURES_ROOT = featuresRoot;
  const source = fs.readFileSync(path.join(root, 'scripts/install-deps.sh'), 'utf8');
  const fn = source.match(/^install_emerge_feature_dependencies\(\) \{[\s\S]*?^\}/m)[0];
  const result = cp.spawnSync('bash', ['-ec', 'SCRIPT_DIR="$1"; portageq(){ :; }; info(){ :; }; run_privileged(){ printf "%s\\n" "$@"; }; eval "$2"; install_emerge_feature_dependencies', '--', path.join(root, 'scripts'), fn], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), ['emerge', '--oneshot', '--update', '>=net-libs/nodejs-22.12.0[npm]']);
  fs.writeFileSync(path.join(featureDir, 'feature.json'), '{"id":"fixture","defaultEnabled":false}');
  const refused = cp.spawnSync('bash', ['-ec', 'SCRIPT_DIR="$1"; run_privileged(){ echo must-not-install; }; eval "$2"; install_emerge_feature_dependencies', '--', path.join(root, 'scripts'), fn], { env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0); assert.ok(!refused.stdout.includes('must-not-install'));
});
