"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  requireName,
} = require("../lib/minified-js.js");

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
const NATIVE_APPS_PLATFORM_GATE_LOOKAHEAD = 2400;

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

function rewriteComputerUseMarketplaceSelector(currentSource) {
  const marketplaceGateRegex =
    /if\(!\(\s*([A-Za-z_$][\w$]*)\.platform!==`darwin`\|\|!\s*\1\.marketplacePluginNames\.includes\(`computer-use`\)\s*\)\)return\s*\1\.desktopFeatureAvailability\.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/g;
  return currentSource.replace(
    marketplaceGateRegex,
    (_match, ref) =>
      `if(!((${ref}.platform!==\`darwin\`&&${ref}.platform!==\`linux\`)||!${ref}.marketplacePluginNames.includes(\`computer-use\`)))return ${ref}.platform===\`darwin\`&&${ref}.desktopFeatureAvailability.computerUseNodeRepl?\`node-repl\`:\`legacy-mcp\``,
  );
}

function hasPatchedComputerUseMarketplaceSelector(currentSource) {
  return /if\(!\(\(\s*([A-Za-z_$][\w$]*)\.platform!==`darwin`&&\1\.platform!==`linux`\)\|\|!\1\.marketplacePluginNames\.includes\(`computer-use`\)\)\)return\s+\1\.platform===`darwin`&&\1\.desktopFeatureAvailability\.computerUseNodeRepl\?`node-repl`:`legacy-mcp`/.test(currentSource);
}

function stripInstallWhenMissingRequiresOptIn(value) {
  return value.replace(/installWhenMissingRequiresOptIn:!0,/g, "");
}

function hasInstallWhenMissingRequiresOptIn(value) {
  return value.includes("installWhenMissingRequiresOptIn:!0,");
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
  const sanitizedPrefix = stripInstallWhenMissingRequiresOptIn(prefix);
  const sanitizedMiddleFields = stripInstallWhenMissingRequiresOptIn(middleFields);
  const sanitizedExpressionSuffix = stripInstallWhenMissingRequiresOptIn(expressionSuffix);
  const installField = sanitizedPrefix.includes("installWhenMissing:!0,") ||
      sanitizedMiddleFields.includes("installWhenMissing:!0,") ||
      sanitizedExpressionSuffix.includes("installWhenMissing:!0,")
    ? ""
    : "installWhenMissing:!0,";
  return `{${sanitizedPrefix}${installField}name:${nameExpr},${sanitizedMiddleFields}${availabilityProp}:({features:${featuresVar},platform:${platformVar}})=>(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${featuresVar}.computerUse${sanitizedExpressionSuffix}}`;
}

function hasComputerUseLiteral(source) {
  return /(?:`computer-use`|"computer-use"|'computer-use')/.test(source);
}

function hasComputerUseNativeAppsMention(source) {
  return source.includes("native-desktop-apps") &&
    (
      hasComputerUseLiteral(source) ||
      source.includes("computer-use-native-desktop-app-icon") ||
      source.includes("computerUse.nativeApps") ||
      source.includes("computerUse.label") ||
      hasComputerUseNativeAppsResultShape(source)
    );
}

function hasComputerUseNativeAppsResultShape(source) {
  return /nativeApps:[A-Za-z_$][\w$]*/.test(source) &&
    /isLoading:[A-Za-z_$][\w$]*/.test(source) &&
    /[A-Za-z_$][\w$]*\.data\?\.apps/.test(source);
}

