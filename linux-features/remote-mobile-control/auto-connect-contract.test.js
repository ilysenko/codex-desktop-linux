"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm"),test=require("node:test");
const {prepareAutoConnect:prepare,locateAutoConnect:locate,applyAutoConnect:apply}=require("./auto-connect-contract.js");
const {patchWebviewAssets}=require("../../scripts/patches/lib/assets.js");
const c=require("./auto-connect-contracts.js"),h=require("./fixtures/auto-connect-harness.js");
const {createJavaScriptLexicalIndex,escapeRegExp}=require("../../scripts/patches/lib/minified-js.js");
const native=h.sources(),mainName=Object.keys(native).find(name=>name.startsWith(".vite/")),settingsName="webview/assets/async/settings.js",clean=value=>JSON.parse(JSON.stringify(value));
const currentSettings=h.settingsParts(native);
function mutate(from,to,name=settingsName,input=native){assert.ok(input[name].includes(from),from);return{...input,[name]:input[name].replace(from,to)}}
function reject(input){assert.throws(()=>prepare(h.snapshots(input)),/Remote auto-connect|Remote copy scope|Remote connections owners|SyntaxError/)}
function temporary(fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),"remote-auto-connect-"));try{return fn(root)}finally{fs.rmSync(root,{recursive:true,force:true})}}

function appendMember(input,className,member){
 const source=input[mainName],start=source.indexOf("class "+className+"{"),open=source.indexOf("{",start),end=createJavaScriptLexicalIndex(source).matchingBrace(open);assert.ok(start>=0&&end>open);
 return {...input,[mainName]:source.slice(0,end)+member+source.slice(end)};
}

