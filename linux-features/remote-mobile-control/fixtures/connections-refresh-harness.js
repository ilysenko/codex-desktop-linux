"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const copy=require("./current-remote-copy.json"),visibility=require("./current-remote-visibility.json"),bridge=require("./current-enablement-bridge.json"),revoke=require("./current-revoke-setup-reset.json");
const {rspackModuleFactories}=require("../../../scripts/patches/lib/rspack-module-assets.js");
const roles={owner:[copy.settings],facade:bridge.facades,awaiter:revoke.providers.filter(row=>row.moduleId==="q77y"),...visibility.roles};
function sources(){return Object.fromEntries(Object.entries(roles).flatMap(([role,rows])=>rows.map((row,index)=>[`async/refresh-${role}-${index}.js`,`export const __rspack_esm_ids=[${index+200}];export const __webpack_modules__={${row.moduleId}(${row.params}){${row.moduleSource}}};`])))}
function snapshots(input=sources()){const all=Object.entries(input).flatMap(([name,text])=>[...rspackModuleFactories(text,name)]);return Object.fromEntries(Object.entries(roles).map(([role,rows])=>[role,all.filter(row=>row.moduleId===rows[0].moduleId)]))}
function transition(input,plan,key="patchedSource"){return{...input,...Object.fromEntries(plan.edits.map(row=>[row.assetName,row[key]]))}}
function writeApp(root,input=sources()){const assets=path.join(root,"webview/assets");for(const[name,text]of Object.entries(input)){const p=path.join(assets,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,text,{mode:0o640})}return assets}
function readApp(root,input=sources()){return Object.fromEntries(Object.keys(input).map(name=>[name,fs.readFileSync(path.join(root,"webview/assets",name),"utf8")]))}
const tick=()=>new Promise(setImmediate);
function runtime(effectSource,refresh){
 let now=10000,next=1;const intervals=new Map(),timeouts=new Map(),calls=[],controllers=[],events=[];
 const target=()=>({listeners:new Map(),addEventListener(name,fn){const set=this.listeners.get(name)??new Set();set.add(fn);this.listeners.set(name,set);events.push(["add",name])},removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);events.push(["remove",name])},fire(name){for(const fn of [...this.listeners.get(name)??[]])fn()}});
 const window={...target(),setInterval(fn,delay){const id=next++;intervals.set(id,{fn,delay});return id},clearInterval(id){intervals.delete(id)},setTimeout(fn,delay){const id=next++;timeouts.set(id,{fn,at:now+delay});return id},clearTimeout(id){timeouts.delete(id)}};
 const document={...target(),visibilityState:"visible"};class ControlledAbortController extends AbortController{constructor(){super();controllers.push(this)}}
 const effect=vm.runInNewContext("("+effectSource+")",{window,document,AbortController:ControlledAbortController,Date:{now:()=>now},oI:signal=>{calls.push(signal);return refresh(signal)}}),cleanup=effect();
 return{window,document,intervals,timeouts,calls,controllers,events,cleanup,async interval(){for(const{fn}of [...intervals.values()])fn();await tick();await tick()},async event(name){(name==="visibilitychange"?document:window).fire(name);await tick();await tick()},async advance(ms){now+=ms;for(const[id,row]of [...timeouts])if(row.at<=now){timeouts.delete(id);row.fn()}await tick();await tick()},async flush(){await tick();await tick()}};
}
module.exports={roles,sources,snapshots,transition,writeApp,readApp,runtime,tick};
