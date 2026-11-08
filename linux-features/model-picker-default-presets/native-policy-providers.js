"use strict";
const {Script}=require("node:vm");
const {assertUnambiguousModelComposerLexicalSource:assertLexical}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackRequireBinding}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const ID="[A-Za-z_$][\\w$]*";
function one(values,label){if(values.length!==1)throw Error(`Missing or ambiguous native preset ${label}`);return values[0];}
function frame(source,snapshot,authority){
 if(typeof source!=="string"||Buffer.byteLength(source)>256*1024||typeof authority?.requireStableBinding!=="function"||!Array.isArray(snapshot?.params)||snapshot.params.length!==3||new Set(snapshot.params).size!==3||snapshot.params.some(name=>!new RegExp(`^${ID}$`,"u").test(name)))throw Error("Invalid native preset provider input");
 try{new Script(`"use strict";(function(${snapshot.params.join(",")}){${source}})`);}catch{throw Error("Invalid native preset provider syntax");}
 const module={...snapshot,start:snapshot.start??0,moduleSource:source},lexical=createJavaScriptLexicalIndex(source);
 assertLexical(source,lexical);
 for(const name of module.params.slice(1))authority.requireStableBinding(source,name);
 const hits=expression=>[...source.matchAll(expression)].filter(hit=>lexical.isRoot(hit.index));
 function imported(name){const binding=findRspackRequireBinding(module,name);if(!binding||module.params.includes(name))throw Error(`Invalid native preset provider import ${name}`);authority.requireStableBinding(source,name,binding.start-module.start);return{localName:name,moduleId:binding.moduleId};}
 function stable(name,at){authority.requireStableBinding(source,name,at);}
 function publicationFor(expression){const keys=[...source.matchAll(new RegExp(`(?<key>${ID}):(?:\\(\\)=>|function\\(|async function\\(|${ID})`,"gu"))].filter(hit=>lexical.isCode(hit.index)).map(hit=>hit.groups.key);return one([...new Set(keys)].flatMap(key=>{const pub=findRspackExportPublication(module,key);return pub?.expression===expression?[{key,...pub}]:[];}),"provider publication");}
 function rootFunction(name){const hit=one(hits(new RegExp(`\\bfunction ${escapeRegExp(name)}\\((?<params>[^)]*)\\)\\{`,"gu")),"provider function"),open=hit.index+hit[0].length-1,end=lexical.matchingBrace(open);if(end<open)throw Error("Incomplete native preset provider function");stable(name,hit.index+"function ".length);return{name,params:hit.groups.params,start:hit.index,end:end+1,body:source.slice(open+1,end)};}
 return{source,module,lexical,hits,imported,stable,publicationFor,rootFunction};
}
function distinct(names,label){if(new Set(names).size!==names.length)throw Error(`Aliased native preset ${label}`);}
function noShadow(locals,captured,label){if(locals.some(name=>captured.includes(name)))throw Error(`Shadowed native preset ${label}`);}

