"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { inspectMainRequestSites: inspect } = require("./main-request-sites.js");
const { findMainProcessChunks } = require("./assets.js");
const { findMatchingBrace, createJavaScriptLexicalIndex, escapeRegExp } = require("./minified-js.js");
const { mainProcessFactories } = require("./main-process-factories.js");

const { graphBody, currentGraphBody, nativePrelude, fixture } = require("./fixtures/main-request-graph.js");

function declarationRange(source, head) {
  const start = source.indexOf(head); assert.ok(start >= 0, head);
  const open = source.indexOf("{", start), end = findMatchingBrace(source, open); assert.ok(end > open);
  return { start, end: end + 1 };
}
function unusedExpression(source, head) {
  const { start, end } = declarationRange(source, head);
  return source.slice(0, start) + "const codexUnusedDeclaration=" + source.slice(start, end) + ";" + source.slice(end);
}
function reassignedDeclaration(source, head, name) {
  const { end } = declarationRange(source, head);
  return source.slice(0, end) + `;${name}=codexOtherBinding;` + source.slice(end);
}
function stateRoute(site) {
  return `/*codex-linux-foundation-state-route*/if("vscode://codex/foundation-state"===${site.requestVar}?.url){codexLinuxFoundationState(${site.requestVar},${site.globalStateExpr},reply=>${site.senderExpr}(${site.webContentsVar},reply));break}`;
}
const STATE_HELPER = 'function codexLinuxFoundationState(request,state,reply){let body=JSON.parse(request.body);if(body.action==="set")state.set(body.key,body.value);reply({type:"fetch-response",responseType:"success",requestId:request.requestId,bodyJsonString:JSON.stringify({value:state.get(body.key)})})}';
function asyncRoute(site) {
  return `/*codex-linux-foundation-async-route*/if(await codexLinuxFoundationAsync.call(this,${site.requestVar},reply=>${site.senderExpr}(${site.webContentsVar},reply)))break;`;
}
const ASYNC_HELPER = 'async function codexLinuxFoundationAsync(request,reply){if(request.url!=="vscode://codex/foundation-async")return!1;await Promise.resolve();reply({type:"fetch-response",responseType:"success",requestId:request.requestId,bodyJsonString:JSON.stringify({value:this.globalState.get("owned")})});return!0}';
function wrapperRoute(site) {
  return `/*codex-linux-foundation-wrapper-route*/if("vscode://codex/foundation-wrapper"===${site.requestVar}?.url)return void await codexLinuxFoundationWrapper(${site.requestVar},reply=>${site.senderExpr}(${site.webContentsVar},reply));`;
}
const WRAPPER_HELPER = 'async function codexLinuxFoundationWrapper(request,reply){await Promise.resolve();if(request.fail)throw Error("async bridge failed");reply({type:"fetch-response",responseType:"success",requestId:request.requestId,bodyJsonString:JSON.stringify({value:JSON.parse(request.body).value})})}';
function selectorRoute(site) {
  return `/*codex-linux-foundation-selector-route*/if(codexLinuxFoundationSelector(${site.requestVar}?.url))return void await codexLinuxFoundationWrapper(${site.requestVar},reply=>${site.senderExpr}(${site.webContentsVar},reply));`;
}
const SELECTOR_HELPER = 'function codexLinuxFoundationSelector(url){return url==="vscode://codex/foundation-selector"}';

// Minimal example adapters exercise the same interface a feature will use.
// They own their complete payload/canonical checks; the shared locator owns
// only graph, insertion position, structural prefix and native continuation.
function add(source, siteName, render, helper) {
  const graph = inspect(source); assert.equal(graph.ok, true, graph.reason);
  const site = graph[siteName], route = render(site), marker = /^\/\*[^*]+\*\//u.exec(route)[0];
  const markerCount = source.split(marker).length - 1, helperCount = source.split(helper).length - 1;
  if (markerCount || helperCount) {
    assert.equal(markerCount, 1, "partial or duplicate own route");
    assert.equal(helperCount, 1, "partial or duplicate own helper");
    const helperAt = source.indexOf(helper), prefix = source.slice(0, helperAt);
    assert.equal(findMatchingBrace("{" + prefix + "}", 0), prefix.length + 1, "own helper must be a real outer-scope declaration");
    assert.doesNotThrow(() => new vm.Script(prefix + "const __canonicalHelperDeclaration=0;"));
    assert.ok(source.slice(site.prefixStart, site.prefixEnd).includes(route), "own route must be a complete statement inside the validated prefix");
    return source;
  }
  return helper + "\n" + source.slice(0, site.nativeStart) + route + source.slice(site.nativeStart);
}
function runtime(source, avatarOptions = {}) {
  const exports = {}, context = vm.createContext({ exports, Error, JSON, Promise, _P: () => null });
  vm.runInContext(source, context);
  const module = { exports: {} }, load = () => { throw Error("unexpected import"); };
  load.d = (target, getters) => { for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get }); };
  exports.modules[82820](module, module.exports, load);
  const messages = [], cancelled = [], values = new Map(), sender = { sendInlineMessageForView(view, message) { assert.equal(this, sender); messages.push({ view, message }); } };
  const state = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const windowManager = { sendMessageToWebContents(view, message) { assert.equal(this, windowManager); messages.push({ view, message }); } };
  const host = module.exports.runMainAppStartup({ globalState: state, chunkedMessageSender: sender, cancelled, windowManager,
    avatarOverlayManager: avatarOptions.avatarOverlayManager,
    getOverlayManagerForOrigin: avatarOptions.getOverlayManagerForOrigin ?? (() => null) });
  return { host, messages, cancelled, state, async request(url, body = {}, extra = {}) {
    const view = { id: "real-view" }, request = { type: "fetch", requestId: `request-${messages.length}`, url, body: JSON.stringify(body), ...extra };
    await host.handleMessage(view, request); return { view, request, response: messages.at(-1)?.message };
  } };
}

