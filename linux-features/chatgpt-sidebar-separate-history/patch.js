"use strict";

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const STORAGE_KEY = "community-chatgpt-sidebar-source-v1";
const selectorPattern = new RegExp(
  `${IDENT}===\x60chatgpt\x60\\?${IDENT}\\((?<atom>${IDENT})\\):\x60codex\x60`,
  "g",
);
const storagePattern = new RegExp(
  `${IDENT}=(?<persist>${IDENT})\\(\x60sidebar-organize-mode-v1\x60,void 0\\)`,
  "g",
);

function replacement(atom, persist) {
  return `${atom}=${persist}(\`${STORAGE_KEY}\`,\`chatgpt\`,{coerceStoredValue:value=>[\`all\`,\`chatgpt\`,\`codex\`].includes(value)?value:\`chatgpt\`})`;
}

function contract(source) {
  const selectors = [...source.matchAll(selectorPattern)];
  const storage = [...source.matchAll(storagePattern)];
  if (selectors.length !== 1 || storage.length !== 1) return null;
  const { atom } = selectors[0].groups;
  const { persist } = storage[0].groups;
  // Escaping also supports aliases containing '$'. Neither alias is a filename.
  const escaped = atom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const initializers = [...source.matchAll(new RegExp(
    `(?<![\\w$])${escaped}=${IDENT}\\(${IDENT},\x60all\x60\\)`, "g",
  ))];
  const patched = replacement(atom, persist);
  const patchedCount = source.split(patched).length - 1;
  const keyCount = source.split(STORAGE_KEY).length - 1;
  if (initializers.length === 0 && patchedCount === 1 && keyCount === 1) return { patched: true };
  if (initializers.length !== 1 || keyCount !== 0) return null;
  return { match: initializers[0], replacement: patched };
}

function matchesSidebarHistoryContract(source) {
  return contract(source) != null;
}

function applySidebarHistoryPatch(source) {
  const state = contract(source);
  if (state?.patched) return source;
  if (state == null) {
    console.warn("WARN: Could not prove one unique ChatGPT sidebar source preference - skipping separate history patch");
    return source;
  }
  const { match } = state;
  return source.slice(0, match.index) + state.replacement + source.slice(match.index + match[0].length);
}

const descriptors = [{
  id: "source-preference",
  phase: "webview-asset",
  order: 20_950,
  ciPolicy: "optional",
  pattern: /^[A-Za-z0-9_-]+\.js$/,
  assetMatch: matchesSidebarHistoryContract,
  missingDescription: "unique ChatGPT sidebar source preference",
  skipDescription: "separate ChatGPT sidebar history patch",
  apply: applySidebarHistoryPatch,
}];

module.exports = { STORAGE_KEY, applySidebarHistoryPatch, matchesSidebarHistoryContract, descriptors };
