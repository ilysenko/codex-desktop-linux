"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Script } = require("node:vm");
const { mainBundleFixture } = require("../../scripts/patches/lib/global-shortcuts-portal.test-helpers.js");
const { applyWaylandGlobalShortcutsPatch } = require("../wayland-global-shortcuts/patch.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { descriptors, applyLinuxGlobalDictationMainProcessPatch: apply, inspectGlobalDictationMainProcess: inspect } = require("./patch.js");
const selected = normalizePatchDescriptors(descriptors.map(descriptor => ({ ...descriptor,
  id: "feature:global-dictation:" + descriptor.id, sourceKind: "feature", featureId: "global-dictation" })));
function fixture(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev"); fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "up33-owner-test-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite/build"); fs.mkdirSync(build, { recursive: true });
  for (const [name, source] of Object.entries(files)) fs.writeFileSync(path.join(build, name), source);
  return root;
}
function production(root) {
  const report = createPatchReport(); applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview"); return report.patches[0];
}
function unchanged(root, files) {
  for (const [name, source] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, ".vite/build", name), "utf8"), source, name);
}
function quiet(fn) {
  const old = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = old; }
}

test("normal descriptor applies one owned class and repeats with an existing shared backend", t => {
  for (const source of [mainBundleFixture(), applyWaylandGlobalShortcutsPatch(mainBundleFixture())]) {
    const files = { "early-bootstrap-45-abc.js": source, "early-bootstrap.js": "const unrelated=true;" }, root = fixture(t, files);
    assert.equal(production(root).status, "applied");
    const output = fs.readFileSync(path.join(root, ".vite/build/early-bootstrap-45-abc.js"), "utf8");
    assert.equal(inspect(output).state, "patched"); assert.equal(production(root).status, "already-applied");
    assert.equal(fs.readFileSync(path.join(root, ".vite/build/early-bootstrap.js"), "utf8"), files["early-bootstrap.js"]);
  }
});

test("normal descriptor refuses fake marker, unused class, damaged callbacks and helper authority", t => {
  const source = mainBundleFixture(), canonical = apply(source);
  const variants = {
    fakeOwnMarker: source + '\n/*codex-linux-global-dictation-v3*/',
    unusedController: source.replace("L=new H7({windowManager:D,globalState:G})", "L={}"),
    reassignedController: source.replace(";return{windowManager:D", ";L={};return{windowManager:D"),
    logicalReassignedController: source.replace(";return{windowManager:D", ";L&&={};return{windowManager:D"),
    destructuredController: source.replace(";return{windowManager:D", ";[L]=[{}];return{windowManager:D"),
    objectDestructuredController: source.replace(";return{windowManager:D", ";({value:L}={value:{}});return{windowManager:D"),
    shadowedController: source.replace("let L=new H7", "let H7=class{};let L=new H7"),
    staticRegistration: source.replace("registerHotkeyOrThrow(e,t){", "static registerHotkeyOrThrow(e,t){"),
    commentedStaticRegistration: source.replace("registerHotkeyOrThrow(e,t){", "static/*inert*/registerHotkeyOrThrow(e,t){"),
    generatorRegistration: source.replace("registerHotkeyOrThrow(e,t){", "*registerHotkeyOrThrow(e,t){"),
    asyncRegistration: source.replace("registerHotkeyOrThrow(e,t){", "async registerHotkeyOrThrow(e,t){"),
    asyncGeneratorRegistration: source.replace("registerHotkeyOrThrow(e,t){", "async/*inert*/*registerHotkeyOrThrow(e,t){"),
    staticGeneratorRegistration: source.replace("registerHotkeyOrThrow(e,t){", "static/*inert*/*registerHotkeyOrThrow(e,t){"),
    damagedPrimaryGate: canonical.replace('this.setupWindowFocused||this.shortcutGestures.release("primary")', 'this.shortcutGestures.release("primary")'),
    noopOwnHelper: canonical.replace("function codexLinuxGlobalDictationReleaseWatcher(accelerator, onReleased)", "function unrelatedReleaseWatcher(accelerator, onReleased)"),
    wrongPasteRoute: canonical.replace(/await codexLinuxGlobalDictationPasteX11\([^)]*\)/u, "await unrelatedPaste()"),
  };
  for (const [name, variant] of Object.entries(variants)) {
    const original = ["damagedPrimaryGate", "noopOwnHelper", "wrongPasteRoute"].includes(name) ? canonical : source;
    assert.notEqual(variant, original, name);
    assert.doesNotThrow(() => new Script(variant), name);
    const files = { "early-bootstrap-45-abc.js": variant }, root = fixture(t, files);
    assert.equal(quiet(() => production(root)).status, "skipped-optional", name); unchanged(root, files);
  }
});