test("complete native service, Settings, bootstrap and both facades prepare first/repeat without edits",()=>{
 const first=prepare(h.snapshots(native)),second=prepare(h.snapshots(native));assert.equal(first.alreadyApplied,true);assert.equal(second.alreadyApplied,true);assert.deepEqual(first,second);assert.equal(first.edits.length,5);assert.equal(first.targetCopies,1);
 for(const row of first.edits)assert.equal(row.patchedSource,row.source);
});
test("registered no-op adapter reads every dependency, never writes and retains read-only bytes/modes",()=>temporary(root=>{
 h.writeApp(root);for(const name of Object.keys(native))fs.chmodSync(path.join(root,name),0o440);
 let writes=0,reads=0;for(let run=0;run<2;run++){const result=apply(root,{readFileSync(file){reads++;return fs.readFileSync(file)},writeFileSync(){writes++;throw Error("no writes permitted")}});assert.equal(result.matched,true);assert.equal(result.changed,0);assert.deepEqual(result.changedAssets,[]);assert.equal(result.targetCopies,1)}
 assert.equal(writes,0);assert.equal(reads,10);for(const[name,source]of Object.entries(native)){assert.equal(fs.readFileSync(path.join(root,name),"utf8"),source);assert.equal(fs.statSync(path.join(root,name)).mode&0o777,0o440)}
}));
test("false and true preserve the host-keyed map, write before refresh and dispatch the exact selected host",async()=>{
 const events=[],values=new Map([["choice-map",{other:true,chosen:true}]]),store={get:key=>values.get(key),set(key,value){events.push(["write",key,clean(value)]);values.set(key,value)}};
 const self=h.handler(store,{async refresh(host){events.push(["refresh",host,values.get("choice-map")[host]]);return[{hostId:host}]},async ensure(host){events.push(["ensure",host]);return{state:"connected"}},async disconnect(host){events.push(["disconnect",host]);return{state:"disconnected"}}});
 for(const choice of[false,true]){const result=await self.setRemoteConnectionAutoConnect("chosen",choice);assert.equal(result.state,choice?"connected":"disconnected");assert.equal(values.get("choice-map").other,true);assert.equal(values.get("choice-map").chosen,choice)}
 assert.deepEqual(events.map(x=>x[0]),["write","refresh","disconnect","write","refresh","ensure"]);assert.deepEqual(events.filter(x=>x[0]==="refresh"),[["refresh","chosen",false],["refresh","chosen",true]]);
 assert.equal(self.getAutoConnectForRemoteConnection({hostId:"chosen"},false),true);self.clearRemoteConnectionAutoConnect("chosen");assert.deepEqual(clean(values.get("choice-map")),{other:true});
});
test("explicit false survives fallback and reconstructed shared-store readers; rejected refresh retains native choice",async()=>{
 const failure=Error("controlled refresh rejection"),values=new Map([["choice-map",{other:true}]]),store={get:key=>values.get(key),set:(key,value)=>values.set(key,value)},self=h.handler(store,{async refresh(){throw failure}});
 await assert.rejects(self.setRemoteConnectionAutoConnect("chosen",false),error=>error===failure);assert.deepEqual(clean(values.get("choice-map")),{other:true,chosen:false});
 const reader=h.handler(store);assert.equal(reader.getAutoConnectForRemoteConnection({hostId:"chosen"},true),false);assert.equal(reader.getAutoConnectForRemoteConnection({hostId:"missing"},true),true);assert.equal(reader.getAutoConnectForRemoteConnection({hostId:"missing"}),false);
 // Shared mocked appState proves the native readers, not a real process restart.
});
test("actual native service forwarding and late caller preserve booleans, errors and facade replacement",async()=>{
 const seen=[],namespace={appServices:{remoteConnections:null}},call=h.caller(namespace),forward=vm.runInNewContext('('+h.selectedMethod(c.mainServiceClass,"setAutoConnect")+')');
 const service={setAutoConnect:forward,connections:{setRemoteConnectionAutoConnect(host,choice){seen.push([host,choice]);return Promise.resolve({host,choice})}}};
 await assert.rejects(call({hostId:"a",autoConnect:false}),/Remote connections are unavailable/);namespace.appServices.remoteConnections=service;
 const request={hostId:"a",autoConnect:false,savedSshConnectionName:"ignored"};await call(request);await call({hostId:"b",autoConnect:true});
 const replacement=Error("controlled replacement failure");namespace.appServices.remoteConnections={setAutoConnect(value){assert.notEqual(value,request);assert.deepEqual(clean(value),{hostId:"a",autoConnect:false});throw replacement}};await assert.rejects(call(request),error=>error===replacement);assert.deepEqual(seen,[["a",false],["b",true]]);
});
test("selected native mutation action retains pending guard, selected-host result and exact rejection/finally behavior",async()=>{
 for(const rejects of[false,true]){
  const events=[],error=Error("controlled mutation rejection"),bindings={tw:[],tI:{},tM:{watch(fn){fn({get(){}});return()=>events.push("stop")},get:()=>"connecting"},oN:(...args)=>events.push(["state",...args]),om:{mutateAsync(value){events.push(["mutation",clean(value)]);return rejects?Promise.reject(error):Promise.resolve({remoteConnections:[],state:"connected",error:null})}},w:{Q_:(store,host)=>events.push(["select",host])},y:{y2:"state"},S:{LH:"error"},m:{tPs:()=>false},v:{_:()=>{}},i:{},of:false,nT:host=>events.push(["cancel",host]),na:e=>events.push(["caught",e])};
  const run=vm.runInNewContext('let eJ;'+c.rendererMutationActionAndGuardedCallback+';({action:eJ,toggle:oD});',bindings);
  if(rejects)await assert.rejects(run.action("chosen",false,"saved"),e=>e===error);else await run.action("chosen",false,"saved");
  assert.deepEqual(events[0],["select","chosen"]);assert.deepEqual(events[1],["mutation",{hostId:"chosen",autoConnect:false,savedSshConnectionName:"saved"}]);assert.equal(events.filter(x=>x==="stop").length,1);
  if(!rejects)assert.deepEqual(events[2],["state","chosen","connected",null]);else assert.equal(events.some(x=>Array.isArray(x)&&x[0]==="state"),false);
  events.length=0;bindings.of=true;run.toggle("blocked",false);assert.deepEqual(events,[]);bindings.of=false;run.toggle("chosen",false);await new Promise(setImmediate);assert.deepEqual(events[0],["cancel","chosen"]);if(rejects)assert.equal(events.at(-1)[1],error);
 }
});
test("bounded actual row controls read stored checked choice and forward supplied booleans with the same host",()=>{
 const requests=[],X=(...args)=>requests.push(args),P={hostId:"remote",autoConnect:false},Y=(...args)=>requests.push(args),Z={hostId:"ssh",autoConnect:true};
 const remoteCallback=/onChange:(e=>X\(P\.hostId,e\))(?=,ariaLabel)/u.exec(c.rendererRemoteControlRow)[1],sshCallback=/w=(e=>Y\(Z\.hostId,e\))(?=,F\[52\])/u.exec(c.rendererSshRow)[1];
 for(const choice of[false,true])vm.runInNewContext('('+remoteCallback+')',{X,P})(choice);
 for(const choice of[false,true])vm.runInNewContext('('+sshCallback+')',{Y,Z})(choice);
 const remoteChecked=/checked:(P\.autoConnect)/u.exec(c.rendererRemoteControlRow)[1],sshChecked=/ex=(Z\.autoConnect)/u.exec(c.rendererSshRow)[1];
 assert.equal(vm.runInNewContext(remoteChecked,{P}),false);assert.equal(vm.runInNewContext(sshChecked,{Z}),true);assert.deepEqual(requests,[["remote",false],["remote",true],["ssh",false],["ssh",true]]);
});

