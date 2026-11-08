"use strict";
const assert=require("node:assert/strict"),test=require("node:test"),vm=require("node:vm"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),crypto=require("node:crypto");
const {createJavaScriptLexicalIndex}=require("../../scripts/patches/lib/minified-js.js");
const {nativeResetOwner,nativeResetResolver,resetFactoryState,auditPickerReset}=require("./picker-reset.js");
const current=require("./fixtures/current-picker-reset.json"),source=current.moduleSource;
const sha=x=>crypto.createHash("sha256").update(x).digest("hex"),plain=x=>JSON.parse(JSON.stringify(x));
const snapshot=(text=source,params=current.params)=>({moduleSource:text,params});
const chunk=(text=source,id="resetOwner")=>`export const __webpack_modules__={${id}(${current.params.join(",")}){${text}}};`;
const dependency=(text=current.resolver.source,id=current.resolver.moduleId,key=current.resolver.exportName)=>`export const __webpack_modules__={${id}(module,exports,loader){loader.d(exports,{},{${key}:${text}})}};`;
function app(files,fn){files={"dependency.js":dependency(),...files};const root=fs.mkdtempSync(path.join(os.tmpdir(),"picker-reset-")),assets=path.join(root,"webview","assets");fs.mkdirSync(assets,{recursive:true});try{for(const [name,text]of Object.entries(files)){fs.mkdirSync(path.dirname(path.join(assets,name)),{recursive:true});fs.writeFileSync(path.join(assets,name),text);}return fn(root,assets);}finally{fs.rmSync(root,{recursive:true,force:true});}}
function harness(){const proof=nativeResetOwner(source,current);assert(proof);const g=proof.groups,cache=[],ref={current:null},effects=[],calls=[];let latestCallback;const resolver=new vm.Script(`(${current.resolver.source})`).runInNewContext({}),event=(...args)=>latestCallback(...args);const context={
 [g.memoApi]:{c:()=>cache},[g.react]:{useRef:()=>ref,useEffectEvent(fn){latestCallback=fn;return event},useEffect(fn){effects.push(fn)}},[g.experiments]:{[source.match(/\(0,o\.([\w$]+)\)/u)[1]]:()=>({get:()=>false})},[g.resolver]:{[g.resolveExport]:resolver}};
 const filterAt=source.indexOf(`function ${g.withoutXHigh}(`),filterOpen=source.indexOf("{",filterAt),filterEnd=createJavaScriptLexicalIndex(source).matchingBrace(filterOpen);context[g.withoutXHigh]=new vm.Script(`(${source.slice(filterAt,filterEnd+1)})`).runInNewContext({});
 const fn=new vm.Script(`(${source.slice(proof.publication.fn.start,proof.publication.fn.end)})`).runInNewContext(context);return{render(props){return plain(fn(props))},flush(){for(const effect of effects.splice(0))effect()},takeEffects(){return effects.splice(0)},calls,ref};}
