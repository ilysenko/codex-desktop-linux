"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
require("./selected-text-more-details-trace.test.js");
const { BINDINGS_EXPORT, OPEN_EXPORT, AVAILABLE_EXPORT, RUNTIME_MARKER, OVERLAY_MARKER, REGISTRY_KEY, enabled,
  restoreUpstream, runtimeSource, patchSources, applySelectedTextMoreDetails, descriptors } =
  require("./patches/selected-text-more-details.js");

// Synthetic rspack chunks with the current official module shapes: the Quick
// Chat owner, the ChatGPT sender, its native follow-up submitter, and the
// selected-text overlay whose toolbar module owns the More details action.
const quickModule = 'quick(e,t,n){n.d(t,{G2:()=>V,ZE:()=>Q});var a=n("cap"),s=n("hosts"),I=n("accounts"),' +
  'y=n("ids"),r=n("store");async function P(e,{sourceThread:{threadId:t,hostId:n}}){let u=e.get(I.p);' +
  'if(null==u)return null;let d=()=>{if(e.get(I.p)!==u)throw new DOMException("Context window or account changed",' +
  '"AbortError")};return d(),null}async function D(e,{sourceThread:t}){let i=await P(e,{sourceThread:t});' +
  'return null==i?["Codex conversation context"]:[`Reply to the user query using the following additional context ' +
  'from their Codex conversation:\n\n${i}`]}var L=n("dock"),M=n("telemetry");let F=(0,r.vP)(!1),' +
  'q=(0,r.m3)("has-opened-quick-chat-v1",!1),$=(0,r.vP)(null),Y=(0,r.vP)(null);function V(e,{projectId:t=null,' +
  'projectName:n=null,preservePreviousSession:r=!1,...i}={}){var o;let l;if(!e.get(a.G,{name:"chatgpt.quick-chat"}).isCapable)' +
  'return;(function(e,{conversationId:t=(0,y.co)(),contextSourceThread:n=null,projectId:r=null,projectName:i=null,' +
  'preservePreviousSession:a=!1}={}){(0,L.Nk)(e,0);let s=e.get($);a||s?.conversationId===t||es(e,s),e.set($,' +
  '{contextSourceThread:n,conversationId:t,hasConversation:!1,projectId:r,projectName:i,title:null}),e.set(Y,null)})' +
  '(e,{contextSourceThread:(o=e,null==(l=o.get(a.current))?null:{threadId:l,hostId:o.get(s.qX,l)}),projectId:t,' +
  'projectName:n,preservePreviousSession:r}),ea(e,!1),(0,M.yR)(e,{action:M.Zs.CODEX_QUICK_CHAT_LIFECYCLE_ACTION_OPENED,' +
  '...i})}function Q(e,t){return D(e,{isBackgroundSubagentsEnabled:!0,sourceThread:t})}function ea(e,t){let n=!e.get(q);' +
  'e.set(q,!0),e.set(F,!0)}function es(e,t){null!=t&&e.set(Y,null)}}';
const senderModule = 'sender(e,t,n){n.d(t,{submitChatGPTCompletion:()=>tr});var p=n("lockdown"),eo=n("service");' +
  'async function tr(e,{requestInput:t,isRequestCurrent:h,extraDeveloperInstructions:w=[],messageMetadata:j,' +
  'requireResponseAcceptance:eI,toolApproval:ea,conversationId:g,...rest}){let eb=null!=ea;if(!eb&&e.get(p.Nk))throw new ' +
  'Error("Lockdown");if(null!=ea)throw Error("Lockdown mode blocks connector approvals");return ts(e,{conversationId:g,' +
  'requireResponseAcceptance:eI,isRequestCurrent:h,extraDeveloperInstructions:w,messageMetadata:j,...rest})}' +
  'function ts(e,t){let c=t.gizmoEditor??e.get(tn,t.conversationId),i={cacheStatus:"missing",clientPrepareState:"none",' +
  'inFlightPrepared:null};return(async()=>{t.first&&c.onModelMessage(t.first);t.recovered&&c.onModelMessage(t.recovered);' +
  'let l=await e.get(eo.e).startCompletionStream({assertRequestCurrent:()=>{},onPrepareRequestStart:()=>{},' +
  'onRequestStart:()=>{},onResponse:n=>{n.isEventStream&&t.requireResponseAcceptance&&c?.resolve(null)},onTiming:e=>{},' +
  'onStreamData:c.onStreamData,onComplete:()=>{},onTransportClose:()=>{},onError:e=>{},onRecoverableError:e=>{},' +
  'inFlightPrepared:i.inFlightPrepared,request:t});return l})()}let tn="overrides"}';
const followModule = 'follow(e,t,n){n.d(t,{submitChatGptFollowUp:()=>s});var r=n("composer"),i=n("status"),' +
  'a=n("sender");async function s(e,{conversationId:t,prompt:h}){let g=e.get(i.SL,t),_=e.get(i.F1,t),y=(0,i.QN)(_);' +
  'if(e.get(r.Mb,t)||e.get(i.PH,t)||y&&null==g)return!1;let v=e.get(r.ch,t);e.set(r.Mb,t,!0);try{return null!=await ' +
  '(0,a.submitChatGPTCompletion)(e,{conversationId:t,model:v.slug,prompt:h,thinkingEffort:v.thinkingEffort,' +
  'systemHints:[]})}finally{e.set(r.Mb,t,!1)}}}';
