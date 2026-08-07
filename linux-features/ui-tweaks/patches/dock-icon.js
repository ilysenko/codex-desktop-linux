"use strict";

const currentPreviewGate = "if(process.platform!==`darwin`||t==null)return null";
const patchedPreviewGate =
  "if(process.platform!==`darwin`&&process.platform!==`linux`||t==null)return null";
const currentAppInfoResource =
  "function MS(e){if(e==null)return null;let t=l.app.isPackaged?(0,p.join)(process.resourcesPath,e):null";
const patchedAppInfoResource =
  "function codexLinuxDockIconResourcePath(e){return process.platform===`linux`?(0,p.join)(process.resourcesPath,`dock-icon`,e):(0,p.join)(process.resourcesPath,e)}function MS(e){if(e==null)return null;let t=l.app.isPackaged||process.platform===`linux`?codexLinuxDockIconResourcePath(e):null";
const currentWindowResource =
  "E=e=>{if(!l.app.isPackaged)return null;let t=(0,p.join)(process.resourcesPath,e);return(0,_.existsSync)(t)?t:null}";
const patchedWindowResource =
  "E=e=>{if(!l.app.isPackaged&&process.platform!==`linux`)return null;let t=codexLinuxDockIconResourcePath(e);return(0,_.existsSync)(t)?t:null}";
const currentApplyIcon =
  "P=t=>{if(t===`app-default`&&i!==a.a.Dev&&(l.app.isPackaged||e===n.gc.ChatGPT)){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let r=t===`codex-system`?N():null,o=(r==null?null:O(r))??A(),s=o==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(o);s.isEmpty()||l.app.dock?.setIcon(s)}";
const patchedApplyIcon =
  "P=function codexLinuxApplyDockIcon(t){if(t===`app-default`&&process.platform!==`linux`&&i!==a.a.Dev&&(l.app.isPackaged||e===n.gc.ChatGPT)){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let r=t===`codex-system`?N():null,o=(r==null?null:O(r))??A(),s=o==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(o);if(s.isEmpty())return;if(process.platform===`linux`){let codexLinuxIconSelection=t===`codex-system`?(l.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?`codex-dark`:`codex-light`):`chatgpt`;codexLinuxIconSelection===`codex-dark`?s=s.crop({x:34,y:34,width:956,height:956}):codexLinuxIconSelection===`codex-light`&&(s=s.crop({x:13,y:23,width:998,height:998}));globalThis.codexLinuxDockIconImage=s;for(let e of l.BrowserWindow.getAllWindows())e.isDestroyed()||e.setIcon(s);codexLinuxTray!=null&&!codexLinuxTray.isDestroyed()&&codexLinuxTray.setImage(s);let codexLinuxSyncScript=codexLinuxDockIconResourcePath(`sync-desktop-icon.sh`);if(_.existsSync(codexLinuxSyncScript))try{let e=require(`node:child_process`).spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:[`pipe`,`ignore`,`ignore`]});e.on(`error`,()=>{}),e.stdin.on(`error`,()=>{}),e.stdin.end(s.toPNG()),e.unref()}catch(e){}return}l.app.dock?.setIcon(s)}";
const currentUpdateGate =
  "F=()=>{if(!v)return;let e=k();P(e),Yce({preference:e,resourceName:e===`codex-system`?M.light:null}).then(e=>{e&&P(k())})}";
const patchedUpdateGate =
  "F=()=>{if(!v&&process.platform!==`linux`)return;let e=k();P(e),Yce({preference:e,resourceName:e===`codex-system`?M.light:null}).then(e=>{e&&P(k())})}";
const currentThemeGate =
  "if(v){F();let e=()=>{let e=k();e===`codex-system`&&P(e)};l.nativeTheme.on(`updated`,e),w.add(()=>{l.nativeTheme.off(`updated`,e)})}";
const patchedThemeGate =
  "if(v||process.platform===`linux`){F();let e=()=>{let e=k();e===`codex-system`&&P(e)};l.nativeTheme.on(`updated`,e),w.add(()=>{l.nativeTheme.off(`updated`,e)})}";
const currentWindowRegistration =
  "onWindowRegistered:e=>{I?.registerWindow(e),C?.(e)}";
const patchedWindowRegistration =
  "onWindowRegistered:e=>{I?.registerWindow(e),C?.(e),process.platform===`linux`&&setImmediate(F)}";
const currentTrayRegistration =
  "n=codexLinuxRegisterTray(new l.Tray(...(process.platform===`linux`?[t.defaultIcon]:[t.defaultIcon,process.platform===`win32`&&l.app.isPackaged?dEe(e.buildFlavor):void 0])));if(!W9)return";
const patchedTrayRegistration =
  "n=codexLinuxRegisterTray(new l.Tray(...(process.platform===`linux`?[globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:t.defaultIcon]:[t.defaultIcon,process.platform===`win32`&&l.app.isPackaged?dEe(e.buildFlavor):void 0])));if(!W9)return";

const currentMainContracts = [
  currentPreviewGate,
  currentAppInfoResource,
  currentWindowResource,
  currentApplyIcon,
  currentUpdateGate,
  currentThemeGate,
  currentWindowRegistration,
  currentTrayRegistration,
];

