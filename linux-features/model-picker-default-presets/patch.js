"use strict";

const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const CATALOG_PATCH_MARKER = "codexLinuxModelPickerDefaultPresets";
const CATALOG_PRESET_OPTIONS_KEY = "codexLinuxDefaultPresetOptions";
const SLIDER_PATCH_MARKER = "codex-linux-model-picker-default-presets-slider-minimum";
const LOCAL_DEFAULT_PATCH_MARKER = "codex-linux-model-picker-default-presets-local-default";
const LOCAL_COMPOSER_CONFIG_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-config";
const LOCAL_COMPOSER_RESOLVER_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-resolver";
const EXISTING_CHAT_OPTIMISTIC_MARKER =
  "codex-linux-model-picker-default-presets-existing-chat-optimistic-selection";
const EXISTING_CHAT_PRESET_IDS_KEY = "codexLinuxExistingChatDefaultPresetIds";
const JS_ASSET_PATTERN = /\.js$/;
const IDENT = "[A-Za-z_$][\\w$]*";
const EFFORT_TO_THINKING_EFFORT = Object.freeze({
  none: "zero",
  low: "min",
  medium: "standard",
  high: "extended",
  xhigh: "xhigh",
  max: "max",
  ultra: "ultra",
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function identifierSpellingPattern(identifier) {
  return [...identifier].map((character) => {
    const hex = character.codePointAt(0).toString(16)
      .replace(/[a-f]/gu, (digit) => `[${digit}${digit.toUpperCase()}]`);
    const fixedHex = character.codePointAt(0).toString(16).padStart(4, "0")
      .replace(/[a-f]/gu, (digit) => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${escapeRegExp(character)}|\\\\u${fixedHex}|\\\\u\\{0*${hex}\\})`;
  }).join("");
}
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
  const sections = [];
  const pattern = /function [A-Za-z_$][\w$]*\([^)]*\)\{/g;
  for (const match of source.matchAll(pattern)) {
    const open = match.index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close !== -1) {
      sections.push({
        end: close + 1,
        source: source.slice(match.index, close + 1),
        start: match.index,
      });
    }
  }
  return sections;
}

function uniqueFunctionWithMarkers(source, markers) {
  const matches = functionSections(source).filter((section) =>
    markers.every((marker) => section.source.includes(marker)),
  );
  const leafMatches = matches.filter((candidate) =>
    !matches.some((other) =>
      other !== candidate && other.start > candidate.start && other.end < candidate.end
    )
  );
  return leafMatches.length === 1 ? leafMatches[0] : null;
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

function stringLiteralEnd(source, openingIndex) {
  const quote = source[openingIndex];
  for (let index = openingIndex + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === quote) return index;
    if (quote === "`" && character === "$" && source[index + 1] === "{") {
      const closing = matchingCurlyBrace(source, index + 1);
      if (closing < 0) return -1;
      index = closing;
    }
  }
  return -1;
}

function matchingCurlyBrace(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" || character === '"' || character === "`") {
      const closing = stringLiteralEnd(source, index);
      if (closing < 0) return -1;
      index = closing;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function returnsObjectLiteralAt(section, objectIndex) {
  const preceding = section.slice(0, objectIndex).trimEnd();
  return preceding.endsWith("return") || preceding.endsWith(",");
}

// Upstream both nests object returns inside the catalog normalizer and returns
// the catalog through a comma expression, so no textual "return{" anchor is
// stable. The catalog object is the literal that closes the function body;
// wrapping anything else unbalances the bundle and blanks the renderer.
function catalogReturnObjectIndex(section, closingIndex) {
  if (closingIndex < 1) return -1;
  for (let index = closingIndex - 2; index >= 0; index -= 1) {
    if (section[index] !== "{") continue;
    if (matchingCurlyBrace(section, index) !== closingIndex - 1) continue;
    return returnsObjectLiteralAt(section, index) ? index : -1;
  }
  return -1;
}

function parsesStandalone(section) {
  try {
    new Function(section);
    return true;
  } catch {
    return false;
  }
}

// A patch that turns a parseable section into an unparseable one takes the
// whole renderer down with a blank window, so fail closed instead.
function keepsSectionParseable(original, patched) {
  return !parsesStandalone(original) || parsesStandalone(patched);
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
    normalizer.source.includes(`${CATALOG_PATCH_MARKER}({`) &&
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
  const closingIndex = normalizer.source.lastIndexOf("}");
  const returnIndex = catalogReturnObjectIndex(normalizer.source, closingIndex);
  if (returnIndex < 0) {
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
    ` ${CATALOG_PATCH_MARKER}(` +
    normalizer.source.slice(returnIndex, closingIndex) +
    ",codexLinuxDefaultPresetsConfigured)" +
    normalizer.source.slice(closingIndex);
  const catalogParameter = resolverSignature[1];
  const patchedResolver =
    resolver.source.slice(0, resolverOptionsEnd) +
    `,...${catalogParameter}?.${CATALOG_PRESET_OPTIONS_KEY}??[]` +
    resolver.source.slice(resolverOptionsEnd);
  if (
    !keepsSectionParseable(normalizer.source, patchedNormalizer) ||
    !keepsSectionParseable(resolver.source, patchedResolver)
  ) {
    warn(
      "Patched ChatGPT model catalog section no longer parses",
      "model picker Default catalog patch",
    );
    return source;
  }

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
  const signature = new RegExp(
    `^function ${IDENT}\\((${IDENT}),(${IDENT}),${IDENT},\\{`,
    "u",
  ).exec(section?.source ?? "");
  if (signature == null) return null;
  const aliases = [
    ["isTppConversation", "!1"],
    ["useMergedPicker", "!1"],
    ["selectionMode", "(?:\\x60default\\x60|'default'|\"default\")"],
  ].map(([property, fallback]) => [
    ...section.source.matchAll(
      new RegExp(`${property}:(${IDENT})=${fallback}`, "gu"),
    ),
  ]);
  if (aliases.some((matches) => matches.length !== 1)) return null;
  const [tppMode, mergedPicker, selectionMode] = aliases.map(
    (matches) => matches[0][1],
  );
  const explicitPattern = new RegExp(
    `\\(!\\(${tppMode}\\|\\|${mergedPicker}\\)\\|\\|${selectionMode}===([\\x60'"])model\\1\\)` +
      `&&${signature[2]}!=null\\?${signature[2]}:`,
    "gu",
  );
  const explicitMatches = [...section.source.matchAll(explicitPattern)];
  if (explicitMatches.length !== 1) return null;
  return {
    catalogParameter: signature[1],
    explicitMatch: explicitMatches[0][0],
    mergedPicker,
    optionsParameter: signature[2],
    selectionMode,
    tppMode,
  };
}

function upstreamSliderFilterCondition(section, defaultCondition) {
  if (section == null || defaultCondition == null) return null;
  const { catalogParameter, mergedPicker, selectionMode, tppMode } = defaultCondition;
  const filterPattern = new RegExp(
    `(${IDENT})=${catalogParameter}\\?\\.sliderSettings\\?\\.filter\\(\\(\\{modelSlug:${IDENT}\\}\\)=>` +
      `\\(${tppMode}\\|\\|${mergedPicker}\\)&&${selectionMode}===([\\x60'"])default\\2\\|\\|`,
    "gu",
  );
  const filterMatches = [...section.source.matchAll(filterPattern)];
  if (filterMatches.length !== 1) return null;
  const sliderSettings = filterMatches[0][1];
  const defaultPattern = new RegExp(
    `\\(\\(${tppMode}\\|\\|${mergedPicker}\\)&&${selectionMode}===([\\x60'"])default\\1&&` +
      `${sliderSettings}\\.length>0\\?${sliderSettings}:`,
    "gu",
  );
  const defaultMatches = [...section.source.matchAll(defaultPattern)];
  return defaultMatches.length === 1
    ? { defaultMatch: defaultMatches[0][0], filterMatch: filterMatches[0][0], sliderSettings }
    : null;
}

function upstreamDefaultSelectionAssetMatch(source, _assetName, context = {}) {
  if (normalizePresets(context).length === 0) return false;
  const section = powerSelectionResolverSection(source);
  const condition = upstreamDefaultSliderCondition(section);
  return upstreamSliderFilterCondition(section, condition) != null;
}

function upstreamResetEffectSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "fallbackPowerSelection:",
    "isModelSettingsLoading:",
    "onReset:",
    "resetContextKey:",
    "selectedPowerSelectionWithXHigh:",
    ".useEffectEvent)(",
  ]);
}

function upstreamResetEffectAliases(section) {
  const properties = [
    "fallbackPowerSelection",
    "isModelSettingsLoading",
    "onReset",
    "resetContextKey",
    "selectedPowerSelectionWithXHigh",
  ];
  const destructurings = [
    ...(section?.source ?? "").matchAll(
      new RegExp(`\\{([^{}]+)\\}=${IDENT}(?=,|;)`, "gu"),
    ),
  ].filter((match) =>
    properties.every((property) =>
      new RegExp(`(?:^|,)${property}:${IDENT}(?=,|$)`, "u").test(match[1]),
    )
  );
  if (destructurings.length !== 1) return null;
  const aliases = {};
  for (const property of properties) {
    const match = new RegExp(`(?:^|,)${property}:(${IDENT})(?=,|$)`, "u").exec(
      destructurings[0][1],
    );
    if (match == null) return null;
    aliases[property] = match[1];
  }
  return aliases;
}

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function upstreamResetEffectContract(source) {
  const section = upstreamResetEffectSection(source);
  if (section == null) return "drifted";
  const aliases = upstreamResetEffectAliases(section);
  if (aliases == null) return "drifted";
  const {
    fallbackPowerSelection: fallback,
    isModelSettingsLoading: loading,
    onReset,
    resetContextKey: resetContext,
    selectedPowerSelectionWithXHigh: selected,
  } = aliases;

  const resolution = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=${IDENT}\\(\\{[^{}]{0,1200}?canInitializePowerPicker:(${IDENT}),` +
        `[^{}]{0,1200}?fallbackPowerSelection:${fallback},` +
        `[^{}]{0,1200}?menuView:(${IDENT}),` +
        `[^{}]{0,1200}?selectedPowerSelection:${selected},` +
        `[^{}]{0,1200}?showXHighInSimplePicker:(${IDENT})[^{}]{0,1200}?\\}\\)`,
      "gu",
    ),
  );
  if (resolution == null) return "drifted";
  const resolved = resolution[1];
  const canInitialize = resolution[2];
  const menuView = resolution[3];
  const showXHigh = resolution[4];
  const selection = uniqueMatch(
    section.source,
    new RegExp(`(?:let\\s+|,)(${IDENT})=${resolved}(?=,)`, "gu"),
  )?.[1];
  if (selection == null) return "drifted";
  const selectedId = uniqueMatch(
    section.source,
    new RegExp(`(${IDENT})=${selection}\\?\\.id\\?\\?null`, "gu"),
  )?.[1];
  if (selectedId == null) return "drifted";
  const resetScope = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=${selectedId}==null\\?null:\\x60\\$\\{${resetContext}\\}:` +
        `\\$\\{${selectedId}\\}\\x60`,
      "gu",
    ),
  )?.[1];
  if (resetScope == null) return "drifted";
  const resetCallback = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=(${IDENT})=>\\{${selection}\\?\\.id===\\2&&${onReset}\\(${selection}\\)\\}`,
      "gu",
    ),
  )?.[1];
  if (resetCallback == null) return "drifted";
  const resetEvent = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=\\(0,${IDENT}\\.useEffectEvent\\)\\(${resetCallback}\\)`,
      "gu",
    ),
  )?.[1];
  const resetRef = uniqueMatch(
    section.source,
    new RegExp(`(${IDENT})=\\(0,${IDENT}\\.useRef\\)\\(null\\)`, "gu"),
  )?.[1];
  if (resetEvent == null || resetRef == null) return "drifted";

  const effect = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=\\(\\)=>\\{${loading}\\|\\|\\((${IDENT})\\?` +
        `${selectedId}!=null&&${resetScope}!=null&&` +
        `${resetRef}\\.current!==${resetScope}&&\\(${resetRef}\\.current=${resetScope},` +
        `${resetEvent}\\(${selectedId}\\)\\):${resetRef}\\.current=null\\)\\}`,
      "gu",
    ),
  );
  if (effect == null) return "drifted";
  const active = effect[2];
  const pickerReady = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=!${showXHigh}&&${canInitialize}&&${menuView}===([\\x60'"])simple\\2(?=,|;)`,
      "gu",
    ),
  );
  if (pickerReady == null || pickerReady[1] !== active) return "drifted";
  const dependencies = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=\\[${selectedId},${resetScope},${active},${loading}\\]`,
      "gu",
    ),
  );
  if (dependencies == null || effect.index >= dependencies.index) return "drifted";
  const effectRegistration = uniqueMatch(
    section.source,
    new RegExp(
      `\\(0,${IDENT}\\.useEffect\\)\\(${effect[1]},${dependencies[1]}\\)`,
      "gu",
    ),
  );
  if (
    effectRegistration == null ||
    dependencies.index >= effectRegistration.index
  ) {
    return "drifted";
  }
  const auditedScope = section.source;
  const activeOccurrences = [
    ...auditedScope.matchAll(
      new RegExp(`(?<![\\w$])${identifierSpellingPattern(active)}(?![\\w$])`, "gu"),
    ),
  ].map((match) => match.index);
  const effectPredicateIndex =
    effect.index + effect[0].indexOf(`||(${active}?`) + "||(".length;
  const dependencyIndex =
    dependencies.index + dependencies[0].indexOf(`,${active},`) + 1;
  const allowedActiveOccurrences = new Set([
    pickerReady.index,
    effectPredicateIndex,
    dependencyIndex,
  ]);
  // Compiler-cache reads are allowed only when the very next token is one the
  // signed bundle uses after them. Listing the allowed tokens (instead of the
  // forbidden ones) rejects assignments, updates, comments, and line breaks.
  const cacheReadSuffix = "(?=,|\\|\\|(?!=)|\\?(?![?.=]))";
  for (const match of auditedScope.matchAll(
    new RegExp(
      `${IDENT}\\[\\d+\\](?:!==|=)(${escapeRegExp(active)})${cacheReadSuffix}`,
      "gu",
    ),
  )) {
    allowedActiveOccurrences.add(
      match.index + match[0].length - active.length,
    );
  }
  if (
    pickerReady.index >= effect.index ||
    activeOccurrences.length !== allowedActiveOccurrences.size ||
    activeOccurrences.some((index) => !allowedActiveOccurrences.has(index))
  ) {
    return "drifted";
  }
  return "current";
}

function upstreamResetEffectAssetMatch(source, _assetName, context = {}) {
  return normalizePresets(context).length > 0 &&
    upstreamResetEffectContract(source) === "current";
}

function sliderPatchContract(source) {
  const markerCount = source.split(SLIDER_PATCH_MARKER).length - 1;
  const sliderSection = sliderResolverSection(source);
  if (markerCount === 0) {
    return sliderSection != null &&
      (sliderSection.source.match(/\.length>=3/g) ?? []).length === 2
      ? "current" : "drifted";
  }
  if (
    markerCount === 1 &&
    sliderSection != null &&
    sliderSection.source.includes(`/*${SLIDER_PATCH_MARKER}*/`) &&
    (sliderSection.source.match(/\.length>=codexLinuxDefaultPresetMinimum\(/g) ?? []).length === 2 &&
    !sliderSection.source.includes(".length>=3")
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
  return source.slice(0, sliderSection.start) + patchedSliderSection +
    source.slice(sliderSection.end);
}

function localComposerResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "sliderModelsConfig:",
    "removeXHigh:",
    "stripGptPrefix:",
    ".presets){",
  ]);
}

function localComposerSection(source) {
  const prefix = uniqueFunctionWithMarkers(source, [
    "sliderModelsConfig:",
    "modelsForPicker(",
    "setDefaultModelAndReasoningEffort:",
    "composer.mode.local.model.custom",
  ]);
  if (prefix == null) return null;
  const terminalMarker = source.indexOf("onSelectDefault:", prefix.start);
  if (terminalMarker < 0) return null;
  const nextFunction = /function [A-Za-z_$][\w$]*\(/g;
  nextFunction.lastIndex = terminalMarker;
  const next = nextFunction.exec(source);
  if (next == null) return null;
  return {
    end: next.index,
    source: source.slice(prefix.start, next.index),
    start: prefix.start,
  };
}

function localComposerResolverContract(source) {
  const markerCount = source.split(LOCAL_COMPOSER_RESOLVER_MARKER).length - 1;
  const section = localComposerResolverSection(source);
  if (markerCount === 0) {
    if (section == null) return "drifted";
    const configParameter = /sliderModelsConfig:([A-Za-z_$][\w$]*)/.exec(
      section.source,
    )?.[1];
    if (configParameter == null) return "drifted";
    const thresholds =
      section.source.match(/if\(([A-Za-z_$][\w$]*)\.length>=3\)return \1/gu) ?? [];
    const configLoopThresholds = section.source.match(
      new RegExp(
        `for\\(let [A-Za-z_$][\\w$]* of ${configParameter}\\.presets\\)\\{[\\s\\S]{0,2000}?if\\(([A-Za-z_$][\\w$]*)\\.length>=3\\)return \\1`,
        "gu",
      ),
    );
    return thresholds.length === 2 && configLoopThresholds?.length === 1
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 1 &&
    section != null &&
    section.source.includes(`/*${LOCAL_COMPOSER_RESOLVER_MARKER}*/`) &&
    (section.source.match(/codexLinuxIsConfiguredDefaultPresets\?1:3/g) ?? []).length === 1
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
    new RegExp(
      `(for\\(let [A-Za-z_$][\\w$]* of ${configParameter}\\.presets\\)\\{[\\s\\S]{0,2000}?)if\\(([A-Za-z_$][\\w$]*)\\.length>=3\\)return \\2`,
      "u",
    ),
    "$1if($2.length>=(codexLinuxIsConfiguredDefaultPresets?1:3))return $2",
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
    "function codexLinuxLocalDefaultPresetSelection(codexLinuxSelections){" +
    "let codexLinuxAvailable=codexLinuxSelections.filter(({id:codexLinuxId})=>codexLinuxLocalDefaultPresetIds.has(codexLinuxId));" +
    "return codexLinuxAvailable.find(({id:codexLinuxId})=>codexLinuxId===codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetId)??codexLinuxAvailable[0]??null}" +
    "function codexLinuxLocalDefaultPresetFallback(codexLinuxEnabled,codexLinuxSelections,codexLinuxUpstreamDefault){" +
    "return codexLinuxEnabled?codexLinuxLocalDefaultPresetSelection(codexLinuxSelections)?.id??codexLinuxUpstreamDefault:codexLinuxUpstreamDefault}"
  );
}

const LOCAL_COMPOSER_FALLBACK_PATTERN =
  /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)==null\?void 0:`\$\{\4\.model\}:\$\{\4\.defaultReasoningEffort\}`\)/gu;
const LOCAL_COMPOSER_SELECTION_PATTERN = new RegExp(
  `async function (?<handler>[A-Za-z_$][\\w$]*)\\((?<model>[A-Za-z_$][\\w$]*),(?<effort>[A-Za-z_$][\\w$]*)\\)\\{` +
    `let (?<normalized>[A-Za-z_$][\\w$]*)=(?<normalizer>[A-Za-z_$][\\w$]*)\\(\\k<model>\\);` +
    `await\\((?<delegate>[A-Za-z_$][\\w$]*)==null\\?(?<base>[A-Za-z_$][\\w$]*)\\(\\k<normalized>,\\k<effort>\\):` +
    `\\k<delegate>\\.setModelAndReasoningEffort\\(\\k<normalized>,\\k<effort>\\)\\)\\}`,
  "gu",
);

function localComposerResetContext(section) {
  const matches = [
    ...(section?.source ?? "").matchAll(
      /resetContextKey:JSON\.stringify\(\[([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\.cwd\]\)/gu,
    ),
  ];
  if (matches.length !== 1) return null;
  const [, conversation, hostId, cwdOwner] = matches[0];
  return { conversation, cwdOwner, hostId };
}

function localComposerConfigContract(source) {
  const markerCount = source.split(LOCAL_COMPOSER_CONFIG_MARKER).length - 1;
  const section = localComposerSection(source);
  if (markerCount === 0) {
    if (section == null) return "drifted";
    const configMatches = section.source.match(/sliderModelsConfig:[A-Za-z_$][\w$]*/g) ?? [];
    const fallbackMatches = section.source.match(LOCAL_COMPOSER_FALLBACK_PATTERN) ?? [];
    const selectionMatches = section.source.match(LOCAL_COMPOSER_SELECTION_PATTERN) ?? [];
    return configMatches.length === 1 &&
      fallbackMatches.length === 2 &&
      selectionMatches.length === 1 &&
      localComposerResetContext(section) != null
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 1 &&
    section != null &&
    section.source.includes(":codexLinuxLocalDefaultPresetConfig") &&
    (section.source.match(/codexLinuxLocalDefaultPresetFallback\(/g) ?? []).length === 2 &&
    (section.source.match(/codexLinuxLocalDefaultPresetSelection\(/g) ?? []).length === 0 &&
    (section.source.match(LOCAL_COMPOSER_SELECTION_PATTERN) ?? []).length === 1
  ) {
    return "applied";
  }
  return "mixed";
}

function modelSettingsStateSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "hasManagedNewThreadSettings:",
    "setModelAndReasoningEffortForNextTurn:",
    "No conversation available for next-turn model update",
    "reasoningEffort:",
    "serviceTier:",
  ]);
}

function modelSettingsOptimisticTarget(section) {
  const source = section?.source ?? "";
  const id = "[A-Za-z_$][\\w$]*";
  const pattern = new RegExp(
    `(?<selection>${id})=\\{model:(?<model>${id}),reasoningEffort:(?<effort>${id}),` +
      `serviceTier:(?<serviceTier>[^;}]+)\\};[\\s\\S]{0,400}?` +
      `(?<store>${id})\\.set\\((?<atom>${id}),(?<target>${id}),\\k<selection>\\),[\\s\\S]{0,800}?` +
      `\\.finally\\(\\(\\)=>\\{(?<cleanup>\\k<store>\\.get\\(\\k<atom>,\\k<target>\\)===` +
      `\\k<selection>&&\\k<store>\\.set\\(\\k<atom>,\\k<target>,null\\))\\}\\)`,
    "gu",
  );
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function chatGptAuthVariable(section) {
  const matches = [
    ...(section?.source ?? "").matchAll(
      /([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.authMethod===`chatgpt`/gu,
    ),
  ];
  return matches.length === 1 ? matches[0][1] : null;
}

function existingChatPresetRuntime(presets) {
  const ids = new Set();
  for (const { modelSlug, thinkingEffort } of presets) {
    ids.add(`${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`);
    ids.add(`${modelSlug}:${thinkingEffort}`);
  }
  return `const ${EXISTING_CHAT_PRESET_IDS_KEY}=new Set(${JSON.stringify([...ids])});`;
}

function existingChatOptimisticContract(source) {
  const markerCount = source.split(EXISTING_CHAT_OPTIMISTIC_MARKER).length - 1;
  const presetIdsCount = source.split(EXISTING_CHAT_PRESET_IDS_KEY).length - 1;
  const modelState = modelSettingsStateSection(source);
  if (markerCount === 0 && presetIdsCount === 0) {
    if (modelState == null) return "drifted";
    return modelSettingsOptimisticTarget(modelState) != null &&
      chatGptAuthVariable(modelState) != null
      ? "current"
      : "drifted";
  }
  if (
    markerCount === 2 &&
    presetIdsCount === 2 &&
    modelState != null &&
    modelState.source.includes(".codexLinuxKeepOptimisticSelection!==!0&&") &&
    modelState.source.includes(`&&${EXISTING_CHAT_PRESET_IDS_KEY}.has(`)
  ) {
    return "applied";
  }
  return "mixed";
}

function applyExistingChatOptimisticPatch(source, context = {}) {
  const presets = normalizePresets(context);
  if (presets.length === 0) return source;
  const contract = existingChatOptimisticContract(source);
  if (contract === "applied") return source;
  if (contract !== "current") {
    warn(
      "Could not find one coherent existing-chat optimistic model-selection contract",
      "model picker Default existing-chat selection patch",
    );
    return source;
  }

  const modelState = modelSettingsStateSection(source);
  const optimisticTarget = modelSettingsOptimisticTarget(modelState);
  const chatGptAuth = chatGptAuthVariable(modelState);
  if (optimisticTarget == null || chatGptAuth == null) {
    return source;
  }

  const { groups } = optimisticTarget;
  const patchedModelState = modelState.source.replace(
    optimisticTarget[0],
    optimisticTarget[0]
      .replace(
        `serviceTier:${groups.serviceTier}`,
        `serviceTier:${groups.serviceTier},codexLinuxKeepOptimisticSelection:${chatGptAuth}&&${groups.target}[0]===\`conversation\`&&${EXISTING_CHAT_PRESET_IDS_KEY}.has(${groups.model}+\`:\`+${groups.effort})/*${EXISTING_CHAT_OPTIMISTIC_MARKER}*/`,
      )
      .replace(
        groups.cleanup,
        `${groups.selection}.codexLinuxKeepOptimisticSelection!==!0&&${groups.cleanup}/*${EXISTING_CHAT_OPTIMISTIC_MARKER}*/`,
      ),
  );
  const patchedSource =
    source.slice(0, modelState.start) +
    existingChatPresetRuntime(presets) +
    patchedModelState +
    source.slice(modelState.end);
  if (existingChatOptimisticContract(patchedSource) !== "applied") {
    warn(
      "Could not apply the complete existing-chat optimistic model-selection contract",
      "model picker Default existing-chat selection patch",
    );
    return source;
  }
  return patchedSource;
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
  const configMatch = /sliderModelsConfig:([A-Za-z_$][\w$]*)/u.exec(section.source);
  const fallbackMatches = [...section.source.matchAll(LOCAL_COMPOSER_FALLBACK_PATTERN)];
  const selectionMatches = [...section.source.matchAll(LOCAL_COMPOSER_SELECTION_PATTERN)];
  const resetContext = localComposerResetContext(section);
  if (
    configMatch == null ||
    fallbackMatches.length !== 2 ||
    selectionMatches.length !== 1 ||
    resetContext == null
  ) {
    return source;
  }
  const configVariable = configMatch[1];
  let patchedSection = section.source.replace(
    configMatch[0],
    `sliderModelsConfig:${configVariable}==null?${configVariable}:codexLinuxLocalDefaultPresetConfig`,
  );
  patchedSection = patchedSection.replace(
    LOCAL_COMPOSER_FALLBACK_PATTERN,
    `$1=$2($3,codexLinuxLocalDefaultPresetFallback(${configVariable}!=null,$3,$4==null?void 0:\`${"${$4.model}:${$4.defaultReasoningEffort}"}\`))`,
  );
  const patchedSource =
    source.slice(0, section.start) +
    localComposerRuntime(localComposerConfig(presets)) +
    patchedSection +
    source.slice(section.end);
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
    id: "model-picker-default-presets-upstream-default-selection",
    phase: "webview-asset",
    order: 20_797,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: upstreamDefaultSelectionAssetMatch,
    missingDescription: "upstream merged model picker Default-selection bundle",
    skipDescription: "model picker upstream Default-selection compatibility audit",
    apply: (source) => source,
  },
  {
    id: "model-picker-default-presets-upstream-reset-effect",
    phase: "webview-asset",
    order: 20_797.5,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: upstreamResetEffectAssetMatch,
    missingDescription: "upstream model picker reset-effect bundle",
    skipDescription: "model picker upstream reset-effect compatibility audit",
    apply: (source) => source,
  },
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
    id: "model-picker-default-presets-existing-chat-optimistic-selection",
    phase: "webview-asset",
    order: 20_801,
    ciPolicy: "optional",
    pattern: JS_ASSET_PATTERN,
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: (source) => existingChatOptimisticContract(source) !== "drifted",
    missingDescription: "existing-chat model settings state bundle",
    skipDescription: "model picker Default existing-chat selection patch",
    apply: applyExistingChatOptimisticPatch,
  },
  {
    id: "model-picker-default-presets-local-composer-config",
    phase: "webview-asset",
    order: 20_802,
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
  EXISTING_CHAT_OPTIMISTIC_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  THINKING_EFFORT_TO_EFFORT,
  JS_ASSET_PATTERN,
  SLIDER_PATCH_MARKER,
  applyCatalogPatch,
  applyExistingChatOptimisticPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  applySliderMinimumPatch,
  catalogAssetMatch,
  catalogPatchContract,
  codexLinuxModelPickerDefaultPresets,
  descriptors,
  normalizePresets,
  existingChatOptimisticContract,
  localComposerConfig,
  localComposerConfigContract,
  localComposerResolverContract,
  sliderAssetMatch,
  sliderPatchContract,
  upstreamDefaultSelectionAssetMatch,
  upstreamResetEffectAssetMatch,
  upstreamResetEffectContract,
};
