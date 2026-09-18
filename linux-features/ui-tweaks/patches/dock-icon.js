"use strict";

const identifier = "[A-Za-z_$][\\w$]*";
const dockIconResourceHelper = "codexLinuxDockIconResourcePath";
const dockIconApplyHelper = "codexLinuxApplyDockIcon";

function matches(source, pattern) {
  if (typeof source !== "string") return [];
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function oneMatch(source, pattern) {
  const found = matches(source, pattern);
  return found.length === 1 ? found[0] : null;
}

function sameAliases(...aliases) {
  return aliases.every((alias) => alias === aliases[0]);
}

function mainPatterns(state) {
  const linux = state === "patched" ? "&&process\\.platform!==`linux`" : "";
  const packaged = state === "patched"
    ? "(?<electron>[A-Za-z_$][\\w$]*)\\.app\\.isPackaged\\|\\|process\\.platform===`linux`\\?\\k<helper>\\(\\k<arg>\\):null"
    : "(?<electron>[A-Za-z_$][\\w$]*)\\.app\\.isPackaged\\?\\(0,(?<path>[A-Za-z_$][\\w$]*)\\.join\\)\\(process\\.resourcesPath,\\k<arg>\\):null";
  const windowPackaged = state === "patched"
    ? "!(?<electron>[A-Za-z_$][\\w$]*)\\.app\\.isPackaged&&process\\.platform!==`linux`"
    : "!(?<electron>[A-Za-z_$][\\w$]*)\\.app\\.isPackaged";
  const applyPrefix = state === "patched"
    ? `(?<apply>${identifier})=function ${dockIconApplyHelper}\\((?<arg>${identifier})\\)\\{if\\((?<devIcons>${identifier})&&process\\.platform!==\`linux\`\\)\\{(?=[\\s\\S]{0,512}\\.app\\.dock)(?=[\\s\\S]{0,512}if\\(\\k<arg>===\`app-default\`)`
    : `(?<apply>${identifier})=(?<arg>${identifier})=>\\{if\\((?<devIcons>${identifier})\\)\\{(?=[\\s\\S]{0,512}\\.app\\.dock)(?=[\\s\\S]{0,512}if\\(\\k<arg>===\`app-default\`)`;
  const applyDefaultGate = state === "patched"
    ? `if\\((?<arg>${identifier})===\`app-default\`&&process\\.platform!==\`linux\`&&(?<build>${identifier})!==(?:${identifier})\\.(?:${identifier})\\.Dev\\)`
    : `if\\((?<arg>${identifier})===\`app-default\`&&(?<build>${identifier})!==(?:${identifier})\\.(?:${identifier})\\.Dev\\)`;
  const applyTail = state === "patched"
    ? `if\\((?<image>${identifier})\\.isEmpty\\(\\)\\)return;if\\(process\\.platform!==\`linux\`&&(?<arg>${identifier})===\`codex-system\`\\)\\{let\\{width:(?<width>${identifier}),height:(?<height>${identifier})\\}=\\k<image>\\.getSize\\(\\),(?<inset>${identifier})=Math\\.round\\(\\k<width>/128\\);\\k<image>=\\k<image>\\.crop\\(\\{x:\\k<inset>,y:\\k<inset>,width:\\k<width>-\\k<inset>\\*2,height:\\k<height>-\\k<inset>\\*2\\}\\)\\}if\\(process\\.platform===\`linux\`\\)\\{let codexLinuxIconSelection=\\k<arg>===\`codex-system\`\\?\\((?<electron>${identifier})\\.nativeTheme\\.shouldUseDarkColorsForSystemIntegratedUI\\?\`codex-dark\`:\`codex-light\`\\):\`chatgpt\`;globalThis\\.codexLinuxDockIconImage=\\k<image>;for\\(let (?<window>${identifier}) of \\k<electron>\\.BrowserWindow\\.getAllWindows\\(\\)\\)\\k<window>\\.isDestroyed\\(\\)\\|\\|\\k<window>\\.setIcon\\(\\k<image>\\);(?<trayState>${identifier})!=null&&!\\k<trayState>\\.tray\\.isDestroyed\\(\\)&&\\k<trayState>\\.tray\\.setImage\\(\\k<image>\\);let codexLinuxSyncScript=${dockIconResourceHelper}\\(\`sync-desktop-icon\\.sh\`\\);if\\((?<exists>${identifier})\\.existsSync\\(codexLinuxSyncScript\\)\\)try\\{let (?<child>${identifier})=require\\(\`node:child_process\`\\)\\.spawn\\(codexLinuxSyncScript,\\[codexLinuxIconSelection\\],\\{detached:!0,stdio:\\[\`pipe\`,\`ignore\`,\`ignore\`\\]\\}\\);\\k<child>\\.on\\(\`error\`,\\(\\)=>\\{\\}\\),\\k<child>\\.stdin\\.on\\(\`error\`,\\(\\)=>\\{\\}\\),\\k<child>\\.stdin\\.end\\(\\k<image>\\.toPNG\\(\\)\\),\\k<child>\\.unref\\(\\)\\}catch\\((?:${identifier})\\)\\{\\}return\\}\\k<electron>\\.app\\.dock\\?\\.setIcon\\(\\k<image>\\)\\}`
    : `if\\(!(?<image>${identifier})\\.isEmpty\\(\\)\\)\\{if\\((?<arg>${identifier})===\`codex-system\`\\)\\{let\\{width:(?<width>${identifier}),height:(?<height>${identifier})\\}=\\k<image>\\.getSize\\(\\),(?<inset>${identifier})=Math\\.round\\(\\k<width>/128\\);\\k<image>=\\k<image>\\.crop\\(\\{x:\\k<inset>,y:\\k<inset>,width:\\k<width>-\\k<inset>\\*2,height:\\k<height>-\\k<inset>\\*2\\}\\)\\}(?<electron>${identifier})\\.app\\.dock\\?\\.setIcon\\(\\k<image>\\)\\}\\}`;

  return {
    preview: new RegExp(
      `function (?<owner>${identifier})\\((?<arg>${identifier})\\)\\{if\\(process\\.platform!==\`darwin\`${linux}\\)return null;let (?<theme>${identifier})=(?<themeHelper>${identifier})\\(\\k<arg>\\),(?<defaultIcon>${identifier})=(?<resource>${identifier})\\(`,
      "g",
    ),
    appInfo: state === "patched"
      ? new RegExp(
        `function (?<helper>${dockIconResourceHelper})\\((?<helperArg>${identifier})\\)\\{return process\\.platform===\`linux\`\\?\\(0,(?<path>${identifier})\\.join\\)\\(process\\.resourcesPath,\`dock-icon\`,\\k<helperArg>\\):\\(0,\\k<path>\\.join\\)\\(process\\.resourcesPath,\\k<helperArg>\\)\\}function (?<owner>${identifier})\\((?<arg>${identifier})\\)\\{if\\(\\k<arg>==null\\)return null;let (?<candidate>${identifier})=${packaged};return (?<normalize>${identifier})\\(\\k<candidate>!=null&&\\(0,(?<exists>${identifier})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:\\(0,\\k<path>\\.join\\)\\(\\k<electron>\\.app\\.getAppPath\\(\\),\`src\`,\`icons\`,\\k<arg>\\)\\)\\}`,
        "g",
      )
      : new RegExp(
        `function (?<owner>${identifier})\\((?<arg>${identifier})\\)\\{if\\(\\k<arg>==null\\)return null;let (?<candidate>${identifier})=${packaged};return (?<normalize>${identifier})\\(\\k<candidate>!=null&&\\(0,(?<exists>${identifier})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:\\(0,\\k<path>\\.join\\)\\(\\k<electron>\\.app\\.getAppPath\\(\\),\`src\`,\`icons\`,\\k<arg>\\)\\)\\}`,
        "g",
      ),
    windowResource: state === "patched"
      ? new RegExp(
        `(?<owner>${identifier})=(?<arg>${identifier})=>\\{if\\(${windowPackaged}\\)return null;let (?<candidate>${identifier})=${dockIconResourceHelper}\\(\\k<arg>\\);return\\(0,(?<exists>${identifier})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:null\\}`,
        "g",
      )
      : new RegExp(
        `(?<owner>${identifier})=(?<arg>${identifier})=>\\{if\\(${windowPackaged}\\)return null;let (?<candidate>${identifier})=\\(0,(?<path>${identifier})\\.join\\)\\(process\\.resourcesPath,\\k<arg>\\);return\\(0,(?<exists>${identifier})\\.existsSync\\)\\(\\k<candidate>\\)\\?\\k<candidate>:null\\}`,
        "g",
      ),
    applyPrefix: new RegExp(applyPrefix, "g"),
    applyDefaultGate: new RegExp(applyDefaultGate, "g"),
    applyTail: new RegExp(applyTail, "g"),
    update: state === "patched"
      ? new RegExp(
        `(?<update>${identifier})=\\(\\)=>\\{if\\(!(?<isMac>${identifier})&&process\\.platform!==\`linux\`\\)return;let (?<preference>${identifier})=(?<read>${identifier})\\(\\);(?<apply>${identifier})\\(\\k<preference>\\),(?<refresh>${identifier})\\(\\{preference:\\k<preference>,resourceName:\\k<preference>===\`codex-system\`\\?(?<theme>${identifier})\\.light:null\\}\\)\\.then\\((?<changed>${identifier})=>\\{\\k<changed>&&\\k<apply>\\(\\k<read>\\(\\)\\)\\}\\)\\}`,
        "g",
      )
      : new RegExp(
        `(?<update>${identifier})=\\(\\)=>\\{if\\(!(?<isMac>${identifier})\\)return;let (?<preference>${identifier})=(?<read>${identifier})\\(\\);(?<apply>${identifier})\\(\\k<preference>\\),(?<refresh>${identifier})\\(\\{preference:\\k<preference>,resourceName:\\k<preference>===\`codex-system\`\\?(?<theme>${identifier})\\.light:null\\}\\)\\.then\\((?<changed>${identifier})=>\\{\\k<changed>&&\\k<apply>\\(\\k<read>\\(\\)\\)\\}\\)\\}`,
        "g",
      ),
    theme: new RegExp(
      `if\\((?<isMac>${identifier})${state === "patched" ? "\\|\\|process\\.platform===`linux`" : ""}\\)\\{(?<update>${identifier})\\(\\);let (?<listener>${identifier})=\\(\\)=>\\{let (?<preference>${identifier})=(?<read>${identifier})\\(\\);\\k<preference>===\`codex-system\`&&(?<apply>${identifier})\\(\\k<preference>\\)\\};(?<electron>${identifier})\\.nativeTheme\\.on\\(\`updated\`,\\k<listener>\\),(?<disposables>${identifier})\\.add\\(\\(\\)=>\\{\\k<electron>\\.nativeTheme\\.off\\(\`updated\`,\\k<listener>\\)\\}\\)\\}`,
      "g",
    ),
    windowRegistration: new RegExp(
      `onWindowRegistered:(?<window>${identifier})=>\\{(?<registrar>${identifier})\\?\\.registerWindow\\(\\k<window>\\),(?<callback>${identifier})\\?\\.\\(\\k<window>\\)${state === "patched" ? `,process\\.platform===\`linux\`&&setImmediate\\((?<update>${identifier})\\)` : ""}\\}`,
      "g",
    ),
    tray: state === "patched"
      ? new RegExp(
        `(?<tray>${identifier})=new (?<electron>${identifier})\\.Tray\\(process\\.platform===\`linux\`&&globalThis\\.codexLinuxDockIconImage&&!globalThis\\.codexLinuxDockIconImage\\.isEmpty\\(\\)\\?globalThis\\.codexLinuxDockIconImage:(?<iconInfo>${identifier})\\.defaultIcon,process\\.platform===\`win32\`&&\\k<electron>\\.app\\.isPackaged\\?(?<windowsHelper>${identifier})\\((?<flavor>${identifier})\\):void 0\\);if\\(!(?<ready>${identifier})\\)return`,
        "g",
      )
      : new RegExp(
        `(?<tray>${identifier})=new (?<electron>${identifier})\\.Tray\\((?<iconInfo>${identifier})\\.defaultIcon,process\\.platform===\`win32\`&&\\k<electron>\\.app\\.isPackaged\\?(?<windowsHelper>${identifier})\\((?<flavor>${identifier})\\):void 0\\);if\\(!(?<ready>${identifier})\\)return`,
        "g",
      ),
    trayState: new RegExp(
      `let (?<controller>${identifier})=new (?:${identifier})\\((?<tray>${identifier})(?:,|\\))[^;]*;return (?<trayState>${identifier})=\\k<controller>,!await \\k<controller>\\.waitForReady\\(\\)\\|\\|\\k<trayState>!==\\k<controller>\\?`,
      "g",
    ),
  };
}

