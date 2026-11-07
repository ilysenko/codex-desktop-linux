"use strict";

const path = require("node:path");
const { inspectModelCatalogOwner } = require("../../scripts/patches/lib/model-composer-owners.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const {
  findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories,
} = require("../../scripts/patches/lib/rspack-module-assets.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const NOT_IDENT = "(?![\\w$])";
const COMPILED_UI_MARKER = "codexLinuxCopilotReasoningEffortUi";
const MODEL_LIST_MARKER = "codexLinuxCopilotReasoningEffortModelList";

// rspack chunks have no stable filenames, so every owner is found by content.
const PERSISTENCE_NEEDLES = ["setDefaultModelAndReasoningEffort:", ".setDefaultModelConfig("];
const MODEL_LIST_NEEDLES = ["additionalAvailableModels:", "enabledReasoningEfforts:", "hasConfiguredModelCatalog:", "useHiddenModels:"];
const MODEL_LIST_DESCRIPTION = "Copilot model reasoning effort catalog";
const DROPDOWN_NEEDLES = ["reasoningEffortDisabled:", "?.disabledReason!=null"];
const SLASH_NEEDLES = [
  'id:"composer.reasoningSlashCommand.title"',
  "requiresEmptyComposer",
  'authMethod==="copilot"',
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findAllMatches(source, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.matchAll(new RegExp(regex.source, flags))];
}

function spliceMatch(source, match, replacement) {
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

function warn(message, skipDescription) {
  console.warn(`WARN: ${message} - skipping ${skipDescription}`);
}

// --- Persistence owner (validation only) ------------------------------------

// Upstream persists Copilot model and effort selections through its model
// settings hook. The hook is copied into every composer surface chunk; each
// copy must still write the default through setDefaultModelConfig and route
// both the "default" and "current" scopes through the same writer.
function matchesCopilotModelAndReasoningPersistenceContract(source) {
  const exportedMatches = findAllMatches(source, new RegExp(
    `setDefaultModelAndReasoningEffort:${JS_IDENT},` +
      `setModelAndReasoningEffortForNextTurn:${JS_IDENT},` +
      `setModelAndReasoningEffort:${JS_IDENT},modelSettings:${JS_IDENT}`,
  ));
  if (exportedMatches.length !== 1) return false;

  const match = exportedMatches[0];
  const ownerRegion = source.slice(Math.max(0, match.index - 6_000), match.index + match[0].length);
  const defaultWrites = findAllMatches(
    ownerRegion,
    new RegExp(`\\.setDefaultModelConfig\\(${JS_IDENT},${JS_IDENT},${JS_IDENT}\\.profile\\)`),
  );
  const defaultWrappers = findAllMatches(
    ownerRegion,
    new RegExp(`=>(${JS_IDENT})\\(${JS_IDENT},${JS_IDENT},"default"\\)`),
  );
  const currentWrappers = findAllMatches(
    ownerRegion,
    new RegExp(`=>(${JS_IDENT})\\(${JS_IDENT},${JS_IDENT},"current",${JS_IDENT}\\)`),
  );
  return defaultWrites.length === 1 &&
    defaultWrappers.length === 1 &&
    currentWrappers.length === 1 &&
    defaultWrappers[0][1] === currentWrappers[0][1];
}

function validateCopilotModelAndReasoningPersistence(source) {
  if (!matchesCopilotModelAndReasoningPersistenceContract(source)) {
    warn(
      "Could not find current model-and-reasoning persistence owner",
      "Copilot reasoning effort persistence validation",
    );
  }
  return source;
}

// --- Model catalog ------------------------------------------------------------

function modelListMarkerCount(source) {
  return source.split(MODEL_LIST_MARKER).length - 1;
}

function identifiesModelList(source) {
  return source.includes(MODEL_LIST_MARKER) || MODEL_LIST_NEEDLES.every(needle => source.includes(needle));
}

function requireModelListRegistry(source) {
  const headers = [...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];
  if (headers.length !== 1) throw new Error(`Missing or ambiguous ${MODEL_LIST_DESCRIPTION} registry`);
  const [header] = headers;
  const prefix = createJavaScriptLexicalIndex(source.slice(0, header.index + header[0].length));
  if (!prefix.isRoot(header.index)) throw new Error(`Opaque or nested ${MODEL_LIST_DESCRIPTION} registry`);
}

function inspectModelList(module) {
  const owner = inspectModelCatalogOwner(module);
  if (!owner.ok) throw new Error(`Unsupported ${MODEL_LIST_DESCRIPTION}: ${owner.reason}`);
  const { sourceEfforts, filteredEfforts, enabledFilter, sourceRange } = owner.normalization;
  const source = module.moduleSource;
  const sourceExpression = source.slice(sourceRange.start, sourceRange.end);
  const effort = new RegExp(`\\.filter\\(\\(\\{reasoningEffort:(${JS_IDENT})\\}\\)=>"ultra"!==\\1\\)$`).exec(sourceExpression)?.[1];
  const captured = [owner.inputs.auth, owner.inputs.ultra, owner.inputs.enabled];
  const outputRange = owner.normalization.outputRange;
  const ifOpen = owner.visibility.call.end + 1;
  if (source.slice(owner.visibility.call.end, sourceRange.start) !== "){let " ||
      owner.visibility.owner.start !== owner.loop.range.end ||
      createJavaScriptLexicalIndex(source).matchingBrace(ifOpen) !== outputRange.end ||
      source.slice(sourceRange.end, enabledFilter.start) !== "," ||
      source.slice(enabledFilter.end, outputRange.start) !== ",") {
    throw new Error(`Unsupported ${MODEL_LIST_DESCRIPTION} normalization flow`);
  }
  if (effort == null || captured.includes(owner.loop.model) ||
      new Set([sourceEfforts, filteredEfforts, owner.normalization.output]).size !== 3 ||
      [sourceEfforts, filteredEfforts, owner.normalization.output].some(name => captured.includes(name) || name === owner.loop.model)) {
    throw new Error(`Unsupported ${MODEL_LIST_DESCRIPTION} effort bindings`);
  }
  // The branch and its inverse use the same current compiler-local effort
  // binding already established by the native ultra filter. A marker alone
  // cannot claim an applied state or choose a different model/auth input.
  const native = `("copilot"===${owner.inputs.auth}?[${sourceEfforts}.find(${effort}=>"medium"===${effort}.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:${sourceEfforts})`;
  const contribution = `/*${MODEL_LIST_MARKER}*/[...${sourceEfforts}]`;
  const filter = source.slice(enabledFilter.start, enabledFilter.end);
  const prefix = `${filteredEfforts}=`;
  const suffix = filter.slice(filter.lastIndexOf(".filter("));
  const current = prefix + native + suffix;
  const patched = prefix + contribution + suffix;
  const applied = filter === patched && modelListMarkerCount(source) === 1;
  if (!applied && (filter !== current || modelListMarkerCount(source) !== 0)) {
    throw new Error(`Unsupported or noncanonical ${MODEL_LIST_DESCRIPTION} effort filter`);
  }
  if (applied) {
    const inverse = source.slice(0, enabledFilter.start) + current + source.slice(enabledFilter.end);
    if (!inspectModelCatalogOwner({ ...module, moduleSource: inverse }).ok ||
        modelListMarkerCount(inverse) !== 0) throw new Error(`Invalid ${MODEL_LIST_DESCRIPTION} inverse`);
  }
  return { applied, range: enabledFilter, patched };
}

function patchModelListFactory(source, snapshot) {
  const module = { ...snapshot, moduleSource: source };
  const state = inspectModelList(module);
  if (state.applied) return source;
  const patched = source.slice(0, state.range.start) + state.patched + source.slice(state.range.end);
  if (!inspectModelList({ ...module, moduleSource: patched }).applied) {
    throw new Error(`Incomplete ${MODEL_LIST_DESCRIPTION} insertion`);
  }
  return patched;
}

function applyCopilotReasoningEffortModelListPatch(source, context = {}) {
  if (context.factorySnapshot != null) {
    if (context.factorySnapshot.moduleSource !== source) throw new Error("Stale Copilot model catalog factory snapshot");
    return patchModelListFactory(source, context.factorySnapshot);
  }
  requireModelListRegistry(source);
  const candidates = [...rspackModuleFactories(source, "copilot-model-catalog.js")]
    .filter(module => identifiesModelList(module.moduleSource) && inspectModelCatalogOwner(module).ok);
  if (candidates.length !== 1) throw new Error(`Missing or ambiguous ${MODEL_LIST_DESCRIPTION} factory`);
  const [module] = candidates;
  if (modelListMarkerCount(source) !== modelListMarkerCount(module.moduleSource)) {
    throw new Error(`Orphan ${MODEL_LIST_DESCRIPTION} marker`);
  }
  return source.slice(0, module.start) + patchModelListFactory(module.moduleSource, module) + source.slice(module.end);
}

function matchesCopilotReasoningEffortModelListContract(source, context = {}) {
  try { applyCopilotReasoningEffortModelListPatch(source, context); return true; }
  catch { return false; }
}

function applyCopilotReasoningEffortModelListAppPatch(extractedDir, _context = {}, options = {}) {
  const assets = path.join(extractedDir, "webview", "assets"), markerAssets = new Set();
  const copies = findUniqueRspackModuleCopies(assets, {
    description: MODEL_LIST_DESCRIPTION,
    sourceMatch(source, name) {
      if (source.includes(MODEL_LIST_MARKER)) markerAssets.add(name);
      return identifiesModelList(source);
    },
    matchModule: (source, module) => identifiesModelList(source) && inspectModelCatalogOwner(module).ok,
  });
  for (const copy of copies) {
    requireModelListRegistry(copy.source);
    inspectModelList(copy);
    if (modelListMarkerCount(copy.source) !== modelListMarkerCount(copy.moduleSource)) {
      throw new Error(`Orphan ${MODEL_LIST_DESCRIPTION} marker`);
    }
    markerAssets.delete(copy.assetName);
  }
  if (markerAssets.size > 0) throw new Error(`Orphan ${MODEL_LIST_DESCRIPTION} marker in ${[...markerAssets].join(", ")}`);
  return patchRspackModuleCopies(assets, copies, patchModelListFactory, options);
}

// --- Composer reasoning effort dropdown --------------------------------------

function analyzeCompiledCopilotReasoningEffortUiContract(source) {
  const modelExpression =
    `${JS_IDENT}\\?\\.find\\(${JS_IDENT}=>\\{let\\{model:${JS_IDENT}\\}=${JS_IDENT};` +
    `return ${JS_IDENT}\\.model===${JS_IDENT}\\}\\)\\?\\.disabledReason!=null`;
  const cleanMatches = findAllMatches(source, new RegExp(
    `(?<disabled>${JS_IDENT})=(?<host>${JS_IDENT})\\?\\.authMethod==="copilot"\\|\\|` +
      `(?<modelExpression>${modelExpression})`,
  ));
  const patchedMatches = findAllMatches(source, new RegExp(
    `(?<disabled>${JS_IDENT})=/\\*${COMPILED_UI_MARKER}\\*/(?<modelExpression>${modelExpression})`,
  ));
  const combinedMatches = [...cleanMatches, ...patchedMatches];
  if (combinedMatches.length !== 1) {
    return {
      state: "invalid",
      warning: combinedMatches.length === 0
        ? "Could not find current compiled Copilot reasoning effort gate"
        : "Found duplicate current compiled Copilot reasoning effort gates",
    };
  }

  // The combined gate must reach the dropdown through one later
  // `dropdown=<locked>||<combined>||...` assignment in the same composer.
  const combinedMatch = combinedMatches[0];
  const after = source.slice(combinedMatch.index + combinedMatch[0].length, combinedMatch.index + 60_000);
  const dropdownGates = findAllMatches(after, new RegExp(
    `[,;](?<dropdown>${JS_IDENT})=${JS_IDENT}\\|\\|` +
      `${escapeRegExp(combinedMatch.groups.disabled)}${NOT_IDENT}`,
  ));
  const consumers = dropdownGates.filter((gate) => findAllMatches(
    after.slice(gate.index, gate.index + 20_000),
    new RegExp(`reasoningEffortDisabled:${escapeRegExp(gate.groups.dropdown)}${NOT_IDENT}`),
  ).length === 1);
  if (dropdownGates.length !== 1 || consumers.length !== 1) {
    return {
      state: "invalid",
      warning: dropdownGates.length > 1
        ? "Found duplicate current compiled Copilot reasoning effort dropdown gates"
        : "Could not find current compiled Copilot reasoning effort dropdown gate",
    };
  }

  return {
    state: cleanMatches.length === 1 ? "pristine" : "patched",
    combinedMatch,
  };
}

function matchesCopilotReasoningEffortDropdownContract(source) {
  return analyzeCompiledCopilotReasoningEffortUiContract(source).state !== "invalid";
}

function applyCopilotReasoningEffortDropdownPatch(source) {
  const contract = analyzeCompiledCopilotReasoningEffortUiContract(source);
  if (contract.state === "patched") return source;
  if (contract.state === "pristine") {
    const { disabled, modelExpression } = contract.combinedMatch.groups;
    const patched = spliceMatch(
      source,
      contract.combinedMatch,
      `${disabled}=/*${COMPILED_UI_MARKER}*/${modelExpression}`,
    );
    if (analyzeCompiledCopilotReasoningEffortUiContract(patched).state === "patched") return patched;
    contract.warning = "Compiled Copilot reasoning effort dropdown patch did not produce one coherent patched contract";
  }
  warn(contract.warning, "Copilot reasoning effort dropdown patch");
  return source;
}

// --- /reasoning slash command --------------------------------------------------

function analyzeCompiledCopilotReasoningSlashContract(source) {
  const clean = findAllMatches(source, new RegExp(
    `let (?<enabled>${JS_IDENT})=(?<requires>${JS_IDENT})&&(?<ready>${JS_IDENT})&&!` +
      `(?<copilot>${JS_IDENT});`,
  ));
  const patched = findAllMatches(source, new RegExp(
    `let (?<enabled>${JS_IDENT})=(?<requires>${JS_IDENT})&&(?<ready>${JS_IDENT})&&!0` +
      `/\\*${COMPILED_UI_MARKER}\\*/;`,
  ));
  const commandOwned = (match) => new RegExp(
    `\\{id:"reasoning",title:${JS_IDENT},[^{}]{0,200}requiresEmptyComposer:!1,` +
      `[^{}]{0,200}enabled:${escapeRegExp(match.groups.enabled)}${NOT_IDENT}`,
  ).test(source.slice(match.index, match.index + 2_000));
  const authOwned = (match) => match.groups.copilot == null || new RegExp(
    `[,;]${escapeRegExp(match.groups.copilot)}=${JS_IDENT}\\?\\.authMethod==="copilot"[,;]`,
  ).test(source.slice(Math.max(0, match.index - 3_000), match.index));
  const commandGates = [...clean, ...patched].filter(commandOwned);
  const cleanOwned = clean.filter((match) => commandOwned(match) && authOwned(match));
  const patchedOwned = patched.filter(commandOwned);
  const matches = [...cleanOwned, ...patchedOwned];
  if (matches.length !== 1) {
    return {
      state: "invalid",
      warning: commandGates.length > 1
        ? "Found duplicate current compiled Copilot reasoning slash command gates"
        : commandGates.length === 1
          ? "Could not find current compiled Copilot reasoning slash command auth gate"
          : "Could not find current compiled Copilot reasoning slash command gate",
    };
  }
  return {
    state: cleanOwned.length === 1 ? "pristine" : "patched",
    slashMatch: matches[0],
  };
}

function matchesCopilotReasoningSlashContract(source) {
  return analyzeCompiledCopilotReasoningSlashContract(source).state !== "invalid";
}

function applyCopilotReasoningSlashPatch(source) {
  const contract = analyzeCompiledCopilotReasoningSlashContract(source);
  if (contract.state === "patched") return source;
  if (contract.state === "pristine") {
    const { enabled, requires, ready } = contract.slashMatch.groups;
    const patched = spliceMatch(
      source,
      contract.slashMatch,
      `let ${enabled}=${requires}&&${ready}&&!0/*${COMPILED_UI_MARKER}*/;`,
    );
    if (analyzeCompiledCopilotReasoningSlashContract(patched).state === "patched") return patched;
    contract.warning = "Compiled Copilot reasoning slash command patch did not produce one coherent patched contract";
  }
  warn(contract.warning, "Copilot reasoning slash command patch");
  return source;
}

module.exports = {
  descriptors: [
    {
      id: "persistence-contract",
      name: "copilot-reasoning-effort-persistence-contract",
      phase: "webview-asset",
      assetNeedles: PERSISTENCE_NEEDLES,
      missingDescription: "current model-and-reasoning persistence owner",
      skipDescription: "Copilot reasoning effort persistence validation",
      apply: validateCopilotModelAndReasoningPersistence,
    },
    {
      id: "model-list",
      name: "copilot-reasoning-effort-model-list",
      phase: "extracted-app:pre-webview",
      order: 20570,
      ciPolicy: "optional",
      apply: applyCopilotReasoningEffortModelListAppPatch,
    },
    {
      id: "ui-dropdown",
      name: "copilot-reasoning-effort-ui-dropdown",
      phase: "webview-asset",
      assetNeedles: DROPDOWN_NEEDLES,
      missingDescription: "current reasoning effort dropdown owner",
      skipDescription: "Copilot reasoning effort dropdown patch",
      apply: applyCopilotReasoningEffortDropdownPatch,
    },
    {
      id: "ui-slash-command",
      name: "copilot-reasoning-effort-ui-slash-command",
      phase: "webview-asset",
      assetNeedles: SLASH_NEEDLES,
      missingDescription: "current reasoning slash command owner",
      skipDescription: "Copilot reasoning slash command patch",
      apply: applyCopilotReasoningSlashPatch,
    },
  ],
  applyCopilotReasoningEffortDropdownPatch,
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortModelListAppPatch,
  MODEL_LIST_NEEDLES,
  applyCopilotReasoningSlashPatch,
  matchesCopilotModelAndReasoningPersistenceContract,
  matchesCopilotReasoningEffortDropdownContract,
  matchesCopilotReasoningEffortModelListContract,
  matchesCopilotReasoningSlashContract,
  validateCopilotModelAndReasoningPersistence,
};
