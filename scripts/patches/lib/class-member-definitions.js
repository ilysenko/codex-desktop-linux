"use strict";

const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex } = require("./minified-js.js");

// Ranges are relative to the supplied complete class body.
function classTrivia(scope, start) {
  let index = start;
  for (;;) {
    while (/\s/u.test(scope.text[index] ?? "") && index < scope.text.length) index++;
    if (scope.text.startsWith("/*", index)) {
      const close = scope.text.indexOf("*/", index + 2);
      if (close < 0) throw new Error("Incomplete native class member comment");
      index = close + 2;
    } else if (scope.text.startsWith("//", index)) {
      const line = scope.text.slice(index + 2).search(/[\r\n\u2028\u2029]/u);
      index = line < 0 ? scope.text.length : index + 2 + line;
    } else return index;
  }
}

function classDelimiterEnd(scope, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, stack = [];
  for (let index = open; index < scope.text.length; index++) {
    if (!scope.lexical.isCode(index)) continue;
    const character = scope.text[index];
    if (pairs[character]) stack.push(pairs[character]);
    else if (")]}".includes(character)) {
      if (stack.pop() !== character) throw new Error("Unbalanced native class member");
      if (stack.length === 0) return index;
    }
  }
  throw new Error("Incomplete native class member");
}

function classQuotedKey(scope, start) {
  const quote = scope.text[start];
  let end = start + 1;
  for (; end < scope.text.length; end++) {
    if (scope.text[end] === "\\") end++;
    else if (quote === "`" && scope.text.startsWith("${", end)) throw new Error("Unproven interpolated native class key");
    else if (scope.text[end] === quote) break;
  }
  if (end >= scope.text.length) throw new Error("Incomplete native class key");
  const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
  const name = scope.text.slice(start + 1, end).replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/gu,
    (_, braced, fixed, hex, escaped) => {
      if (braced || fixed || hex) return String.fromCodePoint(parseInt(braced || fixed || hex, 16));
      if (/^[\r\n\u2028\u2029]/u.test(escaped)) return "";
      return escapes[escaped] ?? escaped;
    });
  return { name, end: end + 1 };
}

function classMemberKey(scope, start) {
  let index = start;
  const privateKey = scope.text[index] === "#";
  if (privateKey) index++;
  if (scope.text[index] === "[") {
    const close = classDelimiterEnd(scope, index), literalStart = classTrivia(scope, index + 1);
    if (!['"', "'", "`"].includes(scope.text[literalStart])) throw new Error("Unproven computed native class key");
    const key = classQuotedKey(scope, literalStart);
    if (classTrivia(scope, key.end) !== close) throw new Error("Unproven computed native class expression");
    return { name: key.name, end: close + 1, privateKey };
  }
  if (['"', "'"].includes(scope.text[index])) return { ...classQuotedKey(scope, index), privateKey };
  const identifier = /^(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/u.exec(scope.text.slice(index));
  if (!identifier) throw new Error("Unsupported native class key");
  const name = identifier[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
    (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
  return { name, end: index + identifier[0].length, privateKey };
}

function assertClassFieldBoundary(scope, equals, end) {
  if (scope.text[equals] !== "=") return;
  const bounded = scope.text.slice(0, equals + 1) + "(" + scope.text.slice(equals + 1, end) + "\n)" + scope.text.slice(end);
  try { new Script("class NativeFieldBoundaryProbe extends Object{" + bounded + "}"); }
  catch { throw new Error("Native class field initializer has an unproven ASI boundary"); }
}

function classMemberDefinitions(body) {
  const scope = { text: body, lexical: createJavaScriptLexicalIndex(body) };
  const members = [], modifiers = new Set(["static", "async", "get", "set"]);
  let index = 0;
  while ((index = classTrivia(scope, index)) < scope.text.length) {
    if (scope.text[index] === ";") { index++; continue; }
    const memberStart = index;
    const kinds = [];
    if (scope.text[index] === "*") { kinds.push("generator"); index = classTrivia(scope, index + 1); }
    let key = classMemberKey(scope, index), next = classTrivia(scope, key.end);
    while (!key.privateKey && modifiers.has(key.name) && !["(", "=", ";", undefined].includes(scope.text[next])) {
      kinds.push(key.name);
      index = next;
      if (scope.text[index] === "*") { kinds.push("generator"); index = classTrivia(scope, index + 1); }
      key = classMemberKey(scope, index);
      next = classTrivia(scope, key.end);
    }
    const keyStart = index;
    if (scope.text[next] === "(") {
      const parametersEnd = classDelimiterEnd(scope, next), open = classTrivia(scope, parametersEnd + 1);
      if (scope.text[open] !== "{") throw new Error("Missing native class method body");
      const close = scope.lexical.matchingBrace(open);
      if (close <= open) throw new Error("Incomplete native class method body");
      members.push({ ...key, kinds, kind: "method", start: memberStart, keyStart, end: close + 1,
        bodyStart: open + 1, bodyEnd: close, parametersStart: next + 1, parametersEnd });
      index = close + 1;
    } else {
      if (!["=", ";", undefined].includes(scope.text[next])) throw new Error("Unsupported native class field");
      const field = { ...key, kinds, kind: "field", start: memberStart, keyStart, initializerStart: scope.text[next] === "=" ? next + 1 : null };
      index = next;
      while (index < scope.text.length) {
        if (scope.lexical.isCode(index) && scope.text[index] === ";") break;
        if (scope.lexical.isCode(index) && "([{".includes(scope.text[index])) index = classDelimiterEnd(scope, index);
        index++;
      }
      assertClassFieldBoundary(scope, next, index);
      members.push({ ...field, initializerEnd: index, end: Math.min(index + 1, scope.text.length) });
      index++;
    }
  }
  return members;
}
module.exports = { classMemberDefinitions, staticMemberKey: classMemberKey };