function isNativeAppsPlatformGateContext(source, matchEnd, nextPlatformGatePattern) {
  const rest = source.slice(matchEnd);
  const nextGateIndex = rest.search(nextPlatformGatePattern);
  const contextLength = nextGateIndex === -1
    ? NATIVE_APPS_PLATFORM_GATE_LOOKAHEAD
    : Math.min(nextGateIndex, NATIVE_APPS_PLATFORM_GATE_LOOKAHEAD);
  return rest.slice(0, contextLength).includes("native-desktop-apps");
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

  const sourceWithMarketplaceSelector = rewriteComputerUseMarketplaceSelector(currentSource);
  const hasMarketplaceSelectorPatch =
    sourceWithMarketplaceSelector !== currentSource ||
    hasPatchedComputerUseMarketplaceSelector(sourceWithMarketplaceSelector);

  const computerUseNameVar = sourceWithMarketplaceSelector.match(/([A-Za-z_$][\w$]*)=(?:`computer-use`|"computer-use"|'computer-use')/)?.[1] ?? null;
  const nameExpressionPattern = String.raw`(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?|` +
    String.raw`\`computer-use\`|"computer-use"|'computer-use')`;
  const gateRegex =
    new RegExp(String.raw`\{(installWhenMissing:!0,)?name:(${nameExpressionPattern}),(isEnabled|isAvailable):\(\{([^}]*)\}\)=>([^{}]*?\.computerUse),migrate:([A-Za-z_$][\w$]*)\}`, "g");
  let sawEnabledGate = false;
  let sawUnpatchableGate = false;
  let patchedGateCount = 0;
  const patchedSource = sourceWithMarketplaceSelector.replace(
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
  const flexiblyPatchedSource = sourceWithMarketplaceSelector.replace(
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
    return sourceWithMarketplaceSelector;
  }

  if (hasMarketplaceSelectorPatch && !sawUnpatchableGate) {
    return sourceWithMarketplaceSelector;
  }

  if (hasComputerUseLiteral(sourceWithMarketplaceSelector) && sourceWithMarketplaceSelector.includes("computerUse")) {
    throw new Error("Required Linux Computer Use plugin gate patch failed: could not enable bundled Computer Use on Linux");
  }

  return sourceWithMarketplaceSelector;
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
  let nativeAppsGateChanged = false;

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
      if (!context.includes(computerUseFeatureNeedle)) {
        return match;
      }
      availabilityGateFound = true;
      availabilityChanged = true;
      return `${resultVar}=${helperVar}({areRequiredFeaturesEnabled:${platformVar}===\`linux\`||${requiredFeaturesVar},enabled:${enabledVar},isAnyFeatureLoading:${platformVar}===\`linux\`?!1:${featureLoadingVar},isComputerUseGateEnabled:${platformVar}===\`linux\`||${rolloutVar},isHostCompatiblePlatform:${platformVar}===\`linux\`||${platformPredicateVar}(${platformVar}),isPlatformLoading:${platformLoadingVar},windowType:\`electron\`})`;
    },
  );

  const currentSettingsAvailabilityConsumerPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([^)]*)\),\{platform:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\);/g;
  patchedSource = patchedSource.replace(
    currentSettingsAvailabilityConsumerPattern,
    (match, availabilityVar, _hookVar, _hookArg, platformVar, _platformHookVar, offset) => {
      const nextSource = patchedSource.slice(offset + match.length, offset + match.length + 3000);
      if (
        nextSource.startsWith(`${platformVar}===\`linux\`&&(${availabilityVar}={`) ||
        !nextSource.includes(`computerUseAvailability:${availabilityVar}`) ||
        !nextSource.includes(`${availabilityVar}.available`)
      ) {
        return match;
      }
      availabilityChanged = true;
      return `${match}${platformVar}===\`linux\`&&(${availabilityVar}={...${availabilityVar},available:!0,isFetching:!1,isLoading:!1});`;
    },
  );

  const currentSettingsAvailablePluginsPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\3\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*);/g;
  patchedSource = patchedSource.replace(
    currentSettingsAvailablePluginsPattern,
    (
      match,
      pluginsQueryVar,
      pluginsHookVar,
      selectedHostVar,
      emptyPluginsVar,
      marketplacePathVar,
      marketplacePathHookVar,
      featureFlagVar,
      featureFlagHookVar,
      featureFlagArgVar,
      computerUsePluginVar,
      offset,
    ) => {
      const contextStart = Math.max(0, offset - 900);
      const lookback = patchedSource.slice(contextStart, offset);
      const nextSource = patchedSource.slice(offset + match.length, offset + match.length + 800);
      const platformVar = lookback.match(/\{computerUseAvailability:[A-Za-z_$][\w$]*,platform:([A-Za-z_$][\w$]*)\}=/)?.[1] ?? null;
      const selectorMatch = nextSource.match(
        new RegExp(
          String.raw`${computerUsePluginVar}=[A-Za-z_$][\w$]*\(${pluginsQueryVar}\.availablePlugins,([A-Za-z_$][\w$]*),${marketplacePathVar}\)`,
        ),
      );
      const pluginNameVar = selectorMatch?.[1] ?? null;
      if (
        platformVar == null ||
        pluginNameVar == null ||
        !nextSource.includes(`${pluginsQueryVar}.availablePlugins`) ||
        nextSource.startsWith(`${platformVar}===\`linux\`&&!${pluginsQueryVar}.availablePlugins.some`)
      ) {
        return match;
      }
      availabilityChanged = true;
      return `let ${pluginsQueryVar}=${pluginsHookVar}(${selectedHostVar},${emptyPluginsVar}),${marketplacePathVar}=${marketplacePathHookVar}(${selectedHostVar}),${featureFlagVar}=${featureFlagHookVar}(${featureFlagArgVar});${platformVar}===\`linux\`&&!${pluginsQueryVar}.availablePlugins.some(e=>e.plugin?.name===${pluginNameVar}||e.plugin?.id?.split(\`@\`)[0]===${pluginNameVar})&&(${pluginsQueryVar}={...${pluginsQueryVar},availablePlugins:[...${pluginsQueryVar}.availablePlugins,{marketplaceName:\`openai-curated\`,marketplacePath:${marketplacePathVar},logoPath:new URL(\`computer-use-plugin-icon-linux.png\`,import.meta.url).href,logoDarkPath:new URL(\`computer-use-plugin-icon-linux.png\`,import.meta.url).href,plugin:{id:${pluginNameVar},name:${pluginNameVar},installed:!0,enabled:!0}}]});let ${computerUsePluginVar};`;
    },
  );

  if (hasComputerUseNativeAppsMention(patchedSource)) {
    const nativeAppsPlatformPattern =
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)===`macOS`\|\|\3===`windows`\)/g;
    const nativeAppsPlatformBoundaryPattern =
      /[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*&&\(([A-Za-z_$][\w$]*)===`macOS`\|\|\1===`windows`(?:\|\|\1===`linux`)?\)/;
    patchedSource = patchedSource.replace(
      nativeAppsPlatformPattern,
      (match, availableVar, enabledVar, platformVar, offset) => {
        if (!isNativeAppsPlatformGateContext(patchedSource, offset + match.length, nativeAppsPlatformBoundaryPattern)) {
          return match;
        }
        nativeAppsGateChanged = true;
        return `${availableVar}=${enabledVar}&&(${platformVar}===\`macOS\`||${platformVar}===\`windows\`||${platformVar}===\`linux\`)`;
      },
    );
  }

  if (availabilityChanged || nativeAppsGateChanged || availabilityAlreadyPatched()) {
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
  const currentRequiredFeaturesObjectPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*),enabled:([A-Za-z_$][\w$]*),isAnyFeatureLoading:([A-Za-z_$][\w$]*),isComputerUseGateEnabled:([A-Za-z_$][\w$]*),isHostCompatiblePlatform:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),isPlatformLoading:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;

  let changed = false;
  let patchedSource = currentSource;

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
      if (!context.includes("featureName:`computer_use`")) {
        return match;
      }
      changed = true;
      return `${resultVar}=${helperVar}({areRequiredFeaturesEnabled:${platformVar}===\`linux\`||${requiredFeaturesVar},enabled:${enabledVar},isAnyFeatureLoading:${platformVar}===\`linux\`?!1:${featureLoadingVar},isComputerUseGateEnabled:${platformVar}===\`linux\`||${rolloutVar},isHostCompatiblePlatform:${platformVar}===\`linux\`||${platformPredicateVar}(${platformVar}),isPlatformLoading:${platformLoadingVar},windowType:\`electron\`})`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (
    /featureName:`computer_use`[\s\S]{0,2200}?areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*)===`linux`\|\|[A-Za-z_$][\w$]*,enabled:[A-Za-z_$][\w$]*,isAnyFeatureLoading:\1===`linux`\?!1:[A-Za-z_$][\w$]*,isComputerUseGateEnabled:\1===`linux`\|\|[A-Za-z_$][\w$]*,isHostCompatiblePlatform:\1===`linux`\|\|[A-Za-z_$][\w$]*\(\1\),isPlatformLoading:/.test(currentSource)
  ) {
    return currentSource;
  }

  if (currentSource.includes("featureName:`computer_use`")) {
    console.warn(
      "WARN: Could not find Computer Use install flow gate — skipping Linux Computer Use install flow patch",
    );
  }

  return currentSource;
}

