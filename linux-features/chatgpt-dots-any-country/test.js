#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { loadLinuxFeaturePatchDescriptors } = require("../../scripts/lib/linux-features.js");
const { applyWebviewAssetPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const { captureWarnings, createPatchReport } = require("../../scripts/lib/patch-report.js");
const { javascriptSourceParses } = require("../../scripts/patches/lib/javascript-syntax.js");
const {
  CONTRACTS,
  applyDotsAppSharedPatch,
  applyDotsLandingRoutePatch,
  applyDotsPersonalizationPatch,
  descriptors,
} = require("./patch.js");

// Reduced rspack chunks shaped like the latest signed stable Linux webview.
const chunk = (id, body) => `export const __rspack_esm_ids=[${id}];` +
  `export const __webpack_modules__={${body}};`;
const LANDING_ROUTE = 'function route(account,status){if("pending"===status)return"loading";if("error"===status||account?.tbo_config?.tbo_available==null||null==account.structure||null==account.plan_type)return"load-error";if(account.tbo_config.tbo_available){return"enter"}return"unavailable"}';
const SHARED_FACTORY = "jiwy(e,t,n){var r=n(\"zTeN\"),i=n(\"vw1R\"),a=n(\"ksR2\"),s=n(\"CLax\"),o=n(\"SPnB\"),l=n(\"eFn4\"),u=n(\"svjy\"),d=n(\"OWtl\"),c=n(\"PHON\"),p=n(\"OMIV\"),h=n(\"OHD8\"),f=n(\"Vf6c\");let m=(0,r.un)(d.u,({get:e})=>{let t=e(o.chatGptAuthenticatedAccountId$);if(null!=t&&e(a.nw))return{isLoading:!1,isError:!0,isCapable:!1};if(null==t||null==e(o.o8)){let t=e(o.PO);return{isLoading:t.authLoading||t.accountLoading,isError:!1,isCapable:!1}}let{data:n,status:r}=e(s.sE,t);return{isLoading:\"pending\"===r,isError:\"error\"===r,isCapable:\"success\"===r&&n?.accounts[t]?.account.tbo_config?.tbo_available===!0}}),_=(0,r.un)(d.u,({get:e})=>{let t=e(m),n=e(o.chatGptAuthenticatedAccountId$);if(!t.isError||null==n||e(a.nw))return t;let{data:r,error:i,status:l}=e(s.sE,n);return\"error\"===l&&r?.accounts[n]?.account.tbo_config?.tbo_available===!0&&(0,h.$)(i)?{isLoading:!1,isError:!1,isCapable:!0}:t}),g=(0,r.un)(d.u,({get:e})=>e(m).isCapable);function v(e,t){return e?.features?.includes(\"dot_account_access_policy\")?\"success\"===t&&e.account.tbo_config?.tbo_available===!0:null}let y=(0,r.un)(d.u,({get:e})=>{let t=e(o.chatGptAuthenticatedAccountId$);if(null==t||null==e(o.o8))return null;let{data:n,status:r}=e(s.sE,t);return v(n?.accounts[t],r)}),E=(0,r.un)(d.u,({get:e})=>{let t=e(m);return t.isCapable?e(p.JW,(0,c.R)(\"orbit\",\"rbac-enforcement\"))?(0,i.H)({getAccount:()=>e(o.PO),getAccountInfoError:()=>e(l.$S).accountInfoError,permissions:[\"chatgpt.workspace.feature.orbit.local-computer.access\"],getWorkspaceSettings:t=>e(l.Jk,t)}):{isLoading:!1,isError:!1,isCapable:!0}:t}),I=(0,r.un)(d.u,({get:e})=>(0,i.H)({getAccount:()=>e(o.PO),getAccountInfoError:()=>e(l.$S).accountInfoError,permissions:[\"chatgpt.workspace.feature.orbit.slack-teams.access\"],getWorkspaceSettings:t=>e(l.Jk,t)}));function C(e){e.query.invalidate(s.sE,e.get(o.chatGptAuthenticatedAccountId$))}n.d(t,{},{Bu:async function(e){try{await (0,a.SG)(e)}catch{return}C(e)},D5:_,Dj:I,Mo:C,PQ:E,Tw:y,VK:g,qo:function(e){let t=e.get(o.chatGptAuthenticatedAccountId$);if(null==t||null==e.get(o.o8)||e.queryClient.getQueryState(e.query.snapshot(s.sE,t).queryKey)?.status!==\"success\"||e.query.getData(s.sE,t)?.accounts[t]?.account.tbo_config?.tbo_available!==!0)throw Error(e.get(u.g).formatMessage(f.A.accountUnavailable))},vA:m,wx:function(e,t){let n=e.query.snapshot(s.sE,t);return v(n.getData()?.accounts[t],e.queryClient.getQueryState(n.queryKey)?.status)}})}";
const PERSONALIZATION_FUNCTIONS = "function $(e){let t,a,s,r,o,l,c,d,p,_=(0,i.c)(29),{children:f}=e,b=(0,g.zy)(),C=(0,g.Zp)(),T=(0,Y.Zj)(\"534586353\"),x=(0,Y.DR)(\"534586353\"),E=(0,Y.Zj)(!1),A=(0,Y.DR)(\"534586353\"),{authMethod:S,accountId:I,userId:L,isLoading:N}=(0,v.As)(),{status:O}=(0,u.Ul)(y.kf),R=\"chatgpt\"===S&&null!=I&&null!=L,j=!N&&!x&&T&&!E&&!A&&R;_[0]!==j?(t={enabled:j},_[0]=j,_[1]=t):t=_[1];let{data:G,isPending:w,error:U,refetch:k}=(0,u._U)(P.sE,I,t),V=(0,g.Rr)(b.hash.slice(1));if(\"custom\"!==new URLSearchParams(V.pathname?.startsWith(\"settings/\")?V.search:b.search).get(\"rules\")){let e;return _[2]!==f?(e=(0,n.jsx)(n.Fragment,{children:f}),_[2]=f,_[3]=e):e=_[3],e}_[4]!==b||_[5]!==C?(a=()=>void C(et(b,!1),{replace:!0,state:b.state}),_[4]=b,_[5]=C,_[6]=a):a=_[6];let F=a;_[7]===Symbol.for(\"react.memo_cache_sentinel\")?(s=(0,n.jsx)(K.U,{}),_[7]=s):s=_[7],_[8]===Symbol.for(\"react.memo_cache_sentinel\")?(r=(0,n.jsx)(\"p\",{className:\"text-sm text-secondary\",role:\"status\",children:(0,n.jsx)(h.A,{id:\"settings.userRules.unavailable\",defaultMessage:\"Custom rules aren’t available for this account\",description:\"Shown when the custom rules settings page is unavailable for the signed-in account\"})}),_[8]=r):r=_[8],_[9]===Symbol.for(\"react.memo_cache_sentinel\")?(o=(0,n.jsx)(h.A,{id:\"settings.userRules.back\",defaultMessage:\"Back\",description:\"Return to Personalization settings\"}),_[9]=o):o=_[9],_[10]!==F?(l=(0,n.jsxs)(D.P,{title:s,children:[r,(0,n.jsx)(M.$,{onClick:F,color:\"secondary\",children:o})]}),_[10]=F,_[11]=l):l=_[11];let H=l;if(N||\"chatgpt\"===S&&!R&&\"loading\"===O||R&&(x||A)||j&&w){let e;return _[12]===Symbol.for(\"react.memo_cache_sentinel\")?(e=(0,n.jsx)(z.M,{section:\"personalization\"}),_[12]=e):e=_[12],e}if(j&&null==G&&null!=U){let e,t,a,i,s;return _[13]===Symbol.for(\"react.memo_cache_sentinel\")?(e=(0,n.jsx)(K.U,{}),_[13]=e):e=_[13],_[14]===Symbol.for(\"react.memo_cache_sentinel\")?(t=(0,n.jsx)(\"p\",{className:\"text-sm text-danger\",role:\"alert\",children:(0,n.jsx)(h.A,{id:\"settings.userRules.accountLoadError\",defaultMessage:\"Couldn’t check custom rules availability\",description:\"Shown when account information needed to check custom rules access could not be loaded\"})}),_[14]=t):t=_[14],_[15]!==k?(a=()=>void k(),_[15]=k,_[16]=a):a=_[16],_[17]===Symbol.for(\"react.memo_cache_sentinel\")?(i=(0,n.jsx)(h.A,{id:\"settings.userRules.retry\",defaultMessage:\"Try again\",description:\"Retry loading the account's custom rules\"}),_[17]=i):i=_[17],_[18]!==a?(s=(0,n.jsxs)(D.P,{title:e,children:[t,(0,n.jsx)(M.$,{onClick:a,color:\"secondary\",children:i})]}),_[18]=a,_[19]=s):s=_[19],s}if(!T||E||\"chatgpt\"!==S||null==I||null==L||G?.accounts[I]?.account.tbo_config?.tbo_available!==!0)return H;_[20]===Symbol.for(\"react.memo_cache_sentinel\")?(c=(0,n.jsx)(z.M,{section:\"personalization\"}),_[20]=c):c=_[20];let B=`${I}:${L}`;return _[21]!==I||_[22]!==F||_[23]!==B||_[24]!==L?(d=(0,n.jsx)(m.Suspense,{fallback:c,children:(0,n.jsx)(W,{accountId:I,userId:L,onClose:F},B)}),_[21]=I,_[22]=F,_[23]=B,_[24]=L,_[25]=d):d=_[25],_[26]!==d||_[27]!==H?(p=(0,n.jsx)(X,{fallback:H,children:d}),_[26]=d,_[27]=H,_[28]=p):p=_[28],p}function Q(){let e,t,a=(0,i.c)(6),s=(0,Y.Zj)(\"534586353\"),r=(0,Y.Zj)(!1),o=(0,Y.DR)(\"534586353\"),{authMethod:l,accountId:c,userId:d}=(0,v.As)(),m=s&&!r&&!o&&\"chatgpt\"===l&&null!=c&&null!=d;a[0]!==m?(e={enabled:m},a[0]=m,a[1]=e):e=a[1];let{data:h}=(0,u._U)(P.sE,c,e);if(!s||r||o||\"chatgpt\"!==l||null==c||null==d||h?.accounts[c]?.account.tbo_config?.tbo_available!==!0)return null;let p=`${c}:${d}`;return a[2]!==c||a[3]!==p||a[4]!==d?(t=(0,n.jsx)(X,{children:(0,n.jsx)(J,{accountId:c,userId:d},p)}),a[2]=c,a[3]=p,a[4]=d,a[5]=t):t=a[5],t}";
const FIXTURES = {
  "async/221857.4c17f751f6.js": chunk(221857, `Ab12(e,t,n){${LANDING_ROUTE}}`),
  "async/24191.7b05d5cf83.js": chunk(24191,SHARED_FACTORY),
  "async/860646.06b6da0005.js": chunk(860646,`Ef56(module,exports,load){${PERSONALIZATION_FUNCTIONS};exports.page=$;exports.sidebar=Q}`),
};


const signedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;

function withFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }));
    return fn();
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("feature is disabled until selected", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig([], () => {
    assert.equal(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .some((descriptor) => descriptor.id.startsWith("feature:chatgpt-dots-any-country:")),
      false,
    );
  });
  withFeatureConfig(["chatgpt-dots-any-country"], () => {
    assert.deepEqual(
      loadLinuxFeaturePatchDescriptors({ featuresRoot })
        .filter((descriptor) => descriptor.id.startsWith("feature:chatgpt-dots-any-country:"))
        .map((descriptor) => descriptor.id),
      [
        "feature:chatgpt-dots-any-country:dots-landing-route",
        "feature:chatgpt-dots-any-country:dots-app-shared-capability",
        "feature:chatgpt-dots-any-country:dots-personalization-capability",
      ],
    );
  });
});