function inspectVisibilityProvider(source,snapshot,authority){
 if(typeof source!=="string"||![".data?.reasoningEffortVisibility?.enabled",".enabledReasoningEfforts","new Set("].every(needle=>source.includes(needle)))throw Error("Missing native visibility provider");
 const f=frame(source,snapshot,authority);
 const raw=one(f.hits(new RegExp(String.raw`(?<name>${ID})=\(0,(?<framework>${ID})\.(?<derived>${ID})\)\((?<scope>${ID})\.(?<scopeExport>${ID}),\(\{get:(?<get>${ID})\}\)=>\k<get>\((?<preferences>${ID})\.(?<queryExport>${ID})\)\.data\?\.reasoningEffortVisibility\?\.enabled\)`,"gu")),"raw visibility atom"),r=raw.groups;
 const effective=one(f.hits(new RegExp(String.raw`(?<name>${ID})=\(0,${escapeRegExp(r.framework)}\.${escapeRegExp(r.derived)}\)\(${escapeRegExp(r.scope)}\.${escapeRegExp(r.scopeExport)},\(\{get:(?<get>${ID})\}\)=>null!=\k<get>\(${escapeRegExp(r.preferences)}\.(?<accountExport>${ID})\)&&null!=\k<get>\((?<identity>${ID})\.(?<userExport>${ID})\)\?new Set\(\k<get>\(${escapeRegExp(r.name)}\)\?\?(?<defaults>${ID})\):new Set\(\(0,(?<local>${ID})\.(?<localExport>${ID})\)\(\k<get>,(?<config>${ID})\.(?<configExport>${ID})\.enabledReasoningEfforts\)\)\)`,"gu")),"effective visibility atom"),g=effective.groups;
 const json='"(?:\\\\.|[^"\\\\])*"',values=one(f.hits(new RegExp(`(?<![\\w$.])${escapeRegExp(g.defaults)}=(?<array>\\[(?:${json}(?:,${json})*)?\\])(?=[,;])`,"gu")),"native default effort list");
 const defaults=JSON.parse(values.groups.array);if(!defaults.every(value=>typeof value==="string"))throw Error("Invalid native default efforts");
 if(g.userExport!=="chatGptAuthenticatedUserId$")throw Error("Visibility provider does not use authenticated user identity");
 const names=[r.framework,r.scope,r.preferences,g.identity,g.local,g.config];distinct(names,"visibility imports");distinct([r.name,g.name,g.defaults],"visibility atoms");
 noShadow([r.get],[r.preferences],"raw visibility reader");noShadow([g.get],[r.preferences,g.identity,r.name,g.defaults,g.local,g.config,"Set"],"effective visibility reader");
 if(f.module.params.includes("Set"))throw Error("Shadowed native visibility Set");authority.requireStableBinding(source,"Set");
 const imports=names.map(f.imported),byName=name=>imports.find(binding=>binding.localName===name);
 f.stable(r.name,raw.index);f.stable(g.name,effective.index);f.stable(g.defaults,values.index);
 const published=f.publicationFor(g.name),rawPublished=f.publicationFor(r.name);
 return{kind:"visibility",moduleId:snapshot.moduleId,exportName:published.key,rawExportName:rawPublished.key,scope:{moduleId:byName(r.scope).moduleId,exportName:r.scopeExport},frameworkModuleId:byName(r.framework).moduleId,identityModuleId:byName(g.identity).moduleId,settingsModuleId:byName(r.preferences).moduleId,proof:{defaultEfforts:defaults,authenticatedUserExport:g.userExport,accountPresenceExport:g.accountExport,preferencesQueryExport:r.queryExport,effectiveSource:effective[0],rawSource:raw[0]}};
}

