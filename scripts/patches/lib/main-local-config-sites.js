"use strict";

const { Script } = require("node:vm");
const { mainProcessFactories } = require("./main-process-factories.js");
const { inspectMainRequestSites } = require("./main-request-sites.js");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("./minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";
const MEMBER = `${ID}(?:\\.${ID})*`;
const TOKENS = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
function drift(reason) { throw new Error(reason); }
function one(values, reason) { if (values.length !== 1) drift(reason); return values[0]; }
function frame(text, offset = 0) { return { text, offset, lexical: createJavaScriptLexicalIndex(text) }; }
function subframe(parent, start, end) { return frame(parent.text.slice(start, end), parent.offset + start); }
function range(owner, start, end) { return { start: owner.offset + start, end: owner.offset + end }; }
function next(owner, at) { while (at < owner.text.length && !owner.lexical.isCode(at)) at++; return at; }
function previous(owner, at) { while (at >= 0 && !owner.lexical.isCode(at)) at--; return at; }
function matches(owner, pattern, root = false) {
  return [...owner.text.matchAll(pattern)].filter(match => owner.lexical.isCode(match.index) && (!root || owner.lexical.isRoot(match.index)));
}
function trimmed(owner, start, end) {
  while (start < end && /\s/u.test(owner.text[start])) start++;
  while (end > start && /\s/u.test(owner.text[end - 1])) end--;
  return { start, end, text: owner.text.slice(start, end) };
}
function compact(owner, start = 0, end = owner.text.length) {
  let result = "";
  for (let at = start; at < end; at++) if (owner.lexical.isCode(at)) result += owner.text[at];
  return result;
}
function delimiterEnd(owner, open) {
  const pairs = { ")": "(", "]": "[", "}": "{" }, stack = [];
  if (!"([{".includes(owner.text[open])) drift("expected a native opening delimiter");
  for (let at = open; at < owner.text.length; at++) {
    if (!owner.lexical.isCode(at)) continue;
    const value = owner.text[at];
    if ("([{".includes(value)) stack.push(value);
    else if (pairs[value]) {
      if (stack.pop() !== pairs[value]) drift("mismatched native delimiters");
      if (stack.length === 0) return at;
    }
  }
  drift("incomplete native delimiter range");
}
function parts(owner, start, end) {
  const result = [], stack = [], pairs = { ")": "(", "]": "[", "}": "{" };
  let begin = start;
  for (let at = start; at <= end; at++) {
    if (at < end && !owner.lexical.isCode(at)) continue;
    const value = owner.text[at];
    if (at === end || value === "," && stack.length === 0) {
      const item = trimmed(owner, begin, at);
      if (!item.text) drift("empty native expression member");
      result.push(item); begin = at + 1; continue;
    }
    if ("([{".includes(value)) stack.push(value);
    else if (pairs[value] && stack.pop() !== pairs[value]) drift("unbalanced native expression member");
  }
  if (stack.length) drift("incomplete native expression member");
  return result;
}
function properties(owner, open, close, protectedKey = null) {
  const fields = new Map(), items = parts(owner, open + 1, close);
  const headers = items.map(item => new RegExp(`^(${ID})\\s*:\\s*`, "u").exec(item.text));
  const protectedAt = protectedKey == null ? -1 : one(headers.map((head, index) => ({ head, index }))
    .filter(value => value.head?.[1] === protectedKey), "native options protected property is missing or duplicated").index;
  for (const [index, item] of items.entries()) {
    const head = headers[index];
    // Earlier spreads are overwritten by the later explicit transport field.
    if (!head && protectedKey != null && index < protectedAt) continue;
    if (!head || fields.has(head[1])) drift("native options have unsupported or duplicate properties");
    const value = trimmed(owner, item.start + head[0].length, item.end);
    if (!value.text) drift("native options property has no value");
    fields.set(head[1], value);
  }
  return fields;
}
function expression(owner, field) { return field == null ? null : compact(owner, field.start, field.end); }
function scopeParses(owner, parameters, suffix = "") {
  try { new Script(`function nativeConfigScope(${parameters}){${owner.text}\n${suffix}}`); return true; }
  catch { return false; }
}
function localBinding(owner, parameters, name) {
  return scopeParses(frame(""), parameters, `let ${name};`) && scopeParses(owner, parameters) && !scopeParses(owner, parameters, `let ${name};`);
}
function statementAt(owner, at, parameters = "") {
  if (!owner.lexical.isRoot(at)) return false;
  return scopeParses(subframe(owner, 0, at), parameters, "const nativeConfigStatement=0;");
}
function noEarlyExit(owner, at, parameters = "") {
  for (const exit of matches(owner, /\b(?:return|throw)\b/gu, true)) {
    if (exit.index >= at) break;
    if (statementAt(owner, exit.index, parameters)) drift("native local config path has an earlier unconditional exit");
  }
}
function decoded(value) {
  return value.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => {
    const point = parseInt(braced || fixed, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\0";
  });
}
function references(owner, name) {
  const result = [];
  for (const token of owner.text.matchAll(TOKENS)) {
    if (decoded(token[0]) !== name || !owner.lexical.isCode(token.index)) continue;
    const before = previous(owner, token.index - 1);
    const after = next(owner, token.index + token[0].length);
    if ([".", "#"].includes(owner.text[before]) || owner.text[after] === ":") continue;
    result.push({ start: token.index, end: token.index + token[0].length, raw: token[0] });
  }
  return result;
}
function writes(owner, name) {
  const candidates = references(owner, name).filter(ref => {
    const after = next(owner, ref.end), before = previous(owner, ref.start - 1);
    return /^(?:\+\+|--|(?:\?\?|\|\||&&|[+*/%&|^\-])?=(?!=|>))/u.test(owner.text.slice(after)) ||
      ["++", "--"].includes(owner.text.slice(before - 1, before + 1));
  });
  const byStart = new Map(candidates.map(ref => [ref.start, ref]));
  for (const open of matches(owner, /[\[{]/gu)) {
    const end = delimiterEnd(owner, open.index), after = next(owner, end + 1);
    if (!/^=(?!=|>)/u.test(owner.text.slice(after))) continue;
    const target = subframe(owner, open.index + 1, end);
    for (const ref of references(target, name)) {
      const start = open.index + 1 + ref.start, stop = open.index + 1 + ref.end;
      byStart.set(start, { start, end: stop, raw: ref.raw });
    }
  }
  return [...byStart.values()].sort((left, right) => left.start - right.start);
}
function arrowExpressionEnd(owner, start) {
  const stack = [], pairs = { ")": "(", "]": "[", "}": "{" };
  for (let at = start; at < owner.text.length; at++) {
    if (!owner.lexical.isCode(at)) continue;
    const value = owner.text[at];
    if ("([{".includes(value)) stack.push(value);
    else if (pairs[value]) {
      if (stack.length === 0) return at;
      if (stack.pop() !== pairs[value]) drift("unbalanced native arrow expression");
    } else if (stack.length === 0 && [",", ";"].includes(value)) return at;
  }
  return owner.text.length;
}
function callableScopes(owner) {
  const scopes = [], seen = new Set();
  function add(open, selfName = null) {
    const close = delimiterEnd(owner, open), bodyOpen = next(owner, close + 1);
    if (owner.text[bodyOpen] !== "{" || seen.has(bodyOpen)) return;
    seen.add(bodyOpen);
    scopes.push({ parametersStart: open + 1, parametersEnd: close, bodyStart: bodyOpen + 1,
      bodyEnd: owner.lexical.matchingBrace(bodyOpen), expression: false, selfName });
  }
  for (const head of matches(owner, new RegExp(`\\b(?:async\\s+)?function\\s*(?:\\*\\s*)?(?:(${ID})\\s*)?\\(`, "gu"))) {
    add(head.index + head[0].length - 1, head[1]);
  }
  for (const head of matches(owner, new RegExp(`(?<![\\w$.#])(${ID})\\s*\\(`, "gu"))) {
    if (["if", "for", "while", "switch", "with"].includes(head[1])) continue;
    add(head.index + head[0].length - 1);
  }
  const parens = matches(owner, /\(/gu);
  for (const arrow of matches(owner, /=>/gu)) {
    const before = previous(owner, arrow.index - 1), bodyStart = next(owner, arrow.index + 2);
    let parametersStart, parametersEnd;
    if (owner.text[before] === ")") {
      const open = one(parens.filter(value => value.index < before && delimiterEnd(owner, value.index) === before), "native arrow parameters are unbalanced").index;
      parametersStart = open + 1; parametersEnd = before;
    } else {
      const token = [...owner.text.slice(0, before + 1).matchAll(TOKENS)].at(-1);
      if (!token || token.index + token[0].length !== before + 1 || !owner.lexical.isCode(token.index)) drift("native arrow parameter is unsupported");
      parametersStart = token.index; parametersEnd = before + 1;
    }
    if (owner.text[bodyStart] === "{") {
      if (seen.has(bodyStart)) continue;
      seen.add(bodyStart);
      scopes.push({ parametersStart, parametersEnd, bodyStart: bodyStart + 1,
        bodyEnd: owner.lexical.matchingBrace(bodyStart), expression: false });
    } else scopes.push({ parametersStart, parametersEnd, bodyStart,
      bodyEnd: arrowExpressionEnd(owner, bodyStart), expression: true });
  }
  return scopes;
}
function freeWrites(owner, parameters, name) {
  const candidates = writes(owner, name);
  if (candidates.length === 0) return candidates;
  const callables = callableScopes(owner), blocks = matches(owner, /\{/gu);
  let probeName = "__nativeConfigBindingProbe";
  while (owner.text.includes(probeName)) probeName += "$";
  const parses = text => scopeParses(frame(text), parameters);
  function callableOwns(scope, parameterReference) {
    if (scope.selfName === name) return true;
    const replacement = binding => {
      const declaration = `\n;let ${binding};\n`;
      if (scope.expression) return owner.text.slice(0, scope.bodyStart) + "{" + declaration + "}" + owner.text.slice(scope.bodyEnd);
      const prefix = owner.text.slice(0, parameterReference ? scope.bodyStart : scope.bodyEnd);
      return prefix + declaration + owner.text.slice(scope.bodyEnd);
    };
    // Removing the body keeps its var/lexical declarations from being mistaken
    // for bindings visible to a parameter default initializer.
    return parses(replacement(probeName)) && !parses(replacement(name));
  }
  function blockOwns(open, end) {
    const insert = binding => owner.text.slice(0, end) + `\n;let ${binding};\n` + owner.text.slice(end);
    if (!parses(insert(probeName))) return false;
    const body = owner.text.slice(open + 1, end);
    const isolated = binding => {
      try { new Script(`"use strict";async function* nativeBlockBinding(){while(true){${body}\n;var ${binding};\n}}`); return true; }
      catch { return false; }
    };
    // var does not create a block binding. A same-block lexical declaration
    // conflicts with this probe, while a hoisted var remains a free write.
    return isolated(probeName) && !isolated(name);
  }
  return candidates.filter(ref => {
    for (const scope of callables) {
      const bodyReference = scope.bodyStart <= ref.start && ref.start < scope.bodyEnd;
      const parameterReference = scope.parametersStart <= ref.start && ref.start < scope.parametersEnd;
      if ((bodyReference || parameterReference) && callableOwns(scope, parameterReference)) return false;
    }
    for (const open of blocks) {
      if (open.index >= ref.start) continue;
      const end = owner.lexical.matchingBrace(open.index);
      if (ref.start < end && blockOwns(open.index, end)) return false;
    }
    return true;
  });
}
function rootDeclaration(owner, at, parameters) {
  if (!owner.lexical.isRoot(at)) return false;
  let before = previous(owner, at - 1), boundary = before;
  if (owner.text[before] === ",") return scopeParses(subframe(owner, 0, before), parameters, ";const nativeConfigDeclaration=0;");
  while (boundary >= 0 && /[\w$]/u.test(owner.text[boundary])) boundary--;
  return ["let", "const", "var"].includes(owner.text.slice(boundary + 1, before + 1)) &&
    scopeParses(subframe(owner, 0, boundary + 1), parameters, "const nativeConfigDeclaration=0;");
}
function memberWrites(owner, name) {
  const result = [], token = new RegExp(TOKENS.source, "uy");
  for (const receiver of matches(owner, /(?<![\w$.#])this\b/gu)) {
    const access = next(owner, receiver.index + "this".length);
    let end;
    if (owner.text[access] === "[") {
      // A computed write can replace the protected member. Its key is not
      // evaluated while inspecting source, so this host shape fails closed.
      end = delimiterEnd(owner, access) + 1;
    } else if (owner.text[access] === ".") {
      token.lastIndex = next(owner, access + 1);
      const member = token.exec(owner.text);
      if (!member || decoded(member[0]) !== name) continue;
      end = token.lastIndex;
    } else continue;
    const before = previous(owner, receiver.index - 1);
    if (/^(?:\+\+|--|(?:\?\?|\|\||&&|[+*/%&|^\-])?=(?!=|>))/u.test(owner.text.slice(next(owner, end))) ||
        ["++", "--"].includes(owner.text.slice(before - 1, before + 1)) ||
        /(?<![\w$])delete$/u.test(owner.text.slice(0, before + 1))) result.push(receiver.index);
  }
  return result;
}
function stableOptions(selector) {
  const owner = selector.body, name = selector.options;
  if (freeWrites(owner, name, name).length) drift("native selector options binding is replaced");
}
function ordinaryMethod(factory, hostStart, hostEnd, name) {
  const open = factory.text.indexOf("{", hostStart), owner = subframe(factory, open + 1, hostEnd - 1);
  const headers = matches(owner, new RegExp(`(?<![\\w$.#])${escapeRegExp(name)}\\s*\\(`, "gu"), true);
  const head = one(headers, "missing or ambiguous native config caller method");
  const before = previous(owner, head.index - 1);
  if (before >= 0 && ![";", "}"].includes(owner.text[before])) drift("native config caller is not an ordinary instance method");
  const paramOpen = head.index + head[0].lastIndexOf("("), paramEnd = delimiterEnd(owner, paramOpen), bodyOpen = next(owner, paramEnd + 1);
  if (owner.text[bodyOpen] !== "{") drift("native config caller has no body");
  const end = owner.lexical.matchingBrace(bodyOpen), body = subframe(owner, bodyOpen + 1, end), parameters = owner.text.slice(paramOpen + 1, paramEnd);
  if (!scopeParses(body, parameters)) drift("native config caller scope is invalid");
  const names = matches(owner, new RegExp(`(?<![\\w$.#])${escapeRegExp(name)}(?![\\w$])`, "gu"), true);
  if (names.length !== 1) drift("native config caller member is shadowed");
  if (memberWrites(owner, name).length) drift("native config caller is replaced on its instance");
  for (const token of owner.text.matchAll(TOKENS)) {
    if (token[0] !== name && decoded(token[0]) === name && owner.lexical.isCode(token.index)) drift("native config caller uses an encoded member");
  }
  return { body, parameters, start: owner.offset + head.index, end: owner.offset + end + 1 };
}
function callerCalls(caller) {
  const calls = [];
  for (const head of matches(caller.body, new RegExp(`(?<![\\w$.#])(?<name>${ID})\\(\\{`, "gu"))) {
    if (/\bnew\s*$/u.test(caller.body.text.slice(0, head.index))) continue;
    const open = head.index + head[0].length - 1, close = caller.body.lexical.matchingBrace(open);
    if (close < open) continue;
    const object = subframe(caller.body, open + 1, close);
    if (!matches(object, /(?<![\w$.#])transportKind\s*:/gu, true).length) continue;
    const fields = properties(caller.body, open, close), kind = fields.get("transportKind")?.text;
    if (!["\"standard\"", "\"remote-control\""].includes(kind)) continue;
    const assignment = new RegExp(`(?<![\\w$.#])(${ID})\\s*=\\s*$`, "u").exec(caller.body.text.slice(0, head.index));
    if (!assignment) drift("native selector call is not the selected transport assignment");
    const end = next(caller.body, close + 1);
    if (caller.body.text[end] !== ")") drift("native selector arguments have an unknown continuation");
    const after = next(caller.body, end + 1);
    if (after < caller.body.text.length && ![";", "}", ","].includes(caller.body.text[after])) drift("native selected transport value is replaced");
    calls.push({ name: head.groups.name, binding: assignment[1], assignmentStart: assignment.index,
      start: head.index, end: end + 1, fields, kind: JSON.parse(kind) });
  }
  if (calls.length !== 2 || new Set(calls.map(call => call.kind)).size !== 2 ||
      new Set(calls.map(call => call.name)).size !== 1 || new Set(calls.map(call => call.binding)).size !== 1) drift("native standard/remote config callers are missing or ambiguous");
  return calls;
}
function callerFlow(caller, calls) {
  const standard = calls.find(call => call.kind === "standard"), remote = calls.find(call => call.kind === "remote-control"), transport = standard.binding;
  if (!localBinding(caller.body, caller.parameters, transport)) drift("selected native transport is not caller-local");
  const branch = [];
  for (const head of matches(caller.body, /\bif\(/gu, true)) {
    const condOpen = head.index + head[0].length - 1, condEnd = delimiterEnd(caller.body, condOpen), open = next(caller.body, condEnd + 1);
    if (caller.body.text[open] !== "{") continue;
    const end = caller.body.lexical.matchingBrace(open), elseAt = next(caller.body, end + 1);
    if (!caller.body.text.startsWith("else", elseAt)) continue;
    const alternative = compact(caller.body, elseAt + 4, standard.end);
    if (!(open < remote.assignmentStart && remote.end <= end) || !alternative.startsWith(`${transport}=${standard.name}({`)) continue;
    const consequent = subframe(caller.body, open + 1, end), local = remote.assignmentStart - open - 1;
    if (!statementAt(consequent, local, caller.parameters)) continue;
    if (localBinding(consequent, caller.parameters, transport)) drift("native remote transport assignment is shadowed by its branch");
    noEarlyExit(consequent, local, caller.parameters);
    branch.push({ open, end });
  }
  const selectedBranch = one(branch, "native selector caller branches are disconnected");
  const allowed = new Set(calls.map(call => call.assignmentStart));
  for (const write of freeWrites(caller.body, caller.parameters, transport)) {
    if (!allowed.has(write.start)) drift("native selected transport binding is overwritten");
    if (write.raw !== transport) drift("native selected transport uses an encoded binding");
  }
  const host = expression(caller.body, standard.fields.get("hostConfig"));
  if (!host || host !== expression(caller.body, remote.fields.get("hostConfig")) ||
      expression(caller.body, standard.fields.get("globalState")) !== "this.appState" ||
      expression(caller.body, remote.fields.get("globalState")) !== "this.appState" ||
      expression(caller.body, standard.fields.get("secretAuthStorageConfigOverrides")) !== "this.secretAuthStorageConfigOverrides") drift("native caller app/profile/auth options are disconnected");
  const clients = [];
  for (const head of matches(caller.body, new RegExp(`(?<![\\w$.#])(?<client>${ID})=new ${MEMBER}\\(`, "gu"), true)) {
    if (!rootDeclaration(caller.body, head.index, caller.parameters)) continue;
    const open = head.index + head[0].length - 1, end = delimiterEnd(caller.body, open), args = parts(caller.body, open + 1, end);
    if (args.length !== 2 || args[1].text[0] !== "{") continue;
    const fields = properties(caller.body, args[1].start, args[1].end - 1, "transport");
    if (expression(caller.body, fields.get("transport")) !== transport) continue;
    clients.push({ binding: head.groups.client, start: head.index, end: end + 1 });
  }
  const client = one(clients, "native selected transport does not feed one actual client");
  if (!localBinding(caller.body, caller.parameters, client.binding)) drift("native returned client is not caller-local");
  for (const write of freeWrites(caller.body, caller.parameters, client.binding)) {
    if (write.start !== client.start || write.raw !== client.binding) drift("native returned client binding is overwritten");
  }
  noEarlyExit(caller.body, client.start, caller.parameters);
  const returned = one(matches(caller.body, /\breturn\b/gu, true), "native config caller return is missing or ambiguous");
  if (returned.index < client.end) drift("native config client return precedes construction");
  const end = caller.body.text.trimEnd().endsWith(";") ? caller.body.text.trimEnd().length - 1 : caller.body.text.trimEnd().length;
  const values = parts(caller.body, returned.index + "return".length, end);
  if (values.at(-1).text !== client.binding) drift("native config caller does not return the constructed client");
}
function ordinarySelector(factory, name) {
  const head = one(matches(factory, new RegExp(`(?<![\\w$.#])function ${escapeRegExp(name)}\\((${ID})\\)\\{`, "gu"), true), "native config selector declaration is missing or ambiguous");
  const before = previous(factory, head.index - 1);
  if (before >= 0 && ![";", "}"].includes(factory.text[before]) || !statementAt(factory, head.index)) drift("native config selector is not an ordinary root declaration");
  const open = head.index + head[0].length - 1, end = factory.lexical.matchingBrace(open);
  return { name, options: head[1], start: factory.offset + head.index, end: factory.offset + end + 1, body: subframe(factory, open + 1, end) };
}
function overrides(selector, value) {
  const owner = selector.body, part = subframe(owner, value.start, value.end);
  const arrays = matches(part, /\[/gu, true).filter(open => compact(part, 0, open.index) === "async()=>");
  const open = one(arrays, "native config callback is not one zero-argument async array closure").index, end = delimiterEnd(part, open);
  if (next(part, end + 1) !== part.text.length) drift("native config callback continuation changed");
  const terms = parts(part, open + 1, end);
  if (terms.length < 3) drift("native config callback lost an ordered entry");
  const options = escapeRegExp(selector.options);
  if (!new RegExp(`^\\.\\.\\.\\(0,${MEMBER}\\)\\(${options}\\.globalState,${options}\\.hostConfig\\)$`, "u").test(compact(part, terms[0].start, terms[0].end)) ||
      compact(part, terms[1].start, terms[1].end) !== `...await${selector.options}.secretAuthStorageConfigOverrides`) drift("native global/secret config entry order or binding changed");
  const third = subframe(part, terms[2].start, terms[2].end), head = new RegExp(`^\\.\\.\\.await async function\\((${ID})\\)\\{`, "u").exec(third.text);
  if (!head) drift("native config tail is not the current awaited ordinary anonymous IIFE");
  const bodyOpen = head[0].length - 1, bodyEnd = third.lexical.matchingBrace(bodyOpen);
  if (bodyEnd < bodyOpen || compact(third, bodyEnd + 1) !== `(${selector.options})`) drift("native config IIFE is not directly called with the owned options");
  return { ...range(part, 0, part.text.length), arrayStart: part.offset + open, arrayEnd: part.offset + end + 1, nativePrefixEnd: part.offset + terms[2].end };
}
function nativeLocalReturn(selector) {
  const candidates = [];
  for (const head of matches(selector.body, new RegExp(`\\breturn new ${MEMBER}\\(\\{`, "gu"), true)) {
    const open = head.index + head[0].length - 1, close = selector.body.lexical.matchingBrace(open);
    if (close < open) continue;
    const fields = properties(selector.body, open, close);
    if (!fields.has("getConfigOverrides")) continue;
    const end = next(selector.body, close + 1);
    if (selector.body.text[end] !== ")" || !/^;?$/u.test(compact(selector.body, end + 1))) drift("native local transport is not the final returned constructor");
    const names = [...fields.keys()];
    if (names.join(",") !== "hostConfig,repoRoot,resourcesPath,defaultOriginator,getConfigOverrides") drift("native local constructor options changed");
    for (const name of names.slice(0, -1)) if (expression(selector.body, fields.get(name)) !== `${selector.options}.${name}`) drift("native local constructor is disconnected from its options");
    if (!statementAt(selector.body, head.index, selector.options)) drift("native local return is conditional or inactive");
    noEarlyExit(selector.body, head.index, selector.options);
    candidates.push({ localReturn: range(selector.body, head.index, end + 1), overrides: overrides(selector, fields.get("getConfigOverrides")) });
  }
  return one(candidates, "missing or ambiguous native final local config constructor");
}

/** Pure native site inspection. Ranges are absolute half-open UTF16 offsets.
 * Callback/array/declaration/return ranges include delimiters; selector body
 * ranges exclude braces. Extension source is owned and validated by adapters.
 * Native callback source keeps its ordered await operations and opaque IIFE. */
function inspectMainLocalConfigSite(source) {
  let factoryIds = [];
  const failure = reason => ({ ok: false, reason, factoryIds });
  if (typeof source !== "string") return failure("expected main-process source text");
  try {
    const inventory = mainProcessFactories(source); factoryIds = inventory.map(factory => factory.identity);
    const graph = inspectMainRequestSites(source);
    if (!graph.ok) return failure("missing native host/request scope for local config");
    const snapshot = one(inventory.filter(factory => factory.identity === graph.scope.factoryId), "native config factory identity is ambiguous"), factory = frame(snapshot.body, snapshot.start);
    const caller = ordinaryMethod(factory, graph.scope.hostStart - snapshot.start, graph.scope.hostEnd - snapshot.start, "createAppServerConnection"), calls = callerCalls(caller);
    callerFlow(caller, calls);
    const selector = ordinarySelector(factory, calls[0].name), refs = references(factory, selector.name), declaration = selector.start - factory.offset + "function ".length;
    const expected = new Set([declaration, ...calls.map(call => caller.body.offset - factory.offset + call.start)]);
    if (refs.length !== 3 || refs.some(ref => ref.raw !== selector.name || !expected.has(ref.start))) drift("native config selector binding is aliased or replaced");
    stableOptions(selector);
    const local = nativeLocalReturn(selector);
    return { ok: true, factoryIds, scope: { factoryId: snapshot.identity, factoryStart: snapshot.start, factoryEnd: snapshot.end,
      selectorStart: selector.start, selectorEnd: selector.end, selectorBodyStart: selector.body.offset, selectorBodyEnd: selector.body.offset + selector.body.text.length,
      callerStart: caller.start, callerEnd: caller.end }, optionsVar: selector.options, ...local };
  } catch (error) { return failure(error instanceof Error ? error.message : String(error)); }
}

module.exports = { inspectMainLocalConfigSite };
