"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const util = require("node:util");
const vm = require("node:vm");
const { execFileSync } = require("node:child_process");
const official = require("./fixtures/official-response-annotation.json");
const {
  GUARD_NAME, HANDLER_MARKER, RUNTIME_MARKER, enabled,
  codexLinuxResponseAnnotationOwnsSubmitShortcut: ownsShortcut,
  shortcutContract, patchSource, applyAnnotationSubmit, discoverAnnotationSubmitAssets, validateNativeEditor,
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
    composedPath: () => [input, form, editor], getModifierState: () => false,
    prevented: 0, stopped: 0,
    preventDefault() { this.prevented += 1; this.defaultPrevented = true; }, stopPropagation() { this.stopped += 1; },
    ...overrides };
  event.nativeEvent = { isComposing: false, composedPath: () => event.composedPath(), ...overrides.nativeEvent };
  return { event, input, editor, form, window, document };
}

// Runs the frozen official excerpts: the app shortcut owner (window capture
// handler), the annotation card's capture keydown handler and its submit
// path, and the composer's direct-submit callbacks and annotation store.
function nativeHandlers(source, eventState, { mode = "create", storedBody, draft = "当前批注文字", command = "composer.submit", canSubmit = true, busy = false } = {}) {
  const memo = (size) => Array(size).fill(Symbol.for("react.memo_cache_sentinel"));
  const annotations = [{ id: "annotation", text: "所选回复", annotation: storedBody }];
  let editing = { id: "annotation", mode, draftBody: draft };
  const scope = { get: (atom) => atom === "annotations" ? annotations : editing,
    set: (_atom, value) => { editing = value; } };
  const sent = [];
  let generalCalls = 0;
  let draftReads = 0;
  const jobs = [];
  let registered;
  const deepEqual = () => util.isDeepStrictEqual;
  deepEqual.current = [];
  const context = vm.createContext({ Element, Symbol, Promise, ...eventState,
    // Shortcut owner dependencies.
    c: { c: memo, R: null }, la: { QR: () => false, TY: (target) => target instanceof Element },
    li: { EE: (options) => { registered = options; } },
    lo: { aP: () => false, W7: () => {
      generalCalls += 1;
      jobs.push(context.uN(scope, {}).then((payload) => sent.push({ type: "general", annotations: payload.responseTextAnnotations })));
      editing = null;
      return true;
    } },
    // Composer direct-submit callbacks and annotation store dependencies.
    a: { c: memo }, u: { gh: () => scope, Ul: (atom) => scope.get(atom) }, tT: { PR: "scope" },
    oS: { zJ: "annotations", zX: "editor", A_: (...args) => context.tI(...args), q5() {} },
    o: { jsx: (_component, props) => props }, iz: "markers", rR: deepEqual,
    tr: (_scope, edit) => edit({ responseTextAnnotations: annotations }),
    uD: { d: () => [] }, cP: { lg: async () => null }, uU: async () => undefined,
    // Synthetic direct policy for this frozen model. Signed tests below derive
    // the current editor's default saved policy from the actual wrapper.
    i: canSubmit, t3: busy, ne: () => false, nr: false, nn: false, na: false, r6: { current: null }, nc() {},
    rI: { current: null }, eE: true, es: false, eu: false, eJ: null, te: false, rD: true, q: null,
    eF: { getText: () => { draftReads += 1; return draft; }, view: { dom: eventState.input } },
    nH: mode === "edit" ? "annotation" : null, ed: true, ec: true, n7: "direct",
  });
  vm.runInContext([source, official.submitComment, official.withoutDesignControls, official.directSubmitCallbacks,
    official.updateAnnotation, official.collectComposerContext,
    `var n={nl:(${official.commentSubmission}),FJ:(${official.designEditorOpen})};`,
    `c.R=(${official.resolveCommentSubmission});`,
    `var annotationKeyDown=${official.annotationKeyDown};`].join("\n"), context);
  const callbacks = context.iQ({ focusComposer() {}, onDirectSubmit: (request) => {
    assert.equal(request.isCurrent(), true);
    sent.push({ type: "annotation", annotation: request.annotation });
  } });
  context.U = ({ body }) => callbacks.onDirectSubmit("annotation", body);
  context.W = ({ body }) => callbacks.onUpdateAnnotation("annotation", body);
  context.lh({ id: command, accelerator: "Ctrl+Enter", capture: true, runInRenderer: true, isMacOS: false });
  assert.equal(registered.capture, true);
  return { context, sent, jobs, dispatch() { registered.onKeyDown(eventState.event); context.annotationKeyDown(eventState.event); },
    get generalCalls() { return generalCalls; }, get editing() { return editing; }, get draftReads() { return draftReads; } };
}

