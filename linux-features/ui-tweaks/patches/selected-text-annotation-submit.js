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
// reads the current text and follows its native save/direct policy, including
// the existing composition, repeat and submission-validation guards.
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

function functionCandidates(scope) {
  const {createJavaScriptLexicalIndex}=helpers();
  const lexical=createJavaScriptLexicalIndex(scope);
  const trivia="(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r?\\n|$))";
  const header=new RegExp(`(?<![\\w$.])(?:(?<async>async)${trivia}+)?function(?:${trivia}+(?<name>${IDENT})|${trivia}*(?<generator>\\*)${trivia}*(?<generatorName>${IDENT}))${trivia}*\\((?<params>[^)]*)\\)${trivia}*\\{`,"gu");
  return [...scope.matchAll(header)].filter(head=>lexical.isCode(head.index)&&lexical.isRoot(head.index)).map(head=>{
    const open=head.index+head[0].length-1,end=lexical.matchingBrace(open);
    return {name:head.groups.name??head.groups.generatorName,params:head.groups.params,start:head.index,open,end,
      ordinary:!head.groups.async&&!head.groups.generator,source:scope.slice(head.index,end+1),body:scope.slice(open+1,end)};
  }).filter(fn=>fn.end>fn.open);
}
function uniqueMatchOwner(owners,label) {
  if(owners.length!==1)throw new Error(`Expected one ${label}, found ${owners.length}`);
  return owners[0];
}
function ordinaryDeclaration(scope,fn) {
  if(!fn||!fn.ordinary)throw new Error("Native annotation owner must be an ordinary function declaration");
  try {new (require("node:vm").Script)(`"use strict";function annotationDeclarationProbe(){\n${scope.slice(0,fn.start)}\nconst declared=0;\n}`);}
  catch {throw new Error("Native annotation owner is not a statement declaration");}
  return fn;
}

