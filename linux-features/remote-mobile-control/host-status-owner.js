"use strict";
const { Script } = require("node:vm");
const shapes = require("./host-status-shapes.js");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const FIXED = new Set(["async", "await", "for", "of", "in", "var", "let", "const", "function", "return", "if", "else", "new", "typeof", "void", "null", "true", "false", "class", "extends", "super", "constructor", "this", "switch", "case", "default", "break", "throw", "instanceof", "try", "catch", "finally", "Error", "Promise", "AbortController", "Symbol", "setTimeout", "clearTimeout", "Object", "Array", "Set", "Map", "Math", "String", "navigator", "undefined"]);
const escape = escapeRegExp;
const READ_MARKER = "codexLinuxRemoteControlShouldReadStatus";
const WAIT_MARKER = "codexLinuxRemoteControlStatusWaitMs";
const READ_HELPER = `function ${READ_MARKER}(e){return !(typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)&&typeof e==\`string\`&&(e.startsWith(\`remote-ssh\`)||e.startsWith(\`remote-control:\`)))}`;
const WAIT_EXPRESSION = `typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)?3e4:5e3/*${WAIT_MARKER}*/`;
function fail(reason) { throw Error(`Remote host status: ${reason}`); }
function one(rows, reason) { if (rows.length !== 1) fail(reason); return rows[0]; }

function normalized(snapshot, body = snapshot.moduleSource) {
  if (snapshot.params.length !== 3 || new Set(snapshot.params).size !== 3) fail("factory parameters");
  const lexical = createJavaScriptLexicalIndex(body), req = snapshot.params[2];
  const imports = [], edits = [];
  const pattern = new RegExp(`(?<![\\w$.])${escape(req)}\\(("(?:\\\\.|[^"\\\\])*")\\)`, "gu");
  for (const match of body.matchAll(pattern)) {
    if (!lexical.isRoot(match.index)) continue;
    const prefix = body.slice(0, match.index), local = prefix.match(new RegExp(`(${IDENT})=$`, "u"))?.[1];
    if (local != null) {
      const binding = findRspackRequireBinding({ ...snapshot, moduleSource: body }, local);
      if (binding == null || binding.moduleId !== JSON.parse(match[1])) fail("unbound or mutable import");
      imports.push({ local, moduleId: binding.moduleId });
    }
    const start = match.index + match[0].indexOf(match[1]);
    edits.push({ start, end: start + match[1].length, text: '"@import"' });
  }
  for (const edit of edits.reverse()) body = body.slice(0, edit.start) + edit.text + body.slice(edit.end);
  const code = createJavaScriptLexicalIndex(body), names = new Map(snapshot.params.map((name, index) => [name, "$" + index]));
  let result = "", cursor = 0;
  for (const token of body.matchAll(/[A-Za-z_$][\w$]*/gu)) {
    const start = token.index, name = token[0];
    if (!code.isCode(start) || FIXED.has(name) || body[start - 1] === "." || /^\s*:/u.test(body.slice(start + name.length))) continue;
    if (!names.has(name)) names.set(name, "$" + names.size);
    result += body.slice(cursor, start) + names.get(name);
    cursor = start + name.length;
  }
  const renamed = result + body.slice(cursor);
  const renamedCode = createJavaScriptLexicalIndex(renamed);
  let text = "";
  for (let index = 0; index < renamed.length;) {
    if (renamedCode.isCode(index)) {
      text += renamed[index++];
      continue;
    }
    let end = index + 1;
    while (end < renamed.length && !renamedCode.isCode(end)) end++;
    const opaqueOrTrivia = renamed.slice(index, end);
    // The index also marks trivia non-code. Opaque runs and all line
    // terminators stay byte-for-byte. For spaces/tabs, preserve a separator
    // between word tokens and conservatively beside operator characters;
    // removing those could fuse keywords, identifiers or operators.
    if (!/^[ \t]+$/u.test(opaqueOrTrivia)) text += opaqueOrTrivia;
    else {
      const previous = renamed[index - 1] ?? "", next = renamed[end] ?? "";
      const wordBoundary = /[\w$]/u.test(previous) && /[\w$]/u.test(next);
      const operatorBoundary = /[+\-*/%&|^<>=!?~.]/u.test(previous + next);
      if (wordBoundary || operatorBoundary) text += " ";
    }
    index = end;
  }
  return { text, imports };
}

