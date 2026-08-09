#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { stageEnabledLinuxFeatureInstall } = require("../../scripts/lib/linux-features.js");
const root = path.resolve(__dirname, "../..");
const hook = path.join(__dirname, "launcher-hook.sh");
const stageHook = path.join(__dirname, "stage.sh");
const cleanupHook = path.join(__dirname, "cleanup.sh");
const packageHook = path.join(__dirname, "package-hook.sh");

function withConfig(enabled, callback) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-sandbox-config-"));
  const configPath = path.join(temp, "features.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
  try {
    return callback({ featuresRoot: path.join(root, "linux-features"), featuresConfigPath: configPath });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-sandbox-hook-"));
  const app = path.join(temp, "app");
  const bin = path.join(temp, "bin");
  const helper = path.join(temp, "installed-helper");
  const features = path.join(app, ".codex-linux", "features");
  const generatedHelper = path.join(features, "chromium-sandbox", "generated-chrome-sandbox");
  fs.mkdirSync(path.dirname(generatedHelper), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(generatedHelper, "matching helper\n", { mode: 0o755 });
  fs.writeFileSync(path.join(app, "electron"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.copyFileSync(generatedHelper, helper);
  fs.chmodSync(helper, 0o755);
  fs.writeFileSync(path.join(bin, "stat"),
    "#!/bin/sh\nprintf '%s\\n' \"${CODEX_TEST_STAT_METADATA:-0:0:4755}\"\n",
    { mode: 0o755 });
  return { temp, app, bin, features, generatedHelper, helper };
}

function runHook(f, {
  resident = "0",
  helper = f.helper,
  args = [],
  metadata = "0:0:4755",
} = {}) {
  return spawnSync("bash", [hook, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${f.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      CODEX_LINUX_APP_DIR: f.app,
      CODEX_LINUX_FEATURES_DIR: f.features,
      CODEX_LINUX_RESIDENT_PROCESS_ACTIVE: resident,
      CHROME_DEVEL_SANDBOX: helper,
      CODEX_TEST_STAT_METADATA: metadata,
    },
  });
}

test("feature is disabled by default and stages only when enabled", () => {
  withConfig([], (options) => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-sandbox-disabled-"));
    try {
      assert.deepEqual(stageEnabledLinuxFeatureInstall(app, options).runtimeHooks, []);
    } finally { fs.rmSync(app, { recursive: true, force: true }); }
  });
  withConfig(["chromium-sandbox"], (options) => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-sandbox-enabled-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(app, options);
      assert.deepEqual(plan.runtimeHooks.map((entry) => entry.target), [
        ".codex-linux/launcher.d/chromium-sandbox-chromium-sandbox.sh",
      ]);
    } finally { fs.rmSync(app, { recursive: true, force: true }); }
  });
});

test("stage hook preserves the generated helper and cleanup restores it", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-sandbox-stage-"));
  const app = path.join(temp, "app");
  const bundled = path.join(app, "chrome-sandbox");
  const generated = path.join(app, ".codex-linux", "features", "chromium-sandbox", "generated-chrome-sandbox");
  fs.mkdirSync(app);
  fs.writeFileSync(bundled, "generated helper\n", { mode: 0o755 });
  try {
    const staged = spawnSync("bash", [stageHook], {
      encoding: "utf8",
      env: { ...process.env, INSTALL_DIR: app },
    });
    assert.equal(staged.status, 0, staged.stderr);
    assert.equal(fs.existsSync(bundled), false);
    assert.equal(fs.readFileSync(generated, "utf8"), "generated helper\n");

    const cleaned = spawnSync("bash", [cleanupHook], {
      encoding: "utf8",
      env: { ...process.env, INSTALL_DIR: app },
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.readFileSync(bundled, "utf8"), "generated helper\n");
    assert.equal(fs.existsSync(generated), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("native package creation fails closed for the user-managed-only feature", () => {
  const result = spawnSync("bash", [packageHook], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /supports user-managed app builds only/);
});

test("qualified cold launch removes only sandbox-disabling core defaults", () => {
  const f = fixture();
  try {
    const result = runHook(f);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `env CHROME_DEVEL_SANDBOX=${f.helper}`,
      "env-lock CHROME_DEVEL_SANDBOX",
      "electron-default-arg-remove --no-sandbox",
      "electron-default-arg-remove --disable-gpu-sandbox",
      "electron-arg-deny --no-sandbox",
      "electron-arg-deny --disable-*-sandbox",
    ]);
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("resident process rejects both IPC warm start and second-instance fallback", () => {
  const f = fixture();
  try {
    const result = runHook(f, { resident: "1" });
    assert.equal(result.status, 0);
    assert.match(result.stdout,
      /launch-error Chromium sandbox: a resident app process is already running/);
    assert.doesNotMatch(result.stdout, /electron-default-arg-remove/);
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("helper and final conflicting-argument failures are actionable", () => {
  const f = fixture();
  try {
    assert.match(runHook(f, { helper: "" }).stdout, /must name an absolute helper path/);
    assert.match(runHook(f, { helper: "relative" }).stdout, /must name an absolute helper path/);
    assert.match(runHook(f, { helper: path.join(f.temp, "missing") }).stdout,
      /non-symlink executable regular file/);
    const symlink = path.join(f.temp, "symlink");
    fs.symlinkSync(f.helper, symlink);
    assert.match(runHook(f, { helper: symlink }).stdout,
      /non-symlink executable regular file/);
    fs.chmodSync(f.helper, 0o644);
    assert.match(runHook(f).stdout, /non-symlink executable regular file/);
    fs.chmodSync(f.helper, 0o755);
    assert.match(runHook(f, { metadata: "1000:1000:755" }).stdout,
      /root:root mode 4755/);
    const mismatch = path.join(f.temp, "mismatch");
    fs.writeFileSync(mismatch, "wrong\n", { mode: 0o755 });
    assert.match(runHook(f, { helper: mismatch }).stdout, /does not match/);
    fs.writeFileSync(path.join(f.app, "chrome-sandbox"), "matching helper\n", { mode: 0o755 });
    assert.match(runHook(f).stdout, /chrome-sandbox path must remain absent/);
    fs.rmSync(path.join(f.app, "chrome-sandbox"));
    fs.renameSync(f.generatedHelper, `${f.generatedHelper}.missing`);
    assert.match(runHook(f).stdout, /generated helper reference is missing or invalid/);
    fs.renameSync(`${f.generatedHelper}.missing`, f.generatedHelper);
    for (const arg of ["--no-sandbox", "--disable-gpu-sandbox", "--disable-setuid-sandbox=true"]) {
      assert.match(runHook(f, { args: [arg] }).stdout, /conflicting Electron argument/);
    }
  } finally { fs.rmSync(f.temp, { recursive: true, force: true }); }
});

test("actual launcher control flow executes launch preparation before either handoff", () => {
  const source = fs.readFileSync(path.join(root, "launcher/start.sh.template"), "utf8");
  const runtime = source.slice(source.indexOf("recover_unhealthy_running_app\nprepare_launch_state_under_lock"));
  const prepare = runtime.indexOf("prepare_electron_launch");
  assert.ok(prepare >= 0);
  assert.match(runtime, /prepare_electron_launch "\${LAUNCHER_ARGS\[@\]}"/);
  assert.doesNotMatch(runtime, /prepare_electron_launch "\${LAUNCHER_ARGS\[@\]:1}"/);
  assert.ok(prepare < runtime.indexOf("send_warm_start_launch_action"));
  assert.ok(prepare < runtime.indexOf("using_second_instance_handoff"));
  assert.match(source, /launch-error\\ \*\)[\s\S]*notify_error[\s\S]*return 1/);
});
