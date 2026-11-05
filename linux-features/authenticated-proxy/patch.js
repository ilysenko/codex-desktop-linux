"use strict";

const { Script } = require("node:vm");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";

// The rspack main process spreads code over chunk files and the patch engine
// offers this descriptor every chunk. The ready point and the application
// network surface are one contract: the helpers are declared at the top of the
// chunk that holds both, so every injected call resolves in that module scope.
const READY_PATTERN = new RegExp(
  `await (${JS_IDENT})\\.app\\.whenReady\\(\\)(?=,${JS_IDENT}\\("main app\\.whenReady resolved")`,
  "g",
);
const PATCHED_READY_PATTERN = new RegExp(
  `\\(codexLinuxInstallProxyAuthHandler\\((${JS_IDENT})\\),await \\1\\.app\\.whenReady\\(\\)\\)` +
    `(?=,${JS_IDENT}\\("main app\\.whenReady resolved")`,
  "g",
);
// Keep the upstream URL/method credentials policy in front of both network
// paths. Matching all of its bindings prevents a nearby unrelated fetch from
// being mistaken for the application network owner.
const FETCH_PREFIX =
  `if\\(null==${JS_IDENT}\\)\\{let (?<options>${JS_IDENT})=\\{method:(?<method>${JS_IDENT}),` +
  `cache:${JS_IDENT},headers:${JS_IDENT},body:${JS_IDENT}\\(\\),redirect:[^,{}]{1,120},signal:${JS_IDENT},` +
  `credentials:(?<cookies>${JS_IDENT})\\?"include":"same-origin"\\};` +
  `\\(${JS_IDENT}\\|\\|!\\k<cookies>&&\\(0,${JS_IDENT}\\.${JS_IDENT}\\)\\((?<url>${JS_IDENT}),\\k<method>\\)\\)&&` +
  `\\(\\k<options>\\.credentials="omit"\\),(?<response>${JS_IDENT})=await `;
const FETCH_PATTERN = new RegExp(
  `${FETCH_PREFIX}this\\.options\\.applicationNetwork\\.fetch\\(\\k<url>,\\k<options>\\)`,
  "g",
);
const PATCHED_FETCH_PATTERN = new RegExp(
  `${FETCH_PREFIX}codexLinuxProxyAuthFetch\\(this,\\k<url>,\\k<options>\\)`,
  "g",
);
const REQUEST_PATTERN = new RegExp(
  `let (?<request>${JS_IDENT})=(?<owner>this\\.options\\.applicationNetwork)\\.request\\(` +
    `\\{method:(?<method>${JS_IDENT}),url:(?<url>${JS_IDENT}),redirect:(?<redirect>[^,{}]{1,120}),` +
    `headers:(?<headers>${JS_IDENT}),useSessionCookies:(?<cookies>${JS_IDENT})\\}\\),` +
    `(?<last>${JS_IDENT})=-1,(?<progressHandler>${JS_IDENT})=\\((?<loaded>${JS_IDENT}),(?<total>${JS_IDENT})\\)=>` +
    `\\{\\k<loaded>!==\\k<last>&&\\(\\k<last>=\\k<loaded>,(?<callback>${JS_IDENT})` +
    `\\(\\{loaded:\\k<loaded>,total:\\k<total>\\}\\)\\)\\};` +
    `\\k<request>\\.on\\("upload-progress",\\k<progressHandler>\\)` ,
  "g",
);
const PATCHED_REQUEST_PATTERN = new RegExp(
  `let (?<request>${JS_IDENT})=this\\.options\\.applicationNetwork\\.request\\(` +
    `\\{method:${JS_IDENT},url:${JS_IDENT},redirect:[^,{}]{1,120},headers:${JS_IDENT},useSessionCookies:${JS_IDENT}\\}\\);` +
    `codexLinuxAttachProxyAuthToRequest\\(\\k<request>\\);let (?<last>${JS_IDENT})=-1,` +
    `(?<progressHandler>${JS_IDENT})=\\((?<loaded>${JS_IDENT}),(?<total>${JS_IDENT})\\)=>` +
    `\\{null!=(?<callback>${JS_IDENT})&&\\k<loaded>!==\\k<last>&&` +
    `\\(\\k<last>=\\k<loaded>,\\k<callback>\\(\\{loaded:\\k<loaded>,total:\\k<total>\\}\\)\\)\\};` +
    `\\k<request>\\.on\\("upload-progress",\\k<progressHandler>\\)`,
  "g",
);

