"use strict";

const path = require("node:path");
const { Script } = require("node:vm");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const { findMatchingBrace, escapeRegExp, createJavaScriptLexicalIndex } = require("../../../scripts/patches/lib/minified-js.js");
const { prepareBindingAuthority, proveBindingAuthority } = require("../../../scripts/patches/lib/javascript-binding-authority.js");
const { roleHelpers: { ID, one, matches, writes, functions, liveFunction, exportGetter, dependencyCopies, resolveFunction, isAccountPredicate, isRolloutHook, entryContext } } = require("./suggested-prompts-app-page.js");
const MARKER="codexLinuxUiTweaksSuggestedPromptsWorkPageEligible";
const ROLLOUT="codexLinuxUiTweaksSuggestedPromptsEnabled";
const providerBindingViews = new Map();
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
    const object=new RegExp(`^\\{generatedSuggestionsEnabled:(${ID})&&(.+),hostId:(${ID}),mode:"work",onSelect:(${ID}),projectId:(${ID})\\.composerProps\\.projectId\\?\\?null,workCloudUsesLocalExecutor:\\5\\.workCloudUsesLocalExecutor,workRunLocation:\\5\\.runLocationState\\.effectiveLocation\\}$`,"u").exec(text);
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
function inspectPage(source,snapshot) {
  if(typeof source!=="string")return null;
  try {
    let modules;
    if(source.includes("__webpack_modules__"))modules=[...rspackModuleFactories(source,"work-page.js")];
    else modules=snapshot?.params?[{...snapshot,moduleSource:source}]:[];
    return one(modules.map(inspectModule).filter(Boolean));
  }catch{return null;}
}
function isCandidate(body) { try{return workObjects(body).length>0;}catch{return false;} }

