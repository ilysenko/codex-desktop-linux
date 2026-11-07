"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"), os=require("node:os"),path=require("node:path");
const test=require("node:test");
const {applyApiKeyServiceTierResolverModule:apply,patchApiKeyServiceTierResolver:patch,resolverModuleState,descriptors}=require("./patch.js");
const fixture=require("./fixtures/current-resolver.json").resolver;
const source=fixture.source;
const snapshot=(text=source,params=fixture.params)=>({moduleSource:text,start:0,params});
const chunk=(text=source,id="renamedOwner")=>`export const __webpack_modules__={${id}(e,t,n){${text}}};`;
function app(chunks,fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),"tier-resolver-"));const dir=path.join(root,"webview","assets");fs.mkdirSync(dir,{recursive:true});try{for(const [name,text]of Object.entries(chunks)){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),text);}return fn(root,dir);}finally{fs.rmSync(root,{recursive:true,force:true});}}
function exportsOf(text){let out;Function("n","t",text)({d:(_,a,b)=>{out=b}},{});return out;}
test("current resolver factory preserves provider tiers and sends synthetic Fast ids",()=>{
 const patched=apply(source,snapshot());assert.notEqual(patched,source);assert.equal(apply(patched,snapshot(patched)),patched);
 const api=exportsOf(patched),empty={model:"model-A",codexLinuxApiKeyServiceTierModel:true};
 assert.equal(api.DS(empty,"fast"),"fast");assert.equal(api.E_(empty,"fast"),"fast");assert.equal(api.E_(empty,"fast",{fast:false}),null);assert.equal(api.Pd(empty,"fast"),true);
 for(const model of [null,{}, {codexLinuxApiKeyServiceTierModel:false},{codexLinuxApiKeyServiceTierModel:"true"}])assert.equal(api.DS(model,"fast"),null);
 const priority={id:"priority",name:"Priority"},custom={id:"custom",name:"Provider custom"};
 const provider={...empty,serviceTiers:[priority,custom]};assert.equal(api.L9(provider),priority);assert.equal(api.DS(provider,"fast"),"priority");assert.equal(api.DS(provider,"custom"),"custom");assert.equal(api.DS(provider,"missing"),null);
 assert.equal(api.DS({...empty,serviceTiers:[custom]},"fast"),null);assert.equal(api.DS({...empty,serviceTiers:[]},"fast"),"fast");
 assert.equal(api.DS(empty,null),null);assert.equal(api.DS(empty,"ultrafast"),null);assert.equal(api.E_({...empty,defaultServiceTier:"fast"},null),"fast");
 assert.deepEqual(api.W6({requirements:{featureRequirements:{fast_mode:false}},supportsIndependentSpeedModes:true}),{fast:false,ultrafast:true});
 assert.equal(patched.replace('function codexLinuxApiKeyFastTier(e){return null==e||e.serviceTiers?.length||e.codexLinuxApiKeyServiceTierModel!==!0?null:{id:"fast",name:"Fast",description:"1.5x speed, increased usage"}}','').replace('?u(e)??codexLinuxApiKeyFastTier(e):','?u(e):'),source);
});
test("resolver qualifier rejects opaque, unpublished, shadowed and noncanonical factories",()=>{
 const patched=apply(source,snapshot());
 for(const text of [source+source,`/*${source}*/`,`const opaque=${JSON.stringify(source)};`,source.replace('n.d(t,','n.d(other,'),source.replace('n.d(t,','foreign.d(t,'),source.replace('a="fast"','a="priority"'),source.replace('t===a?u(e)','t===a?foreign(e)'),source.replace('function c(e,t)','function c(s,t)'),source.replace('function s(e,t)','function s(a,t)'),source.replace('e=>e.id===t','t=>t.id===t'),source.replace('L9:u','L9:c'),source+';s=foreign;',patched+'/*codexLinuxApiKeyFastTier*/',patched.replace('1.5x speed','2x speed'),patched.replace('??codexLinuxApiKeyFastTier(e)',''),patched.replace('function codexLinuxApiKeyFastTier','function otherHelper')]) {
  assert.equal(resolverModuleState(text,snapshot(text)).kind,"missing");assert.throws(()=>apply(text,snapshot(text)),/resolver factory/);
 }
});
test("resolver follows renamed factory bindings and publication keys",()=>{
 const map={r:"priorityId",a:"fastId",i:"standardId",o:"allowed",l:"classify",s:"resolve",u:"findFast",c:"requestId",e:"modelArg",t:"tierArg",n:"loader"};
 const renamed=source.replace(/\b[raiolsucetn]\b/gu,x=>map[x]??x).replace('DS:','request:').replace('L9:','find:');
 const params=fixture.params.map(x=>map[x]);const once=apply(renamed,snapshot(renamed,params));assert.equal(apply(once,snapshot(once,params)),once);
});
test("resolver descriptor commits every physical copy and rejects damaged hidden or mixed copies",()=>{
 assert.equal(descriptors.find(d=>d.id==="api-key-service-tier-resolver").phase,"extracted-app:pre-webview");
 app({"a.js":chunk(),"nested/b.js":chunk()},(root,dir)=>{fs.chmodSync(path.join(dir,"a.js"),0o640);assert.equal(patch(root).changed,2);assert.equal(patch(root).changed,0);assert.equal(fs.statSync(path.join(dir,"a.js")).mode&0o777,0o640);});
 for(const bad of [source.replace('supportsIndependentSpeedModes','unknownCapability'),apply(source,snapshot()),'const drifted=true;'])app({"a.js":chunk(),"hidden/b.js":chunk(bad)},(root,dir)=>{const before=fs.readFileSync(path.join(dir,"a.js"));assert.throws(()=>patch(root),/resolver factory|Partially applied/);assert.deepEqual(fs.readFileSync(path.join(dir,"a.js")),before);});
 app({"a.js":chunk(),"b.js":chunk(source,"differentIdentity")},root=>assert.throws(()=>patch(root),/multiple/));
 app({"a.js":`/*${chunk()}*/`},root=>assert.throws(()=>patch(root),/Could not find/));
});
test("resolver transaction restores a partial second write and propagates rollback integrity failure",()=>{
 app({"a.js":chunk(),"b.js":chunk()},(root,dir)=>{let calls=0;assert.throws(()=>patch(root,{writeFileSync(file,bytes){calls++;if(calls===2){fs.writeFileSync(file,bytes.subarray(0,10));throw Error("partial write");}fs.writeFileSync(file,bytes);}}),/partial write/);for(const name of ["a.js","b.js"])assert.equal(fs.readFileSync(path.join(dir,name),"utf8"),chunk());});
 app({"a.js":chunk(),"b.js":chunk()},root=>{let calls=0;assert.throws(()=>patch(root,{writeFileSync(file,bytes){if(++calls===1)fs.writeFileSync(file,bytes);else throw Error("disk fault");}}),/rollback could not restore/);});
});

