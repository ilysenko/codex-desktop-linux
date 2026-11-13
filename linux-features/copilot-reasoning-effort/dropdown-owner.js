"use strict";
const path=require("node:path"),{Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,patchRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const ID="[A-Za-z_$][\\w$]*",MARKER="codexLinuxCopilotEffortDropdown",DESCRIPTION="current Copilot reasoning dropdown factory";
const MAX_FACTORY_BYTES=256*1024;
const NEEDLES=["reasoningEffortDisabled:","selectComposerModelAndReasoningEffort:","?.disabledReason!=null"];
const rx=text=>new RegExp(text,"gu"),q=escapeRegExp;
const count=source=>source.split(MARKER).length-1;
function reject(message){throw new Error(message);}
function one(values,label){if(values.length!==1)reject(`Missing or ambiguous dropdown ${label}`);return values[0];}
function frame(text,offset=0){return {text,offset,lexical:createJavaScriptLexicalIndex(text)};}
function matches(owner,pattern,root=true){return [...owner.text.matchAll(pattern)].filter(m=>owner.lexical.isCode(m.index)&&(!root||owner.lexical.isRoot(m.index)));}
function sole(owner,pattern,label,root=true){return one(matches(owner,pattern,root),label);}
function parsable(body,params="",suffix=""){try{new Script(`async function scope(${params}){${body}\n${suffix}}`);return true;}catch{return false;}}
const bindingProofs=new Map();
// Initial declaration/assignment sites are established by the native owner
// grammar first. Rename only those LHS binders in a private syntax projection;
// the publication checker's parameter authority then sees all remaining free
// writes, including escaped spellings and writes inside nested control blocks.
// Real lexical shadows, opaque text and member/property keys keep their scope.
function readonlyOwnedBinding(source,name,binders=[]){
 const key=JSON.stringify([source,name,binders]);let result=bindingProofs.get(key);
 if(result==null){
  let prefix="__copilotDropdownBinding";while(source.includes(prefix)||name.startsWith(prefix))prefix+="$";
  let projected=source;const sites=[...new Set(binders)].sort((a,b)=>b-a);
  for(const at of sites){if(projected.slice(at,at+name.length)!==name)reject("Unsupported dropdown binding initializer");projected=projected.slice(0,at)+prefix+"Initial"+projected.slice(at+name.length);}
  if(Buffer.byteLength(projected)>MAX_FACTORY_BYTES)reject("Dropdown binding projection exceeds inspection cap");
  const lexical=createJavaScriptLexicalIndex(projected);
  const tokens=/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  const spellings=[...projected.matchAll(tokens)].filter(token=>lexical.isCode(token.index)&&token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,(_,braced,fixed)=>String.fromCodePoint(parseInt(braced||fixed,16)))===name);
  const lexicalSource=projected;
  for(const token of spellings.reverse()){
   let after=token.index+token[0].length;while(after<lexicalSource.length&&!lexical.isCode(after))after++;
   let before=token.index-1;while(before>=0&&!lexical.isCode(before))before--;
   const spread=lexicalSource.slice(Math.max(0,token.index-3),token.index)==="...";
   const property=[".","#"].includes(lexicalSource[before])&&!spread;
   // Receiver access reads the binding even when the addressed property is
   // written. Projecting that read once avoids reparsing a dense memo function
   // for every cache slot; assignments/declarations/destructured targets stay.
   const receiver=!property&&([".","["].includes(lexicalSource[after])||lexicalSource.slice(after,after+2)==="?.");
   const value=receiver?"(0)":(spread?" ":"")+name;
   projected=projected.slice(0,token.index)+value+projected.slice(token.index+token[0].length);
  }
  // A single syntax probe can discharge a body containing only expression
  // reads: replacing every remaining reference by a parenthesized literal
  // cannot make a declaration, update, assignment or iteration target valid.
  // Potential targets and real local binders fall through to the shared
  // parameter projection, which distinguishes captured writes from shadows.
  const remainingLexical=createJavaScriptLexicalIndex(projected);
  const remaining=[...projected.matchAll(tokens)].filter(token=>remainingLexical.isCode(token.index)&&token[0]===name&&![".","#"].includes(projected[token.index-1])&&!/^\\s*:/u.test(projected.slice(token.index+token[0].length)));
  let expressionProbe=projected;
  for(const token of remaining.reverse())expressionProbe=expressionProbe.slice(0,token.index)+"(0)"+expressionProbe.slice(token.index+token[0].length);
  if(parsable(expressionProbe))result=true;
  const loader=prefix+"Require",value=prefix+"Value";
  const probe=`${loader}.d(${name},{},{proof:${value}});function ${value}(){}${projected}`;
  if(Buffer.byteLength(probe)>MAX_FACTORY_BYTES)reject("Dropdown binding proof exceeds inspection cap");
  if(result!==true){try{result=findRspackExportPublication({moduleSource:probe,params:[prefix+"Module",name,loader]},"proof")?.expression===value;}catch{result=false;}}
  if(bindingProofs.size===128)bindingProofs.delete(bindingProofs.keys().next().value);bindingProofs.set(key,result);
 }
 if(!result)reject(`Dropdown owned binding is unstable: ${name}`);
}
function dependencies(module,body,names,params=""){
 const out={};
 for(const name of new Set(names)){
  const binding=findRspackRequireBinding(module,name);if(binding==null)reject(`Dropdown dependency is not factory-owned: ${name}`);
  readonlyOwnedBinding(module.moduleSource,name,[binding.start-(module.start??0)]);
  if(!parsable(body.text,params,`let ${name};`))reject(`Dropdown dependency is shadowed at its uses: ${name}`);
  out[name]=binding;
 }
 return out;
}
function stable(body,name,expected,allowedDestructures=[],provenDeclarations=[]){
 const writes=matches(body,rx(`(?<![\\w$.])${q(name)}\\s*(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))`));
 if(writes.length!==expected)reject(`Dropdown native initializer count changed: ${name}`);
 const binders=[...provenDeclarations,...writes.map(match=>match.index)];
 // SWC declares its memoized temporaries in one initial uninitialized let
 // list. This declaration is distinct from the two proven memo branch writes.
 const bare=new RegExp(`^let (?<names>${ID}(?:,${ID})*),${ID}=`).exec(body.text);
 if(bare){const begin=bare.index+"let ".length;for(const match of bare.groups.names.matchAll(rx(`(?<![\\w$])${q(name)}(?![\\w$])`)))binders.push(begin+match.index);}
 for(const range of allowedDestructures){
  const text=body.text.slice(range.start,range.end);
  for(const match of text.matchAll(rx(`:${q(name)}(?=[,}])`)))binders.push(range.start+match.index+1);
 }
 readonlyOwnedBinding(body.text,name,binders);
}
function distinct(locals,captured=[]){if(new Set(locals).size!==locals.length||locals.some(name=>captured.includes(name)))reject("Dropdown native bindings alias or shadow captured roles");}
function publications(module,needles){
 if(module?.params?.length!==3||new Set(module.params).size!==3||module.params.some(p=>!new RegExp(`^${ID}$`,"u").test(p)))reject("Expected current dropdown factory snapshot");
 const source=module.moduleSource;
 if(typeof source!=="string"||Buffer.byteLength(source)>MAX_FACTORY_BYTES)reject("Dropdown factory exceeds bounded inspection cap");
 const owner=frame(source);
 if(!parsable(source,module.params.join(",")))reject("Dropdown factory does not parse");
 const keys=matches(owner,rx(`(?<key>${ID}):function\\(`),false).map(m=>m.groups.key),out=[];
 for(const key of new Set(keys)){
  const pub=findRspackExportPublication(module,key);if(pub?.fn==null||!needles.every(n=>pub.fn.body.includes(n)))continue;
  const fn=pub.fn,offset=fn.end-1-fn.body.length;out.push({publication:pub,fn,body:frame(fn.body,offset)});
 }
 return one(out,"published owner");
}
function memoProjection(body,cache,fields,result,inputs=fields.map(([,value])=>value)){
 let pattern="";for(let i=0;i<inputs.length;i++)pattern+=(i?"\\|\\|":"")+`${q(cache)}\\[(?<i${i}>\\d+)\\]!==${q(inputs[i])}`;
 pattern+=`\\?\\(${q(result)}=\\{${fields.map(([key,value])=>`${key}:${q(value)}`).join(",")}\\},`;
 for(let i=0;i<inputs.length;i++)pattern+=`${q(cache)}\\[\\k<i${i}>\\]=${q(inputs[i])},`;
 pattern+=`${q(cache)}\\[(?<out>\\d+)\\]=${q(result)}\\):${q(result)}=${q(cache)}\\[\\k<out>\\]`;
 const found=sole(body,rx(pattern),"memoized native context");if(new Set(Object.values(found.groups)).size!==inputs.length+1)reject("Dropdown memo slots alias");
 return found;
}
function memoFunction(body,cache,inputs,result,initializer){
 let pattern=inputs.map((value,i)=>`${q(cache)}\\[(?<i${i}>\\d+)\\]!==${q(value)}`).join("\\|\\|")+`\\?\\(${q(initializer)},`;
 for(let i=0;i<inputs.length;i++)pattern+=`${q(cache)}\\[\\k<i${i}>\\]=${q(inputs[i])},`;
 pattern+=`${q(cache)}\\[(?<out>\\d+)\\]=${q(result)}\\):${q(result)}=${q(cache)}\\[\\k<out>\\]`;
 const found=sole(body,rx(pattern),"native selector callback memo");if(new Set(Object.values(found.groups)).size!==inputs.length+1)reject("Selector callback memo slots alias");
}
function inspectComposer(module,patched){
 const selected=publications(module,["reasoningEffortDisabled:","selectComposerModelAndReasoningEffort:"]),{body,fn}=selected;
 if(!new RegExp(`^${ID}$`,"u").test(fn.params))reject("Unsupported dropdown component parameters");
 const props=sole(body,rx(`\\{serviceTierDefaults:${ID},conversationId:(?<conversation>${ID}),hasThreadResumeFailed:${ID},hideLabel:${ID},home:${ID},isCodexHome:${ID},permissionsCwdOverride:(?<cwd>${ID}),permissionsHostId:(?<permissionsHost>${ID})\\}=${q(fn.params)}`),"component conversation inputs");
 const g=props.groups;
 const memo=sole(body,rx(`(?<cache>${ID})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\(421\\)`),"compiler memo").groups;
 const context=sole(body,rx(`(?<context>${ID})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\(${q(g.conversation)}\\)`),"conversation context").groups;
 const host=sole(body,rx(`(?<host>${ID})=${q(context.context)}\\.hostId(?=[,;])`),"active host").groups.host;
 const identity=sole(body,rx(`(?<identity>${ID})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\(${q(host)}\\)`),"host identity").groups;
 const settings=sole(body,rx(`(?<selection>${ID})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\((?<options>${ID})\\),`+
  `\\{modelSettings:(?<settings>${ID}),selectComposerModelAndReasoningEffort:(?<select>${ID}),setDefaultModelAndReasoningEffort:(?<defaults>${ID}),setModelAndReasoningEffort:(?<current>${ID})\\}=\\k<selection>`),"native model selection").groups;
 memoProjection(body,memo.cache,[["conversationId",g.conversation],["cwdOverride",g.cwd],["hostId",g.permissionsHost]],settings.options);
 const agent=sole(body,rx(`(?<agent>${ID})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\((?<options>${ID})\\),(?<activeModel>${ID})=\\k<agent>\\?\\.selectedModelId\\?\\?${q(settings.settings)}\\.model`),"agent/current model context").groups;
 memoProjection(body,memo.cache,[["conversationId",g.conversation],["executionHostId",host],["modelSelection",settings.selection]],agent.options,[g.conversation,settings.selection,host]);
 const chosen=sole(body,rx(`(?<model>${ID})=${ID}\\?${ID}\\?\\.model\\?\\?${ID}:${q(agent.activeModel)}(?=[,;])`),"effective selected model").groups.model;
 const expression=`(?<options>${ID})\\?\\.find\\((?<parameter>${ID})=>\\{let\\{model:(?<found>${ID})\\}=\\k<parameter>;return \\k<found>\\.model===${q(chosen)}\\}\\)\\?\\.disabledReason!=null`;
 const gatePrefix=patched?`/\\*${MARKER}\\*/`:`${q(identity.identity)}\\?\\.authMethod==="copilot"\\|\\|`;
 const gate=sole(body,rx(`(?<combined>${ID})=${gatePrefix}(?<expression>${expression})`),"Copilot/model disabled gate");
 distinct([gate.groups.parameter,gate.groups.found],[chosen]);
 const menuOptions=sole(body,rx(`modelOptions:(?<options>${ID}),defaultOptionIndex:(?<index>${ID}),modelOptionsDisabled:`),"menu options role",false).groups;
 const options=sole(body,rx(`(?<options>${q(gate.groups.options)})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\((?<models>${ID}),`),"native model options").groups;
 // The native menu promotes its auto option to the first row and publishes
 // the corresponding default index. The disabled gate still reads the
 // original options array, so prove that complete projection into the menu.
 const defaultOption=sole(body,rx(`${q(memo.cache)}\\[(?<input>\\d+)\\]!==${q(options.options)}\\?`+
  `\\((?<found>${ID})=${q(options.options)}\\?\\.find\\((?<predicate>${ID})\\),${q(memo.cache)}\\[\\k<input>\\]=${q(options.options)},`+
  `${q(memo.cache)}\\[(?<out>\\d+)\\]=\\k<found>\\):\\k<found>=${q(memo.cache)}\\[\\k<out>\\];let (?<value>${ID})=\\k<found>;`),"native default option lookup").groups;
 if(defaultOption.input===defaultOption.out)reject("Default option memo slots alias");
 const factory=frame(module.moduleSource);
 const defaultPredicate=sole(factory,rx(`function ${q(defaultOption.predicate)}\\((?<parameter>${ID})\\)\\{let\\{model:(?<model>${ID})\\}=\\k<parameter>;return"auto"===\\k<model>\\.model\\}`),"native default option predicate");
 if(!parsable(body.text,fn.params,`let ${defaultOption.predicate};`))reject("Default option predicate is shadowed at its use");
 distinct([defaultPredicate.groups.parameter,defaultPredicate.groups.model],[defaultOption.predicate]);
 const reordered=sole(body,rx(`${q(memo.cache)}\\[(?<first>\\d+)\\]!==${q(defaultOption.value)}\\|\\|${q(memo.cache)}\\[(?<second>\\d+)\\]!==${q(options.options)}\\?`+
  `\\((?<value>${ID})=null!=${q(defaultOption.value)}&&null!=${q(options.options)}\\?\\[${q(defaultOption.value)},\\.\\.\\.${q(options.options)}\\.filter\\((?<parameter>${ID})=>\\k<parameter>!==${q(defaultOption.value)}\\)\\]:${q(options.options)},`+
  `${q(memo.cache)}\\[\\k<first>\\]=${q(defaultOption.value)},${q(memo.cache)}\\[\\k<second>\\]=${q(options.options)},${q(memo.cache)}\\[(?<out>\\d+)\\]=\\k<value>\\):\\k<value>=${q(memo.cache)}\\[\\k<out>\\];let ${q(menuOptions.options)}=\\k<value>(?=[,;])`),"native menu options projection").groups;
 if(new Set([reordered.first,reordered.second,reordered.out]).size!==3)reject("Menu option memo slots alias");
 distinct([reordered.parameter],[defaultOption.value,options.options]);
 sole(body,rx(`${q(menuOptions.index)}=\\+\\(null!=${q(defaultOption.value)}\\)`),"native default option index");
 const effortName=sole(body,rx(`reasoningEffort:(?<effort>${ID}),reasoningEffortDisabled:`),"menu effort role",false).groups.effort;
 const effective=sole(body,rx(`(?<effort>${q(effortName)})=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\(${q(settings.settings)}\\.reasoningEffort,(?<efforts>${ID})\\)(?=[,;])`),"effective effort").groups;
 const available=sole(body,rx(`(?<efforts>${q(effective.efforts)})=\\(0,(?<namespace>${q(effective.namespace)})\\.(?<key>${ID})\\)\\(${q(options.models)},${q(chosen)}\\)`),"model supported efforts").groups;
 const effort=effective.effort;
 const disabled=sole(body,rx(`(?<disabled>${ID})=(?<loading>${ID})\\|\\|${q(gate.groups.combined)}(?=[,;])`),"dropdown loading/model gate").groups;
 const loadingAlias=sole(body,rx(`let ${q(disabled.loading)}=(?<value>${ID}),`),"settings loading alias").groups.value;
 const loading=sole(body,rx(`${q(memo.cache)}\\[(?<a>\\d+)\\]!==${q(agent.agent)}\\?\\.isLoading\\|\\|${q(memo.cache)}\\[(?<b>\\d+)\\]!==(?<status>${ID})\\|\\|${q(memo.cache)}\\[(?<c>\\d+)\\]!==${q(settings.settings)}\\.isLoading\\|\\|${q(memo.cache)}\\[(?<d>\\d+)\\]!==(?<threadStatus>${ID})\\?`+
  `\\(${q(loadingAlias)}=${q(agent.agent)}\\?\\.isLoading===!0\\|\\|!\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\(\\k<status>\\)\\|\\|${q(settings.settings)}\\.isLoading\\|\\|"pending"===\\k<threadStatus>,`+
  `${q(memo.cache)}\\[\\k<a>\\]=${q(agent.agent)}\\?\\.isLoading,${q(memo.cache)}\\[\\k<b>\\]=\\k<status>,${q(memo.cache)}\\[\\k<c>\\]=${q(settings.settings)}\\.isLoading,${q(memo.cache)}\\[\\k<d>\\]=\\k<threadStatus>,`+
  `${q(memo.cache)}\\[(?<out>\\d+)\\]=${q(loadingAlias)}\\):${q(loadingAlias)}=${q(memo.cache)}\\[\\k<out>\\]`),"native loading state").groups;
 const catalog=sole(body,rx(`\\{data:(?<catalog>${ID}),status:${q(loading.status)},isEnabled:${ID},isFetching:${ID},refetch:${ID}\\}=\\(0,${q(loading.namespace)}\\.(?<key>${ID})\\)\\(${ID}\\)`),"catalog loading source").groups;
 const rootReturn=sole(body,/\breturn\b/gu,"returned menu");
 if(matches(body,/\bthrow\b/gu).length)reject("Dropdown component exits before its menu");
 const menu=sole(body,rx(`(?<result>${ID})=\\(0,(?<jsx>${ID})\\.(?<jsxKey>${ID})\\)\\(\\k<jsx>\\.Fragment,\\{children:\\(0,\\k<jsx>\\.\\k<jsxKey>\\)\\((?<menu>${ID})\\.(?<menuKey>${ID}),\\{align:"end",disabled:(?<globalDisabled>${ID}),headerShortcut:${ID},daybreak:${ID},contentRef:${ID},triggerRef:${ID},menuFooter:${ID},menuView:${ID},open:${ID},onOpenChange:${ID},onCloseAutoFocus:${ID},lockedModelSlug:${ID},model:${q(chosen)},fallbackModelLabel:${ID},selectedLabel:${ID},modelPickerTriggerConfig:${ID},isTeamCatalog:${ID},models:(?<models>${ID}),modelOptions:${q(menuOptions.options)},defaultOptionIndex:${q(menuOptions.index)},modelOptionsDisabled:(?<modelDisabled>${ID}),reasoningEffort:${q(effort)},reasoningEffortDisabled:${q(disabled.disabled)},reasoningEffortTooltip:${ID},selectedServiceTier:${ID},selectionMode:${ID},serviceTierOptions:${ID},serviceTierOptionsLoading:${ID},showReasoningEffortControls:!0,shouldReduceMotion:${ID},onSelectComplete:${ID},onBeforeSelectModel:${ID},onCommitPower:${ID},onSelectModel:(?<onSelect>${ID}),onSelectDefault:${ID},onSelectModelOption:${ID},powerSelections:${ID},onSelectServiceTier:${ID},onToggleMenuView:${ID},triggerButton:${ID}\\}\\)\\}\\)`),"actual menu props",false).groups;
 const menuMatch=matches(body,rx(`${q(menu.result)}=\\(0,${q(menu.jsx)}\\.${q(menu.jsxKey)}\\)\\(${q(menu.jsx)}\\.Fragment`));
 if(menuMatch.length!==1||menuMatch[0].index<rootReturn.index||!new RegExp(`:${q(menu.result)}=${q(memo.cache)}\\[\\d+\\],${q(menu.result)}$`,"u").test(body.text))reject("Dropdown menu does not reach component result");
 sole(body,rx(`${q(menu.modelDisabled)}=${q(disabled.loading)}\\|\\|"error"===${q(loading.status)}\\|\\|${q(agent.agent)}\\?\\.isModelLocked===!0`),"native model loading/locked gate");
 sole(body,rx(`${q(menu.models)}=${q(options.models)}(?=[,;])`),"returned model list");
 const callback=sole(body,rx(`${q(menu.onSelect)}=\\((?<model>${ID}),(?<effort>${ID})\\)=>\\{(?<selector>${ID})\\(\\k<model>,\\k<effort>\\)\\}`),"actual menu callback").groups;
 const callbackMemo=sole(body,rx(`${q(memo.cache)}\\[(?<input>\\d+)\\]!==${q(callback.selector)}\\?\\(${q(menu.onSelect)}=\\(${q(callback.model)},${q(callback.effort)}\\)=>\\{${q(callback.selector)}\\(${q(callback.model)},${q(callback.effort)}\\)\\},${q(memo.cache)}\\[\\k<input>\\]=${q(callback.selector)},${q(memo.cache)}\\[(?<output>\\d+)\\]=${q(menu.onSelect)}\\):${q(menu.onSelect)}=${q(memo.cache)}\\[\\k<output>\\]`),"native menu callback memo").groups;
 if(callbackMemo.input===callbackMemo.output)reject("Dropdown callback memo slots alias");
 const selectMatch=sole(body,rx(`function ${q(callback.selector)}\\((?<model>${ID}),(?<effort>${ID}),(?<options>${ID})\\)\\{if\\("auto"===\\k<model>&&!0!==(?<store>${ID})\\.get\\((?<permission>${ID})\\.(?<permissionKey>${ID}),${q(g.conversation)}\\)\\)return Promise\\.resolve\\(!1\\);`+
  `let (?<commit>${ID})=\\(\\)=>\\{\\k<model>!==${q(chosen)}\\?\\(0,(?<events>${ID})\\.(?<eventKey>${ID})\\)\\(\\k<store>,(?<eventTypes>${ID})\\.CodexComposerModelChanged,\\{model:\\k<model>\\}\\):null!=\\k<effort>&&\\k<effort>!==${q(effort)}&&\\(0,\\k<events>\\.\\k<eventKey>\\)\\(\\k<store>,\\k<eventTypes>\\.CodexComposerReasoningEffortChanged,\\{reasoningEffort:\\k<effort>\\}\\)\\};`+
  `return ${q(agent.agent)}\\?\\.isAeon\\?${q(agent.agent)}\\.selectModelAndReasoningEffort\\((?<transform>${ID})\\(\\k<model>\\),\\k<effort>,\\k<commit>\\):${q(settings.select)}\\(\\k<transform>\\(\\k<model>\\),\\k<effort>,\\k<commit>,\\k<options>\\)\\}`),"native selection route");
 const select=selectMatch.groups;
 distinct([callback.model,callback.effort],[callback.selector]);
 distinct([select.model,select.effort,select.options,select.commit],[chosen,effort,agent.agent,settings.select,select.store,select.permission,select.events,select.eventTypes,select.transform]);
 const transformMatch=sole(body,rx(`function ${q(select.transform)}\\((?<model>${ID})\\)\\{return (?<flag>${ID})&&\\k<model>===${q(chosen)}\\?(?<namespace>${ID})\\.${ID}:\\k<model>\\}`),"native model slug adapter");
 const transform=transformMatch.groups;
 distinct([transform.model],[chosen,transform.flag,transform.namespace]);
 const store=sole(body,rx(`${q(select.store)}=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\((?<scope>${ID})\\.${ID}\\)`),"native component store").groups;
 const imports=dependencies(module,body,[memo.namespace,context.namespace,identity.namespace,settings.namespace,agent.namespace,options.namespace,available.namespace,loading.namespace,menu.jsx,menu.menu,select.permission,select.events,select.eventTypes,transform.namespace,store.namespace,store.scope],fn.params);
 const locals=[g.conversation,g.cwd,g.permissionsHost,memo.cache,context.context,host,identity.identity,settings.options,settings.selection,settings.settings,settings.select,settings.defaults,settings.current,agent.options,agent.agent,agent.activeModel,chosen,options.options,options.models,defaultOption.found,defaultOption.value,reordered.value,menuOptions.options,menuOptions.index,available.efforts,effort,gate.groups.combined,disabled.disabled,disabled.loading,callback.selector,menu.onSelect,select.store,menu.models,menu.modelDisabled,transform.flag];
 distinct(locals,Object.keys(imports));
 const allowed=[props,sole(body,rx(`\\{modelSettings:${q(settings.settings)},selectComposerModelAndReasoningEffort:${q(settings.select)},setDefaultModelAndReasoningEffort:${q(settings.defaults)},setModelAndReasoningEffort:${q(settings.current)}\\}=${q(settings.selection)}`),"selection result")].map(m=>({start:m.index,end:m.index+m[0].length}));
 for(const [name,n]of [[memo.cache,1],[context.context,1],[host,1],[identity.identity,1],[settings.options,2],[settings.selection,1],[settings.settings,0],[settings.select,0],[agent.options,2],[agent.agent,1],[agent.activeModel,1],[chosen,1],[options.options,1],[available.efforts,1],[effort,1],[gate.groups.combined,1],[disabled.disabled,1],[disabled.loading,1],[menu.onSelect,2],[select.store,1],[menu.models,1],[menu.modelDisabled,1],[transform.flag,1]])stable(body,name,n,allowed);
 for(const [name,n]of [[defaultOption.found,2],[defaultOption.value,1],[reordered.value,2],[menuOptions.options,1],[menuOptions.index,1]])stable(body,name,n,allowed);
 stable(factory,defaultOption.predicate,0,[],[defaultPredicate.index+"function ".length]);
 stable(body,callback.selector,0,allowed,[selectMatch.index+"function ".length]);
 stable(body,select.transform,0,allowed,[transformMatch.index+"function ".length]);
 const start=body.offset+gate.index,end=start+gate[0].length;
 const native=`${gate.groups.combined}=${identity.identity}?.authMethod==="copilot"||${gate.groups.expression}`;
 const replacement=`${gate.groups.combined}=/*${MARKER}*/${gate.groups.expression}`;
 if(count(module.moduleSource)!==(patched?1:0))reject("Orphan dropdown marker");
 return {publication:selected.publication,gate:{start,end,native,replacement},selectorImport:imports[settings.namespace],selectorExport:settings.key,bindings:{host,conversation:g.conversation,selectedModel:chosen,reasoningEffort:effort,disabled:disabled.disabled,settings:settings.settings,select:settings.select,loading:disabled.loading,modelOptions:options.options},nativeRoute:{menuHandler:menu.onSelect,callback:callback.selector,callbackRange:{start:body.offset+selectMatch.index,end:body.offset+selectMatch.index+selectMatch[0].length},bindings:{...select,chosen,effort,agent:agent.agent,settingsSelect:settings.select,conversation:g.conversation}},imports};
}
function inspectDropdownState(source,snapshot){
 if(typeof source!=="string"||(!source.includes(MARKER)&&!NEEDLES.every(needle=>source.includes(needle))))return {kind:"missing"};
 try{
  const module={...snapshot,moduleSource:source};
  if(count(source)===0)return {kind:"current",owner:inspectComposer(module,false)};
  const owner=inspectComposer(module,true),native=source.slice(0,owner.gate.start)+owner.gate.native+source.slice(owner.gate.end),original=inspectComposer({...module,moduleSource:native},false);
  if(native.slice(0,original.gate.start)+original.gate.replacement+native.slice(original.gate.end)===source)return {kind:"patched",owner,native};
 }catch(error){return {kind:"missing",reason:error.message};}
 return {kind:"missing"};
}
function applyDropdownModule(source,snapshot){
 const state=dropdownModuleState(source,snapshot);if(state.kind==="patched")return source;
 if(state.kind!=="current")reject(`Missing, ambiguous or partial ${DESCRIPTION}`);
 const {gate}=state.owner,patched=source.slice(0,gate.start)+gate.replacement+source.slice(gate.end);
 if(dropdownModuleState(patched,snapshot).kind!=="patched")reject("Dropdown patch failed canonical replay");return patched;
}

