"use strict";

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_MARKER = "codex-linux-selected-text-annotation-submit:runtime";
const HANDLER_MARKER = "codex-linux-selected-text-annotation-submit:handler";
const GUARD_NAME = "codexLinuxResponseAnnotationOwnsSubmitShortcut";
const IDENT = "[A-Za-z_$][\\w$]*";
const COMMAND_ANCHOR = `"focusPageBlockControls"===(?<command>${IDENT})\\|\\|` +
      `"copyPageLink"===\\k<command>\\|\\|"clearAllUnreads"===\\k<command>(?![\\w$])`;

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
  const commandAnchor = uniqueMatch(source, COMMAND_ANCHOR, "app shortcut editable-scope anchor");
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
  const handlerOpening = handler.index + `${handler.groups.handler}=${event}=>`.length;
  const handlerClosing = findMatchingBrace(body, handlerOpening);
  if (handlerClosing < handlerOpening) throw new Error("App shortcut keydown body drifted");
  const handlerBody = body.slice(handlerOpening, handlerClosing + 1);
  uniqueMatch(handlerBody, `\\(0,${IDENT}\\.${IDENT}\\)\\(${escapeRegExp(command)},${escapeRegExp(event)}\\)\\)*&&\\(?` +
    `${escapeRegExp(event)}\\.preventDefault\\(\\)`, "registered app handler command dispatch");
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
function nativeFunction(source, name) {
  const { escapeRegExp, findMatchingBrace } = helpers();
  const header = uniqueMatch(source, `function ${escapeRegExp(name)}\\((?<params>[^)]*)\\)\\{`, "native function declaration");
  const open = header.index + header[0].length - 1;
  const end = findMatchingBrace(source, open);
  if (end < open) throw new Error("Native function boundary drifted");
  return { name, params: header.groups.params, source: source.slice(header.index, end + 1), start: header.index, end };
}

function nativeProps(fn) {
  const { escapeRegExp } = helpers();
  const props = fn.params.startsWith("{") ? fn.params.slice(1,-1) :
    uniqueMatch(fn.source, `\\{(?<props>[^{}]*onDirectSubmit:[^{}]*)\\}=${escapeRegExp(fn.params)}(?=[,;])`, "native callback props").groups.props;
  const callback = key => uniqueMatch(props, `(?:^|,)${key}:(?<callback>${IDENT})(?=,|$)`, "native submit prop").groups.callback;
  return {direct:callback("onDirectSubmit"),saved:callback("onSubmit")};
}

