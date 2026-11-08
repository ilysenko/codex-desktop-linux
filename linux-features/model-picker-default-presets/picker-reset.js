"use strict";
const path=require("node:path");
const {requireStableCatalogBinding:requireOriginalBinding}=require("./catalog-binding-authority.js");
const {Script}=require("node:vm");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding,findUniqueRspackModuleCopies,patchRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const ID="[A-Za-z_$][\\w$]*";
const NEEDLES=["resetContextKey:","powerSelectionsWithXHigh:","useEffectEvent","show_xhigh_in_simple_picker"];
const DESCRIPTION="current Default picker reset-effect factory";

// A closed native grammar connects the current props, experiment, filtered
// selections, memoized fallback, reset context, latest callback and effect.
// No source is evaluated, and no marker can supply missing native authority.
function nativeResetOwner(source,module) {
 if(Buffer.byteLength(source)>256*1024||!module||module.params?.length!==3||new Set(module.params).size!==3||!NEEDLES.every(n=>source.includes(n)))return null;
 const [argument,exportsName,requireName]=module.params;
 if(module.params.some(name=>!new RegExp(`^${ID}$`,"u").test(name)))return null;
 const req=escapeRegExp(requireName),exp=escapeRegExp(exportsName),importValue=String.raw`${req}\((?:"(?:\\.|[^"\\])*"|\d+)\)`;
 const pattern=new RegExp([
 String.raw`^var (?<memoApi>${ID})=${importValue},(?<react>${ID})=${importValue},(?<experiments>${ID})=${importValue},(?<resolver>${ID})=${importValue};`,
 String.raw`function (?<withoutXHigh>${ID})\((?<filterInput>${ID})\)\{let\{reasoningEffort:(?<filterEffort>${ID})\}=\k<filterInput>;return"xhigh"!==\k<filterEffort>\}`,
 String.raw`${req}\.d\(${exp},\{\},\{(?<exportName>${ID}):function\((?<input>${ID})\)\{let (?<filteredCache>${ID}),(?<canInitializeCache>${ID}),(?<selectionsCache>${ID}),(?<showXHighCache>${ID}),(?<selectionCache>${ID}),(?<callbackCache>${ID}),(?<effectCache>${ID}),(?<dependenciesCache>${ID}),(?<memo>${ID})=\(0,\k<memoApi>\.${ID}\)\(28\),`,
 String.raw`\{canRenderPowerPickerSurface:(?<canRender>${ID}),fallbackPowerSelection:(?<fallback>${ID}),isModelSettingsLoading:(?<loading>${ID}),menuView:(?<menu>${ID}),onReset:(?<onReset>${ID}),powerSelectionsWithXHigh:(?<selections>${ID}),resetContextKey:(?<resetContext>${ID}),selectedPowerSelectionWithXHigh:(?<selected>${ID}),skipExperimentExposure:(?<skipExposure>${ID})\}=\k<input>,(?<experiment>${ID})=\(0,\k<experiments>\.${ID}\)\("(?<experimentId>[0-9]+)"\);`,
 String.raw`\k<memo>\[0\]!==\k<selections>\?\(\k<filteredCache>=\k<selections>\.filter\(\k<withoutXHigh>\),\k<memo>\[0\]=\k<selections>,\k<memo>\[1\]=\k<filteredCache>\):\k<filteredCache>=\k<memo>\[1\];let (?<filtered>${ID})=\k<filteredCache>,(?<expose>${ID})=\k<canRender>&&!\k<skipExposure>&&\k<filtered>\.length>=3&&null!=\k<selected>&&null!=\k<fallback>&&\("xhigh"!==\k<selected>\.reasoningEffort\|\|\k<fallback>\.id!==\k<selected>\.id\)&&"simple"===\k<menu>;`,
 String.raw`\k<memo>\[2\]!==\k<canRender>\|\|\k<memo>\[3\]!==\k<fallback>\|\|\k<memo>\[4\]!==\k<menu>\|\|\k<memo>\[5\]!==\k<experiment>\|\|\k<memo>\[6\]!==\k<selections>\|\|\k<memo>\[7\]!==\k<filtered>\|\|\k<memo>\[8\]!==\k<selected>\|\|\k<memo>\[9\]!==\k<expose>\?`,
 String.raw`\(\k<selectionsCache>=\(\k<showXHighCache>=!\k<expose>\|\|\k<experiment>\.get\("show_xhigh_in_simple_picker",!0\)\)\?\k<selections>:\k<filtered>,\k<canInitializeCache>=\k<canRender>&&\k<selectionsCache>\.length>=3,\k<selectionCache>=\(0,\k<resolver>\.(?<resolveExport>${ID})\)\(\{canInitializePowerPicker:\k<canInitializeCache>,fallbackPowerSelection:\k<fallback>,menuView:\k<menu>,selectedPowerSelection:\k<selected>,showXHighInSimplePicker:\k<showXHighCache>\}\),`,
 String.raw`\k<memo>\[2\]=\k<canRender>,\k<memo>\[3\]=\k<fallback>,\k<memo>\[4\]=\k<menu>,\k<memo>\[5\]=\k<experiment>,\k<memo>\[6\]=\k<selections>,\k<memo>\[7\]=\k<filtered>,\k<memo>\[8\]=\k<selected>,\k<memo>\[9\]=\k<expose>,\k<memo>\[10\]=\k<canInitializeCache>,\k<memo>\[11\]=\k<selectionsCache>,\k<memo>\[12\]=\k<showXHighCache>,\k<memo>\[13\]=\k<selectionCache>\):\(\k<canInitializeCache>=\k<memo>\[10\],\k<selectionsCache>=\k<memo>\[11\],\k<showXHighCache>=\k<memo>\[12\],\k<selectionCache>=\k<memo>\[13\]\);`,
 String.raw`let (?<selection>${ID})=\k<selectionCache>,(?<resetRef>${ID})=\(0,\k<react>\.useRef\)\(null\),(?<selectedId>${ID})=\k<selection>\?\.id\?\?null,(?<scope>${ID})=null==\k<selectedId>\?null:\x60\$\{\k<resetContext>\}:\$\{\k<selectedId>\}\x60,(?<active>${ID})=!\k<showXHighCache>&&\k<canInitializeCache>&&"simple"===\k<menu>;`,
 String.raw`\k<memo>\[14\]!==\k<selection>\|\|\k<memo>\[15\]!==\k<onReset>\?\(\k<callbackCache>=(?<callbackInput>${ID})=>\{\k<selection>\?\.id===\k<callbackInput>&&\k<onReset>\(\k<selection>\)\},\k<memo>\[14\]=\k<selection>,\k<memo>\[15\]=\k<onReset>,\k<memo>\[16\]=\k<callbackCache>\):\k<callbackCache>=\k<memo>\[16\];let (?<event>${ID})=\(0,\k<react>\.useEffectEvent\)\(\k<callbackCache>\);`,
 String.raw`return \k<memo>\[17\]!==\k<selectedId>\|\|\k<memo>\[18\]!==\k<scope>\|\|\k<memo>\[19\]!==\k<active>\|\|\k<memo>\[20\]!==\k<loading>\|\|\k<memo>\[21\]!==\k<event>\?\(\k<effectCache>=\(\)=>\{if\(!\k<loading>\)\{if\(!\k<active>\)\{\k<resetRef>\.current=null;return\}null!=\k<selectedId>&&null!=\k<scope>&&\k<resetRef>\.current!==\k<scope>&&\(\k<resetRef>\.current=\k<scope>,\k<event>\(\k<selectedId>\)\)\}\},`,
 String.raw`\k<memo>\[17\]=\k<selectedId>,\k<memo>\[18\]=\k<scope>,\k<memo>\[19\]=\k<active>,\k<memo>\[20\]=\k<loading>,\k<memo>\[21\]=\k<event>,\k<memo>\[22\]=\k<effectCache>\):\k<effectCache>=\k<memo>\[22\],`,
 String.raw`\k<memo>\[23\]!==\k<selectedId>\|\|\k<memo>\[24\]!==\k<scope>\|\|\k<memo>\[25\]!==\k<active>\|\|\k<memo>\[26\]!==\k<loading>\?\(\k<dependenciesCache>=\[\k<selectedId>,\k<scope>,\k<active>,\k<loading>\],\k<memo>\[23\]=\k<selectedId>,\k<memo>\[24\]=\k<scope>,\k<memo>\[25\]=\k<active>,\k<memo>\[26\]=\k<loading>,\k<memo>\[27\]=\k<dependenciesCache>\):\k<dependenciesCache>=\k<memo>\[27\],\(0,\k<react>\.useEffect\)\(\k<effectCache>,\k<dependenciesCache>\),\k<selectionsCache>\}\}\);?$`,
 ].join(""),"u");
 const match=pattern.exec(source);if(!match)return null;const g=match.groups;
 const imports=[g.memoApi,g.react,g.experiments,g.resolver],roots=[...imports,g.withoutXHigh];
 const locals=[g.input,g.filteredCache,g.canInitializeCache,g.selectionsCache,g.showXHighCache,g.selectionCache,g.callbackCache,g.effectCache,g.dependenciesCache,g.memo,g.canRender,g.fallback,g.loading,g.menu,g.onReset,g.selections,g.resetContext,g.selected,g.skipExposure,g.experiment,g.filtered,g.expose,g.selection,g.resetRef,g.selectedId,g.scope,g.active,g.event];
 if(new Set(roots).size!==roots.length||roots.some(name=>module.params.includes(name))||new Set(locals).size!==locals.length||locals.some(name=>imports.includes(name)||name===g.withoutXHigh)||[g.selection,g.onReset].includes(g.callbackInput)||g.filterInput===g.filterEffort)return null;
 const snapshot={...module,start:module.start??0,moduleSource:source};const bindings=imports.map(name=>findRspackRequireBinding(snapshot,name));if(bindings.some(b=>!b))return null;
 const publication=findRspackExportPublication(snapshot,g.exportName);if(publication?.fn==null)return null;
 try{new Script(`"use strict";(function(${module.params.join(",")}){${source}})`);}catch{return null;}
 return{groups:g,publication,imports:bindings};
}

