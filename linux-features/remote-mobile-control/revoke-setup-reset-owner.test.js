"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm"),test=require("node:test");
const {prepareRevokeSetupReset:prepare,prepareRevokeSetupResetSource,applyRevokeSetupReset:apply}=require("./revoke-setup-reset-owner.js");
const {patchWebviewAssets}=require("../../scripts/patches/lib/assets.js");
const h=require("./fixtures/revoke-setup-reset-harness.js");
const MARKER="codexLinuxRemoteControlResetMobileSetupAfterRevoke",KEY="codex-mobile-has-connected-device",clean=value=>JSON.parse(JSON.stringify(value)),tick=()=>new Promise(setImmediate);
function patched(input=h.sources()){return h.transition(input,prepare(h.snapshots(input)));}
function change(input,fn){return Object.fromEntries(Object.entries(input).map(([name,text])=>[name,fn(text,name)]));}
function rejected(input){assert.throws(()=>prepare(h.snapshots(input)),/Remote revoke|Remote connections owners/);}
function temporary(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),"remote-revoke-"));try{return fn(root)}finally{fs.rmSync(root,{recursive:true,force:true})}}

test("bounded critical owner/provider cohort prepares, repeats and inverses only the local contribution",()=>{
 const native=h.sources(),first=prepare(h.snapshots(native)),output=h.transition(native,first),repeat=prepare(h.snapshots(output));
 assert.equal(first.alreadyApplied,false);assert.equal(repeat.alreadyApplied,true);assert.deepEqual(h.transition(output,repeat),output);assert.deepEqual(h.transition(output,repeat,"nativeSource"),native);
 const changes=first.edits.filter(row=>row.source!==row.patchedSource);assert.equal(changes.length,1);assert.equal(changes[0].assetName,"async/owner.js");assert.equal(Buffer.byteLength(changes[0].patchedSource)-Buffer.byteLength(changes[0].source),357);
 assert.ok(changes[0].patchedSource.includes(h.fixture.functions.ssh.source));assert.ok(changes[0].patchedSource.includes(h.fixture.critical.localRenderSlot));
 const complete=h.source(),string=prepareRevokeSetupResetSource(complete);assert.equal(string.nativeSource,complete);assert.equal(prepareRevokeSetupResetSource(string.patchedSource).nativeSource,complete);
});

test("selected actual onSuccess callback resets only after the last external controller is removed",async()=>{
 const source=patched();
 for(const [data,revoked,expected,writes]of[
  [[{clientId:"desktop_1"},{clientId:"phone_1"}],"phone_1",[{clientId:"desktop_1"}],1],
  [[{clientId:"phone_1"}],"phone_1",[],1],
  [[{client_id:"desktop_1"},{client_id:"phone_1"}],"phone_1",[{client_id:"desktop_1"}],1],
  [[{clientId:"desktop_1"},{clientId:"phone_1"},{clientId:"tablet_1"}],"phone_1",[{clientId:"desktop_1"},{clientId:"tablet_1"}],0],
  [undefined,"phone_1",undefined,0],[null,"phone_1",undefined,0],
 ]){
  const run=h.behavior(source,data);run.success(revoked);await tick();assert.deepEqual(run.query.data,expected);assert.equal(run.writes.length,writes);if(writes)assert.deepEqual(run.writes,[[KEY,false]]);assert.equal(run.query.invalidated,1);assert.equal(run.events[0],"analytics:succeeded");assert.equal(run.events.at(-1),"toast:success");assert.equal(run.events.includes("toast:error"),false);if(data==null)assert.equal(run.state.reads,0);
 }
});

test("selected native onError and native SSH revoke callback never reset local setup",async()=>{
 const data=[{clientId:"desktop_1"},{clientId:"phone_1"}],run=h.behavior(patched(),data);run.error("phone_1");await tick();assert.equal(run.query.data,data);assert.equal(run.query.invalidated,undefined);assert.deepEqual(run.writes,[]);assert.deepEqual(run.events,["analytics:failed","warning","toast:error"]);
 const ssh={data:[{clientId:"ssh_client"}],setData(fn){this.data=fn(this.data)},invalidate(){this.invalidated=true}};h.nativeSshCallback(ssh)("ssh_client");assert.deepEqual(clean(ssh.data),[]);assert.equal(ssh.invalidated,true);assert.deepEqual(run.writes,[]);
 // The owned call occurs once inside the local row slot. SSH and every other
 // renderer branch remain identical; outbound operation policy is unchanged.
 const output=patched(),module=h.snapshots(output).owner[0].moduleSource;assert.equal(module.split(MARKER).length-1,2);assert.ok(module.includes(h.fixture.functions.ssh.source));
});

