"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  PatchIntegrityError,
  isPatchIntegrityError,
} = require("../integrity-error.js");

const {
  findMatchingBrace,
} = require("../lib/minified-js.js");
const {
  readDirectoryNames,
} = require("../lib/assets.js");

const LINUX_CHROME_NATIVE_HOST_RUNTIME_HELPER =
  "function codexLinuxChromeNativeHostRuntimeFile(e,t){if(process.platform!==`linux`||e==null)return null;for(let n of t){let t=(0,require(`node:path`).join)(e,...n);try{if((0,require(`node:fs`).statSync)(t).isFile())return t}catch{}}return null}" +
  "function codexLinuxChromeNativeHostRuntimeEnv(e){if(process.platform!==`linux`)return null;let t=process.env[e];if(t==null||t.length===0)return null;try{return(0,require(`node:fs`).statSync)(t).isFile()?t:null}catch{return null}}" +
  "function codexLinuxChromeNativeHostRuntimePath(e){if(process.platform!==`linux`)return null;for(let t of(process.env.PATH??``).split(`:`)){if(t.length===0)continue;let n=(0,require(`node:path`).join)(t,e);try{if((0,require(`node:fs`).statSync)(n).isFile())return n}catch{}}return null}" +
  "function codexLinuxChromeNativeHostRuntimeEntry(e,t){return e==null?null:{path:e,source:t}}";

const LINUX_CHROME_NATIVE_HOST_RUNTIME_MODERN_MARKERS = [
  "codexLinuxChromeNativeHostRuntimeEntry(codexLinuxChromeNativeHostRuntimePath(`codex`),`linux-path`)",
  "`linux-node-runtime`",
  "`linux-node-repl-runtime`",
];
const LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_RUNTIME_MARKER =
  "/*codexLinuxChromeNativeHostAppServerRuntime*/";
const LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_CODEX_MARKER =
  "/*codexLinuxChromeNativeHostAppServerCodexRuntime*/";
const LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_SOURCE_PATH_MARKER =
  "/*codexLinuxChromePluginAppServerSourcePath*/";
const LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_MARKERS = [
  LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_RUNTIME_MARKER,
  LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_CODEX_MARKER,
  LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_SOURCE_PATH_MARKER,
];
const LINUX_CHROME_PLUGIN_APP_SERVER_SOURCE_PATH_HELPER =
  "function codexLinuxChromePluginAppServerSourcePath(e){return e.codexCliPath}";
const CURRENT_CHROME_NATIVE_HOST_RUNTIME_MESSAGE =
  "Missing bundled Electron runtime required to sync Chrome native host resources";
const CURRENT_CHROME_APP_SERVER_CODEX_RUNTIME_MESSAGE =
  "Missing bundled Electron Codex runtime required to sync Chrome plugin app server";
const IDENTIFIER_PATTERN = "[A-Za-z_$][\\w$]*";

function markerCount(source, marker) {
  return source.split(marker).length - 1;
}

function matchesExactlyOnce(source, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))].length === 1;
}

function hasCompleteModernChromeNativeHostRuntimePatch(source) {
  return markerCount(source, LINUX_CHROME_NATIVE_HOST_RUNTIME_HELPER) === 1 &&
    LINUX_CHROME_NATIVE_HOST_RUNTIME_MODERN_MARKERS.every((marker) =>
      markerCount(source, marker) === 1
    ) &&
    matchesExactlyOnce(
      source,
      new RegExp(
        String.raw`codexLinuxChromeNativeHostRuntimeEntry\(codexLinuxChromeNativeHostRuntimePath\(\`codex\`\),\`linux-path\`\)\?\?`,
      ),
    ) &&
    matchesExactlyOnce(
      source,
      new RegExp(
        String.raw`codexLinuxChromeNativeHostRuntimeEntry\(codexLinuxChromeNativeHostRuntimeFile\(${IDENTIFIER_PATTERN},\[\[\`node-runtime\`,\`bin\`,${IDENTIFIER_PATTERN}===\`win32\`\?\`node\.exe\`:\`node\`\]\]\),\`linux-node-runtime\`\)\?\?`,
      ),
    ) &&
    matchesExactlyOnce(
      source,
      new RegExp(
        String.raw`codexLinuxChromeNativeHostRuntimeEntry\(codexLinuxChromeNativeHostRuntimeFile\(${IDENTIFIER_PATTERN},\[\[${IDENTIFIER_PATTERN}===\`win32\`\?\`node_repl\.exe\`:\`node_repl\`\]\]\),\`linux-node-repl-runtime\`\)\?\?`,
      ),
    );
}

