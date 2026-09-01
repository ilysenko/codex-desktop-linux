"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const BT = "`";
const COMPILED_UI_MARKER = "codexLinuxCopilotReasoningEffortUi";

function currentCopilotWriterRegex() {
  return new RegExp(
    `(${JS_IDENT}=async\\((${JS_IDENT}),(${JS_IDENT}),${JS_IDENT}\\)=>\\{[\\s\\S]{0,1000}?` +
      `if\\((${JS_IDENT})\\)return await (${JS_IDENT})\\((${JS_IDENT}),${BT}copilot-default-model${BT},\\2,` +
      `\\{throwOnFailure:!0\\}\\)),!0`,
  );
}

function matchesCopilotReasoningEffortSettingsContract(source) {
  const cleanReader = new RegExp(
    `function ${JS_IDENT}\\(\\)\\{let ${JS_IDENT}=\\(0,${JS_IDENT}\\.c\\)\\(3\\),${JS_IDENT}=${JS_IDENT}\\(\\),` +
      `\\{data:${JS_IDENT},isLoading:${JS_IDENT}\\}=${JS_IDENT}\\(${BT}copilot-default-model${BT}\\)` +
      `[\\s\\S]{0,400}?reasoningEffort:${BT}medium${BT}`,
  );
  const patchedReader = source.includes("copilot-default-reasoning-effort`),codexCopilotModelValue=");
  const patchedWriter = source.includes("`copilot-default-reasoning-effort`,");
  return (cleanReader.test(source) || patchedReader) &&
    (currentCopilotWriterRegex().test(source) || patchedWriter);
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

function findAllMatches(source, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.matchAll(new RegExp(regex.source, flags))];
}

function analyzeCompiledCopilotReasoningEffortUiContract(source) {
  if (
    !source.includes("composer.reasoningSlashCommand.title") ||
    !source.includes("reasoningEffortDisabled:") ||
    !source.includes("authMethod===`copilot`")
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
  if (!source.includes(`reasoningEffortDisabled:${combinedMatch.groups.disabled}`)) {
    return {
      state: "invalid",
      warning: "Could not find current compiled Copilot reasoning effort dropdown gate",
    };
  }

  const titleIndex = source.indexOf("composer.reasoningSlashCommand.title");
  const slashStart = Math.max(0, titleIndex - 2_000);
  const slashEnd = Math.min(source.length, titleIndex + 3_000);
  const slashSource = source.slice(slashStart, slashEnd);
  const cleanSlash = new RegExp(
    `(?<enabled>${JS_IDENT})=(?<requires>${JS_IDENT})&&(?<ready>${JS_IDENT})&&!` +
      `(?<copilot>${JS_IDENT})&&!0,(?<dependencies>${JS_IDENT});`,
  );
  const patchedSlash = new RegExp(
    `(?<enabled>${JS_IDENT})=(?<requires>${JS_IDENT})&&(?<ready>${JS_IDENT})&&!0` +
      `/\\*${COMPILED_UI_MARKER}\\*/,(?<dependencies>${JS_IDENT});`,
  );
  const cleanSlashMatches = findAllMatches(slashSource, cleanSlash);
  const patchedSlashMatches = findAllMatches(slashSource, patchedSlash);
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
    const copilotVar = cleanSlashMatches[0].groups.copilot;
    const copilotDeclaration = new RegExp(
      `${copilotVar}=${JS_IDENT}\\?\\.authMethod===${BT}copilot${BT}`,
    );
    if (!copilotDeclaration.test(slashSource)) {
      return {
        state: "invalid",
        warning: "Could not find current compiled Copilot reasoning slash command auth gate",
      };
    }
  }

  const pristine = cleanCombinedMatches.length === 1 && cleanSlashMatches.length === 1;
  const patched = patchedCombinedMatches.length === 1 && patchedSlashMatches.length === 1;
  if (!pristine && !patched) {
    return {
      state: "invalid",
      warning: "Found mixed current compiled Copilot reasoning effort UI contract state",
    };
  }
  return {
    state: pristine ? "pristine" : "patched",
    contract: "compiled",
    combinedMatch,
    slashMatch: slashMatches[0],
  };
}

function analyzeCopilotReasoningEffortUiContract(source) {
  const compiled = analyzeCompiledCopilotReasoningEffortUiContract(source);
  return compiled ?? {
    state: "invalid",
    warning: "Could not find current compiled Copilot reasoning effort UI contract",
  };
}

