"use strict";
const assert=require("node:assert/strict"),test=require("node:test"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {patchCatalog,normalizePresets}=require("./patch.js"),authority=require("./native-catalog-authority.js");
const fixture=require('./fixtures/current-catalog-policy.json'),catalog=require('./fixtures/current-chatgpt-catalog.json'),Policy=require('./catalog-policy.js'),{patchPresetCatalog}=require('./catalog-integration.js');
const context={feature:{settings:{presets:[{model:'gpt-6-astra',effort:'medium',default:true},{model:'gpt-5.6-sol',effort:'high'}]}}};
const sourceChunk=owners=>'export const __webpack_modules__={'+owners.map(owner=>`${JSON.stringify(owner.moduleId)}(${owner.params.join(',')}){${owner.moduleSource}}`).join(',')+'};';
const providers=()=>[...['SPnB','Q3tq','Bl5H','LLIt','WPra','vw1R'].map(id=>fixture.owners[id]),require('./fixtures/current-native-cache-provider.json')];
function files(split=false,overrides={}){const c={...catalog,moduleSource:overrides.catalog??catalog.moduleSource},q={...fixture.owners.sMGP,moduleSource:overrides.tpp??fixture.owners.sMGP.moduleSource},m={...fixture.owners.lTvi,moduleSource:overrides.chatgpt??fixture.owners.lTvi.moduleSource};const result=split?{'catalog.js':sourceChunk([c]),'queries.js':sourceChunk([q,m])}:{'main.js':sourceChunk([c,q,m])};result['providers.js']=sourceChunk(providers().map(owner=>({...owner,moduleSource:overrides[owner.moduleId]??owner.moduleSource})));return result;}
function app(input,fn){const root=fs.mkdtempSync(path.join(os.tmpdir(),'catalog-integration-')),assets=path.join(root,'webview','assets');fs.mkdirSync(assets,{recursive:true});try{for(const[name,source]of Object.entries(input)){fs.mkdirSync(path.dirname(path.join(assets,name)),{recursive:true});fs.writeFileSync(path.join(assets,name),source);}return fn(root,assets);}finally{fs.rmSync(root,{recursive:true,force:true});}}
function unchanged(assets,input){for(const[name,source]of Object.entries(input))assert.equal(fs.readFileSync(path.join(assets,name),'utf8'),source,name);}
test('production main catalog descriptor joins all three real owners in one asset and repeats exactly',()=>app(files(),(root,assets)=>{fs.chmodSync(path.join(assets,'main.js'),0o640);const first=patchCatalog(root,context),before=fs.readFileSync(path.join(assets,'main.js'));assert.equal(first.owners.length,3);assert.equal(first.matched,3);assert.equal(first.changed,1);assert.equal(first.dependencies.length,7);assert.equal(patchCatalog(root,context).changed,0);assert.deepEqual(fs.readFileSync(path.join(assets,'main.js')),before);assert.equal(fs.statSync(path.join(assets,'main.js')).mode&0o777,0o640);}));
test('empty manifest is a native audit across actual catalog/query owners without code changes',()=>app(files(),(root,assets)=>{let writes=0;const empty={feature:{manifest:{presets:[]},settings:{}}},result=patchCatalog(root,empty,{writeFileSync(){writes++}});assert.equal(result.changed,0);assert.equal(result.matched,3);assert(result.owners.every(owner=>owner.state==='pristine'));assert.equal(writes,0);unchanged(assets,files());}));
test('actual owner mixtures and hidden same-id damaged copies refuse before all writes',()=>{const presets=normalizePresets(context),prepared=Policy.prepareCatalogFactory(catalog.moduleSource,catalog,presets,{},authority);for(const input of [files(false,{catalog:prepared.patchedSource}),{...files(),'hidden/bad.js':sourceChunk([{...catalog,moduleSource:'const damaged=true;'}])},{...files(),'hidden/duplicate.js':sourceChunk([{...catalog,moduleId:'differentCatalogIdentity'}])}])app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,context,{writeFileSync(){writes++}}),/Partially|Missing|multiple/);assert.equal(writes,0);unchanged(assets,input);});});
test('native query/catalog/scope/map bindings are linked rather than guessed from fixture names',()=>{const fixtures=fixture.owners;const mutations=[files(false,{tpp:fixtures.sMGP.moduleSource.replace('d=n("TFzY")','d=n("foreign")')}),files(false,{Q3tq:fixtures.Q3tq.moduleSource.replaceAll('(c.u,','(c.otherScope,')}),files(false,{Bl5H:fixtures.Bl5H.moduleSource.replace('a=n("LLIt")','a=n("foreign")')}),files(false,{LLIt:fixtures.LLIt.moduleSource.replace('extended:"high"','extended:"ultra"')})];for(const input of mutations)app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,context,{writeFileSync(){writes++}}));assert.equal(writes,0);unchanged(assets,input);});});
test('actual prepared multi-owner transaction restores both assets after a partial second write',()=>app(files(true),(root,assets)=>{fs.chmodSync(path.join(assets,'catalog.js'),0o640);let writes=0;assert.throws(()=>patchCatalog(root,context,{writeFileSync(file,bytes){if(++writes===2){fs.writeFileSync(file,bytes.subarray(0,9));throw Error('partial device write')}fs.writeFileSync(file,bytes)}}),/partial device write/);unchanged(assets,files(true));assert.equal(fs.statSync(path.join(assets,'catalog.js')).mode&0o777,0o640);}));
test('actual integration refuses orphan metadata and generated invalid helper before any write',()=>{app({...files(),'orphan.js':'const example="codexLinuxDefaultPresetServerVariants";'},(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,context,{writeFileSync(){writes++}}),/Orphan/);assert.equal(writes,0);unchanged(assets,{...files(),'orphan.js':'const example="codexLinuxDefaultPresetServerVariants";'});});const old=Policy.projectCatalog.toString;try{Policy.projectCatalog.toString=()=>"function invalid(";app(files(),(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,context,{writeFileSync(){writes++}}));assert.equal(writes,0);unchanged(assets,files());});}finally{Policy.projectCatalog.toString=old;}});