function hasCompleteCurrentChromeAppServerRuntimePatch(source) {
  return markerCount(source, LINUX_CHROME_NATIVE_HOST_RUNTIME_HELPER) === 1 &&
    markerCount(source, LINUX_CHROME_PLUGIN_APP_SERVER_SOURCE_PATH_HELPER) === 1 &&
    LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_MARKERS.every((marker) =>
      markerCount(source, marker) === 1
    ) &&
    matchesExactlyOnce(
      source,
      new RegExp(
        String.raw`\/\*codexLinuxChromePluginAppServerSourcePath\*\/async function ${IDENTIFIER_PATTERN}\((?<sourceConfig>${IDENTIFIER_PATTERN})\)\{if\(process\.platform===\`linux\`\)return codexLinuxChromePluginAppServerSourcePath\(\k<sourceConfig>\);let ${IDENTIFIER_PATTERN}=\k<sourceConfig>\.nativeHostName===`,
      ),
    ) &&
    matchesExactlyOnce(
      source,
      new RegExp(
        String.raw`\/\*codexLinuxChromeNativeHostAppServerRuntime\*\/async function ${IDENTIFIER_PATTERN}\((?<runtimeConfig>${IDENTIFIER_PATTERN})\)\{let ${IDENTIFIER_PATTERN}=${IDENTIFIER_PATTERN}\(\k<runtimeConfig>\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(\`CODEX_CLI_PATH\`\)\?\?codexLinuxChromeNativeHostRuntimePath\(\`codex\`\),${IDENTIFIER_PATTERN}=${IDENTIFIER_PATTERN}\(\k<runtimeConfig>\.resourcesPath\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(\`CODEX_BROWSER_USE_NODE_PATH\`\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(\`NODE_REPL_NODE_PATH\`\)\?\?codexLinuxChromeNativeHostRuntimeFile\(\k<runtimeConfig>\.resourcesPath,\[\[\`node-runtime\`,\`bin\`,process\.platform===\`win32\`\?\`node\.exe\`:\`node\`\]\]\),${IDENTIFIER_PATTERN}=${IDENTIFIER_PATTERN}\(\k<runtimeConfig>\.resourcesPath\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(\`CODEX_NODE_REPL_PATH\`\)\?\?codexLinuxChromeNativeHostRuntimeFile\(\k<runtimeConfig>\.resourcesPath,\[\[process\.platform===\`win32\`\?\`node_repl\.exe\`:\`node_repl\`\]\]\),`,
      ),
    ) &&
    matchesExactlyOnce(
      source,
      new RegExp(
        String.raw`\/\*codexLinuxChromeNativeHostAppServerCodexRuntime\*\/async function ${IDENTIFIER_PATTERN}\((?<codexConfig>${IDENTIFIER_PATTERN})\)\{let (?<codexPath>${IDENTIFIER_PATTERN})=${IDENTIFIER_PATTERN}\(\k<codexConfig>\)\?\?codexLinuxChromeNativeHostRuntimeEnv\(\`CODEX_CLI_PATH\`\)\?\?codexLinuxChromeNativeHostRuntimePath\(\`codex\`\);if\(\k<codexPath>==null\)throw Error\(.+?\);return ${IDENTIFIER_PATTERN}\(\{codexCliPath:\k<codexPath>,codexHome:\k<codexConfig>\.codexHome,nativeHostName:\k<codexConfig>\.nativeHostName\}\)\}`,
      ),
    );
}

function hasAnyLinuxChromeNativeHostRuntimeMarker(source) {
  return source.includes("codexLinuxChromeNativeHostRuntime") ||
    source.includes("codexLinuxChromePluginAppServerSourcePath") ||
    LINUX_CHROME_NATIVE_HOST_RUNTIME_MODERN_MARKERS.some((marker) =>
      source.includes(marker)
    ) ||
    LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_MARKERS.some((marker) =>
      source.includes(marker)
    );
}

