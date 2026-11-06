"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { descriptors, suggestedPromptsAppPageContract: contract, applySuggestedPromptsAppPagePatch: applySource } = require("./patches/suggested-prompts.js");
const { applyToExtractedApp, inspectPage, inspectModule, isCandidate, validateDependencies, entryContext } = require("./patches/suggested-prompts-app-page.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { exportGetter } = require("./patches/suggested-prompts-app-page.js");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const { applyExtractedAppPatchDescriptors, normalizeDescriptor } = require("../../scripts/patches/engine.js");
const { createPatchReport, captureWarnings } = require("../../scripts/lib/patch-report.js");
const descriptor = descriptors.find(({ id }) => id === "home-suggested-prompts-app-page");

const fixtures = require("./fixtures/suggested-prompts-app-page.js");
function fixture() { return fixtures.page; }
function chunk(body, id = "PageOwner") { return fixtures.chunk(body.replace(/^PageOwner(?=\()/u, id)); }

function workspace(t, files) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "codex-desktop-dev");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "suggested-prompts-app-page-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const defaults = { "runtime.js": fixtures.runtime };
  fs.mkdirSync(path.join(root,"webview"),{recursive:true});
  fs.writeFileSync(path.join(root,"webview/index.html"),'<script type="module" src="./assets/runtime.js"></script>');
  for (const [name, source] of Object.entries({ ...defaults, ...files })) {
    const file = path.join(root, "webview/assets", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

let signed;
function signedFixture() {
  if(signed)return signed;
  const official=process.env.CODEX_SIGNED_EXTRACTED_APP,assets=path.join(official,"webview/assets");
  const owners=findUniqueRspackModuleCopies(assets,{sourceMatch:s=>s.includes("onLocalConversationCreated:"),matchModule:isCandidate});
  const entry=entryContext(official),cache=new Map();
  const info=inspectModule(owners[0]);assert.ok(info);
  const roles=validateDependencies(assets,info,cache,entry.entryId),files={};
  for(const module of [...owners,...[...cache.values()].flat()])files[module.assetName]=module.source;
  const index=fs.readFileSync(path.join(official,"webview/index.html"),"utf8");
  for(const match of index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)) {
    const name=/^(?:\.\/|\/)?assets\/([^/?#]+\.js)$/u.exec(match[1])?.[1];
    if(name)files[name]=fs.readFileSync(path.join(assets,name),"utf8");
  }
  signed={owners,info,roles,files,index,entry,dependencies:[...cache.values()].flat()};return signed;
}
function signedWorkspace(t,overrides={}) {
  const fixture=signedFixture(),root=workspace(t,{...fixture.files,...overrides});
  fs.writeFileSync(path.join(root,"webview/index.html"),fixture.index);return root;
}

function evaluate(source) {
  const calls = { gate: [], eligibility: [], navigation: [] }, memo=[];
  const context = vm.createContext({});
  const modules=vm.runInContext(source.replaceAll("export const ","const ")+"\n;__webpack_modules__",context);
  const cache={};
  function load(id) {
    if(cache[id])return cache[id];
    if(id==="JSX")return {jsx:(component,props)=>({component,props})};
    if(id==="Hooks")return {cache:()=>memo,gate:(id)=>{calls.gate.push(id);return false}};
    if(id==="Domain")return {internal:()=>false};
    if(id==="Transition")return {start:()=>true};
    if(id==="Lazy")return {_:(fn)=>({load:fn})};
    if(!modules[id])throw Error("Unknown fixture module "+id);
    const target={};cache[id]=target;modules[id]({},target,load);
    if(id==="Accounts") { const original=target.eligible;Object.defineProperty(target,"eligible",{value:(account)=>{calls.eligibility.push(account);return original(account)}}); }
    return target;
  }
  load.d=(target,getters)=>{for(const[key,get]of Object.entries(getters))Object.defineProperty(target,key,{get,configurable:true,enumerable:true})};
  load("PageOwner");
  return {home:context.home,calls};
}

test("App Home production descriptor uses module-copy validation and remains opt-in", () => {
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  assert.equal(descriptor.enabled({}), false);
  assert.equal(descriptor.enabled({ feature: { settings: { tweaks: { home: { suggestedPrompts: { enabled: true } } } } } }), true);
});

test("App Home preserves rollout/account diagnostics and current project/host/navigation callback", async () => {
  const source = chunk(fixture()), patched = applySource(source);
  const current = evaluate(source), enabled = evaluate(patched);
  const navigated = [];
  const input = { hostId:"host-a",projectRoot:"/project/a",routeEntryKey:"entry-a",email:"a@example.test",navigate:async(...args)=>navigated.push(["a",...args]) };
  assert.equal(current.home(input).props.generatedSuggestionsEnabled,false);
  let rendered=enabled.home(input);assert.equal(rendered.props.generatedSuggestionsEnabled,true);
  assert.equal(rendered.props.hostId,input.hostId);assert.equal(rendered.props.projectRoot,input.projectRoot);
  await rendered.props.onLocalConversationCreated("conversation-a",{entry:"a"},"foreground");
  rendered=enabled.home({...input,hostId:"host-b",projectRoot:"/project/b",routeEntryKey:"entry-b",email:"b@example.test",navigate:async(...args)=>navigated.push(["b",...args])});
  assert.equal(rendered.props.hostId,"host-b");assert.equal(rendered.props.projectRoot,"/project/b");
  await rendered.props.onLocalConversationCreated("conversation-b",{entry:"b"},"foreground");
  assert.deepEqual(navigated.map(row=>[row[0],row[1]]),[["a","/local/conversation-a"],["b","/local/conversation-b"]]);
  assert.deepEqual(enabled.calls.gate,["2425897452","2425897452"]);assert.equal(enabled.calls.eligibility.length,2);
  assert.equal(applySource(patched), patched);
});

test("App Home re-entry does not invoke navigation", () => {
  const {home}=evaluate(applySource(chunk(fixture()))),calls=[];
  const input={hostId:"host",projectRoot:"project",routeEntryKey:"entry",navigate:(...args)=>calls.push(args)};
  const a=home(input),b=home({...input,routeEntryKey:"next"});
  assert.equal(a.props.onLocalConversationCreated,b.props.onLocalConversationCreated);
  assert.deepEqual(calls,[]);
});

test("App Home patches every same-ID module copy atomically and stays idempotent", (t) => {
  const source = chunk(fixture());
  const root = workspace(t, { "async/1.js": source, "nested/2.js": source, "decoy.js": chunk('Other(module,exports,require){const unrelated="2425897452";}') });
  const result = descriptor.apply(root);
  assert.equal(result.moduleId, "PageOwner");
  assert.equal(result.matched, 2);
  assert.equal(result.changed, 2);
  assert.equal(descriptor.apply(root).changed, 0);
  for (const name of ["async/1.js", "nested/2.js"]) {
    const patched = fs.readFileSync(path.join(root, "webview/assets", name), "utf8");
    assert.equal(contract(patched), "patched");
    assert.equal(javascriptSourceParses(patched), true);
  }
});

for (const state of ["missing", "ambiguous", "damaged-copy-with-no-needles", "partial", "mixed"]) {
  test(`App Home rejects ${state} without changing any physical module`, (t) => {
    const source = chunk(fixture()), patched = applySource(source);
    const files = state === "missing" ? { "one.js": fixtures.chunk('Other(module,exports,require){return false}') } : {
      "one.js": source,
      "nested/two.js": state === "damaged-copy-with-no-needles" ? chunk("PageOwner(module,exports,require){return false}") : state === "partial" ? patched.replace("codexLinuxUiTweaksSuggestedPromptsEnabled", "brokenMarker") : state === "mixed" ? patched : state === "ambiguous" ? source.replace("PageOwner(", "OtherOwner(") : source,
    };
    const root = workspace(t, files);
    assert.throws(() => applyToExtractedApp(root), /Could not find|multiple .*identities|Incomplete|Partially applied/);
    for (const [name, expected] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, "webview/assets", name), "utf8"), expected);
  });
}

const corruptions={
  "rollout hidden in unused function":s=>s.replace('rollout=(0,hooks.gate)("2425897452")','rollout=!1;function unused(){return(0,hooks.gate)("2425897452")}'),
  "rollout hidden in string":s=>s.replace('rollout=(0,hooks.gate)("2425897452")',`rollout=!1,decoy='rollout=(0,hooks.gate)("2425897452")'`),
  "wrong gate module":s=>s.replace('(0,hooks.gate)("2425897452")','(0,sdk.eligible)("2425897452")'),
  "unbound gate namespace":s=>s.replace('(0,hooks.gate)("2425897452")','(0,missing.member)("2425897452")'),
  "account predicate removed":s=>s.replace('(0,sdk.eligible)({authMethod:auth,email:email,plan:plan})','false'),
  "wrong page export":s=>s.replace('Z:()=>Entry','Z:()=>Frame'),
  "wrong navigation callback":s=>s.replace('onLocalConversationCreated:callback','onLocalConversationCreated:navigate'),
  "entry returns before page":s=>s.replace('function Entry(e){','function Entry(e){return null;'),
  "entry creates page in unused local then returns null":s=>disconnectedEntry(s,false),
  "entry creates page in unused local then returns unrelated JSX":s=>disconnectedEntry(s,true),
  "frame returns before consumer":s=>s.replace('function Frame(e){','function Frame(e){return null;'),
  "page returns before consumer":s=>s.replace('function Page(e){','function Page(e){return null;'),
  "provider runtime gate bypass":s=>s.replace('generatedSuggestionsEnabled:enabled,hostId:host,isCodexHome:codex','generatedSuggestionsEnabled:generated,hostId:host,isCodexHome:codex'),
  "provider returns before consumer":s=>s.replace('function Content(e){','function Content(e){return null;'),
  "provider fake fields":s=>s.replace(fixtures.content,'NativeHome(module,exports,require){function fake(e){let{generatedSuggestionsEnabled:g,hostId:h,projectRoot:p,routeEntryKey:r}=e;return e}require.d(exports,{HomeAmbientSuggestionsContent:()=>fake})}'),
  "export hidden in arrow":s=>s.replace('require.d(exports,{Z:()=>Entry})','(()=>require.d(exports,{Z:()=>Entry}))'),
  "export hidden in conditional":s=>s.replace('require.d(exports,{Z:()=>Entry})','if(false)require.d(exports,{Z:()=>Entry})'),
  "export hidden in string":s=>s.replace('require.d(exports,{Z:()=>Entry})',`'require.d(exports,{Z:()=>Entry})'`),
  "export receiver suffix":s=>s.replace('require.d(exports,{Z:()=>Entry})','other.require.d(exports,{Z:()=>Entry})'),
};
for(const [name,corrupt]of Object.entries(corruptions)) {
  test(`App Home rejects ${name} before writing`,t=>{
    const source=fixtures.chunk(),damaged=corrupt(source);assert.notEqual(damaged,source);
    const root=workspace(t,{"owner.js":damaged});
    assert.throws(()=>descriptor.apply(root));
    assert.equal(fs.readFileSync(path.join(root,"webview/assets/owner.js"),"utf8"),damaged);
  });
}
for(const id of ["Accounts","Hooks","View","NativeHome"]) {
  test(`App Home rejects damaged same-ID ${id} dependency copy before writing`,t=>{
    const source=fixtures.chunk(),replica=`export const __webpack_modules__={${id}(module,exports,require){return false}};`;
    const root=workspace(t,{"owner.js":source,"replica.js":replica});
    assert.throws(()=>descriptor.apply(root));
    assert.equal(fs.readFileSync(path.join(root,"webview/assets/owner.js"),"utf8"),source);
    assert.equal(fs.readFileSync(path.join(root,"webview/assets/replica.js"),"utf8"),replica);
  });
}

test("signed App Home module is patched through its production descriptor and rejects a marker-free replica", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, (t) => {
  const {owners}=signedFixture();
  assert.equal(owners.length, 1);
  const original = owners[0].source;
  const root = signedWorkspace(t);
  const result = descriptor.apply(root);
  assert.equal(result.changed, 1);
  assert.equal(descriptor.apply(root).changed, 0);
  const target = path.join(root, "webview/assets", owners[0].assetName);
  const patched = fs.readFileSync(target, "utf8");
  assert.equal(contract(patched), "patched");
  assert.equal(javascriptSourceParses(patched), true);
  const owner=owners[0];
  fs.writeFileSync(target, original);
  const replica = `export const __webpack_modules__={${JSON.stringify(owner.moduleId)}(e,t,o){return false}};`;
  fs.writeFileSync(path.join(root, "webview/assets", "damaged-copy.js"), replica);
  assert.throws(() => descriptor.apply(root), /Incomplete/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(fs.readFileSync(path.join(root, "webview/assets", "damaged-copy.js"), "utf8"), replica);
});


test("signed App Home JSX preserves actual project/host/callback bindings across page contexts", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const {owners}=signedFixture();
  assert.equal(owners.length, 1);
  const source = applySource(owners[0].source);
  const objects = [];
  for (const match of source.matchAll(/generatedSuggestionsEnabled:/g)) {
    const start = source.lastIndexOf("{", match.index), end = findMatchingBrace(source, start);
    const object = source.slice(start, end + 1);
    if (object.includes("onLocalConversationCreated:") && object.includes("projectRoot:") && object.includes("routeEntryKey:")) objects.push(object);
  }
  assert.equal(objects.length, 1);
  const [object] = objects;
  const id = "[A-Za-z_$][\\w$]*";
  function alias(key) {
    const found = new RegExp(`${key}:(${id})`).exec(object);
    assert.ok(found, key);
    return found[1];
  }
  const callbacks = [];
  for (const name of ["alpha", "beta"]) {
    const callback = (value) => callbacks.push([name, value]);
    const context = {};
    context[alias("hostId")] = `host-${name}`;
    context[alias("generatedSuggestionsEnabled")] = true;
    context[alias("projectRoot")] = `/project/${name}`;
    context[alias("onLocalConversationCreated")] = callback;
    context[alias("routeEntryKey")] = { key: `entry-${name}` };
    context[alias("isCodexHome")] = true;
    context[alias("plan")] = "free";
    context[alias("topLevelLayout")] = true;
    const props = vm.runInNewContext(`(${object})`, context);
    assert.equal(props.generatedSuggestionsEnabled, true);
    assert.equal(props.hostId, `host-${name}`);
    assert.equal(props.projectRoot, `/project/${name}`);
    assert.equal(props.routeEntryKey, `entry-${name}`);
    assert.equal(props.onLocalConversationCreated, callback);
    props.onLocalConversationCreated(`selected-${name}`);
  }
  assert.deepEqual(callbacks, [["alpha", "selected-alpha"], ["beta", "selected-beta"]]);
});

function nativeFunction(body,name) {
  const start=body.indexOf(`function ${name}(`);assert.ok(start>=0,name);
  const open=body.indexOf("){",start)+1,end=findMatchingBrace(body,open);
  assert.ok(end>open);return body.slice(start,end+1);
}

// Keep the actual entry's prefix, including its native hooks and nested route
// guard. Only disconnect its final returned view from the ordinary Home JSX.
function disconnectedEntry(source,unrelated) {
  const info=inspectPage(source);assert.ok(info);
  const entry=nativeFunction(info.module.moduleSource,info.graph.entry),open=entry.indexOf("){")+1;
  const body=entry.slice(open+1,-1),id="[A-Za-z_$][\\w$]*";
  const returned=[...body.matchAll(/\breturn\b/gu)].filter(match=>
    findMatchingBrace("{"+body.slice(0,match.index)+"}",0)===match.index+1);
  assert.equal(returned.length,1);
  const links=[...body.matchAll(new RegExp(
    `\\(0,(${id})\\.jsx\\)\\(${escapeRegExp(info.graph.middle)},\\{\\.\\.\\.${id},hideHeaderUpgrade:!1,prepareTaskSuggestionDestination:${id}\\}\\)`,"gu"))];
  assert.equal(links.length,1);
  const [link]=links,ending=unrelated?`return(0,${link[1]}.jsx)("div",{children:"unrelated native view"});`:"return null;";
  const replacement=entry.slice(0,open+1+returned[0].index)+`let codexAuditUnusedHome=${link[0]};${ending}}`;
  return source.replace(entry,replacement);
}

function normalPageDescriptor(root) {
  const normalized=normalizeDescriptor({...descriptor,id:"feature:ui-tweaks:home-suggested-prompts-app-page",
    sourceKind:"feature",featureId:"ui-tweaks"});
  const context={feature:{settings:{tweaks:{home:{suggestedPrompts:{enabled:true}}}}}},report=createPatchReport();
  captureWarnings(()=>applyExtractedAppPatchDescriptors(root,[normalized],context,report,normalized.phase));
  return report.patches[0];
}

for(const applied of [false,true])for(const unrelated of [false,true]) {
  test(`signed ordinary Home rejects unused page JSX with ${unrelated?"unrelated JSX":"null"} return in ${applied?"applied":"pristine"} source`,{
    skip:process.env.CODEX_SIGNED_EXTRACTED_APP==null,
  },t=>{
    const {owners,files}=signedFixture(),original=owners[0].source;
    const damaged=disconnectedEntry(applied?applySource(original):original,unrelated);
    assert.equal(javascriptSourceParses(damaged),true);
    assert.equal(contract(damaged),"drifted");
    const root=signedWorkspace(t,{[owners[0].assetName]:damaged});
    const names=["webview/index.html",...Object.keys(files).map(name=>"webview/assets/"+name)];
    const before=new Map(names.map(name=>[name,fs.readFileSync(path.join(root,name))]));
    const report=normalPageDescriptor(root);
    assert.equal(report.status,"skipped-optional");assert.match(report.reason,/Incomplete ordinary Home page contract/);
    for(const [name,bytes]of before)assert.deepEqual(fs.readFileSync(path.join(root,name)),bytes,name);
  });
}

test("signed native rollout hook and account predicate retain their independent roles",{
  skip:process.env.CODEX_SIGNED_EXTRACTED_APP==null,
},()=>{
  const {roles,dependencies,entry}=signedFixture();
  let gateValue=false,internal=false;
  const memo=[],reads=[],namespace=new Proxy({}, {get:(_target,key)=>({
    c:()=>memo,createContext:()=>({}),useContext:()=>{},Ul:selection=>{reads.push(selection);return gateValue},
    JW:{scope:{},resolve:()=>({atom:gateValue})},
  })[key]??(()=>internal)});
  function execute(target) {
    const module=dependencies.find(m=>m.moduleId===target.moduleId);assert.ok(module);
    const requireStub=()=>namespace;requireStub.j=entry.entryId;
    requireStub.d=(exports,getters,values={})=>{for(const[key,get]of Object.entries(getters))Object.defineProperty(exports,key,{get});Object.assign(exports,values)};
    const expression = target.exportName == null ? target.functionName : `${module.params[1]}[${JSON.stringify(target.exportName)}]`;
    return vm.runInNewContext(`(function(${module.params.join(",")}){${module.moduleSource};return ${expression}})`,{} )({}, {},requireStub);
  }
  const gate=execute(roles.rolloutTargets[0]),account=execute(roles.accountTargets[0]);
  assert.equal(gate("2425897452"),false);gateValue=true;assert.equal(gate("2425897452"),true);assert.equal(reads.length,2);
  assert.equal(account({authMethod:"apikey",email:"",plan:"free"}),true);
  assert.equal(account({authMethod:"chatgpt",email:"external@example.test",plan:"free"}),false);
  assert.equal(account({authMethod:"chatgpt",email:"external@example.test",plan:"plus"}),true);
  internal=true;assert.equal(account({authMethod:"chatgpt",email:"internal@example.test",plan:"free"}),true);
});

test("signed page export and dependency roles reject executable decoys and swapped callbacks",{
  skip:process.env.CODEX_SIGNED_EXTRACTED_APP==null,
},t=>{
  const {owners,info}=signedFixture(),original=owners[0].source;
  const gate=`${info.rollout}=(0,${info.rolloutCall.namespace}.${info.rolloutCall.member})("2425897452")`;
  const variants=[
    original.replace(gate,`${info.rollout}=!1;function unused(){return(0,${info.rolloutCall.namespace}.${info.rolloutCall.member})("2425897452")}`),
    original.replace(gate,`${info.rollout}=!1,unused='${gate}'`),
    original.replace(gate,`${info.rollout}=(0,${info.accountCall.namespace}.${info.accountCall.member})("2425897452")`),
    original.replace(gate,`${info.rollout}=(0,missing.member)("2425897452")`),
    original.replace(`Z:()=>${info.graph.entry}`,`Z:()=>${info.graph.middle}`),
    original.replace(`onLocalConversationCreated:${info.fields.onLocalConversationCreated}`,`onLocalConversationCreated:${info.fields.projectRoot}`),
    ...[info.graph.entry,info.graph.middle,info.graph.leaf].map(name=>original.replace(`function ${name}(e){`,`function ${name}(e){return null;`)),
  ];
  for(const damaged of variants) {
    assert.notEqual(damaged,original);
    const root=signedWorkspace(t,{[owners[0].assetName]:damaged});
    assert.throws(()=>descriptor.apply(root));
    assert.equal(fs.readFileSync(path.join(root,"webview/assets",owners[0].assetName),"utf8"),damaged);
  }
});

test("signed native provider keeps runtime-off gating and current host/project through re-entry",{
  skip:process.env.CODEX_SIGNED_EXTRACTED_APP==null,
},()=>{
  const {dependencies,roles}=signedFixture();
  const provider=dependencies.find(m=>m.moduleId===roles.providerModule);assert.ok(provider);
  const name=exportGetter(provider,roles.providerExport).expression,source=nativeFunction(provider.moduleSource,name);
  const memo=[],queries=[],effects=[],jsx=[];
  let runtime=false;
  const methods={
    c:()=>memo,a:()=>({modelSettings:{model:"test-model"}}),Ym:()=>({data:{models:[]}}),s4m:()=>"test-domain",r9:()=>"codex",O$:"work",
    Ul:()=>({status:runtime?"enabled":"disabled"}),gh:()=>({query:{fetch:(key,context)=>{queries.push(context);return Promise.resolve()}}}),
    useEffect:(effect)=>{effects.push(effect);effect()},useEffectEvent:effect=>effect,
    AS:()=>({getDynamicConfig:()=>({value:{}})}),w:()=>null,
    jsx:(component,props)=>{const node={component,props};jsx.push(node);return node},
  };
  const inert=new Proxy(()=>undefined,{get:(_target,key)=>methods[key]??inert});
  const globals=Object.fromEntries([...new Set(source.match(/\b[A-Za-z_$][\w$]*\b/gu))].map(key=>[key,inert]));
  function render(host,project,entry,callback) {
    globals.input={generatedSuggestionsEnabled:true,hostId:host,isCodexHome:true,onLocalConversationCreated:callback,plan:"free",projectRoot:project,routeEntryKey:entry};
    return vm.runInNewContext(`(${source})(input)`,globals);
  }
  const callbackA=()=>{},callbackB=()=>{};
  let result=render("alpha","/alpha","entry-a",callbackA);
  assert.equal(result.props.generatedSuggestionsEnabled,false);assert.equal(queries.length,0);
  runtime=true;
  result=render("alpha","/alpha","entry-a",callbackA);
  assert.equal(result.props.generatedSuggestionsEnabled,true);assert.equal(result.props.onLocalConversationCreated,callbackA);
  result=render("beta","/beta","entry-b",callbackB);
  assert.equal(result.props.hostId,"beta");assert.equal(result.props.projectRoot,"/beta");assert.equal(result.props.onLocalConversationCreated,callbackB);
  assert.deepEqual(queries.map(({hostId,projectRoot})=>[hostId,projectRoot]),[["alpha","/alpha"],["beta","/beta"]]);
  runtime=false;result=render("beta",null,"entry-c",callbackB);
  assert.equal(result.props.generatedSuggestionsEnabled,false);assert.equal(queries.length,2);
});

test("signed native navigation retains current draft context and preview transitions",{
  skip:process.env.CODEX_SIGNED_EXTRACTED_APP==null,
},async()=>{
  const {info}=signedFixture(),body=info.component.body;
  const assignment=`${info.navigation.callback}=async(`,start=body.indexOf(assignment);assert.ok(start>=0);
  const open=body.indexOf("{",start),end=findMatchingBrace(body,open),source=body.slice(start+info.navigation.callback.length+1,end+1);
  const route=/let (?<destination>[\w$]+)=(?<cloud>[\w$]+)\?\(0,(?<namespace>[\w$]+)\.(?<cloudMethod>[\w$]+)\)\((?<id>[\w$]+)\):\(0,\k<namespace>\.(?<localMethod>[\w$]+)\)\(\k<id>\),(?<transition>[\w$]+)="new"===(?<scope>[\w$]+)\.value\.kind&&"preview"===\k<scope>\.value\.entrypoint&&\(0,(?<previewNamespace>[\w$]+)\.(?<previewMethod>[\w$]+)\)\(\k<scope>,\k<destination>,(?<draft>[\w$]+)\);await (?<navigate>[\w$]+)\(\k<destination>,/u.exec(source)?.groups;
  assert.ok(route);
  const section=/null!=([\w$]+)&&/u.exec(source)?.[1];assert.ok(section);
  const reset=/\(0,([\w$]+)\.([\w$]+)\)\([\w$]+,\{conversationId:[\w$]+,draftThreadLocationId:/u.exec(source);assert.ok(reset);
  const pass=new Proxy(()=>true,{get:()=>pass}),globals=Object.fromEntries([...new Set(source.match(/\b[A-Za-z_$][\w$]*\b/gu))].map(key=>[key,pass]));
  const navigations=[],resets=[],previews=[];
  globals[section]=null;
  globals[route.namespace]=new Proxy({}, {get:(_target,key)=>id=>`${key===route.cloudMethod?"cloud":"local"}/${id}`});
  globals[route.navigate]=async(...args)=>navigations.push(args);
  globals[route.previewNamespace]={[route.previewMethod]:(...args)=>{previews.push(args);return true}};
  globals[reset[1]]=new Proxy({}, {get:(_target,key)=>key===reset[2]?(_scope,context)=>resets.push(context):()=>false});
  for(const [kind,entrypoint] of [["new","preview"],["new","standard"],["existing","preview"]]) {
    for(const cloud of [false,true]) {
      const id=`${kind}-${entrypoint}-${cloud}`,location=`draft-${id}`;
      globals[route.scope]={value:{kind,entrypoint,clientThreadId:"current-client"},set:()=>{},get:()=>"background-other"};
      globals[route.draft]=location;globals[route.cloud]=cloud;
      const before=previews.length,callback=vm.runInNewContext(`(${source})`,globals);
      await callback(id,{entry:location},"foreground");
      const [destination,options]=navigations.at(-1),expectedPreview=kind==="new"&&entrypoint==="preview";
      assert.equal(destination,`${cloud?"cloud":"local"}/${id}`);
      assert.equal(options.replace,true);assert.equal(options.state.entry,location);assert.equal(options.state.preserveSidebarScroll,true);
      assert.equal(options.viewTransition,expectedPreview);
      assert.equal(previews.length,before+Number(expectedPreview));
      if(expectedPreview)assert.deepEqual(previews.at(-1),[globals[route.scope],destination,location]);
      assert.equal(resets.at(-1).conversationId,id);assert.equal(resets.at(-1).draftThreadLocationId,location);
    }
  }
  const callback=vm.runInNewContext(`(${source})`,globals);await callback("background-skipped",{},"background");
  assert.equal(navigations.length,6);
});

test("ordinary Home edits only its proved owner ranges across long memo regions and sibling aliases", () => {
  const long=fixture().replace("enabled=rollout&&eligible;return", "enabled=rollout&&eligible;"+"void 0;".repeat(250)+"return");
  assert.notEqual(long,fixture());
  const sibling='Sibling(module,exports,require){let enabled=rollout&&eligible;return {generatedSuggestionsEnabled:enabled}}';
  const source=fixtures.chunk(long,sibling),patched=applySource(source);
  assert.equal(contract(source),"current");assert.equal(contract(patched),"patched");
  assert.ok(patched.includes(sibling));assert.equal(applySource(patched),patched);
});

for(const field of ["viewTransition:transition",'"preview"===scope.value.entrypoint']) {
  test(`ordinary Home rejects changed native preview binding ${field}`, t => {
    const source=chunk(fixture()),damaged=source.replace(field,field==="viewTransition:transition"?"viewTransition:other":'"preview"===other.value.entrypoint');
    assert.notEqual(damaged,source);
    const root=workspace(t,{"async/owner.js":damaged}),file=path.join(root,"webview/assets/async/owner.js");
    assert.throws(()=>descriptor.apply(root));assert.equal(fs.readFileSync(file,"utf8"),damaged);
  });
}
