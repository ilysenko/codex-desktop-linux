"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { linuxSettingsKeys, requireName } = require("../../scripts/patches/shared.js");

const HANDLER_NAME = "codex-linux-wrapper-updater";
const RUNTIME_VERSION = "codex-wrapper-updater-v3";
const KEYBINDS_ASSET = "keybinds-settings-linux.js";
const LINUX_DESKTOP_SETTINGS_ASSET = "linux-desktop-settings-linux.js";
const WRAPPER_UPDATES_SETTING_KEY = linuxSettingsKeys.wrapperUpdates;
const FEATURE_PICKER_ON_UPDATE_SETTING_KEY = linuxSettingsKeys.featurePickerOnUpdate;

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyMainBundlePatch(source) {
  if (source.includes(`"${HANDLER_NAME}":async`)) {
    return source;
  }

  const fsVar = requireName(source, "node:fs");
  const pathVar = requireName(source, "node:path");
  const childProcessVar =
    requireName(source, "node:child_process") ?? requireName(source, "child_process");
  if (fsVar == null || pathVar == null || childProcessVar == null) {
    warn(
      "Could not find node:fs/node:path/node:child_process deps",
      "codex wrapper updater main-bundle patch",
    );
    return source;
  }

  const helper = [
    `function codexLinuxWrapHome(){return process.env.HOME||\`\`}`,
    `function codexLinuxWrapAppId(){let i=process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||\`codex-desktop\`;return /^[A-Za-z0-9._-]+$/.test(i)?i:\`codex-desktop\`}`,
    `function codexLinuxWrapAppStateDir(){let e=process.env.CODEX_LINUX_APP_STATE_DIR;if(typeof e===\`string\`&&e.trim())return e;let h=codexLinuxWrapHome();let r=process.env.XDG_STATE_HOME||(h&&${pathVar}.join(h,\`.local\`,\`state\`));return r?${pathVar}.join(r,codexLinuxWrapAppId()):null}`,
    `function codexLinuxWrapStatePath(){let h=codexLinuxWrapHome();let d=process.env.XDG_STATE_HOME||(h&&${pathVar}.join(h,\`.local\`,\`state\`));return d?${pathVar}.join(d,\`codex-update-manager\`,\`state.json\`):null}`,
    `function codexLinuxWrapMarkerPath(){let d=codexLinuxWrapAppStateDir();return d?${pathVar}.join(d,\`codex-wrapper-updater\`,\`pending\`):null}`,
    `function codexLinuxWrapReadStatus(){try{let p=codexLinuxWrapStatePath();if(!p||!${fsVar}.existsSync(p))return null;return JSON.parse(${fsVar}.readFileSync(p,\`utf8\`))}catch{return null}}`,
    `function codexLinuxWrapShouldShow(s){return !!(s&&typeof s===\`object\`&&s.wrapper_dev_mode!==!0&&typeof s.candidate_wrapper_commit===\`string\`&&s.candidate_wrapper_commit.length>0)}`,
    `function codexLinuxWrapStatusPayload(){let s=codexLinuxWrapReadStatus();return{ok:!0,show:codexLinuxWrapShouldShow(s),dev_mode:!!(s&&s.wrapper_dev_mode===!0),changelog:s?s.wrapper_changelog||\`\`:\`\`,commit:s?s.candidate_wrapper_commit||\`\`:\`\`,installed_commit:s?s.installed_wrapper_commit||\`\`:\`\`}}`,
    `function codexLinuxWrapManagerPath(){let e=process.env.CODEX_UPDATE_MANAGER_PATH;return typeof e===\`string\`&&e.trim().length>0?e:\`codex-update-manager\`}`,
    `function codexLinuxWrapSpawnCheck(){try{let c=${childProcessVar}.spawn(codexLinuxWrapManagerPath(),[\`check-wrapper\`],{stdio:\`ignore\`,detached:!0,env:process.env});c.on(\`error\`,()=>{});c.unref()}catch{}}`,
    // Feature picker on update: resolve settings.json the same way the launcher
    // and launch-actions do, and gate the on-click picker on the
    // `codex-linux-feature-picker-on-update` toggle (absent ⇒ ask) plus a live
    // display. The picker runs synchronously here, at click time, because the
    // detached apply runs after the app exits with no display.
    `function codexLinuxWrapSettingsAppId(){let e=process.env.CODEX_LINUX_APP_ID||process.env.CODEX_APP_ID||\`codex-desktop\`;return/^[A-Za-z0-9._-]+$/.test(e)?e:\`codex-desktop\`}`,
    `function codexLinuxWrapSettingsPath(){let e=process.env.CODEX_LINUX_SETTINGS_FILE;if(typeof e===\`string\`&&e.length>0)return e;let h=codexLinuxWrapHome();let t=process.env.XDG_CONFIG_HOME||(h&&${pathVar}.join(h,\`.config\`));return t?${pathVar}.join(t,codexLinuxWrapSettingsAppId(),\`settings.json\`):null}`,
    `function codexLinuxWrapPickerEnabled(){try{let p=codexLinuxWrapSettingsPath();if(!p||!${fsVar}.existsSync(p))return!0;let s=JSON.parse(${fsVar}.readFileSync(p,\`utf8\`));if(!s||typeof s!==\`object\`)return!0;let v=s[\`codex-linux-feature-picker-on-update\`];if(v==null)return!0;if(typeof v===\`boolean\`)return v;if(typeof v===\`number\`)return v!==0;if(typeof v===\`string\`){let n=v.trim().toLowerCase();return!([\`0\`,\`false\`,\`no\`,\`off\`].includes(n))}return!0}catch{return!0}}`,
    `function codexLinuxWrapHasDisplay(){let d=process.env.DISPLAY,w=process.env.WAYLAND_DISPLAY;return!!((d&&d.trim())||(w&&w.trim()))}`,
    `function codexLinuxWrapRunPicker(){try{${childProcessVar}.spawnSync(codexLinuxWrapManagerPath(),[\`pick-features\`,\`--json\`],{stdio:\`ignore\`,env:process.env})}catch{}}`,
    `function codexLinuxWrapWriteMarker(){let p=codexLinuxWrapMarkerPath();if(!p)return{ok:!1,reason:\`no-marker-path\`};try{${fsVar}.mkdirSync(${pathVar}.dirname(p),{recursive:!0});${fsVar}.writeFileSync(p,new Date().toISOString());return{ok:!0,path:p}}catch(e){return{ok:!1,error:String(e?.message||e)}}}`,
    `function codexLinuxWrapInstallNow(){if(codexLinuxWrapHasDisplay()&&codexLinuxWrapPickerEnabled())codexLinuxWrapRunPicker();let m=codexLinuxWrapWriteMarker();if(!m.ok)return m;try{let a=require(\`electron\`).app;setTimeout(()=>a.exit(0),120);return{ok:!0,path:m.path}}catch(e){return{ok:!1,error:String(e?.message||e)}}}`,
    `function codexLinuxWrapHandle(e={}){let action=e&&e.action;if(action===\`status\`)return codexLinuxWrapStatusPayload();if(action===\`check\`){codexLinuxWrapSpawnCheck();return{ok:!0}}if(action===\`install\`)return codexLinuxWrapInstallNow();return{ok:!1,reason:\`unknown-action\`}}`,
    `(()=>{if(process.env.CODEX_LINUX_MULTI_LAUNCH!==\`1\`)codexLinuxWrapSpawnCheck()})();`,
  ].join("");

  const handler = `"${HANDLER_NAME}":async(e)=>codexLinuxWrapHandle(e),`;
  const needle = `"native-desktop-apps":`;
  const handlerIndex = source.indexOf(needle);
  if (handlerIndex === -1) {
    warn(`Could not find ${needle} handler map needle`, "codex wrapper updater main-bundle patch");
    return source;
  }

  const withHandler = source.slice(0, handlerIndex) + handler + source.slice(handlerIndex);
  const useStrictDouble = `"use strict";`;
  const useStrictSingle = `'use strict';`;
  const helperInsertAt = withHandler.startsWith(useStrictDouble)
    ? useStrictDouble.length
    : withHandler.startsWith(useStrictSingle)
      ? useStrictSingle.length
      : 0;
  return withHandler.slice(0, helperInsertAt) + helper + withHandler.slice(helperInsertAt);
}

