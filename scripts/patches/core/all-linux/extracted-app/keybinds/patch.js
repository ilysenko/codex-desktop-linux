"use strict";

const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const { patchKeybindsSettingsAssets } = require("../../../../impl/keybinds-settings.js");

module.exports = [
  extractedAppPatch({
    id: "keybinds-settings",
    phase: "extracted-app:post-webview",
    order: 2030,
    ciPolicy: "optional",
    apply: (extractedDir) => patchKeybindsSettingsAssets(extractedDir),
    status: (result, warnings) => ({
      status: result?.changed
        ? "applied"
        : result?.matched
          ? "already-applied"
          : "skipped-optional",
      reason: result?.reason ?? warnings[0] ?? null,
    }),
  }),
];
