"use strict";
// Current bounded native critical regions and small provider grammars.
module.exports = {
  "localPrefix": "function eR(e){let t,n,c,d,m,g,x,v,b,S,y,w,M,A,L,P,T,H,V,F,Z,B,G=(0,s.c)(89),{mode:W,oneToOnePairingInAppEnabled:X}=e,$=(0,u.gh)(z.u),K=(0,C.Zp)(),Q=(0,f.A)(),{platform:J}=(0,O.V)();G[0]!==Q?(t=Q.formatMessage({id:\"settings.remoteConnections.refresh\",defaultMessage:\"Refresh\",description:\"Button label to refresh remote connections\"}),G[0]=Q,G[1]=t):t=G[1];let eo=t,[ea,el]=(0,h.useState)(null),ec=(0,u.Ul)(D.dZ),ed=(0,u._U)(ee.Zg,eg.fI);G[2]!==$?(n=(0,I.sv)($),G[2]=$,G[3]=n):n=G[3];let{data:eu,isFetching:em}=(0,Y.I)(n),ef=(0,u.Ul)(eh.y8),ep=ea?.existingClientIds??null,eC=ea?.step===\"waiting\";G[4]!==ec||G[5]!==ep||G[6]!==eC?(c={existingClientIds:ep,hostId:null,localRemoteControlClientId:ec,waiting:eC},G[4]=ec,G[5]=ep,G[6]=eC,G[7]=c):c=G[7];let ex=(0,u._U)(eh.BW,c),ev=ea?.step===\"waiting\"?ex.data:null,eb=\"connected\"===ev?\"connected\":\"dismiss\"===ev?null:ea?.step??null;G[8]!==$.query?(d=$.query.snapshot(eh.y8),G[8]=$.query,G[9]=d):d=G[9];let ej=d;G[10]!==ec||G[11]!==ef.data?(m=(0,ew.uz)(ef.data,ec),G[10]=ec,G[11]=ef.data,G[12]=m):m=G[12];let eS=m,",
  "localRowsSlot": "(0,o.jsx)(ey,{clients:eS,leadingRow:X?(0,o.jsx)(eL,{oneToOnePairingInAppEnabled:!0}):void 0,onRevoked:e=>{ej.setData(t=>t?.filter(t=>t.clientId!==e)),ej.invalidate()},onRevokeResult:e=>{(0,k.yy)($,i.CodexRemoteControlClientRevokeResult,{result:e})}})",
  "rows": "function ey(e){let t,n,i,r,a,c,d=(0,s.c)(26),{clients:m,leadingRow:g,scrollAfterThreeRows:h,onRevoked:C,onRevokeResult:x}=e,v=(0,u.gh)(z.u),b=(0,f.A)();d[0]!==v?(t=e=>(0,eS.vv)(v,e),d[0]=v,d[1]=t):t=d[1],d[2]!==b||d[3]!==x||d[4]!==C||d[5]!==v?(n=(e,t)=>{let{clientId:n}=t;x?.(\"succeeded\"),C(n),v.get(R.Id).success(b.formatMessage({id:\"settings.remoteConnections.remoteControlClients.revoke.success\",defaultMessage:\"Revoked device access\",description:\"Toast shown when access for a remote control client is revoked\"}),{id:\"remote-control-client-revoke-success\"})},d[2]=b,d[3]=x,d[4]=C,d[5]=v,d[6]=n):n=d[6],d[7]!==b||d[8]!==x||d[9]!==v?(i=(e,t)=>{let{clientId:n}=t;x?.(\"failed\"),W.v.warning(\"[remote-connections/settings] remote_control_client_revoke_failed\",{safe:{},sensitive:{clientId:n,error:e}}),v.get(R.Id).danger(b.formatMessage({id:\"settings.remoteConnections.remoteControlClients.revoke.error\",defaultMessage:\"Failed to revoke device access\",description:\"Toast shown when access for a remote control client cannot be revoked\"}),{errorAnalytics:{toastId:\"settings.remoteConnections.remoteControlClients.revoke.error\"},id:\"remote-control-client-revoke-error\"})},d[7]=b,d[8]=x,d[9]=v,d[10]=i):i=d[10],d[11]!==t||d[12]!==n||d[13]!==i?(r={mutationFn:t,onSuccess:n,onError:i},d[11]=t,d[12]=n,d[13]=i,d[14]=r):r=d[14];let j=(0,l.n)(r),S=j.isPending?j.variables?.clientId:null,y=void 0!==h&&h&&m.length+ +(null!=g)>3?\"max-h-52 overflow-y-auto\":void 0;if(d[15]!==m||d[16]!==j||d[17]!==S){let e;d[19]!==j||d[20]!==S?(e=e=>{var t;return(0,o.jsx)(em.ic,{icon:function(e){switch(e.deviceType){case\"phone\":return(0,o.jsx)(eC,{className:\"icon-sm\"});case\"laptop\":return(0,o.jsx)(ev.A,{className:\"icon-sm\"});default:return(0,o.jsx)(ex.A,{className:\"icon-sm\"})}}(e),label:e.displayName??e.deviceModel??e.platform??e.clientId,description:null!=(t=e).lastSeenAt?(0,o.jsx)(p.A,{id:\"settings.remoteConnections.remoteControlClients.lastSeen\",defaultMessage:\"Last connected {date}\",description:\"Description for when a remote control client was last seen\",values:{date:(0,o.jsx)(ef.A,{dateString:t.lastSeenAt},\"last-seen-at\")}}):(0,o.jsx)(p.A,{id:\"settings.remoteConnections.remoteControlClients.authorized\",defaultMessage:\"Authorized device\",description:\"Description for an authorized remote control client\"}),control:(0,o.jsx)(_.$,{color:\"secondary\",disabled:j.isPending,loading:S===e.clientId,onClick:()=>{j.mutate(e)},children:(0,o.jsx)(p.A,{id:\"settings.remoteConnections.remoteControlClients.revoke\",defaultMessage:\"Revoke access\",description:\"Button label that revokes access for a remote control client\"})})},e.clientId)},d[19]=j,d[20]=S,d[21]=e):e=d[21],a=m.map(e),d[15]=m,d[16]=j,d[17]=S,d[18]=a}else a=d[18];return d[22]!==g||d[23]!==y||d[24]!==a?(c=(0,o.jsxs)(U.t,{className:y,children:[g,a]}),d[22]=g,d[23]=y,d[24]=a,d[25]=c):c=d[25],c}",
  "parent": "function eN(){let e,t=(0,s.c)(5),n=(0,G.Zj)(I.Qg),i=(0,u.Ul)(ed.kP);if(void 0===i){let e;return t[0]===Symbol.for(\"react.memo_cache_sentinel\")?(e=(0,o.jsx)(F.j,{}),t[0]=e):e=t[0],e}if(!i){let e;return t[1]!==n?(e=(0,o.jsx)(eR,{mode:\"setup\",oneToOnePairingInAppEnabled:n}),t[1]=n,t[2]=e):e=t[2],e}return t[3]!==n?(e=(0,o.jsxs)(o.Fragment,{children:[(0,o.jsx)(eR,{mode:\"manage\",oneToOnePairingInAppEnabled:n}),(0,o.jsx)(eE,{oneToOnePairingInAppEnabled:n})]}),t[3]=n,t[4]=e):e=t[4],e}",
  "renderSlot": "tw[229]!==n9?(tc=\"control-this-mac\"===n9?(0,o.jsx)(o.Fragment,{children:(0,o.jsx)(eN,{})}):null,tw[229]=n9,tw[230]=tc):tc=tw[230]",
  "publication": "n.d(t,{RemoteConnectionsSettings:()=>t8});",
  "providers": {
    "xS4d": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "let r,i;var a=n(\"SZCv\"),s=n.n(a),o=n(\"zTeN\"),l=n(\"OWtl\");let u=new Set,d=(0,o.SZ)(l.u,()=>void 0,({set:e})=>{let t=()=>e(r);return u.add(t),t(),()=>{u.delete(t)}}),c=(0,o.un)(l.u,({get:e})=>e(d)?.ssh,{isEqual:s()}),p=(0,o.un)(l.u,({get:e})=>e(d)?.wsl,{isEqual:s()}),h=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControl,{isEqual:s()}),f=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControlState,{isEqual:s()}),m=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlClientId),_=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnvironmentId),g=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnabled);function v(e){for(let t of(r=null==e?void 0:{remoteControlState:void 0,localRemoteControlClientId:void 0,localRemoteControlEnvironmentId:void 0,localRemoteControlInstallationId:void 0,localRemoteControlEnabled:void 0,ssh:void 0,wsl:void 0,remoteControl:void 0,...r,...e},u))t()}n.d(t,{},{BJ:_,EP:c,K:p,Zr:h,dZ:m,h9:f,mi:g,y5:async function(e){i?.[Symbol.dispose](),i=void 0,v(void 0),null!=e&&(i=await e.catalog.subscribe(v))}})"
    },
    "IUCH": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "var r=n(\"Dgwo\"),i=n(\"fO4j\");async function a(e,t,n,i=null){let s=await (0,r.V)(e,t).sendRequest(\"remoteControl/client/list\",{environmentId:n,cursor:i,limit:100,order:\"desc\"}),o=s.data.map(e=>{var r,i,a;return r=e,i=t,a=n,{clientId:r.clientId,displayName:r.displayName,deviceType:r.deviceType,platform:r.platform,deviceModel:r.deviceModel,lastSeenAt:null==r.lastSeenAt?null:new Date(1e3*Number(r.lastSeenAt)).toISOString(),revokeTarget:{type:\"app-server\",environmentId:a,hostId:i}}});return null==s.nextCursor?o:o.concat(await a(e,t,n,s.nextCursor))}n.d(t,{},{ic:async function(e,t,{appServerHostId:n,includeBrowserClients:r=!0}={}){let[s,o]=await Promise.all([r&&null==n?(0,i.cu)():[],null==t?[]:a(e,n??\"local\",t)]),l=new Map;for(let e of s){var u;l.set(e.client_id,{clientId:(u=e).client_id,displayName:u.display_name??null,deviceType:u.device_type??null,platform:u.platform??null,deviceModel:u.device_model??null,lastSeenAt:u.last_seen_at??null,revokeTarget:{type:\"browser\"}})}for(let e of o)l.set(e.clientId,e);return Array.from(l.values())},vv:async function(e,t){switch(t.revokeTarget.type){case\"browser\":await (0,i.mJ)({clientId:t.clientId});return;case\"app-server\":await (0,r.V)(e,t.revokeTarget.hostId).sendRequest(\"remoteControl/client/revoke\",{environmentId:t.revokeTarget.environmentId,clientId:t.clientId});return}},yB:a})"
    },
    "fJ4f": {
      "params": [
        "e",
        "r",
        "t"
      ],
      "moduleSource": "var c=t(\"zTeN\"),l=t(\"ihPm\"),i=t(\"xS4d\"),o=t(\"OWtl\"),n=t(\"OMIV\"),a=t(\"IUCH\"),s=t(\"M03z\");let u=(0,c.RD)(o.u,({get:e,scope:r})=>{let t=e(i.BJ)??null,c=!e(n.JW,\"2055603567\");return{queryKey:[\"remote-control-clients\",t,c],queryFn:()=>(0,a.ic)(r,t,{includeBrowserClients:c}),staleTime:3e4}}),d=(0,c.vU)(o.u,(e,{get:r,scope:t})=>{let c=r(l.AP,e),i=c?.environmentId;return{enabled:null!=i,queryKey:[\"remote-control-clients\",\"app-server\",e,c?.installationId],queryFn:()=>null==i?Promise.resolve([]):(0,a.ic)(t,i,{appServerHostId:e}),staleTime:3e4}}),p=(0,c.vU)(o.u,(e,{get:r,scope:t})=>{let c=r(i.BJ)??null,l=!r(n.JW,\"2055603567\");return{enabled:e,queryKey:[\"remote-control-clients\",c,l],queryFn:()=>(0,a.ic)(t,c,{includeBrowserClients:l}),refetchInterval:!!e&&1e3,staleTime:0}}),f=(0,c.vU)(o.u,({existingClientIds:e,hostId:r,localRemoteControlClientId:t,waiting:c},{get:o,queryClient:u,scope:d})=>{let p=null,f=null,x=!o(n.JW,\"2055603567\");if(c&&null==r)p=o(i.BJ)??null;else if(c){let e=o(l.AP,r);p=e?.environmentId,f=e?.installationId}let y=[\"remote-control-clients\",\"waiting-for-added\",r,x,null==r?p:f,null==e?null:Array.from(e).sort(),t];return{enabled:c&&null!=e&&(null==r||null!=p),gcTime:0,queryKey:y,queryFn:async()=>{let c=u.getQueryData(y);if(null!=c||null==e)return c??null;let l=await (0,a.ic)(d,p??null,{appServerHostId:r??void 0,includeBrowserClients:x});return null!=r&&u.setQueryData([\"remote-control-clients\",\"app-server\",r,f],l),(0,s.PA)((0,s.uz)(l,t),e)},refetchInterval:e=>!!c&&null==e.state.data&&1e3,staleTime:0}},{key:function({existingClientIds:e,hostId:r,localRemoteControlClientId:t,waiting:c}){return JSON.stringify({existingClientIds:null==e?null:Array.from(e).sort(),hostId:r,localRemoteControlClientId:t,waiting:c})}});t.d(r,{},{BW:f,MN:d,y8:u,zj:p})"
    },
    "M03z": {
      "params": [
        "e",
        "r",
        "t"
      ],
      "moduleSource": "function c(e,r){return e?.some(e=>!r.has(e.clientId))===!0}t.d(r,{},{PA:function(e,r){return null!=e&&c(e,r)?0===r.size&&1===e.length?\"connected\":\"dismiss\":null},rr:c,uz:function(e,r){if(null!=e)return null==r?e:e.filter(e=>e.clientId!==r)}})"
    },
    "q77y": {
      "params": [
        "e",
        "t",
        "n"
      ],
      "moduleSource": "n.d(t,{},{P:async function(e,t){let n=!1,i=()=>{n||(n=!0,e[Symbol.dispose]?.())};t?.addEventListener(\"abort\",i,{once:!0});try{t?.throwIfAborted();let n=await e;return t?.throwIfAborted(),n}finally{t?.removeEventListener(\"abort\",i),i()}}})"
    }
  }
};
