"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { inspectMainRequestSites: inspect } = require("./main-request-sites.js");
const { findMainProcessChunks } = require("./assets.js");
const { findMatchingBrace } = require("./minified-js.js");

const { graphBody, fixture } = require("./fixtures/main-request-graph.js");

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
function runtime(source) {
  const exports = {}, context = vm.createContext({ exports, Error, JSON, Promise });
  vm.runInContext(source, context);
  const module = { exports: {} }, load = () => { throw Error("unexpected import"); };
  load.d = (target, getters) => { for (const [name, get] of Object.entries(getters)) Object.defineProperty(target, name, { get }); };
  exports.modules[82820](module, module.exports, load);
  const messages = [], cancelled = [], values = new Map(), sender = { sendInlineMessageForView(view, message) { assert.equal(this, sender); messages.push({ view, message }); } };
  const state = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const host = module.exports.runMainAppStartup({ globalState: state, chunkedMessageSender: sender, cancelled });
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

for (const envName of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  test(`actual signed main graph and precise corruption rejection (${envName})`, { skip: process.env[envName] == null }, () => {
    const app = process.env[envName], inventory = findMainProcessChunks(app); assert.ok(inventory);
    const candidates = inventory.chunks.map(name => ({ name, source: fs.readFileSync(path.join(inventory.buildDir, name), "utf8") }))
      .filter(({ source }) => source.includes("HTTP requests must use the HTTP fetch service.") && source.includes("this.fetchWrapper.handleRequest("));
    const owners = candidates.map(candidate => ({ ...candidate, graph: inspect(candidate.source) })).filter(({ graph }) => graph.ok);
    assert.equal(owners.length, 1); const { source, graph } = owners[0];
    assert.deepEqual(inspect(source), graph); assert.equal(graph.viewFetch.globalStateExpr, "this.globalState");
    const mutations = [
      text => text.replace("this.scopedState=e.globalState", "this.scopedState=e.appGlobalState"),
      text => text.replace("chunkedMessageSender:e.chunkedMessageSender,pluginServicePreviewEnabled", "chunkedMessageSender:e.otherSender,pluginServicePreviewEnabled"),
      text => text.replace("e.windowManager,e.chunkedMessageSender,e.avatarOverlayManager,this.appServerConnectionRegistry,this.fetchWrapper,this.scopedState", "e.windowManager,e.otherSender,e.avatarOverlayManager,this.appServerConnectionRegistry,this.fetchWrapper,this.scopedState"),
      text => text.replace("this.fetchWrapper,this.scopedState,this.projectsManager", "this.fetchWrapper,this.otherState,this.projectsManager"),
      text => text.replace("this.messageHandler=new ee9", "this.unused=()=>this.messageHandler=new ee9"),
      text => text.replace("async handleRequest(e,t){if(\"/codex/dictation-stream-connect-info\"", "async unusedHandleRequest(e,t){if(\"/codex/dictation-stream-connect-info\""),
      text => text.replace("await this.fetchWrapper.handleRequest(e,t);break;case\"cancel-fetch\":", "await this.other.handleRequest(e,t);break;case\"cancel-fetch\":"),
      text => text.replace("r.d(t,{runMainAppStartup:()=>eE0})", "r.d(J,{runMainAppStartup:()=>eE0})"),
      text => text.replace("}}({app:ea.app,applicationNetwork:W,quitState:e4", "}};let codexUnusedOptions=({app:ea.app,applicationNetwork:W,quitState:e4"),
      text => text.replace("q=new e_3({appViewsByWebContentsId", "codexUnused=()=>q=new e_3({appViewsByWebContentsId"),
      text => text.replace("async handleDictationStreamConnectInfoRequest(e,t){try", "async handleDictationStreamConnectInfoRequest(e,t){return;try"),
      text => unusedExpression(text, "class Ra{"),
      text => unusedExpression(text, "async function eE0("),
      text => reassignedDeclaration(text, "class Ra{", "Ra"),
      text => reassignedDeclaration(text, "async function eE0(", "eE0"),
      text => text.replace("chunkedMessageSender:e.chunkedMessageSender,pluginServicePreviewEnabled", "chunkedMessageSender:e.chunkedMessageSender,...{chunkedMessageSender:e.otherSender},pluginServicePreviewEnabled"),
      text => text.replace("chunkedMessageSender:e.chunkedMessageSender,pluginServicePreviewEnabled", 'chunkedMessageSender:e.chunkedMessageSender,"chunkedMessageSender":e.otherSender,pluginServicePreviewEnabled'),
    ];
    for (const mutate of mutations) {
      const damaged = mutate(source); assert.notEqual(damaged, source);
      assert.doesNotThrow(() => new vm.Script(damaged), "native counterexample remains valid JavaScript");
      assert.equal(inspect(damaged).ok, false);
    }
    let combined = add(source, "viewFetch", stateRoute, STATE_HELPER); combined = add(combined, "wrapperRequest", wrapperRoute, WRAPPER_HELPER);
    assert.equal(inspect(combined).ok, true); assert.equal(add(combined, "viewFetch", stateRoute, STATE_HELPER), combined);
    for (const key of ["viewFetch", "wrapperRequest"]) {
      const site = graph[key], render = key === "viewFetch" ? stateRoute : wrapperRoute;
      const normal = render(site), shadow = normal.replace(`reply=>${site.senderExpr}(${site.webContentsVar},reply)`, `${site.webContentsVar}=>${site.senderExpr}(${site.webContentsVar},${site.webContentsVar})`);
      assert.notEqual(shadow, normal); const damaged = source.slice(0, site.insertAt) + shadow + source.slice(site.insertAt);
      assert.doesNotThrow(() => new vm.Script(damaged)); assert.equal(inspect(damaged).ok, false);
    }
  });
}
