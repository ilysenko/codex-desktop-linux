"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm"),test=require("node:test");
const api=require("./connections-refresh-owner.js"),c=require("./connections-refresh-contracts.js"),h=require("./fixtures/connections-refresh-harness.js"),scope=require("./remote-copy-scope.js");
const {patchWebviewAssets}=require("../../scripts/patches/lib/assets.js");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const descriptor=require("./patch.js").find(row=>row.id==="linux-remote-connections-refresh");
function temporary(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),"connections-refresh-"));try{return fn(root)}finally{fs.rmSync(root,{recursive:true,force:true})}}
function edit(input,file,from,to){assert.ok(input[file].includes(from),from);input[file]=input[file].replace(from,to)}
function rejects(mutate){const input=h.sources();mutate(input);const cohort=h.snapshots(input),before=JSON.stringify(input);for(const rows of Object.values(cohort))for(const row of rows)new vm.Script(`"use strict";(function(${row.params}){${row.moduleSource}\n});`);assert.throws(()=>api.prepareConnectionsRefresh(cohort),/Remote Connections refresh|Native Remote copy|Remote mobile visibility|Remote connections owners|Remote load gate/);assert.equal(JSON.stringify(input),before)}

test("current native effect becomes the exact existing1393-byte postimage, repeats and inverses",()=>{
 const input=h.sources(),first=api.prepareConnectionsRefresh(h.snapshots(input)),output=h.transition(input,first),repeat=api.prepareConnectionsRefresh(h.snapshots(output));
 assert.equal(first.alreadyApplied,false);assert.equal(repeat.alreadyApplied,true);const changed=first.edits.filter(r=>r.source!==r.patchedSource);assert.equal(changed.length,1);assert.equal(Buffer.byteLength(changed[0].patchedSource)-Buffer.byteLength(changed[0].source),1393);assert.deepEqual(h.transition(output,repeat),output);assert.deepEqual(h.transition(output,repeat,"nativeSource"),input);
 const copy=h.snapshots(input).owner[0],plan=api.prepareConnectionsRefreshOwner(copy),at=copy.moduleSource.indexOf(c.nativeEffect);assert.ok(at>=0);assert.equal(plan.patchedSource,copy.moduleSource.slice(0,at)+c.patchedEffect+copy.moduleSource.slice(at+c.nativeEffect.length));
});

test("5s polling and all visible resume signals invoke the same captured effect event",async()=>{
 const rt=h.runtime(c.patchedEffect,()=>Promise.resolve());assert.deepEqual([...rt.intervals.values()].map(r=>r.delay),[5000]);assert.equal(rt.calls.length,0);
 await rt.interval();assert.equal(rt.calls.length,1);for(const event of["focus","online","resume","visibilitychange"]){await rt.advance(1000);await rt.event(event)}assert.equal(rt.calls.length,5);
 rt.document.visibilityState="hidden";await rt.advance(1000);await rt.event("visibilitychange");assert.equal(rt.calls.length,5);rt.document.visibilityState="visible";await rt.event("visibilitychange");assert.equal(rt.calls.length,6);assert.ok(rt.calls.every(signal=>signal instanceof AbortSignal));rt.cleanup();
});

test("concurrent polling/events coalesce, offline fulfillment recovers and cleanup cancels every resource",async()=>{
 let resolve;const pending=new Promise(r=>{resolve=r});let count=0;const rt=h.runtime(c.patchedEffect,()=>++count===1?pending:Promise.resolve());
 await rt.interval();await rt.interval();await rt.event("focus");await rt.event("online");assert.equal(rt.calls.length,1);assert.ok(rt.timeouts.size<=1);
 resolve();await rt.flush();await rt.advance(1000);assert.equal(rt.calls.length,2);await rt.advance(1000);await rt.event("online");assert.equal(rt.calls.length,3);
 await rt.event("focus");assert.ok(rt.timeouts.size<=1);rt.cleanup();assert.equal(rt.intervals.size,0);assert.equal(rt.timeouts.size,0);for(const target of[rt.window,rt.document])for(const rows of target.listeners.values())assert.equal(rows.size,0);const before=rt.calls.length;await rt.advance(5000);await rt.event("resume");await rt.interval();assert.equal(rt.calls.length,before);
});

