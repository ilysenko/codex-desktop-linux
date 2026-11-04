"use strict";

const { applyLinuxComputerUsePluginGatePatch } = require("./plugin-gate.js");

const { mainBundlePatch, webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  applyLinuxComputerUseAvatarCursorBridgePatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseHostPlatformPatch,
  matchesLinuxComputerUseHostPlatformContract,
} = require("../../scripts/patches/impl/computer-use.js");

const {
  NATIVE_SETTINGS_VISIBILITY_NEEDLES,
  applyNativeSettingsAvailabilityPatch,
  applyNativeSettingsVisibilityPatch,
} = require("./settings.js");
const { applyUnifiedComputerUsePatch } = require("./unified.js");
const { applyNativeApplicationsPatch } = require("./native-applications.js");

module.exports = [
  mainBundlePatch({
    id: "unified-runtime",
    order: 20_115,
    apply: applyUnifiedComputerUsePatch,
  }),
  mainBundlePatch({
    id: "avatar-cursor",
    phase: "main-bundle",
    order: 20_100,
    ciPolicy: "optional",
    apply: applyLinuxComputerUseAvatarCursorBridgePatch,
  }),
  mainBundlePatch({
    id: "ui-feature",
    phase: "main-bundle",
    order: 20_110,
    ciPolicy: "optional",
    apply: applyLinuxComputerUseFeaturePatch,
  }),
  mainBundlePatch({
    id: "plugin-gate",
    phase: "main-bundle",
    order: 20_120,
    ciPolicy: "optional",
    apply: applyLinuxComputerUsePluginGatePatch,
  }),
  mainBundlePatch({
    id: "native-applications",
    order: 20_130,
    apply: applyNativeApplicationsPatch,
  }),
  webviewAssetPatch({
    id: "ui-availability",
    phase: "webview-asset",
    order: 20_140,
    ciPolicy: "optional",
    // The Settings → Computer use page owner.
    assetNeedles: ["settings.computerUse.subtitle", "computerUseAvailability:"],
    missingDescription: "Computer Use availability bundle",
    skipDescription: "Linux Computer Use UI availability patch",
    apply: applyNativeSettingsAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "host-platform",
    phase: "webview-asset",
    order: 20_150,
    ciPolicy: "optional",
    assetNeedles: ['featureName:"computer_use"', "isHostCompatiblePlatform:"],
    assetMatch: matchesLinuxComputerUseHostPlatformContract,
    missingDescription: "current Computer Use host-platform contract",
    skipDescription: "Linux Computer Use host-platform patch",
    apply: applyLinuxComputerUseHostPlatformPatch,
  }),
  webviewAssetPatch({
    id: "native-settings-visibility",
    order: 20_160,
    // rspack duplicates the Plugins presentation module into several lazy
    // chunks; every copy must hide the native component, so no assetMatch.
    assetNeedles: NATIVE_SETTINGS_VISIBILITY_NEEDLES,
    missingDescription: "Plugins presentation filter",
    skipDescription: "Linux native Settings visibility patch",
    apply: applyNativeSettingsVisibilityPatch,
  }),
];
