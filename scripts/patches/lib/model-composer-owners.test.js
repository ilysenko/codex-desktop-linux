"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { inspectModelCatalogOwner, inspectModelSettingsOwner } = require("./model-composer-owners.js");
const current = require("./fixtures/current-model-composer.json");

function snapshot(moduleSource, params = ["module", "exports", "loader"]) {
  return { moduleId: "renamed-owner", moduleSource, params, start: 900, end: 900 + moduleSource.length };
}
function changed(fixture, from, to) {
  assert.ok(fixture.moduleSource.includes(from), `fixture has no ${from}`);
  return { ...fixture, moduleSource: fixture.moduleSource.replace(from, to) };
}
function text(fixture, span) {
  assert.ok(Number.isInteger(span.start) && Number.isInteger(span.end));
  assert.ok(span.start >= 0 && span.end >= span.start && span.end <= fixture.moduleSource.length);
  return fixture.moduleSource.slice(span.start, span.end);
}
function rejects(inspect, fixture, reason) {
  const result = inspect(fixture);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.ok(result.reason, "unsupported owners explain why");
  if (reason) assert.match(result.reason, reason);
}
function catalogFixture() {
  return snapshot('var guard=loader("effort-guard");loader.d(exports,{},{catalog:function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak=!1,authMethod:auth,availableModels:allow,defaultModel:fallback,enabledReasoningEfforts:enabled,hasConfiguredModelCatalog:configured,includeUltraReasoningEffort:ultra,isCustomModelProvider:custom=!1,models:models,useHiddenModels:hidden}){let output=[],defaultModel=null,maximum=!1,ultraFlag=!1;return models.forEach(item=>{if(function({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden}){return !item.hidden}({additionalAvailableModels:extra,apiKeyDaybreakSupported:daybreak,authMethod:auth,availableModels:allow,hasConfiguredModelCatalog:configured,isCustomModelProvider:custom,model:item,useHiddenModels:hidden})){let raw=ultra?item.supportedReasoningEfforts:item.supportedReasoningEfforts.filter(({reasoningEffort:effort})=>"ultra"!==effort),filtered=("copilot"===auth?[raw.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:raw).filter(({reasoningEffort:effort})=>(0,guard.allowed)(effort)&&enabled.has(effort)),normalized={...item,supportedReasoningEfforts:filtered};output.push(normalized),item.isDefault&&(defaultModel=normalized)}}),null==defaultModel&&(defaultModel=output.find(item=>item.model===fallback)??null),{models:output,defaultModel:defaultModel,hasModelSupportingMaxReasoningEffort:maximum,hasModelSupportingUltraReasoningEffort:ultraFlag}}})');
}
function settingsFixture() {
  return snapshot([
    'loader.d(exports,{settings:()=>useSettings});var app=loader("host-service"),target=loader("optimistic"),auth=loader("auth"),context=loader("context"),route=loader("routing"),config=loader("config"),mode=loader("mode"),atoms=loader("atoms");',
    'function writeContext(host,cwd,managed){return host!==route.managed||managed?{hostId:host,cwd:cwd}:{hostId:"local",cwd:null}}',
    'function readSettings(options){return{modelSettings:options.settings}}',
    'function useSettings(conversation){return function(thread,isDraft,draft,wait,fetch){',
    'let registered=!0,reserve=!1,account=!1,store={},ctx=(0,context.read)(thread),active=ctx.hostId;let identity=(0,auth.read)(active),method=identity?.authMethod??null,chatgpt=identity?.authMethod==="chatgpt",cwd=ctx.cwd,managed=!1,writeCtx=writeContext(active,cwd,managed);let{hostId:writeHost,cwd:writeCwd}=writeCtx;',
    'let options={hostId:active,cwd:cwd,isChatGptAuth:chatgpt,isHostRegistered:registered,managedNewThreadModelSettings:draft,draftModelSettings:draft,fetchModelCatalog:fetch,isNewThreadDraft:isDraft,waitForModelFallback:wait};let{modelSettings:saved}=readSettings(options);let ready=!0,has=!0;',
    'let cache=[],selected=null,selectedEffort=null,loading=!1,copilot=!1,managedModel=null,copilotDefaults={},base,effective;let fallback=copilot&&null==managedModel?copilotDefaults:saved;',
    'let targetValue=(0,target.resolve)({conversationId:thread,hasConversation:has,hostId:active,cwd:cwd});let stateTarget=targetValue,pendingSelection=(0,atoms.read)(target.pending,stateTarget),committedSelection=(0,atoms.read)(target.committed,stateTarget);',
    'cache[0]!==saved?(base=has?{model:selected??saved.model,reasoningEffort:null==selected?saved.reasoningEffort:selectedEffort,profile:saved.profile,isLoading:!ready||saved.isLoading&&null==selected}:{...fallback,isLoading:fallback.isLoading||loading||null!=thread},cache[0]=saved,cache[1]=base):base=cache[1];let baseSelection=base,pendingValue=pendingSelection??committedSelection;',
    'cache[2]!==draft||cache[3]!==pendingValue||cache[4]!==stateTarget||cache[5]!==baseSelection?(effective=null==pendingValue||null!=draft?baseSelection:{...baseSelection,...pendingValue,hasPendingThreadSelection:"conversation"===stateTarget[0]},cache[2]=draft,cache[3]=pendingValue,cache[4]=stateTarget,cache[5]=baseSelection,cache[6]=effective):effective=cache[6];let currentSettings=effective;',
    'let RPC=async(model,effort,options)=>null!=thread&&!!ready&&(await (0,app.service)(store,active).updateThreadSettingsForNextTurn(thread,{...options?.threadSettings,model:model,effort:effort,multiAgentMode:mode.default}),!0);let rpc=RPC;',
    'let NEXT=async(model,effort,options)=>{let selectionTarget=(0,target.resolve)({conversationId:thread,hasConversation:has,hostId:active,cwd:cwd}),selection={model:model,reasoningEffort:effort,serviceTier:options?.threadSettings.serviceTier};store.set(target.pending,selectionTarget,selection);await (async()=>{await rpc(model,effort,options)})().finally(()=>{store.get(target.pending,selectionTarget)===selection&&store.set(target.pending,selectionTarget,null)})};let next=NEXT;',
    'let WRITER=async(model,effort,scope,tier)=>{let query=[...config.key,writeHost,writeCwd];let result=await (0,app.service)(store,writeHost).setDefaultModelConfig(model,effort,saved.profile);await (0,app.service)(store,writeHost).clearPrewarmedThreads(),writeHost!==active&&await (0,app.service)(store,active).clearPrewarmedThreads();return result};let writer=WRITER;',
    'let CURRENT=(model,effort,options)=>{let selectionTarget=(0,target.resolve)({conversationId:thread,hasConversation:has,hostId:active,cwd:cwd});let tier=options?.serviceTier;return(0,target.write)(store,selectionTarget,{model:model,reasoningEffort:effort,serviceTier:tier},()=>writer(model,effort,"current",tier))};let current=CURRENT;',
    'let DEFAULT=(model,effort)=>(0,target.write)(store,["default",active,cwd],{model:model,reasoningEffort:effort},()=>writer(model,effort,"default"));let def=DEFAULT;',
    'return {defaultAdvancedModel:saved.model,hasManagedNewThreadSettings:isDraft,hostId:active,isLunaReserveActive:reserve,usesAccountPreferences:account,originalAdvancedModelSettings:draft,setDefaultModelAndReasoningEffort:def,setModelAndReasoningEffortForNextTurn:next,setModelAndReasoningEffort:current,modelSettings:currentSettings}',
    '}(conversation,!1,null,!1,!0)}',
  ].join(""));
}

