"use strict";
const path=require("node:path");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findUniqueRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const Policy=require("./catalog-policy.js");
const Providers=require("./native-policy-providers.js");
const {patchCatalogCohorts}=require("./catalog-cohort.js");
const CATALOG_NEEDLES=[".slider_settings.flatMap(","serviceTiersByModelSlug:","modelConfigBySlug:","workspaceModelPolicy:"];
const TPP_NEEDLES=['"/tpp/models/"','"chatgpt-tpp-models"',"expectedIdentity:","placeholderData:"];
const MODELS_NEEDLES=['"/models"','"chatgpt-models"',"is_gizmo:","merged:"];
const PLAN_NEEDLES=["chatGptAuthenticatedAccountId$","chatGptAuthenticatedUserId$",".targetingAccount.planType",".hasChatGptToken"];
const VISIBILITY_NEEDLES=[".data?.reasoningEffortVisibility?.enabled",".enabledReasoningEfforts","new Set("];
const WORKSPACE_NEEDLES=[".modelConfigBySlug?.[",".thinkingEfforts",".sliderSettings?.flatMap(","thinkingEffort:null",".options.indexOf("];
// The published browser-guarded read distinguishes this tiny cache provider
// before any authority work on unrelated Map/window factories in its asset.
const CACHE_NEEDLES=[".has(",".get(",".set(","new Map",'return"u"<typeof window?'];
const has=(source,needles)=>needles.every(needle=>source.includes(needle));
function same(a,b,label){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`Inconsistent Default preset ${label}`);}
function ref(value){if(typeof value?.moduleId!=="string"||typeof value?.exportName!=="string")throw Error("Missing native Default preset dependency reference");return{moduleId:value.moduleId,exportName:value.exportName};}
function checkRef(value,expected,label){same(ref(value),ref(expected),label);}

function nativeReference(source,snapshot,reference,kind,authority) {
 if(Buffer.byteLength(source)>256*1024)return null;
 for(const name of snapshot.params.slice(1))authority.requireStableBinding(source,name);
 const pub=findRspackExportPublication(snapshot,reference.exportName),lex=createJavaScriptLexicalIndex(source),ID="[A-Za-z_$][\\w$]*",json='"(?:\\\\.|[^"\\\\])*"';
 if(!pub||typeof pub.expression!=="string"||!new RegExp(`^${ID}$`,"u").test(pub.expression))return null;
 const name=pub.expression,root=expression=>[...source.matchAll(expression)].filter(hit=>lex.isRoot(hit.index));
 if(kind==="map"){
  const field=`${ID}:${json}`,literal=oneNative(root(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?<object>\\{${field}(?:,${field})*\\})(?=[,;])`,"gu")),"effort map initializer");
  const entries=[...literal.groups.object.slice(1,-1).matchAll(new RegExp(`(?<key>${ID}):(?<value>${json})`,"gu"))];
  if(new Set(entries.map(entry=>entry.groups.key)).size!==entries.length||entries.some(entry=>["__proto__","constructor","prototype"].includes(entry.groups.key)))throw Error("Invalid native effort map");
  const mapping=Object.fromEntries(entries.map(entry=>[entry.groups.key,JSON.parse(entry.groups.value)]));
  authority.requireStableBinding(source,name,literal.index);
  if(authority.reasoningEffortNames)for(const [code,value]of Object.entries(authority.reasoningEffortNames))same(mapping[code],value,`native effort name ${code}`);
  return{...reference,kind,mapping};
 }
 if(kind==="enum"){
  const req=escapeRegExp(snapshot.params[2]),hit=oneNative(root(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=${req}\\(${json}\\)\\.enum\\((?<array>\\[(?:${json}(?:,${json})*)?\\])\\)(?=[,;])`,"gu")),"effort enum initializer");
  authority.requireStableBinding(source,name,hit.index);return{...reference,kind,values:JSON.parse(hit.groups.array)};
 }
 const head=oneNative(root(new RegExp(`function ${escapeRegExp(name)}\\((?<input>${ID})\\)\\{return null!=\\k<input>&&(?<list>${ID})\\.includes\\(\\k<input>\\)\\}`,"gu")),"workspace predicate function");
 const list=oneNative(root(new RegExp(`(?<![\\w$.])${escapeRegExp(head.groups.list)}=(?<array>\\[(?:${json}(?:,${json})*)?\\])(?=[,;])`,"gu")),"workspace plan list");
 authority.requireStableBinding(source,name,head.index+"function ".length);authority.requireStableBinding(source,head.groups.list,list.index);
 return{...reference,kind,plans:JSON.parse(list.groups.array)};
}
function oneNative(values,label){if(values.length!==1)throw Error(`Missing or ambiguous native ${label}`);return values[0];}
function nativeReferenceCopies(assetsDir,reference,kind,authority,requireRegistry) {
 const inspect=copy=>{requireRegistry(copy.source);return nativeReference(copy.moduleSource,copy,reference,kind,authority)};
 const copies=findUniqueRspackModuleCopies(assetsDir,{description:`native Default preset ${kind} dependency`,sourceMatch:source=>source.includes(reference.moduleId)||source.includes("\\u")||source.includes("\\/"),matchModule:(_source,copy)=>{if(copy.moduleId!==reference.moduleId)return false;try{return inspect(copy)!=null;}catch{return false;}}});
 const facts=copies.map(inspect);if(facts.some(fact=>!fact))throw Error(`Damaged native Default preset ${kind} dependency`);
 for(const fact of facts)same(fact,facts[0],`${kind} dependency copies`);
 return{fact:facts[0],dependency:{id:kind,moduleId:reference.moduleId,exportName:reference.exportName,matched:copies.length}};
}

