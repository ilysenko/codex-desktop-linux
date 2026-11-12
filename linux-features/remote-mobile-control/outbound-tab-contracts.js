"use strict";
// Bounded selected current native sites; full settings/UI/vendor modules remain outside this grammar.
module.exports = {
  "version": "26.1106.51428",
  "shapes": {
    "hZax": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "var r=n(\"QosV\"),i=n(\"JlWK\"),a=n(\"zTeN\"),s=n(\"zd8w\"),o=n(\"OMIV\");let l=(0,s.createContext)(!1);function u(){return f(),(0,i.useStatsigClient)()}function d(e,t,n){return e.getLayer(t,n)}function c(e){let t={};return Object.entries(e).forEach(([e,n])=>{(\"number\"==typeof n||\"string\"==typeof n||\"boolean\"==typeof n)&&(t[e]=String(n))}),t}function p(e,t){let n;return{...(n=e.getContext().user,{origin:`codex_${\"electron\".replace(\"-\",\"_\")}`,codex_window_type:\"electron\",...n?.appVersion?{app_version:n.appVersion}:{},...n?.locale?{browser_locale:n.locale}:{}}),...t}}function h(e,t,{value:n,metadata:r}={}){let i=c(p(e,r));e.logEvent(t,n,i)}function f(e){(0,s.useContext)(l)}n.d(t,{},{$R:p,AS:function(){return u().client},DR:function(e){return f(),(0,a._U)(o.dx,e)},Fj:function(e,t){let n,i=(0,r.c)(4),{getDynamicConfig:a}=u();return i[0]!==e||i[1]!==a||i[2]!==t?(n=a(e,t),i[0]=e,i[1]=a,i[2]=t,i[3]=n):n=i[3],n},Ks:function(e,t){return e.checkGate(t)},Ou:function(e,t){let n,i=(0,r.c)(8),{client:a,getLayer:s}=u();return i[4]!==a||i[5]!==e||i[6]!==t?(n=d(a,e,t),i[4]=a,i[5]=e,i[6]=t,i[7]=n):n=i[7],n},XM:d,XR:function(){return u().isLoading},Zj:function(e){let t,n=(0,r.c)(2);return f(\"string\"==typeof e),n[0]!==e?(t=\"boolean\"==typeof e?e:{cache:\"signal\",resolve:(t,n)=>o.JW.resolve(t,n,e).atom,scope:o.JW.scope},n[0]=e,n[1]=t):t=n[1],(0,a.Ul)(t)},cB:function(){return f(),(0,i.useStatsigUser)().user},cn:u,fd:function(){let e,t,n,i=(0,r.c)(7),{client:a}=u();i[0]!==a?(e=(e,t)=>{h(a,e,{metadata:t})},i[0]=a,i[1]=e):e=i[1];let s=e;i[2]!==a?(t=(e,t)=>h(a,e,t),i[2]=a,i[3]=t):t=i[3];let o=t;return i[4]!==s||i[5]!==o?(n={logEventWithStatsig:s,logValueEventWithStatsig:o},i[4]=s,i[5]=o,i[6]=n):n=i[6],n},hW:function(e,t,n){return e.getExperiment(t,n)},j3:l,ml:c})"
    },
    "wwME": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "var r=n(\"QosV\"),i=n(\"C4bN\"),a=n(\"XYHU\");n.d(t,{},{V:function(){let e,t,n,s=(0,r.c)(7),{data:o,isLoading:l}=(0,i.a)();if(s[0]!==o?.platform){let n=(0,a.tR)(o?.platform);e=n,t=\"macOS\"===n?\"⌘\":\"^\",s[0]=o?.platform,s[1]=e,s[2]=t}else e=s[1],t=s[2];return s[3]!==l||s[4]!==e||s[5]!==t?(n={platform:e,modifierSymbol:t,isLoading:l},s[3]=l,s[4]=e,s[5]=t,s[6]=n):n=s[6],n}})"
    },
    "XYHU": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "var r=n(\"zTeN\"),i=n(\"OWtl\"),a=n(\"wLMK\");let s=(0,r.un)(i.u,({get:e})=>o(e(a.V).data?.platform));function o(e){var t;let n;return null!=e&&\"web\"!==e?\"win32\"===(t=e)?\"windows\":\"darwin\"===t?\"macOS\":\"linux\":(n=\"u\"<typeof navigator?\"\":navigator.platform??\"\").startsWith(\"Mac\")?\"macOS\":n.startsWith(\"Win\")?\"windows\":\"linux\"}n.d(t,{},{IU:s,qH:{macOS:\"darwin\",windows:\"win32\",linux:\"linux\"},tR:o})"
    },
    "xS4d": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "let r,i;var a=n(\"SZCv\"),s=n.n(a),o=n(\"zTeN\"),l=n(\"OWtl\");let u=new Set,d=(0,o.SZ)(l.u,()=>void 0,({set:e})=>{let t=()=>e(r);return u.add(t),t(),()=>{u.delete(t)}}),c=(0,o.un)(l.u,({get:e})=>e(d)?.ssh,{isEqual:s()}),p=(0,o.un)(l.u,({get:e})=>e(d)?.wsl,{isEqual:s()}),h=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControl,{isEqual:s()}),f=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControlState,{isEqual:s()}),m=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlClientId),_=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnvironmentId),g=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnabled);function v(e){for(let t of(r=null==e?void 0:{remoteControlState:void 0,localRemoteControlClientId:void 0,localRemoteControlEnvironmentId:void 0,localRemoteControlInstallationId:void 0,localRemoteControlEnabled:void 0,ssh:void 0,wsl:void 0,remoteControl:void 0,...r,...e},u))t()}n.d(t,{},{BJ:_,EP:c,K:p,Zr:h,dZ:m,h9:f,mi:g,y5:async function(e){i?.[Symbol.dispose](),i=void 0,v(void 0),null!=e&&(i=await e.catalog.subscribe(v))}})"
    },
    "mUEW": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "var r=n(\"S2r0\"),i=n(\"zTeN\"),a=n(\"Dgwo\"),s=n(\"fO4j\"),o=n(\"ihPm\"),l=n(\"IUCH\"),u=n(\"OWtl\"),d=n(\"kfGJ\"),c=n(\"OMIV\"),p=n(\"rvFo\");let h=[\"codex-mobile-mfa-setup-required\"],f=\"2055603567\",m=\"3936985709\",g=[\"remote-control-server-pairing\"],_=(0,i.RD)(u.u,()=>({queryKey:[\"remote-control-mfa-requirement\"],queryFn:s.L7,retry:!1,staleTime:3e4})),v=(0,i.RD)(u.u,({get:e})=>({enabled:\"required\"===e(_).data,queryKey:[\"remote-control-mfa-enabled\"],queryFn:s.VC,refetchOnWindowFocus:\"always\",staleTime:0}));async function y(e){let t=e.query.snapshot(_);if(await t.invalidate({exact:!0,refetchType:\"none\"}),await t.fetch()!==\"required\")return!1;let n=e.query.snapshot(v);return await n.invalidate({exact:!0,refetchType:\"none\"}),!await n.fetch()}let E=(0,i.RD)(u.u,({get:e,scope:t})=>{let n=e(c.JW,\"2055603567\"),r=e(o.AP,d.fI)?.environmentId??null;return{enabled:e(o.Zg,d.fI)&&(!n||null!=r),queryKey:[\"codex-mobile-setup-resume-client\",n,r],queryFn:async()=>n?null!=r&&(await (0,l.yB)(t,d.fI,r)).length>0:(0,s.W$)(),staleTime:0}}),I=(0,i.vU)(u.u,({hostId:e,openId:t},{get:n,scope:r})=>({enabled:n(c.JW,f)&&!n(c.JW,m)&&n(o.Zg,e),queryKey:[...g,e,t],queryFn:async()=>(await (0,o.Hf)(r,e),(0,a.V)(r,e).sendRequest(\"remoteControl/pairing/start\",{manualCode:!0})),retry:!1,gcTime:0,staleTime:e=>{let t=e.state.data?.expiresAt;return null==t?0:Math.max(0,C(t)-e.state.dataUpdatedAt)},refetchInterval:e=>{let t=e.state.data?.expiresAt;return null!=t&&\"fetching\"!==e.state.fetchStatus&&null==e.state.error&&Math.max(1,C(t)-Date.now()-6e4)}}),{key:({hostId:e,openId:t})=>`${e}:${t}`});function C(e){return 1e3*Number(e)}n.d(t,{},{BM:_,Km:m,L_:v,Qg:f,ZI:y,Zm:I,n6:E,sv:function(e){return(0,r.j)({queryKey:h,queryFn:()=>y(e),refetchOnMount:\"always\",refetchOnWindowFocus:\"always\",retry:!1,staleTime:p.D.INFINITE})}})"
    }
  },
  "deepLinkCallbackHead": "e1=async e=>{let{signal:t}=e,n=T.appServices.sshConnections;if(!n0&&(null==n||null==n1)||n0&&(!nF||!nZ||!tP||!es||eo||null==tU||null==n2))return;",
  "importIds": {
    "hZax": [
      "QosV",
      "JlWK",
      "zTeN",
      "zd8w",
      "OMIV"
    ],
    "wwME": [
      "QosV",
      "C4bN",
      "XYHU"
    ],
    "XYHU": [
      "zTeN",
      "OWtl",
      "wLMK"
    ],
    "xS4d": [
      "SZCv",
      "zTeN",
      "OWtl"
    ],
    "mUEW": [
      "S2r0",
      "zTeN",
      "Dgwo",
      "fO4j",
      "ihPm",
      "IUCH",
      "OWtl",
      "kfGJ",
      "OMIV",
      "rvFo"
    ]
  },
  "tabResolver": {
    "params": [
      "unusedModule",
      "unusedExports",
      "unusedRequire"
    ],
    "moduleSource": "function({selectedConnectionsTab:e,showControlOtherDevices:t,showControlThisMacTab:n,showRemoteControlConnectionsSection:o,showRemoteSshConnections:i,showTabbedSshPage:a,isWslConnectionsLoading:s,showWslConnections:l}){return\"wsl\"===e&&s?\"wsl\":o?\"control-this-mac\"!==e||n?\"access-other-devices\"!==e||t?\"ssh\"!==e||a?\"wsl\"!==e||l?e:\"ssh\":t?\"access-other-devices\":\"control-this-mac\":n?\"control-this-mac\":\"ssh\":t?\"access-other-devices\":\"ssh\":\"wsl\"===e&&l?\"wsl\":i?\"ssh\":\"access-other-devices\"}"
  },
  "sites": {
    "gateInitializer": "tD=(0,G.Zj)(\"782640499\")",
    "platformInitializer": "{platform:tk}=(0,O.V)()",
    "availabilityRead": "nF=(0,tK.wi)()",
    "ownedFlag": "nZ=!tD",
    "tabFlags": "nK=nF&&!0,nQ=nZ&&(nF||!1),nY=nF&&!0",
    "routeKind": "n0=\"remoteControl\"===tO&&\"add\"===tR",
    "tabResolver": "n9=(0,tK.HZ)({selectedConnectionsTab:nJ??\"control-this-mac\",showControlOtherDevices:nZ,showControlThisMacTab:nK,showRemoteControlConnectionsSection:nF,showRemoteSshConnections:!0,showTabbedSshPage:nY,isWslConnectionsLoading:nB,showWslConnections:eu})",
    "outboundOptionInclude": "tn=nQ?oF:[]",
    "deepLinkGuard": "if(!n0&&(null==n||null==n1)||n0&&(!nF||!nZ||!tP||!es||eo||null==tU||null==n2))return;",
    "deepLinkEffectEnabled": "oH=!n0||nF&&nZ&&tP&&es&&!eo&&null!=tU",
    "setupPanel": "td=nZ&&\"access-other-devices\"===n9&&ec?",
    "devicesPanel": "tu=nZ&&\"access-other-devices\"===n9&&!ec?",
    "discoveryDialog": "tp=nZ&&!tP&&nE?",
    "pairingDialog": "tC=nZ&&tP&&nR&&null!=tU?",
    "authorizationDialog": "tx=nZ&&nk?",
    "deleteDialog": "tS=nZ?",
    "inboundPanel": "tc=\"control-this-mac\"===n9?",
    "sshWslPanel": "tm=\"ssh\"===n9||\"wsl\"===n9?",
    "pairingGate": "tP=(0,G.Zj)(I.Qg)",
    "localClient": "tU=(0,u.Ul)(D.dZ)",
    "remoteState": "tW=(0,u.Ul)(D.h9)",
    "authState": "eo=tW?.authRequired===!0,es=tW?.clientAuthorized===!0",
    "setupPolicy": "n=function({remoteControlConnectionsAuthorized:e,remoteControlConnectionsAuthRequired:t,showRemoteControlConnectionsSection:n}){return n&&!t&&!e}({remoteControlConnectionsAuthorized:es,remoteControlConnectionsAuthRequired:eo,showRemoteControlConnectionsSection:nF})",
    "setupResult": ":n=tw[43],ec=n,el=!ee&&es&&!eo",
    "deepLinkEventLink": "let oP=(0,h.useEffectEvent)(e1)",
    "deepLinkEffectDriver": "tw[184]!==oP||tw[185]!==nU||tw[186]!==oH?(e2=()=>{if(nU||!oH)return;let e=new AbortController;return queueMicrotask(()=>{e.signal.aborted||oP(e)}),()=>e.abort()},tw[184]=oP,tw[185]=nU,tw[186]=oH,tw[187]=e2):e2=tw[187],tw[188]!==oT||tw[189]!==nU||tw[190]!==oH?(e3=[nU,oT,oH],tw[188]=oT,tw[189]=nU,tw[190]=oH,tw[191]=e3):e3=tw[191],(0,h.useEffect)(e2,e3)"
  },
  "actionMapper": "function({action:e,hostId:t,onAuthenticate:n,onReconnect:o,onRestart:s}){if(null==e)return null;switch(e.kind){case\"install-codex\":case\"settings\":return null;case\"login\":return{label:e.label,onClick:()=>n(t)};case\"restart\":if(null!=e.tooltipText)return{label:e.label,tooltipText:e.tooltipText,onClick:s};return{label:e.label,onClick:s};case\"reconnect\":return{label:e.label,onClick:o}}}",
  "nativeFlagReferences": 25,
  "nativeMemoReferences": 14,
  "nativeMemoCapacity": 351,
  "nativeCallbackReferences": 5,
  "nativeEventReferences": 4,
  "detectorPolicy": "Preserve existing navigator.userAgent Linux alternative; native tk is qualified read-only. No claim of equivalence to a tk-based detector."
};
