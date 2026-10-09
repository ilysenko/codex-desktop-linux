"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
require("./selected-text-more-details-trace.test.js");
const { BINDINGS_EXPORT, OPEN_EXPORT, DIAGNOSTICS_EXPORT, RUNTIME_MARKER, OVERLAY_MARKER, enabled,
  runtimeSource, patchSources, applySelectedTextMoreDetails, descriptors } = require("./patches/selected-text-more-details.js");

function initialFixture() {
  return [
    'function qInit(){return(qInit=e((()=>{session=atom(),stored(`has-opened-quick-chat-v1`)})))()}',
    'function qFactory(a,{projectId:p=null,projectName:n=null,preservePreviousSession:r=!1,...o}={}){if(!a.get(cap,{name:`chatgpt.quick-chat`}).isCapable)return;let b=a.get(session)!=null;qCreate(a,{contextSourceThread:qSource(a),projectId:p,projectName:n,preservePreviousSession:r}),reset(a),qShow(a,!1),analytics(a,{action:events.CODEX_QUICK_CHAT_LIFECYCLE_ACTION_OPENED})}',
    'function qCreate(a,{conversationId:c=newId(),contextSourceThread:s=null}={}){a.set(session,{contextSourceThread:s,conversationId:c,hasConversation:!1});return c}',
    'function qSource(a){let t=thread();return{threadId:t,hostId:a.get(host,t)}}',
    'function qShow(a,b){a.set(visible,!0)}',
    'async function sourceContext(a,b){return [`Reply to the user query using the following additional context from their Codex conversation:`]}',
    'function qContext(a,b){return sourceContext(a,{isBackgroundSubagentsEnabled:!0,sourceThread:b})}',
    'async function accountContext(a){let b=a.get(account);if(b==null)return null;throw new DOMException(`Context window or account changed`,`AbortError`)}',
    'async function send(a,{requestInput:r,extraDeveloperInstructions:c=[],messageMetadata:m,prompt:p,requireResponseAcceptance:q,isRequestCurrent:v}){let tool=!1;if(!tool&&a.get(lock))throw new Locked;return `Lockdown mode blocks connector approvals`}',
    'function prefetch(a,b){let m=a.get(model,b);return prepare(a,{afterCompletion:c,attachmentMimeTypes:[],conversationId:b,model:m.slug,systemHints:[],thinkingEffort:m.thinkingEffort})}',
    'async function dispatch(a,b){let c=b.gizmoEditor??a.get(overrides,b.conversationId),cache={inFlightPrepared:null};c.onModelMessage(message);c.onModelMessage(recovered);let u=await a.get(service).startCompletionStream({assertRequestCurrent:()=>{},onPrepareRequestStart:prepare(a),onRequestStart:()=>{},onResponse:n=>{n.isEventStream&&b.requireResponseAcceptance&&c?.resolve(null)},onTiming:e=>{},onStreamData:c.onStreamData,onComplete:()=>{},onTransportClose:()=>{},onError:failed,onRecoverableError:failed,inFlightPrepared:cache.inFlightPrepared,request:b});return u}',
    'function sendInit(){return(sendInit=e((()=>{overrides=atom()})))()}',
    'function statusInit(){return(statusInit=e((()=>{status=family(Q,(c,{get:g})=>{let n=resolve(g,c);if(n==null)return`idle`;let r=g(stream,n),i=g(origin,n)===`tpp`;if(!i&&r!==`idle`)return r;return`idle`})})))()}',
    'function busy(s){switch(s){case`active-async-turn`:case`active-tpp-turn`:case`streaming`:return!0;case`error`:case`idle`:return!1}}',
    'async function nativeSubmit(a,{conversationId:b,prompt:p}){let draft=a.get(steering,b),active=busy(a.get(status,b));if(a.get(submitting,b)||a.get(stopping,b)||active&&draft==null)return!1;let chosen=a.get(model,b);a.set(submitting,b,!0);try{return await send(a,{conversationId:b,model:chosen.slug,prompt:p})}finally{a.set(submitting,b,!1)}}',
  ].join("");
}

