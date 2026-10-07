#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  disabledLinuxFeatureCleanupHooks,
  enabledLinuxFeatureIds,
  enabledLinuxFeatureStageHooks,
} = require("../../scripts/lib/linux-features.js");

const FEATURE_DIR = __dirname;
const REPO_ROOT = path.resolve(FEATURE_DIR, "../..");
const STAGE = path.join(FEATURE_DIR, "stage.sh");
const CLEANUP = path.join(FEATURE_DIR, "cleanup.sh");
const WRAPPER = path.join(FEATURE_DIR, "node-repl-proxy-wrapper.sh");
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
];

function cleanProxyEnvironment(extra = {}) {
  const environment = { ...process.env };
  for (const name of PROXY_NAMES) delete environment[name];
  return { ...environment, ...extra };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function withTempFeatureRoot(enabled, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-proxy-features-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), '{"enabled":[]}\n');
    fs.writeFileSync(path.join(root, "features.json"), `${JSON.stringify({ enabled }, null, 2)}\n`);
    fs.cpSync(FEATURE_DIR, path.join(root, "browser-proxy"), { recursive: true });
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeExecutable(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

function makeFakeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-browser-proxy-install-"));
  const installDir = path.join(root, "app");
  const binDir = path.join(installDir, "resources", "cua_node", "bin");
  const nodeRepl = path.join(binDir, "node_repl");
  const originalNodeRepl = path.join(binDir, "node_repl.codex-linux-original");
  const originalContents = `#!/usr/bin/env bash
set -euo pipefail
for name in HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy NODE_USE_ENV_PROXY; do
  if [[ -v $name ]]; then
    printf '%s=%s\\n' "$name" "\${!name}"
  else
    printf '%s=<unset>\\n' "$name"
  fi
done
if [[ -v UNRELATED_SECRET ]]; then
  printf 'UNRELATED_SECRET=%s\\n' "$UNRELATED_SECRET"
else
  printf 'UNRELATED_SECRET=<unset>\\n'
fi
printf 'args=%s\\n' "$*"
`;
  writeExecutable(nodeRepl, originalContents);
  return { root, installDir, nodeRepl, originalNodeRepl, originalContents };
}

function featureEnvironment(installDir) {
  return {
    ...process.env,
    SCRIPT_DIR: REPO_ROOT,
    INSTALL_DIR: installDir,
    WORK_DIR: path.join(installDir, ".work"),
    ARCH: process.arch,
  };
}

function runWithFilteredChild(wrapper, parentEnvironment, childEnvironment = {}) {
  const childAssignments = Object.entries(childEnvironment).map(
    ([name, value]) => `${name}=${value}`,
  );
  // Keep Bash alive as the wrapper's parent. Otherwise Bash may replace itself
  // with the final command and the wrapper would inspect the Node test runner.
  const script = `wrapper="$1"; shift; env -i -- PATH="$PATH" HOME="\${HOME:-/tmp}" "$@" "$wrapper" alpha beta; status=$?; :; exit $status`;
  return run(
    "bash",
    ["-c", script, "browser-proxy-parent", wrapper, ...childAssignments],
    { env: parentEnvironment },
  );
}

function makeFakeCuaInstall(identityMismatch) {
  const fixture = makeFakeInstall();
  run("bash", [STAGE], { env: featureEnvironment(fixture.installDir) });
  const resources = path.join(fixture.installDir, "resources");
  const node = path.join(resources, "cua_node/bin/node");
  const codex = path.join(resources, "codex");
  // Bash stands in for app-server so the two executable identities remain
  // distinct without copying the Node binary or depending on an installed app.
  const bash = run("bash", ["-c", 'readlink -f -- "/proc/$$/exe"; :']).stdout.trim();
  assert.notEqual(bash, fs.realpathSync(process.execPath));
  fs.symlinkSync(identityMismatch === "node" ? bash : process.execPath, node);
  fs.symlinkSync(identityMismatch === "app-server" ? process.execPath : bash, codex);
  const launcher = path.join(
    resources,
    "cua_node/lib/node_modules/@oai/cua-repl/bin",
    identityMismatch === "launcher" ? "unrelated.mjs" : "cua-repl.mjs",
  );
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `import { spawnSync } from 'node:child_process';
const result = spawnSync(process.argv[2], ['alpha', 'beta'], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...JSON.parse(process.argv[3]) },
  encoding: 'utf8',
});
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`);
  return { ...fixture, bash, launcher };
}

