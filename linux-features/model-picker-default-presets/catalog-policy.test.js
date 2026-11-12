"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),crypto=require("node:crypto");
const {findMatchingBrace}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const current=require("./fixtures/current-chatgpt-catalog.json"),policyFixture=require("./fixtures/current-catalog-policy.json"),chainFixture=require("./fixtures/current-preset-query-chain.json"),cacheFixture=require("./fixtures/current-native-cache-provider.json");
const {projectCatalog,resolveVariant,prepareCatalogFactory,prepareQueryFactory,inspectQueryOwner,inspectVisibilityProvider,inspectWorkspaceClampProvider,inspectPlanProvider,inspectCacheProvider,constants}=require("./catalog-policy.js");
const hash=value=>crypto.createHash("sha256").update(value).digest("hex");
function named(source,name){const h=new RegExp(`\\bfunction ${name}\\([^)]*\\)\\{`).exec(source);assert.ok(h,name);return source.slice(h.index,findMatchingBrace(source,h.index+h[0].length-1)+1);}
function nativeHelpers(){
  const pubs=key=>findRspackExportPublication(current,key),r=pubs("hX").expression,v=pubs("un").expression,cap=pubs("iC").fn;
  const functions=vm.runInNewContext(`${named(current.moduleSource,r)}${named(current.moduleSource,v)};({collector:${r},resolve:${v},capability:(${current.moduleSource.slice(cap.start,cap.end)})})`);
  const workspace=policyFixture.owners.Bl5H,classifier=policyFixture.owners.vw1R,enumOwner=policyFixture.owners.WPra,mapOwner=policyFixture.owners.LLIt;
  const classifyName=findRspackExportPublication(classifier,"o").expression;
  const plans=JSON.parse(/^let [\w$]+=(\[[^;]+\]);/.exec(classifier.moduleSource)[1]);
  const classify=vm.runInNewContext(`(${named(classifier.moduleSource,classifyName)})`,{r:plans});
  const order=JSON.parse(/\.enum\((\[[^;]+?\])\)/.exec(enumOwner.moduleSource)[1]);
  const names=vm.runInNewContext(`(${/let s=(\{[^;]+\});/.exec(mapOwner.moduleSource)[1]})`);
  const efforts=JSON.parse(/p=[\w$]+\.enum\((\[[^;]+?\])\)/.exec(current.moduleSource)[1]);
  const j=findRspackExportPublication(workspace,"j").fn;
  const clamp=vm.runInNewContext(`(${workspace.moduleSource.slice(j.start,j.end)})`,{r:{_:{options:order}},i:{o:classify},a:{QW:names},s:{hX:functions.collector,Ux:{safeParse:value=>({data:efforts.includes(value)?value:undefined})}}});
  return {...functions,workspace:clamp,names};
}
const native=nativeHelpers();
function context(overrides={}){return{ready:true,plan:"plus",visibleEfforts:new Set(["none","low","medium","high","xhigh","max","ultra"]),reasoningEffortNames:native.names,resolveNative:native.resolve,clampCapability:native.capability,clampWorkspace:native.workspace,...overrides};}
function catalog(metadata={thinkingEfforts:[{thinking_effort:"standard",short_label:"Standard"},{thinking_effort:"extended",short_label:"High"}]}){
  const base={slug:"model-new",title:"Model",description:"native description",thinkingEffort:"standard",isAvailable:true,daybreak:{available:true},serviceTiers:[{id:"priority"}],extra:{keep:true}};
  return{options:[base],internalOptions:[],versionOptions:[],sliderSettings:[{modelSlug:"model-new",thinkingEffort:"standard"}],defaultModelSlug:"model-new",defaultThinkingEffortByModelSlug:{"model-new":"standard"},modelConfigBySlug:{"model-new":{title:"Model",...metadata}},workspaceModelPolicy:{newThreadPrecedence:"prefer_policy",selection:{model:"model-new",thinkingEffort:"standard"}}};
}
const high=[{modelSlug:"model-new",thinkingEffort:"extended",isDefault:true}];
const auth=require("./native-catalog-authority.js");

test("current native pure R/v gap becomes a validated explicit variant without changing native arrays",()=>{
  const base=catalog();assert.equal(native.resolve(base,{slug:"model-new",thinkingEffort:"extended"}),undefined);
  const projected=projectCatalog(base,high,context());assert.notEqual(projected,base);
  const resolved=resolveVariant(projected,{slug:"model-new",thinkingEffort:"extended"},native.resolve(projected,{slug:"model-new",thinkingEffort:"extended"}));
  assert.equal(resolved.thinkingEffort,"extended");assert.equal(resolved.selectedLabel,"Model High");
  for(const key of ["options","internalOptions","versionOptions","workspaceModelPolicy","modelConfigBySlug"])assert.equal(projected[key],base[key],key);
  assert.equal(resolved.daybreak,base.options[0].daybreak);assert.equal(resolved.serviceTiers,base.options[0].serviceTiers);assert.equal(resolved.extra,base.options[0].extra);
  assert.equal(base.defaultThinkingEffortByModelSlug["model-new"],"standard");assert.equal(projected.defaultThinkingEffortByModelSlug["model-new"],"extended");
  assert.deepEqual(Array.from(native.collector(projected)),Array.from(native.collector(base)));
});

test("actual exact native unavailable option is never a miss authorized by another usable base",()=>{
  const base=catalog(),denied={slug:"model-new",thinkingEffort:"extended",isAvailable:false,title:"Denied"};base.options.unshift(denied);
  assert.equal(native.resolve(base,{slug:"model-new",thinkingEffort:"extended"}),denied);
  assert.equal(projectCatalog(base,high,context()),base);
  const forged={...base,[constants.STAMP]:1,[constants.VARIANTS]:[{...base.options[1],thinkingEffort:"extended"}]};
  assert.equal(resolveVariant(forged,{slug:"model-new",thinkingEffort:"extended"},denied),denied);
});

test("advertised supported variant retains exact native option and unsupported declared effort is excluded",()=>{
  const base=catalog(),advertised={...base.options[0],thinkingEffort:"extended",title:"Native High"};base.options.push(advertised);
  const projected=projectCatalog(base,high,context());assert.equal(projected[constants.VARIANTS].length,0);
  assert.equal(resolveVariant(projected,{slug:"model-new",thinkingEffort:"extended"},native.resolve(base,{slug:"model-new",thinkingEffort:"extended"})),advertised);
  const unsupported=catalog({thinkingEfforts:[{thinking_effort:"standard"}]});assert.equal(projectCatalog(unsupported,high,context()),unsupported);
});

test("native missing/null/empty metadata preserves proven pairs, not arbitrary unknown efforts",()=>{
  for(const value of [undefined,null,[]]){
    const base=catalog({thinkingEfforts:value});
    assert.equal(projectCatalog(base,high,context()),base,String(value));
    const standard=[{...high[0],thinkingEffort:"standard"}];
    assert.notEqual(projectCatalog(base,standard,context()),base,String(value));
    base.sliderSettings.push({modelSlug:"model-new",thinkingEffort:"extended"});
    assert.notEqual(projectCatalog(base,high,context()),base,String(value));
    if(value===undefined||value===null)assert.notEqual(projectCatalog(base,high,context({plan:"business"})),base);
    else assert.equal(projectCatalog(base,high,context({plan:"business"})),base);
  }
  const noEvidence=catalog({thinkingEfforts:undefined});noEvidence.options[0].thinkingEffort=null;noEvidence.sliderSettings=[];
  assert.equal(native.workspace("business",noEvidence,"model-new","extended"),undefined);
  assert.equal(projectCatalog(noEvidence,high,context({plan:"business"})),noEvidence);
  noEvidence.defaultThinkingEffortByModelSlug["model-new"]="extended";
  assert.notEqual(projectCatalog(noEvidence,high,context({plan:"business"})),noEvidence);
});

