"use strict";
const path=require("node:path");
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {findUniqueRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {commitAssetEdits}=require("../../scripts/patches/lib/asset-edits.js");
const {javascriptSourceParses}=require("../../scripts/patches/lib/javascript-syntax.js");
const MAX_FACTORY_BYTES=256*1024;

// Each adapter owns semantic inspection and exact source replay. This module
// owns physical discovery, joint state/marker checks, merging and one commit.
// prepare(source,snapshot) -> {state, nativeSource, patchedSource, proof?}.
// state is pristine or applied; no callback here may write files.
function patchCatalogCohorts(extractedDir,adapters,options={}) {
 if(!Array.isArray(adapters)||adapters.length===0||new Set(adapters.map(a=>a.id)).size!==adapters.length)throw TypeError("Expected distinct Default preset owner adapters");
 for(const adapter of adapters)if(typeof adapter.id!=="string"||typeof adapter.prepare!=="function"||typeof adapter.sourceMatch!=="function"||!Array.isArray(adapter.markers)||adapter.markers.some(m=>typeof m!=="string"||m.length===0))throw TypeError("Invalid Default preset owner adapter");
 const auditOnly=options.auditOnly===true;
 const assetsDir=path.join(extractedDir,"webview","assets"),markers=[...new Set(adapters.flatMap(a=>a.markers))],markedAssets=new Map(),registryProofs=new Map();
 function requireRegistry(source) {
  if(registryProofs.has(source))return;
  const headers=[...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];
  if(headers.length!==1||!createJavaScriptLexicalIndex(source.slice(0,headers[0].index+headers[0][0].length)).isRoot(headers[0].index))throw Error("Missing, ambiguous or opaque Default preset registry");
  registryProofs.set(source,true);
 }
 function prepare(adapter,source,snapshot) {
  if(Buffer.byteLength(source)>MAX_FACTORY_BYTES)throw Error(`Default preset factory exceeds ${MAX_FACTORY_BYTES} bytes`);
  const prepared=adapter.prepare(source,Object.freeze({...snapshot,params:Object.freeze([...snapshot.params]),moduleSource:source}));
  const result=prepared==null?null:{state:prepared.state,nativeSource:prepared.nativeSource,patchedSource:prepared.patchedSource,proof:prepared.proof};
  if(!result||!["pristine","applied"].includes(result.state)||typeof result.nativeSource!=="string"||typeof result.patchedSource!=="string")throw Error(`Invalid ${adapter.id} preparation result`);
  if(markers.some(marker=>result.nativeSource.includes(marker)))throw Error(`Orphan ${adapter.id} marker in native inverse`);
  if(result.state==="pristine"&&result.nativeSource!==source||result.state==="applied"&&result.patchedSource!==source)throw Error(`Noncanonical ${adapter.id} state`);
  return Object.freeze({state:result.state,nativeSource:result.nativeSource,patchedSource:result.patchedSource,proof:result.proof});
 }
 const groups=adapters.map(adapter=>{
  const copies=findUniqueRspackModuleCopies(assetsDir,{
   description:adapter.description??adapter.id,
   sourceMatch(source,name){if(markers.some(marker=>source.includes(marker)))markedAssets.set(name,source);return adapter.sourceMatch(source,name);},
   matchModule(source,snapshot){if(Buffer.byteLength(source)>MAX_FACTORY_BYTES)return false;try{requireRegistry(snapshot.source);prepare(adapter,source,snapshot);return true;}catch{return false;}},
  });
  const members=copies.map(snapshot=>{requireRegistry(snapshot.source);return{snapshot,prepared:prepare(adapter,snapshot.moduleSource,snapshot)}});
  return{id:adapter.id,moduleId:copies[0].moduleId,adapter,members};
 });
 if(new Set(groups.map(group=>group.moduleId)).size!==groups.length)throw Error("Default preset owner identities overlap");
 const members=groups.flatMap(group=>group.members.map(member=>({...member,adapter:group.adapter,owner:group.id}))),states=new Set(members.map(member=>member.prepared.state));
 if(states.size!==1)throw Error("Partially applied Default preset owner cohorts");
 if(auditOnly&&(!states.has("pristine")||members.some(m=>m.prepared.patchedSource!==m.snapshot.moduleSource)))throw Error("Default preset audit attempted a mutation");
 for(const member of members){const{adapter,snapshot,prepared}=member;
  const {nativeSource,patchedSource}=prepared;
  if(!auditOnly){
   if(prepared.state==="pristine"&&patchedSource===snapshot.moduleSource)throw Error(`Incomplete ${adapter.id} patch`);
   const repeated=prepare(adapter,patchedSource,snapshot),forward=prepare(adapter,nativeSource,snapshot);
   if(repeated.state!=="applied"||repeated.patchedSource!==patchedSource||repeated.nativeSource!==nativeSource||forward.state!=="pristine"||forward.patchedSource!==patchedSource)throw Error(`Incomplete ${adapter.id} canonical replay`);
  }
  try{new Script(`"use strict";(function(${snapshot.params.join(",")}){${patchedSource}})`);}catch{throw Error(`Invalid generated ${adapter.id} factory syntax`);}
 }
 // Joint census allows a shared private name in any qualified cohort member,
 // while strings/comments or unrelated modules outside them remain orphans.
 for(const [name,source]of markedAssets){const owned=members.filter(m=>m.snapshot.assetName===name);
  for(const marker of markers){const count=value=>value.split(marker).length-1;if(count(source)!==owned.reduce((sum,m)=>sum+count(m.snapshot.moduleSource),0))throw Error(`Orphan Default preset marker in ${name}`);}
 }
 const validationView=Object.freeze(groups.map(({id,moduleId,members})=>Object.freeze({id,moduleId,members:Object.freeze(members.map(({snapshot,prepared})=>Object.freeze({
  snapshot:Object.freeze({...snapshot,params:Object.freeze([...snapshot.params])}),
  prepared:Object.freeze({state:prepared.state,nativeSource:prepared.nativeSource,patchedSource:prepared.patchedSource,proof:prepared.proof}),
 })))})));
 const validated=options.validatePrepared?.(validationView);
 if(validated!=null&&typeof validated.then==="function")throw TypeError("Default preset validation must be synchronous");
 const assets=new Map();
 for(const{snapshot,prepared,owner}of members){const{assetName,source,start,end,moduleSource}=snapshot;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||source.slice(start,end)!==moduleSource)throw Error(`Invalid ${owner} source snapshot`);
  let asset=assets.get(assetName);if(!asset){asset={source,edits:[]};assets.set(assetName,asset);}else if(asset.source!==source)throw Error(`Default preset asset changed during discovery: ${assetName}`);
  asset.edits.push({start,end,patched:prepared.patchedSource});
 }
 const edits=[...assets].map(([assetName,asset])=>{
  let patchedSource=asset.source,last=asset.source.length;
  for(const edit of asset.edits.sort((a,b)=>b.start-a.start)){if(edit.end>last)throw Error(`Overlapping Default preset modules in ${assetName}`);patchedSource=patchedSource.slice(0,edit.start)+edit.patched+patchedSource.slice(edit.end);last=edit.start;}
  if(patchedSource!==asset.source&&!javascriptSourceParses(patchedSource))throw Error(`Invalid generated Default preset asset syntax: ${assetName}`);
  return{assetName,source:asset.source,patchedSource};
 });
 const expected=edits.filter(edit=>edit.source!==edit.patchedSource).length;
 if(auditOnly&&expected!==0)throw Error("Default preset audit attempted a final mutation");
 const result=commitAssetEdits(assetsDir,edits,options);
 if(result.changed!==expected)throw Error("Default preset transaction did not commit its complete prepared cohort");
 return{...result,matched:members.length,owners:groups.map(group=>({id:group.id,moduleId:group.moduleId,matched:group.members.length,state:group.members[0].prepared.state}))};
}
module.exports={patchCatalogCohorts};
