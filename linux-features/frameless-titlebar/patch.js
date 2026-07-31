"use strict";

const {
  delegatePatchMarker,
  patchDelegationState,
} = require("../../scripts/patches/lib/composition-delegation.js");

const FEATURE_ID = "frameless-titlebar";
const LINUX_NATIVE_TITLEBAR_PATCH_ID = "linux-native-titlebar";
const LINUX_NATIVE_TITLEBAR_PATCH_MARKER =
  "/*codexLinuxNativeTitlebarPatch*/";
const LINUX_WINDOW_CONTROLS_SAFE_AREA_PATCH_ID =
  "linux-window-controls-safe-area";
const LINUX_WINDOW_CONTROLS_SAFE_AREA_MARKER =
  "/*codexLinuxWindowControlsSafeAreaPatch*/";

function regexMatchCount(source, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return source.match(new RegExp(pattern.source, flags))?.length ?? 0;
}

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
        `${platformAlias}===\`linux\`?{titleBarStyle:\`hidden\`,${quickChatOptions}}:`
      );
    },
  );

  const patchedLinuxTitlebarRegex =
    /[A-Za-z_$][\w$]*===`linux`\?\{titleBarStyle:`hidden`,\.\.\.[A-Za-z_$][\w$]*===`quickChat`\?\{resizable:!0\}:\{\}\}:/;
  if (!patchedTitlebar && !patchedLinuxTitlebarRegex.test(patchedSource)) {
    console.warn("WARN: Could not find primary BrowserWindow titlebar snippet - skipping frameless titlebar branch patch");
  }

  return patchedSource;
}

function applyFramelessTitlebarOverlaySyncPatch(currentSource) {
  let patchedZoom = false;
  let patchedSource = currentSource.replace(
    /(setWindowZoom\([^)]*\)\{(?=[\s\S]{0,600}?,([A-Za-z_$][\w$]*)=[A-Za-z_$][\w$]*&&this\.windowAppearances\.get\()[\s\S]{0,600}?)\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\3\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(\4\):([A-Za-z_$][\w$]*)\(\4\)\)\)/g,
    (_match, functionPrefix, _appearanceAlias, windowAlias, zoomAlias, overlayHelperAlias) => {
      patchedZoom = true;
      return `${functionPrefix}process.platform===\`win32\`&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(${overlayHelperAlias}(${zoomAlias})))`;
    },
  );

  const patchedZoomRegex =
    /setWindowZoom\([^)]*\)\{(?=[\s\S]{0,600}?,[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*&&this\.windowAppearances\.get\()[\s\S]{0,600}?process\.platform===`win32`&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\1\.setTitleBarOverlay\([A-Za-z_$][\w$]*\(\2\)\)\)/;
  if (currentSource.includes("setWindowZoom(") && !patchedZoom && !patchedZoomRegex.test(patchedSource)) {
    console.warn("WARN: Could not find setWindowZoom titlebar overlay snippet - skipping frameless zoom patch");
  }

  let patchedSync = false;
  patchedSource = patchedSource.replace(
    /installApplicationMenuTitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(process\.platform!==`win32`&&process\.platform!==`linux`\|\|\2!==`primary`&&\2!==`quickChat`\)return;let ([A-Za-z_$][\w$]*)=\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(\1\.id\)\):([A-Za-z_$][\w$]*)\(this\.windowZooms\.get\(\1\.id\)\)\)\};return ([A-Za-z_$][\w$]*)\.nativeTheme\.on\(`updated`,\3\),\3\(\),\(\)=>\{\5\.nativeTheme\.off\(`updated`,\3\)\}\}/g,
    (_match, windowAlias, windowTypeAlias, updateAlias, overlayHelperAlias, electronAlias) => {
      patchedSync = true;
      return `installApplicationMenuTitleBarOverlaySync(${windowAlias},${windowTypeAlias}){if(process.platform!==\`win32\`||${windowTypeAlias}!==\`primary\`&&${windowTypeAlias}!==\`quickChat\`)return;let ${updateAlias}=()=>{${windowAlias}.isDestroyed()||${windowAlias}.setTitleBarOverlay(${overlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))};return ${electronAlias}.nativeTheme.on(\`updated\`,${updateAlias}),${updateAlias}(),()=>{${electronAlias}.nativeTheme.off(\`updated\`,${updateAlias})}}`;
    },
  );

  const patchedSyncRegex =
    /installApplicationMenuTitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(process\.platform!==`win32`\|\|\2!==`primary`&&\2!==`quickChat`\)return;let ([A-Za-z_$][\w$]*)=\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.setTitleBarOverlay\([A-Za-z_$][\w$]*\(this\.windowZooms\.get\(\1\.id\)\)\)\}/;
  if (
    currentSource.includes("installApplicationMenuTitleBarOverlaySync(") &&
    !patchedSync &&
    !patchedSyncRegex.test(patchedSource)
  ) {
    console.warn("WARN: Could not find application menu titlebar overlay sync snippet - skipping frameless sync patch");
  }

  return patchedSource;
}

