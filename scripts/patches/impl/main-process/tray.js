"use strict";

const {
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findMatchingBrace,
  requireName,
} = require("../../lib/minified-js.js");

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
    /let ([A-Za-z_$][\w$]*)=async\(\)=>\{[A-Za-z_$][\w$]*=!0;try\{await ([A-Za-z_$][\w$]*)\(\{(?:buildFlavor|appBrand):/g;
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
    const linuxIconFallback =
      `if(process.platform===\`linux\`){let __codexLinuxTrayIcon=${electronVar}.nativeImage.createFromPath(${packagedTrayIconPathExpression});if(!__codexLinuxTrayIcon.isEmpty())return{defaultIcon:__codexLinuxTrayIcon,chronicleRunningIcon:null};let __codexLinuxAppIcon=${electronVar}.nativeImage.createFromPath(${packagedAppIconPathExpression});if(!__codexLinuxAppIcon.isEmpty())return{defaultIcon:__codexLinuxAppIcon,chronicleRunningIcon:null};let __codexLinuxUpstreamTrayIcon=${electronVar}.nativeImage.createFromPath(${iconPathExpression});if(!__codexLinuxUpstreamTrayIcon.isEmpty())return{defaultIcon:__codexLinuxUpstreamTrayIcon,chronicleRunningIcon:null}}`;
    const legacyGetFileIconSize = `process.platform===\`win32\`?\`small\`:\`normal\``;
    const trayIconNeedle =
      `for(let e of o){let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await ${electronVar}.app.getFileIcon(process.execPath,{size:${legacyGetFileIconSize}}),chronicleRunningIcon:null}}`;
    const trayIconPatch =
      `for(let e of o){let t=${electronVar}.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}${linuxIconFallback}return{defaultIcon:await ${electronVar}.app.getFileIcon(process.execPath,{size:${legacyGetFileIconSize}}),chronicleRunningIcon:null}}`;
    const trayIconFallbackRegex =
      /for\(let ([A-Za-z_$][\w$]*) of ([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(\1\);if\(!\3\.isEmpty\(\)\)return\{defaultIcon:\3,chronicleRunningIcon:null\}\}return\{defaultIcon:await \4\.app\.getFileIcon\(process\.execPath,\{size:((?:process\.platform===`win32`\?`small`:`normal`)|`small`|`normal`)\}\),chronicleRunningIcon:null\}\}/;
    if (
      patchedSource.includes(`nativeImage.createFromPath(${packagedTrayIconPathExpression})`) ||
      patchedSource.includes(`nativeImage.createFromPath(${packagedAppIconPathExpression})`)
    ) {
      // Already patched.
    } else if (patchedSource.includes(trayIconNeedle)) {
      patchedSource = patchedSource.replace(trayIconNeedle, trayIconPatch);
    } else if (trayIconFallbackRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        trayIconFallbackRegex,
        (_match, iconPathVar, candidatesVar, imageVar, electronAlias, sizeExpression) =>
          `for(let ${iconPathVar} of ${candidatesVar}){let ${imageVar}=${electronAlias}.nativeImage.createFromPath(${iconPathVar});if(!${imageVar}.isEmpty())return{defaultIcon:${imageVar},chronicleRunningIcon:null}}if(process.platform===\`linux\`){let __codexLinuxTrayIcon=${electronAlias}.nativeImage.createFromPath(${packagedTrayIconPathExpression});if(!__codexLinuxTrayIcon.isEmpty())return{defaultIcon:__codexLinuxTrayIcon,chronicleRunningIcon:null};let __codexLinuxAppIcon=${electronAlias}.nativeImage.createFromPath(${packagedAppIconPathExpression});if(!__codexLinuxAppIcon.isEmpty())return{defaultIcon:__codexLinuxAppIcon,chronicleRunningIcon:null};let __codexLinuxUpstreamTrayIcon=${electronAlias}.nativeImage.createFromPath(${iconPathExpression});if(!__codexLinuxUpstreamTrayIcon.isEmpty())return{defaultIcon:__codexLinuxUpstreamTrayIcon,chronicleRunningIcon:null}}return{defaultIcon:await ${electronAlias}.app.getFileIcon(process.execPath,{size:${sizeExpression}}),chronicleRunningIcon:null}}`,
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

module.exports = {
  applyLinuxBuildInfoTrayPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
};
