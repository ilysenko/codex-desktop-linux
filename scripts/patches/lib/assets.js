"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findExportedAlias } = require("./minified-js.js");

function readDirectoryNames(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir);
}

// The official main process is an rspack build: the `early-bootstrap.js`
// entry plus numbered `early-bootstrap-<id>-<hash>.js` chunks. Main-process
// code is spread across several chunks, so patches search all of them.
const MAIN_PROCESS_CHUNK_PATTERN = /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/;

function findMainProcessChunks(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const chunks = readDirectoryNames(buildDir)
    .filter((name) => MAIN_PROCESS_CHUNK_PATTERN.test(name))
    .sort();

  return chunks.length === 0 ? null : { buildDir, chunks };
}

function findIconAsset(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  return readDirectoryNames(assetsDir).find((name) => /^app-.*\.png$/.test(name)) ?? null;
}

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

function patchUniqueAssetFile(
  extractedDir,
  filenamePattern,
  assetMatch,
  patchFn,
  missingWarnMessage,
  ambiguousWarnMessage,
) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    console.warn(
      `WARN: Could not find webview assets directory in ${webviewAssetsDir} — skipping asset patch`,
    );
    return { matched: 0, changed: 0, assetName: null };
  }

  const matches = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(filenamePattern, name))
    .sort()
    .map((assetName) => ({
      assetName,
      source: fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8"),
    }))
    .filter(({ assetName, source }) => assetMatch(source, assetName));

  if (matches.length === 0) {
    console.warn(missingWarnMessage);
    return { matched: 0, changed: 0, assetName: null };
  }
  if (matches.length !== 1) {
    console.warn(`${ambiguousWarnMessage}: ${matches.map(({ assetName }) => assetName).join(", ")}`);
    return { matched: matches.length, changed: 0, assetName: null };
  }

  const [{ assetName, source }] = matches;
  const patchedSource = patchFn(source);
  if (patchedSource === source) {
    return { matched: 1, changed: 0, assetName };
  }
  fs.writeFileSync(path.join(webviewAssetsDir, assetName), patchedSource, "utf8");
  return { matched: 1, changed: 1, assetName };
}

function readWebviewAsset(webviewAssetsDir, assetName) {
  return fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8");
}

function findRequiredWebviewAsset(webviewAssetsDir, filenamePattern, marker, description) {
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Missing webview assets directory ${webviewAssetsDir}`);
  }

  const candidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(filenamePattern, name))
    .sort();
  const matches = marker == null
    ? candidates
    : candidates.filter((name) => readWebviewAsset(webviewAssetsDir, name).includes(marker));

  if (matches.length === 0) {
    throw new Error(`Could not find ${description} in ${webviewAssetsDir}`);
  }

  return matches[0];
}

function findCodexRequestExportName(source) {
  let match = source.match(
    /async function\s+([A-Za-z_$][\w$]*)\(\.\.\.[^)]+\)\{let\[[^\]]+\]=[^;]+,\{params:[^}]+source:[^}]+\}=[^;]+;return\s+[A-Za-z_$][\w$]*\([^)]*\)\}/,
  );
  if (match != null) {
    return findExportedAlias(source, match[1]);
  }

  match = source.match(
    /function\s+([A-Za-z_$][\w$]*)\(\.\.\.[^)]+\)\{let\[[^\]]+\]=[^;]+,\{params:[^}]+select:[^}]+signal:[^}]+source:[^}]+\}=[^;]+;return\s+([A-Za-z_$][\w$]*)\([^)]*\)\}/,
  );
  if (match != null) {
    const [, wrapperName, rawRequestName] = match;
    const rawRequestPattern = new RegExp(
      `async function\\s+${rawRequestName}\\([^)]*\\)\\{[\\s\\S]{0,600}?vscode://codex/`,
    );
    if (rawRequestPattern.test(source)) {
      return findExportedAlias(source, wrapperName);
    }
  }

  return null;
}

function findCodexRequestWebviewAsset(webviewAssetsDir) {
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Missing webview assets directory ${webviewAssetsDir}`);
  }

  const settingStorageCandidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(/^setting-storage-.*\.js$/, name))
    .sort();
  const allRequestCandidates = fs
    .readdirSync(webviewAssetsDir)
    .filter((name) => regexpTest(/\.js$/, name))
    .sort()
    .filter((name) => !settingStorageCandidates.includes(name));
  const modernCandidates = [...settingStorageCandidates, ...allRequestCandidates];
  const matches = [];
  for (const candidate of modernCandidates) {
    const source = readWebviewAsset(webviewAssetsDir, candidate);
    if (!source.includes("vscode://codex/")) {
      continue;
    }
    const exportName = findCodexRequestExportName(source);
    if (exportName != null) {
      matches.push({ assetName: candidate, exportName });
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `Found multiple Codex request API assets (${matches.map(({ assetName }) => assetName).join(", ")})`,
    );
  }

  if (matches.length === 1) {
    return matches[0];
  }

  throw new Error(`Could not find Codex request API asset in ${webviewAssetsDir}`);
}

function findImportedAsset(webviewAssetsDir, importerAsset, description) {
  const importedAsset = readWebviewAsset(webviewAssetsDir, importerAsset).match(/from"\.\/([^"]+)"/)?.[1];
  if (!importedAsset || !fs.existsSync(path.join(webviewAssetsDir, importedAsset))) {
    throw new Error(`Could not find ${description} imported by ${importerAsset}`);
  }
  return importedAsset;
}

module.exports = {
  findCodexRequestWebviewAsset,
  findIconAsset,
  findImportedAsset,
  MAIN_PROCESS_CHUNK_PATTERN,
  findMainProcessChunks,
  findRequiredWebviewAsset,
  patchAssetFiles,
  patchUniqueAssetFile,
  readDirectoryNames,
  readWebviewAsset,
};