// The reduced graph deliberately keeps the same native binding relationships,
// without React caches or the feature policies exercised by consumer tests.
const smallCatalog = catalogFixture();
const smallSettings = settingsFixture();

for (const [key, inspect] of [["catalog", inspectModelCatalogOwner], ["settings", inspectModelSettingsOwner]]) {
  test(`${key}: retained current factory is exact and inspected without executing it`, () => {
    const fixture = current[key], original = JSON.stringify(fixture);
    assert.equal(createHash("sha256").update(fixture.moduleSource).digest("hex"), fixture.sha256);
    const result = inspect(fixture);
    assert.equal(result.ok, true, result.reason);
    assert.equal(JSON.stringify(fixture), original);
    assert.deepEqual(inspect(fixture), result);
    assert.equal(inspect({ ...fixture, moduleId: "changed-module-identity", assetName: "elsewhere.js", start: 0 }).ok, true);
    assert.match(text(fixture, result.owner), /^function/);
    assert.equal(text(fixture, result.owner.body), fixture.moduleSource.slice(result.owner.start, result.owner.end).replace(/^function(?: [\w$]+)?\([^)]*\)\{/, "").slice(0, -1));
  });
  test(`${key}: opaque markers, comments, strings and invalid snapshots never qualify an owner`, () => {
    for (const body of ["", "/*codexLinuxApiKeyServiceTierModel*/", 'const marker="codexLinuxModelPickerDefaultPresets";',
      `const example=${JSON.stringify(current[key].moduleSource)};`, `/* ${current[key].moduleSource.replaceAll("*/", "* /")} */`]) {
      rejects(inspect, snapshot(body));
    }
    for (const fixture of [null, {}, { ...current[key], params: ["e", "e", "n"] }, { ...current[key], params: ["e", "t"] }]) rejects(inspect, fixture);
  });
  test(`${key}: duplicate native owners and invalid publications are rejected`, () => {
    rejects(inspect, { ...current[key], moduleSource: current[key].moduleSource + current[key].moduleSource });
    const [, exportsParam, requireParam] = current[key].params;
    rejects(inspect, changed(current[key], `${requireParam}.d(${exportsParam},`, `${requireParam}.d(otherExports,`));
  });
}

