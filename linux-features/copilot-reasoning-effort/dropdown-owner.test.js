"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),crypto=require("node:crypto"),test=require("node:test"),{Script}=require("node:vm");
const {spawnSync}=require("node:child_process");
const {MARKER,dropdownModuleState,applyDropdownModule:apply,selectorModuleState,patchCopilotDropdown:patch}=require("./dropdown-owner.js");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {inspectModelSettingsOwner}=require("../../scripts/patches/lib/model-composer-owners.js");
const {applyExtractedAppPatchDescriptors,normalizePatchDescriptors}=require("../../scripts/patches/engine.js");
const {createPatchReport,captureWarnings,enabledFeatureFailuresFromReport}=require("../../scripts/lib/patch-report.js");
const fixture=require("./fixtures/current-dropdown.json"),current=require("../../scripts/patches/lib/fixtures/current-model-composer.json");
const composer=fixture.composer,selector=fixture.selector;
const snap=(source=composer.source,params=composer.params)=>({moduleSource:source,start:0,params});
const selectorSnap=(source=selector.source,params=selector.params)=>snap(source,params);
const sha=text=>crypto.createHash("sha256").update(text).digest("hex");
const chunk=(text,id="dropdownOwner",params=composer.params)=>`export const __webpack_modules__={${id}(${params.join(",")}){${text}}};`;
const selectorChunk=(text=selector.source,id="sU9s")=>chunk(text,id,selector.params);
const settingsChunk=(text=current.settings.moduleSource,id="o8WW")=>chunk(text,id,current.settings.params);
const settingsState=(source,module)=>{const owner=inspectModelSettingsOwner({...module,moduleSource:source});return owner.ok?{kind:"current",owner}:{kind:"missing"};};
function app(files,run){
 const cache=path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),".cache"),"codex-desktop-dev");fs.mkdirSync(cache,{recursive:true});const root=fs.mkdtempSync(path.join(cache,"copilot-dropdown-")),dir=path.join(root,"webview","assets");fs.mkdirSync(dir,{recursive:true});
 try{for(const [name,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),text,{mode:0o640});}return run(root,dir,name=>fs.readFileSync(path.join(dir,name),"utf8"));}finally{fs.rmSync(root,{recursive:true,force:true});}
}
function dependencyFiles(files){return {"selector.js":selectorChunk(),"settings.js":settingsChunk(),...files};}
function report(root){const result=createPatchReport();result.enabledFeatures=["copilot-reasoning-effort"];captureWarnings(()=>applyExtractedAppPatchDescriptors(root,normalizePatchDescriptors([{id:"ui-dropdown",phase:"extracted-app:pre-webview",ciPolicy:"optional",featureId:"copilot-reasoning-effort",sourceKind:"feature",apply:dir=>patch(dir,settingsState)}]),{},result,"extracted-app:pre-webview"));return result;}

// The mutation inventory creates many distinct V8 syntax-probe bodies.
// Run those cases sequentially in fresh processes so compiler state from one
// source variant cannot accumulate across the full feature test process.
const isolatedProofs=[];
function isolatedProof(source,params,kind,expected,roundTrip=false){
 const script=`const fs=require("node:fs"),assert=require("node:assert/strict");
const api=require(process.argv[1]),input=JSON.parse(fs.readFileSync(0,"utf8"));
const snapshot={moduleSource:input.source,params:input.params,start:0};
if(input.kind==="composer"){
 const state=api.dropdownModuleState(input.source,snapshot);assert.equal(state.kind,input.expected,state.reason);
 if(input.roundTrip){const patched=api.applyDropdownModule(input.source,snapshot);assert.equal(api.dropdownModuleState(patched,snapshot).kind,"patched");assert.equal(api.applyDropdownModule(patched,snapshot),patched);}
}else{const state=api.selectorModuleState(input.source,snapshot);assert.equal(state.ok,input.expected,state.reason);}
process.stdout.write(JSON.stringify({maxRssKiB:process.resourceUsage().maxRSS}));`;
 const started=performance.now(),result=spawnSync(process.execPath,["-e",script,path.join(__dirname,"dropdown-owner.js")],{
  input:JSON.stringify({source,params,kind,expected,roundTrip}),encoding:"utf8",maxBuffer:1024*1024,timeout:60000,
 });
 assert.equal(result.status,0,result.stderr||result.error?.message);isolatedProofs.push({...JSON.parse(result.stdout),elapsedMs:performance.now()-started});
}
test.after(()=>{if(isolatedProofs.length)console.log("UP51 isolated binding witnesses",JSON.stringify({cases:isolatedProofs.length,maxChildRssKiB:Math.max(...isolatedProofs.map(row=>row.maxRssKiB)),maxChildElapsedMs:Math.max(...isolatedProofs.map(row=>row.elapsedMs))}));});

