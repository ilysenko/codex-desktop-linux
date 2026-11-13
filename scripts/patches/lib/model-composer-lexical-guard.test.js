"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{Script}=require("node:vm");
const {createJavaScriptLexicalIndex}=require("./minified-js.js"),{assertUnambiguousModelComposerLexicalSource:guard}=require("./model-composer-lexical-guard.js");
function check(source){new Script(source);return guard(source,createJavaScriptLexicalIndex(source));}
const negative=[
 ['object division','const x={} / (n=foreign) / 1;'],
 ['tight division','const x={}/(n=foreign)/1;'],
 ['escaped write',String.raw`const x={} / (\u006e=foreign) / 1;`],
 ['block-comment trivia','const x={} /*trivia*/ / (n=foreign) / 1;'],
 ['line-comment trivia','const x={} //trivia\n / (n=foreign) / 1;'],
 ['function-return object','function f(){return {} / (n=foreign) / 1;}'],
 ['array expression','const x=[{} / (n=foreign) / 1];'],
 ['function expression','const x=function(){} / (n=foreign) / 1;'],
 ['template object division','const x=`value:${{} / (n=foreign) / 1}`;'],
 ['template escaped object division','const x=`value:${{} / (n=foreign) / 1}`;'.replace('n=foreign',String.raw`\u006e=foreign`)],
 ['unknown block regex','if(ready){} /pattern/.test(value);'],
];
for(const [name,source]of negative)test("lexical guard refuses "+name,()=>assert.throws(()=>check(source),/Ambiguous slash/));
const positive=[
 ['URL template','const url=`https://${host}/chat/${thread}/turn`;'],
 ['nested URL template','const url=`${`${host}/nested`}/chat`;'],
 ['object in URL interpolation','const url=`${JSON.stringify({value:host})}/chat`;'],
 ['interpolation opaque suffix','const url=`${host}/(n=foreign)/1`;'],
 ['string example','const text="} / (n=foreign) / 1";'],
 ['comment example','/* } / (n=foreign) / 1 */const value=1;'],
 ['regex example',String.raw`const regex=/}\s*\//;`],
 ['parenthesized division','const x=({}) / (n=foreign) / 1;'],
];
for(const [name,source]of positive)test("lexical guard preserves "+name,()=>assert.doesNotThrow(()=>check(source)));
test("guard requires an explicit lexical index",()=>assert.throws(()=>guard("const value=1;"),/lexical index/));
