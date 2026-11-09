"use strict";
const fs = require("node:fs"), path = require("node:path"), { Script } = require("node:vm");
const data = require("./active-status-contracts.json"), scope = require("./remote-copy-scope.js");
const { createJavaScriptLexicalIndex, escapeRegExp: q } = require("../../scripts/patches/lib/minified-js.js");
const { hasStableEagerMainBinding: stable } = require("../../scripts/patches/lib/main-request-sites.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { findUniqueRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const ID = "[A-Za-z_$][\\w$]*", MARKER = "codexLinuxRemoteMobileActiveStatus", MAX_SOURCE = 16 * 1024 * 1024;
const FIXED = new Set("function async await return if else for of in while let var const new this true false null undefined void typeof instanceof throw try catch finally switch case break continue Object Array Set Map WeakMap Symbol Number Math Date JSON Promise Error String globalThis window document navigator".split(" "));
function fail(reason) { throw Error("Remote active status: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }
function parses(source) { try { new Script(source); return true; } catch { return false; } }
function next(text, lex, at) { while (at < text.length && (!lex.isCode(at) || /\s/u.test(text[at]))) at++; return at; }
function previous(text, lex, at) { while (at >= 0 && (!lex.isCode(at) || /\s/u.test(text[at]))) at--; return at; }
function closeParen(text, lex, at) {
  let depth = 0;
  for (let p = at; p < text.length; p++) if (lex.isCode(p)) { if (text[p] === "(") depth++; else if (text[p] === ")" && !--depth) return p; }
  fail("native callable parameters");
}
// Finite native syntax, including local binding equality. Literal property
// keys stay literal; spread and ternary values remain binding occurrences.
function pattern(template, whole = true) {
  const lex = createJavaScriptLexicalIndex(template), names = new Map(), stack = [], objectContext = new Uint8Array(template.length);
  for (let at = 0; at < template.length; at++) {
    if (!lex.isCode(at)) continue;
    objectContext[at] = stack.at(-1)?.object ? 1 : 0;
    const char = template[at];
    if ("([{".includes(char)) {
      const before = previous(template, lex, at - 1), word = template.slice(0, before + 1).match(/([A-Za-z_$][\w$]*)$/u)?.[1];
      stack.push({ char, object: char === "{" && ("=([,:?".includes(template[before] ?? " ") || ["let", "const", "var", "return"].includes(word)) });
    } else if (")]}".includes(char)) {
      const pair = { ")": "(", "]": "[", "}": "{" };
      if (stack.at(-1)?.char === pair[char]) stack.pop();
    }
  }
  let text = whole ? "^" : "", cursor = 0;
  for (const token of template.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const name = token[0], at = token.index, before = previous(template, lex, at - 1), after = next(template, lex, at + name.length);
    const property = template[after] === ":" && ["{", ","].includes(template[before]);
    const method = template[after] === "(" && ["{", "}", ",", ";"].includes(template[before]) && template[next(template, lex, closeParen(template, lex, after) + 1)] === "{";
    if (!lex.isCode(at) || FIXED.has(name) || template[at - 1] === "." && template.slice(at - 3, at) !== "..." || property || method) continue;
    const shorthand = objectContext[at] && ["{", ","].includes(template[before]) && ["}", ","].includes(template[after]);
    text += q(template.slice(cursor, at));
    if (names.has(name)) text += (shorthand ? `(?=${q(name)}(?![\\w$]))` : "") + `\\k<v${names.get(name)}>`;
    else { names.set(name, names.size); text += `(?<v${names.get(name)}>${shorthand ? q(name) : ID})`; }
    cursor = at + name.length;
  }
  return { regex: new RegExp(text + q(template.slice(cursor)) + (whole ? "$" : ""), "gu"), names };
}
function roles(p, match) {
  const values = [...p.names].map(([name, index]) => [name, match.groups["v" + index]]);
  if (new Set(values.map(([, value]) => value)).size !== values.length) fail("collapsed native binding roles");
  const map = new Map(values); return name => map.get(name) ?? name;
}
function exact(source, template) {
  const p = pattern(template), match = p.regex.exec(source);
  if (!match) fail("changed bounded native indicator or row"); return roles(p, match);
}
function render(template, bindings) {
  const lex = createJavaScriptLexicalIndex(template); let cursor = 0, out = "";
  for (const token of template.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const at = token.index, name = token[0], before = previous(template, lex, at - 1), after = next(template, lex, at + name.length);
    if (!lex.isCode(at) || template[at - 1] === "." && template.slice(at - 3, at) !== "..." || template[after] === ":" && ["{", ","].includes(template[before]) || !bindings.has(name)) continue;
    out += template.slice(cursor, at) + bindings.get(name); cursor = at + name.length;
  }
  return out + template.slice(cursor);
}
function globalReference(copy, name, at) {
  try { scope.unshadowed(copy, name, at); return true; } catch { return false; }
}
const mutationViews = new WeakMap();
function mutationSyntax(copy) {
  const body = copy.moduleSource;
  const cached = mutationViews.get(copy); if (cached?.body === body) return cached;
  const lex = scope.context(copy).lexical, stack = [], pairs = new Map(), regions = [];
  for (let at = 0; at < body.length; at++) {
    if (!lex.isCode(at)) continue;
    if ("([{".includes(body[at])) stack.push(at);
    else if (")]}".includes(body[at])) { const open = stack.pop(); pairs.set(open, at); pairs.set(at, open); }
  }
  for (const frame of scope.context(copy).functions) {
    regions.push({ start: frame.open + 1, end: frame.end - 1 });
    const params = body.indexOf("(", frame.start), close = pairs.get(params);
    if (close != null && close < frame.open) regions.push({ start: params + 1, end: close });
  }
  // A selected namespace remains external inside a deferred callback too.
  // Check its execution region instead of asking an eager-only checker to
  // certify the containing function declaration or arrow expression.
  for (const arrow of body.matchAll(/=>/gu)) {
    if (!lex.isCode(arrow.index)) continue; const start = next(body, lex, arrow.index + 2);
    if (body[start] === "{") { regions.push({ start: start + 1, end: pairs.get(start) }); continue; }
    let end = start;
    for (; end < body.length; end++) {
      if (!lex.isCode(end)) continue;
      if ("([{".includes(body[end])) { end = pairs.get(end); continue; }
      if (",;)]}".includes(body[end])) break;
    }
    regions.push({ start, end });
  }
  for (const [open, close] of pairs) {
    if (body[open] !== "{" || close < open) continue;
    const before = previous(body, lex, open - 1);
    if (body[before] !== ")") continue;
    const params = pairs.get(before), word = body.slice(0, params).match(/([A-Za-z_$][\w$]*)\s*$/u)?.[1];
    if (["if", "for", "while", "switch", "catch", "with"].includes(word)) continue;
    regions.push({ start: open + 1, end: close }, { start: params + 1, end: before });
  }
  for (const head of body.matchAll(/\bclass(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[A-Za-z_$][\w$.]*)?\s*\{/gu)) {
    if (lex.isCode(head.index)) { const open = head.index + head[0].length - 1; regions.push({ start: open + 1, end: pairs.get(open) }); }
  }
  const result = { body, lex, pairs, regions }; mutationViews.set(copy, result); return result;
}
function memberEnd(text, lex, start) {
  let at = next(text, lex, start), member = false; const parts = [];
  // Transparent receiver parentheses and optional member access do not grant
  // another writer authority over the selected maps or selector namespace.
  while (text[at] === ")") at = next(text, lex, at + 1);
  for (;;) {
    while (text[at] === ")") at = next(text, lex, at + 1);
    const propertyStart = at, optional = text.slice(at, at + 2) === "?.";
    if (optional) at = next(text, lex, at + 2);
    if (text[at] === "." || optional && text[at] !== "[") {
      at = text[at] === "." ? next(text, lex, at + 1) : at;
      const key = new RegExp(`^${ID}`, "u").exec(text.slice(at)); if (!key) fail("computed member authority");
      const end = at + key[0].length; parts.push({ start: propertyStart, end }); at = next(text, lex, end); member = true;
    } else if (text[at] === "[") {
      let depth = 0, end = -1;
      for (let p = at; p < text.length; p++) if (lex.isCode(p)) { if (text[p] === "[") depth++; else if (text[p] === "]" && !--depth) { end = p; break; } }
      if (end < at) fail("member index bounds"); parts.push({ start: propertyStart, end: end + 1 }); at = next(text, lex, end + 1); member = true;
    } else return { at, member, parts };
  }
}
function projectedMemberIsStable(copy, token, chain) {
  const { body, regions } = mutationSyntax(copy), end = chain.parts.at(-1).end;
  const view = regions.filter(r => r.start <= token.index && end <= r.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0] ?? { start: 0, end: body.length };
  let fresh = "__nativeActivityMemberTarget"; while (body.includes(fresh)) fresh += "$";
  const edits = [{ start: token.index, end: token.index + token[0].length, text: fresh }, ...chain.parts.map(p => ({ ...p, text: "" }))].sort((a, b) => b.start - a.start);
  let projected = body.slice(view.start, view.end);
  for (const edit of edits) projected = projected.slice(0, edit.start - view.start) + edit.text + projected.slice(edit.end - view.start);
  const lex = createJavaScriptLexicalIndex(projected);
  for (const update of projected.matchAll(/\+\+|--/gu)) {
    if (!lex.isCode(update.index)) continue; let at = next(projected, lex, update.index + 2);
    while (projected[at] === "(") at = next(projected, lex, at + 1);
    if (projected.slice(at, at + fresh.length) === fresh && !/[\w$]/u.test(projected[at + fresh.length] ?? "")) return false;
  }
  return stable(projected, fresh);
}
function rejectMemberMutations(copy, names) {
  const text = copy.moduleSource, lex = scope.context(copy).lexical, selected = new Set(names);
  const write = /^(?:=(?!=|>)|\+\+|--|(?:\?\?|\|\||&&|\*\*|<<|>>>|>>|[+*/%&|^-])=)/u;
  for (const token of text.matchAll(new RegExp(`(?<![\\w$.])(?:${names.map(q).join("|")})(?![\\w$])`, "gu"))) {
    if (!lex.isCode(token.index) || !globalReference(copy, token[0], token.index)) continue;
    const chain = memberEnd(text, lex, token.index + token[0].length);
    if (chain.member && write.test(text.slice(chain.at))) fail("selected map/provider member write");
    const before = previous(text, lex, token.index - 1);
    if (chain.member && ["++", "--"].includes(text.slice(Math.max(0, before - 1), before + 1))) fail("selected member update");
    if (chain.member && !projectedMemberIsStable(copy, token, chain)) fail("selected member assignment target");
  }
  for (const token of text.matchAll(/(?<![\w$.])delete\b/gu)) {
    if (!lex.isCode(token.index)) continue; let at = next(text, lex, token.index + 6);
    while (text[at] === "(") at = next(text, lex, at + 1);
    const name = new RegExp(`^${ID}`, "u").exec(text.slice(at))?.[0];
    if (selected.has(name) && globalReference(copy, name, at) && memberEnd(text, lex, at + name.length).member) fail("selected map/provider member delete");
  }
  const mutators = { Object: new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]), Reflect: new Set(["set", "defineProperty", "deleteProperty", "setPrototypeOf"]) };
  for (const call of text.matchAll(/(?<![\w$.])(?:Object|Reflect)\b/gu)) {
    if (!lex.isCode(call.index)) continue; let cursor = next(text, lex, call.index + call[0].length), method;
    if (text[cursor] === ".") {
      cursor = next(text, lex, cursor + 1); const key = new RegExp(`^${ID}`, "u").exec(text.slice(cursor)); if (!key) continue;
      method = key[0]; cursor = next(text, lex, cursor + method.length);
    } else if (text[cursor] === "[") {
      const close = mutationSyntax(copy).pairs.get(cursor); if (close == null) fail("reflection member bounds");
      const literal = text.slice(cursor + 1, close).trim();
      if (/^"(?:\\.|[^"\\])*"$/u.test(literal)) { try { method = JSON.parse(literal); } catch {} }
      else if (/^['`][A-Za-z_$][\w$]*['`]$/u.test(literal) && literal[0] === literal.at(-1)) method = literal.slice(1, -1);
      cursor = next(text, lex, close + 1);
    } else continue;
    if (text[cursor] !== "(") continue;
    let at = next(text, lex, cursor + 1);
    while (text[at] === "(") at = next(text, lex, at + 1);
    const name = new RegExp(`^${ID}`, "u").exec(text.slice(at))?.[0];
    if (selected.has(name) && globalReference(copy, name, at) && (method == null || mutators[call[0]].has(method))) fail("selected map/provider reflection mutation");
  }
}
function noRootExit(copy, before) {
  const body = copy.moduleSource, lex = scope.context(copy).lexical;
  for (const row of body.slice(0, before).matchAll(/\b(?:return|throw)\b/gu)) {
    if (lex.isRoot(row.index) && parses(`function activeStatusRootExit(${copy.params}){${body.slice(0, row.index)}\nconst __exit=0;}`)) fail("native provider follows root exit");
  }
}
function prepareActiveIndicatorSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 16 * 1024) fail("bounded indicator source");
  const patched = source.split(MARKER).length - 1;
  if (patched > 1) fail("duplicate indicator marker");
  const template = patched ? data.patchedClassifier : data.nativeClassifier, p = pattern(template, false), lex = createJavaScriptLexicalIndex(source);
  const match = one([...source.matchAll(p.regex)].filter(row => lex.isCode(row.index)), "complete native classifier");
  const classifierRoles = roles(p, match), bindings = new Map([...p.names.keys()].map(name => [name, classifierRoles(name)]));
  const nativeClassifier = render(data.nativeClassifier, bindings), patchedClassifier = render(data.patchedClassifier, bindings);
  const nativeSource = source.slice(0, match.index) + nativeClassifier + source.slice(match.index + match[0].length);
  const indicatorRoles = exact(nativeSource, data.indicator);
  const patchedSource = source.slice(0, match.index) + patchedClassifier + source.slice(match.index + match[0].length);
  return { state: patched ? "patched" : "native", nativeSource, patchedSource, roles: indicatorRoles };
}
function inspectActiveStatusOwner(copy) {
  if (!copy || typeof copy.moduleSource !== "string" || !Array.isArray(copy.params) || copy.params.length !== 3 ||
      !Number.isInteger(copy.start) || !Number.isInteger(copy.end) || typeof copy.source !== "string" ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource || Buffer.byteLength(copy.moduleSource) > 64 * 1024) fail("bounded physical snapshot");
  scope.stableFactoryParameters(copy);
  const publication = findRspackExportPublication(copy, data.exportKey);
  if (!publication || !new RegExp(`^${ID}$`, "u").test(publication.expression ?? "")) fail("native sidebar row publication");
  const wrapper = scope.stableRootFunction(copy, publication.expression), wrapperRoles = exact(wrapper.source, data.wrapper);
  const parent = scope.stableRootFunction(copy, wrapperRoles("eU")), parentRoles = exact(parent.source, data.parent);
  const indicator = scope.stableRootFunction(copy, parentRoles("ea")), prepared = prepareActiveIndicatorSource(indicator.source), bindings = prepared.roles;
  if (wrapperRoles("e_") !== wrapper.name || parentRoles("eU") !== parent.name || bindings("ea") !== indicator.name) fail("split published indicator identities");
  scope.reachable(copy, wrapper, parent); scope.reachable(copy, parent, indicator);
  // The finite parent retains native flag subscriptions, the direct icon
  // mount, its badge-array merge, row props, cache bridges and final return.
  for (const name of ["n", "o"]) if (wrapperRoles(name) !== bindings(name) || parentRoles(name) !== bindings(name)) fail("split renderer providers");
  for (const name of ["i", "m"]) if (parentRoles(name) !== bindings(name)) fail("split keyed conversation selectors");
  for (const [nativeName, id] of Object.entries(data.imports)) {
    const name = bindings(nativeName), binding = scope.requireImport(copy, name, indicator.start);
    if (binding.moduleId !== id) fail("wrong native indicator dependency " + nativeName);
    let fresh = "__activeStatusAllowedImport"; while (copy.moduleSource.includes(fresh)) fresh += "$";
    const at = binding.start - copy.start;
    if (!stable(copy.moduleSource.slice(0, at) + fresh + copy.moduleSource.slice(at + name.length), name)) fail("eager provider rewrite");
  }
  // Both badge gates remain native: the Statsig hook and the scoped atom's
  // initializer/namespace are part of the finite source contract.
  for (const [nativeName, id] of Object.entries(data.gateImports)) {
    const name = parentRoles(nativeName), at = parent.start + parent.source.indexOf(name + "."), binding = scope.requireImport(copy, name, at);
    if (binding.moduleId !== id) fail("wrong native visibility gate provider");
    const start = binding.start - copy.start; noRootExit(copy, start);
    if (!stable(copy.moduleSource.slice(0, start) + "__activeGateImport" + copy.moduleSource.slice(start + name.length), name)) fail("rewritten visibility provider");
  }
  const gateName = parentRoles("J"), gateLex = scope.context(copy).lexical;
  const gateHead = one([...copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])let ${q(gateName)}=`, "gu"))].filter(row => gateLex.isRoot(row.index)), "native visibility atom");
  let gateEnd = gateHead.index; while (gateEnd < copy.moduleSource.length && !(copy.moduleSource[gateEnd] === ";" && gateLex.isRoot(gateEnd))) gateEnd++;
  if (gateEnd === copy.moduleSource.length) fail("visibility atom statement");
  const gateRoles = exact(copy.moduleSource.slice(gateHead.index, gateEnd + 1), data.gateCell);
  if (gateRoles("J") !== gateName || gateRoles("i") !== bindings("i") || gateRoles("F") !== parentRoles("F")) fail("split visibility atom dependencies");
  noRootExit(copy, gateHead.index);
  if (!parses(`function nativeVisibilityRoot(${copy.params}){${copy.moduleSource.slice(0, gateHead.index)}\nconst __gate=0;}`) ||
      !stable(copy.moduleSource.slice(0, gateHead.index + 4) + "__activeGateInitializer" + copy.moduleSource.slice(gateHead.index + 4 + gateName.length), gateName)) fail("conditional or rewritten visibility atom");
  scope.unshadowed(copy, gateName, parent.start + parent.source.indexOf("(" + gateName + ")") + 1);
  const body = copy.moduleSource, lex = scope.context(copy).lexical, style = bindings("ee"), labels = bindings("et");
  const head = one([...body.matchAll(new RegExp(`(?<![\\w$.])let ${q(style)}=\\{`, "gu"))].filter(row => lex.isRoot(row.index)), "native indicator maps");
  let end = head.index; while (end < body.length && !(body[end] === ";" && lex.isRoot(end))) end++;
  if (end === body.length || !parses(`function indicatorMapRoot(${copy.params}){${body.slice(0, head.index)}\nconst __mapEntry=0;}`)) fail("eager native maps");
  const mapRoles = exact(body.slice(head.index, end + 1), data.maps);
  if (mapRoles("ee") !== style || mapRoles("et") !== labels) fail("split indicator map bindings");
  noRootExit(copy, head.index);
  for (const name of [style, labels]) {
    const token = one([...body.slice(head.index, end + 1).matchAll(new RegExp(`(?<![\\w$.])${q(name)}(?==\\{)`, "gu"))], "native map initializer");
    const at = head.index + token.index; let fresh = "__activeStatusMapInitializer"; while (body.includes(fresh)) fresh += "$";
    if (!stable(body.slice(0, at) + fresh + body.slice(at + name.length), name)) fail("rewritten native map");
    scope.unshadowed(copy, name, indicator.start + indicator.source.indexOf(name + "["));
  }
  rejectMemberMutations(copy, [style, labels, ...Object.keys(data.imports).map(bindings), ...Object.keys(data.gateImports).map(parentRoles)]);
  if (body.split(MARKER).length - 1 !== Number(prepared.state === "patched")) fail("orphan module marker");
  return { state: prepared.state, nativeSource: body.slice(0, indicator.start) + prepared.nativeSource + body.slice(indicator.end),
    patchedSource: body.slice(0, indicator.start) + prepared.patchedSource + body.slice(indicator.end), indicator: indicator.name, parent: parent.name, wrapper: wrapper.name };
}
function prepareActiveStatus(copies) {
  if (!copies.length || new Set(copies.map(c => c.moduleId)).size !== 1 || new Set(copies.map(c => c.assetName)).size !== copies.length) fail("one physical module cohort");
  if (copies.reduce((n, c) => n + Buffer.byteLength(c.source), 0) > MAX_SOURCE) fail("selected source budget");
  const plans = copies.map(inspectActiveStatusOwner);
  if (new Set(plans.map(p => p.state)).size !== 1) fail("mixed native/patched indicator copies");
  return { state: plans[0].state, edits: copies.map((c, i) => ({ assetName: c.assetName, source: c.source,
    patchedSource: c.source.slice(0, c.start) + plans[i].patchedSource + c.source.slice(c.end),
    nativeSource: c.source.slice(0, c.start) + plans[i].nativeSource + c.source.slice(c.end) })) };
}
function locateActiveStatus(assets) {
  const copies = findUniqueRspackModuleCopies(assets, { description: "published native current-conversation indicator", sourceMatch: s => s.includes('"Read-only snapshot"') || s.includes(MARKER),
    matchModule: (_s, c) => { try { inspectActiveStatusOwner(c); return true; } catch { return false; } } });
  const plan = prepareActiveStatus(copies); let markers = 0;
  for (const name of listWebviewAssetFiles(assets, /\.js$/u)) markers += fs.readFileSync(path.join(assets, name), "utf8").split(MARKER).length - 1;
  if (markers !== Number(plan.state === "patched") * copies.length) fail("orphan physical marker"); return plan;
}
function applyActiveStatus(extractedDir, options = {}) { const assets = path.join(extractedDir, "webview/assets"), plan = locateActiveStatus(assets); return { ...patchWebviewAssets(assets, plan.edits, options), matched: true }; }
function prepareActiveStatusSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE) fail("source budget");
  const copies = [...rspackModuleFactories(source, "source.js")].filter(c => c.moduleSource.includes('"Read-only snapshot"'));
  const plan = prepareActiveStatus(copies); if (plan.edits.length !== 1 || source.split(MARKER).length - 1 !== Number(plan.state === "patched")) fail("orphan String marker");
  return plan.edits[0].patchedSource;
}
module.exports = { MARKER, prepareActiveIndicatorSource, inspectActiveStatusOwner, prepareActiveStatus, locateActiveStatus, applyActiveStatus, prepareActiveStatusSource };