function runWithFilteredCua(fixture, grandparentEnvironment, parentEnvironment = {}, childEnvironment = {}) {
  const parentAssignments = Object.entries(parentEnvironment).map(
    ([name, value]) => `${name}=${value}`,
  );
  // Keep app-server's Bash stand-in alive while CUA waits for node_repl. Both
  // helpers receive separately filtered environments, as in the upstream chain.
  const script = `node="$1"; launcher="$2"; wrapper="$3"; child_environment="$4"; shift 4;
env -i -- PATH="$PATH" HOME="\${HOME:-/tmp}" "$@" "$node" "$launcher" "$wrapper" "$child_environment";
status=$?; :; exit "$status"`;
  return run(fixture.bash, [
    "-c", script, "browser-proxy-app-server", process.execPath,
    fixture.launcher, fixture.nodeRepl, JSON.stringify(childEnvironment), ...parentAssignments,
  ], { env: grandparentEnvironment });
}

function reportedEnvironment(stdout) {
  const environment = new Map();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) environment.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return environment;
}

test("browser-proxy is disabled by default and exposes cleanup only while disabled", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);
    assert.deepEqual(
      disabledLinuxFeatureCleanupHooks({ featuresRoot: root }).map((hook) => hook.id),
      ["browser-proxy"],
    );
  });
});

test("browser-proxy exposes one stage hook only when explicitly enabled", () => {
  withTempFeatureRoot(["browser-proxy"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["browser-proxy"]);
    assert.deepEqual(
      enabledLinuxFeatureStageHooks({ featuresRoot: root }).map((hook) => hook.id),
      ["browser-proxy"],
    );
    assert.deepEqual(disabledLinuxFeatureCleanupHooks({ featuresRoot: root }), []);
  });
});

test("feature shell entrypoints pass bash syntax validation", () => {
  for (const script of [STAGE, CLEANUP, WRAPPER]) run("bash", ["-n", script]);
});

