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
  assert.match(r.stderr, /empty feature configuration/);
});

test("generated ebuild payload and Manifest use the shared native layout", t => {
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
  buildInfo.linuxFeatures.enabled = ['codex-micro'];
  fs.writeFileSync(path.join(app, '.codex-linux/build-info.json'), JSON.stringify(buildInfo));
  const stale = cp.spawnSync('bash', ['scripts/build-gentoo.sh'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /empty staged feature snapshot/);
  buildInfo.linuxFeatures.enabled = [];
  fs.writeFileSync(path.join(app, '.codex-linux/build-info.json'), JSON.stringify(buildInfo));
  staged.runtimeHooks = [{ id: 'codex-micro' }];
  fs.writeFileSync(path.join(app, '.codex-linux/linux-features-staged.json'), JSON.stringify(staged));
  const staleHooks = cp.spawnSync('bash', ['scripts/build-gentoo.sh'], { cwd: root, env, encoding: 'utf8' });
  assert.notEqual(staleHooks.status, 0);
  assert.match(staleHooks.stderr, /empty staged feature snapshot/);
  staged.runtimeHooks = [];
  fs.writeFileSync(path.join(app, '.codex-linux/linux-features-staged.json'), JSON.stringify(staged));
  m.sha256 = "b".repeat(64);fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(m));
  const rejected = cp.spawnSync("bash", ["scripts/build-gentoo.sh"], { cwd: root, env, encoding: "utf8" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /latest signed stable/);
});
