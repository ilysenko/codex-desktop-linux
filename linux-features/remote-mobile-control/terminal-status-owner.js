"use strict";

const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackRequireBinding } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { hasStableEagerMainBinding } = require("../../scripts/patches/lib/main-request-sites.js");
const { normalized } = require("./remote-copy-scope.js");
const shapes = require("./terminal-status-shapes.js");

const ID = "[A-Za-z_$][\\w$]*";
const INPUT = "codexLinuxRemoteHasUserInputRequest";
const TERMINAL = "codexLinuxRemoteTerminalStatus";
const HELPER = "function codexLinuxRemoteHasUserInputRequest(e){try{return Array.isArray(e)&&e.some(e=>e?.method===`item/tool/requestUserInput`||e?.method===`item/tool/requestOptionPicker`||e?.method===`item/tool/requestSetupCodexContextPicker`||e?.method===`item/tool/call`&&(e?.params?.tool===`request_onboarding_input`||e?.params?.tool===`request_option_picker`||e?.params?.tool===`setup_codex_context_picker`||e?.params?.tool===`setup_codex_step`))}catch{return!1}}";
const MAX_BYTES = 16 * 1024;
function fail(message) { throw Error(`Remote terminal status: ${message}`); }
function one(rows, message) { if (rows.length !== 1) fail(message); return rows[0]; }
function count(source, text) { return source.split(text).length - 1; }
function syntax(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 || new Set(copy.params).size !== 3 || copy.params.some(x => !new RegExp(`^${ID}$`, "u").test(x)) || Buffer.byteLength(copy.moduleSource ?? "") > MAX_BYTES) fail("bounded small native module");
  new Script(`function terminalStatusModule(${copy.params.join(",")}){${copy.moduleSource}\n}`);
}

