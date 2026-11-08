"use strict";
const fs=require("node:fs"),path=require("node:path");
const shapes=require("./load-gate-shapes.js");
const {projectLoadGatePeer,prepareLoadGateBody,MARKER}=require("./load-gate-peer.js");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,rspackModuleFactories}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {listWebviewAssetFiles,patchWebviewAssets}=require("../../scripts/patches/lib/assets.js");
const IDENT="[A-Za-z_$][\\w$]*";
const FIXED=new Set(["async","await","for","of","var","let","const","function","return","if","else","new","typeof","void","null","true","false","Object","Array","Set","String","Symbol","navigator","undefined"]);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
function fail(reason){throw Error("Remote load gate: "+reason)}
function one(rows,reason){if(rows.length!==1)fail(reason);return rows[0]}
function normalized(snapshot, body = snapshot.moduleSource) {
  if (snapshot.params.length !== 3 || new Set(snapshot.params).size !== 3) fail("factory parameters");
  const lexical = createJavaScriptLexicalIndex(body), req = snapshot.params[2];
  const imports = [], edits = [];
  const pattern = new RegExp(`(?<![\\w$.])${escape(req)}\\(("(?:\\\\.|[^"\\\\])*")\\)`, "gu");
  for (const match of body.matchAll(pattern)) {
    if (!lexical.isRoot(match.index)) continue;
    const prefix = body.slice(0, match.index), local = prefix.match(new RegExp(`(${IDENT})=$`, "u"))?.[1];
    if (local != null) {
      const binding = findRspackRequireBinding({ ...snapshot, moduleSource: body }, local);
      if (binding == null || binding.moduleId !== JSON.parse(match[1])) fail("unbound or mutable import");
      imports.push({ local, moduleId: binding.moduleId });
    }
    const start = match.index + match[0].indexOf(match[1]);
    edits.push({ start, end: start + match[1].length, text: '"@import"' });
  }
  for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  const code = createJavaScriptLexicalIndex(body), names = new Map(snapshot.params.map((name, index) => [name, "$" + index]));
  let result = "", cursor = 0;
  for (const token of body.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const start = token.index, name = token[0];
    if (!code.isCode(start) || FIXED.has(name) || body[start - 1] === "." || /^\s*:/u.test(body.slice(start + name.length))) continue;
    if (!names.has(name)) names.set(name, "$" + names.size);
    result += body.slice(cursor, start) + names.get(name);
    cursor = start + name.length;
  }
  const renamed = result + body.slice(cursor);
  const renamedCode = createJavaScriptLexicalIndex(renamed);
  let text = "";
  for (let index = 0; index < renamed.length;) {
    if (renamedCode.isCode(index)) {
      text += renamed[index++];
      continue;
    }
    let end = index + 1;
    while (end < renamed.length && !renamedCode.isCode(end)) end++;
    const opaqueOrTrivia = renamed.slice(index, end);
    // The index also marks trivia non-code. Opaque runs and all line
    // terminators stay byte-for-byte. For spaces/tabs, preserve a separator
    // between word tokens and conservatively beside operator characters;
    // removing those could fuse keywords, identifiers or operators.
    if (!/^[ \t]+$/u.test(opaqueOrTrivia)) text += opaqueOrTrivia;
    else {
      const previous = renamed[index - 1] ?? "", next = renamed[end] ?? "";
      const wordBoundary = /[\w$]/u.test(previous) && /[\w$]/u.test(next);
      const operatorBoundary = /[+\-*/%&|^<>=!?~.]/u.test(previous + next);
      if (wordBoundary || operatorBoundary) text += " ";
    }
    index = end;
  }
  return { text, imports };
}

