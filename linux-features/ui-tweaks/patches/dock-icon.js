"use strict";

const currentPreviewGate = "function wse(e){if(process.platform!==`darwin`)return null";
const patchedPreviewGate =
  "function wse(e){if(process.platform!==`darwin`&&process.platform!==`linux`)return null";
const currentAppInfoResource =
  "function DS(e){if(e==null)return null;let t=l.app.isPackaged?(0,p.join)(process.resourcesPath,e):null";
const patchedAppInfoResource =
  "function codexLinuxDockIconResourcePath(e){return process.platform===`linux`?(0,p.join)(process.resourcesPath,`dock-icon`,e):(0,p.join)(process.resourcesPath,e)}function DS(e){if(e==null)return null;let t=l.app.isPackaged||process.platform===`linux`?codexLinuxDockIconResourcePath(e):null";
const currentWindowResource =
  "E=e=>{if(!l.app.isPackaged)return null;let t=(0,p.join)(process.resourcesPath,e);return(0,_.existsSync)(t)?t:null}";
const patchedWindowResource =
  "E=e=>{if(!l.app.isPackaged&&process.platform!==`linux`)return null;let t=codexLinuxDockIconResourcePath(e);return(0,_.existsSync)(t)?t:null}";
const currentApplyIcon =
  "F=e=>{if(e===`app-default`&&t!==a.a.Dev){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let n=e===`codex-system`?P():null,r=(n==null?null:O(n))??A(),i=r==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(r);if(!i.isEmpty()){if(e===`codex-system`){let{width:e,height:t}=i.getSize(),n=Math.round(e/128);i=i.crop({x:n,y:n,width:e-n*2,height:t-n*2})}l.app.dock?.setIcon(i)}}";
const patchedApplyIcon =
  "F=function codexLinuxApplyDockIcon(e){if(e===`app-default`&&process.platform!==`linux`&&t!==a.a.Dev){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let n=e===`codex-system`?P():null,r=(n==null?null:O(n))??A(),i=r==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(r);if(i.isEmpty())return;if(process.platform!==`linux`&&e===`codex-system`){let{width:e,height:t}=i.getSize(),n=Math.round(e/128);i=i.crop({x:n,y:n,width:e-n*2,height:t-n*2})}if(process.platform===`linux`){let codexLinuxIconSelection=e===`codex-system`?(l.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?`codex-dark`:`codex-light`):`chatgpt`;globalThis.codexLinuxDockIconImage=i;for(let e of l.BrowserWindow.getAllWindows())e.isDestroyed()||e.setIcon(i);H9!=null&&!H9.tray.isDestroyed()&&H9.tray.setImage(i);let codexLinuxSyncScript=codexLinuxDockIconResourcePath(`sync-desktop-icon.sh`);if(_.existsSync(codexLinuxSyncScript))try{let e=require(`node:child_process`).spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:[`pipe`,`ignore`,`ignore`]});e.on(`error`,()=>{}),e.stdin.on(`error`,()=>{}),e.stdin.end(i.toPNG()),e.unref()}catch(e){}return}l.app.dock?.setIcon(i)}";
const currentUpdateGate =
  "I=()=>{if(!g)return;let e=k();F(e),Vde({preference:e,resourceName:e===`codex-system`?N.light:null}).then(e=>{e&&F(k())})}";
const patchedUpdateGate =
  "I=()=>{if(!g&&process.platform!==`linux`)return;let e=k();F(e),Vde({preference:e,resourceName:e===`codex-system`?N.light:null}).then(e=>{e&&F(k())})}";
const currentThemeGate =
  "if(g){I();let e=()=>{let e=k();e===`codex-system`&&F(e)};l.nativeTheme.on(`updated`,e),w.add(()=>{l.nativeTheme.off(`updated`,e)})}";
const patchedThemeGate =
  "if(g||process.platform===`linux`){I();let e=()=>{let e=k();e===`codex-system`&&F(e)};l.nativeTheme.on(`updated`,e),w.add(()=>{l.nativeTheme.off(`updated`,e)})}";