function nativeTerminal(r) {
  return `function ${r.fn}({hasInProgressOwnedWork:${r.owned},isResponseInProgress:${r.progress},latestTurnHasSystemError:${r.error},resumeState:${r.resume},threadRuntimeStatus:${r.runtime}}){return ${r.owned}?"loading":${r.runtime}?.type==="systemError"?"error":${r.runtime}?.type==="active"?"loading":"needs_resume"===${r.resume}?"idle":${r.error}?"error":!0===${r.progress}?"loading":"idle"}`;
}
function patchedTerminal(r) {
  return `function ${r.fn}({hasInProgressOwnedWork:${r.owned},isResponseInProgress:${r.progress},latestTurnHasSystemError:${r.error},resumeState:${r.resume},threadRuntimeStatus:${r.runtime},hasUserInputRequest:codexLinuxRemoteHasUserInputRequestPending=!0}){` +
    `let codexLinuxRemoteTerminalStatusActive=${r.runtime}?.type==="active",` +
    `codexLinuxRemoteTerminalStatusActiveFlags=Array.isArray(${r.runtime}?.activeFlags)?${r.runtime}.activeFlags:null,` +
    `codexLinuxRemoteTerminalStatusWaitingOnUserInput=codexLinuxRemoteTerminalStatusActiveFlags?.includes("waitingOnUserInput")===!0,` +
    `codexLinuxRemoteTerminalStatusLoading=codexLinuxRemoteTerminalStatusActive&&(${r.progress}===!0||codexLinuxRemoteTerminalStatusActiveFlags==null||codexLinuxRemoteTerminalStatusActiveFlags.length>0&&(!codexLinuxRemoteTerminalStatusWaitingOnUserInput||codexLinuxRemoteHasUserInputRequestPending===!0));` +
    `return ${r.owned}?"loading":${r.runtime}?.type==="systemError"?"error":codexLinuxRemoteTerminalStatusLoading?"loading":"needs_resume"===${r.resume}?"idle":${r.error}?"error":!0===${r.progress}?"loading":"idle"}`;
}
function terminalFrame(source, patched) {
  const extra = patched ? ",hasUserInputRequest:codexLinuxRemoteHasUserInputRequestPending=!0" : "";
  const header = new RegExp(String.raw`function (?<fn>${ID})\(\{hasInProgressOwnedWork:(?<owned>${ID}),isResponseInProgress:(?<progress>${ID}),latestTurnHasSystemError:(?<error>${ID}),resumeState:(?<resume>${ID}),threadRuntimeStatus:(?<runtime>${ID})${escapeRegExp(extra)}\}\)\{`, "gu");
  const code = createJavaScriptLexicalIndex(source);
  const match = one([...source.matchAll(header)].filter(x => code.isRoot(x.index)), "native terminal reducer declaration");
  const open = match.index + match[0].length - 1, end = code.matchingBrace(open);
  const actual = source.slice(match.index, end + 1), expected = patched ? patchedTerminal(match.groups) : nativeTerminal(match.groups);
  if (end <= open || actual !== expected) fail("changed complete terminal reducer");
  return { index: match.index, end: end + 1, source: actual, roles: match.groups };
}
function callPattern(patched) {
  const extra = patched ? String.raw`,hasUserInputRequest:${INPUT}\(\k<state>\?\.requests\)` : "";
  return new RegExp(String.raw`hasInProgressOwnedWork:[^{}]*latestTurnHasSystemError:(?<state>${ID})\?\.latestTurnError!=null${extra}(?=\}\))`, "gu");
}
function pendingPattern(patched) {
  const extra = patched ? String.raw`&&${INPUT}\(\k<requests>\)` : "";
  return new RegExp(String.raw`(?<native>"needs_resume"===${ID}\?(?<runtime>${ID})\?\.type==="active"&&\k<runtime>\.activeFlags\.includes\("waitingOnApproval"\)&&\(0,${ID}\.${ID}\)\((?<requests>${ID})\)\?\{blocking:!0,kind:"approval",source:${ID}\(${ID}\)\}:\k<runtime>\?\.type==="active"&&\k<runtime>\.activeFlags\.includes\("waitingOnUserInput"\))${extra}(?=\?\{autoResolution:null,blocking:!0,kind:"input",requestId:${ID},source:"userInput"\}:null:)`, "gu");
}
function transform(source, role, inverse = false) {
  const edits = [], code = createJavaScriptLexicalIndex(source);
  if (role === "terminal") {
    const fn = terminalFrame(source, inverse);
    edits.push({ start: fn.index, end: fn.end, text: inverse ? nativeTerminal(fn.roles) : patchedTerminal(fn.roles) });
  }
  if (role === "terminal" || role === "statusCaller") {
    const m = one([...source.matchAll(callPattern(inverse))].filter(x => code.isCode(x.index)), "one native keyed status caller");
    const extra = `,hasUserInputRequest:${INPUT}(${m.groups.state}?.requests)`;
    edits.push({ start: m.index, end: m.index + m[0].length, text: inverse ? m[0].slice(0, -extra.length) : m[0] + extra });
  } else {
    const m = one([...source.matchAll(pendingPattern(inverse))].filter(x => code.isCode(x.index + '"needs_resume"'.length)), "one native pending-input branch");
    edits.push({ start: m.index, end: m.index + m[0].length, text: m.groups.native + (inverse ? "" : `&&${INPUT}(${m.groups.requests})`) });
  }
  return edits.sort((a, b) => b.start - a.start).reduce((s, e) => s.slice(0, e.start) + e.text + s.slice(e.end), source);
}
function importedRole(copy, local) {
  const binding = findRspackRequireBinding(copy, local);
  if (!binding || binding.requireName !== copy.params[2]) fail("captured native factory import");
  const start = binding.start - copy.start, end = binding.end - copy.start;
  const projected = copy.moduleSource.slice(0, start) + local + copy.moduleSource.slice(end);
  if (!hasStableEagerMainBinding(projected, local)) fail("eager native provider replacement");
  return Object.freeze(binding);
}
function qualify(copy, role) {
  syntax(copy);
  if (!Object.hasOwn(shapes, role)) fail("unknown native module role");
  const a = normalized(copy), b = normalized(shapes[role]);
  if (a.text !== b.text || a.imports.length !== b.imports.length) fail("changed complete small native module");
  // Source normalization is only a template comparison. The actual import
  // declarations and globals used by emitted/runtime code retain authority.
  const imports = a.imports.map(x => importedRole(copy, x.local));
  try { new Script(`function terminalIntrinsics(${copy.params.join(",")}){${copy.moduleSource}\n;let Array;let Map;}`); }
  catch { fail("captured native or helper intrinsic"); }
  const index = expected => b.imports.findIndex(x => x.local === expected);
  const get = expected => imports[index(expected)];
  const proof = { role, moduleId: copy.moduleId, imports: Object.freeze(imports) };
  proof.atomFactory = get("a");
  proof.atomScope = get(role === "terminal" ? "d" : role === "statusCaller" ? "c" : "p");
  if (role === "terminal") {
    const reducer = terminalFrame(copy.moduleSource, false), pub = findRspackExportPublication(copy, "sX");
    if (pub?.expression !== reducer.roles.fn) fail("native terminal publication");
    proof.reducerExport = "sX";proof.reducerName = reducer.roles.fn;proof.threadState = get("o");
  } else if (role === "statusCaller") {
    proof.terminal = get("l");proof.pendingInput = get("u");proof.threadState = get("s");
  } else {
    if (findRspackExportPublication(copy, "Z")?.expression == null) fail("native pending-input publication");
    proof.threadState = get("s");
  }
  if (!proof.threadState) fail("missing host/thread state provider");
  return Object.freeze(proof);
}
function prepareTerminalStatusModule(copy, role) {
  syntax(copy);
  const marked = copy.moduleSource.includes(INPUT) || copy.moduleSource.includes(TERMINAL);
  let nativeSource = copy.moduleSource;
  if (marked) {
    if (!nativeSource.startsWith(HELPER) || count(nativeSource, HELPER) !== 1) fail("partial helper contribution");
    nativeSource = transform(nativeSource.slice(HELPER.length), role, true);
  }
  const native = { ...copy, moduleSource: nativeSource }, proof = qualify(native, role);
  const patchedSource = HELPER + transform(nativeSource, role);
  syntax({ ...copy, moduleSource: patchedSource });
  if (marked && patchedSource !== copy.moduleSource) fail("canonical inverse and replay");
  if (transform(patchedSource.slice(HELPER.length), role, true) !== nativeSource) fail("exact native inverse");
  return Object.freeze({ proof, nativeSource, patchedSource, state: marked ? "patched" : "pristine" });
}
function prepareTerminalStatusCohort(groups) {
  const prepared = {};
  for (const role of Object.keys(shapes)) {
    const copies = groups[role];
    if (!Array.isArray(copies) || copies.length === 0 || new Set(copies.map(x => x.moduleId)).size !== 1) fail("missing or ambiguous native role " + role);
    const rows = copies.map(x => ({ copy: x, ...prepareTerminalStatusModule(x, role) }));
    if (new Set(rows.map(x => x.state)).size !== 1) fail("mixed physical peer application state");
    const ids = rows[0].proof.imports.map(x => x.moduleId);
    if (rows.some(row => row.proof.imports.some((x, i) => x.moduleId !== ids[i]))) fail("inconsistent native provider identities across physical peers");
    prepared[role] = rows;
  }
  const all = Object.values(prepared).flat();
  if (new Set(all.map(x => x.state)).size !== 1) fail("partial terminal contribution across roles");
  const terminalId = prepared.terminal[0].copy.moduleId, pendingId = prepared.pendingInput[0].copy.moduleId;
  const threadStateId = prepared.terminal[0].proof.threadState.moduleId;
  const first = prepared.terminal[0].proof;
  if (terminalId === pendingId || new Set(Object.values(prepared).map(x => x[0].copy.moduleId)).size !== 3) fail("native role identity collision");
  for (const row of all) {
    if (row.proof.threadState.moduleId !== threadStateId) fail("different host/thread state provider");
    if (row.proof.atomFactory?.moduleId !== first.atomFactory?.moduleId || row.proof.atomScope?.moduleId !== first.atomScope?.moduleId) fail("different native atom factory or scope");
    if (row.proof.role === "statusCaller" && (row.proof.terminal?.moduleId !== terminalId || row.proof.pendingInput?.moduleId !== pendingId)) fail("foreign reducer or pending-input provider");
  }
  return Object.freeze({ prepared: Object.freeze(prepared), rows: Object.freeze(all), state: all[0].state });
}
module.exports = { HELPER, INPUT, TERMINAL, MAX_BYTES, prepareTerminalStatusModule, prepareTerminalStatusCohort };