test('native catalog nested writes reject complete three-owner cohorts before writes',()=>{
 for(const code of ['if(true){A=[]}','if(true){T={parse:()=>({})}}','if(true){\\u0041=[]}']){
  const bad=catalog.moduleSource.replace('return{serviceTiersByModelSlug:R',code+'return{serviceTiersByModelSlug:R');
  const input={...files(),'hidden/bad.js':sourceChunk([{...catalog,moduleSource:bad}])};
  app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,context,{writeFileSync(){writes++}}));assert.equal(writes,0);unchanged(assets,input);});
 }
});
test('quote-bearing regex regression1659 preserves complete asset prefix and suffix on first and repeat',()=>{
  const prefix='const t=e=>e;function yT(e){let n=e.trim();n=n.replace(/^[`"\\\'\\u201c\\u201d\\u2018\\u2019]+|[`"\\\'\\u201c\\u201d\\u2018\\u2019]+$/g,``);return n}function isQuote(e){return"\\\""===e}';
  const suffix='function Pan(){return(Pan=t((()=>{Nan=/[\\t\\n!-,./:-@[-`\\f{-}$\\x80-\\uFFFF]/g})))()}var Nan;export{Pan,isQuote,yT};';
 const input=files();input['main.js']=prefix+input['main.js']+suffix;
 app(input,(root,assets)=>{assert.equal(patchCatalog(root,context).changed,1);const result=fs.readFileSync(path.join(assets,'main.js'),'utf8');assert(result.startsWith(prefix));assert(result.endsWith(suffix));assert.equal(patchCatalog(root,context).changed,0);assert.equal(fs.readFileSync(path.join(assets,'main.js'),'utf8'),result);});
});
test('empty and configured production catalogs validate all three actual cache references',()=>{
 const nativeCache=require('./fixtures/current-native-cache-provider.json');
 const empty={feature:{manifest:{presets:[]},settings:{}}};
 for(const changes of [{moduleId:'foreignCache'},{moduleSource:nativeCache.moduleSource.replace('TB:function','foreignRead:function')},{moduleSource:nativeCache.moduleSource.replace('jx:function','foreignWrite:function')}]){
  const input=files();input['providers.js']=sourceChunk(providers().map(owner=>owner.moduleId===nativeCache.moduleId?{...owner,...changes}:owner));
  for(const settings of [empty,context])app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,settings,{writeFileSync(){writes++}}),/cache/i);assert.equal(writes,0);unchanged(assets,input);});
 }
});

test('auxiliary native map enum and predicate require original loader and exports authority',()=>{
 const empty={feature:{manifest:{presets:[]},settings:{}}};
 for(const id of ['LLIt','WPra','vw1R'])for(const code of [';([...n]=foreign);',';({...t}=foreign);']){
  const input=files(false,{[id]:fixture.owners[id].moduleSource+code});
  app(input,(root,assets)=>{let writes=0;assert.throws(()=>patchCatalog(root,empty,{writeFileSync(){writes++}}),/native Default preset (map|enum|predicate) dependency/);assert.equal(writes,0);unchanged(assets,input);});
 }
});
