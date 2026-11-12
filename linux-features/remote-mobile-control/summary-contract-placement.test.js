"use strict";
const fs=require("node:fs"),path=require("node:path"),assert=require("node:assert/strict"),vm=require("node:vm"),{Script}=require("node:vm"),test=require("node:test"),{createRequire}=require("node:module");
const data=require("./summary-contract-data.js"),api=require("./summary-contract.js"),{rspackModuleFactories}=require("../../scripts/patches/lib/rspack-module-assets.js"),{createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const FIELD="this.executeTurnStart=this.streamRecovery.wrapTurnStart(X)";
function instrumentedPlacement(){const filename=path.join(__dirname,"summary-contract.js"),source=fs.readFileSync(filename,"utf8")+"\nmodule.exports.__placement=ctorEagerAssignmentAt;",owned={exports:{}};vm.runInNewContext("(function(require,module,exports){"+source+"\n})",{Buffer})(createRequire(filename),owned,owned.exports);return owned.exports.__placement}
const placement=instrumentedPlacement();
function inspect(body,privateName=true){const source=`class Probe{${privateName?"#V(){}":""}constructor(e){${body}}}`,index=createJavaScriptLexicalIndex(source),start=source.indexOf("constructor(e){"),open=start+"constructor(e){".length-1,close=index.matchingBrace(open),ctor={params:"e",open,close,body:source.slice(open+1,close)};return placement({source},ctor,ctor.body.indexOf("this.executeTurnStart"))}
function carrier(statement){const body='n.d(t,{O3:()=>sM});var p=n("Fkn8");'+data.previousLookup+data.previousGetter+data.configReader+data.turn+'class sM extends p.TF{#V(){}constructor(e){super();'+data.constructorInput+'this.logger=R;'+data.route+'this.settings=Y;this.hostId=b;'+statement+'}'+data.getDefault+data.getHost+data.getConversation+data.startTurn+'}';return 'export const __rspack_esm_ids=[1];export const __webpack_modules__={V7mA(e,t,n){'+body+'}};'}
function copies(source){return[...rspackModuleFactories(source,"async/summary.js")]}

test("native root-if initialization prefix links the wrapped route in original private class syntax",()=>{
 const native=carrier(data.executionBoundary+data.executionPrefix+',false){}'),m=api.prepareSummaryLayer(copies(native),"mobile"),ms=m.edits[0].patchedSource,v=api.prepareSummaryLayer(copies(native),"visibility"),vs=v.edits[0].patchedSource,j1=api.prepareSummaryLayer(copies(ms),"visibility").edits[0].patchedSource,j2=api.prepareSummaryLayer(copies(vs),"mobile").edits[0].patchedSource;
 assert.equal(j1,j2);assert.equal(Buffer.byteLength(ms)-Buffer.byteLength(native),510);assert.equal(api.prepareSummaryLayer(copies(j1),"mobile",false).edits[0].patchedSource,vs);assert.equal(api.prepareSummaryLayer(copies(j1),"visibility",false).edits[0].patchedSource,ms);assert.equal(api.prepareSummaryLayer(copies(ms),"mobile").edits[0].patchedSource,ms);
});

test("statement, root-if first and direct comma operands are eager without executing the class",()=>{
 assert.equal(inspect('let X=()=>{};'+FIELD+';').kind,"statement");
 assert.equal(inspect('let X=()=>{};if('+FIELD+',false){}').kind,"root-if-comma");
 assert.equal(inspect('let X=()=>{};if(this.setup=()=>this.#V(),'+FIELD+',false){}').kind,"root-if-comma");
 assert.throws(()=>inspect('let X=()=>{};if(this.setup=()=>this.#V(),'+FIELD+',false){}',false),/constructor|root-if|condition/);
});

test("branch, short-circuit, ternary, call, extra-parenthesis, loop and dead scopes reject",()=>{
 for(const source of['if(false){'+FIELD+';}','if(false&&('+FIELD+')){}','if(false||(0,'+FIELD+')){}','if(null??('+FIELD+')){}','if(false?(0,'+FIELD+'):0){}','if(false?'+FIELD+':0){}','sink(0,'+FIELD+');','if(sink(0,'+FIELD+'),false){}','if((0,'+FIELD+'),false){}','for(;;)'+FIELD+';','if(false)if(0,'+FIELD+',false){}','return;'+FIELD+';','function never(){'+FIELD+';}','const never=()=>'+FIELD+';']){assert.doesNotThrow(()=>new Script('class Probe{#V(){}constructor(e){let X=()=>{};'+source+'}}'));assert.throws(()=>inspect('let X=()=>{};'+source),/constructor|root-if|condition/);}
});

test("preceding native operands and lifecycle callback boundary must qualify, not just parse",()=>{
 const good=carrier(data.executionBoundary+data.executionPrefix+',false){}');
 for(const bad of[good.replace('this.lifecycle.addAuthStatusCallback(ee)','this.lifecycle.addAuthStatusCallback(foreign)'),good.replace('startTurn:X,isDisposed:()=>this.disposed','startTurn:foreign,isDisposed:()=>this.disposed'),good.replace(data.executionBoundary,'let ee=()=>{};'),good.replace('if(this.lifecycle.addAuthStatusCallback','if(false&&this.lifecycle.addAuthStatusCallback')])assert.throws(()=>api.prepareSummaryLayer(copies(bad),"mobile"),/turn-summary contract/);
});


test("native String identity and current intrinsic factory/constructor bindings remain literal",()=>{
 const native=carrier(data.executionBoundary+data.executionPrefix+',false){}');assert.doesNotThrow(()=>api.prepareSummaryLayer(copies(native),"mobile"));
 for(const [from,to]of[["String(o)","WeakMap(o)"],["String(e)","WeakMap(e)"]]){assert.ok(native.includes(from));const changed=native.replace(from,to);assert.throws(()=>api.prepareSummaryLayer(copies(changed),"mobile"),/turn-summary contract/);}
 for(const name of["Array","Date","Error","Map","Object","Promise","String"]){
  for(const declaration of[`var ${name}=WeakMap;`,`${name}=WeakMap;`])assert.throws(()=>api.prepareSummaryLayer(copies(native.replace('var p=n("Fkn8");',declaration+'var p=n("Fkn8");')),"mobile"),/turn-summary contract/);
  assert.throws(()=>api.prepareSummaryLayer(copies(native.replace('V7mA(e,t,n)',`V7mA(${name},t,n)`)),"mobile"),/turn-summary contract/);
 }
 for(const name of["Array","Date","Error","Map","Object","Promise","String"])for(const declaration of[`var ${name}=WeakMap;`,`${name}=WeakMap;`])assert.throws(()=>api.prepareSummaryLayer(copies(native.replace('constructor(e){super();','constructor(e){super();'+declaration)),"mobile"),/turn-summary contract/);
});


test("manager class must be directly published through the stable native exports parameter",()=>{
 const native=carrier(data.executionBoundary+data.executionPrefix+',false){}');assert.doesNotThrow(()=>api.prepareSummaryLayer(copies(native),"mobile"));
 for(const publication of['n.d(t,{}, {O3:sM});','n.d(t,{O3:sM});','n.d(t,{foreign:{O3:()=>sM}});','n.d(t,{foreign:"O3:()=>sM}"});','t={};n.d(t,{O3:()=>sM});','n.d(t,{O3:()=>sM});t={};','if(false)n.d(t,{O3:()=>sM});','return;n.d(t,{O3:()=>sM});'])assert.throws(()=>api.prepareSummaryLayer(copies(native.replace('n.d(t,{O3:()=>sM});',publication)),"mobile"),/turn-summary contract/);
});


test("public manager declaration must initialize after its live publication",()=>{
 const native=carrier(data.executionBoundary+data.executionPrefix+',false){}'),publication='n.d(t,{O3:()=>sM});';assert.doesNotThrow(()=>api.prepareSummaryLayer(copies(native),"mobile"));
 for(const exit of['return;','throw Error("dead manager");'])assert.throws(()=>api.prepareSummaryLayer(copies(native.replace(publication,publication+exit)),"mobile"),/public manager initialization follows a root exit/);
});


test("live route external module roles cannot be constructor-captured or eagerly rebound",()=>{
 const native=carrier(data.executionBoundary+data.executionPrefix+',false){}');assert.doesNotThrow(()=>api.prepareSummaryLayer(copies(native),"mobile"));
 for(const name of["a4","rn","eE"])for(const declaration of[`var ${name}=()=>null;`,`${name}=()=>null;`,`function ${name}(unused=()=>{}){return null}`,`function* ${name}(){return null}`])assert.throws(()=>api.prepareSummaryLayer(copies(native.replace('this.logger=R;','this.logger=R;'+declaration)),"mobile"),/constructor captures or eagerly rewrites a native route module role/);
 const harmless=native.replace('this.logger=R;','this.logger=R;function unrelated(a4){a4=()=>null}');assert.doesNotThrow(()=>api.prepareSummaryLayer(copies(harmless),"mobile"));
});


test("safe native aliases normalize spread and ternary values while literal properties remain locked",()=>{
 const native=carrier(data.executionBoundary+data.executionPrefix+',false){}'),lex=createJavaScriptLexicalIndex(native),aliases={e:"inputArg",n:"optionsArg",h:"$expanded"},renamed=native.replace(/\b[enh]\b/gu,(name,at)=>lex.isCode(at)?aliases[name]:name);
 assert.ok(renamed.includes('join("\\n")'));assert.doesNotThrow(()=>new Script(renamed.replaceAll("export const ","const ")));
 for(const layer of["mobile","visibility"]){const plan=api.prepareSummaryLayer(copies(renamed),layer);assert.notEqual(plan.edits[0].patchedSource,renamed);assert.equal(api.prepareSummaryLayer(copies(plan.edits[0].patchedSource),layer,false).edits[0].patchedSource,renamed);}
 for(const[from,to]of[[".context",".foreignContext"],["manager:inputArg","foreignManager:inputArg"],["?.summary","?.foreignSummary"]]){assert.ok(renamed.includes(from));assert.throws(()=>api.prepareSummaryLayer(copies(renamed.replace(from,to)),"mobile"),/turn-summary contract/);}
});