test("landing route stays visible while preserving the server gate and missing-config safety", () => {
  const patched = applyDotsLandingRoutePatch(LANDING_ROUTE);
  assert.doesNotMatch(patched, /tbo_available==null/);
  assert.match(patched,/if\(account\.tbo_config\.tbo_available\)/);
  assert.equal(applyDotsLandingRoutePatch(patched),patched);
  const route=vm.runInNewContext(patched+";route");
  const account={structure:"personal",plan_type:"plus"};
  for(const tbo_config of [{},{tbo_available:null},{tbo_available:false}]) assert.equal(route({...account,tbo_config}),"unavailable");
  assert.equal(route({...account,tbo_config:{tbo_available:true}}),"enter");
  assert.equal(route(undefined),"load-error");
  assert.equal(route(account),"load-error");
  assert.equal(route({...account,tbo_config:null}),"load-error");
  assert.equal(route({...account,tbo_config:{}},"error"),"load-error");
  assert.equal(route(undefined,"pending"),"loading");
});

test("landing recognizes only a complete original or marked applied contract", () => {
  const patched=applyDotsLandingRoutePatch(LANDING_ROUTE),descriptor=descriptors[0];
  assert.equal(descriptor.assetMatch(LANDING_ROUTE),true);
  assert.equal(descriptor.assetMatch(patched),true);
  assert.ok(descriptor.assetNeedles.every(needle=>LANDING_ROUTE.includes(needle)&&patched.includes(needle)));
  const repeated=captureWarnings(()=>applyDotsLandingRoutePatch(patched));
  assert.equal(repeated.value,patched);assert.deepEqual(repeated.warnings,[]);
  for(const source of ["",LANDING_ROUTE+LANDING_ROUTE,LANDING_ROUTE+patched,patched+patched,
    patched.replace("/*codexDotsLandingRoute*/",""),
    patched.replace("?.tbo_config==null/*codexDotsLandingRoute*/","!1/*codexDotsLandingRoute*/"),
    LANDING_ROUTE.replace("if(account.tbo_config.tbo_available){","if(false){"),
    LANDING_ROUTE.replace("null==account.plan_type","null==other.plan_type")]){
    const result=captureWarnings(()=>applyDotsLandingRoutePatch(source));
    assert.equal(result.value,source);assert.equal(result.warnings.length,1);
  }
});