test("catalog: reduced renamed owner exposes the same input/loop/output seam", () => {
  const result = inspectModelCatalogOwner(smallCatalog);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.inputs.auth, "auth");
  assert.equal(result.loop.model, "item");
  assert.equal(result.normalization.sourceEfforts, "raw");
  assert.equal(result.normalization.filteredEfforts, "filtered");
  assert.equal(result.normalization.output, "normalized");
  assert.equal(result.normalization.effortPredicate.moduleId, "effort-guard");
  assert.match(text(smallCatalog, result.visibility.call), /model:item,useHiddenModels:hidden/);
  assert.match(text(smallCatalog, result.normalization.outputRange), /^normalized=\{\.\.\.item,supportedReasoningEfforts:filtered/);
});

test("catalog: feature-owned visibility/effort/metadata insertions keep native roles inspectable", () => {
  let fixture = changed(current.catalog, '"amazonBedrock"!==n?', '"amazonBedrock"!==n&&"apikey"!==n/*featureVisibility*/?');
  fixture = changed(fixture, 't=("copilot"===n?[e.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:e).filter(', 't=/*featureEffort*/[...e].filter(');
  fixture = changed(fixture, 'i={...a,supportedReasoningEfforts:t}', 'i={...a,supportedReasoningEfforts:t,featureMarker:"apikey"===n}');
  const result = inspectModelCatalogOwner(fixture);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.normalization.model, "a");
  assert.equal(result.inputs.auth, "n");
});

test("catalog: wrong auth, model, effort, result and imported guard bindings fail closed", () => {
  const cases = [
    ['authMethod:n,availableModels:i,hasConfiguredModelCatalog:o', 'authMethod:other,availableModels:i,hasConfiguredModelCatalog:o'],
    ['i={...a,supportedReasoningEfforts:t}', 'i={...wrongModel,supportedReasoningEfforts:t}'],
    ['i={...a,supportedReasoningEfforts:t}', 'i={...a,supportedReasoningEfforts:wrongEfforts}'],
    ['=>(0,r.eE)(e)&&s.has(e)', '=>(0,missing.eE)(e)&&s.has(e)'],
    ['=>(0,r.eE)(e)&&s.has(e)', '=>(0,r.eE)(e)&&wrongEnabled.has(e)'],
    ['{models:p,defaultModel:h,', '{models:wrongOutput,defaultModel:h,'],
    ['var r=n("FQih")', 'var r=unrelated()'],
    ['t=("copilot"===n?[e.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:e).filter(', 't="e".filter('],
  ];
  for (const [from, to] of cases) rejects(inspectModelCatalogOwner, changed(current.catalog, from, to));
  rejects(inspectModelCatalogOwner, { ...current.catalog, moduleSource: current.catalog.moduleSource + ';r=other;' });
});