for (const kind of ["duplicate", "mixed", "opaque", "quoted", "exponent", "hex", "damagedSameId", "orphanHelper", "orphanMarker"]) {
  test(`normal descriptor refuses ${kind} cohort before writing`, t => {
    const source = mainBundleFixture(), canonical = apply(source), files = { "early-bootstrap-45-abc.js": source };
    if (kind === "duplicate") files["early-bootstrap-46-def.js"] = source;
    else if (kind === "mixed") files["early-bootstrap-46-def.js"] = canonical;
    else if (kind === "damagedSameId") files["early-bootstrap-46-def.js"] = source.replace("L=new H7({windowManager:D,globalState:G})", "L={}");
    else if (kind === "orphanHelper") files["early-bootstrap-46-def.js"] = "function codexLinuxGlobalDictationPasteX11(){}";
    else if (kind === "orphanMarker") files["early-bootstrap-46-def.js"] = 'const note="codex-linux-global-dictation-v3";';
    else files["early-bootstrap-46-def.js"] = `exports.ids=[46],exports.modules={${kind === "quoted" ? '"82820"' : kind === "exponent" ? "8.282e4" : kind === "hex" ? "0x14384" : "82820"}(){return false}};`;
    const root = fixture(t, files); assert.equal(quiet(() => production(root)).status, "skipped-optional"); unchanged(root, files);
  });
}

test("dictation owner transaction restores partial writes and treats failed restoration as fatal", t => {
  for (const fatal of [false, true]) {
    const files = { "early-bootstrap-45-abc.js": mainBundleFixture() }, root = fixture(t, files), target = path.join(root, ".vite/build/early-bootstrap-45-abc.js"), originalWrite = fs.writeFileSync;
    let attempted = false;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (file === target) {
        if (!attempted) { attempted = true; originalWrite(file, "partial-write"); throw Error("inert write failure"); }
        if (fatal) throw Error("inert restore failure");
      }
      return originalWrite(file, bytes, ...options);
    };
    try {
      if (fatal) assert.throws(() => quiet(() => production(root)), /rollback could not restore original bytes/u);
      else assert.equal(quiet(() => production(root)).status, "skipped-optional");
    } finally { fs.writeFileSync = originalWrite; }
    assert.equal(attempted, true); if (!fatal) unchanged(root, files);
  }
});

test("anonymous clipboard authority protects arguments, abort, timing and native completion", t => {
  const source = mainBundleFixture(), native = inspect(source).plan, canonical = apply(source);
  const signal = native.bridge.parameterNames[3];
  const wrongPasteSignal = source.slice(0, native.paste.end + 1) + "void 0" +
    source.slice(native.paste.end + 1 + signal.length);
  const variants = {
    wrongFifoController: canonical.replace("codexLinuxGlobalDictationClipboard(this,async function", "codexLinuxGlobalDictationClipboard({},async function"),
    nonAwaitedClipboard: source.replace("let o=await async function", "let o=async function"),
    wrongFourthArgument: source.replace('`${s} `,n,i,a.signal', '`${s} `,n,i,other.signal'),
    wrongStopFingerprint: source.replace("i=this.clipboardFingerprintAtStop", "i=this.otherClipboardFingerprint"),
    wrongSessionCompletion: source.replace("this.pendingPasteSessionId===e&&(", "this.pendingPasteSessionId!==e&&("),
    changedInitialAbort: source.replace("if(i?.aborted)return null;", "if(i?.aborted)return{text:e};"),
    changedHandoff: source.replace("Math.max(0,150-n)", "Math.max(0,250-n)"),
    changedRestoreWait: source.replace("(700)}catch", "(250)}catch"),
    wrongPasteSignal,
    missingNativeAccessibility: source.replace("AXUIElementPerformAction", "MissingNativeAccessibilityAction"),
    partialFifoHelper: canonical.replace("const previous = codexLinuxGlobalDictationClipboardQueues.get(controller)", "const previous = unrelatedQueues.get(controller)"),
  };
  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(variant, name.startsWith("wrongFifo") || name === "partialFifoHelper" ? canonical : source, name);
    assert.doesNotThrow(() => new Script(variant), name);
    assert.equal(inspect(variant).state, "drifted", name);
    const files = { "early-bootstrap-45-abc.js": variant }, root = fixture(t, files);
    assert.equal(quiet(() => production(root)).status, "skipped-optional", name);
    unchanged(root, files);
  }
});

test("foreign factory and inert clipboard text do not become a consumed transcript owner", t => {
  const source = mainBundleFixture(), native = inspect(source).plan;
  const inert = source.replace('"use strict";', '"use strict";const clipboardDocumentation=' + JSON.stringify(native.bridge.text) + ';');
  const foreign = mainBundleFixture({ extra: ',99999(){return ' + JSON.stringify(native.bridge.text) + '}' });
  for (const value of [inert, foreign]) {
    const files = { "early-bootstrap-45-abc.js": value }, root = fixture(t, files);
    assert.equal(production(root).status, "applied");
    const output = fs.readFileSync(path.join(root, ".vite/build/early-bootstrap-45-abc.js"), "utf8");
    assert.equal(inspect(output).state, "patched");
    assert.equal(production(root).status, "already-applied");
  }
});

