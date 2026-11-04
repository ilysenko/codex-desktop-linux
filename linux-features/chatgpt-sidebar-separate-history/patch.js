"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const STORAGE_KEY = "community-chatgpt-sidebar-source-v1";
const MODULES_MARKER = "export const __webpack_modules__={";
const selectorPattern = new RegExp(
  String.raw`"chatgpt"===${IDENT}\?${IDENT}\((?<ns>${IDENT})\.(?<exportName>${IDENT})\):"codex"`,
  "g",
);
const storagePattern = new RegExp(
  String.raw`${IDENT}=\(0,(?<persist>${IDENT}\.${IDENT})\)\("sidebar-organize-mode-v1",void 0\)`,
  "g",
);

// Lists the module factories of one rspack chunk
// (`export const __webpack_modules__={id(e,t,n){…},…}`), or null.
function chunkModules(source) {
  const start = source.indexOf(MODULES_MARKER);
  if (start < 0) return null;
  const header = /([A-Za-z0-9_$]+|"[^"\\]*")\(([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)?\)\{/y;
  const modules = [];
  let index = start + MODULES_MARKER.length;
  while (source[index] !== "}") {
    header.lastIndex = index;
    const match = header.exec(source);
    if (match == null) return null;
    const close = findMatchingBrace(source, index + match[0].length - 1);
    if (close < 0) return null;
    modules.push({
      id: match[1].replace(/^"|"$/g, ""),
      params: match[2]?.split(",") ?? [],
      start: index,
      end: close + 1,
    });
    index = close + 1;
    if (source[index] === ",") index += 1;
  }
  return modules;
}

function moduleAt(modules, index) {
  return modules.find((module) => module.start <= index && index < module.end) ?? null;
}

function replacement(atom, persist) {
  return `${atom}=(0,${persist})("${STORAGE_KEY}","chatgpt",` +
    `{coerceStoredValue:e=>["all","chatgpt","codex"].includes(e)?e:"chatgpt"})`;
}

// The ChatGPT sidebar selector reads an in-memory "all" atom exported by the
// module that declares the persisted sidebar preferences. Prove that the
// selector's module requires exactly that module and reads exactly that export
// before replacing the atom with a persisted preference from the same helper.
function contract(source) {
  const selectors = [...source.matchAll(selectorPattern)];
  const storage = [...source.matchAll(storagePattern)];
  if (selectors.length !== 1 || storage.length !== 1) return null;
  const modules = chunkModules(source);
  if (modules == null) return null;
  const storageModule = moduleAt(modules, storage[0].index);
  const selectorModule = moduleAt(modules, selectors[0].index);
  const requireParam = selectorModule?.params[2];
  if (storageModule == null || requireParam == null) return null;
  const { ns, exportName } = selectors[0].groups;
  const binding = new RegExp(
    String.raw`(?<![\w$.])${escapeRegExp(ns)}=${escapeRegExp(requireParam)}\("${escapeRegExp(storageModule.id)}"\)`,
  );
  if (!binding.test(source.slice(selectorModule.start, selectorModule.end))) return null;

  const body = source.slice(storageModule.start, storageModule.end);
  const exported = [...body.matchAll(new RegExp(
    String.raw`[{,]${escapeRegExp(exportName)}:(?:\(\)=>)?(?<atom>${IDENT})(?=[,}])`, "g",
  ))];
  if (exported.length !== 1) return null;
  const { atom } = exported[0].groups;
  const { persist } = storage[0].groups;
  const initializers = [...body.matchAll(new RegExp(
    String.raw`(?<![\w$.])${escapeRegExp(atom)}=\(0,${IDENT}\.${IDENT}\)\(${IDENT}\.${IDENT},"all"\)`, "g",
  ))];
  const patched = replacement(atom, persist);
  const patchedCount = body.split(patched).length - 1;
  const keyCount = source.split(STORAGE_KEY).length - 1;
  if (initializers.length === 0 && patchedCount === 1 && keyCount === 1) return { patched: true };
  if (initializers.length !== 1 || keyCount !== 0) return null;
  const start = storageModule.start + initializers[0].index;
  return { start, end: start + initializers[0][0].length, replacement: patched };
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
  return source.slice(0, state.start) + state.replacement + source.slice(state.end);
}

const descriptors = [{
  id: "source-preference",
  phase: "webview-asset",
  order: 20_950,
  ciPolicy: "optional",
  assetNeedles: ["sidebar-organize-mode-v1", ':"codex"'],
  assetMatch: matchesSidebarHistoryContract,
  missingDescription: "unique ChatGPT sidebar source preference",
  skipDescription: "separate ChatGPT sidebar history patch",
  apply: applySidebarHistoryPatch,
}];

module.exports = { STORAGE_KEY, applySidebarHistoryPatch, matchesSidebarHistoryContract, descriptors };
