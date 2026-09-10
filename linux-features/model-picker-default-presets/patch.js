"use strict";

const CATALOG_PATCH_MARKER = "codexLinuxModelPickerDefaultPresets";
const CATALOG_PRESET_OPTIONS_KEY = "codexLinuxDefaultPresetOptions";
const SLIDER_PATCH_MARKER = "codex-linux-model-picker-default-presets-slider-minimum";
const LOCAL_DEFAULT_PATCH_MARKER = "codex-linux-model-picker-default-presets-local-default";
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
  const supported = configured.flatMap((preset) => {
    const option = options.find((candidate) => candidate?.slug === preset.modelSlug);
    return option == null
      ? []
      : [{ preset, option: { ...option, thinkingEffort: preset.thinkingEffort } }];
  });
  if (supported.length === 0) {
    return catalog;
  }
  const selectedDefault =
    supported.find(({ preset }) => preset.isDefault)?.preset ?? supported[0].preset;
  return {
    ...catalog,
    codexLinuxDefaultPresetOptions: supported.map(({ option }) => option),
    sliderSettings: supported.map(({ preset }) => ({
      modelSlug: preset.modelSlug,
      thinkingEffort: preset.thinkingEffort,
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

function catalogSelectionResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "internalOptions??[]",
    "versionOptions?.flatMap(",
    "defaultThinkingEffortByModelSlug",
    "thinkingEffort!=null",
  ]);
}

function matchingSquareBracket(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (source[index] === "[") depth += 1;
    if (source[index] === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function catalogPatchContract(source) {
  const markerCount = source.split(CATALOG_PATCH_MARKER).length - 1;
  const presetOptionsCount = source.split(CATALOG_PRESET_OPTIONS_KEY).length - 1;
  const normalizer = catalogNormalizerSection(source);
  const resolver = catalogSelectionResolverSection(source);
  if (markerCount === 0 && presetOptionsCount === 0) {
    return normalizer == null || resolver == null ? "drifted" : "current";
  }
  if (
    markerCount === 2 &&
    presetOptionsCount === 2 &&
    normalizer != null &&
    resolver != null &&
    normalizer.source.includes(`return ${CATALOG_PATCH_MARKER}({`) &&
    resolver.source.includes(`?.${CATALOG_PRESET_OPTIONS_KEY}??[]`)
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

  const normalizer = catalogNormalizerSection(source);
  const resolver = catalogSelectionResolverSection(source);
  const returnMarker = ";return{";
  const returnIndex = normalizer.source.indexOf(returnMarker);
  const closingIndex = normalizer.source.lastIndexOf("}");
  if (returnIndex < 0 || closingIndex <= returnIndex) {
    warn(
      "Could not locate the ChatGPT model catalog return object",
      "model picker Default catalog patch",
    );
    return source;
  }

  const resolverSignature = /^function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)[,)]/u.exec(
    resolver.source,
  );
  const resolverOptionsStart = resolver.source.indexOf("=[", resolverSignature?.[0].length ?? 0) + 1;
  const resolverOptionsEnd = matchingSquareBracket(resolver.source, resolverOptionsStart);
  if (resolverSignature == null || resolverOptionsStart <= 0 || resolverOptionsEnd < 0) {
    warn(
      "Could not locate the ChatGPT model selection option array",
      "model picker Default catalog patch",
    );
    return source;
  }

  const patchedNormalizer =
    normalizer.source.slice(0, returnIndex) +
    `;return ${CATALOG_PATCH_MARKER}({` +
    normalizer.source.slice(returnIndex + returnMarker.length, closingIndex) +
    ",codexLinuxDefaultPresetsConfigured)" +
    normalizer.source.slice(closingIndex);
  const catalogParameter = resolverSignature[1];
  const patchedResolver =
    resolver.source.slice(0, resolverOptionsEnd) +
    `,...${catalogParameter}?.${CATALOG_PRESET_OPTIONS_KEY}??[]` +
    resolver.source.slice(resolverOptionsEnd);
  const replacements = [
    { ...normalizer, source: patchedNormalizer },
    { ...resolver, source: patchedResolver },
  ].sort((left, right) => right.start - left.start);
  let patchedSource = source;
  for (const replacement of replacements) {
    patchedSource =
      patchedSource.slice(0, replacement.start) +
      replacement.source +
      patchedSource.slice(replacement.end);
  }
  const helperIndex = Math.min(normalizer.start, resolver.start);
  return (
    patchedSource.slice(0, helperIndex) +
    catalogRuntimeHelper(presets) +
    patchedSource.slice(helperIndex)
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

function powerSelectionResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    ".sliderSettings?.filter(",
    "isTppConversation:",
    "selectionMode:",
    "powerSettings:",
  ]);
}

function firstFunctionParameter(section) {
  return /^function [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*)[,)]/u.exec(
    section?.source ?? "",
  )?.[1] ?? null;
}

