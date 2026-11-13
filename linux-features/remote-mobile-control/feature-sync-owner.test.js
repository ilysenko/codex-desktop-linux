"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), test = require("node:test");
const { prepareFeatureSyncSource: prepare, applyFeatureSyncToExtractedApp: apply, HELPER } = require("./feature-sync-owner.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const h = require("./fixtures/feature-sync-harness.js");
const clean = value => JSON.parse(JSON.stringify(value));
const patched = () => prepare(h.fixture()).patchedSource;
function reject(source, label) { assert.throws(() => prepare(source), /Unsupported current Remote feature-sync contract/, label); }
function deferred() { let resolve;const promise = new Promise(done => { resolve = done; });return { promise, resolve }; }
function app(fn, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-feature-sync-")), build = path.join(root, ".vite/build");fs.mkdirSync(build, { recursive: true });
  const sources = files ?? Object.fromEntries(Array.from({ length: 21 }, (_, index) => [index ? `early-bootstrap-${index}-feedface.js` : "early-bootstrap-920-deadbeef.js", index ? `exports.ids=[${index}],exports.modules={${index}(e){e.exports=true}};` : h.fixture()]));
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(build, name), source, { mode: 0o640 });
  try { return fn({ root, build, sources }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("qualified native class, live startup and exact request replay retain all outside bytes", () => {
  const source = h.fixture(), first = prepare(source), repeat = prepare(first.patchedSource);
  assert.equal(first.state, "current");assert.equal(repeat.state, "patched");assert.equal(first.proof.ownerBytes, 4155);assert.equal(first.proof.factoryId, "26307");
  assert.equal(Buffer.byteLength(first.patchedSource) - Buffer.byteLength(source), 192);
  assert.equal(repeat.nativeSource, source);assert.equal(repeat.patchedSource, first.patchedSource);
  const call = first.proof.nativeCall, replacement = call.replace("{enablement:i}", "{enablement:codexLinuxRemoteControlFeatureSyncEnabled(i,e.connection.hostId)}");
  assert.equal(first.patchedSource, source.slice(0, first.proof.ownerStart) + HELPER + source.slice(first.proof.ownerStart, first.proof.callStart) + replacement + source.slice(first.proof.callStart + call.length));
  assert.ok(first.patchedSource.includes(h.native.startup));assert.ok(first.patchedSource.includes(h.native.prelude));
});

test("the existing helper clones only Linux literal local-host enablement and preserves other identities", () => {
  const input = Object.freeze({ memories: false, remote_control: false, other: Object.freeze({ native: true }) });
  for (const platform of ["linux", "darwin", "win32"]) for (const host of ["local", "ssh:host", "wsl:host", "cloud", "Local", undefined]) {
    const output = h.helper(platform)(input, host);
    if (platform === "linux" && host === "local") { assert.notEqual(output, input);assert.equal(output.remote_control, true);assert.equal(output.other, input.other);assert.equal(output.memories, false); }
    else assert.equal(output, input);
  }
  assert.equal(input.remote_control, false);
});

test("selected sendEnablement keeps every native flag and ack policy across platforms and hosts", async () => {
  const source = patched();
  for (const platform of ["linux", "darwin", "win32"]) for (const host of ["local", "ssh:host", "wsl:host", "cloud"]) {
    const baseline = h.scene(h.native.owner, { platform, host }), changed = h.scene(source, { platform, host }), assignments = JSON.stringify(changed.state.assignment);
    await baseline.run();await changed.run();
    const nativeFlags = baseline.calls[0].args.enablement, actual = changed.calls[0].args.enablement;
    assert.deepEqual(clean(actual), { ...clean(nativeFlags), ...(platform === "linux" && host === "local" ? { remote_control: true } : {}) });
    assert.deepEqual(changed.calls.map(call => call.method), ["experimentalFeature/enablement/set"]);
    assert.equal(actual.unrelated, undefined);assert.equal(actual.auth_elicitation, false);assert.equal(actual.memories, false);assert.equal(actual.mcp_connection_sharing, false);
    assert.equal(JSON.stringify(changed.state.assignment), assignments);assert.deepEqual(changed.trace, baseline.trace);
    for (const field of ["generation", "supportsPropagation", "acknowledgedGeneration", "acknowledgedEnrollment", "rolloutCompressionRequested"]) assert.equal(changed.record[field], baseline.record[field], field);
  }
});

test("current native MCP lazy startup flag preserves strict boolean selection across platforms and hosts", async () => {
  const source = patched();
  for (const platform of ["linux", "darwin", "win32"]) for (const host of ["local", "ssh:host", "cloud"]) {
    for (const value of [undefined, true, false, 1, "true", null]) {
      const baseline = h.scene(h.native.owner, { platform, host }), changed = h.scene(source, { platform, host });
      baseline.state.assignment.defaultEnableFeatures.mcp_lazy_stdio_startup = value;
      changed.state.assignment.defaultEnableFeatures.mcp_lazy_stdio_startup = value;
      const original = JSON.stringify(changed.state.assignment);
      await baseline.run();await changed.run();
      assert.equal(changed.calls[0].args.enablement.mcp_lazy_stdio_startup, value === true);
      assert.deepEqual(clean(changed.calls[0].args.enablement), {
        ...clean(baseline.calls[0].args.enablement),
        ...(platform === "linux" && host === "local" ? { remote_control: true } : {}),
      });
      assert.equal(JSON.stringify(changed.state.assignment), original);
    }
  }
  for (const replacement of ["mcp_lazy_stdio_startup:e.mcp_lazy_stdio_startup", "mcp_lazy_stdio_startup:!1"]) {
    reject(h.fixture().replace("mcp_lazy_stdio_startup:!0===e.mcp_lazy_stdio_startup", replacement), replacement);
  }
  reject(h.fixture().replace(",mcp_lazy_stdio_startup:!0===e.mcp_lazy_stdio_startup", ""), "retired owner without native MCP flag");
});

test("disposed, missing assignments and stale generations send no request or ack", async () => {
  const source = patched();
  for (const change of [scene => { scene.self.disposed = true; }, scene => { scene.record.generation = 2; }, scene => { scene.state.assignment = null; }, scene => { scene.state.assignment.defaultEnableFeatures = null; }]) {
    const scene = h.scene(source);change(scene);await scene.self.sendEnablement(scene.record, 1);assert.equal(scene.calls.length, 0);assert.equal(scene.record.acknowledgedGeneration, null);assert.equal(scene.trace.some(row => Array.isArray(row) && row[0] === "clear"), false);
  }
  for (const cancel of [scene => { scene.record.generation++; }, scene => { scene.self.disposed = true; }]) {
    const wait = deferred(), scene = h.scene(source, { assignmentPromise: wait.promise }), task = scene.run();cancel(scene);wait.resolve(scene.state.assignment);await task;assert.equal(scene.calls.length, 0);assert.equal(scene.record.acknowledgedGeneration, null);
  }
});

test("ready-assignment guard, current map identity and same generation still control acknowledgement", async () => {
  const source = patched(), loading = h.scene(source);loading.state.ready = { changed: true };
  await assert.rejects(loading.run(), loading.NotReady);assert.equal(loading.calls.length, 0);assert.equal(loading.record.acknowledgedGeneration, null);
  for (const kind of ["generation", "identity", "disposed"]) {
    const wait = deferred(), scene = h.scene(source);scene.state.responsePromise = wait.promise;const task = scene.run();await new Promise(setImmediate);
    assert.equal(scene.calls.length, 1);
    if (kind === "generation") scene.record.generation++;else if (kind === "identity") scene.self.connections.set(scene.record.connection.hostId, { replacement: true });else scene.self.disposed = true;
    wait.resolve(scene.state.response);await task;assert.equal(scene.record.acknowledgedGeneration, null);assert.equal(scene.trace.some(row => Array.isArray(row) && row[0] === "changed"), false);
    assert.equal(scene.record.supportsPropagation, kind === "generation" ? true : null);
  }
});

test("native unsupported-method and arbitrary errors retain their distinct ack behavior", async () => {
  const source = patched();
  for (const current of [h.native.owner, source]) {
    const unsupported = h.scene(current);unsupported.state.error = { unsupported: true };await unsupported.run();assert.equal(unsupported.record.supportsPropagation, false);assert.equal(unsupported.record.acknowledgedGeneration, 1);assert.equal(unsupported.record.acknowledgedEnrollment, true);
    const failed = h.scene(current), error = Error("controlled request error");failed.state.error = error;await assert.rejects(failed.run(), value => value === error);assert.equal(failed.record.supportsPropagation, null);assert.equal(failed.record.acknowledgedGeneration, null);
  }
});

test("native compression and prewarm callbacks keep their request and generation guards", async () => {
  for (const source of [h.native.owner, patched()]) {
    const scene = h.scene(source, { compression: true });await scene.run();await Promise.resolve();await Promise.resolve();
    assert.deepEqual(scene.calls.map(row => row.method).sort(), ["config/read", "experimentalFeature/enablement/set", "rollout/compress"].sort());assert.equal(scene.record.rolloutCompressionRequested, true);
    assert.deepEqual(clean(scene.calls.find(row => row.method === "config/read").args), { includeLayers: false });assert.equal(scene.calls.find(row => row.method === "rollout/compress").args, undefined);
    assert.equal(scene.trace.filter(row => Array.isArray(row) && row[0] === "clear").length, 1);
  }
});

test("selected native constructor retains initial ack state and live policy/connection/preparation callbacks", () => {
  const events = [], slots = {}, scene = h.scene(patched()), self = { disposed: false, connections: new Map(), sync: record => events.push(record) };
  const registry = { subscribe(callback) { slots.registry = callback;return () => events.push("unwatch-registry"); } }, evaluations = { onDidChange(callback) { slots.policy = callback;return () => events.push("unwatch-policy"); } };
  const connection = { registerInternalConnectionStateHandler(callback) { slots.state = callback;return () => events.push("stop-state"); }, setThreadStartPreparation(policy) { slots.preparation = policy;return () => events.push("stop-preparation"); } };
  scene.make("constructor").call(self, registry, evaluations, () => {}, () => {});slots.registry({ hostId: "cloud", type: "added", connection });assert.equal(self.connections.size, 0);
  slots.registry({ hostId: "local", type: "added", connection });const record = self.connections.get("local");assert.equal(record.connection, connection);assert.equal(record.generation, 0);assert.equal(record.acknowledgedGeneration, null);assert.equal(record.supportsPropagation, null);assert.equal(record.acknowledgedEnrollment, false);assert.equal(record.rolloutCompressionRequested, false);
  assert.deepEqual(clean(slots.preparation.read()), { prewarmPolicy: "disabled", enrolled: false });
  record.supportsPropagation = false;assert.deepEqual(clean(slots.preparation.read()), { prewarmPolicy: "legacy" });
  record.supportsPropagation = true;record.acknowledgedGeneration = 0;assert.deepEqual(clean(slots.preparation.read()), { prewarmPolicy: "unenrolled", enrolled: false });
  record.acknowledgedEnrollment = true;assert.deepEqual(clean(slots.preparation.read()), { prewarmPolicy: "disabled", enrolled: true });
  record.generation++;assert.deepEqual(clean(slots.preparation.read()), { prewarmPolicy: "disabled", enrolled: false });slots.state();slots.policy();assert.equal(events.filter(row => row === record).length, 3);
  slots.registry({ hostId: "local", type: "removed" });assert.equal(self.connections.size, 0);assert.equal(record.generation, 2);assert.ok(events.includes("stop-state"));assert.ok(events.includes("stop-preparation"));
});

test("selected native sync resets disconnected state and retains not-ready warning suppression", async () => {
  const source = patched(), scene = h.scene(source);scene.record.generation = 9;scene.record.acknowledgedGeneration = 9;scene.record.supportsPropagation = true;scene.record.rolloutCompressionRequested = true;scene.state.connectionState = "disconnected";scene.sync();
  assert.equal(scene.record.generation, 1);assert.equal(scene.record.supportsPropagation, null);assert.equal(scene.record.acknowledgedGeneration, null);assert.equal(scene.record.rolloutCompressionRequested, false);assert.equal(scene.calls.length, 0);
  for (const kind of ["not-ready", "failure"]) {
    const next = h.scene(source), error = kind === "not-ready" ? new next.NotReady({ reason: "loading" }) : Error("controlled sync failure");next.self.sendEnablement = async () => { throw error; };next.sync();await new Promise(setImmediate);assert.equal(next.trace.filter(row => Array.isArray(row) && row[0] === "warning").length, kind === "not-ready" ? 0 : 1);
  }
});

test("changed native lifecycle, eligibility, callback or owner grammar refuses before editing", () => {
  const source = h.fixture();for (const [from, to] of [
    ['e.generation!==t', 'e.generation===t'], ['this.connections.get(e.connection.hostId)!==e', 'this.connections.get(e.connection.hostId)===e'], ['readReadyExecutionAssignments()', 'readExecutionAssignments()'], ['acknowledgedGeneration:null', 'acknowledgedGeneration:0'], ['supportsPropagation:null', 'supportsPropagation:false'], ['acknowledgedEnrollment:!1', 'acknowledgedEnrollment:!0'], ['"apps_mcp_path_override","auth_elicitation","tool_suggest"', '"remote_control","auth_elicitation","tool_suggest"'], ['"experimental-features","list",e', '"experimental-features","list","local"'], ['connections:this.appServerConnectionRegistry', 'connections:this.otherRegistry'], ['evaluations:this.publishedStatsig', 'evaluations:this.otherStatsig'], ['return new eSo(e,t,e=>', 'return new OtherSync(e,t,e=>'], ['e.hostId===ei.iwv', 'e.hostId!==ei.iwv'], ['if(!(0,ei.Rg6)', 'if((0,ei.Rg6)'],
  ]) { const broken = source.replace(from, to);assert.notEqual(broken, source, from);reject(broken, from); }
  reject(source.replace('class Host{constructor(e)', 'class Host{constructor(e,eSo)'), "constructor captures owner");
  reject(source.replace('class Host{constructor(e)', 'class Host{constructor(e,sp)'), "constructor captures callback namespace");
  reject(source.replace(h.native.startup, "return;" + h.native.startup), "root constructor exit");
  reject('const opaque=' + JSON.stringify(h.native.owner) + ';', "opaque-only owner");
});

test("Node process capture and eager native authority writes refuse while unrelated deferred locals remain valid", () => {
  const source = h.fixture();for (const statement of ['let process={platform:"linux"};', 'process=foreign;', 'eSo=foreign;', 't5=foreign;', 'sp>>>=1;', '\\u0070rocess=foreign;']) reject(source.replace("class RequestWrapper", statement + "class RequestWrapper"), statement);
  reject('let process={platform:"linux"};' + source, "outer process capture");
  reject(source.replace('26307(e,t,r)', '26307(process,t,r)'), "factory process parameter");
  for (const statement of ['function deferred(process){process=foreign}', '{let process={platform:"other"};}', 'function deferred(t5){t5=foreign}']) assert.doesNotThrow(() => prepare(source.replace("class RequestWrapper", statement + "class RequestWrapper")), statement);
});

test("canonical repeats require exact helper, local record host, request guard and factory placement", () => {
  const source = patched();for (const broken of [source.replace(HELPER, ""), source.replace('"local"===t', '"ssh:host"===t'), source.replace('Enabled(i,e.connection.hostId)', 'Enabled(i,"local")'), source.replace('{enablement:codexLinuxRemoteControlFeatureSyncEnabled(i,e.connection.hostId)},s)', '{enablement:codexLinuxRemoteControlFeatureSyncEnabled(i,e.connection.hostId)},otherGuard)'), HELPER + source.replace(HELPER, ""), source + ';const orphan="codexLinuxRemoteControlFeatureSyncEnabled";']) reject(broken, "own canonical artifact");
});

test("semantic owner/import names and scientific factory identities retain the native graph", () => {
  let source = h.fixture();for (const [from, to] of Object.entries({ eSo: "EnablementOwner", eSs: "allowlisted", eSa: "compressionSchema", ed: "Logging", ei: "NativeHosts", t3: "equalityModule", t5: "equalityGetter", t4: "Version", t8: "RequestErrors", sp: "LocalHost", VE: "clearViews", eM: "Schema" })) {
    const index = createJavaScriptLexicalIndex(source), matches = [...source.matchAll(new RegExp(`(?<![\\w$])${from}(?![\\w$])`, "gu"))].filter(row => index.isCode(row.index));for (const row of matches.reverse()) source = source.slice(0, row.index) + to + source.slice(row.index + row[0].length);
  }
  source = source.replace("26307(e,t,r)", "9e4(e,t,r)");const first = prepare(source);assert.equal(first.proof.owner, "EnablementOwner");assert.equal(first.proof.factoryId, "90000");assert.equal(prepare(first.patchedSource).nativeSource, source);
});

test("complete twenty-one-row main transaction changes one asset and rolls back interrupted writes with modes", () => app(({ root, build, sources }) => {
  let writes = 0;assert.throws(() => apply(root, { writeFileSync(file, bytes) { if (++writes === 1) { fs.writeFileSync(file, bytes.subarray(0, 7));throw Error("controlled interrupted sync write"); }fs.writeFileSync(file, bytes); } }), /controlled interrupted sync write/);
  for (const [name, before] of Object.entries(sources)) { assert.equal(fs.readFileSync(path.join(build, name), "utf8"), before);assert.equal(fs.statSync(path.join(build, name)).mode & 0o777, 0o640); }
  assert.equal(apply(root).changed, 1);const after = Object.fromEntries(Object.keys(sources).map(name => [name, fs.readFileSync(path.join(build, name), "utf8")]));assert.equal(Object.keys(after).filter(name => after[name] !== sources[name]).length, 1);assert.equal(apply(root).changed, 0);
  for (const [name, text] of Object.entries(after)) assert.equal(fs.readFileSync(path.join(build, name), "utf8"), text);
}));

test("damaged same-identity, duplicate and orphan carriers reject the complete physical inventory", () => {
  for (const extra of ['exports.ids=[1],exports.modules={26307(e,t,r){const broken=true}};', h.fixture(), 'exports.ids=[1],exports.modules={1(e){e.exports="codexLinuxRemoteControlFeatureSyncEnabled"}};']) app(({ root, build, sources }) => {
    assert.throws(() => apply(root), /Unsupported current Remote feature-sync contract/);for (const [name, text] of Object.entries(sources)) assert.equal(fs.readFileSync(path.join(build, name), "utf8"), text);
  }, { "early-bootstrap-920-deadbeef.js": h.fixture(), "early-bootstrap-1-feedface.js": extra });
});