test("unmount aborts the in-flight generation and fresh page entry has its own valid signal",async()=>{
 let resolve;const pending=new Promise(r=>{resolve=r}),a=h.runtime(c.patchedEffect,()=>pending);await a.interval();const old=a.calls[0];a.cleanup();assert.equal(old.aborted,true);resolve();await a.flush();assert.equal(a.intervals.size,0);assert.equal(a.timeouts.size,0);
 const b=h.runtime(c.patchedEffect,()=>Promise.resolve());await b.event("focus");assert.equal(b.calls.length,1);assert.notEqual(b.calls[0],old);assert.equal(b.calls[0].aborted,false);b.cleanup();
});

test("native live callback retains pending suppression, availability and late read-only service choice",async()=>{
 const events=[],state={services:null},namespace={get appServices(){return state.services}},body=c.awaiter.moduleSource,start=body.indexOf("P:async function(")+2,open=body.indexOf("{",start),end=createJavaScriptLexicalIndex(body).matchingBrace(open),awaiter=body.slice(start,end+1);assert.ok(start>1&&end>open);
 const P=vm.runInNewContext("("+awaiter+")",{Symbol}),make=(op,nF)=>vm.runInNewContext("("+c.nativeHandler+")",{op,nF,T:namespace,H:{P},W:{v:{debug:()=>events.push("debug")}},Promise,DOMException});
 state.services={sshConnections:{refresh(){events.push("ssh");return Promise.resolve()}},remoteConnections:{refreshRemoteControl(){events.push("remote");return Promise.resolve()}}};
 let current=make(false,true);const rt=h.runtime(c.patchedEffect,signal=>current(signal));await rt.interval();assert.deepEqual(events,["ssh","remote"]);
 current=make(true,true);await rt.interval();assert.deepEqual(events,["ssh","remote"]);current=make(false,false);await rt.interval();assert.deepEqual(events,["ssh","remote","ssh"]);
 state.services={sshConnections:{refresh(){events.push("replacement");return Promise.resolve()}}};current=make(false,true);await rt.advance(1000);await rt.event("online");assert.equal(events.at(-1),"replacement");rt.cleanup();
});

test("unpublished/generator/captured or orphaned effects and wrong caller/declaration links reject",()=>{
 for(const[from,to]of[["RemoteConnectionsSettings:()=>t6","RemoteConnectionsSettings:()=>eO"],["let oI=(0,h.useEffectEvent)(eZ)","if(false)var oI=(0,h.useEffectEvent)(eZ)"],["tw[130]!==op||tw[131]!==nF?","if(false)tw[130]!==op||tw[131]!==nF?"],["tw[133]!==oI?","if(false)tw[133]!==oI?"],["(0,h.useEffect)(eB,eX)","(0,h.useEffect)(eZ,eX)"],["if(!op)try","if(op)try"],["nF=(0,t$.wi)()","nF=true"],["let oh=(0,l.n)(eD)","if(false)var oh=(0,l.n)(eD)"],["let oI=(0,h.useEffectEvent)(eZ)","eZ=()=>null;let oI=(0,h.useEffectEvent)(eZ)"],["window.clearInterval(n)","window.clearInterval(e)"],["var o=",`/*${api.MARKER}*/var o=`],["var o=","function* t6(){return null}var o="]])rejects(input=>edit(input,"async/refresh-owner-0.js",from,to));
});

test("all late facade/awaiter/availability physical providers remain mandatory and untouched",()=>{
 rejects(input=>edit(input,"async/refresh-facade-1.js","appServices:","wrongServices:"));rejects(input=>edit(input,"async/refresh-awaiter-0.js","throwIfAborted","wrongIfAborted"));rejects(input=>edit(input,"async/refresh-visibility-5.js","accessRequired!==!0","accessRequired===!0"));
 const missing=h.snapshots();missing.facade=[];assert.throws(()=>api.prepareConnectionsRefresh(missing),/missing facade/);
});

test("read-only dependencies preflight and interrupted owner writes preserve exact native bytes",()=>temporary(root=>{
 const input=h.sources(),assets=h.writeApp(root,input),plan=api.prepareConnectionsRefresh(h.snapshots(input));let writes=0;
 assert.throws(()=>patchWebviewAssets(assets,plan.edits,{writeFileSync(file,data){if(++writes===1){fs.writeFileSync(file,data.subarray(0,10));throw Error("controlled refresh short write")}fs.writeFileSync(file,data)}}),/controlled refresh short write/);assert.deepEqual(h.readApp(root,input),input);
 const dep=Object.keys(input).find(name=>name.includes("facade-1"));fs.appendFileSync(path.join(assets,dep),"\n//stale");assert.throws(()=>patchWebviewAssets(assets,plan.edits),/changed before patch commit/);assert.equal(fs.readFileSync(path.join(assets,"async/refresh-owner-0.js"),"utf8"),input["async/refresh-owner-0.js"]);
}));

