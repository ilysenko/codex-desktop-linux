"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";

function findTransportSymbols(source) {
  const classMatch = source.match(
    new RegExp(
      `var (${IDENT})=class\\{options;kind=\\\`websocket\\\`;logger=${IDENT}\\.${IDENT}\\(\\\`AppServerTransportSshWebsocket\\\`\\)`,
    ),
  );
  const selectionLogIndex = source.indexOf("selected app-server transport");
  if (classMatch == null || selectionLogIndex < 0 || classMatch.index >= selectionLogIndex) return null;

  const sshClassSource = source.slice(classMatch.index, selectionLogIndex);
  const webSocketMatch = sshClassSource.match(
    new RegExp(`new (${IDENT})\\.(${IDENT})\\((${IDENT}),\\{perMessageDeflate:!1,createConnection:`),
  );
  if (webSocketMatch == null) return null;
  const [, namespace, webSocketClass, webSocketUrl] = webSocketMatch;
  const lifecycleMatch = sshClassSource.match(
    new RegExp(
      `${namespace}\\.(${IDENT})\\((${IDENT}),\\{onPongTimeout:[\\s\\S]{0,220}?new ${namespace}\\.(${IDENT})\\(\\2\\)`,
    ),
  );
  if (lifecycleMatch == null) return null;

  return {
    namespace,
    webSocketClass,
    webSocketUrl,
    adapterClass: lifecycleMatch[3],
    keepAlive: lifecycleMatch[1],
  };
}

