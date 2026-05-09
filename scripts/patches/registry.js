"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  captureWarnings,
  patchStatusFromChange,
  recordPatch,
} = require("../lib/patch-report.js");
const {
  applyLinuxAppUpdaterMenuPatch,
  patchLinuxAppUpdaterBridge,
} = require("../lib/linux-update-bridge-patch.js");
const {
  findIconAsset,
  findMainBundle,
  patchAssetFiles,
} = require("./shared.js");
const {
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWindowOptionsPatch,
} = require("./main-process.js");
const {
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  isComputerUseUiEnabled,
} = require("./computer-use.js");
const {
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxSettingsPersistencePatch,
  applyLinuxTrayCloseSettingPatch,
} = require("./launch-actions.js");
const {
  applyBrowserAnnotationScreenshotPatch,
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  patchCommentPreloadBundle,
} = require("./webview-assets.js");
const {
  patchKeybindsSettingsAssets,
} = require("./keybinds-settings.js");
const {
  patchPackageJson,
} = require("./package-json.js");

const REQUIRED_UPSTREAM = "required-upstream";
const OPTIONAL = "optional";
const OPT_IN = "opt-in";

// Main bundle patches run in this order because later patches can depend on
// helper functions inserted by earlier ones, especially the quit guard and
// Linux settings helpers.
const MAIN_BUNDLE_PATCHES = [
  {
    name: "linux-quit-guard",
    ciPolicy: REQUIRED_UPSTREAM,
    apply: (source) => applyLinuxQuitGuardPatch(source),
  },
  {
    name: "linux-explicit-tray-quit",
    ciPolicy: REQUIRED_UPSTREAM,
    apply: (source) => applyLinuxExplicitTrayQuitPatch(source),
  },
  {
    name: "linux-explicit-ipc-quit",
    ciPolicy: REQUIRED_UPSTREAM,
    apply: (source) => applyLinuxExplicitIpcQuitPatch(source),
  },
  {
    name: "linux-window-options",
    ciPolicy: OPTIONAL,
    apply: (source, context) => applyLinuxWindowOptionsPatch(source, context.iconAsset),
  },
  {
    name: "linux-menu",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxMenuPatch(source),
  },
  {
    name: "linux-set-icon",
    ciPolicy: OPTIONAL,
    apply: (source, context) => applyLinuxSetIconPatch(source, context.iconAsset),
  },
  {
    name: "linux-opaque-background",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxOpaqueBackgroundPatch(source),
  },
  {
    name: "linux-avatar-overlay-mouse-passthrough",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxAvatarOverlayMousePassthroughPatch(source),
  },
  {
    name: "linux-file-manager",
    ciPolicy: REQUIRED_UPSTREAM,
    apply: (source) => applyLinuxFileManagerPatch(source),
  },
  {
    name: "linux-tray",
    ciPolicy: OPTIONAL,
    apply: (source, context) => applyLinuxTrayPatch(source, context.iconPathExpression),
  },
  {
    name: "linux-single-instance",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxSingleInstancePatch(source),
  },
  {
    name: "linux-computer-use-ui-feature",
    ciPolicy: OPT_IN,
    enabled: (context) => context.enableComputerUseUi,
    apply: (source) => applyLinuxComputerUseFeaturePatch(source),
  },
  {
    name: "linux-computer-use-plugin-gate",
    ciPolicy: REQUIRED_UPSTREAM,
    apply: (source) => applyLinuxComputerUsePluginGatePatch(source),
  },
  {
    name: "browser-use-node-repl-approval",
    ciPolicy: OPTIONAL,
    apply: (source) => applyBrowserUseNodeReplApprovalPatch(source),
  },
  {
    name: "linux-app-updater-menu",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxAppUpdaterMenuPatch(source),
  },
  {
    name: "linux-tray-close-setting",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxTrayCloseSettingPatch(source),
  },
  {
    name: "linux-settings-persistence",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxSettingsPersistencePatch(source),
  },
  {
    name: "linux-launch-actions",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxLaunchActionArgsPatch(source),
  },
  {
    name: "linux-hotkey-window-prewarm",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxHotkeyWindowPrewarmPatch(source),
  },
  {
    name: "linux-git-origins-source-fallback",
    ciPolicy: OPTIONAL,
    apply: (source) => applyLinuxGitOriginsSourceFallbackPatch(source),
  },
];

