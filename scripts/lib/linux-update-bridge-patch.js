const fs = require("fs");
const path = require("path");

function requireName(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`([A-Za-z_$][\\w$]*)=require\\([\\\`'"]${escaped}[\\\`'"]\\)`))?.[1] ?? null;
}

function buildUpdateManagerEnvSource() {
  return "function codexLinuxUpdateManagerEnv(){let e={...process.env},t=process.env.CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE,n=t==null?void 0:process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE??t,r=process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE==null?process.env.CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE:process.env.CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE;n===`unset`?delete e.LD_LIBRARY_PATH:n===`empty`?e.LD_LIBRARY_PATH=``:n===`value`&&typeof r==`string`&&(e.LD_LIBRARY_PATH=r);for(let t of[`CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_STATE`,`CODEX_LINUX_ORIGINAL_LD_LIBRARY_PATH_VALUE`,`CODEX_LINUX_HOST_LD_LIBRARY_PATH_STATE`,`CODEX_LINUX_HOST_LD_LIBRARY_PATH_VALUE`])delete e[t];return e}";
}

function buildInstallAfterQuitSource(childProcessVar) {
  return `function codexLinuxInstallAfterQuit(){try{let e=${childProcessVar}.spawn(\`/bin/sh\`,[\`-c\`,\`for i in 1 2 3 4 5 6 7 8 9 10;do sleep 1;s="$("$1" status 2>/dev/null||true)";echo "$s"|grep -q "^status: WaitingForAppExit"&&continue;echo "$s"|grep -q "^status: Installing"&&continue;"$1" install-ready||exit $?;s="$("$1" status 2>/dev/null||true)";echo "$s"|grep -q "^status: WaitingForAppExit"&&continue;echo "$s"|grep -q "^status: Installing"&&continue;if echo "$s"|grep -q "^status: Installed";then (/usr/bin/codex-desktop >/dev/null 2>&1 &);fi;exit 0;done\`,\`codex-linux-update-install\`,codexLinuxUpdateManagerPath()],{detached:!0,stdio:\`ignore\`,windowsHide:!0});e.unref?.()}catch{}}`;
}

function replaceAfter(source, anchor, search, replacement) {
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) {
    return source;
  }
  const matchIndex = source.indexOf(search, anchorIndex);
  if (matchIndex === -1) {
    return source;
  }
  return source.slice(0, matchIndex) + replacement + source.slice(matchIndex + search.length);
}

function buildElectronResolverSource() {
  return "function codexLinuxGetElectronModule(){try{return require(`electron`)}catch{return null}}";
}

function buildQuitForUpdateSource(callInstallAfterQuit) {
  const prefix = callInstallAfterQuit ? "codexLinuxInstallAfterQuit();" : "";
  return `function codexLinuxQuitForUpdate(){try{${prefix}let t=codexLinuxGetElectronModule();if(!t)return;let e=setTimeout(()=>t.app?.exit?.(0),1500);e.unref?.(),t.app?.quit?.()}catch{}}`;
}

