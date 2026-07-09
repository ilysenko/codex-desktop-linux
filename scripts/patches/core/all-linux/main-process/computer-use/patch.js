"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxComputerUseFeaturePatch,
  applyLinuxNativeDesktopAppsHandlerPatch,
  applyLinuxComputerUsePluginGatePatch,
} = require("../../../../impl/computer-use.js");

module.exports = [
  mainBundlePatch({
    id: "linux-computer-use-ui-feature",
    phase: "main-bundle",
    order: 130,
    ciPolicy: "opt-in",
    enabled: (context) => context.enableComputerUseUi,
    apply: applyLinuxComputerUseFeaturePatch,
  }),
  mainBundlePatch({
    id: "linux-computer-use-plugin-gate",
    phase: "main-bundle",
    order: 140,
    ciPolicy: "optional",
    apply: applyLinuxComputerUsePluginGatePatch,
  }),
  mainBundlePatch({
    id: "linux-computer-use-native-desktop-apps",
    phase: "main-bundle",
    order: 150,
    ciPolicy: "opt-in",
    enabled: (context) => context.enableComputerUseUi,
    apply: applyLinuxNativeDesktopAppsHandlerPatch,
  }),
];
