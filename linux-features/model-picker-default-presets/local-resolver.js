"use strict";
const path=require("node:path");
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,patchRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {javascriptSourceParses}=require("../../scripts/patches/lib/javascript-syntax.js");
const {requireStableCatalogBinding:stable}=require("./catalog-binding-authority.js");
const {assertCriticalLoaderMethodUses}=require("./critical-loader-authority.js");
const {findSynchronousFunctionDeclaration}=require("./synchronous-function-declaration.js");
const ID="[A-Za-z_$][\\w$]*",JSON_STRING='"(?:\\\\.|[^"\\\\])*"';
const MARKER="codex-linux-model-picker-default-presets-local-composer-resolver";
const FLAG="codexLinuxIsConfiguredDefaultPresets";
const NEEDLES=["removeXHigh:","sliderModelsConfig:","stripGptPrefix:",".presets){"];
const one=(values,label)=>{if(values.length!==1)throw Error(`Missing or ambiguous local Default ${label}`);return values[0]};
const distinct=(names,label)=>{if(new Set(names).size!==names.length)throw Error(`Aliased local Default ${label}`)};
const noCapture=(names,captured,label)=>{if(names.some(name=>captured.includes(name)))throw Error(`Shadowed local Default ${label}`)};

function frame(source,module,allowInterop=false){
 const loaderUses=assertCriticalLoaderMethodUses(source,module,{allowInterop});
 const snapshot={...module,start:module.start??0,moduleSource:source},lexical=createJavaScriptLexicalIndex(source);
 const root=pattern=>[...source.matchAll(pattern)].filter(hit=>lexical.isRoot(hit.index));
 function imported(name){const binding=findRspackRequireBinding(snapshot,name);if(!binding||module.params.includes(name))throw Error("Invalid local Default import");stable(source,name,binding.start-snapshot.start);return{localName:name,moduleId:binding.moduleId}}
 function named(name){return findSynchronousFunctionDeclaration(source,snapshot,name)}
 return{source,snapshot,lexical,root,imported,named,loaderUses};
}

const QV_PATTERN=new RegExp([
 String.raw`^function\((?<models>${ID}),\{removeXHigh:(?<remove>${ID})=!1,sliderModelsConfig:(?<config>${ID}),stripGptPrefix:(?<strip>${ID})=!0\}=\{\}\)\{`,
 String.raw`if\(null!=\k<config>\)\{let (?<mapped>${ID})=(?<normalizer>${ID})\(\k<models>,\{stripGptPrefix:\k<strip>\}\);for\(let (?<group>${ID}) of \k<config>\.presets\)\{`,
 String.raw`let (?<pairs>${ID})=\k<group>\.filter\(\(\{reasoning_effort:(?<filterEffort>${ID})\}\)=>!\k<remove>\|\|"xhigh"!==\k<filterEffort>\)\.flatMap\(\(\{model:(?<model>${ID}),reasoning_effort:(?<effort>${ID})\}\)=>\{let (?<found>${ID})=\k<mapped>\.find\((?<candidate>${ID})=>\k<candidate>\.model===\k<model>&&\k<candidate>\.reasoningEffort===\k<effort>\);return null==\k<found>\?\[\]:\[\k<found>\]\}\),`,
 String.raw`(?<deduped>${ID})=(?<unique>${ID})\(\)\((?<intersection>${ID})\(\k<pairs>,\k<models>,\k<strip>\),\(\{id:(?<uniqueId>${ID})\}\)=>\k<uniqueId>\);if\(\k<deduped>\.length>=3\)return \k<deduped>\}\}`,
 String.raw`let (?<first>${ID})=\k<intersection>\((?<fallbackA>${ID})\.filter\(\(\{reasoningEffort:(?<firstEffort>${ID})\}\)=>!\k<remove>\|\|"xhigh"!==\k<firstEffort>\),\k<models>,\k<strip>\);if\(\k<first>\.length>=3\)return \k<first>;`,
 String.raw`let (?<second>${ID})=\k<intersection>\((?<fallbackB>${ID})\.filter\(\(\{reasoningEffort:(?<secondEffort>${ID})\}\)=>!\k<remove>\|\|"xhigh"!==\k<secondEffort>\),\k<models>,\k<strip>\);return \k<second>\.length>=3\?\k<second>:\[\]\}$`,
].join(""),"u");