test("pure interface exposes only verified sites/parameters and view-only global state", () => {
  const source = fixture(), graph = inspect(source);
  assert.equal(graph.ok, true, graph.reason);
  assert.deepEqual(Object.keys(graph).sort(), ["factoryIds", "ok", "scope", "viewFetch", "wrapperRequest"]);
  assert.equal(graph.viewFetch.globalStateExpr, "this.globalState");
  assert.equal(Object.hasOwn(graph.wrapperRequest, "globalStateExpr"), false);
  assert.equal(graph.viewFetch.insertAt, graph.viewFetch.nativeStart);
  assert.equal(graph.wrapperRequest.insertAt, graph.wrapperRequest.nativeStart);
  assert.ok(source.slice(graph.viewFetch.nativeStart).startsWith("await this.fetchWrapper.handleRequest(e,t)"));
  assert.ok(source.slice(graph.wrapperRequest.nativeStart).startsWith('if("/codex/dictation-stream-connect-info"===t.url)'));
  assert.deepEqual(inspect(source), graph, "inspection has no source edits or state changes");
});

test("verified source ranges keep feature contracts inside the actual factory, startup and host", () => {
  const source = fixture(), graph = inspect(source);
  assert.equal(graph.ok, true, graph.reason);
  const { scope } = graph;
  const factory = source.slice(scope.factoryStart, scope.factoryEnd);
  const startup = source.slice(scope.startupStart, scope.startupEnd);
  const host = source.slice(scope.hostStart, scope.hostEnd);
  assert.ok(factory.startsWith("class RequestWrapper{"));
  assert.ok(factory.endsWith("module.exports=exports;"));
  assert.ok(startup.startsWith("let created=function("));
  assert.ok(startup.endsWith("return created"));
  assert.ok(host.startsWith("class Host{"));
  assert.ok(host.endsWith("this.seen.push(t.type)}}"));
  assert.ok(scope.factoryStart <= scope.startupStart && scope.startupEnd <= scope.factoryEnd);
  assert.ok(scope.factoryStart <= scope.hostStart && scope.hostEnd <= scope.factoryEnd);
  for (const site of [graph.viewFetch, graph.wrapperRequest]) {
    assert.ok(scope.factoryStart <= site.ownerStart && site.ownerEnd <= scope.factoryEnd);
    assert.ok(site.ownerStart < site.methodBodyStart && site.methodBodyEnd < site.ownerEnd);
    assert.ok(site.methodBodyStart <= site.prefixStart && site.prefixEnd <= site.methodBodyEnd);
    const method = source.slice(site.methodBodyStart, site.methodBodyEnd);
    assert.doesNotThrow(() => new vm.Script(`async function request(${site.webContentsVar},${site.requestVar}){${method}}`));
  }
});

test("current CJS carrier supports exponent keys and applies JavaScript property identity", () => {
  assert.equal(inspect(fixture(graphBody(), "8.282e4", ',9e4(){return true}')).ok, true);
  for (const source of [fixture(graphBody(), "8.282e4", ',82820(){return false}'), fixture(graphBody(), "8.282e4", ',"82820"(){return false}'), fixture(graphBody(), "9007199254740993"), fixture(graphBody(), "8.5"), fixture() + fixture(), 'const text=' + JSON.stringify(fixture()) + ";", 'function unused(){' + fixture() + '}']) {
    assert.equal(inspect(source).ok, false);
  }
});
test("factory identity finds related copies even after every request discovery needle is lost", () => {
  const good = inspect(fixture());
  assert.equal(good.ok, true, good.reason);
  assert.equal(good.scope.factoryId, "82820");
  assert.deepEqual(good.factoryIds, [good.scope.factoryId]);
  for (const key of ["82820", "8.282e4", '"82820"']) {
    const missing = inspect(fixture("return false;", key));
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.factoryIds, [good.scope.factoryId]);
    assert.equal(Object.hasOwn(missing, "scope"), false, "identity alone is not a verified graph");
  }
  assert.deepEqual(inspect("const unrelated=true;").factoryIds, []);
});
test("current inert empty object spread cannot override a literal wiring property", () => {
  const source = fixture().replace("}({globalState:e.globalState,chunkedMessageSender", "}({globalState:e.globalState,...{},chunkedMessageSender");
  assert.equal(inspect(source).ok, true);
});

test("two insertion sites work independently and in both composition orders", async () => {
  for (const order of [["state"], ["wrapper"], ["state", "wrapper"], ["wrapper", "state"]]) {
    let source = fixture();
    for (const name of order) source = name === "state" ? add(source, "viewFetch", stateRoute, STATE_HELPER) : add(source, "wrapperRequest", wrapperRoute, WRAPPER_HELPER);
    const run = runtime(source);
    if (order.includes("state")) {
      await run.request("vscode://codex/foundation-state", { action: "set", key: "owned", value: "saved" });
      const { response } = await run.request("vscode://codex/foundation-state", { action: "get", key: "owned" });
      assert.equal(JSON.parse(response.bodyJsonString).value, "saved");
      assert.equal(add(source, "viewFetch", stateRoute, STATE_HELPER), source);
    }
    if (order.includes("wrapper")) {
      const { response } = await run.request("vscode://codex/foundation-wrapper", { value: "async reply" });
      assert.equal(JSON.parse(response.bodyJsonString).value, "async reply");
      await assert.rejects(run.request("vscode://codex/foundation-wrapper", {}, { fail: true }), /async bridge failed/u);
      assert.equal(add(source, "wrapperRequest", wrapperRoute, WRAPPER_HELPER), source);
    }
    const { view, request, response } = await run.request("/codex/dictation-stream-connect-info");
    assert.equal(response.requestId, request.requestId); assert.equal(response.responseType, "success");
    assert.equal(run.messages.at(-1).view, view);
    const failed = await run.request("/codex/dictation-stream-connect-info", {}, { fail: true });
    assert.equal(failed.response.responseType, "error");
    await assert.rejects(run.request("https://example.invalid/"), /HTTP requests must use the HTTP fetch service/u);
    const cancel = { type: "cancel-fetch", requestId: "cancelled" }; await run.host.handleMessage(view, cancel);
    assert.equal(run.cancelled[0].owner, run.host.fetchWrapper); assert.equal(run.cancelled[0].request, cancel);
    assert.equal(run.cancelled[0].view, view);
  }
});

