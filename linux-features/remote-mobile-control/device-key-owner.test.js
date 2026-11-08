"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),test=require("node:test");
const {prepareDeviceKeySource,applyDeviceKeyToExtractedApp}=require("./device-key-owner.js");
const h=require("./fixtures/device-key-harness.js");
const patch=require("./patch.js"),apply=patch.applyLinuxRemoteControlDeviceKeyPatch;
const runtime=h.minimalRuntime;
function reject(source,label){assert.throws(()=>prepareDeviceKeySource(source,runtime),/Unsupported current Remote device-key contract/,label);}
function app(files){const root=fs.mkdtempSync(path.join(os.tmpdir(),"up80-main-cohort-")),build=path.join(root,".vite/build");fs.mkdirSync(build,{recursive:true});for(const[name,source]of Object.entries(files))fs.writeFileSync(path.join(build,name),source,{mode:0o640});return{root,build,clean(){fs.rmSync(root,{recursive:true,force:true})}};}
test("device-key prepare qualifies the connected current classes and replays exact native inverse",()=>{
 const source=h.fixture(),first=prepareDeviceKeySource(source,runtime),repeat=prepareDeviceKeySource(first.patchedSource,runtime);
 assert.equal(first.state,"current");assert.equal(repeat.state,"patched");assert.equal(repeat.nativeSource,source);assert.equal(repeat.patchedSource,first.patchedSource);assert.equal(first.proof.factoryId,"26307");assert.equal(first.proof.provider,"edD");assert.equal(first.proof.schema,"edP");assert(first.patchedSource.includes(h.native.pair));assert(first.patchedSource.includes(h.native.nonce));assert(first.patchedSource.includes(h.native.digest));assert(first.patchedSource.includes(`new edD(${h.native.constructionArgs}),this.executionHostRegistry`));
});
test("device-key prepare follows semantic names and canonical scientific factory identities",()=>{
 const source=h.fixture({rename:{edM:"SigningBase",edD:"RemoteSigner",edP:"AddonSchema",edN:"loadAddon",edY:"nonceOk",edG:"digestOk",ed_:"nonceGrammar",eM:"Schema",eD:"NodeModule",$:"NativePath"}}).replace("26307(e,t,r)","9e4(e,t,r)");const first=prepareDeviceKeySource(source,runtime);assert.equal(first.proof.factoryId,"90000");assert.equal(first.proof.provider,"RemoteSigner");assert.equal(first.proof.schema,"AddonSchema");assert.equal(prepareDeviceKeySource(first.patchedSource,runtime).nativeSource,source);
});
test("device-key prepare rejects comment-only, unused-owner and captured-provider counterexamples",()=>{
 const source=h.fixture(),body=h.native.pair,construction=h.native.construction;
 reject(`exports.ids=[920],exports.modules={26307(e,t,r){/*;${body};function Unused(){${construction}={}};*/}};`,"comment-only");
 reject(source.replace(construction,"this.remoteControlDeviceKeyClient=null,this.executionHostRegistry")+`function Unused(){${construction}={}}`,"unused owner");
 for(const role of ["edD","edP"])reject(source.replace("class Host{constructor(e)",`class Host{constructor(e,${role})`),role);
 const dead=source.replace(construction+"={},","").replace("this.seen=[]}",`this.seen=[];return;${construction}={}}`);reject(dead,"construction after root return");
});
test("device-key runtime refuses a factory parameter that captures its String builtin",()=>{
 const source=h.fixture();assert.doesNotThrow(()=>prepareDeviceKeySource(source,runtime));
 const capture=source.replace("26307(e,t,r)","26307(String,t,r)").replace("e.exports=t;","String.exports=t;");reject(capture,"String module parameter");
});
test("device-key prepare rejects drifted schema, serializer and validator relationships",()=>{
 const source=h.fixture();for(const[from,to]of[
  ['edP.parse(edN','edX.parse(edN'],['"hardware_tpm"','"other_protection"'],['eM.promise(edX)','eM.promise(edZ)'],['"codex-device-key-sign-payload/v1"','"other-sign-domain"'],['signedPayloadBase64:n.toString("base64")','signedPayloadBase64:t.toString("base64")'],['.length<32','.length<16'],['32!==Buffer.from','16!==Buffer.from'],['signBytes(e,t){return this.getAddon().signDeviceKey(e,t)}','signBytes(e,t){return alternateSign(e,t)}'],
 ]){const changed=source.replace(from,to);assert.notEqual(changed,source,from);reject(changed,from);}
});
test("device-key binding proofs retain eager authority and reject constructor writes",()=>{
 const source=h.fixture(),at=source.indexOf("class RequestWrapper");
 for(const statement of ['edP=foreign;','edD>>>=1;','\\u0065dD=foreign;','++/*role*/edD;','++//role\u2028edD;'])reject(source.slice(0,at)+statement+source.slice(at),statement);
 reject(source.replace('this.options=e,','edP=foreign;this.options=e,'),"constructor schema write");
 for(const statement of ['function later(edP){edP=foreign}','const unrelated={edP:1};unrelated.edP=2;','{let edD=foreign;edD++;}','let other=0;other++;\nedD;']){
  const changed=source.slice(0,at)+statement+source.slice(at);assert.doesNotThrow(()=>prepareDeviceKeySource(changed,runtime),statement);
 }
});
test("device-key canonical decoder refuses partial, orphan and modified own artifacts",()=>{
 const source=h.fixture(),first=prepareDeviceKeySource(source,runtime).patchedSource;
 for(const changed of[first.replace(runtime,""),first.replace('codexLinuxRemoteControlDeviceKeyClient(edD,edP)','codexLinuxRemoteControlDeviceKeyClient(edD,edX)'),first+`;const extra="codexLinuxRemoteControlDeviceKeyAddon";`,first.replace('r=t.parse(codexLinuxRemoteControlDeviceKeyAddon())','r=codexLinuxRemoteControlDeviceKeyAddon()')])reject(changed,"own artifact");
});
test("device-key descriptor prepares one whole main cohort and repeat without writes",()=>{
 const source=h.fixture(),scene=app({"early-bootstrap-920-deadbeef.js":source,"early-bootstrap-133-feedface.js":'exports.ids=[133],exports.modules={42(e){e.exports=true}};'});
 try{const first=applyDeviceKeyToExtractedApp(scene.root,runtime);assert.equal(first.changed,1);const file=path.join(scene.build,"early-bootstrap-920-deadbeef.js"),after=fs.readFileSync(file,"utf8");assert.equal(fs.statSync(file).mode&0o777,0o640);assert.equal(applyDeviceKeyToExtractedApp(scene.root,runtime).changed,0);assert.equal(fs.readFileSync(file,"utf8"),after);}finally{scene.clean()}
});
test("device-key whole cohort refuses damaged same-ID, ambiguous and orphan physical carriers before writes",()=>{
 const source=h.fixture();for(const extra of['exports.ids=[133],exports.modules={26307(e,t,r){const damaged=true}};',source,'exports.ids=[133],exports.modules={1(){return "codexLinuxRemoteControlDeviceKeyAddon"}};']){
  const scene=app({"early-bootstrap-920-deadbeef.js":source,"early-bootstrap-133-feedface.js":extra});try{assert.throws(()=>applyDeviceKeyToExtractedApp(scene.root,runtime),/Unsupported current Remote device-key contract/);assert.equal(fs.readFileSync(path.join(scene.build,"early-bootstrap-920-deadbeef.js"),"utf8"),source);assert.equal(fs.statSync(path.join(scene.build,"early-bootstrap-920-deadbeef.js")).mode&0o777,0o640);}finally{scene.clean()}
 }
});
test("device-key transaction restores a partial write and original mode",()=>{
 const source=h.fixture(),scene=app({"early-bootstrap-920-deadbeef.js":source});let writes=0;try{assert.throws(()=>applyDeviceKeyToExtractedApp(scene.root,runtime,{writeFileSync(file,data,...rest){writes++;if(writes===1){fs.writeFileSync(file,String(data).slice(0,31));throw Error("controlled partial write")}return fs.writeFileSync(file,data,...rest)}}),/controlled partial write/);assert.equal(fs.readFileSync(path.join(scene.build,"early-bootstrap-920-deadbeef.js"),"utf8"),source);assert.equal(fs.statSync(path.join(scene.build,"early-bootstrap-920-deadbeef.js")).mode&0o777,0o640);}finally{scene.clean()}
});
test("Linux device-key client delegates addon interface acceptance to the captured native schema",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"up80-schema-delegate-")),source=apply(h.fixture());try{
  const observer={};const client=h.client(source,root,{electron:{}},{},observer);assert.equal(observer.calls,1);await assert.rejects(()=>client.createDeviceKey("not-a-native-protection-class"),/controlled native schema/);assert.equal(fs.existsSync(path.join(root,"codex-desktop")),false);
  const rejected={reject:true};assert.throws(()=>h.client(source,root,{}, {},rejected),/controlled native addon schema refused/);assert.equal(rejected.calls,1);
  const malformed={transform:addon=>({...addon,signDeviceKey:42})};assert.throws(()=>h.client(source,root,{}, {},malformed),/controlled native addon method is missing/);
  const badResult={transform:addon=>({...addon,createDeviceKey:async()=>({keyId:"x",publicKeySpkiDerBase64:"x",algorithm:"wrong",protectionClass:"os_protected_nonextractable"})})};const invalid=h.client(source,root,{}, {},badResult);await assert.rejects(()=>invalid.createDeviceKey("allow_os_protected_nonextractable"),/controlled native schema/);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
test("device-key Linux addon schema integration preserves the non-Linux native construction",async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"up80-native-platform-"));try{const observer={platform:"darwin"},client=h.client(apply(h.fixture()),root,{}, {},observer);assert.equal(observer.calls??0,0);const result=await client.createDeviceKey("hardware_only");assert.equal(result.keyId,"native-key");assert.equal(result.protectionClass,"hardware_secure_enclave");assert.equal(observer.calls,1);assert.equal(fs.existsSync(path.join(root,"codex-desktop")),false);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test("actual signed current device-key source prepares and canonicalizes with exact native inverse",{skip:!process.env.CODEX_SIGNED_EXTRACTED_APP},()=>{
 const directory=path.join(process.env.CODEX_SIGNED_EXTRACTED_APP,".vite/build"),rows=fs.readdirSync(directory).filter(n=>/^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/u.test(n)).map(name=>({name,source:fs.readFileSync(path.join(directory,name),"utf8")})).filter(row=>row.source.includes("remote-control-device-key.node"));assert.equal(rows.length,1);const source=rows[0].source,first=apply(source),repeat=apply(first);assert.notEqual(first,source);assert.equal(repeat,first);const begin=source.indexOf("class edM{"),helperEnd=first.indexOf("class edM{"),helper=first.slice(begin,helperEnd),prepared=prepareDeviceKeySource(first,helper);assert.equal(prepared.nativeSource,source);assert.equal(prepared.patchedSource,first);assert(first.includes(h.native.pair));assert(first.includes(h.native.nonce));assert(first.includes(h.native.digest));
});
