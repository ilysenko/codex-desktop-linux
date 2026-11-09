"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto');
const C=require('./composer-config.js'),S=require('./composer-config-sources.js'),Main=require('./patch.js'),R=require('./local-resolver.js'),D=require('../copilot-reasoning-effort/dropdown-owner.js');
const fixture=require('./fixtures/current-composer-config.json'),providers=require('./fixtures/current-composer-config-sources.json').owners,refs=require('./fixtures/current-composer-config-references.json').owners,twuu=require('./fixtures/current-local-resolver.json'),iLYI=require('./fixtures/current-catalog-policy.json').owners.iLYI,localDeps=require('./fixtures/current-local-resolver-dependencies.json');
const {findRspackExportPublication:publication}=require('../../scripts/patches/lib/rspack-export-publication.js'),{findMatchingBrace,createJavaScriptLexicalIndex}=require('../../scripts/patches/lib/minified-js.js');
const plain=x=>JSON.parse(JSON.stringify(x)),sha=x=>crypto.createHash('sha256').update(x).digest('hex'),map=Main.THINKING_EFFORT_TO_EFFORT,presets=[{modelSlug:'model-new',thinkingEffort:'extended',isDefault:true},{modelSlug:'model-new',thinkingEffort:'standard',isDefault:false}],changed=(x,source)=>({...x,moduleSource:source});
let prepared;
function current(){return prepared??=C.prepareComposerFactory(fixture.moduleSource,fixture,presets,map);}
function ownRuntime(source){const start=source.indexOf('/*'+C.MARKER+'*/'),f=source.indexOf('function codexLinuxLocalDefaultPresetFallback',start),open=source.indexOf('{',f),end=findMatchingBrace(source,open)+1;assert(start>=0&&f>start&&end>open);const code=source.slice(start,end);return{code,...vm.runInNewContext(`(()=>{${code};return{config:codexLinuxLocalDefaultPresetConfig,select:codexLinuxLocalDefaultPresetSelection,fallback:codexLinuxLocalDefaultPresetFallback};})()`)};}
function chunk(modules){return'export const __webpack_modules__={'+modules.map(x=>JSON.stringify(x.moduleId)+'('+x.params+'){'+x.moduleSource+'}').join(',')+'};';}
function allModules(){const seen=new Set;return[fixture,...Object.values(providers),...Object.values(refs),twuu,iLYI].filter(x=>!seen.has(x.moduleId)&&seen.add(x.moduleId));}
function scene(files,run){const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'up59-test-')),assets=path.join(root,'webview/assets');fs.mkdirSync(assets,{recursive:true});try{for(const[n,s]of Object.entries(files)){const p=path.join(assets,n);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s,{mode:0o640});}return run(root,assets);}finally{fs.rmSync(root,{recursive:true,force:true});}}
function dataScene(extra={}){return{'current.js':chunk(allModules()),...extra};}
function unchanged(assets,input){for(const[n,s]of Object.entries(input)){assert.equal(fs.readFileSync(path.join(assets,n),'utf8'),s);assert.equal(fs.statSync(path.join(assets,n)).mode&0o777,0o640);}}
function testCommit(key,valueMap=true){return'let selected={},conversation={};n.d(t,'+(valueMap?'{nx:()=>selected,homeConversationId$:()=>conversation},':'{nx:()=>selected,homeConversationId$:()=>conversation,'+key+':async function(store,choice,bridge,drop){let state=store.get(selected),v=store.get(conversation);await bridge(choice)}},')+'{'+(valueMap?key+':async function(store,choice,bridge,drop){let state=store.get(selected),v=store.get(conversation);await bridge(choice)}':'')+'});';}

