"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_MARKER = "codex-linux-selected-text-annotation-submit:runtime";
const HANDLER_MARKER = "codex-linux-selected-text-annotation-submit:handler";
const GUARD_NAME = "codexLinuxResponseAnnotationOwnsSubmitShortcut";
const IDENT = "[A-Za-z_$][\\w$]*";

function enabled(context = {}) {
  const defaults = context.feature?.manifest?.tweaks?.selection?.annotationSubmit;
  const settings = context.feature?.settings?.tweaks?.selection?.annotationSubmit;
  return (settings?.enabled ?? defaults?.enabled) === true;
}

// Leave the event available to the upstream annotation editor. Its own handler
// reads the current text, persists the annotation, and sends it through the
// existing direct-submit path, including its composition and repeat guards.
function codexLinuxResponseAnnotationOwnsSubmitShortcut(command, event) {
  if (!["composer.submit", "composer.submitInBackground", "composer.steer", "composer.queue"].includes(command) ||
      event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  const withinEditor = (node) => node != null && typeof node.closest === "function" &&
    node.closest("[data-selected-text-annotation-editor]") != null;
  return withinEditor(event.target) || (event.composedPath?.() ?? []).some(withinEditor);
}

function runtimeSource() {
  return `\n/*${RUNTIME_MARKER}*/${codexLinuxResponseAnnotationOwnsSubmitShortcut.toString()}\n`;
}

function helpers() {
  // Disabled isolated feature copies do not need the ASAR engine helpers.
  return require("../../../scripts/patches/lib/minified-js.js");
}

function assetHelpers() {
  return require("../../../scripts/patches/lib/assets.js");
}

function uniqueMatch(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern, "gu"))];
  if (matches.length !== 1) throw new Error(`Expected one ${label}, found ${matches.length}`);
  return matches[0];
}

function occurrenceCount(source, text) {
  return source.split(text).length - 1;
}

function shortcutContract(source) {
  const { escapeRegExp, findMatchingBrace } = helpers();
  const commandAnchor = uniqueMatch(source,
    `"focusPageBlockControls"===(?<command>${IDENT})\\|\\|` +
      `"copyPageLink"===\\k<command>\\|\\|"clearAllUnreads"===\\k<command>(?![\\w$])`,
    "app shortcut editable-scope anchor");
  const start = source.lastIndexOf("function ", commandAnchor.index);
  const header = new RegExp(`^function ${IDENT}\\(${IDENT}\\)\\{`, "u").exec(source.slice(start));
  if (start < 0 || header == null) throw new Error("App shortcut function header drifted");
  const openingBrace = start + header[0].length - 1;
  const closingBrace = findMatchingBrace(source, openingBrace);
  if (closingBrace < commandAnchor.index) throw new Error("App shortcut function body drifted");
  const body = source.slice(start, closingBrace + 1);
  const command = commandAnchor.groups.command;
  uniqueMatch(body, `\\{id:${escapeRegExp(command)},accelerator:${IDENT},`, "app shortcut command binding");
  if (!body.includes("allowWithinEditable:") || !body.includes("onKeyDown:")) {
    throw new Error("App shortcut registration drifted");
  }
  const handler = uniqueMatch(body,
    `(?<handler>${IDENT})=(?<event>${IDENT})=>\\{` +
      `(?<guard>/\\*${escapeRegExp(HANDLER_MARKER)}\\*/` +
        `if\\(${GUARD_NAME}\\(${escapeRegExp(command)},\\k<event>\\)\\)return;)?` +
      `if\\(\\k<event>\\.target instanceof Element&&\\k<event>\\.target,\\k<event>\\.defaultPrevented\\)return;`,
    "app shortcut keydown handler");
  const event = handler.groups.event;
  uniqueMatch(body, `\\(0,${IDENT}\\.${IDENT}\\)\\(${escapeRegExp(command)},${escapeRegExp(event)}\\)\\)*&&\\(?` +
    `${escapeRegExp(event)}\\.preventDefault\\(\\)`, "app command dispatch");
  uniqueMatch(body, `onKeyDown:${escapeRegExp(handler.groups.handler)}(?=[,}])`, "registered shortcut handler");
  const injection = `/*${HANDLER_MARKER}*/if(${GUARD_NAME}(${command},${event}))return;`;
  const runtime = runtimeSource();
  const runtimeCount = occurrenceCount(source, RUNTIME_MARKER);
  const handlerCount = occurrenceCount(source, HANDLER_MARKER);
  if (runtimeCount || handlerCount || source.includes(GUARD_NAME)) {
    if (runtimeCount !== 1 || handlerCount !== 1 || !handler.groups.guard ||
        handler.groups.guard !== injection || occurrenceCount(source, runtime) !== 1 ||
        occurrenceCount(source, GUARD_NAME) !== 2) {
      throw new Error("Incomplete or drifted annotation submit patch");
    }
    return { state: "applied" };
  }
  return { state: "current", insertion: start + handler.index +
    `${handler.groups.handler}=${event}=>{`.length, injection, runtime };
}

