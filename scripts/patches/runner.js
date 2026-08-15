"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
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
  findMainBundle,
} = require("./lib/assets.js");
const {
  applyExtractedAppPatchDescriptors,
  applyMainBundlePatchDescriptors,
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
  recordUnavailablePhasePatchDescriptors,
} = require("./engine.js");
const {
  PHASE_EXTRACTED_APP_POST_WEBVIEW,
  PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  PHASE_MAIN_BUNDLE,
} = require("./descriptor.js");

const REQUIRED_UPSTREAM = "required-upstream";
const OPTIONAL = "optional";
const OPT_IN = "opt-in";
const CORE_PATCH_ROOT = path.join(__dirname, "core");

const CUSTOM_PATCH_POLICIES = [];

function normalizeDiscoveredCorePatchDescriptors(options = {}) {
  void options;
  return [];
}

function corePatchDescriptors(options = {}) {
  return normalizeDiscoveredCorePatchDescriptors(options);
}

function featurePatchDescriptors(options = {}) {
  return normalizePatchDescriptors(loadLinuxFeaturePatchDescriptors(options));
}

function featurePatchOptions(options = {}) {
  return {
    ...(options.featuresRoot != null ? { featuresRoot: options.featuresRoot } : {}),
    ...(options.featuresConfigPath != null ? { featuresConfigPath: options.featuresConfigPath } : {}),
    ...(options.internalFeatureIds != null ? { internalFeatureIds: options.internalFeatureIds } : {}),
  };
}

function createMainBundleContext(iconAsset, options = {}) {
  const linux = options.linuxTarget ?? detectLinuxTargetContext(options.linuxTargetOptions);
  const currentFeaturePatchOptions = featurePatchOptions(options);
  const enabledFeatureIds = options.enabledFeatureIds ??
    enabledLinuxFeatureIds(currentFeaturePatchOptions);
  return {
    enableComputerUseUi: enabledFeatureIds.includes("computer-use-linux"),
    enabledFeatureIds: [...enabledFeatureIds],
    iconAsset,
    linux,
    linuxTarget: linux,
    corePatchRoot: options.corePatchRoot,
    featurePatchOptions: currentFeaturePatchOptions,
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
  };
}

function mainBundlePatchDescriptors(context) {
  return normalizePatchDescriptors([
    ...corePatchDescriptors({ corePatchRoot: context.corePatchRoot })
      .filter((patch) => patch.phase === PHASE_MAIN_BUNDLE),
    ...featurePatchDescriptors(context.featurePatchOptions).filter((patch) => patch.phase === PHASE_MAIN_BUNDLE),
  ]);
}

function applyMainBundlePatches(source, context, report) {
  const descriptors = mainBundlePatchDescriptors(context);
  return applyMainBundlePatchDescriptors(source, descriptors, context, report);
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
    report.enabledFeatures = [...baseContext.enabledFeatureIds];
  }

  const main = findMainBundle(extractedDir);
  if (report != null) {
    report.mainBundle = main?.mainBundle ?? null;
    report.target = main == null ? null : path.join(main.buildDir, main.mainBundle);
  }
  if (main == null && patchDescriptors.some((descriptor) => descriptor.phase === PHASE_MAIN_BUNDLE)) {
    const reason = `Could not find main bundle in ${path.join(extractedDir, ".vite", "build")}`;
    console.warn(`WARN: ${reason} — skipping enabled main-bundle feature patches`);
    recordUnavailablePhasePatchDescriptors(
      patchDescriptors,
      PHASE_MAIN_BUNDLE,
      baseContext,
      report,
      reason,
    );
  }

  const iconAsset = null;
  if (report != null) {
    report.iconAsset = iconAsset;
  }
  const assetContext = createMainBundleContext(iconAsset, {
    ...options,
    enabledFeatureIds: baseContext.enabledFeatureIds,
    linuxTarget: baseContext.linux,
  });
  assetContext.report = report;

  if (main != null && patchDescriptors.some((descriptor) => descriptor.phase === PHASE_MAIN_BUNDLE)) {
    const target = path.join(main.buildDir, main.mainBundle);
    const source = fs.readFileSync(target, "utf8");
    const { patchedSource } = applyMainBundlePatches(source, assetContext, report);
    if (patchedSource !== source) {
      fs.writeFileSync(target, patchedSource, "utf8");
    }
  }

  applyExtractedAppPatchDescriptors(
    extractedDir,
    patchDescriptors,
    assetContext,
    report,
    PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  );

  applyWebviewAssetPatchDescriptors(
    extractedDir,
    patchDescriptors,
    assetContext,
    report,
  );

  applyExtractedAppPatchDescriptors(
    extractedDir,
    patchDescriptors,
    assetContext,
    report,
    PHASE_EXTRACTED_APP_POST_WEBVIEW,
  );

  console.log("Applied enabled Linux feature descriptors:", {
    target: main == null ? null : path.join(main.buildDir, main.mainBundle),
    mainBundle: main?.mainBundle ?? null,
    iconAsset,
    featureCount: baseContext.enabledFeatureIds.length,
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
  const context = { linux, linuxTarget: linux, enableComputerUseUi: false };
  return allPatchPolicies(options)
    .filter((patch) => patch.ciPolicy === REQUIRED_UPSTREAM)
    .filter((patch) => patch.appliesTo == null || patch.appliesTo(context) !== false)
    .map((patch) => patch.name);
}

module.exports = {
  CUSTOM_PATCH_POLICIES,
  OPTIONAL,
  OPT_IN,
  REQUIRED_UPSTREAM,
  allPatchPolicies,
  corePatchDescriptors,
  createMainBundleContext,
  featurePatchDescriptors,
  patchExtractedApp,
  patchMainBundleSource,
  requiredPatchNamesForProfile,
};