function primaryFixture() {
  return [
    'import{}from"./rolldown-runtime-fixture.js";',
    'import{}from"./app-shared-fixture.js";',
    'import{}from"./app-initial-fixture.js";',
    'function Parent(e){let t=(0,Cache.c)(18),{actions:n,canOpenSideChat:r,scopeToThread:i,targetSelector:a}=e,o=useScope(root),s=context(),c;let l=c,d;d=sourceId(o);let f=d,p=useQuery(messages,f),m=useQuery(remote,f);return jsx(Leaf,{onAddResponseTextAnnotation:p,onOpenSideChat:n.onOpenSideChat,targetContainerRefs:l,targetSelector:a})}',
    'function Actions(e){let z=0,f=intl(),[p,m]=state();return label(`selectedTextOverlay.moreDetails`)}',
    'function Errors(e){let b=readState(workMode),x=intl();return()=>{logger.error(`[Composer] side chat failed`,{safe:{},sensitive:{error:e}}),e.get(toast).danger(x.formatMessage({id:`composer.sideSlashCommand.error`}),{errorAnalytics:{toastId:`composer.sideSlashCommand.error`}})}}',
    'function Leaf(e){let t=(0,Cache.c)(8),{onAddResponseTextAnnotation:n,onOpenSideChat:r,targetContainerRefs:i,targetSelector:a}=e,o=zoom();if(n==null&&r==null)return null;let s;t[0]!==n||t[1]!==r||t[2]!==o?(s=(e,t)=>{let{portalTarget:i,rect:a,selectedText:s,selectionRange:c,target:l}=e,u=annotation(l,c,s);return(0,Jsx.jsx)(`div`,{className:`contents`,children:(0,Jsx.jsx)(Actions,{selectedText:s,onAddSelectedText:u==null||n==null?void 0:()=>{n(u,{x:a.right/o,y:a.top/o},t()),window.getSelection()?.removeAllRanges()},onOpenSideChat:r})})},t[0]=n,t[1]=r,t[2]=o,t[3]=s):s=t[3];let c;return t[4]!==s||t[5]!==i||t[6]!==a?(c=(0,Jsx.jsx)(Surface,{targetContainerRefs:i,targetSelector:a,children:s}),t[4]=s,t[5]=i,t[6]=a,t[7]=c):c=t[7],c}',
  ].join("");
}

const enabledContext = { feature: { settings: { tweaks: { selection: { moreDetails: { enabled: true } } } } } };

function appFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "selected-text-more-details-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  const initial = path.join(assets, "app-initial-fixture.js");
  const primary = path.join(assets, "app-primary-fixture.js");
  fs.writeFileSync(initial, initialFixture());
  fs.writeFileSync(primary, primaryFixture());
  return { root, assets, initial, primary };
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
  assert.equal(fs.readFileSync(app.initial, "utf8"), initialFixture());
  assert.equal(fs.readFileSync(app.primary, "utf8"), primaryFixture());
});

test("More details reconnects both assets once and detects complete reapplication", (t) => {
  const app = appFixture(t);
  assert.equal(applySelectedTextMoreDetails(app.root, enabledContext).changed, 2);
  const initial = fs.readFileSync(app.initial, "utf8");
  const primary = fs.readFileSync(app.primary, "utf8");
  assert.match(initial, new RegExp(RUNTIME_MARKER));
  assert.match(primary, new RegExp(OVERLAY_MARKER));
  assert.match(primary, /selectedTextOverlay.quickChatPrompt/);
  assert.equal(applySelectedTextMoreDetails(app.root, enabledContext).changed, 0);
  assert.equal(fs.readFileSync(app.initial, "utf8"), initial);
  assert.equal(fs.readFileSync(app.primary, "utf8"), primary);
});

