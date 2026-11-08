"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const {inspectNativeCatalog}=require("./native-catalog-authority.js");
const {javascriptSourceParses}=require("../../scripts/patches/lib/javascript-syntax.js");
const currentCatalog=require("./fixtures/current-chatgpt-catalog.json");
test("native authority inspects the retained signed normalizer without executing it",()=>{
 assert.equal(crypto.createHash("sha256").update(currentCatalog.moduleSource).digest("hex"),currentCatalog.bodySha256);
 assert.doesNotThrow(()=>inspectNativeCatalog(currentCatalog.moduleSource,currentCatalog));
 for(const source of ["function unrelated(){}",JSON.stringify(currentCatalog.moduleSource),`/*${currentCatalog.moduleSource}*/`,currentCatalog.moduleSource.replace('n.d(t,','foreign.d(t,'),currentCatalog.moduleSource.replace('n.d(t,','n.d(other,')])assert.throws(()=>inspectNativeCatalog(source,{...currentCatalog,moduleSource:source}));
});
test("actual modern catalog rejects all-depth literal and Unicode owned binding changes", () => {
  const beforeReturn=code=>currentCatalog.moduleSource.replace('return{serviceTiersByModelSlug:R',code+'return{serviceTiersByModelSlug:R');
  const changes=[
    'if(true){A=[]}', 'if(true){T={parse:()=>({})}}',
    'if(true){\\u0041=[]}', 'if(true){\\u{41}=[]}', 'if(true){\\u0054={parse:()=>({})}}',
    'if(true){o={}}', 'if(true){a=new Map}', 'if(true){x={}}', 'if(true){S="other"}',
    'if(true){C=[]}', 'if(true){R={}}', 'if(true){e={}}',
    'if(true){({A}=foreign)}', 'if(true){[\\u0041]=foreign}',
    '(()=>{A=[]})();', '(()=>{\\u0054={}})();',
    'if(true){var T;}', 'if(true){var \\u0054;}', 'var e;', 'var \\u0065;',
    'function T(){}',
    'let harmless=`${A=[]}`;', 'let harmless=`${\\u0054={}}`;',
    'for(let q=0;q<1;q++){A=[]}',

  ];
  for(const code of changes){
    const source=beforeReturn(code);
    assert.equal(javascriptSourceParses(source),true,code);
    assert.throws(()=>inspectNativeCatalog(source,{...currentCatalog,moduleSource:source}),undefined,code);
  }
  for(const code of [';if(true){o=foreign}', ';if(true){\\u006f=foreign}']){
    const source=currentCatalog.moduleSource+code;
    assert.equal(javascriptSourceParses(source),true,code);
    assert.throws(()=>inspectNativeCatalog(source,{...currentCatalog,moduleSource:source}),undefined,code);
  }
});

test("modern binding proof preserves real local shadows, opaque text and member keys", () => {
  const harmless=[
    'if(true){let A=[];A.push(1)}', 'if(true){const T={};T.value=1}',
    'if(true){let \\u0041=[];\\u0041.push(1)}', 'if(true){const \\u0054={};\\u0054.value=1}',
    '((A)=>{A=[]})([]);', '(\\u0041=>{\\u0041=[]})([]);', '((\\u0054)=>{\\u0054={}})({});',
    '(()=>{let A=[];A=[]})();',
    'let harmless={A:[],T:1};harmless.A=[];harmless["T"]=2;',
    'let harmless={\\u0041(){return 1},T(){return 2}};',
    '/* A=[];T={};\\u0041=[] */let harmless="A=[];T={};\\u0041=[]";',
    'let harmless=/["\'{}]A=\\\\u0041/;',
    'for(let A of [1]){A=2}', 'for(let \\u0041 of [1]){\\u0041=2}',
    'if(true){let {A}={A:[]};A=[]}', 'let harmless=`A=[];${1}`;',

  ];
  for(const code of harmless){
    const source=currentCatalog.moduleSource.replace('return{serviceTiersByModelSlug:R',code+'return{serviceTiersByModelSlug:R');
    assert.equal(javascriptSourceParses(source),true,code);
    assert.doesNotThrow(()=>inspectNativeCatalog(source,{...currentCatalog,moduleSource:source}),code);
  }
});
