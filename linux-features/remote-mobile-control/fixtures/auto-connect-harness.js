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
  body = 'var ei=r(24240),en=r(33491),edC=r(23507);' + handler + c.mainServiceClass + c.mainAppHostClass + c.mainVisualizationOwner + body;
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
function settingsParts(input = sources()) {
  const scope = require("../remote-copy-scope.js");
  const { inspectAutoConnectSettings } = require("../auto-connect-contract.js");
  const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../../scripts/patches/lib/minified-js.js");
  const [copy] = snapshots(input).settings;
  const proof = inspectAutoConnectSettings(copy);
  const rows = scope.context(copy).functions.filter(row => row.root && row.name &&
    row.source.includes("clientAuthorized:") && row.source.includes("checked:") && row.source.includes(".autoConnect"));
  if (rows.length !== 1) throw Error("missing current remote-control row");
  const remoteRow = scope.stableRootFunction(copy, rows[0].name).source;
  const list = scope.stableRootFunction(copy, proof.list);
  const sshNames = [...list.source.matchAll(/\.jsx\)\(([A-Za-z_$][\w$]*),\{connection:[A-Za-z_$][\w$]*,disabled:/gu)]
    .map(row => row[1]);
  if (sshNames.length !== 1) throw Error("missing current SSH row");
  const caller = scope.stableRootFunction(copy, proof.caller);
  const facade = /(?<![\w$.])([A-Za-z_$][\w$]*)\.appServices\b/u.exec(caller.source)?.[1];
  if (!facade) throw Error("missing current late facade");
  const entry = scope.publishedRootFunction(copy, "RemoteConnectionsSettings");
  const body = entry.source.slice(entry.source.indexOf("{") + 1, -1);
  const lexical = createJavaScriptLexicalIndex(body);
  const memo = /([A-Za-z_$][\w$]*)=\(0,[A-Za-z_$][\w$]*\.c\)\(351\)/u.exec(body)?.[1];
  const slot = /^[A-Za-z_$][\w$]*\[(\d+)\]/u.exec(c.rendererFinalFragment)?.[1];
  const heads = [...body.matchAll(new RegExp(`${escapeRegExp(memo ?? "")}\\[${slot}\\]!==`, "gu"))]
    .filter(row => lexical.isCode(row.index) && lexical.isRoot(row.index));
  if (!memo || !slot || heads.length !== 1) throw Error("missing current returned fragment");
  const finalFragment = body.slice(heads[0].index);
  const result = /,([A-Za-z_$][\w$]*)$/u.exec(finalFragment)?.[1];
  if (!result) throw Error("missing current returned result");
  return { remoteRow, finalFragment, result,
    criticalNames: [proof.caller, proof.entry, proof.list, rows[0].name, sshNames[0], facade],
    entryHead: entry.source.slice(0, entry.source.indexOf("{") + 1) };
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
module.exports={main,sources,snapshots,settingsParts,writeApp,handler,caller,selectedMethod};
