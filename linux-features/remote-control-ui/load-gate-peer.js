"use strict";
// Exact UP81 contribution protocol. This feature-local reader intentionally
// does not import the other optional feature directory.
const {findRspackExportPublication}=require("../../scripts/patches/lib/rspack-export-publication.js");
const {findRspackRequireBinding}=require("../../scripts/patches/lib/rspack-module-assets.js");
const ID="[A-Za-z_$][\\w$]*";
const MARKER="codexLinuxRemoteControlLoadGateEnabled";
const FRESH="codexLinuxRemoteControlNativeLoadGateResult";
const LINUX="typeof navigator!==`undefined`&&navigator.userAgent.includes(`Linux`)";
const CALL=`\\(0,[ \\t]*(?<namespace>${ID})\\.Zj\\)[ \\t]*\\(\"1042620455\"\\)`;
function fail(reason){throw Error("Remote load gate peer: "+reason)}
function publication(copy){
 const value=findRspackExportPublication(copy,"mC");
 if(!value?.fn||value.fn.name!==null||value.fn.params!=="")fail("mC is not the unique inline parameterless publication");
 const open=copy.moduleSource.indexOf("{",value.fn.start),end=value.fn.end-1;
 if(open<value.fn.start||copy.moduleSource[end]!=="}"||copy.moduleSource.slice(open+1,end)!==value.fn.body)fail("stale mC body bounds");
 return {...value,start:open+1,end};
}
function freshName(nativeModule){let name=FRESH;while(nativeModule.includes(name))name+="$";return name}
function render(nativeModule,record){
 const name=freshName(nativeModule);
 return `${record.leading}const ${name}=${record.gap}${record.call};return ${LINUX}?true:${name}${record.trailing}/*${MARKER}*/`;
}
function nativeRecord(copy){
 if(copy.params.includes("navigator"))fail("factory parameter captures platform lookup");
 const pub=publication(copy),match=new RegExp(`^(?<leading>[ \\t]*)return(?<gap>[ \\t]*)(?<call>${CALL})(?<trailing>[ \\t]*)$`,"u").exec(pub.fn.body);
 if(!match)fail("mC does not retain the native hook call");
 const binding=findRspackRequireBinding(copy,match.groups.namespace);
 if(!binding)fail("native hook namespace is not a stable factory import");
 return {...match.groups,pub,binding};
}
function projectLoadGatePeer(copy){
 const source=copy.moduleSource;
 if(!source.includes(MARKER))return {moduleSource:source,active:false};
 if(source.split(MARKER).length!==2)fail("orphan or duplicate contribution marker");
 if(copy.params.includes("navigator"))fail("factory parameter captures platform lookup");
 const pub=publication(copy),pattern=new RegExp(`^(?<leading>[ \\t]*)const (?<local>${ID})=(?<gap>[ \\t]*)(?<call>${CALL});return ${LINUX.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}\\?true:\\k<local>(?<trailing>[ \\t]*)/\\*${MARKER}\\*/$`,"u");
 const found=pattern.exec(pub.fn.body);if(!found)fail("noncanonical contribution body");
 const record=found.groups,nativeBody=`${record.leading}return${record.gap}${record.call}${record.trailing}`;
 const native=source.slice(0,pub.start)+nativeBody+source.slice(pub.end);
 const qualified=nativeRecord({...copy,moduleSource:native});
 if(record.local!==freshName(native)||pub.fn.body!==render(native,qualified))fail("contribution is not exact native replay");
 return {moduleSource:native,active:true};
}
module.exports={projectLoadGatePeer,MARKER};