test("missing or disconnected Settings never qualifies the main service as its own caller",()=>{
 const cohort=h.snapshots();for(const role of["main","settings","facade","bootstrap"])assert.throws(()=>prepare({...cohort,[role]:[]}),/missing/);
 reject(mutate('return o.setAutoConnect({hostId:t,autoConnect:n})','return o.setAutoConnect({hostId:n,autoConnect:t})'));
 reject(mutate('mutationFn:nh','mutationFn:foreign'));
 reject(mutate('onToggleConnection:oD','onToggleConnection:foreign'));
 reject(mutate('children:[tl,tc,td,tu,tm]','children:[tl,tc,td,null,null]'));
 reject(mutate('RemoteConnectionsSettings:()=>t8','RemoteConnectionsSettings:()=>foreign'));
});
test("wrong persisted key, getter fallback, write order, live service or host choice refuses",()=>{
 for(const[from,to]of[
  ['[e]:t','[t]:e'],['[e.hostId]??t','[e.hostId]||t'],['REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID,{...r','UNRELATED_KEY,{...r'],
  ['let n=await this.refreshRemoteConnectionsForHostId(e);return t?','let n=await this.refreshRemoteConnectionsForHostId(t);return t?'],
  ['this.ensureRemoteConnectionConnected(e)','this.ensureRemoteConnectionConnected(t)'],['this.disconnectRemoteConnection(e)','this.disconnectRemoteConnection(t)'],
  ['return this.connections.setRemoteConnectionAutoConnect(e.hostId,e.autoConnect)','return this.connections.setRemoteConnectionAutoConnect(e.autoConnect,e.hostId)'],
  ['new edV(this.appState,','new foreign(this.appState,'],['remoteConnections:new edM(o=this.remoteConnectionsHandler','remoteConnections:new edM(o=this.unrelatedHandler'],
  ['var ei=r(93246)','var ei=r(1)'],['en=r(33491)','en=r(1)'],
  ['edC=r(23507)','edC=r(1)'],[',edC=r(23507)',''],
  ['new edC.M(', 'new edC.Q('],['edC.Q.map(', 'edC.M.map('],
  ['this.remoteConnectionsHandler=new edV','if(false)this.remoteConnectionsHandler=new edV'],
  ['return new Er({','if(false)return new Er({'],
  ['return new Er({','return null;return new Er({'],
 ])reject(mutate(from,to,mainName));
 const setter=c.mainPersistentSetter;reject(mutate(setter,setter.replace('this.appState.set(ei.Q2Y.REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID,{...r,[e]:t});','').replace('let n=await this.refreshRemoteConnectionsForHostId(e);','let n=await this.refreshRemoteConnectionsForHostId(e);this.appState.set(ei.Q2Y.REMOTE_CONNECTION_AUTO_CONNECT_BY_HOST_ID,{...r,[e]:t});'),mainName));
});
test("main classes/imports and generator/ordinary duplicate methods cannot replace native authorities",()=>{
 for(const statement of['edM=foreign;','edV=foreign;','ei=foreign;','en=foreign;','edC=foreign;','function edC(){}','function ei(){}','function* en(){}','function /*head*/ * /*name*/ ei(){}'])reject(mutate('class RequestWrapper',statement+'class RequestWrapper',mainName));
 reject(mutate(c.mainPersistentSetter,c.mainPersistentSetter+'*setRemoteConnectionAutoConnect(e,t){}',mainName));
 reject(mutate('createAppHost(e){let o,c,g;','createAppHost(e){let o,c,g,edM;',mainName));
 reject(mutate('this.seen=[]}','this.remoteConnectionsHandler=foreign;this.seen=[]}',mainName));
});
test("native visualization service preserves its current connection provider argument",()=>{
 const nativeOwner=c.mainVisualizationOwner;assert.ok(nativeOwner.includes(",void 0,n)"));
 reject(mutate(nativeOwner,nativeOwner.replace(",void 0,n)",",void 0)"),mainName));
 reject(mutate(nativeOwner,nativeOwner.replace(",void 0,n)",",void 0,foreign)"),mainName));
});
test("late facade getter/setter, bootstrap ordering and every physical peer are required",()=>{
 reject(mutate('appServices:()=>i','appServices:()=>n','webview/assets/async/facade-b.js'));
 reject(mutate('setAppServices:function(e){i=e}','setAppServices:function(e){n=e}','webview/assets/async/facade-b.js'));
 reject(mutate('await J.appHost.services','J.appHost.services','webview/assets/async/bootstrap.js'));
 reject(mutate('J=n("GaA7")','J=n("foreign")','webview/assets/async/bootstrap.js'));
 reject(mutate('Y:()=>ee','Y:()=>foreign','webview/assets/async/bootstrap.js'));
 reject(mutate('async function ee(){','function* ee(){}async function ee(){','webview/assets/async/bootstrap.js'));
 const stale=h.snapshots();stale.facade[1]={...stale.facade[1],start:1};assert.throws(()=>prepare(stale),/stale/);
 reject({...native,'webview/assets/async/hidden.js':'export const __webpack_modules__={GaA7(e,t,n){const absent=true}};'});
});
test("changed pending/error behavior, captured locals, disconnected list caches and dead examples refuse",()=>{
 for(const[from,to]of[
  ['of=oc.isPending','of=false'],['om.isPending||og.isPending','foreign.isPending||og.isPending'],
  ['om.mutateAsync({hostId:e,autoConnect:t','om.mutateAsync({hostId:t,autoConnect:e'],['.finally(s)},tw[148]','.finally(()=>{})},tw[148]'],
  ['checked:P.autoConnect','checked:!T.autoConnect'],['e=>X(P.hostId,e)','e=>X(e,T.hostId)'],['ex=Z.autoConnect','ex=Z.autoConnect||true'],['w=e=>J(Z.hostId,e)','w=e=>J(e,Z.hostId)'],
  ['onToggleConnection:P},e.hostId)','onToggleConnection:foreign},e.hostId)'],['let oO=eY,oD=','let oO=foreign,oD='],
  ['let om=(0,l.n)(eR);','let om=(0,l.n)(foreign);'],['return tw[326]','return null;return tw[326]'],
  ['tw[237]!==n9','if(false)tw[237]!==n9'],
 ])reject(mutate(from,to));
 for(const statement of['om=foreign;','oO=foreign;','oD=foreign;','tw=foreign;','eR=foreign;','eY=foreign;','tA=foreign;','tI=foreign;','t_=foreign;'])reject(mutate('let oG=null!=nH;',statement+'let oG=null!=nH;'));
 for(const name of currentSettings.criticalNames)for(const declaration of[`function ${name}(unused=()=>{}){return null}`,`function* ${name}(){return null}`])reject(mutate(currentSettings.entryHead,declaration+currentSettings.entryHead));
 reject(mutate('eY=async(e,t,n)=>{','eY=async(e,t,om)=>{'));
});
test("all selected dependency bytes are preflighted, including symlinks; no-op needs no write permission",()=>temporary(root=>{
 h.writeApp(root);const plan=locate(root),name='webview/assets/async/facade-b.js',file=path.join(root,name);
 fs.appendFileSync(file,'\n// stale');assert.throws(()=>patchWebviewAssets(root,plan.edits),/changed before patch commit/);assert.equal(fs.readFileSync(path.join(root,mainName),'utf8'),native[mainName]);
 fs.writeFileSync(file,native[name]);fs.renameSync(file,file+'.original');fs.symlinkSync(file+'.original',file);assert.throws(()=>patchWebviewAssets(root,plan.edits),/symlink/);assert.equal(fs.readFileSync(path.join(root,settingsName),'utf8'),native[settingsName]);
}));
test("unsupported hidden same-ID copies are collected before any no-op success",()=>temporary(root=>{
 h.writeApp(root);fs.writeFileSync(path.join(root,'webview/assets/async/hidden.js'),'export const __webpack_modules__={GrdY(e,t,n){const absent=true}};');assert.throws(()=>apply(root),/Remote copy scope|Remote auto-connect/);
 for(const[name,source]of Object.entries(native))assert.equal(fs.readFileSync(path.join(root,name),'utf8'),source);
}));

