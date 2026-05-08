"use strict";

const {
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findMatchingBrace,
  inferModuleAlias,
} = require("./shared.js");

// Main-process patches adapt Electron shell behavior: windows, tray, menu,
// single-instance handling, and packaged runtime glue.
function applyLinuxWindowOptionsPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const windowOptionsNeedle = "...process.platform===`win32`?{autoHideMenuBar:!0}:{},";
  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  const iconPathNeedle = `icon:${iconPathExpression}`;
  const windowOptionsReplacement =
    `...process.platform===\`win32\`||process.platform===\`linux\`?{autoHideMenuBar:!0,...process.platform===\`linux\`?{${iconPathNeedle}}:{}}:{},`;

  if (currentSource.includes(iconPathNeedle)) {
    return currentSource;
  }

  if (currentSource.includes(windowOptionsNeedle)) {
    return currentSource.replace(windowOptionsNeedle, windowOptionsReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow autoHideMenuBar snippet — skipping window options patch");
  return currentSource;
}

function applyLinuxMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(menuRegex, (match, windowVar) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setMenuBarVisibility(!1),`;
    if (currentSource.includes(`${linuxPatch}${match}`)) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (!patchedAny && menuRegex.test(currentSource) && !currentSource.includes("setMenuBarVisibility(!1),process.platform===`win32`")) {
    console.warn("WARN: Could not find window menu visibility snippet — skipping menu patch");
  }

  return patchedSource;
}

function applyLinuxSetIconPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  if (currentSource.includes(`setIcon(${iconPathExpression})`)) {
    return currentSource;
  }

  const readyRegex = /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/;
  const match = currentSource.match(readyRegex);
  if (match == null) {
    console.warn("WARN: Could not find window setIcon insertion point — skipping setIcon patch");
    return currentSource;
  }

  const windowVar = match[1];
  return currentSource.replace(
    readyRegex,
    `process.platform===\`linux\`&&${windowVar}.setIcon(${iconPathExpression}),${match[0]}`,
  );
}

