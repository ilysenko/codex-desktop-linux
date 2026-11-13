"use strict";
// Source-security guard for native owner inspectors. The shared minified lexer
// cannot distinguish a division after an object literal from a regex following
// a block. Reject the ambiguity before trusting its code-token census. Callers
// retain their own syntax/owner qualification and source-size limits.
function assertUnambiguousModelComposerLexicalSource(source,lexical){
 if(typeof source!=="string"||typeof lexical?.isCode!=="function"||typeof lexical?.matchingBrace!=="function")throw new TypeError("Expected owner source and its lexical index");
 const templateClosings=new Set();
 for(const open of source.matchAll(/\{/gu)){
  if(!lexical.isCode(open.index)||source[open.index-1]!=="$"||lexical.isCode(open.index-1))continue;
  const close=lexical.matchingBrace(open.index);if(close>open.index)templateClosings.add(close);
 }
 function afterTrivia(at){
  while(at<source.length){
   if(/\s/u.test(source[at])){at++;continue;}
   if(source.startsWith("//",at)){const end=source.slice(at+2).search(/[\r\n\u2028\u2029]/u);at=end<0?source.length:at+2+end;continue;}
   if(source.startsWith("/*",at)){const end=source.indexOf("*/",at+2);if(end<0)return source.length;at=end+2;continue;}
   break;
  }
  return at;
 }
 let codeClosingsChecked=0;
 for(const close of source.matchAll(/\}/gu)){
  if(!lexical.isCode(close.index)||templateClosings.has(close.index))continue;codeClosingsChecked++;
  if(source[afterTrivia(close.index+1)]==="/")throw new Error(`Ambiguous slash after native owner code brace at ${close.index}`);
 }
 return {codeClosingsChecked,templateSubstitutionClosings:templateClosings.size};
}
module.exports={assertUnambiguousModelComposerLexicalSource};
