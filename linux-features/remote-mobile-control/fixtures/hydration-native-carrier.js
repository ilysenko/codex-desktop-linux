"use strict";

// Selected current native owners in a source-only published-manager carrier.
// Tests execute the small discovery/queue through hydration-harness.js. They
// never instantiate this manager or execute its Rspack factory.
const data = require("../hydration-contract-data.json");
function nativeCarrier(moduleId = "V7mA") {
  const notify = data.notificationHead + data.notificationReducerHead + "switch(l.method){default:break;}}}" + data.notificationTail;
  const request = data.requestHead + ")||noop();}";
  const manager = "class sD extends p.TF{threadDiscovery;notificationReductionContext;hostId;isCloudHost;#V(){}constructor(e){super();let Q;" +
    data.constructorInput + data.hostInitialization + ";" + data.constructionIfPrefix + "," + data.context + ",false){}}" + data.getHost + notify + request + "}";
  return "export const __rspack_esm_ids=[1];export const __webpack_modules__={" + moduleId + "(e,t,n){" +
    'var g=n("E7Ps"),p=n("ZG9f"),R=n("wnzA"),em=n("N2rm");n.d(t,{O3:()=>sD});' +
    data.readThreadId + data.canonicalIslands + data.canonicalReader + data.merge + data.resolved + data.bufferText + data.bufferKey + data.buffer + data.life + manager + "}};";
}
module.exports = { nativeCarrier };
