"use strict";

const APPSHOT_HELPER_MARKER = "codexLinuxAppshotStartCapture";
const LINUX_APPSHOT_X11_HOTKEYS = [
  { hotkey: "DoubleOption", label: "Alt + Alt" },
  { hotkey: "DoubleShift", label: "Shift + Shift" },
  { hotkey: "Ctrl+Super+A", label: "Ctrl + Super + A" },
];
const LINUX_APPSHOT_WAYLAND_HOTKEYS = [
  { hotkey: "Ctrl+Super+A", label: "Ctrl + Super + A" },
];

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyLinuxAppshotAvailabilityPatch(currentSource) {
  if (currentSource.includes("!==`linux`&&(") && currentSource.includes("!==`macOS`||")) {
    return currentSource;
  }

  let changed = false;
  const patchedSource = currentSource.replace(
    /if\(([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)!==`macOS`\|\|!([A-Za-z_$][\w$]*)\(([^)]*?)\)\)return!1;/g,
    (match, platformGetFn, platformAtomVar, flagGetFn, flagArgs) => {
      changed = true;
      return `if(${platformGetFn}(${platformAtomVar})!==\`linux\`&&(${platformGetFn}(${platformAtomVar})!==\`macOS\`||!${flagGetFn}(${flagArgs})))return!1;`;
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
    return currentSource;
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
  const alreadyPatched = [
    /this\.configuredHotkey=[A-Za-z_$][\w$]*===void 0\?\(process\.platform===`linux`\?null:[A-Za-z_$][\w$]*\):[A-Za-z_$][\w$]*/,
    /supported:this\.enabled&&\(process\.platform===`darwin`\|\|process\.platform===`linux`\),configuredHotkey:this\.configuredHotkey,isActive:this\.registration!=null,linuxWayland:codexLinuxAppshotIsWayland\(\)/,
    /if\(!this\.enabled\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\)return\{success:!1,error:`Not supported\.`,state:this\.getState\(\)\}/,
    /!this\.enabled\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\|\|this\.configuredHotkey==null/,
    /return [A-Za-z_$][\w$]*\.length===1\?\([A-Za-z_$][\w$]*===`darwin`\|\|[A-Za-z_$][\w$]*===`linux`\)\?/,
    /return \([A-Za-z_$][\w$]*===`darwin`\|\|[A-Za-z_$][\w$]*===`linux`&&!codexLinuxAppshotIsWayland\(\)\)&&/,
    /if\(process\.platform!==`darwin`&&process\.platform!==`linux`\)return null/,
    /new Set\(\[\.\.\.[A-Za-z_$][\w$]*,`shift`,`super`,`meta`,`win`\]\)/,
  ].every((pattern) => pattern.test(currentSource));
  if (alreadyPatched && currentSource.includes("function codexLinuxAppshotIsWayland")) {
    return currentSource;
  }

  let patchedSource = currentSource;
  const counts = [];
  function replaceRequired(pattern, replacement) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const count = [...patchedSource.matchAll(new RegExp(pattern.source, flags))].length;
    counts.push(count);
    if (count !== 1) {
      return;
    }
    patchedSource = patchedSource.replace(pattern, replacement);
  }

  replaceRequired(
    /this\.configuredHotkey=([A-Za-z_$][\w$]*)===void 0\?([A-Za-z_$][\w$]*):\1/,
    (match, storedVar, defaultHotkeyVar) =>
      `this.configuredHotkey=${storedVar}===void 0?(process.platform===\`linux\`?null:${defaultHotkeyVar}):${storedVar}`,
  );
  replaceRequired(
    /getState\(\)\{return\{supported:this\.enabled&&process\.platform===`darwin`,configuredHotkey:this\.configuredHotkey,isActive:this\.registration!=null\}\}/,
    "getState(){return{supported:this.enabled&&(process.platform===`darwin`||process.platform===`linux`),configuredHotkey:this.configuredHotkey,isActive:this.registration!=null,linuxWayland:codexLinuxAppshotIsWayland()}}",
  );
  replaceRequired(
    /if\(!this\.enabled\|\|process\.platform!==`darwin`\)return\{success:!1,error:`Not supported\.`,state:this\.getState\(\)\}/,
    "if(!this.enabled||process.platform!==`darwin`&&process.platform!==`linux`)return{success:!1,error:`Not supported.`,state:this.getState()}",
  );
  replaceRequired(
    /!this\.enabled\|\|process\.platform!==`darwin`\|\|this\.configuredHotkey==null/,
    "!this.enabled||process.platform!==`darwin`&&process.platform!==`linux`||this.configuredHotkey==null",
  );
  replaceRequired(
    /return ([A-Za-z_$][\w$]*)\.length===1\?([A-Za-z_$][\w$]*)===`darwin`\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\2\)\?null:`This shortcut key is not supported\.`:`Choose a shortcut with Ctrl or Alt plus another key\.`:`Use Ctrl, Alt, or Command when combining with another key\.`/,
    (match, partsVar, platformVar, supportedBareModifierFn, hotkeyVar) =>
      `return ${partsVar}.length===1?(${platformVar}===\`darwin\`||${platformVar}===\`linux\`)?${supportedBareModifierFn}(${hotkeyVar},${platformVar})?null:\`This shortcut key is not supported.\`:\`Choose a shortcut with Ctrl or Alt plus another key.\`:\`Use Ctrl, Alt, or Command when combining with another key.\``,
  );
  replaceRequired(
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=process\.platform\)\{return \3===`darwin`&&([A-Za-z_$][\w$]*)\(\2\)!=null\}/,
    (match, fnName, hotkeyVar, platformVar, modifierFn) =>
      `function ${fnName}(${hotkeyVar},${platformVar}=process.platform){return (${platformVar}===\`darwin\`||${platformVar}===\`linux\`&&!codexLinuxAppshotIsWayland())&&${modifierFn}(${hotkeyVar})!=null}`,
  );
  replaceRequired(
    /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=`press`\)\{if\(process\.platform!==`darwin`\)return null;/,
    (match, fnName, hotkeyVar, handlerVar, triggerVar) =>
      `function ${fnName}(${hotkeyVar},${handlerVar},${triggerVar}=\`press\`){if(process.platform!==\`darwin\`&&process.platform!==\`linux\`)return null;`,
  );
  replaceRequired(
    /new Set\(\[\.\.\.([A-Za-z_$][\w$]*),`shift`\]\)/,
    (match, baseModifiersVar) =>
      `new Set([...${baseModifiersVar},\`shift\`,\`super\`,\`meta\`,\`win\`])`,
  );

  if (counts.every((count) => count === 1)) {
    return withLinuxAppshotWaylandHelper(patchedSource);
  }

  if (currentSource.includes("appshotHotkey") || currentSource.includes("appshot-hotkey-state")) {
    warn("Could not find current AppShots hotkey class", "Linux AppShots hotkey patch");
  }
  return currentSource;
}

