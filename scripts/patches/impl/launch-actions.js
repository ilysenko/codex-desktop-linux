"use strict";

const {
  HANDLER_PREFIX_LOOKBACK,
  escapeRegExp,
  findDisposableVar,
  findLastRegexMatch,
  findLinuxGlobalStateExpression,
  findMatchingBrace,
  inferModuleAlias,
} = require("../lib/minified-js.js");
const {
  linuxSettingsKeys,
} = require("../lib/settings-keys.js");

// Launch-action patches keep second launches, hotkey windows, and persisted
// Linux settings coordinated with the generated launcher.
const linuxQuitStateHelpers =
  "let codexLinuxQuitInProgress=!1,codexLinuxExplicitQuitApproved=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()},codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0,codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0,";

function persistedLinuxSettingsKeysSource() {
  return `[${Object.values(linuxSettingsKeys).map((key) => `\`${key}\``).join(",")}]`;
}

function settingsPersistenceHelpersSource(pathVar, fsVar, stateFileVar) {
  return [
    stateFileVar == null ? "" : `var ${stateFileVar}=\`.codex-global-state.json\`;`,
    `function codexLinuxSettingsAppId(){let codexLinuxAppId=process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||\`codex-desktop\`;return/^[A-Za-z0-9._-]+$/.test(codexLinuxAppId)?codexLinuxAppId:\`codex-desktop\`}`,
    `function codexLinuxSettingsPath(){let codexLinuxExplicitSettingsPath=process.env.CODEX_LINUX_SETTINGS_FILE;if(typeof codexLinuxExplicitSettingsPath===\`string\`&&codexLinuxExplicitSettingsPath.length>0)return codexLinuxExplicitSettingsPath;let codexLinuxConfigHome=process.env.XDG_CONFIG_HOME||process.env.HOME&&${pathVar}.join(process.env.HOME,\`.config\`);return codexLinuxConfigHome?${pathVar}.join(codexLinuxConfigHome,codexLinuxSettingsAppId(),\`settings.json\`):null}`,
    `function codexLinuxReadSettingsFile(){let codexLinuxSettingsPathValue=codexLinuxSettingsPath();if(!codexLinuxSettingsPathValue||!${fsVar}.existsSync(codexLinuxSettingsPathValue))return{};try{let codexLinuxSettingsContents=${fsVar}.readFileSync(codexLinuxSettingsPathValue,\`utf8\`),codexLinuxSettingsValue=JSON.parse(codexLinuxSettingsContents);return codexLinuxSettingsValue&&typeof codexLinuxSettingsValue===\`object\`&&!Array.isArray(codexLinuxSettingsValue)?codexLinuxSettingsValue:{}}catch(codexLinuxSettingsReadError){return{}}}`,
    `function codexLinuxSettingsOwner(){return\`${"${process.pid??0}"}-${"${Date.now()}"}-${"${Math.random().toString(16).slice(2)}"}\`}`,
    `async function codexLinuxReleaseSettingsLock(codexLinuxLock){try{(await ${fsVar}.promises.readFile(codexLinuxLock.path,\`utf8\`)).split(\`\\n\`,1)[0]===codexLinuxLock.owner&&await ${fsVar}.promises.unlink(codexLinuxLock.path)}catch{}}`,
    `function codexLinuxSettingsOwnerIsAlive(codexLinuxOwner){let codexLinuxOwnerPid=Number(codexLinuxOwner.split(\`-\`,1)[0]);if(!Number.isInteger(codexLinuxOwnerPid)||codexLinuxOwnerPid<=0)return!1;try{return process.kill(codexLinuxOwnerPid,0),!0}catch(codexLinuxOwnerError){return codexLinuxOwnerError?.code===\`EPERM\`}}`,
    `async function codexLinuxRecoverSettingsLock(codexLinuxLockPath,codexLinuxClaimOwner){let codexLinuxLockSnapshot=await ${fsVar}.promises.readFile(codexLinuxLockPath,\`utf8\`),codexLinuxOriginalOwner=codexLinuxLockSnapshot.split(\`\\n\`,1)[0],codexLinuxLockStat=await ${fsVar}.promises.stat(codexLinuxLockPath);if(Date.now()-codexLinuxLockStat.mtimeMs<=3e4||codexLinuxSettingsOwnerIsAlive(codexLinuxOriginalOwner))return;let codexLinuxClaim=\`recover:${"${codexLinuxClaimOwner}"}\`,codexLinuxRecoveryRecords=codexLinuxLockSnapshot.split(\`\\n\`).slice(1,-1);if(!codexLinuxRecoveryRecords.includes(codexLinuxClaim)){let codexLinuxRecoveryFile=await ${fsVar}.promises.open(codexLinuxLockPath,\`a\`);try{await codexLinuxRecoveryFile.write((codexLinuxLockSnapshot.endsWith(\`\\n\`)?\`\`:\`\\n\`)+codexLinuxClaim+\`\\n\`),await codexLinuxRecoveryFile.sync()}finally{await codexLinuxRecoveryFile.close()}codexLinuxLockSnapshot=await ${fsVar}.promises.readFile(codexLinuxLockPath,\`utf8\`)}if(!codexLinuxLockSnapshot.endsWith(\`\\n\`)||codexLinuxLockSnapshot.split(\`\\n\`,1)[0]!==codexLinuxOriginalOwner)return;let codexLinuxFirstLiveClaim=codexLinuxLockSnapshot.split(\`\\n\`).slice(1,-1).find(codexLinuxRecord=>codexLinuxRecord.startsWith(\`recover:\`)&&codexLinuxSettingsOwnerIsAlive(codexLinuxRecord.slice(8)));codexLinuxFirstLiveClaim===codexLinuxClaim&&await ${fsVar}.promises.readFile(codexLinuxLockPath,\`utf8\`)===codexLinuxLockSnapshot&&await ${fsVar}.promises.unlink(codexLinuxLockPath)}`,
    `async function codexLinuxAcquireSettingsLock(codexLinuxSettingsPathValue){let codexLinuxLockPath=\`${"${codexLinuxSettingsPathValue}"}.lock\`,codexLinuxLockOwner=codexLinuxSettingsOwner(),codexLinuxLockDeadline=Date.now()+2e3;for(;;)try{let codexLinuxLockFile=await ${fsVar}.promises.open(codexLinuxLockPath,\`wx\`,384),codexLinuxLockInitError=null;try{await codexLinuxLockFile.writeFile(codexLinuxLockOwner+\`\\n\`),await codexLinuxLockFile.sync()}catch(codexLinuxLockWriteError){codexLinuxLockInitError=codexLinuxLockWriteError}finally{await codexLinuxLockFile.close()}if(codexLinuxLockInitError!=null){try{await ${fsVar}.promises.unlink(codexLinuxLockPath)}catch{}throw codexLinuxLockInitError}return{path:codexLinuxLockPath,owner:codexLinuxLockOwner}}catch(codexLinuxLockError){if(codexLinuxLockError?.code!==\`EEXIST\`)throw codexLinuxLockError;try{await codexLinuxRecoverSettingsLock(codexLinuxLockPath,codexLinuxLockOwner)}catch(codexLinuxRecoveryError){if(codexLinuxRecoveryError?.code!==\`ENOENT\`)throw codexLinuxRecoveryError}if(Date.now()>=codexLinuxLockDeadline)throw Error(\`Timed out waiting for settings lock ${"${codexLinuxLockPath}"}\`);await new Promise(codexLinuxRetry=>setTimeout(codexLinuxRetry,25))}}`,
    `async function codexLinuxPersistSettingsState(codexLinuxSettingsKey,codexLinuxSettingsNewValue){if(process.platform!==\`linux\`||!${persistedLinuxSettingsKeysSource()}.includes(codexLinuxSettingsKey))return;let codexLinuxSettingsLock=null,codexLinuxSettingsTempPath=null;try{let codexLinuxSettingsPathValue=codexLinuxSettingsPath();if(!codexLinuxSettingsPathValue)return;await ${fsVar}.promises.mkdir(${pathVar}.dirname(codexLinuxSettingsPathValue),{recursive:!0,mode:448}),codexLinuxSettingsLock=await codexLinuxAcquireSettingsLock(codexLinuxSettingsPathValue);let codexLinuxSettingsObject=codexLinuxReadSettingsFile();codexLinuxSettingsNewValue===void 0?delete codexLinuxSettingsObject[codexLinuxSettingsKey]:codexLinuxSettingsObject[codexLinuxSettingsKey]=codexLinuxSettingsNewValue,codexLinuxSettingsTempPath=\`${"${codexLinuxSettingsPathValue}"}.tmp.${"${codexLinuxSettingsOwner()}"}\`;let codexLinuxSettingsTempFile=await ${fsVar}.promises.open(codexLinuxSettingsTempPath,\`wx\`,384);try{await codexLinuxSettingsTempFile.writeFile(JSON.stringify(codexLinuxSettingsObject,null,2)+\`\\n\`,\`utf8\`),await codexLinuxSettingsTempFile.sync()}finally{await codexLinuxSettingsTempFile.close()}await ${fsVar}.promises.rename(codexLinuxSettingsTempPath,codexLinuxSettingsPathValue),codexLinuxSettingsTempPath=null}catch(codexLinuxSettingsWriteError){}finally{if(codexLinuxSettingsTempPath!=null)try{await ${fsVar}.promises.unlink(codexLinuxSettingsTempPath)}catch{}codexLinuxSettingsLock!=null&&await codexLinuxReleaseSettingsLock(codexLinuxSettingsLock)}}`,
  ].join("");
}