function wrapperRuntimeSource() {
  return [
    `;(()=>{`,
    `const VERSION=${JSON.stringify(RUNTIME_VERSION)};`,
    `if(globalThis.codexLinuxWrapperUpdaterVersion===VERSION)return;`,
    `globalThis.codexLinuxWrapperUpdaterVersion=VERSION;`,
    `const METHOD=${JSON.stringify(HANDLER_NAME)};`,
    `let seq=0,pending=new Map,button=null,shaChip=null,busy=false;`,
    `function onMessage(e){let t=e?.data;if(!t||typeof t!=="object"||t.type!=="fetch-response")return;let n=pending.get(t.requestId);if(!n)return;pending.delete(t.requestId);if(t.responseType==="success"){let v=null;try{v=t.bodyJsonString?JSON.parse(t.bodyJsonString):null}catch{}n.resolve({status:t.status,body:v})}else n.reject(Error(t.error||"fetch failed"))}`,
    `window.addEventListener("message",onMessage);`,
    `function dispatch(payload){let bridge=window.electronBridge,ev=new CustomEvent("codex-message-from-view",{detail:payload});if(bridge?.sendMessageFromView){ev.__codexForwardedViaBridge=!0;bridge.sendMessageFromView(payload).catch(()=>{})}window.dispatchEvent(ev)}`,
    `function post(params,timeoutMs=4000){let requestId="codex-linux-wrapper-updater-"+ ++seq;let payload={type:"fetch",hostId:"local",requestId,method:"POST",url:"vscode://codex/"+METHOD,body:JSON.stringify(params??{})};return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});setTimeout(()=>{pending.delete(requestId);reject(Error("timeout"))},timeoutMs);dispatch(payload)})}`,
    `function installStyle(){if(document.getElementById("codex-linux-wrapper-update-style"))return;let s=document.createElement("style");s.id="codex-linux-wrapper-update-style";s.textContent=".codex-linux-wrapper-update-btn{height:22px;padding:0 10px;margin:0 8px;display:none;align-items:center;gap:5px;font:500 12px/1 -apple-system,BlinkMacSystemFont,\\"Segoe UI\\",Roboto,sans-serif;color:#fff;background:#3a7d44;border:1px solid #4a9d54;border-radius:4px;cursor:pointer;pointer-events:auto;-webkit-app-region:no-drag;box-shadow:0 1px 2px rgba(0,0,0,0.18);transition:background-color 120ms ease;vertical-align:middle;line-height:1}.codex-linux-wrapper-update-btn[data-state=\\"available\\"],.codex-linux-wrapper-update-btn[data-state=\\"dev-mode\\"]{display:inline-flex}.codex-linux-wrapper-update-btn[data-state=\\"dev-mode\\"]{background:#6b5300;border-color:#a07c00;color:#ffe9a8;cursor:default}.codex-linux-wrapper-update-btn[data-state=\\"dev-mode\\"]:hover{background:#6b5300}.codex-linux-wrapper-update-btn.codex-linux-wrapper-update-floating{position:fixed;top:6px;right:210px;z-index:2147483000}.codex-linux-wrapper-update-btn:hover{background:#4a9d54}.codex-linux-wrapper-update-btn:disabled{opacity:.85;cursor:default}.codex-linux-wrapper-sha{height:22px;padding:0 7px;margin:0 4px;display:none;align-items:center;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9aa0a6;background:rgba(120,120,120,.16);border:1px solid rgba(120,120,120,.28);border-radius:4px;pointer-events:auto;-webkit-app-region:no-drag;vertical-align:middle}.codex-linux-wrapper-sha.codex-linux-wrapper-sha-on{display:inline-flex}.codex-linux-wrapper-sha.codex-linux-wrapper-sha-floating{position:fixed;top:6px;right:290px;z-index:2147483000}.codex-linux-wrapper-sha::before{content:\\"sha \\";opacity:.7;margin-right:3px}";document.head.appendChild(s)}`,
    `function findHeaderTarget(){const candidates=["header","[role=\\"banner\\"]","nav[aria-label]"];for(const sel of candidates){const el=document.querySelector(sel);if(el&&el.getBoundingClientRect().top<120&&el.offsetHeight>0)return el}return null}`,
    `function placeShaChip(){if(!shaChip||!button||!button.parentElement)return;if(button.classList.contains("codex-linux-wrapper-update-floating")){shaChip.classList.add("codex-linux-wrapper-sha-floating")}else{shaChip.classList.remove("codex-linux-wrapper-sha-floating")}if(shaChip.parentElement!==button.parentElement||shaChip.nextSibling!==button){button.parentElement.insertBefore(shaChip,button)}}`,
    `function attachButton(b){if(b.parentElement){placeShaChip();return}let host=findHeaderTarget();if(host){b.classList.remove("codex-linux-wrapper-update-floating");host.appendChild(b)}else{b.classList.add("codex-linux-wrapper-update-floating");(document.body||document.documentElement).appendChild(b)}placeShaChip()}`,
    `function ensureButton(){if(button&&document.contains(button))return button;installStyle();let b=document.createElement("button");b.type="button";b.className="codex-linux-wrapper-update-btn";b.setAttribute("aria-label","Update Codex Desktop Linux");b.title="A newer Codex Desktop Linux build is available";b.innerHTML='<span class="cdx-wrap-glyph">\\u2193</span><span class="cdx-wrap-label">Update</span>';b.addEventListener("click",onClick);button=b;attachButton(b);return b}`,
    `function ensureShaChip(commit){installStyle();if(!shaChip||!document.contains(shaChip)){let c=document.createElement("span");c.className="codex-linux-wrapper-sha";c.setAttribute("aria-label","Installed Codex Desktop Linux build");shaChip=c}let sha=(typeof commit==="string"?commit:"").trim();if(sha.length>0){shaChip.textContent=sha.slice(0,7);shaChip.title="Installed build "+sha.slice(0,12);shaChip.classList.add("codex-linux-wrapper-sha-on")}else{shaChip.textContent="";shaChip.classList.remove("codex-linux-wrapper-sha-on")}placeShaChip();return shaChip}`,
    `let observer=null;function watchForHeader(){if(observer)return;observer=new MutationObserver(()=>{if(!button)return;if(button.classList.contains("codex-linux-wrapper-update-floating")){let host=findHeaderTarget();if(host){button.classList.remove("codex-linux-wrapper-update-floating");host.appendChild(button)}}else if(!button.parentElement||!document.contains(button.parentElement)){attachButton(button)}placeShaChip()});observer.observe(document.body||document.documentElement,{childList:!0,subtree:!0})}`,
    `function setBtn(b,glyph,label){b.innerHTML='<span class="cdx-wrap-glyph">'+glyph+'</span><span class="cdx-wrap-label">'+label+'</span>'}`,
    `function setState(payload){let b=ensureButton();ensureShaChip(payload&&payload.installed_commit);if(payload&&payload.dev_mode===true){b.dataset.state="dev-mode";setBtn(b,"\\u2699","dev mode");b.disabled=true;b.title="Local build ahead of upstream; updates disabled to avoid downgrade";return}if(payload&&payload.show){b.dataset.state="available";setBtn(b,"\\u2193","Update");b.disabled=false;let cl=(payload.changelog||"").trim();b.title=cl?("What's new:\\n"+cl.split("\\n").slice(0,12).join("\\n")):"A newer Codex Desktop Linux build is available";return}b.dataset.state="hidden";b.disabled=false}`,
    `async function onClick(){if(busy||button&&button.dataset.state==="dev-mode")return;busy=true;let b=ensureButton();b.disabled=true;setBtn(b,"\\u21bb","Restarting\\u2026");try{let r=await post({action:"install"});if(r&&r.body&&r.body.ok===false){setBtn(b,"\\u2193","Update");b.title=r.body.error||r.body.reason||"Update failed";setTimeout(()=>{b.title="A newer Codex Desktop Linux build is available"},2400)}}catch{setBtn(b,"\\u2193","Update")}finally{busy=false;b.disabled=false}}`,
    `async function refresh(){try{let r=await post({action:"status"},2500);setState(r?.body||null)}catch{}}`,
    `function start(){if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",start,{once:!0});return}ensureButton();watchForHeader();post({action:"check"}).catch(()=>{});refresh();[2000,5000,9000,15000,22000].forEach(t=>setTimeout(refresh,t));setInterval(()=>{post({action:"check"}).catch(()=>{});setTimeout(refresh,4000)},30000)}`,
    `start();`,
    `})();`,
  ].join("");
}

