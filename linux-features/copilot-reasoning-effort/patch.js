"use strict";

const path = require("node:path");
const {patchCopilotSlash}=require("./slash-owner.js");
const {patchCopilotDropdown}=require("./dropdown-owner.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {createCopilotEffortPreferences}=require("./effort-preferences.js");
const { inspectModelCatalogOwner, inspectModelSettingsOwner } = require("../../scripts/patches/lib/model-composer-owners.js");
const { createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const {
  findUniqueRspackModuleCopies, patchRspackModuleCopies, rspackModuleFactories, findRspackRequireBinding,
} = require("../../scripts/patches/lib/rspack-module-assets.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const MODEL_LIST_MARKER = "codexLinuxCopilotReasoningEffortModelList";

// rspack chunks have no stable filenames, so every owner is found by content.
const PERSISTENCE_NEEDLES = ["setDefaultModelAndReasoningEffort:", ".setDefaultModelConfig("];
const MODEL_LIST_NEEDLES = ["additionalAvailableModels:", "enabledReasoningEfforts:", "hasConfiguredModelCatalog:", "useHiddenModels:"];
const MODEL_LIST_DESCRIPTION = "Copilot model reasoning effort catalog";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function warn(message, skipDescription) {
  console.warn(`WARN: ${message} - skipping ${skipDescription}`);
}

// --- Copilot default effort persistence ---------------------------------------

const PERSISTENCE_MARKER = "codexLinuxCopilotEffortPreferences";
const PERSISTENCE_IDS=[PERSISTENCE_MARKER,"codexLinuxCopilotEffortSelection","codexLinuxCopilotRequestedEffort"];
const mentionsPersistence=source=>PERSISTENCE_IDS.some(name=>source.includes(name));
const PERSISTENCE_DESCRIPTION = "current Copilot model-and-reasoning settings factory";
const PERSISTENCE_FACTORY = `const ${PERSISTENCE_MARKER}=(${createCopilotEffortPreferences.toString()})(`;

// Reuse the publication checker's syntax-only parameter authority proof. The
// proven initializer binder is renamed only in this private projection; actual
// source/publication qualification remains a separate prerequisite.
function stableCapturedBinding(body,name,binderAt=null) {
  const alias="__copilotEffortBinder",target="__copilotEffortExports",value="__copilotEffortValue";
  if([alias,target,value].some(probe=>body.includes(probe)))return false;
  let projection=body;
  if(binderAt!=null){if(body.slice(binderAt,binderAt+name.length)!==name)return false;
    projection=body.slice(0,binderAt)+alias+body.slice(binderAt+name.length);}
  projection=`${name}.d(${target},{proof:()=>${value}});`+projection;
  return findRspackExportPublication({moduleSource:projection,params:[value,target,name]},"proof")!=null;
}

function settingsPersistenceOwner(source, snapshot) {
  if(snapshot?.params?.some(name=>PERSISTENCE_IDS.includes(name)||name==="globalThis"))throw new Error("Copilot helper collides with factory parameters");
  const module = {...snapshot,moduleSource:source};
  const owner = inspectModelSettingsOwner(module);
  if (!owner.ok) throw new Error(`Unsupported ${PERSISTENCE_DESCRIPTION}: ${owner.reason}`);
  if(!stableCapturedBinding(source,"globalThis"))throw new Error("Copilot runtime global is shadowed or reassigned");
  const lexical = createJavaScriptLexicalIndex(source);
  const region = source.slice(owner.state.body.start,owner.state.body.end);
  const stateLexical=createJavaScriptLexicalIndex(region);
  const ownMatches = regex => [...region.matchAll(regex)].filter(match =>stateLexical.isRoot(match.index));
  const only = (values,label) => {if(values.length!==1)throw new Error(`Missing or ambiguous Copilot ${label}`);return values[0];};
  const auth = only(ownMatches(new RegExp(`(?<copilot>${JS_IDENT})=${escapeRegExp(owner.active.identity.host)}\\?\\.authMethod==="copilot"`,"gu")),"auth binding");
  const readerPattern = new RegExp(`(?<binding>${JS_IDENT})=function\\(\\)\\{let (?<result>${JS_IDENT}),(?<memo>${JS_IDENT})=\\(0,(?<memoApi>${JS_IDENT})\\.${JS_IDENT}\\)\\(3\\),`+
    `(?<defaults>${JS_IDENT})=\\(0,(?<query>${JS_IDENT})\\.${JS_IDENT}\\)\\((?<defaultsApi>${JS_IDENT})\\.${JS_IDENT}\\),`+
    `\\{data:(?<preferences>${JS_IDENT}),isLoading:(?<loading>${JS_IDENT})\\}=\\(0,\\k<query>\\.${JS_IDENT}\\)\\((?<copilotApi>${JS_IDENT})\\.${JS_IDENT}\\),`+
    `(?<model>${JS_IDENT})=\\k<preferences>\\?\\.defaultModel\\?\\?\\k<defaults>\\.defaultModel;return `+
    `\\k<memo>\\[0\\]!==\\k<loading>\\|\\|\\k<memo>\\[1\\]!==\\k<model>\\?`+
    `\\(\\k<result>=\\{model:\\k<model>,reasoningEffort:"medium",profile:null,isLoading:\\k<loading>\\},`+
    `\\k<memo>\\[0\\]=\\k<loading>,\\k<memo>\\[1\\]=\\k<model>,\\k<memo>\\[2\\]=\\k<result>\\):`+
    `\\k<result>=\\k<memo>\\[2\\],\\k<result>\\}\\(\\),`,"gu");
  const reader=only(ownMatches(readerPattern),"native default reader");
  const fallback=source.slice(owner.effectiveSettings.base.fallback.start,owner.effectiveSettings.base.fallback.end);
  const expectedFallback=new RegExp(`^(?<fallback>${JS_IDENT})=${escapeRegExp(auth.groups.copilot)}&&null==(?<managed>${JS_IDENT})\\?${escapeRegExp(reader.groups.binding)}:${escapeRegExp(owner.profile.settings)}$`,"u").exec(fallback);
  if(!expectedFallback)throw new Error("Copilot reader is disconnected from effective settings");
  const catalogRegion=source.slice(owner.profile.reader.body.start,owner.profile.reader.body.end);
  const catalogLexical=createJavaScriptLexicalIndex(catalogRegion);
  const catalog=only([...catalogRegion.matchAll(new RegExp(`let\\{data:${JS_IDENT},isLoading:${JS_IDENT}\\}=\\(0,(?<namespace>${JS_IDENT})\\.(?<exportName>${JS_IDENT})\\)\\(${JS_IDENT}\\)`,"gu"))].filter(match=>catalogLexical.isRoot(match.index)),"model catalog hook");
  if(!stableCapturedBinding(catalogRegion,catalog.groups.namespace))throw new Error("Copilot catalog import is shadowed or reassigned");
  const imports=[reader.groups.memoApi,reader.groups.query,reader.groups.defaultsApi,reader.groups.copilotApi,catalog.groups.namespace];
  if(new Set(imports).size!==imports.length||imports.some(name=>findRspackRequireBinding(module,name)==null))throw new Error("Copilot reader has invalid imports");
  // The native React namespace is the state-level context reader and error UI
  // provider. Its binding is resolved through this factory's loader.
  const react=only(ownMatches(new RegExp(`\\(0,(?<namespace>${JS_IDENT})\\.use\\)\\(${JS_IDENT}\\.${JS_IDENT}\\)`,"gu")),"React context reader").groups.namespace;
  if(!findRspackRequireBinding(module,react))throw new Error("Copilot React namespace has no factory binding");
  for(const name of [react,catalog.groups.namespace]){
    const binding=findRspackRequireBinding(module,name);
    if(!binding||!stableCapturedBinding(source,name,binding.start-(module.start??0)))throw new Error("Copilot hook dependency is reassigned");
  }
  if(!stableCapturedBinding(region,react)||!stableCapturedBinding(region,auth.groups.copilot,auth.index))throw new Error("Copilot context binding is shadowed or reassigned");
  const readerLocals=[reader.groups.result,reader.groups.memo,reader.groups.defaults,reader.groups.preferences,reader.groups.loading,reader.groups.model];
  if(new Set(readerLocals).size!==readerLocals.length||imports.some(name=>readerLocals.includes(name)))throw new Error("Copilot reader import is shadowed");
  const writer=source.slice(owner.default.writer.start,owner.default.writer.end);
  const call=only([...writer.matchAll(new RegExp(`if\\(${escapeRegExp(auth.groups.copilot)}\\)\\{let (?<service>${JS_IDENT})=(?<services>${JS_IDENT})\\.appServices\\?\\.copilot;`+
    `if\\(null==\\k<service>\\)return ${JS_IDENT}\\(Error\\("Copilot is unavailable"\\)\\),!1;return await `+
    `(?<nativeCall>\\(0,(?<unwrap>${JS_IDENT})\\.${JS_IDENT}\\)\\(\\k<service>\\.setDefaultModel\\((?<model>${JS_IDENT})\\)\\)),`+
    `await (?<invalidateCall>\\(0,(?<invalidate>${JS_IDENT})\\.${JS_IDENT}\\)\\(${escapeRegExp(owner.target.store)}\\)),!0\\}`,"gu"))],"native model writer");
  const writerHead=new RegExp(`^[^=]+?=async\\((?<model>${JS_IDENT}),(?<effort>${JS_IDENT}),(?<scope>${JS_IDENT}),(?<tier>${JS_IDENT})\\)=>\\{`).exec(writer);
  if(!writerHead||Object.values(writerHead.groups).some(name=>name===auth.groups.copilot)||writerHead.groups.model!==call.groups.model||
    [call.groups.services,call.groups.unwrap,call.groups.invalidate].some(name=>findRspackRequireBinding(module,name)==null))throw new Error("Copilot writer binding is disconnected");
  const useCall=`${PERSISTENCE_MARKER}.useSelection(${auth.groups.copilot},${owner.active.hostId},${reader.groups.binding})`;
  const readFrom=`?${reader.groups.binding}:${owner.profile.settings}`;
  // Hooks must execute regardless of auth or managed-default branches.
  const hookBinding="codexLinuxCopilotEffortSelection";
  if(mentionsPersistence(source))throw new Error("Orphan Copilot effort persistence marker");
  const edits=[
    {from:reader[0],to:reader[0]+`${hookBinding}=${useCall},`},
    {from:fallback,to:fallback.replace(readFrom,`?${hookBinding}:${owner.profile.settings}`)},
    {from:`return await ${call.groups.nativeCall},await ${call.groups.invalidateCall},!0`,to:`return await ${PERSISTENCE_MARKER}.save(${owner.active.hostId},null,${writerHead.groups.model},codexLinuxCopilotRequestedEffort,async()=>{await ${call.groups.nativeCall};await ${call.groups.invalidateCall}}),!0`},
    {from:writerHead[0],to:writerHead[0]+`let codexLinuxCopilotRequestedEffort=${writerHead.groups.effort};`},
  ];
  for(const edit of edits)if(source.split(edit.from).length!==2)throw new Error("Ambiguous Copilot persistence edit");
  return {owner,edits,helper:PERSISTENCE_FACTORY+`${react},${catalog.groups.namespace}.${catalog.groups.exportName});`};
}

function rewriteSettingsPersistence(source, snapshot) {
  const {edits,helper}=settingsPersistenceOwner(source,snapshot);
  for(const edit of edits)source=source.replace(edit.from,edit.to);
  return source+helper;
}

function settingsPersistenceState(source,snapshot) {
  if(!PERSISTENCE_NEEDLES.every(needle=>source.includes(needle)))return {kind:"missing"};
  try{
    if(!mentionsPersistence(source))return {kind:"current",...settingsPersistenceOwner(source,snapshot)};
    const helperAt=source.lastIndexOf(PERSISTENCE_FACTORY);
    if(helperAt<0)return {kind:"missing"};
    const suffix=source.slice(helperAt+PERSISTENCE_FACTORY.length);
    if(!new RegExp(`^${JS_IDENT},${JS_IDENT}\\.${JS_IDENT}\\);$`,"u").test(suffix))return {kind:"missing"};
    let native=source.slice(0,helperAt);
    const selection=new RegExp(`codexLinuxCopilotEffortSelection=${PERSISTENCE_MARKER}\\.useSelection\\(${JS_IDENT},${JS_IDENT},${JS_IDENT}\\),`,"gu");
    const selections=[...native.matchAll(selection)];if(selections.length!==1)return {kind:"missing"};
    const selected=selections[0][0];const args=selected.slice(selected.indexOf("(")+1,selected.lastIndexOf(")")).split(",");
    native=native.replace(selected,"").replace(`?codexLinuxCopilotEffortSelection:`,`?${args[2]}:`);
    const writes=new RegExp(`return await ${PERSISTENCE_MARKER}\\.save\\(${JS_IDENT},null,${JS_IDENT},codexLinuxCopilotRequestedEffort,async\\(\\)=>\\{await (?<native>\\(0,${JS_IDENT}\\.${JS_IDENT}\\)\\(${JS_IDENT}\\.setDefaultModel\\(${JS_IDENT}\\)\\));await (?<invalidate>\\(0,${JS_IDENT}\\.${JS_IDENT}\\)\\(${JS_IDENT}\\))\\}\\),!0`,"gu");
    const written=[...native.matchAll(writes)];if(written.length!==1)return {kind:"missing"};native=native.replace(written[0][0],`return await ${written[0].groups.native},await ${written[0].groups.invalidate},!0`);
    const aliases=[...native.matchAll(new RegExp(`let codexLinuxCopilotRequestedEffort=${JS_IDENT};`,"gu"))];if(aliases.length!==1)return {kind:"missing"};native=native.replace(aliases[0][0],"");
    const found=settingsPersistenceOwner(native,snapshot);
    return rewriteSettingsPersistence(native,snapshot)===source?{kind:"patched",native,...found}:{kind:"missing"};
  }catch{return {kind:"missing"};}
}

function applyCopilotSettingsPersistence(source,snapshot) {
  const state=settingsPersistenceState(source,snapshot);
  if(state.kind==="patched")return source;
  if(state.kind!=="current")throw new Error("Missing, ambiguous or partial current Copilot persistence factory");
  const patched=rewriteSettingsPersistence(source,snapshot);
  if(settingsPersistenceState(patched,snapshot).kind!=="patched")throw new Error("Copilot persistence failed canonical replay");
  return patched;
}

function patchCopilotSettingsPersistence(extractedDir,_context={},options={}) {
  const assetsDir=path.join(extractedDir,"webview","assets"),markerAssets=new Set();
  const copies=findUniqueRspackModuleCopies(assetsDir,{
    description:PERSISTENCE_DESCRIPTION,
    sourceMatch(source,name){if(mentionsPersistence(source))markerAssets.add(name);return PERSISTENCE_NEEDLES.every(needle=>source.includes(needle));},
    matchModule:(source,snapshot)=>settingsPersistenceState(source,snapshot).kind!=="missing",
  });
  for(const copy of copies){requireModelListRegistry(copy.source);
    const outside=copy.source.slice(0,copy.start)+copy.source.slice(copy.end);
    if(mentionsPersistence(outside))throw new Error("Orphan Copilot persistence marker");
    markerAssets.delete(copy.assetName);
  }
  if(markerAssets.size)throw new Error("Orphan Copilot persistence marker asset");
  return patchRspackModuleCopies(assetsDir,copies,applyCopilotSettingsPersistence,options);
}

// Compatibility exports inspect a complete factory; a nearby ordinary config
// writer can no longer claim that Copilot effort already persists natively.
function matchesCopilotModelAndReasoningPersistenceContract(source,snapshot){return settingsPersistenceState(source,snapshot).kind!=="missing";}
function validateCopilotModelAndReasoningPersistence(source,snapshot){return applyCopilotSettingsPersistence(source,snapshot);}

// --- Model catalog ------------------------------------------------------------

function modelListMarkerCount(source) {
  return source.split(MODEL_LIST_MARKER).length - 1;
}

function identifiesModelList(source) {
  return source.includes(MODEL_LIST_MARKER) || MODEL_LIST_NEEDLES.every(needle => source.includes(needle));
}

function requireModelListRegistry(source) {
  const headers = [...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];
  if (headers.length !== 1) throw new Error(`Missing or ambiguous ${MODEL_LIST_DESCRIPTION} registry`);
  const [header] = headers;
  const prefix = createJavaScriptLexicalIndex(source.slice(0, header.index + header[0].length));
  if (!prefix.isRoot(header.index)) throw new Error(`Opaque or nested ${MODEL_LIST_DESCRIPTION} registry`);
}

function inspectModelList(module) {
  const owner = inspectModelCatalogOwner(module);
  if (!owner.ok) throw new Error(`Unsupported ${MODEL_LIST_DESCRIPTION}: ${owner.reason}`);
  const { sourceEfforts, filteredEfforts, enabledFilter, sourceRange } = owner.normalization;
  const source = module.moduleSource;
  const sourceExpression = source.slice(sourceRange.start, sourceRange.end);
  const effort = new RegExp(`\\.filter\\(\\(\\{reasoningEffort:(${JS_IDENT})\\}\\)=>"ultra"!==\\1\\)$`).exec(sourceExpression)?.[1];
  const captured = [owner.inputs.auth, owner.inputs.ultra, owner.inputs.enabled];
  const outputRange = owner.normalization.outputRange;
  const ifOpen = owner.visibility.call.end + 1;
  if (source.slice(owner.visibility.call.end, sourceRange.start) !== "){let " ||
      owner.visibility.owner.start !== owner.loop.range.end ||
      createJavaScriptLexicalIndex(source).matchingBrace(ifOpen) !== outputRange.end ||
      source.slice(sourceRange.end, enabledFilter.start) !== "," ||
      source.slice(enabledFilter.end, outputRange.start) !== ",") {
    throw new Error(`Unsupported ${MODEL_LIST_DESCRIPTION} normalization flow`);
  }
  if (effort == null || captured.includes(owner.loop.model) ||
      new Set([sourceEfforts, filteredEfforts, owner.normalization.output]).size !== 3 ||
      [sourceEfforts, filteredEfforts, owner.normalization.output].some(name => captured.includes(name) || name === owner.loop.model)) {
    throw new Error(`Unsupported ${MODEL_LIST_DESCRIPTION} effort bindings`);
  }
  // The branch and its inverse use the same current compiler-local effort
  // binding already established by the native ultra filter. A marker alone
  // cannot claim an applied state or choose a different model/auth input.
  const native = `("copilot"===${owner.inputs.auth}?[${sourceEfforts}.find(${effort}=>"medium"===${effort}.reasoningEffort)??{reasoningEffort:"medium",description:"medium effort"}]:${sourceEfforts})`;
  const contribution = `/*${MODEL_LIST_MARKER}*/[...${sourceEfforts}]`;
  const filter = source.slice(enabledFilter.start, enabledFilter.end);
  const prefix = `${filteredEfforts}=`;
  const suffix = filter.slice(filter.lastIndexOf(".filter("));
  const current = prefix + native + suffix;
  const patched = prefix + contribution + suffix;
  const applied = filter === patched && modelListMarkerCount(source) === 1;
  if (!applied && (filter !== current || modelListMarkerCount(source) !== 0)) {
    throw new Error(`Unsupported or noncanonical ${MODEL_LIST_DESCRIPTION} effort filter`);
  }
  if (applied) {
    const inverse = source.slice(0, enabledFilter.start) + current + source.slice(enabledFilter.end);
    if (!inspectModelCatalogOwner({ ...module, moduleSource: inverse }).ok ||
        modelListMarkerCount(inverse) !== 0) throw new Error(`Invalid ${MODEL_LIST_DESCRIPTION} inverse`);
  }
  return { applied, range: enabledFilter, patched };
}

function patchModelListFactory(source, snapshot) {
  const module = { ...snapshot, moduleSource: source };
  const state = inspectModelList(module);
  if (state.applied) return source;
  const patched = source.slice(0, state.range.start) + state.patched + source.slice(state.range.end);
  if (!inspectModelList({ ...module, moduleSource: patched }).applied) {
    throw new Error(`Incomplete ${MODEL_LIST_DESCRIPTION} insertion`);
  }
  return patched;
}

function applyCopilotReasoningEffortModelListPatch(source, context = {}) {
  if (context.factorySnapshot != null) {
    if (context.factorySnapshot.moduleSource !== source) throw new Error("Stale Copilot model catalog factory snapshot");
    return patchModelListFactory(source, context.factorySnapshot);
  }
  requireModelListRegistry(source);
  const candidates = [...rspackModuleFactories(source, "copilot-model-catalog.js")]
    .filter(module => identifiesModelList(module.moduleSource) && inspectModelCatalogOwner(module).ok);
  if (candidates.length !== 1) throw new Error(`Missing or ambiguous ${MODEL_LIST_DESCRIPTION} factory`);
  const [module] = candidates;
  if (modelListMarkerCount(source) !== modelListMarkerCount(module.moduleSource)) {
    throw new Error(`Orphan ${MODEL_LIST_DESCRIPTION} marker`);
  }
  return source.slice(0, module.start) + patchModelListFactory(module.moduleSource, module) + source.slice(module.end);
}

function matchesCopilotReasoningEffortModelListContract(source, context = {}) {
  try { applyCopilotReasoningEffortModelListPatch(source, context); return true; }
  catch { return false; }
}

function applyCopilotReasoningEffortModelListAppPatch(extractedDir, _context = {}, options = {}) {
  const assets = path.join(extractedDir, "webview", "assets"), markerAssets = new Set();
  const copies = findUniqueRspackModuleCopies(assets, {
    description: MODEL_LIST_DESCRIPTION,
    sourceMatch(source, name) {
      if (source.includes(MODEL_LIST_MARKER)) markerAssets.add(name);
      return identifiesModelList(source);
    },
    matchModule: (source, module) => identifiesModelList(source) && inspectModelCatalogOwner(module).ok,
  });
  for (const copy of copies) {
    requireModelListRegistry(copy.source);
    inspectModelList(copy);
    if (modelListMarkerCount(copy.source) !== modelListMarkerCount(copy.moduleSource)) {
      throw new Error(`Orphan ${MODEL_LIST_DESCRIPTION} marker`);
    }
    markerAssets.delete(copy.assetName);
  }
  if (markerAssets.size > 0) throw new Error(`Orphan ${MODEL_LIST_DESCRIPTION} marker in ${[...markerAssets].join(", ")}`);
  return patchRspackModuleCopies(assets, copies, patchModelListFactory, options);
}

module.exports = {
  applyCopilotSettingsPersistence,patchCopilotSettingsPersistence,settingsPersistenceState,
  settingsPersistenceOwner,
  descriptors: [
    {
      id: "persistence-contract",
      name: "copilot-reasoning-effort-persistence-contract",
      phase: "extracted-app:pre-webview",
      apply: patchCopilotSettingsPersistence,
    },
    {
      id: "model-list",
      name: "copilot-reasoning-effort-model-list",
      phase: "extracted-app:pre-webview",
      order: 20570,
      ciPolicy: "optional",
      apply: applyCopilotReasoningEffortModelListAppPatch,
    },
    {
      id: "ui-dropdown",
      name: "copilot-reasoning-effort-ui-dropdown",
      phase: "extracted-app:pre-webview",
      order: 20580,
      ciPolicy: "optional",
      apply: extractedDir=>patchCopilotDropdown(extractedDir,settingsPersistenceState),
    },
    {
      id: "ui-slash-command",
      name: "copilot-reasoning-effort-ui-slash-command",
      phase: "extracted-app:pre-webview",
      order: 20590,
      ciPolicy: "optional",
      apply: extractedDir=>patchCopilotSlash(extractedDir,settingsPersistenceState),
    },
  ],
  applyCopilotReasoningEffortModelListPatch,
  applyCopilotReasoningEffortModelListAppPatch,
  MODEL_LIST_NEEDLES,
  matchesCopilotModelAndReasoningPersistenceContract,
  matchesCopilotReasoningEffortModelListContract,
  validateCopilotModelAndReasoningPersistence,
};