// Asset patches are separate from main bundle patches because they scan hashed
// webview chunks by filename pattern after app.asar extraction.
const WEBVIEW_ASSET_PATCHES = [
  {
    name: "linux-app-sunset-gate",
    ciPolicy: REQUIRED_UPSTREAM,
    pattern: /^index-.*\.js$/,
    apply: applyLinuxAppSunsetPatch,
    missingDescription: "webview index bundle",
    skipDescription: "app sunset gate patch",
  },
  {
    name: "opaque-window-default-code-theme",
    ciPolicy: OPTIONAL,
    pattern: /^code-theme-.*\.js$/,
    apply: applyLinuxOpaqueWindowsDefaultPatch,
    missingDescription: "code theme bundle",
    skipDescription: "translucent sidebar default patch",
  },
  {
    name: "opaque-window-default-general-settings",
    ciPolicy: OPTIONAL,
    pattern: /^general-settings-.*\.js$/,
    apply: applyLinuxOpaqueWindowsDefaultPatch,
    missingDescription: "general settings bundle",
    skipDescription: "translucent sidebar default patch",
  },
  {
    name: "opaque-window-default-webview-index",
    ciPolicy: OPTIONAL,
    pattern: /^index-.*\.js$/,
    apply: applyLinuxOpaqueWindowsDefaultPatch,
    missingDescription: "webview index bundle",
    skipDescription: "translucent sidebar default patch",
  },
  {
    name: "opaque-window-default-resolved-theme",
    ciPolicy: OPTIONAL,
    pattern: /^use-resolved-theme-variant-.*\.js$/,
    apply: applyLinuxOpaqueWindowsDefaultPatch,
    missingDescription: "resolved theme bundle",
    skipDescription: "translucent sidebar default patch",
  },
];

const COMPUTER_USE_UI_ASSET_PATCHES = [
  {
    name: "linux-computer-use-ui-availability",
    ciPolicy: OPT_IN,
    pattern: /^(use-model-settings|apps|use-in-app-browser-use-availability)-.*\.js$/,
    apply: applyLinuxComputerUseRendererAvailabilityPatch,
    missingDescription: "Computer Use availability bundle",
    skipDescription: "Linux Computer Use UI availability patch",
  },
  {
    name: "linux-computer-use-install-flow",
    ciPolicy: OPT_IN,
    pattern: /^(use-plugin-install-flow|plugins-availability)-.*\.js$/,
    apply: applyLinuxComputerUseInstallFlowPatch,
    missingDescription: "plugin install flow bundle",
    skipDescription: "Linux Computer Use install flow patch",
  },
];

const CUSTOM_PATCH_POLICIES = [
  { name: "main-process-ui", ciPolicy: REQUIRED_UPSTREAM },
  { name: "linux-app-updater-bridge", ciPolicy: OPTIONAL },
  { name: "browser-annotation-screenshot", ciPolicy: OPTIONAL },
  { name: "keybinds-settings", ciPolicy: OPTIONAL },
  { name: "package-desktop-name", ciPolicy: REQUIRED_UPSTREAM },
];

function webviewMissingWarning(extractedDir, patch) {
  return `WARN: Could not find ${patch.missingDescription} in ${path.join(extractedDir, "webview", "assets")} — skipping ${patch.skipDescription}`;
}