function normalizerPattern(name){return new RegExp([
 String.raw`^function ${escapeRegExp(name)}\((?<models>${ID}),\{stripGptPrefix:(?<strip>${ID})=!0\}=\{\}\)\{return \k<models>\?\.flatMap\(\(\{displayName:(?<display>${ID}),model:(?<model>${ID}),supportedReasoningEfforts:(?<efforts>${ID})\}\)=>\{`,
 String.raw`let (?<label>${ID})=null==\k<display>\?"Custom":\(0,(?<formatter>${ID})\.(?<formatExport>${ID})\)\(\k<display>,\{stripGptPrefix:\k<strip>\}\),(?<allowed>${ID})=\k<efforts>\.flatMap\(\(\{reasoningEffort:(?<effort>${ID})\}\)=>\(0,(?<predicate>${ID})\.(?<predicateExport>${ID})\)\(\k<effort>\)&&"persistent"!==\k<effort>\?\[\k<effort>\]:\[\]\);`,
 String.raw`return\(\k<allowed>\.length>0\?\k<allowed>:\["medium"\]\)\.map\((?<choice>${ID})=>\(\{id:\x60\$\{\k<model>\}:\$\{\k<choice>\}\x60,model:\k<model>,modelLabel:\k<label>,reasoningEffort:\k<choice>\}\)\)\}\)\?\?\[\]\}$`,
].join(""),"u")}
function intersectionPattern(name){return new RegExp([
 String.raw`^function ${escapeRegExp(name)}\((?<entries>${ID}),(?<models>${ID}),(?<strip>${ID})\)\{return \k<entries>\.flatMap\(\((?<entry>${ID}),(?<index>${ID})\)=>\{let (?<found>${ID})=\k<models>\?\.find\((?<candidate>${ID})=>\k<candidate>\.model===\k<entry>\.model&&\k<candidate>\.supportedReasoningEfforts\.some\(\(\{reasoningEffort:(?<effort>${ID})\}\)=>\k<effort>===\k<entry>\.reasoningEffort\)\);`,
 String.raw`return null==\k<found>\?\[\]:\[\{\.\.\.\k<entry>,modelLabel:\(0,(?<formatter>${ID})\.(?<formatExport>${ID})\)\(\k<found>\.displayName,\{stripGptPrefix:\k<strip>\}\),powerSettingIndex:\k<index>\}\]\}\)\}$`,
].join(""),"u")}