function findHandlerValue(source, methodName) {
  const key = `${JSON.stringify(methodName)}:`;
  const keyIndex = source.indexOf(key);
  if (keyIndex === -1) {
    return null;
  }
  const valueStart = keyIndex + key.length;
  const valueEnd = findExpressionEnd(source, valueStart);
  if (valueEnd == null || valueEnd <= valueStart) {
    return null;
  }
  return {
    key,
    keyIndex,
    value: source.slice(valueStart, valueEnd),
    valueEnd,
    valueStart,
  };
}

function findExpressionEnd(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
    } else if (char === "(" || char === "{" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "}" || char === "]") {
      if (depth > 0) {
        depth -= 1;
      } else {
        return index;
      }
    } else if (char === "," && depth === 0) {
      return index;
    }
  }
  return source.length;
}

function replaceHandlerValue(source, methodName, replacement) {
  const handler = findHandlerValue(source, methodName);
  if (handler == null) {
    return { changed: false, source };
  }
  const nextValue = typeof replacement === "function"
    ? replacement(handler.value)
    : replacement;
  return {
    changed: nextValue !== handler.value,
    source: source.slice(0, handler.valueStart) + nextValue + source.slice(handler.valueEnd),
  };
}

function insertAfterUseStrict(source, insertion) {
  const doubleStrict = "\"use strict\";";
  const singleStrict = "'use strict';";
  const insertAt = source.startsWith(doubleStrict)
    ? doubleStrict.length
    : source.startsWith(singleStrict)
      ? singleStrict.length
      : 0;
  return source.slice(0, insertAt) + insertion + source.slice(insertAt);
}

