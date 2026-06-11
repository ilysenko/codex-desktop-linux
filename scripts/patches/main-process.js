"use strict";

const {
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findCallBlock,
  findMatchingBrace,
  inferModuleAlias,
  requireName,
} = require("./shared.js");

const LINUX_TITLEBAR_OVERLAY_HEIGHT = 30;
const LINUX_TITLEBAR_OVERLAY_HELPER = "codexLinuxTitleBarOverlay";

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
function applyLinuxFileManagerPatch(currentSource) {
  const block = findCallBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  if (block.text.includes("linux:{")) {
    return currentSource;
  }

  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (electronVar == null || fsVar == null || pathVar == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{let __codexResolved=e;for(;;){if((0,${fsVar}.existsSync)(__codexResolved))break;let __codexParent=(0,${pathVar}.dirname)(__codexResolved);if(__codexParent===__codexResolved){__codexResolved=null;break}__codexResolved=__codexParent}let __codexOpenTarget=__codexResolved??e;if((0,${fsVar}.existsSync)(__codexOpenTarget)&&(0,${fsVar}.statSync)(__codexOpenTarget).isFile())__codexOpenTarget=(0,${pathVar}.dirname)(__codexOpenTarget);let __codexError=await ${electronVar}.shell.openPath(__codexOpenTarget);if(__codexError)throw Error(__codexError)}}`;

  const patchedBlock =
    block.text.slice(0, insertionPoint + 1) +
    linuxFileManager +
    block.text.slice(insertionPoint + 1);
  const patchedSource =
    currentSource.slice(0, block.start) + patchedBlock + currentSource.slice(block.end);

  const patchedBlockCheck = patchedSource.slice(block.start, block.start + patchedBlock.length);
  if (
    !patchedBlockCheck.includes("linux:{label:`File Manager`") ||
    !patchedBlockCheck.includes("detect:()=>`linux-file-manager`") ||
    !patchedBlockCheck.includes(`${electronVar}.shell.openPath(__codexOpenTarget)`)
  ) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  return patchedSource;
}

function applyLinuxWindowOptionsPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  const iconPathNeedle = `icon:${iconPathExpression}`;

  const windowOptionsNeedle = "...process.platform===`win32`?{autoHideMenuBar:!0}:{},";
  const legacyLinuxSystemTitlebarNeedle =
    `...process.platform===\`win32\`||process.platform===\`linux\`?{autoHideMenuBar:!0,...process.platform===\`linux\`?{${iconPathNeedle}}:{}}:{},`;
  const windowOptionsReplacement =
    `...process.platform===\`win32\`?{autoHideMenuBar:!0}:process.platform===\`linux\`?{${iconPathNeedle}}:{},`;

  let patchedSource = currentSource;
  if (patchedSource.includes(legacyLinuxSystemTitlebarNeedle)) {
    patchedSource = patchedSource.split(legacyLinuxSystemTitlebarNeedle).join(windowOptionsReplacement);
  }

  if (patchedSource.includes(windowOptionsNeedle)) {
    return patchedSource.split(windowOptionsNeedle).join(windowOptionsReplacement);
  }

  if (patchedSource !== currentSource || patchedSource.includes(iconPathNeedle)) {
    return patchedSource;
  }

  console.warn("WARN: Could not find BrowserWindow autoHideMenuBar snippet — skipping window options patch");
  return currentSource;
}

