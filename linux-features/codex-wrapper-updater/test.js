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
  applyWrapperUpdateGeneralSettingsPatch,
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
  assert.match(patched, /wrapper_dev_mode/);
  assert.match(patched, /installed_wrapper_commit/);
  assert.doesNotMatch(patched, /wrapper-update-pending/);
  assert.doesNotMatch(patched, /wrapper_status/);
});

test("webview runtime renders dev-mode and installed-sha chips", () => {
  const patched = applyWebviewRuntimePatch("console.log('codex');");

  assert.match(patched, /codex-linux-wrapper-sha/);
  assert.match(patched, /installed_commit/);
  assert.match(patched, /dev-mode/);
  assert.match(patched, /\\u2699/);
  assert.match(patched, /\\u2193/);
});

test("settings patch adds wrapper update toggle", () => {
  const source =
    `var KEYS={autoUpdateOnExit:"codex-linux-auto-update-on-exit"};` +
    `function Settings(){return $.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close Codex",description:"When on, a ready update waits for Codex to close and then installs. When off, updates wait until you click Update."})})}`;

  const patched = applyWrapperUpdateSettingsPatch(source);

  assert.match(patched, /wrapperUpdates:"codex-linux-wrapper-updates-enabled"/);
  assert.match(patched, /featurePickerOnUpdate:"codex-linux-feature-picker-on-update"/);
  assert.match(patched, /Check for Codex Desktop Linux updates/);
  assert.match(patched, /Ask which features to enable on update/);
  assert.equal(applyWrapperUpdateSettingsPatch(patched), patched);
});

test("general settings patch adds wrapper update toggles for current upstream settings", () => {
  const source =
    `function $n(){let D,k,A,j,M;e[16]===Symbol.for(\`react.memo_cache_sentinel\`)?(D=(0,$.jsx)(K,{electron:!0,children:(0,$.jsx)(Br,{})}),k=(0,$.jsx)(zr,{}),A=(0,$.jsx)(Hn,{}),j=(0,$.jsx)(Mr,{}),M=(0,$.jsx)(Pr,{}),e[16]=D,e[17]=k,e[18]=A,e[19]=j,e[20]=M):(D=e[16],k=e[17],A=e[18],j=e[19],M=e[20]);}` +
    `function Br(){return null}function Vr(e,t){return e}`;

  const patched = applyWrapperUpdateGeneralSettingsPatch(source);

  assert.match(patched, /CodexLinuxWrapperUpdatesSetting/);
  assert.match(patched, /CodexLinuxFeaturePickerOnUpdateSetting/);
  assert.match(patched, /codex-linux-wrapper-updates-enabled/);
  assert.match(patched, /codex-linux-feature-picker-on-update/);
  assert.match(patched, /Check for Codex Desktop Linux updates/);
  assert.match(patched, /Ask which features to enable on update/);
  assert.match(patched, /get-global-state/);
  assert.match(patched, /set-global-state/);
  assert.doesNotMatch(patched, /set-setting/);
  assert.match(
    patched,
    /children:\[\(0,\$\.jsx\)\(Br,\{\}\),\(0,\$\.jsx\)\(CodexLinuxWrapperUpdatesSetting,\{\}\),\(0,\$\.jsx\)\(CodexLinuxFeaturePickerOnUpdateSetting,\{\}\)\]/,
  );
  assert.equal(applyWrapperUpdateGeneralSettingsPatch(patched), patched);
});

