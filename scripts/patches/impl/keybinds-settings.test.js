"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  patchWrapperUpdateSettingsAssets,
} = require("../../../linux-features/codex-wrapper-updater/patch.js");
const {
  linuxDesktopSettingsAsset,
  patchKeybindsSettingsAssets,
} = require("./keybinds-settings.js");
const {
  createModernNativeKeyboardShortcutsSettingsFixture,
} = require("../test-fixtures/current-dmg.js");

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function assetSources(assetsDir) {
  return new Map(
    fs.readdirSync(assetsDir).map((name) => [
      name,
      fs.readFileSync(path.join(assetsDir, name), "utf8"),
    ]),
  );
}

test("preserves wrapper updater extensions across Linux settings patch passes", () => {
  const { extractedDir, assetsDir } =
    createModernNativeKeyboardShortcutsSettingsFixture();
  try {
    const firstCoreResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(firstCoreResult.matched, true);

    const settingsPath = path.join(assetsDir, linuxDesktopSettingsAsset);
    assert.match(
      fs.readFileSync(settingsPath, "utf8"),
      /var codexLinuxDesktopSettingsVersion=1,KEYS=\{/,
    );

    const firstFeatureResult = patchWrapperUpdateSettingsAssets(extractedDir);
    assert.deepEqual(firstFeatureResult, { matched: true, changed: 1 });
    const composedSource = fs.readFileSync(settingsPath, "utf8");
    assert.match(
      composedSource,
      /wrapperUpdates:"codex-linux-wrapper-updates-enabled"/,
    );
    assert.match(
      composedSource,
      /featurePickerOnUpdate:"codex-linux-feature-picker-on-update"/,
    );

    const secondCoreResult = patchKeybindsSettingsAssets(extractedDir);
    assert.equal(secondCoreResult.matched, true);
    assert.equal(secondCoreResult.changed, 0);
    assert.equal(fs.readFileSync(settingsPath, "utf8"), composedSource);

    assert.deepEqual(
      patchWrapperUpdateSettingsAssets(extractedDir),
      { matched: true, changed: 0 },
    );
    assert.equal(fs.readFileSync(settingsPath, "utf8"), composedSource);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

for (const [name, damage] of [
  [
    "rejects incomplete generated Linux settings markers without writing assets",
    (source) =>
      source.replace(
        "codexLinuxDesktopSettingsVersion=1",
        "codexLinuxDesktopSettingsVersion=2",
      ),
  ],
  [
    "rejects truncated generated Linux settings source without writing assets",
    (source) => source.slice(0, source.indexOf("KEYS={") + "KEYS={".length),
  ],
  ...[
    "promptWindow",
    "systemTray",
    "warmStart",
    "autoUpdateOnExit",
  ].map((key) => [
    `rejects generated Linux settings without the ${key} control`,
    (source) =>
      source.replace(
        `settingKey:KEYS.${key}`,
        `settingKey:MISSING.${key}`,
      ),
  ]),
  [
    "rejects generated Linux settings without the build info panel consumer",
    (source) =>
      source.replace(
        "$.jsx(LinuxBuildInfoPanel,{})",
        '$.jsx("div",{})',
      ),
  ],
  [
    "rejects generated Linux settings without the build info panel owner",
    (source) =>
      source.replace(
        "class LinuxBuildInfoPanel extends React.Component",
        "class LinuxBuildInfoPanelMissing extends React.Component",
      ),
  ],
]) {
  test(name, () => {
    const { extractedDir, assetsDir } =
      createModernNativeKeyboardShortcutsSettingsFixture();
    try {
      assert.equal(patchKeybindsSettingsAssets(extractedDir).matched, true);
      const settingsPath = path.join(assetsDir, linuxDesktopSettingsAsset);
      fs.writeFileSync(
        settingsPath,
        damage(fs.readFileSync(settingsPath, "utf8")),
        "utf8",
      );
      const before = assetSources(assetsDir);

      const { value: result, warnings } = captureWarns(() =>
        patchKeybindsSettingsAssets(extractedDir),
      );

      assert.equal(result.matched, false);
      assert.equal(result.changed, 0);
      assert.match(
        result.reason,
        /generated Linux desktop settings marker is stale or incomplete/,
      );
      assert.ok(
        warnings.some((warning) =>
          warning.includes(
            "generated Linux desktop settings marker is stale or incomplete",
          ),
        ),
      );
      assert.deepEqual(assetSources(assetsDir), before);
    } finally {
      fs.rmSync(extractedDir, { recursive: true, force: true });
    }
  });
}
