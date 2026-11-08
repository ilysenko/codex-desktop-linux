"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm");
const fixture = require("./fixtures/current-terminal-status.json");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { HELPER, prepareTerminalStatusModule: modulePlan, prepareTerminalStatusCohort: prepare } = require("./terminal-status-owner.js");
function groups() { return Object.fromEntries(fixture.modules.map(x => [x.role, [{ ...x, start: 0 }]])); }
function output(plan, field = "patchedSource") { return Object.fromEntries(Object.entries(plan.prepared).map(([k, rows]) => [k, rows.map(x => ({ ...x.copy, moduleSource: x[field] }))])); }
function change(g, role, from, to) {
  const row = g[role][0];assert.equal(row.moduleSource.split(from).length, 2);
  row.moduleSource = row.moduleSource.replace(from, to);return g;
}
function frame(source, header) {
  const matches = [...source.matchAll(header)];assert.equal(matches.length, 1);
  const m = matches[0], open = m.index + m[0].length - 1, end = createJavaScriptLexicalIndex(source).matchingBrace(open);
  assert.ok(end > open);return source.slice(m.index, end + 1);
}
function reducer(source) {
  const text = frame(source, /function m\(\{hasInProgressOwnedWork:[^}]+\}\)\{/gu);
  return vm.runInNewContext(`(${text})`);
}
function inputResolver(source) {
  const text = frame(source, /function\(\{mcpServerElicitationKind:[^}]+\}\)\{/gu);
  return vm.runInNewContext(`${HELPER};(${text})`, { l: { PZ: requests => requests.some(x => x.method === "approval"), w_: kind => kind === "approval" }, m: kind => kind === "mcpServerElicitation" ? "mcp" : "approval" });
}

test("three native keyed status modules prepare as one contribution with exact inverse and replay", () => {
  const g = groups(), first = prepare(g), second = prepare(output(first));
  assert.equal(first.state, "pristine");assert.equal(second.state, "patched");
  assert.deepEqual(output(first), output(second));assert.deepEqual(output(first, "nativeSource"), g);
  assert.deepEqual(first.rows.map(x => Buffer.byteLength(x.patchedSource) - Buffer.byteLength(x.nativeSource)), [1174, 522, 493]);
  const bundle = rows => "export const __webpack_modules__={" + Object.values(rows).map(([x]) => `${x.moduleId}(${x.params.join(",")}){${x.moduleSource}}`).join(",") + "};";
  assert.equal(require("node:crypto").createHash("sha256").update(bundle(output(first))).digest("hex"), fixture.legacyPatchedBundleSha256, "runtime edits preserve the current established business byte-for-byte");
});

test("native reducer keeps terminal priorities and only settles stale pending-input flags", () => {
  const p = prepare(groups()).prepared.terminal[0], status = reducer(p.patchedSource), native = reducer(p.nativeSource);
  const active = activeFlags => ({ type: "active", activeFlags });
  for (const [value, expected] of [
    [{ threadRuntimeStatus: active(["waitingOnUserInput"]), hasUserInputRequest: false }, "idle"],
    [{ threadRuntimeStatus: active(["waitingOnUserInput"]), hasUserInputRequest: true }, "loading"],
    [{ threadRuntimeStatus: active(["waitingOnUserInput"]) }, "loading"],
    [{ threadRuntimeStatus: active([]), hasUserInputRequest: false }, "idle"],
    [{ threadRuntimeStatus: active(["running"]), hasUserInputRequest: false }, "loading"],
    [{ threadRuntimeStatus: { type: "active" }, hasUserInputRequest: false }, "loading"],
    [{ hasInProgressOwnedWork: true, threadRuntimeStatus: { type: "systemError" } }, "loading"],
    [{ threadRuntimeStatus: { type: "systemError" }, resumeState: "needs_resume" }, "error"],
    [{ resumeState: "needs_resume", latestTurnHasSystemError: true }, "idle"],
    [{ latestTurnHasSystemError: true }, "error"],
    [{ isResponseInProgress: true, threadRuntimeStatus: active(["waitingOnUserInput"]), hasUserInputRequest: false }, "loading"],
  ]) assert.equal(status(value), expected, JSON.stringify(value));
  for (const value of [{}, { latestTurnHasSystemError: true }, { isResponseInProgress: true }, { resumeState: "needs_resume" }, { threadRuntimeStatus: { type: "systemError" } }]) assert.equal(status(value), native(value));
});

