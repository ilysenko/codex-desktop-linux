"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const { applyWebviewAssetPatchDescriptors } = require("../../scripts/patches/engine.js");
const { captureWarnings, createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  DEFAULT_PROJECT_NAME_STYLE,PROJECT_NAME_SELECTOR,RUNTIME_MARKER,STYLE_ID,
  applySidebarProjectNameStylePatch,sidebarProjectNameCss,sidebarProjectNameStyleRuntimeSource,descriptors,
} = require("./patches/sidebar-project-name.js");

const CURRENT = 'const attrs={sidebarProjectRow:"data-app-action-sidebar-project-row",sidebarProjectLabel:"data-app-action-sidebar-project-label"};' +
  'const selectors={sidebarProjectRow:`[${attrs.sidebarProjectRow}]`};' +
  'const actions={sidebarProjectRow:({collapsed:e,label:t,projectId:n})=>({collapsed:e,label:t,projectId:n})};';

test("sidebar runtime installs one scoped stylesheet and reuses it on DOM ready and repeated execution",()=>{
  const styles=[],listeners=[];
  const document={readyState:"loading",head:{appendChild:node=>styles.push(node)},
    getElementById:id=>styles.find(node=>node.id===id),
    createElement:tag=>({tagName:tag,id:"",textContent:""}),
    addEventListener:(event,listener)=>listeners.push({event,listener}),
  };
  const runtime=sidebarProjectNameStyleRuntimeSource();
  vm.runInNewContext(runtime,{document});
  for(const {event,listener} of listeners){assert.equal(event,"DOMContentLoaded");listener();}
  vm.runInNewContext(runtime,{document});
  assert.equal(styles.length,1);assert.equal(styles[0].id,STYLE_ID);
  assert.equal(styles[0].textContent,`${PROJECT_NAME_SELECTOR}{${DEFAULT_PROJECT_NAME_STYLE}}`);
  assert.doesNotMatch(styles[0].textContent,/(?:padding|margin|height|line-height|width):/);
  const custom="font-weight: 800 !important; color: red;";
  vm.runInNewContext(sidebarProjectNameStyleRuntimeSource(custom),{document});
  assert.equal(styles.length,1);assert.equal(styles[0].textContent,sidebarProjectNameCss(custom));
  assert.doesNotThrow(()=>vm.runInNewContext(runtime,{}));
});

test("sidebar complete-state idempotence rejects partial and duplicated owner/runtime markers",()=>{
  const patched=applySidebarProjectNameStylePatch(CURRENT);
  assert.notEqual(patched,CURRENT);assert.equal(descriptors[0].assetMatch(patched),true);
  const repeated=captureWarnings(()=>applySidebarProjectNameStylePatch(patched));
  assert.equal(repeated.value,patched);assert.deepEqual(repeated.warnings,[]);
  assert.equal(applySidebarProjectNameStylePatch(patched+"\n;const anotherFeature=true;"),patched+"\n;const anotherFeature=true;");
  assert.equal(descriptors[0].assetMatch(CURRENT),true);
  const unrelatedMarquee='function marquee(){return {"data-marquee-text":!1}}';
  assert.equal(applySidebarProjectNameStylePatch(patched+unrelatedMarquee),patched+unrelatedMarquee);
  for(const source of [CURRENT+CURRENT,patched+sidebarProjectNameStyleRuntimeSource(),
    CURRENT+`;const ${RUNTIME_MARKER}=true;`,CURRENT+`;const style=${JSON.stringify(STYLE_ID)};`,
    patched.replace("function install(){","function damaged(){"),
    patched.replace('sidebarProjectLabel:', 'renamedProjectLabel:'),
    CURRENT.replace('sidebarProjectRow:"data-app-action-sidebar-project-row"','sidebarProjectRow:`data-app-action-sidebar-project-row`')]){
    const result=captureWarnings(()=>applySidebarProjectNameStylePatch(source,{warnOnMissingMarkers:true}));
    assert.equal(result.value,source);assert.equal(result.warnings.length,1);
  }
});

const signedApp=process.env.CODEX_SIGNED_EXTRACTED_APP;
test("current signed Projects marker owner patches nested async chunks with syntax and idempotence",{skip:!signedApp},()=>{
  const assets=path.join(signedApp,"webview/assets"),descriptor=descriptors[0];
  const owners=findWebviewAssetsContaining(signedApp,descriptor.assetNeedles)
    .map(assetName=>({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")}))
    .filter(({source})=>descriptor.assetMatch(source));
  assert.equal(owners.length,1);const [owner]=owners;assert.ok(owner.assetName.startsWith("async/"));
  const extracted=fs.mkdtempSync(path.join(os.tmpdir(),"sidebar-project-name-signed-"));
  try {
    const target=path.join(extracted,"webview/assets",owner.assetName);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,owner.source);
    for(const expected of ["applied","already-applied"]){
      const report=createPatchReport();applyWebviewAssetPatchDescriptors(extracted,[descriptor],{},report);
      assert.equal(report.patches[0].status,expected);assert.equal(report.patches[0].assetName,owner.assetName);
    }
    const before=fs.readFileSync(target,"utf8");
    fs.copyFileSync(target,path.join(extracted,"webview/assets/async/duplicate.current.js"));
    const report=createPatchReport();captureWarnings(()=>applyWebviewAssetPatchDescriptors(extracted,[descriptor],{},report));
    assert.notEqual(report.patches[0].status,"already-applied");assert.equal(fs.readFileSync(target,"utf8"),before);
  } finally {fs.rmSync(extracted,{recursive:true,force:true});}
});
