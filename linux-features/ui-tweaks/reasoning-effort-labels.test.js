"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const vm=require("node:vm");
const test=require("node:test");
const {applyExtractedAppPatchDescriptors,normalizePatchDescriptors}=require("../../scripts/patches/engine.js");
const {captureWarnings,createPatchReport}=require("../../scripts/lib/patch-report.js");
const {ENGLISH_REASONING_LABELS,applyEnglishReasoningLabels,applyEnglishReasoningLabelsToApp,findZhCnLocaleAsset,descriptors}=require("./patches/reasoning-effort-labels.js");

const values={
  "composer.mode.local.reasoning.none.label":"无","composer.mode.local.reasoning.minimal.label":"极低",
  "composer.mode.local.reasoning.medium.label":"中","composer.mode.local.reasoning.high.label":"高",
  "composer.mode.local.reasoning.xhigh.label":"极高","composer.mode.local.reasoning.max.label":"Max",
  "composer.mode.local.reasoning.ultra.label":"Ultra","composer.mode.local.reasoning.persistent.label":"持续",
  title:"推理强度",warning:"高强度会消耗更多额度",escaped:"It's a \"quoted\" line\nwith a backslash \\",
};
function catalog(dictionary,chunk=101,id="ZhCn"){
  const json=JSON.stringify(dictionary).replaceAll("\\","\\\\").replaceAll("'","\\'");
  return `export const __rspack_esm_ids=[${chunk}];export const __webpack_modules__={${id}(e){e.exports=JSON.parse('${json}')}};`;
}
function readCatalog(source){
  const factories=vm.runInNewContext(source.replace(/export const (__rspack_esm_ids|__webpack_modules__)=/g,"const $1=")+"\n;__webpack_modules__");
  const module={};Object.values(factories)[0](module);return module.exports;
}
function workspace(t,{source=catalog(values),chunk=101,id="ZhCn",assetName=`async/${chunk}.abcdef1234.js`}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"effort-label-route-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const assets=path.join(root,"webview/assets");fs.mkdirSync(path.join(assets,"async"),{recursive:true});
  const loader=`export const __webpack_modules__={Loader(e,t,i){const locales={"../locales/zh-CN.json":function(){return i.e(${chunk}).then(i.t.bind(i,"${id}",19))},"../locales/zh-TW.json":function(){return i.e(102).then(i.t.bind(i,"ZhTw",19))}}}};`;
  fs.writeFileSync(path.join(assets,"entry.js"),loader);
  const target=path.join(assets,assetName);fs.writeFileSync(target,source);
  const traditional=path.join(assets,"async/102.abcdef1234.js");fs.writeFileSync(traditional,catalog({...values,title:"繁體中文"},102,"ZhTw"));
  const run=()=>{const report=createPatchReport();captureWarnings(()=>applyExtractedAppPatchDescriptors(root,normalizePatchDescriptors(descriptors),{},report,"extracted-app:post-webview"));return report.patches[0];};
  return{root,target,traditional,run};
}
function expectedSource(source,dictionary){
  for(const[key,label]of Object.entries(ENGLISH_REASONING_LABELS)){
    const before=`${JSON.stringify(key)}:${JSON.stringify(dictionary[key])}`;assert.ok(source.includes(before),key);
    source=source.replace(before,`${JSON.stringify(key)}:${JSON.stringify(label)}`);
  }
  return source;
}

test("English effort locale follows the authoritative route and preserves every unrelated byte",t=>{
  const app=workspace(t),before=fs.readFileSync(app.target,"utf8"),traditional=fs.readFileSync(app.traditional,"utf8");
  assert.equal(app.run().status,"applied");const after=fs.readFileSync(app.target,"utf8");
  assert.ok(after===expectedSource(before,values));
  const dictionary=readCatalog(after);for(const[key,value]of Object.entries(values))assert.equal(dictionary[key],ENGLISH_REASONING_LABELS[key]??value,key);
  assert.equal(dictionary["composer.mode.local.reasoning.persistent.label"],"Persistent");
  assert.equal(new Set(Object.keys(ENGLISH_REASONING_LABELS).map(key=>dictionary[key])).size,8);
  assert.equal(fs.readFileSync(app.traditional,"utf8"),traditional);assert.equal(app.run().status,"already-applied");
});

test("English effort locale keeps early disabled discovery and the extracted-app descriptor",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"effort-label-disabled-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const context={feature:{settings:{tweaks:{reasoning:{keepEffortLabelsEnglish:{enabled:false}}}}}};
  assert.equal(descriptors[0].phase,"extracted-app:post-webview");assert.equal(descriptors[0].pattern,undefined);
  assert.equal(descriptors[0].enabled(context),false);
  const result=captureWarnings(()=>applyEnglishReasoningLabelsToApp(root,context));
  assert.deepEqual(result.value,{matched:0,changed:0});assert.deepEqual(result.warnings,[]);
});

test("English effort locale rejects missing or duplicated Persistent before changing the catalog",t=>{
  const entry='"composer.mode.local.reasoning.persistent.label":"持续"';
  for(const source of[catalog(values).replace(entry,'"missingPersistent":"持续"'),catalog(values).replace(entry,entry+","+entry)]){
    const app=workspace(t,{source});assert.equal(app.run().status,"skipped-optional");assert.equal(fs.readFileSync(app.target,"utf8"),source);
  }
});

test("English effort locale requires its current array chunk identity before writing", t => {
  const original = catalog(values);
  for (const header of [
    "export const __rspack_esm_ids=[999];",
    "export const __rspack_esm_ids=[101,999];",
    "export const __rspack_esm_ids=[];",
    "export const __rspack_esm_id=101;",
  ]) {
    const source = original.replace("export const __rspack_esm_ids=[101];", header);
    const app = workspace(t, { source });
    assert.equal(app.run().status, "skipped-optional");
    assert.equal(fs.readFileSync(app.target, "utf8"), source);
  }
});

test("English effort locale signed route retains all non-target entries and is repeatable",{skip:!process.env.CODEX_SIGNED_EXTRACTED_APP},t=>{
  const original=findZhCnLocaleAsset(process.env.CODEX_SIGNED_EXTRACTED_APP),dictionary=readCatalog(original.source);
  const chunk=Number(/^export const __rspack_esm_ids=\[(\d+)\];/.exec(original.source)[1]);
  const id=/__webpack_modules__=\{([A-Za-z_$][\w$]*)\(/.exec(original.source)[1];
  const app=workspace(t,{source:original.source,chunk,id,assetName:original.assetName});
  assert.equal(app.run().status,"applied");const after=fs.readFileSync(app.target,"utf8");assert.ok(after===expectedSource(original.source,dictionary));
  const actual=readCatalog(after);assert.equal(Object.keys(actual).length,Object.keys(dictionary).length);
  for(const[key,value]of Object.entries(dictionary))assert.equal(actual[key],ENGLISH_REASONING_LABELS[key]??value,key);
  assert.equal(app.run().status,"already-applied");
  assert.equal(applyEnglishReasoningLabels(after),after);
  assert.equal(fs.readFileSync(path.join(process.env.CODEX_SIGNED_EXTRACTED_APP,"webview/assets",original.assetName),"utf8"),original.source);
});
