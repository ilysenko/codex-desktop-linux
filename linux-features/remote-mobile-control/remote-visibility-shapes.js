"use strict";
// Bounded current native grammar; import identities are linked separately.
module.exports = {
  "visibility": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "var i=n(\"QosV\"),a=n(\"zTeN\"),r=n(\"xS4d\"),o=n(\"PIwo\");function s({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}n.d(t,{},{HZ:function({selectedConnectionsTab:e,showControlOtherDevices:t,showControlThisMacTab:n,showRemoteControlConnectionsSection:i,showRemoteSshConnections:a,showTabbedSshPage:r,isWslConnectionsLoading:o,showWslConnections:s}){return\"wsl\"===e&&o?\"wsl\":i?\"control-this-mac\"!==e||n?\"access-other-devices\"!==e||t?\"ssh\"!==e||r?\"wsl\"!==e||s?e:\"ssh\":t?\"access-other-devices\":\"control-this-mac\":n?\"control-this-mac\":\"ssh\":t?\"access-other-devices\":\"ssh\":\"wsl\"===e&&s?\"wsl\":a?\"ssh\":\"access-other-devices\"},Zi:s,wi:function(){let e,t=(0,i.c)(3),n=(0,a.Ul)(r.h9),l=(0,o.mC)();return t[0]!==n||t[1]!==l?(e=s({remoteControlConnectionsState:n,slingshotEnabled:l}),t[0]=n,t[1]=l,t[2]=e):e=t[2],e}})"
  },
  "catalog": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "let r,i;var a=n(\"SZCv\"),s=n.n(a),o=n(\"zTeN\"),l=n(\"OWtl\");let u=new Set,d=(0,o.SZ)(l.u,()=>void 0,({set:e})=>{let t=()=>e(r);return u.add(t),t(),()=>{u.delete(t)}}),c=(0,o.un)(l.u,({get:e})=>e(d)?.ssh,{isEqual:s()}),p=(0,o.un)(l.u,({get:e})=>e(d)?.wsl,{isEqual:s()}),h=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControl,{isEqual:s()}),f=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControlState,{isEqual:s()}),m=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlClientId),g=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnvironmentId),_=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnabled);function v(e){for(let t of(r=null==e?void 0:{remoteControlState:void 0,localRemoteControlClientId:void 0,localRemoteControlEnvironmentId:void 0,localRemoteControlInstallationId:void 0,localRemoteControlEnabled:void 0,ssh:void 0,wsl:void 0,remoteControl:void 0,...r,...e},u))t()}n.d(t,{},{BJ:g,EP:c,K:p,Zr:h,dZ:m,h9:f,mi:_,y5:async function(e){i?.[Symbol.dispose](),i=void 0,v(void 0),null!=e&&(i=await e.catalog.subscribe(v))}})"
  }
};
