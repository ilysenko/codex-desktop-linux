"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const shapes = require("./feature-sync-shapes.js");
const { findMainProcessChunks, patchWebviewAssets: commitAssetEdits } = require("../../scripts/patches/lib/assets.js");
const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
const { inspectMainRequestSites, hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const { createJavaScriptLexicalIndex, findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxRemoteControlFeatureSyncEnabled";
const HELPER = `function ${MARKER}(e,t){return"linux"===process.platform&&"local"===t?{...e,remote_control:!0}:e}`;
const FIXED = new Set(("class constructor evaluations onChanged clearPrewarmedThreads logger connections stopWatchingPolicy stopWatchingConnections disposed nextGeneration dispose sync sendEnablement async await function return if for of let const var new this try catch throw instanceof typeof void null true false Map Object Array Promise Error process undefined").split(" "));
function fail(reason) { throw Error("Unsupported current Remote feature-sync contract: " + reason); }
function one(rows, reason) { if (rows.length !== 1) fail(reason);return rows[0]; }
function parses(source) { try { new Script(source);return true; } catch { return false; } }
function rootStatement(factory, at) {
  const prefix = factory.body.slice(0, at);
  return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1 && parses(`function featureSyncRoot(${factory.parameters.join(",")}){${prefix}\nconst __featureSyncRoot=0;}`);
}
function rootInitializer(factory, row) {
  const prefix = factory.body.slice(0, row.index);
  return findMatchingBrace("{" + prefix + "}", 0) === prefix.length + 1 && parses(`function featureSyncInitializer(${factory.parameters.join(",")}){${prefix}${row[0]};}`);
}
function normalized(source) {
  const lexical = createJavaScriptLexicalIndex(source), names = new Map();let output = "", cursor = 0;
  for (const token of source.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const at = token.index, name = token[0];
    if (!lexical.isCode(at) || FIXED.has(name) || source[at - 1] === "." || /^\s*:/u.test(source.slice(at + name.length))) continue;
    if (!names.has(name)) names.set(name, "$" + names.size);
    output += source.slice(cursor, at) + names.get(name);cursor = at + name.length;
  }
  output += source.slice(cursor);const code = createJavaScriptLexicalIndex(output);let text = "";
  for (let at = 0; at < output.length;) {
    if (code.isCode(at)) { text += output[at++];continue; }
    let end = at + 1;while (end < output.length && !code.isCode(end)) end++;
    const trivia = output.slice(at, end);
    if (!/^[ \t]+$/u.test(trivia)) text += trivia;
    else if (/[\w$]/u.test(output[at - 1] ?? "") && /[\w$]/u.test(output[end] ?? "") || /[+\-*/%&|^<>=!?~.]/u.test((output[at - 1] ?? "") + (output[end] ?? ""))) text += " ";
    at = end;
  }
  return { text, names };
}
function equivalent(actual, expected) {
  const a = normalized(actual), b = normalized(expected);
  if (a.text !== b.text) fail("changed complete native owner or constructor wiring");
  const inverse = new Map([...a.names].map(([name, canonical]) => [canonical, name]));
  return name => inverse.get(b.names.get(name));
}
function declared(factory, name, initializer) {
  if (factory.parameters.includes(name) || parses(`function featureSyncBinding(${factory.parameters.join(",")}){${factory.body}\n;let ${name};}`)) fail("captured or undeclared factory binding " + name);
  return { name, initializer };
}
function imported(factory, name) {
  const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(name)}=${escapeRegExp(factory.parameters[2])}\\((?<module>\\d+)\\)`, "gu");
  const found = one([...factory.body.matchAll(pattern)].filter(row => rootInitializer(factory, row)), "missing or ambiguous import " + name);
  return { ...declared(factory, name, found.index), moduleId: found.groups.module };
}
function stableRoles(factory, roles) {
  const index = createJavaScriptLexicalIndex(factory.body), byName = new Map();
  for (const role of roles) { if (byName.has(role.name)) fail("aliased authority bindings");byName.set(role.name, { ...role, candidate: false }); }
  const operator = /^(?:\+\+|--|(?:\?\?|\|\||&&|\*\*|<<|>>>|>>|[+*/%&|^\-])?=(?!=|>))/u;
  for (const token of factory.body.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu)) {
    const name = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, a, b) => String.fromCodePoint(parseInt(a || b, 16))), role = byName.get(name);
    if (!role || role.initializer === token.index || !index.isCode(token.index)) continue;
    const tail = factory.body.slice(token.index + token[0].length).replace(/^(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n\u2028\u2029]*(?:\r?\n|[\u2028\u2029]|$)))*/u, "");
    let before = token.index - 1;while (before >= 0 && (!index.isCode(before) || /\s/u.test(factory.body[before]))) before--;
    if (token[0].includes("\\u") || operator.test(tail) || ["++", "--"].includes(factory.body.slice(Math.max(0, before - 1), before + 1)) || ",}])".includes(tail[0] || " ")) role.candidate = true;
  }
  for (const role of byName.values()) if (role.candidate) {
    let projected = factory.body;
    if (role.initializer != null) {
      let fresh = "__featureSyncAllowedInitializer";while (projected.includes(fresh)) fresh += "$";
      projected = projected.slice(0, role.initializer) + fresh + projected.slice(role.initializer + role.name.length);
    }
    if (!hasStableEagerMainBinding(projected, role.name)) fail("eager authority write " + role.name);
  }
}
function inspectNative(source) {
  const graph = inspectMainRequestSites(source);if (!graph.ok) fail("missing unique live startup/owner graph");
  const factory = one(mainProcessFactories(source).filter(row => row.identity === graph.scope.factoryId), "ambiguous live main factory");
  if (factory.start !== graph.scope.factoryStart || factory.end !== graph.scope.factoryEnd) fail("stale main graph ranges");
  if (factory.parameters.includes("process") || !parses(source + "\n;let process;") || !parses(`function featureSyncGlobals(${factory.parameters.join(",")}){${factory.body}\n;let process,${MARKER};}`) || !hasStableEagerMainBinding(source, "process")) fail("helper captures the Node process global or existing own binding");
  const lexical = createJavaScriptLexicalIndex(factory.body);
  const head = one([...factory.body.matchAll(new RegExp(`\\bclass (?<name>${ID})\\{evaluations;onChanged;clearPrewarmedThreads;logger=`, "gu"))].filter(row => rootStatement(factory, row.index)), "missing or ambiguous current sync owner");
  const open = factory.body.indexOf("{", head.index), end = lexical.matchingBrace(open), owner = factory.body.slice(head.index, end + 1);
  if (end < open || Buffer.byteLength(owner) > 16 * 1024) fail("incomplete or unbounded sync owner");
  const declarations = [...factory.body.slice(Math.max(0, head.index - 1024), head.index).matchAll(new RegExp(`\\blet (${ID})=\\["apps_mcp_path_override","auth_elicitation","tool_suggest"\\]`, "gu"))];
  const pre = one(declarations, "missing native allowlist/schema prelude"), preStart = Math.max(0, head.index - 1024) + pre.index;
  if (!rootStatement(factory, preStart)) fail("allowlist/schema prelude is not root scoped");
  const rolesFor = equivalent(factory.body.slice(preStart, end + 1), shapes.prelude + shapes.owner), name = rolesFor("eSo");
  if (name !== head.groups.name) fail("wrong owner binding");
  const host = source.slice(graph.scope.hostStart, graph.scope.hostEnd);if (Buffer.byteLength(host) > 256 * 1024) fail("unbounded live main host");
  const hostIndex = createJavaScriptLexicalIndex(host), ctorHead = one([...host.matchAll(/\bconstructor\((?<params>[^{};]*?)\)\{/gu)].filter(row => hostIndex.isCode(row.index)), "missing live constructor");
  const ctorOpen = ctorHead.index + ctorHead[0].length - 1, ctorEnd = hostIndex.matchingBrace(ctorOpen), ctor = host.slice(ctorOpen + 1, ctorEnd), ctorIndex = createJavaScriptLexicalIndex(ctor);
  const wireHead = one([...ctor.matchAll(/this\.disposables\.add\(function\(\{connections:/gu)].filter(row => ctorIndex.isRoot(row.index)), "missing or ambiguous live sync construction");
  const wireEnd = ctor.indexOf(",this.habitatAutomationsService=", wireHead.index);
  // The native next field is not owned. A standalone synthetic fixture may
  // use a semicolon after the complete native expression instead.
  const standalone = ctor.indexOf(";", wireHead.index), stop = wireEnd >= 0 ? wireEnd : standalone;
  if (stop < wireHead.index || stop - wireHead.index > 4096) fail("unbounded live sync construction");
  const wire = ctor.slice(wireHead.index, stop), wireRoles = equivalent(wire, shapes.startup);
  if (wireRoles("eSo") !== name) fail("live constructor uses another sync owner");
  let prefix = ctor.slice(0, wireHead.index);if (prefix.endsWith(",")) prefix = prefix.slice(0, -1) + ";";
  if (!parses(`function featureSyncConstructor(${ctorHead.groups.params}){${prefix}\nconst __featureSyncConstruction=0;}`) || !parses(host.slice(0, ctorEnd) + `\n;let ${name};` + host.slice(ctorEnd)) || !hasStableEagerMainBinding(ctor, name)) fail("dead, nested or captured sync construction");
  for (const exit of [...ctor.matchAll(/\b(?:return|throw)\b/gu)].filter(row => ctorIndex.isRoot(row.index) && row.index < wireHead.index)) {
    let before = ctor.slice(0, exit.index);if (before.endsWith(",")) before = before.slice(0, -1) + ";";
    if (parses(host.slice(0, ctorOpen + 1) + before + "\nconst __featureSyncExitProbe=0;" + host.slice(ctorEnd))) fail("sync construction follows a root constructor exit");
  }
  const startupRoles = [name, wireRoles("sp"), wireRoles("VE")];
  if (!parses(host.slice(0, ctorEnd) + `\n;let ${startupRoles.join(",")};` + host.slice(ctorEnd)) || startupRoles.some(role => !hasStableEagerMainBinding(ctor, role))) fail("captured or written native startup role");
  const moduleRoles = [{ name: "process", initializer: null }, declared(factory, name, null), ...["ed", "ei", "t4", "t8", "eM"].map(role => imported(factory, rolesFor(role))), imported(factory, wireRoles("sp"))];
  for (const role of ["eSs", "eSa"]) { const binding = rolesFor(role), at = factory.body.indexOf(binding + "=", preStart);if (at < preStart || at >= head.index) fail("missing native prelude binding");moduleRoles.push(declared(factory, binding, at)); }
  const getter = rolesFor("t5"), getterPattern = new RegExp(`(?<![\\w$.])${escapeRegExp(getter)}=${escapeRegExp(factory.parameters[2])}\\.n\\((?<provider>${ID})\\)`, "gu"), get = one([...factory.body.matchAll(getterPattern)].filter(row => rootInitializer(factory, row)), "missing native ready-assignment equality getter");
  moduleRoles.push(declared(factory, getter, get.index), imported(factory, get.groups.provider));
  const clear = wireRoles("VE"), clearDeclaration = one([...factory.body.matchAll(new RegExp(`(?:async )?function ${escapeRegExp(clear)}\\(`, "gu"))].filter(row => rootStatement(factory, row.index)), "missing native prewarm cleanup helper");
  if (!clearDeclaration) fail("missing prewarm helper");moduleRoles.push(declared(factory, clear, null));stableRoles(factory, moduleRoles);
  const calls = [...owner.matchAll(new RegExp(`(?<record>${ID})\\.connection\\.sendAppServerRequest\\("experimentalFeature/enablement/set",\\{enablement:(?<enablement>${ID})\\},(?<guard>${ID})\\)`, "gu"))].filter(row => createJavaScriptLexicalIndex(owner).isCode(row.index));
  const call = one(calls, "missing unique native sync request");
  return { factory, graph, owner, ownerStart: factory.start + head.index, call: { ...call.groups, start: factory.start + head.index + call.index, source: call[0] }, ownerName: name };
}
function decode(source) {
  if (!source.includes(MARKER)) return { state: "current", nativeSource: source };
  if (source.split(MARKER).length !== 3 || source.split(HELPER).length !== 2) fail("partial, duplicated or modified own helper");
  const without = source.replace(HELPER, ""), pattern = new RegExp(`(?<record>${ID})\\.connection\\.sendAppServerRequest\\("experimentalFeature/enablement/set",\\{enablement:${MARKER}\\((?<enablement>${ID}),\\k<record>\\.connection\\.hostId\\)\\},(?<guard>${ID})\\)`, "gu"), call = one([...without.matchAll(pattern)], "partial own sync request");
  const nativeCall = `${call.groups.record}.connection.sendAppServerRequest("experimentalFeature/enablement/set",{enablement:${call.groups.enablement}},${call.groups.guard})`, nativeSource = without.slice(0, call.index) + nativeCall + without.slice(call.index + call[0].length);
  if (nativeSource.includes(MARKER)) fail("orphan own marker");return { state: "patched", nativeSource };
}
function prepareFeatureSyncSource(source) {
  if (typeof source !== "string" || !parses(source)) fail("main source does not parse");
  const decoded = decode(source), native = inspectNative(decoded.nativeSource), call = native.call;
  const replacement = `${call.record}.connection.sendAppServerRequest("experimentalFeature/enablement/set",{enablement:${MARKER}(${call.enablement},${call.record}.connection.hostId)},${call.guard})`;
  const patchedSource = decoded.nativeSource.slice(0, native.ownerStart) + HELPER + decoded.nativeSource.slice(native.ownerStart, call.start) + replacement + decoded.nativeSource.slice(call.start + call.source.length);
  if (!parses(patchedSource) || decoded.state === "patched" && patchedSource !== source) fail("noncanonical native inverse/replay or helper placement");
  return Object.freeze({ state: decoded.state, nativeSource: decoded.nativeSource, patchedSource, proof: Object.freeze({ factoryId: native.factory.identity, owner: native.ownerName, ownerStart: native.ownerStart, ownerBytes: Buffer.byteLength(native.owner), callStart: call.start, nativeCall: call.source, hostStart: native.graph.scope.hostStart, hostEnd: native.graph.scope.hostEnd }) });
}
function applyFeatureSyncToExtractedApp(extractedDir, options = {}) {
  const inventory = findMainProcessChunks(extractedDir);if (!inventory) fail("missing main inventory");
  const rows = inventory.chunks.map(assetName => ({ assetName, source: fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8") }));
  const candidate = one(rows.filter(row => row.source.includes("app-server-feature-enablement") || row.source.includes(MARKER)), "missing or ambiguous sync carrier"), prepared = prepareFeatureSyncSource(candidate.source);
  const physical = rows.filter(row => mainProcessFactories(row.source).some(factory => factory.identity === prepared.proof.factoryId));
  if (physical.length !== 1 || physical[0] !== candidate) fail("duplicate or damaged live factory cohort");
  if (prepared.state === "patched") return { matched: 1, changed: 0, changedAssets: [] };
  return { matched: 1, ...commitAssetEdits(inventory.buildDir, [{ assetName: candidate.assetName, source: candidate.source, patchedSource: prepared.patchedSource }], options) };
}
module.exports = { prepareFeatureSyncSource, applyFeatureSyncToExtractedApp, HELPER };
