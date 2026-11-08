"use strict";
const fs=require('node:fs'),path=require('node:path'),{Script}=require('node:vm');
const {listWebviewAssetFiles}=require('../../scripts/patches/lib/assets.js');
const Sources=require('./composer-config-sources.js');
const {createJavaScriptLexicalIndex,escapeRegExp}=require('../../scripts/patches/lib/minified-js.js');
const {findRspackExportPublication}=require('../../scripts/patches/lib/rspack-export-publication.js');
const {findRspackRequireBinding,findUniqueRspackModuleCopies,patchRspackModuleCopies,rspackModuleFactories}=require('../../scripts/patches/lib/rspack-module-assets.js');
const {javascriptSourceParses}=require('../../scripts/patches/lib/javascript-syntax.js');
const {requireStableCatalogBinding:stable}=require('./catalog-binding-authority.js');
const {assertCriticalLoaderMethodUses}=require('./critical-loader-authority.js');
const {findSynchronousFunctionDeclaration}=require('./synchronous-function-declaration.js');
const Authority=require('./native-catalog-authority.js'),Resolver=require('./local-resolver.js'),Default=require('./upstream-default-selection.js');
const ID='[A-Za-z_$][\\w$]*',MARKER='codex-linux-model-picker-default-presets-local-composer-config',PREFIX='codexLinuxLocalDefaultPreset';
const NEEDLES=['sliderModelsConfig:','modelsForPicker(','setDefaultModelAndReasoningEffort:','composer.mode.local.model.custom','onSelectDefault:'];
function sourceMatch(source){return typeof source==='string'&&(source.includes(MARKER)||NEEDLES.every(x=>source.includes(x)));}
function one(values,label){if(values.length!==1)throw Error(`Missing or ambiguous composer Default ${label}`);return values[0];}
function hits(source,expression,root=false){const lex=createJavaScriptLexicalIndex(source);return[...source.matchAll(expression)].filter(x=>root?lex.isRoot(x.index):lex.isCode(x.index));}
function match(source,expression,label,root=false){return one(hits(source,expression,root),label);}
function distinct(names,label){if(new Set(names).size!==names.length)throw Error(`Aliased composer Default ${label}`);}
function noCapture(locals,free,label){if(locals.some(x=>free.includes(x)))throw Error(`Shadowed composer Default ${label}`);}
function capture(body,names,params=[]){for(const name of [...new Set(names)]){noCapture(params,[name],'callback capture');try{new Script(`async function composerCaptured(${params}){${body};let ${name};}`)}catch{throw Error(`Redeclared composer Default capture: ${name}`)}stable(`async function composerCaptured(${params}){${body}}`,name);}}
function declaredAt(body,name,index){
 let fresh='__codexComposerDeclared';while(body.includes(fresh))fresh+='$';
 const compile=x=>new Script(`"use strict";function composerDeclarationProof(){${x}\n;let ${name};}`);
 let conflict=false;try{compile(body)}catch{conflict=true}if(!conflict)throw Error(`Unowned composer role: ${name}`);
 try{compile(body.slice(0,index)+fresh+body.slice(index+name.length))}catch{throw Error(`Wrong composer declaration site: ${name}`)}
}
function roleInitializer(body,name){const hit=match(body,new RegExp(String.raw`(?<![\w$.])${escapeRegExp(name)}=(?!=|>)`,'gdu'),'role initializer',true);declaredAt(body,name,hit.index);stable(body,name,hit.index);return hit.index;}

function frame(source,snapshot){
 if(typeof source!=='string'||Buffer.byteLength(source)>256*1024||snapshot?.moduleSource!==source)throw Error('Oversize or stale composer Default factory');
 const loaderUses=assertCriticalLoaderMethodUses(source,snapshot,{allowInterop:false}),module={...snapshot,moduleSource:source},lexical=createJavaScriptLexicalIndex(source);
 function imported(name){const binding=findRspackRequireBinding(module,name);if(!binding||snapshot.params.includes(name))throw Error(`Missing composer Default import ${name}`);stable(source,name,binding.start-(snapshot.start??0));return{localName:name,moduleId:binding.moduleId};}
 return{module,source,lexical,imported,loaderUses};
}
function renderOwner(source,snapshot){
 const f=frame(source,snapshot),keys=[...new Set(hits(source,new RegExp(String.raw`(?<key>${ID}):function\(`,'gu')).map(x=>x.groups.key))];
 const candidates=keys.flatMap(key=>{const pub=findRspackExportPublication(f.module,key);if(!pub?.fn||!new RegExp(`^${ID}$`,'u').test(pub.fn.params)||!NEEDLES.every(x=>pub.fn.body.includes(x)))return[];const text=source.slice(pub.fn.start,pub.fn.end),head=new RegExp(String.raw`^function\((?<input>${ID})\)\{`,'u').exec(text);return head?[{pub,key,input:head.groups.input,bodyStart:pub.fn.start+head[0].length,bodyEnd:pub.fn.end-1,body:pub.fn.body}]:[];});
 const owner=one(candidates,'published synchronous render function');if(source.slice(owner.bodyStart,owner.bodyEnd)!==owner.body)throw Error('Invalid composer Default body span');return{...f,...owner};
}
function bodyScope(body){let prefix='__codexComposerScope';while(body.includes(prefix))prefix+='$';return{moduleSource:body,params:[prefix+'Module',prefix+'Exports',prefix+'Require']};}
function memoDeclaration(body){
 const hit=match(body,new RegExp(String.raw`\blet (?<temps>(?:${ID},)+)(?<cache>${ID})=\(0,(?<react>${ID})\.c\)\((?<size>\d+)\),`,'gdu'),'render cache declaration',true),g=hit.groups,names=g.temps.slice(0,-1).split(',');distinct([...names,g.cache],'render temporary declarations');
 const positions=new Map();let at=hit.indices.groups.temps[0];for(const name of names){positions.set(name,at);at+=name.length+1;}
 declaredAt(body,g.cache,hit.indices.groups.cache[0]);return{...g,size:Number(g.size),positions,end:hit.index+hit[0].length};
}
function stableMutableRole(body,name,positions){let fresh='__codexComposerMutable';while(body.includes(fresh))fresh+='$';let probe=body;for(const at of [...new Set(positions)].sort((a,b)=>b-a)){if(body.slice(at,at+name.length)!==name)throw Error('Stale composer role projection');probe=probe.slice(0,at)+fresh+probe.slice(at+name.length);}stable(probe,name);}
function memoObject(body,decl,name,fields,deps){
 if(!decl.positions.has(name))throw Error('Unowned composer Default memo object');
 const c=escapeRegExp(decl.cache),n=escapeRegExp(name),conditions=deps.map((value,index)=>String.raw`${c}\[(?<s${index}>\d+)\]!==${escapeRegExp(value)}`).join(String.raw`\|\|`),stores=deps.map((value,index)=>String.raw`${c}\[\k<s${index}>\]=${escapeRegExp(value)}`).join(',');
 const pattern=new RegExp(String.raw`${conditions}\?\((?<write0>${n})=\{${fields.map(([key,value])=>key+':'+escapeRegExp(value)).join(',')}\},${stores},${c}\[(?<out>\d+)\]=${n}\):(?<write1>${n})=${c}\[\k<out>\]`,'gdu');
 const hit=match(body,pattern,'memo context object',true),slots=[...deps.map((_,i)=>Number(hit.groups['s'+i])),Number(hit.groups.out)];distinct(slots,'memo context slots');if(slots.some(x=>x>=decl.size))throw Error('Composer Default memo slot outside native cache');
 const positions=[decl.positions.get(name),hit.indices.groups.write0[0],hit.indices.groups.write1[0]];stableMutableRole(body,name,positions);return{hit,slots};
}
function routeFacts(owner){
 const body=owner.body,decl=memoDeclaration(body),input=escapeRegExp(owner.input);
 const propsHit=match(body,new RegExp(String.raw`\{serviceTierDefaults:(?<tier>${ID}),conversationId:(?<conversation>${ID}),hasThreadResumeFailed:${ID},hideLabel:(?<hideLabel>${ID}),home:(?<home>${ID}),isCodexHome:${ID},permissionsCwdOverride:(?<cwdOverride>${ID}),permissionsHostId:(?<permissionsHost>${ID})\}=${input}`,'gdu'),'caller props',true),props=propsHit.groups;
 if(propsHit.index!==decl.end)throw Error('Caller props are not the native render declaration');
 const queryHit=match(body,new RegExp(String.raw`let (?<local>${ID})=\(0,(?<framework>${ID})\.(?<scopedReader>${ID})\)\((?<cloudFlag>${ID})\|\|(?<auth>${ID})\?\.authMethod!=="chatgpt"\|\|(?<managed>${ID})\?\.isAeon\?null:(?<provider>${ID})\.(?<localExport>${ID}),(?<contextArgs>${ID})\),(?<cloud>${ID})=\(0,\k<framework>\.(?<plainReader>${ID})\)\(\k<cloudFlag>\?\k<provider>\.(?<globalExport>${ID}):null\)(?=[,;])`,'gdu'),'two native config-source readers',true),q=queryHit.groups;
 const route=match(body,new RegExp(String.raw`(?<executionContext>${ID})=\(0,(?<hostNamespace>${ID})\.(?<hostExport>${ID})\)\(${escapeRegExp(props.conversation)}\),(?<cloudValue>${ID})=\(0,(?<react>${ID})\.use\)\((?<contextNamespace>${ID})\.(?<contextExport>${ID})\),${escapeRegExp(q.cloudFlag)}=null!=\k<cloudValue>,(?<host>${ID})=\k<executionContext>\.hostId,(?<homeFlag>${ID})=null!=${escapeRegExp(props.home)}`,'gdu'),'host and cloud-presence context',true).groups;
 const auth=match(body,new RegExp(String.raw`(?<![\w$.])${escapeRegExp(q.auth)}=\(0,(?<namespace>${ID})\.(?<exportName>${ID})\)\(${escapeRegExp(route.host)}\)(?=[,;])`,'gdu'),'execution-host auth reader',true).groups;
 memoObject(body,decl,q.contextArgs,[['conversationId',props.conversation],['hostId',route.host],['cwd',route.executionContext+'.cwd']],[props.conversation,route.executionContext+'.cwd',route.host]);
 const stateHit=match(body,new RegExp(String.raw`let (?<state>${ID})=\(0,(?<namespace>${ID})\.(?<exportName>${ID})\)\((?<args>${ID})\),\{modelSettings:(?<settings>${ID}),selectComposerModelAndReasoningEffort:(?<select>${ID}),setDefaultModelAndReasoningEffort:(?<setDefault>${ID}),setModelAndReasoningEffort:(?<setModel>${ID})\}=\k<state>(?=[,;])`,'gdu'),'native model-selection provider',true),state=stateHit.groups;
 memoObject(body,decl,state.args,[['conversationId',props.conversation],['cwdOverride',props.cwdOverride],['hostId',props.permissionsHost]],[props.conversation,props.cwdOverride,props.permissionsHost]);
 const managed=match(body,new RegExp(String.raw`let ${escapeRegExp(q.managed)}=\(0,(?<namespace>${ID})\.(?<exportName>${ID})\)\((?<args>${ID})\)(?=[,;])`,'gdu'),'managed selection provider',true).groups;
 memoObject(body,decl,managed.args,[['conversationId',props.conversation],['executionHostId',route.host],['modelSelection',state.state]],[props.conversation,state.state,route.host]);
 for(const name of [q.local,q.cloud,q.cloudFlag,q.auth,q.managed,route.executionContext,route.cloudValue,route.host,route.homeFlag,state.state])roleInitializer(body,name);
 for(const key of ['settings','select','setDefault','setModel'])stable(body,state[key],stateHit.indices.groups[key][0]);
 for(const key of Object.keys(props))stable(body,props[key],propsHit.indices.groups[key][0]);
 stable(body,owner.input);
 distinct([q.local,q.cloud,q.cloudFlag,q.auth,q.managed,q.contextArgs,route.executionContext,route.cloudValue,route.host],'source roles');
 const imports={memoReact:owner.imported(decl.react),provider:owner.imported(q.provider),framework:owner.imported(q.framework),host:owner.imported(route.hostNamespace),context:owner.imported(route.contextNamespace),react:owner.imported(route.react),hostAuth:owner.imported(auth.namespace),selection:owner.imported(state.namespace),managed:owner.imported(managed.namespace)};
 capture(body,Object.values(imports).map(x=>x.localName),[owner.input]);
 return{props,query:q,route,auth,state,managed,decl,imports,expression:`${q.cloudFlag}?${q.cloud}:${q.local}`};
}
function composerConfig(presets,publicEfforts){
 if(!Array.isArray(presets)||presets.length===0)throw Error('Composer Default needs populated normalized presets');const configured=presets.map(p=>({model:p.modelSlug,reasoning_effort:publicEfforts[p.thinkingEffort]})),selected=presets.filter(p=>p.isDefault);if(selected.length!==1||configured.some(x=>typeof x.model!=='string'||x.model.length===0||!['none','low','medium','high','xhigh','max','ultra'].includes(x.reasoning_effort)))throw Error('Invalid normalized composer Default presets');
 return{codexLinuxDefaultPresets:true,codexLinuxDefaultPresetIds:configured.map(x=>`${x.model}:${x.reasoning_effort}`),codexLinuxDefaultPresetId:`${selected[0].modelSlug}:${publicEfforts[selected[0].thinkingEffort]}`,presets:[configured]};
}
function dataJson(value){return JSON.stringify(value).replace(/"(?:\\.|[^"\\])*"/gu,literal=>{const value=JSON.parse(literal);let encoded='"';for(let i=0;i<value.length;i++)encoded+='\\u'+value.charCodeAt(i).toString(16).padStart(4,'0');return encoded+'"';});}
function runtime(config){return`/*${MARKER}*/const codexLinuxLocalDefaultPresetConfig=${dataJson(config)},codexLinuxLocalDefaultPresetIds=new Set(codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetIds);function codexLinuxLocalDefaultPresetSelection(codexLinuxSelections){let codexLinuxAvailable=codexLinuxSelections.filter(({id:codexLinuxId})=>codexLinuxLocalDefaultPresetIds.has(codexLinuxId));return codexLinuxAvailable.find(({id:codexLinuxId})=>codexLinuxId===codexLinuxLocalDefaultPresetConfig.codexLinuxDefaultPresetId)??codexLinuxAvailable[0]??null}function codexLinuxLocalDefaultPresetFallback(codexLinuxEnabled,codexLinuxSelections,codexLinuxUpstreamDefault){return codexLinuxEnabled?codexLinuxLocalDefaultPresetSelection(codexLinuxSelections)?.id??codexLinuxUpstreamDefault:codexLinuxUpstreamDefault}`;}