test("registered87 owns the extracted cohort, writes one1393-byte effect and repeats without writes",()=>temporary(root=>{
 assert.equal(descriptor.phase,"extracted-app:pre-webview");assert.equal(descriptor.order,20140);assert.equal(descriptor.assetNeedles,undefined);assert.equal(descriptor.ciPolicy,"optional");assert.throws(()=>descriptor.apply("function unrelated(){}"));
 const input=h.sources(),assets=h.writeApp(root,input),modes=Object.fromEntries(Object.keys(input).map(name=>[name,fs.statSync(path.join(assets,name)).mode]));assert.equal(descriptor.apply(root).changed,1);const output=h.readApp(root,input);assert.equal(Buffer.byteLength(output["async/refresh-owner-0.js"])-Buffer.byteLength(input["async/refresh-owner-0.js"]),1393);assert.equal(descriptor.apply(root,{connectionsRefreshWriteOptions:{writeFileSync(){assert.fail("repeat write")}}}).changed,0);assert.deepEqual(h.readApp(root,input),output);for(const name of Object.keys(input))assert.equal(fs.statSync(path.join(assets,name)).mode,modes[name]);
}));

test("87 commutes and inverses independently with accepted85/86 while read-only83 providers retain their contribution",()=>{
 const out=require("./fixtures/outbound-tab-harness.js"),rev=require("./fixtures/revoke-setup-reset-harness.js"),vis=require("./fixtures/remote-visibility-harness.js"),{prepareOutboundTab}=require("./outbound-tab-owner.js"),{prepareRevokeSetupReset}=require("./revoke-setup-reset-owner.js"),{prepareRemoteMobileVisibility}=require("./remote-control-visibility.js");
 const input={...h.sources(),...Object.fromEntries(Object.entries(out.sources()).filter(([n])=>!n.includes("outbound-owner-"))),...Object.fromEntries(Object.entries(rev.sources()).filter(([n])=>n!=="async/owner.js"))};
 const step=(x,id)=>h.transition(x,id===85?prepareOutboundTab(out.snapshots(x)):id===86?prepareRevokeSetupReset(rev.snapshots(x)):api.prepareConnectionsRefresh(h.snapshots(x)));
 let a=input,b=input;for(const id of[85,86,87])a=step(a,id);for(const id of[87,86,85])b=step(b,id);assert.deepEqual(a,b);assert.deepEqual(h.transition(a,api.prepareConnectionsRefresh(h.snapshots(a)),"nativeSource"),step(step(input,85),86));
 const with83=h.transition(input,prepareRemoteMobileVisibility(vis.snapshots(input))),joint=step(with83,87),reverse=h.transition(step(input,87),prepareRemoteMobileVisibility(vis.snapshots(step(input,87))));assert.deepEqual(joint,reverse);assert.deepEqual(h.transition(joint,api.prepareConnectionsRefresh(h.snapshots(joint)),"nativeSource"),with83);
});

test("qualified pending availability and memo bindings reject the three exact eager overwrites",()=>{
 const native=h.snapshots().owner[0],positive=api.prepareConnectionsRefreshOwner(native);assert.equal(positive.state,"native");assert.equal(Buffer.byteLength(positive.patchedSource)-Buffer.byteLength(native.moduleSource),1393);
 for(const injected of["op=!1;","nF=!0;","tw=[];"]){
  const input=h.sources(),file="async/refresh-owner-0.js",head="tw[130]!==op||tw[131]!==nF?";edit(input,file,head,injected+head);const copy=h.snapshots(input).owner[0];new vm.Script(`"use strict";(function(${copy.params}){${copy.moduleSource}\n});`);
  assert.throws(()=>api.prepareConnectionsRefreshOwner(copy),/eager component binding rebind/);
 }
 // Existing cache-element writes remain accepted by the native positive above.
 const patched={...native,moduleSource:positive.patchedSource};const repeat=api.prepareConnectionsRefreshOwner(patched);assert.equal(repeat.state,"patched");assert.equal(repeat.nativeSource,native.moduleSource);
});
