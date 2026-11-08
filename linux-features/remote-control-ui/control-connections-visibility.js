"use strict";
const fs = require("node:fs");
const path = require("node:path");
const shapes = require("./control-visibility-shapes.js");
const { projectLoadGatePeer } = require("./load-gate-peer.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const FIXED = new Set(["async", "await", "for", "of", "var", "let", "const", "function", "return", "if", "else", "new", "typeof", "void", "null", "true", "false", "Object", "Array", "Set", "Symbol", "navigator", "undefined"]);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(message) { throw new Error("Remote control visibility: " + message); }

function normalized(snapshot, body = snapshot.moduleSource) {
  if (snapshot.params.length !== 3 || new Set(snapshot.params).size !== 3) fail("factory parameters");
  if (snapshot.params.includes("navigator") || snapshot.params.includes("codexLinuxRemoteControlOnLinux")) fail("reserved platform binding");
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

const UI = "codexLinuxRemoteControlUiVisibilityEnabled";
const MOBILE = "codexLinuxRemoteControlVisibilityEnabled";
const ENTRY = "codexLinuxRemoteConnectionsVisibility";
const LINUX = "typeof navigator!=`undefined`&&navigator.userAgent.includes(`Linux`)";
const LOCAL = "codexLinuxRemoteControlOnLinux";

function predicate(copy) {
  const body = copy.moduleSource, lexical = createJavaScriptLexicalIndex(body);
  const pattern = new RegExp(`function (${IDENT})\\(\\{remoteControlConnectionsState:(${IDENT}),slingshotEnabled:(${IDENT})\\}\\)\\{`, "gu");
  const matches = [...body.matchAll(pattern)].filter(match => lexical.isRoot(match.index));
  if (matches.length !== 1) fail("unique root predicate declaration");
  const match = matches[0], start = match.index + match[0].length, end = lexical.matchingBrace(start - 1);
  if (end < start) fail("predicate body bounds");
  return { name: match[1], state: match[2], flag: match[3], start, end, body: body.slice(start, end) };
}

function render(owner, ui, mobile) {
  const { flag, state } = owner;
  if (mobile) return `let ${LOCAL}=${LINUX};/*${MOBILE}*/${ui ? `/*${UI}*/` : ""}` +
    `return(${LOCAL}||${flag})&&(${LOCAL}||(${state}?.available??!0))&&${state}?.accessRequired!==!0`;
  return ui ? `return (${flag}||${LINUX})&&(${state}?.available??!0)&&${state}?.accessRequired!==!0/*${UI}*/` :
    `return ${flag}&&(${state}?.available??!0)&&${state}?.accessRequired!==!0`;
}

function visibilityProof(copy) {
  const owner = predicate(copy);
  const states = [[false, false], [true, false], [false, true], [true, true]]
    .filter(([ui, mobile]) => owner.body === render(owner, ui, mobile));
  if (states.length !== 1) fail("incomplete visibility contribution");
  const [ui, mobile] = states[0];
  const pristine = copy.moduleSource.slice(0, owner.start) + render(owner, false, false) + copy.moduleSource.slice(owner.end);
  const actual = normalized(copy, pristine);
  if (actual.text !== normalized(shapes.visibility).text) fail("changed visibility module grammar");
  const snapshot = { ...copy, moduleSource: pristine };
  const zi = findRspackExportPublication(snapshot, "Zi");
  if (zi?.expression !== owner.name || findRspackExportPublication(snapshot, "wi") == null ||
      findRspackExportPublication(snapshot, "HZ") == null) fail("visibility publication graph");
  if (new RegExp(`\\b${LOCAL}\\b`, "u").test(pristine)) fail("mobile helper binding collision");
  return { ...actual, owner, ui, mobile };
}

function dependencyProof(copy, role) {
  const loadGatePeer = role === "gate" ? projectLoadGatePeer(copy) : { moduleSource: copy.moduleSource, active: false };
  let body = loadGatePeer.moduleSource, entry = false;
  if (role === "gate" && body.includes(ENTRY)) {
    const calls = [...body.matchAll(new RegExp(`${IDENT}\\(${IDENT}\\.JW,"4114442250"\\)`, "gu"))];
    if (calls.length !== 1 || body.split(ENTRY).length !== 2) fail("entry gate contribution");
    const call = calls[0][0];
    const canonical = `(${call}||typeof navigator!==\`undefined\`&&navigator.userAgent.includes(\`Linux\`))/*${ENTRY}*/`;
    if (body.split(canonical).length !== 2) fail("changed entry canonical gate");
    body = body.replace(canonical, call);
    entry = true;
  }
  const actual = normalized(copy, body);
  if (actual.text !== normalized(shapes[role]).text) fail("changed " + role + " dependency grammar");
  const key = role === "catalog" ? "h9" : "mC";
  if (findRspackExportPublication({ ...copy, moduleSource: body }, key) == null) fail("missing " + role + " publication");
  return { ...actual, entry, loadGatePeer: loadGatePeer.active };
}

// Pure build-time contribution preparation. The mobile contribution exposes
// the exact future sibling protocol; the UI descriptor requests only "ui".
// This is not proof that the existing UP83 descriptor uses this interface.
function prepareRemoteControlConnectionsVisibility(cohort, contribution = "ui", enabled = true) {
  if (!["ui", "mobile"].includes(contribution)) fail("unknown contribution");
  if (typeof enabled !== "boolean") fail("invalid contribution state");
  const proofs = {};
  for (const role of ["visibility", "catalog", "gate"]) {
    const copies = cohort[role];
    if (!Array.isArray(copies) || copies.length === 0 || new Set(copies.map(copy => copy.moduleId)).size !== 1 ||
        new Set(copies.map(copy => copy.assetName)).size !== copies.length) fail("missing or ambiguous " + role + " copies");
    for (const copy of copies) if (copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale " + role + " snapshot");
    proofs[role] = copies.map(copy => role === "visibility" ? visibilityProof(copy) : dependencyProof(copy, role));
    const imports = proofs[role][0].imports.map(row => row.moduleId);
    if (proofs[role].some(proof => JSON.stringify(proof.imports.map(row => row.moduleId)) !== JSON.stringify(imports))) fail("different physical peer imports");
  }
  const first = proofs.visibility[0];
  if (proofs.visibility.some(proof => proof.ui !== first.ui || proof.mobile !== first.mobile)) fail("partially applied visibility cohort");
  if (proofs.gate.some(proof => proof.entry !== proofs.gate[0].entry)) fail("partial entry dependency");
  if (proofs.gate.some(proof => proof.loadGatePeer !== proofs.gate[0].loadGatePeer)) fail("partial load-gate dependency");
  const visibility = first.imports, catalog = proofs.catalog[0].imports, gate = proofs.gate[0].imports;
  if (visibility[2].moduleId !== cohort.catalog[0].moduleId || visibility[3].moduleId !== cohort.gate[0].moduleId ||
      visibility[1].moduleId !== catalog[1].moduleId || visibility[1].moduleId !== gate[0].moduleId ||
      catalog[2].moduleId !== gate[3].moduleId) fail("unbound catalog/gate hook scope");
  const ui = contribution === "ui" ? enabled : first.ui;
  const mobile = contribution === "mobile" ? enabled : first.mobile;
  const grouped = new Map();
  for (const [index, copy] of cohort.visibility.entries()) {
    if (copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale visibility snapshot");
    const proof = proofs.visibility[index];
    const group = grouped.get(copy.assetName) ?? { assetName: copy.assetName, source: copy.source, edits: [] };
    if (group.source !== copy.source) fail("different asset snapshots");
    const replacement = render(proof.owner, ui, mobile);
    if (replacement !== proof.owner.body) group.edits.push({ start: copy.start + proof.owner.start, end: copy.start + proof.owner.end, replacement });
    grouped.set(copy.assetName, group);
  }
  for (const role of ["catalog", "gate"]) for (const copy of cohort[role]) {
    const group = grouped.get(copy.assetName);
    if (group && group.source !== copy.source) fail("different dependency asset snapshot");
    if (!group) grouped.set(copy.assetName, { assetName: copy.assetName, source: copy.source, edits: [] });
  }
  const edits = [...grouped.values()].map(group => {
    let patchedSource = group.source;
    for (const edit of group.edits.sort((a, b) => b.start - a.start)) patchedSource = patchedSource.slice(0, edit.start) + edit.replacement + patchedSource.slice(edit.end);
    return { assetName: group.assetName, source: group.source, patchedSource };
  });
  return { edits, contributions: { ui, mobile }, priorContributions: { ui: first.ui, mobile: first.mobile },
    entryDependency: proofs.gate[0].entry ? "exact-UP77-canonical" : "pristine",
    moduleIds: Object.fromEntries(Object.keys(proofs).map(role => [role, cohort[role][0].moduleId])),
    dependencyAssets: [...new Set(Object.values(cohort).flatMap(copies => copies.map(copy => copy.assetName)))].sort() };
}

function locateRemoteControlConnectionsVisibility(assetsDir, contribution = "ui") {
  const cohort = {};
  for (const role of ["visibility", "catalog", "gate"]) {
    const needle = role === "visibility" ? "remoteControlConnectionsState" : role === "catalog" ? "localRemoteControlInstallationId" : "4114442250";
    cohort[role] = findUniqueRspackModuleCopies(assetsDir, {
      description: "remote control visibility " + role,
      sourceMatch: source => source.includes(needle),
      matchModule: (body, copy) => {
        const keys = role === "visibility" ? ["Zi:", "wi:", "HZ:"] : role === "catalog" ? ["h9:", "catalog.subscribe"] : ["bc:", "Ik:"];
        if (!body.includes(needle) || !keys.every(key => body.includes(key))) return false;
        try { role === "visibility" ? visibilityProof(copy) : dependencyProof(copy, role); return true; } catch { return false; }
      },
    });
  }
  const prepared = prepareRemoteControlConnectionsVisibility(cohort, contribution);
  for (const [marker, count] of [[UI, prepared.priorContributions.ui], [MOBILE, prepared.priorContributions.mobile]]) {
    let actual = 0;
    for (const name of listWebviewAssetFiles(assetsDir, /\.js$/u)) actual += fs.readFileSync(path.join(assetsDir, name), "utf8").split(marker).length - 1;
    if (actual !== (count ? cohort.visibility.length : 0)) fail("orphan visibility marker");
  }
  return prepared;
}

function applyRemoteControlConnectionsVisibility(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets");
  const prepared = locateRemoteControlConnectionsVisibility(assets);
  return { ...patchWebviewAssets(assets, prepared.edits, options), matched: true, moduleIds: prepared.moduleIds };
}

module.exports = { prepareRemoteControlConnectionsVisibility, locateRemoteControlConnectionsVisibility, applyRemoteControlConnectionsVisibility };
