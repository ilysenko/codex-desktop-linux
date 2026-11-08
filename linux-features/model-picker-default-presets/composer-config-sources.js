"use strict";
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {requireStableCatalogBinding:stable}=require("./catalog-binding-authority.js");
const {assertCriticalLoaderMethodUses}=require("./critical-loader-authority.js");
const {findSynchronousFunctionDeclaration}=require("./synchronous-function-declaration.js");
const ID="[A-Za-z_$][\\w$]*",STRING='"(?:\\\\.|[^"\\\\])*"';
const one=(rows,label)=>{if(rows.length!==1)throw Error(`Missing or ambiguous native composer ${label}`);return rows[0]};
const distinct=(names,label)=>{if(new Set(names).size!==names.length)throw Error(`Aliased native composer ${label}`)};
const noCapture=(names,captured,label)=>{if(names.some(name=>captured.includes(name)))throw Error(`Shadowed native composer ${label}`)};
const same=(a,b,label)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(`Inconsistent native composer ${label}`)};
const validName=value=>typeof value==="string"&&new RegExp(`^${ID}$`,"u").test(value);

function frame(source,snapshot,allowInterop=false){
 if(typeof snapshot?.moduleId!=="string"||!snapshot.moduleId)throw Error("Invalid native composer module identity");
 const loaderUses=assertCriticalLoaderMethodUses(source,snapshot,{allowInterop}),module={...snapshot,start:snapshot.start??0,moduleSource:source},lexical=createJavaScriptLexicalIndex(source);
 const roots=expression=>[...source.matchAll(expression)].filter(hit=>lexical.isRoot(hit.index));
 function bind(name,index){if(!validName(name)||module.params.includes(name)||source.slice(index,index+name.length)!==name)throw Error("Invalid native composer initializer");stable(source,name,index);let conflicts=false;try{new Script(`"use strict";function composerRoot(${module.params.join(",")}){\n${source}\n;let ${name};\n}`)}catch{conflicts=true}if(!conflicts)throw Error("Native composer initializer has no root declaration")}
 function imported(name){const binding=findRspackRequireBinding(module,name);if(!binding||module.params.includes(name))throw Error(`Missing native composer import ${name}`);stable(source,name,binding.start-module.start);return{localName:name,moduleId:binding.moduleId}}
 const ref=(name,exportName)=>({...imported(name),exportName});
 function pub(key){if(!validName(key))throw Error("Invalid native composer publication key");const found=findRspackExportPublication(module,key);if(!found)throw Error(`Missing native composer publication ${key}`);return found}
 function fn(key){const publication=pub(key);if(publication.fn){const row=publication.fn,text=source.slice(row.start,row.end),head=new RegExp(`^function(?: (?<self>${ID}))?\\(`,"u").exec(text);if(!head)throw Error("Native composer publication is not synchronous");return{...row,source:text,selfName:head.groups.self??null,publication}}
  if(!validName(publication.expression))throw Error("Native composer publication is not a function");return{...findSynchronousFunctionDeclaration(source,module,publication.expression),selfName:publication.expression,publication};}
 const named=name=>findSynchronousFunctionDeclaration(source,module,name);
 function beforePublication(end){if(end>loaderUses.find(row=>row.method==="d").index)throw Error("Native composer value is initialized after publication")}
 return{source,module,roots,bind,imported,ref,pub,fn,named,beforePublication,loaderUses};
}