test("introduced resolver helper cannot collide with factory or resolver parameters",()=>{
 for(const text of [source.replace('function s(e,t){return null==t?null:t===a?u(e):e?.serviceTiers?.find(e=>e.id===t)??null}', 'function s(codexLinuxApiKeyFastTier,t){return null==t?null:t===a?u(codexLinuxApiKeyFastTier):codexLinuxApiKeyFastTier?.serviceTiers?.find(e=>e.id===t)??null}'),source.replace('function s(e,t){return null==t?null:t===a?u(e):e?.serviceTiers?.find(e=>e.id===t)??null}', 'function s(e,codexLinuxApiKeyFastTier){return null==codexLinuxApiKeyFastTier?null:codexLinuxApiKeyFastTier===a?u(e):e?.serviceTiers?.find(e=>e.id===codexLinuxApiKeyFastTier)??null}')])assert.throws(()=>apply(text,snapshot(text)),/resolver factory/);
 for(const index of [0,1,2]){const params=[...fixture.params];const before=params[index];params[index]='codexLinuxApiKeyFastTier';const text=index===1?source.replace('n.d(t,','n.d(codexLinuxApiKeyFastTier,'):index===2?source.replace('n.d(t,','codexLinuxApiKeyFastTier.d(t,'):source;assert.throws(()=>apply(text,snapshot(text,params)),/resolver factory/);}
});
