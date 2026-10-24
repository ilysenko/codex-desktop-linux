"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const util = require("node:util");
const vm = require("node:vm");
const official = require("./fixtures/official-response-annotation.json");
const {
  GUARD_NAME, HANDLER_MARKER, RUNTIME_MARKER, enabled,
  codexLinuxResponseAnnotationOwnsSubmitShortcut: ownsShortcut,
  shortcutContract, patchSource, applyAnnotationSubmit,
} = require("./patches/selected-text-annotation-submit.js");

const enabledContext = { feature: { settings: { tweaks: { selection: { annotationSubmit: { enabled: true } } } } } };

class Element {
  constructor(parent = null, annotationEditor = false) {
    this.parent = parent;
    this.annotationEditor = annotationEditor;
    this.ownerDocument = null;
  }
  closest(selector) {
    if (selector !== "[data-selected-text-annotation-editor]") return null;
    for (let node = this; node; node = node.parent) if (node.annotationEditor) return node;
    return null;
  }
  contains(target) {
    for (let node = target; node; node = node.parent) if (node === this) return true;
    return false;
  }
}

function eventFixture(overrides = {}) {
  const editor = new Element(null, true);
  const form = new Element(editor);
  const input = new Element(form);
  const window = { Element, Node: Element, HTMLInputElement: class {}, HTMLTextAreaElement: class {} };
  const document = { defaultView: window, activeElement: input };
  for (const node of [editor, form, input]) node.ownerDocument = document;
  const event = { key: "Enter", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
    target: input, currentTarget: form, defaultPrevented: false, repeat: false,
    composedPath: () => [input, form, editor],
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
    ...overrides };
  event.nativeEvent = { isComposing: false, composedPath: () => event.composedPath(), ...overrides.nativeEvent };
  return { event, input, editor, form, window, document };
}

function nativeHandlers(source, eventState, { mode = "create", storedBody, draft = "当前批注文字", command = "composer.submit" } = {}) {
  const memo = (size) => Array(size).fill(Symbol.for("react.memo_cache_sentinel"));
  const annotations = [{ id: "annotation", text: "所选回复", annotation: storedBody }];
  let editing = { id: "annotation", mode, draftBody: draft };
  const scope = { get: (atom) => atom === "annotations" ? annotations : editing,
    set: (_atom, value) => { editing = value; } };
  const sent = [];
  let generalCalls = 0;
  const jobs = [];
  let registered;
  const context = vm.createContext({ Element, Symbol, ...eventState,
    YQs: { c: memo }, znt: { c: memo }, jji: () => false,
    Nji: (options) => { registered = options; },
    Kqt: () => {
      generalCalls += 1;
      jobs.push(context.flt(scope, {}).then((payload) => sent.push({ type: "general", annotations: payload.responseTextAnnotations })));
      editing = null;
      return true;
    },
    ic: "scope", YE: "annotations", Hy: "editor", so: () => scope, Z: (atom) => scope.get(atom),
    Bnt: { default: util.isDeepStrictEqual }, Vnt: { jsx: (_component, props) => props }, jnt: "markers",
    Zge: (...args) => context.SYr(...args), Uw() {}, BV: (_scope, edit) => edit({ responseTextAnnotations: annotations }),
    llt: () => [], aFe: async () => null, plt: async () => undefined,
    Ft: false, K: { getText: () => draft, view: { dom: eventState.input } }, Mn: { current: null },
    U: true, Ze: null, q: false, pe: true, L: false, kn: { current: [] }, Zn: false, wn: true,
    X: mode === "edit" ? "annotation" : null, R: true, fe: true,
  });
  vm.runInContext(source + "\n" + [official.Rnt, official.SYr, official.flt, official.Jr, official.oa, official.pa, official.gi].join("\n"), context);
  const callbacks = context.Rnt({ focusComposer() {}, onDirectSubmit: (request) => {
    assert.equal(request.isCurrent(), true);
    sent.push({ type: "annotation", annotation: request.annotation });
  } });
  context.C = ({ body }) => callbacks.onDirectSubmit("annotation", body);
  context.S = ({ body }) => callbacks.onUpdateAnnotation("annotation", body);
  vm.runInContext(`var _i=${official._i};var yi=_i;var Si=${official.Si};`, context);
  context.KQs({ id: command, accelerator: "Ctrl+Enter", capture: true, enabled: true, isMacOS: false });
  assert.equal(registered.capture, true);
  return { context, sent, jobs, dispatch() { registered.onKeyDown(eventState.event); context.Si(eventState.event); },
    get generalCalls() { return generalCalls; }, get editing() { return editing; } };
}

