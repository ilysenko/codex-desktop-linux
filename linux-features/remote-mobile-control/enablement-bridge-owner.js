"use strict";
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxRemoteControlEnablementBridge";
const LINUX = `||/*${MARKER}*/typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)`;
function fail(reason) { throw Error(`Remote enablement bridge: ${reason}`); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }
function grammar() {
  return new RegExp(String.raw`^function (?<name>${ID})\(\)\{let (?<a>${ID}),(?<b>${ID}),(?<effect>${ID}),(?<deps>${ID}),(?<memo>${ID})=\(0,(?<compiler>${ID})\.c\)\(10\),\{checkGate:(?<gate>${ID}),isLoading:(?<loading>${ID})\}=\(0,(?<hook>${ID})\.cn\)\(\);` +
    String.raw`\k<memo>\[0\]!==\k<gate>\?\(\k<a>=\k<gate>\((?<pairing>${ID})\.(?<pairingKey>${ID})\),\k<memo>\[0\]=\k<gate>,\k<memo>\[1\]=\k<a>\):\k<a>=\k<memo>\[1\];let (?<oneToOne>${ID})=\k<a>;` +
    String.raw`\k<memo>\[2\]!==\k<gate>\|\|\k<memo>\[3\]!==\k<oneToOne>\?\(\k<b>=\k<gate>\("1042620455"\)\|\|\k<oneToOne>,\k<memo>\[2\]=\k<gate>,\k<memo>\[3\]=\k<oneToOne>,\k<memo>\[4\]=\k<b>\):\k<b>=\k<memo>\[4\];let (?<enabled>${ID})=\k<b>(?<linux>${escapeRegExp(LINUX)})?;return ` +
    String.raw`\k<memo>\[5\]!==\k<loading>\|\|\k<memo>\[6\]!==\k<oneToOne>\|\|\k<memo>\[7\]!==\k<enabled>\?\(\k<effect>=\(\)=>\{let (?<service>${ID})=(?<facade>${ID})\.appServices\.remoteConnections;\k<loading>\|\|null==\k<service>\|\|\k<service>\.setRemoteControlEnabled\(\{enabled:\k<enabled>,oneToOnePairingInAppEnabled:\k<oneToOne>\}\)\.catch\((?<error>${ID})=>\{(?<logger>${ID})\.v\.warning\("\[remote-connections/gate-bridge\] sync_failed",\{safe:\{remoteControlConnectionsEnabled:\k<enabled>\},sensitive:\{error:\k<error>\}\}\)\}\)\},\k<deps>=\[\k<loading>,\k<oneToOne>,\k<enabled>\],\k<memo>\[5\]=\k<loading>,\k<memo>\[6\]=\k<oneToOne>,\k<memo>\[7\]=\k<enabled>,\k<memo>\[8\]=\k<effect>,\k<memo>\[9\]=\k<deps>\):\(\k<effect>=\k<memo>\[8\],\k<deps>=\k<memo>\[9\]\),\(0,(?<react>${ID})\.useEffect\)\(\k<effect>,\k<deps>\),null\}$`, "u");
}
function rootFunctions(copy) {
  const body = copy.moduleSource, lexical = createJavaScriptLexicalIndex(body), rows = [];
  for (const match of body.matchAll(new RegExp(String.raw`function (?<name>${ID})\((?<params>[^()]*)\)\{`, "gu"))) {
    if (!lexical.isRoot(match.index)) continue;
    const open = match.index + match[0].length - 1, end = lexical.matchingBrace(open);
    if (end <= open) fail("incomplete root function");
    rows.push({ name: match.groups.name, params: match.groups.params, start: match.index, end: end + 1, source: body.slice(match.index, end + 1) });
  }
  return { rows, lexical };
}
// The shared EAGER checker rejects initializers too. Remove only an independently
// certified native initializer before asking whether another eager write exists.
function stableAfterInitializer(copy, name, start, end) {
  const body = copy.moduleSource.slice(0, start) + name + copy.moduleSource.slice(end);
  return hasStableEagerMainBinding(body, name);
}
function nativeImport(copy, name) {
  const binding = findRspackRequireBinding(copy, name);
  if (!binding || binding.requireName !== copy.params[2] ||
      !stableAfterInitializer(copy, name, binding.start - copy.start, binding.end - copy.start)) fail("missing or eagerly reassigned native factory import " + name);
  return Object.freeze(binding);
}
function rootOwns(copy, name) {
  if (copy.params.includes(name)) return true;
  try { new Script(`function nativeBridgeFactory(${copy.params.join(",")}){${copy.moduleSource}\n;let ${name};}`); return false; }
  catch { return true; }
}
function inspectBridgeOwner(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 || new Set(copy.params).size !== 3) fail("native factory snapshot");
  const { rows, lexical } = rootFunctions(copy);
  const owner = one(rows.filter(row => row.source.includes("[remote-connections/gate-bridge] sync_failed")), "unique root bridge owner");
  if (Buffer.byteLength(owner.source) > 2048) fail("bounded native bridge owner");
  const match = grammar().exec(owner.source);
  if (!match) fail("changed complete bridge hook/cache/effect grammar");
  const r = match.groups;
  if (copy.moduleSource.split(MARKER).length - 1 !== (r.linux ? 1 : 0)) fail("orphan bridge contribution");
  const locals = [r.a, r.b, r.effect, r.deps, r.memo, r.gate, r.loading, r.oneToOne, r.enabled];
  const providers = [r.compiler, r.hook, r.pairing, r.facade, r.logger, r.react];
  if (locals.includes(r.name) || providers.includes(r.name) || copy.params.includes(r.name) ||
      new Set(locals).size !== locals.length || new Set(providers).size !== providers.length ||
      providers.some(name => locals.includes(name) || copy.params.includes(name)) ||
      [r.facade, r.logger, r.enabled, r.loading, r.oneToOne].includes(r.service) ||
      [r.logger, r.enabled].includes(r.error) || rows.some(row => providers.includes(row.name))) fail("captured bridge provider");
  if (r.linux && rootOwns(copy, "navigator")) fail("captured Linux browser intrinsic");
  const imports = Object.fromEntries(["compiler", "hook", "pairing", "facade", "logger", "react"].map(role => [role, nativeImport(copy, r[role])]));
  if (imports.hook.moduleId === imports.facade.moduleId || imports.pairing.moduleId === imports.facade.moduleId ||
      !hasStableEagerMainBinding(copy.moduleSource, r.name)) fail("unstable bridge owner identity");
  const callPattern = new RegExp(String.raw`\(0,(?<jsx>${ID})\.jsx\)\(${escapeRegExp(r.name)},\{\}\)`, "gu");
  const calls = [...copy.moduleSource.matchAll(callPattern)].filter(row => lexical.isCode(row.index));
  const call = one(calls, "live native bridge component use");
  const caller = one(rows.filter(row => row.start < call.index && call.index < row.end), "root bridge component caller");
  if (Buffer.byteLength(caller.source) > 1024) fail("bounded bridge component caller");
  const parentPattern = new RegExp(String.raw`^function (?<name>${ID})\(\)\{let (?<result>${ID}),(?<memo>${ID})=\(0,${escapeRegExp(r.compiler)}\.c\)\(1\);return\(0,(?<mobile>${ID})\.(?<mobileKey>${ID})\)\(\)\?null:\(\k<memo>\[0\]===Symbol\.for\("react.memo_cache_sentinel"\)\?\(\k<result>=\(0,${escapeRegExp(call.groups.jsx)}\.jsx\)\(${escapeRegExp(r.name)},\{\}\),\k<memo>\[0\]=\k<result>\):\k<result>=\k<memo>\[0\],\k<result>\)\}$`, "u");
  const parent = parentPattern.exec(caller.source);
  if (!parent || [r.name, r.compiler, call.groups.jsx, "Symbol", parent?.groups.mobile].some(name => [parent?.groups.result, parent?.groups.memo].includes(name)) ||
      copy.params.includes(caller.name) || !hasStableEagerMainBinding(copy.moduleSource, caller.name)) fail("changed native bridge component parent");
  if (rows.some(row => [call.groups.jsx, parent.groups.mobile].includes(row.name))) fail("root function captures native component provider");
  const jsx = nativeImport(copy, call.groups.jsx), mobile = nativeImport(copy, parent.groups.mobile);
  const renderPattern = new RegExp(String.raw`(?<slot>${ID})=\(0,${escapeRegExp(call.groups.jsx)}\.jsx\)\(${escapeRegExp(call.groups.jsx)}\.Fragment,\{children:\(0,${escapeRegExp(call.groups.jsx)}\.jsx\)\(${escapeRegExp(caller.name)},\{\}\)\}\)`, "gu");
  const renderCall = one([...copy.moduleSource.matchAll(renderPattern)].filter(row => lexical.isCode(row.index)), "native root render-tree bridge slot");
  const render = one(rows.filter(row => row.start < renderCall.index && renderCall.index < row.end), "native render-tree function");
  if (Buffer.byteLength(render.source) > 16 * 1024 || !hasStableEagerMainBinding(copy.moduleSource, render.name)) fail("bounded native render-tree owner");
  for (const name of [owner.name, caller.name, render.name]) {
    if (copy.params.includes(name) || rows.filter(row => row.name === name).length !== 1) fail("duplicate or captured native owner/caller/render binding " + name);
  }
  const renderBody = render.source.slice(render.source.indexOf("{") + 1, -1);
  for (const name of [caller.name, call.groups.jsx]) {
    try { new Script(`function nativeRemoteRender(${render.params}){${renderBody}\n;let ${name};}`); }
    catch { fail("captured native render-tree provider " + name); }
  }
  return Object.freeze({ owner: Object.freeze(owner), caller: Object.freeze(caller), render: Object.freeze(render), state: r.linux ? "patched" : "pristine", roles: Object.freeze(r), imports: Object.freeze(imports), jsx, mobile,
    boundary: "Complete bounded hook/effect and direct native component caller; native React/compiler/vendor and full application bootstrap remain dependencies, not recursively executed or re-proved." });
}
function inspectPairingGate(copy, exportName) {
  const pub = findRspackExportPublication(copy, exportName), lexical = createJavaScriptLexicalIndex(copy.moduleSource);
  if (!pub?.expression || !new RegExp(`^${ID}$`, "u").test(pub.expression)) fail("pairing gate publication");
  const declaration = new RegExp(String.raw`(?<![\w$.])${escapeRegExp(pub.expression)}="2055603567"(?=[,;])`, "gu");
  const literal = one([...copy.moduleSource.matchAll(declaration)].filter(row => lexical.isRoot(row.index)), "native one-to-one gate literal");
  if (!stableAfterInitializer(copy, pub.expression, literal.index, literal.index + literal[0].length)) fail("mutable one-to-one gate binding");
  return Object.freeze({ moduleId: copy.moduleId, exportName, gate: "2055603567", boundary: "Native MFA/pairing implementation is retained as a read-only dependency." });
}
function prepareBridgeOwner(copy) {
  const proof = inspectBridgeOwner(copy), { owner, roles } = proof;
  const nativeOwner = proof.state === "patched" ? owner.source.replace(LINUX, "") : owner.source;
  const needle = `let ${roles.enabled}=${roles.b};return `;
  if (nativeOwner.split(needle).length !== 2) fail("unique enabled scalar");
  const patchedOwner = nativeOwner.replace(needle, `let ${roles.enabled}=${roles.b}${LINUX};return `);
  const nativeSource = copy.moduleSource.slice(0, owner.start) + nativeOwner + copy.moduleSource.slice(owner.end);
  const patchedSource = copy.moduleSource.slice(0, owner.start) + patchedOwner + copy.moduleSource.slice(owner.end);
  const nativeProof = inspectBridgeOwner({ ...copy, moduleSource: nativeSource });
  const replay = inspectBridgeOwner({ ...copy, moduleSource: patchedSource });
  if (nativeProof.state !== "pristine" || replay.state !== "patched" || proof.state === "patched" && patchedSource !== copy.moduleSource) fail("canonical native inverse/replay");
  return Object.freeze({ proof: nativeProof, state: proof.state, nativeSource, patchedSource });
}
function inspectNativeGateHook(copy, exportName) {
  const publication = findRspackExportPublication(copy, exportName), context = findRspackExportPublication(copy, "j3");
  if (!publication?.expression || !context?.expression) fail("native Statsig hook/context publication");
  const { rows, lexical } = rootFunctions(copy), hook = one(rows.filter(row => row.name === publication.expression), "native gate hook declaration");
  const match = new RegExp(String.raw`^function ${escapeRegExp(hook.name)}\(\)\{return (?<context>${ID})\(\),\(0,(?<statsig>${ID})\.useStatsigClient\)\(\)\}$`, "u").exec(hook.source);
  if (!match || !hasStableEagerMainBinding(copy.moduleSource, hook.name)) fail("changed native Statsig hook result");
  const r = match.groups, reader = one(rows.filter(row => row.name === r.context), "native hook context reader");
  const read = new RegExp(String.raw`^function ${escapeRegExp(reader.name)}\((?<unused>${ID})\)\{\(0,(?<react>${ID})\.useContext\)\(${escapeRegExp(context.expression)}\)\}$`, "u").exec(reader.source);
  if (!read || [read.groups.react, context.expression].includes(read.groups.unused) ||
      !hasStableEagerMainBinding(copy.moduleSource, reader.name)) fail("changed native Statsig context read");
  const declaration = new RegExp(String.raw`let ${escapeRegExp(context.expression)}=\(0,${escapeRegExp(read.groups.react)}\.createContext\)\(!1\);`, "gu");
  const created = one([...copy.moduleSource.matchAll(declaration)].filter(row => lexical.isRoot(row.index)), "native gate context creation");
  const initializerStart = created.index + "let ".length, initializerEnd = created.index + created[0].length - 1;
  if (rows.some(row => [r.statsig, read.groups.react].includes(row.name)) ||
      !stableAfterInitializer(copy, context.expression, initializerStart, initializerEnd)) fail("captured native gate context/provider");
  return Object.freeze({ moduleId: copy.moduleId, exportName,
    statsig: nativeImport(copy, r.statsig), react: nativeImport(copy, read.groups.react),
    boundary: "Bounded native context+Statsig result interface; React and Statsig vendor behavior remain native dependencies." });
}
module.exports = { MARKER, LINUX, inspectBridgeOwner, inspectPairingGate, inspectNativeGateHook, prepareBridgeOwner };