function sharedTransportClassSource(symbols) {
  return (
    "class CodexLinuxSharedAppServerSocketTransport{" +
    "kind=`websocket`;proxyStreams=new Set;authority=null;authorityError=null;authorityReady=null;lockIdentity=null;ownerStartTime=null;socketIdentity=null;disposed=!1;" +
    "constructor(e,t){if(typeof t!==`function`)throw Error(`shared app-server socket requires a config override callback`);this.socketPath=e;this.lockPath=`${e}.lock`;this.getConfigOverrides=t}" +
    "supportsReconnect(){return!0}" +
    "sameIdentity(e,t){return e!=null&&t.dev===e.dev&&t.ino===e.ino}" +
    "processIdentity(e){let t=require(`node:fs`);try{let n=t.readFileSync(`/proc/${e}/stat`,`utf8`),r=n.lastIndexOf(`)`);if(r<0)return null;return n.slice(r+2).trim().split(/\\s+/)[19]??null}catch(e){return null}}" +
    "recordAuthorityIdentity(e){let t=require(`node:fs`),n=e?.pid,r=this.processIdentity(n);if(!Number.isInteger(n)||r==null||this.ownerStartTime==null)throw Error(`shared app-server socket could not identify its authority`);let o;try{o=t.openSync(this.lockPath,`r+`);let e=t.fstatSync(o),i=t.readFileSync(o,`utf8`);if(!this.sameIdentity(this.lockIdentity,e)||i!==`${process.pid} ${this.ownerStartTime}\\n`)throw Error(`shared app-server ownership changed before authority registration`);t.ftruncateSync(o,0),t.writeSync(o,`${process.pid} ${this.ownerStartTime} ${n} ${r}\\n`,0,`utf8`),t.fsyncSync(o)}finally{o!=null&&t.closeSync(o)}}" +
    "socketPathIsLive(){return new Promise(e=>{let t=require(`node:net`).createConnection({path:this.socketPath}),n=!1,r=o=>{if(n)return;n=!0,clearTimeout(i),t.removeAllListeners(),t.destroy(),e(o)},i=setTimeout(()=>r(!0),500);i.unref?.(),t.once(`connect`,()=>r(!0)),t.once(`error`,e=>r(e?.code!==`ECONNREFUSED`&&e?.code!==`ENOENT`))})}" +
    "async reclaimStaleLock(){let e=require(`node:fs`),t;try{t=e.openSync(this.lockPath,`r`);let n=e.fstatSync(t),r=e.readFileSync(t,`utf8`).trim(),o=r.match(/^(\\d+) (\\S+)(?: \\d+ \\S+)?$/),i=!1;if(o){let t=Number(o[1]),n=this.processIdentity(t);i=n==null?!e.existsSync(`/proc/${t}`):n!==o[2]}else i=Date.now()-n.mtimeMs>15e3;if(!i)return!1;let a=null;try{a=e.lstatSync(this.socketPath);if(!a.isSocket()||await this.socketPathIsLive())return!1}catch(e){if(e?.code!==`ENOENT`)throw e}if(a)try{let t=e.lstatSync(this.socketPath);if(!this.sameIdentity(a,t))return!1;e.unlinkSync(this.socketPath)}catch(e){if(e?.code!==`ENOENT`)throw e}let s=e.lstatSync(this.lockPath);if(!this.sameIdentity(n,s))return!1;e.unlinkSync(this.lockPath);return!0}catch(e){if(e?.code===`ENOENT`)return!0;throw e}finally{t!=null&&e.closeSync(t)}}" +
    "releaseOwnedPaths(e=!1){let t=require(`node:fs`),n=[];if(this.socketIdentity)try{let e=t.lstatSync(this.socketPath);this.sameIdentity(this.socketIdentity,e)&&t.unlinkSync(this.socketPath),this.socketIdentity=null}catch(e){e?.code===`ENOENT`?this.socketIdentity=null:n.push(e)}if(this.lockIdentity)try{let e=t.lstatSync(this.lockPath);this.sameIdentity(this.lockIdentity,e)&&t.unlinkSync(this.lockPath),this.lockIdentity=null}catch(e){e?.code===`ENOENT`?this.lockIdentity=null:n.push(e)}if(n.length&&!e)throw n[0];n.length&&console.warn(`WARN: shared app-server socket cleanup failed: ${n[0].message}`)}" +
    "dispose(){this.disposed=!0;for(let e of this.proxyStreams)e.destroy();this.proxyStreams.clear();let e=this.authority;this.authority=null;if(e&&e.exitCode==null&&e.signalCode==null){let t=()=>this.releaseOwnedPaths(!0);e.once(`close`,t);try{e.kill()}catch(e){console.warn(`WARN: shared app-server authority stop failed: ${e.message}`)}}else this.releaseOwnedPaths(!0)}" +
    "async acquireOwnership(){let e=require(`node:fs`),t=require(`node:path`);e.mkdirSync(t.dirname(this.socketPath),{recursive:!0,mode:448});for(let t=0;t<2;t++){let n;try{n=e.openSync(this.lockPath,`wx`,384),this.lockIdentity=e.fstatSync(n);let t=this.processIdentity(process.pid);if(t==null)throw Error(`shared app-server socket could not identify its owner`);this.ownerStartTime=t,e.writeSync(n,`${process.pid} ${t}\\n`),e.fsyncSync(n)}catch(e){if(e?.code===`EEXIST`&&t===0&&await this.reclaimStaleLock())continue;if(e?.code===`EEXIST`)throw Error(`shared app-server socket is already owned: ${this.socketPath}`);this.releaseOwnedPaths(!0);throw e}finally{n!=null&&e.closeSync(n)}try{e.lstatSync(this.socketPath);throw Error(`shared app-server socket path already exists: ${this.socketPath}`)}catch(e){if(e?.code!==`ENOENT`){this.releaseOwnedPaths();throw e}}return}}" +
    "stopAuthority(e){return new Promise(t=>{if(!e||e.exitCode!=null||e.signalCode!=null)return t(!0);let n=!1,r=i=>{if(n)return;n=!0,clearTimeout(a),e.off(`close`,o),e.off(`exit`,o),e.off(`error`,s),t(i)},o=()=>r(!0),s=e=>{this.authorityError??=e},a=setTimeout(()=>r(!1),2e3);a.unref?.(),e.once(`close`,o),e.once(`exit`,o),e.on(`error`,s);try{e.kill()}catch(e){this.authorityError??=e,r(!1)}})}" +
    "async ensureAuthority(){if(this.disposed)throw Error(`shared app-server socket transport is disposed`);if(this.authorityReady)return this.authorityReady;if(this.authority&&this.authority.exitCode==null&&this.authority.signalCode==null){if(this.authorityError)throw this.authorityError;return}let e=this.startAuthority();this.authorityReady=e;try{return await e}finally{this.authorityReady===e&&(this.authorityReady=null)}}" +
    "async startAuthority(){let e=process.env.CODEX_CLI_PATH;if(!e)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);this.authorityError=null;let t=await this.getConfigOverrides();if(this.disposed)throw Error(`shared app-server socket transport was disposed during startup`);if(!Array.isArray(t)||t.some(e=>typeof e!==`string`))throw Error(`shared app-server socket received invalid config overrides`);await this.acquireOwnership();if(this.disposed){this.releaseOwnedPaths(!0);throw Error(`shared app-server socket transport was disposed during startup`)}let n=require(`node:fs`),r;try{r=require(`node:child_process`).spawn(e,[...t.flatMap(e=>[`-c`,e]),`app-server`,`--listen`,`unix://${this.socketPath}`],{env:process.env,stdio:`ignore`}),this.authority=r}catch(e){this.releaseOwnedPaths();throw e}try{this.recordAuthorityIdentity(r),await new Promise((e,t)=>{let i=!1,a,o=()=>{clearTimeout(a),clearTimeout(u),r.off(`error`,s),r.off(`exit`,l),r.off(`close`,l)},c=(n,u)=>{if(i)return;i=!0,o(),n?t(n):e(u)},s=e=>{this.authorityError=e,c(e)},l=()=>c(Error(`shared app-server authority exited before socket creation`)),h=()=>{if(i)return;try{let e=n.lstatSync(this.socketPath);if(e.isSocket()){if(typeof process.getuid==`function`&&e.uid!==process.getuid())return c(Error(`shared app-server socket has unexpected owner`));this.socketIdentity={dev:e.dev,ino:e.ino};return c(null)}}catch(e){if(e?.code!==`ENOENT`)return c(e)}a=setTimeout(h,100),a.unref?.()},u=setTimeout(()=>c(Error(`shared app-server socket creation timed out`)),1e4);r.once(`error`,s),r.once(`exit`,l),r.once(`close`,l),h(),u.unref?.()}),r.on(`error`,e=>{this.authorityError=e;for(let t of this.proxyStreams)t.destroy(e)}),r.once(`exit`,()=>{this.authority===r&&(this.authority=null,this.releaseOwnedPaths(!0))})}catch(e){this.authority=null;(await this.stopAuthority(r))&&this.releaseOwnedPaths();throw e}}" +
    "createProxyStream(){let c=process.env.CODEX_CLI_PATH;if(!c)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);let e=require(`node:child_process`).spawn(c,[`app-server`,`proxy`,`--sock`,this.socketPath],{env:process.env,stdio:[`pipe`,`pipe`,`pipe`]}),t=e.stdin,n=e.stdout,r=e.stderr;if(t==null||n==null||r==null)throw e.kill(),Error(`shared app-server proxy stdio was unavailable`);let i=``;r.on(`data`,e=>{i=`${i}${e.toString(`utf8`)}`.slice(-4000)});let a=new(require(`node:stream`).Duplex)({read(){n.resume()},write(e,n,r){t.write(e,n,r)},final(e){t.end(),e()},destroy(t,n){e.kill(),n(t)}});Object.assign(a,{setKeepAlive:()=>a,setNoDelay:()=>a,setTimeout:()=>a});let o=e=>a.destroy(e);t.on(`error`,o),n.on(`data`,e=>{a.push(e)||n.pause()}),n.on(`end`,()=>a.push(null)),e.on(`error`,o),e.on(`close`,(e,n)=>{t.removeListener(`error`,o),e===0?a.push(null):a.destroy(Error(`shared app-server proxy exited (${e??n??`unknown`}): ${i.trim()}`))}),this.proxyStreams.add(a),a.once(`close`,()=>this.proxyStreams.delete(a));return a}" +
    `async connect(){await this.ensureAuthority();let e={current:null},t=new ${symbols.namespace}.${symbols.webSocketClass}(${symbols.webSocketUrl},{perMessageDeflate:!1,createConnection:()=>(e.current=this.createProxyStream(),e.current)});t.once(\`close\`,()=>e.current?.destroy());try{await new Promise((n,r)=>{let i=setTimeout(()=>o(Error(\`shared app-server websocket open timed out\`)),3e4);i.unref();let a=()=>{clearTimeout(i),t.off(\`error\`,o),t.off(\`close\`,s)},o=e=>{a(),r(e)},s=()=>o(Error(\`shared app-server websocket closed before opening\`));t.once(\`open\`,()=>{a(),n()}),t.once(\`error\`,o),t.once(\`close\`,s)})}catch(n){e.current?.destroy(),t.terminate(),await new Promise(e=>setTimeout(e,0));throw n}${symbols.namespace}.${symbols.keepAlive}(t,{onPongTimeout:()=>t.terminate()});return new ${symbols.namespace}.${symbols.adapterClass}(t)}}`
  );
}

