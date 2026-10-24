// Hand-authored native metadata factory and its assignment/exposure contract.
const cp=require("node:child_process"),fs=require("node:fs"),os=require("node:os"),path=require("node:path");
function makeNativeApplications(){if(process.platform===`darwin`||process.platform===`win32`)return{getByBundleId:async id=>await cachedApp(id)??await catalog.findById(id),list:catalog.list,getIcon:async({appPath:file,size:size})=>size===`medium`?{iconSmall:null,iconMedium:await mediumIcon(file)}:{iconSmall:await smallIcon(file)}}}
class TestHandler{nativeApplications=makeNativeApplications()}
function expose(){return{nativeApplications:this.fetchHandler.nativeApplications}}
