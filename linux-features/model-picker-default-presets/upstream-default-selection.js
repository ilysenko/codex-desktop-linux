"use strict";
const path=require("node:path");
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {assertUnambiguousModelComposerLexicalSource:assertLexical}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,rspackModuleFactories}=require("../../scripts/patches/lib/rspack-module-assets.js");
const Authority=require("./native-catalog-authority.js");
const {requireStableCatalogBinding}=require("./catalog-binding-authority.js");
const Policy=require("./catalog-policy.js");
const {assertCriticalLoaderMethodUses}=require("./critical-loader-authority.js");
const {findSynchronousFunctionDeclaration}=require("./synchronous-function-declaration.js");
const IDENT="[A-Za-z_$][\\w$]*";
const DEFAULT_SELECTION_DESCRIPTION = "native upstream Default selection";
const DEFAULT_SELECTION_NEEDLES = ["includeSyntheticDefault:", "paidModelFallbackEnabled:", ".sliderSettings?.length?"];

function defaultSelectionOne(source, expression, description) {
  const lexical = createJavaScriptLexicalIndex(source);
  const values = [...source.matchAll(expression)].filter(match => lexical.isRoot(match.index));
  if (values.length !== 1) throw new Error(`Missing or ambiguous ${DEFAULT_SELECTION_DESCRIPTION} ${description}`);
  return values[0];
}

function defaultSelectionInitializer(source,expression,description){
  const found=defaultSelectionOne(source,expression,description);
  const tail=source.slice(found.index+found[0].length).trimStart();
  if(!/^[,;]/u.test(tail))throw Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} ${description} initializer tail`);
  return found;
}

function defaultSelectionFunction(source,name,snapshot) {
  return findSynchronousFunctionDeclaration(source,snapshot,name);
}

function defaultSelectionReturn(body) {
  const returned = defaultSelectionOne(body,/\breturn\b/gu,"return");
  const tail=body.slice(returned.index + "return".length),gap=/^\s*/u.exec(tail)[0];
  if(/[\r\n\u2028\u2029]/u.test(gap))throw Error(`ASI line break in ${DEFAULT_SELECTION_DESCRIPTION} return`);
  return tail.trim().replace(/;$/u,"");
}

function defaultSelectionParameters(body, names) {
  if (new Set(names).size !== names.length) throw new Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} parameters`);
  for (const name of names) requireStableCatalogBinding(body,name);
}

