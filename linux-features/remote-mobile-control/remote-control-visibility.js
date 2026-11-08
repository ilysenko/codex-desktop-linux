"use strict";
const fs = require("node:fs");
const path = require("node:path");
const shapes = require("./remote-visibility-shapes.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies, findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { listWebviewAssetFiles, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const IDENT = "[A-Za-z_$][\\w$]*";
const FIXED = new Set(["async", "await", "for", "of", "var", "let", "const", "function", "return", "if", "else", "new", "typeof", "void", "null", "true", "false", "Object", "Array", "Set", "Symbol", "navigator", "undefined"]);
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(message) { throw new Error("Remote mobile visibility: " + message); }

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

function catalogProof(copy) {
  const actual = normalized(copy);
  if (actual.text !== normalized(shapes.catalog).text || findRspackExportPublication(copy, "h9") == null) fail("changed catalog dependency grammar");
  return actual;
}

// The load-gate module is an independently reviewed SAME-feature dependency.
// Its proposed81 edits are ignored:83 owns only the visibility contribution.
const { prepareRemoteLoadGate, inspectRemoteLoadGateOwner } = require("./remote-load-gate.js");
function prepareRemoteMobileVisibility(input, enabled = true) {
  if (typeof enabled !== "boolean") fail("invalid mobile contribution state");
  const roles = ["visibility", "catalog", "gate", "gateHook"];
  const cohort = Object.fromEntries(roles.map(role => [role, Array.isArray(input?.[role]) ? input[role].map(copy => {
    const value = { assetName: copy.assetName, source: copy.source, moduleId: copy.moduleId,
      moduleSource: copy.moduleSource, start: copy.start, end: copy.end, params: [...copy.params] };
    if (typeof value.source !== "string" || typeof value.moduleSource !== "string" || value.source.slice(value.start, value.end) !== value.moduleSource) fail("stale " + role + " snapshot");
    Object.freeze(value.params);return Object.freeze(value);
  }) : []]));
  for (const role of roles) if (!cohort[role].length || new Set(cohort[role].map(copy => copy.moduleId)).size !== 1 ||
      new Set(cohort[role].map(copy => copy.assetName)).size !== cohort[role].length) fail("missing/ambiguous " + role);
  const gatePlan = prepareRemoteLoadGate({ owner: cohort.gate, callee: cohort.gateHook });
  const owners = cohort.gate.map(inspectRemoteLoadGateOwner), catalogs = cohort.catalog.map(catalogProof), visibility = cohort.visibility.map(visibilityProof);
  for (const proofs of [owners, catalogs, visibility]) {
    const ids = proofs[0].imports.map(row => row.moduleId);
    if (proofs.some(proof => JSON.stringify(proof.imports.map(row => row.moduleId)) !== JSON.stringify(ids))) fail("different physical dependency imports");
  }
  const first = visibility[0];
  if (visibility.some(proof => proof.ui !== first.ui || proof.mobile !== first.mobile)) fail("partially applied visibility cohort");
  const view = first.imports, catalog = catalogs[0].imports, gate = owners[0].imports;
  if (view[2].moduleId !== cohort.catalog[0].moduleId || view[3].moduleId !== cohort.gate[0].moduleId ||
      view[1].moduleId !== catalog[1].moduleId || view[1].moduleId !== gate[0].moduleId || catalog[2].moduleId !== gate[3].moduleId) fail("unbound catalog/gate scope");
  const grouped = new Map();
  for (const role of roles) for (const copy of cohort[role]) {
    const group = grouped.get(copy.assetName);
    if (group && group.source !== copy.source) fail("different dependency snapshots");
    if (!group) grouped.set(copy.assetName, { assetName: copy.assetName, source: copy.source, patches: [] });
  }
  for (const [index, copy] of cohort.visibility.entries()) {
    const owner = visibility[index].owner, replacement = render(owner, first.ui, enabled);
    if (replacement !== owner.body) grouped.get(copy.assetName).patches.push({ start: copy.start + owner.start, end: copy.start + owner.end, replacement });
  }
  const edits = [...grouped.values()].map(group => {
    let patchedSource = group.source;
    for (const patch of group.patches.sort((a, b) => b.start - a.start)) patchedSource = patchedSource.slice(0, patch.start) + patch.replacement + patchedSource.slice(patch.end);
    return { assetName: group.assetName, source: group.source, patchedSource };
  });
  return { edits, contributions: { ui: first.ui, mobile: enabled }, priorContributions: { ui: first.ui, mobile: first.mobile },
    moduleIds: Object.fromEntries(roles.map(role => [role, cohort[role][0].moduleId])),
    gatePeerState: { entry77: gatePlan.entryPeer, load81: gatePlan.alreadyApplied },
    dependencyAssets: [...grouped.keys()].sort() };
}

function locateRemoteMobileVisibility(assetsDir) {
  const cohort = {};
  for (const role of ["visibility", "catalog", "gate"]) {
    const needle = role === "visibility" ? "remoteControlConnectionsState" : role === "catalog" ? "localRemoteControlInstallationId" : "4114442250";
    cohort[role] = findUniqueRspackModuleCopies(assetsDir, {
      description: "Remote mobile visibility " + role,
      sourceMatch: source => source.includes(needle),
      matchModule: (body, copy) => {
        const keys = role === "visibility" ? ["Zi:", "wi:", "HZ:"] : role === "catalog" ? ["h9:", "catalog.subscribe"] : ["bc:", "Ik:", "mC:"];
        if (!body.includes(needle) || !keys.every(key => body.includes(key))) return false;
        try { role === "visibility" ? visibilityProof(copy) : role === "catalog" ? catalogProof(copy) : inspectRemoteLoadGateOwner(copy);return true; } catch { return false; }
      },
    });
  }
  const hook = inspectRemoteLoadGateOwner(cohort.gate[0]).inline.binding.moduleId;
  cohort.gateHook = findUniqueRspackModuleCopies(assetsDir, {
    description: "Remote mobile native gate hook", sourceMatch: source => source.includes(hook), matchModule: (_body, copy) => copy.moduleId === hook,
  });
  const prepared = prepareRemoteMobileVisibility(cohort);
  for (const [marker, active] of [[UI, prepared.priorContributions.ui], [MOBILE, prepared.priorContributions.mobile]]) {
    let count = 0;
    for (const name of listWebviewAssetFiles(assetsDir, /\.js$/u)) count += fs.readFileSync(path.join(assetsDir, name), "utf8").split(marker).length - 1;
    if (count !== (active ? cohort.visibility.length : 0)) fail("orphan visibility marker");
  }
  return prepared;
}

function applyRemoteMobileVisibility(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets");
  const prepared = locateRemoteMobileVisibility(assets);
  return { ...patchWebviewAssets(assets, prepared.edits, options), matched: true, moduleIds: prepared.moduleIds };
}

module.exports = { prepareRemoteMobileVisibility, locateRemoteMobileVisibility, applyRemoteMobileVisibility };
