"use strict";

const { Script } = require("node:vm");
const { createHash } = require("node:crypto");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { assertUnambiguousModelComposerLexicalSource } = require("../../scripts/patches/lib/model-composer-lexical-guard.js");

const ID = "[A-Za-z_$][\\w$]*";
const PROJECT = "codexLinuxApplyDefaultPresets";
const RESOLVE = "codexLinuxDefaultPresetVariant";
const CONFIG = "codexLinuxDefaultPresetsConfigured";
const VARIANTS = "codexLinuxDefaultPresetVariants";
const STAMP = "codexLinuxDefaultPresetProjection";
const SERVER_VARIANTS = "codexLinuxDefaultPresetServerVariants";
const QUERY_MARKER = "codex-linux-default-presets-query-policy-v1";
const CATALOG_MARKERS = [PROJECT, RESOLVE, CONFIG, VARIANTS, STAMP, SERVER_VARIANTS];

// Serialized into the current catalog factory. All control inputs are supplied
// by a same-scope native options reader, never imported back into TFzY.
function codexLinuxApplyDefaultPresets(base, presets, policy) {
  if (!Array.isArray(presets)) throw new TypeError("Default presets must be normalized");
  if (presets.length === 0 || policy?.ready !== true || base == null) return base;
  if (Object.prototype.hasOwnProperty.call(base, "codexLinuxDefaultPresetProjection") ||
      Object.prototype.hasOwnProperty.call(base, "codexLinuxDefaultPresetVariants") ||
      Object.prototype.hasOwnProperty.call(base, "codexLinuxDefaultPresetServerVariants")) {
    throw new TypeError("Default presets require a pristine native catalog");
  }
  if (typeof policy.resolveNative !== "function" || typeof policy.clampCapability !== "function" ||
      typeof policy.clampWorkspace !== "function" || typeof policy.visibleEfforts?.has !== "function" ||
      policy.reasoningEffortNames == null) {
    throw new TypeError("Default presets require native policy dependencies");
  }
  const modelPool = [...(base.options ?? []), ...(base.internalOptions ?? []),
    ...(base.versionOptions?.flatMap(version => version?.options ?? []) ?? [])];
  const nativePool = [...(base.options ?? []), ...(base.chatAlphaOptions ?? []), ...(base.internalOptions ?? []),
    ...(base.versionOptions?.flatMap(version => version?.options ?? []) ?? [])];
  const supported = [], variants = [];
  function variantOption(model,metadata,slug,effort) {
    const capabilityLabel=metadata?.thinkingEfforts?.find(entry=>entry.thinking_effort===effort);
    const label=capabilityLabel?.short_label??capabilityLabel?.full_label;
    const modelTitle=model.modelTitle??metadata?.title??model.title??slug;
    return {...model,thinkingEffort:effort,modelTitle,title:label??modelTitle,
      selectedLabel:label==null?modelTitle:`${modelTitle} ${label}`};
  }
  for (const preset of presets) {
    const slug = preset.modelSlug, effort = preset.thinkingEffort;
    const requested = {slug,thinkingEffort:effort};
    if (effort == null) continue;
    const metadata = base.modelConfigBySlug?.[slug];
    if (metadata?.disabledByAdmin === true) continue;
    const model = modelPool.find(option => option?.slug === slug && option.isAvailable !== false);
    if (model == null) continue;
    const advertised = nativePool.find(option => option?.slug === slug &&
      (option.thinkingEffort ?? null) === effort);
    const native = policy.resolveNative(base, requested);
    // A native exact denial is an answer, not a miss that another base option
    // may turn into a granted variant.
    if (advertised?.isAvailable === false || native?.isAvailable === false) continue;
    if (native != null && (native.slug !== slug ||
        (native.thinkingEffort ?? null) !== effort)) continue;
    const capability = policy.clampCapability(base, requested);
    if (capability?.slug !== slug || capability.thinkingEffort !== effort) continue;
    const workspace = policy.clampWorkspace(policy.plan, base, slug, effort);
    if (workspace !== undefined && workspace?.thinkingEffort !== effort) continue;
    const reasoningEffort = policy.reasoningEffortNames[effort];
    if (reasoningEffort == null || !policy.visibleEfforts.has(reasoningEffort)) continue;
    const declared = metadata?.thinkingEfforts?.some(entry => entry.thinking_effort === effort) === true;
    const serverSlider = base.sliderSettings?.some(pair => pair.modelSlug === slug && pair.thinkingEffort === effort) === true;
    const serverDefault = base.defaultThinkingEffortByModelSlug?.[slug] === effort;
    // No-clamp is not positive evidence. Unknown metadata keeps the model's
    // proven pairs; it never licenses an arbitrary unadvertised effort.
    let option = native ?? advertised;
    if (option == null && !declared && !serverSlider && !serverDefault) continue;
    if (option == null) {
      option = variantOption(model,metadata,slug,effort);
      variants.push(option);
    }
    supported.push(preset);
  }
  if (supported.length === 0) return base;
  // Original server slider declarations have native authority independent of
  // the user's configured pool/visibility. Preserve their lookup metadata when
  // replacing the slider so native ay/policy precedence cannot lose an effort.
  const serverVariants=[];
  for(const pair of base.sliderSettings??[]){
    if(pair?.thinkingEffort==null)continue;
    const selection={slug:pair.modelSlug,thinkingEffort:pair.thinkingEffort};
    if(policy.resolveNative(base,selection)!=null || nativePool.some(option=>option?.slug===selection.slug &&
        (option.thinkingEffort??null)===selection.thinkingEffort))continue;
    const model=nativePool.find(option=>option?.slug===selection.slug&&option.isAvailable!==false);
    if(model==null||serverVariants.some(option=>option.slug===selection.slug&&option.thinkingEffort===selection.thinkingEffort))continue;
    serverVariants.push(variantOption(model,base.modelConfigBySlug?.[selection.slug],selection.slug,selection.thinkingEffort));
  }
  const selected = supported.find(preset => preset.isDefault) ?? supported[0];
  return {...base,
    sliderSettings:supported.map(preset => ({modelSlug:preset.modelSlug,thinkingEffort:preset.thinkingEffort})),
    defaultModelSlug:selected.modelSlug,
    defaultThinkingEffortByModelSlug:{...base.defaultThinkingEffortByModelSlug,[selected.modelSlug]:selected.thinkingEffort},
    codexLinuxDefaultPresetVariants:variants,
    codexLinuxDefaultPresetServerVariants:serverVariants,
    codexLinuxDefaultPresetProjection:1};
}