test('async publication is the exact direct value-map member, never a name suffix or getter',()=>{
 for(const key of ['rp','unrelated_rp','rp_suffix','$rp','λrp']){const source=testCommit(key);assert.doesNotThrow(()=>new vm.Script(`function f(e,t,n){${source}}`));const call=()=>C.inspectHomeCommit(source,{moduleId:'test',params:['e','t','n'],moduleSource:source},{exportName:'rp',selectedExport:'nx'});if(key==='rp')assert.equal(call().exportName,'rp');else assert.throws(call);}
 const source=testCommit('rp',false);assert.throws(()=>C.inspectHomeCommit(source,{moduleId:'test',params:['e','t','n'],moduleSource:source},{exportName:'rp',selectedExport:'nx'}));
});

test('actual caller prepares, inverses and replays exactly; empty audit and invalid user settings preserve data',()=>{
 assert.equal(sha(fixture.moduleSource),fixture.bodySha256);const before=JSON.stringify(fixture),a=current(),b=C.prepareComposerFactory(a.patchedSource,changed(fixture,a.patchedSource),presets,map);assert.equal(a.state,'pristine');assert.equal(b.state,'applied');assert.equal(b.nativeSource,fixture.moduleSource);assert.equal(b.patchedSource,a.patchedSource);assert.equal(JSON.stringify(fixture),before);
 assert.equal(C.prepareComposerFactory(fixture.moduleSource,fixture,[],map).patchedSource,fixture.moduleSource);assert.throws(()=>C.prepareComposerFactory(a.patchedSource,changed(fixture,a.patchedSource),[],map));
 assert.throws(()=>C.prepareComposerFactory(a.patchedSource,changed(fixture,a.patchedSource),[{...presets[0],thinkingEffort:'standard'}],map));
 for(const raw of [[],null,[{model:'x',effort:'wrong',default:true}],[{model:'x',effort:'high'}]])assert.throws(()=>Main.patchLocalComposerConfig('/never-read',{feature:{settings:{presets:raw}}}),/presets|default|effort/);
});

test('the native Default callback belongs to the rendered Fragment child',()=>{
 const original=fixture.moduleSource;
 for(const value of ['onSelectDefault:lk,','modelOptionsDisabled:tt,','reasoningEffortDisabled:ti,','lz=(0,o.jsx)(o.Fragment,{children:']){
  assert.equal(original.split(value).length,2,value);
 }
 const ghost='(0,o.jsx)(D.i,{model:nX,modelOptions:n5,reasoningEffort:oS,selectionMode:oP,onSelectDefault:lk,modelOptionsDisabled:tt,reasoningEffortDisabled:ti})';
 const mutant=original.replace('onSelectDefault:lk,','onSelectDefault:void 0,')
  .replace('modelOptionsDisabled:tt,','"modelOptionsDisabled":tt,')
  .replace('reasoningEffortDisabled:ti,','"reasoningEffortDisabled":ti,')
  .replace('lz=(0,o.jsx)(o.Fragment,{children:',`lz=(0,o.jsx)(o.Fragment,{ghost:${ghost},children:`);
 new vm.Script(`function nativeCaller(${fixture.params.join(',')}){${mutant}}`);
 const {rspackModuleFactories}=require('../../scripts/patches/lib/rspack-module-assets.js');
 const [snapshot]=rspackModuleFactories(chunk([changed(fixture,mutant)]),'quoted-key-ghost.js');
 assert.equal(snapshot.moduleSource,mutant);
 assert.throws(()=>C.prepareComposerFactory(mutant,snapshot,presets,map),/literal returned Fragment child/);
});

test('own config keeps public efforts and UTF16 data values without exposing sibling marker text',()=>{
 const efforts=['none','low','medium','high','xhigh','max','ultra'],input=Main.normalizePresets({feature:{settings:{presets:efforts.map((effort,i)=>({model:`model-${effort}`,effort,default:i===0}))}}});assert.deepEqual(Main.localComposerConfig(input).presets[0].map(x=>x.reasoning_effort),efforts);assert.equal(Main.localComposerConfig(input).codexLinuxDefaultPresets,true);
 const model='opaque"}/*codexLinuxCopilotEffortDropdown*/{\\\n🦊',p=[{modelSlug:model,thinkingEffort:'zero',isDefault:true}],a=C.prepareComposerFactory(fixture.moduleSource,fixture,p,map),runtime=ownRuntime(a.patchedSource);assert.deepEqual(plain(runtime.config),Main.localComposerConfig(p));assert.equal(a.patchedSource.includes(model),false);assert.equal(a.patchedSource.includes('codexLinuxCopilotEffortDropdown'),false);
 const sibling=D.applyDropdownModule(a.patchedSource,changed(fixture,a.patchedSource));assert.equal(D.dropdownModuleState(sibling,changed(fixture,sibling)).kind,'patched');assert.equal(C.prepareComposerFactory(sibling,changed(fixture,sibling),p,map).state,'applied');
});

