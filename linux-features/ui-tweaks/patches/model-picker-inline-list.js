"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { findRspackExportPublication } = require("../../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding, findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { assertUnambiguousModelComposerLexicalSource } = require("../../../scripts/patches/lib/model-composer-lexical-guard.js");
const { createJavaScriptLexicalIndex, escapeRegExp: q } = require("../../../scripts/patches/lib/minified-js.js");

// These are physical variants from the same current signed package. The
// semantic role and publication are checked before accepting its native ABI.
const NATIVE = {
  dig0: { kind: "work-options", exportKey: "i", hashes: [
    "ea5417f8311ebd19f1002135cd0e9db129540c726420885f54456a886afe56b6",
    "b532ba1c881e108aa2eaf61cc4b1cdef570e6b460a0b798c0732521b743647be",
  ], needles: ["modelOptionsDisabled:", "supportedReasoningEfforts", "onBeforeSelectModel:"] },
  erx1: { kind: "menu-bridge", exportKey: "Y", hashes: [
    "c500e22faf9f3a09b012ef2fb33b8f0ae9c16546bb252cfaac88de44016bddda",
  ], needles: ["modelListConfig:", "keepSimpleView:", "onToggleMenuView:"] },
  sByQ: { kind: "inline-rows", exportKey: "e", hashes: [
    "91f23e1bfb249a9574ea44601d11149d00a55fd4211db7e0100499efcbd0672b",
  ], needles: ['"older"===', "defaultOption?.index", 'role:"menuitemradio"', '"data-model-picker-view":', "onKeyDownCapture:"] },
};

const ID = "[A-Za-z_$][\\w$]*";

function one(values, description) {
  if (values.length !== 1) throw new Error(`Current inline model list: ${description}`);
  return values[0];
}

function matches(source, expression) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(expression)].filter(match => lexical.isCode(match.index));
}