test("settings: reduced renamed owner preserves distinct active/write host and profile roles", () => {
  const result = inspectModelSettingsOwner(smallSettings);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.conversation, "thread");
  assert.deepEqual([result.active.hostId, result.active.cwd], ["active", "cwd"]);
  assert.deepEqual([result.write.hostId, result.write.cwd], ["writeHost", "writeCwd"]);
  assert.equal(result.profile.expression, "saved.profile");
  assert.deepEqual([result.effectiveSettings.binding, result.effectiveSettings.reader, result.effectiveSettings.memo], ["currentSettings", "saved", "effective"]);
  assert.equal(result.active.identity.moduleId, "auth");
  assert.equal(result.target.moduleId, "optimistic");
  assert.match(text(smallSettings, result.default.call), /\(store,writeHost\)\.setDefaultModelConfig\(model,effort,saved.profile\)/);
  assert.match(text(smallSettings, result.default.prewarm), /writeHost!==active/);
  assert.match(text(smallSettings, result.nextTurn.rpc), /\(store,active\)\.updateThreadSettingsForNextTurn\(thread,/);
  assert.match(text(smallSettings, result.current.target), /hostId:active,cwd:cwd/);
  assert.match(text(smallSettings, result.nextTurn.optimistic.cleanup), /===selection&&/);
});

test("settings: exact current factory exposes all host/profile/target/RPC links", () => {
  const result = inspectModelSettingsOwner(current.settings);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual([result.active.hostId, result.active.cwd, result.write.hostId, result.write.cwd], ["ec", "eI", "eC", "eP"]);
  assert.equal(result.profile.expression, "eA.profile");
  assert.deepEqual([result.effectiveSettings.binding, result.effectiveSettings.reader, result.effectiveSettings.memo], ["eG", "eA", "k"]);
  assert.equal(result.effectiveSettings.optimistic.target, "eD");
  assert.equal(result.effectiveSettings.optimistic.reader.moduleId, "zTeN");
  assert.equal(result.default.service.moduleId, "Dgwo");
  assert.equal(result.target.moduleId, "Eklu");
  assert.equal(result.default.query.moduleId, "YWOa");
  for (const span of [result.result, result.state, result.write.resolver, result.profile.reader, result.default.setter,
    result.default.writer, result.default.prewarm, result.current.setter, result.nextTurn.setter, result.nextTurn.rpc,
    result.nextTurn.optimistic.value, result.nextTurn.optimistic.write, result.nextTurn.optimistic.cleanup]) text(current.settings, span);
});

test("settings: feature-owned optimistic metadata and cleanup guard do not become shared policy", () => {
  let fixture = changed(current.settings, 'a={model:l,reasoningEffort:t,serviceTier:i?.threadSettings.serviceTier}', 'a={model:l,reasoningEffort:t,serviceTier:i?.threadSettings.serviceTier,featureKeep:!0/*featureMarker*/}');
  fixture = changed(fixture, 'Q.get(C.EX,n)===a&&Q.set(C.EX,n,null)', 'a.featureKeep!==!0&&Q.get(C.EX,n)===a&&Q.set(C.EX,n,null)');
  const result = inspectModelSettingsOwner(fixture);
  assert.equal(result.ok, true, result.reason);
  assert.match(text(fixture, result.nextTurn.optimistic.cleanup), /^Q\.get/);
});

