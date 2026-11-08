"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Default=require('./upstream-default-selection.js'),{findSynchronousFunctionDeclaration}=require('./synchronous-function-declaration.js'),{assertCriticalLoaderMethodUses}=require('./critical-loader-authority.js');
const owner=require('./fixtures/current-default-selection.json'),predicate=require('./fixtures/current-default-model-predicate.json'),catalog=require('./fixtures/current-chatgpt-catalog.json'),Policy=require('./catalog-policy.js'),Authority=require('./native-catalog-authority.js');
const facts=Default.inspectUpstreamDefaultSelectionOwner(owner.moduleSource,owner),predicates={...facts.modelPredicate};
const changed=(input,moduleSource,params=input.params)=>({...input,params,moduleSource});
const valid=(source,input)=>assert.doesNotThrow(()=>new vm.Script(`"use strict";function nativeReview(${input.params.join(',')}){${source}}`));
function qualify(input,source){return input===predicate?Default.inspectModelPredicate(source,changed(input,source),predicates):Default.inspectUpstreamDefaultSelectionOwner(source,changed(input,source));}

test('review function-kind: Root async common/manual/normal/predicate declarations refuse',()=>{
 for(const [input,name]of [...Object.values(facts.builders).map(name=>[owner,name]),[predicate,'p']])for(const async of ['async ','async/*native comment*/']){
  const source=input.moduleSource.replace(`function ${name}(`,`${async}function ${name}(`);valid(source,input);assert.throws(()=>qualify(input,source),/Async.*not a synchronous contract/);
 }
});

test('review function-kind: actual current declarations, opaque comments and paired names hold',()=>{
 for(const name of Object.values(facts.builders)){
  const fn=findSynchronousFunctionDeclaration(owner.moduleSource,owner,name);assert.equal(fn.kind,'synchronous-declaration');assert.equal(owner.moduleSource.slice(fn.start,fn.end),fn.source);
  const source=owner.moduleSource.replace(`function ${name}(`,`/* async function ${name}(){} */function ${name}(`);assert.doesNotThrow(()=>qualify(owner,source));
 }
 const source=owner.moduleSource.replace(/\bu\b/gu,'nativeCommon')+';function local(u){u=foreign;return u}const opaque="async function nativeCommon(){}";';
 assert.equal(qualify(owner,source).builders.common,'nativeCommon');
 const pred=predicate.moduleSource.replace(/\bp\b/gu,'nativePredicate')+';function local(p){p=foreign;return p}';assert.doesNotThrow(()=>qualify(predicate,pred));
 const expression=owner.moduleSource.replace('function u(e,t,n){','const decoy=function u(e,t,n){').replace('powerSettings:n}}n.d','powerSettings:n}};n.d');valid(expression,owner);assert.throws(()=>qualify(owner,expression),/not a root declaration/);
});

test('review function-kind: only the selected native ordinary helper illustrates Promise mismatch',async()=>{
 const fn=findSynchronousFunctionDeclaration(owner.moduleSource,owner,facts.builders.normal),input=[{slug:'model-new',thinkingEffort:'standard'}];
 const sync=vm.runInNewContext(`(${fn.source})`),async=vm.runInNewContext(`(async ${fn.source})`);
 assert.equal(Array.isArray(sync(input,false)),true);const pending=async(input,false);assert.equal(Array.isArray(pending),false);assert.equal(typeof pending.then,'function');assert.deepEqual(JSON.parse(JSON.stringify(await pending)),JSON.parse(JSON.stringify(sync(input,false))));
});

test('review loader-method: Root pre-use n.n/n.d and static spellings refuse in actual owner/predicate',()=>{
 const targets=['n.n','n.d','\\u006e.n','n.\\u0064','n["n"]',"n['d']",'n["\\x6e"]','n /*critical*/ ["\\u0064"]'];
 for(const input of [owner,predicate])for(const target of targets){const source=`${target}=foreign;`+input.moduleSource;valid(source,input);assert.throws(()=>qualify(input,source),/critical loader method use/);}
});