const runtimeStubModules = ["cap", "hosts", "accounts", "ids", "store", "dock", "telemetry", "lockdown", "service",
  "composer", "status"].map((id) => `${id}(e,t,n){t.stub=${JSON.stringify(id)}}`);

function chunk(id, modules) {
  return `export const __rspack_esm_id=${id};export const __rspack_esm_ids=[${id}];` +
    `export const __webpack_modules__={${modules.join(",")}};`;
}

function runtimeFixture(replace = (source) => source) {
  return chunk(1, [quickModule, senderModule, followModule, ...runtimeStubModules].map(replace));
}

const overlayModule = 'overlay(e,t,n){n.d(t,{O:()=>S});var i=n("jsx"),r=n("memo"),l=n("store"),p=n("scopes"),' +
  'm=n("toolbar"),u=n("zoom"),y=n("annotations");function w(e){let t,n,o,a,u,f=(0,r.c)(18),{actions:m,' +
  'canOpenSideChat:b,scopeToThread:w,targetSelector:I}=e,S=(0,l.gh)(p.PR);f[2]!==S?(n=(0,p.ah)(S),f[2]=S,f[3]=n):' +
  'n=f[3];let _=n;f[4]!==S?(o=(e,t,n)=>(0,y.vo)(S,e,t,n),f[4]=S,f[7]=o):o=f[7];let R=b?m.onOpenSideChat:void 0;' +
  'return f[8]!==w?(a=w?[]:void 0,f[8]=w,f[12]=a):a=f[12],f[13]!==o||f[14]!==R||f[15]!==a||f[16]!==I?(u=(0,i.jsx)(x,' +
  '{onAddResponseTextAnnotation:o,onOpenSideChat:R,targetContainerRefs:a,targetSelector:I}),f[13]=o,f[14]=R,f[15]=a,' +
  'f[16]=I,f[17]=u):u=f[17],u}function x(e){let t,n,o=(0,r.c)(8),{onAddResponseTextAnnotation:a,onOpenSideChat:l,' +
  'targetContainerRefs:s,targetSelector:c}=e,d=(0,u.dz)();return null==a&&null==l?null:(o[0]!==a||o[1]!==l||' +
  'o[2]!==d?(t=(e,t)=>{let{portalTarget:n,rect:r,selectedText:o,selectionRange:s,target:c}=e,u=(0,y.eM)(c,s,o);' +
  'return(0,i.jsx)("div",{className:"contents",children:(0,i.jsx)(m.q,{selectedText:o,onAddSelectedText:null==u||' +
  'null==a?void 0:()=>{a(u,{x:r.right/d,y:r.top/d},t())},onOpenSideChat:l})})},o[0]=a,o[1]=l,o[2]=d,o[3]=t):' +
  't=o[3],o[4]!==t||o[5]!==s||o[6]!==c?(n=(0,i.jsx)("surface",{targetContainerRefs:s,targetSelector:c,children:t}),' +
  'o[4]=t,o[5]=s,o[6]=c,o[7]=n):n=o[7],n)}function S(e){return(0,i.jsx)(w,e)}t.parent=w,t.leaf=x}';
const toolbarModule = 'toolbar(e,t,n){n.d(t,{q:()=>u});var a=n("intl");function u(e){let{onMoreDetails:C,' +
  'onOpenSideChat:x,selectedText:S}=e,k=(0,a.A)();return null!=C?k.formatMessage({id:"selectedTextOverlay.moreDetails",' +
  'defaultMessage:"More details"}):null}}';
const overlayStubModules = ["jsx", "memo", "scopes", "zoom", "annotations", "intl"]
  .map((id) => `${id}(e,t,n){t.stub=${JSON.stringify(id)}}`);

function overlayFixture(replace = (source) => source) {
  return chunk(2, [overlayModule, toolbarModule, ...overlayStubModules].map(replace));
}

const enabledContext = { feature: { settings: { tweaks: { selection: { moreDetails: { enabled: true } } } } } };

function appFixture(t, runtime = runtimeFixture(), overlay = overlayFixture()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selected-text-more-details-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(path.join(assets, "async"), { recursive: true });
  fs.writeFileSync(path.join(assets, "100.entry.js"), "export const entry=1;");
  const runtimeFile = path.join(assets, "async", "1.aaaa.js");
  const overlayFile = path.join(assets, "async", "2.bbbb.js");
  fs.writeFileSync(runtimeFile, runtime);
  fs.writeFileSync(overlayFile, overlay);
  return { root, assets, runtime: runtimeFile, overlay: overlayFile };
}

function read(app) {
  return [app.runtime, app.overlay].map((file) => fs.readFileSync(file, "utf8"));
}

function warnings(callback) {
  const captured = [];
  const original = console.warn;
  console.warn = (message) => captured.push(message);
  try { return { result: callback(), warnings: captured }; }
  finally { console.warn = original; }
}

