"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const data = require("./hydration-contract-data.json");
const { createJavaScriptLexicalIndex, escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxRemoteMobileConversationHydration";
const LOG = "Failed to discover thread from event";
const MAX_SOURCE = 16 * 1024 * 1024;
const caches = new WeakMap();
const FIXED = new Set(("async await function return if else for of in while let const var new this class extends super typeof instanceof void null true false undefined Object Array Set Map Symbol Number Math Date JSON Promise Error String try catch finally switch case break continue throw yield constructor manager context schedule buffer pending buffers begin bufferNotification bufferRequest discard clear beginDiscovery hydrate release discardDynamicToolRequest push onNotification").split(" "));
function fail(reason) { throw Error("Remote conversation hydration: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }
function parses(source) { try { new Script(source); return true; } catch { return false; } }
function lexical(copy) {
  let item = caches.get(copy);
  if (!item || item.source !== copy.moduleSource) { item = { source: copy.moduleSource, index: createJavaScriptLexicalIndex(copy.moduleSource) }; caches.set(copy, item); }
  return item.index;
}
function codeNext(text, lex, at) { while (at < text.length && (!lex.isCode(at) || /\s/u.test(text[at]))) at++; return at; }
function bodyOpen(text, lex, at) {
  const open = text.indexOf("(", at); let depth = 0;
  for (let p = open; p < text.length; p++) {
    if (!lex.isCode(p)) continue;
    if (text[p] === "(") depth++;
    if (text[p] === ")" && !--depth) { const q = codeNext(text, lex, p + 1); if (text[q] !== "{") fail("function body"); return q; }
  }
  fail("function parameters");
}
function normalize(source) {
  const lex = createJavaScriptLexicalIndex(source), names = new Map(); let text = "", cursor = 0;
  for (const token of source.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const at = token.index, name = token[0]; let before = at - 1;
    while (before >= 0 && (!lex.isCode(before) || /\s/u.test(source[before]))) before--;
    if (!lex.isCode(at) || FIXED.has(name) || source[at - 1] === "." && source.slice(at - 3, at) !== "..." ||
        /^\s*:/u.test(source.slice(at + name.length)) && ["{", ","].includes(source[before])) continue;
    if (!names.has(name)) names.set(name, "$" + names.size);
    text += source.slice(cursor, at) + names.get(name); cursor = at + name.length;
  }
  return { text: text + source.slice(cursor), names };
}
function equivalent(actual, expected) {
  const a = normalize(actual), b = normalize(expected);
  if (a.text !== b.text) fail("changed bounded native lifecycle or publication wiring");
  const inverse = new Map([...a.names].map(([name, value]) => [value, name]));
  return name => inverse.get(b.names.get(name)) ?? name;
}
function rootStatement(copy, at) {
  return lexical(copy).isRoot(at) && parses(`function nativeHydrationRoot(${copy.params.join(",")}){${copy.moduleSource.slice(0, at)}\nconst __hydrationRoot=0;}`);
}
function stableRoot(copy, name) {
  if (copy.params.includes(name) || !hasStableEagerMainBinding(copy.moduleSource, name)) fail("captured or rebound native authority " + name);
}
function noRootExit(copy, before) {
  for (const row of copy.moduleSource.slice(0, before).matchAll(/\b(?:return|throw)\b/gu)) {
    if (lexical(copy).isRoot(row.index) && rootStatement(copy, row.index)) fail("native authority follows a root exit");
  }
}
function rootClass(copy, name) {
  const rows = [...copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])class ${escapeRegExp(name)}(?: extends ${ID}\\.${ID})?\\{`, "gu"))]
    .filter(row => rootStatement(copy, row.index));
  const head = one(rows, "unique root class " + name), open = head.index + head[0].length - 1, end = lexical(copy).matchingBrace(open);
  if (end < open || end - head.index > 256 * 1024) fail("bounded native class");
  stableRoot(copy, name);
  noRootExit(copy, head.index);
  return { name, start: head.index, open, end: end + 1, source: copy.moduleSource.slice(head.index, end + 1) };
}
function rootFunction(copy, name, expected) {
  const rows = [...copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])function ${escapeRegExp(name)}\\(`, "gu"))]
    .filter(row => rootStatement(copy, row.index));
  const head = one(rows, "unique native helper " + name), open = bodyOpen(copy.moduleSource, lexical(copy), head.index), end = lexical(copy).matchingBrace(open);
  const heads = [...copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])function\\s*\\*?\\s*${escapeRegExp(name)}\\s*\\(`, "gu"))].filter(row => lexical(copy).isRoot(row.index));
  if (heads.length !== 1) fail("duplicate native helper authority");
  if (end < open || end - head.index > 16 * 1024) fail("bounded native helper");
  stableRoot(copy, name);
  const source = copy.moduleSource.slice(head.index, end + 1), roles = equivalent(source, expected);
  return { start: head.index, source, roles };
}
function method(cls, name) {
  const body = cls.source.slice(cls.source.indexOf("{") + 1, -1), lex = createJavaScriptLexicalIndex(body);
  // The selected identifier method must remain the sole instance authority.
  // A later quoted/computed literal method or instance field replaces it even
  // though the original declaration and its native body are still present.
  const authority = [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?=\\s*[=(;])`, "gu"))].filter(row => lex.isRoot(row.index));
  if (authority.length !== 1) fail("replaced native method or field " + name);
  const quoted = new RegExp(`(?:\\[\\s*)?["'\x60]${escapeRegExp(name)}["'\x60]\\s*(?:\\]\\s*)?[=(;]`, "gu");
  for (const row of body.matchAll(quoted)) {
    const prefix = body.slice(0, row.index);
    if (findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1) fail("literal native method replacement " + name);
  }
  for (const row of body.matchAll(/(?:^|[;}])\s*(?:(?:static|async|get|set)\s+)*\[/gu)) {
    const open = row.index + row[0].length - 1;
    if (lex.isRoot(open) && !/^\[\s*Symbol\.(?:dispose|asyncDispose)\s*\]\s*\(/u.test(body.slice(open))) fail("unproven computed class member");
  }
  const rows = [...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\(`, "gu"))].filter(row => lex.isRoot(row.index));
  const head = one(rows, "unique native instance method " + name), open = bodyOpen(body, lex, head.index), end = lex.matchingBrace(open);
  const previous = body.slice(0, head.index).trimEnd();
  if (/(?:\b(?:static|async|get|set)|\*)$/u.test(previous)) fail("changed native method kind " + name);
  const offset = cls.source.indexOf("{") + 1;
  return { source: body.slice(head.index, end + 1), body: body.slice(open + 1, end), open, end, head: body.slice(head.index, open + 1), classOpen: offset + open, classClose: offset + end };
}
function imported(copy, name, expectedId, before = null) {
  const binding = findRspackRequireBinding(copy, name);
  if (!binding || expectedId != null && binding.moduleId !== expectedId) fail("native imported provider " + name);
  const start = binding.start - (copy.start ?? 0); let fresh = "__hydrationAllowedInitializer";
  if (before != null && start >= before) fail("class base import follows its eager use");
  noRootExit(copy, start);
  while (copy.moduleSource.includes(fresh)) fresh += "$";
  if (!hasStableEagerMainBinding(copy.moduleSource.slice(0, start) + fresh + copy.moduleSource.slice(start + name.length), name)) fail("rebound native import " + name);
  return binding;
}
function rejectOwnedDeletes(cls, names) {
  const text = cls.source, lex = createJavaScriptLexicalIndex(text), owned = new Set(names);
  for (const token of text.matchAll(/(?<![\w$.])delete\b/gu)) {
    if (!lex.isCode(token.index)) continue;
    let at = codeNext(text, lex, token.index + token[0].length);
    let receiverParens = 0;
    while (text[at] === "(") { receiverParens++; at = codeNext(text, lex, at + 1); }
    if (!/^this\b/u.test(text.slice(at))) continue;
    at = codeNext(text, lex, at + 4);
    while (receiverParens && text[at] === ")") { receiverParens--; at = codeNext(text, lex, at + 1); }
    const optional = text.slice(at, at + 2) === "?.";
    if (optional) at = codeNext(text, lex, at + 2);
    let name;
    if (text[at] === "." || optional && text[at] !== "[") name = new RegExp(`^${ID}`, "u").exec(text.slice(text[at] === "." ? codeNext(text, lex, at + 1) : at))?.[0];
    else if (text[at] === "[") {
      // Current code uses dot fields. A static JSON key can be proven unrelated;
      // other computed deletions could remove any of the selected authorities.
      const literal = /^\s*("(?:\\.|[^"\\])*")\s*\]/u.exec(text.slice(at + 1));
      if (!literal) fail("unproven computed instance delete");
      name = JSON.parse(literal[1]);
    }
    if (owned.has(name)) fail("deleted native discovery field " + name);
  }
}

function patchedGuard(roles) {
  return `/*${MARKER}*/!this.manager.isCloudHost&&"local"!==this.manager.getHostId()||"turn/started"!==${roles.notification}.method&&"turn/completed"!==${roles.notification}.method&&("local"!==this.manager.getHostId()||"item/started"!==${roles.notification}.method&&"item/completed"!==${roles.notification}.method)`;
}
function prepareHydrationLifecycle(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > 16 * 1024) fail("bounded lifecycle");
  const nativePattern = new RegExp(`!this\\.manager\\.isCloudHost\\|\\|"turn/started"!==(${ID})\\.method&&"turn/completed"!==\\1\\.method`, "u");
  let nativeSource = source, state = "native";
  const count = source.split(MARKER).length - 1;
  if (count) {
    const notification = /"turn\/started"!==([A-Za-z_$][\w$]*)\.method/u.exec(source)?.[1];
    if (!notification || count !== 1) fail("orphan hydration marker");
    const owned = patchedGuard({ notification });
    if (source.split(owned).length !== 2) fail("partial native guard contribution");
    nativeSource = source.replace(owned, `!this.manager.isCloudHost||"turn/started"!==${notification}.method&&"turn/completed"!==${notification}.method`); state = "patched";
  }
  const roles = equivalent(nativeSource, data.life), guard = one([...nativeSource.matchAll(new RegExp(nativePattern.source, "gu"))], "single native notification guard");
  const patchedSource = nativeSource.slice(0, guard.index) + patchedGuard({ notification: guard[1] }) + nativeSource.slice(guard.index + guard[0].length);
  return { state, nativeSource, patchedSource, roles };
}
function inspectHydrationOwner(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 || new Set(copy.params).size !== 3 ||
      !copy.params.every(name => new RegExp(`^${ID}$`, "u").test(name)) || typeof copy.moduleSource !== "string" ||
      Buffer.byteLength(copy.moduleSource) > 1024 * 1024 || typeof copy.source !== "string" ||
      !Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 || copy.end < copy.start ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource ||
      !parses(`function hydrationFactory(${copy.params}){${copy.moduleSource}\n}`)) fail("factory snapshot");
  const text = copy.moduleSource;
  if (copy.params.slice(1).some(name => !hasStableEagerMainBinding(text, name))) fail("rebound factory loader/exports");
  for (const row of text.matchAll(/\b(?:eval|Function)\s*\(|\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/gu)) if (lexical(copy).isCode(row.index)) fail("opaque lexical authority");
  const globals = "Array,Date,Error,JSON,Map,Math,Number,Object,Promise,Set,String,Symbol";
  if (copy.params.some(name => globals.split(",").includes(name)) || !parses(`function nativeHydrationGlobals(${copy.params}){${text}\n;let ${globals};}`)) fail("captured native globals");
  if (globals.split(",").some(name => !hasStableEagerMainBinding(text, name))) fail("eager native global replacement");
  const log = one([...text.matchAll(/\.debug\("Failed to discover thread from event"/gu)].filter(row => lexical(copy).isCode(row.index)), "native discovery logger");
  const classes = [...text.matchAll(new RegExp(`(?<![\\w$.])class (${ID})\\{manager;context;schedule;buffer=new (${ID});pending=new Map;`, "gu"))]
    .filter(row => rootStatement(copy, row.index));
  const head = one(classes.filter(row => { const end = lexical(copy).matchingBrace(row.index + row[0].indexOf("{")); return row.index < log.index && log.index < end; }), "native lifecycle owner");
  const life = rootClass(copy, head[1]), prepared = prepareHydrationLifecycle(life.source), { state, roles } = prepared;
  const nativeLife = prepared.nativeSource, patchedLife = prepared.patchedSource;
  if (text.split(MARKER).length - 1 !== Number(state === "patched")) fail("orphan module contribution");
  const buffer = rootClass(copy, roles("rD"));
  if (Buffer.byteLength(buffer.source) > 16 * 1024) fail("bounded native queue");
  equivalent(buffer.source, data.buffer);
  for (const [name, template] of [[roles("eM"), data.readThreadId], [roles("iK"), data.resolved]]) rootFunction(copy, name, template);
  const merge = rootFunction(copy, roles("D"), data.merge), canonical = rootFunction(copy, merge.roles("k"), data.canonicalReader);
  rootFunction(copy, canonical.roles("N"), data.canonicalIslands);
  imported(copy, merge.roles("R"), data.mergeNamespaceModuleId);
  // These queue helpers are certified together so their shared names cannot be
  // silently swapped while preserving the class's apparent shape.
  const queueRoles = equivalent(buffer.source, data.buffer);
  rootFunction(copy, queueRoles("rx"), data.bufferText); rootFunction(copy, queueRoles("rM"), data.bufferKey);
  if (queueRoles("eM") !== roles("eM") || queueRoles("g") !== roles("g")) fail("split queue/thread identities");
  imported(copy, roles("g"), data.threadIdentityModuleId);
  // Qualify the native getter map through the shared strict publication reader.
  // A quoted duplicate key must not override the apparently valid O3 getter.
  const registration = one([...text.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(copy.params[2])}\\.d\\(${escapeRegExp(copy.params[1])},\\{`, "gu"))].filter(row => lexical(copy).isRoot(row.index)), "native manager registration");
  const mapEnd = lexical(copy).matchingBrace(registration.index + registration[0].length - 1);
  const callEnd = codeNext(text, lexical(copy), mapEnd + 1);
  if (text[callEnd] !== ")") fail("native lazy getter map");
  const publication = findRspackExportPublication({ ...copy, moduleSource: text.slice(0, callEnd + 1) }, "O3");
  const publicName = publication && new RegExp(`^${ID}$`, "u").test(publication.expression ?? "") ? publication.expression : null;
  if (!publicName) fail("native manager publication");
  const manager = rootClass(copy, publicName), ctor = method(manager, "constructor"), on = method(manager, "onNotification");
  const base = new RegExp(`^class ${ID} extends (${ID})\\.TF\\{`, "u").exec(manager.source);
  if (!base) fail("native public manager base");
  imported(copy, base[1], "ZG9f", manager.start);
  equivalent(method(manager, "getHostId").source, data.getHost);
  const ctorLexical = createJavaScriptLexicalIndex(ctor.body);
  const input = one([...ctor.body.matchAll(/\blet\{hostId:/gu)].filter(row => ctorLexical.isRoot(row.index)), "native constructor host input");
  const inputOpen = ctor.body.indexOf("{", input.index), inputClose = ctorLexical.matchingBrace(inputOpen);
  let declarationEnd = ctor.body.indexOf(";", inputClose) + 1, guardEnd = -1;
  for (let at = declarationEnd; at < ctor.body.length; at++) if (ctor.body[at] === ";" && ctorLexical.isRoot(at)) { guardEnd = at + 1; break; }
  if (guardEnd <= declarationEnd || guardEnd - input.index > 16 * 1024) fail("bounded constructor host guard");
  const inputRoles = equivalent(ctor.body.slice(input.index, guardEnd), data.constructorInput);
  const ctorParameter = new RegExp(`^constructor\\((${ID})\\)\\{$`, "u").exec(ctor.head)?.[1];
  if (ctorParameter !== inputRoles("e") || !hasStableEagerMainBinding(ctor.body, ctorParameter)) fail("constructor host input argument");
  const hostFields = one([...ctor.body.matchAll(new RegExp(`this\\.hostId=${ID},this\\.isCloudHost=\\(0,${ID}\\.ZJ\\)\\(${ID}\\)\\|\\|${ID}\\.isBrowserRuntime&&"local"===${ID}`, "gu"))].filter(row => ctorLexical.isRoot(row.index)), "native host fields");
  const hostRoles = equivalent(hostFields[0], data.hostInitialization);
  if (hostRoles("b") !== inputRoles("b") || hostRoles("Y") !== inputRoles("Y")) fail("host field uses another input");
  imported(copy, hostRoles("em"), data.hostClassifierModuleId);
  for (const name of [head[1], hostRoles("em")]) {
    if (!parses(manager.source.slice(0, ctor.classClose) + `\n;let ${name};` + manager.source.slice(ctor.classClose)) || !hasStableEagerMainBinding(ctor.body, name)) fail("captured constructor module authority");
  }
  for (const name of [inputRoles("b"), inputRoles("Y")]) {
    const first = [...ctor.body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "gu"))].find(row => ctorLexical.isCode(row.index));
    if (!first) fail("missing constructor input binding");
    const projected = ctor.body.slice(0, first.index) + "__hydrationCertifiedInput" + ctor.body.slice(first.index + name.length);
    if (!hasStableEagerMainBinding(projected, name)) fail("rewritten constructor host/settings input");
  }
  const construction = `this.threadDiscovery=new ${head[1]}(this,this.notificationContext,this.scheduler.schedule)`;
  if (ctor.body.split(construction).length !== 2) fail("live discovery construction");
  // Upstream initializes discovery in an eagerly evaluated comma sequence in
  // an if-condition. Qualify that finite native prelude, then prove its entry
  // point is a constructor statement. Closing arbitrary parentheses would
  // incorrectly accept a new short-circuit guard around initialization.
  const eager = one([...ctor.body.matchAll(new RegExp(`let ${ID}=\\(\\)=>this\\.turnStartObservations\\.clear\\(\\);if\\(`, "gu"))].filter(row => ctorLexical.isRoot(row.index)), "native eager constructor prelude");
  equivalent(ctor.body.slice(eager.index, ctor.body.indexOf(construction) + construction.length), data.constructionIfPrefix);
  const before = ctor.body.slice(0, eager.index), prefix = before.endsWith(",") ? before.slice(0, -1) + ";" : before;
  const ctorProjection = before => manager.source.slice(0, ctor.classOpen + 1) + before + "\nconst __hydrationCtor=0;" + manager.source.slice(ctor.classClose);
  const beforeHost = ctor.body.slice(0, hostFields.index).replace(/,$/u, ";");
  if (!parses(ctorProjection(beforeHost))) fail("conditional host field initialization");
  if (!parses(ctorProjection(prefix))) fail("conditional or nested discovery construction");
  for (const row of prefix.matchAll(/\b(?:return|throw)\b/gu)) {
    if (ctorLexical.isRoot(row.index) && parses(ctorProjection(prefix.slice(0, row.index)))) fail("discovery construction follows a constructor exit");
  }
  const contextAt = ctor.body.indexOf("this.notificationReductionContext={"), contextOpen = contextAt + "this.notificationReductionContext=".length;
  const contextEnd = createJavaScriptLexicalIndex(ctor.body).matchingBrace(contextOpen);
  if (contextAt < ctor.body.indexOf(construction)) fail("discovery context ownership");
  equivalent(ctor.body.slice(contextAt, contextEnd + 1), data.context);
  const constructionAndContext = ctor.body.slice(ctor.body.indexOf(construction), contextEnd + 1);
  equivalent(constructionAndContext, data.construction + "," + data.context);
  const onLexical = createJavaScriptLexicalIndex(on.source), reducerAt = on.source.indexOf("function("), reducerOpen = bodyOpen(on.source, onLexical, reducerAt), reducerEnd = onLexical.matchingBrace(reducerOpen);
  equivalent(on.source.slice(0, reducerAt), data.notificationHead);
  equivalent(on.source.slice(reducerEnd + 1), data.notificationTail);
  const nativeSwitch = [...on.source.matchAll(new RegExp(`switch\\(${ID}\\.method\\)\\{`, "gu"))].find(row => row.index > reducerOpen && row.index < reducerEnd && onLexical.isCode(row.index));
  if (!nativeSwitch) fail("native notification dispatch");
  const prefixRoles = equivalent(on.source.slice(reducerAt, nativeSwitch.index), data.notificationReducerHead);
  if (prefixRoles("g") !== roles("g")) fail("notification producer uses another thread identity");
  const request = method(manager, "onRequest"), requestAt = request.source.indexOf("this.threadDiscovery.bufferRequest(");
  if (requestAt < 0 || request.source.indexOf("this.threadDiscovery.bufferRequest(", requestAt + 1) >= 0) fail("request discovery binding");
  equivalent(request.source.slice(0, requestAt + "this.threadDiscovery.bufferRequest(".length) + request.source.slice(requestAt + "this.threadDiscovery.bufferRequest(".length).split(")")[0] + ")", data.requestHead);
  const ownedFields = ["threadDiscovery", "notificationReductionContext", "hostId", "isCloudHost"];
  rejectOwnedDeletes(manager, ownedFields);
  for (const field of ownedFields) {
    const managerLexical = createJavaScriptLexicalIndex(manager.source);
    const writes = [...manager.source.matchAll(new RegExp(`this(?:\\.${field}|\\[(?:"${field}"|'${field}')\\])\\s*(?:=(?!=|>)|\\+\\+|--|[+*/%&|^-]=|\\?\\?=|&&=|\\|\\|=)`, "gu"))].filter(row => managerLexical.isCode(row.index));
    if (writes.length !== 1) fail("later native discovery field write");
    const memberBody = manager.source.slice(manager.source.indexOf("{") + 1, -1), memberLexical = createJavaScriptLexicalIndex(memberBody);
    const members = [...memberBody.matchAll(new RegExp(`(?<![\\w$.])${field}(?=\\s*(?:;|=|\\())`, "gu"))].filter(row => memberLexical.isRoot(row.index));
    if (members.length !== 1 || memberBody[members[0].index + field.length] !== ";") fail("changed native discovery field declaration");
  }
  return { state, nativeSource: text.slice(0, life.start) + nativeLife + text.slice(life.end), patchedSource: text.slice(0, life.start) + patchedLife + text.slice(life.end), className: life.name };
}

