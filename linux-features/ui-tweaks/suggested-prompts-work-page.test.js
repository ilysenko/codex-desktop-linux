"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os"),vm=require("node:vm"),test=require("node:test");
const fixtures=require("./fixtures/suggested-prompts-work-page.js");
const {descriptors,suggestedPromptsWorkPageContract:contract,applySuggestedPromptsWorkPagePatch:applySource}=require("./patches/suggested-prompts.js");
const work=require("./patches/suggested-prompts-work-page.js");
const {roleHelpers:{entryContext}}=require("./patches/suggested-prompts-app-page.js");
const {findUniqueRspackModuleCopies,rspackModuleFactories}=require("../../scripts/patches/lib/rspack-module-assets.js");
const {javascriptSourceParses}=require("../../scripts/patches/lib/javascript-syntax.js");
const descriptor=descriptors.find(d=>d.id==="home-suggested-prompts-work-page");
function workspace(t,files,index='<script type="module" src="./assets/runtime.js"></script>') {
  const cache=path.join(process.env.XDG_CACHE_HOME||path.join(os.homedir(),".cache"),"codex-desktop-dev");fs.mkdirSync(cache,{recursive:true});
  const root=fs.mkdtempSync(path.join(cache,"suggested-prompts-work-page-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,"webview/assets"),{recursive:true});fs.writeFileSync(path.join(root,"webview/index.html"),index);
  for(const[name,source]of Object.entries({"runtime.js":fixtures.runtime,...files})) {const file=path.join(root,"webview/assets",name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,source);}
  return root;
}
function unchanged(root,files) {for(const[name,source]of Object.entries(files))assert.equal(fs.readFileSync(path.join(root,"webview/assets",name),"utf8"),source);}
function fixtureRuntime(source) {
  const calls={gate:[],account:[]},context=vm.createContext({});let input;
  const modules=vm.runInContext(source.replace("export const ","const ")+";__webpack_modules__",context);
  const namespaces={JSX:{jsx:(component,props)=>({component,props})},Accounts:{eligible:a=>{calls.account.push(a);return false}},Hooks:{gate:id=>{calls.gate.push(id);return false}},WorkContent:{HomeTaskSuggestions:"NativeWorkContent"},Store:{Ul:()=>input.hostId},Hosts:{threadHostId$:"host"},Controller:{Z:({homeComposerController})=>homeComposerController}};
  const load=id=>namespaces[id];load.d=(target,getters)=>{for(const[key,get]of Object.entries(getters))Object.defineProperty(target,key,{get})};
  modules.WorkPage({}, {},load);
  return{calls,render(props){input=props;return context.workPage(props)}};
}
test("Work descriptor stays opt-in and runs before webview assets",()=>{
  assert.equal(descriptor.phase,"extracted-app:pre-webview");assert.equal(descriptor.enabled({}),false);
  assert.equal(descriptor.enabled({feature:{settings:{tweaks:{home:{suggestedPrompts:{enabled:true}}}}}}),true);
});
test("Work page keeps diagnostics and forwards current destination state with a mode callback",()=>{
  const original=fixtures.chunk(),patched=applySource(original),old=fixtureRuntime(original),run=fixtureRuntime(patched),selected=[];
  const a={hostId:"host-a",authMethod:"chatgpt",email:"fallback@example.test",account:{email:"a@example.test"},plan:"free",editor:{composerProps:{projectId:"project-a"},runLocationState:{effectiveLocation:"local"}},onTaskSuggestionSelected:mode=>selected.push(["a",mode])};
  assert.equal(old.render(a).props.generatedSuggestionsEnabled,false);
  let node=run.render(a);assert.equal(node.props.generatedSuggestionsEnabled,true);assert.equal(node.props.projectId,"project-a");node.props.onSelect("chat");
  node=run.render({...a,hostId:"host-b",editor:{composerProps:{projectId:"project-b"},runLocationState:{effectiveLocation:"cloud"}},onTaskSuggestionSelected:mode=>selected.push(["b",mode])});
  assert.equal(node.props.hostId,"host-b");assert.equal(node.props.projectId,"project-b");assert.equal(node.props.workRunLocation,"cloud");node.props.onSelect("work");
  assert.deepEqual(selected,[["a","chat"],["b","work"]]);assert.deepEqual(run.calls.gate,["2425897452","2425897452"]);assert.equal(run.calls.account.length,2);assert.equal(run.calls.account[0].email,"a@example.test");assert.equal(applySource(patched),patched);
});
test("Work descriptor validates all page copies and dependencies before idempotent writes",t=>{
  const source=fixtures.chunk(),root=workspace(t,{"one.js":source,"nested/two.js":source});
  const result=descriptor.apply(root);assert.equal(result.matched,2);assert.equal(result.changed,2);assert.equal(descriptor.apply(root).changed,0);
  for(const name of ["one.js","nested/two.js"]){const output=fs.readFileSync(path.join(root,"webview/assets",name),"utf8");assert.equal(contract(output),"patched");assert.equal(javascriptSourceParses(output),true);}
});
for(const kind of ["missing","ambiguous","damaged","partial","mixed"])test(`Work descriptor rejects ${kind} copy set atomically`,t=>{
  const source=fixtures.chunk(),patched=applySource(source),files=kind==="missing"?{"one.js":'export const __webpack_modules__={Other(){return false}};'}:{"one.js":source,"two.js":kind==="ambiguous"?source.replace("WorkPage(","OtherPage("):kind==="damaged"?'export const __webpack_modules__={WorkPage(){return false}};':kind==="partial"?patched.replace("codexLinuxUiTweaksSuggestedPromptsEnabled","broken"):patched};
  const root=workspace(t,files);assert.throws(()=>descriptor.apply(root));unchanged(root,files);
});
const mutations={
  "hidden rollout":s=>s.replace('Pe=(0,er.gate)("2425897452")','Pe=!1;function unused(){return(0,er.gate)("2425897452")}'),
  "wrong rollout role":s=>s.replace('(0,er.gate)("2425897452")','(0,s.eligible)("2425897452")'),
  "unbound rollout":s=>s.replace('(0,er.gate)("2425897452")','(0,missing.gate)("2425897452")'),
  "shadowed rollout import":s=>s.replace('function Page(e){','function Page(e){let er={gate:()=>false};'),
  "shadowed account import":s=>s.replace('function Page(e){','function Page(e){let s={eligible:()=>false};'),
  "wrong account":s=>s.replace('(0,s.eligible)({authMethod:Fe,email:b?.email??Le,plan:We})','false'),
  "wrong Work export":s=>s.replace('ChatGptWorkHomePage:()=>Entry','ChatGptWorkHomePage:()=>Page'),
  "hidden export":s=>s.replace('require.d(exports,{ChatGptWorkHomePage:()=>Entry})','if(false)require.d(exports,{ChatGptWorkHomePage:()=>Entry})'),
  "wrong selection":s=>s.replace('mode:"work",onSelect:select,projectId:state','mode:"work",onSelect:editor,projectId:state'),
  "wrong project source":s=>s.replace('projectId:state.composerProps.projectId??null','projectId:other.composerProps.projectId??null'),
  "wrong mode":s=>s.replace('hostId:host,mode:"work",onSelect','hostId:host,mode:"chat",onSelect'),
  "wrong query export":s=>s.replace('queries.ki,args,opts','queries.other,args,opts'),
  "wrong query args":s=>s.replace('queries.ki,args,opts','queries.ki,opts,args'),
  "project query field":s=>s.replace('hostId:host,mode:mode,supportsHomeFeed:cached','hostId:host,projectId:project,mode:mode,supportsHomeFeed:cached'),
  "wrong direct query value export":s=>s.replace('{ki:query}','{ki:scope}'),
  "text preparation argument":s=>s.replace('prepared=select?.(target)','prepared=select?.(text)'),
  "missing preparation await":s=>s.replace('null!=prepared&&await prepared','null!=prepared&&prepared'),
  "wrong editor setter":s=>s.replace('editor.setPromptText(text','other.setPromptText(text'),
  "missing focus":s=>s.replace('editor.focus()','record()'),
  "wrong list callback":s=>s.replace('let click=action;','let click=record;'),
  "wrong lazy target":s=>s.replace('require.bind(require,"WorkPage")','require.bind(require,"OtherPage")'),
  "wrong lazy export":s=>s.replace(').ChatGptWorkHomePage',').OtherPage'),
  "wrong preparation forwarding":s=>s.replace('onChatGptTaskSuggestionSelected:callback','onChatGptTaskSuggestionSelected:change'),
  "wrong shell export":s=>s.replace('Z:()=>Entry','Z:()=>Page'),
  "unused page entry view":s=>s.replace('children:(0,jsx.jsx)(Page,{...e})','children:null,unused:(0,jsx.jsx)(Page,{...e})'),
  "page child string":s=>s.replace('children:(0,jsx.jsx)(Page,{...e})',`children:null,unused:'(0,jsx.jsx)(Page,{...e})'`),
  "page child callback":s=>s.replace('children:(0,jsx.jsx)(Page,{...e})','children:null,unused:()=>(0,jsx.jsx)(Page,{...e})'),
  "query atom constructor":s=>s.replace('(0,store.vU)','(0,store.vP)'),
  "query read hook":s=>s.replace('(0,store._U)(queries.ki','(0,store.Ul)(queries.ki'),
  "unused provider view":s=>s.replace('return(0,jsx.jsx)(Inner,','let unused=(0,jsx.jsx)(Inner,').replace('workRunLocation:run})}function Inner','workRunLocation:run});return null}function Inner'),
};
for(const[name,mutate]of Object.entries(mutations))test(`Work descriptor rejects ${name} before writing`,t=>{
  const source=fixtures.chunk(),damaged=mutate(source);assert.notEqual(damaged,source);const files={"owner.js":damaged},root=workspace(t,files);
  assert.throws(()=>descriptor.apply(root));unchanged(root,files);
});
test("Work canonical state still rejects changed dependency, export and callback roles",t=>{
  const source=applySource(fixtures.chunk());let checked=0;
  for(const[name,mutate]of Object.entries(mutations)){const damaged=mutate(source);if(damaged===source)continue;const files={"owner.js":damaged},root=workspace(t,files);assert.throws(()=>descriptor.apply(root),undefined,name);unchanged(root,files);checked++;}
  assert.ok(checked>=20);
});
for(const id of ["Hooks","Accounts","WorkContent","Query","Shell","Preparation"])test(`Work descriptor rejects marker-free ${id} dependency copies`,t=>{
  const files={"owner.js":fixtures.chunk(),"replica.js":`export const __webpack_modules__={${id}(){return false}};`},root=workspace(t,files);assert.throws(()=>descriptor.apply(root));unchanged(root,files);
});
let signed;
function signedFixture(){
  if(signed)return signed;const official=process.env.CODEX_SIGNED_EXTRACTED_APP,assets=path.join(official,"webview/assets");
  const owners=findUniqueRspackModuleCopies(assets,{sourceMatch:s=>s.includes("ChatGptWorkHomePage:"),matchModule:work.isCandidate}),entry=entryContext(official),cache=new Map(),info=work.inspectModule(owners[0]);assert.ok(info);
  const roles=work.validateDependencies(assets,info,cache,entry.entryId),dependencies=[...cache.values()].flat(),files={};for(const m of [...owners,...dependencies])files[m.assetName]=m.source;
  const index=fs.readFileSync(path.join(official,"webview/index.html"),"utf8");for(const m of index.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)){const name=/^(?:\.\/|\/)?assets\/([^/?#]+\.js)$/u.exec(m[1])?.[1];if(name)files[name]=fs.readFileSync(path.join(assets,name),"utf8");}
  return signed={owners,roles,dependencies,files,index,info,entry};
}
const signedOnly={skip:process.env.CODEX_SIGNED_EXTRACTED_APP==null};
test("signed Work page resolves native callers/provider and patches through production descriptor",signedOnly,t=>{
  const {files,index,owners,roles}=signedFixture(),root=workspace(t,files,index);assert.equal(owners.length,1);assert.equal(descriptor.apply(root).changed,1);assert.equal(descriptor.apply(root).changed,0);
  const output=fs.readFileSync(path.join(root,"webview/assets",owners[0].assetName),"utf8");assert.equal(contract(output),"patched");assert.equal(javascriptSourceParses(output),true);
  assert.ok(roles.callers.preparation.callback);assert.ok(roles.providerRoles.every(role=>role.query.exportName==="ki"));
});
test("signed Work JSX forwards mode callback and current host/project/run-location without invoking it",signedOnly,()=>{
  const {owners}=signedFixture(),patched=applySource(owners[0].moduleSource,owners[0]),info=work.inspectModule({...owners[0],moduleSource:patched}),object=info.consumer.text,calls=[];
  for(const label of["alpha","beta"]){const callback=mode=>calls.push([label,mode]),a=info.accountCall,context={[info.rollout]:true,[a.namespace]:{[a.member]:()=>false},[a.auth]:"chatgpt",[a.info]:{email:`${label}@test`},[a.email]:"fallback",[a.plan]:"free",[info.fields.host]:`host-${label}`,[info.fields.selection]:callback,[info.fields.state]:{composerProps:{projectId:`project-${label}`},runLocationState:{effectiveLocation:label==="alpha"?"local":"cloud"}}};
    const props=vm.runInNewContext(`(${object})`,context);assert.equal(props.generatedSuggestionsEnabled,true);assert.equal(props.hostId,`host-${label}`);assert.equal(props.projectId,`project-${label}`);assert.equal(props.mode,"work");assert.equal(props.onSelect,callback);assert.equal(calls.length,label==="alpha"?0:1);props.onSelect(label==="alpha"?"chat":"work");}
  assert.deepEqual(calls,[["alpha","chat"],["beta","work"]]);
});
test("signed Work query executes each native direct value export with host/mode flags only",signedOnly,async()=>{
  const {dependencies,roles}=signedFixture(),role=roles.providerRoles[0],queries=dependencies.filter(m=>m.moduleId===role.query.moduleId);assert.ok(queries.length>=1);
  for(const module of queries){const requests=[],namespace=new Proxy(function(){},{get:(_target,key)=>key==="vU"?(_scope,fn)=>fn:key==="vP"?()=>new Set():key==="appServices"?{ambientSuggestions:{getChatGptComposerItems:input=>{requests.push(input);return Promise.resolve([])}}}:namespace,construct:()=>({}),apply:()=>({})});
    const load=()=>namespace;load.d=(target,getters,values={})=>{for(const[key,get]of Object.entries(getters))Object.defineProperty(target,key,{get});Object.assign(target,values)};const target={};vm.runInNewContext(`(function(${module.params.join(",")}){${module.moduleSource}})`,{Set,URL})({},target,load);
    for(const[host,mode,supports]of[["alpha","work",false],["beta","chat",true]]){const config=target[role.query.exportName]({hostId:host,mode,supportsHomeFeed:supports},{get:()=>"account"});assert.deepEqual(Array.from(config.queryKey),["chatgpt-task-suggestions","account",host,mode,supports]);await config.queryFn({signal:null});assert.deepEqual(Object.keys(requests.at(-1)).sort(),["entrypoint","hostId"]);assert.equal(requests.at(-1).hostId,host);assert.equal(requests.at(-1).entrypoint,mode);}}
});
test("signed native preparation changes mode or awaits a valid chat destination",signedOnly,async()=>{
  const {roles}=signedFixture(),p=roles.callers.preparation,source=p.expression,calls=[];
  const globals=Object.fromEntries([...new Set(source.match(/\b[A-Za-z_$][\w$]*\b/gu))].map(name=>[name,()=>true]));globals.Error=Error;
  const allowed=/^([\w$]+)\?/u.exec(source)[1],current=/if\([\w$]+!==([\w$]+)\)/u.exec(source)[1],can=/if\(!([\w$]+)\)/u.exec(source)[1],unified=/;if\(([\w$]+)\)\{if\("chat"/u.exec(source)[1];
  const prep=/return\(0,([\w$]+)\.([\w$]+)\)\(([\w$]+),\3\.get\(([\w$]+)\.([\w$]+),null\),([\w$]+)\)\.then\(([\w$]+)\)/u.exec(source);assert.ok(prep);
  const change=/\}([\w$]+)\([\w$]+,void 0,"task_suggestion"\)/u.exec(source)[1];
  globals[allowed]=true;globals[current]="work";globals[can]=true;globals[unified]=false;globals[change]=(...args)=>calls.push(args);globals[prep[3]]={get:()=>"home"};globals[prep[4]]={[prep[5]]:"mode"};globals[prep[1]]={[prep[2]]:()=>Promise.resolve(true)};
  const helpers=p.helpers.map(h=>`function ${h.name}(${h.params}){${h.body}}`).join(";");const callback=()=>vm.runInNewContext(`(()=>{${helpers};return ${source}})()`,globals);
  callback()("work");assert.equal(calls.length,0);callback()("chat");assert.deepEqual(calls,[["chat",undefined,"task_suggestion"]]);
  globals[unified]=true;assert.equal(await callback()("chat"),undefined);globals[prep[1]][prep[2]]=()=>Promise.resolve(false);await assert.rejects(callback()("chat"),/Suggestion destination is unavailable/);
  globals[can]=false;assert.throws(()=>callback()("chat"),/Suggestion destination is unavailable/);
});
test("signed Work roles reject altered exports, query aliases, preparation and real editor bindings",signedOnly,t=>{
  const {owners,dependencies,roles,files,index,info}=signedFixture(),provider=dependencies.find(m=>m.moduleId===roles.providerModule),query=dependencies.find(m=>m.moduleId===roles.providerRoles[0].query.moduleId),shell=dependencies.find(m=>m.moduleId===roles.callers.shellModule),prep=dependencies.find(m=>m.moduleId===roles.callers.preparationModule);
  const mutations=[
    [owners[0],body=>body.replace(`onSelect:${info.fields.selection}`,`onSelect:${info.fields.state}`)],
    [owners[0],body=>body.replace(`(0,${info.rolloutCall.namespace}.${info.rolloutCall.member})("2425897452")`,`(0,${info.accountCall.namespace}.${info.accountCall.member})("2425897452")`)],
    [owners[0],body=>body.replace('ChatGptWorkHomePage:()=>ew','ChatGptWorkHomePage:()=>eC')],
    [provider,body=>body.replace('HomeTaskSuggestions:()=>n_','HomeTaskSuggestions:()=>nA')],
    [provider,body=>body.replace('eb.ki,d,_','eb.Pe,d,_')],
    [provider,body=>body.replace('eb.ki,d,_','eb.ki,_,d')],
    [provider,body=>body.replace('s=eJ?.(t);','s=eJ?.(c);')],
    [provider,body=>body.replace('null!=s&&await s,','null!=s&&s,')],
    [provider,body=>body.replace('tr.setPromptText(c,','other.setPromptText(c,')],
    [provider,body=>body.replace('T(),tr.focus(),n','T(),T(),n')],
    [provider,body=>body.replace('let nr=Q;','let nr=J;')],
    [query,body=>body.replace(/ki:([\w$]+)/u,'ki:unknown')],
    [query,body=>body.replace('.vU)','.vP)')],
    [provider,body=>body.replace('(0,g._U)(eb.ki,d,_)','(0,g.Ul)(eb.ki,d,_)')],
    [owners[0],body=>body.replace('children:(0,r.jsx)(eC,{...e})',`children:null,unused:'(0,r.jsx)(eC,{...e})'`)],
    [owners[0],body=>body.replace('children:(0,r.jsx)(eC,{...e})','children:null,unused:()=>(0,r.jsx)(eC,{...e})')],
    [owners[0],body=>body.replace('function ew(e){','function ew(e){let unused=(0,r.jsx)(eC,{...e});').replace('children:(0,r.jsx)(eC,{...e})','children:null')],
    [shell,body=>body.replace('.ChatGptWorkHomePage)', '.OtherPage)')],
    [shell,body=>body.replace('onTaskSuggestionSelected:h.onChatGptTaskSuggestionSelected','onTaskSuggestionSelected:h.other')],
    [prep,body=>body.replace('onChatGptTaskSuggestionSelected:eo','onChatGptTaskSuggestionSelected:ea')],
    [owners[0],body=>body.replace('):o=t[1],o}','):o=t[1],null}')],
    [owners[0],body=>body.replace(':eF=eH[116],eF}',':eF=eH[116],null}')],
    [prep,body=>body.replace(':ei=es[114],ei}',':ei=es[114],null}')],
    [provider,body=>body.replace(':ey=eN[165],ey}',':ey=eN[165],null}')],
  ];
  for(const canonical of[false,true])for(const[module,mutate]of mutations){
    const damaged=mutate(module.moduleSource);assert.notEqual(damaged,module.moduleSource);
    const overrides={...files};if(canonical)overrides[owners[0].assetName]=applySource(owners[0].source);
    let full=module.source.slice(0,module.start)+damaged+module.source.slice(module.end);if(canonical&&module.moduleId===owners[0].moduleId){full=mutate(applySource(module.source));assert.notEqual(full,applySource(module.source));}
    overrides[module.assetName]=full;const root=workspace(t,overrides,index);assert.throws(()=>descriptor.apply(root));unchanged(root,overrides);
  }
});
