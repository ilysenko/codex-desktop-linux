"use strict";

const { readSocketPath } = require("./socket-path.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const IDENT = "[A-Za-z_$][\\w$]*";

const MEMBER = `${IDENT}\\.${IDENT}`;
// Upstream inlines these handshake values as literals in the SSH method; the
// generated transport receives the literal itself, never a method-local name.
const LITERAL = `(?:"[^"\\\\\\n]*"|0x[0-9a-fA-F]+|\\d+(?:e\\d+)?)`;

function findTransportSymbols(source) {
  const classMatches = [...source.matchAll(
    new RegExp(
      `class (${IDENT})\\{options;kind="websocket";logger=\\(0,${MEMBER}\\)\\("AppServerTransportSshWebsocket"\\)`,
      "g",
    ),
  )];
  const selectionLogIndex = source.indexOf("selected app-server transport");
  if (classMatches.length !== 1 || selectionLogIndex < 0 ||
      classMatches[0].index >= selectionLogIndex) return null;
  const [classMatch] = classMatches;

  const sshRegion = source.slice(classMatch.index, selectionLogIndex);
  const connectMatches = [...sshRegion.matchAll(
    new RegExp(`async connectToRemoteAppServer\\(${IDENT},${IDENT}\\)\\{`, "g"),
  )];
  if (connectMatches.length !== 1) return null;
  const connectStart = connectMatches[0].index;
  const connectEnd = findMatchingBrace(sshRegion, sshRegion.indexOf("{", connectStart));
  if (connectEnd < 0) return null;
  // Keep injected transports and unrelated methods out of uniqueness checks.
  const sshClassSource = sshRegion.slice(connectStart, connectEnd + 1);
  const webSocketMatches = [...sshClassSource.matchAll(
    new RegExp(`(${IDENT})=new (${MEMBER})\\((${LITERAL}),\\{perMessageDeflate:!1,[^}]{0,160}createConnection:`, "g"),
  )];
  if (webSocketMatches.length !== 1) return null;
  const [, socket, webSocketClass, webSocketUrl] = webSocketMatches[0];

  // Follow the returned connection and its codec, rather than selecting the
  // first WebSocket wrapper. Upstream constructs the codec before opening and
  // logs compression between constructing the adapter and starting keepalive.
  const adapterMatches = [...sshClassSource.matchAll(
    new RegExp(`let (${IDENT})=new (${MEMBER})\\(${escapeRegExp(socket)},void 0,(${IDENT}),(${IDENT})\\);return `, "g"),
  )];
  if (adapterMatches.length !== 1) return null;
  const [, adapter, adapterClass, frameLimit, codec] = adapterMatches[0];
  const codecMatches = [...sshClassSource.matchAll(
    new RegExp(`let ${escapeRegExp(codec)}=new (${MEMBER})\\(${escapeRegExp(socket)},null!=${IDENT}\\);`, "g"),
  )];
  const keepAliveMatches = [...sshClassSource.matchAll(
    new RegExp(`\\(0,(${MEMBER})\\)\\(${escapeRegExp(socket)},\\{onPongTimeout:\\(\\)=>\\{${escapeRegExp(adapter)}\\.terminationReason="pong_timeout",${escapeRegExp(socket)}\\.terminate\\(\\)\\}\\}\\),this\\.hasConnected=!0,${escapeRegExp(adapter)}(?=[})])`, "g"),
  )];
  const frameLimitMatches = [...sshClassSource.matchAll(
    new RegExp(`let ${escapeRegExp(frameLimit)}=(${LITERAL});${escapeRegExp(socket)}\\.once\\("upgrade",(${IDENT})=>\\{let (${IDENT})=Number\\(\\2\\.headers\\[(${LITERAL})\\]\\);Number\\.isSafeInteger\\(\\3\\)&&\\3>0&&\\(${escapeRegExp(frameLimit)}=\\3\\)\\}\\);`, "g"),
  )];
  if (codecMatches.length !== 1 || keepAliveMatches.length !== 1 || frameLimitMatches.length !== 1 ||
      webSocketMatches[0].index >= frameLimitMatches[0].index ||
      frameLimitMatches[0].index >= codecMatches[0].index ||
      codecMatches[0].index >= adapterMatches[0].index ||
      adapterMatches[0].index >= keepAliveMatches[0].index) return null;

  return {
    webSocketClass,
    webSocketUrl,
    codecClass: codecMatches[0][1],
    adapterClass,
    keepAlive: keepAliveMatches[0][1],
    maximumFrameBytes: frameLimitMatches[0][1],
    maximumFrameHeader: frameLimitMatches[0][4],
  };
}

// Serialized into the app bundle. Dependencies are passed by the outer method
// so minified upstream bindings cannot be captured by this function's locals.
async function connectSharedSocket({
  WebSocket, MessageCodec, ConnectionAdapter, keepAlive,
  url, maximumFrameBytes, maximumFrameHeader,
}) {
  await this.ensureAuthority();
  let proxyStream = null;
  const socket = new WebSocket(url, {
    perMessageDeflate: false,
    createConnection: () => (proxyStream = this.createProxyStream()),
  });
  let firstError = null;
  const recordError = error => { firstError ??= error; };
  socket.on("error", recordError);
  socket.once("close", () => {
    proxyStream?.destroy();
    socket.off("error", recordError);
  });
  try {
    socket.once("upgrade", response => {
      const limit = Number(response.headers[maximumFrameHeader]);
      if (Number.isSafeInteger(limit) && limit > 0) maximumFrameBytes = limit;
    });
    const messages = new MessageCodec(socket, false);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => onError(Error("shared app-server websocket open timed out")), 30e3);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = error => { cleanup(); reject(error); };
      const onClose = () => onError(Error("shared app-server websocket closed before opening"));
      socket.once("open", onOpen);
      socket.once("error", onError);
      socket.once("close", onClose);
    });
    // The codec and WebSocket can fail after open but before this continuation.
    // Keep the recorder until the adapter has installed its own error handler.
    if (firstError != null) throw firstError;
    const connection = new ConnectionAdapter(socket, undefined, maximumFrameBytes, messages);
    socket.off("error", recordError);
    keepAlive(socket, {
      onPongTimeout: () => {
        connection.terminationReason = "pong_timeout";
        socket.terminate();
      },
    });
    return connection;
  } catch (error) {
    proxyStream?.destroy();
    socket.terminate();
    await new Promise(resolve => setTimeout(resolve, 0));
    throw error;
  }
}