function applySharedAppServerSocketPatch(source) {
  if (source.includes("class CodexLinuxSharedAppServerSocketTransport")) return source;

  const symbols = findTransportSymbols(source);
  if (symbols == null) {
    console.warn("WARN: Could not find SSH WebSocket transport for shared app-server socket patch");
    return source;
  }

  const selectionLogIndex = source.indexOf("selected app-server transport");
  const factoryStart = source.lastIndexOf("function ", selectionLogIndex);
  const factoryEnd = source.indexOf("function ", selectionLogIndex + 1);
  if (selectionLogIndex < 0 || factoryStart < 0 || factoryEnd < 0) {
    console.warn("WARN: Could not find local transport factory for shared app-server socket patch");
    return source;
  }
  const factorySource = source.slice(factoryStart, factoryEnd);
  const insertionPattern = new RegExp(
    `(if\\(${symbols.namespace}\\.(${IDENT})\\(e\\.hostConfig\\)\\)return new (${IDENT})\\(\\{hostConfig:e\\.hostConfig,repoRoot:e\\.repoRoot,resourcesPath:e\\.resourcesPath,defaultOriginator:e\\.defaultOriginator\\}\\);)(?=let (${IDENT})=(${IDENT})\\(e\\.hostConfig\\);if\\(\\4\\)\\{)`,
    "g",
  );
  const insertionMatches = [...factorySource.matchAll(insertionPattern)];
  if (insertionMatches.length !== 1) {
    console.warn(
      `WARN: Expected one local transport insertion point for shared app-server socket patch, found ${insertionMatches.length}`,
    );
    return source;
  }
  const configOverridesPattern = new RegExp(
    `return new ${symbols.namespace}\\.(${IDENT})\\(\\{hostConfig:e\\.hostConfig,repoRoot:e\\.repoRoot,resourcesPath:e\\.resourcesPath,defaultOriginator:e\\.defaultOriginator,getConfigOverrides:((?:async)?\\(\\)=>${IDENT}\\(e\\))\\}\\)`,
    "g",
  );
  const configOverridesMatches = [...factorySource.matchAll(configOverridesPattern)];
  if (configOverridesMatches.length !== 1) {
    console.warn(
      `WARN: Expected one local transport config override callback for shared app-server socket patch, found ${configOverridesMatches.length}`,
    );
    return source;
  }
  const [insertionMatch] = insertionMatches;
  const getConfigOverrides = configOverridesMatches[0][2];

  const classSource = sharedTransportClassSource(symbols);

  const insertionIndex = insertionMatch.index + insertionMatch[0].length;
  const patchedFactory =
    factorySource.slice(0, insertionIndex) +
    `if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET&&e.hostConfig.kind===\`local\`)return new CodexLinuxSharedAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET,${getConfigOverrides});` +
    factorySource.slice(insertionIndex);
  return source.slice(0, factoryStart) + classSource + patchedFactory + source.slice(factoryEnd);
}

const descriptors = [
  {
    id: "main-process-shared-app-server-socket",
    phase: "main-bundle",
    order: 140,
    ciPolicy: "optional",
    apply: applySharedAppServerSocketPatch,
  },
];

module.exports = {
  applySharedAppServerSocketPatch,
  descriptors,
  findTransportSymbols,
  sharedTransportClassSource,
};
