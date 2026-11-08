"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {assertCriticalLoaderMethodUses:prove}=require("./critical-loader-authority.js");
const current=require("./fixtures/current-local-resolver.json"),dependencies=require("./fixtures/current-local-resolver-dependencies.json"),source=current.moduleSource;
const owner=text=>prove(text,current,{allowInterop:true});
test("static critical loader census qualifies the current owner and each tiny dependency",()=>{
 assert.deepEqual(owner(source).map(row=>row.method),["n","d"]);
 for(const fixture of Object.values(dependencies.owners))assert.deepEqual(prove(fixture.moduleSource,fixture).map(row=>row.method),["d"]);
 assert(Object.isFrozen(owner(source)));assert(Object.isFrozen(owner(source)[0]));
});
test("pre-use direct, escaped and static-quoted loader n/d writes reject",()=>{
 for(const code of ['n.n=foreign;','n.d=foreign;',String.raw`\u006e.n=foreign;`,String.raw`n.\u0064=foreign;`,'n["n"]=foreign;',"n['d']=foreign;",String.raw`n["\u006e"]=foreign;`,String.raw`n["\x64"]=foreign;`])assert.throws(()=>owner(code+source),/critical loader method use/,code);
});
test("between-initializer and publication writes and captured nested critical refs reject",()=>{
 for(const code of ['n.n=foreign;','n.d=foreign;'])assert.throws(()=>owner(source.replace('function d(',code+'function d(')),/critical loader method use/);
 for(const code of [';(()=>{n.d=foreign})()',';function captured(){n["n"]=foreign}',';const captured=n.d;'])assert.throws(()=>owner(source+code),/critical loader method use/);
});
test("true loader shadows, opaque text and unrelated namespace member writes retain authority",()=>{
 for(const code of [';function local(n){n.n=foreign;n.d=foreign}',';{let n={};n.d=foreign;n["n"]=foreign}',';for(let n of []){n.d=foreign}',';(({n})=>{n.d=foreign})({n:{}})',';n.extra=foreign;n["ordinary"]=foreign;s.extra=foreign;',';const text="n.n=foreign;n.d=foreign";/*n.d=foreign*/',String.raw`;n["\n"]=foreign;n["\\d"]=foreign;`])assert.doesNotThrow(()=>owner(source+code),code);
});
test("paired factory loader and exports renaming uses semantic receiver identities",()=>{
 const renamed=source.replace(/\bn\("/gu,'loader("').replace('n.n(r)','loader.n(r)').replace('n.d(t,','loader.d(output,');
 assert.deepEqual(prove(renamed,{...current,params:["moduleArg","output","loader"]},{allowInterop:true}).map(row=>row.method),["n","d"]);
});
