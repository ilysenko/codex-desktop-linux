"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  findMatchingBrace,
  requireName,
} = require("../lib/minified-js.js");

const COMPUTER_USE_UI_ENV_VAR = "CODEX_LINUX_ENABLE_COMPUTER_USE_UI";
const COMPUTER_USE_UI_SETTINGS_KEY = "codex-linux-computer-use-ui-enabled";
const COMPUTER_USE_CURSOR_HANDLER_MARKER =
  "setRemoteHostedPIPContentComputerUseCursorLocationHandler";
const LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER =
  "codexLinuxRegisterComputerUseCursorHandler";

function linuxComputerUseCursorBridgeRuntimeSource() {
  return [
    "function codexLinuxComputerUseCursorComponent(e){return typeof e==`string`&&e!==`.`&&e!==`..`&&/^[A-Za-z0-9._-]+$/.test(e)}function codexLinuxComputerUseCursorSocketPath(){let e=process.env.XDG_RUNTIME_DIR?.trim();if(!e)return null;let t=require(`node:path`);if(!t.isAbsolute(e))return null;let n=(process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||`codex-desktop`).trim();codexLinuxComputerUseCursorComponent(n)||(n=`codex-desktop`);let r=process.env.CODEX_LINUX_INSTANCE_ID?.trim()||``;if(r&&!codexLinuxComputerUseCursorComponent(r))return null;let i=r?t.join(e,n,`instances`,r,`computer-use-cursor.sock`):t.join(e,n,`computer-use-cursor.sock`);return Buffer.byteLength(i,`utf8`)<=100?i:null}",
    "function codexLinuxRegisterComputerUseCursorHandler(e){let t=codexLinuxRegisterComputerUseCursorHandler;t.handler=e;if(t.server!=null)return!0;let n=codexLinuxComputerUseCursorSocketPath();if(n==null)return!1;try{let r=require(`node:path`),i=require(`node:fs`),a=require(`node:net`),o=require(`electron`),s=r.dirname(n),l=typeof process.getuid==`function`?process.getuid():null,u=i.lstatSync(process.env.XDG_RUNTIME_DIR.trim());if(!u.isDirectory()||u.isSymbolicLink()||l!=null&&u.uid!==l||(u.mode&63)!==0)return!1;i.mkdirSync(s,{recursive:!0,mode:448});let c=i.lstatSync(s);if(!c.isDirectory()||c.isSymbolicLink()||l!=null&&c.uid!==l)return!1;i.chmodSync(s,448);if(i.existsSync(n)){let e=i.lstatSync(n);if(!(e.isSocket()||e.isSymbolicLink())||l!=null&&e.uid!==l)return!1;i.unlinkSync(n)}let d=()=>{let e=t.socketIdentity;t.socketIdentity=null;if(e==null)return;try{let r=i.lstatSync(n);r.dev===e.dev&&r.ino===e.ino&&r.isSocket()&&i.unlinkSync(n)}catch{}},p=()=>{t.timer!=null&&(clearTimeout(t.timer),t.timer=null);let e=t.server;t.server=null;try{e?.close()}catch{}d()},m=()=>{try{let e=t.handler;if(typeof e!=`function`)return;let n=o.screen.getCursorScreenPoint();e({isActive:!0,x:n.x,y:n.y}),t.timer!=null&&clearTimeout(t.timer),t.timer=setTimeout(()=>{try{let e=t.handler;typeof e==`function`&&e({isActive:!1,x:n.x,y:n.y})}catch{}finally{t.timer=null}},900),t.timer.unref?.()}catch{}},f=a.createServer(e=>{let t=``,n=!1;e.setEncoding(`utf8`),e.setTimeout(250,()=>e.destroy()),e.on(`error`,()=>{}),e.on(`data`,r=>{if(n)return;t+=r;if(t.length>64){n=!0,e.destroy();return}if(t.includes(`\n`)){n=!0,t.trim()===`pointer`&&m(),e.end()}})});return t.server=f,f.on(`error`,()=>{t.server===f&&(t.server=null),d()}),f.listen(n,()=>{try{i.chmodSync(n,384);let e=i.lstatSync(n);if(!e.isSocket()||l!=null&&e.uid!==l)throw Error(`unsafe cursor socket`);t.socketIdentity={dev:e.dev,ino:e.ino},f.unref()}catch{p()}}),t.cleanupRegistered||(t.cleanupRegistered=!0,o.app.once(`before-quit`,p)),!0}catch{return t.server=null,!1}}",
  ].join("");
}

