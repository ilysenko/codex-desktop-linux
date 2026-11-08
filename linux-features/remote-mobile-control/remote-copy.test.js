"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), vm = require("node:vm");
const test = require("node:test");
const { prepareNativeRemoteCopy: prepare, literalMember } = require("./remote-copy.js");
const scope = require("./remote-copy-scope.js");
const contracts = require("./remote-copy-contracts.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const harness = require("./fixtures/remote-copy-harness.js");
const { fixture, sources, snapshots, writeApp, readApp } = harness;
const descriptors = require("./patch.js");
const descriptor = descriptors.find(row => row.id === "linux-remote-control-copy");
const apply84 = descriptor.apply;
const apply85 = descriptors.find(row => row.id === "linux-remote-control-settings-ux").apply;
function temporary(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-remote-copy-"));
  try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function replace(input, role, before, after) {
  const name = "async/remote-copy-" + role + ".js";
  assert.ok(input[name].includes(before), role + ": " + before);
  input[name] = input[name].replace(before, after);
}
function rejects(change) {
  const input = sources();change(input);const before = JSON.stringify(input);
  assert.throws(() => prepare(snapshots(input)), /Native Remote copy|Rspack|SyntaxError/);
  assert.equal(JSON.stringify(input), before);
}

test("registered84 qualifies native copy before webview, without a text marker or String writer", () => {
  assert.equal(descriptor.phase, "extracted-app:pre-webview");assert.equal(descriptor.order, 20130);
  assert.equal(descriptor.assetNeedles, undefined);assert.equal(descriptor.ciPolicy, "optional");
  const patch = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8");
  assert.doesNotMatch(patch, /REMOTE_CONTROL_LINUX_COPY_REPLACEMENTS|replaceLinuxRemoteControlCopy|codexLinuxRemoteControlCopy/);
  assert.throws(() => apply84('defaultMessage:"Control this Mac"'));
  const plan = prepare(snapshots());
  assert.equal(plan.alreadyApplied, true);assert.equal(plan.edits.length, 10);assert.equal(plan.selectedSearchMessages, 42);
  for (const row of plan.edits) assert.equal(row.patchedSource, row.source);
});

test("native84 first and repeat qualify with zero writes and preserve every byte, mode and mtime", () => temporary(root => {
  const input = sources(), assets = writeApp(root, input);
  const before = Object.fromEntries(Object.keys(input).map(name => {
    const stat = fs.statSync(path.join(assets, name));return [name, [stat.mode, stat.mtimeMs]];
  }));
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = apply84(root, { remoteCopyWriteOptions: { writeFileSync() { assert.fail("no-op must never write"); } } });
    assert.equal(result.matched, true);assert.equal(result.changed, 0);assert.deepEqual(result.changedAssets, []);
    assert.deepEqual(readApp(root, input), input);
    for (const name of Object.keys(input)) {
      const stat = fs.statSync(path.join(assets, name));assert.deepEqual([stat.mode, stat.mtimeMs], before[name]);
    }
  }
}));

test("current platform mapper returns Linux and native PC selectors retain Windows/Linux and Mac messages", () => {
  const copy = { ...fixture.platformMap, start: 0 };
  const fn = scope.rootFunction(copy, "o").source;
  for (const [platform, expected] of [["linux", "linux"], ["darwin", "macOS"], ["win32", "windows"], ["freebsd", "linux"]]) {
    assert.equal(vm.runInNewContext(`(${fn})(${JSON.stringify(platform)})`), expected);
  }
  for (const [platform, expected] of [["Linux x86_64", "linux"], ["MacIntel", "macOS"], ["Win32", "windows"]]) {
    assert.equal(vm.runInNewContext(`(${fn})(undefined)`, { navigator: { platform } }), expected);
  }
  const expression = fixture.settings.moduleSource.match(/"macOS"!==J\?\(0,o\.jsx\)\(p\.A,\{id:"settings\.remoteConnections\.remoteControlClients\.devices\.title\.windows"[^}]+\}\):\(0,o\.jsx\)\(p\.A,\{id:"settings\.remoteConnections\.remoteControlClients\.devices\.title"[^}]+\}\)/u)?.[0];
  assert.ok(expression);
  for (const platform of ["linux", "windows", "macOS"]) {
    const result = vm.runInNewContext(expression, { J: platform, o: { jsx: (_type, props) => props }, p: { A: "FormattedMessage" } });
    assert.equal(result.defaultMessage, platform === "macOS" ? "Devices that can control this Mac" : "Devices that can control this PC");
    assert.equal(result.id.endsWith(".windows"), platform !== "macOS");
  }
});

