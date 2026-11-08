"use strict";
const path=require("node:path");
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,patchRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {inspectModelSettingsOwner}=require("../../scripts/patches/lib/model-composer-owners.js");
const {requireStableCatalogBinding:stable}=require("./catalog-binding-authority.js");
const {assertCriticalLoaderMethodUses}=require("./critical-loader-authority.js");
const {findSynchronousFunctionDeclaration}=require("./synchronous-function-declaration.js");
const {requireRegistry}=require("./native-catalog-authority.js");
const {createExistingChatSelectionRuntime}=require("./existing-chat-selection-runtime.js");
const Dependencies=require("./existing-chat-dependencies.js");
const ID="[A-Za-z_$][\\w$]*";
const MARKER="codex-linux-model-picker-default-presets-existing-chat-selection-v2";
const NAMES={runtime:"codexLinuxExistingChatSelectionRuntime",lease:"codexLinuxExistingChatSelectionLease",
  direct:"codexLinuxExistingChatDirectTicket",queued:"codexLinuxExistingChatQueuedTicket",result:"codexLinuxExistingChatWriteResult"};
const NEEDLES=["hasManagedNewThreadSettings:","setModelAndReasoningEffortForNextTurn:","No conversation available for next-turn model update"];
const COPILOT_MARKERS=["codexLinuxCopilotEffortPreferences","codexLinuxCopilotEffortSelection","codexLinuxCopilotRequestedEffort"];
const RETIRED_MARKERS=["codex-linux-model-picker-default-presets-existing-chat-optimistic-selection","codexLinuxExistingChatDefaultPresetIds","codexLinuxKeepOptimisticSelection"];
const AUTH_FIELDS=["authMethod","openAIAuth","accountId","userId","email"];
const one=(rows,label)=>{if(rows.length!==1)throw Error(`Missing or ambiguous existing-chat ${label}`);return rows[0]};
const sourceMatch=source=>NEEDLES.every(needle=>source.includes(needle))||source.includes(MARKER);
const same=(left,right,label)=>{if(JSON.stringify(left)!==JSON.stringify(right))throw Error(`Inconsistent existing-chat ${label}`)};