function fallbackPattern(namespace,exportName){return new RegExp(String.raw`(?<result>${ID})=\(0,${escapeRegExp(namespace)}\.${escapeRegExp(exportName)}\)\((?<selections>${ID}),(?<argument>null==(?<default>${ID})\?void 0:\x60\$\{\k<default>\.model\}:\$\{\k<default>\.defaultReasoningEffort\}\x60)\)`,'gdu');}
function setterFacts(owner,route){
 const body=owner.body;
 const hit=match(body,new RegExp(String.raw`(?<setter>${ID})=function\((?<model>${ID}),(?<effort>${ID}),(?<metadata>${ID})\)\{if\("auto"===\k<model>&&!0!==(?<store>${ID})\.get\((?<autoNamespace>${ID})\.(?<autoExport>${ID}),(?<conversation>${ID})\)\)return Promise\.resolve\(!1\);let (?<event>${ID})=\(\)=>\{(?<eventBody>[\s\S]*?)\};return (?<managed>${ID})\?\.isAeon\?\k<managed>\.selectModelAndReasoningEffort\((?<normalizer>${ID})\(\k<model>\),\k<effort>,\k<event>\):(?<select>${ID})\(\k<normalizer>\(\k<model>\),\k<effort>,\k<event>,\k<metadata>\)\}`,'gdu'),'fresh native model selector',true),g=hit.groups;
 if(g.managed!==route.query.managed||g.select!==route.state.select||g.conversation!==route.props.conversation)throw Error('Composer Default selection lost its native context');
 // Keep the native event expression exact; only its aliases are variable.
 const eventPattern=new RegExp(String.raw`^${escapeRegExp(g.model)}!==(?<current>${ID})\?\(0,(?<namespace>${ID})\.(?<exportName>${ID})\)\(${escapeRegExp(g.store)},(?<enumNamespace>${ID})\.CodexComposerModelChanged,\{model:${escapeRegExp(g.model)}\}\):null!=${escapeRegExp(g.effort)}&&${escapeRegExp(g.effort)}!==(\s*)(?<effort>${ID})&&\(0,\k<namespace>\.\k<exportName>\)\(${escapeRegExp(g.store)},\k<enumNamespace>\.CodexComposerReasoningEffortChanged,\{reasoningEffort:${escapeRegExp(g.effort)}\}\)$`,'u');
 const event=eventPattern.exec(g.eventBody)?.groups;if(!event)throw Error('Drifted composer native model event routing');
 if(!/^[,;]/u.test(body.slice(hit.index+hit[0].length).trimStart()))throw Error('Native selector initializer has a suffix');
 const start=hit.index+g.setter.length+1,text=body.slice(start,hit.index+hit[0].length),head=new RegExp(String.raw`^function\(${ID},${ID},${ID}\)\{`,'u').exec(text);if(!head)throw Error('Non-synchronous native selector expression');
 distinct([g.model,g.effort,g.metadata,g.event],'selector local roles');
 const captures=[g.store,g.autoNamespace,g.conversation,g.managed,g.normalizer,g.select,event.current,event.effort,event.namespace,event.enumNamespace,'Promise'];
 capture(text.slice(head[0].length,-1),captures,[g.model,g.effort,g.metadata]);roleInitializer(body,g.setter);
 const normalized=findSynchronousFunctionDeclaration(body,bodyScope(body),g.normalizer),normal=new RegExp(String.raw`^return (?<premium>${ID})&&${escapeRegExp(normalized.params)}===${escapeRegExp(event.current)}\?(?<namespace>${ID})\.(?<exportName>${ID}):${escapeRegExp(normalized.params)}$`,'u').exec(normalized.body)?.groups;
 if(!normal||!new RegExp(`^${ID}$`,'u').test(normalized.params))throw Error('Drifted native model-id normalization');
 capture(normalized.body,[normal.premium,event.current,normal.namespace],[normalized.params]);
 match(body,new RegExp(String.raw`(?<![\w$.])${escapeRegExp(normal.premium)}=(?<query>${ID})&&${escapeRegExp(g.managed)}\?\.isAeon!==!0(?=[,;])`,'gu'),'native premium-mode normalization',true);
 return{hit,...g,event,text,normalized,normal,imports:{auto:owner.imported(g.autoNamespace),events:owner.imported(event.namespace),eventEnum:owner.imported(event.enumNamespace),sentinel:owner.imported(normal.namespace)}};
}
function consumerFacts(owner,route){
 const body=owner.body;
 const qvHit=match(body,new RegExp(String.raw`(?<choices>${ID})=\(0,(?<namespace>${ID})\.(?<exportName>${ID})\)\((?<models>${ID}),\{sliderModelsConfig:(?<argument>[^,;]+),stripGptPrefix:!(?<strip>${ID})\}\)(?=[,;])`,'gdu'),'native local preset resolver call',true),qv=qvHit.groups;
 if(qv.argument!==route.expression)throw Error('Mixed native composer config source');
 const enabled=match(body,new RegExp(String.raw`(?<![\w$.])${escapeRegExp(qv.models)}=(?<options>${ID})\?\.filter\((?<enabled>${ID})\)\.map\((?<model>${ID})\)(?=[,;])`,'gdu'),'enabled model intersection input',true).groups;
 for(const[name,property,tail]of [[enabled.enabled,'disabledReason','null=='],[enabled.model,'model','']]){
  const fn=findSynchronousFunctionDeclaration(owner.source,owner.module,name);
  const pattern=new RegExp(String.raw`^let\{${property}:(?<value>${ID})\}=${escapeRegExp(fn.params)};return ${tail}\k<value>$`,'u');
  if(!new RegExp(`^${ID}$`,'u').test(fn.params)||!pattern.test(fn.body))throw Error('Drifted native enabled-model projection');
 }
 const current=match(body,new RegExp(String.raw`(?<mode>${ID})=null!=\(0,${escapeRegExp(qv.namespace)}\.(?<exact>${ID})\)\(${escapeRegExp(qv.choices)},(?<model>${ID}),(?<effort>${ID})\)\?(?<modeAtomValue>${ID})\?\?"default":"model",(?<effective>${ID})=${escapeRegExp(qv.choices)};`,'gdu'),'native current pair and display mode',true).groups;
 const defaultRecord=match(body,new RegExp(String.raw`(?<value>${ID})=(?<models>${ID})\?\.find\((?<predicate>${ID})\),${escapeRegExp(qv.choices)}=`,'gdu'),'native default model record',true).groups;
 const predicate=findSynchronousFunctionDeclaration(owner.source,owner.module,defaultRecord.predicate);if(predicate.body!==`return ${predicate.params}.isDefault`||!new RegExp(`^${ID}$`,'u').test(predicate.params))throw Error('Drifted native Default model predicate');
 const setters=setterFacts(owner,route);if(setters.event.current!==current.model||setters.event.effort!==current.effort)throw Error('Composer selector uses a different native current pair');
 const branches=selectionBranches(owner,route,qv,current,setters);
 const first=match(body,new RegExp(String.raw`(?<result>${ID})=\(0,${escapeRegExp(qv.namespace)}\.(?<exportName>${ID})\)\(${escapeRegExp(current.effective)},(?<argument>null==${escapeRegExp(defaultRecord.value)}\?void 0:\x60\$\{${escapeRegExp(defaultRecord.value)}\.model\}:\$\{${escapeRegExp(defaultRecord.value)}\.defaultReasoningEffort\}\x60)\)`,'gdu'),'displayed native fallback',true);
 const cache=escapeRegExp(route.decl.cache),a=escapeRegExp(defaultRecord.value),b=escapeRegExp(qv.choices),setter=escapeRegExp(setters.setter),store=escapeRegExp(setters.store);
 const memoHead=match(body,new RegExp(String.raw`${cache}\[(?<s0>\d+)\]!==${a}\|\|${cache}\[(?<s1>\d+)\]!==${b}\|\|${cache}\[(?<s2>\d+)\]!==(?<before>${ID})\|\|${cache}\[(?<s3>\d+)\]!==${store}\|\|${cache}\[(?<s4>\d+)\]!==${setter}\?\((?<callback>${ID})=0===${b}\.length\?void 0:\(\)=>\{`,'gdu'),'Default callback native memo dependencies',true);
 const open=memoHead.index+memoHead[0].length-1,end=createJavaScriptLexicalIndex(body).matchingBrace(open),callbackBody=body.slice(open+1,end),memo=memoHead.groups;
 if(end<open||!route.decl.positions.has(memo.callback))throw Error('Unowned Default callback memo');
 const cb=new RegExp(String.raw`^let (?<value>${ID})=\(0,${escapeRegExp(qv.namespace)}\.${escapeRegExp(first.groups.exportName)}\)\(${b},(?<argument>null==${a}\?void 0:\x60\$\{${a}\.model\}:\$\{${a}\.defaultReasoningEffort\}\x60)\);\(null==\k<value>\|\|${escapeRegExp(memo.before)}\(\k<value>\.model\)\)&&\(${store}\.set\((?<modeNamespace>${ID})\.(?<modeExport>${ID}),"default"\),null!=\k<value>&&${setter}\(\k<value>\.model,\k<value>\.reasoningEffort\)\)$`,'du').exec(callbackBody);
 if(!cb)throw Error('Drifted native Default callback routing');
 const deps=[defaultRecord.value,qv.choices,memo.before,setters.store,setters.setter],stores=deps.map((value,index)=>`${route.decl.cache}[${memo['s'+index]}]=${value}`).join(',');
 const tail=new RegExp(String.raw`^,${escapeRegExp(stores)},${cache}\[(?<out>\d+)\]=${escapeRegExp(memo.callback)}\):(?<write1>${escapeRegExp(memo.callback)})=${cache}\[\k<out>\]`,'du').exec(body.slice(end+1));if(!tail)throw Error('Drifted native Default callback cache stores');
 const slots=[...deps.map((_,i)=>Number(memo['s'+i])),Number(tail.groups.out)];distinct(slots,'Default memo slots');if(slots.some(x=>x>=route.decl.size))throw Error('Default memo slot outside native cache');
 stableMutableRole(body,memo.callback,[route.decl.positions.get(memo.callback),memoHead.indices.groups.callback[0],end+1+tail.indices.groups.write1[0]]);
 capture(callbackBody,[qv.namespace,qv.choices,defaultRecord.value,memo.before,setters.store,setters.setter,cb.groups.modeNamespace]);
 match(body,new RegExp(String.raw`onSelectDefault:${escapeRegExp(memo.callback)}(?=[,}])`,'gu'),'native Default output callback');
 const second={index:open+1+cb.indices.groups.argument[0],end:open+1+cb.indices.groups.argument[1],argument:cb.groups.argument,selections:qv.choices};
 roleInitializer(body,qv.choices);roleInitializer(body,qv.models);roleInitializer(body,current.mode);roleInitializer(body,defaultRecord.value);
 capture(body,[qv.namespace], [owner.input]);
 return{qvHit,qv,enabled,current,defaultRecord,branches,setter:setters,callback:{memoHead,body:callbackBody,source:`()=>{${callbackBody}}`,...memo,modeNamespace:cb.groups.modeNamespace,modeExport:cb.groups.modeExport,freshSetterDependency:true,memoSource:body.slice(memoHead.index,end+1+tail[0].length)},fallbackExport:first.groups.exportName,fallbacks:[{index:first.indices.groups.argument[0],end:first.indices.groups.argument[1],argument:first.groups.argument,selections:current.effective},second],imports:{models:owner.imported(qv.namespace),mode:owner.imported(cb.groups.modeNamespace)}};
}

