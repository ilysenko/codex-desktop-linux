"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  readDirectoryNames,
  requireName,
} = require("./shared.js");

function hasChromePluginLiteral(source) {
  return /(?:`chrome`|"chrome"|'chrome')/.test(source);
}

function isChromeNameExpr(nameExpr, chromeNameVar) {
  return /^(?:`chrome`|"chrome"|'chrome')$/.test(nameExpr) ||
    nameExpr === chromeNameVar;
}

function hasChromeAutoInstall(source, chromeNameVar) {
  const namePatterns = [String.raw`\`chrome\``, "\"chrome\"", "'chrome'"];
  if (chromeNameVar != null) {
    namePatterns.push(chromeNameVar);
  }
  return new RegExp(String.raw`installWhenMissing:!0,name:(?:${namePatterns.join("|")})`).test(source);
}

function applyLinuxChromePluginAutoInstallPatch(currentSource) {
  if (!hasChromePluginLiteral(currentSource)) {
    console.warn(
      "WARN: Could not find Chrome plugin gate literal — skipping Linux Chrome plugin auto-install patch",
    );
    return currentSource;
  }

  const chromeNameVar = currentSource.match(/([A-Za-z_$][\w$]*)=(?:`chrome`|"chrome"|'chrome')/)?.[1] ?? null;
  const nameExpressionPattern = String.raw`(?:[A-Za-z_$][\w$]*|` +
    String.raw`\`chrome\`|"chrome"|'chrome')`;
  const gateRegex =
    new RegExp(
      String.raw`\{([^{}]*?)(installWhenMissing:!0,)?name:(${nameExpressionPattern}),([^{}]*?)(isEnabled|isAvailable):\(\{([^}]*)\}\)=>([^{}]*?externalBrowserUseAllowed[^{}]*?)(,migrate:[A-Za-z_$][\w$]*)?\}`,
      "g",
    );

  let sawChromeGate = false;
  let sawAlreadyInstalledGate = false;
  const patched = currentSource.replace(
    gateRegex,
    (
      gateSource,
      prefix,
      installWhenMissing,
      nameExpr,
      middleFields,
      availabilityProp,
      paramsText,
      expression,
      migrateSuffix = "",
    ) => {
      if (!isChromeNameExpr(nameExpr, chromeNameVar)) {
        return gateSource;
      }

      sawChromeGate = true;
      if (installWhenMissing != null || prefix.includes("installWhenMissing:!0")) {
        sawAlreadyInstalledGate = true;
        return gateSource;
      }

      return `{${prefix}installWhenMissing:!0,name:${nameExpr},${middleFields}${availabilityProp}:({${paramsText}})=>${expression}${migrateSuffix}}`;
    },
  );

  if (patched !== currentSource || (sawChromeGate && sawAlreadyInstalledGate)) {
    return patched;
  }

  if (hasChromeAutoInstall(currentSource, chromeNameVar)) {
    return currentSource;
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
  if (currentSource.includes("codexLinuxChromeNativeHostRuntimeFile")) {
    return currentSource;
  }

  const missingRuntimeMessage =
    "Missing bundled Electron runtime required to sync Chrome native host resources";
  if (!currentSource.includes(missingRuntimeMessage)) {
    console.warn(
      "WARN: Could not find Chrome native host runtime resolver — skipping Linux runtime path patch",
    );
    return currentSource;
  }

  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (fsVar == null || pathVar == null) {
    console.warn(
      "WARN: Could not find fs/path aliases — skipping Linux Chrome native host runtime patch",
    );
    return currentSource;
  }

  const runtimeResolverRegex =
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\.resourcesPath\)\?\?([A-Za-z_$][\w$]*)\(\2\.devRuntimeRepoRoot,\[`extension`,`bin`,process\.platform===`win32`\?`codex\.exe`:`codex`\]\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\.resourcesPath\)\?\?\5\(\2\.devRuntimeRepoRoot,\[`electron`,`bin`,process\.platform===`win32`\?`node\.exe`:`node`\]\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\2\.resourcesPath\)\?\?\5\(\2\.devRuntimeRepoRoot,\[`electron`,`bin`,process\.platform===`win32`\?`node_repl\.exe`:`node_repl`\]\),/;
  const match = currentSource.match(runtimeResolverRegex);
  if (match == null) {
    console.warn(
      "WARN: Could not identify Chrome native host runtime resolver shape — skipping Linux runtime path patch",
    );
    return currentSource;
  }

  const [
    originalPrefix,
    resolverName,
    configVar,
    codexVar,
    codexResourceFn,
    devRuntimeFn,
    nodeVar,
    nodeResourceFn,
    nodeReplVar,
    nodeReplResourceFn,
  ] = match;
  const helper =
    `function codexLinuxChromeNativeHostRuntimeFile(e,t){if(process.platform!==\`linux\`||e==null)return null;for(let n of t){let t=(0,${pathVar}.join)(e,...n);try{if((0,${fsVar}.statSync)(t).isFile())return t}catch{}}return null}function codexLinuxChromeNativeHostRuntimeEnv(e){if(process.platform!==\`linux\`)return null;let t=process.env[e];if(t==null||t.length===0)return null;try{return(0,${fsVar}.statSync)(t).isFile()?t:null}catch{return null}}function codexLinuxChromeNativeHostRuntimePath(e){if(process.platform!==\`linux\`)return null;for(let t of(process.env.PATH??\`\`).split(\`:\`)){if(t.length===0)continue;let n=(0,${pathVar}.join)(t,e);try{if((0,${fsVar}.statSync)(n).isFile())return n}catch{}}return null}`;
  const replacement =
    `${helper}function ${resolverName}(${configVar}){let ${codexVar}=${codexResourceFn}(${configVar}.resourcesPath)??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_CLI_PATH\`)??codexLinuxChromeNativeHostRuntimePath(\`codex\`)??${devRuntimeFn}(${configVar}.devRuntimeRepoRoot,[\`extension\`,\`bin\`,process.platform===\`win32\`?\`codex.exe\`:\`codex\`]),${nodeVar}=${nodeResourceFn}(${configVar}.resourcesPath)??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_BROWSER_USE_NODE_PATH\`)??codexLinuxChromeNativeHostRuntimeEnv(\`NODE_REPL_NODE_PATH\`)??codexLinuxChromeNativeHostRuntimeFile(${configVar}.resourcesPath,[[\`node-runtime\`,\`bin\`,process.platform===\`win32\`?\`node.exe\`:\`node\`]])??${devRuntimeFn}(${configVar}.devRuntimeRepoRoot,[\`electron\`,\`bin\`,process.platform===\`win32\`?\`node.exe\`:\`node\`]),${nodeReplVar}=${nodeReplResourceFn}(${configVar}.resourcesPath)??codexLinuxChromeNativeHostRuntimeEnv(\`CODEX_NODE_REPL_PATH\`)??codexLinuxChromeNativeHostRuntimeFile(${configVar}.resourcesPath,[[process.platform===\`win32\`?\`node_repl.exe\`:\`node_repl\`]])??${devRuntimeFn}(${configVar}.devRuntimeRepoRoot,[\`electron\`,\`bin\`,process.platform===\`win32\`?\`node_repl.exe\`:\`node_repl\`]),`;

  return currentSource.replace(originalPrefix, replacement);
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
      !source.includes("Missing bundled Electron runtime required to sync Chrome native host resources") &&
      !source.includes("codexLinuxChromeNativeHostRuntimeFile")
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
