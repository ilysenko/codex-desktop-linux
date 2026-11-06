"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { inspectMainRequestSites } = require("../../scripts/patches/lib/main-request-sites.js");
const { findMainProcessChunks, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");

const ID = "[A-Za-z_$][\\w$]*";
const RECORD_REPLAY_PLUGIN_NAME = "record-and-replay";
const MARKER = "/*codex-linux-record-replay-plugin-gate*/";
const LINUX_INSTALL = ',...("linux"===process.platform?{installWhenMissing:!0}:{})';
const IDENTIFIER_TOKEN = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
const lexicalViews = new Map();

function lexical(source) {
  let view = lexicalViews.get(source);
  if (view) return view;
  view = createJavaScriptLexicalIndex(source);
  if (lexicalViews.size === 4) lexicalViews.delete(lexicalViews.keys().next().value);
  lexicalViews.set(source, view);
  return view;
}

function one(values, role) {
  if (values.length !== 1) throw Error(`Missing or ambiguous ${role}`);
  return values[0];
}
function matches(source, pattern, root = true) {
  const candidates = [...source.matchAll(pattern)];
  if (candidates.length === 0) return candidates;
  const view = lexical(source);
  return candidates.filter(match => view.isCode(match.index) && (!root || view.isRoot(match.index)));
}
function groups(source) {
  const view = lexical(source);
  if (view.groups) return view.groups;
  const partners = new Int32Array(source.length), openings = [], stack = [];
  const closing = { "(": ")", "[": "]", "{": "}" };
  for (const token of source.matchAll(/[()[\]{}]/gu)) {
    if (!view.isCode(token.index)) continue;
    if (closing[token[0]]) {
      stack.push(token.index);
      openings.push(token.index);
    } else {
      const open = stack.pop();
      if (open == null || closing[source[open]] !== token[0]) throw Error("Unbalanced native source group");
      partners[open] = token.index + 1;
      partners[token.index] = open + 1;
    }
  }
  if (stack.length) throw Error("Incomplete native source group");
  view.groups = { partners, openings };
  return view.groups;
}
function delimiterEnd(source, open) {
  return "([{".includes(source[open]) ? groups(source).partners[open] - 1 : -1;
}
function nextCode(source, index) {
  const view = lexical(source);
  while (index < source.length && !view.isCode(index)) index++;
  return index;
}
function sourceParses(body, parameters = []) {
  try { new Script(`async function recordPluginScopeProbe(${parameters.join(",")}){\n${body}\n}`); return true; }
  catch { return false; }
}
function statementAt(body, index, parameters = []) {
  return lexical(body).isRoot(index) && sourceParses(body.slice(0, index) + "\nconst recordPluginStatementReached=0;\n", parameters);
}
function evaluatedAt(body, index, parameters = []) {
  if (!statementAt(body, index, parameters)) return false;
  return !matches(body.slice(0, index), /\b(?:return|throw)\b/gu)
    .some(exit => statementAt(body, exit.index, parameters));
}
function declarationCarrier(body, bindingIndex, parameters = []) {
  for (const head of matches(body, /\b(?:var|let|const)\s+/gu)) {
    if (head.index > bindingIndex) break;
    if (!statementAt(body, head.index, parameters)) continue;
    let cursor = nextCode(body, head.index + head[0].length);
    while (cursor < body.length) {
      const start = cursor;
      for (; cursor < body.length; cursor++) {
        if (!lexical(body).isCode(cursor)) continue;
        if ("([{".includes(body[cursor])) {
          cursor = delimiterEnd(body, cursor);
          if (cursor < 0) throw Error("Incomplete native declaration");
        } else if (body[cursor] === "," || body[cursor] === ";") break;
      }
      if (start === bindingIndex) {
        if (!evaluatedAt(body, head.index, parameters)) throw Error("Unevaluated native declaration");
        return { start: head.index, binding: bindingIndex };
      }
      if (body[cursor] !== ",") break;
      cursor = nextCode(body, cursor + 1);
    }
  }
  throw Error("Native binding is not its own evaluated declarator");
}
function directSequenceElement(body, sequenceStart, target, expected) {
  let cursor = sequenceStart;
  while (cursor < body.length) {
    const start = nextCode(body, cursor);
    cursor = start;
    for (; cursor < body.length; cursor++) {
      if (!lexical(body).isCode(cursor)) continue;
      if ("([{".includes(body[cursor])) cursor = delimiterEnd(body, cursor);
      else if (body[cursor] === "," || body[cursor] === ";") break;
    }
    if (start === target && body.slice(start, cursor) === expected) return;
    if (body[cursor] !== ",") break;
    cursor++;
  }
  throw Error("Native runtime assignment is not its direct evaluated sequence element");
}
function previousCode(source, index) {
  const view = lexical(source);
  while (index >= 0 && !view.isCode(index)) index--;
  return index;
}
function identifierValue(text) {
  return text.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
    (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
}
function triviaEnd(source, index) {
  const trivia = /(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n\u2028\u2029]*)*/uy;
  trivia.lastIndex = index;
  return index + trivia.exec(source)[0].length;
}
function quotedMemberKey(source, start) {
  const quote = source[start];
  if (!["'", '"', "`"].includes(quote)) return null;
  const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "0": "\0" };
  let value = "";
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === quote) return { value, end: index + 1 };
    if (quote === "`" && char === "$" && source[index + 1] === "{") return null;
    if (char !== "\\") { value += char; continue; }
    const escaped = source[++index];
    if (escaped === "\r" || escaped === "\n" || escaped === "\u2028" || escaped === "\u2029") {
      if (escaped === "\r" && source[index + 1] === "\n") index++;
    } else if (escaped === "u" || escaped === "x") {
      const braced = escaped === "u" && source[index + 1] === "{";
      const first = index + (braced ? 2 : 1), end = braced ? source.indexOf("}", first) : first + (escaped === "u" ? 4 : 2);
      const digits = source.slice(first, end);
      if (end < first || !/^[0-9a-f]+$/iu.test(digits) || !braced && digits.length !== (escaped === "u" ? 4 : 2)) return null;
      const point = parseInt(digits, 16);
      if (point > 0x10ffff) return null;
      value += String.fromCodePoint(point); index = end - Number(!braced);
    } else if (/[0-9]/u.test(escaped ?? "") && (escaped !== "0" || /[0-9]/u.test(source[index + 1] ?? ""))) return null;
    else value += escapes[escaped] ?? escaped;
  }
  return null;
}
function staticMember(source, index) {
  let cursor = triviaEnd(source, index);
  if (source[cursor] === ".") {
    cursor = triviaEnd(source, cursor + 1);
    const identifier = new RegExp(IDENTIFIER_TOKEN.source, "uy"); identifier.lastIndex = cursor;
    const match = identifier.exec(source);
    return match ? { value: identifierValue(match[0]), end: cursor + match[0].length } : null;
  }
  if (source[cursor] !== "[") return null;
  const literal = quotedMemberKey(source, triviaEnd(source, cursor + 1));
  if (!literal || source[triviaEnd(source, literal.end)] !== "]") return { unknown: true };
  return { value: literal.value, end: triviaEnd(source, literal.end) + 1 };
}
function memberReferences(source, receiver, field) {
  const [binding, ...path] = receiver.split("."), expected = [...path, field], references = [], view = lexical(source);
  for (const token of source.matchAll(IDENTIFIER_TOKEN)) {
    if (!view.isCode(token.index) || token[0] !== binding && (!token[0].includes("\\u") || identifierValue(token[0]) !== binding)) continue;
    const before = previousCode(source, token.index - 1);
    if (source[before] === "#" ||
        source[before] === "." && source.slice(before - 2, before + 1) !== "...") continue;
    let cursor = token.index + token[0].length, matched = true;
    for (const name of expected) {
      const member = staticMember(source, cursor);
      if (member?.unknown) { references.push({ index: token.index, unknown: true }); matched = false; break; }
      if (!member || member.value !== name) { matched = false; break; }
      cursor = member.end;
    }
    if (matched) references.push({ index: token.index, end: cursor, unknown: false });
  }
  return references;
}
function identifierBefore(source, index) {
  let start = index;
  while (start >= 0 && /[\w$\\{}]/u.test(source[start])) start--;
  const value = source.slice(start + 1, index + 1);
  const identifier = /^(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*$/u;
  return identifier.test(value) ? { index: start + 1, value } : null;
}
function contextBinding(body, start, end, name, fresh, parameters, kind = "let") {
  const prefix = body.slice(0, start), suffix = body.slice(end);
  const parses = binding => sourceParses(`${prefix}\n${kind} ${binding};\n${suffix}`, parameters);
  return parses(fresh) && !parses(name);
}
function bodyScope(source, open) {
  const end = delimiterEnd(source, open), previous = previousCode(source, open - 1);
  if (end < open) return null;
  let parametersStart, parametersEnd, kind = "block", functionName = null, nameStart = null;
  let before = previous;
  if (source[previous] === ">" && source[previousCode(source, previous - 1)] === "=") {
    kind = "callable";
    before = previousCode(source, previousCode(source, previous - 1) - 1);
  }
  if (source[before] === ")") {
    const parametersOpen = groups(source).partners[before] - 1;
    parametersStart = parametersOpen + 1; parametersEnd = before;
    const word = identifierBefore(source, previousCode(source, parametersOpen - 1));
    const controls = ["if", "for", "while", "switch", "with", "catch"];
    if (kind === "callable" || !word || !controls.includes(word.value)) kind = "callable";
    else if (word.value === "catch") kind = "catch";
    if (word && controls.includes(word.value)) {
      const beforeWord = source.slice(0, word.index), afterWord = source.slice(word.index);
      if (sourceParses(beforeWord + "__codexRecordMethodProbe(){}" + afterWord) ||
          sourceParses(beforeWord + "__codexRecordMethodProbe(){}," + afterWord)) kind = "callable";
    }
    if (word && word.value !== "function") {
      let prior = previousCode(source, word.index - 1);
      if (source[prior] === "*") prior = previousCode(source, prior - 1);
      if (identifierBefore(source, prior)?.value === "function") { functionName = word.value; nameStart = word.index; }
    }
  } else if (kind === "callable") {
    const parameter = identifierBefore(source, before);
    if (!parameter) return null;
    parametersStart = parameter.index; parametersEnd = before + 1;
  }
  return { open, end, kind, parametersStart, parametersEnd, functionName, nameStart };
}
function arrowScopes(source) {
  const result = [];
  for (const arrow of matches(source, /=>/gu, false)) {
    const start = nextCode(source, arrow.index + 2);
    if (source[start] === "{") continue;
    const before = previousCode(source, arrow.index - 1);
    let parametersStart, parametersEnd;
    if (source[before] === ")") {
      parametersStart = groups(source).partners[before]; parametersEnd = before;
    } else {
      const parameter = identifierBefore(source, before);
      if (!parameter) continue;
      parametersStart = parameter.index; parametersEnd = before + 1;
    }
    let end = start;
    for (; end < source.length; end++) {
      if (!lexical(source).isCode(end)) continue;
      if ("([{".includes(source[end])) end = delimiterEnd(source, end);
      else if (",;)]}".includes(source[end])) break;
    }
    result.push({ start, end, parametersStart, parametersEnd });
  }
  return result;
}
function bindingAuthority(body, name, parameters = [], factoryScopes = []) {
  const view = lexical(body), paired = groups(body);
  let fresh = "__codexRecordBindingProbe";
  while (body.includes(fresh)) fresh += "$";
  const ownership = new Map(), bodyScopes = new Map(), factoryOwnership = new Map(), proofs = new Map();
  let arrows;
  const scopeAt = open => {
    if (!bodyScopes.has(open)) bodyScopes.set(open, bodyScope(body, open));
    return bodyScopes.get(open);
  };
  const declares = (start, end, kind = "let") => {
    const key = `${start}:${end}:${kind}`;
    if (!proofs.has(key)) proofs.set(key, contextBinding(body, start, end, name, fresh, parameters, kind));
    return proofs.get(key);
  };
  const callableDeclares = (scope, parametersOnly) => {
    const params = [body.slice(scope.parametersStart, scope.parametersEnd)];
    const inner = parametersOnly ? "" : body.slice(scope.open + 1, scope.end);
    // A standalone callable that parses can prove its own local bindings.
    // Private names, super and generator syntax retain the full context probe.
    if (sourceParses(inner, params) && !sourceParses(inner + `\nlet ${name};`, params)) return true;
    return parametersOnly ? declares(scope.open + 1, scope.end) : declares(scope.end, scope.end);
  };
  const factoryLocal = index => factoryScopes.some(scope => {
    if (scope.parametersStart <= index && index < scope.parametersEnd && scope.parameters.includes(name)) return true;
    if (!(scope.open < index && index < scope.end)) return false;
    if (!factoryOwnership.has(scope.open)) {
      const owns = scope.parameters.includes(name) || sourceParses(scope.body, scope.parameters) &&
        !sourceParses(scope.body + `\nlet ${name};`, scope.parameters);
      factoryOwnership.set(scope.open, owns);
    }
    return factoryOwnership.get(scope.open);
  });
  const local = index => {
    if (ownership.has(index)) return ownership.get(index);
    if (factoryLocal(index)) { ownership.set(index, true); return true; }
    for (const open of paired.openings) {
      const end = paired.partners[open] - 1;
      if (open >= index || end <= index) continue;
      if (body[open] === "(") {
        const after = nextCode(body, end + 1), block = body[after] === "{" ? after :
          body.slice(after, after + 2) === "=>" ? nextCode(body, after + 2) : -1;
        if (body[block] !== "{") continue;
        const scope = scopeAt(block);
        const self = scope?.functionName === name && sourceParses(body.slice(0, scope.nameStart) + body.slice(scope.nameStart + name.length), parameters);
        if (self || ["callable", "catch"].includes(scope?.kind) && callableDeclares(scope, true)) {
          ownership.set(index, true); return true;
        }
      }
      if (body[open] !== "{") continue;
      const scope = scopeAt(open);
      if (!scope) continue;
      if (scope.functionName === name && sourceParses(body.slice(0, scope.nameStart) + body.slice(scope.nameStart + name.length), parameters)) {
        ownership.set(index, true); return true;
      }
      const ownParameters = ["callable", "catch"].includes(scope.kind) && callableDeclares(scope, true);
      const callableLocal = scope.kind === "callable" && callableDeclares(scope, false);
      const lexicalLocal = scope.kind === "block" && declares(end, end) && declares(end, end, "var") &&
        !matches(body.slice(open + 1, end), new RegExp(`\\bfunction ${escapeRegExp(name)}\\b`, "gu")).length;
      if (ownParameters || callableLocal || lexicalLocal) { ownership.set(index, true); return true; }
    }
    arrows ??= arrowScopes(body);
    for (const arrow of arrows) {
      if (!(arrow.parametersStart <= index && index < arrow.parametersEnd || arrow.start <= index && index < arrow.end)) continue;
      const prefix = body.slice(0, arrow.start), suffix = body.slice(arrow.end);
      const parses = binding => sourceParses(`${prefix}{let ${binding};}${suffix}`, parameters);
      if (parses(fresh) && !parses(name)) { ownership.set(index, true); return true; }
    }
    ownership.set(index, false); return false;
  };
  return { local, factoryLocal, fresh, view };
}
function stableRootBinding(body, name, assignmentIndex, options = {}) {
  const parameters = options.parameters ?? [], allowed = new Set(options.declarations ?? []);
  if (assignmentIndex != null) allowed.add(assignmentIndex);
  const authority = bindingAuthority(body, name, parameters, options.factoryScopes);
  for (const token of body.matchAll(IDENTIFIER_TOKEN)) {
    if (!authority.view.isCode(token.index)) continue;
    const decoded = identifierValue(token[0]);
    if (decoded !== name || allowed.has(token.index)) continue;
    const before = previousCode(body, token.index - 1), after = nextCode(body, token.index + token[0].length);
    if ([".", "#"].includes(body[before]) || body[after] === ":") continue;
    if (authority.factoryLocal(token.index)) continue;
    if ([".", "["].includes(body[after]) || body.slice(after, after + 2) === "?.") continue;
    if (/^(?:\+\+|--|(?:\?\?|\|\||&&|[+*/%&|^\-])?=(?!=|>))/u.test(body.slice(after)) && authority.local(token.index)) continue;
    const prefix = body.slice(0, token.index), suffix = body.slice(token.index + token[0].length);
    if (/\bfunction\b\s*(?:\*\s*)?$/u.test(prefix) && sourceParses(prefix + suffix, parameters)) continue;
    if (sourceParses(prefix + "(0)" + suffix, parameters) ||
        sourceParses(prefix + `${name}:(0)` + suffix, parameters)) continue;
    if (sourceParses(prefix + `${authority.fresh}(){}` + body.slice(token.index), parameters) ||
        sourceParses(prefix + `${authority.fresh}(){},` + body.slice(token.index), parameters)) continue;
    if (!authority.local(token.index)) return false;
  }
  return true;
}

// The adapter follows the evaluated seed table, its real module loader, the
// CommonJS chunk installer and the final exported bootstrap invocation. Only
// the table carrier changes for the shared parser. Factory bytes stay exact.
function entryFactories(source) {
  const heads = matches(source, new RegExp(`\\(\\(\\)=>\\{var (?:${ID},)*(?<table>${ID})=\\{`, "gu"));
  if (heads.length === 0) return [];
  const head = one(heads, "evaluated main entry seed"), outerStart = head.index + 6;
  try { new Script(`function entryPreludeProbe(){${source.slice(0, head.index)}\nconst entryPreludeReached=0;\n}`); }
  catch { throw Error("Conditional main entry seed"); }
  if (matches(source.slice(0, head.index), /\b(?:return|throw)\b/gu).length) throw Error("Unreachable main entry seed");
  const open = head.index + head[0].length - 1, end = delimiterEnd(source, open);
  if (end < open) throw Error("Incomplete main entry seed table");
  const suffix = source.slice(end + 1);
  const loaderHead = new RegExp(`^,(?<cache>${ID})=\\{\\};function (?<loader>${ID})\\((?<request>${ID})\\)\\{`, "u").exec(suffix);
  if (!loaderHead) throw Error("Unsupported main entry loader");
  const { table } = head.groups, { cache, loader, request } = loaderHead.groups;
  if (new Set([table, cache, loader]).size !== 3) throw Error("Aliased main entry loader roles");
  const loaderOpen = end + loaderHead[0].length, loaderEnd = delimiterEnd(source, loaderOpen);
  const loaderBody = source.slice(loaderOpen + 1, loaderEnd);
  const loaderPattern = new RegExp(`^var (?<cached>${ID})=${escapeRegExp(cache)}\\[${escapeRegExp(request)}\\];if\\(void 0!==\\k<cached>\\)return \\k<cached>\\.exports;var (?<module>${ID})=${escapeRegExp(cache)}\\[${escapeRegExp(request)}\\]=\\{exports:\\{\\}\\};return ${escapeRegExp(table)}\\[${escapeRegExp(request)}\\]\\.call\\(\\k<module>\\.exports,\\k<module>,\\k<module>\\.exports,${escapeRegExp(loader)}\\),\\k<module>\\.exports$`, "u");
  if (!loaderPattern.test(loaderBody) || !source.slice(loaderEnd + 1).startsWith(`${loader}.m=${table},${loader}.c=${cache},`)) {
    throw Error("Disconnected main entry loader/table");
  }
  const outerEnd = delimiterEnd(source, head.index + 5), outer = source.slice(outerStart, outerEnd);
  if (!/^\)\(\);(?:\s*\/\/# sourceMappingURL=[^\n]*)?\s*$/u.test(source.slice(outerEnd + 1))) throw Error("Unevaluated main entry wrapper");
  const bootstrap = new RegExp(`var (?<value>${ID})=${escapeRegExp(loader)}\\((?<id>\\d+)\\);module\\.exports=\\k<value>$`, "u").exec(outer);
  if (!bootstrap || !lexical(outer).isRoot(bootstrap.index)) throw Error("Missing evaluated main entry bootstrap");
  try { new Script(`function entryCallerProbe(){${outer.slice(0, bootstrap.index)}\nconst entryCallerReached=0;\n}`); }
  catch { throw Error("Conditional main entry bootstrap"); }
  if (matches(outer.slice(0, bootstrap.index), /\b(?:return|throw)\b/gu).length) throw Error("Unreachable main entry bootstrap");
  for (const scope of [source.slice(0, head.index), outer]) {
    try { new Script(`function entryGlobalsProbe(){${scope}\nlet require;let module;}`); }
    catch { throw Error("Shadowed native entry CommonJS globals"); }
    if (!stableRootBinding(scope, "require", null) || !stableRootBinding(scope, "module", null)) {
      throw Error("Replaced native entry CommonJS globals");
    }
  }
  const install = new RegExp(`${escapeRegExp(loader)}\\.f\\.require=\\(${ID},${ID}\\)=>\\{`, "gu");
  const installer = one(matches(outer, install), "native CommonJS chunk installer");
  const installerOpen = installer.index + installer[0].length - 1, installerEnd = delimiterEnd(outer, installerOpen);
  const installerSource = outer.slice(installer.index, installerEnd + 1);
  const installHead = new RegExp(`^${escapeRegExp(loader)}\\.f\\.require=\\((?<chunk>${ID}),(?<pending>${ID})\\)=>\\{(?<loaded>${ID})\\[\\k<chunk>\\]\\|\\|\\((?<payload>${ID})=>\\{var (?<modules>${ID})=\\k<payload>\\.modules,(?<ids>${ID})=\\k<payload>\\.ids,(?<runtime>${ID})=\\k<payload>\\.runtime;for\\(var (?<key>${ID}) in \\k<modules>\\)`, "u").exec(installerSource);
  const indexHead = new RegExp(`for\\(var (${ID})=0;`, "u").exec(installerSource);
  if (!installHead || !indexHead) throw Error("Unsupported native CommonJS chunk installer");
  const { chunk, pending, loaded, payload, modules, ids, runtime, key } = installHead.groups, index = indexHead[1];
  const expectedInstall = `${loader}.f.require=(${chunk},${pending})=>{${loaded}[${chunk}]||(${payload}=>{var ${modules}=${payload}.modules,${ids}=${payload}.ids,${runtime}=${payload}.runtime;for(var ${key} in ${modules})${loader}.o(${modules},${key})&&(${loader}.m[${key}]=${modules}[${key}]);${runtime}&&${runtime}(${loader});for(var ${index}=0;${index}<${ids}.length;${index}++)${loaded}[${ids}[${index}]]=1})(require("./"+${loader}.u(${chunk})))}`;
  if (installerSource !== expectedInstall) throw Error("Disconnected native CommonJS chunk installer");
  const loadedTable = one(matches(outer, new RegExp(`(?<![\\w$.#])${escapeRegExp(loaded)}=\\{\\d+:1\\}`, "gu")), "native loaded-chunk table");
  const prefix = "exports.ids=[0],exports.modules=", delta = open - prefix.length;
  const factories = mainProcessFactories(prefix + source.slice(open, end + 1) + ";")
    .map(factory => ({ ...factory, start: factory.start + delta, end: factory.end + delta, carrier: "evaluated-entry-seed" }));
  const factoryScopes = factories.map(factory => {
    const close = previousCode(source, factory.start - 2), parametersOpen = groups(source).partners[close] - 1;
    if (source[close] !== ")" || source.slice(parametersOpen + 1, close) !== factory.parameters.join(",")) throw Error("Changed native entry factory parameters");
    return { open: factory.start - 1 - outerStart, end: factory.end - outerStart, body: factory.body,
      parameters: factory.parameters, parametersStart: parametersOpen + 1 - outerStart, parametersEnd: close - outerStart };
  });
  const tableSite = open - table.length - 1 - outerStart, cacheSite = end + 2 - outerStart;
  declarationCarrier(outer, tableSite); declarationCarrier(outer, cacheSite);
  const loaderSite = end + 1 + loaderHead[0].indexOf("function ") - outerStart;
  if (!evaluatedAt(outer, loaderSite) || !evaluatedAt(outer, loaderEnd + 1 - outerStart)) throw Error("Unevaluated native loader carrier");
  directSequenceElement(outer, loaderEnd + 1 - outerStart, loadedTable.index, loadedTable[0]);
  directSequenceElement(outer, loaderEnd + 1 - outerStart, installer.index, expectedInstall);
  const loadedDeclaration = new RegExp(`(?<![\\w$])${escapeRegExp(loaded)}(?=[,=])`, "u").exec(source.slice(head.index + 6, open));
  if (!loadedDeclaration) throw Error("Missing native loaded-chunk declaration");
  const loaderDeclaration = loaderSite + "function ".length;
  const options = { factoryScopes };
  if (!stableRootBinding(outer, table, tableSite, options) || !stableRootBinding(outer, cache, cacheSite, options) ||
      !stableRootBinding(outer, loaded, loadedTable.index, { ...options, declarations: [loadedDeclaration.index] }) ||
      !stableRootBinding(outer, loader, null, { ...options, declarations: [loaderDeclaration] }) ||
      matches(outer, new RegExp(`function ${escapeRegExp(loader)}\\(`, "gu")).length !== 1 ||
      matches(outer, new RegExp(`${escapeRegExp(loader)}(?:\\.m|\\[["']m["']\\])`, "gu")).length !== 1 ||
      matches(outer, new RegExp(`${escapeRegExp(loader)}(?:\\.c|\\[["']c["']\\])`, "gu")).length !== 1) {
    throw Error("Replaced native entry loader authority");
  }
  if (!factories.some(factory => factory.identity === bootstrap.groups.id)) throw Error("Missing main entry bootstrap factory");
  for (const factory of factories) if (source.slice(factory.start, factory.end) !== factory.body) throw Error("Changed entry factory bytes");
  return factories;
}

function rootImport(factory, binding) {
  const requireName = factory.parameters[2];
  if (!requireName) throw Error("Missing native factory require parameter");
  const pattern = new RegExp(`(?<![\\w$.#])${escapeRegExp(binding)}=${escapeRegExp(requireName)}\\((\\d+)\\)`, "gu");
  const imported = one(matches(factory.body, pattern), `${binding} native import`);
  declarationCarrier(factory.body, imported.index, factory.parameters);
  if (!stableRootBinding(factory.body, binding, imported.index, { parameters: factory.parameters })) throw Error(`Unstable ${binding} native import`);
  return imported[1];
}
function publication(factory, key) {
  const result = findRspackExportPublication({ moduleSource: factory.body, params: factory.parameters }, key);
  if (!result || !result.expression) throw Error(`Unqualified native ${key} publication`);
  return result;
}
function rowsOf(source, open, end) {
  const rows = [];
  let cursor = nextCode(source, open + 1);
  while (cursor < end) {
    if (source[cursor] !== "{") throw Error("Unsupported bundled plugin registry row");
    const close = delimiterEnd(source, cursor);
    if (close < cursor || close >= end) throw Error("Incomplete bundled plugin registry row");
    rows.push({ start: cursor, end: close + 1, text: source.slice(cursor, close + 1) });
    cursor = nextCode(source, close + 1);
    if (cursor === end) break;
    if (source[cursor] !== ",") throw Error("Unsupported bundled plugin registry separator");
    cursor = nextCode(source, cursor + 1);
  }
  return rows;
}
function registryOf(factory) {
  const candidates = [];
  for (const assignment of matches(factory.body, new RegExp(`(?<![\\w$.#])(${ID})=\\[`, "gu"))) {
    const open = assignment.index + assignment[0].length - 1, end = delimiterEnd(factory.body, open);
    if (end < open) throw Error("Incomplete root array");
    const text = factory.body.slice(open, end + 1);
    if (!text.includes(".recordAndReplay") || !text.includes(".computerUse") || !text.includes(".visualize")) continue;
    const rows = rowsOf(factory.body, open, end);
    const record = one(rows.filter(row => /^\{\.\.\.[\w$]+\.[\w$]+\.recordAndReplay,/u.test(row.text)), "existing native Record & Replay row");
    const rowHead = new RegExp(`^\\{\\.\\.\\.(?<namespace>${ID}\\.${ID})\\.recordAndReplay(?:${escapeRegExp(LINUX_INSTALL)})?,isAvailable:\\(\\{features:(?<features>${ID}),platform:(?<platform>${ID})\\}\\)=>`, "u").exec(record.text);
    if (!rowHead || rowHead.groups.features === rowHead.groups.platform) throw Error("Unsupported Record & Replay predicate parameters");
    const { namespace, features, platform } = rowHead.groups;
    for (const role of ["computerUse", "latex", "visualize"]) one(rows.filter(row => row.text.startsWith(`{...${namespace}.${role},`)), `${role} sibling row`);
    const raw = `{...${namespace}.recordAndReplay,isAvailable:({features:${features},platform:${platform}})=>"darwin"===${platform}&&${features}.recordAndReplay}`;
    const canonical = raw.replace(".recordAndReplay,", `.recordAndReplay${LINUX_INSTALL},`).replace("=>", `=>${MARKER}"linux"===${platform}||`);
    if (record.text !== raw && record.text !== canonical) throw Error("Incomplete or altered Record & Replay plugin gate");
    declarationCarrier(factory.body, assignment.index, factory.parameters);
    if (!stableRootBinding(factory.body, assignment[1], assignment.index, { parameters: factory.parameters })) throw Error("Unstable bundled plugin registry binding");
    const registryAuthority = bindingAuthority(factory.body, assignment[1], factory.parameters);
    const references = matches(factory.body, new RegExp(`(?<![\\w$.#])${escapeRegExp(assignment[1])}(?![\\w$])`, "gu"), false);
    if (references.some(reference => reference.index !== assignment.index &&
        !/^\.(?:filter|map)\(/u.test(factory.body.slice(reference.index + assignment[1].length)) && !registryAuthority.local(reference.index))) {
      throw Error("Unsupported bundled plugin registry mutation or alias");
    }
    const namespaceAuthority = bindingAuthority(factory.body, namespace.split(".")[0], factory.parameters);
    const nativeRecordReferences = memberReferences(factory.body, namespace, "recordAndReplay")
      .filter(reference => reference.index === record.start + 4 || !namespaceAuthority.local(reference.index));
    if (nativeRecordReferences.some(reference => reference.unknown) || nativeRecordReferences.length !== 1) {
      throw Error("Duplicate native Record & Replay descriptor reference");
    }
    candidates.push({ binding: assignment[1], start: open, end: end + 1, rows, record, namespace, raw, canonical,
      state: record.text === raw ? "current" : "patched" });
  }
  return one(candidates, "root bundled plugin registry");
}

function registryController(owner, factory, registry) {
  const startup = owner.source.slice(owner.graph.scope.startupStart, owner.graph.scope.startupEnd), found = [];
  const array = escapeRegExp(registry.binding);
  for (const head of matches(startup, new RegExp(`function\\((${ID})\\)\\{`, "gu"))) {
    const open = head.index + head[0].length - 1, end = delimiterEnd(startup, open);
    if (end < open || startup[end + 1] !== "(") continue;
    const callEnd = delimiterEnd(startup, end + 1);
    if (callEnd < end || startup[end + 2] !== "{") continue;
    if (!new RegExp(`(?:let |const |var |,)${ID}=$`, "u").test(startup.slice(0, head.index))) continue;
    const body = startup.slice(open + 1, end), options = head[1];
    const eligibility = new RegExp(`(?<![\\w$.#])(${ID})=(${ID})=>${array}\\.filter\\((${ID})=>\\3\\.isAvailable\\(\\{buildFlavor:${escapeRegExp(options)}\\.buildFlavor,env:(${ID}),features:\\2,platform:(${ID})\\}\\)\\)`, "gu");
    const selectors = matches(body, eligibility);
    if (selectors.length !== 1) continue;
    const selector = selectors[0], platform = selector[5];
    if (matches(body, new RegExp(`(?<![\\w$.#])${escapeRegExp(platform)}=${escapeRegExp(options)}\\.platform\\?\\?process\\.platform`, "gu")).length !== 1 ||
        !body.includes("setDesktopFeatureAvailability:") || !body.includes("waitForPendingReconcile:")) continue;
    const argumentsBody = startup.slice(end + 3, callEnd - 1);
    if (matches(argumentsBody, /\bplatform\s*:/gu).length || matches(argumentsBody, /\.\.\./gu).length) continue;
    const installs = matches(body, new RegExp(`(?<![\\w$.#])(${ID})\\.marketplacePluginDescriptors\\.filter\\((${ID})=>!0===\\2\\.installWhenMissing\\)\\.filter\\(`, "gu"), false);
    if (installs.length !== 1) continue;
    const install = installs[0], filterOpen = install.index + install[0].length - 1, filterEnd = delimiterEnd(body, filterOpen);
    const map = new RegExp(`^\\.map\\((${ID})=>\\1\\.name\\)`, "u").exec(body.slice(filterEnd + 1));
    if (!map || !body.slice(filterOpen, filterEnd).includes("installWhenMissingRequiresOptIn")) continue;
    const declaration = new RegExp(`(?:let |const |var |,)(?<binding>${ID})=$`, "u").exec(startup.slice(0, head.index));
    declarationCarrier(startup, head.index - declaration.groups.binding.length - 1);
    const start = owner.graph.scope.startupStart + head.index;
    found.push({ start, end: owner.graph.scope.startupStart + end + 1, options,
      eligibility: selector[0].slice(selector[0].indexOf("=") + 1), env: selector[4], platform,
      installSelection: body.slice(install.index, filterEnd + 1 + map[0].length), installOptions: install[1] });
  }
  return one(found, "evaluated native bundled plugin controller");
}

function inspectRecordReplayPluginGate(assets) {
  try {
    const records = assets.map(asset => ({ ...asset, graph: inspectMainRequestSites(asset.source) }));
    const factories = records.flatMap(asset => [...mainProcessFactories(asset.source).map(factory => ({ ...factory, carrier: "CommonJS-chunk" })),
      ...entryFactories(asset.source)].map(factory => ({ ...factory, assetName: asset.assetName })));
    const owner = one(records.filter(record => record.graph.ok), "native main owner");
    const factory = one(factories.filter(candidate => candidate.identity === owner.graph.scope.factoryId), "native registry factory cohort");
    if (factory.assetName !== owner.assetName || factory.start !== owner.graph.scope.factoryStart) throw Error("Disconnected native registry owner");
    const registry = registryOf(factory), [namespaceBinding, namespaceKey] = registry.namespace.split(".");
    try { new Script(`async function processBindingProbe(${factory.parameters.join(",")}){${factory.body}\nlet process;}`); }
    catch { throw Error("Shadowed native process platform"); }
    if (!stableRootBinding(factory.body, "process", null, { parameters: factory.parameters })) throw Error("Replaced native process platform");
    const namespaceId = rootImport(factory, namespaceBinding);
    const namespace = one(factories.filter(candidate => candidate.identity === namespaceId), "native plugin namespace factory cohort");
    if (namespace.carrier !== "evaluated-entry-seed") throw Error("Plugin namespace lacks an evaluated entry seed");
    const exported = publication(namespace, namespaceKey), member = new RegExp(`^(${ID})\\.(${ID})$`, "u").exec(exported.expression);
    if (!member) throw Error("Unsupported plugin definition reexport");
    const reexportAuthority = bindingAuthority(namespace.body, member[1], namespace.parameters);
    const reexportReferences = memberReferences(namespace.body, member[1], member[2]);
    const qualifiedReferences = reexportReferences.length === 1 ? reexportReferences : reexportReferences.filter(reference => !reexportAuthority.local(reference.index));
    if (qualifiedReferences.some(reference => reference.unknown) || qualifiedReferences.length !== 1) {
      throw Error("Replaced native plugin definition reexport");
    }
    const definitionsId = rootImport(namespace, member[1]);
    const definitions = one(factories.filter(candidate => candidate.identity === definitionsId), "native plugin definition factory cohort");
    if (definitions.carrier !== "evaluated-entry-seed") throw Error("Plugin definitions lack an evaluated entry seed");
    const tablePublication = publication(definitions, member[2]);
    if (!new RegExp(`^${ID}$`, "u").test(tablePublication.expression)) throw Error("Unsupported native plugin table binding");
    const tables = matches(definitions.body, new RegExp(`(?<![\\w$.#])${escapeRegExp(tablePublication.expression)}=\\{`, "gu"));
    const table = one(tables, "native plugin definition table");
    declarationCarrier(definitions.body, table.index, definitions.parameters);
    if (!stableRootBinding(definitions.body, tablePublication.expression, table.index, { parameters: definitions.parameters })) throw Error("Unstable native plugin definition table");
    const tableOpen = table.index + table[0].length - 1, tableEnd = delimiterEnd(definitions.body, tableOpen);
    const fields = definitions.body.slice(tableOpen + 1, tableEnd);
    one(matches(fields, /\brecordAndReplay\s*:/gu), "native Record & Replay definition field");
    one(matches(fields, /\brecordAndReplay:\{name:"record-and-replay"\}/gu), "native Record & Replay plugin name");
    const tableAuthority = bindingAuthority(definitions.body, tablePublication.expression, definitions.parameters);
    if (memberReferences(definitions.body, tablePublication.expression, "recordAndReplay")
      .some(reference => !tableAuthority.local(reference.index))) {
      throw Error("Replaced native Record & Replay definition");
    }
    const nameCount = records.reduce((sum, record) => sum + [...record.source.matchAll(/\bname:(?:"record-and-replay"|'record-and-replay'|`record-and-replay`)/gu)].length, 0);
    const markers = records.reduce((sum, record) => sum + record.source.split(MARKER).length - 1, 0);
    if (nameCount !== 1 || markers !== Number(registry.state === "patched")) throw Error("Duplicate or orphan Record & Replay plugin artifact");
    const controller = registryController(owner, factory, registry);
    return { state: registry.state, owner, factory, registry, namespace, definitions,
      namespacePublication: exported, tablePublication, controller };
  } catch (error) { return { state: "invalid", reason: error.message }; }
}

function applyRecordReplayPluginGateToExtractedApp(extractedDir) {
  const inventory = findMainProcessChunks(extractedDir);
  const reject = reason => {
    console.warn(`WARN: ${reason} - skipping Record & Replay plugin gate`);
    return { matched: 0, changed: 0, changedAssets: [], reason };
  };
  if (!inventory) return reject("Missing main-process inventory");
  const assets = inventory.chunks.map(assetName => ({ assetName, source: fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8") }));
  const plan = inspectRecordReplayPluginGate(assets);
  if (plan.state === "invalid") return reject(plan.reason);
  if (plan.state === "patched") return { matched: 1, changed: 0, changedAssets: [] };
  const { owner, factory, registry } = plan;
  const start = factory.start + registry.record.start, end = factory.start + registry.record.end;
  const patchedSource = owner.source.slice(0, start) + registry.canonical + owner.source.slice(end);
  const post = inspectRecordReplayPluginGate(assets.map(asset => asset.assetName === owner.assetName ? { ...asset, source: patchedSource } : asset));
  if (post.state !== "patched" || patchedSource.slice(0, start) + registry.raw + patchedSource.slice(start + registry.canonical.length) !== owner.source) {
    return reject("Record & Replay plugin gate poststate changed");
  }
  const edits = assets.map(asset => ({ ...asset, patchedSource: asset.assetName === owner.assetName ? patchedSource : asset.source }));
  return { matched: 1, ...patchWebviewAssets(inventory.buildDir, edits) };
}

module.exports = { RECORD_REPLAY_PLUGIN_NAME, MARKER, LINUX_INSTALL, entryFactories,
  inspectRecordReplayPluginGate, applyRecordReplayPluginGateToExtractedApp };
