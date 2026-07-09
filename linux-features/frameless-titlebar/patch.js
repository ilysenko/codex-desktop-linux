"use strict";

const LINUX_TITLEBAR_OVERLAY_HELPER = "codexLinuxTitleBarOverlay";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyFramelessTitlebarBranchPatch(currentSource) {
  const primaryTitlebarRegex =
    /case`primary`:return ([A-Za-z_$][\w$]*)===`darwin`\?([A-Za-z_$][\w$]*)\?\{titleBarStyle:`hiddenInset`,trafficLightPosition:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\}:\{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:\3\(\4\)\}:\1===`win32`(\|\|\1===`linux`)?\?\{titleBarStyle:`hidden`,titleBarOverlay:([A-Za-z_$][\w$]*)\(\4\)\}:\{titleBarStyle:`default`\};/g;
  let patchedSource = currentSource;
  let patchedTitlebar = false;

  primaryTitlebarRegex.lastIndex = 0;
  patchedSource = patchedSource.replace(
    primaryTitlebarRegex,
    (_match, platformAlias, opaqueWindowsAlias, trafficLightAlias, zoomAlias, _linuxInWin32Branch, overlayHelperAlias) => {
      patchedTitlebar = true;
      return `case\`primary\`:return ${platformAlias}===\`darwin\`?${opaqueWindowsAlias}?{titleBarStyle:\`hiddenInset\`,trafficLightPosition:${trafficLightAlias}(${zoomAlias})}:{vibrancy:\`menu\`,titleBarStyle:\`hiddenInset\`,trafficLightPosition:${trafficLightAlias}(${zoomAlias})}:${platformAlias}===\`win32\`?{titleBarStyle:\`hidden\`,titleBarOverlay:${overlayHelperAlias}(${zoomAlias})}:${platformAlias}===\`linux\`?{titleBarStyle:\`hidden\`}:{titleBarStyle:\`default\`};`;
    },
  );

  const linuxOverlayRegex = new RegExp(
    `([A-Za-z_$][\\w$]*)===\`linux\`\\?\\{titleBarStyle:\`hidden\`,titleBarOverlay:${escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER)}\\([^)]*\\)\\}:`,
    "g",
  );
  patchedSource = patchedSource.replace(linuxOverlayRegex, (_match, platformAlias) => {
    patchedTitlebar = true;
    return `${platformAlias}===\`linux\`?{titleBarStyle:\`hidden\`}:`;
  });

  if (!patchedTitlebar && !/===`linux`\?\{titleBarStyle:`hidden`\}/.test(patchedSource)) {
    console.warn("WARN: Could not find primary BrowserWindow titlebar snippet - skipping frameless titlebar branch patch");
  }

  return patchedSource;
}

// The zoom path and the overlay sync method each appear in multiple shapes
// depending on upstream and core-patch vintage. setWindowZoom: a plain
// overlay helper body, or a codexLinuxTitleBarOverlay ternary body after the
// core linux-native-titlebar patch. Overlay sync: the un-widened upstream
// form, the current upstream form with a win32/linux gate but a plain
// overlay helper body, and the core-patched form with a
// codexLinuxTitleBarOverlay ternary body. All must collapse to win32-only.
function applyFramelessTitlebarOverlaySyncPatch(currentSource) {
  let patchedSource = currentSource.replace(
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\1\.setTitleBarOverlay\(([A-Za-z_$][\w$]*)\(\2\)\)\)/g,
    (_match, windowAlias, zoomAlias, overlayHelperAlias) =>
      `process.platform===\`win32\`&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(${overlayHelperAlias}(${zoomAlias})))`,
  );

  const linuxZoomOverlayTernaryRegex = new RegExp(
    "\\(process\\.platform===`win32`\\|\\|process\\.platform===`linux`\\)&&\\(this\\.windowZooms\\.set\\(([A-Za-z_$][\\w$]*)\\.id,([A-Za-z_$][\\w$]*)\\),\\1\\.setTitleBarOverlay\\(process\\.platform===`linux`\\?" +
      escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER) +
      "\\([^)]*\\):([A-Za-z_$][\\w$]*)\\(\\2\\)\\)\\)",
    "g",
  );
  patchedSource = patchedSource.replace(
    linuxZoomOverlayTernaryRegex,
    (_match, windowAlias, zoomAlias, overlayHelperAlias) =>
      `process.platform===\`win32\`&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(${overlayHelperAlias}(${zoomAlias})))`,
  );

  patchedSource = patchedSource.replace(
    /(install(?:Windows|ApplicationMenu)TitleBarOverlaySync)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\((?:\(process\.platform!==`win32`&&process\.platform!==`linux`\)|process\.platform!==`win32`&&process\.platform!==`linux`)\|\|\3!==`primary`\)return;let ([A-Za-z_$][\w$]*)=\(\)=>\{\2\.isDestroyed\(\)\|\|\2\.setTitleBarOverlay\(([A-Za-z_$][\w$]*)\(this\.windowZooms\.get\(\2\.id\)\)\)\};return ([A-Za-z_$][\w$]*)\.nativeTheme\.on\(`updated`,\4\),\4\(\),\(\)=>\{\6\.nativeTheme\.off\(`updated`,\4\)\}\}/g,
    (_match, methodName, windowAlias, windowTypeAlias, updateAlias, overlayHelperAlias, electronAlias) =>
      `${methodName}(${windowAlias},${windowTypeAlias}){if(process.platform!==\`win32\`||${windowTypeAlias}!==\`primary\`)return;let ${updateAlias}=()=>{${windowAlias}.isDestroyed()||${windowAlias}.setTitleBarOverlay(${overlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))};return ${electronAlias}.nativeTheme.on(\`updated\`,${updateAlias}),${updateAlias}(),()=>{${electronAlias}.nativeTheme.off(\`updated\`,${updateAlias})}}`,
  );

  return patchedSource.replace(
    /(install(?:Windows|ApplicationMenu)TitleBarOverlaySync)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(\(process\.platform!==`win32`&&process\.platform!==`linux`\)\|\|\3!==`primary`\)return;let ([A-Za-z_$][\w$]*)=\(\)=>\{\2\.isDestroyed\(\)\|\|\2\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(\2\.id\)\):([A-Za-z_$][\w$]*)\(this\.windowZooms\.get\(\2\.id\)\)\)\};return ([A-Za-z_$][\w$]*)\.nativeTheme\.on\(`updated`,\4\),\4\(\),\(\)=>\{\6\.nativeTheme\.off\(`updated`,\4\)\}\}/g,
    (_match, methodName, windowAlias, windowTypeAlias, updateAlias, windowsOverlayHelperAlias, electronAlias) =>
      `${methodName}(${windowAlias},${windowTypeAlias}){if(process.platform!==\`win32\`||${windowTypeAlias}!==\`primary\`)return;let ${updateAlias}=()=>{${windowAlias}.isDestroyed()||${windowAlias}.setTitleBarOverlay(${windowsOverlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))};return ${electronAlias}.nativeTheme.on(\`updated\`,${updateAlias}),${updateAlias}(),()=>{${electronAlias}.nativeTheme.off(\`updated\`,${updateAlias})}}`,
  );
}

function applyFramelessTitlebarMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  let patchedSource = currentSource
    .replace(
      /process\.platform===`linux`&&\(([A-Za-z_$][\w$]*)\.setMenuBarVisibility\(!1\),\1\.removeMenu\?\.\(\)\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `process.platform===\`linux\`&&${windowVar}.removeMenu(),process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    )
    .replace(
      /process\.platform===`linux`&&([A-Za-z_$][\w$]*)\.setMenuBarVisibility\(!1\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `process.platform===\`linux\`&&${windowVar}.removeMenu(),process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    );
  let patchedAny = patchedSource !== currentSource;
  patchedSource = patchedSource.replace(menuRegex, (match, windowVar, offset, source) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.removeMenu(),`;
    if (source.slice(Math.max(0, offset - linuxPatch.length), offset) === linuxPatch) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  const hasWindowsRemoveMenu = /process\.platform===`win32`&&[A-Za-z_$][\w$]*\.removeMenu\(\),/.test(patchedSource);
  const hasLinuxRemoveMenu = /process\.platform===`linux`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),process\.platform===`win32`&&\1\.removeMenu\(\),/.test(patchedSource);
  if (!patchedAny && hasWindowsRemoveMenu && !hasLinuxRemoveMenu) {
    console.warn("WARN: Could not find window menu visibility snippet - skipping frameless titlebar menu patch");
  }

  return patchedSource;
}

function applyFramelessTitlebarMainPatch(currentSource) {
  return applyFramelessTitlebarMenuPatch(
    applyFramelessTitlebarOverlaySyncPatch(
      applyFramelessTitlebarBranchPatch(currentSource),
    ),
  );
}

function applyFramelessTitlebarWebviewPatch(currentSource) {
  let patchedSource = currentSource.replace(
    /applicationMenu:Object\.freeze\(\{left:0,right:\d+\}\)/g,
    "applicationMenu:Object.freeze({left:0,right:0})",
  );

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

  const recognizedChromeMapping = foundApplicationMenuChrome || hasNativeChrome;
  const recognizedBrowserGate = foundApplicationMenuBrowserGate || hasNativeBrowserGate;
  if (
    !recognizedChromeMapping &&
    !recognizedBrowserGate &&
    !foundApplicationMenuBridge &&
    currentSource.includes("applicationMenu:Object.freeze({left:0,right:")
  ) {
    console.warn("WARN: Could not find Linux window controls chrome mapping - skipping frameless webview chrome patch");
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
    pattern: /^app-initial~app-main~onboarding-page-.*\.js$/,
    missingDescription: "main app chrome bundle",
    skipDescription: "frameless titlebar webview layout patch",
    apply: applyFramelessTitlebarWebviewPatch,
  },
];

module.exports = {
  descriptors: patches,
  applyFramelessTitlebarBranchPatch,
  applyFramelessTitlebarMainPatch,
  applyFramelessTitlebarMenuPatch,
  applyFramelessTitlebarOverlaySyncPatch,
  applyFramelessTitlebarWebviewPatch,
};
