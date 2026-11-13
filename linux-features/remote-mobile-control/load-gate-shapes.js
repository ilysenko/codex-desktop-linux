"use strict";
// Bounded current native grammar; import identities are linked separately.
module.exports = {
  "owner": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "var r=n(\"QosV\"),i=n(\"zTeN\"),a=n(\"tl5a\"),s=n(\"B81s\"),o=n(\"OWtl\"),l=n(\"hZax\"),u=n(\"OMIV\"),d=n(\"kx7U\");let c=(0,i.un)(o.u,({get:e})=>{let t=e(a.Dc),{data:n}=e(s.I2,t),r=e(u.JW,\"4114442250\");if(!0===n?.config[\"features.remote_connections\"])return!0;let i=n?.config.features;return null==i||\"object\"!=typeof i||Array.isArray(i)?r:Object.getOwnPropertyDescriptor(i,\"remote_connections\")?.value===!0||r});function p(e){return e.autoConnect?[e.hostId]:[]}n.d(t,{},{Ik:function(){return(0,i.Ul)(c)},bc:c,mC:function(){return(0,l.Zj)(\"1042620455\")},mw:function(){let e,t,n=(0,r.c)(5),a=(0,i.Ul)(d.u8)??[];return n[0]!==a?(e=new Set(a.flatMap(p)),n[0]=a,n[1]=e):e=n[1],n[2]!==a||n[3]!==e?(t={remoteConnections:a,enabledRemoteHostIdSet:e},n[2]=a,n[3]=e,n[4]=t):t=n[4],t}})"
  },
  "callee": {
    "params": [
      "e",
      "t",
      "n"
    ],
    "moduleSource": "var r=n(\"QosV\"),i=n(\"IozE\"),a=n(\"zTeN\"),s=n(\"zd8w\"),o=n(\"OMIV\");let l=(0,s.createContext)(!1);function u(){return c(),(0,i.useStatsigClient)()}function d(e,t,n){return e.getLayer(t,n)}function c(e){(0,s.useContext)(l)}n.d(t,{},{AS:function(){return u().client},DR:function(e){return c(),(0,a._U)(o.dx,e)},Fj:function(e,t){let n,i=(0,r.c)(4),{getDynamicConfig:a}=u();return i[0]!==e||i[1]!==a||i[2]!==t?(n=a(e,t),i[0]=e,i[1]=a,i[2]=t,i[3]=n):n=i[3],n},Ks:function(e,t){return e.checkGate(t)},Ou:function(e,t){let n,i=(0,r.c)(8),{client:a,getLayer:s}=u();return i[4]!==a||i[5]!==e||i[6]!==t?(n=d(a,e,t),i[4]=a,i[5]=e,i[6]=t,i[7]=n):n=i[7],n},XM:d,XR:function(){return u().isLoading},Zj:function(e){let t,n=(0,r.c)(2);return c(\"string\"==typeof e),n[0]!==e?(t=\"boolean\"==typeof e?e:{cache:\"signal\",resolve:(t,n)=>o.JW.resolve(t,n,e).atom,scope:o.JW.scope},n[0]=e,n[1]=t):t=n[1],(0,a.Ul)(t)},cB:function(){return c(),(0,i.useStatsigUser)().user},cn:u,hW:function(e,t,n){return e.getExperiment(t,n)},j3:l})"
  }
};
