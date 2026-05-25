"use strict";

const APPSHOT_HELPER_MARKER = "codexLinuxAppshotStartCapture";
const LINUX_APPSHOT_RECOMMENDED_BARE_HOTKEY = "DoubleShift";
const LINUX_APPSHOT_FALLBACK_HOTKEY = "Ctrl+Alt+A";

function applyLinuxAppshotAvailabilityPatch(currentSource) {
  if (currentSource.includes("n===`linux`||n===`macOS`&&r")) {
    return currentSource;
  }

  let changed = false;
  const patchedSource = currentSource.replace(
    /return ([A-Za-z_$][\w$]*)===`macOS`&&([A-Za-z_$][\w$]*)/g,
    (match, platformVar, flagVar) => {
      changed = true;
      return `return ${platformVar}===\`linux\`||${platformVar}===\`macOS\`&&${flagVar}`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (currentSource.includes("1304276663") || currentSource.includes("macOS")) {
    console.warn("WARN: Could not find AppShots availability gate — skipping Linux AppShots availability patch");
  }
  return currentSource;
}

function applyLinuxAppshotMainProcessPatch(currentSource) {
  if (currentSource.includes(APPSHOT_HELPER_MARKER)) {
    return currentSource;
  }

  let changed = false;
  let patchedSource = currentSource.replace(
    /"computer-use-frontmost-window":async\(\)=>process\.platform===`darwin`\?([A-Za-z_$][\w$]*)\(\):null/g,
    (match, macFrontmostFn) => {
      changed = true;
      return `"computer-use-frontmost-window":async()=>process.platform===\`linux\`?codexLinuxAppshotFrontmostWindow():process.platform===\`darwin\`?${macFrontmostFn}():null`;
    },
  );

  patchedSource = patchedSource.replace(
    /"computer-use-start-capture":async\(\{animationDestination:([A-Za-z_$][\w$]*),bundleIdentifier:([A-Za-z_$][\w$]*),origin:([A-Za-z_$][\w$]*),requestId:([A-Za-z_$][\w$]*)\}\)=>\{if\(process\.platform!==`darwin`\|\|this\.requestComputerUseCaptureWorker==null\|\|this\.subscribeComputerUseCaptureWorkerEvent==null\)return null;/g,
    (match, animationDestinationVar, bundleIdentifierVar, originVar, requestIdVar) => {
      changed = true;
      return `"computer-use-start-capture":async({animationDestination:${animationDestinationVar},bundleIdentifier:${bundleIdentifierVar},origin:${originVar},requestId:${requestIdVar}})=>{if(process.platform===\`linux\`)return codexLinuxAppshotStartCapture({origin:${originVar},requestId:${requestIdVar},bundleIdentifier:${bundleIdentifierVar}});if(process.platform!==\`darwin\`||this.requestComputerUseCaptureWorker==null||this.subscribeComputerUseCaptureWorkerEvent==null)return null;`;
    },
  );

  if (!changed) {
    if (currentSource.includes("computer-use-frontmost-window") || currentSource.includes("computer-use-start-capture")) {
      console.warn("WARN: Could not find AppShots main-process capture handlers — skipping Linux AppShots main-process patch");
    }
    return currentSource;
  }

  const sendMessageFn = findMessageForViewSendFunction(currentSource);
  if (sendMessageFn == null) {
    console.warn("WARN: Could not find renderer message sender — skipping Linux AppShots main-process patch");
    return currentSource;
  }

  return appendLinuxAppshotHelper(patchedSource, sendMessageFn);
}

function applyLinuxAppshotHotkeyPatch(currentSource) {
  if (currentSource.includes("process.platform===`linux`?null")) {
    return currentSource;
  }

  let changed = false;
  let patchedSource = currentSource.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.get\(`appshotHotkey`\)\?\?([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=\(\)=>\(\{supported:([A-Za-z_$][\w$]*)&&process\.platform===`darwin`,configuredHotkey:\1,isActive:\4!=null\}\),([A-Za-z_$][\w$]*)=\(\)=>\{if\(\4\?\.unregister\(\),\4=null,!\6\|\|process\.platform!==`darwin`\|\|\1==null\)\{/,
    (
      match,
      configuredVar,
      globalStateVar,
      defaultHotkeyVar,
      registrationVar,
      stateFnVar,
      enabledVar,
      reconcileFnVar,
    ) => {
      changed = true;
      return `let ${configuredVar}=${globalStateVar}.get(\`appshotHotkey\`)??(process.platform===\`linux\`?null:${defaultHotkeyVar});let ${registrationVar}=null,${stateFnVar}=()=>({supported:${enabledVar}&&(process.platform===\`darwin\`||process.platform===\`linux\`),configuredHotkey:${configuredVar},isActive:${registrationVar}!=null}),${reconcileFnVar}=()=>{if(${registrationVar}?.unregister(),${registrationVar}=null,!${enabledVar}||process.platform!==\`darwin\`&&process.platform!==\`linux\`||${configuredVar}==null){`;
    },
  );

  patchedSource = patchedSource.replace(
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=process\.platform\)\{return \3===`darwin`&&([A-Za-z_$][\w$]*)\(\2\)!=null\}/,
    (match, supportedFn, hotkeyVar, platformVar, canonicalBareModifierFn) => {
      changed = true;
      return `function ${supportedFn}(${hotkeyVar},${platformVar}=process.platform){return ${platformVar}===\`darwin\`&&${canonicalBareModifierFn}(${hotkeyVar})!=null||${platformVar}===\`linux\`&&typeof codexLinuxAppshotBareModifierHotkey==\`function\`&&codexLinuxAppshotBareModifierHotkey(${hotkeyVar})}`;
    },
  );

  patchedSource = patchedSource.replace(
    /if\(([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)return ([A-Za-z_$][\w$]*)\(\2\)\?([A-Za-z_$][\w$]*)\(\2,([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\?\.(bareModifierTrigger)\):null;let /,
    (
      match,
      isBareModifierFn,
      hotkeyVar,
      supportedFn,
      macRegisterFn,
      handlersVar,
      optionsVar,
      triggerProperty,
    ) => {
      changed = true;
      return `if(${isBareModifierFn}(${hotkeyVar}))return process.platform===\`linux\`&&typeof codexLinuxAppshotBareModifierHotkey==\`function\`&&codexLinuxAppshotBareModifierHotkey(${hotkeyVar})?codexLinuxAppshotRegisterBareModifierHotkey(${hotkeyVar},${handlersVar},${optionsVar}?.${triggerProperty}):${supportedFn}(${hotkeyVar})?${macRegisterFn}(${hotkeyVar},${handlersVar},${optionsVar}?.${triggerProperty}):null;let `;
    },
  );

  patchedSource = patchedSource.replace(
    /if\(!([A-Za-z_$][\w$]*)\|\|process\.platform!==`darwin`\)return\{success:!1,error:`Not supported\.`,state:([A-Za-z_$][\w$]*)\(\)\};if\(([A-Za-z_$][\w$]*)!=null\)\{/,
    (match, enabledVar, stateFnVar, nextHotkeyVar) => {
      changed = true;
      return `if(!${enabledVar}||process.platform!==\`darwin\`&&process.platform!==\`linux\`)return{success:!1,error:\`Not supported.\`,state:${stateFnVar}()};if(${nextHotkeyVar}!=null){`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (currentSource.includes("appshotHotkey") || currentSource.includes("appshot-hotkey-state")) {
    console.warn("WARN: Could not find AppShots hotkey controller — skipping Linux AppShots hotkey patch");
  }
  return currentSource;
}

function applyLinuxAppshotSettingsHotkeyPatch(currentSource) {
  if (currentSource.includes("DoubleAlt") && currentSource.includes("Ctrl+Alt+A")) {
    return currentSource;
  }

  let changed = false;
  const patchedSource = currentSource.replace(
    /((?:var\s+|,)([A-Za-z_$][\w$]*)=)(\[\{hotkey:`DoubleCommand`,label:`[^`]+`\},\{hotkey:`DoubleOption`,label:`[^`]+`\},\{hotkey:`DoubleShift`,label:`[^`]+`\}\])(?=;)/,
    (match, declarationPrefix, optionsVar, macOptions) => {
      changed = true;
      return `${declarationPrefix}typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)?[{hotkey:\`${LINUX_APPSHOT_RECOMMENDED_BARE_HOTKEY}\`,label:\`Shift + Shift\`},{hotkey:\`DoubleAlt\`,label:\`Alt + Alt\`},{hotkey:\`${LINUX_APPSHOT_FALLBACK_HOTKEY}\`,label:\`Ctrl + Alt + A\`}]:${macOptions}`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (currentSource.includes("appshot-hotkey-state") || currentSource.includes("DoubleCommand")) {
    console.warn("WARN: Could not find AppShots settings hotkey options — skipping Linux AppShots settings patch");
  }
  return currentSource;
}

function findMessageForViewSendFunction(source) {
  const channelVar = source.match(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)=`codex_desktop:message-for-view`/)?.[1];
  if (channelVar == null) {
    return source.includes("function nS(") ? "nS" : null;
  }

  const escapedChannelVar = escapeRegExp(channelVar);
  const sendFnMatch = source.match(new RegExp(
    String.raw`function\s+([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{\2\.isDestroyed\(\)\|\|\2\.send\(${escapedChannelVar},\3\)\}`,
  ));
  return sendFnMatch?.[1] ?? (source.includes("function nS(") ? "nS" : null);
}

function appendLinuxAppshotHelper(source, sendMessageFn) {
  return `${source}
;function codexLinuxAppshotRequire(e){return require(e)}
function codexLinuxAppshotBackendPath(){let e=codexLinuxAppshotRequire(\`node:fs\`),t=codexLinuxAppshotRequire(\`node:path\`),n=codexLinuxAppshotRequire(\`node:os\`),r=process.env.CODEX_ELECTRON_RESOURCES_PATH||process.resourcesPath,i=process.env.CODEX_HOME||(process.env.HOME?t.join(process.env.HOME,\`.codex\`):t.join(n.homedir(),\`.codex\`)),a=[process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE,r&&t.join(r,\`plugins\`,\`openai-bundled\`,\`plugins\`,\`computer-use\`,\`bin\`,\`codex-computer-use-linux\`),i&&t.join(i,\`plugins\`,\`cache\`,\`openai-bundled\`,\`computer-use\`,\`latest\`,\`bin\`,\`codex-computer-use-linux\`)];for(let t of a){if(typeof t!=\`string\`||t.length===0)continue;try{if(e.existsSync(t))return t}catch{}}return null}
function codexLinuxAppshotBackendJson(e,t=45000){let n=codexLinuxAppshotBackendPath();if(n==null)return Promise.reject(Error(\`Linux Computer Use backend is not installed\`));let r=codexLinuxAppshotRequire(\`node:child_process\`);return new Promise((i,a)=>{r.execFile(n,e,{timeout:t,maxBuffer:67108864},(e,t,n)=>{if(e!=null){a(Error((n||e.message||\`Linux Computer Use backend failed\`).trim()));return}try{i(JSON.parse(t))}catch(e){a(Error(\`Linux Computer Use backend returned invalid JSON\`))}})})}
function codexLinuxAppshotNormalizeBareModifier(e){let t=String(e??\`\`).replace(/[\\s_-]/g,\`\`).toLowerCase();if(t===\`doubleshift\`||t===\`leftshift+rightshift\`)return\`DoubleShift\`;if(t===\`doublealt\`||t===\`doubleoption\`||t===\`leftalt+rightalt\`||t===\`leftoption+rightoption\`)return\`DoubleAlt\`;if(t===\`doublesuper\`||t===\`doublemeta\`||t===\`doublecommand\`||t===\`leftmeta+rightmeta\`||t===\`leftcommand+rightcommand\`)return\`DoubleSuper\`;return null}
function codexLinuxAppshotBareModifierHotkey(e){return codexLinuxAppshotNormalizeBareModifier(e)!=null}
function codexLinuxAppshotRegisterBareModifierHotkey(e,t,n=\`press\`){let r=codexLinuxAppshotNormalizeBareModifier(e),i=codexLinuxAppshotBackendPath();if(r==null||i==null)return null;let a=codexLinuxAppshotRequire(\`node:child_process\`),o=[\`bare-modifier-monitor\`,\`--key\`,r];n===\`immediatePress\`?o.push(\`--immediate\`):n===\`release\`&&o.push(\`--trigger-on-release\`);let s=a.spawn(i,o,{stdio:[\`ignore\`,\`pipe\`,\`ignore\`]}),c=!1,l=!1,u=e=>{switch(e){case\`ready\`:return;case\`down\`:t.onPressed();return;case\`up\`:t.onReleased?.();return;case\`permission-denied\`:return;case\`\`:return;default:return}},d=\`\`;return s.stdout?.on(\`data\`,e=>{d+=e.toString(\`utf8\`);let t=d.indexOf(\`\\n\`);for(;t!==-1;)u(d.slice(0,t).trim()),d=d.slice(t+1),t=d.indexOf(\`\\n\`)}),s.once(\`error\`,()=>{l||s.kill()}),s.once(\`exit\`,()=>{c||l||(l=!0)}),{handlesRelease:!0,unregister:()=>{c=!0,l=!0,s.kill()}}}
function codexLinuxAppshotFirstString(...e){for(let t of e)if(typeof t==\`string\`&&t.trim().length>0)return t.trim();return null}
function codexLinuxAppshotWindowForRenderer(e){if(e==null||typeof e!=\`object\`)return null;let t=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.title,\`Linux app\`),n=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.pid!=null?\`pid:\${e.pid}\`:null,e.window_id!=null?\`window:\${e.window_id}\`:null,t),r=codexLinuxAppshotFirstString(e.title);return{name:t,appName:t,bundleIdentifier:n,windowTitle:r,iconSmallDataURL:null,appIconDataUrl:null}}
async function codexLinuxAppshotFrontmostWindow(){if(process.platform!==\`linux\`)return null;try{let e=await codexLinuxAppshotBackendJson([\`focused-window\`],5000);return codexLinuxAppshotWindowForRenderer(e.focused_window)}catch{return null}}
function codexLinuxAppshotSend(e,t,n){try{${sendMessageFn}(e,{requestId:t,type:\`computer-use-capture-updated\`,update:n})}catch{}}
function codexLinuxAppshotStartCapture({origin:e,requestId:t,bundleIdentifier:n}){if(process.platform!==\`linux\`)return null;setTimeout(()=>{codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n}).catch(()=>codexLinuxAppshotSend(e,t,{type:\`failed\`}))},0);return{animationDuration:null,transitionSnapshotHeight:null,transitionSpringDampingFraction:null,transitionSpringResponse:null}}
async function codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n}){let r=typeof n==\`string\`&&n.trim().length>0?n.trim():null,i=await codexLinuxAppshotBackendJson(r==null?[\`appshot\`]:[\`appshot\`,r]),a=codexLinuxAppshotWindowForRenderer(i.focused_window);a!=null&&codexLinuxAppshotSend(e,t,{type:\`metadata\`,app:{bundleIdentifier:a.bundleIdentifier,name:a.name,windowTitle:a.windowTitle,iconSmallDataURL:null}});typeof i.accessibility_text==\`string\`&&i.accessibility_text.length>0&&codexLinuxAppshotSend(e,t,{type:\`axText\`,text:i.accessibility_text});let o=i.screenshot?.data_url;if(typeof o!=\`string\`||o.length===0){codexLinuxAppshotSend(e,t,{type:\`failed\`});return}codexLinuxAppshotSend(e,t,{type:\`screenshot\`,screenshotDataURL:o});codexLinuxAppshotSend(e,t,{type:\`completed\`,transitionSnapshotDataURL:o})}
`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  applyLinuxAppshotSettingsHotkeyPatch,
};