const currentWindowRegistration =
  "onWindowRegistered:e=>{ee?.registerWindow(e),C?.(e)}";
const patchedWindowRegistration =
  "onWindowRegistered:e=>{ee?.registerWindow(e),C?.(e),process.platform===`linux`&&setImmediate(I)}";
const currentTrayRegistrationPattern =
  /([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\.Tray\(([A-Za-z_$][\w$]*)\.defaultIcon,process\.platform===`win32`&&\2\.app\.isPackaged\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\):void 0\);if\(!([A-Za-z_$][\w$]*)\)return/g;
const patchedTrayRegistrationPattern =
  /([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\.Tray\(process\.platform===`linux`&&globalThis\.codexLinuxDockIconImage&&!globalThis\.codexLinuxDockIconImage\.isEmpty\(\)\?globalThis\.codexLinuxDockIconImage:([A-Za-z_$][\w$]*)\.defaultIcon,process\.platform===`win32`&&\2\.app\.isPackaged\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\):void 0\);if\(!([A-Za-z_$][\w$]*)\)return/g;

const currentMainContracts = [
  currentPreviewGate,
  currentAppInfoResource,
  currentWindowResource,
  currentApplyIcon,
  currentUpdateGate,
  currentThemeGate,
  currentWindowRegistration,
];
const patchedMainContracts = [
  patchedPreviewGate,
  patchedAppInfoResource,
  patchedWindowResource,
  patchedApplyIcon,
  patchedUpdateGate,
  patchedThemeGate,
  patchedWindowRegistration,
];

function countOccurrences(source, needle) {
  return typeof source === "string" ? source.split(needle).length - 1 : 0;
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
  const currentTrayMatches = matches(source, currentTrayRegistrationPattern);
  const patchedTrayMatches = matches(source, patchedTrayRegistrationPattern);
  if (
    currentCounts.every((count) => count === 0) &&
    patchedCounts.every((count) => count === 1) &&
    currentTrayMatches.length === 0 &&
    patchedTrayMatches.length === 1
  ) {
    return source;
  }
  if (
    !currentCounts.every((count) => count === 1) ||
    !patchedCounts.every((count) => count === 0) ||
    currentTrayMatches.length !== 1 ||
    patchedTrayMatches.length !== 0
  ) {
    console.warn(
      "WARN: Could not find the complete current Dock icon main-process contract - skipping Dock icon main patch",
    );
    return source;
  }
  const patchedSource = currentMainContracts.reduce(
    (patchedSource, needle, index) => patchedSource.replace(needle, patchedMainContracts[index]),
    source,
  );
  return patchedSource.replace(
    currentTrayRegistrationPattern,
    (_match, trayAlias, electronAlias, iconAlias, windowsHelperAlias, flavorAlias, readyAlias) =>
      `${trayAlias}=new ${electronAlias}.Tray(process.platform===\`linux\`&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:${iconAlias}.defaultIcon,process.platform===\`win32\`&&${electronAlias}.app.isPackaged?${windowsHelperAlias}(${flavorAlias}):void 0);if(!${readyAlias})return`,
  );
}

const currentSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const patchedSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`&&\1!==`linux`\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const settingsRowAnchorPattern = /\bdockIconPreviews\b/g;

function matches(source, pattern) {
  if (typeof source !== "string") return [];
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function dockIconSettingsContract(source) {
  const currentMatches = matches(source, currentSettingsGatePattern);
  const patchedMatches = matches(source, patchedSettingsGatePattern);
  const rowAnchors = matches(source, settingsRowAnchorPattern);
  if (rowAnchors.length === 1 && currentMatches.length === 1 && patchedMatches.length === 0) {
    return "current";
  }
  if (rowAnchors.length === 1 && currentMatches.length === 0 && patchedMatches.length === 1) {
    return "patched";
  }
  return "drifted";
}

function applyDockIconSettingsPatch(source) {
  const contract = dockIconSettingsContract(source);
  if (contract === "patched") return source;
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
      buildFlavorAlias,
      buildFlavorEnumAlias,
      previewsAlias,
    ) =>
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
