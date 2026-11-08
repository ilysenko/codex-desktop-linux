"use strict";
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {requireStableCatalogBinding:stable}=require("./catalog-binding-authority.js");
const {assertCriticalLoaderMethodUses}=require("./critical-loader-authority.js");
const ID="[A-Za-z_$][\\w$]*",STRING='"(?:\\\\.|[^"\\\\])*"';
const REACT_INTERNALS="__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE";
const TOKEN_SOURCE=String.raw`(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[$_\p{ID_Start}])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[$_\u200C\u200D\p{ID_Continue}])*`;
const decode=text=>text.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,(_,a,b)=>String.fromCodePoint(parseInt(a??b,16)));
const distinct=(names,label)=>{if(new Set(names).size!==names.length)throw Error(`Aliased native selection ${label}`)};
const noCapture=(names,captured,label)=>{if(names.some(name=>captured.includes(name)))throw Error(`Shadowed native selection ${label}`)};
function frozen(value){if(value&&typeof value==="object"){for(const child of Object.values(value))frozen(child);Object.freeze(value)}return value}
function syntax(source,snapshot,count){if(typeof source!=="string"||Buffer.byteLength(source)>256*1024||typeof snapshot?.moduleId!=="string"||!snapshot.moduleId||snapshot.params?.length!==count||new Set(snapshot.params).size!==count||snapshot.params.some(name=>!new RegExp(`^${ID}$`,"u").test(name)))throw Error("Invalid native selection dependency input");try{new Script(`"use strict";(function(${snapshot.params.join(",")}){${source}})`)}catch{throw Error("Invalid native selection dependency syntax")}}