test("locked Computer Use remains macOS-only under every capability and readiness combination", () => {
  const guard = fixture.flow.moduleSource.match(/eh=("macOS"===M&&s&&L&&N\.data\?\.enabled!=null)/u)?.[1];
  assert.ok(guard);assert.ok(fixture.flow.moduleSource.includes("es.showComputerUseSetup&&es.showLockedComputerUse"));
  for (const M of ["linux", "windows", "macOS"]) for (const s of [false, true]) for (const L of [false, true]) for (const enabled of [undefined, false, true]) {
    const actual = vm.runInNewContext(guard, { M, s, L, N: { data: { enabled } } });
    assert.equal(actual, M === "macOS" && s && L && enabled != null);
    if (M === "linux") assert.equal(actual, false);
  }
  assert.ok(contracts.messages.flow.some(row => row.id.endsWith("computerUse.description.windows") && row.defaultMessage === "Let ChatGPT control apps on your PC"));
  const peer = contracts.messages.settings.filter(row => row.id.includes("manualPairingDialog.instructions."));
  assert.ok(peer.some(row => row.defaultMessage.includes("the computer you want to control")));
  assert.ok(peer.some(row => row.defaultMessage.includes("<controlMac>Control this Mac</controlMac> or <pc>PC</pc>")));
});

test("bounded native FormattedMessage preserves IDs, locale formatting, values, tags and children", () => {
  const copy = { ...fixture.formatted, start: 0 }, fn = scope.rootFunction(copy, "s").source;
  for (const locale of ["en-US", "zh-CN", "de-DE"]) {
    const calls = [], values = Object.freeze({ device: "peer", count: 2 });
    const render = vm.runInNewContext(`(${fn})`, {
      a: { A: () => ({ formatMessage: (message, input, options) => { calls.push({ message, input, options });return locale + ":" + input.device; }, textComponent: undefined }) },
      i: { Fragment: "Fragment", createElement: (type, props, children) => ({ type, props, children }) },
    });
    const result = render({ id: "native.id", description: "native description", defaultMessage: "Native {device}", values, ignoreTag: true });
    assert.equal(result.children, locale + ":peer");assert.equal(result.type, "Fragment");
    assert.equal(calls[0].message.id, "native.id");assert.equal(calls[0].message.defaultMessage, "Native {device}");
    assert.equal(calls[0].input, values);assert.equal(calls[0].options.ignoreTag, true);
    const child = render({ id: "native.id", values, children: rows => rows.join("|") });assert.equal(child, locale + ":peer");
  }
});

test("selected Connections data balances the whole native array and leaves other sections opaque", () => {
  assert.equal(literalMember('connections:[{x:[1,2]},{x:"],}"}],other:3', "connections", "[").text, '[{x:[1,2]},{x:"],}"}]');
  const input = sources();replace(input, "search", "unrelated:[]", 'unrelated:[{id:"foreign.locale",defaultMessage:"Mac Linux"}]');
  const plan = prepare(snapshots(input));assert.equal(plan.selectedSearchMessages, 42);
  const second = contracts.searchMessages[1];
  rejects(data => replace(data, "search", JSON.stringify(second.defaultMessage), JSON.stringify(second.defaultMessage + " changed")));
});

