"use strict";

const APPSHOT_HELPER_MARKER = "codexLinuxAppshotStartCapture";
const LINUX_APPSHOT_HOTKEYS = [
  { hotkey: "DoubleOption", label: "Alt + Alt" },
  { hotkey: "DoubleShift", label: "Shift + Shift" },
  { hotkey: "Ctrl+Super+A", label: "Ctrl + Super + A" },
];

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyLinuxAppshotAvailabilityPatch(currentSource) {
  if (currentSource.includes("===`linux`||") && currentSource.includes("===`macOS`&&")) {
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

  if (currentSource.includes("macOS") || currentSource.includes("appshot")) {
    warn("Could not find AppShots availability gate", "Linux AppShots availability patch");
  }
  return currentSource;
}

function applyLinuxAppshotMainProcessPatch(currentSource) {
  if (currentSource.includes(APPSHOT_HELPER_MARKER)) {
    return repairLinuxAppshotRendererSender(currentSource);
  }

  const sendMessageFn = findMessageForViewSendFunction(currentSource);
  if (sendMessageFn == null) {
    warn("Could not find direct renderer message sender", "Linux AppShots main-process patch");
    return currentSource;
  }

  let patchedFrontmost = false;
  let patchedCapture = false;
  let patchedSource = currentSource.replace(
    /"computer-use-frontmost-window":async\(\)=>process\.platform===`darwin`\?([A-Za-z_$][\w$]*)\(\):null/g,
    (match, macFrontmostFn) => {
      patchedFrontmost = true;
      return `"computer-use-frontmost-window":async()=>process.platform===\`linux\`?codexLinuxAppshotFrontmostWindow():process.platform===\`darwin\`?${macFrontmostFn}():null`;
    },
  );

  patchedSource = patchedSource.replace(
    /"computer-use-start-capture":async\(\{animationDestination:([A-Za-z_$][\w$]*),bundleIdentifier:([A-Za-z_$][\w$]*),origin:([A-Za-z_$][\w$]*),requestId:([A-Za-z_$][\w$]*)\}\)=>\{if\(process\.platform!==`darwin`\|\|this\.requestComputerUseCaptureWorker==null\|\|this\.subscribeComputerUseCaptureWorkerEvent==null\)return null;/g,
    (match, animationDestinationVar, bundleIdentifierVar, originVar, requestIdVar) => {
      patchedCapture = true;
      return `"computer-use-start-capture":async({animationDestination:${animationDestinationVar},bundleIdentifier:${bundleIdentifierVar},origin:${originVar},requestId:${requestIdVar}})=>{if(process.platform===\`linux\`)return codexLinuxAppshotStartCapture({origin:${originVar},requestId:${requestIdVar},bundleIdentifier:${bundleIdentifierVar}});if(process.platform!==\`darwin\`||this.requestComputerUseCaptureWorker==null||this.subscribeComputerUseCaptureWorkerEvent==null)return null;`;
    },
  );

  if (!patchedFrontmost || !patchedCapture) {
    if (currentSource.includes("computer-use-frontmost-window") || currentSource.includes("computer-use-start-capture")) {
      warn("Could not find AppShots main-process handlers", "Linux AppShots main-process patch");
    }
    return currentSource;
  }

  return appendLinuxAppshotHelper(patchedSource, sendMessageFn);
}

function applyLinuxAppshotHotkeyPatch(currentSource) {
  currentSource = currentSource.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.(getStored|get)\(`appshotHotkey`\)\?\?\(process\.platform===`linux`\?`DoubleShift`:([A-Za-z_$][\w$]*)\);/g,
    (match, configuredVar, globalStateVar, getterName, defaultHotkeyVar) =>
      `let ${configuredVar}=${globalStateVar}.${getterName}(\`appshotHotkey\`)??(process.platform===\`linux\`?null:${defaultHotkeyVar});`,
  );
  currentSource = currentSource.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.(getStored|get)\(`appshotHotkey`\)\?\?\(process\.platform===`linux`\?null:([A-Za-z_$][\w$]*)\);/g,
    (match, configuredVar, globalStateVar, getterName, defaultHotkeyVar) =>
      `let ${configuredVar}=${globalStateVar}.${getterName}(\`appshotHotkey\`)??(process.platform===\`linux\`?null:${defaultHotkeyVar});`,
  );
  currentSource = currentSource.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.(getStored|get)\(`appshotHotkey`\)\?\?([A-Za-z_$][\w$]*);let ([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=\(\)=>\(\{supported:([A-Za-z_$][\w$]*)&&\(process\.platform===`darwin`\|\|process\.platform===`linux`\),configuredHotkey:\1,isActive:\5!=null\}\)/g,
    (match, configuredVar, globalStateVar, getterName, defaultHotkeyVar, registrationVar, stateFnVar, enabledVar) =>
      `let ${configuredVar}=${globalStateVar}.${getterName}(\`appshotHotkey\`)??(process.platform===\`linux\`?null:${defaultHotkeyVar});let ${registrationVar}=null,${stateFnVar}=()=>({supported:${enabledVar}&&(process.platform===\`darwin\`||process.platform===\`linux\`),configuredHotkey:${configuredVar},isActive:${registrationVar}!=null})`,
  );
  currentSource = currentSource.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.(getStored|get)\(`appshotHotkey`\),([A-Za-z_$][\w$]*)=\1===void 0\?([A-Za-z_$][\w$]*):\1,([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=\(\)=>\(\{supported:([A-Za-z_$][\w$]*)&&process\.platform===`darwin`,configuredHotkey:\4,isActive:\6!=null\}\),([A-Za-z_$][\w$]*)=\(\)=>\{if\(\6\?\.unregister\(\),\6=null,!\8\|\|process\.platform!==`darwin`\|\|\4==null\)\{/g,
    (
      match,
      storedVar,
      globalStateVar,
      getterName,
      configuredVar,
      defaultHotkeyVar,
      registrationVar,
      stateFnVar,
      enabledVar,
      reconcileFnVar,
    ) => {
      return `let ${storedVar}=${globalStateVar}.${getterName}(\`appshotHotkey\`),${configuredVar}=${storedVar}===void 0?(process.platform===\`linux\`?null:${defaultHotkeyVar}):${storedVar},${registrationVar}=null,${stateFnVar}=()=>({supported:${enabledVar}&&(process.platform===\`darwin\`||process.platform===\`linux\`),configuredHotkey:${configuredVar},isActive:${registrationVar}!=null}),${reconcileFnVar}=()=>{if(${registrationVar}?.unregister(),${registrationVar}=null,!${enabledVar}||process.platform!==\`darwin\`&&process.platform!==\`linux\`||${configuredVar}==null){`;
    },
  );
  currentSource = currentSource.replace(
    /return ([A-Za-z_$][\w$]*)\.length===1\?([A-Za-z_$][\w$]*)===`darwin`\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\2\)\?null:`This shortcut key is not supported\.`:`Choose a shortcut with Ctrl or Alt plus another key\.`:`Use Ctrl, Alt, or Command when combining with another key\.`/g,
    (match, partsVar, platformVar, supportedBareModifierFn, hotkeyVar) =>
      `return ${partsVar}.length===1?(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)?${supportedBareModifierFn}(${hotkeyVar},${platformVar})?null:\`This shortcut key is not supported.\`:\`Choose a shortcut with Ctrl or Alt plus another key.\`:\`Use Ctrl, Alt, or Command when combining with another key.\``,
  );

  if (
    currentSource.includes("process.platform===`linux`?null") &&
    currentSource.includes("process.platform!==`darwin`&&process.platform!==`linux`") &&
    currentSource.includes("===`linux`)&&") &&
    currentSource.includes("if(process.platform!==`darwin`&&process.platform!==`linux`)return null")
  ) {
    return currentSource;
  }

  let changed = false;
  let patchedSource = currentSource.replace(
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=process\.platform\)\{return \3===`darwin`&&([A-Za-z_$][\w$]*)\(\2\)!=null\}/g,
    (match, fnName, hotkeyVar, platformVar, modifierFn) => {
      changed = true;
      return `function ${fnName}(${hotkeyVar},${platformVar}=process.platform){return (${platformVar}===\`darwin\`||${platformVar}===\`linux\`)&&${modifierFn}(${hotkeyVar})!=null}`;
    },
  );

  patchedSource = patchedSource.replace(
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=`press`\)\{if\(process\.platform!==`darwin`\)return null;/g,
    (match, fnName, hotkeyVar, handlerVar, triggerVar) => {
      changed = true;
      return `function ${fnName}(${hotkeyVar},${handlerVar},${triggerVar}=\`press\`){if(process.platform!==\`darwin\`&&process.platform!==\`linux\`)return null;`;
    },
  );

  patchedSource = patchedSource.replace(
    /let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.(getStored|get)\(`appshotHotkey`\)\?\?([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=null,([A-Za-z_$][\w$]*)=\(\)=>\(\{supported:([A-Za-z_$][\w$]*)&&process\.platform===`darwin`,configuredHotkey:\1,isActive:\5!=null\}\),([A-Za-z_$][\w$]*)=\(\)=>\{if\(\5\?\.unregister\(\),\5=null,!\7\|\|process\.platform!==`darwin`\|\|\1==null\)\{/,
    (
      match,
      configuredVar,
      globalStateVar,
      getterName,
      defaultHotkeyVar,
      registrationVar,
      stateFnVar,
      enabledVar,
      reconcileFnVar,
    ) => {
      changed = true;
      return `let ${configuredVar}=${globalStateVar}.${getterName}(\`appshotHotkey\`)??(process.platform===\`linux\`?null:${defaultHotkeyVar});let ${registrationVar}=null,${stateFnVar}=()=>({supported:${enabledVar}&&(process.platform===\`darwin\`||process.platform===\`linux\`),configuredHotkey:${configuredVar},isActive:${registrationVar}!=null}),${reconcileFnVar}=()=>{if(${registrationVar}?.unregister(),${registrationVar}=null,!${enabledVar}||process.platform!==\`darwin\`&&process.platform!==\`linux\`||${configuredVar}==null){`;
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
    warn("Could not find AppShots hotkey controller", "Linux AppShots hotkey patch");
  }
  return currentSource;
}

function applyLinuxAppshotSettingsHotkeyPatch(currentSource) {
  const linuxOptions = `[${LINUX_APPSHOT_HOTKEYS.map(
    (option) => `{hotkey:\`${option.hotkey}\`,label:\`${option.label}\`}`,
  ).join(",")}]`;
  if (currentSource.includes(`navigator.userAgent.includes(\`Linux\`)?${linuxOptions}:`)) {
    return currentSource;
  }

  let changed = false;
  let patchedSource = currentSource.replace(
    /((?:var\s+|,)([A-Za-z_$][\w$]*)=typeof navigator!=`undefined`&&navigator\.userAgent\.includes\(`Linux`\)\?)\[[^\]]+\]:(\[\{hotkey:`DoubleCommand`,label:`[^`]+`\},\{hotkey:`DoubleOption`,label:`[^`]+`\},\{hotkey:`DoubleShift`,label:`[^`]+`\}\])(?=;)/,
    (match, linuxPrefix, optionsVar, macOptions) => {
      changed = true;
      return `${linuxPrefix}${linuxOptions}:${macOptions}`;
    },
  );

  patchedSource = patchedSource.replace(
    /((?:var\s+|,)([A-Za-z_$][\w$]*)=)(\[\{hotkey:`DoubleCommand`,label:`[^`]+`\},\{hotkey:`DoubleOption`,label:`[^`]+`\},\{hotkey:`DoubleShift`,label:`[^`]+`\}\])(?=;)/,
    (match, declarationPrefix, optionsVar, macOptions) => {
      changed = true;
      return `${declarationPrefix}typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)?${linuxOptions}:${macOptions}`;
    },
  );

  if (changed) {
    return patchedSource;
  }

  if (currentSource.includes("appshot-hotkey-state") || currentSource.includes("DoubleCommand")) {
    warn("Could not find AppShots settings hotkey options", "Linux AppShots settings patch");
  }
  return currentSource;
}

function repairLinuxAppshotRendererSender(source) {
  const sendMessageFn = findMessageForViewSendFunction(source);
  if (sendMessageFn == null) {
    return source;
  }

  return source.replace(
    /function codexLinuxAppshotSend\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{try\{[A-Za-z_$][\w$]*\(\1,\{requestId:\2,type:`computer-use-capture-updated`,update:\3\}\)\}catch\{\}\}/,
    (match, originVar, requestIdVar, updateVar) =>
      `function codexLinuxAppshotSend(${originVar},${requestIdVar},${updateVar}){try{${sendMessageFn}(${originVar},{requestId:${requestIdVar},type:\`computer-use-capture-updated\`,update:${updateVar}})}catch{}}`,
  );
}

function findMessageForViewSendFunction(source) {
  const channelVar = source.match(
    /(?:^|[;,\n])\s*(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)=`codex_desktop:message-for-view`/,
  )?.[1];
  if (channelVar == null) {
    return null;
  }

  const escapedChannelVar = escapeRegExp(channelVar);
  const sendFnMatch = source.match(new RegExp(
    String.raw`function\s+([A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\{\s*\2\.isDestroyed\(\)\|\|\2\.send\(${escapedChannelVar},\3\)\s*\}`,
  ));
  return sendFnMatch?.[1] ?? null;
}

function appendLinuxAppshotHelper(source, sendMessageFn) {
  return `${source}
;function codexLinuxAppshotRequire(e){return require(e)}
function codexLinuxAppshotBackendPath(){let e=codexLinuxAppshotRequire(\`node:fs\`),t=codexLinuxAppshotRequire(\`node:path\`),n=codexLinuxAppshotRequire(\`node:os\`),r=process.env.CODEX_ELECTRON_RESOURCES_PATH||process.resourcesPath,i=process.env.CODEX_HOME||(process.env.HOME?t.join(process.env.HOME,\`.codex\`):t.join(n.homedir(),\`.codex\`)),a=[process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE,r&&t.join(r,\`plugins\`,\`openai-bundled\`,\`plugins\`,\`computer-use\`,\`bin\`,\`codex-computer-use-linux\`),i&&t.join(i,\`plugins\`,\`cache\`,\`openai-bundled\`,\`computer-use\`,\`latest\`,\`bin\`,\`codex-computer-use-linux\`)];for(let t of a){if(typeof t!=\`string\`||t.length===0)continue;try{if(e.existsSync(t))return t}catch{}}return null}
function codexLinuxAppshotBackendJson(e,t=10000){let n=codexLinuxAppshotBackendPath();if(n==null)return Promise.reject(Error(\`Linux Computer Use backend is not installed\`));let r=codexLinuxAppshotRequire(\`node:child_process\`);return new Promise((i,a)=>{r.execFile(n,e,{encoding:\`utf8\`,timeout:t,maxBuffer:67108864},(e,t,n)=>{if(e!=null){a(Error((n||e.message||\`Linux Computer Use backend failed\`).trim()));return}try{i(JSON.parse(t))}catch(e){a(Error(\`Linux Computer Use backend returned invalid JSON\`))}})})}
function codexLinuxAppshotFirstString(...e){for(let t of e)if(typeof t==\`string\`&&t.trim().length>0)return t.trim();return null}
function codexLinuxAppshotWindowForRenderer(e){if(e==null||typeof e!=\`object\`)return null;let t=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.title,\`Linux app\`),n=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.pid!=null?\`pid:\${e.pid}\`:null,e.window_id!=null?\`window:\${e.window_id}\`:null,t),r=codexLinuxAppshotFirstString(e.title);return{name:t,appName:t,bundleIdentifier:n,windowTitle:r,iconSmallDataURL:null,appIconDataUrl:null}}
function codexLinuxAppshotFocusedWindowFromReport(e){let t=Array.isArray(e?.windows)?e.windows:[],n=t.find(e=>e?.focused)||null;return{focusedWindow:n,windows:t,backend:codexLinuxAppshotFirstString(e?.backend)}}
async function codexLinuxAppshotFocusedWindow(){let e=await codexLinuxAppshotBackendJson([\`windows\`],5000);return codexLinuxAppshotFocusedWindowFromReport(e)}
async function codexLinuxAppshotFrontmostWindow(){if(process.platform!==\`linux\`)return null;try{let e=await codexLinuxAppshotFocusedWindow();return codexLinuxAppshotWindowForRenderer(e.focusedWindow)}catch{return null}}
function codexLinuxAppshotSend(e,t,n){try{${sendMessageFn}(e,{requestId:t,type:\`computer-use-capture-updated\`,update:n})}catch{}}
function codexLinuxAppshotStartCapture({origin:e,requestId:t,bundleIdentifier:n}){if(process.platform!==\`linux\`)return null;setTimeout(()=>{codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n}).catch(()=>codexLinuxAppshotSend(e,t,{type:\`failed\`}))},0);return{animationDuration:0,transitionSnapshotHeight:140,transitionSpringDampingFraction:1,transitionSpringResponse:0}}
async function codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n}){let r=await codexLinuxAppshotFocusedWindow(),i=codexLinuxAppshotWindowForRenderer(r.focusedWindow);if(i==null){codexLinuxAppshotSend(e,t,{type:\`failed\`});return}codexLinuxAppshotSend(e,t,{type:\`metadata\`,app:{bundleIdentifier:i.bundleIdentifier,name:i.name,windowTitle:i.windowTitle,iconSmallDataURL:null}});let a=await codexLinuxAppshotAccessibilityNodes(r.focusedWindow,n),o=codexLinuxAppshotAccessibilityText(r.focusedWindow,a.nodes,a.error);typeof o==\`string\`&&o.length>0&&codexLinuxAppshotSend(e,t,{type:\`axText\`,text:o});let s=await codexLinuxAppshotScreenshot(r.focusedWindow,r.windows);if(s==null||typeof s.dataURL!=\`string\`||s.dataURL.length===0){codexLinuxAppshotSend(e,t,{type:\`failed\`});return}codexLinuxAppshotSend(e,t,{type:\`screenshot\`,screenshotDataURL:s.dataURL});codexLinuxAppshotSend(e,t,{type:\`completed\`,transitionSnapshotDataURL:s.dataURL})}
async function codexLinuxAppshotAccessibilityNodes(e,t){let n=[],r=new Set,a=o=>{let s=codexLinuxAppshotFirstString(o);s!=null&&!r.has(s)&&(r.add(s),n.push(s))};a(t),a(e?.app_id),a(e?.wm_class),a(e?.title),a(\`electron\`);let o=null;for(let e of n){try{let t=await codexLinuxAppshotBackendJson([\`state\`,e],10000);if(Array.isArray(t)&&t.length>0)return{nodes:t,candidate:e,error:null}}catch(e){o=e}}return{nodes:[],candidate:null,error:o instanceof Error?o.message:String(o||\`\`)}}
function codexLinuxAppshotAccessibilityText(e,t,n){let r=codexLinuxAppshotFirstString(e?.app_id,e?.wm_class,\`Linux app\`),i=codexLinuxAppshotFirstString(e?.title,\`\`),a=[\`Linux AppShot accessibility snapshot\`,\`Application: \${r}\`,\`Window: "\${i}"\`,\`\`,\`Elements:\`];if(!Array.isArray(t)||t.length===0){n&&a.push(\`- error text="\${String(n).slice(0,240)}"\`);return a.join(\`\\n\`)}for(let e of t.slice(0,120))a.push(codexLinuxAppshotNodeLine(e));return a.join(\`\\n\`)}
function codexLinuxAppshotNodeLine(e){let t=Number.isFinite(e?.depth)?Math.max(0,Math.min(12,e.depth)):0,n=\`  \`.repeat(t),r=codexLinuxAppshotFirstString(e?.role,\`node\`),i=codexLinuxAppshotFirstString(e?.name),a=codexLinuxAppshotFirstString(e?.text),o=Array.isArray(e?.states)?e.states.filter(Boolean).slice(0,8).join(\`,\`):null,s=e?.bounds?\` bounds=\${Math.round(Number(e.bounds.width)||0)}x\${Math.round(Number(e.bounds.height)||0)}+\${Math.round(Number(e.bounds.x)||0)}+\${Math.round(Number(e.bounds.y)||0)}\`:\`\`;return\`\${n}- \${r}\${i?\` name="\${codexLinuxAppshotCleanText(i,120)}"\`:\`\`}\${a?\` text="\${codexLinuxAppshotCleanText(a,160)}"\`:\`\`}\${s}\${o?\` states=\${o}\`:\`\`}\`}
function codexLinuxAppshotCleanText(e,t){return String(e).replace(/[\\r\\n\\t]+/g,\` \`).replace(/"/g,\`'\`).trim().slice(0,t)}
function codexLinuxAppshotScreenshotCommands(e){return[{source:\`grim\`,programs:[\`grim\`,\`/usr/bin/grim\`],args:[],output:\`append\`},{source:\`spectacle\`,programs:[\`spectacle\`,\`/usr/bin/spectacle\`],args:[\`-b\`,\`-n\`],output:[\`-o\`]},{source:\`gnome-screenshot\`,programs:[\`gnome-screenshot\`,\`/usr/bin/gnome-screenshot\`],args:[],output:[\`-f\`]},{source:\`maim\`,programs:[\`maim\`,\`/usr/bin/maim\`],args:[],output:\`append\`},{source:\`scrot\`,programs:[\`scrot\`,\`/usr/bin/scrot\`],args:[],output:\`append\`},{source:\`imagemagick-import\`,programs:[\`import\`,\`/usr/bin/import\`],args:[\`-window\`,\`root\`],output:\`append\`}]}
async function codexLinuxAppshotScreenshot(e,t){
let n=codexLinuxAppshotRequire(\`node:fs\`),r=codexLinuxAppshotRequire(\`node:os\`),i=codexLinuxAppshotRequire(\`node:path\`),a=codexLinuxAppshotRequire(\`node:child_process\`),o=codexLinuxAppshotRequire(\`electron\`).nativeImage,s=codexLinuxAppshotCropRects(e,t);
if(s.length===0)return codexLinuxAppshotWarn(\`screenshot-crop-missing\`,{hasBounds:e?.bounds!=null}),null;
for(let c of codexLinuxAppshotScreenshotCommands(e))for(let l of c.programs){
let u=i.join(r.tmpdir(),\`codex-appshot-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}.png\`),d=i.join(r.tmpdir(),\`codex-appshot-crop-\${process.pid}-\${Date.now()}-\${Math.random().toString(16).slice(2)}.png\`),f=c.output===\`append\`?[...c.args,u]:[...c.args,...c.output,u];
try{
await codexLinuxAppshotExecFile(a,l,f,{timeout:15000,maxBuffer:8388608});
if(!n.existsSync(u)){codexLinuxAppshotWarn(\`screenshot-output-missing\`,{source:c.source,program:l});continue}
let e=n.statSync(u);if(e.size<=0){codexLinuxAppshotWarn(\`screenshot-output-empty\`,{source:c.source,program:l});continue}
let t=await codexLinuxAppshotCropWithImageMagick({childProcess:a,fs:n,sourcePath:u,tmpPath:d,cropRects:s});
if(t!=null)return{dataURL:t.dataURL,width:t.width,height:t.height,source:\`\${c.source}:imagemagick-window-crop\`};
let r=codexLinuxAppshotCropNativeImage(o,u,s);
if(r!=null)return{dataURL:r.image.toDataURL(),width:r.width,height:r.height,source:\`\${c.source}:feature-window-crop\`}
}catch(e){codexLinuxAppshotWarn(\`screenshot-command-failed\`,{source:c.source,program:l,message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`})}
finally{try{n.rmSync(u,{force:true})}catch{}try{n.rmSync(d,{force:true})}catch{}}
}
return codexLinuxAppshotWarn(\`screenshot-all-commands-failed\`,{commandCount:codexLinuxAppshotScreenshotCommands(e).length}),null
}
function codexLinuxAppshotExecFile(e,t,n,r){return new Promise((i,a)=>{e.execFile(t,n,r,(e,t,n)=>{if(e!=null){e.codexStderr=String(n||\`\`);a(e);return}i({stdout:t,stderr:n})})})}
function codexLinuxAppshotCropNativeImage(e,t,n){let r=e.createFromPath(t),i=r.getSize();if(i.width<=0||i.height<=0)return codexLinuxAppshotWarn(\`screenshot-native-image-empty\`,{}),null;let a=codexLinuxAppshotFirstValidCrop(n,i);if(a==null)return codexLinuxAppshotWarn(\`screenshot-native-crop-invalid\`,{width:i.width,height:i.height,cropCount:n.length}),null;let o=r.crop(a),s=o.getSize();return s.width<=0||s.height<=0?(codexLinuxAppshotWarn(\`screenshot-native-crop-empty\`,a),null):{image:o,width:s.width,height:s.height}}
async function codexLinuxAppshotCropWithImageMagick({childProcess:e,fs:t,sourcePath:n,tmpPath:r,cropRects:i}){try{let a=await codexLinuxAppshotExecFirst(e,[\`identify\`,\`/usr/bin/identify\`],[\`-format\`,\`%w %h\`,n],{timeout:5000,maxBuffer:1024},\`screenshot-identify-failed\`),o=String(a.stdout||\`\`).trim().split(/\\s+/).map(Number),s={width:o[0],height:o[1]},c=codexLinuxAppshotFirstValidCrop(i,s);if(c==null)return codexLinuxAppshotWarn(\`screenshot-identify-crop-invalid\`,{width:s.width,height:s.height,cropCount:i.length}),null;await codexLinuxAppshotExecFirst(e,[\`convert\`,\`/usr/bin/convert\`],[n,\`-crop\`,\`\${c.width}x\${c.height}+\${c.x}+\${c.y}\`,\`+repage\`,r],{timeout:10000,maxBuffer:8388608},\`screenshot-convert-failed\`);if(!t.existsSync(r)||t.statSync(r).size<=0)return codexLinuxAppshotWarn(\`screenshot-convert-output-empty\`,{}),null;return{dataURL:\`data:image/png;base64,\${t.readFileSync(r).toString(\`base64\`)}\`,width:c.width,height:c.height}}catch(e){return codexLinuxAppshotWarn(\`screenshot-imagemagick-crop-failed\`,{message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`}),null}}
async function codexLinuxAppshotExecFirst(e,t,n,r,i){let a=null;for(let o of t)try{return await codexLinuxAppshotExecFile(e,o,n,r)}catch(e){a=e;codexLinuxAppshotWarn(i,{program:o,message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`})}throw a??Error(\`No command available\`)}
function codexLinuxAppshotWarn(e,t={}){try{console.warn(\`[linux-appshots] \${e}\`,t)}catch{}}
function codexLinuxAppshotCropRects(e,t){let n=e?.bounds;if(n==null)return[];let r=[n.x,n.y,n.width,n.height].map(Number);if(!r.every(Number.isFinite)||r[2]<=0||r[3]<=0)return[];let i=Math.round(r[0]),a=Math.round(r[1]),o=Math.round(r[2]),s=Math.round(r[3]),c=[{x:i,y:a,width:o,height:s}],l=Array.isArray(t)?t:[],u=l.map(e=>Number(e?.bounds?.x)).filter(Number.isFinite),d=l.map(e=>Number(e?.bounds?.y)).filter(Number.isFinite);if(u.length>0||d.length>0){let e=u.length>0?Math.min(...u):0,t=d.length>0?Math.min(...d):0;c.push({x:Math.round(i-e),y:Math.round(a-t),width:o,height:s})}return c.push({x:0,y:0,width:o,height:s}),codexLinuxAppshotUniqueCropRects(c)}
function codexLinuxAppshotUniqueCropRects(e){let t=new Set,n=[];for(let r of e){let e=\`\${r.x}:\${r.y}:\${r.width}:\${r.height}\`;t.has(e)||(t.add(e),n.push(r))}return n}
function codexLinuxAppshotFirstValidCrop(e,t){for(let n of e){let e=codexLinuxAppshotClampCrop(n,t);if(e!=null)return e}return null}
function codexLinuxAppshotClampCrop(e,t){if(!Number.isFinite(t?.width)||!Number.isFinite(t?.height)||t.width<=0||t.height<=0)return null;let n=Math.max(0,e.x),r=Math.max(0,e.y),i=Math.min(e.width,t.width-n),a=Math.min(e.height,t.height-r);return!Number.isFinite(i)||!Number.isFinite(a)||i<=0||a<=0?null:{x:n,y:r,width:i,height:a}}
`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const descriptors = [
  {
    id: "linux-appshots-main-process",
    phase: "main-bundle",
    order: 142,
    apply: applyLinuxAppshotMainProcessPatch,
  },
  {
    id: "linux-appshots-availability",
    phase: "webview-asset",
    order: 1090,
    pattern: /^use-is-appshot-available-.*\.js$/,
    missingDescription: "AppShots availability bundle",
    skipDescription: "Linux AppShots availability patch",
    apply: applyLinuxAppshotAvailabilityPatch,
  },
  {
    id: "linux-appshots-hotkey",
    phase: "main-bundle",
    order: 143,
    apply: applyLinuxAppshotHotkeyPatch,
  },
  {
    id: "linux-appshots-settings-hotkey",
    phase: "webview-asset",
    order: 1091,
    pattern: /^appshots-settings-.*\.js$/,
    missingDescription: "AppShots settings bundle",
    skipDescription: "Linux AppShots settings hotkey patch",
    apply: applyLinuxAppshotSettingsHotkeyPatch,
  },
];

module.exports = {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  applyLinuxAppshotSettingsHotkeyPatch,
  descriptors,
  findMessageForViewSendFunction,
};
