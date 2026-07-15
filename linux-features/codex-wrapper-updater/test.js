"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  applyMainBundlePatch,
  applyWebviewRuntimePatch,
  applyWrapperUpdateSettingsPatch,
  patchWrapperUpdateSettingsAssets,
} = require("./patch.js");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");

const featureDir = __dirname;
const featuresRoot = path.resolve(featureDir, "..");
const GENERATION = "a".repeat(40);

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }, null, 2));
    return fn();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function fakeManager(temp, body = "exit ${CODEX_FAKE_MANAGER_STATUS:-0}\n") {
  const manager = path.join(temp, "codex-update-manager");
  fs.writeFileSync(manager, `#!/usr/bin/env bash\n${body}`);
  fs.chmodSync(manager, 0o755);
  return manager;
}

function withoutWarnings(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = originalWarn;
  }
}

test("main bundle patch writes app-state wrapper marker", () => {
  const source =
    `"use strict";var f=require("node:fs"),p=require("node:path"),c=require("node:child_process");` +
    `var handlers={"native-desktop-apps":async()=>({ok:true})};`;

  const patched = applyMainBundlePatch(source);

  assert.match(patched, /"codex-linux-wrapper-updater":async/);
  assert.match(patched, /CODEX_LINUX_APP_STATE_DIR/);
  assert.match(patched, /pick-features/);
  assert.match(patched, /codex-linux-feature-picker-on-update/);
  assert.match(patched, /codex-wrapper-updater/);
  assert.match(patched, /restart-intent/);
  assert.match(patched, /candidate_wrapper_commit/);
  assert.match(patched, /no-valid-candidate-generation/);
  assert.match(patched, /wrapper_dev_mode/);
  assert.match(patched, /installed_wrapper_commit/);
  assert.doesNotMatch(patched, /wrapper-update-pending/);
  assert.doesNotMatch(patched, /wrapper_status/);
});

