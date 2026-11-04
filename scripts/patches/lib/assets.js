"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { findMatchingBrace } = require("./minified-js.js");
const { patchBreaksJavaScriptSyntax } = require("./javascript-syntax.js");

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

const JAVASCRIPT_ASSET_PATTERN = /\.(?:c|m)?js$/;

function rejectsSyntaxBreak(assetName, original, patched) {
  if (!JAVASCRIPT_ASSET_PATTERN.test(assetName) || !patchBreaksJavaScriptSyntax(original, patched)) {
    return false;
  }
  console.warn(
    `WARN: Patched webview asset ${assetName} no longer parses as JavaScript — keeping the original asset`,
  );
  return true;
}

// The official webview is an rspack build: entry chunks live in
// webview/assets and lazily loaded chunks in webview/assets/async, all with
// numeric content-hashed names. Asset names below are relative to
// webview/assets (for example "async/24191.7b05d5cf83.js").
const WEBVIEW_SCRIPT_DIRECTORIES = ["", "async"];

function listWebviewAssets(extractedDir) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  const names = [];
  for (const directory of WEBVIEW_SCRIPT_DIRECTORIES) {
    for (const entry of readDirectoryEntries(path.join(webviewAssetsDir, directory))) {
      if (entry.isFile()) {
        names.push(directory === "" ? entry.name : `${directory}/${entry.name}`);
      }
    }
  }
  return names.sort();
}

function listWebviewScriptAssets(extractedDir) {
  return listWebviewAssets(extractedDir).filter((name) => /\.js$/.test(name));
}

function readDirectoryEntries(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true });
}

// Returns the webview script assets whose source contains every needle.
function findWebviewAssetsContaining(extractedDir, needles) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  return listWebviewScriptAssets(extractedDir).filter((assetName) => {
    const source = fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8");
    return needles.every((needle) => source.includes(needle));
  });
}

function assetBaseName(assetName) {
  return assetName.slice(assetName.lastIndexOf("/") + 1);
}

function selectAssetCandidates(extractedDir, filenamePattern, candidates) {
  if (candidates != null) {
    return [...candidates].sort();
  }
  return listWebviewAssets(extractedDir)
    .filter((name) => regexpTest(filenamePattern, assetBaseName(name)));
}

function patchAssetFiles(extractedDir, filenamePattern, patchFn, missingWarnMessage, candidates = null) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    console.warn(
      `WARN: Could not find webview assets directory in ${webviewAssetsDir} — skipping asset patch`,
    );
    return { matched: 0, changed: 0, changedAssets: [] };
  }

  const selected = selectAssetCandidates(extractedDir, filenamePattern, candidates);
  if (selected.length === 0) {
    console.warn(missingWarnMessage);
    return { matched: 0, changed: 0, changedAssets: [] };
  }

  const pendingWrites = [];
  for (const candidate of selected) {
    const filePath = path.join(webviewAssetsDir, candidate);
    const currentSource = fs.readFileSync(filePath, "utf8");
    const patchedSource = patchFn(currentSource);
    if (patchedSource !== currentSource) {
      if (rejectsSyntaxBreak(candidate, currentSource, patchedSource)) {
        return { matched: selected.length, changed: 0, changedAssets: [] };
      }
      pendingWrites.push({ candidate, filePath, patchedSource });
    }
  }
  for (const { filePath, patchedSource } of pendingWrites) {
    fs.writeFileSync(filePath, patchedSource, "utf8");
  }

  return {
    matched: selected.length,
    changed: pendingWrites.length,
    changedAssets: pendingWrites.map(({ candidate }) => candidate),
  };
}

function patchUniqueAssetFile(
  extractedDir,
  filenamePattern,
  assetMatch,
  patchFn,
  missingWarnMessage,
  ambiguousWarnMessage,
  candidates = null,
) {
  const webviewAssetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(webviewAssetsDir)) {
    console.warn(
      `WARN: Could not find webview assets directory in ${webviewAssetsDir} — skipping asset patch`,
    );
    return { matched: 0, changed: 0, assetName: null, changedAssets: [] };
  }

  const matches = selectAssetCandidates(extractedDir, filenamePattern, candidates)
    .map((assetName) => ({
      assetName,
      source: fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8"),
    }))
    .filter(({ assetName, source }) => assetMatch(source, assetName));

  if (matches.length === 0) {
    console.warn(missingWarnMessage);
    return { matched: 0, changed: 0, assetName: null, changedAssets: [] };
  }
  if (matches.length !== 1) {
    console.warn(`${ambiguousWarnMessage}: ${matches.map(({ assetName }) => assetName).join(", ")}`);
    return { matched: matches.length, changed: 0, assetName: null, changedAssets: [] };
  }

  const [{ assetName, source }] = matches;
  const patchedSource = patchFn(source);
  if (patchedSource === source || rejectsSyntaxBreak(assetName, source, patchedSource)) {
    return { matched: 1, changed: 0, assetName, changedAssets: [] };
  }
  fs.writeFileSync(path.join(webviewAssetsDir, assetName), patchedSource, "utf8");
  return { matched: 1, changed: 1, assetName, changedAssets: [assetName] };
}