test("named function fields cannot impersonate the native constructor or registration method", t => {
  const source = mainBundleFixture(), plan = inspect(source).plan;
  for (const name of ["constructor", "registerHotkeyOrThrow", "ensureHotkeyReleaseWatchers"]) {
    const method = plan.methods[name];
    const variant = source.slice(0, method.start) + `fieldFor${name}=function ` + method.text + ";" + source.slice(method.end);
    assert.doesNotThrow(() => new Script(variant), name);
    assert.equal(inspect(variant).state, "drifted", name);
    const files = { "early-bootstrap-45-abc.js": variant }, root = fixture(t, files);
    assert.equal(quiet(() => production(root)).status, "skipped-optional", name);
    unchanged(root, files);
  }
});

test("native in-app Escape stop/cancel policy cannot be flattened in raw or canonical source", t => {
  const source = mainBundleFixture(), canonical = apply(source);
  for (const input of [source, canonical]) {
    const variant = input.replace('this.activeSession?.type!=="inApp"||this.shortcutGestures.hasPendingStart?this.shortcutGestures.cancel():this.stopRecording(this.activeSession.id)', 'this.shortcutGestures.cancel()');
    assert.notEqual(variant, input);
    assert.doesNotThrow(() => new Script(variant));
    assert.equal(inspect(variant).state, "drifted");
    const files = { "early-bootstrap-45-abc.js": variant }, root = fixture(t, files);
    assert.equal(quiet(() => production(root)).status, "skipped-optional");
    unchanged(root, files);
  }
});

test("protected native instance methods reject public own-field shadows in raw and canonical states", t => {
  const raw = mainBundleFixture(), canonical = apply(raw);
  const fields = {
    transcript: 'handleTranscript=async()=>{};',
    holdRegistration: 'registerHotkeyOrThrow=()=>{};',
    toggleRegistration: 'registerToggleHotkeyOrThrow=()=>{};',
    unregisterHold: 'unregisterHotkey=()=>{};',
    releaseWatchers: 'ensureHotkeyReleaseWatchers=()=>{};',
    escape: 'updateEscapeRegistration=()=>{};',
    quoted: '"handleTranscript"=async()=>{};',
    computedQuoted: '["handleTranscript"]=async()=>{};',
    computedHex: "['handleTranscr\\x69pt']=async()=>{};",
    computedTemplate: '[`handleTranscript`]=async()=>{};',
    computedComments: '[/*key*/"handleTranscript"/*end*/]/*value*/=async()=>{};',
    unicodeIdentifier: 'handl\\u0065Transcript=async()=>{};',
    unicodeQuoted: '"handl\\u0065Transcript"=async()=>{};',
    noInitializer: 'handleTranscript;',
    asi: 'handleTranscript=async()=>{}\n',
    commentAsi: 'handleTranscript=async()=>{}/*\nASI*/',
    unknownComputed: '[unprovenKey]=async()=>{};',
    computedExpression: '["handle"+"Transcript"]=async()=>{};',
  };
  for (const [state, input] of [["raw", raw], ["canonical", canonical]]) {
    const controller = inspect(input).plan.controller;
    for (const [name, field] of Object.entries(fields)) {
      const variant = input.slice(0, controller.bodyStart) + field + input.slice(controller.bodyStart);
      assert.doesNotThrow(() => new Script(variant), `${state}/${name}`);
      assert.equal(inspect(variant).state, "drifted", `${state}/${name}`);
      const files = { "early-bootstrap-45-abc.js": variant }, root = fixture(t, files);
      assert.equal(quiet(() => production(root)).status, "skipped-optional", `${state}/${name}`);
      unchanged(root, files);
    }
  }
});

test("static, private and unrelated class members preserve the selected native instance method", t => {
  const raw = mainBundleFixture(), canonical = apply(raw);
  const fields = {
    staticField: 'static handleTranscript=async()=>{};',
    staticQuoted: 'static ["registerHotkeyOrThrow"]=()=>{};',
    staticMethod: 'static handleTranscript(){}',
    privateField: '#handleTranscript=async()=>{};',
    privateMethod: '#registerHotkeyOrThrow(){}',
    unrelatedField: 'unrelatedField="handleTranscript";',
    unrelatedTemplate: '[`unrelatedField`]=1;',
    inertData: 'documentation="[\\"handleTranscript\\"]=async()=>{}";',
  };
  for (const [state, input] of [["raw", raw], ["canonical", canonical]]) {
    const controller = inspect(input).plan.controller;
    for (const [name, field] of Object.entries(fields)) {
      const variant = input.slice(0, controller.bodyStart) + field + input.slice(controller.bodyStart);
      assert.doesNotThrow(() => new Script(variant), `${state}/${name}`);
      assert.equal(inspect(variant).state, state === "raw" ? "current" : "patched", `${state}/${name}`);
      const files = { "early-bootstrap-45-abc.js": variant }, root = fixture(t, files);
      assert.equal(production(root).status, state === "raw" ? "applied" : "already-applied", `${state}/${name}`);
      const output = fs.readFileSync(path.join(root, ".vite/build/early-bootstrap-45-abc.js"), "utf8");
      assert.equal(inspect(output).state, "patched", `${state}/${name}`);
      assert.equal(production(root).status, "already-applied", `${state}/${name}`);
    }
  }
});
