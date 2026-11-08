"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const API=require("./existing-chat-selection.js"),main=require("./patch.js"),Copilot=require("../copilot-reasoning-effort/patch.js");
const settings=require("../../scripts/patches/lib/fixtures/current-model-composer.json").settings;
const {inspectModelSettingsOwner}=require("../../scripts/patches/lib/model-composer-owners.js");
const {scene}=require("./fixtures/existing-chat-selection-harness.js");
const configuration=[{model:"model-new",effort:"high",default:true},{model:"model-B",effort:"low"}];
const presets=main.normalizePresets({feature:{settings:{presets:configuration}}}),efforts=main.THINKING_EFFORT_TO_EFFORT;
const prepared=API.prepareExistingChatSelection(settings.moduleSource,settings,presets,efforts);
function callbackSources(result){
  const source=result.patchedSource,owner=inspectModelSettingsOwner({...settings,moduleSource:source});assert(owner.ok,owner.reason);
  const expression=range=>source.slice(range.start,range.end).replace(/^[^=]+=/u,"");
  const hook=result.proof.edits[0].to.slice(result.proof.edits[0].from.length);
  return{locals:result.proof.locals,effectiveTarget:result.proof.effectiveTarget,hook,
    next:expression(owner.nextTurn.setter),writer:expression(owner.default.writer),
    current:expression(owner.current.setter),rpc:expression(owner.nextTurn.rpc)};
}
const callbacks=callbackSources(prepared);
function actualScene(options={}){
  const prefix=prepared.patchedSource.slice(0,prepared.proof.runtimePrefixLength);
  const runtime=new vm.Script(`${prefix};${prepared.proof.locals.runtime}`).runInNewContext({});
  return scene({...options,runtime,nativeCallbacks:callbacks});
}
const chunk=(source=settings.moduleSource,id=settings.moduleId)=>`export const __webpack_modules__={${id}(${settings.params.join(",")}){${source}}};`;
function app(files,run){const dependency=require("./fixtures/current-existing-chat-dependencies.json"),deps=`export const __webpack_modules__={${Object.values(dependency.owners).map(owner=>`${owner.moduleId}(${owner.params.join(",")}){${owner.moduleSource}}`).join(",")}};`;files={"dependencies.js":deps,...files};const root=fs.mkdtempSync(path.join(os.tmpdir(),"existing-chat-source-")),assets=path.join(root,"webview","assets");fs.mkdirSync(assets,{recursive:true});try{for(const[name,source]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(assets,name)),{recursive:true});fs.writeFileSync(path.join(assets,name),source);}return run(root,assets);}finally{fs.rmSync(root,{recursive:true,force:true});}}

