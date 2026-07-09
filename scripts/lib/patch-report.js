"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CRITICAL_CI_POLICY = "required-upstream";
const PATCH_STATUS_APPLIED = "applied";
const PATCH_STATUS_ALREADY_APPLIED = "already-applied";
const PATCH_STATUS_APPLIED_WITH_WARNINGS = "applied-with-warnings";
const PATCH_STATUS_FAILED_REQUIRED = "failed-required";
const PATCH_STATUS_SKIPPED_DISABLED = "skipped-disabled";
const PATCH_STATUS_SKIPPED_OPTIONAL = "skipped-optional";
const PATCH_STATUS_SKIPPED_TARGET = "skipped-target";

const SUCCESS_STATUSES = new Set([PATCH_STATUS_APPLIED, PATCH_STATUS_ALREADY_APPLIED]);
// Statuses meaning "not applicable here" rather than "failed": the patch was
// skipped because of platform targeting or an explicit enable gate.
const NOT_APPLICABLE_STATUSES = new Set([PATCH_STATUS_SKIPPED_TARGET, PATCH_STATUS_SKIPPED_DISABLED]);

function isCriticalPolicy(ciPolicy) {
  return ciPolicy === CRITICAL_CI_POLICY;
}

function reportEntryFailure(patch) {
  return {
    name: patch.name,
    status: patch.status,
    reason: patch.reason ?? null,
  };
}

function criticalFailuresFromReport(report) {
  return (report?.patches ?? [])
    .filter((patch) => isCriticalPolicy(patch.ciPolicy))
    .filter((patch) => !SUCCESS_STATUSES.has(patch.status) && !NOT_APPLICABLE_STATUSES.has(patch.status))
    .map(reportEntryFailure);
}

function optionalDriftFromReport(report) {
  return (report?.patches ?? [])
    .filter((patch) => !isCriticalPolicy(patch.ciPolicy))
    .filter((patch) => !SUCCESS_STATUSES.has(patch.status) && !NOT_APPLICABLE_STATUSES.has(patch.status))
    .map(reportEntryFailure);
}

function createPatchReport() {
  return {
    generatedAt: new Date().toISOString(),
    target: null,
    mainBundle: null,
    iconAsset: null,
    desktopName: null,
    linuxTarget: null,
    enabledFeatures: [],
    patches: [],
  };
}

function recordPatch(report, name, status, reason = null, metadata = null) {
  if (report == null) {
    return;
  }

  const entry = { name, status };
  if (reason != null && String(reason).length > 0) {
    entry.reason = String(reason);
  }
  if (metadata != null && typeof metadata === "object") {
    Object.assign(entry, metadata);
  }
  report.patches.push(entry);
}

function captureWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
    originalWarn(...args);
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function writePatchReport(reportPath, report) {
  if (reportPath == null) {
    return;
  }

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function patchStatusFromChange(changed, warnings, ciPolicy = "optional") {
  const required = ciPolicy === CRITICAL_CI_POLICY;
  if (changed) {
    if (warnings.length > 0) {
      return required ? PATCH_STATUS_FAILED_REQUIRED : PATCH_STATUS_APPLIED_WITH_WARNINGS;
    }
    return PATCH_STATUS_APPLIED;
  }
  if (warnings.length > 0) {
    return required ? PATCH_STATUS_FAILED_REQUIRED : PATCH_STATUS_SKIPPED_OPTIONAL;
  }
  return PATCH_STATUS_ALREADY_APPLIED;
}

function patchGroupForEntry(entry) {
  if (isCriticalPolicy(entry.ciPolicy)) {
    return "requiredCore";
  }
  return entry.sourceKind === "feature" ? "optionalFeatures" : "optionalCore";
}

function summarizePatchReport(report) {
  const groups = {
    requiredCore: { count: 0, statusCounts: {} },
    optionalCore: { count: 0, statusCounts: {} },
    optionalFeatures: { count: 0, statusCounts: {}, byFeature: {} },
  };

  for (const patch of report?.patches ?? []) {
    const groupName = patchGroupForEntry(patch);
    const group = groups[groupName];
    group.count += 1;
    group.statusCounts[patch.status] = (group.statusCounts[patch.status] ?? 0) + 1;

    if (groupName === "optionalFeatures") {
      const featureId = patch.featureId ?? "unknown-feature";
      const featureGroup = group.byFeature[featureId] ??= { count: 0, statusCounts: {} };
      featureGroup.count += 1;
      featureGroup.statusCounts[patch.status] = (featureGroup.statusCounts[patch.status] ?? 0) + 1;
    }
  }

  return {
    enabledFeatures: Array.isArray(report?.enabledFeatures) ? [...report.enabledFeatures] : [],
    groups,
  };
}

module.exports = {
  CRITICAL_CI_POLICY,
  NOT_APPLICABLE_STATUSES,
  PATCH_STATUS_ALREADY_APPLIED,
  PATCH_STATUS_APPLIED,
  PATCH_STATUS_APPLIED_WITH_WARNINGS,
  PATCH_STATUS_FAILED_REQUIRED,
  PATCH_STATUS_SKIPPED_DISABLED,
  PATCH_STATUS_SKIPPED_OPTIONAL,
  PATCH_STATUS_SKIPPED_TARGET,
  SUCCESS_STATUSES,
  captureWarnings,
  createPatchReport,
  criticalFailuresFromReport,
  isCriticalPolicy,
  optionalDriftFromReport,
  patchStatusFromChange,
  recordPatch,
  summarizePatchReport,
  writePatchReport,
};
