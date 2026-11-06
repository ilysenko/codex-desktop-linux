"use strict";

const FEATURE_GATE_ID = "2425897452";
const FEATURE_GATE_NEEDLE = `"${FEATURE_GATE_ID}"`;
// The official webview is an rspack build whose app code lives in numbered
// async chunks, so each contract is located by stable content needles.
const FEATURE_SYNC_ASSET_NEEDLES = Object.freeze([FEATURE_GATE_NEEDLE, "electron-desktop-features-changed"]);
const APP_PAGE_ASSET_NEEDLES = Object.freeze([FEATURE_GATE_NEEDLE, "generatedSuggestionsEnabled:"]);
const WORK_PAGE_ASSET_NEEDLES = Object.freeze([FEATURE_GATE_NEEDLE, "generatedSuggestionsEnabled:", "mode:\"work\""]);
const GENERAL_SETTINGS_ASSET_NEEDLES = Object.freeze([FEATURE_GATE_NEEDLE, "planAtLogin"]);
const HOME_CONTENT_ASSET_NEEDLES = Object.freeze(["\"curated\"===", "shouldUseCuratedNewChatPageSuggestions:"]);
const RUNTIME_MARKER = "codexLinuxUiTweaksSuggestedPromptsEnabled";
const FEATURE_SYNC_MARKER = "codexLinuxUiTweaksSuggestedPromptsFeatureSync";
const APP_PAGE_ELIGIBILITY_MARKER = "codexLinuxUiTweaksSuggestedPromptsAppPageEligible";
const WORK_PAGE_ELIGIBILITY_MARKER = "codexLinuxUiTweaksSuggestedPromptsWorkPageEligible";
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