test("discovery collects hidden numeric and scientific main factory peers",()=>temporary(root=>{
 h.writeApp(root);const peer=path.join(root,".vite/build/early-bootstrap-901-abc123.js");
 for(const identity of["26307","2.6307e4"]){fs.writeFileSync(peer,`exports.ids=[901],exports.modules={${identity}(e,t,r){const absent=true}};`);assert.throws(()=>apply(root),/Remote auto-connect/)}
 for(const[name,source]of Object.entries(native))assert.equal(fs.readFileSync(path.join(root,name),"utf8"),source);
}));

test("map spread binding rejects a declaration-only rename and accepts coherent longer local names",()=>{
 reject(mutate("let r=this.getRemoteConnectionAutoConnectByHostId();","let wrongMap=this.getRemoteConnectionAutoConnectByHostId();",mainName));
 const renamed=c.mainPersistentSetter.replace("let r=","let longerMap=").replace("{...r,","{...longerMap,");
 assert.equal(prepare(h.snapshots(mutate(c.mainPersistentSetter,renamed,mainName))).alreadyApplied,true);
});
test("ternary value identifiers retain the declaration binding while object property keys stay literal",()=>{
 reject(mutate(currentSettings.remoteRow,currentSettings.remoteRow.replace('let eu=x;','let wrongTooltip=x;')));
 const row=currentSettings.remoteRow.replace('let eu=x;','let longerTooltip=x;').replace('P.online?eu:ed','P.online?longerTooltip:ed');
 assert.equal(prepare(h.snapshots(mutate(currentSettings.remoteRow,row))).alreadyApplied,true);
});

