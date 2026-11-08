"use strict";
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const { normalizeNativeHostStatusModule: normalized } = require("./host-status-owner.js");
const shapes = require("./host-status-graph-shapes.js");
const ID = "[A-Za-z_$][\\w$]*";
function fail(reason) { throw Error(`Remote host status graph: ${reason}`); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }
function view(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 || new Set(copy.params).size !== 3 || Buffer.byteLength(copy.moduleSource ?? "") > 96 * 1024) fail("bounded native module snapshot");
  new Script(`function nativeStatusDependency(${copy.params.join(",")}){${copy.moduleSource}\n}`);
  return createJavaScriptLexicalIndex(copy.moduleSource);
}

function rootFunctionHeads(body, lexical) {
  const rows = [], identifier = /^(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/u;
  const next = from => { let at = from;while (at < body.length && !lexical.isCode(at)) at++;return at; };
  for (const keyword of body.matchAll(/\bfunction\b/gu)) {
    if (!lexical.isRoot(keyword.index)) continue;
    let at = next(keyword.index + keyword[0].length);
    if (body[at] === "*") at = next(at + 1);
    const token = identifier.exec(body.slice(at));
    if (!token || body[next(at + token[0].length)] !== "(") continue;
    const name = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
      (_raw, braces, four) => String.fromCodePoint(parseInt(braces ?? four, 16)));
    rows.push({ name, start: keyword.index });
  }
  return rows;
}

