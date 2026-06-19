"use strict";

const fs = require("node:fs");
const path = require("node:path");

const COMPUTER_USE_UI_ENV_VAR = "CODEX_LINUX_ENABLE_COMPUTER_USE_UI";
const COMPUTER_USE_UI_SETTINGS_KEY = "codex-linux-computer-use-ui-enabled";

// Computer Use has two postures: the bundled plugin gate is default-on Linux
// platform glue; the visible UI gates remain opt-in because they bypass rollout
// checks in upstream webview code.
function isComputerUseUiEnabled(env = process.env) {
  if (env[COMPUTER_USE_UI_ENV_VAR] === "1") {
    return true;
  }
  return readComputerUseUiSettingsFlag(env);
}

function readComputerUseUiSettingsFlag(env) {
  const settingsPath = computerUseUiSettingsPath(env);
  if (settingsPath == null) {
    return false;
  }
  try {
    if (!fs.existsSync(settingsPath)) {
      return false;
    }
    const raw = fs.readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    return parsed[COMPUTER_USE_UI_SETTINGS_KEY] === true;
  } catch {
    return false;
  }
}

function computerUseUiSettingsPath(env) {
  const override = env.CODEX_LINUX_SETTINGS_FILE;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  const xdgConfig = env.XDG_CONFIG_HOME;
  const home = env.HOME;
  const configHome = (xdgConfig && xdgConfig.length > 0)
    ? xdgConfig
    : home
      ? path.join(home, ".config")
      : null;
  if (configHome == null) {
    return null;
  }
  const appId = computerUseUiSettingsAppId(env);
  return path.join(configHome, appId, "settings.json");
}

function computerUseUiSettingsAppId(env) {
  const appId = env.CODEX_LINUX_APP_ID || env.CODEX_APP_ID || "codex-desktop";
  return /^[A-Za-z0-9._-]+$/.test(appId) ? appId : "codex-desktop";
}

// Lookback/lookahead windows used when searching for the nearest minified
// identifier or surrounding context around a regex anchor in the bundle.
// Sized empirically to the typical distance between a feature's anchor and
// the helper aliases it depends on.
const TRAY_GUARD_LOOKAHEAD = 1200;
const CLOSE_GATE_PREFIX_LOOKBACK = 8000;
const HANDLER_PREFIX_LOOKBACK = 12000;
const DIRECT_HANDLER_PROXIMITY = 1200;

const linuxSettingsKeys = {
  promptWindow: "codex-linux-prompt-window-enabled",
  systemTray: "codex-linux-system-tray-enabled",
  warmStart: "codex-linux-warm-start-enabled",
};

function parseDestructuredParamAliases(paramsText) {
  const aliases = Object.create(null);
  for (const rawPart of paramsText.split(",")) {
    const part = rawPart.trim();
    const match = part.match(/^([A-Za-z_$][\w$]*)(?::([A-Za-z_$][\w$]*))?$/);
    if (match != null) {
      aliases[match[1]] = match[2] ?? match[1];
    }
  }
  return aliases;
}

function buildComputerUseGate({ nameExpr, availabilityProp, featuresVar, platformVar, migrateVar }) {
  return `{installWhenMissing:!0,name:${nameExpr},${availabilityProp}:({features:${featuresVar},platform:${platformVar}})=>(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${featuresVar}.computerUse,migrate:${migrateVar}}`;
}

function buildFlexibleComputerUseGate({
  availabilityProp,
  expressionSuffix,
  featuresVar,
  middleFields,
  nameExpr,
  platformVar,
  prefix,
}) {
  const installField = prefix.includes("installWhenMissing:!0,") ||
      middleFields.includes("installWhenMissing:!0,") ||
      expressionSuffix.includes("installWhenMissing:!0,")
    ? ""
    : "installWhenMissing:!0,";
  return `{${prefix}${installField}name:${nameExpr},${middleFields}${availabilityProp}:({features:${featuresVar},platform:${platformVar}})=>(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${featuresVar}.computerUse${expressionSuffix}}`;
}

function hasComputerUseLiteral(source) {
  return /(?:`computer-use`|"computer-use"|'computer-use')/.test(source);
}

