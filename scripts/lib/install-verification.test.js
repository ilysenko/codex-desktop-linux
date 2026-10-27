"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { makeDeb } = require("../../tests/lib/upstream-package-fixture.js");
const { buildInfo } = require("./build-info.js");

const repo = path.resolve(__dirname, "../..");
const skip = "--skip-oai-official-sig-verification";

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-install-verification-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = makeDeb(path.join(root, "package"), options);
  const metadata = path.join(root, "metadata.json");
  const calls = path.join(root, "verifier-calls.json");
  const bin = path.join(root, "bin");
  const work = path.join(root, "work");
  fs.mkdirSync(bin);
  fs.mkdirSync(work);
  const verifier = path.join(root, "verifier.js");
  fs.writeFileSync(verifier, `
    const fs = require('node:fs');
    const args = process.argv.slice(3);
    fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(args));
    if (process.env.FIXTURE_VERIFIER_FAIL === '1') { console.error('fixture signed verification failed'); process.exit(23); }
    const file = args[args.indexOf('--local-package') + 1];
    const output = args[args.indexOf('--metadata') + 1];
    fs.writeFileSync(output, JSON.stringify({ package: 'chatgpt', version: '26.1021.22027', architecture: 'amd64',
      path: file, signatureVerification: 'verified', explicitlyProvided: true }));
    console.log(file);
  `);
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(path.join(bin, "node"), [
    "#!/bin/bash",
    `if [ "$1" = ${shellQuote(path.join(repo, "scripts/lib/upstream-linux-package.js"))} ]; then`,
    `  exec ${shellQuote(process.execPath)} ${shellQuote(verifier)} "$@"`,
    "fi",
    `exec ${shellQuote(process.execPath)} "$@"`, "",
  ].join("\n"), { mode: 0o755 });
  const runner = path.join(root, "run.sh");
  fs.writeFileSync(runner, [
    "#!/bin/bash", "set -Eeuo pipefail",
    `. ${shellQuote(path.join(repo, "scripts/lib/install-helpers.sh"))}`,
    `. ${shellQuote(path.join(repo, "scripts/lib/upstream-linux-package.sh"))}`,
    'parse_args "$@"',
    `resolve_upstream_linux_package ${shellQuote(metadata)}`,
    'extract_upstream_linux_package "$UPSTREAM_DEB_PATH"', "",
  ].join("\n"), { mode: 0o755 });
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, UPSTREAM_DEB: "",
    WORK_DIR: work, SCRIPT_DIR: repo, ARCH: options.architecture ?? "amd64",
  };
  return { root, file, metadata, calls, runner, env };
}

function run(f, args, env = {}) {
  return childProcess.spawnSync(f.runner, args, { encoding: "utf8", env: { ...f.env, ...env } });
}

