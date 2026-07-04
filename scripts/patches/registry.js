"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  patchStatusFromChange,
  recordPatch,
} = require("../lib/patch-report.js");
const {
  detectLinuxTargetContext,
  linuxTargetSummary,
} = require("../lib/linux-target-context.js");
const {
  loadLinuxFeaturePatchDescriptors,
  enabledLinuxFeatureIds,
} = require("../lib/linux-features.js");
const {
  findIconAsset,
  findMainBundle,
} = require("./shared.js");
const {
  applyExtractedAppPatchDescriptors,
  applyMainBundlePatchDescriptors,
  applyWebviewAssetPatchDescriptors,
  discoverCorePatchDescriptors,
  normalizePatchDescriptors,
} = require("./engine.js");
const {
  isComputerUseUiEnabled,
} = require("./computer-use.js");

const REQUIRED_UPSTREAM = "required-upstream";
const OPTIONAL = "optional";
const OPT_IN = "opt-in";
const CORE_PATCH_ROOT = path.join(__dirname, "core");
const EXTRACTED_APP_WEBVIEW_SPLIT_ORDER = 2020;

const CUSTOM_PATCH_POLICIES = [
  { name: "main-process-ui", ciPolicy: REQUIRED_UPSTREAM, phase: "main-bundle" },
];

function recordMainProcessUiPatch(report, status, reason = null) {
  recordPatch(report, "main-process-ui", status, reason, {
    phase: "main-bundle",
    ciPolicy: REQUIRED_UPSTREAM,
    sourceKind: "core",
  });
}

function normalizeDiscoveredCorePatchDescriptors(options = {}) {
  const root = options.corePatchRoot ?? CORE_PATCH_ROOT;
  return normalizePatchDescriptors(discoverCorePatchDescriptors({ root }));
}

function corePatchDescriptors(options = {}) {
  return normalizeDiscoveredCorePatchDescriptors(options);
}

function legacyCorePatchDescriptors(options = {}) {
  return corePatchDescriptors(options);
}

function featurePatchDescriptors(options = {}) {
  return normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors(options));
}

function featurePatchOptions(options = {}) {
  return {
    ...(options.featuresRoot != null ? { featuresRoot: options.featuresRoot } : {}),
    ...(options.featuresConfigPath != null ? { featuresConfigPath: options.featuresConfigPath } : {}),
  };
}