function findComputerUseCursorRegistrationFunction(source) {
  const markerIndex = source.indexOf(COMPUTER_USE_CURSOR_HANDLER_MARKER);
  if (markerIndex === -1) {
    return null;
  }

  const functionRegex = /function ([A-Za-z_$][\w$]*)\(([^)]*)\)\{/g;
  let candidate = null;
  let match;
  while ((match = functionRegex.exec(source)) != null && match.index < markerIndex) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex >= markerIndex) {
      candidate = {
        match,
        start: match.index,
        end: closeIndex + 1,
        text: source.slice(match.index, closeIndex + 1),
      };
    }
  }
  return candidate;
}

function applyLinuxComputerUseAvatarCursorBridgePatch(currentSource) {
  if (currentSource.includes(LINUX_COMPUTER_USE_CURSOR_BRIDGE_MARKER)) {
    return currentSource;
  }

  const registration = findComputerUseCursorRegistrationFunction(currentSource);
  const handlerVar = registration?.match[2].match(/^\s*([A-Za-z_$][\w$]*)\s*,/)?.[1] ?? null;
  const platformVar = registration?.match[2].match(
    /platform:([A-Za-z_$][\w$]*)=process\.platform/,
  )?.[1] ?? null;
  if (registration == null || handlerVar == null || platformVar == null) {
    const reason = currentSource.includes(COMPUTER_USE_CURSOR_HANDLER_MARKER)
      ? "Could not identify the Computer Use cursor registration function"
      : "Could not find the Computer Use cursor handler marker";
    console.warn(`WARN: ${reason} - skipping Linux avatar cursor bridge patch`);
    return currentSource;
  }

  const darwinGuard = `if(${platformVar}!==\`darwin\`)return!1;`;
  if (!registration.text.includes(darwinGuard)) {
    console.warn(
      "WARN: Computer Use cursor registration no longer has the expected Darwin guard - skipping Linux avatar cursor bridge patch",
    );
    return currentSource;
  }

  const patchedRegistration = registration.text.replace(
    darwinGuard,
    `if(${platformVar}===\`linux\`)return codexLinuxRegisterComputerUseCursorHandler(${handlerVar});${darwinGuard}`,
  );
  return currentSource.slice(0, registration.start) +
    linuxComputerUseCursorBridgeRuntimeSource() +
    patchedRegistration +
    currentSource.slice(registration.end);
}

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
  return `{installWhenMissing:!0,name:${nameExpr},${availabilityProp}:({features:${featuresVar},platform:${platformVar}})=>${platformVar}===\`linux\`||${platformVar}===\`darwin\`&&${featuresVar}.computerUse,migrate:${migrateVar}}`;
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
  return `{${sanitizedPrefix}${installField}name:${nameExpr},${sanitizedMiddleFields}${availabilityProp}:({features:${featuresVar},platform:${platformVar}})=>${platformVar}===\`linux\`||${platformVar}===\`darwin\`&&${featuresVar}.computerUse${sanitizedExpressionSuffix}}`;
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
      const linuxRegisteredExpression = `${platformVar}===\`linux\`||${platformVar}===\`darwin\`&&${featuresVar}.computerUse`;
      if (installWhenMissing != null && expression === linuxRegisteredExpression && !hasInstallWhenMissingRequiresOptIn(gateSource)) {
        sawEnabledGate = true;
        return gateSource;
      }
      if (expression === darwinOnlyExpression || expression === linuxExpression || expression === linuxRegisteredExpression) {
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
      const linuxRegisteredExpression = `${platformVar}===\`linux\`||${platformVar}===\`darwin\`&&${featuresVar}.computerUse`;
      if (
        prefix.includes("installWhenMissing:!0,") &&
        expression === linuxRegisteredExpression &&
        !hasInstallWhenMissingRequiresOptIn(gateSource)
      ) {
        sawEnabledGate = true;
        return gateSource;
      }
      if (expression.includes("win32") || expression.includes("isInternal")) {
        return gateSource;
      }
      if (expression === darwinOnlyExpression || expression === linuxExpression || expression === linuxRegisteredExpression) {
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

function applyCurrentComputerUseSettingsContract(currentSource) {
  if (
    !currentSource.includes("computerUseAvailability:") ||
    !currentSource.includes("availablePlugins")
  ) {
    return null;
  }

  const availabilityMarkerPattern =
    /([A-Za-z_$][\w$]*)===`linux`&&\(([A-Za-z_$][\w$]*)=\{\.\.\.\2,available:!0,isFetching:!1,isLoading:!1\}\);/;
  const cardMarker = "marketplaceName:`openai-bundled`";
  const hasAvailabilityMarker = availabilityMarkerPattern.test(currentSource);
  const hasCardMarker = currentSource.includes(cardMarker);

  if (hasAvailabilityMarker && hasCardMarker) {
    return currentSource;
  }
  if (hasAvailabilityMarker !== hasCardMarker) {
    console.warn(
      "WARN: Could not find the complete current Computer Use settings contract — skipping Linux Computer Use UI availability patch",
    );
    return currentSource;
  }

  let availabilityChanged = false;
  const availabilityPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([^)]*)\),\{platform:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=/g;
  let patchedSource = currentSource.replace(
    availabilityPattern,
    (match, availabilityVar, hookVar, hookArg, platformVar, platformHookVar, nextVar, offset) => {
      const nextSource = currentSource.slice(offset + match.length, offset + match.length + 3000);
      if (
        !nextSource.includes(`computerUseAvailability:${availabilityVar}`) ||
        !nextSource.includes(`${availabilityVar}.available`)
      ) {
        return match;
      }
      availabilityChanged = true;
      return `let ${availabilityVar}=${hookVar}(${hookArg}),{platform:${platformVar}}=${platformHookVar}();${platformVar}===\`linux\`&&(${availabilityVar}={...${availabilityVar},available:!0,isFetching:!1,isLoading:!1});let ${nextVar}=`;
    },
  );

  let cardChanged = false;
  const cardPattern =
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\3\),((?:[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\),)+)([A-Za-z_$][\w$]*);/g;
  patchedSource = patchedSource.replace(
    cardPattern,
    (
      match,
      pluginsQueryVar,
      pluginsHookVar,
      selectedHostVar,
      emptyPluginsVar,
      marketplacePathVar,
      marketplacePathHookVar,
      intermediateDeclarations,
      computerUsePluginVar,
      offset,
    ) => {
      const lookback = patchedSource.slice(Math.max(0, offset - 900), offset);
      const nextSource = patchedSource.slice(offset + match.length, offset + match.length + 800);
      const platformVar = lookback.match(
        /\{computerUseAvailability:[A-Za-z_$][\w$]*,platform:([A-Za-z_$][\w$]*)\}=/,
      )?.[1];
      const pluginNameVar = nextSource.match(
        new RegExp(
          String.raw`${computerUsePluginVar}=[A-Za-z_$][\w$]*\(${pluginsQueryVar}\.availablePlugins,([A-Za-z_$][\w$]*),${marketplacePathVar}\)`,
        ),
      )?.[1];
      if (platformVar == null || pluginNameVar == null) {
        return match;
      }
      cardChanged = true;
      return `let ${pluginsQueryVar}=${pluginsHookVar}(${selectedHostVar},${emptyPluginsVar}),${marketplacePathVar}=${marketplacePathHookVar}(${selectedHostVar}),${intermediateDeclarations.slice(0, -1)};${platformVar}===\`linux\`&&!${pluginsQueryVar}.availablePlugins.some(e=>e.plugin?.name===${pluginNameVar}||e.plugin?.id?.split(\`@\`)[0]===${pluginNameVar})&&(${pluginsQueryVar}={...${pluginsQueryVar},availablePlugins:[...${pluginsQueryVar}.availablePlugins,{marketplaceName:\`openai-bundled\`,marketplacePath:${marketplacePathVar},logoPath:new URL(\`computer-use-plugin-icon-linux.png\`,import.meta.url).href,logoDarkPath:new URL(\`computer-use-plugin-icon-linux.png\`,import.meta.url).href,plugin:{id:${pluginNameVar},name:${pluginNameVar},installed:!0,enabled:!0}}]});let ${computerUsePluginVar};`;
    },
  );

  if (
    availabilityChanged &&
    cardChanged &&
    availabilityMarkerPattern.test(patchedSource) &&
    patchedSource.includes(cardMarker)
  ) {
    return patchedSource;
  }

  console.warn(
    "WARN: Could not find the complete current Computer Use settings contract — skipping Linux Computer Use UI availability patch",
  );
  return currentSource;
}

