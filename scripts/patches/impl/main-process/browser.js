"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  escapeRegExp,
  requireName,
} = require("../../lib/minified-js.js");

function applyLinuxBundledPluginCopyPermissionsPatch(currentSource) {
  const ancestorHelperName = "codexLinuxValidateBundledPluginAncestors";
  const sourceHelperName = "codexLinuxValidateBundledPluginSource";
  const stageHelperName = "codexLinuxPrepareBundledPluginStage";
  const writableHelperName = "codexLinuxMakeBundledPluginTreeWritable";
  if (
    currentSource.includes(`async function ${ancestorHelperName}(`) &&
    currentSource.includes(`async function ${sourceHelperName}(`) &&
    currentSource.includes(`async function ${stageHelperName}(`) &&
    currentSource.includes(`async function ${writableHelperName}(`)
  ) {
    return currentSource;
  }

  const pathVar = requireName(currentSource, "node:path");
  if (pathVar == null) {
    if (currentSource.includes("verbatimSymlinks")) {
      console.warn(
        "WARN: Could not find node:path binding — skipping Linux plugin permissions patch",
      );
    }
    return currentSource;
  }

  const copyBranchRegex =
    /if\(([A-Za-z_$][\w$]*)\.default\.platform!==`win32`\)\{await ([A-Za-z_$][\w$]*)\.default\.cp\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),\{recursive:!0,verbatimSymlinks:!0\}\);return\}/;
  let patchedCopyBranch = false;
  const patchedSource = currentSource.replace(
    copyBranchRegex,
    (_match, platformVar, fsPromisesVar, sourceVar, targetVar) => {
      patchedCopyBranch = true;
      return `if(${platformVar}.default.platform!==\`win32\`){if(process.platform===\`linux\`){await ${fsPromisesVar}.default.cp(await ${sourceHelperName}(${sourceVar},${fsPromisesVar}.default),${targetVar},{recursive:!0,verbatimSymlinks:!0});await ${writableHelperName}(${targetVar},${fsPromisesVar}.default);return}await ${fsPromisesVar}.default.cp(${sourceVar},${targetVar},{recursive:!0,verbatimSymlinks:!0});return}`;
    },
  );
  if (!patchedCopyBranch) {
    if (currentSource.includes("verbatimSymlinks")) {
      console.warn(
        "WARN: Could not find bundled plugin copy branch — skipping Linux plugin permissions patch",
      );
    }
    return currentSource;
  }

  const stagingMkdirRegex = new RegExp(
    `await ([A-Za-z_$][\\w$]*)\\.default\\.mkdir\\(\\(0,${escapeRegExp(pathVar)}\\.join\\)\\(([A-Za-z_$][\\w$]*),\\.\\.\\.([A-Za-z_$][\\w$]*)\\.slice\\(0,-1\\)\\),\\{recursive:!0\\}\\)`,
  );
  let patchedStagingMkdir = false;
  const stagingPatchedSource = patchedSource.replace(
    stagingMkdirRegex,
    (_match, fsPromisesVar, stageRootVar, manifestPartsVar) => {
      patchedStagingMkdir = true;
      return `await ${stageHelperName}(${stageRootVar},${fsPromisesVar}.default),await ${fsPromisesVar}.default.mkdir((0,${pathVar}.join)(${stageRootVar},...${manifestPartsVar}.slice(0,-1)),{recursive:!0,mode:448})`;
    },
  );
  if (!patchedStagingMkdir) {
    if (currentSource.includes("staging_marketplace")) {
      console.warn(
        "WARN: Could not find bundled marketplace staging creation — skipping Linux plugin permissions patch",
      );
    }
    return currentSource;
  }

  const pluginParentMkdirRegex = new RegExp(
    `await ([A-Za-z_$][\\w$]*)\\.default\\.mkdir\\(\\(0,${escapeRegExp(pathVar)}\\.dirname\\)\\(([A-Za-z_$][\\w$]*)\\),\\{recursive:!0\\}\\),await ([A-Za-z_$][\\w$]*)\\(([A-Za-z_$][\\w$]*),([A-Za-z_$][\\w$]*)\\)`,
  );
  let patchedPluginParentMkdir = false;
  const fullyPatchedSource = stagingPatchedSource.replace(
    pluginParentMkdirRegex,
    (_match, fsPromisesVar, targetVar, copyFunctionVar, sourceVar, copyTargetVar) => {
      if (copyTargetVar !== targetVar) {
        return _match;
      }
      patchedPluginParentMkdir = true;
      return `await ${fsPromisesVar}.default.mkdir((0,${pathVar}.dirname)(${targetVar}),{recursive:!0,mode:448}),await ${copyFunctionVar}(${sourceVar},${targetVar})`;
    },
  );
  if (!patchedPluginParentMkdir) {
    if (currentSource.includes("copy_plugins")) {
      console.warn(
        "WARN: Could not find bundled plugin target parent creation — skipping Linux plugin permissions patch",
      );
    }
    return currentSource;
  }

  const helpers = [
    `async function ${ancestorHelperName}(e,t){let n=await t.realpath(e),r=process.geteuid?.();if(!Number.isInteger(r))throw Error(\`Linux bundled plugin path is not trusted\`);for(let e=n;;){let n=await t.lstat(e),i=n.mode;if(n.isSymbolicLink()||!n.isDirectory()||n.uid!==r&&n.uid!==0||i&18&&!(n.uid===0&&i&512))throw Error(\`Linux bundled plugin path is not trusted\`);let a=(0,${pathVar}.dirname)(e);if(a===e)break;e=a}return n}`,
    `async function ${sourceHelperName}(e,t){let n=await ${ancestorHelperName}(e,t),r=process.geteuid(),i=async e=>{let n=await t.lstat(e);if(n.isSymbolicLink()||!n.isDirectory()&&!n.isFile()||n.uid!==r&&n.uid!==0||n.mode&18)throw Error(\`Linux bundled plugin source is not trusted\`);if(n.isDirectory())for(let n of await t.readdir(e))await i((0,${pathVar}.join)(e,n))};return await i(n),n}`,
    `async function ${stageHelperName}(e,t){let n=(0,${pathVar}.dirname)(e),r=n;for(;;)try{await t.lstat(r);break}catch(e){if(e?.code!==\`ENOENT\`)throw e;let t=(0,${pathVar}.dirname)(r);if(t===r)throw e;r=t}await ${ancestorHelperName}(r,t),await t.mkdir(n,{recursive:!0,mode:448}),await ${ancestorHelperName}(n,t),await t.mkdir(e,{mode:448});let i=process.geteuid(),a=await t.lstat(e);if(a.isSymbolicLink()||!a.isDirectory()||a.uid!==i)throw Error(\`Linux bundled plugin staging root is not private\`);await t.chmod(e,448),a=await t.lstat(e);if((a.mode&511)!==448)throw Error(\`Linux bundled plugin staging root is not private\`)}`,
    `async function ${writableHelperName}(e,t){let n=await t.lstat(e);if(n.isSymbolicLink())throw Error(\`Linux bundled plugin copy contains a symbolic link\`);await t.chmod(e,(n.mode|128)&~18);if(n.isDirectory())for(let n of await t.readdir(e))await ${writableHelperName}((0,${pathVar}.join)(e,n),t)}`,
  ].join("");
  const strictDirective = '"use strict";';
  const helperInsertionIndex = currentSource.startsWith(strictDirective)
    ? strictDirective.length
    : 0;
  return (
    fullyPatchedSource.slice(0, helperInsertionIndex) +
    helpers +
    fullyPatchedSource.slice(helperInsertionIndex)
  );
}