function appFixture(t, source = official.KQs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "annotation-submit-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const target = path.join(assets, "app-initial-current.js");
  fs.writeFileSync(target, source);
  fs.writeFileSync(path.join(assets, "annotation-comment-editor-card-current.js"),
    `let Si=${official.Si};const registration={onKeyDownCapture:Si};`);
  fs.writeFileSync(path.join(assets, "annotation-editor-current.js"),
    'import{t as Card}from"./annotation-comment-editor-card-current.js";' +
    'const editor={"data-selected-text-annotation-editor":!0,onDirectSubmit:direct,' +
    'label:`selectedTextAnnotationEditor.noteAriaLabel`};');
  return { root, assets, target };
}

const currentShortcutSource = official.KQs
  .replace("Kqt(n,e)&&e.preventDefault()", "(Kqt(n,e))&&(e.preventDefault())");

function withWarnings(callback) {
  const messages = [];
  const warn = console.warn;
  console.warn = (message) => messages.push(message);
  try { return { result: callback(), messages }; } finally { console.warn = warn; }
}

test("annotation submit is independently disabled by default and honors a disabled override", (t) => {
  assert.equal(require("./feature.json").tweaks.selection.annotationSubmit.enabled, false);
  assert.equal(enabled(), false);
  assert.equal(enabled(enabledContext), true);
  assert.equal(enabled({ feature: { manifest: enabledContext.feature.settings,
    settings: { tweaks: { selection: { annotationSubmit: { enabled: false } } } } } }), false);
  const app = appFixture(t);
  assert.deepEqual(applyAnnotationSubmit(app.root), { matched: 0, changed: 0 });
  assert.equal(fs.readFileSync(app.target, "utf8"), official.KQs);
});

test("patch discovers renamed native symbols, preserves registration and memo slots, and is idempotent", () => {
  const renamed = official.KQs.replace(/\b(KQs|YQs|Kqt|Nji|jji|n|p|e)\b/gu, (name) => `renamed_${name}`);
  const patched = patchSource(renamed);
  assert.equal(shortcutContract(patched).state, "applied");
  assert.equal(patchSource(patched), patched);
  assert.equal(patched.replace(`/*${HANDLER_MARKER}*/if(${GUARD_NAME}(renamed_n,renamed_e))return;`, "")
    .slice(0, renamed.length), renamed);
});

test("patch accepts the current shortcut target normalization and grouped dispatch", () => {
  const patched = patchSource(currentShortcutSource);
  assert.equal(shortcutContract(patched).state, "applied");
  assert.equal(patchSource(patched), patched);
});

test("unpatched capture handler reproduces loss of the initial unsaved annotation body", async () => {
  const native = nativeHandlers(official.KQs, eventFixture());
  native.dispatch();
  await Promise.all(native.jobs);
  assert.equal(native.generalCalls, 1);
  assert.equal(native.sent.length, 1);
  assert.equal(native.sent[0].annotations[0].text, "所选回复");
  assert.equal(native.sent[0].annotations[0].annotation, undefined);
  assert.equal(native.editing, null);
});

test("Ctrl+Enter sends the current native annotation body in create and edit modes", async () => {
  for (const mode of ["create", "edit"]) {
    const native = nativeHandlers(patchSource(official.KQs), eventFixture(), { mode, storedBody: "旧批注", draft: "  新批注  " });
    native.dispatch();
    await Promise.all(native.jobs);
    assert.equal(native.generalCalls, 0);
    assert.equal(native.sent.length, 1);
    assert.equal(native.sent[0].type, "annotation");
    assert.equal(native.sent[0].annotation.annotation, "新批注");
    assert.equal(native.sent[0].annotation.text, "所选回复");
    assert.equal(native.editing.draftBody, "  新批注  ");
  }
});