function prepareHydration(copies) {
  if (!copies.length || new Set(copies.map(c => c.moduleId)).size !== 1 || new Set(copies.map(c => c.assetName)).size !== copies.length) fail("physical owner cohort");
  if (copies.reduce((size, c) => size + Buffer.byteLength(c.source), 0) > MAX_SOURCE) fail("selected source budget");
  const plans = copies.map(inspectHydrationOwner);
  if (new Set(plans.map(p => p.state)).size !== 1) fail("mixed native/patched peer state");
  const edits = copies.map((c, i) => {
    if (c.source.slice(c.start, c.end) !== c.moduleSource) fail("stale owner snapshot");
    return { assetName: c.assetName, source: c.source, patchedSource: c.source.slice(0, c.start) + plans[i].patchedSource + c.source.slice(c.end), nativeSource: c.source.slice(0, c.start) + plans[i].nativeSource + c.source.slice(c.end) };
  });
  return { edits, alreadyApplied: plans[0].state === "patched", moduleId: copies[0].moduleId };
}
function locateHydration(assets) {
  const copies = findUniqueRspackModuleCopies(assets, { description: "native published conversation discovery lifecycle", sourceMatch: s => s.includes(LOG) || s.includes(MARKER), matchModule: (_s, c) => { try { inspectHydrationOwner(c); return true; } catch { return false; } } });
  const plan = prepareHydration(copies); let markers = 0;
  for (const name of listWebviewAssetFiles(assets, /\.js$/u)) markers += fs.readFileSync(path.join(assets, name), "utf8").split(MARKER).length - 1;
  if (markers !== Number(plan.alreadyApplied) * copies.length) fail("orphan physical contribution");
  return plan;
}
function applyHydration(extractedDir, options = {}) { const assets = path.join(extractedDir, "webview/assets"), plan = locateHydration(assets); return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, moduleId: plan.moduleId }; }
function prepareHydrationSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_SOURCE) fail("source budget");
  const candidates = [...rspackModuleFactories(source, "source.js")].filter(c => c.moduleSource.includes(LOG));
  const plan = prepareHydration(candidates);
  if (plan.edits.length !== 1 || source.split(MARKER).length - 1 !== Number(plan.alreadyApplied)) fail("orphan String contribution");
  return plan.edits[0].patchedSource;
}
module.exports = { MARKER, prepareHydrationLifecycle, inspectHydrationOwner, prepareHydration, locateHydration, applyHydration, prepareHydrationSource };
