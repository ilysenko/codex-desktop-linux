"use strict";

const { localConfigGraph, localConfigFixture, callbackSource } = require("../../../scripts/patches/lib/fixtures/main-local-config-graph.js");

// Current selector/caller/request graph with a bounded inert SSH handshake
// shape. Tests evaluate only extracted generated transport/selector fragments.
function mainTransportGraph() {
  const sshSource = [
    'class gC{options;kind="websocket";logger=(0,i.i)("AppServerTransportSshWebsocket");proxyStreams=new Set;hasConnected=!1;supportsReconnect(){return!0}',
    'async connectToRemoteAppServer(e,t){return this.runWithSshStartupGate(async()=>{let t={current:null},h=(0,n.hd)(),r=new w.kn("ws://codex-app-server/rpc",{perMessageDeflate:!1,headers:h,createConnection:()=>',
    "(t.current=this.createSshProxyStream(),t.current)}),o={current:null},a=e=>{o.current=o.current??e};r.on(\"error\",a);",
    'let s=64;r.once("upgrade",e=>{let t=Number(e.headers["frame-limit"]);Number.isSafeInteger(t)&&t>0&&(s=t)});let c=new n.Codec(r,null!=h);r.once("close",()=>{t.current?.destroy()});',
    "try{if(await opened(r),null!=o.current)throw o.current}catch(e){throw t.current?.destroy(),r.terminate(),e}",
    'let i=new n.On(r,void 0,s,c);return r.off("error",a),this.logger.info("app_server_connection.compression_negotiated",{safe:{compression:c.compression}}),(0,n.Dn)(r,{onPongTimeout:()=>{i.terminationReason="pong_timeout",r.terminate()}}),this.hasConnected=!0,i})}}',
  ].join("");
  const graph = localConfigGraph().replace(/\bevZ\b/gu, "b5");
  return localConfigFixture(sshSource + graph);
}

module.exports = { mainTransportGraph, callbackSource };