function inspectSelectionQueueProvider(source,snapshot){
 syntax(source,snapshot,3);const loaderUses=assertCriticalLoaderMethodUses(source,snapshot),req=escapeRegExp(snapshot.params[2]),exp=escapeRegExp(snapshot.params[1]);
 const pattern=new RegExp([
  String.raw`^var (?<framework>${ID})=${req}\((?<frameworkId>${STRING})\),(?<scopeNamespace>${ID})=${req}\((?<scopeId>${STRING})\);let (?<pending>${ID})=\(0,\k<framework>\.(?<atomFactory>${ID})\)\(\k<scopeNamespace>\.(?<scopeExport>${ID}),(?<pendingInput>${ID})=>null\),`,
  String.raw`(?<writing>${ID})=\(0,\k<framework>\.\k<atomFactory>\)\(\k<scopeNamespace>\.\k<scopeExport>,(?<writingInput>${ID})=>null\),(?<auxiliary>${ID})=\(0,\k<framework>\.\k<atomFactory>\)\(\k<scopeNamespace>\.\k<scopeExport>,(?<auxiliaryInput>${ID})=>null\),`,
  String.raw`(?<queueAtom>${ID})=\(0,\k<framework>\.(?<queueFactory>${ID})\)\(\k<scopeNamespace>\.\k<scopeExport>,\((?<factoryInput>${ID}),\{scope:(?<scope>${ID})\}\)=>\{let (?<queued>${ID})=null,(?<active>${ID})=!1,(?<timer>${ID})=null;return (?<ticket>${ID})=>\{let (?<previous>${ID})=\k<queued>;`,
  String.raw`\k<scope>\.set\(\k<pending>,\k<ticket>\.target,\k<ticket>\.selection\),\k<queued>=\k<ticket>,null!=\k<previous>&&\k<previous>\.resolve\(!1\),null!=\k<timer>&&clearTimeout\(\k<timer>\),\k<timer>=setTimeout\(\(\)=>\{\k<timer>=null,async function (?<runner>${ID})\(\)\{var (?<cleanupScope>${ID}),(?<cleanupTicket>${ID});`,
  String.raw`if\(\k<active>\|\|null==\k<queued>\)return;let (?<work>${ID})=\k<queued>;\k<queued>=null,\k<active>=!0,\k<scope>\.set\(\k<writing>,\k<work>\.target,\k<work>\.selection\);let (?<result>${ID})=!1;try\{\k<result>=await \k<work>\.write\(\)\}catch\{\}`,
  String.raw`\k<cleanupScope>=\k<scope>,\k<cleanupTicket>=\k<work>,\k<cleanupScope>\.get\(\k<writing>,\k<cleanupTicket>\.target\)===\k<cleanupTicket>\.selection&&\(\k<cleanupScope>\.set\(\k<writing>,\k<cleanupTicket>\.target,null\),\k<cleanupScope>\.get\(\k<pending>,\k<cleanupTicket>\.target\)===\k<cleanupTicket>\.selection&&\k<cleanupScope>\.set\(\k<pending>,\k<cleanupTicket>\.target,null\)\),`,
  String.raw`\k<work>\.resolve\(\k<result>\),\k<active>=!1,null!=\k<queued>&&null==\k<timer>&&\k<runner>\(\)\}\(\)\},320\)\}\}\);`,
  String.raw`${req}\.d\(${exp},\{\},\{(?<targetExport>${ID}):function\(\{conversationId:(?<conversation>${ID}),hasConversation:(?<hasConversation>${ID}),hostId:(?<host>${ID}),cwd:(?<cwd>${ID})\}\)\{return null!=\k<conversation>&&\k<hasConversation>\?\["conversation",\k<conversation>\]:\["default",\k<host>,\k<cwd>\]\},`,
  String.raw`(?<pendingExport>${ID}):\k<pending>,(?<queueExport>${ID}):function\((?<submitScope>${ID}),(?<target>${ID}),(?<selection>${ID}),(?<write>${ID})\)\{return new Promise\((?<resolve>${ID})=>\{\k<submitScope>\.get\(\k<queueAtom>,JSON\.stringify\(\k<target>\)\)\(\{resolve:\k<resolve>,selection:\k<selection>,target:\k<target>,write:\k<write>\}\)\}\)\},(?<auxiliaryExport>${ID}):\k<auxiliary>,(?<writingExport>${ID}):\k<writing>\}\);?$`,
 ].join(""),"u");
 const g=pattern.exec(source)?.groups;if(!g)throw Error("Missing complete native selection queue grammar");
 const roots=[g.framework,g.scopeNamespace,g.pending,g.writing,g.auxiliary,g.queueAtom];distinct(roots,"queue root bindings");noCapture(roots,snapshot.params,"queue module parameters");
 distinct([g.atomFactory,g.queueFactory],"queue framework operations");
 const builtins=["Promise","JSON","setTimeout","clearTimeout"];noCapture([...snapshot.params,...roots],builtins,"queue native builtins");
 distinct([g.targetExport,g.pendingExport,g.queueExport,g.auxiliaryExport,g.writingExport],"queue publications");if([g.targetExport,g.pendingExport,g.queueExport,g.auxiliaryExport,g.writingExport].includes("__proto__"))throw Error("Invalid native selection publication");
 distinct([g.factoryInput,g.scope,g.queued,g.active,g.timer],"queue factory scope");
 noCapture([g.factoryInput,g.scope,g.queued,g.active,g.timer],[g.pending,g.writing,"setTimeout","clearTimeout"],"queue factory captures");
 distinct([g.ticket,g.previous],"queued ticket scope");noCapture([g.ticket,g.previous],[g.scope,g.queued,g.active,g.timer,g.pending,g.writing,"setTimeout","clearTimeout"],"queued ticket captures");
 distinct([g.runner,g.cleanupScope,g.cleanupTicket,g.work,g.result],"active writer scope");noCapture([g.runner,g.cleanupScope,g.cleanupTicket,g.work,g.result],[g.scope,g.queued,g.active,g.timer,g.pending,g.writing],"writer captures");
 distinct([g.conversation,g.hasConversation,g.host,g.cwd],"target parameters");
 distinct([g.submitScope,g.target,g.selection,g.write,g.resolve],"queue submit parameters");noCapture([g.submitScope,g.target,g.selection,g.write,g.resolve],[g.queueAtom,"Promise","JSON"],"queue submit captures");
 for(const name of builtins)stable(source,name);
 return frozen({kind:"selection-queue-provider",moduleId:snapshot.moduleId,targetExport:g.targetExport,pendingExport:g.pendingExport,writingExport:g.writingExport,queueExport:g.queueExport,auxiliaryExport:g.auxiliaryExport,framework:{moduleId:JSON.parse(g.frameworkId),atomExport:g.atomFactory,queueFamilyExport:g.queueFactory},scope:{moduleId:JSON.parse(g.scopeId),exportName:g.scopeExport},proof:{nativeSource:source,rootBindings:{pending:g.pending,writing:g.writing,auxiliary:g.auxiliary,queueAtom:g.queueAtom},scopeObject:g.scope,conversationTarget:["conversation","conversationId"],defaultTarget:["default","hostId","cwd"],conversationTargetIncludesHost:false,queueKey:"JSON.stringify(target)",coalescingDelayMs:320,overwrittenPendingIsResolved:true,overwrittenPendingResult:false,catchResult:false,cleanupRequiresSameSelectionIdentity:true,recursiveFlushAfterActiveWrite:true,submitIsSynchronousPromiseConstructor:true,loaderUses}});
}

function inspectReactForwarder(source,snapshot){
 syntax(source,snapshot,3);for(const name of snapshot.params)stable(source,name);
 const mod=escapeRegExp(snapshot.params[0]),req=escapeRegExp(snapshot.params[2]),hit=new RegExp(String.raw`^${mod}\.exports=${req}\((?<target>${STRING}|\d+)\);?$`,"u").exec(source);if(!hit)throw Error("Missing closed React CJS forwarder");
 const targetModuleId=hit.groups.target.startsWith('"')?JSON.parse(hit.groups.target):hit.groups.target;
 return frozen({kind:"react-forwarder",moduleId:snapshot.moduleId,targetModuleId,proof:{nativeSource:source,moduleParameter:snapshot.params[0],requireParameter:snapshot.params[2],moduleExportsAssignment:true,closedGrammar:true}});
}

function publicHookReferences(source,snapshot,lexical){
 const target=snapshot.params[1],tokenRegex=new RegExp(TOKEN_SOURCE,"gu"),propertyToken=new RegExp(TOKEN_SOURCE,"uy");
 function trivia(at){while(at<source.length){if(/\s/u.test(source[at])){at++;continue}if(source.startsWith("/*",at)){at=source.indexOf("*/",at+2)+2;continue}if(source.startsWith("//",at)){const n=source.slice(at+2).search(/[\r\n\u2028\u2029]/u);at=n<0?source.length:at+2+n;continue}break}return at}
 function previous(at){while(at>=0&&!lexical.isCode(at))at--;return at}
 function property(at){at=trivia(at);if(source.startsWith("?.",at))at=trivia(at+2);else if(source[at]===".")at=trivia(at+1);else if(source[at]!=="[")return null;
  if(source[at]!=="["){propertyToken.lastIndex=at;const value=propertyToken.exec(source);return value?decode(value[0]):null}
  at=trivia(at+1);const quote=source[at];if(!['"',"'"].includes(quote))return null;let end=at+1;for(;end<source.length;end++){if(source[end]==="\\"){end++;continue}if(source[end]===quote)break}if(source[trivia(end+1)]!=="]")return null;
  return source.slice(at+1,end).replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\r\n\u2028\u2029])|([\s\S]))/gu,(_,a,b,c,line,other)=>a||b||c?String.fromCodePoint(parseInt(a??b??c,16)):line?"":({n:"\n",r:"\r",t:"\t",b:"\b",f:"\f",v:"\v",0:"\0"}[other]??other));
 }
 const uses=[];for(const token of source.matchAll(tokenRegex)){
  if(!lexical.isCode(token.index)||decode(token[0])!==target||[".","#"].includes(source[previous(token.index-1)]))continue;const name=property(token.index+token[0].length);if(!["useRef","useLayoutEffect",REACT_INTERNALS].includes(name))continue;
  const projected=source.slice(0,token.index)+`(${token[0]}=${token[0]})`+source.slice(token.index+token[0].length);if(Buffer.byteLength(projected)>256*1024)throw Error("React API reference proof exceeds budget");syntax(projected,snapshot,2);let local=false;try{stable(projected,target);local=true}catch{}if(!local)uses.push({name,index:token.index});
 }return uses;
}