function applyLinuxNativeTitlebarPatch(currentSource) {
  const patchedPrimaryTitlebarRegex = new RegExp(
    `===\`linux\`\\?\\{titleBarStyle:\`hidden\`,titleBarOverlay:${LINUX_TITLEBAR_OVERLAY_HELPER}\\(([A-Za-z_$][\\w$]*)\\)\\}`,
  );
  const alreadyPatchedTitlebarMatch = currentSource.match(patchedPrimaryTitlebarRegex);
  const helperFunctionRegex = new RegExp(
    'function ' +
      escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER) +
      '\\([^)]*\\)\\{return\\{color:([A-Za-z_$][\\w$]*)\\.nativeTheme\\.shouldUseDarkColors\\?`#111111`:([A-Za-z_$][\\w$]*),symbolColor:\\1\\.nativeTheme\\.shouldUseDarkColors\\?([A-Za-z_$][\\w$]*):([A-Za-z_$][\\w$]*),height:Math\\.round\\(' +
      LINUX_TITLEBAR_OVERLAY_HEIGHT +
      '\\*[A-Za-z_$][\\w$]*\\)\\}\\}',
  );
  const helperFunctionMatch = currentSource.match(helperFunctionRegex);

  const primaryTitlebarRegex =
    /case`primary`:return ([A-Za-z_$][\w$]*)===`darwin`\?([A-Za-z_$][\w$]*)\?\{titleBarStyle:`hiddenInset`,trafficLightPosition:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\}:\{vibrancy:`menu`,titleBarStyle:`hiddenInset`,trafficLightPosition:\3\(\4\)\}:\1===`win32`(\|\|\1===`linux`)?\?\{titleBarStyle:`hidden`,titleBarOverlay:([A-Za-z_$][\w$]*)\(\4\)\}:\{titleBarStyle:`default`\};/g;
  const primaryTitlebarMatch = primaryTitlebarRegex.exec(currentSource);
  if (primaryTitlebarMatch == null && alreadyPatchedTitlebarMatch == null) {
    console.warn("WARN: Could not find primary BrowserWindow titlebar snippet — skipping Linux native titlebar patch");
    return currentSource;
  }

  let patchedSource = currentSource;
  let electronAlias;
  let lightSymbolAlias;
  let darkSymbolAlias;
  let lightBackgroundAlias;

  if (primaryTitlebarMatch != null) {
    const [, platformAlias, opaqueWindowsAlias, trafficLightAlias, zoomAlias, , overlayHelperAlias] = primaryTitlebarMatch;
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

    [, electronAlias, lightSymbolAlias, darkSymbolAlias] = overlayHelperMatch;
    [, , , , lightBackgroundAlias] = linuxBackgroundMatch;
    const replacement =
      `case\`primary\`:return ${platformAlias}===\`darwin\`?${opaqueWindowsAlias}?{titleBarStyle:\`hiddenInset\`,trafficLightPosition:${trafficLightAlias}(${zoomAlias})}:{vibrancy:\`menu\`,titleBarStyle:\`hiddenInset\`,trafficLightPosition:${trafficLightAlias}(${zoomAlias})}:${platformAlias}===\`win32\`?{titleBarStyle:\`hidden\`,titleBarOverlay:${overlayHelperAlias}(${zoomAlias})}:${platformAlias}===\`linux\`?{titleBarStyle:\`hidden\`,titleBarOverlay:${LINUX_TITLEBAR_OVERLAY_HELPER}(${zoomAlias})}:{titleBarStyle:\`default\`};`;

    primaryTitlebarRegex.lastIndex = 0;
    patchedSource = patchedSource.replace(primaryTitlebarRegex, replacement);
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
  } else if (helperFunctionMatch != null) {
    [, electronAlias, lightBackgroundAlias, lightSymbolAlias, darkSymbolAlias] = helperFunctionMatch;
  } else {
    console.warn("WARN: Could not derive Linux titleBarOverlay helper aliases — skipping Linux native titlebar patch");
    return currentSource;
  }

  if (
    patchedSource.includes("process.platform!==`win32`&&process.platform!==`linux`") &&
    new RegExp(
      `setTitleBarOverlay\\(process\\.platform===\`linux\`\\?${escapeRegExp(LINUX_TITLEBAR_OVERLAY_HELPER)}\\(`,
    ).test(patchedSource)
  ) {
    return patchedSource;
  }

  const escapedElectronAlias = escapeRegExp(electronAlias);
  const overlaySyncRegex = new RegExp(
    "installWindowsTitleBarOverlaySync\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\)\\{if\\(process\\.platform!==`win32`\\|\\|\\2!==`primary`\\)return;let ([A-Za-z_$][\\w$]*)=\\(\\)=>\\{\\1\\.isDestroyed\\(\\)\\|\\|\\1\\.setTitleBarOverlay\\(([A-Za-z_$][\\w$]*)\\(this\\.windowZooms\\.get\\(\\1\\.id\\)\\)\\)\\};return " +
      escapedElectronAlias +
      "\\.nativeTheme\\.on\\(`updated`,\\3\\),\\3\\(\\),\\(\\)=>\\{" +
      escapedElectronAlias +
      "\\.nativeTheme\\.off\\(`updated`,\\3\\)\\}\\}",
  );
  let overlaySyncMatch = patchedSource.match(overlaySyncRegex);
  let overlaySyncReplacementRegex = overlaySyncRegex;
  if (overlaySyncMatch == null) {
    const existingLinuxOverlaySyncRegex = new RegExp(
      "installWindowsTitleBarOverlaySync\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\)\\{if\\(\\(process\\.platform!==`win32`&&process\\.platform!==`linux`\\)\\|\\|\\2!==`primary`\\)return;let ([A-Za-z_$][\\w$]*)=\\(\\)=>\\{\\1\\.isDestroyed\\(\\)\\|\\|\\1\\.setTitleBarOverlay\\(process\\.platform===`linux`\\?\\{color:" +
        escapedElectronAlias +
        "\\.nativeTheme\\.shouldUseDarkColors\\?[A-Za-z_$][\\w$]*:[A-Za-z_$][\\w$]*,symbolColor:" +
        escapedElectronAlias +
        "\\.nativeTheme\\.shouldUseDarkColors\\?[A-Za-z_$][\\w$]*:[A-Za-z_$][\\w$]*,height:Math\\.round\\((?:[A-Za-z_$][\\w$]*|\\d+(?:\\.\\d+)?)\\*this\\.windowZooms\\.get\\(\\1\\.id\\)\\)\\}:([A-Za-z_$][\\w$]*)\\(this\\.windowZooms\\.get\\(\\1\\.id\\)\\)\\)\\};return " +
        escapedElectronAlias +
        "\\.nativeTheme\\.on\\(`updated`,\\3\\),\\3\\(\\),\\(\\)=>\\{" +
        escapedElectronAlias +
        "\\.nativeTheme\\.off\\(`updated`,\\3\\)\\}\\}",
    );
    overlaySyncMatch = patchedSource.match(existingLinuxOverlaySyncRegex);
    overlaySyncReplacementRegex = existingLinuxOverlaySyncRegex;
  }
  if (overlaySyncMatch == null) {
    if (patchedSource.includes("installWindowsTitleBarOverlaySync")) {
      console.warn("WARN: Could not patch titleBarOverlay nativeTheme sync for Linux");
    }
    return patchedSource;
  }

  const [, windowAlias, windowTypeAlias, updateAlias, windowsOverlayHelperAlias] = overlaySyncMatch;
  const overlaySyncReplacement =
    `installWindowsTitleBarOverlaySync(${windowAlias},${windowTypeAlias}){if((process.platform!==\`win32\`&&process.platform!==\`linux\`)||${windowTypeAlias}!==\`primary\`)return;let ${updateAlias}=()=>{${windowAlias}.isDestroyed()||${windowAlias}.setTitleBarOverlay(process.platform===\`linux\`?${LINUX_TITLEBAR_OVERLAY_HELPER}(this.windowZooms.get(${windowAlias}.id)):${windowsOverlayHelperAlias}(this.windowZooms.get(${windowAlias}.id)))};return ${electronAlias}.nativeTheme.on(\`updated\`,${updateAlias}),${updateAlias}(),()=>{${electronAlias}.nativeTheme.off(\`updated\`,${updateAlias})}}`;
  const replacedSource = patchedSource.replace(overlaySyncReplacementRegex, overlaySyncReplacement);
  if (replacedSource !== patchedSource) {
    return replacedSource;
  }

  const methodDefinitionRegex = /installWindowsTitleBarOverlaySync\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{if\(/g;
  let methodStart = -1;
  for (const match of patchedSource.matchAll(methodDefinitionRegex)) {
    methodStart = match.index;
  }
  const methodEndMarker = "}isOpaqueWindowsEnabled(){";
  const methodEnd = methodStart === -1 ? -1 : patchedSource.indexOf(methodEndMarker, methodStart);
  if (methodEnd !== -1) {
    return patchedSource.slice(0, methodStart) + overlaySyncReplacement + patchedSource.slice(methodEnd + 1);
  }

  return patchedSource;
}

function applyLinuxMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(menuRegex, (match, windowVar, offset) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setMenuBarVisibility(!1),`;
    if (currentSource.slice(Math.max(0, offset - linuxPatch.length), offset) === linuxPatch) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (!patchedAny && !currentSource.includes("setMenuBarVisibility(!1)")) {
    const hasWindowsRemoveMenu = /process\.platform===`win32`&&[A-Za-z_$][\w$]*\.removeMenu\(\),/.test(currentSource);
    if (hasWindowsRemoveMenu) {
      console.warn("WARN: Could not find window menu visibility snippet — skipping menu patch");
    }
  }

  return patchedSource;
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
  let patchedSource = currentSource;
  const shouldAlwaysOpaqueSurfaceRegex =
    /shouldAlwaysUseOpaqueWindowSurface\(([A-Za-z_$][\w$]*)\)\{return\s*([A-Za-z_$][\w$]*)\(\{appearance:\1,opaqueWindowsEnabled:this\.isOpaqueWindowsEnabled\(\),platform:process\.platform\}\)\|\|!([A-Za-z_$][\w$]*)\(\)&&!([A-Za-z_$][\w$]*)\(\1\)\}/u;
  const shouldAlwaysOpaqueSurfaceMatch = patchedSource.match(shouldAlwaysOpaqueSurfaceRegex);
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
  } else if (
    /shouldAlwaysUseOpaqueWindowSurface\([A-Za-z_$][\w$]*\)\{return\s*process\.platform===`linux`&&!/.test(patchedSource)
  ) {
    // Already patched.
  } else if (patchedSource.includes("shouldAlwaysUseOpaqueWindowSurface(")) {
    console.warn("WARN: Could not find opaque surface mode predicate — skipping Linux opaque surface patch");
  }

  if (
    patchedSource.includes("===`linux`&&!OM(") ||
    /===`linux`&&![A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\?\{backgroundColor:[^{}]+,backgroundMaterial:null\}/.test(patchedSource)
  ) {
    return patchedSource;
  }

  const colorConstRegex =
    /([A-Za-z_$][\w$]*)=`#00000000`,([A-Za-z_$][\w$]*)=`#000000`,([A-Za-z_$][\w$]*)=`#f9f9f9`/;
  const colorMatch = patchedSource.match(colorConstRegex);

  if (!colorMatch) {
    console.warn(
      "WARN: Could not find color constants (#00000000, #000000, #f9f9f9) — skipping background patch",
    );
    return patchedSource;
  }

  const [, transparentVar, darkVar, lightVar] = colorMatch;

  const currentFuncParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\3&&!([A-Za-z_$][\w$]*)\(\2\)&&\(\1===`darwin`\|\|\1===`win32`\)\?/;
  const currentFuncMatch = patchedSource.match(currentFuncParamRegex);
  if (currentFuncMatch != null) {
    const [, platformParam, appearanceParam, , darkColorsParam, transparentAppearancePredicate] =
      currentFuncMatch;
    const win32Needle =
      `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
    const linuxBgPrefix =
      `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:`;

    if (patchedSource.includes(linuxBgPrefix)) {
      return patchedSource;
    }
    if (patchedSource.includes(win32Needle)) {
      return patchedSource.replace(win32Needle, `${linuxBgPrefix}${win32Needle.slice(1)}`);
    }

    console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
    return patchedSource;
  }

  const currentSurfaceFuncParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowSurfaceEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\3\?\{backgroundColor:\4\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*),backgroundMaterial:\1===`win32`\?`none`:null\}:\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)\?/;
  const currentSurfaceFuncMatch = patchedSource.match(currentSurfaceFuncParamRegex);
  if (currentSurfaceFuncMatch != null) {
    const [, platformParam, appearanceParam, , darkColorsParam, darkVarFromReturn, lightVarFromReturn, transparentAppearancePredicate] =
      currentSurfaceFuncMatch;
    const win32Needle =
      `:${platformParam}===\`win32\`&&!${transparentAppearancePredicate}(${appearanceParam})?`;
    const linuxBgPrefix =
      `:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVarFromReturn}:${lightVarFromReturn},backgroundMaterial:null}:`;

    if (patchedSource.includes(linuxBgPrefix)) {
      return patchedSource;
    }
    if (patchedSource.includes(win32Needle)) {
      return patchedSource.replace(win32Needle, `${linuxBgPrefix}${win32Needle.slice(1)}`);
    }

    console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
    return patchedSource;
  }

  const funcParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:[A-Za-z_$][\w$]*,prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)/;
  const funcMatch = patchedSource.match(funcParamRegex);

  if (funcMatch == null) {
    console.warn("WARN: Could not find BrowserWindow background function signature — skipping background patch");
    return patchedSource;
  }

  const [, platformParam, appearanceParam, darkColorsParam, transparentAppearancePredicate] =
    funcMatch;
  const bgNeedle =
    `backgroundMaterial:\`mica\`}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const oldLinuxBgPatch =
    `backgroundMaterial:\`mica\`}:process.platform===\`linux\`?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const bgReplacement =
    `backgroundMaterial:\`mica\`}:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;

  if (patchedSource.includes(bgNeedle)) {
    return patchedSource.replace(bgNeedle, bgReplacement);
  }
  if (patchedSource.includes(oldLinuxBgPatch)) {
    return patchedSource.replace(oldLinuxBgPatch, bgReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
  return patchedSource;
}

function applyLinuxAboutDialogPatch(currentSource, iconPathExpression) {
  if (!currentSource.includes("codex.aboutDialog.title")) {
    return currentSource;
  }

  const alreadyUsesBundledIcon =
    iconPathExpression != null &&
    currentSource.includes(`nativeImage.createFromPath(${iconPathExpression})`);
  const aboutHtmlIconNullSafeRegex =
    /[A-Za-z_$][\w$]*==null\|\|([A-Za-z_$][\w$]*)\.isEmpty\(\)\?null:\1\.resize\(/;
  const aboutWindowIconNullSafeRegex =
    /\.\.\.([A-Za-z_$][\w$]*)\.windowIcon==null\|\|\1\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:\1\.windowIcon\}/;
  const alreadyNullSafe =
    aboutWindowIconNullSafeRegex.test(currentSource) &&
    aboutHtmlIconNullSafeRegex.test(currentSource) &&
    /windowIcon:[A-Za-z_$][\w$]*\?\?null\}/.test(currentSource);
  if (alreadyUsesBundledIcon && alreadyNullSafe) {
    return currentSource;
  }

  let patchedSource = currentSource;
  if (iconPathExpression != null) {
    const aboutIconPromiseRegex =
      /\[([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\(([^()]+)\):null,([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:process\.platform===`win32`\?`large`:`normal`\}\)\]/;
    patchedSource = patchedSource.replace(
      aboutIconPromiseRegex,
      `[
process.platform===\`linux\`?null:$1?$2($3):null,
process.platform===\`linux\`?Promise.resolve((()=>{let __codexLinuxAboutIcon=$4.nativeImage.createFromPath(${iconPathExpression});return __codexLinuxAboutIcon.isEmpty()?null:__codexLinuxAboutIcon})()):$4.app.getFileIcon($5,{size:process.platform===\`win32\`?\`large\`:\`normal\`}).catch(()=>null)
]`,
    );
  } else {
    const patchedGetFileIconRegex =
      /([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:process\.platform===`win32`\?`large`:`normal`\}\)\.catch\(\(\)=>null\)/;
    if (!patchedGetFileIconRegex.test(patchedSource)) {
      const getFileIconRegex =
        /([A-Za-z_$][\w$]*)\.app\.getFileIcon\(([^()]+),\{size:process\.platform===`win32`\?`large`:`normal`\}\)/;
      patchedSource = patchedSource.replace(
        getFileIconRegex,
        "$1.app.getFileIcon($2,{size:process.platform===`win32`?`large`:`normal`}).catch(()=>null)",
      );
    }
  }

  patchedSource = patchedSource
    .replace(
      /([A-Za-z_$][\w$]*)\.isEmpty\(\)\?null:\1\.resize\(/g,
      "$1==null||$1.isEmpty()?null:$1.resize(",
    )
    .replace(/windowIcon:([A-Za-z_$][\w$]*)\}/g, "windowIcon:$1??null}")
    .replace(
      /\.\.\.([A-Za-z_$][\w$]*)\.windowIcon\.isEmpty\(\)\?\{\}:\{icon:\1\.windowIcon\}/g,
      "...$1.windowIcon==null||$1.windowIcon.isEmpty()?{}:{icon:$1.windowIcon}",
    );

  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  console.warn("WARN: Could not patch About dialog icon fallback for Linux");
  return currentSource;
}

