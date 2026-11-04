"use strict";

const path = require("node:path");
const { Script } = require("node:vm");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { findMatchingBrace, escapeRegExp } = require("../../../scripts/patches/lib/minified-js.js");
const { roleHelpers: { ID, one, matches, writes, functions, liveFunction, statementAt, exportGetter, dependencyCopies, resolveFunction, isAccountPredicate, isRolloutHook, entryContext } } = require("./suggested-prompts-app-page.js");
const MARKER="codexLinuxUiTweaksSuggestedPromptsWorkPageEligible";
const ROLLOUT="codexLinuxUiTweaksSuggestedPromptsEnabled";
function importedIn(module,fn,name) {
  if(!findRspackRequireBinding(module,name)||writes(fn.body,name).length!==0)return false;
  try { new Script(`function probe(${fn.params}){${fn.body}\n;let ${name};}`);return true; }
  catch{return false;}
}
function returnedView(fn) {
  const returns=matches(fn.body,/\breturn\b/gu),last=returns.at(-1);if(!last)return false;
  const expression=fn.body.slice(last.index+6).trim();
  if(new RegExp(`^\\(0,${ID}\\.jsxs?\\)\\(`,"u").test(expression))return true;
  const tail=new RegExp(`:(${ID})=${ID}\\[\\d+\\],\\1\\)?$`,"u").exec(expression);
  return Boolean(tail&&new RegExp(`(?<![\\w$.])${escapeRegExp(tail[1])}=\\(0,${ID}\\.jsxs?\\)\\(`,"u").test(expression));
}
function workObjects(body) {
  const found=[];
  for(const marker of matches(body,/generatedSuggestionsEnabled:/gu,false)) {
    const start=body.lastIndexOf("{",marker.index),end=findMatchingBrace(body,start);
    if(start<0||end<0)continue;
    const text=body.slice(start,end+1);
    const object=new RegExp(`^\\{generatedSuggestionsEnabled:(${ID})&&(.+),hostId:(${ID}),mode:"work",onSelect:(${ID}),projectId:(${ID})\\.composerProps\\.projectId\\?\\?null,workRunLocation:\\5\\.runLocationState\\.effectiveLocation\\}$`,"u").exec(text);
    if(!object)continue;
    let eligibility=object[2];
    const suffix=`||function ${MARKER}(){return!0}())`;
    if(eligibility.startsWith("(")&&eligibility.endsWith(suffix))eligibility=eligibility.slice(1,-suffix.length);
    const account=new RegExp(`^\\(0,(${ID})\\.(${ID})\\)\\(\\{authMethod:(${ID}),email:(${ID})\\?\\.email\\?\\?(${ID}),plan:(${ID})\\}\\)$`,"u").exec(eligibility);
    const jsx=new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID})\\.HomeTaskSuggestions,$`,"u").exec(body.slice(0,start));
    if(account&&jsx)found.push({start,end:end+1,text,rollout:object[1],jsx:jsx[1],fields:{host:object[3],selection:object[4],state:object[5]},account:{namespace:account[1],member:account[2],auth:account[3],info:account[4],email:account[5],plan:account[6]},provider:{namespace:jsx[2],member:"HomeTaskSuggestions"}});
  }
  return found;
}
function inspectModule(module) {
  const body=module.moduleSource,object=one(workObjects(body));if(!object)return null;
  const defs=functions(body),leaf=one(defs.filter(fn=>fn.start<object.start&&object.end<fn.end));
  const exported=exportGetter(module,"ChatGptWorkHomePage"),entry=exported&&one(defs.filter(fn=>fn.name===exported.expression));
  if(!leaf||!entry||!liveFunction(entry)||!liveFunction(leaf)||!returnedView(entry)||!returnedView(leaf))return null;
  const mount=one(matches(entry.body,new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID})\\.${ID},\\{followUpSuggestionsPlacement:"below-composer",children:\\(0,\\1\\.jsx\\)\\(${escapeRegExp(leaf.name)},\\{\\.\\.\\.${escapeRegExp(entry.params)}\\}\\)\\}\\)`,"gu")));
  const returned=matches(entry.body,/\breturn\b/gu).at(-1),result=/:([\w$]+)=[\w$]+\[\d+\],\1\)?$/u.exec(entry.body);
  if(!mount||!returned||mount.index<returned.index||!importedIn(module,entry,mount[1])||!importedIn(module,entry,mount[2]))return null;
  const prefix=entry.body.slice(returned.index+6,mount.index).trim();
  if(prefix!==""&&(!result||!prefix.endsWith(`${result[1]}=`)||prefix.includes("=>")))return null;
  const {rollout,fields,account}=object;
  const gate=one(matches(leaf.body,new RegExp(`(?<![\\w$.])${escapeRegExp(rollout)}=(?:\\(0,(${ID})\\.(${ID})\\)\\("2425897452"\\)|\\(\\(0,(${ID})\\.(${ID})\\)\\("2425897452"\\),function ${ROLLOUT}\\(\\)\\{return!0\\}\\(\\)\\))(?=[,;])`,"gu")));
  if(!gate||writes(leaf.body,rollout).length!==1)return null;
  const props=one(matches(leaf.body,new RegExp(`\\{renderHomeContent:${ID},hideHeaderUpgrade:${ID},additionalDeveloperInstructions:${ID},onTaskSuggestionSelected:${escapeRegExp(fields.selection)}\\}=${escapeRegExp(leaf.params)}(?=[,;])`,"gu")));
  const host=one(matches(leaf.body,new RegExp(`(?<![\\w$.])${escapeRegExp(fields.host)}=\\(0,(${ID})\\.${ID}\\)\\((${ID})\\.threadHostId\\$\\)`,"gu")));
  const state=one(matches(leaf.body,new RegExp(`(?<![\\w$.])${escapeRegExp(fields.state)}=\\(0,(${ID})\\.(${ID})\\)\\((${ID})\\)(?=[,;])`,"gu")));
  if(!props||!host||!state||writes(leaf.body,fields.state).length!==1||!leaf.body.includes(`{homeComposerController:`)||!leaf.body.includes('homeComposerMode:"work"}'))return null;
  return {module,graph:{entry:entry.name,leaf:leaf.name},component:leaf,consumer:object,rollout,rolloutCall:{namespace:gate[1]??gate[3],member:gate[2]??gate[4]},accountCall:account,provider:object.provider,fields};
}
function inspectPage(source) {
  if(typeof source!=="string")return null;
  try {
    let modules;
    if(source.includes("__webpack_modules__"))modules=[...rspackModuleFactories(source,"work-page.js")];
    else {
      const module={moduleSource:source,moduleId:"WorkPageOwner",start:0,end:source.length},exported=exportGetter(module,"ChatGptWorkHomePage");
      if(!exported)return null;
      module.params=["__codexWorkModule",exported.exportsName,exported.requireName];modules=[module];
    }
    return one(modules.map(inspectModule).filter(Boolean));
  }catch{return null;}
}
function isCandidate(body) { try{return workObjects(body).length>0;}catch{return false;} }