const pair=(model,effort)=>({id:`${model}:${effort}`,model,reasoningEffort:effort});
function inputs(harness,extra={}){const fallback=pair("default-model","medium");return{canRenderPowerPickerSurface:true,fallbackPowerSelection:fallback,isModelSettingsLoading:false,menuView:"simple",onReset:value=>harness.calls.push(plain(value)),powerSelectionsWithXHigh:[pair("a","medium"),pair("b","medium"),pair("c","medium"),pair("d","xhigh")],resetContextKey:"host-A:draft-A",selectedPowerSelectionWithXHigh:pair("d","xhigh"),skipExperimentExposure:false,...extra};}
test("retained current reset factory and native resolver are hash-pinned, published and syntax-valid",()=>{assert.equal(sha(source),current.provenance.sha256);assert.equal(sha(current.resolver.source),current.resolver.sha256);const proof=nativeResetOwner(source,current);assert(proof);assert.equal(proof.groups.exportName,"q");assert.equal(proof.imports.length,4);assert.doesNotThrow(()=>new vm.Script(`"use strict";(function(${current.params}){${source}})`));});
test("native reset preserves valid selections and resolves invalid xhigh to this context's current fallback once",()=>{const h=harness(),value=inputs(h);h.render(value);h.flush();assert.deepEqual(h.calls,[value.fallbackPowerSelection]);h.render(value);h.flush();assert.equal(h.calls.length,1);h.render({...value,resetContextKey:"host-B:draft-A",fallbackPowerSelection:pair("host-B-default","high")});h.flush();assert.equal(h.calls[1].id,"host-B-default:high");const count=h.calls.length;h.render({...value,selectedPowerSelectionWithXHigh:pair("a","medium"),fallbackPowerSelection:pair("new-default","high")});h.flush();assert.equal(h.calls.length,count);const remount=harness();remount.render(inputs(remount,{selectedPowerSelectionWithXHigh:pair("a","medium")}));remount.flush();assert.equal(remount.calls.length,0);});
test("loading and inactive states defer reset, and a changed host/draft context is independent",()=>{const h=harness(),value=inputs(h);h.render({...value,isModelSettingsLoading:true});h.flush();assert.equal(h.calls.length,0);h.render(value);h.flush();assert.equal(h.calls.length,1);h.render({...value,canRenderPowerPickerSurface:false});h.flush();assert.equal(h.ref.current,null);h.render(value);h.flush();assert.equal(h.calls.length,2);h.render({...value,resetContextKey:"host-A:thread-A"});h.flush();assert.equal(h.calls.length,3);});
test("native effect-event callback prevents an older effect from resetting a newer resolved pair",()=>{const h=harness(),first=inputs(h);h.render(first);const stale=h.takeEffects();h.render({...first,resetContextKey:"host-B:draft-B",fallbackPowerSelection:pair("new-context","high")});for(const fn of stale)fn();assert.equal(h.calls.length,0);h.flush();assert.deepEqual(h.calls,[pair("new-context","high")]);});
test("reset qualification follows renamed imports, locals, publication and module parameters",()=>{const names={n:"memoApi",i:"reactApi",o:"experimentsApi",r:"resolverApi",a:"withoutXHigh",e:"inputArg",t:"exportsArg",l:"loaderArg"};const renamed=source.replace(/\b[nioraetl]\b/gu,name=>names[name]??name).replace('{q:function','{reset:function');assert(nativeResetOwner(renamed,snapshot(renamed,current.params.map(name=>names[name]))));});
test("reset qualifier rejects opaque, unpublished, wrong-binding, free-write and malformed owners",()=>{for(const text of [`/*${source}*/`,`const sample=${JSON.stringify(source)};`,source+source,source.replace('l.d(t,','foreign.d(t,'),source.replace('l.d(t,','l.d(other,'),source.replace('i=l("zd8w")','i=foreign("zd8w")'),source.replace('resetContextKey:P','resetContextKey:wrong'),source.replace('D.current=k,R(L)','D.current=k,R(other)'),source.replace('E=[L,k,O,g]','E=[L,k,other,g]'),source.replace('if(!g){','if(!other){'),source.replace('let S=u,','if(true){\\u0054=foreign}let S=u,'),source+';if(true){i=foreign}',source.replace('reasoningEffort:t}=e;return','reasoningEffort:e}=e;return'),source.replace('S?.id===e&&T(S)','S?.id===S&&T(S)'),source.replace(',s}})',',s}}) broken(')])assert.equal(nativeResetOwner(text,snapshot(text)),null,text.slice(-70));assert.equal(nativeResetOwner('x'.repeat(256*1024+1),current),null);});
test("reset audit reads every physical copy, remains unchanged on repeat and preserves modes",()=>{app({'a.js':chunk(),'nested/b.js':chunk()},(root,assets)=>{fs.chmodSync(path.join(assets,'a.js'),0o640);let writes=0;for(let pass=0;pass<2;pass++){const result=auditPickerReset(root,[],{writeFileSync(){writes++}});assert.equal(result.matched,2);assert.equal(result.dependency.moduleId,current.resolver.moduleId);assert.equal(result.dependency.matched,1);assert.equal(result.changed,0);}assert.equal(writes,0);assert.equal(fs.statSync(path.join(assets,'a.js')).mode&0o777,0o640);for(const name of ['a.js','nested/b.js'])assert.equal(fs.readFileSync(path.join(assets,name),'utf8'),chunk());});});
test("reset audit refuses damaged hidden copies and ambiguous/opaque factories with zero writes",()=>{for(const bad of [source.replace('resetContextKey:','wrongKey:'),'const damaged=true;'])app({'a.js':chunk(),'hidden/b.js':chunk(bad)},root=>{let writes=0;assert.throws(()=>auditPickerReset(root,[],{writeFileSync(){writes++}}),/drifted/);assert.equal(writes,0);});app({'a.js':chunk(),'b.js':chunk(source,'differentIdentity')},root=>assert.throws(()=>auditPickerReset(root),/multiple/));app({'a.js':`/*${chunk()}*/`},root=>assert.throws(()=>auditPickerReset(root),/opaque/));});