function readPattern(parameters, patched) {
  const [store, host, client, current] = parameters.map(escape), I = IDENT;
  const guard = patched ? String.raw`${READ_MARKER}\(${host}\)\?` : "";
  const blocked = patched ? String.raw`:\(\k<active>\(\)&&\k<setter>\(${store},${host},\{status:\x60disabled\x60,available:!1,accessRequired:!1\}\),void 0\)` : "";
  return new RegExp(
    String.raw`^let (?<resolved>${I});if\(\(0,(?<classifier>${I})\.(?<classifierKey>${I})\)\(${host}\)\)return\(\)=>\{\};` +
    String.raw`let (?<abort>${I})=new AbortController,(?<active>${I})=\(\)=>!\k<abort>\.signal\.aborted&&\(${current}\?\.\(\)\?\?!0\),(?<initial>${I})=${store}\.get\((?<atom>${I}),${host}\),` +
    String.raw`(?<subscription>${I})=${client}\.subscribe\(\{type:"notification",key:\{hostId:${host}\},methods:"remoteControl/status/changed",listener:\(\{params:(?<params>${I})\}\)=>\{\k<active>\(\)&&(?<setter>${I})\(${store},${host},\k<params>\)\}\}\),` +
    String.raw`(?<cleanup>${I})=\(\)=>\{\k<abort>\.signal\.aborted\|\|\(\k<abort>\.abort\(\),\k<subscription>\[Symbol\.dispose\]\(\),\k<resolved>\?\.\[Symbol\.dispose\]\(\)\)\};` +
    String.raw`return \k<subscription>\.onRpcBroken\(\k<cleanup>\),\k<subscription>\.then\((?<ready>${I})=>\{\k<active>\(\)\?\(\k<resolved>=\k<ready>,\k<ready>\.onRpcBroken\(\k<cleanup>\)\):\k<ready>\[Symbol\.dispose\]\(\)\},\k<cleanup>\),` +
    guard +
    String.raw`(?<read>\(0,(?<awaiter>${I})\.(?<awaiterKey>${I})\)\(${client}\.sendRequest\("remoteControl/status/read",void 0\),\k<abort>\.signal\)\.then\((?<result>${I})=>\{${store}\.get\(\k<atom>,${host}\)===\k<initial>&&\k<active>\(\)&&\k<setter>\(${store},${host},\k<result>\)\}\)\.catch\((?<error>${I})=>\{\k<active>\(\)&&(?<logger>${I})\.(?<loggerKey>${I})\.error\("Failed to read remote-control status",\{safe:\{\},sensitive:\{error:\k<error>\}\}\)\}\))` +
    blocked + String.raw`,\k<cleanup>$`, "du");
}
function inline(copy, key) {
  const pub = findRspackExportPublication(copy, key);
  if (!pub?.fn || pub.fn.name !== null) fail("native inline " + key + " publication");
  const bodyStart = pub.fn.end - 1 - pub.fn.body.length, bodyEnd = pub.fn.end - 1;
  if (copy.moduleSource.slice(bodyStart, bodyEnd) !== pub.fn.body) fail("stale native inline body");
  return { ...pub.fn, bodyStart, bodyEnd };
}
function projectRead(copy) {
  const fn = inline(copy, "UL"), parameters = fn.params.split(",");
  if (parameters.length !== 4 || new Set(parameters).size !== 4 || parameters.some(name => !new RegExp(`^${IDENT}$`, "u").test(name))) fail("native status reader arguments");
  const markers = copy.moduleSource.split(READ_MARKER).length - 1, patched = markers !== 0;
  if (patched && (markers !== 2 || !fn.body.startsWith(READ_HELPER))) fail("partial status-read contribution");
  const body = patched ? fn.body.slice(READ_HELPER.length) : fn.body, match = readPattern(parameters, patched).exec(body);
  if (!match) fail("changed complete status subscription/read/cleanup grammar");
  const r = match.groups, range = match.indices.groups.read;
  const guardedStart = patched ? body.indexOf(`${READ_MARKER}(${parameters[1]})?`) : range[0];
  const guardedEnd = patched ? body.lastIndexOf("," + r.cleanup) : range[1];
  if (guardedStart < 0 || guardedEnd < guardedStart) fail("missing native read span");
  const nativeBody = patched ? body.slice(0, guardedStart) + r.read + body.slice(guardedEnd) : body;
  return { fn, parameters, roles: r, nativeBody, state: patched ? "patched" : "pristine",
    nativeSource: copy.moduleSource.slice(0, fn.bodyStart) + nativeBody + copy.moduleSource.slice(fn.bodyEnd) };
}
function projectWait(copy) {
  const markers = copy.moduleSource.split(WAIT_MARKER).length - 1;
  if (!markers) return { moduleSource: copy.moduleSource, active: false };
  const fn = inline(copy, "Hf");
  if (markers !== 1 || fn.body.split(WAIT_EXPRESSION).length !== 2) fail("partial native wait contribution");
  return { moduleSource: copy.moduleSource.replace(WAIT_EXPRESSION, "5e3"), active: true };
}
function freeIntrinsic(copy, name) {
  if (copy.params.includes(name)) fail("captured factory intrinsic " + name);
  try { new Script(`function nativeHostStatus(${copy.params.join(",")}){${copy.moduleSource}\n;let ${name};}`); }
  catch { fail("captured root intrinsic " + name); }
}
function inspectHostStatusOwner(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 || new Set(copy.params).size !== 3 || Buffer.byteLength(copy.moduleSource ?? "") > 16 * 1024) fail("bounded native status module");
  new Script(`function nativeHostStatus(${copy.params.join(",")}){${copy.moduleSource}\n}`);
  for (const name of ["navigator", "Error", "Promise", "AbortController", "Symbol", "setTimeout", "clearTimeout"]) freeIntrinsic(copy, name);
  const read = projectRead(copy), peer = projectWait({ ...copy, moduleSource: read.nativeSource });
  const native = { ...copy, moduleSource: peer.moduleSource }, actual = normalized(native), expected = normalized(shapes);
  if (actual.text !== expected.text || actual.imports.length !== 5) fail("changed native complete host-status contract");
  const imports = actual.imports.map(row => {
    const binding = findRspackRequireBinding(native, row.local), begin = binding.start - copy.start, end = binding.end - copy.start;
    if (!hasStableEagerMainBinding(native.moduleSource.slice(0, begin) + row.local + native.moduleSource.slice(end), row.local)) fail("eager native provider write");
    return Object.freeze(binding);
  });
  const atom = findRspackExportPublication(native, "AP"), setter = findRspackExportPublication(native, "Lt");
  if (atom?.expression !== read.roles.atom || setter?.expression !== read.roles.setter) fail("read is not the published native host state");
  return Object.freeze({ moduleId: copy.moduleId, readState: read.state, waitPeer: peer.active,
    nativeSource: native.moduleSource, readNativeSource: read.nativeSource,
    read: Object.freeze({ ...read, parameters: Object.freeze(read.parameters), roles: Object.freeze(read.roles), fn: Object.freeze(read.fn) }),
    imports: Object.freeze(imports),
    boundary: "Complete bounded native module grammar and eager import initialization authority; no arbitrary-JavaScript resolver, runtime immutability, cancellation or global selected-host policy." });
}
function prepareStatusReadSource(copy) {
  const proof = inspectHostStatusOwner(copy), nativeCopy = { ...copy, moduleSource: proof.readNativeSource }, read = projectRead(nativeCopy), r = read.roles;
  const range = readPattern(read.parameters, false).exec(read.nativeBody).indices.groups.read;
  const guarded = `${READ_MARKER}(${read.parameters[1]})?${r.read}:(${r.active}()&&${r.setter}(${read.parameters[0]},${read.parameters[1]},{status:\`disabled\`,available:!1,accessRequired:!1}),void 0)`;
  const body = READ_HELPER + read.nativeBody.slice(0, range[0]) + guarded + read.nativeBody.slice(range[1]);
  const patchedSource = nativeCopy.moduleSource.slice(0, read.fn.bodyStart) + body + nativeCopy.moduleSource.slice(read.fn.bodyEnd);
  const replay = inspectHostStatusOwner({ ...copy, moduleSource: patchedSource });
  if (replay.readState !== "patched" || replay.readNativeSource !== proof.readNativeSource ||
      proof.readState === "patched" && patchedSource !== copy.moduleSource) fail("canonical status-read inverse/replay");
  return Object.freeze({ proof, nativeSource: proof.readNativeSource, patchedSource, state: proof.readState });
}
module.exports = { inspectHostStatusOwner, prepareStatusReadSource, normalizeNativeHostStatusModule: normalized,
  READ_MARKER, READ_HELPER, WAIT_MARKER, WAIT_EXPRESSION };
