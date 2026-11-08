"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const fixture=require("./current-remote-load-gate.json");
const {rspackModuleFactories}=require("../../../scripts/patches/lib/rspack-module-assets.js");
const {findRspackExportPublication}=require("../../../scripts/patches/lib/rspack-export-publication.js");
function chunk(id,modules){return `export const __rspack_esm_ids=[${id}];export const __webpack_modules__={${modules}};`;}
function source(){return chunk(1,[fixture.owner,fixture.callee].map(row=>`${row.moduleId}(${row.params}){${row.moduleSource}}`).join(","));}
function sources(){return{"async/load-gate.js":source()};}
function snapshots(input=sources()){
 const modules=Object.entries(input).flatMap(([name,text])=>[...rspackModuleFactories(text,name)]);
 return {owner:modules.filter(row=>row.moduleId===fixture.owner.moduleId),callee:modules.filter(row=>row.moduleId===fixture.callee.moduleId)};
}
function applyEdits(input,plan,kind="patchedSource"){const result={...input};for(const edit of plan.edits)result[edit.assetName]=edit[kind];return result;}
function callMC(input,ua,value,throws=false){const copy=snapshots(input).owner[0],pub=findRspackExportPublication(copy,"mC"),calls=[],trace=[],binding=Object.fromEntries(copy.moduleSource.matchAll(/([A-Za-z_$][\w$]*)=\w+\("hZax"\)/gu).map(row=>[row[1],{Zj(gate){calls.push(gate);trace.push("native");if(throws)throw Error("native hook throw");return value}}]));const context={...binding};if(ua!==null)context.navigator={get userAgent(){trace.push("platform");return ua}};const fn=vm.runInNewContext(`(function(){${pub.fn.body}})`,context);let result,error;try{result=fn()}catch(e){error=e.message}return{calls,trace,result,error};}
function writeApp(root,input=sources()){const assets=path.join(root,"webview/assets");for(const[name,text]of Object.entries(input)){const file=path.join(assets,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text,{mode:0o640});}return assets;}
module.exports={fixture,chunk,source,sources,snapshots,applyEdits,callMC,writeApp};