test("current signed composer and selection bridge qualify source-only with exact dropdown inverse",()=>{
 assert.equal(sha(composer.source),composer.bodySha256);assert.equal(sha(selector.source),selector.bodySha256);
 const state=dropdownModuleState(composer.source,snap());assert.equal(state.kind,"current",state.reason);assert.equal(state.owner.publication.exportName,"M");assert.equal(state.owner.selectorImport.moduleId,"sU9s");assert.equal(state.owner.selectorExport,"o");
 const bridge=selectorModuleState(selector.source,selectorSnap());assert.equal(bridge.ok,true,bridge.reason);assert.equal(bridge.owner.settingsImport.moduleId,"o8WW");assert.equal(bridge.owner.settingsExport,"a");
 const patched=apply(composer.source,snap()),after=dropdownModuleState(patched,snap(patched));assert.equal(after.kind,"patched",after.reason);assert.equal(after.native,composer.source);assert.equal(apply(patched,snap(patched)),patched);assert.doesNotThrow(()=>new Script(patched));
 assert.equal(patched.replace(state.owner.gate.replacement,state.owner.gate.native),composer.source);
 assert.equal(Buffer.byteLength(patched)-Buffer.byteLength(composer.source),7);
});
test("feature contribution removes only the Copilot guard while native loading, disabled model and lock gates remain",()=>{
 const state=dropdownModuleState(composer.source,snap());
 // A reduced synthetic control executes the exact feature contribution; no
 // retained factory is evaluated and no native backend or UI is launched.
 const body='let nc=host,n5=options,nX=model,og=loading,nj={lockedReasoningEffort:locked};let '+state.owner.gate.native+';let ti=og||ob||nj?.lockedReasoningEffort!=null;return ti';
 const before=Function("host","options","model","loading","locked",body),after=Function("host","options","model","loading","locked",body.replace(state.owner.gate.native,state.owner.gate.replacement));
 for(const authMethod of ["copilot","chatgpt","apikey","amazonBedrock",null])for(const loading of [true,false])for(const disabledReason of [null,"policy blocked"])for(const locked of [null,"medium"]){
  const host={authMethod},options=[{model:{model:"chosen"},disabledReason}],value=after(host,options,"chosen",loading,locked);
  assert.equal(value,loading||disabledReason!=null||locked!=null);
  if(authMethod!=="copilot")assert.equal(value,before(host,options,"chosen",loading,locked));
 }
 assert.equal(before({authMethod:"copilot"},[{model:{model:"chosen"},disabledReason:null}],"chosen",false,null),true);
 assert.equal(after({authMethod:"copilot"},[{model:{model:"chosen"},disabledReason:null}],"chosen",false,null),false);
});
test("native menu selection callback forwards the chosen model and effort through its current settings selector",async()=>{
 const owner=dropdownModuleState(composer.source,snap()).owner,route=owner.nativeRoute,b=route.bindings,calls=[],events=[];
 // Execute only the already qualified native selection callback under mocks.
 // The enclosing signed factory is never evaluated; these calls do not prove
 // native durability, profile reopen or the UP49 persistence implementation.
 const env={
  [b.store]:{get:()=>true},[b.permission]:{[b.permissionKey]:"autoAllowed"},[b.conversation]:"conversation-A",
  [b.chosen]:"model-A",[b.effort]:"medium",[b.agent]:null,
  [b.events]:{[b.eventKey]:(store,event,value)=>events.push([event,value])},
  [b.eventTypes]:{CodexComposerModelChanged:"model",CodexComposerReasoningEffortChanged:"effort"},
  [b.transform]:model=>model,[b.settingsSelect]:(model,effort,onChange,options)=>{calls.push({model,effort,options,host:"active-host",conversation:"conversation-A"});onChange();return Promise.resolve(true);},
 };
 const create=()=>Function(...Object.keys(env),`return (${composer.source.slice(route.callbackRange.start,route.callbackRange.end)});`)(...Object.values(env));
 assert.equal(await create()("model-A","high",{persistAsDefault:true}),true);assert.deepEqual(calls,[{model:"model-A",effort:"high",options:{persistAsDefault:true},host:"active-host",conversation:"conversation-A"}]);assert.deepEqual(events,[["effort",{reasoningEffort:"high"}]]);
 calls.length=0;events.length=0;env[b.store]={get:()=>false};assert.equal(await create()("auto","high"),false);assert.deepEqual(calls,[]);
 env[b.store]={get:()=>true};env[b.agent]={isAeon:true,selectModelAndReasoningEffort:(model,effort,onChange)=>{calls.push({model,effort,aeon:true});onChange();return true;}};assert.equal(create()("model-B","low"),true);assert.deepEqual(calls,[{model:"model-B",effort:"low",aeon:true}]);
});
test("composer qualification follows renamed bindings and public export names",()=>{
 const map={e:"argument",l:"localValue",n:"loader",nc:"activeIdentity",nt:"activeHost",nX:"selectedModel",nP:"nativeSelect",ob:"combinedDisabled",ti:"effortDisabled"},lex=createJavaScriptLexicalIndex(composer.source);
 const names=Object.keys(map).sort((a,b)=>b.length-a.length).join("|");
 const renamed=composer.source.replace(new RegExp(`\\b(?:${names})\\b`,"gu"),(name,at)=>lex.isCode(at)?map[name]:name).replace('M:function(', 'renamed:function(');
 const params=composer.params.map(name=>map[name]??name),state=dropdownModuleState(renamed,snap(renamed,params));assert.equal(state.kind,"current",state.reason);const once=apply(renamed,snap(renamed,params));assert.equal(apply(once,snap(once,params)),once);
});
test("composer rejects wrong authority, binding drift, shadow scopes, role writes and disconnected UI paths",()=>{
 const patched=apply(composer.source,snap()),state=dropdownModuleState(composer.source,snap()),{callbackRange}=state.owner.nativeRoute;
 const callback=composer.source.slice(callbackRange.start,callbackRange.end),shadowedCallback=callback.replace(/\be\b/gu,"nP");
 for(const source of [
  composer.source+composer.source,`/*${composer.source}*/`,`const example=${JSON.stringify(composer.source)};`,
  composer.source.replace('n.d(l,','n.d(other,'),composer.source.replace('S=n("EOo5")','S=foreign'),composer.source+';S=foreign;',
  composer.source.replace('M:function(e){','M:function(e){let S;'),
  composer.source.replace('nc=(0,S.tn)(nt)','nc=(0,S.tn)(otherHost)'),
  composer.source.replace('cwdOverride:lX,hostId:lH}','cwdOverride:otherCwd,hostId:lH}'),
  composer.source.replace('return l.model===nX','return l.model===wrongModel'),
  composer.source.replace('n5?.find(e=>{let{model:l}=e;return l.model===nX})','n5?.find(nX=>{let{model:l}=nX;return l.model===nX})'),
  composer.source.replace('ti=og||ob||','ti=og||foreign||'),composer.source.replace('ti=og||ob||nj?.lockedReasoningEffort!=null','ti=ob'),
  composer.source.replace('e3=nj?.isLoading===!0||','e3=otherLoading||'),composer.source.replace('reasoningEffortDisabled:ti','reasoningEffortDisabled:other'),
  composer.source.replace('onSelectModel:lI','onSelectModel:other'),composer.source.replace('lI=(e,l)=>{oY(e,l)}','lI=(e,l)=>{other(e,l)}'),
  composer.source.replace('nP(o0(e),l,o,n)','nR(o0(e),l,o,n)'),
  composer.source.slice(0,callbackRange.start)+shadowedCallback+composer.source.slice(callbackRange.end),
  composer.source.replace('function o0(e){return nN&&e===nX?G.qz:e}','function o0(nX){return nN&&nX===nX?G.qz:nX}'),
  composer.source.replace('let tn=nz?.isTeamCatalog,','[nP]=[foreign];let tn=nz?.isTeamCatalog,'),
  composer.source.replace('let tn=nz?.isTeamCatalog,','({identity:nc}=other);let tn=nz?.isTeamCatalog,'),
  composer.source.replace('M:function(e){','M:function(e){throw Error("unreachable");'),
  composer.source+`/*${MARKER}*/`,patched+`/*${MARKER}*/`,patched.replace(`/*${MARKER}*/`,''),patched.replace('ob=/*'+MARKER+'*/n5','ob=/*'+MARKER+'*/foreign'),
 ]){const result=dropdownModuleState(source,snap(source));assert.equal(result.kind,"missing",source.slice(-120));assert.throws(()=>apply(source,snap(source)),/dropdown factory/);}
});
test("selector qualification rejects wrong publications, settings imports, policy shadows and writer rebinding",()=>{
 const original=selectorModuleState(selector.source,selectorSnap());assert.equal(original.ok,true,original.reason);
 for(const source of [selector.source+selector.source,`/*${selector.source}*/`,selector.source.replace('n.d(t,','n.d(other,'),selector.source.replace('(0,i.a)(j)','(0,i.a)(other)'),selector.source.replace('i=n("o8WW")','i=foreign'),selector.source.replace('return k(e,t,o)','return k(e,"medium",o)'),selector.source.replace('selectComposerModelAndReasoningEffort:R','selectComposerModelAndReasoningEffort:k'),selector.source.replace('let R=f;return','[k]=[foreign];let R=f;return'),selector.source.replace('let R=f;return','M=foreign;let R=f;return'),selector.source+';g=foreign;'])assert.equal(selectorModuleState(source,selectorSnap(source)).ok,false,source.slice(-120));
});
test("owned dropdown, auth import and selector writes reject escaped or block-scoped spellings",()=>{
 const insert=(source,fragment)=>source.replace("let tn=nz?.isTeamCatalog,",fragment+"let tn=nz?.isTeamCatalog,");
 const patched=apply(composer.source,snap());
 for(const fragment of [
  String.raw`if(true){\u006f\u0062=false}`,
  String.raw`if(true){\u{6f}\u{62}=false}`,
  String.raw`if(true){[\u006f\u0062]=[false]}`,
  String.raw`if(true){({value:\u006f\u0062}=payload)}`,
  String.raw`if(true){var \u006f\u0062=false}`,
  String.raw`if(true){\u006f\u0062++}`,
  String.raw`if(true){++\u006f\u0062}`,
  String.raw`if(true){[...\u006f\u0062]=payload}`,
  String.raw`if(true){({...\u006f\u0062}=payload)}`,
  String.raw`for(\u006f\u0062 of payload){}`,
  String.raw`for(\u006f\u0062 in payload){}`,
 ])for(const original of [composer.source,patched]){
  const source=insert(original,fragment);isolatedProof(source,composer.params,"composer","missing");
 }
 for(const fragment of [String.raw`;if(true){S=foreign}`,String.raw`;if(true){\u0053=foreign}`,String.raw`;if(true){var \u0053=foreign}`,String.raw`;if(true){[\u0053]=payload}`,String.raw`;if(true){({value:\u0053}=payload)}`]){
  const source=composer.source+fragment;isolatedProof(source,composer.params,"composer","missing");
 }
 for(const fragment of [String.raw`if(true){\u006b=foreign}`,String.raw`if(true){[\u006b]=payload}`,String.raw`if(true){({value:\u006b}=payload)}`,String.raw`if(true){var \u006b=foreign}`]){
  const source=selector.source.replace("let R=f;return",fragment+"let R=f;return");isolatedProof(source,selector.params,"selector",false);
 }
});
test("binding projection retains real escaped local shadows, opaque text and member keys",()=>{
 const fragment=String.raw`if(true){let \u006f\u0062=false;\u006f\u0062=true}function unused(\u006f\u0062){\u006f\u0062=false}if(true){let [localOb]=payload;holder.\u006f\u0062=false;({\u006f\u0062:holder.value}=payload)}const opaque="\u006f\u0062=false";/* \u006f\u0062=false */`;
 const source=composer.source.replace("let tn=nz?.isTeamCatalog,",fragment+"let tn=nz?.isTeamCatalog,");isolatedProof(source,composer.params,"composer","current",true);
 const importShadow=composer.source+String.raw`;if(true){let \u0053=foreign;\u0053=other}function unused(){var \u0053=foreign;\u0053=other}holder.\u0053=foreign;({\u0053:holder.value}=payload)`;
 isolatedProof(importShadow,composer.params,"composer","current");
 const bridge=selector.source.replace("let R=f;return",String.raw`if(true){let \u006b=foreign;\u006b=other}function unused(\u006b){\u006b=foreign}holder.\u006b=other;({\u006b:holder.value}=payload);`+"let R=f;return");isolatedProof(bridge,selector.params,"selector",true);
});
test("receiver reads and member writes remain readonly, while dense memo reads cannot hide an encoded binding write",()=>{
 const member=composer.source+String.raw`;S.note=1;S["note"]=2;const read=S.note;`;
 isolatedProof(member,composer.params,"composer","current");
 const reads="lW[0];".repeat(1000),marker="let tn=nz?.isTeamCatalog,";
 const safe=composer.source.replace(marker,reads+marker);isolatedProof(safe,composer.params,"composer","current");
 const unsafe=composer.source.replace(marker,reads+String.raw`if(true){\u006f\u0062=false}`+marker);isolatedProof(unsafe,composer.params,"composer","missing");
});
test("deep inspection rejects oversized factory bodies before lexical parsing",()=>{
 const largeComposer=composer.source+"/*"+"x".repeat(256*1024)+"*/";
 const state=dropdownModuleState(largeComposer,snap(largeComposer));assert.equal(state.kind,"missing");assert.match(state.reason,/bounded inspection cap/);
 const largeSelector=selector.source+"/*"+"x".repeat(256*1024)+"*/";
 const bridge=selectorModuleState(largeSelector,selectorSnap(largeSelector));assert.equal(bridge.ok,false);assert.match(bridge.reason,/bounded inspection cap/);
});
test("production dropdown transaction patches every physical copy and preserves dependencies, modes and repeat bytes",()=>{
 const files=dependencyFiles({"ui.js":chunk(composer.source),"nested/ui.js":chunk(composer.source)});
 app(files,(root,dir,read)=>{
  const first=report(root);assert.equal(first.patches[0].status,"applied");assert.deepEqual(enabledFeatureFailuresFromReport(first),[]);
  assert.equal(read("ui.js"),chunk(apply(composer.source,snap())));assert.equal(read("nested/ui.js"),read("ui.js"));assert.equal(read("selector.js"),files["selector.js"]);assert.equal(read("settings.js"),files["settings.js"]);
  const after=Object.fromEntries(Object.keys(files).map(name=>[name,read(name)])),repeat=report(root);assert.equal(repeat.patches[0].status,"already-applied");assert.deepEqual(enabledFeatureFailuresFromReport(repeat),[]);for(const name of Object.keys(files)){assert.equal(read(name),after[name]);assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o640);}
 });
});
test("ambiguous, hidden, damaged, mixed, opaque and orphan dropdown cohorts refuse every write",()=>{
 const pristine=chunk(composer.source),patched=chunk(apply(composer.source,snap()));
 for(const files of [{},{"ui.js":pristine,"other.js":chunk(composer.source,"differentOwner")},{"ui.js":pristine,"nested/ui.js":patched},{"ui.js":pristine,"nested/ui.js":chunk('const lostEveryNeedle=true;')},{"ui.js":pristine,"nested/ui.js":chunk(composer.source.replace('ti=og||ob||','ti=og||foreign||'))},{"ui.js":pristine,"orphan.js":`export const marker="${MARKER}";`},{"ui.js":pristine+`/*${MARKER}*/`},{"ui.js":'/*'+pristine+'*/'},{"ui.js":'const example=`'+pristine+'`;'}])app(dependencyFiles(files),(root,dir,read)=>{let writes=0;assert.throws(()=>patch(root,settingsState,{writeFileSync(){writes++;}}));assert.equal(writes,0);assert.equal(enabledFeatureFailuresFromReport(report(root)).length,1);for(const [name,text]of Object.entries(files))assert.equal(read(name),text);});
});
test("wrong, hidden or missing selector/settings dependencies prevent UI writes",()=>{
 for(const files of [
  {"ui.js":chunk(composer.source.replace('ek=n("sU9s")','ek=n("foreign")')),"selector.js":selectorChunk(),"settings.js":settingsChunk()},
  {"ui.js":chunk(composer.source),"selector.js":selectorChunk(selector.source.replace('i=n("o8WW")','i=n("foreign")')),"settings.js":settingsChunk()},
  {"ui.js":chunk(composer.source),"selector.js":selectorChunk(selector.source.replace('o:function','other:function')),"settings.js":settingsChunk()},
  {"ui.js":chunk(composer.source),"selector.js":selectorChunk(),"hidden/selector.js":selectorChunk('const hidden=true;'),"settings.js":settingsChunk()},
  {"ui.js":chunk(composer.source),"selector.js":selectorChunk(),"settings.js":settingsChunk(),"hidden/settings.js":settingsChunk('const hidden=true;')},
  {"ui.js":chunk(composer.source),"selector.js":selectorChunk()},
  {"ui.js":chunk(composer.source)},
 ])app(files,(root,dir,read)=>{let writes=0;assert.throws(()=>patch(root,settingsState,{writeFileSync(){writes++;}}));assert.equal(writes,0);for(const [name,text]of Object.entries(files))assert.equal(read(name),text);});
});
test("partial second dropdown write restores exact bytes and modes, and failed rollback remains fatal",()=>{
 const files=dependencyFiles({"a.js":chunk(composer.source),"b.js":chunk(composer.source)});
 app(files,(root,dir,read)=>{let calls=0;assert.throws(()=>patch(root,settingsState,{writeFileSync(file,bytes){if(++calls===2){fs.writeFileSync(file,bytes.subarray(0,17));throw Error("UP51 partial write");}fs.writeFileSync(file,bytes);}}),/UP51 partial write/);for(const [name,text]of Object.entries(files)){assert.equal(read(name),text);assert.equal(fs.statSync(path.join(dir,name)).mode&0o777,0o640);}});
 app(files,root=>{let calls=0;assert.throws(()=>patch(root,settingsState,{writeFileSync(file,bytes){if(++calls===1)fs.writeFileSync(file,bytes);else throw Error("disk fault");}}),error=>error.name==="PatchIntegrityError"&&/restore original bytes/.test(error.message));});
});
