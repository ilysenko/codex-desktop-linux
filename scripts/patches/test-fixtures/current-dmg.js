"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function electron42BrowserUseRuntimeResolverBundleFixture() {
  return [
    "let s=require(`node:path`),l=require(`node:fs`);",
    "function tt({resourcesPath:e}){return e}",
    "function Kn(e){return e===`linux`?`/primary/node`:null}",
    "function Hn({env:e=process.env,isPackaged:n=!0,platform:r=process.platform,repoRoot:i=process.cwd(),resolveCodexPath:a=t.Wn,resolveNodePath:o=t.Gn,resolveNodeReplPath:s=t.Kn,resolvePrimaryRuntimeNodePath:c=Kn,resourcesPath:l}){let u=l??tt({env:e,resourcesPath:process.resourcesPath}),d=c(r),f=Gn({platform:r,rawValue:e.CODEX_CLI_PATH,resolveWindowsAppsPath:a})??Wn({devRelativePathSegments:[`extension`,`bin`,`codex`],isPackaged:n,platform:r,repoRoot:i,resolveBundledPath:a,resourcesPath:u}),p=Wn({devRelativePathSegments:null,isPackaged:n,platform:r,repoRoot:i,resolveBundledPath:o,resourcesPath:u}),m=Gn({platform:r,rawValue:e.CODEX_BROWSER_USE_NODE_PATH,resolveWindowsAppsPath:o})??(p.path==null&&d!=null?{path:d,source:`primary-runtime`}:p),h=Gn({platform:r,rawValue:e.CODEX_NODE_REPL_PATH,resolveWindowsAppsPath:s})??Wn({devRelativePathSegments:null,isPackaged:n,platform:r,repoRoot:i,resolveBundledPath:s,resourcesPath:u});return{codexCliPath:f.path,codexCliPathSource:f.source,nodeModuleDirs:t.Vn(u),nodePath:m.path,nodePathSource:m.source,nodeReplPath:h.path,nodeReplPathSource:h.source,platform:r}}",
    "function Wn(e){return{path:null,source:`missing`}}function Gn({rawValue:e}){return e==null?null:{path:e,source:`env-override`}}",
  ].join("");
}

function currentChromePluginAppServerSourceBundleFixture() {
  return [
    "let i=require(`node:path`),c=require(`node:fs`);",
    "var _G=`com.openai.codexextension`,gG=`.plugin-appserver`;",
    "async function TG(e){let t=e.nativeHostName===_G;return t?`isolated:${e.codexCliPath}`:e.codexCliPath}",
    "async function vq(e){let t=yq(e),n=GN(e.resourcesPath),r=WN(e.resourcesPath),i=[t==null?`codex`:null,n==null?`node`:null,r==null?`node_repl`:null].filter(e=>e!=null);if(i.length>0)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}: ${i.join(`, `)} (resourcesPath: ${e.resourcesPath}).`);if(t==null||n==null||r==null)throw Error(`Missing bundled Electron runtime required to sync Chrome native host resources for ${e.nativeHostName}.`);return{codexCliPath:await TG({codexCliPath:t,codexHome:e.codexHome,nativeHostName:e.nativeHostName}),nodePath:n,nodeModuleDirs:KN(e.resourcesPath),nodeReplPath:r}}",
    "async function UK(e){let t=yq(e);if(t==null)throw Error(`Missing bundled Electron Codex runtime required to sync Chrome plugin app server for ${e.nativeHostName} (resourcesPath: ${e.resourcesPath??`<none>`}).`);return TG({codexCliPath:t,codexHome:e.codexHome,nativeHostName:e.nativeHostName})}",
    "function yq(e){return null}function GN(e){return null}function WN(e){return null}function KN(e){return []}",
  ].join("");
}

function createCurrentChromeNativeHostRuntimeAssetsFixture() {
  const extractedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-current-chrome-runtime-assets-"),
  );
  const buildDir = path.join(extractedDir, ".vite", "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const mainPath = path.join(buildDir, "main-current.js");
  const srcPath = path.join(buildDir, "src-current.js");
  fs.writeFileSync(
    mainPath,
    electron42BrowserUseRuntimeResolverBundleFixture(),
    "utf8",
  );
  fs.writeFileSync(
    srcPath,
    currentChromePluginAppServerSourceBundleFixture(),
    "utf8",
  );
  return { extractedDir, mainPath, srcPath };
}

