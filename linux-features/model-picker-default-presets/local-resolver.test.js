"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),vm=require("node:vm"),crypto=require("node:crypto");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const current=require("./fixtures/current-local-resolver.json"),dependency=require("./fixtures/current-local-resolver-dependencies.json");
const {MARKER,nativeLocalResolverOwner,localResolverState,applyLocalResolver,patchLocalResolver}=require("./local-resolver.js");
const source=current.moduleSource,hash=value=>crypto.createHash("sha256").update(value).digest("hex"),plain=value=>JSON.parse(JSON.stringify(value));
const chunk=owners=>"export const __webpack_modules__={"+owners.map(owner=>`${JSON.stringify(owner.moduleId)}(${owner.params}){${owner.moduleSource}}`).join(",")+"};";
function files(overrides={}){return{"resolver.js":chunk([{...current,moduleSource:overrides.TWUU??source}]),"predicate.js":chunk([{...dependency.owners.FQih,moduleSource:overrides.FQih??dependency.owners.FQih.moduleSource}]),"formatter.js":chunk([{...dependency.owners.O5Ra,moduleSource:overrides.O5Ra??dependency.owners.O5Ra.moduleSource}])}}
function app(input,fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),"local-default-resolver-")),assets=path.join(root,"webview","assets");fs.mkdirSync(assets,{recursive:true});try{for(const[name,bytes]of Object.entries(input)){fs.mkdirSync(path.dirname(path.join(assets,name)),{recursive:true});fs.writeFileSync(path.join(assets,name),bytes)}return fn(root,assets)}finally{fs.rmSync(root,{recursive:true,force:true})}}
function unchanged(assets,input){for(const[name,bytes]of Object.entries(input))assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),bytes,name)}

function resolver(body=source){
 const state=localResolverState(body,{...current,moduleSource:body});assert.notEqual(state.kind,"missing",state.reason);const owner=state.owner;
 const formatterOwner=dependency.owners.O5Ra,predicateOwner=dependency.owners.FQih;
 const published=(record,key)=>{const pub=findRspackExportPublication(record,key);assert(pub?.fn);return record.moduleSource.slice(pub.fn.start,pub.fn.end)};
 const context=vm.createContext({});
 const format=new vm.Script(`(${published(formatterOwner,owner.imports.formatter.exportName)})`).runInContext(context),predicate=new vm.Script(`(${published(predicateOwner,owner.imports.predicate.exportName)})`).runInContext(context);
 context[owner.imports.formatter.localName]={[owner.imports.formatter.exportName]:format};context[owner.imports.predicate.localName]={[owner.imports.predicate.exportName]:predicate};
 // This explicit stub models the native unchanged uniqBy consumer contract;
 // vendor i5ac code and upstream module factories are never executed here.
 context[owner.groups.unique]=()=>(values,key)=>{const seen=new Set;return values.filter(value=>{const id=key(value);if(seen.has(id))return false;seen.add(id);return true})};
 for(const [name,array]of [[owner.groups.fallbackA,owner.first],[owner.groups.fallbackB,owner.second]])context[name]=array.entries.map(({id,model,label,effort})=>({id,model,modelLabel:label,reasoningEffort:effort}));
 new vm.Script(owner.normalizer.source+owner.intersection.source).runInContext(context);
 const pub=findRspackExportPublication({...current,moduleSource:body},owner.key);assert(pub?.fn);
 return new vm.Script(`(${body.slice(pub.fn.start,pub.fn.end)})`).runInContext(context);
}
const model=(name,efforts=["low","medium","high","xhigh","ultra"])=>({model:name,displayName:`gpt-${name}`,supportedReasoningEfforts:efforts.map(reasoningEffort=>({reasoningEffort}))});
const config=(pairs,flag=true)=>({codexLinuxDefaultPresets:flag,presets:[pairs.map(([model,reasoning_effort])=>({model,reasoning_effort}))]});