// Work's query is a direct value export in the third require.d argument, not
// the getter exports used by the page/account facades.
function valueExport(module,key) {
  const {moduleSource:body,params}=module,req=params?.[2],target=params?.[1];if(!req||!target)return null;
  const call=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(req)}\\.d\\(${escapeRegExp(target)},\\{`,"gu")).filter(m=>statementAt(body,m.index)));
  if(!call)return null;
  const open=call.index+call[0].length-1,end=findMatchingBrace(body,open);
  if(body.slice(end+1,end+3)!==",{")return null;
  const valuesEnd=findMatchingBrace(body,end+2),values=body.slice(end+3,valuesEnd);
  const found=one([...values.matchAll(new RegExp(`(?:^|,)${escapeRegExp(key)}:(${ID})(?=,|$)`,"gu"))]);return found?.[1]??null;
}
function queryRole(module,key) {
  const value=valueExport(module,key);if(!value)return false;
  const body=module.moduleSource;
  const definition=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(value)}=\\(0,(${ID})\\.(${ID})\\)\\((${ID})\\.${ID},\\(\\{hostId:(${ID}),mode:(${ID}),supportsHomeFeed:(${ID})=!1\\},\\{get:(${ID})\\}\\)=>\\{`,"gu")));
  if(!definition||definition[2]!=="vU"||!findRspackRequireBinding(module,definition[1])||!findRspackRequireBinding(module,definition[3]))return false;
  const open=definition.index+definition[0].length-1,end=findMatchingBrace(body,open),query=body.slice(open+1,end);
  const keyMatch=one(matches(query,new RegExp(`queryKey:\\["chatgpt-task-suggestions",(${ID}),${escapeRegExp(definition[4])},${escapeRegExp(definition[5])},${escapeRegExp(definition[6])}\\]`,"gu"),false));
  const fetch=one(matches(query,new RegExp(`(${ID})\\.appServices\\.ambientSuggestions\\?\\.getChatGptComposerItems\\(\\{entrypoint:${escapeRegExp(definition[5])},hostId:${escapeRegExp(definition[4])}\\}\\)`,"gu"),false));
  return Boolean(keyMatch&&fetch&&findRspackRequireBinding(module,fetch[1])&&!query.includes("projectId:"));
}
function providerRole(module) {
  const exported=exportGetter(module,"HomeTaskSuggestions"),defs=functions(module.moduleSource),outer=exported&&one(defs.filter(fn=>fn.name===exported.expression));
  if(!outer||!liveFunction(outer)||!returnedView(outer))return null;
  const props=one(matches(outer.body,new RegExp(`generatedSuggestionsEnabled:(${ID}),generatedSuggestionsLoading:(${ID}),hostId:(${ID}),mode:(${ID}),onSelect:(${ID}),projectId:(${ID}),prepareDestination:(${ID}),unifiedModelPickerEnabled:(${ID}),workRunLocation:(${ID})`,"gu"),false));
  if(!props)return null;
  const innerCall=one(matches(outer.body,new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{mobileFeedContent:`,"gu")));
  const inner=innerCall&&one(defs.filter(fn=>fn.name===innerCall[2]));if(!inner||!returnedView(inner)||!importedIn(module,outer,innerCall[1]))return null;
  const page=one(matches(outer.body,new RegExp(`(?<![\\w$.])(${ID})=void 0===${escapeRegExp(props[1])}\\|\\|${escapeRegExp(props[1])}`,"gu")));
  const forwarded=one(matches(outer.body,new RegExp(`hostId:${escapeRegExp(props[3])},mode:${escapeRegExp(props[4])},onOpenHomeFeed:[\\s\\S]+?onSelect:${ID}\\|\\|!${ID}\\?${escapeRegExp(props[5])}:void 0,projectId:${escapeRegExp(props[6])},prepareDestination:${escapeRegExp(props[7])},workRunLocation:${escapeRegExp(props[9])}\\}`,"gu"),false));
  if(!page||!forwarded||!outer.body.includes(`&&${page[1]}&&!`))return null;
  const fields=one(matches(inner.body,new RegExp(`generatedSuggestionsEnabled:(${ID}),generatedSuggestionsLoading:${ID},suggestionsDisabled:${ID},fileSuggestionsEnabled:(${ID}),hostId:(${ID}),mode:(${ID}),onOpenHomeFeed:${ID},onSelect:(${ID}),projectId:(${ID}),prepareDestination:${ID},workRunLocation:${ID}\\}=${escapeRegExp(inner.params)}`,"gu"),false));
  if(!fields)return null;
  const args=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=\\{hostId:${escapeRegExp(fields[3])},mode:${escapeRegExp(fields[4])},supportsHomeFeed:(${ID})\\}`,"gu")));
  const query=args&&one(matches(inner.body,new RegExp(`\\(0,(${ID})\\._U\\)\\((${ID})\\.(${ID}),${escapeRegExp(args[1])},(${ID})\\)`,"gu")));
  const options=query&&one(matches(inner.body,new RegExp(`(?<![\\w$.])${escapeRegExp(query[4])}=\\{enabled:(${ID})\\}`,"gu")));
  if(!query||!options||!findRspackRequireBinding(module,query[1])||!findRspackRequireBinding(module,query[2]))return null;
  const setting=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.${ID}\\)\\((${ID})\\.${ID}\\)`,"gu")).filter(m=>inner.body.includes(`"enabled"===${m[1]}.status`)));
  if(!setting||!findRspackRequireBinding(module,setting[2])||!findRspackRequireBinding(module,setting[3]))return null;
  const runtime=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=!${ID}&&!${ID}&&\\(${ID}\\?${ID}:${escapeRegExp(fields[1])}&&${ID}&&"enabled"===${escapeRegExp(setting[1])}\\.status&&\\(${ID}\\|\\|${escapeRegExp(fields[2])}&&${ID}\\)\\)`,"gu")));
  if(!runtime||!new RegExp(`${escapeRegExp(options[1])}=!${ID}&&\\(${escapeRegExp(runtime[1])}\\|\\|${ID}\\)&&null!=${ID}&&\\("chat"!==${escapeRegExp(fields[4])}\\|\\|!${ID}\\)`,"u").test(inner.body))return null;
  const aliases=one(matches(inner.body,new RegExp(`let (${ID})=(${ID});`,"gu")).filter(m=>inner.body.includes(`onClick:()=>${m[1]}(`)));
  const action=aliases&&one(matches(inner.body,new RegExp(`(?<![\\w$.])${escapeRegExp(aliases[2])}=\\((${ID}),(${ID}),(${ID})\\)=>\\{`,"gu")));
  if(!action||writes(inner.body,aliases[1]).length!==1)return null;
  const actionOpen=action.index+action[0].length-1,actionEnd=findMatchingBrace(inner.body,actionOpen),actionBody=inner.body.slice(actionOpen+1,actionEnd);
  const prompt=one(matches(actionBody,new RegExp(`(?<![\\w$.])(${ID})=${ID}\\?\\.prompt\\?\\?${escapeRegExp(action[1])}\\.prompt`,"gu")));
  const target=one(matches(actionBody,new RegExp(`let (${ID})=(${ID})\\?\\.type==="prompt"\\?\\2\\.entrypoint\\?\\?${escapeRegExp(fields[4])}:${escapeRegExp(fields[4])};`,"gu"),false));
  const preparation=target&&one(matches(actionBody,new RegExp(`(${ID})=${escapeRegExp(fields[5])}\\?\\.\\(${escapeRegExp(target[1])}\\);if\\(null!=\\1&&await \\1,`,"gu"),false));
  const editor=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.a\\)\\(\\)`,"gu")).filter(m=>actionBody.includes(`${m[1]}.setPromptText(`)));
  if(!prompt||!preparation||!editor||!findRspackRequireBinding(module,editor[2]))return null;
  const setter=one(matches(actionBody,new RegExp(`\\(0,(${ID})\\.flushSync\\)\\(\\(\\)=>\\{${escapeRegExp(editor[1])}\\.setPromptText\\(${escapeRegExp(prompt[1])},\\{preserveLibraryFileMentions:${escapeRegExp(fields[2])}\\}\\)`,"gu"),false));
  if(!setter||!findRspackRequireBinding(module,setter[1])||!new RegExp(`\\}\\),${ID}\\(\\),${escapeRegExp(editor[1])}\\.focus\\(\\),${escapeRegExp(action[3])}`,"u").test(actionBody))return null;
  if(![query[1],query[2],setting[2],setting[3],editor[2],setter[1]].every(name=>importedIn(module,inner,name)))return null;
  return {outer:outer.name,inner:inner.name,query:{moduleId:findRspackRequireBinding(module,query[2]).moduleId,exportName:query[3]},selection:{callback:aliases[2],alias:aliases[1],source:actionBody},fields:{host:fields[3],mode:fields[4],selection:fields[5],project:fields[6]}};
}

function shellRole(module,pageId) {
  const body=module.moduleSource,req=module.params?.[2];if(!req)return null;
  const lazy=one(matches(body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.${ID}\\)\\(async\\(\\)=>\\(await Promise\\.all\\(\\[(?:${escapeRegExp(req)}\\.e\\(\\d+\\),)*${escapeRegExp(req)}\\.e\\(\\d+\\)\\]\\)\\.then\\(${escapeRegExp(req)}\\.bind\\(${escapeRegExp(req)},${escapeRegExp(JSON.stringify(pageId))}\\)\\)\\)\\.ChatGptWorkHomePage\\)`,"gu")));
  const exported=exportGetter(module,"Z"),entry=exported&&one(functions(body,exported.expression));
  if(!lazy||!entry||!liveFunction(entry)||!returnedView(entry)||!findRspackRequireBinding(module,lazy[2])||writes(body,lazy[1]).length!==1)return null;
  const forwarded=one(matches(entry.body,new RegExp(`\\(0,${ID}\\.jsx\\)\\(${escapeRegExp(lazy[1])},\\{hideHeaderUpgrade:!1,onTaskSuggestionSelected:(${ID})\\.onChatGptTaskSuggestionSelected\\}\\)`,"gu"),false));
  return forwarded?{entry:entry.name,lazy:lazy[1]}:null;
}
function preparationRole(module,shellId) {
  const exported=exportGetter(module,"HomeComposerRoute"),defs=functions(module.moduleSource),entry=exported&&one(defs.filter(fn=>fn.name===exported.expression));
  if(!entry||!liveFunction(entry)||!returnedView(entry))return null;
  const candidates=[];
  for(const fn of defs) {
    if(!returnedView(fn))continue;
    const props=one(matches(fn.body,new RegExp(`canSwitchMode:(${ID}),showPendingModeToggle:${ID},unifiedModelPickerEnabled:(${ID}),workspaceAgent:${ID},mode:(${ID}),routeProjectId:${ID},preservePendingInput:${ID},workModeAllowed:(${ID}),workModeLoading:${ID},workModeUpgradePlan:${ID},onModeChange:${ID}\\}=${escapeRegExp(fn.params)}`,"gu"),false));
    if(!props)continue;
    const callback=one(matches(fn.body,new RegExp(`(?<![\\w$.])(${ID})=${escapeRegExp(props[4])}\\?(${ID})=>\\{if\\(\\2!==${escapeRegExp(props[3])}\\)\\{if\\(!${escapeRegExp(props[1])}\\)throw Error\\("Suggestion destination is unavailable"\\);if\\(${escapeRegExp(props[2])}\\)\\{if\\("chat"!==\\2\\)throw Error\\("Suggestion destination is unavailable"\\);return\\(0,(${ID})\\.(${ID})\\)\\((${ID}),\\5\\.get\\((${ID})\\.${ID},null\\),(${ID})\\)\\.then\\((${ID})\\)\\}(${ID})\\(\\2,void 0,"task_suggestion"\\)\\}\\}:void 0`,"gu")));
    if(!callback||!findRspackRequireBinding(module,callback[3])||!findRspackRequireBinding(module,callback[6]))continue;
    const no=one(functions(module.moduleSource,callback[7])),assert=one(functions(module.moduleSource,callback[8]));
    if(!no||no.body!=="return!1"||!assert||assert.body!==`if(!${assert.params})throw Error("Suggestion destination is unavailable")`)continue;
    const forwarded=one(matches(fn.body,new RegExp(`\\(0,${ID}\\.jsx\\)\\((${ID})\\.Z,\\{preservePendingInput:${ID},workspaceAgent:${ID},homeComposerController:${ID},homeComposerMode:${escapeRegExp(props[3])},unifiedModelPickerEnabled:${escapeRegExp(props[2])},homeComposerModeToggle:${ID},onTemporaryChatToggle:${ID},taskSuggestionsLoading:${ID},onChatGptTaskSuggestionSelected:${escapeRegExp(callback[1])},projectId:${ID}\\}\\)`,"gu")));
    if(!forwarded||findRspackRequireBinding(module,forwarded[1])?.moduleId!==shellId||!entry.body.includes(`)(`+fn.name+",{"))continue;
    candidates.push({entry:entry.name,component:fn.name,callback:callback[1],expression:callback[0].slice(callback[1].length+1),helpers:[no,assert].map(fn=>({name:fn.name,params:fn.params,body:fn.body}))});
  }
  return one(candidates);
}
function validateCallers(assetsDir,info,cache) {
  const shells=findUniqueRspackModuleCopies(assetsDir,{description:"native Work lazy route",sourceMatch:s=>s.includes(".ChatGptWorkHomePage"),matchModule:(_body,module)=>Boolean(shellRole(module,info.module.moduleId))});
  cache.set("work-shell",shells);
  if(!shells.every(module=>shellRole(module,info.module.moduleId)))throw Error("Incomplete Work Home lazy route copy");
  const routes=findUniqueRspackModuleCopies(assetsDir,{description:"native Work preparation route",sourceMatch:s=>s.includes("HomeComposerRoute:"),matchModule:(_body,module)=>Boolean(preparationRole(module,shells[0].moduleId))});
  cache.set("work-preparation",routes);
  if(!routes.every(module=>preparationRole(module,shells[0].moduleId)))throw Error("Incomplete Work Home preparation route copy");
  return {shellModule:shells[0].moduleId,preparationModule:routes[0].moduleId,preparation:preparationRole(routes[0],shells[0].moduleId)};
}

