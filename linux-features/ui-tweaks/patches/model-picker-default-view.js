"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../../scripts/patches/lib/minified-js.js");
const { findRspackExportPublication } = require("../../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding, findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../../scripts/patches/lib/assets.js");
const { hasStableEagerMainBinding } = require("../../../scripts/patches/lib/main-request-sites.js");
const { assertUnambiguousModelComposerLexicalSource } = require("../../../scripts/patches/lib/model-composer-lexical-guard.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxModelPickerDefaultAdvancedView";
const CONTRACTS = {
  work: { exportKey: "M", renderer: "dig0", stateReferences: 3, setterReferences: 4 },
  chat: { exportKey: "N", renderer: "ivi7", stateReferences: 5, setterReferences: 4 },
};

function one(values, description) {
  if (values.length !== 1) throw new Error(`Current model picker: ${description}`);
  return values[0];
}

function codeMatches(text, expression) {
  const lexical = createJavaScriptLexicalIndex(text);
  return [...text.matchAll(expression)].filter(match => lexical.isCode(match.index));
}

function references(text, name) {
  return codeMatches(text, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "gu"));
}

function publishedComponent(copy, contract) {
  const publication = findRspackExportPublication(copy, contract.exportKey);
  if (publication?.fn) return publication.fn;
  if (!publication?.expression || !new RegExp(`^${ID}$`, "u").test(publication.expression)) {
    throw new Error("Current model picker: missing component publication");
  }
  const lexical = createJavaScriptLexicalIndex(copy.moduleSource);
  const declaration = one(codeMatches(copy.moduleSource,
    new RegExp(`(?<![\\w$.])function ${escapeRegExp(publication.expression)}\\(${ID}\\)\\{`, "gu"))
    .filter(match => lexical.isRoot(match.index)), "ambiguous published component");
  if (!hasStableEagerMainBinding(copy.moduleSource, publication.expression)) {
    throw new Error("Current model picker: replaced component publication");
  }
  const open = declaration.index + declaration[0].length - 1;
  return { start: declaration.index, end: lexical.matchingBrace(open) + 1 };
}

function requireProvider(copy, name, expected) {
  const binding = findRspackRequireBinding(copy, name);
  if (!binding || binding.moduleId !== expected || copy.params.includes(name)) {
    throw new Error(`Current model picker: wrong ${expected} provider`);
  }
  const start = binding.start - copy.start;
  let probe = "__nativePickerProvider";
  while (copy.moduleSource.includes(probe)) probe += "$";
  const projected = copy.moduleSource.slice(0, start) + probe + copy.moduleSource.slice(start + name.length);
  if (!hasStableEagerMainBinding(projected, name)) {
    throw new Error("Current model picker: replaced native provider");
  }
}

function jsxCalls(body) {
  const lexical = createJavaScriptLexicalIndex(body);
  return codeMatches(body, new RegExp(`\\(0,(${ID})\\.jsx(?:s)?\\)\\((${ID})\\.(${ID}),\\{`, "gu"))
    .flatMap(call => {
      const open = call.index + call[0].length - 1;
      const close = lexical.matchingBrace(open);
      if (body[close + 1] !== ")") return [];
      return [{ start: call.index, end: close + 2, jsx: call[1], namespace: call[2], member: call[3],
        props: body.slice(open + 1, close), root: lexical.isRoot(call.index) }];
    });
}

function assignedResult(body, call) {
  const match = new RegExp(`(?<![\\w$.])(${ID})=$`, "u").exec(body.slice(0, call.start));
  if (!match) throw new Error("Current model picker: missing native render result");
  return match[1];
}

function requireMemoResult(body, call, result, memo) {
  const cache = escapeRegExp(memo), value = escapeRegExp(result);
  const compare = `${cache}\\[\\d+\\]!==${ID}`;
  one(codeMatches(body.slice(0, call.start), new RegExp(`${compare}(?:\\|\\|${compare})*\\?\\(${value}=$`, "gu")),
    "changed native returned memo branch");
  const tail = new RegExp(`^(?:,${cache}\\[\\d+\\]=${ID})*,${cache}\\[(\\d+)\\]=${value}\\):${value}=${cache}\\[\\1\\],${value}$`, "u");
  if (!tail.test(body.slice(call.end))) throw new Error("Current model picker: discarded native menu result");
}