test("landing production discovery keeps stable needles through the second run and rejects ambiguity", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dots-landing-rspack-"));
  try{
    const assets=path.join(root,"webview/assets/async");fs.mkdirSync(assets,{recursive:true});
    const file=path.join(assets,"221857.current.js"),descriptor=normalizePatchDescriptors([descriptors[0]]);
    fs.writeFileSync(file,FIXTURES["async/221857.4c17f751f6.js"]);
    for(const expected of ["applied","already-applied"]){
      const report=createPatchReport();applyWebviewAssetPatchDescriptors(root,descriptor,{},report);
      assert.equal(report.patches[0].status,expected);
      assert.equal(report.patches[0].assetName,"async/221857.current.js");
      assert.ok(descriptors[0].assetNeedles.every(needle=>fs.readFileSync(file,"utf8").includes(needle)));
    }
    const duplicate=path.join(assets,"duplicate.current.js");fs.copyFileSync(file,duplicate);
    const before=fs.readFileSync(file,"utf8"),report=createPatchReport();
    captureWarnings(()=>applyWebviewAssetPatchDescriptors(root,descriptor,{},report));
    assert.equal(report.patches[0].status,"skipped-optional");
    assert.equal(fs.readFileSync(file,"utf8"),before);assert.equal(fs.readFileSync(duplicate,"utf8"),before);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("shared Dots capability checks no longer reject a country-gated account", () => {
  const patched = applyDotsAppSharedPatch(FIXTURES["async/24191.7b05d5cf83.js"]);
  assert.equal(patched.split("/*codexDotsSharedAccountGate*/").length-1,1);
  assert.equal(patched.split("/*codexDotsSharedCapability*/").length-1,2);
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsAppSharedPatch(patched), patched);
  assert.ok(javascriptSourceParses(patched));
});

function loadSharedCapability(source,state) {
  const keys = Object.fromEntries(["accountId","session","accountState","blocked","query","format","flag"].map(name=>[name,Symbol(name)]));
  const imports = {
    zTeN: {un: (_domain,read)=>({read})},
    vw1R: {H: ()=>({isLoading:false,isError:false,isCapable:false})},
    ksR2: {nw: keys.blocked}, CLax: {sE: keys.query},
    SPnB: {chatGptAuthenticatedAccountId$:keys.accountId,o8:keys.session,PO:keys.accountState},
    eFn4: {}, svjy: {g:keys.format}, OWtl: {u:{}}, PHON: {R:()=>"rbac"},
    OMIV: {JW:keys.flag}, OHD8: {$:error=>error?.recoverable},
    Vf6c: {A:{accountUnavailable:"Account unavailable"}},
  };
  const exports = {};
  const require = id=>{assert.ok(id in imports,id);return imports[id];};
  require.d = (target,getters,values)=>{
    for (const [name,get] of Object.entries(getters)) Object.defineProperty(target,name,{get});
    Object.assign(target,values);
  };
  const factories = vm.runInNewContext(source.replace(/export const (__rspack_esm_ids|__webpack_modules__)=/g,"const $1=")+"\n;__webpack_modules__");
  Object.values(factories)[0]({},exports,require);
  const queryReads = [],invalidations = [];
  const get = (key,accountId)=>{
    if (key?.read) return key.read({get});
    if (key===keys.accountId) return state.accountId;
    if (key===keys.session) return state.session;
    if (key===keys.accountState) return {authLoading:false,accountLoading:false};
    if (key===keys.blocked) return state.blocked;
    if (key===keys.query) {queryReads.push(accountId);return state.response;}
    if (key===keys.format) return {formatMessage:value=>value};
    if (key===keys.flag) return state.rbac;
    assert.fail("unexpected shared capability read");
  };
  const context = {get,queryClient:{getQueryState:()=>({status:state.response.status})},query:{
    snapshot:()=>({queryKey:[state.accountId],getData:()=>state.response.data}),getData:()=>state.response.data,
    invalidate:(key,account)=>invalidations.push([key,account]),
  }};
  return {exports,read:token=>get(token),context,queryReads,invalidations,keys};
}

test("current shared module retains auth, query status, account refresh, workspace RBAC and server-error recovery", () => {
  const data = accountId=>({accounts:{[accountId]:{account:{tbo_config:{tbo_available:false}}}}});
  const state = {accountId:"first",session:{},blocked:false,rbac:false,response:{status:"success",data:data("first")}};
  const original = loadSharedCapability(FIXTURES["async/24191.7b05d5cf83.js"],state);
  const patched = loadSharedCapability(applyDotsAppSharedPatch(FIXTURES["async/24191.7b05d5cf83.js"]),state);
  assert.equal(original.read(original.exports.vA).isCapable,false);
  assert.throws(()=>original.exports.qo(original.context),/Account unavailable/);
  assert.equal(patched.read(patched.exports.vA).isCapable,true);
  assert.doesNotThrow(()=>patched.exports.qo(patched.context));
  for (const [features,status,available,expected] of [
    [[],"success",false,null],
    [["dot_account_access_policy"],"pending",true,false],
    [["dot_account_access_policy"],"success",false,false],
    [["dot_account_access_policy"],"success",true,true],
  ]) {
    state.response.status=status;
    state.response.data.accounts.first={features,account:{tbo_config:{tbo_available:available}}};
    assert.equal(patched.read(patched.exports.Tw),expected,"keeps the native account-access policy");
    assert.equal(patched.exports.wx(patched.context,"first"),expected);
    assert.equal(original.read(original.exports.Tw),expected);
  }
  state.response.status="success";
  state.accountId="second";state.response.data=data("second");
  assert.equal(patched.read(patched.exports.vA).isCapable,true);
  assert.equal(patched.queryReads.at(-1),"second");
  patched.exports.Mo(patched.context);
  assert.deepEqual(patched.invalidations,[[patched.keys.query,"second"]]);
  state.rbac=true;
  assert.equal(patched.read(patched.exports.PQ).isCapable,false,"workspace permission denial remains active");
  state.response.status="pending";
  assert.equal(patched.read(patched.exports.vA).isLoading,true);
  assert.equal(patched.read(patched.exports.vA).isCapable,false);
  assert.throws(()=>patched.exports.qo(patched.context),/Account unavailable/);
  state.response.status="error";state.response.error={recoverable:false};
  assert.equal(patched.read(patched.exports.D5).isError,true);
  state.response.error.recoverable=true;
  assert.equal(patched.read(patched.exports.D5).isCapable,true,"only the upstream recoverable-error path reuses capability");
  state.blocked=true;
  assert.equal(patched.read(patched.exports.vA).isCapable,false);
  state.blocked=false;state.session=null;
  assert.equal(patched.read(patched.exports.vA).isCapable,false);
  assert.throws(()=>patched.exports.qo(patched.context),/Account unavailable/);
  state.accountId=null;
  assert.equal(patched.read(patched.exports.vA).isCapable,false);
});

test("shared capability refuses missing, duplicate, mixed, partial and damaged marked states", () => {
  const source = FIXTURES["async/24191.7b05d5cf83.js"],patched = applyDotsAppSharedPatch(source);
  assert.equal(descriptors[1].assetMatch(source),true);
  assert.equal(descriptors[1].assetMatch(patched),true);
  for (const input of ["",source+source,source+patched,patched+patched,
    "!1/*codexDotsSharedAccountGate*/;!0/*codexDotsSharedCapability*/;!0/*codexDotsSharedCapability*/;",
    source.replace("e.query.getData(s.sE,t)","e.query.getData(oldQuery,t)"),
    patched.replace("e.query.snapshot(s.sE,t)","e.query.snapshot(s.sE,wrongAccount)"),
    patched.replace("/*codexDotsSharedAccountGate*/",""),
    patched.replace("!0/*codexDotsSharedCapability*/","!1/*codexDotsSharedCapability*/"),
    patched.replace("!1/*codexDotsSharedAccountGate*/", "e.query.getData(s.sE,t)?.accounts[t]?.account.tbo_config?.tbo_available!==!0")]) {
    const result = captureWarnings(()=>applyDotsAppSharedPatch(input));
    assert.equal(result.value,input);
    assert.equal(result.warnings.length,1);
  }
  const repeated = captureWarnings(()=>applyDotsAppSharedPatch(patched));
  assert.equal(repeated.value,patched);assert.deepEqual(repeated.warnings,[]);
});

test("shared production selection keeps its retained query needles through repeat and damaged states", () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dots-shared-rspack-"));
  try{
    const assets=path.join(root,"webview/assets/async");fs.mkdirSync(assets,{recursive:true});
    const file=path.join(assets,"24191.current.js"),original=FIXTURES["async/24191.7b05d5cf83.js"],descriptor=descriptors[1];
    const run=()=>{const report=createPatchReport();captureWarnings(()=>applyWebviewAssetPatchDescriptors(root,normalizePatchDescriptors([descriptor]),{},report));return report.patches[0];};
    fs.writeFileSync(file,original);
    assert.ok(descriptor.assetNeedles.every(needle=>original.includes(needle)));
    assert.equal(run().status,"applied");
    const patched=fs.readFileSync(file,"utf8");
    assert.ok(descriptor.assetNeedles.every(needle=>patched.includes(needle)));
    assert.equal(run().status,"already-applied");
    for(const damaged of [
      original.replace("e.query.snapshot(s.sE,t)","e.query.snapshot(s.sE,wrongAccount)"),
      patched.replace("!0/*codexDotsSharedCapability*/","!1/*codexDotsSharedCapability*/"),
    ]){
      fs.writeFileSync(file,damaged);assert.equal(run().status,"skipped-optional");
      assert.equal(fs.readFileSync(file,"utf8"),damaged);
    }
    fs.writeFileSync(file,patched);const duplicate=path.join(assets,"duplicate.current.js");fs.writeFileSync(duplicate,patched);
    assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),patched);assert.equal(fs.readFileSync(duplicate,"utf8"),patched);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("current signed shared capability has one async owner with repeatable production results", {skip:!signedApp}, () => {
  const descriptor = descriptors[1],assets = path.join(signedApp,"webview/assets");
  const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js");
  const owners = findWebviewAssetsContaining(signedApp,descriptor.assetNeedles)
    .map(assetName=>({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")}))
    .filter(({source})=>descriptor.assetMatch(source));
  assert.equal(owners.length,1);
  const [owner] = owners;
  assert.ok(owner.assetName.startsWith("async/"));
  assert.ok(owner.source.includes(SHARED_FACTORY),"shared fixture must be the actual current factory");
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(),"dots-shared-signed-"));
  try {
    const target = path.join(extracted,"webview/assets",owner.assetName);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,owner.source);
    for (const expected of ["applied","already-applied"]) {
      const report = createPatchReport();
      applyWebviewAssetPatchDescriptors(extracted,normalizePatchDescriptors([descriptor]),{},report);
      assert.equal(report.patches[0].status,expected);
      assert.equal(report.patches[0].assetName,owner.assetName);
    }
  } finally {fs.rmSync(extracted,{recursive:true,force:true});}
});

test("personalization Dots checks are patched together", () => {
  const patched = applyDotsPersonalizationPatch(FIXTURES["async/860646.06b6da0005.js"]);
  assert.equal(patched.split("/*codexDotsPersonalization*/").length-1,2);
  assert.doesNotMatch(patched, /\?\.[!01]/);
  assert.equal(applyDotsPersonalizationPatch(patched), patched);
  assert.ok(javascriptSourceParses(patched));
});

function loadPersonalization(source,state) {
  const queryReads = [];
  const hooks = {
    URLSearchParams,
    i: {c:size=>Array(size).fill(Symbol.for("react.memo_cache_sentinel"))},
    g: {zy:()=>({hash:"",search:"?rules=custom"}),Zp:()=>()=>{},Rr:()=>({pathname:"",search:""})},
    Y: {Zj:key=>key===false ? state.hidden : state.enabled,DR:()=>state.pendingGate},
    v: {As:()=>state.auth},
    u: {Ul:()=>({status:"ready"}),_U:(query,account,options)=>{queryReads.push({account,enabled:options.enabled});return state.response;}},
    P: {sE:"query"},y: {kf:"account-status"},
    n: {Fragment:"Fragment",jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})},
    K: {U:"Title"},h: {A:"Message"},D: {P:"Panel"},M: {$:"Button"},z: {M:"Loading"},
    m: {Suspense:"Suspense"},X:"AccessBoundary",W:"RulesPage",J:"RulesSidebar",
  };
  const factories = vm.runInNewContext(source.replace(/export const (__rspack_esm_ids|__webpack_modules__)=/g,"const $1=")+"\n;__webpack_modules__",hooks);
  const pages={};Object.values(factories)[0]({},pages,()=>({}));
  return {...pages,queryReads};
}

