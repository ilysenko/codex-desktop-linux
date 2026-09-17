"use strict";

const currentPreviewGate = "function Gme(e){if(process.platform!==`darwin`)return null";
const patchedPreviewGate =
  "function Gme(e){if(process.platform!==`darwin`&&process.platform!==`linux`)return null";
const currentAppInfoResource =
  "function g_(e){if(e==null)return null;let t=d.app.isPackaged?(0,g.join)(process.resourcesPath,e):null;return __(t!=null&&(0,y.existsSync)(t)?t:(0,g.join)(d.app.getAppPath(),`src`,`icons`,e))}";
const patchedAppInfoResource =
  "function codexLinuxDockIconResourcePath(e){return process.platform===`linux`?(0,g.join)(process.resourcesPath,`dock-icon`,e):(0,g.join)(process.resourcesPath,e)}function g_(e){if(e==null)return null;let t=d.app.isPackaged||process.platform===`linux`?codexLinuxDockIconResourcePath(e):null;return __(t!=null&&(0,y.existsSync)(t)?t:(0,g.join)(d.app.getAppPath(),`src`,`icons`,e))}";
const currentWindowResource =
  "O=e=>{if(!d.app.isPackaged)return null;let t=(0,g.join)(process.resourcesPath,e);return(0,y.existsSync)(t)?t:null}";
const patchedWindowResource =
  "O=e=>{if(!d.app.isPackaged&&process.platform!==`linux`)return null;let t=codexLinuxDockIconResourcePath(e);return(0,y.existsSync)(t)?t:null}";
const currentApplyIcon =
  "L=e=>{if(I){let t=`app-default`;e===`codex-system`&&(t=d.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?`codex-dark`:`codex-light`);let n=d.nativeImage.createFromPath((0,g.join)(I,`${t}.png`));if(!n.isEmpty()){d.app.dock?.setIcon(n);return}}if(e===`app-default`&&i!==o.i.Dev){let e=d.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let t=e===`codex-system`?ee():null,n=(t==null?null:A(t))??M(),r=n==null?d.nativeImage.createEmpty():d.nativeImage.createFromPath(n);if(!r.isEmpty()){if(e===`codex-system`){let{width:e,height:t}=r.getSize(),n=Math.round(e/128);r=r.crop({x:n,y:n,width:e-n*2,height:t-n*2})}d.app.dock?.setIcon(r)}}";
const patchedApplyIcon =
  "L=function codexLinuxApplyDockIcon(e){if(I&&process.platform!==`linux`){let t=`app-default`;e===`codex-system`&&(t=d.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?`codex-dark`:`codex-light`);let n=d.nativeImage.createFromPath((0,g.join)(I,`${t}.png`));if(!n.isEmpty()){d.app.dock?.setIcon(n);return}}if(e===`app-default`&&process.platform!==`linux`&&i!==o.i.Dev){let e=d.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let t=e===`codex-system`?ee():null,n=(t==null?null:A(t))??M(),r=n==null?d.nativeImage.createEmpty():d.nativeImage.createFromPath(n);if(r.isEmpty())return;if(process.platform!==`linux`&&e===`codex-system`){let{width:e,height:t}=r.getSize(),n=Math.round(e/128);r=r.crop({x:n,y:n,width:e-n*2,height:t-n*2})}if(process.platform===`linux`){let codexLinuxIconSelection=e===`codex-system`?(d.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?`codex-dark`:`codex-light`):`chatgpt`;globalThis.codexLinuxDockIconImage=r;for(let e of d.BrowserWindow.getAllWindows())e.isDestroyed()||e.setIcon(r);U9!=null&&!U9.tray.isDestroyed()&&U9.tray.setImage(r);let codexLinuxSyncScript=codexLinuxDockIconResourcePath(`sync-desktop-icon.sh`);if(y.existsSync(codexLinuxSyncScript))try{let e=require(`node:child_process`).spawn(codexLinuxSyncScript,[codexLinuxIconSelection],{detached:!0,stdio:[`pipe`,`ignore`,`ignore`]});e.on(`error`,()=>{}),e.stdin.on(`error`,()=>{}),e.stdin.end(r.toPNG()),e.unref()}catch(e){}return}d.app.dock?.setIcon(r)}";
const currentUpdateGate =
  "R=()=>{if(!_)return;let e=j();L(e),aF({preference:e,resourceName:e===`codex-system`?F.light:null}).then(e=>{e&&L(j())})}";
const patchedUpdateGate =
  "R=()=>{if(!_&&process.platform!==`linux`)return;let e=j();L(e),aF({preference:e,resourceName:e===`codex-system`?F.light:null}).then(e=>{e&&L(j())})}";
const currentThemeGate =
  "if(_){R();let e=()=>{let e=j();e===`codex-system`&&L(e)};d.nativeTheme.on(`updated`,e),T.add(()=>{d.nativeTheme.off(`updated`,e)})}";
const patchedThemeGate =
  "if(_||process.platform===`linux`){R();let e=()=>{let e=j();e===`codex-system`&&L(e)};d.nativeTheme.on(`updated`,e),T.add(()=>{d.nativeTheme.off(`updated`,e)})}";
const currentWindowRegistration =
  "onWindowRegistered:e=>{z?.registerWindow(e),w?.(e)}";
const patchedWindowRegistration =
  "onWindowRegistered:e=>{z?.registerWindow(e),w?.(e),process.platform===`linux`&&setImmediate(R)}";
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
