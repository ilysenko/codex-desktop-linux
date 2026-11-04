"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { escapeRegExp, findMatchingBrace } = require("./minified-js.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("./assets.js");

const ID = "[A-Za-z_$][\\w$]*";
const KEY = `(?:"(?:\\\\.|[^"\\\\])*"|${ID}|\\d+)`;
const FACTORY = new RegExp(`(?<key>${KEY})\\s*\\(\\s*(?:${ID}(?:\\s*,\\s*${ID}){0,2})?\\s*\\)\\s*\\{`, "y");

function skipWhitespace(source, index) {
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return index;
}

// Current renderer chunks export an object of method-style module factories.
// Walk its direct members, skipping complete function bodies rather than
// mistaking nested methods or strings for another module definition. Snapshot
// start/end delimit the body contents, excluding its opening/closing braces.
function* rspackModuleFactories(source, assetName) {
  const headers = [...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/g)];
  if (headers.length === 0) return;
  if (headers.length !== 1) throw new Error(`Ambiguous Rspack module registry in ${assetName}`);
  let cursor = headers[0].index + headers[0][0].length;
  const seen = new Set();
  while (true) {
    cursor = skipWhitespace(source, cursor);
    if (source[cursor] === "}") return;
    FACTORY.lastIndex = cursor;
    const header = FACTORY.exec(source);
    if (header == null) throw new Error(`Unsupported Rspack module factory in ${assetName} at ${cursor}`);
    const key = header.groups.key;
    const moduleId = key.startsWith('"') ? JSON.parse(key) : key;
    if (seen.has(moduleId)) throw new Error(`Duplicate Rspack module ${moduleId} in ${assetName}`);
    seen.add(moduleId);
    const start = FACTORY.lastIndex;
    const end = findMatchingBrace(source, start - 1);
    if (end < start) throw new Error(`Unterminated Rspack module ${moduleId} in ${assetName}`);
    yield { assetName, source, moduleId, moduleSource: source.slice(start, end), start, end };
    cursor = skipWhitespace(source, end + 1);
    if (source[cursor] === "}") return;
    if (source[cursor] !== ",") throw new Error(`Invalid Rspack module separator in ${assetName} at ${cursor}`);
    cursor += 1;
  }
}

function* moduleAssets(assetsDir, { pattern, sourceMatch }) {
  for (const assetName of listWebviewAssetFiles(assetsDir, pattern)) {
    const source = fs.readFileSync(path.join(assetsDir, assetName), "utf8");
    if (sourceMatch != null && !sourceMatch(source, assetName)) continue;
    yield* rspackModuleFactories(source, assetName);
  }
}

function containsFactoryId(source, moduleId) {
  for (const header of source.matchAll(new RegExp(FACTORY.source, "g"))) {
    const key = header.groups.key;
    if ((key.startsWith('"') ? JSON.parse(key) : key) === moduleId) return true;
  }
  return false;
}

// Discovery may use a cheap sourceMatch prefilter. After finding one semantic
// module identity, search every asset for that identity without the semantic
// prefilter, so a damaged or partially patched replica cannot be omitted.
function findUniqueRspackModuleCopies(assetsDir, {
  matchModule,
  description = "semantic Rspack owner",
  pattern = /\.js$/,
  sourceMatch,
}) {
  const identities = new Set();
  for (const snapshot of moduleAssets(assetsDir, { pattern, sourceMatch })) {
    if (!matchModule(snapshot.moduleSource, snapshot)) continue;
    identities.add(snapshot.moduleId);
    if (identities.size > 1) throw new Error(`Found multiple ${description} module identities: ${[...identities].join(", ")}`);
  }
  if (identities.size === 0) throw new Error(`Could not find ${description} in ${assetsDir}`);
  const [moduleId] = identities;
  const copies = [];
  const literalFactory = new RegExp(`(?:${escapeRegExp(moduleId)}|${escapeRegExp(JSON.stringify(moduleId))})\\s*\\(`);
  for (const snapshot of moduleAssets(assetsDir, {
    pattern,
    sourceMatch: source => literalFactory.test(source) ||
      ((source.includes("\\u") || moduleId.includes("/") && source.includes("\\/")) && containsFactoryId(source, moduleId)),
  })) {
    if (snapshot.moduleId === moduleId) copies.push(snapshot);
  }
  if (copies.length === 0) throw new Error(`Could not find ${description} copies in ${assetsDir}`);
  return copies;
}

// patchModule must reject an invalid contract and return unchanged text for a
// complete applied state. Prepare and validate all copies before any write;
// mixtures of pristine and applied replicas are rejected rather than repaired.
function patchRspackModuleCopies(assetsDir, copies, patchModule, options = {}) {
  if (copies.length === 0 || new Set(copies.map(copy => copy.moduleId)).size !== 1) {
    throw new Error("Expected copies of one semantic Rspack module identity");
  }
  const assets = new Set();
  const edits = copies.map(copy => {
    const { assetName, source, moduleSource, start, end } = copy;
    if (assets.has(assetName) || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end < start || end > source.length || source.slice(start, end) !== moduleSource) {
      throw new Error(`Invalid or duplicate Rspack module snapshot: ${assetName}`);
    }
    assets.add(assetName);
    const patchedModule = patchModule(moduleSource, copy);
    if (typeof patchedModule !== "string" || patchModule(patchedModule, copy) !== patchedModule) {
      throw new Error(`Rspack module patch is incomplete or not idempotent: ${assetName}`);
    }
    return { assetName, source, patchedSource: source.slice(0, start) + patchedModule + source.slice(end) };
  });
  const changed = edits.map(edit => edit.source !== edit.patchedSource);
  if (changed.some(Boolean) && !changed.every(Boolean)) throw new Error("Partially applied Rspack module copies");
  return {
    ...patchWebviewAssets(assetsDir, edits, options),
    matched: copies.length,
    moduleId: copies[0].moduleId,
    assetNames: [...assets],
  };
}

module.exports = { findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories };
