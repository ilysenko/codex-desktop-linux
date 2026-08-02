"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const PATCH_SENTINEL = "/*codex-linux:external-app-server-attachment:v1*/";
const ATTACHMENT_CLASS = "class CodexLinuxExternalAppServerSocketTransport";
const ATTACHMENT_SELECTOR =
  "if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_ATTACH_ONLY===`1`){if(e.hostConfig.kind!==`local`)throw Error(`external app-server socket mode requires a local host`);if(!process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET)throw Error(`external app-server socket mode requires CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET`);return new CodexLinuxExternalAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET)}";

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
  const [lifecycleMatch, extraLifecycleMatch] = sshClassSource.matchAll(
    new RegExp(
      `return ${namespace}\\.(${IDENT})\\((${IDENT}),\\{onPongTimeout:[\\s\\S]{0,160}?\\}\\),(?:this\\.hasConnected=!0,)?new ${namespace}\\.(${IDENT})\\(\\2\\)(?=\\})`,
      "g",
    ),
  );
  if (lifecycleMatch == null || extraLifecycleMatch != null) return null;

  return {
    namespace,
    webSocketClass,
    webSocketUrl,
    adapterClass: lifecycleMatch[3],
    keepAlive: lifecycleMatch[1],
  };
}

function attachmentTransportClassSource(symbols) {
  return (
    "class CodexLinuxExternalAppServerSocketTransport{" +
    "kind=`websocket`;proxyStreams=new Set;proxyChildren=new Set;proxyKillTimers=new Map;validationFds=new Set;disposed=!1;" +
    "constructor(e){this.socketPath=e}" +
    "supportsReconnect(){return!0}" +
    "closeValidationFd(e){if(!this.validationFds.delete(e))return;try{require(`node:fs`).closeSync(e)}catch(e){console.warn(`WARN: external app-server parent fd close failed: ${e.message}`)}}" +
    "validateEndpoint(){let e=require(`node:fs`),t=require(`node:path`),n=t.dirname(this.socketPath),r=t.basename(this.socketPath),i,a,o,c,s=null;if(!t.isAbsolute(this.socketPath))throw Error(`external app-server socket requires an absolute path`);if(n!==t.normalize(n)||this.socketPath!==t.join(n,r))throw Error(`external app-server socket parent path is not canonical`);if(typeof process.getuid!=`function`)throw Error(`external app-server socket current UID is unavailable`);try{c=process.getuid()}catch(e){throw Error(`external app-server socket current UID is unavailable`)}if(!Number.isInteger(c)||c<0)throw Error(`external app-server socket current UID is unavailable`);c=BigInt(c);try{i=e.lstatSync(n,{bigint:!0})}catch(e){throw Error(`external app-server socket parent inspection failed: ${e?.code??e?.message??e}`)}if(!i.isDirectory())throw Error(`external app-server socket parent is not a real directory: ${n}`);if(i.uid!==c)throw Error(`external app-server socket parent has unexpected owner`);if((i.mode&320n)!==320n)throw Error(`external app-server socket parent owner read and execute permissions are required`);if((i.mode&18n)!==0n)throw Error(`external app-server socket parent has unsafe permissions`);try{a=e.realpathSync(n)}catch(e){throw Error(`external app-server socket parent canonicalization failed: ${e?.code??e?.message??e}`)}if(a!==n)throw Error(`external app-server socket parent path contains a symlink`);try{s=e.openSync(n,e.constants.O_RDONLY|e.constants.O_DIRECTORY|e.constants.O_NOFOLLOW),this.validationFds.add(s)}catch(e){throw Error(`external app-server socket parent open failed: ${e?.code??e?.message??e}`)}try{o=e.fstatSync(s,{bigint:!0});if(!o.isDirectory()||o.dev!==i.dev||o.ino!==i.ino)throw Error(`external app-server socket parent changed during validation`);if(o.uid!==c)throw Error(`external app-server socket parent has unexpected owner`);if((o.mode&320n)!==320n)throw Error(`external app-server socket parent owner read and execute permissions are required`);if((o.mode&18n)!==0n)throw Error(`external app-server socket parent has unsafe permissions`);let t=`/proc/self/fd/${s}/${r}`;try{a=e.lstatSync(t,{bigint:!0})}catch(e){throw Error(`external app-server socket inspection failed: ${e?.code??e?.message??e}`)}if(!a.isSocket())throw Error(`external app-server endpoint is not a real Unix socket: ${this.socketPath}`);if(a.uid!==c)throw Error(`external app-server socket has unexpected owner`);if((a.mode&384n)!==384n)throw Error(`external app-server socket owner read and write permissions are required`);if((a.mode&63n)!==0n)throw Error(`external app-server socket has unsafe group or other permissions`);return{parentFd:s,basename:r}}catch(e){this.closeValidationFd(s);throw e}}" +
    "trackProxy(e){this.proxyChildren.add(e),e.once(`close`,()=>{this.proxyChildren.delete(e);let t=this.proxyKillTimers.get(e);t&&clearTimeout(t),this.proxyKillTimers.delete(e)})}" +
    "stopProxy(e){if(e==null||e.exitCode!=null||e.signalCode!=null||this.proxyKillTimers.has(e))return;let t=setTimeout(()=>{this.proxyKillTimers.delete(e);if(e.exitCode==null&&e.signalCode==null)try{e.kill(`SIGKILL`)}catch(e){console.warn(`WARN: external app-server proxy kill failed: ${e.message}`)}},2e3);t.unref?.(),this.proxyKillTimers.set(e,t);try{e.kill(`SIGTERM`)}catch(e){console.warn(`WARN: external app-server proxy stop failed: ${e.message}`)}}" +
    "dispose(){this.disposed=!0;for(let e of this.validationFds)this.closeValidationFd(e);for(let e of this.proxyStreams)e.destroy();this.proxyStreams.clear();for(let e of this.proxyChildren)this.stopProxy(e)}" +
    "createProxyStream(e){if(this.disposed)throw Error(`external app-server socket transport is disposed`);let c=process.env.CODEX_CLI_PATH;if(!c)throw Error(`external app-server socket requires CODEX_CLI_PATH`);let t=require(`node:child_process`).spawn(c,[`app-server`,`proxy`,`--sock`,e],{env:process.env,stdio:[`pipe`,`pipe`,`pipe`]}),n=t.stdin,r=t.stdout,i=t.stderr;this.trackProxy(t);if(n==null||r==null||i==null)throw this.stopProxy(t),Error(`external app-server proxy stdio was unavailable`);let a=``;i.on(`data`,e=>{a=`${a}${e.toString(`utf8`)}`.slice(-4000)});let s=this,o=new(require(`node:stream`).Duplex)({read(){r.resume()},write(e,t,r){n.write(e,t,r)},final(e){n.end(),e()},destroy(e,n){s.stopProxy(t),n(e)}});Object.assign(o,{setKeepAlive:()=>o,setNoDelay:()=>o,setTimeout:()=>o});let l=e=>o.destroy(e);n.on(`error`,l),r.on(`data`,e=>{o.push(e)||r.pause()}),r.on(`end`,()=>o.push(null)),t.on(`error`,l),t.on(`close`,(e,t)=>{n.removeListener(`error`,l),e===0?o.push(null):o.destroy(Error(`external app-server proxy exited (${e??t??`unknown`}): ${a.trim()}`))}),this.proxyStreams.add(o),o.once(`close`,()=>this.proxyStreams.delete(o));return o}" +
    `async connect(){if(this.disposed)throw Error(\`external app-server socket transport is disposed\`);let codexLinuxBoundEndpoint=this.validateEndpoint(),codexLinuxProxyPath=\`/proc/\${process.pid}/fd/\${codexLinuxBoundEndpoint.parentFd}/\${codexLinuxBoundEndpoint.basename}\`,codexLinuxProxyState={current:null},codexLinuxSocket;try{try{codexLinuxSocket=new ${symbols.namespace}.${symbols.webSocketClass}(${symbols.webSocketUrl},{perMessageDeflate:!1,createConnection:()=>(codexLinuxProxyState.current=this.createProxyStream(codexLinuxProxyPath),codexLinuxProxyState.current)}),codexLinuxSocket.once(\`close\`,()=>codexLinuxProxyState.current?.destroy()),await new Promise((e,t)=>{let n=setTimeout(()=>a(Error(\`external app-server websocket open timed out\`)),3e4);n.unref();let r=()=>{clearTimeout(n),codexLinuxSocket.off(\`error\`,a),codexLinuxSocket.off(\`close\`,s)},a=e=>{r(),t(e)},s=()=>a(Error(\`external app-server websocket closed before opening\`));codexLinuxSocket.once(\`open\`,()=>{r(),e()}),codexLinuxSocket.once(\`error\`,a),codexLinuxSocket.once(\`close\`,s)}),${symbols.namespace}.${symbols.keepAlive}(codexLinuxSocket,{onPongTimeout:()=>codexLinuxSocket.terminate()});return new ${symbols.namespace}.${symbols.adapterClass}(codexLinuxSocket)}catch(e){codexLinuxProxyState.current?.destroy(),codexLinuxSocket?.terminate(),await new Promise(e=>setTimeout(e,0));throw e}}finally{this.closeValidationFd(codexLinuxBoundEndpoint.parentFd)}}}`
  );
}