test("More details discovers renamed upstream symbols and cache bindings", () => {
  const rename = (source) => source.replace(/\b(qInit|qFactory|qCreate|qSource|qShow|qContext|sourceContext|accountContext|sendInit|send|session|cap|host|model|overrides|Leaf|Parent|Cache|Jsx|intl|useScope|sourceId|useQuery|readState|nativeSubmit|submitting|stopping)\b/gu,
    (name) => ["session", "model"].includes(name) ? name : `renamed_${name}`);
  const result = patchSources(rename(initialFixture()), rename(primaryFixture()), "app-initial-fixture.js");
  assert.equal(result.applied, false);
  assert.match(result.initial, /send:renamed_send/);
  assert.match(result.primary, /renamed_useScope\(root\)/);
});

test("helper imports preserve the upstream module evaluation order", () => {
  const original = primaryFixture();
  const result = patchSources(initialFixture(), original, "app-initial-fixture.js");
  const imports = (source) => [...source.matchAll(/import\{[^}]*\}from"([^"]+)";/gu)].map((match) => match[1]);
  assert.deepEqual(imports(result.primary), imports(original));
  assert.match(result.primary, /import\{codexLinuxSelectedTextQuickChatBindings,codexLinuxOpenSelectedTextQuickChat,codexLinuxReportSelectedTextQuickChatState\}from"\.\/app-initial-fixture\.js"/);
});

test("missing, ambiguous, mixed, and drifted contracts leave every asset unchanged", (t) => {
  const variants = [
    (app) => fs.writeFileSync(app.initial, initialFixture().replace("gizmoEditor??", "gizmoEditorChanged??")),
    (app) => fs.writeFileSync(app.initial, initialFixture().replace(/requireResponseAcceptance/gu, "responseAcceptanceChanged")),
    (app) => fs.writeFileSync(app.initial, initialFixture().replace("a.set(submitting,b,!0)", "a.set(submitting,b,drifted)")),
    (app) => fs.writeFileSync(app.primary, primaryFixture().replace("onOpenSideChat:r}", "onOpenSideChat:r,drifted:true}")),
    (app) => fs.writeFileSync(path.join(app.assets, "app-initial-duplicate.js"), initialFixture()),
    (app) => fs.writeFileSync(app.primary, primaryFixture() + `/*${OVERLAY_MARKER}*/`),
    (app) => {
      applySelectedTextMoreDetails(app.root, enabledContext);
      fs.writeFileSync(app.primary, fs.readFileSync(app.primary, "utf8").replace("onMoreDetails:codexLinuxCanAskQuickChat", "onMoreDetails:broken"));
    },
  ];
  for (const modify of variants) {
    const app = appFixture(t);
    modify(app);
    const before = [app.initial, app.primary].map((file) => fs.readFileSync(file, "utf8"));
    const result = warnings(() => applySelectedTextMoreDetails(app.root, enabledContext));
    assert.equal(result.result.changed, 0);
    assert.equal(result.result.matched, 0);
    assert.equal(result.warnings.length, 1);
    assert.deepEqual([app.initial, app.primary].map((file) => fs.readFileSync(file, "utf8")), before);
  }
});

