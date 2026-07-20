"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PATCH_MARKER = "codexLinuxCrossProviderThreadHistory";
const ACTIVE_RESUME_PROVIDER_MARKER = "codexLinuxActiveResumeProvider";
const CURRENT_LIST_ALL = "listAllThreads({modelProviders:null";
const COMPLIANT_LIST_ALL = "listAllThreads({modelProviders:[]";
const PATCHED_PROVIDER_FILTER = `modelProviders:[]/*${PATCH_MARKER}*/`;
const CURRENT_RESUME_PROVIDER_PATTERN =
  /(`thread\/resume`,\{[^{}]{0,1600}?model:null,modelProvider:)([A-Za-z_$][\w$]*)(\.modelProvider)(,serviceTier:\2\.serviceTier)/g;
const COMPLIANT_RESUME_PROVIDER_PATTERN = new RegExp(
  "(`thread/resume`,\\{[^{}]{0,1600}?model:null,modelProvider:)" +
    "([A-Za-z_$][\\w$]*)(\\.modelProvider\\?\\?\\2\\.config\\?\\.model_provider" +
    `\\?\\?null/\\*${ACTIVE_RESUME_PROVIDER_MARKER}\\*/)` +
    "(,serviceTier:\\2\\.serviceTier)",
  "g",
);
const DIRECT_THREAD_LIST_PREFIX = "`thread/list`,\\{[^{}]{0,800}?";
const RECENT_THREAD_PARAMS_PREFIX =
  "async listRecentThreads\\([^)]*\\)\\{let [A-Za-z_$][\\w$]*=\\{[^{}]{0,800}?";
const THREAD_ENUMERATION_PREFIXES = [
  DIRECT_THREAD_LIST_PREFIX,
  RECENT_THREAD_PARAMS_PREFIX,
];
const THREAD_HISTORY_TARGETS = [
  {
    id: "manager",
    pattern:
      /^app-initial~artifact-tab-content\.electron~notebook-preview-panel~app-main~business-checkout~oxnpxkxc-[^.]+\.js$/,
    expectedEnumerationCount: 5,
    expectedResumeCount: 1,
    surface: "thread manager",
  },
  {
    id: "resolver",
    pattern:
      /^app-initial~artifact-tab-content\.electron~notebook-preview-panel~app-main~pull-request-rout~jvsvjxtt-[^.]+\.js$/,
    expectedEnumerationCount: 2,
    expectedResumeCount: 0,
    surface: "cross-host thread resolver",
  },
  {
    id: "subagent",
    pattern:
      /^app-initial~app-main~new-thread-panel-page~onboarding-page~appgen-library-page~hotkey-windo~k4644ppc-[^.]+\.js$/,
    expectedEnumerationCount: 1,
    expectedResumeCount: 0,
    surface: "subagent thread enumeration",
  },
];

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function countMatches(source, pattern) {
  return Array.from(source.matchAll(pattern)).length;
}

function providerFilterPattern(prefixPattern, providerPattern, capturePrefix = false) {
  const prefix = capturePrefix
    ? `(${prefixPattern})`
    : prefixPattern;
  return new RegExp(`${prefix}${providerPattern}`, "g");
}

function countThreadEnumerationFilters(source, listAllNeedle, providerPattern) {
  return THREAD_ENUMERATION_PREFIXES.reduce(
    (total, prefix) =>
      total + countMatches(source, providerFilterPattern(prefix, providerPattern)),
    countOccurrences(source, listAllNeedle),
  );
}

function threadEnumerationCounts(source) {
  return {
    currentEnumeration: countThreadEnumerationFilters(
      source,
      CURRENT_LIST_ALL,
      "modelProviders:null",
    ),
    compliantEnumeration: countThreadEnumerationFilters(
      source,
      COMPLIANT_LIST_ALL,
      "modelProviders:\\[\\]",
    ),
  };
}

function matchesThreadHistoryState(counts, target, state) {
  const current = state === "current";
  return (
    counts.currentEnumeration ===
      (current ? target.expectedEnumerationCount : 0) &&
    counts.compliantEnumeration ===
      (current ? 0 : target.expectedEnumerationCount) &&
    counts.currentResume === (current ? target.expectedResumeCount : 0) &&
    counts.compliantResume === (current ? 0 : target.expectedResumeCount)
  );
}

function classifyThreadHistoryState(counts, target) {
  if (matchesThreadHistoryState(counts, target, "current")) {
    return "current";
  }
  if (matchesThreadHistoryState(counts, target, "compliant")) {
    return "compliant";
  }
  return "invalid";
}

function threadHistoryCounts(source) {
  return {
    ...threadEnumerationCounts(source),
    currentResume: countMatches(source, CURRENT_RESUME_PROVIDER_PATTERN),
    compliantResume: countMatches(source, COMPLIANT_RESUME_PROVIDER_PATTERN),
  };
}

function applyCrossProviderThreadHistoryPatch(
  source,
  { expectedEnumerationCount, expectedResumeCount = 0, surface },
) {
  const target = { expectedEnumerationCount, expectedResumeCount };
  const counts = threadHistoryCounts(source);

  if (matchesThreadHistoryState(counts, target, "compliant")) {
    return source;
  }

  if (!matchesThreadHistoryState(counts, target, "current")) {
    console.warn(
      `WARN: Could not verify ${surface} provider filter ` +
        `(current=${counts.currentEnumeration}, ` +
        `compliant=${counts.compliantEnumeration}, ` +
        `expected=${expectedEnumerationCount}) - or resume provider ` +
        `(current=${counts.currentResume}, compliant=${counts.compliantResume}, ` +
        `expected=${expectedResumeCount}) - ` +
        "skipping cross-provider thread history patch",
    );
    return source;
  }

  let patched = source
    .replaceAll(
      CURRENT_LIST_ALL,
      `listAllThreads({${PATCHED_PROVIDER_FILTER}`,
    );
  for (const prefix of THREAD_ENUMERATION_PREFIXES) {
    patched = patched.replace(
      providerFilterPattern(prefix, "modelProviders:null", true),
      `$1${PATCHED_PROVIDER_FILTER}`,
    );
  }
  patched = patched.replace(
    CURRENT_RESUME_PROVIDER_PATTERN,
    `$1$2.modelProvider??$2.config?.model_provider??null/*${ACTIVE_RESUME_PROVIDER_MARKER}*/$4`,
  );
  return patched;
}

function skipCrossProviderThreadHistoryPatch(reason) {
  console.warn(`WARN: ${reason} - skipping cross-provider thread history patch`);
  return { matched: false, changed: 0, reason };
}

function resolveThreadHistoryAssets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return {
      error: `missing webview assets directory ${assetsDir}`,
      assets: [],
    };
  }

  const candidates = fs.readdirSync(assetsDir);
  const assets = [];
  for (const target of THREAD_HISTORY_TARGETS) {
    const matches = candidates.filter((candidate) => target.pattern.test(candidate));
    if (matches.length !== 1) {
      return {
        error:
          `expected exactly one ${target.surface} bundle, found ${matches.length}`,
        assets: [],
      };
    }
    const filePath = path.join(assetsDir, matches[0]);
    assets.push({
      ...target,
      filePath,
      source: fs.readFileSync(filePath, "utf8"),
    });
  }
  return { error: null, assets };
}