test('review loader-method: canonical uses, local shadows, opaque/member keys and loader rename hold',()=>{
 for(const input of [owner,predicate]){
  const uses=assertCriticalLoaderMethodUses(input.moduleSource,input,{allowInterop:true});assert.equal(uses.length,2);assert.equal(Object.isFrozen(uses),true);assert.deepEqual(uses.map(x=>x.method).sort(),['d','n']);
  const source=input.moduleSource+';function local(n){n.n=foreign;n["d"]=foreign}const obj={n:{d:foreign}},opaque="n.n=foreign";obj.n.d=foreign;';assert.doesNotThrow(()=>qualify(input,source));
  const renamed=input.moduleSource.replace(/(?<![\w$.])n\b/gu,'loader'),snapshot=changed(input,renamed,['e','t','loader']);
  assert.doesNotThrow(()=>input===predicate?Default.inspectModelPredicate(renamed,snapshot,predicates):Default.inspectUpstreamDefaultSelectionOwner(renamed,snapshot));
 }
});

test('review loader-method: named catalog dependency critical uses compose with exact53 canonical data',()=>{
 const presets=[{modelSlug:'model-new',thinkingEffort:'extended',isDefault:true}],prepared=Policy.prepareCatalogFactory(catalog.moduleSource,catalog,presets,{},Authority);
 assert.equal(assertCriticalLoaderMethodUses(catalog.moduleSource,catalog,{allowInterop:true}).length,2);
 assert.equal(assertCriticalLoaderMethodUses(prepared.patchedSource,changed(catalog,prepared.patchedSource),{allowInterop:true}).length,2);
 const chunk=values=>'export const __webpack_modules__={'+values.map(x=>`${JSON.stringify(x.moduleId)}(${x.params}){${x.moduleSource}}`).join(',')+'};';
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'up54-review-')),assets=path.join(root,'webview/assets');fs.mkdirSync(assets,{recursive:true});
 try{
  const input=chunk([owner,predicate,changed(catalog,prepared.patchedSource)]),file=path.join(assets,'actual.js');fs.writeFileSync(file,input,{mode:0o640});
  assert.equal(Default.auditUpstreamDefaultSelection(root,presets).changed,0);assert.equal(fs.readFileSync(file,'utf8'),input);
  const bad=chunk([owner,predicate,changed(catalog,'n.d=foreign;'+catalog.moduleSource)]);fs.writeFileSync(file,bad);assert.throws(()=>Default.auditUpstreamDefaultSelection(root,presets));assert.equal(fs.readFileSync(file,'utf8'),bad);assert.equal(fs.statSync(file).mode&0o777,0o640);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('review function-kind: actual catalog resolver and collector inverse declarations are synchronous',()=>{
 const presets=[{modelSlug:'model-new',thinkingEffort:'extended',isDefault:true}],prepared=Policy.prepareCatalogFactory(catalog.moduleSource,catalog,presets,{},Authority);
 const {findRspackExportPublication}=require('../../scripts/patches/lib/rspack-export-publication.js');
 const refs=[prepared.proof.resolverExport,prepared.proof.collectorExport].map(key=>findRspackExportPublication(catalog,key).expression);
 const chunk=values=>'export const __webpack_modules__={'+values.map(x=>`${JSON.stringify(x.moduleId)}(${x.params}){${x.moduleSource}}`).join(',')+'};';
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'up54-catalog-kind-')),assets=path.join(root,'webview/assets');fs.mkdirSync(assets,{recursive:true});
 try{
  const file=path.join(assets,'actual.js');
  for(const body of [catalog.moduleSource,prepared.patchedSource]){const input=chunk([owner,predicate,changed(catalog,body)]);fs.writeFileSync(file,input,{mode:0o640});assert.equal(Default.auditUpstreamDefaultSelection(root,presets).changed,0);assert.equal(fs.readFileSync(file,'utf8'),input);}
  for(const name of refs){
   const source=catalog.moduleSource.replace(`function ${name}(`,`async function ${name}(`);assert.notEqual(source,catalog.moduleSource);valid(source,catalog);
   // The closed UP53 preparer is unchanged. This boundary is an UP54 audit.
   assert.doesNotThrow(()=>Policy.prepareCatalogFactory(source,changed(catalog,source),presets,{},Authority));
   const input=chunk([owner,predicate,changed(catalog,source)]);fs.writeFileSync(file,input);assert.throws(()=>Default.auditUpstreamDefaultSelection(root,presets));assert.equal(fs.readFileSync(file,'utf8'),input);assert.equal(fs.statSync(file).mode&0o777,0o640);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
