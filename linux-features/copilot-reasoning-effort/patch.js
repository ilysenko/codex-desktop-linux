"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const NOT_IDENT = "(?![\\w$])";
const COMPILED_UI_MARKER = "codexLinuxCopilotReasoningEffortUi";
const MODEL_LIST_MARKER = "codexLinuxCopilotReasoningEffortModelList";

// rspack chunks have no stable filenames, so every owner is found by content.
const PERSISTENCE_NEEDLES = ["setDefaultModelAndReasoningEffort:", ".setDefaultModelConfig("];
const MODEL_LIST_NEEDLES = ['description:"medium effort"', "supportedReasoningEfforts"];
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

function modelListState(source) {
  const clean = findAllMatches(source, new RegExp(
    `(?<result>${JS_IDENT})=\\("copilot"===${JS_IDENT}\\?\\[(?<efforts>${JS_IDENT})\\.find\\(` +
      `(${JS_IDENT})=>"medium"===\\3\\.reasoningEffort\\)\\?\\?` +
      `\\{reasoningEffort:"medium",description:"medium effort"\\}\\]:\\k<efforts>\\)\\.filter\\(`,
  ));
  const patched = findAllMatches(source, new RegExp(
    `${JS_IDENT}=/\\*${MODEL_LIST_MARKER}\\*/\\[\\.\\.\\.${JS_IDENT}\\]\\.filter\\(`,
  ));
  if (clean.length === 1 && patched.length === 0) return { kind: "current", match: clean[0] };
  if (clean.length === 0 && patched.length === 1) return { kind: "patched" };
  return { kind: clean.length + patched.length === 0 ? "missing" : "invalid" };
}

function matchesCopilotReasoningEffortModelListContract(source) {
  const { kind } = modelListState(source);
  return kind === "current" || kind === "patched";
}

function applyCopilotReasoningEffortModelListPatch(source) {
  const state = modelListState(source);
  if (state.kind === "patched") return source;
  if (state.kind === "current") {
    const { result, efforts } = state.match.groups;
    // Copilot keeps every effort the model advertises instead of a single
    // synthetic "medium" entry; the upstream enabled-effort filter still runs.
    return spliceMatch(
      source,
      state.match,
      `${result}=/*${MODEL_LIST_MARKER}*/[...${efforts}].filter(`,
    );
  }
  warn(
    state.kind === "invalid"
      ? "Found ambiguous Copilot model reasoning effort filters"
      : "Could not find current Copilot model reasoning effort filter",
    "Copilot reasoning effort model list patch",
  );
  return source;
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
      `(?<copilot>${JS_IDENT})&&!0;`,
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
      phase: "webview-asset",
      assetNeedles: MODEL_LIST_NEEDLES,
      missingDescription: "model list bundle",
      skipDescription: "Copilot reasoning effort model list patch",
      apply: applyCopilotReasoningEffortModelListPatch,
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
  applyCopilotReasoningSlashPatch,
  matchesCopilotModelAndReasoningPersistenceContract,
  matchesCopilotReasoningEffortDropdownContract,
  matchesCopilotReasoningEffortModelListContract,
  matchesCopilotReasoningSlashContract,
  validateCopilotModelAndReasoningPersistence,
};