function requireReturnedMenu(body, consumer, kind) {
  const lexical = createJavaScriptLexicalIndex(body);
  const exits = codeMatches(body, /\b(?:return|throw)\b/gu).filter(match => lexical.isRoot(match.index));
  if (exits.length !== (kind === "work" ? 1 : 2) || exits.some(match => match[0] !== "return")) {
    throw new Error("Current model picker: changed component exit path");
  }
  if (kind === "chat") {
    const gate = exits[0];
    if (!new RegExp(`if\\(!${ID}\\)$`, "u").test(body.slice(0, gate.index)) ||
        !body.startsWith("return null;", gate.index)) {
      throw new Error("Current model picker: changed native eligibility return");
    }
  }
  const returned = exits.at(-1);
  const memo = one(codeMatches(body, new RegExp(`(${ID})=\\(0,${ID}\\.c\\)\\(\\d+\\)`, "gu"))
    .filter(match => lexical.isRoot(match.index)), "missing native component memo")[1];
  if (!new RegExp(`^return ${escapeRegExp(memo)}\\[\\d+\\]!==${ID}`, "u").test(body.slice(returned.index))) {
    throw new Error("Current model picker: replaced native return expression");
  }
  const calls = jsxCalls(body);
  const parent = one(calls.filter(call => call.root && call.namespace === call.jsx && call.member === "Fragment" &&
    call.start < consumer.start && consumer.end < call.end), "menu has no native root render parent");
  const result = assignedResult(body, parent);
  if (kind === "work") {
    if (parent.props !== "children:" + body.slice(consumer.start, consumer.end) || returned.index > parent.start) {
      throw new Error("Current model picker: menu is outside the native Work return");
    }
    requireMemoResult(body, parent, result, memo);
    return;
  }
  if (!parent.props.startsWith("children:[") ||
      !parent.props.endsWith("," + body.slice(consumer.start, consumer.end) + "]") || parent.start > returned.index) {
    throw new Error("Current model picker: changed native Chat menu children");
  }
  const wrapper = one(calls.filter(call => call.root && call.props.endsWith(`children:${result}`) &&
    call.start > parent.end && call.end < returned.index), "missing native Chat presentation wrapper");
  const wrapperHead = new RegExp(`(?<![\\w$.])(${ID})=${ID}\\?$`, "u").exec(body.slice(0, wrapper.start));
  if (!wrapperHead || body.slice(wrapper.end, returned.index) !== `:${result};`) {
    throw new Error("Current model picker: changed native Chat presentation result");
  }
  const final = one(calls.filter(call => call.root && call.start > returned.index &&
    call.namespace === call.jsx && call.member === "Fragment" &&
    new RegExp(`^children:\\[${escapeRegExp(wrapperHead[1])},${ID}\\]$`, "u").test(call.props)),
  "menu does not reach the final Chat return");
  requireMemoResult(body, final, assignedResult(body, final), memo);
}

function menuConsumer(copy, body, view, contract) {
  const lexical = createJavaScriptLexicalIndex(body);
  const candidates = [];
  for (const call of codeMatches(body, new RegExp(`\\(0,(${ID})\\.jsx(?:s)?\\)\\((${ID})\\.(${ID}),\\{`, "gu"))) {
    const open = call.index + call[0].length - 1;
    const close = lexical.matchingBrace(open);
    const props = body.slice(open + 1, close);
    const propertyLexical = createJavaScriptLexicalIndex(props);
    const values = name => codeMatches(props, new RegExp(`(?<![\\w$.])${name}:(${ID})(?=,|$)`, "gu"))
      .filter(match => propertyLexical.isRoot(match.index));
    const views = values("menuView");
    if (views.length !== 1 || views[0][1] !== view) continue;
    const toggle = one(values("onToggleMenuView"), "missing native menu toggle")[1];
    const opening = one(values("onOpenChange"), "missing native menu open callback")[1];
    requireProvider(copy, call[1], "ABep");
    requireProvider(copy, call[2], contract.renderer);
    candidates.push({ toggle, opening, props, start: call.index, end: close + 2 });
  }
  return one(candidates, "missing or ambiguous native menu consumer");
}

