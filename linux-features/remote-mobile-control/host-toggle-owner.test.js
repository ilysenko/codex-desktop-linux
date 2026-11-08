"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/current-host-toggle.json");
const { MARKER, inspectHostToggle, prepareHostToggle } = require("./host-toggle-owner.js");
const rows = fixture.modules.filter(row => row.moduleId === "WbV5");

function prepare(row, source = row.moduleSource) {
  return prepareHostToggle(source, { ...row, moduleSource: source });
}

// Execute only the 341-byte native request adapter with injected providers.
// This does not instantiate the Desktop app, a vendor module or a real RPC.
function callback(row, source, { initial = null, latest = initial, reply = { status: "connecting" },
  requestError = null } = {}) {
  const proof = inspectHostToggle({ ...row, moduleSource: source });
  assert.equal(proof.ok, true, proof.reason);
  const requests = [], writes = [], selections = [], reads = [];
  const atom = {}, store = { get(actual, host) { reads.push(host); assert.equal(actual, atom);
    return reads.length === 1 ? initial : latest; } };
  const status = { [proof.status.atomExport]: atom,
    [proof.status.writeExport](actualStore, host, state) { writes.push([actualStore, host, state]); } };
  const client = { [proof.client.exportName](actualStore, host) {
    selections.push([actualStore, host]);
    return { async sendRequest(method, params) {
      requests.push([method, params]); if (requestError) throw requestError; return reply;
    } };
  } };
  const exports = {}, loader = id => {
    if (id === proof.client.moduleId) return client;
    if (id === proof.status.moduleId) return status;
    throw Error(`Unexpected controlled provider ${id}`);
  };
  loader.d = (target, getters, values) => {
    assert.deepEqual(getters, {}); Object.assign(target, values);
  };
  new Function(...row.params, source)({}, exports, loader);
  return { invoke: (enabled, options) => exports[proof.publication.exportName](store, "selected-host", enabled, options),
    requests, writes, selections, reads, store, reply };
}

test("current native host-toggle copies prepare, invert and replay with the same selected host", async () => {
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const plan = prepare(row);
    assert.equal(plan.state, "pristine");
    assert.equal(plan.patchedSource.length - plan.nativeSource.length, 48);
    const repeat = prepare(row, plan.patchedSource);
    assert.equal(repeat.state, "patched");
    assert.equal(repeat.patchedSource, plan.patchedSource);
    assert.equal(repeat.nativeSource, row.moduleSource);
    assert(Object.isFrozen(repeat.proof.arguments));
    for (const enabled of [true, false]) {
      const run = callback(row, plan.patchedSource);
      assert.equal(await run.invoke(enabled), run.reply);
      assert.deepEqual(run.requests, [[enabled ? "remoteControl/enable" : "remoteControl/disable", undefined]]);
      assert.deepEqual(run.selections, [[run.store, "selected-host"]]);
      assert.deepEqual(run.reads, ["selected-host", "selected-host"]);
      assert.deepEqual(run.writes, [[run.store, "selected-host", run.reply]]);
    }
  }
});

test("native current-generation and later connected/error status take precedence unchanged", async () => {
  for (const row of rows) {
    const source = prepare(row).patchedSource;
    for (const status of ["connected", "errored"]) {
      const run = callback(row, source, { initial: { status: "connecting" }, latest: { status } });
      await run.invoke(true);
      assert.equal(run.writes.length, 0);
    }
    const retired = callback(row, source);
    await retired.invoke(true, { shouldApplyStatus: () => false });
    assert.equal(retired.writes.length, 0);
    const disabled = callback(row, source, { initial: null, latest: { status: "connected" } });
    await disabled.invoke(false);
    assert.deepEqual(disabled.writes, [[disabled.store, "selected-host", disabled.reply]]);
    const error = Error("controlled RPC failure"), failed = callback(row, source, { requestError: error });
    await assert.rejects(failed.invoke(true), value => value === error);
    assert.equal(failed.writes.length, 0);
  }
});

test("opaque, wrong-host, shadowed-provider and altered protocol bodies cannot qualify", () => {
  const row = rows[0], source = row.moduleSource;
  const bad = [
    `/*${source}*/`,
    `const data=${JSON.stringify(source)};`,
    `function unused(){${source}}`,
    source.replace("n.d(t,", "n.d(e,"),
    source.replace("(0,a.V)(e,t)", '(0,a.V)(e,"other-host")'),
    source.replace("(0,i.Lt)(e,t,o)", '(0,i.Lt)(e,"other-host",o)'),
    source.replace("async function(e,t,n,", "async function(e,t,a,").replace("sendRequest(n?", "sendRequest(a?").replace("||n&&c||", "||a&&c||"),
    source.replace("return!r()", "return\n!r()"),
    source.replace("shouldApplyStatus:r=()=>!0", "shouldApplyStatus:r=()=>!1"),
  ];
  for (const input of bad) assert.throws(() => prepare(row, input), undefined, input);
  assert.throws(() => prepareHostToggle(source, { ...row, moduleSource: source + ";" }), /stale/);
});

test("canonical marker alone, altered void value or added writes cannot approve already state", () => {
  const row = rows[0], source = prepare(row).patchedSource;
  for (const input of [source.replace("void 0", "void 1"), source.replace(MARKER, MARKER + "Extra"),
    source + ";foreignWrite();", source.replace(`void 0/*${MARKER}*/`, `null/*${MARKER}*/`)]) {
    assert.throws(() => prepare(row, input));
  }
});
