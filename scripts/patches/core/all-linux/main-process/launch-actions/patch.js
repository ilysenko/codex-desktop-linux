"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxSettingsPersistencePatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
} = require("../../../../impl/launch-actions.js");

module.exports = [
  mainBundlePatch({
    id: "linux-settings-persistence",
    phase: "main-bundle",
    order: 210,
    ciPolicy: "optional",
    apply: applyLinuxSettingsPersistencePatch,
  }),
  mainBundlePatch({
    id: "linux-launch-actions",
    phase: "main-bundle",
    order: 220,
    ciPolicy: "optional",
    apply: applyLinuxLaunchActionArgsPatch,
  }),
  mainBundlePatch({
    id: "linux-hotkey-window-prewarm",
    phase: "main-bundle",
    order: 230,
    ciPolicy: "optional",
    apply: applyLinuxHotkeyWindowPrewarmPatch,
  }),
];