// Work's query is a direct value export in the third require.d argument, not
// the getter exports used by the page/account facades.
function valueExport(module,key) {
  const publication=exportGetter(module,key);
  return typeof publication?.expression==="string"?publication.expression:null;
}
function queryRole(module,key) {
  const value=valueExport(module,key);if(!value)return false;
  const body=module.moduleSource;
  const definition=one(matches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(value)}=\\(0,(${ID})\\.(${ID})\\)\\((${ID})\\.${ID},\\(\\{hostId:(${ID}),mode:(${ID}),supportsHomeFeed:(${ID})=!1\\},\\{get:(${ID}),scope:${ID}\\}\\)=>\\{`,"gu")));
  if(!definition||definition[2]!=="vU"||!findRspackRequireBinding(module,definition[1])||!findRspackRequireBinding(module,definition[3]))return false;
  const valueWrites=bindingWrites(body,value);
  if(valueWrites.length!==1||valueWrites[0]!==definition.index)return false;
  const open=definition.index+definition[0].length-1,end=findMatchingBrace(body,open),query=body.slice(open+1,end);
  const keyMatch=one(matches(query,new RegExp(`queryKey:\\["chatgpt-task-suggestions",(?<account>${ID}),${escapeRegExp(definition[4])},${escapeRegExp(definition[5])},${escapeRegExp(definition[6])},(?<saved>${ID})\\]`,"gu"),false));
  if(!keyMatch)return false;
  const account=escapeRegExp(keyMatch.groups.account),saved=escapeRegExp(keyMatch.groups.saved),get=escapeRegExp(definition[7]);
  const state=one(matches(query,new RegExp(`(?<![\\w$.])${account}=${get}\\((?<provider>${ID})\\.(?<account>${ID})\\),${saved}=${get}\\(\\k<provider>\\.(?<saved>${ID})\\)(?=[,;])`,"gu")));
  const fetch=one(matches(query,new RegExp(`(${ID})\\.appServices\\.ambientSuggestions\\?\\.getChatGptComposerItems\\(\\{entrypoint:${escapeRegExp(definition[5])},hostId:${escapeRegExp(definition[4])},supportsSavedLessonChat:${saved}\\}\\)`,"gu"),false));
  const conversion=exportGetter(module,"se")?.fn;
  const conversionParameter=conversion&&new RegExp(`^${ID}$`,"u").test(conversion.params)?escapeRegExp(conversion.params):null;
  const convertsToolPrompt=conversionParameter&&new RegExp(
    `^let\\{title:(${ID})\\}=${conversionParameter},(${ID})=${conversionParameter}\\.item\\.logging_metadata\\?\\.suggestion_id;` +
    `return ${conversionParameter}\\.item\\.action_metadata\\?\\.task_suggestion_prompt_as_tool&&\\1\\.trim\\(\\)&&\\2\\?` +
    `\\{prompt:\\1,messageMetadata:\\{task_suggestion_tool_prompt_id:\\2\\}\\}:null$`,"u").test(conversion.body);
  return Boolean(state&&fetch&&convertsToolPrompt&&findRspackRequireBinding(module,state.groups.provider)&&findRspackRequireBinding(module,fetch[1])&&
    keyMatch.groups.account!==keyMatch.groups.saved&&writes(query,keyMatch.groups.account).length===1&&writes(query,keyMatch.groups.saved).length===1&&!query.includes("projectId:"));
}
function objectFields(text) {
  try {new Script(`const fields={${text}};`);}catch{return null;}
  const commas=[];
  for(const comma of matches(text,/,/gu)) {
    try {new Script(`const fields={${text.slice(0,comma.index)}};`);commas.push(comma.index);}catch{}
  }
  const fields=new Map();let start=0;
  for(const end of [...commas,text.length]) {
    const member=text.slice(start,end).trim();start=end+1;
    if(!member)continue;
    const head=new RegExp(String.raw`^(${ID}):([\s\S]+)$`,"u").exec(member);
    if(!head||fields.has(head[1]))return null;
    fields.set(head[1],head[2]);
  }
  return fields;
}
function componentProps(fn) {
  if(!new RegExp(`^${ID}$`,"u").test(fn.params))return null;
  const object=one(matches(fn.body,new RegExp(String.raw`\{([^{}]*generatedSuggestionsEnabled:[^{}]*workRunLocation:[^{}]*)\}=${escapeRegExp(fn.params)}(?=[,;])`,"gu")));
  const fields=object&&objectFields(object[1]);
  return fields&&[...fields.values()].every(value=>new RegExp(`^${ID}$`,"u").test(value))?fields:null;
}
function stableProviderBindings(fn, initializers) {
  try {
    const parameters = Array.isArray(fn.params) ? fn.params : [fn.params];
    const key = JSON.stringify(parameters) + "\0" + fn.body;
    let prepared = providerBindingViews.get(key);
    if (prepared) providerBindingViews.delete(key);
    else prepared = prepareBindingAuthority(fn.body, parameters);
    providerBindingViews.set(key, prepared);
    if (providerBindingViews.size > 8) providerBindingViews.delete(providerBindingViews.keys().next().value);
    const declaration = new RegExp(`^let (${ID}(?:,${ID})*)=`, "u").exec(fn.body);
    const bare = new Map();
    let offset = 4;
    for (const name of declaration?.[1].split(",") ?? []) {
      bare.set(name, offset);
      offset += name.length + 1;
    }
    return [...initializers].every(([name, positions]) => {
      const allowed = bare.has(name) ? [bare.get(name), ...positions] : positions;
      return proveBindingAuthority(prepared, name, allowed).stable;
    });
  } catch { return false; }
}

function providerEarlyGuard(module, fn, props) {
  const returns = matches(fn.body, /\breturn\b/gu);
  if (returns.length !== 2 || matches(fn.body, /\bthrow\b/gu).length !== 0) return null;
  const guard = one(matches(fn.body, new RegExp(`\\bif\\((${ID})&&null==(${ID})\\)return null;`, "gu")));
  if (!guard || guard.index + guard[0].indexOf("return") !== returns[0].index) return null;
  const mode = props.get("mode");
  const condition = one(matches(fn.body, new RegExp(
    `(?<![\\w$.])${escapeRegExp(guard[1])}=(${ID})&&\\("chat"===${escapeRegExp(mode)}\\|\\|(${ID})\\)(?=[,;])`, "gu")));
  if (!condition || condition.index >= guard.index) return null;
  const enabled = one(matches(fn.body, new RegExp(
    `(?<![\\w$.])${escapeRegExp(condition[1])}=\\(0,(${ID})\\._U\\)\\((${ID})\\.R0,(${ID})\\)(?=[,;])`, "gu")));
  const preference = one(matches(fn.body, new RegExp(
    `(?<![\\w$.])${escapeRegExp(condition[2])}=\\(0,(${ID})\\.Ul\\)\\((${ID})\\.sy\\)(?=[,;])`, "gu")));
  const conversation = enabled && one(matches(fn.body, new RegExp(
    `(?<![\\w$.])${escapeRegExp(enabled[3])}=\\(0,(${ID})\\.Ul\\)\\((${ID})\\.homeConversationId\\$\\)(?=[,;])`, "gu")));
  const state = one(matches(fn.body, new RegExp(
    `\\[${escapeRegExp(guard[2])},(${ID})\\]=\\(0,(${ID})\\.useState\\)\\(null\\)`, "gu")));
  if (!enabled || !preference || !conversation || !state ||
      ![enabled, preference, conversation, state].every(match => match.index < guard.index)) return null;
  const imports = [[enabled[1], "zTeN"], [preference[1], "zTeN"], [conversation[1], "zTeN"],
    [enabled[2], "yhFA"], [preference[2], "CT62"], [conversation[2], "iLYI"], [state[2], "zd8w"]];
  if (!imports.every(([name, id]) => findRspackRequireBinding(module, name)?.moduleId === id && importedIn(module, fn, name))) return null;
  const assignments = [[guard[1], condition], [condition[1], enabled], [condition[2], preference], [enabled[3], conversation]];
  if (!assignments.every(([name, match]) => bindingWrites(fn.body, name).length === 1 && bindingWrites(fn.body, name)[0] === match.index)) return null;
  const modeAt = fn.body.indexOf(`mode:${mode}`) + "mode:".length;
  if (modeAt < "mode:".length || bindingWrites(fn.body, guard[2]).length !== 0 || bindingWrites(fn.body, mode).length !== 0) return null;
  const initializers = new Map(assignments.map(([name, match]) => [name, [match.index]]));
  initializers.set(guard[2], [state.index + 1]);
  initializers.set(mode, [modeAt]);
  for (const [name] of imports) initializers.set(name, []);
  if (!stableProviderBindings(fn, initializers)) return null;
  return { source: guard[0], condition: condition[0], flag: guard[1], pending: guard[2],
    enabled: condition[1], preference: condition[2], conversation: enabled[3], mode,
    imports: [...new Set(imports.map(([name]) => name))], expression: `${guard[1]}&&null==${guard[2]}` };
}

function returnedProvider(module,fn,call,propsEnd,props) {
  const returned=matches(fn.body,/\breturn\b/gu).at(-1);
  if(!returned)return false;
  const expression=fn.body.slice(returned.index+6).trim().replace(/;$/u,"");
  if(matches(expression,/=>/gu).length)return false;
  const child=one(matches(fn.body.slice(0,call.index),new RegExp(`(?<![\\w$.])(${ID})=${ID}\\|\\|${ID}\\|\\|${ID}\\?$`,"gu")));
  if(!child||call.index>=returned.index)return false;
  const fragments=matches(fn.body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.jsxs\\)\\(\\2\\.Fragment,\\{children:\\[(${ID}(?:,${ID})*)\\]\\}\\)`,"gu"));
  const fragment=one(fragments.filter(match=>match[3].split(",").filter(name=>name===child[1]).length===1));
  if(!fragment||fragment.index<=propsEnd||fragment[3].split(",").length!==2)return false;
  const alias=one(matches(fn.body,new RegExp(`\\blet (${ID})=${escapeRegExp(fragment[1])};`,"gu")));
  const target=props.get("inlineSuggestionsPortalTarget");
  if(!alias||!target||alias.index<=fragment.index||alias.index>=returned.index)return false;
  const portal=one(matches(fn.body,new RegExp(
    `(?<![\\w$.])(${ID})=void 0===${escapeRegExp(target)}\\?${escapeRegExp(alias[1])}:${escapeRegExp(target)}&&\\(0,(${ID})\\.createPortal\\)\\(${escapeRegExp(alias[1])},${escapeRegExp(target)}\\)`,"gu")));
  if(!portal||portal.index<=returned.index||!importedIn(module,fn,portal[2]))return false;
  const final=one(fragments.filter(match=>match[3].split(",").filter(name=>name===portal[1]).length===1));
  if(!final||final.index<=portal.index||final[2]!==fragment[2]||final[3].split(",").length!==3||!importedIn(module,fn,final[2]))return false;
  const memoRecovery=(name,begin,end)=>one(matches(fn.body,new RegExp(
    `(${ID})\\[(\\d+)\\]=${escapeRegExp(name)}\\):${escapeRegExp(name)}=\\1\\[\\2\\]`,"gu"))
    .filter(match=>begin<=match.index&&match.index<end));
  if(!memoRecovery(child[1],propsEnd,fragment.index)||!memoRecovery(fragment[1],fragment.index,alias.index)||
      !memoRecovery(portal[1],portal.index,final.index))return false;
  const result=escapeRegExp(final[1]);
  if(!new RegExp(`,(${ID})\\[(\\d+)\\]=${result}\\):${result}=\\1\\[\\2\\],${result}$`,"u").test(expression))return false;
  const bindings=new Map([[alias[1],[alias.index+"let ".length]]]);
  if(bindingWrites(fn.body,alias[1]).length!==1)return false;
  for(const name of[child[1],fragment[1],portal[1],final[1]]) {
    const positions=bindingWrites(fn.body,name);
    if(positions.length!==2)return false;
    bindings.set(name,positions);
  }
  const targetAt=fn.body.indexOf(`inlineSuggestionsPortalTarget:${target}`)+"inlineSuggestionsPortalTarget:".length;
  if(targetAt<"inlineSuggestionsPortalTarget:".length||bindingWrites(fn.body,target).length!==0)return false;
  bindings.set(target,[targetAt]);
  bindings.set(final[2],[]);bindings.set(portal[2],[]);
  return stableProviderBindings(fn,bindings)?{portalNamespace:portal[2],jsxNamespace:final[2]}:null;
}
// Use the shared lexer to inspect actual root identifier tokens, including
// escaped spellings and comments between a binding and its write operator.
function bindingWrites(body,name) {
  const lexical=createJavaScriptLexicalIndex(body);
  const projection=body.split("").map((character,index)=>lexical.isCode(index)?character:" ").join("");
  const identifiers=/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  const found=[];
  for(const token of projection.matchAll(identifiers)) {
    if(!lexical.isRoot(token.index))continue;
    const decoded=token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
      (_match,braced,fixed)=>String.fromCodePoint(parseInt(braced||fixed,16)));
    if(decoded!==name)continue;
    const before=projection.slice(0,token.index).trimEnd();
    if(/[.#]$/u.test(before))continue;
    const after=projection.slice(token.index+token[0].length);
    if(/^\s*(?:\+\+|--|(?:\?\?|\|\||&&|[+*/%&|^\-])?=(?!=|>))/u.test(after)||
      /(?:\+\+|--)$/u.test(before))found.push(token.index);
  }
  return found;
}
function providerRole(module) {
  const exported=exportGetter(module,"HomeTaskSuggestions"),defs=functions(module.moduleSource),outer=exported&&one(defs.filter(fn=>fn.name===exported.expression));
  if(!outer||!returnedView(outer)||bindingWrites(module.moduleSource,outer.name).length!==0)return null;
  const props=componentProps(outer);if(!props)return null;
  const required=["generatedSuggestionsEnabled","generatedSuggestionsLoading","inlineSuggestionsPortalTarget","hostId","mode","onSelect","projectId","prepareDestination","unifiedModelPickerEnabled","workCloudUsesLocalExecutor","workRunLocation","showGenericSuggestions"];
  if(!required.every(key=>props.has(key)))return null;
  const earlyGuard=providerEarlyGuard(module,outer,props);if(!earlyGuard)return null;
  const innerCall=one(matches(outer.body,new RegExp(String.raw`\(0,(${ID})\.jsx\)\((${ID}),\{explore:`,"gu")));
  const inner=innerCall&&one(defs.filter(fn=>fn.name===innerCall[2]));
  if(!inner||!returnedView(inner)||!importedIn(module,outer,innerCall[1])||bindingWrites(module.moduleSource,inner.name).length!==0)return null;
  const propsStart=innerCall.index+innerCall[0].indexOf("{"),propsEnd=findMatchingBrace(outer.body,propsStart),forwarded=objectFields(outer.body.slice(propsStart+1,propsEnd));
  const view=forwarded&&returnedProvider(module,outer,innerCall,propsEnd,props);
  if(!forwarded||!view)return null;
  const page=one(matches(outer.body,new RegExp(`(?<![\\w$.])(${ID})=void 0===${escapeRegExp(props.get("generatedSuggestionsEnabled"))}\\|\\|${escapeRegExp(props.get("generatedSuggestionsEnabled"))}`,"gu")));
  const generic=one(matches(outer.body,new RegExp(`(?<![\\w$.])(${ID})=void 0===${escapeRegExp(props.get("showGenericSuggestions"))}\\|\\|${escapeRegExp(props.get("showGenericSuggestions"))}`,"gu")));
  const unified=one(matches(outer.body,new RegExp(`(?<![\\w$.])(${ID})=void 0!==${escapeRegExp(props.get("unifiedModelPickerEnabled"))}&&${escapeRegExp(props.get("unifiedModelPickerEnabled"))}`,"gu")));
  const cloudExecutor=one(matches(outer.body,new RegExp(`(?<![\\w$.])(${ID})=void 0!==${escapeRegExp(props.get("workCloudUsesLocalExecutor"))}&&${escapeRegExp(props.get("workCloudUsesLocalExecutor"))}`,"gu")));
  if(!page||!generic||!unified||!cloudExecutor||forwarded.get("workCloudUsesLocalExecutor")!==cloudExecutor[1]||bindingWrites(outer.body,cloudExecutor[1]).length!==1)return null;
  const cloudInput=props.get("workCloudUsesLocalExecutor"),cloudAt=outer.body.indexOf(`workCloudUsesLocalExecutor:${cloudInput}`)+"workCloudUsesLocalExecutor:".length;
  if(cloudAt<"workCloudUsesLocalExecutor:".length||!stableProviderBindings(outer,new Map([[cloudExecutor[1],[cloudExecutor.index]],[cloudInput,[cloudAt]]])))return null;
  const eligibility=new RegExp(`^!(${ID})&&${escapeRegExp(generic[1])}&&${escapeRegExp(page[1])}&&!(${ID})$`,"u").exec(forwarded.get("generatedSuggestionsEnabled")??"");
  if(!eligibility||forwarded.get("clinicalStartersTakePriority")!==eligibility[2])return null;
  for(const key of ["hostId","mode","projectId","prepareDestination","workRunLocation"])if(forwarded.get(key)!==props.get(key))return null;
  if(forwarded.get("onSelect")!==`${eligibility[1]}||!${unified[1]}?${props.get("onSelect")}:void 0`||!new RegExp(`^${ID}$`,"u").test(forwarded.get("onStartConversation")??""))return null;
  const fieldMap=componentProps(inner),fieldKeys=["generatedSuggestionsEnabled","fileSuggestionsEnabled","hostId","mode","onSelect","projectId","prepareDestination","workCloudUsesLocalExecutor","workRunLocation","onStartConversation"];
  if(!fieldMap||!fieldKeys.every(key=>fieldMap.has(key)))return null;
  const fields=[null,fieldMap.get("generatedSuggestionsEnabled"),fieldMap.get("fileSuggestionsEnabled"),fieldMap.get("hostId"),fieldMap.get("mode"),fieldMap.get("onSelect"),fieldMap.get("projectId")];
  const args=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=\\{hostId:${escapeRegExp(fields[3])},mode:${escapeRegExp(fields[4])},supportsHomeFeed:(${ID})\\}`,"gu")));
  const query=args&&one(matches(inner.body,new RegExp(`\\(0,(${ID})\\._U\\)\\((${ID})\\.(${ID}),${escapeRegExp(args[1])},(\\{enabled:(${ID})\\})\\)`,"gu")));
  if(!query||!findRspackRequireBinding(module,query[1])||!findRspackRequireBinding(module,query[2]))return null;
  const setting=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.${ID}\\)\\((${ID})\\.${ID}\\)`,"gu")).filter(m=>inner.body.includes(`"enabled"===${m[1]}.status`)));
  if(!setting||!findRspackRequireBinding(module,setting[2])||!findRspackRequireBinding(module,setting[3]))return null;
  const eligibilityAlias=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=${escapeRegExp(fields[1])}&&(${ID})(?=[,;])`,"gu")));
  const runtime=eligibilityAlias&&one(matches(inner.body,new RegExp(`(?<![\\w$.])(?<policy>${ID})=!(?<hidden>${ID})&&!(?<disabled>${ID})&&\\((?<external>${ID})\\?(?<externalValue>${ID}):(?<native>${ID})&&${escapeRegExp(eligibilityAlias[1])}&&"enabled"===${escapeRegExp(setting[1])}\\.status&&\\((?<typed>${ID})\\|\\|${escapeRegExp(fields[2])}&&(?<hasFiles>${ID})\\)\\)`,"gu")));
  const queryEnabled=runtime&&one(matches(inner.body,new RegExp(`${escapeRegExp(query[5])}=!${escapeRegExp(runtime.groups.external)}&&\\(${escapeRegExp(runtime[1])}\\|\\|(?<fallback>${ID})\\)&&null!=(?<account>${ID})&&\\("chat"!==${escapeRegExp(fields[4])}\\|\\|!(?<loading>${ID})\\)`,"gu")));
  if(!runtime||!queryEnabled||eligibilityAlias.index>=runtime.index||bindingWrites(inner.body,eligibilityAlias[1]).length!==1)return null;
  const generatedAt=inner.body.indexOf(`generatedSuggestionsEnabled:${fields[1]}`)+"generatedSuggestionsEnabled:".length;
  const preferenceWrites=bindingWrites(inner.body,eligibilityAlias[2]);
  const preference=one(matches(inner.body,new RegExp(`(?<![\\w$.])${escapeRegExp(eligibilityAlias[2])}=\\(0,(${ID})\\.iK\\)\\((${ID})\\.${ID}\\.enabled\\)`,"gu")));
  if(generatedAt<"generatedSuggestionsEnabled:".length||preferenceWrites.length!==1||
      !preference||![preference[1],preference[2]].every(name=>importedIn(module,inner,name))||
      !stableProviderBindings(inner,new Map([[eligibilityAlias[1],[eligibilityAlias.index]],[fields[1],[generatedAt]],[eligibilityAlias[2],preferenceWrites]])))return null;
  const aliases=one(matches(inner.body,new RegExp(`(?:let |,)(${ID})=(${ID})(?=[,;])`,"gu")).filter(m=>inner.body.includes(`onClick:()=>${m[1]}(`)));
  const action=aliases&&one(matches(inner.body,new RegExp(`(?<![\\w$.])${escapeRegExp(aliases[2])}=\\((${ID}),(${ID}),(${ID})\\)=>\\{`,"gu")));
  if(!action||bindingWrites(inner.body,aliases[1]).length!==1)return null;
  const actionOpen=action.index+action[0].length-1,actionEnd=findMatchingBrace(inner.body,actionOpen),actionBody=inner.body.slice(actionOpen+1,actionEnd);
  const actionWrites=bindingWrites(inner.body,aliases[2]);
  if(actionWrites[0]!==action.index)return null;
  if(actionWrites.length!==1) {
    const callback=escapeRegExp(aliases[2]),alias=escapeRegExp(aliases[1]);
    const memo=one(matches(inner.body,new RegExp(
      `(?<cache>${ID})\\[(?<slot>\\d+)\\]=${callback}\\):${callback}=\\k<cache>\\[\\k<slot>\\];let ${alias}=${callback}(?=[,;])`,"gu")));
    if(actionWrites.length!==2||!memo||inner.body.slice(0,action.index).slice(-2)!=="?("||
      actionWrites[1]!==memo.index+memo[0].indexOf(`:${aliases[2]}=`)+1)return null;
  }
  if(!stableProviderBindings(inner,new Map([[aliases[2],actionWrites],[aliases[1],bindingWrites(inner.body,aliases[1])]])))return null;
  const input=one(matches(actionBody,new RegExp(`^let\\{connected:(${ID}),quickAction:(${ID})\\}=void 0===${escapeRegExp(action[3])}\\?\\{\\}:${escapeRegExp(action[3])}`,"gu")));
  if(!input)return null;
  const prompt=one(matches(actionBody,new RegExp(`(?<![\\w$.])(${ID})=${escapeRegExp(input[2])}\\?\\.prompt\\?\\?${escapeRegExp(action[1])}\\.prompt`,"gu")));
  const target=one(matches(actionBody,new RegExp(`let (${ID})=(${ID})\\?\\.type==="prompt"\\?\\2\\.entrypoint\\?\\?${escapeRegExp(fields[4])}:${escapeRegExp(fields[4])};`,"gu"),false));
  const auto=target&&one(matches(actionBody,new RegExp(`let (${ID})=${escapeRegExp(target[2])}\\?\\.type==="prompt"&&!0===${escapeRegExp(target[2])}\\.auto_send;`,"gu"),false));
  const preparation=target&&one(matches(actionBody,new RegExp(`(${ID})=${escapeRegExp(fields[5])}\\?\\.\\(${escapeRegExp(target[1])}\\);if\\(null!=\\1&&await \\1,`,"gu"),false));
  const editor=one(matches(inner.body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.a\\$\\)\\(\\)`,"gu")).filter(m=>actionBody.includes(`${m[1]}.setPromptText(`)));
  if(!prompt||!auto||!preparation||!editor||!findRspackRequireBinding(module,editor[2]))return null;
  const cloud=one(matches(actionBody,new RegExp(
    `(?<![\\w$.])(?<account>${ID})=(?<scope>${ID})\\.get\\((?<authNamespace>${ID})\\.chatGptAuthenticatedUserId\\$\\),` +
    `(?<metadata>${ID})=null==\\k<account>\\|\\|null!=${escapeRegExp(input[2])}\\|\\|${escapeRegExp(target[2])}\\?\\.type!=="prompt"\\|\\|` +
    `\\(${escapeRegExp(target[2])}\\.entrypoint\\?\\?${escapeRegExp(fields[4])}\\)!=="work"\\|\\|${escapeRegExp(fieldMap.get("workCloudUsesLocalExecutor"))}\\|\\|"cloud"!==${escapeRegExp(fieldMap.get("workRunLocation"))}` +
    `\\?null:\\(0,${escapeRegExp(query[2])}\\.se\\)\\(${escapeRegExp(action[1])}\\),` +
    `(?<prompt>${ID})=\\k<metadata>\\?\\.prompt\\?\\?${escapeRegExp(prompt[1])}(?=[,;])`,"gu")));
  if(!cloud||!findRspackRequireBinding(module,cloud.groups.authNamespace))return null;
  const setter=one(matches(actionBody,new RegExp(`\\(0,(${ID})\\.flushSync\\)\\(\\(\\)=>\\{${escapeRegExp(editor[1])}\\.setPromptText\\(${escapeRegExp(cloud.groups.prompt)},\\{preserveLibraryFileMentions:${escapeRegExp(fields[2])}\\}\\)`,"gu"),false));
  if(!setter||!findRspackRequireBinding(module,setter[1])||!new RegExp(`\\}\\),${ID}\\(\\),${escapeRegExp(editor[1])}\\.focus\\(\\),${escapeRegExp(auto[1])}`,"u").test(actionBody))return null;
  const metadata=one(matches(actionBody,new RegExp(
    `${escapeRegExp(cloud.groups.metadata)}&&null!=${escapeRegExp(cloud.groups.account)}&&${escapeRegExp(cloud.groups.scope)}\\.set\\((?<namespace>${ID})\\.V,(?<conversation>${ID}),` +
    `\\{accountId:${escapeRegExp(queryEnabled.groups.account)},userId:${escapeRegExp(cloud.groups.account)},prompt:${escapeRegExp(cloud.groups.metadata)}\\.prompt,` +
    `messageMetadata:${escapeRegExp(cloud.groups.metadata)}\\.messageMetadata,taskSuggestionDocument:${escapeRegExp(editor[1])}\\.view\\.state\\.doc\\}\\)`,"gu"),false));
  if(!metadata||!findRspackRequireBinding(module,metadata.groups.namespace))return null;
  if(![query[1],query[2],setting[2],setting[3],editor[2],setter[1]].every(name=>importedIn(module,inner,name)))return null;
  const declarations=new Map([[outer.name,[outer.start+"function ".length]],[inner.name,[inner.start+"function ".length]]]);
  const criticalImports=[...new Set([...earlyGuard.imports,view.portalNamespace,view.jsxNamespace,innerCall[1],
    query[1],query[2],setting[2],setting[3],preference[1],preference[2],editor[2],setter[1],cloud.groups.authNamespace,metadata.groups.namespace])];
  const factoryImports=matches(module.moduleSource,new RegExp(`(?<![\\w$.])(${ID})=${escapeRegExp(module.params[2])}\\("[^"\\n]+"\\)`,"gu")).map(match=>match[1]);
  if(!criticalImports.every(name=>factoryImports.includes(name)))return null;
  for(const name of factoryImports) {
    const binding=findRspackRequireBinding(module,name);
    if(!binding)return null;
    declarations.set(name,[binding.start-module.start]);
  }
  if(!stableProviderBindings({body:module.moduleSource,params:module.params},declarations))return null;
  return {outer:outer.name,inner:inner.name,earlyGuard,criticalImports,factoryImports,view,
    query:{moduleId:findRspackRequireBinding(module,query[2]).moduleId,exportName:query[3],readNamespace:query[1],namespace:query[2],args:args[1],options:query[4],source:query[0]},
    policy:{...runtime.groups,generated:fields[1],files:fields[2],preference:eligibilityAlias[2],eligibility:eligibilityAlias[1],eligibilityExpression:`${fields[1]}&&${eligibilityAlias[2]}`,status:setting[1],source:runtime[0],expression:runtime[0].slice(runtime[1].length+1)},
    queryEnabled:{...queryEnabled.groups,source:queryEnabled[0],expression:queryEnabled[0].slice(query[5].length+1)},
    selection:{callback:aliases[2],alias:aliases[1],source:actionBody,item:action[1],index:action[2],options:action[3],prompt:cloud.groups.prompt,originalPrompt:prompt[1],mode:target[1],destination:target[2],prepared:preparation[1],editor:editor[1],flushNamespace:setter[1],autoSend:auto[1],cloud:{...cloud.groups,source:cloud[0],metadataSource:metadata[0]}},
    fields:{host:fields[3],mode:fields[4],selection:fields[5],project:fields[6],prepareDestination:fieldMap.get("prepareDestination"),workCloudUsesLocalExecutor:fieldMap.get("workCloudUsesLocalExecutor"),workRunLocation:fieldMap.get("workRunLocation")}};
}