const SLIDER_MARKER="codex-linux-model-picker-default-presets-slider-minimum";
function sliderContribution(ids){return `/*${SLIDER_MARKER}*/let codexLinuxDefaultPresetIds=new Set(${JSON.stringify(ids)}),codexLinuxDefaultPresetMinimum=codexLinuxSelections=>codexLinuxSelections.every(codexLinuxSelection=>codexLinuxDefaultPresetIds.has(codexLinuxSelection.id))?2:3;`;}
function sliderNative(source,module,ids){
 const helper=sliderContribution(ids);
 if(source.split(helper).length!==2||source.split(SLIDER_MARKER).length!==2)return null;
 let restored=source.replace(helper,"");
 const thresholds=[...restored.matchAll(/([A-Za-z_$][\w$]*)\.length>=codexLinuxDefaultPresetMinimum\(\1\)/gu)];
 if(thresholds.length!==2)return null;
 restored=restored.replace(/([A-Za-z_$][\w$]*)\.length>=codexLinuxDefaultPresetMinimum\(\1\)/gu,"$1.length>=3");
 const owner=nativeResetOwner(restored,module);if(!owner)return null;
 const names=[...module.params,...Object.values(owner.groups)];
 if(names.includes("Set")||names.some(name=>name.startsWith("codexLinux")))return null;
 const open=restored.indexOf("{",owner.publication.fn.start);
 let replay=restored.slice(0,open+1)+helper+restored.slice(open+1);
 for(const name of [owner.groups.filtered,owner.groups.selectionsCache])replay=replay.replace(`${name}.length>=3`,`${name}.length>=codexLinuxDefaultPresetMinimum(${name})`);
 return replay===source?{owner,native:restored}:null;
}
function resetFactoryState(source,module,ids=[]){const native=nativeResetOwner(source,module);if(native)return{kind:"native",owner:native};const slider=sliderNative(source,module,ids);return slider?{kind:"slider",...slider}:{kind:"missing"};}