function distinct(names,label){if(new Set(names).size!==names.length)throw Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} ${label}`);}
function noShadow(locals,free,label){if(locals.some(name=>free.includes(name)))throw Error(`Shadowed ${DEFAULT_SELECTION_DESCRIPTION} ${label}`);}
function captured(body,names,params){
 for(const name of [...new Set(names)]){
  if(params.includes(name))throw Error(`Shadowed ${DEFAULT_SELECTION_DESCRIPTION} captured role`);
  try{new Script(`function nativeDefaultCapturedScope(${params.join(",")}){${body};let ${name};}`);}catch{throw Error(`Redeclared ${DEFAULT_SELECTION_DESCRIPTION} captured role: ${name}`);}
  requireStableCatalogBinding(`function nativeDefaultCapturedScope(${params.join(",")}){${body}}`,name);
 }
}

function inspectUpstreamDefaultSelectionOwner(source, snapshot) {
  if(typeof source!=="string"||!DEFAULT_SELECTION_NEEDLES.every(needle=>source.includes(needle)))throw new Error(`Missing ${DEFAULT_SELECTION_DESCRIPTION} body candidate`);
  if(Buffer.byteLength(source)>256*1024||snapshot?.moduleSource!==source)throw new Error(`Oversize or stale ${DEFAULT_SELECTION_DESCRIPTION} snapshot`);
  if (!Array.isArray(snapshot?.params) || snapshot.params.length !== 3 || new Set(snapshot.params).size !== 3 || snapshot.params.some(name=>!new RegExp(`^${IDENT}$`,"u").test(name))) {
    throw new Error(`Invalid ${DEFAULT_SELECTION_DESCRIPTION} factory snapshot`);
  }
  try { new Script(`"use strict";function nativeDefaultFactory(${snapshot.params.join(",")}){${source}}`); }
  catch { throw new Error(`Invalid ${DEFAULT_SELECTION_DESCRIPTION} factory syntax`); }
  const module={...snapshot,moduleSource:source},lexical=createJavaScriptLexicalIndex(source);
  assertLexical(source,lexical);
  requireStableCatalogBinding(source,snapshot.params[2]);
  requireStableCatalogBinding(source,snapshot.params[1]);
  assertCriticalLoaderMethodUses(source,snapshot,{allowInterop:true});
  const keys=[...source.matchAll(new RegExp(`(${IDENT}):function\\(`,"gu"))].filter(hit=>lexical.isCode(hit.index)).map(hit=>hit[1]);
  const publications=[...new Set(keys)].flatMap(key=>{
    const publication=findRspackExportPublication(module,key);
    if(publication?.fn==null)return[];
    const params=new RegExp(`^(?<catalog>${IDENT}),\\{isTppConversation:(?<tpp>${IDENT})=!1,includeSyntheticDefault:(?<include>${IDENT})=!1,paidModelFallbackEnabled:(?<paid>${IDENT})=!1\\}$`,"u").exec(publication.fn.params);
    return params==null?[]:[{publication,inputs:params.groups}];
  });
  if(publications.length!==1)throw new Error(`Missing or ambiguous ${DEFAULT_SELECTION_DESCRIPTION} publication`);
  const {publication,inputs}=publications[0],body=publication.fn.body,catalog=escapeRegExp(inputs.catalog);
  defaultSelectionParameters(body,Object.values(inputs));
  const options=defaultSelectionInitializer(body,new RegExp(`(?<options>${IDENT})=${catalog}\\?\\.versionOptions\\?\\.find\\(\\(\\{slugs:(?<slugs>${IDENT}),options:(?<models>${IDENT})\\}\\)=>\\k<slugs>\\.includes\\(${catalog}\\.defaultModelSlug\\)&&\\k<models>\\.length>0\\)\\?\\.options\\?\\?${catalog}\\?\\.versionOptions\\?\\.find\\(\\(\\{slugs:(?<fallback>${IDENT})\\}\\)=>\\k<fallback>\\.some\\((?<preferences>${IDENT})\\.(?<predicate>${IDENT})\\)\\)\\?\\.options\\?\\?${catalog}\\?\\.options\\?\\?\\[\\]`,"gu"),"available model options").groups;
  noShadow([options.slugs,options.models],[inputs.catalog],"catalog options callback");
  distinct([options.slugs,options.models],"catalog options callback");
  noShadow([options.fallback],[options.preferences],"fallback predicate callback");
  const settings=defaultSelectionInitializer(body,new RegExp(`(?<settings>${IDENT})=${catalog}\\?\\.sliderSettings\\?\\.length\\?${catalog}\\.sliderSettings:(?<normal>${IDENT})\\(${escapeRegExp(options.options)},${escapeRegExp(inputs.tpp)}\\)`,"gu"),"exclusive catalog slider").groups;
  for(const name of [options.options,settings.settings]){
    if(Object.values(inputs).includes(name))throw new Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} local`);
    const init=defaultSelectionOne(body,new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?!=|>)`,"gu"),"local initializer");
    requireStableCatalogBinding(body,name,init.index);
  }
  const returned=defaultSelectionReturn(body);
  const output=new RegExp(`^\\{defaultOption:${escapeRegExp(inputs.include)}\\|\\|${escapeRegExp(inputs.paid)}\\?\\{\\.\\.\\.(?<builder>${IDENT})\\(${catalog},${escapeRegExp(options.options)},${escapeRegExp(settings.settings)}\\),isDefault:!0\\}:void 0,versionOptions:${catalog}\\?\\.versionOptions\\?\\.map\\((?<version>${IDENT})=>\\(\\{\\.\\.\\.${escapeRegExp(inputs.paid)}\\?\\k<builder>\\(${catalog},\\k<version>\\.options,${escapeRegExp(settings.settings)}\\):(?<manual>${IDENT})\\(${catalog},\\k<version>\\.options,\\{isTppConversation:${escapeRegExp(inputs.tpp)}\\}\\),version:\\k<version>\\}\\)\\)\\?\\?\\[\\]\\}$`,"u").exec(returned);
  if(output==null)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} Default/manual output`);
  noShadow([output.groups.version],[inputs.catalog,inputs.paid,inputs.tpp,settings.settings,output.groups.builder,output.groups.manual],"version callback");
  captured(body,[settings.normal,output.groups.builder,output.groups.manual,options.preferences],Object.values(inputs));
  const common=defaultSelectionFunction(source,output.groups.builder,snapshot),manual=defaultSelectionFunction(source,output.groups.manual,snapshot),normal=defaultSelectionFunction(source,settings.normal,snapshot);
  if(new Set([common.name,manual.name,normal.name]).size!==3)throw new Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} builders`);
  const commonParams=new RegExp(`^(?<catalog>${IDENT}),(?<models>${IDENT}),(?<pairs>${IDENT})$`,"u").exec(common.params)?.groups;
  if(commonParams==null)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} common builder parameters`);
  defaultSelectionParameters(common.body,Object.values(commonParams));
  const cp=Object.fromEntries(Object.entries(commonParams).map(([key,value])=>[key,escapeRegExp(value)]));
  const resolved=defaultSelectionInitializer(common.body,new RegExp(`(?<resolved>${IDENT})=${cp.pairs}\\.flatMap\\(\\(\\{modelSlug:(?<slug>${IDENT}),thinkingEffort:(?<effort>${IDENT})\\}\\)=>${cp.models}\\.find\\((?<model>${IDENT})=>\\k<model>\\.slug===\\k<slug>&&\\(\\k<model>\\.thinkingEffort\\?\\?null\\)===\\k<effort>\\)\\?\\?\\(0,(?<schema>${IDENT})\\.(?<resolver>${IDENT})\\)\\(${cp.catalog},\\{slug:\\k<slug>,thinkingEffort:\\k<effort>\\}\\)\\?\\?\\[\\]\\)`,"gu"),"catalog model/effort resolver");
  distinct([resolved.groups.slug,resolved.groups.effort],"pair callback");
  noShadow([resolved.groups.slug,resolved.groups.effort],[commonParams.catalog,commonParams.models,resolved.groups.schema],"pair callback");
  noShadow([resolved.groups.model],[resolved.groups.slug,resolved.groups.effort],"exact option callback");
  if(Object.values(commonParams).includes(resolved.groups.resolved))throw new Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} resolved options`);
  requireStableCatalogBinding(common.body,resolved.groups.resolved,resolved.index);
  const commonOutput=new RegExp(`^\\{isDefault:!1,options:(?<dedupe>${IDENT})\\(\\)\\(\\[\\.\\.\\.${cp.models},\\.\\.\\.${escapeRegExp(resolved.groups.resolved)}\\],\\(\\{slug:(?<slug>${IDENT}),thinkingEffort:(?<effort>${IDENT})\\}\\)=>(?<key>[\\s\\S]+)\\),powerSettings:${cp.pairs}\\}$`,"u").exec(defaultSelectionReturn(common.body));
  if(commonOutput==null||commonOutput.groups.key!==`\`\${${commonOutput.groups.slug}}:\${${commonOutput.groups.effort}??""}\``)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} common result`);
  distinct([commonOutput.groups.slug,commonOutput.groups.effort],"option key callback");
  captured(common.body,[resolved.groups.schema,commonOutput.groups.dedupe],Object.values(commonParams));
  const manualParams=new RegExp(`^(?<catalog>${IDENT}),(?<models>${IDENT}),\\{isTppConversation:(?<tpp>${IDENT})=!1\\}=\\{\\}$`,"u").exec(manual.params)?.groups;
  if(manualParams==null)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} manual parameters`);
  defaultSelectionParameters(manual.body,Object.values(manualParams));
  const mp=Object.fromEntries(Object.entries(manualParams).map(([key,value])=>[key,escapeRegExp(value)]));
  const manualSlider=defaultSelectionInitializer(manual.body,new RegExp(`(?<settings>${IDENT})=${mp.catalog}\\?\\.sliderSettings\\?\\.filter\\(\\(\\{modelSlug:(?<slug>${IDENT})\\}\\)=>${mp.models}\\.some\\(\\(\\{slug:(?<model>${IDENT})\\}\\)=>\\k<model>===\\k<slug>\\)\\)\\?\\?\\[\\]`,"gu"),"manual catalog subset");
  noShadow([manualSlider.groups.slug],[manualParams.models],"manual slider callback");
  noShadow([manualSlider.groups.model],[manualSlider.groups.slug],"manual model callback");
  if(Object.values(manualParams).includes(manualSlider.groups.settings))throw new Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} manual settings`);
  requireStableCatalogBinding(manual.body,manualSlider.groups.settings,manualSlider.index);
  const manualOutput=new RegExp(`^${escapeRegExp(common.name)}\\(${mp.catalog},${mp.models},${escapeRegExp(commonOutput.groups.dedupe)}\\(\\)\\(\\[\\.\\.\\.${escapeRegExp(normal.name)}\\(${mp.models},${mp.tpp}\\),\\.\\.\\.${escapeRegExp(manualSlider.groups.settings)}\\],\\(\\{modelSlug:(?<slug>${IDENT}),thinkingEffort:(?<effort>${IDENT})\\}\\)=>(?<key>[\\s\\S]+)\\)\\)$`,"u").exec(defaultSelectionReturn(manual.body));
  if(manualOutput==null||manualOutput.groups.key!==`\`\${${manualOutput.groups.slug}}:\${${manualOutput.groups.effort}??""}\``)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} ordinary model path`);
  distinct([manualOutput.groups.slug,manualOutput.groups.effort],"pair key callback");
  captured(manual.body,[common.name,normal.name,commonOutput.groups.dedupe],Object.values(manualParams));
  const normalParams=new RegExp(`^(?<models>${IDENT}),(?<tpp>${IDENT})$`,"u").exec(normal.params)?.groups;
  if(normalParams==null)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} normal parameters`);
  defaultSelectionParameters(normal.body,Object.values(normalParams));
  const ordinary=new RegExp(`^${escapeRegExp(normalParams.models)}\\.flatMap\\(\\(\\{slug:(?<slug>${IDENT}),thinkingEffort:(?<effort>${IDENT})\\}\\)=>${escapeRegExp(normalParams.tpp)}&&null==\\k<effort>\\?\\[\\]:\\[\\{modelSlug:\\k<slug>,thinkingEffort:\\k<effort>\\?\\?null\\}\\]\\)$`,"u").exec(defaultSelectionReturn(normal.body));
  if(ordinary==null)throw new Error(`Unsupported ${DEFAULT_SELECTION_DESCRIPTION} ordinary effort choices`);
  distinct([ordinary.groups.slug,ordinary.groups.effort],"ordinary pair callback");
  noShadow([ordinary.groups.slug,ordinary.groups.effort],[normalParams.tpp],"ordinary pair callback");
  const dedupe=commonOutput.groups.dedupe;
  const interop=defaultSelectionInitializer(source,new RegExp(`(?<alias>${escapeRegExp(dedupe)})=${escapeRegExp(publication.requireName)}\\.n\\((?<module>${IDENT})\\)`,"gu"),"dedupe interop");
  const names=[interop.groups.module,dedupe,options.preferences,resolved.groups.schema];
  if(new Set(names).size!==names.length||names.some(name=>module.params.includes(name)))throw new Error(`Aliased ${DEFAULT_SELECTION_DESCRIPTION} imports`);
  const imports=[];
  for(const name of names){
    const init=defaultSelectionOne(source,new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?!=|>)`,"gu"),"factory import initializer");
    requireStableCatalogBinding(source,name,init.index);
    if(name!==dedupe){const binding=findRspackRequireBinding(module,name);if(binding==null)throw new Error(`Missing ${DEFAULT_SELECTION_DESCRIPTION} factory require`);imports.push({localName:name,moduleId:binding.moduleId});}
  }
  const exportedKeys=[...source.matchAll(new RegExp(`(${IDENT}):(?:${IDENT}|\\(\\)=>${IDENT})(?=[,}])`,"gu"))].filter(hit=>lexical.isCode(hit.index)).map(hit=>hit[1]);
  const manualExports=[...new Set(exportedKeys)].filter(key=>findRspackExportPublication(module,key)?.expression===manual.name);
  if(manualExports.length!==1)throw new Error(`Missing or ambiguous ${DEFAULT_SELECTION_DESCRIPTION} manual publication`);
  return {kind:"native",publication:{exportName:publication.exportName,requireName:publication.requireName,exportsName:publication.exportsName},inputs:{...inputs},options:options.options,powerSettings:settings.settings,builders:{common:common.name,manual:manual.name,normal:normal.name},catalogResolver:{...imports.find(ref=>ref.localName===resolved.groups.schema),exportName:resolved.groups.resolver},modelPredicate:{...imports.find(ref=>ref.localName===options.preferences),exportName:options.predicate},dedupeImport:{...imports.find(ref=>ref.localName===interop.groups.module),interopLocalName:dedupe},manualExportName:manualExports[0],imports};
}

function sourceMatch(source){return typeof source==='string'&&DEFAULT_SELECTION_NEEDLES.every(needle=>source.includes(needle));}
function currentOwner(source,context={}){
 if(context.factorySnapshot!=null)return inspectUpstreamDefaultSelectionOwner(source,context.factorySnapshot);
 Authority.requireRegistry(source);
 const owners=[];
 for(const snapshot of rspackModuleFactories(source,'native-default.js')){
  if(!sourceMatch(snapshot.moduleSource))continue;
  try{owners.push(inspectUpstreamDefaultSelectionOwner(snapshot.moduleSource,snapshot));}catch{}
 }
 if(owners.length!==1)throw Error(`Missing or ambiguous ${DEFAULT_SELECTION_DESCRIPTION} factory`);
 return owners[0];
}
function upstreamDefaultSelectionContract(source,context={}){try{currentOwner(source,context);return'current';}catch{return'drifted';}}

// Only the named native predicate is audited here. Other TWUU exports remain
// owned by their separate feature contracts, including the local resolver.
function inspectModelPredicate(source,snapshot,reference){
 if(typeof source!=='string'||Buffer.byteLength(source)>256*1024||snapshot?.moduleSource!==source||snapshot.params?.length!==3||new Set(snapshot.params).size!==3||snapshot.params.some(name=>!new RegExp(`^${IDENT}$`,'u').test(name)))throw Error('Invalid native Default model predicate factory');
 try{new Script(`"use strict";function nativeDefaultPredicate(${snapshot.params.join(',')}){${source}}`);}catch{throw Error('Invalid native Default model predicate syntax');}
 assertLexical(source,createJavaScriptLexicalIndex(source));
 requireStableCatalogBinding(source,snapshot.params[2]);requireStableCatalogBinding(source,snapshot.params[1]);
 assertCriticalLoaderMethodUses(source,snapshot,{allowInterop:true});
 const pub=findRspackExportPublication(snapshot,reference.exportName);
 if(!pub||!new RegExp(`^${IDENT}$`,'u').test(pub.expression??''))throw Error('Missing native Default model predicate publication');
 const fn=defaultSelectionFunction(source,pub.expression,snapshot),argument=new RegExp(`^${IDENT}$`,'u').test(fn.params)?fn.params:null;
 const body=argument==null?null:new RegExp(`^return (?<regex>${IDENT})\\.test\\(${escapeRegExp(argument)}\\)$`,'u').exec(fn.body);
 if(!body||body.groups.regex===argument)throw Error('Unsupported native Default model predicate');
 const initial=defaultSelectionOne(source,new RegExp(`(?<![\\w$.])${escapeRegExp(body.groups.regex)}=(?<regex>/\\(\\?:\\^\\|\\[-_\\.\\]\\)sol\\(\\?:\\$\\|\\[-_\\.\\]\\)/iu)(?=[,;])`,'gu'),'native model regex');
 requireStableCatalogBinding(source,body.groups.regex,initial.index);
 captured(fn.body,[body.groups.regex],[argument]);
 return{moduleId:snapshot.moduleId,exportName:reference.exportName,pattern:initial.groups.regex};
}
function refs(owner){return{defaultExport:owner.publication.exportName,manualExport:owner.manualExportName,catalogResolver:{moduleId:owner.catalogResolver.moduleId,exportName:owner.catalogResolver.exportName},modelPredicate:{moduleId:owner.modelPredicate.moduleId,exportName:owner.modelPredicate.exportName},dedupeModuleId:owner.dedupeImport.moduleId};}
function same(a,b,label){if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`Inconsistent native Default ${label}`);}
function auditUpstreamDefaultSelection(extractedDir,presets,options={}){
 if(!Array.isArray(presets))throw TypeError('Expected normalized Default presets');
 const assetsDir=path.join(extractedDir,'webview','assets'),registries=new Set();
 const registry=source=>{if(!registries.has(source)){Authority.requireRegistry(source);registries.add(source);}};
 const inspect=snapshot=>{registry(snapshot.source);return inspectUpstreamDefaultSelectionOwner(snapshot.moduleSource,snapshot);};
 const copies=findUniqueRspackModuleCopies(assetsDir,{description:DEFAULT_SELECTION_DESCRIPTION,sourceMatch,matchModule(_source,snapshot){if(!sourceMatch(snapshot.moduleSource))return false;try{inspect(snapshot);return true;}catch{return false;}}});
 const facts=copies.map(inspect),reference=refs(facts[0]);for(const fact of facts)same(refs(fact),reference,'owner references');
 function dependency(ref,kind,qualify){
  const check=snapshot=>{registry(snapshot.source);return qualify(snapshot);};
  const peers=findUniqueRspackModuleCopies(assetsDir,{description:`native Default ${kind} dependency`,sourceMatch:source=>source.includes(ref.moduleId)||source.includes('\\u')||source.includes('\\/'),matchModule(_source,snapshot){if(snapshot.moduleId!==ref.moduleId||Buffer.byteLength(snapshot.moduleSource)>256*1024)return false;try{check(snapshot);return true;}catch{return false;}}});
  if(peers[0].moduleId!==ref.moduleId)throw Error(`Wrong native Default ${kind} identity`);
  const proofs=peers.map(check);for(const proof of proofs)same(proof,proofs[0],`${kind} physical references`);
  return{kind,moduleId:ref.moduleId,exportName:ref.exportName,matched:peers.length,proof:proofs[0]};
 }
 const catalog=dependency(reference.catalogResolver,'catalog',snapshot=>{
  assertCriticalLoaderMethodUses(snapshot.moduleSource,snapshot,{allowInterop:true});
  const prepared=Policy.prepareCatalogFactory(snapshot.moduleSource,snapshot,presets,{},Authority),proof=prepared.proof;
  if(proof.resolverExport!==reference.catalogResolver.exportName)throw Error('Native Default resolver does not match the qualified catalog');
  const nativeSnapshot={...snapshot,moduleSource:prepared.nativeSource};
  for(const exportName of [proof.resolverExport,proof.collectorExport]){
   const publication=findRspackExportPublication(nativeSnapshot,exportName);
   if(!new RegExp(`^${IDENT}$`,'u').test(publication?.expression??''))throw Error('Missing native Default catalog declaration reference');
   findSynchronousFunctionDeclaration(prepared.nativeSource,nativeSnapshot,publication.expression);
  }
  // Both states are accepted only through the catalog's exact inverse/replay.
  return{state:prepared.state,resolverExport:proof.resolverExport,collectorExport:proof.collectorExport,capabilityExport:proof.capabilityExport,normalizerExport:proof.normalizerExport};
 });
 const predicate=dependency(reference.modelPredicate,'predicate',snapshot=>inspectModelPredicate(snapshot.moduleSource,snapshot,reference.modelPredicate));
 // No vendor owner is invented for loader.n default interop. Its real static
 // import, readonly aliases and native call routing are checked in each owner.
 // Controlled test uniqBy stubs are not a bundled-vendor algorithm audit.
 const result={matched:copies.length,changed:0,changedAssets:[],moduleId:copies[0].moduleId,assetNames:[...new Set(copies.map(copy=>copy.assetName))],references:reference,dependencies:[catalog,predicate],dedupe:{moduleId:reference.dedupeModuleId,staticImportAndInteropQualified:true,nativeCallRoutingUnchanged:true,vendorBodyVerified:false}};
 const validate=options.validatePrepared?.({owners:facts,dependencies:result.dependencies,result});
 if(validate!=null&&typeof validate.then==='function')throw TypeError('Default audit validation must be synchronous');
 return result;
}
module.exports={sourceMatch,inspectUpstreamDefaultSelectionOwner,inspectModelPredicate,upstreamDefaultSelectionContract,auditUpstreamDefaultSelection};