function buildBridgeSource({ childProcessVar, fsVar, pathVar }) {
  const showUpdateMessage =
    `async function codexLinuxShowUpdateMessage(codexLinuxMessage,codexLinuxDetail){try{let e=codexLinuxGetElectronModule();if(!e)return;await e.dialog?.showMessageBox({type:\`info\`,buttons:[\`OK\`],defaultId:0,noLink:!0,message:codexLinuxMessage,detail:codexLinuxDetail})}catch{}}`;
  const installAfterQuit = buildInstallAfterQuitSource(childProcessVar);
  const quitForUpdate = buildQuitForUpdateSource(true);
  return `${buildElectronResolverSource()}function codexLinuxUpdateStatePath(){let e=process.env.XDG_STATE_HOME||process.env.HOME&&(0,${pathVar}.join)(process.env.HOME,\`.local\`,\`state\`);return e?(0,${pathVar}.join)(e,\`codex-update-manager\`,\`state.json\`):null}function codexLinuxReadUpdateState(){let e=codexLinuxUpdateStatePath();if(!e||!${fsVar}.existsSync(e))return null;try{let t=JSON.parse(${fsVar}.readFileSync(e,\`utf8\`));return t&&typeof t===\`object\`&&!Array.isArray(t)?t:null}catch{return null}}function codexLinuxUpdateLifecycleState(e){switch(e){case\`ready_to_install\`:case\`waiting_for_app_exit\`:return\`ready\`;case\`installing\`:return\`installing\`;case\`checking_upstream\`:case\`update_detected\`:case\`downloading_dmg\`:case\`preparing_workspace\`:case\`patching_app\`:case\`building_package\`:return\`checking\`;default:return\`idle\`}}function codexLinuxUpdateManagerPath(){let e=process.env.CODEX_UPDATE_MANAGER_PATH;return typeof e===\`string\`&&e.trim().length>0?e:\`codex-update-manager\`}${showUpdateMessage}${installAfterQuit}${quitForUpdate}function codexLinuxRunUpdateManager(e){return new Promise((t,n)=>{${childProcessVar}.execFile(codexLinuxUpdateManagerPath(),e,{encoding:\`utf8\`,windowsHide:!0},(e,r,i)=>{if(e){e.stdout=r,e.stderr=i,n(e);return}t({stdout:r??\`\`,stderr:i??\`\`})})})}async function codexLinuxProbeUpdateManager(){await codexLinuxRunUpdateManager([\`--help\`])}async function codexLinuxRefreshUpdateState(){return codexLinuxReadUpdateState()}`;
}

function migrateLinuxUpdaterBridgeSource(source) {
  let patchedSource = source.replace(
    "async function codexLinuxRefreshUpdateState(){await codexLinuxRunUpdateManager([`status`,`--json`]);return codexLinuxReadUpdateState()}",
    "async function codexLinuxRefreshUpdateState(){return codexLinuxReadUpdateState()}",
  );
  if (patchedSource.includes("function codexLinuxRunUpdateManager(")) {
    if (!patchedSource.includes("function codexLinuxUpdateManagerEnv(")) {
      patchedSource = patchedSource.replace(
        "function codexLinuxUpdateStatePath(",
        `${buildUpdateManagerEnvSource()}function codexLinuxUpdateStatePath(`,
      );
    }
    if (patchedSource.includes("function codexLinuxUpdateManagerEnv(")) {
      patchedSource = patchedSource
        .replace(
          "{encoding:`utf8`,windowsHide:!0}",
          "{encoding:`utf8`,windowsHide:!0,env:codexLinuxUpdateManagerEnv()}",
        )
        .replace(
          "{detached:!0,stdio:`ignore`,windowsHide:!0}",
          "{detached:!0,stdio:`ignore`,windowsHide:!0,env:codexLinuxUpdateManagerEnv()}",
        );
    }
  }
  const probeSource =
    "async function codexLinuxProbeUpdateManager(){await codexLinuxRunUpdateManager([`--help`])}";
  const refreshSource =
    "async function codexLinuxRefreshUpdateState(){return codexLinuxReadUpdateState()}";
  if (
    patchedSource.includes("function codexLinuxRunUpdateManager(") &&
    patchedSource.includes(refreshSource) &&
    !patchedSource.includes(probeSource)
  ) {
    patchedSource = patchedSource.replace(
      refreshSource,
      `${probeSource}${refreshSource}`,
    );
  }

  const bootstrapNeedle = "function codexLinuxCreatePackageUpdateManager(";
  const isBootstrapSource = patchedSource.includes(bootstrapNeedle);
  if (
    patchedSource.includes("function codexLinuxRunUpdateManager(") &&
    isBootstrapSource &&
    (!patchedSource.includes(probeSource) || !patchedSource.includes(refreshSource))
  ) {
    const helperSource =
      `${patchedSource.includes(probeSource) ? "" : probeSource}` +
      `${patchedSource.includes(refreshSource) ? "" : refreshSource}`;
    patchedSource = patchedSource.replace(bootstrapNeedle, `${helperSource}${bootstrapNeedle}`);
  }

  patchedSource = patchedSource.replace(
    "await codexLinuxRefreshUpdateState(),e()",
    "await codexLinuxProbeUpdateManager(),e()",
  );

  const probeStateSource =
    "let s=!1,c=codexLinuxProbeUpdateManager().then(()=>{s=!0,i(),a();return!0}).catch(()=>{s=!1,t=!1,n=`idle`,a();return!1});let o=";
  const hasProbeState = () => patchedSource.includes("c=codexLinuxProbeUpdateManager().then(");
  if (isBootstrapSource && !hasProbeState() && patchedSource.includes(probeSource)) {
    patchedSource = replaceAfter(
      patchedSource,
      bootstrapNeedle,
      "i(),codexLinuxRefreshUpdateState().then(()=>{i(),a()}).catch(()=>{});let o=",
      probeStateSource,
    );
    patchedSource = replaceAfter(patchedSource, bootstrapNeedle, "i();let o=", probeStateSource);
  }

  if (!isBootstrapSource || !hasProbeState()) {
    return patchedSource;
  }

  patchedSource = replaceAfter(
    patchedSource,
    bootstrapNeedle,
    "getIsUpdateReady:()=>t,getUpdateLifecycleState:()=>n,",
    "getIsUpdateReady:()=>s&&t,getUpdateLifecycleState:()=>s?n:`idle`,",
  );
  patchedSource = replaceAfter(
    patchedSource,
    bootstrapNeedle,
    "checkForUpdates:async()=>{n=`checking`,a();try{",
    "checkForUpdates:async()=>{if(!await c)return;n=`checking`,a();try{",
  );
  patchedSource = replaceAfter(
    patchedSource,
    bootstrapNeedle,
    "installUpdatesIfAvailable:async()=>{i();if(!t){a();return}",
    "installUpdatesIfAvailable:async()=>{if(!await c){a();return}i();if(!t){a();return}",
  );
  patchedSource = replaceAfter(
    patchedSource,
    bootstrapNeedle,
    "installUpdatesIfAvailable:async()=>{i();if(!t)return;",
    "installUpdatesIfAvailable:async()=>{if(!await c){a();return}i();if(!t){a();return}",
  );
  patchedSource = replaceAfter(
    patchedSource,
    bootstrapNeedle,
    "refresh:async()=>{try{await codexLinuxRefreshUpdateState()}catch{}i(),a()}",
    "refresh:async()=>{if(await c){try{await codexLinuxRefreshUpdateState()}catch{}i()}else t=!1,n=`idle`;a()}",
  );
  return replaceAfter(
    patchedSource,
    bootstrapNeedle,
    "refresh:()=>{i(),a()}",
    "refresh:async()=>{if(await c){try{await codexLinuxRefreshUpdateState()}catch{}i()}else t=!1,n=`idle`;a()}",
  );
}

