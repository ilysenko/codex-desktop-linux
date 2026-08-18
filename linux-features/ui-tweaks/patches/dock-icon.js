"use strict";

const currentPreviewGate = "if(process.platform!==`darwin`||t==null)return null";
const patchedPreviewGate =
  "if(process.platform!==`darwin`&&process.platform!==`linux`||t==null)return null";
const currentAppInfoResource =
  "function Xb(e){if(e==null)return null;let t=l.app.isPackaged?(0,p.join)(process.resourcesPath,e):null";
const patchedAppInfoResource =
  "function codexLinuxDockIconResourcePath(e){return process.platform===`linux`?(0,p.join)(process.resourcesPath,`dock-icon`,e):(0,p.join)(process.resourcesPath,e)}function Xb(e){if(e==null)return null;let t=l.app.isPackaged||process.platform===`linux`?codexLinuxDockIconResourcePath(e):null";
const currentWindowResource =
  "D=e=>{if(!l.app.isPackaged)return null;let t=(0,p.join)(process.resourcesPath,e);return(0,_.existsSync)(t)?t:null}";
const patchedWindowResource =
  "D=e=>{if(!l.app.isPackaged&&process.platform!==`linux`)return null;let t=codexLinuxDockIconResourcePath(e);return(0,_.existsSync)(t)?t:null}";
const currentApplyIcon =
  "F=t=>{if(t===`app-default`&&i!==a.a.Dev&&(l.app.isPackaged||e===n.Zc.ChatGPT)){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let r=t===`codex-system`?P():null,o=(r==null?null:k(r))??j(),s=o==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(o);if(!s.isEmpty()){if(t===`codex-system`){let{width:e,height:t}=s.getSize(),n=Math.round(e/128);s=s.crop({x:n,y:n,width:e-n*2,height:t-n*2})}l.app.dock?.setIcon(s)}}";
const patchedApplyIcon =
  "F=function codexLinuxApplyDockIcon(t){if(t===`app-default`&&process.platform!==`linux`&&i!==a.a.Dev&&(l.app.isPackaged||e===n.Zc.ChatGPT)){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let r=t===`codex-system`?P():null,o=(r==null?null:k(r))??j(),s=o==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(o);if(s.isEmpty())return;if(process.platform!==`linux`&&t===`codex-system`){let{width:e,height:t}=s.getSize(),n=Math.round(e/128);s=s.crop({x:n,y:n,width:e-n*2,height:t-n*2})}if(process.platform===`linux`){let codexLinuxIconSelection=t===`codex-system`?(l.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?`codex-dark`:`codex-light`):`chatgpt`;globalThis.codexLinuxDockIconImage=s;for(let e of l.BrowserWindow.getAllWindows())e.isDestroyed()||e.setIcon(s);V9!=null&&!V9.tray.isDestroyed()&&V9.tray.setImage(s);let codexLinuxSyncScript=codexLinuxDockIconResourcePath(`sync-desktop-icon.sh`);if(_.existsSync(codexLinuxSyncScript))try{let e=require(`node:child_process`).spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:[`pipe`,`ignore`,`ignore`]});e.on(`error`,()=>{}),e.stdin.on(`error`,()=>{}),e.stdin.end(s.toPNG()),e.unref()}catch(e){}return}l.app.dock?.setIcon(s)}";
const currentUpdateGate =
  "I=()=>{if(!v)return;let e=A();F(e),nde({preference:e,resourceName:e===`codex-system`?N.light:null}).then(e=>{e&&F(A())})}";
const patchedUpdateGate =
  "I=()=>{if(!v&&process.platform!==`linux`)return;let e=A();F(e),nde({preference:e,resourceName:e===`codex-system`?N.light:null}).then(e=>{e&&F(A())})}";
const currentThemeGate =
  "if(v){I();let e=()=>{let e=A();e===`codex-system`&&F(e)};l.nativeTheme.on(`updated`,e),T.add(()=>{l.nativeTheme.off(`updated`,e)})}";
const patchedThemeGate =
  "if(v||process.platform===`linux`){I();let e=()=>{let e=A();e===`codex-system`&&F(e)};l.nativeTheme.on(`updated`,e),T.add(()=>{l.nativeTheme.off(`updated`,e)})}";
const currentWindowRegistration =
  "onWindowRegistered:e=>{L?.registerWindow(e),w?.(e)}";
const patchedWindowRegistration =
  "onWindowRegistered:e=>{L?.registerWindow(e),w?.(e),process.platform===`linux`&&setImmediate(I)}";
const currentTrayRegistration =
  "i=new l.Tray(n.defaultIcon,process.platform===`win32`&&l.app.isPackaged?Uje(t):void 0);if(!W9)return";
const patchedTrayRegistration =
  "i=new l.Tray(process.platform===`linux`&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty()?globalThis.codexLinuxDockIconImage:n.defaultIcon,process.platform===`win32`&&l.app.isPackaged?Uje(t):void 0);if(!W9)return";

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
  /return ([A-Za-z_$][\w$]*)!==`macOS`\|\|([A-Za-z_$][\w$]*)!==([A-Za-z_$][\w$]*)\.ChatGPT\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
const patchedSettingsGatePattern =
  /return ([A-Za-z_$][\w$]*)!==`macOS`&&\1!==`linux`\|\|([A-Za-z_$][\w$]*)!==([A-Za-z_$][\w$]*)\.ChatGPT\|\|([A-Za-z_$][\w$]*)===([A-Za-z_$][\w$]*)\.Agent\?null:([A-Za-z_$][\w$]*)/g;
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
      appBrandAlias,
      appBrandEnumAlias,
      buildFlavorAlias,
      buildFlavorEnumAlias,
      previewsAlias,
    ) =>
      `return ${platformAlias}!==\`macOS\`&&${platformAlias}!==\`linux\`||${appBrandAlias}!==${appBrandEnumAlias}.ChatGPT||${buildFlavorAlias}===${buildFlavorEnumAlias}.Agent?null:${previewsAlias}`,
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
