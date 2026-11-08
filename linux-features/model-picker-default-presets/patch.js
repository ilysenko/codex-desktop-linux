"use strict";
const {auditPickerReset}=require("./picker-reset.js");

const {patchPresetCatalog}=require("./catalog-integration.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const catalogAuthority=require("./native-catalog-authority.js");

const SLIDER_PATCH_MARKER = "codex-linux-model-picker-default-presets-slider-minimum";
const LOCAL_DEFAULT_PATCH_MARKER = "codex-linux-model-picker-default-presets-local-default";
const LOCAL_COMPOSER_CONFIG_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-config";
const LOCAL_COMPOSER_RESOLVER_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-resolver";
const EXISTING_CHAT_OPTIMISTIC_MARKER =
  "codex-linux-model-picker-default-presets-existing-chat-optimistic-selection";
const EXISTING_CHAT_PRESET_IDS_KEY = "codexLinuxExistingChatDefaultPresetIds";
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

function functionSections(source) {
  const sections = [];
  const pattern = /function(?: [A-Za-z_$][\w$]*)?\([^)]*\)\{/g;
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

// rspack chunks register `__webpack_modules__={id(e,t,n){...},...}`; minified
// helper names repeat across module factories, so related functions are looked
// up only inside the factory that owns a matched section.
function enclosingModuleFactory(source, index) {
  const registry = "__webpack_modules__={";
  const registryStart = source.indexOf(registry);
  if (registryStart < 0 || source.indexOf(registry, registryStart + 1) >= 0) return null;
  const entry = /(?:"[^"\\]*"|[\w$]+)\([^()]*\)\{/y;
  let cursor = registryStart + registry.length;
  while (cursor < source.length && source[cursor] !== "}") {
    entry.lastIndex = cursor;
    const match = entry.exec(source);
    if (match == null) return null;
    const open = cursor + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) return null;
    if (index > open && index < close) {
      return {
        bodyStart: open + 1,
        end: close + 1,
        source: source.slice(cursor, close + 1),
        start: cursor,
      };
    }
    cursor = close + 1;
    if (source[cursor] === ",") cursor += 1;
  }
  return null;
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

function patchCatalog(extractedDir,context={},options={}) {
  return patchPresetCatalog(extractedDir,normalizePresets(context),{...catalogAuthority,reasoningEffortNames:THINKING_EFFORT_TO_EFFORT},options);
}

function sliderResolverSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "powerSelectionsWithXHigh",
    "fallbackPowerSelection",
    "show_xhigh_in_simple_picker",
    "canInitializePowerPicker",
  ]);
}

// The merged picker builds its Default option from the catalog slider settings
// alone whenever the catalog provides any; version options keep their own
// model list. The configured presets replace the catalog slider settings, so
// this owner must keep using them exclusively for Default.
function defaultOptionBuilderSection(source) {
  return uniqueFunctionWithMarkers(source, [
    "includeSyntheticDefault:",
    "paidModelFallbackEnabled:",
    ".sliderSettings?.length?",
    "defaultOption:",
  ]);
}