test("actual native await/dispose function disposes fulfilled and rejected write handles exactly once",async()=>{
 for(const reject of[false,true]){
  const calls=[],handle={then(resolve,failed){calls.push("await");reject?failed(Error("controlled async write failure")):resolve({success:true})},[Symbol.dispose](){calls.push("dispose")}},run=h.behavior(patched(),[{clientId:"phone_1"}],"desktop_1",{services:{applicationState:{write(key,value){calls.push([key,value]);return handle}}}});
  run.success("phone_1");assert.equal(run.query.invalidated,1);assert.equal(run.events.at(-1),"toast:success");await tick();assert.deepEqual(calls,[[KEY,false],"await","dispose"]);assert.deepEqual(clean(run.query.data),[]);assert.equal(run.events.includes("toast:error"),false);
 }
});

test("absent and synchronously failing state writers preserve successful revoke/invalidate flow",async()=>{
 for(const services of[{}, {applicationState:{}}, {applicationState:{write(){throw Error("controlled sync write failure")}}}, {applicationState:{write(){return Promise.resolve({success:false})}}}]){
  const run=h.behavior(patched(),[{clientId:"phone_1"}],"desktop_1",{services});assert.doesNotThrow(()=>run.success("phone_1"));await tick();assert.deepEqual(clean(run.query.data),[]);assert.equal(run.query.invalidated,1);assert.equal(run.events.at(-1),"toast:success");
 }
 const run=h.behavior(patched(),undefined);run.state.services=undefined;run.success("phone_1");await tick();assert.equal(run.query.data,undefined);assert.equal(run.state.reads,0);
});

test("late facade population and replacement are read at callback time",async()=>{
 const run=h.behavior(patched(),[{clientId:"phone_1"}]),seen=[];run.state.services={applicationState:{write(){seen.push("first");return Promise.resolve({success:true})}}};assert.equal(run.state.reads,0);run.success("phone_1");await tick();assert.deepEqual(seen,["first"]);
 run.query.data=[{clientId:"tablet_1"}];run.state.services={applicationState:{write(){seen.push("replacement");return Promise.resolve({success:true})}}};run.success("tablet_1");await tick();assert.deepEqual(seen,["first","replacement"]);assert.equal(run.state.reads,2);
});

test("wrong local query, identity, success/error policy or published caller refuses",()=>{
 const native=h.sources();for(const[from,to]of[
  ["ef=(0,u.Ul)(eh.y8)","ef=(0,u.Ul)(eh.MN)"],["$.query.snapshot(eh.y8)","$.query.snapshot(eh.MN)"],["ec=(0,u.Ul)(D.dZ)","ec=(0,u.Ul)(D.BJ)"],["(0,ew.uz)(ef.data,ec)","(0,ew.uz)(ef.data,undefined)"],
  ["x?.(\"succeeded\"),C(n)","x?.(\"failed\"),C(n)"],["onSuccess:n,onError:i","onSuccess:i,onError:n"],["remoteControl/client/revoke","remoteControl/client/delete"],["appServices:()=>o","appServices:()=>t"],["e[Symbol.dispose]?.()","e[Symbol.dispose]?.(),e[Symbol.dispose]?.()"],["\"control-this-mac\"===n9","\"access-other-devices\"===n9"],
 ]){const broken=change(native,text=>text.replace(from,to));assert.notDeepEqual(broken,native,from);rejected(broken);}
});

test("eager query/local/import and helper captures refuse while native component T/H shadows remain valid",()=>{
 const native=h.sources();assert.doesNotThrow(()=>prepare(h.snapshots(native)));
 for(const statement of["ec=foreign;","ej=foreign;","X=foreign;","\\u0065c=foreign;"]){const broken=change(native,text=>text.replace("let eS=m,",statement+"let eS=m,"));rejected(broken);}
 for(const statement of["T=foreign;","H=foreign;",`let ${MARKER};`,`\\u0063odexLinuxRemoteControlResetMobileSetupAfterRevoke=foreign;`])rejected(change(native,text=>text.replace("function ey(",statement+"function ey(")));
 rejected(change(native,text=>text.replace("function eR(e){",`function eR(e,${MARKER}){`)));
});

test("duplicate live function bindings, import collisions and factory captures refuse",()=>{
 const native=h.sources();for(const name of["eR","ey","eN","t8","eL","eE","T","H"]){const broken=change(native,(text,file)=>file==="async/owner.js"?text.replace("function ey(",`function ${name}(){return null}function ey(`):text);rejected(broken);}
 for(const name of["eR","ey","eN","t8"])rejected(change(native,(text,file)=>file==="async/owner.js"?text.replace("GrdY(e,t,n)",`GrdY(${name},t,n)`):text));
});