function nativeModels(){
 const owner=R.localResolverState(twuu.moduleSource,twuu).owner,patched=R.applyLocalResolver(twuu.moduleSource,twuu),pub=publication(changed(twuu,patched),owner.key),g=owner.groups;
 const dep=localDeps.owners??localDeps,predicate=dep.FQih??dep.predicate,formatter=dep.O5Ra??dep.formatter;
 const predPub=publication(predicate,owner.imports.predicate.exportName),fmtPub=publication(formatter,owner.imports.formatter.exportName);
 const predicateFn=vm.runInNewContext('('+predicate.moduleSource.slice(predPub.fn.start,predPub.fn.end)+')'),formatFn=vm.runInNewContext('('+formatter.moduleSource.slice(fmtPub.fn.start,fmtPub.fn.end)+')');
 const uniqBy=(values,key)=>{const seen=new Set;return values.filter(value=>{const id=key(value);if(seen.has(id))return false;seen.add(id);return true;});}; // Controlled vendor behavior, not vendor-body verification.
 const env={[g.unique]:()=>uniqBy,[owner.imports.predicate.localName]:{[owner.imports.predicate.exportName]:predicateFn},[owner.imports.formatter.localName]:{[owner.imports.formatter.exportName]:formatFn}};
 const qv=vm.runInNewContext(`let ${g.fallbackA}=${owner.first.source},${g.fallbackB}=${owner.second.source};${owner.normalizer.source}${owner.intersection.source};(${patched.slice(pub.fn.start,pub.fn.end)})`,env);
 const fallbackKey='Pd',fb=publication(twuu,fallbackKey).expression,source=twuu.moduleSource,h=new RegExp(`function ${fb}\\([^)]*\\)\\{`).exec(source),end=findMatchingBrace(source,h.index+h[0].length-1),fn=source.slice(h.index,end+1),family=/function ([A-Za-z_$][\w$]*)\(e\)\{return o\.test\(e\)\}/u.exec(source)?.[1]??'p';
 const fallback=vm.runInNewContext('('+fn+')',{[family]:model=>/(?:^|[-_.])sol(?:$|[-_.])/iu.test(model)});return{qv,fallback,patched};
}
let modelsWorld;const world=()=>modelsWorld??=nativeModels();