// rspack/SWC renderer: the rollout hook is a module-member call such as
// `(0,er.Zj)("2425897452")`.
function gateAssignmentPattern() {
  return /([A-Za-z_$][\w$]*)=(\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\("2425897452"\)/gu;
}

function featureSyncPattern() {
  return /ambientSuggestions:([A-Za-z_$][\w$]*)&&"enabled"===([A-Za-z_$][\w$]*)\.status/gu;
}

function workPageEligibilityPattern() {
  return /generatedSuggestionsEnabled:([A-Za-z_$][\w$]*)&&(\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(\{authMethod:([A-Za-z_$][\w$]*),email:([A-Za-z_$][\w$]*)\?\.email\?\?([A-Za-z_$][\w$]*),plan:([A-Za-z_$][\w$]*)\}\)/gu;
}

function patchedWorkPageEligibilityPattern() {
  return /generatedSuggestionsEnabled:([A-Za-z_$][\w$]*)&&\((\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(\{authMethod:([A-Za-z_$][\w$]*),email:([A-Za-z_$][\w$]*)\?\.email\?\?([A-Za-z_$][\w$]*),plan:([A-Za-z_$][\w$]*)\}\)\|\|function codexLinuxUiTweaksSuggestedPromptsWorkPageEligible\(\)\{return!0\}\(\)\)/gu;
}

// rspack/SWC main process: literal-first null checks and a module-member
// account-eligibility call such as `(0,el.T9S)(account)`.
function mainEligibilityPattern() {
  return /let\{ambientSuggestionsFeatureDiscovery:([A-Za-z_$][\w$]*),ambientSuggestionsStaleTimeMs:([A-Za-z_$][\w$]*),computerUse:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\);if\(!([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\|\|null==\2\)return\{enabled:!1\};let\{account:([A-Za-z_$][\w$]*)\}=await ([A-Za-z_$][\w$]*)\.getAccount\(\);return(\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(\7\)\?\{enabled:!0,computerUseAvailable:\3,featureDiscoveryEnabled:\1,staleTimeMs:\2\}:\{enabled:!1\}/gu;
}

function patchedMainEligibilityPattern() {
  return /let\{ambientSuggestionsFeatureDiscovery:([A-Za-z_$][\w$]*),ambientSuggestionsStaleTimeMs:([A-Za-z_$][\w$]*),computerUse:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\);if\(!([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\|\|null==\2\)return\{enabled:!1\};let\{account:([A-Za-z_$][\w$]*)\}=await ([A-Za-z_$][\w$]*)\.getAccount\(\);return\((\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(\7\),function codexLinuxUiTweaksSuggestedPromptsMainEnabled\(\)\{return!0\}\(\)\)\?\{enabled:!0,computerUseAvailable:\3,featureDiscoveryEnabled:\1,staleTimeMs:\2\}:\{enabled:!1\}/gu;
}

function settingsEligibilityPattern() {
  return /if\(!(\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(\{authMethod:([A-Za-z_$][\w$]*),email:([A-Za-z_$][\w$]*)\?\.email\?\?([A-Za-z_$][\w$]*),plan:\3\?\.plan\?\?([A-Za-z_$][\w$]*)\}\)\)return null;/gu;
}

function patchedSettingsEligibilityPattern() {
  return /if\(!\((\(0,[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\))\(\{authMethod:([A-Za-z_$][\w$]*),email:([A-Za-z_$][\w$]*)\?\.email\?\?([A-Za-z_$][\w$]*),plan:([A-Za-z_$][\w$]*)\?\.plan\?\?([A-Za-z_$][\w$]*)\}\)\|\|function codexLinuxUiTweaksSuggestedPromptsSettingsEligible\(\)\{return!0\}\(\)\)\)return null;/gu;
}

function homeContentSourcePattern() {
  return /([A-Za-z_$][\w$]*)="curated"===([A-Za-z_$][\w$]*)(?=[,;][\s\S]{0,400}?canUsePersonalizedSuggestions:[A-Za-z_$][\w$]*,generatedSuggestionsEnabled:[A-Za-z_$][\w$]*,hasGeneratedSuggestionsReadSettled:[A-Za-z_$][\w$]*,shouldUseCuratedNewChatPageSuggestions:\1\})/gu;
}

function patchedHomeContentSourcePattern() {
  return /([A-Za-z_$][\w$]*)=\("curated"===([A-Za-z_$][\w$]*),function codexLinuxSuggestedPromptsGeneratedSource\(\)\{return!1\}\(\)\)(?=[,;][\s\S]{0,400}?canUsePersonalizedSuggestions:[A-Za-z_$][\w$]*,generatedSuggestionsEnabled:[A-Za-z_$][\w$]*,hasGeneratedSuggestionsReadSettled:[A-Za-z_$][\w$]*,shouldUseCuratedNewChatPageSuggestions:\1\})/gu;
}

function matchCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function markerOccurrenceCount(source, marker) {
  return source.split(marker).length - 1;
}

function markerFunctionPattern(marker) {
  return new RegExp(`function ${marker}\\(\\)\\{return!0\\}\\(\\)`, "gu");
}

function completeMarkerCount(source, marker) {
  return matchCount(source, markerFunctionPattern(marker));
}

function patchedGateAssignmentPattern(marker) {
  return new RegExp(
    "([A-Za-z_$][\\w$]*)=\\((\\(0,[A-Za-z_$][\\w$]*\\.[A-Za-z_$][\\w$]*\\))\\(\"" +
      FEATURE_GATE_ID +
      "\"\\),function " +
      marker +
      "\\(\\)\\{return!0\\}\\(\\)\\)",
    "gu",
  );
}

function warn(target) {
  console.warn(`WARN: Could not find current Suggested Prompts ${target} contract - skipping ui-tweaks patch`);
}

function completePatchedGateCount(source, marker) {
  return matchCount(source, patchedGateAssignmentPattern(marker));
}

function suggestedPromptsFeatureSyncContract(source) {
  if (typeof source !== "string") {
    return "drifted";
  }
  const cleanRollouts = [...source.matchAll(gateAssignmentPattern())];
  const featureSync = [...source.matchAll(featureSyncPattern())];
  const patchedRollouts = [...source.matchAll(patchedGateAssignmentPattern(FEATURE_SYNC_MARKER))];
  const markerCount = markerOccurrenceCount(source, FEATURE_SYNC_MARKER);
  const completeMarkers = completeMarkerCount(source, FEATURE_SYNC_MARKER);
  if (
    markerCount === 0 &&
    completeMarkers === 0 &&
    cleanRollouts.length === 1 &&
    featureSync.length === 1 &&
    featureSync[0][1] === cleanRollouts[0][1]
  ) {
    return "current";
  }
  if (
    markerCount === 1 &&
    completeMarkers === 1 &&
    cleanRollouts.length === 0 &&
    patchedRollouts.length === 1 &&
    featureSync.length === 1 &&
    featureSync[0][1] === patchedRollouts[0][1] &&
    completePatchedGateCount(source, FEATURE_SYNC_MARKER) === 1
  ) {
    return "patched";
  }
  return "drifted";
}

function appPageState(source, info) {
  if (!info) return "drifted";
  if (markerOccurrenceCount(source, RUNTIME_MARKER) === 0 &&
      markerOccurrenceCount(source, APP_PAGE_ELIGIBILITY_MARKER) === 0 &&
      !info.rolloutSite.patched && !info.eligibility.patched) return "current";
  if (markerOccurrenceCount(source, RUNTIME_MARKER) === 1 && completeMarkerCount(source, RUNTIME_MARKER) === 1 &&
      markerOccurrenceCount(source, APP_PAGE_ELIGIBILITY_MARKER) === 1 && completeMarkerCount(source, APP_PAGE_ELIGIBILITY_MARKER) === 1 &&
      info.rolloutSite.patched && info.eligibility.patched &&
      completePatchedGateCount(info.rolloutSite.source, RUNTIME_MARKER) === 1) return "patched";
  return "drifted";
}

function suggestedPromptsAppPageContract(source,snapshot) {
  if (typeof source !== "string") return "drifted";
  return appPageState(source, require("./suggested-prompts-app-page.js").inspectPage(source,snapshot));
}

function suggestedPromptsWorkPageContract(source,snapshot) {
  if (typeof source !== "string") {
    return "drifted";
  }
  const cleanRollouts = [...source.matchAll(gateAssignmentPattern())];
  const cleanEligibility = [...source.matchAll(workPageEligibilityPattern())];
  const patchedRollouts = [...source.matchAll(patchedGateAssignmentPattern(RUNTIME_MARKER))];
  const patchedEligibility = [...source.matchAll(patchedWorkPageEligibilityPattern())];
  if (
    markerOccurrenceCount(source, RUNTIME_MARKER) === 0 &&
    markerOccurrenceCount(source, WORK_PAGE_ELIGIBILITY_MARKER) === 0 &&
    cleanRollouts.length === 1 &&
    cleanEligibility.length === 1 &&
    cleanEligibility[0][1] === cleanRollouts[0][1]
  ) {
    return require("./suggested-prompts-work-page.js").inspectPage(source,snapshot) ? "current" : "drifted";
  }
  if (
    markerOccurrenceCount(source, RUNTIME_MARKER) === 1 &&
    completeMarkerCount(source, RUNTIME_MARKER) === 1 &&
    markerOccurrenceCount(source, WORK_PAGE_ELIGIBILITY_MARKER) === 1 &&
    completeMarkerCount(source, WORK_PAGE_ELIGIBILITY_MARKER) === 1 &&
    cleanRollouts.length === 0 &&
    cleanEligibility.length === 0 &&
    patchedRollouts.length === 1 &&
    patchedEligibility.length === 1 &&
    patchedEligibility[0][1] === patchedRollouts[0][1] &&
    completePatchedGateCount(source, RUNTIME_MARKER) === 1
  ) {
    return require("./suggested-prompts-work-page.js").inspectPage(source,snapshot) ? "patched" : "drifted";
  }
  return "drifted";
}

function suggestedPromptsSettingsContract(source) {
  if (typeof source !== "string") {
    return "drifted";
  }
  const cleanRollouts = [...source.matchAll(gateAssignmentPattern())];
  const cleanEligibility = [...source.matchAll(settingsEligibilityPattern())];
  const patchedRollouts = [...source.matchAll(patchedGateAssignmentPattern(RUNTIME_MARKER))];
  const patchedEligibility = [...source.matchAll(patchedSettingsEligibilityPattern())];
  if (
    markerOccurrenceCount(source, RUNTIME_MARKER) === 0 &&
    markerOccurrenceCount(source, SETTINGS_ELIGIBILITY_MARKER) === 0 &&
    cleanRollouts.length === 1 &&
    cleanEligibility.length === 1
  ) {
    return "current";
  }
  if (
    markerOccurrenceCount(source, RUNTIME_MARKER) === 1 &&
    completeMarkerCount(source, RUNTIME_MARKER) === 1 &&
    markerOccurrenceCount(source, SETTINGS_ELIGIBILITY_MARKER) === 1 &&
    completeMarkerCount(source, SETTINGS_ELIGIBILITY_MARKER) === 1 &&
    cleanRollouts.length === 0 &&
    cleanEligibility.length === 0 &&
    patchedRollouts.length === 1 &&
    patchedEligibility.length === 1 &&
    completePatchedGateCount(source, RUNTIME_MARKER) === 1
  ) {
    return "patched";
  }
  return "drifted";
}

function suggestedPromptsHomeContentContract(source) {
  if (typeof source !== "string") {
    return "drifted";
  }
  const markerMatches = source.split(HOME_CONTENT_SOURCE_MARKER).length - 1;
  const cleanMatches = matchCount(source, homeContentSourcePattern());
  const patchedMatches = matchCount(source, patchedHomeContentSourcePattern());
  if (markerMatches === 0 && cleanMatches === 1 && patchedMatches === 0) {
    return "current";
  }
  if (markerMatches === 1 && cleanMatches === 0 && patchedMatches === 1) {
    return "patched";
  }
  return "drifted";
}

function suggestedPromptsMainContract(source) {
  if (typeof source !== "string") {
    return "drifted";
  }
  const markerMatches = source.split(MAIN_ELIGIBILITY_MARKER).length - 1;
  const cleanMatches = matchCount(source, mainEligibilityPattern());
  const patchedMatches = matchCount(source, patchedMainEligibilityPattern());
  if (markerMatches === 0 && cleanMatches === 1 && patchedMatches === 0) {
    return "current";
  }
  if (markerMatches === 1 && cleanMatches === 0 && patchedMatches === 1) {
    return "patched";
  }
  return "drifted";
}

function replaceRolloutGate(source, marker) {
  return source.replace(
    gateAssignmentPattern(),
    (_match, targetName, gateName) =>
      `${targetName}=(${gateName}("${FEATURE_GATE_ID}"),function ${marker}(){return!0}())`,
  );
}

function applySuggestedPromptsFeatureSyncPatch(source) {
  try {
    const contract = suggestedPromptsFeatureSyncContract(source);
    if (contract === "patched") {
      return source;
    }
    if (contract !== "current") {
      warn("feature sync");
      return source;
    }

    return replaceRolloutGate(source, FEATURE_SYNC_MARKER);
  } catch (error) {
    console.warn(
      `WARN: Unexpected Suggested Prompts feature sync patch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return source;
  }
}

function applySuggestedPromptsAppPagePatch(source,snapshot) {
  try {
    if (typeof source !== "string") return source;
    const info = require("./suggested-prompts-app-page.js").inspectPage(source,snapshot);
    const state = appPageState(source, info);
    if (state === "patched") return source;
    if (state !== "current") { warn("app page"); return source; }
    const offset = source.includes("__webpack_modules__") ? info.module.start : 0;
    const edits = [
      { ...info.rolloutSite, replacement: replaceRolloutGate(info.rolloutSite.source, RUNTIME_MARKER) },
      { ...info.eligibility, replacement: `${info.fields.generatedSuggestionsEnabled}=${info.rollout}&&(${info.account}||function ${APP_PAGE_ELIGIBILITY_MARKER}(){return!0}())` },
    ].sort((a,b) => b.start-a.start);
    let patched = source;
    for (const edit of edits) {
      const start=offset+edit.start,end=offset+edit.end;
      if (source.slice(start,end)!==edit.source) throw new Error("Ordinary Home source range changed");
      patched=patched.slice(0,start)+edit.replacement+patched.slice(end);
    }
    return patched;
  } catch (error) {
    console.warn(`WARN: Unexpected Suggested Prompts app page patch error: ${error instanceof Error ? error.message : String(error)}`);
    return source;
  }
}

function applySuggestedPromptsWorkPagePatch(source,snapshot) {
  try {
    const contract = suggestedPromptsWorkPageContract(source,snapshot);
    if (contract === "patched") {
      return source;
    }
    if (contract !== "current") {
      warn("Work Home page");
      return source;
    }

    return replaceRolloutGate(source, RUNTIME_MARKER).replace(
      workPageEligibilityPattern(),
      (
        _match,
        rolloutName,
        eligibilityName,
        authMethodName,
        accountInfoName,
        emailName,
        planName,
      ) =>
        `generatedSuggestionsEnabled:${rolloutName}&&(${eligibilityName}({authMethod:${authMethodName},email:${accountInfoName}?.email??${emailName},plan:${planName}})||function ${WORK_PAGE_ELIGIBILITY_MARKER}(){return!0}())`,
    );
  } catch (error) {
    console.warn(
      `WARN: Unexpected Suggested Prompts Work Home page patch error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return source;
  }
}

function applySuggestedPromptsMainPatch(source) {
  try {
    const contract = suggestedPromptsMainContract(source);
    if (contract === "patched") {
      return source;
    }
    if (contract !== "current") {
      warn("main process");
      return source;
    }

    return source.replace(
      mainEligibilityPattern(),
      (
        _match,
        featureDiscoveryName,
        staleTimeName,
        computerUseName,
        featureStateName,
        settingsEligibilityName,
        settingsStoreName,
        accountName,
        appServerConnectionName,
        accountEligibilityName,
      ) =>
        `let{ambientSuggestionsFeatureDiscovery:${featureDiscoveryName},ambientSuggestionsStaleTimeMs:${staleTimeName},computerUse:${computerUseName}}=${featureStateName}();if(!${settingsEligibilityName}(${settingsStoreName})||null==${staleTimeName})return{enabled:!1};let{account:${accountName}}=await ${appServerConnectionName}.getAccount();return(${accountEligibilityName}(${accountName}),function ${MAIN_ELIGIBILITY_MARKER}(){return!0}())?{enabled:!0,computerUseAvailable:${computerUseName},featureDiscoveryEnabled:${featureDiscoveryName},staleTimeMs:${staleTimeName}}:{enabled:!1}`,
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
    const contract = suggestedPromptsHomeContentContract(source);
    if (contract === "patched") {
      return source;
    }
    if (contract !== "current") {
      warn("Home generated-source");
      return source;
    }

    return source.replace(
      homeContentSourcePattern(),
      (_match, sourceFlag, suggestionSource) =>
        `${sourceFlag}=("curated"===${suggestionSource},function ${HOME_CONTENT_SOURCE_MARKER}(){return!1}())`,
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
    const contract = suggestedPromptsSettingsContract(source);
    if (contract === "patched") {
      return source;
    }
    if (contract !== "current") {
      warn("settings");
      return source;
    }

    return replaceRolloutGate(source, RUNTIME_MARKER).replace(
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
    id: "home-suggested-prompts-feature-sync",
    phase: "webview-asset",
    order: 20_975,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    assetNeedles: FEATURE_SYNC_ASSET_NEEDLES,
    assetMatch: (source) => suggestedPromptsFeatureSyncContract(source) !== "drifted",
    missingDescription: "current Suggested Prompts feature-sync bundle",
    skipDescription: "ui-tweaks Suggested Prompts feature-sync patch",
    apply: applySuggestedPromptsFeatureSyncPatch,
  },
  {
    id: "home-suggested-prompts-app-page",
    phase: "extracted-app:pre-webview",
    order: 20_980,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    assetNeedles: APP_PAGE_ASSET_NEEDLES,
    assetMatch: (source) => suggestedPromptsAppPageContract(source) !== "drifted",
    missingDescription: "current Suggested Prompts app page bundle",
    skipDescription: "ui-tweaks Suggested Prompts app page patch",
    apply: (extractedDir) => require("./suggested-prompts-app-page.js").applyToExtractedApp(extractedDir),
  },
  {
    id: "home-suggested-prompts-work-page",
    phase: "extracted-app:pre-webview",
    order: 20_985,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    assetNeedles: WORK_PAGE_ASSET_NEEDLES,
    assetMatch: (source) => suggestedPromptsWorkPageContract(source) !== "drifted",
    missingDescription: "current Suggested Prompts Work Home bundle",
    skipDescription: "ui-tweaks Suggested Prompts Work Home patch",
    apply: (extractedDir) => require("./suggested-prompts-work-page.js").applyToExtractedApp(extractedDir),
  },
  {
    id: "home-suggested-prompts-settings-row",
    phase: "webview-asset",
    order: 20_990,
    ciPolicy: "optional",
    enabled: suggestedPromptsEnabled,
    assetNeedles: GENERAL_SETTINGS_ASSET_NEEDLES,
    assetMatch: (source) => suggestedPromptsSettingsContract(source) !== "drifted",
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
    assetNeedles: HOME_CONTENT_ASSET_NEEDLES,
    assetMatch: (source) => suggestedPromptsHomeContentContract(source) !== "drifted",
    missingDescription: "current Suggested Prompts Home content bundle",
    skipDescription: "ui-tweaks Suggested Prompts generated-source patch",
    apply: applySuggestedPromptsHomeContentPatch,
  },
];

module.exports = {
  APP_PAGE_ASSET_NEEDLES,
  APP_PAGE_ELIGIBILITY_MARKER,
  FEATURE_SYNC_ASSET_NEEDLES,
  FEATURE_SYNC_MARKER,
  GENERAL_SETTINGS_ASSET_NEEDLES,
  HOME_CONTENT_ASSET_NEEDLES,
  HOME_CONTENT_SOURCE_MARKER,
  MAIN_ELIGIBILITY_MARKER,
  RUNTIME_MARKER,
  SETTINGS_ELIGIBILITY_MARKER,
  WORK_PAGE_ASSET_NEEDLES,
  WORK_PAGE_ELIGIBILITY_MARKER,
  suggestedPromptsAppPageContract,
  suggestedPromptsFeatureSyncContract,
  suggestedPromptsHomeContentContract,
  suggestedPromptsMainContract,
  suggestedPromptsSettingsContract,
  suggestedPromptsWorkPageContract,
  applySuggestedPromptsFeatureSyncPatch,
  applySuggestedPromptsAppPagePatch,
  applySuggestedPromptsHomeContentPatch,
  applySuggestedPromptsMainPatch,
  applySuggestedPromptsSettingsPatch,
  applySuggestedPromptsWorkPagePatch,
  descriptors,
  suggestedPromptsConfig,
  suggestedPromptsEnabled,
};