function isComputerUseNameExpr(nameExpr, computerUseNameVar) {
  return /^(?:`computer-use`|"computer-use"|'computer-use')$/.test(nameExpr) ||
    nameExpr === computerUseNameVar ||
    /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(nameExpr);
}

function applyLinuxComputerUsePluginGatePatch(currentSource) {
  if (!hasComputerUseLiteral(currentSource)) {
    console.warn(
      "WARN: Could not find Computer Use plugin gate literal — skipping Linux Computer Use plugin gate patch",
    );
    return currentSource;
  }

  const computerUseNameVar = currentSource.match(/([A-Za-z_$][\w$]*)=(?:`computer-use`|"computer-use"|'computer-use')/)?.[1] ?? null;
  const nameExpressionPattern = String.raw`(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?|` +
    String.raw`\`computer-use\`|"computer-use"|'computer-use')`;
  const gateRegex =
    new RegExp(String.raw`\{(installWhenMissing:!0,)?name:(${nameExpressionPattern}),(isEnabled|isAvailable):\(\{([^}]*)\}\)=>([^{}]*?\.computerUse),migrate:([A-Za-z_$][\w$]*)\}`, "g");
  let sawEnabledGate = false;
  let sawUnpatchableGate = false;
  let patchedGateCount = 0;
  const patchedSource = currentSource.replace(
    gateRegex,
    (gateSource, installWhenMissing, nameExpr, availabilityProp, paramsText, expression, migrateVar) => {
      if (!isComputerUseNameExpr(nameExpr, computerUseNameVar)) {
        return gateSource;
      }

      const aliases = parseDestructuredParamAliases(paramsText);
      const featuresVar = aliases.features;
      const platformVar = aliases.platform;
      if (featuresVar == null || platformVar == null) {
        sawUnpatchableGate = true;
        return gateSource;
      }

      const darwinOnlyExpression = `${platformVar}===\`darwin\`&&${featuresVar}.computerUse`;
      const linuxExpression = `(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${featuresVar}.computerUse`;
      if (installWhenMissing != null && expression === linuxExpression) {
        sawEnabledGate = true;
        return gateSource;
      }
      if (expression === darwinOnlyExpression || expression === linuxExpression) {
        patchedGateCount += 1;
        return buildComputerUseGate({ nameExpr, availabilityProp, featuresVar, platformVar, migrateVar });
      }
      sawUnpatchableGate = true;
      return gateSource;
    },
  );

  if (patchedGateCount > 0) {
    return patchedSource;
  }

  const flexibleGateRegex =
    new RegExp(String.raw`\{([^{}]*?)name:(${nameExpressionPattern}),([^{}]*?)(isEnabled|isAvailable):\(\{([^}]*)\}\)=>([^{}]*?\.computerUse)([^{}]*?)\}`, "g");
  let flexiblePatchedCount = 0;
  const flexiblyPatchedSource = currentSource.replace(
    flexibleGateRegex,
    (gateSource, prefix, nameExpr, middleFields, availabilityProp, paramsText, expression, expressionSuffix) => {
      if (!isComputerUseNameExpr(nameExpr, computerUseNameVar)) {
        return gateSource;
      }

      const aliases = parseDestructuredParamAliases(paramsText);
      const featuresVar = aliases.features;
      const platformVar = aliases.platform;
      if (featuresVar == null || platformVar == null) {
        sawUnpatchableGate = true;
        return gateSource;
      }

      const darwinOnlyExpression = `${platformVar}===\`darwin\`&&${featuresVar}.computerUse`;
      const linuxExpression = `(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${featuresVar}.computerUse`;
      if (prefix.includes("installWhenMissing:!0,") && expression === linuxExpression) {
        sawEnabledGate = true;
        return gateSource;
      }
      if (expression.includes("win32") || expression.includes("isInternal")) {
        return gateSource;
      }
      if (expression === darwinOnlyExpression || expression === linuxExpression) {
        flexiblePatchedCount += 1;
        return buildFlexibleComputerUseGate({
          availabilityProp,
          expressionSuffix,
          featuresVar,
          middleFields,
          nameExpr,
          platformVar,
          prefix,
        });
      }
      sawUnpatchableGate = true;
      return gateSource;
    },
  );

  if (flexiblePatchedCount > 0) {
    return flexiblyPatchedSource;
  }

  if (sawEnabledGate && !sawUnpatchableGate) {
    return currentSource;
  }

  if (hasComputerUseLiteral(currentSource) && currentSource.includes("computerUse")) {
    throw new Error("Required Linux Computer Use plugin gate patch failed: could not enable bundled Computer Use on Linux");
  }

  return currentSource;
}

