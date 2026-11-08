"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createExistingChatSelectionRuntime}=require("./existing-chat-selection-runtime.js");
const {scene,ids,aliases,plain}=require("./fixtures/existing-chat-selection-harness.js");
const vm=require("node:vm");
const compile=(source,context)=>new vm.Script(`(${source})`).runInNewContext(context,{timeout:2000});

test("active native rejection clears the attempted pair and keeps the native error path",async()=>{
  const s=scene(),pending=s.current("model-new","high");s.rpc[0].reject(Error("native rejected"));
  assert.equal(await pending,false);assert.equal(s.pending(),null);assert.equal(s.read().model,"old-model");
  assert.deepEqual(s.errors,["native rejected"]);assert.equal(s.calls.filter(row=>row[0]==="rpc").length,1);
});
test("active success keeps the same fields before native finally, with no stale intermediate store snapshot",async()=>{
  const s=scene(),pending=s.current("model-new","high"),nativePending=s.pending();s.events.length=0;
  s.rpc[0].resolve();assert.equal(await pending,true);assert.notEqual(s.pending(),nativePending);
  assert.equal(s.read().model,"model-new");assert.equal(s.read().reasoningEffort,"high");
  assert(s.events.every(event=>event.visible.model==="model-new"));
  assert.equal(Object.hasOwn(s.pending(),"codexLinuxKeepOptimisticSelection"),false);
});
test("ordinary native queue promotes before its existing cleanup and does not emit stale metadata",async()=>{
  const s=scene({active:false}),pending=s.current("model-new","high");await s.drive();s.events.length=0;
  s.rpc[0].resolve();assert.equal(await pending,true);assert.equal(s.read().model,"model-new");
  assert(s.events.every(event=>event.visible.model==="model-new"));assert.equal(s.writing(),null);
  assert.deepEqual(s.calls.filter(row=>row[0]==="timer"),[["timer",320]]);
});
test("real metadata acknowledgement releases the hold and later native refresh remains visible",async()=>{
  const s=scene(),pending=s.current("model-new","high");s.rpc[0].resolve();await pending;
  s.state.metadata={model:"model-new",effort:"high"};s.refresh();assert.equal(s.pending(),null);
  s.state.metadata={model:"later-native",effort:"low"};s.refresh();assert.equal(s.read().model,"later-native");
});
test("account-default fallback equality is not a thread metadata acknowledgement",async()=>{
  const s=scene();s.state.metadata={model:null,effort:null};s.state.defaultModel="model-new";
  s.state.defaultEffort="high";s.refresh();const pending=s.current("model-new","high");
  s.rpc[0].resolve();await pending;s.refresh();assert(s.pending());
  s.state.metadata={model:"model-new",effort:"high"};s.refresh();assert.equal(s.pending(),null);
});
test("acknowledgement before RPC completion cannot later mask a newer metadata refresh",async()=>{
  for(const active of [true,false]){
    const s=scene({active}),pending=s.current("model-new","high");if(!active)await s.drive();
    s.state.metadata={model:"model-new",effort:"high"};s.refresh();
    s.state.metadata={model:"later-native",effort:"low"};s.refresh();
    s.rpc[0].resolve();await pending;assert.equal(s.pending(),null);assert.equal(s.read().model,"later-native");
  }
});
test("older success or rejection cannot replace a newer outside-list intent",async()=>{
  for(const reject of [true,false]){
    const s=scene(),old=s.current("model-new","high"),latest=s.current("outside-list","low");
    s.rpc[1].resolve();await latest;
    if(reject)s.rpc[0].reject(Error("older failure"));else s.rpc[0].resolve();
    await old;assert.equal(s.pending(),null);assert.equal(s.read().model,"old-model");
  }
});
test("older completion cannot clear or replace the newer successful configured choice",async()=>{
  for(const reject of [true,false]){
    const s=scene(),old=s.current("model-new","high"),latest=s.current("model-B","low");
    s.rpc[1].resolve();await latest;const held=s.pending();
    if(reject)s.rpc[0].reject(Error("older failure"));else s.rpc[0].resolve();
    await old;assert.equal(s.pending(),held);assert.equal(s.read().model,"model-B");
  }
});
test("native queue coalescing preserves the latest configured choice without an extra write",async()=>{
  const s=scene({active:false}),old=s.current("model-new","high"),latest=s.current("model-B","low");
  assert.equal(await old,false);await s.drive();assert.equal(s.rpc.length,1);
  s.rpc[0].resolve();assert.equal(await latest,true);assert.equal(s.read().model,"model-B");
});
test("host profile auth and readiness transitions invalidate an earlier pending request even after switching back",async()=>{
  for(const field of ["host","profile","auth","ready","conversation"]){
    const s=scene(),old=s.current("model-new","high"),prior=s.state[field];
    s.state[field]=field==="auth"?{authMethod:"chatgpt",accountId:"other-account"}:
      field==="ready"?false:"other-"+field;s.refresh();s.state[field]=prior;s.refresh();
    s.rpc[0].resolve();await old;assert.equal(s.pending(),null,field);
    assert.equal(s.calls.filter(row=>row[0]==="rpc").length,1);
  }
});
test("an aborted host render does not replace the committed lease or discard its successful request",async()=>{
  const s=scene(),pending=s.current("model-new","high");s.speculate("host","uncommitted-host");
  s.rpc[0].resolve();await pending;assert.equal(s.read().model,"model-new");assert(s.pending());
  assert.equal(s.calls.find(row=>row[0]==="rpc")[1],"host-A");
});
test("an event before the initial layout commit leaves native behavior available without publishing a feature hold",()=>{
  const runtime=createExistingChatSelectionRuntime(ids,aliases),writes=[],store={get:()=>null,set:(...args)=>writes.push(args)};
  const lease=runtime.use({useRef:()=>({current:null}),useLayoutEffect(){}},{store,pendingAtom:"pending",writingAtom:"writing",
    target:["conversation","thread"],hostId:"host",conversationId:"thread",chatGpt:true,hasConversation:true,ready:true});
  const ticket=runtime.begin(lease,{store,target:["conversation","thread"],hostId:"host",selection:{model:"model-new",reasoningEffort:"high"}});
  assert.doesNotThrow(()=>{runtime.directSucceeded(ticket);runtime.finished(ticket)});assert.deepEqual(writes,[]);
});
test("actual native HM dispatch under a no-write false provider cannot orphan a preceding hold",async()=>{
  const s=scene(),old=s.current("model-new","high");s.rpc[0].resolve();await old;assert(s.pending());
  // The native producer normally publishes EX before resolving any request.
  // This scope-provider control keeps HM itself real and exercises the pure
  // manager's no-publication boundary without claiming a released queue bug.
  s.state.active=false;s.state.queueNoWrite=true;s.refresh();
  assert.equal(await s.current("outside-list","low"),false);assert.equal(s.pending(),null);
  s.state.metadata={model:"model-new",effort:"high"};s.refresh();
  s.state.metadata={model:"later-native",effort:"low"};s.refresh();assert.equal(s.read().model,"later-native");
});
test("unmount releases only an owned hold and prevents an unfinished request from retaining later",async()=>{
  const ready=scene(),a=ready.current("model-new","high");ready.rpc[0].resolve();await a;
  ready.unmount();assert.equal(ready.pending(),null);
  const pending=scene(),b=pending.current("model-new","high");pending.unmount();
  pending.rpc[0].resolve();await b;assert.equal(pending.pending(),null);
});
test("effect teardown/setup cancels older work and permits a new native choice",async()=>{
  const s=scene(),old=s.current("model-new","high");s.replayEffects();
  s.rpc[0].resolve();await old;assert.equal(s.pending(),null);
  const latest=s.current("model-B","low");s.rpc[1].resolve();await latest;
  assert.equal(s.read().model,"model-B");assert(s.pending());
});
test("native thread target RPC arguments and service tier remain unchanged",async()=>{
  const s=scene(),pending=s.next("model-new","high",{threadSettings:{serviceTier:"priority",nativeExtra:"keep"}});
  s.rpc[0].resolve();await pending;
  assert.deepEqual(plain(s.target()),["conversation","thread-A"]);
  assert.deepEqual(s.calls.filter(row=>row[0]==="rpc"),[["rpc","host-A","thread-A",
    {serviceTier:"priority",nativeExtra:"keep",model:"model-new",effort:"high",multiAgentMode:"native-mode"}]]);
  assert.equal(s.pending().serviceTier,"priority");
});
test("non-ChatGPT calls follow native cleanup and native/public effort aliases acknowledge the same pair",async()=>{
  const s=scene();s.state.chatGpt=false;s.state.auth={authMethod:"apikey"};s.refresh();
  const pending=s.current("model-new","high");s.rpc[0].resolve();await pending;assert.equal(s.pending(),null);
  const t=scene(),next=t.current("model-new","extended");t.rpc[0].resolve();await next;
  t.state.metadata={model:"model-new",effort:"high"};t.refresh();assert.equal(t.pending(),null);
});
test("native not-resumed readiness still refuses the write and keeps no feature hold",async()=>{
  const s=scene();s.state.ready=false;s.refresh();
  assert.equal(await s.current("model-new","high"),false);
  assert.equal(s.rpc.length,0);assert.equal(s.pending(),null);
  assert.deepEqual(s.errors,["No conversation available for next-turn model update"]);
});
test("the serialized runtime is self-contained and independent native stores do not share tickets",async()=>{
  const factory=compile(createExistingChatSelectionRuntime.toString(),{}),runtime=factory(ids,aliases);
  const a=scene({runtime}),b=scene({runtime}),pending=a.current("model-new","high");
  a.rpc[0].resolve();await pending;assert.equal(a.read().model,"model-new");
  assert.equal(b.pending(),null);assert.equal(b.read().model,"old-model");
});
