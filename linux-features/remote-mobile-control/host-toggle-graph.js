"use strict";
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const ID = "[A-Za-z_$][\\w$]*";
function fail(reason) { throw Error(`Remote host-toggle graph: ${reason}`); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }
function view(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 ||
      new Set(copy.params).size !== 3 || Buffer.byteLength(copy.moduleSource ?? "") > 16 * 1024) fail("bounded module snapshot");
  if (copy.params.some(name => ["Promise", "Error", "Symbol", "queueMicrotask", "AbortController"].includes(name))) {
    fail("captured native provider intrinsic");
  }
  new Script(`function currentRemoteProvider(${copy.params.join(",")}){${copy.moduleSource}\n}`);
  return createJavaScriptLexicalIndex(copy.moduleSource);
}
function imported(copy, name) {
  const result = findRspackRequireBinding({ ...copy, start: copy.start ?? 0 }, name);
  if (!result || result.requireName !== copy.params[2]) fail("non-native import " + name);
  return result;
}
function codeMatches(body, expression) {
  const lexical = createJavaScriptLexicalIndex(body);
  return [...body.matchAll(expression)].filter(match => lexical.isCode(match.index));
}
function publication(copy, key) {
  view(copy);
  const result = findRspackExportPublication(copy, key);
  if (!result) fail("missing native provider publication " + key);
  return result;
}

// The provider itself is not changed. Qualify the native same-host entry and
// its existing manager/client/cached-client branches, retaining the proxy ABI
// and lifecycle implementation as an upstream dependency.
function inspectSelectedHostClient(copy, exportName) {
  const pub = publication(copy, exportName);
  if (!pub.fn) fail("client getter is not the native inline function");
  const args = pub.fn.params.split(",");
  if (args.length !== 2 || new Set(args).size !== 2 || args.some(x => !new RegExp(`^${ID}$`, "u").test(x))) fail("client getter arguments");
  const [store, host] = args, S = escapeRegExp(store), H = escapeRegExp(host), body = pub.fn.body;
  const prefix = new RegExp(
    String.raw`^let (?<bag>${ID})=\{stack:\[\],error:void 0,hasError:!1\};try\{let (?<dispose>${ID}),(?<state>${ID})=${S}\.get\((?<connections>${ID})\.(?<stateKey>${ID}),${H}\),(?<manager>${ID})=${S}\.get\((?<managerAtom>${ID})\);` +
    String.raw`if\(null!=\k<manager>&&"disconnected"!==\k<state>\.status&&\("unavailable"!==\k<state>\.status\|\|!${S}\.get\((?<hosts>${ID})\.(?<hostsKey>${ID})\)\.includes\(${H}\)\)\)try\{return \k<manager>\.forHost\(${H}\)\}catch\{\}` +
    String.raw`let\{client:(?<client>${ID})\}=\k<state>;if\(null!=\k<client>\)return \k<client>\.rpc;let (?<cached>${ID})=${S}\.get\((?<cacheAtom>${ID}),${H}\);if\(null!=\k<cached>\)return \k<cached>;`, "u");
  const match = prefix.exec(body);
  if (!match) fail("changed same-host client selection entry");
  const r = match.groups;
  imported(copy, r.connections); imported(copy, r.hosts);
  if ([r.connections, r.hosts].some(name => args.includes(name))) fail("captured client provider");
  const hostSelections = codeMatches(body, /\.forHost\(([^)]*)\)/gu);
  if (hostSelections.length !== 1 || hostSelections[0][1] !== host) fail("wrong selected host");
  const watched = new RegExp(String.raw`${S}\.watch\(\(\{get:(?<get>${ID})\}\)=>\{let (?<state>${ID})=\k<get>\(${escapeRegExp(r.connections)}\.${escapeRegExp(r.stateKey)},${H}\),(?<manager>${ID})=\k<get>\(${escapeRegExp(r.managerAtom)}\),(?<available>${ID})=\k<get>\(${escapeRegExp(r.hosts)}\.${escapeRegExp(r.hostsKey)}\)\.includes\(${H}\);`, "gu");
  const watch = one(codeMatches(body, watched), "missing same-host deferred-client watch");
  if ([watch.groups.get, watch.groups.state, watch.groups.manager, watch.groups.available].includes(host)) fail("captured watched host");
  if (!body.includes('"request-only"') || !body.includes("[Symbol.dispose]()") || !body.includes(".onRpcBroken(")) fail("missing native deferred-client ABI");
  return Object.freeze({ moduleId: copy.moduleId, exportName, store, host,
    connectionSource: Object.freeze(imported(copy, r.connections)),
    hostListSource: Object.freeze(imported(copy, r.hosts)),
    boundary: "Native manager, proxy, request-only and disposal implementations are retained; this is not a recursive vendor or runtime-immutability proof." });
}