function inspectConfigProvider(source,snapshot,options={}){
 const {globalExport,localExport}=options;if(globalExport===localExport)throw Error("Config publications must be distinct");
 const f=frame(source,snapshot,true),global=f.pub(globalExport),local=f.pub(localExport);if(!validName(global.expression)||!validName(local.expression))throw Error("Config providers are not native atom bindings");
 const globalPattern=new RegExp([
  String.raw`(?<![\w$.])${escapeRegExp(global.expression)}=\(0,(?<framework>${ID})\.(?<derived>${ID})\)\((?<scope>${ID})\.(?<scopeExport>${ID}),\(\{get:(?<get>${ID})\}\)=>\{let (?<identity>${ID})=\k<get>\((?<identityNamespace>${ID})\.(?<identityExport>${ID})\);`,
  String.raw`if\(\k<identity>\.authLoading\|\|"chatgpt"!==\k<identity>\.authMethod\|\|!1===\k<identity>\.hasChatGptToken\|\|null==\k<identity>\.authenticatedAccountId\|\|null==\k<identity>\.userId\)return null;`,
  String.raw`let (?<parsed>${ID})=(?<schema>${ID})\.safeParse\(\k<get>\((?<experiment>${ID})\.(?<experimentExport>${ID}),(?<flag>${STRING})\)\?\.value\);return \k<parsed>\.success&&\k<parsed>\.data\.presets\.some\((?<entry>${ID})=>\k<entry>\.length>0\)\?\k<parsed>\.data:null\},\{isEqual:(?<equal>${ID})\(\)\}\)(?=[,;])`,
 ].join(""),"gu");
 const globalHit=one(f.roots(globalPattern),"global config atom"),g=globalHit.groups;
 distinct([g.get,g.identity,g.parsed],"global config locals");noCapture([g.get,g.identity,g.parsed],[g.identityNamespace,g.experiment,g.schema],"global config captured providers");
 const schemaHit=one(f.roots(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(g.schema)}=(?<namespace>${ID})\.object\(\{presets:\k<namespace>\.array\(\k<namespace>\.array\(\k<namespace>\.object\(\{model:\k<namespace>\.string\(\)\.min\(1\),reasoning_effort:\k<namespace>\.string\(\)\.min\(1\)\}\)\)\)\}\)(?=[,;])`,"gu")),"config preset schema");
 f.bind(g.schema,schemaHit.index);f.bind(global.expression,globalHit.index);f.beforePublication(globalHit.index+globalHit[0].length);
 const req=escapeRegExp(snapshot.params[2]),interop=one(f.roots(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(g.equal)}=${req}\.n\((?<namespace>${ID})\)(?=[,;])`,"gu")),"config equality interop");
 const equalBinding=findRspackRequireBinding(f.module,interop.groups.namespace);if(!equalBinding||equalBinding.end-f.module.start>interop.index)throw Error("Config equality interop precedes its import");f.bind(g.equal,interop.index);
 const localPattern=new RegExp([
  String.raw`(?<![\w$.])${escapeRegExp(local.expression)}=\(0,(?<framework>${ID})\.(?<parameterized>${ID})\)\((?<scope>${ID})\.(?<scopeExport>${ID}),\(\{conversationId:(?<conversation>${ID}),hostId:(?<host>${ID}),cwd:(?<cwd>${ID})\},\{get:(?<get>${ID})\}\)=>\{if\("local"!==\k<host>\)return null;`,
  String.raw`let (?<config>${ID})=\k<get>\((?<effectiveConfig>${ID})\.(?<configExport>${ID}),\{hostId:\k<host>,cwd:\k<cwd>\}\)\.data;return null==\k<config>\|\|\(\k<get>\((?<providerOverride>${ID})\.(?<providerExport>${ID}),\k<conversation>\)\?\?\k<config>\.model_provider\?\?"openai"\)!=="openai"\|\|\(0,(?<predicate>${ID})\.(?<predicateExport>${ID})\)\(\k<config>\)\|\|\k<get>\((?<reserve>${ID})\.(?<reserveExport>${ID}),\k<host>\)\?null:\k<get>\((?<globalAtom>${ID})\)\}\)(?=[,;])`,
 ].join(""),"gu");
 const localHit=one(f.roots(localPattern),"local config atom"),l=localHit.groups;
 distinct([l.conversation,l.host,l.cwd,l.get,l.config],"local config locals");noCapture([l.conversation,l.host,l.cwd,l.get,l.config],[l.effectiveConfig,l.providerOverride,l.predicate,l.reserve,l.globalAtom],"local config captured providers");
 if(l.globalAtom!==global.expression)throw Error("Local config does not delegate to the native global config");
 f.bind(local.expression,localHit.index);f.beforePublication(localHit.index+localHit[0].length);
 const globalScope=f.ref(g.scope,g.scopeExport),localScope=f.ref(l.scope,l.scopeExport),globalFramework=f.ref(g.framework,g.derived),localFramework=f.ref(l.framework,l.parameterized);
 same({moduleId:globalScope.moduleId,exportName:globalScope.exportName},{moduleId:localScope.moduleId,exportName:localScope.exportName},"config scope");same(globalFramework.moduleId,localFramework.moduleId,"config framework");
 const refs={identity:f.ref(g.identityNamespace,g.identityExport),experiment:{...f.ref(g.experiment,g.experimentExport),flagKey:JSON.parse(g.flag)},effectiveConfig:f.ref(l.effectiveConfig,l.configExport),providerOverride:f.ref(l.providerOverride,l.providerExport),catalogPredicate:f.ref(l.predicate,l.predicateExport),reserve:f.ref(l.reserve,l.reserveExport),schema:{...f.ref(schemaHit.groups.namespace,"object"),methods:["object","array","string"]},equality:{...f.imported(interop.groups.namespace),exportName:null,interopLocalName:g.equal}};
 return{kind:"config-provider",moduleId:snapshot.moduleId,globalExport,localExport,frameworkModuleId:globalFramework.moduleId,scope:globalScope,global:{atomName:global.expression,framework:globalFramework},local:{atomName:local.expression,framework:localFramework,globalConfig:{moduleId:snapshot.moduleId,exportName:globalExport},parameters:["conversationId","hostId","cwd"]},refs,proof:{globalSource:globalHit[0],localSource:localHit[0],schemaSource:schemaHit[0],falseOnlyToken:true,globalIdentityFields:["authLoading","authMethod","hasChatGptToken","authenticatedAccountId","userId"],localHost:"local",providerDefault:"openai",explicitProfileParameter:false,loaderUses:f.loaderUses}};
}