function createMainBundleContext(iconAsset) {
  return {
    enableComputerUseUi: isComputerUseUiEnabled(),
    iconAsset,
    iconPathExpression:
      iconAsset == null ? null : `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``,
  };
}

function recordAssetPatch(report, name, patchResult, warnings) {
  if (patchResult.matched === 0) {
    recordPatch(report, name, "skipped-optional", warnings[0] ?? "no matching bundle found");
    return;
  }

  recordPatch(
    report,
    name,
    patchStatusFromChange(patchResult.changed > 0, warnings),
    warnings[0] ?? null,
  );
}

function applyMainBundlePatches(source, context, report) {
  let patched = source;
  const warnings = [];

  for (const patch of MAIN_BUNDLE_PATCHES) {
    if (patch.enabled != null && !patch.enabled(context)) {
      continue;
    }

    const before = patched;
    const result = captureWarnings(() => patch.apply(patched, context));
    patched = result.value;
    warnings.push(...result.warnings);
    recordPatch(
      report,
      patch.name,
      patchStatusFromChange(patched !== before, result.warnings),
      result.warnings[0] ?? null,
    );
  }

  return { patchedSource: patched, warnings };
}

function patchMainBundleSource(source, iconAsset) {
  return applyMainBundlePatches(source, createMainBundleContext(iconAsset), null).patchedSource;
}

function patchExtractedApp(extractedDir, options = {}) {
  const report = options.report ?? null;
  const main = findMainBundle(extractedDir);
  if (report != null) {
    report.mainBundle = main?.mainBundle ?? null;
    report.target = main == null ? null : path.join(main.buildDir, main.mainBundle);
  }
  if (main == null) {
    const reason = `Could not find main bundle in ${path.join(extractedDir, ".vite", "build")}`;
    console.warn(`WARN: ${reason} — skipping main-process UI patches`);
    recordPatch(report, "main-process-ui", "failed-required", reason);
  }

  const iconAsset = findIconAsset(extractedDir);
  if (report != null) {
    report.iconAsset = iconAsset;
  }
  if (iconAsset == null) {
    console.warn(
      `WARN: Could not find app icon asset in ${path.join(extractedDir, "webview", "assets")} — skipping icon patches`,
    );
  }

  if (main != null) {
    const target = path.join(main.buildDir, main.mainBundle);
    const source = fs.readFileSync(target, "utf8");
    const context = createMainBundleContext(iconAsset);
    const { patchedSource, warnings } = applyMainBundlePatches(source, context, report);
    if (patchedSource !== source) {
      fs.writeFileSync(target, patchedSource, "utf8");
    }
    recordPatch(
      report,
      "main-process-ui",
      patchStatusFromChange(patchedSource !== source, warnings),
      warnings[0] ?? null,
    );
  }

  {
    const { value: result, warnings } = captureWarnings(() => patchLinuxAppUpdaterBridge(extractedDir));
    recordAssetPatch(report, "linux-app-updater-bridge", result, warnings);
  }

  {
    const { value: result, warnings } = captureWarnings(() => patchCommentPreloadBundle(extractedDir));
    recordPatch(
      report,
      "browser-annotation-screenshot",
      patchStatusFromChange(result.changed, warnings),
      warnings[0] ?? null,
    );
  }

  for (const patch of WEBVIEW_ASSET_PATCHES) {
    const { value: result, warnings } = captureWarnings(() =>
      patchAssetFiles(extractedDir, patch.pattern, patch.apply, webviewMissingWarning(extractedDir, patch)),
    );
    recordAssetPatch(report, patch.name, result, warnings);
  }

  if (isComputerUseUiEnabled()) {
    for (const patch of COMPUTER_USE_UI_ASSET_PATCHES) {
      const { value: result, warnings } = captureWarnings(() =>
        patchAssetFiles(extractedDir, patch.pattern, patch.apply, webviewMissingWarning(extractedDir, patch)),
      );
      recordAssetPatch(report, patch.name, result, warnings);
    }
  }

  {
    const { value: result, warnings } = captureWarnings(() => patchKeybindsSettingsAssets(extractedDir));
    recordPatch(
      report,
      "keybinds-settings",
      result.changed > 0 ? "applied" : result.matched ? "already-applied" : "skipped-optional",
      result.reason ?? warnings[0] ?? null,
    );
  }

  const packageJsonPath = path.join(extractedDir, "package.json");
  const previousPackageJson = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : null;
  const desktopName = patchPackageJson(extractedDir);
  const nextPackageJson = fs.existsSync(packageJsonPath)
    ? fs.readFileSync(packageJsonPath, "utf8")
    : null;
  if (report != null) {
    report.desktopName = desktopName;
  }
  recordPatch(
    report,
    "package-desktop-name",
    desktopName == null
      ? "skipped-optional"
      : previousPackageJson !== nextPackageJson ? "applied" : "already-applied",
    desktopName == null ? "package.json not found" : null,
  );
  console.log("Patched Linux window, shell, and appearance behavior:", {
    target: main == null ? null : path.join(main.buildDir, main.mainBundle),
    mainBundle: main?.mainBundle ?? null,
    iconAsset,
    desktopName,
  });
}

function allPatchPolicies() {
  return [
    ...MAIN_BUNDLE_PATCHES.map(({ name, ciPolicy }) => ({ name, ciPolicy })),
    ...WEBVIEW_ASSET_PATCHES.map(({ name, ciPolicy }) => ({ name, ciPolicy })),
    ...COMPUTER_USE_UI_ASSET_PATCHES.map(({ name, ciPolicy }) => ({ name, ciPolicy })),
    ...CUSTOM_PATCH_POLICIES,
  ];
}

function requiredPatchNamesForProfile(profile) {
  if (profile !== "upstream-build") {
    return [];
  }
  return allPatchPolicies()
    .filter((patch) => patch.ciPolicy === REQUIRED_UPSTREAM)
    .map((patch) => patch.name);
}

module.exports = {
  COMPUTER_USE_UI_ASSET_PATCHES,
  CUSTOM_PATCH_POLICIES,
  MAIN_BUNDLE_PATCHES,
  OPTIONAL,
  OPT_IN,
  REQUIRED_UPSTREAM,
  WEBVIEW_ASSET_PATCHES,
  allPatchPolicies,
  patchExtractedApp,
  patchMainBundleSource,
  requiredPatchNamesForProfile,
};
