"use strict";

const currentPreviewGate = "if(process.platform!==`darwin`||t==null)return null";
const patchedPreviewGate =
  "if(process.platform!==`darwin`&&process.platform!==`linux`||t==null)return null";
const currentAppInfoResource =
  "function E_(e){if(e==null)return null;let t=c.app.isPackaged?(0,u.join)(process.resourcesPath,e):null";
const patchedAppInfoResource =
  "function codexLinuxDockIconResourcePath(e){return process.platform===`linux`?(0,u.join)(process.resourcesPath,`dock-icon`,e):(0,u.join)(process.resourcesPath,e)}function E_(e){if(e==null)return null;let t=c.app.isPackaged||process.platform===`linux`?codexLinuxDockIconResourcePath(e):null";
const currentWindowResource =
  "w=e=>{if(!c.app.isPackaged)return null;let t=(0,u.join)(process.resourcesPath,e);return(0,p.existsSync)(t)?t:null}";
const patchedWindowResource =
  "w=e=>{if(!c.app.isPackaged&&process.platform!==`linux`)return null;let t=codexLinuxDockIconResourcePath(e);return(0,p.existsSync)(t)?t:null}";
const currentApplyIcon =
  "j=r=>{if(r===`app-default`&&t!==i.a.Dev&&(c.app.isPackaged||e===n.Vc.ChatGPT)){let e=c.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let a=r===`codex-system`?A():null,o=(a==null?null:E(a))??O(),s=o==null?c.nativeImage.createEmpty():c.nativeImage.createFromPath(o);s.isEmpty()||c.app.dock?.setIcon(s)}";
const patchedApplyIcon =
  "j=function codexLinuxApplyDockIcon(r){if(r===`app-default`&&process.platform!==`linux`&&t!==i.a.Dev&&(c.app.isPackaged||e===n.Vc.ChatGPT)){let e=c.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let a=r===`codex-system`?A():null,o=(a==null?null:E(a))??O(),s=o==null?c.nativeImage.createEmpty():c.nativeImage.createFromPath(o);if(s.isEmpty())return;if(process.platform===`linux`){globalThis.codexLinuxDockIconImage=s;for(let e of c.BrowserWindow.getAllWindows())e.isDestroyed()||e.setIcon(s);let e=are()?.tray;e!=null&&!e.isDestroyed()&&e.setImage(s);return}c.app.dock?.setIcon(s)}";
const currentUpdateGate =
  "M=()=>{if(!g)return;let e=D();j(e),AA({preference:e,resourceName:e===`codex-system`?k.light:null}).then(e=>{e&&j(D())})}";
const patchedUpdateGate =
  "M=()=>{if(!g&&process.platform!==`linux`)return;let e=D();j(e),AA({preference:e,resourceName:e===`codex-system`?k.light:null}).then(e=>{e&&j(D())})}";
const currentThemeGate =
  "if(g){M();let e=()=>{let e=D();e===`codex-system`&&j(e)};c.nativeTheme.on(`updated`,e),S.add(()=>{c.nativeTheme.off(`updated`,e)})}";
const patchedThemeGate =
  "if(g||process.platform===`linux`){M();let e=()=>{let e=D();e===`codex-system`&&j(e)};c.nativeTheme.on(`updated`,e),S.add(()=>{c.nativeTheme.off(`updated`,e)})}";
const currentWindowRegistration =
  "onWindowRegistered:e=>{N?.registerWindow(e),x?.(e)}";
const patchedWindowRegistration =
  "onWindowRegistered:e=>{N?.registerWindow(e),x?.(e),process.platform===`linux`&&setImmediate(M)}";
const currentTrayRegistration =
  "n=typeof codexLinuxRegisterTray===`function`?codexLinuxRegisterTray(new c.Tray(t.defaultIcon)):new c.Tray(t.defaultIcon);if(!W9)return";
const patchedTrayRegistration =
  "n=typeof codexLinuxRegisterTray===`function`?codexLinuxRegisterTray(new c.Tray(t.defaultIcon)):new c.Tray(t.defaultIcon);if(process.platform===`linux`&&globalThis.codexLinuxDockIconImage&&!globalThis.codexLinuxDockIconImage.isEmpty())n.setImage(globalThis.codexLinuxDockIconImage);if(!W9)return";

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

const currentSettingsGate =
  "if(r!==`macOS`||Fe.ChatGPT!==`chatgpt`||st.Agent===`prod`)return null";
const patchedSettingsGate =
  "if(r!==`macOS`&&r!==`linux`||Fe.ChatGPT!==`chatgpt`||st.Agent===`prod`)return null";

function applyDockIconSettingsPatch(source) {
  const currentCount = countOccurrences(source, currentSettingsGate);
  const patchedCount = countOccurrences(source, patchedSettingsGate);
  if (currentCount === 0 && patchedCount === 1) {
    return source;
  }
  if (currentCount !== 1 || patchedCount !== 0) {
    console.warn(
      "WARN: Could not find the current Dock icon settings contract - skipping Dock icon settings patch",
    );
    return source;
  }
  return source.replace(currentSettingsGate, patchedSettingsGate);
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
    id: "main-process",
    phase: "main-bundle",
    order: 20_940,
    ciPolicy: "optional",
    apply: applyDockIconMainPatch,
  },
  {
    id: "settings-row",
    phase: "webview-asset",
    order: 20_950,
    ciPolicy: "optional",
    pattern: /^general-settings-C0l3c9YI\.js$/,
    missingDescription: "General settings Dock icon bundle",
    skipDescription: "Dock icon settings row patch",
    apply: applyDockIconSettingsPatch,
  },
  {
    id: "settings-search",
    phase: "webview-asset",
    order: 20_960,
    ciPolicy: "optional",
    pattern: /^settings-page-[A-Za-z0-9_-]+\.js$/,
    missingDescription: "Settings search bundle",
    skipDescription: "Dock icon settings search patch",
    apply: applyDockIconSearchPatch,
  },
];

module.exports = {
  applyDockIconMainPatch,
  applyDockIconSearchPatch,
  applyDockIconSettingsPatch,
  descriptors,
};
