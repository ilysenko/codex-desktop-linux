"use strict";

function applyCopilotReasoningEffortSettingsPatch(currentSource) {
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

  const copilotSavePatchMarker = "copilot-default-reasoning-effort`,";
  const copilotAsyncSaveRegex =
    /if\(await ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\)return;if\(([A-Za-z_$][\w$]*)\)\{await ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),`copilot-default-model`,\2,\{throwOnFailure:!0\}\);return\}if\(([A-Za-z_$][\w$]*)\.info\(`Setting default model and reasoning effort`,\{safe:\{newModel:\2,newEffort:\3,profile:([A-Za-z_$][\w$]*)\.profile\}\}\),!([A-Za-z_$][\w$]*)\)(throw Error\(`Model settings host is unavailable`\);|return;)/;
  if (patchedSource.includes(copilotSavePatchMarker)) {
    // Already patched.
  } else if (copilotAsyncSaveRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      copilotAsyncSaveRegex,
      (
        _match,
        updateConversationVar,
        modelArgVar,
        effortArgVar,
        isCopilotVar,
        persistStateVar,
        stateScopeVar,
        loggerVar,
        configVar,
        hostReadyVar,
        unavailableTail,
      ) =>
        `if(await ${updateConversationVar}(${modelArgVar},${effortArgVar}))return;if(${isCopilotVar}){await ${persistStateVar}(${stateScopeVar},\`copilot-default-model\`,${modelArgVar},{throwOnFailure:!0});await ${persistStateVar}(${stateScopeVar},\`copilot-default-reasoning-effort\`,${effortArgVar},{throwOnFailure:!0});return}if(${loggerVar}.info(\`Setting default model and reasoning effort\`,{safe:{newModel:${modelArgVar},newEffort:${effortArgVar},profile:${configVar}.profile}}),!${hostReadyVar})${unavailableTail}`,
    );
  } else if (patchedSource.includes("copilot-default-model")) {
    console.warn(
      "WARN: Could not find Copilot default model writer - skipping Copilot reasoning effort persistence patch",
    );
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
  let patchedSource = currentSource;

  const currentComposerGateRegex =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\?\.authMethod===`copilot`,([A-Za-z_$][\w$]*)=!([A-Za-z_$][\w$]*)(?:&&!\1)?(?=,)/;
  const currentComposerGateMatch = currentComposerGateRegex.exec(patchedSource);
  if (currentComposerGateMatch) {
    const authMethodVar = currentComposerGateMatch[1];
    patchedSource = patchedSource.replace(
      currentComposerGateRegex,
      "$1=$2?.authMethod===`copilot`,$3=!$4",
    );

    const currentDropdownNeedle = `reasoningEffortDisabled:${authMethodVar}`;
    const currentDropdownIndex = patchedSource.indexOf(
      currentDropdownNeedle,
      currentComposerGateMatch.index,
    );
    if (
      currentDropdownIndex >= currentComposerGateMatch.index &&
      currentDropdownIndex < currentComposerGateMatch.index + 10_000
    ) {
      patchedSource =
        patchedSource.slice(0, currentDropdownIndex) +
        "reasoningEffortDisabled:!1" +
        patchedSource.slice(currentDropdownIndex + currentDropdownNeedle.length);
    } else if (!patchedSource.includes("reasoningEffortDisabled:!1")) {
      console.warn(
        "WARN: Could not find current Copilot reasoning effort dropdown gate - skipping current dropdown patch",
      );
    }
  } else if (
    patchedSource.includes("composer.increaseReasoningEffort") &&
    patchedSource.includes("reasoningEffortDisabled:")
  ) {
    console.warn(
      "WARN: Could not find current Copilot reasoning effort shortcut gate - skipping current UI patch",
    );
  }

  const currentSlashCommandRegex =
    /(composer\.reasoningSlashCommand\.title[\s\S]{0,1000}?let )([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)&&!0,([A-Za-z_$][\w$]*);/;
  const currentSlashCommandPatchedRegex =
    /(composer\.reasoningSlashCommand\.title[\s\S]{0,1000}?let )([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&!0,([A-Za-z_$][\w$]*);/;
  if (currentSlashCommandPatchedRegex.test(patchedSource)) {
    // Already patched.
  } else if (currentSlashCommandRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      currentSlashCommandRegex,
      "$1$2=$3&&$4&&!0,$6;",
    );
  } else if (patchedSource.includes("composer.reasoningSlashCommand.title")) {
    console.warn(
      "WARN: Could not find reasoning slash command enabled state - skipping Copilot reasoning slash command patch",
    );
  }

  return patchedSource;
}

module.exports = {
  descriptors: [
    {
      id: "settings",
      name: "copilot-reasoning-effort-settings",
      phase: "webview-asset",
      pattern: /^app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-[^.]+\.js$/,
      missingDescription: "model settings bundle",
      skipDescription: "Copilot reasoning effort settings patch",
      apply: applyCopilotReasoningEffortSettingsPatch,
    },
    {
      id: "model-list",
      name: "copilot-reasoning-effort-model-list",
      phase: "webview-asset",
      pattern: /^app-initial~app-main~onboarding-page~hotkey-window-thread-page~quick-chat-window-page~chatg~k0ede4gb-[^.]+\.js$/,
      missingDescription: "font settings bundle",
      skipDescription: "Copilot reasoning effort model list patch",
      apply: applyCopilotReasoningEffortModelListPatch,
    },
    {
      id: "ui",
      name: "copilot-reasoning-effort-ui",
      phase: "webview-asset",
      pattern: /^app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-[^.]+\.js$/,
      missingDescription: "webview index bundle",
      skipDescription: "Copilot reasoning effort UI patch",
      apply: applyCopilotReasoningEffortUiPatch,
    },
  ],
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortSettingsPatch,
  applyCopilotReasoningEffortUiPatch,
};