function settingsSharedBundleFixture() {
  return [
    '"general-settings":{id:`settings.nav.general-settings`,defaultMessage:`General`,description:`Title for general settings section`},appearance:{id:`settings.nav.appearance`,defaultMessage:`Appearance`,description:`Title for appearance settings section`},',
    "function titleForSection(e){switch(e){case`general-settings`:{let e;return t[2]===Symbol.for(`react.memo_cache_sentinel`)?(e=(0,d.jsx)(n,{id:`settings.section.general-settings`,defaultMessage:`General`,description:`Title for general settings section`}),t[2]=e):e=t[2],e}case`appearance`:return (0,d.jsx)(n,{id:`settings.section.appearance`,defaultMessage:`Appearance`,description:`Title for appearance settings section`})}}",
  ].join("");
}

function createModernNativeKeyboardShortcutsSettingsFixture() {
  const extractedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-modern-native-shortcuts-"),
  );
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const writeAsset = (name, source = "") => {
    fs.writeFileSync(path.join(assetsDir, name), source, "utf8");
  };

  writeAsset(
    "rolldown-runtime-A.js",
    "function n(e){return e}function s(e){return e}export{n,s};",
  );
  writeAsset(
    "shared-runtime-A.js",
    'import{s as s}from"./rolldown-runtime-A.js";function jsxFactory(){return{jsx(){},jsxs(){},Fragment:"Fragment"}}function reactFactory(){return{useState(){},useCallback(){},useEffect(){}}}function memoCache(){}export{jsxFactory as I,memoCache as L,reactFactory as R};',
  );
  writeAsset(
    "setting-storage-A.js",
    'async function requestCodex(...args){let[request]=args,{params:params,source:source}=request;return send("vscode://codex/",params)}export{requestCodex as z};',
  );
  writeAsset(
    "toggle-A.js",
    'function t({checked,disabled,onChange,ariaLabel}){return {role:"switch","aria-checked":checked,"aria-label":ariaLabel,disabled,onClick:()=>onChange(!checked)}}export{t};',
  );
  writeAsset(
    "settings-row-A.js",
    "function a(e){let{label:t,description:n,control:r}=e;return null}export{a as r};",
  );
  writeAsset("settings-content-layout-A.js", "export{n,r,t};");
  writeAsset("settings-group-A.js", "export{n,t};");
  writeAsset("settings-surface-A.js", "export{t};");
  writeAsset(
    "keyboard-shortcuts-settings-A.js",
    [
      'import{n as __module,s as __toESM}from"./rolldown-runtime-A.js";',
      'import{I as __jsxFactory,L as __memoCache,R as __reactFactory}from"./shared-runtime-A.js";',
      "function KeyboardShortcutsSettings(){let t=(0,React.useState)(null);return (0,$.jsx)(`div`,{children:t})}",
      "var React,$;__module(()=>{React=__toESM(__reactFactory(),1),$=__jsxFactory()})();",
      "slug:`keyboard-shortcuts`;export{KeyboardShortcutsSettings};",
    ].join(""),
  );
  writeAsset(
    "app-initial-BTphDPeq.js",
    [
      'import{n as routeModule,s as routeToESM}from"./rolldown-runtime-A.js";',
      'import{I as routeJsxFactory,R as routeReactFactory}from"./shared-runtime-A.js";',
      "function DecoyState(){let t=(0,DecoyReact.useState)(null);return t}",
      "function DecoyView(){return (0,DecoyJsx.jsx)(`div`,{})}",
      "var DecoyReact,DecoyJsx;routeModule(()=>{DecoyReact=routeToESM(routeReactFactory(),1)});routeModule(()=>{DecoyJsx=routeJsxFactory()})();",
      "function Ya(e){let r=(0,RouteReact.lazy)(e);function SettingsRouteWrapper(){let t=(0,RouteReact.useState)(null);return (0,RouteJsx.jsx)(r,{children:t})}return SettingsRouteWrapper}",
      "var RouteReact,RouteJsx;routeModule(()=>{RouteReact=routeToESM(routeReactFactory(),1),RouteJsx=routeJsxFactory()})();",
      'var Zn={"general-settings":Ya(async()=>(await Pr(async()=>{let{GeneralSettings:e}=await import(`./general-settings-A.js`);return{GeneralSettings:e}},[],import.meta.url)).GeneralSettings),"keyboard-shortcuts":Ya(async()=>(await Pr(async()=>{let{KeyboardShortcutsSettings:e}=await import(`./keyboard-shortcuts-settings-A.js`);return{KeyboardShortcutsSettings:e}},[],import.meta.url)).KeyboardShortcutsSettings)};',
      "var Wn=[`general-settings`,`import`,`profile`,`keyboard-shortcuts`];",
      "var Qn=[{key:`app`,slugs:[`general-settings`,`import`,`profile`,`keyboard-shortcuts`]}];",
      "function loading(H){let W=!1;if(H)bb0:switch(H.slug){case`appearance`:case`general-settings`:case`agent`:case`git-settings`:case`data-controls`:case`personalization`:W=!1;break bb0;case`keyboard-shortcuts`:W=!1;break bb0}return W}",
      "export{SettingsRouteWrapper};",
    ].join(""),
  );
  writeAsset(
    "settings-page-A.js",
    [
      "var nn=`general-settings.import.profile.appearance.voice.agent.personalization.pets.keyboard-shortcuts.usage.debug`.split(`.`),",
      "rn=[{key:`personal`,heading:d({id:`settings.nav.heading.personal`,defaultMessage:`Personal`,description:`Heading for personal settings in the settings navigation`}),",
      "slugs:[`general-settings`,`import`,`profile`,`appearance`,`voice`,`agent`,`personalization`,`pets`,`keyboard-shortcuts`,`usage`,`debug`]}];",
    ].join(""),
  );
  writeAsset(
    "use-visible-settings-sections-A.js",
    [
      'var Hn={"general-settings":wt,import:it,profile:pt,"keyboard-shortcuts":xn};',
      "function visible(e){switch(e.slug){case`profile`:return y;case`general-settings`:case`agent`:case`personalization`:return!0;case`keyboard-shortcuts`:return!0}}",
      "export{Hn};",
    ].join(""),
  );
  writeAsset(
    "app-initial~app-main~page~remote-conversation-page~new-thread-panel-page~settings-page~shared-A.js",
    settingsSharedBundleFixture(),
  );
  writeAsset(
    "app-initial~app-main~remote-conversation-page~settings-page~hotkey-window-thread-page~mcp-s-A.js",
    [
      "var c,l=e((()=>{c=`general-settings.import.profile.keyboard-shortcuts.codex-micro.appshots.appearance.pets.agent.git-settings.data-controls.cloud-settings.cloud-environments.code-review.personalization.usage.browser-use.computer-use.local-environments.worktrees.environments.mcp-settings.hooks-settings.connections.plugins-settings.skills-settings`.split(`.`)})),u,d,f,p=e((()=>{",
      "l(),u=`general-settings`,d=function(e){return e.String=`string`,e.Array=`array`,e.Record=`record`,e}({}),",
      "f=[{slug:`general-settings`},{slug:`import`},{slug:`profile`},{slug:`appearance`},{slug:`pets`},{slug:`appshots`},{slug:`git-settings`},{slug:`connections`},{slug:`cloud-settings`},{slug:`cloud-environments`},{slug:`code-review`},{slug:`local-environments`},{slug:`worktrees`},{slug:`agent`},{slug:`personalization`},{slug:`keyboard-shortcuts`},{slug:`usage`},{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`},{slug:`hooks-settings`},{slug:`plugins-settings`},{slug:`skills-settings`},{slug:`data-controls`}]",
      "}));",
    ].join(""),
  );

  return { extractedDir, assetsDir };
}

module.exports = {
  createCurrentChromeNativeHostRuntimeAssetsFixture,
  createModernNativeKeyboardShortcutsSettingsFixture,
  currentChromePluginAppServerSourceBundleFixture,
  electron42BrowserUseRuntimeResolverBundleFixture,
  settingsSharedBundleFixture,
};