function findRendered(node,type) {
  if (node==null||typeof node!=="object") return null;
  if (node.type===type) return node;
  for (const child of [node.props?.children].flat()) {
    const found=findRendered(child,type);if(found) return found;
  }
  return null;
}

test("current Personalization functions retain query/auth/feature gates, account refresh and server-error explanation", () => {
  const source=FIXTURES["async/860646.06b6da0005.js"];
  const state={enabled:true,hidden:false,pendingGate:false,
    auth:{authMethod:"chatgpt",accountId:"first",userId:"user",isLoading:false},
    response:{data:{accounts:{first:{account:{tbo_config:{tbo_available:false}}}}},isPending:false,error:null,refetch(){}}};
  const original=loadPersonalization(source,state),patched=loadPersonalization(applyDotsPersonalizationPatch(source),state);
  assert.equal(original.sidebar(),null);
  assert.equal(findRendered(original.page({children:"settings"}),"Message").props.id,"settings.userRules.unavailable");
  assert.equal(findRendered(patched.page({children:"settings"}),"RulesPage").props.accountId,"first");
  assert.equal(findRendered(patched.sidebar(),"RulesSidebar").props.accountId,"first");
  state.auth.accountId="second";
  assert.equal(findRendered(patched.page({children:"settings"}),"RulesPage").props.accountId,"second");
  assert.equal(findRendered(patched.sidebar(),"RulesSidebar").props.accountId,"second");
  assert.equal(patched.queryReads.at(-1).account,"second");
  state.response.data=undefined;state.response.error=new Error("server rejected account data");
  assert.equal(findRendered(patched.page({children:"settings"}),"Message").props.id,"settings.userRules.accountLoadError");
  state.response.error=null;state.response.isPending=true;
  assert.equal(patched.page({children:"settings"}).type,"Loading");
  state.response.isPending=false;state.enabled=false;
  assert.equal(patched.sidebar(),null);
  assert.equal(findRendered(patched.page({children:"settings"}),"Message").props.id,"settings.userRules.unavailable");
  state.enabled=true;state.auth.authMethod="api-key";
  assert.equal(patched.sidebar(),null);
  assert.equal(findRendered(patched.page({children:"settings"}),"Message").props.id,"settings.userRules.unavailable");
  state.auth.authMethod="chatgpt";state.auth.accountId=null;
  assert.equal(patched.sidebar(),null);
  assert.equal(findRendered(patched.page({children:"settings"}),"Message").props.id,"settings.userRules.unavailable");
});

