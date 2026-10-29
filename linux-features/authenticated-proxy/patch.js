"use strict";

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
const FETCH_TAIL =
  `\\{let ${JS_IDENT}=\\{method:${JS_IDENT},headers:${JS_IDENT},body:${JS_IDENT}\\(\\),` +
  `redirect:[^,{}]{1,120},signal:${JS_IDENT},credentials:${JS_IDENT}\\?"include":"same-origin"\\};` +
  `${JS_IDENT}=await this\\.options\\.applicationNetwork\\.fetch\\(`;
const FETCH_GATE = new RegExp(`if\\(null==(${JS_IDENT})\\)(?=${FETCH_TAIL})`, "g");
const PATCHED_FETCH_GATE = new RegExp(
  `if\\(null==(${JS_IDENT})&&!codexLinuxProxyAuthEntry\\(\\)\\)(?=${FETCH_TAIL})`,
  "g",
);
const REQUEST_PATTERN = new RegExp(
  `let (?<request>${JS_IDENT})=(?<owner>this\\.options\\.applicationNetwork)\\.request\\(` +
    `\\{method:(?<method>${JS_IDENT}),url:(?<url>${JS_IDENT}),redirect:(?<redirect>[^,{}]{1,120}),` +
    `headers:(?<headers>${JS_IDENT}),useSessionCookies:(?<cookies>${JS_IDENT})\\}\\),` +
    `(?<last>${JS_IDENT})=-1,(?<poll>${JS_IDENT})=\\(\\)=>\\{let (?<progress>${JS_IDENT})=` +
    `\\k<request>\\.getUploadProgress\\(\\);\\k<progress>\\.started&&` +
    `\\k<progress>\\.current!==\\k<last>&&\\(\\k<last>=\\k<progress>\\.current,` +
    `(?<callback>${JS_IDENT})\\(\\{loaded:\\k<progress>\\.current,total:\\k<progress>\\.total\\}\\)\\)\\}`,
  "g",
);
const PATCHED_REQUEST_PATTERN = new RegExp(
  `let (?<request>${JS_IDENT})=this\\.options\\.applicationNetwork\\.request\\(` +
    `\\{method:${JS_IDENT},url:${JS_IDENT},redirect:[^,{}]{1,120},headers:${JS_IDENT},useSessionCookies:${JS_IDENT}\\}\\);` +
    `codexLinuxAttachProxyAuthToRequest\\(\\k<request>\\);let (?<last>${JS_IDENT})=-1,(?<poll>${JS_IDENT})=\\(\\)=>` +
    `\\{if\\((?<callback>${JS_IDENT})==null\\)return;let (?<progress>${JS_IDENT})=\\k<request>\\.getUploadProgress\\(\\);` +
    `!\\k<progress>\\.started\\|\\|\\k<progress>\\.current===\\k<last>\\|\\|` +
    `\\(\\k<last>=\\k<progress>\\.current,\\k<callback>\\(\\{loaded:\\k<progress>\\.current,` +
    `total:\\k<progress>\\.total\\}\\)\\)\\}`,
  "g",
);

const APP_LOGIN_HELPER =
  "function codexLinuxProxyAuthHost(e){return String(e??``).trim().replace(/^\\[|\\]$/g,``).toLowerCase()}" +
  "function codexLinuxProxyAuthEntry(e=process.env){if(process.platform!==`linux`)return null;let t=codexLinuxProxyAuthHost(e.CODEX_LINUX_PROXY_AUTH_HOST),n=String(e.CODEX_LINUX_PROXY_AUTH_PORT??``).trim(),r=e.CODEX_LINUX_PROXY_USERNAME;if(!t||r==null||String(r).length===0)return null;return{host:t,port:n,username:String(r),password:String(e.CODEX_LINUX_PROXY_PASSWORD??``)}}" +
  "function codexLinuxInstallProxyAuthHandler(e){let t=codexLinuxProxyAuthEntry();if(t==null)return;e.app.on(`login`,(n,r,i,a,o)=>{if(!a?.isProxy)return;let s=codexLinuxProxyAuthHost(a.host),l=String(a.port??``).trim();if(t.host!==s||t.port&&t.port!==l)return;n.preventDefault(),o(t.username,t.password)})}";
const REQUEST_LOGIN_HELPER =
  "function codexLinuxAttachProxyAuthToRequest(e){let t=codexLinuxProxyAuthEntry();if(t==null||e==null)return;e.on(`login`,(n,r)=>{if(!n?.isProxy){r();return}let i=codexLinuxProxyAuthHost(n.host),a=String(n.port??``).trim();if(t.host!==i||t.port&&t.port!==a){r();return}r(t.username,t.password)})}";
const HELPER_NEEDLES = [
  "function codexLinuxProxyAuthHost(",
  "function codexLinuxProxyAuthEntry(",
  "function codexLinuxInstallProxyAuthHandler(",
  "function codexLinuxAttachProxyAuthToRequest(",
];

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function applyAuthenticatedProxyPatch(currentSource) {
  const helpers = HELPER_NEEDLES.filter((needle) => currentSource.includes(needle)).length;
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

  const fetches = count(currentSource, FETCH_GATE);
  const patchedFetches = count(currentSource, PATCHED_FETCH_GATE);
  const requests = count(currentSource, REQUEST_PATTERN);
  const patchedRequests = count(currentSource, PATCHED_REQUEST_PATTERN);
  const pristine = helpers === 0 && ready === 1 && patchedReady === 0 &&
    fetches === 1 && patchedFetches === 0 && requests === 1 && patchedRequests === 0;
  const complete = helpers === HELPER_NEEDLES.length && ready === 0 && patchedReady === 1 &&
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
    .replace(FETCH_GATE, (_match, progressVar) => `if(null==${progressVar}&&!codexLinuxProxyAuthEntry())`)
    .replace(REQUEST_PATTERN, (...args) => {
      const groups = args.at(-1);
      return `let ${groups.request}=${groups.owner}.request({method:${groups.method},url:${groups.url},redirect:${groups.redirect},headers:${groups.headers},useSessionCookies:${groups.cookies}});` +
        `codexLinuxAttachProxyAuthToRequest(${groups.request});let ${groups.last}=-1,${groups.poll}=()=>{if(${groups.callback}==null)return;` +
        `let ${groups.progress}=${groups.request}.getUploadProgress();!${groups.progress}.started||${groups.progress}.current===${groups.last}||` +
        `(${groups.last}=${groups.progress}.current,${groups.callback}({loaded:${groups.progress}.current,total:${groups.progress}.total}))}`;
    });

  // Chunk files are CommonJS scripts; function declarations at the top are
  // visible to every module factory in that chunk.
  const strictDirective = '"use strict";';
  const helperInsertionIndex = patchedSource.startsWith(strictDirective) ? strictDirective.length : 0;
  return patchedSource.slice(0, helperInsertionIndex) + APP_LOGIN_HELPER + REQUEST_LOGIN_HELPER +
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
