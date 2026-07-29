"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

const LINUX_CHROME_NATIVE_HOST_RUNTIME_MARKERS = [
  "codexLinuxChromeNativeHostRuntimeEntry(codexLinuxChromeNativeHostRuntimePath(`codex`),`linux-path`)",
  "`linux-node-runtime`",
  "`linux-node-repl-runtime`",
];

function markerCount(source, marker) {
  return source.split(marker).length - 1;
}

function hasCompleteLinuxChromeNativeHostRuntimePatch(source) {
  return markerCount(source, LINUX_CHROME_NATIVE_HOST_RUNTIME_HELPER) === 1 &&
    LINUX_CHROME_NATIVE_HOST_RUNTIME_MARKERS.every((marker) =>
      markerCount(source, marker) === 1
    );
}

function hasAnyLinuxChromeNativeHostRuntimeMarker(source) {
  return source.includes("codexLinuxChromeNativeHostRuntime") ||
    LINUX_CHROME_NATIVE_HOST_RUNTIME_MARKERS.some((marker) =>
      source.includes(marker)
    );
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
  if (hasCompleteLinuxChromeNativeHostRuntimePatch(currentSource)) {
    return currentSource;
  }
  if (hasAnyLinuxChromeNativeHostRuntimeMarker(currentSource)) {
    console.warn(
      "WARN: Found incomplete Chrome native host runtime patch — skipping Linux runtime path patch",
    );
    return currentSource;
  }

  const patched = applyModernChromeNativeHostRuntimePatch(
    currentSource,
    LINUX_CHROME_NATIVE_HOST_RUNTIME_HELPER,
  );
  if (patched != null) {
    return patched;
  }

  if (
    currentSource.includes("CODEX_BROWSER_USE_NODE_PATH") &&
    currentSource.includes("nodeReplPathSource") &&
    currentSource.includes("resolvePrimaryRuntimeNodePath")
  ) {
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
  return hasCompleteLinuxChromeNativeHostRuntimePatch(patchedSource)
    ? patchedSource
    : null;
}

function patchLinuxChromeNativeHostRuntimeAssets(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    const reason = `Could not find build directory in ${buildDir}`;
    console.warn(`WARN: ${reason} — skipping Linux Chrome native host runtime patch`);
    return { matched: 0, changed: 0, reason };
  }

  let matched = 0;
  let changed = 0;
  for (const fileName of readDirectoryNames(buildDir).filter((name) => name.endsWith(".js")).sort()) {
    const filePath = path.join(buildDir, fileName);
    const source = fs.readFileSync(filePath, "utf8");
    if (
      !source.includes("codexLinuxChromeNativeHostRuntime") &&
      !(
        source.includes("CODEX_BROWSER_USE_NODE_PATH") &&
        source.includes("nodeReplPathSource") &&
        source.includes("resolvePrimaryRuntimeNodePath")
      )
    ) {
      continue;
    }

    matched += 1;
    const patched = applyLinuxChromeNativeHostRuntimePatch(source);
    if (patched !== source) {
      fs.writeFileSync(filePath, patched, "utf8");
      changed += 1;
    }
  }

  return { matched, changed };
}

module.exports = {
  applyLinuxChromeNativeHostRuntimePatch,
  applyLinuxChromePluginAutoInstallPatch,
  patchLinuxChromeNativeHostRuntimeAssets,
};