function sharedTransportClassSource(symbols) {
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
    `connect(){return (${connectSharedSocket.toString()}).call(this,{WebSocket:${symbols.webSocketClass},MessageCodec:${symbols.codecClass},ConnectionAdapter:${symbols.adapterClass},keepAlive:${symbols.keepAlive},url:${symbols.webSocketUrl},maximumFrameBytes:${symbols.maximumFrameBytes},maximumFrameHeader:${symbols.maximumFrameHeader}})}}`
  );
}

function applySharedAppServerSocketPatch(source) {
  const markerCount = source.split("class CodexLinuxSharedAppServerSocketTransport").length - 1;
  const symbols = findTransportSymbols(source);
  if (markerCount === 1 && symbols != null) return source;
  if (markerCount !== 0) {
    console.warn("WARN: Found incomplete or ambiguous shared app-server socket patch state");
    return source;
  }
  if (symbols == null) {
    console.warn("WARN: Could not find SSH WebSocket transport for shared app-server socket patch");
    return source;
  }

  const selectionLogIndex = source.indexOf("selected app-server transport");
  const factoryStart = source.lastIndexOf("function ", selectionLogIndex);
  const factoryHead = factoryStart < 0
    ? null
    : source.slice(factoryStart).match(new RegExp(`^function ${IDENT}\\((${IDENT})\\)\\{`));
  const factoryEnd = factoryHead == null
    ? -1
    : findMatchingBrace(source, factoryStart + factoryHead[0].length - 1) + 1;
  if (selectionLogIndex < 0 || factoryHead == null || factoryEnd <= selectionLogIndex) {
    console.warn("WARN: Could not find local transport factory for shared app-server socket patch");
    return source;
  }
  const options = escapeRegExp(factoryHead[1]);
  const factorySource = source.slice(factoryStart, factoryEnd);
  const optionFields =
    `\\{hostConfig:${options}\\.hostConfig,repoRoot:${options}\\.repoRoot,` +
    `resourcesPath:${options}\\.resourcesPath,defaultOriginator:${options}\\.defaultOriginator`;
  const insertionPattern = new RegExp(
    `(if\\(\\(0,${MEMBER}\\)\\(${options}\\.hostConfig\\)\\)return new ${IDENT}\\(${optionFields}\\}\\);)` +
      `(?=let (${IDENT})=${IDENT}\\(${options}\\.hostConfig\\);if\\(\\2\\)\\{)`,
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
    `return new ${MEMBER}\\(${optionFields},getConfigOverrides:(async\\(\\)=>\\[[^\\]]{1,1000}\\])\\}\\)`,
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
  const getConfigOverrides = configOverridesMatches[0][1];

  const classSource = sharedTransportClassSource(symbols);

  const insertionIndex = insertionMatch.index + insertionMatch[0].length;
  const patchedFactory =
    factorySource.slice(0, insertionIndex) +
    `if(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET&&${factoryHead[1]}.hostConfig.kind===\`local\`&&${factoryHead[1]}.hostConfig.id===\`local\`)return new CodexLinuxSharedAppServerSocketTransport(process.env.CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET,${getConfigOverrides});` +
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