test("renderer keeps annotations and side chat, and invalidates the cached callback on availability and source changes", async () => {
  const result = patchSources(initialFixture(), primaryFixture(), "app-initial-fixture.js");
  const memo = [];
  const scope = { value: { kind: "local", conversationId: "source-a" }, get: () => ({ danger: () => {} }) };
  const calls = [];
  let capable = false;
  let loading = false;
  let blocked = false;
  const language = { formatMessage: ({ id }) => id.endsWith("quickChatPrompt") ? "告诉我更多相关信息" : "所选文字" };
  const context = vm.createContext({ Cache: { c: () => memo }, root: {}, useScope: () => scope,
    sourceId: (value) => value.value.conversationId, useQuery: () => ({ isCapable: capable, isLoading: loading }),
    readState: (atom) => atom === "account" ? {} : blocked, intl: () => language, zoom: () => 1,
    annotation: () => ({ text: "annotation" }), Jsx: { jsx: (component, props) => ({ component, props }) },
    Surface: "surface", toast: "toast", window: { getSelection: () => ({ removeAllRanges() {} }) },
    logger: { info() {} }, [DIAGNOSTICS_EXPORT]() {},
    [BINDINGS_EXPORT]: () => ({ capability: "cap", blocked: "blocked", account: "account" }),
    [OPEN_EXPORT]: async (value, input) => calls.push({ value, input }) });
  vm.runInContext(result.primary.replace(/import\{[^}]*\}from"[^"]+";/gu, ""), context);
  const render = (props) => context.Leaf(props)?.props.children({ rect: { right: 2, top: 3 },
    selectedText: "selection", target: { innerText: "entire source reply" }, selectionRange: {} }, () => "placement").props.children.props;
  const annotationCalls = [];
  const side = () => {};
  const props = { onAddResponseTextAnnotation: (...args) => annotationCalls.push(args), onOpenSideChat: side };
  assert.equal(render(props).onMoreDetails, undefined);
  loading = true;
  assert.equal(render(props).onMoreDetails, undefined);
  loading = false;
  capable = true;
  let actions = render(props);
  assert.equal(actions.onOpenSideChat, side);
  actions.onAddSelectedText();
  assert.equal(annotationCalls.length, 1);
  actions.onMoreDetails("selection");
  await Promise.resolve();
  assert.equal(calls[0].input.prompt, "告诉我更多相关信息");
  assert.equal(calls[0].input.selectedMessageText, "entire source reply");
  scope.value.conversationId = "source-b";
  render(props).onMoreDetails("next selection");
  await Promise.resolve();
  assert.equal(calls[1].input.sourceConversationId, "source-b");
  blocked = true;
  assert.equal(render(props).onMoreDetails, undefined);
  blocked = false;
  assert.equal(typeof render({}).onMoreDetails, "function");
});

function runtimeFixture(options = {}) {
  const calls = [];
  const state = new Map([["account", {}], ["cap", { isCapable: true }], ["blocked", false], ["host", "remote-host"], ["status", "idle"],
    ["submitting", false], ["stopping", false],
    ["model", { slug: "chosen-chatgpt-model", thinkingEffort: "extended" }]]);
  const waiters = [];
  const watch = (condition) => {
    const waiter = { dependencies: new Set(), evaluate() {
      const get = (atom) => { waiter.dependencies.add(atom); return state.get(atom); };
      condition({ get });
    } };
    waiters.push(waiter);
    waiter.evaluate();
    return () => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); };
  };
  const scope = { get: (atom) => state.get(atom), set(atom, ...args) {
    state.set(atom, args.at(-1));
    for (const waiter of [...waiters]) if (waiter.dependencies.has(atom)) waiter.evaluate();
  }, watch, when: (condition) => new Promise((resolve) => {
    const waiter = { dependencies: new Set(), evaluate() {
      const get = (atom) => { waiter.dependencies.add(atom); return state.get(atom); };
      if (condition({ get })) resolve();
    } };
    waiters.push(waiter);
    waiter.evaluate();
  }) };
  let sequence = 0;
  const bindings = { init: "init", sendInit: "sendInit", capability: "cap", blocked: "blocked", account: "account",
    session: "session", host: "host", create: "create", visibility: "show", context: "context", send: "send", model: "model",
    status: "status", statusInit: "statusInit", busy: "busy", submitting: "submitting", stopping: "stopping" };
  const sandbox = vm.createContext({ setTimeout, clearTimeout, ...Object.fromEntries(["cap", "blocked", "account", "session", "host", "model", "status", "submitting", "stopping"].map((key) => [key, key])),
    init() {}, sendInit() {}, statusInit() {}, busy: (status) => ["streaming", "active-async-turn", "active-tpp-turn"].includes(status),
    create(value, input) { const id = input.conversationId ?? `new-chat-${++sequence}`;
      value.set("session", { conversationId: id, contextSourceThread: input.contextSourceThread, hasConversation: false }); return id; },
    show() { calls.push({ type: "show" }); },
    async context(value, sourceThread) { calls.push({ type: "context", sourceThread });
      return options.context ? options.context(value, sourceThread) : ["Codex conversation context"]; },
    async send(value, input) { calls.push({ type: "send", input }); if (options.send) await options.send(value, input); } });
  vm.runInContext(runtimeSource(bindings).replace(/export /gu, ""), sandbox);
  const input = { sourceConversationId: "source-a", selectedText: "chosen text", selectedMessageText: "entire reply containing chosen text",
    prompt: "localized question", targetedReplyLabel: "localized selected text" };
  return { calls, state, scope, input, open: (override = {}) => sandbox[OPEN_EXPORT](scope, { ...input, ...override }),
    openInScope: (value, override = {}) => sandbox[OPEN_EXPORT](value, { ...input, ...override }) };
}