function applyExternalAppServerAttachmentPatch(source) {
  if (source.includes(PATCH_SENTINEL)) return source;
  if (source.includes(ATTACHMENT_CLASS) || source.includes(ATTACHMENT_SELECTOR)) {
    throw Error("inconsistent external app-server attachment patch state");
  }

  const symbols = findTransportSymbols(source);
  if (symbols == null) {
    console.warn("WARN: Could not find SSH WebSocket transport for external app-server attachment patch");
    return source;
  }

  const selectionLogIndex = source.indexOf("selected app-server transport");
  const factoryStart = source.lastIndexOf("function ", selectionLogIndex);
  const factoryEnd = source.indexOf("function ", selectionLogIndex + 1);
  if (selectionLogIndex < 0 || factoryStart < 0 || factoryEnd < 0) {
    console.warn("WARN: Could not find local transport factory for external app-server attachment patch");
    return source;
  }
  const factorySource = source.slice(factoryStart, factoryEnd);
  const localFallbackPattern = new RegExp(
    `(if\\(${symbols.namespace}\\.(${IDENT})\\(e\\.hostConfig\\)\\)return new (${IDENT})\\(\\{hostConfig:e\\.hostConfig,repoRoot:e\\.repoRoot,resourcesPath:e\\.resourcesPath,defaultOriginator:e\\.defaultOriginator\\}\\);)(?=let (${IDENT})=(${IDENT})\\(e\\.hostConfig\\);if\\(\\4\\)\\{)`,
  );
  const localFallbackMatch = factorySource.match(localFallbackPattern);
  if (localFallbackMatch == null) {
    console.warn("WARN: Could not find local transport fallback for external app-server attachment patch");
    return source;
  }

  const classSource = PATCH_SENTINEL + attachmentTransportClassSource(symbols);

  let patchedFactory = factorySource;
  const factoryBodyStart = patchedFactory.indexOf("{") + 1;
  patchedFactory =
    patchedFactory.slice(0, factoryBodyStart) +
    ATTACHMENT_SELECTOR +
    patchedFactory.slice(factoryBodyStart);
  return source.slice(0, factoryStart) + classSource + patchedFactory + source.slice(factoryEnd);
}

const descriptors = [
  {
    id: "main-process-external-app-server-attachment",
    phase: "main-bundle",
    order: 140,
    ciPolicy: "required-upstream",
    apply: applyExternalAppServerAttachmentPatch,
  },
];

module.exports = {
  attachmentTransportClassSource,
  applyExternalAppServerAttachmentPatch,
  descriptors,
  findTransportSymbols,
};