// Also serialized. Preserve every real native result (including unavailable),
// and preserve null/default lookup exactly. Only a validated explicit miss can
// use feature-owned supplemental metadata.
function codexLinuxDefaultPresetVariant(catalog, selection, nativeResult) {
  if (nativeResult != null || selection?.thinkingEffort == null || catalog?.codexLinuxDefaultPresetProjection !== 1) {
    return nativeResult;
  }
  return catalog.codexLinuxDefaultPresetVariants?.find(option => option.slug === selection.slug &&
    option.thinkingEffort === selection.thinkingEffort && option.isAvailable !== false) ??
    catalog.codexLinuxDefaultPresetServerVariants?.find(option => option.slug === selection.slug &&
      option.thinkingEffort === selection.thinkingEffort && option.isAvailable !== false) ?? nativeResult;
}

function one(values, description) {
  if (values.length !== 1) throw new Error(`Missing or ambiguous current catalog policy ${description}`);
  return values[0];
}
function rootMatches(source, expression) {
  const lexical=createJavaScriptLexicalIndex(source);
  return [...source.matchAll(expression)].filter(hit=>lexical.isRoot(hit.index));
}
function factorySyntax(source,snapshot) {
  assertUnambiguousModelComposerLexicalSource(source,createJavaScriptLexicalIndex(source));
  if (!Array.isArray(snapshot?.params) || snapshot.params.length!==3 || new Set(snapshot.params).size!==3 ||
      snapshot.params.some(name=>!new RegExp(`^${ID}$`,"u").test(name))) throw new Error("Invalid catalog policy factory parameters");
  try {new Script(`"use strict";function catalogPolicyFactory(${snapshot.params.join(",")}){${source}}`);}
  catch {throw new Error("Invalid catalog policy factory syntax");}
}
function requireFactoryAuthority(source,snapshot,authority) {
  // Check the actual body before a publication/import parser can trust the
  // factory's require and exports roles. The authority callback owns lexical
  // spelling normalization for its syntax-only readonly-binding probe.
  authority.requireStableBinding(source,snapshot.params[2]);
  authority.requireStableBinding(source,snapshot.params[1]);
}
function namedFunction(source,name,authority) {
  const head=one(rootMatches(source,new RegExp(`\\bfunction ${escapeRegExp(name)}\\((?<params>[^)]*)\\)\\{`,"gu")),"function binding");
  const open=head.index+head[0].length-1,end=createJavaScriptLexicalIndex(source).matchingBrace(open);
  if(end<open)throw new Error("Incomplete catalog policy function");
  authority.requireStableBinding(source,name,head.index+"function ".length);
  return {name,start:head.index,end:end+1,bodyStart:open+1,body:source.slice(open+1,end),params:head.groups.params};
}
function exportMaps(source,snapshot) {
  const req=escapeRegExp(snapshot.params[2]),exp=escapeRegExp(snapshot.params[1]);
  const head=one(rootMatches(source,new RegExp(`(?<![\\w$.])${req}\\.d\\(${exp},\\{`,"gu")),"export registration");
  const lexical=createJavaScriptLexicalIndex(source),first=head.index+head[0].length-1,firstEnd=lexical.matchingBrace(first);
  let cursor=firstEnd+1;while(/\s/u.test(source[cursor]??"")&&cursor<source.length)cursor++;
  if(source[cursor]!==",")throw new Error("Unsupported current catalog policy value publication");
  cursor++;while(/\s/u.test(source[cursor]??"")&&cursor<source.length)cursor++;
  const close=lexical.matchingBrace(cursor);
  if(source[cursor]!=="{"||close<cursor)throw new Error("Incomplete catalog policy export map");
  const maps=[[first+1,firstEnd],[cursor+1,close]];
  const keys=[];
  for(const [a,b]of maps){const content=source.slice(a,b),lex=createJavaScriptLexicalIndex(content);for(const hit of content.matchAll(new RegExp(`(?<key>${ID}):`,"gu")))if(lex.isRoot(hit.index))keys.push(hit.groups.key);}
  const publications=new Map([...new Set(keys)].flatMap(key=>{const value=findRspackExportPublication({...snapshot,moduleSource:source},key);return value?[[key,value]]:[];}));
  return {close,publications};
}
function resolverPattern(fn) {
  const params=new RegExp(`^(?<catalog>${ID}),(?<selection>${ID})$`,"u").exec(fn.params)?.groups;
  if(params==null||params.catalog===params.selection)return null;
  const c=escapeRegExp(params.catalog),s=escapeRegExp(params.selection);
  const body=new RegExp(`^let (?<pool>${ID})=(?<collector>${ID})\\(${c}\\),(?<effort>${ID})=${s}\\.thinkingEffort\\?\\?${c}\\?\\.defaultThinkingEffortByModelSlug\\?\\.\\[${s}\\.slug\\]\\?\\?null,(?<result>${ID})=(?<expression>[^;]+);return null!=\\k<result>\\|\\|null!=${s}\\.thinkingEffort\\?\\k<result>:\\k<pool>\\.find\\((?<fallback>${ID})=>\\k<fallback>\\.slug===${s}\\.slug\\)$`,"u").exec(fn.body);
  if(body==null)return null;
  const g=body.groups;
  const native=new RegExp(`^${escapeRegExp(g.pool)}\\.find\\((?<model>${ID})=>\\k<model>\\.slug===${s}\\.slug&&\\(\\k<model>\\.thinkingEffort\\?\\?null\\)===${escapeRegExp(g.effort)}\\)$`,"u");
  let nativeExpression=g.expression,applied=false;
  const prefix=`${RESOLVE}(${params.catalog},${params.selection},`;
  if(nativeExpression.startsWith(prefix)&&nativeExpression.endsWith(")")){nativeExpression=nativeExpression.slice(prefix.length,-1);applied=true;}
  const exact=native.exec(nativeExpression);
  if(exact==null)return null;
  const roles=[params.catalog,params.selection,g.pool,g.effort,g.result];
  if(new Set(roles).size!==roles.length||roles.includes(g.collector)||
      [params.selection,g.effort].includes(exact.groups.model)||g.fallback===params.selection)return null;
  const index=fn.body.indexOf(g.expression);
  if(index<0||fn.body.lastIndexOf(g.expression)!==index)return null;
  return {fn,params,groups:g,nativeExpression,applied,expressionRange:{start:fn.bodyStart+index,end:fn.bodyStart+index+g.expression.length}};
}
function inspectResolver(source,snapshot,authority,expectedApplied) {
  const map=exportMaps(source,snapshot),candidates=[];
  for(const [key,pub]of map.publications){if(pub.expression==null||!new RegExp(`^${ID}$`,"u").test(pub.expression))continue;let fn;try{fn=namedFunction(source,pub.expression,authority);}catch{continue;}const found=resolverPattern(fn);if(found&&found.applied===expectedApplied)candidates.push({...found,exportName:key});}
  const resolver=one(candidates,"option resolver");
  authority.requireStableBinding(resolver.fn.body,resolver.groups.collector);
  return {...resolver,map};
}
function inspectNativeCatalogPolicy(source,snapshot,authority) {
  if(typeof authority?.inspectNativeCatalog!=="function"||typeof authority.requireStableBinding!=="function")throw new Error("Catalog policy requires native authority callbacks");
  const normalizer=authority.inspectNativeCatalog(source,{...snapshot,moduleSource:source});
  const resolver=inspectResolver(source,snapshot,authority,false),collector=namedFunction(source,resolver.groups.collector,authority);
  const arg=new RegExp(`^${ID}$`,"u").test(collector.params)?escapeRegExp(collector.params):null;
  const collectorPattern=arg==null?null:new RegExp(`^return\\[\\.\\.\\.${arg}\\?\\.options\\?\\?\\[\\],\\.\\.\\.${arg}\\?\\.chatAlphaOptions\\?\\?\\[\\],\\.\\.\\.${arg}\\?\\.internalOptions\\?\\?\\[\\],\\.\\.\\.${arg}\\?\\.versionOptions\\?\\.flatMap\\((?<version>${ID})=>\\k<version>\\.options\\)\\?\\?\\[\\]\\]$`,"u");
  if(collectorPattern==null||!collectorPattern.test(collector.body))throw new Error("Unsupported native catalog option collector");
  authority.requireStableBinding(collector.body,collector.params);
  const collectorExport=one([...resolver.map.publications].filter(([,pub])=>pub.expression===collector.name),"option collector publication")[0];
  const capability=[];
  for(const [key,pub]of resolver.map.publications){if(pub.fn==null)continue;const ps=new RegExp(`^(?<catalog>${ID}),(?<selection>${ID})$`,"u").exec(pub.fn.params)?.groups;if(ps==null||ps.catalog===ps.selection)continue;
    const c=escapeRegExp(ps.catalog),s=escapeRegExp(ps.selection),v=escapeRegExp(resolver.fn.name);
    const pattern=new RegExp(`^let (?<metadata>${ID})=${c}\\?\\.modelConfigBySlug\\?\\.\\[${s}\\.slug\\],(?<internal>${ID})=null!=\\k<metadata>\\|\\|${c}\\?\\.options\\.some\\((?<item>${ID})=>\\k<item>\\.slug===${s}\\.slug\\)\\?void 0:${c}\\?\\.internalOptions\\?\\.find\\((?<entry>${ID})=>\\k<entry>\\.slug===${s}\\.slug\\);if\\(null!=\\k<internal>&&null==${v}\\(${c},${s}\\)\\)return\\{\\.\\.\\.${s},thinkingEffort:\\k<internal>\\.thinkingEffort\\?\\?null\\};let (?<efforts>${ID})=\\k<metadata>\\?\\.thinkingEfforts;return null==${s}\\.thinkingEffort\\|\\|!\\k<efforts>\\?\\.length\\|\\|\\k<efforts>\\.some\\(\\(\\{thinking_effort:(?<effort>${ID})\\}\\)=>\\k<effort>===${s}\\.thinkingEffort\\)\\?${s}:\\{\\.\\.\\.${s},thinkingEffort:\\k<efforts>\\[0\\]\\.thinking_effort\\}$`,"u");
    const captured=pattern.exec(pub.fn.body);
    if(captured!=null){
      const g=captured.groups,roles=[ps.catalog,ps.selection,g.metadata,g.internal,g.efforts];
      if(new Set(roles).size!==roles.length||roles.includes(resolver.fn.name)||
          [g.item,g.entry,g.effort].includes(ps.selection))continue;
      authority.requireStableBinding(pub.fn.body,ps.catalog);
      authority.requireStableBinding(pub.fn.body,ps.selection);
      authority.requireStableBinding(pub.fn.body,resolver.fn.name);
      capability.push(key);
    }
  }
  const capabilityExport=one(capability,"capability clamp publication");
  return {normalizer,resolver,collector,collectorExport,capabilityExport,exportClose:resolver.map.close};
}
function helperSource(presets) {
  return `${codexLinuxApplyDefaultPresets.toString()}${codexLinuxDefaultPresetVariant.toString()}const ${CONFIG}=${JSON.stringify(presets)};`;
}
function exportContribution() {
  return `,${PROJECT}:function(codexLinuxPresetCatalog,codexLinuxPresetPolicy){return ${PROJECT}(codexLinuxPresetCatalog,${CONFIG},codexLinuxPresetPolicy)}`;
}
function catalogPatched(native,snapshot,presets,authority) {
  // These are the complete free ambient bindings used by the serialized
  // helpers. A factory parameter is outside the body-only authority probe.
  for(const name of ["Array","Object","TypeError","undefined"]){
    if(snapshot.params.includes(name))throw new Error(`Captured catalog helper builtin: ${name}`);
    authority.requireStableBinding(native,name);
  }
  const proof=inspectNativeCatalogPolicy(native,snapshot,authority),range=proof.resolver.expressionRange;
  const wrapped=`${RESOLVE}(${proof.resolver.params.catalog},${proof.resolver.params.selection},${proof.resolver.nativeExpression})`;
  let patched=native.slice(0,proof.exportClose)+exportContribution()+native.slice(proof.exportClose);
  patched=patched.slice(0,range.start)+wrapped+patched.slice(range.end);
  patched=helperSource(presets)+patched;
  factorySyntax(patched,snapshot);
  return {patched,proof};
}
function catalogSourceMatch(source) {return typeof source==="string"&&(CATALOG_MARKERS.some(marker=>source.includes(marker))||[".slider_settings.flatMap(","serviceTiersByModelSlug:","modelConfigBySlug:","workspaceModelPolicy:"].every(needle=>source.includes(needle)));}
function prepareCatalogFactory(source,snapshot,presets,_bindings={},authority) {
  if(!catalogSourceMatch(source))throw new Error("Not a current catalog policy body candidate");
  if(snapshot?.moduleSource!==source)throw new Error("Stale catalog policy snapshot");
  if(!Array.isArray(presets))throw new Error("Catalog policy requires normalized presets");
  factorySyntax(source,snapshot);
  requireFactoryAuthority(source,snapshot,authority);
  const hasMarkers=CATALOG_MARKERS.some(marker=>source.includes(marker));
  if(presets.length===0){if(hasMarkers)throw new Error("Non-native empty catalog policy audit");const proof=inspectNativeCatalogPolicy(source,snapshot,authority);return{state:"pristine",nativeSource:source,patchedSource:source,proof:{role:"catalog",auditOnly:true,moduleId:snapshot.moduleId,normalizerExport:proof.normalizer.publication.exportName,resolverExport:proof.resolver.exportName,collectorExport:proof.collectorExport,capabilityExport:proof.capabilityExport,projectionExport:PROJECT}};}
  let native=source,state="pristine";
  if(hasMarkers){
    const prefix=helperSource(presets),contribution=exportContribution();
    if(!source.startsWith(prefix))throw new Error("Orphan or stale catalog policy helper");
    let candidate=source.slice(prefix.length);
    if(candidate.indexOf(contribution)<0||candidate.indexOf(contribution)!==candidate.lastIndexOf(contribution))throw new Error("Orphan catalog policy export");
    candidate=candidate.replace(contribution,"");
    const resolver=inspectResolver(candidate,{...snapshot,moduleSource:candidate},authority,true),range=resolver.expressionRange;
    native=candidate.slice(0,range.start)+resolver.nativeExpression+candidate.slice(range.end);
    if(CATALOG_MARKERS.some(marker=>native.includes(marker)))throw new Error("Orphan catalog policy marker");
    state="applied";
  }
  const made=catalogPatched(native,{...snapshot,moduleSource:native},presets,authority);
  if(state==="applied"&&made.patched!==source)throw new Error("Noncanonical catalog policy replay");
  return {state,nativeSource:native,patchedSource:made.patched,proof:{role:"catalog",auditOnly:false,moduleId:snapshot.moduleId,normalizerExport:made.proof.normalizer.publication.exportName,resolverExport:made.proof.resolver.exportName,collectorExport:made.proof.collectorExport,capabilityExport:made.proof.capabilityExport,projectionExport:PROJECT,variantField:VARIANTS,nullLookupPreserved:true,nativeCollectorUnchanged:true}};
}

