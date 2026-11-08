"use strict";
const { Script } = require("node:vm");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const scope = require("./remote-copy-scope.js");
const shapes = require("./terminal-status-graph-shapes.js");
const ID = "[A-Za-z_$][\\w$]*";
function fail(reason) { throw Error(`Remote terminal state graph: ${reason}`); }
function one(rows, reason) { if (rows.length !== 1) fail(reason);return rows[0]; }
function view(copy, maximum) {
  if (Buffer.byteLength(copy?.moduleSource ?? "") > maximum) fail("bounded native provider");
  scope.stableFactoryParameters(copy);return scope.context(copy);
}
function declarator(copy, ctx, start, end, nativeKind) {
  const declarations = [...copy.moduleSource.matchAll(/\b(?<kind>let|const|var)\s+/gu)].filter(x => x.index < start && ctx.lexical.isRoot(x.index));
  const declaration = declarations.at(-1);
  if (!declaration) fail("missing native root declarator");
  if (declaration.groups.kind !== nativeKind) fail("changed native root declaration kind");
  let previous = declaration.index - 1;
  while (previous >= 0 && !ctx.lexical.isCode(previous)) previous--;
  if (previous >= 0 && ![";", "}"].includes(copy.moduleSource[previous])) fail("conditional native declaration statement");
  try { new Script(`for(${copy.moduleSource.slice(declaration.index, end)};;){break;}`); }
  catch { fail("initializer is not a native root declarator"); }
}
function nativeSmall(copy, role) {
  view(copy, 8 * 1024);
  const a = scope.normalized(copy), b = scope.normalized(shapes[role]);
  if (a.text !== b.text || a.imports.length !== b.imports.length) fail("changed complete native state interface");
  const imports = a.imports.map(x => scope.requireImport(copy, x.local, copy.moduleSource.length - 1));
  return { imports, expected: b.imports };
}
function inspectRuntimeState(copy) {
  const p = nativeSmall(copy, "runtimeState");
  for (const key of ["Nb", "ok", "hF"]) {
    const pub = findRspackExportPublication(copy, key);
    if (!pub?.expression || !new RegExp(`^${ID}$`, "u").test(pub.expression)) fail("native keyed state atom publication " + key);
  }
  const role = local => p.imports[p.expected.findIndex(x => x.local === local)];
  return Object.freeze({ moduleId: copy.moduleId, imports: Object.freeze(p.imports), atomFactory: role("l"), atomScope: role("d"),
    boundary: "Complete small native per-thread listState subscription, summary/state/request atom projections and host/thread ownership key; RPC transport implementation retained as native dependency." });
}
function inspectHostSelector(copy, runtimeId) {
  const p = nativeSmall(copy, "hostSelector"), i = p.expected.findIndex(x => x.local === "o");
  if (p.imports[i]?.moduleId !== runtimeId || findRspackExportPublication(copy, "qX")?.expression == null) fail("native thread-to-host selection provider");
  const role = local => p.imports[p.expected.findIndex(x => x.local === local)];
  return Object.freeze({ moduleId: copy.moduleId, runtimeId, imports: Object.freeze(p.imports), atomFactory: role("r"), atomScope: role("i") });
}
function inspectThreadState(copy) {
  const ctx = view(copy, 32 * 1024), pub = findRspackExportPublication(copy, "pC");
  if (!pub?.expression || !new RegExp(`^${ID}$`, "u").test(pub.expression)) fail("native summary atom publication");
  const atom = pub.expression;
  const pattern = new RegExp(String.raw`(?<![\w$.])${escapeRegExp(atom)}=\(0,(?<jotai>${ID})\.i1\)\((?<scope>${ID})\.u,\((?<key>${ID}),\{get:(?<get>${ID})\}\)=>\k<get>\((?<state>${ID})\.Nb,\{hostId:\k<key>\.hostId,threadId:\k<key>\.conversationId\}\),\{isEqual:(?<equal>${ID})\(\),key:(?<keyfn>${ID})\}\)`, "gu");
  const match = one([...copy.moduleSource.matchAll(pattern)].filter(x => ctx.lexical.isRoot(x.index)), "native host/thread summary projection");
  const r = match.groups;
  if (new Set(Object.values(r)).size !== Object.values(r).length) fail("captured summary projection role");
  // Parse this exact initializer as a declaration list, where ASI, conditional
  // assignments or unrelated statements cannot stand in for its declarator.
  const end = match.index + match[0].length;
  declarator(copy, ctx, match.index, end, "let");
  const projected = copy.moduleSource.slice(0, match.index) + atom + copy.moduleSource.slice(end);
  if (!hasStableEagerMainBinding(projected, atom) || ctx.rootFunctionHeads.some(x => x.name === atom)) fail("replaced native summary atom");
  const at = key => match.index + match[0].indexOf(r[key] + ".");
  const state = scope.requireImport(copy, r.state, at("state"));
  const atomFactory = scope.requireImport(copy, r.jotai, at("jotai")), atomScope = scope.requireImport(copy, r.scope, at("scope"));
  const equalPattern = new RegExp(String.raw`(?<![\w$.])${escapeRegExp(r.equal)}=${escapeRegExp(copy.params[2])}\.n\((?<namespace>${ID})\)`, "gu");
  const equal = one([...copy.moduleSource.matchAll(equalPattern)].filter(x => ctx.lexical.isRoot(x.index)), "native equality default import");
  declarator(copy, ctx, equal.index, equal.index + equal[0].length, "var");
  // This namespace is consumed eagerly by the default interop initializer;
  // later native closures can reuse its minified name as their local binding.
  const equalityProvider = findRspackRequireBinding(copy, equal.groups.namespace);
  if (!equalityProvider || equalityProvider.requireName !== copy.params[2] || ctx.rootFunctionHeads.some(x => [equal.groups.namespace, copy.params[2]].includes(x.name))) fail("native equality import authority");
  const eqStart = equalityProvider.start - copy.start, eqEnd = equalityProvider.end - copy.start;
  if (!hasStableEagerMainBinding(copy.moduleSource.slice(0, eqStart) + equal.groups.namespace + copy.moduleSource.slice(eqEnd), equal.groups.namespace)) fail("eager equality provider replacement");
  const withoutEqual = copy.moduleSource.slice(0, equal.index) + r.equal + copy.moduleSource.slice(equal.index + equal[0].length);
  if (!hasStableEagerMainBinding(withoutEqual, r.equal) || ctx.rootFunctionHeads.some(x => x.name === r.equal)) fail("replaced native equality adapter");
  const keyfn = scope.stableRootFunction(copy, r.keyfn);
  const args = new RegExp(String.raw`^\{hostId:(?<host>${ID}),conversationId:(?<thread>${ID})\}$`, "u").exec(keyfn.params);
  if (!args || args.groups.host === args.groups.thread ||
      copy.moduleSource.slice(keyfn.open + 1, keyfn.end - 1) !== 'return`' + '${' + args.groups.host + '}:${' + args.groups.thread + '}`') fail("native host/thread atom key");
  if (findRspackExportPublication(copy, "ok")?.expression !== `${r.state}.ok` || findRspackExportPublication(copy, "hF")?.expression !== `${r.state}.hF`) fail("different summary/runtime/request state providers");
  const selector = findRspackExportPublication(copy, "qX")?.expression;
  const selected = selector && new RegExp(String.raw`^(?<namespace>${ID})\.qX$`, "u").exec(selector);
  if (!selected) fail("native host selector publication");
  const hostSelector = scope.requireImport(copy, selected.groups.namespace, copy.moduleSource.length - 1);
  return Object.freeze({ moduleId: copy.moduleId, runtimeState: state, hostSelector, atomFactory, atomScope, equalityProvider,
    boundary: "Selected published pC summary projection and key function, ok/hF runtime/request atom and qX host selector forwarding only. Unrelated atoms in the native module are retained unchanged, not whole-module locked or recursively re-proved." });
}
function inspectTerminalStateProviders(groups, threadStateId, atoms = null) {
  for (const role of ["threadState", "runtimeState", "hostSelector"]) if (!groups[role]?.length || new Set(groups[role].map(x => x.moduleId)).size !== 1) fail("missing or ambiguous provider " + role);
  const runtimeId = groups.runtimeState[0].moduleId, selectorId = groups.hostSelector[0].moduleId;
  if (new Set([threadStateId, runtimeId, selectorId]).size !== 3) fail("colliding native state provider identities");
  const proofs = {};
  for (const copy of groups.threadState) {
    const p = inspectThreadState(copy);
    if (p.moduleId !== threadStateId || p.runtimeState.moduleId !== runtimeId || p.hostSelector.moduleId !== selectorId) fail("foreign thread state provider");
    (proofs.threadState ??= []).push(p);
  }
  proofs.runtimeState = groups.runtimeState.map(inspectRuntimeState);
  proofs.hostSelector = groups.hostSelector.map(copy => inspectHostSelector(copy, runtimeId));
  const first = atoms ?? proofs.threadState[0];
  for (const [role, rows] of Object.entries(proofs)) {
    const ids = rows[0].imports?.map(x => x.moduleId);
    for (const p of rows) {
      if (p.atomFactory?.moduleId !== first.atomFactory?.moduleId || p.atomScope?.moduleId !== first.atomScope?.moduleId) fail("different native atom factory or scope");
      if (ids && p.imports.some((x, i) => x.moduleId !== ids[i])) fail("different native provider imports across physical peers " + role);
      if (role === "threadState" && p.equalityProvider.moduleId !== rows[0].equalityProvider.moduleId) fail("different native equality providers");
    }
  }
  return Object.freeze({ threadStateId, runtimeId, selectorId });
}
module.exports = { inspectRuntimeState, inspectHostSelector, inspectThreadState, inspectTerminalStateProviders };
