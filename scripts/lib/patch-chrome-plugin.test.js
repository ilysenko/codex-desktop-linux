#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const patcher = path.join(__dirname, "patch-chrome-plugin.js");

function writeScript(pluginDir, name, source) {
  const scriptsDir = path.join(pluginDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, name), source, "utf8");
}

function readScript(pluginDir, name) {
  return fs.readFileSync(path.join(pluginDir, "scripts", name), "utf8");
}

function currentBrowserClientFixture() {
  return (
    String.raw`import L7,{platform as XI}from"node:os";import{readFile as P7}from"fs/promises";import{resolve as D7}from"path";import{resolve as S7}from"path";import{homedir as v7,platform as E7}from"os";var Cd=S7(v7(),E7()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");import{ClassicLevel as C7}from"./node_modules/classic-level.mjs";import{resolve as bg}from"path";import{tmpdir as T7}from"os";import{cp as A7,mkdtemp as I7,rm as HI}from"fs/promises";import{existsSync as k7}from"fs";var VI=async(e,t)=>{let r=bg(Cd,e,"Local Extension Settings",t);if(!k7(r))return null;let n=await I7(bg(R7(),"codex"));await A7(r,n,{recursive:!0}),await HI(bg(n,"LOCK"));let o=new C7(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await HI(n,{force:!0,recursive:!0})}},R7=()=>T7();var GI=async e=>e,N7=async(e,t)=>(await O7(e)).find(o=>o.instanceId===t)||null,O7=async e=>{let t=await M7();return await Promise.all(t.map(async r=>({...r,instanceId:await VI(r.id,e).catch(n=>(le(n),null))})))},M7=async()=>{let e=D7(Cd,"Local State"),t=JSON.parse(await P7(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};var U7=5e3,_g=__(L7.platform()),j7=async(e,{codexSessionId:t})=>{let r=tl(p_),n=e.filter(i=>i.info.type==="iab"),o=q7(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},q7=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r)),ek=async()=>{};function tI({browserId:e,clientInfo:t,requestedBrowserId:r}){return ig(r)?og(t.type)===r:e===r}function ld(){}` +
    String.raw`async function mwe({globals:e}){let r=new Id,n=new Map(),l={browser_id:"extension"};if(ig(l.browser_id)){let _=li(l.browser_id);KI(_)}let p=await r.get(l.browser_id),f=n.get(p.api);return f}`
  );
}

function electron42BrowserClientFixture() {
  return (
    String.raw`import{readdir as hk}from"node:fs/promises";import iz,{platform as gk}from"node:os";import bk from"node:path";import{readFile as X7}from"fs/promises";import{resolve as Q7}from"path";import{resolve as z7}from"path";import{homedir as W7,platform as H7}from"os";var Rd=z7(W7(),H7()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");import{ClassicLevel as V7}from"./node_modules/classic-level.mjs";import{resolve as Eg}from"path";import{tmpdir as G7}from"os";import{cp as K7,mkdtemp as J7,rm as lk}from"fs/promises";import{existsSync as Y7}from"fs";var ck=async(e,t)=>{let r=Eg(Rd,e,"Local Extension Settings",t);if(!Y7(r))return null;let n=await J7(Eg(Z7(),"codex"));await K7(r,n,{recursive:!0}),await lk(Eg(n,"LOCK"));let o=new V7(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await lk(n,{force:!0,recursive:!0})}},Z7=()=>"nodeRepl"in globalThis&&globalThis.nodeRepl?globalThis.nodeRepl.tmpDir:G7();var dk=async e=>{if(e.type!=="extension"||!e.metadata?.extensionInstanceId||!e.metadata.extensionId)return e;let t=await ez(e.metadata.extensionId,e.metadata.extensionInstanceId);return t?{...e,metadata:{...e.metadata,profileName:t.name,profileIsLastUsed:t.isLastUsed.toString(),profileOrdering:t.orderingIndex.toString()}}:e},ez=async(e,t)=>(await tz(e)).find(o=>o.instanceId===t)||null,tz=async e=>{let t=await rz();return await Promise.all(t.map(async r=>({...r,instanceId:await ck(r.id,e).catch(n=>(le(n),null))})))},rz=async()=>{let e=Q7(Rd,"Local State"),t=JSON.parse(await X7(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};var sz=5e3,Tg=T_(iz.platform()),az=async(e,{codexSessionId:t})=>{let r=os(__),n=e.filter(i=>i.info.type==="iab"),o=uz(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},uz=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r)),yk=async()=>{};function pg(e){return e==="extension"||e==="iab"||e==="cdp"}function dg(e){return e}function _I({browserId:e,clientInfo:t,requestedBrowserId:r}){return pg(r)?dg(t.type)===r:e===r}function fd(e,t){return{capabilities:O_(t.capabilities),id:e,name:t.name,type:dg(t.type),metadata:t.metadata}}var Nd=class{browsers=null;async refresh(){}list(){return this.getBrowsers()}` +
    'async get(t){let r=(await this.getBrowsers()).find(n=>_I({browserId:n.id,clientInfo:n.info,requestedBrowserId:t}));if(r==null)throw new Error(`Browser is not available: ${t}`);return r}' +
    String.raw`async getBrowsers(){return this.browsers==null&&await this.refresh(),this.browsers??[]}};` +
    String.raw`function T_(){return"/tmp/codex-browser-use"}function os(){return null}function le(){}`
  );
}

