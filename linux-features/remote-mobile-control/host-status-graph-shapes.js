"use strict";

// Bounded current native lifecycle interfaces; source data, never executed here.
module.exports = {
  "manager": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "n.d(t,{L:()=>S,C:()=>b});var r=n(\"SRbQ\"),i=n(\"DBCl\"),a=n(\"YLui\"),s=n(\"oOJX\");function o(e,t,n){e(\"electron-app-state-snapshot-trigger\",{hostId:t,reason:n})}var l=n(\"NFzp\"),u=n(\"uku1\"),d=n(\"GLfw\"),c=n(\"l00C\"),p=n(\"CfsC\"),h=n(\"tl5a\"),f=n(\"J8Ro\"),m=n(\"Ojh9\"),_=n(\"w0gB\"),g=n(\"CSxw\"),v=n(\"c9K0\"),y=n(\"GCVk\"),E=n(\"TL6G\"),I=n(\"CnQ6\"),C=n(\"NnGo\");let T=250;var A=n(\"GaA7\");function S(e){let t,n,S,b,w,O,R,P,N,k,D=A.appServices.appServerManagers;if(null==D)throw Error(\"Desktop host did not provide its AppServerManager service\");return t=D.dup(),n=new Map,S=e.get(u.Qc),b=!1,w=(t,n,r)=>{let i=n.connection;n.connection=null,e.set(c.M4,t,{status:r,client:null}),i?.stop(),i?.client[Symbol.dispose]()},O=(t,n)=>{clearTimeout(n.retryTimer),n.active&&(n.active=!1,e.set(d.bj,t,null),n.stopAccountAuth?.(),n.stopAccountAuth=null,n.account?.[Symbol.dispose](),n.account=null,w(t,n,\"disconnected\"),n.pending?.[Symbol.dispose](),n.lease?.[Symbol.dispose]())},R=(r,p=T)=>{let A={account:null,stopAccountAuth:null,active:!0,connection:null,pending:null,lease:null};n.set(r,A);let P=()=>{if(!A.active||(O(r,A),b||n.get(r)!==A))return;let e=null==A.lease?p:T;A.retryTimer=setTimeout(()=>R(r,Math.min(2*e,1e4)),e)},N=t.subscribe(r,n=>{let p,T;if(b||!A.active)return;if(w(r,A,\"ready\"===n.status?\"replaced\":n.status),\"disconnected\"===n.status)e.set(d.bj,r,null),A.stopAccountAuth?.(),A.stopAccountAuth=null,A.account?.[Symbol.dispose](),A.account=null;else if(null==A.account){A.account=t.openAccount(r);let n={hostId:r,rpc:A.account};A.stopAccountAuth=(0,_.xG)(e,n),e.set(d.bj,r,n)}if(\"ready\"!==n.status)return;let O=n.manager.dup(),R=new l.W,N=[],k=[],D=new Map,x={client:O,sampler:R,reviewPaneSnapshotMetrics:{reviewDiffFilesTotal:0,reviewDiffLinesTotal:0,reviewDiffBytesEstimate:0},stop(){for(let[t,n]of(p?.(),T?.(),D))(0,v.sr)(e,t,n);for(let e of(D.clear(),N))e[Symbol.dispose]();for(let e of k)e[Symbol.dispose]()}};A.connection=x;let M=()=>A.connection===x;\"all\"===S&&N.push(O.subscribe({type:\"notification\",key:{hostId:r},methods:[\"item/agentMessage/delta\",\"item/plan/delta\",\"item/reasoning/summaryTextDelta\",\"item/reasoning/textDelta\",\"item/commandExecution/outputDelta\",\"item/fileChange/outputDelta\"],listener:({params:e})=>{M()&&R.recordDeltaBytes(e.delta)&&o((e,t)=>E.O1.dispatchMessage(e,t),r,\"delta_burst\")}}),O.subscribe({type:\"notification\",key:{hostId:r},methods:[\"thread/started\",\"turn/started\",\"turn/completed\"],listener:({method:e})=>{M()&&o((e,t)=>E.O1.dispatchMessage(e,t),r,{\"thread/started\":\"thread_started\",\"turn/started\":\"turn_started\",\"turn/completed\":\"turn_completed\"}[e])}})),\"all\"!==S||(0,g.NN)()||(y.U!==i.RlH&&(p=(0,s.Y)(e,r,O)),N.push(O.registerReplayAdmission((t,n)=>(0,I.n)(e,r,t,n)),O.subscribe({type:\"event\",key:{hostId:r},event:\"queued-message-execution\",listener:t=>{M()&&((0,a.zi)(t.message.context)&&(\"attempt\"===t.type?D.set(t.conversationId,t.message.id):D.get(t.conversationId)===t.message.id&&D.delete(t.conversationId)),(0,m.P)(e,r,t,(e,t)=>e(h.BP,{hostId:r,threadId:t}),(0,C.oI)()))}})));let L=()=>{M()&&P()};for(let e of N)e.onRpcBroken(L),e.then(e=>{M()?(k.push(e),e.onRpcBroken(L)):e[Symbol.dispose]()},L);if(O.onRpcBroken(L),!M())return;let U={hostId:r,rpc:O};T=e.watch(({get:t})=>{let n=t(u.lN),i=n?(0,f.x)(e,r,O,M):void 0;return M()&&\"ready\"!==e.get(c.M4,r).status&&e.set(c.M4,r,n||\"while-visible\"!==S&&\"while-active\"!==S?{status:\"ready\",client:U}:{status:\"request-only\",client:null,requestClient:U}),i}),M()||T()});A.pending=N,N.onRpcBroken(P),N.then(e=>{A.active?(A.lease=e,e.onRpcBroken(P)):e[Symbol.dispose]()},P)},P=e.watch(({get:e})=>{let t=(void 0)??e(p.D);for(let[e,r]of n)t.includes(e)||(O(e,r),n.delete(e));for(let e of t)n.has(e)||R(e)}),N=e=>{let t=n.get(e)?.connection;if(b||null==t)throw Error(`AppServerManager RPC is unavailable for hostId: ${e}`);return t},k={forHost:e=>N(e).client,async collectAppStateSnapshot(e,t){let n={stack:[],error:void 0,hasError:!1};try{let i=N(e),a=(0,r.mS)(n,await i.client.collectAppStateMetrics(i.reviewPaneSnapshotMetrics),!1);return i.sampler.collectSnapshot(t,a)}catch(e){n.error=e,n.hasError=!0}finally{(0,r.hk)(n)}},getReviewPaneSnapshotMetrics:e=>n.get(e)?.connection?.reviewPaneSnapshotMetrics,dispose(){if(!b){for(let[e,t]of(b=!0,P(),n))O(e,t);n.clear(),t[Symbol.dispose]()}}},t.onRpcBroken(()=>k.dispose()),k}function b(){return!1}"
  },
  "awaiter": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "n.d(t,{},{P:async function(e,t){let n=!1,i=()=>{n||(n=!0,e[Symbol.dispose]?.())};t?.addEventListener(\"abort\",i,{once:!0});try{t?.throwIfAborted();let n=await e;return t?.throwIfAborted(),n}finally{t?.removeEventListener(\"abort\",i),i()}}})"
  },
  "readCleanup": {
    "params": [
      "__nativeStatusModule",
      "__nativeStatusExports",
      "__nativeStatusRequire"
    ],
    "moduleSource": "let rp=[],rh=()=>{if(nX){for(let e of(nX=!1,clearTimeout(nD),clearTimeout(nz),ru.cancel(),nQ(),j?.(),n2(),n3?.dispose(),n4.dispose(),n5?.dispose(),n1.dispose(),n9?.(),n6(),nJ?.(),n0?.(),rn(),re(),n8?.(),n7(),rt?.(),ra.dispose(),ri))e[Symbol.dispose]();for(let e of(ri.clear(),rc))e[Symbol.dispose]();for(let e of rp)e[Symbol.dispose]();rp.length=0}};for(let e of rc)e.onRpcBroken(rh),e.then(e=>{nX?(rp.push(e),e.onRpcBroken(rh)):e[Symbol.dispose]()},rh);return rh"
  },
  "readPrefix": {
    "params": [
      "__nativeStatusModule",
      "__nativeStatusExports",
      "__nativeStatusRequire"
    ],
    "moduleSource": "var S,b,w,O,L;let U,G,F,H,B,q,j,ep,eh,eE,ev,eC,eU,eG,eF,eB,eq,eJ,e1,e7,te,ti,tP,nO,nR,nN,nD,nz,nX=!0,nZ=(0,th.PL)(e,t,i,()=>nX&&(A?.()??!0)&&(0,n_.oI)());!function(e){if(eK.has(e))return;eK.add(e);let t=!1;e.watch(({get:n})=>{let r=n(eY.AP,d.fI)?.status===\"connected\";r&&!t&&(0,e$.op)(e).catch(e=>{N.v.error(\"Failed to mark Codex mobile setup complete\",{safe:{},sensitive:{error:e}})}),t=r})}(e);let nQ=(0,eY.UL)(e,t,i,A)"
  }
};