function hasCurrentModernChromeNativeHostRuntimeContract(source) {
  return source.includes("CODEX_BROWSER_USE_NODE_PATH") &&
    source.includes("nodeReplPathSource") &&
    source.includes("resolvePrimaryRuntimeNodePath");
}

function hasCurrentChromeAppServerRuntimeContract(source) {
  return source.includes(CURRENT_CHROME_NATIVE_HOST_RUNTIME_MESSAGE) &&
    source.includes(CURRENT_CHROME_APP_SERVER_CODEX_RUNTIME_MESSAGE) &&
    source.includes(".plugin-appserver");
}

function classifyChromeNativeHostRuntimeSource(source) {
  const shapes = [];
  if (hasCurrentModernChromeNativeHostRuntimeContract(source)) {
    shapes.push("modern");
  }
  if (hasCurrentChromeAppServerRuntimeContract(source)) {
    shapes.push("app-server");
  }

  const hasAnyMarker = hasAnyLinuxChromeNativeHostRuntimeMarker(source);
  if (shapes.length === 0) {
    const hasCurrentContractFragment =
      source.includes("CODEX_BROWSER_USE_NODE_PATH") ||
      source.includes(CURRENT_CHROME_NATIVE_HOST_RUNTIME_MESSAGE) ||
      source.includes(CURRENT_CHROME_APP_SERVER_CODEX_RUNTIME_MESSAGE) ||
      source.includes(".plugin-appserver");
    return {
      shapes,
      state: hasAnyMarker ? "partial" : hasCurrentContractFragment ? "drifted" : "irrelevant",
    };
  }

  const modernComplete = !shapes.includes("modern") ||
    hasCompleteModernChromeNativeHostRuntimePatch(source);
  const appServerComplete = !shapes.includes("app-server") ||
    hasCompleteCurrentChromeAppServerRuntimePatch(source);
  const unexpectedModernMarker = !shapes.includes("modern") &&
    LINUX_CHROME_NATIVE_HOST_RUNTIME_MODERN_MARKERS.some((marker) => source.includes(marker));
  const unexpectedAppServerMarker = !shapes.includes("app-server") &&
    LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_MARKERS.some((marker) => source.includes(marker));
  if (modernComplete && appServerComplete && !unexpectedModernMarker && !unexpectedAppServerMarker) {
    return { shapes, state: "complete" };
  }
  return { shapes, state: hasAnyMarker ? "partial" : "clean" };
}