function hasCompleteFramelessTitlebarMainComposition(source) {
  const delegation = patchDelegationState(
    source,
    LINUX_NATIVE_TITLEBAR_PATCH_ID,
    {
      allowedFeatureIds: [FEATURE_ID],
      enabledFeatureIds: [FEATURE_ID],
      ownerMarker: LINUX_NATIVE_TITLEBAR_PATCH_MARKER,
    },
  );
  if (delegation.state !== "enabled" || delegation.featureId !== FEATURE_ID) {
    return false;
  }

  const helper =
    /function codexLinuxTitleBarOverlay\(e=1\)\{return\{color:([A-Za-z_$][\w$]*)\.nativeTheme\.shouldUseDarkColors\?`#111111`:([A-Za-z_$][\w$]*),symbolColor:\1\.nativeTheme\.shouldUseDarkColors\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),height:Math\.round\(30\*e\)\}\}/u;
  const primary =
    /case`quickChat`:case`primary`:return [^;]{0,2000}?:[A-Za-z_$][\w$]*===`win32`\?\{titleBarStyle:`hidden`,titleBarOverlay:[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\),\.\.\.[A-Za-z_$][\w$]*===`quickChat`\?\{resizable:!0\}:\{\}\}:[A-Za-z_$][\w$]*===`linux`\?\{titleBarStyle:`hidden`,\.\.\.[A-Za-z_$][\w$]*===`quickChat`\?\{resizable:!0\}:\{\}\}:/u;
  const zoom =
    /setWindowZoom\([^)]*\)\{[\s\S]{0,800}?process\.platform===`win32`&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\1\.setTitleBarOverlay\([A-Za-z_$][\w$]*\(\2\)\)\)/u;
  const sync =
    /install[A-Za-z_$][\w$]*TitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(process\.platform!==`win32`\|\|\2!==`primary`&&\2!==`quickChat`\)return;let [A-Za-z_$][\w$]*=\(\)=>\{[\s\S]{0,300}?\1\.setTitleBarOverlay\([A-Za-z_$][\w$]*\(this\.windowZooms\.get\(\1\.id\)\)\)/u;
  const zoomOwner =
    /setWindowZoom\([^)]*\)\{[\s\S]{0,800}?this\.windowAppearances\.get\(/u;
  const syncOwner =
    /install[A-Za-z_$][\w$]*TitleBarOverlaySync\([^)]*\)\{/u;
  const zoomOwnerCount = regexMatchCount(source, zoomOwner);
  const syncOwnerCount = regexMatchCount(source, syncOwner);

  return (
    regexMatchCount(source, helper) === 1 &&
    regexMatchCount(source, primary) === 1 &&
    zoomOwnerCount === 1 &&
    regexMatchCount(source, zoom) === 1 &&
    syncOwnerCount === 1 &&
    regexMatchCount(source, sync) === 1
  );
}

function applyFramelessTitlebarMainPatch(currentSource) {
  const delegation = patchDelegationState(
    currentSource,
    LINUX_NATIVE_TITLEBAR_PATCH_ID,
    {
      allowedFeatureIds: [FEATURE_ID],
      enabledFeatureIds: [FEATURE_ID],
      ownerMarker: LINUX_NATIVE_TITLEBAR_PATCH_MARKER,
    },
  );
  if (delegation.state !== "none") {
    if (
      delegation.state === "enabled" &&
      delegation.featureId === FEATURE_ID &&
      hasCompleteFramelessTitlebarMainComposition(currentSource)
    ) {
      return currentSource;
    }
    console.warn(
      "WARN: Could not validate delegated frameless titlebar main-process composition - leaving bundle unchanged",
    );
    return currentSource;
  }

  const hasOwnerMarker = currentSource.includes(
    LINUX_NATIVE_TITLEBAR_PATCH_MARKER,
  );
  if (!hasOwnerMarker) {
    console.warn(
      "WARN: Could not find completed Linux native titlebar patch for frameless composition - leaving bundle unchanged",
    );
    return currentSource;
  }

  const patchedSource = applyFramelessTitlebarOverlaySyncPatch(
    applyFramelessTitlebarBranchPatch(currentSource),
  );
  const delegatedSource = delegatePatchMarker(
    patchedSource,
    LINUX_NATIVE_TITLEBAR_PATCH_MARKER,
    LINUX_NATIVE_TITLEBAR_PATCH_ID,
    FEATURE_ID,
  );
  if (
    delegatedSource != null &&
    hasCompleteFramelessTitlebarMainComposition(delegatedSource)
  ) {
    return delegatedSource;
  }

  console.warn(
    "WARN: Could not complete delegated frameless titlebar main-process composition - leaving bundle unchanged",
  );
  return currentSource;
}

function applyFramelessTitlebarWebviewTransforms(currentSource) {
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

  const headerSafeAreaProp = "codexLinuxUseWindowControlsSafeArea";
  const hasHeaderSafeArea = currentSource.includes(headerSafeAreaProp);
  patchedSource = patchedSource.replace(
    new RegExp(`${headerSafeAreaProp}:![A-Za-z_$][\\w$]*,side:\`end\``, "g"),
    `${headerSafeAreaProp}:!1,side:\`end\``,
  );
  const recognizedHeaderSafeArea =
    !hasHeaderSafeArea || patchedSource.includes(`${headerSafeAreaProp}:!1,side:\`end\``);

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

  const recognizedChromeMapping = foundApplicationMenuChrome || hasNativeChrome;
  const recognizedBrowserGate = foundApplicationMenuBrowserGate || hasNativeBrowserGate;
  const hasApplicationMenuChromeConsumer =
    currentSource.includes("dataset.codexWindowChrome===`application-menu`");

  if (hasApplicationMenuLayout && !recognizedApplicationMenuLayout) {
    console.warn("WARN: Could not find application menu layout - skipping frameless webview layout patch");
  }
  if (hasApplicationMenuLayout && !recognizedBrowserGate) {
    console.warn("WARN: Could not find application menu browser gate - skipping frameless webview platform patch");
  }
  if (hasHeaderSafeArea && !recognizedHeaderSafeArea) {
    console.warn("WARN: Could not disable the Linux window controls safe area - skipping frameless header padding patch");
  }
  if (hasApplicationMenuChromeConsumer && !recognizedChromeMapping) {
    console.warn("WARN: Could not find Linux window controls chrome mapping - skipping frameless webview chrome patch");
  }
  if (
    !hasApplicationMenuLayout &&
    !hasApplicationMenuChromeConsumer &&
    !hasHeaderSafeArea &&
    !recognizedChromeMapping
  ) {
    console.warn("WARN: Could not identify frameless titlebar webview target - skipping frameless webview patch");
  }

  return patchedSource;
}

function applyFramelessTitlebarWebviewPatch(currentSource) {
  const delegation = patchDelegationState(
    currentSource,
    LINUX_WINDOW_CONTROLS_SAFE_AREA_PATCH_ID,
    {
      allowedFeatureIds: [FEATURE_ID],
      enabledFeatureIds: [FEATURE_ID],
      ownerMarker: LINUX_WINDOW_CONTROLS_SAFE_AREA_MARKER,
    },
  );
  if (delegation.state !== "none") {
    if (
      delegation.state === "enabled" &&
      delegation.featureId === FEATURE_ID &&
      hasCompleteFramelessWindowControlsSafeAreaComposition(currentSource)
    ) {
      return currentSource;
    }
    console.warn(
      "WARN: Could not validate delegated frameless Linux window-controls safe-area composition - leaving asset unchanged",
    );
    return currentSource;
  }

  const hasOwnerMarker = currentSource.includes(
    LINUX_WINDOW_CONTROLS_SAFE_AREA_MARKER,
  );
  if (!hasOwnerMarker) {
    console.warn(
      "WARN: Could not find completed Linux window-controls safe-area patch for frameless composition - leaving asset unchanged",
    );
    return currentSource;
  }

  const patchedSource = applyFramelessTitlebarWebviewTransforms(currentSource);
  const delegatedSource = delegatePatchMarker(
    patchedSource,
    LINUX_WINDOW_CONTROLS_SAFE_AREA_MARKER,
    LINUX_WINDOW_CONTROLS_SAFE_AREA_PATCH_ID,
    FEATURE_ID,
  );
  if (
    delegatedSource != null &&
    hasCompleteFramelessWindowControlsSafeAreaComposition(delegatedSource)
  ) {
    return delegatedSource;
  }

  console.warn(
    "WARN: Could not complete delegated frameless Linux window-controls safe-area composition - leaving asset unchanged",
  );
  return currentSource;
}

function hasCompleteFramelessWindowControlsSafeAreaComposition(source) {
  const delegation = patchDelegationState(
    source,
    LINUX_WINDOW_CONTROLS_SAFE_AREA_PATCH_ID,
    {
      allowedFeatureIds: [FEATURE_ID],
      enabledFeatureIds: [FEATURE_ID],
      ownerMarker: LINUX_WINDOW_CONTROLS_SAFE_AREA_MARKER,
    },
  );
  if (delegation.state !== "enabled" || delegation.featureId !== FEATURE_ID) {
    return false;
  }

  const prop = "codexLinuxUseWindowControlsSafeArea";
  const overrideMatches = source.match(
    new RegExp(`${prop}:!1,side:\`end\``, "gu"),
  ) ?? [];
  const insetMatches = [
    ...source.matchAll(
      /applicationMenu:Object\.freeze\(\{left:0,right:([^}]+)\}\)/gu,
    ),
  ];
  const slotSignatureMatches = source.match(
    new RegExp(
      `function [A-Za-z_$][\\w$]*\\(\\{entries:[A-Za-z_$][\\w$]*,fitWidth:[A-Za-z_$][\\w$]*,side:[A-Za-z_$][\\w$]*,slotWidth:[A-Za-z_$][\\w$]*,${prop}\\}\\)`,
      "gu",
    ),
  ) ?? [];
  const paddingMatches = source.match(
    new RegExp(
      `"pe-2":([A-Za-z_$][\\w$]*)===\`start\`&&[A-Za-z_$][\\w$]*\\|\\|\\1===\`end\`&&!${prop},"pe-\\(--spacing-token-safe-header-right\\)":\\1===\`end\`&&${prop}`,
      "gu",
    ),
  ) ?? [];
  const nativeBrowserGateMatches = source.match(
    /([A-Za-z_$][\w$]*)\.includes\(`win`\)\|\|([A-Za-z_$][\w$]*)\.includes\(`windows`\)\?([A-Za-z_$][\w$]*)\?\?([A-Za-z_$][\w$]*)\.applicationMenu:\4\.default/gu,
  ) ?? [];
  const nativeChromeMappingMatches = source.match(
    /case`win32`:return`application-menu`;case`linux`:return`native`/gu,
  ) ?? [];

  return (
    overrideMatches.length === 1 &&
    insetMatches.length > 0 &&
    insetMatches.every((match) => match[1] === "0") &&
    slotSignatureMatches.length === 1 &&
    paddingMatches.length === 1 &&
    nativeBrowserGateMatches.length === 1 &&
    nativeChromeMappingMatches.length === 1
  );
}

const patches = [
  {
    id: "main-process",
    phase: "main-bundle",
    order: 20_720,
    ciPolicy: "optional",
    composesPatches: [LINUX_NATIVE_TITLEBAR_PATCH_ID],
    apply: applyFramelessTitlebarMainPatch,
  },
  {
    id: "webview-window-controls-layout",
    phase: "webview-asset",
    order: 20_730,
    ciPolicy: "optional",
    composesPatches: [LINUX_WINDOW_CONTROLS_SAFE_AREA_PATCH_ID],
    pattern: /^app-initial-[^.]+\.js$/,
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
  applyFramelessTitlebarWebviewTransforms,
};
