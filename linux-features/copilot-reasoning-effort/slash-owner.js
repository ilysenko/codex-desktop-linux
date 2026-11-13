"use strict";
const path=require("node:path"),{Script}=require("node:vm");
const {escapeRegExp,createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,patchRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {selectorModuleState}=require("./dropdown-owner.js");
const authority=require("./slash-binding-authority.js");
const {assertUnambiguousModelComposerLexicalSource:guardLexical}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const ID="[A-Za-z_$][\\w$]*",MARKER="codexLinuxCopilotReasoningSlash",DESCRIPTION="current Copilot reasoning slash factory";
const NEEDLES=['id:"composer.reasoningSlashCommand.title"',"selectComposerModelAndReasoningEffort:","requiresEmptyComposer"];
const q=escapeRegExp,C=name=>`(?<${name}>${ID})`,R=name=>`\\k<${name}>`,rx=text=>new RegExp(text,"dgu");
function fail(message){throw new Error(message);}
function one(values,description){if(values.length!==1)fail(`Missing or ambiguous slash ${description}`);return values[0];}
function frame(text,offset=0){return {text,offset,lexical:createJavaScriptLexicalIndex(text)};}
function matches(owner,pattern,root=true){return [...owner.text.matchAll(pattern)].filter(m=>owner.lexical.isCode(m.index)&&(!root||owner.lexical.isRoot(m.index)));}
function sole(owner,pattern,description,root=true){return one(matches(owner,pattern,root),description);}
function markerCount(source){return source.split(MARKER).length-1;}
function functions(prepared){return [...prepared.source.matchAll(rx(`\\bfunction ${C("name")}\\((?<params>${ID})\\)\\{`))].filter(m=>prepared.lexical.isRoot(m.index)).map(m=>{const open=m.index+m[0].length-1,end=prepared.pairs.get(open);if(end==null)fail("Incomplete slash root function");return {name:m.groups.name,params:m.groups.params,start:m.index,end:end+1,bodyStart:open+1,bodyEnd:end,body:frame(prepared.source.slice(open+1,end),open+1)};});}
function commandPattern(name,patched){
 const gate=patched?`${R("required")}&&${R("ready")}/\\*${MARKER}\\*/`:`${R("required")}&&${R("ready")}&&!${R("copilot")}`;
 return rx(`^function ${q(name)}\\(${C("argument")}\\)\\{let ${C("hostOptions")},${C("readyTmp")},${C("selectionOptions")},${C("efforts")},${C("effort")},${C("section")},${C("items")},${C("submenuTmp")},${C("title")},${C("description")},${C("icons")},${C("dependencies")},${C("command")},${C("cache")}=\\(0,${C("memoApi")}\\.${C("memoKey")}\\)\\(43\\),`+
  `\\{conversationId:${C("conversation")},permissionsCwdOverride:${C("cwd")},permissionsHostId:${C("hostOverride")}\\}=${R("argument")},${C("store")}=\\(0,${C("stateApi")}\\.${C("storeKey")}\\)\\(${C("storeApi")}\\.${C("storeExport")}\\),${C("intl")}=\\(0,${C("intlApi")}\\.${C("intlKey")}\\)\\(\\),${C("context")}=\\(0,${C("contextApi")}\\.${C("contextKey")}\\)\\(${R("conversation")}\\),${C("host")}=\\(0,${C("hostApi")}\\.${C("hostKey")}\\)\\(${R("context")}\\.hostId\\),${C("required")}=${R("host")}\\?\\.requiresAuth\\?\\?!0;`+
  `${R("cache")}\\[0\\]!==${R("context")}\\.hostId\\?\\(${R("hostOptions")}=\\{hostId:${R("context")}\\.hostId\\},${R("cache")}\\[0\\]=${R("context")}\\.hostId,${R("cache")}\\[1\\]=${R("hostOptions")}\\):${R("hostOptions")}=${R("cache")}\\[1\\];let\\{data:${C("catalog")},status:${C("status")}\\}=\\(0,${C("catalogApi")}\\.${C("catalogKey")}\\)\\(${R("hostOptions")}\\);`+
  `${R("cache")}\\[2\\]!==${R("status")}\\?\\(${R("readyTmp")}=\\(0,${R("catalogApi")}\\.${C("readyKey")}\\)\\(${R("status")}\\),${R("cache")}\\[2\\]=${R("status")},${R("cache")}\\[3\\]=${R("readyTmp")}\\):${R("readyTmp")}=${R("cache")}\\[3\\];let ${C("ready")}=${R("readyTmp")},${C("copilot")}=${R("host")}\\?\\.authMethod==="copilot";`+
  `${R("cache")}\\[4\\]!==${R("conversation")}\\|\\|${R("cache")}\\[5\\]!==${R("cwd")}\\|\\|${R("cache")}\\[6\\]!==${R("hostOverride")}\\?\\(${R("selectionOptions")}=\\{conversationId:${R("conversation")},cwdOverride:${R("cwd")},hostId:${R("hostOverride")}\\},${R("cache")}\\[4\\]=${R("conversation")},${R("cache")}\\[5\\]=${R("cwd")},${R("cache")}\\[6\\]=${R("hostOverride")},${R("cache")}\\[7\\]=${R("selectionOptions")}\\):${R("selectionOptions")}=${R("cache")}\\[7\\];`+
  `let\\{modelSettings:${C("settings")},selectComposerModelAndReasoningEffort:${C("select")}\\}=\\(0,${C("selectorApi")}\\.${C("selectorKey")}\\)\\(${R("selectionOptions")}\\);`+
  `${R("cache")}\\[8\\]!==${R("intl")}\\|\\|${R("cache")}\\[9\\]!==${R("catalog")}\\?\\.models\\|\\|${R("cache")}\\[10\\]!==${R("settings")}\\.model\\|\\|${R("cache")}\\[11\\]!==${R("settings")}\\.reasoningEffort\\|\\|${R("cache")}\\[12\\]!==${R("store")}\\|\\|${R("cache")}\\[13\\]!==${R("select")}\\?`+
  `\\(${R("efforts")}=\\(0,${C("effortApi")}\\.${C("effortsKey")}\\)\\(${R("catalog")}\\?\\.models,${R("settings")}\\.model\\),${R("effort")}=\\(0,${R("effortApi")}\\.${C("clampKey")}\\)\\(${R("settings")}\\.reasoningEffort,${R("efforts")}\\),${R("section")}="reasoning-efforts",${R("items")}=${R("efforts")}\\.map\\(${C("item")}=>\\{let\\{reasoningEffort:${C("itemEffort")}\\}=${R("item")},${C("itemTitle")}=${R("intl")}\\.formatMessage\\(${C("labelsApi")}\\.${C("labelsKey")}\\[${R("itemEffort")}\\]\\);`+
  `return\\{id:${R("itemEffort")},title:${R("itemTitle")},Icon:\\{16:${C("iconsApi")}\\.${C("icon16")},20:${R("iconsApi")}\\.${C("icon20")}\\},RightIcon:${R("itemEffort")}===${R("effort")}\\?\\{16:${R("iconsApi")}\\.${C("right16")},20:${R("iconsApi")}\\.${C("right20")}\\}:void 0,onSelect:\\(\\)=>\\{${R("select")}\\(${R("settings")}\\.model,${R("itemEffort")},\\(\\)=>\\{\\(0,${C("eventApi")}\\.${C("eventKey")}\\)\\(${R("store")},${C("eventTypes")}\\.CodexComposerReasoningEffortChanged,\\{reasoningEffort:${R("itemEffort")}\\}\\)\\}\\)\\}\\}\\}\\),`+
  `${R("cache")}\\[8\\]=${R("intl")},${R("cache")}\\[9\\]=${R("catalog")}\\?\\.models,${R("cache")}\\[10\\]=${R("settings")}\\.model,${R("cache")}\\[11\\]=${R("settings")}\\.reasoningEffort,${R("cache")}\\[12\\]=${R("store")},${R("cache")}\\[13\\]=${R("select")},${R("cache")}\\[14\\]=${R("efforts")},${R("cache")}\\[15\\]=${R("effort")},${R("cache")}\\[16\\]=${R("section")},${R("cache")}\\[17\\]=${R("items")}\\):`+
  `\\(${R("efforts")}=${R("cache")}\\[14\\],${R("effort")}=${R("cache")}\\[15\\],${R("section")}=${R("cache")}\\[16\\],${R("items")}=${R("cache")}\\[17\\]\\),`+
  `${R("cache")}\\[18\\]!==${R("section")}\\|\\|${R("cache")}\\[19\\]!==${R("items")}\\?\\(${R("submenuTmp")}=\\{sections:\\[\\{id:${R("section")},items:${R("items")}\\}\\]\\},${R("cache")}\\[18\\]=${R("section")},${R("cache")}\\[19\\]=${R("items")},${R("cache")}\\[20\\]=${R("submenuTmp")}\\):${R("submenuTmp")}=${R("cache")}\\[20\\];let ${C("submenu")}=${R("submenuTmp")};`+
  `${R("cache")}\\[21\\]!==${R("intl")}\\?\\(${R("title")}=${R("intl")}\\.formatMessage\\(\\{id:"composer.reasoningSlashCommand.title",defaultMessage:"Reasoning",description:"Title for the reasoning slash command"\\}\\),${R("cache")}\\[21\\]=${R("intl")},${R("cache")}\\[22\\]=${R("title")}\\):${R("title")}=${R("cache")}\\[22\\],`+
  `${R("cache")}\\[23\\]!==${R("intl")}\\|\\|${R("cache")}\\[24\\]!==${R("effort")}\\?\\(${R("description")}=${R("intl")}\\.formatMessage\\(${R("labelsApi")}\\.${R("labelsKey")}\\[${R("effort")}\\]\\),${R("cache")}\\[23\\]=${R("intl")},${R("cache")}\\[24\\]=${R("effort")},${R("cache")}\\[25\\]=${R("description")}\\):${R("description")}=${R("cache")}\\[25\\],`+
  `${R("cache")}\\[26\\]===Symbol\\.for\\("react.memo_cache_sentinel"\\)\\?\\(${R("icons")}=\\{16:${R("iconsApi")}\\.${R("icon16")},20:${R("iconsApi")}\\.${R("icon20")}\\},${R("cache")}\\[26\\]=${R("icons")}\\):${R("icons")}=${R("cache")}\\[26\\];let ${C("enabled")}=${gate};return `+
  `${R("cache")}\\[27\\]!==${R("efforts")}\\|\\|${R("cache")}\\[28\\]!==${R("conversation")}\\|\\|${R("cache")}\\[29\\]!==${R("ready")}\\|\\|${R("cache")}\\[30\\]!==${R("required")}\\|\\|${R("cache")}\\[31\\]!==${R("copilot")}\\|\\|${R("cache")}\\[32\\]!==${R("settings")}\\|\\|${R("cache")}\\[33\\]!==${R("store")}\\|\\|${R("cache")}\\[34\\]!==${R("select")}\\|\\|${R("cache")}\\[35\\]!==${R("effort")}\\?`+
  `\\(${R("dependencies")}=\\[${R("store")},${R("efforts")},${R("required")},${R("conversation")},${R("ready")},${R("copilot")},${R("settings")},${R("effort")},${R("select")}\\],${R("cache")}\\[27\\]=${R("efforts")},${R("cache")}\\[28\\]=${R("conversation")},${R("cache")}\\[29\\]=${R("ready")},${R("cache")}\\[30\\]=${R("required")},${R("cache")}\\[31\\]=${R("copilot")},${R("cache")}\\[32\\]=${R("settings")},${R("cache")}\\[33\\]=${R("store")},${R("cache")}\\[34\\]=${R("select")},${R("cache")}\\[35\\]=${R("effort")},${R("cache")}\\[36\\]=${R("dependencies")}\\):${R("dependencies")}=${R("cache")}\\[36\\],`+
  `${R("cache")}\\[37\\]!==${R("submenu")}\\|\\|${R("cache")}\\[38\\]!==${R("enabled")}\\|\\|${R("cache")}\\[39\\]!==${R("dependencies")}\\|\\|${R("cache")}\\[40\\]!==${R("title")}\\|\\|${R("cache")}\\[41\\]!==${R("description")}\\?\\(${R("command")}=\\{id:"reasoning",title:${R("title")},description:${R("description")},requiresEmptyComposer:!1,Icon:${R("icons")},submenu:${R("submenu")},enabled:${R("enabled")},dependencies:${R("dependencies")}\\},`+
  `${R("cache")}\\[37\\]=${R("submenu")},${R("cache")}\\[38\\]=${R("enabled")},${R("cache")}\\[39\\]=${R("dependencies")},${R("cache")}\\[40\\]=${R("title")},${R("cache")}\\[41\\]=${R("description")},${R("cache")}\\[42\\]=${R("command")}\\):${R("command")}=${R("cache")}\\[42\\],\\(0,${C("registryApi")}\\.${C("registryKey")}\\)\\(${R("command")}\\),null\\}$`);
}
function inspectCommand(prepared,fn,patched){
 const text=prepared.source.slice(fn.start,fn.end),match=commandPattern(fn.name,patched).exec(text);if(!match)return null;const g=match.groups;
 const imported=[g.memoApi,g.stateApi,g.storeApi,g.intlApi,g.contextApi,g.hostApi,g.catalogApi,g.selectorApi,g.effortApi,g.labelsApi,g.iconsApi,g.eventApi,g.eventTypes,g.registryApi];
 const callback=[g.item,g.itemEffort,g.itemTitle],captured=[g.intl,g.labelsApi,g.iconsApi,g.effort,g.select,g.settings,g.store,g.eventApi,g.eventTypes];if(new Set(callback).size!==3||callback.some(name=>captured.includes(name)))return null;
 const callbackKeys=new Set(["item","itemEffort","itemTitle"]),importKeys=new Set(["memoApi","stateApi","storeApi","intlApi","contextApi","hostApi","catalogApi","selectorApi","threadApi","configApi","effortApi","labelsApi","iconsApi","eventApi","eventTypes","registryApi"]);
 const locals=Object.entries(g).filter(([key])=>!key.endsWith("Key")&&!key.endsWith("Export")&&!callbackKeys.has(key)&&!importKeys.has(key)&&!["icon16","icon20","right16","right20"].includes(key)).map(([,value])=>value);
 if(new Set(locals).size!==locals.length||locals.some(name=>imported.includes(name)))return null;
 const native=`let ${g.enabled}=${g.required}&&${g.ready}&&!${g.copilot};`,applied=`let ${g.enabled}=${g.required}&&${g.ready}/*${MARKER}*/;`,gate=patched?applied:native,index=text.indexOf(gate);if(index<0||text.indexOf(gate,index+1)>=0)return null;
 return {fn,groups:g,imports:[...new Set(imported)],gate:{start:fn.start+index,end:fn.start+index+gate.length,native,applied},patched};
}
module.exports={commandPattern,inspectCommand};
function memoHeader(fn){
 const match=/^let (?<bare>[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*),(?<cache>[A-Za-z_$][\w$]*)=\(0,(?<api>[A-Za-z_$][\w$]*)\.(?<key>[A-Za-z_$][\w$]*)\)\((?<size>\d+)\)/u.exec(fn.body.text);if(!match)fail("Unsupported slash carrier memo header");
 const bindings=new Map();for(const token of match.groups.bare.matchAll(rx(ID))){if(bindings.has(token[0]))fail("Duplicate slash carrier temporary");bindings.set(token[0],"let ".length+token.index);}
 return {...match.groups,match,bindings,cacheAt:match[0].lastIndexOf(match.groups.cache+"="),apiAt:match[0].lastIndexOf("(0,"+match.groups.api+".")+3};
}
function topItems(prepared,open,end){const result=[];let start=open+1;for(let at=start;at<end;at++){if(!prepared.lexical.isCode(at))continue;const c=prepared.source[at];if("([{".includes(c)){const close=prepared.pairs.get(at);if(close==null||close>end)fail("Incomplete slash native member");at=close;}else if(c===","){result.push(prepared.source.slice(start,at).trim());start=at+1;}}result.push(prepared.source.slice(start,end).trim());return result.filter(Boolean);}
function properties(prepared,open,end){const result=new Map();for(const item of topItems(prepared,open,end)){const match=new RegExp(`^(?<key>${ID}):(?<value>[\\s\\S]+)$`,"u").exec(item);if(!match||result.has(match.groups.key))fail("Unsupported slash carrier properties");result.set(match.groups.key,match.groups.value);}return result;}
function rootReturnChild(prepared,fn,out,jsx){
 const found=[];
 for(const match of matches(fn.body,rx(`\\(0,${q(jsx)}\\.${ID}\\)\\(${q(jsx)}\\.Fragment,\\{children:\\[`))){
  const arrayOpen=fn.body.offset+match.index+match[0].length-1,arrayEnd=prepared.pairs.get(arrayOpen),callOpen=fn.body.offset+match.index+match[0].lastIndexOf("("),callEnd=prepared.pairs.get(callOpen);if(arrayEnd==null||callEnd==null)continue;
  const items=topItems(prepared,arrayOpen,arrayEnd);if(items.filter(item=>item===out).length!==1)continue;const returns=matches(fn.body,/\breturn\b/gu),lastReturn=returns.at(-1);if(!lastReturn||lastReturn.index>match.index)continue;try{new Script(`function finalReturnProbe(){return (${fn.body.text.slice(lastReturn.index+"return".length)});}`);}catch{continue;}
  let finalMemo=null;
  if(callEnd+1!==fn.bodyEnd){
   const binding=new RegExp(`(?<result>${ID})=$`,"u").exec(fn.body.text.slice(0,match.index));if(!binding)continue;const header=memoHeader(fn),result=binding.groups.result,assignmentStart=match.index-binding[0].length,assignment=prepared.source.slice(fn.body.offset+assignmentStart,callEnd+1);
   try{const memo=memoConsumer(fn,header,assignmentStart,assignment,result);if(memo.end!==fn.body.text.length-result.length-1||fn.body.text.slice(memo.end)!==","+result)continue;const declaration=header.bindings.get(result);if(declaration==null)continue;finalMemo={result,sites:[declaration,...memo.initializers]};}catch{continue;}
  }
  found.push({arrayOpen,arrayEnd,returnAt:fn.body.offset+lastReturn.index,fragmentAt:fn.body.offset+match.index,fragmentPrefixEnd:fn.body.offset+match.index+match[0].length,finalMemo});
 }
 return one(found,"returned direct command child");
}
function memoConsumer(fn,header,assignmentAt,assignment,out){
 const val=`${ID}(?:(?:\\?\\.|\\.)${ID})*`,cache=q(header.cache),prefix=fn.body.text.slice(0,assignmentAt);
 const pattern=rx(`(?<predicate>${cache}\\[\\d+\\]!==${val}(?:\\|\\|${cache}\\[\\d+\\]!==${val})*)\\?\\($`),head=one([...prefix.matchAll(pattern)].filter(m=>fn.body.lexical.isRoot(m.index)),"carrier memo predicate");
 const previous=prefix.slice(0,head.index).trimEnd().at(-1);if(previous!=null&&![",",";","}"].includes(previous))fail("Slash carrier memo is not native root code");
 const tail=new RegExp(`^,(?<writes>(?:${cache}\\[\\d+\\]=${val},)+)${cache}\\[(?<out>\\d+)\\]=${q(out)}\\):${q(out)}=${cache}\\[\\k<out>\\]`,"du").exec(fn.body.text.slice(assignmentAt+assignment.length));if(!tail)fail("Slash carrier memo output is disconnected");
 const inputs=[...head.groups.predicate.matchAll(new RegExp(`${cache}\\[(?<slot>\\d+)\\]!==(?<value>${val})`,"gu"))].map(m=>m.groups),writes=[...tail.groups.writes.matchAll(new RegExp(`${cache}\\[(?<slot>\\d+)\\]=(?<value>${val}),`,"gu"))].map(m=>m.groups);
 if(JSON.stringify(inputs)!==JSON.stringify(writes)||new Set(inputs.map(row=>row.slot)).size!==inputs.length||inputs.some(row=>row.slot===tail.groups.out))fail("Slash carrier memo loses its native input bindings");
 const fallbackOffset=assignmentAt+assignment.length+tail[0].lastIndexOf(":"+out+"=")+1;
 return {start:head.index,end:assignmentAt+assignment.length+tail[0].length,initializers:[assignmentAt,fallbackOffset],inputs};
}
function renderCarrier(prepared,fn,callee,kind){
 const header=memoHeader(fn),expression=kind==="scope"?`${C("out")}="cloud"===${C("mode")}\\|\\|${C("query")}\\?null:\\(0,${C("jsx")}\\.${C("jsxKey")}\\)\\((?<callee>${q(callee)}),\\{`:`${C("out")}=${C("surface")}\\?\\(0,${C("jsx")}\\.${C("jsxKey")}\\)\\((?<callee>${q(callee)}),\\{`;
 const candidates=[],refusals=[];
 for(const match of matches(fn.body,rx(expression))){
  const open=fn.body.offset+match.index+match[0].length-1,end=prepared.pairs.get(open),callOpen=fn.body.offset+match.index+match[0].lastIndexOf("("),callEnd=prepared.pairs.get(callOpen);if(end==null||callEnd==null)continue;let assignmentEnd=callEnd+1;if(kind!=="scope"){if(!prepared.source.startsWith(":null",assignmentEnd))continue;assignmentEnd+=5;}
  const assignment=prepared.source.slice(fn.body.offset+match.index,assignmentEnd);let memo;try{memo=memoConsumer(fn,header,match.index,assignment,match.groups.out);rootReturnChild(prepared,fn,match.groups.out,match.groups.jsx);}catch(error){refusals.push(error.message);continue;}
  const outDecl=header.bindings.get(match.groups.out);if(outDecl==null)continue;
  candidates.push({fn,header,match,groups:match.groups,props:properties(prepared,open,end),memo,outDecl,calleeAt:fn.body.offset+match.indices.groups.callee[0],assignmentAt:fn.body.offset+match.index,assignmentEnd,returned:rootReturnChild(prepared,fn,match.groups.out,match.groups.jsx)});
 }
 return one(candidates,(kind==="scope"?"scope command carrier":"published command carrier")+(refusals.length?": "+refusals.join("; "):""));
}
function proveLocal(fn,roles){
 const prepared=authority.prepare(fn.body.text,[fn.params]),results=[];
 for(const [name,sites]of roles){const result=authority.prove(prepared,name,[...new Set(sites)]);if(!result.stable)fail(`Slash carrier binding is replaced: ${name}`);results.push(result.summary);}return results;
}
function carrierInput(fn,header){
 const start=header.match[0].length,match=new RegExp(`^,\\{(?<fields>[^{}]+)\\}=${q(fn.params)},`,"du").exec(fn.body.text.slice(start));if(!match)fail("Missing native command carrier inputs");const fields=new Map();
 for(const field of match.groups.fields.split(",")){const value=new RegExp(`^(?<key>${ID}):(?<binding>${ID})$`,"u").exec(field);if(!value||fields.has(value.groups.key))fail("Unsupported command carrier input");const at=start+match[0].indexOf(field)+value[0].lastIndexOf(value.groups.binding);fields.set(value.groups.key,{name:value.groups.binding,at});}return fields;
}
function inspectScopeCarrier(prepared,carrier,command){
 const {fn,header,groups,props}=carrier,g=command.groups,input=carrierInput(fn,header);
 for(const key of ["composerMode","permissionsCwdOverride","permissionsHostId","isAeonThread"])if(!input.has(key))fail("Missing native scoped command input");
 if(groups.mode!==input.get("composerMode").name||props.size!==3||!["conversationId","permissionsCwdOverride","permissionsHostId"].every(key=>props.has(key))||props.get("permissionsCwdOverride")!==input.get("permissionsCwdOverride").name||props.get("permissionsHostId")!==input.get("permissionsHostId").name)fail("Slash carrier context is disconnected");
 const conversation=props.get("conversationId");if(!new RegExp(`^${ID}$`,"u").test(conversation))fail("Unsupported scoped conversation selection");
 const alias=sole(fn.body,rx(`let ${q(conversation)}=${C("tmp")},`),"scope conversation alias");
 const selected=sole(fn.body,rx(`(?<tmp>${q(alias.groups.tmp)})=\\(0,${C("scopeApi")}\\.${ID}\\)\\(${C("store")}\\)`),"scope-derived conversation");
 const scopeStore=sole(fn.body,rx(`(?<store>${q(selected.groups.store)})=\\(0,(?<state>${q(g.stateApi)})\\.${ID}\\)\\((?<scopeApi>${q(selected.groups.scopeApi)})\\.${ID}\\)`),"composer scope store");
 const selectMemo=memoConsumer(fn,header,selected.index,selected[0],selected.groups.tmp);
 const aeonName=input.get("isAeonThread").name,aeon=sole(fn.body,rx(`${C("aeon")}=void 0!==${q(aeonName)}&&${q(aeonName)}(?=[,;])`),"native Aeon input");
 const query=sole(fn.body,rx(`let ${q(groups.query)}=\\(0,${q(g.stateApi)}\\.${C("queryKey")}\\)\\(${q(aeon.groups.aeon)}\\?null:${C("atom")},${C("options")}\\)(?=[,;])`),"native scope query");
 const options=sole(fn.body,rx(`${q(query.groups.options)}=null==${q(conversation)}\\?null:\\{hostId:${C("executor")},threadId:${q(conversation)}\\}`),"native scope-query context");
 const executor=sole(fn.body,rx(`(?<executor>${q(options.groups.executor)})=\\(0,${q(g.stateApi)}\\.${ID}\\)\\(${C("threadApi")}\\.${ID},${q(conversation)}\\)`),"native thread executor");
 const optionsMemo=memoConsumer(fn,header,options.index,options[0],query.groups.options);
 const atom=sole(frame(prepared.source),rx(`\\blet ${q(query.groups.atom)}=\\(0,${q(g.stateApi)}\\.${ID}\\)\\(${q(g.storeApi)}\\.${q(g.storeExport)},`),"native scope-query atom");
 let atomBefore=atom.index-1;while(atomBefore>=0&&!prepared.lexical.isCode(atomBefore))atomBefore--;if(atomBefore>=0&&![";","}"].includes(prepared.source[atomBefore]))fail("Scope query atom is not a native factory declaration");
 const tmpDecl=header.bindings.get(selected.groups.tmp),optDecl=header.bindings.get(query.groups.options);if(tmpDecl==null||optDecl==null)fail("Native scope-query memo declaration is missing");
 const local=[[header.cache,[header.cacheAt]],[groups.out,[carrier.outDecl,...carrier.memo.initializers]],[input.get("composerMode").name,[input.get("composerMode").at]],[input.get("permissionsCwdOverride").name,[input.get("permissionsCwdOverride").at]],[input.get("permissionsHostId").name,[input.get("permissionsHostId").at]],[aeonName,[input.get("isAeonThread").at]],[aeon.groups.aeon,[aeon.index]],[scopeStore.groups.store,[scopeStore.index]],[selected.groups.tmp,[tmpDecl,...selectMemo.initializers]],[conversation,[alias.index+"let ".length]],[executor.groups.executor,[executor.index]],[query.groups.options,[optDecl,...optionsMemo.initializers]],[groups.query,[query.index+"let ".length]]];
 return {input,conversation,scopeApi:scopeStore.groups.scopeApi,threadApi:executor.groups.threadApi,atom:query.groups.atom,atomInitializer:atom.index+"let ".length,atomUse:fn.body.offset+query.indices.groups.atom[0],localProofs:proveLocal(fn,[...local,...(carrier.returned.finalMemo?[[carrier.returned.finalMemo.result,carrier.returned.finalMemo.sites]]:[])]),nativeCondition:`"cloud"===${groups.mode}||${groups.query}`,scopeOrigin:{store:scopeStore.groups.store,conversation,selection:selected[0]},query:query[0],semanticRanges:[scopeStore,selected,query,executor].map(match=>[fn.body.offset+match.index,fn.body.offset+match.index+match[0].length]).concat([[atom.index,atom.index+atom[0].length]])};
}
const states=new Map();
function inspectFactory(source,params){
 const prepared=authority.prepare(source,params,{maxSourceBytes:authority.MAX_SLASH_FACTORY}),root=frame(source),rootFns=functions(prepared);
 const publication=new RegExp(`^${q(params[2])}\\.d\\(${q(params[1])},\\{ComposerContent:\\(\\)=>(?<function>${ID})\\}\\);`,"du").exec(source);if(!publication||!root.lexical.isRoot(0))fail("Missing actual root ComposerContent getter");
 if(matches(root,rx(`(?<![\\w$.])${q(params[2])}\\.d\\(${q(params[1])},\\{`)).length!==1)fail("Ambiguous slash factory publication");
 const published=one(rootFns.filter(fn=>fn.name===publication.groups.function),"published ComposerContent binding");
 const commands=[];for(const fn of rootFns){if(!['id:"composer.reasoningSlashCommand.title"','id:"reasoning"'].every(needle=>fn.body.text.includes(needle)))continue;for(const patched of [false,true]){const command=inspectCommand(prepared,fn,patched);if(command)commands.push(command);}}
 const command=one(commands,"complete reasoning command function");
 const scopeCarriers=[];for(const fn of rootFns){if(fn===command.fn||!fn.body.text.includes(command.fn.name))continue;try{scopeCarriers.push(renderCarrier(prepared,fn,command.fn.name,"scope"));}catch{}}
 const scopeCarrier=one(scopeCarriers,"scope command consumer"),scope=inspectScopeCarrier(prepared,scopeCarrier,command),publishedCarrier=renderCarrier(prepared,published,scopeCarrier.fn.name,"publication");
 const expectedKeys=[...scope.input.keys()].sort();if(JSON.stringify([...publishedCarrier.props.keys()].sort())!==JSON.stringify(expectedKeys)||publishedCarrier.props.has("conversationId"))fail("Published carrier no longer forwards the native scope inputs");
 proveLocal(published,[[publishedCarrier.header.cache,[publishedCarrier.header.cacheAt]],[publishedCarrier.groups.out,[publishedCarrier.outDecl,...publishedCarrier.memo.initializers]],...(publishedCarrier.returned.finalMemo?[[publishedCarrier.returned.finalMemo.result,publishedCarrier.returned.finalMemo.sites]]:[])]);
 const module={moduleSource:source,params,start:0},imports=new Map();
 for(const name of [...new Set([...command.imports,scope.scopeApi,scope.threadApi,scopeCarrier.groups.jsx,publishedCarrier.groups.jsx,scopeCarrier.header.api,publishedCarrier.header.api])]){
  const binding=findRspackRequireBinding(module,name);if(!binding||!prepared.lexical.isRoot(binding.start))fail(`Slash dependency is not a factory import: ${name}`);imports.set(name,binding);
 }
 const definitions=new Map([[params[2],[]],[params[1],[]]]);for(const fn of [published,scopeCarrier.fn,command.fn])definitions.set(fn.name,[fn.start+"function ".length]);for(const [name,binding]of imports)definitions.set(name,[binding.start]);definitions.set(scope.atom,[scope.atomInitializer]);
 const commandImports=new Set(command.imports);
 const semanticRanges=[[0,publication[0].length],...scope.semanticRanges];
 for(const carrier of [scopeCarrier,publishedCarrier])semanticRanges.push([carrier.fn.body.offset+carrier.header.apiAt,carrier.fn.body.offset+carrier.header.apiAt+carrier.header.api.length],[carrier.assignmentAt,carrier.assignmentEnd],[carrier.returned.fragmentAt,carrier.returned.fragmentPrefixEnd]);
 const requiredImportRefs=new Map([...imports.keys()].map(name=>[name,new Set()]));
 function previous(at){while(at>=0&&!prepared.lexical.isCode(at))at--;return at;}function next(at){while(at<source.length&&!prepared.lexical.isCode(at))at++;return at;}
 for(const token of prepared.tokens){if(!requiredImportRefs.has(token.name))continue;
  const commandUse=commandImports.has(token.name)&&command.fn.start<=token.start&&token.end<=command.fn.end;
  if(!commandUse&&!semanticRanges.some(([start,end])=>start<=token.start&&token.end<=end))continue;const before=previous(token.start-1),after=next(token.end);if([".","#"].includes(source[before])||source[after]===":")continue;if([".","["].includes(source[after])||source.slice(after,after+2)==="?." )requiredImportRefs.get(token.name).add(token.start);}
 requiredImportRefs.set(scope.atom,new Set([scope.atomUse]));
 requiredImportRefs.set(params[2],new Set([0]));requiredImportRefs.set(params[1],new Set([publication[0].indexOf("("+params[1]+",")+1]));
 const summaries=[],functionMaps=new Map(),importReferences={};
 for(const [name,sites]of definitions){const required=[...(requiredImportRefs.get(name)??[])],result=authority.prove(prepared,name,sites,{resolveOffsets:required});if(!result.stable)fail(`Slash factory binding is unstable: ${name}`);for(const at of required)if(!result.unowned.some(row=>row.start===at))fail(`Slash API use resolves to a local or unrelated binding: ${name}`);if(required.length)importReferences[name]=required;summaries.push(result.summary);if([published.name,scopeCarrier.fn.name,command.fn.name].includes(name))functionMaps.set(name,{global:result.unowned.map(row=>row.start),local:result.owned.filter(row=>row.reason!=="proven-native-initializer").map(row=>row.start)});}
 function requireRootReference(name,at){if(!functionMaps.get(name)?.global.includes(at))fail(`Slash consumer resolves to a local or unrelated binding: ${name}`);}
 requireRootReference(published.name,publication.indices.groups.function[0]);requireRootReference(scopeCarrier.fn.name,publishedCarrier.calleeAt);requireRootReference(command.fn.name,scopeCarrier.calleeAt);
 if(markerCount(source)!==(command.patched?1:0))fail("Orphan or noncanonical slash marker");
 return {command,published:{name:published.name,reference:publication.indices.groups.function[0]},scope:{name:scopeCarrier.fn.name,reference:publishedCarrier.calleeAt,commandReference:scopeCarrier.calleeAt,condition:scope.nativeCondition,conversation:scope.conversation,origin:scope.scopeOrigin},selectorImport:imports.get(command.groups.selectorApi),selectorExport:command.groups.selectorKey,proof:summaries,importReferences,functionReferences:Object.fromEntries(functionMaps)};
}
function slashModuleState(source,snapshot){
 if(typeof source!=="string"||!Array.isArray(snapshot?.params)||snapshot.params.length!==3||new Set(snapshot.params).size!==3||snapshot.params.some(name=>!new RegExp(`^${ID}$`,"u").test(name)))return {kind:"missing",reason:"Expected current slash factory snapshot"};
 if(!source.includes(MARKER)&&!NEEDLES.every(needle=>source.includes(needle)))return {kind:"missing"};if(Buffer.byteLength(source)>authority.MAX_SLASH_FACTORY)return {kind:"missing",reason:"Slash owner exceeds explicit1MiB cap"};
 const key=JSON.stringify([source,snapshot.params]);if(states.has(key))return states.get(key);let state;
 try{const owner=inspectFactory(source,snapshot.params);if(!owner.command.patched)state={kind:"current",owner};else{
   const gate=owner.command.gate,native=source.slice(0,gate.start)+gate.native+source.slice(gate.end),original=states.get(JSON.stringify([native,snapshot.params]))?.kind==="current"?states.get(JSON.stringify([native,snapshot.params])).owner:inspectFactory(native,snapshot.params);if(original.command.patched||native.slice(0,original.command.gate.start)+original.command.gate.applied+native.slice(original.command.gate.end)!==source)fail("Slash contribution failed exact inverse");state={kind:"patched",owner,native};
  }}catch(error){state={kind:"missing",reason:error.message};}
 if(states.size===4)states.delete(states.keys().next().value);states.set(key,state);return state;
}
function applySlashModule(source,snapshot){const state=slashModuleState(source,snapshot);if(state.kind==="patched")return source;if(state.kind!=="current")fail(`Unsupported ${DESCRIPTION}: ${state.reason}`);const gate=state.owner.command.gate,patched=source.slice(0,gate.start)+gate.applied+source.slice(gate.end);if(slashModuleState(patched,snapshot).kind!=="patched")fail("Slash patch did not produce a canonical factory");return patched;}
function requireRegistry(source){const headers=[...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];if(headers.length!==1)fail("Missing or ambiguous slash registry");const [head]=headers;if(!createJavaScriptLexicalIndex(source.slice(0,head.index+head[0].length)).isRoot(head.index))fail("Opaque slash registry");}
function patchCopilotSlash(extractedDir,settingsState,options={}){
 if(typeof settingsState!=="function")throw new TypeError("Slash patch requires the feature settings inspector");const assets=path.join(extractedDir,"webview","assets"),markerAssets=new Set();
 const copies=findUniqueRspackModuleCopies(assets,{description:DESCRIPTION,sourceMatch(source,name){if(source.includes(MARKER))markerAssets.add(name);return source.includes(MARKER)||NEEDLES.every(needle=>source.includes(needle));},matchModule:(source,module)=>slashModuleState(source,module).kind!=="missing"});
 const selectors=findUniqueRspackModuleCopies(assets,{description:"native composer selector for reasoning command",sourceMatch:source=>source.includes("selectComposerModelAndReasoningEffort:")&&source.includes("setModelAndReasoningEffortForNextTurn:"),matchModule:(source,module)=>{if(!source.includes("selectComposerModelAndReasoningEffort:"))return false;guardLexical(source,createJavaScriptLexicalIndex(source));return selectorModuleState(source,module).ok;}});
 const selectorOwners=selectors.map(copy=>{requireRegistry(copy.source);const state=selectorModuleState(copy.moduleSource,copy);if(!state.ok)fail("Damaged reasoning command selector");return state.owner;});
 const settings=findUniqueRspackModuleCopies(assets,{description:"native settings for reasoning command",sourceMatch:source=>source.includes("setDefaultModelAndReasoningEffort:")&&source.includes(".setDefaultModelConfig("),matchModule:(source,module)=>{if(!source.includes("setDefaultModelAndReasoningEffort:"))return false;guardLexical(source,createJavaScriptLexicalIndex(source));return ["current","patched"].includes(settingsState(source,module).kind);}}),settingStates=settings.map(copy=>{requireRegistry(copy.source);return settingsState(copy.moduleSource,copy);});
 if(settingStates.some(state=>!["current","patched"].includes(state.kind))||new Set(settingStates.map(state=>state.kind)).size!==1)fail("Damaged or mixed reasoning command settings");
 for(const owner of selectorOwners)if(owner.settingsImport.moduleId!==settings[0].moduleId||settingStates.some(state=>state.owner?.publication?.exportName!==owner.settingsExport))fail("Reasoning command selector has a different native settings publication");
 for(const copy of copies){requireRegistry(copy.source);const state=slashModuleState(copy.moduleSource,copy);if(state.kind==="missing")fail("Damaged reasoning command physical copy");if(markerCount(copy.source)!==markerCount(copy.moduleSource))fail("Orphan reasoning command marker");markerAssets.delete(copy.assetName);if(state.owner.selectorImport.moduleId!==selectors[0].moduleId||selectorOwners.some(owner=>owner.publication.exportName!==state.owner.selectorExport))fail("Reasoning command does not bind native composer selector");}
 if(markerAssets.size)fail(`Orphan reasoning command marker in ${[...markerAssets].join(", ")}`);return patchRspackModuleCopies(assets,copies,applySlashModule,options);
}
module.exports={MARKER,NEEDLES,slashModuleState,applySlashModule,patchCopilotSlash};