function inspectConfigContext(source,snapshot,options={}){
 const f=frame(source,snapshot),publication=f.pub(options.exportName);if(!validName(publication.expression))throw Error("Config context is not a native binding");
 const req=escapeRegExp(snapshot.params[2]),hit=one(f.roots(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(publication.expression)}=\(0,${req}\((?<react>${STRING})\)\.createContext\)\(null\)(?=[,;])`,"gu")),"null config context initializer");
 f.bind(publication.expression,hit.index);f.beforePublication(hit.index+hit[0].length);
 return{kind:"config-context",moduleId:snapshot.moduleId,exportName:options.exportName,refs:{react:{moduleId:JSON.parse(hit.groups.react),exportName:"createContext",inlineRequire:true}},proof:{defaultValue:null,initializer:hit[0],loaderUses:f.loaderUses}};
}

function inspectEffectiveConfigQuery(source,snapshot,options={}){
 const f=frame(source,snapshot),publication=f.pub(options.exportName);if(!validName(publication.expression))throw Error("Effective config query is not a native binding");
 const accessorPattern=new RegExp(String.raw`(?<![\w$.])${escapeRegExp(publication.expression)}=\(0,(?<framework>${ID})\.(?<accessor>${ID})\)\((?<scope>${ID})\.(?<scopeExport>${ID}),\(\{cwd:(?<cwd>${ID})=null,hostId:(?<host>${ID})\},\{get:(?<get>${ID}),queryClient:(?<client>${ID}),scope:(?<queryScope>${ID})\}\)=>(?<builder>${ID})\(\{scope:\k<queryScope>,queryClient:\k<client>,hostId:\k<host>,cwd:\k<cwd>,enabled:\k<get>\((?<connected>${ID})\.(?<connectedExport>${ID})\)\.includes\(\k<host>\)\}\)\)(?=[,;])`,"gu");
 const accessorHit=one(f.roots(accessorPattern),"effective config accessor"),a=accessorHit.groups;
 distinct([a.cwd,a.host,a.get,a.client,a.queryScope],"effective config accessor locals");noCapture([a.cwd,a.host,a.get,a.client,a.queryScope],[a.builder,a.connected],"effective config accessor captures");
 const builder=f.named(a.builder),params=new RegExp(String.raw`^\{scope:(?<scope>${ID}),queryClient:(?<client>${ID}),hostId:(?<host>${ID}),cwd:(?<cwd>${ID}),enabled:(?<enabled>${ID})\}$`,"u").exec(builder.params)?.groups;if(!params)throw Error("Drifted effective config builder parameters");
 const p=Object.fromEntries(Object.entries(params).map(([key,value])=>[key,escapeRegExp(value)]));
 const bodyPattern=new RegExp(String.raw`^return\(0,(?<adapter>${ID})\.(?<adapterExport>${ID})\)\(\{enabled:${p.enabled},queryFn:async\(\)=>\{try\{let (?<response>${ID})=await ?\(0,(?<reader>${ID})\.(?<readExport>${ID})\)\(${p.scope},${p.client},${p.host},${p.cwd},!1\);return\(0,(?<transform>${ID})\.(?<transformExport>${ID})\)\(\k<response>\.config\)\}catch\{return null\}\},queryKey:\[\.\.\.(?<key>${ID}),${p.host},${p.cwd}\],staleTime:(?<timer>${ID})\.D\.FIVE_MINUTES\}\)$`,"u");
 const b=bodyPattern.exec(builder.body)?.groups;if(!b)throw Error("Drifted effective config builder body");
 distinct(Object.values(params),"effective config builder parameters");noCapture(Object.values(params),[b.adapter,b.reader,b.transform,b.key,b.timer],"effective config builder imports");noCapture([b.response],[b.reader,b.transform,params.scope,params.client,params.host,params.cwd],"effective config query response");
 const keyHit=one(f.roots(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(b.key)}=(?<array>\["user-saved-config"\])(?=[,;])`,"gu")),"native config query key");f.bind(b.key,keyHit.index);f.bind(publication.expression,accessorHit.index);f.beforePublication(accessorHit.index+accessorHit[0].length);
 const refs={framework:f.ref(a.framework,a.accessor),scope:f.ref(a.scope,a.scopeExport),connectedHosts:f.ref(a.connected,a.connectedExport),queryAdapter:f.ref(b.adapter,b.adapterExport),reader:f.ref(b.reader,b.readExport),profileTransform:f.ref(b.transform,b.transformExport),timer:f.ref(b.timer,"D")};
 return{kind:"effective-config-query",moduleId:snapshot.moduleId,exportName:options.exportName,frameworkModuleId:refs.framework.moduleId,scope:refs.scope,queryKeyPrefix:JSON.parse(keyHit.groups.array),refs,proof:{accessorSource:accessorHit[0],builderSource:builder.source,builderName:a.builder,queryKeyFields:["hostId","cwd"],cwdDefault:null,connectedHostGate:true,readerArgs:["scope","queryClient","hostId","cwd",false],queryFnAsync:true,readErrorReturns:null,profileTransformAppliedBeforeData:true,explicitProfileCacheKey:false,loaderUses:f.loaderUses}};
}