function applyLinuxComputerUseFeaturePatch(currentSource) {
  const patchedFeaturePattern =
    /function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\{env:[A-Za-z_$][\w$]*=process\.env,platform:[A-Za-z_$][\w$]*=process\.platform\}=\{\}\)\{return [A-Za-z_$][\w$]*===`linux`\?\{\.\.\.[A-Za-z_$][\w$]*,computerUse:!0,computerUseNodeRepl:!0\}:/;
  const currentPatchedFeaturePattern =
    /let [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*===`linux`\?\{\.\.\.[A-Za-z_$][\w$]*,computerUse:!0,computerUseNodeRepl:!0\}:[A-Za-z_$][\w$]*===`win32`&&[A-Za-z_$][\w$]*\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.[A-Za-z_$][\w$]*,computerUse:!0,computerUseNodeRepl:!0\}:[A-Za-z_$][\w$]*,/;
  const currentChainedPatchedFeaturePattern =
    /,[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*===`linux`\?\{\.\.\.[A-Za-z_$][\w$]*,computerUse:!0,computerUseNodeRepl:!0\}:[A-Za-z_$][\w$]*===`win32`&&[A-Za-z_$][\w$]*\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.[A-Za-z_$][\w$]*,computerUse:!0,computerUseNodeRepl:!0\}:[A-Za-z_$][\w$]*,/;
  const windowsOnlyFeaturePattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{env:([A-Za-z_$][\w$]*)=process\.env,platform:([A-Za-z_$][\w$]*)=process\.platform\}=\{\}\)\{return \4!==`win32`\|\|\3\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`\?\2:\{\.\.\.\2,computerUse:!0,computerUseNodeRepl:!0\}\}/g;
  const currentWindowsOnlyFeaturePattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:\4,/g;
  const chainedWindowsOnlyFeaturePattern =
    /,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:\4,/g;

  let changed = false;
  let patchedSource = currentSource.replace(
    windowsOnlyFeaturePattern,
    (_, fnName, featuresVar, envVar, platformVar) => {
      changed = true;
      return `function ${fnName}(${featuresVar},{env:${envVar}=process.env,platform:${platformVar}=process.platform}={}){return ${platformVar}===\`linux\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${platformVar}!==\`win32\`||${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==\`1\`?${featuresVar}:{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}}`;
    },
  );
  patchedSource = patchedSource.replace(
    currentWindowsOnlyFeaturePattern,
    (_, gateVar, platformVar, envVar, featuresVar) => {
      changed = true;
      return `let ${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${platformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${featuresVar},`;
    },
  );
  patchedSource = patchedSource.replace(
    chainedWindowsOnlyFeaturePattern,
    (_, gateVar, platformVar, envVar, featuresVar) => {
      changed = true;
      return `,${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${platformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${featuresVar},`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (
    patchedFeaturePattern.test(currentSource) ||
    currentPatchedFeaturePattern.test(currentSource) ||
    currentChainedPatchedFeaturePattern.test(currentSource)
  ) {
    return currentSource;
  }

  if (currentSource.includes("CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE")) {
    console.warn(
      "WARN: Could not find Computer Use desktop feature gate — skipping Linux Computer Use feature patch",
    );
  }

  return currentSource;
}

function applyLinuxComputerUseRendererAvailabilityPatch(currentSource) {
  let patchedSource = currentSource;
  let platformPredicateChanged = false;
  let availabilityChanged = false;
  let availabilityGateFound = false;

  const computerUseFeatureNeedle = "featureName:`computer_use`";
  const hasComputerUseAvailabilityGate = () =>
    currentSource.includes(computerUseFeatureNeedle) &&
    (currentSource.includes("isComputerUseAvailable") || currentSource.includes("1506311413"));
  const availabilityAlreadyPatched = () =>
    /featureName:`computer_use`[\s\S]{0,1200}?let ([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*&&\([A-Za-z_$][\w$]*===`linux`\|\|[A-Za-z_$][\w$]*&&\([A-Za-z_$][\w$]*\|\|[A-Za-z_$][\w$]*\)\),[A-Za-z_$][\w$]*=\1&&![A-Za-z_$][\w$]*&&\([A-Za-z_$][\w$]*===`linux`\|\|[A-Za-z_$][\w$]*\.enabled\)&&![A-Za-z_$][\w$]*\.isLoading/.test(patchedSource) ||
    /featureName:`computer_use`[\s\S]{0,1800}?isComputerUseFeatureEnabled:([A-Za-z_$][\w$]*)===`linux`\|\|[A-Za-z_$][\w$]*\.enabled,isComputerUseFeatureLoading:\1!==`linux`&&[A-Za-z_$][\w$]*\.isLoading,isComputerUseGateEnabled:\1===`linux`\|\|[A-Za-z_$][\w$]*,isHostCompatiblePlatform:\1===`linux`\|\|[A-Za-z_$][\w$]*\(\1\)(?:,isHostLocal:[A-Za-z_$][\w$]*)?,isPlatformLoading:/.test(patchedSource) ||
    /featureName:`computer_use`[\s\S]{0,2200}?areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*)===`linux`\|\|[A-Za-z_$][\w$]*,enabled:[A-Za-z_$][\w$]*,isAnyFeatureLoading:\1===`linux`\?!1:[A-Za-z_$][\w$]*,isComputerUseGateEnabled:\1===`linux`\|\|[A-Za-z_$][\w$]*,isHostCompatiblePlatform:\1===`linux`\|\|[A-Za-z_$][\w$]*\(\1\),isPlatformLoading:/.test(patchedSource) ||
    patchedSource.includes(availabilityPatch) ||
    patchedSource.includes(currentAvailabilityPatch);

  const findPlatformVarForAvailabilityGate = (offset, platformLoadingVar) => {
    const lookback = patchedSource.slice(Math.max(0, offset - 900), offset);
    const loadingFirst = new RegExp(String.raw`\{isLoading:${platformLoadingVar},platform:([A-Za-z_$][\w$]*)\}=`);
    const platformFirst = new RegExp(String.raw`\{platform:([A-Za-z_$][\w$]*),isLoading:${platformLoadingVar}\}=`);
    return lookback.match(loadingFirst)?.[1] ?? lookback.match(platformFirst)?.[1] ?? null;
  };

  const platformPredicateNeedle = "function hae(e){return e===`macOS`||e===`windows`}";
  const platformPredicatePatch =
    "function hae(e){return e===`macOS`||e===`windows`||e===`linux`}";
  const currentPlatformPredicateNeedle =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2===`macOS`\|\|\2===`windows`\}/g;
  const currentPlatformPredicatePatch = (_, fnName, platformVar) => {
    platformPredicateChanged = true;
    return `function ${fnName}(${platformVar}){return ${platformVar}===\`macOS\`||${platformVar}===\`windows\`||${platformVar}===\`linux\`}`;
  };
  if (patchedSource.includes(platformPredicateNeedle)) {
    patchedSource = patchedSource.split(platformPredicateNeedle).join(platformPredicatePatch);
    platformPredicateChanged = true;
  }
  patchedSource = patchedSource.replace(currentPlatformPredicateNeedle, currentPlatformPredicatePatch);

  const availabilityNeedle =
    "let m=a&&i&&s===`electron`&&u&&(c||p),h=m&&!c&&f.enabled&&!f.isLoading,g=m&&f.isLoading,_=m&&(c||f.isLoading),v;";
  const availabilityHostLocalLinuxPatch =
    "let m=a&&i&&s===`electron`&&(l===`linux`||u&&(c||p)),h=m&&!c&&(l===`linux`||f.enabled)&&!f.isLoading,g=m&&l!==`linux`&&f.isLoading,_=m&&(c||l!==`linux`&&f.isLoading),v;";
  const availabilityPatch =
    "let m=a&&(i||l===`linux`)&&s===`electron`&&(l===`linux`||u&&(c||p)),h=m&&!c&&(l===`linux`||f.enabled)&&!f.isLoading,g=m&&l!==`linux`&&f.isLoading,_=m&&(c||l!==`linux`&&f.isLoading),v;";
  if (patchedSource.includes(availabilityHostLocalLinuxPatch)) {
    patchedSource = patchedSource.split(availabilityHostLocalLinuxPatch).join(availabilityPatch);
    availabilityChanged = true;
  }
  if (patchedSource.includes(availabilityNeedle)) {
    patchedSource = patchedSource.split(availabilityNeedle).join(availabilityPatch);
    availabilityChanged = true;
  }

  const currentAvailabilityNeedle =
    "let _=a&&i&&l&&(o||m),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;";
  const currentAvailabilityPatch =
    "let _=a&&i&&(c===`linux`||l&&(o||m)),v=_&&!o&&(c===`linux`||p.enabled)&&!p.isLoading,y=_&&c!==`linux`&&p.isLoading,b=_&&(o||c!==`linux`&&p.isLoading),x;";
  if (patchedSource.includes(currentAvailabilityNeedle)) {
    patchedSource = patchedSource.split(currentAvailabilityNeedle).join(currentAvailabilityPatch);
    availabilityChanged = true;
  }

  const currentHookAvailabilityPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\1&&!\5&&([A-Za-z_$][\w$]*)\.enabled&&!\8\.isLoading,([A-Za-z_$][\w$]*)=\1&&\8\.isLoading,([A-Za-z_$][\w$]*)=\1&&\(\5\|\|\8\.isLoading\),([A-Za-z_$][\w$]*);/g;
  patchedSource = patchedSource.replace(
    currentHookAvailabilityPattern,
    (
      match,
      availabilityVar,
      enabledVar,
      isHostLocalVar,
      rolloutVar,
      platformLoadingVar,
      supportedPlatformVar,
      availableVar,
      featureQueryVar,
      fetchingVar,
      loadingVar,
      resultVar,
      offset,
    ) => {
      const contextStart = Math.max(0, offset - 900);
      const context = patchedSource.slice(contextStart, offset + match.length);
      if (!context.includes(computerUseFeatureNeedle)) {
        return match;
      }
      availabilityGateFound = true;
      const platformVar = findPlatformVarForAvailabilityGate(offset, platformLoadingVar);
      if (platformVar == null) {
        return match;
      }
      availabilityChanged = true;
      return `let ${availabilityVar}=${enabledVar}&&${isHostLocalVar}&&(${platformVar}===\`linux\`||${rolloutVar}&&(${platformLoadingVar}||${supportedPlatformVar})),${availableVar}=${availabilityVar}&&!${platformLoadingVar}&&(${platformVar}===\`linux\`||${featureQueryVar}.enabled)&&!${featureQueryVar}.isLoading,${fetchingVar}=${availabilityVar}&&${platformVar}!==\`linux\`&&${featureQueryVar}.isLoading,${loadingVar}=${availabilityVar}&&(${platformLoadingVar}||${platformVar}!==\`linux\`&&${featureQueryVar}.isLoading),${resultVar};`;
    },
  );

  const currentObjectAvailabilityPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{enabled:([A-Za-z_$][\w$]*),isComputerUseFeatureEnabled:([A-Za-z_$][\w$]*)\.enabled,isComputerUseFeatureLoading:\4\.isLoading,isComputerUseGateEnabled:([A-Za-z_$][\w$]*),isHostCompatiblePlatform:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)(?:,isHostLocal:([A-Za-z_$][\w$]*))?,isPlatformLoading:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;
  patchedSource = patchedSource.replace(
    currentObjectAvailabilityPattern,
    (
      match,
      resultVar,
      helperVar,
      enabledVar,
      featureQueryVar,
      rolloutVar,
      platformPredicateVar,
      platformVar,
      isHostLocalVar,
      platformLoadingVar,
      offset,
    ) => {
      const contextStart = Math.max(0, offset - 900);
      const context = patchedSource.slice(contextStart, offset + match.length);
      if (!context.includes(computerUseFeatureNeedle)) {
        return match;
      }
      availabilityGateFound = true;
      availabilityChanged = true;
      const hostLocalSegment = isHostLocalVar == null ? "" : `,isHostLocal:${isHostLocalVar}`;
      return `${resultVar}=${helperVar}({enabled:${enabledVar},isComputerUseFeatureEnabled:${platformVar}===\`linux\`||${featureQueryVar}.enabled,isComputerUseFeatureLoading:${platformVar}!==\`linux\`&&${featureQueryVar}.isLoading,isComputerUseGateEnabled:${platformVar}===\`linux\`||${rolloutVar},isHostCompatiblePlatform:${platformVar}===\`linux\`||${platformPredicateVar}(${platformVar})${hostLocalSegment},isPlatformLoading:${platformLoadingVar},windowType:\`electron\`})`;
    },
  );

  const currentRequiredFeaturesObjectPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*),enabled:([A-Za-z_$][\w$]*),isAnyFeatureLoading:([A-Za-z_$][\w$]*),isComputerUseGateEnabled:([A-Za-z_$][\w$]*),isHostCompatiblePlatform:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),isPlatformLoading:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;
  patchedSource = patchedSource.replace(
    currentRequiredFeaturesObjectPattern,
    (
      match,
      resultVar,
      helperVar,
      requiredFeaturesVar,
      enabledVar,
      featureLoadingVar,
      rolloutVar,
      platformPredicateVar,
      platformVar,
      platformLoadingVar,
      offset,
    ) => {
      const contextStart = Math.max(0, offset - 1200);
      const context = patchedSource.slice(contextStart, offset + match.length);
      if (!context.includes(computerUseFeatureNeedle) || !context.includes("featureName:`windows_computer_use`")) {
        return match;
      }
      availabilityGateFound = true;
      availabilityChanged = true;
      return `${resultVar}=${helperVar}({areRequiredFeaturesEnabled:${platformVar}===\`linux\`||${requiredFeaturesVar},enabled:${enabledVar},isAnyFeatureLoading:${platformVar}===\`linux\`?!1:${featureLoadingVar},isComputerUseGateEnabled:${platformVar}===\`linux\`||${rolloutVar},isHostCompatiblePlatform:${platformVar}===\`linux\`||${platformPredicateVar}(${platformVar}),isPlatformLoading:${platformLoadingVar},windowType:\`electron\`})`;
    },
  );

  if (availabilityChanged || availabilityAlreadyPatched()) {
    return patchedSource;
  }

  if (hasComputerUseAvailabilityGate() || availabilityGateFound) {
    console.warn(
      "WARN: Could not find Computer Use renderer availability gate — skipping Linux Computer Use UI availability patch",
    );
    return currentSource;
  }

  return platformPredicateChanged ? patchedSource : currentSource;
}