function applyLinuxChromePluginAutoInstallPatch(currentSource) {
  const gateRegex =
    /\{([^{}]*?)(installWhenMissing:!0,)?name:([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*),([^{}]*?syncInstallStateWithChromeExtension:!0,isAvailable:\(\{buildFlavor:([A-Za-z_$][\w$]*),features:([A-Za-z_$][\w$]*)\}\)=>)((?:process\.platform===`linux`\|\|\()?\6\.externalBrowserUseAllowed&&[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\(\5\)\)?)\}/g;

  let sawChromeGate = false;
  const patched = currentSource.replace(
    gateRegex,
    (
      gateSource,
      prefix,
      installWhenMissing,
      nameExpr,
      middleFields,
      _buildFlavorVar,
      _featuresVar,
      expression,
    ) => {
      sawChromeGate = true;
      const hasInstallWhenMissing = installWhenMissing != null ||
        prefix.includes("installWhenMissing:!0");
      const hasLinuxAvailability = expression.startsWith("process.platform===`linux`||(");
      if (hasInstallWhenMissing && hasLinuxAvailability) {
        return gateSource;
      }

      const installWhenMissingField = hasInstallWhenMissing ? (installWhenMissing ?? "") : "installWhenMissing:!0,";
      const availabilityExpression = hasLinuxAvailability
        ? expression
        : `process.platform===\`linux\`||(${expression})`;
      return `{${prefix}${installWhenMissingField}name:${nameExpr},${middleFields}${availabilityExpression}}`;
    },
  );

  if (sawChromeGate) {
    return patched;
  }

  if (currentSource.includes("externalBrowserUseAllowed")) {
    throw new Error("Required Linux Chrome plugin auto-install patch failed: could not enable bundled Chrome auto-install");
  }

  console.warn(
    "WARN: Could not find Chrome plugin auto-install gate — skipping Linux Chrome plugin auto-install patch",
  );
  return currentSource;
}

function applyLinuxChromeNativeHostRuntimePatch(currentSource) {
  const classification = classifyChromeNativeHostRuntimeSource(currentSource);
  if (classification.state === "complete") {
    return currentSource;
  }
  if (classification.state === "partial") {
    console.warn(
      "WARN: Found incomplete Chrome native host runtime patch — skipping Linux runtime path patch",
    );
    return currentSource;
  }

  if (classification.state === "clean") {
    let patchedSource = currentSource;
    let helper = LINUX_CHROME_NATIVE_HOST_RUNTIME_HELPER;
    if (classification.shapes.includes("modern")) {
      const patched = applyModernChromeNativeHostRuntimePatch(patchedSource, helper);
      if (patched == null) {
        console.warn(
          "WARN: Could not identify Chrome native host runtime resolver shape — skipping Linux runtime path patch",
        );
        return currentSource;
      }
      patchedSource = patched;
      helper = "";
    }
    if (classification.shapes.includes("app-server")) {
      const patched = applyCurrentChromeAppServerRuntimePatches(patchedSource, helper);
      if (patched == null) {
        console.warn(
          "WARN: Could not identify current Chrome plugin app-server runtime contract — skipping Linux runtime path patch",
        );
        return currentSource;
      }
      patchedSource = patched;
    }

    if (classifyChromeNativeHostRuntimeSource(patchedSource).state === "complete") {
      return patchedSource;
    }
    console.warn(
      "WARN: Could not complete Chrome native host runtime patch contract — skipping Linux runtime path patch",
    );
    return currentSource;
  }

  if (classification.state === "drifted") {
    console.warn(
      "WARN: Could not identify Chrome native host runtime resolver shape — skipping Linux runtime path patch",
    );
    return currentSource;
  }

  console.warn(
    "WARN: Could not find Chrome native host runtime resolver — skipping Linux runtime path patch",
  );
  return currentSource;
}

function applyModernChromeNativeHostRuntimePatch(currentSource, helper) {
  if (
    !currentSource.includes("CODEX_BROWSER_USE_NODE_PATH") ||
    !currentSource.includes("nodeReplPathSource") ||
    !currentSource.includes("resolvePrimaryRuntimeNodePath")
  ) {
    return null;
  }

  const markerIndex = currentSource.indexOf("CODEX_BROWSER_USE_NODE_PATH");
  const functionStart = currentSource.lastIndexOf("function ", markerIndex);
  if (functionStart === -1) {
    return null;
  }
  const functionBodyMarker = currentSource.indexOf("){", functionStart);
  if (functionBodyMarker === -1) {
    return null;
  }
  const functionBrace = functionBodyMarker + 1;
  const functionEnd = findMatchingBrace(currentSource, functionBrace);
  if (functionEnd === -1) {
    return null;
  }

  const resolverSource = currentSource.slice(functionStart, functionEnd + 1);
  const varsMatch = resolverSource.match(
    /function [A-Za-z_$][\w$]*\(\{env:([A-Za-z_$][\w$]*)=process\.env,[^{}]*?platform:([A-Za-z_$][\w$]*)=process\.platform,[^{}]*?resourcesPath:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=\3\?\?/,
  );
  if (varsMatch == null) {
    return null;
  }
  const [, envVar, platformVar, , resourcesVar] = varsMatch;
  let patchedResolver = resolverSource;
  const codexPathRegex = new RegExp(
    String.raw`(rawValue:${envVar}\.CODEX_CLI_PATH,resolveWindowsAppsPath:[A-Za-z_$][\w$]*\}\)\?\?)([A-Za-z_$][\w$]*)\(\{devRelativePathSegments:\[\`extension\`,\`bin\`,\`codex\`\]`,
  );
  const nodePathRegex = new RegExp(
    String.raw`(rawValue:${envVar}\.CODEX_BROWSER_USE_NODE_PATH,resolveWindowsAppsPath:[A-Za-z_$][\w$]*\}\)\?\?)(\([A-Za-z_$][\w$]*\.path==null&&[A-Za-z_$][\w$]*!=null\?)`,
  );
  const nodeReplPathRegex = new RegExp(
    String.raw`(rawValue:${envVar}\.CODEX_NODE_REPL_PATH,resolveWindowsAppsPath:[A-Za-z_$][\w$]*\}\)\?\?)([A-Za-z_$][\w$]*)\(\{devRelativePathSegments:null`,
  );

  patchedResolver = patchedResolver.replace(
    codexPathRegex,
    (_match, prefix, resolverFn) =>
      `${prefix}codexLinuxChromeNativeHostRuntimeEntry(codexLinuxChromeNativeHostRuntimePath(\`codex\`),\`linux-path\`)??${resolverFn}({devRelativePathSegments:[\`extension\`,\`bin\`,\`codex\`]`,
  );
  if (patchedResolver === resolverSource) {
    return null;
  }
  const codexPatchedResolver = patchedResolver;
  patchedResolver = patchedResolver.replace(
    nodePathRegex,
    (_match, prefix, fallbackExpressionStart) =>
      `${prefix}codexLinuxChromeNativeHostRuntimeEntry(codexLinuxChromeNativeHostRuntimeFile(${resourcesVar},[[\`node-runtime\`,\`bin\`,${platformVar}===\`win32\`?\`node.exe\`:\`node\`]]),\`linux-node-runtime\`)??${fallbackExpressionStart}`,
  );
  if (patchedResolver === codexPatchedResolver) {
    return null;
  }
  const nodePatchedResolver = patchedResolver;
  patchedResolver = patchedResolver.replace(
    nodeReplPathRegex,
    (_match, prefix, resolverFn) =>
      `${prefix}codexLinuxChromeNativeHostRuntimeEntry(codexLinuxChromeNativeHostRuntimeFile(${resourcesVar},[[${platformVar}===\`win32\`?\`node_repl.exe\`:\`node_repl\`]]),\`linux-node-repl-runtime\`)??${resolverFn}({devRelativePathSegments:null`,
  );
  if (patchedResolver === nodePatchedResolver) {
    return null;
  }

  const patchedSource = currentSource.slice(0, functionStart) +
    helper +
    patchedResolver +
    currentSource.slice(functionEnd + 1);
  return hasCompleteModernChromeNativeHostRuntimePatch(patchedSource)
    ? patchedSource
    : null;
}

function applyCurrentChromeAppServerRuntimePatches(currentSource, helper) {
  let patchedSource = applyLinuxChromePluginAppServerSourcePathPatch(currentSource);
  if (patchedSource == null) {
    return null;
  }

  patchedSource = applyChromePluginAppServerRuntimePatch(patchedSource, helper);
  if (patchedSource == null) {
    return null;
  }

  patchedSource = applyChromePluginCodexAppServerRuntimePatch(patchedSource, "");
  if (patchedSource == null) {
    return null;
  }

  return hasCompleteCurrentChromeAppServerRuntimePatch(patchedSource)
    ? patchedSource
    : null;
}

function applyLinuxChromePluginAppServerSourcePathPatch(currentSource) {
  const isolationRoot = currentSource.indexOf(".plugin-appserver");
  if (isolationRoot === -1) {
    return null;
  }

  const isolationSource = currentSource.slice(isolationRoot, isolationRoot + 12_000);
  const syncFunctionRegex =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{(?=let [A-Za-z_$][\w$]*=\2\.nativeHostName===)/;
  const match = isolationSource.match(syncFunctionRegex);
  if (match == null) {
    return null;
  }

  const [functionStart, , configVar] = match;
  const functionIndex = isolationRoot + match.index;
  return currentSource.slice(0, functionIndex) +
    `${LINUX_CHROME_PLUGIN_APP_SERVER_SOURCE_PATH_HELPER}${LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_SOURCE_PATH_MARKER}${functionStart}if(process.platform===\`linux\`)return codexLinuxChromePluginAppServerSourcePath(${configVar});` +
    currentSource.slice(functionIndex + functionStart.length);
}

function applyChromePluginAppServerRuntimePatch(currentSource, helper) {
  const appServerRuntimeRegex =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\.resourcesPath\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\.resourcesPath\),/;
  const match = currentSource.match(appServerRuntimeRegex);
  if (match == null) {
    return null;
  }
  const [
    originalPrefix,
    resolverFn,
    configVar,
    codexVar,
    codexResolverFn,
    nodeVar,
    nodeResolverFn,
    nodeReplVar,
    nodeReplResolverFn,
  ] = match;
  const replacement =
    `${helper}${LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_RUNTIME_MARKER}async function ${resolverFn}(${configVar}){let ${codexVar}=${codexResolverFn}(${configVar})??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_CLI_PATH\`)??codexLinuxChromeNativeHostRuntimePath(\`codex\`),${nodeVar}=${nodeResolverFn}(${configVar}.resourcesPath)??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_BROWSER_USE_NODE_PATH\`)??codexLinuxChromeNativeHostRuntimeEnv(\`NODE_REPL_NODE_PATH\`)??codexLinuxChromeNativeHostRuntimeFile(${configVar}.resourcesPath,[[\`node-runtime\`,\`bin\`,process.platform===\`win32\`?\`node.exe\`:\`node\`]]),${nodeReplVar}=${nodeReplResolverFn}(${configVar}.resourcesPath)??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_NODE_REPL_PATH\`)??codexLinuxChromeNativeHostRuntimeFile(${configVar}.resourcesPath,[[process.platform===\`win32\`?\`node_repl.exe\`:\`node_repl\`]]),`;
  return currentSource.replace(originalPrefix, replacement);
}

function applyChromePluginCodexAppServerRuntimePatch(currentSource, helper) {
  const appServerCodexRuntimeRegex =
    /async function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\);if\(\3==null\)throw Error\(`Missing bundled Electron Codex runtime required to sync Chrome plugin app server for \$\{\2\.nativeHostName\} \(resourcesPath: \$\{\2\.resourcesPath\?\?`<none>`\}\)\.\`\);return ([A-Za-z_$][\w$]*)\(\{codexCliPath:\3,codexHome:\2\.codexHome,nativeHostName:\2\.nativeHostName\}\)\}/;
  const match = currentSource.match(appServerCodexRuntimeRegex);
  if (match == null) {
    return null;
  }
  const [
    original,
    resolverFn,
    configVar,
    codexVar,
    bundledCodexResolverFn,
    syncFn,
  ] = match;
  const replacement =
    `${helper}${LINUX_CHROME_NATIVE_HOST_RUNTIME_APP_SERVER_CODEX_MARKER}async function ${resolverFn}(${configVar}){let ${codexVar}=${bundledCodexResolverFn}(${configVar})??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_CLI_PATH\`)??codexLinuxChromeNativeHostRuntimePath(\`codex\`);if(${codexVar}==null)throw Error(\`Missing bundled Electron Codex runtime required to sync Chrome plugin app server for \${${configVar}.nativeHostName} (resourcesPath: \${${configVar}.resourcesPath??\`<none>\`}).\`);return ${syncFn}({codexCliPath:${codexVar},codexHome:${configVar}.codexHome,nativeHostName:${configVar}.nativeHostName})}`;
  return currentSource.replace(original, replacement);
}

function writeChromeNativeHostRuntimeAssetCandidates(
  candidates,
  writeFileSync,
  readFileSync,
) {
  const attempted = [];
  try {
    for (const candidate of candidates) {
      attempted.push(candidate);
      writeFileSync(candidate.filePath, candidate.patched, "utf8");
    }
  } catch (error) {
    const rollbackWriteFailures = [];
    for (const candidate of attempted.reverse()) {
      try {
        writeFileSync(candidate.filePath, candidate.source, "utf8");
      } catch (rollbackError) {
        rollbackWriteFailures.push(rollbackError);
      }
    }

    const rollbackVerificationFailures = [];
    for (const candidate of attempted) {
      try {
        if (readFileSync(candidate.filePath, "utf8") !== candidate.source) {
          rollbackVerificationFailures.push(
            new Error(`rollback byte verification failed for ${candidate.filePath}`),
          );
        }
      } catch (rollbackError) {
        rollbackVerificationFailures.push(rollbackError);
      }
    }

    if (rollbackVerificationFailures.length > 0) {
      const writeFailureContext = rollbackWriteFailures[0] == null
        ? ""
        : `; rollback write also failed: ${rollbackWriteFailures[0].message}`;
      const integrityError = new PatchIntegrityError(
        `Chrome native host runtime rollback could not restore original bytes: ${rollbackVerificationFailures[0].message}${writeFailureContext}`,
      );
      throw integrityError;
    }

    throw error;
  }
}

function patchLinuxChromeNativeHostRuntimeAssets(extractedDir, {
  writeFileSync = fs.writeFileSync,
  readFileSync = fs.readFileSync,
} = {}) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    const reason = `Could not find build directory in ${buildDir}`;
    console.warn(`WARN: ${reason} — skipping Linux Chrome native host runtime patch`);
    return { matched: 0, changed: 0, reason };
  }

  const records = [];
  for (const fileName of readDirectoryNames(buildDir).filter((name) => name.endsWith(".js")).sort()) {
    const filePath = path.join(buildDir, fileName);
    const source = fs.readFileSync(filePath, "utf8");
    const classification = classifyChromeNativeHostRuntimeSource(source);
    if (classification.state === "irrelevant") {
      continue;
    }
    records.push({ classification, filePath, source });
  }

  if (records.length === 0) {
    return { matched: 0, changed: 0 };
  }
  if (records.some(({ classification }) => classification.state === "drifted")) {
    const reason = "Could not identify complete current Chrome native host runtime asset set";
    console.warn(`WARN: ${reason} — skipping Linux runtime path patch`);
    return { matched: records.length, changed: 0, reason };
  }

  const shapeCounts = new Map();
  for (const { classification } of records) {
    for (const shape of classification.shapes) {
      shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
    }
  }
  const missingOrAmbiguousShapes = ["modern", "app-server"].filter(
    (shape) => shapeCounts.get(shape) !== 1,
  );
  if (missingOrAmbiguousShapes.length > 0) {
    const reason = `Expected exactly one current Chrome native host runtime ${missingOrAmbiguousShapes.join(" and ")} asset`;
    console.warn(`WARN: ${reason} — skipping Linux runtime path patch`);
    return { matched: records.length, changed: 0, reason };
  }
  if (records.some(({ classification }) => classification.state === "partial")) {
    const reason = "Found incomplete Chrome native host runtime patch";
    console.warn(`WARN: ${reason} — skipping Linux runtime path patch`);
    return { matched: records.length, changed: 0, reason };
  }

  const allComplete = records.every(({ classification }) => classification.state === "complete");
  if (allComplete) {
    return { matched: records.length, changed: 0 };
  }
  const allClean = records.every(({ classification }) => classification.state === "clean");
  if (!allClean) {
    const reason = "Found mixed current Chrome native host runtime patch state";
    console.warn(`WARN: ${reason} — skipping Linux runtime path patch`);
    return { matched: records.length, changed: 0, reason };
  }

  const candidates = [];
  for (const record of records) {
    const patched = applyLinuxChromeNativeHostRuntimePatch(record.source);
    if (patched === record.source || classifyChromeNativeHostRuntimeSource(patched).state !== "complete") {
      const reason = "Could not complete current Chrome native host runtime patch contract";
      console.warn(`WARN: ${reason} — skipping Linux runtime path patch`);
      return { matched: records.length, changed: 0, reason };
    }
    candidates.push({ ...record, patched });
  }

  try {
    writeChromeNativeHostRuntimeAssetCandidates(
      candidates,
      writeFileSync,
      readFileSync,
    );
  } catch (error) {
    if (isPatchIntegrityError(error)) {
      throw error;
    }

    const reason = "Could not write current Chrome native host runtime asset set";
    console.warn(`WARN: ${reason} — skipping Linux runtime path patch`);
    return { matched: records.length, changed: 0, reason };
  }

  return { matched: records.length, changed: candidates.length };
}

module.exports = {
  applyLinuxChromeNativeHostRuntimePatch,
  applyLinuxChromePluginAutoInstallPatch,
  patchLinuxChromeNativeHostRuntimeAssets,
};
