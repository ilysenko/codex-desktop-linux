"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),os=require('node:os');
const Default=require('./upstream-default-selection.js'),Policy=require('./catalog-policy.js'),Authority=require('./native-catalog-authority.js');
const owner=require('./fixtures/current-default-selection.json'),predicate=require('./fixtures/current-default-model-predicate.json'),catalog=require('./fixtures/current-chatgpt-catalog.json'),fixtures=require('./fixtures/current-catalog-policy.json'),chain=require('./fixtures/current-preset-query-chain.json');
const {findMatchingBrace}=require('../../scripts/patches/lib/minified-js.js'),{findRspackExportPublication}=require('../../scripts/patches/lib/rspack-export-publication.js'),{findRspackRequireBinding}=require('../../scripts/patches/lib/rspack-module-assets.js');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex'),plain=v=>JSON.parse(JSON.stringify(v));
const presets=[{modelSlug:'model-new',thinkingEffort:'extended',isDefault:true}];
function chunk(modules){return'export const __webpack_modules__={'+modules.map(m=>`${JSON.stringify(m.moduleId)}(${m.params.join(',')}){${m.moduleSource}}`).join(',')+'};';}
function named(source,name){const h=new RegExp(`\\bfunction ${name}\\([^)]*\\)\\{`).exec(source);assert(h,name);return source.slice(h.index,findMatchingBrace(source,h.index+h[0].length-1)+1);}
function ownerWith(source){return{...owner,moduleSource:source};}
function nativeHelpers(){
 const pub=key=>findRspackExportPublication(catalog,key),collector=pub('hX').expression,resolve=pub('un').expression,cap=pub('iC').fn;
 const helpers=vm.runInNewContext(`${named(catalog.moduleSource,collector)}${named(catalog.moduleSource,resolve)};({collector:${collector},resolve:${resolve},capability:(${catalog.moduleSource.slice(cap.start,cap.end)})})`);
 const w=fixtures.owners.Bl5H,classifier=fixtures.owners.vw1R,enumOwner=fixtures.owners.WPra,mapOwner=fixtures.owners.LLIt;
 const classifyName=findRspackExportPublication(classifier,'o').expression,plans=JSON.parse(/^let [\w$]+=(\[[^;]+\]);/.exec(classifier.moduleSource)[1]);
 const classify=vm.runInNewContext(`(${named(classifier.moduleSource,classifyName)})`,{r:plans}),order=JSON.parse(/\.enum\((\[[^;]+?\])\)/.exec(enumOwner.moduleSource)[1]);
 const names=vm.runInNewContext(`(${/let s=(\{[^;]+\});/.exec(mapOwner.moduleSource)[1]})`),efforts=JSON.parse(/p=[\w$]+\.enum\((\[[^;]+?\])\)/.exec(catalog.moduleSource)[1]);
 const j=findRspackExportPublication(w,'j').fn,workspace=vm.runInNewContext(`(${w.moduleSource.slice(j.start,j.end)})`,{r:{_:{options:order}},i:{o:classify},a:{QW:names},s:{hX:helpers.collector,Ux:{safeParse:value=>({data:efforts.includes(value)?value:undefined})}}});
 return{...helpers,workspace,names};
}
const native=nativeHelpers();
function context(overrides={}){return{ready:true,plan:'plus',visibleEfforts:new Set(['medium','high','xhigh']),reasoningEffortNames:native.names,resolveNative:native.resolve,clampCapability:native.capability,clampWorkspace:native.workspace,...overrides};}
function base(){const option={slug:'model-new',thinkingEffort:'standard',title:'Model',isAvailable:true};return{options:[option],internalOptions:[],versionOptions:[],sliderSettings:[{modelSlug:'model-new',thinkingEffort:'standard'}],defaultModelSlug:'model-new',defaultThinkingEffortByModelSlug:{'model-new':'standard'},modelConfigBySlug:{'model-new':{thinkingEfforts:[{thinking_effort:'standard'},{thinking_effort:'extended',short_label:'High'}]}}};}
// Controlled test behavior for the unchanged vendor call; this is not an
// execution or verification of the bundled i5ac vendor algorithm.
const uniqBy=(items,key)=>{const seen=new Set;return items.filter(item=>{const id=typeof key==='function'?key(item):item[key];if(seen.has(id))return false;seen.add(id);return true;});};
function nativeWorld(){
 const prepared=Policy.prepareCatalogFactory(catalog.moduleSource,catalog,presets,{},Authority),snapshot={...catalog,moduleSource:prepared.patchedSource};
 const collector=findRspackExportPublication(snapshot,'hX').expression,resolve=findRspackExportPublication(snapshot,'un').expression;
 const lookup=vm.runInNewContext(`${named(prepared.patchedSource,collector)}${named(prepared.patchedSource,resolve)};${resolve}`,{[Policy.constants.RESOLVE]:Policy.resolveVariant});
 const p=findRspackExportPublication(predicate,'GA').expression,predicateFn=vm.runInNewContext(`${named(predicate.moduleSource,p)};${p}`,{o:/(?:^|[-_.])sol(?:$|[-_.])/iu});
 const schema={un:lookup,ie:vm.runInNewContext(`(${named(catalog.moduleSource,'N')})`),Jk:vm.runInNewContext(`(${named(catalog.moduleSource,'S')})`)};
 const ay=findRspackExportPublication(snapshot,'ay').fn,xe=findRspackExportPublication(catalog,'xe').fn;
 schema.ay=vm.runInNewContext(`(${prepared.patchedSource.slice(ay.start,ay.end)})`,{v:lookup,N:schema.ie});
 schema.xe=vm.runInNewContext(`${named(catalog.moduleSource,'w')};(${catalog.moduleSource.slice(xe.start,xe.end)})`);
 const main=findRspackExportPublication(owner,'nX').fn,functions=['o','l','u'].map(n=>named(owner.moduleSource,n)).join('');
 const build=vm.runInNewContext(`${functions};(${owner.moduleSource.slice(main.start,main.end)})`,{i:()=>uniqBy,s:schema,a:{GA:predicateFn}});
 const ll=fixtures.owners.LLIt,th=findRspackExportPublication(ll,'th').fn;
 const power=vm.runInNewContext(`${named(ll.moduleSource,'o')};(${ll.moduleSource.slice(th.start,th.end)})`,{s:native.names,a:schema,i:{Pd:()=>undefined,GA:predicateFn}});
 const p4=chain.p4N2,availablePub=findRspackExportPublication(p4,'f5'),available=vm.runInNewContext(`(${named(p4.moduleSource,availablePub.expression)})`,{d:schema,u:{P:()=>{throw Error('unexpected instant category');}}});
 const keys={home:{},fallback:{},plan:{}};
 const choose=vm.runInNewContext(`(function(o,e){let n,u;${chain.normalNewThreadPolicy.source};${fixtures.consumerFragments.newThreadDefault.source};return n;})`,{A:schema,D:{j:native.workspace},T:{lB:keys.home,eg:keys.fallback,f5:available},i:{e0:keys.plan},E:{nX:build},I:{th:power}});
 return{lookup,build,power,choose:(data,get)=>choose({data},get),keys};
}
const world=nativeWorld();
function scene(files,callback){
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'up54-default-test-')),assets=path.join(root,'webview/assets');fs.mkdirSync(assets,{recursive:true});
 try{for(const [name,source]of Object.entries(files)){const file=path.join(assets,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source,{mode:0o640});}return callback(root,assets);}finally{fs.rmSync(root,{recursive:true,force:true});}
}
const files=()=>({'owner.js':chunk([owner]),'catalog.js':chunk([catalog]),'predicate.js':chunk([predicate])});
function unchanged(assets,input){for(const [name,source]of Object.entries(input)){const p=path.join(assets,name);assert.equal(fs.readFileSync(p,'utf8'),source);assert.equal(fs.statSync(p).mode&0o777,0o640);}}

