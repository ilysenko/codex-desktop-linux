"use strict";

const DEFAULT_MAX_UI_FONT_SIZE = 24;
const MAX_CONFIGURABLE_UI_FONT_SIZE = 64;
const MIN_EXTENDED_UI_FONT_SIZE = 17;
const UI_FONT_SIZE_ASSET_PATTERN = /^app-initial-[^.]+\.js$/;
const RUNTIME_MARKER = "codex-linux-ui-font-size-max";
const UPSTREAM_FONT_SIZE_LIMITS_PATTERN =
  /([A-Za-z_$][\w$]*)=\{sans:\{min:(11),max:(16)\},code:\{min:(8),max:(24)\}\}/g;

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

function applyUiFontSizePatch(source, context = {}) {
  try {
    if (typeof source !== "string") {
      warn("Asset source is not a string");
      return source;
    }
    if (!enabled(context) || source.includes(RUNTIME_MARKER)) {
      return source;
    }

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

const descriptors = [
  {
    id: "extended-ui-font-size",
    phase: "webview-asset",
    order: 20_792,
    ciPolicy: "optional",
    enabled,
    pattern: UI_FONT_SIZE_ASSET_PATTERN,
    missingDescription: "appearance settings registry bundle",
    skipDescription: "ui-tweaks extended UI font size patch",
    apply: (source, context = {}) =>
      applyUiFontSizePatch(source, { ...context, warnOnMissingMarkers: true }),
  },
];

module.exports = {
  DEFAULT_MAX_UI_FONT_SIZE,
  MAX_CONFIGURABLE_UI_FONT_SIZE,
  MIN_EXTENDED_UI_FONT_SIZE,
  RUNTIME_MARKER,
  UI_FONT_SIZE_ASSET_PATTERN,
  UPSTREAM_FONT_SIZE_LIMITS_PATTERN,
  applyUiFontSizePatch,
  descriptors,
  normalizedMaxUiFontSize,
};
