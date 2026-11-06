"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { findMatchingBrace, createJavaScriptLexicalIndex } = require("./minified-js.js");

function legacyCode(source, index) {
  return findMatchingBrace("{" + source.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}
function legacyRoot(source, index) {
  return findMatchingBrace("{" + source.slice(0, index) + "}", 0) === index + 1;
}

test("lexical token index agrees with existing prefix queries across literals and comments", () => {
  const source = [
    'const text="fake function hidden(){}, 😀";',
    '/* function blocked(){} */ function real(value){',
    'const regex=/[`\"\'{}]+/g;const quotient=value/2;',
    'const template=`outside ${value?`nested ${value}`:"}"}`;',
    'if(value)/}/.test(text);return {value,template,regex,quotient};}',
    '// ignored function after(){}\nreal(text);',
  ].join("");
  const index = createJavaScriptLexicalIndex(source);
  const flags = source.indexOf("/g;") + 1;
  const templateStart = source.indexOf("`outside"), templateEnd = source.indexOf(";if(value)");
  const regexBrace = source.indexOf("/}/") + 1;
  for (const token of source.matchAll(/[A-Za-z_$][\w$]*|[{},;]/gu)) {
    // Artificially truncated prefixes cannot classify regex flags or template
    // substitutions. Their complete-source lexer state is asserted below.
    if (token.index === flags || token.index === regexBrace || templateStart <= token.index && token.index < templateEnd) continue;
    assert.equal(index.isCode(token.index), legacyCode(source, token.index), token[0]);
    if (index.isCode(token.index)) assert.equal(index.isRoot(token.index), legacyRoot(source, token.index), token[0]);
  }
  assert.equal(index.isCode(flags), false);
  assert.equal(index.isCode(regexBrace), false);
  assert.equal(index.isCode(source.indexOf("${value") + 2), true);
  assert.equal(index.isCode(source.indexOf("nested ")), false);
});

test("original brace ranges include nested template substitutions and UTF16 offsets", () => {
  const source = 'const label="😀";function outer(){return `${({value:()=>({x:1})}).value()}`;}';
  const index = createJavaScriptLexicalIndex(source);
  for (const token of source.matchAll(/\{/gu)) {
    if (!index.isCode(token.index)) continue;
    assert.equal(index.matchingBrace(token.index), findMatchingBrace(source, token.index));
  }
  assert.equal(findMatchingBrace.length, 2);
  assert.equal(index.matchingBrace(source.indexOf("😀")), -1);
});

test("incomplete scopes have no fabricated closing brace", () => {
  const source = 'function missing(){return {value:1};';
  const index = createJavaScriptLexicalIndex(source);
  assert.equal(index.matchingBrace(source.indexOf("{")), -1);
});