function requireRegistry(source){const headers=[...source.matchAll(/\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu)];if(headers.length!==1||!createJavaScriptLexicalIndex(source.slice(0,headers[0].index+headers[0][0].length)).isRoot(headers[0].index))throw Error(`Missing, ambiguous or opaque ${DESCRIPTION} registry`);}
function nativeResetResolver(source,module,key) {
 if(Buffer.byteLength(source)>256*1024||!['canInitializePowerPicker:','selectedPowerSelection:','showXHighInSimplePicker:'].every(needle=>source.includes(needle)))return null;
 if(module?.params?.length!==3)return null;
 for(const name of module.params.slice(1))requireOriginalBinding(source,name);
 const publication=findRspackExportPublication({...module,moduleSource:source},key);
 if(!publication?.fn)return null;
 const fn=source.slice(publication.fn.start,publication.fn.end);
 const pattern=new RegExp(String.raw`^function\(\{canInitializePowerPicker:(?<ready>${ID}),fallbackPowerSelection:(?<fallback>${ID}),menuView:(?<menu>${ID}),selectedPowerSelection:(?<selected>${ID}),showXHighInSimplePicker:(?<show>${ID})\}\)\{if\(!\k<show>&&\k<ready>&&"simple"===\k<menu>\)return \k<selected>\?\.reasoningEffort==="xhigh"&&\k<fallback>\?\.id!==\k<selected>\.id\?\k<fallback>:void 0\}$`,"u");
 const found=pattern.exec(fn);if(!found||new Set(Object.values(found.groups)).size!==5)return null;
 return{publication,groups:found.groups};
}
function requireResetDependency(assets,copies,ids=[]) {
 const owners=copies.map(copy=>resetFactoryState(copy.moduleSource,copy,ids).owner);
 if(owners.some(owner=>!owner))throw Error(`Missing or drifted ${DESCRIPTION}`);
 const expected=owners.map(owner=>({moduleId:owner.imports.find(binding=>binding.localName===owner.groups.resolver).moduleId,key:owner.groups.resolveExport}));
 if(new Set(expected.map(value=>JSON.stringify(value))).size!==1)throw Error("Inconsistent reset resolver dependencies");
 const [{moduleId,key}]=expected;
 const dependencies=findUniqueRspackModuleCopies(assets,{
  description:"native Default reset resolver dependency",
  sourceMatch:source=>['canInitializePowerPicker:','selectedPowerSelection:','showXHighInSimplePicker:'].every(needle=>source.includes(needle)),
  matchModule:(source,module)=>nativeResetResolver(source,module,key)!=null,
 });
 if(dependencies[0].moduleId!==moduleId)throw Error("Default reset import does not bind its native resolver publication");
 for(const copy of dependencies){requireRegistry(copy.source);if(!nativeResetResolver(copy.moduleSource,copy,key))throw Error("Damaged native Default reset resolver dependency");}
 return{moduleId,exportName:key,matched:dependencies.length};
}