function upstreamDefaultSelectionContract(source) {
  const section = defaultOptionBuilderSection(source);
  const catalogParameter = new RegExp(`^function(?: ${IDENT})?\\((${IDENT}),\\{`, "u")
    .exec(section?.source ?? "")?.[1];
  if (catalogParameter == null) return "drifted";
  const catalog = escapeRegExp(catalogParameter);
  const sliderSettings = uniqueMatch(
    section.source,
    new RegExp(
      `(${IDENT})=${catalog}\\?\\.sliderSettings\\?\\.length\\?${catalog}\\.sliderSettings:${IDENT}\\(`,
      "gu",
    ),
  )?.[1];
  if (sliderSettings == null) return "drifted";
  const defaultOption = uniqueMatch(
    section.source,
    new RegExp(
      `defaultOption:${IDENT}\\|\\|${IDENT}\\?\\{\\.\\.\\.(${IDENT})\\(${catalog},${IDENT},` +
        `${escapeRegExp(sliderSettings)}\\),isDefault:!0\\}:void 0`,
      "gu",
    ),
  );
  if (defaultOption == null) return "drifted";
  // The option builder lives in the same rspack module factory and must expose
  // its third argument as the power settings.
  const moduleFactory = enclosingModuleFactory(source, section.start);
  const builders = functionSections(moduleFactory?.source ?? "").filter((candidate) =>
    candidate.source.startsWith(`function ${defaultOption[1]}(`)
  );
  if (builders.length !== 1) return "drifted";
  const builder = new RegExp(
    `^function ${escapeRegExp(defaultOption[1])}\\(${IDENT},${IDENT},(${IDENT})\\)\\{`,
    "u",
  ).exec(builders[0].source);
  return builder != null && builders[0].source.endsWith(`powerSettings:${builder[1]}}}`)
    ? "current"
    : "drifted";
}

function upstreamDefaultSelectionAssetMatch(source, _assetName, context = {}) {
  return normalizePresets(context).length > 0 &&
    upstreamDefaultSelectionContract(source) === "current";
}

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
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
  return prefix != null && prefix.source.includes("onSelectDefault:") ? prefix : null;
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
  /([A-Za-z_$][\w$]*)=(\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(([A-Za-z_$][\w$]*),null==([A-Za-z_$][\w$]*)\?void 0:`\$\{\4\.model\}:\$\{\4\.defaultReasoningEffort\}`\)/gu;
// The composer picks the slider config from one of two ChatGPT-gated sources.
const LOCAL_COMPOSER_CONFIG_PATTERN =
  /sliderModelsConfig:([A-Za-z_$][\w$]*\?[A-Za-z_$][\w$]*:[A-Za-z_$][\w$]*)(?=[,}])/gu;