test("root head census rejects complex/default/generator shadows and keeps native frames",()=>{
 const native=h.sources(),first=prepare(h.snapshots(native)),output=h.transition(native,first);assert.equal(first.alreadyApplied,false);assert.equal(Buffer.byteLength(output["async/owner.js"])-Buffer.byteLength(native["async/owner.js"]),357);assert.deepEqual(h.transition(output,prepare(h.snapshots(output)),"nativeSource"),native);
 for(const name of["eR","ey","eN","t8","eL","eE","T","H"])for(const declaration of[`function ${name}(unused=()=>{}){return null}`,`function* ${name}(){return null}`])assert.throws(()=>prepare(h.snapshots(change(native,(text,file)=>file==="async/owner.js"?text.replace("function ey(",declaration+"function ey("):text))),/duplicate, captured or eagerly rewritten critical function|critical import collides with a root function/);
 for(const declaration of["function /*head*/ eR(unused=()=>{}){return null}","async function /*head*/ * /*name*/ eR /*args*/ (){return null}","function \\u0065R(unused=()=>{}){return null}"])rejected(change(native,(text,file)=>file==="async/owner.js"?text.replace("function ey(",declaration+"function ey("):text));
 const decoys='const opaque="function* eR(){return null}";/*function eR(unused=()=>{}){return null}*/function unrelated(unused=()=>{}){function* eR(){return null}}';assert.doesNotThrow(()=>prepare(h.snapshots(change(native,(text,file)=>file==="async/owner.js"?text.replace("function ey(",decoys+"function ey("):text))));
});

test("helper local names avoid renamed facade and awaiter import captures",async()=>{
 const native=change(h.sources(),(text,name)=>name==="async/owner.js"?text.replace("GrdY(e,t,n)","GrdY(module,t,n)").replace('T=n("GaA7")','e=n("GaA7")').replace('r=n("slpy")','NativePopover=n("slpy")').replaceAll("(0,r.m)","(0,NativePopover.m)").replace('H=n("q77y")','r=n("q77y")'):text),output=patched(native),declaration=h.helperSource(output),seen=[];
 assert.match(declaration,/AfterRevoke\(e\$,t,n\)/u);const fn=vm.runInNewContext(declaration+`;${MARKER}`,{e:{appServices:{applicationState:{write(key,value){seen.push([key,value]);return Promise.resolve({success:true})}}}},r:{P:h.actualAwaiter()}});assert.deepEqual(clean(fn([{clientId:"phone_1"}],"phone_1","desktop_1")),[]);await tick();assert.deepEqual(seen,[[KEY,false]]);assert.deepEqual(h.transition(output,prepare(h.snapshots(output)),"nativeSource"),native);
});

test("marker-only, partial, duplicate and tampered canonical contributions never authorize repeats",()=>{
 const output=patched();for(const mutate of[
  text=>text.replace('a.write("codex-mobile-has-connected-device",!1)','a.write("other-key",!1)'),text=>text.replace("(0,H.P)(a.write", "(0,H.wrong)(a.write"),text=>text.replace("if(i?.length===0)","if(i?.length!==0)"),text=>text.replace("}catch{}return r}","}catch{}return e}"),text=>text.replace(`function ${MARKER}(`,`/*${MARKER}*/function ${MARKER}(`),text=>text.replace(`function ${MARKER}(e,t,n){`,"function unrelated(e,t,n){"),
 ])rejected(change(output,mutate));
 rejected(change(h.sources(),text=>text.replace("function eR(e){",`function eR(e){const orphan=\"${MARKER}\";`)));
});

test("current copy changes compose in both orders without locking unrelated UI labels",()=>{
 const {applyLinuxRemoteControlCopyPatch:copy}=require("./patch.js"),native=h.sources(),copyFirst=change(native,copy),a=patched(copyFirst),b=change(patched(native),copy);assert.deepEqual(a,b);assert.deepEqual(patched(a),a);assert.deepEqual(h.transition(a,prepare(h.snapshots(a)),"nativeSource"),copyFirst);
 const label=change(native,text=>text.replace("Devices that can control this Mac","Custom local device list title"));assert.doesNotThrow(()=>prepare(h.snapshots(label)));
});