test("fresh plan/visibility chooses ordered surviving default and never authorizes from projected sliders",()=>{
  const base=catalog({thinkingEfforts:null}),presets=[high[0],{modelSlug:"model-new",thinkingEffort:"standard",isDefault:false}];
  base.defaultThinkingEffortByModelSlug["model-new"]="extended";
  const first=projectCatalog(base,presets,context());assert.equal(first.defaultThinkingEffortByModelSlug["model-new"],"extended");
  const later=projectCatalog(base,presets,context({plan:"business"}));assert.equal(later.defaultThinkingEffortByModelSlug["model-new"],"standard");
  assert.throws(()=>projectCatalog(first,presets,context()),/pristine/);
  assert.equal(projectCatalog(base,high,context({visibleEfforts:new Set(["medium"])})),base);
  const ultra=catalog({thinkingEfforts:[{thinking_effort:"ultra"}]});assert.equal(projectCatalog(ultra,[{...high[0],thinkingEffort:"ultra"}],context({visibleEfforts:new Set(["medium"])})),ultra);
  assert.notEqual(projectCatalog(ultra,[{...high[0],thinkingEffort:"ultra"}],context()),ultra);
});

test("pristine base and native policy receive no projected data; no callback runs for empty/unready",()=>{
  const base=catalog(),snap=JSON.stringify(base),presets=Object.freeze(high.map(p=>Object.freeze({...p})));
  let capability=0,workspace=0;
  projectCatalog(base,presets,context({clampCapability:(value,pair)=>{assert.equal(value,base);capability++;return native.capability(value,pair);},clampWorkspace:(plan,value,slug,effort)=>{assert.equal(value,base);workspace++;return native.workspace(plan,value,slug,effort);}}));
  assert.equal(capability,1);assert.equal(workspace,1);assert.equal(JSON.stringify(base),snap);
  const poison=new Proxy({}, {get(){throw Error("must not read policy")}});assert.equal(projectCatalog(base,[],poison),base);
  assert.equal(projectCatalog(base,high,{ready:false}),base);assert.throws(()=>projectCatalog(base,high,{ready:true}),/dependencies/);
});

test("native null/default lookup and ordinary model pool remain native",()=>{
  const base=catalog(),projected=projectCatalog(base,high,context());
  for(const thinkingEffort of [null,undefined]){
    const selection={slug:"model-new",thinkingEffort},before=native.resolve(base,selection),after=native.resolve(projected,selection);
    assert.equal(after,before);assert.equal(resolveVariant(projected,selection,after),after);
  }
  assert.equal(resolveVariant(projected,{slug:"other",thinkingEffort:"extended"},undefined),undefined);
  const unavailable=catalog();unavailable.modelConfigBySlug["model-new"].disabledByAdmin=true;assert.equal(projectCatalog(unavailable,high,context()),unavailable);
  const configOnly=catalog();configOnly.options=[];assert.equal(projectCatalog(configOnly,high,context()),configOnly);
});

test("all presets preserve order/default fallback and zero survivors restore complete exact base",()=>{
  const base=catalog(),presets=[{modelSlug:"missing",thinkingEffort:"extended",isDefault:true},{modelSlug:"model-new",thinkingEffort:"extended",isDefault:false},{modelSlug:"model-new",thinkingEffort:"standard",isDefault:false}];
  const result=projectCatalog(base,presets,context());assert.deepEqual(result.sliderSettings,[{modelSlug:"model-new",thinkingEffort:"extended"},{modelSlug:"model-new",thinkingEffort:"standard"}]);assert.equal(result.defaultThinkingEffortByModelSlug["model-new"],"extended");
  assert.equal(projectCatalog(base,[presets[0]],context()),base);
});

test("actual catalog prepare preserves Ov/R/hX/null, inverse, replay and empty audit",()=>{
  assert.equal(hash(current.moduleSource),current.bodySha256);
  const a=prepareCatalogFactory(current.moduleSource,current,high,{},auth);assert.equal(a.state,"pristine");assert.equal(a.proof.resolverExport,"un");
  const b=prepareCatalogFactory(a.patchedSource,{...current,moduleSource:a.patchedSource},high,{},auth);assert.equal(b.state,"applied");assert.equal(b.nativeSource,current.moduleSource);assert.equal(b.patchedSource,a.patchedSource);
  for(const key of ["Ov","hX","iC"]){const before=findRspackExportPublication(current,key),after=findRspackExportPublication({...current,moduleSource:a.patchedSource},key);assert.equal(before.expression,after.expression);if(before.fn)assert.equal(current.moduleSource.slice(before.fn.start,before.fn.end),a.patchedSource.slice(after.fn.start,after.fn.end));}
  const empty=prepareCatalogFactory(current.moduleSource,current,[],{},auth);assert.equal(empty.nativeSource,current.moduleSource);assert.equal(empty.patchedSource,current.moduleSource);assert.equal(empty.proof.auditOnly,true);
});

test("catalog prepare rejects partial/stale/orphan source and follows renamed publication keys",()=>{
  const a=prepareCatalogFactory(current.moduleSource,current,high,{},auth);
  for(const source of [a.patchedSource.replace(`,${constants.PROJECT}:function`,`,wrongExport:function`),a.patchedSource.replace(`${constants.RESOLVE}(e,t,`,`${constants.RESOLVE}(e,wrong,`),a.patchedSource+`/*${constants.RESOLVE}*/`])assert.throws(()=>prepareCatalogFactory(source,{...current,moduleSource:source},high,{},auth));
  assert.throws(()=>prepareCatalogFactory(a.patchedSource,{...current,moduleSource:a.patchedSource},[{...high[0],thinkingEffort:"standard"}],{},auth));
  assert.throws(()=>prepareCatalogFactory(current.moduleSource,{...current,moduleSource:"stale"},high,{},auth),/Stale/);
  const renamed=current.moduleSource.replace("un:v","lookup:v").replace("hX:R","collect:R").replace("iC:function","clamp:function").replace("Ov:function","normalize:function");
  const r=prepareCatalogFactory(renamed,{...current,moduleSource:renamed},high,{},auth);assert.equal(r.proof.resolverExport,"lookup");assert.equal(r.proof.capabilityExport,"clamp");assert.equal(r.proof.normalizerExport,"normalize");
});