function linuxNativeDesktopAppsHelper({ childProcessVar, fsVar, osVar, pathVar }) {
  return [
    `function codexLinuxNativeDesktopAppsPayload(e){return e?.params??e??{}}`,
    `function codexLinuxNativeDesktopAppsHome(){return process.env.HOME||${osVar}.homedir?.()||\`\`}`,
    `function codexLinuxNativeDesktopAppsExecutable(e){if(!e)return null;if(e.includes(\`/\`)){try{return ${fsVar}.existsSync(e)&&(${fsVar}.accessSync(e,${fsVar}.constants.X_OK),!0)?e:null}catch{return null}}for(let t of(process.env.PATH||\`\`).split(\`:\`)){if(!t||!${pathVar}.isAbsolute(t))continue;let n=${pathVar}.join(t,e);try{if(${fsVar}.existsSync(n)&&(${fsVar}.accessSync(n,${fsVar}.constants.X_OK),!0))return n}catch{}}return null}`,
    `function codexLinuxNativeDesktopAppsBackendPath(){let e=process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE?.trim(),t=process.env.CODEX_ELECTRON_RESOURCES_PATH||process.resourcesPath,n=process.env.CODEX_HOME||(codexLinuxNativeDesktopAppsHome()?${pathVar}.join(codexLinuxNativeDesktopAppsHome(),\`.codex\`):\`\`),r=[e,t&&${pathVar}.join(t,\`plugins\`,\`openai-bundled\`,\`plugins\`,\`computer-use\`,\`bin\`,\`codex-computer-use-linux\`),n&&${pathVar}.join(n,\`plugins\`,\`cache\`,\`openai-bundled\`,\`computer-use\`,\`latest\`,\`bin\`,\`codex-computer-use-linux\`),\`codex-computer-use-linux\`];for(let e of r){if(typeof e!==\`string\`||e.length===0)continue;let t=codexLinuxNativeDesktopAppsExecutable(e);if(t)return t}return null}`,
    `function codexLinuxNativeDesktopAppsRun(e){let t=codexLinuxNativeDesktopAppsBackendPath();if(t==null)return null;try{let n=${childProcessVar}.spawnSync(t,e,{encoding:\`utf8\`,env:process.env,maxBuffer:1048576,timeout:2500});if(n.error||n.status!==0)return null;return JSON.parse(n.stdout||\`null\`)}catch{return null}}`,
    `function codexLinuxNativeDesktopAppsDataDirs(){let e=codexLinuxNativeDesktopAppsHome(),t=process.env.XDG_DATA_HOME||(e&&${pathVar}.join(e,\`.local\`,\`share\`)),n=(process.env.XDG_DATA_DIRS||\`/usr/local/share:/usr/share\`).split(\`:\`).filter(Boolean);return[...t?[t]:[],...n]}`,
    `function codexLinuxNativeDesktopAppsUnescape(e){return String(e??\`\`).replace(/\\\\s/g,\` \`).replace(/\\\\n/g,\`\\n\`).replace(/\\\\t/g,\`\\t\`).replace(/\\\\r/g,\`\\r\`).replace(/\\\\\\\\/g,\`\\\\\`)}`,
    `function codexLinuxNativeDesktopAppsParseDesktopFile(e){try{let t=${fsVar}.readFileSync(e,\`utf8\`).split(/\\r?\\n/),n=!1,r={id:${pathVar}.basename(e,\`.desktop\`),path:e};for(let e of t){let t=e.trim();if(!t||t.startsWith(\`#\`))continue;if(t.startsWith(\`[\`)&&t.endsWith(\`]\`)){n=t===\`[Desktop Entry]\`;continue}if(!n)continue;let i=t.indexOf(\`=\`);if(i<1)continue;let a=t.slice(0,i),o=codexLinuxNativeDesktopAppsUnescape(t.slice(i+1));a===\`Name\`?r.name=o:a===\`Icon\`?r.icon=o:a===\`StartupWMClass\`?r.startupWmClass=o:a===\`Exec\`?r.exec=o:a===\`NoDisplay\`?r.noDisplay=o:a===\`Hidden\`&&(r.hidden=o)}return r.hidden===\`true\`?null:r}catch{return null}}`,
    `function codexLinuxNativeDesktopAppsDesktopEntries(){let e=[];for(let t of codexLinuxNativeDesktopAppsDataDirs()){let n=${pathVar}.join(t,\`applications\`);if(!${fsVar}.existsSync(n))continue;let r=[n],i=0;for(;r.length>0&&i<2500;){let t=r.pop();i+=1;let n;try{n=${fsVar}.readdirSync(t,{withFileTypes:!0})}catch{continue}for(let i of n){let n=${pathVar}.join(t,i.name);if(i.isDirectory())r.push(n);else if(i.isFile()&&i.name.endsWith(\`.desktop\`)){let t=codexLinuxNativeDesktopAppsParseDesktopFile(n);t&&e.push(t)}}}}return e}`,
    `function codexLinuxNativeDesktopAppsNorm(e){return String(e??\`\`).trim().toLowerCase()}`,
    `function codexLinuxNativeDesktopAppsDesktopScore(e,t){let n=[t.app_id,t.wm_class,t.name].map(codexLinuxNativeDesktopAppsNorm).filter(Boolean),r=codexLinuxNativeDesktopAppsNorm(e.id),i=codexLinuxNativeDesktopAppsNorm(e.startupWmClass),a=codexLinuxNativeDesktopAppsNorm(e.name);let o=0;for(let e of n){r===e&&(o=Math.max(o,90));r===\`\${e}.desktop\`&&(o=Math.max(o,90));r.endsWith(\`.\${e}\`)&&(o=Math.max(o,70));i===e&&(o=Math.max(o,100));a===e&&(o=Math.max(o,45))}return o}`,
    `function codexLinuxNativeDesktopAppsDesktopFor(e,t){let n=null,r=0;for(let i of t){let t=codexLinuxNativeDesktopAppsDesktopScore(i,e);t>r&&(n=i,r=t)}return n}`,
    `function codexLinuxNativeDesktopAppsTitle(e){let t=String(e??\`\`).trim().split(/[._-]+/).filter(Boolean).map(e=>e.charAt(0).toUpperCase()+e.slice(1)).join(\` \`);return t||\`Desktop app\`}`,
    `function codexLinuxNativeDesktopAppsCandidate(e,t){let n=codexLinuxNativeDesktopAppsDesktopFor(e,t),r=String(e.app_id??\`\`).trim(),i=String(e.wm_class??\`\`).trim(),a=n?.id||r||i||(e.pid!=null?\`pid:\${e.pid}\`:\`\`);if(!a)return null;let o=n?.name||codexLinuxNativeDesktopAppsTitle(r||i||e.name||e.title),s=n?.path||\`linux:\${a}\`;return{bundleId:a,appPath:s,displayName:o,description:e.title?\`Window: \${e.title}\`:\`Linux desktop app\`,iconSmall:\`\`,linuxAppId:r||null,wmClass:i||null,pid:e.pid??null,windowId:e.window_id??null,focused:e.focused===!0,backend:e.backend??null,clientType:e.client_type??null}}`,
    `function codexLinuxNativeDesktopAppsAdd(e,t){if(t==null)return;let n=codexLinuxNativeDesktopAppsNorm(t.bundleId||t.appPath||t.displayName),r=e.get(n);if(r==null||t.focused&&!r.focused||r.appPath.startsWith(\`linux:\`)&&!t.appPath.startsWith(\`linux:\`))e.set(n,t)}`,
    `function codexLinuxNativeDesktopAppsFromWindows(e,t){let n=new Map;for(let r of Array.isArray(e)?e:[])codexLinuxNativeDesktopAppsAdd(n,codexLinuxNativeDesktopAppsCandidate(r,t));return[...n.values()].sort((e,t)=>Number(t.focused)-Number(e.focused)||e.displayName.localeCompare(t.displayName)).slice(0,20)}`,
    `async function codexLinuxNativeDesktopApps(){let e=codexLinuxNativeDesktopAppsRun([\`windows\`]),t=codexLinuxNativeDesktopAppsDesktopEntries(),n=codexLinuxNativeDesktopAppsFromWindows(e?.windows,t);return{apps:n}}`,
    `function codexLinuxNativeDesktopAppsIconDirs(){let e=codexLinuxNativeDesktopAppsHome(),t=codexLinuxNativeDesktopAppsDataDirs(),n=[];for(let r of t)n.push(${pathVar}.join(r,\`icons\`)),n.push(${pathVar}.join(r,\`pixmaps\`));e&&n.push(${pathVar}.join(e,\`.icons\`));return n}`,
    `function codexLinuxNativeDesktopAppsResolveIcon(e){if(!e)return null;if(${pathVar}.isAbsolute(e)){try{return ${fsVar}.existsSync(e)?e:null}catch{return null}}let t=e.match(/\\.(png|svg|xpm)$/i)?[e]:[\`\${e}.png\`,\`\${e}.svg\`,\`\${e}.xpm\`],n=[\`hicolor/512x512/apps\`,\`hicolor/256x256/apps\`,\`hicolor/128x128/apps\`,\`hicolor/64x64/apps\`,\`hicolor/48x48/apps\`,\`hicolor/scalable/apps\`,\`hicolor/symbolic/apps\`,\`.\`];for(let e of codexLinuxNativeDesktopAppsIconDirs())for(let r of n)for(let n of t){let t=${pathVar}.join(e,r,n);try{if(${fsVar}.existsSync(t))return t}catch{}}return null}`,
    `function codexLinuxNativeDesktopAppsIconDataUrl(e){try{let t=${pathVar}.extname(e).toLowerCase(),n=t===\`.svg\`?\`image/svg+xml\`:t===\`.xpm\`?\`image/x-xpixmap\`:\`image/png\`;return\`data:\${n};base64,\${${fsVar}.readFileSync(e).toString(\`base64\`)}\`}catch{return\`\`}}`,
    `async function codexLinuxNativeDesktopAppIcon(e){let t=codexLinuxNativeDesktopAppsPayload(e),n=String(t.appPath??\`\`),r=null;if(n.endsWith(\`.desktop\`)&&${fsVar}.existsSync(n))r=codexLinuxNativeDesktopAppsParseDesktopFile(n)?.icon??null;let i=codexLinuxNativeDesktopAppsResolveIcon(r);return{iconSmall:i?codexLinuxNativeDesktopAppsIconDataUrl(i):\`\`}}`,
  ].join("");
}

