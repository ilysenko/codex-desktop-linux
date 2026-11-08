"use strict";
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const ID = "[A-Za-z_$][\\w$]*";
const FIXED = new Set(["async", "await", "for", "of", "var", "let", "const", "function", "return", "if", "else", "new", "typeof", "void", "null", "true", "false", "JSON", "Math", "Date", "Number", "String", "Boolean", "RegExp", "Map", "Error", "TypeError", "Promise", "Intl", "window", "document", "arguments", "eval", "Object", "Array", "Set", "Symbol", "navigator", "undefined"]);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(message) { throw new Error("Experimental feature scope: " + message); }

function normalized(snapshot, body = snapshot.moduleSource) {
  if (snapshot.params.length !== 3 || new Set(snapshot.params).size !== 3) fail("factory parameters");
  if (snapshot.params.some(name => ["eval", "arguments"].includes(name))) fail("reserved factory binding");
  const lexical = createJavaScriptLexicalIndex(body), req = snapshot.params[2];
  const imports = [], edits = [];
  const pattern = new RegExp(`(?<![\\w$.])${escape(req)}\\(("(?:\\\\.|[^"\\\\])*")\\)`, "gu");
  for (const match of body.matchAll(pattern)) {
    if (!lexical.isRoot(match.index)) continue;
    const prefix = body.slice(0, match.index), local = prefix.match(new RegExp(`(${ID})=$`, "u"))?.[1];
    if (local != null) {
      const binding = findRspackRequireBinding({ ...snapshot, moduleSource: body }, local);
      if (binding == null || binding.moduleId !== JSON.parse(match[1])) fail("unbound or mutable import");
      imports.push({ local, moduleId: binding.moduleId });
    }
    const start = match.index + match[0].indexOf(match[1]);
    edits.push({ start, end: start + match[1].length, text: '"@import"' });
  }
  for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  const code = createJavaScriptLexicalIndex(body), names = new Map(snapshot.params.map((name, index) => [name, "$" + index]));
  let result = "", cursor = 0;
  for (const token of body.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const start = token.index, name = token[0];
    if (!code.isCode(start) || FIXED.has(name) || body[start - 1] === "." || /^\s*:/u.test(body.slice(start + name.length))) continue;
    if (!names.has(name)) names.set(name, "$" + names.size);
    result += body.slice(cursor, start) + names.get(name);
    cursor = start + name.length;
  }
  const renamed = result + body.slice(cursor);
  const renamedCode = createJavaScriptLexicalIndex(renamed);
  let text = "";
  for (let index = 0; index < renamed.length;) {
    if (renamedCode.isCode(index)) {
      text += renamed[index++];
      continue;
    }
    let end = index + 1;
    while (end < renamed.length && !renamedCode.isCode(end)) end++;
    const opaqueOrTrivia = renamed.slice(index, end);
    // The index also marks trivia non-code. Opaque runs and all line
    // terminators stay byte-for-byte. For spaces/tabs, preserve a separator
    // between word tokens and conservatively beside operator characters;
    // removing those could fuse keywords, identifiers or operators.
    if (!/^[ \t]+$/u.test(opaqueOrTrivia)) text += opaqueOrTrivia;
    else {
      const previous = renamed[index - 1] ?? "", next = renamed[end] ?? "";
      const wordBoundary = /[\w$]/u.test(previous) && /[\w$]/u.test(next);
      const operatorBoundary = /[+\-*/%&|^<>=!?~.]/u.test(previous + next);
      if (wordBoundary || operatorBoundary) text += " ";
    }
    index = end;
  }
  return { text, imports };
}

