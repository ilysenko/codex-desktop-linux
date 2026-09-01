"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_UI_FONT_SIZE = 24;
const MAX_CONFIGURABLE_UI_FONT_SIZE = 64;
const MIN_EXTENDED_UI_FONT_SIZE = 17;
const RUNTIME_MARKER = "codex-linux-ui-font-size-max";
const EXPECTED_FONT_SIZE_BUNDLE_COUNT = 3;
const UPSTREAM_FONT_SIZE_LIMITS_PATTERN =
  /([A-Za-z_$][\w$]*)=\{sans:\{min:(11),max:(16)\},code:\{min:(8),max:(24)\}\}/g;
const APPLIED_FONT_SIZE_LIMITS_PATTERN =
  /[A-Za-z_$][\w$]*=\{sans:\{min:11,max:(1[7-9]|[2-5]\d|6[0-4])\/\*codex-linux-ui-font-size-max\*\/\},code:\{min:8,max:24\}\}/g;

function warn(message) {
  console.warn(`WARN: ${message} - skipping ui-tweaks UI font size patch`);
}

function uiFontSizeConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.appearance?.uiFontSize;
  const settings = context?.feature?.settings?.tweaks?.appearance?.uiFontSize;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function enabled(context) {
  return uiFontSizeConfig(context).enabled === true;
}

function normalizedMaxUiFontSize(context) {
  const configured = uiFontSizeConfig(context).max;
  if (configured == null) {
    return DEFAULT_MAX_UI_FONT_SIZE;
  }
  if (
    !Number.isInteger(configured) ||
    configured < MIN_EXTENDED_UI_FONT_SIZE ||
    configured > MAX_CONFIGURABLE_UI_FONT_SIZE
  ) {
    console.warn(
      `WARN: ui-tweaks appearance.uiFontSize.max must be an integer from ` +
        `${MIN_EXTENDED_UI_FONT_SIZE} to ${MAX_CONFIGURABLE_UI_FONT_SIZE} - ` +
        `using ${DEFAULT_MAX_UI_FONT_SIZE}`,
    );
    return DEFAULT_MAX_UI_FONT_SIZE;
  }
  return configured;
}

function countMatches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].length;
}

function fontSizeLimitContract(source) {
  const markerCount = source.split(RUNTIME_MARKER).length - 1;
  const upstreamCount = countMatches(source, UPSTREAM_FONT_SIZE_LIMITS_PATTERN);
  const appliedCount = countMatches(source, APPLIED_FONT_SIZE_LIMITS_PATTERN);
  if (markerCount === 0 && upstreamCount === 0 && appliedCount === 0) {
    return "absent";
  }
  if (markerCount === 0 && upstreamCount === 1 && appliedCount === 0) {
    return "current";
  }
  if (markerCount === 1 && upstreamCount === 0 && appliedCount === 1) {
    return "applied";
  }
  return "drifted";
}

function appliedUiFontSizeMax(source) {
  APPLIED_FONT_SIZE_LIMITS_PATTERN.lastIndex = 0;
  const matches = [...source.matchAll(APPLIED_FONT_SIZE_LIMITS_PATTERN)];
  return matches.length === 1 ? Number(matches[0][1]) : null;
}

function applyUiFontSizePatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(RUNTIME_MARKER)) {
      return source;
    }

    UPSTREAM_FONT_SIZE_LIMITS_PATTERN.lastIndex = 0;
    const matches = [...source.matchAll(UPSTREAM_FONT_SIZE_LIMITS_PATTERN)];
    if (matches.length !== 1) {
      if (context.warnOnMissingMarkers === true) {
        warn("Could not find the unique current UI and code font size limits");
      }
      return source;
    }

    const max = normalizedMaxUiFontSize(context);
    const [original, registry, sansMin, _sansMax, codeMin, codeMax] = matches[0];
    const replacement =
      `${registry}={sans:{min:${sansMin},max:${max}/*${RUNTIME_MARKER}*/},` +
      `code:{min:${codeMin},max:${codeMax}}}`;
    return source.replace(original, replacement);
  } catch (error) {
    warn(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function fontSizeBundlePaths(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  const paths = [];
  if (fs.existsSync(buildDir)) {
    paths.push(
      ...fs.readdirSync(buildDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => path.join(buildDir, entry.name)),
    );
  }
  if (fs.existsSync(webviewAssetsDir)) {
    paths.push(
      ...fs.readdirSync(webviewAssetsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^app-initial-[^.]+\.js$/.test(entry.name))
        .map((entry) => path.join(webviewAssetsDir, entry.name)),
    );
  }
  return paths.sort();
}

function findUiFontSizeBundles(extractedDir) {
  const candidates = [];
  for (const filePath of fontSizeBundlePaths(extractedDir)) {
    const source = fs.readFileSync(filePath, "utf8");
    const state = fontSizeLimitContract(source);
    if (state !== "absent") {
      candidates.push({
        filePath,
        source,
        state,
        appliedMax: state === "applied" ? appliedUiFontSizeMax(source) : null,
      });
    }
  }

  const buildCount = candidates.filter(({ filePath }) =>
    filePath.startsWith(`${path.join(extractedDir, ".vite", "build")}${path.sep}`),
  ).length;
  const webviewCount = candidates.length - buildCount;
  const states = new Set(candidates.map(({ state }) => state));
  const appliedMaxes = new Set(
    candidates.filter(({ state }) => state === "applied").map(({ appliedMax }) => appliedMax),
  );
  if (
    candidates.length !== EXPECTED_FONT_SIZE_BUNDLE_COUNT ||
    buildCount !== 2 ||
    webviewCount !== 1 ||
    states.has("drifted") ||
    states.size !== 1 ||
    appliedMaxes.size > 1
  ) {
    return {
      candidates: [],
      reason:
        `Found ${buildCount} build and ${webviewCount} webview UI font-size contracts ` +
        `with states ${JSON.stringify([...states].sort())} and applied maxima ` +
        `${JSON.stringify([...appliedMaxes].sort((left, right) => left - right))}`,
    };
  }
  return { candidates, reason: null };
}

function applyUiFontSizeAppPatch(extractedDir, context = {}) {
  const discovery = findUiFontSizeBundles(extractedDir);
  if (discovery.candidates.length !== EXPECTED_FONT_SIZE_BUNDLE_COUNT) {
    const reason = discovery.reason ?? "Current UI font-size contracts not found";
    warn(reason);
    return { matched: 0, changed: 0, reason };
  }
  if (discovery.candidates[0].state === "applied") {
    const configuredMax = normalizedMaxUiFontSize(context);
    if (discovery.candidates[0].appliedMax !== configuredMax) {
      const reason =
        `Applied UI font-size maximum ${discovery.candidates[0].appliedMax} ` +
        `does not match configured maximum ${configuredMax}`;
      warn(reason);
      return { matched: 0, changed: 0, reason };
    }
    return {
      matched: EXPECTED_FONT_SIZE_BUNDLE_COUNT,
      changed: 0,
      reason: null,
      targets: discovery.candidates.map(({ filePath }) => path.relative(extractedDir, filePath)),
    };
  }

  const results = discovery.candidates.map((candidate) => ({
    ...candidate,
    patchedSource: applyUiFontSizePatch(candidate.source, context),
  }));
  if (results.some(({ patchedSource, source }) => patchedSource === source)) {
    const reason = "Could not patch every current UI font-size contract";
    warn(reason);
    return { matched: 0, changed: 0, reason };
  }
  for (const { filePath, patchedSource } of results) {
    fs.writeFileSync(filePath, patchedSource, "utf8");
  }
  return {
    matched: EXPECTED_FONT_SIZE_BUNDLE_COUNT,
    changed: EXPECTED_FONT_SIZE_BUNDLE_COUNT,
    reason: null,
    targets: results.map(({ filePath }) => path.relative(extractedDir, filePath)),
  };
}

const descriptors = [
  {
    id: "extended-ui-font-size",
    phase: "extracted-app:post-webview",
    order: 20_792,
    ciPolicy: "optional",
    enabled,
    apply: applyUiFontSizeAppPatch,
    status: (result, warnings) => {
      if (result?.matched !== EXPECTED_FONT_SIZE_BUNDLE_COUNT) {
        return { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null };
      }
      return result.changed > 0 ? "applied" : "already-applied";
    },
  },
];

module.exports = {
  DEFAULT_MAX_UI_FONT_SIZE,
  EXPECTED_FONT_SIZE_BUNDLE_COUNT,
  MAX_CONFIGURABLE_UI_FONT_SIZE,
  MIN_EXTENDED_UI_FONT_SIZE,
  RUNTIME_MARKER,
  UPSTREAM_FONT_SIZE_LIMITS_PATTERN,
  appliedUiFontSizeMax,
  applyUiFontSizeAppPatch,
  applyUiFontSizePatch,
  descriptors,
  findUiFontSizeBundles,
  fontSizeLimitContract,
  normalizedMaxUiFontSize,
};