test("main bundle helper does not shadow minified module variables", () => {
  const source =
    `"use strict";var p=require("node:fs"),u=require("node:path"),c=require("node:child_process");` +
    `var handlers={"native-desktop-apps":async()=>({ok:true})};`;

  const patched = applyMainBundlePatch(source);

  assert.match(patched, /codexLinuxWrapFs\(\)\.existsSync\(__codexWrapStatePath\)/);
  assert.match(patched, /codexLinuxWrapFs\(\)\.readFileSync\(__codexWrapStatePath,`utf8`\)/);
  assert.match(patched, /codexLinuxWrapFs\(\)\.mkdirSync\(codexLinuxWrapPath\(\)\.dirname\(__codexWrapMarkerPath\),\{recursive:!0\}\)/);
  assert.match(patched, /codexLinuxWrapFs\(\)\.writeFileSync\(__codexWrapMarkerPath,__codexWrapGeneration/);
  assert.match(patched, /codexLinuxWrapFs\(\)\.writeFileSync\(__codexWrapRestartIntentPath,__codexWrapGeneration/);
  assert.match(patched, /let __codexWrapCheckProcess=codexLinuxWrapChildProcess\(\)\.spawn\(/);
  assert.doesNotMatch(patched, /let p=codexLinuxWrapStatePath\(\)/);
  assert.doesNotMatch(patched, /let c=c\.spawn\(/);
  assert.doesNotMatch(patched, /__codexChild/);
});

test("webview runtime renders dev-mode and installed-sha chips", () => {
  const patched = applyWebviewRuntimePatch("console.log('codex');");

  assert.match(patched, /codex-linux-wrapper-sha/);
  assert.match(patched, /installed_commit/);
  assert.match(patched, /dev-mode/);
  assert.match(patched, /\\u2699/);
  assert.match(patched, /\\u2193/);
  assert.match(patched, /Update and reopen ChatGPT Desktop for Linux/);
  assert.match(patched, /Update and reopen/);
  assert.match(patched, /Reopening\\u2026/);
});

test("webview runtime is not swallowed by a trailing sourcemap comment", () => {
  const patched = applyWebviewRuntimePatch("console.log('codex');\n//# sourceMappingURL=index.js.map");

  assert.match(patched, /sourceMappingURL=index\.js\.map\n;\(\(\)=>/);
  assert.doesNotMatch(patched, /sourceMappingURL=index\.js\.map;\(\(\)=>/);
});

test("settings patch adds wrapper update toggle", () => {
  const source =
    `var KEYS={autoUpdateOnExit:"codex-linux-auto-update-on-exit"};` +
    `function Settings(){return $.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close ChatGPT",description:"When on, a ready update waits for ChatGPT to close and then installs. When off, updates wait until you click Update."})})}`;

  const patched = applyWrapperUpdateSettingsPatch(source);

  assert.match(patched, /wrapperUpdates:"codex-linux-wrapper-updates-enabled"/);
  assert.match(patched, /featurePickerOnUpdate:"codex-linux-feature-picker-on-update"/);
  assert.match(patched, /Check for ChatGPT Desktop for Linux updates/);
  assert.match(patched, /Ask which features to enable on update/);
  assert.equal(applyWrapperUpdateSettingsPatch(patched), patched);
});

test("settings asset patch does not fall back to legacy settings bundles", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-legacy-settings-"));
  const assetsDir = path.join(appDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const generalSettings = `function Br(){return null}`;
  const keybindsSettings = `var KEYS={autoUpdateOnExit:"codex-linux-auto-update-on-exit"};`;
  fs.writeFileSync(path.join(assetsDir, "general-settings-z.js"), generalSettings);
  fs.writeFileSync(path.join(assetsDir, "keybinds-settings-linux.js"), keybindsSettings);

  try {
    assert.deepEqual(patchWrapperUpdateSettingsAssets(appDir), {
      matched: false,
      changed: 0,
      reason: "linux-desktop-settings-linux.js is not present",
    });
    assert.equal(fs.readFileSync(path.join(assetsDir, "general-settings-z.js"), "utf8"), generalSettings);
    assert.equal(fs.readFileSync(path.join(assetsDir, "keybinds-settings-linux.js"), "utf8"), keybindsSettings);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("settings asset patch prefers generated Linux desktop settings bundle", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-linux-desktop-settings-"));
  const assetsDir = path.join(appDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const linuxDesktopSettings =
    `var KEYS={autoUpdateOnExit:"codex-linux-auto-update-on-exit"};` +
    `function Settings(){return $.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close ChatGPT",description:"When on, a ready update waits for ChatGPT to close and then installs. When off, updates wait until you click Update."})})}`;
  const generalSettings = `function Br(){return null}`;
  fs.writeFileSync(path.join(assetsDir, "linux-desktop-settings-linux.js"), linuxDesktopSettings);
  fs.writeFileSync(path.join(assetsDir, "general-settings-z.js"), generalSettings);

  try {
    assert.deepEqual(patchWrapperUpdateSettingsAssets(appDir), { matched: true, changed: 1 });
    assert.deepEqual(patchWrapperUpdateSettingsAssets(appDir), { matched: true, changed: 0 });
    assert.match(
      fs.readFileSync(path.join(assetsDir, "linux-desktop-settings-linux.js"), "utf8"),
      /Check for ChatGPT Desktop for Linux updates/,
    );
    assert.equal(
      fs.readFileSync(path.join(assetsDir, "general-settings-z.js"), "utf8"),
      generalSettings,
    );
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("settings asset patch leaves current asset unchanged on synthetic drift", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-settings-drift-"));
  const assetsDir = path.join(appDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const driftedSettings = `var KEYS={autoUpdateOnExit:"codex-linux-auto-update-on-exit"};function Settings(){return null}`;
  const settingsPath = path.join(assetsDir, "linux-desktop-settings-linux.js");
  fs.writeFileSync(settingsPath, driftedSettings);

  try {
    assert.deepEqual(withoutWarnings(() => patchWrapperUpdateSettingsAssets(appDir)), {
      matched: false,
      changed: 0,
      reason: "could not find Linux update toggle",
    });
    assert.equal(fs.readFileSync(settingsPath, "utf8"), driftedSettings);
  } finally {
    fs.rmSync(appDir, { recursive: true, force: true });
  }
});

test("feature exposes optional patches and declarative apply hooks when enabled", () => {
  withTempFeatureConfig(["codex-wrapper-updater"], () => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot }), ["codex-wrapper-updater"]);
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .filter((descriptor) => descriptor.id.startsWith("feature:codex-wrapper-updater:"))
        .map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [
        ["feature:codex-wrapper-updater:main-handler", "main-bundle", "optional"],
        ["feature:codex-wrapper-updater:webview-runtime", "webview-asset", "optional"],
        ["feature:codex-wrapper-updater:settings-toggle", "extracted-app:post-webview", "optional"],
      ],
    );

    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-app-"));
    try {
      const plan = stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      assert.deepEqual(
        plan.runtimeHooks.map((hook) => [hook.key, hook.target, hook.mode.toString(8)]),
        [
          ["prelaunch", ".codex-linux/prelaunch.d/codex-wrapper-updater-apply-pending.sh", "755"],
          ["afterExit", ".codex-linux/after-exit.d/codex-wrapper-updater-apply-pending.sh", "755"],
        ],
      );
      assert.equal(
        fs.existsSync(
          path.join(appDir, ".codex-linux", "prelaunch.d", "codex-wrapper-updater-apply-pending.sh"),
        ),
        true,
      );
      assert.equal(
        fs.existsSync(
          path.join(appDir, ".codex-linux", "after-exit.d", "codex-wrapper-updater-apply-pending.sh"),
        ),
        true,
      );
      assert.equal(
        fs.existsSync(path.join(appDir, ".codex-linux", "env.d", "codex-wrapper-updater-wrapper-updater.env")),
        false,
      );
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("apply hook clears a generation marker on success", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const manager = fakeManager(temp);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, `${GENERATION}\n`);

  const env = {
    ...process.env,
    CODEX_LINUX_APP_STATE_DIR: temp,
    CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
    CODEX_UPDATE_MANAGER_PATH: manager,
  };

  const succeeded = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env,
    encoding: "utf8",
  });
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test("after-exit relaunch requires a matching generation-bound restart intent", () => {
  for (const { intent, exitStatus, expectedStatus } of [
    { intent: GENERATION, exitStatus: "0", expectedStatus: 85 },
    { intent: null, exitStatus: "0", expectedStatus: 0 },
    { intent: "b".repeat(40), exitStatus: "0", expectedStatus: 0 },
    { intent: GENERATION, exitStatus: "1", expectedStatus: 0 },
  ]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-intent-"));
    const markerDir = path.join(temp, "codex-wrapper-updater");
    const marker = path.join(markerDir, "pending");
    const restartIntent = path.join(markerDir, "restart-intent");
    const manager = fakeManager(temp);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, `${GENERATION}\n`);
    if (intent != null) fs.writeFileSync(restartIntent, `${intent}\n`);

    const result = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
      env: {
        ...process.env,
        CODEX_LINUX_APP_STATE_DIR: temp,
        CODEX_LINUX_FEATURE_HOOK_PHASE: "after-exit",
        CODEX_LINUX_ELECTRON_EXIT_STATUS: exitStatus,
        CODEX_UPDATE_MANAGER_PATH: manager,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, expectedStatus, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(restartIntent), false);
    if (expectedStatus === 85) {
      assert.match(result.stdout, /requesting relaunch after all after-exit hooks complete/);
    } else {
      assert.doesNotMatch(result.stdout, /requesting relaunch/);
    }
  }
});

test("matching Update and reopen intent is consumed exactly once", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-once-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const restartIntent = path.join(markerDir, "restart-intent");
  const managerLog = path.join(temp, "manager.log");
  const manager = fakeManager(
    temp,
    'printf "%s\\n" "$*" >> "$CODEX_TEST_MANAGER_LOG"\nexit 0\n',
  );
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, `${GENERATION}\n`);
  fs.writeFileSync(restartIntent, `${GENERATION}\n`);

  const env = {
    ...process.env,
    CODEX_LINUX_APP_STATE_DIR: temp,
    CODEX_LINUX_FEATURE_HOOK_PHASE: "after-exit",
    CODEX_LINUX_ELECTRON_EXIT_STATUS: "0",
    CODEX_UPDATE_MANAGER_PATH: manager,
    CODEX_TEST_MANAGER_LOG: managerLog,
  };
  const first = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env,
    encoding: "utf8",
  });
  const second = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env,
    encoding: "utf8",
  });

  assert.equal(first.status, 85, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    fs.readFileSync(managerLog, "utf8"),
    `apply-wrapper-update --expected-generation ${GENERATION}\n`,
  );
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.existsSync(restartIntent), false);
});

test("service-owned wrapper apply runs in the maintenance slice", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-slice-"));
  const binDir = path.join(temp, "bin");
  const markerDir = path.join(temp, "state", "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const managerLog = path.join(temp, "manager.log");
  const systemdRunLog = path.join(temp, "systemd-run.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, `${GENERATION}\n`);

  const systemctl = path.join(binDir, "systemctl");
  fs.writeFileSync(systemctl, "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(systemctl, 0o755);
  const systemdRun = path.join(binDir, "systemd-run");
  fs.writeFileSync(
    systemdRun,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$CODEX_TEST_SYSTEMD_RUN_LOG"\nwhile [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\n[ "$#" -eq 0 ] || shift\nexec "$@"\n`,
  );
  fs.chmodSync(systemdRun, 0o755);
  const manager = fakeManager(
    temp,
    'printf "%s\\n" "$*" > "$CODEX_TEST_MANAGER_LOG"\nexit 0\n',
  );

  const result = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      CODEX_LINUX_APP_STATE_DIR: path.join(temp, "state"),
      CODEX_LINUX_FEATURE_HOOK_PHASE: "after-exit",
      CODEX_LINUX_ELECTRON_EXIT_STATUS: "0",
      CODEX_LINUX_SYSTEMD_SERVICE: "1",
      CODEX_UPDATE_MANAGER_PATH: manager,
      CODEX_TEST_MANAGER_LOG: managerLog,
      CODEX_TEST_SYSTEMD_RUN_LOG: systemdRunLog,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const systemdArgs = fs.readFileSync(systemdRunLog, "utf8");
  assert.match(systemdArgs, /--unit=codex-wrapper-update-apply/);
  assert.match(systemdArgs, /--scope/);
  assert.match(systemdArgs, /--slice=codex-maintenance\.slice/);
  assert.match(systemdArgs, /--nice=10/);
  assert.match(systemdArgs, /--setenv=CARGO_BUILD_JOBS=2/);
  assert.equal(
    fs.readFileSync(managerLog, "utf8"),
    `apply-wrapper-update --expected-generation ${GENERATION}\n`,
  );
});

test("failed and invalid generations are quarantined without relaunch", () => {
  for (const { markerBody, managerStatus, reason } of [
    { markerBody: `${GENERATION}\n`, managerStatus: "42", reason: /apply failed/ },
    { markerBody: "legacy timestamp\n", managerStatus: "0", reason: /invalid-generation/ },
  ]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-quarantine-"));
    const markerDir = path.join(temp, "codex-wrapper-updater");
    const marker = path.join(markerDir, "pending");
    const restartIntent = path.join(markerDir, "restart-intent");
    const manager = fakeManager(temp);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, markerBody);
    fs.writeFileSync(restartIntent, `${GENERATION}\n`);

    const result = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
      env: {
        ...process.env,
        CODEX_LINUX_APP_STATE_DIR: temp,
        CODEX_LINUX_FEATURE_HOOK_PHASE: "after-exit",
        CODEX_LINUX_ELECTRON_EXIT_STATUS: "0",
        CODEX_UPDATE_MANAGER_PATH: manager,
        CODEX_FAKE_MANAGER_STATUS: managerStatus,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(restartIntent), false);
    assert.match(result.stdout, reason);
    assert.equal(fs.readdirSync(path.join(markerDir, "quarantine")).length, 1);
    assert.doesNotMatch(result.stdout, /requesting relaunch/);
  }
});

test("apply hook bounds slow prelaunch apply and preserves marker", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-timeout-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const manager = fakeManager(temp, "sleep 3\nexit 0\n");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, `${GENERATION}\n`);

  const started = Date.now();
  const result = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env: {
      ...process.env,
      CODEX_LINUX_APP_STATE_DIR: temp,
      CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
      CODEX_UPDATE_MANAGER_PATH: manager,
      CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS: "1",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), true);
  assert.match(result.stdout, /prelaunch wrapper update apply timed out after 1s/);
  assert.ok(Date.now() - started < 2500, "prelaunch apply should be bounded by timeout");
});

