"use strict";
const fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const native=require("./current-device-key.json");
const {graphBody}=require("../../../scripts/patches/lib/fixtures/main-request-graph.js");
const {createJavaScriptLexicalIndex}=require("../../../scripts/patches/lib/minified-js.js");
function fixture(options={}){
  const declaration=native.imports+'let er={app:{isPackaged:true}};'+native.schema+native.pair+native.nonce+native.digest;
  const construction=options.args==null?native.construction:native.construction.replace(native.constructionArgs,options.args);
  let body=graphBody().replace('this.scopedState=e.globalState,this.fetchWrapper=',`this.scopedState=e.globalState,${construction}={},this.fetchWrapper=`)
    .replace('require.d(exports,','r.d(t,').replace('module.exports=exports;','e.exports=t;');
  body=declaration+body;
  let source=`exports.ids=[920],exports.modules={26307(e,t,r){${body}}};`;
  for(const[from,to]of Object.entries(options.rename??{})){
    const lexical=createJavaScriptLexicalIndex(source),pattern=new RegExp(`(?<![\\w$])${from.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?![\\w$])`,"gu");
    const replacements=[...source.matchAll(pattern)].filter(row=>lexical.isCode(row.index));
    for(const row of replacements.reverse())source=source.slice(0,row.index)+to+source.slice(row.index+row[0].length);
  }
  return source;
}
function schemas(observer={}){
  const type=check=>({parse(value){if(!check(value))throw Error("controlled native schema rejected shape");return value}});
  const api={string:()=>{const x=type(v=>typeof v==="string");x.min=min=>type(v=>typeof v==="string"&&v.length>=min);return x},literal:wanted=>type(v=>v===wanted),enum:values=>type(v=>values.includes(v)),void:()=>type(v=>v===undefined),instanceof:ctor=>type(v=>v instanceof ctor),promise:inner=>({async parse(value){return inner.parse(await value)}}),function:({input,output})=>({parse(value){if(typeof value!=="function")throw Error("controlled native addon method is missing");return async function(...args){if(args.length!==input.length)throw Error("controlled native input arity");const values=args.map((value,index)=>input[index].parse(value));return output.parse(await Reflect.apply(value,this,values))}}}),object:shape=>({parse(value){if(value==null||typeof value!=="object")throw Error("controlled native schema object");if(Object.hasOwn(shape,"createDeviceKey")){observer.calls=(observer.calls??0)+1;if(observer.reject)throw Error("controlled native addon schema refused");if(observer.transform)value=observer.transform(value)}const result={};for(const[key,schema]of Object.entries(shape))result[key]=schema.parse(value[key]);return result}})};
  return api;
}
function client(patched,configHome,overrides={},processEnv={},observer={}){
  const nativeAddon=observer.nativeAddon??{createDeviceKey:async()=>({keyId:"native-key",publicKeySpkiDerBase64:"native-public",algorithm:"ecdsa_p256_sha256",protectionClass:"hardware_secure_enclave"}),getDeviceKeyPublic:async()=>({keyId:"native-key",publicKeySpkiDerBase64:"native-public",algorithm:"ecdsa_p256_sha256",protectionClass:"hardware_secure_enclave"}),deleteDeviceKey:async()=>{},signDeviceKey:async()=>({algorithm:"ecdsa_p256_sha256",signatureDerBase64:"native-signature"})};
  const context={Buffer,clearTimeout,Date,Error,JSON,Promise,console,__filename:path.join(path.resolve(configHome),"fixture-main.js"),module:{exports:{}},exports:{},process:{env:{XDG_CONFIG_HOME:configHome,...processEnv},getuid:typeof process.getuid==="function"?process.getuid.bind(process):undefined,pid:process.pid,platform:observer.platform??"linux",resourcesPath:"/fixture-resources"},require:name=>overrides[name]??require(name),setTimeout};
  const ns=schemas(observer),loader=id=>{if(String(id)==="35553")return ns;if(String(id)==="55822")return{createRequire:()=>()=>nativeAddon};if(String(id)==="86697")return require("node:path");if(String(id)==="67726")return{b:({resourcesPath})=>resourcesPath};throw Error(`unexpected controlled fixture dependency ${id}`)};
  loader.d=(target,definitions)=>{for(const[key,get]of Object.entries(definitions))Object.defineProperty(target,key,{get,enumerable:true})};context.__loader=loader;
  vm.runInNewContext(patched+';exports.modules[26307](module,module.exports,__loader);',context);
  return context.module.exports.runMainAppStartup({globalState:{},chunkedMessageSender:{},cancelled:[],windowManager:{}}).remoteControlDeviceKeyClient;
}
const minimalRuntime="function codexLinuxRemoteControlDeviceKeyAddon(){return{}}function codexLinuxRemoteControlDeviceKeyClient(e,t){let n=new e(null),r=t.parse(codexLinuxRemoteControlDeviceKeyAddon());return n.getAddon=()=>r,n}";
module.exports={fixture,client,schemas,native,minimalRuntime};