function patchSource(source) {
  const contract = shortcutContract(source);
  if (contract.state === "applied") return source;
  const result = source.slice(0, contract.insertion) + contract.injection +
    source.slice(contract.insertion) + contract.runtime;
  if (shortcutContract(result).state !== "applied") throw new Error("Annotation submit patch validation failed");
  return result;
}

const SHORTCUT_NEEDLES = ['"clearAllUnreads"', "allowWithinEditable:"];
const EDITOR_SCOPE = '"data-selected-text-annotation-editor":!0';
const EDITOR_NEEDLES = [EDITOR_SCOPE, "selectedTextAnnotationEditor.noteAriaLabel", "onDirectSubmit:"];
const CARD_NEEDLES = ["onKeyDownCapture:", ".nativeEvent.isComposing)return;"];
const MODULE_TABLE = "export const __webpack_modules__={";

// Splits an rspack chunk into its module factories. Each entry is
// `<id>(<module>,<exports>,<require>){...}` in the chunk's module table.
function webpackModules(source) {
  const { findMatchingBrace } = helpers();
  const table = source.indexOf(MODULE_TABLE);
  if (table < 0 || table !== source.lastIndexOf(MODULE_TABLE)) return null;
  const header = new RegExp(`(?:"((?:[^"\\\\]|\\\\.)+)"|([\\w$]+))\\((${IDENT}(?:,${IDENT})*)?\\)\\{`, "uy");
  const modules = [];
  let index = table + MODULE_TABLE.length;
  while (source[index] !== "}") {
    header.lastIndex = index;
    const match = header.exec(source);
    if (match == null) return null;
    const open = index + match[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) return null;
    modules.push({ id: match[1] ?? match[2], params: (match[3] ?? "").split(","), body: source.slice(index, close + 1) });
    index = close + 1;
    if (source[index] === ",") index += 1;
    else if (source[index] !== "}") return null;
  }
  return modules;
}

function modulesContaining(chunks, needles, label) {
  const found = [];
  for (const chunk of chunks) {
    const modules = webpackModules(chunk.source);
    if (modules == null) throw new Error(`Could not read the ${label} chunk module table`);
    found.push(...modules.filter((module) => needles.every((needle) => module.body.includes(needle))));
  }
  return found;
}

