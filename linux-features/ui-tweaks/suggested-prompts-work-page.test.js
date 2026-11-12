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
  "reassigned provider outer":s=>s.replace('function Inner(e){','Outer=()=>null;function Inner(e){'),
  "reassigned provider inner":s=>s.replace('require.d(exports,{HomeTaskSuggestions:()=>Outer})','Inner=()=>null;require.d(exports,{HomeTaskSuggestions:()=>Outer})'),
  "reassigned selection callback":s=>s.replace('let click=action;','action=()=>null;let click=action;'),
  "encoded reassigned provider outer":s=>s.replace('function Inner(e){',String.raw`Oute\u0072=()=>null;function Inner(e){`),
  "encoded reassigned provider inner":s=>s.replace('require.d(exports,{HomeTaskSuggestions:()=>Outer})',String.raw`Inne\u0072=()=>null;require.d(exports,{HomeTaskSuggestions:()=>Outer})`),
  "encoded reassigned selection callback":s=>s.replace('let click=action;',String.raw`actio\u006e=()=>null;let click=action;`),
  "reassigned list alias":s=>s.replace('let click=action;','let click=action;click=()=>null;'),
  "encoded reassigned list alias":s=>s.replace('let click=action;',String.raw`let click=action;clic\u006b=()=>null;`),
  "reassigned query value":s=>s.replace('require.d(exports,{},{ki:query})','query=()=>null;require.d(exports,{},{ki:query})'),
  "encoded reassigned query value":s=>s.replace('require.d(exports,{},{ki:query})',String.raw`quer\u0079=()=>null;require.d(exports,{},{ki:query})`),
  "wrong lazy target":s=>s.replace('require.bind(require,"WorkPage")','require.bind(require,"OtherPage")'),
  "wrong lazy export":s=>s.replace(').ChatGptWorkHomePage',').OtherPage'),
  "wrong preparation forwarding":s=>s.replace('onChatGptTaskSuggestionSelected:callback','onChatGptTaskSuggestionSelected:change'),
  "wrong shell export":s=>s.replace('Z:()=>Entry','Z:()=>Page'),
  "unused page entry view":s=>s.replace('children:(0,jsx.jsx)(Page,{...e})','children:null,unused:(0,jsx.jsx)(Page,{...e})'),
  "page child string":s=>s.replace('children:(0,jsx.jsx)(Page,{...e})',`children:null,unused:'(0,jsx.jsx)(Page,{...e})'`),
  "page child callback":s=>s.replace('children:(0,jsx.jsx)(Page,{...e})','children:null,unused:()=>(0,jsx.jsx)(Page,{...e})'),
  "query atom constructor":s=>s.replace('(0,store.vU)','(0,store.vP)'),
  "query read hook":s=>s.replace('(0,store._U)(queries.ki','(0,store.Ul)(queries.ki'),
  "retired feed content prop":s=>s.replace('renderHomeFeed:null','mobileFeedContent:null'),
  "retired editor hook":s=>s.replace('(0,composer.a$)()','(0,composer.a)()'),
  "saved lesson request binding":s=>s.replace('supportsSavedLessonChat:saved','supportsSavedLessonChat:account'),
  "saved lesson cache binding":s=>s.replace('host,mode,supports,saved]','host,mode,supports,account]'),
  "saved lesson state reader":s=>s.replace('saved=get(state.saved)','saved=other(state.saved)'),
  "missing preparation early guard":s=>s.replace('if(blocked)return null;',''),
  "wrong preparation early guard":s=>s.replace('if(blocked)return null;','if(other)return null;'),
  "reversed preparation early guard":s=>s.replace('if(blocked)return null;','if(!blocked)return null;'),
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
test("signed Work query keys and requests preserve native host, mode and saved-lesson state",signedOnly,async()=>{
  const {dependencies,roles}=signedFixture(),role=roles.providerRoles[0],queries=dependencies.filter(m=>m.moduleId===role.query.moduleId);assert.ok(queries.length>=1);
  for(const module of queries){
    const requests=[],account=Symbol("account"),savedLesson=Symbol("saved-lesson");
    const namespace=new Proxy(function(){},{get:(_target,key)=>key==="Pe"?account:key==="iT"?savedLesson:key==="vU"?(_scope,fn)=>fn:key==="vP"?()=>new Set():key==="appServices"?{ambientSuggestions:{getChatGptComposerItems:input=>{requests.push(input);return Promise.resolve([])}}}:namespace,construct:()=>({}),apply:()=>({})});
    const load=()=>namespace;load.d=(target,getters,values={})=>{for(const[key,get]of Object.entries(getters))Object.defineProperty(target,key,{get});Object.assign(target,values)};
    const target={};vm.runInNewContext(`(function(${module.params.join(",")}){${module.moduleSource}})`,{Set,URL})({},target,load);
    for(const[host,mode,supports]of[["alpha","work",false],["beta","chat",true]])for(const saved of[false,true]){
      const config=target[role.query.exportName]({hostId:host,mode,supportsHomeFeed:supports},{get:key=>key===savedLesson?saved:"account"});
      assert.deepEqual(Array.from(config.queryKey),["chatgpt-task-suggestions","account",host,mode,supports,saved]);
      await config.queryFn({signal:null});
      assert.deepEqual(Object.keys(requests.at(-1)).sort(),["entrypoint","hostId","supportsSavedLessonChat"]);
      assert.equal(requests.at(-1).hostId,host);assert.equal(requests.at(-1).entrypoint,mode);assert.equal(requests.at(-1).supportsSavedLessonChat,saved);
    }
  }
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
  const {owners,dependencies,roles,files,info}=signedFixture(),provider=dependencies.find(m=>m.moduleId===roles.providerModule),role=roles.providerRoles[0],query=dependencies.find(m=>m.moduleId===role.query.moduleId),shell=dependencies.find(m=>m.moduleId===roles.callers.shellModule),prep=dependencies.find(m=>m.moduleId===roles.callers.preparationModule);
  const {functions}=require("./patches/suggested-prompts-app-page.js").roleHelpers;
  const shellInfo=work.shellRole(shell,info.module.moduleId);
  const action=(body,change)=>body.replace(role.selection.source,change(role.selection.source));
  const encoded=name=>`${name.slice(0,-1)}\\u${name.charCodeAt(name.length-1).toString(16).padStart(4,"0")}`;
  const queryValue=work.valueExport(query,role.query.exportName);
  const nullReturn=(body,name,moduleId)=>{
    if(body.includes("__webpack_modules__")){
      const copy=[...rspackModuleFactories(body,"mutant.js")].find(copy=>copy.moduleId===moduleId);assert.ok(copy);
      return body.slice(0,copy.start)+nullReturn(copy.moduleSource,name)+body.slice(copy.end);
    }
    const fn=functions(body,name)[0];assert.ok(fn);
    const returned=require("./patches/suggested-prompts-app-page.js").roleHelpers.matches(fn.body,/\breturn\b/gu).at(-1);assert.ok(returned);
    return body.slice(0,fn.start)+`function ${fn.name}(${fn.params}){${fn.body.slice(0,returned.index)}return null}`+body.slice(fn.end);
  };
  const mutations=[
    [owners[0],body=>body.replace(`onSelect:${info.fields.selection}`,`onSelect:${info.fields.state}`)],
    [owners[0],body=>body.replace(`(0,${info.rolloutCall.namespace}.${info.rolloutCall.member})("2425897452")`,`(0,${info.accountCall.namespace}.${info.accountCall.member})("2425897452")`)],
    [owners[0],body=>body.replace(`ChatGptWorkHomePage:()=>${info.graph.entry}`,`ChatGptWorkHomePage:()=>${info.graph.leaf}`)],
    [provider,body=>body.replace(`HomeTaskSuggestions:()=>${role.outer}`,`HomeTaskSuggestions:()=>${role.inner}`)],
    [provider,body=>body.replace(role.query.source,role.query.source.replace(`.${role.query.exportName},`,'.unknown,'))],
    [provider,body=>body.replace(role.query.source,role.query.source.replace(`,${role.query.args},${role.query.options})`,`,${role.query.options},${role.query.args})`))],
    [provider,body=>action(body,text=>text.replace(`${role.selection.prepared}=${role.fields.selection}?.(${role.selection.mode})`,`${role.selection.prepared}=${role.fields.selection}?.(${role.selection.prompt})`))],
    [provider,body=>action(body,text=>text.replace(`null!=${role.selection.prepared}&&await ${role.selection.prepared}`,`null!=${role.selection.prepared}&&${role.selection.prepared}`))],
    [provider,body=>action(body,text=>text.replace(`${role.selection.editor}.setPromptText(`,'other.setPromptText('))],
    [provider,body=>action(body,text=>text.replace(`${role.selection.editor}.focus()`,'record()'))],
    [provider,body=>body.replace(`let ${role.selection.alias}=${role.selection.callback}`,`let ${role.selection.alias}=other`)],
    [provider,body=>body+`;${role.outer}=()=>null;`],
    [provider,body=>body+`;${role.inner}=()=>null;`],
    [provider,body=>body.replace(`let ${role.selection.alias}=${role.selection.callback}`,`${role.selection.callback}=()=>null;let ${role.selection.alias}=${role.selection.callback}`)],
    [provider,body=>body+`;${encoded(role.outer)}=()=>null;`],
    [provider,body=>body+`;${encoded(role.inner)}=()=>null;`],
    [provider,body=>body.replace(`let ${role.selection.alias}=${role.selection.callback}`,`${encoded(role.selection.callback)}=()=>null;let ${role.selection.alias}=${role.selection.callback}`)],
    [query,body=>body+`;${queryValue}=()=>null;`],
    [query,body=>body+`;${encoded(queryValue)}=()=>null;`],
    [provider,body=>body.replace(`let ${role.selection.alias}=${role.selection.callback}`,`let ${role.selection.alias}=${role.selection.callback};${role.selection.alias}=()=>null`)],
    [provider,body=>body.replace(`let ${role.selection.alias}=${role.selection.callback}`,`let ${role.selection.alias}=${role.selection.callback};${encoded(role.selection.alias)}=()=>null`)],
    [query,body=>body.replace(`${role.query.exportName}:${work.valueExport(query,role.query.exportName)}`,`${role.query.exportName}:unknown`)],
    [query,body=>body.replace('.vU)','.vP)')],
    [provider,body=>body.replace(role.query.source,role.query.source.replace(`(0,${role.query.readNamespace}._U)`,`(0,${role.query.readNamespace}.Ul)`))],
    [shell,body=>body.replace('.ChatGptWorkHomePage)', '.OtherPage)')],
    [prep,body=>body.replace(`onChatGptTaskSuggestionSelected:${roles.callers.preparation.callback}`,`onChatGptTaskSuggestionSelected:other`)],
    [owners[0],body=>nullReturn(body,info.graph.entry,owners[0].moduleId)],
    [prep,body=>nullReturn(body,roles.callers.preparation.component)],
    [provider,body=>nullReturn(body,role.outer)],
    [provider,body=>nullReturn(body,role.inner)],
    [shell,body=>nullReturn(body,shellInfo.entry)],
  ];
  for(const canonical of[false,true])for(const[module,mutate]of mutations){
    const damaged=mutate(module.moduleSource);assert.notEqual(damaged,module.moduleSource);
    const overrides={...files};if(canonical)overrides[owners[0].assetName]=applySource(owners[0].source);
    let full=module.source.slice(0,module.start)+damaged+module.source.slice(module.end);if(canonical&&module.moduleId===owners[0].moduleId){full=mutate(applySource(module.source));assert.notEqual(full,applySource(module.source));}
    overrides[module.assetName]=full;const root=workspace(t,overrides,signedFixture().index);assert.throws(()=>descriptor.apply(root));unchanged(root,overrides);
  }
});

test("signed provider preserves native runtime and preference gates", signedOnly, () => {
  const { roles } = signedFixture();
  const role = roles.providerRoles[0], policy = role.policy, query = role.queryEnabled;
  const identifiers = [...new Set((policy.expression + query.expression).match(/[A-Za-z_$][\w$]*/gu))];
  const globals = Object.fromEntries(identifiers.map(name => [name, false]));
  globals[policy.native] = true;
  globals[policy.generated] = true;
  globals[policy.preference] = true;
  globals[policy.typed] = true;
  globals[policy.status] = { status: "enabled" };
  globals[query.account] = "account";
  globals[role.fields.mode] = "work";
  const read = () => {
    globals[policy.policy] = vm.runInNewContext(policy.expression, globals);
    return { policy: globals[policy.policy], query: vm.runInNewContext(query.expression, globals) };
  };
  assert.deepEqual(read(), { policy: true, query: true });
  globals[policy.status] = { status: "disabled" };
  assert.deepEqual(read(), { policy: false, query: false });
  globals[policy.status] = { status: "enabled" };
  globals[policy.preference] = false;
  assert.deepEqual(read(), { policy: false, query: false });
  globals[policy.preference] = true;
  globals[policy.generated] = false;
  assert.deepEqual(read(), { policy: false, query: false });
  globals[policy.generated] = true;
  globals[policy.hidden] = true;
  assert.deepEqual(read(), { policy: false, query: false });
});