test("complete owned prefixes retain arbitrary composition position and native continuation", async () => {
  let source = add(fixture(), "viewFetch", stateRoute, STATE_HELPER);
  source = add(source, "viewFetch", asyncRoute, ASYNC_HELPER);
  source = add(source, "wrapperRequest", wrapperRoute, WRAPPER_HELPER);
  source = add(source, "wrapperRequest", selectorRoute, SELECTOR_HELPER);
  const graph = inspect(source); assert.equal(graph.ok, true, graph.reason);
  assert.ok(graph.viewFetch.prefixEnd > graph.viewFetch.prefixStart);
  assert.ok(graph.wrapperRequest.prefixEnd > graph.wrapperRequest.prefixStart);
  assert.equal(add(source, "viewFetch", stateRoute, STATE_HELPER), source, "own canonical route need not be adjacent to native forward");
  assert.equal(add(source, "wrapperRequest", wrapperRoute, WRAPPER_HELPER), source);
  const run = runtime(source); run.state.set("owned", "correct this");
  assert.equal(JSON.parse((await run.request("vscode://codex/foundation-async")).response.bodyJsonString).value, "correct this");
  assert.equal(JSON.parse((await run.request("vscode://codex/foundation-selector", { value: "selector" })).response.bodyJsonString).value, "selector");
  assert.throws(() => add(source.replace(STATE_HELPER, ""), "viewFetch", stateRoute, STATE_HELPER), /partial or duplicate own helper/u);
  assert.throws(() => add(source.replace(STATE_HELPER, "const unused=`" + STATE_HELPER + "`;"), "viewFetch", stateRoute, STATE_HELPER), /real outer-scope declaration/u);
});

const corruptions = {
  "missing graph": source => source.replace("this.fetchWrapper=new RequestWrapper", "this.fetchWrapper=new OtherWrapper"),
  "wrong wrapper sender": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", "chunkedMessageSender:e.otherSender,cancelled"),
  "wrong view sender argument": source => source.replace("e.windowManager,e.chunkedMessageSender,f,g", "e.windowManager,e.otherSender,f,g"),
  "wrong wrapper argument": source => source.replace("f,g,this.fetchWrapper,this.scopedState", "f,g,this.otherWrapper,this.scopedState"),
  "wrong state argument": source => source.replace("f,g,this.fetchWrapper,this.scopedState", "f,g,this.fetchWrapper,e.globalState"),
  "wrong state ownership": source => source.replace("this.scopedState=e.globalState", "this.scopedState=e.appGlobalState"),
  "wrong view state binding": source => source.replace("this.globalState=state", "this.globalState=wrapper"),
  "wrong wrapper options": source => source.replace("this.options=e}async handleRequest", "this.options=other}async handleRequest"),
  "wrong wrapper reply receiver": source => source.replaceAll("this.options.chunkedMessageSender.sendInlineMessageForView", "this.chunkedMessageSender.sendInlineMessageForView"),
  "wrong dictation request id": source => source.replaceAll("requestId:t.requestId", "requestId:other.requestId"),
  "wrong native forwarding arguments": source => source.replace("await this.fetchWrapper.handleRequest(e,t)", "await this.fetchWrapper.handleRequest(t,e)"),
  "wrong cancel forwarding": source => source.replace("this.fetchWrapper.cancelRequest(e,t)", "this.other.cancelRequest(e,t)"),
  "unused view method": source => source.replace("async handleMessage(e,t){switch", "async unused(e,t){switch"),
  "unused wrapper method": source => source.replace("async handleRequest(e,t){if", "async unused(e,t){if"),
  "nested view construction": source => source.replace("this.messageHandler=new ViewHandler", "let unused=()=>this.messageHandler=new ViewHandler"),
  "nested wrapper construction": source => source.replace("this.fetchWrapper=new RequestWrapper", "unused=()=>this.fetchWrapper=new RequestWrapper"),
  "unconditional view return": source => source.replace("async handleMessage(e,t){switch", "async handleMessage(e,t){return;switch"),
  "wrong host dispatch": source => source.replace("await this.messageHandler.handleMessage(e,t)", "await this.other.handleMessage(e,t)"),
  "wrong startup publication target": source => source.replace("require.d(exports,{runMainAppStartup", "require.d(module,{runMainAppStartup"),
  "unused startup publication": source => source.replace("require.d(exports,{runMainAppStartup:()=>runMainAppStartup})", "(()=>require.d(exports,{runMainAppStartup:()=>runMainAppStartup}))"),
  "uninvoked startup factory": source => source.replace("}({globalState:e.globalState", "};let unusedOptions=({globalState:e.globalState"),
  "wrong startup host state": source => source.replace("new Host({globalState:state", "new Host({globalState:other"),
  "wrong startup host sender": source => source.replace("new Host({globalState:state,chunkedMessageSender:sender", "new Host({globalState:state,chunkedMessageSender:other"),
  "missing startup state argument": source => source.replace("}({globalState:e.globalState", "}({otherState:e.globalState"),
  "shadowed host in startup": source => source.replace("function runMainAppStartup(e){", "function runMainAppStartup(e){let Host=OtherHost;"),
  "shadowed host in startup IIFE": source => source.replace("function({globalState:state,chunkedMessageSender:sender", "function({host:Host,globalState:state,chunkedMessageSender:sender"),
  "unconditional startup return": source => source.replace("function runMainAppStartup(e){", "function runMainAppStartup(e){return null;"),
  "unused dictation responder": source => source.replace("async handleDictationStreamConnectInfoRequest(e,t){try", "async handleDictationStreamConnectInfoRequest(e,t){return;try"),
  "conditional dictation response": source => source.replace(";this.options.chunkedMessageSender.sendInlineMessageForView(e", ";if(false)this.options.chunkedMessageSender.sendInlineMessageForView(e"),
  "class expression instead of declaration": source => unusedExpression(source, "class RequestWrapper{"),
  "startup expression instead of declaration": source => unusedExpression(source, "function runMainAppStartup("),
  "reassigned wrapper declaration": source => reassignedDeclaration(source, "class RequestWrapper{", "RequestWrapper"),
  "reassigned startup declaration": source => reassignedDeclaration(source, "function runMainAppStartup(", "runMainAppStartup"),
  "nonempty options spread": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", "chunkedMessageSender:e.chunkedMessageSender,...{chunkedMessageSender:e.otherSender},cancelled"),
  "expression options spread": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", "chunkedMessageSender:e.chunkedMessageSender,...e.otherOptions,cancelled"),
  "quoted options override": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", 'chunkedMessageSender:e.chunkedMessageSender,"chunkedMessageSender":e.otherSender,cancelled'),
  "computed options override": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", 'chunkedMessageSender:e.chunkedMessageSender,["chunkedMessageSender"]:e.otherSender,cancelled'),
  "accessor options override": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", 'chunkedMessageSender:e.chunkedMessageSender,get chunkedMessageSender(){return e.otherSender},cancelled'),
  "duplicate data options override": source => source.replace("chunkedMessageSender:e.chunkedMessageSender,cancelled", "chunkedMessageSender:e.chunkedMessageSender,chunkedMessageSender:e.otherSender,cancelled"),
  "quoted host state override": source => source.replace("new Host({globalState:state,chunkedMessageSender", 'new Host({globalState:state,"globalState":other,chunkedMessageSender'),
  "startup state spread override": source => source.replace("}({globalState:e.globalState,chunkedMessageSender", "}({globalState:e.globalState,...{globalState:e.otherState},chunkedMessageSender"),
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`rejects ${name} rather than a textual owner`, () => {
  const source = fixture(), damaged = corrupt(source); assert.notEqual(damaged, source); assert.equal(inspect(damaged).ok, false);
});