test('actual native Default publication and dependency roles qualify without changing the source',()=>{
 assert.equal(sha(owner.moduleSource),owner.bodySha256);assert.equal(owner.moduleSource.length,1603);
 const before=JSON.stringify(owner),proof=Default.inspectUpstreamDefaultSelectionOwner(owner.moduleSource,owner);
 assert.equal(proof.publication.exportName,'nX');assert.equal(proof.manualExportName,'kA');assert.equal(proof.catalogResolver.moduleId,'TFzY');assert.equal(proof.catalogResolver.exportName,'un');assert.equal(proof.modelPredicate.exportName,'GA');assert.equal(proof.dedupeImport.moduleId,'i5ac');assert.equal(JSON.stringify(owner),before);
 assert.equal(Default.upstreamDefaultSelectionContract(chunk([owner])),'current');assert.equal(Default.upstreamDefaultSelectionContract(owner.moduleSource),'drifted');
 let touched=0;assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner('unrelated invalid JS',new Proxy({}, {get(){touched++;throw Error('snapshot');}})),/body candidate/);assert.equal(touched,0);
});

test('native Default grammar rejects lost pair resolution, mixed sliders, and callback captures',()=>{
 const changes=[
  ['s=e?.sliderSettings?.length?e.sliderSettings:l(i,t)','s=[...l(i,t),...e?.sliderSettings??[]]'],
  ['{...u(e,i,s),isDefault:!0}','{...u(e,i,l(i,t)),isDefault:!0}'],
  ['??(0,s.un)(e,{slug:n,thinkingEffort:r})??[]','??[]'],
  ['powerSettings:n}}','powerSettings:r}}'],
  ['({slugs:t,options:n})=>t.includes(e.defaultModelSlug)&&n.length>0','({slugs:e,options:n})=>e.includes(e.defaultModelSlug)&&n.length>0'],
  ['({slugs:e})=>e.some(a.GA)','({slugs:a})=>a.some(a.GA)'],
  ['({modelSlug:n,thinkingEffort:r})=>t.find','({modelSlug:t,thinkingEffort:r})=>t.find'],
  ['t.find(e=>e.slug===n&&(e.thinkingEffort??null)===r)','t.find(n=>n.slug===n&&(n.thinkingEffort??null)===r)'],
  ['({modelSlug:e})=>t.some(({slug:t})=>t===e)','({modelSlug:t})=>t.some(({slug:e})=>e===t)'],
  ['e.flatMap(({slug:e,thinkingEffort:n})=>t&&null==n','e.flatMap(({slug:t,thinkingEffort:n})=>t&&null==n'],
  ['map(n=>({...r?u(e,n.options,s):o(e,n.options','map(e=>({...r?u(e,e.options,s):o(e,e.options'],
 ];
 for(const [from,to]of changes){assert(owner.moduleSource.includes(from),from);const source=owner.moduleSource.replace(from,to);assert.doesNotThrow(()=>new vm.Script(`function f(${owner.params}){${source}}`),from);assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)),undefined,from);}
});