function inspectProfileAlias(source,snapshot,options={}){
 const f=frame(source,snapshot),publication=f.pub(options.exportName),parts=new RegExp(String.raw`^(?<namespace>${ID})\.(?<key>${ID})$`,"u").exec(publication.expression??"")?.groups;if(!parts)throw Error("Profile alias is not a native namespace reexport");
 return{kind:"profile-alias",moduleId:snapshot.moduleId,exportName:options.exportName,refs:{target:f.ref(parts.namespace,parts.key)},proof:{expression:publication.expression,loaderUses:f.loaderUses}};
}

function inspectProfileOverlay(source,snapshot,options={}){
 const f=frame(source,snapshot),fn=f.fn(options.exportName),input=validName(fn.params)?fn.params:null;if(!input)throw Error("Invalid native profile overlay parameter");const c=escapeRegExp(input);
 const pattern=new RegExp(String.raw`^let (?<profiles>${ID})=(?<parser>${ID})\(${c}\.profiles\),(?<selected>${ID})="string"==typeof ${c}\.profile\?\k<parser>\(\k<profiles>\?\.\[${c}\.profile\]\):null;if\(null==\k<selected>\)return ${c};let (?<result>${ID})=\{\.\.\.${c}\};for\(let\[(?<key>${ID}),(?<value>${ID})\]of Object\.entries\(\k<selected>\)\)null!=\k<value>&&\(\k<result>\[\k<key>\]=\k<value>\);return \k<result>$`,"u");
 const o=pattern.exec(fn.body)?.groups;if(!o)throw Error("Drifted native profile overlay");
 distinct([input,o.profiles,o.selected,o.result],"profile overlay locals");distinct([o.key,o.value],"profile overlay loop");noCapture([input,o.profiles,o.selected,o.result,...(fn.selfName?[fn.selfName]:[])],[o.parser,"Object"],"profile overlay captures");noCapture([o.key,o.value],[o.selected,o.result,"Object"],"profile overlay loop captures");if(snapshot.params.includes("Object"))throw Error("Shadowed native Object builtin");stable(source,"Object");
 const parser=f.named(o.parser),parseParams=validName(parser.params)?parser.params:null;if(!parseParams)throw Error("Invalid native profile parser parameter");const pp=escapeRegExp(parseParams),parsed=new RegExp(String.raw`^let (?<parsed>${ID})=(?<schema>${ID})\.safeParse\(${pp}\);return \k<parsed>\.success\?\k<parsed>\.data:null$`,"u").exec(parser.body)?.groups;if(!parsed)throw Error("Drifted native profile parser");
 distinct([parseParams,parsed.parsed],"profile parser locals");noCapture([parseParams,parsed.parsed],[parsed.schema],"profile parser schema");
 const schemaHit=one(f.roots(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(parsed.schema)}=(?<namespace>${ID})\.record\(\k<namespace>\.string\(\),\k<namespace>\.json\(\)\)(?=[,;])`,"gu")),"profile record schema");f.bind(parsed.schema,schemaHit.index);
 return{kind:"profile-overlay",moduleId:snapshot.moduleId,exportName:options.exportName,refs:{recordSchema:f.ref(schemaHit.groups.namespace,"record")},proof:{functionSource:fn.source,parserSource:parser.source,schemaSource:schemaHit[0],selectedProfileField:"profile",profilesField:"profiles",nonNullOverlayOnly:true,missingProfileReturnsInputIdentity:true,explicitWritesToConfig:false,loaderUses:f.loaderUses}};
}

function inspectModelCatalogPredicate(source,snapshot,options={}){
 const f=frame(source,snapshot),fn=f.fn(options.exportName),input=validName(fn.params)?escapeRegExp(fn.params):null;if(!input||!new RegExp(String.raw`^return"string"==typeof ${input}\?\.model_catalog_json&&${input}\.model_catalog_json\.trim\(\)\.length>0$`,"u").test(fn.body))throw Error("Drifted native model catalog predicate");
 return{kind:"model-catalog-predicate",moduleId:snapshot.moduleId,exportName:options.exportName,refs:{},proof:{functionSource:fn.source,field:"model_catalog_json",nonEmptyTrimmedString:true,notGeneralProviderPredicate:true,loaderUses:f.loaderUses}};
}
module.exports={inspectConfigProvider,inspectConfigContext,inspectEffectiveConfigQuery,inspectProfileAlias,inspectProfileOverlay,inspectModelCatalogPredicate};