function applyLinuxNativeDesktopAppsHandlerPatch(currentSource) {
  if (currentSource.includes("codexLinuxNativeDesktopApps(")) {
    return currentSource;
  }

  if (findHandlerValue(currentSource, "native-desktop-apps") == null) {
    if (currentSource.includes("native-desktop-apps") || currentSource.includes("handleVSCodeRequest")) {
      console.warn(
        "WARN: Could not find native-desktop-apps handler — skipping Linux native desktop apps patch",
      );
    }
    return currentSource;
  }

  const childProcessVar =
    requireName(currentSource, "node:child_process") ?? requireName(currentSource, "child_process");
  const fsVar = requireName(currentSource, "node:fs");
  const osVar = requireName(currentSource, "node:os") ?? requireName(currentSource, "os");
  const pathVar = requireName(currentSource, "node:path");
  if (childProcessVar == null || fsVar == null || osVar == null || pathVar == null) {
    console.warn(
      "WARN: Could not find node:child_process/node:fs/node:os/node:path dependencies — skipping Linux native desktop apps patch",
    );
    return currentSource;
  }

  let patchedSource = insertAfterUseStrict(
    currentSource,
    linuxNativeDesktopAppsHelper({ childProcessVar, fsVar, osVar, pathVar }),
  );

  const nativeHandler = findHandlerValue(patchedSource, "native-desktop-apps");
  if (nativeHandler == null) {
    console.warn(
      "WARN: Could not find native-desktop-apps handler after helper insertion — skipping Linux native desktop apps patch",
    );
    return currentSource;
  }
  const nativeHandlerKeyIndex = nativeHandler.keyIndex;

  const nativeAppsReplacement = replaceHandlerValue(
    patchedSource,
    "native-desktop-apps",
    (handler) => `async(...e)=>process.platform===\`linux\`?codexLinuxNativeDesktopApps(e[0]):await(${handler})(...e)`,
  );
  if (!nativeAppsReplacement.changed) {
    console.warn(
      "WARN: Could not wrap native-desktop-apps handler — skipping Linux native desktop apps patch",
    );
    return currentSource;
  }
  patchedSource = nativeAppsReplacement.source;

  if (findHandlerValue(patchedSource, "computer-use-native-desktop-app-icon") == null) {
    const iconHandler =
      `"computer-use-native-desktop-app-icon":async(e)=>process.platform===\`linux\`?codexLinuxNativeDesktopAppIcon(e):{iconSmall:\`\`},`;
    patchedSource =
      patchedSource.slice(0, nativeHandlerKeyIndex) +
      iconHandler +
      patchedSource.slice(nativeHandlerKeyIndex);
  } else {
    const iconReplacement = replaceHandlerValue(
      patchedSource,
      "computer-use-native-desktop-app-icon",
      (handler) => `async(...e)=>process.platform===\`linux\`?codexLinuxNativeDesktopAppIcon(e[0]):await(${handler})(...e)`,
    );
    patchedSource = iconReplacement.source;
  }

  return patchedSource;
}

module.exports = {
  COMPUTER_USE_UI_ENV_VAR,
  COMPUTER_USE_UI_SETTINGS_KEY,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxNativeDesktopAppsHandlerPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  isComputerUseUiEnabled,
};
