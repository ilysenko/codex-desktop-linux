"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyLinuxRemoteMobileReasoningSummaryPatch: mobileSource,
  applyLinuxRemoteMobileReasoningSummaryExtractedAppPatch: mobileApp } = require("./patch.js");
const { applyRequestSummariesPatch: visibilitySource,
  applyRequestSummariesExtractedAppPatch: visibilityApp } = require("../reasoning-visibility/request-summaries.js");
const mobile = require("./summary-contract.js");
const visibility = require("../reasoning-visibility/summary-contract.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { nativeCarrier, selectedRuntime, nativeDefaultGetter, nativeConfigReader, nativeConfigurationSelection, nativeInheritance, FLOW } = require("./summary-contract.test-helpers.js");

function withApp(fn, sources = [nativeCarrier(), nativeCarrier()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-cohort-"));
  const assets = path.join(root, "webview/assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  const files = sources.map((source, index) => {
    const file = path.join(assets, "async", `${index}.fixture.js`);
    fs.writeFileSync(file, source, { mode: index ? 0o640 : 0o644 });
    return file;
  });
  try { return fn(root, assets, files); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function warnings(fn) {
  const saved = console.warn, messages = [];
  console.warn = message => messages.push(message);
  try { return { value: fn(), messages }; } finally { console.warn = saved; }
}

test("production source adapters commute, repeat and invert only their own contribution", () => {
  const native = nativeCarrier(), m = mobileSource(native), v = visibilitySource(native);
  const joint = mobileSource(v);
  assert.equal(joint, visibilitySource(m));
  assert.equal(Buffer.byteLength(m) - Buffer.byteLength(native), 510);
  assert.equal(Buffer.byteLength(v) - Buffer.byteLength(native), 553);
  assert.equal(Buffer.byteLength(joint) - Buffer.byteLength(native), 976);
  for (const state of [m, v, joint]) {
    assert.equal(mobileSource(mobileSource(state)), mobileSource(state));
    assert.equal(visibilitySource(visibilitySource(state)), visibilitySource(state));
    assert.equal(state.split(FLOW).length, 2);
  }
  assert.equal(mobile.prepareSummaryLayerSource(joint, "mobile", false).patchedSource, v);
  assert.equal(visibility.prepareSummaryLayerSource(joint, "visibility", false).patchedSource, m);
  assert.equal(mobile.prepareSummaryLayerSource(m, "mobile", false).patchedSource, native);
  assert.equal(visibility.prepareSummaryLayerSource(v, "visibility", false).patchedSource, native);
  for (const name of ["summary-contract.js", "summary-contract-data.js"]) {
    assert.deepEqual(fs.readFileSync(path.join(__dirname, name)), fs.readFileSync(path.join(__dirname, "../reasoning-visibility", name)));
  }
});

test("production extracted adapters own every physical peer in either feature order", () => {
  for (const order of [[mobileApp, visibilityApp], [visibilityApp, mobileApp]]) withApp((root, _assets, files) => {
    const modes = files.map(file => fs.statSync(file).mode);
    for (const apply of order) {
      assert.equal(apply(root).changed, 2);
      assert.equal(apply(root).changed, 0);
    }
    const expected = mobileSource(visibilitySource(nativeCarrier()));
    assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), [expected, expected]);
    assert.deepEqual(files.map(file => fs.statSync(file).mode), modes);
  });
});

test("hidden same-ID drift, mixed states, or orphan markers reject before writes", () => {
  const native = nativeCarrier(), m = mobileSource(native), bad = native.replace("Reasoning summary turn-start config resolved", "hidden owner");
  for (const sources of [[native, bad], [native, nativeCarrier("ForeignOwner")], [native, m], [m, m.replace('="none");', '="concise");')]]) withApp((root, _assets, files) => {
    const before = files.map(file => fs.readFileSync(file));
    assert.throws(() => mobileApp(root));
    assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
  }, sources);
  withApp((root, assets, files) => {
    fs.writeFileSync(path.join(assets, "async/orphan.js"), "/*codexCommunitySummaryChannel:M*/");
    assert.throws(() => mobileApp(root), /orphan/);
    assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), [native, native]);
  });
});