function buildBootstrapBridgeSource({ childProcessVar, fsVar, pathVar }) {
  return `${buildBridgeSource({ childProcessVar, fsVar, pathVar })};function codexLinuxCreatePackageUpdateManager(e){let t=!1,n=\`idle\`,r=null,i=()=>{try{let e=codexLinuxReadUpdateState(),r=e?.status;t=r===\`ready_to_install\`||r===\`waiting_for_app_exit\`,n=codexLinuxUpdateLifecycleState(r);return e}catch{return null}},a=()=>{try{e.send({type:\`app-update-ready-changed\`,isUpdateReady:t}),e.send({type:\`app-update-lifecycle-state-changed\`,lifecycleState:n}),e.send({type:\`app-update-install-progress-changed\`,installProgressPercent:r})}catch{}},s=!1,c=codexLinuxProbeUpdateManager().then(()=>{s=!0,i(),a();return!0}).catch(()=>{s=!1,t=!1,n=\`idle\`,a();return!1});let o=()=>{e.allowQuit?.();codexLinuxQuitForUpdate()};return{manager:{setAutomaticBackgroundDownloadsEnabled:()=>{},getIsUpdateReady:()=>s&&t,getUpdateLifecycleState:()=>s?n:\`idle\`,getInstallProgressPercent:()=>r,checkForUpdates:async()=>{if(!await c)return;n=\`checking\`,a();try{await codexLinuxRunUpdateManager([\`check-now\`]),i(),a()}catch(e){n=t?\`ready\`:\`idle\`,a();throw e}},installUpdatesIfAvailable:async()=>{if(!await c){a();return}i();if(!t){a();return}r=0,n=\`installing\`,a();try{let e=await codexLinuxRunUpdateManager([\`install-ready\`]),s=i();if(s?.status===\`waiting_for_app_exit\`){r=null,n=\`ready\`,a(),o();return}r=null,a(),e.stdout?.includes(\`Manual install required:\`)?await codexLinuxShowUpdateMessage(\`ChatGPT Desktop update\`,e.stdout.trim()):e.stdout?.includes(\`already installed\`)?await codexLinuxShowUpdateMessage(\`ChatGPT Desktop update\`,\`The ready update is already installed.\`):e.stdout?.includes(\`No update is ready to install\`)&&await codexLinuxShowUpdateMessage(\`ChatGPT Desktop update\`,\`There is no rebuilt update waiting to install.\`)}catch(e){r=null,n=t?\`ready\`:\`idle\`,a();throw e}}},quitForUpdate:o,refresh:async()=>{if(await c){try{await codexLinuxRefreshUpdateState()}catch{}i()}else t=!1,n=\`idle\`;a()}}}`;
}

