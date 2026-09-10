"use strict";

const CATALOG_PATCH_MARKER = "codexLinuxModelPickerDefaultPresets";
const CATALOG_PRESET_OPTIONS_KEY = "codexLinuxDefaultPresetOptions";
const SLIDER_PATCH_MARKER = "codex-linux-model-picker-default-presets-slider-minimum";
const LOCAL_DEFAULT_PATCH_MARKER = "codex-linux-model-picker-default-presets-local-default";
const LOCAL_COMPOSER_CONFIG_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-config";
const LOCAL_COMPOSER_RESOLVER_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-resolver";
const LOCAL_DRAFT_SELECTION_MARKER =
  "codex-linux-model-picker-default-presets-local-draft-selection";
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

function localComposerResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "sliderModelsConfig:",
    "includeUltraInSlider:",
    "stripGptPrefix:",
    ".presets){",
  ]);
}

function localComposerSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "sliderModelsConfig:",
    "modelsForPicker(",
    "setDefaultModelAndReasoningEffort:",
    "composer.mode.local.model.custom",
  ]);
}

function localComposerResolverContract(source) {
  const markerCount = source.split(LOCAL_COMPOSER_RESOLVER_MARKER).length - 1;
  const section = localComposerResolverSection(source);
  if (markerCount === 0) {
    if (section == null) return "drifted";
    const matches = [
      ...section.source.matchAll(
        /if\(([A-Za-z_$][\w$]*)\.length>=3\)return \1/gu,
      ),
    ];
    return matches.length === 2 ? "current" : "drifted";
  }
  if (
    markerCount === 1 &&
    section != null &&
    section.source.includes(`/*${LOCAL_COMPOSER_RESOLVER_MARKER}*/`) &&
    section.source.includes("codexLinuxIsConfiguredDefaultPresets?1:3")
  ) {
    return "applied";
  }
  return "mixed";
}

function applyLocalComposerResolverPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) return source;
  const contract = localComposerResolverContract(source);
  if (contract === "applied") return source;
  if (contract !== "current") {
    warn(
      "Could not find one coherent local composer slider config resolver contract",
      "model picker Default local composer resolver patch",
    );
    return source;
  }
  const section = localComposerResolverSection(source);
  const configParameter = /sliderModelsConfig:([A-Za-z_$][\w$]*)/.exec(section.source)?.[1];
  if (configParameter == null) return source;
  let patchedSection = section.source.replace(
    new RegExp(
      `(for\\(let [A-Za-z_$][\\w$]* of ${configParameter}\\.presets\\)\\{)`,
      "u",
    ),
    `let codexLinuxIsConfiguredDefaultPresets=${configParameter}?.codexLinuxDefaultPresets===!0/*${LOCAL_COMPOSER_RESOLVER_MARKER}*/;$1`,
  );
  patchedSection = patchedSection.replace(
    /if\(([A-Za-z_$][\w$]*)\.length>=3\)return \1/u,
    "if($1.length>=(codexLinuxIsConfiguredDefaultPresets?1:3))return $1",
  );
  const patchedSource =
    source.slice(0, section.start) + patchedSection + source.slice(section.end);
  if (localComposerResolverContract(patchedSource) !== "applied") {
    warn(
      "Could not apply the complete local composer slider config resolver contract",
      "model picker Default local composer resolver patch",
    );
    return source;
  }
  return patchedSource;
}

function localComposerConfig(presets) {
  const configured = presets.map(({ modelSlug, thinkingEffort }) => ({
    model: modelSlug,
    reasoning_effort: THINKING_EFFORT_TO_EFFORT[thinkingEffort],
  }));
  const selectedDefault = presets.find(({ isDefault }) => isDefault);
  return {
    codexLinuxDefaultPresets: true,
    codexLinuxDefaultPresetIds: configured.map(
      ({ model, reasoning_effort: effort }) => `${model}:${effort}`,
    ),
    codexLinuxDefaultPresetId: `${selectedDefault.modelSlug}:${THINKING_EFFORT_TO_EFFORT[selectedDefault.thinkingEffort]}`,
    presets: [configured],
  };
}

function localComposerRuntime(config) {
  return (
    `/*${LOCAL_COMPOSER_CONFIG_MARKER}*/` +
    `const codexLinuxLocalDefaultPresetConfig=${JSON.stringify(config)},` +
    "codexLinuxLocalDefaultPresetIds=new Set(codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetIds);" +
    "function codexLinuxLocalDefaultPresetFallback(codexLinuxSelections,codexLinuxUpstreamDefault){" +
    "let codexLinuxAvailable=codexLinuxSelections.filter(({id:codexLinuxId})=>codexLinuxLocalDefaultPresetIds.has(codexLinuxId));" +
    "if(codexLinuxAvailable.length===0)return codexLinuxUpstreamDefault;" +
    "return codexLinuxAvailable.find(({id:codexLinuxId})=>codexLinuxId===codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetId)?.id??codexLinuxAvailable[0].id}"
  );
}

