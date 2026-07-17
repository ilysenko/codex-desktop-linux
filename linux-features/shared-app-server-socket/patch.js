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
      `return ${namespace}\\.(${IDENT})\\((${IDENT}),\\{onPongTimeout:[\\s\\S]{0,160}?\\}\\),new ${namespace}\\.(${IDENT})\\(\\2\\)`,
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
    "kind=`websocket`;proxyStreams=new Set;authority=null;authorityError=null;authorityReady=null;lockIdentity=null;socketIdentity=null;" +
    "constructor(e){this.socketPath=e;this.lockPath=`${e}.lock`}" +
    "supportsReconnect(){return!0}" +
    "sameIdentity(e,t){return e!=null&&t.dev===e.dev&&t.ino===e.ino}" +
    "releaseOwnedPaths(e=!1){let t=require(`node:fs`),n=[];if(this.socketIdentity)try{let e=t.lstatSync(this.socketPath);this.sameIdentity(this.socketIdentity,e)&&t.unlinkSync(this.socketPath),this.socketIdentity=null}catch(e){e?.code===`ENOENT`?this.socketIdentity=null:n.push(e)}if(this.lockIdentity)try{let e=t.lstatSync(this.lockPath);this.sameIdentity(this.lockIdentity,e)&&t.unlinkSync(this.lockPath),this.lockIdentity=null}catch(e){e?.code===`ENOENT`?this.lockIdentity=null:n.push(e)}if(n.length&&!e)throw n[0];n.length&&console.warn(`WARN: shared app-server socket cleanup failed: ${n[0].message}`)}" +
    "dispose(){for(let e of this.proxyStreams)e.destroy();this.proxyStreams.clear();let e=this.authority;this.authority=null;if(e&&e.exitCode==null&&e.signalCode==null){let t=()=>this.releaseOwnedPaths(!0);e.once(`close`,t);try{e.kill()}catch(e){console.warn(`WARN: shared app-server authority stop failed: ${e.message}`)}}else this.releaseOwnedPaths(!0)}" +
    "acquireOwnership(){let e=require(`node:fs`),t=require(`node:path`);e.mkdirSync(t.dirname(this.socketPath),{recursive:!0,mode:448});let n;try{n=e.openSync(this.lockPath,`wx`,384),this.lockIdentity=e.fstatSync(n)}catch(e){if(e?.code===`EEXIST`)throw Error(`shared app-server socket is already owned: ${this.socketPath}`);throw e}finally{n!=null&&e.closeSync(n)}try{e.lstatSync(this.socketPath);throw Error(`shared app-server socket path already exists: ${this.socketPath}`)}catch(e){if(e?.code!==`ENOENT`){this.releaseOwnedPaths();throw e}}}" +
    "stopAuthority(e){return new Promise(t=>{if(!e||e.exitCode!=null||e.signalCode!=null)return t(!0);let n=!1,r=i=>{if(n)return;n=!0,clearTimeout(a),e.off(`close`,o),e.off(`exit`,o),e.off(`error`,s),t(i)},o=()=>r(!0),s=e=>{this.authorityError??=e},a=setTimeout(()=>r(!1),2e3);a.unref?.(),e.once(`close`,o),e.once(`exit`,o),e.on(`error`,s);try{e.kill()}catch(e){this.authorityError??=e,r(!1)}})}" +
    "async ensureAuthority(){if(this.authorityReady)return this.authorityReady;if(this.authority&&this.authority.exitCode==null&&this.authority.signalCode==null){if(this.authorityError)throw this.authorityError;return}let e=this.startAuthority();this.authorityReady=e;try{return await e}finally{this.authorityReady===e&&(this.authorityReady=null)}}" +
    "async startAuthority(){let e=process.env.CODEX_CLI_PATH;if(!e)throw Error(`shared app-server socket requires CODEX_CLI_PATH`);this.authorityError=null,this.acquireOwnership();let t=require(`node:fs`),n;try{n=require(`node:child_process`).spawn(e,[`app-server`,`--listen`,`unix://${this.socketPath}`],{env:process.env,stdio:`ignore`}),this.authority=n}catch(e){this.releaseOwnedPaths();throw e}try{await new Promise((e,r)=>{let i=!1,a,o=()=>{clearTimeout(a),clearTimeout(u),n.off(`error`,s),n.off(`exit`,l),n.off(`close`,l)},c=(t,u)=>{if(i)return;i=!0,o(),t?r(t):e(u)},s=e=>{this.authorityError=e,c(e)},l=()=>c(Error(`shared app-server authority exited before socket creation`)),h=()=>{if(i)return;try{let e=t.lstatSync(this.socketPath);if(e.isSocket()){if(typeof process.getuid==`function`&&e.uid!==process.getuid())return c(Error(`shared app-server socket has unexpected owner`));this.socketIdentity={dev:e.dev,ino:e.ino};return c(null)}}catch(e){if(e?.code!==`ENOENT`)return c(e)}a=setTimeout(h,100),a.unref?.()},u=setTimeout(()=>c(Error(`shared app-server socket creation timed out`)),1e4);n.once(`error`,s),n.once(`exit`,l),n.once(`close`,l),h(),u.unref?.()}),n.on(`error`,e=>{this.authorityError=e;for(let t of this.proxyStreams)t.destroy(e)}),n.once(`exit`,()=>{this.authority===n&&(this.authority=null,this.releaseOwnedPaths(!0))})}catch(e){this.authority=null;(await this.stopAuthority(n))&&this.releaseOwnedPaths();throw e}}" +
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
  const localFallbackPattern = new RegExp(
    `(if\\(${symbols.namespace}\\.(${IDENT})\\(e\\.hostConfig\\)\\)return new (${IDENT})\\(\\{hostConfig:e\\.hostConfig,repoRoot:e\\.repoRoot,resourcesPath:e\\.resourcesPath,defaultOriginator:e\\.defaultOriginator\\}\\);)(?=let (${IDENT})=(${IDENT})\\(e\\.hostConfig\\);if\\(\\4\\)\\{)`,
  );
  const localFallbackMatch = factorySource.match(localFallbackPattern);
  if (localFallbackMatch == null) {
    console.warn("WARN: Could not find local transport fallback for shared app-server socket patch");
    return source;
  }

  const classSource = sharedTransportClassSource(symbols);

  const patchedFactory = factorySource.replace(
    localFallbackPattern,
    (match) =>
      `${match}if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET&&e.hostConfig.kind===\`local\`)return new CodexLinuxSharedAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET);`,
  );
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