function chunk(id, modules) {
  return `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
    `export const __webpack_modules__={${modules}};\n//# sourceMappingURL=${id}.js.map`;
}

const editorModule = `Edit(e,t,r){${official.editorModule.replace('u=r("ntJV")','u=r("Card")')}}`;
const cardModule = `Card(e,t,r){r.d(t,{s:()=>tq});${official.cardWrapper}${official.nativeInnerHeader}${official.submitComment};return{onKeyDownCapture:${official.annotationKeyDown}}}}`;

function appFixture(t, source = official.shortcutOwner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "annotation-submit-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  const target = path.join(assets, "async", "100001.0000000001.js");
  const ownerChunk = chunk(100001, `Shrt(e,t,r){r.d(t,{x:()=>lh});${source}}`);
  fs.writeFileSync(target, ownerChunk);
  fs.writeFileSync(path.join(assets, "async", "100002.0000000002.js"), chunk(100002, cardModule));
  fs.writeFileSync(path.join(assets, "async", "100003.0000000003.js"), chunk(100003, editorModule));
  fs.writeFileSync(path.join(assets, "100004.0000000004.js"), chunk(100004, 'Main(e,t,r){r.e(100003)}'));
  return { root, assets, target, ownerChunk };
}

const currentShortcutSource = official.shortcutOwner
  .replace("(0,lo.W7)(s,e)&&(e.preventDefault(),", "((0,lo.W7)(s,e))&&(e.preventDefault(),");

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
  assert.equal(fs.readFileSync(app.target, "utf8"), app.ownerChunk);
});

test("patch discovers renamed native symbols, preserves registration and memo slots, and is idempotent", () => {
  const renamed = official.shortcutOwner.replace(/\b(lh|c|la|lo|li|s|n|e)\b/gu, (name) => `renamed_${name}`);
  const patched = patchSource(renamed);
  assert.equal(shortcutContract(patched).state, "applied");
  assert.equal(patchSource(patched), patched);
  assert.equal(patched.replace(`/*${HANDLER_MARKER}*/if(${GUARD_NAME}(renamed_s,renamed_e))return;`, "")
    .slice(0, renamed.length), renamed);
});

test("patch accepts the current shortcut target normalization and grouped dispatch", () => {
  assert.notEqual(currentShortcutSource, official.shortcutOwner);
  const patched = patchSource(currentShortcutSource);
  assert.equal(shortcutContract(patched).state, "applied");
  assert.equal(patchSource(patched), patched);
});

test("unpatched capture handler reproduces loss of the initial unsaved annotation body", async () => {
  const native = nativeHandlers(official.shortcutOwner, eventFixture());
  native.dispatch();
  await Promise.all(native.jobs);
  assert.equal(native.generalCalls, 1);
  assert.equal(native.sent.length, 1);
  assert.equal(native.sent[0].annotations[0].text, "所选回复");
  assert.equal(native.sent[0].annotations[0].annotation, undefined);
  assert.equal(native.editing, null);
});

test("synthetic direct policy sends the current annotation body in create and edit modes", async () => {
  for (const mode of ["create", "edit"]) {
    const eventState = eventFixture();
    const native = nativeHandlers(patchSource(official.shortcutOwner), eventState, { mode, storedBody: "旧批注", draft: "  新批注  " });
    native.dispatch();
    await Promise.all(native.jobs);
    assert.equal(native.generalCalls, 0);
    assert.equal(native.sent.length, 1);
    assert.equal(native.sent[0].type, "annotation");
    assert.equal(native.sent[0].annotation.annotation, "新批注");
    assert.equal(native.sent[0].annotation.text, "所选回复");
    assert.equal(native.editing.draftBody, "  新批注  ");
    assert.equal(native.draftReads, 1);
    assert.equal(eventState.event.prevented, 1);
    assert.equal(eventState.event.stopped, 1);
    native.dispatch();
    assert.equal(native.sent.length, 1, "the same consumed event cannot submit twice");
  }
});

