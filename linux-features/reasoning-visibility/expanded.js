"use strict";

const { Script } = require("node:vm");
const path = require("node:path");
const { rspackModuleFactories, findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { escapeRegExp, createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { runtimeVisibility, withRuntime } = require("./runtime.js");

const ID = "[A-Za-z_$][\\w$]*";
const ENABLED = "codexLinuxReasoningVisibilityEnabled()";
const STATE_MARKER = "/*community-reasoning-visibility-expanded*/";
const BODY_MARKER = "/*community-reasoning-visibility-expanded-body*/";

function stableComponentBinding(body,name,declaration,lexical) {
  const tokens=/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  for(const token of body.matchAll(tokens)) {
    const decoded=token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,(_,braced,fixed)=>String.fromCodePoint(parseInt(braced||fixed,16)));
    if(decoded!==name||token.index===declaration||[".","#"].includes(body[token.index-1])||/^\s*:/u.test(body.slice(token.index+token[0].length))||!lexical.isCode(token.index))continue;
    try {new Script(`function expandedBindingProbe(){${body.slice(0,token.index)}(0)${body.slice(token.index+token[0].length)}\n}`);}
    catch{return false;}
  }
  return true;
}

function returnedDisclosure(component,visible,state) {
  const body=component.text.slice(component.text.indexOf("{")+1,-1),lexical=createJavaScriptLexicalIndex(body);
  const returns=[...body.matchAll(/\breturn\b/gu)].filter(match=>lexical.isRoot(match.index));
  if(returns.length!==1)return false;
  const returned=returns[0];let first=returned.index+6;
  while(first<body.length&&!lexical.isCode(first))first++;
  if(/[\r\n\u2028\u2029]/u.test(body.slice(returned.index+6,first)))return false;
  if([...body.matchAll(/;/gu)].some(match=>match.index>returned.index&&lexical.isRoot(match.index)))return false;
  const pattern=new RegExp(
    `(?<cache>${ID})\\[(?<visibleSlot>\\d+)\\]!==${escapeRegExp(visible)}\\|\\|\\k<cache>\\[(?<scrollSlot>\\d+)\\]!==(?<scroll>${ID})\\?`+
    `\\((?<collapse>${ID})=\\(0,(?<jsx>${ID})\\.jsx\\)\\(${ID}\\.${ID},\\{expanded:${escapeRegExp(visible)},children:\\k<scroll>\\}\\),`+
    `\\k<cache>\\[\\k<visibleSlot>\\]=${escapeRegExp(visible)},\\k<cache>\\[\\k<scrollSlot>\\]=\\k<scroll>,\\k<cache>\\[(?<collapseSlot>\\d+)\\]=\\k<collapse>\\):\\k<collapse>=\\k<cache>\\[\\k<collapseSlot>\\],`+
    `\\k<cache>\\[(?<headerSlot>\\d+)\\]!==(?<header>${ID})\\|\\|\\k<cache>\\[(?<bodySlot>\\d+)\\]!==\\k<collapse>\\?`+
    `\\((?<result>${ID})=\\(0,\\k<jsx>\\.jsxs\\)\\(${ID}\\.${ID},\\{children:\\[\\k<header>,\\k<collapse>\\]\\}\\),`+
    `\\k<cache>\\[\\k<headerSlot>\\]=\\k<header>,\\k<cache>\\[\\k<bodySlot>\\]=\\k<collapse>,\\k<cache>\\[(?<resultSlot>\\d+)\\]=\\k<result>\\):\\k<result>=\\k<cache>\\[\\k<resultSlot>\\],\\k<result>$`,"gu");
  const tails=[...body.matchAll(pattern)];if(tails.length!==1||tails[0].index<returned.index||!lexical.isRoot(tails[0].index))return false;
  const g=tails[0].groups;
  const disclosure=new RegExp(`(?<disclosure>${ID})=${escapeRegExp(state.disclosure)}\\?\\{expanded:${escapeRegExp(state.state)},onToggle:\\(\\)=>\\{${escapeRegExp(state.setter)}\\(${ID}\\)\\}\\}:void 0`,"gu");
  const controls=[...body.matchAll(disclosure)].filter(match=>lexical.isRoot(match.index)&&returned.index<match.index&&match.index<tails[0].index);
  if(controls.length!==1)return false;
  const header=new RegExp(`${escapeRegExp(g.header)}=\\(0,${escapeRegExp(g.jsx)}\\.jsx\\)\\(${ID}\\.${ID},\\{externalDisclosure:${escapeRegExp(controls[0].groups.disclosure)},children:${ID}\\}\\)`,"gu");
  const headers=[...body.matchAll(header)].filter(match=>lexical.isRoot(match.index)&&controls[0].index<match.index&&match.index<tails[0].index);
  return headers.length===1&&new Set([g.visibleSlot,g.scrollSlot,g.collapseSlot,g.headerSlot,g.bodySlot,g.resultSlot]).size===6;
}

function reasoningComponent(source) {
  if (typeof source !== "string") return null;
  let modules;
  try { modules=source.includes("__webpack_modules__")?[...rspackModuleFactories(source,"reasoning-expanded.js")]:[{moduleSource:source,start:0}]; }
  catch { return null; }
  const found=[];
  for (const module of modules) {
    const body=module.moduleSource;
    if(!body.includes('key:"reasoning-markdown"'))continue;
    const lexical=createJavaScriptLexicalIndex(body);
    const keys=[...body.matchAll(/key:"reasoning-markdown"/gu)].filter(match=>lexical.isCode(match.index));
    if (!keys.length) continue;
    if (keys.length!==1) return null;
    const owners=[];
    for (const head of body.matchAll(new RegExp(`function (?<name>${ID})\\(${ID}\\)\\{`,"gu"))) {
      if (!lexical.isRoot(head.index)) continue;
      const end=lexical.matchingBrace(head.index+head[0].length-1)+1;
      if(head.index>=keys[0].index||end<=keys[0].index)continue;
      let previous=head.index-1;
      while(previous>=0&&!lexical.isCode(previous))previous--;
      // Require a completed factory-root statement before the declaration;
      // an ASI probe alone would mistake return/async prefixes for statements.
      if(previous>=0&&body[previous]!==";"&&body[previous]!=="}")continue;
      try { new Script(`function expandedOwnerProbe(){${body.slice(0,head.index)}\nconst expandedOwnerStatement=0;}`); }
      catch { continue; }
      if(!stableComponentBinding(body,head.groups.name,head.index+"function ".length,lexical))continue;
      owners.push({start:module.start+head.index,end:module.start+end});
    }
    if (owners.length!==1) return null;
    found.push({...owners[0],text:source.slice(owners[0].start,owners[0].end)});
  }
  return found.length===1?found[0]:null;
}

function expandedState(source) {
  const component = reasoningComponent(source);
  if (component == null) return { kind: "invalid" };
  const states = [...component.text.matchAll(new RegExp(
    `\\[(?<state>${ID}),(?<setter>${ID})\\]=\\(0,(?<react>${ID})\\.useState\\)\\(` +
    `(?<initial>!1|(?<patched>${escapeRegExp(ENABLED + STATE_MARKER)}))\\),` +
    `(?<disclosure>${ID})=!(?<stream>${ID})&&!!(?<body>${ID});`, "g"))];
  if (states.length !== 1) return { kind: "invalid" };
  const [state] = states;
  const { stream, body, state: expanded, setter } = state.groups;
  const views = [...component.text.matchAll(new RegExp(
    `(?<visible>${ID})=${escapeRegExp(stream)}\\?!!(?<streamBody>${ID})&&\\(null==(?<resume>${ID})\\|\\|"resumed"===\\k<resume>\\):${escapeRegExp(expanded)}` +
    `(?<guard>&&\\(!${escapeRegExp(ENABLED)}\\|\\|!!${escapeRegExp(body)}\\)${escapeRegExp(BODY_MARKER)})?,` +
    `(?<renderBody>${ID})=${escapeRegExp(stream)}\\?\\k<streamBody>:${escapeRegExp(body)};`, "g"))];
  if (views.length !== 1) return { kind: "invalid" };
  const [view] = views;
  if(!returnedDisclosure(component,view.groups.visible,state.groups))return {kind:"invalid"};
  const patched = state.groups.patched != null;
  if (patched !== (view.groups.guard != null) || source.split(STATE_MARKER).length - 1 !== Number(patched) ||
      source.split(BODY_MARKER).length - 1 !== Number(patched) ||
      !component.text.includes(`expanded:${expanded},onToggle:()=>{${setter}(`) ||
      !component.text.includes(`autoScrollToBottom:${stream},`) ||
      !component.text.includes(`children:${view.groups.renderBody}`)) return { kind: "invalid" };
  const initialOffset = state.index + state[0].indexOf(`(${state.groups.initial})`) + 1;
  const targetIndex = component.start + initialOffset;
  const visibility = runtimeVisibility(source, targetIndex);
  if (visibility === "invalid" || visibility === "absent" && source.includes(ENABLED) ||
      patched && visibility !== "visible") return { kind: "invalid" };
  if (patched) {
    const guardTarget = component.start + view.index + view[0].indexOf(ENABLED);
    if (runtimeVisibility(source, guardTarget) !== "visible") return { kind: "invalid" };
  }
  return { kind: patched ? "patched" : "current", component, state, view, initialOffset, targetIndex };
}

function applyExpandedPatch(source) {
  const current = expandedState(source);
  const fail = () => {
    console.warn("WARN: reasoning-visibility/expanded: current native disclosure contract missing, ambiguous, or incomplete");
    return source;
  };
  if (current.kind === "invalid") return fail();
  if (current.kind === "patched") return source;
  const { component, state, view, initialOffset, targetIndex } = current;
  const stateName = state.groups.state;
  const guardOffset = view.index + view[0].indexOf(`:${stateName}`) + 1 + stateName.length;
  // Initial expansion survives an initially empty stream. Completed items only
  // reveal a real body; the disabled preference retains the native state rule.
  const edits = [
    { index: initialOffset, length: state.groups.initial.length, text: ENABLED + STATE_MARKER },
    { index: guardOffset, length: 0, text: `&&(!${ENABLED}||!!${state.groups.body})${BODY_MARKER}` },
  ];
  let text = component.text;
  for (const edit of edits.sort((a, b) => b.index - a.index)) {
    text = text.slice(0, edit.index) + edit.text + text.slice(edit.index + edit.length);
  }
  const patched = withRuntime(source.slice(0, component.start) + text + source.slice(component.end), targetIndex);
  return expandedState(patched).kind === "patched" ? patched : fail();
}

function patchExpandedAssets(extractedDir) {
  const assets=path.join(extractedDir,"webview/assets");
  const copies=findUniqueRspackModuleCopies(assets,{
    sourceMatch:source=>source.includes('key:"reasoning-markdown"')||source.includes(STATE_MARKER)||source.includes(BODY_MARKER),
    matchModule:body=>reasoningComponent(body)!=null,
    description:"native reasoning disclosure component",
  });
  const edits=copies.map(copy=>{
    const component=reasoningComponent(copy.source);
    if(!component||component.start<copy.start||component.end>copy.end||expandedState(copy.source).kind==="invalid")throw Error(`Incomplete reasoning disclosure in ${copy.assetName}`);
    const patchedSource=applyExpandedPatch(copy.source);
    if(expandedState(patchedSource).kind!=="patched"||applyExpandedPatch(patchedSource)!==patchedSource)throw Error(`Incomplete reasoning disclosure result in ${copy.assetName}`);
    return {assetName:copy.assetName,source:copy.source,patchedSource};
  });
  const changed=edits.map(edit=>edit.source!==edit.patchedSource);
  if(changed.some(Boolean)&&!changed.every(Boolean))throw Error("Partially applied reasoning disclosure copies");
  return {matched:copies.length,...commitAssetEdits(assets,edits),reason:`Reasoning disclosure module ${copies[0].moduleId}: ${copies.length} copies`};
}

const expandedDescriptor = {
  id: "expanded",
  phase: "extracted-app:pre-webview",
  order: 20_746,
  ciPolicy: "optional",
  assetNeedles: ['key:"reasoning-markdown"'],
  assetMatch: source => source.includes('key:"reasoning-markdown"') || source.includes(STATE_MARKER) || source.includes(BODY_MARKER),
  missingDescription: "current reasoning markdown native disclosure component",
  apply: patchExpandedAssets,
};

module.exports = { reasoningComponent, expandedState, applyExpandedPatch, patchExpandedAssets, expandedDescriptor };