function shortcutContract(source) {
  const { escapeRegExp, findMatchingBrace } = helpers();
  const commandAnchor = uniqueMatch(source, COMMAND_ANCHOR, "app shortcut editable-scope anchor");
  const modules=source.includes("__webpack_modules__")?webpackModules(source):[];
  const module=modules.find(module=>module.start<=commandAnchor.index&&commandAnchor.index<module.end);
  if(source.includes("__webpack_modules__")&&!module)throw new Error("App shortcut factory owner drifted");
  const scope=module?.moduleSource??source,offset=module?.start??0;
  const owner=uniqueMatchOwner(functionCandidates(scope).filter(fn=>fn.open<commandAnchor.index-offset&&commandAnchor.index-offset<fn.end),"app shortcut owner");
  ordinaryDeclaration(scope,owner);
  const start=offset+owner.start;
  const body=owner.source;
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
    return { state: "applied", ownerStart: start };
  }
  return { state: "current", ownerStart: start, insertion: start + handler.index +
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
// Keep the public fixture view while deriving every factory from the shared
// current renderer index. Publication authority uses its original snapshot.
function webpackModules(source) {
  const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
  return [...rspackModuleFactories(source,"annotation-submit.js")].map(module => ({
    ...module,id:module.moduleId,body:module.moduleSource,
  }));
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
// whose capture handler owns the native Ctrl+Enter save/direct routing.
function nativeFunction(source,name) {
  const fn=uniqueMatchOwner(functionCandidates(source).filter(fn=>fn.name===name),"native function declaration");
  return ordinaryDeclaration(source,fn);
}
function publishedNativeFunction(module,key) {
  const { findRspackExportPublication } = require("../../../scripts/patches/lib/rspack-export-publication.js");
  const publication=findRspackExportPublication(module,key);
  if(!publication)throw new Error("Native annotation publication authority drifted");
  if(publication.fn)return {...publication.fn,source:module.moduleSource.slice(publication.fn.start,publication.fn.end),end:publication.fn.end-1};
  if(!new RegExp(`^${IDENT}$`,"u").test(publication.expression))throw new Error("Native annotation function export drifted");
  return nativeFunction(module.moduleSource,publication.expression);
}

function nativeProps(fn) {
  const { escapeRegExp } = helpers();
  const props = fn.params.startsWith("{") ? fn.params.slice(1,-1) :
    uniqueMatch(fn.source, `\\{(?<props>[^{}]*onDirectSubmit:[^{}]*)\\}=${escapeRegExp(fn.params)}(?=[,;])`, "native callback props").groups.props;
  const callback = key => uniqueMatch(props, `(?:^|,)${key}:(?<callback>${IDENT})(?=,|$)`, "native submit prop").groups.callback;
  return {direct:callback("onDirectSubmit"),saved:callback("onSubmit"),props};
}

function nativeFunctionOwner(source,index) {
  const fn=uniqueMatchOwner(functionCandidates(source).filter(fn=>fn.open<index&&index<fn.end),"native annotation handler owner");
  return ordinaryDeclaration(source,fn);
}

function nativeEditorContract(editorChunks) {
  const { escapeRegExp, findMatchingBrace } = helpers();
  const editors = modulesContaining(editorChunks, EDITOR_NEEDLES, "annotation editor");
  if (editors.length !== 1) throw new Error(`Expected one native annotation editor module, found ${editors.length}`);
  const editor = editors[0];
  const requireParam = editor.params[2];
  if (requireParam == null) throw new Error("Native annotation editor module has no require parameter");
  const editorOwner = publishedNativeFunction(editor,"SelectedTextAnnotationEditor");
  const render = uniqueMatch(editorOwner.source,
    `\\(0,${IDENT}\\.jsxs?\\)\\((?<binding>${IDENT})\\.(?<exported>[\\w$]+),\\{[^{}]*?onDirectSubmit:`,
    "native annotation card render");
  const editorCallbacks = nativeProps(editorOwner);
  const editorPropsOpen = render.index + render[0].lastIndexOf("{");
  const editorPropsEnd = findMatchingBrace(editorOwner.source,editorPropsOpen);
  const editorProps = editorOwner.source.slice(editorPropsOpen,editorPropsEnd+1);
  const directBridge = uniqueMatch(editorProps, `onDirectSubmit:(?<callback>${IDENT})(?=[,}])`, "selected-text editor direct callback").groups.callback;
  const directBridgeMatch=uniqueMatch(editorOwner.source,
    `${escapeRegExp(directBridge)}=(?<request>${IDENT})=>\\{let\\{body:(?<body>${IDENT})\\}=\\k<request>;` +
    `null==${escapeRegExp(editorCallbacks.direct)}\\|\\|(?<busy>${IDENT})\\.current\\|\\|\\(\\k<busy>\\.current=!0,\\(async\\(\\)=>${escapeRegExp(editorCallbacks.direct)}\\(\\k<body>\\)\\)\\(\\)\\.finally\\(\\(\\)=>\\{\\k<busy>\\.current=!1\\}\\)\\)\\}`,
    "selected-text editor direct-submit bridge");
  const savedBridge=uniqueMatch(editorProps,`onSubmit:(?<callback>${IDENT})(?=[,}])`,"selected-text editor saved callback").groups.callback;
  const savedBridgeMatch=uniqueMatch(editorOwner.source,
    `${escapeRegExp(savedBridge)}=(?<request>${IDENT})=>\\{let\\{body:(?<body>${IDENT})\\}=\\k<request>;return ${escapeRegExp(editorCallbacks.saved)}\\(\\k<body>\\)\\}`,
    "selected-text editor saved-submit bridge");
  const createMode=uniqueMatch(editorProps,'defaultCreateSubmitMode:"(?<mode>saved|direct)"',"native annotation create mode").groups.mode;
  const { findRspackRequireBinding } = require("../../../scripts/patches/lib/rspack-module-assets.js");
  const linkage=findRspackRequireBinding(editor,render.groups.binding);
  if(!linkage)throw new Error("Native annotation card require drifted");
  const cardId=linkage.moduleId;
  return {editor,editorOwner,editorCallbacks,editorProps,directBridge,directBridgeMatch,savedBridge,savedBridgeMatch,createMode,cardId,render};
}

function validateNativeEditor(editorChunks,cardChunks) {
  const {escapeRegExp,findMatchingBrace}=helpers();
  const {editor,editorOwner,editorCallbacks,editorProps,directBridge,directBridgeMatch,savedBridge,savedBridgeMatch,createMode,cardId,render}=nativeEditorContract(editorChunks);
  const editorCopies=editorChunks.flatMap(chunk=>webpackModules(chunk.source)).filter(module=>module.id===editor.id);
  if(editorCopies.length!==1)throw new Error("Expected one complete native annotation editor module copy");
  const linkedCards=[];
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
    const wrapper = publishedNativeFunction(cardMetadata,render.groups.exported);
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
    const submitFunction = nativeFunction(inner.body,router.groups.submit);
    const parameters = new RegExp(`^(?<mode>${IDENT}),(?<source>${IDENT})="button"$`).exec(submitFunction.params);
    if (parameters == null) throw new Error("Native submission parameters drifted");
    const submit = submitFunction.source;
    const validation = uniqueMatch(submit,
      `(?<result>${IDENT})=\\(0,(?<validatorNamespace>${IDENT})\\.(?<validatorMethod>${IDENT})\\)\\(\\{submitMode:(?<mode>${escapeRegExp(parameters.groups.mode)}),` +
      `submitSource:${escapeRegExp(parameters.groups.source)},commentText:${escapeRegExp(editorBinding)}\\.getText\\(\\),`, "native current-text submission validator");
    uniqueMatch(submit, `case"noop":return;`, "native empty/invalid submission guard");
    uniqueMatch(submit,
      `case"submit":"direct"===${escapeRegExp(validation.groups.mode)}\\?${escapeRegExp(callbacks.direct)}\\(${escapeRegExp(validation.groups.result)}\\.payload\\):` +
      `${escapeRegExp(callbacks.saved)}\\(${escapeRegExp(validation.groups.result)}\\.payload\\)`, "native validated callback routing");
    linkedCards.push({module:cardMetadata,wrapper,inner,callbacks,editorBinding,
      keydown:{parameter:keydown.groups.event,source:`${keydown.groups.event}=>${body}`},
      router:router.groups,submit:submitFunction,validator:validation.groups});
  }
  return {editor:{module:editor,owner:editorOwner,callbacks:editorCallbacks,props:editorProps,createMode,
    directBridge:{name:directBridge,source:directBridgeMatch[0].slice(directBridge.length+1),busy:directBridgeMatch.groups.busy},
    savedBridge:{name:savedBridge,source:savedBridgeMatch[0].slice(savedBridge.length+1)}},cards:linkedCards};
}

// Collect semantic candidates, then use the shared indexer to inventory every
// copy of the resolved shortcut/editor/card identities. Markerless damaged
// peers must be rejected before the single shortcut asset can change.
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
  const { findUniqueRspackModuleCopies } = require("../../../scripts/patches/lib/rspack-module-assets.js");
  const copies = id => findUniqueRspackModuleCopies(assets,{
    description:`annotation module ${id}`,
    sourceMatch:source=>new RegExp(`(?:${helpers().escapeRegExp(id)}|${helpers().escapeRegExp(JSON.stringify(id))})\\s*\\(`,"u").test(source),
    matchModule:(_body,module)=>module.moduleId===id,
  });
  if(owners.length===1){
    const at=shortcutContract(owners[0].source).ownerStart;
    const module=webpackModules(owners[0].source).find(module=>module.start<=at&&at<module.end);
    if(!module||copies(module.id).length!==1)throw new Error("Expected one complete app shortcut module copy");
  }
  if(editors.length){
    const contract=nativeEditorContract(editors);
    const chunks=modules=>[...new Map(modules.map(module=>[module.assetName,{name:module.assetName,source:module.source}])).values()];
    return {assets,owners,editors:chunks(copies(contract.editor.id)),cards:chunks(copies(contract.cardId))};
  }
  return {assets,owners,editors,cards};
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
