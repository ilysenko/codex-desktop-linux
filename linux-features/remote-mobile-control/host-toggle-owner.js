"use strict";

// This is the current, bounded per-host request adapter. It is separate from
// catalog.remoteControlState and from the Desktop outbound-enable service.
const { Script } = require("node:vm");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxRemoteControlEnableForHostParams";
const MAX_FACTORY_BYTES = 16 * 1024;

function unsupported(reason) { return { ok: false, reason }; }
function fail(reason) { throw new Error(`Unsupported current Remote host toggle: ${reason}`); }

// Complete grammar, rather than a nearby sendRequest substring. Captures are
// roles: the same store, host and selected client must reach both request and
// status publication. No whitespace normalisation changes literal data or ASI.
function grammar(loader, exportsName) {
  const L = escapeRegExp(loader), E = escapeRegExp(exportsName);
  return new RegExp(
    String.raw`^var (?<client>${IDENT})=${L}\("(?<clientId>[^"\\]+)"\),(?<status>${IDENT})=${L}\("(?<statusId>[^"\\]+)"\);${L}\.d\(${E},\{\},\{(?<key>${IDENT}):async function\((?<store>${IDENT}),(?<host>${IDENT}),(?<enabled>${IDENT}),\{shouldApplyStatus:(?<current>${IDENT})=\(\)=>!0\}=\{\}\)\{` +
    String.raw`let (?<initial>${IDENT})=\k<store>\.get\(\k<status>\.(?<atomKey>${IDENT}),\k<host>\),(?<reply>${IDENT})=await \(0,\k<client>\.(?<clientKey>${IDENT})\)\(\k<store>,\k<host>\)\.sendRequest\(\k<enabled>\?"remoteControl/enable":"remoteControl/disable",(?<params>null|void 0/\*${MARKER}\*/)\),(?<latest>${IDENT})=\k<store>\.get\(\k<status>\.\k<atomKey>,\k<host>\),(?<raced>${IDENT})=\k<latest>!==\k<initial>&&\(\k<latest>\?\.status==="connected"\|\|\k<latest>\?\.status==="errored"\);` +
    String.raw`return!\k<current>\(\)\|\|\k<enabled>&&\k<raced>\|\|\(0,\k<status>\.(?<writeKey>${IDENT})\)\(\k<store>,\k<host>,\k<reply>\),\k<reply>\}\}\)$`,
    "du",
  );
}

function inspectHostToggle(module) {
  try {
    if (typeof module?.moduleSource !== "string" || !Array.isArray(module.params) ||
        module.params.length !== 3 || new Set(module.params).size !== 3 ||
        module.params.some(name => !new RegExp(`^${IDENT}$`, "u").test(name))) {
      return unsupported("expected a three-parameter current Rspack snapshot");
    }
    const source = module.moduleSource;
    if (Buffer.byteLength(source) > MAX_FACTORY_BYTES) return unsupported("factory size limit");
    new Script(`function currentRemoteHostToggle(${module.params.join(",")}){${source}\n}`);
    const match = grammar(module.params[2], module.params[1]).exec(source);
    if (!match) return unsupported("missing complete host/client/status request grammar");
    const r = match.groups;
    const locals = [r.store, r.host, r.enabled, r.current, r.initial, r.reply, r.latest, r.raced];
    if (new Set(locals).size !== locals.length || r.client === r.status ||
        [r.client, r.status].some(name => locals.includes(name) || module.params.includes(name))) {
      return unsupported("provider or per-host role is shadowed");
    }
    for (const [name, id] of [[r.client, r.clientId], [r.status, r.statusId]]) {
      const imported = findRspackRequireBinding(module, name);
      if (!imported || imported.requireName !== module.params[2] || imported.moduleId !== id) {
        return unsupported("request provider is not the native factory import");
      }
    }
    const state = r.params === "null" ? "pristine" : "patched";
    const expectedMarkers = state === "pristine" ? 0 : 1;
    if (source.split(MARKER).length - 1 !== expectedMarkers) return unsupported("orphan parameter marker");
    return { ok: true, state, moduleId: module.moduleId ?? null,
      publication: { requireName: module.params[2], exportsName: module.params[1], exportName: r.key },
      client: { namespace: r.client, moduleId: r.clientId, exportName: r.clientKey },
      status: { namespace: r.status, moduleId: r.statusId, atomExport: r.atomKey, writeExport: r.writeKey },
      arguments: { store: r.store, host: r.host, enabled: r.enabled, isCurrent: r.current },
      response: { initial: r.initial, reply: r.reply, latest: r.latest, raced: r.raced },
      paramsRange: { start: match.indices.groups.params[0], end: match.indices.groups.params[1] },
    };
  } catch (error) { return unsupported(error.message); }
}

function replaceParams(source, range, value) {
  return source.slice(0, range.start) + value + source.slice(range.end);
}

function prepareHostToggle(source, snapshot) {
  if (source !== snapshot?.moduleSource) fail("stale snapshot");
  const proof = inspectHostToggle(snapshot);
  if (!proof.ok) fail(proof.reason);
  const nativeSource = proof.state === "pristine" ? source : replaceParams(source, proof.paramsRange, "null");
  const native = inspectHostToggle({ ...snapshot, moduleSource: nativeSource });
  if (!native.ok || native.state !== "pristine") fail("native inverse is not qualified");
  const patchedSource = replaceParams(nativeSource, native.paramsRange, `void 0/*${MARKER}*/`);
  const repeated = inspectHostToggle({ ...snapshot, moduleSource: patchedSource });
  if (!repeated.ok || repeated.state !== "patched" ||
      proof.state === "patched" && patchedSource !== source) fail("noncanonical parameter contribution");
  for (const key of ["publication", "client", "status", "arguments", "response", "paramsRange"]) {
    Object.freeze(native[key]);
  }
  return Object.freeze({ state: proof.state, nativeSource, patchedSource, proof: Object.freeze(native) });
}

module.exports = { MARKER, MAX_FACTORY_BYTES, inspectHostToggle, prepareHostToggle };