test("actual native lookup/Default/new-thread tail consume the projected legal pair",()=>{
  const base=catalog(),projected=projectCatalog(base,high,context());
  const prepared=prepareCatalogFactory(current.moduleSource,current,high,{},auth),snapshot={...current,moduleSource:prepared.patchedSource};
  const lookupName=findRspackExportPublication(snapshot,prepared.proof.resolverExport).expression;
  const poolName=findRspackExportPublication(snapshot,prepared.proof.collectorExport).expression;
  const lookup=vm.runInNewContext(`${named(prepared.patchedSource,poolName)}${named(prepared.patchedSource,lookupName)};${lookupName}`,{[constants.RESOLVE]:resolveVariant});
  const uniq=(values,key)=>{const seen=new Set;return values.filter(value=>{const k=key(value);if(seen.has(k))return false;seen.add(k);return true;});};
  const tu=policyFixture.owners.TuVM,fn=findRspackExportPublication(tu,"nX").fn;
  const build=vm.runInNewContext(`${named(tu.moduleSource,"o")}${named(tu.moduleSource,"l")}${named(tu.moduleSource,"u")};(${tu.moduleSource.slice(fn.start,fn.end)})`,{i:()=>uniq,s:{un:lookup},a:{GA:()=>false}});
  const ll=policyFixture.owners.LLIt,th=findRspackExportPublication(ll,"th").fn;
  const modelTitle=vm.runInNewContext(`(${named(current.moduleSource,"S")})`);
  const resolvePower=vm.runInNewContext(`${named(ll.moduleSource,"o")};(${ll.moduleSource.slice(th.start,th.end)})`,{s:native.names,a:{un:lookup,Jk:modelTitle},i:{Pd:()=>{throw Error("unexpected fallback")},GA:()=>false}});
  const option=build(projected,{includeSyntheticDefault:true}).defaultOption;
  assert.equal(option.options.find(entry=>entry.thinkingEffort==="extended"),projected[constants.VARIANTS][0]);
  const reselected=resolvePower(projected,option,{slug:projected.defaultModelSlug,thinkingEffort:projected.defaultThinkingEffortByModelSlug[projected.defaultModelSlug]},{fallbackModelLabel:"Model"});
  assert.equal(reselected.defaultPowerSelection.model,"model-new");assert.equal(reselected.powerSettings[reselected.defaultPowerSelection.powerSettingIndex].thinkingEffort,"extended");
  const reader={},result={data:projected};
  const passthrough=vm.runInNewContext(`(${policyFixture.consumerFragments.lBziGetter.source})`);
  assert.equal(passthrough(value=>{assert.equal(value,reader);return result;},false,reader),result);
  const version=vm.runInNewContext(`(${named(current.moduleSource,"N")})`);
  const next=vm.runInNewContext(`(function(a){let n,u;const f=undefined;${policyFixture.consumerFragments.newThreadDefault.source};return n;})`,{E:{nX:build},I:{th:resolvePower},A:{ie:version}})(result.data);
  assert.equal(next.slug,"model-new");assert.equal(next.thinkingEffort,"extended");
});

test("actual SGof direct-fetch metadata formatting needs no supplemental query data",()=>{
  const source=policyFixture.owners.SGof,fn=findRspackExportPublication(source,"N").fn;
  const format=vm.runInNewContext(`(${source.moduleSource.slice(fn.start,fn.end)})`,{i:{QW:native.names},n:{$:(base,slug)=>base.modelConfigBySlug?.[slug]!=null}});
  const base=catalog(),result=format(base,"model-new","high");
  assert.equal(result.model,"model-new");assert.equal(result.reasoningEffort,"extended");
  assert.equal(base[constants.VARIANTS],undefined);
});

test("catalog helpers reject captured ambient builtins but preserve true nested shadows",()=>{
  for(const name of ["Array","Object","TypeError","undefined"]){
    const snapshot={...current,params:[name,"t","n"]};
    assert.ok(auth.inspectNativeCatalog(current.moduleSource,snapshot));
    assert.throws(()=>prepareCatalogFactory(current.moduleSource,snapshot,high,{},auth),/builtin/);
    for(const declaration of [`let ${name};`,`if(true){${name}=foreign;}`]){
      const source=current.moduleSource+";"+declaration;
      assert.throws(()=>prepareCatalogFactory(source,{...current,moduleSource:source},high,{},auth));
    }
  }
  const source=current.moduleSource+';function unrelated(Array,Object,TypeError,undefined){Array=[];Object={};TypeError=1;undefined=2}';
  assert.equal(prepareCatalogFactory(source,{...current,moduleSource:source},high,{},auth).state,"pristine");
});

test("resolver and capability callback captures cannot shadow native input roles",()=>{
  const changes=[
    ['n.find(e=>e.slug===t.slug&&(e.thinkingEffort??null)===i)','n.find(t=>t.slug===t.slug&&(t.thinkingEffort??null)===i)'],
    ['n.find(e=>e.slug===t.slug&&(e.thinkingEffort??null)===i)','n.find(i=>i.slug===t.slug&&(i.thinkingEffort??null)===i)'],
    ['r:n.find(e=>e.slug===t.slug)','r:n.find(t=>t.slug===t.slug)'],
    ['options.some(e=>e.slug===t.slug)','options.some(t=>t.slug===t.slug)'],
    ['internalOptions?.find(e=>e.slug===t.slug)','internalOptions?.find(t=>t.slug===t.slug)'],
    ['r.some(({thinking_effort:e})=>e===t.thinkingEffort)','r.some(({thinking_effort:t})=>t===t.thinkingEffort)'],
  ];
  for(const [from,to]of changes){assert.ok(current.moduleSource.includes(from),from);const source=current.moduleSource.replace(from,to);assert.throws(()=>prepareCatalogFactory(source,{...current,moduleSource:source},high,{},auth),undefined,from);}
  const vText=named(current.moduleSource,"v"),vShadow=vText.replace(/\be\b/gu,"R");
  const cap=findRspackExportPublication(current,"iC").fn,capText=current.moduleSource.slice(cap.start,cap.end),capShadow=capText.replace(/\be\b/gu,"v");
  for(const source of [current.moduleSource.replace(vText,vShadow),current.moduleSource.slice(0,cap.start)+capShadow+current.moduleSource.slice(cap.end)]){
    assert.doesNotThrow(()=>new vm.Script(`function factory(e,t,n){${source}}`));
    assert.throws(()=>prepareCatalogFactory(source,{...current,moduleSource:source},high,{},auth));
  }
  for(const [from,to]of [
    ['n.find(e=>e.slug===t.slug&&(e.thinkingEffort??null)===i)','n.find(model=>model.slug===t.slug&&(model.thinkingEffort??null)===i)'],
    ['r:n.find(e=>e.slug===t.slug)','r:n.find(model=>model.slug===t.slug)'],
    ['options.some(e=>e.slug===t.slug)','options.some(model=>model.slug===t.slug)'],
    ['internalOptions?.find(e=>e.slug===t.slug)','internalOptions?.find(model=>model.slug===t.slug)'],
    ['r.some(({thinking_effort:e})=>e===t.thinkingEffort)','r.some(({thinking_effort:effort})=>effort===t.thinkingEffort)'],
  ]){const source=current.moduleSource.replace(from,to);assert.equal(prepareCatalogFactory(source,{...current,moduleSource:source},high,{},auth).state,"pristine",from);}
});

 test("only pristine positive evidence may synthesize; explicit zero is not null default",()=>{
  const base=catalog({thinkingEfforts:null});base.options[0].thinkingEffort=null;base.sliderSettings=[];base.defaultThinkingEffortByModelSlug={};
  assert.equal(projectCatalog(base,high,context()),base);
  const zero=[{modelSlug:"model-new",thinkingEffort:"zero",isDefault:true}];
  assert.equal(projectCatalog(base,zero,context()),base);
  base.sliderSettings=[{modelSlug:"model-new",thinkingEffort:"zero"}];
  const projected=projectCatalog(base,zero,context());assert.notEqual(projected,base);
  const rawNull=native.resolve(projected,{slug:"model-new",thinkingEffort:null});
  assert.equal(resolveVariant(projected,{slug:"model-new",thinkingEffort:null},rawNull),rawNull);
  assert.equal(resolveVariant(projected,{slug:"model-new",thinkingEffort:"zero"},native.resolve(projected,{slug:"model-new",thinkingEffort:"zero"})).thinkingEffort,"zero");
  assert.throws(()=>projectCatalog(projected,high,context()),/pristine/);
  const unknown=catalog({thinkingEfforts:null});
  const presets=[{modelSlug:"model-new",thinkingEffort:"standard",isDefault:true},high[0]];
  assert.deepEqual(projectCatalog(unknown,presets,context()).sliderSettings,[{modelSlug:"model-new",thinkingEffort:"standard"}]);
});