test("stage is idempotent and the wrapper recovers only proxy variables from its parent", () => {
  const fixture = makeFakeInstall();
  try {
    const env = featureEnvironment(fixture.installDir);
    run("bash", [STAGE], { env });
    run("bash", [STAGE], { env });

    assert.equal(fs.readFileSync(fixture.originalNodeRepl, "utf8"), fixture.originalContents);
    assert.match(fs.readFileSync(fixture.nodeRepl, "utf8"), /browser-proxy-node-repl-wrapper/);
    assert.equal(fs.statSync(fixture.nodeRepl).mode & 0o777, 0o755);
    assert.equal(fs.statSync(fixture.originalNodeRepl).mode & 0o111, 0o111);

    const result = runWithFilteredChild(
      fixture.nodeRepl,
      cleanProxyEnvironment({
        HTTP_PROXY: "http://127.0.0.1:18080",
        https_proxy: "http://127.0.0.1:18443",
        NO_PROXY: "127.0.0.1,localhost",
        UNRELATED_SECRET: "must-not-be-copied",
      }),
    );
    assert.match(result.stdout, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:18080$/m);
    assert.match(result.stdout, /^https_proxy=http:\/\/127\.0\.0\.1:18443$/m);
    assert.match(result.stdout, /^NO_PROXY=127\.0\.0\.1,localhost$/m);
    assert.match(result.stdout, /^NODE_USE_ENV_PROXY=1$/m);
    assert.match(result.stdout, /^HTTPS_PROXY=<unset>$/m);
    assert.match(result.stdout, /^UNRELATED_SECRET=<unset>$/m);
    assert.doesNotMatch(result.stdout, /must-not-be-copied/);
    assert.match(result.stdout, /^args=alpha beta$/m);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit child proxy value wins over the parent value", () => {
  const fixture = makeFakeInstall();
  try {
    run("bash", [STAGE], { env: featureEnvironment(fixture.installDir) });
    const result = runWithFilteredChild(
      fixture.nodeRepl,
      cleanProxyEnvironment({ HTTP_PROXY: "http://parent.invalid:8080" }),
      { HTTP_PROXY: "http://child.invalid:9090" },
    );
    assert.match(result.stdout, /^HTTP_PROXY=http:\/\/child\.invalid:9090$/m);
    assert.match(result.stdout, /^NODE_USE_ENV_PROXY=1$/m);
    assert.doesNotMatch(result.stdout, /parent\.invalid/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit child proxy family blocks cross-case parent values", () => {
  const fixture = makeFakeInstall();
  try {
    run("bash", [STAGE], { env: featureEnvironment(fixture.installDir) });
    const families = [
      ["HTTP_PROXY", "http_proxy", "http://child-http.invalid:8080"],
      ["HTTPS_PROXY", "https_proxy", "http://child-https.invalid:8443"],
      ["ALL_PROXY", "all_proxy", "socks://child-all.invalid:1080"],
      ["NO_PROXY", "no_proxy", "child.internal,localhost"],
    ];

    for (const [upperName, lowerName, childValue] of families) {
      for (const [childName, parentName] of [
        [upperName, lowerName],
        [lowerName, upperName],
      ]) {
        const parentValue = parentName.toLowerCase() === "no_proxy"
          ? "parent.internal"
          : "http://parent-user:parent-secret@parent.invalid:8080";
        const result = runWithFilteredChild(
          fixture.nodeRepl,
          cleanProxyEnvironment({ [parentName]: parentValue }),
          { [childName]: childValue },
        );
        const environment = reportedEnvironment(result.stdout);

        assert.equal(environment.get(childName), childValue);
        assert.equal(environment.get(parentName), "<unset>");
        assert.doesNotMatch(result.stdout, /parent-user|parent-secret|parent\.invalid/);
      }
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the wrapper leaves NODE_USE_ENV_PROXY unset when no proxy exists", () => {
  const fixture = makeFakeInstall();
  try {
    run("bash", [STAGE], { env: featureEnvironment(fixture.installDir) });
    const result = runWithFilteredChild(fixture.nodeRepl, cleanProxyEnvironment());
    assert.match(result.stdout, /^HTTP_PROXY=<unset>$/m);
    assert.match(result.stdout, /^https_proxy=<unset>$/m);
    assert.match(result.stdout, /^NODE_USE_ENV_PROXY=<unset>$/m);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("cleanup restores the original entrypoint byte-for-byte", () => {
  const fixture = makeFakeInstall();
  try {
    const env = featureEnvironment(fixture.installDir);
    run("bash", [STAGE], { env });
    run("bash", [CLEANUP], { env });
    run("bash", [CLEANUP], { env });

    assert.equal(fs.readFileSync(fixture.nodeRepl, "utf8"), fixture.originalContents);
    assert.equal(fs.existsSync(fixture.originalNodeRepl), false);
    assert.equal(fs.statSync(fixture.nodeRepl).mode & 0o111, 0o111);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a staging failure restores the original entrypoint", () => {
  const fixture = makeFakeInstall();
  try {
    const fakeBin = path.join(fixture.root, "fake-bin");
    writeExecutable(path.join(fakeBin, "install"), "#!/usr/bin/env bash\nexit 73\n");
    const env = {
      ...featureEnvironment(fixture.installDir),
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    };
    const result = spawnSync("bash", [STAGE], { cwd: REPO_ROOT, encoding: "utf8", env });

    assert.notEqual(result.status, 0, "stage unexpectedly succeeded with a failing install command");
    assert.equal(fs.readFileSync(fixture.nodeRepl, "utf8"), fixture.originalContents);
    assert.equal(fs.existsSync(fixture.originalNodeRepl), false);
    assert.deepEqual(
      fs.readdirSync(path.dirname(fixture.nodeRepl)).filter((name) => name.startsWith(".node_repl.")),
      [],
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("stage and cleanup preserve files when an unknown wrapper owns the entrypoint", () => {
  const fixture = makeFakeInstall();
  try {
    const foreignContents = "#!/usr/bin/env bash\necho foreign wrapper\n";
    const backupContents = "#!/usr/bin/env bash\necho existing backup\n";
    writeExecutable(fixture.nodeRepl, foreignContents);
    writeExecutable(fixture.originalNodeRepl, backupContents);
    const env = featureEnvironment(fixture.installDir);

    for (const script of [STAGE, CLEANUP]) {
      const result = spawnSync("bash", [script], { cwd: REPO_ROOT, encoding: "utf8", env });
      assert.notEqual(result.status, 0, `${path.basename(script)} unexpectedly succeeded`);
      assert.match(result.stderr, /does not own|not this feature's wrapper/);
      assert.equal(fs.readFileSync(fixture.nodeRepl, "utf8"), foreignContents);
      assert.equal(fs.readFileSync(fixture.originalNodeRepl, "utf8"), backupContents);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

for (const identityMismatch of [undefined, "launcher", "node", "app-server"]) {
  test(`CUA proxy recovery ${identityMismatch ? `rejects an unrelated ${identityMismatch}` : "recognizes the bundled process chain"}`, () => {
    const fixture = makeFakeCuaInstall(identityMismatch);
    try {
      const result = runWithFilteredCua(fixture, cleanProxyEnvironment({
        HTTPS_PROXY: "http://127.0.0.1:18443",
        UNRELATED_SECRET: "do-not-inherit",
      }));
      const values = reportedEnvironment(result.stdout);
      assert.equal(values.get("HTTPS_PROXY"), identityMismatch ? "<unset>" : "http://127.0.0.1:18443");
      assert.equal(values.get("NODE_USE_ENV_PROXY"), identityMismatch ? "<unset>" : "1");
      assert.equal(values.get("UNRELATED_SECRET"), "<unset>");
      assert.equal(values.get("args"), "alpha beta");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

for (const level of ["child", "direct parent"]) {
  for (const empty of [false, true]) {
    test(`CUA ${level} ${empty ? "empty" : "non-empty"} proxy families block higher ancestors across case`, () => {
      const fixture = makeFakeCuaInstall();
      try {
        for (const [upperName, lowerName] of [
          ["HTTP_PROXY", "http_proxy"],
          ["HTTPS_PROXY", "https_proxy"],
          ["ALL_PROXY", "all_proxy"],
          ["NO_PROXY", "no_proxy"],
        ]) {
          for (const [preferredName, alternateName] of [[upperName, lowerName], [lowerName, upperName]]) {
            const value = empty ? "" : "preferred.invalid";
            const parentEnvironment = level === "direct parent"
              ? { [preferredName]: value }
              : { [alternateName]: "parent.invalid" };
            const childEnvironment = level === "child" ? { [preferredName]: value } : {};
            const result = runWithFilteredCua(
              fixture,
              cleanProxyEnvironment({ [alternateName]: "grandparent.invalid" }),
              parentEnvironment,
              childEnvironment,
            );
            const values = reportedEnvironment(result.stdout);
            assert.equal(values.get(preferredName), value, `${preferredName} should retain the ${level} value`);
            assert.equal(values.get(alternateName), "<unset>", `${alternateName} should not leak an ancestor value`);
            assert.equal(values.get("NODE_USE_ENV_PROXY"), empty || upperName === "NO_PROXY" ? "<unset>" : "1");
          }
        }
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
}

for (const level of ["child", "direct parent", "app-server"]) {
  for (const value of ["0", ""]) {
    test(`CUA preserves ${level} NODE_USE_ENV_PROXY=${JSON.stringify(value)}`, () => {
      const fixture = makeFakeCuaInstall();
      try {
        const result = runWithFilteredCua(
          fixture,
          cleanProxyEnvironment({
            HTTPS_PROXY: "http://grandparent.invalid:8443",
            NODE_USE_ENV_PROXY: level === "app-server" ? value : "1",
          }),
          level === "app-server" ? {} : { NODE_USE_ENV_PROXY: level === "direct parent" ? value : "1" },
          level === "child" ? { NODE_USE_ENV_PROXY: value } : {},
        );
        const values = reportedEnvironment(result.stdout);
        assert.equal(values.get("HTTPS_PROXY"), "http://grandparent.invalid:8443");
        assert.equal(values.get("NODE_USE_ENV_PROXY"), value);
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
}