function selectionBranches(owner,route,qv,current,setter){
 const body=owner.body,c=Object.fromEntries(Object.entries(current).map(([k,v])=>[k,escapeRegExp(v)])),managed=escapeRegExp(route.query.managed);
 const pattern=new RegExp(String.raw`(?<initial>${c.effective})=${escapeRegExp(qv.choices)};${escapeRegExp(setter.normal.premium)}\?(?<write0>${c.effective})=(?<ordinary>${ID})\.map\((?<mapAll>${ID})\):null!=(?<models>${ID})&&null==(?<known>${ID})\?(?<write1>${c.effective})=(?<efforts>${ID})\.map\(\((?<entry>${ID}),(?<index>${ID})\)=>\{let\{reasoningEffort:(?<effort>${ID})\}=\k<entry>;return\{id:\x60\$\{${c.model}\}:\$\{\k<effort>\}\x60,model:${c.model},modelLabel:(?<label>${ID})\?\?(?<intl>${ID})\.formatMessage\(\{id:"composer.mode.local.model.custom",defaultMessage:"(?:\\.|[^"\\])*",description:"(?:\\.|[^"\\])*"\}\),reasoningEffort:\k<effort>,powerSettingIndex:\k<index>\}\}\):\("model"===${c.mode}\|\|${managed}\?\.isModelLocked===!0\)&&\((?<write2>${c.effective})=\k<ordinary>\.filter\((?<candidate>${ID})=>\k<candidate>\.model===${c.model}\)\.map\((?<mapModel>${ID})\)\)`,'gdu');
 const hit=match(body,pattern,'native display-selection branches',true),g=hit.groups;
 distinct([g.entry,g.index,g.effort],'custom effort mapper roles');noCapture([g.entry,g.index,g.effort],[current.model,g.label,g.intl],'custom effort mapper captures');noCapture([g.candidate],[current.model],'manual model filter');
 for(const mapper of[g.mapAll,g.mapModel]){const fn=findSynchronousFunctionDeclaration(owner.source,owner.module,mapper);const args=new RegExp(String.raw`^(?<option>${ID}),(?<index>${ID})$`,'u').exec(fn.params)?.groups;if(!args||args.option===args.index||fn.body!==`return{...${args.option},powerSettingIndex:${args.index}}`)throw Error('Drifted native power-setting index mapper');}
 declaredAt(body,current.effective,hit.indices.groups.initial[0]);stableMutableRole(body,current.effective,[hit.indices.groups.initial[0],...['write0','write1','write2'].map(k=>hit.indices.groups[k][0])]);
 const store=match(body,new RegExp(String.raw`(?<![\w$.])${escapeRegExp(setter.store)}=\(0,${escapeRegExp(route.query.framework)}\.(?<exportName>${ID})\)\((?<namespace>${ID})\.(?<scopeExport>${ID})\)(?=[,;])`,'gdu'),'native selection scope store',true).groups;
 roleInitializer(body,setter.store);
 return{...g,scope:{...owner.imported(store.namespace),exportName:store.scopeExport},storeExport:store.exportName,source:hit[0]};
}
const renderCache=new Map(),nativeCache=new Map();
function key(source,snapshot){return JSON.stringify([snapshot?.moduleId,snapshot?.params,source]);}
function cachedRender(source,snapshot){const k=key(source,snapshot);if(renderCache.has(k))return renderCache.get(k);const value=renderOwner(source,snapshot);if(renderCache.size>=4)renderCache.delete(renderCache.keys().next().value);renderCache.set(k,value);return value;}
function nativeFacts(source,snapshot){
 const k=key(source,snapshot);if(nativeCache.has(k))return nativeCache.get(k);
 if(source.includes(MARKER)||source.includes(PREFIX))throw Error('Orphan composer Default contribution');
 const owner=cachedRender(source,snapshot),route=routeFacts(owner),consumer=consumerFacts(owner,route);consumer.guards=guardFacts(owner,route,consumer);consumer.guards.menu=returnedMenu(owner,route,consumer);
 for(const name of ['Set','JSON','Promise','Symbol']){if(snapshot.params.includes(name))throw Error('Captured composer Default ambient binding');stable(source,name);capture(owner.body,[name],[owner.input]);}
 const mode=match(owner.body,new RegExp(String.raw`(?<![\w$.])${escapeRegExp(consumer.current.modeAtomValue)}=\(0,${escapeRegExp(route.query.framework)}\.${escapeRegExp(route.query.plainReader)}\)\(${escapeRegExp(consumer.callback.modeNamespace)}\.${escapeRegExp(consumer.callback.modeExport)}\)(?=[,;])`,'gu'),'native selection-mode atom',true);roleInitializer(owner.body,consumer.current.modeAtomValue);
 const value={owner,route,consumer};if(nativeCache.size>=4)nativeCache.delete(nativeCache.keys().next().value);nativeCache.set(k,value);return value;
}
function splice(source,edits){let result=source;for(const edit of[...edits].sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.text+result.slice(edit.end);return result;}
function publicProof(facts){const{owner,route,consumer}=facts;return JSON.parse(JSON.stringify({moduleId:owner.module.moduleId,exportName:owner.key,props:route.props,query:route.query,context:route.route,auth:route.auth,state:route.state,managed:route.managed,imports:{...route.imports,...consumer.imports,...consumer.setter.imports},qv:consumer.qv,current:consumer.current,defaultRecord:consumer.defaultRecord,memo:{cache:route.decl.cache,size:route.decl.size},selector:{name:consumer.setter.setter,store:consumer.setter.store,autoNamespace:consumer.setter.autoNamespace,autoExport:consumer.setter.autoExport,before:consumer.callback.before,modeNamespace:consumer.callback.modeNamespace,modeExport:consumer.callback.modeExport,premium:consumer.setter.normal.premium,sentinelNamespace:consumer.setter.normal.namespace,sentinelExport:consumer.setter.normal.exportName,event:consumer.setter.event},fallbackExport:consumer.fallbackExport,exactExport:consumer.current.exact,normalizer:consumer.setter.normalized.name,callback:consumer.callback.callback,scope:consumer.branches.scope,storeExport:consumer.branches.storeExport,freshSetterMemoDependency:true,nativeSourceRoutesPreserved:true,fragments:{sourceReaders:match(owner.body,new RegExp(String.raw`let ${escapeRegExp(route.query.local)}=[\s\S]+?${escapeRegExp(route.query.cloud)}=[\s\S]+?\)(?=[,;])`,'gu'),'source reader fragment',true)[0],setter:consumer.setter.text,normalizer:consumer.setter.normalized.source,defaultCallback:consumer.callback.source,displayBranches:consumer.branches.source,defaultMemo:consumer.callback.memoSource,guards:consumer.guards}}));}
function renderInsertion(body,decl){const lex=createJavaScriptLexicalIndex(body);for(let at=decl.end;at<body.length;at++)if(body[at]===';'&&lex.isRoot(at))return at+1;throw Error('Missing native render declaration boundary');}
function patchedNative(source,snapshot,presets,publicEfforts){
 const facts=nativeFacts(source,snapshot),{owner,route,consumer}=facts,config=composerConfig(presets,publicEfforts),expr=`(${route.expression})`;
 const edits=[{start:consumer.qvHit.indices.groups.argument[0],end:consumer.qvHit.indices.groups.argument[1],text:`${expr}==null?${expr}:codexLinuxLocalDefaultPresetConfig`},...consumer.fallbacks.map(f=>({start:f.index,end:f.end,text:`codexLinuxLocalDefaultPresetFallback(${expr}!=null,${f.selections},${f.argument})`}))];
 const insertion=renderInsertion(owner.body,route.decl),body=splice(owner.body,[...edits,{start:insertion,end:insertion,text:runtime(config)}]),patched=source.slice(0,owner.bodyStart)+body+source.slice(owner.bodyEnd);
 if(!javascriptSourceParses(`function composerPrepared(${snapshot.params}){${patched}}`))throw Error('Invalid generated composer Default factory');
 return{patched,facts};
}
function queryTuple(body){return match(body,new RegExp(String.raw`let (?<local>${ID})=\(0,(?<framework>${ID})\.(?<scopedReader>${ID})\)\((?<cloudFlag>${ID})\|\|(?<auth>${ID})\?\.authMethod!=="chatgpt"\|\|(?<managed>${ID})\?\.isAeon\?null:(?<provider>${ID})\.(?<localExport>${ID}),(?<contextArgs>${ID})\),(?<cloud>${ID})=\(0,\k<framework>\.(?<plainReader>${ID})\)\(\k<cloudFlag>\?\k<provider>\.(?<globalExport>${ID}):null\)(?=[,;])`,'gdu'),'native source tuple',true).groups;}
function inverse(source,snapshot,presets,publicEfforts){
 const prefix=runtime(composerConfig(presets,publicEfforts)),at=source.indexOf(prefix);if(at<0||source.indexOf(prefix,at+prefix.length)>=0)throw Error('Stale or orphan composer Default runtime');
 let stripped=source.slice(0,at)+source.slice(at+prefix.length);const owner=cachedRender(stripped,{...snapshot,moduleSource:stripped});if(owner.bodyStart+renderInsertion(owner.body,memoDeclaration(owner.body))!==at)throw Error('Misplaced composer Default runtime');
 const q=queryTuple(owner.body),expr=`(${q.cloudFlag}?${q.cloud}:${q.local})`,qv=match(owner.body,new RegExp(String.raw`sliderModelsConfig:${escapeRegExp(expr)}==null\?${escapeRegExp(expr)}:codexLinuxLocalDefaultPresetConfig(?=,stripGptPrefix:)`,'gdu'),'configured slider replacement');
 const calls=hits(owner.body,new RegExp(String.raw`codexLinuxLocalDefaultPresetFallback\(${escapeRegExp(expr)}!=null,(?<list>${ID}),(?<argument>null==(?<model>${ID})\?void 0:\x60\$\{\k<model>\.model\}:\$\{\k<model>\.defaultReasoningEffort\}\x60)\)`,'gdu'));
 if(calls.length!==2)throw Error('Partial composer Default fallback contributions');
 const body=splice(owner.body,[{start:qv.index,end:qv.index+qv[0].length,text:`sliderModelsConfig:${q.cloudFlag}?${q.cloud}:${q.local}`},...calls.map(h=>({start:h.index,end:h.index+h[0].length,text:h.groups.argument}))]);
 stripped=stripped.slice(0,owner.bodyStart)+body+stripped.slice(owner.bodyEnd);if(stripped.includes(MARKER)||stripped.includes(PREFIX))throw Error('Orphan composer Default contribution');return stripped;
}
function prepareComposerFactory(source,snapshot,presets,publicEfforts){
 if(!sourceMatch(source))throw Error('Not a composer Default body candidate');if(snapshot?.moduleSource!==source||!Array.isArray(presets))throw Error('Stale composer Default input');
 const applied=source.includes(MARKER)||source.includes(PREFIX);if(presets.length===0){if(applied)throw Error('Non-native empty composer audit');const facts=nativeFacts(source,snapshot);return{state:'pristine',nativeSource:source,patchedSource:source,proof:{...publicProof(facts),auditOnly:true}};}
 const native=applied?inverse(source,snapshot,presets,publicEfforts):source,made=patchedNative(native,{...snapshot,moduleSource:native},presets,publicEfforts);
 if(applied&&made.patched!==source)throw Error('Noncanonical or stale composer Default replay');return{state:applied?'applied':'pristine',nativeSource:native,patchedSource:made.patched,proof:{...publicProof(made.facts),auditOnly:false}};
}

function guardFacts(owner,route,c){
 const body=owner.body,m=escapeRegExp(route.query.managed),home=escapeRegExp(route.route.homeFlag),auth=escapeRegExp(route.query.auth);
 const disabledHit=match(body,new RegExp(String.raw`(?<modelDisabled>${ID})=(?<loading>${ID})\|\|"error"===(?<status>${ID})\|\|${m}\?\.isModelLocked===!0,(?<effortDisabled>${ID})=\k<loading>\|\|(?<blocked>${ID})\|\|${m}\?\.lockedReasoningEffort!=null(?=[,;])`,'gdu'),'native loading/lock disabled controls',true),disabled=disabledHit.groups;
 for(const [field,value]of[['modelOptionsDisabled',disabled.modelDisabled],['reasoningEffortDisabled',disabled.effortDisabled]])match(body,new RegExp(String.raw`${field}:${escapeRegExp(value)}(?=[,}])`,'gu'),'native disabled output');
 const available=match(body,new RegExp(String.raw`(?<surface>${ID})=!(?<side>${ID})&&!${escapeRegExp(disabled.loading)}&&!(?<busy>${ID})&&!${escapeRegExp(disabled.blocked)},(?<effort>${ID})=!${home}&&\k<surface>&&${m}\?\.lockedReasoningEffort==null,(?<power>${ID})=!${home}&&!\k<side>&&${m}\?\.isModelLocked!==!0&&${m}\?\.lockedReasoningEffort==null&&!${escapeRegExp(disabled.blocked)}&&"error"!==${escapeRegExp(disabled.status)}(?=[,;])`,'gdu'),'native picker surface readiness',true).groups;
 const blockingHit=match(body,new RegExp(String.raw`${escapeRegExp(disabled.blocked)}=(?<gate>${auth}\?\.authMethod==="copilot"\|\||/\*codexLinuxCopilotEffortDropdown\*/)${escapeRegExp(c.enabled.options)}\?\.find\((?<entry>${ID})=>\{let\{model:(?<model>${ID})\}=\k<entry>;return \k<model>\.model===${escapeRegExp(c.current.model)}\}\)\?\.disabledReason!=null`,'gdu'),'native or exact sibling Copilot/model blocking',true),blocking=blockingHit.groups;

 noCapture([blocking.entry,blocking.model],[c.current.model],'native disabled-model callback');
 const reset=match(body,new RegExp(String.raw`canRenderPowerPickerSurface:${escapeRegExp(available.power)}&&\(!${escapeRegExp(disabled.loading)}\|\|(?<open>${ID})\),fallbackPowerSelection:${escapeRegExp(c.fallbacks[0].selections===c.current.effective?match(body,new RegExp(String.raw`(?<fallback>${ID})=\(0,${escapeRegExp(c.qv.namespace)}\.${escapeRegExp(c.fallbackExport)}\)\(${escapeRegExp(c.current.effective)},`,'gu'),'fallback role',true).groups.fallback:'')},isModelSettingsLoading:${escapeRegExp(disabled.loading)},menuView:(?<menu>${ID}),onReset:(?<option>${ID})=>\(async function\((?<model>${ID}),(?<effort>${ID})\)\{if\("auto"===\k<model>&&!0!==${escapeRegExp(c.setter.store)}\.get\(${escapeRegExp(c.setter.autoNamespace)}\.${escapeRegExp(c.setter.autoExport)},${escapeRegExp(route.props.conversation)}\)\)return;let (?<normalized>${ID})=${escapeRegExp(c.setter.normalizer)}\(\k<model>\);await \(null==${m}\?${escapeRegExp(route.state.setModel)}\(\k<normalized>,\k<effort>\):${m}\.setModelAndReasoningEffort\(\k<normalized>,\k<effort>\)\)\}\)\(\k<option>\.model,\k<option>\.reasoningEffort\),powerSelectionsWithXHigh:${escapeRegExp(c.current.effective)},resetContextKey:JSON\.stringify\(\[${escapeRegExp(route.props.conversation)},${escapeRegExp(route.route.host)},${escapeRegExp(route.route.executionContext)}\.cwd\]\)`,'gdu'),'native reset call/context');
 const rg=reset.groups;distinct([rg.model,rg.effort,rg.normalized],'native reset parameters');noCapture([rg.model,rg.effort,rg.normalized],[c.setter.store,c.setter.autoNamespace,route.props.conversation,c.setter.normalizer,route.query.managed,route.state.setModel],'native reset captures');
 // The home surface keeps its native merged-picker state and does not consume
 // the local Default callback. Keep that original branch and data readers.
 const homeReads=match(body,new RegExp(String.raw`let (?<pending>${ID})=\(0,${escapeRegExp(route.query.framework)}\.${escapeRegExp(route.query.plainReader)}\)\(${home}\?(?<namespace>${ID})\.(?<pendingExport>${ID}):null\),(?<selected>${ID})=\(0,${escapeRegExp(route.query.framework)}\.${escapeRegExp(route.query.plainReader)}\)\(${home}\?(?<merged>${ID}):null\),(?<conversation>${ID})=\(0,${escapeRegExp(route.query.framework)}\.${escapeRegExp(route.query.plainReader)}\)\(${home}\?\k<namespace>\.homeConversationId\$:null\)`,'gdu'),'native home state readers',true).groups;

 const guardFragment=match(body,new RegExp(String.raw`if\(${home}\)\{let (?<selectedModel>${ID}),(?<service>${ID}),(?<node>${ID}),(?<tpp>${ID})=null==${escapeRegExp(homeReads.selected)},(?<blocked>${ID})=${escapeRegExp(homeReads.selected)}\?\.rateLimitState\.sendBlocked,(?<loading>${ID})=${escapeRegExp(homeReads.pending)}\?\.isPending!==!1,(?<models>${ID})=${escapeRegExp(homeReads.pending)}\?\.models,(?<limits>${ID})=${escapeRegExp(homeReads.selected)}\?\.rateLimitState\.modelLimits,(?<fallback>${ID})=${escapeRegExp(homeReads.selected)}\?\.premiumFallbackModelSlug;return `,'gdu'),'native home readiness branch',true);
 if(guardFragment.index>=c.callback.memoHead.index)throw Error('Native home branch no longer precedes local Default callback');
 const hg=guardFragment.groups;distinct([hg.selectedModel,hg.service,hg.node,hg.tpp,hg.blocked,hg.loading,hg.models,hg.limits,hg.fallback],'home branch locals');noCapture(Object.values(hg),[homeReads.selected,homeReads.pending,homeReads.conversation],'home branch captures');
 const blockOpen=guardFragment.index+guardFragment[0].indexOf('{'),blockEnd=createJavaScriptLexicalIndex(body).matchingBrace(blockOpen),homeBody=body.slice(blockOpen+1,blockEnd);
 const output=match(homeBody,new RegExp(String.raw`\(0,(?<jsx>${ID})\.jsx\)\((?<namespace>${ID})\.(?<exportName>${ID}),\{conversationId:${escapeRegExp(homeReads.conversation)},hideLabel:${escapeRegExp(route.props.hideLabel)},useMergedPicker:!0,useHomeSelectionMode:!0,showChatAlphas:!0,isTppConversation:${escapeRegExp(hg.tpp)},disabled:${escapeRegExp(hg.blocked)},isLoading:${escapeRegExp(hg.loading)},models:${escapeRegExp(hg.models)},modelLimits:${escapeRegExp(hg.limits)},premiumFallbackModelSlug:${escapeRegExp(hg.fallback)},selectedModel:${escapeRegExp(hg.selectedModel)},selectedServiceTier:(?<tier>${ID})\.selectedServiceTierForModel,onModelChange:(?<onChange>${ID}),onServiceTierChange:${escapeRegExp(hg.service)}\}\)`,'gdu'),'native merged home picker output');
 capture(homeBody,[route.decl.cache,homeReads.namespace,homeReads.pending,homeReads.selected,homeReads.conversation,output.groups.jsx,output.groups.namespace,output.groups.tier,output.groups.onChange,route.props.hideLabel,c.setter.store]);
 const bridge=homeBridgeFacts(owner,route,c,disabled,output.groups.onChange);
 return{bridge,disabled,disabledSource:disabledHit[0],available,resetSource:reset[0],home:homeReads,homeGuardSource:guardFragment[0],homeState:{...owner.imported(homeReads.namespace),exportName:homeReads.pendingExport},homePicker:{...owner.imported(output.groups.namespace),exportName:output.groups.exportName},homeOutput:output[0],localDefaultUnavailableDuringHomeBranch:true};
}

function homeBridgeFacts(owner,route,c,disabled,onChange){
 const body=owner.body;
 const head=match(body,new RegExp(String.raw`(?<bridge>${ID})=async function\((?<choice>${ID})\)\{`,'gdu'),'native home-model bridge',true),open=head.index+head[0].length-1,end=createJavaScriptLexicalIndex(body).matchingBrace(open),text=body.slice(open+1,end),p=head.groups;
 const pattern=new RegExp(String.raw`^let\{model:(?<model>${ID}),reasoningEffort:(?<effort>${ID})\}=\(0,(?<mapper>${ID})\.(?<mapExport>${ID})\)\(\{model:${escapeRegExp(p.choice)}\.slug,reasoningEffort:${escapeRegExp(p.choice)}\.thinkingEffort\},(?<raw>${ID})\),(?<target>${ID})=(?<models>${ID})\?\.find\((?<candidate>${ID})=>\k<candidate>\.model===\k<model>\);return ${escapeRegExp(disabled.loading)}\|\|null==\k<target>\|\|null!=\k<effort>&&!\k<target>\.supportedReasoningEfforts\.some\((?<entry>${ID})=>\{let\{reasoningEffort:(?<value>${ID})\}=\k<entry>;return \k<value>===\k<effort>\}\)\?\((?<warning>[\s\S]+),!1\):!!${escapeRegExp(c.callback.before)}\(\k<target>\.model\)&&${escapeRegExp(c.setter.setter)}\(\k<target>\.model,\k<effort>,\{persistAsDefault:!1\}\)$`,'du');
 const matchResult=pattern.exec(text),g=matchResult?.groups;if(!g||g.models!==c.defaultRecord.models)throw Error('Drifted native home selection availability bridge');
 distinct([p.choice,g.model,g.effort,g.target],'home model/effort bridge locals');noCapture([g.candidate],[g.model],'home model lookup');noCapture([g.entry,g.value],[g.effort],'home effort comparison');
 capture(text,[g.mapper,g.raw,g.models,disabled.loading,c.callback.before,c.setter.setter],[p.choice]);
 const alias=match(body,new RegExp(String.raw`let (?<alias>${ID})=${escapeRegExp(p.bridge)};`,'gdu'),'native bridge callback alias',true).groups.alias;
 const viewAlias=match(body,new RegExp(String.raw`let ${escapeRegExp(onChange)}=(?<cached>${ID});if\(${escapeRegExp(route.route.homeFlag)}\)\{`,'gdu'),'native home change handler alias',true).groups.cached;
 const wrapper=match(body,new RegExp(String.raw`${escapeRegExp(viewAlias)}=function\((?<choice>${ID}),(?<switchMode>${ID})\)\{let (?<persistMode>${ID})=void 0!==\k<switchMode>&&\k<switchMode>;(?<composer>${ID})\.cancelPendingSubmit\(\),\(0,(?<namespace>${ID})\.(?<exportName>${ID})\)\(${escapeRegExp(c.setter.store)},\k<choice>,${escapeRegExp(alias)},${escapeRegExp(route.props.home)}\?\.fileDropTargetId\)\.then\((?<success>${ID})=>\{\k<success>&&\k<persistMode>&&${escapeRegExp(c.setter.store)}\.set\((?<modeNamespace>${ID})\.(?<modeExport>${ID}),"model"\)\},\(\)=>(?<warning>[\s\S]*?)\)\}`,'gdu'),'native home submission wrapper',true);
 distinct([wrapper.groups.choice,wrapper.groups.switchMode,wrapper.groups.persistMode],'home wrapper locals');
 noCapture([wrapper.groups.choice,wrapper.groups.switchMode,wrapper.groups.persistMode],[wrapper.groups.composer,wrapper.groups.namespace,c.setter.store,route.props.home,alias],'home submission wrapper captures');
 noCapture([wrapper.groups.success],[wrapper.groups.persistMode,c.setter.store,wrapper.groups.modeNamespace],'home success callback');

 roleInitializer(body,alias);roleInitializer(body,onChange);
 return{functionSource:`async function(${p.choice}){${text}}`,mapper:{...owner.imported(g.mapper),exportName:g.mapExport},rawModels:g.raw,models:g.models,sourceWarning:g.warning,onChange,alias,wrapperSource:wrapper[0],commit:{...owner.imported(wrapper.groups.namespace),exportName:wrapper.groups.exportName}};
}

function reference(value){return{moduleId:value.moduleId,exportName:value.exportName};}
function same(a,b,label){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`Inconsistent composer Default ${label}`);}
function inspectModels(source,snapshot,expected){
 const state=Resolver.localResolverState(source,snapshot);if(!['native','patched'].includes(state.kind))throw Error(`Missing native local resolver: ${state.reason}`);
 const owner=state.owner,native=state.native,module={...snapshot,moduleSource:native};
 if(owner.proof.exportName!==expected.qv)throw Error('Composer Qv is not the qualified native resolver');
 const normalized=findRspackExportPublication(module,expected.normalizer);if(normalized?.expression!==owner.normalizer.name)throw Error('Composer CT is not the native model normalizer');
 const fallback=findRspackExportPublication(module,expected.fallback);if(!new RegExp(`^${ID}$`,'u').test(fallback?.expression??''))throw Error('Missing native fallback publication');
 const fn=findSynchronousFunctionDeclaration(native,module,fallback.expression),g=new RegExp(String.raw`^(?<choices>${ID}),(?<selected>${ID})$`,'u').exec(fn.params)?.groups;if(!g||g.choices===g.selected)throw Error('Drifted native fallback parameters');
 const c=escapeRegExp(g.choices),s=escapeRegExp(g.selected),pattern=new RegExp(String.raw`^let (?<effort>${ID})=null==${s}\?void 0:${s}\.slice\(${s}\.lastIndexOf\(":"\)\+1\);return ${c}\.find\(\(\{id:(?<id>${ID})\}\)=>\k<id>===${s}\)\?\?${c}\.find\(\(\{id:(?<pair>${ID}),model:(?<model>${ID})\}\)=>(?<predicate>${ID})\(\k<model>\)&&\k<pair>\.slice\(\k<pair>\.lastIndexOf\(":"\)\+1\)===\k<effort>\)\?\?${c}\.find\(\(\{model:(?<next>${ID}),reasoningEffort:(?<nextEffort>${ID})\}\)=>\k<predicate>\(\k<next>\)&&"medium"===\k<nextEffort>\)\?\?${c}\.find\(\(\{model:(?<any>${ID})\}\)=>\k<predicate>\(\k<any>\)\)\?\?${c}\.find\(\(\{reasoningEffort:(?<medium>${ID})\}\)=>"medium"===\k<medium>\)\?\?${c}\[0\]$`,'u').exec(fn.body)?.groups;
 if(!pattern)throw Error('Drifted native Pd fallback');distinct([pattern.pair,pattern.model],'fallback pair fields');distinct([pattern.next,pattern.nextEffort],'fallback next fields');noCapture([pattern.id],[g.selected],'fallback exact id');noCapture([pattern.pair,pattern.model],[pattern.effort,pattern.predicate],'fallback pair captures');noCapture([pattern.next,pattern.nextEffort,pattern.any],[pattern.predicate],'fallback predicate capture');capture(fn.body,[pattern.predicate],[g.choices,g.selected]);
 const keys=hits(native,new RegExp(String.raw`(?<key>${ID}):${escapeRegExp(pattern.predicate)}(?=[,}])`,'gu')).map(x=>x.groups.key),predicateKey=one([...new Set(keys)].filter(k=>findRspackExportPublication(module,k)?.expression===pattern.predicate),'native model-family predicate export');Default.inspectModelPredicate(native,module,{exportName:predicateKey});
 const lookup=findRspackExportPublication(module,expected.exact);if(!lookup?.fn)throw Error('Missing native exact-pair lookup');
 const text=native.slice(lookup.fn.start,lookup.fn.end),exact=new RegExp(String.raw`^function\((?<choices>${ID}),(?<model>${ID}),(?<effort>${ID})\)\{return \k<choices>\.find\((?<item>${ID})=>\k<item>\.model===\k<model>&&\k<item>\.reasoningEffort===\k<effort>\)\}$`,'u').exec(text)?.groups;
 if(!exact)throw Error('Drifted native exact-pair lookup');distinct([exact.choices,exact.model,exact.effort],'exact lookup parameters');noCapture([exact.item],[exact.model,exact.effort],'exact lookup callback');
 return{kind:state.kind,qv:expected.qv,normalizer:expected.normalizer,fallback:expected.fallback,exact:expected.exact,publicIntersection:true,nativeFlagData:'codexLinuxDefaultPresets',nativeFallbackUnchanged:true};
}
const publicationCache=new Map(),dependencyCache=new Map();
function publicationFrame(source,snapshot){
 const cacheKey=key(source,snapshot);if(publicationCache.has(cacheKey))return publicationCache.get(cacheKey);
 if(Buffer.byteLength(source)>256*1024)throw Error('Composer dependency exceeds native factory budget');
 stable(source,snapshot.params[2]);stable(source,snapshot.params[1]);const lexical=createJavaScriptLexicalIndex(source),req=escapeRegExp(snapshot.params[2]);
 const interops=hits(source,new RegExp(String.raw`(?<![\w$.])${ID}=${req}\.n\(${ID}\)(?=[,;])`,'gu'),true);if(interops.length>1)throw Error('Unsupported composer dependency interop count');assertCriticalLoaderMethodUses(source,snapshot,{allowInterop:interops.length===1});if(publicationCache.size>=64)publicationCache.delete(publicationCache.keys().next().value);publicationCache.set(cacheKey,lexical);return lexical;
}
function inspectHomeCommit(source,snapshot,expected){
 const lex=publicationFrame(source,snapshot),req=escapeRegExp(snapshot.params[2]),exp=escapeRegExp(snapshot.params[1]),registration=match(source,new RegExp(String.raw`(?<![\w$.])${req}\.d\(${exp},\{`,'gu'),'home commit publication registry',true);
 const first=registration.index+registration[0].length-1,firstEnd=lex.matchingBrace(first);let second=firstEnd+1;while(/\s/u.test(source[second]??''))second++;if(source[second++]!==',')throw Error('Missing native home value map');while(/\s/u.test(source[second]??''))second++;
 const close=lex.matchingBrace(second);if(source[second]!=='{'||close<second)throw Error('Missing native home value map');
 const map=source.slice(second+1,close),mapLex=createJavaScriptLexicalIndex(map),trivia=String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$))*`;
 const headers=[...map.matchAll(new RegExp(String.raw`(?:^|,)${trivia}(?<key>${escapeRegExp(expected.exportName)}):(?<value>async function\((?<store>${ID}),(?<choice>${ID}),(?<bridge>${ID}),(?<drop>${ID})\)\{)`,'gdu'))].filter(h=>mapLex.isRoot(h.indices.groups.key[0]));
 const head=one(headers,'actual async home member'),params={store:head.groups.store,choice:head.groups.choice,bridge:head.groups.bridge,drop:head.groups.drop};distinct(Object.values(params),'native home commit parameters');
 const start=second+1+head.indices.groups.value[0],open=second+head.index+head[0].length,end=lex.matchingBrace(open),body=source.slice(open+1,end);if(end<open)throw Error('Incomplete native home commit');
 const selected=findRspackExportPublication(snapshot,expected.selectedExport),conversation=findRspackExportPublication(snapshot,'homeConversationId$');if(!new RegExp(`^${ID}$`,'u').test(selected?.expression??'')||!new RegExp(`^${ID}$`,'u').test(conversation?.expression??''))throw Error('Missing native selected-state references');
 match(body,new RegExp(String.raw`^let ${ID}=${escapeRegExp(params.store)}\.get\(${escapeRegExp(selected.expression)}\),`,'gu'),'native home selected-state read',true);
 match(body,new RegExp(String.raw`${escapeRegExp(params.store)}\.get\(${escapeRegExp(conversation.expression)}\)`,'gu'),'native home conversation read',true);
 match(body,new RegExp(String.raw`await ${escapeRegExp(params.bridge)}\(${escapeRegExp(params.choice)}\)`,'gu'),'native home work bridge invocation');
 noCapture(Object.values(params),[selected.expression,conversation.expression],'native home selected-state captures');capture(body,[selected.expression,conversation.expression],Object.values(params));
 return{kind:'native-async-home-commit',moduleId:snapshot.moduleId,exportName:expected.exportName,selectedExport:expected.selectedExport,conversationExport:'homeConversationId$',parameters:Object.keys(params),source:source.slice(start,end+1),nativeMethodBytesUnchanged:true};
}
function semantic(value){
 const base={};for(const name of ['kind','moduleId','exportName','globalExport','localExport','frameworkModuleId','queryKeyPrefix','qv','normalizer','fallback','exact','publicIntersection','nativeFlagData','selectedExport','conversationExport'])if(value[name]!==undefined)base[name]=value[name];
 if(value.scope)base.scope=reference(value.scope);if(value.refs)base.refs=Object.fromEntries(Object.entries(value.refs).map(([k,v])=>[k,{...reference(v),...(v.flagKey?{flagKey:v.flagKey}:{})}]));return base;
}
function patchComposerConfig(extractedDir,presets,publicEfforts,options={}){
 const assetsDir=path.join(extractedDir,'webview','assets'),index=new Map(),assets=new Map(),registries=new Set();
 for(const assetName of listWebviewAssetFiles(assetsDir,/\.js$/)){const source=fs.readFileSync(path.join(assetsDir,assetName),'utf8');assets.set(assetName,source);for(const snapshot of rspackModuleFactories(source,assetName)){if(!index.has(snapshot.moduleId))index.set(snapshot.moduleId,[]);index.get(snapshot.moduleId).push(snapshot);}}
 const registry=snapshot=>{if(!registries.has(snapshot.source)){Authority.requireRegistry(snapshot.source);registries.add(snapshot.source);}};
 const ids=new Set();for(const peers of index.values())for(const snapshot of peers){if(!sourceMatch(snapshot.moduleSource))continue;try{registry(snapshot);prepareComposerFactory(snapshot.moduleSource,snapshot,presets,publicEfforts);ids.add(snapshot.moduleId);}catch(error){if(snapshot.moduleSource.includes(MARKER)||snapshot.moduleSource.includes(PREFIX))throw error;}}
 if(ids.size!==1)throw Error('Missing or ambiguous composer Default owner identity');const id=[...ids][0],copies=index.get(id),prepared=copies.map(snapshot=>{registry(snapshot);return prepareComposerFactory(snapshot.moduleSource,snapshot,presets,publicEfforts);});
 if(new Set(prepared.map(x=>x.state)).size!==1)throw Error('Mixed composer Default contribution states');
 for(const[asset,source]of assets){let outside=source;for(const copy of copies.filter(c=>c.assetName===asset).sort((a,b)=>b.start-a.start))outside=outside.slice(0,copy.start)+outside.slice(copy.end);if(outside.includes(MARKER)||outside.includes(PREFIX))throw Error('Orphan composer Default contribution outside owner');}
 const facts=prepared[0].proof;const ownerRefs=proof=>({exportName:proof.exportName,imports:Object.fromEntries(Object.entries(proof.imports).map(([k,v])=>[k,reference(v)])),query:{localExport:proof.query.localExport,globalExport:proof.query.globalExport}});for(const p of prepared)same(ownerRefs(p.proof),ownerRefs(facts),'owner references');
 const deps=[],ownerSignature=key(prepared[0].nativeSource,copies[0]);
 function qualify(ref,label,inspect){const peers=index.get(ref.moduleId);if(!peers?.length)throw Error(`Missing composer ${label} dependency`);const values=peers.map(copy=>{registry(copy);const cacheKey=JSON.stringify([ownerSignature,label,ref,copy.params,copy.moduleSource]);if(dependencyCache.has(cacheKey))return dependencyCache.get(cacheKey);const value=inspect(copy.moduleSource,copy);if(dependencyCache.size>=64)dependencyCache.delete(dependencyCache.keys().next().value);dependencyCache.set(cacheKey,value);return value;});for(const value of values)same(semantic(value),semantic(values[0]),`${label} physical references`);deps.push({id:label,moduleId:ref.moduleId,exportName:ref.exportName??null,matched:peers.length});return values[0];}
 const provider=qualify(facts.imports.provider,'config-sources',(s,m)=>Sources.inspectConfigProvider(s,m,{globalExport:facts.query.globalExport,localExport:facts.query.localExport}));
 if(provider.frameworkModuleId!==facts.imports.framework.moduleId)throw Error('Config provider uses another native framework');
 const context=qualify({...facts.imports.context,exportName:facts.context.contextExport},'cloud-context',(s,m)=>Sources.inspectConfigContext(s,m,{exportName:facts.context.contextExport}));if(context.refs.react.moduleId!==facts.imports.react.moduleId)throw Error('Config context uses another React runtime');
 const effective=qualify(provider.refs.effectiveConfig,'effective-profile-config',(s,m)=>Sources.inspectEffectiveConfigQuery(s,m,provider.refs.effectiveConfig));same(reference(effective.scope),reference(provider.scope),'config getter scope');if(effective.frameworkModuleId!==provider.frameworkModuleId)throw Error('Config query uses another framework');
 const alias=qualify(effective.refs.profileTransform,'profile-transform-alias',(s,m)=>Sources.inspectProfileAlias(s,m,effective.refs.profileTransform));
 const overlay=qualify(alias.refs.target,'active-profile-overlay',(s,m)=>Sources.inspectProfileOverlay(s,m,alias.refs.target));
 qualify(provider.refs.catalogPredicate,'native-model-catalog-predicate',(s,m)=>Sources.inspectModelCatalogPredicate(s,m,provider.refs.catalogPredicate));if(alias.refs.target.moduleId!==provider.refs.catalogPredicate.moduleId)throw Error('Profile overlay and model-catalog guard are not the native shared config utility');
 same({moduleId:overlay.refs.recordSchema.moduleId},{moduleId:provider.refs.schema.moduleId},'native config schema runtime');
 for(const [label,ref]of Object.entries({globalIdentity:provider.refs.identity,experiment:provider.refs.experiment,providerOverride:provider.refs.providerOverride,reserve:provider.refs.reserve,connectedHosts:effective.refs.connectedHosts}))qualify(ref,label,(s,m)=>inspectNamedReference(s,m,ref));
 const branch=facts.fragments.guards,modelRef=facts.imports.models;
 const mapper=qualify(branch.bridge.mapper,'native-home-mapper',(s,m)=>inspectNativeMapper(s,m,branch.bridge.mapper));
 for(const [label,ref]of Object.entries(mapper.refs))qualify(ref,'home-mapper-'+label,(s,m)=>inspectNamedReference(s,m,ref));
 const direct={host:{...facts.imports.host,exportName:facts.context.hostExport},hostAuth:{...facts.imports.hostAuth,exportName:facts.auth.exportName},selection:{...facts.imports.selection,exportName:facts.state.exportName},managed:{...facts.imports.managed,exportName:facts.managed.exportName}};
 for(const [label,ref]of Object.entries(direct))qualify(ref,label,(s,m)=>inspectNamedReference(s,m,ref,true));
 qualify(branch.homePicker,'home-picker-component',(s,m)=>inspectNamedReference(s,m,branch.homePicker));
 const ct=match(prepared[0].nativeSource,new RegExp(String.raw`\(0,${escapeRegExp(modelRef.localName)}\.(?<exportName>${ID})\)\(${escapeRegExp(facts.qv.models)},\{stripGptPrefix:!${escapeRegExp(facts.qv.strip)}\}\)\.filter\(`,'gu'),'native ordinary normalizer call').groups.exportName;
 qualify(modelRef,'native-public-pair-resolver',(s,m)=>inspectModels(s,m,{qv:facts.qv.exportName,normalizer:ct,fallback:facts.fallbackExport,exact:facts.exactExport}));
 const homeRef=branch.bridge.commit;if(homeRef.moduleId!==branch.homeState.moduleId)throw Error('Home commit is not the selected-state namespace');qualify(homeRef,'native-home-commit',(s,m)=>inspectHomeCommit(s,m,{exportName:homeRef.exportName,selectedExport:branch.home.pendingExport}));
 const external=options.validatePrepared?.({copies,prepared,dependencies:deps});if(external!=null&&typeof external.then==='function')throw Error('Composer config validation must be synchronous');
 if(presets.length===0)return{matched:copies.length,changed:0,changedAssets:[],moduleId:id,assetNames:[...new Set(copies.map(x=>x.assetName))],dependencies:deps,auditOnly:true};
 const result=patchRspackModuleCopies(assetsDir,copies,(source,snapshot)=>prepareComposerFactory(source,{...snapshot,moduleSource:source},presets,publicEfforts).patchedSource,options);return{...result,dependencies:deps};
}

function returnedMenu(owner,route,c){
 const body=owner.body,lex=createJavaScriptLexicalIndex(body),property=match(body,new RegExp(String.raw`(?:^|[,{])(?<key>onSelectDefault):${escapeRegExp(c.callback.callback)}(?=[,}])`,'gdu'),'returned Default member');
 const point=property.indices.groups.key[0];let open=-1,end=-1;for(let at=0;at<point;at++)if(body[at]==='{'&&lex.isCode(at)){const close=lex.matchingBrace(at);if(close>point&&at>open){open=at;end=close;}}
 if(open<0)throw Error('Missing returned picker props');const content=body.slice(open+1,end),objectLex=createJavaScriptLexicalIndex(content),fields=new Map();
 for(const header of content.matchAll(new RegExp(String.raw`(?:^|,)(?<key>${ID}):`,'gdu'))){if(!objectLex.isRoot(header.indices.groups.key[0]))continue;const key=header.groups.key;if(fields.has(key))throw Error('Duplicate native picker member');fields.set(key,{start:header.index+header[0].length});}
 const expected={model:c.current.model,modelOptions:c.enabled.options,reasoningEffort:c.current.effort,selectionMode:c.current.mode,onSelectDefault:c.callback.callback,modelOptionsDisabled:c.guards.disabled.modelDisabled,reasoningEffortDisabled:c.guards.disabled.effortDisabled};
 for(const[field,value]of Object.entries(expected)){const at=fields.get(field)?.start;if(at==null||!new RegExp(String.raw`^${escapeRegExp(value)}(?=,|$)`,'u').test(content.slice(at)))throw Error(`Wrong native picker ${field} member`);}
 // Match the literal call syntax rather than a suffix-bearing member name.
 const call=new RegExp(String.raw`\(0,(?<jsx>${ID})\.(?<create>${ID})\)\((?<namespace>${ID})\.(?<exportName>${ID}),$`,'u').exec(body.slice(0,open));if(!call)throw Error('Picker props do not belong to a native JSX call');
 const fragmentOpen=[...body.slice(0,open).matchAll(/\{/gu)].filter(x=>lex.isCode(x.index)&&lex.matchingBrace(x.index)>end).map(x=>x.index).pop();if(fragmentOpen==null)throw Error('Missing returned picker Fragment');
 const prefix=new RegExp(String.raw`(?<result>${ID})=\(0,${escapeRegExp(call.groups.jsx)}\.${escapeRegExp(call.groups.create)}\)\(${escapeRegExp(call.groups.jsx)}\.Fragment,$`,'u').exec(body.slice(0,fragmentOpen));if(!prefix||!lex.isRoot(prefix.index))throw Error('Native picker Fragment is not assigned to the returned node');
 const returned=match(body,/\breturn\b/gu,'root picker return',true);if(returned.index>fragmentOpen||!new RegExp(String.raw`:${escapeRegExp(prefix.groups.result)}=${escapeRegExp(route.decl.cache)}\[\d+\],${escapeRegExp(prefix.groups.result)}$`,'u').test(body))throw Error('Picker node does not reach the render result');
 capture(body,[call.groups.namespace,call.groups.jsx],[owner.input]);return{...owner.imported(call.groups.namespace),exportName:call.groups.exportName,nativeOutputDefaultMember:true};
}

function inspectNativeMapper(source,snapshot,ref){
 publicationFrame(source,snapshot);const pub=findRspackExportPublication(snapshot,ref.exportName);if(!pub?.fn)throw Error('Missing native home effort mapper');
 const text=source.slice(pub.fn.start,pub.fn.end),g=new RegExp(String.raw`^function\((?<selection>${ID}),(?<response>${ID})\)\{let (?<model>${ID})=\k<selection>\?\.model\?\?null,(?<found>${ID})=\k<response>\?\.models\.find\((?<item>${ID})=>\k<item>\.model===\k<model>\)\?\?\k<response>\?\.models\.find\((?<alias>${ID})=>\x60\$\{\k<alias>\.model\}-wm\x60===\k<model>\),(?<parsed>${ID})=(?<catalog>${ID})\.(?<schemaExport>${ID})\.safeParse\(\k<selection>\?\.reasoningEffort\);return\{model:\k<found>\?\.model\?\?\k<model>,reasoningEffort:\k<parsed>\.success\?(?<names>${ID})\.(?<namesExport>${ID})\[\k<parsed>\.data\]:\k<selection>\?\.reasoningEffort\?\?null\}\}$`,'u').exec(text)?.groups;
 if(!g)throw Error('Drifted native home effort mapper');distinct([g.selection,g.response,g.model,g.found,g.parsed],'home mapper locals');noCapture([g.item,g.alias],[g.model],'home mapper model lookup');capture(pub.fn.body,[g.catalog,g.names],[g.selection,g.response]);
 const imported=name=>{const b=findRspackRequireBinding(snapshot,name);if(!b)throw Error('Missing native home mapper import');stable(source,name,b.start-(snapshot.start??0));return{moduleId:b.moduleId,localName:name};};
 return{kind:'native-home-mapper',moduleId:snapshot.moduleId,exportName:ref.exportName,refs:{schema:{...imported(g.catalog),exportName:g.schemaExport},names:{...imported(g.names),exportName:g.namesExport}},source:text,nativeWorkAliasPreserved:true};
}
function inspectNamedReference(source,snapshot,ref,callable=false){
 publicationFrame(source,snapshot);const pub=findRspackExportPublication(snapshot,ref.exportName);if(!pub)throw Error('Missing linked native reference');
 if(callable){if(pub.fn){if(!/^function\(/u.test(source.slice(pub.fn.start,pub.fn.end)))throw Error('Non-synchronous native caller dependency');}else if(new RegExp(`^${ID}$`,'u').test(pub.expression??'')){
   const name=pub.expression,declarations=hits(source,new RegExp(String.raw`\bfunction ${escapeRegExp(name)}\(`,'gu'),true);
   if(declarations.length)findSynchronousFunctionDeclaration(source,snapshot,name);
   else{const hit=match(source,new RegExp(String.raw`(?<![\w$.])(?<binder>${escapeRegExp(name)})=(?<value>function\((?<params>[^)]*)\)\{)`,'gdu'),'native synchronous callable initializer',true),end=createJavaScriptLexicalIndex(source).matchingBrace(hit.index+hit[0].length-1)+1;if(end<=hit.index||source.slice(end).trimStart()&&!/^[,;]/u.test(source.slice(end).trimStart()))throw Error('Native callable initializer suffix');declaredAt(source,name,hit.indices.groups.binder[0]);stable(source,name,hit.indices.groups.binder[0]);}
  }else throw Error('Unsupported native callable publication');}
 return{kind:callable?'native-synchronous-reference':'native-reference',moduleId:snapshot.moduleId,exportName:ref.exportName};
}

function prepareAsset(source,presets,publicEfforts){
 Authority.requireRegistry(source);const candidates=[];for(const snapshot of rspackModuleFactories(source,'composer-compat.js')){if(!sourceMatch(snapshot.moduleSource))continue;try{candidates.push({snapshot,prepared:prepareComposerFactory(snapshot.moduleSource,snapshot,presets,publicEfforts)})}catch(error){if(snapshot.moduleSource.includes(MARKER)||snapshot.moduleSource.includes(PREFIX))throw error;}}
 return one(candidates,'complete registry compatibility owner');
}
function composerConfigContract(source,presets,publicEfforts){try{return prepareAsset(source,presets,publicEfforts).prepared.state==='applied'?'applied':'current'}catch{return typeof source==='string'&&(source.includes(MARKER)||source.includes(PREFIX))?'mixed':'drifted';}}
function applyComposerConfigAsset(source,presets,publicEfforts){if(presets.length===0)return source;const{snapshot,prepared}=prepareAsset(source,presets,publicEfforts);return source.slice(0,snapshot.start)+prepared.patchedSource+source.slice(snapshot.end);}
module.exports={MARKER,sourceMatch,composerConfig,composerConfigContract,applyComposerConfigAsset,prepareComposerFactory,patchComposerConfig,inspectModels,inspectHomeCommit,inspectNativeMapper};
