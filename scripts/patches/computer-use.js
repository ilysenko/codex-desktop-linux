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
  const appId = env.CODEX_APP_ID || env.CODEX_LINUX_APP_ID || "codex-desktop";
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
  let match;
  while ((match = gateRegex.exec(currentSource)) != null) {
    const [gateSource, installWhenMissing, nameExpr, availabilityProp, paramsText, expression, migrateVar] = match;
    if (!isComputerUseNameExpr(nameExpr, computerUseNameVar)) {
      continue;
    }

    const aliases = parseDestructuredParamAliases(paramsText);
    const featuresVar = aliases.features;
    const platformVar = aliases.platform;
    if (featuresVar == null || platformVar == null) {
      continue;
    }

    const darwinOnlyExpression = `${platformVar}===\`darwin\`&&${featuresVar}.computerUse`;
    const linuxExpression = `(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${featuresVar}.computerUse`;
    if (installWhenMissing != null && expression === linuxExpression) {
      sawEnabledGate = true;
      continue;
    }
    if (expression === darwinOnlyExpression || expression === linuxExpression) {
      const replacement = buildComputerUseGate({ nameExpr, availabilityProp, featuresVar, platformVar, migrateVar });
      return `${currentSource.slice(0, match.index)}${replacement}${currentSource.slice(match.index + gateSource.length)}`;
    }
    sawUnpatchableGate = true;
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
  const windowsOnlyFeaturePattern =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\{env:([A-Za-z_$][\w$]*)=process\.env,platform:([A-Za-z_$][\w$]*)=process\.platform\}=\{\}\)\{return \4!==`win32`\|\|\3\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`\?\2:\{\.\.\.\2,computerUse:!0,computerUseNodeRepl:!0\}\}/;
  const currentWindowsOnlyFeaturePattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===`win32`&&([A-Za-z_$][\w$]*)\.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`\?\{\.\.\.([A-Za-z_$][\w$]*),computerUse:!0,computerUseNodeRepl:!0\}:\4,/;

  if (patchedFeaturePattern.test(currentSource) || currentPatchedFeaturePattern.test(currentSource)) {
    return currentSource;
  }

  if (windowsOnlyFeaturePattern.test(currentSource)) {
    return currentSource.replace(
      windowsOnlyFeaturePattern,
      (_, fnName, featuresVar, envVar, platformVar) =>
        `function ${fnName}(${featuresVar},{env:${envVar}=process.env,platform:${platformVar}=process.platform}={}){return ${platformVar}===\`linux\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${platformVar}!==\`win32\`||${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==\`1\`?${featuresVar}:{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}}`,
    );
  }

  if (currentWindowsOnlyFeaturePattern.test(currentSource)) {
    return currentSource.replace(
      currentWindowsOnlyFeaturePattern,
      (_, gateVar, platformVar, envVar, featuresVar) =>
        `let ${gateVar}=${platformVar}===\`linux\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${platformVar}===\`win32\`&&${envVar}.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...${featuresVar},computerUse:!0,computerUseNodeRepl:!0}:${featuresVar},`,
    );
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

  const platformPredicateNeedle = "function hae(e){return e===`macOS`||e===`windows`}";
  const platformPredicatePatch =
    "function hae(e){return e===`macOS`||e===`windows`||e===`linux`}";
  const currentPlatformPredicateNeedle =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{return \2===`macOS`\|\|\2===`windows`\}/;
  const currentPlatformPredicatePatch = (_, fnName, platformVar) =>
    `function ${fnName}(${platformVar}){return ${platformVar}===\`macOS\`||${platformVar}===\`windows\`||${platformVar}===\`linux\`}`;
  if (patchedSource.includes(platformPredicatePatch)) {
    // Already patched.
  } else if (patchedSource.includes(platformPredicateNeedle)) {
    patchedSource = patchedSource.replace(platformPredicateNeedle, platformPredicatePatch);
  } else if (currentPlatformPredicateNeedle.test(patchedSource)) {
    patchedSource = patchedSource.replace(currentPlatformPredicateNeedle, currentPlatformPredicatePatch);
  }

  const availabilityNeedle =
    "let m=a&&i&&s===`electron`&&u&&(c||p),h=m&&!c&&f.enabled&&!f.isLoading,g=m&&f.isLoading,_=m&&(c||f.isLoading),v;";
  const availabilityHostLocalLinuxPatch =
    "let m=a&&i&&s===`electron`&&(l===`linux`||u&&(c||p)),h=m&&!c&&(l===`linux`||f.enabled)&&!f.isLoading,g=m&&l!==`linux`&&f.isLoading,_=m&&(c||l!==`linux`&&f.isLoading),v;";
  const availabilityPatch =
    "let m=a&&(i||l===`linux`)&&s===`electron`&&(l===`linux`||u&&(c||p)),h=m&&!c&&(l===`linux`||f.enabled)&&!f.isLoading,g=m&&l!==`linux`&&f.isLoading,_=m&&(c||l!==`linux`&&f.isLoading),v;";
  if (patchedSource.includes(availabilityPatch)) {
    return patchedSource;
  }

  if (patchedSource.includes(availabilityHostLocalLinuxPatch)) {
    return patchedSource.replace(availabilityHostLocalLinuxPatch, availabilityPatch);
  }

  if (patchedSource.includes(availabilityNeedle)) {
    return patchedSource.replace(availabilityNeedle, availabilityPatch);
  }

  const currentAvailabilityNeedle =
    "let _=a&&i&&l&&(o||m),v=_&&!o&&p.enabled&&!p.isLoading,y=_&&p.isLoading,b=_&&(o||p.isLoading),x;";
  const currentAvailabilityPatch =
    "let _=a&&i&&(c===`linux`||l&&(o||m)),v=_&&!o&&(c===`linux`||p.enabled)&&!p.isLoading,y=_&&c!==`linux`&&p.isLoading,b=_&&(o||c!==`linux`&&p.isLoading),x;";
  if (patchedSource.includes(currentAvailabilityPatch)) {
    return patchedSource;
  }

  if (patchedSource.includes(currentAvailabilityNeedle)) {
    return patchedSource.replace(currentAvailabilityNeedle, currentAvailabilityPatch);
  }

  if (currentSource.includes("featureName:`computer_use`") && currentSource.includes("isComputerUseAvailable")) {
    console.warn(
      "WARN: Could not find Computer Use renderer availability gate — skipping Linux Computer Use UI availability patch",
    );
  }

  return patchedSource;
}

function applyLinuxComputerUseInstallFlowPatch(currentSource) {
  const availabilityNeedle =
    "ne=f({featureName:`computer_use`,hostId:t}),re=!ne.isLoading&&ne.enabled,";
  const availabilityPatch =
    "ne=f({featureName:`computer_use`,hostId:t}),re=!ne.isLoading&&ne.enabled||navigator.userAgent.includes(`Linux`),";
  const currentAvailabilityPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{featureName:`computer_use`,hostId:([^}]+)\}\),([^;]{0,300}?)([A-Za-z_$][\w$]*)=!\1\.isLoading&&\1\.enabled,/;

  if (currentSource.includes(availabilityPatch)) {
    return currentSource;
  }

  if (currentSource.includes(availabilityNeedle)) {
    return currentSource.replace(availabilityNeedle, availabilityPatch);
  }

  if (/=[^=]+\.isLoading&&[^=]+\.enabled\|\|navigator\.userAgent\.includes\(`Linux`\),/.test(currentSource)) {
    return currentSource;
  }

  if (currentAvailabilityPattern.test(currentSource)) {
    return currentSource.replace(
      currentAvailabilityPattern,
      (_, queryVar, queryFn, hostExpr, between, availableVar) =>
        `${queryVar}=${queryFn}({featureName:\`computer_use\`,hostId:${hostExpr}}),${between}${availableVar}=!${queryVar}.isLoading&&${queryVar}.enabled||navigator.userAgent.includes(\`Linux\`),`,
    );
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
