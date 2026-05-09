#!/usr/bin/env node
"use strict";

const {
  createPatchReport,
  writePatchReport,
} = require("./lib/patch-report.js");
const {
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  patchLinuxAppUpdaterBridge,
} = require("./lib/linux-update-bridge-patch.js");
const {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  isComputerUseUiEnabled,
} = require("./patches/computer-use.js");
const {
  applyKeybindsSettingsIndexPatch,
  applyKeybindsSettingsSectionsPatch,
  applyKeybindsSettingsSharedPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  patchKeybindsSettingsAssets,
  resolveKeybindsSettingsAsset,
} = require("./patches/keybinds-settings.js");
const {
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxTrayCloseSettingPatch,
} = require("./patches/launch-actions.js");
const {
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWindowOptionsPatch,
} = require("./patches/main-process.js");
const {
  patchPackageJson,
  resolveDesktopName,
} = require("./patches/package-json.js");
const {
  patchExtractedApp,
  patchMainBundleSource,
} = require("./patches/registry.js");
const {
  applyBrowserAnnotationScreenshotPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  patchCommentPreloadBundle,
} = require("./patches/webview-assets.js");

function main() {
  const args = process.argv.slice(2);
  let reportJson = null;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--report-json") {
      reportJson = args[index + 1];
      if (!reportJson) {
        console.error("Usage: patch-linux-window-ui.js [--report-json path] <extracted-app-asar-dir>");
        process.exit(1);
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: patch-linux-window-ui.js [--report-json path] <extracted-app-asar-dir>");
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  const extractedDir = positional[0];

  if (!extractedDir || positional.length > 1) {
    console.error("Usage: patch-linux-window-ui.js [--report-json path] <extracted-app-asar-dir>");
    process.exit(1);
  }

  const report = reportJson == null ? null : createPatchReport();
  patchExtractedApp(extractedDir, { report });
  writePatchReport(reportJson, report);
}

if (require.main === module) {
  main();
}

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyBrowserAnnotationScreenshotPatch,
  applyBrowserUseNodeReplApprovalPatch,
  applyKeybindsSettingsIndexPatch,
  applyKeybindsSettingsSectionsPatch,
  applyKeybindsSettingsSharedPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxSetIconPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayCloseSettingPatch,
  applyLinuxTrayPatch,
  applyLinuxWindowOptionsPatch,
  createPatchReport,
  isComputerUseUiEnabled,
  patchCommentPreloadBundle,
  patchExtractedApp,
  patchKeybindsSettingsAssets,
  patchLinuxAppUpdaterBridge,
  patchMainBundleSource,
  patchPackageJson,
  resolveDesktopName,
  resolveKeybindsSettingsAsset,
};