test("all regular composer send commands yield Ctrl+Enter inside the annotation editor", async () => {
  for (const command of ["composer.submit", "composer.submitInBackground", "composer.steer", "composer.queue"]) {
    const native = nativeHandlers(patchSource(official.shortcutOwner), eventFixture(), { command });
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
  const native = nativeHandlers(patchSource(official.shortcutOwner), eventState);
  native.dispatch();
  await Promise.all(native.jobs);
  assert.equal(native.generalCalls, 1);
  assert.equal(native.sent[0].type, "general");
});

test("native composition and key-repeat guards prevent both annotation and ordinary sends", () => {
  for (const overrides of [{ repeat: true }, { nativeEvent: { isComposing: true } }]) {
    const native = nativeHandlers(patchSource(official.shortcutOwner), eventFixture(overrides));
    native.dispatch();
    assert.equal(native.generalCalls, 0);
    assert.equal(native.sent.length, 0);
  }
});

test("native current-text validation still rejects blank, disabled and busy submissions", () => {
  for (const options of [{ draft: "   " }, { canSubmit: false }, { busy: true }]) {
    const native = nativeHandlers(patchSource(official.shortcutOwner), eventFixture(), options);
    native.dispatch();
    assert.equal(native.generalCalls, 0);
    assert.equal(native.sent.length, 0);
    assert.equal(native.draftReads, options.draft === "   " ? 1 : 0);
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
    const native = nativeHandlers(patchSource(official.shortcutOwner), eventFixture(options.overrides), options);
    native.dispatch();
    await Promise.all(native.jobs);
    assert.equal(native.generalCalls, 1);
    assert.equal(native.sent[0].type, "general");
  }
});

test("missing, ambiguous, changed, and partially patched contracts leave assets unchanged", (t) => {
  const patched = patchSource(official.shortcutOwner);
  const handler = "n=e=>{if(e.target instanceof Element&&e.target,e.defaultPrevented)return;";
  for (const source of [
    official.shortcutOwner.replace("clearAllUnreads", "renamedCommand"),
    official.shortcutOwner + official.shortcutOwner,
    official.shortcutOwner.replace("(0,lo.W7)(s,e)","(0,lo.W7)(s,wrongEvent)")
      .replace("return i[3]",'if(false){(0,lo.W7)(s,e)&&(e.preventDefault())}return i[3]'),
    official.shortcutOwner.replace("(0,lo.W7)(s,e)&&(e.preventDefault(),", "(0,lo.W7)(s,e)&&(e.stopPropagation(),"),
    official.shortcutOwner.replace("onKeyDown:n}", "onKeyDown:otherHandler}"),
    // Retired handler preambles are no longer accepted.
    official.shortcutOwner.replace(handler,
      "n=e=>{let target=e.target instanceof Element?e.target:null;if(e.defaultPrevented)return;"),
    official.shortcutOwner.replace(handler,
      "n=e=>{if(e.target instanceof Element&&e.target,!e.defaultPrevented)return;"),
    // Retired template-literal command comparisons are no longer accepted.
    official.shortcutOwner.replace('"focusPageBlockControls"===s', "s===`focusPageBlockControls`"),
    official.shortcutOwner.replace("id:s,accelerator:", "id:otherCommand,accelerator:"),
    official.shortcutOwner + `/*${RUNTIME_MARKER}*/`,
    patched.replace("return withinEditor(event.target)", "return false&&withinEditor(event.target)"),
    patched.replace(`if(${GUARD_NAME}(s,e))return;`, ""),
  ]) {
    assert.notEqual(source, official.shortcutOwner);
    const app = appFixture(t, source);
    const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
    assert.equal(result.result.changed, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(fs.readFileSync(app.target, "utf8"), app.ownerChunk);
  }
});

test("duplicate rspack shortcut owners are patched as one semantic owner set", (t) => {
  const app = appFixture(t);
  const duplicate = path.join(app.assets, "async", "100005.0000000005.js");
  fs.copyFileSync(app.target, duplicate);
  const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
  assert.equal(result.result.matched, 2);
  assert.equal(result.result.changed, 2);
  assert.deepEqual(result.messages, []);
  assert.equal(shortcutContract(fs.readFileSync(app.target, "utf8")).state, "applied");
  assert.equal(shortcutContract(fs.readFileSync(duplicate, "utf8")).state, "applied");
});

test("missing or changed native annotation scope and Ctrl+Enter handling reject the patch", (t) => {
  const editor = (app) => path.join(app.assets, "async", "100003.0000000003.js");
  const card = (app) => path.join(app.assets, "async", "100002.0000000002.js");
  const rewrite = (file, from, to) => {
    const source = fs.readFileSync(file, "utf8");
    assert.ok(source.includes(from));
    fs.writeFileSync(file, source.replace(from, to));
  };
  for (const mutate of [
    (app) => fs.unlinkSync(editor(app)),
    (app) => rewrite(editor(app), "data-selected-text-annotation-editor", "changed-editor-scope"),
    // The editor must render the card module it requires, with onDirectSubmit.
    (app) => rewrite(editor(app), 'u=r("Card")', 'u=r("Other")'),
    (app) => rewrite(editor(app), 'u=r("Card")', 'u=wrongLoader("Card")'),
    (app) => rewrite(editor(app), 'async()=>T(t)', 'async()=>L(t)'),
    (app) => rewrite(editor(app), 'SelectedTextAnnotationEditor:()=>f', 'SelectedTextAnnotationEditor:()=>wrongEditor'),
    (app) => rewrite(editor(app), "(0,a.jsx)(u.s,", "(0,a.jsx)(u.other,"),
    (app) => rewrite(editor(app), "onDirectSubmit:B", "onWrongSubmit:B"),
    (app) => fs.unlinkSync(card(app)),
    (app) => rewrite(card(app), "r.d(t,{s:()=>tq})", "r.d(t,{other:()=>tq})"),
    (app) => rewrite(card(app), "e.ctrlKey", "e.changedModifier"),
    (app) => rewrite(card(app), "onDirectSubmit:F,", "onDirectSubmit:wrong,"),
    (app) => rewrite(card(app), "commentText:eF.getText()", "commentText:wrongEditor.getText()"),
    (app) => rewrite(card(app), "submitMode:e", "submitMode:wrongMode"),
    (app) => rewrite(card(app), '"direct"===e?U(n.payload):W(n.payload)', '"direct"===e?W(n.payload):U(n.payload)'),
    (app) => rewrite(card(app), 'n8("direct","keyboard")', 'n8("saved","keyboard")'),
    (app) => rewrite(card(app), "if(e.defaultPrevented||e.nativeEvent.isComposing)return;", "if(e.defaultPrevented)return;"),
    (app) => fs.copyFileSync(editor(app), path.join(app.assets, "async", "100006.0000000006.js")),
  ]) {
    const app = appFixture(t);
    mutate(app);
    const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
    assert.equal(result.result.changed, 0);
    assert.equal(result.messages.length, 1);
    assert.equal(fs.readFileSync(app.target, "utf8"), app.ownerChunk);
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

test("a damaged second shortcut owner is not ignored while patching the valid owner", (t) => {
  const app = appFixture(t);
  const duplicate = path.join(app.assets, "async", "100005.0000000005.js");
  const damaged = app.ownerChunk.replace("onKeyDown:n}", "onKeyDown:wrongHandler}");
  assert.notEqual(damaged, app.ownerChunk);
  fs.writeFileSync(duplicate, damaged);
  const result = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
  assert.equal(result.result.changed, 0);
  assert.equal(fs.readFileSync(app.target, "utf8"), app.ownerChunk);
  assert.equal(fs.readFileSync(duplicate, "utf8"), damaged);
});

test("all legitimate native card replicas validate before the one shortcut owner changes", (t) => {
  const app = appFixture(t);
  const card = path.join(app.assets, "async", "100002.0000000002.js");
  const duplicate = path.join(app.assets, "async", "100007.0000000007.js");
  fs.copyFileSync(card, duplicate);
  assert.equal(applyAnnotationSubmit(app.root, enabledContext).changed, 1);
  assert.equal(applyAnnotationSubmit(app.root, enabledContext).changed, 0);
  const patched = fs.readFileSync(app.target, "utf8");
  fs.writeFileSync(duplicate, fs.readFileSync(duplicate, "utf8").replace("commentText:eF.getText()", "commentText:wrongEditor.getText()"));
  const rejected = withWarnings(() => applyAnnotationSubmit(app.root, enabledContext));
  assert.equal(rejected.result.changed, 0);
  assert.equal(rejected.messages.length, 1);
  assert.equal(fs.readFileSync(app.target, "utf8"), patched);
});

test("an unrecoverable write rollback remains a fatal patch integrity failure", (t) => {
  const app = appFixture(t), write = fs.writeFileSync;
  try {
    fs.writeFileSync = (file, ...args) => {
      if (path.resolve(file) === app.target) {
        write(file, "damaged fixture");
        throw new Error("injected write/rollback failure");
      }
      return write(file, ...args);
    };
    assert.throws(() => applyAnnotationSubmit(app.root, enabledContext), error => error.code === "PATCH_INTEGRITY_FAILURE");
  } finally { fs.writeFileSync = write; }
});

// The behavioral tests above run frozen excerpts of the native shortcut and
// annotation code. Minified names and rspack chunk boundaries change every
// upstream release, so this signed test checks the semantic contract instead:
// the same discovery the patch uses must find exactly one shortcut owner and
// one native editor -> card linkage in the current official ASAR, and the
// patch must apply once and validate.
for (const id of ["Shrt", "Edit", "Card"]) {
  test(`markerless same-ID ${id} replicas reject before writes in raw and canonical state`, t => {
    for (const canonical of [false,true]) {
      const app = appFixture(t);
      if (canonical) assert.equal(applyAnnotationSubmit(app.root,enabledContext).changed,1);
      const replica = path.join(app.assets,"async/100009.0000000009.js");
      fs.writeFileSync(replica,chunk(100009,`${id}(e,t,r){return false}`));
      const files = [app.target,replica,path.join(app.assets,"async/100002.0000000002.js"),path.join(app.assets,"async/100003.0000000003.js")];
      const before = new Map(files.map(file => [file,fs.readFileSync(file)]));
      const result = withWarnings(() => applyAnnotationSubmit(app.root,enabledContext));
      assert.equal(result.result.changed,0);
      assert.equal(result.messages.length,1);
      for (const [file,bytes] of before) assert.deepEqual(fs.readFileSync(file),bytes);
    }
  });
}

test("shortcut and card owners require ordinary statement declarations", t => {
  const shortcutName = /^function ([\w$]+)/u.exec(official.shortcutOwner)[1];
  const wrapperName = /^function ([\w$]+)/u.exec(official.cardWrapper)[1];
  const innerName = /^function ([\w$]+)/u.exec(official.nativeInnerHeader)[1];
  for (const [kind,name] of [["shortcut",shortcutName],["wrapper",wrapperName],["inner",innerName]]) {
    for (const form of ["named-expression","async","async-comment","generator"]) {
      const app = appFixture(t),file = kind === "shortcut" ? app.target : path.join(app.assets,"async/100002.0000000002.js");
      const source = fs.readFileSync(file,"utf8"),head = new RegExp(`function ${name}\\([^)]*\\)\\{`,"u").exec(source);
      assert.ok(head);
      const open = head.index+head[0].length-1;
      const close = require("../../scripts/patches/lib/minified-js.js").findMatchingBrace(source,open);
      const fn = source.slice(head.index,close+1);
      const replacement = form === "named-expression" ? `const unused${name}=${fn};` : fn.replace(`function ${name}`,form === "async" ? `async function ${name}` : form === "async-comment" ? `async/*gap*/function ${name}` : `function* ${name}`);
      const damaged = source.slice(0,head.index)+replacement+source.slice(close+1);
      assert.notEqual(damaged,source);
      assert.equal(require("../../scripts/patches/lib/javascript-syntax.js").javascriptSourceParses(damaged),true);
      fs.writeFileSync(file,damaged);
      const before = new Map([app.target,file].map(target => [target,fs.readFileSync(target)]));
      const result = withWarnings(() => applyAnnotationSubmit(app.root,enabledContext));
      assert.equal(result.result.changed,0,`${kind}/${form}`);
      for (const [target,bytes] of before) assert.deepEqual(fs.readFileSync(target),bytes);
    }
  }
});

let currentNative;
function signedNative() {
  if (!currentNative) currentNative = require("./fixtures/native-response-annotation.js").nativeAnnotationPlan(process.env.CODEX_SIGNED_EXTRACTED_APP);
  return currentNative;
}

test("current official ASAR exposes the published editor/card route and patches only the shortcut asset", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, t => {
  const native = signedNative(), { owners, editors, cards } = native.found;
  assert.equal(owners.length, 1);
  assert.equal(native.plan.editor.createMode, "saved");
  assert.equal(native.defaults.allowDirect, true);
  assert.equal(native.defaults.allowDirectOnEdit, false);
  assert.equal(shortcutContract(owners[0].source).state, "current");
  assert.equal(shortcutContract(patchSource(owners[0].source)).state, "applied");
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const copy = fs.mkdtempSync(path.join(cache, "annotation-submit-official-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  const sources = new Map([...owners, ...editors, ...cards].map(chunk => [chunk.name, chunk.source]));
  for (const [name, source] of sources) {
    const target = path.join(copy, "webview/assets", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  const applied = applyAnnotationSubmit(copy, enabledContext);
  assert.equal(applied.changed, 1);
  assert.deepEqual(applied.targets, [path.join("webview", "assets", owners[0].name)]);
  for (const [name, source] of sources) {
    const actual = fs.readFileSync(path.join(copy, "webview/assets", name), "utf8");
    assert.equal(actual, name === owners[0].name ? patchSource(source) : source);
  }
  assert.equal(applyAnnotationSubmit(copy, enabledContext).changed, 0);
});

for (const mode of ["create", "edit"]) {
  test(`latest native default saved policy handles current ${mode} text through the editor`, {
    skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
  }, async () => {
    const native = signedNative(), state = eventFixture();
    const runtime = require("./fixtures/native-response-annotation.js").nativeAnnotationRuntime(native, state, {mode,draft:"  当前未保存文字  "});
    runtime.dispatch();
    await new Promise(setImmediate);
    assert.deepEqual(runtime.saved, ["当前未保存文字"]);
    assert.deepEqual(runtime.direct, []);
    assert.equal(runtime.textReads, 1);
    assert.equal(state.event.prevented, 1);
    assert.equal(state.event.stopped, 1);
    assert.equal(runtime.validations[0].submitMode, "saved");
  });
}

test("latest native direct policy stays available when the native editor selects it", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const native = signedNative();
  for (const mode of ["create", "edit"]) {
    const state = eventFixture();
    const runtime = require("./fixtures/native-response-annotation.js").nativeAnnotationRuntime(native, state, {
      mode,createMode:"direct",allowDirectOnEdit:true,draft:"  直接路径文字  ",
    });
    runtime.dispatch();
    await new Promise(setImmediate);
    assert.deepEqual(runtime.direct, ["直接路径文字"]);
    assert.deepEqual(runtime.saved, []);
    assert.equal(runtime.textReads, 1);
  }
});

test("latest native IME/repeat and submit validation guard the yielded event", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, async () => {
  const native = signedNative();
  for (const [event,settings] of [[{nativeEvent:{isComposing:true}},{}],[{repeat:true},{}],[{},{canSubmit:false}],[{},{busy:true}],[{},{createMode:"direct",draft:"   "}]]) {
    const state = eventFixture(event);
    const runtime = require("./fixtures/native-response-annotation.js").nativeAnnotationRuntime(native, state, settings);
    runtime.dispatch();
    await new Promise(setImmediate);
    assert.deepEqual(runtime.direct, []);
    assert.deepEqual(runtime.saved, []);
  }
  const state = eventFixture();
  const empty = require("./fixtures/native-response-annotation.js").nativeAnnotationRuntime(native, state, {draft:"   "});
  empty.dispatch();
  await new Promise(setImmediate);
  assert.deepEqual(empty.saved, [""]);
  assert.equal(empty.validations[0].allowEmptySubmit, true);
});
