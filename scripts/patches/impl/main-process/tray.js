"use strict";

const { requireName } = require("../../lib/minified-js.js");

function applyLinuxTrayPatch(currentSource, iconPathExpression) {
  let patchedSource = currentSource;

  const closeToTrayPattern =
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&this\.options\.canHideLastWindowToTray\?\.\(\)===!0&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)\.preventDefault\(\),([A-Za-z_$][\w$]*)\.hide\(\);return\}/;
  const guardedCloseToTrayPattern =
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLastWindowToTray\?\.\(\)===!0&&![A-Za-z_$][\w$]*\)/;
  if (!guardedCloseToTrayPattern.test(patchedSource)) {
    const match = patchedSource.match(closeToTrayPattern);
    if (match == null) {
      console.warn("WARN: Could not find current Linux close-to-tray condition — skipping Linux tray quit guard patch");
      return currentSource;
    }
    const [, hasOtherWindowVar, eventVar, windowVar] = match;
    patchedSource = patchedSource.replace(
      closeToTrayPattern,
      `if((process.platform===\`win32\`||process.platform===\`linux\`)&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())&&this.options.canHideLastWindowToTray?.()===!0&&!${hasOtherWindowVar}){${eventVar}.preventDefault(),${windowVar}.hide();return}`,
    );
  }

  const trayWhenReadyFallbackPattern =
    /if\(typeof ([A-Za-z_$][\w$]*)\.whenReady!=`function`\)return process\.platform!==`linux`;try\{return await \1\.whenReady\(\),!0\}catch\{return!1\}/;
  const compatibleTrayWhenReadyPattern =
    /if\(typeof ([A-Za-z_$][\w$]*)\.whenReady!=`function`\)return!0;try\{return await \1\.whenReady\(\),!0\}catch\{return!1\}/;
  if (!compatibleTrayWhenReadyPattern.test(patchedSource)) {
    if (!trayWhenReadyFallbackPattern.test(patchedSource)) {
      console.warn("WARN: Could not find current Linux tray whenReady fallback — skipping Linux tray compatibility patch");
      return currentSource;
    }
    patchedSource = patchedSource.replace(
      trayWhenReadyFallbackPattern,
      "if(typeof $1.whenReady!=`function`)return!0;try{return await $1.whenReady(),!0}catch{return!1}",
    );
  }

  const trayIsReadyFallbackPattern =
    /return typeof ([A-Za-z_$][\w$]*)\.isReady==`function`\?\1\.isReady\(\):process\.platform!==`linux`/;
  const compatibleTrayIsReadyPattern =
    /return typeof ([A-Za-z_$][\w$]*)\.isReady==`function`\?\1\.isReady\(\):!0/;
  if (!compatibleTrayIsReadyPattern.test(patchedSource)) {
    if (!trayIsReadyFallbackPattern.test(patchedSource)) {
      console.warn("WARN: Could not find current Linux tray isReady fallback — skipping Linux tray compatibility patch");
      return currentSource;
    }
    patchedSource = patchedSource.replace(
      trayIsReadyFallbackPattern,
      "return typeof $1.isReady==`function`?$1.isReady():!0",
    );
  }

  if (
    iconPathExpression != null &&
    !patchedSource.includes("let __codexLinuxTrayFallbackIcon=")
  ) {
    const linuxTrayIconPattern =
      /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.nativeImage\.createFromPath\(([^;]+)\);if\(\1\.isEmpty\(\)\)throw Error\(`Linux tray application icon is unavailable`\)/;
    const match = patchedSource.match(linuxTrayIconPattern);
    if (match == null) {
      console.warn("WARN: Could not find current Linux tray icon loader — skipping Linux tray compatibility patch");
      return currentSource;
    }
    const [iconLoader, imageVar, electronVar, upstreamIconPath] = match;
    patchedSource = patchedSource.replace(
      iconLoader,
      `${imageVar}=${electronVar}.nativeImage.createFromPath(${upstreamIconPath});if(${imageVar}.isEmpty()){let __codexLinuxTrayFallbackIcon=${electronVar}.nativeImage.createFromPath(${iconPathExpression});if(!__codexLinuxTrayFallbackIcon.isEmpty())${imageVar}=__codexLinuxTrayFallbackIcon}if(${imageVar}.isEmpty())throw Error(\`Linux tray application icon is unavailable\`)`,
    );
  }

  const conditionalTrayConstructorPattern =
    /([A-Za-z_$][\w$]*)=typeof codexLinuxRegisterTray===`function`\?codexLinuxRegisterTray\(new ([A-Za-z_$][\w$]*)\.Tray\(([^;]+?)\)\):new \2\.Tray\(\3\)/;
  const retainedTrayConstructorPattern =
    /([A-Za-z_$][\w$]*)=codexLinuxRegisterTray\(new ([A-Za-z_$][\w$]*)\.Tray\(([^;]+?)\)\)/;
  const trayConstructorPattern =
    /([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\.Tray\(([^;)]+)\)/;
  const constructorMatch =
    patchedSource.match(conditionalTrayConstructorPattern) ??
    patchedSource.match(retainedTrayConstructorPattern) ??
    patchedSource.match(trayConstructorPattern);
  if (
    constructorMatch == null ||
    !patchedSource.includes("if(process.platform===`linux`){") ||
    !patchedSource.includes("updatePersistentTrayMenu(){process.platform===`linux`")
  ) {
    console.warn("WARN: Could not find current Linux tray factory — skipping Linux tray retention patch");
    return currentSource;
  }

  const [, trayVar, electronVar, constructorArgs] = constructorMatch;
  const retainedConstructor =
    `${trayVar}=codexLinuxRegisterTray(new ${electronVar}.Tray(${constructorArgs}))`;
  if (conditionalTrayConstructorPattern.test(patchedSource)) {
    patchedSource = patchedSource.replace(conditionalTrayConstructorPattern, retainedConstructor);
  } else if (!retainedTrayConstructorPattern.test(patchedSource)) {
    patchedSource = patchedSource.replace(trayConstructorPattern, retainedConstructor);
  }

  if (!patchedSource.includes("codexLinuxRegisterTray=e=>")) {
    const constructorIndex = patchedSource.indexOf(retainedConstructor);
    const factoryIndex = patchedSource.lastIndexOf("async function ", constructorIndex);
    if (constructorIndex === -1 || factoryIndex === -1) {
      console.warn("WARN: Could not find current Linux tray helper insertion point — skipping Linux tray retention patch");
      return currentSource;
    }
    const retentionHelper =
      "let codexLinuxTray=null,codexLinuxRegisterTray=e=>(codexLinuxTray=e,e);";
    patchedSource =
      patchedSource.slice(0, factoryIndex) +
      retentionHelper +
      patchedSource.slice(factoryIndex);
  }

  return patchedSource;
}