test("settings asset patch skips re-exported general settings bundles", () => {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-settings-assets-"));
  const assetsDir = path.join(appDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, "general-settings-a.js"), `export{e as GeneralSettings};`);
  fs.writeFileSync(
    path.join(assetsDir, "general-settings-z.js"),
    `function $n(){let D,k,A,j,M;e[16]===Symbol.for(\`react.memo_cache_sentinel\`)?(D=(0,$.jsx)(K,{electron:!0,children:(0,$.jsx)(Br,{})}),k=(0,$.jsx)(zr,{}),A=(0,$.jsx)(Hn,{}),j=(0,$.jsx)(Mr,{}),M=(0,$.jsx)(Pr,{}),e[16]=D,e[17]=k,e[18]=A,e[19]=j,e[20]=M):(D=e[16],k=e[17],A=e[18],j=e[19],M=e[20]);}function Br(){return null}`,
  );

  try {
    assert.deepEqual(patchWrapperUpdateSettingsAssets(appDir), { matched: true, changed: 1 });
    assert.doesNotMatch(fs.readFileSync(path.join(assetsDir, "general-settings-a.js"), "utf8"), /WrapperUpdates/);
    assert.match(fs.readFileSync(path.join(assetsDir, "general-settings-z.js"), "utf8"), /Check for Codex Desktop Linux updates/);
    assert.match(fs.readFileSync(path.join(assetsDir, "general-settings-z.js"), "utf8"), /Ask which features to enable on update/);
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
    `function Settings(){return $.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close Codex",description:"When on, a ready update waits for Codex to close and then installs. When off, updates wait until you click Update."})})}`;
  const generalSettings = `function Br(){return null}`;
  fs.writeFileSync(path.join(assetsDir, "linux-desktop-settings-linux.js"), linuxDesktopSettings);
  fs.writeFileSync(path.join(assetsDir, "general-settings-z.js"), generalSettings);

  try {
    assert.deepEqual(patchWrapperUpdateSettingsAssets(appDir), { matched: true, changed: 1 });
    assert.match(
      fs.readFileSync(path.join(assetsDir, "linux-desktop-settings-linux.js"), "utf8"),
      /Check for Codex Desktop Linux updates/,
    );
    assert.equal(
      fs.readFileSync(path.join(assetsDir, "general-settings-z.js"), "utf8"),
      generalSettings,
    );
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

test("apply hook preserves marker on failure and clears it on success", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const manager = fakeManager(temp);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, "pending\n");

  const env = {
    ...process.env,
    CODEX_LINUX_APP_STATE_DIR: temp,
    CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
    CODEX_UPDATE_MANAGER_PATH: manager,
  };

  const failed = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env: { ...env, CODEX_FAKE_MANAGER_STATUS: "42" },
    encoding: "utf8",
  });
  assert.equal(failed.status, 0, failed.stderr);
  assert.equal(fs.existsSync(marker), true);

  const succeeded = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env,
    encoding: "utf8",
  });
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.equal(fs.existsSync(marker), false);
});

test("apply hook bounds slow prelaunch apply and preserves marker", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-timeout-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const manager = fakeManager(temp, "sleep 3\nexit 0\n");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, "pending\n");

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
    fs.writeFileSync(marker, "pending\n");

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
  fs.writeFileSync(marker, "pending\n");

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

test("apply hook skip guard and lock keep marker without running manager", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-wrapper-updater-guard-"));
  const markerDir = path.join(temp, "codex-wrapper-updater");
  const marker = path.join(markerDir, "pending");
  const invoked = path.join(temp, "manager-invoked");
  const manager = fakeManager(temp, `touch ${JSON.stringify(invoked)}\nexit 0\n`);
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(marker, "pending\n");

  const env = {
    ...process.env,
    CODEX_LINUX_APP_STATE_DIR: temp,
    CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
    CODEX_UPDATE_MANAGER_PATH: manager,
  };

  const skipped = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env: { ...env, CODEX_WRAPPER_UPDATER_SKIP_PRELAUNCH_ONCE: "1" },
    encoding: "utf8",
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(invoked), false);

  fs.mkdirSync(path.join(markerDir, "apply.lock"));
  const locked = spawnSync("bash", [path.join(featureDir, "apply-pending.sh")], {
    env,
    encoding: "utf8",
  });
  assert.equal(locked.status, 0, locked.stderr);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(fs.existsSync(invoked), false);
});