const LOCAL_COMPOSER_SELECTION_PATTERN = new RegExp(
  `async function(?: (?<handler>[A-Za-z_$][\\w$]*))?\\((?<model>[A-Za-z_$][\\w$]*),(?<effort>[A-Za-z_$][\\w$]*)\\)\\{` +
    `[\\s\\S]{0,240}?let (?<normalized>[A-Za-z_$][\\w$]*)=(?<normalizer>[A-Za-z_$][\\w$]*)\\(\\k<model>\\);` +
    `await ?\\(null==(?<delegate>[A-Za-z_$][\\w$]*)\\?(?<base>[A-Za-z_$][\\w$]*)\\(\\k<normalized>,\\k<effort>\\):` +
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
    const configMatches = section.source.match(LOCAL_COMPOSER_CONFIG_PATTERN) ?? [];
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
    section.source.includes(`/*${LOCAL_COMPOSER_CONFIG_MARKER}*/`) &&
    section.source.includes(":codexLinuxLocalDefaultPresetConfig") &&
    (section.source.match(/codexLinuxLocalDefaultPresetFallback\(/g) ?? []).length >= 2 &&
    (section.source.match(/codexLinuxLocalDefaultPresetSelection\(/g) ?? []).length >= 1 &&
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
      `(?<store>${id})\\.set\\((?<atom>${id}(?:\\.${id})?),(?<target>${id}),\\k<selection>\\),[\\s\\S]{0,800}?` +
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
      /([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*\?\.authMethod===(["'`])chatgpt\2(?=[,;])/gu,
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
  let patchedModelState = modelState.source.replace(
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
  patchedModelState = patchedModelState.replace("{", `{${existingChatPresetRuntime(presets)}`);
  const patchedSource =
    source.slice(0, modelState.start) +
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
  const configMatches = [...section.source.matchAll(LOCAL_COMPOSER_CONFIG_PATTERN)];
  const configMatch = configMatches.length === 1 ? configMatches[0] : null;
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
  const configExpression = `(${configMatch[1]})`;
  let patchedSection = section.source.replace(
    configMatch[0],
    () =>
      `sliderModelsConfig:${configExpression}==null?${configExpression}:codexLinuxLocalDefaultPresetConfig`,
  );
  patchedSection = patchedSection.replace(
    LOCAL_COMPOSER_FALLBACK_PATTERN,
    (_match, result, resolver, selections, upstreamDefault) =>
      `${result}=${resolver}(${selections},codexLinuxLocalDefaultPresetFallback(` +
      `${configExpression}!=null,${selections},null==${upstreamDefault}?void 0:` +
      `\`\${${upstreamDefault}.model}:\${${upstreamDefault}.defaultReasoningEffort}\`))`,
  );
  patchedSection = patchedSection.replace(
    "{",
    `{${localComposerRuntime(localComposerConfig(presets))}`,
  );
  const patchedSource =
    source.slice(0, section.start) +
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
    assetNeedles: ["includeSyntheticDefault:", "paidModelFallbackEnabled:", ".sliderSettings?.length?"],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: upstreamDefaultSelectionAssetMatch,
    missingDescription: "upstream merged model picker Default-selection bundle",
    skipDescription: "model picker upstream Default-selection compatibility audit",
    apply: (source) => source,
  },
  {
    id: "model-picker-default-presets-upstream-reset-effect",
    phase: "extracted-app:pre-webview",
    order: 20_797.5,
    ciPolicy: "optional",
    enabled: (context = {}) => normalizePresets(context).length > 0,
    apply: (dir,context={}) => auditPickerReset(dir,normalizePresets(context).map(({modelSlug,thinkingEffort})=>`${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`)),
  },
  {
    id: "model-picker-default-presets-catalog",
    phase: "extracted-app:pre-webview",
    order: 20_798,
    ciPolicy: "optional",
    enabled: (context = {}) => {
      normalizePresets(context);
      return true;
    },
    apply: patchCatalog,
  },
  {
    id: "model-picker-default-presets-slider-minimum",
    phase: "webview-asset",
    order: 20_799,
    ciPolicy: "optional",
    assetNeedles: ["show_xhigh_in_simple_picker", "powerSelectionsWithXHigh"],
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
    assetNeedles: ["removeXHigh:", "sliderModelsConfig:", "stripGptPrefix:"],
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
    assetNeedles: [
      "No conversation available for next-turn model update",
      "setModelAndReasoningEffortForNextTurn:",
      "hasManagedNewThreadSettings:",
    ],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    missingDescription: "existing-chat model settings state bundle",
    skipDescription: "model picker Default existing-chat selection patch",
    apply: applyExistingChatOptimisticPatch,
  },
  {
    id: "model-picker-default-presets-local-composer-config",
    phase: "webview-asset",
    order: 20_802,
    ciPolicy: "optional",
    assetNeedles: [
      "composer.mode.local.model.custom",
      "sliderModelsConfig:",
      "setDefaultModelAndReasoningEffort",
      "modelsForPicker(",
    ],
    enabled: (context = {}) => normalizePresets(context).length > 0,
    assetMatch: (source) => localComposerConfigContract(source) !== "drifted",
    missingDescription: "local composer model picker bundle",
    skipDescription: "model picker Default local composer config patch",
    apply: applyLocalComposerConfigPatch,
  },
];

module.exports = {
  EFFORT_TO_THINKING_EFFORT,
  EXISTING_CHAT_OPTIMISTIC_MARKER,
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_COMPOSER_RESOLVER_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  THINKING_EFFORT_TO_EFFORT,
  SLIDER_PATCH_MARKER,
  patchCatalog,
  applyExistingChatOptimisticPatch,
  applyLocalComposerConfigPatch,
  applyLocalComposerResolverPatch,
  applySliderMinimumPatch,
  descriptors,
  normalizePresets,
  existingChatOptimisticContract,
  localComposerConfig,
  localComposerConfigContract,
  localComposerResolverContract,
  sliderAssetMatch,
  sliderPatchContract,
  upstreamDefaultSelectionAssetMatch,
  upstreamDefaultSelectionContract,
};