test("Personalization requires both current gates or both marked replacements", () => {
  const source=FIXTURES["async/860646.06b6da0005.js"],patched=applyDotsPersonalizationPatch(source);
  assert.equal(descriptors[2].assetMatch(source),true);assert.equal(descriptors[2].assetMatch(patched),true);
  for (const input of ["",source+source,source+patched,patched+patched,
    source.replace("accounts[I]","accounts[wrongAccount]"),
    patched.replace("/*codexDotsPersonalization*/",""),
    patched.replace("!1/*codexDotsPersonalization*/","!0/*codexDotsPersonalization*/"),
    "!1/*codexDotsPersonalization*/;!1/*codexDotsPersonalization*/;"]) {
    const result=captureWarnings(()=>applyDotsPersonalizationPatch(input));
    assert.equal(result.value,input);assert.equal(result.warnings.length,1);
  }
  const repeated=captureWarnings(()=>applyDotsPersonalizationPatch(patched));
  assert.equal(repeated.value,patched);assert.deepEqual(repeated.warnings,[]);
});

test("Personalization production selection retains needles and rejects broken auth/account/marker state",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dots-personalization-rspack-"));
  try{
    const assets=path.join(root,"webview/assets/async");fs.mkdirSync(assets,{recursive:true});
    const file=path.join(assets,"860646.current.js"),original=FIXTURES["async/860646.06b6da0005.js"],descriptor=descriptors[2];
    const run=()=>{const report=createPatchReport();captureWarnings(()=>applyWebviewAssetPatchDescriptors(root,normalizePatchDescriptors([descriptor]),{},report));return report.patches[0];};
    fs.writeFileSync(file,original);
    assert.ok(descriptor.assetNeedles.every(needle=>original.includes(needle)));
    assert.equal(run().status,"applied");
    const patched=fs.readFileSync(file,"utf8");assert.ok(descriptor.assetNeedles.every(needle=>patched.includes(needle)));
    assert.equal(run().status,"already-applied");
    for(const damaged of [
      original.replace("accounts[I]","accounts[wrongAccount]"),
      original.replace('"chatgpt"!==S','"api-key"!==S'),
      patched.replace("!1/*codexDotsPersonalization*/","!0/*codexDotsPersonalization*/"),
    ]){
      assert.notEqual(damaged,original);assert.notEqual(damaged,patched);
      fs.writeFileSync(file,damaged);assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),damaged);
    }
    fs.writeFileSync(file,patched);const duplicate=path.join(assets,"duplicate.current.js");fs.writeFileSync(duplicate,patched);
    assert.equal(run().status,"skipped-optional");assert.equal(fs.readFileSync(file,"utf8"),patched);assert.equal(fs.readFileSync(duplicate,"utf8"),patched);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("current signed Personalization gates have one async owner and repeatable production results", {skip:!signedApp}, () => {
  const descriptor=descriptors[2],assets=path.join(signedApp,"webview/assets");
  const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js");
  const owners=findWebviewAssetsContaining(signedApp,descriptor.assetNeedles)
    .map(assetName=>({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")}))
    .filter(({source})=>descriptor.assetMatch(source));
  assert.equal(owners.length,1);
  const [owner]=owners;
  assert.ok(owner.assetName.startsWith("async/"));
  const fixture=PERSONALIZATION_FUNCTIONS,second=fixture.indexOf("function Z(");
  assert.ok(owner.source.includes(fixture.slice(0,second)));
  assert.ok(owner.source.includes(fixture.slice(second)));
  const extracted=fs.mkdtempSync(path.join(os.tmpdir(),"dots-personalization-signed-"));
  try {
    const target=path.join(extracted,"webview/assets",owner.assetName);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,owner.source);
    for (const expected of ["applied","already-applied"]) {
      const report=createPatchReport();
      applyWebviewAssetPatchDescriptors(extracted,normalizePatchDescriptors([descriptor]),{},report);
      assert.equal(report.patches[0].status,expected);
      assert.equal(report.patches[0].assetName,owner.assetName);
    }
    assert.equal(fs.readFileSync(path.join(assets,owner.assetName),"utf8"),owner.source);
  } finally {fs.rmSync(extracted,{recursive:true,force:true});}
});

test("ambiguous contracts fail closed", () => {
  const source = "a?.tbo_config?.tbo_available==null;b?.tbo_config?.tbo_available==null";
  assert.equal(applyDotsLandingRoutePatch(source), source);
});

test("each descriptor patches its current rspack chunk contract", () => {
  const extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-dots-any-country-assets-"));
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(path.join(assetsDir, "async"), { recursive: true });
  try {
    for (const [name, source] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(assetsDir, name), source);
    const report = createPatchReport();
    applyWebviewAssetPatchDescriptors(extractedDir, normalizePatchDescriptors(descriptors), {}, report);
    assert.deepEqual(report.patches.map(({ status }) => status), ["applied", "applied", "applied"]);
    assert.deepEqual(report.patches.map(({ assetName }) => assetName), Object.keys(FIXTURES));
    for (const name of Object.keys(FIXTURES)) {
      assert.equal(descriptors[Object.keys(FIXTURES).indexOf(name)].assetMatch(
        fs.readFileSync(path.join(assetsDir, name), "utf8")), true);
    }
    const repeated=createPatchReport();
    applyWebviewAssetPatchDescriptors(extractedDir,normalizePatchDescriptors(descriptors),{},repeated);
    assert.deepEqual(repeated.patches.map(({status})=>status),["already-applied","already-applied","already-applied"]);
  } finally {
    fs.rmSync(extractedDir, { recursive: true, force: true });
  }
});

test("the signed official webview has one pristine chunk per Dots contract", { skip: signedApp == null }, () => {
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  for (const descriptor of descriptors) {
    const matches = findWebviewAssetsContaining(signedApp, descriptor.assetNeedles).filter((name) =>
      descriptor.assetMatch(fs.readFileSync(path.join(signedApp, "webview", "assets", name), "utf8")));
    assert.equal(matches.length, 1, descriptor.id);
  }
});

test("signed landing owner patches through the production descriptor twice without changing inputs", {skip:!signedApp}, () => {
  const {findWebviewAssetsContaining}=require("../../scripts/patches/lib/assets.js");
  const descriptor=descriptors[0],assets=path.join(signedApp,"webview/assets");
  const owners=findWebviewAssetsContaining(signedApp,descriptor.assetNeedles)
    .map(assetName=>({assetName,source:fs.readFileSync(path.join(assets,assetName),"utf8")}))
    .filter(({source})=>descriptor.assetMatch(source));
  assert.equal(owners.length,1);const[owner]=owners;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"dots-landing-signed-"));
  try{
    const target=path.join(root,"webview/assets",owner.assetName);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,owner.source);
    for(const expected of ["applied","already-applied"]){
      const report=createPatchReport();applyWebviewAssetPatchDescriptors(root,normalizePatchDescriptors([descriptor]),{},report);
      assert.equal(report.patches[0].status,expected);assert.equal(report.patches[0].assetName,owner.assetName);
    }
    assert.equal(fs.readFileSync(path.join(assets,owner.assetName),"utf8"),owner.source);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