function applyLinuxSettingsPersistencePatch(currentSource) {
  let patchedSource = currentSource;

  if (
    !patchedSource.includes('"set-global-state"') &&
    !patchedSource.includes(".codex-global-state.json")
  ) {
    return patchedSource;
  }

  const pathVar = inferModuleAlias(patchedSource, "node:path");
  const fsVar = inferModuleAlias(patchedSource, "node:fs");
  if (pathVar == null || fsVar == null) {
    console.warn("WARN: Could not infer Linux settings path or fs module");
    return patchedSource;
  }
  if (!patchedSource.includes("function codexLinuxPersistSettingsState(")) {
    const stateFileHelperSource = (stateFileVar) =>
      settingsPersistenceHelpersSource(pathVar, fsVar, stateFileVar);
    const stateFileCommaRegex = /var ([A-Za-z_$][\w$]*)=`\.codex-global-state\.json`,/;
    const stateFileSemicolonRegex = /var ([A-Za-z_$][\w$]*)=`\.codex-global-state\.json`;/;
    if (pathVar == null || fsVar == null) {
      console.warn("WARN: Could not find Linux settings state file marker — skipping settings persistence patch");
      return patchedSource;
    }
    if (stateFileCommaRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        stateFileCommaRegex,
        (_match, stateFileVar) => `${stateFileHelperSource(stateFileVar)}var `,
      );
    } else if (stateFileSemicolonRegex.test(patchedSource)) {
      patchedSource = patchedSource.replace(
        stateFileSemicolonRegex,
        (_match, stateFileVar) => stateFileHelperSource(stateFileVar),
      );
    } else {
      const strictDirective = '"use strict";';
      const helperInsertionIndex = patchedSource.startsWith(strictDirective)
        ? strictDirective.length
        : 0;
      patchedSource =
        patchedSource.slice(0, helperInsertionIndex) +
        stateFileHelperSource(null) +
        patchedSource.slice(helperInsertionIndex);
    }
  } else if (!patchedSource.includes("function codexLinuxSettingsAppId()")) {
    const legacySettingsPathRegex =
      /function codexLinuxSettingsPath\(\)\{let ([A-Za-z_$][\w$]*)=process\.env\.XDG_CONFIG_HOME\|\|process\.env\.HOME&&([A-Za-z_$][\w$]*)\.join\(process\.env\.HOME,`\.config`\);return \1\?\2\.join\(\1,`codex-desktop`,`settings\.json`\):null\}/;
    patchedSource = patchedSource.replace(
      legacySettingsPathRegex,
      (_match, _configVar, pathVar) =>
        `function codexLinuxSettingsAppId(){let e=process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||\`codex-desktop\`;return/^[A-Za-z0-9._-]+$/.test(e)?e:\`codex-desktop\`}function codexLinuxSettingsPath(){let e=process.env.CODEX_LINUX_SETTINGS_FILE;if(typeof e===\`string\`&&e.length>0)return e;let t=process.env.XDG_CONFIG_HOME||process.env.HOME&&${pathVar}.join(process.env.HOME,\`.config\`);return t?${pathVar}.join(t,codexLinuxSettingsAppId(),\`settings.json\`):null}`,
    );
  }

  const settingsKeysGuard = `!${persistedLinuxSettingsKeysSource()}.includes(e)`;
  if (!patchedSource.includes(settingsKeysGuard)) {
    const oldSettingsKeysGuardRegex = /!\[[^\]]*`codex-linux-[^`]+`[^\]]*\]\.includes\(e\)/;
    patchedSource = patchedSource.replace(oldSettingsKeysGuardRegex, settingsKeysGuard);
  }

  if (/"set-global-state":async\(\{key:[A-Za-z_$][\w$]*,value:[A-Za-z_$][\w$]*,origin:[A-Za-z_$][\w$]*\}\)=>\([\s\S]{0,300}?await codexLinuxPersistSettingsState\(/.test(patchedSource)) {
    return patchedSource;
  }
  if (/"set-global-state":async\(\{key:[A-Za-z_$][\w$]*,value:[A-Za-z_$][\w$]*,origin:[A-Za-z_$][\w$]*\}\)=>\(this\.setGlobalStateValue\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\),await codexLinuxPersistSettingsState\(/.test(patchedSource)) {
    return patchedSource;
  }
  const setGlobalStateRegex =
    /"set-global-state":async\(\{key:([A-Za-z_$][\w$]*),value:([A-Za-z_$][\w$]*),origin:([A-Za-z_$][\w$]*)\}\)=>\((this\.(?:globalState\.set\(\1,\2\)|setGlobalStateValue\(\1,\2,\3\))),/;
  if (!setGlobalStateRegex.test(patchedSource)) {
    console.warn("WARN: Could not find Linux set-global-state needle — skipping settings persistence hook");
    return patchedSource;
  }

  return patchedSource.replace(
    setGlobalStateRegex,
    (_match, keyVar, valueVar, originVar, setterCall) =>
      `"set-global-state":async({key:${keyVar},value:${valueVar},origin:${originVar}})=>(${setterCall},await codexLinuxPersistSettingsState(${keyVar},${valueVar}),`,
  );
}

function buildSemanticLinuxLaunchActionPatch({
  setterVar,
  deepLinksVar,
  fallbackFn,
  openerFn,
  windowManagerVar,
  hostExpr,
  getPrimaryWindowCall,
  createFreshWindowMethod,
  currentWindowVar,
  createdWindowVar,
  routeVar,
  focusFn,
  notificationVar,
  globalStateExpr,
  reporterVar,
  disposableVar,
  appVar,
  freshWindowExpr,
}) {
  const notificationPrefix = notificationVar == null
    ? ""
    : `${notificationVar}.desktopNotificationManager.dismissByNavigationPath(e),`;
  const quitState = linuxQuitStateHelpers;
  const directHandler = appVar == null
    ? ""
    : `,codexLinuxSecondInstanceHandler=(e,t)=>{codexLinuxHandleLaunchActionArgsFallback(t,()=>{${fallbackFn}()})},codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===\`function\`&&codexLinuxMarkQuitInProgress()}`;
  const startup = appVar == null
    ? `process.platform===\`linux\`&&codexLinuxStartLaunchActionSocket();${setterVar}(e=>{codexLinuxHandleLaunchActionArgsFallback(e,()=>{${fallbackFn}()})});`
    : `process.platform===\`linux\`&&(${appVar}.app.on(\`before-quit\`,codexLinuxBeforeQuitHandler),${disposableVar}.add(()=>{${appVar}.app.off(\`before-quit\`,codexLinuxBeforeQuitHandler)}),codexLinuxStartLaunchActionSocket(),${appVar}.app.on(\`second-instance\`,codexLinuxSecondInstanceHandler),${disposableVar}.add(()=>{${appVar}.app.off(\`second-instance\`,codexLinuxSecondInstanceHandler)}));${setterVar}(e=>{codexLinuxHandleLaunchActionArgsFallback(e,()=>{${fallbackFn}()})});`;

  const ensureHostWindowCall = hostExpr == null ? `${windowManagerVar}.ensureHostWindow()` : `${windowManagerVar}.ensureHostWindow(${hostExpr})`;
  const createFreshWindow = freshWindowExpr ?? ((pathExpr) => `${windowManagerVar}.${createFreshWindowMethod}(${pathExpr})`);
  const defaultSocket =
    "codexLinuxDefaultLaunchActionSocket=()=>{let e=codexLinuxLaunchActionAppId(),t=codexLinuxLaunchActionInstanceId(),n=process.env.XDG_RUNTIME_DIR?.trim(),r=require(`node:path`);if(n&&n.length>0)return t?r.join(n,e,`instances`,t,`launch-action.sock`):r.join(n,e,`launch-action.sock`);let i=process.env.XDG_STATE_HOME?.trim(),a=process.env.HOME?.trim();if((!i||i.length===0)&&a&&a.length>0)i=r.join(a,`.local`,`state`);if(!i||i.length===0)return null;return t?r.join(i,e,`instances`,t,`launch-action.sock`):r.join(i,e,`launch-action.sock`)}";
  const startSocket =
    `codexLinuxStartLaunchActionSocket=()=>{if(process.platform!==\`linux\`)return;try{let e=process.env.CODEX_DESKTOP_LAUNCH_ACTION_SOCKET?.trim()||codexLinuxDefaultLaunchActionSocket();if(!e||!codexLinuxIsWarmStartEnabled())return;let n=require(\`node:path\`),r=require(\`node:fs\`),i=require(\`node:net\`);r.mkdirSync(n.dirname(e),{recursive:!0,mode:448}),r.rmSync(e,{force:!0});let a=i.createServer(t=>{let n=\`\`,r=!1,i=()=>{if(r)return;r=!0;let i=[];try{let e=JSON.parse(n.trim());Array.isArray(e.argv)&&(i=e.argv.filter(e=>typeof e===\`string\`))}catch(e){t.end?.(\`error\\n\`);return}codexLinuxHandleLaunchActionArgs(i).then(e=>e?void 0:${fallbackFn}()).then(()=>{t.end?.(\`ok\\n\`)}).catch(e=>{${reporterVar}.reportNonFatal(e instanceof Error?e:\`Failed to handle Linux launch action socket\`,{kind:\`linux-launch-action-socket-failed\`}),t.end?.(\`error\\n\`)})};t.on(\`error\`,e=>{${reporterVar}.reportNonFatal(e instanceof Error?e:\`Failed Linux launch action socket client\`,{kind:\`linux-launch-action-socket-client-error\`})}),t.setEncoding?.(\`utf8\`),t.on(\`data\`,e=>{n+=e,n.includes(\`\\n\`)?i():n.length>65536&&t.destroy()}),t.on(\`end\`,i)});a.on(\`error\`,e=>{${reporterVar}.reportNonFatal(e instanceof Error?e:\`Failed Linux launch action socket\`,{kind:\`linux-launch-action-socket-error\`})}),a.listen(e),${disposableVar}.add(()=>{a.close(),r.rmSync(e,{force:!0})})}catch(e){${reporterVar}.reportNonFatal(e instanceof Error?e:\`Failed to start Linux launch action socket\`,{kind:\`linux-launch-action-socket-start-failed\`})}}`;
  return `${quitState}codexLinuxGetSetting=e=>process.platform!==\`linux\`||${globalStateExpr}.get(e)!==!1,codexLinuxIsTrayEnabled=()=>codexLinuxGetSetting(\`${linuxSettingsKeys.systemTray}\`),codexLinuxIsWarmStartEnabled=()=>codexLinuxGetSetting(\`${linuxSettingsKeys.warmStart}\`),codexLinuxIsPromptWindowEnabled=()=>codexLinuxGetSetting(\`${linuxSettingsKeys.promptWindow}\`),codexLinuxLaunchActionAppId=()=>{let e=process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||\`codex-desktop\`;return/^[A-Za-z0-9._-]+$/.test(e)?e:\`codex-desktop\`},codexLinuxLaunchActionInstanceId=()=>{let e=process.env.CODEX_LINUX_INSTANCE_ID?.trim();return e&&/^[A-Za-z0-9._-]+$/.test(e)?e:null},${defaultSocket},${openerFn}=async(e,t)=>{${windowManagerVar}.hotkeyWindowLifecycleManager.hide();let ${currentWindowVar}=${getPrimaryWindowCall},${createdWindowVar}=${currentWindowVar}??await ${createFreshWindow("e")};${createdWindowVar}!=null&&(${notificationPrefix}${currentWindowVar}!=null&&t.navigateExistingWindow&&${routeVar}.navigateToRoute(${createdWindowVar},e),${focusFn}(${createdWindowVar}))},codexLinuxGetHotkeyWindowController=()=>typeof ${windowManagerVar}.hotkeyWindowLifecycleManager.ensureHotkeyWindowController===\`function\`?${windowManagerVar}.hotkeyWindowLifecycleManager.ensureHotkeyWindowController():${windowManagerVar}.hotkeyWindowLifecycleManager,codexLinuxShowHotkeyWindow=async()=>{let e=codexLinuxGetHotkeyWindowController();typeof e.openHome===\`function\`?await e.openHome():typeof e.show===\`function\`?await e.show():await ${ensureHostWindowCall}},codexLinuxOpenQuickChat=async()=>{${windowManagerVar}.hotkeyWindowLifecycleManager.hide();let e=${getPrimaryWindowCall},t=e??await ${createFreshWindow("`/`")};t!=null&&(${windowManagerVar}.windowManager.sendMessageToWindow(t,{type:\`new-quick-chat\`}),${focusFn}(t))},codexLinuxHasDeepLink=e=>Array.isArray(e)&&e.some(e=>typeof e===\`string\`&&(e.startsWith(\`codex://\`)||e.startsWith(\`codex-browser-sidebar://\`))),codexLinuxHandleLaunchActionArgs=async e=>(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())?!0:codexLinuxHasDeepLink(e)&&${deepLinksVar}.deepLinks.queueProcessArgs(e)?!0:Array.isArray(e)&&(e.includes(\`--prompt-chat\`)||e.includes(\`--hotkey-window\`))?(codexLinuxIsPromptWindowEnabled()?(await codexLinuxShowHotkeyWindow(),!0):!1):Array.isArray(e)&&e.includes(\`--quick-chat\`)?(await codexLinuxOpenQuickChat(),!0):Array.isArray(e)&&e.includes(\`--new-chat\`)?(await ${openerFn}(\`/\`,{navigateExistingWindow:!0}),!0):!1,codexLinuxHandleLaunchActionArgsFallback=(e,t)=>{if(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())return;codexLinuxHandleLaunchActionArgs(e).then(e=>{e||t()}).catch(e=>{${reporterVar}.reportNonFatal(e instanceof Error?e:\`Failed to handle Linux launch action\`,{kind:\`linux-launch-action-failed\`}),t()})},codexLinuxPrewarmHotkeyWindow=()=>{if(!codexLinuxIsPromptWindowEnabled())return;try{let e=codexLinuxGetHotkeyWindowController();typeof e.prewarm===\`function\`&&e.prewarm()}catch(e){${reporterVar}.reportNonFatal(e instanceof Error?e:\`Failed to prewarm Linux hotkey window\`,{kind:\`linux-hotkey-window-prewarm-failed\`})}},${startSocket}${directHandler};${startup}`;
}