test('original loader/export, helper and import bindings reject all-depth/rest/escaped writes',()=>{
 for(const name of ['n','t','u','s','a','i','r'])for(const target of [name,'\\u'+name.charCodeAt(0).toString(16).padStart(4,'0')]){
  for(const write of [`${target}=foreign`,`([ ...${target}]=values)`,`([...${target}]=values)`]){
   const source=owner.moduleSource+`;function hidden(){${write}}`;assert.doesNotThrow(()=>new vm.Script(`function f(${owner.params}){${source}}`));assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)));
  }
 }
 const source=owner.moduleSource+';function local(n,t,u,s,a,i,r){([...n]=values);s=1;u=2}const opaque={s:"n=foreign",a:/t=foreign/};';assert.doesNotThrow(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)));
});

test('captured helper namespaces cannot be redeclared or replaced by helper parameters',()=>{
 for(const source of [owner.moduleSource.replace('function u(e,t,n){','function u(s,t,n){').replace('s.un)(e,','s.un)(s,'),owner.moduleSource.replace('function u(e,t,n){let r=','function u(e,t,n){let s=foreign;let r='),owner.moduleSource.replace('function o(e,t,','function o(i,t,').replace('return u(e,t,i()','return u(i,t,i()')]){
  assert.doesNotThrow(()=>new vm.Script(`function f(${owner.params}){${source}}`));assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)));
 }
 for(const source of [owner.moduleSource.replace('nX:function','buildRenamed:function').replace('kA:o','manualRenamed:o'),owner.moduleSource.replace('e=>e.slug===n&&(e.thinkingEffort??null)===r','item=>item.slug===n&&(item.thinkingEffort??null)===r')])assert.doesNotThrow(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)));
});