function applyLinuxAppshotSettingsHotkeyPatch(currentSource) {
  const linuxX11Options = `[${LINUX_APPSHOT_X11_HOTKEYS.map(
    (option) => `{hotkey:\`${option.hotkey}\`,label:\`${option.label}\`}`,
  ).join(",")}]`;
  const linuxWaylandOptions = `[${LINUX_APPSHOT_WAYLAND_HOTKEYS.map(
    (option) => `{hotkey:\`${option.hotkey}\`,label:\`${option.label}\`}`,
  ).join(",")}]`;
  if (currentSource.includes("codexLinuxAppshotHotkeyOptions")) {
    return currentSource;
  }

  const stateDataVar =
    currentSource.match(/\b([A-Za-z_$][\w$]*)\?\.configuredHotkey\?\?null/)?.[1] ?? null;
  if (stateDataVar == null) {
    if (currentSource.includes("appshot-hotkey-state") || currentSource.includes("DoubleCommand")) {
      warn("Could not find AppShots settings state binding", "Linux AppShots settings hotkey patch");
    }
    return currentSource;
  }

  let optionsMatched = false;
  let optionsVarName = null;
  let patchedSource = currentSource.replace(
    /((?:var\s+|,)([A-Za-z_$][\w$]*)=)(\[\{hotkey:`DoubleCommand`,label:`[^`]+`\},\{hotkey:`DoubleOption`,label:`[^`]+`\},\{hotkey:`DoubleShift`,label:`[^`]+`\}\])(?=[,;)}])/,
    (match, declarationPrefix, optionsVar, macOptions) => {
      optionsMatched = true;
      optionsVarName = optionsVar;
      return `${declarationPrefix}${macOptions}`;
    },
  );

  let patchedFind = false;
  let patchedMap = false;
  if (optionsMatched && optionsVarName != null) {
    const findResult = replaceIdentifierCall(
      patchedSource,
      optionsVarName,
      "find",
      `codexLinuxAppshotHotkeyOptions(${stateDataVar}).find(`,
    );
    patchedSource = findResult.source;
    patchedFind = findResult.count > 0;
    const mapResult = replaceIdentifierCall(
      patchedSource,
      optionsVarName,
      "map",
      `codexLinuxAppshotHotkeyOptions(${stateDataVar}).map(`,
    );
    patchedSource = mapResult.source;
    patchedMap = mapResult.count > 0;
  }

  if (optionsMatched && patchedFind && patchedMap) {
    const helper =
      `function codexLinuxAppshotHotkeyOptions(e){return typeof navigator!=\`undefined\`&&navigator.userAgent.includes(\`Linux\`)?e?.linuxWayland?${linuxWaylandOptions}:${linuxX11Options}:${optionsVarName}}`;
    const sourceMapIndex = patchedSource.lastIndexOf("\n//# sourceMappingURL=");
    if (sourceMapIndex >= 0) {
      return `${patchedSource.slice(0, sourceMapIndex)};${helper}${patchedSource.slice(sourceMapIndex)}`;
    }
    return `${patchedSource}\n;${helper}`;
  }

  if (optionsMatched) {
    warn("Could not find both AppShots settings hotkey option call sites", "Linux AppShots settings patch");
    return currentSource;
  }

  if (currentSource.includes("appshot-hotkey-state") || currentSource.includes("DoubleCommand")) {
    warn("Could not find AppShots settings hotkey options", "Linux AppShots settings patch");
  }
  return currentSource;
}

