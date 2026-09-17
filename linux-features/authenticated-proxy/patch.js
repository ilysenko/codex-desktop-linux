"use strict";

const {
  inferModuleAlias,
} = require("../../scripts/patches/lib/minified-js.js");

const JS_IDENT = "[A-Za-z_$][\\w$]*";
const BT = "`";

function applyAuthenticatedProxyPatch(currentSource) {
  const electronVar = inferModuleAlias(currentSource, "electron");
  if (electronVar == null) {
    console.warn(
      "WARN: Could not find Electron alias - skipping Linux proxy authentication patch",
    );
    return currentSource;
  }
  const appLoginHelper =
    "function codexLinuxProxyAuthHost(e){return String(e??``).trim().replace(/^\\[|\\]$/g,``).toLowerCase()}" +
    "function codexLinuxProxyAuthEntry(e=process.env){if(process.platform!==`linux`)return null;let t=codexLinuxProxyAuthHost(e.CODEX_LINUX_PROXY_AUTH_HOST),n=String(e.CODEX_LINUX_PROXY_AUTH_PORT??``).trim(),r=e.CODEX_LINUX_PROXY_USERNAME;if(!t||r==null||String(r).length===0)return null;return{host:t,port:n,username:String(r),password:String(e.CODEX_LINUX_PROXY_PASSWORD??``)}}" +
    "function codexLinuxInstallProxyAuthHandler(e){let t=codexLinuxProxyAuthEntry();if(t==null)return;e.app.on(`login`,(n,r,i,a,o)=>{if(!a?.isProxy)return;let s=codexLinuxProxyAuthHost(a.host),l=String(a.port??``).trim();if(t.host!==s||t.port&&t.port!==l)return;n.preventDefault(),o(t.username,t.password)})}";
  const requestLoginHelper =
    "function codexLinuxAttachProxyAuthToRequest(e){let t=codexLinuxProxyAuthEntry();if(t==null||e==null)return;e.on(`login`,(n,r)=>{if(!n?.isProxy){r();return}let i=codexLinuxProxyAuthHost(n.host),a=String(n.port??``).trim();if(t.host!==i||t.port&&t.port!==a){r();return}r(t.username,t.password)})}";
  const installHandlerNeedle = "function codexLinuxInstallProxyAuthHandler(";
  let patchedSource = currentSource;

  if (!patchedSource.includes(installHandlerNeedle)) {
    const whenReadyNeedle = `await ${electronVar}.app.whenReady()`;
    if (!patchedSource.includes(whenReadyNeedle)) {
      if (patchedSource.includes(".app.whenReady()")) {
        console.warn(
          "WARN: Could not find Electron app ready point - skipping Linux proxy authentication patch",
        );
      }
      return patchedSource;
    }

    const strictDirective = '"use strict";';
    const helperInsertionIndex = patchedSource.startsWith(strictDirective)
      ? strictDirective.length
      : 0;
    patchedSource =
      patchedSource.slice(0, helperInsertionIndex) +
      appLoginHelper +
      requestLoginHelper +
      patchedSource.slice(helperInsertionIndex);

    patchedSource = patchedSource.replace(
      whenReadyNeedle,
      `codexLinuxInstallProxyAuthHandler(${electronVar});${whenReadyNeedle}`,
    );
  } else if (!patchedSource.includes("function codexLinuxAttachProxyAuthToRequest(")) {
    console.warn(
      "WARN: Found incomplete Linux proxy authentication helpers - skipping patch",
    );
    return patchedSource;
  }

  const currentFetchGate = new RegExp(
    `if\\((${JS_IDENT})==null\\)(?=\\{let ${JS_IDENT}=\\{method:${JS_IDENT},headers:${JS_IDENT},` +
      `body:${JS_IDENT}\\(\\),redirect:[^,{}]{1,120},signal:${JS_IDENT},credentials:${JS_IDENT}\\?` +
      `${BT}include${BT}:${BT}same-origin${BT}\\};${JS_IDENT}=await ` +
      `this\\.options\\.applicationNetwork\\.fetch\\()`,
    "g",
  );
  const patchedCurrentFetchGate = new RegExp(
    `if\\((${JS_IDENT})==null&&!codexLinuxProxyAuthEntry\\(\\)\\)(?=\\{let ${JS_IDENT}=\\{method:${JS_IDENT},` +
      `headers:${JS_IDENT},body:${JS_IDENT}\\(\\),redirect:[^,{}]{1,120},signal:${JS_IDENT},credentials:${JS_IDENT}\\?` +
      `${BT}include${BT}:${BT}same-origin${BT}\\};${JS_IDENT}=await this\\.options\\.applicationNetwork\\.fetch\\()`,
    "g",
  );
  const currentRequestPattern = new RegExp(
    `let (?<request>${JS_IDENT})=(?<owner>this\\.options\\.applicationNetwork)\\.request\\(` +
      `\\{method:(?<method>${JS_IDENT}),url:(?<url>${JS_IDENT}),redirect:(?<redirect>[^,{}]{1,120}),` +
      `headers:(?<headers>${JS_IDENT}),useSessionCookies:(?<cookies>${JS_IDENT})\\}\\),` +
      `(?<last>${JS_IDENT})=-1,(?<poll>${JS_IDENT})=\\(\\)=>\\{let (?<progress>${JS_IDENT})=` +
      `\\k<request>\\.getUploadProgress\\(\\);\\k<progress>\\.started&&` +
      `\\k<progress>\\.current!==\\k<last>&&\\(\\k<last>=\\k<progress>\\.current,` +
      `(?<callback>${JS_IDENT})\\(\\{loaded:\\k<progress>\\.current,total:\\k<progress>\\.total\\}\\)\\)\\}`,
    "g",
  );
  const patchedRequestPattern = new RegExp(
    `let (?<request>${JS_IDENT})=this\\.options\\.applicationNetwork\\.request\\(` +
      `\\{method:${JS_IDENT},url:${JS_IDENT},redirect:[^,{}]{1,120},headers:${JS_IDENT},useSessionCookies:${JS_IDENT}\\}\\);` +
      `codexLinuxAttachProxyAuthToRequest\\(\\k<request>\\);let (?<last>${JS_IDENT})=-1,(?<poll>${JS_IDENT})=\\(\\)=>` +
      `\\{if\\((?<callback>${JS_IDENT})==null\\)return;let (?<progress>${JS_IDENT})=\\k<request>\\.getUploadProgress\\(\\);` +
      `!\\k<progress>\\.started\\|\\|\\k<progress>\\.current===\\k<last>\\|\\|` +
      `\\(\\k<last>=\\k<progress>\\.current,\\k<callback>\\(\\{loaded:\\k<progress>\\.current,` +
      `total:\\k<progress>\\.total\\}\\)\\)\\}`,
    "g",
  );
  const hasFetchSurface = patchedSource.includes(".applicationNetwork.fetch(") &&
    patchedSource.includes("performProgressRequest");
  if (hasFetchSurface) {
    const currentFetches = [...patchedSource.matchAll(currentFetchGate)];
    const patchedFetches = [...patchedSource.matchAll(patchedCurrentFetchGate)];
    const currentRequests = [...patchedSource.matchAll(currentRequestPattern)];
    const patchedRequests = [...patchedSource.matchAll(patchedRequestPattern)];
    const pristine = currentFetches.length === 1 && patchedFetches.length === 0 &&
      currentRequests.length === 1 && patchedRequests.length === 0;
    const complete = currentFetches.length === 0 && patchedFetches.length === 1 &&
      currentRequests.length === 0 && patchedRequests.length === 1;
    if (!pristine && !complete) {
      console.warn("WARN: Could not identify unique current applicationNetwork proxy-auth contracts");
      return currentSource;
    }
    if (complete) return patchedSource;

    patchedSource = patchedSource.replace(
      currentFetchGate,
      (_match, progressVar) => `if(${progressVar}==null&&!codexLinuxProxyAuthEntry())`,
    );
    patchedSource = patchedSource.replace(currentRequestPattern, (...args) => {
      const groups = args.at(-1);
      return `let ${groups.request}=${groups.owner}.request({method:${groups.method},url:${groups.url},redirect:${groups.redirect},headers:${groups.headers},useSessionCookies:${groups.cookies}});` +
        `codexLinuxAttachProxyAuthToRequest(${groups.request});let ${groups.last}=-1,${groups.poll}=()=>{if(${groups.callback}==null)return;` +
        `let ${groups.progress}=${groups.request}.getUploadProgress();!${groups.progress}.started||${groups.progress}.current===${groups.last}||` +
        `(${groups.last}=${groups.progress}.current,${groups.callback}({loaded:${groups.progress}.current,total:${groups.progress}.total}))}`;
    });
  }

  return patchedSource;
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