const QUERY_HELPER = "codexLinuxPresetQueryOptions";
const QUERY_MARKERS = [QUERY_MARKER,QUERY_HELPER];

function queryImport(source,snapshot,name,authority) {
  const binding=findRspackRequireBinding({...snapshot,moduleSource:source},name);
  if(binding==null)throw new Error(`Missing native query import: ${name}`);
  const init=one(rootMatches(source,new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?!=|>)`,"gu")),"query import initializer");
  authority.requireStableBinding(source,name,init.index);
  return {localName:name,moduleId:binding.moduleId};
}
function rootReturnedObject(body,offset=0) {
  const returned=one(rootMatches(body,/\breturn\b/gu),"query options return");
  let open=returned.index+6;while(/\s/u.test(body[open]??"")&&open<body.length)open++;
  if(/[\r\n\u2028\u2029]/u.test(body.slice(returned.index+6,open)))throw new Error("Query return has an ASI line break");
  const close=createJavaScriptLexicalIndex(body).matchingBrace(open);
  if(body[open]!=="{"||close<open||body.slice(close+1).trim()!=="")throw new Error("Unsupported native query options return");
  const fields=body.slice(open+1,close),lex=createJavaScriptLexicalIndex(fields);
  if([...fields.matchAll(/\bselect:/gu)].some(hit=>lex.isRoot(hit.index)))throw new Error("Native query already has a select projection");
  return {open:offset+open,close:offset+close,fields};
}
function queryReaders(source) {
  const lexical=createJavaScriptLexicalIndex(source),readers=[];
  for(const head of rootMatches(source,new RegExp(`(?<signal>${ID})=\\(0,(?<framework>${ID})\\.RD\\)\\((?<scope>${ID})\\.(?<scopeExport>${ID}),`,"gu"))){
    const start=head.index+head[0].length,tail=source.slice(start);
    const block=/^\(\{get:(?<get>[A-Za-z_$][\w$]*)\}\)=>\{/u.exec(tail);
    if(block){const open=start+block[0].length-1,end=lexical.matchingBrace(open);if(end<open||source[end+1]!==")")throw new Error("Incomplete native query reader");readers.push({...head.groups,mode:"tpp",callbackStart:start,callbackEnd:end+1,get:block.groups.get,bodyStart:open+1,body:source.slice(open+1,end)});continue;}
    const scoped=new RegExp(`^\\(\\{scope:(?<scopeLocal>${ID})\\}\\)=>(?<builder>${ID})\\(\\k<scopeLocal>,"(?<mode>chat|gizmo|merged)"\\)`,"u").exec(tail);
    if(scoped&&source[start+scoped[0].length]===")"){
      if(scoped.groups.scopeLocal===scoped.groups.builder)throw new Error("Native query scope shadows its options builder");
      readers.push({...head.groups,...scoped.groups,callbackStart:start,callbackEnd:start+scoped[0].length});continue;
    }
    throw new Error("Unsupported native query options reader");
  }
  return readers;
}
function queryExpressionReturn(body) {const value=one(rootMatches(body,/\breturn\b/gu),"native query return");return body.slice(value.index+6).trim().replace(/;$/u,"");}
function capturedQueryBindings(body,names,params,authority) {
  for(const name of [...new Set(names)]){
    if(params.includes(name))throw new Error("Native query callback shadows a captured binding");
    try{new Script(`async function queryCapturedScope(${params.join(",")}){${body};let ${name};}`);}catch{throw new Error(`Native query callback redeclares a captured binding: ${name}`);}
    authority.requireStableBinding(`async function queryCapturedScope(${params.join(",")}){${body}}`,name);
  }
}
function queryPropertyBody(fields,key,header) {
  const hit=one(rootMatches(fields,new RegExp(`${key}:${header}`,"gu")),`query ${key} body`);
  const open=hit.index+hit[0].length-1,close=createJavaScriptLexicalIndex(fields).matchingBrace(open);
  if(close<open)throw new Error("Incomplete native query property body");
  return {body:fields.slice(open+1,close),groups:hit.groups??{},start:open+1,end:close};
}
function querySourceMatch(source) {return typeof source==="string"&&(QUERY_MARKERS.some(marker=>source.includes(marker))||source.includes(".RD)(")&&(source.includes('Request.safeGet("/tpp/models/"')||source.includes('Request.safeGet("/models"')));}
function inspectQueryOwner(source,snapshot,authority) {
  if(!querySourceMatch(source))throw new Error("Not a current query policy body candidate");
  factorySyntax(source,snapshot);
  requireFactoryAuthority(source,snapshot,authority);
  if(QUERY_MARKERS.some(marker=>source.includes(marker)))throw new Error("Expected native query source");
  const readers=queryReaders(source),map=exportMaps(source,snapshot);
  if(readers.length===0)throw new Error("Missing native query reader");
  const modes=readers.map(reader=>reader.mode),tpp=readers.length===1&&modes[0]==="tpp";
  if(!tpp&&(readers.length!==3||new Set(modes).size!==3||!modes.every(mode=>["chat","gizmo","merged"].includes(mode))))throw new Error("Ambiguous native query reader modes");
  const scopes=readers.map(reader=>`${reader.framework}:${reader.scope}:${reader.scopeExport}`);
  if(new Set(scopes).size!==1)throw new Error("Mismatched native query scopes");
  const first=readers[0],framework=queryImport(source,snapshot,first.framework,authority),scope=queryImport(source,snapshot,first.scope,authority);
  for(const reader of readers){
    const init=one(rootMatches(source,new RegExp(`(?<![\\w$.])${escapeRegExp(reader.signal)}=(?!=|>)`,"gu")),"query signal initializer");
    authority.requireStableBinding(source,reader.signal,init.index);
    reader.exportName=one([...map.publications].filter(([,pub])=>pub.expression===reader.signal),"query reader publication")[0];
  }
  let catalog,normalizerExport,identity=null,nativePlan=null,cacheImport=null,cacheProof=null,builder=null;
  if(tpp){
    const reader=first,get=escapeRegExp(reader.get),body=reader.body;
    authority.requireStableBinding(body,reader.get);
    reader.options=rootReturnedObject(body,reader.bodyStart);
    const tupleMatch=one(rootMatches(body,new RegExp(`(?<account>${ID})=${get}\\((?<identity>${ID})\\.(?<accountExport>${ID})\\),(?<user>${ID})=${get}\\(\\k<identity>\\.(?<preferredUserExport>${ID})\\)\\?\\?${get}\\(\\k<identity>\\.(?<userExport>${ID})\\),(?<ready>${ID})=null!=\\k<account>&&null!=\\k<user>,(?<cacheKey>${ID})=`,"gu")),"TPP identity tuple"),tuple=tupleMatch.groups;
    const norm=[...body.matchAll(new RegExp(`\\(0,(?<catalog>${ID})\\.(?<normalizer>${ID})\\)\\((?<response>${ID})(?:\\.response)?\\)`,"gu"))].filter(hit=>createJavaScriptLexicalIndex(body).isCode(hit.index));
    const placeholder=one(norm.filter(hit=>hit[0].endsWith(".response)")),"TPP cached response normalization");
    const n=placeholder.groups;
    if(norm.filter(hit=>hit.groups.catalog===n.catalog&&hit.groups.normalizer===n.normalizer).length!==2)throw new Error("Unsupported TPP normalization publication");catalog=queryImport(source,snapshot,n.catalog,authority);normalizerExport=n.normalizer;
    const captured=[tuple.account,tuple.user,tuple.ready,tuple.cacheKey];
    if(new Set([...captured,reader.get]).size!==captured.length+1||captured.includes(tuple.identity)||captured.includes(n.catalog)||reader.get===tuple.identity||reader.get===n.catalog)throw new Error("Aliased TPP query roles");
    for(const name of captured){const init=one(rootMatches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?!=|>)`,"gu")),"TPP local initializer");authority.requireStableBinding(body,name,init.index);}
    const fields=reader.options.fields;
    const network=queryPropertyBody(fields,"queryFn",`async\\(\\{signal:(?<signal>${ID})\\}\\)=>\\{`);
    const cached=queryPropertyBody(fields,"placeholderData",`\\(\\)=>\\{`);
    const raw=one(rootMatches(network.body,new RegExp(`let (?<raw>${ID})=await (?<request>${ID})\\.Request\\.safeGet\\("/tpp/models/"`,"gu")),"TPP raw request").groups;
    queryImport(source,snapshot,raw.request,authority);
    const normalized=one(rootMatches(network.body,new RegExp(`(?<value>${ID})=\\(0,${escapeRegExp(n.catalog)}\\.${escapeRegExp(n.normalizer)}\\)\\(${escapeRegExp(raw.raw)}\\)`,"gu")),"TPP raw normalization").groups;
    const tail=new RegExp(`^${escapeRegExp(network.groups.signal)}\\.throwIfAborted\\(\\),${escapeRegExp(tuple.ready)}&&\\(0,(?<cache>${ID})\\.(?<write>${ID})\\)\\(${escapeRegExp(tuple.cacheKey)},\\{fetchedAt:Date\\.now\\(\\),response:${escapeRegExp(raw.raw)}\\}\\),${escapeRegExp(normalized.value)}$`,"u").exec(queryExpressionReturn(network.body));
    if(tail==null)throw new Error("Unsupported TPP raw cache/abort return");
    cacheImport={...queryImport(source,snapshot,tail.groups.cache,authority),writeExport:tail.groups.write};
    capturedQueryBindings(network.body,[n.catalog,raw.request,tail.groups.cache,...captured,"Date"],[network.groups.signal],authority);
    const cacheUse=one(rootMatches(cached.body,new RegExp(`let (?<value>${ID})=\\(0,${escapeRegExp(n.catalog)}\\.${escapeRegExp(n.normalizer)}\\)\\((?<cached>${ID})\\.response\\)`,"gu")),"TPP cached raw normalization").groups;
    capturedQueryBindings(cached.body,[n.catalog,cacheUse.cached,"Date"],[],authority);
    if([...captured,reader.get,n.catalog,tuple.identity].includes(cacheUse.cached))throw new Error("Aliased TPP cached response role");
    const keyTemplate='`chatgpt-work-models-v1/${encodeURIComponent('+tuple.user+'??"")}/${encodeURIComponent('+tuple.account+'??"")}`';
    if(!body.startsWith(keyTemplate+",",tupleMatch.index+tupleMatch[0].length))throw new Error("Unsupported TPP encoded identity cache key");
    const cacheInit=one(rootMatches(body,new RegExp(`(?<![\\w$.])${escapeRegExp(cacheUse.cached)}=${escapeRegExp(tuple.ready)}&&${get}\\((?<enabled>${ID})\\)\\?(?<schema>${ID})\\.safeParse\\(\\(0,(?<cache>${ID})\\.(?<read>${ID})\\)\\(${escapeRegExp(tuple.cacheKey)}\\)\\)\\.data:void 0(?=[,;])`,"gu")),"TPP ready/schema/cache read");
    const read=cacheInit.groups;
    if(read.cache!==cacheImport.localName)throw new Error("TPP cache read/write namespaces differ");
    cacheImport.readExport=read.read;
    authority.requireStableBinding(body,cacheUse.cached,cacheInit.index);
    const gate=one(rootMatches(source,new RegExp(`(?<![\\w$.])${escapeRegExp(read.enabled)}=\\(0,${escapeRegExp(first.framework)}\\.vP\\)\\(${escapeRegExp(first.scope)}\\.${escapeRegExp(first.scopeExport)},!0,\\{getServerSnapshot:\\(\\)=>!1\\}\\)`,"gu")),"TPP native cache enabled gate");
    authority.requireStableBinding(source,read.enabled,gate.index);
    const schema=one(rootMatches(source,new RegExp(`(?<![\\w$.])${escapeRegExp(read.schema)}=(?<provider>${ID})\\.object\\(\\{fetchedAt:\\k<provider>\\.number\\(\\),response:\\k<provider>\\.unknown\\(\\)\\}\\)`,"gu")),"TPP timestamp/raw-response cache schema");
    authority.requireStableBinding(source,read.schema,schema.index);
    const schemaImport=queryImport(source,snapshot,schema.groups.provider,authority);
    const roles=[reader.get,...captured,cacheUse.cached,read.enabled,read.schema,n.catalog,tuple.identity,read.cache];
    if(new Set(roles).size!==roles.length)throw new Error("Aliased TPP cache/key/schema roles");
    capturedQueryBindings(body,[n.catalog,tuple.identity,read.enabled,read.schema,read.cache,"Date","encodeURIComponent"],[reader.get],authority);
    for(const builtin of ["Date","encodeURIComponent"]){
      if(snapshot.params.includes(builtin))throw new Error(`Captured TPP cache builtin: ${builtin}`);
      authority.requireStableBinding(source,builtin);
    }
    const cachedPattern=new RegExp(`^if\\(null==${escapeRegExp(cacheUse.cached)}\\|\\|Date\\.now\\(\\)-${escapeRegExp(cacheUse.cached)}\\.fetchedAt>=864e5\\)return;let ${escapeRegExp(cacheUse.value)}=\\(0,${escapeRegExp(n.catalog)}\\.${escapeRegExp(n.normalizer)}\\)\\(${escapeRegExp(cacheUse.cached)}\\.response\\);return ${escapeRegExp(cacheUse.value)}\\.options\\.length>0\\?${escapeRegExp(cacheUse.value)}:void 0$`,"u");
    if(!cachedPattern.test(cached.body))throw new Error("Unsupported TPP cached response TTL/return");
    cacheProof={encodedIdentityKey:keyTemplate,ttlMilliseconds:86400000,cacheEnabledAtom:read.enabled,schema:{localName:read.schema,provider:schemaImport,fetchedAt:"number",response:"unknown"}};

    if(!body.includes('Request.safeGet("/tpp/models/"')||!body.includes(`additionalHeaders:${tuple.ready}?{"ChatGPT-Account-ID":${tuple.account}}:void 0`)||
       !body.includes(`expectedIdentity:${tuple.ready}?{accountId:${tuple.account},userId:${tuple.user}}:void 0`)||
       !body.includes(`queryKey:${tuple.ready}?["chatgpt-tpp-models",${tuple.account},${tuple.user}]:["chatgpt-tpp-models"]`)||
       !body.includes('.throwIfAborted()')||!body.includes('placeholderData:')||!body.includes('response:'))throw new Error("Unsupported TPP identity/cache/abort paths");
    const plan=one([...body.matchAll(new RegExp(`\\(0,${ID}\\.${ID}\\)\\(${get}\\((?<identity>${ID})\\.(?<exportName>${ID})\\)\\)\\?\\{refetchOnMount:"always"`,"gu"))].filter(hit=>createJavaScriptLexicalIndex(body).isCode(hit.index)),"TPP plan dependency").groups;
    if(plan.identity!==tuple.identity)throw new Error("TPP plan is not the identity namespace");
    identity={...queryImport(source,snapshot,tuple.identity,authority),accountExport:tuple.accountExport,preferredUserExport:tuple.preferredUserExport,userExport:tuple.userExport};
    nativePlan={moduleId:identity.moduleId,exportName:plan.exportName};
  }else{
    if(new Set(readers.map(reader=>reader.builder)).size!==1)throw new Error("Mismatched chat query builders");
    builder=namedFunction(source,first.builder,authority);
    const params=builder.params.split(",");
    if(params.length!==2||new Set(params).size!==2||!params.every(name=>new RegExp(`^${ID}$`,"u").test(name)))throw new Error("Unsupported chat query scope/mode parameters");
    const [scopeName,modeName]=params,queryScope=escapeRegExp(scopeName),mode=escapeRegExp(modeName);
    const options=rootReturnedObject(builder.body),network=queryPropertyBody(options.fields,"queryFn","async\\(\\)=>\\{");
    const shape=new RegExp(
      `^let (?<context>${ID})=function\\((?<localScope>${ID})\\)\\{try\\{if\\(!\\k<localScope>\\.get\\((?<flags>${ID})\\.(?<flagExport>${ID}),(?<gate>"[0-9]+")\\)\\)return;`+
      `let (?<user>${ID})=\\k<localScope>\\.get\\((?<identity>${ID})\\.(?<userExport>${ID})\\),(?<account>${ID})=\\k<localScope>\\.get\\(\\k<identity>\\.(?<accountExport>${ID})\\);`+
      `return null==\\k<user>\\|\\|null==\\k<account>\\?void 0:(?<telemetry>${ID})\\.(?<telemetryExport>${ID})\\.modelsRequestContext\\(\\k<user>,\\k<account>\\)\\}catch\\{return\\}\\}\\(${queryScope}\\),`+
      `(?<requestId>${ID})=null,(?<raw>${ID})=await (?<request>${ID})\\.Request\\.safeGet\\("/models",\\{onResponseHeaders:void 0===\\k<context>\\?void 0:(?<headers>${ID})=>\\{\\k<requestId>=\\k<headers>\\.get\\("x-oai-request-id"\\)\\},`+
      `parameters:\\{query:\\{iim:!1,include_icons:!1,is_gizmo:"gizmo"===${mode},merged:"merged"===${mode}\\|\\|void 0\\}\\}\\}\\),(?<normalized>${ID})=\\(0,(?<catalog>${ID})\\.(?<normalizer>${ID})\\)\\(\\k<raw>\\);`+
      `try\\{void 0!==\\k<context>&&null!=\\k<requestId>&&${queryScope}\\.get\\(\\k<identity>\\.\\k<userExport>\\)===\\k<context>\\.userId&&${queryScope}\\.get\\(\\k<identity>\\.\\k<accountExport>\\)===\\k<context>\\.accountId&&`+
      `${queryScope}\\.get\\(\\k<flags>\\.\\k<flagExport>,\\k<gate>\\)&&\\k<telemetry>\\.\\k<telemetryExport>\\.modelsResponseReceived\\(\\k<context>,\\k<requestId>\\)\\}catch\\{\\}return \\k<normalized>$`,"u");
    const body=shape.exec(network.body)?.groups;
    const tail=new RegExp(`^,queryKey:"chat"===${mode}\\?\\["chatgpt-models"\\]:\\["chatgpt-models",${mode}\\],refetchOnWindowFocus:!0,staleTime:(?<timer>${ID})\\.D\\.FIVE_MINUTES$`,"u").exec(options.fields.slice(network.end+1))?.groups;
    if(body==null||tail==null)throw new Error("Unsupported chat/gizmo/merged native options");
    for(const name of params)authority.requireStableBinding(builder.body,name);
    const imports=[body.request,body.catalog,body.identity,body.flags,body.telemetry];
    if(new Set([scopeName,modeName,...imports]).size!==imports.length+2)throw new Error("Aliased chat query captured roles");
    for(const name of imports)queryImport(source,snapshot,name,authority);
    queryImport(source,snapshot,tail.timer,authority);
    capturedQueryBindings(network.body,[scopeName,modeName,...imports],[],authority);
    catalog=queryImport(source,snapshot,body.catalog,authority);normalizerExport=body.normalizer;

  }
  return {role:"query",kind:tpp?"tpp":"chatgpt",moduleId:snapshot.moduleId,frameworkModuleId:framework.moduleId,scope:{moduleId:scope.moduleId,exportName:first.scopeExport},catalogImport:{...catalog,normalizerExport},identity,nativePlan,cacheImport,cacheProof,readers,builder};
}
function queryProtocol(bindings,owner) {
  const {catalog,plan,visibility,workspaceClamp}=bindings??{};
  for(const [name,value]of Object.entries({catalog,plan,visibility,workspaceClamp}))if(value==null)throw new Error(`Missing catalog policy ${name} bindings`);
  const ids=[catalog,plan,visibility,workspaceClamp,workspaceClamp.effortNames];
  for(const entry of ids)if(typeof entry?.moduleId!=="string"||typeof entry.exportName!="string"&&entry!==catalog)throw new Error("Invalid catalog policy provider reference");
  for(const key of [catalog.normalizerExport,catalog.resolverExport,catalog.capabilityExport,catalog.projectionExport,plan.exportName,plan.accountExport,plan.userExport,visibility.exportName,workspaceClamp.exportName,workspaceClamp.effortNames.exportName])if(!new RegExp(`^${ID}$`,"u").test(key??""))throw new Error("Invalid catalog policy export binding");
  if(catalog.moduleId!==owner.catalogImport.moduleId||catalog.normalizerExport!==owner.catalogImport.normalizerExport)throw new Error("Query normalizer is not the prepared native catalog");
  for(const provider of [plan,visibility])if(provider.scope?.moduleId!==owner.scope.moduleId||provider.scope.exportName!==owner.scope.exportName||provider.frameworkModuleId!==owner.frameworkModuleId)throw new Error("Policy provider has a different native scope");
  if(workspaceClamp.catalogModuleId!==catalog.moduleId)throw new Error("Workspace clamp uses a different catalog");
  if(owner.nativePlan&&(owner.nativePlan.moduleId!==plan.moduleId||owner.nativePlan.exportName!==plan.exportName))throw new Error("TPP native plan binding mismatch");
  if(owner.identity&&(owner.identity.moduleId!==plan.moduleId||owner.identity.accountExport!==plan.accountExport||owner.identity.userExport!==plan.userExport||owner.identity.preferredUserExport!==plan.preferredUserExport))throw new Error("TPP native identity binding mismatch");
  if(owner.cacheImport){
    const cache=bindings.cache;
    if(cache==null||cache.moduleId!==owner.cacheImport.moduleId||cache.readExport!==owner.cacheImport.readExport||cache.writeExport!==owner.cacheImport.writeExport)throw new Error("TPP native cache provider binding mismatch");
  }
  return {catalog,plan,visibility,workspaceClamp};
}
function querySuffix(owner,snapshot,presets,bindings) {
  const b=queryProtocol(bindings,owner),prefix="codexLinuxPreset";
  const imports=[],catalog=owner.catalogImport.localName;
  const plan=owner.identity?.localName??`${prefix}Plan`,visible=`${prefix}Visibility`,clamp=`${prefix}WorkspaceClamp`,names=`${prefix}EffortNames`;
  const requireName=snapshot.params[2];
  for(const [alias,ref,existing]of [[plan,b.plan,owner.identity!=null],[visible,b.visibility,false],[clamp,b.workspaceClamp,false],[names,b.workspaceClamp.effortNames,false]])if(!existing)imports.push(`${alias}=${requireName}(${JSON.stringify(ref.moduleId)})`);
  const get="codexLinuxPresetGet",options="codexLinuxPresetOptions",base="codexLinuxPresetCatalog";
  const preferred=b.plan.preferredUserExport?`${get}(${plan}.${b.plan.preferredUserExport})??`:"";
  const configHash=createHash("sha256").update(JSON.stringify(presets)).digest("hex");
  const code=`;/*${QUERY_MARKER}:${configHash}*/${imports.length?`var ${imports.join(",")};`:""}function ${QUERY_HELPER}(${options},${get}){let codexLinuxPresetPlanValue=${get}(${plan}.${b.plan.exportName});if(null==codexLinuxPresetPlanValue)return ${options};let codexLinuxPresetAccount=${get}(${plan}.${b.plan.accountExport}),codexLinuxPresetUser=${preferred}${get}(${plan}.${b.plan.userExport});if(null==codexLinuxPresetAccount||null==codexLinuxPresetUser)return ${options};let codexLinuxPresetVisible=${get}(${visible}.${b.visibility.exportName});return{...${options},select:${base}=>${catalog}.${b.catalog.projectionExport}(${base},{ready:!0,plan:codexLinuxPresetPlanValue,visibleEfforts:codexLinuxPresetVisible,reasoningEffortNames:${names}.${b.workspaceClamp.effortNames.exportName},resolveNative:${catalog}.${b.catalog.resolverExport},clampCapability:${catalog}.${b.catalog.capabilityExport},clampWorkspace:${clamp}.${b.workspaceClamp.exportName}})}}`;
  return {code,dependencies:{catalog:{...b.catalog,localName:catalog},plan:{...b.plan,localName:plan},visibility:{...b.visibility,localName:visible},workspaceClamp:{...b.workspaceClamp,localName:clamp},effortNames:{...b.workspaceClamp.effortNames,localName:names}}};
}
function queryPatched(native,snapshot,presets,bindings,authority) {
  const owner=inspectQueryOwner(native,snapshot,authority);
  const suffix=querySuffix(owner,snapshot,presets,bindings);
  const edits=owner.readers.map(reader=>{
    if(reader.mode==="tpp")return{start:reader.options.open,end:reader.options.close+1,text:` ${QUERY_HELPER}(${native.slice(reader.options.open,reader.options.close+1)},${reader.get})`};
    return{start:reader.callbackStart,end:reader.callbackEnd,text:`({scope:${reader.scopeLocal},get:codexLinuxPresetGet})=>${QUERY_HELPER}(${reader.builder}(${reader.scopeLocal},${JSON.stringify(reader.mode)}),codexLinuxPresetGet)`};
  });
  let patched=native;for(const edit of edits.sort((a,b)=>b.start-a.start))patched=patched.slice(0,edit.start)+edit.text+patched.slice(edit.end);
  patched+=suffix.code;factorySyntax(patched,snapshot);
  return {patched,owner,dependencies:suffix.dependencies};
}
function inverseQuery(source) {
  const needle=`;/*${QUERY_MARKER}:`,start=source.indexOf(needle);
  if(start<0||source.lastIndexOf(needle)!==start)throw new Error("Orphan query policy contribution");
  let candidate=source.slice(0,start);
  const heads=rootMatches(candidate,new RegExp(`(?<signal>${ID})=\\(0,(?<framework>${ID})\\.RD\\)\\((?<scope>${ID})\\.(?<scopeExport>${ID}),`,"gu"));
  const lexical=createJavaScriptLexicalIndex(candidate),edits=[];
  for(const head of heads){const a=head.index+head[0].length,tail=candidate.slice(a);
    const chat=new RegExp(`^\\(\\{scope:(?<scopeLocal>${ID}),get:codexLinuxPresetGet\\}\\)=>${QUERY_HELPER}\\((?<builder>${ID})\\(\\k<scopeLocal>,"(?<mode>chat|gizmo|merged)"\\),codexLinuxPresetGet\\)`,"u").exec(tail);
    if(chat){edits.push({start:a,end:a+chat[0].length,text:`({scope:${chat.groups.scopeLocal}})=>${chat.groups.builder}(${chat.groups.scopeLocal},${JSON.stringify(chat.groups.mode)})`});continue;}
    const block=/^\(\{get:(?<get>[A-Za-z_$][\w$]*)\}\)=>\{/u.exec(tail);if(block==null)throw new Error("Partial query policy reader");
    const open=a+block[0].length-1,end=lexical.matchingBrace(open),body=candidate.slice(open+1,end);
    const returned=one(rootMatches(body,/\breturn\b/gu),"projected query return");
    const from=open+1+returned.index+6;let wrapper=from;while(/\s/u.test(candidate[wrapper]??"")&&wrapper<end)wrapper++;
    const prefix=`${QUERY_HELPER}(`;if(!candidate.startsWith(prefix,wrapper))throw new Error("Partial query policy options wrapper");
    const object=wrapper+prefix.length,close=lexical.matchingBrace(object),suffix=`,${block.groups.get})`;
    if(candidate[object]!=="{"||close<object||candidate.slice(close+1,end).trim()!==suffix)throw new Error("Partial query policy options");
    if(candidate[wrapper-1]!==" ")throw new Error("Noncanonical query policy return spacing");
    edits.push({start:wrapper-1,end:close+1+suffix.length,text:candidate.slice(object,close+1)});
  }
  if(edits.length===0)throw new Error("Missing query policy readers");
  for(const edit of edits.sort((a,b)=>b.start-a.start))candidate=candidate.slice(0,edit.start)+edit.text+candidate.slice(edit.end);
  if(QUERY_MARKERS.some(marker=>candidate.includes(marker)))throw new Error("Orphan query policy marker");
  return candidate;
}
function prepareQueryFactory(source,snapshot,presets,bindings={},authority) {
  if(!querySourceMatch(source))throw new Error("Not a current query policy body candidate");
  if(snapshot?.moduleSource!==source)throw new Error("Stale query policy snapshot");
  if(!Array.isArray(presets))throw new Error("Query policy requires normalized presets");
  factorySyntax(source,snapshot);
  requireFactoryAuthority(source,snapshot,authority);
  const applied=QUERY_MARKERS.some(marker=>source.includes(marker));
  if(presets.length===0){if(applied)throw new Error("Non-native empty query audit");const owner=inspectQueryOwner(source,snapshot,authority);return{state:"pristine",nativeSource:source,patchedSource:source,proof:{...owner,readers:owner.readers.map(r=>({mode:r.mode,exportName:r.exportName})),auditOnly:true}};}
  const native=applied?inverseQuery(source):source;
  if(native.includes("codexLinuxPreset")||snapshot.params.some(name=>name.startsWith("codexLinuxPreset")))throw new Error("Captured query policy namespace");
  const made=queryPatched(native,{...snapshot,moduleSource:native},presets,bindings,authority);
  if(applied&&made.patched!==source)throw new Error("Noncanonical or stale query policy replay");
  return{state:applied?"applied":"pristine",nativeSource:native,patchedSource:made.patched,proof:{role:"query",kind:made.owner.kind,auditOnly:false,moduleId:snapshot.moduleId,scope:made.owner.scope,frameworkModuleId:made.owner.frameworkModuleId,originalCatalogImport:made.owner.catalogImport,identity:made.owner.identity,nativePlan:made.owner.nativePlan,cacheImport:made.owner.cacheImport,cacheProof:made.owner.cacheProof,readers:made.owner.readers.map(r=>({mode:r.mode,exportName:r.exportName})),addedDependencies:made.dependencies,preservedNativePaths:true}};
}

module.exports = {
  projectCatalog:codexLinuxApplyDefaultPresets,
  resolveVariant:codexLinuxDefaultPresetVariant,
  prepareCatalogFactory,
  ...require("./native-policy-providers.js"),
  inspectQueryOwner,
  prepareQueryFactory,
  queryMarkers:QUERY_MARKERS,
  constants:{PROJECT,RESOLVE,CONFIG,VARIANTS,STAMP,SERVER_VARIANTS,QUERY_MARKER,QUERY_HELPER},
  catalogMarkers:CATALOG_MARKERS,
  catalogSourceMatch,
  querySourceMatch,
};
