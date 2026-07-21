"use strict";

const APP_PAGE_ASSET_PATTERN =
  /^app-initial~app-main~appgen-settings-page~page~appgen-library-page~appgen-page~appgen-setti~ogh9jurw-DEXL3aWU\.js$/;
const GENERAL_SETTINGS_ASSET_PATTERN = /^general-settings-BWZCvLqI\.js$/;
const HOME_CONTENT_ASSET_PATTERN = /^home-ambient-suggestions-content-C7Hrlu7B\.js$/;
const FEATURE_GATE_ID = "2425897452";
const RUNTIME_MARKER = "codexLinuxUiTweaksSuggestedPromptsEnabled";
const APP_PAGE_ELIGIBILITY_MARKER = "codexLinuxUiTweaksSuggestedPromptsAppPageEligible";
const HOME_CONTENT_SOURCE_MARKER = "codexLinuxSuggestedPromptsGeneratedSource";
const MAIN_ELIGIBILITY_MARKER = "codexLinuxUiTweaksSuggestedPromptsMainEnabled";
const SETTINGS_ELIGIBILITY_MARKER = "codexLinuxUiTweaksSuggestedPromptsSettingsEligible";

function suggestedPromptsConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.home?.suggestedPrompts;
  const settings = context?.feature?.settings?.tweaks?.home?.suggestedPrompts;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function suggestedPromptsEnabled(context) {
  return suggestedPromptsConfig(context).enabled === true;
}

function gateAssignmentPattern() {
  return /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(`2425897452`\)/gu;
}

function appPageEligibilityPattern() {
  return /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)(?=,[\s\S]{0,500}?generatedSuggestionsEnabled:\1)/gu;
}

function mainEligibilityPattern() {
  return /return\{enabled:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\.account\),staleTimeMs:\1\.([A-Za-z_$][\w$]*)\(\3\.account\)\}/gu;
}

function settingsEligibilityPattern() {
  return /if\(!([A-Za-z_$][\w$]*)\(\{authMethod:([A-Za-z_$][\w$]*),email:([A-Za-z_$][\w$]*)\?\.email\?\?([A-Za-z_$][\w$]*),plan:\3\?\.plan\?\?([A-Za-z_$][\w$]*)\}\)\)return null;/gu;
}

