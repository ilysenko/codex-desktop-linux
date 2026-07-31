"use strict";

const {
  escapeRegExp,
  findMatchingBrace,
} = require("../../lib/minified-js.js");
const {
  patchDelegationState,
} = require("../../lib/composition-delegation.js");

const LINUX_TITLEBAR_OVERLAY_HEIGHT = 30;
const LINUX_TITLEBAR_OVERLAY_HELPER = "codexLinuxTitleBarOverlay";
const LINUX_TITLEBAR_PATCH_MARKER = "/*codexLinuxNativeTitlebarPatch*/";
const LINUX_TITLEBAR_PATCH_ID = "linux-native-titlebar";

function linuxTitlebarOverlayHelperSource(
  electronAlias,
  lightBackgroundAlias,
  lightSymbolAlias,
  darkSymbolAlias,
) {
  return `function ${LINUX_TITLEBAR_OVERLAY_HELPER}(e=1){return{color:${electronAlias}.nativeTheme.shouldUseDarkColors?\`#111111\`:${lightBackgroundAlias},symbolColor:${electronAlias}.nativeTheme.shouldUseDarkColors?${lightSymbolAlias}:${darkSymbolAlias},height:Math.round(${LINUX_TITLEBAR_OVERLAY_HEIGHT}*e)}}`;
}

function ensureLinuxTitlebarOverlayHelper(source, anchorText, helperSource) {
  if (source.includes(`function ${LINUX_TITLEBAR_OVERLAY_HELPER}(`)) {
    return source;
  }

  const anchorIndex = source.indexOf(anchorText);
  if (anchorIndex === -1) {
    return null;
  }

  return (
    source.slice(0, anchorIndex + anchorText.length) +
    helperSource +
    source.slice(anchorIndex + anchorText.length)
  );
}