function applyWebviewRuntimePatch(source) {
  if (source.includes(`codexLinuxWrapperUpdaterVersion=`)) {
    return source;
  }
  return source + wrapperRuntimeSource();
}

function applyWrapperUpdateSettingsPatch(source) {
  let next = source;
  if (!next.includes("wrapperUpdates:")) {
    const keyNeedle = `autoUpdateOnExit:"codex-linux-auto-update-on-exit"`;
    if (!next.includes(keyNeedle)) {
      throw new Error("could not find Linux update settings keys");
    }
    next = next.replace(
      keyNeedle,
      `${keyNeedle},wrapperUpdates:${JSON.stringify(WRAPPER_UPDATES_SETTING_KEY)}`,
    );
  }
  if (!next.includes("featurePickerOnUpdate:")) {
    const wrapperKey = `wrapperUpdates:${JSON.stringify(WRAPPER_UPDATES_SETTING_KEY)}`;
    if (!next.includes(wrapperKey)) {
      throw new Error("could not find wrapper update settings key");
    }
    next = next.replace(
      wrapperKey,
      `${wrapperKey},featurePickerOnUpdate:${JSON.stringify(FEATURE_PICKER_ON_UPDATE_SETTING_KEY)}`,
    );
  }

  if (!next.includes("Check for Codex Desktop Linux updates")) {
    const toggleNeedle =
      `children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close Codex",description:"When on, a ready update waits for Codex to close and then installs. When off, updates wait until you click Update."})`;
    if (!next.includes(toggleNeedle)) {
      throw new Error("could not find Linux update toggle");
    }
    const pickerToggle =
      `$.jsx(LinuxToggle,{settingKey:KEYS.featurePickerOnUpdate,label:"Ask which features to enable on update",description:"When on, clicking Update opens a checklist to pick optional Linux features before rebuilding. Turn off to keep your current feature selection without prompting.",defaultValue:!0},"featurePickerOnUpdate")`;
    const wrapperToggle =
      `children:[$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close Codex",description:"When on, a ready update waits for Codex to close and then installs. When off, updates wait until you click Update."},"autoUpdateOnExit"),$.jsx(LinuxToggle,{settingKey:KEYS.wrapperUpdates,label:"Check for Codex Desktop Linux updates",description:"Check for Linux wrapper updates from codex-desktop-linux in addition to upstream Codex app updates.",defaultValue:!1},"wrapperUpdates"),${pickerToggle}]`;
    next = next.replace(toggleNeedle, wrapperToggle);
  } else if (!next.includes("Ask which features to enable on update")) {
    const existingWrapperToggle =
      `$.jsx(LinuxToggle,{settingKey:KEYS.wrapperUpdates,label:"Check for Codex Desktop Linux updates",description:"Check for Linux wrapper updates from codex-desktop-linux in addition to upstream Codex app updates.",defaultValue:!1},"wrapperUpdates")`;
    if (!next.includes(existingWrapperToggle)) {
      throw new Error("could not find wrapper update toggle");
    }
    const pickerToggle =
      `$.jsx(LinuxToggle,{settingKey:KEYS.featurePickerOnUpdate,label:"Ask which features to enable on update",description:"When on, clicking Update opens a checklist to pick optional Linux features before rebuilding. Turn off to keep your current feature selection without prompting.",defaultValue:!0},"featurePickerOnUpdate")`;
    next = next.replace(existingWrapperToggle, `${existingWrapperToggle},${pickerToggle}`);
  }

  return next;
}