test("all regular composer send commands yield Ctrl+Enter inside the annotation editor", async () => {
  for (const command of ["composer.submit", "composer.submitInBackground", "composer.steer", "composer.queue"]) {
    const native = nativeHandlers(patchSource(official.KQs), eventFixture(), { command });
    native.dispatch();
    await Promise.all(native.jobs);
    assert.equal(native.generalCalls, 0);
    assert.equal(native.sent[0].annotation.annotation, "当前批注文字");
  }
});

test("ordinary composer Ctrl+Enter still sends when an annotation editor exists elsewhere", async () => {
  const eventState = eventFixture();
  const normalInput = new Element();
  normalInput.ownerDocument = eventState.document;
  eventState.event.target = normalInput;
  eventState.event.composedPath = () => [normalInput];
  eventState.document.activeElement = normalInput;
  const native = nativeHandlers(patchSource(official.KQs), eventState);
  native.dispatch();
  await Promise.all(native.jobs);
  assert.equal(native.generalCalls, 1);
  assert.equal(native.sent[0].type, "general");
});

test("native composition and key-repeat guards prevent both annotation and ordinary sends", () => {
  for (const overrides of [{ repeat: true }, { nativeEvent: { isComposing: true } }]) {
    const native = nativeHandlers(patchSource(official.KQs), eventFixture(overrides));
    native.dispatch();
    assert.equal(native.generalCalls, 0);
    assert.equal(native.sent.length, 0);
  }
});

test("scope matching handles retargeted events and Cmd+Enter without changing unrelated keys or commands", () => {
  const fixture = eventFixture();
  assert.equal(ownsShortcut("composer.submit", fixture.event), true);
  assert.equal(ownsShortcut("composer.submit", { ...fixture.event, target: new Element() }), true);
  assert.equal(ownsShortcut("composer.submit", { ...fixture.event, ctrlKey: false, metaKey: true }), true);
  for (const overrides of [{ key: "Escape" }, { key: "Enter", ctrlKey: false }, { altKey: true }, { shiftKey: true }]) {
    assert.equal(ownsShortcut("composer.submit", { ...fixture.event, ...overrides }), false);
  }
  assert.equal(ownsShortcut("artifact.sendAnnotations", fixture.event), false);
  assert.equal(ownsShortcut("composer.submit", { ...fixture.event, target: null, composedPath: undefined }), false);
});

test("patched capture handler preserves unrelated shortcut dispatch and modified Enter behavior", async () => {
  for (const options of [{ command: "artifact.sendAnnotations" }, { overrides: { altKey: true } }, { overrides: { shiftKey: true } }]) {
    const native = nativeHandlers(patchSource(official.KQs), eventFixture(options.overrides), options);
    native.dispatch();
    await Promise.all(native.jobs);
    assert.equal(native.generalCalls, 1);
    assert.equal(native.sent[0].type, "general");
  }
});