function importRole(copy, name) {
  const lexical = view(copy), binding = findRspackRequireBinding(copy, name);
  if (!binding || binding.requireName !== copy.params[2] ||
      rootFunctionHeads(copy.moduleSource, lexical).some(row => [name, copy.params[2]].includes(row.name))) fail("captured native factory import");
  const start = binding.start - copy.start, end = binding.end - copy.start;
  if (!hasStableEagerMainBinding(copy.moduleSource.slice(0, start) + name + copy.moduleSource.slice(end), name)) fail("eager native import write");
  return Object.freeze(binding);
}
function rootFunction(copy, name, maximumBytes = 64 * 1024) {
  const lexical = view(copy), heads = rootFunctionHeads(copy.moduleSource, lexical).filter(row => row.name === name);
  if (copy.params.includes(name) || heads.length !== 1 || !hasStableEagerMainBinding(copy.moduleSource, name)) fail("native root function authority " + name);
  const pattern = new RegExp(String.raw`function ${escapeRegExp(name)}\((?<args>[^()]*)\)\{`, "gu");
  const match = one([...copy.moduleSource.matchAll(pattern)].filter(row => lexical.isRoot(row.index)), "native bounded function frame");
  const open = match.index + match[0].length - 1, end = lexical.matchingBrace(open);
  if (end <= open || Buffer.byteLength(copy.moduleSource.slice(match.index, end + 1)) > maximumBytes) fail("native bounded function frame size");
  return Object.freeze({ name, params: match.groups.args, start: match.index, end: end + 1, body: copy.moduleSource.slice(open + 1, end), source: copy.moduleSource.slice(match.index, end + 1) });
}
function inspectClassifierBridge(copy, exportName) {
  view(copy);
  const loader = escapeRegExp(copy.params[2]), exportsName = escapeRegExp(copy.params[1]);
  const match = new RegExp(String.raw`^var (?<namespace>${ID})=${loader}\("[^"\\]+"\);function (?<helper>${ID})\((?<host>${ID})\)\{return\(0,\k<namespace>\.(?<key>${ID})\)\(\k<host>\)\|\|!1\}${loader}\.d\(${exportsName},\{\},\{(?<export>${ID}):\k<helper>,u:function\((?<arg>${ID})\)\{return \k<helper>\(\k<arg>\)\?\["codex_cloud","codex_work_cca"\]:void 0\}\}\)$`, "u").exec(copy.moduleSource);
  if (!match || match.groups.export !== exportName) fail("native durable classifier bridge");
  const r = match.groups;
  if (r.namespace === r.helper || r.host === r.namespace || r.arg === r.helper) fail("captured classifier bridge provider");
  rootFunction(copy, r.helper, 512);
  return Object.freeze({ moduleId: copy.moduleId, facade: importRole(copy, r.namespace), exportName: r.key });
}
function inspectClassifierFacade(copy, exportName) {
  const pub = findRspackExportPublication(copy, exportName);
  const match = pub?.expression && new RegExp(String.raw`^(?<namespace>${ID})\.(?<key>${ID})$`, "u").exec(pub.expression);
  if (!match) fail("native classifier facade member getter");
  return Object.freeze({ moduleId: copy.moduleId, literalModule: importRole(copy, match.groups.namespace), exportName: match.groups.key });
}
function inspectDurableLiteral(copy, exportName) {
  const lexical = view(copy), pub = findRspackExportPublication(copy, exportName);
  if (!pub?.fn || !new RegExp(`^${ID}$`, "u").test(pub.fn.params)) fail("native durable equality publication");
  const match = new RegExp(String.raw`^return ${escapeRegExp(pub.fn.params)}===(?<literal>${ID})$`, "u").exec(pub.fn.body);
  if (!match || match.groups.literal === pub.fn.params) fail("native durable equality binding");
  const name = match.groups.literal;
  const declaration = new RegExp(String.raw`(?:^|[;}])\s*let (?<initializer>${escapeRegExp(name)}="durable")(?=[,;])`, "gu");
  const literal = one([...copy.moduleSource.matchAll(declaration)].filter(row => lexical.isRoot(row.index + row[0].indexOf("let "))), "native durable let-declarator initializer");
  const start = literal.index + literal[0].indexOf(literal.groups.initializer);
  const projected = copy.moduleSource.slice(0, start) + name + copy.moduleSource.slice(start + literal.groups.initializer.length);
  if (!hasStableEagerMainBinding(projected, name) || rootFunctionHeads(copy.moduleSource, lexical).some(row => row.name === name)) fail("mutable native durable literal");
  return Object.freeze({ moduleId: copy.moduleId, hostId: "durable", boundary: "Only the native literal durable early skip; no cloud, SSH or generic nonlocal taxonomy is supplied." });
}
function nativeTemplate(copy, expected) {
  if (Buffer.byteLength(copy.moduleSource ?? "") > 16 * 1024) fail("bounded small native provider");
  view(copy);const actual = normalized(copy), reference = normalized(expected);
  if (actual.text !== reference.text || actual.imports.length !== reference.imports.length) fail("changed bounded native lifecycle interface");
  const bindings = actual.imports.map(row => importRole(copy, row.local));
  return Object.freeze({ bindings: Object.freeze(bindings), expectedLocals: Object.freeze(reference.imports.map(row => row.local)) });
}
function inspectNativeAwaiter(copy, exportName) {
  if (exportName !== "P") fail("native read awaiter publication");
  // The generic publication reader intentionally does not parse this native
  // inline async function. Certify its complete small module here instead.
  nativeTemplate(copy, shapes.awaiter);
  if (copy.params.includes("Symbol")) fail("captured native disposal intrinsic");
  return Object.freeze({ moduleId: copy.moduleId, exportName, boundary: "Native signal/await/finally disposal implementation retained; no wrapper or transport policy is introduced." });
}
function inspectNativeManager(copy) {
  const proof = nativeTemplate(copy, shapes.manager);
  const role = name => proof.bindings[proof.expectedLocals.indexOf(name)];
  const subscriber = role("f"), facade = role("A"), classifierFacade = role("i");
  if (!subscriber || !facade || !classifierFacade) fail("missing native per-host lifecycle providers");
  const pub = findRspackExportPublication(copy, "L");
  if (!pub?.expression || !new RegExp(`^${ID}$`, "u").test(pub.expression)) fail("native per-host manager publication");
  rootFunction(copy, pub.expression, 8 * 1024);
  return Object.freeze({ moduleId: copy.moduleId, subscriber, facade, classifierFacade, imports: proof.bindings,
    boundary: "Complete native per-host manager map, identity predicate, replacement/disconnect and teardown source; no global selected-host owner or runtime bootstrap is added." });
}
function inspectReadLifecycle(copy, statusId) {
  const pub = findRspackExportPublication(copy, "x");
  if (!pub?.expression || !new RegExp(`^${ID}$`, "u").test(pub.expression)) fail("native read lifecycle publication");
  const fn = rootFunction(copy, pub.expression), args = fn.params.split(",");
  if (args.length !== 4 || new Set(args).size !== 4 || args.some(name => !new RegExp(`^${ID}$`, "u").test(name))) fail("native read lifecycle arguments");
  const [store, host, client, current] = args.map(escapeRegExp), lexical = createJavaScriptLexicalIndex(fn.body);
  const pattern = new RegExp(String.raw`let (?<dispose>${ID})=\(0,(?<status>${ID})\.UL\)\(${store},${host},${client},${current}\),`, "gu");
  const mount = one([...fn.body.matchAll(pattern)].filter(row => lexical.isRoot(row.index)), "native same-host status mount");
  const prefix = { params: shapes.readPrefix.params, moduleSource: fn.body.slice(0, mount.index + mount[0].length - 1) };
  if (normalized(prefix).text !== normalized(shapes.readPrefix).text) fail("changed bounded native status-mount prefix");
  const prefixCode = createJavaScriptLexicalIndex(prefix.moduleSource), prefixProviders = {};
  for (const key of ["PL", "oI", "AP", "fI", "op", "v"]) {
    const uses = new RegExp(String.raw`(?<![\w$.])(?<namespace>${ID})\.${key}(?=[),.])`, "gu");
    const use = one([...prefix.moduleSource.matchAll(uses)].filter(row => prefixCode.isCode(row.index)), "native mount prefix provider " + key);
    prefixProviders[key] = importRole(copy, use.groups.namespace);
  }
  if (prefixProviders.AP.localName !== mount.groups.status) fail("local status watch and per-host mount use different state");
  const once = /!function\((?<arg>[A-Za-z_$][\w$]*)\)\{if\((?<scope>[A-Za-z_$][\w$]*)\.has\(\k<arg>\)\)return;\k<scope>\.add\(\k<arg>\);/u.exec(prefix.moduleSource);
  if (!once) fail("native once-per-store setup watcher");
  const moduleCode = view(copy), scopeName = once.groups.scope;
  const scopeInit = new RegExp(String.raw`(?:^|[;}])\s*let (?<initializer>${escapeRegExp(scopeName)}=new WeakSet);`, "gu");
  const initialized = one([...copy.moduleSource.matchAll(scopeInit)].filter(row => moduleCode.isRoot(row.index + row[0].indexOf("let "))), "native once-per-store WeakSet let-declarator");
  if (copy.params.includes("WeakSet")) fail("captured native scope intrinsic");
  try { new Script(`function nativeStatusScopes(${copy.params.join(",")}){${copy.moduleSource}\n;let WeakSet;}`); }
  catch { fail("captured native scope intrinsic"); }
  const initializedStart = initialized.index + initialized[0].indexOf(initialized.groups.initializer);
  const withoutInit = copy.moduleSource.slice(0, initializedStart) + scopeName + copy.moduleSource.slice(initializedStart + initialized.groups.initializer.length);
  if (!hasStableEagerMainBinding(withoutInit, scopeName) || rootFunctionHeads(copy.moduleSource, moduleCode).some(row => row.name === scopeName)) fail("native setup watcher scope is replaced");
  const status = importRole(copy, mount.groups.status);
  if (status.moduleId !== statusId || args.includes(mount.groups.status)) fail("wrong native status subscription provider");
  try { new Script(`function nativeStatusMount(${fn.params}){${fn.body}\n;let ${mount.groups.status};}`); }
  catch { fail("captured native status mount namespace"); }
  for (const name of args) if (!hasStableEagerMainBinding(fn.body.slice(0, mount.index), name)) fail("native mount argument was eagerly replaced");
  const tails = new RegExp(String.raw`let (?<pending>${ID})=\[\],(?<cleanup>${ID})=\(\)=>\{if\((?<active>${ID})\)\{`, "gu");
  const tail = one([...fn.body.matchAll(tails)].filter(row => lexical.isRoot(row.index) && fn.body.endsWith("return " + row.groups.cleanup)), "native returned lifecycle cleanup");
  const cleanup = fn.body.slice(tail.index), fake = { params: shapes.readCleanup.params, moduleSource: cleanup };
  if (normalized(fake).text !== normalized(shapes.readCleanup).text) fail("changed native active/cleanup/disposal lifetime");
  const cleanupCode = createJavaScriptLexicalIndex(cleanup), calls = new RegExp(String.raw`(?<![\w$.])${escapeRegExp(mount.groups.dispose)}\(\)`, "gu");
  one([...cleanup.matchAll(calls)].filter(row => cleanupCode.isCode(row.index)), "native mount disposer is not called exactly once");
  const active = new RegExp(String.raw`(?<![\w$.])${escapeRegExp(tail.groups.active)}=!0(?=[,;])`, "gu");
  one([...fn.body.slice(0, mount.index).matchAll(active)].filter(row => lexical.isRoot(row.index)), "native active lifetime initialization");
  const declared = mount[0].indexOf(mount.groups.dispose), begin = mount.index + declared, end = mount.index + mount[0].length - 1;
  if (!hasStableEagerMainBinding(fn.body.slice(0, begin) + mount.groups.dispose + fn.body.slice(end), mount.groups.dispose)) fail("native mount disposer is eagerly replaced");
  return Object.freeze({ moduleId: copy.moduleId, exportName: "x", functionName: fn.name, nativeFunctionBytes: Buffer.byteLength(fn.source), status, prefixProviders: Object.freeze(prefixProviders),
    mount: Object.freeze({ host: args[1], client: args[2], current: args[3], disposer: mount.groups.dispose }),
    boundary: "Bounded native mount and returned cleanup frame inside the published subscriber. Other native thread work, vendor implementations and runtime persistence are retained dependencies, not recursively re-proved." });
}
module.exports = { inspectClassifierBridge, inspectClassifierFacade, inspectDurableLiteral,
  inspectNativeAwaiter, inspectNativeManager, inspectReadLifecycle };