test("current signed resolver qualifies its complete native chain and changes only one flagged config threshold",()=>{
 assert.equal(hash(source),current.bodySha256);const before=nativeLocalResolverOwner(source,current),patched=applyLocalResolver(source,current),state=localResolverState(patched,current);
 assert.equal(state.kind,"patched");assert.equal(state.native,source);assert.equal(applyLocalResolver(patched,current),patched);assert.equal(before.proof.nativePairIntersection,true);
 assert.equal((patched.match(new RegExp(MARKER,"gu"))??[]).length,1);assert.equal((patched.match(/codexLinuxIsConfiguredDefaultPresets\?1:3/gu)??[]).length,1);
 for(const key of ["CT","GA","Pd","Z0","cp","ig"]){const left=findRspackExportPublication(current,key),right=findRspackExportPublication({...current,moduleSource:patched},key);assert.equal(right?.expression,left?.expression,key);if(left?.fn)assert.equal(patched.slice(right.fn.start,right.fn.end),source.slice(left.fn.start,left.fn.end),key)}
});
test("one through large marked lists retain native eligible pairs in configured order without truncation",()=>{
 const run=resolver(applyLocalResolver(source,current));for(const count of [1,2,4,40]){const models=Array.from({length:count},(_,i)=>model(`custom${i}`)),pairs=models.map(value=>[value.model,"high"]),result=run(models,{sliderModelsConfig:config(pairs)});assert.deepEqual(plain(result.map(value=>value.id)),pairs.map(([name,effort])=>`${name}:${effort}`));assert.deepEqual(plain(result.map(value=>value.powerSettingIndex)),Array.from({length:count},(_,i)=>i))}
});
test("native exact model and effort filtering removes unknown pairs and stable uniqBy keeps first native index",()=>{
 const run=resolver(applyLocalResolver(source,current)),models=[model("custom")],pairs=[["missing","medium"],["custom","unknown"],["custom","high"],["custom","high"],["custom","low"]],result=run(models,{sliderModelsConfig:config(pairs)});
 assert.deepEqual(plain(result.map(value=>[value.id,value.powerSettingIndex])),[["custom:high",0],["custom:low",2]]);
 for(const efforts of [[],["unknown"],["persistent"]])assert.deepEqual(plain(run([model("custom",efforts)],{sliderModelsConfig:config([["custom","medium"]])})),[]);
});
test("removeXHigh retains the exact native treatment of xhigh, max and ultra",()=>{
 const run=resolver(applyLocalResolver(source,current)),models=[model("custom",["xhigh","max","ultra"])],settings=config([["custom","xhigh"],["custom","max"],["custom","ultra"]]);
 assert.deepEqual(plain(run(models,{sliderModelsConfig:settings,removeXHigh:true}).map(value=>value.id)),["custom:max","custom:ultra"]);
 assert.deepEqual(plain(run(models,{sliderModelsConfig:settings,removeXHigh:false}).map(value=>value.id)),["custom:xhigh","custom:max","custom:ultra"]);
});
test("unmarked configurations, false flags and empty or unavailable marked presets retain native fallback",()=>{
 const native=resolver(),patched=resolver(applyLocalResolver(source,current)),models=[model("gpt-5.6-sol"),model("gpt-5.6-terra")];
 for(const options of [{},{sliderModelsConfig:null},...[[["custom","high"]],[]].flatMap(pairs=>[false,null,undefined,1].map(flag=>({sliderModelsConfig:config(pairs,flag)}))),{sliderModelsConfig:config([])},{sliderModelsConfig:config([["missing","high"]])}])assert.deepEqual(plain(patched(models,options)),plain(native(models,options)));
 const cfg=config([["gpt-5.6-sol","high"]]);assert.equal(native(models,{sliderModelsConfig:cfg})[0].id,"gpt-5.6-terra:low");assert.deepEqual(plain(patched(models,{sliderModelsConfig:cfg}).map(value=>value.id)),["gpt-5.6-sol:high"]);
});
test("native label formatter, none effort and quote or brace bearing model names remain native data",()=>{
 const native=resolver(),patched=resolver(applyLocalResolver(source,current));for(const name of ['gpt-new','quote"braces} /[x]/','`${literal}`']){const models=[model(name,["none","low","medium"])],pairs=[[name,"none"],[name,"low"],[name,"medium"]],options={sliderModelsConfig:config(pairs),stripGptPrefix:false};assert.deepEqual(plain(patched(models,options)),plain(native(models,options)));assert.equal(patched(models,{sliderModelsConfig:config([[name,"none"]])})[0].reasoningEffort,"none")}
});
test("original factory authority refuses captured alias, Unicode, compact rest and object division writes",()=>{
 for(const code of [';([...n]=foreign);',';({...t}=foreign);',';([...\\u006e]=foreign);',';const hidden={} / (n=foreign) / 1;',';if(true){d=foreign}',';(()=>{h=foreign})()',';if(true){i=foreign}',';if(true){l=[]}',';if(true){u=[]}',';if(true){a=foreign}',';if(true){s=foreign}'])assert.throws(()=>applyLocalResolver(source+code,current),/factory/);
 for(const code of [';function unrelated(...n){n=foreign}',';function unrelated(){let d;d=foreign}',';{let s;s=foreign}',';const unrelated={d:1,h:2};unrelated.d=3;',';const unrelated="n=foreign;d=foreign";'])assert.equal(localResolverState(source+code,current).kind,"native",code);
});
test("known direct critical loader rewrites reject before interop or publication while local shadows remain native",()=>{
 for(const prefix of ['n.n=foreign;','n.d=foreign;',String.raw`\u006e.d=foreign;`,'n["n"]=foreign;'])assert.throws(()=>applyLocalResolver(prefix+source,current),/critical loader method use/);
 for(const write of ['n.n=foreign;','n.d=foreign;'])assert.throws(()=>applyLocalResolver(source.replace('function d(',write+'function d('),current),/critical loader method use/);
 for(const suffix of [';function unrelated(n){n.n=foreign;n.d=foreign}',';n.extra=foreign;',';const text="n.d=foreign";'])assert.equal(localResolverState(source+suffix,current).kind,"native");
});
test("native d/h are actual synchronous root declarations and public predicate or formatter cannot become async",()=>{
 const native=nativeLocalResolverOwner(source,current);
 for(const name of [native.groups.normalizer,native.groups.intersection]){
  for(const prefix of ['async ','async/*kind*/'])assert.throws(()=>applyLocalResolver(source.replace(`function ${name}(`,`${prefix}function ${name}(`),current),/synchronous|Async/);
  const range=name===native.groups.normalizer?native.normalizer:native.intersection,expression=source.slice(0,range.start)+`(${range.source});`+source.slice(range.end);assert.throws(()=>applyLocalResolver(expression,current),/root declaration/);
 }
 const renamed=source.replace('function d(','/* opaque async function d */function NormalizePairs(').replace('let a=d(e,','let a=NormalizePairs(e,');assert.equal(localResolverState(renamed,current).kind,"native");
 for(const [name,before,after]of [["FQih",'eE:function','eE:async function'],["O5Ra",'K:function','K:async function']])app(files({[name]:dependency.owners[name].moduleSource.replace(before,after)}),root=>assert.throws(()=>patchLocalResolver(root),/dependency/));
});
test("intersection formals cannot capture its imported formatter while clean formal renames remain native",()=>{
 const owner=nativeLocalResolverOwner(source,current),fn=owner.intersection.source;
 const mutations=[
  fn.replace('function h(e,t,n){return e.flatMap','function h(s,t,n){return s.flatMap'),
  fn.replace('function h(e,t,n)','function h(e,s,n)').replace('let i=t?.find','let i=s?.find'),
  fn.replace('function h(e,t,n)','function h(e,t,s)').replace('stripGptPrefix:n','stripGptPrefix:s'),
 ];
 for(const mutation of mutations){assert.notEqual(mutation,fn);const body=source.slice(0,owner.intersection.start)+mutation+source.slice(owner.intersection.end);assert.throws(()=>applyLocalResolver(body,current),/intersection formatter import/)}
 for(const renamed of [fn.replace('function h(e,t,n){return e.flatMap','function h(entriesInput,t,n){return entriesInput.flatMap'),fn.replace('function h(e,t,n)','function h(e,catalogRows,n)').replace('let i=t?.find','let i=catalogRows?.find'),fn.replace('function h(e,t,n)','function h(e,t,shouldStrip)').replace('stripGptPrefix:n','stripGptPrefix:shouldStrip')]){const body=source.slice(0,owner.intersection.start)+renamed+source.slice(owner.intersection.end);assert.equal(localResolverState(body,current).kind,"native");assert.equal(localResolverState(applyLocalResolver(body,current),current).native,body)}
});
test("complete owner and use site proof reject semantic drift and captured namespace lookalikes",()=>{
 for(const [before,after]of [['n.n(r)','n.n(a)'],['if(o.length>=3)return o','if(o.length>=4)return o'],['n.reasoningEffort===t','n.reasoningEffort!==t'],['supportedReasoningEfforts.some','supportedReasoningEfforts.every'],['powerSettingIndex:r','powerSettingIndex:0'],['function d(e,','function d(s,'],['function h(e,t,n)','function h(s,t,n)'],['removeXHigh:t=!1','removeXHigh:t=!0'],['return null==n?[]:[n]','return null==n?[]:[a[0]]']]){assert.notEqual(source.replace(before,after),source,before);assert.throws(()=>applyLocalResolver(source.replace(before,after),current),/factory/,before)}
});
test("canonical contribution rejects partial, duplicated, old helper and orphan states",()=>{
 const patched=applyLocalResolver(source,current);for(const candidate of [patched.replace('?1:3','?2:3'),patched.replace('?.codexLinuxDefaultPresets','?.foreignFlag'),patched+`/*${MARKER}*/`,patched.replace(`/*${MARKER}*/`,''),source+`const orphan="${MARKER}";`,patched.replace('let codexLinuxIsConfiguredDefaultPresets=','let foreign=')])assert.throws(()=>applyLocalResolver(candidate,current),/factory/);
});
test("all physical resolver copies and native dependencies commit once and replay with modes preserved",()=>{
 const input={...files(),"nested/copy.js":chunk([current])};app(input,(root,assets)=>{fs.chmodSync(path.join(assets,"resolver.js"),0o640);const first=patchLocalResolver(root),snap=fs.readFileSync(path.join(assets,"resolver.js"));assert.equal(first.matched,2);assert.equal(first.changed,2);assert.equal(first.dependencies.length,3);assert.equal(patchLocalResolver(root).changed,0);assert.deepEqual(fs.readFileSync(path.join(assets,"resolver.js")),snap);assert.equal(fs.statSync(path.join(assets,"resolver.js")).mode&0o777,0o640);for(const name of ["predicate.js","formatter.js"])assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),input[name])});
});
test("semantic owner and dependency discovery accepts renamed module ids and publication keys",()=>{
 const renamed=source.replace('Qv:function','OtherResolver:function').replace('a=n("FQih")','a=n("EffortDependency")').replace('s=n("O5Ra")','s=n("FormatDependency")').replaceAll('a.eE','a.OtherEffort').replaceAll('s.K','s.OtherLabel');
 const owners=[{...current,moduleId:"NativeModern",moduleSource:renamed},{...dependency.owners.FQih,moduleId:"EffortDependency",moduleSource:dependency.owners.FQih.moduleSource.replace('eE:function','OtherEffort:function')},{...dependency.owners.O5Ra,moduleId:"FormatDependency",moduleSource:dependency.owners.O5Ra.moduleSource.replace('K:function','OtherLabel:function')}];
 app({"renamed.js":chunk(owners)},root=>{const result=patchLocalResolver(root);assert.equal(result.moduleId,"NativeModern");assert.equal(result.dependencies[0].exportName,"OtherEffort");assert.equal(result.dependencies[1].exportName,"OtherLabel");assert.equal(patchLocalResolver(root).changed,0)});
});
test("main registered resolver descriptor uses the complete pre-webview seam and keeps empty config disabled",()=>{
 const descriptor=require("./patch.js").descriptors.find(value=>value.id.endsWith("-local-composer-resolver"));assert(descriptor);assert.equal(descriptor.phase,"extracted-app:pre-webview");assert.equal(descriptor.enabled({feature:{manifest:{presets:[]},settings:{}}}),false);assert.throws(()=>descriptor.enabled({feature:{settings:{presets:[]}}}),/at least one/);
 const context={feature:{settings:{presets:[{model:"custom",effort:"high",default:true}]}}};assert.equal(descriptor.enabled(context),true);app(files(),root=>{assert.equal(descriptor.apply(root,context).changed,1);assert.equal(descriptor.apply(root,context).changed,0)});
});
test("hidden damage, mixed copies, ambiguous identities, opaque registries and orphan markers refuse before writes",()=>{
 const patched=applyLocalResolver(source,current),base=files();for(const input of [{...base,"hidden.js":chunk([{...current,moduleSource:patched}])},{...base,"hidden.js":chunk([{...current,moduleSource:'const damaged=true;'}])},{...base,"foreign.js":chunk([{...current,moduleId:'differentOwner'}])},{...base,"resolver.js":`/*${base["resolver.js"]}*/`},{...base,"orphan.js":`const orphan="${MARKER}";`}])app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchLocalResolver(root,{writeFileSync(){writes++}}));assert.equal(writes,0);unchanged(assets,input)});
});
test("actual effort and formatter dependency imports, exports, all copies and original authority are required",()=>{
 for(const id of ["FQih","O5Ra"]){const currentDep=dependency.owners[id];for(const code of [';([...n]=foreign);',';({...t}=foreign);',';const hidden={} / (n=foreign) / 1;']){const input=files({[id]:currentDep.moduleSource+code});app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchLocalResolver(root,{writeFileSync(){writes++}}),/dependency/);assert.equal(writes,0);unchanged(assets,input)})}
 const input={...files(),"hidden.js":chunk([{...currentDep,moduleSource:'const damaged=true;'}])};app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchLocalResolver(root,{writeFileSync(){writes++}}));assert.equal(writes,0);unchanged(assets,input)})}
 for(const [name,before,after]of [["FQih",'eE:function','foreign:function'],["O5Ra",'K:function','foreign:function']]){const input=files({[name]:dependency.owners[name].moduleSource.replace(before,after)});app(input,root=>assert.throws(()=>patchLocalResolver(root),/dependency/))}
 const swapped=files({TWUU:source.replace('a=n("FQih")','a=n("foreign")')});app(swapped,root=>assert.throws(()=>patchLocalResolver(root),/dependency/));
});
test("partial later write restores every resolver asset and mode; unrestorable rollback remains fatal",()=>{
 const input={...files(),"copy.js":chunk([current])};app(input,(root,assets)=>{fs.chmodSync(path.join(assets,"resolver.js"),0o640);let calls=0;assert.throws(()=>patchLocalResolver(root,{writeFileSync(file,bytes){if(++calls===2){fs.writeFileSync(file,bytes.subarray(0,11));throw Error("partial device write")}fs.writeFileSync(file,bytes)}}),/partial device write/);unchanged(assets,input);assert.equal(fs.statSync(path.join(assets,"resolver.js")).mode&0o777,0o640)});
 app(input,root=>{let calls=0;assert.throws(()=>patchLocalResolver(root,{writeFileSync(file,bytes){if(++calls===1)fs.writeFileSync(file,bytes);else throw Error("device failure")}}),/rollback could not restore/)});
});