function linuxAppshotWaylandHelperSource() {
  return "function codexLinuxAppshotIsWayland(){return process.platform===`linux`&&((process.env.XDG_SESSION_TYPE||``).toLowerCase()===`wayland`||!!process.env.WAYLAND_DISPLAY)}";
}

function withLinuxAppshotWaylandHelper(source) {
  if (source.includes("function codexLinuxAppshotIsWayland")) {
    return source;
  }
  return `${linuxAppshotWaylandHelperSource()}${source}`;
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
let u=null;
try{
u=n.mkdtempSync(i.join(r.tmpdir(),\`codex-appshot-\`)),n.chmodSync(u,448);let d=i.join(u,\`source.png\`),f=i.join(u,\`crop.png\`),p=c.output===\`append\`?[...c.args,d]:[...c.args,...c.output,d];
await codexLinuxAppshotExecFile(a,l,p,{timeout:15000,maxBuffer:8388608});
if(!n.existsSync(d)){codexLinuxAppshotWarn(\`screenshot-output-missing\`,{source:c.source,program:l});continue}
let e=n.statSync(d);if(e.size<=0){codexLinuxAppshotWarn(\`screenshot-output-empty\`,{source:c.source,program:l});continue}
let t=await codexLinuxAppshotCropWithImageMagick({childProcess:a,fs:n,sourcePath:d,tmpPath:f,cropRects:s});
if(t!=null)return{dataURL:t.dataURL,width:t.width,height:t.height,source:\`\${c.source}:imagemagick-window-crop\`};
let h=codexLinuxAppshotCropNativeImage(o,d,s);
if(h!=null)return{dataURL:h.image.toDataURL(),width:h.width,height:h.height,source:\`\${c.source}:feature-window-crop\`}
}catch(e){codexLinuxAppshotWarn(\`screenshot-command-failed\`,{source:c.source,program:l,message:e instanceof Error?e.message:String(e),stderr:typeof e?.codexStderr===\`string\`?e.codexStderr.slice(0,200):\`\`})}
finally{if(u!=null)try{n.rmSync(u,{recursive:true,force:true})}catch{}}
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

function replaceIdentifierCall(source, identifier, method, replacement) {
  const needle = `${identifier}.${method}(`;
  let count = 0;
  let cursor = 0;
  let output = "";

  while (cursor < source.length) {
    const matchIndex = source.indexOf(needle, cursor);
    if (matchIndex < 0) {
      output += source.slice(cursor);
      break;
    }
    const previous = matchIndex > 0 ? source[matchIndex - 1] : "";
    if (previous === "." || /[A-Za-z0-9_$]/.test(previous)) {
      const nextCursor = matchIndex + needle.length;
      output += source.slice(cursor, nextCursor);
      cursor = nextCursor;
      continue;
    }
    output += source.slice(cursor, matchIndex) + replacement;
    cursor = matchIndex + needle.length;
    count += 1;
  }

  return { source: output, count };
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
    pattern: /^app-initial~app-main~page-[^.]+\.js$/,
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