function shellRole(module,pageId) {
  const body=module.moduleSource,req=module.params?.[2];if(!req)return null;
  const lazy=one(matches(body,new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.${ID}\\)\\(async\\(\\)=>\\(await Promise\\.all\\(\\[(?:${escapeRegExp(req)}\\.e\\(\\d+\\),)*${escapeRegExp(req)}\\.e\\(\\d+\\)\\]\\)\\.then\\(${escapeRegExp(req)}\\.bind\\(${escapeRegExp(req)},${escapeRegExp(JSON.stringify(pageId))}\\)\\)\\)\\.ChatGptWorkHomePage\\)`,"gu")));
  const exported=exportGetter(module,"Z"),entry=exported&&one(functions(body,exported.expression));
  if(!lazy||!entry||!liveFunction(entry)||!returnedView(entry)||!findRspackRequireBinding(module,lazy[2])||writes(body,lazy[1]).length!==1)return null;
  const forwarded=one(matches(entry.body,new RegExp(`\\(0,${ID}\\.jsx\\)\\(${escapeRegExp(lazy[1])},\\{hideHeaderUpgrade:!1,onTaskSuggestionSelected:(${ID})\\.onChatGptTaskSuggestionSelected\\}\\)`,"gu"),false));
  return forwarded?{entry:entry.name,lazy:lazy[1]}:null;
}
function preparationEntryRole(module,entry) {
  const exits=matches(entry.body,/\breturn\b/gu),guard=one(matches(entry.body,new RegExp(`if\\((?<value>${ID})\\)return null;`,"gu")));
  if(!guard||exits.length!==2||exits[0].index!==guard.index+guard[0].indexOf("return")||matches(entry.body,/\bthrow\b/gu).length!==0)return false;
  const read=one(matches(entry.body,new RegExp(`(?<![\\w$.])${escapeRegExp(guard.groups.value)}=\\(0,(?<hook>${ID})\\.Ul\\)\\((?<state>${ID})\\.${ID}\\)`,"gu")));
  if(!read||read.index>=guard.index||writes(entry.body,guard.groups.value).length!==1)return false;
  return[read.groups.hook,read.groups.state].every(name=>importedIn(module,entry,name));
}
function preparationRole(module,shellId) {
  const exported=exportGetter(module,"HomeComposerRoute"),defs=functions(module.moduleSource),entry=exported&&one(defs.filter(fn=>fn.name===exported.expression));
  if(!entry||!preparationEntryRole(module,entry)||!returnedView(entry))return null;
  const candidates=[];
  for(const fn of defs) {
    if(!returnedView(fn))continue;
    const props=one(matches(fn.body,new RegExp(`canSwitchMode:(${ID}),showPendingModeToggle:${ID},unifiedModelPickerEnabled:(${ID}),workspaceAgent:${ID},mode:(${ID}),routeProjectId:${ID},preservePendingInput:${ID},workModeAllowed:(${ID}),workModeLoading:${ID},workModeUpgradePlan:${ID},onModeChange:${ID}\\}=${escapeRegExp(fn.params)}`,"gu"),false));
    const input=one(matches(fn.body,new RegExp(`\\{([^{}]*submitOptions:[^{}]*onModeChange:[^{}]*)\\}=${escapeRegExp(fn.params)}(?=[,;])`,"gu")));
    const inputFields=input&&objectFields(input[1]),submitOptions=inputFields?.get("submitOptions");
    if(!props||!new RegExp(`^${ID}$`,"u").test(submitOptions??""))continue;
    const callback=one(matches(fn.body,new RegExp(`(?<![\\w$.])(${ID})=${escapeRegExp(props[4])}\\?(${ID})=>\\{if\\(\\2!==${escapeRegExp(props[3])}\\)\\{if\\(!${escapeRegExp(props[1])}\\)throw Error\\("Suggestion destination is unavailable"\\);if\\(${escapeRegExp(props[2])}\\)\\{if\\("chat"!==\\2\\)throw Error\\("Suggestion destination is unavailable"\\);return\\(0,(${ID})\\.(${ID})\\)\\((${ID}),\\5\\.get\\((${ID})\\.${ID},null\\),(${ID})\\)\\.then\\((${ID})\\)\\}(${ID})\\(\\2,void 0,"task_suggestion"\\)\\}\\}:void 0`,"gu")));
    if(!callback||!findRspackRequireBinding(module,callback[3])||!findRspackRequireBinding(module,callback[6]))continue;
    const no=one(functions(module.moduleSource,callback[7])),assert=one(functions(module.moduleSource,callback[8]));
    if(!no||no.body!=="return!1"||!assert||assert.body!==`if(!${assert.params})throw Error("Suggestion destination is unavailable")`)continue;
    const forwarded=one(matches(fn.body,new RegExp(`\\(0,${ID}\\.jsx\\)\\((${ID})\\.Z,\\{submitOptions:${escapeRegExp(submitOptions)},preservePendingInput:${ID},workspaceAgent:${ID},homeComposerController:${ID},homeComposerMode:${escapeRegExp(props[3])},unifiedModelPickerEnabled:${escapeRegExp(props[2])},homeComposerModeToggle:${ID},onTemporaryChatToggle:${ID},taskSuggestionsLoading:${ID},onChatGptTaskSuggestionSelected:${escapeRegExp(callback[1])},projectId:${ID}\\}\\)`,"gu")));
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
    if(!info||central.suggestedPromptsWorkPageContract(copy.moduleSource,copy)==="drifted")throw Error("Incomplete Work Home page contract");
    validateDependencies(assetsDir,info,cache,entry.entryId);
  }
  return patchRspackModuleCopies(assetsDir,copies,(body,copy)=>{
    const patched=central.applySuggestedPromptsWorkPagePatch(body,copy);
    if(central.suggestedPromptsWorkPageContract(patched,copy)!=="patched")throw Error("Work Home page poststate failed");return patched;
  });
}
module.exports={applyToExtractedApp,inspectPage,inspectModule,isCandidate,validateDependencies,providerRole,queryRole,valueExport,shellRole,preparationRole};