function applyWrapperUpdateGeneralSettingsPatch(source) {
  const hasWrapperSetting = source.includes("Check for Codex Desktop Linux updates");
  const hasFeaturePickerSetting = source.includes("Ask which features to enable on update");
  if (hasWrapperSetting && hasFeaturePickerSetting) {
    return source;
  }

  const functionNeedle = "function Br(){";
  if (!source.includes(functionNeedle)) {
    throw new Error("could not find general power settings function");
  }

  const wrapperSettingFunction = hasWrapperSetting
    ? ""
    :
    `function CodexLinuxWrapperUpdatesSetting(){let[e,t]=(0,X.useState)(!1),[n,r]=(0,X.useState)(!0),[i,a]=(0,X.useState)(null),o=x();(0,X.useEffect)(()=>{let e=!0;return r(!0),N(\`get-global-state\`,{params:{key:${JSON.stringify(WRAPPER_UPDATES_SETTING_KEY)}}}).then(n=>{e&&(t(n?.value??!1),a(null))}).catch(t=>{e&&a(t instanceof Error?t.message:String(t))}).finally(()=>{e&&r(!1)}),()=>{e=!1}},[]);let s=(0,$.jsx)(w,{id:\`settings.general.wrapperUpdates.label\`,defaultMessage:\`Check for Codex Desktop Linux updates\`,description:\`Label for Linux wrapper update checks setting\`}),c=(0,$.jsx)(w,{id:\`settings.general.wrapperUpdates.description\`,defaultMessage:\`Check for Linux wrapper updates from codex-desktop-linux in addition to upstream Codex app updates.\`,description:\`Description for Linux wrapper update checks setting\`});i&&(c=(0,$.jsxs)(\`div\`,{className:\`flex flex-col gap-1\`,children:[c,(0,$.jsx)(\`span\`,{className:\`text-token-error-foreground\`,children:i})]}));let l=o.formatMessage({id:\`settings.general.wrapperUpdates.label\`,defaultMessage:\`Check for Codex Desktop Linux updates\`,description:\`Label for Linux wrapper update checks setting\`});return(0,$.jsx)(J,{label:s,description:c,control:(0,$.jsx)(q,{checked:e===!0,disabled:n,onChange:o=>{let s=e;t(o),a(null),N(\`set-global-state\`,{params:{key:${JSON.stringify(WRAPPER_UPDATES_SETTING_KEY)},value:o}}).catch(e=>{t(s),a(e instanceof Error?e.message:String(e))})},ariaLabel:l})})}`;
  const featurePickerSettingFunction = hasFeaturePickerSetting
    ? ""
    :
    `function CodexLinuxFeaturePickerOnUpdateSetting(){let[e,t]=(0,X.useState)(!0),[n,r]=(0,X.useState)(!0),[i,a]=(0,X.useState)(null),o=x();(0,X.useEffect)(()=>{let e=!0;return r(!0),N(\`get-global-state\`,{params:{key:${JSON.stringify(FEATURE_PICKER_ON_UPDATE_SETTING_KEY)}}}).then(n=>{e&&(t(n?.value??!0),a(null))}).catch(t=>{e&&a(t instanceof Error?t.message:String(t))}).finally(()=>{e&&r(!1)}),()=>{e=!1}},[]);let s=(0,$.jsx)(w,{id:\`settings.general.featurePickerOnUpdate.label\`,defaultMessage:\`Ask which features to enable on update\`,description:\`Label for Linux feature picker on update setting\`}),c=(0,$.jsx)(w,{id:\`settings.general.featurePickerOnUpdate.description\`,defaultMessage:\`When on, clicking Update opens a checklist to pick optional Linux features before rebuilding. Turn off to keep your current feature selection without prompting.\`,description:\`Description for Linux feature picker on update setting\`});i&&(c=(0,$.jsxs)(\`div\`,{className:\`flex flex-col gap-1\`,children:[c,(0,$.jsx)(\`span\`,{className:\`text-token-error-foreground\`,children:i})]}));let l=o.formatMessage({id:\`settings.general.featurePickerOnUpdate.label\`,defaultMessage:\`Ask which features to enable on update\`,description:\`Label for Linux feature picker on update setting\`});return(0,$.jsx)(J,{label:s,description:c,control:(0,$.jsx)(q,{checked:e===!0,disabled:n,onChange:o=>{let s=e;t(o),a(null),N(\`set-global-state\`,{params:{key:${JSON.stringify(FEATURE_PICKER_ON_UPDATE_SETTING_KEY)},value:o}}).catch(e=>{t(s),a(e instanceof Error?e.message:String(e))})},ariaLabel:l})})}`;

  let next = source.replace(
    functionNeedle,
    `${wrapperSettingFunction}${featurePickerSettingFunction}${functionNeedle}`,
  );

  const powerRowNeedle = `D=(0,$.jsx)(K,{electron:!0,children:(0,$.jsx)(Br,{})})`;
  const powerRowPatch =
    `D=(0,$.jsx)(K,{electron:!0,children:(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(Br,{}),(0,$.jsx)(CodexLinuxWrapperUpdatesSetting,{}),(0,$.jsx)(CodexLinuxFeaturePickerOnUpdateSetting,{})]})})`;
  if (next.includes(powerRowNeedle)) {
    next = next.replace(powerRowNeedle, powerRowPatch);
    return next;
  }

  const existingWrapperRowNeedle = `children:[(0,$.jsx)(Br,{}),(0,$.jsx)(CodexLinuxWrapperUpdatesSetting,{})]`;
  const existingWrapperRowPatch =
    `children:[(0,$.jsx)(Br,{}),(0,$.jsx)(CodexLinuxWrapperUpdatesSetting,{}),(0,$.jsx)(CodexLinuxFeaturePickerOnUpdateSetting,{})]`;
  if (next.includes(existingWrapperRowNeedle)) {
    next = next.replace(existingWrapperRowNeedle, existingWrapperRowPatch);
    return next;
  }

  throw new Error("could not find general power settings row");
}