test("pending input helper preserves supported request kinds and rejects foreign or missing requests", () => {
  const pending = vm.runInNewContext(`(${HELPER})`);
  for (const method of ["item/tool/requestUserInput", "item/tool/requestOptionPicker", "item/tool/requestSetupCodexContextPicker"]) assert.equal(pending([{ method }]), true);
  for (const tool of ["request_onboarding_input", "request_option_picker", "setup_codex_context_picker", "setup_codex_step"]) assert.equal(pending([{ method: "item/tool/call", params: { tool } }]), true);
  for (const value of [undefined, null, [], {}, [null], [{ method: "approval" }], [{ method: "item/tool/call", params: { tool: "other" } }]]) assert.equal(pending(value), false);
});

test("native pending-input resolver preserves MCP/approval priorities while clearing stale user input", () => {
  const p = prepare(groups()).prepared.pendingInput[0], resolve = inputResolver(p.patchedSource), native = inputResolver(p.nativeSource);
  const base = { requests: [], resumeState: "needs_resume", threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnUserInput"] }, userInputRequestId: "thread-request" };
  assert.equal(resolve(base), null);assert.equal(native(base).kind, "input");
  assert.equal(resolve({ ...base, requests: [{ method: "item/tool/requestUserInput" }] }).requestId, "thread-request");
  for (const value of [
    { ...base, requests: null },
    { ...base, requests: [{ method: "approval" }], threadRuntimeStatus: { type: "active", activeFlags: ["waitingOnApproval"] } },
    { ...base, pendingRequestType: "mcpServerElicitation", mcpServerElicitationKind: "formElicitation" },
    { ...base, resumeState: "ready", pendingRequestType: "userInput" },
  ]) assert.deepEqual(JSON.parse(JSON.stringify(resolve(value))), JSON.parse(JSON.stringify(native(value))));
});

test("native caller links keep one reducer, pending owner and host/thread state provider", () => {
  assert.throws(() => prepare(change(groups(), "statusCaller", 'l=n("EU9a")', 'l=n("foreign")')), /foreign reducer/);
  assert.throws(() => prepare(change(groups(), "statusCaller", 'u=n("sZJm")', 'u=n("foreign")')), /foreign reducer/);
  assert.throws(() => prepare(change(groups(), "pendingInput", 's=n("tl5a")', 's=n("foreign")')), /different host\/thread/);
  assert.throws(() => prepare(change(groups(), "statusCaller", 'hostId:n,threadId:r', 'hostId:r,threadId:n')), /complete small native/);
  const missing = groups();delete missing.pendingInput;assert.throws(() => prepare(missing), /missing or ambiguous/);
});

test("all physical modules agree on native imports and share the atom factory and scope", () => {
  assert.throws(() => prepare(change(groups(), "pendingInput", 'p=n("OWtl")', 'p=n("foreignScope")')), /different native atom factory or scope/);
  const peers = groups();peers.terminal.push({ ...peers.terminal[0], moduleSource: peers.terminal[0].moduleSource.replace('a=n("zTeN")', 'a=n("foreignAtoms")') });
  assert.throws(() => prepare(peers), /inconsistent native provider identities/);
});

test("complete native grammar, intrinsic authority and canonical output reject partial or malformed peers", () => {
  assert.throws(() => prepare(change(groups(), "statusCaller", 'new Map', 'new WeakMap')), /complete small native/);
  assert.throws(() => prepare(change(groups(), "terminal", 'return e?"loading"', 'return e?"idle"')), /complete small native|complete terminal/);
  assert.throws(() => prepare(change(groups(), "terminal", 'sX:m', 'sX:n')), /complete small native/);
  const marked = output(prepare(groups()));assert.throws(() => prepare(change(marked, "statusCaller", HELPER, "")), /partial helper/);
  const partial = output(prepare(groups()));partial.pendingInput = groups().pendingInput;assert.throws(() => prepare(partial), /partial terminal contribution/);
  const mixed = groups();mixed.terminal.push({ ...mixed.terminal[0], moduleSource: output(prepare(groups())).terminal[0].moduleSource });assert.throws(() => prepare(mixed), /mixed physical peer/);
  const bad = groups();bad.terminal.push({ ...bad.terminal[0], moduleSource: bad.terminal[0].moduleSource + ';function* m(){return null}' });assert.throws(() => prepare(bad), /complete small native/);
  const cap = groups().terminal[0];assert.throws(() => modulePlan({ ...cap, moduleSource: cap.moduleSource + "/*" + "x".repeat(16 * 1024) + "*/" }, "terminal"), /bounded small native/);
});