function bindings(){
  const catalogProof=prepareCatalogFactory(current.moduleSource,current,high,{},auth).proof;
  return{catalog:{moduleId:catalogProof.moduleId,normalizerExport:catalogProof.normalizerExport,resolverExport:catalogProof.resolverExport,collectorExport:catalogProof.collectorExport,capabilityExport:catalogProof.capabilityExport,projectionExport:catalogProof.projectionExport},plan:inspectPlanProvider(policyFixture.owners.SPnB.moduleSource,policyFixture.owners.SPnB,auth),visibility:inspectVisibilityProvider(policyFixture.owners.Q3tq.moduleSource,policyFixture.owners.Q3tq,auth),workspaceClamp:inspectWorkspaceClampProvider(policyFixture.owners.Bl5H.moduleSource,policyFixture.owners.Bl5H,auth),cache:inspectCacheProvider(cacheFixture.moduleSource,cacheFixture,auth)};
}
const linked=bindings();
function wrapRuntime(prepared,base,state){
  const proof=prepared.proof,refs=proof.addedDependencies;
  const atoms={plan:{},account:{},preferred:{},user:{},visible:{}};
  const planNamespace={[linked.plan.exportName]:atoms.plan,[linked.plan.accountExport]:atoms.account,[linked.plan.preferredUserExport]:atoms.preferred,[linked.plan.userExport]:atoms.user};
  const schemaNamespace={[linked.catalog.projectionExport]:(value,policy)=>projectCatalog(value,high,policy),[linked.catalog.resolverExport]:native.resolve,[linked.catalog.capabilityExport]:native.capability};
  const globals={
    [refs.catalog.localName]:schemaNamespace,
    [refs.plan.localName]:planNamespace,
    [refs.visibility.localName]:{[linked.visibility.exportName]:atoms.visible},
    [refs.workspaceClamp.localName]:{[linked.workspaceClamp.exportName]:native.workspace},
    [refs.effortNames.localName]:{[linked.workspaceClamp.effortNames.exportName]:native.names},
  };
  const wrap=vm.runInNewContext(`(${named(prepared.patchedSource,constants.QUERY_HELPER)})`,globals);
  const reads=[];
  const get=atom=>{reads.push(atom);if(atom===atoms.plan)return state.plan;if(atom===atoms.account)return state.account;if(atom===atoms.preferred)return state.preferred;if(atom===atoms.user)return state.user;if(atom===atoms.visible)return state.visible;throw Error("unknown policy atom");};
  const options={queryKey:["native-key"],queryFn:()=>base,placeholderData:()=>base};
  return{options,wrap,get,reads,atoms,globals,schemaNamespace};
}

test("all actual native query modes prepare/inverse/replay and empty config is byte-only audit",()=>{
  for(const id of ["sMGP","lTvi"]){
    const input=policyFixture.owners[id],snapshot=Object.freeze({...input,params:Object.freeze([...input.params])});
    const before=JSON.stringify(snapshot),owner=inspectQueryOwner(input.moduleSource,snapshot,auth);
    assert.equal(owner.readers.length,id==="sMGP"?1:3);
    const a=prepareQueryFactory(input.moduleSource,snapshot,high,linked,auth),b=prepareQueryFactory(a.patchedSource,{...snapshot,moduleSource:a.patchedSource},high,linked,auth);
    assert.equal(a.state,"pristine");assert.equal(b.state,"applied");assert.equal(b.nativeSource,input.moduleSource);assert.equal(b.patchedSource,a.patchedSource);
    assert.equal(JSON.stringify(snapshot),before);
    if(id==="lTvi")assert.equal(named(a.patchedSource,owner.builder.name),named(input.moduleSource,owner.builder.name));
    const empty=prepareQueryFactory(input.moduleSource,snapshot,[],{},auth);assert.equal(empty.patchedSource,input.moduleSource);assert.equal(empty.nativeSource,input.moduleSource);assert.equal(empty.proof.auditOnly,true);assert.equal(empty.patchedSource.includes(constants.QUERY_HELPER),false);
  }
});

test("current scoped chat queries retain native telemetry identity, header and feature-gate bindings",()=>{
  const input=policyFixture.owners.lTvi;
  for(const [from,to]of [
    ['({scope:e})=>f(e,"chat")','({scope:e})=>f(other,"chat")'],
    ['function f(e,t)','function f(t,e)'],
    ['r=e.get("x-request-id")','other=e.get("x-request-id")'],
    ['===n.userId','===n.accountId'],
    ['===n.accountId','===n.userId'],
    ['modelsResponseReceived(n,r)','modelsResponseReceived(other,r)'],
    ['modelsResponseReceived(n,r)','modelsResponseReceived(n,other)'],
    ['onResponseHeaders:void 0===n','onResponseHeaders:void 0!==n'],
    ['return l},queryKey:','return a},queryKey:'],
  ]){
    const changed=input.moduleSource.replace(from,to);assert.notEqual(changed,input.moduleSource,from);
    assert.throws(()=>prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth));
  }
});

test("scoped query readers reject a captured builder and retain coherent local aliases",()=>{
  const input=policyFixture.owners.lTvi,original='({scope:e})=>f(e,"chat")';
  assert.equal(input.moduleSource.split(original).length,2);
  const captured=input.moduleSource.replace(original,'({scope:f})=>f(f,"chat")');
  const renamed=input.moduleSource.replace(original,'({scope:queryScope})=>f(queryScope,"chat")');
  for(const presets of[[],high]){
    assert.throws(()=>prepareQueryFactory(captured,{...input,moduleSource:captured},presets,linked,auth),/scope shadows its options builder/);
    const first=prepareQueryFactory(renamed,{...input,moduleSource:renamed},presets,linked,auth);
    assert.equal(first.state,"pristine");
    const repeated=prepareQueryFactory(first.patchedSource,{...input,moduleSource:first.patchedSource},presets,linked,auth);
    assert.equal(repeated.nativeSource,renamed);
    assert.equal(repeated.patchedSource,first.patchedSource);
  }
});

test("same native cached base reprojects on plan/visibility without changing query/cache fields",()=>{
  const input=policyFixture.owners.sMGP,p=prepareQueryFactory(input.moduleSource,input,high,linked,auth),base=catalog();
  const state={plan:"plus",account:"account",preferred:null,user:"user",visible:new Set(["medium","high"])};
  const r=wrapRuntime(p,base,state),first=r.wrap(r.options,r.get);
  assert.equal(first.queryKey,r.options.queryKey);assert.equal(first.queryFn,r.options.queryFn);assert.equal(first.placeholderData,r.options.placeholderData);
  assert.notEqual(first.select(base),base);
  state.visible=new Set(["medium"]);const second=r.wrap(r.options,r.get);assert.notEqual(second.select,first.select);assert.equal(second.select(base),base);
  state.plan=null;r.reads.length=0;assert.equal(r.wrap(r.options,r.get),r.options);assert.equal(r.reads.includes(r.atoms.visible),false);
  state.plan="plus";state.account=null;r.reads.length=0;assert.equal(r.wrap(r.options,r.get),r.options);assert.equal(r.reads.includes(r.atoms.visible),false);
  assert.equal(base[constants.VARIANTS],undefined);
});

