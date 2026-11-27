"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PatchIntegrityError } = require("../../scripts/patches/integrity-error.js");
const { readDirectoryNames } = require("../../scripts/patches/lib/assets.js");
const { readSocketPath } = require("./socket-path.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

function sharedTransportClassSource(webSocketTransport) {
  return (
    "class CodexLinuxSharedAppServerSocketTransport{" +
    "kind=`websocket`;proxyStreams=new Set;authority=null;authorityError=null;authorityReady=null;lockIdentity=null;ownerStartTime=null;socketIdentity=null;disposed=!1;" +
    "constructor(e,t){if(typeof t!==`function`)throw Error(`shared app-server socket requires a config override callback`);this.socketPath=e;this.lockPath=`${e}.lock`;this.getConfigOverrides=t}" +
    "supportsReconnect(){return!0}" +
    `readSocketPath(){return (${readSocketPath.toString()})(this.socketPath)}` +
    "sameIdentity(e,t){return e!=null&&t.dev===e.dev&&t.ino===e.ino}" +
    "processIdentity(e){let t=require(`node:fs`);try{let n=t.readFileSync(`/proc/${e}/stat`,`utf8`),r=n.lastIndexOf(`)`);if(r<0)return null;return n.slice(r+2).trim().split(/\\s+/)[19]??null}catch(e){return null}}" +
    "recordAuthorityIdentity(e){let t=require(`node:fs`),n=e?.pid,r=this.processIdentity(n);if(!Number.isInteger(n)||r==null||this.ownerStartTime==null)throw Error(`shared app-server socket could not identify its authority`);let o;try{o=t.openSync(this.lockPath,`r+`);let e=t.fstatSync(o),i=t.readFileSync(o,`utf8`);if(!this.sameIdentity(this.lockIdentity,e)||i!==`${process.pid} ${this.ownerStartTime}\\n`)throw Error(`shared app-server ownership changed before authority registration`);t.ftruncateSync(o,0),t.writeSync(o,`${process.pid} ${this.ownerStartTime} ${n} ${r}\\n`,0,`utf8`),t.fsyncSync(o)}finally{o!=null&&t.closeSync(o)}}" +
    "attachedCliRecord(r){let e=process.env.XDG_RUNTIME_DIR||process.env.CODEX_LINUX_APP_STATE_DIR,t=process.env.CODEX_LINUX_APP_ID||`codex-desktop`,n=process.execPath;if([e,t,n,r,this.socketPath].some(e=>typeof e!==`string`||e.length===0||/[\\0\\r\\n]/.test(e))||/[\\/]/.test(t))throw Error(`attached CLI discovery record contains an unsafe field`);let o=require(`node:path`).join(e,t,`app-server-bridge`),i=require(`node:path`).join(o,`attached-cli-v1`),a=[`version=1`,`app_id=${t}`,`socket=${this.socketPath}`,`desktop=${n}`,`codex=${r}`,``].join(`\\n`);return{bridgeDir:o,recordPath:i,contents:a}}" +
    "publishAttachedCliRecord(t,p){let e=require(`node:fs`),n,r=null,o=null,i=null,d=!1;try{n=this.attachedCliRecord(p);let a=t?.pid,s=this.processIdentity(a);if(!Number.isInteger(a)||s==null||this.ownerStartTime==null)throw Error(`shared app-server lock is not registered`);let c=e.lstatSync(this.lockPath),u=e.readFileSync(this.lockPath,`utf8`);if(!this.sameIdentity(this.lockIdentity,c)||u!==`${process.pid} ${this.ownerStartTime} ${a} ${s}\\n`)throw Error(`shared app-server lock is not registered`);e.mkdirSync(n.bridgeDir,{recursive:!0,mode:448});let l=e.lstatSync(n.bridgeDir);if(!l.isDirectory()||l.isSymbolicLink()||(l.mode&511)!==448||(typeof process.getuid==`function`&&l.uid!==process.getuid()))throw Error(`attached CLI discovery directory is unsafe`);o=require(`node:path`).join(n.bridgeDir,`.attached-cli-v1.${process.pid}.${Date.now()}`),r=e.openSync(o,`wx`,384),d=!0,i=e.fstatSync(r);if(!i.isFile()||(i.mode&511)!==384||(typeof process.getuid==`function`&&i.uid!==process.getuid()))throw Error(`attached CLI discovery temporary file is unsafe`);e.writeFileSync(r,n.contents,`utf8`),e.closeSync(r),r=null;let h=e.lstatSync(o);if(!this.sameIdentity(i,h)||!h.isFile()||h.isSymbolicLink()||(h.mode&511)!==384||(typeof process.getuid==`function`&&h.uid!==process.getuid()))throw Error(`attached CLI discovery temporary file changed`);e.renameSync(o,n.recordPath),o=null}catch(t){if(o!=null&&d)try{if(i==null){r!=null&&e.unlinkSync(o)}else{let t=e.lstatSync(o);this.sameIdentity(i,t)&&t.isFile()&&e.unlinkSync(o)}}catch(e){}if(r!=null)try{e.closeSync(r)}catch(e){}console.warn(`WARN: attached CLI discovery record was not published`)}}" +
    "socketPathIsLive(){return new Promise(e=>{let t=require(`node:net`).createConnection({path:this.socketPath}),n=!1,r=o=>{if(n)return;n=!0,clearTimeout(i),t.removeAllListeners(),t.destroy(),e(o)},i=setTimeout(()=>r(!0),500);i.unref?.(),t.once(`connect`,()=>r(!0)),t.once(`error`,e=>r(e?.code!==`ECONNREFUSED`&&e?.code!==`ENOENT`))})}" +
    "async reclaimStaleLock(){let e=require(`node:fs`),t;try{t=e.openSync(this.lockPath,`r`);let n=e.fstatSync(t),r=e.readFileSync(t,`utf8`).trim(),o=r.match(/^(\\d+) (\\S+)(?: \\d+ \\S+)?$/),i=!1;if(o){let t=Number(o[1]),n=this.processIdentity(t);i=n==null?!e.existsSync(`/proc/${t}`):n!==o[2]}else i=Date.now()-n.mtimeMs>15e3;if(!i)return!1;let a=null;try{a=this.readSocketPath().identity;if(await this.socketPathIsLive())return!1}catch(e){if(e?.code!==`ENOENT`)throw e}if(a)try{let t=e.lstatSync(this.socketPath);if(!this.sameIdentity(a,t))return!1;e.unlinkSync(this.socketPath)}catch(e){if(e?.code!==`ENOENT`)throw e}let s=e.lstatSync(this.lockPath);if(!this.sameIdentity(n,s))return!1;e.unlinkSync(this.lockPath);return!0}catch(e){if(e?.code===`ENOENT`)return!0;throw e}finally{t!=null&&e.closeSync(t)}}" +
    "releaseOwnedPaths(e=!1){let t=require(`node:fs`),n=[];if(this.socketIdentity)try{let e=t.lstatSync(this.socketPath);this.sameIdentity(this.socketIdentity,e)&&t.unlinkSync(this.socketPath),this.socketIdentity=null}catch(e){e?.code===`ENOENT`?this.socketIdentity=null:n.push(e)}if(this.lockIdentity)try{let e=t.lstatSync(this.lockPath);this.sameIdentity(this.lockIdentity,e)&&t.unlinkSync(this.lockPath),this.lockIdentity=null}catch(e){e?.code===`ENOENT`?this.lockIdentity=null:n.push(e)}if(n.length&&!e)throw n[0];n.length&&console.warn(`WARN: shared app-server socket cleanup failed: ${n[0].message}`)}" +
    "dispose(){this.disposed=!0;for(let e of this.proxyStreams)e.destroy();this.proxyStreams.clear();let e=this.authority;this.authority=null;if(e&&e.exitCode==null&&e.signalCode==null){let t=()=>this.releaseOwnedPaths(!0);e.once(`close`,t);try{e.kill()}catch(e){console.warn(`WARN: shared app-server authority stop failed: ${e.message}`)}}else this.releaseOwnedPaths(!0)}" +
    "async acquireOwnership(){let e=require(`node:fs`),t=require(`node:path`);e.mkdirSync(t.dirname(this.socketPath),{recursive:!0,mode:448});for(let t=0;t<2;t++){let n;try{n=e.openSync(this.lockPath,`wx`,384),this.lockIdentity=e.fstatSync(n);let t=this.processIdentity(process.pid);if(t==null)throw Error(`shared app-server socket could not identify its owner`);this.ownerStartTime=t,e.writeSync(n,`${process.pid} ${t}\\n`),e.fsyncSync(n)}catch(e){if(e?.code===`EEXIST`&&t===0&&await this.reclaimStaleLock())continue;if(e?.code===`EEXIST`)throw Error(`shared app-server socket is already owned: ${this.socketPath}`);this.releaseOwnedPaths(!0);throw e}finally{n!=null&&e.closeSync(n)}try{e.lstatSync(this.socketPath);throw Error(`shared app-server socket path already exists: ${this.socketPath}`)}catch(e){if(e?.code!==`ENOENT`){this.releaseOwnedPaths();throw e}}return}}" +
    "stopAuthority(e){return new Promise(t=>{if(!e||e.exitCode!=null||e.signalCode!=null)return t(!0);let n=!1,r=i=>{if(n)return;n=!0,clearTimeout(a),e.off(`close`,o),e.off(`exit`,o),e.off(`error`,s),t(i)},o=()=>r(!0),s=e=>{this.authorityError??=e},a=setTimeout(()=>r(!1),2e3);a.unref?.(),e.once(`close`,o),e.once(`exit`,o),e.on(`error`,s);try{e.kill()}catch(e){this.authorityError??=e,r(!1)}})}" +
    "async ensureAuthority(){if(this.disposed)throw Error(`shared app-server socket transport is disposed`);if(this.authorityReady)return this.authorityReady;if(this.authority&&this.authority.exitCode==null&&this.authority.signalCode==null){if(this.authorityError)throw this.authorityError;return}let e=this.startAuthority();this.authorityReady=e;try{return await e}finally{this.authorityReady===e&&(this.authorityReady=null)}}" +
    "async startAuthority(){let e=process.env.CODEX_CLI_PATH;if(!e)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);this.authorityError=null;let t=await this.getConfigOverrides();if(this.disposed)throw Error(`shared app-server socket transport was disposed during startup`);if(!Array.isArray(t)||t.some(e=>typeof e!==`string`))throw Error(`shared app-server socket received invalid config overrides`);await this.acquireOwnership();if(this.disposed){this.releaseOwnedPaths(!0);throw Error(`shared app-server socket transport was disposed during startup`)}let n=require(`node:fs`),r;try{r=require(`node:child_process`).spawn(e,[...t.flatMap(e=>[`-c`,e]),`app-server`,`--listen`,`unix://${this.socketPath}`],{env:process.env,stdio:`ignore`}),this.authority=r}catch(e){this.releaseOwnedPaths();throw e}try{this.recordAuthorityIdentity(r),await new Promise((e,t)=>{let i=!1,a,o=()=>{clearTimeout(a),clearTimeout(u),r.off(`error`,s),r.off(`exit`,l),r.off(`close`,l)},c=(n,u)=>{if(i)return;i=!0,o(),n?t(n):e(u)},s=e=>{this.authorityError=e,c(e)},l=()=>c(Error(`shared app-server authority exited before socket creation`)),h=()=>{if(i)return;try{let s=this.readSocketPath(),e=s.identity;if(s.target){if(typeof process.getuid==`function`&&e.uid!==process.getuid())return c(Error(`shared app-server socket has unexpected owner`));this.socketIdentity={dev:e.dev,ino:e.ino};return c(null)}}catch(e){if(e?.code!==`ENOENT`)return c(e)}a=setTimeout(h,100),a.unref?.()},u=setTimeout(()=>c(Error(`shared app-server socket creation timed out`)),1e4);r.once(`error`,s),r.once(`exit`,l),r.once(`close`,l),h(),u.unref?.()}),this.publishAttachedCliRecord(r,e),r.on(`error`,e=>{this.authorityError=e;for(let t of this.proxyStreams)t.destroy(e)}),r.once(`exit`,()=>{this.authority===r&&(this.authority=null,this.releaseOwnedPaths(!0))})}catch(e){this.authority=null;(await this.stopAuthority(r))&&this.releaseOwnedPaths();throw e}}" +
    "createProxyStream(){let c=process.env.CODEX_CLI_PATH;if(!c)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);let e=require(`node:child_process`).spawn(c,[`app-server`,`proxy`,`--sock`,this.socketPath],{env:process.env,stdio:[`pipe`,`pipe`,`pipe`]}),t=e.stdin,n=e.stdout,r=e.stderr;if(t==null||n==null||r==null)throw e.kill(),Error(`shared app-server proxy stdio was unavailable`);let i=``;r.on(`data`,e=>{i=`${i}${e.toString(`utf8`)}`.slice(-4000)});let a=new(require(`node:stream`).Duplex)({read(){n.resume()},write(e,n,r){t.write(e,n,r)},final(e){t.end(),e()},destroy(t,n){e.kill(),n(t)}});Object.assign(a,{setKeepAlive:()=>a,setNoDelay:()=>a,setTimeout:()=>a});let o=e=>a.destroy(e);t.on(`error`,o),n.on(`data`,e=>{a.push(e)||n.pause()}),n.on(`end`,()=>a.push(null)),e.on(`error`,o),e.on(`close`,(e,n)=>{t.removeListener(`error`,o),e===0?a.push(null):a.destroy(Error(`shared app-server proxy exited (${e??n??`unknown`}): ${i.trim()}`))}),this.proxyStreams.add(a),a.once(`close`,()=>this.proxyStreams.delete(a));return a}" +
    `connect(){return this.ensureAuthority().then(()=>new ${webSocketTransport}({` +
    "hostConfig:{kind:`local`,id:`local`},websocketUrl:`ws://localhost/rpc`," +
    "createConnection:()=>this.createProxyStream()}).connect())}}"
  );
}

const CURRENT_DAEMON_PATTERN = /new ([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\(\{hostConfig:this\.options\.hostConfig,websocketUrl:"ws:\/\/localhost\/rpc",createConnection:/gu;
const CURRENT_FACTORY_PATTERN = /function\((?<options>[A-Za-z_$][\w$]*),(?<host>[A-Za-z_$][\w$]*),(?<overrides>[A-Za-z_$][\w$]*)\)\{let\{isPackaged:(?<packaged>[A-Za-z_$][\w$]*)=!1,\.\.\.(?<rest>[A-Za-z_$][\w$]*)\}=\k<options>\.options;/gu;
const CURRENT_CONFIGURE_PATTERN = /getConfigOverrides:async\(\)=>\{let\{overrides:([A-Za-z_$][\w$]*),windowsFrameworkRoot:([A-Za-z_$][\w$]*)\}=await ([A-Za-z_$][\w$]*)\(\);return\(0,([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\)\(\2\),\1\}/gu;

const TRANSPORT_MARKER = "class CodexLinuxSharedAppServerSocketTransport";
const FACTORY_METHOD = "createLinuxSharedSocket";

function sharedAppServerSocketContract(source) {
  const daemons = [...source.matchAll(CURRENT_DAEMON_PATTERN)];
  const factories = [...source.matchAll(CURRENT_FACTORY_PATTERN)];
  const markerCount = source.split(TRANSPORT_MARKER).length - 1;
  if (daemons.length !== 1 || factories.length !== 1) {
    return { state: "drifted", reason: `found ${daemons.length} local transports and ${factories.length} factories` };
  }
  const [daemon] = daemons;
  const [factory] = factories;
  const classAnchor = source.lastIndexOf("class ", daemon.index);
  const classHeader = classAnchor < 0 ? null : source.slice(classAnchor).match(/^class [A-Za-z_$][\w$]*\{/);
  const classBody = classAnchor + (classHeader?.[0].length ?? 0);
  if (classHeader == null || findMatchingBrace(source, classBody - 1) <= daemon.index) {
    return { state: "drifted", reason: "local transport class not found" };
  }

  const factoryBody = factory.index + factory[0].length;
  const factoryEnd = findMatchingBrace(source, source.indexOf("{", factory.index));
  if (factoryEnd < factoryBody) {
    return { state: "drifted", reason: "local transport factory body not found" };
  }
  const factoryTail = source.slice(factoryBody, factoryEnd);
  const nativeConstructor = factoryTail.match(/return new ([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*)\(\{/);
  if (nativeConstructor == null) {
    return { state: "drifted", reason: "local transport constructor not found" };
  }
  const configures = [...factoryTail.matchAll(CURRENT_CONFIGURE_PATTERN)];
  if (configures.length !== 1 || configures[0][3] !== factory.groups.overrides) {
    return { state: "drifted", reason: `config override callback found ${configures.length}` };
  }
  const [configure] = configures;
  const configCallback = configure[0].slice("getConfigOverrides:".length);
  const classSource = sharedTransportClassSource(daemon[1]);
  // The factory and native class can live in separate bundled modules.
  const method = `static ${FACTORY_METHOD}(e,t){return new CodexLinuxSharedAppServerSocketTransport(e,t)}`;
  const branch = `if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET&&${factory.groups.host}.kind===\`local\`&&${factory.groups.host}.id===\`local\`)` +
    `return ${nativeConstructor[1]}.${FACTORY_METHOD}(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET,${configCallback});`;
  const classCount = source.split(classSource).length - 1;
  const methodCount = source.split(FACTORY_METHOD).length - 1;
  const branchCount = source.split(branch).length - 1;
  if (markerCount === 0 && methodCount === 0 && branchCount === 0 && nativeConstructor.index === 0) {
    return { state: "current", classAnchor, classBody, factoryBody, classSource, method, branch };
  }
  if (markerCount === 1 && classCount === 1 && methodCount === 2 && branchCount === 1 &&
      source.slice(classAnchor - classSource.length, classAnchor) === classSource &&
      source.startsWith(method, classBody) &&
      nativeConstructor.index === branch.length && factoryTail.startsWith(branch)) {
    return { state: "patched" };
  }
  return { state: "drifted", reason: `found markers ${markerCount}, complete classes ${classCount}, factory method references ${methodCount}, and branches ${branchCount}` };
}

function insertSharedTransport(source, contract) {
  const { classAnchor, classBody, factoryBody, classSource, method, branch } = contract;
  const insertions = [
    [classAnchor, classSource],
    [classBody, method],
    [factoryBody, branch],
  ];
  for (const [index, insertion] of insertions.sort(([a], [b]) => b - a)) {
    source = source.slice(0, index) + insertion + source.slice(index);
  }
  return source;
}

function patchAppServerHost(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const candidates = [];
  for (const name of readDirectoryNames(buildDir).filter((name) => name.endsWith(".js")).sort()) {
    const file = path.join(buildDir, name);
    const source = fs.readFileSync(file, "utf8");
    if (source.search(CURRENT_FACTORY_PATTERN) >= 0 ||
        source.includes(TRANSPORT_MARKER) || source.includes(FACTORY_METHOD)) {
      candidates.push({ file, source });
    }
  }
  if (candidates.length !== 1) {
    throw new PatchIntegrityError(
      `Expected one shared app-server socket host bundle, found ${candidates.length}`,
    );
  }

  const [{ file, source }] = candidates;
  const contract = sharedAppServerSocketContract(source);
  if (contract.state === "patched") return { changed: false };
  if (contract.state !== "current") {
    throw new PatchIntegrityError(`Could not patch ${path.basename(file)}: ${contract.reason}`);
  }

  const patched = insertSharedTransport(source, contract);
  if (sharedAppServerSocketContract(patched).state !== "patched") {
    throw new PatchIntegrityError(`Incomplete shared app-server socket patch in ${path.basename(file)}`);
  }
  fs.writeFileSync(file, patched, "utf8");
  return { changed: true };
}

const descriptors = [
  {
    id: "main-process-shared-app-server-socket",
    phase: "extracted-app:pre-webview",
    order: 140,
    ciPolicy: "optional",
    apply: patchAppServerHost,
  },
];

module.exports = { descriptors, sharedTransportClassSource };