function mainContract(source, state) {
  const patterns = mainPatterns(state);
  const contract = Object.fromEntries(
    Object.entries(patterns).map(([name, pattern]) => [name, oneMatch(source, pattern)]),
  );
  if (Object.values(contract).some((match) => match == null)) return null;
  const groups = Object.fromEntries(
    Object.entries(contract).map(([name, match]) => [name, match.groups]),
  );
  const aliasesAgree =
    groups.preview.resource === groups.appInfo.owner &&
    sameAliases(groups.appInfo.electron, groups.windowResource.electron, groups.applyTail.electron, groups.theme.electron, groups.tray.electron) &&
    sameAliases(groups.appInfo.path, groups.windowResource.path ?? groups.appInfo.path) &&
    sameAliases(groups.appInfo.exists, groups.windowResource.exists, groups.applyTail.exists ?? groups.appInfo.exists) &&
    sameAliases(groups.applyPrefix.apply, groups.update.apply, groups.theme.apply) &&
    sameAliases(groups.applyPrefix.arg, groups.applyDefaultGate.arg, groups.applyTail.arg) &&
    sameAliases(groups.update.update, groups.theme.update, groups.windowRegistration.update ?? groups.update.update) &&
    sameAliases(groups.update.isMac, groups.theme.isMac) &&
    sameAliases(groups.update.read, groups.theme.read) &&
    sameAliases(groups.tray.tray, groups.trayState.tray) &&
    sameAliases(groups.applyTail.trayState ?? groups.trayState.trayState, groups.trayState.trayState);
  return aliasesAgree ? { contract, groups } : null;
}