test("missing, ambiguous, changed, and partially patched contracts leave assets unchanged", (t) => {
  const patched = patchSource(official.KQs);
  for (const source of [
    official.KQs.replace("clearAllUnreads", "renamedCommand"),
    official.KQs + official.KQs,
    official.KQs.replace("Kqt(n,e)&&e.preventDefault()", "Kqt(n,e)"),
    official.KQs.replace("onKeyDown:p", "onKeyDown:otherHandler"),
    // The retired pre-26.1021 target guard is no longer accepted.
    official.KQs.replace(
      "p=e=>{let target=e.target instanceof Element?e.target:null;if(!e.defaultPrevented){",
      "p=e=>{if(e.target instanceof Element&&e.target,!e.defaultPrevented){",
    ),
    official.KQs.replace("id:n,accelerator:", "id:otherCommand,accelerator:"),
    official.KQs + `/*${RUNTIME_MARKER}*/`,
    patched.replace("return withinEditor(event.target)", "return false&&withinEditor(event.target)"),
    patched.replace(`if(${GUARD_NAME}(n,e))return;`, ""),
  ]) {
    const app = appFixture(t, source);
    const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
    assert.equal(result.result.changed, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(fs.readFileSync(app.target, "utf8"), source);
  }
});

test("an ambiguous asset set is rejected before either copy changes", (t) => {
  const app = appFixture(t);
  const duplicate = path.join(app.assets, "app-initial-duplicate.js");
  fs.writeFileSync(duplicate, official.KQs);
  const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
  assert.equal(result.result.changed, 0);
  assert.equal(result.messages.length, 1);
  assert.equal(fs.readFileSync(app.target, "utf8"), official.KQs);
  assert.equal(fs.readFileSync(duplicate, "utf8"), official.KQs);
});

test("missing or changed native annotation scope and Ctrl+Enter handling reject the patch", (t) => {
  for (const mutate of [
    (app) => fs.unlinkSync(path.join(app.assets, "annotation-editor-current.js")),
    (app) => {
      const target = path.join(app.assets, "annotation-editor-current.js");
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("data-selected-text-annotation-editor", "changed-editor-scope"));
    },
    (app) => {
      const target = path.join(app.assets, "annotation-comment-editor-card-current.js");
      fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace("e.ctrlKey", "e.changedModifier"));
    },
    (app) => fs.copyFileSync(path.join(app.assets, "annotation-editor-current.js"), path.join(app.assets, "annotation-editor-duplicate.js")),
  ]) {
    const app = appFixture(t);
    mutate(app);
    const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
    assert.equal(result.result.changed, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(fs.readFileSync(app.target, "utf8"), official.KQs);
  }
});

test("enabled patch changes one asset once and can coexist with another appended feature runtime", (t) => {
  const app = appFixture(t);
  assert.equal(applyAnnotationSubmit(app.root, enabledContext).changed, 1);
  fs.appendFileSync(app.target, "\nfunction unrelatedFeatureRuntime(){return true}\n");
  const patched = fs.readFileSync(app.target, "utf8");
  assert.equal(applyAnnotationSubmit(app.root, enabledContext).changed, 0);
  assert.equal(fs.readFileSync(app.target, "utf8"), patched);
});

// The behavioral tests above run a frozen excerpt of the native shortcut and
// annotation code. Minified names and chunk boundaries change every upstream
// release, so this signed test checks the semantic contract instead: the same
// owner discovery the patch uses must find exactly one shortcut owner in the
// current official ASAR, and the patch must apply once and validate.
test("current official ASAR exposes one native shortcut owner and accepts the patch", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, (t) => {
  const assets = path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview", "assets");
  const owners = fs.readdirSync(assets).filter((name) => /^[A-Za-z0-9_-]+\.js$/u.test(name))
    .map((name) => ({ name, source: fs.readFileSync(path.join(assets, name), "utf8") }))
    .filter(({ source }) => source.includes("clearAllUnreads") && source.includes("allowWithinEditable:"))
    .filter(({ source }) => {
      try { return shortcutContract(source).state === "current"; } catch { return false; }
    });
  assert.equal(owners.length, 1);
  assert.equal(shortcutContract(patchSource(owners[0].source)).state, "applied");

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "annotation-submit-official-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(process.env.CODEX_SIGNED_EXTRACTED_APP, copy, { recursive: true });
  const applied = applyAnnotationSubmit(copy, enabledContext);
  assert.equal(applied.changed, 1);
  assert.deepEqual(applied.targets, [path.join("webview", "assets", owners[0].name)]);
  const moreDetails = require("./patches/selected-text-more-details.js");
  const both = { feature: { settings: { tweaks: { selection: {
    annotationSubmit: { enabled: true }, moreDetails: { enabled: true },
  } } } } };
  assert.equal(moreDetails.applySelectedTextMoreDetails(copy, both).changed, 2);
  assert.equal(applyAnnotationSubmit(copy, both).changed, 0);
  assert.equal(moreDetails.applySelectedTextMoreDetails(copy, both).changed, 0);
});