const APP_LOGIN_HELPER =
  "function codexLinuxProxyAuthHost(e){return String(e??``).trim().replace(/^\\[|\\]$/g,``).toLowerCase()}" +
  "function codexLinuxProxyAuthEntry(e=process.env){if(process.platform!==`linux`)return null;let t=codexLinuxProxyAuthHost(e.CODEX_LINUX_PROXY_AUTH_HOST),n=String(e.CODEX_LINUX_PROXY_AUTH_PORT??``).trim(),r=e.CODEX_LINUX_PROXY_USERNAME;if(!t||r==null||String(r).length===0)return null;return{host:t,port:n,username:String(r),password:String(e.CODEX_LINUX_PROXY_PASSWORD??``)}}" +
  "function codexLinuxInstallProxyAuthHandler(e){let t=codexLinuxProxyAuthEntry();if(t==null)return;e.app.on(`login`,(n,r,i,a,o)=>{if(!a?.isProxy)return;let s=codexLinuxProxyAuthHost(a.host),l=String(a.port??``).trim();if(t.host!==s||t.port&&t.port!==l)return;n.preventDefault(),o(t.username,t.password)})}";
const REQUEST_LOGIN_HELPER =
  "function codexLinuxAttachProxyAuthToRequest(e){let t=codexLinuxProxyAuthEntry();if(t==null||e==null)return;e.on(`login`,(n,r)=>{if(!n?.isProxy){r();return}let i=codexLinuxProxyAuthHost(n.host),a=String(n.port??``).trim();if(t.host!==i||t.port&&t.port!==a){r();return}r(t.username,t.password)})}";
// Preserve finalized fetch options such as trace export's redirect:"error"
// when proxy authentication requires ClientRequest, without reading the body twice.
const FETCH_HELPER =
  "function codexLinuxProxyAuthFetch(e,t,n){return codexLinuxProxyAuthEntry()==null?e.options.applicationNetwork.fetch(t,n):e.performProgressRequest({body:n.body,headers:n.headers,method:n.method,onUploadProgress:null,resolvedUrl:t,redirect:n.redirect,signal:n.signal,useSessionCookies:n.credentials===`include`})}";
const HELPER_NEEDLES = [
  "function codexLinuxProxyAuthHost(",
  "function codexLinuxProxyAuthEntry(",
  "function codexLinuxInstallProxyAuthHandler(",
  "function codexLinuxAttachProxyAuthToRequest(",
  "function codexLinuxProxyAuthFetch(",
];

const HELPER_BLOCK = APP_LOGIN_HELPER + REQUEST_LOGIN_HELPER + FETCH_HELPER;
const HELPER_NAMES = HELPER_NEEDLES.map(needle => needle.slice("function ".length, -1));
const OWNED_HELPER_CALLS = new Map([
  ["codexLinuxInstallProxyAuthHandler", 1],
  ["codexLinuxAttachProxyAuthToRequest", 1],
  ["codexLinuxProxyAuthFetch", 1],
]);

function helpersHaveProgramScope(source) {
  const offset = source.indexOf(HELPER_BLOCK);
  if (offset < 0) return false;
  const prefix = source.slice(0, offset);
  // Keep comments/strings and nested braces intact. The lexical declaration
  // probe also rejects a dangling if/loop/label or expression that could turn
  // the first helper into a conditional declaration or function expression.
  if (findMatchingBrace("{" + prefix + "}", 0) !== offset + 1) return false;
  try {
    new Script(prefix + "\nconst __codexLinuxProxyHelperScopeProbe = 0;");
    return true;
  } catch { return false; }
}

function helperReferenceCount(source, name) {
  return [...source.matchAll(new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "g"))].length;
}

