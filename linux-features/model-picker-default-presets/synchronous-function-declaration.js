"use strict";
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {assertUnambiguousModelComposerLexicalSource:assertLexical}=require("../../scripts/patches/lib/model-composer-lexical-guard.js");
const {requireStableCatalogBinding:stable}=require("./catalog-binding-authority.js");
const ID="[A-Za-z_$][\\w$]*";
const TRIVIA=String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$))`;
// An async declaration has no line terminator between its keyword and
// function. Comments count as trivia; opaque occurrences of async do not.
const ASYNC_PREFIX=/(?<![\w$])async(?:[^\S\r\n\u2028\u2029]|\/\*(?:(?!\*\/)[^\r\n\u2028\u2029])*\*\/)*$/u;
function findSynchronousFunctionDeclaration(source,snapshot,name){
 if(typeof source!=="string"||Buffer.byteLength(source)>256*1024||snapshot?.moduleSource!==source||snapshot.params?.length!==3||new Set(snapshot.params).size!==3||snapshot.params.some(param=>!new RegExp(`^${ID}$`,"u").test(param))||!new RegExp(`^${ID}$`,"u").test(name)||snapshot.params.includes(name))throw Error("Invalid native synchronous-declaration input");
 const wrap=body=>`"use strict";function nativeDeclarationOwner(${snapshot.params.join(",")}){\n${body}\n}`;
 try{new Script(wrap(source))}catch{throw Error("Invalid native synchronous-declaration factory syntax")}
 const lexical=createJavaScriptLexicalIndex(source);assertLexical(source,lexical);
 const expression=new RegExp(`\\bfunction${TRIVIA}+(?<name>${escapeRegExp(name)})${TRIVIA}*\\((?<params>[^)]*)\\)${TRIVIA}*\\{`,"gdu");
 const heads=[...source.matchAll(expression)].filter(hit=>lexical.isRoot(hit.index));
 if(heads.length!==1)throw Error("Missing or ambiguous native synchronous declaration");
 const head=heads[0],asyncPrefix=ASYNC_PREFIX.exec(source.slice(0,head.index));
 if(asyncPrefix&&lexical.isCode(asyncPrefix.index))throw Error("Async native declaration is not a synchronous contract");
 const identifierStart=head.indices.groups.name[0];stable(source,name,identifierStart);
 // The proven binder must be an actual root declaration. A same-named
 // function expression does not conflict with this syntax-only let probe.
 let conflicts=false;try{new Script(wrap(source+`\n;let ${name};\n`))}catch{conflicts=true}
 if(!conflicts)throw Error("Native function binding is not a root declaration");
 const open=head.index+head[0].length-1,close=lexical.matchingBrace(open);
 if(close<open)throw Error("Incomplete native synchronous declaration");
 return Object.freeze({kind:"synchronous-declaration",name,params:head.groups.params,body:source.slice(open+1,close),start:head.index,end:close+1,bodyStart:open+1,identifierStart,source:source.slice(head.index,close+1)});
}
module.exports={findSynchronousFunctionDeclaration};