function dockIconConfig(context) {
  const defaults = context?.feature?.manifest?.tweaks?.appearance?.dockIcon;
  const settings = context?.feature?.settings?.tweaks?.appearance?.dockIcon;
  return {
    ...(defaults != null && typeof defaults === "object" && !Array.isArray(defaults) ? defaults : {}),
    ...(settings != null && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
  };
}

function dockIconEnabled(context) {
  return dockIconConfig(context).enabled === true;
}

function applyDockIconMainPatch(source) {
  const current = mainContract(source, "current");
  const patched = mainContract(source, "patched");
  if (patched != null && current == null) return source;
  if (current == null || patched != null) {
    console.warn(
      "WARN: Could not find the complete current Dock icon main-process contract - skipping Dock icon main patch",
    );
    return source;
  }

  const { groups } = current;
  let patchedSource = source;
  patchedSource = patchedSource.replace(
    current.contract.preview[0],
    current.contract.preview[0].replace(
      "process.platform!==`darwin`",
      "process.platform!==`darwin`&&process.platform!==`linux`",
    ),
  );
  patchedSource = patchedSource.replace(
    current.contract.appInfo[0],
    `function ${dockIconResourceHelper}(${groups.appInfo.arg}){return process.platform===\`linux\`?(0,${groups.appInfo.path}.join)(process.resourcesPath,\`dock-icon\`,${groups.appInfo.arg}):(0,${groups.appInfo.path}.join)(process.resourcesPath,${groups.appInfo.arg})}function ${groups.appInfo.owner}(${groups.appInfo.arg}){if(${groups.appInfo.arg}==null)return null;let ${groups.appInfo.candidate}=${groups.appInfo.electron}.app.isPackaged||process.platform===\`linux\`?${dockIconResourceHelper}(${groups.appInfo.arg}):null;return ${groups.appInfo.normalize}(${groups.appInfo.candidate}!=null&&(0,${groups.appInfo.exists}.existsSync)(${groups.appInfo.candidate})?${groups.appInfo.candidate}:(0,${groups.appInfo.path}.join)(${groups.appInfo.electron}.app.getAppPath(),\`src\`,\`icons\`,${groups.appInfo.arg}))}`,
  );
  patchedSource = patchedSource.replace(
    current.contract.windowResource[0],
    `${groups.windowResource.owner}=${groups.windowResource.arg}=>{if(!${groups.windowResource.electron}.app.isPackaged&&process.platform!==\`linux\`)return null;let ${groups.windowResource.candidate}=${dockIconResourceHelper}(${groups.windowResource.arg});return(0,${groups.windowResource.exists}.existsSync)(${groups.windowResource.candidate})?${groups.windowResource.candidate}:null}`,
  );
  patchedSource = patchedSource.replace(
    current.contract.applyPrefix[0],
    `${groups.applyPrefix.apply}=function ${dockIconApplyHelper}(${groups.applyPrefix.arg}){if(${groups.applyPrefix.devIcons}&&process.platform!==\`linux\`){`,
  );
  patchedSource = patchedSource.replace(
    current.contract.applyDefaultGate[0],
    current.contract.applyDefaultGate[0].replace("&&", "&&process.platform!==`linux`&&"),
  );
  const tail = groups.applyTail;
  const trayState = groups.trayState.trayState;
  patchedSource = patchedSource.replace(
    current.contract.applyTail[0],
    `if(${tail.image}.isEmpty())return;if(process.platform!==\`linux\`&&${tail.arg}===\`codex-system\`){let{width:${tail.width},height:${tail.height}}=${tail.image}.getSize(),${tail.inset}=Math.round(${tail.width}/128);${tail.image}=${tail.image}.crop({x:${tail.inset},y:${tail.inset},width:${tail.width}-${tail.inset}*2,height:${tail.height}-${tail.inset}*2})}if(process.platform===\`linux\`){let codexLinuxIconSelection=${tail.arg}===\`codex-system\`?(${tail.electron}.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?\`codex-dark\`:\`codex-light\`):\`chatgpt\`;globalThis.codexLinuxDockIconImage=${tail.image};for(let ${tail.width} of ${tail.electron}.BrowserWindow.getAllWindows())${tail.width}.isDestroyed()||${tail.width}.setIcon(${tail.image});${trayState}!=null&&!${trayState}.tray.isDestroyed()&&${trayState}.tray.setImage(${tail.image});let codexLinuxSyncScript=${dockIconResourceHelper}(\`sync-desktop-icon.sh\`);if(${groups.appInfo.exists}.existsSync(codexLinuxSyncScript))try{let ${tail.height}=require(\`node:child_process\`).spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:[\`pipe\`,\`ignore\`,\`ignore\`]});${tail.height}.on(\`error\`,()=>{}),${tail.height}.stdin.on(\`error\`,()=>{}),${tail.height}.stdin.end(${tail.image}.toPNG()),${tail.height}.unref()}catch(${tail.arg}){}return}${tail.electron}.app.dock?.setIcon(${tail.image})}`,
  );
  patchedSource = patchedSource.replace(
    current.contract.update[0],
    current.contract.update[0].replace(`if(!${groups.update.isMac})`, `if(!${groups.update.isMac}&&process.platform!==\`linux\`)`),
  );
  patchedSource = patchedSource.replace(
    current.contract.theme[0],
    current.contract.theme[0].replace(`if(${groups.theme.isMac})`, `if(${groups.theme.isMac}||process.platform===\`linux\`)`),
  );
  patchedSource = patchedSource.replace(
    current.contract.windowRegistration[0],
    current.contract.windowRegistration[0].replace(
      `?.(${groups.windowRegistration.window})}`,
      `?.(${groups.windowRegistration.window}),process.platform===\`linux\`&&setImmediate(${groups.update.update})}`,
    ),
  );
  patchedSource = patchedSource.replace(
    current.contract.tray[0],
    current.contract.tray[0].replace(
      `${groups.tray.iconInfo}.defaultIcon`,
      `process.platform===\`linux\`&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:${groups.tray.iconInfo}.defaultIcon`,
    ),
  );
  return mainContract(patchedSource, "patched") != null ? patchedSource : source;
}

const currentSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const patchedSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`&&\1!==`linux`\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const settingsRowAnchorPattern = /\bdockIconPreviews\b/g;

function dockIconSettingsContract(source) {
  const currentMatches = matches(source, currentSettingsGatePattern);
  const patchedMatches = matches(source, patchedSettingsGatePattern);
  const rowAnchors = matches(source, settingsRowAnchorPattern);
  if (rowAnchors.length === 1 && currentMatches.length === 1 && patchedMatches.length === 0) return "current";
  if (rowAnchors.length === 1 && currentMatches.length === 0 && patchedMatches.length === 1) return "patched";
  return "drifted";
}

function applyDockIconSettingsPatch(source) {
  const contract = dockIconSettingsContract(source);
  if (contract === "patched") return source;
  if (contract !== "current") {
    console.warn("WARN: Could not find the current Dock icon settings contract - skipping Dock icon settings patch");
    return source;
  }
  return source.replace(
    currentSettingsGatePattern,
    (_match, platformAlias, buildFlavorAlias, buildFlavorEnumAlias, previewsAlias) =>
      `return ${platformAlias}!==\`macOS\`&&${platformAlias}!==\`linux\`||${buildFlavorAlias}===${buildFlavorEnumAlias}.Agent?null:${previewsAlias}`,
  );
}

const descriptors = [
  {
    id: "appearance-dock-icon-main-process",
    phase: "main-bundle",
    order: 20_940,
    ciPolicy: "optional",
    enabled: dockIconEnabled,
    apply: applyDockIconMainPatch,
  },
  {
    id: "appearance-dock-icon-settings-row",
    phase: "webview-asset",
    order: 20_950,
    ciPolicy: "optional",
    pattern: /^dock-icon-setting-visibility-[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => dockIconSettingsContract(source) !== "drifted",
    missingDescription: "official Linux Dock icon setting visibility bundle",
    skipDescription: "Dock icon settings row patch",
    enabled: dockIconEnabled,
    apply: applyDockIconSettingsPatch,
  },
];

module.exports = {
  applyDockIconMainPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconConfig,
  dockIconEnabled,
};