function inlineRendererFacts(copy, publication) {
  if (!publication.expression || !new RegExp(`^${ID}$`, "u").test(publication.expression)) {
    throw new Error("Current inline model list: missing returned renderer function");
  }
  const module = copy.moduleSource, moduleLexical = createJavaScriptLexicalIndex(module);
  const head = one(matches(module, new RegExp(`function ${q(publication.expression)}\\((${ID})\\)\\{`, "gu"))
    .filter(match => moduleLexical.isRoot(match.index)), "ambiguous renderer function");
  const open = head.index + head[0].length - 1;
  const body = module.slice(open + 1, moduleLexical.matchingBrace(open));
  const lexical = createJavaScriptLexicalIndex(body);
  const input = one(matches(body, /\{active:/gu).filter(match =>
    lexical.isRoot(match.index) && body.startsWith(`=${head[1]}`, lexical.matchingBrace(match.index) + 1)),
  "missing native renderer inputs");
  const inputEnd = lexical.matchingBrace(input.index);
  if (!body.startsWith(`=${head[1]}`, inputEnd + 1)) throw new Error("Current inline model list: disconnected native renderer inputs");
  const header = body.slice(input.index + 1, inputEnd);
  const config = one(matches(header, new RegExp(`modelListConfig:(${ID}),`, "gu")), "missing model-list input")[1];
  const view = one(matches(header, new RegExp(`menuView:(${ID}),`, "gu")), "missing native view input")[1];
  const confirm = one(matches(header, new RegExp(`onConfirmCurrentSelection:(${ID}),`, "gu")), "missing native confirmation input")[1];
  const toggle = one(matches(header, new RegExp(`onToggleMenuView:(${ID}),`, "gu")), "missing native view-toggle input")[1];
  const row = one(matches(body, new RegExp(
    `for\\(let (?<option>${ID}) of\\((?<ordinary>${ID})=\\[\\],(?<older>${ID})=\\[\\],${q(config)}\\.options\\)\\)` +
    `\\("older"===\\k<option>\\.group\\?\\k<older>:\\k<ordinary>\\)\\.push\\(\\(0,(?<jsx>${ID})\\.jsx\\)\\((?<menu>${ID})\\.ms\\.Item,\\{`, "gu")),
  "models do not reach the native grouped option renderer");
  const { option, jsx, ordinary, older } = row.groups;
  const rowOpen = row.index + row[0].length - 1;
  const props = body.slice(rowOpen + 1, lexical.matchingBrace(rowOpen));
  for (const property of [
    `"aria-checked":${option}.selected`, `disabled:${option}.disabled`,
    `focusableWhenDisabled:${option}.focusableWhenDisabled||"auto"===${option}.id`,
    `role:"menuitemradio"`, `SubText:${option}.subText`, `tooltipText:${option}.tooltipText`,
    `tooltipOnBeforeOpen:${option}.tooltipOnBeforeOpen`, `children:${option}.label`,
  ]) {
    if (!props.includes(property)) throw new Error("Current inline model list: changed native row presentation");
  }
  const select = new RegExp(`onSelect:(${ID})=>\\{\\1\\.preventDefault\\(\\),!${q(option)}\\.selected\\|\\|${q(option)}\\.isLocked\\?${q(option)}\\.onSelect\\(\\):${q(confirm)}\\?\\.\\(\\),${q(toggle)}\\("simple"\\)\\}`, "u");
  if (!select.test(props)) throw new Error("Current inline model list: changed native selection callback");
  const rowEnd = lexical.matchingBrace(rowOpen);
  const prefix = new RegExp(`^,${q(option)}\\.id\\)\\);(?<prefix>${ID})=${q(ordinary)}\\.splice\\(0,${q(config)}\\.defaultOption\\?\\.index\\?\\?0\\)`, "u")
    .exec(body.slice(rowEnd + 1));
  if (!prefix) throw new Error("Current inline model list: changed native default-index partition");
  const prefixAlias = one(matches(body, new RegExp(`let (${ID})=${q(prefix.groups.prefix)};`, "gu")),
    "default-index rows do not reach their native binding")[1];
  const olderMenu = one(matches(body, new RegExp(`(${ID})=${q(older)}\\.length>0&&\\(0,${q(jsx)}\\.jsx\\)\\(${ID},\\{[^{}]{0,250}label:\\(0,${q(jsx)}\\.jsx\\)\\(${ID}\\.A,\\{[^{}]{0,400}\\}\\),children:${q(older)}\\}\\)`, "gu")),
    "older rows do not reach their native submenu")[1];
  const list = one(matches(body, new RegExp(`(${ID})=\\(0,${q(jsx)}\\.jsxs\\)\\("div",\\{className:(${ID})\\.A\\.ModelList,children:\\[${ID},${q(config)}\\.beforeModels,(?:${ID},)*${q(prefixAlias)},${ID},${q(ordinary)},${q(olderMenu)},${q(config)}\\.extras\\]\\}\\)`, "gu")),
    "inline rows do not reach the native ModelList");
  const advanced = one(matches(body, new RegExp(`(${ID})="advanced"===${q(view)}`, "gu")), "missing native advanced-view gate")[1];
  const panel = one(matches(body, new RegExp(`(${ID})=\\(0,${q(jsx)}\\.jsx\\)\\("div",\\{className:${q(list[2])}\\.A\\.ViewPanel,ref:${ID},children:\\(0,${q(jsx)}\\.jsx\\)\\("div",\\{className:${q(list[2])}\\.A\\.ModelListMotion,"data-active":${q(advanced)},children:${q(list[1])}\\}\\)\\}\\)`, "gu")),
    "model list is outside the native advanced panel");
  const track = one(matches(body, new RegExp(`(${ID})=\\(0,${q(jsx)}\\.jsx\\)\\("div",\\{"aria-hidden":${ID},className:${q(list[2])}\\.A\\.ViewTrack,"data-active":${q(advanced)},inert:${ID},children:${q(panel[1])}\\}\\)`, "gu")),
    "missing native advanced track");
  const returned = one(matches(body, new RegExp(`(${ID})=\\(0,${q(jsx)}\\.jsxs\\)\\("div",\\{role:"group",className:${q(list[2])}\\.A\\.Menu,[^{}]{1,300}onKeyDownCapture:(${ID}),onKeyDown:(${ID}),onPointerDownCapture:${ID},style:${ID},children:\\[${ID},${q(track[1])}\\]\\}\\)`, "gu")),
    "advanced track does not reach the returned native menu");
  const exits = matches(body, /\b(?:return|throw)\b/gu).filter(match => lexical.isRoot(match.index));
  if (exits.length !== 1 || exits[0][0] !== "return" || !body.endsWith("," + returned[1])) {
    throw new Error("Current inline model list: changed native renderer return");
  }
  const delegated = one(matches(body, new RegExp(
    `${q(returned[2])}=(${ID})=>\\{"Tab"!==\\1\\.key&&(${ID})\\(\\1\\)\\},${q(returned[3])}=(${ID})=>\\{"Tab"===\\3\\.key&&\\2\\(\\3\\)\\}`, "gu")),
  "changed native keyboard delegation");
  const keyboardName = one(matches(body, new RegExp(`let ${q(delegated[2])}=(${ID});`, "gu")),
    "missing shared native keyboard binding")[1];
  const keyboard = one(matches(body, new RegExp(`${q(keyboardName)}=function\\((${ID})\\)\\{`, "gu")), "missing native keyboard callback");
  const keyboardOpen = keyboard.index + keyboard[0].length - 1;
  const keys = body.slice(keyboardOpen + 1, lexical.matchingBrace(keyboardOpen));
  if (!["ArrowUp", "ArrowDown", "Tab", "[data-disabled]", "[data-interactive=", "[role=\"slider\"]", ".preventDefault()", ".stopPropagation()", "?.focus()"].every(needle => keys.includes(needle))) {
    throw new Error("Current inline model list: changed native keyboard navigation");
  }
  requireNativeBridge(copy, "ABep");
  requireNativeBridge(copy, "bqtn");
  return { nativeOptionMap: true, nativeSelectionCallback: true, nativeReturnedAdvancedRows: true, nativeKeyboardNavigation: true };
}

function inspectInlineModelList(copy) {
  const contract = Object.hasOwn(NATIVE, copy?.moduleId) ? NATIVE[copy.moduleId] : null;
  if (!contract || typeof copy.moduleSource !== "string" || typeof copy.source !== "string" ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource ||
      Buffer.byteLength(copy.moduleSource) > 64 * 1024) {
    throw new Error("Current inline model list: invalid native snapshot");
  }
  const source = copy.moduleSource;
  const lexical = createJavaScriptLexicalIndex(source);
  assertUnambiguousModelComposerLexicalSource(source, lexical);
  const publication = findRspackExportPublication(copy, contract.exportKey);
  if (!contract.needles.every(needle => source.includes(needle)) || !publication) {
    throw new Error("Current inline model list: missing native role publication");
  }
  const facts = copy.moduleId === "sByQ" ? inlineRendererFacts(copy, publication) : {};
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  if (!contract.hashes.includes(digest)) {
    throw new Error("Current inline model list: changed current native capability");
  }
  return { kind: contract.kind, state: "native", moduleId: copy.moduleId, sha256: digest, ...facts };
}

function requireNativeBridge(copy, moduleId) {
  const loader = copy.params[2];
  const candidates = [...copy.moduleSource.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)=${loader}\\("${moduleId}"\\)`, "gu"))];
  if (candidates.length !== 1 || findRspackRequireBinding(copy, candidates[0][1])?.moduleId !== moduleId) {
    throw new Error(`Current inline model list: unbound ${moduleId} bridge`);
  }
}

function auditCopies(copies) {
  const assets = new Map(copies.map(copy => [copy.assetName, copy.source]));
  if ([...assets.values()].reduce((bytes, source) => bytes + Buffer.byteLength(source), 0) > 16 * 1024 * 1024) {
    throw new Error("Current inline model list: selected source budget exceeded");
  }
  for (const moduleId of Object.keys(NATIVE)) {
    const peers = copies.filter(copy => copy.moduleId === moduleId);
    if (!peers.length || new Set(peers.map(copy => copy.assetName)).size !== peers.length) {
      throw new Error("Current inline model list: incomplete native role cohort");
    }
    for (const copy of peers) {
      inspectInlineModelList(copy);
      if (moduleId === "dig0") {
        requireNativeBridge(copy, "erx1");
        requireNativeBridge(copy, "sByQ");
      } else if (moduleId === "erx1") requireNativeBridge(copy, "sByQ");
    }
  }
  return { matched: true, changed: false, changedAssets: [], nativePhysicalCopies: copies.length };
}

function auditInlineModelList(extractedDir) {
  const assets = path.join(extractedDir, "webview/assets");
  const copies = Object.keys(NATIVE).flatMap(moduleId => findUniqueRspackModuleCopies(assets, {
    description: `current native inline model list ${moduleId}`,
    sourceMatch: source => source.includes("modelListConfig:") || source.includes("modelOptionsDisabled:"),
    matchModule: (_source, copy) => {
      if (copy.moduleId !== moduleId) return false;
      try { inspectInlineModelList(copy); return true; } catch { return false; }
    },
  }));
  return auditCopies(copies);
}

function auditInlineModelListSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 16 * 1024 * 1024) {
    throw new Error("Current inline model list: source budget exceeded");
  }
  auditCopies([...rspackModuleFactories(source, "source.js")].filter(copy => Object.hasOwn(NATIVE, copy.moduleId)));
  return source;
}

module.exports = { inspectInlineModelList, auditInlineModelList, auditInlineModelListSource };