function auditPickerReset(extractedDir,ids=[],options={}) {
 const assets=path.join(extractedDir,"webview","assets");
 const copies=findUniqueRspackModuleCopies(assets,{description:DESCRIPTION,sourceMatch:source=>NEEDLES.every(n=>source.includes(n)),matchModule:(source,module)=>resetFactoryState(source,module,ids).kind!=="missing"});
 for(const copy of copies)requireRegistry(copy.source);
 const states=copies.map(copy=>resetFactoryState(copy.moduleSource,copy,ids).kind);
 if(states.includes("missing"))throw Error(`Missing or drifted ${DESCRIPTION}`);
 if(new Set(states).size!==1)throw Error("Mixed Default picker reset-effect copies");
 const dependency=requireResetDependency(assets,copies,ids);
 return {...patchRspackModuleCopies(assets,copies,(source,module)=>{if(resetFactoryState(source,module,ids).kind==="missing")throw Error(`Missing or drifted ${DESCRIPTION}`);return source;},options),dependency};
}
function applyPickerSlider(source,module,ids) {
 if(ids.length===0)return source;
 const state=resetFactoryState(source,module,ids);
 if(state.kind==="slider")return source;
 if(state.kind!=="native")throw Error("Missing, ambiguous or partial current Default slider factory");
 const names=[...module.params,...Object.values(state.owner.groups)];
 if(names.includes("Set")||names.some(name=>name.startsWith("codexLinux")))throw Error("Default slider helper binding collides with native scope");
 const open=source.indexOf("{",state.owner.publication.fn.start),helper=sliderContribution(ids);
 let patched=source.slice(0,open+1)+helper+source.slice(open+1);
 for(const name of [state.owner.groups.filtered,state.owner.groups.selectionsCache]){
  const before=`${name}.length>=3`;if(patched.split(before).length!==2)throw Error("Ambiguous Default slider threshold");
  patched=patched.replace(before,`${name}.length>=codexLinuxDefaultPresetMinimum(${name})`);
 }
 if(resetFactoryState(patched,module,ids).kind!=="slider")throw Error("Default slider failed canonical replay");
 try{new Script(`"use strict";(function(${module.params.join(",")}){${patched}})`);}catch{throw Error("Default slider generated invalid syntax");}
 return patched;
}
function patchPickerSlider(extractedDir,ids,options={}) {
 if(ids.length===0)return{matched:0,changed:0,changedAssets:[]};
 const assets=path.join(extractedDir,"webview","assets"),markerAssets=new Map();
 const copies=findUniqueRspackModuleCopies(assets,{
  description:"current Default slider factory",
  sourceMatch(source,name){if(source.includes(SLIDER_MARKER))markerAssets.set(name,source);return source.includes(SLIDER_MARKER)||NEEDLES.every(n=>source.includes(n));},
  matchModule:(source,module)=>resetFactoryState(source,module,ids).kind!=="missing",
 });
 for(const copy of copies){requireRegistry(copy.source);
  if(copy.source.split(SLIDER_MARKER).length!==copy.moduleSource.split(SLIDER_MARKER).length)throw Error("Orphan Default slider marker");
  markerAssets.delete(copy.assetName);
 }
 if(markerAssets.size)throw Error("Orphan Default slider marker asset");
 requireResetDependency(assets,copies,ids);
 return patchRspackModuleCopies(assets,copies,(source,module)=>applyPickerSlider(source,module,ids),options);
}

function isPickerResetAsset(source,ids=[]) {
 try{requireRegistry(source);return [...require("../../scripts/patches/lib/rspack-module-assets.js").rspackModuleFactories(source,"reset-effect.js")].filter(module=>resetFactoryState(module.moduleSource,module,ids).kind!=="missing").length===1;}catch{return false;}
}
module.exports={nativeResetOwner,nativeResetResolver,requireResetDependency,resetFactoryState,auditPickerReset,isPickerResetAsset,applyPickerSlider,patchPickerSlider};
