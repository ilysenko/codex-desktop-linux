"use strict";
// Exact bounded current native refresh/effect bridges; no whole component grammar.
module.exports = {
  "version": "26.1103.32239",
  "nativeEffect": "()=>{let e=null,t=!1,n=window.setInterval(()=>{(async()=>{t||(t=!0,e=new AbortController,await (async()=>{await oI(e.signal)})().finally(()=>{e=null,t=!1}))})()},15e3);return()=>{e?.abort(),window.clearInterval(n)}}",
  "patchedEffect": "()=>{let e=null,t=!1,codexLinuxRemoteConnectionsRefresh=async()=>{t||(t=!0,e=new AbortController,await(async()=>{await oI(e.signal)})().finally(()=>{e=null,t=!1}))},codexLinuxRemoteConnectionsRefreshTimer=null,codexLinuxRemoteConnectionsRefreshLast=0,codexLinuxRemoteConnectionsRefreshNow=()=>{if(document.visibilityState===`hidden`)return;let e=Date.now(),t=()=>{codexLinuxRemoteConnectionsRefreshLast=Date.now(),codexLinuxRemoteConnectionsRefreshTimer=null,codexLinuxRemoteConnectionsRefresh()};if(e-codexLinuxRemoteConnectionsRefreshLast<1e3){codexLinuxRemoteConnectionsRefreshTimer!=null&&window.clearTimeout(codexLinuxRemoteConnectionsRefreshTimer),codexLinuxRemoteConnectionsRefreshTimer=window.setTimeout(t,1e3-(e-codexLinuxRemoteConnectionsRefreshLast));return}t()},n=window.setInterval(()=>{codexLinuxRemoteConnectionsRefresh()},5e3);document.addEventListener(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow),window.addEventListener(`focus`,codexLinuxRemoteConnectionsRefreshNow),window.addEventListener(`online`,codexLinuxRemoteConnectionsRefreshNow),window.addEventListener(`resume`,codexLinuxRemoteConnectionsRefreshNow);return()=>{e?.abort(),window.clearInterval(n),codexLinuxRemoteConnectionsRefreshTimer!=null&&window.clearTimeout(codexLinuxRemoteConnectionsRefreshTimer),document.removeEventListener(`visibilitychange`,codexLinuxRemoteConnectionsRefreshNow),window.removeEventListener(`focus`,codexLinuxRemoteConnectionsRefreshNow),window.removeEventListener(`online`,codexLinuxRemoteConnectionsRefreshNow),window.removeEventListener(`resume`,codexLinuxRemoteConnectionsRefreshNow)}}",
  "nativeHandler": "async e=>{if(!op)try{let t=[];if(e.aborted||T.appServices?.sshConnections==null||t.push(T.appServices.sshConnections.refresh()),nF){let n=T.appServices.remoteConnections;null!=n&&t.push((0,H.P)(n.refreshRemoteControl(),e))}await Promise.all(t)}catch(e){if(e instanceof DOMException&&\"AbortError\"===e.name)return;W.v.debug(\"[remote-connections/settings] auto_refresh_failed\",{safe:{},sensitive:{error:e}})}}",
  "effectBridge": "tw[133]!==oI?(eB=\"__OWNED_REFRESH_EFFECT__\",tw[133]=oI,tw[134]=eB):eB=tw[134],tw[135]===Symbol.for(\"react.memo_cache_sentinel\")?(eX=[],tw[135]=eX):eX=tw[135],(0,h.useEffect)(eB,eX)",
  "handlerBridge": "tw[130]!==op||tw[131]!==nF?(eZ=\"__NATIVE_REFRESH_HANDLER__\",tw[130]=op,tw[131]=nF,tw[132]=eZ):eZ=tw[132];let oI=(0,h.useEffectEvent)(eZ)",
  "pendingSource": "op=oi.isPending||or.isPending||oa.isPending||ol.isPending||oc.isPending||od.isPending||ou.isPending||om.isPending||og.isPending||oh.isPending",
  "nativeMemoCapacity": 351,
  "nativeAvailability": "nF=(0,tK.wi)()",
  "nativeEventDeclaration": "oI=(0,h.useEffectEvent)(eZ)",
  "awaiter": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "n.d(t,{},{P:async function(e,t){let n=!1,i=()=>{n||(n=!0,e[Symbol.dispose]?.())};t?.addEventListener(\"abort\",i,{once:!0});try{t?.throwIfAborted();let n=await e;return t?.throwIfAborted(),n}finally{t?.removeEventListener(\"abort\",i),i()}}})"
  },
  "nativeOwnerModuleSha256": "d8ce410a1c4e86e010d28448b6620239eb94ab1398bcbc6f202d63a4814dc63d",
  "nativeLoggerId": "WFY2",
  "expectedDeltaBytes": 1393,
  "policy": "Preserve current canonical +1393B runtime postimage; qualify only current native modern effect/callers. No legacy bare-string or marker-only success."
};