function discoverNativePolicyBindings(assetsDir,authority) {
 const specs=[
  {id:"plan",description:"native authenticated plan signal",needles:PLAN_NEEDLES,inspect:Providers.inspectPlanProvider,key:fact=>({moduleId:fact.moduleId,exportName:fact.exportName,accountExport:fact.accountExport,userExport:fact.userExport,preferredUserExport:fact.preferredUserExport,scope:fact.scope,frameworkModuleId:fact.frameworkModuleId})},
  {id:"visibility",description:"native effective reasoning visibility",needles:VISIBILITY_NEEDLES,inspect:Providers.inspectVisibilityProvider,key:fact=>({moduleId:fact.moduleId,exportName:fact.exportName,rawExportName:fact.rawExportName,scope:fact.scope,frameworkModuleId:fact.frameworkModuleId,identityModuleId:fact.identityModuleId,defaults:fact.proof.defaultEfforts})},
  {id:"workspaceClamp",description:"native workspace thinking clamp",needles:WORKSPACE_NEEDLES,inspect:Providers.inspectWorkspaceClampProvider,key:fact=>({moduleId:fact.moduleId,exportName:fact.exportName,catalogModuleId:fact.catalogModuleId,planPredicate:fact.planPredicate,effortEnum:fact.effortEnum,effortNames:fact.effortNames})},
  {id:"cache",description:"native persisted model cache",needles:CACHE_NEEDLES,inspect:Providers.inspectCacheProvider,key:fact=>({moduleId:fact.moduleId,readExport:fact.readExport,writeExport:fact.writeExport})},
 ];
 const bindings={},dependencies=[],registries=new Set();
 const requireRegistry=source=>{if(!registries.has(source)){authority.requireRegistry(source);registries.add(source);}};
 for(const spec of specs){
  const inspect=copy=>{if(Buffer.byteLength(copy.moduleSource)>256*1024||!has(copy.moduleSource,spec.needles))throw Error(`Missing native ${spec.id} body`);requireRegistry(copy.source);return spec.inspect(copy.moduleSource,copy,authority)};
  const copies=findUniqueRspackModuleCopies(assetsDir,{description:spec.description,sourceMatch:source=>has(source,spec.needles),matchModule:(_source,copy)=>{try{inspect(copy);return true;}catch{return false;}}});
  const facts=copies.map(inspect),key=spec.key(facts[0]);for(const fact of facts)same(spec.key(fact),key,`${spec.id} physical copies`);
  bindings[spec.id]=facts[0];dependencies.push({id:spec.id,moduleId:copies[0].moduleId,matched:copies.length});
 }
 same(bindings.visibility.identityModuleId,bindings.plan.moduleId,"visibility identity module");
 same(bindings.visibility.scope,bindings.plan.scope,"native policy scope");
 same(bindings.visibility.frameworkModuleId,bindings.plan.frameworkModuleId,"native policy framework");
 same(bindings.visibility.proof.authenticatedUserExport,bindings.plan.userExport,"visibility user signal");
 bindings.reasoningEffortNames=bindings.workspaceClamp.effortNames;
 for(const [kind,reference]of [["map",bindings.workspaceClamp.effortNames],["enum",bindings.workspaceClamp.effortEnum],["predicate",bindings.workspaceClamp.planPredicate]]){
  const native=nativeReferenceCopies(assetsDir,reference,kind,authority,requireRegistry);dependencies.push(native.dependency);bindings[kind+"Proof"]=native.fact;
 }
 for(const value of Object.values(bindings.mapProof.mapping))if(!bindings.enumProof.values.includes(value))throw Error("Native effort map is outside native enum");
 return{bindings,dependencies};
}