test("copy IDs, default text, descriptions, PC/Mac selectors and provider bindings fail closed", () => {
  const mutations = [
    ["settings", 'id:"settings.remoteConnections.tabs.controlThisMac.windows"', 'id:"other.id"'],
    ["settings", 'defaultMessage:"Devices that can control this PC"', 'defaultMessage:"Devices that can control Linux"'],
    ["settings", 'description:"Header title for devices that can control this Windows device"', 'description:"other"'],
    ["settings", '"macOS"!==J?', '"macOS"===J?'],
    ["settings", '{platform:J}=(0,O.V)()', '{platform:J}=(0,p.V)()'],
    ["settings", 'p=n("oyxz")', 'p=n("wrong")'],
    ["settings", 'o=n("ABep")', 'o=n("wrong")'],
    ["settings", 'O=n("wwME")', 'O=n("wrong")'],
    ["settings", 'J=n("Qgfj")', 'J=n("wrong")'],
    ["settings", 'RemoteConnectionsSettings:()=>t8', 'RemoteConnectionsSettings:()=>eO'],
    ["settings", 'keepLiveWindowsLabel}):(0,o.jsx)(p.A,{...eP.keepLiveMacLabel}', 'keepLiveMacLabel}):(0,o.jsx)(p.A,{...eP.keepLiveWindowsLabel}'],
    ["settings", 'keepLiveWindowsLabel):b.formatMessage(eP.keepLiveMacLabel)', 'keepLiveMacLabel):b.formatMessage(eP.keepLiveWindowsLabel)'],
    ["settings", 'Open the ChatGPT app on the computer you want to control', 'Open the ChatGPT app on this Linux desktop'],
    ["settings", '<controlMac>Control this Mac</controlMac> or <pc>PC</pc>', '<controlMac>Control this Linux desktop</controlMac> or <pc>PC</pc>'],
    ["platformMap", ':"linux"', ':"windows"'],
    ["platformHook", 'a=n("XYHU")', 'a=n("wrong")'],
    ["platformHook", 'i=n("C4bN")', 'i=n("wrong")'],
    ["formatted", 'h=e.values', 'h={}'],
    ["formatted", '{ignoreTag:e.ignoreTag}', '{ignoreTag:true}'],
    ["intlHook", 'return(0,i.HM)(e),e', 'return(0,i.HM)(e),{}'],
    ["flow", 'eh="macOS"===M&&s&&L&&N.data?.enabled!=null', 'eh=s&&L&&N.data?.enabled!=null'],
    ["flow", 'es.showComputerUseSetup&&es.showLockedComputerUse', 'es.showComputerUseSetup||es.showLockedComputerUse'],
    ["initial", 'codexMobile.setupDialog.initial.heading.windows', 'other.heading'],
    ["allow", 'codexMobile.setupDialog.initial.title.windows', 'other.title'],
  ];
  for (const [role, before, after] of mutations) rejects(input => replace(input, role, before, after));
  rejects(input => replace(input, "settings", '}});var eT=', '}});eP={};var eT='));
});

test("search publication, selected records, loader, state and section consumer fail closed", () => {
  for (const [role, before, after] of [
    ["search", 'settingsSearchDocuments:', 'otherDocuments:'],
    ["search", 'connections:[', 'otherConnections:['],
    ["searchConsumer", '.e(327607)', '.e(999999)'],
    ["searchConsumer", '.bind(s,"y5gB")', '.bind(s,"wrong")'],
    ["searchConsumer", 'e=>e.settingsSearchDocuments', 'e=>e.otherDocuments'],
    ["searchConsumer", 'messages:(W?.[e]??[])', 'messages:(X?.[e]??[])'],
    ["searchConsumer", ',sectionSlug:e,...null==t?{}:{terms:t}', '.filter(()=>false),sectionSlug:e,...null==t?{}:{terms:t}'],
    ["searchConsumer", 'SettingsLayout:()=>tL', 'SettingsLayout:()=>e7'],
  ]) rejects(input => replace(input, role, before, after));
  const row = contracts.searchMessages[0], text = `{defaultMessage:${JSON.stringify(row.defaultMessage)},id:${JSON.stringify(row.id)}}`;
  rejects(input => replace(input, "search", text, text + "," + text));
  rejects(input => replace(input, "search", text, `{defaultMessage:"wrong",id:${JSON.stringify(row.id)}}`));
});

test("all copies and physical dependencies are qualified before any no-op commit", () => temporary(root => {
  const input = sources();input["async/replica.js"] = input["async/remote-copy-settings.js"];
  assert.equal(prepare(snapshots(input)).targetCopies, 2);
  input["async/replica.js"] = input["async/replica.js"].replace('"macOS"!==J?', '"macOS"===J?');
  writeApp(root, input);assert.throws(() => apply84(root));assert.deepEqual(readApp(root, input), input);
  const cohort = snapshots();cohort.flow = [];assert.throws(() => prepare(cohort), /missing flow/);
  const physical = snapshots();physical.settings[0].start++;assert.throws(() => prepare(physical), /physical snapshot/);
}));