test("independent, nested and string decoys cannot replace a connected same-factory graph", () => {
  const source = fixture();
  assert.equal(inspect(fixture('const text=' + JSON.stringify(graphBody()) + ";")).ok, false);
  assert.equal(inspect(fixture("function unused(){" + graphBody() + "}")).ok, false);
  assert.equal(inspect(fixture(graphBody().replace("class RequestWrapper", "class OtherWrapper"))).ok, false);
  assert.equal(inspect(fixture(graphBody(), "1") + fixture(graphBody(), "2")).ok, false);
  assert.equal(inspect(source + '\nconst unrelated="async handleRequest(e,t){fake}";').ok, true);
  assert.equal(inspect(source.replace("options;constructor(e)", 'options;decoy="async handleRequest(e,t){fake}";constructor(e)')).ok, true);
  assert.equal(inspect(source.replace("globalState;constructor", 'globalState;decoy="await this.fetchWrapper.handleRequest(e,t)";constructor')).ok, true);
});

test("prefix structure rejects broken, unused, mismatched or duplicate owned statements", () => {
  const current = fixture(), first = inspect(current), route = stateRoute(first.viewFetch);
  for (const prefix of [route.replace("this.globalState", "this.otherState"), route.replace("sendInlineMessageForView(e,reply)", "sendInlineMessageForView(other,reply)"), route.replace("reply=>this.chunkedMessageSender.sendInlineMessageForView(e,reply)", "e=>this.chunkedMessageSender.sendInlineMessageForView(e,e)"), route.replace("codexLinuxFoundationState(t,", "codexLinuxFoundationState(other,"), route.replace(";break}", ";return}"), route + route, '/*codex-linux-fake-route*/const unused=()=>{};', '/*codex-linux-fake-route*/return;', route.slice(0, -1)]) {
    const source = current.slice(0, first.viewFetch.insertAt) + prefix + current.slice(first.viewFetch.insertAt);
    assert.equal(inspect(source).ok, false);
  }
  const withWrapper = add(current, "wrapperRequest", wrapperRoute, WRAPPER_HELPER), site = inspect(withWrapper).wrapperRequest;
  const prefix = withWrapper.slice(site.prefixStart, site.prefixEnd);
  for (const damaged of [prefix.replace("return void await", "return void"), prefix.replace("this.options.chunkedMessageSender", "this.chunkedMessageSender"), prefix.replace("reply=>this.options.chunkedMessageSender.sendInlineMessageForView(e,reply)", "e=>this.options.chunkedMessageSender.sendInlineMessageForView(e,e)"), prefix.replace("Wrapper(t,", "Wrapper(other,"), prefix.replace("if(", "if(false&&")]) {
    assert.equal(inspect(withWrapper.slice(0, site.prefixStart) + damaged + withWrapper.slice(site.prefixEnd)).ok, false);
  }
});