const contexts = new WeakMap();
function context(copy) {
  let value = contexts.get(copy);
  if (value?.body === copy.moduleSource && value.parameters === copy.params.join(",")) return value;
  if (copy.params.length !== 3 || new Set(copy.params).size !== 3 || !copy.params.every(name => new RegExp(`^${ID}$`, "u").test(name))) fail("factory parameters");
  new Script(`"use strict";(function(${copy.params}){${copy.moduleSource}\n});`);
  const body = copy.moduleSource, lexical = createJavaScriptLexicalIndex(body), functions = [];
  for (const token of body.matchAll(/\b(?:eval|Function)\s*\(|\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/gu)) {
    if (lexical.isCode(token.index)) fail("opaque lexical authority");
  }
  for (const match of body.matchAll(/\b(?:async\s+)?function(?:\s+([A-Za-z_$][\w$]*))?\s*\(/gu)) {
    if (!lexical.isCode(match.index)) continue;
    const parametersOpen = match.index + match[0].length - 1;
    let cursor = parametersOpen + 1, balance = 1;
    for (; cursor < body.length && balance; cursor++) {
      if (!lexical.isCode(cursor)) continue;
      if (body[cursor] === "(") balance++;else if (body[cursor] === ")") balance--;
    }
    if (balance) fail("function parameter bounds");
    const parametersEnd = cursor - 1;
    while (cursor < body.length && !lexical.isCode(cursor)) cursor++;
    const open = cursor, end = lexical.matchingBrace(open);
    if (body[open] !== "{") fail("function body");
    if (end < open) fail("function scope bounds");
    functions.push({ name: match[1] ?? null, params: body.slice(parametersOpen + 1, parametersEnd), start: match.index, open, end: end + 1,
      source: body.slice(match.index, end + 1), root: lexical.isRoot(match.index), locals: new Map() });
  }
  for (const match of body.matchAll(/(?:async\s*)?(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{/gu)) {
    if (!lexical.isCode(match.index)) continue;
    const open = match.index + match[0].length - 1, end = lexical.matchingBrace(open);
    if (end < open) fail("arrow scope bounds");
    functions.push({ name: null, params: match[1] ?? match[2], start: match.index, open, end: end + 1,
      source: body.slice(match.index, end + 1), root: false, locals: new Map() });
  }
  value = { body, parameters: copy.params.join(","), lexical, functions, blockLocals: new Map(), statementBlocks: new Map() };
  contexts.set(copy, value);
  return value;
}
function locallyBound(scope, name) {
  if (scope.locals.has(name)) return scope.locals.get(name);
  new Script(`"use strict";(${scope.source});`);
  let local = false;
  try { new Script(`"use strict";(${scope.source.slice(0, -1)}\nlet ${name};\n});`); }
  catch { local = true; }
  scope.locals.set(name, local);
  return local;
}
function enclosingFunctions(copy, at) {
  return context(copy).functions.filter(scope => scope.start < at && at < scope.end)
    .sort((a, b) => (a.end - a.start) - (b.end - b.start));
}
function blockBound(copy, name, at) {
  const ctx = context(copy), body = copy.moduleSource;
  let fresh = "__codexExperimentalBlockProbe";
  while (body.includes(fresh)) fresh += "$";
  for (let open = 0; open < at; open++) {
    if (body[open] !== "{" || !ctx.lexical.isCode(open)) continue;
    const close = ctx.lexical.matchingBrace(open);
    if (at >= close) continue;
    const key = open + ":" + name;
    if (ctx.blockLocals.has(key)) { if (ctx.blockLocals.get(key)) return true;continue; }
    const parses = local => {
      try { new Script(`"use strict";(function(${copy.params}){${body.slice(0, close)}\nlet ${local};\n${body.slice(close)}\n});`);return true; }
      catch { return false; }
    };
    let block = ctx.statementBlocks.get(open);
    if (block == null) { block = parses(fresh);ctx.statementBlocks.set(open, block); }
    const local = block && !parses(name);
    ctx.blockLocals.set(key, local);
    if (local) return true;
  }
  return false;
}
function unshadowed(copy, name, at) {
  for (const scope of enclosingFunctions(copy, at)) {
    if (scope.name === name || locallyBound(scope, name)) fail("captured binding " + name);
  }
  if (blockBound(copy, name, at)) fail("captured block binding " + name);
}
function rootFunction(copy, name) {
  const rows = context(copy).functions.filter(scope => scope.root && scope.name === name);
  if (rows.length !== 1) fail("root function " + name);
  return rows[0];
}
function enclosingFunction(copy, at) {
  const rows = enclosingFunctions(copy, at);
  if (!rows.length) fail("missing consumer scope");
  return rows[0];
}
function requireImport(copy, name, at, expectedId = null) {
  const binding = findRspackRequireBinding(copy, name);
  if (binding == null || copy.params.includes(name) || expectedId != null && binding.moduleId !== expectedId) fail("unbound import " + name);
  unshadowed(copy, name, at);
  const ctx = context(copy), initializer = binding.start - (copy.start ?? 0);
  for (const token of copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`, "gu"))) {
    if (!ctx.lexical.isCode(token.index) || /^\s*:/u.test(copy.moduleSource.slice(token.index + name.length))) continue;
    const tail = copy.moduleSource.slice(token.index + name.length);
    const write = /^\s*(?:=(?!=)|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(tail) ||
      /^\s*\.[A-Za-z_$][\w$]*\s*(?:=(?!=)|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(tail);
    if (!write || token.index === initializer) continue;
    if (!enclosingFunctions(copy, token.index).some(scope => locallyBound(scope, name)) && !blockBound(copy, name, token.index)) fail("reassigned import " + name);
  }
  for (const scope of ctx.functions) if (scope.root && scope.name === name) fail("redeclared import " + name);
  return binding;
}
function stableRootFunction(copy, name) {
  const scope = rootFunction(copy, name), ctx = context(copy);
  for (const token of copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`, "gu"))) {
    if (!ctx.lexical.isCode(token.index) || /^\s*:/u.test(copy.moduleSource.slice(token.index + name.length))) continue;
    if (!/^\s*(?:=(?!=)|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(copy.moduleSource.slice(token.index + name.length))) continue;
    if (!enclosingFunctions(copy, token.index).some(owner => locallyBound(owner, name)) && !blockBound(copy, name, token.index)) fail("reassigned root function " + name);
  }
  return scope;
}
function stableFactoryParameters(copy) {
  const ctx = context(copy);
  for (const name of copy.params.slice(1)) for (const token of copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`, "gu"))) {
    if (!ctx.lexical.isCode(token.index) || /^\s*:/u.test(copy.moduleSource.slice(token.index + name.length))) continue;
    const tail = copy.moduleSource.slice(token.index + name.length);
    const write = /^\s*(?:=(?!=)|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(tail) ||
      /^\s*\.[A-Za-z_$][\w$]*\s*=(?!=)/u.test(tail);
    if (write && !enclosingFunctions(copy, token.index).some(owner => locallyBound(owner, name)) && !blockBound(copy, name, token.index)) fail("mutable factory parameter " + name);
  }
}
function maps(copy) {
  const ctx = context(copy), body = copy.moduleSource, req = copy.params[2], out = copy.params[1];
  const calls = [...body.matchAll(new RegExp(`(?<![\\w$.])${escape(req)}\\.d\\(${escape(out)},\\{`, "gu"))]
    .filter(match => ctx.lexical.isRoot(match.index));
  if (calls.length !== 1) fail("unique root publication");
  const open = calls[0].index + calls[0][0].length - 1, end = ctx.lexical.matchingBrace(open);
  const result = [{ text: body.slice(open + 1, end), offset: open + 1 }];
  let cursor = end + 1;
  while (/\s/u.test(body[cursor] ?? "")) cursor++;
  if (body[cursor] === ",") {
    cursor++;while (/\s/u.test(body[cursor] ?? "")) cursor++;
    if (body[cursor] !== "{") fail("publication value map");
    const close = ctx.lexical.matchingBrace(cursor);
    result.push({ text: body.slice(cursor + 1, close), offset: cursor + 1 });cursor = close + 1;
  }
  while (/\s/u.test(body[cursor] ?? "")) cursor++;
  if (body[cursor] !== ")") fail("publication call close");
  return result;
}
function publicationMember(copy, key) {
  const found = [];
  for (const map of maps(copy)) {
    const lexical = createJavaScriptLexicalIndex(map.text);
    for (const head of map.text.matchAll(new RegExp(`\\b${escape(key)}:`, "gu"))) {
      if (!lexical.isRoot(head.index)) continue;
      const start = head.index + head[0].length;let end = start;
      while (end < map.text.length && !(map.text[end] === "," && lexical.isRoot(end))) end++;
      found.push({ value: map.text.slice(start, end), start: map.offset + start, end: map.offset + end });
    }
  }
  if (found.length !== 1) fail("publication " + key);
  return found[0];
}
function publishedRootFunction(copy, key) {
  const member = publicationMember(copy, key), match = new RegExp(`^\\(\\)=>(${ID})$`, "u").exec(member.value);
  if (!match) fail("function publication " + key);
  return stableRootFunction(copy, match[1]);
}
function reachable(copy, entry, target) {
  const ctx = context(copy), roots = ctx.functions.filter(scope => scope.root && scope.name), queue = [entry], seen = new Set();
  while (queue.length) {
    const scope = queue.shift();if (scope.start === target.start) return;
    if (seen.has(scope.start)) continue;seen.add(scope.start);
    for (const candidate of roots) {
      const use = new RegExp(`(?<![\\w$.])${escape(candidate.name)}\\(`, "gu");
      const jsx = new RegExp(`\\b${ID}\\.jsx(?:s)?\\)\\(${escape(candidate.name)}(?=,)`, "gu");
      for (const expression of [use, jsx]) for (const match of scope.source.matchAll(expression)) {
        const at = scope.start + match.index + match[0].lastIndexOf(candidate.name);
        if (!ctx.lexical.isCode(at) || at === candidate.start + candidate.source.indexOf(candidate.name)) continue;
        try { unshadowed(copy, candidate.name, at);stableRootFunction(copy, candidate.name);queue.push(candidate); } catch { /* A shadowed local is not this edge. */ }
      }
    }
  }
  fail("orphan published consumer scope");
}

module.exports = { normalized, context, rootFunction, stableRootFunction, stableFactoryParameters, enclosingFunction, unshadowed, requireImport, publicationMember, publishedRootFunction, reachable };