test("reset audit recognizes only the exact configured slider contribution and refuses mixed replicas",()=>{
 const {applyPickerSlider}=require("./picker-reset.js"),ids=["a:medium","b:medium"];
 const changed=applyPickerSlider(source,current,ids);
 assert.notEqual(changed,source);assert.equal(resetFactoryState(changed,current,ids).kind,"slider");assert.equal(resetFactoryState(changed,current,ids).native,source);
 for(const text of [changed.replace('"a:medium"','"other:medium"'),changed.replace('?2:3','?1:3'),changed+`/*codex-linux-model-picker-default-presets-slider-minimum*/`])assert.equal(resetFactoryState(text,current,ids).kind,"missing");
 app({'a.js':chunk(changed),'b.js':chunk(changed)},root=>assert.equal(auditPickerReset(root,ids).changed,0));
 app({'a.js':chunk(),'b.js':chunk(changed)},root=>assert.throws(()=>auditPickerReset(root,ids),/Mixed/));
});

test("production reset audit requires its actual published native resolver and every same-id dependency copy",()=>{
 const altered=source.replace('r=l("TWUU")','r=l("foreign")');assert(nativeResetOwner(altered,current));
 app({'a.js':chunk(altered)},root=>assert.throws(()=>auditPickerReset(root),/does not bind/));
 for(const bad of ['const missing=true;',dependency(current.resolver.source,current.resolver.moduleId,'wrongExport'),dependency(current.resolver.source.replace('?t:void 0','?r:void 0'))])app({'a.js':chunk(),'dependency.js':bad},root=>assert.throws(()=>auditPickerReset(root),/resolver dependency/));
 app({'a.js':chunk(),'hidden/b.js':dependency('function(){return null}')},root=>assert.throws(()=>auditPickerReset(root),/Damaged/));
 const changed=dependency().replace('loader.d(exports,','foreign.d(exports,');app({'a.js':chunk(),'dependency.js':changed},root=>assert.throws(()=>auditPickerReset(root),/resolver dependency/));
 assert(nativeResetResolver(`loader.d(exports,{},{renamed:${current.resolver.source}})`,{params:['module','exports','loader']},'renamed'));
});

test("unrestricted reset dependency proves actual original loader and exports before publication",()=>{
 const factory=current.resolver.factory;assert.equal(sha(factory.moduleSource),factory.provenance.bodySha256);assert(nativeResetResolver(factory.moduleSource,factory,current.resolver.exportName));
 const [moduleName,exportsName,loaderName]=factory.params;
 for(const code of [`;([...${loaderName}]=foreign);`,`;({...${exportsName}}=foreign);`,`;const hidden={} / (${loaderName}=foreign) / 1;`,`;const hidden={} / (${exportsName}=foreign) / 1;`]){
  const body=factory.moduleSource+code;
  assert.throws(()=>nativeResetResolver(body,{...factory,moduleSource:body},current.resolver.exportName),/Unstable|Ambiguous slash/);
  const wrapped=`export const __webpack_modules__={${factory.moduleId}(${factory.params.join(',')}){${body}}};`;
  app({'a.js':chunk(),'dependency.js':wrapped},(root,assets)=>{let writes=0;assert.throws(()=>auditPickerReset(root,[],{writeFileSync(){writes++}}),/Unstable|Ambiguous slash/);assert.equal(writes,0);assert.equal(fs.readFileSync(path.join(assets,'dependency.js'),'utf8'),wrapped);});
 }
});
test("unrestricted reset dependency retains true local loader and exports shadows",()=>{
 const factory=current.resolver.factory;
 for(const name of factory.params.slice(1)){
  const body=factory.moduleSource+`;function local(${name}){([...${name}]=foreign)}`;
  assert(nativeResetResolver(body,{...factory,moduleSource:body},current.resolver.exportName));
 }
});