// Main-process patches adapt Electron shell behavior: windows, tray, menu,
// single-instance handling, file manager integration, and packaged runtime glue.
function applyLinuxWindowOptionsPatch(currentSource, iconAsset) {
  let patchedSource = currentSource;

  if (iconAsset != null) {
    const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
    const iconPathNeedle = `icon:${iconPathExpression}`;
    const setIconNeedle = `setIcon(${iconPathExpression})`;
    const readyToShowSetIconInsertionPattern = /[A-Za-z_$][\w$]*\.once\(`ready-to-show`,\(\)=>\{/;

    const currentLinuxAutoHideMenuBarNeedle =
      "...process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{},";
    const windowOptionsReplacement =
      `...process.platform===\`win32\`?{autoHideMenuBar:!0}:process.platform===\`linux\`?{${iconPathNeedle}}:{},`;

    if (patchedSource.includes(currentLinuxAutoHideMenuBarNeedle)) {
      patchedSource = patchedSource.split(currentLinuxAutoHideMenuBarNeedle).join(windowOptionsReplacement);
    } else if (
      !patchedSource.includes(iconPathNeedle) &&
      !patchedSource.includes(setIconNeedle) &&
      !readyToShowSetIconInsertionPattern.test(patchedSource)
    ) {
      console.warn("WARN: Could not find BrowserWindow autoHideMenuBar snippet — skipping window options patch");
    }
  }

  patchedSource = applyDefinedBrowserWindowOptionsPatch(patchedSource);
  patchedSource = applyLinuxPrimaryFocusablePatch(patchedSource);
  return patchedSource;
}

function applyDefinedBrowserWindowOptionsPatch(currentSource) {
  const browserWindowOptionsRegex =
    /show:([A-Za-z_$][\w$]*),parent:([A-Za-z_$][\w$]*),\.\.\.([A-Za-z_$][\w$]*)===void 0\?\{\}:\{focusable:\3\},(\.\.\.process\.platform===`win32`(?:\|\|process\.platform===`linux`)?\?\{autoHideMenuBar:!0\}(?::process\.platform===`linux`\?\{icon:process\.resourcesPath\+`\/\.\.\/content\/webview\/assets\/[^`]+`\})?:\{\},)backgroundMaterial:([A-Za-z_$][\w$]*)\?\?void 0,\.\.\.([A-Za-z_$][\w$]*),minWidth:([A-Za-z_$][\w$]*)\?\.width,minHeight:\7\?\.height,webPreferences:([A-Za-z_$][\w$]*)/g;

  return currentSource.replace(
    browserWindowOptionsRegex,
    (
      _match,
      showAlias,
      parentAlias,
      focusableAlias,
      platformOptions,
      backgroundMaterialAlias,
      appearanceOptionsAlias,
      minimumSizeAlias,
      webPreferencesAlias,
    ) =>
      `show:${showAlias},...${parentAlias}===void 0?{}:{parent:${parentAlias}},...${focusableAlias}===void 0?{}:{focusable:${focusableAlias}},${platformOptions}...${backgroundMaterialAlias}==null?{}:{backgroundMaterial:${backgroundMaterialAlias}},...${appearanceOptionsAlias},...${minimumSizeAlias}==null?{}:{minWidth:${minimumSizeAlias}.width,minHeight:${minimumSizeAlias}.height},webPreferences:${webPreferencesAlias}`,
  );
}

function findCreateWindowAppearanceAlias(currentSource, matchIndex) {
  const prefix = currentSource.slice(Math.max(0, matchIndex - 3000), matchIndex);
  const createWindowRegex =
    /createWindow\([^)]*\)\{let\{[^}]*appearance:([A-Za-z_$][\w$]*)(?:=[^,}]+)?/g;
  let match;
  let appearanceAlias = null;
  while ((match = createWindowRegex.exec(prefix)) != null) {
    appearanceAlias = match[1];
  }
  return appearanceAlias;
}

function hasPrimaryBrowserWindowFocusableCandidate(currentSource) {
  return /createWindow\([^)]*\)\{let\{[^}]*appearance:[A-Za-z_$][\w$]*(?:=`primary`)?[^}]*\}=[\s\S]{0,3500}?new\s+[A-Za-z_$][\w$]*\.BrowserWindow\(\{[\s\S]{0,2000}?focusable:/.test(
    currentSource,
  );
}

function applyLinuxPrimaryFocusablePatch(currentSource) {
  if (
    currentSource.includes("===`primary`?{focusable:!0}")
  ) {
    return currentSource;
  }

  let patchedAny = false;
  let matchedAny = false;
  const focusableSpreadRegex =
    /\.\.\.([A-Za-z_$][\w$]*)===void 0\?\{\}:\{focusable:\1\},(\.\.\.process\.platform===`win32`(?:\|\|process\.platform===`linux`)?\?)/g;
  const patchedSource = currentSource.replace(
    focusableSpreadRegex,
    (match, focusableAlias, platformOptions, offset) => {
      matchedAny = true;
      const appearanceAlias = findCreateWindowAppearanceAlias(currentSource, offset);
      if (appearanceAlias == null) {
        return match;
      }
      patchedAny = true;
      return (
        `...process.platform===\`linux\`&&${appearanceAlias}===\`primary\`?{focusable:!0}:` +
        `${focusableAlias}===void 0?{}:{focusable:${focusableAlias}},${platformOptions}`
      );
    },
  );

  if (!patchedAny && matchedAny && hasPrimaryBrowserWindowFocusableCandidate(currentSource)) {
    throw new Error("Could not derive primary BrowserWindow appearance alias for Linux focusable patch");
  }

  if (!patchedAny && hasPrimaryBrowserWindowFocusableCandidate(currentSource)) {
    throw new Error("Could not patch primary BrowserWindow focusable option for Linux");
  }

  return patchedSource;
}

function findMinifiedMethod(source, signatureRegex) {
  const match = source.match(signatureRegex);
  if (match == null) {
    return null;
  }
  const openIndex = match.index + match[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  if (closeIndex === -1) {
    return null;
  }
  return {
    match,
    start: match.index,
    end: closeIndex + 1,
    text: source.slice(match.index, closeIndex + 1),
  };
}

function markLinuxNativeTitlebarPatch(source) {
  const helperNeedle = `function ${LINUX_TITLEBAR_OVERLAY_HELPER}(`;
  const helperIndex = source.indexOf(helperNeedle);
  if (helperIndex === -1) {
    return null;
  }
  return (
    source.slice(0, helperIndex) +
    LINUX_TITLEBAR_PATCH_MARKER +
    source.slice(helperIndex)
  );
}

function regexMatchCount(source, pattern) {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return source.match(new RegExp(pattern.source, flags))?.length ?? 0;
}

function hasCompleteLinuxNativeTitlebarPatch(source, helperFunctionRegex) {
  const markerCount =
    source.split(LINUX_TITLEBAR_PATCH_MARKER).length - 1;
  if (
    markerCount !== 1 ||
    regexMatchCount(source, helperFunctionRegex) !== 1
  ) {
    return false;
  }

  const nativePrimary =
    /case`quickChat`:case`primary`:return [^;]{0,2000}?titleBarOverlay:([A-Za-z_$][\w$]*)===`linux`\?codexLinuxTitleBarOverlay\(([A-Za-z_$][\w$]*)\):([A-Za-z_$][\w$]*)\(\2\)/u;
  const nativeZoom =
    /setWindowZoom\([^)]*\)\{[\s\S]{0,800}?\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\1\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(\2\):([A-Za-z_$][\w$]*)\(\2\)\)\)/u;
  const nativeSync =
    /install[A-Za-z_$][\w$]*TitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{if\(process\.platform!==`win32`&&process\.platform!==`linux`\|\|\2!==`primary`&&\2!==`quickChat`\)return;let [A-Za-z_$][\w$]*=\(\)=>\{[\s\S]{0,300}?\1\.setTitleBarOverlay\(process\.platform===`linux`\?codexLinuxTitleBarOverlay\(this\.windowZooms\.get\(\1\.id\)\):([A-Za-z_$][\w$]*)\(this\.windowZooms\.get\(\1\.id\)\)\)/u;
  const zoomOwner =
    /setWindowZoom\([^)]*\)\{[\s\S]{0,800}?this\.windowAppearances\.get\(/u;
  const syncOwner =
    /install[A-Za-z_$][\w$]*TitleBarOverlaySync\([^)]*\)\{/u;
  const zoomOwnerCount = regexMatchCount(source, zoomOwner);
  const syncOwnerCount = regexMatchCount(source, syncOwner);
  return (
    regexMatchCount(source, nativePrimary) === 1 &&
    zoomOwnerCount === 1 &&
    regexMatchCount(source, nativeZoom) === 1 &&
    syncOwnerCount === 1 &&
    regexMatchCount(source, nativeSync) === 1
  );
}

function applyLinuxNativeTitlebarPatch(currentSource, context = {}) {
  const helperFunctionRegex = new RegExp(
    'function ' +
      escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER) +
      '\\(e=1\\)\\{return\\{color:([A-Za-z_$][\\w$]*)\\.nativeTheme\\.shouldUseDarkColors\\?`#111111`:([A-Za-z_$][\\w$]*),symbolColor:\\1\\.nativeTheme\\.shouldUseDarkColors\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*),height:Math\\.round\\(' +
      LINUX_TITLEBAR_OVERLAY_HEIGHT +
      '\\*e\\)\\}\\}',
  );
  const delegation = patchDelegationState(
    currentSource,
    LINUX_TITLEBAR_PATCH_ID,
    {
      allowedFeatureIds:
        context.patchCompositionDelegates?.[LINUX_TITLEBAR_PATCH_ID],
      enabledFeatureIds: context.enabledFeatureIds,
      ownerMarker: LINUX_TITLEBAR_PATCH_MARKER,
    },
  );
  if (delegation.state === "enabled") {
    return currentSource;
  }
  if (delegation.state !== "none") {
    console.warn(
      "WARN: Found inactive or invalid Linux native titlebar patch delegation — skipping",
    );
    return currentSource;
  }
  const markerCount =
    currentSource.split(LINUX_TITLEBAR_PATCH_MARKER).length - 1;
  if (markerCount > 0) {
    if (hasCompleteLinuxNativeTitlebarPatch(currentSource, helperFunctionRegex)) {
      return currentSource;
    }
    console.warn(
      "WARN: Found incomplete Linux native titlebar patch marker — skipping",
    );
    return currentSource;
  }
  if (currentSource.includes(`function ${LINUX_TITLEBAR_OVERLAY_HELPER}(`)) {
    console.warn(
      "WARN: Found unmarked Linux native titlebar patch state — skipping",
    );
    return currentSource;
  }

  const primaryTitlebarRegex =
    /(case`quickChat`:case`primary`:return [^;]{0,2000}?([A-Za-z_$][\w$]*)===`win32`\|\|\2===`linux`\?\{titleBarStyle:`hidden`,titleBarOverlay:)([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/;
  const patchedPrimaryTitlebarRegex = new RegExp(
    `(case\`quickChat\`:case\`primary\`:return [^;]{0,2000}?titleBarOverlay:)([A-Za-z_$][\\w$]*)===\`linux\`\\?${escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER)}\\(([A-Za-z_$][\\w$]*)\\):([A-Za-z_$][\\w$]*)\\(\\3\\)`,
  );
  const primaryTitlebarMatch = currentSource.match(primaryTitlebarRegex);
  const patchedPrimaryTitlebarMatch = currentSource.match(patchedPrimaryTitlebarRegex);
  if (primaryTitlebarMatch == null && patchedPrimaryTitlebarMatch == null) {
    console.warn("WARN: Could not find primary BrowserWindow titlebar snippet — skipping Linux native titlebar patch");
    return currentSource;
  }

  let patchedSource = currentSource;
  let electronAlias;
  if (primaryTitlebarMatch != null) {
    const [, titlebarPrefix, platformAlias, overlayHelperAlias, zoomAlias] = primaryTitlebarMatch;
    const overlayHelperRegex = new RegExp(
      `function ${escapeRegExp(overlayHelperAlias)}\\([^)]*\\)\\{return\\{color:[A-Za-z_$][\\w$]*,symbolColor:([A-Za-z_$][\\w$]*)\\.nativeTheme\\.shouldUseDarkColors\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*),height:Math\\.round\\(([A-Za-z_$][\\w$]*)\\*[^)]*\\)\\}\\}`,
    );
    const overlayHelperMatch = currentSource.match(overlayHelperRegex);
    const linuxBackgroundMatch = currentSource.match(
      /===`linux`&&!([A-Za-z_$][\w$]*)\([A-Za-z_$][\w$]*\)\?\{backgroundColor:([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),backgroundMaterial:null\}/,
    );
    if (overlayHelperMatch == null || linuxBackgroundMatch == null) {
      console.warn("WARN: Could not derive titleBarOverlay aliases — skipping Linux native titlebar patch");
      return currentSource;
    }

    const [, currentElectronAlias, lightSymbolAlias, darkSymbolAlias] = overlayHelperMatch;
    const lightBackgroundAlias = linuxBackgroundMatch[4];
    electronAlias = currentElectronAlias;
    patchedSource = patchedSource.replace(
      primaryTitlebarRegex,
      `${titlebarPrefix}${platformAlias}===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(${zoomAlias}):${overlayHelperAlias}(${zoomAlias})`,
    );
    patchedSource = ensureLinuxTitlebarOverlayHelper(
      patchedSource,
      overlayHelperMatch[0],
      linuxTitlebarOverlayHelperSource(
        electronAlias,
        lightBackgroundAlias,
        lightSymbolAlias,
        darkSymbolAlias,
      ),
    );
    if (patchedSource == null) {
      console.warn("WARN: Could not insert Linux titleBarOverlay helper — skipping Linux native titlebar patch");
      return currentSource;
    }
  } else {
    const helperFunctionMatch = currentSource.match(helperFunctionRegex);
    if (helperFunctionMatch == null) {
      console.warn("WARN: Could not derive Linux titleBarOverlay helper aliases — skipping Linux native titlebar patch");
      return currentSource;
    }
    electronAlias = helperFunctionMatch[1];
  }

  const zoomMethod = findMinifiedMethod(
    patchedSource,
    /setWindowZoom\([^)]*\)\{/,
  );
  if (zoomMethod == null) {
    console.warn(
      "WARN: Could not find setWindowZoom owner — skipping Linux native titlebar patch",
    );
    return currentSource;
  }
  const zoomOverlayRegex =
    /\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&\(this\.windowZooms\.set\(([A-Za-z_$][\w$]*)\.id,([A-Za-z_$][\w$]*)\),\1\.setTitleBarOverlay\(([A-Za-z_$][\w$]*)\(\2\)\)\)/g;
  if (regexMatchCount(zoomMethod.text, zoomOverlayRegex) !== 1) {
    console.warn(
      "WARN: Could not find the current setWindowZoom titlebar overlay consumer — skipping Linux native titlebar patch",
    );
    return currentSource;
  }
  const patchedZoomMethod = zoomMethod.text.replace(
    zoomOverlayRegex,
    (_match, windowAlias, zoomAlias, overlayHelperAlias) =>
      `(process.platform===\`win32\`||process.platform===\`linux\`)&&(this.windowZooms.set(${windowAlias}.id,${zoomAlias}),${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(${zoomAlias}):${overlayHelperAlias}(${zoomAlias})))`,
  );
  patchedSource =
    patchedSource.slice(0, zoomMethod.start) +
    patchedZoomMethod +
    patchedSource.slice(zoomMethod.end);

  const overlaySyncMethod = findMinifiedMethod(
    patchedSource,
    /install[A-Za-z_$][\w$]*TitleBarOverlaySync\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{/,
  );
  if (overlaySyncMethod == null) {
    const completedSource = markLinuxNativeTitlebarPatch(patchedSource);
    if (
      completedSource != null &&
      hasCompleteLinuxNativeTitlebarPatch(completedSource, helperFunctionRegex)
    ) {
      return completedSource;
    }
    console.warn(
      "WARN: Could not complete Linux native titlebar consumers — skipping",
    );
    return currentSource;
  }
  if (overlaySyncMethod.text.includes(`setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(`)) {
    const completedSource = markLinuxNativeTitlebarPatch(patchedSource);
    if (
      completedSource != null &&
      hasCompleteLinuxNativeTitlebarPatch(completedSource, helperFunctionRegex)
    ) {
      return completedSource;
    }
    console.warn(
      "WARN: Could not complete Linux native titlebar consumers — skipping",
    );
    return currentSource;
  }

  const windowAlias = overlaySyncMethod.match[1];
  const overlayCallRegex = new RegExp(
    `${escapeRegExp(windowAlias)}\\.setTitleBarOverlay\\(([A-Za-z_$][\\w$]*)\\(this\\.windowZooms\\.get\\(${escapeRegExp(windowAlias)}\\.id\\)\\)\\)`,
  );
  const overlayCallMatch = overlaySyncMethod.text.match(overlayCallRegex);
  if (overlayCallMatch == null) {
    console.warn("WARN: Could not patch titleBarOverlay nativeTheme sync for Linux");
    return currentSource;
  }

  const windowsOverlayHelperAlias = overlayCallMatch[1];
  const patchedMethod = overlaySyncMethod.text.replace(
    overlayCallRegex,
    `${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(this.windowZooms.get(${windowAlias}.id)):${windowsOverlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))`,
  );
  const completedSource = (
    patchedSource.slice(0, overlaySyncMethod.start) +
    patchedMethod +
    patchedSource.slice(overlaySyncMethod.end)
  );
  const markedSource = markLinuxNativeTitlebarPatch(completedSource);
  if (
    markedSource != null &&
    hasCompleteLinuxNativeTitlebarPatch(markedSource, helperFunctionRegex)
  ) {
    return markedSource;
  }
  console.warn(
    "WARN: Could not complete Linux native titlebar consumers — skipping",
  );
  return currentSource;
}

function applyLinuxMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  const linuxMenuPatchFor = (windowVar) =>
    `process.platform===\`linux\`&&(${windowVar}.on(\`system-context-menu\`,e=>e.preventDefault()),${windowVar}.removeMenu()),`;
  let patchedSource = currentSource
    .replace(
      /process\.platform===`linux`&&\(([A-Za-z_$][\w$]*)\.setMenuBarVisibility\(!1\),\1\.removeMenu\?\.\(\)\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `${linuxMenuPatchFor(windowVar)}process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    )
    .replace(
      /process\.platform===`linux`&&([A-Za-z_$][\w$]*)\.setMenuBarVisibility\(!1\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `${linuxMenuPatchFor(windowVar)}process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    )
    .replace(
      /process\.platform===`linux`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),process\.platform===`win32`&&\1\.removeMenu\(\),/g,
      (_match, windowVar) => `${linuxMenuPatchFor(windowVar)}process.platform===\`win32\`&&${windowVar}.removeMenu(),`,
    );
  let patchedAny = patchedSource !== currentSource;
  patchedSource = patchedSource.replace(menuRegex, (match, windowVar, offset, source) => {
    const linuxPatch = linuxMenuPatchFor(windowVar);
    if (source.slice(Math.max(0, offset - linuxPatch.length), offset) === linuxPatch) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  const hasWindowsRemoveMenu = /process\.platform===`win32`&&[A-Za-z_$][\w$]*\.removeMenu\(\),/.test(patchedSource);
  const hasLinuxRemoveMenu = /process\.platform===`linux`&&\(([A-Za-z_$][\w$]*)\.on\(`system-context-menu`,[A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.preventDefault\(\)\),\1\.removeMenu\(\)\),process\.platform===`win32`&&\1\.removeMenu\(\),/.test(patchedSource);
  if (!patchedAny && hasWindowsRemoveMenu && !hasLinuxRemoveMenu) {
    console.warn("WARN: Could not find window menu visibility snippet — skipping menu patch");
  }

  return patchedSource;
}

function applyLinuxApplicationMenuPatch(currentSource) {
  return currentSource.replace(
    /([A-Za-z_$][\w$]*)\.Menu\.setApplicationMenu\(process\.platform===`linux`\?null:([A-Za-z_$][\w$]*)\)/g,
    (_match, electronAlias, menuAlias) => `${electronAlias}.Menu.setApplicationMenu(${menuAlias})`,
  );
}

function applyLinuxAppReloadShortcutsPatch(currentSource) {
  const patchMarker = "codexLinuxReloadAppWindow";
  if (currentSource.includes(patchMarker)) {
    return currentSource;
  }

  const identifierPattern = "[A-Za-z_$][\\w$]*";
  // Providers are intentionally constrained to static member paths.  This
  // admits both `webContents` and the current `c.webContents` shape without
  // accepting calls, computed members, optional chaining, or expressions.
  const staticProviderPattern =
    `${identifierPattern}(?:\\.${identifierPattern})*`;
  const enabledPattern =
    new RegExp(
      `(${identifierPattern})=(${identifierPattern})!=null&&!\\2\\.isDestroyed\\(\\)&&!!(${identifierPattern})\\(\\2\\)\\?\\.canReloadActiveVisiblePage\\(\\2,(${identifierPattern})\\)`,
      "g",
    );
  const semanticReloadHandlerPattern = new RegExp(
    `(${identifierPattern})=async\\((${identifierPattern})=!1\\)=>\\{let (${identifierPattern})=await (${identifierPattern})\\(\\);if\\(!\\3\\)return;let (${identifierPattern})=(${identifierPattern})\\(\\3\\);if\\(\\5==null\\)return;let (${identifierPattern})=(${staticProviderPattern})\\.getFocusedWebContents\\(\\);if\\(\\2\\)\\{\\5\\.reloadActiveVisiblePageWithOptions\\(\\3,\\{ignoreCache:!0\\},\\7\\);return\\}\\5\\.reloadActiveVisiblePage\\(\\3,\\7\\)\\}`,
    "g",
  );
  const focusedWebContentsProviderPattern = new RegExp(
    `(${identifierPattern})=(${staticProviderPattern})\\.getFocusedWebContents\\(\\)`,
    "g",
  );
  const findFocusedWebContentsProvider = (focusedWebContentsAlias, beforeIndex) => {
    let providerAlias = null;
    for (const match of currentSource
      .slice(0, beforeIndex)
      .matchAll(focusedWebContentsProviderPattern)) {
      if (match[1] === focusedWebContentsAlias) {
        providerAlias = match[2];
      }
    }
    return providerAlias;
  };
  const enabledCandidates = [...currentSource.matchAll(enabledPattern)]
    .map((match) => {
      const [text, enabledAlias, windowAlias, browserSidebarManagerAlias, focusedWebContentsAlias] = match;
      return {
        enabledText: text,
        enabledStart: match.index,
        enabledEnd: match.index + text.length,
        enabledAlias,
        windowAlias,
        browserSidebarManagerAlias,
        focusedWebContentsAlias,
        focusedWebContentsProvider: findFocusedWebContentsProvider(
          focusedWebContentsAlias,
          match.index,
        ),
      };
    })
    .filter((candidate) => candidate.focusedWebContentsProvider != null);
  const reloadHandlers = [...currentSource.matchAll(semanticReloadHandlerPattern)].map(
    (match) => {
      const [
        text,
        reloadHandlerAlias,
        ignoreCacheAlias,
        targetWindowAlias,
        getWindowAlias,
        _browserSidebarManagerResultAlias,
        browserSidebarManagerAlias,
        _focusedWebContentsAlias,
        focusedWebContentsProvider,
      ] = match;
      return {
        handlerText: text,
        handlerStart: match.index,
        handlerEnd: match.index + text.length,
        reloadHandlerAlias,
        ignoreCacheAlias,
        targetWindowAlias,
        getWindowAlias,
        browserSidebarManagerAlias,
        focusedWebContentsProvider,
      };
    },
  );
  const reloadCandidates = enabledCandidates.flatMap((enabledCandidate) =>
    reloadHandlers
      .filter(
        (handler) =>
          handler.browserSidebarManagerAlias === enabledCandidate.browserSidebarManagerAlias &&
          handler.focusedWebContentsProvider ===
            enabledCandidate.focusedWebContentsProvider,
      )
      .map((handler) => ({ ...enabledCandidate, ...handler })),
  );

  if (reloadCandidates.length !== 1) {
    console.warn("WARN: Could not find native browser reload menu actions — skipping Linux app reload shortcut patch");
    return currentSource;
  }

  const {
    enabledText,
    enabledStart,
    enabledEnd,
    handlerText,
    handlerStart,
    handlerEnd,
    enabledAlias,
    windowAlias,
    browserSidebarManagerAlias,
    focusedWebContentsAlias,
    reloadHandlerAlias,
    ignoreCacheAlias,
    targetWindowAlias,
    getWindowAlias,
  } = reloadCandidates[0];
  const enabledReplacement =
    `${enabledAlias}=process.platform===\`linux\`||${windowAlias}!=null&&!${windowAlias}.isDestroyed()&&!!${browserSidebarManagerAlias}(${windowAlias})?.canReloadActiveVisiblePage(${windowAlias},${focusedWebContentsAlias})`;
  const handlerPrefix =
    `${reloadHandlerAlias}=async(${ignoreCacheAlias}=!1)=>{let ${targetWindowAlias}=await ${getWindowAlias}();if(!${targetWindowAlias})return;`;
  const handlerReplacement = handlerText.replace(
    handlerPrefix,
    `${handlerPrefix}if(process.platform===\`linux\`){let ${patchMarker}=${targetWindowAlias}.webContents;if(${ignoreCacheAlias}){${patchMarker}.reloadIgnoringCache();return}${targetWindowAlias}.reload();return}`,
  );

  return [
    { start: enabledStart, end: enabledEnd, replacement: enabledReplacement },
    { start: handlerStart, end: handlerEnd, replacement: handlerReplacement },
  ]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (source, { start, end, replacement }) =>
        source.slice(0, start) + replacement + source.slice(end),
      currentSource,
    );
}

function applyLinuxSetIconPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  const readyRegex = /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(readyRegex, (match, windowVar, offset) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setIcon(${iconPathExpression}),`;
    const prefix = currentSource.slice(Math.max(0, offset - Math.max(400, linuxPatch.length * 2)), offset);
    if (prefix.includes(linuxPatch)) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (patchedAny) {
    return patchedSource;
  }

  if (currentSource.includes(`setIcon(${iconPathExpression})`)) {
    return currentSource;
  }

  console.warn("WARN: Could not find window setIcon insertion point — skipping setIcon patch");
  return currentSource;
}

function applyLinuxReadyToShowWindowStatePatch(currentSource) {
  const alreadyPatchedRegex =
    /[A-Za-z_$][\w$]*&&[A-Za-z_$][\w$]*\.once\(`ready-to-show`,\(\)=>\{[A-Za-z_$][\w$]*\.isDestroyed\(\)\|\|[A-Za-z_$][\w$]*\.maximize\(\)\}\)/;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  const readyToShowMaximizeRegex =
    /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{\1\.isDestroyed\(\)\|\|\1\.maximize\(\)\}\)/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(readyToShowMaximizeRegex, (_match, windowVar, offset, source) => {
    const prefix = source.slice(Math.max(0, offset - 120), offset);
    const maximizedStateMatch = prefix.match(/([A-Za-z_$][\w$]*)&&process\.platform===`linux`&&[A-Za-z_$][\w$]*\.setIcon\(/);
    const maximizedStateVar = maximizedStateMatch?.[1] ?? "false";
    patchedAny = true;
    return `${maximizedStateVar}&&${windowVar}.once(\`ready-to-show\`,()=>{${windowVar}.isDestroyed()||${windowVar}.maximize()})`;
  });

  if (patchedAny) {
    return patchedSource;
  }

  if (currentSource.includes("ready-to-show") && currentSource.includes(".maximize()")) {
    console.warn("WARN: Could not find ready-to-show maximize hook — skipping Linux window-state patch");
  }

  return currentSource;
}

function applyLinuxResizeRepaintPatch(currentSource) {
  const helperName = "codexLinuxInstallResizeRepaintHook";
  const helper =
    "function codexLinuxInstallResizeRepaintHook(e){if(!(process.platform===`linux`)||e.__codexLinuxResizeRepaintHookInstalled)return;e.__codexLinuxResizeRepaintHookInstalled=!0;let __codexResizeRepaintScheduled=!1,__codexResizeRepaint=()=>{__codexResizeRepaintScheduled||(__codexResizeRepaintScheduled=!0,setTimeout(()=>{if(__codexResizeRepaintScheduled=!1,e.isDestroyed())return;let __codexWebContents=e.webContents;__codexWebContents==null||__codexWebContents.isDestroyed?.()||typeof __codexWebContents.invalidate==`function`&&__codexWebContents.invalidate()},16))};e.on(`resize`,__codexResizeRepaint),e.on(`resized`,__codexResizeRepaint)}";
  const readyToShowRegex =
    /(^|[^A-Za-z0-9_$])((?:[A-Za-z_$][\w$]*&&)?)([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(
    readyToShowRegex,
    (match, leading, guardPrefix, windowVar, offset, source) => {
      const linuxPatch = `process.platform===\`linux\`&&${helperName}(${windowVar}),`;
      const insertionPoint = offset + leading.length;
      const prefix = source.slice(Math.max(0, insertionPoint - Math.max(400, linuxPatch.length * 2)), insertionPoint);
      if (prefix.includes(linuxPatch)) {
        return match;
      }
      patchedAny = true;
      return `${leading}${linuxPatch}${guardPrefix}${windowVar}.once(\`ready-to-show\`,()=>{`;
    },
  );

  if (!patchedAny) {
    if (currentSource.includes(`${helperName}(`)) {
      return currentSource;
    }
    if (currentSource.includes("ready-to-show")) {
      console.warn("WARN: Could not find ready-to-show hook — skipping Linux resize repaint patch");
    }
    return currentSource;
  }

  if (patchedSource.includes(`function ${helperName}(`)) {
    return patchedSource;
  }

  for (const prefix of ['"use strict";', "'use strict';"]) {
    if (patchedSource.startsWith(prefix)) {
      return `${prefix}${helper}${patchedSource.slice(prefix.length)}`;
    }
  }

  return `${helper}${patchedSource}`;
}

function applyLinuxOpaqueBackgroundPatch(currentSource) {
  const shouldAlwaysOpaqueSurfaceRegex =
    /shouldAlwaysUseOpaqueWindowSurface\(([A-Za-z_$][\w$]*)\)\{return\s*([A-Za-z_$][\w$]*)\(\{appearance:\1,opaqueWindowsEnabled:this\.isOpaqueWindowsEnabled\(\),platform:process\.platform\}\)\|\|!([A-Za-z_$][\w$]*)\(\)&&!([A-Za-z_$][\w$]*)\(\1\)\}/u;
  const patchedShouldAlwaysOpaqueSurfaceRegex =
    /shouldAlwaysUseOpaqueWindowSurface\(([A-Za-z_$][\w$]*)\)\{return\s*process\.platform===`linux`&&!([A-Za-z_$][\w$]*)\(\1\)\|\|([A-Za-z_$][\w$]*)\(\{appearance:\1,opaqueWindowsEnabled:this\.isOpaqueWindowsEnabled\(\),platform:process\.platform\}\)\|\|!([A-Za-z_$][\w$]*)\(\)&&!\2\(\1\)\}/u;
  const shouldAlwaysOpaqueSurfaceMatch = currentSource.match(shouldAlwaysOpaqueSurfaceRegex);
  const shouldAlwaysOpaqueSurfaceReady =
    shouldAlwaysOpaqueSurfaceMatch != null ||
    patchedShouldAlwaysOpaqueSurfaceRegex.test(currentSource);

  if (!shouldAlwaysOpaqueSurfaceReady) {
    console.warn("WARN: Could not find opaque surface mode predicate — skipping Linux opaque surface patch");
  }

  const opaqueWindowSurfaceFunctionRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowSurfaceEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*(?:\2===`avatarOverlay`\?\{backgroundColor:`#00000000`,backgroundMaterial:null\}:)?\3\?\{backgroundColor:\4\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),backgroundMaterial:\1===`win32`\?`none`:null\}:\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)\?/;
  const patchedOpaqueWindowSurfaceFunctionRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowSurfaceEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*(?:\2===`avatarOverlay`\?\{backgroundColor:`#00000000`,backgroundMaterial:null\}:)?\3\?\{backgroundColor:\4\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),backgroundMaterial:\1===`win32`\?`none`:null\}:\1===`linux`&&!([A-Za-z_$][\w$]*)\(\2\)\?\{backgroundColor:\4\?\5:\6,backgroundMaterial:null\}:\1===`win32`&&!\7\(\2\)\?/;
  const opaqueWindowSurfaceFunctionMatch = currentSource.match(
    opaqueWindowSurfaceFunctionRegex,
  );
  const opaqueWindowSurfaceFunctionReady =
    opaqueWindowSurfaceFunctionMatch != null ||
    patchedOpaqueWindowSurfaceFunctionRegex.test(currentSource);

  if (!opaqueWindowSurfaceFunctionReady) {
    console.warn("WARN: Could not find BrowserWindow background function signature — skipping background patch");
  }

  if (!shouldAlwaysOpaqueSurfaceReady || !opaqueWindowSurfaceFunctionReady) {
    return currentSource;
  }

  let patchedSource = currentSource;
  if (shouldAlwaysOpaqueSurfaceMatch != null) {
    const [
      match,
      appearanceParam,
      opaqueSurfaceHelper,
      nativeSurfaceCapabilityHelper,
      transparentAppearancePredicate,
    ] = shouldAlwaysOpaqueSurfaceMatch;
    const replacement =
      `shouldAlwaysUseOpaqueWindowSurface(${appearanceParam}){return process.platform===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})||${opaqueSurfaceHelper}({appearance:${appearanceParam},opaqueWindowsEnabled:this.isOpaqueWindowsEnabled(),platform:process.platform})||!${nativeSurfaceCapabilityHelper}()&&!${transparentAppearancePredicate}(${appearanceParam})}`;
    patchedSource = patchedSource.replace(match, replacement);
  }

  if (opaqueWindowSurfaceFunctionMatch == null) {
    return patchedSource;
  }

  const [
    ,
    platformParam,
    appearanceParam,
    ,
    darkColorsParam,
    darkBackground,
    lightBackground,
    transparentAppearancePredicate,
  ] = opaqueWindowSurfaceFunctionMatch;
  const win32Needle =
    `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
  const linuxBackground =
    `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkBackground}:${lightBackground},backgroundMaterial:null}:`;

  if (!patchedSource.includes(win32Needle)) {
    console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
    return patchedSource;
  }
  return patchedSource.replace(
    win32Needle,
    `${linuxBackground}${win32Needle.slice(1)}`,
  );
}

module.exports = {
  applyLinuxAppReloadShortcutsPatch,
  applyLinuxApplicationMenuPatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxSetIconPatch,
  applyLinuxWindowOptionsPatch,
};