function upstreamDefaultSliderCondition(section) {
  const catalogParameter = firstFunctionParameter(section);
  if (catalogParameter == null) return null;
  const pattern =
    /([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)===([`'"])default\3&&([A-Za-z_$][\w$]*)\.length>0\?\4:/gu;
  const matches = [...section.source.matchAll(pattern)];
  if (matches.length !== 1) return null;
  return {
    catalogParameter,
    match: matches[0][0],
    selectionMode: matches[0][2],
    sliderSettings: matches[0][4],
    tppMode: matches[0][1],
  };
}

function upstreamSliderFilterCondition(section, defaultCondition) {
  const quotedDefault = "([`'\"])default\\1";
  const pattern = new RegExp(
    `${defaultCondition.tppMode}&&${defaultCondition.selectionMode}===${quotedDefault}\\|\\|`,
    "gu",
  );
  const matches = [...section.source.matchAll(pattern)];
  return matches.length === 1 ? matches[0][0] : null;
}

function sliderPatchContract(source) {
  const markerCount = source.split(SLIDER_PATCH_MARKER).length - 1;
  const localMarkerCount = source.split(LOCAL_DEFAULT_PATCH_MARKER).length - 1;
  const sliderSection = sliderResolverSection(source);
  const powerSection = powerSelectionResolverSection(source);
  const catalogParameter = firstFunctionParameter(powerSection);
  if (markerCount === 0 && localMarkerCount === 0) {
    if (sliderSection == null || powerSection == null) return "drifted";
    const defaultCondition = upstreamDefaultSliderCondition(powerSection);
    return (sliderSection.source.match(/\.length>=3/g) ?? []).length === 2 &&
      defaultCondition != null &&
      upstreamSliderFilterCondition(powerSection, defaultCondition) != null
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 1 &&
    localMarkerCount === 1 &&
    sliderSection != null &&
    powerSection != null &&
    sliderSection.source.includes(`/*${SLIDER_PATCH_MARKER}*/`) &&
    powerSection.source.includes(`/*${LOCAL_DEFAULT_PATCH_MARKER}*/`) &&
    (sliderSection.source.match(/\.length>=codexLinuxDefaultPresetMinimum\(/g) ?? []).length === 2 &&
    !sliderSection.source.includes(".length>=3") &&
    powerSection.source.includes(
      `let codexLinuxHasDefaultPresets=${catalogParameter}?.${CATALOG_PRESET_OPTIONS_KEY}!=null`,
    ) &&
    (powerSection.source.match(/codexLinuxHasDefaultPresets/g) ?? []).length === 3
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

  const sliderSection = sliderResolverSection(source);
  const powerSection = powerSelectionResolverSection(source);
  const defaultCondition = upstreamDefaultSliderCondition(powerSection);
  const filterCondition =
    defaultCondition == null ? null : upstreamSliderFilterCondition(powerSection, defaultCondition);
  if (defaultCondition == null || filterCondition == null) {
    warn(
      "Could not locate the local Default power-selection branch",
      "model picker Default slider patch",
    );
    return source;
  }
  const configuredIds = presets.map(
    ({ modelSlug, thinkingEffort }) =>
      `${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`,
  );
  const patchedSliderSection = sliderSection.source
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
  const configuredDefaultCondition =
    `codexLinuxHasDefaultPresets&&${defaultCondition.selectionMode}===\`default\``;
  let patchedPowerSection = powerSection.source
    .replace(filterCondition, `${configuredDefaultCondition}||`)
    .replace(
      defaultCondition.match,
      `${configuredDefaultCondition}&&${defaultCondition.sliderSettings}.length>0?${defaultCondition.sliderSettings}:`,
    );
  const bodyOpening = patchedPowerSection.lastIndexOf(
    "){",
    patchedPowerSection.indexOf(".sliderSettings"),
  ) + 1;
  if (bodyOpening <= 0 || patchedPowerSection[bodyOpening] !== "{") {
    warn(
      "Could not locate the power-selection resolver body",
      "model picker Default slider patch",
    );
    return source;
  }
  patchedPowerSection =
    patchedPowerSection.slice(0, bodyOpening + 1) +
    `/*${LOCAL_DEFAULT_PATCH_MARKER}*/let codexLinuxHasDefaultPresets=${defaultCondition.catalogParameter}?.${CATALOG_PRESET_OPTIONS_KEY}!=null;` +
    patchedPowerSection.slice(bodyOpening + 1);
  const replacements = [
    { ...sliderSection, source: patchedSliderSection },
    { ...powerSection, source: patchedPowerSection },
  ].sort((left, right) => right.start - left.start);
  let patchedSource = source;
  for (const replacement of replacements) {
    patchedSource =
      patchedSource.slice(0, replacement.start) +
      replacement.source +
      patchedSource.slice(replacement.end);
  }
  return patchedSource;
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
  CATALOG_PRESET_OPTIONS_KEY,
  EFFORT_TO_THINKING_EFFORT,
  LOCAL_DEFAULT_PATCH_MARKER,
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
