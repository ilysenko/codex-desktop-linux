"use strict";

const linuxSettingsKeys = {
  readAloud: "codex-linux-read-aloud-enabled",
  readAloudKokoroSpeed: "codex-linux-read-aloud-kokoro-speed",
  promptWindow: "codex-linux-prompt-window-enabled",
  systemTray: "codex-linux-system-tray-enabled",
  warmStart: "codex-linux-warm-start-enabled",
  autoUpdateOnExit: "codex-linux-auto-update-on-exit",
  wrapperUpdates: "codex-linux-wrapper-updates-enabled",
  featurePickerOnUpdate: "codex-linux-feature-picker-on-update",
};

const keybindsSettingsAsset = "keybinds-settings-linux.js";
const linuxKeybindOverridesKey = "codex-linux-keybind-overrides";

const COMPUTER_USE_UI_ENV_VAR = "CODEX_LINUX_ENABLE_COMPUTER_USE_UI";
const COMPUTER_USE_UI_SETTINGS_KEY = "codex-linux-computer-use-ui-enabled";

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  keybindsSettingsAsset,
  linuxKeybindOverridesKey,
  linuxSettingsKeys,
};
