"use strict";

const fs = require("node:fs");
const path = require("node:path");
const shapes = require("./visibility-shapes.js");
const { projectLoadGatePeer } = require("./load-gate-peer.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");

const MARKER = "codexLinuxRemoteConnectionsVisibility";
const IDENT = "[A-Za-z_$][\\w$]*";
const FIXED = new Set(["var", "let", "const", "function", "return", "if", "else", "new", "typeof", "void", "null", "true", "false", "Object", "Array", "Set", "Symbol", "navigator", "undefined"]);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(message) { throw new Error("Remote connections visibility: " + message); }

// This is a conservative native grammar, not an evaluator. Import identities
// and factory-local names are resolved independently; all operators, keys,
// constants, declarations, control flow and publication structure must remain.
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

function gate(snapshot) {
  const matches = [...snapshot.moduleSource.matchAll(new RegExp(`(${IDENT})\\((${IDENT})\\.JW,"4114442250"\\)`, "gu"))];
  const lexical = createJavaScriptLexicalIndex(snapshot.moduleSource);
  const calls = matches.filter(match => lexical.isCode(match.index));
  if (calls.length !== 1) fail("unique gate expression");
  return { call: calls[0][0], start: calls[0].index, getter: calls[0][1], provider: calls[0][2] };
}

function qualify(snapshot, role) {
  const loadGatePeer = role === "boolean" ? projectLoadGatePeer(snapshot) : { moduleSource: snapshot.moduleSource, active: false };
  let body = loadGatePeer.moduleSource, applied = false;
  if (role === "boolean" || role === "state") {
    const { call } = gate(snapshot);
    const canonical = `(${call}||typeof navigator!==\`undefined\`&&navigator.userAgent.includes(\`Linux\`))/*${MARKER}*/`;
    const markers = body.split(MARKER).length - 1;
    if (markers) {
      if (markers !== 1 || body.split(canonical).length !== 2) fail("incomplete canonical gate");
      body = body.replace(canonical, call);
      applied = true;
    }
  }
  const actual = normalized(snapshot, body), expected = normalized(shapes[role]);
  if (actual.text !== expected.text) fail("changed " + role + " owner grammar");
  const required = role === "boolean" ? ["bc", "Ik"] : role === "state" ? ["e", "xm"] : role === "booleanCaller" ? ["XO"] : role === "navigationCaller" ? ["RemoteConnectionsPage"] : ["FQ"];
  for (const key of required) if (findRspackExportPublication({ ...snapshot, moduleSource: body }, key) == null) fail("missing " + role + " publication " + key);
  return { ...actual, applied, loadGatePeer: loadGatePeer.active };
}