function replaceRequired(source, from, to, start = 0, end = source.length) {
  const before = source.slice(start, end), after = before.replace(from, to);
  assert.notEqual(after, before, `expected current source anchor ${from}`);
  return source.slice(0, start) + after + source.slice(end);
}
function currentPrelude(source, graph) {
  const start = graph.viewFetch.methodBodyStart, body = source.slice(start, graph.viewFetch.methodBodyEnd);
  const lexical = createJavaScriptLexicalIndex(body);
  const dispatches = [...body.matchAll(new RegExp(`switch\\(${escapeRegExp(graph.viewFetch.requestVar)}\\.type\\)\\{`, "gu"))]
    .filter(match => lexical.isRoot(match.index));
  assert.equal(dispatches.length, 1);
  return { start, end: start + dispatches[0].index, text: body.slice(0, dispatches[0].index) };
}
function preludeCorruptions(source, graph) {
  const prelude = currentPrelude(source, graph), text = prelude.text;
  const view = graph.viewFetch.webContentsVar, request = graph.viewFetch.requestVar;
  const bodyOpen = text.indexOf("{switch("), bodyEnd = findMatchingBrace(text, bodyOpen);
  assert(bodyOpen > 0 && bodyEnd > bodyOpen);
  const body = text.slice(bodyOpen + 1, bodyEnd);
  const changes = [
    ["wrong origin lookup view", `getOverlayManagerForOrigin?.(${view})`, "getOverlayManagerForOrigin?.(otherView)"],
    ["wrong manager fallback", "??this.avatarOverlayManager", "??this.otherManager"],
    ["wrong forwarded view", `,${view},${request},`, `,otherView,${request},`],
    ["wrong forwarded request", `,${view},${request},`, `,${view},otherRequest,`],
    ["wrong callback view", `sendMessageToWebContents(${view},`, "sendMessageToWebContents(otherView,"],
    ["wrong async generator kind", "async function(", "async function*("],
    ["lost native await", "return void await async function(", "return void async function("],
    ["uninvoked native function", "}(this.getOverlayManagerForOrigin", "};const unusedOptions=(this.getOverlayManagerForOrigin"],
    ["wrong inner request discriminator", "switch(r.type)", "switch(other.type)"],
    ["unconsumed manager parameter", "async function(e,t,r,n=()=>{})", "async function(otherManager,t,r,n=()=>{})"],
    ["unconsumed view parameter", "async function(e,t,r,n=()=>{})", "async function(e,otherView,r,n=()=>{})"],
    ["unconsumed reply parameter", "async function(e,t,r,n=()=>{})", "async function(e,t,r,otherReply=()=>{})"],
    ["unbound native this dependency", 'case"avatar-overlay-close":e.dismiss()', 'case"avatar-overlay-close":this.unqualifiedNativeDependency();e.dismiss()'],
    ["callback shadows captured view", `${request}=>{this.windowManager.sendMessageToWebContents(${view},${request})}`,
      `${view}=>{this.windowManager.sendMessageToWebContents(${view},${view})}`],
  ].map(([name, from, to]) => [name, replaceRequired(source, from, to, prelude.start, prelude.end)]);
  for (const [name, replacement] of [
    ["early inner return", "return null;" + body],
    ["unused nested dispatcher", `const unused=async()=>{${body}};return null;`],
    ["native call continuation", null],
  ]) {
    const changed = replacement == null ? text.slice(0, -1) + "&&other();" :
      text.slice(0, bodyOpen + 1) + replacement + text.slice(bodyEnd);
    changes.push([name, source.slice(0, prelude.start) + changed + source.slice(prelude.end)]);
  }
  return changes;
}

test("current native inline Avatar prelude preserves per-origin manager and reply view identity", async () => {
  const source = fixture(currentGraphBody()), graph = inspect(source);
  assert.equal(graph.ok, true, graph.reason);
  assert.equal(currentPrelude(source, graph).text, nativePrelude);
  const selected = [], views = [{ id: "first" }, { id: "second" }, { id: "fallback" }];
  const first = { isOpen: () => true, async toggle(view) { assert.equal(this, first); assert.equal(view, views[0]); throw Error("avatar native failure"); } };
  const second = { isOpen: () => false }, fallback = { isOpen: () => false };
  const run = runtime(source, { avatarOverlayManager: fallback,
    getOverlayManagerForOrigin(view) { selected.push({ receiver: this, view }); return view === views[0] ? first : view === views[1] ? second : null; } });
  for (const view of views) {
    await run.host.handleMessage(view, { type: "avatar-overlay-open-state-request" });
    const message = run.messages.at(-1);
    assert.equal(message.view, view);
    assert.equal(message.message.type, "avatar-overlay-open-state-changed");
    assert.equal(message.message.isOpen, view === views[0]);
  }
  assert(selected.every(call => call.receiver === run.host.messageHandler));
  await assert.rejects(run.host.handleMessage(views[0], { type: "avatar-overlay-open" }), /avatar native failure/u);
});

test("current inline prelude requires its active ordinary async call, dispatcher and correlated arguments", () => {
  const source = fixture(currentGraphBody()), graph = inspect(source);
  assert.equal(graph.ok, true, graph.reason);
  for (const [name, damaged] of preludeCorruptions(source, graph)) {
    assert.doesNotThrow(() => new vm.Script(damaged), name);
    const result = inspect(damaged);
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.factoryIds, graph.factoryIds, name);
  }
  const oldNamed = replaceRequired(source, currentPrelude(source, graph).text,
    'if(t.type.startsWith("avatar-overlay-"))return void await oldAvatar(this.getOverlayManagerForOrigin?.(e)??this.avatarOverlayManager,e,t,t=>{this.windowManager.sendMessageToWebContents(e,t)});');
  assert.equal(inspect(oldNamed).ok, false, "retired named dispatcher is outside the latest native contract");
  const current = currentPrelude(source, graph), fnStart = current.text.indexOf("async function("), open = current.text.indexOf("{switch(", fnStart), end = findMatchingBrace(current.text, open);
  let renamed = current.text.slice(fnStart, end + 1);
  for (const [from, to] of [["e", "nativeManager"], ["t", "nativeView"], ["n", "nativeReply"]]) {
    renamed = renamed.replace(new RegExp(`(?<![\\w$.])${from}(?![\\w$])`, "gu"), to);
  }
  const aliasPrelude = current.text.slice(0, fnStart) + renamed + current.text.slice(end + 1);
  const aliasSource = source.slice(0, current.start) + aliasPrelude + source.slice(current.end);
  assert.doesNotThrow(() => new vm.Script(aliasSource));
  assert.equal(inspect(aliasSource).ok, true, "correlated native parameter aliases remain supported");
});