test("query input captures and partial/new scope/dependency mismatches refuse",()=>{
  const input=policyFixture.owners.sMGP,source=input.moduleSource;
  for(const changed of [source.replace('let t=e(a.','let t=foreign(a.'),source.replace('s=(0,d.Ov)(a)','s=(0,foreign.Ov)(a)'),source.replace('signal:e','signal:t'),source.replace('let a=await c.Request','let d=await c.Request'),source.replace('return{queryFn:', 'if(true){n="other"}return{queryFn:')]){
    assert.throws(()=>prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth));
  }
  const a=prepareQueryFactory(source,input,high,linked,auth);
  for(const changed of [a.patchedSource.replace(constants.QUERY_MARKER,"wrong-stamp"),a.patchedSource.replace('},e)','},other)'),a.patchedSource+`/*${constants.QUERY_HELPER}*/`])assert.throws(()=>prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth));
  const other={...linked,visibility:{...linked.visibility,scope:{moduleId:"wrong",exportName:"u"}}};assert.throws(()=>prepareQueryFactory(source,input,high,other,auth));
  const q=policyFixture.owners.lTvi,b=prepareQueryFactory(q.moduleSource,q,high,linked,auth);
  const partial=b.patchedSource.replace('codexLinuxPresetQueryOptions(f(e,"merged"),codexLinuxPresetGet)','f(e,"merged")');assert.throws(()=>prepareQueryFactory(partial,{...q,moduleSource:partial},high,linked,auth));
});

function actualWorld(){
  const prepared=prepareCatalogFactory(current.moduleSource,current,high,{},auth),snapshot={...current,moduleSource:prepared.patchedSource};
  const uniq=(values,key)=>{const seen=new Set;return values.filter(v=>{const k=typeof key==="function"?key(v):v[key];if(seen.has(k))return false;seen.add(k);return true;});};
  const ov=findRspackExportPublication(current,"Ov").fn,ay=findRspackExportPublication(snapshot,"ay").fn,xe=findRspackExportPublication(current,"xe").fn;
  const defs=["b","L","y","D","N","S","w","R","v"].map(name=>named(prepared.patchedSource,name)).join("");
  const schema=vm.runInNewContext(`${defs};({Ov:(${current.moduleSource.slice(ov.start,ov.end)}),un:v,ay:(${prepared.patchedSource.slice(ay.start,ay.end)}),xe:(${current.moduleSource.slice(xe.start,xe.end)}),ie:N,Jk:S})`,{T:{parse:value=>value},r:()=>uniq,x:{},s:"auto",[constants.RESOLVE]:resolveVariant});
  const tu=policyFixture.owners.TuVM,fn=findRspackExportPublication(tu,"nX").fn;
  const build=vm.runInNewContext(`${named(tu.moduleSource,"o")}${named(tu.moduleSource,"l")}${named(tu.moduleSource,"u")};(${tu.moduleSource.slice(fn.start,fn.end)})`,{i:()=>uniq,s:schema,a:{GA:()=>false}});
  const ll=policyFixture.owners.LLIt,th=findRspackExportPublication(ll,"th").fn;
  const resolvePower=vm.runInNewContext(`${named(ll.moduleSource,"o")};(${ll.moduleSource.slice(th.start,th.end)})`,{s:native.names,a:schema,i:{Pd:()=>undefined,GA:()=>false}});
  const availablePub=findRspackExportPublication(chainFixture.p4N2,"f5"),available=vm.runInNewContext(`(${named(chainFixture.p4N2.moduleSource,availablePub.expression)})`,{d:schema,u:{P:()=>{throw Error("unexpected instant-category branch")}}});
  const keys={home:{},fallback:{},plan:{}};
  const choose=vm.runInNewContext(`(function(o,e){let n,u;${chainFixture.normalNewThreadPolicy.source};${policyFixture.consumerFragments.newThreadDefault.source};return n;})`,{A:schema,D:{j:native.workspace},T:{lB:keys.home,eg:keys.fallback,f5:available},i:{e0:keys.plan},E:{nX:build},I:{th:resolvePower}});
  return{schema,build,resolvePower,choose,keys};
}
const world=actualWorld();
function rawResponse(policy){return{models:[
  {slug:"model-new",title:"Model",description:"Model description",default_thinking_effort:"standard",thinking_efforts:[{thinking_effort:"standard",short_label:"Standard"},{thinking_effort:"extended",short_label:"High"}],configurable_thinking_effort:true},
  {slug:"policy-model",title:"Policy",description:"Policy description",default_thinking_effort:"standard",thinking_efforts:[{thinking_effort:"standard"}]}],
  internal_groups:[],categories:[{default_model:"model-new",supported_models:["model-new"],model_lane:"thinking",title:"Model"},{default_model:"policy-model",supported_models:["policy-model"],model_lane:"thinking",title:"Policy"}],
  versions:[{id:"latest",slugs:["model-new","policy-model"],intelligence_presets:[{model_slug:"model-new",thinking_effort:"standard",lane:"thinking",title:"Standard",preset_type:"available"},{model_slug:"policy-model",thinking_effort:"standard",lane:"thinking",title:"Standard",preset_type:"available"}]}],
  slider_settings:[{model_slug:"model-new",thinking_effort:"standard"}],default_model_slug:"model-new",...policy?{workspace_model_policy:policy}:{}};}