function configuration(presets,effortNames) {
  if(!Array.isArray(presets)||presets.length===0||effortNames==null||typeof effortNames!=="object")throw Error("Missing existing-chat preset configuration");
  const ids=[];
  for(const preset of presets){
    const effort=effortNames[preset.thinkingEffort];
    if(typeof preset.modelSlug!=="string"||!preset.modelSlug||typeof effort!=="string")throw Error("Invalid existing-chat preset pair");
    for(const value of [preset.thinkingEffort,effort]){const id=`${preset.modelSlug}:${value}`;if(!ids.includes(id))ids.push(id)}
  }
  const aliases=Object.entries(effortNames);if(aliases.some(([from,to])=>!from||typeof to!=="string"||!to))throw Error("Invalid existing-chat effort aliases");
  return{ids,aliases};
}
// Encode data, including escape characters, as UTF-16 JSON string literals.
// User slugs cannot impersonate another feature's plain-text source markers.
function encodedJson(value){
  if(Array.isArray(value))return`[${value.map(encodedJson).join(",")}]`;
  if(typeof value!=="string")throw Error("Expected string data in existing-chat runtime configuration");
  let result='"';for(let index=0;index<value.length;index++)result+=`\\u${value.charCodeAt(index).toString(16).padStart(4,"0")}`;return result+'"';
}
function runtimePrefix(config){return`/*${MARKER}*/const ${NAMES.runtime}=(${createExistingChatSelectionRuntime.toString()})(${encodedJson(config.ids)},${encodedJson(config.aliases)});`;}
function syntax(source,snapshot){
  if(typeof source!=="string"||Buffer.byteLength(source)>256*1024||snapshot?.params?.length!==3||new Set(snapshot.params).size!==3)throw Error("Invalid existing-chat factory input");
  try{new Script(`"use strict";(function(${snapshot.params.join(",")}){${source}})`)}catch{throw Error("Invalid existing-chat factory syntax")}
}
function rootMatches(source,regex){const lexical=createJavaScriptLexicalIndex(source);return[...source.matchAll(regex)].filter(hit=>lexical.isRoot(hit.index));}
function capturedAt(body,parameters,names,start,end){
  let scope="__codexExistingChatCapturedScope";while(body.includes(scope))scope+="$";
  const wrap=value=>`async function ${scope}(${parameters.join(",")}){${value}}`;
  for(const name of [...new Set(names)]){
    if(parameters.includes(name))throw Error(`Shadowed existing-chat captured role: ${name}`);
    stable(wrap(body),name);
    const probe=body.slice(0,start)+`(${name}=${name},${body.slice(start,end)})`+body.slice(end);
    let local=false;try{stable(wrap(probe),name);local=true}catch{}
    if(local)throw Error(`Shadowed existing-chat captured use: ${name}`);
  }
}
function capturedStatement(body,parameters,name,at){
  if(parameters.includes(name))throw Error(`Shadowed existing-chat captured role: ${name}`);
  let scope="__codexExistingChatStatementScope";while(body.includes(scope))scope+="$";
  const wrap=value=>`async function ${scope}(${parameters.join(",")}){${value}}`;
  stable(wrap(body),name);
  const probe=body.slice(0,at)+`(${name}=${name});`+body.slice(at);
  let local=false;try{stable(wrap(probe),name);local=true}catch{}
  if(local)throw Error(`Shadowed existing-chat statement capture: ${name}`);
}
function metadataProvenance(source,snapshot,owner,body,meta){
  const o=owner,reader=o.effectiveSettings.optimistic.reader,conv=escapeRegExp(o.conversation),has=escapeRegExp(o.target.hasConversation),ready=escapeRegExp(o.nextTurn.ready);
  const record=one(rootMatches(body,new RegExp(`${has}=\\(0,${escapeRegExp(reader.localName)}\\.${escapeRegExp(reader.exportName)}\\)\\((?<namespace>${ID})\\.(?<exists>${ID}),${conv}\\),(?<record>${ID})=\\(0,${escapeRegExp(reader.localName)}\\.${escapeRegExp(reader.exportName)}\\)\\(\\k<namespace>\\.(?<data>${ID}),${conv}\\),${ready}=${has}&&\\k<record>\\?\\.resumeState==="resumed"`,"gu")),"thread metadata and readiness source");
  const collaboration=one(rootMatches(body,new RegExp(`(?<![\\w$.])(?<collaboration>${ID})=${escapeRegExp(record.groups.record)}\\?\\.collaborationMode,(?<raw>${ID})=\\k<collaboration>\\?\\.settings\\.model\\?\\?null`,"gu")),"thread collaboration model source");
  const result=source.slice(o.result.start,o.result.end);
  const luna=new RegExp(`isLunaReserveActive:(?<name>${ID})(?=,)`,"u").exec(result)?.groups.name;
  const original=new RegExp(`originalAdvancedModelSettings:(?<name>${ID})(?=,)`,"u").exec(result)?.groups.name;
  if(!luna||!original)throw Error("Disconnected existing-chat original thread metadata");
  const raw=escapeRegExp(collaboration.groups.raw),orig=escapeRegExp(original),active=escapeRegExp(luna);
  const declaration=one(rootMatches(body,new RegExp(`let ${escapeRegExp(meta.model)}=(?<modelSource>${ID}),${escapeRegExp(meta.effort)}=${raw}!==(?<reserved>${ID})\\.(?<reserveKey>${ID})\\|\\|${active}\\|\\|null==${orig}\\?${escapeRegExp(collaboration.groups.collaboration)}\\?\\.settings\\.reasoning_effort\\?\\?null:${orig}\\.reasoningEffort;`,"gu")),"real metadata result aliases");
  const modelSource=declaration.groups.modelSource;
  const cache=one(rootMatches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(modelSource)}=null!=${raw}&&${raw}\\.trim\\(\\)\\.length>0&&\\(${active}\\|\\|${raw}!==${escapeRegExp(declaration.groups.reserved)}\\.${escapeRegExp(declaration.groups.reserveKey)}\\)\\?${raw}:${orig}\\?\\.model\\?\\?null,(?<memo>${ID})\\[(?<rawSlot>\\d+)\\]=${raw},\\k<memo>\\[(?<activeSlot>\\d+)\\]=${active},\\k<memo>\\[(?<originalSlot>\\d+)\\]=${orig}\\?\\.model,\\k<memo>\\[(?<resultSlot>\\d+)\\]=${escapeRegExp(modelSource)}\\):${escapeRegExp(modelSource)}=\\k<memo>\\[\\k<resultSlot>\\]`,"gu")),"thread metadata model memo");
  const guard=`${cache.groups.memo}[${cache.groups.rawSlot}]!==${collaboration.groups.raw}||${cache.groups.memo}[${cache.groups.activeSlot}]!==${luna}||${cache.groups.memo}[${cache.groups.originalSlot}]!==${original}?.model?(`;
  if(body.slice(cache.index-guard.length,cache.index)!==guard)throw Error("Disconnected thread metadata cache guard");
  const head=new RegExp(`^let (?<list>${ID}(?:,${ID})*),(?<memo>${ID})=\\(0,${ID}\\.${ID}\\)\\(\\d+\\),`,"u").exec(body);
  if(!head||head.groups.memo!==cache.groups.memo)throw Error("Unsupported native metadata memo declaration");
  const names=head.groups.list.split(","),at=names.indexOf(modelSource);
  if(at<0||names.lastIndexOf(modelSource)!==at)throw Error("Metadata source is not the native memo local");
  const binder=4+names.slice(0,at).reduce((sum,name)=>sum+name.length+1,0);
  const first=cache.index,last=cache.index+cache[0].lastIndexOf(`${modelSource}=${cache.groups.memo}[`);
  let projection=body,fresh="__codexExistingChatMetadataMemo";while(body.includes(fresh))fresh+="$";
  for(const index of [binder,first,last].sort((a,b)=>b-a)){if(projection.slice(index,index+modelSource.length)!==modelSource)throw Error("Invalid metadata memo binding projection");projection=projection.slice(0,index)+fresh+projection.slice(index+modelSource.length)}
  stable(projection,modelSource);
  const modelAt=declaration.index+"let ".length,effortAt=declaration.index+declaration[0].indexOf(`${meta.effort}=`);
  stable(body,meta.model,modelAt);stable(body,meta.effort,effortAt);
  for(const [name,index]of [[collaboration.groups.collaboration,collaboration.index],[collaboration.groups.raw,collaboration.index+collaboration[0].indexOf(`${collaboration.groups.raw}=`)],[record.groups.record,record.index+record[0].indexOf(`${record.groups.record}=`)]])stable(body,name,index);
  const binding=findRspackRequireBinding(snapshot,record.groups.namespace);
  if(!binding)throw Error("Missing actual thread metadata namespace");
  stable(source,binding.localName,binding.start-(snapshot.start??0));
  return{moduleId:binding.moduleId,existsExport:record.groups.exists,dataExport:record.groups.data,
    reader:{moduleId:reader.moduleId,exportName:reader.exportName},record:record.groups.record,
    collaboration:collaboration.groups.collaboration,model:meta.model,effort:meta.effort,
    usesActualThreadMetadata:true,accountFallbackIsAcknowledgement:false};
}

function inspectExistingChatOwner(source,snapshot,options={}) {
  syntax(source,snapshot);
  const module={...snapshot,moduleSource:source};
  assertCriticalLoaderMethodUses(source,module,{allowInterop:true});
  const owner=inspectModelSettingsOwner(module);
  if(!owner.ok)throw Error(`Unsupported existing-chat native settings owner: ${owner.reason}`);
  findSynchronousFunctionDeclaration(source,module,owner.publication.expression);
  const wrapperPrefix=source.slice(owner.owner.body.start,owner.state.start);
  const stateInitializer=new RegExp(`(?<![\\w$.])(?<name>${ID})=(?:\\s|/\\*[\\s\\S]*?\\*/)*$`,"u").exec(wrapperPrefix);
  if(!stateInitializer)throw Error("Existing-chat state must be a synchronous native function expression");
  const stateBody=source.slice(owner.state.body.start,owner.state.body.end),bodyLexical=createJavaScriptLexicalIndex(stateBody);
  if(rootMatches(stateBody,/\breturn\b/gu).length!==1)throw Error("Existing-chat hook must reach its unconditional native return");
  const parameters=source.slice(owner.state.start,owner.state.body.start-1).match(/^function\(([^)]*)\)$/u)?.[1].split(",");
  if(parameters?.length!==5)throw Error("Unsupported existing-chat state declaration");
  const react=one([...stateBody.matchAll(new RegExp(`\\(0,(?<namespace>${ID})\\.use\\)\\(${ID}\\.${ID}\\)`,"gu"))].filter(hit=>bodyLexical.isRoot(hit.index)),"React context namespace");
  const reactBinding=findRspackRequireBinding(module,react.groups.namespace);
  if(!reactBinding)throw Error("Missing existing-chat React namespace import");
  stable(source,react.groups.namespace,reactBinding.start-(snapshot.start??0));
  const optionsText=source.slice(owner.profile.options.start,owner.profile.options.end);
  const auth=one([...optionsText.matchAll(new RegExp(`isChatGptAuth:(?<name>${ID})(?=,)`,"gu"))],"ChatGPT auth reader").groups.name;
  const authBinding=one(rootMatches(stateBody,new RegExp(`(?<![\\w$.])${escapeRegExp(auth)}=${escapeRegExp(owner.active.identity.host)}\\?\\.authMethod==="chatgpt"`,"gu")),"ChatGPT native auth binding");
  stable(stateBody,auth,authBinding.index);
  const baseText=source.slice(owner.effectiveSettings.base.selection.start,owner.effectiveSettings.base.selection.end);
  const meta=new RegExp(`model:(?<model>${ID})\\?\\?${escapeRegExp(owner.profile.settings)}\\.model,reasoningEffort:null==\\k<model>\\?${escapeRegExp(owner.profile.settings)}\\.reasoningEffort:(?<effort>${ID}),profile:`,"u").exec(baseText)?.groups;
  if(!meta||meta.model===meta.effort)throw Error("Missing real existing-chat metadata roles");
  const metadata=metadataProvenance(source,module,owner,stateBody,meta);
  const read=owner.effectiveSettings.optimistic,aliases=source.slice(owner.effectiveSettings.base.aliases.start,owner.effectiveSettings.base.aliases.end);
  const storeConstructor=one(rootMatches(stateBody,new RegExp(`(?<![\\w$.])${escapeRegExp(owner.target.store)}=\\(0,(?<framework>${ID})\\.(?<exportName>${ID})\\)\\((?<scope>${ID})\\.(?<scopeExport>${ID})\\)`,"gu")),"native target store scope").groups;
  const linkedImports={};
  for(const name of [storeConstructor.framework,storeConstructor.scope]){
    const binding=findRspackRequireBinding(module,name);
    if(!binding)throw Error("Missing native target store import");stable(source,name,binding.start-(snapshot.start??0));linkedImports[name]=binding;
  }
  const storeScope={framework:{moduleId:linkedImports[storeConstructor.framework].moduleId,exportName:storeConstructor.exportName},
    scope:{moduleId:linkedImports[storeConstructor.scope].moduleId,exportName:storeConstructor.scopeExport}};
  if(storeScope.framework.moduleId!==read.reader.moduleId)throw Error("Existing-chat store and pending reader use different frameworks");
  const currentText=source.slice(owner.current.setter.start,owner.current.setter.end);
  const currentParams=new RegExp(`^${ID}=\\((?<model>${ID}),(?<effort>${ID}),(?<options>${ID})\\)=>\\{`,"u").exec(currentText)?.groups;
  const nextText=source.slice(owner.nextTurn.setter.start,owner.nextTurn.setter.end);
  const nextParams=new RegExp(`^${ID}=async\\((?<model>${ID}),(?<effort>${ID}),(?<options>${ID})\\)=>\\{`,"u").exec(nextText)?.groups;
  const writerText=source.slice(owner.default.writer.start,owner.default.writer.end);
  const writerParams=new RegExp(`^${ID}=async\\((?<model>${ID}),(?<effort>${ID}),(?<scope>${ID}),(?<tier>${ID})\\)=>\\{`,"u").exec(writerText)?.groups;
  if(!currentParams||!nextParams||!writerParams)throw Error("Unsupported existing-chat native setter declarations");
  const currentCall=source.slice(owner.current.write.start,owner.current.write.end);
  const tier=new RegExp(`serviceTier:(?<name>${ID})\\},\\(\\)=>`,"u").exec(currentCall)?.groups.name;
  const currentTarget=new RegExp(`^(?<name>${ID})=`,"u").exec(source.slice(owner.current.target.start,owner.current.target.end))?.groups.name;
  const nextTarget=new RegExp(`^(?<name>${ID})=`,"u").exec(source.slice(owner.nextTurn.target.start,owner.nextTurn.target.end))?.groups.name;
  const invoke=new RegExp(`^await (?<name>${ID})\\(`,"u").exec(source.slice(owner.nextTurn.invoke.start,owner.nextTurn.invoke.end))?.groups.name;
  if(!tier||!currentTarget||!nextTarget||!invoke)throw Error("Disconnected existing-chat native setter roles");
  const writerCurrent=`if("current"===(void 0===${writerParams.scope}?"current":${writerParams.scope})&&await ${invoke}(${writerParams.model},${writerParams.effort},void 0===${writerParams.tier}?void 0:{threadSettings:{serviceTier:${writerParams.tier}}}))return!0;`;
  const writerCurrentAt=writerText.indexOf(writerCurrent);
  if(writerCurrentAt<0||writerText.split(writerCurrent).length!==2)throw Error("Missing exact native current-write success branch");
  const writerBody=source.slice(owner.default.writer.body.start,owner.default.writer.body.end);
  const writerBodyAt=writerCurrentAt-(owner.default.writer.body.start-owner.default.writer.start);
  const currentExpr=`${invoke}(${writerParams.model},${writerParams.effort},void 0===${writerParams.tier}?void 0:{threadSettings:{serviceTier:${writerParams.tier}}})`;
  const currentExprAt=writerBodyAt+writerCurrent.indexOf(currentExpr);
  capturedAt(writerBody,Object.values(writerParams),[owner.target.store,owner.target.localName,read.target],currentExprAt,currentExprAt+currentExpr.length);
  const companion=COPILOT_MARKERS.some(marker=>source.includes(marker));
  if(companion){
    if(typeof options.copilotState!=="function"||options.copilotState(source,snapshot).kind!=="patched")throw Error("Unqualified Copilot settings sibling contribution");
  }
  return{owner,react:{...reactBinding},auth,meta,metadata,currentParams,nextParams,writerParams,
    currentCall,tier,currentTarget,nextTarget,invoke,writerCurrent,currentExpr,
    aliases,storeScope,companion:companion?"copilot-persistence":"native",stateParameters:parameters};
}

function buildEdits(source,snapshot,config,options={}) {
  const frame=inspectExistingChatOwner(source,snapshot,options),o=frame.owner;
  for(const name of Object.values(NAMES))if(source.includes(name))throw Error(`Existing-chat helper collides with native source: ${name}`);
  for(const name of ["Set","Map","WeakMap","JSON"]){
    if(snapshot.params.includes(name))throw Error(`Existing-chat runtime builtin is a factory parameter: ${name}`);
    stable(source,name);
  }
  const store=o.target.store,namespace=o.target.localName,read=o.effectiveSettings.optimistic;
  const writingAtom=new RegExp(`${escapeRegExp(namespace)}\\.(?<key>${ID}),${escapeRegExp(read.target)}\\)$`,"u").exec(source.slice(read.committedRead.start,read.committedRead.end))?.groups.key;
  if(!writingAtom)throw Error("Missing actual existing-chat native writing atom");
  const stateBody=source.slice(o.state.body.start,o.state.body.end);
  capturedStatement(stateBody,frame.stateParameters,"JSON",o.effectiveSettings.base.aliases.end-o.state.body.start);
  capturedStatement(stateBody,frame.stateParameters,frame.react.localName,o.effectiveSettings.base.aliases.end-o.state.body.start);
  const principal=`JSON.stringify([${AUTH_FIELDS.map(field=>`${o.active.identity.host}?.${field}`).join(",")}])`;
  const hook=`const ${NAMES.lease}=${NAMES.runtime}.use(${frame.react.localName},{store:${store},pendingAtom:${namespace}.${o.nextTurn.optimistic.atom},writingAtom:${namespace}.${writingAtom},target:${read.target},hostId:${o.active.hostId},conversationId:${o.conversation},profile:${o.profile.expression},authIdentity:${principal},chatGpt:${frame.auth},hasConversation:${o.target.hasConversation},ready:${o.nextTurn.ready},metadataModel:${frame.meta.model},metadataEffort:${frame.meta.effort},pending:${read.pending},writing:${read.committed}});`;
  const nextValue=source.slice(o.nextTurn.optimistic.value.start,o.nextTurn.optimistic.value.end)+";";
  const beginDirect=`let ${NAMES.direct}=${NAMES.runtime}.begin(${NAMES.lease},{store:${store},target:${frame.nextTarget},selection:${o.nextTurn.optimistic.selection},hostId:${o.active.hostId}});`;
  const cleanup=source.slice(o.nextTurn.optimistic.cleanup.start,o.nextTurn.optimistic.cleanup.end);
  const nativeFinally=`.finally(()=>{${cleanup}})`;
  const directFinally=`.then(()=>{${NAMES.runtime}.directSucceeded(${NAMES.direct})})${nativeFinally}.finally(()=>{${NAMES.runtime}.finished(${NAMES.direct})})`;
  const p=frame.currentParams;
  const beginQueued=`let ${NAMES.queued}=${NAMES.runtime}.begin(${NAMES.lease},{store:${store},target:${frame.currentTarget},selection:{model:${p.model},reasoningEffort:${p.effort},serviceTier:${frame.tier}},hostId:${o.active.hostId}});`;
  const queued=`${beginQueued}${frame.currentCall}.then(${NAMES.runtime}.bindQueued(${NAMES.queued},${store}.get(${namespace}.${o.nextTurn.optimistic.atom},${frame.currentTarget}))).finally(()=>{${NAMES.runtime}.finished(${NAMES.queued})})`;
  const writeHook=`${frame.currentExpr}.then(${NAMES.result}=>${NAMES.runtime}.queuedResult(${store},${namespace}.${writingAtom},${read.target},${NAMES.result}))`;
  const edits=[{from:frame.aliases,to:frame.aliases+hook},{from:nextValue,to:nextValue+beginDirect},
    {from:nativeFinally,to:directFinally},{from:frame.currentCall,to:queued},
    {from:frame.writerCurrent,to:frame.writerCurrent.replace(frame.currentExpr,writeHook)}];
  for(const edit of edits)if(source.split(edit.from).length!==2)throw Error("Ambiguous existing-chat feature insertion");
  return{frame,edits,prefix:runtimePrefix(config),writingAtom};
}
function forward(source,plan){for(const edit of plan.edits)source=source.replace(edit.from,edit.to);return plan.prefix+source;}

function prepareExistingChatSelection(source,snapshot,presets,effortNames,options={}) {
  syntax(source,snapshot);const config=configuration(presets,effortNames),prefix=runtimePrefix(config);
  let native=source,state="pristine",validatedPlan=null;
  if(source.includes(MARKER)){
    if(!source.startsWith(prefix))throw Error("Orphan or stale existing-chat selection contribution");
    let candidate=source.slice(prefix.length);
    // Restore fixed feature additions by their reserved identifiers, then
    // prove the native roles afresh and require exact whole-factory replay.
    candidate=candidate.replace(new RegExp(`const ${NAMES.lease}=${NAMES.runtime}\\.use\\([\\s\\S]*?\\);`,"u"),"");
    candidate=candidate.replace(new RegExp(`let ${NAMES.direct}=${NAMES.runtime}\\.begin\\([^;]+;`,"u"),"");
    candidate=candidate.replace(new RegExp(`\\.then\\(\\(\\)=>\\{${NAMES.runtime}\\.directSucceeded\\(${NAMES.direct}\\)\\}\\)`,"u"),"");
    candidate=candidate.replace(new RegExp(`\\.finally\\(\\(\\)=>\\{${NAMES.runtime}\\.finished\\(${NAMES.direct}\\)\\}\\)`,"u"),"");
    candidate=candidate.replace(new RegExp(`let ${NAMES.queued}=${NAMES.runtime}\\.begin\\([^;]+;`,"u"),"");
    candidate=candidate.replace(new RegExp(`\\.then\\(${NAMES.runtime}\\.bindQueued\\(${NAMES.queued},${ID}\\.get\\(${ID}\\.${ID},${ID}\\)\\)\\)`,"u"),"");
    candidate=candidate.replace(new RegExp(`\\.finally\\(\\(\\)=>\\{${NAMES.runtime}\\.finished\\(${NAMES.queued}\\)\\}\\)`,"u"),"");
    candidate=candidate.replace(new RegExp(`\\.then\\(${NAMES.result}=>${NAMES.runtime}\\.queuedResult\\(${ID},${ID}\\.${ID},${ID},${NAMES.result}\\)\\)`,"u"),"");
    if(candidate.includes(MARKER)||Object.values(NAMES).some(name=>candidate.includes(name)))throw Error("Partial existing-chat selection contribution");
    validatedPlan=buildEdits(candidate,{...snapshot,moduleSource:candidate},config,options);
    if(forward(candidate,validatedPlan)!==source)throw Error("Noncanonical existing-chat selection replay");
    native=candidate;state="applied";
  }else if(RETIRED_MARKERS.some(marker=>source.includes(marker))||Object.values(NAMES).some(name=>source.includes(name))){throw Error("Retired or orphan existing-chat contribution")}
  const plan=validatedPlan??buildEdits(native,{...snapshot,moduleSource:native},config,options),patched=forward(native,plan);
  syntax(patched,snapshot);
  return{state,nativeSource:native,patchedSource:patched,proof:{moduleId:snapshot.moduleId,
    publication:plan.frame.owner.publication,companion:plan.frame.companion,
    active:plan.frame.owner.active,profile:plan.frame.owner.profile.expression,
    target:plan.frame.owner.target,writingAtom:plan.writingAtom,queueExport:new RegExp(`^return\\(0,${escapeRegExp(plan.frame.owner.target.localName)}\\.(?<key>${ID})\\)`,"u").exec(plan.frame.currentCall)?.groups.key,storeScope:plan.frame.storeScope,react:plan.frame.react,
    metadata:plan.frame.meta,metadataSource:plan.frame.metadata,authPrincipalFields:[...AUTH_FIELDS],locals:{...NAMES},runtimePrefixLength:plan.prefix.length,effectiveTarget:plan.frame.owner.effectiveSettings.optimistic.target,scope:{state:plan.frame.owner.state,wrapper:plan.frame.owner.owner},
    edits:plan.edits.map(edit=>({...edit})),nativeCurrent:plan.frame.owner.current,
    nativeNextTurn:plan.frame.owner.nextTurn,nativeWriter:plan.frame.owner.default.writer,
    unchangedNativeFinally:true,unchangedNativeRpcAndQueue:true}};
}

function dependencyCopies(assets,id,description,inspect){
  const copies=findUniqueRspackModuleCopies(assets,{description,
    sourceMatch:source=>source.includes(id)||source.includes("\\u")||source.includes("\\/"),
    matchModule(source,snapshot){if(snapshot.moduleId!==id||Buffer.byteLength(source)>256*1024)return false;try{inspect(source,snapshot);return true}catch{return false}},
  });
  const facts=copies.map(copy=>{requireRegistry(copy.source);return inspect(copy.moduleSource,copy)});
  return{copies,facts};
}
function validateDependencies(assets,proofs){
  const first=proofs[0];
  const semantic=proof=>({queueModuleId:proof.target.moduleId,targetExport:proof.target.exportName,pendingExport:proof.nativeNextTurn.optimistic.atom,
    writingExport:proof.writingAtom,queueExport:proof.queueExport,reactModuleId:proof.react.moduleId,storeScope:proof.storeScope});
  for(const proof of proofs)same(semantic(proof),semantic(first),"physical native references");
  const queue=dependencyCopies(assets,first.target.moduleId,"native existing-chat queue/target dependency",Dependencies.inspectSelectionQueueProvider);
  for(const fact of queue.facts){
    same({moduleId:fact.moduleId,targetExport:fact.targetExport,pendingExport:fact.pendingExport,writingExport:fact.writingExport,queueExport:fact.queueExport},
      {moduleId:first.target.moduleId,targetExport:first.target.exportName,pendingExport:first.nativeNextTurn.optimistic.atom,writingExport:first.writingAtom,queueExport:first.queueExport},"actual queue publications");
    same(fact.scope,first.storeScope.scope,"native queue and settings scope");
    same(fact.framework.moduleId,first.storeScope.framework.moduleId,"native queue and settings framework");
  }
  const forwarder=dependencyCopies(assets,first.react.moduleId,"native React hook namespace forwarder",Dependencies.inspectReactForwarder);
  for(const fact of forwarder.facts)same(fact.targetModuleId,forwarder.facts[0].targetModuleId,"React forwarder copies");
  const client=dependencyCopies(assets,forwarder.facts[0].targetModuleId,"native React client hook APIs",Dependencies.inspectReactClientHooks);
  for(const fact of client.facts)same({moduleId:fact.moduleId,useRef:fact.useRefExport,useLayoutEffect:fact.useLayoutEffectExport},
    {moduleId:forwarder.facts[0].targetModuleId,useRef:"useRef",useLayoutEffect:"useLayoutEffect"},"actual React public hook APIs");
  return[{id:"native-queue",moduleId:queue.facts[0].moduleId,matched:queue.copies.length},
    {id:"react-forwarder",moduleId:forwarder.facts[0].moduleId,matched:forwarder.copies.length},
    {id:"react-client-hooks",moduleId:client.facts[0].moduleId,matched:client.copies.length}];
}

function patchExistingChatSelections(extractedDir,presets,effortNames,context={},options={}) {
  if(presets.length===0)return{matched:0,changed:0,changedAssets:[]};
  const fixedPresets=Object.freeze(presets.map(row=>Object.freeze({modelSlug:row.modelSlug,thinkingEffort:row.thinkingEffort,isDefault:row.isDefault})));
  const fixedEfforts=Object.freeze({...effortNames});configuration(fixedPresets,fixedEfforts);
  const assets=path.join(extractedDir,"webview","assets"),markers=new Set();
  let copilotState;
  if(context.enabledFeatureIds?.includes("copilot-reasoning-effort")){
    // Only a jointly enabled sibling needs its existing canonical decoder;
    // preset-only update bundles do not depend on disabled feature files.
    copilotState=require("../copilot-reasoning-effort/patch.js").settingsPersistenceState;
  }
  // The six physical copies can contain exactly the same factory. Reuse only
  // a fully proved body within this synchronous invocation; physical registry,
  // identity closure, source states and dependency checks remain per copy.
  const bodies=new Map();
  const freeze=value=>{if(value&&typeof value==="object"&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value)}return value};
  const prepare=(source,snapshot)=>{
    const key=JSON.stringify([snapshot.moduleId,snapshot.params])+":"+source;
    if(bodies.has(key))return bodies.get(key);
    const relative={moduleId:snapshot.moduleId,params:[...snapshot.params],start:0,end:source.length,moduleSource:source};
    const result=freeze(prepareExistingChatSelection(source,relative,fixedPresets,fixedEfforts,{copilotState}));
    if(bodies.size===16)bodies.delete(bodies.keys().next().value);
    bodies.set(key,result);return result;
  };
  const copies=findUniqueRspackModuleCopies(assets,{description:"current existing-chat selection settings owner",
    sourceMatch(source,name){if(source.includes(MARKER))markers.add(name);return sourceMatch(source)},
    matchModule(source,snapshot){if(!sourceMatch(source)||Buffer.byteLength(source)>256*1024)return false;try{prepare(source,snapshot);return true}catch{return false}},
  });
  const prepared=copies.map(copy=>{requireRegistry(copy.source);const result=prepare(copy.moduleSource,copy);
    if(copy.source.split(MARKER).length!==copy.moduleSource.split(MARKER).length)throw Error("Orphan existing-chat marker outside its owner");
    markers.delete(copy.assetName);return result;});
  if(markers.size)throw Error("Orphan existing-chat marker asset");
  if(new Set(prepared.map(row=>row.state)).size!==1)throw Error("Partially applied existing-chat cohorts");
  same(prepared.map(row=>row.proof.companion),prepared.map(()=>prepared[0].proof.companion),"settings sibling states");
  const dependencies=validateDependencies(assets,prepared.map(row=>row.proof));
  return{...patchRspackModuleCopies(assets,copies,(source,snapshot)=>prepare(source,snapshot).patchedSource,options),dependencies};
}
module.exports={MARKER,inspectExistingChatOwner,prepareExistingChatSelection,patchExistingChatSelections};
