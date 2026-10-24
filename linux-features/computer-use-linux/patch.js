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
  applyNativeSettingsAvailabilityPatch,
  applyNativeSettingsVisibilityPatch,
  matchesNativeSettingsVisibilityContract,
} = require("./settings.js");
const { applyUnifiedComputerUsePatch } = require("./unified.js");

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
  webviewAssetPatch({
    id: "ui-availability",
    phase: "webview-asset",
    order: 20_140,
    ciPolicy: "optional",
    pattern: /^computer-use-settings-[^.]+\.js$/,
    missingDescription: "Computer Use availability bundle",
    skipDescription: "Linux Computer Use UI availability patch",
    apply: applyNativeSettingsAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "host-platform",
    phase: "webview-asset",
    order: 20_150,
    ciPolicy: "optional",
    pattern: /^[A-Za-z0-9_-]+\.js$/,
    assetMatch: matchesLinuxComputerUseHostPlatformContract,
    missingDescription: "current Computer Use host-platform contract",
    skipDescription: "Linux Computer Use host-platform patch",
    apply: applyLinuxComputerUseHostPlatformPatch,
  }),
  webviewAssetPatch({
    id: "native-settings-visibility",
    order: 20_160,
    pattern: /^[A-Za-z0-9_-]+\.js$/,
    assetMatch: matchesNativeSettingsVisibilityContract,
    missingDescription: "Plugins presentation filter",
    skipDescription: "Linux native Settings visibility patch",
    apply: applyNativeSettingsVisibilityPatch,
  }),
];
