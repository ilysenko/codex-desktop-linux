"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const c = require("../auto-connect-contracts.js"), copy = require("./current-remote-copy.json");
const { graphBody } = require("../../../scripts/patches/lib/fixtures/main-request-graph.js");
const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
function main() {
  const handler = c.mainHandlerHeaderAndConstructor + c.mainPersistentSetter + c.mainChoiceAndMapGetters + c.mainClearChoice + "}";
  let body = graphBody().replace("class Host{constructor", "class Host{appState;remoteConnectionsHandler;visualizations;constructor").replace('this.scopedState=e.globalState,', 'this.scopedState=e.globalState,this.appState=e.globalState,' + c.mainVisualizationConstruction + ',' + c.mainLiveHandlerConstruction + ',')
    .replace('async handleMessage(e,t){await this.messageHandler', 'createAppHost(e){let o,c,g;let ' + c.mainSystemServicesInitializer + ';return new Er({getConnection:this.getAppServerClient,globalState:this.scopedState,...{' + c.mainLiveServicePublication + ',remoteControlEnvironments:this.remoteControlEnvironments,...I,...' + c.mainReturnedConditionalSpreads.join(',...') + ',...' + c.mainVisualizationSpread + '})}async handleMessage(e,t){await this.messageHandler')
    .replace('require.d(exports,', 'r.d(t,').replace('module.exports=exports;', 'e.exports=t;');
  body = 'var ei=r(40614),en=r(12892);' + handler + c.mainServiceClass + c.mainAppHostClass + c.mainVisualizationOwner + body;
  return `exports.ids=[815],exports.modules={26307(e,t,r){${body}}};`;
}
function chunk(id, row) { return `export const __rspack_esm_ids=[${id}];export const __webpack_modules__={${row.moduleId}(${row.params}){${row.moduleSource}}};`; }
function sources() {
  return { "webview/assets/async/bootstrap.js": chunk(4, {moduleId:"wRZ2",params:["e","t","n"],moduleSource:c.rendererBootstrapModule}), ".vite/build/early-bootstrap-815-123abc.js": main(),
    "webview/assets/async/settings.js": chunk(1, copy.settings),
    "webview/assets/async/facade-a.js": chunk(2, { moduleId: "GaA7", params: ["e","p","s"], moduleSource: 'let t,o;s.r(p),s.d(p,{appHost:()=>t,appServices:()=>o},{setAppHost:function(e){t=e},setAppServices:function(e){o=e}})' }),
    "webview/assets/async/facade-b.js": chunk(3, { moduleId: "GaA7", params: ["e","t","r"], moduleSource: 'let n,i;r.r(t),r.d(t,{appHost:()=>n,appServices:()=>i},{setAppHost:function(e){n=e},setAppServices:function(e){i=e}})' }) };
}
function snapshots(input = sources()) {
  const main = Object.entries(input).filter(([name])=>name.startsWith('.vite/')).map(([assetName,source])=>({assetName,source}));
  const modules = Object.entries(input).filter(([name])=>name.startsWith('webview/')).flatMap(([name,source])=>[...rspackModuleFactories(source,name)]);
  return { main, settings: modules.filter(row=>row.moduleId==='GrdY'), facade: modules.filter(row=>row.moduleId==='GaA7'), bootstrap: modules.filter(row=>row.moduleId==='wRZ2') };
}
function writeApp(root, input=sources()) { for (const [name,source] of Object.entries(input)) { const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source,{mode:0o640}); } }
function selectedMethod(source, name, async=false) {
  const start=new RegExp(`(?<![\\w$.])${async?'async ':''}${name}\\(`,'u').exec(source)?.index??-1,open=source.indexOf('{',start),lex=require('../../../scripts/patches/lib/minified-js.js').createJavaScriptLexicalIndex(source),end=lex.matchingBrace(open);
  if(start<0||end<open)throw Error('missing selected method');return (async?'async ':'')+'function'+source.slice(start+(async?6:0)+name.length,end+1);
}
function handler(store, hooks={}) {
  const bindings={ei:{Q2Y:{REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID:'choice-map'}}},self={appState:store,
    refreshRemoteConnectionsForHostId:hooks.refresh??(async host=>[{hostId:host}]),ensureRemoteConnectionConnected:hooks.ensure??(async()=>({state:'connected'})),disconnectRemoteConnection:hooks.disconnect??(async()=>({state:'disconnected'}))};
  for(const [name,text,async] of [['setRemoteConnectionAutoConnect',c.mainPersistentSetter,true],['getAutoConnectForRemoteConnection',c.mainChoiceAndMapGetters,false],['getRemoteConnectionAutoConnectByHostId',c.mainChoiceAndMapGetters,false],['clearRemoteConnectionAutoConnect',c.mainClearChoice,false]]) self[name]=vm.runInNewContext('('+selectedMethod(text,name,async)+')',bindings);
  return self;
}
function caller(namespace) { return vm.runInNewContext(c.rendererCaller+';nh',{T:namespace}); }
module.exports={main,sources,snapshots,writeApp,handler,caller,selectedMethod};