test("settings: wrong host, cwd, profile, writer, target, optimistic and RPC bindings fail closed", () => {
  const cases = [
    ['eh=(0,p.tn)(ec)', 'eh=(0,p.tn)(wrongHost)'],
    ['eI=eu.cwd', 'eI=otherContext.cwd'],
    ['b=er(ec,eI,G)', 'b=er(otherHost,eI,G)'],
    ['{hostId:eC,cwd:eP}=b', '{hostId:eC,cwd:eP}=otherContext'],
    ['.setDefaultModelConfig(e,l,eA.profile)', '.setDefaultModelConfig(e,l,otherSettings.profile)'],
    ['(Q,eC).setDefaultModelConfig', '(Q,ec).setDefaultModelConfig'],
    ['eC!==ec&&await (0,u.V)(Q,ec).clearPrewarmedThreads()', 'eC!==ec&&await (0,u.V)(Q,eC).clearPrewarmedThreads()'],
    ['a=[...m.Od,eC,eP]', 'a=[...m.Od,eC,eI]'],
    ['()=>eJ(e,l,"default")', '()=>otherWriter(e,l,"default")'],
    ['()=>eJ(l,t,"current",a)', '()=>otherWriter(l,t,"current",a)'],
    ['.updateThreadSettingsForNextTurn(e,{', '.updateThreadSettingsForNextTurn(otherConversation,{'],
    ['(Q,ec).updateThreadSettingsForNextTurn', '(Q,eC).updateThreadSettingsForNextTurn'],
    ['Q.get(C.EX,n)===a&&Q.set(C.EX,n,null)', 'Q.get(C.EX,otherTarget)===a&&Q.set(C.EX,n,null)'],
    ['setModelAndReasoningEffort:e$,modelSettings:eG', 'setModelAndReasoningEffort:e0,modelSettings:eG'],
  ];
  for (const [from, to] of cases) rejects(inspectModelSettingsOwner, changed(current.settings, from, to));
  rejects(inspectModelSettingsOwner, changed(current.settings, 'u=t("Dgwo")', 'u=otherService'));
  rejects(inspectModelSettingsOwner, { ...current.settings, moduleSource: current.settings.moduleSource + ';u=other;' });
});


test("catalog: local import shadows, discarded effort input, and discarded return object are rejected", () => {
  for (const [from, to] of [
    ['let p=[],h=null', 'let r=otherNamespace,p=[],h=null'],
    [',t=("copilot"===n?[e.find(e=>"medium"===e.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:e).filter(', ',t=(e,[]).filter('],
    [',{models:p,defaultModel:h,', ',void {models:p,defaultModel:h,'],
  ]) rejects(inspectModelCatalogOwner, changed(current.catalog, from, to));
});

test("settings: callback shadows and reassigned host/writer/RPC roles are rejected", () => {
  for (const [from, to] of [
    ['let n,a=null;try{', 'let u=otherService;let n,a=null;try{'],
    ['let n,a=null;try{', 'let eA={profile:"other"};let n,a=null;try{'],
    ['let n,a=null;try{', 'let n,a=null;try{let eA={profile:"other"};'],
    ['ec=eu.hostId;', 'ec=eu.hostId;ec=otherHost;'],
    ['let eJ=W;', 'let eJ=W;eJ=wrongWriter;'],
    ['let eq=I;', 'let eq=I;eq=wrongRPC;'],
    ['z=async(l,t,i)=>{', 'z=async(l,t,i)=>{let C=otherTarget;'],
  ]) rejects(inspectModelSettingsOwner, changed(current.settings, from, to));
});

// Cross the same inspector seam with the actual feature transforms. These
// source-only checks never execute a factory, hook, RPC, or application.
const { applyApiKeyModelVisibilityPatch } = require("../../../linux-features/api-key-model-visibility/patch.js");
const { applyApiKeyModelMarkerPatch } = require("../../../linux-features/api-key-service-tier/patch.js");
const { applyCopilotReasoningEffortModelListPatch } = require("../../../linux-features/copilot-reasoning-effort/patch.js");
const { applyExistingChatOptimisticPatch } = require("../../../linux-features/model-picker-default-presets/patch.js");
const catalogTransforms = [applyApiKeyModelVisibilityPatch, applyApiKeyModelMarkerPatch, applyCopilotReasoningEffortModelListPatch];
function permutations(values) {
  return values.length === 0 ? [[]] : values.flatMap((value, index) => permutations(values.filter((_, at) => at !== index)).map(tail => [value, ...tail]));
}
for (const transforms of [...catalogTransforms.map(value => [value]), ...permutations(catalogTransforms)]) {
  test(`catalog: native bindings survive production ${transforms.map(fn => fn.name).join(" + ")}`, () => {
    let source = current.catalog.moduleSource;
    for (const transform of transforms) {
      const changed = transform(source, { factorySnapshot: { ...current.catalog, moduleSource: source } });
      assert.notEqual(changed, source, `${transform.name} did not exercise its production insertion`);
      assert.equal(transform(changed, { factorySnapshot: { ...current.catalog, moduleSource: changed } }), changed);
      source = changed;
    }
    const result = inspectModelCatalogOwner({ ...current.catalog, moduleSource: source });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.inputs.auth, "n");
    assert.equal(result.loop.model, "a");
    assert.equal(result.normalization.sourceEfforts, "e");
    assert.equal(result.normalization.filteredEfforts, "t");
    assert.equal(result.normalization.output, "i");
  });
}