test("Quick Chat sends the selected text, reply, Codex context, localized labels, and selected ChatGPT model", async () => {
  const fixture = runtimeFixture();
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
  const fixture = runtimeFixture({ send: async (scope, input) => {
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
  const fixture = runtimeFixture({ send: async (scope, input) => {
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
  const fixture = runtimeFixture({ send: async (scope, input) => {
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
    const fixture = runtimeFixture();
    fixture.state.set(atom, value);
    await fixture.open();
    assert.equal(fixture.calls.length, 0);
  }
  const empty = runtimeFixture();
  await empty.open({ selectedText: "   " });
  assert.equal(empty.calls.length, 0);
  const switched = runtimeFixture({ context: async (scope) => { scope.set("account", {}); return ["old account context"]; } });
  await switched.open();
  assert.equal(switched.calls.some((call) => call.type === "send"), false);
  assert.equal(switched.state.has("session"), false);
});

test("loading capability keeps Quick Chat closed until account availability is ready", async () => {
  const fixture = runtimeFixture();
  fixture.state.set("cap", { isLoading: true, isCapable: false });
  await fixture.open();
  assert.equal(fixture.calls.length, 0);
  fixture.scope.set("cap", { isLoading: false, isCapable: true });
  await fixture.open();
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
});

test("rapid selections serialize, reuse their source conversation, and recover after a failed send", async () => {
  let attempts = 0;
  const fixture = runtimeFixture({ send: async () => { if (++attempts === 1) throw new Error("network failed"); } });
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
  const fixture = runtimeFixture({ send: async (scope) => scope.set("status", "streaming") });
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
  const fixture = runtimeFixture({ send: async () => {
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
      const fixture = runtimeFixture();
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
  const fixture = runtimeFixture();
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
  const fixture = runtimeFixture();
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
  const fixture = runtimeFixture({ send: async (scope) => scope.set("status", "active-async-turn") });
  await fixture.open();
  const next = fixture.open();
  await new Promise((resolve) => setImmediate(resolve));
  fixture.scope.set("account", {});
  await next;
  assert.equal(fixture.calls.filter((call) => call.type === "send").length, 1);
});

test("long source replies remain bounded while preserving the selected passage in context", async () => {
  const fixture = runtimeFixture();
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
  fs.cpSync(process.env.CODEX_SIGNED_EXTRACTED_APP, copy, { recursive: true });
  const result = warnings(() => applySelectedTextMoreDetails(copy, enabledContext));
  assert.equal(result.warnings.length, 0);
  assert.equal(result.result.matched, 2);
  assert.equal(result.result.changed, 2);
  assert.equal(applySelectedTextMoreDetails(copy, enabledContext).changed, 0);
});