function applyLinuxBundledPluginReconcileStaleSnapshotPatch(currentSource) {
  const marker = "/*codex-linux-skip-stale-bundled-plugin-reconcile*/";
  if (currentSource.includes(marker)) {
    return currentSource;
  }

  const reconcilerStartRegex =
    /([A-Za-z_$][\w$]*)=\(\{force:([A-Za-z_$][\w$]*),reason:([A-Za-z_$][\w$]*)\}\)=>\{if\(([A-Za-z_$][\w$]*)==null\)return [A-Za-z_$][\w$]*\(\)\.info\(`bundled_plugins_reconcile_skipped_features_unavailable`/;
  const match = currentSource.match(reconcilerStartRegex);
  if (match == null || match.index == null) {
    if (currentSource.includes("bundled_plugins_reconcile_skipped_features_unavailable")) {
      console.warn(
        "WARN: Could not find bundled plugin reconcile queue — skipping stale snapshot patch",
      );
    }
    return currentSource;
  }

  const featureSnapshotVar = match[4];
  const escapedFeatureSnapshotVar = escapeRegExp(featureSnapshotVar);
  const reconcilerPrefix = currentSource.slice(match.index);
  const snapshotMatch = reconcilerPrefix.match(
    new RegExp(`;let ([A-Za-z_$][\\w$]*)=${escapedFeatureSnapshotVar}(?:,|;)`),
  );
  const reconcileLogIndex = reconcilerPrefix.indexOf(
    "bundled_plugins_reconcile_started",
  );
  if (snapshotMatch == null || snapshotMatch.index == null || reconcileLogIndex < 0) {
    console.warn(
      "WARN: Could not find bundled plugin reconcile snapshot — skipping stale snapshot patch",
    );
    return currentSource;
  }

  const capturedSnapshotVar = snapshotMatch[1];
  const hashMatch = reconcilerPrefix.match(
    new RegExp(
      `;if\\(!${escapeRegExp(match[2])}&&([A-Za-z_$][\\w$]*)===([A-Za-z_$][\\w$]*)\\)return`,
    ),
  );
  if (hashMatch == null) {
    console.warn(
      "WARN: Could not find bundled plugin reconcile semantic hash — skipping stale snapshot patch",
    );
    return currentSource;
  }

  const latestHashVar = hashMatch[1];
  const capturedHashVar = hashMatch[2];
  const reconcileCallMatch = reconcilerPrefix.match(
    new RegExp(
      `await ([A-Za-z_$][\\w$]*)\\(\\{desktopFeatureAvailability:${escapeRegExp(capturedSnapshotVar)},`,
    ),
  );
  if (reconcileCallMatch == null) {
    console.warn(
      "WARN: Could not find bundled plugin reconcile worker — skipping stale snapshot patch",
    );
    return currentSource;
  }

  const reconcileWorkerVar = reconcileCallMatch[1];
  const workerDefinitionRegex = new RegExp(
    `${escapeRegExp(reconcileWorkerVar)}=async ([A-Za-z_$][\\w$]*)=>\\{`,
    "g",
  );
  const workerDefinitionMatches = [...reconcilerPrefix.matchAll(workerDefinitionRegex)];
  if (
    workerDefinitionMatches.length !== 1 ||
    workerDefinitionMatches[0].index == null
  ) {
    console.warn(
      "WARN: Expected one bundled plugin reconcile worker definition — skipping stale snapshot patch",
    );
    return currentSource;
  }
  const workerDefinitionMatch = workerDefinitionMatches[0];

  const workerArgumentVar = workerDefinitionMatch[1];
  const workerPrefix = reconcilerPrefix.slice(workerDefinitionMatch.index);
  const destructiveReconcileRegex =
    /try\{([A-Za-z_$][\w$]*)=await ([A-Za-z_$][\w$]*)\(\{appServerConnection:/;
  const destructiveReconcileMatch = workerPrefix.match(destructiveReconcileRegex);
  if (destructiveReconcileMatch == null || destructiveReconcileMatch.index == null) {
    console.warn(
      "WARN: Could not find bundled plugin destructive reconcile boundary — skipping stale snapshot patch",
    );
    return currentSource;
  }

  const insertionIndex =
    match.index +
    workerDefinitionMatch.index +
    destructiveReconcileMatch.index +
    "try{".length;
  const reconcileCallIndex = match.index + reconcileCallMatch.index;
  const reconcileCallPrefix = `await ${reconcileWorkerVar}({`;
  const reconcilePropertyIndex = reconcileCallIndex + reconcileCallPrefix.length;
  const hashAssignment = `${latestHashVar}=${capturedHashVar};`;
  const hashAssignmentIndex = reconcilerPrefix.indexOf(hashAssignment);
  if (hashAssignmentIndex < 0) {
    console.warn(
      "WARN: Could not find bundled plugin reconcile hash assignment — skipping stale snapshot patch",
    );
    return currentSource;
  }
  const globalHashInsertionIndex =
    match.index + hashAssignmentIndex + hashAssignment.length;
  if (
    !(
      globalHashInsertionIndex < reconcilePropertyIndex &&
      reconcilePropertyIndex < insertionIndex
    )
  ) {
    console.warn(
      "WARN: Bundled plugin reconcile insertion order drifted — skipping stale snapshot patch",
    );
    return currentSource;
  }

  const guardedSource =
    currentSource.slice(0, insertionIndex) +
    `if(${workerArgumentVar}.codexLinuxReconcileSnapshot!==globalThis.__codexLinuxBundledPluginReconcileSnapshot)return;${marker}` +
    currentSource.slice(insertionIndex);
  const propertySource =
    guardedSource.slice(0, reconcilePropertyIndex) +
    `codexLinuxReconcileSnapshot:${capturedHashVar},` +
    guardedSource.slice(reconcilePropertyIndex);
  return (
    propertySource.slice(0, globalHashInsertionIndex) +
    `globalThis.__codexLinuxBundledPluginReconcileSnapshot=${capturedHashVar};` +
    propertySource.slice(globalHashInsertionIndex)
  );
}

function applyBrowserUseNodeReplApprovalPatch(currentSource) {
  let patchedSource = currentSource;
  let patchedTrustedHashes = false;
  const hasTrustedHashesRuntimeBuilder =
    /(?<!async )function [A-Za-z_$][\w$]*\(\{(?=[^{}]*nodePath:)(?=[^{}]*nodeReplPath:)(?=[^{}]*shouldUseWslPaths:)[^{}]*trustedBrowserClientSha256s:[A-Za-z_$][\w$]*(?:=\[\])?[^{}]*\}\)\{/.test(currentSource);

  const runtimeBuilderTrustedHashesRegex =
    /(?<!async )function ([A-Za-z_$][\w$]*)\(\{(?=[^{}]*nodePath:)(?=[^{}]*nodeReplPath:)(?=[^{}]*shouldUseWslPaths:)([^{}]*?trustedBrowserClientSha256s:)([A-Za-z_$][\w$]*)([^{}]*?\})\)\{(?![A-Za-z_$][\w$]*=codexLinuxTrustedBrowserClientSha256s\()/g;
  if (
    requireName(patchedSource, "node:fs") != null &&
    requireName(patchedSource, "node:path") != null &&
    requireName(patchedSource, "node:crypto") != null
  ) {
    patchedSource = patchedSource.replace(
      runtimeBuilderTrustedHashesRegex,
      (
        _match,
        functionName,
        configPrefix,
        trustedHashesVar,
        configSuffix,
      ) => {
        patchedTrustedHashes = true;
        return `function ${functionName}({${configPrefix}${trustedHashesVar}${configSuffix}){${trustedHashesVar}=codexLinuxTrustedBrowserClientSha256s(${trustedHashesVar});`;
      },
    );
  }

  // The node_repl MCP server config is a standalone object literal in a
  // separate build chunk. Insert the js auto-approval there.
  const mcpServerConfigRegex =
    /(\[`mcp_servers\.\$\{[A-Za-z_$][\w$]*\}`\]:\{args:\[\],command:[A-Za-z_$][\w$]*,env:[A-Za-z_$][\w$]*,)(startup_timeout_sec:120\})/g;
  const mcpServerConfigAlreadyApprovedRegex =
    /\[`mcp_servers\.\$\{[A-Za-z_$][\w$]*\}`\]:\{args:\[\],command:[A-Za-z_$][\w$]*,env:[A-Za-z_$][\w$]*,tools:\{js:\{approval_mode:`approve`\}\},startup_timeout_sec:120\}/;
  let patchedAnyMcpServerConfig = false;
  patchedSource = patchedSource.replace(
    mcpServerConfigRegex,
    (_match, configPrefix, configSuffix) => {
      patchedAnyMcpServerConfig = true;
      return `${configPrefix}tools:{js:{approval_mode:\`approve\`}},${configSuffix}`;
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
      return currentSource;
    } else {
      const helper =
        `function codexLinuxTrustedBrowserClientSha256s(__codexHashes,__codexResourcesPath=process.resourcesPath){if(process.platform!==\`linux\`)return __codexHashes;let __codexTrustedHashes=Array.isArray(__codexHashes)?[...__codexHashes]:[],__codexBasePath=__codexResourcesPath??"";if(__codexBasePath.length===0)return Array.from(new Set(__codexTrustedHashes));for(let __codexPluginName of[\`browser\`,\`chrome\`])try{let __codexBrowserClientPath=(0,${pathVar}.join)(__codexBasePath,\`plugins\`,\`openai-bundled\`,\`plugins\`,__codexPluginName,\`scripts\`,\`browser-client.mjs\`);(0,${fsVar}.existsSync)(__codexBrowserClientPath)&&__codexTrustedHashes.push((0,${cryptoVar}.createHash)(\`sha256\`).update((0,${fsVar}.readFileSync)(__codexBrowserClientPath)).digest(\`hex\`))}catch{}return Array.from(new Set(__codexTrustedHashes))}`;
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
    hasTrustedHashesRuntimeBuilder
  ) {
    console.warn(
      "WARN: Could not find Browser Use trusted hash insertion point — skipping Linux Browser Use trusted hash patch",
    );
  }

  if (
    patchedSource === currentSource &&
    patchedSource.includes("startup_timeout_sec:120") &&
    !patchedAnyMcpServerConfig &&
    !mcpServerConfigAlreadyApprovedRegex.test(patchedSource) &&
    !patchedTrustedHashes &&
    !patchedSource.includes("codexLinuxTrustedBrowserClientSha256s(")
  ) {
    console.warn(
      "WARN: Could not find Browser Use node_repl config insertion point — skipping node_repl approval patch",
    );
  }

  return patchedSource;
}

// The trusted-hash setup and node_repl config can live in different build chunks.
// Scan every chunk carrying either marker so each patch reaches its current host.
function applyBrowserUseNodeReplApprovalAssets(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { matched: 0, changed: 0 };
  }

  const candidates = fs
    .readdirSync(buildDir)
    .filter((name) => name.endsWith(".js"))
    .sort()
    .map((name) => path.join(buildDir, name))
    .filter((candidate) => {
      try {
        const source = fs.readFileSync(candidate, "utf8");
        return (
          source.includes("startup_timeout_sec:120") ||
          source.includes("trustedBrowserClientSha256s")
        );
      } catch {
        return false;
      }
    });

  let changed = 0;
  const pendingWrites = [];
  for (const candidate of candidates) {
    const currentSource = fs.readFileSync(candidate, "utf8");
    const patchedSource = applyBrowserUseNodeReplApprovalPatch(currentSource);
    if (patchedSource !== currentSource) {
      changed += 1;
      pendingWrites.push({ filePath: candidate, patchedSource });
    }
  }
  for (const { filePath, patchedSource } of pendingWrites) {
    fs.writeFileSync(filePath, patchedSource, "utf8");
  }

  return { matched: candidates.length, changed };
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

  // Fix: use windowId-based lookup instead of "first live" heuristic.
  // The old heuristic returned arbitrary live windows that may not match
  // the requested windowId, causing IAB_LIFECYCLE rebound loops where the
  // sidebar webview was created, destroyed, and re-created in a cycle.
  const helper = `function codexLinuxResolveLiveBrowserUseRouteWindow(e,t,n,r){if(process.platform!==\`linux\`)return null;let o=r.BrowserWindow.fromId(t);if(o!=null&&!o.isDestroyed()&&!o.webContents.isDestroyed())return e(o,o.webContents);let s=n.get(t)??null;return s!=null&&!s.window.isDestroyed()&&!s.owner.isDestroyed()?s:null}`;
  const replacement = `${helper}function ${functionName}({ensureWindowState:${ensureWindowStateVar},windowId:${windowIdVar},windows:${windowsVar}}){let ${stateVar}=${windowsVar}.get(${windowIdVar})??null;if(${stateVar}==null){let ${browserWindowVar}=${electronVar}.BrowserWindow.fromId(${windowIdVar});${browserWindowVar}!=null&&!${browserWindowVar}.isDestroyed()&&!${browserWindowVar}.webContents.isDestroyed()&&(${stateVar}=${ensureWindowStateVar}(${browserWindowVar},${browserWindowVar}.webContents))}${stateVar}==null&&(${stateVar}=codexLinuxResolveLiveBrowserUseRouteWindow(${ensureWindowStateVar},${windowIdVar},${windowsVar},${electronVar}));return ${stateVar}==null||${stateVar}.window.isDestroyed()||${stateVar}.owner.isDestroyed()?(${loggerVar}().warning(\`IAB_LIFECYCLE route window is not live\`,{safe:{hasWindowState:${stateVar}!=null,ownerDestroyed:${stateVar}?.owner.isDestroyed()??null,windowDestroyed:${stateVar}?.window.isDestroyed()??null,windowId:${windowIdVar}},sensitive:{}}),null):${stateVar}}`;

  return currentSource.replace(original, replacement);
}

function applyLinuxBrowserUseSocketDirectoryPatch(currentSource) {
  const helperName = "codexLinuxBrowserUseSocketDir";
  const socketModeMarker = "/*codexLinuxBrowserUseSocketMode*/";
  const hasHelper = currentSource.includes(`function ${helperName}(`);
  const hasSocketModePatch = currentSource.includes(socketModeMarker);
  if (hasHelper && hasSocketModePatch) {
    return currentSource;
  }
  if (hasHelper || hasSocketModePatch) {
    console.warn(
      "WARN: Browser Use socket directory patch is only partially present — leaving main bundle unchanged",
    );
    return currentSource;
  }

  const socketDirectoryPattern =
    /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>\2===`win32`\?(`(?:\\.|[^`\\])*codex-browser-use`):`\/tmp\/codex-browser-use`/g;
  const socketDirectoryMatches = [...currentSource.matchAll(socketDirectoryPattern)];
  const socketListenPattern =
    /this\.server\.listen\(this\.pipePath,\(\)=>\{this\.server\.off\(`error`,([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)\(\)\}\)/g;
  const socketListenMatches = [...currentSource.matchAll(socketListenPattern)];
  if (socketDirectoryMatches.length !== 1 || socketListenMatches.length !== 1) {
    if (currentSource.includes("codex-browser-use")) {
      console.warn(
        `WARN: Expected one Browser Use socket directory and listener, found ${socketDirectoryMatches.length}/${socketListenMatches.length} — skipping Linux IAB socket alignment patch`,
      );
    }
    return currentSource;
  }

  const [directoryTarget, resolverName, platformName, windowsSocket] =
    socketDirectoryMatches[0];
  const [listenTarget, errorHandlerName, resolveName] = socketListenMatches[0];
  const helper =
    `function ${helperName}(){let e=process.env.CODEX_BROWSER_USE_SOCKET_DIR,t=typeof e===\`string\`&&e.length>0?e:null,n=typeof process.getuid===\`function\`?process.getuid():null;` +
    `if(t==null){if(!Number.isInteger(n)||n<0)throw Error(\`Browser Use cannot resolve a per-user Linux socket directory\`);t=\`/tmp/codex-browser-use-\${n}\`}` +
    `let r=require(\`node:fs\`);r.mkdirSync(t,{recursive:!0,mode:448});let i=r.lstatSync(t);` +
    `if(i.isSymbolicLink()||!i.isDirectory())throw Error(\`Browser Use socket directory is not a directory\`);` +
    `if(Number.isInteger(n)&&i.uid!==n)throw Error(\`Browser Use socket directory is not owned by the current user\`);` +
    `r.chmodSync(t,448);return t}`;
  const directoryReplacement = `${resolverName}=${platformName}=>${platformName}===\`win32\`?${windowsSocket}:${helperName}()`;
  const listenReplacement =
    `this.server.listen(this.pipePath,()=>{if(process.platform===\`linux\`)try{require(\`node:fs\`).chmodSync(this.pipePath,384)}catch(e){this.server.off(\`error\`,${errorHandlerName}),this.server.close(()=>{}),${errorHandlerName}(e);return}${socketModeMarker}` +
    `this.server.off(\`error\`,${errorHandlerName}),${resolveName}()})`;

  let patchedSource = currentSource.replace(directoryTarget, directoryReplacement);
  patchedSource = patchedSource.replace(listenTarget, listenReplacement);
  const strictDirective = '"use strict";';
  const helperInsertionIndex = patchedSource.startsWith(strictDirective)
    ? strictDirective.length
    : 0;
  return (
    patchedSource.slice(0, helperInsertionIndex) +
    helper +
    patchedSource.slice(helperInsertionIndex)
  );
}

function buildLinuxExternalOpenHelpers() {
  return (
    `function codexLinuxExternalOpenEnv(){let __codexEnv={...process.env};` +
    `for(let __codexKey of[\`LD_LIBRARY_PATH\`,\`LD_PRELOAD\`,\`NODE_OPTIONS\`,\`NODE_PATH\`,\`NODE_REPL_EXTERNAL_MODULE\`,\`ELECTRON_RUN_AS_NODE\`,\`ELECTRON_NO_ASAR\`,\`ELECTRON_ENABLE_LOGGING\`,\`VSCODE_NODE_OPTIONS\`,\`VSCODE_NODE_REPL_EXTERNAL_MODULE\`,\`npm_config_node_options\`,\`NPM_CONFIG_NODE_OPTIONS\`,\`CHROME_DESKTOP\`,\`ELECTRON_RENDERER_URL\`,\`CODEX_ELECTRON_RESOURCES_PATH\`,\`CODEX_ELECTRON_USER_DATA_DIR\`,\`CODEX_LINUX_APP_ID\`,\`CODEX_LINUX_APP_DISPLAY_NAME\`,\`CODEX_LINUX_WEBVIEW_PORT\`])delete __codexEnv[__codexKey];` +
    `return __codexEnv}` +
    `function codexLinuxLaunchExternalUrl(__codexUrl){return new Promise((__codexResolve,__codexReject)=>{let __codexSettled=!1,__codexTimer;try{let __codexChild=require(\`node:child_process\`).spawn(\`xdg-open\`,[__codexUrl],{detached:!0,stdio:\`ignore\`,windowsHide:!0,env:codexLinuxExternalOpenEnv()});__codexTimer=setTimeout(()=>{__codexSettled=!0,__codexChild.unref?.(),__codexResolve()},400),__codexTimer.unref?.(),__codexChild.on(\`error\`,__codexError=>{__codexSettled||(clearTimeout(__codexTimer),__codexReject(__codexError))}),__codexChild.on(\`close\`,__codexCode=>{__codexSettled||(clearTimeout(__codexTimer),__codexCode===0?__codexResolve():__codexReject(Error(\`Linux external open failed\`)))})}catch(__codexError){clearTimeout(__codexTimer),__codexReject(__codexError)}})}` +
    `function codexLinuxOpenExternalWithFallback(__codexOriginalOpenExternal,__codexUrl){return codexLinuxLaunchExternalUrl(__codexUrl).catch(()=>__codexOriginalOpenExternal(__codexUrl))}` +
    `function codexLinuxPatchExternalOpen(__codexElectron){if(process.platform!==\`linux\`||__codexElectron?.shell==null||typeof __codexElectron.shell.openExternal!==\`function\`)return __codexElectron;if(__codexElectron.shell.openExternal.__codexLinuxExternalOpenPatched)return __codexElectron;if(process.env.CODEX_LINUX_DISABLE_EXTERNAL_OPEN_PATCH===\`1\`)return __codexElectron;let __codexOriginalOpenExternal=__codexElectron.shell.openExternal.bind(__codexElectron.shell);async function __codexOpenExternal(__codexUrl,__codexOptions){if(typeof __codexUrl===\`string\`&&__codexOptions==null)return codexLinuxOpenExternalWithFallback(__codexOriginalOpenExternal,__codexUrl);return __codexOriginalOpenExternal(__codexUrl,__codexOptions)}__codexOpenExternal.__codexLinuxExternalOpenPatched=!0,__codexElectron.shell.openExternal=__codexOpenExternal;return __codexElectron}`
  );
}

const LINUX_EXTERNAL_OPEN_TARGET_MARKER =
  "/*codexLinuxExternalOpenTarget*/";
const CURRENT_LINUX_EXTERNAL_OPEN_TARGET_COUNT = 2;

function hasCompleteLinuxExternalOpenEnvPatch(source, helperPayload) {
  if (source.split(helperPayload).length - 1 !== 1) {
    return false;
  }
  const markerCount =
    source.split(LINUX_EXTERNAL_OPEN_TARGET_MARKER).length - 1;
  const targetPattern =
    /\/\*codexLinuxExternalOpenTarget\*\/codexLinuxPatchExternalOpen\(require\(([`'"])electron\1\)\)/g;
  return (
    markerCount === CURRENT_LINUX_EXTERNAL_OPEN_TARGET_COUNT &&
    [...source.matchAll(targetPattern)].length ===
      CURRENT_LINUX_EXTERNAL_OPEN_TARGET_COUNT
  );
}

function applyLinuxExternalOpenEnvPatch(currentSource) {
  const helperPayload = buildLinuxExternalOpenHelpers();
  const hasAnyPatchArtifact =
    currentSource.includes("codexLinuxExternalOpenEnv")
    || currentSource.includes("codexLinuxLaunchExternalUrl")
    || currentSource.includes("codexLinuxOpenExternalWithFallback")
    || currentSource.includes("codexLinuxPatchExternalOpen")
    || currentSource.includes(LINUX_EXTERNAL_OPEN_TARGET_MARKER);
  if (hasAnyPatchArtifact) {
    if (hasCompleteLinuxExternalOpenEnvPatch(currentSource, helperPayload)) {
      return currentSource;
    }
    console.warn(
      "WARN: Found incomplete Linux external open environment patch — skipping",
    );
    return currentSource;
  }

  const electronRequireInitializerPattern =
    /([A-Za-z_$][\w$]*=)require\(([`'"])electron\2\)/g;
  const targetCount = [
    ...currentSource.matchAll(electronRequireInitializerPattern),
  ].length;
  if (targetCount !== CURRENT_LINUX_EXTERNAL_OPEN_TARGET_COUNT) {
    console.warn(
      `WARN: Expected ${CURRENT_LINUX_EXTERNAL_OPEN_TARGET_COUNT} current Electron require initializers, found ${targetCount} — skipping Linux external open environment patch`,
    );
    return currentSource;
  }

  const patchedSource = currentSource.replace(
    electronRequireInitializerPattern,
    (_match, prefix, quote) => {
      return (
        `${prefix}${LINUX_EXTERNAL_OPEN_TARGET_MARKER}` +
        `codexLinuxPatchExternalOpen(require(${quote}electron${quote}))`
      );
    },
  );

  const strictDirective = '"use strict";';
  const helperInsertionIndex = currentSource.startsWith(strictDirective)
    ? strictDirective.length
    : 0;
  return (
    patchedSource.slice(0, helperInsertionIndex) +
    helperPayload +
    patchedSource.slice(helperInsertionIndex)
  );
}

module.exports = {
  applyBrowserUseNodeReplApprovalPatch,
  applyBrowserUseNodeReplApprovalAssets,
  applyLinuxBundledPluginCopyPermissionsPatch,
  applyLinuxBundledPluginReconcileStaleSnapshotPatch,
  applyLinuxExternalOpenEnvPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxBrowserUseSocketDirectoryPatch,
};