function patchedReader(prepared,nativeOwner,mode,globals){
  const source=prepared.patchedSource;
  if(mode!=="tpp"){
    const hit=new RegExp(`\\(\\{scope:(?<scope>[A-Za-z_$][\\w$]*),get:codexLinuxPresetGet\\}\\)=>${constants.QUERY_HELPER}\\((?<builder>[A-Za-z_$][\\w$]*)\\(\\k<scope>,"${mode}"\\),codexLinuxPresetGet\\)`,"u").exec(source);assert.ok(hit,mode);
    return vm.runInNewContext(`(${hit[0]})`,{...globals,[hit.groups.builder]:globals.nativeBuilder});
  }
  const head=/\(0,[A-Za-z_$][\w$]*\.RD\)\([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*,/.exec(source);assert.ok(head);
  const start=head.index+head[0].length,open=source.indexOf("{",source.indexOf("=>",start)),end=findMatchingBrace(source,open);
  return vm.runInNewContext(`(${source.slice(start,end+1)})`,globals);
}
function consumerChoice(projected,user,plan="plus"){
  const result={data:projected},reader={},pass=vm.runInNewContext(`(${policyFixture.consumerFragments.lBziGetter.source})`);
  const observed=pass(token=>{assert.equal(token,reader);return result;},false,reader);assert.equal(observed,result);
  return world.choose(observed,key=>key===world.keys.plan?plan:key===world.keys.home?user:undefined);
}

test("actual lTvi three readers and native /models producer reach Default and newthread",async()=>{
  const input=policyFixture.owners.lTvi,prepared=prepareQueryFactory(input.moduleSource,input,high,linked,auth),requests=[];
  const state={plan:"plus",account:"a",preferred:null,user:"u",visible:new Set(["medium","high"])};
  for(const mode of ["chat","gizmo","merged"]){
    const runtime=wrapRuntime(prepared,null,state);Object.assign(runtime.schemaNamespace,world.schema,{[linked.catalog.projectionExport]:(base,policy)=>projectCatalog(base,high,policy)});
    const telemetry=[],flag={},requestScope={get:token=>token===flag?true:runtime.get(token)};
    const nativeBuilder=vm.runInNewContext(`(${named(input.moduleSource,"f")})`,{
      u:runtime.schemaNamespace,l:{D:{FIVE_MINUTES:300000}},
      i:{chatGptAuthenticatedUserId$:runtime.atoms.user,chatGptAuthenticatedAccountId$:runtime.atoms.account},o:{JW:flag},
      s:{b6:{modelsRequestContext:(userId,accountId)=>({userId,accountId}),modelsResponseReceived:(context,id)=>telemetry.push({context,id})}},
      d:{Request:{safeGet:(route,options)=>{requests.push({route,options});options.onResponseHeaders?.({get:header=>{assert.equal(header,"x-request-id");return `request-${mode}`;}});return Promise.resolve(rawResponse());}}},
    });
    const globals={...runtime.globals,nativeBuilder,[constants.QUERY_HELPER]:runtime.wrap};
    const read=patchedReader(prepared,input,mode,globals),options=read({scope:requestScope,get:runtime.get});
    assert.deepEqual(Array.from(options.queryKey),mode==="chat"?["chatgpt-models"]:["chatgpt-models",mode]);
    const base=await options.queryFn();assert.equal(base[constants.VARIANTS],undefined);const projected=options.select(base);
    assert.equal(telemetry.length,1);assert.deepEqual({...telemetry[0].context},{userId:"u",accountId:"a"});assert.equal(telemetry[0].id,`request-${mode}`);
    assert.equal(projected.defaultThinkingEffortByModelSlug["model-new"],"extended");
    const option=world.build(projected,{includeSyntheticDefault:true}).defaultOption,power=world.resolvePower(projected,option,{slug:"model-new",thinkingEffort:"extended"},{fallbackModelLabel:"Model"});
    assert.equal(power.defaultPowerSelection.model,"model-new");assert.equal(power.powerSettings[power.defaultPowerSelection.powerSettingIndex].thinkingEffort,"extended");
    const next=consumerChoice(projected,undefined);assert.equal(next.slug,"model-new");assert.equal(next.thinkingEffort,"extended");
    state.visible=new Set(["medium"]);const count=requests.length,changed=read({scope:requestScope,get:runtime.get});assert.equal(changed.select(base),base);assert.equal(requests.length,count);state.visible=new Set(["medium","high"]);
  }
  assert.equal(requests.length,3);assert.equal(requests[0].options.parameters.query.is_gizmo,false);assert.equal(requests[1].options.parameters.query.is_gizmo,true);assert.equal(requests[2].options.parameters.query.merged,true);
});

test("actual sMGP queryFn/placeholder keep native identity/raw cache while observer projects",async()=>{
  const input=policyFixture.owners.sMGP,prepared=prepareQueryFactory(input.moduleSource,input,high,linked,auth),state={plan:"plus",account:"account",preferred:null,user:"user",visible:new Set(["medium","high"])};
  const runtime=wrapRuntime(prepared,null,state);Object.assign(runtime.schemaNamespace,world.schema,{[linked.catalog.projectionExport]:(base,policy)=>projectCatalog(base,high,policy)});
  const requests=[],writes=[],cacheEnabled={},raw=rawResponse();
  const originalGet=runtime.get,get=atom=>atom===cacheEnabled?true:originalGet(atom);
  const globals={...runtime.globals,[constants.QUERY_HELPER]:runtime.wrap,p:cacheEnabled,h:{safeParse:()=>({data:{fetchedAt:Date.now(),response:raw}})},o:{TB:()=>({}),jx:(key,value)=>writes.push({key,value})},l:{D:{FIVE_MINUTES:300000}},u:{J8:()=>false},c:{Request:{safeGet:(route,options)=>{requests.push({route,options});return Promise.resolve(raw);}}}};
  const read=patchedReader(prepared,input,"tpp",globals),options=read({get});assert.deepEqual(Array.from(options.queryKey),["chatgpt-tpp-models","account","user"]);
  const cached=options.placeholderData();assert.equal(cached[constants.VARIANTS],undefined);assert.notEqual(options.select(cached),cached);
  let aborted=0;const base=await options.queryFn({signal:{throwIfAborted:()=>{aborted++;}}});
  assert.equal(base[constants.VARIANTS],undefined);assert.equal(aborted,1);assert.equal(requests[0].route,"/tpp/models/");assert.equal(requests[0].options.expectedIdentity.accountId,"account");assert.equal(requests[0].options.expectedIdentity.userId,"user");
  assert.equal(writes[0].key,"chatgpt-work-models-v1/user/account");assert.equal(writes[0].value.response,raw);
  const projected=options.select(base);assert.equal(consumerChoice(projected,undefined).thinkingEffort,"extended");
  state.account="other-account";state.user="other-user";state.visible=new Set(["medium"]);const after=read({get});assert.deepEqual(Array.from(after.queryKey),["chatgpt-tpp-models","other-account","other-user"]);assert.equal(after.select(base),base);assert.equal(requests.length,1);
});

test("actual normal workspace precedence preserves policy/user and invalid-policy fallback",()=>{
  for(const precedence of ["prefer_policy","prefer_user"]){
    const raw=rawResponse({selection:{model:"policy-model",thinking_effort:"standard"},new_thread_precedence:precedence}),base=world.schema.Ov(raw),projected=projectCatalog(base,high,context());
    assert.equal(projected.workspaceModelPolicy,base.workspaceModelPolicy);
    const result=consumerChoice(projected,{slug:"model-new",thinkingEffort:"extended"});
    assert.equal(result.slug,precedence==="prefer_policy"?"policy-model":"model-new");assert.equal(result.thinkingEffort,precedence==="prefer_policy"?"standard":"extended");
  }
  const invalid=world.schema.Ov(rawResponse({selection:{model:"missing",thinking_effort:"extended"},new_thread_precedence:"prefer_policy"}));
  const result=consumerChoice(projectCatalog(invalid,high,context()),undefined);assert.equal(result.slug,"model-new");assert.equal(result.thinkingEffort,"extended");
  const invalidEffort=world.schema.Ov(rawResponse({selection:{model:"policy-model",thinking_effort:"ultra"},new_thread_precedence:"prefer_policy"}));
  const nativeResult=consumerChoice(projectCatalog(invalidEffort,high,context()),undefined);assert.equal(nativeResult.slug,"policy-model");assert.equal(nativeResult.thinkingEffort,null);
});

test("original server-only policy effort survives custom slider and hidden user effort",()=>{
  const raw=rawResponse({selection:{model:"policy-model",thinking_effort:"extended"},new_thread_precedence:"prefer_policy"});
  raw.slider_settings=[{model_slug:"policy-model",thinking_effort:"extended"}];
  raw.models.find(model=>model.slug==="policy-model").thinking_efforts.push({thinking_effort:"extended"});
  const base=world.schema.Ov(raw);assert.equal(world.schema.un(base,{slug:"policy-model",thinkingEffort:"extended"}),undefined);
  const before=world.schema.ay(base);assert.equal(before.thinkingEffort,"extended");
  const standard=[{modelSlug:"model-new",thinkingEffort:"standard",isDefault:true}],policy=context({visibleEfforts:new Set(["medium"])});
  const projected=projectCatalog(base,standard,policy);
  assert.equal(projected.workspaceModelPolicy,base.workspaceModelPolicy);assert.deepEqual(projected.sliderSettings,[{modelSlug:"model-new",thinkingEffort:"standard"}]);
  const after=world.schema.ay(projected);assert.equal(after.slug,before.slug);assert.equal(after.thinkingEffort,before.thinkingEffort);
  const next=consumerChoice(projected,undefined);assert.equal(next.slug,"policy-model");assert.equal(next.thinkingEffort,"extended");
  assert.equal(projected[constants.VARIANTS].some(option=>option.slug==="policy-model"),false);
  assert.equal(projected[constants.SERVER_VARIANTS].some(option=>option.slug==="policy-model"&&option.thinkingEffort==="extended"),true);
  assert.deepEqual(Array.from(native.collector(projected)),Array.from(native.collector(base)));
});

test("server compatibility never overrides exact deny, creates unknown model, or equates null with zero",()=>{
  const base=catalog(),denied={slug:"denied",thinkingEffort:"extended",isAvailable:false};
  base.options.push({slug:"denied",thinkingEffort:"standard",isAvailable:true},denied);
  base.sliderSettings.push({modelSlug:"denied",thinkingEffort:"extended"},{modelSlug:"unknown",thinkingEffort:"extended"},{modelSlug:"model-new",thinkingEffort:null});
  const projected=projectCatalog(base,high,context());
  assert.equal(projected[constants.SERVER_VARIANTS].some(option=>option.slug==="denied"||option.slug==="unknown"||option.thinkingEffort==null),false);
  assert.equal(resolveVariant(projected,{slug:"denied",thinkingEffort:"extended"},native.resolve(base,{slug:"denied",thinkingEffort:"extended"})),denied);
  assert.equal(resolveVariant(projected,{slug:"model-new",thinkingEffort:null},base.options[0]),base.options[0]);
  assert.throws(()=>projectCatalog(projected,high,context()),/pristine/);
});

test("server compatibility metadata does not disable native downstream capability/workspace clamps",()=>{
  const base=catalog();base.options.push({slug:"policy-model",thinkingEffort:null,title:"Policy",isAvailable:true});
  base.modelConfigBySlug["policy-model"]={thinkingEfforts:[{thinking_effort:"standard"}]};
  base.sliderSettings.push({modelSlug:"policy-model",thinkingEffort:"extended"});
  const projected=projectCatalog(base,high,context());
  assert.equal(resolveVariant(projected,{slug:"policy-model",thinkingEffort:"extended"},native.resolve(projected,{slug:"policy-model",thinkingEffort:"extended"})).thinkingEffort,"extended");
  assert.equal(native.capability(projected,{slug:"policy-model",thinkingEffort:"extended"}).thinkingEffort,"standard");
  assert.equal(native.workspace("business",projected,"policy-model","extended").thinkingEffort,"standard");
});

test("cheap body rejection precedes snapshot syntax or authority access",()=>{
  let touched=0;const snapshot=new Proxy({}, {get(){touched++;throw Error("unrelated body touched snapshot");}});
  const source="not valid JavaScript, but not an owner";
  assert.throws(()=>prepareCatalogFactory(source,snapshot,high,{},auth),/body candidate/);
  assert.throws(()=>prepareQueryFactory(source,snapshot,high,{},auth),/body candidate/);
  assert.equal(touched,0);
});

test("exact c6c221 native ay server-slider witness preserves its original result",()=>{
  const base={options:[{slug:"model-new",thinkingEffort:"standard",title:"Model",isAvailable:true},{slug:"policy-only",thinkingEffort:null,title:"Policy",isAvailable:true}],internalOptions:[],versionOptions:[],defaultModelSlug:"model-new",defaultThinkingEffortByModelSlug:{"model-new":"standard","policy-only":"standard"},sliderSettings:[{modelSlug:"policy-only",thinkingEffort:"extended"}],modelConfigBySlug:{"model-new":{thinkingEfforts:[{thinking_effort:"standard"},{thinking_effort:"extended"}]},"policy-only":{thinkingEfforts:[{thinking_effort:"standard"},{thinking_effort:"extended"}]}},workspaceModelPolicy:{selection:{model:"policy-only",thinkingEffort:"extended"},newThreadPrecedence:"prefer_policy"}};
  assert.equal(world.schema.un(base,{slug:"policy-only",thinkingEffort:"extended"}),undefined);
  const before=world.schema.ay(base),after=world.schema.ay(projectCatalog(base,high,context()));
  assert.equal(before.slug,"policy-only");assert.equal(before.thinkingEffort,"extended");assert.deepEqual({...after},{...before});
});

test("TPP cache proof binds encoded identity key, actual read/write provider, schema, gate and 24-hour TTL",()=>{
  const input=policyFixture.owners.sMGP,source=input.moduleSource;
  const owner=inspectQueryOwner(source,input,auth);
  assert.deepEqual(owner.cacheImport,{localName:"o",moduleId:linked.cache.moduleId,writeExport:linked.cache.writeExport,readExport:linked.cache.readExport});
  assert.equal(owner.cacheProof.ttlMilliseconds,86400000);
  assert.equal(owner.cacheProof.schema.fetchedAt,"number");assert.equal(owner.cacheProof.schema.response,"unknown");
  const changes=[
    ['(0,o.TB)(i)','(0,o.TB)("foreign-user-account")'],
    ['(0,o.TB)(i)','(0,o.foreign)(i)'],
    ['(0,o.jx)(i,','(0,o.foreign)(i,'],
    ['o=n("kpIY")','o=n("foreign-cache")'],
    ['(0,o.TB)(i)','(0,l.TB)(i)'],
    ['${encodeURIComponent(n??"")}/${encodeURIComponent(t??"")}','${encodeURIComponent(t??"")}/${encodeURIComponent(n??"")}'],
    ['chatgpt-work-models-v1/','foreign-work-models-v1/'],
    ['encodeURIComponent(n??"")','String(n??"")'],
    ['encodeURIComponent(n??"")','encodeURIComponent(n)'],
    ['s=r&&e(p)?','s=e(p)?'],
    ['s=r&&e(p)?','s=r||e(p)?'],
    ['getServerSnapshot:()=>!1','getServerSnapshot:()=>!0'],
    ['h.safeParse((0,o.TB)(i))','h.parse((0,o.TB)(i))'],
    ['fetchedAt:i.number()','fetchedAt:i.unknown()'],
    ['response:i.unknown()','response:i.number()'],
    ['Date.now()-s.fetchedAt>=864e5','Date.now()-s.fetchedAt>=Infinity'],
    ['Date.now()-s.fetchedAt>=864e5','Date.now()-s.fetchedAt>=864e6'],
    ['Date.now()-s.fetchedAt>=864e5','Date.now()-i.fetchedAt>=864e5'],
    ['Date.now()-s.fetchedAt>=864e5','Date.now()-s.fetchedAt>864e5'],
  ];
  for(const [from,to]of changes){
    assert.ok(source.includes(from),from);const changed=source.replace(from,to);
    assert.doesNotThrow(()=>new vm.Script(`function factory(${input.params}){${changed}}`),from);
    assert.throws(()=>prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth),undefined,from);
  }
  for(const cache of [undefined,{...linked.cache,moduleId:"foreign"},{...linked.cache,readExport:"foreign"},{...linked.cache,writeExport:"foreign"}]){
    assert.throws(()=>prepareQueryFactory(source,input,high,{...linked,cache},auth),/cache provider binding mismatch/);
  }
});

test("TPP Date and encodeURIComponent resolve to globals at key/timestamp/TTL use sites",()=>{
  const input=policyFixture.owners.sMGP,source=input.moduleSource;
  const changedSignal=source.replace('queryFn:async({signal:e})=>{let a=await','queryFn:async({signal:Date})=>{let a=await').replace('signal:e}),s=(0,d.Ov)(a);return e.throwIfAborted()','signal:Date}),s=(0,d.Ov)(a);return Date.throwIfAborted()');
  const changedGetter=source.replace('({get:e})=>{let t=e(', '({get:encodeURIComponent})=>{let t=encodeURIComponent(').replace(/(?<![\w$.])e\(/gu,'encodeURIComponent(');
  const changes=[
    changedSignal,changedGetter,
    'let Date=foreign;'+source,'let encodeURIComponent=foreign;'+source,
    source.replace('=>{let t=e(a.','=>{let Date=foreign;let t=e(a.'),
    source.replace('=>{let t=e(a.','=>{let encodeURIComponent=foreign;let t=e(a.'),
    source+';Date=foreign',source+';encodeURIComponent=foreign',
    source+';function rebind(){Date=foreign}',source+';function rebind(){encodeURIComponent=foreign}',
    source+';function rebind(){D\\u0061te=foreign}',source+';function rebind(){encodeURIComp\\u006fnent=foreign}',
  ];
  for(const changed of changes){
    assert.doesNotThrow(()=>new vm.Script(`function factory(${input.params}){${changed}}`));
    assert.throws(()=>prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth));
  }
  for(const builtin of ["Date","encodeURIComponent"]){
    const changed=source.replace(/\bn\(/gu,`${builtin}(`).replace(/\bn\.d\(/gu,`${builtin}.d(`),params=["e","t",builtin];
    assert.doesNotThrow(()=>new vm.Script(`function factory(${params}){${changed}}`));
    assert.throws(()=>prepareQueryFactory(changed,{...input,params,moduleSource:changed},high,linked,auth),/builtin/);
  }
});

test("TPP paired local/export renames and unrelated true shadows/opaque keys remain qualified",()=>{
  const input=policyFixture.owners.sMGP,source=input.moduleSource;
  const changedSignal=source.replace('queryFn:async({signal:e})=>{let a=await','queryFn:async({signal:requestSignal})=>{let a=await').replace('signal:e}),s=(0,d.Ov)(a);return e.throwIfAborted()','signal:requestSignal}),s=(0,d.Ov)(a);return requestSignal.throwIfAborted()');
  const changedExports=source.replace('(0,o.TB)(i)','(0,o.readRenamed)(i)').replace('(0,o.jx)(i,','(0,o.writeRenamed)(i,');
  const owner=inspectQueryOwner(source,input,auth),reader=owner.readers[0];
  const renamedBody=reader.body.replace(/\bt\b/gu,'accountId').replace(/\bn\b/gu,'userId').replace(/\br\b/gu,'identityReady').replace(/\bi\b/gu,'cacheKey');
  const changedLocals=source.slice(0,reader.bodyStart)+renamedBody+source.slice(reader.bodyStart+reader.body.length);
  const unrelated=';function unrelated(Date,encodeURIComponent){Date=1;encodeURIComponent=2;return {Date,encodeURIComponent};}const opaque={Date:"Date=foreign",encodeURIComponent:/encodeURIComponent=foreign/};';
  for(const changed of [changedSignal,changedLocals,source+unrelated,source.replace('let a=await c.Request','function unrelated(Date,encodeURIComponent){Date=1;encodeURIComponent=2}let a=await c.Request')]){
    assert.equal(prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth).state,"pristine");
  }
  const renamed=prepareQueryFactory(changedExports,{...input,moduleSource:changedExports},high,{...linked,cache:{...linked.cache,readExport:"readRenamed",writeExport:"writeRenamed"}},auth);
  assert.equal(renamed.proof.cacheImport.readExport,"readRenamed");assert.equal(renamed.proof.cacheImport.writeExport,"writeRenamed");
});

test("owner lexical guard rejects brace/slash hidden ASCII and escaped owned writes",()=>{
  for(const input of [current,policyFixture.owners.sMGP,policyFixture.owners.lTvi]){
    const prepare=input===current?prepareCatalogFactory:prepareQueryFactory;
    const captured=input===current?"Array":"Date";
    for(const name of [captured,captured==='Array'?'Arr\\u0061y':'D\\u0061te']){
      const changed=input.moduleSource+`;const opaqueDivision={}/(${name}=foreign)/1;`;
      assert.doesNotThrow(()=>new vm.Script(`function factory(${input.params}){${changed}}`));
      assert.throws(()=>prepare(changed,{...input,moduleSource:changed},high,linked,auth),/Ambiguous slash/);
    }
    const ordinary=input.moduleSource+';const harmless="{}/(Date=foreign)/1";function local(Date){return `${Date}`;}';
    assert.equal(prepare(ordinary,{...input,moduleSource:ordinary},high,linked,auth).state,"pristine");
  }
});

test("original factory require/exports authority rejects compact, trivia and escaped rest writes",()=>{
  for(const input of [current,policyFixture.owners.sMGP,policyFixture.owners.lTvi]){
    const prepare=input===current?prepareCatalogFactory:prepareQueryFactory;
    for(const name of [input.params[2],input.params[1]]){
      const escaped='\\u'+name.codePointAt(0).toString(16).padStart(4,'0')+name.slice(1);
      for(const target of [`...${name}`,`... ${name}`,`.../*native probe*/${name}`,`...${escaped}`]){
        const changed=input.moduleSource+`;([${target}]=values);`;
        assert.doesNotThrow(()=>new vm.Script(`function factory(${input.params}){${changed}}`));
        assert.throws(()=>prepare(changed,{...input,moduleSource:changed},high,linked,auth));
        if(input!==current)assert.throws(()=>inspectQueryOwner(changed,{...input,moduleSource:changed},auth));
      }
    }
    const shadow=input.moduleSource+`;function local(n,t){([...n]=values);([...t]=values)}const opaqueRest="([...n]=values)";`;
    assert.equal(prepare(shadow,{...input,moduleSource:shadow},high,linked,auth).state,"pristine");
    assert.equal(prepare(input.moduleSource,input,high,linked,auth).state,"pristine");
  }
});

test("compact rest cannot rebind a captured query namespace or ambient cache builtin",()=>{
  const input=policyFixture.owners.sMGP;
  for(const name of ["d","o","Date","encodeURIComponent"]){
    const escaped='\\u'+name.codePointAt(0).toString(16).padStart(4,'0')+name.slice(1);
    for(const target of [`...${name}`,`... ${name}`,`.../*probe*/${name}`,`...${escaped}`]){
      const changed=input.moduleSource+`;([${target}]=values);`;
      assert.doesNotThrow(()=>new vm.Script(`function factory(${input.params}){${changed}}`));
      assert.throws(()=>prepareQueryFactory(changed,{...input,moduleSource:changed},high,linked,auth));
    }
  }
  const shadow=input.moduleSource+';function local(d,o,Date,encodeURIComponent){([...d]=values);([...o]=values);([...Date]=values);([...encodeURIComponent]=values)}';
  assert.equal(prepareQueryFactory(shadow,{...input,moduleSource:shadow},high,linked,auth).state,"pristine");
});

test("native catalog inspector closure uses the shared authority for schema, slider and parsed-input rest writes",()=>{
  const source=current.moduleSource;
  for(const name of ["T","A","o"]){
    const escaped='\\u'+name.codePointAt(0).toString(16).padStart(4,'0');
    for(const target of [`...${name}`,`... ${name}`,`.../*probe*/${name}`,`...${escaped}`]){
      const changed=source.replace('return{serviceTiersByModelSlug:',`([${target}]=values);return{serviceTiersByModelSlug:`);
      assert.doesNotThrow(()=>new vm.Script(`function factory(${current.params}){${changed}}`));
      assert.throws(()=>prepareCatalogFactory(changed,{...current,moduleSource:changed},high,linked,auth));
    }
  }
  const shadow=source.replace('return{serviceTiersByModelSlug:','function unrelated(T,A,o){([...T]=values);([...A]=values);([...o]=values)}return{serviceTiersByModelSlug:');
  assert.equal(prepareCatalogFactory(shadow,{...current,moduleSource:shadow},high,linked,auth).state,"pristine");
});
