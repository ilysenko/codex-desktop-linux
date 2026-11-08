"use strict";
const {auditPickerReset,patchPickerSlider}=require("./picker-reset.js");

const {patchLocalResolver}=require("./local-resolver.js");
const {patchExistingChatSelections}=require("./existing-chat-selection.js");
const {patchPresetCatalog}=require("./catalog-integration.js");
const DefaultSelection=require("./upstream-default-selection.js");
const ComposerConfig=require("./composer-config.js");

const catalogAuthority=require("./native-catalog-authority.js");

const LOCAL_COMPOSER_CONFIG_MARKER=ComposerConfig.MARKER;
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

function localComposerConfig(presets){return ComposerConfig.composerConfig(presets,THINKING_EFFORT_TO_EFFORT);}
function localComposerConfigContract(source,context={}){return ComposerConfig.composerConfigContract(source,normalizePresets(context),THINKING_EFFORT_TO_EFFORT);}
function applyLocalComposerConfigPatch(source,context={}){return ComposerConfig.applyComposerConfigAsset(source,normalizePresets(context),THINKING_EFFORT_TO_EFFORT);}
function patchLocalComposerConfig(dir,context={},options={}){return ComposerConfig.patchComposerConfig(dir,normalizePresets(context),THINKING_EFFORT_TO_EFFORT,options);}

function patchExistingChatSelection(extractedDir,context={},options={}) {
  return patchExistingChatSelections(extractedDir,normalizePresets(context),THINKING_EFFORT_TO_EFFORT,context,options);
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
    phase: "extracted-app:pre-webview",
    order: 20_802,
    ciPolicy: "optional",
    enabled: (context = {}) => normalizePresets(context).length > 0,
    apply: patchLocalComposerConfig,
  },
];

module.exports = {
  EFFORT_TO_THINKING_EFFORT,
  LOCAL_COMPOSER_CONFIG_MARKER,
  THINKING_EFFORT_TO_EFFORT,
  patchCatalog,
  patchExistingChatSelection,
  applyLocalComposerConfigPatch,
  patchLocalComposerConfig,
  descriptors,
  normalizePresets,
  localComposerConfig,
  localComposerConfigContract,
  upstreamDefaultSelectionAssetMatch,
  upstreamDefaultSelectionContract,
  inspectUpstreamDefaultSelectionOwner,
  auditUpstreamDefaultSelection,
};