function patchPresetCatalog(extractedDir,presets,authority,options={}) {
 if(!Array.isArray(presets)||typeof authority?.inspectNativeCatalog!=="function"||typeof authority.requireStableBinding!=="function"||typeof authority.requireRegistry!=="function")throw TypeError("Invalid Default preset integration input");
 const assetsDir=path.join(extractedDir,"webview","assets"),found=discoverNativePolicyBindings(assetsDir,authority),bindings=found.bindings;
 const markers=[...new Set([...Policy.catalogMarkers,...Policy.queryMarkers])];
 const catalogPrepare=(source,snapshot)=>{
  if(!has(source,CATALOG_NEEDLES))throw Error("Missing current Default catalog body");
  const prepared=Policy.prepareCatalogFactory(source,snapshot,presets,bindings,authority),p=prepared.proof;
  const current={moduleId:snapshot.moduleId,normalizerExport:p.normalizerExport,resolverExport:p.resolverExport,collectorExport:p.collectorExport,capabilityExport:p.capabilityExport,projectionExport:p.projectionExport};
  if(!bindings.catalog)bindings.catalog=current;
  return prepared;
 };
 function queryPrepare(kind,needles){return(source,snapshot)=>{
  // Guard each body before any Script or authority work; an asset may contain
  // hundreds of unrelated current factories. Closure validation still throws
  // for a known identity's damaged peer when it loses these needles.
  if(!has(source,needles))throw Error(`Missing current Default ${kind} query body`);
  const prepared=Policy.prepareQueryFactory(source,snapshot,presets,bindings,authority);
  if(prepared.proof.role!=="query"||prepared.proof.kind!==kind)throw Error(`Wrong Default ${kind} query owner`);
  return prepared;
 };}
 const adapters=[
  {id:"catalog",description:"current ChatGPT model catalog policy",markers,sourceMatch:source=>has(source,CATALOG_NEEDLES),prepare:catalogPrepare},
  {id:"tpp",description:"current TPP catalog query",markers,sourceMatch:source=>has(source,TPP_NEEDLES),prepare:queryPrepare("tpp",TPP_NEEDLES)},
  {id:"chatgpt",description:"current chat/gizmo/merged catalog queries",markers,sourceMatch:source=>has(source,MODELS_NEEDLES),prepare:queryPrepare("chatgpt",MODELS_NEEDLES)},
 ];
 const result=patchCatalogCohorts(extractedDir,adapters,{...options,auditOnly:presets.length===0,validatePrepared(groups){
  const catalog=groups.find(group=>group.id==="catalog");
  for(const{snapshot,prepared}of catalog.members){const p=prepared.proof;same(bindings.catalog,{moduleId:snapshot.moduleId,normalizerExport:p.normalizerExport,resolverExport:p.resolverExport,collectorExport:p.collectorExport,capabilityExport:p.capabilityExport,projectionExport:p.projectionExport},"catalog physical bindings");}
  same(bindings.workspaceClamp.catalogModuleId,catalog.moduleId,"workspace catalog import");same(bindings.workspaceClamp.proof.collectorExport,bindings.catalog.collectorExport,"workspace catalog collector");
  for(const group of groups.filter(group=>group.id!=="catalog"))for(const {prepared}of group.members){const proof=prepared.proof;
   checkRef({moduleId:(proof.originalCatalogImport??proof.catalogImport).moduleId,exportName:(proof.originalCatalogImport??proof.catalogImport).normalizerExport},{moduleId:catalog.moduleId,exportName:bindings.catalog.normalizerExport},`${group.id} native normalizer`);
   checkRef(proof.scope,bindings.plan.scope,`${group.id} scope`);same(proof.frameworkModuleId,bindings.plan.frameworkModuleId,`${group.id} framework`);
   if(group.id==="tpp"){
    const identity=proof.identity,cache=proof.cacheImport;
    same(identity&&{moduleId:identity.moduleId,accountExport:identity.accountExport,userExport:identity.userExport,preferredUserExport:identity.preferredUserExport},{moduleId:bindings.plan.moduleId,accountExport:bindings.plan.accountExport,userExport:bindings.plan.userExport,preferredUserExport:bindings.plan.preferredUserExport},"tpp native identity");
    checkRef(proof.nativePlan,bindings.plan,"tpp native plan");
    same(cache&&{moduleId:cache.moduleId,readExport:cache.readExport,writeExport:cache.writeExport},{moduleId:bindings.cache.moduleId,readExport:bindings.cache.readExport,writeExport:bindings.cache.writeExport},"tpp native cache");
    if(proof.cacheProof==null)throw Error("Missing tpp native cache proof");
   }else if(proof.identity!==null||proof.nativePlan!==null||proof.cacheImport!==null||proof.cacheProof!==null)throw Error("Unexpected chatgpt identity/cache proof");
   if(presets.length!==0){const deps=proof.addedDependencies;
    checkRef({moduleId:deps.catalog.moduleId,exportName:deps.catalog.projectionExport},{moduleId:catalog.moduleId,exportName:bindings.catalog.projectionExport},`${group.id} projected catalog`);
    checkRef(deps.plan,bindings.plan,`${group.id} plan`);checkRef(deps.visibility,bindings.visibility,`${group.id} visibility`);checkRef(deps.workspaceClamp,bindings.workspaceClamp,`${group.id} workspace clamp`);checkRef(deps.effortNames,bindings.workspaceClamp.effortNames,`${group.id} effort names`);
   }
  }
  const external=options.validatePrepared?.(groups);if(external!=null&&typeof external.then==="function")throw TypeError("Default preset integration validation must be synchronous");
 }});
 return{...result,dependencies:found.dependencies};
}
module.exports={discoverNativePolicyBindings,patchPresetCatalog};