function inspectHostStatusPublication(copy, atomKey, writeKey) {
  const lexical = view(copy), atom = publication(copy, atomKey), write = publication(copy, writeKey);
  if (!new RegExp(`^${ID}$`, "u").test(atom.expression ?? "") ||
      !new RegExp(`^${ID}$`, "u").test(write.expression ?? "")) fail("status atom/mapper publication");
  const name = write.expression, atomName = atom.expression;
  const header = new RegExp(String.raw`function ${escapeRegExp(name)}\((?<store>${ID}),(?<host>${ID}),(?<value>${ID})\)\{`, "gu");
  const head = one([...copy.moduleSource.matchAll(header)].filter(x => lexical.isRoot(x.index)), "status mapper declaration");
  const open = head.index + head[0].length - 1, end = lexical.matchingBrace(open), r = head.groups;
  if (new Set(Object.values(r)).size !== 3 || Object.values(r).includes(atomName)) fail("captured status atom");
  const expected = new RegExp(String.raw`^${escapeRegExp(r.value)}\?\.status==="connected"&&${escapeRegExp(r.store)}\.set\((?<override>${ID}),${escapeRegExp(r.host)},!1\),${escapeRegExp(r.store)}\.set\(${escapeRegExp(atomName)},${escapeRegExp(r.host)},${escapeRegExp(r.value)}\)$`, "u");
  const body = copy.moduleSource.slice(open + 1, end), mapper = expected.exec(body);
  if (!mapper || Object.values(r).includes(mapper.groups.override)) fail("changed same-host status mapper");
  const atomDecl = new RegExp(String.raw`(?:let|const|var) ${escapeRegExp(atomName)}=\(0,(?<factory>${ID})\.(?<create>${ID})\)\((?<scope>${ID})\.(?<scopeKey>${ID}),(?<host>${ID})=>null\)`, "gu");
  const declaration = one([...copy.moduleSource.matchAll(atomDecl)].filter(x => lexical.isRoot(x.index)), "host-keyed native status atom");
  imported(copy, declaration.groups.factory); imported(copy, declaration.groups.scope);
  return Object.freeze({ moduleId: copy.moduleId, atomExport: atomKey, writeExport: writeKey,
    atom: atomName, mapper: name, overrideAtom: mapper.groups.override,
    boundary: "The existing host-keyed atom and native mapper are dependencies; no catalog state, cancellation API or new policy is supplied." });
}

// Native UIre has a distinct local Desktop-service branch. Only its per-host
// fallback delegates to this request adapter; both branches remain unchanged.
function inspectHostToggleCaller(copy, targetId, targetKey, statusId) {
  view(copy);
  const body = copy.moduleSource, L = escapeRegExp(copy.params[2]), E = escapeRegExp(copy.params[1]);
  const starts = new RegExp(String.raw`^var (?<target>${ID})=${L}\("(?<targetId>[^"\\]+)"\),(?<status>${ID})=${L}\("(?<statusId>[^"\\]+)"\),(?<facade>${ID})=${L}\("[^"\\]+"\),(?<local>${ID})=${L}\("[^"\\]+"\),(?<refresh>${ID})=${L}\("[^"\\]+"\);async function (?<helper>${ID})\((?<store>${ID}),(?<host>${ID}),(?<enabled>${ID})\)\{let (?<service>${ID})=\k<facade>\.appServices\.remoteControlEnvironments;return null!=\k<service>&&\k<host>===\k<local>\.(?<localKey>${ID})\?\(await \k<service>\.setLocalEnabled\(\{enabled:\k<enabled>\}\),\(0,\k<refresh>\.(?<refreshKey>${ID})\)\(\k<store>,\k<enabled>,\{force:!0\}\)\):\(0,\k<target>\.(?<targetKey>${ID})\)\(\k<store>,\k<host>,\k<enabled>\)\}`, "u");
  const match = starts.exec(body);
  if (!match || match.groups.targetId !== targetId || match.groups.statusId !== statusId || match.groups.targetKey !== targetKey) fail("wrong native toggle caller fallback");
  const r = match.groups, rootNames = [r.target, r.status, r.facade, r.local, r.refresh];
  const helperProviders = [r.target, r.facade, r.local, r.refresh];
  if (new Set(rootNames).size !== rootNames.length || rootNames.includes(r.helper) || copy.params.includes(r.helper) ||
      helperProviders.some(x => [r.store, r.host, r.enabled, r.service].includes(x))) fail("captured native toggle caller");
  for (const name of rootNames) imported(copy, name);
  const tail = body.slice(match[0].length);
  const publication = new RegExp(String.raw`^${L}\.d\(${E},\{\},\{(?<key>${ID}):async function\((?<store>${ID}),(?<host>${ID}),(?<enabled>${ID})\)\{if\(!\k<enabled>\)return ${escapeRegExp(r.helper)}\(\k<store>,\k<host>,!1\);\(0,${escapeRegExp(r.status)}\.(?<overrideKey>${ID})\)\(\k<store>,\k<host>,!1\);let (?<waiter>${ID})=\(0,${escapeRegExp(r.status)}\.(?<waitKey>${ID})\)\(\k<store>,\k<host>,\{ignoreCurrentError:!0\}\);try\{let (?<request>${ID})=${escapeRegExp(r.helper)}\(\k<store>,\k<host>,!0\);return await Promise\.race\(\[\k<waiter>,\k<request>\.then\(\(\)=>\k<waiter>\)\]\)\}catch\((?<error>${ID})\)\{throw\(0,${escapeRegExp(r.status)}\.\k<overrideKey>\)\(\k<store>,\k<host>,!0\),\k<error>\}\}\}\)$`, "u").exec(tail);
  if (!publication) fail("changed native toggle caller request/wait lifetime");
  const p = publication.groups;
  // The native helper's local service shadows the status namespace, while the
  // public function's waiter shadows the fallback namespace. Neither namespace
  // is used in that respective scope. Check the actual providers used there.
  if ([r.helper, r.status, "Promise"].some(x =>
    [p.store, p.host, p.enabled, p.waiter, p.request, p.error].includes(x))) fail("captured native caller provider");
  return Object.freeze({ moduleId: copy.moduleId, exportName: p.key,
    target: Object.freeze(imported(copy, r.target)), status: Object.freeze(imported(copy, r.status)),
    targetExport: targetKey, waitExport: p.waitKey, overrideExport: p.overrideKey,
    boundary: "Local appServices path, native per-host enable/wait race and error propagation are retained; no selected-host global or cancellation signal is added." });
}

module.exports = { inspectSelectedHostClient, inspectHostStatusPublication, inspectHostToggleCaller };