function patchWrapperUpdateSettingsAssets(extractedDir) {
  try {
    const assetsDir = path.join(extractedDir, "webview", "assets");
    if (!fs.existsSync(assetsDir)) {
      return { matched: false, changed: 0, reason: `missing webview assets directory ${assetsDir}` };
    }

    for (const settingsAsset of [LINUX_DESKTOP_SETTINGS_ASSET, KEYBINDS_ASSET]) {
      const settingsPath = path.join(assetsDir, settingsAsset);
      if (!fs.existsSync(settingsPath)) {
        continue;
      }
      const current = fs.readFileSync(settingsPath, "utf8");
      const patched = applyWrapperUpdateSettingsPatch(current);
      if (patched === current) {
        return { matched: true, changed: 0 };
      }
      fs.writeFileSync(settingsPath, patched, "utf8");
      return { matched: true, changed: 1 };
    }

    const generalSettingsAssets = fs
      .readdirSync(assetsDir)
      .filter((name) => /^general-settings-.*\.js$/.test(name));
    if (generalSettingsAssets.length === 0) {
      return { matched: false, changed: 0, reason: `${LINUX_DESKTOP_SETTINGS_ASSET}, ${KEYBINDS_ASSET}, and general settings asset are not present` };
    }

    let lastError = null;
    for (const generalSettingsAsset of generalSettingsAssets) {
      const generalPath = path.join(assetsDir, generalSettingsAsset);
      const current = fs.readFileSync(generalPath, "utf8");
      try {
        const patched = applyWrapperUpdateGeneralSettingsPatch(current);
        if (patched === current) {
          return { matched: true, changed: 0 };
        }
        fs.writeFileSync(generalPath, patched, "utf8");
        return { matched: true, changed: 1 };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (
      lastError != null &&
      (
        lastError.includes("could not find general power settings function") ||
        lastError.includes("could not find general power settings row")
      )
    ) {
      return {
        matched: true,
        changed: 0,
        reason: "upstream settings shape does not expose the legacy wrapper update toggle extension point",
      };
    }

    return { matched: false, changed: 0, reason: lastError ?? "could not patch general settings asset" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: Wrapper update settings patch skipped: ${message}`);
    return { matched: false, changed: 0, reason: message };
  }
}

module.exports = {
  HANDLER_NAME,
  RUNTIME_VERSION,
  FEATURE_PICKER_ON_UPDATE_SETTING_KEY,
  WRAPPER_UPDATES_SETTING_KEY,
  applyMainBundlePatch,
  applyWebviewRuntimePatch,
  applyWrapperUpdateGeneralSettingsPatch,
  applyWrapperUpdateSettingsPatch,
  patchWrapperUpdateSettingsAssets,
  descriptors: [
    {
      id: "main-handler",
      phase: "main-bundle",
      order: 20_920,
      ciPolicy: "optional",
      apply: applyMainBundlePatch,
    },
    {
      id: "webview-runtime",
      phase: "webview-asset",
      order: 20_921,
      ciPolicy: "optional",
      pattern: /^index-.*\.js$/,
      missingDescription: "webview index bundle",
      skipDescription: "codex wrapper updater webview runtime patch",
      apply: applyWebviewRuntimePatch,
    },
    {
      id: "settings-toggle",
      phase: "extracted-app",
      order: 20_922,
      ciPolicy: "optional",
      apply: (extractedDir) => patchWrapperUpdateSettingsAssets(extractedDir),
      status: (result, warnings) => {
        if (result?.matched === false) {
          return { status: "skipped-optional", reason: result.reason ?? warnings[0] ?? null };
        }
        return (result?.changed ?? 0) > 0 ? "applied" : "already-applied";
      },
    },
  ],
};