function validateDependencies(assetsDir,info,cache,entryId) {
  const gate=findRspackRequireBinding(info.module,info.rolloutCall.namespace),account=findRspackRequireBinding(info.module,info.accountCall.namespace),content=findRspackRequireBinding(info.module,info.provider.namespace);
  if(!gate||!account||!content||![info.rolloutCall.namespace,info.accountCall.namespace,info.provider.namespace,info.consumer.jsx].every(name=>importedIn(info.module,info.component,name)))throw Error("Unbound Work Home rollout/account/provider import");
  const gates=resolveFunction(assetsDir,gate.moduleId,info.rolloutCall.member,cache,entryId),accounts=resolveFunction(assetsDir,account.moduleId,info.accountCall.member,cache,entryId);
  if(!gates.length||!gates.every(isRolloutHook)||!accounts.length||!accounts.every(({fn})=>isAccountPredicate(fn)))throw Error("Work Home rollout/account role changed");
  const providers=dependencyCopies(assetsDir,content.moduleId,cache),roles=[];
  for(const provider of providers) {
    const role=providerRole(provider);if(!role)throw Error("Work Home native provider role changed");
    const queries=dependencyCopies(assetsDir,role.query.moduleId,cache);
    if(!queries.length||!queries.every(module=>queryRole(module,role.query.exportName)))throw Error("Work Home native query role changed");
    roles.push(role);
  }
  return {providerModule:content.moduleId,providerExport:info.provider.member,providerRoles:roles,callers:validateCallers(assetsDir,info,cache)};
}
function applyToExtractedApp(extractedDir) {
  const central=require("./suggested-prompts.js"),assetsDir=path.join(extractedDir,"webview/assets"),cache=new Map(),entry=entryContext(extractedDir);
  const copies=findUniqueRspackModuleCopies(assetsDir,{description:"Work Home page",sourceMatch:s=>s.includes("ChatGptWorkHomePage:"),matchModule:isCandidate});
  for(const copy of copies) {
    const info=inspectModule(copy);
    if(!info||central.suggestedPromptsWorkPageContract(copy.moduleSource)==="drifted")throw Error("Incomplete Work Home page contract");
    validateDependencies(assetsDir,info,cache,entry.entryId);
  }
  return patchRspackModuleCopies(assetsDir,copies,body=>{
    const patched=central.applySuggestedPromptsWorkPagePatch(body);
    if(central.suggestedPromptsWorkPageContract(patched)!=="patched")throw Error("Work Home page poststate failed");return patched;
  });
}
module.exports={applyToExtractedApp,inspectPage,inspectModule,isCandidate,validateDependencies,providerRole,queryRole,valueExport,shellRole,preparationRole};