const LOCAL_COMPOSER_FALLBACK_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)==null\?void 0:`\$\{\4\.model\}:\$\{\4\.defaultReasoningEffort\}`\)/gu;

function localComposerConfigContract(source) {
  const markerCount = source.split(LOCAL_COMPOSER_CONFIG_MARKER).length - 1;
  const draftMarkerCount = source.split(LOCAL_DRAFT_SELECTION_MARKER).length - 1;
  const section = localComposerSection(source);
  if (markerCount === 0 && draftMarkerCount === 0) {
    if (section == null) return "drifted";
    const configMatches = section.source.match(/sliderModelsConfig:[A-Za-z_$][\w$]*/g) ?? [];
    const fallbackMatches = source.match(LOCAL_COMPOSER_FALLBACK_PATTERN) ?? [];
    const selectionMatches =
      section.source.match(
        /[A-Za-z_$][\w$]*\?\.selectModelAndReasoningEffort\?\?[A-Za-z_$][\w$]*/g,
      ) ?? [];
    return configMatches.length === 1 &&
      fallbackMatches.length === 2 &&
      selectionMatches.length === 1
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 1 &&
    draftMarkerCount === 1 &&
    section != null &&
    section.source.includes("sliderModelsConfig:codexLinuxLocalDefaultPresetConfig") &&
    (source.match(/codexLinuxLocalDefaultPresetFallback\(/g) ?? []).length === 3 &&
    section.source.includes(`/*${LOCAL_DRAFT_SELECTION_MARKER}*/`)
  ) {
    return "applied";
  }
  return "mixed";
}

function applyLocalComposerConfigPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) return source;
  const contract = localComposerConfigContract(source);
  if (contract === "applied") return source;
  if (contract !== "current") {
    warn(
      "Could not find one coherent local composer model picker contract",
      "model picker Default local composer config patch",
    );
    return source;
  }
  const section = localComposerSection(source);
  let patchedSection = section.source.replace(
    /sliderModelsConfig:[A-Za-z_$][\w$]*/u,
    "sliderModelsConfig:codexLinuxLocalDefaultPresetConfig",
  );
  patchedSection = patchedSection.replace(
    /([A-Za-z_$][\w$]*)\?\.selectModelAndReasoningEffort\?\?([A-Za-z_$][\w$]*)/u,
    "($1?.selectModelAndReasoningEffort??((codexLinuxModel,codexLinuxEffort,codexLinuxCallback)=>$2(codexLinuxModel,codexLinuxEffort,codexLinuxCallback,codexLinuxLocalDefaultPresetIds.has(`${codexLinuxModel}:${codexLinuxEffort}`)?{persistAsDefault:!1}:void 0)))/*" +
      LOCAL_DRAFT_SELECTION_MARKER +
      "*/",
  );
  let patchedSource =
    source.slice(0, section.start) +
    localComposerRuntime(localComposerConfig(presets)) +
    patchedSection +
    source.slice(section.end);
  patchedSource = patchedSource.replace(
    LOCAL_COMPOSER_FALLBACK_PATTERN,
    "$1=$2($3,codexLinuxLocalDefaultPresetFallback($3,$4==null?void 0:`${$4.model}:${$4.defaultReasoningEffort}`))",
  );
  if (localComposerConfigContract(patchedSource) !== "applied") {
    warn(
      "Could not apply the complete local composer model picker contract",
      "model picker Default local composer config patch",
    );
    return source;
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
  {
    id: "model-picker-default-presets-local-composer-resolver",
    phase: "webview-asset",
    order: 20_800,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: (source) => localComposerResolverContract(source) !== "drifted",
    missingDescription: "local composer slider config resolver bundle",
    skipDescription: "model picker Default local composer resolver patch",
    apply: applyLocalComposerResolverPatch,
  },
  {
    id: "model-picker-default-presets-local-composer-config",
    phase: "webview-asset",
    order: 20_801,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: (source) => localComposerConfigContract(source) !== "drifted",
    missingDescription: "local composer model picker bundle",
    skipDescription: "model picker Default local composer config patch",
    apply: applyLocalComposerConfigPatch,
  },
];

module.exports = {
  CATALOG_PATCH_MARKER,
  CATALOG_PRESET_OPTIONS_KEY,
  EFFORT_TO_THINKING_EFFORT,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  LOCAL_DRAFT_SELECTION_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  THINKING_EFFORT_TO_EFFORT,
  JS_ASSET_PATTERN,
  SLIDER_PATCH_MARKER,
  applyCatalogPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  applySliderMinimumPatch,
  catalogAssetMatch,
  catalogPatchContract,
  codexLinuxModelPickerDefaultPresets,
  descriptors,
  normalizePresets,
  localComposerConfig,
  localComposerConfigContract,
  localComposerResolverContract,
  sliderAssetMatch,
  sliderPatchContract,
};