test("all physical providers and facade copies validate atomically before writes",()=>temporary(root=>{
 const native=h.sources(),assets=h.writeApp(root,native),plan=prepare(h.snapshots(native)),facadeNames=Object.entries(h.snapshots(native).facade).map(([,copy])=>copy.assetName);assert.equal(facadeNames.length,2);
 const broken={...native,[facadeNames[1]]:native[facadeNames[1]].replace("appServices:()=>i","appServices:()=>n")};rejected(broken);
 const stale=h.snapshots(native);stale.catalog[0]={...stale.catalog[0],start:1};assert.throws(()=>prepare(stale),/stale/);
 fs.appendFileSync(path.join(assets,facadeNames[1]),"\n// changed facade dependency");assert.throws(()=>patchWebviewAssets(assets,plan.edits),/changed before patch commit/);assert.equal(fs.readFileSync(path.join(assets,"async/owner.js"),"utf8"),native["async/owner.js"]);
}));

test("discovery prefilters keep large and semantically unrelated modules out of lexical qualification",()=>temporary(root=>{
 const filename=path.join(__dirname,"revoke-setup-reset-owner.js"),localRequire=require("node:module").createRequire(filename),lexical=localRequire("../../scripts/patches/lib/minified-js.js"),seen=[];
 const observed={...lexical,createJavaScriptLexicalIndex(source){if(source.includes("UP86_QUALIFICATION_DECOY"))seen.push(Buffer.byteLength(source));return lexical.createJavaScriptLexicalIndex(source)}};
 const owned={exports:{}};vm.runInNewContext("(function(require,module,exports){"+fs.readFileSync(filename,"utf8")+"\n})",{Buffer})((name)=>name==="../../scripts/patches/lib/minified-js.js"?observed:localRequire(name),owned,owned.exports);
 const native=h.sources(),needles="RemoteConnectionsSettings localRemoteControlClientId: localRemoteControlEnvironmentId remoteControlState onRevokeResult: remote-control-clients waiting-for-added refetchInterval remoteControl/client/list remoteControl/client/revoke revokeTarget connected dismiss clientId throwIfAborted addEventListener removeEventListener dispose setAppServices appServices:",large=`const marker="UP86_QUALIFICATION_DECOY_LARGE";const words=${JSON.stringify(needles)};const payload=${JSON.stringify("x".repeat(256*1024+64))};`,unicode=`const marker="UP86_QUALIFICATION_DECOY_UTF8";const words=${JSON.stringify(needles)};const payload=${JSON.stringify("é".repeat(9000))};`,small='const marker="UP86_QUALIFICATION_DECOY_SMALL";const words="localRemoteControlClientId waiting-for-added remoteControl/client/revoke connected dismiss throwIfAborted setAppServices appServices:";';
 native["async/discovery-decoys.js"]=h.chunk(991,[{moduleId:"largeUnrelated",params:["e","t","n"],moduleSource:large},{moduleId:"utf8Unrelated",params:["e","t","n"],moduleSource:unicode},{moduleId:"smallUnrelated",params:["e","t","n"],moduleSource:small}]);const assets=h.writeApp(root,native),plan=owned.exports.locateRevokeSetupReset(assets);
 assert.equal(plan.alreadyApplied,false);assert.equal(plan.edits.filter(row=>row.source!==row.patchedSource).length,1);assert.deepEqual(seen,[]);for(const[name,text]of Object.entries(native))assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),text);
}));

test("discovery still collects hidden malformed and over-cap same-ID peers before final rejection",()=>{
 for(const [moduleId,body]of[["xS4d","const hidden=true;"],["q77y","const hidden=true;"],["GrdY","const hidden=true;"],["xS4d",`const payload=${JSON.stringify("é".repeat(9000))};`],["GrdY",`const payload=${JSON.stringify("x".repeat(256*1024+1))};`]])temporary(root=>{
  const native=h.sources();native["async/hidden-peer.js"]=h.chunk(992,[{moduleId,params:["e","t","n"],moduleSource:body}]);const assets=h.writeApp(root,native);assert.throws(()=>apply(root),/Remote revoke setup-reset contract/);for(const[name,text]of Object.entries(native))assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),text);
 });
});

test("interrupted owner write rolls back bytes and modes, then actual adapter first/repeat succeeds",()=>temporary(root=>{
 const native=h.sources(),assets=h.writeApp(root,native);let writes=0;assert.throws(()=>apply(root,{writeFileSync(file,bytes){if(++writes===1){fs.writeFileSync(file,bytes.subarray(0,9));throw Error("controlled interrupted revoke write")}fs.writeFileSync(file,bytes)}}),/controlled interrupted revoke write/);
 for(const[name,text]of Object.entries(native)){assert.equal(fs.readFileSync(path.join(assets,name),"utf8"),text);assert.equal(fs.statSync(path.join(assets,name)).mode&0o777,0o640);}
 assert.equal(apply(root).changed,1);assert.equal(apply(root).changed,0);fs.writeFileSync(path.join(assets,"async/orphan.js"),`/*${MARKER}*/`);assert.throws(()=>apply(root),/orphan/);
}));
