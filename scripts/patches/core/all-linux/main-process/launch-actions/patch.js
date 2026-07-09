"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxTrayCloseSettingPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
} = require("../../../../impl/launch-actions.js");

module.exports = [
  mainBundlePatch({
    id: "linux-tray-close-setting",
    phase: "main-bundle",
    order: 200,
    ciPolicy: "optional",
    apply: applyLinuxTrayCloseSettingPatch,
  }),
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
