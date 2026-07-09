"use strict";

const PHASE_MAIN_BUNDLE = "main-bundle";
const PHASE_EXTRACTED_APP_PRE_WEBVIEW = "extracted-app:pre-webview";
const PHASE_WEBVIEW_ASSET = "webview-asset";
const PHASE_EXTRACTED_APP_POST_WEBVIEW = "extracted-app:post-webview";

const PATCH_PHASES = new Set([
  PHASE_MAIN_BUNDLE,
  PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  PHASE_WEBVIEW_ASSET,
  PHASE_EXTRACTED_APP_POST_WEBVIEW,
]);
const EXTRACTED_APP_PHASES = new Set([
  PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  PHASE_EXTRACTED_APP_POST_WEBVIEW,
]);

const CI_POLICY_REQUIRED_UPSTREAM = "required-upstream";
const CI_POLICY_OPTIONAL = "optional";
const CI_POLICY_OPT_IN = "opt-in";
const CI_POLICIES = new Set([
  CI_POLICY_REQUIRED_UPSTREAM,
  CI_POLICY_OPTIONAL,
  CI_POLICY_OPT_IN,
]);

function descriptorId(descriptor) {
  return descriptor.id ?? descriptor.name;
}

function assertDescriptorBase(descriptor, phase) {
  if (descriptor == null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error(`Patch descriptor for phase '${phase}' must be an object`);
  }
  const id = descriptorId(descriptor);
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Patch descriptor for phase '${phase}' must have id or name`);
  }
  if (typeof descriptor.apply !== "function") {
    throw new Error(`Patch descriptor '${id}' must export an apply function`);
  }
  if (descriptor.order != null && (!Number.isFinite(descriptor.order) || !Number.isInteger(descriptor.order))) {
    throw new Error(`Patch descriptor '${id}' order must be an integer`);
  }
  const ciPolicy = descriptor.ciPolicy ?? CI_POLICY_OPTIONAL;
  if (!CI_POLICIES.has(ciPolicy)) {
    throw new Error(`Patch descriptor '${id}' has unsupported ciPolicy '${ciPolicy}'`);
  }
  return id;
}

function patchDescriptor(phase, descriptor) {
  if (!PATCH_PHASES.has(phase)) {
    throw new Error(`Unsupported patch phase '${phase}'`);
  }
  const id = assertDescriptorBase(descriptor, phase);
  return {
    ...descriptor,
    id,
    name: descriptor.name ?? id,
    phase,
    ciPolicy: descriptor.ciPolicy ?? CI_POLICY_OPTIONAL,
  };
}

function mainBundlePatch(descriptor) {
  return patchDescriptor(PHASE_MAIN_BUNDLE, descriptor);
}

function webviewAssetPatch(descriptor) {
  const pattern = descriptor?.assetPattern ?? descriptor?.pattern;
  const id = descriptorId(descriptor ?? {});
  if (pattern == null) {
    throw new Error(`Webview asset patch '${id ?? "unknown"}' must define assetPattern or pattern`);
  }
  return patchDescriptor(PHASE_WEBVIEW_ASSET, descriptor);
}

function extractedAppPatch(descriptor) {
  const phase = descriptor?.phase;
  if (!EXTRACTED_APP_PHASES.has(phase)) {
    const id = descriptorId(descriptor ?? {});
    throw new Error(
      `Extracted app patch '${id ?? "unknown"}' must use phase '${PHASE_EXTRACTED_APP_PRE_WEBVIEW}' or '${PHASE_EXTRACTED_APP_POST_WEBVIEW}'`,
    );
  }
  return patchDescriptor(phase, descriptor);
}

module.exports = {
  CI_POLICIES,
  CI_POLICY_OPT_IN,
  CI_POLICY_OPTIONAL,
  CI_POLICY_REQUIRED_UPSTREAM,
  EXTRACTED_APP_PHASES,
  PATCH_PHASES,
  PHASE_EXTRACTED_APP_POST_WEBVIEW,
  PHASE_EXTRACTED_APP_PRE_WEBVIEW,
  PHASE_MAIN_BUNDLE,
  PHASE_WEBVIEW_ASSET,
  extractedAppPatch,
  mainBundlePatch,
  patchDescriptor,
  webviewAssetPatch,
};