function applyLinuxComputerUseInstallFlowPatch(currentSource) {
  const availabilityNeedle =
    "ne=f({featureName:`computer_use`,hostId:t}),re=!ne.isLoading&&ne.enabled,";
  const availabilityPatch =
    "ne=f({featureName:`computer_use`,hostId:t}),re=!ne.isLoading&&ne.enabled||navigator.userAgent.includes(`Linux`),";
  const currentAvailabilityPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{featureName:`computer_use`,hostId:([^}]+)\}\),([^;]{0,300}?)([A-Za-z_$][\w$]*)=!\1\.isLoading&&\1\.enabled,/g;

  let changed = false;
  let patchedSource = currentSource;

  if (patchedSource.includes(availabilityNeedle)) {
    patchedSource = patchedSource.split(availabilityNeedle).join(availabilityPatch);
    changed = true;
  }

  patchedSource = patchedSource.replace(
    currentAvailabilityPattern,
    (_, queryVar, queryFn, hostExpr, between, availableVar) => {
      changed = true;
      return `${queryVar}=${queryFn}({featureName:\`computer_use\`,hostId:${hostExpr}}),${between}${availableVar}=!${queryVar}.isLoading&&${queryVar}.enabled||navigator.userAgent.includes(\`Linux\`),`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (/=[^=]+\.isLoading&&[^=]+\.enabled\|\|navigator\.userAgent\.includes\(`Linux`\),/.test(currentSource)) {
    return currentSource;
  }

  if (currentSource.includes("featureName:`computer_use`")) {
    console.warn(
      "WARN: Could not find Computer Use install flow gate — skipping Linux Computer Use install flow patch",
    );
  }

  return currentSource;
}

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  isComputerUseUiEnabled,
};
