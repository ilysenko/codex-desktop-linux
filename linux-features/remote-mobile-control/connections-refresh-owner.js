"use strict";
const fs=require("node:fs"),path=require("node:path"),{Script}=require("node:vm");
const scope=require("./remote-copy-scope.js"),contract=require("./connections-refresh-contracts.js");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {findUniqueRspackModuleCopies}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {listWebviewAssetFiles,patchWebviewAssets}=require("../../scripts/patches/lib/assets.js");
const {inspectAppServicesFacade}=require("./renderer-remote-connections-owners.js");
const {prepareRemoteMobileVisibility}=require("./remote-control-visibility.js");
const {hasStableEagerMainBinding}=require("../../scripts/patches/lib/main-request-sites.js");
const ID="[A-Za-z_$][\\w$]*",MARKER="codexLinuxRemoteConnectionsRefreshNow",escape=s=>s.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
function fail(reason){throw Error("Remote Connections refresh: "+reason)}
function one(rows,reason){if(rows.length!==1)fail(reason);return rows[0]}
function norm(text){return scope.normalized({params:["unusedModule","unusedExports","unusedRequire"],moduleSource:text}).text}
function matches(copy,re,owner=null){const body=owner?.source??copy.moduleSource,offset=owner?.start??0,lex=scope.context(copy).lexical;return[...body.matchAll(re)].filter(r=>lex.isCode(offset+r.index)).map(r=>Object.assign(r,{at:offset+r.index}))}
function render(text,bindings){const lex=createJavaScriptLexicalIndex(text);return text.replace(/[A-Za-z_$][\w$]*/gu,(name,at)=>lex.isCode(at)&&text[at-1]!=="."&&!/^\s*:/u.test(text.slice(at+name.length))&&bindings[name]?bindings[name]:name)}
function rootLets(copy,entry){
 const body=copy.moduleSource.slice(entry.open+1,entry.end-1),offset=entry.open+1,lex=createJavaScriptLexicalIndex(body),rows=[];
 const valid=text=>{try{new Script(`"use strict";for(let ${text};;){}`);return true}catch{return false}};
 for(const head of body.matchAll(/\blet\b/gu)){if(!lex.isCode(head.index)||!lex.isRoot(head.index))continue;let p=head.index-1;while(p>=0&&!lex.isCode(p))p--;if(p>=0&&!";}".includes(body[p]))continue;let start=head.index+3;while(/\s/u.test(body[start]??""))start++;let end=start;while(end<body.length&&!(body[end]===";"&&lex.isCode(end)&&lex.isRoot(end)))end++;if(end===body.length||!valid(body.slice(start,end)))continue;const list={start:offset+head.index,end:offset+end};let cursor=start;
  for(let at=start;at<=end;at++){if(at!==end&&!(body[at]===","&&lex.isCode(at)&&lex.isRoot(at)&&valid(body.slice(start,at))))continue;let left=cursor,right=at;while(/\s/u.test(body[left]??""))left++;while(right>left&&/\s/u.test(body[right-1]))right--;rows.push({start:offset+left,end:offset+right,text:body.slice(left,right),list});cursor=at+1;}
 }return rows;
}
function initializer(decls,row,reason){return one(decls.filter(d=>d.start===row.at&&d.end===row.at+row[0].length&&d.text===row[0]),"actual root let "+reason)}
function componentProjection(copy,entry){let prefix="__codexRefreshScope";while(entry.source.includes(prefix))prefix+="$";return{params:[prefix+"M",prefix+"E",prefix+"R"],start:0,moduleSource:copy.moduleSource.slice(entry.open+1,entry.end-1),offset:entry.open+1}}
function sameLocal(projected,name,at){scope.unshadowed(projected,name,at-projected.offset)}
function stableComponentBinding(projected,name,initialized){
 const start=initialized.at-projected.offset,end=start+initialized[0].length;
 const withoutInitializer=projected.moduleSource.slice(0,start)+name+projected.moduleSource.slice(end);
 // Remove only the independently certified root-let initializer. Preserve the
 // accepted literal eager-write boundary: deferred/shadowed scopes are not ours,
 // and memo-element writes do not rebind the memo array itself.
 if(!hasStableEagerMainBinding(withoutInitializer,name))fail("eager component binding rebind "+name);
}
function rootStatement(projected,at){const index=at-projected.offset,lex=scope.context(projected).lexical;if(!lex.isCode(index)||!lex.isRoot(index))fail("nested cache/mount statement");let before=index-1;while(before>=0&&!lex.isCode(before))before--;if(before>=0&&!";}".includes(projected.moduleSource[before]))fail("conditional cache/mount statement")}
function prepareConnectionsRefreshOwner(copy){
 if(!copy||Buffer.byteLength(copy.moduleSource??"")>256*1024)fail("bounded settings owner");scope.stableFactoryParameters(copy);const entry=scope.publishedRootFunction(copy,"RemoteConnectionsSettings"),decls=rootLets(copy,entry),projected=componentProjection(copy,entry);
 const interval=one(matches(copy,/window\.setInterval\(/gu,entry),"single native polling interval"),effect=scope.enclosingFunction(copy,interval.at),assignment=new RegExp(`(${ID})=$`,"u").exec(copy.moduleSource.slice(entry.start,effect.start));if(!assignment)fail("effect assignment");const effectVar=assignment[1];
 const local=new RegExp(`^\\(\\)=>\\{let (${ID})=null,(${ID})=!1,`,"u").exec(effect.source);if(!local)fail("native effect local state");
 const call=one([...effect.source.matchAll(new RegExp(`await\\s+(${ID})\\((${ID})\\.signal\\)`,"gu"))],"live effect-event call");if(call[2]!==local[1])fail("effect abort signal binding");
 const intervalVar=new RegExp(`(${ID})=$`,"u").exec(copy.moduleSource.slice(effect.start,interval.at))?.[1];if(!intervalVar)fail("interval handle");
 const effectBindings={e:local[1],t:local[2],n:intervalVar,oI:call[1]},nativeEffect=render(contract.nativeEffect,effectBindings),patchedEffect=render(contract.patchedEffect,effectBindings);let state;
 if(effect.source===nativeEffect)state="native";else if(effect.source===patchedEffect)state="patched";else fail("incomplete owned effect");
 if(new Set(Object.values(effectBindings)).size!==4||Object.values(effectBindings).some(n=>n.startsWith("codexLinuxRemoteConnectionsRefresh")))fail("captured effect bindings");
 if(copy.moduleSource.split(MARKER).length-1!==patchedEffect.split(MARKER).length-1&&state==="patched"||state==="native"&&copy.moduleSource.includes(MARKER))fail("orphan refresh marker");
 const event=one(matches(copy,new RegExp(`(?<![\\w$.])${escape(call[1])}=\\(0,(${ID})\\.useEffectEvent\\)\\((${ID})\\)`,"gu"),entry),"native useEffectEvent binding"),react=event[1],handlerVar=event[2];initializer(decls,event,"effect event");
 const log=one(matches(copy,/[A-Za-z_$][\w$]*\.v\.debug\("\[remote-connections\/settings\] auto_refresh_failed"/gu,entry).map(row=>({at:row.at})),"native auto-refresh handler");
 const handler=scope.enclosingFunction(copy,log.at),handlerAssign=new RegExp(`(${ID})=$`,"u").exec(copy.moduleSource.slice(entry.start,handler.start));if(!handlerAssign||handlerAssign[1]!==handlerVar)fail("handler assignment link");
 const pending=one(matches(copy,new RegExp(`(${ID})=${ID}\\.isPending(?:\\|\\|${ID}\\.isPending){9}`,"gu"),entry),"native mutation-pending aggregate"),available=one(matches(copy,new RegExp(`(${ID})=\\(0,(${ID})\\.wi\\)\\(\\)`,"gu"),entry),"native availability hook");initializer(decls,pending,"mutation pending");initializer(decls,available,"availability");
 const memo=one(matches(copy,new RegExp(`(${ID})=\\(0,(${ID})\\.c\\)\\(${contract.nativeMemoCapacity}\\)`,"gu"),entry),"native memo owner"),memoDecl=initializer(decls,memo,"memo owner");
 for(const row of[pending,available,memo])stableComponentBinding(projected,row[1],row);
 const deps=one(matches(copy,new RegExp(`${escape(memo[1])}\\[135\\]=(${ID})\\):\\1=${escape(memo[1])}\\[135\\]`,"gu"),entry),"native empty dependency cache");
 const service=new RegExp(`(${ID})\\.appServices\\?\\.sshConnections`,"u").exec(handler.source),awaiter=new RegExp(`\\(0,(${ID})\\.P\\)\\(`,"u").exec(handler.source),logger=new RegExp(`(${ID})\\.v\\.debug\\(`,"u").exec(handler.source);if(!service||!awaiter||!logger)fail("native service/awaiter/logger consumers");
 const bindings={tw:memo[1],h:react,eB:effectVar,eX:deps[1],oI:call[1],eZ:handlerVar,op:pending[1],nF:available[1],T:service[1],H:awaiter[1],W:logger[1]};
 const seed=Object.keys(bindings).join(",")+";",actualSeed=Object.values(bindings).join(",")+";";
 if(norm(actualSeed+handler.source+";"+pending[0])!==norm(seed+contract.nativeHandler+";"+contract.pendingSource))fail("native refresh policy and service bindings");
 const handlerBridge=render(contract.handlerBridge,bindings),effectBridge=render(contract.effectBridge,bindings);
 const nativeHandlerBridge=handlerBridge.replace('"__NATIVE_REFRESH_HANDLER__"',handler.source),nativeEffectBridge=effectBridge.replace('"__OWNED_REFRESH_EFFECT__"',effect.source);
 const hb=one(matches(copy,new RegExp(escape(nativeHandlerBridge),"gu"),entry),"handler memo/event bridge"),eb=one(matches(copy,new RegExp(escape(nativeEffectBridge),"gu"),entry),"effect cache/mount bridge");
 rootStatement(projected,hb.at);rootStatement(projected,eb.at);
 if(!(memoDecl.list.start===entry.open+1&&available.at<hb.at&&pending.at<hb.at&&hb.at+hb[0].length<=eb.at))fail("native declaration and callback order");
 for(const name of[handlerVar,effectVar,deps[1]]){const d=one(decls.filter(d=>d.text===name),"native bare component let "+name);if(d.list!==memoDecl.list)fail("component local declaration list");}
 for(const row of[event,pending,available,memo])if(scope.enclosingFunction(copy,row.at).start!==entry.start)fail("nested initializer");
 const ids={facade:scope.requireImport(copy,service[1],handler.start).moduleId,awaiter:scope.requireImport(copy,awaiter[1],handler.start).moduleId,visibility:scope.requireImport(copy,available[2],available.at).moduleId};
 if(scope.requireImport(copy,react,event.at).moduleId!=="zd8w"||scope.requireImport(copy,memo[2],memo.at).moduleId!=="QosV"||scope.requireImport(copy,logger[1],handler.start).moduleId!==contract.nativeLoggerId)fail("native React/memo/logger identity");
 for(const ambient of["window","document","Date","AbortController"]){try{new Script(`"use strict";(function(${copy.params}){${copy.moduleSource}\nlet ${ambient};});`)}catch{fail("captured ambient "+ambient)}scope.unshadowed(copy,ambient,interval.at);}
 for(const[name,sites]of[[handlerVar,[hb]],[effectVar,[eb]],[deps[1],[eb]],[call[1],[hb,eb]]]){
  const decl=one(decls.filter(d=>d.text===name||d.text.startsWith(name+"=")),"component declaration "+name);
  for(const r of matches(copy,new RegExp(`(?<![\\w$.])${escape(name)}(?![\\w$])`,"gu"),entry)){sameLocal(projected,name,r.at);if(decl.start<=r.at&&r.at<decl.end||sites.some(s=>s.at<=r.at&&r.at<s.at+s[0].length))continue;fail("unowned callback/event authority "+name)}
 }
 const patchedSource=copy.moduleSource.slice(0,effect.start)+patchedEffect+copy.moduleSource.slice(effect.end),nativeSource=copy.moduleSource.slice(0,effect.start)+nativeEffect+copy.moduleSource.slice(effect.end);
 return{state,ids,patchedSource,nativeSource,effectVar,eventVar:call[1],entry:entry.name};
}
function prepareConnectionsRefresh(cohort){
 for(const role of["owner","facade","awaiter","visibility","catalog","gate","gateHook"])if(!cohort?.[role]?.length)fail("missing "+role);
 const plans=cohort.owner.map(prepareConnectionsRefreshOwner),first=plans[0];if(plans.some(p=>p.state!==first.state||JSON.stringify(p.ids)!==JSON.stringify(first.ids)))fail("mixed owner states/identities");
 for(const role of["facade","awaiter","visibility"])if(cohort[role].some(c=>c.moduleId!==first.ids[role]))fail("wrong "+role+" identity");
 for(const c of cohort.facade)inspectAppServicesFacade(c);
 for(const c of cohort.awaiter){scope.context(c);if(norm(c.moduleSource)!==norm(contract.awaiter.moduleSource))fail("native abort/await/dispose provider")}
 // Same-feature83 owns visibility policy. Its proposed edits are ignored:87
 // only verifies the known native/78/83 provider states and retains their bytes.
 prepareRemoteMobileVisibility({visibility:cohort.visibility,catalog:cohort.catalog,gate:cohort.gate,gateHook:cohort.gateHook});
 const assets=new Map();for(const copies of Object.values(cohort))for(const c of copies){if(!Number.isInteger(c.start)||!Number.isInteger(c.end)||c.start<0||typeof c.source!=="string"||c.source.slice(c.start,c.end)!==c.moduleSource)fail("stale physical source");const old=assets.get(c.assetName);if(old&&old.source!==c.source)fail("inconsistent physical source");if(!old)assets.set(c.assetName,{assetName:c.assetName,source:c.source,changes:[]})}
 for(const[i,c]of cohort.owner.entries())assets.get(c.assetName).changes.push({start:c.start,end:c.end,patched:plans[i].patchedSource,native:plans[i].nativeSource});
 const edits=[...assets.values()].map(a=>{const splice=key=>{let text=a.source,last=text.length;for(const c of a.changes.sort((x,y)=>y.start-x.start)){if(c.end>last)fail("overlapping owners");text=text.slice(0,c.start)+c[key]+text.slice(c.end);last=c.start}return text};return{assetName:a.assetName,source:a.source,patchedSource:splice("patched"),nativeSource:splice("native")}});
 return{edits,alreadyApplied:first.state==="patched",targetCopies:plans.length,ids:first.ids};
}
function locateConnectionsRefresh(assets){
 const owner=findUniqueRspackModuleCopies(assets,{description:"current live Connections polling owner",sourceMatch:s=>s.includes("RemoteConnectionsSettings:")&&s.includes("auto_refresh_failed"),matchModule:(body,c)=>{if(Buffer.byteLength(body)>256*1024||!body.includes("window.setInterval("))return false;try{prepareConnectionsRefreshOwner(c);return true}catch{return false}}});
 const proof=prepareConnectionsRefreshOwner(owner[0]);const hints={facade:["setAppServices","appServices:"],awaiter:["throwIfAborted","Symbol.dispose"],visibility:["showControlOtherDevices:","showRemoteSshConnections:"],catalog:["catalog.subscribe","localRemoteControlEnvironmentId"],gate:['"1042620455"'],gateHook:["Zj:function",'cache:"signal"']};
 const byId=(role,id)=>findUniqueRspackModuleCopies(assets,{description:"native refresh "+role,sourceMatch:s=>hints[role].every(h=>s.includes(h)),matchModule:(_s,c)=>c.moduleId===id});
 const facade=byId("facade",proof.ids.facade),awaiter=byId("awaiter",proof.ids.awaiter),visibility=byId("visibility",proof.ids.visibility);
 const first=visibility[0],info=scope.normalized(first),catalog=byId("catalog",info.imports[2].moduleId),gate=byId("gate",info.imports[3].moduleId);
 const nativeCheck=one(matches(gate[0],new RegExp(`\\(0,(${ID})\\.Zj\\)\\("1042620455"\\)`,"gu")),"native availability gate subscription");
 const gateHook=byId("gateHook",scope.requireImport(gate[0],nativeCheck[1],nativeCheck.at).moduleId);
 const plan=prepareConnectionsRefresh({owner,facade,awaiter,visibility,catalog,gate,gateHook});let count=0;for(const f of listWebviewAssetFiles(assets,/\.js$/u))count+=fs.readFileSync(path.join(assets,f),"utf8").split(MARKER).length-1;const expected=contract.patchedEffect.split(MARKER).length-1;if(count!==(plan.alreadyApplied?expected*plan.targetCopies:0))fail("orphan physical marker");return plan;
}
function applyConnectionsRefresh(extractedDir,options={}){const assets=path.join(extractedDir,"webview/assets"),plan=locateConnectionsRefresh(assets);return{...patchWebviewAssets(assets,plan.edits,options),matched:true,targetCopies:plan.targetCopies}}
module.exports={MARKER,prepareConnectionsRefreshOwner,prepareConnectionsRefresh,locateConnectionsRefresh,applyConnectionsRefresh};
