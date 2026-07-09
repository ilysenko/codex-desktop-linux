"use strict";

const {
  inferModuleAlias,
} = require("../../scripts/patches/lib/minified-js.js");

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
    "function codexLinuxInstallProxyAuthHandler(e){let t=codexLinuxProxyAuthEntry();if(t==null)return;e.app.on(`login`,(n,r,i,a,o)=>{if(!a?.isProxy)return;let s=codexLinuxProxyAuthHost(a.host),l=String(a.port??``).trim();if(t.host!==s||t.port&&l&&t.port!==l)return;n.preventDefault(),o(t.username,t.password)})}";
  const requestLoginHelper =
    "function codexLinuxAttachProxyAuthToRequest(e){let t=codexLinuxProxyAuthEntry();if(t==null||e==null)return;e.on(`login`,(n,r)=>{if(!n?.isProxy){r();return}let i=codexLinuxProxyAuthHost(n.host),a=String(n.port??``).trim();if(t.host!==i||t.port&&a&&t.port!==a){r();return}r(t.username,t.password)})}";
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
    const insertAfterAppLoginHelper =
      "function codexLinuxInstallProxyAuthHandler(e){let t=codexLinuxProxyAuthEntry();if(t==null)return;e.app.on(`login`,(n,r,i,a,o)=>{if(!a?.isProxy)return;let s=codexLinuxProxyAuthHost(a.host),l=String(a.port??``).trim();if(t.host!==s||t.port&&l&&t.port!==l)return;n.preventDefault(),o(t.username,t.password)})}";
    const legacyInlineHostAppLoginHelper =
      "function codexLinuxProxyAuthEntry(e=process.env){if(process.platform!==`linux`)return null;let t=String(e.CODEX_LINUX_PROXY_AUTH_HOST??``).trim().replace(/^\\[|\\]$/g,``).toLowerCase(),n=String(e.CODEX_LINUX_PROXY_AUTH_PORT??``).trim(),r=e.CODEX_LINUX_PROXY_USERNAME;if(!t||r==null||String(r).length===0)return null;return{host:t,port:n,username:String(r),password:String(e.CODEX_LINUX_PROXY_PASSWORD??``)}}function codexLinuxInstallProxyAuthHandler(e){let t=codexLinuxProxyAuthEntry();if(t==null)return;e.app.on(`login`,(n,r,i,a,o)=>{if(!a?.isProxy)return;let s=String(a.host??``).replace(/^\\[|\\]$/g,``).toLowerCase();if(t.host!==s||t.port&&String(a.port??``)!==t.port)return;n.preventDefault(),o(t.username,t.password)})}";
    if (patchedSource.includes(legacyInlineHostAppLoginHelper)) {
      patchedSource = patchedSource.replace(
        legacyInlineHostAppLoginHelper,
        appLoginHelper + requestLoginHelper,
      );
    } else if (patchedSource.includes(insertAfterAppLoginHelper)) {
      patchedSource = patchedSource.replace(
        insertAfterAppLoginHelper,
        insertAfterAppLoginHelper + requestLoginHelper,
      );
    } else {
      console.warn(
        "WARN: Could not extend existing Linux proxy authentication helper with ClientRequest support",
      );
    }
  }

  const fetchNeedle =
    `let d=i==null?await ${electronVar}.net.fetch(o,{method:r,headers:t,body:p(),signal:s,credentials:c?\`include\`:\`same-origin\`}):await this.performProgressRequest({body:p(),headers:t,method:r,onUploadProgress:i,resolvedUrl:o,signal:s,useSessionCookies:c});`;
  const fetchReplacement =
    `let d=i==null&&!codexLinuxProxyAuthEntry()?await ${electronVar}.net.fetch(o,{method:r,headers:t,body:p(),signal:s,credentials:c?\`include\`:\`same-origin\`}):await this.performProgressRequest({body:p(),headers:t,method:r,onUploadProgress:i,resolvedUrl:o,signal:s,useSessionCookies:c});`;
  if (patchedSource.includes(fetchNeedle)) {
    patchedSource = patchedSource.replace(fetchNeedle, fetchReplacement);
  } else if (
    patchedSource.includes("performDesktopFetch") &&
    !patchedSource.includes("!codexLinuxProxyAuthEntry()?await")
  ) {
    console.warn(
      "WARN: Could not route Linux proxy-auth desktop fetches through ClientRequest",
    );
  }

  const requestNeedle =
    `let u=${electronVar}.net.request({method:n,url:i,headers:t,useSessionCookies:s}),d=-1,f=()=>{let e=u.getUploadProgress();!e.started||e.current===d||(d=e.current,r({loaded:e.current,total:e.total}))}`;
  const requestReplacement =
    `let u=${electronVar}.net.request({method:n,url:i,headers:t,useSessionCookies:s});codexLinuxAttachProxyAuthToRequest(u);let d=-1,f=()=>{if(r==null)return;let e=u.getUploadProgress();!e.started||e.current===d||(d=e.current,r({loaded:e.current,total:e.total}))}`;
  if (patchedSource.includes(requestNeedle)) {
    patchedSource = patchedSource.replace(requestNeedle, requestReplacement);
  } else if (
    patchedSource.includes("performProgressRequest") &&
    !patchedSource.includes("codexLinuxAttachProxyAuthToRequest(")
  ) {
    console.warn(
      "WARN: Could not attach Linux proxy authentication to ClientRequest fetch path",
    );
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
