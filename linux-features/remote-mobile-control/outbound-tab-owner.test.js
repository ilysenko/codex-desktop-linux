"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm"), test = require("node:test");
const { prepareOutboundTab: prepare, prepareOutboundTabOwner, MARKER } = require("./outbound-tab-owner.js");
const contract = require("./outbound-tab-contracts.js"), h = require("./fixtures/outbound-tab-harness.js");
const scope = require("./remote-copy-scope.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const descriptor = require("./patch.js").find(row => row.id === "linux-remote-control-settings-ux"), apply = descriptor.apply;
const ownerFile = "async/outbound-owner-0.js";
function temporary(fn) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-outbound-"));try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } }
function change(input, file, before, after) { assert.ok(input[file].includes(before), before);input[file] = input[file].replace(before, after); }
function rejected(mutate) {
  const input = h.sources();mutate(input);const cohort = h.snapshots(input), before = JSON.stringify(input);
  for (const rows of Object.values(cohort)) for (const copy of rows) new vm.Script(`"use strict";(function(${copy.params}){${copy.moduleSource}\n});`);
  assert.throws(() => prepare(cohort), /Remote outbound|Native Remote copy|Rspack/);assert.equal(JSON.stringify(input), before);
}

test("registered85 owns the pre-webview cohort and changes only the114-byte outbound alternative", () => {
  assert.equal(descriptor.phase, "extracted-app:pre-webview");assert.equal(descriptor.order, 20135);assert.equal(descriptor.ciPolicy, "optional");assert.equal(descriptor.assetNeedles, undefined);
  assert.throws(() => apply('function Uo(){let hidden=true,visible=!hidden;return visible}'));
  const input = h.sources(), first = prepare(h.snapshots(input)), output = h.transition(input, first), second = prepare(h.snapshots(output));
  assert.equal(first.alreadyApplied, false);assert.equal(second.alreadyApplied, true);
  const changed = first.edits.filter(row => row.source !== row.patchedSource);assert.equal(changed.length, 1);assert.equal(changed[0].assetName, ownerFile);
  assert.equal(Buffer.byteLength(changed[0].patchedSource) - Buffer.byteLength(changed[0].source), 114);
  assert.deepEqual(h.transition(output, second), output);assert.deepEqual(h.transition(output, second, "nativeSource"), input);
  const row = h.snapshots(input).owner[0], owned = prepareOutboundTabOwner(row), nativeFlag = contract.sites.ownedFlag;
  const at = row.moduleSource.indexOf(nativeFlag);assert.ok(at >= 0);
  assert.equal(owned.patchedSource.slice(0, at), row.moduleSource.slice(0, at));
  assert.equal(owned.patchedSource.slice(at + nativeFlag.length + 114), row.moduleSource.slice(at + nativeFlag.length));
});

test("preserved UA detector runs the native subscription once before detection and retains non-Linux behavior", () => {
  const patched = h.snapshots(h.transition(h.sources(), prepare(h.snapshots()))).owner[0].moduleSource;
  const flag = patched.match(/nZ=(\/\*codexLinuxRemoteControlOutboundTabGate\*\/\([^;]+?\))(?=,nU=)/u)?.[1];assert.ok(flag);
  for (const hidden of [false, true]) for (const [ua, platform] of [["Linux", "linux"], ["Windows", "linux"], ["Linux", "macOS"], ["Macintosh", "macOS"], [null, "linux"]]) {
    const trace = [], context = { tk: platform, G: { Zj(id) { trace.push(id);return hidden; } } };
    if (ua !== null) context.navigator = { get userAgent() { trace.push("detect");return ua; } };
    const value = vm.runInNewContext(`(()=>{let ${contract.sites.gateInitializer},nZ=${flag};return nZ})()`, context);
    assert.equal(value, ua === "Linux" || !hidden);assert.deepEqual(trace, ua === null ? ["782640499"] : ["782640499", "detect"]);
  }
  assert.match(contract.detectorPolicy, /Preserve existing navigator/);
});

test("native HZ/navigation and deep-link guards preserve403, auth, pairing, identity and SSH boundaries", () => {
  const hz = vm.runInNewContext("(" + contract.tabResolver.moduleSource + ")");
  const guard = contract.sites.deepLinkGuard.slice(3, -")return;".length);
  function denied(values) { return vm.runInNewContext(guard, { n0: true, nF: true, nZ: true, tP: true, es: true, eo: false, tU: "local", n2: "code", n: {}, n1: "ssh-alias", ...values }); }
  assert.equal(denied({}), false);
  for (const values of [{ nF: false }, { nZ: false }, { tP: false }, { es: false }, { eo: true }, { tU: null }, { n2: null }]) assert.equal(denied(values), true);
  for (const show of [false, true]) {
    const scene = Object.freeze({ selectedConnectionsTab: "access-other-devices", showControlOtherDevices: show, showControlThisMacTab: false,
      showRemoteControlConnectionsSection: false, showRemoteSshConnections: true, showTabbedSshPage: false, isWslConnectionsLoading: false, showWslConnections: false });
    assert.equal(hz(scene), "ssh");assert.equal(false && show, false);
    assert.equal(denied({ n0: false, nF: false, nZ: show, tP: false, es: false, eo: true }), false);
    assert.equal(denied({ n0: false, nZ: show, n: null }), true);
  }
});

test("qualified native action mapper keeps retired installers null and forwards exact host/callback choices", () => {
  const mapper = vm.runInNewContext("(" + contract.actionMapper + ")"), calls = [], restart = () => calls.push("restart"), reconnect = () => calls.push("reconnect");
  const base = { hostId: "ssh:chosen", onAuthenticate: host => calls.push(host), onRestart: restart, onReconnect: reconnect };
  for (const kind of ["install-codex", "settings"]) assert.equal(mapper({ ...base, action: { kind } }), null);
  mapper({ ...base, action: { kind: "login", label: "Login" } }).onClick();assert.deepEqual(calls, ["ssh:chosen"]);
  const row = mapper({ ...base, action: { kind: "restart", label: "Restart", tooltipText: "Native tooltip" } });assert.equal(row.onClick, restart);assert.equal(row.tooltipText, "Native tooltip");
  assert.equal(mapper({ ...base, action: { kind: "reconnect", label: "Reconnect" } }).onClick, reconnect);
});

test("published owners, generators, live providers, detector capture and canonical contributions fail closed", () => {
  for (const [before, after] of [
    ["RemoteConnectionsSettings:()=>t8", "RemoteConnectionsSettings:()=>eO"],
    ['G=n("hZax")', 'G=n("wrong")'], ['O=n("wwME")', 'O=n("wrong")'], ['tK=n("uodG")', 'tK=n("wrong")'],
    ["nZ=!tD", "nZ=tD"], ["nZ=!tD", "nZ=!!tD"], ["nF=(0,tK.wi)()", "nF=true"],
    ["function t8(){", "function t8(){const navigator={userAgent:'Linux'};"],
    ["function t8(){", `function t8(){const orphan="${MARKER}";`],
  ]) rejected(input => change(input, ownerFile, before, after));
  rejected(input => change(input, ownerFile, "var o=", "function* t8(){return null}var o="));
  rejected(input => change(input, ownerFile, "var o=", "function /*head*/ * G({x}={}){return null}var o="));
  const patched = h.transition(h.sources(), prepare(h.snapshots()));
  const damaged = { ...patched };change(damaged, ownerFile, "||!tD)", "||tD)");assert.throws(() => prepare(h.snapshots(damaged)));
});

test("every selected policy/caller link and every physical provider/HZ copy is mandatory", () => {
  for (const [before, after] of [
    ["nQ=nZ&&(nF||!1)", "nQ=nZ||nF"], ["showControlOtherDevices:nZ", "showControlOtherDevices:!0"],
    ["!nF||!nZ||!tP||!es||eo", "!nF||!nZ||!tP||!es||!eo"],
    ["eo=tW?.authRequired===!0", "eo=tW?.authRequired!==!0"], ["tP=(0,G.Zj)(I.Qg)", "tP=true"],
    ["(0,h.useEffectEvent)(e1)", "(0,h.useEffectEvent)(eO)"], ["queueMicrotask(()=>{e.signal.aborted||oP(e)})", "queueMicrotask(()=>{oP(e)})"],
    ["let oP=(0,h.useEffectEvent)(e1)", "e1=()=>null;let oP=(0,h.useEffectEvent)(e1)"],
    ["tw[176]!==n0", "oP=()=>null;tw[176]!==n0"],
    ["tU=(0,u.Ul)(D.dZ)", "tU=(0,u.Ul)(D.BJ)"], ["let nX=em;", "let nX=em;void nZ;"],
    ["let nX=em;", "let nX=em;nZ=false;"],
  ]) rejected(input => change(input, ownerFile, before, after));
  for (const [file, before, after] of [
    ["async/outbound-gateHook-0.js", "Zj:function", "wrong:function"],
    ["async/outbound-platform-0.js", 'a=n("XYHU")', 'a=n("wrong")'],
    ["async/outbound-catalog-0.js", "h9:f", "h9:h"],
    ["async/outbound-pairing-0.js", 'f="2055603567"', 'f="wrong"'],
    ["async/outbound-tabs-5.js", "showControlOtherDevices:", "wrongControlOtherDevices:"],
  ]) rejected(input => change(input, file, before, after));
  const missing = h.snapshots();missing.tabs = [];assert.throws(() => prepare(missing), /missing tabs/);
});

test("unrelated native UI text remains outside85 ownership and all-copy states remain coherent", () => {
  const input = h.sources();change(input, ownerFile, "Devices that can control this Mac", "Custom native list heading");
  const plan = prepare(h.snapshots(input)), out = h.transition(input, plan);assert.ok(out[ownerFile].includes("Custom native list heading"));
  assert.deepEqual(h.transition(out, prepare(h.snapshots(out)), "nativeSource"), input);
  const duplicate = h.sources();duplicate["async/replica.js"] = duplicate[ownerFile];assert.equal(prepare(h.snapshots(duplicate)).targetCopies, 2);
  const mix = { ...duplicate, [ownerFile]: h.transition(duplicate, prepare(h.snapshots(duplicate)))[ownerFile] };assert.throws(() => prepare(h.snapshots(mix)), /mixed owner state/);
});

test("actual registered85 adapter writes one asset, retains modes and repeats through the atomic preflight", () => temporary(root => {
  const input = h.sources(), assets = h.writeApp(root, input), before = Object.fromEntries(Object.keys(input).map(name => [name, fs.statSync(path.join(assets, name)).mode]));
  assert.equal(apply(root).changed, 1);const after = h.readApp(root, input);assert.notEqual(after[ownerFile], input[ownerFile]);
  for (const name of Object.keys(input)) assert.equal(fs.statSync(path.join(assets, name)).mode, before[name]);
  assert.equal(apply(root, { outboundTabWriteOptions: { writeFileSync() { assert.fail("repeat must not write"); } } }).changed, 0);assert.deepEqual(h.readApp(root, input), after);
}));

test("discovery rejects hidden malformed/over-cap peers and orphan markers before writing", () => {
  for (const [id, body] of [["GrdY", "const hidden=true;"], ["uodG", "const hidden=true;"], ["GrdY", `const payload=${JSON.stringify("x".repeat(256 * 1024 + 1))};`]]) temporary(root => {
    const input = h.sources();input["async/hidden.js"] = `export const __webpack_modules__={${id}(e,t,n){${body}}};`;h.writeApp(root, input);
    assert.throws(() => apply(root));assert.deepEqual(h.readApp(root, input), input);
  });
  temporary(root => { const input = h.sources();input["async/orphan.js"] = `const marker="${MARKER}";`;h.writeApp(root, input);assert.throws(() => apply(root), /orphan physical/);assert.deepEqual(h.readApp(root, input), input); });
});

test("read-only dependencies reject stale bytes/symlinks and interrupted writes restore exact native bytes", () => temporary(root => {
  const input = h.sources(), assets = h.writeApp(root, input), plan = prepare(h.snapshots(input));let reads = 0;
  assert.throws(() => apply(root, { outboundTabWriteOptions: { readFileSync(file) { const data = fs.readFileSync(file);return ++reads === 12 ? Buffer.concat([data, Buffer.from(" ")]) : data; } } }), /changed before patch commit/);
  assert.deepEqual(h.readApp(root, input), input);
  let writes = 0;assert.throws(() => apply(root, { outboundTabWriteOptions: { writeFileSync(file, data) { if (++writes === 1) { fs.writeFileSync(file, data.subarray(0, 10));throw Error("controlled short write"); }fs.writeFileSync(file, data); } } }), /controlled short write/);
  assert.deepEqual(h.readApp(root, input), input);
  const file = path.join(assets, "async/outbound-platformMap-0.js"), saved = file + ".retained";fs.renameSync(file, saved);fs.symlinkSync(saved, file);
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /symlink|special files/);
  assert.equal(fs.readFileSync(saved, "utf8"), input["async/outbound-platformMap-0.js"]);
}));