function inspectWorkspaceClampProvider(source,snapshot,authority){
 if(typeof source!=="string"||![".modelConfigBySlug?.[",".thinkingEfforts",".sliderSettings?.flatMap(","thinkingEffort:null",".options.indexOf("].every(needle=>source.includes(needle)))throw Error("Missing native workspace clamp provider");
 const f=frame(source,snapshot,authority),candidates=[];
 const keys=[...new Set([...source.matchAll(new RegExp(`(?<key>${ID}):function\\(`,"gu"))].filter(hit=>f.lexical.isCode(hit.index)).map(hit=>hit.groups.key))];
 for(const key of keys){const publication=findRspackExportPublication(f.module,key);if(!publication?.fn)continue;const fn=publication.fn;
 const params=new RegExp(`^(?<plan>${ID}),(?<catalog>${ID}),(?<slug>${ID}),(?<effort>${ID})$`,"u").exec(fn.params)?.groups;if(!params)continue;
 const p=Object.fromEntries(Object.entries(params).map(([key,value])=>[key,escapeRegExp(value)]));
 const pattern=new RegExp(String.raw`^if\(!\(0,(?<planModule>${ID})\.(?<planExport>${ID})\)\(${p.plan}\)\|\|null==${p.effort}\|\|null==${p.catalog}\)return;let (?<metadata>${ID})=${p.catalog}\.modelConfigBySlug\?\.\[${p.slug}\]\?\.thinkingEfforts,(?<allowed>${ID})=\k<metadata>\?\.map\((?<entry>${ID})=>\k<entry>\.thinking_effort\)\?\?\[\.\.\.\(0,(?<catalogModule>${ID})\.(?<collectorExport>${ID})\)\(${p.catalog}\)\.flatMap\((?<option>${ID})=>\k<option>\.slug===${p.slug}&&!1!==\k<option>\.isAvailable&&null!=\k<option>\.thinkingEffort\?\[\k<option>\.thinkingEffort\]:\[\]\),\.\.\.${p.catalog}\.sliderSettings\?\.flatMap\((?<slider>${ID})=>\k<slider>\.modelSlug===${p.slug}\?\[\k<slider>\.thinkingEffort\]:\[\]\)\?\?\[\]\];if\(null==\k<metadata>&&0===\k<allowed>\.length\)return;let (?<parsed>${ID})=\k<catalogModule>\.(?<schemaExport>${ID})\.safeParse\(${p.effort}\)\.data;if\(null==\k<parsed>\)return\{thinkingEffort:null\};let (?<rank>${ID})=(?<rankInput>${ID})=>(?<enumModule>${ID})\.(?<enumExport>${ID})\.options\.indexOf\((?<namesModule>${ID})\.(?<namesExport>${ID})\[\k<rankInput>\]\),(?<request>${ID})=\k<rank>\(\k<parsed>\),(?<best>${ID})=null;for\(let (?<item>${ID}) of \k<allowed>\)\k<rank>\(\k<item>\)<=\k<request>&&\(null==\k<best>\|\|\k<rank>\(\k<item>\)>\k<rank>\(\k<best>\)\)&&\(\k<best>=\k<item>\);return\{thinkingEffort:\k<best>\}$`,"u");
 const match=pattern.exec(fn.body);if(!match)continue;const g=match.groups;
 distinct(Object.values(params),"workspace parameters");distinct([g.planModule,g.catalogModule,g.enumModule,g.namesModule],"workspace imports");const locals=[g.metadata,g.allowed,g.parsed,g.rank,g.request,g.best];distinct(locals,"workspace locals");noShadow([...Object.values(params),...locals],[g.planModule,g.catalogModule,g.enumModule,g.namesModule],"workspace imports");noShadow(locals,Object.values(params),"workspace parameters");noShadow([g.option,g.slider],[params.slug],"workspace model predicate");noShadow([g.rankInput],[g.enumModule,g.namesModule],"workspace effort map");noShadow([g.item],[g.allowed,g.rank,g.request,g.best],"workspace ranking loop");
 const imported=[g.planModule,g.catalogModule,g.enumModule,g.namesModule].map(f.imported),get=name=>imported.find(binding=>binding.localName===name).moduleId;
 for(const name of Object.values(params))authority.requireStableBinding(fn.body,name);
 candidates.push({kind:"workspace",moduleId:snapshot.moduleId,exportName:key,catalogModuleId:get(g.catalogModule),planPredicate:{moduleId:get(g.planModule),exportName:g.planExport},effortEnum:{moduleId:get(g.enumModule),exportName:g.enumExport},effortNames:{moduleId:get(g.namesModule),exportName:g.namesExport},proof:{collectorExport:g.collectorExport,schemaExport:g.schemaExport,parameters:params,nativeFunction:source.slice(fn.start,fn.end),emptyCapabilityIsDistinct:true,workspacePlanGatePreserved:true}});
 }
 return one(candidates,"workspace clamp publication");
}