function applyLinuxOpaqueBackgroundPatch(currentSource) {
  if (currentSource.includes("===`linux`&&!OM(")) {
    return currentSource;
  }

  const colorConstRegex =
    /([A-Za-z_$][\w$]*)=`#00000000`,([A-Za-z_$][\w$]*)=`#000000`,([A-Za-z_$][\w$]*)=`#f9f9f9`/;
  const colorMatch = currentSource.match(colorConstRegex);

  if (!colorMatch) {
    console.warn(
      "WARN: Could not find color constants (#00000000, #000000, #f9f9f9) — skipping background patch",
    );
    return currentSource;
  }

  const [, transparentVar, darkVar, lightVar] = colorMatch;
  const funcParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:[A-Za-z_$][\w$]*,prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)/;
  const funcMatch = currentSource.match(funcParamRegex);

  if (funcMatch == null) {
    console.warn("WARN: Could not find BrowserWindow background function signature — skipping background patch");
    return currentSource;
  }

  const [, platformParam, appearanceParam, darkColorsParam, transparentAppearancePredicate] =
    funcMatch;
  const bgNeedle =
    `backgroundMaterial:\`mica\`}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const oldLinuxBgPatch =
    `backgroundMaterial:\`mica\`}:process.platform===\`linux\`?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const bgReplacement =
    `backgroundMaterial:\`mica\`}:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;

  if (currentSource.includes(bgNeedle)) {
    return currentSource.replace(bgNeedle, bgReplacement);
  }
  if (currentSource.includes(oldLinuxBgPatch)) {
    return currentSource.replace(oldLinuxBgPatch, bgReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
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
      return { setupFn, index: match.index };
    }
  }
  return null;
}

function findDynamicTrayStartupCall(source, setupFn, startIndex) {
  const startupRegex = new RegExp(`([A-Za-z_$][\\w$]*)&&${escapeRegExp(setupFn)}\\(\\);`, "g");
  startupRegex.lastIndex = startIndex;
  return startupRegex.exec(source);
}

function applyLinuxQuitGuardPatch(currentSource) {
  let patchedSource = currentSource;

  const quitGuardNeedle = "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);";
  const quitGuardPatch =
    "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";

  if (patchedSource.includes("codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;")) {
    return patchedSource;
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

function applyLinuxTrayPatch(currentSource, iconPathExpression) {
  let patchedSource = currentSource;

  const trayGuardNeedle =
    "process.platform!==`win32`&&process.platform!==`darwin`?null:";
  const trayGuardPatch =
    "process.platform!==`win32`&&process.platform!==`darwin`&&process.platform!==`linux`?null:";
  const trayGuardIndex = patchedSource.indexOf(trayGuardNeedle);
  if (patchedSource.includes(trayGuardPatch)) {
    // Already patched.
  } else if (
    trayGuardIndex !== -1 &&
    patchedSource.slice(trayGuardIndex, trayGuardIndex + TRAY_GUARD_LOOKAHEAD).includes("new n.Tray")
  ) {
    patchedSource = patchedSource.replace(trayGuardNeedle, trayGuardPatch);
  } else {
    console.warn("WARN: Could not find tray platform guard — skipping Linux tray guard patch");
  }

  if (iconPathExpression != null) {
    const trayIconNeedle =
      "for(let e of o){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await n.app.getFileIcon(process.execPath,{size:process.platform===`win32`?`small`:`normal`}),chronicleRunningIcon:null}}";
    const trayIconPatch =
      `for(let e of o){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}if(process.platform===\`linux\`){let e=n.nativeImage.createFromPath(${iconPathExpression});if(!e.isEmpty())return{defaultIcon:e,chronicleRunningIcon:null}}return{defaultIcon:await n.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`;
    if (patchedSource.includes(`nativeImage.createFromPath(${iconPathExpression})`)) {
      // Already patched.
    } else if (patchedSource.includes(trayIconNeedle)) {
      patchedSource = patchedSource.replace(trayIconNeedle, trayIconPatch);
    } else {
      console.warn("WARN: Could not find tray icon fallback — skipping Linux tray icon patch");
    }
  }

  const closeToTrayNeedle =
    "if(process.platform===`win32`&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}";
  const closeToTrayExistingPatch =
    "if((process.platform===`win32`||process.platform===`linux`)&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}";
  const closeToTrayPatch =
    "if((process.platform===`win32`||process.platform===`linux`)&&f===`local`&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}";
  const patchedCloseToTrayRegex =
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&[A-Za-z_$][\w$]*===`local`&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLastLocalWindowToTray\?\.\(\)===!0&&![A-Za-z_$][\w$]*\)\{[A-Za-z_$][\w$]*\.preventDefault\(\),[A-Za-z_$][\w$]*\.hide\(\);return\}/;
  if (patchedSource.includes(closeToTrayPatch)) {
    // Already patched.
  } else if (patchedSource.includes(closeToTrayExistingPatch)) {
    patchedSource = patchedSource.replace(closeToTrayExistingPatch, closeToTrayPatch);
  } else if (patchedSource.includes(closeToTrayNeedle)) {
    patchedSource = patchedSource.replace(closeToTrayNeedle, closeToTrayPatch);
  } else if (patchedCloseToTrayRegex.test(patchedSource)) {
    // Already patched with a newer minifier's window variable.
  } else {
    const closeToTrayRegex =
      /if\(process\.platform===`win32`&&([A-Za-z_$][\w$]*)===`local`&&!this\.isAppQuitting&&this\.options\.canHideLastLocalWindowToTray\?\.\(\)===!0&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)\.preventDefault\(\),([A-Za-z_$][\w$]*)\.hide\(\);return\}/;
    const closeToTrayMatch = patchedSource.match(closeToTrayRegex);
    if (closeToTrayMatch != null) {
      const [, hostVar, hasOtherWindowVar, eventVar, windowVar] = closeToTrayMatch;
      patchedSource = patchedSource.replace(
        closeToTrayRegex,
        `if((process.platform===\`win32\`||process.platform===\`linux\`)&&${hostVar}===\`local\`&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())&&this.options.canHideLastLocalWindowToTray?.()===!0&&!${hasOtherWindowVar}){${eventVar}.preventDefault(),${windowVar}.hide();return}`,
      );
    } else {
      console.warn("WARN: Could not find close-to-tray condition — skipping Linux close-to-tray patch");
    }
  }

  const trayContextMethodNeedle =
    "trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(";
  const trayContextMethodPatch =
    "trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};setLinuxTrayContextMenu(){let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());this.tray.setContextMenu?.(e);return e}constructor(";
  if (patchedSource.includes("setLinuxTrayContextMenu(){")) {
    // Already patched.
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
    "openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());";
  const trayMenuBuildExistingPatch =
    "openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=process.platform===`linux`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());";
  const trayMenuBuildPatch =
    "openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;this.updateChronicleTrayIcon();let e=process.platform===`linux`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());";
  if (patchedSource.includes("openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuBuildExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuBuildExistingPatch, trayMenuBuildPatch);
  } else if (patchedSource.includes(trayMenuBuildNeedle)) {
    patchedSource = patchedSource.replace(trayMenuBuildNeedle, trayMenuBuildPatch);
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

  return patchedSource;
}

function applyLinuxSingleInstancePatch(currentSource) {
  let patchedSource = currentSource;

  const singleInstanceLockNeedle =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});let A=Date.now();await n.app.whenReady()";
  const singleInstanceLockPatch =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});if(process.platform===`linux`&&!n.app.requestSingleInstanceLock()){n.app.quit();return}let A=Date.now();await n.app.whenReady()";
  if (patchedSource.includes("process.platform===`linux`&&!n.app.requestSingleInstanceLock()")) {
    // Already patched.
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
  if (currentSource.includes(approvalPatch)) {
    return currentSource;
  }

  const needle = "startup_timeout_sec:120,env:{";
  if (!currentSource.includes(needle)) {
    console.warn(
      "WARN: Could not find Browser Use node_repl config insertion point — skipping node_repl approval patch",
    );
    return currentSource;
  }

  return currentSource.replace(needle, approvalPatch);
}

function applyLinuxGitOriginsSourceFallbackPatch(currentSource) {
  const fallbackSource = "linux_git_origins_missing_source_fallback";
  if (currentSource.includes(`source:\`${fallbackSource}\`,requestKind:`)) {
    return currentSource;
  }

  const exactNeedle =
    "if(o==null){if(e.qt(r))throw Error(`Missing git operation source for ${r}`);return l()}return t.Gt({source:o,requestKind:r},l)";
  const exactReplacement =
    `if(o==null){if(e.qt(r)){if(r===\`git-origins\`)return t.Gt({source:\`${fallbackSource}\`,requestKind:r},l);throw Error(\`Missing git operation source for \${r}\`)}return l()}return t.Gt({source:o,requestKind:r},l)`;
  if (currentSource.includes(exactNeedle)) {
    return currentSource.replace(exactNeedle, exactReplacement);
  }

  const dynamicRegex =
    /if\(([A-Za-z_$][\w$]*)==null\)\{if\(([A-Za-z_$][\w$]*)\.qt\(([A-Za-z_$][\w$]*)\)\)throw Error\(`Missing git operation source for \$\{\3\}`\);return ([A-Za-z_$][\w$]*)\(\)\}return ([A-Za-z_$][\w$]*)\.Gt\(\{source:\1,requestKind:\3\},\4\)/;
  const dynamicMatch = currentSource.match(dynamicRegex);
  if (dynamicMatch != null) {
    const [, sourceVar, gitGuardVar, requestKindVar, callVar, operationContextVar] = dynamicMatch;
    return currentSource.replace(
      dynamicRegex,
      `if(${sourceVar}==null){if(${gitGuardVar}.qt(${requestKindVar})){if(${requestKindVar}===\`git-origins\`)return ${operationContextVar}.Gt({source:\`${fallbackSource}\`,requestKind:${requestKindVar}},${callVar});throw Error(\`Missing git operation source for \${${requestKindVar}}\`)}return ${callVar}()}return ${operationContextVar}.Gt({source:${sourceVar},requestKind:${requestKindVar}},${callVar})`,
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

module.exports = {
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWindowOptionsPatch,
};