// Pure: validates the complete cohort and returns source edits; no writes and
// no upstream module initialization. Callers/tests cross this same interface.
function prepareRemoteConnectionsVisibility(cohort) {
  const roles = ["boolean", "state", "booleanCaller", "stateCaller", "navigationCaller"];
  const qualified = {};
  for (const role of roles) {
    const copies = cohort[role];
    if (!Array.isArray(copies) || copies.length === 0 || new Set(copies.map(row => row.moduleId)).size !== 1) fail("missing or ambiguous " + role);
    const assets = new Set();
    qualified[role] = copies.map(copy => {
      if (assets.has(copy.assetName)) fail("duplicate physical peer");
      assets.add(copy.assetName);
      return qualify(copy, role);
    });
    const imports = qualified[role][0].imports.map(row => row.moduleId);
    if (qualified[role].some(row => JSON.stringify(row.imports.map(item => item.moduleId)) !== JSON.stringify(imports))) fail("inconsistent physical peer imports");
  }
  if (qualified.boolean.some(row => row.loadGatePeer !== qualified.boolean[0].loadGatePeer)) fail("partially applied load-gate peer");
  const boolean = qualified.boolean[0].imports, state = qualified.state[0].imports;
  for (const [left, right] of [[0, 0], [1, 2], [2, 3], [3, 5], [5, 9], [6, 4]]) {
    if (boolean[left].moduleId !== state[right].moduleId) fail("gate roots disagree on shared provider");
  }
  if (qualified.booleanCaller[0].imports[2].moduleId !== cohort.boolean[0].moduleId ||
      qualified.stateCaller[0].imports[4].moduleId !== cohort.state[0].moduleId ||
      qualified.navigationCaller[0].imports[3].moduleId !== cohort.boolean[0].moduleId) fail("orphan caller import");
  for (const [role, pairs] of [["booleanCaller", [[0, 0], [3, 3], [8, 5]]], ["stateCaller", [[0, 0], [2, 3]]]]) {
    for (const [caller, owner] of pairs) if (qualified[role][0].imports[caller].moduleId !== boolean[owner].moduleId) fail("caller uses different native provider");
  }
  const states = [...qualified.boolean, ...qualified.state].map(row => row.applied);
  if (states.some(Boolean) && !states.every(Boolean)) fail("partially applied cohort");
  const groups = new Map();
  for (const role of roles.slice(0, 2)) for (const copy of cohort[role]) {
    if (copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale module snapshot");
    const item = groups.get(copy.assetName) ?? { assetName: copy.assetName, source: copy.source, changes: [] };
    if (item.source !== copy.source) fail("inconsistent source snapshot");
    const call = gate(copy), replacement = `(${call.call}||typeof navigator!==\`undefined\`&&navigator.userAgent.includes(\`Linux\`))/*${MARKER}*/`;
    if (!states[0]) item.changes.push({ start: copy.start + call.start, end: copy.start + call.start + call.call.length, replacement });
    groups.set(copy.assetName, item);
  }
  const edits = [...groups.values()].map(({ assetName, source, changes }) => {
    let patchedSource = source;
    for (const edit of changes.sort((a, b) => b.start - a.start)) patchedSource = patchedSource.slice(0, edit.start) + edit.replacement + patchedSource.slice(edit.end);
    return { assetName, source, patchedSource };
  });
  return { edits, alreadyApplied: states[0], moduleIds: Object.fromEntries(roles.map(role => [role, cohort[role][0].moduleId])),
    providerModules: [boolean[0].moduleId, boolean[1].moduleId, boolean[2].moduleId, boolean[3].moduleId, boolean[5].moduleId],
    dependencyAssets: [...new Set(roles.flatMap(role => cohort[role].map(copy => copy.assetName)))].sort() };
}

function locateRemoteConnectionsVisibility(assetsDir) {
  const cohort = {};
  for (const role of Object.keys(shapes)) {
    const needle = role === "boolean" || role === "state" ? "4114442250" : role === "booleanCaller" ? "/settings/connections/ssh" : role === "navigationCaller" ? "RemoteConnectionsPage" : "conversationByKey";
    cohort[role] = findUniqueRspackModuleCopies(assetsDir, {
      description: "remote connections " + role,
      sourceMatch: source => source.includes(needle),
      matchModule: (body, snapshot) => {
        if (!body.includes(needle)) return false;
        // Cheap publication/role prefilters keep unrelated large settings or
        // conversation modules out of the bounded grammar proof. Once an
        // identity is found, the generic census still returns every peer.
        const needles = role === "boolean" ? ["bc:", "Ik:"] : role === "state" ? ["xm:", '"loading"', '"disabled"'] :
          role === "booleanCaller" ? ["XO:"] : role === "navigationCaller" ? ["RemoteConnectionsPage:function"] :
            ["FQ:", "preserveUnloadedStoredKeys:!0", "chatSortMode"];
        if (!needles.every(value => body.includes(value))) return false;
        try { qualify(snapshot, role); return true; } catch { return false; }
      },
    });
  }
  const prepared = prepareRemoteConnectionsVisibility(cohort);
  const dependencies = new Set(prepared.dependencyAssets);
  // Qualify domain publications through their factory loader identity. The
  // roots also require identical atom/scope imports; this does not recursively
  // qualify the implementation of the upstream framework libraries.
  for (const [index, key] of [[1, "Dc"], [2, "I2"], [4, "JW"]]) {
    const moduleId = prepared.providerModules[index];
    const copies = findUniqueRspackModuleCopies(assetsDir, {
      description: "remote connections provider " + key,
      sourceMatch: source => source.includes(moduleId),
      matchModule: (_body, snapshot) => snapshot.moduleId === moduleId,
    });
    for (const copy of copies) {
      if (findRspackExportPublication(copy, key) == null) fail("missing provider publication " + key);
      dependencies.add(copy.assetName);
    }
  }
  let markers = 0;
  for (const name of listWebviewAssetFiles(assetsDir, /\.js$/u)) markers += fs.readFileSync(path.join(assetsDir, name), "utf8").split(MARKER).length - 1;
  if (markers !== (prepared.alreadyApplied ? cohort.boolean.length + cohort.state.length : 0)) fail("orphan canonical marker");
  return { ...prepared, dependencyAssets: [...dependencies].sort() };
}

function applyRemoteConnectionsVisibility(extractedDir, options = {}) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const prepared = locateRemoteConnectionsVisibility(assetsDir);
  return { ...patchWebviewAssets(assetsDir, prepared.edits, options), matched: true, moduleIds: prepared.moduleIds };
}

module.exports = { prepareRemoteConnectionsVisibility, locateRemoteConnectionsVisibility, applyRemoteConnectionsVisibility };