test('lexical ambiguity and malformed/stale/oversize factories fail before role trust',()=>{
 for(const tail of [';const hidden={}/(n=foreign)/1',';const hidden={}/(\\u006e=foreign)/1']){const source=owner.moduleSource+tail;assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)),/Ambiguous slash/);}
 assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(owner.moduleSource,{...owner,moduleSource:'stale'}),/stale/);
 const huge=owner.moduleSource+'/*'+'x'.repeat(256*1024)+'*/';assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(huge,ownerWith(huge)),/Oversize/);
 for(const source of ['"'+chunk([owner])+'"','function opaque(){'+chunk([owner])+'}'])assert.equal(Default.upstreamDefaultSelectionContract(source),'drifted');
});

test('actual named model predicate is qualified with original authority and exact native regex',()=>{
 assert.equal(sha(predicate.moduleSource),predicate.bodySha256);assert.equal(Default.inspectModelPredicate(predicate.moduleSource,predicate,{exportName:'GA'}).pattern,'/(?:^|[-_.])sol(?:$|[-_.])/iu');
 for(const source of [predicate.moduleSource.replace('GA:p','GA:c'),predicate.moduleSource.replace('sol(?:$','foreign(?:$'),predicate.moduleSource+';([...o]=values)',predicate.moduleSource+';function hidden(){\\u006e=foreign}'])assert.throws(()=>Default.inspectModelPredicate(source,{...predicate,moduleSource:source},{exportName:'GA'}));
 const source=predicate.moduleSource+';function local(o,n){o=1;([...n]=values)}';assert.doesNotThrow(()=>Default.inspectModelPredicate(source,{...predicate,moduleSource:source},{exportName:'GA'}));
});

test('readonly audit closes every owner and named dependency copy without writes or mode changes',()=>{
 const input={...files(),'hidden/owner.js':chunk([owner]),'hidden/catalog.js':chunk([catalog]),'hidden/predicate.js':chunk([predicate])};
 scene(input,(root,assets)=>{let writes=0;const result=Default.auditUpstreamDefaultSelection(root,presets,{writeFileSync(){writes++}});assert.equal(result.matched,2);assert.equal(result.changed,0);assert.deepEqual(result.changedAssets,[]);assert(result.dependencies.every(d=>d.matched===2));assert.equal(result.dedupe.vendorBodyVerified,false);assert.equal(writes,0);unchanged(assets,input);assert.deepEqual(Default.auditUpstreamDefaultSelection(root,presets),result);});
});