const ENTRY="codexLinuxRemoteConnectionsVisibility";
function projectEntryPeer(copy){
 let body=copy.moduleSource;
 if(!body.includes(ENTRY))return {moduleSource:body,active:false};
 if(body.split(ENTRY).length!==2)fail("orphan or duplicate entry contribution");
 const lexical=createJavaScriptLexicalIndex(body),calls=[...body.matchAll(new RegExp(`(${IDENT})\\((${IDENT})\\.JW,"4114442250"\\)`,"gu"))].filter(row=>lexical.isCode(row.index));
 const call=one(calls,"entry contribution has no unique native call")[0],canonical=`(${call}||typeof navigator!==\`undefined\`&&navigator.userAgent.includes(\`Linux\`))/*${ENTRY}*/`;
 if(body.split(canonical).length!==2)fail("noncanonical entry contribution");
 return {moduleSource:body.replace(canonical,call),active:true};
}
function ownerProof(copy){
 const inline=prepareLoadGateBody(copy),entry=projectEntryPeer({...copy,moduleSource:inline.nativeModuleSource});
 const actual=normalized(copy,entry.moduleSource),expected=normalized(shapes.owner);
 if(actual.text!==expected.text)fail("changed complete PIwo owner grammar");
 const snapshot={...copy,moduleSource:entry.moduleSource};
 for(const key of["bc","Ik","mC","mw"])if(!findRspackExportPublication(snapshot,key))fail("missing owner publication "+key);
 return {...actual,inline,entry:entry.active};
}
function calleeProof(copy){
 const actual=normalized(copy),expected=normalized(shapes.callee);
 if(actual.text!==expected.text)fail("changed complete hook callee grammar");
 const hook=findRspackExportPublication(copy,"Zj"),context=findRspackExportPublication(copy,"j3");
 if(!hook?.fn||hook.fn.name!==null||!hook.fn.params||!context)fail("missing native hook/context publication");
 return actual;
}
function captured(copy){
 const value={assetName:copy.assetName,source:copy.source,moduleId:copy.moduleId,moduleSource:copy.moduleSource,start:copy.start,end:copy.end,params:Array.isArray(copy.params)?[...copy.params]:null};
 if(typeof value.source!=="string"||typeof value.moduleSource!=="string"||typeof value.assetName!=="string"||!value.params||Buffer.byteLength(value.moduleSource)>16*1024||value.source.slice(value.start,value.end)!==value.moduleSource)fail("invalid or stale bounded snapshot");
 Object.freeze(value.params);return Object.freeze(value);
}
function prepareRemoteLoadGate(input){
 const cohort=Object.fromEntries(["owner","callee"].map(role=>[role,Array.isArray(input?.[role])?input[role].map(captured):[]]));
 const proofs={};
 for(const role of["owner","callee"]){const copies=cohort[role];if(!copies.length||new Set(copies.map(row=>row.moduleId)).size!==1||new Set(copies.map(row=>row.assetName)).size!==copies.length)fail("missing or ambiguous "+role+" cohort");proofs[role]=copies.map(copy=>role==="owner"?ownerProof(copy):calleeProof(copy));const ids=proofs[role][0].imports.map(row=>row.moduleId);if(proofs[role].some(proof=>JSON.stringify(proof.imports.map(row=>row.moduleId))!==JSON.stringify(ids)))fail("inconsistent physical "+role+" imports");}
 const first=proofs.owner[0],nativeHook=proofs.callee[0].imports;
 if(proofs.owner.some(proof=>proof.inline.active!==first.inline.active||proof.entry!==first.entry))fail("mixed physical contribution state");
 for(const owner of proofs.owner){if(owner.inline.binding.moduleId!==cohort.callee[0].moduleId||owner.imports[0].moduleId!==nativeHook[2].moduleId||owner.imports[5].moduleId!==nativeHook[4].moduleId)fail("owner does not bind the actual native hook/atom/gate providers");}
 const grouped=new Map();
 for(const[role,copies]of Object.entries(cohort))for(const[index,copy]of copies.entries()){
  const group=grouped.get(copy.assetName)??{assetName:copy.assetName,source:copy.source,changes:[],inverse:[]};if(group.source!==copy.source)fail("inconsistent source snapshots");
  if(role==="owner"){const proof=proofs.owner[index];group.changes.push({start:copy.start,end:copy.end,source:proof.inline.patchedModuleSource});group.inverse.push({start:copy.start,end:copy.end,source:proof.inline.nativeModuleSource});}grouped.set(copy.assetName,group);
 }
 function splice(source,edits){let next=source;for(const edit of edits.sort((a,b)=>b.start-a.start))next=next.slice(0,edit.start)+edit.source+next.slice(edit.end);return next;}
 const edits=[...grouped.values()].map(group=>({assetName:group.assetName,source:group.source,patchedSource:splice(group.source,[...group.changes]),nativeSource:splice(group.source,[...group.inverse])}));
 return {edits,alreadyApplied:first.inline.active,entryPeer:first.entry,moduleIds:{owner:cohort.owner[0].moduleId,callee:cohort.callee[0].moduleId},dependencyAssets:[...grouped.keys()].sort()};
}
function prepareRemoteLoadGateSource(source){
 const assetName="__source__.js",modules=[...rspackModuleFactories(source,assetName)];
 const owners=modules.filter(copy=>copy.moduleSource.includes("4114442250")&&copy.moduleSource.includes("mC:")).filter(copy=>{try{ownerProof(copy);return true}catch{return false}});
 const owner=one(owners,"missing or ambiguous current owner in String input"),proof=ownerProof(owner),callee=modules.filter(copy=>copy.moduleId===proof.inline.binding.moduleId);
 const prepared=prepareRemoteLoadGate({owner:[owner],callee});
 const markers=source.split(MARKER).length-1;if(markers!==(prepared.alreadyApplied?1:0))fail("orphan String input contribution marker");
 return {nativeSource:prepared.edits[0].nativeSource,patchedSource:prepared.edits[0].patchedSource,alreadyApplied:prepared.alreadyApplied,moduleIds:prepared.moduleIds};
}
function locateRemoteLoadGate(assets){
 const owner=findUniqueRspackModuleCopies(assets,{description:"current outbound Remote load gate",sourceMatch:source=>source.includes("4114442250")||source.includes(MARKER),matchModule:(body,copy)=>{if(!["bc:","Ik:","mC:"].every(word=>body.includes(word)))return false;try{ownerProof(copy);return true}catch{return false}}});
 const first=ownerProof(owner[0]),hookId=first.inline.binding.moduleId;
 const callee=findUniqueRspackModuleCopies(assets,{description:"native outbound Remote hook callee",sourceMatch:source=>source.includes(hookId),matchModule:(_body,copy)=>copy.moduleId===hookId});
 const prepared=prepareRemoteLoadGate({owner,callee});let markers=0;for(const name of listWebviewAssetFiles(assets,/\.js$/u))markers+=fs.readFileSync(path.join(assets,name),"utf8").split(MARKER).length-1;
 if(markers!==(prepared.alreadyApplied?owner.length:0))fail("orphan contribution marker outside the owner cohort");return prepared;
}
function applyRemoteLoadGate(extractedDir,options={}){const assets=path.join(extractedDir,"webview/assets"),prepared=locateRemoteLoadGate(assets);return{...patchWebviewAssets(assets,prepared.edits,options),matched:true,moduleIds:prepared.moduleIds};}
module.exports={prepareRemoteLoadGate,prepareRemoteLoadGateSource,locateRemoteLoadGate,applyRemoteLoadGate,inspectRemoteLoadGateOwner:ownerProof};
