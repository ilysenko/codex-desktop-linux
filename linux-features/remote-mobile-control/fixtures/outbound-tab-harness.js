"use strict";
const fs = require("node:fs"), path = require("node:path");
const copy = require("./current-remote-copy.json"), visibility = require("./current-remote-visibility.json");
// Independent snapshot of the current signed native pairing provider.
const pairing = {
  "moduleId": "mUEW",
  "params": [
    "e",
    "t",
    "n"
  ],
  "moduleSource": "var r=n(\"S2r0\"),i=n(\"zTeN\"),a=n(\"Dgwo\"),s=n(\"fO4j\"),o=n(\"ihPm\"),l=n(\"IUCH\"),u=n(\"OWtl\"),d=n(\"kfGJ\"),c=n(\"OMIV\"),p=n(\"rvFo\");let h=[\"codex-mobile-mfa-setup-required\"],_=\"2055603567\",m=\"3936985709\",f=[\"remote-control-server-pairing\"],g=(0,i.RD)(u.u,()=>({queryKey:[\"remote-control-mfa-requirement\"],queryFn:s.L7,retry:!1,staleTime:3e4})),E=(0,i.RD)(u.u,({get:e})=>({enabled:\"required\"===e(g).data,queryKey:[\"remote-control-mfa-enabled\"],queryFn:s.VC,refetchOnWindowFocus:\"always\",staleTime:0}));async function v(e){let t=e.query.snapshot(g);if(await t.invalidate({exact:!0,refetchType:\"none\"}),await t.fetch()!==\"required\")return!1;let n=e.query.snapshot(E);return await n.invalidate({exact:!0,refetchType:\"none\"}),!await n.fetch()}let y=(0,i.RD)(u.u,({get:e,scope:t})=>{let n=e(c.JW,\"2055603567\"),r=e(o.AP,d.fI)?.environmentId??null;return{enabled:e(o.Zg,d.fI)&&(!n||null!=r),queryKey:[\"codex-mobile-setup-resume-client\",n,r],queryFn:async()=>n?null!=r&&(await (0,l.yB)(t,d.fI,r)).length>0:(0,s.W$)(),staleTime:0}}),I=(0,i.vU)(u.u,({hostId:e,openId:t},{get:n,scope:r})=>({enabled:n(c.JW,_)&&!n(c.JW,m)&&n(o.Zg,e),queryKey:[...f,e,t],queryFn:async()=>(await (0,o.Hf)(r,e),(0,a.V)(r,e).sendRequest(\"remoteControl/pairing/start\",{manualCode:!0})),retry:!1,gcTime:0,staleTime:e=>{let t=e.state.data?.expiresAt;return null==t?0:Math.max(0,T(t)-e.state.dataUpdatedAt)},refetchInterval:e=>{let t=e.state.data?.expiresAt;return null!=t&&\"fetching\"!==e.state.fetchStatus&&null==e.state.error&&Math.max(1,T(t)-Date.now()-6e4)}}),{key:({hostId:e,openId:t})=>`${e}:${t}`});function T(e){return 1e3*Number(e)}n.d(t,{},{BM:g,Km:m,L_:E,Qg:_,ZI:v,Zm:I,n6:y,sv:function(e){return(0,r.j)({queryKey:h,queryFn:()=>v(e),refetchOnMount:\"always\",refetchOnWindowFocus:\"always\",retry:!1,staleTime:p.D.INFINITE})}})",
  "origin": {
    "version": "26.1111.21308",
    "sourceAsset": "webview/assets/async/907538.ce3dfb2b2a.js"
  }
};
const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const roles = { owner: [copy.settings], gateHook: visibility.roles.gateHook, platform: [copy.platformHook], platformMap: [copy.platformMap],
  catalog: visibility.roles.catalog, pairing: [pairing], tabs: visibility.roles.visibility };
function sources() {
  return Object.fromEntries(Object.entries(roles).flatMap(([role, rows]) => rows.map((row, index) => [
    `async/outbound-${role}-${index}.js`, `export const __rspack_esm_ids=[${100 + index}];export const __webpack_modules__={${row.moduleId}(${row.params}){${row.moduleSource}}};`,
  ])));
}
function snapshots(input = sources()) {
  const copies = Object.entries(input).flatMap(([assetName, source]) => [...rspackModuleFactories(source, assetName)]);
  return Object.fromEntries(Object.entries(roles).map(([role, rows]) => [role, copies.filter(copy => copy.moduleId === rows[0].moduleId)]));
}
function transition(input, plan, key = "patchedSource") { return { ...input, ...Object.fromEntries(plan.edits.map(row => [row.assetName, row[key]])) }; }
function writeApp(root, input = sources()) {
  const assets = path.join(root, "webview/assets");
  for (const [name, text] of Object.entries(input)) { const file = path.join(assets, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, text, { mode: 0o640 }); }
  return assets;
}
function readApp(root, input = sources()) { return Object.fromEntries(Object.keys(input).map(name => [name, fs.readFileSync(path.join(root, "webview/assets", name), "utf8")])); }
function withCopySources() {
  return { ...require("./remote-copy-harness.js").sources(), ...Object.fromEntries(Object.entries(sources()).filter(([name]) => !name.includes("outbound-owner-"))) };
}
module.exports = { roles, sources, snapshots, transition, writeApp, readApp, withCopySources };
