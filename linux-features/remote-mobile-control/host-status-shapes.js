"use strict";

// Current signed native host status contract, used as source data only.
module.exports = {
  "params": [
    "e",
    "t",
    "n"
  ],
  "moduleSource": "var r=n(\"zTeN\"),i=n(\"dbK8\"),a=n(\"q77y\"),s=n(\"OWtl\"),o=n(\"WFY2\");class l extends Error{constructor(){super(\"Remote control failed to connect\"),this.name=\"RemoteControlConnectionFailedError\"}}let u=(0,r.bD)(s.u,e=>null),d=(0,r.bD)(s.u,e=>!1),c=(0,r.i1)(s.u,(e,{get:t})=>{let n=t(u,e);return!t(d,e)&&(n?.status===\"connecting\"||n?.status===\"connected\")});function p(e,t,n){n?.status===\"connected\"&&e.set(d,t,!1),e.set(u,t,n)}function h(e,t){if(null==e||\"connecting\"===e.status||\"disabled\"===e.status||e===t)return null;switch(e.status){case\"connected\":return e;case\"errored\":return new l}}n.d(t,{},{AP:u,Hf:function(e,t,{ignoreCurrentError:n=!1}={}){let r=e.get(u,t),i=n&&r?.status===\"errored\"?r:null,a=h(r,i);return a instanceof Error?Promise.reject(a):null!=a?Promise.resolve(a):new Promise((n,r)=>{let a,s=!1,o=e=>{s||(s=!0,clearTimeout(l),a?.(),e instanceof Error?r(e):n(e))},l=setTimeout(()=>{o(Error(\"Timed out waiting for remote control to connect\"))},5e3);a=e.watch(({get:e})=>{let n=h(e(u,t),i);null!=n&&o(n)}),s&&a()})},Lt:p,TV:l,UL:function(e,t,n,r){let s;if((0,i.C)(t))return()=>{};let l=new AbortController,d=()=>!l.signal.aborted&&(r?.()??!0),c=e.get(u,t),h=n.subscribe({type:\"notification\",key:{hostId:t},methods:\"remoteControl/status/changed\",listener:({params:n})=>{d()&&p(e,t,n)}}),f=()=>{l.signal.aborted||(l.abort(),h[Symbol.dispose](),s?.[Symbol.dispose]())};return h.onRpcBroken(f),h.then(e=>{d()?(s=e,e.onRpcBroken(f)):e[Symbol.dispose]()},f),(0,a.P)(n.sendRequest(\"remoteControl/status/read\",void 0),l.signal).then(n=>{e.get(u,t)===c&&d()&&p(e,t,n)}).catch(e=>{d()&&o.v.error(\"Failed to read remote-control status\",{safe:{},sensitive:{error:e}})}),f},UV:function(e,t,n){e.set(d,t,n)},Zg:c})"
};