test("apply hook keeps invalid and capped prelaunch timeout values numeric", () => {
  for (const { value, stderrNeedle } of [
    {
      value: "bad",
      stderrNeedle: /invalid CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS='bad'; using 5/,
    },
    {
      value: "999",
      stderrNeedle: /CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS=999 is too high; using 300/,
    },
  ]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-timeout-value-"));
    const markerDir = path.join(temp, "codex-wrapper-updater");
    const marker = path.join(markerDir, "pending");
    const managerLog = path.join(temp, "manager.log");
    const manager = fakeManager(
      temp,
      'echo "manager-ran" >> "$CODEX_TEST_MANAGER_LOG"\nexit 0\n',
    );
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(marker, `${GENERATION}\n`);

    const result = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
      env: {
        ...process.env,
        CODEX_LINUX_APP_STATE_DIR: temp,
        CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
        CODEX_UPDATE_MANAGER_PATH: manager,
        CODEX_WRAPPER_UPDATER_PRELAUNCH_TIMEOUT_SECONDS: value,
        CODEX_TEST_MANAGER_LOG: managerLog,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, stderrNeedle);
    assert.doesNotMatch(result.stderr, /integer expression expected|syntax error: operand expected/);
    assert.equal(fs.readFileSync(managerLog, "utf8"), "manager-ran\n");
    assert.equal(fs.existsSync(marker), false);
  }
});

test("apply hook resolves marker from sanitized app id when app state dir is absent", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-xdg-"));
  const markerDir = path.join(temp, "codex-cua-lab", "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const manager = fakeManager(temp);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, `${GENERATION}\n`);

  const result = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env: {
      ...process.env,
      CODEX_LINUX_APP_ID: "codex-cua-lab",
      CODEX_LINUX_APP_STATE_DIR: "",
      CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
      CODEX_UPDATE_MANAGER_PATH: manager,
      XDG_STATE_HOME: temp,
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test("apply hook lock keeps marker without running manager", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-guard-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const invoked = path.join(temp, "manager-invoked");
  const manager = fakeManager(temp, `touch ${JSON.stringify(invoked)}\nexit 0\n`);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, `${GENERATION}\n`);

  const env = {
    ...process.env,
    CODEX_LINUX_APP_STATE_DIR: temp,
    CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
    CODEX_UPDATE_MANAGER_PATH: manager,
  };

  fs.mkdirSync(path.join(markerDir, "apply.lock"));
  const locked = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env,
    encoding: "utf8",
  });
  assert.equal(locked.status, 0, locked.stderr);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(invoked), false);
});
