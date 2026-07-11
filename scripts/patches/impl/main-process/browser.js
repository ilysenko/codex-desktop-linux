"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  escapeRegExp,
  requireName,
} = require("../../lib/minified-js.js");

function applyLinuxBundledPluginCopyPermissionsPatch(currentSource) {
  const helperName = "codexLinuxMakeBundledPluginTreeWritable";
  if (currentSource.includes(`async function ${helperName}(`)) {
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
      return `if(${platformVar}.default.platform!==\`win32\`){await ${fsPromisesVar}.default.cp(${sourceVar},${targetVar},{recursive:!0,verbatimSymlinks:!0});if(process.platform===\`linux\`)await ${helperName}(${targetVar},${fsPromisesVar}.default);return}`;
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

  const helper =
    `async function ${helperName}(e,t){let n=await t.lstat(e);if(n.isSymbolicLink())return;await t.chmod(e,n.mode|128);if(n.isDirectory())for(let n of await t.readdir(e))await ${helperName}((0,${pathVar}.join)(e,n),t)}`;
  const strictDirective = '"use strict";';
  const helperInsertionIndex = currentSource.startsWith(strictDirective)
    ? strictDirective.length
    : 0;
  return (
    patchedSource.slice(0, helperInsertionIndex) +
    helper +
    patchedSource.slice(helperInsertionIndex)
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
    `function codexLinuxChromeProfileRoots({homeDir:__codexHomeDir,platform:__codexPlatform}){return __codexPlatform===\`linux\`?[(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`BraveSoftware\`,\`Brave-Browser\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome-beta\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`google-chrome-unstable\`),(0,${pathVar}.join)(__codexHomeDir,\`.config\`,\`chromium\`)]:[]}function codexLinuxChromeHasExtension({extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform}){if(__codexPlatform!==\`linux\`)return!1;let __codexValidatedExtensionId=${extensionIdValidatorName}(__codexExtensionId);for(let __codexProfileRoot of codexLinuxChromeProfileRoots({homeDir:__codexHomeDir,platform:__codexPlatform})){if(!(0,${fsVar}.existsSync)(__codexProfileRoot))continue;for(let __codexProfileEntry of (0,${fsVar}.readdirSync)(__codexProfileRoot,{withFileTypes:!0}))if(__codexProfileEntry.isDirectory()&&(0,${fsVar}.existsSync)((0,${pathVar}.join)(__codexProfileRoot,__codexProfileEntry.name,\`Extensions\`,__codexValidatedExtensionId)))return!0}return!1}function codexLinuxChromeCommand(){let __codexPathEntries=(process.env.PATH??\`\`).split(\`:\`);for(let __codexBrowserCommand of[\`brave-browser\`,\`brave\`,\`google-chrome\`,\`google-chrome-stable\`,\`google-chrome-beta\`,\`google-chrome-unstable\`,\`chromium-browser\`,\`chromium\`])for(let __codexPathEntry of __codexPathEntries){if(__codexPathEntry.length===0)continue;let __codexCandidate=(0,${pathVar}.join)(__codexPathEntry,__codexBrowserCommand);try{if((0,${fsVar}.existsSync)(__codexCandidate)&&(0,${fsVar}.statSync)(__codexCandidate).isFile())return __codexCandidate}catch{}}return null}function ${statusFunctionName}({extensionId:__codexExtensionId,homeDir:__codexHomeDir=(0,${osVar}.homedir)(),localAppDataDir:__codexLocalAppDataDir=process.env.LOCALAPPDATA,platform:__codexPlatform=process.platform}){if(__codexPlatform===\`linux\`)return codexLinuxChromeHasExtension({extensionId:__codexExtensionId,homeDir:__codexHomeDir,platform:__codexPlatform});let __codexValidatedExtensionId=${extensionIdValidatorName}(__codexExtensionId),__codexProfileDir=${profileDirFunctionName}({homeDir:__codexHomeDir,localAppDataDir:__codexLocalAppDataDir,platform:__codexPlatform});return __codexProfileDir==null||!(0,${fsVar}.existsSync)(__codexProfileDir)?!1:(0,${fsVar}.readdirSync)(__codexProfileDir,{withFileTypes:!0}).some(__codexProfileEntry=>__codexProfileEntry.isDirectory()&&(0,${fsVar}.existsSync)((0,${pathVar}.join)(__codexProfileDir,__codexProfileEntry.name,\`Extensions\`,__codexValidatedExtensionId)))}async function ${openFunctionName}({extensionId:__codexExtensionId,platform:__codexPlatform=process.platform,detectChromeCommand:__codexDetectChromeCommand=${detectChromeFunctionName},runCommand:__codexRunCommand=${runCommandFunctionName}}){if(__codexPlatform===\`darwin\`){await __codexRunCommand(${macOpenFunctionName},[\`-b\`,${macBundleIdName},${extensionUrlFunctionName}(__codexExtensionId)]);return}if(__codexPlatform===\`win32\`){let __codexChromeCommand=__codexDetectChromeCommand();if(__codexChromeCommand==null)throw Error(\`Google Chrome is not installed\`);await __codexRunCommand(__codexChromeCommand,[${extensionUrlFunctionName}(__codexExtensionId)]);return}if(__codexPlatform===\`linux\`){let __codexChromeCommand=codexLinuxChromeCommand()??__codexDetectChromeCommand();if(__codexChromeCommand==null)throw Error(\`Google Chrome, Brave, or Chromium is not installed\`);await __codexRunCommand(__codexChromeCommand,[${extensionUrlFunctionName}(__codexExtensionId)]);return}throw Error(\`Opening Chrome extension settings is only supported on macOS, Windows, and Linux\`)}`;

  return currentSource.slice(0, blockStart) + replacement + currentSource.slice(blockEnd);
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

function applyLinuxExternalOpenEnvPatch(currentSource) {
  const hasHelper = currentSource.includes("function codexLinuxPatchExternalOpen(");
  const hasPatchedElectronRequire = /codexLinuxPatchExternalOpen\(require\(([`'"])electron\1\)\)/.test(
    currentSource,
  );
  let patchedAnyElectronRequire = false;
  const patchedSource = currentSource.replace(
    /([A-Za-z_$][\w$]*=)require\(([`'"])electron\2\)/g,
    (_match, prefix, quote) => {
      patchedAnyElectronRequire = true;
      return `${prefix}codexLinuxPatchExternalOpen(require(${quote}electron${quote}))`;
    },
  );

  if (!patchedAnyElectronRequire) {
    if (!(hasHelper && hasPatchedElectronRequire)) {
      console.warn(
        "WARN: Could not find Electron require initializer — skipping Linux external open environment patch",
      );
    }
    return currentSource;
  }

  if (hasHelper) {
    return patchedSource;
  }

  const strictDirective = '"use strict";';
  const helperInsertionIndex = currentSource.startsWith(strictDirective)
    ? strictDirective.length
    : 0;
  return (
    patchedSource.slice(0, helperInsertionIndex) +
    buildLinuxExternalOpenHelpers() +
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
  applyLinuxChromeExtensionStatusPatch,
};