test("More details is opt-in and a disabled override preserves both original assets", (t) => {
  const app = appFixture(t);
  assert.equal(enabled(), false);
  assert.equal(descriptors[0].enabled(enabledContext), true);
  assert.equal(enabled({ feature: { manifest: { tweaks: { selection: { moreDetails: { enabled: true } } } },
    settings: { tweaks: { selection: { moreDetails: { enabled: false } } } } } }), false);
  assert.equal(applySelectedTextMoreDetails(app.root).changed, 0);
  assert.deepEqual(read(app), [runtimeFixture(), overlayFixture()]);
});

test("More details patches both rspack chunks once, restorably, and detects complete reapplication", (t) => {
  const app = appFixture(t);
  assert.equal(applySelectedTextMoreDetails(app.root, enabledContext).changed, 2);
  const [runtime, overlay] = read(app);
  assert.match(runtime, new RegExp(RUNTIME_MARKER));
  assert.match(overlay, new RegExp(OVERLAY_MARKER));
  assert.match(overlay, /selectedTextOverlay\.quickChatPrompt/);
  assert.equal(restoreUpstream(runtime), runtimeFixture());
  assert.equal(restoreUpstream(overlay), overlayFixture());
  // Cross-module access goes through each owner's own require parameter.
  assert.match(runtime, /var codexLinuxSelectedTextQuickChatRequire=n;/);
  assert.match(runtime, /send:codexLinuxSelectedTextQuickChatRequire\("sender"\)\.submitChatGPTCompletion/);
  assert.match(runtime, /model:codexLinuxSelectedTextQuickChatRequire\("composer"\)\.ch/);
  assert.match(runtime, /status:codexLinuxSelectedTextQuickChatRequire\("status"\)\.F1/);
  assert.match(runtime, /blocked:codexLinuxSelectedTextQuickChatRequire\("lockdown"\)\.Nk/);
  assert.match(overlay, /var codexLinuxSelectedTextOverlayIntl=n\("intl"\);/);
  const again = warnings(() => applySelectedTextMoreDetails(app.root, enabledContext));
  assert.deepEqual(again.warnings, []);
  assert.equal(again.result.matched, 2);
  assert.equal(again.result.changed, 0);
  assert.deepEqual(read(app), [runtime, overlay]);
  assert.equal(descriptors[0].status(again.result, []), "already-applied");
});