function fallbackArray(f,name){
 const item=`\\{id:${JSON_STRING},model:${JSON_STRING},modelLabel:${JSON_STRING},reasoningEffort:${JSON_STRING}\\}`;
 const hit=one(f.root(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=(?<array>\\[(?:${item}(?:,${item})*)?\\])(?=[,;])`,"gu")),"native fallback array");stable(f.source,name,hit.index);
 const entries=[...hit.groups.array.matchAll(new RegExp(`\\{id:(?<id>${JSON_STRING}),model:(?<model>${JSON_STRING}),modelLabel:(?<label>${JSON_STRING}),reasoningEffort:(?<effort>${JSON_STRING})\\}`,"gu"))].map(hit=>Object.fromEntries(Object.entries(hit.groups).map(([key,value])=>[key,JSON.parse(value)])));
 if(entries.some(value=>value.id!==`${value.model}:${value.effort}`))throw Error("Inconsistent local Default fallback pair");return{source:hit.groups.array,entries};
}

function nativeLocalResolverOwner(source,module){
 if(!NEEDLES.every(needle=>source.includes(needle)))throw Error("Missing current local Default resolver body");
 const f=frame(source,module,true),keys=[...new Set([...source.matchAll(new RegExp(`(?<key>${ID}):function\\(`,"gu"))].filter(hit=>f.lexical.isCode(hit.index)).map(hit=>hit.groups.key))];
 const candidates=keys.flatMap(key=>{const publication=findRspackExportPublication(f.snapshot,key);if(!publication?.fn)return[];const fn=source.slice(publication.fn.start,publication.fn.end),match=QV_PATTERN.exec(fn);return match?[{key,publication,fn,groups:match.groups}]:[]});
 const owner=one(candidates,"published resolver"),g=owner.groups;
 distinct([g.models,g.remove,g.config,g.strip],"resolver parameters");distinct([g.normalizer,g.unique,g.intersection,g.fallbackA,g.fallbackB],"captured resolver roles");
 noCapture([g.models,g.remove,g.config,g.strip,g.mapped,g.group,g.pairs,g.deduped,g.first,g.second],[g.normalizer,g.unique,g.intersection,g.fallbackA,g.fallbackB],"resolver captures");
 noCapture([g.mapped],[g.models,g.remove,g.config,g.strip],"normalized model list");noCapture([g.group],[g.models,g.remove,g.config,g.strip,g.mapped],"preset group");noCapture([g.pairs,g.deduped],[g.models,g.remove,g.strip,g.mapped,g.group],"preset block captures");noCapture([g.found],[g.mapped],"pair lookup list");
 distinct([g.mapped,g.group],"preset loop roles");distinct([g.pairs,g.deduped],"preset result roles");distinct([g.model,g.effort],"preset pair parameters");noCapture([g.filterEffort,g.firstEffort,g.secondEffort],[g.remove],"removeXHigh flag");noCapture([g.model,g.effort],[g.mapped],"normalized pair list");noCapture([g.candidate],[g.model,g.effort],"pair lookup");
 const normalizer=f.named(g.normalizer),normal=normalizerPattern(g.normalizer).exec(normalizer.source)?.groups;if(!normal)throw Error("Drifted local Default model normalizer");
 distinct([normal.models,normal.strip],"model normalizer parameters");distinct([normal.display,normal.model,normal.efforts,normal.label,normal.allowed],"model normalization roles");
 noCapture([normal.display,normal.model,normal.efforts,normal.label,normal.allowed],[normal.strip],"normalizer strip flag");
 noCapture([normal.models,normal.strip,normal.display,normal.model,normal.efforts,normal.label,normal.allowed],[normal.formatter,normal.predicate],"model normalizer imports");noCapture([normal.effort],[normal.predicate],"effort predicate");noCapture([normal.choice],[normal.model,normal.label],"normalized pair constructor");
 const intersection=f.named(g.intersection),inter=intersectionPattern(g.intersection).exec(intersection.source)?.groups;if(!inter)throw Error("Drifted local Default supported-pair intersection");
 noCapture([inter.entries,inter.models,inter.strip],[inter.formatter],"intersection formatter import");
 distinct([inter.entries,inter.models,inter.strip],"intersection parameters");distinct([inter.entry,inter.index,inter.found],"intersection roles");noCapture([inter.entry,inter.index,inter.found],[inter.models,inter.strip,inter.formatter],"intersection captures");noCapture([inter.candidate,inter.effort],[inter.entry],"supported-pair comparison");
 if(normal.formatter!==inter.formatter||normal.formatExport!==inter.formatExport)throw Error("Inconsistent local Default formatter");
 const req=escapeRegExp(module.params[2]),interop=one(f.root(new RegExp(`(?<![\\w$.])${escapeRegExp(g.unique)}=${req}\\.n\\((?<namespace>${ID})\\)(?=[,;])`,"gu")),"native uniqBy interop");
 if([g.models,g.remove,g.config,g.strip,g.mapped,g.group,g.pairs,g.deduped,g.first,g.second].includes(g.unique))throw Error("Captured local Default uniqBy interop");
 const namespace=findRspackRequireBinding(f.snapshot,interop.groups.namespace);if(!namespace||namespace.end-f.snapshot.start>interop.index)throw Error("Local Default interop precedes its native import");
 stable(source,g.unique,interop.index);const unique=f.imported(interop.groups.namespace),predicate=f.imported(normal.predicate),formatter=f.imported(normal.formatter);distinct([unique.localName,predicate.localName,formatter.localName],"native dependency namespaces");if([predicate.moduleId,formatter.moduleId].includes(unique.moduleId))throw Error("Local Default uniqBy import aliases a policy dependency");
 const first=fallbackArray(f,g.fallbackA),second=fallbackArray(f,g.fallbackB);
 return{...owner,normalizer,intersection,first,second,imports:{unique:{...unique,interop:g.unique},predicate:{...predicate,exportName:normal.predicateExport},formatter:{...formatter,exportName:normal.formatExport}},proof:{exportName:owner.key,nativeEffortFilter:true,nativePairIntersection:true,nativeUniqByConsumerUnchanged:true,nativeFallbackArraysUnchanged:true,originalCriticalLoaderUses:f.loaderUses}};
}

function contribution(g){return`let ${FLAG}=${g.config}?.codexLinuxDefaultPresets===!0/*${MARKER}*/;`}
function replay(source,owner){
 if(source.includes(MARKER)||source.includes(FLAG))throw Error("Orphan local Default resolver contribution");
 const g=owner.groups,loop=`for(let ${g.group} of ${g.config}.presets){`,threshold=`if(${g.deduped}.length>=3)return ${g.deduped}`;
 if(owner.fn.split(loop).length!==2||owner.fn.split(threshold).length!==2)throw Error("Ambiguous local Default config threshold");
 const patched=owner.fn.replace(loop,contribution(g)+loop).replace(threshold,`if(${g.deduped}.length>=(${FLAG}?1:3))return ${g.deduped}`);
 return source.slice(0,owner.publication.fn.start)+patched+source.slice(owner.publication.fn.end);
}
function localResolverState(source,module){
 try{
  if(!source.includes(MARKER)&&!source.includes(FLAG))return{kind:"native",native:source,owner:nativeLocalResolverOwner(source,module)};
  frame(source,module,true);
  if(source.split(MARKER).length!==2||source.split(FLAG).length!==3)throw Error("Orphan local Default resolver marker");
  const helper=new RegExp(`let ${FLAG}=(?<config>${ID})\\?\\.codexLinuxDefaultPresets===!0/\\*${MARKER}\\*/;`,"gu"),helpers=[...source.matchAll(helper)];
  if(helpers.length!==1)throw Error("Partial local Default resolver helper");
  const thresholds=[...source.matchAll(new RegExp(`if\\((?<result>${ID})\\.length>=\\(${FLAG}\\?1:3\\)\\)return \\k<result>`,"gu"))];if(thresholds.length!==1)throw Error("Partial local Default resolver threshold");
  const native=source.replace(helper,"").replace(thresholds[0][0],`if(${thresholds[0].groups.result}.length>=3)return ${thresholds[0].groups.result}`),owner=nativeLocalResolverOwner(native,module);
  if(owner.groups.config!==helpers[0].groups.config||owner.groups.deduped!==thresholds[0].groups.result||replay(native,owner)!==source)throw Error("Noncanonical local Default resolver replay");
  return{kind:"patched",native,owner};
 }catch(error){return{kind:"missing",reason:error.message}}
}
function applyLocalResolver(source,module){
 const state=localResolverState(source,module);if(state.kind==="patched")return source;if(state.kind!=="native")throw Error(`Missing, ambiguous or partial local Default resolver factory: ${state.reason}`);
 const patched=replay(source,state.owner);frame(patched,module,true);const repeated=localResolverState(patched,module);if(repeated.kind!=="patched"||repeated.native!==source)throw Error("Incomplete local Default resolver contribution");return patched;
}

function nativePredicate(source,module,key){
 const f=frame(source,module),publication=findRspackExportPublication(f.snapshot,key);if(!publication?.fn)throw Error("Missing native effort predicate publication");
 const match=new RegExp(`^function\\((?<input>${ID})\\)\\{return(?<clauses>${JSON_STRING}===\\k<input>(?:\\|\\|${JSON_STRING}===\\k<input>)*)\\}$`,"u").exec(source.slice(publication.fn.start,publication.fn.end));if(!match)throw Error("Drifted native effort predicate");
 const values=[...match.groups.clauses.matchAll(new RegExp(`(?<value>${JSON_STRING})===`,"gu"))].map(hit=>JSON.parse(hit.groups.value));if(new Set(values).size!==values.length||!["none","low","medium","high","xhigh","max","ultra"].every(value=>values.includes(value)))throw Error("Incomplete native public effort predicate");return{exportName:key,values};
}
function nativeFormatter(source,module,key){
 const f=frame(source,module),publication=findRspackExportPublication(f.snapshot,key);if(!publication?.fn)throw Error("Missing native label formatter publication");
 const pattern=new RegExp([
  String.raw`^function\((?<label>${ID}),\{stripGptPrefix:(?<strip>${ID})=!1\}=\{\}\)\{if\(!\k<label>\.trimStart\(\)\.toLowerCase\(\)\.startsWith\("gpt"\)\)return \k<label>;let (?<separator>${ID})=/\^gpt-\\d/iu\.test\(\k<label>\.trimStart\(\)\)\?" ":"-",(?<formatted>${ID})=\k<label>\.split\(/\(\\s\+\)/\)\.map\((?<word>${ID})=>0===\k<word>\.trim\(\)\.length\?\k<word>:\k<word>\.split\("-"\)\.map\(\((?<token>${ID}),(?<index>${ID})\)=>"gpt"===\k<token>\.toLowerCase\(\)\?"GPT":"oai"===\k<token>\.toLowerCase\(\)\?"OAI":\k<index>>0&&\k<token>\.length>0\?\x60\$\{\k<token>\[0\]\?\.toUpperCase\(\)\?\?""\}\$\{\k<token>\.slice\(1\)\}\x60:\k<token>\)\.join\(\k<separator>\)\.replace\(/\^GPT \(\?=\\d\)/u,"GPT-"\)\)\.join\(""\);return \k<strip>\?\k<formatted>\.replace\(/\^GPT-/iu,""\):\k<formatted>\}$`,
 ].join(""),"u");
 const g=pattern.exec(source.slice(publication.fn.start,publication.fn.end))?.groups;if(!g)throw Error("Drifted native model label formatter");distinct([g.label,g.strip,g.separator,g.formatted],"label formatter roles");distinct([g.token,g.index],"label token parameters");noCapture([g.word],[g.separator],"label separator");return{exportName:key,stripGptPrefixDefault:false};
}
function requireRegistry(source){const headers=[...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];if(headers.length!==1||!createJavaScriptLexicalIndex(source.slice(0,headers[0].index+headers[0][0].length)).isRoot(headers[0].index))throw Error("Missing, ambiguous or opaque local Default registry")}
function requireDependencies(assets,copies){
 const owners=copies.map(copy=>localResolverState(copy.moduleSource,copy).owner);if(owners.some(owner=>!owner))throw Error("Missing local Default resolver owner");
 const references=owners.map(owner=>owner.imports);if(references.some(value=>JSON.stringify(value)!==JSON.stringify(references[0])))throw Error("Inconsistent local Default resolver dependencies");
 return[...[["predicate",nativePredicate],["formatter",nativeFormatter]].map(([kind,inspect])=>{
  const ref=references[0][kind],inspectCopy=copy=>{requireRegistry(copy.source);return inspect(copy.moduleSource,copy,ref.exportName)};
  const dependencies=findUniqueRspackModuleCopies(assets,{description:`native local Default ${kind} dependency`,sourceMatch:source=>source.includes(ref.moduleId)||source.includes("\\u")||source.includes("\\/"),matchModule:(_source,copy)=>{if(copy.moduleId!==ref.moduleId)return false;try{inspectCopy(copy);return true}catch{return false}}});
  const facts=dependencies.map(inspectCopy);if(facts.some(fact=>JSON.stringify(fact)!==JSON.stringify(facts[0])))throw Error(`Inconsistent native local Default ${kind} copies`);return{kind,moduleId:ref.moduleId,exportName:ref.exportName,matched:dependencies.length};
 }),{kind:"native-uniqBy-consumer",moduleId:references[0].unique.moduleId,staticRequireAndInterop:true,implementationInspected:false}];
}
function patchLocalResolver(extractedDir,options={}){
 const assets=path.join(extractedDir,"webview","assets"),marked=new Map();
 const copies=findUniqueRspackModuleCopies(assets,{description:"current local Default resolver",sourceMatch(source,name){if(source.includes(MARKER)||source.includes(FLAG))marked.set(name,source);return NEEDLES.every(needle=>source.includes(needle))||source.includes(MARKER)},matchModule:(source,module)=>localResolverState(source,module).kind!=="missing"});
 for(const copy of copies){requireRegistry(copy.source);for(const marker of [MARKER,FLAG])if(copy.source.split(marker).length!==copy.moduleSource.split(marker).length)throw Error("Orphan local Default resolver contribution");marked.delete(copy.assetName);if(!javascriptSourceParses(copy.source))throw Error("Invalid local Default resolver asset syntax")}
 if(marked.size)throw Error("Orphan local Default resolver marker asset");
 const dependencies=requireDependencies(assets,copies);
 for(const copy of copies){const patched=applyLocalResolver(copy.moduleSource,copy);if(patched!==copy.moduleSource&&!javascriptSourceParses(copy.source.slice(0,copy.start)+patched+copy.source.slice(copy.end)))throw Error("Invalid generated local Default asset syntax")}
 return{...patchRspackModuleCopies(assets,copies,applyLocalResolver,options),dependencies};
}
module.exports={MARKER,nativeLocalResolverOwner,localResolverState,applyLocalResolver,patchLocalResolver};