test('owner/dependency missing, different identities, hidden damage and export drift refuse the whole audit',()=>{
 const changed=(input,key,module,source)=>({...input,[key]:chunk([{...module,moduleSource:source}])});
 const cases=[
  {...files(),'duplicate.js':chunk([{...owner,moduleId:'anotherOwner'}])},
  {...files(),'hidden/damaged.js':chunk([{...owner,moduleSource:'const lost=true;'}])},
  {...files(),'hidden/damaged-catalog.js':chunk([{...catalog,moduleSource:'const lost=true;'}])},
  {...files(),'hidden/damaged-predicate.js':chunk([{...predicate,moduleSource:'const lost=true;'}])},
  changed(files(),'owner.js',owner,owner.moduleSource.replace('s=n("TFzY")','s=n("foreign")')),
  changed(files(),'owner.js',owner,owner.moduleSource.replace('a.GA','a.foreign')),
  changed(files(),'catalog.js',catalog,catalog.moduleSource.replace('un:v','renamed:v')),
  changed(files(),'predicate.js',predicate,predicate.moduleSource.replace('GA:p','GA:c')),
  {...files(),'hidden/opaque.js':'const opaque=`'+chunk([owner])+'`'},
  {...files(),'bad-registry.js':chunk([owner]).replace('"TuVM"(','"\\u0054uVM"(').replace(owner.moduleSource,'const damaged=true;')},
 ];
 for(const input of cases)scene(input,(root,assets)=>{let writes=0;assert.throws(()=>Default.auditUpstreamDefaultSelection(root,presets,{writeFileSync(){writes++}}));assert.equal(writes,0);unchanged(assets,input);});
});

test('quote-bearing regex registry prefixes remain byte-identical in readonly first and repeat',()=>{
 const prefix='const quoted=/["\u0027]/;/* prefix */',input=files();input['owner.js']=prefix+input['owner.js']+'/* suffix */';
 scene(input,(root,assets)=>{Default.auditUpstreamDefaultSelection(root,presets);Default.auditUpstreamDefaultSelection(root,presets);unchanged(assets,input);});
});

test('same config catalog canonical replay composes with readonly audit and stale config refuses',()=>{
 const prepared=Policy.prepareCatalogFactory(catalog.moduleSource,catalog,presets,{},Authority),input={...files(),'catalog.js':chunk([{...catalog,moduleSource:prepared.patchedSource}])};
 scene(input,(root,assets)=>{assert.equal(Default.auditUpstreamDefaultSelection(root,presets).changed,0);assert.throws(()=>Default.auditUpstreamDefaultSelection(root,[{...presets[0],thinkingEffort:'standard'}]));unchanged(assets,input);});
 scene(files(),(root,assets)=>{assert.equal(Default.auditUpstreamDefaultSelection(root,[]).changed,0);unchanged(assets,files());});
});

test('actual native Default resolver routes a validated explicit pair and native manual/version paths',()=>{
 const original=base(),projected=Policy.projectCatalog(original,presets,context());assert.equal(native.resolve(original,{slug:'model-new',thinkingEffort:'extended'}),undefined);
 const output=world.build(projected,{includeSyntheticDefault:true});assert.deepEqual(plain(output.defaultOption.powerSettings),[{modelSlug:'model-new',thinkingEffort:'extended'}]);assert.equal(output.defaultOption.options.find(o=>o.thinkingEffort==='extended'),projected[Policy.constants.VARIANTS][0]);
 const version={id:'legacy',slugs:['legacy'],options:[{slug:'legacy',thinkingEffort:'quick',title:'Legacy',isAvailable:true}]};const withVersion={...projected,versionOptions:[version]};
 const normal=world.build(withVersion,{includeSyntheticDefault:true});assert.deepEqual(plain(normal.versionOptions[0].powerSettings),[{modelSlug:'legacy',thinkingEffort:'quick'}]);assert.equal(normal.versionOptions[0].version,version);
 const paid=world.build(withVersion,{paidModelFallbackEnabled:true});assert.deepEqual(plain(paid.versionOptions[0].powerSettings),[{modelSlug:'model-new',thinkingEffort:'extended'}]);assert.equal(paid.versionOptions[0].version,version);
 const noSlider={...original,sliderSettings:[]};assert.deepEqual(plain(world.build(noSlider,{includeSyntheticDefault:true}).defaultOption.powerSettings),[{modelSlug:'model-new',thinkingEffort:'standard'}]);
 const nullEffort={...noSlider,options:[{...original.options[0],thinkingEffort:null}]};assert.deepEqual(plain(world.build(nullEffort,{includeSyntheticDefault:true,isTppConversation:true}).defaultOption.powerSettings),[]);
});

