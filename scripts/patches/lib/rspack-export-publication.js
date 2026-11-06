"use strict";

const { Script } = require("node:vm");
const { escapeRegExp, createJavaScriptLexicalIndex } = require("./minified-js.js");
const ID = "[A-Za-z_$][\\w$]*";
// Bound the string-keyed lexical views. Callers may pass changed snapshots,
// so caching by exact source text never reuses a stale proof.
const lexicalViews = new Map();
function lexical(body) {
  let view = lexicalViews.get(body);
  if (view) return view;
  view = createJavaScriptLexicalIndex(body);
  if (lexicalViews.size === 12) lexicalViews.delete(lexicalViews.keys().next().value);
  lexicalViews.set(body, view);
  return view;
}
function own(body, index) { return lexical(body).isRoot(index); }
function code(body, index) { return lexical(body).isCode(index); }
function findMatchingBrace(body, open) { return lexical(body).matchingBrace(open); }
function matches(body, pattern, root = true) {
  return [...body.matchAll(pattern)].filter(match => code(body, match.index) && (!root || own(body, match.index)));
}
function one(values) { return values.length === 1 ? values[0] : null; }
function statementAt(body, index) {
  if (!own(body, index)) return false;
  try { new Script(`function exportStatementProbe(){\n${body.slice(0, index)}\nconst declaration=0;\n}`); return true; }
  catch { return false; }
}
function evaluatedAt(body, index) {
  if (!statementAt(body, index)) return false;
  for (const exit of matches(body.slice(0, index), /\b(?:return|throw)\b/gu)) {
    try { new Script(`function exportReachabilityProbe(){\n${body.slice(0, exit.index)}\nconst reached=0;\n}`); }
    catch { continue; }
    return false;
  }
  return true;
}
function scopeParses(body, parameters, suffix = "") {
  try { new Script(`"use strict";async function publicationScopeProbe(${parameters}){\n${body}\n${suffix}\n}`); return true; }
  catch { return false; }
}
function localBinding(body, parameters, name) {
  return scopeParses(body, parameters) && !scopeParses(body, parameters, `let ${name};`);
}
function delimiterEnd(body, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, stack = [];
  if (!pairs[body[open]] || !code(body, open)) return -1;
  for (let index = open; index < body.length; index++) {
    if (!code(body, index)) continue;
    if (pairs[body[index]]) stack.push(pairs[body[index]]);
    else if (")]}".includes(body[index])) {
      if (stack.pop() !== body[index]) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}
function nextCode(body, index) {
  while (index < body.length && !code(body, index)) index++;
  return index;
}
function callableScope(body, parametersOpen) {
  const parametersEnd = delimiterEnd(body, parametersOpen);
  if (parametersEnd < parametersOpen) return null;
  const open = nextCode(body, parametersEnd + 1), end = findMatchingBrace(body, open);
  return body[open] === "{" && end > open ? { parametersOpen, parametersEnd, open, end } : null;
}
function contextBinding(body, start, end, name, probeName) {
  const prefix = body.slice(0, start), suffix = body.slice(end);
  const parses = binding => scopeParses(`${prefix}\nlet ${binding};\n${suffix}`, "");
  return parses(probeName) && !parses(name);
}
function loopDeclaration(header) {
  const declaration = /^\s*(?:let|const)\b\s*/u.exec(header);
  if (!declaration) return null;
  for (let index = declaration[0].length; index < header.length; index++) {
    if (!code(header, index)) continue;
    if ("([{".includes(header[index])) {
      index = delimiterEnd(header, index);
      if (index < 0) return null;
      continue;
    }
    const parameters = header.slice(declaration[0].length, index).trim();
    if (header[index] === ";") return parameters;
    if (/^(?:in|of)\b/u.test(header.slice(index)) && !/[\w$.]/u.test(header[index - 1]) &&
        parameters && scopeParses("", parameters)) return parameters;
  }
  return null;
}
function loopBodyEnd(body, start) {
  if (body[start] === "{") {
    const end = findMatchingBrace(body, start);
    return end > start ? end + 1 : -1;
  }
  const conditional = /^if\s*\(/u.exec(body.slice(start));
  if (conditional) {
    const close = delimiterEnd(body, start + conditional[0].length - 1);
    if (close < start) return -1;
    const end = loopBodyEnd(body, nextCode(body, close + 1));
    if (end < 0) return -1;
    const following = nextCode(body, end);
    return /^else\b/u.test(body.slice(following)) ? loopBodyEnd(body, nextCode(body, following + 4)) : end;
  }
  // Native single-statement loops use expressions or an if/return branch.
  // Balance the entire expression so a function/object value cannot end it.
  const jump = /^(?:return|throw)\b/u.exec(body.slice(start));
  const expressionStart = start + (jump?.[0].length ?? 0);
  const trivia = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/u.exec(body.slice(expressionStart))[0];
  if (jump?.[0] === "return" && /[\r\n\u2028\u2029]/u.test(trivia)) {
    return expressionStart;
  }
  let end = start;
  for (; end < body.length; end++) {
    if (!code(body, end)) continue;
    if ("([{".includes(body[end])) {
      end = delimiterEnd(body, end);
      if (end < 0) return -1;
    } else if (body[end] === ";" || body[end] === "}") break;
  }
  const expression = body.slice(expressionStart, end);
  if (!(jump?.[0] === "return" && expression.trim() === "") && !scopeParses(`return (${expression});`, "")) return -1;
  return end + Number(body[end] === ";");
}
function arrowExpressionEnd(body, start) {
  const stack = [], pairs = { ")": "(", "]": "[", "}": "{" };
  const tokens = /[()[\]{},;]/gu;
  tokens.lastIndex = start;
  let token;
  while ((token = tokens.exec(body)) != null) {
    const index = token.index, value = token[0];
    if (!code(body, index)) continue;
    if ("([{".includes(value)) { stack.push(value); continue; }
    if (stack.length && pairs[value] === stack.at(-1)) { stack.pop(); continue; }
    if (stack.length === 0 && scopeParses(`return (${body.slice(start, index)});`, "")) return index;
  }
  return scopeParses(`return (${body.slice(start)});`, "") ? body.length : -1;
}
function parameterProjection(body, name) {
  if (!scopeParses(body, "")) return body;
  const projected = body.split(""), hiddenScopes = [];
  let probeName = "__codexPublicationScopeProbe";
  while (body.includes(probeName)) probeName += "$";
  const hidden = index => hiddenScopes.some(([start, end]) => start <= index && index < end);
  function blank(start, end, replacement = "") {
    for (let index = start; index < end; index++) if (!/[\r\n]/u.test(projected[index])) projected[index] = " ";
    for (let index = 0; index < replacement.length; index++) projected[start + index] = replacement[index];
  }
  const functions = new RegExp(`\\b(?:async\\s+)?function\\b\\s*(?:\\*\\s*)?(?:(${ID})\\s*)?\\(`, "gu");
  for (const head of matches(body, functions, false)) {
    if (hidden(head.index)) continue;
    const scope = callableScope(body, head.index + head[0].length - 1);
    if (!scope || head[1] !== name && !contextBinding(body, scope.end, scope.end, name, probeName)) continue;
    // Body declarations do not bind a parameter default initializer. Preserve
    // those expressions unless the parameter list itself owns this name.
    if (head[1] === name || contextBinding(body, scope.open + 1, scope.end, name, probeName)) {
      blank(scope.parametersOpen + 1, scope.parametersEnd);
    }
    if (head[1] === name) {
      const nameStart = head.index + head[0].indexOf(name, head[0].indexOf("function") + "function".length);
      blank(nameStart, nameStart + name.length, name === "_" ? "$" : "_");
    }
    blank(scope.open + 1, scope.end);
    hiddenScopes.push([scope.open + 1, scope.end + 1]);
  }
  const classes = new RegExp(`\\bclass(?:\\s+(${ID}))?(?: extends ${ID}(?:\\.${ID})*)?\\{`, "gu");
  for (const head of matches(body, classes, false)) {
    if (hidden(head.index)) continue;
    const open = head.index + head[0].length - 1, end = findMatchingBrace(body, open);
    if (end < open) continue;
    if (head[1] === name) {
      const nameStart = head.index + head[0].indexOf(name, "class".length);
      blank(nameStart, nameStart + name.length);
      blank(open + 1, end);
      hiddenScopes.push([head.index, end + 1]);
      continue;
    }
    const members = body.slice(open + 1, end);
    const methods = new RegExp(`(?:(?:static|async|get|set)\\s+)?\\*?(${ID})\\s*\\(`, "gu");
    for (const method of matches(members, methods)) {
      const start = open + 1 + method.index;
      if (hidden(start)) continue;
      const scope = callableScope(body, start + method[0].length - 1);
      if (!scope || !contextBinding(body, scope.end, scope.end, name, probeName)) continue;
      // Keep the declaring class and its private names in both syntax probes.
      if (contextBinding(body, scope.open + 1, scope.end, name, probeName)) {
        blank(scope.parametersOpen + 1, scope.parametersEnd);
      }
      blank(scope.open + 1, scope.end);
      hiddenScopes.push([scope.open + 1, scope.end + 1]);
    }
    for (const property of matches(members, new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?=\\s*[=(;])`, "gu"))) {
      try { new Script(`"use strict";class publicationPropertyProbe{${members.slice(0, property.index)}\n__propertyProbe(){}\n}`); }
      catch { continue; }
      const start = open + 1 + property.index;
      blank(start, start + name.length, name === "_" ? "$" : "_");
    }
  }
  const arrows = /(?:\(([^()]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*/gu;
  for (const head of matches(body, arrows, false)) {
    if (hidden(head.index)) continue;
    const start = head.index + head[0].length, block = body[start] === "{";
    const end = block ? findMatchingBrace(body, start) : arrowExpressionEnd(body, start);
    if (end < start) continue;
    const scope = block ? body.slice(start + 1, end) : `return (${body.slice(start, end)});`;
    if (!localBinding(scope, head[1] ?? head[2], name)) continue;
    const arrow = head.index + head[0].indexOf("=>");
    if (head[1] == null) blank(head.index, arrow, name === "_" ? "$" : "_");
    else blank(head.index + 1, head.index + head[0].lastIndexOf(")", head[0].indexOf("=>")));
    if (block) blank(start + 1, end);
    else blank(start, end, "0");
    hiddenScopes.push([head.index, end + Number(block)]);
  }
  for (const head of matches(body, /\bfor(?:\s+await)?\s*\(/gu, false)) {
    if (hidden(head.index)) continue;
    const open = head.index + head[0].length - 1, close = delimiterEnd(body, open);
    if (close < open) continue;
    const declaration = loopDeclaration(body.slice(open + 1, close));
    if (!declaration || !localBinding("", declaration, name)) continue;
    const start = nextCode(body, close + 1), end = loopBodyEnd(body, start);
    if (end < start) continue;
    blank(head.index, end, ";");
    hiddenScopes.push([head.index, end]);
  }
  for (const open of matches(body, /\{/gu, false)) {
    if (hidden(open.index)) continue;
    const end = findMatchingBrace(body, open.index);
    if (end > open.index && localBinding(body.slice(open.index + 1, end), "", name)) blank(open.index + 1, end);
  }
  return projected.join("");
}
function stableParameter(body, name) {
  const projection = parameterProjection(body, name);
  if (!scopeParses(projection, "")) return false;
  const tokens = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
  for (const token of projection.matchAll(tokens)) {
    const decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
      (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
    if (decoded !== name || [".", "#"].includes(projection[token.index - 1]) ||
        /^\s*:/u.test(projection.slice(token.index + token[0].length)) || !code(projection, token.index)) continue;
    const probe = projection.slice(0, token.index) + "(0)" + projection.slice(token.index + token[0].length);
    if (!scopeParses(probe, "")) return false;
  }
  return true;
}

// Resolve only one factory-root require.d publication. The getter and direct
// value maps share duplicate/ambiguity checks. Function spans address the
// supplied moduleSource without executing factories or imported code. Binding
// records expose expression. Inline functions expose fn/exportName and set
// expression to null. Callers qualify their feature-specific role afterward.
function exportMembers(body, start, end) {
  const text = body.slice(start, end), separators = [];
  try { new Script(`const exportMapProbe={${text}};`); }
  catch { return null; }
  for (const comma of matches(text, /,/gu)) {
    try { new Script(`const exportMembersProbe={${text.slice(0, comma.index)}};`); separators.push(comma.index); }
    catch { /* A nested expression has not finished its member value. */ }
  }
  const members = new Map();
  let cursor = 0;
  for (const stop of [...separators, text.length]) {
    const member = text.slice(cursor, stop);
    if (member.trim() !== "") {
      const head = new RegExp(`^\\s*(${ID})\\s*:\\s*`, "u").exec(member);
      if (!head || head[1] === "__proto__" || members.has(head[1])) return null;
      members.set(head[1], { value: member.slice(head[0].length).trimEnd(), start: start + cursor + head[0].length });
    }
    cursor = stop + 1;
  }
  return members;
}
function findRspackExportPublication(module, key) {
  if (!module || typeof module.moduleSource !== "string" || !Array.isArray(module.params) || module.params.length !== 3 ||
      new Set(module.params).size !== 3 || !module.params.every(name => new RegExp(`^${ID}$`, "u").test(name))) return null;
  const body = module.moduleSource, req = module.params[2], target = module.params[1];
  const registrations = matches(body, new RegExp(`(?<![\\w$.])(${ID})\\.d\\((${ID}),\\{`, "gu"))
    .filter(call => call[1] === req && call[2] === target && evaluatedAt(body, call.index));
  const registration = one(registrations);
  if (!registration) return null;
  const requireName = registration[1], exportsName = registration[2];
  try { new Script(`function exportPublicationBindings(){\n${body}\n;let ${requireName};let ${exportsName};\n}`); }
  catch { return null; }
  if (!stableParameter(body, requireName) || !stableParameter(body, exportsName)) return null;
  const open = registration.index + registration[0].length - 1, end = findMatchingBrace(body, open);
  if (end < open) return null;
  const getters = exportMembers(body, open + 1, end);
  if (!getters) return null;
  let cursor = end + 1;
  while (/\s/u.test(body[cursor] ?? "") && cursor < body.length) cursor++;
  let values = new Map();
  if (body[cursor] === ",") {
    cursor++;
    while (/\s/u.test(body[cursor] ?? "") && cursor < body.length) cursor++;
    if (body[cursor] !== "{") return null;
    const valuesEnd = findMatchingBrace(body, cursor);
    if (valuesEnd < cursor) return null;
    values = exportMembers(body, cursor + 1, valuesEnd);
    if (!values) return null;
    cursor = valuesEnd + 1;
    while (/\s/u.test(body[cursor] ?? "") && cursor < body.length) cursor++;
  }
  if (body[cursor] !== ")" || [...getters.keys()].some(name => values.has(name))) return null;
  const publication = { requireName, exportsName };
  const getter = getters.get(key);
  if (getter) {
    const value = new RegExp(`^\\(\\)=>(${ID}(?:\\.${ID})?)$`, "u").exec(getter.value);
    return value ? { ...publication, expression: value[1] } : null;
  }
  const value = values.get(key);
  if (!value) return null;
  if (new RegExp(`^${ID}(?:\\.${ID})?$`, "u").test(value.value)) return { ...publication, expression: value.value };
  const fn = new RegExp(`^function(?: ${ID})?\\(([^)]*)\\)\\{`, "u").exec(value.value);
  if (!fn) return null;
  const functionOpen = value.start + fn[0].length - 1, functionEnd = findMatchingBrace(body, functionOpen);
  if (functionEnd !== value.start + value.value.length - 1) return null;
  try { new Script(`(${value.value})`); }
  catch { return null; }
  return { ...publication, expression: null, exportName: key,
    fn: { name: null, params: fn[1], start: value.start, end: functionEnd + 1, body: body.slice(functionOpen + 1, functionEnd) } };
}

module.exports = { findRspackExportPublication };