function applyLinuxComputerUseRendererAvailabilityPatch(currentSource) {
  const currentSettingsSource = applyCurrentComputerUseSettingsContract(currentSource);
  if (currentSettingsSource != null) {
    return currentSettingsSource;
  }

  console.warn(
    "WARN: Could not find the current Computer Use settings contract — skipping Linux Computer Use UI availability patch",
  );
  return currentSource;
}

function applyLinuxComputerUseHostPlatformPatch(currentSource) {
  const currentRequiredFeaturesObjectPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\{areRequiredFeaturesEnabled:([A-Za-z_$][\w$]*),enabled:([A-Za-z_$][\w$]*),isAnyFeatureLoading:([A-Za-z_$][\w$]*),isComputerUseGateEnabled:([A-Za-z_$][\w$]*),isHostCompatiblePlatform:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),isPlatformLoading:([A-Za-z_$][\w$]*),windowType:`electron`\}\)/g;

  let changed = false;
  const patchedSource = currentSource.replace(
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
      const context = currentSource.slice(Math.max(0, offset - 1200), offset + match.length);
      if (!context.includes("featureName:`computer_use`")) {
        return match;
      }
      changed = true;
      return `${resultVar}=${helperVar}({areRequiredFeaturesEnabled:${requiredFeaturesVar},enabled:${enabledVar},isAnyFeatureLoading:${featureLoadingVar},isComputerUseGateEnabled:${rolloutVar},isHostCompatiblePlatform:${platformVar}===\`linux\`||${platformPredicateVar}(${platformVar}),isPlatformLoading:${platformLoadingVar},windowType:\`electron\`})`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (
    /featureName:`computer_use`[\s\S]{0,2200}?areRequiredFeaturesEnabled:[A-Za-z_$][\w$]*,enabled:[A-Za-z_$][\w$]*,isAnyFeatureLoading:[A-Za-z_$][\w$]*,isComputerUseGateEnabled:[A-Za-z_$][\w$]*,isHostCompatiblePlatform:([A-Za-z_$][\w$]*)===`linux`\|\|[A-Za-z_$][\w$]*\(\1\),isPlatformLoading:/.test(currentSource)
  ) {
    return currentSource;
  }

  console.warn(
    "WARN: Could not find current Computer Use host-platform gate — skipping Linux Computer Use host-platform patch",
  );
  return currentSource;
}