function helperReferencesAreOwned(source) {
  const withoutHelpers = source.replace(HELPER_BLOCK, "");
  return HELPER_NAMES.every(name =>
    helperReferenceCount(withoutHelpers, name) === (OWNED_HELPER_CALLS.get(name) ?? 0));
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function applyAuthenticatedProxyPatch(currentSource) {
  const helpers = HELPER_NEEDLES.reduce((total, needle) => total + currentSource.split(needle).length - 1, 0);
  const ready = count(currentSource, READY_PATTERN);
  const patchedReady = count(currentSource, PATCHED_READY_PATTERN);
  if (helpers === 0 && ready === 0 && patchedReady === 0) {
    console.warn(
      "WARN: Could not find Electron app ready point - skipping Linux proxy authentication patch",
    );
    return currentSource;
  }
  if (helpers !== 0 && helpers !== HELPER_NEEDLES.length) {
    console.warn("WARN: Found incomplete Linux proxy authentication helpers - skipping patch");
    return currentSource;
  }

  const fetches = count(currentSource, FETCH_PATTERN);
  const patchedFetches = count(currentSource, PATCHED_FETCH_PATTERN);
  const requests = count(currentSource, REQUEST_PATTERN);
  const patchedRequests = count(currentSource, PATCHED_REQUEST_PATTERN);
  const pristine = helpers === 0 && HELPER_NAMES.every(name => helperReferenceCount(currentSource, name) === 0) && ready === 1 && patchedReady === 0 &&
    fetches === 1 && patchedFetches === 0 && requests === 1 && patchedRequests === 0;
  const complete = helpers === HELPER_NEEDLES.length &&
    helpersHaveProgramScope(currentSource) && helperReferencesAreOwned(currentSource) &&
    ready === 0 && patchedReady === 1 &&
    fetches === 0 && patchedFetches === 1 && requests === 0 && patchedRequests === 1;
  if (complete) return currentSource;
  if (!pristine) {
    console.warn(
      "WARN: Could not identify unique current app ready and applicationNetwork proxy-auth contracts",
    );
    return currentSource;
  }

  let patchedSource = currentSource
    .replace(READY_PATTERN, (match, electron) => `(codexLinuxInstallProxyAuthHandler(${electron}),${match})`)
    .replace(FETCH_PATTERN, (...args) => {
      const groups = args.at(-1);
      const original = args[0];
      return original.slice(0, original.lastIndexOf("this.options.applicationNetwork.fetch(")) +
        `codexLinuxProxyAuthFetch(this,${groups.url},${groups.options})`;
    })
    .replace(REQUEST_PATTERN, (...args) => {
      const groups = args.at(-1);
      return `let ${groups.request}=${groups.owner}.request({method:${groups.method},url:${groups.url},redirect:${groups.redirect},headers:${groups.headers},useSessionCookies:${groups.cookies}});` +
        `codexLinuxAttachProxyAuthToRequest(${groups.request});let ${groups.last}=-1,${groups.progressHandler}=(${groups.loaded},${groups.total})=>` +
        `{null!=${groups.callback}&&${groups.loaded}!==${groups.last}&&(${groups.last}=${groups.loaded},` +
        `${groups.callback}({loaded:${groups.loaded},total:${groups.total}}))};` +
        `${groups.request}.on("upload-progress",${groups.progressHandler})`;
    });

  // Chunk files are CommonJS scripts; function declarations at the top are
  // visible to every module factory in that chunk.
  const strictDirective = '"use strict";';
  const helperInsertionIndex = patchedSource.startsWith(strictDirective) ? strictDirective.length : 0;
  return patchedSource.slice(0, helperInsertionIndex) + APP_LOGIN_HELPER + REQUEST_LOGIN_HELPER + FETCH_HELPER +
    patchedSource.slice(helperInsertionIndex);
}

const descriptors = [
  {
    id: "main-process-proxy-auth",
    phase: "main-bundle",
    order: 125,
    ciPolicy: "optional",
    apply: applyAuthenticatedProxyPatch,
  },
];

module.exports = {
  applyAuthenticatedProxyPatch,
  descriptors,
};