function inspectPlanProvider(source,snapshot,authority){
 if(typeof source!=="string"||!["chatGptAuthenticatedAccountId$","chatGptAuthenticatedUserId$",".targetingAccount.planType",".hasChatGptToken"].every(needle=>source.includes(needle)))throw Error("Missing native plan provider");
 const f=frame(source,snapshot,authority),account=findRspackExportPublication(f.module,"chatGptAuthenticatedAccountId$"),user=findRspackExportPublication(f.module,"chatGptAuthenticatedUserId$");
 const accountRef=new RegExp(`^(?<namespace>${ID})\\.(?<key>${ID})$`,"u").exec(account?.expression??"")?.groups,userRef=new RegExp(`^(?<namespace>${ID})\\.(?<key>${ID})$`,"u").exec(user?.expression??"")?.groups;
 if(!accountRef||!userRef||accountRef.namespace!==userRef.namespace)throw Error("Missing native authenticated identity publications");
 const candidates=[];
 for(const hit of f.hits(new RegExp(String.raw`(?<name>${ID})=\(0,(?<framework>${ID})\.(?<derived>${ID})\)\((?<scope>${ID})\.(?<scopeExport>${ID}),\(\{get:(?<get>${ID})\}\)=>\{`,"gu"))){const open=hit.index+hit[0].length-1,end=f.lexical.matchingBrace(open);if(end<open)continue;const body=source.slice(open+1,end),h=hit.groups;
 const pattern=new RegExp(String.raw`^let (?<auth>${ID})=${escapeRegExp(h.get)}\(${escapeRegExp(accountRef.namespace)}\.(?<authExport>${ID})\);if\("chatgpt"!==\k<auth>\.authMethod\|\|!\k<auth>\.hasChatGptToken\|\|null==\k<auth>\.authenticatedAccountId\)return null;if\(\k<auth>\.accountId===\k<auth>\.authenticatedAccountId\)return \k<auth>\.plan;if\(null!=\k<auth>\.accountId\)return null;let (?<fallback>${ID})=${escapeRegExp(h.get)}\((?<fallbackAtom>${ID})\);return null==\k<fallback>\?null:\(\k<fallback>\.targetingAccount\?\.id===\k<fallback>\.accountId\?\k<fallback>\.targetingAccount\.planType:void 0\)\?\?\("unknown"===\k<fallback>\.planType\?null:\k<fallback>\.planType\)$`,"u");
 const found=pattern.exec(body);if(!found)continue;const g=found.groups;
 distinct([h.framework,h.scope,accountRef.namespace],"plan imports");distinct([h.get,g.auth,g.fallback],"plan local roles");noShadow([h.get,g.auth,g.fallback],[accountRef.namespace,g.fallbackAtom],"plan captures");
 const fallback=one(f.hits(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(g.fallbackAtom)}=\(0,${escapeRegExp(h.framework)}\.${escapeRegExp(h.derived)}\)\(${escapeRegExp(h.scope)}\.${escapeRegExp(h.scopeExport)},\(\{get:(?<get>${ID})\}\)=>(?<match>${ID})\(\k<get>\(${escapeRegExp(accountRef.namespace)}\.(?<stored>${ID})\),\k<get>\(${escapeRegExp(accountRef.namespace)}\.${escapeRegExp(g.authExport)}\)\)\)`,"gu")),"plan fallback atom");
 noShadow([fallback.groups.get],[fallback.groups.match,accountRef.namespace],"plan fallback captures");
 const matcher=f.rootFunction(fallback.groups.match),mp=new RegExp(`^(?<cached>${ID}),(?<current>${ID})$`,"u").exec(matcher.params)?.groups;if(!mp||mp.cached===mp.current)throw Error("Invalid native cached-identity matcher");
 const ce=escapeRegExp(mp.cached),cu=escapeRegExp(mp.current),matchPattern=new RegExp(String.raw`^return null!=${ce}&&"chatgpt"===${cu}\.authMethod&&${cu}\.hasChatGptToken&&${cu}\.authenticatedAccountId===${ce}\.accountId&&${cu}\.authenticatedUserId===${ce}\.userId&&${cu}\.userId===${ce}\.userId\?${ce}:null$`,"u");if(!matchPattern.test(matcher.body))throw Error("Drifted native cached-identity matcher");
 for(const name of Object.values(mp))authority.requireStableBinding(matcher.body,name);
 const preferred=one(f.hits(new RegExp(String.raw`(?<name>${ID})=\(0,${escapeRegExp(h.framework)}\.${escapeRegExp(h.derived)}\)\(${escapeRegExp(h.scope)}\.${escapeRegExp(h.scopeExport)},\(\{get:(?<get>${ID})\}\)=>\k<get>\(${escapeRegExp(accountRef.namespace)}\.${escapeRegExp(g.authExport)}\)\.authenticatedUserId\?\?null\)`,"gu")),"native preferred user atom");
 noShadow([preferred.groups.get],[accountRef.namespace],"preferred identity reader");
 const imports=[h.framework,h.scope,accountRef.namespace].map(f.imported),byName=name=>imports.find(binding=>binding.localName===name);
 f.stable(h.name,hit.index);f.stable(g.fallbackAtom,fallback.index);f.stable(preferred.groups.name,preferred.index);
 const pub=f.publicationFor(h.name),preferredPub=f.publicationFor(preferred.groups.name);
 candidates.push({kind:"plan",moduleId:snapshot.moduleId,exportName:pub.key,accountExport:"chatGptAuthenticatedAccountId$",userExport:"chatGptAuthenticatedUserId$",preferredUserExport:preferredPub.key,scope:{moduleId:byName(h.scope).moduleId,exportName:h.scopeExport},frameworkModuleId:byName(h.framework).moduleId,proof:{identityModuleId:byName(accountRef.namespace).moduleId,identityExport:g.authExport,accountIdentityExport:accountRef.key,userIdentityExport:userRef.key,preferredSource:preferred[0],nativePlanBody:body,cacheMatcher:matcher.body,tokenAndAccountMismatchPreserved:true}});
 }
 return one(candidates,"plan signal");
}
function inspectCacheProvider(source,snapshot,authority){
 if(typeof source!=="string"||![".has(",".get(",".set(","typeof window","new Map"].every(needle=>source.includes(needle)))throw Error("Missing native model cache provider");
 const f=frame(source,snapshot,authority),keys=[...new Set([...source.matchAll(new RegExp(`(?<key>${ID}):function\\(`,"gu"))].filter(hit=>f.lexical.isCode(hit.index)).map(hit=>hit.groups.key))],reads=[],writes=[];
 for(const key of keys){const pub=findRspackExportPublication(f.module,key);if(!pub?.fn)continue;const fn=pub.fn,params=new RegExp(`^(?<key>${ID}),(?<value>${ID})$`,"u").exec(fn.params)?.groups;if(!params||params.key===params.value)continue;
  const k=escapeRegExp(params.key),v=escapeRegExp(params.value);
  const read=new RegExp(String.raw`^return"u"<typeof window\?${v}:\((?<initialize>${ID})\(\),(?<map>${ID})\.has\(${k}\)\?\k<map>\.get\(${k}\):${v}\)$`,"u").exec(fn.body);
  if(read){noShadow(Object.values(params),[read.groups.initialize,read.groups.map,"window"],"cache read captures");reads.push({key,fn,params,...read.groups});}
  const write=new RegExp(String.raw`^(?<initialize>${ID})\(\),(?<cancel>${ID})\(${k}\),(?<publish>${ID})\(${k},${v},!0\)$`,"u").exec(fn.body);
  if(write){noShadow(Object.values(params),Object.values(write.groups),"cache write captures");writes.push({key,fn,params,...write.groups});}
 }
 const read=one(reads,"cache map read publication"),write=one(writes.filter(value=>value.initialize===read.initialize),"cache map write publication");
 if(f.module.params.some(name=>["window","Map"].includes(name)))throw Error("Shadowed native cache builtin");authority.requireStableBinding(source,"window");authority.requireStableBinding(source,"Map");
 const map=one(f.hits(new RegExp(`(?<![\\w$.])${escapeRegExp(read.map)}=new Map(?=[,;])`,"gu")),"cache map initializer");f.stable(read.map,map.index);
 const initialize=f.rootFunction(read.initialize),cancel=f.rootFunction(write.cancel),publish=f.rootFunction(write.publish),ps=new RegExp(`^(?<key>${ID}),(?<value>${ID}),(?<persist>${ID}),(?<record>${ID}),(?<revision>${ID})$`,"u").exec(publish.params)?.groups;
 if(!ps||new Set(Object.values(ps)).size!==5)throw Error("Invalid native cache publisher parameters");
 const p=Object.fromEntries(Object.entries(ps).map(([key,value])=>[key,escapeRegExp(value)]));
 const publisher=new RegExp(String.raw`^let (?<writer>${ID})=${escapeRegExp(read.initialize)}\(\);void 0===${p.value}\?${escapeRegExp(read.map)}\.delete\(${p.key}\):${escapeRegExp(read.map)}\.set\(${p.key},${p.value}\),${p.persist}&&\k<writer>\(${p.key},${p.value},${p.record}\),(?<notify>${ID})\(\[${p.key}\],${p.revision}\)$`,"u").exec(publish.body);
 if(!publisher)throw Error("Native cache writer does not share the read map");
 distinct([...Object.values(ps),publisher.groups.writer],"cache publisher roles");noShadow([...Object.values(ps),publisher.groups.writer],[read.map,read.initialize,publisher.groups.notify],"cache publisher captures");
 f.rootFunction(publisher.groups.notify);for(const name of Object.values(ps))authority.requireStableBinding(publish.body,name);
 return{kind:"cache",moduleId:snapshot.moduleId,readExport:read.key,writeExport:write.key,proof:{sharedMap:read.map,readFunction:source.slice(read.fn.start,read.fn.end),writeFunction:source.slice(write.fn.start,write.fn.end),publisher:publish.body,initializationFunction:initialize.name,cancelFunction:cancel.name}};
}

module.exports={inspectVisibilityProvider,inspectWorkspaceClampProvider,inspectPlanProvider,inspectCacheProvider};