function terminal(f, args) {
  const result = childProcess.spawnSync("python3", ["-B", "-c", `
import errno, json, os, pty, select, subprocess, sys, time
command = json.loads(sys.argv[1])
master, slave = pty.openpty()
child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b''
deadline = time.monotonic() + 15
try:
    while True:
        if time.monotonic() > deadline:
            child.kill()
            raise RuntimeError('terminal fixture timed out: ' + output.decode(errors='replace'))
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO: raise
                break
            if not chunk: break
            output += chunk
        elif child.poll() is not None:
            break
finally:
    os.close(master)
    child.wait(timeout=5)
print(json.dumps({'status': child.returncode, 'output': output.decode(errors='replace')}))
  `, JSON.stringify([f.runner, ...args])], { encoding: "utf8", env: f.env, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("noninteractive local inputs verify by default, including UPSTREAM_DEB and piped yes", (t) => {
  for (const fromEnvironment of [false, true]) {
    const f = fixture(t);
    const result = childProcess.spawnSync(f.runner, fromEnvironment ? [] : [f.file], {
      encoding: "utf8", input: "yes\n", env: {
        ...f.env, SKIP_OAI_OFFICIAL_SIG_VERIFICATION: "1",
        ...(fromEnvironment ? { UPSTREAM_DEB: f.file } : {}),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /\[y\/N\]/);
    const args = JSON.parse(fs.readFileSync(f.calls));
    assert.equal(args[args.indexOf("--local-package") + 1], f.file);
    assert.equal(JSON.parse(fs.readFileSync(f.metadata)).signatureVerification, "verified");
  }
});

test("failed verification aborts without silently switching to a skip", (t) => {
  const f = fixture(t);
  const result = run(f, [f.file], { FIXTURE_VERIFIER_FAIL: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signed verification failed/);
  assert.equal(fs.existsSync(f.metadata), false);
});

test("the explicit local skip avoids signed discovery and is recorded in build provenance", (t) => {
  const f = fixture(t);
  const result = run(f, [skip, f.file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(f.calls), false);
  assert.match(result.stderr, /Skipping OpenAI official signed-repository verification/);
  const metadata = JSON.parse(fs.readFileSync(f.metadata));
  assert.equal(metadata.signatureVerification, "skipped");
  assert.equal(metadata.repository, null);
  const featuresRoot = path.join(f.root, "features");
  fs.mkdirSync(featuresRoot);
  fs.writeFileSync(path.join(featuresRoot, "features.example.json"), '{"enabled":[]}');
  const info = buildInfo({
    repoDir: f.root, upstreamPackagePath: f.file, upstreamMetadata: metadata, featuresRoot,
    appId: "codex-desktop", appDisplayName: "ChatGPT Community",
  });
  assert.equal(info.upstreamLinuxPackage.signatureVerification, "skipped");
  const verified = buildInfo({ repoDir: f.root, upstreamPackagePath: f.file,
    upstreamMetadata: { ...metadata, signatureVerification: "verified" }, featuresRoot });
  assert.equal(verified.upstreamLinuxPackage.signatureVerification, "verified");
});

test("a skip requires a local input and retains architecture, control, and payload checks", (t) => {
  const absent = fixture(t);
  assert.match(run(absent, [skip]).stderr, /requires a local .deb/);
  for (const [options, message] of [
    [{ packageName: "other" }, /package name must be 'chatgpt'/],
    [{ architecture: "armv7l" }, /Unsupported architecture/],
    [{ missingPayload: "resources/codex" }, /missing bundled codex/],
  ]) {
    const f = fixture(t, options);
    const result = run(f, [f.file, skip]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  }
  const wrongArch = fixture(t, { architecture: "arm64" });
  assert.match(run(wrongArch, [skip, wrongArch.file], { ARCH: "amd64" }).stderr, /architecture is 'arm64', expected 'amd64'/);
});

test("terminal local builds verify without input and skip only with an explicit flag", (t) => {
  for (const fromEnvironment of [false, true]) {
    const f = fixture(t);
    if (fromEnvironment) f.env.UPSTREAM_DEB = f.file;
    const result = terminal(f, fromEnvironment ? [] : [f.file]);
    assert.equal(result.status, 0, result.output);
    assert.doesNotMatch(result.output, /\[y\/N\]|Skip OpenAI official/);
    assert.equal(fs.existsSync(f.calls), true);
    assert.equal(JSON.parse(fs.readFileSync(f.metadata)).signatureVerification, "verified");
  }
  const explicit = fixture(t);
  const result = terminal(explicit, [skip, explicit.file]);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /\[y\/N\]/);
  assert.equal(fs.existsSync(explicit.calls), false);
  assert.equal(JSON.parse(fs.readFileSync(explicit.metadata)).signatureVerification, "skipped");
  const next = terminal(explicit, [explicit.file]);
  assert.equal(next.status, 0, next.output);
  assert.doesNotMatch(next.output, /\[y\/N\]|Skip OpenAI official/);
  assert.equal(JSON.parse(fs.readFileSync(explicit.metadata)).signatureVerification, "verified");
});

test("real transactional install and rebuild forward explicit verification flags without prompting", (t) => {
  for (const [entrypoint, explicit] of [["install.sh", false], ["install.sh", true], ["scripts/rebuild-candidate.sh", false], ["scripts/rebuild-candidate.sh", true]]) {
    const f = fixture(t);
    const app = path.join(f.root, "app");
    const features = path.join(f.root, "features");
    const reports = path.join(f.root, "reports");
    fs.mkdirSync(app);
    fs.mkdirSync(features);
    fs.writeFileSync(path.join(app, "previous-app"), "preserve me");
    const config = path.join(features, "features.example.json");
    fs.writeFileSync(config, '{"enabled":[]}');
    const asar = path.join(f.root, "asar");
    fs.writeFileSync(asar, "#!/bin/sh\nexit 73\n", { mode: 0o755 });
    const result = terminal({ ...f, runner: path.join(repo, entrypoint), env: {
      ...f.env, CODEX_INSTALL_DIR: app, CODEX_NEXT_APP_DIR: app,
      REBUILD_REPORT_DIR: reports, CODEX_KEEP_REJECTED_CANDIDATE: "0", CODEX_ASAR_BIN: asar,
      CODEX_LINUX_FEATURES_CONFIG: config, CODEX_LINUX_FEATURES_ROOT: features,
      CODEX_INSTALL_TRANSACTION_ACTIVE: "0",
    } }, explicit ? [skip, f.file] : [f.file]);
    assert.notEqual(result.status, 0, "the fixture forces a later ASAR-tool failure");
    assert.match(result.output, /Extracting a temporary app\.asar copy/);
    assert.doesNotMatch(result.output, /\[y\/N\]/);
    assert.equal(fs.readFileSync(path.join(app, "previous-app"), "utf8"), "preserve me");
    assert.equal(fs.existsSync(path.join(app, "ChatGPT")), false);
    const [transaction] = fs.readdirSync(path.join(reports, "transactions"));
    const metadata = JSON.parse(fs.readFileSync(path.join(reports, "transactions", transaction, "upstream-linux-package.json")));
    assert.equal(metadata.signatureVerification, explicit ? "skipped" : "verified");
    assert.equal(fs.existsSync(f.calls), !explicit);
  }
});

test("Nix uses the explicit local exception for its already hash-verified fixed-output input", () => {
  const flake = fs.readFileSync(path.join(repo, "flake.nix"), "utf8");
  assert.equal((flake.match(/install\.sh[^\n]*--skip-oai-official-sig-verification/g) ?? []).length, 2);
  assert.match(flake, /upstreamDeb = pkgs\.fetchurl \{\s+inherit \(officialPackage\) url hash;/);
  const builder = fs.readFileSync(path.join(repo, "updater/src/builder.rs"), "utf8");
  assert.ok(!builder.includes(skip), "the native updater must retain signed verification");
});