test("patches Linux Chrome Beta and Unstable support into bundled Chrome plugin scripts", () => {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-plugin-"));
  try {
    writeScript(
      pluginDir,
      "installManifest.mjs",
      'const hostPlatforms={linux:[".config/google-chrome/NativeMessagingHosts"]};\n',
    );
    writeScript(
      pluginDir,
      "check-native-host-manifest.js",
      `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
function getNativeHostManifestDetails(expectedHostName) {
  if (process.platform === "linux") {
    return {
      manifestPath: path.join(
        os.homedir(),
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }
}
`,
    );
    writeScript(
      pluginDir,
      "browser-client.mjs",
      currentBrowserClientFixture(),
    );
    writeScript(
      pluginDir,
      "installed-browsers.js",
      `const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
];
`,
    );
    writeScript(
      pluginDir,
      "chrome-is-running.js",
      `const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  win32: new Set(["chrome.exe"]),
};
`,
    );
    writeScript(
      pluginDir,
      "check-extension-installed.js",
      `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}
function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
}
function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  return null;
}
`,
    );
    writeScript(
      pluginDir,
      "open-chrome-window.js",
      `const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
function runCommand() {
  return "";
}
function commandPath(command) {
  return command;
}
function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}
function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
}
function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {
  return null;
}
function openChromeWindow(chromeArgs) {
  return {
    command: "google-chrome",
    args: chromeArgs,
  };
}
`,
    );

    const result = spawnSync(process.execPath, [patcher, pluginDir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /browser-client\.mjs missing patch target/);

    const installManifest = readScript(pluginDir, "installManifest.mjs");
    assert.match(installManifest, /google-chrome-beta\/NativeMessagingHosts/);
    assert.match(installManifest, /google-chrome-unstable\/NativeMessagingHosts/);

    const nativeHostCheck = readScript(pluginDir, "check-native-host-manifest.js");
    assert.match(nativeHostCheck, /"google-chrome-beta",\n        "NativeMessagingHosts"/);
    assert.match(nativeHostCheck, /"google-chrome-unstable",\n        "NativeMessagingHosts"/);

    const browserClient = readScript(pluginDir, "browser-client.mjs");
    assert.match(browserClient, /"google-chrome-beta"/);
    assert.match(browserClient, /"google-chrome-unstable"/);
    assert.match(browserClient, /async\(e,t,r=Cd\)/);
    assert.match(browserClient, /r\.length===1\?r\[0\]:null/);
    assert.match(browserClient, /codexLinuxRankBrowserBackends/);
    assert.match(browserClient, /codexLinuxCloseDiscardedBrowserBackends/);
    assert.match(browserClient, /codexLinuxRejectAmbiguousBrowserAlias/);
    assert.match(browserClient, /await r\.getBrowsers\(\)/);

    const installedBrowsers = readScript(pluginDir, "installed-browsers.js");
    assert.match(installedBrowsers, /name: "Google Chrome Beta"/);
    assert.match(installedBrowsers, /commands: \["google-chrome-beta"\]/);
    assert.match(installedBrowsers, /name: "Google Chrome Unstable"/);
    assert.match(installedBrowsers, /commands: \["google-chrome-unstable"\]/);

    const runningCheck = readScript(pluginDir, "chrome-is-running.js");
    assert.match(runningCheck, /"google-chrome-beta"/);
    assert.match(runningCheck, /"google-chrome-unstable"/);

    const extensionCheck = readScript(pluginDir, "check-extension-installed.js");
    assert.match(extensionCheck, /linuxChromeBetaUserDataDirectory/);
    assert.match(extensionCheck, /"google-chrome-beta"/);
    assert.match(extensionCheck, /"google-chrome-unstable"/);

    const openWindow = readScript(pluginDir, "open-chrome-window.js");
    assert.match(openWindow, /google-chrome-beta\.desktop/);
    assert.match(openWindow, /commandPath\("google-chrome-beta"\)/);
    assert.match(openWindow, /commandPath\("google-chrome-unstable"\)/);
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});

test("patches current Electron 42 browser-client Chrome profile drift", () => {
  const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-plugin-current-"));
  try {
    writeScript(pluginDir, "browser-client.mjs", electron42BrowserClientFixture());

    const result = spawnSync(process.execPath, [patcher, pluginDir], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /browser-client\.mjs missing patch target/);

    const browserClient = readScript(pluginDir, "browser-client.mjs");
    assert.match(browserClient, /async\(e,t,r=Rd\)/);
    assert.match(browserClient, /r\.length===1\?r\[0\]:null/);
    assert.match(browserClient, /codexLinuxRankBrowserBackends/);
    assert.match(browserClient, /codexLinuxCloseDiscardedBrowserBackends/);
    assert.match(browserClient, /codexLinuxRejectAmbiguousBrowserAlias/);
    assert.match(browserClient, /__codexBrowsers=await this\.getBrowsers\(\)/);
  } finally {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
});