test("no-op atomic preflight rejects stale bytes and symlink dependencies without writes", () => temporary(root => {
  const input = sources(), assets = writeApp(root, input);
  const plan = prepare(snapshots(input));
  let reads = 0;
  assert.throws(() => apply84(root, { remoteCopyWriteOptions: {
    readFileSync(file) { const bytes = fs.readFileSync(file);return ++reads === 5 ? Buffer.concat([bytes, Buffer.from(" ")]) : bytes; },
    writeFileSync() { assert.fail("must not write"); },
  } }), /changed before patch commit/);
  assert.deepEqual(readApp(root, input), input);
  const name = "async/remote-copy-platformMap.js", file = path.join(assets, name), retained = file + ".retained";
  fs.renameSync(file, retained);fs.symlinkSync(retained, file);assert.throws(() => apply84(root), /Could not find|symlink|special files/);
  assert.throws(() => patchWebviewAssets(assets, plan.edits), /symlink|special files/);
  assert.equal(fs.readFileSync(retained, "utf8"), input[name]);
}));

test("actual84 and85 APIs compose in either order and preserve every native copy byte", () => {
  let expected;
  for (const order of [[84, 85], [85, 84]]) temporary(root => {
    const input = require("./fixtures/outbound-tab-harness.js").withCopySources(), name = "async/remote-copy-settings.js";writeApp(root, input);
    const apply = id => {
      if (id === 84) { assert.equal(apply84(root).changed, 0);return; }
      const before = readApp(root, input);const result = apply85(root);
      assert.equal(result.changed, JSON.stringify(before) === JSON.stringify(input) ? 1 : 0);
    };
    for (const id of order) apply(id);
    const output = readApp(root, input);
    for (const id of order) apply(id);
    assert.deepEqual(readApp(root, input), output);
    if (expected) assert.deepEqual(output, expected);else expected = output;
    for (const message of contracts.messages.settings) assert.ok(output[name].includes('defaultMessage:' + JSON.stringify(message.defaultMessage)));
    assert.doesNotMatch(output[name], /codexLinuxRemoteControlCopy/);
  });
});

test("copy-site qualification leaves the unrelated native revoke callback outside84 ownership", () => {
  const input = sources();replace(input, "settings", 'onRevoked:e=>{ej.setData(t=>t?.filter(t=>t.clientId!==e)),ej.invalidate()}', 'onRevoked:e=>{void e}');
  const plan = prepare(snapshots(input));assert.equal(plan.alreadyApplied, true);
  assert.equal(plan.edits.find(row => row.assetName.endsWith("settings.js")).patchedSource, input["async/remote-copy-settings.js"]);
});

test("root function-head authority rejects generators replacing published copy consumers or native providers", () => {
  for (const [role, suffix] of [
    ["settings", "function* t8(){return null}"],
    ["searchConsumer", "function* tL(){return null}"],
    ["settings", "async/*head*/function /*star*/ * /*name*/ t8({x}={}){return null}"],
    ["searchConsumer", "function\n*\n tL({x}={}){return null}"],
    ["settings", "function* O(){return null}"],
    ["settings", "function /*head*/ * /*name*/ p({x}={}){return null}"],
    ["settings", "function* n(){return null}"],
  ]) {
    const input = sources(), name = "async/remote-copy-" + role + ".js";
    input[name] = input[name].replace(/\}\};$/u, suffix + "}};");
    const cohort = snapshots(input), copy = cohort[role][0], before = JSON.stringify(input);
    new vm.Script(`"use strict";(function(${copy.params}){${copy.moduleSource}\n});`);
    assert.throws(() => prepare(cohort), /root function authority|redeclared import authority|redeclared factory parameter authority/);
    assert.equal(JSON.stringify(input), before);
  }
});

test("root function-head census leaves nested and opaque generator text outside native root authority", () => {
  const copy = { params: ["e", "t", "n"], start: 0,
    moduleSource: 'var p=n("native");function owner(){function* owner(){return null}return p}const text="function* owner(){}";/* function* owner(){} */' };
  assert.equal(scope.rootFunction(copy, "owner").name, "owner");
  assert.equal(scope.requireImport(copy, "p", copy.moduleSource.indexOf("return p") + 7, "native").moduleId, "native");
  for (const name of ["owner", "p", "n"]) {
    const changed = { ...copy, moduleSource: copy.moduleSource + `function /*head*/ * /*name*/ ${name}({x}={}){return null}` };
    if (name === "owner") assert.throws(() => scope.rootFunction(changed, name), /root function authority/);
    else assert.throws(() => scope.requireImport(changed, "p", changed.moduleSource.indexOf("return p") + 7, "native"), /redeclared import authority/);
  }
});