function nativeFunctionOwner(source,index) {
  return [...source.matchAll(new RegExp(`function (?<name>${IDENT})\\([^)]*\\)\\{`, "gu"))]
    .filter(match => match.index < index)
    .map(match => nativeFunction(source,match.groups.name))
    .filter(fn => fn.end > index).at(-1);
}

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
  const editorOwner = nativeFunctionOwner(editor.body,render.index);
  if (editorOwner == null) throw new Error("Native selected-text editor function owner drifted");
  const editorExport = uniqueMatch(editor.body,
    `${escapeRegExp(requireParam)}\\.d\\(${escapeRegExp(editor.params[1])},\\{[^{}]*?SelectedTextAnnotationEditor:\\(\\)=>(?<component>${IDENT})(?=[,}])`, "selected-text editor export");
  if (editorExport.groups.component !== editorOwner.name) throw new Error("Selected-text editor export owner drifted");
  const editorCallbacks = nativeProps(editorOwner);
  const editorPropsOpen = render.index + render[0].lastIndexOf("{");
  const editorPropsEnd = findMatchingBrace(editor.body,editorPropsOpen);
  const editorProps = editor.body.slice(editorPropsOpen,editorPropsEnd+1);
  const directBridge = uniqueMatch(editorProps, `onDirectSubmit:(?<callback>${IDENT})(?=[,}])`, "selected-text editor direct callback").groups.callback;
  uniqueMatch(editorOwner.source,
    `${escapeRegExp(directBridge)}=(?<request>${IDENT})=>\\{let\\{body:(?<body>${IDENT})\\}=\\k<request>;` +
    `(?<busy>${IDENT})\\.current\\|\\|\\(\\k<busy>\\.current=!0,\\(async\\(\\)=>${escapeRegExp(editorCallbacks.direct)}\\(\\k<body>\\)\\)\\(\\)\\.finally\\(\\(\\)=>\\{\\k<busy>\\.current=!1\\}\\)\\)\\}`,
    "selected-text editor direct-submit bridge");
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
  for (const cardMetadata of cards) {
    const [, exportsParam, cardRequire] = cardMetadata.params;
    if (exportsParam == null || cardRequire == null) throw new Error("Native annotation card module signature drifted");
    const card = cardMetadata.body;
    const exported = uniqueMatch(card, `${escapeRegExp(cardRequire)}\\.d\\(${escapeRegExp(exportsParam)},\\{[^{}]*?` +
      `(?<![\\w$])${escapeRegExp(render.groups.exported)}:\\(\\)=>(?<component>${IDENT})(?=[,}])`, "native annotation card export");
    const wrapper = nativeFunction(card, exported.groups.component);
    const keydown = uniqueMatch(card,
      `onKeyDownCapture:(?<event>${IDENT})=>\\{if\\(\\k<event>\\.defaultPrevented\\|\\|\\k<event>\\.nativeEvent\\.isComposing\\)return;`,
      "native annotation keydown handler");
    const inner = nativeFunctionOwner(card,keydown.index);
    if (inner == null) throw new Error("Native annotation handler function owner drifted");
    const callbacks = nativeProps(inner), forwarded = nativeProps(wrapper);
    const renderInner = uniqueMatch(wrapper.source, `\\(0,${IDENT}\\.jsx\\)\\(${escapeRegExp(inner.name)},\\{`, "native card wrapper forwarding");
    const propsOpen = renderInner.index + renderInner[0].length - 1;
    const propsEnd = findMatchingBrace(wrapper.source,propsOpen);
    const forwardedProps = wrapper.source.slice(propsOpen,propsEnd+1);
    for (const [key,value] of [["onDirectSubmit",forwarded.direct],["onSubmit",forwarded.saved]]) {
      uniqueMatch(forwardedProps, `${key}:${escapeRegExp(value)}(?=[,}])`, "native card forwarded callback");
    }
    const openingBrace = keydown.index + `onKeyDownCapture:${keydown.groups.event}=>`.length;
    const closingBrace = findMatchingBrace(card,openingBrace);
    const body = card.slice(openingBrace,closingBrace+1);
    const event = escapeRegExp(keydown.groups.event);
    uniqueMatch(body, `"Enter"===${event}\\.key&&!${event}\\.altKey&&!${event}\\.shiftKey&&\\(${event}\\.metaKey\\|\\|${event}\\.ctrlKey\\)`, "native annotation Ctrl+Enter path");
    uniqueMatch(body, `if\\(${event}\\.preventDefault\\(\\),${event}\\.stopPropagation\\(\\),${event}\\.repeat\\)return;`, "native repeat guard");
    const router = uniqueMatch(body,
      `null!=(?<editing>${IDENT})&&(?<allowed>${IDENT})&&${IDENT}\\?(?<submit>${IDENT})\\("direct","keyboard"\\):` +
      `null==\\k<editing>&&\\k<allowed>\\?\\k<submit>\\(${IDENT},"keyboard"\\):\\k<submit>\\("saved","keyboard"\\)`, "native direct/saved keyboard routing");
    const path = uniqueMatch(body, `(?<path>${IDENT})=${event}\\.nativeEvent\\.composedPath\\(\\)`, "native keyboard composed path").groups.path;
    const editorBinding = uniqueMatch(body, `${escapeRegExp(path)}\\.includes\\((?<editor>${IDENT})\\.view\\.dom\\)`, "native keyboard editor binding").groups.editor;
    const submitFunction = nativeFunction(inner.source,router.groups.submit);
    const parameters = new RegExp(`^(?<mode>${IDENT}),(?<source>${IDENT})="button"$`).exec(submitFunction.params);
    if (parameters == null) throw new Error("Native submission parameters drifted");
    const submit = submitFunction.source;
    const validation = uniqueMatch(submit,
      `(?<result>${IDENT})=\\(0,${IDENT}\\.${IDENT}\\)\\(\\{submitMode:(?<mode>${escapeRegExp(parameters.groups.mode)}),` +
      `submitSource:${escapeRegExp(parameters.groups.source)},commentText:${escapeRegExp(editorBinding)}\\.getText\\(\\),`, "native current-text submission validator");
    uniqueMatch(submit, `case"noop":return;`, "native empty/invalid submission guard");
    uniqueMatch(submit,
      `case"submit":"direct"===${escapeRegExp(validation.groups.mode)}\\?${escapeRegExp(callbacks.direct)}\\(${escapeRegExp(validation.groups.result)}\\.payload\\):` +
      `${escapeRegExp(callbacks.saved)}\\(${escapeRegExp(validation.groups.result)}\\.payload\\)`, "native validated callback routing");
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
    if ((has(SHORTCUT_NEEDLES) && new RegExp(COMMAND_ANCHOR,"u").test(source)) ||
        source.includes(HANDLER_MARKER) || source.includes(RUNTIME_MARKER)) {
      shortcutContract(source);
      owners.push({ name, source });
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
    if (owners.length === 0) throw new Error("Expected at least one app shortcut asset, found 0");
    validateNativeEditor(editors, cards);
    const asset = owners[0];
    const result = patchSource(asset.source);
    const { commitAssetEdits } = require("../../../scripts/patches/lib/asset-edits.js");
    const committed = commitAssetEdits(assets,[{assetName:asset.name,source:asset.source,patchedSource:result}]);
    return { matched: 1, changed: committed.changed, targets: [path.join("webview", "assets", asset.name)] };
  } catch (error) {
    if (error?.code === "PATCH_INTEGRITY_FAILURE") throw error;
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