function createMainBundleContext(iconAsset, options = {}) {
  const linux = options.linuxTarget ?? detectLinuxTargetContext(options.linuxTargetOptions);
  return {
    enableComputerUseUi: isComputerUseUiEnabled(),
    iconAsset,
    iconPathExpression:
      iconAsset == null ? null : `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``,
    linux,
    linuxTarget: linux,
    corePatchRoot: options.corePatchRoot,
    featurePatchOptions: featurePatchOptions(options),
  };
}

function setReportLinuxTarget(report, linux) {
  if (report == null) {
    return;
  }

  report.linuxTarget = {
    summary: linuxTargetSummary(linux),
    distro: linux.distro,
    packageFormat: linux.packageFormat,
    packageManager: linux.packageManager,
    arch: linux.arch,
    desktop: linux.desktop,
    sessionType: linux.sessionType,
    wayland: linux.wayland,
    x11: linux.x11,
    atomic: linux.atomic,
  };
}

function mainBundlePatchDescriptors(context) {
  return normalizePatchDescriptors([
    ...corePatchDescriptors({ corePatchRoot: context.corePatchRoot })
      .filter((patch) => patch.phase === "main-bundle"),
    ...featurePatchDescriptors(context.featurePatchOptions).filter((patch) => patch.phase === "main-bundle"),
  ]);
}

function applyMainBundlePatches(source, context, report) {
  return applyMainBundlePatchDescriptors(source, mainBundlePatchDescriptors(context), context, report);
}

function patchMainBundleSource(source, iconAsset, options = {}) {
  return applyMainBundlePatches(source, createMainBundleContext(iconAsset, options), null).patchedSource;
}

function patchExtractedApp(extractedDir, options = {}) {
  const report = options.report ?? null;
  const baseContext = createMainBundleContext(null, options);
  const featuresOptions = featurePatchOptions(options);
  const patchDescriptors = normalizePatchDescriptors([
    ...corePatchDescriptors({ corePatchRoot: options.corePatchRoot }),
    ...featurePatchDescriptors(featuresOptions),
  ]);

  setReportLinuxTarget(report, baseContext.linux);
  if (report != null) {
    report.enabledFeatures = enabledLinuxFeatureIds(featuresOptions);
  }

  const main = findMainBundle(extractedDir);
  if (report != null) {
    report.mainBundle = main?.mainBundle ?? null;
    report.target = main == null ? null : path.join(main.buildDir, main.mainBundle);
  }
  if (main == null) {
    const reason = `Could not find main bundle in ${path.join(extractedDir, ".vite", "build")}`;
    console.warn(`WARN: ${reason} — skipping main-process UI patches`);
    recordMainProcessUiPatch(report, "failed-required", reason);
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

  const assetContext = createMainBundleContext(iconAsset, {
    ...options,
    linuxTarget: baseContext.linux,
  });
  assetContext.report = report;

  if (main != null) {
    const target = path.join(main.buildDir, main.mainBundle);
    const source = fs.readFileSync(target, "utf8");
    const { patchedSource, requiredCoreWarnings } = applyMainBundlePatches(source, assetContext, report);
    if (patchedSource !== source) {
      fs.writeFileSync(target, patchedSource, "utf8");
    }
    recordPatch(
      report,
      "main-process-ui",
      patchStatusFromChange(patchedSource !== source, requiredCoreWarnings, REQUIRED_UPSTREAM),
      requiredCoreWarnings[0] ?? null,
      {
        phase: "main-bundle",
        ciPolicy: REQUIRED_UPSTREAM,
        sourceKind: "core",
        ...(requiredCoreWarnings.length > 0 ? { warnings: [...requiredCoreWarnings] } : {}),
      },
    );
  }

  applyExtractedAppPatchDescriptors(
    extractedDir,
    patchDescriptors.filter((patch) => patch.order < EXTRACTED_APP_WEBVIEW_SPLIT_ORDER),
    assetContext,
    report,
  );

  applyWebviewAssetPatchDescriptors(
    extractedDir,
    patchDescriptors,
    assetContext,
    report,
  );

  applyExtractedAppPatchDescriptors(
    extractedDir,
    patchDescriptors.filter((patch) => patch.order >= EXTRACTED_APP_WEBVIEW_SPLIT_ORDER),
    assetContext,
    report,
  );

  const desktopName = assetContext.desktopName ?? report?.desktopName ?? null;
  console.log("Patched Linux window, shell, and appearance behavior:", {
    target: main == null ? null : path.join(main.buildDir, main.mainBundle),
    mainBundle: main?.mainBundle ?? null,
    iconAsset,
    desktopName,
  });
}

function allPatchPolicies(options = {}) {
  return [
    ...corePatchDescriptors(options).map(({ id, name, ciPolicy, phase, appliesTo }) => ({
      name: name ?? id,
      ciPolicy,
      phase,
      appliesTo,
    })),
    ...featurePatchDescriptors(featurePatchOptions(options)).map(({ id, name, ciPolicy, phase, appliesTo }) => ({
      name: name ?? id,
      ciPolicy,
      phase,
      appliesTo,
    })),
    ...CUSTOM_PATCH_POLICIES,
  ];
}

function requiredPatchNamesForProfile(profile, options = {}) {
  if (profile !== "upstream-build") {
    return [];
  }
  const linux = options.linuxTarget ?? detectLinuxTargetContext(options.linuxTargetOptions);
  const context = { linux, linuxTarget: linux, enableComputerUseUi: isComputerUseUiEnabled() };
  return allPatchPolicies({ corePatchRoot: options.corePatchRoot })
    .filter((patch) => patch.ciPolicy === REQUIRED_UPSTREAM)
    .filter((patch) => patch.appliesTo == null || patch.appliesTo(context) !== false)
    .map((patch) => patch.name);
}

const EXPORTED_CORE_PATCHES = corePatchDescriptors();
const MAIN_BUNDLE_PATCHES = EXPORTED_CORE_PATCHES.filter((patch) => patch.phase === "main-bundle");
const WEBVIEW_ASSET_PATCHES = EXPORTED_CORE_PATCHES.filter((patch) => patch.phase === "webview-asset");
const COMPUTER_USE_UI_ASSET_PATCHES = WEBVIEW_ASSET_PATCHES.filter((patch) =>
  patch.id.startsWith("linux-computer-use-"),
);

module.exports = {
  COMPUTER_USE_UI_ASSET_PATCHES,
  CUSTOM_PATCH_POLICIES,
  MAIN_BUNDLE_PATCHES,
  OPTIONAL,
  OPT_IN,
  REQUIRED_UPSTREAM,
  WEBVIEW_ASSET_PATCHES,
  allPatchPolicies,
  corePatchDescriptors,
  createMainBundleContext,
  featurePatchDescriptors,
  legacyCorePatchDescriptors,
  patchExtractedApp,
  patchMainBundleSource,
  requiredPatchNamesForProfile,
};