test('actual57 native intersection retains unsupported-pair and one-pair semantics',()=>{
 const w=world(),runtime=ownRuntime(current().patchedSource),models=[{model:'model-new',displayName:'GPT Model',supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],result=w.qv(models,{sliderModelsConfig:runtime.config});assert.deepEqual(plain(result).map(x=>x.id),['model-new:high','model-new:medium']);assert.equal(runtime.fallback(true,result,'model-new:medium'),'model-new:high');
 const wrong=C.composerConfig([{modelSlug:'model-new',thinkingEffort:'ultra',isDefault:true}],map),fallbackModels=[{model:'gpt-5.6-sol',displayName:'GPT Sol',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],native=w.qv(fallbackModels,{}),unsupported=w.qv(fallbackModels,{sliderModelsConfig:wrong});assert.deepEqual(plain(unsupported),plain(native));assert(unsupported.every(x=>x.id!=='model-new:ultra'));
 const one=C.composerConfig([presets[0]],map);assert.equal(w.qv(models,{sliderModelsConfig:one}).length,1);assert.deepEqual(plain(w.qv(models,{sliderModelsConfig:{...one,codexLinuxDefaultPresets:false}})),[]);
});

function nativeCallback(source,pattern){const h=pattern.exec(source);assert(h);const open=h.index+h[0].length-1,end=findMatchingBrace(source,open);return source.slice(h.index,end+1);}
function sourceReaders(options={}){
 const proof=current().proof,p=S.inspectConfigProvider(providers.agZi.moduleSource,providers.agZi,{globalExport:proof.query.globalExport,localExport:proof.query.localExport}),id=Symbol('identity'),experiment=Symbol('experiment'),effective=Symbol('effective'),override=Symbol('override'),reserve=Symbol('reserve'),global=Symbol('global');
 const identity={authMethod:'chatgpt',authLoading:false,hasChatGptToken:true,authenticatedAccountId:'account',userId:'user',...options.identity},nativeConfig={presets:[[{model:'upstream',reasoning_effort:'medium'}]]},raw=options.raw??{model_provider:'openai'};
 const overlay=S.inspectProfileOverlay(providers.OeLR.moduleSource,providers.OeLR,{exportName:'Y$'}),parser=/function ([A-Za-z_$][\w$]*)\(/u.exec(overlay.proof.parserSource)[1],schema=/^([A-Za-z_$][\w$]*)=/u.exec(overlay.proof.schemaSource)[1];
 const over=vm.runInNewContext(`${overlay.proof.parserSource};(${overlay.proof.functionSource})`,{[schema]:{safeParse:value=>({success:value!=null&&typeof value==='object'&&!Array.isArray(value),data:value})}}),config=over(raw);
 const bo=S.inspectModelCatalogPredicate(providers.OeLR.moduleSource,providers.OeLR,{exportName:'bo'}),catalogPredicate=vm.runInNewContext('('+bo.proof.functionSource+')'),schemaName=/let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.safeParse/u.exec(p.proof.globalSource)[1],calls=[];
 const get=(key,arg)=>{calls.push({key,arg});if(key===id)return identity;if(key===experiment)return{value:nativeConfig};if(key===effective)return{data:config};if(key===override)return options.providerOverride;if(key===reserve)return options.reserve??false;if(key===global)return globalFn({get});throw Error('Unknown native source read');};
 const globalCallback=nativeCallback(p.proof.globalSource,/\(\{get:[A-Za-z_$][\w$]*\}\)=>\{/u),localCallback=nativeCallback(p.proof.localSource,/\(\{conversationId:[A-Za-z_$][\w$]*,hostId:[A-Za-z_$][\w$]*,cwd:[A-Za-z_$][\w$]*\},\{get:[A-Za-z_$][\w$]*\}\)=>\{/u);
 const globalFn=vm.runInNewContext('('+globalCallback+')',{[p.refs.identity.localName]:{[p.refs.identity.exportName]:id},[p.refs.experiment.localName]:{[p.refs.experiment.exportName]:experiment},[schemaName]:{safeParse:()=>({success:options.validSchema!==false,data:options.empty?{presets:[[]]}:nativeConfig})}}),localFn=vm.runInNewContext('('+localCallback+')',{[p.refs.effectiveConfig.localName]:{[p.refs.effectiveConfig.exportName]:effective},[p.refs.providerOverride.localName]:{[p.refs.providerOverride.exportName]:override},[p.refs.catalogPredicate.localName]:{[p.refs.catalogPredicate.exportName]:catalogPredicate},[p.refs.reserve.localName]:{[p.refs.reserve.exportName]:reserve},[p.global.atomName]:global});
 const local=Symbol('local selector'),cloud=Symbol('global selector'),q=proof.query,env={
 [q.cloudFlag]:options.context!=null,[q.auth]:{authMethod:Object.hasOwn(options,'hostAuth')?options.hostAuth:'chatgpt'},[q.managed]:options.managed??null,[q.contextArgs]:{conversationId:options.conversation??null,hostId:options.host??'local',cwd:options.cwd??'/workspace'},
 [q.provider]:{[q.localExport]:local,[q.globalExport]:cloud},[q.framework]:{[q.scopedReader]:(selector,arg)=>selector==null?null:localFn(arg,{get}),[q.plainReader]:selector=>selector==null?null:globalFn({get})}};
 const values=vm.runInNewContext(`(()=>{${proof.fragments.sourceReaders};return{local:${q.local},cloud:${q.cloud},selected:${q.cloudFlag}?${q.cloud}:${q.local}}})()`,env);return{...values,calls,config,raw,effective};
}

test('actual caller source switches and auth negatives preserve native branch identity',()=>{
 assert(sourceReaders().selected);for(const hostAuth of ['apikey','copilot','personalAccessToken',null]){const r=sourceReaders({hostAuth});assert.equal(r.selected,null);assert.equal(r.calls.length,0);}
 for(const identity of[{authLoading:true},{authMethod:'apikey'},{authMethod:'copilot'},{hasChatGptToken:false},{authenticatedAccountId:null},{userId:null}])assert.equal(sourceReaders({context:'account',identity}).selected,null);
 assert(sourceReaders({context:'account',hostAuth:'apikey'}).selected);assert(sourceReaders({context:false,hostAuth:'copilot'}).selected);assert(sourceReaders({context:'runtime',managed:{isAeon:true}}).selected);assert.equal(sourceReaders({managed:{isAeon:true}}).selected,null);assert(sourceReaders({context:'account',identity:{hasChatGptToken:undefined}}).selected);
 assert.equal(sourceReaders({host:'remote'}).selected,null);assert.equal(sourceReaders({validSchema:false}).selected,null);assert.equal(sourceReaders({empty:true}).selected,null);
});

test('native selected-profile overlay and host/cwd/provider/catalog guards keep original query scope',()=>{
 const raw={profile:'custom',model_provider:'openai',profiles:{custom:{model_provider:'other'},native:{model_provider:'openai',model_catalog_json:null}}},custom=sourceReaders({raw,conversation:'thread',cwd:'/one'});assert.equal(custom.selected,null);assert.equal(raw.model_provider,'openai');
 const native=sourceReaders({raw:{...raw,profile:'native'},conversation:'thread',cwd:'/two'});assert(native.selected);const read=native.calls.find(x=>x.key===native.effective);assert.deepEqual(plain(read.arg),{hostId:'local',cwd:'/two'});assert.equal('profile'in read.arg,false);
 assert.equal(sourceReaders({raw:{model_provider:'openai',model_catalog_json:'{}'}}).selected,null);assert(sourceReaders({raw:{model_provider:'openai',model_catalog_json:'  '}}).selected);assert.equal(sourceReaders({providerOverride:'other'}).selected,null);assert.equal(sourceReaders({reserve:true}).selected,null);
});
function preparedMemo(a){const native=a.proof.fragments.defaultMemo,head=native.slice(0,native.indexOf('()=>{')+5),start=a.patchedSource.indexOf(head);assert(start>=0);const open=start+head.length-1,end=findMatchingBrace(a.patchedSource,open),tail=native.slice(native.lastIndexOf('},')+1);assert(a.patchedSource.startsWith(tail,end+1));return a.patchedSource.slice(start,end+1+tail.length);}
function renderDefault(a,cache,context){
 const p=a.proof,s=p.selector,r=ownRuntime(a.patchedSource),vars=new Map([[p.imports.models.localName,'input.modelsNamespace'],[p.memo.cache,'input.cache'],[p.query.cloudFlag,'input.context!=null'],[p.query.local,'input.local'],[p.query.cloud,'input.cloud'],[p.defaultRecord.value,'input.defaultModel'],[p.qv.choices,'input.choices'],[s.before,'input.before'],[s.store,'input.store'],[p.state.select,'input.base'],[p.query.managed,'input.managed'],[p.props.conversation,'input.conversation'],[p.current.model,'input.currentModel'],[p.current.effort,'input.currentEffort'],[s.premium,'input.premium'],[s.sentinelNamespace,`{${s.sentinelExport}:"native-auto-proxy"}`],[s.autoNamespace,`{${s.autoExport}:"native-auto"}`],[s.event.namespace,`{${s.event.exportName}:()=>{}}`],[s.event.enumNamespace,'{CodexComposerModelChanged:"native-model",CodexComposerReasoningEffortChanged:"native-effort"}'],[s.modeNamespace,`{${s.modeExport}:"native-mode"}`]]);
 const source=`(function(input){${r.code};let ${[...vars].map(([name,value])=>name+'='+value).join(',')};${p.fragments.normalizer};let ${s.name}=${p.fragments.setter},${p.callback};${preparedMemo(a)};return {callback:${p.callback},setter:${s.name}};})`;
 return vm.runInNewContext(source)({cache,modelsNamespace:{[p.fallbackExport]:world().fallback},...context});
}

test('actual Default memo refreshes same-list callbacks on config/profile/host changes through fresh native setter',async()=>{
 const a=current(),cache=Array(a.proof.memo.size),calls=[],modes=[],store={get:()=>true,set:(key,value)=>modes.push([key,value])},choices=[{id:'model-new:medium',model:'model-new',reasoningEffort:'medium'},{id:'model-new:high',model:'model-new',reasoningEffort:'high'}],base={context:null,local:{},cloud:null,defaultModel:{model:'model-new',defaultReasoningEffort:'medium'},choices,before:()=>true,store,base:(...args)=>{calls.push(args);return Promise.resolve(true)},managed:null,conversation:null,currentModel:'model-new',currentEffort:'medium',premium:false};
 const first=renderDefault(a,cache,base);first.callback();assert.equal(calls.at(-1)[1],'high');assert.equal(calls.at(-1)[3],undefined);
 const second=renderDefault(a,cache,{...base,local:null,conversation:'new-host-thread'});assert.notEqual(first.setter,second.setter);assert.notEqual(first.callback,second.callback);second.callback();assert.equal(calls.at(-1)[1],'medium');assert.deepEqual(modes.at(-1),['native-mode','default']);
 const denied=renderDefault(a,cache,{...base,before:()=>false}),count=calls.length;denied.callback();assert.equal(calls.length,count);
 const delegate=[];renderDefault(a,cache,{...base,context:'account',cloud:{},local:null,managed:{isAeon:true,selectModelAndReasoningEffort:(...args)=>{delegate.push(args);return Promise.resolve(true)}}}).callback();assert.equal(delegate[0][1],'high');
 const profileCalls=[];renderDefault(a,cache,{...base,base:(...args)=>{profileCalls.push({profile:'changed',host:'remote',args});return Promise.resolve(true)}}).callback();assert.equal(profileCalls[0].args[0],'model-new');assert.equal(profileCalls[0].args[1],'high');assert.equal(profileCalls[0].args[3],undefined);
});

test('actual local disabled expressions retain loading, locked, Copilot and error controls',()=>{
 const p=current().proof,g=p.fragments.guards.disabled,src=p.fragments.guards.disabledSource,run=options=>vm.runInNewContext(`(()=>{let ${src};return{model:${g.modelDisabled},effort:${g.effortDisabled}}})()`,{[g.loading]:options.loading??false,[g.status]:options.status??'success',[g.blocked]:options.blocked??false,[p.query.managed]:options.managed??null});
 assert.deepEqual(plain(run({})),{model:false,effort:false});assert.deepEqual(plain(run({loading:true})),{model:true,effort:true});assert.equal(run({status:'error'}).model,true);assert.equal(run({blocked:true}).effort,true);assert.deepEqual(plain(run({managed:{isModelLocked:true,lockedReasoningEffort:'high'}})),{model:true,effort:true});
});

test('actual home conversion bridge refuses pending/unsupported pairs and preserves native selection metadata',async()=>{
 const p=current().proof,b=p.fragments.guards.bridge,selector=p.selector,events=[],nativeMapper=publication(refs.SGof,'D'),fn=refs.SGof.moduleSource.slice(nativeMapper.fn.start,nativeMapper.fn.end),names=/i\.QW/u.test(fn)?'i':'i',mapper=vm.runInNewContext('('+fn+')',{i:{QW:{zero:'none',standard:'medium',extended:'high'}},n:{Ux:{safeParse:value=>({success:['zero','standard','extended'].includes(value),data:value})}}});
 const vars={[b.mapper.localName]:{[b.mapper.exportName]:mapper},[b.rawModels]:{models:[{model:'model-new'}]},[b.models]:[{model:'model-new',supportedReasoningEfforts:[{reasoningEffort:'high'}]}],[p.fragments.guards.disabled.loading]:false,[selector.before]:()=>true,[selector.name]:(...args)=>{events.push(args);return Promise.resolve(true)},[selector.store]:{get:()=>({warning:()=>{}})},B:{Id:'toast'},o:{jsx:()=>({})},h:{A:{}}};
 const execute=values=>vm.runInNewContext('('+b.functionSource+')',{...vars,...values});assert.equal(await execute({})({slug:'model-new',thinkingEffort:'extended'}),true);assert.equal(events[0][1],'high');assert.deepEqual(plain(events[0][2]),{persistAsDefault:false});
 const count=events.length;assert.equal(await execute({[p.fragments.guards.disabled.loading]:true})({slug:'model-new',thinkingEffort:'extended'}),false);assert.equal(await execute({})({slug:'missing',thinkingEffort:'extended'}),false);assert.equal(await execute({})({slug:'model-new',thinkingEffort:'ultra'}),false);assert.equal(events.length,count);
});

test('same actual51 gate and59 contribution compose in both orders; marker data stays opaque',()=>{
 const base=current(),after51=D.applyDropdownModule(base.patchedSource,changed(fixture,base.patchedSource)),first51=D.applyDropdownModule(fixture.moduleSource,fixture),a=C.prepareComposerFactory(first51,changed(fixture,first51),presets,map),b=C.prepareComposerFactory(after51,changed(fixture,after51),presets,map);assert.equal(a.patchedSource,after51);assert.equal(b.state,'applied');assert.equal(b.nativeSource,first51);assert.equal(D.dropdownModuleState(after51,changed(fixture,after51)).kind,'patched');
 const drift=fixture.moduleSource.replace('"copilot"||','"other"||');assert.throws(()=>C.prepareComposerFactory(drift,changed(fixture,drift),presets,map));
});

test('actual use-site namespace and normalizer captures reject paired formal changes',()=>{
 const p=current().proof,changes=[fixture.moduleSource.replace(p.fragments.normalizer,p.fragments.normalizer.replace(/\be\b/gu,'G')),fixture.moduleSource.replace(p.fragments.setter,p.fragments.setter.replace(/\be\b/gu,p.normalizer)),fixture.moduleSource.replace(p.fragments.defaultCallback,p.fragments.defaultCallback.replace(/\be\b/gu,p.qv.namespace))];
 for(const source of changes){assert.doesNotThrow(()=>new vm.Script(`function native(${fixture.params}){${source}}`));assert.throws(()=>C.prepareComposerFactory(source,changed(fixture,source),presets,map));}
 const poisoned=fixture.moduleSource.replace(`${p.state.select}(${p.normalizer}(`,`${p.state.setDefault}(${p.normalizer}(`);assert.throws(()=>C.prepareComposerFactory(poisoned,changed(fixture,poisoned),presets,map));
});

test('all physical owner and native source references close before writes, with canonical57 support',()=>{
 const input=dataScene({'peer/owner.js':chunk([fixture]),'peer/config.js':chunk([providers.agZi])});scene(input,(root,assets)=>{const first=C.patchComposerConfig(root,presets,map);assert.equal(first.matched,2);assert.equal(first.changed,2);assert(first.dependencies.find(x=>x.id==='config-sources').matched===2);const before=fs.readFileSync(path.join(assets,'current.js'));assert.equal(C.patchComposerConfig(root,presets,map).changed,0);assert.deepEqual(fs.readFileSync(path.join(assets,'current.js')),before);assert.equal(fs.statSync(path.join(assets,'current.js')).mode&0o777,0o640);});
 const patched=R.applyLocalResolver(twuu.moduleSource,twuu),canon={'current.js':chunk(allModules().map(x=>x.moduleId===twuu.moduleId?changed(x,patched):x))};scene(canon,root=>assert.equal(C.patchComposerConfig(root,presets,map).changed,1));
 for(const extra of [{'peer/bad.js':chunk([changed(fixture,'const damaged=true;')])},{'peer/bad-config.js':chunk([changed(providers.agZi,'const damaged=true;')])},{'orphan.js':'const orphan="'+C.MARKER+'";'}]){const files=dataScene(extra);scene(files,(root,assets)=>{assert.throws(()=>C.patchComposerConfig(root,presets,map));unchanged(assets,files);});}
});

test('mixed or stale contributions and partial second writes are rejected or rolled back transactionally',()=>{
 const mixed=dataScene({'peer/owner.js':chunk([changed(fixture,current().patchedSource)])});scene(mixed,(root,assets)=>{assert.throws(()=>C.patchComposerConfig(root,presets,map));unchanged(assets,mixed);});
 const input=dataScene({'peer/owner.js':chunk([fixture])});scene(input,(root,assets)=>{let writes=0;assert.throws(()=>C.patchComposerConfig(root,presets,map,{writeFileSync(file,bytes){if(++writes===2){fs.writeFileSync(file,bytes.slice(0,7));throw Error('partial second device write')}fs.writeFileSync(file,bytes)}}),/partial second/);unchanged(assets,input);});
});

test('unchanged native home commit retains its selected-state, client-ready, permission and post-await checks',async()=>{
 const value=C.inspectHomeCommit(iLYI.moduleSource,iLYI,{exportName:'rp',selectedExport:'nx'}),selected=publication(iLYI,'nx').expression,conversation=publication(iLYI,'homeConversationId$').expression;
 const state={isPending:false,isCommitting:false,selectedModel:{slug:'old'},models:{modelConfigBySlug:{'model-new':{isWorkModeModel:true}},available:true},mode:'work'},keys={selected:{},conversation:{},account:{},user:{},permission:{},pending:{}},events=[],data=new Map([[keys.selected,state],[keys.conversation,'thread'],[keys.account,'account'],[keys.user,'user'],[keys.permission,{status:'allowed'}]]);
 const store={get:key=>data.get(key),set:(key,value)=>events.push([key,value])},env={[selected]:keys.selected,[conversation]:keys.conversation,i:{chatGptAuthenticatedAccountId$:keys.account,chatGptAuthenticatedUserId$:keys.user},a:{xI:keys.permission},T:{f5:(models)=>models.available,is:()=>events.push(['commit'])},V:()=>false,G:keys.pending,_:{L9:()=>{}},f:{JQ:()=>true}};
 const commit=vm.runInNewContext('('+value.source+')',env),choice={slug:'model-new',thinkingEffort:'extended'};let bridges=0;const bridge=async()=>{bridges++;return true};assert.equal(await commit(store,choice,bridge,null),true);assert.equal(bridges,1);assert.deepEqual(events.at(-1),[keys.pending,null]);
 for(const invalid of [{...state,isPending:true},{...state,isCommitting:true},{...state,selectedModel:null},{...state,models:{...state.models,available:false}}]){data.set(keys.selected,invalid);const before=bridges;assert.equal(await commit(store,choice,bridge,null),false);assert.equal(bridges,before);}
 data.set(keys.selected,state);data.set(keys.permission,{status:'blocked'});assert.equal(await commit(store,choice,bridge,null),false);data.set(keys.permission,{status:'allowed'});
 assert.equal(await commit(store,choice,async()=>{data.set(keys.account,'other-account');return true},null),false);assert.deepEqual(events.at(-1),[keys.pending,null]);
});