test("settings: native bindings survive production existing-chat optimistic insertion", () => {
  const context = { feature: { settings: { presets: [{ model: "gpt-6-astra", effort: "medium", default: true }] } } };
  const source = applyExistingChatOptimisticPatch(current.settings.moduleSource, context);
  assert.notEqual(source, current.settings.moduleSource);
  assert.equal(applyExistingChatOptimisticPatch(source, context), source);
  const result = inspectModelSettingsOwner({ ...current.settings, moduleSource: source });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.profile.expression, "eA.profile");
  assert.deepEqual([result.active.hostId, result.write.hostId], ["ec", "eC"]);
  assert.equal(result.nextTurn.optimistic.selection, "a");
});
test("catalog: complete literal and Unicode direct assignment/update writes cannot replace captured auth", () => {
  const native=inspectModelCatalogOwner(current.catalog);assert(native.ok);
  const name=native.inputs.auth,spelled=[name,"\\u"+name.codePointAt(0).toString(16).padStart(4,"0"),"\\u{"+name.codePointAt(0).toString(16)+"}"];
  const operators=["=","+=","-=","*=","/=","%=","**=","<<=",">>=",">>>=","&=","^=","|=","&&=","||=","??="];
  for(const target of spelled){
    const changes=[...operators.map(operator=>`${target}${operator}1;`),`${target}++;`,`${target}--;`,`++${target};`,`--${target};`,
      `${target}/*owned*/>>>=1;`,`${target}\n>>>=1;`,`[${target}]=foreign;`,`({...${target}}=foreign);`];
    for(const insertion of changes){
      const source=current.catalog.moduleSource.slice(0,native.owner.body.start)+insertion+current.catalog.moduleSource.slice(native.owner.body.start);
      assert.doesNotThrow(()=>new (require("node:vm").Script)(source),insertion);
      const snapshot={...current.catalog,moduleSource:source};assert.equal(inspectModelCatalogOwner(snapshot).ok,false,insertion);
    }
  }
});
test("catalog: auth write census retains complete other identifiers member keys opaque data and postfix boundaries", () => {
  const native=inspectModelCatalogOwner(current.catalog),name=native.inputs.auth;
  const harmless=[`let ${name}Other=0;${name}Other>>>=1;`,`let ${name}λ=0;${name}λ>>>=1;`,
    `let ${name}\\u03bb=0;${name}\\u03bb>>>=1;`,`const harmless={${name}:1};harmless.${name}>>>=1;`,
    `const harmless={${name}};`,`const opaque="\\\\u006e=foreign;n>>>=1";/*n>>>=1*/`,
    `let unrelated=0;unrelated++;\n${name};`,`function localRead(${name}){return ${name}}`];
  for(const insertion of harmless){const source=current.catalog.moduleSource.slice(0,native.owner.body.start)+insertion+current.catalog.moduleSource.slice(native.owner.body.start);
    const result=inspectModelCatalogOwner({...current.catalog,moduleSource:source});assert.equal(result.ok,true,`${insertion}: ${result.reason}`);}
});
test("catalog: original escaped and shift auth witnesses refuse all three production String entrypoints", () => {
  const native=inspectModelCatalogOwner(current.catalog),name=native.inputs.auth;
  for(const insertion of ["\\u"+name.codePointAt(0).toString(16).padStart(4,"0")+'="chatgpt";',name+">>>=0;"]){
    const source=current.catalog.moduleSource.slice(0,native.owner.body.start)+insertion+current.catalog.moduleSource.slice(native.owner.body.start),snapshot={...current.catalog,moduleSource:source};
    for(const transform of catalogTransforms)assert.throws(()=>transform(source,{factorySnapshot:snapshot}),undefined,transform.name+": "+insertion);
  }
});




