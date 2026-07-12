"use strict";

function applyFramelessTitlebarBranchPatch(currentSource) {
  let patchedTitlebar = false;
  const combinedLinuxTitlebarRegex =
    /([A-Za-z_$][\w$]*)===`win32`\|\|\1===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:\1===`linux`\?codexLinuxTitleBarOverlay\(([A-Za-z_$][\w$]*)\):([A-Za-z_$][\w$]*)\(\2\),(\.\.\.([A-Za-z_$][\w$]*)===`quickChat`\?\{resizable:!0\}:\{\})\}:/g;
  const patchedSource = currentSource.replace(
    combinedLinuxTitlebarRegex,
    (_match, platformAlias, zoomAlias, overlayHelperAlias, quickChatOptions, windowTypeAlias) => {
      patchedTitlebar = true;
      return (
        `${platformAlias}===\`win32\`?{titleBarStyle:\`hidden\`,titleBarOverlay:${overlayHelperAlias}(${zoomAlias}),${quickChatOptions}}:` +
        `${platformAlias}===\`linux\`?{titleBarStyle:\`hidden\`,...${windowTypeAlias}===\`quickChat\`?{titleBarOverlay:codexLinuxTitleBarOverlay(${zoomAlias}),resizable:!0}:{}}:`
      );
    },
  );

  const patchedLinuxTitlebarRegex =
    /[A-Za-z_$][\w$]*===`linux`\?\{titleBarStyle:`hidden`,\.\.\.[A-Za-z_$][\w$]*===`quickChat`\?\{titleBarOverlay:codexLinuxTitleBarOverlay\([A-Za-z_$][\w$]*\),resizable:!0\}:\{\}\}:/;
  if (!patchedTitlebar && !patchedLinuxTitlebarRegex.test(patchedSource)) {
    console.warn("WARN: Could not find primary BrowserWindow titlebar snippet - skipping frameless titlebar branch patch");
  }

  return patchedSource;
}

function applyFramelessTitlebarOverlaySyncPatch(currentSource) {
  let patchedZoom = false;
  let patchedSource = currentSource.replace(
    /(setWindowZoom\([^)]*\)\{(?=[\s\S]{0,600}?,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*&&this\.windowAppearances\.get\()[\s\S]{0,600}?)\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\3\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(\4\):([A-Za-z_$][\w$]*)\(\4\)\)\)/g,
    (_match, functionPrefix, appearanceAlias, windowAlias, zoomAlias, overlayHelperAlias) => {
      patchedZoom = true;
      return `${functionPrefix}(process.platform===\`win32\`||process.platform===\`linux\`&&${appearanceAlias}===\`quickChat\`)&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?codexLinuxTitleBarOverlay(${zoomAlias}):${overlayHelperAlias}(${zoomAlias})))`;
    },
  );

  const patchedZoomRegex =
    /setWindowZoom\([^)]*\)\{(?=[\s\S]{0,600}?,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*&&this\.windowAppearances\.get\()[\s\S]{0,600}?\(process\.platform===`win32`\|\|process\.platform===`linux`&&\1===`quickChat`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\2\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(\3\):[A-Za-z_$][\w$]*\(\3\)\)\)/;
  if (currentSource.includes("setWindowZoom(") && !patchedZoom && !patchedZoomRegex.test(patchedSource)) {
    console.warn("WARN: Could not find setWindowZoom titlebar overlay snippet - skipping frameless zoom patch");
  }

  let patchedSync = false;
  patchedSource = patchedSource.replace(
    /installApplicationMenuTitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(process\.platform!==`win32`&&process\.platform!==`linux`\|\|\2!==`primary`&&\2!==`quickChat`\)return;let ([A-Za-z_$][\w$]*)=\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(\1\.id\)\):([A-Za-z_$][\w$]*)\(this\.windowZooms\.get\(\1\.id\)\)\)\};return ([A-Za-z_$][\w$]*)\.nativeTheme\.on\(`updated`,\3\),\3\(\),\(\)=>\{\5\.nativeTheme\.off\(`updated`,\3\)\}\}/g,
    (_match, windowAlias, windowTypeAlias, updateAlias, overlayHelperAlias, electronAlias) => {
      patchedSync = true;
      return `installApplicationMenuTitleBarOverlaySync(${windowAlias},${windowTypeAlias}){if(process.platform!==\`win32\`&&(process.platform!==\`linux\`||${windowTypeAlias}!==\`quickChat\`)||${windowTypeAlias}!==\`primary\`&&${windowTypeAlias}!==\`quickChat\`)return;let ${updateAlias}=()=>{${windowAlias}.isDestroyed()||${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?codexLinuxTitleBarOverlay(this.windowZooms.get(${windowAlias}.id)):${overlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))};return ${electronAlias}.nativeTheme.on(\`updated\`,${updateAlias}),${updateAlias}(),()=>{${electronAlias}.nativeTheme.off(\`updated\`,${updateAlias})}}`;
    },
  );

  const patchedSyncRegex =
    /installApplicationMenuTitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(process\.platform!==`win32`&&\(process\.platform!==`linux`\|\|\2!==`quickChat`\)\|\|\2!==`primary`&&\2!==`quickChat`\)return;let ([A-Za-z_$][\w$]*)=\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(\1\.id\)\):[A-Za-z_$][\w$]*\(this\.windowZooms\.get\(\1\.id\)\)\)\}/;
  if (
    currentSource.includes("installApplicationMenuTitleBarOverlaySync(") &&
    !patchedSync &&
    !patchedSyncRegex.test(patchedSource)
  ) {
    console.warn("WARN: Could not find application menu titlebar overlay sync snippet - skipping frameless sync patch");
  }

  return patchedSource;
}