function inspectReactClientHooks(source,snapshot){
 syntax(source,snapshot,2);stable(source,snapshot.params[1]);const lexical=createJavaScriptLexicalIndex(source),exp=escapeRegExp(snapshot.params[1]),roots=pattern=>[...source.matchAll(pattern)].filter(hit=>lexical.isRoot(hit.index));
 const refs=roots(new RegExp(String.raw`(?<![\w$.])${exp}\.useRef=function\((?<input>${ID})\)\{return (?<dispatcher>${ID})\.H\.useRef\(\k<input>\)\}(?=[,;]|$)`,"gu")),effects=roots(new RegExp(String.raw`(?<![\w$.])${exp}\.useLayoutEffect=function\((?<effect>${ID}),(?<dependencies>${ID})\)\{return (?<dispatcher>${ID})\.H\.useLayoutEffect\(\k<effect>,\k<dependencies>\)\}(?=[,;]|$)`,"gu"));
 if(refs.length!==1||effects.length!==1)throw Error("Missing or ambiguous native React hook wrappers");const ref=refs[0],effect=effects[0],dispatcher=ref.groups.dispatcher;if(effect.groups.dispatcher!==dispatcher)throw Error("React hooks use different native dispatchers");
 distinct([effect.groups.effect,effect.groups.dependencies],"React effect parameters");noCapture([ref.groups.input,effect.groups.effect,effect.groups.dependencies],[dispatcher],"React dispatcher formals");noCapture([dispatcher],snapshot.params,"React dispatcher module parameters");
 const initializers=roots(new RegExp(String.raw`(?<![\w$.])${escapeRegExp(dispatcher)}=\{H:null,A:null,T:null,S:null\}(?=[,;])`,"gu"));if(initializers.length!==1)throw Error("Missing or ambiguous native React dispatcher initializer");const initializer=initializers[0];stable(source,dispatcher,initializer.index);
 let declared=false;try{new Script(`"use strict";function reactClient(${snapshot.params.join(",")}){\n${source}\n;let ${dispatcher};\n}`)}catch{declared=true}if(!declared)throw Error("Native React dispatcher has no root declaration");
 const carriers=roots(new RegExp(String.raw`(?<![\w$.])${exp}\.${REACT_INTERNALS}=${escapeRegExp(dispatcher)}(?=[,;])`,"gu"));if(carriers.length!==1||initializer.index+initializer[0].length>carriers[0].index)throw Error("React hooks do not share the native published dispatcher");
 const uses=publicHookReferences(source,snapshot,lexical),expected=[{name:"useRef",index:ref.index},{name:"useLayoutEffect",index:effect.index},{name:REACT_INTERNALS,index:carriers[0].index}].sort((a,b)=>a.index-b.index);if(JSON.stringify(uses)!==JSON.stringify(expected))throw Error("Unexpected native React public hook reference");
 const version=roots(new RegExp(String.raw`(?<![\w$.])${exp}\.version=(?<version>${STRING})(?=[,;]|$)`,"gu"));
 return frozen({kind:"react-client-hooks",moduleId:snapshot.moduleId,useRefExport:"useRef",useLayoutEffectExport:"useLayoutEffect",dispatcherName:dispatcher,dispatcherExport:REACT_INTERNALS,version:version.length===1?JSON.parse(version[0].groups.version):null,proof:{exportsParameter:snapshot.params[1],dispatcherInitializer:initializer[0],dispatcherBindingStable:true,dispatcherSlot:"H",dispatcherSlotsAreMutable:true,noDeepImmutabilityClaim:true,useRefSource:ref[0],useLayoutEffectSource:effect[0],publicHookReferences:uses,staticPublicHookCensusOnly:true}});
}
module.exports={inspectSelectionQueueProvider,inspectReactForwarder,inspectReactClientHooks};