function findNamedFunctionBody(source, functionName) {
  const functionMatch = source.match(
    new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\([^)]*\\)\\{`),
  );
  if (functionMatch == null) {
    return null;
  }

  const openIndex = functionMatch.index + functionMatch[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  return closeIndex === -1 ? null : source.slice(openIndex, closeIndex + 1);
}

function isTrayFactoryFunction(source, functionName) {
  const body = findNamedFunctionBody(source, functionName);
  return body != null && /new [A-Za-z_$][\w$]*\.Tray\(/.test(body);
}

function findDynamicTraySetup(source) {
  const setupRegex =
    /let ([A-Za-z_$][\w$]*)=async\(\)=>\{[A-Za-z_$][\w$]*=!0;try\{await ([A-Za-z_$][\w$]*)\(\{buildFlavor:/g;
  let match;
  while ((match = setupRegex.exec(source)) != null) {
    const [, setupFn, factoryFn] = match;
    if (isTrayFactoryFunction(source, factoryFn)) {
      return { setupFn, factoryFn, index: match.index };
    }
  }
  return null;
}

function findDynamicTrayStartupCall(source, setupFn, startIndex) {
  const startupRegex = new RegExp(`([A-Za-z_$][\\w$]*)&&${escapeRegExp(setupFn)}\\(\\);`, "g");
  startupRegex.lastIndex = startIndex;
  return startupRegex.exec(source);
}

function addDynamicTraySetupFailureLogging(source, traySetup) {
  const logMessage = "[codex-linux] Failed to set up system tray";
  if (traySetup == null || source.includes(logMessage)) {
    return source;
  }

  const openIndex = source.indexOf("{", traySetup.index);
  if (openIndex === -1) {
    return source;
  }
  const closeIndex = findMatchingBrace(source, openIndex);
  if (closeIndex === -1) {
    return source;
  }

  const body = source.slice(openIndex, closeIndex + 1);
  if (!body.includes(`await ${traySetup.factoryFn}(`)) {
    return source;
  }

  const catchRegex = /catch\(([A-Za-z_$][\w$]*)\)\{/;
  const catchMatch = body.match(catchRegex);
  if (catchMatch == null) {
    return source;
  }

  const [, errorVar] = catchMatch;
  const catchOpenIndex = catchMatch.index + catchMatch[0].length - 1;
  const catchCloseIndex = findMatchingBrace(body, catchOpenIndex);
  if (catchCloseIndex === -1) {
    return source;
  }

  const catchBody = body.slice(catchOpenIndex + 1, catchCloseIndex);
  const separator = catchBody.trim().length === 0 || /[;,]$/.test(catchBody.trim()) ? "" : ";";
  const linuxWarning = `${separator}process.platform===\`linux\`&&console.warn(\`${logMessage}\`,${errorVar})`;
  const patchedBody =
    `${body.slice(0, catchCloseIndex)}${linuxWarning}${body.slice(catchCloseIndex)}`;
  return `${source.slice(0, openIndex)}${patchedBody}${source.slice(closeIndex + 1)}`;
}

function applyLinuxQuitGuardPatch(currentSource) {
  let patchedSource = currentSource;

  const quitGuardNeedle = "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);";
  const legacyQuitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxExplicitQuitApproved=!1,codexLinuxExplicitQuitDrainTimeoutMs=3e3,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()},codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0,codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardPatch = `${quitGuardNeedle}${quitGuardSuffix}`;

  if (patchedSource.includes("codexLinuxExplicitQuitApproved=!1")) {
    return patchedSource;
  }

  if (patchedSource.includes(legacyQuitGuardSuffix)) {
    return patchedSource.replace(legacyQuitGuardSuffix, quitGuardSuffix);
  }

  if (patchedSource.includes(quitGuardNeedle)) {
    return patchedSource.replace(quitGuardNeedle, quitGuardPatch);
  }

  const splitQuitGuardNeedle =
    /let ([A-Za-z_$][\w$]*)=require\(`electron`\);(?:\1=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:path`\);(?:\2=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:fs`\);(?:\3=[^;]+;)?/;
  const splitQuitGuardMatch = patchedSource.match(splitQuitGuardNeedle);
  if (splitQuitGuardMatch != null) {
    const matchedPrefix = splitQuitGuardMatch[0];
    return patchedSource.replace(matchedPrefix, `${matchedPrefix}${quitGuardSuffix}`);
  }

  if (patchedSource.includes("require(`electron`)")) {
    return `${quitGuardSuffix}${patchedSource}`;
  }

  if (patchedSource.includes("require(`electron`)") && patchedSource.includes("require(`node:path`)")) {
    console.warn("WARN: Could not find Linux quit guard insertion point — skipping explicit quit-state patch");
  }

  return patchedSource;
}

function linuxExplicitQuitExpression() {
  return "typeof codexLinuxPrepareForExplicitQuit===`function`?codexLinuxPrepareForExplicitQuit():typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";
}

function applyLinuxWillQuitDrainTimeoutPatch(currentSource) {
  let patchedSource = currentSource;

  const explicitQuitDrainGuard =
    "process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())";
  const originalDrainSnippet =
    "Promise.all([...u.values()].map(e=>e.flush())).finally(()=>{d(),f.dispose(),n.app.quit()})";
  const patchedDrainSnippet =
    "(()=>{let codexLinuxFinalizeQuit=()=>{d(),f.dispose(),n.app.quit()},codexLinuxDrainPromise=Promise.all([...u.values()].map(e=>e.flush()));" +
    `if(${explicitQuitDrainGuard}){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}` +
    "codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()";
  let patchedAny = false;

  if (patchedSource.includes(originalDrainSnippet)) {
    patchedAny = true;
    patchedSource = patchedSource.split(originalDrainSnippet).join(patchedDrainSnippet);
  }

  const drainRegex =
    /Promise\.all\(\[\.\.\.([A-Za-z_$][\w$]*)\.values\(\)\]\.map\(e=>e\.flush\(\)\)\)\.finally\(\(\)=>\{([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)\.dispose\(\),([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\)/g;
  patchedSource = patchedSource.replace(
    drainRegex,
    (_match, globalStatesVar, flushDisposeVar, disposablesVar, electronVar) => {
      patchedAny = true;
      return `(()=>{let codexLinuxFinalizeQuit=()=>{${flushDisposeVar}(),${disposablesVar}.dispose(),${electronVar}.app.quit()},codexLinuxDrainPromise=Promise.all([...${globalStatesVar}.values()].map(e=>e.flush()));if(${explicitQuitDrainGuard}){Promise.race([codexLinuxDrainPromise,new Promise(e=>setTimeout(e,typeof codexLinuxExplicitQuitDrainTimeoutMs===\`number\`?codexLinuxExplicitQuitDrainTimeoutMs:3e3))]).finally(codexLinuxFinalizeQuit);return}codexLinuxDrainPromise.finally(codexLinuxFinalizeQuit)})()`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes("codexLinuxDrainPromise=Promise.all(") &&
    patchedSource.includes("n.app.on(`will-quit`,") &&
    patchedSource.includes(".map(e=>e.flush())")
  ) {
    console.warn("WARN: Could not find will-quit drain sequence — skipping Linux explicit quit drain timeout patch");
  }

  return patchedSource;
}

function applyLinuxExplicitQuitPromptBypassPatch(currentSource) {
  let patchedSource = currentSource;

  const promptBypassExpression =
    "(typeof codexLinuxShouldBypassQuitPrompt===`function`&&codexLinuxShouldBypassQuitPrompt())||";
  const promptBypassGuard = `if(${promptBypassExpression}`;
  const beforeQuitNeedle =
    "if(e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}";
  const beforeQuitPatch =
    `if(${promptBypassExpression}e||i.canQuitWithoutPrompt()||r||!s&&!c){g=!0,a.markAppQuitting();return}`;
  const beforeQuitRegex =
    /if\(([A-Za-z_$][\w$]*)\|\|([A-Za-z_$][\w$]*)\.canQuitWithoutPrompt\(\)\|\|([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)=!0,([A-Za-z_$][\w$]*)\.markAppQuitting\(\);return\}/g;
  let patchedAny = false;

  if (patchedSource.includes(beforeQuitNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(beforeQuitNeedle).join(beforeQuitPatch);
  }

  patchedSource = patchedSource.replace(
    beforeQuitRegex,
    (_match, updateInstallVar, quitControllerVar, appQuittingVar, activeConversationVar, automationVar, quittingStateVar, appQuittingControllerVar) => {
      patchedAny = true;
      return `if(${promptBypassExpression}${updateInstallVar}||${quitControllerVar}.canQuitWithoutPrompt()||${appQuittingVar}||!${activeConversationVar}&&!${automationVar}){${quittingStateVar}=!0,${appQuittingControllerVar}.markAppQuitting();return}`;
    },
  );

  if (
    !patchedAny &&
    !patchedSource.includes(promptBypassGuard) &&
    patchedSource.includes("showMessageBoxSync({type:`warning`,buttons:[`Quit`,`Cancel`]") &&
    patchedSource.includes(".canQuitWithoutPrompt()")
  ) {
    console.warn("WARN: Could not find before-quit confirmation guard — skipping Linux explicit quit prompt bypass patch");
  }

  return patchedSource;
}

function applyLinuxExplicitTrayQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const trayQuitNeedle = "{label:rB(this.appName),click:()=>{n.app.quit()}}";
  const trayQuitPatch =
    `{label:rB(this.appName),click:()=>{${quitMarkerExpression}n.app.quit()}}`;
  const patchedTrayQuitRegex =
    /\{label:[^{}]+,click:\(\)=>\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\)\}\}/;
  const trayQuitRegex =
    /\{label:rB\(([^)]+)\),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  const genericTrayQuitRegex =
    /\{label:([A-Za-z_$][\w$]*\(this\.appName\)),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/g;
  let patchedAny = false;
  if (patchedSource.includes(trayQuitNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(trayQuitNeedle).join(trayQuitPatch);
  }
  patchedSource = patchedSource.replace(
    trayQuitRegex,
    (_match, appNameExpr, electronVar) => {
      patchedAny = true;
      return `{label:rB(${appNameExpr}),click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  patchedSource = patchedSource.replace(
    genericTrayQuitRegex,
    (_match, labelExpression, electronVar) => {
      patchedAny = true;
      return `{label:${labelExpression},click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`;
    },
  );
  if (
    !patchedAny &&
    !patchedTrayQuitRegex.test(patchedSource) &&
    patchedSource.includes("getNativeTrayMenuItems(){") &&
    (patchedSource.includes("label:rB(") || patchedSource.includes("role:`quit`"))
  ) {
    console.warn("WARN: Could not find tray quit menu handler — skipping Linux explicit tray quit patch");
  }

  return patchedSource;
}

function applyLinuxExplicitIpcQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression = linuxExplicitQuitExpression();

  const quitAppNeedle = "if(o.type===`quit-app`){n.app.quit();return}";
  const quitAppPatch = `if(o.type===\`quit-app\`){${quitMarkerExpression}n.app.quit();return}`;
  const quitAppRegex =
    /if\(([A-Za-z_$][\w$]*)\.type===`quit-app`\)\{([A-Za-z_$][\w$]*)\.app\.quit\(\);return\}/g;
  const patchedQuitAppRegex =
    /if\([A-Za-z_$][\w$]*\.type===`quit-app`\)\{typeof codexLinuxPrepareForExplicitQuit===`function`\?codexLinuxPrepareForExplicitQuit\(\):typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress\(\),[A-Za-z_$][\w$]*\.app\.quit\(\);return\}/;
  let patchedAny = false;
  if (patchedSource.includes(quitAppNeedle)) {
    patchedAny = true;
    patchedSource = patchedSource.split(quitAppNeedle).join(quitAppPatch);
  }
  patchedSource = patchedSource.replace(
    quitAppRegex,
    (_match, messageVar, electronVar) => {
      patchedAny = true;
      return `if(${messageVar}.type===\`quit-app\`){${quitMarkerExpression}${electronVar}.app.quit();return}`;
    },
  );
  if (!patchedAny && !patchedQuitAppRegex.test(patchedSource) && patchedSource.includes("type===`quit-app`")) {
    console.warn("WARN: Could not find quit-app IPC handler — skipping Linux explicit quit-app patch");
  }

  return patchedSource;
}

function applyLinuxTrayPatch(currentSource, iconPathExpression) {
  let patchedSource = currentSource;
  const electronVar = requireName(currentSource, "electron") ?? "n";
  const packagedTrayIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop-tray.png`";
  const packagedAppIconPathExpression = "process.resourcesPath+`/../.codex-linux/codex-desktop.png`";

  const trayGuardNeedle =
    "process.platform!==`win32`&&process.platform!==`darwin`?null:";
  const trayGuardPatch =
    "process.platform!==`win32`&&process.platform!==`darwin`&&process.platform!==`linux`?null:";
  const trayGuardIndex = patchedSource.indexOf(trayGuardNeedle);
  if (patchedSource.includes(trayGuardPatch)) {
    // Already patched.
  } else if (
    trayGuardIndex !== -1 &&
    /new [A-Za-z_$][\w$]*\.Tray\(/.test(
      patchedSource.slice(trayGuardIndex, trayGuardIndex + TRAY_GUARD_LOOKAHEAD),
    )
  ) {
    patchedSource = patchedSource.replace(trayGuardNeedle, trayGuardPatch);
  } else {
    console.warn("WARN: Could not find tray platform guard — skipping Linux tray guard patch");
  }

  if (iconPathExpression != null) {
    const trayIconNeedle =
      `for(let e of o){let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await ${electronVar}.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`;
    const trayIconPatch =
      `for(let e of o){let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}if(process.platform===\`linux\`){let __codexLinuxTrayIcon=${electronVar}.nativeImage.createFromPath(${packagedTrayIconPathExpression});if(!__codexLinuxTrayIcon.isEmpty())return{defaultIcon:__codexLinuxTrayIcon,chronicleRunningIcon:null};let __codexLinuxAppIcon=${electronVar}.nativeImage.createFromPath(${packagedAppIconPathExpression});if(!__codexLinuxAppIcon.isEmpty())return{defaultIcon:__codexLinuxAppIcon,chronicleRunningIcon:null};let __codexLinuxUpstreamTrayIcon=${electronVar}.nativeImage.createFromPath(${iconPathExpression});if(!__codexLinuxUpstreamTrayIcon.isEmpty())return{defaultIcon:__codexLinuxUpstreamTrayIcon,chronicleRunningIcon:null}}return{defaultIcon:await ${electronVar}.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`;
    if (
      patchedSource.includes(`nativeImage.createFromPath(${packagedTrayIconPathExpression})`) ||
      patchedSource.includes(`nativeImage.createFromPath(${packagedAppIconPathExpression})`)
    ) {
      // Already patched.
    } else if (patchedSource.includes(trayIconNeedle)) {
      patchedSource = patchedSource.replace(trayIconNeedle, trayIconPatch);
    } else if (
      /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(\1\);if\(!\3\.isEmpty\(\)\)return\{defaultIcon:\3,chronicleRunningIcon:null\}\}return\{defaultIcon:await \4\.app\.getFileIcon\(process\.execPath,\{size:process\.platform===`win32`\?`small`:`normal`\}\),chronicleRunningIcon:null\}\}/.test(patchedSource)
    ) {
      patchedSource = patchedSource.replace(
        /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(\1\);if\(!\3\.isEmpty\(\)\)return\{defaultIcon:\3,chronicleRunningIcon:null\}\}return\{defaultIcon:await \4\.app\.getFileIcon\(process\.execPath,\{size:process\.platform===`win32`\?`small`:`normal`\}\),chronicleRunningIcon:null\}\}/,
        (_match, iconPathVar, candidatesVar, imageVar, electronAlias) =>
          `for(let ${iconPathVar} of ${candidatesVar}){let ${imageVar}=${electronAlias}.nativeImage.createFromPath(${iconPathVar});if(!${imageVar}.isEmpty())return{defaultIcon:${imageVar},chronicleRunningIcon:null}}if(process.platform===\`linux\`){let __codexLinuxTrayIcon=${electronAlias}.nativeImage.createFromPath(${packagedTrayIconPathExpression});if(!__codexLinuxTrayIcon.isEmpty())return{defaultIcon:__codexLinuxTrayIcon,chronicleRunningIcon:null};let __codexLinuxAppIcon=${electronAlias}.nativeImage.createFromPath(${packagedAppIconPathExpression});if(!__codexLinuxAppIcon.isEmpty())return{defaultIcon:__codexLinuxAppIcon,chronicleRunningIcon:null};let __codexLinuxUpstreamTrayIcon=${electronAlias}.nativeImage.createFromPath(${iconPathExpression});if(!__codexLinuxUpstreamTrayIcon.isEmpty())return{defaultIcon:__codexLinuxUpstreamTrayIcon,chronicleRunningIcon:null}}return{defaultIcon:await ${electronAlias}.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`,
      );
    } else {
      console.warn("WARN: Could not find tray icon fallback — skipping Linux tray icon patch");
    }
  }

  const patchedCloseToTrayRegex =
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLast(?:Local)?WindowToTray\?\.\(\)===!0&&![A-Za-z_$][\w$]*\)\{[A-Za-z_$][\w$]*\.preventDefault\(\),[A-Za-z_$][\w$]*\.hide\(\);return\}/;
  if (patchedCloseToTrayRegex.test(patchedSource)) {
    // Already patched with a newer minifier's window variable.
  } else {
    const closeToTrayRegex =
      /if\(process\.platform===`win32`&&!this\.isAppQuitting&&this\.options\.(canHideLast(?:Local)?WindowToTray)\?\.\(\)===!0&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)\.preventDefault\(\),([A-Za-z_$][\w$]*)\.hide\(\);return\}/;
    const closeToTrayMatch = patchedSource.match(closeToTrayRegex);
    if (closeToTrayMatch != null) {
      const [, gateMethodName, hasOtherWindowVar, eventVar, windowVar] = closeToTrayMatch;
      patchedSource = patchedSource.replace(
        closeToTrayRegex,
        `if((process.platform===\`win32\`||process.platform===\`linux\`)&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())&&this.options.${gateMethodName}?.()===!0&&!${hasOtherWindowVar}){${eventVar}.preventDefault(),${windowVar}.hide();return}`,
      );
    } else {
      console.warn("WARN: Could not find close-to-tray condition — skipping Linux close-to-tray patch");
    }
  }

  const trayContextMethodNeedle =
    "trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(";
  const trayContextMethodPatch =
    `trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};setLinuxTrayContextMenu(){let e=${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());this.tray.setContextMenu?.(e);return e}constructor(`;
  if (patchedSource.includes("setLinuxTrayContextMenu(){")) {
    patchedSource = patchedSource.replace(
      /setLinuxTrayContextMenu\(\)\{let e=[A-Za-z_$][\w$]*\.Menu\.buildFromTemplate\(this\.getNativeTrayMenuItems\(\)\);/,
      `setLinuxTrayContextMenu(){let e=${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`,
    );
  } else if (patchedSource.includes(trayContextMethodNeedle)) {
    patchedSource = patchedSource.replace(trayContextMethodNeedle, trayContextMethodPatch);
  } else {
    console.warn("WARN: Could not find tray controller fields — skipping Linux tray context menu method patch");
  }

  const trayClickNeedle =
    "this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const trayClickPatchWithoutContextSetup =
    "this.tray.on(`click`,()=>{process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const trayClickPatch =
    "process.platform===`linux`&&this.setLinuxTrayContextMenu(),this.tray.on(`click`,()=>{process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const canSetLinuxTrayContextMenu = patchedSource.includes("setLinuxTrayContextMenu(){");
  if (patchedSource.includes("process.platform===`linux`&&this.setLinuxTrayContextMenu(),this.tray.on(`click`")) {
    // Already patched.
  } else if (patchedSource.includes(trayClickNeedle)) {
    patchedSource = patchedSource.replace(
      trayClickNeedle,
      canSetLinuxTrayContextMenu ? trayClickPatch : trayClickPatchWithoutContextSetup,
    );
  } else if (canSetLinuxTrayContextMenu && patchedSource.includes(trayClickPatchWithoutContextSetup)) {
    patchedSource = patchedSource.replace(trayClickPatchWithoutContextSetup, trayClickPatch);
  } else {
    console.warn("WARN: Could not find tray click handler — skipping Linux tray menu click patch");
  }

  const trayMenuBuildNeedle =
    `openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`;
  const trayMenuBuildExistingPatch =
    `openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=process.platform===\`linux\`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`;
  const trayMenuBuildPatch =
    `openNativeTrayMenu(){if(process.platform===\`linux\`&&(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress()))return;this.updateChronicleTrayIcon();let e=process.platform===\`linux\`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():${electronVar}.Menu.buildFromTemplate(this.getNativeTrayMenuItems());`;
  const trayMenuBuildAnyAliasRegex =
    /openNativeTrayMenu\(\)\{this\.updateChronicleTrayIcon\(\);let e=([A-Za-z_$][\w$]*)\.Menu\.buildFromTemplate\(this\.getNativeTrayMenuItems\(\)\);/;
  const trayMenuBuildExistingAnyAliasRegex =
    /openNativeTrayMenu\(\)\{this\.updateChronicleTrayIcon\(\);let e=process\.platform===`linux`&&this\.setLinuxTrayContextMenu\?this\.setLinuxTrayContextMenu\(\):([A-Za-z_$][\w$]*)\.Menu\.buildFromTemplate\(this\.getNativeTrayMenuItems\(\)\);/;
  if (patchedSource.includes("openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuBuildExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuBuildExistingPatch, trayMenuBuildPatch);
  } else if (trayMenuBuildExistingAnyAliasRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(trayMenuBuildExistingAnyAliasRegex, trayMenuBuildPatch);
  } else if (patchedSource.includes(trayMenuBuildNeedle)) {
    patchedSource = patchedSource.replace(trayMenuBuildNeedle, trayMenuBuildPatch);
  } else if (trayMenuBuildAnyAliasRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(trayMenuBuildAnyAliasRegex, trayMenuBuildPatch);
  } else {
    console.warn("WARN: Could not find tray native menu builder — skipping Linux tray context menu builder patch");
  }

  const trayContextMenuNeedle =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  const trayContextMenuPatch =
    "if(process.platform===`linux`)return;e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  const oldLinuxPopupPatch =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),process.platform===`linux`&&this.tray.setContextMenu?.(e),this.tray.popUpContextMenu(e)}";
  const badLinuxPopupPatch =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),if(process.platform===`linux`)return;e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  if (patchedSource.includes("if(process.platform===`linux`)return;e.once(`menu-will-show`")) {
    // Already patched.
  } else if (patchedSource.includes(badLinuxPopupPatch)) {
    patchedSource = patchedSource.replace(badLinuxPopupPatch, trayContextMenuPatch);
  } else if (patchedSource.includes(oldLinuxPopupPatch)) {
    patchedSource = patchedSource.replace(oldLinuxPopupPatch, trayContextMenuPatch);
  } else if (patchedSource.includes(trayContextMenuNeedle)) {
    patchedSource = patchedSource.replace(trayContextMenuNeedle, trayContextMenuPatch);
  } else {
    console.warn("WARN: Could not find tray native menu popup — skipping Linux tray popup guard patch");
  }

  const trayMenuThreadsNeedle =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return";
  const trayMenuThreadsExistingPatch =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&this.setLinuxTrayContextMenu?.();return";
  const trayMenuThreadsPatch =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.();return";
  if (patchedSource.includes("this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.()")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuThreadsExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuThreadsExistingPatch, trayMenuThreadsPatch);
  } else if (patchedSource.includes(trayMenuThreadsNeedle)) {
    patchedSource = patchedSource.replace(trayMenuThreadsNeedle, trayMenuThreadsPatch);
  } else {
    console.warn("WARN: Could not find tray menu thread update handler — skipping Linux tray context refresh patch");
  }

  const trayStartupNeedle = "E&&oe();";
  const previousTrayStartupPatch = "(E||process.platform===`linux`)&&oe();";
  const trayEnabledExpression = "process.platform===`linux`&&(typeof codexLinuxIsTrayEnabled!==`function`||codexLinuxIsTrayEnabled())";
  const trayStartupPatch = `(E||${trayEnabledExpression})&&oe();`;
  patchedSource = patchedSource.replaceAll(
    "process.platform===`linux`&&codexLinuxIsTrayEnabled())&&",
    `${trayEnabledExpression})&&`,
  );
  if (patchedSource.includes(trayStartupPatch)) {
    // Already patched.
  } else if (patchedSource.includes(previousTrayStartupPatch)) {
    patchedSource = patchedSource.replace(previousTrayStartupPatch, trayStartupPatch);
  } else if (patchedSource.includes(trayStartupNeedle)) {
    patchedSource = patchedSource.replace(trayStartupNeedle, trayStartupPatch);
  } else {
    const traySetup = findDynamicTraySetup(patchedSource);
    const dynamicTrayStartupMatch = traySetup == null
      ? null
      : findDynamicTrayStartupCall(patchedSource, traySetup.setupFn, traySetup.index);
    if (
      traySetup != null &&
      patchedSource.includes(`${trayEnabledExpression})&&${traySetup.setupFn}();`)
    ) {
      // Already patched with a newer minifier's tray setup identifier.
    } else if (dynamicTrayStartupMatch != null) {
      const isWindowsVar = dynamicTrayStartupMatch[1];
      patchedSource = `${patchedSource.slice(0, dynamicTrayStartupMatch.index)}(${isWindowsVar}||${trayEnabledExpression})&&${traySetup.setupFn}();${patchedSource.slice(dynamicTrayStartupMatch.index + dynamicTrayStartupMatch[0].length)}`;
    } else {
      console.warn("WARN: Could not find tray startup call — skipping Linux tray startup patch");
    }
  }

  const traySetupForDiagnostics = findDynamicTraySetup(patchedSource);
  const sourceWithTrayDiagnostics = addDynamicTraySetupFailureLogging(
    patchedSource,
    traySetupForDiagnostics,
  );
  if (
    traySetupForDiagnostics != null &&
    sourceWithTrayDiagnostics === patchedSource &&
    !patchedSource.includes("[codex-linux] Failed to set up system tray")
  ) {
    console.warn("WARN: Could not find tray setup catch handler — skipping Linux tray diagnostics patch");
  }
  patchedSource = sourceWithTrayDiagnostics;

  return patchedSource;
}

function buildLinuxBuildInfoHelpers(electronVar, fsVar, pathVar) {
  return `function codexLinuxBuildInfoPaths(){let __codexBuildInfoPaths=[];try{__codexBuildInfoPaths.push((0,${pathVar}.join)(process.resourcesPath,\`codex-linux-build-info.json\`)),__codexBuildInfoPaths.push((0,${pathVar}.join)(process.resourcesPath,\`..\`,\`.codex-linux\`,\`build-info.json\`))}catch{}return __codexBuildInfoPaths}function codexLinuxReadBuildInfo(){for(let __codexBuildInfoPath of codexLinuxBuildInfoPaths())try{if(${fsVar}.existsSync(__codexBuildInfoPath)){let __codexBuildInfo=JSON.parse(${fsVar}.readFileSync(__codexBuildInfoPath,\`utf8\`));if(__codexBuildInfo&&typeof __codexBuildInfo===\`object\`&&!Array.isArray(__codexBuildInfo))return{info:__codexBuildInfo,path:__codexBuildInfoPath}}}catch{}return{info:null,path:null}}function codexLinuxBuildInfoValue(__codexBuildInfoValue,__codexBuildInfoFallback=\`unknown\`){return typeof __codexBuildInfoValue===\`string\`&&__codexBuildInfoValue.trim().length>0?__codexBuildInfoValue:Array.isArray(__codexBuildInfoValue)&&__codexBuildInfoValue.length>0?__codexBuildInfoValue.join(\`, \`):__codexBuildInfoValue==null?__codexBuildInfoFallback:String(__codexBuildInfoValue)}function codexLinuxBuildInfoCommitUrl(__codexBuildInfo){let __codexBuildInfoCommitUrl=__codexBuildInfo?.source?.commitUrl;return typeof __codexBuildInfoCommitUrl===\`string\`&&/^https:\\/\\/github\\.com\\/[^/\\s]+\\/[^/\\s]+\\/commit\\/[0-9a-f]{7,40}$/i.test(__codexBuildInfoCommitUrl)?__codexBuildInfoCommitUrl:null}function codexLinuxGetBuildInfo(){let __codexBuildInfoResult=codexLinuxReadBuildInfo();return{...__codexBuildInfoResult,commitUrl:codexLinuxBuildInfoCommitUrl(__codexBuildInfoResult.info)}}function codexLinuxBuildInfoDetail(__codexBuildInfo,__codexBuildInfoPath){if(!__codexBuildInfo)return\`No Linux build metadata file was found in this app install.\`;let __codexBuildInfoTarget=__codexBuildInfo.linuxTarget??{},__codexBuildInfoDistro=__codexBuildInfoTarget.distro??{},__codexBuildInfoDmg=__codexBuildInfo.upstreamDmg??{},__codexBuildInfoSource=__codexBuildInfo.source??{},__codexBuildInfoFeatures=__codexBuildInfo.linuxFeatures?.enabled??[],__codexBuildInfoProfile=__codexBuildInfo.packageProfile??{},__codexBuildInfoCommit=__codexBuildInfoSource.commit||__codexBuildInfoSource.shortCommit,__codexBuildInfoCommitValue=__codexBuildInfoCommit?__codexBuildInfoSource.dirty?\`\${__codexBuildInfoCommit} (dirty)\`:__codexBuildInfoCommit:\`unknown\`,__codexBuildInfoDistroValue=__codexBuildInfoDistro.prettyName||[__codexBuildInfoDistro.id,__codexBuildInfoDistro.versionId].filter(Boolean).join(\` \`)||\`unknown\`,__codexBuildInfoCommitLink=codexLinuxBuildInfoCommitUrl(__codexBuildInfo);return[\`Metadata file: \${codexLinuxBuildInfoValue(__codexBuildInfoPath)}\`,\`Linux package profile: \${codexLinuxBuildInfoValue(__codexBuildInfoProfile.label)}\`,\`Distro: \${__codexBuildInfoDistroValue}\`,\`Package manager: \${codexLinuxBuildInfoValue(__codexBuildInfoTarget.packageManager??__codexBuildInfoProfile.packageManager)}\`,\`Package format: \${codexLinuxBuildInfoValue(__codexBuildInfoTarget.packageFormat??__codexBuildInfoProfile.format)}\`,\`Enabled features: \${__codexBuildInfoFeatures.length>0?__codexBuildInfoFeatures.join(\`, \`):\`none\`}\`,\`Upstream app version: \${codexLinuxBuildInfoValue(__codexBuildInfoDmg.appVersion)}\`,\`Upstream DMG SHA256: \${codexLinuxBuildInfoValue(__codexBuildInfoDmg.sha256)}\`,\`Electron: \${codexLinuxBuildInfoValue(__codexBuildInfo.electronVersion)}\`,\`Linux source commit: \${__codexBuildInfoCommitValue}\`,...(__codexBuildInfoCommitLink?[\`Source commit URL: \${__codexBuildInfoCommitLink}\`]:[]),\`Source branch: \${codexLinuxBuildInfoValue(__codexBuildInfoSource.branch)}\`,\`Generated: \${codexLinuxBuildInfoValue(__codexBuildInfo.generatedAt)}\`].join(\`\\n\`)}async function codexLinuxOpenBuildInfoCommit(){let __codexBuildInfoResult=codexLinuxGetBuildInfo();return __codexBuildInfoResult.commitUrl?(await ${electronVar}.shell?.openExternal(__codexBuildInfoResult.commitUrl),{success:!0}):{success:!1}}async function codexLinuxShowBuildInfo(){try{let __codexBuildInfoResult=codexLinuxGetBuildInfo(),__codexBuildInfoCommitUrl=__codexBuildInfoResult.commitUrl,__codexBuildInfoPath=__codexBuildInfoResult.path,__codexBuildInfoButtons=[],__codexBuildInfoButtonIndex=0;__codexBuildInfoCommitUrl&&__codexBuildInfoButtons.push(\`Open Source Commit\`),__codexBuildInfoPath&&__codexBuildInfoButtons.push(\`Open Metadata File\`),__codexBuildInfoButtons.push(\`OK\`);let __codexBuildInfoBoxResponse=await ${electronVar}.dialog?.showMessageBox({type:\`info\`,buttons:__codexBuildInfoButtons,defaultId:__codexBuildInfoButtons.length-1,cancelId:__codexBuildInfoButtons.length-1,message:\`Codex Desktop Linux build information\`,detail:codexLinuxBuildInfoDetail(__codexBuildInfoResult.info,__codexBuildInfoPath)});if(__codexBuildInfoCommitUrl&&__codexBuildInfoBoxResponse?.response===__codexBuildInfoButtonIndex++){await ${electronVar}.shell?.openExternal(__codexBuildInfoCommitUrl);return}if(__codexBuildInfoPath&&__codexBuildInfoBoxResponse?.response===__codexBuildInfoButtonIndex++)await ${electronVar}.shell?.openPath?.(__codexBuildInfoPath)}catch{}}`;
}

function addLinuxBuildInfoRequestHandler(currentSource) {
  const handler = "\"codex-linux-get-build-info\":async()=>codexLinuxGetBuildInfo(),\"codex-linux-open-build-info-commit\":async()=>codexLinuxOpenBuildInfoCommit(),\"codex-linux-show-build-info\":async()=>{await codexLinuxShowBuildInfo();return{success:!0}},";
  const nestedHandler = `({${handler}`;
  let patchedSource = currentSource;
  let changed = false;
  if (patchedSource.includes(nestedHandler)) {
    patchedSource = patchedSource.replace(nestedHandler, "({");
    changed = true;
  } else if (patchedSource.includes(handler)) {
    return { source: patchedSource, changed: false };
  }

  const handlerKeyIndexes = [
    patchedSource.indexOf("\"set-global-state\":async"),
    patchedSource.indexOf("\"get-global-state\":async"),
  ].filter((index) => index !== -1);
  if (handlerKeyIndexes.length === 0) {
    return { source: patchedSource, changed };
  }

  const keyIndex = Math.min(...handlerKeyIndexes);
  return {
    source: `${patchedSource.slice(0, keyIndex)}${handler}${patchedSource.slice(keyIndex)}`,
    changed: true,
  };
}

function findLinuxBuildInfoHelperInsertionIndex(source, classMatch, helpMenuMatch) {
  if (classMatch?.index != null) {
    return classMatch.index;
  }
  if (helpMenuMatch?.index == null) {
    return null;
  }

  const statementStart = source.lastIndexOf(";", helpMenuMatch.index) + 1;
  const insertionIndex = statementStart === 0 ? 0 : statementStart;
  return insertionIndex <= helpMenuMatch.index ? insertionIndex : null;
}

function applyLinuxBuildInfoTrayPatch(currentSource) {
  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  const hasHelper = currentSource.includes("function codexLinuxShowBuildInfo()");
  if (!hasHelper && (electronVar == null || fsVar == null || pathVar == null)) {
    console.warn("WARN: Could not find build info module bindings — skipping Linux build info tray patch");
    return currentSource;
  }

  let patchedSource = currentSource;
  let changed = false;
  if (
    electronVar != null &&
    patchedSource.includes(`let ${electronVar}=await ${electronVar}.dialog?.showMessageBox`)
  ) {
    patchedSource = patchedSource
      .replace(
        `let ${electronVar}=await ${electronVar}.dialog?.showMessageBox`,
        `let __codexBuildInfoBoxResponse=await ${electronVar}.dialog?.showMessageBox`,
      )
      .replaceAll(
        `&&${electronVar}?.response===`,
        "&&__codexBuildInfoBoxResponse?.response===",
      );
    changed = true;
  }
  const trayMenuRegex = /getNativeTrayMenuItems\(\)\{[^]*?return\[/g;
  const classRegex = /var [A-Za-z_$][\w$]*=class\{[^]*?getNativeTrayMenuItems\(\)\{[^]*?return\[/;
  const helpMenuPattern = /\{role:`help`,id:[A-Za-z_$][\w$]*\.bn\.help,submenu:\[/;
  const currentHelpMenuPattern = /\{role:`help`,id:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.help,submenu:\[/;
  const helperInsertionIndex = findLinuxBuildInfoHelperInsertionIndex(
    currentSource,
    currentSource.match(classRegex),
    currentSource.match(helpMenuPattern) ?? currentSource.match(currentHelpMenuPattern),
  );
  const canInstallHelper = hasHelper || helperInsertionIndex != null;
  const trayMenuMatch = patchedSource.match(trayMenuRegex);
  if (trayMenuMatch == null && !patchedSource.includes("role:`help`")) {
    console.warn("WARN: Could not find tray menu items method — skipping Linux build info tray patch");
  } else if (
    trayMenuMatch != null &&
    !/getNativeTrayMenuItems\(\)\{[^]*?label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}/.test(patchedSource)
  ) {
    const menuPrefix =
      "...process.platform===`linux`?[{label:`Build Information`,click:()=>{codexLinuxShowBuildInfo()}},{type:`separator`}]:[],";
    patchedSource = patchedSource.replace(trayMenuRegex, (match) => `${match}${menuPrefix}`);
    changed = true;
  }

  const helpMenuRegex = /\{role:`help`,id:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.help,submenu:\[/g;
  if (
    !/\{role:`help`,id:[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.help,submenu:\[\.\.\.process\.platform===`linux`\?\[\{label:`Build Information`,click:\(\)=>\{codexLinuxShowBuildInfo\(\)\}\},\{type:`separator`\}\]:\[\],/.test(patchedSource)
  ) {
    if (canInstallHelper) {
      let patchedHelpMenu = false;
      patchedSource = patchedSource.replace(helpMenuRegex, (match) => {
        patchedHelpMenu = true;
        return `${match}...process.platform===\`linux\`?[{label:\`Build Information\`,click:()=>{codexLinuxShowBuildInfo()}},{type:\`separator\`}]:[],`;
      });
      changed = changed || patchedHelpMenu;
      if (!patchedHelpMenu && patchedSource.includes("role:`help`")) {
        console.warn("WARN: Could not find Help menu insertion point — skipping Linux build info app menu patch");
      }
    } else if (patchedSource.includes("role:`help`")) {
      console.warn("WARN: Could not find Help menu insertion point — skipping Linux build info app menu patch");
    }
  }

  const handlerPatch = addLinuxBuildInfoRequestHandler(patchedSource);
  patchedSource = handlerPatch.source;
  changed = changed || handlerPatch.changed;

  if (!changed || hasHelper) {
    return patchedSource;
  }

  const classMatch = patchedSource.match(classRegex);
  const helpMenuMatch = patchedSource.match(helpMenuPattern) ?? patchedSource.match(currentHelpMenuPattern);
  const helperIndex = findLinuxBuildInfoHelperInsertionIndex(patchedSource, classMatch, helpMenuMatch);
  if (helperIndex == null) {
    console.warn("WARN: Could not find build info helper insertion point — skipping Linux build info patch");
    return currentSource;
  }

  const helpers = buildLinuxBuildInfoHelpers(electronVar, fsVar, pathVar);
  return `${patchedSource.slice(0, helperIndex)}${helpers};${patchedSource.slice(helperIndex)}`;
}

function applyLinuxSingleInstancePatch(currentSource) {
  let patchedSource = currentSource;

  const singleInstanceLockNeedle =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});let A=Date.now();await n.app.whenReady()";
  const singleInstanceLockPatch =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});if(process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n.app.requestSingleInstanceLock()){n.app.quit();return}let A=Date.now();await n.app.whenReady()";
  const unguardedSingleInstanceLock =
    "process.platform===`linux`&&!n.app.requestSingleInstanceLock()";
  const guardedSingleInstanceLock =
    "process.platform===`linux`&&process.env.CODEX_LINUX_MULTI_LAUNCH!==`1`&&!n.app.requestSingleInstanceLock()";
  if (patchedSource.includes(guardedSingleInstanceLock)) {
    // Already patched.
  } else if (patchedSource.includes(unguardedSingleInstanceLock)) {
    patchedSource = patchedSource.replaceAll(unguardedSingleInstanceLock, guardedSingleInstanceLock);
  } else if (patchedSource.includes(singleInstanceLockNeedle)) {
    patchedSource = patchedSource.replace(singleInstanceLockNeedle, singleInstanceLockPatch);
  } else if (patchedSource.includes("setSecondInstanceArgsHandler")) {
    // Newer bundles take the single-instance lock in bootstrap.js and hand args into main here.
  } else {
    console.warn("WARN: Could not find startup handoff point — skipping Linux single-instance lock patch");
  }

  const secondInstanceHandlerNeedle =
    "l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  const secondInstanceHandlerExistingPatch =
    "let codexLinuxSecondInstanceHandler=(e,t)=>{R.deepLinks.queueProcessArgs(t)||ie()};process.platform===`linux`&&(n.app.on(`second-instance`,codexLinuxSecondInstanceHandler),k.add(()=>{n.app.off(`second-instance`,codexLinuxSecondInstanceHandler)})),l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  const secondInstanceHandlerPatch =
    "let codexLinuxSecondInstanceHandler=(e,t)=>{(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?void 0:R.deepLinks.queueProcessArgs(t)||ie()},codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()};process.platform===`linux`&&(n.app.on(`before-quit`,codexLinuxBeforeQuitHandler),k.add(()=>{n.app.off(`before-quit`,codexLinuxBeforeQuitHandler)}),n.app.on(`second-instance`,codexLinuxSecondInstanceHandler),k.add(()=>{n.app.off(`second-instance`,codexLinuxSecondInstanceHandler)})),l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  if (
    patchedSource.includes("codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()}") &&
    patchedSource.includes("(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?void 0:R.deepLinks.queueProcessArgs(t)||ie()")
  ) {
    // Already patched.
  } else if (patchedSource.includes(secondInstanceHandlerExistingPatch)) {
    patchedSource = patchedSource.replace(secondInstanceHandlerExistingPatch, secondInstanceHandlerPatch);
  } else if (patchedSource.includes(secondInstanceHandlerNeedle)) {
    patchedSource = patchedSource.replace(secondInstanceHandlerNeedle, secondInstanceHandlerPatch);
  } else if (patchedSource.includes("setSecondInstanceArgsHandler")) {
    // bootstrap.js owns the Electron second-instance event and calls this bundle's handler.
  } else {
    console.warn("WARN: Could not find second-instance handler — skipping Linux second-instance focus patch");
  }

  return patchedSource;
}

function applyBrowserUseNodeReplApprovalPatch(currentSource) {
  const approvalPatch =
    "startup_timeout_sec:120,tools:{js:{approval_mode:`approve`}},env:{";
  const needle = "startup_timeout_sec:120,env:{";
  let patchedSource = currentSource;
  let patchedTrustedHashes = false;
  if (patchedSource.includes(needle)) {
    patchedSource = patchedSource.split(needle).join(approvalPatch);
  }

  const currentRuntimeConfigRegex =
    /([A-Za-z_$][\w$]*)\.Dn\(\{([^{}]*?)nodeReplPath:([^,{}]+)(,)(?!tools:\{js:\{approval_mode:`approve`\}\})/g;
  let patchedAnyCurrentRuntimeConfig = false;
  patchedSource = patchedSource.replace(
    currentRuntimeConfigRegex,
    (_match, runtimeFactoryVar, configPrefix, nodeReplPathVar, comma) => {
      patchedAnyCurrentRuntimeConfig = true;
      return `${runtimeFactoryVar}.Dn({${configPrefix}nodeReplPath:${nodeReplPathVar}${comma}tools:{js:{approval_mode:\`approve\`}},`;
    },
  );

  const trustedHashesRegex =
    /trustedBrowserClientSha256s:([^,{}]+)\|\|([^,{}]+)\?([A-Za-z_$][\w$]*):\[\]/g;
  patchedSource = patchedSource.replace(
    trustedHashesRegex,
    (match, browserUseEnabledVar, nativePipeEnabledVar, trustedHashesVar) => {
      if (match.includes("codexLinuxTrustedBrowserClientSha256s(")) {
        return match;
      }
      patchedTrustedHashes = true;
      return `trustedBrowserClientSha256s:${browserUseEnabledVar}||${nativePipeEnabledVar}?codexLinuxTrustedBrowserClientSha256s(${trustedHashesVar}):[]`;
    },
  );

  if (
    patchedTrustedHashes &&
    !patchedSource.includes("function codexLinuxTrustedBrowserClientSha256s(")
  ) {
    const fsVar = requireName(patchedSource, "node:fs");
    const pathVar = requireName(patchedSource, "node:path");
    const cryptoVar = requireName(patchedSource, "node:crypto");
    if (fsVar == null || pathVar == null || cryptoVar == null) {
      console.warn(
        "WARN: Could not find fs/path/crypto aliases — skipping Linux Browser Use trusted hash patch",
      );
      patchedSource = patchedSource.replace(
        /trustedBrowserClientSha256s:([^,{}]+)\|\|([^,{}]+)\?codexLinuxTrustedBrowserClientSha256s\(([A-Za-z_$][\w$]*)\):\[\]/g,
        "trustedBrowserClientSha256s:$1||$2?$3:[]",
      );
      patchedTrustedHashes = false;
    } else {
      const helper =
        `function codexLinuxTrustedBrowserClientSha256s(e,t=process.resourcesPath){if(process.platform!==\`linux\`)return e;let n=Array.isArray(e)?[...e]:[],r=t??"";if(r.length===0)return Array.from(new Set(n));for(let a of[\`browser\`,\`chrome\`])try{let e=(0,${pathVar}.join)(r,\`plugins\`,\`openai-bundled\`,\`plugins\`,a,\`scripts\`,\`browser-client.mjs\`);(0,${fsVar}.existsSync)(e)&&n.push((0,${cryptoVar}.createHash)(\`sha256\`).update((0,${fsVar}.readFileSync)(e)).digest(\`hex\`))}catch{}return Array.from(new Set(n))}`;
      const strictDirective = '"use strict";';
      const helperInsertionIndex = patchedSource.startsWith(strictDirective)
        ? strictDirective.length
        : 0;
      patchedSource =
        patchedSource.slice(0, helperInsertionIndex) +
        helper +
        patchedSource.slice(helperInsertionIndex);
    }
  }

  if (
    !patchedTrustedHashes &&
    !patchedSource.includes("codexLinuxTrustedBrowserClientSha256s(") &&
    patchedSource.includes("NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S")
  ) {
    console.warn(
      "WARN: Could not find Browser Use trusted hash insertion point — skipping Linux Browser Use trusted hash patch",
    );
  }

  if (
    patchedSource === currentSource &&
    !patchedSource.includes(approvalPatch) &&
    !patchedAnyCurrentRuntimeConfig &&
    !patchedTrustedHashes &&
    !patchedSource.includes("codexLinuxTrustedBrowserClientSha256s(")
  ) {
    console.warn(
      "WARN: Could not find Browser Use node_repl config insertion point — skipping node_repl approval patch",
    );
  }

  return patchedSource;
}

function applyLinuxBrowserUseRouteLivenessPatch(currentSource) {
  if (currentSource.includes("codexLinuxResolveLiveBrowserUseRouteWindow")) {
    return currentSource;
  }

  const routeWindowPattern =
    /function ([A-Za-z_$][\w$]*)\(\{ensureWindowState:([A-Za-z_$][\w$]*),windowId:([A-Za-z_$][\w$]*),windows:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=\4\.get\(\3\)\?\?null;if\(\5==null\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.BrowserWindow\.fromId\(\3\);\6!=null&&!\6\.isDestroyed\(\)&&!\6\.webContents\.isDestroyed\(\)&&\(\5=\2\(\6,\6\.webContents\)\)\}return \5==null\|\|\5\.window\.isDestroyed\(\)\|\|\5\.owner\.isDestroyed\(\)\?\(([A-Za-z_$][\w$]*)\(\)\.warning\(`IAB_LIFECYCLE route window is not live`,\{safe:\{hasWindowState:\5!=null,ownerDestroyed:\5\?\.owner\.isDestroyed\(\)\?\?null,windowDestroyed:\5\?\.window\.isDestroyed\(\)\?\?null,windowId:\3\},sensitive:\{\}\}\),null\):\5\}/u;

  const match = currentSource.match(routeWindowPattern);
  if (match == null) {
    if (
      currentSource.includes("IAB_LIFECYCLE route window is not live") &&
      currentSource.includes("BrowserWindow.fromId")
    ) {
      console.warn(
        "WARN: Could not find Browser Use route liveness helper — skipping Linux route liveness fallback patch",
      );
    }
    return currentSource;
  }

  const [
    original,
    functionName,
    ensureWindowStateVar,
    windowIdVar,
    windowsVar,
    stateVar,
    browserWindowVar,
    electronVar,
    loggerVar,
  ] = match;

  const helper = `function codexLinuxResolveLiveBrowserUseRouteWindow(e,t,n,r){if(process.platform!==\`linux\`)return null;let i=[];try{for(let e of n.values())e!=null&&!e.window.isDestroyed()&&!e.owner.isDestroyed()&&i.push(e)}catch{}if(i.length===1)return i[0];let a=[];try{a=r.BrowserWindow.getAllWindows().filter(e=>e!=null&&!e.isDestroyed()&&!e.webContents.isDestroyed())}catch{return null}if(a.length!==1)return null;let o=a[0],s=n.get(o.id)??null;return s!=null&&!s.window.isDestroyed()&&!s.owner.isDestroyed()?s:e(o,o.webContents)}`;
  const replacement = `${helper}function ${functionName}({ensureWindowState:${ensureWindowStateVar},windowId:${windowIdVar},windows:${windowsVar}}){let ${stateVar}=${windowsVar}.get(${windowIdVar})??null;if(${stateVar}==null){let ${browserWindowVar}=${electronVar}.BrowserWindow.fromId(${windowIdVar});${browserWindowVar}!=null&&!${browserWindowVar}.isDestroyed()&&!${browserWindowVar}.webContents.isDestroyed()&&(${stateVar}=${ensureWindowStateVar}(${browserWindowVar},${browserWindowVar}.webContents))}${stateVar}==null&&(${stateVar}=codexLinuxResolveLiveBrowserUseRouteWindow(${ensureWindowStateVar},${windowIdVar},${windowsVar},${electronVar}));return ${stateVar}==null||${stateVar}.window.isDestroyed()||${stateVar}.owner.isDestroyed()?(${loggerVar}().warning(\`IAB_LIFECYCLE route window is not live\`,{safe:{hasWindowState:${stateVar}!=null,ownerDestroyed:${stateVar}?.owner.isDestroyed()??null,windowDestroyed:${stateVar}?.window.isDestroyed()??null,windowId:${windowIdVar}},sensitive:{}}),null):${stateVar}}`;

  return currentSource.replace(original, replacement);
}

function applyLinuxChromeExtensionStatusPatch(currentSource) {
  if (currentSource.includes("codexLinuxChromeProfileRoots")) {
    return currentSource;
  }

  const fsVar = requireName(currentSource, "node:fs");
  const osVar = requireName(currentSource, "node:os");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || osVar == null || pathVar == null) {
    console.warn(
      "WARN: Could not find fs/os/path aliases — skipping Linux Chrome extension status patch",
    );
    return currentSource;
  }

  const unsupportedMessage =
    "Opening Chrome extension settings is only supported on macOS and Windows";
  const unsupportedMessageIndex = currentSource.indexOf(unsupportedMessage);
  const openFunctionStart =
    unsupportedMessageIndex === -1
      ? -1
      : currentSource.lastIndexOf("async function ", unsupportedMessageIndex);
  const blockStart =
    openFunctionStart === -1
      ? -1
      : currentSource.lastIndexOf("function ", openFunctionStart - 1);
  const blockEnd =
    openFunctionStart === -1
      ? -1
      : currentSource.indexOf("function ", openFunctionStart + "async function ".length);
  const originalBlock = blockEnd === -1 ? null : currentSource.slice(blockStart, blockEnd);
  if (
    blockStart === -1 ||
    blockEnd === -1 ||
    !originalBlock.includes(unsupportedMessage)
  ) {
    console.warn(
      "WARN: Could not find Chrome extension status functions — skipping Linux Chrome extension status patch",
    );
    return currentSource;
  }

  const statusFunctionName = /^function ([A-Za-z_$][\w$]*)\(\{extensionId:/.exec(
    originalBlock,
  )?.[1];
  const openFunctionName = /async function ([A-Za-z_$][\w$]*)\(\{extensionId:/.exec(
    originalBlock,
  )?.[1];
  const detectChromeFunctionName =
    /detectChromeCommand:[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)/.exec(originalBlock)?.[1];
  const runCommandFunctionName =
    /runCommand:[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)/.exec(originalBlock)?.[1];
  const extensionUrlFunctionName = /await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\[([A-Za-z_$][\w$]*)\(e\)\]\)/.exec(
    originalBlock,
  )?.[1];
  const macOpenFunctionName = /await [A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),\[`-b`,/.exec(
    originalBlock,
  )?.[1];
  const macBundleIdName = /await [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,\[`-b`,([A-Za-z_$][\w$]*),/.exec(
    originalBlock,
  )?.[1];
  const extensionIdValidatorName = /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(e\),/.exec(
    originalBlock,
  )?.[1];
  const profileDirFunctionName = /[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\(\{homeDir:/.exec(
    originalBlock,
  )?.[1];
  if (
    statusFunctionName == null ||
    openFunctionName == null ||
    detectChromeFunctionName == null ||
    runCommandFunctionName == null ||
    extensionUrlFunctionName == null ||
    macOpenFunctionName == null ||
    macBundleIdName == null ||
    extensionIdValidatorName == null ||
    profileDirFunctionName == null
  ) {
    console.warn(
      "WARN: Could not identify Chrome extension status helper names — skipping Linux Chrome extension status patch",
    );
    return currentSource;
  }

  const replacement =
    `function codexLinuxChromeProfileRoots({homeDir:__codexHomeDir,platform:__codexPlatform}){return __codexPlatform===\`linux\`?[(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`BraveSoftware\`,\`Brave-Browser\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome-beta\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome-unstable\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`chromium\`)]:[]}function codexLinuxChromeHasExtension({extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform}){if(__codexPlatform!==\`linux\`)return!1;let __codexValidatedExtensionId=${extensionIdValidatorName}(__codexExtensionId);for(let __codexProfileRoot of codexLinuxChromeProfileRoots({homeDir:__codexHomeDir,platform:__codexPlatform})){if(!(0,${fsVar}.existsSync)(__codexProfileRoot))continue;for(let __codexProfileEntry of (0,${fsVar}.readdirSync)(__codexProfileRoot,{withFileTypes:!0}))if(__codexProfileEntry.isDirectory()&&(0,${fsVar}.existsSync)((0,${pathVar}.join)(__codexProfileRoot,__codexProfileEntry.name,\`Extensions\`,__codexValidatedExtensionId)))return!0}return!1}function codexLinuxChromeCommand(){let __codexPathEntries=(process.env.PATH??\`\`).split(\`:\`);for(let __codexBrowserCommand of[\`brave-browser\`,\`brave\`,\`google-chrome\`,\`google-chrome-stable\`,\`chromium-browser\`,\`chromium\`])for(let __codexPathEntry of __codexPathEntries){if(__codexPathEntry.length===0)continue;let __codexCandidate=(0,${pathVar}.join)(__codexPathEntry,__codexBrowserCommand);try{if((0,${fsVar}.existsSync)(__codexCandidate)&&(0,${fsVar}.statSync)(__codexCandidate).isFile())return __codexCandidate}catch{}}return null}function ${statusFunctionName}({extensionId:__codexExtensionId,homeDir:__codexHomeDir=(0,${osVar}.homedir)(),localAppDataDir:__codexLocalAppDataDir=process.env.LOCALAPPDATA,platform:__codexPlatform=process.platform}){if(__codexPlatform===\`linux\`)return codexLinuxChromeHasExtension({extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform});let __codexValidatedExtensionId=${extensionIdValidatorName}(__codexExtensionId),__codexProfileDir=${profileDirFunctionName}({homeDir:__codexHomeDir,localAppDataDir:__codexLocalAppDataDir,platform:__codexPlatform});return __codexProfileDir==null||!(0,${fsVar}.existsSync)(__codexProfileDir)?!1:(0,${fsVar}.readdirSync)(__codexProfileDir,{withFileTypes:!0}).some(__codexProfileEntry=>__codexProfileEntry.isDirectory()&&(0,${fsVar}.existsSync)((0,${pathVar}.join)(__codexProfileDir,__codexProfileEntry.name,\`Extensions\`,__codexValidatedExtensionId)))}async function ${openFunctionName}({extensionId:__codexExtensionId,platform:__codexPlatform=process.platform,detectChromeCommand:__codexDetectChromeCommand=${detectChromeFunctionName},runCommand:__codexRunCommand=${runCommandFunctionName}}){if(__codexPlatform===\`darwin\`){await __codexRunCommand(${macOpenFunctionName},[\`-b\`,${macBundleIdName},${extensionUrlFunctionName}(__codexExtensionId)]);return}if(__codexPlatform===\`win32\`){let __codexChromeCommand=__codexDetectChromeCommand();if(__codexChromeCommand==null)throw Error(\`Google Chrome is not installed\`);await __codexRunCommand(__codexChromeCommand,[${extensionUrlFunctionName}(__codexExtensionId)]);return}if(__codexPlatform===\`linux\`){let __codexChromeCommand=codexLinuxChromeCommand()??__codexDetectChromeCommand();if(__codexChromeCommand==null)throw Error(\`Google Chrome, Brave, or Chromium is not installed\`);await __codexRunCommand(__codexChromeCommand,[${extensionUrlFunctionName}(__codexExtensionId)]);return}throw Error(\`Opening Chrome extension settings is only supported on macOS, Windows, and Linux\`)}`;

  return currentSource.slice(0, blockStart) + replacement + currentSource.slice(blockEnd);
}

function applyLinuxGitOriginsSourceFallbackPatch(currentSource) {
  const fallbackSource = "linux_git_origins_missing_source_fallback";
  if (currentSource.includes(`source:\`${fallbackSource}\`,requestKind:`)) {
    return currentSource;
  }

  const dynamicRegex =
    /if\(([A-Za-z_$][\w$]*)==null\)\{if\(([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)throw Error\(`Missing git operation source for \$\{\4\}`\);return ([A-Za-z_$][\w$]*)\(\)\}return ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\{source:\1,requestKind:\4\},\5\)/;
  const dynamicMatch = currentSource.match(dynamicRegex);
  if (dynamicMatch != null) {
    const [, sourceVar, gitGuardVar, guardFn, requestKindVar, callVar, operationContextVar, operationContextFn] = dynamicMatch;
    return currentSource.replace(
      dynamicRegex,
      `if(${sourceVar}==null){if(${gitGuardVar}.${guardFn}(${requestKindVar})){if(${requestKindVar}===\`git-origins\`)return ${operationContextVar}.${operationContextFn}({source:\`${fallbackSource}\`,requestKind:${requestKindVar}},${callVar});throw Error(\`Missing git operation source for \${${requestKindVar}}\`)}return ${callVar}()}return ${operationContextVar}.${operationContextFn}({source:${sourceVar},requestKind:${requestKindVar}},${callVar})`,
    );
  }

  if (
    currentSource.includes("Missing git operation source for") &&
    currentSource.includes("\"git-origins\":")
  ) {
    console.warn("WARN: Could not find git operation source guard — skipping git-origins fallback patch");
  }

  return currentSource;
}

function applyLinuxRemoteControlConfigPreservationPatch(currentSource) {
  const removedLog = "Removed remote_control from config before app-server start";
  const failedLog = "Failed to remove remote_control before app-server start";
  const stripperGuardRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`\)try\{/gu;
  const patchedSource = currentSource.replace(stripperGuardRegex, (needle, hostConfigVar) =>
    needle.replace(
      `if(${hostConfigVar}.kind===\`local\`)try{`,
      `if(${hostConfigVar}.kind===\`local\`&&process.platform!==\`linux\`)try{`,
    ),
  );
  if (patchedSource !== currentSource) {
    return patchedSource;
  }

  const alreadyPatchedRegex =
    /async function [A-Za-z_$][\w$]*\(\{codexHome:[A-Za-z_$][\w$]*,hostConfig:([A-Za-z_$][\w$]*),logger:[A-Za-z_$][\w$]*=[^}]*\}\)\{if\(\1\.kind===`local`&&process\.platform!==`linux`\)try\{/u;
  if (alreadyPatchedRegex.test(currentSource)) {
    return currentSource;
  }

  if (!currentSource.includes(removedLog) && !currentSource.includes(failedLog)) {
    return currentSource;
  }

  console.warn(
    "WARN: Could not find remote-control config stripper guard — skipping Linux remote-control config preservation patch",
  );
  return currentSource;
}

module.exports = {
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxAboutDialogPatch,
  applyLinuxChromeExtensionStatusPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxBuildInfoTrayPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxRemoteControlConfigPreservationPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxWindowOptionsPatch,
};
