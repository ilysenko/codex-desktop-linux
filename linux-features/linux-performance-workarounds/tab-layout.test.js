"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm"),test=require("node:test");
const {applyLinuxAppShellTabLayoutPerformancePatch:apply,matchesLinuxAppShellTabLayoutPerformanceContract:matches}=require("./implementation.js");
const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js");
const fixture='function tab(l,t){return jsx(Tab,{...t,activateOnClick:!0,animateLayout:!l.isWorkspaceHome&&t.animateLayout,animateExit:!l.isWorkspaceHome&&t.animateExit,closeButtonTabIndex:-1,controller:x.It,dragActivator:"tab",tab:l,shortcutHint:hint})}';
test("tab workaround preserves exit, controller, drag and closing callbacks for every layout state",()=>{
 const controller={},hint={},ctx={jsx:(_,props)=>props,Tab:{},x:{It:controller},hint};const before=vm.runInNewContext(fixture+";tab",ctx),after=vm.runInNewContext(apply(fixture)+";tab",ctx);
 for(const home of [false,true])for(const layout of [false,true])for(const exit of [false,true]){
  const tab={isWorkspaceHome:home},close=()=>{},options={animateLayout:layout,animateExit:exit,onClose:close};const a=before(tab,options),b=after(tab,options);
  assert.equal(b.animateLayout,false);for(const key of ["animateExit","onClose","controller","dragActivator","closeButtonTabIndex","tab","shortcutHint"])assert.equal(b[key],a[key]);
 }
 assert.equal(apply(apply(fixture)),apply(fixture));
});
test("incoherent tab binding, activator, close behavior and mixed owners are rejected",()=>{
 for(const s of [fixture.replace("tab:l","tab:other"),fixture.replace('dragActivator:"tab"','dragActivator:`tab`'),fixture+apply(fixture),fixture.replace("closeButtonTabIndex:-1","closeButtonTabIndex:0")]){assert.equal(matches(s),false);assert.equal(apply(s),s);}
});
test("signed current tab has one semantic owner",{skip:!process.env.CODEX_SIGNED_EXTRACTED_APP},()=>{
 const assets=path.join(process.env.CODEX_SIGNED_EXTRACTED_APP,"webview/assets"),owners=findWebviewAssetsContaining(process.env.CODEX_SIGNED_EXTRACTED_APP,require("./patch.js")[1].assetNeedles).filter(n=>matches(fs.readFileSync(path.join(assets,n),"utf8")));assert.equal(owners.length,1);const s=fs.readFileSync(path.join(assets,owners[0]),"utf8"),p=apply(s);assert.notEqual(p,s);assert.equal(apply(p),p);
});