test("actual85 and accepted86 preparers commute, repeat and inverse independently while84copy remains native", () => {
  const copy = require("./fixtures/remote-copy-harness.js"), revoke = require("./fixtures/revoke-setup-reset-harness.js");
  const { prepareRevokeSetupReset } = require("./revoke-setup-reset-owner.js"), { prepareNativeRemoteCopy } = require("./remote-copy.js");
  const input = { ...h.withCopySources(), ...Object.fromEntries(Object.entries(revoke.sources()).filter(([name]) => name !== "async/owner.js")) };
  const a = h.transition(input, prepare(h.snapshots(input))), ab = revoke.transition(a, prepareRevokeSetupReset(revoke.snapshots(a)));
  const b = revoke.transition(input, prepareRevokeSetupReset(revoke.snapshots(input))), ba = h.transition(b, prepare(h.snapshots(b)));
  assert.deepEqual(ab, ba);assert.ok(prepare(h.snapshots(ab)).alreadyApplied);assert.ok(prepareRevokeSetupReset(revoke.snapshots(ab)).alreadyApplied);
  assert.ok(prepareNativeRemoteCopy(copy.snapshots(ab)).edits.every(row => row.source === row.patchedSource));
  assert.deepEqual(h.transition(ab, prepare(h.snapshots(ab)), "nativeSource"), b);
  assert.deepEqual(revoke.transition(ab, prepareRevokeSetupReset(revoke.snapshots(ab)), "nativeSource"), a);
});