test("signed native selection awaits mode preparation and keeps stale contexts from pasting", signedOnly, async () => {
  const role = signedFixture().roles.providerRoles[0];
  const create = require("./fixtures/native-work-selection.js").runtime;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const active = create(role, { select: () => pending });
  active.invoke("chat");
  await active.settle();
  assert.deepEqual(active.modeCalls, ["chat"]);
  assert.equal(active.writes.length, 0);
  release();
  await active.settle();
  assert.equal(active.warnings.length, 0);
  assert.equal(active.writes.length, 1);
  assert.equal(active.focused.length, 1);
  assert.equal(active.writes[0].text, "当前建议文字");
  assert.equal(active.pending(), 0);
  for (const change of ["changeDocument", "changeAccount"]) {
    let finish;
    const wait = new Promise(resolve => { finish = resolve; });
    const stale = create(role, { select: () => wait });
    stale.invoke("chat");
    await stale.settle();
    stale[change]();
    finish();
    await stale.settle();
    assert.deepEqual(stale.modeCalls, ["chat"]);
    assert.equal(stale.warnings.length, 0);
    assert.equal(stale.writes.length, 0);
    assert.equal(stale.focused.length, 0);
    assert.equal(stale.pending(), 0);
  }
  for (const change of ["changeAccount", "changeConversation", "changeInstructions"]) {
    const automatic = create(role, { autoSend: true });
    automatic.invoke("chat");
    await automatic.settle();
    assert.equal(automatic.warnings.length, 0);
    assert.equal(automatic.writes.length, 1);
    assert.equal(automatic.queued.length, 1);
    assert.equal(automatic.queued[0](), true);
    automatic[change]();
    assert.equal(automatic.queued[0](), false);
  }
});
