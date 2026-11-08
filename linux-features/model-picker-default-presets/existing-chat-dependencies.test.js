"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),crypto=require("node:crypto");
const api=require("./existing-chat-dependencies.js"),fixture=require("./fixtures/current-existing-chat-dependencies.json");
const hash=value=>crypto.createHash("sha256").update(value).digest("hex"),owner=id=>fixture.owners[id];
function queue(source=owner('Eklu').moduleSource,snapshot={}){return api.inspectSelectionQueueProvider(source,{...owner('Eklu'),...snapshot,moduleSource:source})}
function forwarder(source=owner('zd8w').moduleSource,snapshot={}){return api.inspectReactForwarder(source,{...owner('zd8w'),...snapshot,moduleSource:source})}
function client(source=owner('Vlts').moduleSource,snapshot={}){return api.inspectReactClientHooks(source,{...owner('Vlts'),...snapshot,moduleSource:source})}
test("trusted entry provenance and current three native factory bodies remain exact",()=>{
 assert.equal(fixture.entryProvenance.scripts.length,4);assert(fixture.entryProvenance.scripts.includes('/assets/727403.da6b00f04b.js'));assert.equal(fixture.assets['webview/assets/727403.da6b00f04b.js'].bytes,7762);assert(fixture.entryProvenance.selectedPlusEntryBytes<16*1024**2);
 for(const record of Object.values(fixture.owners))assert.equal(hash(record.moduleSource),record.bodySha256);
 const before=JSON.stringify(fixture),q=queue(),f=forwarder(),r=client();assert.equal(JSON.stringify(fixture),before);assert.equal(q.kind,'selection-queue-provider');assert.equal(f.targetModuleId,r.moduleId);assert.equal(r.version,'19.2.7');for(const result of [q,f,r]){assert(Object.isFrozen(result));assert(Object.isFrozen(result.proof))}
});
test("queue facts connect the actual published target pending writing and submit roles",()=>{
 const q=queue();assert.deepEqual([q.targetExport,q.pendingExport,q.writingExport,q.queueExport,q.auxiliaryExport],['BG','EX','si','HM','pu']);assert.deepEqual(q.framework,{moduleId:'zTeN',atomExport:'bD',queueFamilyExport:'T1'});assert.deepEqual(q.scope,{moduleId:'OWtl',exportName:'u'});assert.equal(q.proof.coalescingDelayMs,320);assert.equal(q.proof.conversationTargetIncludesHost,false);assert.equal(q.proof.queueKey,'JSON.stringify(target)');assert.equal(q.proof.overwrittenPendingIsResolved,true);assert.equal(q.proof.overwrittenPendingResult,false);assert.equal(q.proof.catchResult,false);assert.equal(q.proof.cleanupRequiresSameSelectionIdentity,true);
});
test("queue scope and exports can be paired-renamed without hardcoded module or private symbols",()=>{
 const original=owner('Eklu').moduleSource;
 const renamed=original.replace('r=n("zTeN"),i=n("OWtl")','framework=loader("FrameworkCurrent"),scopeNamespace=loader("ScopeCurrent")').replaceAll('(0,r.bD)','(0,framework.bD)').replaceAll('(0,r.T1)','(0,framework.T1)').replaceAll('i.u','scopeNamespace.u').replace('n.d(t,','loader.d(exportsArg,').replaceAll(/\ba\b/gu,'pendingAtom').replaceAll(/\bo\b/gu,'writingAtom').replace('BG:function','Target:function').replace('EX:pendingAtom','Pending:pendingAtom').replace('HM:function','Submit:function').replace('pu:l','Aux:l').replace('si:writingAtom','Writing:writingAtom');
 const q=queue(renamed,{moduleId:'QueueCurrent',params:['moduleArg','exportsArg','loader']});assert.equal(q.targetExport,'Target');assert.equal(q.queueExport,'Submit');assert.equal(q.framework.moduleId,'FrameworkCurrent');assert.equal(q.scope.moduleId,'ScopeCurrent');assert.equal(q.proof.rootBindings.pending,'pendingAtom');
 // These names are real harmless shadows in disjoint native scopes.
 assert.doesNotThrow(()=>queue(original.replace('(i.u,(e,{scope:t})','(i.u,(Promise,{scope:t})')));
});
test("queue rejects altered target shape hash delay coalescing write and identity cleanup",()=>{
 const source=owner('Eklu').moduleSource;for(const [a,b]of [
  ['["conversation",e]','["conversation",n,e]'],['["default",n,r]','["default",r,n]'],['JSON.stringify(t)','JSON.stringify(n)'],['},320)','},321)'],['l.resolve(!1)','l.resolve(!0)'],['null!=i&&clearTimeout(i),',''],['t.set(a,e.target,e.selection)','t.set(o,e.target,e.selection)'],['t.set(o,d.target,d.selection)','t.set(a,d.target,d.selection)'],['l.get(o,s.target)===s.selection','l.get(a,s.target)===s.selection'],['l.get(a,s.target)===s.selection','l.get(a,s.target)!==s.selection'],['d.resolve(u)','d.resolve(!0)'],['null!=n&&null==i&&e()','null!=n&&e()'],['pu:l,si:o','pu:l,si:a'],['r.T1','r.bD'],
 ]){const candidate=source.replace(a,b);assert.notEqual(candidate,source,a);assert.throws(()=>queue(candidate),undefined,a)}
});
test("every queue callback scope protects the captured pending and writing atoms",()=>{
 const s=owner('Eklu').moduleSource;
 const cases=[
  s.replace('(i.u,(e,{scope:t})','(i.u,(a,{scope:t})'),
  s.replace('return e=>{','return a=>{').replaceAll('e.target','a.target').replaceAll('e.selection','a.selection').replace(',n=e,',',n=a,'),
  s.replace('let l=n;','let a=n;').replace('null!=l&&l.resolve(!1)','null!=a&&a.resolve(!1)'),
  s.replace('async function e(){','async function o(){').replace('null==i&&e()','null==i&&o()'),
  s.replace('var l,s;','var a,s;').replace('l=t,s=d','a=t,s=d').replaceAll('l.get','a.get').replaceAll('l.set','a.set'),
  s.replace('var l,s;','var l,o;').replace('s=d','o=d').replaceAll('s.target','o.target').replaceAll('s.selection','o.selection'),
  s.replace('let u=!1;try{u=','let o=!1;try{o=').replace('d.resolve(u)','d.resolve(o)'),
 ];
 for(const candidate of cases)assert.throws(()=>queue(candidate),/captures/);
});
test("native timer globals cannot be captured by queued factory bindings",()=>{
 const s=owner('Eklu').moduleSource;
 const candidate=s.replace('let n=null,r=!1,i=null','let n=null,r=!1,setTimeout=null').replace('null!=i&&clearTimeout(i),i=setTimeout','null!=setTimeout&&clearTimeout(setTimeout),setTimeout=setTimeout').replace('()=>{i=null,async','()=>{setTimeout=null,async').replace('null==i&&e()','null==setTimeout&&e()');assert.throws(()=>queue(candidate),/captures/);
 const split=s.indexOf('n.d(t,'),prefix=s.slice(0,split).replace(/\bt\b/gu,'clearTimeout');assert.throws(()=>queue(prefix+s.slice(split)),/captures/);
});
test("submit wrapper is synchronous new Promise with distinct uncaptured queue and native builtins",()=>{
 const s=owner('Eklu').moduleSource;
 for(const candidate of [
  s.replace('HM:function(e,t,n,r)','HM:async function(e,t,n,r)'),
  s.replace('HM:function(e,t,n,r)','HM:function(Promise,t,n,r)').replace('i=>{e.get(s','i=>{Promise.get(s'),
  s.replace('HM:function(e,t,n,r)','HM:function(e,JSON,n,r)').replace('JSON.stringify(t)','JSON.stringify(JSON)').replace('target:t,write:r','target:JSON,write:r'),
  s.replace('HM:function(e,t,n,r)','HM:function(e,t,s,r)').replace('selection:n,target:t','selection:s,target:t'),
  s.replace('new Promise(i=>{','new Promise(s=>{').replace('resolve:i,selection','resolve:s,selection'),
 ])assert.throws(()=>queue(candidate));
});
test("full queue grammar and original loader exports reject hidden writes opaque source and stale hashes",()=>{
 const s=owner('Eklu').moduleSource;for(const candidate of [s+';n.d=foreign;','n.n=foreign;'+s,s+';([...n]=foreign);',s+';({...t}=foreign);','/*'+s+'*/',JSON.stringify(s),s.replace('},320)','},300)')])assert.throws(()=>queue(candidate,{bodySha256:owner('Eklu').bodySha256}));
});
test("React forwarder proves actual module.exports and require target by a closed grammar",()=>{
 const f=forwarder('moduleArg.exports=loader("ClientCurrent");',{moduleId:'ReactCurrent',params:['moduleArg','exportsArg','loader']});assert.equal(f.targetModuleId,'ClientCurrent');assert.equal(f.proof.moduleExportsAssignment,true);
 for(const candidate of ['t.exports=n("Vlts")','e.exports=foreign("Vlts")','e.exports=n("Vlts");n=foreign','e.exports=n("Vlts");e=foreign','e.exports=n("Vlts");const unrelated=true;'])assert.throws(()=>forwarder(candidate));
});
test("React client uses its published mutable dispatcher and exact synchronous formal forwarding",()=>{
 const facts=client();assert.equal(facts.useRefExport,'useRef');assert.equal(facts.useLayoutEffectExport,'useLayoutEffect');assert.equal(facts.dispatcherName,'R');assert.equal(facts.proof.dispatcherBindingStable,true);assert.equal(facts.proof.noDeepImmutabilityClaim,true);assert.equal(facts.proof.publicHookReferences.length,3);
 const s=owner('Vlts').moduleSource;for(const [a,b]of [['return R.H.useRef(e)','return R.H.useRef(t)'],['return R.H.useLayoutEffect(e,t)','return R.H.useLayoutEffect(t,e)'],['return R.H.useLayoutEffect(e,t)','return R.H.useLayoutEffect(e)'],['R.H.useRef(e)','R.A.useRef(e)'],['t.useRef=function','t.useRef=async function'],['t.useLayoutEffect=function','t.useLayoutEffect=function*'],['S:null},H=','S:!0},H=']]){assert(s.includes(a),a);assert.throws(()=>client(s.replace(a,b)),undefined,a)}
});
test("React hook parameters cannot shadow the captured dispatcher",()=>{
 const s=owner('Vlts').moduleSource;for(const [a,b]of [['t.useRef=function(e){return R.H.useRef(e)}','t.useRef=function(R){return R.H.useRef(R)}'],['t.useLayoutEffect=function(e,t){return R.H.useLayoutEffect(e,t)}','t.useLayoutEffect=function(R,t){return R.H.useLayoutEffect(R,t)}'],['t.useLayoutEffect=function(e,t){return R.H.useLayoutEffect(e,t)}','t.useLayoutEffect=function(e,R){return R.H.useLayoutEffect(e,R)}']])assert.throws(()=>client(s.replace(a,b)),/dispatcher formals/);
});
test("React exports and dispatcher binding are readonly without asserting slot immutability",()=>{
 const s=owner('Vlts').moduleSource;for(const tail of [';t=foreign;',';([...t]=foreign);',';R=foreign;',';if(true){R=foreign}'])assert.throws(()=>client(s+tail));
 assert.doesNotThrow(()=>client(s+';R.H=runtimeDispatcher;'));
 assert.doesNotThrow(()=>client(s+';function harmless(t,R){t.useRef=foreign;R=foreign}'));
});
test("targeted public API and internals census refuses duplicates overwrites and static quoted writes",()=>{
 const s=owner('Vlts').moduleSource;for(const tail of [';t.useRef=foreign;',';t["useLayoutEffect"]=foreign;',String.raw`;\u0074.useRef=foreign;`,';t.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=foreign;',';(()=>{t.useRef=foreign})();'])assert.throws(()=>client(s+tail),/public hook reference/);
 assert.throws(()=>client(s.replace('t.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=R','t.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=foreign')),/published dispatcher/);
});
test("React dispatcher and module identity can be paired-renamed while public API stays native",()=>{
 const s=owner('Vlts').moduleSource.replace(/\bR\b/gu,'Dispatcher');const result=client(s,{moduleId:'ReactClientCurrent',params:['moduleArg','t']});assert.equal(result.dispatcherName,'Dispatcher');assert.equal(result.moduleId,'ReactClientCurrent');
});
test("intended CJS arities syntax budget and opaque pseudo-carriers fail closed",()=>{
 const s=owner('Vlts').moduleSource;assert.throws(()=>client(s,{params:['e','t','n']}));assert.throws(()=>forwarder(owner('zd8w').moduleSource,{params:['e','t']}));for(const candidate of ['/*'+s+'*/',JSON.stringify(s),s+'}'])assert.throws(()=>client(candidate));assert.throws(()=>client('/*'+'x'.repeat(256*1024)+'*/'+s));
});