function applyCurrentSemanticLinuxLaunchActionArgsPatch(currentSource) {
  const handlerRegex =
    /([A-Za-z_$][\w$]*)\(e=>\{let ([A-Za-z_$][\w$]*)=[^;{}]+;if\(([A-Za-z_$][\w$]*)\.deepLinks\.queueProcessArgs\(e\)\)\{\2&&([A-Za-z_$][\w$]*)\(\);return\}if\(\2\)\{\4\(\);return\}\4\(\)\}\);let ([A-Za-z_$][\w$]*)=async\(e,t\)=>\{/g;
  let match;
  while ((match = handlerRegex.exec(currentSource)) != null) {
    const [, setterVar, , deepLinksVar, fallbackFn, openerFn] = match;
    const openerBraceIndex = match.index + match[0].length - 1;
    const openerLetIndex = openerBraceIndex - `let ${openerFn}=async(e,t)=>`.length;
    const openerEnd = findMatchingBrace(currentSource, openerBraceIndex);
    if (openerEnd === -1) {
      continue;
    }

    const separator = currentSource[openerEnd + 1];
    if (separator !== ";" && separator !== ",") {
      continue;
    }

    const openerText = currentSource.slice(openerLetIndex, openerEnd + 1);
    let openerVars = openerText.match(
      /([A-Za-z_$][\w$]*)\.hotkeyWindowLifecycleManager\.hide\(\);let ([A-Za-z_$][\w$]*)=\1\.getPrimaryWindow(?:\(([^)]*)\))?,([A-Za-z_$][\w$]*)=\2\?\?await \1\.(createFreshLocalWindow|createFreshWindow)\(e\);/,
    );
    let freshWindowExpr;
    if (openerVars == null) {
      const wrapperVars = openerText.match(
        /([A-Za-z_$][\w$]*)\.hotkeyWindowLifecycleManager\.hide\(\);let ([A-Za-z_$][\w$]*)=\1\.getPrimaryWindow(?:\(([^)]*)\))?,([A-Za-z_$][\w$]*)=\2\?\?await ([A-Za-z_$][\w$]*)\(e\);/,
      );
      if (wrapperVars != null) {
        const [, windowManagerVar, currentWindowVar, hostExprRaw, createdWindowVar, wrapperFn] = wrapperVars;
        const wrapperDefinition = new RegExp(
          `${escapeRegExp(wrapperFn)}=([A-Za-z_$][\\w$]*)=>[A-Za-z_$][\\w$]*\\?${escapeRegExp(windowManagerVar)}\\.createFresh(?:Local)?Window\\(\\1\\):Promise\\.resolve\\(null\\)`,
        );
        if (wrapperDefinition.test(currentSource.slice(Math.max(0, match.index - HANDLER_PREFIX_LOOKBACK), match.index))) {
          openerVars = [wrapperVars[0], windowManagerVar, currentWindowVar, hostExprRaw, createdWindowVar, "createFreshWindow"];
          freshWindowExpr = (pathExpr) => `${wrapperFn}(${pathExpr})`;
        }
      }
    }
    if (openerVars == null) {
      continue;
    }

    const [, windowManagerVar, currentWindowVar, hostExprRaw, createdWindowVar, createFreshWindowMethod] = openerVars;
    const routeVar = openerText.match(/([A-Za-z_$][\w$]*)\.navigateToRoute\([A-Za-z_$][\w$]*,e\)/)?.[1];
    const focusFn = openerText.match(new RegExp(`,([A-Za-z_$][\\w$]*)\\(${escapeRegExp(createdWindowVar)}\\)\\)\\}$`))?.[1];
    if (routeVar == null || focusFn == null) {
      continue;
    }

    const prefix = currentSource.slice(Math.max(0, match.index - HANDLER_PREFIX_LOOKBACK), match.index);
    const globalStateExpr = findLinuxGlobalStateExpression(prefix);
    const hostExpr =
      hostExprRaw?.trim() ||
      prefix.match(/localHost:([A-Za-z_$][\w$]*)/)?.[1] ||
      null;
    const getPrimaryWindowCall = hostExpr == null
      ? `${windowManagerVar}.getPrimaryWindow()`
      : `${windowManagerVar}.getPrimaryWindow(${hostExpr})`;
    const reporterVar = findLastRegexMatch(
      prefix,
      /([A-Za-z_$][\w$]*)\.reportNonFatal\(e instanceof Error\?e:`Failed to open window on second instance`/g,
    )?.[1] ?? findLastRegexMatch(prefix, /([A-Za-z_$][\w$]*)=\{reportNonFatal/g)?.[1];
    const disposableVar = findDisposableVar(prefix);
    if (globalStateExpr == null || reporterVar == null || disposableVar == null) {
      continue;
    }

    const notificationVar = openerText.match(
      /([A-Za-z_$][\w$]*)\.desktopNotificationManager\.dismissByNavigationPath\(e\)/,
    )?.[1] ?? null;
    const replacement = buildSemanticLinuxLaunchActionPatch({
      setterVar,
      deepLinksVar,
      fallbackFn,
      openerFn,
      windowManagerVar,
      hostExpr,
      getPrimaryWindowCall,
      createFreshWindowMethod,
      currentWindowVar,
      createdWindowVar,
      routeVar,
      focusFn,
      notificationVar,
      globalStateExpr,
      reporterVar,
      disposableVar,
      appVar: null,
      freshWindowExpr,
    });
    const suffix = separator === "," ? "let " : "";
    return currentSource.slice(0, match.index) + replacement + suffix + currentSource.slice(openerEnd + 2);
  }

  return currentSource;
}

function applyLinuxLaunchActionArgsPatch(currentSource) {
  let patchedSource = currentSource;

  if (
    patchedSource.includes("codexLinuxQuitInProgress=!1") &&
    patchedSource.includes("codexLinuxExplicitQuitApproved=!1") &&
    patchedSource.includes("codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0}") &&
    patchedSource.includes("codexLinuxPrepareForExplicitQuit=()=>{codexLinuxExplicitQuitApproved=!0,codexLinuxMarkQuitInProgress()}") &&
    patchedSource.includes("codexLinuxShouldBypassQuitPrompt=()=>codexLinuxExplicitQuitApproved===!0") &&
    patchedSource.includes("codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0") &&
    patchedSource.includes("codexLinuxGetSetting=e=>") &&
    patchedSource.includes("codexLinuxGetHotkeyWindowController=()=>") &&
    patchedSource.includes("codexLinuxPrewarmHotkeyWindow=()=>") &&
    patchedSource.includes("codexLinuxStartLaunchActionSocket=()=>") &&
    (
      patchedSource.includes("n.app.on(`before-quit`,codexLinuxBeforeQuitHandler)") ||
      /process\.platform===`linux`&&codexLinuxStartLaunchActionSocket\(\);[A-Za-z_$][\w$]*\(e=>\{codexLinuxHandleLaunchActionArgsFallback\(e,\(\)=>\{[A-Za-z_$][\w$]*\(\)\}\)\}\)/.test(patchedSource)
    ) &&
    !patchedSource.includes("codexLinuxOpenNewChat")
  ) {
    return patchedSource;
  }

  const currentSemanticLaunchActionPatch = applyCurrentSemanticLinuxLaunchActionArgsPatch(patchedSource);
  if (currentSemanticLaunchActionPatch !== patchedSource) {
    return currentSemanticLaunchActionPatch;
  }

  if (
    patchedSource.includes("Launching app") &&
    patchedSource.includes("deepLinks")
  ) {
    console.warn("WARN: Could not find Linux launch action handler - skipping --new-chat/--quick-chat/--prompt-chat patch");
    return patchedSource;
  }

  if (patchedSource.includes("Launching app") && !patchedSource.includes("codexLinuxGetSetting=e=>")) {
    console.warn("WARN: Linux launch action patch was not settings-gated - skipping --new-chat/--quick-chat/--prompt-chat patch");
  }

  return patchedSource;
}

function applyLinuxHotkeyWindowPrewarmPatch(currentSource) {
  let patchedSource = currentSource;

  if (!patchedSource.includes("codexLinuxPrewarmHotkeyWindow=()=>")) {
    return patchedSource;
  }

  if (
    /process\.platform===`linux`&&codexLinuxPrewarmHotkeyWindow\(\),[A-Za-z_$][\w$]*=Date\.now\(\),await [A-Za-z_$][\w$]*\.deepLinks\.flushPendingDeepLinks\(\)/.test(patchedSource)
  ) {
    return patchedSource;
  }

  const dynamicStartupPrewarmRegex =
    /(([A-Za-z_$][\w$]*)\(`(?:local )?window ensured`,([A-Za-z_$][\w$]*),\{(?:hostId:[^,{}]+,localWindowVisible:[^}]+|windowVisible:[^}]+)\}\),)\3=Date\.now\(\),await ([A-Za-z_$][\w$]*)\.deepLinks\.flushPendingDeepLinks\(\)/;
  const dynamicStartupPrewarmMatch = patchedSource.match(dynamicStartupPrewarmRegex);
  if (dynamicStartupPrewarmMatch != null) {
    const [, prefix, _traceVar, timeVar, deepLinksVar] = dynamicStartupPrewarmMatch;
    patchedSource = patchedSource.replace(
      dynamicStartupPrewarmRegex,
      `${prefix}process.platform===\`linux\`&&codexLinuxPrewarmHotkeyWindow(),${timeVar}=Date.now(),await ${deepLinksVar}.deepLinks.flushPendingDeepLinks()`,
    );
  } else {
    console.warn("WARN: Could not find Linux hotkey window prewarm insertion point — skipping startup prewarm patch");
  }

  return patchedSource;
}

module.exports = {
  applyLinuxHotkeyWindowPrewarmPatch,
  applyLinuxLaunchActionArgsPatch,
  applyLinuxSettingsPersistencePatch,
};
