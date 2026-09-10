"use strict";

const CATALOG_PATCH_MARKER = "codexLinuxModelPickerDefaultPresets";
const SLIDER_PATCH_MARKER = "codex-linux-model-picker-default-presets-slider-minimum";
const JS_ASSET_PATTERN = /\.js$/;
const EFFORT_TO_THINKING_EFFORT = Object.freeze({
  none: "zero",
  low: "min",
  medium: "standard",
  high: "extended",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
});
const THINKING_EFFORT_TO_EFFORT = Object.freeze(
  Object.fromEntries(
    Object.entries(EFFORT_TO_THINKING_EFFORT).map(([effort, thinkingEffort]) => [
      thinkingEffort,
      effort,
    ]),
  ),
);

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function own(object, key) {
  return object != null && Object.prototype.hasOwnProperty.call(object, key);
}

function configuredPresetInput(context = {}) {
  const settings = context?.feature?.settings;
  if (own(settings, "presets")) {
    return { raw: settings.presets, userConfigured: true };
  }
  return {
    raw: context?.feature?.manifest?.presets ?? [],
    userConfigured: false,
  };
}

function normalizePresets(context = {}) {
  const { raw, userConfigured } = configuredPresetInput(context);
  if (!Array.isArray(raw)) {
    throw new Error("model-picker-default-presets presets must be an array");
  }
  if (userConfigured && raw.length === 0) {
    throw new Error("model-picker-default-presets user presets must contain at least one entry");
  }

  const normalized = [];
  const pairs = new Set();
  let defaultCount = 0;
  for (const [index, entry] of raw.entries()) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`model-picker-default-presets presets[${index}] must be an object`);
    }
    const unknownKeys = Object.keys(entry).filter(
      (key) => !["model", "effort", "default"].includes(key),
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `model-picker-default-presets presets[${index}] contains unknown field '${unknownKeys[0]}'`,
      );
    }
    if (typeof entry.model !== "string" || entry.model.trim().length === 0) {
      throw new Error(`model-picker-default-presets presets[${index}].model must be a non-empty string`);
    }
    if (!own(EFFORT_TO_THINKING_EFFORT, entry.effort)) {
      throw new Error(
        `model-picker-default-presets presets[${index}].effort must be one of ${Object.keys(
          EFFORT_TO_THINKING_EFFORT,
        ).join(", ")}`,
      );
    }
    if (own(entry, "default") && typeof entry.default !== "boolean") {
      throw new Error(`model-picker-default-presets presets[${index}].default must be a boolean`);
    }

    const preset = {
      modelSlug: entry.model.trim(),
      thinkingEffort: EFFORT_TO_THINKING_EFFORT[entry.effort],
      isDefault: entry.default === true,
    };
    const pair = `${preset.modelSlug}\0${preset.thinkingEffort}`;
    if (pairs.has(pair)) {
      throw new Error(
        `model-picker-default-presets contains duplicate model/effort pair at presets[${index}]`,
      );
    }
    pairs.add(pair);
    defaultCount += preset.isDefault ? 1 : 0;
    normalized.push(preset);
  }

  if (normalized.length > 0 && defaultCount !== 1) {
    throw new Error("model-picker-default-presets presets must contain exactly one default entry");
  }
  return normalized;
}

function codexLinuxModelPickerDefaultPresets(catalog, configured) {
  if (configured.length === 0) {
    return catalog;
  }
  const options = [
    ...(catalog?.options ?? []),
    ...(catalog?.internalOptions ?? []),
    ...(catalog?.versionOptions?.flatMap((version) => version?.options ?? []) ?? []),
  ];
  const supported = configured.filter((preset) =>
    options.some(
      (option) =>
        option?.slug === preset.modelSlug &&
        (option.thinkingEffort ??
          catalog?.defaultThinkingEffortByModelSlug?.[option.slug] ??
          null) === preset.thinkingEffort,
    ),
  );
  if (supported.length === 0) {
    return catalog;
  }
  const selectedDefault = supported.find((preset) => preset.isDefault) ?? supported[0];
  return {
    ...catalog,
    sliderSettings: supported.map(({ modelSlug, thinkingEffort }) => ({
      modelSlug,
      thinkingEffort,
    })),
    defaultModelSlug: selectedDefault.modelSlug,
    defaultThinkingEffortByModelSlug: {
      ...catalog.defaultThinkingEffortByModelSlug,
      [selectedDefault.modelSlug]: selectedDefault.thinkingEffort,
    },
  };
}