function readWebviewAsset(webviewAssetsDir, assetName) {
  return fs.readFileSync(path.join(webviewAssetsDir, assetName), "utf8");
}

function findRequiredWebviewAsset(webviewAssetsDir, filenamePattern, marker, description) {
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Missing webview assets directory ${webviewAssetsDir}`);
  }

  const candidates = listWebviewScriptAssets(path.dirname(path.dirname(webviewAssetsDir)))
    .filter((name) => regexpTest(filenamePattern, assetBaseName(name)));
  const matches = marker == null
    ? candidates
    : candidates.filter((name) => readWebviewAsset(webviewAssetsDir, name).includes(marker));

  if (matches.length === 0) {
    throw new Error(`Could not find ${description} in ${webviewAssetsDir}`);
  }

  return matches[0];
}

// The rspack webview wraps `vscode://codex/<method>` requests in a module such as
//   M8aW(e,t,n){n.d(t,{vF:()=>"vscode",Xb:()=>s,IF:()=>a});...
//     async function s(...e){let[t,n]=e,{params:r,select:i,signal:a,source:l,responsePriority:u}=n??{};
//       return o(t,r,i,a,l,u)}
//     async function o(e,t,n,a,s,o){let l=(await i._n.getInstance().post(`vscode://codex/${e}`,...
// There are no ESM exports between app chunks any more: injected code reaches
// the wrapper through the webpack require of a module factory, as
// `require(moduleId)[exportName]`, after loading `chunkId` when needed.
function findCodexRequestExportName(source) {
  const ID = "[A-Za-z_$][\\w$]*";
  const modulesStart = source.indexOf("__webpack_modules__={");
  if (modulesStart < 0) return null;
  const header = new RegExp(`^,?("[^"]+"|${ID}|\\d+)\\(((?:${ID}(?:,${ID}){0,2})?)\\)\\{`, "u");
  const escape = (value) => value.replace(/\$/g, "\\$");
  const matches = [];
  let index = modulesStart + "__webpack_modules__={".length;
  while (index < source.length) {
    const moduleHeader = header.exec(source.slice(index, index + 200));
    if (moduleHeader == null) break;
    const open = index + moduleHeader[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) break;
    index = close + 1;
    const body = source.slice(open, close + 1);
    const [, exportsParam, requireParam] = moduleHeader[2].split(",");
    if (requireParam == null || !body.includes("vscode://codex/${")) continue;
    const raw = [...body.matchAll(new RegExp(
      `async function (${ID})\\(${ID}(?:,${ID})*\\)\\{let ${ID}=\\(await ${ID}(?:\\.${ID})*\\.getInstance\\(\\)\\.post\\(\`vscode://codex/\\$\\{`,
      "gu",
    ))];
    if (raw.length !== 1) continue;
    const wrappers = [...body.matchAll(new RegExp(
      `async function (${ID})\\(\\.\\.\\.(${ID})\\)\\{let\\[(${ID}),(${ID})\\]=\\2,` +
        `\\{params:(${ID}),select:(${ID}),signal:(${ID}),source:(${ID})(?:,responsePriority:(${ID}))?\\}=\\4\\?\\?\\{\\};` +
        `return ${escape(raw[0][1])}\\(\\3,\\5,\\6,\\7,\\8(?:,\\9)?\\)\\}`,
      "gu",
    ))];
    if (wrappers.length !== 1) continue;
    const exportNames = [...body.matchAll(new RegExp(
      `(?<![\\w$.])${escape(requireParam)}\\.d\\(${escape(exportsParam)},\\{(?:[^{}]*?,)?(${ID}):\\(\\)=>${escape(wrappers[0][1])}(?=[,}])`,
      "gu",
    ))];
    if (exportNames.length !== 1) continue;
    const moduleId = moduleHeader[1].startsWith("\"") ? JSON.parse(moduleHeader[1]) : moduleHeader[1];
    matches.push({ moduleId, exportName: exportNames[0][1] });
  }
  return matches.length === 1 ? matches[0] : null;
}

function findCodexRequestWebviewAsset(webviewAssetsDir) {
  if (!fs.existsSync(webviewAssetsDir)) {
    throw new Error(`Missing webview assets directory ${webviewAssetsDir}`);
  }

  const candidates = listWebviewScriptAssets(path.dirname(path.dirname(webviewAssetsDir)));
  const matches = [];
  for (const candidate of candidates) {
    const source = readWebviewAsset(webviewAssetsDir, candidate);
    if (!source.includes("vscode://codex/${")) {
      continue;
    }
    const requestModule = findCodexRequestExportName(source);
    const chunkId = source.match(/(?:^|[;\n])export const __rspack_esm_id=(\d+);/)?.[1];
    if (requestModule != null && chunkId != null) {
      matches.push({ assetName: candidate, chunkId: Number(chunkId), ...requestModule });
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
  findWebviewAssetsContaining,
  listWebviewAssets,
  listWebviewScriptAssets,
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
