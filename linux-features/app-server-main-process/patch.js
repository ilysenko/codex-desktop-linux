"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const ID = String.raw`[A-Za-z_$][\w$]*`;
const MAIN = new RegExp(
  String.raw`function\((?<kind>${ID})\)\{let\{entry:(?<entry>${ID}),serviceName:(?<service>${ID})\}=(?<map>${ID})\[\k<kind>\];return (?<electron>${ID})\.utilityProcess\.fork\(\(0,(?<path>${ID})\.join\)\(__dirname,\k<entry>\),\[\],\{serviceName:\k<service>\}\)\}`,
  "g",
);
const MAIN_RESOURCE = 'require(require("node:path").join(process.resourcesPath,"..",".codex-linux","features","app-server-main-process","bridge-main.js"))';
const UTILITY_RESOURCE = 'require(require("node:path").join(process.resourcesPath,"..",".codex-linux","features","app-server-main-process","bridge-utility.js"))';
const HOST_MARKER = "codexLinuxLocalAppServer";

function patchMain(source) {
  const matches = [...source.matchAll(MAIN)];
  if (matches.length !== 1 || !source.includes('"App server utility started"')) return null;
  const { kind, electron } = matches[0].groups;
  const original = matches[0][0];
  const callStart = original.indexOf("return ") + "return ".length;
  const forkCall = original.slice(callStart, -1);
  const wrapped = original.slice(0, callStart) +
    `((worker)=>(${kind}===\"app-server-host\"&&${MAIN_RESOURCE}.attach(worker,${electron}),worker))(${forkCall})}`;
  return source.replace(original, wrapped);
}

function patchHost(source) {
  const anchors = [
    'process.parentPort.on("message",e=>{',
    "this.spawnProcess()",
    "spawnProcess(){",
    'i=(0,n.spawn)(t,r,{stdio:["pipe","pipe","pipe"],env:this.options.env,cwd:this.options.cwd})',
    "new G({...t,args:[...t.args,...n??[]]},this.ioStatsTracker)",
    ";if(!i.pid)throw Error(`Failed to spawn Codex CLI",
  ];
  if (anchors.some((anchor) => source.split(anchor).length !== 2)) return null;
  let result = source;
  result = result.replace(anchors[0], `${anchors[0]}if(e.data?.type===\"codex-linux-app-server-bridge\"){${UTILITY_RESOURCE}.accept(e);return}`);
  result = result.replace(anchors[1], 'this.spawnProcess().catch(e=>{if(this.readyState!==I.vj.Closed){this.onProcessError(e),this.readyState=I.vj.Closed,this.emitClose({type:"close",code:null,reason:e.message,signal:null})}})');
  result = result.replace(anchors[2], "async spawnProcess(){");
  result = result.replace(anchors[3], `i=this.options.${HOST_MARKER}?await ${UTILITY_RESOURCE}.spawn(t,r,{env:this.options.env,cwd:this.options.cwd}):(0,n.spawn)(t,r,{stdio:["pipe","pipe","pipe"],env:this.options.env,cwd:this.options.cwd})`);
  result = result.replace(anchors[5], ";if(this.readyState!==I.vj.Connecting){i.kill();return}if(!i.pid)throw Error(`Failed to spawn Codex CLI");
  result = result.replace(anchors[4], `new G({...t,${HOST_MARKER}:this.options.hostConfig.kind===\"local\"&&this.options.hostConfig.id===\"local\"&&null==t.spawnCommand&&null==this.options.startupCommand,args:[...t.args,...n??[]]},this.ioStatsTracker)`);
  return result;
}

function patchExtractedApp(dir) {
  const main = findMainProcessChunks(dir);
  if (!main) return { matched: false, changed: false, reason: "Main-process chunks missing" };
  const files = main.chunks.map((name) => path.join(main.buildDir, name));
  const sources = files.map((file) => fs.readFileSync(file, "utf8"));
  const hostFile = path.join(main.buildDir, "app-server-host.js");
  if (!fs.existsSync(hostFile)) return { matched: false, changed: false, reason: "App-server utility bundle missing" };
  const host = fs.readFileSync(hostFile, "utf8");
  const alreadyMain = sources.filter((s) => s.includes("bridge-main.js"));
  const completeHost = [
    'if(e.data?.type==="codex-linux-app-server-bridge")',
    'this.spawnProcess().catch(e=>',
    'async spawnProcess(){',
    `this.options.${HOST_MARKER}?await `,
    'if(this.readyState!==I.vj.Connecting){i.kill();return}',
    `${HOST_MARKER}:this.options.hostConfig.kind==="local"`,
  ].every((anchor) => host.split(anchor).length === 2);
  if (alreadyMain.length === 1 && completeHost && host.split("bridge-utility.js").length === 3) return { matched: true, changed: false };
  if (alreadyMain.length || host.includes(HOST_MARKER) || host.includes("bridge-utility.js")) return { matched: false, changed: false, reason: "Incomplete bridge patch" };
  const candidates = sources.map(patchMain).map((value, i) => ({ value, i })).filter(({ value }) => value != null);
  const patchedHost = patchHost(host);
  if (candidates.length !== 1 || patchedHost == null) return { matched: false, changed: false, reason: "App-server launch contract changed" };
  fs.writeFileSync(files[candidates[0].i], candidates[0].value);
  fs.writeFileSync(hostFile, patchedHost);
  return { matched: true, changed: true };
}

const descriptors = [{ id: "main-process-app-server-bridge", phase: "extracted-app:pre-webview", ciPolicy: "optional", apply: patchExtractedApp,
  status: (result) => !result?.matched ? "skipped-optional" : result.changed ? "applied" : "already-applied" }];
module.exports = { patchExtractedApp, patchMain, patchHost, descriptors };
