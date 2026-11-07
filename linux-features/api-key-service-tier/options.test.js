"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {Script}=require("node:vm"),test=require("node:test");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {applyFallbackFastTierPatch,applyFallbackFastTierModule:apply,patchApiKeyServiceTierFallback:patch,fallbackModuleState,applyApiKeyServiceTierResolverPatch,applyApiKeyServiceTierResolverModule,descriptors}=require("./patch.js");
const fixture=require("./fixtures/current-options.json").options,resolver=require("./fixtures/current-resolver.json").resolver;
const {createPatchReport,captureWarnings,enabledFeatureFailuresFromReport}=require("../../scripts/lib/patch-report.js");
const {applyExtractedAppPatchDescriptors,normalizePatchDescriptors}=require("../../scripts/patches/engine.js");
const source=fixture.source;
const snapshot=(text=source,params=fixture.params)=>({moduleSource:text,start:0,params});
const chunk=(text=source,id="optionsOwner",params=fixture.params)=>`export const __webpack_modules__={${id}(${params.join(",")}){${text}}};`;
const resolverChunk=(text=resolver.source,id="eWgO")=>chunk(text,id,resolver.params);
function app(files,run){
 const cache=path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),".cache"),"codex-desktop-dev");fs.mkdirSync(cache,{recursive:true});
 const root=fs.mkdtempSync(path.join(cache,"tier-options-")),dir=path.join(root,"webview","assets");fs.mkdirSync(dir,{recursive:true});
 try{for(const [name,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),text,{mode:0o640});}return run(root,dir,name=>fs.readFileSync(path.join(dir,name),"utf8"));}
 finally{fs.rmSync(root,{recursive:true,force:true});}
}
function productionReport(root){
 const report=createPatchReport();report.enabledFeatures=["api-key-service-tier"];
 const descriptor={...descriptors.find(d=>d.id==="api-key-service-tier-fallback"),featureId:"api-key-service-tier",sourceKind:"feature"};
 captureWarnings(()=>applyExtractedAppPatchDescriptors(root,normalizePatchDescriptors([descriptor]),{},report,descriptor.phase));return report;
}
// Reduced independent behavioral fixtures; no retained signed-package factory
// is evaluated. Production qualifier tests below inspect/parse its source only.
function syntheticOptions(){return 'let standard={description:"Default speed",iconKind:null,label:"Standard",speedMultiplier:null,tier:null,value:null};function options(e){return build(e?.model,e?.serviceTiers)}function build(model,tiers){return[standard,...(tiers??[]).map(tier=>{let kind=(0,classifier.kind)(tier.id,tier.name),speed="fast"===kind?1.5:null;return{description:function(e,t){switch((0,classifier.kind)(e?.id??null,e?.name)){case"fast":return"1.5x speed, increased usage";case"ultrafast":return e?.description||"Ultrafast";case null:return e?.description??"Default speed"}}(tier,speed),iconKind:kind,label:function(e){switch((0,classifier.kind)(e?.id??null,e?.name)){case"fast":return"Fast";case"ultrafast":return"Ultrafast";case null:return e?.name??"Standard"}}(tier),speedMultiplier:speed,tier:tier,value:tier.id}})]}';}
function syntheticResolver(){return 'let priority="priority",fast="fast";function classify(id,name){return id===fast||id===priority||name?.trim().toLowerCase()==="fast"?"fast":id==="ultrafast"?"ultrafast":null}function resolve(model,tier){return null==tier?null:tier===fast?findFast(model):model?.serviceTiers?.find(item=>item.id===tier)??null}function findFast(model){return model?.serviceTiers?.find(item=>"fast"===classify(item.id,item.name))??null}';}
test("options and request resolution agree on one synthetic Fast and retain provider tier precedence",()=>{
 const once=applyFallbackFastTierPatch(syntheticOptions());assert.notEqual(once,syntheticOptions());assert.equal(applyFallbackFastTierPatch(once),once);
 const classifier={kind:(id,name)=>id==="fast"||id==="priority"||name?.trim().toLowerCase()==="fast"?"fast":id==="ultrafast"?"ultrafast":null};
 const options=Function("classifier",once+";return options;")(classifier),resolve=Function(applyApiKeyServiceTierResolverPatch(syntheticResolver())+";return resolve;")();
 const target={model:"new-model",codexLinuxApiKeyServiceTierModel:true};
 const expected={description:"1.5x speed, increased usage",iconKind:"fast",label:"Fast",speedMultiplier:1.5,tier:{id:"fast",name:"Fast",description:"1.5x speed, increased usage"},value:"fast"};
 assert.deepEqual(options(target).slice(1),[expected]);assert.equal(resolve(target,expected.value)?.id,expected.value);
 assert.deepEqual(options({...target,serviceTiers:[]}).slice(1),[expected]);
 for(const model of [null,{}, {model:"other"},{...target,codexLinuxApiKeyServiceTierModel:false},{...target,codexLinuxApiKeyServiceTierModel:"true"}]){assert.deepEqual(options(model).map(x=>x.value),[null]);assert.equal(resolve(model,"fast"),null);}
 const priority={id:"priority",name:"Priority",description:"Provider fast"},custom={id:"provider",name:"Provider custom",description:"Provider description"},ultra={id:"ultrafast",name:"Ultrafast",description:"Provider ultra"};
 for(const marker of [true,false,undefined]){
  const model={model:"provider",codexLinuxApiKeyServiceTierModel:marker,serviceTiers:[priority,custom,ultra]};
  const result=options(model);assert.deepEqual(result.map(x=>x.value),[null,"priority","provider","ultrafast"]);assert.equal(result[1].tier,priority);assert.equal(result[2].tier,custom);assert.equal(result[2].description,custom.description);assert.equal(result[3].tier,ultra);assert.equal(resolve(model,"fast"),priority);
  assert.deepEqual(options({...model,serviceTiers:[custom]}).map(x=>x.value),[null,"provider"]);assert.equal(resolve({...model,serviceTiers:[custom]},"fast"),null);
 }
 // Repeated calls across model/identity changes have no cached synthetic tier.
 assert.deepEqual(options({...target,codexLinuxApiKeyServiceTierModel:false}).map(x=>x.value),[null]);assert.deepEqual(options(target).slice(1),[expected]);
});
test("retained current signed options factory has one exact canonical contribution and inverse",()=>{
 assert.equal(crypto.createHash("sha256").update(source).digest("hex"),fixture.bodySha256);
 assert.equal(fallbackModuleState(source,snapshot()).kind,"current");const patched=apply(source,snapshot());assert.notEqual(patched,source);assert.equal(fallbackModuleState(patched,snapshot(patched)).kind,"patched");assert.equal(apply(patched,snapshot(patched)),patched);
 const helper='/*codexLinuxApiKeyServiceTierOptions*/function codexLinuxApiKeyFastTier(e){return null==e||e.serviceTiers?.length||e.codexLinuxApiKeyServiceTierModel!==!0?null:{id:"fast",name:"Fast",description:"1.5x speed, increased usage"}}';
 assert.equal(patched.replace(helper,"").replace('e?.serviceTiers?.length?e.serviceTiers:[codexLinuxApiKeyFastTier(e)].filter(Boolean)','e?.serviceTiers'),source);assert.doesNotThrow(()=>new Script(patched));
});
test("options follows renamed factory/local bindings and publication keys",()=>{
 const map={e:"input",t:"second",n:"loader",r:"resolver",i:"messages",a:"defaultTier",s:"labels",o:"standard",l:"buildOptions"};
 const lexical=createJavaScriptLexicalIndex(source);
 const renamed=source.replace(/\b[etnriasol]\b/gu,(x,at)=>lexical.isCode(at)?map[x]:x).replace('HN:','options:').replace('Ej:','build:');
 const params=fixture.params.map(x=>map[x]),once=apply(renamed,snapshot(renamed,params));assert.equal(apply(once,snapshot(once,params)),once);
});
test("options rejects opaque, wrong imports/publications, shadowed flow, partial and noncanonical contributions",()=>{
 const patched=apply(source,snapshot());
 for(const text of [source+source,`/*${source}*/`,`const example=${JSON.stringify(source)};`,source.replace('n.d(t,','n.d(other,'),source.replace('n.d(t,','other.d(t,'),source.replace('i=n("Qgfj")','i=foreign'),source.replace('function l(e,t)','function l(o,t)'),source.replace('function l(e,t)','function l(r,t)'),source.replace('function l(e,t)','function l(s,t)'),source.replace('let t=(0,r.Pg)','let r=(0,r.Pg)'),source.replace('function(e){return l(e?.model,e?.serviceTiers)}','function(l){return l(l?.model,l?.serviceTiers)}'),source.replace('function(e){return l(e?.model,e?.serviceTiers)}','function(codexLinuxApiKeyFastTier){return l(codexLinuxApiKeyFastTier?.model,codexLinuxApiKeyFastTier?.serviceTiers)}'),source.replace('Ej:l','Ej:r'),source.replace('tier:e,value:e.id','tier:e,value:other.id'),source.replace('e?.model,e?.serviceTiers','other?.model,e?.serviceTiers'),source+';l=foreign;',patched.replace('1.5x speed, increased usage"}}','2x speed"}}'),patched.replace('/*codexLinuxApiKeyServiceTierOptions*/',''),patched+'/*codexLinuxApiKeyServiceTierOptions*/',patched.replace('[codexLinuxApiKeyFastTier(e)]','[codexLinuxApiKeyFastTier(other)]')]){
  assert.equal(fallbackModuleState(text,snapshot(text)).kind,"missing");assert.throws(()=>apply(text,snapshot(text)),/options factory/);
 }
});
test("fallback Boolean filtering cannot be shadowed by wrapper, factory or root bindings",()=>{
 const lexical=createJavaScriptLexicalIndex(source);
 const rename=name=>source.replace(new RegExp(`\\b${name}\\b`,"gu"),(value,offset)=>lexical.isCode(offset)?"Boolean":value);
 const wrapper=source.replace('HN:function(e){return l(e?.model,e?.serviceTiers)}','HN:function(Boolean){return l(Boolean?.model,Boolean?.serviceTiers)}');
 assert.equal(fallbackModuleState(wrapper,snapshot(wrapper)).kind,"missing");assert.throws(()=>apply(wrapper,snapshot(wrapper)),/options factory/);
 const unusedFactoryParam=["Boolean",...fixture.params.slice(1)];
 assert.equal(fallbackModuleState(source,snapshot(source,unusedFactoryParam)).kind,"missing");assert.throws(()=>apply(source,snapshot(source,unusedFactoryParam)),/options factory/);
 for(const name of fixture.params){
  const text=rename(name),params=fixture.params.map(param=>param===name?"Boolean":param);
  assert.equal(fallbackModuleState(text,snapshot(text,params)).kind,"missing",name);assert.throws(()=>apply(text,snapshot(text,params)),/options factory/);
 }
 for(const name of ["r","i","a","s","o","l"]){
  const text=rename(name);
  assert.equal(fallbackModuleState(text,snapshot(text)).kind,"missing",name);assert.throws(()=>apply(text,snapshot(text)),/options factory/);
 }
});
test("options transaction binds the actual resolver exports and all physical copies",()=>{
 const chunks={"a.js":chunk(),"nested/b.js":chunk(),"resolver.js":resolverChunk()};
 app(chunks,(root,dir,read)=>{
  const first=productionReport(root);assert.equal(first.patches[0].status,"applied");assert.deepEqual(enabledFeatureFailuresFromReport(first),[]);assert.equal(read("a.js"),chunk(apply(source,snapshot())));assert.equal(read("nested/b.js"),read("a.js"));assert.equal(read("resolver.js"),chunks["resolver.js"]);
  const repeat=productionReport(root);assert.equal(repeat.patches[0].status,"already-applied");assert.deepEqual(enabledFeatureFailuresFromReport(repeat),[]);for(const name of Object.keys(chunks))assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o640);
 });
 // UP47 may have already committed its own synthetic resolver contribution.
 app({"options.js":chunk(),"resolver.js":resolverChunk(applyApiKeyServiceTierResolverModule(resolver.source,{moduleSource:resolver.source,start:0,params:resolver.params}))},root=>assert.equal(patch(root).changed,1));
});
test("missing, damaged, hidden, mixed and orphan options cohorts refuse all writes",()=>{
 const pristine=chunk(),patched=chunk(apply(source,snapshot()));
 const scenarios=[{}, {"a.js":pristine,"b.js":chunk(source,"differentOwner")},{"a.js":pristine,"b.js":patched},{"a.js":pristine,"hidden/b.js":chunk('const lostEveryNeedle=true;')},{"a.js":pristine,"b.js":chunk(source.replace('value:e.id','value:wrong.id'))},{"a.js":pristine,"orphan.js":'export const marker="codexLinuxApiKeyServiceTierOptions";'},{"a.js":pristine+'/*codexLinuxApiKeyServiceTierOptions*/'},{"a.js":'const example=`'+pristine+'`;'},{"a.js":'/*'+pristine+'*/'}];
 for(const files of scenarios)app({...files,"resolver.js":resolverChunk()},(root,dir,read)=>{let writes=0;assert.throws(()=>patch(root,{writeFileSync(){writes++;}}));assert.equal(writes,0);const report=productionReport(root);assert.equal(enabledFeatureFailuresFromReport(report).length,1);for(const [name,text]of Object.entries(files))assert.equal(read(name),text);});
});
test("wrong or damaged resolver dependencies refuse options without writing",()=>{
 for(const files of [
  {"a.js":chunk(source.replace('r=n("eWgO")','r=n("foreign")')),"resolver.js":resolverChunk()},
  {"a.js":chunk(source.replaceAll('r.Pg','r.foreign')),"resolver.js":resolverChunk()},
  {"a.js":chunk(),"resolver.js":resolverChunk(resolver.source.replace('supportsIndependentSpeedModes','unknown'))},
  {"a.js":chunk(),"resolver.js":resolverChunk(),"hidden/other.js":resolverChunk('const lostEveryNeedle=true;')},
  {"a.js":chunk(),"resolver.js":resolverChunk(),"hidden/other.js":resolverChunk(applyApiKeyServiceTierResolverModule(resolver.source,{moduleSource:resolver.source,start:0,params:resolver.params}))},
  {"a.js":chunk()},
 ])app(files,(root,dir,read)=>{let writes=0;assert.throws(()=>patch(root,{writeFileSync(){writes++;}}));assert.equal(writes,0);for(const [name,text]of Object.entries(files))assert.equal(read(name),text);});
});
test("a partial second options write restores every byte and mode; failed rollback is fatal",()=>{
 const files={"a.js":chunk(),"b.js":chunk(),"resolver.js":resolverChunk()};
 app(files,(root,dir,read)=>{let calls=0;assert.throws(()=>patch(root,{writeFileSync(file,bytes){if(++calls===2){fs.writeFileSync(file,bytes.subarray(0,13));throw Error("UP48 partial write");}fs.writeFileSync(file,bytes);}}),/UP48 partial write/);for(const [name,text]of Object.entries(files)){assert.equal(read(name),text);assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o640);}});
 app(files,root=>{let calls=0;assert.throws(()=>patch(root,{writeFileSync(file,bytes){if(++calls===1)fs.writeFileSync(file,bytes);else throw Error("disk fault");}}),error=>error.name==="PatchIntegrityError"&&/restore original bytes/.test(error.message));});
});
