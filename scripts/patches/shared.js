"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Shared bundle helpers. Keep these small and syntax-oriented; feature-specific
// policy belongs in the individual patch modules.
const TRAY_GUARD_LOOKAHEAD = 1200;
const CLOSE_GATE_PREFIX_LOOKBACK = 8000;
const HANDLER_PREFIX_LOOKBACK = 12000;

const linuxSettingsKeys = {
  readAloud: "codex-linux-read-aloud-enabled",
  readAloudKokoroSpeed: "codex-linux-read-aloud-kokoro-speed",
  promptWindow: "codex-linux-prompt-window-enabled",
  systemTray: "codex-linux-system-tray-enabled",
  warmStart: "codex-linux-warm-start-enabled",
  autoUpdateOnExit: "codex-linux-auto-update-on-exit",
  wrapperUpdates: "codex-linux-wrapper-updates-enabled",
  featurePickerOnUpdate: "codex-linux-feature-picker-on-update",
};

function readDirectoryNames(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir);
}

function findMainBundle(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainBundle = readDirectoryNames(buildDir).find((name) =>
    /^main(?:-[^.]+)?\.js$/.test(name),
  );

  return mainBundle == null ? null : { buildDir, mainBundle };
}

function findIconAsset(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  return readDirectoryNames(assetsDir).find((name) => /^app-.*\.png$/.test(name)) ?? null;
}

const keybindsSettingsAsset = "keybinds-settings-linux.js";
const linuxKeybindOverridesKey = "codex-linux-keybind-overrides";

const COMPUTER_USE_UI_ENV_VAR = "CODEX_LINUX_ENABLE_COMPUTER_USE_UI";
const COMPUTER_USE_UI_SETTINGS_KEY = "codex-linux-computer-use-ui-enabled";

// Two opt-in surfaces, both checked at build time:
//
// 1. Env var `CODEX_LINUX_ENABLE_COMPUTER_USE_UI=1` — for ad-hoc builds
//    (`make build-app`, manual `make package`).
// 2. Persisted flag `codex-linux-computer-use-ui-enabled: true` in
//    `~/.config/codex-desktop/settings.json` — for the auto-updater path,
//    where the systemd user service does not inherit interactive shell env.
//
// Either path enables the three Statsig-bypass-style Computer Use UI patches
// (`applyLinuxComputerUseFeaturePatch`, `applyLinuxComputerUseRendererAvailabilityPatch`,
// `applyLinuxComputerUseInstallFlowPatch`). The plugin manifest gate
// (`applyLinuxComputerUsePluginGatePatch`) is pure platform-port glue and
// stays unconditional — it is what we have shipped on by default since the
// project's first release.

function regexpTest(filenamePattern, name) {
  filenamePattern.lastIndex = 0;
  return filenamePattern.test(name);
}

function patchAssetFiles(extractedDir, filenamePattern, patchFn, missingWarnMessage) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    console.warn(
      `WARN: Could not find webview assets directory in ${webviewAssetsDir} — skipping asset patch`,
    );
    return { matched: 0, changed: 0 };
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(filenamePattern, name))
    .sort();

  if (candidates.length === 0) {
    console.warn(missingWarnMessage);
    return { matched: 0, changed: 0 };
  }

  // Buffer writes until every candidate has been patched so a throw partway
  // through leaves no half-patched mix of assets on disk.
  const pendingWrites = [];
  for (const candidate of candidates) {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    const patchedSource = patchFn(currentSource);
    if (patchedSource !== currentSource) {
      pendingWrites.push({ filePath, patchedSource });
    }
  }
  for (const { filePath, patchedSource } of pendingWrites) {
    fs.writeFileSync(filePath, patchedSource, "utf8");
  }

  return { matched: candidates.length, changed: pendingWrites.length };
}

function readWebviewAsset(webviewAssetsDir, assetName) {
  return fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8");
}

function findRequiredWebviewAsset(webviewAssetsDir, filenamePattern, marker, description) {
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(filenamePattern, name))
    .sort();
  const matches = marker == null
    ? candidates
    : candidates.filter((name) => readWebviewAsset(webviewAssetsDir, name).includes(marker));

  if (matches.length === 0) {
    throw new Error(`Required Keybinds settings patch failed: could not find ${description}`);
  }

  return matches[0];
}

function findExportedAlias(source, localName) {
  const exportList = source.match(/export\{([^}]*)\}/)?.[1];
  if (exportList == null) {
    return null;
  }

  for (const rawEntry of exportList.split(",")) {
    const entry = rawEntry.trim();
    const aliasMatch = entry.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (aliasMatch != null && aliasMatch[1] === localName) {
      return aliasMatch[2];
    }
    if (entry === localName) {
      return localName;
    }
  }

  return null;
}

function findCodexRequestExportName(source) {
  const match = source.match(
    /async function\s+([A-Za-z_$][\w$]*)\(\.\.\.[^)]+\)\{let\[[^\]]+\]=[^;]+,\{params:[^}]+source:[^}]+\}=[^;]+;return\s+[A-Za-z_$][\w$]*\([^)]*\)\}/,
  );
  if (match == null) {
    return null;
  }

  return findExportedAlias(source, match[1]);
}

