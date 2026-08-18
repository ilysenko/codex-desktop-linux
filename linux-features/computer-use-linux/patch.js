"use strict";

const { mainBundlePatch, webviewAssetPatch } = require("../../scripts/patches/descriptor.js");
const {
  applyLinuxComputerUseAvatarCursorBridgePatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseHostPlatformPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxNativeDesktopAppsHandlerPatch,
  matchesLinuxComputerUseHostPlatformContract,
} = require("../../scripts/patches/impl/computer-use.js");

module.exports = [
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
    id: "native-desktop-apps",
    phase: "main-bundle",
    order: 20_130,
    ciPolicy: "optional",
    apply: applyLinuxNativeDesktopAppsHandlerPatch,
  }),
  webviewAssetPatch({
    id: "ui-availability",
    phase: "webview-asset",
    order: 20_140,
    ciPolicy: "optional",
    pattern: /^computer-use-settings-[^.]+\.js$/,
    missingDescription: "Computer Use availability bundle",
    skipDescription: "Linux Computer Use UI availability patch",
    apply: applyLinuxComputerUseRendererAvailabilityPatch,
  }),
  webviewAssetPatch({
    id: "host-platform",
    phase: "webview-asset",
    order: 20_150,
    ciPolicy: "optional",
    pattern: /^app-initial-[^.]+\.js$/,
    assetMatch: matchesLinuxComputerUseHostPlatformContract,
    missingDescription: "current Computer Use host-platform app-initial contract",
    skipDescription: "Linux Computer Use host-platform patch",
    apply: applyLinuxComputerUseHostPlatformPatch,
  }),
];
