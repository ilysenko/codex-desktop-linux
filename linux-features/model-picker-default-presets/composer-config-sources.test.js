"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),crypto=require("node:crypto");
const api=require("./composer-config-sources.js"),fixture=require("./fixtures/current-composer-config-sources.json");
const sha=value=>crypto.createHash("sha256").update(value).digest("hex"),native=id=>fixture.owners[id];
const specs=[['inspectConfigProvider','agZi',{globalExport:'I',localExport:'m'}],['inspectConfigContext','fNL0',{exportName:'r'}],['inspectEffectiveConfigQuery','YWOa',{exportName:'J8'}],['inspectProfileAlias','wCOm',{exportName:'Y$'}],['inspectProfileOverlay','OeLR',{exportName:'Y$'}],['inspectModelCatalogPredicate','OeLR',{exportName:'bo'}]];
function inspect(method,id,options,source=native(id).moduleSource,patch={}){const original=native(id);return api[method](source,{...original,...patch,moduleSource:source},options)}
function rejects(method,id,options,changes){for(const [before,after]of changes){const source=native(id).moduleSource.replace(before,after);assert.notEqual(source,native(id).moduleSource,before);assert.throws(()=>inspect(method,id,options,source),undefined,before)}}
for(const [method,id,options]of specs)test(`current signed ${id} ${method} returns actual references without changing its snapshot`,()=>{
 const owner=native(id),before=JSON.stringify(owner);assert.equal(sha(owner.moduleSource),owner.bodySha256);const facts=inspect(method,id,options);assert.equal(facts.moduleId,id);assert.equal(JSON.stringify(owner),before);assert(facts.proof.loaderUses.every(row=>['n','d'].includes(row.method)));
});
test("config providers retain exact global and local refs and distinguish their native readiness gates",()=>{
 const f=inspect(...specs[0]);assert.equal(f.globalExport,'I');assert.equal(f.localExport,'m');assert.equal(f.frameworkModuleId,'zTeN');assert.equal(f.scope.moduleId,'OWtl');
 assert.deepEqual(Object.fromEntries(Object.entries(f.refs).map(([key,value])=>[key,value.moduleId])),{identity:'SPnB',experiment:'JYRT',effectiveConfig:'YWOa',providerOverride:'tl5a',catalogPredicate:'OeLR',reserve:'eLmE',schema:'ASxG',equality:'SZCv'});
 assert.equal(f.refs.experiment.flagKey,'423260384');assert.equal(f.proof.falseOnlyToken,true);assert.equal(f.proof.localHost,'local');assert.equal(f.proof.explicitProfileParameter,false);
});
test("global config auth, false-only token, account, user, schema and nonempty-group conditions fail closed on drift",()=>{
 rejects(...specs[0],[['!1===l.hasChatGptToken','!l.hasChatGptToken'],['l.authLoading||',''],['null==l.authenticatedAccountId||',''],['null==l.userId','null==l.authenticatedUserId'],['"chatgpt"!==l.authMethod','"copilot"!==l.authMethod'],['t.data.presets.some(e=>e.length>0)','t.data.presets.every(e=>e.length>0)'],['model:r.string().min(1)','model:r.string()']]);
});
test("local config source preserves local host, provider precedence, catalog and reserve guards",()=>{
 rejects(...specs[0],[['"local"!==l','"local"===l'],['hostId:l,cwd:t','hostId:t,cwd:l'],['i(s.jR,e)??n.model_provider??"openai"','n.model_provider??i(s.jR,e)??"openai"'],['!=='+'"openai"','==='+'"openai"'],['||(0,o.bo)(n)',''],['||i(c.qM,l)',''],['?null:i(p)','?null:i(h)']]);
});
test("config callbacks cannot capture their global identity/schema or local dependency namespaces",()=>{
 const source=native('agZi').moduleSource;
 const cases=[
  source.replace('({get:e})=>{let l=e(u.PO)','({get:u})=>{let l=u(u.PO)').replace('g.safeParse(e(m.X','g.safeParse(u(m.X'),
  source.replace('let l=e(u.PO);if(l.authLoading','let g=e(u.PO);if(g.authLoading').replaceAll('l.authMethod','g.authMethod').replaceAll('l.hasChatGptToken','g.hasChatGptToken').replaceAll('l.authenticatedAccountId','g.authenticatedAccountId').replaceAll('l.userId','g.userId'),
  source.replace('hostId:l,cwd:t},{get:i}','hostId:o,cwd:t},{get:i}').replace('"local"!==l','"local"!==o').replace('hostId:l,cwd:t}).data','hostId:o,cwd:t}).data').replace('i(c.qM,l)','i(c.qM,o)'),
  source.replace('let n=i(d.J8','let p=i(d.J8').replace('null==n||','null==p||').replace('n.model_provider','p.model_provider').replace('(0,o.bo)(n)','(0,o.bo)(p)'),
 ];
 for(const candidate of cases)assert.throws(()=>inspect(...specs[0],candidate),/Shadowed|Aliased/);
});
test("all original provider factories prove loader/exports authority before generic publications",()=>{
 for(const [method,id,options]of specs){const owner=native(id),loader=owner.params[2],exports=owner.params[1];for(const tail of [`;([...${loader}]=foreign);`,`;({...${exports}}=foreign);`,`;const hidden={} / (${loader}=foreign) / 1;`])assert.throws(()=>inspect(method,id,options,owner.moduleSource+tail));for(const prefix of [`${loader}.d=foreign;`,`${loader}.n=foreign;`])assert.throws(()=>inspect(method,id,options,prefix+owner.moduleSource));}
});
test("true loader/import shadows and opaque strings or comments preserve native facts",()=>{
 for(const [method,id,options]of specs){const owner=native(id),loader=owner.params[2];for(const tail of [`;function unrelated(${loader}){${loader}.d=foreign;${loader}.n=foreign}`,`;const unrelated="${loader}.d=foreign";/*async function p*/`])assert.doesNotThrow(()=>inspect(method,id,options,owner.moduleSource+tail))}
});
test("published keys and static module refs can be semantically renamed",()=>{
 const source=native('agZi').moduleSource.replace('I:p,m:h','GlobalReady:p,LocalReady:h').replace('u=t("SPnB")','u=t("IdentityProvider")').replace('m=t("JYRT")','m=t("FlagProvider")');
 const f=inspect('inspectConfigProvider','agZi',{globalExport:'GlobalReady',localExport:'LocalReady'},source,{moduleId:'ConfigProviderRenamed'});assert.equal(f.refs.identity.moduleId,'IdentityProvider');assert.equal(f.refs.experiment.moduleId,'FlagProvider');assert.equal(f.local.globalConfig.moduleId,'ConfigProviderRenamed');
 const query=native('YWOa').moduleSource.replace('J8:h','EffectiveConfig:h').replace('o=n("wCOm")','o=n("ProfileAlias")');assert.equal(inspect('inspectEffectiveConfigQuery','YWOa',{exportName:'EffectiveConfig'},query).refs.profileTransform.moduleId,'ProfileAlias');
});
test("context retains null initialization and actual React require before publication",()=>{
 rejects(...specs[1],[['createContext)(null)','createContext)(void 0)'],['a("zd8w").createContext','foreign("zd8w").createContext'],['r:n','r:foreign']]);
 const original=native('fNL0').moduleSource,parts=original.split(';');assert.throws(()=>inspect(...specs[1],parts[1]+';'+parts[0]+';'));
 const renamed=original.replace('"zd8w"','"ReactCurrent"').replace('r:n','context:n');assert.equal(inspect('inspectConfigContext','fNL0',{exportName:'context'},renamed).refs.react.moduleId,'ReactCurrent');
});
test("effective config query preserves host/cwd keys, connected-host enablement and native profile transform",()=>{
 const facts=inspect(...specs[2]);assert.deepEqual(facts.queryKeyPrefix,['user-saved-config']);assert.equal(facts.refs.connectedHosts.exportName,'Dj');assert.equal(facts.refs.profileTransform.moduleId,'wCOm');assert.deepEqual(facts.proof.readerArgs,['scope','queryClient','hostId','cwd',false]);assert.equal(facts.proof.explicitProfileCacheKey,false);
 rejects(...specs[2],[['queryKey:[...c,n,i]','queryKey:[...c,i,n]'],['enabled:n(s.Dj).includes(t)','enabled:!0'],['(0,o.Y$)(r.config)','r.config'],['catch{return null}','catch{throw Error()}'],['"user-saved-config"','"foreign-config"']]);
});
test("query builder/accessor and profile parser must keep synchronous kinds and real root declarations",()=>{
 for(const prefix of ['async ','async/*kind*/']){rejects(...specs[2],[['function p(',prefix+'function p(']]);rejects(...specs[4],[['function o(',prefix+'function o(']])}
 rejects(...specs[0],[['f.u,({get:e})=>','f.u,async({get:e})=>'],['f.u,({conversationId:e','f.u,async({conversationId:e']]);
 rejects(...specs[2],[['u.u,({cwd:e=null','u.u,async({cwd:e=null']]);
 rejects(...specs[4],[['Y$:function','Y$:async function']]);rejects(...specs[5],[['bo:function','bo:async function']]);
});
test("query builder and native profile transform use sites reject captured namespace aliases",()=>{
 const original=native('YWOa').moduleSource;
 const parameter=original.replace('function p({scope:e','function p({scope:r').replace('(e,t,n,i,!1)','(r,t,n,i,!1)');assert.throws(()=>inspect(...specs[2],parameter),/Shadowed/);
 const response=original.replace('let r=await','let o=await').replace('(r.config)','(o.config)');assert.throws(()=>inspect(...specs[2],response),/Shadowed/);
 const accessor=original.replace('{get:n,queryClient:r,scope:i})=>p(', '{get:p,queryClient:r,scope:i})=>p(').replace('enabled:n(s.Dj)','enabled:p(s.Dj)');assert.throws(()=>inspect(...specs[2],accessor),/Shadowed/);
});
test("profile overlay preserves non-null selected-profile merge and input-identity fallback",()=>{
 const facts=inspect(...specs[4]);assert.equal(facts.refs.recordSchema.moduleId,'ASxG');assert.equal(facts.proof.nonNullOverlayOnly,true);assert.equal(facts.proof.missingProfileReturnsInputIdentity,true);
 const overlay=new vm.Script(`(${facts.proof.functionSource})`).runInNewContext({o:value=>value&&typeof value==='object'&&!Array.isArray(value)?value:null});
 const cfg={model_provider:'openai',model:'base',profile:'work',profiles:{work:{model:'profile',model_provider:null,model_catalog_json:' {} '}}},result=overlay(cfg);assert.equal(result.model,'profile');assert.equal(result.model_provider,'openai');assert.equal(result.model_catalog_json,' {} ');assert.equal(cfg.model,'base');
 const absent={model:'base',profile:'missing',profiles:{}};assert.equal(overlay(absent),absent);
 rejects(...specs[4],[['null!=t&&(r[e]=t)','r[e]=t'],['if(null==n)return e','if(null==n)return {}'],['o(t?.[e.profile])','o(t?.work)']]);
});
test("profile overlay and parser cannot capture their parser/schema/Object imports",()=>{
 const source=native('OeLR').moduleSource;
 const input=source.replace('Y$:function(e){let t=o(e.profiles)','Y$:function(o){let t=o(o.profiles)').replace('typeof e.profile?o(t?.[e.profile])','typeof o.profile?o(t?.[o.profile])').replace('if(null==n)return e;let r={...e}','if(null==n)return o;let r={...o}');assert.throws(()=>inspect(...specs[4],input),/Shadowed/);
 const loop=source.replace('for(let[e,t]of Object.entries(n))null!=t&&(r[e]=t)','for(let[Object,t]of Object.entries(n))null!=t&&(r[Object]=t)');assert.throws(()=>inspect(...specs[4],loop),/Shadowed/);
 const parser=source.replace('function o(e){let t=a.safeParse(e)','function o(a){let t=a.safeParse(a)');assert.throws(()=>inspect(...specs[4],parser),/Shadowed/);
 assert.throws(()=>inspect(...specs[4],source,{params:['Object','t','n']}),/Object/);
 assert.doesNotThrow(()=>inspect(...specs[4],source+';function unrelated(Object){Object={}}'));
});
test("profile alias follows actual import/export and catalog predicate is only trimmed model_catalog_json",()=>{
 const alias=inspect(...specs[3]);assert.deepEqual({moduleId:alias.refs.target.moduleId,exportName:alias.refs.target.exportName},{moduleId:'OeLR',exportName:'Y$'});
 rejects(...specs[3],[['Y$:()=>i.Y$','Y$:()=>unknown.Y$']]);
 const predicate=inspect(...specs[5]),run=new vm.Script(`(${predicate.proof.functionSource})`).runInNewContext({});for(const [value,expected]of [[{},false],[{model_catalog_json:''},false],[{model_catalog_json:'  '},false],[{model_catalog_json:' {} '},true],[{model_provider:'custom'},false]])assert.equal(run(value),expected);assert.equal(predicate.proof.notGeneralProviderPredicate,true);
 rejects(...specs[5],[['e.model_catalog_json.trim().length>0','e.model_catalog_json.length>0']]);
});
test("missing publications, opaque carriers, illegal source and oversized factories are rejected",()=>{
 for(const [method,id,options]of specs){const source=native(id).moduleSource;for(const candidate of ['/*'+source+'*/',JSON.stringify(source),source+'}'])assert.throws(()=>inspect(method,id,options,candidate));assert.throws(()=>inspect(method,id,{...options,exportName:'missing',globalExport:'missing'}));assert.throws(()=>inspect(method,id,options,'/*'+'x'.repeat(256*1024)+'*/'+source));}
});