function applyCrossProviderThreadHistoryAssets(extractedDir) {
  const resolved = resolveThreadHistoryAssets(extractedDir);
  if (resolved.error != null) {
    return skipCrossProviderThreadHistoryPatch(resolved.error);
  }

  const inspected = resolved.assets.map((asset) => {
    const counts = threadHistoryCounts(asset.source);
    const state = classifyThreadHistoryState(counts, asset);
    return { ...asset, counts, state };
  });
  const invalid = inspected.find((asset) => asset.state === "invalid");
  if (invalid != null) {
    return skipCrossProviderThreadHistoryPatch(
      `could not verify ${invalid.surface} provider filter ` +
        `(current=${invalid.counts.currentEnumeration}, ` +
        `compliant=${invalid.counts.compliantEnumeration}, ` +
        `expected=${invalid.expectedEnumerationCount}) or resume provider ` +
        `(current=${invalid.counts.currentResume}, ` +
        `compliant=${invalid.counts.compliantResume}, ` +
        `expected=${invalid.expectedResumeCount})`,
    );
  }

  const states = new Set(inspected.map((asset) => asset.state));
  if (states.size !== 1) {
    return skipCrossProviderThreadHistoryPatch(
      `inconsistent cross-bundle provider filter state (${inspected
        .map((asset) => `${asset.id}=${asset.state}`)
        .join(", ")})`,
    );
  }
  if (states.has("compliant")) {
    return { matched: true, changed: 0 };
  }

  const patches = inspected.map((asset) => {
    const patchedSource = applyCrossProviderThreadHistoryPatch(asset.source, asset);
    const patchedCounts = threadHistoryCounts(patchedSource);
    if (
      patchedSource === asset.source ||
      !matchesThreadHistoryState(patchedCounts, asset, "compliant")
    ) {
      throw new Error(
        `cross-provider thread history postcondition failed for ${asset.surface}`,
      );
    }
    return { ...asset, patchedSource };
  });

  const written = [];
  try {
    for (const patch of patches) {
      written.push(patch);
      fs.writeFileSync(patch.filePath, patch.patchedSource, "utf8");
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const patch of written.reverse()) {
      try {
        fs.writeFileSync(patch.filePath, patch.source, "utf8");
      } catch (rollbackError) {
        rollbackErrors.push(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `cross-provider thread history write failed and rollback was incomplete: ${rollbackErrors.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  return { matched: true, changed: patches.length };
}

const descriptors = [
  {
    id: "all-provider-thread-history",
    phase: "extracted-app:post-webview",
    order: 20_850,
    ciPolicy: "optional",
    apply: applyCrossProviderThreadHistoryAssets,
  },
];

module.exports = {
  ACTIVE_RESUME_PROVIDER_MARKER,
  THREAD_HISTORY_TARGETS,
  applyCrossProviderThreadHistoryAssets,
  applyCrossProviderThreadHistoryPatch,
  descriptors,
  resolveThreadHistoryAssets,
  threadHistoryCounts,
  threadEnumerationCounts,
};