function applyFramelessTitlebarMainPatch(currentSource) {
  return applyFramelessTitlebarOverlaySyncPatch(
    applyFramelessTitlebarBranchPatch(currentSource),
  );
}

function applyFramelessTitlebarWebviewPatch(currentSource) {
  let foundApplicationMenuLayout = false;
  let patchedSource = currentSource.replace(
    /applicationMenu:Object\.freeze\(\{left:0,right:\d+\}\)/g,
    () => {
      foundApplicationMenuLayout = true;
      return "applicationMenu:Object.freeze({left:0,right:0})";
    },
  );
  const hasApplicationMenuLayout = currentSource.includes("applicationMenu:Object.freeze(");
  const recognizedApplicationMenuLayout =
    foundApplicationMenuLayout || patchedSource.includes("applicationMenu:Object.freeze({left:0,right:0})");

  const linuxApplicationMenuChrome = "case`win32`:case`linux`:return`application-menu`";
  const linuxNativeChrome = "case`win32`:return`application-menu`;case`linux`:return`native`";
  const foundApplicationMenuChrome = patchedSource.includes(linuxApplicationMenuChrome);
  const hasNativeChrome = patchedSource.includes(linuxNativeChrome);
  if (foundApplicationMenuChrome) {
    patchedSource = patchedSource.split(linuxApplicationMenuChrome).join(linuxNativeChrome);
  }

  const linuxApplicationMenuBrowserGateRegex =
    /([A-Za-z_$][\w$]*)\.includes\(`win`\)\|\|([A-Za-z_$][\w$]*)\.includes\(`windows`\)\|\|\1\.includes\(`linux`\)\?([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\.applicationMenu:\4\.default/g;
  const nativeApplicationMenuBrowserGateRegex =
    /([A-Za-z_$][\w$]*)\.includes\(`win`\)\|\|([A-Za-z_$][\w$]*)\.includes\(`windows`\)\?\w+\?\?[A-Za-z_$][\w$]*\.applicationMenu:[A-Za-z_$][\w$]*\.default/;
  let foundApplicationMenuBrowserGate = false;
  patchedSource = patchedSource.replace(
    linuxApplicationMenuBrowserGateRegex,
    (_match, platformAlias, userAgentAlias, fallbackAlias, layoutAlias) => {
      foundApplicationMenuBrowserGate = true;
      return `${platformAlias}.includes(\`win\`)||${userAgentAlias}.includes(\`windows\`)?${fallbackAlias}??${layoutAlias}.applicationMenu:${layoutAlias}.default`;
    },
  );
  const hasNativeBrowserGate = nativeApplicationMenuBrowserGateRegex.test(patchedSource);

  const applicationMenuBridgeRegex =
    /function ([A-Za-z_$][\w$]*)\(\)\{return ([A-Za-z_$][\w$]*)\(\)&&window\.electronBridge\?\.showApplicationMenu!=null\}/g;
  let foundApplicationMenuBridge = false;
  patchedSource = patchedSource.replace(applicationMenuBridgeRegex, (_match, functionName) => {
    foundApplicationMenuBridge = true;
    return `function ${functionName}(){return!1}`;
  });
  const disabledApplicationMenuBridgeRegex =
    /function ([A-Za-z_$][\w$]*)\(\)\{return!1\}[\s\S]{0,1600}?if\(!\1\(\)\)return null;[\s\S]{0,1600}?showApplicationMenu/;

  const recognizedChromeMapping = foundApplicationMenuChrome || hasNativeChrome;
  const recognizedBrowserGate = foundApplicationMenuBrowserGate || hasNativeBrowserGate;
  const recognizedApplicationMenuBridge =
    foundApplicationMenuBridge || disabledApplicationMenuBridgeRegex.test(patchedSource);
  const hasApplicationMenuChromeConsumer =
    currentSource.includes("dataset.codexWindowChrome===`application-menu`");

  if (hasApplicationMenuLayout && !recognizedApplicationMenuLayout) {
    console.warn("WARN: Could not find application menu layout - skipping frameless webview layout patch");
  }
  if (hasApplicationMenuLayout && !recognizedBrowserGate) {
    console.warn("WARN: Could not find application menu browser gate - skipping frameless webview platform patch");
  }
  if (hasApplicationMenuLayout && !recognizedApplicationMenuBridge) {
    console.warn("WARN: Could not find application menu bridge guard - skipping frameless webview bridge patch");
  }
  if (hasApplicationMenuChromeConsumer && !recognizedChromeMapping) {
    console.warn("WARN: Could not find Linux window controls chrome mapping - skipping frameless webview chrome patch");
  }
  if (
    !hasApplicationMenuLayout &&
    !hasApplicationMenuChromeConsumer &&
    !recognizedChromeMapping
  ) {
    console.warn("WARN: Could not identify frameless titlebar webview target - skipping frameless webview patch");
  }

  return patchedSource;
}

const patches = [
  {
    id: "main-process",
    phase: "main-bundle",
    order: 20_720,
    ciPolicy: "optional",
    apply: applyFramelessTitlebarMainPatch,
  },
  {
    id: "webview-window-controls-layout",
    phase: "webview-asset",
    order: 20_730,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-.*\.js$/,
    missingDescription: "main app chrome bundle",
    skipDescription: "frameless titlebar webview layout patch",
    apply: applyFramelessTitlebarWebviewPatch,
  },
];

module.exports = {
  descriptors: patches,
  applyFramelessTitlebarBranchPatch,
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarOverlaySyncPatch,
  applyFramelessTitlebarWebviewPatch,
};