function applyLinuxComputerUseInstallFlowPatch(currentSource) {
  if (currentSource.includes("plugin detail query requires pluginName")) {
    const markerPattern =
      /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)!==`computer-use`,([A-Za-z_$][\w$]*);/;
    if (markerPattern.test(currentSource)) {
      return currentSource;
    }

    const needlePattern =
      /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*);/g;
    let changed = false;
    const patchedSource = currentSource.replace(
      needlePattern,
      (match, gateVar, gateValueVar, nextVar, offset) => {
        const lookback = currentSource.slice(Math.max(0, offset - 900), offset);
        const nextSource = currentSource.slice(offset + match.length, offset + match.length + 1800);
        const pluginNameVar = lookback.match(/pluginName:([A-Za-z_$][\w$]*)/)?.[1];
        if (
          pluginNameVar == null ||
          !new RegExp(
            String.raw`&&\(!${gateVar}\|\|[A-Za-z_$][\w$]*\.available\)`,
          ).test(nextSource) ||
          !nextSource.includes("`read-plugin`")
        ) {
          return match;
        }
        changed = true;
        return `let ${gateVar}=${gateValueVar}&&${pluginNameVar}!==\`computer-use\`,${nextVar};`;
      },
    );

    if (changed && markerPattern.test(patchedSource)) {
      return patchedSource;
    }
  }

  console.warn(
    "WARN: Could not find current Computer Use plugin detail availability gate — skipping Linux Computer Use install flow patch",
  );
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
  applyLinuxComputerUseAvatarCursorBridgePatch,
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUseHostPlatformPatch,
  applyLinuxComputerUseInstallFlowPatch,
  applyLinuxNativeDesktopAppsHandlerPatch,
  applyLinuxComputerUsePluginGatePatch,
  applyLinuxComputerUseRendererAvailabilityPatch,
  isComputerUseUiEnabled,
  linuxComputerUseCursorBridgeRuntimeSource,
};
