#!/usr/bin/env node
"use strict";

const {
  createPatchReport,
  criticalFailuresFromReport,
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
  applyLinuxChromeNativeHostRuntimePatch,
  applyLinuxChromePluginAutoInstallPatch,
  patchLinuxChromeNativeHostRuntimeAssets,
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
  applyLinuxDesktopSettingsIndexPatch,
  applyLinuxDesktopSettingsSectionsPatch,
  applyLinuxDesktopSettingsSharedPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  patchKeybindsSettingsAssets,
  resolveLinuxDesktopSettingsAsset,
  resolveKeybindsSettingsAsset,
} = require("./patches/keybinds-settings.js");
const {
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxTrayCloseSettingPatch,
} = require("./patches/launch-actions.js");
const {
  applyLinuxProjectlessXdgDocumentsDirPatch,
  patchProjectlessDocumentsAssets,
} = require("./patches/projectless-documents.js");
const {
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxAboutDialogPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxWorkerFileManagerPatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxLocalAppServerFeatureEnablementHandlerPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxOwlFeatureBindingFallbackPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
  applyLinuxXdgDocumentsDirPatch,
  patchLinuxOwlFeatureBindingFallbackAssets,
  patchLinuxWorkerFileManagerTarget,
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
  applyLinuxBrowserUseAvailabilityPatch,
  applyLinuxBrowserUseExternalAvailabilityPatch,
  applyLinuxBrowserUseNonLocalNavigationPatch,
  applyLinuxConfigWriteVersionConflictPatch,
  applyLinuxI18nGatePatch,
  applyLinuxAppServerBackfillWaitPatch,
  applyLinuxProfileSettingsMenuPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxFastModeModelGuardPatch,
  applySubagentNicknameMetadataPatch,
  patchCommentPreloadBundle,
} = require("./patches/webview-assets.js");

const USAGE = "Usage: patch-linux-window-ui.js [--report-json path] [--enforce-critical] <extracted-app-asar-dir>";

function main() {
  const args = process.argv.slice(2);
  let reportJson = null;
  let enforceCritical = false;
  const positional = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--report-json") {
      reportJson = args[index + 1];
      if (!reportJson) {
        console.error(USAGE);
        process.exit(1);
      }
      index += 1;
    } else if (arg === "--enforce-critical") {
      enforceCritical = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }

  const extractedDir = positional[0];

  if (!extractedDir || positional.length > 1) {
    console.error(USAGE);
    process.exit(1);
  }

  // Enforcement needs the report data even when no --report-json was requested.
  const report = reportJson == null && !enforceCritical ? null : createPatchReport();
  patchExtractedApp(extractedDir, { report });
  // Write the report before gating so CI artifact upload sees it even on failure.
  writePatchReport(reportJson, report);

  if (enforceCritical) {
    const failures = criticalFailuresFromReport(report);
    if (failures.length > 0) {
      console.error(`Critical patch failures (${failures.length}):`);
      for (const failure of failures) {
        console.error(`  - ${failure.name} (${failure.status})${failure.reason ? `: ${failure.reason}` : ""}`);
      }
      console.error(
        "Aborting: these patches are required for a working Linux app. " +
          "Set CODEX_ENFORCE_CRITICAL_PATCHES=0 to bypass (emergency builds only).",
      );
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main();
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
  applyLinuxDesktopSettingsIndexPatch,
  applyLinuxDesktopSettingsSectionsPatch,
  applyLinuxDesktopSettingsSharedPatch,
  applyLinuxAboutDialogPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  applyLinuxAppServerBackfillWaitPatch,
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyLinuxBrowserUseAvailabilityPatch,
  applyLinuxBrowserUseExternalAvailabilityPatch,
  applyLinuxBrowserUseNonLocalNavigationPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxChromeNativeHostRuntimePatch,
  applyLinuxChromePluginAutoInstallPatch,
  applyLinuxConfigWriteVersionConflictPatch,
  applyLinuxI18nGatePatch,
  applyLinuxProfileSettingsMenuPatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxWorkerFileManagerPatch,
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxKeybindOverridesRuntimePatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxLocalAppServerFeatureEnablementHandlerPatch,
  applyLinuxProjectlessXdgDocumentsDirPatch,
  applyLinuxMultiInstanceBootstrapPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxOwlFeatureBindingFallbackPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxFastModeModelGuardPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSetIconPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayCloseSettingPatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
  applyLinuxXdgDocumentsDirPatch,
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
  patchLinuxChromeNativeHostRuntimeAssets,
  patchLinuxOwlFeatureBindingFallbackAssets,
  patchLinuxWorkerFileManagerTarget,
  patchProjectlessDocumentsAssets,
  patchMainBundleSource,
  patchPackageJson,
  resolveDesktopName,
  resolveLinuxDesktopSettingsAsset,
  resolveKeybindsSettingsAsset,
};
