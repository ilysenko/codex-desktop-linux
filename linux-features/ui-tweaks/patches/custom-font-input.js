"use strict";

const RUNTIME_MARKER = "codex-linux-custom-font-input";
const CUSTOM_VALUE_MESSAGE_ID = "settings.general.appearance.chromeTheme.customFontValue";
const MODE_MESSAGE_ID = "codexLinux.uiTweaks.appearance.customFontInput";
const MANUAL_STATE = "codexLinuxManualFontInput";
const MANUAL_SETTER = "setCodexLinuxManualFontInput";
// The current compiled picker uses slots 0-41. The new state needs its own
// dependency slot so toggling a mode invalidates the cached menu children.
const UPSTREAM_CACHE_SIZE = 42;
const IDENT = "[A-Za-z_$][\\w$]*";
const MEMBER = `${IDENT}(?:\\.${IDENT})*`;
const ASSET_NEEDLES = Object.freeze([CUSTOM_VALUE_MESSAGE_ID, "selectedThemeFontFace:"]);

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueMatch(source, pattern) {
  const matches = [...source.matchAll(pattern)];
  return matches.length === 1 ? matches[0] : null;
}

function customFontInputEnabled(context = {}) {
  const defaults = context.feature?.manifest?.tweaks?.appearance?.customFontInput;
  const settings = context.feature?.settings?.tweaks?.appearance?.customFontInput;
  return (settings?.enabled ?? defaults?.enabled) === true;
}

function findMatchingBrace(source, openIndex) {
  // Disabled isolated feature copies do not need the ASAR engine helpers.
  return require("../../../scripts/patches/lib/minified-js.js").findMatchingBrace(source, openIndex);
}

// The picker is the component whose props destructure selectedThemeFontFace and
// whose manual-entry menu item carries the custom-font-value message. SWC
// inlines helper functions into it, so its range is the whole function body.
function pickerRange(source) {
  const anchor = source.indexOf(CUSTOM_VALUE_MESSAGE_ID);
  const props = source.lastIndexOf("selectedThemeFontFace:", anchor);
  if (props < 0) return null;
  const start = source.lastIndexOf("function ", props);
  if (start < 0) return null;
  const header = new RegExp(`^function ${IDENT}\\(${IDENT}\\)\\{`).exec(source.slice(start, props));
  if (header == null) return null;
  const close = findMatchingBrace(source, start + header[0].length - 1);
  if (close < anchor) return null;
  return { start, end: close + 1 };
}

