"use strict";

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const BT = "`";

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

function currentComposerGateRegex() {
  return new RegExp(
      `(?<copilot>${JS_IDENT})=(?<host>${JS_IDENT})\\?\\.authMethod===${BT}copilot${BT}` +
      `(?<middle>[\\s\\S]{0,3000}?),` +
      `(?<shortcut>${JS_IDENT})=(?<shortcutPrefix>[\\s\\S]{1,120}?)!0,` +
      `(?<picker>${JS_IDENT})=(?<modelLock>${JS_IDENT})\\?\\.isModelLocked!==!0` +
      `&&(?<pickerMiddle>[\\s\\S]{1,300}?)&&(?<status>${JS_IDENT})!==${BT}error${BT}`,
  );
}

function currentSlashCommandRegex(patched) {
  const copilotGate = patched ? "" : `&&!\\k<copilot>`;
  return new RegExp(
    `(?<prefix>(?<requiresAuth>${JS_IDENT})=(?<host>${JS_IDENT})\\?\\.requiresAuth\\?\\?!0` +
      `[\\s\\S]{0,3000}?(?<copilot>${JS_IDENT})=\\k<host>\\?\\.authMethod===${BT}copilot${BT}` +
      `[\\s\\S]{0,3000}?composer\\.reasoningSlashCommand\\.title[\\s\\S]{0,1500}?let )` +
      `(?<enabled>${JS_IDENT})=\\k<requiresAuth>&&(?<authReady>${JS_IDENT})` +
      `${copilotGate}&&!0,(?<dependencies>${JS_IDENT});`,
  );
}

function findAllMatches(source, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.matchAll(new RegExp(regex.source, flags))];
}

function findNeedleIndexes(source, needle, startIndex, distance = 20_000) {
  const indexes = [];
  const endIndex = Math.min(source.length, startIndex + distance);
  let index = source.indexOf(needle, startIndex);
  while (index >= startIndex && index < endIndex) {
    indexes.push(index);
    index = source.indexOf(needle, index + needle.length);
  }
  return indexes;
}

function analyzeCopilotReasoningEffortUiContract(source) {
  const composerMatches = findAllMatches(source, currentComposerGateRegex());
  if (composerMatches.length === 0) {
    return {
      state: "invalid",
      warning: "Could not find current Copilot reasoning effort shortcut gate",
    };
  }
  if (composerMatches.length !== 1) {
    return {
      state: "invalid",
      warning: "Found duplicate current Copilot reasoning effort composer contracts",
    };
  }

  const composerMatch = composerMatches[0];
  const cleanShortcutGate = `!${composerMatch.groups.copilot}&&`;
  const cleanPickerGate = `!${composerMatch.groups.copilot}`;
  const hasShortcutGate = composerMatch.groups.shortcutPrefix.endsWith(cleanShortcutGate);
  const hasPickerGate = composerMatch.groups.pickerMiddle.endsWith(cleanPickerGate);
  const pristineComposer = hasShortcutGate && hasPickerGate;
  const patchedComposer = !hasShortcutGate && !hasPickerGate;
  if (!pristineComposer && !patchedComposer) {
    return {
      state: "invalid",
      warning: "Found mismatched current Copilot reasoning effort composer gates",
    };
  }
  const cleanDropdownIndexes = findNeedleIndexes(
    source,
    `reasoningEffortDisabled:${composerMatch.groups.copilot}`,
    composerMatch.index,
  );
  const patchedDropdownIndexes = findNeedleIndexes(
    source,
    "reasoningEffortDisabled:!1",
    composerMatch.index,
  );
  const dropdownIndexes = [...cleanDropdownIndexes, ...patchedDropdownIndexes];
  if (dropdownIndexes.length === 0) {
    return {
      state: "invalid",
      warning: "Could not find current Copilot reasoning effort dropdown gate",
    };
  }
  if (dropdownIndexes.length !== 1) {
    return {
      state: "invalid",
      warning: "Found duplicate current Copilot reasoning effort dropdown gates",
    };
  }

  const cleanSlashMatches = findAllMatches(source, currentSlashCommandRegex(false));
  const patchedSlashMatches = findAllMatches(source, currentSlashCommandRegex(true));
  const slashMatches = [...cleanSlashMatches, ...patchedSlashMatches];
  if (slashMatches.length === 0) {
    return {
      state: "invalid",
      warning: "Could not find reasoning slash command enabled state",
    };
  }
  if (slashMatches.length !== 1) {
    return {
      state: "invalid",
      warning: "Found duplicate Copilot reasoning slash command gates",
    };
  }

  const pristine = pristineComposer &&
    cleanDropdownIndexes.length === 1 && cleanSlashMatches.length === 1;
  const patched = patchedComposer &&
    patchedDropdownIndexes.length === 1 && patchedSlashMatches.length === 1;
  if (!pristine && !patched) {
    return {
      state: "invalid",
      warning: "Found mixed current Copilot reasoning effort UI contract state",
    };
  }

  return {
    state: pristine ? "pristine" : "patched",
    composerMatch,
    dropdownIndex: dropdownIndexes[0],
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

  const cleanComposerMatch = contract.composerMatch;
  let patchedSource = currentSource;
  const groups = cleanComposerMatch.groups;
  const copilotGate = `!${groups.copilot}&&`;
  const gateCount = cleanComposerMatch[0].split(copilotGate).length - 1;
  if (gateCount !== 2) {
    console.warn(
      "WARN: Could not isolate both current Copilot reasoning effort composer gates - skipping current UI patch",
    );
    return currentSource;
  }
  const replacement = cleanComposerMatch[0].split(copilotGate).join("");
  patchedSource = patchedSource.replace(cleanComposerMatch[0], replacement);

  const dropdownNeedle = `reasoningEffortDisabled:${groups.copilot}`;
  const dropdownIndex = patchedSource.indexOf(dropdownNeedle, cleanComposerMatch.index);
  patchedSource =
    patchedSource.slice(0, dropdownIndex) +
    "reasoningEffortDisabled:!1" +
    patchedSource.slice(dropdownIndex + dropdownNeedle.length);

  const cleanSlashRegex = currentSlashCommandRegex(false);
  if (cleanSlashRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      cleanSlashRegex,
      "$<prefix>$<enabled>=$<requiresAuth>&&$<authReady>&&!0,$<dependencies>;",
    );
  }

  if (analyzeCopilotReasoningEffortUiContract(patchedSource).state !== "patched") {
    console.warn(
      "WARN: Copilot reasoning effort UI patch did not produce one coherent patched contract - skipping current UI patch",
    );
    return currentSource;
  }
  return patchedSource;
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
      pattern: /^app-initial-[^.]+\.js$/,
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
