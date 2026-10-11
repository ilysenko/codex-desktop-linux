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
    `(?<command>${IDENT})===\\x60focusPageBlockControls\\x60\\|\\|` +
      `\\k<command>===\\x60copyPageLink\\x60\\|\\|\\k<command>===\\x60clearAllUnreads\\x60`,
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
      `if\\(\\k<event>\\.target instanceof Element&&\\k<event>\\.target,!\\k<event>\\.defaultPrevented\\)`,
    "app shortcut keydown handler");
  const event = handler.groups.event;
  uniqueMatch(body, `${IDENT}\\(${escapeRegExp(command)},${escapeRegExp(event)}\\)&&` +
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

function validateNativeEditor(assets, names) {
  const readUnique = (pattern, anchor) => {
    const matches = names.filter((name) => pattern.test(name))
      .map((name) => ({ name, source: fs.readFileSync(path.join(assets, name), "utf8") }))
      .filter(({ source }) => source.includes(anchor));
    if (matches.length !== 1) throw new Error(`Expected one ${anchor} asset, found ${matches.length}`);
    return matches[0];
  };
  const editor = readUnique(/^annotation-editor-[A-Za-z0-9_-]+\.js$/u, "selectedTextAnnotationEditor.noteAriaLabel");
  const card = readUnique(/^annotation-comment-editor-card-[A-Za-z0-9_-]+\.js$/u, "onKeyDownCapture:");
  if (!editor.source.includes('"data-selected-text-annotation-editor":!0') ||
      !editor.source.includes("onDirectSubmit:") ||
      !["\"", "`"].some((quote) => editor.source.includes(`from${quote}./${card.name}${quote}`))) {
    throw new Error("Native annotation editor scope or direct-submit linkage drifted");
  }
  const keydown = uniqueMatch(card.source,
    `(?<handler>${IDENT})=(?<event>${IDENT})=>\\{if\\(` +
      `\\k<event>\\.defaultPrevented\\|\\|\\k<event>\\.nativeEvent\\.isComposing\\)return;`,
    "native annotation keydown handler");
  const { escapeRegExp, findMatchingBrace } = helpers();
  const openingBrace = keydown.index + `${keydown.groups.handler}=${keydown.groups.event}=>`.length;
  const closingBrace = findMatchingBrace(card.source, openingBrace);
  const body = card.source.slice(openingBrace, closingBrace + 1);
  const event = escapeRegExp(keydown.groups.event);
  uniqueMatch(body, `${event}\\.key===\\x60Enter\\x60&&!${event}\\.altKey&&!${event}\\.shiftKey&&` +
    `\\(${event}\\.metaKey\\|\\|${event}\\.ctrlKey\\)`, "native annotation Ctrl+Enter path");
  uniqueMatch(card.source, `onKeyDownCapture:${escapeRegExp(keydown.groups.handler)}(?=[,}])`,
    "registered native annotation keydown handler");
}

function applyAnnotationSubmit(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  try {
    const assets = path.join(extractedDir, "webview", "assets");
    const names = fs.readdirSync(assets);
    const candidates = names
      .filter((name) => /^app-initial-[A-Za-z0-9_-]+\.js$/u.test(name))
      .map((name) => ({ name, source: fs.readFileSync(path.join(assets, name), "utf8") }))
      .filter(({ source }) => source.includes("clearAllUnreads") && source.includes("allowWithinEditable:"));
    if (candidates.length !== 1) throw new Error(`Expected one app shortcut asset, found ${candidates.length}`);
    validateNativeEditor(assets, names);
    const asset = candidates[0];
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
  descriptors: [{
    id: "selected-text-annotation-submit",
    phase: "extracted-app:post-webview",
    order: 21_005,
    ciPolicy: "optional",
    enabled,
    apply: applyAnnotationSubmit,
  }],
};