test("catalog: native return and effort callback binding ownership are required", () => {
  for (const [from, to] of [
    ['return d.forEach(', 'd.forEach('],
    ['({reasoningEffort:e})=>(0,r.eE)(e)&&s.has(e)', '({reasoningEffort:r})=>(0,r.eE)(r)&&s.has(r)'],
    ['({reasoningEffort:e})=>(0,r.eE)(e)&&s.has(e)', '({reasoningEffort:s})=>(0,r.eE)(s)&&s.has(s)'],
  ]) rejects(inspectModelCatalogOwner, changed(current.catalog, from, to));
});

test("settings: published hook and destructured host writes cannot replace native roles", () => {
  rejects(inspectModelSettingsOwner, { ...current.settings, moduleSource: current.settings.moduleSource + ';eg=otherHook;' });
  rejects(inspectModelSettingsOwner, changed(current.settings, 'ec=eu.hostId;', 'ec=eu.hostId;[ec]=[otherHost];'));
  rejects(inspectModelSettingsOwner, changed(current.settings, 'ec=eu.hostId;', 'ec=eu.hostId;({hostId:ec}=otherHost);'));
});


test("publication names never connect a nested native-shaped function to another root function", () => {
  const catalog = inspectModelCatalogOwner(current.catalog);
  const nativeCatalog = text(current.catalog, catalog.owner).replace(/^function/, "function normalize");
  rejects(inspectModelCatalogOwner, snapshot('var r=n("FQih");n.d(t,{catalog:()=>normalize});function normalize(){return null}function unrelated(){' + nativeCatalog + '}', ["e", "t", "n"]));
  const settings = inspectModelSettingsOwner(current.settings);
  const nativeWrapper = text(current.settings, settings.owner);
  const misplaced = current.settings.moduleSource.slice(0, settings.owner.start) +
    'function eg(){return null}function unrelated(){' + nativeWrapper + '}' + current.settings.moduleSource.slice(settings.owner.end);
  rejects(inspectModelSettingsOwner, { ...current.settings, moduleSource: misplaced });
});


test("settings: effective result must follow the local reader/memo/optimistic graph", () => {
  for (const [from, to] of [
    ['setModelAndReasoningEffort:e$,modelSettings:eG', 'setModelAndReasoningEffort:e$,modelSettings:wrongSettings'],
    ['setModelAndReasoningEffort:e$,modelSettings:eG', 'setModelAndReasoningEffort:e$,modelSettings:eT'],
    ['setModelAndReasoningEffort:e$,modelSettings:eG', 'setModelAndReasoningEffort:e$,modelSettings:eA'],
    ['let eG=k;', 'let eG=unrelated;'],
    ['let eQ=S,eV=eR??ez;', 'let eQ=unrelated,eV=eR??ez;'],
    ['eV=eR??ez;', 'eV=unrelated??ez;'],
    ['eR=(0,o._U)(C.EX,eD)', 'eR=(0,o._U)(C.EX,otherTarget)'],
    ['ez=(0,o._U)(C.si,eD)', 'ez=(0,o._U)(C.si,otherTarget)'],
    ['eF=ex&&null==eE?eT:eA', 'eF=ex&&null==eE?eT:unrelated'],
    ['q[54]=k):k=q[54]', 'q[54]=k):k=q[55]'],
    ['let eD=x,eR=', 'x=otherTarget;let eD=x,eR='],
    ['x,M,I,S,k,N,R,z', 'x,M,I,S,N,R,z'],
  ]) rejects(inspectModelSettingsOwner, changed(current.settings, from, to));
  const source = current.settings.moduleSource.replace('let eG=k;', 'let eG=k;let unrelated=eA;').replace('setModelAndReasoningEffort:e$,modelSettings:eG', 'setModelAndReasoningEffort:e$,modelSettings:unrelated');
  rejects(inspectModelSettingsOwner, { ...current.settings, moduleSource: source });
});


test("settings: nested definitions cannot satisfy factory or state root binding roles", () => {
  const result = inspectModelSettingsOwner(current.settings);
  for (const role of [result.write.resolver, result.profile.reader, result.default.writer, result.current.setter, result.nextTurn.setter]) {
    const original = text(current.settings, role);
    const nested = original.startsWith("function") ? `function __unrelated(){${original}}` : `__unrelated=()=>{${original}}`;
    const source = current.settings.moduleSource.slice(0, role.start) + nested + current.settings.moduleSource.slice(role.end);
    rejects(inspectModelSettingsOwner, { ...current.settings, moduleSource: source });
  }
});