function classNameAt(source, start) {
  const found = /^class ([\w$]+)/u.exec(source.slice(start)); assert.ok(found); return found[1];
}
function constructorRange(source, ownerStart, ownerEnd) {
  const open = source.indexOf("{", ownerStart), body = source.slice(open + 1, ownerEnd - 1);
  const lexical = createJavaScriptLexicalIndex(body);
  const heads = [...body.matchAll(/\bconstructor\(/gu)].filter(match => lexical.isRoot(match.index));
  assert.equal(heads.length, 1);
  const paramsOpen = heads[0].index + heads[0][0].length - 1;
  let depth = 1, end = paramsOpen + 1;
  for (; end < body.length; end++) {
    if (!lexical.isCode(end)) continue;
    if (body[end] === "(") depth++;
    if (body[end] === ")" && --depth === 0) break;
  }
  assert.equal(body[end + 1], "{");
  return { start: open + end + 3, end: open + 1 + findMatchingBrace(body, end + 1), params: body.slice(paramsOpen + 1, end) };
}
function protectedBindings(source, graph) {
  const classes = [graph.wrapperRequest.ownerStart, graph.viewFetch.ownerStart, graph.scope.hostStart]
    .map(start => { const name = classNameAt(source, start); return { name, head: `class ${name}{` }; });
  const startup = /((?:async )?function ([\w$]+)\([^(){}]*\)\{)$/u.exec(source.slice(graph.scope.factoryStart, graph.scope.startupStart));
  assert.ok(startup);
  return [...classes, { name: startup[2], head: startup[1].slice(0, -1) }]
    .map(binding => ({ ...binding, end: declarationRange(source, binding.head).end }));
}
function bindingReplacementCases(source, graph) {
  return protectedBindings(source, graph).flatMap(({ name, end }) => {
    const code = name.charCodeAt(name.length - 1).toString(16);
    const spellings = [name, name.slice(0, -1) + "\\u" + code.padStart(4, "0"), name.slice(0, -1) + "\\u{" + code + "}"];
    return spellings.map(binding => [`replaced binding ${binding}`, source.slice(0, end) + `;${binding}=class{};` + source.slice(end)]);
  });
}

test("protected root class and startup bindings reject encoded replacements while lexical data stays inert", () => {
  const source = fixture(currentGraphBody()), graph = inspect(source);
  assert.equal(graph.ok, true, graph.reason);
  for (const [name, damaged] of bindingReplacementCases(source, graph)) {
    assert.doesNotThrow(() => new vm.Script(damaged), name);
    const result = inspect(damaged);
    assert.equal(result.ok, false, name);
    assert.deepEqual(result.factoryIds, graph.factoryIds, name);
  }
  for (const { name, end } of protectedBindings(source, graph)) {
    const encoded = name.slice(0, -1) + "\\u" + name.charCodeAt(name.length - 1).toString(16).padStart(4, "0");
    for (const inert of [`;const codexBindingNote=${JSON.stringify(name + "=class{};" + encoded + "=class{};")};`,
      `;/* ${name}=class{};${encoded}=class{}; */`, `;const codexHolder={};codexHolder.${encoded}=class{};`]) {
      const current = source.slice(0, end) + inert + source.slice(end);
      assert.doesNotThrow(() => new vm.Script(current));
      assert.equal(inspect(current).ok, true, inert);
    }
  }
});

function blockBindingReplacementCases(source, graph) {
  return protectedBindings(source, graph).flatMap(({ name, end }) => {
    const encoded = name.slice(0, -1) + "\\u" + name.charCodeAt(name.length - 1).toString(16).padStart(4, "0");
    return [name, encoded].flatMap(binding => [
      `;{${binding}=class{}};`, `;if(true){${binding}=class{}};`,
      `;{({value:${binding}}=otherBindings)};`, `;if(true){[${binding}]=otherBindings};`,
      `;{({outer:[{value:${binding}}]}=otherBindings)};`, `;{(${binding})=class{}};`,
      `;const functionHolder=()=>{};functionHolder()\n{${binding}=class{}};`,
    ].map(insertion => [insertion, source.slice(0, end) + insertion + source.slice(end)]));
  });
}

test("protected factory bindings reject ordinary-block writes while preserving lexical and deferred ownership", () => {
  const source = fixture(currentGraphBody()), graph = inspect(source); assert.equal(graph.ok, true, graph.reason);
  for (const [name, damaged] of blockBindingReplacementCases(source, graph)) {
    assert.doesNotThrow(() => new vm.Script(damaged), name);
    const rejected = inspect(damaged); assert.equal(rejected.ok, false, name);
    assert.deepEqual(rejected.factoryIds, graph.factoryIds, name); assert.equal(Object.hasOwn(rejected, "scope"), false, name);
  }
  for (const { name, end } of protectedBindings(source, graph)) {
    const local = [
      `;{let ${name}=class{};${name}=class{}};`,
      `;if(true){const ${name}=class{};${name}=class{}};`,
      `;{class ${name}{};({value:${name}}=otherBindings)};`,
      `;function codexUnusedBinding(){${name}=class{}}`,
      `;const codexUnusedBinding=function(){${name}=class{}};`,
      `;const codexUnusedBinding=()=>{${name}=class{}};`,
      `;try{throw null}catch(${name}){${name}=class{}}`,
      `;const codexBindingNote=${JSON.stringify(`{${name}=class{}}`)};`,
      `;/* {${name}=class{}} */`, `;{const codexHolder={};codexHolder.${name}=class{}};`,
    ];
    if (name !== protectedBindings(source, graph).at(-1).name) local.push(`;{function ${name}(){};${name}=class{}};`);
    for (const insertion of local) {
      const current = source.slice(0, end) + insertion + source.slice(end);
      assert.doesNotThrow(() => new vm.Script(current), insertion);
      assert.equal(inspect(current).ok, true, insertion);
    }
  }
});

function nativeWiringCorruptions(source, graph) {
  const hostName = classNameAt(source, graph.scope.hostStart), wrapperName = classNameAt(source, graph.wrapperRequest.ownerStart), viewName = classNameAt(source, graph.viewFetch.ownerStart);
  const ctor = constructorRange(source, graph.scope.hostStart, graph.scope.hostEnd);
  assert.match(ctor.params, /^[\w$]+$/u);
  const input = ctor.params;
  const wrapperHead = `this.fetchWrapper=new ${wrapperName}({`, wrapperAt = source.indexOf(wrapperHead, ctor.start);
  assert(wrapperAt >= ctor.start && wrapperAt < ctor.end);
  const optionsOpen = wrapperAt + wrapperHead.length - 1, optionsEnd = findMatchingBrace(source, optionsOpen) + 1;
  const viewCall = new RegExp(`this\\.messageHandler=new ${escapeRegExp(viewName)}\\((?<args>[\\w$.]+(?:,[\\w$.]+){8})`, "u").exec(source.slice(ctor.start, ctor.end));
  assert.ok(viewCall);
  const viewAt = ctor.start + viewCall.index, viewEnd = viewAt + viewCall[0].length;
  const startupPrefix = source.slice(graph.scope.factoryStart, graph.scope.startupStart);
  const startup = /((?:async )?function ([\w$]+)\([^(){}]*\)\{)$/u.exec(startupPrefix); assert.ok(startup);
  const factory = mainProcessFactories(source).find(item => item.identity === graph.scope.factoryId); assert.ok(factory);
  const [, target, loader] = factory.parameters;
  const publication = `${loader}.d(${target},{runMainAppStartup:()=>${startup[2]}})`;
  return [
    ["wrong scoped state ownership", replaceRequired(source, `this.scopedState=${input}.globalState`, `this.scopedState=${input}.otherState`, ctor.start, ctor.end)],
    ["wrong wrapper sender", replaceRequired(source, `chunkedMessageSender:${input}.chunkedMessageSender`, `chunkedMessageSender:${input}.otherSender`, optionsOpen, optionsEnd)],
    ["wrong view sender", replaceRequired(source, `${input}.chunkedMessageSender`, `${input}.otherSender`, viewAt, viewEnd)],
    ["wrong wrapper argument", replaceRequired(source, "this.fetchWrapper", "this.otherWrapper", viewAt, viewEnd)],
    ["wrong view state argument", replaceRequired(source, "this.scopedState", "this.otherState", viewAt, viewEnd)],
    ["unused view construction", replaceRequired(source, `this.messageHandler=new ${viewName}`, `this.unused=()=>this.messageHandler=new ${viewName}`, ctor.start, ctor.end)],
    ["unused wrapper entry", replaceRequired(source, `async handleRequest(${graph.wrapperRequest.webContentsVar},${graph.wrapperRequest.requestVar}){`, `async unusedHandleRequest(${graph.wrapperRequest.webContentsVar},${graph.wrapperRequest.requestVar}){`, graph.wrapperRequest.ownerStart, graph.wrapperRequest.ownerEnd)],
    ["wrong fetch continuation", replaceRequired(source, `await this.fetchWrapper.handleRequest(${graph.viewFetch.webContentsVar},${graph.viewFetch.requestVar});break;case"cancel-fetch":`, `await this.otherWrapper.handleRequest(${graph.viewFetch.webContentsVar},${graph.viewFetch.requestVar});break;case"cancel-fetch":`, graph.viewFetch.methodBodyStart, graph.viewFetch.methodBodyEnd)],
    ["wrong publication target", replaceRequired(source, publication, `${loader}.d(otherExports,{runMainAppStartup:()=>${startup[2]}})`)],
    ["unused host construction", replaceRequired(source, `new ${hostName}({`, "new OtherHost({", graph.scope.startupStart, graph.scope.startupEnd)],
    ["unused dictation responder", replaceRequired(source, `async handleDictationStreamConnectInfoRequest(${graph.wrapperRequest.webContentsVar},${graph.wrapperRequest.requestVar}){try`, `async handleDictationStreamConnectInfoRequest(${graph.wrapperRequest.webContentsVar},${graph.wrapperRequest.requestVar}){return;try`, graph.wrapperRequest.ownerStart, graph.wrapperRequest.ownerEnd)],
    ["wrapper class expression", unusedExpression(source, `class ${wrapperName}{`)],
    ["startup function expression", unusedExpression(source, startup[1].slice(0, -1))],
    ["reassigned wrapper", reassignedDeclaration(source, `class ${wrapperName}{`, wrapperName)],
    ["reassigned startup", reassignedDeclaration(source, startup[1].slice(0, -1), startup[2])],
    ["nonempty sender override spread", replaceRequired(source, `chunkedMessageSender:${input}.chunkedMessageSender`, `chunkedMessageSender:${input}.chunkedMessageSender,...{chunkedMessageSender:${input}.otherSender}`, optionsOpen, optionsEnd)],
    ["quoted sender override", replaceRequired(source, `chunkedMessageSender:${input}.chunkedMessageSender`, `chunkedMessageSender:${input}.chunkedMessageSender,"chunkedMessageSender":${input}.otherSender`, optionsOpen, optionsEnd)],
  ];
}

function nativeFragments(source) {
  const graph = inspect(source); assert.equal(graph.ok, true, graph.reason);
  const messages = [], cancelled = [], state = new Map();
  const sender = { sendInlineMessageForView(view, message) { assert.equal(this, sender); messages.push({ view, message }); } };
  const windowManager = { sendMessageToWebContents(view, message) { assert.equal(this, windowManager); messages.push({ view, message }); } };
  const originCalls = [], manager = { isOpen: () => true };
  const context = vm.createContext({ Error, JSON, Promise, _P: () => null });
  vm.runInContext(STATE_HELPER + ASYNC_HELPER + WRAPPER_HELPER + SELECTOR_HELPER, context);
  const method = site => vm.runInContext(`(async function(${site.webContentsVar},${site.requestVar}){${source.slice(site.methodBodyStart, site.methodBodyEnd)}})`, context);
  const wrapper = { options: { chunkedMessageSender: sender },
    async handleDictationStreamConnectInfoRequest(view, request) { sender.sendInlineMessageForView(view, { type: "fetch-response", requestId: request.requestId, responseType: "success" }); },
    cancelRequest(view, request) { cancelled.push({ receiver: this, view, request }); } };
  wrapper.handleRequest = method(graph.wrapperRequest);
  const viewOwner = { chunkedMessageSender: sender, fetchWrapper: wrapper, globalState: { get: key => state.get(key), set: (key, value) => state.set(key, value) }, windowManager,
    avatarOverlayManager: { isOpen: () => false }, getOverlayManagerForOrigin(view) { originCalls.push({ receiver: this, view }); return manager; } };
  viewOwner.handleMessage = method(graph.viewFetch);
  return { graph, messages, cancelled, state, wrapper, viewOwner, originCalls, async request(url, body = {}, extra = {}) {
    const view = { id: "actual-fragment-view" }, request = { type: "fetch", requestId: `request-${messages.length}`, url, body: JSON.stringify(body), ...extra };
    await viewOwner.handleMessage(view, request);
    return { view, request, response: messages.at(-1)?.message };
  } };
}

for (const envName of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  test(`actual signed main graph, bounded rejection and inert method execution (${envName})`, { skip: process.env[envName] == null }, async () => {
    const inventory = findMainProcessChunks(process.env[envName]); assert.ok(inventory);
    const candidates = inventory.chunks.map(name => ({ name, source: fs.readFileSync(path.join(inventory.buildDir, name), "utf8") }));
    const owners = candidates.map(candidate => ({ ...candidate, graph: inspect(candidate.source) })).filter(({ graph }) => graph.ok);
    assert.equal(owners.length, 1);
    const { source, graph } = owners[0];
    assert.deepEqual(inspect(source), graph);
    assert.equal(graph.viewFetch.globalStateExpr, "this.globalState");
    assert.equal(currentPrelude(source, graph).text, nativePrelude);
    for (const [name, damaged] of [...nativeWiringCorruptions(source, graph), ...preludeCorruptions(source, graph), ...bindingReplacementCases(source, graph)]) {
      assert.doesNotThrow(() => new vm.Script(damaged), name);
      const failed = inspect(damaged);
      assert.equal(failed.ok, false, name);
      assert.deepEqual(failed.factoryIds, graph.factoryIds, name);
    }
    const host = protectedBindings(source, graph).find(binding => binding.name === classNameAt(source, graph.scope.hostStart));
    const encoded = host.name.slice(0, -1) + "\\u" + host.name.charCodeAt(host.name.length - 1).toString(16).padStart(4, "0");
    for (const inert of [`;const codexBindingNote=${JSON.stringify(host.name + "=class{};" + encoded + "=class{};")};`, `;/* ${encoded}=class{}; */`]) {
      assert.equal(inspect(source.slice(0, host.end) + inert + source.slice(host.end)).ok, true);
    }
    const { applyUnifiedComputerUsePatch } = require("../../../linux-features/computer-use-linux/unified.js");
    const { applyNativeApplicationsPatch } = require("../../../linux-features/computer-use-linux/native-applications.js");
    const { applyPetOverlayPatch } = require("../../../linux-features/pet-overlay/patch.js");
    const lower = applyNativeApplicationsPatch(applyUnifiedComputerUsePatch(applyPetOverlayPatch(source)));
    for (const base of [source, lower]) for (const order of [["state", "wrapper"], ["wrapper", "state"]]) {
      let combined = base;
      for (const name of order) combined = name === "state" ? add(combined, "viewFetch", stateRoute, STATE_HELPER) : add(combined, "wrapperRequest", wrapperRoute, WRAPPER_HELPER);
      const run = nativeFragments(combined);
      const written = await run.request("vscode://codex/foundation-state", { action: "set", key: "owned", value: "scoped" });
      assert.equal(written.response.requestId, written.request.requestId);
      assert.equal(JSON.parse(written.response.bodyJsonString).value, "scoped");
      const reply = await run.request("vscode://codex/foundation-wrapper", { value: "native fragment" });
      assert.equal(reply.response.requestId, reply.request.requestId);
      assert.equal(JSON.parse(reply.response.bodyJsonString).value, "native fragment");
      await assert.rejects(run.request("vscode://codex/foundation-wrapper", {}, { fail: true }), /async bridge failed/u);
      const native = await run.request("/codex/dictation-stream-connect-info");
      assert.equal(native.response.requestId, native.request.requestId);
      const cancel = await run.request("", {}, { type: "cancel-fetch" });
      assert.equal(run.cancelled[0].receiver, run.wrapper); assert.equal(run.cancelled[0].view, cancel.view); assert.equal(run.cancelled[0].request, cancel.request);
      const avatar = await run.request("", {}, { type: "avatar-overlay-open-state-request" });
      assert.equal(avatar.response.type, "avatar-overlay-open-state-changed");
      assert.equal(run.messages.at(-1).view, avatar.view);
      assert.equal(run.originCalls.at(-1).view, avatar.view); assert.equal(run.originCalls.at(-1).receiver, run.viewOwner);
      await assert.rejects(run.request("/unsupported-http"), /HTTP requests must use the HTTP fetch service/u);
      assert.equal(add(combined, "viewFetch", stateRoute, STATE_HELPER), combined);
      assert.equal(add(combined, "wrapperRequest", wrapperRoute, WRAPPER_HELPER), combined);
    }
    for (const candidate of candidates) assert.equal(fs.readFileSync(path.join(inventory.buildDir, candidate.name), "utf8"), candidate.source);
  });
}