test('actual iLYI Default caller and native LLIt newthread tail consume the projected pair',()=>{
 const caller=fixtures.owners.iLYI,module=findRspackRequireBinding(caller,'E');assert.equal(module.moduleId,owner.moduleId);assert(caller.moduleSource.includes(fixtures.consumerFragments.newThreadDefault.source));
 const projected=Policy.projectCatalog(base(),presets,context());const result=world.choose(projected,key=>key===world.keys.plan?'plus':undefined);assert.equal(result.slug,'model-new');assert.equal(result.thinkingEffort,'extended');
 const power=world.power(projected,world.build(projected,{includeSyntheticDefault:true}).defaultOption,{slug:'model-new',thinkingEffort:'extended'},{fallbackModelLabel:'Model'});assert.equal(power.defaultPowerSelection.model,'model-new');assert.equal(power.powerSettings[power.defaultPowerSelection.powerSettingIndex].thinkingEffort,'extended');
 const denied=base();denied.options.push({slug:'model-new',thinkingEffort:'extended',isAvailable:false});assert.equal(Policy.projectCatalog(denied,presets,context()),denied);
 for(const mode of ['prefer_policy','prefer_user']){const b=base();b.options.push({slug:'policy-model',thinkingEffort:'standard',title:'Policy',isAvailable:true});b.modelConfigBySlug['policy-model']={thinkingEfforts:[{thinking_effort:'standard'}]};b.workspaceModelPolicy={newThreadPrecedence:mode,selection:{model:'policy-model',thinkingEffort:'standard'}};const value=Policy.projectCatalog(b,presets,context());const next=world.choose(value,key=>key===world.keys.plan?'plus':key===world.keys.home?{slug:'model-new',thinkingEffort:'extended'}:undefined);assert.equal(next.slug,mode==='prefer_policy'?'policy-model':'model-new');assert.equal(next.thinkingEffort,mode==='prefer_policy'?'standard':'extended');}
});

test('native and canonical catalog dependency copies cannot be mixed in one readonly audit',()=>{
 const prepared=Policy.prepareCatalogFactory(catalog.moduleSource,catalog,presets,{},Authority),input={...files(),'hidden/applied-catalog.js':chunk([{...catalog,moduleSource:prepared.patchedSource}])};
 scene(input,(root,assets)=>{assert.throws(()=>Default.auditUpstreamDefaultSelection(root,presets),/Inconsistent/);unchanged(assets,input);});
});

test('initializer suffix changes and ASI return changes cannot reuse a native routing prefix',()=>{
 const mutations=[
  ['??[]);return{isDefault:!1','??[]).filter(()=>!1);return{isDefault:!1'],
  ['s=e?.sliderSettings?.length?e.sliderSettings:l(i,t);','s=e?.sliderSettings?.length?e.sliderSettings:l(i,t).filter(()=>!1);'],
  ['i=n.n(r),','i=n.n(r).bind(null),'],
  ['return u(e,t,i()','return\nu(e,t,i()'],
  ['return e.flatMap(','return\ne.flatMap('],
 ];
 for(const [from,to]of mutations){assert(owner.moduleSource.includes(from),from);const source=owner.moduleSource.replace(from,to);assert.doesNotThrow(()=>new vm.Script(`function f(${owner.params}){${source}}`));assert.throws(()=>Default.inspectUpstreamDefaultSelectionOwner(source,ownerWith(source)),undefined,from);}
});