const patchedMainContracts = [
  patchedPreviewGate,
  patchedAppInfoResource,
  patchedWindowResource,
  patchedApplyIcon,
  patchedUpdateGate,
  patchedThemeGate,
  patchedWindowRegistration,
  patchedTrayRegistration,
];

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function hasCompleteSinglePointContract(source, currentNeedle, patchedNeedle) {
  if (typeof source !== "string") {
    return false;
  }
  const currentCount = countOccurrences(source, currentNeedle);
  const patchedCount = countOccurrences(source, patchedNeedle);
  return (currentCount === 1 && patchedCount === 0) || (currentCount === 0 && patchedCount === 1);
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
  const currentCounts = currentMainContracts.map((needle) => countOccurrences(source, needle));
  const patchedCounts = patchedMainContracts.map((needle) => countOccurrences(source, needle));

  if (currentCounts.every((count) => count === 0) && patchedCounts.every((count) => count === 1)) {
    return source;
  }

  if (!currentCounts.every((count) => count === 1) || !patchedCounts.every((count) => count === 0)) {
    console.warn(
      "WARN: Could not find the complete current Dock icon main-process contract - skipping Dock icon main patch",
    );
    return source;
  }

  return currentMainContracts.reduce(
    (patchedSource, needle, index) => patchedSource.replace(needle, patchedMainContracts[index]),
    source,
  );
}

const currentSettingsGatePattern =
  /if\(([A-Za-z_$][\w$]*)!==`macOS`\|\|([A-Za-z_$][\w$]*)\.ChatGPT!==`chatgpt`\|\|([A-Za-z_$][\w$]*)\.Agent===`prod`\)return null/g;
const patchedSettingsGatePattern =
  /if\(([A-Za-z_$][\w$]*)!==`macOS`&&\1!==`linux`\|\|([A-Za-z_$][\w$]*)\.ChatGPT!==`chatgpt`\|\|([A-Za-z_$][\w$]*)\.Agent===`prod`\)return null/g;
const settingsRowAnchorPattern = /\.dockIconPreviews\b/g;

function settingsGateMatches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function dockIconSettingsContract(source) {
  if (typeof source !== "string") {
    return "drifted";
  }
  const currentMatches = settingsGateMatches(source, currentSettingsGatePattern);
  const patchedMatches = settingsGateMatches(source, patchedSettingsGatePattern);
  const rowAnchors = settingsGateMatches(source, settingsRowAnchorPattern);
  if (
    rowAnchors.length === 1 &&
    currentMatches.length === 1 &&
    patchedMatches.length === 0
  ) {
    return "current";
  }
  if (
    rowAnchors.length === 1 &&
    currentMatches.length === 0 &&
    patchedMatches.length === 1
  ) {
    return "patched";
  }
  return "drifted";
}

function applyDockIconSettingsPatch(source) {
  const contract = dockIconSettingsContract(source);
  if (contract === "patched") {
    return source;
  }
  if (contract !== "current") {
    console.warn(
      "WARN: Could not find the current Dock icon settings contract - skipping Dock icon settings patch",
    );
    return source;
  }
  return source.replace(
    currentSettingsGatePattern,
    (
      _match,
      platformAlias,
      brandAlias,
      buildFlavorAlias,
    ) => `if(${platformAlias}!==\`macOS\`&&${platformAlias}!==\`linux\`||${brandAlias}.ChatGPT!==\`chatgpt\`||${buildFlavorAlias}.Agent===\`prod\`)return null`,
  );
}

const currentSearchFilter =
  "codexLinuxDarwinOnlySettingsSearchMessageIds=new Set([`settings.general.appearance.dockIcon.chatGPT.ariaLabel`,`settings.general.appearance.dockIcon.codex.ariaLabel`,`settings.general.appearance.dockIcon.label`,`settings.general.appearance.dockIcon.row.description`])";
const patchedSearchFilter =
  "codexLinuxDarwinOnlySettingsSearchMessageIds=new Set([])";

function applyDockIconSearchPatch(source) {
  const currentCount = countOccurrences(source, currentSearchFilter);
  const patchedCount = countOccurrences(source, patchedSearchFilter);
  if (currentCount === 0 && patchedCount === 1) {
    return source;
  }
  if (currentCount !== 1 || patchedCount !== 0) {
    console.warn(
      "WARN: Could not find the current Dock icon settings search contract - skipping Dock icon search patch",
    );
    return source;
  }
  return source.replace(currentSearchFilter, patchedSearchFilter);
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
    pattern: /^general-settings-[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) => dockIconSettingsContract(source) !== "drifted",
    missingDescription: "General settings Dock icon bundle",
    skipDescription: "Dock icon settings row patch",
    enabled: dockIconEnabled,
    apply: applyDockIconSettingsPatch,
  },
  {
    id: "appearance-dock-icon-settings-search",
    phase: "webview-asset",
    order: 20_960,
    ciPolicy: "optional",
    pattern: /^settings-page-[A-Za-z0-9_-]+\.js$/,
    assetMatch: (source) =>
      hasCompleteSinglePointContract(source, currentSearchFilter, patchedSearchFilter),
    missingDescription: "Settings search bundle",
    skipDescription: "Dock icon settings search patch",
    enabled: dockIconEnabled,
    apply: applyDockIconSearchPatch,
  },
];

module.exports = {
  applyDockIconMainPatch,
  applyDockIconSearchPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconConfig,
  dockIconEnabled,
};