function applyCopilotReasoningEffortSettingsPatch(currentSource) {
  const copilotSavePatchMarker = "copilot-default-reasoning-effort`,";
  const currentCopilotSaveRegex = currentCopilotWriterRegex();
  if (
    !currentSource.includes(copilotSavePatchMarker) &&
    !currentCopilotSaveRegex.test(currentSource)
  ) {
    if (currentSource.includes("copilot-default-model")) {
      console.warn(
        "WARN: Could not find Copilot default model writer - skipping Copilot reasoning effort settings patch",
      );
    }
    return currentSource;
  }

  let patchedSource = currentSource;

  const copilotDefaultsPatchMarker = "copilot-default-reasoning-effort`),codexCopilotModelValue=";
  const copilotDefaultsRegex =
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),\{data:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(`copilot-default-model`\),([A-Za-z_$][\w$]*)=\6\?\?\4\.defaultModel,([A-Za-z_$][\w$]*);return \2\[0\]!==\7\|\|\2\[1\]!==\9\?\(\10=\{model:\9,reasoningEffort:`medium`,profile:null,isLoading:\7\},\2\[0\]=\7,\2\[1\]=\9,\2\[2\]=\10\):\10=\2\[2\],\10\}/;
  if (patchedSource.includes(copilotDefaultsPatchMarker)) {
    // Already patched.
  } else if (copilotDefaultsRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      copilotDefaultsRegex,
      (
        _match,
        functionName,
        memoVar,
        cacheModuleVar,
        defaultsVar,
        defaultsHookVar,
        savedModelVar,
        modelLoadingVar,
        persistedStateHookVar,
        _modelValueVar,
        resultVar,
      ) =>
        `function ${functionName}(){let ${memoVar}=(0,${cacheModuleVar}.c)(5),${defaultsVar}=${defaultsHookVar}(),{data:${savedModelVar},isLoading:${modelLoadingVar}}=${persistedStateHookVar}(\`copilot-default-model\`),{data:codexCopilotReasoningEffort,isLoading:codexCopilotReasoningEffortLoading}=${persistedStateHookVar}(\`copilot-default-reasoning-effort\`),codexCopilotModelValue=${savedModelVar}??${defaultsVar}.defaultModel,codexCopilotReasoningEffortValue=codexCopilotReasoningEffort??\`medium\`,${resultVar};return ${memoVar}[0]!==${modelLoadingVar}||${memoVar}[1]!==codexCopilotReasoningEffortLoading||${memoVar}[2]!==codexCopilotModelValue||${memoVar}[3]!==codexCopilotReasoningEffortValue?(${resultVar}={model:codexCopilotModelValue,reasoningEffort:codexCopilotReasoningEffortValue,profile:null,isLoading:${modelLoadingVar}||codexCopilotReasoningEffortLoading},${memoVar}[0]=${modelLoadingVar},${memoVar}[1]=codexCopilotReasoningEffortLoading,${memoVar}[2]=codexCopilotModelValue,${memoVar}[3]=codexCopilotReasoningEffortValue,${memoVar}[4]=${resultVar}):${resultVar}=${memoVar}[4],${resultVar}}`,
    );
  } else if (patchedSource.includes("copilot-default-model")) {
    console.warn(
      "WARN: Could not find Copilot default model reader - skipping Copilot reasoning effort default patch",
    );
  }

  if (patchedSource.includes(copilotSavePatchMarker)) {
    // Already patched.
  } else {
    const currentMatch = patchedSource.match(currentCopilotSaveRegex);
    if (currentMatch != null) {
      const [, prefix, _modelArg, effortArg, _isCopilot, persistState, stateScope] = currentMatch;
      patchedSource = patchedSource.replace(
        currentCopilotSaveRegex,
        `${prefix},await ${persistState}(${stateScope},${BT}copilot-default-reasoning-effort${BT},${effortArg},{throwOnFailure:!0}),!0`,
      );
    } else if (patchedSource.includes("copilot-default-model")) {
      console.warn(
        "WARN: Could not find Copilot default model writer - skipping Copilot reasoning effort persistence patch",
      );
    }
  }

  return patchedSource;
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

  const combined = contract.combinedMatch.groups;
  const slash = contract.slashMatch.groups;
  let patchedSource = currentSource.replace(
    contract.combinedMatch[0],
    `${combined.disabled}=/*${COMPILED_UI_MARKER}*/${combined.modelExpression}`,
  );
  patchedSource = patchedSource.replace(
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
      id: "settings",
      name: "copilot-reasoning-effort-settings",
      phase: "webview-asset",
      pattern: /^app-initial-[^.]+\.js$/,
      assetMatch: matchesCopilotReasoningEffortSettingsContract,
      missingDescription: "model settings bundle",
      skipDescription: "Copilot reasoning effort settings patch",
      apply: applyCopilotReasoningEffortSettingsPatch,
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
      id: "ui",
      name: "copilot-reasoning-effort-ui",
      phase: "webview-asset",
      pattern: /^app-(?:initial|primary)-[^.]+\.js$/,
      assetMatch: matchesCopilotReasoningEffortUiContract,
      missingDescription: "current composer bundle",
      skipDescription: "Copilot reasoning effort UI patch",
      apply: applyCopilotReasoningEffortUiPatch,
    },
  ],
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortSettingsPatch,
  applyCopilotReasoningEffortUiPatch,
  matchesCopilotReasoningEffortModelListContract,
  matchesCopilotReasoningEffortSettingsContract,
  matchesCopilotReasoningEffortUiContract,
};
