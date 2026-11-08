"use strict";
const fs = require("node:fs"), path = require("node:path"), { Script } = require("node:vm");
const shapes = require("./revoke-setup-reset-shapes.js");
const { inspectAppServicesFacade, locateAppServicesCopies } = require("./renderer-remote-connections-owners.js");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding, findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const ID = "[A-Za-z_$][\\w$]*", MARKER = "codexLinuxRemoteControlResetMobileSetupAfterRevoke", KEY = "codex-mobile-has-connected-device";
const PROVIDERS = { catalog: "xS4d", queries: "fJ4f", clients: "IUCH", filter: "M03z", awaiter: "q77y" };
const MAX_PROVIDER_BYTES = 16 * 1024, MAX_OWNER_BYTES = 256 * 1024;
const PROVIDER_NEEDLES = {
  catalog: ["localRemoteControlClientId", "localRemoteControlEnvironmentId", "remoteControlState"],
  queries: ["remote-control-clients", "waiting-for-added", "refetchInterval"],
  clients: ["remoteControl/client/list", "remoteControl/client/revoke", "revokeTarget"],
  filter: ["connected", "dismiss", "clientId"],
  awaiter: ["throwIfAborted", "addEventListener", "removeEventListener", "dispose"],
};
const FIXED = new Set("function async await return if else for of let const var new this typeof instanceof void null true false undefined Object Array Set Map Symbol Number Date JSON Promise Error try catch finally switch case break default".split(" "));
function fail(reason) { throw Error("Unsupported current Remote revoke setup-reset contract: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason);return rows[0]; }
function parses(body) { try { new Script(body);return true; } catch { return false; } }
function captured(copy, cap) {
  const row = { assetName: copy?.assetName, source: copy?.source, moduleId: copy?.moduleId, moduleSource: copy?.moduleSource, start: copy?.start, end: copy?.end, params: Array.isArray(copy?.params) ? [...copy.params] : null };
  if (!row.params || row.params.length !== 3 || new Set(row.params).size !== 3 || typeof row.source !== "string" || typeof row.assetName !== "string" || typeof row.moduleSource !== "string" || Buffer.byteLength(row.moduleSource) > cap || row.source.slice(row.start, row.end) !== row.moduleSource) fail("invalid or stale bounded module snapshot");
  if (!parses(`function nativeRevokeFactory(${row.params.join(",")}){${row.moduleSource}\n}`)) fail("invalid factory body");
  Object.freeze(row.params);return Object.freeze(row);
}
function normalized(source, names = []) {
  const index = createJavaScriptLexicalIndex(source), bindings = new Map(names.map((name, i) => [name, "$" + i]));let text = "", cursor = 0;
  for (const token of source.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const at = token.index, name = token[0];if (!index.isCode(at) || FIXED.has(name) || source[at - 1] === "." || /^\s*:/u.test(source.slice(at + name.length))) continue;
    if (!bindings.has(name)) bindings.set(name, "$" + bindings.size);text += source.slice(cursor, at) + bindings.get(name);cursor = at + name.length;
  }
  text += source.slice(cursor);const code = createJavaScriptLexicalIndex(text);let compact = "";
  for (let at = 0; at < text.length;) {
    if (code.isCode(at)) { compact += text[at++];continue; }
    let end = at + 1;while (end < text.length && !code.isCode(end)) end++;
    const trivia = text.slice(at, end);
    if (!/^[ \t]+$/u.test(trivia)) compact += trivia;
    else if (/[\w$]/u.test(text[at - 1] ?? "") && /[\w$]/u.test(text[end] ?? "") || /[+\-*/%&|^<>=!?~.]/u.test((text[at - 1] ?? "") + (text[end] ?? ""))) compact += " ";
    at = end;
  }
  return { text: compact, bindings };
}
function equivalent(actual, expected) {
  const a = normalized(actual), b = normalized(expected);if (a.text !== b.text) fail("changed bounded native critical region");
  const inverse = new Map([...a.bindings].map(([name, key]) => [key, name]));return name => inverse.get(b.bindings.get(name));
}
function moduleProof(copy, expected) {
  if (copy.params.some(name => FIXED.has(name))) fail("native provider captures a global");
  let source = copy.moduleSource;const index = createJavaScriptLexicalIndex(source), imports = [], edits = [], loader = escapeRegExp(copy.params[2]);
  for (const row of source.matchAll(new RegExp(`(?<![\\w$.])${loader}\\(("(?:\\\\.|[^"\\\\])*")\\)`, "gu"))) {
    if (!index.isRoot(row.index)) continue;
    const local = source.slice(0, row.index).match(new RegExp(`(${ID})=$`, "u"))?.[1];if (!local) fail("unbound native provider import");
    const binding = findRspackRequireBinding(copy, local);if (!binding || binding.moduleId !== JSON.parse(row[1])) fail("mutable native provider import");imports.push(binding.moduleId);
    const start = row.index + row[0].indexOf(row[1]);edits.push({ start, end: start + row[1].length });
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + '"@import"' + source.slice(edit.end);
  return { text: normalized(source, copy.params).text, imports };
}
function providerProof(copy, role) {
  const body = copy?.moduleSource;
  // Discovery visits every module in a matching asset. Apply the existing
  // provider bound and necessary native tokens before any lexical work.
  if (typeof body !== "string" || body.length > MAX_PROVIDER_BYTES || Buffer.byteLength(body) > MAX_PROVIDER_BYTES || !PROVIDER_NEEDLES[role].every(needle => body.includes(needle))) fail("not a bounded native " + role + " provider candidate");
  const expected = shapes.providers[PROVIDERS[role]], actual = moduleProof(copy), native = moduleProof({ ...copy, ...expected });
  if (actual.text !== native.text) fail("changed complete native " + role + " provider");
  const keys = { catalog: ["dZ", "BJ", "h9"], queries: ["y8", "MN", "BW"], clients: [], filter: ["uz"], awaiter: [] };
  // Full bounded module grammar also certifies the native async publication
  // values; the generic publisher deliberately has a smaller sync subset.
  for (const key of keys[role]) if (!findRspackExportPublication(copy, key)) fail("missing native " + role + " export " + key);
  return actual;
}
const importAuthorityCache = new WeakMap(), rootFunctionCache = new WeakMap();
function stableImport(copy, name) {
  let cached = importAuthorityCache.get(copy);if (!cached) { cached = new Map();importAuthorityCache.set(copy, cached); }
  if (cached.has(name)) return cached.get(name);
  let declarations = rootFunctionCache.get(copy);if (!declarations) { declarations = rootFunctionHeads(copy.moduleSource);rootFunctionCache.set(copy, declarations); }
  if (declarations.some(row => row.name === name)) fail("critical import collides with a root function " + name);
  const binding = findRspackRequireBinding(copy, name);
  if (!binding || copy.params.includes(name)) fail("missing or captured critical factory import " + name);
  const at = binding.start - copy.start;
  if (copy.moduleSource.slice(at, at + name.length) !== name) fail("stale critical import initializer");
  let fresh = "__nativeRevokeAllowedImport";while (copy.moduleSource.includes(fresh)) fresh += "$";
  const projected = copy.moduleSource.slice(0, at) + fresh + copy.moduleSource.slice(at + name.length);
  if (!hasStableEagerMainBinding(projected, name)) fail("eager write to critical factory import " + name);
  cached.set(name, binding);return binding;
}
function importedById(copy, moduleId) {
  const index = createJavaScriptLexicalIndex(copy.moduleSource), rows = [];
  for (const token of copy.moduleSource.matchAll(new RegExp(`(?<![\\w$.])(${ID})=${escapeRegExp(copy.params[2])}\\(${JSON.stringify(moduleId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\)`, "gu"))) {
    if (!index.isRoot(token.index)) continue;const binding = stableImport(copy, token[1]);if (binding.moduleId === moduleId) rows.push(binding);
  }
  return one(rows, "missing or ambiguous required owner import " + moduleId);
}
function helper(services, awaiter) {
  const used = new Set([services, awaiter]), names = ["e", "t", "n", "r", "i", "a"].map(seed => { let name = seed;while (used.has(name)) name += "$";used.add(name);return name; });
  const [rows, revoked, local, remaining, external, state] = names;
  return `function ${MARKER}(${rows},${revoked},${local}){let ${remaining}=${rows}?.filter(${rows}=>(${rows}.clientId??${rows}.client_id)!==${revoked}),${external}=${remaining}?.filter(${rows}=>(${rows}.clientId??${rows}.client_id)!==${local});if(${external}?.length===0)try{let ${state}=${services}.appServices?.applicationState;if(${state}?.write!=null)(0,${awaiter}.P)(${state}.write(${JSON.stringify(KEY)},!1)).catch(()=>{})}catch{}return ${remaining}}`;
}
function projectOwn(copy, ownHelper) {
  const source = copy.moduleSource;if (!source.includes(MARKER)) return { active: false, moduleSource: source };
  if (source.split(MARKER).length !== 3 || source.split(ownHelper).length !== 2) fail("partial, duplicate or changed own helper");
  const without = source.replace(ownHelper, ""), pattern = new RegExp(`onRevoked:(?<client>${ID})=>\\{(?<query>${ID})\\.setData\\((?<data>${ID})=>${MARKER}\\(\\k<data>,\\k<client>,(?<local>${ID})\\)\\),\\k<query>\\.invalidate\\(\\)\\}`, "gu"), found = one([...without.matchAll(pattern)], "partial own native callback");
  const r = found.groups, native = `onRevoked:${r.client}=>{${r.query}.setData(${r.data}=>${r.data}?.filter(${r.data}=>${r.data}.clientId!==${r.client})),${r.query}.invalidate()}`;
  const moduleSource = without.slice(0, found.index) + native + without.slice(found.index + found[0].length);if (moduleSource.includes(MARKER)) fail("orphan own marker");
  return { active: true, moduleSource, local: r.local };
}
// Binding census stops at each root function head. Parameter/default/body
// grammar remains the responsibility of the separate native-frame reader.
function rootFunctionHeads(body) {
  const lexical = createJavaScriptLexicalIndex(body), heads = [];
  const next = start => { let at = start;while (at < body.length && (!lexical.isCode(at) || /\s/u.test(body[at]))) at++;return at; };
  const identifier = /^(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/u;
  for (const keyword of body.matchAll(/(?<![\w$.])function\b/gu)) {
    if (!lexical.isRoot(keyword.index)) continue;
    let at = next(keyword.index + keyword[0].length);if (body[at] === "*") at = next(at + 1);
    const token = identifier.exec(body.slice(at));if (!token) continue;
    const name = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, a, b) => { const point = parseInt(a || b, 16);return point <= 0x10ffff ? String.fromCodePoint(point) : "\0"; });
    at = next(at + token[0].length);if (body[at] === "(") heads.push({ name, start: keyword.index, parametersOpen: at });
  }
  return heads;
}
function functions(body) {
  const lexical = createJavaScriptLexicalIndex(body), rows = [];
  for (const head of body.matchAll(new RegExp(`(?:async )?function (${ID})\\(([^{}]*)\\)\\{`, "gu"))) {
    if (!lexical.isRoot(head.index)) continue;const open = head.index + head[0].length - 1, end = lexical.matchingBrace(open);if (end < open) fail("incomplete root function");
    rows.push({ name: head[1], params: head[2], start: head.index, end: end + 1, open, body: body.slice(open + 1, end), source: body.slice(head.index, end + 1) });
  }
  return rows;
}
function shapeFunction(rows, expected, cap, reason) {
  const matched = rows.filter(row => Buffer.byteLength(row.source) <= cap).filter(row => { try { equivalent(row.source, expected);return true; } catch { return false; } });return one(matched, reason);
}
function noCapture(fn, names) {
  for (const name of names) if (!parses(`function nativeRevokeCapture(${fn.params}){${fn.body}\n;let ${name};}`)) fail("captured native consumer role " + name);
}
function stableLocals(fn, prefix, roles) {
  const index = createJavaScriptLexicalIndex(fn.body);
  for (const name of roles) {
    if (parses(`function nativeRevokeLocal(${fn.params}){${fn.body}\n;let ${name};}`)) fail("unbound local consumer role " + name);
    const token = [...fn.body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "gu"))].find(row => index.isCode(row.index));if (!token || token.index >= prefix.length) fail("missing native local definition");
    let fresh = "__nativeRevokeAllowedLocal";while (fn.body.includes(fresh)) fresh += "$";
    const projected = fn.body.slice(0, token.index) + fresh + fn.body.slice(token.index + name.length);
    if (!hasStableEagerMainBinding(projected, name)) fail("eager write to native local role " + name);
  }
}
function rootFunctionAuthority(copy, heads, name) {
  if (copy.params.includes(name) || heads.filter(row => row.name === name).length !== 1 || !hasStableEagerMainBinding(copy.moduleSource, name)) fail("duplicate, captured or eagerly rewritten critical function " + name);
}
function inspectOwner(copy, ids) {
  const source = copy?.moduleSource;
  if (typeof source !== "string" || source.length > MAX_OWNER_BYTES || Buffer.byteLength(source) > MAX_OWNER_BYTES || !["RemoteConnectionsSettings", "localRemoteControlClientId", "onRevokeResult"].every(needle => source.includes(needle))) fail("not a bounded native local owner candidate");
  if (!Array.isArray(copy.params) || copy.params.length !== 3) fail("unsupported owner parameters");
  const pubPattern = new RegExp(`^${escapeRegExp(copy.params[2])}\\.d\\(${escapeRegExp(copy.params[1])},\\{RemoteConnectionsSettings:\\(\\)=>(${ID})\\}\\);`, "u");
  if (!source.includes(MARKER) && !pubPattern.test(source)) fail("missing native owner candidate publication");
  const services = importedById(copy, ids.facade), awaiter = importedById(copy, ids.awaiter), ownHelper = helper(services.localName, awaiter.localName), projection = projectOwn(copy, ownHelper), body = projection.moduleSource, nativeCopy = { ...copy, moduleSource: body }, fns = functions(body), heads = rootFunctionHeads(body);
  rootFunctionCache.set(nativeCopy, heads);
  if (!parses(`function nativeRevokeOwnBinding(${copy.params.join(",")}){${body}\n;let ${MARKER};}`) || !hasStableEagerMainBinding(body, MARKER)) fail("captured or written own helper binding");
  const local = one(fns.filter(row => Buffer.byteLength(row.source) <= 16 * 1024 && row.source.includes("localRemoteControlClientId:") && row.source.includes("onRevokeResult:") && row.source.includes(".query.snapshot(")), "missing or ambiguous native local component");
  // Prefix length is taken from the native grammar, then alpha-qualified;
  // unrelated translated UI messages and controls stay outside this seam.
  const prefixLength = shapes.localPrefix.length;let prefix = local.source.slice(0, prefixLength), prefixRoles;
  try { prefixRoles = equivalent(prefix, shapes.localPrefix); } catch {
    const candidates = [...local.source.matchAll(new RegExp(`let (${ID})=(${ID}),`, "gu"))].filter(row => row.index < 4096).map(row => local.source.slice(0, row.index + row[0].length));
    prefixRoles = null;for (const value of candidates) try { prefixRoles = equivalent(value, shapes.localPrefix);prefix = value;break; } catch {}if (!prefixRoles) fail("changed native local query/snapshot/filter prefix");
  }
  const rows = shapeFunction(fns, shapes.rows, 8 * 1024, "missing native successful revoke row owner"), rowRoles = equivalent(rows.source, shapes.rows), parent = shapeFunction(fns, shapes.parent, 4 * 1024, "missing native local setup/manage parent"), parentRoles = equivalent(parent.source, shapes.parent);
  const slotPattern = new RegExp(`\\(0,${ID}\\.jsx\\)\\(${escapeRegExp(rows.name)},\\{clients:`, "gu"), slots = [...local.source.matchAll(slotPattern)].map(row => {
    const tail = new RegExp(`onRevokeResult:${ID}=>\\{\\(0,${ID}\\.yy\\)\\(${ID},${ID}\\.CodexRemoteControlClientRevokeResult,\\{result:${ID}\\}\\)\\}\\}\\)`, "gu");tail.lastIndex = row.index;const found = tail.exec(local.source);return found ? { start: row.index, end: found.index + found[0].length, source: local.source.slice(row.index, found.index + found[0].length) } : null;
  }).filter(Boolean), slot = one(slots, "missing unique native local row slot"), slotRoles = equivalent(slot.source, shapes.localRowsSlot);
  for (const name of ["ej", "eS", "X", "$"]) if (slotRoles(name) !== prefixRoles(name)) fail("local row uses another query/list/identity/store");
  if (parentRoles("eR") !== local.name) fail("local parent uses another revoke component");
  const publication = pubPattern.exec(body);if (!publication) fail("missing settings publication");
  const render = one(fns.filter(row => row.name === publication[1] && Buffer.byteLength(row.source) <= 64 * 1024), "missing bounded published settings render");
  const renderSlots = [...render.source.matchAll(new RegExp(`${ID}\\[229\\]!==${ID}\\?\\(${ID}="control-this-mac"===${ID}\\?\\(0,${ID}\\.jsx\\)\\(${ID}\\.Fragment,\\{children:\\(0,${ID}\\.jsx\\)\\(${escapeRegExp(parent.name)},\\{\\}\\)\\}\\):null,${ID}\\[229\\]=${ID},${ID}\\[230\\]=${ID}\\):${ID}=${ID}\\[230\\]`, "gu"))];
  const renderSlot = one(renderSlots, "missing native published local render slot"), renderRoles = equivalent(renderSlot[0], shapes.renderSlot);if (renderRoles("eN") !== parent.name) fail("wrong published local parent");
  const expected = { D: ids.catalog, eh: ids.queries, ew: ids.filter }, bindings = {};
  function binding(name) { return stableImport(nativeCopy, name); }
  for (const name of ["s", "u", "z", "C", "f", "O", "h", "D", "ee", "eg", "I", "Y", "eh", "ew"]) { const actual = prefixRoles(name);bindings[name] = binding(actual);if (expected[name] && bindings[name].moduleId !== expected[name]) fail("wrong local native provider"); }
  for (const [reader, names] of [[slotRoles, ["o", "k", "i"]], [rowRoles, ["o", "s", "u", "z", "f", "eS", "R", "W", "l"]], [parentRoles, ["s", "G", "I", "u", "ed", "F", "o"]]]) for (const name of names) {
    const actual = reader(name);if (!actual) continue;const found = binding(actual);if (name === "eS" && found.moduleId !== ids.clients) fail("revoke row uses another client provider");
  }
  for (const [name, reader] of [["s", rowRoles], ["u", rowRoles], ["z", rowRoles], ["f", rowRoles], ["s", parentRoles], ["u", parentRoles], ["I", parentRoles]]) if (binding(reader(name)).moduleId !== bindings[name].moduleId) fail("native consumer provider mismatch");
  const jsx = binding(slotRoles("o"));for (const reader of [rowRoles, parentRoles, renderRoles]) if (binding(reader("o")).moduleId !== jsx.moduleId) fail("wrong native JSX caller provider");
  noCapture(local, [rows.name, slotRoles("eL"), MARKER]);noCapture(parent, [local.name]);noCapture(render, [parent.name, renderRoles("o")]);
  for (const name of [local.name, rows.name, parent.name, render.name, slotRoles("eL"), parentRoles("eE")]) rootFunctionAuthority(nativeCopy, heads, name);
  stableLocals(local, prefix, ["ec", "ej", "eS", "X", "$", "G"].map(prefixRoles));
  const callback = new RegExp(`onRevoked:(?<client>${ID})=>\\{(?<query>${ID})\\.setData\\((?<data>${ID})=>\\k<data>\\?\\.filter\\(\\k<data>=>\\k<data>\\.clientId!==\\k<client>\\)\\),\\k<query>\\.invalidate\\(\\)\\}`, "gu"), found = one([...slot.source.matchAll(callback)], "missing native successful local callback");
  if (found.groups.query !== prefixRoles("ej") || projection.active && projection.local !== prefixRoles("ec")) fail("callback uses another query/local client");
  const r = found.groups, replacement = `onRevoked:${r.client}=>{${r.query}.setData(${r.data}=>${MARKER}(${r.data},${r.client},${prefixRoles("ec")})),${r.query}.invalidate()}`, at = local.start + slot.start + found.index, insert = body.startsWith('"use strict";') ? 13 : 0;
  const patchedModuleSource = body.slice(0, insert) + ownHelper + body.slice(insert, at) + replacement + body.slice(at + found[0].length);
  if (projection.active && patchedModuleSource !== copy.moduleSource) fail("own native inverse is not canonical replay");
  return { active: projection.active, nativeModuleSource: body, patchedModuleSource, imports: bindings, local: local.name, rows: rows.name, parent: parent.name, render: render.name };
}
function prepareRevokeSetupReset(input) {
  const roles = ["owner", ...Object.keys(PROVIDERS), "facade"], cohort = {}, proofs = {}, ids = {};
  for (const role of roles) {
    cohort[role] = Array.isArray(input?.[role]) ? input[role].map(copy => captured(copy, role === "owner" ? MAX_OWNER_BYTES : MAX_PROVIDER_BYTES)) : [];
    if (!cohort[role].length || new Set(cohort[role].map(copy => copy.moduleId)).size !== 1 || new Set(cohort[role].map(copy => copy.assetName)).size !== cohort[role].length) fail("missing or ambiguous " + role + " cohort");ids[role] = cohort[role][0].moduleId;
  }
  for (const role of Object.keys(PROVIDERS)) { proofs[role] = cohort[role].map(copy => providerProof(copy, role));if (proofs[role].some(row => JSON.stringify(row.imports) !== JSON.stringify(proofs[role][0].imports))) fail("mixed physical provider imports"); }
  for (const copy of cohort.facade) inspectAppServicesFacade(copy);
  proofs.owner = cohort.owner.map(copy => inspectOwner(copy, ids));if (proofs.owner.some(row => row.active !== proofs.owner[0].active)) fail("mixed physical own contribution state");
  const q = proofs.queries[0].imports, c = proofs.catalog[0].imports;
  if (q[2] !== ids.catalog || q[5] !== ids.clients || q[6] !== ids.filter || q[0] !== c[1] || q[3] !== c[2]) fail("native query/catalog/client/filter graph differs");
  for (const owner of proofs.owner) if (owner.imports.u.moduleId !== q[0] || owner.imports.z.moduleId !== q[3] || owner.imports.ee.moduleId !== q[1]) fail("local component uses another query scope or host-state provider");
  const grouped = new Map();for (const role of roles) for (const [index, copy] of cohort[role].entries()) {
    const row = grouped.get(copy.assetName) ?? { assetName: copy.assetName, source: copy.source, changes: [], inverse: [] };if (row.source !== copy.source) fail("inconsistent same-asset snapshots");
    if (role === "owner") { row.changes.push({ start: copy.start, end: copy.end, source: proofs.owner[index].patchedModuleSource });row.inverse.push({ start: copy.start, end: copy.end, source: proofs.owner[index].nativeModuleSource }); }grouped.set(copy.assetName, row);
  }
  function splice(source, edits) { for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.source + source.slice(edit.end);return source; }
  const edits = [...grouped.values()].map(row => ({ assetName: row.assetName, source: row.source, patchedSource: splice(row.source, row.changes), nativeSource: splice(row.source, row.inverse) }));
  return { edits, alreadyApplied: proofs.owner[0].active, moduleIds: ids, dependencyAssets: [...grouped.keys()].sort() };
}
function locateRevokeSetupReset(assets) {
  const cohort = {};
  for (const role of Object.keys(PROVIDERS)) cohort[role] = findUniqueRspackModuleCopies(assets, { description: "native revoke " + role + " provider", sourceMatch: source => role === "catalog" ? source.includes("localRemoteControlClientId") : role === "queries" ? source.includes("waiting-for-added") : role === "clients" ? source.includes("remoteControl/client/revoke") : role === "filter" ? source.includes('"connected":"dismiss"') : source.includes("throwIfAborted"), matchModule: (_body, copy) => { try { providerProof(copy, role);return true; } catch { return false; } } });
  const facadeIdentity = findUniqueRspackModuleCopies(assets, { description: "native late appServices facade identity", sourceMatch: source => source.includes("setAppServices") && source.includes("appServices:"), matchModule: (_body, copy) => { try { inspectAppServicesFacade(copy);return true; } catch { return false; } } });
  cohort.facade = locateAppServicesCopies(assets, facadeIdentity[0].moduleId);
  const ids = Object.fromEntries(Object.entries(cohort).map(([role, copies]) => [role, copies[0].moduleId]));
  cohort.owner = findUniqueRspackModuleCopies(assets, { description: "native local successful revoke owner", sourceMatch: source => source.includes("localRemoteControlClientId:") || source.includes(MARKER), matchModule: (_body, copy) => { try { inspectOwner(copy, ids);return true; } catch { return false; } } });
  const prepared = prepareRevokeSetupReset(cohort);let markers = 0;for (const name of listWebviewAssetFiles(assets, /\.js$/u)) markers += fs.readFileSync(path.join(assets, name), "utf8").split(MARKER).length - 1;
  if (markers !== (prepared.alreadyApplied ? 2 * cohort.owner.length : 0)) fail("orphan contribution marker outside owner cohort");return prepared;
}
function applyRevokeSetupReset(extractedDir, options = {}) { const assets = path.join(extractedDir, "webview/assets"), prepared = locateRevokeSetupReset(assets);return { ...patchWebviewAssets(assets, prepared.edits, options), matched: true, moduleIds: prepared.moduleIds }; }
function prepareRevokeSetupResetSource(source) {
  const modules = [...rspackModuleFactories(source, "__source__.js")], cohort = {};
  for (const role of Object.keys(PROVIDERS)) cohort[role] = modules.filter(copy => { try { providerProof(copy, role);return true; } catch { return false; } });
  cohort.facade = modules.filter(copy => { try { inspectAppServicesFacade(copy);return true; } catch { return false; } });
  const ids = Object.fromEntries(Object.entries(cohort).map(([role, rows]) => [role, rows[0]?.moduleId]));cohort.owner = modules.filter(copy => { try { inspectOwner(copy, ids);return true; } catch { return false; } });
  const plan = prepareRevokeSetupReset(cohort);if (source.split(MARKER).length - 1 !== (plan.alreadyApplied ? 2 : 0)) fail("orphan String input marker");return { ...plan, patchedSource: plan.edits[0].patchedSource, nativeSource: plan.edits[0].nativeSource };
}
module.exports = { prepareRevokeSetupReset, prepareRevokeSetupResetSource, locateRevokeSetupReset, applyRevokeSetupReset };