test("production writes roll back an interrupted peer and reject stale rows byte-for-byte", () => {
  withApp((root, assets, files) => {
    const before = files.map(file => fs.readFileSync(file));
    let writes = 0;
    assert.throws(() => mobileApp(root, { reasoningSummaryWriteOptions: { writeFileSync(file, bytes) {
      if (++writes === 2) { fs.writeFileSync(file, bytes.subarray(0, 7)); throw Error("controlled interrupted summary write"); }
      fs.writeFileSync(file, bytes);
    } } }), /controlled interrupted summary write/);
    assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
    const plan = mobile.locateSummaryLayer(assets, "mobile");
    fs.appendFileSync(files[1], "/*concurrent edit*/");
    assert.throws(() => patchWebviewAssets(assets, plan.edits), /changed before patch commit/);
    assert.deepEqual(fs.readFileSync(files[0]), before[0]);
    assert.equal(fs.readFileSync(files[1], "utf8"), before[1].toString() + "/*concurrent edit*/");
    const copies = [...rspackModuleFactories(nativeCarrier(), "async/source.js")];
    copies[0] = { ...copies[0], start: copies[0].start + 1 };
    assert.throws(() => mobile.prepareSummaryLayer(copies, "mobile"), /stale/);
  });
});

test("obsolete bare helpers and partial or foreign channel forms preserve the source", () => {
  const native = nativeCarrier(), m = mobileSource(native), joint = visibilitySource(m);
  for (const source of [
    'async function HWt(){let summary="none";return summary}',
    native + native,
    m.replace('codexLinuxRemoteSummaryVisibilityPreference=!1', 'codexLinuxRemoteSummaryVisibilityPreference=!0'),
    joint.replace('codex-linux-reasoning-visibility', 'foreign-preference'),
    joint.replace('codexCommunitySummaryChannel:J', 'codexCommunitySummaryChannel:V'),
    joint.replace('/*community-reasoning-visibility-request-summaries*/', ''),
    'function unrelated(){const codexLinuxRemoteSummaryVisibilityPreference=!1;/*codexCommunitySummaryChannel:M*/}'+native,
  ]) for (const apply of [mobileSource, visibilitySource]) {
    const result = warnings(() => apply(source));
    assert.equal(result.value, source);
    assert.equal(result.messages.length, 1);
  }
});

test("selected native flow preserves effective priorities and strict rollout semantics in all channel states", () => {
  const native = nativeCarrier(), states = [
    { source: native, mobile: false, visibility: false },
    { source: mobileSource(native), mobile: true, visibility: false },
    { source: visibilitySource(native), mobile: false, visibility: true },
    { source: visibilitySource(mobileSource(native)), mobile: true, visibility: true },
  ];
  let cases = 0;
  const get = nativeDefaultGetter();
  const kinds = ["default", "latest", "latest-null", "latest-unknown", "model", "model-null", "model-unknown", "request", "request-null", "request-unknown", "unavailable"];
  for (const state of states) for (const on of [false, true]) {
    let storageReads = 0;
    const scope = { navigator: { userAgent: "Linux" }, localStorage: { getItem(key) { storageReads++; assert.equal(key, "codex-linux-reasoning-visibility"); return on ? "1" : null; } } };
    const resolve = selectedRuntime(state.source, scope);
    assert.equal(storageReads, state.visibility ? 1 : 0);
    for (const platform of ["Linux", "Macintosh"]) for (const host of ["local", "durable", "remote-ssh-discovered:box"]) for (const mode of ["durable", "default"]) for (const kind of kinds) for (const rollout of [false, true, "true", 1]) for (const aeon of [false, true]) {
      let getterCalls = 0, settingsReads = 0;
      const e = { getHostId: () => host, getConversation(id) { assert.equal(id, "test-conversation"); return { mode }; }, settings: { readDefaultFeatureOverrides() { settingsReads++; return { concurrent_reasoning_summaries: rollout }; } } };
      e.getDefaultFeatureOverride = function(key) { getterCalls++; return get.call(this, key); };
      const previous = { summary: "inherited" };
      const latest = kind === "latest" ? { summary: "concise" } : kind === "latest-null" ? { summary: null } : kind === "latest-unknown" ? { summary: "future-latest" } : undefined;
      const config = kind === "unavailable" ? null : kind === "model" ? { model_reasoning_summary: "auto" } : kind === "model-null" ? { model_reasoning_summary: null } : kind === "model-unknown" ? { model_reasoning_summary: "future-model" } : {};
      const request = kind === "request" ? { summary: "none" } : kind === "request-null" ? { summary: null } : kind === "request-unknown" ? { summary: "future-request" } : {};
      scope.navigator.userAgent = platform;
      let expected = previous.summary;
      if (latest?.summary !== undefined) expected = latest.summary;
      const automatic = state.visibility && on || rollout === true || aeon ? "detailed" : null;
      if (automatic != null) expected = automatic;
      expected = config == null ? null : config.model_reasoning_summary ?? expected;
      if (request.summary !== undefined) expected = request.summary;
      if (state.mobile && platform === "Linux" && host === "local" && mode === "durable" && request.summary === undefined && latest?.summary === undefined && config != null && config.model_reasoning_summary == null && !(state.visibility && on)) expected = "none";
      assert.equal(resolve(e, aeon, previous, latest, config, request), expected);
      assert.equal(getterCalls, state.visibility && on ? 0 : 1);
      assert.equal(settingsReads, getterCalls);
      cases++;
    }
    assert.equal(storageReads, state.visibility ? 1 : 0, "turns reuse the renderer-session snapshot");
  }
  assert.equal(cases, 8448);
});

