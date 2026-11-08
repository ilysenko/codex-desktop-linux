"use strict";
const fs = require("node:fs"), path = require("node:path"), { Script } = require("node:vm");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const scope = require("./remote-copy-scope.js"), contract = require("./outbound-tab-contracts.js");
const MARKER = "codexLinuxRemoteControlOutboundTabGate", ID = "[A-Za-z_$][\\w$]*";
const KEYWORDS = new Set("function return let const var if else null true false typeof void switch case default break new for of async await try catch throw undefined AbortController queueMicrotask navigator Symbol Object Array".split(" "));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(reason) { throw Error("Remote outbound tab contract: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason);return rows[0]; }
function norm(text) { return scope.normalized({ params: ["unusedModule", "unusedExports", "unusedRequire"], moduleSource: text }).text; }
function matches(copy, expression, owner = null) {
  const body = owner?.source ?? copy.moduleSource, offset = owner?.start ?? 0, lexical = scope.context(copy).lexical;
  return [...body.matchAll(expression)].filter(row => lexical.isCode(offset + row.index)).map(row => Object.assign(row, { at: offset + row.index }));
}
// These are finite selected native expressions, not a function/parameter parser.
// Property names, keywords and opaque bytes remain literal; local names may drift.
function pattern(text, bindings) {
  const lexical = createJavaScriptLexicalIndex(text);let result = "", cursor = 0;
  for (const token of text.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    if (!lexical.isCode(token.index) || KEYWORDS.has(token[0]) || text[token.index - 1] === "." || /^\s*:/u.test(text.slice(token.index + token[0].length))) continue;
    result += escape(text.slice(cursor, token.index)) + (bindings[token[0]] ? escape(bindings[token[0]]) : `(?:${ID})`);
    cursor = token.index + token[0].length;
  }
  return new RegExp(result + escape(text.slice(cursor)), "gu");
}
function provider(copy, name, at) { return scope.requireImport(copy, name, at).moduleId; }
function rootSite(copy, entry, row) {
  if (scope.enclosingFunction(copy, row.at).start !== entry.start) fail("nested native initializer");
}
function projectOwner(copy, entry) {
  const body = copy.moduleSource.slice(entry.open + 1, entry.end - 1);
  let prefix = "__codexOutboundScope";while (body.includes(prefix)) prefix += "$";
  return { params: [prefix + "M", prefix + "E", prefix + "R"], start: 0, moduleSource: body, bodyOffset: entry.open + 1 };
}
function unshadowedLocal(projected, name, at) { scope.unshadowed(projected, name, at - projected.bodyOffset); }
function nativeLocal(entry, name) {
  // Compilation proves lexical ownership without executing the component or
  // extending its native parameter/frame grammar. A root let conflicts only
  // with a same-scope declaration/parameter or a hoisted function-local var.
  try { new Script(`"use strict";(${entry.source.slice(0, -1)}\nlet ${name};\n});`); }
  catch { return; }
  fail("missing native component local " + name);
}
function nativeRootLets(projected) {
  const body = projected.moduleSource, lexical = createJavaScriptLexicalIndex(body), lists = [], declarations = [];
  const declarationList = text => { try { new Script(`"use strict";for(let ${text};;){}`);return true; } catch { return false; } };
  for (const head of body.matchAll(/\blet\b/gu)) {
    if (!lexical.isCode(head.index) || !lexical.isRoot(head.index)) continue;
    let previous = head.index - 1;while (previous >= 0 && !lexical.isCode(previous)) previous--;
    if (previous >= 0 && !";}".includes(body[previous])) continue;
    let start = head.index + head[0].length;while (/\s/u.test(body[start] ?? "")) start++;let end = start;
    while (end < body.length && !(body[end] === ";" && lexical.isCode(end) && lexical.isRoot(end))) end++;
    if (end === body.length || !declarationList(body.slice(start, end))) continue;
    const list = { start: projected.bodyOffset + head.index, end: projected.bodyOffset + end, index: lists.length };
    lists.push(list);let cursor = start;
    for (let at = start; at <= end; at++) {
      if (at !== end && !(body[at] === "," && lexical.isCode(at) && lexical.isRoot(at) && declarationList(body.slice(start, at)))) continue;
      let left = cursor, right = at;while (/\s/u.test(body[left] ?? "")) left++;while (right > left && /\s/u.test(body[right - 1])) right--;
      declarations.push({ start: projected.bodyOffset + left, end: projected.bodyOffset + right, text: body.slice(left, right), list });cursor = at + 1;
    }
  }
  return { lists, declarations };
}
function rootInitializer(rootLets, row, reason) {
  return one(rootLets.declarations.filter(decl => decl.start === row.at && decl.end === row.at + row[0].length && decl.text === row[0]), "native root let initializer " + reason);
}
function immutableLocal(copy, projected, name, initializer, memberWrites = false) {
  for (const row of matches(copy, new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`, "gu"))) {
    if (row.at < projected.bodyOffset || row.at >= projected.bodyOffset + projected.moduleSource.length) continue;
    try { unshadowedLocal(projected, name, row.at); } catch { continue; }
    const tail = copy.moduleSource.slice(row.at + name.length);
    const direct = /^\s*(?:=(?![=>])|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(tail);
    const member = !memberWrites && /^\s*\.[A-Za-z_$][\w$]*\s*(?:=(?![=>])|\+\+|--|[+\-*/%&|^]=|\?\?=|&&=|\|\|=)/u.test(tail);
    if ((direct || member) && !(initializer.at <= row.at && row.at < initializer.at + initializer[0].length)) fail("mutable native local " + name);
  }
}
function prepareOutboundTabOwner(copy) {
  if (!copy || Buffer.byteLength(copy.moduleSource ?? "") > 256 * 1024) fail("bounded settings owner");
  scope.stableFactoryParameters(copy);
  const entry = scope.publishedRootFunction(copy, "RemoteConnectionsSettings");
  const gate = one(matches(copy, new RegExp(`(${ID})=\\(0,(${ID})\\.Zj\\)\\("782640499"\\)`, "gu"), entry), "native hide-gate subscription");
  const platform = one(matches(copy, new RegExp(`\\{platform:(${ID})\\}=\\(0,(${ID})\\.V\\)\\(\\)`, "gu"), entry), "native platform binding");
  const available = one(matches(copy, new RegExp(`(${ID})=\\(0,(${ID})\\.wi\\)\\(\\)`, "gu"), entry), "native availability binding");
  const memo = one(matches(copy, new RegExp(`(${ID})=\\(0,(${ID})\\.c\\)\\(${contract.nativeMemoCapacity}\\)`, "gu"), entry), "native settings memo binding");
  const native = `!${gate[1]}`, patched = `/*${MARKER}*/(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)||!${gate[1]})`;
  const flag = one(matches(copy, new RegExp(`(?<![\\w$.])(${ID})=(${escape(patched)}|${escape(native)})(?=,)`, "gu"), entry), "canonical outbound flag");
  for (const row of [gate, platform, available, memo, flag]) rootSite(copy, entry, row);
  if (matches(copy, /\(0,[A-Za-z_$][\w$]*\.Zj\)\("782640499"\)/gu).length !== 1) fail("duplicate hide-gate hook");
  const state = flag[2] === native ? "native" : "patched";
  if (copy.moduleSource.split(MARKER).length - 1 !== (state === "patched" ? 1 : 0)) fail("orphan outbound contribution");
  const projected = projectOwner(copy, entry), rootLets = nativeRootLets(projected), bindings = { tD: gate[1], G: gate[2], tk: platform[1], O: platform[2], nF: available[1], tK: available[2], nZ: flag[1], tw: memo[1], s: memo[2] };
  const imports = { gateHook: provider(copy, gate[2], gate.at), platform: provider(copy, platform[2], platform.at), tabs: provider(copy, available[2], available.at) };
  if (provider(copy, memo[2], memo.at) !== "QosV") fail("native memo provider");
  const tabFlags = one(matches(copy, new RegExp(`(${ID})=${escape(available[1])}&&!0,(${ID})=${escape(flag[1])}&&\\(${escape(available[1])}\\|\\|!1\\),(${ID})=${escape(available[1])}&&!0`, "gu"), entry), "separate topology flags");
  Object.assign(bindings, { nK: tabFlags[1], nQ: tabFlags[2], nY: tabFlags[3] });
  const route = one(matches(copy, new RegExp(`(${ID})="remoteControl"===(${ID})&&"add"===(${ID})`, "gu"), entry), "remote-control route separator");
  Object.assign(bindings, { n0: route[1], tO: route[2], tR: route[3] });
  const resolver = one(matches(copy, new RegExp(`(${ID})=\\(0,${escape(available[2])}\\.HZ\\)\\(`, "gu"), entry), "native tab resolver call");bindings.n9 = resolver[1];
  const pairing = one(matches(copy, new RegExp(`(${ID})=\\(0,${escape(gate[2])}\\.Zj\\)\\((${ID})\\.Qg\\)`, "gu"), entry), "native pairing gate");
  bindings.tP = pairing[1];bindings.I = pairing[2];imports.pairing = provider(copy, pairing[2], pairing.at);
  const client = one(matches(copy, new RegExp(`(${ID})=\\(0,(${ID})\\.Ul\\)\\((${ID})\\.dZ\\)`, "gu"), entry), "native local client identity");
  Object.assign(bindings, { tU: client[1], u: client[2], D: client[3] });imports.catalog = provider(copy, client[3], client.at);
  if (provider(copy, client[2], client.at) !== "zTeN") fail("native catalog reader");
  const remote = one(matches(copy, new RegExp(`(${ID})=\\(0,${escape(client[2])}\\.Ul\\)\\(${escape(client[3])}\\.h9\\)`, "gu"), entry), "native auth state read");bindings.tW = remote[1];
  const auth = one(matches(copy, new RegExp(`(${ID})=${escape(remote[1])}\\?\\.authRequired===!0,(${ID})=${escape(remote[1])}\\?\\.clientAuthorized===!0`, "gu"), entry), "native auth policy inputs");
  Object.assign(bindings, { eo: auth[1], es: auth[2] });
  const locals = [gate[1], platform[1], available[1], flag[1], memo[1], ...tabFlags.slice(1), route[1], resolver[1], pairing[1], client[1], remote[1], auth[1], auth[2]];
  if (new Set(locals).size !== locals.length || locals.some(name => [gate[2], platform[2], available[2], memo[2], client[2], client[3], pairing[2]].includes(name))) fail("captured native role bindings");
  for (const row of [tabFlags, route, resolver, pairing, client, remote, auth]) rootSite(copy, entry, row);
  new Script(`"use strict";(${entry.source});`);
  for (const name of locals) nativeLocal(entry, name);
  for (const [name, initializer, members] of [[gate[1], gate, false], [platform[1], platform, false], [available[1], available, false], [flag[1], flag, false], [memo[1], memo, true]]) immutableLocal(copy, projected, name, initializer, members);
  const nativeInitializers = [memo, platform, gate, pairing, client, remote, available, flag];
  const initialized = nativeInitializers.map((row, index) => rootInitializer(rootLets, row, String(index)));
  const firstCode = [...projected.moduleSource.matchAll(/\S/gu)].find(row => scope.context(projected).lexical.isCode(row.index))?.index;
  if (initialized[0].list.start !== projected.bodyOffset + firstCode || initialized.slice(0,4).some(row => row.list !== initialized[0].list) ||
      initialized[4].list !== initialized[5].list || initialized[6].list !== initialized[7].list ||
      initialized.some((row, index) => index > 0 && row.start <= initialized[index-1].start)) fail("native initializer declaration order");
  // The legacy detector is intentional. It must resolve the ambient navigator,
  // never an imported/factory/consumer-local same-spelled authority.
  try { new Script(`"use strict";(function(${copy.params}){${copy.moduleSource}\nlet navigator;});`); }
  catch { fail("captured navigator detector"); }
  scope.unshadowed(copy, "navigator", flag.at);
  const guardRow = one(matches(copy, pattern(contract.sites.deepLinkGuard, bindings), entry), "selected native deepLinkGuard");
  const callback = scope.enclosingFunction(copy, guardRow.at);
  const callbackName = new RegExp(`(${ID})=$`, "u").exec(copy.moduleSource.slice(entry.start, callback.start))?.[1];
  if (!callbackName) fail("deep-link callback assignment");
  bindings.e1 = callbackName;
  const selected = [];
  for (const [key, text] of Object.entries(contract.sites)) {
    const row = key === "ownedFlag" ? flag : key === "deepLinkGuard" ? guardRow : one(matches(copy, pattern(text, bindings), entry), "selected native " + key);
    if (key !== "deepLinkGuard") rootSite(copy, entry, row);
    selected.push({ key, start: row.at, end: row.at + row[0].length, text: key === "ownedFlag" ? `${flag[1]}=${native}` : row[0] });
  }
  const guard = selected.find(row => row.key === "deepLinkGuard");
  const head = callbackName + "=" + copy.moduleSource.slice(callback.start, guard.end);
  const event = selected.find(row => row.key === "deepLinkEventLink");
  const eventCall = new RegExp(`^let (${ID})=\\(0,(${ID})\\.useEffectEvent\\)\\(${escape(callbackName)}\\)$`, "u").exec(event.text);
  if (!eventCall || provider(copy, eventCall[2], event.start) !== "zd8w") fail("deep-link event bridge");
  nativeLocal(entry, callbackName);nativeLocal(entry, eventCall[1]);
  const topology = tabFlags[0].split(",").map((text, index, rows) => ({ at: tabFlags.at + rows.slice(0,index).reduce((count,row)=>count+row.length+1,0), 0: text }));
  const topologyDecls = topology.map((row,index) => rootInitializer(rootLets,row,"topology"+index));
  const routeDecl = rootInitializer(rootLets,route,"route"), resolverSite = selected.find(row=>row.key==="tabResolver");
  const resolverDecl = rootInitializer(rootLets,{at:resolverSite.start,0:resolverSite.text},"resolver"), eventDecl = rootInitializer(rootLets,{at:event.start+4,0:event.text.slice(4)},"event");
  const callbackDecl = one(rootLets.declarations.filter(row=>row.text===callbackName),"native callback let declaration");
  if (topologyDecls.some(row=>row.list!==topologyDecls[0].list) || callbackDecl.list!==initialized[0].list ||
      !(initialized[7].start<topologyDecls[0].start && topologyDecls[2].start<routeDecl.start && routeDecl.start<resolverDecl.start &&
        resolverDecl.start<callback.start && callback.end<eventDecl.start)) fail("native caller declaration order");
  const callbackRefs = matches(copy, new RegExp(`(?<![\\w$.])${escape(callbackName)}(?![\\w$])`, "gu"), entry);
  const callbackCache = one(matches(copy, new RegExp(`${escape(memo[1])}\\[(\\d+)\\]=${escape(callbackName)}\\):${escape(callbackName)}=${escape(memo[1])}\\[\\1\\]`, "gu"), entry), "native callback cache bridge");
  const callbackAssignment = callback.start - callbackName.length - 1;
  if (callbackRefs.length !== contract.nativeCallbackReferences || callbackRefs.filter(row => row.at < memo.at).length !== 1) fail("callback reference inventory");
  for (const row of callbackRefs) {
    unshadowedLocal(projected, callbackName, row.at);
    if (row.at < memo.at || row.at === callbackAssignment || callbackCache.at <= row.at && row.at < callbackCache.at + callbackCache[0].length || event.start <= row.at && row.at < event.end) continue;
    fail("unowned callback authority");
  }
  const eventRefs = matches(copy, new RegExp(`(?<![\\w$.])${escape(eventCall[1])}(?![\\w$])`, "gu"), entry);
  if (eventRefs.length !== contract.nativeEventReferences) fail("event reference inventory");
  for (const row of eventRefs) unshadowedLocal(projected, eventCall[1], row.at);
  immutableLocal(copy, projected, eventCall[1], { at: event.start, 0: event.text });
  const service = new RegExp(`,${ID}=(${ID})\\.appServices\\.sshConnections;`, "u").exec(head);
  if (!service || provider(copy, service[1], callback.start) !== "GaA7") fail("deep-link native service binding");
  if (norm(selected.map(row => row.text).concat(head).join(";")) !== norm(Object.values(contract.sites).concat(contract.deepLinkCallbackHead).join(";"))) fail("selected consumer binding relations");
  const refs = matches(copy, new RegExp(`(?<![\\w$.])${escape(flag[1])}(?![\\w$])`, "gu"), entry);
  if (refs.length !== contract.nativeFlagReferences) fail("outbound reference inventory");
  let memoRefs = 0;
  for (const row of refs) {
    unshadowedLocal(projected, flag[1], row.at);
    if (selected.some(site => site.start <= row.at && row.at < site.end)) continue;
    const prefix = copy.moduleSource.slice(Math.max(entry.start, row.at - 80), row.at);
    if (!new RegExp(`${escape(memo[1])}\\[\\d+\\](?:!==|=)$`, "u").test(prefix)) fail("unowned outbound read");
    memoRefs++;
  }
  if (memoRefs !== contract.nativeMemoReferences) fail("outbound memo reference inventory");
  for (const row of matches(copy, new RegExp(`(?<![\\w$.])${escape(gate[1])}(?![\\w$])`, "gu"), entry)) {
    unshadowedLocal(projected, gate[1], row.at);
    if (![gate, flag].some(site => site.at <= row.at && row.at < site.at + site[0].length)) fail("unowned hide-gate reference");
  }
  const mapper = one(matches(copy, pattern(contract.actionMapper, {})), "native retired action mapper");
  const mapperRoot = one(scope.context(copy).functions.filter(row => row.root && row.start < mapper.at && mapper.at < row.end), "native action mapper caller");
  scope.reachable(copy, entry, mapperRoot);
  if (norm(mapper[0]) !== norm(contract.actionMapper)) fail("native retired action behavior");
  const next = copy.moduleSource.slice(0, flag.at) + `${flag[1]}=${patched}` + copy.moduleSource.slice(flag.at + flag[0].length);
  const original = copy.moduleSource.slice(0, flag.at) + `${flag[1]}=${native}` + copy.moduleSource.slice(flag.at + flag[0].length);
  return { state, imports, patchedSource: next, nativeSource: original, flag: flag[1], entry: entry.name, selectedSites: selected.length };
}
function shape(copy, role, ids) {
  const key = { gateHook: "hZax", platform: "wwME", platformMap: "XYHU", catalog: "xS4d", pairing: "mUEW" }[role];
  const expected = contract.shapes[key];
  if (Buffer.byteLength(copy.moduleSource) > 8192 || !expected) fail("bounded native provider " + role);
  scope.context(copy);const actual = scope.normalized(copy);
  if (actual.text !== scope.normalized(expected).text) fail("native provider shape " + role);
  for (const [index, row] of actual.imports.entries()) if (row.moduleId !== (role === "platform" && index === 2 ? ids.platformMap : contract.importIds[key][index])) fail("native provider import " + role);
}
function prepareOutboundTab(cohort) {
  for (const role of ["owner", "gateHook", "platform", "platformMap", "tabs", "catalog", "pairing"]) if (!cohort?.[role]?.length) fail("missing " + role);
  const ids = Object.fromEntries(Object.entries(cohort).map(([role, rows]) => [role, one([...new Set(rows.map(row => row.moduleId))], "mixed role " + role)]));
  const owners = cohort.owner.map(prepareOutboundTabOwner), first = owners[0];
  if (owners.some(row => row.state !== first.state || JSON.stringify(row.imports) !== JSON.stringify(first.imports))) fail("mixed owner state/links");
  for (const [role, id] of Object.entries(first.imports)) if (ids[role] !== id) fail("wrong selected " + role);
  if (new Set(Object.values(ids)).size !== Object.keys(ids).length) fail("overlapping native role identities");
  for (const role of ["gateHook", "platform", "platformMap", "catalog", "pairing"]) for (const copy of cohort[role]) shape(copy, role, ids);
  for (const copy of cohort.tabs) {
    scope.stableFactoryParameters(copy);
    if (norm(scope.publicationMember(copy, "HZ").value) !== norm(contract.tabResolver.moduleSource)) fail("native HZ tab resolver");
  }
  for (const copy of cohort.pairing) {
    scope.stableFactoryParameters(copy);const value = scope.publicationMember(copy, "Qg").value;
    if (!new RegExp(`^${ID}$`, "u").test(value)) fail("native pairing gate publication");
    const row = one(matches(copy, new RegExp(`(?<![\\w$.])${escape(value)}="2055603567"`, "gu")).filter(row => scope.context(copy).lexical.isRoot(row.at)), "native pairing gate value");
    if (!row) fail("native pairing gate value");
  }
  const assets = new Map();
  for (const copies of Object.values(cohort)) for (const copy of copies) {
    if (!Number.isInteger(copy.start) || !Number.isInteger(copy.end) || copy.start < 0 || copy.end < copy.start ||
        typeof copy.source !== "string" || copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale physical source");
    const old = assets.get(copy.assetName);if (old && old.source !== copy.source) fail("inconsistent physical source");
    if (!old) assets.set(copy.assetName, { assetName: copy.assetName, source: copy.source, changes: [], inverses: [] });
  }
  for (const [index, copy] of cohort.owner.entries()) {
    assets.get(copy.assetName).changes.push({ start: copy.start, end: copy.end, text: owners[index].patchedSource });
    assets.get(copy.assetName).inverses.push({ start: copy.start, end: copy.end, text: owners[index].nativeSource });
  }
  const edits = [...assets.values()].map(asset => {
    const splice = rows => { let text = asset.source, last = asset.source.length;for (const row of rows.sort((a,b) => b.start-a.start)) { if (row.end > last) fail("overlapping owner ranges");text = text.slice(0,row.start)+row.text+text.slice(row.end);last=row.start; }return text; };
    return { assetName: asset.assetName, source: asset.source, patchedSource: splice(asset.changes), nativeSource: splice(asset.inverses) };
  });
  return { edits, alreadyApplied: first.state === "patched", targetCopies: owners.length, selectedSites: first.selectedSites, ids };
}
function locateOutboundTab(assets) {
  const owner = findUniqueRspackModuleCopies(assets, { description: "current outbound Connections owner",
    sourceMatch: text => text.includes("RemoteConnectionsSettings:") && text.includes('"782640499"'),
    matchModule: (body, copy) => { if (Buffer.byteLength(body) > 256 * 1024 || !body.includes("showControlOtherDevices:")) return false;try { prepareOutboundTabOwner(copy);return true; } catch { return false; } },
  });
  const proof = prepareOutboundTabOwner(owner[0]), cohort = { owner };
  const needles = { gateHook: ['cache:"signal"', "Zj:function"], platform: ["modifierSymbol:"], platformMap: ['qH:{macOS:"darwin",windows:"win32",linux:"linux"}'],
    catalog: ["localRemoteControlEnvironmentId", "catalog.subscribe"], pairing: ['"2055603567"', "Qg:"], tabs: ["showControlOtherDevices:", "showRemoteSshConnections:"] };
  function byId(role, id) { return findUniqueRspackModuleCopies(assets, { description: "native outbound " + role,
    sourceMatch: text => needles[role].every(needle => text.includes(needle)), matchModule: (_body, copy) => copy.moduleId === id }); }
  for (const [role, id] of Object.entries(proof.imports)) cohort[role] = byId(role, id);
  const platform = scope.normalized(cohort.platform[0]);cohort.platformMap = byId("platformMap", platform.imports[2].moduleId);
  const plan = prepareOutboundTab(cohort);let markers = 0;
  for (const name of listWebviewAssetFiles(assets, /\.js$/u)) markers += fs.readFileSync(path.join(assets, name), "utf8").split(MARKER).length - 1;
  if (markers !== (plan.alreadyApplied ? plan.targetCopies : 0)) fail("orphan physical contribution");
  return plan;
}
function applyOutboundTab(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), plan = locateOutboundTab(assets);
  return { ...patchWebviewAssets(assets, plan.edits, options), matched: true, targetCopies: plan.targetCopies };
}
module.exports = { MARKER, prepareOutboundTabOwner, prepareOutboundTab, locateOutboundTab, applyOutboundTab };
