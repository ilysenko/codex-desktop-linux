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
  const projected = body.split(""), hiddenScopes = [];
  const hidden = index => hiddenScopes.some(([start, end]) => start <= index && index < end);
  function blank(start, end, replacement = "") {
    for (let index = start; index < end; index++) if (!/[\r\n]/u.test(projected[index])) projected[index] = " ";
    for (let index = 0; index < replacement.length; index++) projected[start + index] = replacement[index];
  }
  const functions = /(?:async )?function(?:\s+([A-Za-z_$][\w$]*))?\s*\(([^()]*)\)\s*\{/gu;
  for (const head of matches(body, functions, false)) {
    if (hidden(head.index)) continue;
    const open = head.index + head[0].length - 1, end = findMatchingBrace(body, open);
    if (end < open || head[1] !== name && !localBinding(body.slice(open + 1, end), head[2], name)) continue;
    const parametersEnd = head.index + head[0].lastIndexOf(")");
    blank(head.index + head[0].indexOf("(") + 1, parametersEnd);
    if (head[1] === name) {
      const nameStart = head.index + head[0].indexOf(name, head[0].indexOf("function") + "function".length);
      blank(nameStart, nameStart + name.length);
    }
    blank(open + 1, end);
    hiddenScopes.push([head.index, end + 1]);
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
    const methods = new RegExp(`(?:(?:static|async|get|set)\\s+)?(${ID})\\(([^()]*)\\)\\s*\\{`, "gu");
    for (const method of matches(members, methods)) {
      const start = open + 1 + method.index;
      if (hidden(start)) continue;
      const methodOpen = start + method[0].length - 1, methodEnd = findMatchingBrace(body, methodOpen);
      if (methodEnd < methodOpen || !localBinding(body.slice(methodOpen + 1, methodEnd), method[2], name)) continue;
      blank(start + method[0].indexOf("(") + 1, start + method[0].lastIndexOf(")"));
      blank(methodOpen + 1, methodEnd);
      hiddenScopes.push([start, methodEnd + 1]);
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
  for (const head of matches(body, /for\((?:let|const) ([A-Za-z_$][\w$]*)\b[^{}]*\)\{/gu, false)) {
    if (hidden(head.index)) continue;
    if (head[1] !== name) continue;
    const open = head.index + head[0].length - 1, end = findMatchingBrace(body, open);
    if (end < open) continue;
    blank(head.index, open, "for(;;)");
    blank(open + 1, end);
    hiddenScopes.push([head.index, end + 1]);
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