// rspack modules reach each other only through their factory's require
// parameter, so the editor -> card linkage is checked semantically: the
// editor renders `<binding>.<export>` with onDirectSubmit, the binding is
// required from the card module, and that card module exports the component
// whose capture handler owns the native Ctrl+Enter direct-submit path.
function validateNativeEditor(editorChunks, cardChunks) {
  const { escapeRegExp, findMatchingBrace } = helpers();
  const editors = modulesContaining(editorChunks, EDITOR_NEEDLES, "annotation editor");
  if (editors.length !== 1) throw new Error(`Expected one native annotation editor module, found ${editors.length}`);
  const editor = editors[0];
  const requireParam = editor.params[2];
  if (requireParam == null) throw new Error("Native annotation editor module has no require parameter");
  const render = uniqueMatch(editor.body,
    `\\(0,${IDENT}\\.jsxs?\\)\\((?<binding>${IDENT})\\.(?<exported>[\\w$]+),\\{[^{}]*?onDirectSubmit:`,
    "native annotation card render");
  const linkage = uniqueMatch(editor.body,
    `(?<![\\w$.])${escapeRegExp(render.groups.binding)}=${escapeRegExp(requireParam)}\\("(?<id>[^"\\\\]+)"\\)`,
    "native annotation card require");
  const cardId = linkage.groups.id;
  const cards = cardChunks.flatMap(({ source }) => {
    const modules = webpackModules(source);
    if (modules == null) throw new Error("Could not read the annotation card chunk module table");
    return modules.filter((module) => module.id === cardId);
  });
  if (cards.length === 0) throw new Error("Native annotation card module is missing");
  for (const card of cards) {
    const [, exportsParam, cardRequire] = card.params;
    if (exportsParam == null || cardRequire == null) throw new Error("Native annotation card module signature drifted");
    uniqueMatch(card.body, `${escapeRegExp(cardRequire)}\\.d\\(${escapeRegExp(exportsParam)},\\{[^{}]*?` +
      `(?<![\\w$])${escapeRegExp(render.groups.exported)}:\\(\\)=>`, "native annotation card export");
    const keydown = uniqueMatch(card.body,
      `onKeyDownCapture:(?<event>${IDENT})=>\\{if\\(` +
        `\\k<event>\\.defaultPrevented\\|\\|\\k<event>\\.nativeEvent\\.isComposing\\)return;`,
      "native annotation keydown handler");
    const openingBrace = keydown.index + `onKeyDownCapture:${keydown.groups.event}=>`.length;
    const closingBrace = findMatchingBrace(card.body, openingBrace);
    if (closingBrace < 0) throw new Error("Native annotation keydown handler body drifted");
    const body = card.body.slice(openingBrace, closingBrace + 1);
    const event = escapeRegExp(keydown.groups.event);
    uniqueMatch(body, `"Enter"===${event}\\.key&&!${event}\\.altKey&&!${event}\\.shiftKey&&` +
      `\\(${event}\\.metaKey\\|\\|${event}\\.ctrlKey\\)`, "native annotation Ctrl+Enter path");
    if (!body.includes('"direct"')) throw new Error("Native annotation direct-submit path drifted");
  }
}

// Reads every webview script asset once (entry and async rspack chunks) and
// keeps only the chunks that can hold the shortcut owner, the annotation
// editor, or the annotation card.
function discoverAnnotationSubmitAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const owners = [];
  const editors = [];
  const cards = [];
  for (const name of assetHelpers().listWebviewScriptAssets(extractedDir)) {
    const source = fs.readFileSync(path.join(assets, name), "utf8");
    const has = (needles) => needles.every((needle) => source.includes(needle));
    if (has(SHORTCUT_NEEDLES)) {
      try {
        shortcutContract(source);
        owners.push({ name, source });
      } catch {
        // Other command tables mention the same strings without owning the handler.
      }
    }
    if (has(EDITOR_NEEDLES)) editors.push({ name, source });
    if (has(CARD_NEEDLES)) cards.push({ name, source });
  }
  return { assets, owners, editors, cards };
}

function applyAnnotationSubmit(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  try {
    const { assets, owners, editors, cards } = discoverAnnotationSubmitAssets(extractedDir);
    if (owners.length !== 1) throw new Error(`Expected one app shortcut asset, found ${owners.length}`);
    validateNativeEditor(editors, cards);
    const asset = owners[0];
    const result = patchSource(asset.source);
    const changed = result !== asset.source;
    if (changed) fs.writeFileSync(path.join(assets, asset.name), result);
    return { matched: 1, changed: Number(changed), targets: [path.join("webview", "assets", asset.name)] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: Could not restore selected-text annotation submit: ${reason} - skipping ui-tweaks patch`);
    return { matched: 0, changed: 0, reason };
  }
}

module.exports = {
  RUNTIME_MARKER, HANDLER_MARKER, GUARD_NAME, enabled, runtimeSource,
  codexLinuxResponseAnnotationOwnsSubmitShortcut, shortcutContract, patchSource, applyAnnotationSubmit,
  discoverAnnotationSubmitAssets, validateNativeEditor, webpackModules,
  descriptors: [{
    id: "selected-text-annotation-submit",
    phase: "extracted-app:post-webview",
    order: 21_005,
    ciPolicy: "optional",
    enabled,
    apply: applyAnnotationSubmit,
  }],
};