test("More details discovers renamed minified symbols and module ids", () => {
  const rename = (source) => source
    .replace(/\b(V|Q|D|P|ea|es|tr|ts|w|x|u)\(/gu, "$1_renamed(")
    .replace(/([(,{])(V|Q|ea|tr|w|x|u)([,)}])/gu, "$1$2_renamed$3")
    .replace(/=>(V|Q|tr|u)\b/gu, "=>$1_renamed")
    .replace(/"(composer|status|sender|lockdown|intl|toolbar)"/gu, '"$1Renamed"')
    .replace(/\b(composer|status|sender|lockdown|intl|toolbar)\(e,t,n\)/gu, "$1Renamed(e,t,n)");
  const result = patchSources({ "1.js": rename(runtimeFixture()), "2.js": rename(overlayFixture()) });
  assert.equal(result.applied, false);
  assert.match(result.chunks["1.js"], /send:codexLinuxSelectedTextQuickChatRequire\("senderRenamed"\)/);
  assert.match(result.chunks["1.js"], /context:Q_renamed, /);
  assert.match(result.chunks["1.js"], /show:ea_renamed,/);
  assert.match(result.chunks["2.js"], /n\("intlRenamed"\)/);
});

test("runtime and overlay may share one chunk", () => {
  const combined = chunk(3, [quickModule, senderModule, followModule, ...runtimeStubModules, overlayModule,
    toolbarModule, ...overlayStubModules]);
  const result = patchSources({ "3.js": combined });
  const patched = result.chunks["3.js"];
  assert.match(patched, new RegExp(RUNTIME_MARKER));
  assert.match(patched, new RegExp(OVERLAY_MARKER));
  assert.equal(restoreUpstream(patched), combined);
  const again = patchSources({ "3.js": patched });
  assert.equal(again.applied, true);
  assert.equal(again.chunks["3.js"], patched);
});

test("missing, ambiguous, mixed, and drifted contracts leave every asset unchanged", (t) => {
  const runtimeVariants = [
    (source) => source.replace("gizmoEditor??", "gizmoEditorChanged??"),
    (source) => source.replace(/requireResponseAcceptance/gu, "responseAcceptanceChanged"),
    (source) => source.replace("e.set(r.Mb,t,!0)", "e.set(r.Mb,t,drifted)"),
    (source) => source.replace("Lockdown mode blocks connector approvals", "Lockdown changed"),
    (source) => source.replace("has-opened-quick-chat-v1", "has-opened-quick-chat-v2"),
    (source) => source.replace("CODEX_QUICK_CHAT_LIFECYCLE_ACTION_OPENED", "CODEX_QUICK_CHAT_LIFECYCLE_ACTION_SHOWN"),
    // The copied session constructor must not use the factory's own locals.
    (source) => source.replace("(0,L.Nk)(e,0)", "(0,L.Nk)(e,l)"),
    // Native modules must be registered with the Quick Chat runtime chunk.
    (source) => source.replace("composer(e,t,n){", "composerElsewhere(e,t,n){"),
    // The require parameter must remain visible to the appended runtime.
    (source) => source.replace("function es(e,t){", "function n(){}function es(e,t){"),
    (source) => source.replace("submitChatGPTCompletion:()=>tr", "submitChatGPTCompletion:()=>ts"),
    (source) => source.replace("export const __webpack_modules__={", "export const __webpack_modules__=({"),
  ];
  const overlayVariants = [
    (source) => source.replace("onAddResponseTextAnnotation:o", "onAddResponseTextAnnotationChanged:o"),
    (source) => source.replace("f=(0,r.c)(18)", "f=(0,r.c)(22)"),
    (source) => source.replace("o=(0,r.c)(8)", "o=(0,r.c)(9)"),
    (source) => source.replace('id:"selectedTextOverlay.moreDetails"', 'id:"selectedTextOverlay.moreDetailsChanged"'),
    (source) => source.replace("{onMoreDetails:C,", "{"),
    (source) => source.replace("(0,a.A)()", "a.A"),
    (source) => source.replace("toolbar(e,t,n){", "toolbarElsewhere(e,t,n){"),
    (source) => source.replace("return null==a&&null==l?null:", "return null==a?null:"),
  ];
  const cases = [
    ...runtimeVariants.map((modify) => [modify(runtimeFixture()), overlayFixture()]),
    ...overlayVariants.map((modify) => [runtimeFixture(), modify(overlayFixture())]),
    [runtimeFixture(), overlayFixture() + "/*codex-linux-selected-text-more-details:+*/"],
    [runtimeFixture().replace("submitChatGptFollowUp", "codexLinuxQuickChatFollowUp"), overlayFixture()],
  ];
  for (const [index, [runtime, overlay]] of cases.entries()) {
    const app = appFixture(t, runtime, overlay);
    const result = warnings(() => applySelectedTextMoreDetails(app.root, enabledContext));
    assert.equal(result.result.changed, 0, `drift variant ${index}`);
    assert.equal(result.result.matched, 0, `drift variant ${index}`);
    assert.equal(result.warnings.length, 1, `drift variant ${index}`);
    assert.deepEqual(read(app), [runtime, overlay], `drift variant ${index}`);
  }
  const different = appFixture(t);
  const otherModule = path.join(different.assets, "async", "3.cccc.js");
  fs.writeFileSync(otherModule, overlayFixture((source) => source.replace(/^overlay\(/u, "otherOverlay(")));
  const result = warnings(() => applySelectedTextMoreDetails(different.root, enabledContext));
  assert.match(result.warnings[0], /Selected-text overlay copies are different modules/);
  assert.deepEqual(read(different), [runtimeFixture(), overlayFixture()]);
  assert.equal(fs.readFileSync(otherModule, "utf8"),
    overlayFixture((source) => source.replace(/^overlay\(/u, "otherOverlay(")));
});

test("independently minified overlay copies in several chunks are all patched", (t) => {
  // rspack duplicates the overlay into lazy chunks; the toolbar lives only in
  // a chunk that the patch reads but does not change.
  const renamed = (source) => source.replace(/\b(w|x)\b(?=[({,])/gu, "$1Copy");
  const withoutToolbar = (source) => source.replace(toolbarModule + ",", "");
  const app = appFixture(t, runtimeFixture(), withoutToolbar(overlayFixture()));
  const copy = path.join(app.assets, "async", "3.cccc.js");
  const toolbar = path.join(app.assets, "async", "4.dddd.js");
  fs.writeFileSync(copy, withoutToolbar(overlayFixture(renamed)));
  fs.writeFileSync(toolbar, chunk(4, [toolbarModule]));
  const result = warnings(() => applySelectedTextMoreDetails(app.root, enabledContext));
  assert.deepEqual(result.warnings, []);
  assert.equal(result.result.changed, 3);
  assert.equal(result.result.matched, 3);
  const patchedCopy = fs.readFileSync(copy, "utf8");
  assert.match(patchedCopy, new RegExp(OVERLAY_MARKER));
  assert.equal(restoreUpstream(patchedCopy), withoutToolbar(overlayFixture(renamed)));
  assert.equal(fs.readFileSync(toolbar, "utf8"), chunk(4, [toolbarModule]));
  assert.equal(applySelectedTextMoreDetails(app.root, enabledContext).changed, 0);
});

test("already-patched validation rejects every incomplete or edited insertion byte-identically", (t) => {
  const corruptions = [
    ["overlay", "f[19]=_,", "f[19]=broken,"],
    ["overlay", "f[23]!==codexLinuxMoreDetails", "f[23]!==broken"],
    ["overlay", "{/*codex-linux-selected-text-more-details:+*/onMoreDetails:codexLinuxMoreDetails,",
      "{/*codex-linux-selected-text-more-details:+*/"],
    ["overlay", "&&null==codexLinuxMoreDetails", "&&null==broken"],
    ["overlay", "o[8]=codexLinuxMoreDetails,", ""],
    ["overlay", "~18*/24", "~18*/25"],
    ["overlay", 'n("intl")', 'n("other")'],
    ["runtime", 'codexLinuxSelectedTextQuickChatRequire("composer").ch', 'codexLinuxSelectedTextQuickChatRequire("composer").other'],
    ["runtime", '"stream-data",', '"stream-data-changed",'],
    ["runtime", "/*codex-linux-selected-text-more-details:-*/", ""],
  ];
  for (const [file, before, after] of corruptions) {
    const app = appFixture(t);
    assert.equal(applySelectedTextMoreDetails(app.root, enabledContext).changed, 2);
    const target = app[file];
    const patched = fs.readFileSync(target, "utf8");
    assert.ok(patched.includes(before), `${before} fixture contract`);
    fs.writeFileSync(target, patched.replace(before, after));
    const corrupted = read(app);
    const result = warnings(() => applySelectedTextMoreDetails(app.root, enabledContext));
    assert.equal(result.result.changed, 0, before);
    assert.equal(result.result.matched, 0, before);
    assert.equal(result.warnings.length, 1, before);
    assert.deepEqual(read(app), corrupted, before);
  }
});

test("already-patched validation rejects invalid full-module JavaScript byte-identically", (t) => {
  const app = appFixture(t);
  assert.equal(applySelectedTextMoreDetails(app.root, enabledContext).changed, 2);
  fs.appendFileSync(app.overlay, "const codexLinuxInvalidSyntax=;");
  const before = read(app);
  const result = warnings(() => applySelectedTextMoreDetails(app.root, enabledContext));
  assert.equal(result.result.changed, 0);
  assert.equal(result.result.matched, 0);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(read(app), before);
});

// Evaluates rspack chunks with a minimal module runtime: n(id) evaluates a
// registered factory once, and n.d(exports,getters) defines live exports.
function rspackRuntime(chunks, externals) {
  const quiet = { info() {}, warn: console.warn, error: console.error };
  const context = vm.createContext({ console: quiet, Promise, Symbol, WeakMap, Map, Set, JSON, DOMException, Error });
  const factories = {};
  for (const source of chunks) {
    Object.assign(factories, vm.runInContext(`(()=>{${source.replace(/export const /gu, "const ")};` +
      "return __webpack_modules__})()", context));
  }
  const cache = new Map();
  const require = (id) => {
    if (cache.has(id)) return cache.get(id);
    const exports = externals[id] ?? {};
    cache.set(id, exports);
    if (externals[id] == null) {
      if (factories[id] == null) throw new Error(`Module ${id} is not registered`);
      factories[id].call(exports, { exports }, exports, require);
    }
    return exports;
  };
  require.d = (exports, getters) => {
    for (const [key, get] of Object.entries(getters)) Object.defineProperty(exports, key, { enumerable: true, get });
  };
  return { context, require,
    registry: () => vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(REGISTRY_KEY)})]`, context) };
}

test("patched chunks connect the overlay to Quick Chat and send the selected text natively", async () => {
  const result = patchSources({ runtime: runtimeFixture(), overlay: overlayFixture() });
  const requests = [];
  const memo = new Map();
  let activeSource = "source-a";
  const state = new Map(Object.entries({ cap: { isCapable: true, isLoading: false }, account: {}, blocked: false,
    host: "remote-host", status: "idle", submitting: false, stopping: false,
    model: { slug: "chosen-model", thinkingEffort: "extended" }, overrides: { onStreamData() {}, onModelMessage() {} },
    service: { async startCompletionStream(options) {
      requests.push(options.request);
      options.onRequestStart();
      return {};
    } } }));
  const scope = { get: (atom) => state.get(atom), set: (atom, ...args) => state.set(atom, args.at(-1)),
    when: async () => {} };
  let activeScope = scope;
  const language = { formatMessage: ({ id }) => id.endsWith("quickChatPrompt") ? "告诉我更多相关信息" : "所选文字" };
  const externals = {
    cap: { G: "cap", current: "current" }, hosts: { qX: "host" }, accounts: { p: "account" }, ids: { co: () => "new-chat" },
    store: { vP: () => ({}), m3: (key) => key, gh: () => activeScope }, dock: { Nk() {} }, telemetry: { yR() {}, Zs: {} },
    lockdown: { Nk: "blocked" }, service: { e: "service" }, composer: { Mb: "submitting", ch: "model" },
    status: { F1: "status", PH: "stopping", SL: "steering", QN: () => false },
    jsx: { jsx: (component, props) => ({ component, props }) }, memo: { c: (size) => {
      if (!memo.has(size)) memo.set(size, []);
      return memo.get(size);
    } }, scopes: { PR: "root", ah: () => activeSource }, zoom: { dz: () => 1 },
    annotations: { vo() {}, eM: () => ({ text: "annotation" }) }, intl: { A: () => language },
  };
  const runtime = rspackRuntime([result.chunks.runtime, result.chunks.overlay], externals);
  const overlay = runtime.require("overlay");
  const render = () => {
    const wired = overlay.parent({ actions: { onOpenSideChat() {} }, canOpenSideChat: true, scopeToThread: true,
      targetSelector: "target" }).props;
    return overlay.leaf(wired).props.children({ rect: { right: 2, top: 3 }, selectedText: "selection",
      target: { innerText: "entire source reply" }, selectionRange: {} }, () => "placement").props.children.props;
  };

  // Until the Quick Chat module evaluates, the toolbar keeps its upstream
  // actions and omits More details.
  assert.equal(runtime.registry(), undefined);
  assert.equal(render().onMoreDetails, undefined);
  assert.equal(typeof render().onAddSelectedText, "function");

  runtime.require("quick");
  assert.equal(typeof runtime.registry().open, "function");
  const actions = render();
  assert.equal(typeof actions.onMoreDetails, "function");
  actions.onMoreDetails("selection");
  for (let index = 0; index < 50 && requests.length === 0; index += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].conversationId, "new-chat");
  assert.equal(requests[0].model, "chosen-model");
  assert.equal(requests[0].thinkingEffort, "extended");
  assert.equal(requests[0].prompt, "告诉我更多相关信息");
  assert.equal(requests[0].messageMetadata.targeted_reply, "selection");
  assert.equal(requests[0].messageMetadata.targeted_reply_label, "所选文字");
  assert.match(requests[0].extraDeveloperInstructions.at(-1), /entire source reply/);
  for (let index = 0; index < 50 && runtime.registry() != null && state.get("submitting") !== false; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  for (const [atom, value] of [["cap", { isCapable: false }], ["cap", { isCapable: true, isLoading: true }],
    ["blocked", true], ["account", null]]) {
    const previous = state.get(atom);
    state.set(atom, value);
    assert.equal(render().onMoreDetails, undefined, atom);
    state.set(atom, previous);
  }
  // A scope without a source conversation recomputes the cached action.
  activeScope = { ...scope };
  activeSource = null;
  assert.equal(render().onMoreDetails, undefined);
});

function runtimeHarness(options = {}) {
  const calls = [];
  const state = new Map([["account", {}], ["cap", { isCapable: true }], ["blocked", false], ["host", "remote-host"], ["status", "idle"],
    ["submitting", false], ["stopping", false],
    ["model", { slug: "chosen-chatgpt-model", thinkingEffort: "extended" }]]);
  const waiters = [];
  const scope = { get: (atom) => state.get(atom), set(atom, ...args) {
    state.set(atom, args.at(-1));
    for (const waiter of [...waiters]) if (waiter.dependencies.has(atom)) waiter.evaluate();
  }, when: (condition) => new Promise((resolve) => {
    const waiter = { dependencies: new Set(), evaluate() {
      const get = (atom) => { waiter.dependencies.add(atom); return state.get(atom); };
      if (condition({ get })) resolve();
    } };
    waiters.push(waiter);
    waiter.evaluate();
  }) };
  let sequence = 0;
  const bindings = { capability: "cap", blocked: "blocked", account: "account", session: "session", host: "host",
    create: "create", show: "show", context: "context", send: "send", model: "model", status: "status", busy: "busy",
    submitting: "submitting", stopping: "stopping" };
  const runtimeGlobals = { setTimeout, clearTimeout, console,
    ...Object.fromEntries(["cap", "blocked", "account", "session", "host", "model", "status", "submitting", "stopping"].map((key) => [key, key])),
    busy: (status) => ["streaming", "active-async-turn", "active-tpp-turn"].includes(status),
    create(value, input) { const id = input.conversationId ?? `new-chat-${++sequence}`;
      value.set("session", { conversationId: id, contextSourceThread: input.contextSourceThread, hasConversation: false }); return id; },
    show() { calls.push({ type: "show" }); },
    async context(value, sourceThread) { calls.push({ type: "context", sourceThread });
      return options.context ? options.context(value, sourceThread) : ["Codex conversation context"]; },
    async send(value, input) { calls.push({ type: "send", input }); if (options.send) await options.send(value, input); } };
  const sandbox = vm.createContext(runtimeGlobals);
  vm.runInContext(runtimeSource(bindings), sandbox);
  const input = { sourceConversationId: "source-a", selectedText: "chosen text", selectedMessageText: "entire reply containing chosen text",
    prompt: "localized question", targetedReplyLabel: "localized selected text" };
  return { calls, state, scope, input, sandbox, open: (override = {}) => sandbox[OPEN_EXPORT](scope, { ...input, ...override }),
    openInScope: (value, override = {}) => sandbox[OPEN_EXPORT](value, { ...input, ...override }),
    bindings: () => sandbox[BINDINGS_EXPORT]() };
}

test("generated runtime publishes its availability, open action, and trace registry", () => {
  const fixture = runtimeHarness();
  const registry = vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(REGISTRY_KEY)})]`, fixture.sandbox);
  assert.equal(registry.open, fixture.sandbox[OPEN_EXPORT]);
  assert.equal(registry.available, fixture.sandbox[AVAILABLE_EXPORT]);
  assert.equal(typeof registry.traceFor, "function");
  const logs = [];
  const logger = { info: (message, fields) => logs.push(fields.safe) };
  assert.equal(registry.available(fixture.scope, "source-a", logger), true);
  assert.equal(registry.available(fixture.scope, null, logger), false);
  fixture.state.set("cap", { isCapable: true, isLoading: true });
  assert.equal(registry.available(fixture.scope, "source-a", logger), false);
  assert.deepEqual(logs.map((state) => [state.sourceConversationId, state.loading]), [[true, false], [false, false], [true, true]]);
  assert.equal(fixture.bindings().send, fixture.sandbox.send);
});

test("Quick Chat sends the selected text, reply, Codex context, localized labels, and selected ChatGPT model", async () => {
  const fixture = runtimeHarness();
  await fixture.open();
  const send = fixture.calls.find((call) => call.type === "send").input;
  assert.equal(send.model, "chosen-chatgpt-model");
  assert.equal(send.thinkingEffort, "extended");
  assert.equal(send.prompt, "localized question");
  assert.equal(send.requireResponseAcceptance, true);
  assert.equal(send.isRequestCurrent(), true);
  assert.equal(send.messageMetadata.targeted_reply, "chosen text");
  assert.equal(send.messageMetadata.targeted_reply_label, "localized selected text");
  assert.equal(send.messageMetadata.is_visually_hidden_from_conversation, true);
  assert.equal(send.extraDeveloperInstructions[0], "Codex conversation context");
  assert.match(send.extraDeveloperInstructions[1], /entire reply containing chosen text/);
  assert.equal(fixture.calls[0].sourceThread.hostId, "remote-host");
  assert.equal(fixture.state.get("session").hasConversation, true);
});

test("a queued request is not marked as a conversation until the native sender receives a server response", async () => {
  let accept;
  const phases = [];
  const fixture = runtimeHarness({ send: async (scope, input) => {
    assert.equal(scope.get("submitting"), true);
    if (!input.requireResponseAcceptance) return;
    await new Promise((resolve) => { accept = resolve; });
  } });
  const pending = fixture.open({ logger: { info(message, fields) { phases.push(fields.safe); } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.state.get("session").hasConversation, false);
  assert.equal(fixture.state.get("submitting"), true);
  assert.equal(phases.at(-1).phase, "waiting-for-response");
  assert.equal(phases.some((state) => state.phase === "response-accepted"), false);
  accept();
  await pending;
  assert.equal(fixture.state.get("session").hasConversation, true);
  assert.equal(fixture.state.get("submitting"), false);
  assert.equal(phases.at(-1).phase, "response-accepted");
  assert.ok(phases.every((state) => Number.isFinite(state.elapsedMs) && state.elapsedMs >= 0));
});

test("a failure after local queuing rejects the action and permits a subsequent explicit selection", async () => {
  let reject;
  let attempts = 0;
  const fixture = runtimeHarness({ send: async (scope, input) => {
    if (++attempts === 1 && input.requireResponseAcceptance) {
      await new Promise((resolve, fail) => { reject = fail; });
    }
  } });
  const pending = fixture.open();
  await new Promise((resolve) => setImmediate(resolve));
  const assertion = assert.rejects(pending, /response connection failed/);
  reject(new Error("response connection failed"));
  await assertion;
  assert.equal(fixture.state.get("session").hasConversation, false);
  assert.equal(fixture.state.get("submitting"), false);
  assert.equal(attempts, 1);
  await fixture.open();
  assert.equal(attempts, 2);
  assert.equal(fixture.state.get("session").hasConversation, true);
});

test("native request checks reject a changed account during server preparation", async () => {
  const fixture = runtimeHarness({ send: async (scope, input) => {
    assert.equal(input.isRequestCurrent(), true);
    scope.set("account", {});
    assert.equal(input.isRequestCurrent(), false);
    throw new Error("request identity changed");
  } });
  await assert.rejects(fixture.open(), /request identity changed/);
  assert.equal(fixture.state.get("session").hasConversation, false);
});

test("capability, submission guards, sign-out, empty selections, and account changes prevent submission", async () => {
  for (const [atom, value] of [["cap", { isCapable: false }], ["blocked", true], ["account", null]]) {
    const fixture = runtimeHarness();
    fixture.state.set(atom, value);
    await fixture.open();
    assert.equal(fixture.calls.length, 0);
  }
  const empty = runtimeHarness();
  await empty.open({ selectedText: "   " });
  assert.equal(empty.calls.length, 0);
  const switched = runtimeHarness({ context: async (scope) => { scope.set("account", {}); return ["old account context"]; } });
  await switched.open();
  assert.equal(switched.calls.some((call) => call.type === "send"), false);
  assert.equal(switched.state.has("session"), false);
});

test("loading capability keeps Quick Chat closed until account availability is ready", async () => {
  const fixture = runtimeHarness();
  fixture.state.set("cap", { isLoading: true, isCapable: false });
  await fixture.open();
  assert.equal(fixture.calls.length, 0);
  fixture.scope.set("cap", { isLoading: false, isCapable: true });
  await fixture.open();
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
});

test("rapid selections serialize, reuse their source conversation, and recover after a failed send", async () => {
  let attempts = 0;
  const fixture = runtimeHarness({ send: async () => { if (++attempts === 1) throw new Error("network failed"); } });
  const first = fixture.open();
  const second = fixture.open({ selectedText: "second selection" });
  await assert.rejects(first, /network failed/);
  await second;
  const sends = fixture.calls.filter((call) => call.type === "send");
  assert.equal(sends.length, 2);
  assert.equal(sends[0].input.conversationId, sends[1].input.conversationId);
  await fixture.open({ sourceConversationId: "source-b" });
  assert.notEqual(fixture.calls.filter((call) => call.type === "send")[2].input.conversationId, sends[0].input.conversationId);
});

test("More details waits for an existing ChatGPT response even after dispatch has returned", async () => {
  const fixture = runtimeHarness({ send: async (scope) => scope.set("status", "streaming") });
  await fixture.open();
  const next = fixture.open({ selectedText: "second selection" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
  fixture.scope.set("status", "idle");
  await next;
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 2);
});

test("different ComposerScopes sharing a native session serialize selections through response acceptance", async () => {
  let accept;
  let attempts = 0;
  const fixture = runtimeHarness({ send: async () => {
    if (++attempts === 1) await new Promise((resolve) => { accept = resolve; });
  } });
  const first = fixture.open();
  await new Promise((resolve) => setImmediate(resolve));
  const firstId = fixture.state.get("session").conversationId;
  const second = fixture.openInScope({ ...fixture.scope }, { sourceConversationId: "source-b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(fixture.state.get("session").conversationId, firstId);
  assert.equal(fixture.state.get("session").hasConversation, false);
  accept();
  await Promise.all([first, second]);
  assert.equal(attempts, 2);
  assert.notEqual(fixture.state.get("session").conversationId, firstId);
});

test("native composer preparation and stopping locks block selections before replacing or sending a session", async () => {
  for (const atom of ["submitting", "stopping"]) {
    for (const sameSource of [true, false]) {
      const fixture = runtimeHarness();
      await fixture.open();
      const id = fixture.state.get("session").conversationId;
      fixture.scope.set(atom, id, true);
      const pending = fixture.open({ sourceConversationId: sameSource ? "source-a" : "source-b" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
      assert.equal(fixture.state.get("session").conversationId, id);
      fixture.scope.set(atom, id, false);
      await pending;
      assert.equal(fixture.calls.filter((call) => call.type === "send").length, 2);
    }
  }
});

test("switching sources waits for an active reply before constructing the next native session", async () => {
  const fixture = runtimeHarness();
  await fixture.open();
  const id = fixture.state.get("session").conversationId;
  fixture.scope.set("status", "streaming");
  const pending = fixture.openInScope({ ...fixture.scope }, { sourceConversationId: "source-b" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.state.get("session").conversationId, id);
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
  fixture.scope.set("status", "idle");
  await pending;
  assert.notEqual(fixture.state.get("session").conversationId, id);
});

test("changing accounts while awaiting the native preparation lock cancels without releasing another sender's lock", async () => {
  const fixture = runtimeHarness();
  await fixture.open();
  fixture.scope.set("submitting", true);
  const pending = fixture.open();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.scope.set("account", {});
  await pending;
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
  assert.equal(fixture.state.get("submitting"), true);
});

test("account changes while waiting for an existing response cancel the queued selection", async () => {
  const fixture = runtimeHarness({ send: async (scope) => scope.set("status", "active-async-turn") });
  await fixture.open();
  const next = fixture.open();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.scope.set("account", {});
  await next;
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
});

test("long source replies remain bounded while preserving the selected passage in context", async () => {
  const fixture = runtimeHarness();
  await fixture.open({ selectedMessageText: "a".repeat(50000) + "chosen text" + "b".repeat(50000) });
  const instructions = fixture.calls.find((call) => call.type === "send").input.extraDeveloperInstructions[1];
  assert.ok(instructions.length < 41000);
  assert.match(instructions, /chosen text/);
  assert.match(instructions, /selected text shown above/);
});

test("More details matches the complete signed official bundle", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, (t) => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "selected-text-official-test-"));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  fs.cpSync(path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, "webview"), path.join(copy, "webview"), { recursive: true });
  const result = warnings(() => applySelectedTextMoreDetails(copy, enabledContext));
  assert.deepEqual(result.warnings, []);
  // The Quick Chat runtime chunk plus every chunk that carries a copy of the
  // selected-text overlay module.
  assert.ok(result.result.matched >= 2);
  assert.equal(result.result.changed, result.result.matched);
  const again = warnings(() => applySelectedTextMoreDetails(copy, enabledContext));
  assert.deepEqual(again.warnings, []);
  assert.equal(again.result.changed, 0);
  for (const target of result.result.targets) {
    const patched = fs.readFileSync(path.join(copy, target), "utf8");
    const original = fs.readFileSync(path.join(process.env.CODEX_SIGNED_EXTRACTED_APP, target), "utf8");
    assert.equal(restoreUpstream(patched), original);
  }
});