test("qualified real settings factory replays exactly and preserves native RPC mixer and finally text",()=>{
  const repeat=API.prepareExistingChatSelection(prepared.patchedSource,{...settings,moduleSource:prepared.patchedSource},presets,efforts);
  assert.equal(prepared.state,"pristine");assert.equal(repeat.state,"applied");
  assert.equal(repeat.nativeSource,settings.moduleSource);assert.equal(repeat.patchedSource,prepared.patchedSource);
  assert(prepared.proof.metadataSource.usesActualThreadMetadata);assert.equal(prepared.proof.metadataSource.accountFallbackIsAcknowledgement,false);
  const native=inspectModelSettingsOwner(settings),patched=inspectModelSettingsOwner({...settings,moduleSource:prepared.patchedSource});
  for(const pick of [owner=>owner.nextTurn.rpc,owner=>owner.effectiveSettings.range,owner=>owner.nextTurn.optimistic.cleanup]){
    const a=pick(native),b=pick(patched);assert.equal(settings.moduleSource.slice(a.start,a.end),prepared.patchedSource.slice(b.start,b.end));
  }
});
test("actual transformed active and ordinary callbacks preserve successful visible choice through native cleanup",async()=>{
  for(const active of [true,false]){
    const s=actualScene({active}),pending=s.current("model-new","high");if(!active)await s.drive();s.events.length=0;
    s.rpc[0].resolve();assert.equal(await pending,true);assert.equal(s.read().model,"model-new");
    assert(s.events.every(event=>event.visible.model==="model-new"));assert.equal(s.writing(),null);
    assert.equal(s.calls.filter(row=>row[0]==="rpc").length,1);
  }
});
test("actual transformed rejection and old completion after a newer manual intent follow native cleanup",async()=>{
  for(const active of [true,false]){
    const s=actualScene({active}),pending=s.current("model-new","high");if(!active)await s.drive();
    s.rpc[0].reject(Error("native rejected"));assert.equal(await pending,false);assert.equal(s.pending(),null);
    assert.deepEqual(s.errors,["native rejected"]);
  }
  const s=actualScene(),old=s.current("model-new","high"),latest=s.current("outside-list","low");
  s.rpc[1].resolve();await latest;s.rpc[0].resolve();await old;assert.equal(s.pending(),null);
});
test("actual emitted metadata hook releases after acknowledgement including early ack and later native refresh",async()=>{
  for(const early of [true,false]){
    const s=actualScene(),pending=s.current("model-new","high");
    if(early){s.state.metadata={model:"model-new",effort:"high"};s.refresh();s.state.metadata={model:"later-native",effort:"low"};s.refresh()}
    s.rpc[0].resolve();await pending;
    if(!early){s.state.metadata={model:"model-new",effort:"high"};s.refresh();s.state.metadata={model:"later-native",effort:"low"};s.refresh()}
    assert.equal(s.pending(),null);assert.equal(s.read().model,"later-native");
  }
});
test("actual emitted context hook ignores aborted renders but invalidates committed profile changes",async()=>{
  const speculative=actualScene(),a=speculative.current("model-new","high");speculative.speculate("host","uncommitted-host");
  speculative.rpc[0].resolve();await a;assert(speculative.pending());
  const changed=actualScene(),b=changed.current("model-new","high");changed.state.profile="other-profile";changed.refresh();
  changed.rpc[0].resolve();await b;assert.equal(changed.pending(),null);
});
test("actual native principal projection tolerates fresh auth view objects and changes only with principal fields",async()=>{
  const s=actualScene(),pending=s.current("model-new","high");
  s.state.auth={...s.state.auth};s.refresh();s.rpc[0].resolve();await pending;assert(s.pending());
  s.state.auth={...s.state.auth,accountId:"other-account"};s.refresh();assert.equal(s.pending(),null);
});
test("the emitted runtime cannot capture a module parameter in place of its builtins",()=>{
  for(const name of ["Set","Map","WeakMap","JSON"]){
    const snapshot={...settings,params:[name,...settings.params.slice(1)]};
    assert.throws(()=>API.prepareExistingChatSelection(settings.moduleSource,snapshot,presets,efforts),/builtin.*factory parameter/);
  }
});
test("the actual state hook resolves React and JSON outside the native state scope",()=>{
  const source=settings.moduleSource;
  for(const body of [source.replace("function(e,l,t,n,r)","function(e,l,s,n,r)"),
    source.replace("let eQ=S,eV=eR??ez;","let JSON={};let eQ=S,eV=eR??ez;")]){
    assert.notEqual(body,source);assert.throws(()=>API.prepareExistingChatSelection(body,{...settings,moduleSource:body},presets,efforts),/Shadowed/);
  }
});
test("actual49 and58 transformations commute and each canonical decoder accepts the joint repeat",()=>{
  const c=Copilot.applyCopilotSettingsPersistence(settings.moduleSource,settings);
  const both=API.prepareExistingChatSelection(c,{...settings,moduleSource:c},presets,efforts,{copilotState:Copilot.settingsPersistenceState});
  assert.equal(Copilot.settingsPersistenceState(both.patchedSource,{...settings,moduleSource:both.patchedSource}).kind,"patched");
  assert.equal(Copilot.applyCopilotSettingsPersistence(prepared.patchedSource,{...settings,moduleSource:prepared.patchedSource}),both.patchedSource);
  const repeat=API.prepareExistingChatSelection(both.patchedSource,{...settings,moduleSource:both.patchedSource},presets,efforts,{copilotState:Copilot.settingsPersistenceState});
  assert.equal(repeat.nativeSource,c);assert.equal(repeat.patchedSource,both.patchedSource);
});
test("actual source refuses async owners captures altered metadata orphan partial and stale config",()=>{
  const source=settings.moduleSource;
  const cases=[source.replace("function eg(","async function eg("),source.replace("W=function(e,l,t,n,r)","W=async function(e,l,t,n,r)"),
    source.replace("let n,a=null;try{if(\"current\"","let n,C=null;try{if(\"current\""),
    source.replace("let eK=M,eH=","let eK=eA.model,eH="),source.replace('eW=eU?.collaborationMode','eW=eA?.collaborationMode'),
    prepared.patchedSource.replace(".directSucceeded(",".foreignSucceeded("),prepared.patchedSource+`/*${API.MARKER}*/`];
  for(const body of cases){assert.notEqual(body,source);assert.throws(()=>API.prepareExistingChatSelection(body,{...settings,moduleSource:body},presets,efforts));}
  assert.throws(()=>API.prepareExistingChatSelection(prepared.patchedSource,{...settings,moduleSource:prepared.patchedSource},main.normalizePresets({feature:{settings:{presets:[{model:"different",effort:"low",default:true}]}}}),efforts),/stale/);
});
test("physical cohorts preserve all copies modes and outside bytes and rollback a partial later write",()=>{
  const files={"a.js":chunk(),"nested/b.js":chunk()};
  app(files,(root,assets)=>{fs.chmodSync(path.join(assets,"a.js"),0o640);assert.equal(API.patchExistingChatSelections(root,presets,efforts).changed,2);assert.equal(API.patchExistingChatSelections(root,presets,efforts).changed,0);assert.equal(fs.statSync(path.join(assets,"a.js")).mode&0o777,0o640);});
  app(files,(root,assets)=>{let writes=0;assert.throws(()=>API.patchExistingChatSelections(root,presets,efforts,{}, {writeFileSync(file,bytes){if(++writes===2){fs.writeFileSync(file,bytes.subarray(0,27));throw Error("partial device write")}fs.writeFileSync(file,bytes)}}),/partial device write/);for(const[name,source]of Object.entries(files))assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),source);});
});
test("hidden damaged mixed and orphan actual cohorts refuse every write",()=>{
  const cases=[{"a.js":chunk(),"hidden/b.js":chunk("const damaged=true;")},
    {"a.js":chunk(),"b.js":chunk(prepared.patchedSource)},
    {"a.js":chunk(),"orphan.js":`const text="${API.MARKER}";`}];
  for(const files of cases)app(files,(root,assets)=>{let writes=0;
    assert.throws(()=>API.patchExistingChatSelections(root,presets,efforts,{}, {writeFileSync(){writes++}}));
    assert.equal(writes,0);for(const[name,source]of Object.entries(files))assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),source);
  });
});
test("actual queue scope publications and React forwarder/client references are all prerequisites",()=>{
  const fixture=require("./fixtures/current-existing-chat-dependencies.json");
  const carrier=changes=>`export const __webpack_modules__={${Object.values(fixture.owners).map(owner=>`${owner.moduleId}(${owner.params.join(",")}){${changes[owner.moduleId]??owner.moduleSource}}`).join(",")}};`;
  const mutations=[{Eklu:fixture.owners.Eklu.moduleSource.replace("BG:function","wrongTarget:function")},
    {Eklu:fixture.owners.Eklu.moduleSource.replace('i=n("OWtl")','i=n("foreign")')},
    {zd8w:fixture.owners.zd8w.moduleSource.replace('n("Vlts")','n("foreign")')},
    {Vlts:fixture.owners.Vlts.moduleSource.replace("t.useLayoutEffect=function","t.wrongHook=function")}];
  for(const changes of mutations)app({"a.js":chunk(),"dependencies.js":carrier(changes)},root=>{let writes=0;
    assert.throws(()=>API.patchExistingChatSelections(root,presets,efforts,{}, {writeFileSync(){writes++}}));assert.equal(writes,0);
  });
  app({"a.js":chunk(),"hidden/queue.js":`export const __webpack_modules__={Eklu(e,t,n){const damaged=true;}};`},root=>{
    let writes=0;assert.throws(()=>API.patchExistingChatSelections(root,presets,efforts,{}, {writeFileSync(){writes++}}));assert.equal(writes,0);
  });
});
test("an unrestorable actual multi-copy write failure remains fatal",()=>{
  app({"a.js":chunk(),"b.js":chunk()},root=>{let writes=0;
    assert.throws(()=>API.patchExistingChatSelections(root,presets,efforts,{}, {writeFileSync(file,bytes){if(++writes===1)fs.writeFileSync(file,bytes);else throw Error("device unavailable")}}),/rollback could not restore/);
  });
});
