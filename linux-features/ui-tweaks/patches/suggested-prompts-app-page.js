"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { Script } = require("node:vm");
const {
  findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding,
} = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { findMatchingBrace, escapeRegExp } = require("../../../scripts/patches/lib/minified-js.js");
const { findRspackExportPublication } = require("../../../scripts/patches/lib/rspack-export-publication.js");
const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxUiTweaksSuggestedPromptsAppPageEligible";
const ROLLOUT = "codexLinuxUiTweaksSuggestedPromptsEnabled";
function own(body, offset) { const prefix = body.slice(0, offset); return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1; }
function code(body, offset) { const prefix = "{" + body.slice(0, offset); return findMatchingBrace(prefix + "}".repeat(prefix.length + 1), 0) >= prefix.length; }
function one(items) { return items.length === 1 ? items[0] : null; }
function matches(body, pattern, root = true) { return [...body.matchAll(pattern)].filter(m => code(body,m.index) && (!root || own(body,m.index))); }
function statementAt(body,index) {
  if(!own(body,index))return false;
  try { new Script(`function probe(){${body.slice(0,index)}const __codexHomeStatement=0;}`);return true; }
  catch{return false;}
}
function writes(body, name) {
  const pattern = new RegExp(`(?<![\\w$.])(?:${escapeRegExp(name)}\\s*(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))|(?:\\+\\+|--)${escapeRegExp(name)}\\b)`,"gu");
  return matches(body,pattern).map(m=>m.index);
}
function functions(body, name) {
  return matches(body,new RegExp(`\\bfunction (${name==null?ID:escapeRegExp(name)})\\(([^)]*)\\)\\{`,"gu")).filter(head=>statementAt(body,head.index)).map(head=>{
    const open=head.index+head[0].length-1,end=findMatchingBrace(body,open);
    return {name:head[1],params:head[2],start:head.index,end:end+1,body:body.slice(open+1,end)};
  }).filter(fn=>fn.end>fn.start);
}
// Every current page link has one final factory-level return. A second return
// before the semantic anchors turns them into a textual, unreachable decoy.
function liveFunction(fn) { return matches(fn.body,/\breturn\b/gu).length===1 && matches(fn.body,/\bthrow\b/gu).length===0; }
function homeObjects(body) {
  const found=[];
  for(const marker of body.matchAll(/generatedSuggestionsEnabled:/gu)) {
    if(!code(body,marker.index))continue;
    const start=body.lastIndexOf("{",marker.index),end=findMatchingBrace(body,start);
    if(start<0||end<0)continue;
    const text=body.slice(start,end+1);
    const keys=["isCodexHome","generatedSuggestionsEnabled","hostId","onLocalConversationCreated","plan","projectRoot","routeEntryKey","topLevelLayout"];
    if(!keys.every(key=>text.includes(key+":")))continue;
    const jsx=new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID})\\.(${ID}),$`,"u").exec(body.slice(0,start));
    if(!jsx)continue;
    if(!new RegExp(`^\\{isCodexHome:${ID},generatedSuggestionsEnabled:${ID},hostId:${ID},onLocalConversationCreated:${ID},plan:${ID},projectRoot:${ID},routeEntryKey:${ID}\\.key,topLevelLayout:${ID}\\?"list":void 0\\}$`,"u").test(text))continue;
    const fields={};
    for(const key of keys) {
      const value=new RegExp(`${key}:(${ID})`,"u").exec(text);if(!value)break;fields[key]=value[1];
    }
    if(Object.keys(fields).length===keys.length)found.push({start,end:end+1,text,fields,view:jsx[2],viewExport:jsx[3]});
  }
  return found;
}
function exportGetter(module, key) {
  return findRspackExportPublication(module, key);
}
// The current entry either returns its page directly (the compact fixture),
// or memoizes the ordinary/work choice and returns a scope provider containing
// that choice. A JSX node created in an unused local proves neither path.
function returnedHomeEntry(entry, link) {
  const body=entry.body,returned=one(matches(body,/\breturn\b/gu));
  if(!returned||link.index<returned.index+6)return false;
  if(body.slice(returned.index+6).trim().replace(/;$/u,"")===link[0])return true;
  const wrapper=one(matches(body,new RegExp(
    `(?<memo>${ID})\\[(?<contextSlot>\\d+)\\]!==(?<context>${ID})\\|\\|\\k<memo>\\[(?<childSlot>\\d+)\\]!==(?<child>${ID})\\?`+
    `\\((?<value>${ID})=\\(0,${ID}\\.jsxs\\)\\(${ID}\\.${ID},\\{scope:${ID}\\.${ID},value:\\k<context>,children:\\[(?<children>${ID}(?:,${ID})*)\\]\\}\\),`+
    `\\k<memo>\\[\\k<contextSlot>\\]=\\k<context>,\\k<memo>\\[\\k<childSlot>\\]=\\k<child>,\\k<memo>\\[(?<valueSlot>\\d+)\\]=\\k<value>\\):`+
    `\\k<value>=\\k<memo>\\[\\k<valueSlot>\\],\\k<value>;?$`,"gu")));
  if(!wrapper||wrapper.index<=link.index)return false;
  const {memo,child,children,contextSlot,childSlot,valueSlot}=wrapper.groups;
  if(children.split(",").filter(name=>name===child).length!==1||new Set([contextSlot,childSlot,valueSlot]).size!==3)return false;
  const cache=escapeRegExp(memo),selected=escapeRegExp(child),afterLink=link.index+link[0].length;
  const stored=new RegExp(
    `^((?:,${cache}\\[\\d+\\]=[^;{},]+)+),${cache}\\[(\\d+)\\]=${selected}\\):${selected}=${cache}\\[\\2\\]`,"u")
    .exec(body.slice(afterLink));
  if(!stored||body.slice(afterLink+stored[0].length,wrapper.index)!==","||writes(body,child).length!==2)return false;
  const selection=one(matches(body.slice(0,link.index),new RegExp(`(?<![\\w$.])${selected}=(${ID})\\?`,"gu"))
    .filter(match=>match.index>returned.index));
  if(!selection||body.slice(selection.index-2,selection.index)!=="?(")return false;
  const ordinaryBranch=body.slice(selection.index+child.length+1,link.index);
  if(!ordinaryBranch.endsWith(":"))return false;
  // Parsing this bounded native ternary proves the wanted JSX is its ordinary
  // branch; the memo/result checks above connect that branch to the return.
  try { new Script(`const __codexHomeSelection=${ordinaryBranch}null;`);return true; }
  catch{return false;}
}
function graph(module, defs, leaf) {
  const exported=exportGetter(module,"Z");if(!exported||typeof exported.expression!=="string"||exported.expression.includes("."))return null;
  const entry=defs.find(f=>f.name===exported.expression);if(!entry||!liveFunction(entry)||!liveFunction(leaf))return null;
  const entryLinks=matches(entry.body,new RegExp(`\\(0,${ID}\\.jsx\\)\\((${ID}),\\{\\.\\.\\.(${ID}),hideHeaderUpgrade:!1,prepareTaskSuggestionDestination:${ID}\\}\\)`,"gu"));
  const link=one(entryLinks);if(!link||!returnedHomeEntry(entry,link))return null;
  const middle=defs.find(f=>f.name===link[1]);if(!middle||!liveFunction(middle))return null;
  const call=one(matches(middle.body,new RegExp(`(?<![\\w$.])(${ID})=(${ID})=>\\(0,${ID}\\.jsx\\)\\(${escapeRegExp(leaf.name)},`,"gu")));
  if(!call)return null;
  const objectStart=middle.body.indexOf("{",call.index+call[0].length),objectEnd=findMatchingBrace(middle.body,objectStart),props=middle.body.slice(objectStart,objectEnd+1);
  if(!props.includes(`mobileFeed:${call[2]},`)||!props.includes("projectId:")||!props.includes("homeComposerController:"))return null;
  const alias=one(matches(middle.body,new RegExp(`\\blet (${ID})=${escapeRegExp(call[1])}(?=[,;])`,"gu")));
  if(!alias||writes(middle.body,alias[1]).length!==1)return null;
  const invocation=one(matches(middle.body,new RegExp(`children:${escapeRegExp(alias[1])}\\(\\)`,"gu"),false));
  if(!invocation)return null;
  return {exportName:"Z",entry:entry.name,middle:middle.name,leaf:leaf.name};
}
function inspectModule(module) {
  const source=module.moduleSource,object=one(homeObjects(source));if(!object)return null;
  const defs=functions(source),leaf=one(defs.filter(fn=>fn.start<object.start&&object.end<fn.end));if(!leaf)return null;
  const body=leaf.body,fields=object.fields,enabled=escapeRegExp(fields.generatedSuggestionsEnabled);
  const eligible=one(matches(body,new RegExp(`(?<![\\w$.])${enabled}=(${ID})&&(?:(${ID})|\\((${ID})\\|\\|function ${MARKER}\\(\\)\\{return!0\\}\\(\\)\\))(?=[,;])`,"gu")));
  if(!eligible)return null;
  const rollout=eligible[1],account=eligible[2]??eligible[3];
  const gate=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(rollout)}=(?:\\(0,(${ID})\\.(${ID})\\)\\("2425897452"\\)|\\(\\(0,(${ID})\\.(${ID})\\)\\("2425897452"\\),function ${ROLLOUT}\\(\\)\\{return!0\\}\\(\\)\\))`,"gu")));
  if(!gate||writes(body,rollout).length!==1||writes(body,account).length!==1||writes(body,fields.generatedSuggestionsEnabled).length!==1)return null;
  const memo=one(matches(body,new RegExp(
    `(${ID})\\[(\\d+)\\]!==(${ID})\\|\\|\\1\\[(\\d+)\\]!==(${ID})\\|\\|\\1\\[(\\d+)\\]!==(${ID})\\?\\((${ID})=\\(0,(${ID})\\.(${ID})\\)\\(\\{authMethod:\\3,email:\\7,plan:\\5\\}\\),\\1\\[\\2\\]=\\3,\\1\\[\\4\\]=\\5,\\1\\[\\6\\]=\\7,\\1\\[(\\d+)\\]=\\8\\):\\8=\\1\\[\\11\\]`,"gu")));
  if(!memo||new Set([memo[2],memo[4],memo[6],memo[11]]).size!==4||writes(body,memo[8]).length!==2||fields.plan!==memo[5])return null;
  const accountAlias=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(account)}=${escapeRegExp(memo[8])}(?=[,;])`,"gu")));if(!accountAlias)return null;
  const navigation=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(fields.onLocalConversationCreated)}=(${ID})(?=[,;])`,"gu")));if(!navigation||writes(body,fields.onLocalConversationCreated).length!==1)return null;
  const callback=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(navigation[1])}=async\\((${ID}),(${ID}),(${ID})\\)=>\\{`,"gu")));
  if(!callback||writes(body,navigation[1]).length!==2)return null;
  const callbackEnd=findMatchingBrace(body,callback.index+callback[0].length-1),callbackBody=body.slice(callback.index+callback[0].length,callbackEnd);
  if(!callbackBody.includes(`conversationId:${callback[1]},draftThreadLocationId:`)||!callbackBody.includes(`"background"===${callback[3]}`))return null;
  const route=one(matches(callbackBody,new RegExp(`let (${ID})=${ID}\\?\\(0,${escapeRegExp(memo[9])}\\.${ID}\\)\\(${escapeRegExp(callback[1])}\\):\\(0,${escapeRegExp(memo[9])}\\.${ID}\\)\\(${escapeRegExp(callback[1])}\\);await (${ID})\\(\\1,\\{replace:!0,state:\\{\\.\\.\\.${escapeRegExp(callback[2])},preserveSidebarScroll:!0\\}\\}\\)`,"gu")));
  if(!route)return null;
  const chain=graph(module,defs,leaf);if(!chain)return null;
  return {moduleId:module.moduleId,graph:chain,fields,consumer:object,component:leaf,rollout,rolloutCall:{namespace:gate[1]??gate[3],member:gate[2]??gate[4]},account,accountCall:{namespace:memo[9],member:memo[10],auth:memo[3],email:memo[7],plan:memo[5]},view:{namespace:object.view,member:object.viewExport},navigation:{callback:navigation[1],args:callback.slice(1,4)},module};
}
function inspectPage(source,snapshot) {
  if(typeof source!=="string")return null;
  try {
    const modules=source.includes("__webpack_modules__")?[...rspackModuleFactories(source,"app-page.js")]:snapshot?.params?[{...snapshot,moduleSource:source}]:[];
    return one(modules.map(inspectModule).filter(Boolean));
  }catch{return null;}
}
function isCandidate(body) { try{return homeObjects(body).length>0;}catch{return false;} }
function dependencyCopies(assetsDir, id, cache) {
  if(cache.has(id))return cache.get(id);
  const literal=new RegExp(`(?:${escapeRegExp(id)}|${escapeRegExp(JSON.stringify(id))})\\s*\\(`,"u");
  const copies=findUniqueRspackModuleCopies(assetsDir,{
    description:`ordinary Home dependency ${id}`,
    sourceMatch:source=>literal.test(source)||source.includes("\\u"),
    matchModule:(_body,module)=>module.moduleId===id,
  });
  cache.set(id,copies);return copies;
}
function entryContext(extractedDir) {
  const html=fs.readFileSync(path.join(extractedDir,"webview/index.html"),"utf8");
  const entries=[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)]
    .map(m=>/^(?:\.\/|\/)?assets\/([^/?#]+\.js)$/u.exec(m[1])?.[1]).filter(Boolean)
    .map(name=>({assetName:name,source:fs.readFileSync(path.join(extractedDir,"webview/assets",name),"utf8")}))
    .filter(({source})=>source.includes("as __webpack_require__}")&&source.includes("codex-host-chunked-message-v1")&&!source.includes("initializeDetachedWindow"));
  const entry=one(entries);if(!entry)throw Error("Missing ordinary Home runtime entry");
  const exported=/export\{([A-Za-z_$][\w$]*) as __webpack_require__\}/u.exec(entry.source);
  if(!exported)throw Error("Missing ordinary Home runtime require export");
  let requireName=exported[1];
  const alias=one(matches(entry.source,new RegExp(`(?:var|let|const) ${escapeRegExp(requireName)}=(${ID})(?=[,;])`,"gu")));
  if(alias)requireName=alias[1];
  const assigned=one(matches(entry.source,new RegExp(`${escapeRegExp(requireName)}\\.j="(\\d+)"`,"gu")));
  if(!assigned)throw Error("Missing ordinary Home runtime identity");
  return {...entry,entryId:assigned[1]};
}
function availableBinding(module,name,entryId) {
  const direct=findRspackRequireBinding(module,name);if(direct)return direct;
  const req=module.params?.[2];if(!req)return null;
  const guarded=one(matches(module.moduleSource,new RegExp(
    `if\\(${escapeRegExp(entryId)}==${escapeRegExp(req)}\\.j\\)var ${escapeRegExp(name)}=${escapeRegExp(req)}\\("([^"]+)"\\);`,"gu")));
  if(!guarded)return null;
  // The native root runtime's exact require.j proves this static import is
  // available; use the shared binding resolver on that true-branch projection.
  const source=module.moduleSource.replace(guarded[0],guarded[0].slice(guarded[0].indexOf("var ")));
  return findRspackRequireBinding({...module,moduleSource:source},name);
}
function resolveFunction(assetsDir,id,key,cache,entryId,seen=new Set()) {
  const token=id+":"+key;if(seen.has(token)||seen.size>8)throw Error("Cyclic ordinary Home dependency");
  const next=new Set(seen).add(token),resolved=[];
  for(const module of dependencyCopies(assetsDir,id,cache)) {
    const getter=exportGetter(module,key);if(!getter)throw Error("Missing ordinary Home dependency export");
    if(getter.fn){resolved.push({module,fn:getter.fn,exportName:getter.exportName});continue;}
    const parts=getter.expression.split(".");
    if(parts.length===2) {
      const binding=availableBinding(module,parts[0],entryId);if(!binding)throw Error("Unbound ordinary Home re-export");
      resolved.push(...resolveFunction(assetsDir,binding.moduleId,parts[1],cache,entryId,next));
    } else {
      const fn=one(functions(module.moduleSource,parts[0]));
      if(!fn)throw Error("Missing ordinary Home dependency function");
      resolved.push({module,fn});
    }
  }
  return resolved;
}
function isAccountPredicate(fn) {
  const params=new RegExp(`^\\{authMethod:(${ID}),email:(${ID}),plan:(${ID})\\}$`,"u").exec(fn.params);
  if(!params)return false;
  const body=new RegExp(`^return"apikey"===${escapeRegExp(params[1])}\\|\\|"chatgpt"===${escapeRegExp(params[1])}&&function\\(\\{email:(${ID}),plan:(${ID})\\}\\)\\{return\\(0,${ID}\\.${ID}\\)\\(\\1\\)\\|\\|${ID}\\.some\\((${ID})=>\\3===\\2\\)\\}\\(\\{email:${escapeRegExp(params[2])},plan:${escapeRegExp(params[3])}\\}\\)$`,"u");
  return body.test(fn.body);
}
function isRolloutHook({module,fn}) {
  if(!new RegExp(`^${ID}$`,"u").test(fn.params)||!liveFunction(fn))return false;
  const parameter=escapeRegExp(fn.params);
  const signal=one(matches(fn.body,new RegExp(`cache:"signal",resolve:\\((${ID}),(${ID})\\)=>(${ID})\\.(${ID})\\.resolve\\(\\1,\\2,${parameter}\\)\\.atom,scope:\\3\\.\\4\\.scope`,"gu"),false));
  if(!signal||!findRspackRequireBinding(module,signal[3]))return false;
  const read=one(matches(fn.body,new RegExp(`,\\(0,(${ID})\\.(${ID})\\)\\((${ID})\\)$`,"gu")));
  return Boolean(read&&findRspackRequireBinding(module,read[1])&&fn.body.includes(`"boolean"==typeof ${fn.params}?${fn.params}:{`));
}
function isContentProvider(module) {
  const exported=exportGetter(module,"HomeAmbientSuggestionsContent");
  const defs=functions(module.moduleSource),fn=exported&&defs.find(fn=>fn.name===exported.expression);
  if(!fn||!liveFunction(fn)||!new RegExp(`^${ID}$`,"u").test(fn.params))return false;
  const props=one(matches(fn.body,new RegExp(`\\{generatedSuggestionsEnabled:(${ID}),hostId:(${ID}),isCodexHome:(${ID}),onLocalConversationCreated:(${ID}),plan:(${ID}),projectRoot:(${ID}),routeEntryKey:(${ID}),topLevelLayout:(${ID})\\}=${escapeRegExp(fn.params)}(?=[,;])`,"gu")));
  if(!props)return false;
  const runtime=one(matches(fn.body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.(${ID})\\)\\((${ID})\\.(${ID})\\),(${ID})=${escapeRegExp(props[1])}&&"enabled"===\\1\\.status`,"gu")));
  if(!runtime||!findRspackRequireBinding(module,runtime[2])||!findRspackRequireBinding(module,runtime[4]))return false;
  const [,generated,host,codex,callback,plan,project,route,layout]=props;
  const enabled=runtime[6];
  const context=one(matches(fn.body,new RegExp(`\\{domain:(${ID}),enabled:${escapeRegExp(enabled)},hostId:${escapeRegExp(host)},projectRoot:${escapeRegExp(project)},routeEntryKey:${escapeRegExp(route)}\\}`,"gu")));
  if(!context)return false;
  const consumer=one(matches(fn.body,new RegExp(`\\(0,${ID}\\.jsx\\)\\((${ID}),\\{ambientSuggestionSurface:${ID},domain:${escapeRegExp(context[1])},generatedSuggestionsEnabled:${escapeRegExp(enabled)},hostId:${escapeRegExp(host)},isCodexHome:${escapeRegExp(codex)},onLocalConversationCreated:${escapeRegExp(callback)},plan:${escapeRegExp(plan)},projectRoot:${escapeRegExp(project)},selectedModel:${ID}\\.model,selectedModelDisplayName:${ID},topLevelLayout:${escapeRegExp(layout)}\\}\\)`,"gu")));
  const inner=consumer&&defs.find(fn=>fn.name===consumer[1]);
  return Boolean(inner&&inner.body.includes("generatedSuggestionsEnabled:")&&inner.body.includes('case"fill-composer":'));
}
function validateDependencies(assetsDir,info,cache,entryId) {
  const rollout=findRspackRequireBinding(info.module,info.rolloutCall.namespace);
  const account=findRspackRequireBinding(info.module,info.accountCall.namespace);
  const view=findRspackRequireBinding(info.module,info.view.namespace);
  if(!rollout||!account||!view)throw Error("Unbound ordinary Home rollout/account/view import");
  const gates=resolveFunction(assetsDir,rollout.moduleId,info.rolloutCall.member,cache,entryId);
  if(!gates.length||!gates.every(isRolloutHook))throw Error("Ordinary Home rollout hook role changed");
  const predicates=resolveFunction(assetsDir,account.moduleId,info.accountCall.member,cache,entryId);
  if(!predicates.length||!predicates.every(({fn})=>isAccountPredicate(fn)))throw Error("Ordinary Home account predicate role changed");
  const targets=[];
  for(const facade of dependencyCopies(assetsDir,view.moduleId,cache)) {
    const getter=exportGetter(facade,info.view.member);
    if(!getter||typeof getter.expression!=="string"||getter.expression.includes("."))throw Error("Missing ordinary Home lazy consumer");
    const init=one(matches(facade.moduleSource,new RegExp(
      `(?<![\\w$.])${escapeRegExp(getter.expression)}=\\(0,${ID}\\.${ID}\\)\\(async\\(\\)=>\\(await ${escapeRegExp(facade.params[2])}\\.e\\(\\d+\\)\\.then\\(${escapeRegExp(facade.params[2])}\\.bind\\(${escapeRegExp(facade.params[2])},"([^"]+)"\\)\\)\\)\\.HomeAmbientSuggestionsContent,\\{propagateLoadError:!0\\}\\)`,"gu")));
    if(!init||writes(facade.moduleSource,getter.expression).length!==1)throw Error("Ordinary Home lazy provider binding changed");
    targets.push(init[1]);
  }
  if(new Set(targets).size!==1)throw Error("Ambiguous ordinary Home content provider");
  for(const provider of dependencyCopies(assetsDir,targets[0],cache)) {
    if(!isContentProvider(provider))throw Error("Ordinary Home native provider role changed");
  }
  const target=({module,fn,exportName})=>({moduleId:module.moduleId,functionName:fn.name,...exportName?{exportName}:{}});
  return {rolloutModule:rollout.moduleId,rolloutExport:info.rolloutCall.member,rolloutTargets:gates.map(target),accountModule:account.moduleId,accountExport:info.accountCall.member,accountTargets:predicates.map(target),viewModule:view.moduleId,viewExport:info.view.member,providerModule:targets[0],providerExport:"HomeAmbientSuggestionsContent"};
}
function applyToExtractedApp(extractedDir) {
  const central=require("./suggested-prompts.js"),assetsDir=path.join(extractedDir,"webview/assets"),cache=new Map(),entry=entryContext(extractedDir);
  const copies=findUniqueRspackModuleCopies(assetsDir,{description:"ordinary Home page",sourceMatch:source=>source.includes("onLocalConversationCreated:"),matchModule:isCandidate});
  // Resolve every live caller/dependency before preparing any file write.
  for(const copy of copies) {
    const info=inspectModule(copy);
    if(!info||central.suggestedPromptsAppPageContract(copy.moduleSource,copy)==="drifted")throw Error("Incomplete ordinary Home page contract");
    validateDependencies(assetsDir,info,cache,entry.entryId);
  }
  return patchRspackModuleCopies(assetsDir,copies,(body,copy)=>{
    const patched=central.applySuggestedPromptsAppPagePatch(body,copy);
    if(central.suggestedPromptsAppPageContract(patched,copy)!=="patched")throw Error("Ordinary Home page poststate failed");
    return patched;
  });
}

module.exports={applyToExtractedApp,inspectPage,inspectModule,isCandidate,exportGetter,validateDependencies,entryContext,
  roleHelpers:{ID,one,matches,writes,functions,liveFunction,statementAt,exportGetter,dependencyCopies,resolveFunction,isAccountPredicate,isRolloutHook,entryContext}};