test("selected native getters, configuration failure and inheritance gate keep their evaluation behavior", async () => {
  const native = nativeCarrier(), m = mobileSource(native), joint = visibilitySource(m);
  const make = source => selectedRuntime(source, { navigator: { userAgent: "Linux" }, localStorage: { getItem: () => null } });
  const failure = Error("controlled settings failure"), manager = { getHostId: () => "local", getConversation: () => ({ mode: "durable" }), getDefaultFeatureOverride() { throw failure; } };
  assert.throws(() => make(m)(manager, false, undefined, undefined, {}, {}), error => error === failure);
  const on = selectedRuntime(joint, { navigator: { userAgent: "Linux" }, localStorage: { getItem: () => "1" } });
  assert.equal(on(manager, false, undefined, undefined, {}, {}), "detailed");
  const read = nativeConfigReader({ em: { ZJ: host => host === "durable" }, r0: { Y$: value => value } });
  const calls = [], client = { hostId: "local", sendRequest(method, args, options) { calls.push([method, args, options]); return Promise.resolve({ config: {} }); } };
  assert.deepEqual(JSON.parse(JSON.stringify(await read(client, "/workspace"))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["config/read", { cwd: "/workspace", includeLayers: false }, { priority: "critical", timeoutMs: 500 }]);
  client.sendRequest = () => Promise.reject(Error("controlled config failure"));
  assert.equal(await read(client, "/workspace"), null);
  let selectedReads = 0;
  const select = nativeConfigurationSelection({ aE(...args) { selectedReads++; return read(...args); } });
  assert.equal(select({ requestClient: client }, { summary: null }, "/workspace"), undefined);
  assert.equal(select({ requestClient: client }, { summary: "none" }, "/workspace"), undefined);
  assert.equal(selectedReads, 0);
  assert.equal(await select({ requestClient: client }, {}, "/workspace"), null);
  assert.equal(selectedReads, 1);
  const normalizeFailure = nativeConfigReader({ em: { ZJ: () => false }, r0: { Y$() { throw Error("controlled config conversion failure"); } } });
  assert.equal(await normalizeFailure({ sendRequest: () => Promise.resolve({ config: {} }) }, "/workspace"), null);
  const synchronousFailure = Error("controlled synchronous request failure");
  await assert.rejects(() => read({ hostId: "local", sendRequest() { throw synchronousFailure; } }, "/workspace"), error => error === synchronousFailure);
  client.getHostId = manager.getHostId; client.getConversation = manager.getConversation; client.getDefaultFeatureOverride = () => true;
  assert.equal(make(m)(client, false, { summary: "prior" }, undefined, await read(client, "/workspace"), {}), null);
  const inherit = nativeInheritance({ P: { d: () => ({ entries: [{ value: "accepted" }] }) }, k: () => [] });
  const conversation = { latestThreadSettings: { summary: null }, turnHistory: { kind: "canonical", history: { entitiesByKey: { accepted: { turnId: "turn", params: { summary: "prior" } } } } } };
  const gated = inherit(conversation, false), accepted = inherit(conversation, true);
  assert.equal(gated.H, null); assert.equal(gated.Q, null);
  assert.equal(accepted.H, conversation.latestThreadSettings); assert.equal(accepted.Q.summary, "prior");
});

test("each production feature works with the sibling feature directory absent", () => {
  for (const [feature, entry, method] of [
    ["remote-mobile-control", "patch.js", "applyLinuxRemoteMobileReasoningSummaryPatch"],
    ["reasoning-visibility", "request-summaries.js", "applyRequestSummariesPatch"],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "summary-single-feature-"));
    try {
      const own = path.join(root, "linux-features", feature);
      fs.cpSync(__dirname.replace(/remote-mobile-control$/u, feature), own, { recursive: true });
      fs.cpSync(path.join(__dirname, "../../scripts/patches"), path.join(root, "scripts/patches"), { recursive: true });
      const sibling = feature === "remote-mobile-control" ? "reasoning-visibility" : "remote-mobile-control";
      assert.equal(fs.existsSync(path.join(root, "linux-features", sibling)), false);
      const adapter = require(path.join(own, entry));
      assert.notEqual(adapter[method](nativeCarrier()), nativeCarrier());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