function homeContentSourcePattern() {
  return /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`curated`(?=,[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\.email\),[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\(\{canUsePersonalizedSuggestions:[A-Za-z_$][\w$]*,generatedSuggestionsEnabled:[A-Za-z_$][\w$]*,hasGeneratedSuggestionsReadSettled:[A-Za-z_$][\w$]*,shouldUseCuratedNewChatPageSuggestions:\1\}\))/gu;
}

function matchCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function warn(target) {
  console.warn(`WARN: Could not find current Suggested Prompts ${target} contract - skipping ui-tweaks patch`);
}

function rolloutMarkerCount(source) {
  return source.split(RUNTIME_MARKER).length - 1;
}

function replaceRolloutGates(source) {
  return source.replace(
    gateAssignmentPattern(),
    (_match, targetName, gateName) =>
      `${targetName}=(${gateName}(\`${FEATURE_GATE_ID}\`),function ${RUNTIME_MARKER}(){return!0}())`,
  );
}

function applySuggestedPromptsAppPagePatch(source) {
  try {
    const rolloutMarkers = typeof source === "string" ? rolloutMarkerCount(source) : 0;
    const eligibilityMarkers = typeof source === "string"
      ? source.split(APP_PAGE_ELIGIBILITY_MARKER).length - 1
      : 0;
    const cleanRollouts = typeof source === "string" ? matchCount(source, gateAssignmentPattern()) : 0;
    const cleanEligibility = typeof source === "string"
      ? matchCount(source, appPageEligibilityPattern())
      : 0;
    if (rolloutMarkers === 2 && eligibilityMarkers === 1 && cleanRollouts === 0 && cleanEligibility === 0) {
      return source;
    }
    if (rolloutMarkers !== 0 || eligibilityMarkers !== 0 || cleanRollouts !== 2 || cleanEligibility !== 1) {
      warn("app page");
      return source;
    }

    return replaceRolloutGates(source).replace(
      appPageEligibilityPattern(),
      (_match, enabledName, rolloutName, eligibilityName) =>
        `${enabledName}=${rolloutName}&&(${eligibilityName}||function ${APP_PAGE_ELIGIBILITY_MARKER}(){return!0}())`,
    );
  } catch (error) {
    console.warn(
      `WARN: Unexpected Suggested Prompts app page patch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return source;
  }
}

function applySuggestedPromptsMainPatch(source) {
  try {
    const markerMatches = typeof source === "string"
      ? source.split(MAIN_ELIGIBILITY_MARKER).length - 1
      : 0;
    const cleanMatches = typeof source === "string" ? matchCount(source, mainEligibilityPattern()) : 0;
    if (markerMatches === 1 && cleanMatches === 0) {
      return source;
    }
    if (markerMatches !== 0 || cleanMatches !== 1) {
      warn("main process");
      return source;
    }

    return source.replace(
      mainEligibilityPattern(),
      (_match, namespace, enabledMethod, accountName, staleMethod) =>
        `return{enabled:(${namespace}.${enabledMethod}(${accountName}.account),function ${MAIN_ELIGIBILITY_MARKER}(){return!0}()),staleTimeMs:${namespace}.${staleMethod}(${accountName}.account)}`,
    );
  } catch (error) {
    console.warn(
      `WARN: Unexpected Suggested Prompts main process patch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return source;
  }
}

function applySuggestedPromptsHomeContentPatch(source) {
  try {
    const markerMatches = typeof source === "string"
      ? source.split(HOME_CONTENT_SOURCE_MARKER).length - 1
      : 0;
    const cleanMatches = typeof source === "string" ? matchCount(source, homeContentSourcePattern()) : 0;
    if (markerMatches === 1 && cleanMatches === 0) {
      return source;
    }
    if (markerMatches !== 0 || cleanMatches !== 1) {
      warn("Home generated-source");
      return source;
    }

    return source.replace(
      homeContentSourcePattern(),
      (_match, sourceFlag, debugOverride) =>
        `${sourceFlag}=(${debugOverride}===\`curated\`,function ${HOME_CONTENT_SOURCE_MARKER}(){return!1}())`,
    );
  } catch (error) {
    console.warn(
      `WARN: Unexpected Suggested Prompts Home content patch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return source;
  }
}

function applySuggestedPromptsSettingsPatch(source) {
  try {
    const rolloutMarkers = typeof source === "string" ? rolloutMarkerCount(source) : 0;
    const eligibilityMarkers = typeof source === "string"
      ? source.split(SETTINGS_ELIGIBILITY_MARKER).length - 1
      : 0;
    const cleanRollouts = typeof source === "string" ? matchCount(source, gateAssignmentPattern()) : 0;
    const cleanEligibility = typeof source === "string"
      ? matchCount(source, settingsEligibilityPattern())
      : 0;
    if (rolloutMarkers === 1 && eligibilityMarkers === 1 && cleanRollouts === 0 && cleanEligibility === 0) {
      return source;
    }
    if (rolloutMarkers !== 0 || eligibilityMarkers !== 0 || cleanRollouts !== 1 || cleanEligibility !== 1) {
      warn("settings");
      return source;
    }

    return replaceRolloutGates(source).replace(
      settingsEligibilityPattern(),
      (_match, eligibilityName, authMethod, accountInfo, email, plan) =>
        `if(!(${eligibilityName}({authMethod:${authMethod},email:${accountInfo}?.email??${email},plan:${accountInfo}?.plan??${plan}})||function ${SETTINGS_ELIGIBILITY_MARKER}(){return!0}()))return null;`,
    );
  } catch (error) {
    console.warn(
      `WARN: Unexpected Suggested Prompts settings patch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return source;
  }
}

const descriptors = [
  {
    id: "home-suggested-prompts-main-process",
    phase: "main-bundle",
    order: 20_970,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    apply: applySuggestedPromptsMainPatch,
  },
  {
    id: "home-suggested-prompts-app-page",
    phase: "webview-asset",
    order: 20_980,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    pattern: APP_PAGE_ASSET_PATTERN,
    missingDescription: "current Suggested Prompts app page bundle",
    skipDescription: "ui-tweaks Suggested Prompts app page patch",
    apply: applySuggestedPromptsAppPagePatch,
  },
  {
    id: "home-suggested-prompts-settings-row",
    phase: "webview-asset",
    order: 20_990,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    pattern: GENERAL_SETTINGS_ASSET_PATTERN,
    missingDescription: "current Suggested Prompts General settings bundle",
    skipDescription: "ui-tweaks Suggested Prompts settings row patch",
    apply: applySuggestedPromptsSettingsPatch,
  },
  {
    id: "home-suggested-prompts-content",
    phase: "webview-asset",
    order: 21_000,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    pattern: HOME_CONTENT_ASSET_PATTERN,
    missingDescription: "current Suggested Prompts Home content bundle",
    skipDescription: "ui-tweaks Suggested Prompts generated-source patch",
    apply: applySuggestedPromptsHomeContentPatch,
  },
];

module.exports = {
  APP_PAGE_ASSET_PATTERN,
  APP_PAGE_ELIGIBILITY_MARKER,
  GENERAL_SETTINGS_ASSET_PATTERN,
  HOME_CONTENT_ASSET_PATTERN,
  HOME_CONTENT_SOURCE_MARKER,
  MAIN_ELIGIBILITY_MARKER,
  RUNTIME_MARKER,
  SETTINGS_ELIGIBILITY_MARKER,
  applySuggestedPromptsAppPagePatch,
  applySuggestedPromptsHomeContentPatch,
  applySuggestedPromptsMainPatch,
  applySuggestedPromptsSettingsPatch,
  descriptors,
  suggestedPromptsConfig,
  suggestedPromptsEnabled,
};
