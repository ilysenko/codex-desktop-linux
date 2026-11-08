"use strict";
const fs = require("node:fs");
const path = require("node:path");
const shapes = require("./experimental-filter-shapes.js");
const scope = require("./experimental-filter-scope.js");
const { qualifiedFunction, MARKER } = require("./experimental-filter-module.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { patchWebviewAssets, listWebviewAssetFiles } = require("../../scripts/patches/lib/assets.js");
const ID = "[A-Za-z_$][\\w$]*";
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
function fail(message) { throw new Error("Experimental feature cohort: " + message); }
function one(rows, description) { if (rows.length !== 1) fail(description);return rows[0]; }
function ownMatches(copy, expression) {
  return [...copy.moduleSource.matchAll(expression)].filter(match => scope.context(copy).lexical.isCode(match.index));
}
function shape(copy, role, body = copy.moduleSource) {
  scope.context(copy);
  const actual = scope.normalized(copy, body);
  if (actual.text !== scope.normalized(shapes[role]).text) fail("changed " + role + " native grammar");
  return actual;
}
function literalBinding(copy, key, literal) {
  const name = scope.publicationMember(copy, key).value;
  if (!new RegExp(`^${ID}$`, "u").test(name)) fail("literal binding publication " + key);
  const match = one(ownMatches(copy, new RegExp(`(?<![\\w$.])${escape(name)}=${escape(JSON.stringify(literal))}`, "gu"))
    .filter(row => scope.context(copy).lexical.isRoot(row.index)), "literal declaration " + key);
  return { name, at: match.index };
}
function dependency(copy, role) {
  if (role === "barrel") {
    scope.context(copy);
    const member = scope.publicationMember(copy, "R1o"), match = new RegExp(`^\\(\\)=>(${ID})\\.R1$`, "u").exec(member.value);
    if (!match) fail("workspace barrel getter");
    return { settingsModule: scope.requireImport(copy, match[1], member.start).moduleId };
  }
  const proof = shape(copy, role);
  if (role === "settings") {
    if (scope.publicationMember(copy, "R1").value !== '"workspace_dependencies"') fail("workspace exclusion publication");
    literalBinding(copy, "il", "default_mode_request_user_input");
  } else if (role === "memory") literalBinding(copy, "j", "memories");
  else if (role === "chronicle" && scope.publicationMember(copy, "c").value !== '"chronicle"') fail("chronicle publication");
  else if (role === "list") {
    if (!new RegExp(`^${ID}$`, "u").test(scope.publicationMember(copy, "u9").value) ||
        !scope.publicationMember(copy, "jv").value.startsWith("function(")) fail("selected-host list/write publications");
  }
  return proof;
}
function callbackProof(copy) {
  const pattern = new RegExp(`function (${ID})\\((${ID})\\)\\{return\\(0,(${ID})\\.R\\)\\(\\2\\)&&\\2\\.name!==(${ID})\\.il\\}`, "gu");
  const match = one(ownMatches(copy, pattern).filter(row => scope.context(copy).lexical.isRoot(row.index)), "toggle filter callback");
  return { name: match[1], filterAlias: match[3], settingsAlias: match[4], start: match.index,
    fn: scope.stableRootFunction(copy, match[1]) };
}
function toggleProof(copy, ids, listAtoms) {
  const callback = callbackProof(copy);
  scope.requireImport(copy, callback.filterAlias, callback.start, ids.filter);
  scope.requireImport(copy, callback.settingsAlias, callback.start, ids.settings);
  const expression = new RegExp(`(${ID})=\\(void 0===(${ID})\\?\\[\\]:\\2\\)\\.filter\\(${escape(callback.name)}\\)`, "gu");
  const use = one(ownMatches(copy, expression), "native toggle list input");
  scope.unshadowed(copy, callback.name, use.index);
  const owner = scope.enclosingFunction(copy, use.index);
  shape(copy, "toggleScope", owner.source);
  scope.reachable(copy, scope.publishedRootFunction(copy, "ConfigurationPanel"), owner);
  const body = owner.source, parameter = owner.params;
  const host = one([...body.matchAll(new RegExp(`\\{hostId:(${ID})\\}=${escape(parameter)}`, "gu"))], "toggle selected-host input")[1];
  const query = one([...body.matchAll(new RegExp(`\\{data:(${ID}),isLoading:(${ID})\\}=\\(0,(${ID})\\._U\\)\\((${ID})\\.u9,(${ID})\\)`, "gu"))], "toggle selected-host query");
  if (query[1] !== use[2] || query[5] !== host) fail("toggle query/list host mismatch");
  scope.requireImport(copy, query[3], owner.start + query.index, listAtoms);
  scope.requireImport(copy, query[4], owner.start + query.index, ids.list);
  const mutation = one([...body.matchAll(new RegExp(`let (${ID})=\\(0,(${ID})\\.jv\\)\\((${ID})\\),`, "gu"))], "toggle selected-host mutation");
  scope.requireImport(copy, mutation[2], owner.start + mutation.index, ids.list);
  if (mutation[2] !== query[4] || !body.includes(`${mutation[3]}={hostId:${host}}`)) fail("toggle mutation host mismatch");
  const choice = new RegExp(`${escape(mutation[1])}\\.mutate\\(\\{featureName:(${ID})\\.name,enabled:(${ID})\\}`, "gu");
  if ([...body.matchAll(choice)].length !== 1) fail("native toggle choice forwarding");
  return { owner, callback: callback.fn };
}
function searchProof(copy, ids, listAtoms) {
  const pattern = new RegExp(`(${ID})\\.filter\\((${ID})\\.R\\)\\.flatMap\\((${ID})\\)`, "gu");
  const use = one(ownMatches(copy, pattern), "search filter input");
  scope.requireImport(copy, use[2], use.index, ids.filter);
  const owner = scope.enclosingFunction(copy, use.index);
  shape(copy, "searchScope", owner.source);
  const roots = scope.context(copy).functions.filter(row => row.root && row.start <= owner.start && owner.end <= row.end);
  scope.reachable(copy, scope.publishedRootFunction(copy, "SettingsLayout"), one(roots, "search component root"));
  const body = owner.source;
  const query = one([...body.matchAll(new RegExp(`\\{data:(${ID})\\}=\\(0,(${ID})\\._U\\)\\((${ID})\\.u9,${escape(owner.params)}\\.selectedHostId\\)`, "gu"))], "search selected-host query");
  scope.requireImport(copy, query[2], owner.start + query.index, listAtoms);
  scope.requireImport(copy, query[3], owner.start + query.index, ids.list);
  const fallback = one([...body.matchAll(new RegExp(`\\((${ID})=void 0===${escape(query[1])}\\?\\[\\]:${escape(query[1])},`, "gu"))], "search list fallback");
  if (!body.includes(`let ${use[1]}=${fallback[1]}`)) fail("search query/list mismatch");
  scope.unshadowed(copy, use[3], use.index);
  const mapper = scope.stableRootFunction(copy, use[3]);
  const param = mapper.params;
  if (mapper.source !== `function ${mapper.name}(${param}){return[${param}.displayName??${param}.name,...null==${param}.description?[]:[${param}.description]]}`) fail("search term mapper");
  return { owner, mapper };
}

// Pure: prepare the complete physical filter cohort only after the native
// consumers, list/write owner, exclusions and readonly sources are qualified.
function prepareExperimentalFeaturesVisibility(cohort) {
  const roles = ["filter", "toggles", "search", "list", "barrel", "settings", "memory", "chronicle"];
  const ids = {};
  for (const role of roles) {
    const copies = cohort[role];
    if (!Array.isArray(copies) || !copies.length || new Set(copies.map(copy => copy.moduleId)).size !== 1 ||
        new Set(copies.map(copy => copy.assetName)).size !== copies.length) fail("missing/ambiguous " + role);
    ids[role] = copies[0].moduleId;
    for (const copy of copies) {
      if (copy.source.slice(copy.start, copy.end) !== copy.moduleSource) fail("stale " + role + " snapshot");
      scope.context(copy);
      scope.stableFactoryParameters(copy);
    }
  }
  const dependencies = {};
  for (const role of ["list", "barrel", "settings", "memory", "chronicle"]) dependencies[role] = cohort[role].map(copy => dependency(copy, role));
  for (const barrel of cohort.barrel) {
    const member = scope.publicationMember(barrel, "R1o"), match = new RegExp(`^\\(\\)=>(${ID})\\.R1$`, "u").exec(member.value);
    if (!match) fail("workspace barrel getter");
    scope.requireImport(barrel, match[1], member.start, ids.settings);
  }
  for (const list of dependencies.list) if (list.imports[4].moduleId !== ids.barrel || list.imports[7].moduleId !== ids.memory) fail("list dependency imports");
  const listAtoms = dependencies.list[0].imports[3].moduleId;
  if (dependencies.list.some(row => row.imports[3].moduleId !== listAtoms)) fail("different list atom imports");
  for (const copy of cohort.toggles) toggleProof(copy, ids, listAtoms);
  for (const copy of cohort.search) searchProof(copy, ids, listAtoms);
  const refs = { filterModuleId: ids.filter, imports: { api: ids.barrel, memory: ids.memory, chronicle: ids.chronicle } };
  const proofs = cohort.filter.map(copy => qualifiedFunction(copy, refs));
  if (proofs.some(proof => proof.patched !== proofs[0].patched)) fail("mixed canonical physical filters");
  const groups = new Map();
  for (const role of roles) for (const copy of cohort[role]) {
    const prior = groups.get(copy.assetName);
    if (prior && prior.source !== copy.source) fail("different asset snapshots");
    if (!prior) groups.set(copy.assetName, { assetName: copy.assetName, source: copy.source, patches: [] });
  }
  for (const [index, copy] of cohort.filter.entries()) {
    const proof = proofs[index];if (proof.patched) continue;
    const body = proof.body.replace(`&&"remote_control"!==${proof.role.feature}.name`, "") + `/*${MARKER}*/`;
    groups.get(copy.assetName).patches.push({ start: copy.start + proof.bounds[0], end: copy.start + proof.bounds[1], body });
  }
  const edits = [...groups.values()].map(group => {
    let patchedSource = group.source;
    for (const edit of group.patches.sort((a, b) => b.start - a.start)) patchedSource = patchedSource.slice(0, edit.start) + edit.body + patchedSource.slice(edit.end);
    return { assetName: group.assetName, source: group.source, patchedSource };
  });
  return { edits, moduleIds: ids, alreadyApplied: proofs[0].patched,
    dependencyAssets: [...groups.keys()].sort(), physicalFilterCopies: cohort.filter.length };
}

function locateExperimentalFeaturesVisibility(assetsDir) {
  const cohort = {};
  const needles = { filter: '"remote_control"', toggles: "settings.general.experimentalFeatures", search: "SettingsLayout", list: "experimentalFeature/list",
    barrel: "R1o:", settings: '"workspace_dependencies"', memory: '"memories"', chronicle: '"chronicle"' };
  for (const role of Object.keys(needles)) cohort[role] = findUniqueRspackModuleCopies(assetsDir, {
    description: "experimental feature " + role,
    sourceMatch: source => source.includes(needles[role]) || role === "filter" && source.includes(MARKER),
    matchModule: (body, copy) => {
      try {
        if (role === "filter") return /\{R:function\(/u.test(body) && body.includes('"multi_agent"') && body.includes('"realtime_"');
        if (role === "toggles") return body.includes("ConfigurationPanel:") && callbackProof(copy) != null;
        if (role === "search") return body.includes("SettingsLayout:") && /\.filter\([A-Za-z_$][\w$]*\.R\)\.flatMap\(/u.test(body);
        if (role === "list" && !['["experimental-features","list"]', 'method:"experimentalFeature/list"', '"config/batchWrite"', "jv:"].every(value => body.includes(value))) return false;
        if (role === "settings" && !['"default_mode_request_user_input"', 'R1:"workspace_dependencies"', "il:"].every(value => body.includes(value))) return false;
        if (role === "memory" && !["N:function", ".find(", ".name==="].every(value => body.includes(value))) return false;
        if (role === "chronicle" && !body.includes('c:"chronicle"')) return false;
        const key = role === "barrel" ? "R1o" : role === "settings" ? "R1" : role === "memory" ? "j" : role === "chronicle" ? "c" : "u9";
        if (!body.includes(key + ":")) return false;
        dependency(copy, role);return true;
      } catch { return false; }
    },
  });
  const prepared = prepareExperimentalFeaturesVisibility(cohort);let markers = 0;
  for (const name of listWebviewAssetFiles(assetsDir, /\.js$/u)) markers += fs.readFileSync(path.join(assetsDir, name), "utf8").split(MARKER).length - 1;
  if (markers !== (prepared.alreadyApplied ? cohort.filter.length : 0)) fail("orphan filter marker");
  return prepared;
}
function applyExperimentalFeaturesVisibility(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview/assets"), prepared = locateExperimentalFeaturesVisibility(assets);
  return { ...patchWebviewAssets(assets, prepared.edits, options), matched: true, moduleIds: prepared.moduleIds };
}
module.exports = { prepareExperimentalFeaturesVisibility, locateExperimentalFeaturesVisibility, applyExperimentalFeaturesVisibility };
