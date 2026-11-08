"use strict";
const {auditPickerReset,patchPickerSlider}=require("./picker-reset.js");

const {patchLocalResolver}=require("./local-resolver.js");
const {patchExistingChatSelections}=require("./existing-chat-selection.js");
const {patchPresetCatalog}=require("./catalog-integration.js");
const DefaultSelection=require("./upstream-default-selection.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const catalogAuthority=require("./native-catalog-authority.js");

const LOCAL_DEFAULT_PATCH_MARKER = "codex-linux-model-picker-default-presets-local-default";
const LOCAL_COMPOSER_CONFIG_MARKER =
  "codex-linux-model-picker-default-presets-local-composer-config";
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

// Read-only current Default routing audit. The feature-local owner qualifies
// original factory authority and every physical owner/dependency copy.
function upstreamDefaultSelectionContract(source,context={}) {
  return DefaultSelection.upstreamDefaultSelectionContract(source,context);
}
function upstreamDefaultSelectionAssetMatch(source,_assetName,context={}) {
  return normalizePresets(context).length>0&&upstreamDefaultSelectionContract(source,context)==="current";
}
function inspectUpstreamDefaultSelectionOwner(source,snapshot) {
  return DefaultSelection.inspectUpstreamDefaultSelectionOwner(source,snapshot);
}
function auditUpstreamDefaultSelection(extractedDir,context={},options={}) {
  return DefaultSelection.auditUpstreamDefaultSelection(extractedDir,normalizePresets(context),options);
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

function patchExistingChatSelection(extractedDir,context={},options={}) {
  return patchExistingChatSelections(extractedDir,normalizePresets(context),THINKING_EFFORT_TO_EFFORT,context,options);
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

const descriptors = [
  {
    id: "model-picker-default-presets-upstream-default-selection",
    phase: "extracted-app:pre-webview",
    order: 20_797,
    ciPolicy: "optional",
    enabled: (context = {}) => normalizePresets(context).length > 0,
    apply: auditUpstreamDefaultSelection,
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
    phase: "extracted-app:pre-webview",
    order: 20_799,
    ciPolicy: "optional",
    enabled: (context = {}) => normalizePresets(context).length > 0,
    apply: (dir,context={}) => patchPickerSlider(dir,normalizePresets(context).map(({modelSlug,thinkingEffort})=>`${modelSlug}:${THINKING_EFFORT_TO_EFFORT[thinkingEffort]}`)),
  },
  {
    id: "model-picker-default-presets-local-composer-resolver",
    phase: "extracted-app:pre-webview",
    order: 20_800,
    ciPolicy: "optional",
    enabled: (context = {}) => normalizePresets(context).length > 0,
    apply: (dir) => patchLocalResolver(dir),
  },
  {
    id: "model-picker-default-presets-existing-chat-optimistic-selection",
    phase: "extracted-app:pre-webview",
    order: 20_801,
    ciPolicy: "optional",
    enabled: (context = {}) => normalizePresets(context).length > 0,
    apply: patchExistingChatSelection,
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
  LOCAL_COMPOSER_CONFIG_MARKER,
  LOCAL_DEFAULT_PATCH_MARKER,
  THINKING_EFFORT_TO_EFFORT,
  patchCatalog,
  patchExistingChatSelection,
  applyLocalComposerConfigPatch,
  descriptors,
  normalizePresets,
  localComposerConfig,
  localComposerConfigContract,
  upstreamDefaultSelectionAssetMatch,
  upstreamDefaultSelectionContract,
  inspectUpstreamDefaultSelectionOwner,
  auditUpstreamDefaultSelection,
};