test("owned handler and live host methods reject bare, quoted, computed, accessor and field overrides",()=>{
 const names=["constructor","setRemoteConnectionAutoConnect","getAutoConnectForRemoteConnection","getRemoteConnectionAutoConnectByHostId","clearRemoteConnectionAutoConnect"];
 for(const name of names)for(const member of[
  `${JSON.stringify(name)}(){return null}`,
  `[${JSON.stringify(name)}](){return null}`,
  `['${name}'](){return null}`,
  `[\`${name}\` ](){return null}`,
  `get [${JSON.stringify(name)}](){return null}`,
  `set [${JSON.stringify(name)}](value){}`,
  `${name}=()=>null;`,`${name};`,`${name}\n`,
 ])reject(appendMember(native,"edV",member));
 for(const member of['["createAppHost"](e){return null}','"createAppHost"(e){return null}','createAppHost=()=>null;','createAppHost;','get ["createAppHost"](){return null}'])reject(appendMember(native,"Host",member));
 for(const member of['[unknownKey](){return null}','["setRemote"+"ConnectionAutoConnect"](){return null}','["\\x73etRemoteConnectionAutoConnect"](){return null}','["\\u0073etRemoteConnectionAutoConnect"](){return null}'])reject(appendMember(native,"edV",member));
});
test("native instance fields reject duplicate quoted/computed declarations and field rewrites",()=>{
 for(const [owner,name]of[["edV","appState"],["Host","appState"],["Host","remoteConnectionsHandler"],["Host","visualizations"]])for(const member of[`${JSON.stringify(name)};`,`[${JSON.stringify(name)}]=null;`,`get [${JSON.stringify(name)}](){return null}`])reject(appendMember(native,owner,member));
 for(const statement of['this["remoteConnectionsHandler"]=foreign;','this["appState"]=foreign;','this["visualizations"]=foreign;','this["visualizations"]["createServices"]=()=>({remoteConnections:null});'])reject(mutate('this.seen=[]}',statement+'this.seen=[]}',mainName));
});
test("benign literal class members and proven ambient Symbol members retain native acceptance",()=>{
 for(const member of['otherChoice;','otherChoice=()=>null;','"unrelatedMethod"(){return 1}','["unrelatedMethod"](){return 1}','static ["unrelatedMethod"](){return 1}','[Symbol.dispose](){}'])assert.equal(prepare(h.snapshots(appendMember(native,"edV",member))).alreadyApplied,true);
 const symbols=appendMember(native,"edV",'[Symbol.dispose](){}');reject(mutate('class RequestWrapper','var Symbol=foreign;class RequestWrapper',mainName,symbols));
});
test("returned service object refuses quoted/computed keys and unknown later spreads that can override it",()=>{
 const target='},remoteControlEnvironments:';
 for(const property of['"remoteConnections":null',"['remoteConnections']:null",'["remote"+"Connections"]:null','get ["remoteConnections"](){return null}','[unknownKey]:null','...foreignServices','...foreignServices()','...{"remoteConnections":null}','...{["remoteConnections"]:null}','...{...foreignServices}'])reject(mutate(target,'},'+property+',remoteControlEnvironments:',mainName));
 reject(mutate('systemPermissions:n','remoteConnections:n',mainName));
 reject(mutate('return{visualizations:new ept','return{remoteConnections:new ept',mainName));
 reject(mutate('this.visualizations.createServices(e,','foreignServices(e,',mainName));
 reject(mutate(';return new Er({',';I.remoteConnections=null;return new Er({',mainName));
 reject(mutate(';return new Er({',';mutateObject(I);return new Er({',mainName));
});
test("fixed-key native service spreads accept coherent longer local and producer aliases",()=>{
 const source=native[mainName],longI=source.replace(c.mainSystemServicesInitializer,c.mainSystemServicesInitializer.replace(/^I=/u,'longerSystemServices=')).replace('...I,','...longerSystemServices,');
 assert.equal(prepare(h.snapshots({...native,[mainName]:longI})).alreadyApplied,true);
 reject(mutate(c.mainSystemServicesInitializer,c.mainSystemServicesInitializer.replace(/^I=/u,'wrongSystemServices='),mainName));
 const renamed=source.replaceAll('epe','LongerVisualizationOwner');assert.equal(prepare(h.snapshots({...native,[mainName]:renamed})).alreadyApplied,true);
 // Literal later objects whose keys are known cannot replace the selected service.
 assert.equal(prepare(h.snapshots(mutate('},remoteControlEnvironments:','},...{"unrelated":true},remoteControlEnvironments:',mainName))).alreadyApplied,true);
});
test("native returned fragment must be terminal and coherent longer result aliases still qualify",()=>{
 for(const suffix of[',null',',foreignResult',';return null'])reject(mutate(currentSettings.finalFragment+'}',currentSettings.finalFragment+suffix+'}'));
 const input={...native},copy=h.snapshots(input).settings[0],scope=require('./remote-copy-scope.js'),entry=scope.publishedRootFunction(copy,'RemoteConnectionsSettings'),body=entry.source,lex=createJavaScriptLexicalIndex(body),edits=[...body.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(currentSettings.result)}(?![\\w$])`,"gu"))].filter(row=>lex.isCode(row.index));let renamed=body;
 assert.ok(edits.length>0,"the current returned result must be renamed");
 for(const row of edits.reverse())renamed=renamed.slice(0,row.index)+'longerReturnedFragment'+renamed.slice(row.index+currentSettings.result.length);
 input[settingsName]=copy.source.slice(0,copy.start+entry.start)+renamed+copy.source.slice(copy.start+entry.end);assert.equal(prepare(h.snapshots(input)).alreadyApplied,true);
});

test("v4 visualization construction requires eager execution before root exits", () => {
  const construction = c.mainVisualizationConstruction;
  for (const replacement of [
    `false?${construction}:null`,
    `false&&(${construction})`,
    `true||(${construction})`,
  ]) reject(mutate(construction, replacement, mainName));

  const standalone = native[mainName].replace(construction + ",", "");
  const input = {...native, [mainName]: standalone.replace("this.seen=[]}", construction + ";this.seen=[]}")};
  assert.equal(prepare(h.snapshots(input)).alreadyApplied, true);
  reject(mutate(construction + ";this.seen=[]}", "if(false)" + construction + ";this.seen=[]}", mainName, input));
  reject(mutate(construction + ";this.seen=[]}", "return;" + construction + ";this.seen=[]}", mainName, input));
  reject(mutate(construction + ";this.seen=[]}", "throw Error('stopped');" + construction + ";this.seen=[]}", mainName, input));
});

test("v4 owned field deletion includes dot, literal computed and unknown computed keys", () => {
  for (const field of ["remoteConnectionsHandler", "appState", "visualizations"]) {
    for (const statement of [
      `delete this.${field};`,
      `delete this["${field}"];`,
      `delete this['${field}'];`,
      `delete /*operator*/ this /*receiver*/ ["${field}"];`,
      `delete ((this.${field}));`,
      `delete (this).${field};`,
      `delete ((this))["${field}"];`,
      `delete this?.["${field}"];`,
    ]) reject(mutate("this.seen=[]}", statement + "this.seen=[]}", mainName));
    reject(appendMember(native, "Host", `removeOwnedField(){delete this["${field}"]}`));
  }
  for (const statement of [
    "delete this[unknownKey];",
    "delete this?.[unknownKey];",
    "delete this[chooseKey()];",
    "delete ((this)[unknownKey]);",
    "delete this.visualizations.createServices;",
    'delete this["visualizations"]["createServices"];',
  ]) reject(mutate("this.seen=[]}", statement + "this.seen=[]}", mainName));
  reject(appendMember(native, "edV", 'removeState(){delete this["appState"]}'));
});

test("v4 native and coherent visualization aliases preserve zero-edit qualification", () => {
  const first = prepare(h.snapshots(native));
  const repeat = prepare(h.snapshots(native));
  assert.deepEqual(repeat, first);
  assert.ok(first.edits.every(edit => edit.source === edit.patchedSource));
  const renamed = native[mainName].replaceAll("epe", "LongerVisualizationOwner");
  assert.equal(prepare(h.snapshots({...native, [mainName]: renamed})).alreadyApplied, true);
  const unrelated = mutate("this.seen=[]}", "delete this.unrelated;delete this.visualizations.unrelated;this.seen=[]}", mainName);
  assert.equal(prepare(h.snapshots(unrelated)).alreadyApplied, true);
});

function mainImportInternals(overrides = {}) {
  const file = path.join(__dirname, "auto-connect-contract.js");
  const localRequire = require("node:module").createRequire(file);
  const module = {exports: {}};
  const load = name => Object.hasOwn(overrides, name) ? overrides[name] : localRequire(name);
  const body = fs.readFileSync(file, "utf8");
  const factory = new vm.Script("(function(require,module,exports){" + body +
    "\nreturn {readMainNumericImport, mainImport, mainImportFrame, exact};})", {filename: file}).runInThisContext();
  return factory(load, module, module.exports);
}

function mainImportFixture(body, parameters = ["e", "t", "r"]) {
  return {identity: "finite-main", start: 37, body, parameters};
}

test("function assignments rename independently while native class field names remain literal", () => {
  const local = mainImportInternals();
  assert.doesNotThrow(() => local.exact(
    "function other(){let S,y;S=null==y?null:y.value;return S}",
    "function row(){let y,S;y=null==S?null:S.value;return y}"));
  const nativeClass = "class Owner{connections;constructor(input){this.connections=input}}";
  assert.doesNotThrow(() => local.exact(
    "class Renamed{connections;constructor(value){this.connections=value}}", nativeClass));
  assert.throws(() => local.exact(
    "class Renamed{different;constructor(value){this.connections=value}}", nativeClass), /divergent bounded native policy/);
  assert.throws(() => local.exact(
    "function factory(){class Renamed{different;constructor(value){this.connections=value}}}",
    "function factory(){class Owner{connections;constructor(input){this.connections=input}}}"), /divergent bounded native policy/);
});

test("v5 numeric main import tuples agree with the shared reader on small carriers", () => {
  const local = mainImportInternals();
  const {findRspackRequireBinding} = require("../../scripts/patches/lib/rspack-module-assets.js");
  const carriers = [
    "var state=r(40614);",
    "let state = r( 40614 );",
    'const state = r("40614");',
    "var other=()=>({value:[1,2]}),state=r(40614),tail=3;",
    'var words="comma,semicolon;",state=r(40614);',
    "function unrelated(){var state=r(1)}var state=r(40614);",
    "var state=foreign;",
    "var other=r(40614);",
    "var state=r(1);",
    "var state=r(40614);var state;",
    "var state;var state=r(40614);",
    "var r;var state=r(40614);",
    "function unrelated(){var state=r(40614)}",
    "if(false)var state=r(40614);",
    "if(false){var state=r(40614)}",
    "var state=other(40614);",
    "var state=r('40614');",
  ];
  for (const body of carriers) {
    const frame = mainImportFixture(body);
    const shared = findRspackRequireBinding({params: frame.parameters, moduleSource: body, start: frame.start}, "state");
    assert.deepEqual(local.readMainNumericImport(frame, "state"), shared, body);
  }
});

test("v5 main import authority rejects missing duplicate conditional and uncoupled declarations", () => {
  const local = mainImportInternals();
  for (const body of [
    "var other=r(40614);",
    "var state=r(40614);var state;",
    "var state=r(40614);var state=foreign;",
    "function deferred(){var state=r(40614)}",
    "if(false)var state=r(40614);",
    "if(false){var state=r(40614)}",
    "var previous=0\nif(false)var other=0,state=r(40614);",
    "var state=other(40614);",
    "var state=r(40614,1);",
    "var holder=()=>state=r(40614);",
    "var holder=state=r(40614);",
    "return;var state=r(40614);",
    "throw Error('stopped');var state=r(40614);",
  ]) assert.throws(() => local.mainImport(mainImportFixture(body), "state", "40614"), /Remote auto-connect/);
  assert.throws(() => local.mainImport(mainImportFixture("var state=r(1);"), "state", "40614"), /wrong native main import/);
});

test("v5 main import authority retains eager capture loader and function collision guards", () => {
  const local = mainImportInternals();
  for (const suffix of [
    "state=foreign;", "state++;", "({state}=foreign);",
    "function state(){}", "function* state(){}", "function /*head*/ * /*name*/ state(){}",
    "var r;", "var r=foreign;", "function r(){}", "function* r(){}",
  ]) assert.throws(() => local.mainImport(mainImportFixture("var state=r(40614);" + suffix), "state", "40614"), /Remote auto-connect/);
  assert.throws(() => local.mainImport(mainImportFixture("var state=r(40614);", ["state", "t", "r"]), "state", "40614"), /wrong native main import/);
  assert.doesNotThrow(() => local.mainImport(mainImportFixture("var state=r(40614);function deferred(){state=foreign}"), "state", "40614"));
  assert.doesNotThrow(() => local.mainImport(mainImportFixture("var state=r(40614);{let state=foreign}"), "state", "40614"));
});

test("v5 main import cache follows body loader and offset changes", () => {
  const local = mainImportInternals();
  const frame = mainImportFixture("var state=r(40614),base=r(12892);");
  const cached = local.mainImportFrame(frame);
  const state = local.readMainNumericImport(frame, "state");
  assert.equal(local.readMainNumericImport(frame, "base").moduleId, "12892");
  assert.equal(local.mainImportFrame(frame), cached);
  frame.start += 100;
  assert.equal(local.readMainNumericImport(frame, "state").start, state.start + 100);
  frame.body += "var state=foreign;";
  assert.equal(local.readMainNumericImport(frame, "state"), null);
  assert.notEqual(local.mainImportFrame(frame), cached);
  frame.body = "var state=loadChunk(40614);";
  frame.parameters = ["e", "t", "loadChunk"];
  assert.equal(local.readMainNumericImport(frame, "state").requireName, "loadChunk");
});

test("v5 main import reads avoid the generic scanner and unrelated initializer compilation", () => {
  const actualVM = require("node:vm");
  const shared = require("../../scripts/patches/lib/rspack-module-assets.js");
  let genericReads = 0;
  const local = mainImportInternals({
    "node:vm": {...actualVM, Script: class extends actualVM.Script {
      constructor(text, ...options) {
        assert.ok(!text.includes("UP96_UNRELATED_LARGE_INITIALIZER"));
        super(text, ...options);
      }
    }},
    "../../scripts/patches/lib/rspack-module-assets.js": {...shared,
      findRspackRequireBinding() { genericReads++;throw Error("main generic reader must stay unused"); }},
  });
  const filler = "UP96_UNRELATED_LARGE_INITIALIZER" + "x".repeat(256 * 1024);
  const frame = mainImportFixture("var state=r(40614),base=r(12892);const unrelated=" + JSON.stringify(filler) + ";");
  assert.equal(local.readMainNumericImport(frame, "state").moduleId, "40614");
  assert.equal(local.readMainNumericImport(frame, "base").moduleId, "12892");
  assert.equal(genericReads, 0);
});

test("v5 native cohort and coherent namespace aliases retain zero-edit qualification", () => {
  const plan = prepare(h.snapshots(native));
  assert.equal(plan.alreadyApplied, true);
  assert.ok(plan.edits.every(edit => edit.source === edit.patchedSource));
  const source = native[mainName];
  const lexical = createJavaScriptLexicalIndex(source);
  const replacements = [...source.matchAll(/(?<![\w$.])ei(?![\w$])/gu)].filter(row => lexical.isCode(row.index));
  let renamed = source;
  for (const row of replacements.reverse()) renamed = renamed.slice(0, row.index) + "LongerNativeState" + renamed.slice(row.index + 2);
  assert.equal(prepare(h.snapshots({...native, [mainName]: renamed})).alreadyApplied, true);
  reject(mutate("var ei=r(93246)", "var renamedOnly=r(24240)", mainName));
});

function hostConstructorEdit(input, transform) {
  const source = input[mainName];
  const ownerStart = source.indexOf("class Host{");
  const start = source.indexOf("constructor(e){", ownerStart);
  assert.ok(ownerStart >= 0 && start > ownerStart);
  const open = source.indexOf("{", start);
  const end = createJavaScriptLexicalIndex(source).matchingBrace(open);
  const original = source.slice(start, end + 1);
  return {...input, [mainName]: source.slice(0, start) + transform(original) + source.slice(end + 1)};
}

function renameConstructorOptionsParameter(source, name) {
  const lexical = createJavaScriptLexicalIndex(source);
  const tokens = [...source.matchAll(/(?<![\w$.])e(?![\w$])/gu)].filter(row =>
    lexical.isCode(row.index) && !/^\s*:/u.test(source.slice(row.index + 1)));
  for (const token of tokens.reverse()) source = source.slice(0, token.index) + name + source.slice(token.index + 1);
  return source;
}

test("v6 constructor-local external provider names retain native zero-edit first and repeat", () => {
  for (const name of ["en", "ei", "edM"]) {
    for (const kind of ["let", "var", "parameter"]) {
      const input = hostConstructorEdit(native, source => kind === "parameter"
        ? renameConstructorOptionsParameter(source, name)
        : source.replace("constructor(e){", `constructor(e){${kind} ${name}=()=>null;`));
      const first = prepare(h.snapshots(input));
      const repeat = prepare(h.snapshots(input));
      assert.equal(first.alreadyApplied, true, `${kind} ${name}`);
      assert.deepEqual(repeat, first);
      assert.ok(first.edits.every(edit => edit.source === edit.patchedSource));
    }
  }
});

test("v6 constructor guards still reject global provider writes and actual handler capture", () => {
  for (const name of ["en", "ei", "edM", "edV"]) {
    reject(hostConstructorEdit(native, source => source.replace("this.seen=[]}", `${name}=foreign;this.seen=[]}`)));
  }
  for (const kind of ["let", "var", "parameter"]) {
    const input = hostConstructorEdit(native, source => kind === "parameter"
      ? source.replace("constructor(e){", "constructor(e,edV){")
      : source.replace("constructor(e){", `constructor(e){${kind} edV=foreign;`));
    reject(input);
  }
});

test("v6 actual service and handler use sites keep capture refusal", () => {
  for (const name of ["edM", "Er"]) {
    reject(mutate("createAppHost(e){let o,c,g;", `createAppHost(e){let o,c,g,${name};`, mainName));
    reject(mutate("createAppHost(e){", `createAppHost(e,${name}){`, mainName));
  }
  const setter = c.mainPersistentSetter.replace("setRemoteConnectionAutoConnect(e,t)", "setRemoteConnectionAutoConnect(ei,t)").replace("[e]:t", "[ei]:t").replaceAll("ForHostId(e)", "ForHostId(ei)").replaceAll("Connected(e)", "Connected(ei)").replaceAll("Connection(e)", "Connection(ei)");
  reject(mutate(c.mainPersistentSetter, setter, mainName));
  reject(mutate(c.mainChoiceAndMapGetters, c.mainChoiceAndMapGetters.replace("getRemoteConnectionAutoConnectByHostId(){", "getRemoteConnectionAutoConnectByHostId(){let ei=foreign;"), mainName));
});

test("v6 native and shadow-safe block locals keep constructor context baseline valid", () => {
  const first = prepare(h.snapshots(native));
  assert.ok(first.edits.every(edit => edit.source === edit.patchedSource));
  const block = hostConstructorEdit(native, source => source.replace("constructor(e){", "constructor(e){{let en=()=>null;en();}"));
  assert.equal(prepare(h.snapshots(block)).alreadyApplied, true);
  const captureActualHandler = hostConstructorEdit(native, source => source.replace("constructor(e){", "constructor(e){var edV;"));
  reject(captureActualHandler);
});


test("current cloud preview spread retains a fixed unrelated service key and retires the old state provider",()=>{
 assert.equal(prepare(h.snapshots(native)).alreadyApplied,true);
 reject(mutate('cloudPreviews:this.cloudPreviews','remoteConnections:this.cloudPreviews',mainName));
 reject(mutate('var ei=r(93246)','var ei=r(24240)',mainName));
});

test("current native rename keyboard handler preserves composition veto and Enter/Escape actions",()=>{
 const start=c.rendererRemoteControlRow.indexOf('onKeyDown:e=>{');assert.ok(start>=0);
 const open=c.rendererRemoteControlRow.indexOf('{',start),end=createJavaScriptLexicalIndex(c.rendererRemoteControlRow).matchingBrace(open);
 const text=c.rendererRemoteControlRow.slice(start+'onKeyDown:'.length,end+1);
 for(const composing of[false,true])for(const key of['Enter','Escape','A']){
  const events=[],nativeEvent={composing};
  const handler=vm.runInNewContext('('+text+')',{ime:{X(value){assert.equal(value,nativeEvent);events.push('composition');return composing}},ep:()=>events.push('save'),ef:()=>events.push('cancel')});
  handler({key,nativeEvent,preventDefault:()=>events.push('prevent')});
  assert.deepEqual(events,composing||key==='A'?['composition']:['composition','prevent',key==='Enter'?'save':'cancel']);
 }
 reject(mutate('(0,e6.X)(e.nativeEvent)','(0,e6.X)(foreignEvent)'));
 reject(mutate('e6=n("i7fz")','e6=n("foreignComposition")'));
});


test("method-like bytes inside an opaque native caller message remain literal source",()=>{
 const original=c.rendererCaller;
 try{
  c.rendererCaller=original.replace('Remote connections are unavailable','}statement()');
  const source=mutate('Remote connections are unavailable','}statement()');
  assert.equal(prepare(h.snapshots(source)).alreadyApplied,true);
 }finally{c.rendererCaller=original}
});