// The upstream composer selector preserves guardian/full-access confirmation
// and delegates both ordinary and next-turn writes to the native settings hook.
// This inspector proves that complete callback and its returned memoized alias;
// it neither changes those policies nor owns the persistence implementation.
function inspectSelector(module){
 const selected=publications(module,["selectComposerModelAndReasoningEffort:","setModelAndReasoningEffortForNextTurn:"]),{body,fn}=selected;
 const props=sole(body,rx(`\\{conversationId:(?<conversation>${ID}),cwdOverride:(?<cwd>${ID}),hostId:(?<host>${ID})\\}=${q(fn.params)}`),"selector context");
 const p=props.groups;
 const memo=sole(body,rx(`(?<cache>${ID})=\\(0,(?<namespace>${ID})\\.${ID}\\)\\(26\\)`),"selector memo").groups;
 const settingsMatch=sole(body,rx(`\\{modelSettings:(?<settings>${ID}),setDefaultModelAndReasoningEffort:(?<defaults>${ID}),setModelAndReasoningEffort:(?<current>${ID}),setModelAndReasoningEffortForNextTurn:(?<next>${ID})\\}=\\(0,(?<namespace>${ID})\\.(?<key>${ID})\\)\\(${q(p.conversation)}\\)`),"selector settings hook");
 const s=settingsMatch.groups;
 const permissionMatch=sole(body,rx(`\\{agentMode:(?<mode>${ID}),getNonFullAccessFallbackMode:(?<fallback>${ID}),guardianApprovalThreadSettings:(?<guardianSettings>${ID}),isAutoReviewRequiredForModel:(?<review>${ID}),isGuardianModeAvailable:(?<guardian>${ID}),permissionProfileId:(?<profile>${ID}),setAgentMode:(?<setMode>${ID})\\}=\\(0,(?<namespace>${ID})\\.${ID}\\)\\((?<options>${ID})\\)`),"selector permission hook");
 const permission=permissionMatch.groups;
 memoProjection(body,memo.cache,[["conversationId",p.conversation],["cwdOverride",p.cwd],["hostId",p.host]],permission.options);
 const full=sole(body,rx(`${q(memo.cache)}\\[(?<a>\\d+)\\]!==${q(permission.mode)}\\|\\|${q(memo.cache)}\\[(?<b>\\d+)\\]!==${q(permission.profile)}\\?`+
  `\\((?<value>${ID})="full-access"===${q(permission.mode)}&&\\(null==${q(permission.profile)}\\|\\|${q(permission.profile)}\\.startsWith\\(":"\\)\\),${q(memo.cache)}\\[\\k<a>\\]=${q(permission.mode)},${q(memo.cache)}\\[\\k<b>\\]=${q(permission.profile)},${q(memo.cache)}\\[(?<out>\\d+)\\]=\\k<value>\\):\\k<value>=${q(memo.cache)}\\[\\k<out>\\];let (?<alias>${ID})=\\k<value>;`),"selector access state").groups;
 const alias=sole(body,rx(`let (?<alias>${ID})=(?<callback>${ID});return `),"returned selector alias").groups;
 const result=sole(body,rx(`(?<result>${ID})=\\{modelSettings:${q(s.settings)},setDefaultModelAndReasoningEffort:${q(s.defaults)},setModelAndReasoningEffort:${q(s.current)},selectComposerModelAndReasoningEffort:${q(alias.alias)}\\}`),"returned selector settings",false).groups.result;
 memoProjection(body,memo.cache,[["modelSettings",s.settings],["setDefaultModelAndReasoningEffort",s.defaults],["setModelAndReasoningEffort",s.current],["selectComposerModelAndReasoningEffort",alias.alias]],result,[s.settings,alias.alias,s.defaults,s.current]);
 if(!new RegExp(`:${q(result)}=${q(memo.cache)}\\[\\d+\\],${q(result)}$`,"u").test(body.text)||matches(body,/\breturn\b/gu).length!==1)reject("Selector result is disconnected");
 const callbackMatch=sole(body,rx(`${q(alias.callback)}=function\\((?<model>${ID}),(?<effort>${ID}),(?<commitInput>${ID}),(?<options>${ID})\\)\\{`+
  `let (?<commit>${ID})=\\(\\)=>\\{\\k<model>!==${q(s.settings)}\\.model&&\\(0,(?<notify>${ID})\\.${ID}\\)\\((?<store>${ID}),\\k<model>\\),\\k<commitInput>\\(\\)\\};`+
  `if\\(\\k<model>!==${q(s.settings)}\\.model&&${q(permission.review)}\\(\\k<model>\\)\\)\\{if\\(\\k<commit>\\(\\),null!=${q(p.conversation)}\\)\\{`+
  `let (?<guardian>${ID})=\\(0,(?<protocol>${ID})\\.${ID}\\)\\("guardian-approvals"\\);return ${q(s.next)}\\(\\k<model>,\\k<effort>,\\{threadSettings:\\{\\.\\.\\.(?<capabilities>${ID})\\?\\{approvalPolicy:\\k<guardian>\\.approvalPolicy,approvalsReviewer:\\k<guardian>\\.approvalsReviewer,permissions:\\k<guardian>\\.permissionProfileId\\}:${q(permission.guardianSettings)},`+
  `\\.\\.\\.\\k<options>\\?\\.serviceTier===void 0\\?\\{\\}:\\{serviceTier:\\k<options>\\.serviceTier\\}\\}\\}\\)\\.then\\((?<success>${ID}),(?<failure>${ID})\\)\\}return ${q(s.current)}\\(\\k<model>,\\k<effort>,\\k<options>\\)\\}`+
  `if\\(\\k<model>!==${q(s.settings)}\\.model&&\\(0,(?<catalog>${ID})\\.${ID}\\)\\(\\k<model>\\)&&${q(permission.guardian)}&&"guardian-approvals"!==${q(permission.mode)}\\)return \\k<commit>\\(\\),${q(permission.setMode)}\\("guardian-approvals"\\),${q(s.current)}\\(\\k<model>,\\k<effort>,\\k<options>\\);`+
  `if\\(!${q(full.alias)}\\|\\|"ultra"!==\\k<effort>\\|\\|"ultra"===${q(s.settings)}\\.reasoningEffort\\)return \\k<commit>\\(\\),${q(s.current)}\\(\\k<model>,\\k<effort>,\\k<options>\\);`+
  `let (?<fallback>${ID})=${q(permission.fallback)}\\(\\);return new Promise\\(\\((?<resolve>${ID}),(?<reject>${ID})\\)=>\\{let (?<settled>${ID})=!1,(?<proceed>${ID})=\\(\\)=>\\{\\k<settled>=!0,\\k<commit>\\(\\),${q(s.current)}\\(\\k<model>,\\k<effort>,\\k<options>\\)\\.then\\(\\k<resolve>,\\k<reject>\\)\\};`+
  `\\(0,(?<prompt>${ID})\\.${ID}\\)\\(\\k<store>,(?<modal>${ID})\\.${ID},\\{canContinue:null!=\\k<fallback>,onClose:\\(\\)=>\\{\\k<settled>\\|\\|\\k<resolve>\\(!1\\)\\},onContinueWithFullAccess:\\k<proceed>,onContinueWithFallback:\\(\\)=>\\{null!=\\k<fallback>&&\\(${q(permission.setMode)}\\(\\k<fallback>\\),\\k<proceed>\\(\\)\\)\\}\\}\\)\\}\\)\\}`),"complete native selector callback");
 const callback=callbackMatch.groups;
 memoFunction(body,memo.cache,[permission.mode,p.conversation,permission.fallback,permission.guardianSettings,permission.review,full.alias,permission.guardian,s.settings,callback.capabilities,callback.store,permission.setMode,s.current,s.next],alias.callback,callbackMatch[0]);
 const store=sole(body,rx(`${q(callback.store)}=\\(0,(?<namespace>${ID})\\.${ID}\\)\\((?<scope>${ID})\\.${ID}\\)`),"selector native store").groups;
 const capabilities=sole(body,rx(`${q(callback.capabilities)}=\\(0,${q(store.namespace)}\\.${ID}\\)\\((?<namespace>${ID})\\.${ID},${q(p.host)}\\)`),"selector host capabilities").groups;
 const root=frame(module.moduleSource);
 const failureDef=sole(root,rx(`function ${q(callback.failure)}\\(\\)\\{return!1\\}`),"selector failure result");const successDef=sole(root,rx(`function ${q(callback.success)}\\(\\)\\{return!0\\}`),"selector success result");
 distinct([callback.model,callback.effort,callback.commitInput,callback.options,callback.commit,callback.fallback],[s.settings,s.current,s.next,p.conversation,permission.review,permission.guardian,permission.mode,permission.setMode,permission.guardianSettings,permission.fallback,full.alias,callback.notify,callback.store,callback.protocol,callback.capabilities,callback.success,callback.failure,callback.catalog,callback.prompt,callback.modal]);
 distinct([callback.guardian],[callback.model,callback.effort,callback.options,s.next,permission.guardianSettings,callback.capabilities,callback.success,callback.failure,callback.protocol]);
 distinct([callback.resolve,callback.reject,callback.settled,callback.proceed],[callback.commit,s.current,callback.model,callback.effort,callback.options,callback.store,callback.fallback,permission.setMode,callback.prompt,callback.modal]);
 const imports=dependencies(module,body,[memo.namespace,s.namespace,permission.namespace,callback.notify,callback.protocol,callback.catalog,callback.prompt,callback.modal,store.namespace,store.scope,capabilities.namespace],fn.params);
 distinct([p.conversation,p.cwd,p.host,s.settings,s.defaults,s.current,s.next,permission.options,permission.mode,permission.fallback,permission.guardianSettings,permission.review,permission.guardian,permission.profile,permission.setMode,full.value,full.alias,alias.alias,alias.callback,result,callback.store,callback.capabilities,memo.cache],Object.keys(imports));
 const allowed=[props,settingsMatch,permissionMatch].map(m=>({start:m.index,end:m.index+m[0].length}));
 for(const [name,n]of [[s.settings,0],[s.defaults,0],[s.current,0],[s.next,0],[permission.options,2],[alias.alias,1],[alias.callback,2],[callback.store,1],[callback.capabilities,1],[memo.cache,1],[permission.mode,0],[permission.fallback,0],[permission.guardianSettings,0],[permission.review,0],[permission.guardian,0],[permission.profile,0],[permission.setMode,0],[full.alias,1]])stable(body,name,n,allowed);
 stable(body,full.value,2,allowed);
 stable(root,callback.success,0,[],[successDef.index+"function ".length]);stable(root,callback.failure,0,[],[failureDef.index+"function ".length]);
 return {publication:selected.publication,settingsImport:imports[s.namespace],settingsExport:s.key,bindings:{settings:s.settings,current:s.current,defaults:s.defaults,next:s.next,conversation:p.conversation},imports};
}
function inspectSelectorState(source,snapshot){if(typeof source!=="string"||!["selectComposerModelAndReasoningEffort:","setModelAndReasoningEffortForNextTurn:"].every(needle=>source.includes(needle)))return {ok:false,reason:"Missing composer selector semantic inputs"};try{return {ok:true,owner:inspectSelector({...snapshot,moduleSource:source})};}catch(error){return {ok:false,reason:error.message};}}
const dropdownStates=new Map(),selectorStates=new Map();
function cachedState(cache,source,snapshot,inspect){
 if(typeof source!=="string"||Buffer.byteLength(source)>MAX_FACTORY_BYTES)return inspect(source,snapshot);
 const key=JSON.stringify([source,snapshot?.params,snapshot?.start??0]);if(cache.has(key))return cache.get(key);
 const result=inspect(source,snapshot);if(cache.size===32)cache.delete(cache.keys().next().value);cache.set(key,result);return result;
}
function dropdownModuleState(source,snapshot){return cachedState(dropdownStates,source,snapshot,inspectDropdownState);}
function selectorModuleState(source,snapshot){return cachedState(selectorStates,source,snapshot,inspectSelectorState);}
function requireRegistry(source){
 const headers=[...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];if(headers.length!==1)reject(`Missing or ambiguous ${DESCRIPTION} registry`);
 const [header]=headers;if(!createJavaScriptLexicalIndex(source.slice(0,header.index+header[0].length)).isRoot(header.index))reject(`Opaque or nested ${DESCRIPTION} registry`);
}
function patchCopilotDropdown(extractedDir,settingsState,options={}){
 if(typeof settingsState!=="function")throw new TypeError("Dropdown requires the feature's settings persistence inspector");
 const assetsDir=path.join(extractedDir,"webview","assets"),markerAssets=new Set();
 const copies=findUniqueRspackModuleCopies(assetsDir,{
  description:DESCRIPTION,
  sourceMatch(source,name){if(source.includes(MARKER))markerAssets.add(name);return source.includes(MARKER)||NEEDLES.every(needle=>source.includes(needle));},
  matchModule:(source,module)=>dropdownModuleState(source,module).kind!=="missing",
 });
 const selectors=findUniqueRspackModuleCopies(assetsDir,{
  description:"current composer model selection hook",
  sourceMatch:source=>source.includes("selectComposerModelAndReasoningEffort:")&&source.includes("setModelAndReasoningEffortForNextTurn:"),
  matchModule:(source,module)=>selectorModuleState(source,module).ok,
 });
 const selectorOwners=selectors.map(copy=>{requireRegistry(copy.source);const state=selectorModuleState(copy.moduleSource,copy);if(!state.ok)reject("Damaged composer selector copy");return state.owner;});
 const settings=findUniqueRspackModuleCopies(assetsDir,{
  description:"current Copilot native model settings dependency",
  sourceMatch:source=>source.includes("setDefaultModelAndReasoningEffort:")&&source.includes(".setDefaultModelConfig("),
  matchModule:(source,module)=>["current","patched"].includes(settingsState(source,module).kind),
 });
 const states=settings.map(copy=>{requireRegistry(copy.source);return settingsState(copy.moduleSource,copy);});
 if(states.some(state=>!["current","patched"].includes(state.kind))||new Set(states.map(state=>state.kind)).size!==1)reject("Damaged or mixed dropdown settings dependency");
 for(const owner of selectorOwners){
  if(owner.settingsImport.moduleId!==settings[0].moduleId||states.some(state=>state.owner?.publication?.exportName!==owner.settingsExport))reject("Composer selector does not bind the actual native settings publication");
 }
 for(const copy of copies){
  requireRegistry(copy.source);const state=dropdownModuleState(copy.moduleSource,copy);if(state.kind==="missing")reject("Damaged dropdown physical copy");
  if(count(copy.source)!==count(copy.moduleSource))reject("Orphan dropdown marker");markerAssets.delete(copy.assetName);
  if(state.owner.selectorImport.moduleId!==selectors[0].moduleId||selectorOwners.some(owner=>owner.publication.exportName!==state.owner.selectorExport))reject("Dropdown does not bind the actual composer selection publication");
 }
 if(markerAssets.size)reject(`Orphan dropdown marker in ${[...markerAssets].join(", ")}`);
 return patchRspackModuleCopies(assetsDir,copies,applyDropdownModule,options);
}
module.exports={MARKER,NEEDLES,MAX_FACTORY_BYTES,dropdownModuleState,applyDropdownModule,selectorModuleState,patchCopilotDropdown};