test("native HZ validation accepts accepted83 Zi/wi contributions without qualifying their owned predicates", () => {
  const { prepareRemoteMobileVisibility } = require("./remote-control-visibility.js"), visibility = require("./fixtures/remote-visibility-harness.js");
  const input = { ...h.sources(), ...Object.fromEntries(Object.entries(visibility.sources()).filter(([name]) => !Object.hasOwn(h.sources(), name))) };
  // Both physical uodG sets are intentional replicas; only83 owns their Zi/wi.
  const a = h.transition(input, prepare(h.snapshots(input))), ab = h.transition(a, prepareRemoteMobileVisibility(visibility.snapshots(a)));
  const b = h.transition(input, prepareRemoteMobileVisibility(visibility.snapshots(input))), ba = h.transition(b, prepare(h.snapshots(b)));
  assert.deepEqual(ab, ba);assert.ok(prepare(h.snapshots(ab)).alreadyApplied);
  assert.deepEqual(h.transition(ab, prepare(h.snapshots(ab)), "nativeSource"), b);
});

test("native root let initializers retain declaration ownership and original hook order", () => {
  const input = h.sources(), plan = prepare(h.snapshots(input)), output = h.transition(input,plan), repeat = prepare(h.snapshots(output));
  assert.equal(plan.alreadyApplied,false);assert.equal(repeat.alreadyApplied,true);assert.deepEqual(h.transition(output,repeat,"nativeSource"),input);
  rejected(data => change(data,ownerFile,"let tT=e,tH=","if(false)var tT=e,tH="));
  rejected(data => change(data,ownerFile,'{platform:tk}=(0,O.V)(),tD=(0,G.Zj)("782640499")','tD=(0,G.Zj)("782640499"),{platform:tk}=(0,O.V)()'));
});
