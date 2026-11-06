"use strict";

const { applyLinuxComputerUsePluginGatePatch } = require("./plugin-gate.js");

const { mainBundlePatch, webviewAssetPatch, extractedAppPatch, PHASE_EXTRACTED_APP_POST_WEBVIEW } = require("../../scripts/patches/descriptor.js");
const {
  applyLinuxComputerUseAvatarCursorBridgePatch,
  applyLinuxComputerUseFeaturePatch,
} = require("../../scripts/patches/impl/computer-use.js");

const {
  NATIVE_SETTINGS_VISIBILITY_NEEDLES,
  applyNativeSettingsAvailabilityPatch,
  applyNativeSettingsVisibilityAssets,
} = require("./settings.js");
const { patchUnifiedComputerUseAssets } = require("./unified.js");
const { applyNativeApplicationsPatch } = require("./native-applications.js");
const { applyLinuxComputerUseHostPlatformPatch, matchesLinuxComputerUseHostPlatformContract } = require("./host-platform.js");

module.exports = [
  extractedAppPatch({
    id: "unified-runtime",
    phase: "extracted-app:pre-webview",
    order: 20_115,
    apply: patchUnifiedComputerUseAssets,
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
  extractedAppPatch({
    id: "native-settings-visibility",
    phase: PHASE_EXTRACTED_APP_POST_WEBVIEW,
    order: 20_160,
    assetNeedles: NATIVE_SETTINGS_VISIBILITY_NEEDLES,
    apply: applyNativeSettingsVisibilityAssets,
  }),
];