function functionSections(source) {
  const starts = [];
  const pattern = /function [A-Za-z_$][\w$]*\(/g;
  let match;
  while ((match = pattern.exec(source)) != null) {
    starts.push(match.index);
  }
  return starts.map((start, index) => ({
    end: starts[index + 1] ?? source.length,
    source: source.slice(start, starts[index + 1] ?? source.length),
    start,
  }));
}

function uniqueFunctionWithMarkers(source, markers) {
  const matches = functionSections(source).filter((section) =>
    markers.every((marker) => section.source.includes(marker)),
  );
  return matches.length === 1 ? matches[0] : null;
}

function catalogNormalizerSection(source) {
  return uniqueFunctionWithMarkers(source, [
    ".slider_settings.flatMap(",
    "defaultThinkingEffortByModelSlug",
    "defaultModelSlug",
    "workspaceModelPolicy",
  ]);
}

function catalogPatchContract(source) {
  const markerCount = source.split(CATALOG_PATCH_MARKER).length - 1;
  const section = catalogNormalizerSection(source);
  if (markerCount === 0) {
    return section == null ? "drifted" : "current";
  }
  if (
    markerCount === 2 &&
    section != null &&
    section.source.includes(`return ${CATALOG_PATCH_MARKER}({`)
  ) {
    return "applied";
  }
  return "mixed";
}

function catalogRuntimeHelper(presets) {
  return `${codexLinuxModelPickerDefaultPresets.toString()}const codexLinuxDefaultPresetsConfigured=${JSON.stringify(presets)};`;
}

function applyCatalogPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (typeof source !== "string") {
    warn("Asset source is not a string", "model picker Default catalog patch");
    return source;
  }

  const contract = catalogPatchContract(source);
  if (contract === "applied") {
    return source;
  }
  if (contract !== "current") {
    warn(
      "Could not find one coherent ChatGPT model catalog normalizer contract",
      "model picker Default catalog patch",
    );
    return source;
  }

  const section = catalogNormalizerSection(source);
  const returnMarker = ";return{";
  const returnIndex = section.source.indexOf(returnMarker);
  const closingIndex = section.source.lastIndexOf("}");
  if (returnIndex < 0 || closingIndex <= returnIndex) {
    warn(
      "Could not locate the ChatGPT model catalog return object",
      "model picker Default catalog patch",
    );
    return source;
  }

  const patchedSection =
    section.source.slice(0, returnIndex) +
    `;return ${CATALOG_PATCH_MARKER}({` +
    section.source.slice(returnIndex + returnMarker.length, closingIndex) +
    ",codexLinuxDefaultPresetsConfigured)" +
    section.source.slice(closingIndex);
  return (
    source.slice(0, section.start) +
    catalogRuntimeHelper(presets) +
    patchedSection +
    source.slice(section.end)
  );
}

function sliderResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "powerSelectionsWithXHigh",
    "fallbackPowerSelection",
    "show_xhigh_in_simple_picker",
    "canInitializePowerPicker",
  ]);
}

function sliderPatchContract(source) {
  const markerCount = source.split(SLIDER_PATCH_MARKER).length - 1;
  const section = sliderResolverSection(source);
  if (markerCount === 0) {
    if (section == null) return "drifted";
    return (section.source.match(/\.length>=3/g) ?? []).length === 2 ? "current" : "drifted";
  }
  if (
    markerCount === 1 &&
    section != null &&
    section.source.includes(`/*${SLIDER_PATCH_MARKER}*/`) &&
    (section.source.match(/\.length>=codexLinuxDefaultPresetMinimum\(/g) ?? []).length === 2 &&
    !section.source.includes(".length>=3")
  ) {
    return "applied";
  }
  return "mixed";
}

function applySliderMinimumPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) {
    return source;
  }
  if (typeof source !== "string") {
    warn("Asset source is not a string", "model picker Default slider minimum patch");
    return source;
  }

  const contract = sliderPatchContract(source);
  if (contract === "applied") {
    return source;
  }
  if (contract !== "current") {
    warn(
      "Could not find one coherent ChatGPT model picker slider resolver contract",
      "model picker Default slider minimum patch",
    );
    return source;
  }

  const section = sliderResolverSection(source);
  const configuredIds = presets.map(
    ({ modelSlug, thinkingEffort }) =>
      `${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`,
  );
  const patchedSection = section.source
    .replace(
      "{",
      `{/*${SLIDER_PATCH_MARKER}*/let codexLinuxDefaultPresetIds=new Set(${JSON.stringify(
        configuredIds,
      )}),codexLinuxDefaultPresetMinimum=codexLinuxSelections=>codexLinuxSelections.every(codexLinuxSelection=>codexLinuxDefaultPresetIds.has(codexLinuxSelection.id))?2:3;`,
    )
    .replace(
      /([A-Za-z_$][\w$]*)\.length>=3/g,
      "$1.length>=codexLinuxDefaultPresetMinimum($1)",
    );
  return source.slice(0, section.start) + patchedSection + source.slice(section.end);
}

function catalogAssetMatch(source) {
  return catalogPatchContract(source) !== "drifted";
}

function sliderAssetMatch(source, _assetName, context = {}) {
  const presets = normalizePresets(context);
  return presets.length > 0 && sliderPatchContract(source) !== "drifted";
}

const descriptors = [
  {
    id: "model-picker-default-presets-catalog",
    phase: "webview-asset",
    order: 20_798,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    assetMatch: catalogAssetMatch,
    missingDescription: "ChatGPT model catalog normalizer bundle",
    skipDescription: "model picker Default catalog patch",
    enabled: (context = {}) => {
      normalizePresets(context);
      return true;
    },
    apply: applyCatalogPatch,
  },
  {
    id: "model-picker-default-presets-slider-minimum",
    phase: "webview-asset",
    order: 20_799,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: sliderAssetMatch,
    missingDescription: "ChatGPT model picker slider resolver bundle",
    skipDescription: "model picker Default slider minimum patch",
    apply: applySliderMinimumPatch,
  },
];

module.exports = {
  CATALOG_PATCH_MARKER,
  EFFORT_TO_THINKING_EFFORT,
  THINKING_EFFORT_TO_EFFORT,
  JS_ASSET_PATTERN,
  SLIDER_PATCH_MARKER,
  applyCatalogPatch,
  applySliderMinimumPatch,
  catalogAssetMatch,
  catalogPatchContract,
  codexLinuxModelPickerDefaultPresets,
  descriptors,
  normalizePresets,
  sliderAssetMatch,
  sliderPatchContract,
};
