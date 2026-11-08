"use strict";
// Current publishedvisibility andcatalogowner grammars; gateauthority remainsUP81-owned.
module.exports = {
  "visibility": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "var o=n(\"QosV\"),i=n(\"zTeN\"),a=n(\"xS4d\"),s=n(\"PIwo\");function l({remoteControlConnectionsState:e,slingshotEnabled:t}){return t&&(e?.available??!0)&&e?.accessRequired!==!0}n.d(t,{},{HZ:function({selectedConnectionsTab:e,showControlOtherDevices:t,showControlThisMacTab:n,showRemoteControlConnectionsSection:o,showRemoteSshConnections:i,showTabbedSshPage:a,isWslConnectionsLoading:s,showWslConnections:l}){return\"wsl\"===e&&s?\"wsl\":o?\"control-this-mac\"!==e||n?\"access-other-devices\"!==e||t?\"ssh\"!==e||a?\"wsl\"!==e||l?e:\"ssh\":t?\"access-other-devices\":\"control-this-mac\":n?\"control-this-mac\":\"ssh\":t?\"access-other-devices\":\"ssh\":\"wsl\"===e&&l?\"wsl\":i?\"ssh\":\"access-other-devices\"},Zi:l,wi:function(){let e,t=(0,o.c)(3),n=(0,i.Ul)(a.h9),r=(0,s.mC)();return t[0]!==n||t[1]!==r?(e=l({remoteControlConnectionsState:n,slingshotEnabled:r}),t[0]=n,t[1]=r,t[2]=e):e=t[2],e}})"
  },
  "catalog": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "let r,i;var a=n(\"SZCv\"),s=n.n(a),o=n(\"zTeN\"),l=n(\"OWtl\");let u=new Set,d=(0,o.SZ)(l.u,()=>void 0,({set:e})=>{let t=()=>e(r);return u.add(t),t(),()=>{u.delete(t)}}),c=(0,o.un)(l.u,({get:e})=>e(d)?.ssh,{isEqual:s()}),p=(0,o.un)(l.u,({get:e})=>e(d)?.wsl,{isEqual:s()}),h=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControl,{isEqual:s()}),f=(0,o.un)(l.u,({get:e})=>e(d)?.remoteControlState,{isEqual:s()}),m=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlClientId),_=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnvironmentId),g=(0,o.un)(l.u,({get:e})=>e(d)?.localRemoteControlEnabled);function v(e){for(let t of(r=null==e?void 0:{remoteControlState:void 0,localRemoteControlClientId:void 0,localRemoteControlEnvironmentId:void 0,localRemoteControlInstallationId:void 0,localRemoteControlEnabled:void 0,ssh:void 0,wsl:void 0,remoteControl:void 0,...r,...e},u))t()}n.d(t,{},{BJ:_,EP:c,K:p,Zr:h,dZ:m,h9:f,mi:g,y5:async function(e){i?.[Symbol.dispose](),i=void 0,v(void 0),null!=e&&(i=await e.catalog.subscribe(v))}})"
  }
};