function openingCallback(body, name, allowWrapper = false) {
  const lexical = createJavaScriptLexicalIndex(body);
  let heads = codeMatches(body, new RegExp(
    `(?:function ${escapeRegExp(name)}|${escapeRegExp(name)}=function)\\(${ID}(?:,${ID})?\\)\\{`, "gu"))
    .filter(match => lexical.isRoot(match.index));
  if (!heads.length && allowWrapper) {
    const wrapper = one(codeMatches(body, new RegExp(
      `${escapeRegExp(name)}=(${ID})=>\\{\\1&&${ID}&&!${ID}\\?${ID}\\(\\):(${ID})\\(\\1\\)\\}`, "gu")),
    "missing native Chat open wrapper");
    const cached = one(codeMatches(body, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(${ID})\\[(\\d+)\\]`, "gu")),
      "changed native open-wrapper cache read");
    if (codeMatches(body, new RegExp(`${escapeRegExp(cached[1])}\\[${cached[2]}\\]=${escapeRegExp(name)}(?=,|\\))`, "gu")).length !== 1) {
      throw new Error("Current model picker: changed native open-wrapper cache write");
    }
    let projected = body;
    for (const at of [wrapper.index, cached.index].sort((a, b) => b - a)) {
      projected = projected.slice(0, at) + "__nativeOpenWrapper" + projected.slice(at + name.length);
    }
    if (!hasStableEagerMainBinding(projected, name)) throw new Error("Current model picker: replaced open wrapper");
    return openingCallback(body, wrapper[2]);
  }
  const head = one(heads, "missing native open callback binding");
  const projected = head[0].startsWith("function ") ? body :
    body.slice(0, head.index) + "__nativeOpenCallback" + body.slice(head.index + name.length);
  if (!hasStableEagerMainBinding(projected, name)) throw new Error("Current model picker: replaced open callback");
  const open = head.index + head[0].length - 1;
  return { start: open + 1, end: lexical.matchingBrace(open) };
}

function inspectDefaultView(copy, kind) {
  const contract = CONTRACTS[kind];
  if (!contract || !copy || typeof copy.moduleSource !== "string" || typeof copy.source !== "string" ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource ||
      Buffer.byteLength(copy.moduleSource) > 256 * 1024) {
    throw new Error("Current model picker: invalid component snapshot");
  }
  const moduleLexical = createJavaScriptLexicalIndex(copy.moduleSource);
  assertUnambiguousModelComposerLexicalSource(copy.moduleSource, moduleLexical);
  for (const escape of copy.moduleSource.matchAll(/\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/gu)) {
    if (moduleLexical.isCode(escape.index)) throw new Error("Current model picker: escaped binding authority");
  }
  const component = publishedComponent(copy, contract);
  const text = copy.moduleSource.slice(component.start, component.end);
  new Script(`(${text})`);
  const open = text.indexOf("{");
  const body = text.slice(open + 1, -1);
  const lexical = createJavaScriptLexicalIndex(body);
  const state = one(codeMatches(body, new RegExp(
    `\\[(${ID}),(${ID})\\]=\\(0,(${ID})\\.useState\\)\\("(simple|advanced)"\\)(/\\*${MARKER}\\*/)?`, "gu"))
    .filter(match => lexical.isRoot(match.index)), "missing or ambiguous view state");
  const [view, setter, react, value, marker] = state.slice(1);
  const patched = value === "advanced" && marker != null;
  if (value !== "simple" && !patched || value === "simple" && marker != null) {
    throw new Error("Current model picker: incomplete advanced state");
  }
  if (new Set([view, setter, react]).size !== 3 ||
      references(body, view).length !== contract.stateReferences ||
      references(body, setter).length !== contract.setterReferences) {
    throw new Error("Current model picker: changed view-state ownership");
  }
  requireProvider(copy, react, "zd8w");
  new Script(`(${text.slice(0, -1)};let ${react};})`);
  const reset = one(codeMatches(body, new RegExp(
    `\\(0,(${ID})\\.q\\)\\(\\{canRenderPowerPickerSurface:[^;]{1,800}?menuView:${escapeRegExp(view)},onReset:`, "gu")),
  "missing native reset consumer");
  requireProvider(copy, reset[1], "unb4");
  const timer = one(codeMatches(body, new RegExp(
    `(${ID})\\.current=window\\.setTimeout\\(\\(\\)=>\\{\\1\\.current=null,${escapeRegExp(setter)}\\("${patched ? "advanced" : "simple"}"\\)\\},350\\)`, "gu")),
  "missing close-reset callback");
  const edits = [
    { start: state.index, end: state.index + state[0].length,
      native: state[0].replace(/\("advanced"\)\/\*[^*]+\*\//u, '("simple")'),
      patched: `[${view},${setter}]=(0,${react}.useState)("advanced")/*${MARKER}*/` },
    { start: timer.index, end: timer.index + timer[0].length,
      native: timer[0].replace(`("${patched ? "advanced" : "simple"}")`, '("simple")'),
      patched: timer[0].replace(`("${patched ? "advanced" : "simple"}")`, '("advanced")') },
  ];
  let returnedMenuProps;
  if (kind === "work") {
    const derived = one(codeMatches(body, new RegExp(
      `(${ID})=!\\((${ID})\\.length<2\\)\\|\\|(${ID})\\?${escapeRegExp(view)}:"advanced"`, "gu")),
    "missing native Work view resolver");
    const consumer = menuConsumer(copy, body, derived[1], contract);
    requireReturnedMenu(body, consumer, kind);
    returnedMenuProps = consumer.props;
    const callback = openingCallback(body, consumer.opening);
    if (timer.index < callback.start || timer.index + timer[0].length > callback.end) {
      throw new Error("Current model picker: close reset is outside the live Work callback");
    }
    const toggle = one(codeMatches(body, new RegExp(
      `${escapeRegExp(consumer.toggle)}=(${ID})=>\\{${ID}\\.current=!1,${escapeRegExp(setter)}\\(\\1\\)\\}`, "gu")),
    "missing native Work toggle callback");
    if (!toggle || !body.includes(`setModelAndReasoningEffort`)) {
      throw new Error("Current model picker: missing Work selection path");
    }
    const action = one(codeMatches(body, new RegExp(patched
      ? `${escapeRegExp(setter)}\\((${ID})\\?\\.showModelList===false\\?"simple":"advanced"\\)`
      : `${escapeRegExp(setter)}\\((${ID})\\?\\.showModelList\\?"advanced":"simple"\\)`, "gu")),
    "missing Work open action");
    edits.push({ start: action.index, end: action.index + action[0].length,
      native: `${setter}(${action[1]}?.showModelList?"advanced":"simple")`,
      patched: `${setter}(${action[1]}?.showModelList===false?"simple":"advanced")` });
    const actionLexical = createJavaScriptLexicalIndex(body);
    const actionOwner = one(codeMatches(body, new RegExp(`(${ID})=\\((${ID}),(${ID})\\)=>\\{`, "gu"))
      .filter(head => {
        const start = head.index + head[0].length;
        const end = actionLexical.matchingBrace(start - 1);
        return start <= action.index && action.index + action[0].length <= end && head[3] === action[1];
      }), "missing Work shortcut callback owner");
    const registered = one(codeMatches(body, new RegExp(
      `\\(0,(${ID})\\.Kr\\)\\("composer\\.openModelPicker",${escapeRegExp(actionOwner[1])},`, "gu")),
    "missing native Work shortcut registration");
    requireProvider(copy, registered[1], "w487");
  } else {
    const consumer = menuConsumer(copy, body, view, contract);
    requireReturnedMenu(body, consumer, kind);
    returnedMenuProps = consumer.props;
    const callback = openingCallback(body, consumer.opening, true);
    const opening = one(codeMatches(body, new RegExp(
      `let (${ID})=(${ID})&&!(${ID})\\?"${patched ? "advanced" : "simple"}":${escapeRegExp(view)};if\\(\\1!==${escapeRegExp(view)}&&${escapeRegExp(setter)}\\(\\1\\),`, "gu")),
    "missing Chat open callback");
    edits.push({ start: opening.index, end: opening.index + opening[0].length,
      native: opening[0].replace(`?"${patched ? "advanced" : "simple"}":`, '?"simple":'),
      patched: opening[0].replace(`?"${patched ? "advanced" : "simple"}":`, '?"advanced":') });
    if (timer.index < callback.start || timer.index + timer[0].length > callback.end ||
        opening.index < callback.start || opening.index + opening[0].length > callback.end) {
      throw new Error("Current model picker: Chat defaults are outside the live open callback");
    }
    if (!body.includes(`menuView:${view},keepSimpleView:`) || consumer.toggle !== setter) {
      throw new Error("Current model picker: missing Chat view/toggle consumer");
    }
  }
  const offset = component.start + open + 1;
  function render(key) {
    let output = copy.moduleSource;
    for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
      output = output.slice(0, offset + edit.start) + edit[key] + output.slice(offset + edit.end);
    }
    return output;
  }
  if (copy.moduleSource.split(MARKER).length - 1 !== Number(patched)) {
    throw new Error("Current model picker: orphan advanced-view marker");
  }
  return { kind, state: patched ? "patched" : "native", nativeSource: render("native"),
    patchedSource: render("patched"), returnedMenuProps };
}

function prepareDefaultView(copies) {
  if (!copies.length) throw new Error("Current model picker: empty owner cohort");
  for (const kind of ["work", "chat"]) {
    const peers = copies.filter(copy => copy.pickerKind === kind);
    if (peers.length && (new Set(peers.map(copy => copy.moduleId)).size !== 1 ||
        new Set(peers.map(copy => copy.assetName)).size !== peers.length)) {
      throw new Error("Current model picker: inconsistent physical owner cohort");
    }
  }
  const assets = new Map();
  for (const copy of copies) {
    if (assets.has(copy.assetName) && assets.get(copy.assetName) !== copy.source) {
      throw new Error("Current model picker: inconsistent asset snapshot");
    }
    assets.set(copy.assetName, copy.source);
  }
  if ([...assets.values()].reduce((total, source) => total + Buffer.byteLength(source), 0) > 16 * 1024 * 1024) {
    throw new Error("Current model picker: selected source budget exceeded");
  }
  const plans = copies.map(copy => inspectDefaultView(copy, copy.pickerKind));
  if (new Set(plans.map(plan => plan.state)).size !== 1) throw new Error("Current model picker: mixed view states");
  return [...assets].map(([assetName, source]) => {
    const output = { assetName, source, patchedSource: source, nativeSource: source };
    const members = copies.map((copy, index) => ({ copy, plan: plans[index] }))
      .filter(({ copy }) => copy.assetName === assetName).sort((a, b) => b.copy.start - a.copy.start);
    for (const { copy, plan } of members) {
      output.patchedSource = output.patchedSource.slice(0, copy.start) + plan.patchedSource + output.patchedSource.slice(copy.end);
      output.nativeSource = output.nativeSource.slice(0, copy.start) + plan.nativeSource + output.nativeSource.slice(copy.end);
    }
    return output;
  });
}

function locateDefaultView(assets) {
  const copies = [];
  for (const kind of ["work", "chat"]) {
    copies.push(...findUniqueRspackModuleCopies(assets, {
      description: `current ${kind} picker view`,
      sourceMatch: text => kind === "work" ? text.includes("setModelAndReasoningEffort") && text.includes("showModelList") : text.includes("chatgpt-model-picker"),
      matchModule: (_text, copy) => { try { inspectDefaultView(copy, kind); return true; } catch { return false; } },
    }).map(copy => ({ ...copy, pickerKind: kind })));
  }
  const edits = prepareDefaultView(copies);
  let markers = 0;
  for (const name of listWebviewAssetFiles(assets, /\.js$/u)) {
    markers += fs.readFileSync(path.join(assets, name), "utf8").split(MARKER).length - 1;
  }
  const expected = copies.filter(copy => inspectDefaultView(copy, copy.pickerKind).state === "patched").length;
  if (markers !== expected) throw new Error("Current model picker: orphan asset marker");
  return edits;
}

function applyDefaultView(extractedDir, options = {}) {
  return { ...patchWebviewAssets(path.join(extractedDir, "webview/assets"), locateDefaultView(path.join(extractedDir, "webview/assets")), options), matched: true };
}

function prepareDefaultViewSource(source) {
  const copies = [];
  for (const copy of rspackModuleFactories(source, "source.js")) {
    for (const kind of ["work", "chat"]) {
      try { inspectDefaultView(copy, kind); copies.push({ ...copy, pickerKind: kind }); } catch {}
    }
  }
  if (!copies.length) throw new Error("Current model picker: no published view owner");
  const edits = prepareDefaultView(copies);
  if (source.split(MARKER).length - 1 !== copies.filter(copy => inspectDefaultView(copy, copy.pickerKind).state === "patched").length) {
    throw new Error("Current model picker: orphan source marker");
  }
  return edits[0].patchedSource;
}

module.exports = { MARKER, inspectDefaultView, prepareDefaultView, locateDefaultView, applyDefaultView, prepareDefaultViewSource };