function findCodexRequestWebviewAsset(webviewAssetsDir) {
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Required Keybinds settings patch failed: missing webview assets directory ${webviewAssetsDir}`);
  }

  const legacyAsset = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(/^vscode-api-.*\.js$/, name))
    .sort()
    .find((name) => readWebviewAsset(webviewAssetsDir, name).includes("vscode://codex"));
  if (legacyAsset != null) {
    return { assetName: legacyAsset, exportName: "n" };
  }

  const modernCandidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(/^setting-storage-.*\.js$/, name))
    .sort();
  for (const candidate of modernCandidates) {
    const source = readWebviewAsset(webviewAssetsDir, candidate);
    if (!source.includes("vscode://codex/")) {
      continue;
    }
    const exportName = findCodexRequestExportName(source);
    if (exportName != null) {
      return { assetName: candidate, exportName };
    }
  }

  throw new Error("Required Keybinds settings patch failed: could not find Codex request API asset");
}

function findImportedAsset(webviewAssetsDir, importerAsset, description) {
  const importedAsset = readWebviewAsset(webviewAssetsDir, importerAsset).match(/from"\.\/([^"]+)"/)?.[1];
  if (!importedAsset || !fs.existsSync(path.join(webviewAssetsDir, importedAsset))) {
    throw new Error(`Required Keybinds settings patch failed: could not find ${description}`);
  }
  return importedAsset;
}

function requireName(source, moduleName) {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`([A-Za-z_$][\\w$]*)=require\\(([\\\`"'])${escaped}\\2\\)`));
  return match?.[1] ?? null;
}

function inferModuleAlias(source, moduleName) {
  const requiredName = requireName(source, moduleName);
  if (requiredName != null) {
    return requiredName;
  }

  if (moduleName === "electron") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{app:\{/u)?.[1] ?? null;
  }
  if (moduleName === "node:path") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{default:\{dirname\(/u)?.[1] ?? null;
  }
  if (moduleName === "node:fs") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{mkdirSync\(/u)?.[1] ?? null;
  }
  if (moduleName === "node:net") {
    return source.match(/(?:let|,)\s*([A-Za-z_$][\w$]*)=\{default:\{createServer\(/u)?.[1] ?? null;
  }

  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findCallBlock(source, marker) {
  const markerStart = source.indexOf(marker);
  if (markerStart === -1) {
    return null;
  }

  const blockStart = Math.max(
    source.lastIndexOf("var ", markerStart),
    source.lastIndexOf("let ", markerStart),
    source.lastIndexOf("const ", markerStart),
  );
  const blockEnd = source.indexOf("});", markerStart);
  if (blockStart === -1 || blockEnd === -1) {
    return null;
  }

  return {
    start: blockStart,
    end: blockEnd + "});".length,
    text: source.slice(blockStart, blockEnd + "});".length),
  };
}

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function findLastRegexMatch(source, regex) {
  regex.lastIndex = 0;
  let lastMatch = null;
  let match;
  while ((match = regex.exec(source)) != null) {
    lastMatch = match;
    if (match[0].length === 0) {
      regex.lastIndex += 1;
    }
  }
  return lastMatch;
}

function findLinuxGlobalStateExpression(prefix) {
  const objectStateMatch = findLastRegexMatch(prefix, /(?:let|,)\s*([A-Za-z_$][\w$]*)=\{globalState:/g);
  const propertyStateMatch = findLastRegexMatch(prefix, /globalState:([A-Za-z_$][\w$]*)\.globalState/g);

  if (objectStateMatch != null && (propertyStateMatch == null || objectStateMatch.index > propertyStateMatch.index)) {
    return `${objectStateMatch[1]}.globalState`;
  }
  if (propertyStateMatch != null) {
    return `${propertyStateMatch[1]}.globalState`;
  }

  return null;
}

function findDisposableVar(prefix) {
  const explicitVar = findLastRegexMatch(prefix, /disposables:([A-Za-z_$][\w$]*)/g)?.[1];
  if (explicitVar != null) {
    return explicitVar;
  }

  const adjacentCtorVar = findLastRegexMatch(
    prefix,
    /([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*;\1\.add\(/g,
  )?.[1];
  if (adjacentCtorVar != null) {
    return adjacentCtorVar;
  }

  const constructedVar = findLastRegexMatch(
    prefix,
    /([A-Za-z_$][\w$]*)=new [A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*/g,
  )?.[1];
  if (constructedVar != null && prefix.includes(`${constructedVar}.add(`)) {
    return constructedVar;
  }

  return null;
}

module.exports = {
  CLOSE_GATE_PREFIX_LOOKBACK,
  HANDLER_PREFIX_LOOKBACK,
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findCallBlock,
  findCodexRequestWebviewAsset,
  findDisposableVar,
  findExportedAlias,
  findIconAsset,
  findImportedAsset,
  findLastRegexMatch,
  findLinuxGlobalStateExpression,
  findMainBundle,
  findMatchingBrace,
  findRequiredWebviewAsset,
  inferModuleAlias,
  linuxSettingsKeys,
  patchAssetFiles,
  readDirectoryNames,
  readWebviewAsset,
  requireName,
};
