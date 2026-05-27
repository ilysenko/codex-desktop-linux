#!/usr/bin/env node
"use strict";

const {
  createPatchReport,
  writePatchReport,
} = require("./lib/patch-report.js");
const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureStageHooks,
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
  loadLinuxFeatureMainBundlePatches,
} = require("./lib/linux-features.js");
const {
  detectLinuxTargetContext,
  linuxTargetSummary,
  parseOsRelease,
} = require("./lib/linux-target-context.js");
const {
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  patchLinuxAppUpdaterBridge,
} = require("./lib/linux-update-bridge-patch.js");
const {
  applyLinuxMultiInstanceBootstrapPatch,
  patchLinuxMultiInstanceBootstrap,
} = require("./patches/bootstrap.js");
const {
  applyAutomationScheduleMultiTimePatch,
  patchAutomationScheduleAssets,
} = require("./patches/automation-schedule.js");
const {
  applyLinuxChromePluginAutoInstallPatch,
} = require("./patches/chrome-plugin.js");
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
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
} = require("./patches/main-process.js");
const {
  applyLinuxAvatarOverlayMousePassthroughPatch,
} = require("./patches/avatar-overlay.js");
const {
  patchPackageJson,
  resolveDesktopName,
} = require("./patches/package-json.js");
const {
  discoverCorePatchDescriptors,
  normalizePatchDescriptors,
} = require("./patches/engine.js");
const {
  corePatchDescriptors,
  createMainBundleContext,
  legacyCorePatchDescriptors,
  patchExtractedApp,
  patchMainBundleSource,
} = require("./patches/registry.js");
const {
  applyBrowserAnnotationScreenshotPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxFastModeModelGuardPatch,
  applySubagentNicknameMetadataPatch,
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

function applyLinuxBrowserUseIabVisibleOnCreatePatch(currentSource) {
  // Compatibility shim for old callers after the runtime patch was removed.
  return currentSource;
}

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyAutomationScheduleMultiTimePatch,
  applyBrowserAnnotationScreenshotPatch,
  applyBrowserUseNodeReplApprovalPatch,
  applyKeybindsSettingsIndexPatch,
  applyKeybindsSettingsSectionsPatch,
  applyKeybindsSettingsSharedPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyLinuxBrowserUseIabVisibleOnCreatePatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxChromePluginAutoInstallPatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxMenuPatch,
  applyLinuxMultiInstanceBootstrapPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxFastModeModelGuardPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSetIconPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayCloseSettingPatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
  applySubagentNicknameMetadataPatch,
  createPatchReport,
  corePatchDescriptors,
  createMainBundleContext,
  detectLinuxTargetContext,
  discoverCorePatchDescriptors,
  enabledLinuxFeatureIds,
  enabledLinuxFeatureStageHooks,
  isComputerUseUiEnabled,
  legacyCorePatchDescriptors,
  linuxTargetSummary,
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
  loadLinuxFeatureMainBundlePatches,
  normalizePatchDescriptors,
  parseOsRelease,
  patchCommentPreloadBundle,
  patchAutomationScheduleAssets,
  patchExtractedApp,
  patchKeybindsSettingsAssets,
  patchLinuxMultiInstanceBootstrap,
  patchLinuxAppUpdaterBridge,
  patchMainBundleSource,
  patchPackageJson,
  resolveDesktopName,
  resolveKeybindsSettingsAsset,
};
