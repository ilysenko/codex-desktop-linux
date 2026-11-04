"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { applyLinuxSidebarScrollPerformancePatch: apply } = require("./implementation.js");
const descriptors = require("./patch.js").filter(({id})=>id==="sidebar-scroll");
const {applyWebviewAssetPatchDescriptors}=require("../../scripts/patches/engine.js");
const {createPatchReport,captureWarnings}=require("../../scripts/lib/patch-report.js");
const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js");
const fixture='function sidebar(){return(0,r.jsxs)("div",{...cU.rW.sidebarScroll,className:(0,s.A)("[contain:layout_paint]",bi.A.headerFadeMask,"vertical-scroll-fade-mask"),ref:T,onScroll:e=>{telemetry(e);let{scrollTop:n}=e.currentTarget;changed(n)},children:[]})}';

test("scroll workaround changes styles while preserving classes, props and callbacks",()=>{
  const calls=[];const ref={};const context={r:{jsxs:(_,props)=>props},cU:{rW:{sidebarScroll:{"data-sidebar":true}}},s:{A:(...xs)=>xs.join(" ")},bi:{A:{headerFadeMask:"header"}},T:ref,telemetry:e=>calls.push(e),changed:n=>calls.push(n)};
  const patched=apply(fixture);const original=vm.runInNewContext(fixture+";sidebar",context)();const props=vm.runInNewContext(patched+";sidebar",context)();
  assert.equal(props.className,original.className);assert.equal(props.ref,ref);assert.equal(props["data-sidebar"],true);
  assert.equal(props.style.animationName,"none");assert.equal(props.style.animationTimeline,"auto");assert.equal(props.style["--bottom-fade"],"calc(var(--spacing) * 10)");
  const event={currentTarget:{scrollTop:42}};props.onScroll(event);assert.deepEqual(calls,[event,42]);assert.equal(apply(patched),patched);
});

test("sidebar missing, ambiguous, mixed and incomplete style states stay unchanged",()=>{
  const patched=apply(fixture);
  for(const source of ["",fixture+fixture,patched+fixture,fixture.replace("bi.A.headerFadeMask","bi.A.other"),patched.replace('animationTimeline:"auto"','animationTimeline:"scroll"')]){
    assert.equal(descriptors[0].assetMatch(source),false);assert.equal(captureWarnings(()=>apply(source)).value,source);
  }
});

test("normal descriptor patches nested current asset and rejects additional owners",t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"sidebar-performance-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const assets=path.join(dir,"webview/assets/async");fs.mkdirSync(assets,{recursive:true});const file=path.join(assets,"91641.hash.js");fs.writeFileSync(file,fixture);
  for(const expected of ["applied","already-applied"]){const report=createPatchReport();applyWebviewAssetPatchDescriptors(dir,descriptors,{},report);assert.equal(report.patches[0].status,expected);}
  fs.writeFileSync(path.join(assets,"another.js"),fixture);const report=createPatchReport();captureWarnings(()=>applyWebviewAssetPatchDescriptors(dir,descriptors,{},report));assert.equal(report.patches[0].status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),apply(fixture));
});

test("signed current sidebar has one complete owner",{skip:!process.env.CODEX_SIGNED_EXTRACTED_APP},()=>{
  const assets=path.join(process.env.CODEX_SIGNED_EXTRACTED_APP,"webview/assets");const owners=findWebviewAssetsContaining(process.env.CODEX_SIGNED_EXTRACTED_APP,descriptors[0].assetNeedles).filter(name=>descriptors[0].assetMatch(fs.readFileSync(path.join(assets,name),"utf8")));
  assert.equal(owners.length,1);const source=fs.readFileSync(path.join(assets,owners[0]),"utf8"),patched=apply(source);assert.notEqual(patched,source);assert.equal(apply(patched),patched);
});