function applyCurrentBootstrapUpdaterBridgePatch(currentSource) {
  if (
    !currentSource.includes("setSparkleBridgeHandlers") ||
    !currentSource.includes("sparkleManager:") ||
    !currentSource.includes("onInstallUpdatesRequested")
  ) {
    return currentSource;
  }

  const childProcessVar =
    requireName(currentSource, "node:child_process") ?? requireName(currentSource, "child_process");
  const fsVar = requireName(currentSource, "node:fs") ?? requireName(currentSource, "fs");
  const pathVar = requireName(currentSource, "node:path") ?? requireName(currentSource, "path");
  if (childProcessVar == null || fsVar == null || pathVar == null) {
    console.warn("WARN: Could not find updater bridge module bindings - skipping Linux updater bridge patch");
    return currentSource;
  }

  let patchedSource = currentSource;
  if (!patchedSource.includes("function codexLinuxCreatePackageUpdateManager(")) {
    if (!patchedSource.includes("state:`disabled`")) {
      return currentSource;
    }
    const bootstrapMatch = patchedSource.match(/var [A-Za-z_$][\w$]*=\{enabled:!1,running:!1,state:`disabled`\};/);
    if (bootstrapMatch == null) {
      console.warn("WARN: Could not find current updater bridge insertion point - skipping Linux updater bridge patch");
      return currentSource;
    }
    patchedSource = patchedSource.replace(
      bootstrapMatch[0],
      `${buildBootstrapBridgeSource({ childProcessVar, fsVar, pathVar })};${bootstrapMatch[0]}`,
    );
  }

  patchedSource = migrateLinuxUpdaterBridgeSource(patchedSource);

  const destructureRegex =
    /let\{startedAtMs:([A-Za-z_$][\w$]*),buildFlavor:([A-Za-z_$][\w$]*),desktopSentry:([A-Za-z_$][\w$]*),sparkleManager:([A-Za-z_$][\w$]*),productionAppcastStateStore:[A-Za-z_$][\w$]*,setSparkleBridgeHandlers:([A-Za-z_$][\w$]*),setSecondInstanceArgsHandler:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\(\),/;
  const destructureMatch = patchedSource.match(destructureRegex);
  const sparkleVar = destructureMatch?.[4] ?? null;
  const setSparkleBridgeHandlersVar = destructureMatch?.[5] ?? null;
  if (sparkleVar == null) {
    console.warn("WARN: Could not identify current sparkleManager binding - skipping Linux updater bridge patch");
    return currentSource;
  }
  const bridgeHandlersStart = setSparkleBridgeHandlersVar == null
    ? -1
    : patchedSource.indexOf(`${setSparkleBridgeHandlersVar}({`, destructureMatch.index ?? 0);
  const bridgeHandlersSearchSource = bridgeHandlersStart === -1
    ? ""
    : patchedSource.slice(bridgeHandlersStart);
  const messageDispatcherVar = bridgeHandlersSearchSource.match(
    /([A-Za-z_$][\w$]*)\.sendMessageToAllRegisteredWindows\(\{type:`app-update-ready-changed`/,
  )?.[1] ?? null;
  const appUpdateStateBroadcasterVar = bridgeHandlersSearchSource.match(
    /([A-Za-z_$][\w$]*)\.broadcastAppUpdateState\(\)/,
  )?.[1] ?? null;
  const sendCallback = messageDispatcherVar == null
    ? appUpdateStateBroadcasterVar == null
      ? null
      : `send:()=>${appUpdateStateBroadcasterVar}.broadcastAppUpdateState()`
    : `send:e=>${messageDispatcherVar}.sendMessageToAllRegisteredWindows(e)`;
  if (sendCallback == null) {
    console.warn("WARN: Could not identify current updater window message dispatcher - skipping Linux updater bridge patch");
    return currentSource;
  }

  if (!patchedSource.includes("codexLinuxPackageUpdateBridge=process.platform===`linux`")) {
    const currentBridgeRegex =
      /let ([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\{[^]*?\},(?=[A-Za-z_$][\w$]*=)/;
    const currentBridgeMatch = patchedSource.match(currentBridgeRegex);
    if (currentBridgeMatch == null) {
      console.warn("WARN: Could not find current updater callback bridge - skipping Linux updater bridge patch");
      return currentSource;
    }
    const [bridgeDeclaration, quitControllerVar, , , quitFnVar] = currentBridgeMatch;
    const bridgeSetup =
      `${bridgeDeclaration}codexLinuxPackageUpdateBridge=process.platform===\`linux\`?codexLinuxCreatePackageUpdateManager({allowQuit:()=>${quitControllerVar}.allowQuitTemporarilyForUpdateInstall(),${sendCallback}}):null;codexLinuxPackageUpdateBridge!=null&&(${sparkleVar}=codexLinuxPackageUpdateBridge.manager,${quitFnVar}=codexLinuxPackageUpdateBridge.quitForUpdate,setInterval(()=>codexLinuxPackageUpdateBridge.refresh(),3e4).unref?.());let `;
    patchedSource = patchedSource.replace(currentBridgeRegex, bridgeSetup);
  }

  return patchedSource;
}

function applyLinuxAppUpdaterBridgePatch(currentSource) {
  return applyCurrentBootstrapUpdaterBridgePatch(currentSource);
}

function applyLinuxAppUpdaterMenuPatch(currentSource) {
  if (/[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.shouldIncludeSparkle\([A-Za-z_$][\w$]*,process\.platform,process\.env\)\|\|process\.platform===`linux`/.test(currentSource)) {
    return currentSource;
  }
  const menuRegex =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.shouldIncludeSparkle\(([A-Za-z_$][\w$]*),process\.platform,process\.env\)/;
  if (!menuRegex.test(currentSource)) {
    if (currentSource.includes("enableSparkle") && currentSource.includes("shouldIncludeSparkle")) {
      console.warn("WARN: Could not find update menu feature gate - skipping Linux update menu patch");
    }
    return currentSource;
  }
  return currentSource.replace(menuRegex, "$1=$2.$3.shouldIncludeSparkle($4,process.platform,process.env)||process.platform===`linux`");
}

function patchLinuxAppUpdaterBridge(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    console.warn(`WARN: Could not find build directory in ${buildDir} - skipping Linux updater bridge patch`);
    return { matched: 0, changed: 0 };
  }

  let matched = 0;
  let changed = 0;
  for (const fileName of fs.readdirSync(buildDir).filter((name) => name.endsWith(".js")).sort()) {
    const filePath = path.join(buildDir, fileName);
    const source = fs.readFileSync(filePath, "utf8");
    const shouldPatchMenu = source.includes("shouldIncludeSparkle");
    const shouldPatchBridge =
      source.includes("exports.runMainAppStartup");
    if (!shouldPatchMenu && !shouldPatchBridge) {
      continue;
    }
    matched += 1;
    let patched = source;
    if (shouldPatchMenu) {
      patched = applyLinuxAppUpdaterMenuPatch(patched);
    }
    if (shouldPatchBridge) {
      patched = applyLinuxAppUpdaterBridgePatch(patched);
    }
    if (patched !== source) {
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    }
  }

  return { matched, changed };
}

module.exports = {
  applyLinuxAppUpdaterBridgePatch,
  applyLinuxAppUpdaterMenuPatch,
  patchLinuxAppUpdaterBridge,
};
