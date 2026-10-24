"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const BT = "`";
const COMPILED_UI_MARKER = "codexLinuxCopilotReasoningEffortUi";

function matchesCopilotModelAndReasoningPersistenceContract(source) {
  const exportedContract = new RegExp(
    `setDefaultModelAndReasoningEffort:${JS_IDENT},` +
      `setModelAndReasoningEffortForNextTurn:${JS_IDENT},` +
      `setModelAndReasoningEffort:${JS_IDENT},modelSettings:${JS_IDENT}`,
    "g",
  );
  const exportedMatches = findAllMatches(source, exportedContract);
  if (exportedMatches.length !== 1) return false;

  const match = exportedMatches[0];
  const ownerRegion = source.slice(Math.max(0, match.index - 6_000), match.index + match[0].length);
  const defaultWriteMatches = findAllMatches(
    ownerRegion,
    new RegExp(`\\.setDefaultModelConfig\\(${JS_IDENT},${JS_IDENT},${JS_IDENT}\\.profile\\)`),
  );
  const defaultWrapperMatches = findAllMatches(
    ownerRegion,
    new RegExp(`=>${JS_IDENT}\\(${JS_IDENT},${JS_IDENT},${BT}default${BT}\\)`),
  );
  const currentWrapperMatches = findAllMatches(
    ownerRegion,
    new RegExp(`=>${JS_IDENT}\\(${JS_IDENT},${JS_IDENT},${BT}current${BT},${JS_IDENT}\\)`),
  );
  return defaultWriteMatches.length === 1 &&
    defaultWrapperMatches.length === 1 &&
    currentWrapperMatches.length === 1;
}

function matchesCopilotReasoningEffortModelListContract(source) {
  const clean = new RegExp(
    `${JS_IDENT}=\\(${JS_IDENT}===${BT}copilot${BT}\\?\\[${JS_IDENT}\\.find\\([^)]*\\)\\?\\?` +
      `\\{reasoningEffort:${BT}medium${BT},description:${BT}medium effort${BT}\\}\\]:${JS_IDENT}\\)\\.filter\\(`,
  );
  const patched = new RegExp(`${JS_IDENT}=\\[\\.\\.\\.${JS_IDENT}\\]\\.filter\\(\\(\\{reasoningEffort:`);
  return clean.test(source) || patched.test(source);
}

function matchesCopilotReasoningEffortUiContract(source) {
  return analyzeCopilotReasoningEffortUiContract(source).state !== "invalid";
}

function matchesCopilotReasoningEffortDropdownContract(source) {
  const contract = analyzeCompiledCopilotReasoningEffortUiContract(source);
  return contract != null && contract.state !== "invalid";
}

function matchesCopilotReasoningSlashContract(source) {
  const contract = analyzeCompiledCopilotReasoningSlashContract(source);
  return contract != null && contract.state !== "invalid";
}

function findAllMatches(source, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.matchAll(new RegExp(regex.source, flags))];
}

function findCompiledNamedFunctionOwner(source, index) {
  const declaration = new RegExp(`function ${JS_IDENT}\\([^)]*\\)\\{`, "g");
  let ownerStart = null;
  for (const match of source.matchAll(declaration)) {
    if (match.index > index) break;
    ownerStart = match.index;
  }
  if (ownerStart == null) return null;

  const nextDeclaration = new RegExp(`\\}function ${JS_IDENT}\\(`, "g");
  nextDeclaration.lastIndex = index;
  const ownerEnd = nextDeclaration.exec(source);
  if (ownerEnd == null) return null;

  return {
    start: ownerStart,
    end: ownerEnd.index + 1,
  };
}

function analyzeCompiledCopilotReasoningEffortUiContract(source) {
  if (
    !source.includes("reasoningEffortDisabled:") ||
    (!source.includes("authMethod===`copilot`") && !source.includes(COMPILED_UI_MARKER))
  ) {
    return null;
  }

  const modelExpression =
    `${JS_IDENT}\\?\\.find\\(${JS_IDENT}=>\\{let\\{model:${JS_IDENT}\\}=${JS_IDENT};` +
    `return ${JS_IDENT}\\.model===${JS_IDENT}\\}\\)\\?\\.disabledReason!=null`;
  const cleanCombined = new RegExp(
    `(?<disabled>${JS_IDENT})=(?<host>${JS_IDENT})\\?\\.authMethod===${BT}copilot${BT}\\|\\|` +
      `(?<modelExpression>${modelExpression})`,
  );
  const patchedCombined = new RegExp(
    `(?<disabled>${JS_IDENT})=/\\*${COMPILED_UI_MARKER}\\*/(?<modelExpression>${modelExpression})`,
  );
  const cleanCombinedMatches = findAllMatches(source, cleanCombined);
  const patchedCombinedMatches = findAllMatches(source, patchedCombined);
  const combinedMatches = [...cleanCombinedMatches, ...patchedCombinedMatches];
  if (combinedMatches.length !== 1) {
    return {
      state: "invalid",
      warning: combinedMatches.length === 0
        ? "Could not find current compiled Copilot reasoning effort gate"
        : "Found duplicate current compiled Copilot reasoning effort gates",
    };
  }

  const combinedMatch = combinedMatches[0];
  const owner = findCompiledNamedFunctionOwner(source, combinedMatch.index);
  if (owner == null) {
    return {
      state: "invalid",
      warning: "Could not find current compiled Copilot reasoning effort composer owner",
    };
  }
  const ownerAfterCombined = source.slice(combinedMatch.index, owner.end);
  const dropdownGate = new RegExp(
    `(?<dropdown>${JS_IDENT})=${JS_IDENT}\\|\\|${combinedMatch.groups.disabled}` +
      `[\\s\\S]{0,7000}?reasoningEffortDisabled:\\k<dropdown>`,
  );
  const dropdownGateMatches = findAllMatches(ownerAfterCombined, dropdownGate);
  if (dropdownGateMatches.length !== 1) {
    return {
      state: "invalid",
      warning: dropdownGateMatches.length === 0
        ? "Could not find current compiled Copilot reasoning effort dropdown gate"
        : "Found duplicate current compiled Copilot reasoning effort dropdown gates",
    };
  }

  const pristine = cleanCombinedMatches.length === 1;
  const patched = patchedCombinedMatches.length === 1;
  return {
    state: pristine ? "pristine" : "patched",
    contract: "dropdown",
    combinedMatch,
  };
}

function analyzeCompiledCopilotReasoningSlashContract(source) {
  if (
    !source.includes("composer.reasoningSlashCommand.title") ||
    !source.includes("authMethod===`copilot`")
  ) {
    return null;
  }
  const cleanSlash = new RegExp(
    `(?<enabled>${JS_IDENT})=(?<requires>${JS_IDENT})&&(?<ready>${JS_IDENT})&&!` +
      `(?<copilot>${JS_IDENT})&&!0,(?<dependencies>${JS_IDENT});`,
  );
  const patchedSlash = new RegExp(
    `(?<enabled>${JS_IDENT})=(?<requires>${JS_IDENT})&&(?<ready>${JS_IDENT})&&!0` +
      `/\\*${COMPILED_UI_MARKER}\\*/,(?<dependencies>${JS_IDENT});`,
  );
  const cleanSlashMatches = findAllMatches(source, cleanSlash);
  const patchedSlashMatches = findAllMatches(source, patchedSlash);
  const slashMatches = [...cleanSlashMatches, ...patchedSlashMatches];
  if (slashMatches.length !== 1) {
    return {
      state: "invalid",
      warning: slashMatches.length === 0
        ? "Could not find current compiled Copilot reasoning slash command gate"
        : "Found duplicate current compiled Copilot reasoning slash command gates",
    };
  }

  if (cleanSlashMatches.length === 1) {
    const owner = findCompiledNamedFunctionOwner(source, cleanSlashMatches[0].index);
    if (owner == null) {
      return {
        state: "invalid",
        warning: "Could not find current compiled Copilot reasoning slash command owner",
      };
    }
    const copilotVar = cleanSlashMatches[0].groups.copilot;
    const copilotDeclaration = new RegExp(
      `${copilotVar}=${JS_IDENT}\\?\\.authMethod===${BT}copilot${BT}`,
    );
    if (!copilotDeclaration.test(source.slice(owner.start, owner.end))) {
      return {
        state: "invalid",
        warning: "Could not find current compiled Copilot reasoning slash command auth gate",
      };
    }
  }

  return {
    state: cleanSlashMatches.length === 1 ? "pristine" : "patched",
    contract: "slash",
    slashMatch: slashMatches[0],
  };
}

function analyzeCopilotReasoningEffortUiContract(source) {
  const compiled = analyzeCompiledCopilotReasoningEffortUiContract(source) ??
    analyzeCompiledCopilotReasoningSlashContract(source);
  return compiled ?? {
    state: "invalid",
    warning: "Could not find current compiled Copilot reasoning effort UI contract",
  };
}

function applyCopilotReasoningEffortModelListPatch(currentSource) {
  const currentCopilotReasoningFilterRegex =
    /([A-Za-z_$][\w$]*)=\(([A-Za-z_$][\w$]*)===`copilot`\?\[([A-Za-z_$][\w$]*)\.find\([^)]*\)\?\?\{reasoningEffort:`medium`,description:`medium effort`\}\]:\3\)\.filter\(/g;
  const patchedCurrentCopilotReasoningFilterRegex =
    /[A-Za-z_$][\w$]*=\[\.\.\.[A-Za-z_$][\w$]*\]\.filter\(\(\{reasoningEffort:/;

  if (currentCopilotReasoningFilterRegex.test(currentSource)) {
    return currentSource.replace(
      currentCopilotReasoningFilterRegex,
      (_match, resultVar, _authMethodVar, effortsVar) => `${resultVar}=[...${effortsVar}].filter(`,
    );
  }
  if (patchedCurrentCopilotReasoningFilterRegex.test(currentSource)) {
    return currentSource;
  }

  if (currentSource.includes("reasoningEffort:`medium`") && currentSource.includes("supportedReasoningEfforts")) {
    console.warn(
      "WARN: Could not find current Copilot model reasoning effort filter - skipping Copilot reasoning effort model list patch",
    );
  }
  return currentSource;
}

function applyCopilotReasoningEffortUiPatch(currentSource) {
  const contract = analyzeCopilotReasoningEffortUiContract(currentSource);
  if (contract.state === "invalid") {
    console.warn(`WARN: ${contract.warning} - skipping current UI patch`);
    return currentSource;
  }
  if (contract.state === "patched") {
    return currentSource;
  }

  const combined = contract.combinedMatch?.groups;
  const slash = contract.slashMatch?.groups;
  let patchedSource = contract.contract === "dropdown"
    ? currentSource.replace(
      contract.combinedMatch[0],
      `${combined.disabled}=/*${COMPILED_UI_MARKER}*/${combined.modelExpression}`,
    )
    : currentSource.replace(
      contract.slashMatch[0],
      `${slash.enabled}=${slash.requires}&&${slash.ready}&&!0/*${COMPILED_UI_MARKER}*/,${slash.dependencies};`,
    );
  if (analyzeCopilotReasoningEffortUiContract(patchedSource).state === "patched") {
    return patchedSource;
  }
  console.warn(
    "WARN: Compiled Copilot reasoning effort UI patch did not produce one coherent patched contract - skipping current UI patch",
  );
  return currentSource;
}

module.exports = {
  descriptors: [
    {
      id: "persistence-contract",
      name: "copilot-reasoning-effort-persistence-contract",
      phase: "webview-asset",
      pattern: /^(?!locale-)[A-Za-z0-9_-]+\.js$/,
      assetMatch: matchesCopilotModelAndReasoningPersistenceContract,
      missingDescription: "current model-and-reasoning persistence owner",
      skipDescription: "Copilot reasoning effort persistence validation",
      apply: (source) => source,
    },
    {
      id: "model-list",
      name: "copilot-reasoning-effort-model-list",
      phase: "webview-asset",
      pattern: /^app-initial-[^.]+\.js$/,
      assetMatch: matchesCopilotReasoningEffortModelListContract,
      missingDescription: "model list bundle",
      skipDescription: "Copilot reasoning effort model list patch",
      apply: applyCopilotReasoningEffortModelListPatch,
    },
    {
      id: "ui-dropdown",
      name: "copilot-reasoning-effort-ui-dropdown",
      phase: "webview-asset",
      pattern: /^(?!locale-)[A-Za-z0-9_-]+\.js$/,
      assetMatch: matchesCopilotReasoningEffortDropdownContract,
      missingDescription: "current reasoning effort dropdown owner",
      skipDescription: "Copilot reasoning effort dropdown patch",
      apply: applyCopilotReasoningEffortUiPatch,
    },
    {
      id: "ui-slash-command",
      name: "copilot-reasoning-effort-ui-slash-command",
      phase: "webview-asset",
      pattern: /^(?!locale-)[A-Za-z0-9_-]+\.js$/,
      assetMatch: matchesCopilotReasoningSlashContract,
      missingDescription: "current reasoning slash command owner",
      skipDescription: "Copilot reasoning slash command patch",
      apply: applyCopilotReasoningEffortUiPatch,
    },
  ],
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortUiPatch,
  matchesCopilotReasoningEffortModelListContract,
  matchesCopilotModelAndReasoningPersistenceContract,
  matchesCopilotReasoningEffortDropdownContract,
  matchesCopilotReasoningSlashContract,
  matchesCopilotReasoningEffortUiContract,
};