function fontPickerContract(source) {
  if (typeof source !== "string" || !source.includes(CUSTOM_VALUE_MESSAGE_ID)) return null;
  if (source.split(CUSTOM_VALUE_MESSAGE_ID).length !== 2) return null;
  const markerCount = source.split(RUNTIME_MARKER).length - 1;
  if (markerCount > 1) return null;
  const range = pickerRange(source);
  if (range == null) return null;
  const { start, end } = range;
  const body = source.slice(start, end);
  if (!body.includes("selectedThemeFontFace:") || !body.includes("monospaceOnly:")) return null;
  if (markerCount === 1 && !body.includes(RUNTIME_MARKER)) return null;

  const cache = uniqueMatch(body, new RegExp(
    `(?<cache>${IDENT})=\\(0,${IDENT}\\.c\\)\\((?<size>\\d+)\\)`, "g",
  ));
  const hooks = uniqueMatch(body, new RegExp(
    `\\[${IDENT},${IDENT}\\]=\\(0,(?<react>${IDENT})\\.useState\\)\\(${IDENT}\\?\\?""\\),` +
    `\\[${IDENT},${IDENT}\\]=\\(0,\\k<react>\\.useState\\)\\(!1\\),` +
    `\\[${IDENT},${IDENT}\\]=\\(0,\\k<react>\\.useState\\)\\(!1\\)`, "g",
  ));
  const gate = uniqueMatch(body, new RegExp(
    `let ${IDENT}=${IDENT},(?<options>${IDENT})=null;` +
    `if\\((?<unavailable>${IDENT})(?<manual>\\|\\|${MANUAL_STATE})?\\)\\{`, "g",
  ));
  const label = uniqueMatch(body, new RegExp(
    `\\(0,(?<jsx>${IDENT})\\.jsx\\)\\((?<message>${MEMBER}),` +
    `\\{id:"${escaped(CUSTOM_VALUE_MESSAGE_ID)}",defaultMessage:"[^"]*",` +
    `description:"[^"]*"\\}\\)`, "g",
  ));
  if (!cache || !hooks || !gate || !label) return null;
  const { cache: memo, size } = cache.groups;
  const { options, unavailable } = gate.groups;
  const { jsx, message } = label.groups;
  const list = uniqueMatch(body, new RegExp(
    `${escaped(options)}=${IDENT}\\}else ${IDENT}&&\\(` +
    `${escaped(options)}=(?<families>${IDENT})\\?\\.filter\\(`, "g",
  ));
  const separator = uniqueMatch(body, new RegExp(
    `\\(0,${escaped(jsx)}\\.jsx\\)\\((?<menu>${MEMBER})\\.Separator,\\{\\}\\),` +
    `${escaped(options)}\\]`, "g",
  ));
  const dependency = uniqueMatch(body, new RegExp(`if\\(${escaped(memo)}\\[1\\]!==`, "g"));
  const commit = uniqueMatch(body, new RegExp(
    `${escaped(memo)}\\[15\\]=${IDENT}` +
    `(?:,${escaped(memo)}\\[${UPSTREAM_CACHE_SIZE}\\]=${MANUAL_STATE})?\\}else`, "g",
  ));
  if (!list || !separator || !commit) return null;
  const families = list.groups.families;
  if (!body.includes(`${unavailable}=null==${families}||0===${families}.length`)) {
    return null;
  }

  const stateHook = `,[${MANUAL_STATE},${MANUAL_SETTER}]=(0,${hooks.groups.react}.useState)(!1)/*${RUNTIME_MARKER}*/`;
  const modeControl =
    `(0,${jsx}.jsx)(${separator.groups.menu}.CheckboxItem,{` +
    `checked:${unavailable}||${MANUAL_STATE},disabled:${unavailable},indicator:"switch",closeOnSelect:!1,` +
    `onSelect:()=>{${unavailable}||${MANUAL_SETTER}(!${MANUAL_STATE})},` +
    `children:(0,${jsx}.jsx)(${message},{id:"${MODE_MESSAGE_ID}",` +
    `defaultMessage:"Enter font stack manually",` +
    `description:"Switch between installed fonts and a manually entered CSS font family or fallback list"})}),`;
  const modeDependency = `if(${memo}[${UPSTREAM_CACHE_SIZE}]!==${MANUAL_STATE}||${memo}[1]!==`;
  const modeCommit = `${memo}[${UPSTREAM_CACHE_SIZE}]=${MANUAL_STATE}`;

  if (markerCount === 1) {
    if (Number(size) !== UPSTREAM_CACHE_SIZE + 1 || !gate.groups.manual ||
        !body.includes(stateHook) || !body.includes(modeControl) ||
        !body.includes(modeDependency) || !body.includes(`,${modeCommit}}else`)) return null;
    return { state: "applied" };
  }
  if (Number(size) !== UPSTREAM_CACHE_SIZE || !dependency || gate.groups.manual ||
      body.includes(MANUAL_STATE) || body.includes(MANUAL_SETTER) ||
      !body.includes(`${memo}[41]`)) return null;
  return {
    state: "current", start, end, body, cache, hooks, gate, separator, commit,
    stateHook, modeControl, modeDependency, modeCommit,
  };
}

function applyCustomFontInputPatch(source, context = {}) {
  if (!customFontInputEnabled(context)) return source;
  const contract = fontPickerContract(source);
  if (contract?.state === "applied") return source;
  if (contract?.state !== "current") {
    console.warn("WARN: Could not find the unique current font picker contract - skipping custom font input patch");
    return source;
  }
  const { body, cache, hooks, gate, separator, commit } = contract;
  let patched = body.replace(cache[0], cache[0].replace(`(${UPSTREAM_CACHE_SIZE})`, `(${UPSTREAM_CACHE_SIZE + 1})`));
  patched = patched.replace(hooks[0], hooks[0] + contract.stateHook);
  patched = patched.replace(`if(${cache.groups.cache}[1]!==`, contract.modeDependency);
  patched = patched.replace(commit[0], commit[0].replace("}else", `,${contract.modeCommit}}else`));
  patched = patched.replace(gate[0], gate[0].replace(`if(${gate.groups.unavailable})`, `if(${gate.groups.unavailable}||${MANUAL_STATE})`));
  patched = patched.replace(separator[0], contract.modeControl + separator[0]);
  const result = source.slice(0, contract.start) + patched + source.slice(contract.end);
  if (fontPickerContract(result)?.state !== "applied") {
    console.warn("WARN: Could not validate the complete custom font input patch - leaving font picker unchanged");
    return source;
  }
  return result;
}

module.exports = {
  CUSTOM_VALUE_MESSAGE_ID,
  MODE_MESSAGE_ID,
  RUNTIME_MARKER,
  applyCustomFontInputPatch,
  ASSET_NEEDLES,
  customFontInputEnabled,
  fontPickerContract,
  descriptors: [{
    id: "appearance-custom-font-input",
    phase: "webview-asset",
    order: 20_960,
    ciPolicy: "optional",
    assetNeedles: ASSET_NEEDLES,
    assetMatch: (source) => ASSET_NEEDLES.every((needle) => source.includes(needle)),
    missingDescription: "official font picker bundle",
    skipDescription: "custom font input mode switch",
    enabled: customFontInputEnabled,
    apply: applyCustomFontInputPatch,
  }],
};