function buildLinuxBuildInfoHelpers(electronVar, fsVar, pathVar) {
  return `function codexLinuxBuildInfoPaths(){let __codexBuildInfoPaths=[];try{__codexBuildInfoPaths.push((0,${pathVar}.join)(process.resourcesPath,\`codex-linux-build-info.json\`)),__codexBuildInfoPaths.push((0,${pathVar}.join)(process.resourcesPath,\`..\`,\`.codex-linux\`,\`build-info.json\`))}catch{}return __codexBuildInfoPaths}function codexLinuxReadBuildInfo(){for(let __codexBuildInfoPath of codexLinuxBuildInfoPaths())try{if(${fsVar}.existsSync(__codexBuildInfoPath)){let __codexBuildInfo=JSON.parse(${fsVar}.readFileSync(__codexBuildInfoPath,\`utf8\`));if(__codexBuildInfo&&typeof __codexBuildInfo===\`object\`&&!Array.isArray(__codexBuildInfo))return{info:__codexBuildInfo,path:__codexBuildInfoPath}}}catch{}return{info:null,path:null}}function codexLinuxBuildInfoValue(__codexBuildInfoValue,__codexBuildInfoFallback=\`unknown\`){return typeof __codexBuildInfoValue===\`string\`&&__codexBuildInfoValue.trim().length>0?__codexBuildInfoValue:Array.isArray(__codexBuildInfoValue)&&__codexBuildInfoValue.length>0?__codexBuildInfoValue.join(\`, \`):__codexBuildInfoValue==null?__codexBuildInfoFallback:String(__codexBuildInfoValue)}function codexLinuxBuildInfoCommitUrl(__codexBuildInfo){let __codexBuildInfoCommitUrl=__codexBuildInfo?.source?.commitUrl;return typeof __codexBuildInfoCommitUrl===\`string\`&&/^https:\\/\\/github\\.com\\/[^/\\s]+\\/[^/\\s]+\\/commit\\/[0-9a-f]{7,40}$/i.test(__codexBuildInfoCommitUrl)?__codexBuildInfoCommitUrl:null}function codexLinuxGetBuildInfo(){let __codexBuildInfoResult=codexLinuxReadBuildInfo();return{...__codexBuildInfoResult,commitUrl:codexLinuxBuildInfoCommitUrl(__codexBuildInfoResult.info)}}function codexLinuxBuildInfoDetail(__codexBuildInfo,__codexBuildInfoPath){if(!__codexBuildInfo)return\`No Linux build metadata file was found in this app install.\`;let __codexBuildInfoTarget=__codexBuildInfo.linuxTarget??{},__codexBuildInfoDistro=__codexBuildInfoTarget.distro??{},__codexBuildInfoDmg=__codexBuildInfo.upstreamDmg??{},__codexBuildInfoSource=__codexBuildInfo.source??{},__codexBuildInfoFeatures=__codexBuildInfo.linuxFeatures?.enabled??[],__codexBuildInfoProfile=__codexBuildInfo.packageProfile??{},__codexBuildInfoCommit=__codexBuildInfoSource.commit||__codexBuildInfoSource.shortCommit,__codexBuildInfoCommitValue=__codexBuildInfoCommit?__codexBuildInfoSource.dirty?\`\${__codexBuildInfoCommit} (dirty)\`:__codexBuildInfoCommit:\`unknown\`,__codexBuildInfoDistroValue=__codexBuildInfoDistro.prettyName||[__codexBuildInfoDistro.id,__codexBuildInfoDistro.versionId].filter(Boolean).join(\` \`)||\`unknown\`,__codexBuildInfoCommitLink=codexLinuxBuildInfoCommitUrl(__codexBuildInfo);return[\`Metadata file: \${codexLinuxBuildInfoValue(__codexBuildInfoPath)}\`,\`Linux package profile: \${codexLinuxBuildInfoValue(__codexBuildInfoProfile.label)}\`,\`Distro: \${__codexBuildInfoDistroValue}\`,\`Package manager: \${codexLinuxBuildInfoValue(__codexBuildInfoTarget.packageManager??__codexBuildInfoProfile.packageManager)}\`,\`Package format: \${codexLinuxBuildInfoValue(__codexBuildInfoTarget.packageFormat??__codexBuildInfoProfile.format)}\`,\`Enabled features: \${__codexBuildInfoFeatures.length>0?__codexBuildInfoFeatures.join(\`, \`):\`none\`}\`,\`Upstream app version: \${codexLinuxBuildInfoValue(__codexBuildInfoDmg.appVersion)}\`,\`Upstream DMG SHA256: \${codexLinuxBuildInfoValue(__codexBuildInfoDmg.sha256)}\`,\`Electron: \${codexLinuxBuildInfoValue(__codexBuildInfo.electronVersion)}\`,\`Linux source commit: \${__codexBuildInfoCommitValue}\`,...(__codexBuildInfoCommitLink?[\`Source commit URL: \${__codexBuildInfoCommitLink}\`]:[]),\`Source branch: \${codexLinuxBuildInfoValue(__codexBuildInfoSource.branch)}\`,\`Generated: \${codexLinuxBuildInfoValue(__codexBuildInfo.generatedAt)}\`].join(\`\\n\`)}async function codexLinuxOpenBuildInfoCommit(){let __codexBuildInfoResult=codexLinuxGetBuildInfo();return __codexBuildInfoResult.commitUrl?(await ${electronVar}.shell?.openExternal(__codexBuildInfoResult.commitUrl),{success:!0}):{success:!1}}async function codexLinuxShowBuildInfo(){try{let __codexBuildInfoResult=codexLinuxGetBuildInfo(),__codexBuildInfoCommitUrl=__codexBuildInfoResult.commitUrl,__codexBuildInfoPath=__codexBuildInfoResult.path,__codexBuildInfoButtons=[],__codexBuildInfoButtonIndex=0;__codexBuildInfoCommitUrl&&__codexBuildInfoButtons.push(\`Open Source Commit\`),__codexBuildInfoPath&&__codexBuildInfoButtons.push(\`Open Metadata File\`),__codexBuildInfoButtons.push(\`OK\`);let __codexBuildInfoBoxResponse=await ${electronVar}.dialog?.showMessageBox({type:\`info\`,buttons:__codexBuildInfoButtons,defaultId:__codexBuildInfoButtons.length-1,cancelId:__codexBuildInfoButtons.length-1,message:\`ChatGPT Desktop for Linux build information\`,detail:codexLinuxBuildInfoDetail(__codexBuildInfoResult.info,__codexBuildInfoPath)});if(__codexBuildInfoCommitUrl&&__codexBuildInfoBoxResponse?.response===__codexBuildInfoButtonIndex++){await ${electronVar}.shell?.openExternal(__codexBuildInfoCommitUrl);return}if(__codexBuildInfoPath&&__codexBuildInfoBoxResponse?.response===__codexBuildInfoButtonIndex++)await ${electronVar}.shell?.openPath?.(__codexBuildInfoPath)}catch{}}`;
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
