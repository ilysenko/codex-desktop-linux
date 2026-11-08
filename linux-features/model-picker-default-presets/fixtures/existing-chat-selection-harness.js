"use strict";
const assert=require("node:assert/strict"),vm=require("node:vm");
const {createExistingChatSelectionRuntime}=require("../existing-chat-selection-runtime.js");
const native=require("../../copilot-reasoning-effort/fixtures/current-native-persistence.json").snippets;
const settings=require("../../../scripts/patches/lib/fixtures/current-model-composer.json").settings;
const owner=require("../../../scripts/patches/lib/model-composer-owners.js").inspectModelSettingsOwner(settings);
const plain=value=>JSON.parse(JSON.stringify(value));
const compile=(source,context)=>new vm.Script(`(${source})`).runInNewContext(context,{timeout:2000});
const ids=["model-new:high","model-new:extended","model-B:low","model-B:min","model-none:none","model-none:zero"];
const aliases=[["zero","none"],["min","low"],["standard","medium"],["extended","high"]];

// Only actual small native callbacks, queue, target and selection expression
// run here. This is a controlled caller contract for the pure runtime, not an
// upstream-factory, backend, GUI, or final source-adapter execution.
function scene(options={}) {
  const runtime=options.runtime??createExistingChatSelectionRuntime(ids,aliases);
  const values=new Map(),timers=new Map(),rpc=[],errors=[],calls=[],events=[],refs=[],effects=[];
  let timerId=0,refIndex=0,effectIndex=0,phase="idle",rendering=false;
  const state={active:options.active??true,conversation:"thread-A",host:"host-A",profile:"profile-A",
    auth:{authMethod:"chatgpt",accountId:"account-A"},chatGpt:true,ready:true,
    metadata:{model:"old-model",effort:"medium"},defaultModel:"config-old",defaultEffort:"low",queueNoWrite:false};
  let lease,current,next,target,enqueue;
  const key=(atom,value)=>JSON.stringify([atom,value]);
  const C={EX:"pending",si:"writing",pu:"tier",BG:compile(native.BG.text,{})};
  function read() {
    const base=compile(native.effectiveBase.text,{eN:true,eK:state.metadata.model,
      eH:state.metadata.effort,eA:{model:state.defaultModel,reasoningEffort:state.defaultEffort,
        profile:state.profile,isLoading:false},eO:state.ready,eF:{},eb:false,e:state.conversation});
    const mixer=settings.moduleSource.slice(owner.effectiveSettings.range.start,owner.effectiveSettings.range.end);
    return plain(new vm.Script(`${mixer};k`).runInNewContext({q:[],eS:null,eV:Q.get(C.EX,target)??Q.get(C.si,target),eD:target,eQ:base,k:undefined}));
  }
  const Q={
    get(atom,value){
      if(atom==="active")return state.active;
      if(atom==="queue"&&state.queueNoWrite)return request=>request.resolve(false);
      if(atom==="queue"&&!values.has(key(atom,value)))values.set(key(atom,value),enqueue(null,{scope:Q}));
      return values.get(key(atom,value))??null;
    },
    set(atom,value,selection){
      assert.notEqual(phase,"render","the feature must not write atoms during render");
      values.set(key(atom,value),selection);
      if(target!=null)events.push({phase,atom,visible:read()});
      if(!rendering&&target!=null){render();flush();}
    },
  };
  enqueue=compile(native.queue.text,{a:C.EX,o:C.si,
    setTimeout(fn,delay){calls.push(["timer",delay]);timers.set(++timerId,fn);return timerId},
    clearTimeout(id){timers.delete(id)}});
  C.HM=compile(native.HM.text,{s:"queue"});
  const React={
    useRef(initial){const at=refIndex++;return refs[at]??(refs[at]={current:initial})},
    useLayoutEffect(fn,deps){const at=effectIndex++,old=effects[at];
      if(!old||deps.some((value,index)=>!Object.is(value,old.deps[index])))effects[at]={fn,deps,cleanup:old?.cleanup,pending:true};},
  };
  function flush(){for(const effect of effects)if(effect.pending){effect.pending=false;effect.cleanup?.();
    const previous=phase;phase="layout";try{effect.cleanup=effect.fn()}finally{phase=previous}}}
  function callbacks(){
    const environment={Q,C,Runtime:runtime,lease,target,e:state.conversation,eN:true,eO:state.ready,
      ec:state.host,eI:"/active",ej:state.chatGpt,j:{OS(_,thread,model){calls.push(["notify",thread,model])}},
      f:{Y:"native-mode"},u:{V(_,host){return{updateThreadSettingsForNextTurn(thread,settings){
        calls.push(["rpc",host,thread,plain(settings)]);
        return new Promise((resolve,reject)=>rpc.push({resolve,reject}));}}}},
      eZ(error){errors.push(error.message)},eA:{profile:state.profile},ex:false,ey:false,el:false,e_:false,
      A:{D0:"active"},em:()=>true,ef:()=>false,Error,Promise};
    if(options.nativeCallbacks){
      const supplied=options.nativeCallbacks;
      environment[supplied.locals.runtime]=runtime;environment[supplied.locals.lease]=lease;
      environment[supplied.effectiveTarget]=target;
      environment.eq=compile(supplied.rpc,environment);
      environment.eY=compile(supplied.next,environment);environment.eJ=compile(supplied.writer,environment);
      current=compile(supplied.current,environment);next=environment.eY;return;
    }
    environment.eq=compile(native.rpc.text,environment);
    let direct=native.nextTurn.text;
    direct=direct.replace("};void 0!==a.serviceTier","};let ticket=Runtime.begin(lease,{store:Q,target:n,selection:a,hostId:ec});void 0!==a.serviceTier");
    direct=direct.replace("})().finally(","})().then(()=>{Runtime.directSucceeded(ticket)}).finally(");
    direct=direct.replace("Q.set(C.EX,n,null)})}","Q.set(C.EX,n,null)}).finally(()=>{Runtime.finished(ticket)})}");
    assert.notEqual(direct,native.nextTurn.text);
    environment.eY=compile(direct,environment);
    let writer=settings.moduleSource.slice(owner.default.writer.start,owner.default.writer.end).replace(/^[^=]+=/u,"");
    const invocation="eq(e,l,void 0===i?void 0:{threadSettings:{serviceTier:i}})";
    assert.equal(writer.split(invocation).length,2);
    writer=writer.replace(invocation,invocation+".then(result=>Runtime.queuedResult(Q,C.si,target,result))");
    environment.eJ=compile(writer,environment);
    const call='return(0,C.HM)(Q,n,{model:l,reasoningEffort:t,serviceTier:a},()=>eJ(l,t,"current",a))';
    const queued=native.current.text.replace(call,
      'let ticket=Runtime.begin(lease,{store:Q,target:n,selection:{model:l,reasoningEffort:t,serviceTier:a},hostId:ec});'+call+
      '.then(Runtime.bindQueued(ticket,Q.get(C.EX,n))).finally(()=>{Runtime.finished(ticket)})');
    assert.notEqual(queued,native.current.text);
    current=compile(queued,environment);next=environment.eY;
  }
  function render(){const previous=phase;phase="render";rendering=true;refIndex=0;effectIndex=0;
    try{
      target=C.BG({conversationId:state.conversation,hasConversation:true,hostId:state.host,cwd:"/active"});
      if(options.nativeCallbacks){
        const supplied=options.nativeCallbacks;
        const environment={Q,C,s:React,eD:target,ec:state.host,e:state.conversation,
          eA:{profile:state.profile},eh:state.auth,ej:state.chatGpt,eN:true,eO:state.ready,
          eK:state.metadata.model,eH:state.metadata.effort,eR:Q.get(C.EX,target),ez:Q.get(C.si,target)};
        environment[supplied.locals.runtime]=runtime;
        lease=new vm.Script(supplied.hook+`;${supplied.locals.lease}`).runInNewContext(environment);
      }else{
      lease=runtime.use(React,{store:Q,pendingAtom:C.EX,writingAtom:C.si,target,hostId:state.host,
        conversationId:state.conversation,profile:state.profile,authIdentity:state.auth,
        chatGpt:state.chatGpt,hasConversation:true,ready:state.ready,
        metadataModel:state.metadata.model,metadataEffort:state.metadata.effort,
        pending:Q.get(C.EX,target),writing:Q.get(C.si,target)});
      }
      callbacks();
    }finally{rendering=false;phase=previous}}
  render();flush();
  return {state,Q,C,rpc,errors,calls,events,read,runtime,
    current:(...args)=>current(...args),next:(...args)=>next(...args),
    pending:()=>Q.get(C.EX,target),writing:()=>Q.get(C.si,target),target:()=>target,
    refresh(){render();flush()},unmount(){for(const effect of effects)effect.cleanup?.()},
    speculate(field,value){const prior=state[field],savedEffects=effects.map(effect=>({...effect})),
      savedCurrent=current,savedNext=next,savedTarget=target;
      state[field]=value;render();state[field]=prior;current=savedCurrent;next=savedNext;target=savedTarget;
      effects.splice(0,effects.length,...savedEffects);},
    replayEffects(){for(const effect of effects)effect.cleanup?.();for(const effect of effects)effect.cleanup=effect.fn()},
    async drive(){for(const[id,fn]of [...timers]){timers.delete(id);fn()}for(let i=0;i<25;i++)await Promise.resolve()},
  };
}

module.exports={scene,ids,aliases,plain};
