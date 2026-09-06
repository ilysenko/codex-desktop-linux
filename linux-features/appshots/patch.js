"use strict";

const APPSHOT_HELPER_MARKER = "codexLinuxAppshotStartCapture";

function warn(message, patchName) {
  console.warn(`WARN: ${message} - skipping ${patchName}`);
}

function applyLinuxAppshotAvailabilityPatch(currentSource) {
  const marker = "codexLinuxAppshotsPlatformAvailable";
  if (currentSource.includes(marker)) {
    return currentSource;
  }
  const platformGate = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return \2===`macOS`\|\|\2===`windows`&&\3!=null&&([A-Za-z_$][\w$]*)\.isInternal\(\3\)\}/g;
  const matches = [...currentSource.matchAll(platformGate)];
  if (matches.length === 1) {
    return currentSource.replace(
      platformGate,
      (_match, functionName, platformVar, buildFlavorVar, buildFlavorType) =>
        `function ${functionName}(${platformVar},${buildFlavorVar}){return ${platformVar}===\`linux\`/*${marker}*/||${platformVar}===\`macOS\`||${platformVar}===\`windows\`&&${buildFlavorVar}!=null&&${buildFlavorType}.isInternal(${buildFlavorVar})}`,
    );
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

  if (!currentSource.includes(".sendInlineMessageForView(")) {
    warn("Could not find inline renderer message sender", "Linux AppShots main-process patch");
    return currentSource;
  }

  const frontmostPattern = /("computer-use-frontmost-window":async\(\{origin:[A-Za-z_$][\w$]*,signal:[A-Za-z_$][\w$]*\}\)=>)(?=process\.platform===`win32`)/g;
  const capturePattern = /("computer-use-start-capture":async\(\{animationDestination:([A-Za-z_$][\w$]*),animationPresentationStyle:[A-Za-z_$][\w$]*,bundleIdentifier:([A-Za-z_$][\w$]*),origin:([A-Za-z_$][\w$]*),requestId:([A-Za-z_$][\w$]*),signal:[A-Za-z_$][\w$]*\}\)=>\{)if\(process\.platform!==`darwin`&&process\.platform!==`win32`\)return null;/g;
  const frontmostMatches = [...currentSource.matchAll(frontmostPattern)];
  const captureMatches = [...currentSource.matchAll(capturePattern)];
  if (frontmostMatches.length !== 1 || captureMatches.length !== 1) {
    if (currentSource.includes("computer-use-frontmost-window") || currentSource.includes("computer-use-start-capture")) {
      warn("Could not find AppShots main-process handlers", "Linux AppShots main-process patch");
    }
    return currentSource;
  }
  let patchedSource = currentSource.replace(
    frontmostPattern,
    "$1process.platform===`linux`?codexLinuxAppshotFrontmostWindow():",
  );
  patchedSource = patchedSource.replace(
    capturePattern,
    (_match, prefix, _animationDestinationVar, bundleIdentifierVar, originVar, requestIdVar) =>
      `${prefix}if(process.platform===\`linux\`)return codexLinuxAppshotStartCapture({origin:${originVar},requestId:${requestIdVar},bundleIdentifier:${bundleIdentifierVar},windowManager:this.windowManager});if(process.platform!==\`darwin\`&&process.platform!==\`win32\`)return null;`,
  );

  return appendLinuxAppshotHelper(patchedSource);
}

function applyLinuxAppshotHotkeyPatch(currentSource) {
  const marker = "codexLinuxAppshotIsWayland";
  if (currentSource.includes(`function ${marker}`)) {
    return currentSource;
  }
  const replacements = [
    [/function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=process\.platform\)\{return \3===`darwin`&&([A-Za-z_$][\w$]*)\(\2\)!=null\}/g, (_m, f, e, p, n) => `function ${f}(${e},${p}=process.platform){return (${p}===\`darwin\`||${p}===\`linux\`&&!codexLinuxAppshotIsWayland())&&${n}(${e})!=null}`],
    [/function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=`press`\)\{if\(process\.platform!==`darwin`\)return null;/g, (_m, f, e, h, t) => `function ${f}(${e},${h},${t}=\`press\`){if(process.platform!==\`darwin\`&&process.platform!==\`linux\`)return null;`],
    [/new Set\(\[\.\.\.([A-Za-z_$][\w$]*),`shift`\]\)/g, (_m, base) => `new Set([...${base},\`shift\`,\`super\`,\`meta\`,\`win\`])`],
    [/([A-Za-z_$][\w$]*)===void 0\?this\.configuredHotkey=process\.platform===`win32`\?([A-Za-z_$][\w$]*):([A-Za-z_$][\w$]*):this\.configuredHotkey=\1/g, (_m, stored, windowsDefault, macDefault) => `${stored}===void 0?this.configuredHotkey=process.platform===\`win32\`?${windowsDefault}:process.platform===\`linux\`?null:${macDefault}:this.configuredHotkey=${stored}`],
    [/supported:this\.enabled&&\(process\.platform===`darwin`\|\|process\.platform===`win32`&&this\.windowsCaptureNativeBridge!=null&&!this\.windowsCaptureNativeBridgeFailed\),configuredHotkey:this\.configuredHotkey,isActive:this\.registration!=null/g, "supported:this.enabled&&(process.platform===`linux`||process.platform===`darwin`||process.platform===`win32`&&this.windowsCaptureNativeBridge!=null&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:this.registration!=null,linuxWayland:codexLinuxAppshotIsWayland()"],
  ];
  let patchedSource = currentSource;
  const counts = [];
  for (const [pattern, replacement] of replacements) {
    const matches = [...patchedSource.matchAll(pattern)];
    counts.push(matches.length);
    if (matches.length === 1) patchedSource = patchedSource.replace(pattern, replacement);
  }
  if (counts.every((count) => count === 1)) return withLinuxAppshotWaylandHelper(patchedSource);

  if (currentSource.includes("appshotHotkey") || currentSource.includes("appshot-hotkey-state")) {
    warn("Could not find current AppShots hotkey class", "Linux AppShots hotkey patch");
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

function appendLinuxAppshotHelper(source) {
  return `${source}
;function codexLinuxAppshotRequire(e){return require(e)}
function codexLinuxAppshotBackendPath(){let e=codexLinuxAppshotRequire(\`node:fs\`),t=codexLinuxAppshotRequire(\`node:path\`),n=codexLinuxAppshotRequire(\`node:os\`),r=process.env.CODEX_ELECTRON_RESOURCES_PATH||process.resourcesPath,i=process.env.CODEX_HOME||(process.env.HOME?t.join(process.env.HOME,\`.codex\`):t.join(n.homedir(),\`.codex\`)),a=[process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE,r&&t.join(r,\`plugins\`,\`openai-bundled\`,\`plugins\`,\`computer-use\`,\`bin\`,\`codex-computer-use-linux\`),i&&t.join(i,\`plugins\`,\`cache\`,\`openai-bundled\`,\`computer-use\`,\`latest\`,\`bin\`,\`codex-computer-use-linux\`)];for(let t of a){if(typeof t!=\`string\`||t.length===0)continue;try{if(e.existsSync(t))return t}catch{}}return null}
function codexLinuxAppshotBackendJson(e,t=10000){let n=codexLinuxAppshotBackendPath();if(n==null)return Promise.reject(Error(\`Linux Computer Use backend is not installed\`));let r=codexLinuxAppshotRequire(\`node:child_process\`);return new Promise((i,a)=>{r.execFile(n,e,{encoding:\`utf8\`,timeout:t,maxBuffer:67108864},(e,t,n)=>{if(e!=null){a(Error((n||e.message||\`Linux Computer Use backend failed\`).trim()));return}try{i(JSON.parse(t))}catch(e){a(Error(\`Linux Computer Use backend returned invalid JSON\`))}})})}
function codexLinuxAppshotFirstString(...e){for(let t of e)if(typeof t==\`string\`&&t.trim().length>0)return t.trim();return null}
function codexLinuxAppshotWindowForRenderer(e){if(e==null||typeof e!=\`object\`)return null;let t=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.title,\`Linux app\`),n=codexLinuxAppshotFirstString(e.app_id,e.wm_class,e.pid!=null?\`pid:\${e.pid}\`:null,e.window_id!=null?\`window:\${e.window_id}\`:null,t),r=codexLinuxAppshotFirstString(e.title);return{name:t,appName:t,bundleIdentifier:n,windowTitle:r,iconSmallDataURL:null,appIconDataUrl:null}}
function codexLinuxAppshotFocusedWindowFromReport(e){let t=Array.isArray(e?.windows)?e.windows:[],n=t.find(e=>e?.focused)||null;return{focusedWindow:n,windows:t,backend:codexLinuxAppshotFirstString(e?.backend)}}
function codexLinuxAppshotOwnWindow(e){if(e==null||typeof e!=\`object\`)return!1;let t=[e.app_id,e.wm_class,e.title].filter(e=>typeof e==\`string\`).join(\` \`).toLowerCase();return Number(e.pid)===process.pid||t.includes(\`codex-desktop\`)||t.includes(\`chatgpt community\`)}
function codexLinuxAppshotOwnOrPortalWindow(e){if(codexLinuxAppshotOwnWindow(e))return!0;let t=[e?.app_id,e?.wm_class,e?.title].filter(e=>typeof e==\`string\`).join(\` \`).toLowerCase();return t.includes(\`xdg-desktop-portal\`)}
function codexLinuxAppshotWindowId(e){if(typeof e===\`number\`&&Number.isFinite(e))return e;if(typeof e!==\`string\`||!/^0x[0-9a-f]+$/i.test(e))return null;let t=Number.parseInt(e.slice(2),16);return Number.isSafeInteger(t)?t:null}
function codexLinuxAppshotPreviousExternalWindow(e,t){let n=Array.isArray(e)?e:[],r=Array.isArray(t)?t:[];for(let e of r){if(e?.mapped===!1||e?.hidden===!0)continue;let t=codexLinuxAppshotWindowId(e?.window_id??e?.address),r=codexLinuxAppshotFirstString(e?.wm_class,e?.app_id,e?.class,e?.initialClass),i=n.find(n=>t!=null&&Number(n?.window_id)===t||e?.pid!=null&&Number.isFinite(Number(e.pid))&&Number(n?.pid)===Number(e.pid)&&codexLinuxAppshotFirstString(n?.wm_class,n?.app_id)===r);if(i!=null&&i?.hidden!==!0&&!codexLinuxAppshotOwnOrPortalWindow(i))return i}return null}
function codexLinuxAppshotExecutablePath(e){let t=codexLinuxAppshotRequire(\`node:fs\`),n=codexLinuxAppshotRequire(\`node:path\`),r=[];for(let t of Array.isArray(e)?e:[])typeof t===\`string\`&&t.length>0&&(t.includes(n.sep)?r.push(t):r.push(...String(process.env.PATH||\`\`).split(n.delimiter).filter(Boolean).map(e=>n.join(e,t))));for(let e of r)try{t.accessSync(e,t.constants.X_OK);return e}catch{}return null}
function codexLinuxAppshotHyprlandPicker(){let e=codexLinuxAppshotExecutablePath([process.env.CODEX_LINUX_APPSHOT_PICKER,\`hyprland-preview-share-picker\`,\`hyprland-share-picker\`]);if(e==null)return null;let t=codexLinuxAppshotRequire(\`node:path\`).basename(e);return{path:e,preview:t===\`hyprland-preview-share-picker\`}}
function codexLinuxAppshotHyprlandPickerConfig(e){if(e?.preview!==!0)return{args:[],cleanup:()=>{}};let t=codexLinuxAppshotRequire(\`node:fs\`),n=codexLinuxAppshotRequire(\`node:path\`),r=codexLinuxAppshotRequire(\`node:os\`),i=process.env.HOME||r.homedir(),a=n.join(i,\`.config\`,\`hyprland-preview-share-picker\`,\`config.yaml\`);try{if(!t.existsSync(a))return{args:[],cleanup:()=>{}};let r=t.readFileSync(a,\`utf8\`),i=[...r.matchAll(/^default_page\\s*:\\s*([^\\r\\n#]+).*$/gm)];if(i.length!==1||i[0][1].trim().toLowerCase()===\`windows\`)return{args:[],cleanup:()=>{}};let o=r.slice(0,i[0].index)+\`default_page: windows\`+r.slice(i[0].index+i[0][0].length),s=n.join(n.dirname(a),\`.codex-appshots-\${process.pid}-\${codexLinuxAppshotRequire(\`node:crypto\`).randomBytes(8).toString(\`hex\`)}.yaml\`);t.writeFileSync(s,o,{encoding:\`utf8\`,flag:\`wx\`,mode:384});return{args:[\`--config\`,s],cleanup:()=>{try{t.unlinkSync(s)}catch{}}}}catch(e){return codexLinuxAppshotWarn(\`hyprland-picker-config-override-failed\`,{message:e instanceof Error?e.message:String(e)}),{args:[],cleanup:()=>{}}}}
function codexLinuxAppshotHyprlandInstanceSignature(){let e=codexLinuxAppshotFirstString(process.env.HYPRLAND_INSTANCE_SIGNATURE);if(e!=null)return e;let t=codexLinuxAppshotRequire(\`node:fs\`),n=codexLinuxAppshotRequire(\`node:path\`),r=process.env.XDG_RUNTIME_DIR||(typeof process.getuid===\`function\`?\`/run/user/\${process.getuid()}\`:null);if(r==null)return null;let i=n.join(r,\`hypr\`),a=codexLinuxAppshotFirstString(process.env.WAYLAND_DISPLAY),o=[];try{for(let e of t.readdirSync(i)){let r=n.join(i,e),s=n.join(r,\`.socket.sock\`),c=n.join(r,\`hyprland.lock\`);try{if(!t.statSync(s).isSocket())continue;let r=t.readFileSync(c,\`utf8\`).split(/\\r?\\n/),i=Number(r[0]),l=codexLinuxAppshotFirstString(r[1]);if(!Number.isInteger(i)||i<=0||!t.existsSync(\`/proc/\${i}\`))continue;o.push({signature:e,display:l,displayMatch:a!=null&&l===a,modified:t.statSync(s).mtimeMs})}catch{}}}catch{return null}o.sort((e,t)=>Number(t.displayMatch)-Number(e.displayMatch)||t.modified-e.modified||e.signature.localeCompare(t.signature));return o[0]?.signature??null}
function codexLinuxAppshotHyprlandEnv(){let e={...process.env},t=codexLinuxAppshotHyprlandInstanceSignature();return codexLinuxAppshotFirstString(e.HYPRLAND_INSTANCE_SIGNATURE)==null&&t!=null&&(e.HYPRLAND_INSTANCE_SIGNATURE=t),e}
function codexLinuxAppshotHyprctlArgs(e){let t=codexLinuxAppshotHyprlandInstanceSignature();return codexLinuxAppshotFirstString(process.env.HYPRLAND_INSTANCE_SIGNATURE)==null&&t!=null?[\`-i\`,t,...e]:e}
function codexLinuxAppshotPickerClean(e){let t=String(e??\`\`);for(let e of [\`[HC>]\`,\`[HT>]\`,\`[HE>]\`,\`[HA>]\`,\`\\r\`,\`\\n\`,\`\\t\`])t=t.split(e).join(\` \`);return t.trim()}
function codexLinuxAppshotHyprlandPickerData(e){let t=[],n=new Map,r=1;for(let i of Array.isArray(e)?e:[]){if(i?.hidden===!0||codexLinuxAppshotOwnOrPortalWindow(i))continue;let e=Number(i?.window_id),a=codexLinuxAppshotFirstString(i?.wm_class,i?.app_id,\`Linux app\`),o=codexLinuxAppshotFirstString(i?.title,a);if(!Number.isSafeInteger(e)||e<=0)continue;let s=String(r++);t.push(\`\${s}[HC>]\${codexLinuxAppshotPickerClean(a)}[HT>]\${codexLinuxAppshotPickerClean(o)}[HE>]\${e}[HA>]\`),n.set(s,i)}return{list:t.join(\`\`),windowsById:n}}
function codexLinuxAppshotHyprlandPickerSelection(e){if(typeof e!==\`string\`)return null;let t=\`[SELECTION]\`,n=e.lastIndexOf(t);if(n<0)return null;let r=e.slice(n+t.length).split(\`\\n\`,1)[0],i=\`/window:\`,a=r.indexOf(i);if(a<0)return null;let o=r.slice(a+i.length).trim();return o.length>0&&[...o].every(e=>e>=\`0\`&&e<=\`9\`)?o:null}
function codexLinuxAppshotHyprlandPickWindow(e){let t=codexLinuxAppshotHyprlandPicker(),n=codexLinuxAppshotHyprlandPickerData(e);if(t==null||n.windowsById.size===0)return Promise.resolve(null);let r=codexLinuxAppshotRequire(\`node:child_process\`),i=codexLinuxAppshotHyprlandPickerConfig(t);return new Promise(a=>{try{r.execFile(t.path,i.args,{encoding:\`utf8\`,timeout:120000,maxBuffer:1048576,env:{...codexLinuxAppshotHyprlandEnv(),GDK_BACKEND:\`wayland\`,QT_QPA_PLATFORM:\`wayland\`,XDPH_WINDOW_SHARING_LIST:n.list}},(e,t)=>{i.cleanup();if(e!=null){a(null);return}let r=codexLinuxAppshotHyprlandPickerSelection(t);a(r==null?null:n.windowsById.get(r)??null)})}catch{i.cleanup(),a(null)}})}
function codexLinuxAppshotHyprlandWindowAddress(e){let t=Number(e?.window_id);return Number.isSafeInteger(t)&&t>0?\`address:0x\${t.toString(16)}\`:null}
async function codexLinuxAppshotHyprlandFocusWindow(e){let t=codexLinuxAppshotHyprlandWindowAddress(e);if(t==null)return!1;let n=codexLinuxAppshotRequire(\`node:child_process\`),r={encoding:\`utf8\`,timeout:5000,maxBuffer:1048576,env:codexLinuxAppshotHyprlandEnv()};try{let e=await codexLinuxAppshotExecFile(n,\`hyprctl\`,codexLinuxAppshotHyprctlArgs([\`dispatch\`,\`hl.dsp.focus({ window = "\${t}" })\`]),r);if(String(e.stdout||\`\`).trim()===\`ok\`)return!0}catch{}try{let e=await codexLinuxAppshotExecFile(n,\`hyprctl\`,codexLinuxAppshotHyprctlArgs([\`dispatch\`,\`focuswindow\`,t]),r);return String(e.stdout||\`\`).trim()===\`ok\`}catch{return!1}}
function codexLinuxAppshotDelay(e){return new Promise(t=>setTimeout(t,e))}
function codexLinuxAppshotWindowById(e,t){let n=Number(t?.window_id);return Number.isSafeInteger(n)?(Array.isArray(e)?e:[]).find(e=>Number(e?.window_id)===n)??null:null}
function codexLinuxAppshotUsableBounds(e){let t=e?.bounds;if(t==null||t.x==null||t.y==null||t.width==null||t.height==null)return!1;let n=[t.x,t.y,t.width,t.height].map(Number);return n.every(Number.isFinite)&&n[2]>0&&n[3]>0}
function codexLinuxAppshotBoundsKey(e){let t=e?.bounds;return codexLinuxAppshotUsableBounds(e)?[t.x,t.y,t.width,t.height].map(Number).join(\`:\`):null}
function codexLinuxAppshotWindowIdentity(e){if(e==null)return null;let t=Number(e.window_id),n=Number(e.pid),r=codexLinuxAppshotFirstString(e.app_id),i=codexLinuxAppshotFirstString(e.wm_class);return Number.isSafeInteger(t)&&t>0?\`window:\${t}:pid:\${Number.isFinite(n)?n:\`\`}:app:\${r??\`\`}:class:\${i??\`\`}\`:Number.isFinite(n)&&(r!=null||i!=null)?\`process:\${n}:app:\${r??\`\`}:class:\${i??\`\`}\`:null}
function codexLinuxAppshotSameWindow(e,t){let n=codexLinuxAppshotWindowIdentity(e),r=codexLinuxAppshotWindowIdentity(t);return n!=null&&n===r}
function codexLinuxAppshotCaptureReadyWindow(e,t,n=null){let r=codexLinuxAppshotWindowById(e,t);return r!=null&&codexLinuxAppshotSameWindow(r,t)&&r.focused===!0&&r.hidden!==!0&&r.mapped!==!1&&codexLinuxAppshotUsableBounds(r)&&(n==null||codexLinuxAppshotBoundsKey(r)===n)?r:null}
function codexLinuxAppshotValidReturnWindow(e){return codexLinuxAppshotOwnWindow(e)&&codexLinuxAppshotWindowIdentity(e)!=null&&e.hidden!==!0&&e.mapped!==!1&&codexLinuxAppshotUsableBounds(e)}
async function codexLinuxAppshotWaitForWindow(e,t=null){let n=null;for(let r=0;r<40;r++){let i=await codexLinuxAppshotBackendJson([\`windows\`],5000),a=codexLinuxAppshotFocusedWindowFromReport(i),o=codexLinuxAppshotCaptureReadyWindow(a.windows,e,t),s=o==null?null:codexLinuxAppshotBoundsKey(o);if(s!=null&&s===n)return{...a,focusedWindow:o};n=s,await codexLinuxAppshotDelay(50)}throw Error(\`Hyprland window did not become capture-ready\`)}
async function codexLinuxAppshotPrepareWindowForCapture(e){if(e?.backend!==\`hyprland\`||e?.focusedWindow==null)return e;if(!codexLinuxAppshotValidReturnWindow(e.returnWindow)||codexLinuxAppshotSameWindow(e.focusedWindow,e.returnWindow))throw Error(\`No safe ChatGPT return target for Hyprland capture\`);if(!await codexLinuxAppshotHyprlandFocusWindow(e.focusedWindow))throw Error(\`Could not activate selected Hyprland window\`);let t=await codexLinuxAppshotWaitForWindow(e.focusedWindow);await codexLinuxAppshotDelay(100);let n=await codexLinuxAppshotWaitForWindow(t.focusedWindow,codexLinuxAppshotBoundsKey(t.focusedWindow));return{...e,...n,focusedWindow:n.focusedWindow}}
async function codexLinuxAppshotVerifyCapturedWindow(e,t){let n=await codexLinuxAppshotBackendJson([\`windows\`],5000),r=codexLinuxAppshotFocusedWindowFromReport(n),i=codexLinuxAppshotCaptureReadyWindow(r.windows,e,t);if(i==null)throw Error(\`Selected Hyprland window changed during capture\`);return i}
async function codexLinuxAppshotRestoreWindow(e){if(!await codexLinuxAppshotHyprlandFocusWindow(e))return!1;try{await codexLinuxAppshotWaitForWindow(e);return!0}catch{return!1}}
function codexLinuxAppshotPickerWindowForRenderer(){let e=\`window...\`;try{let t=String(codexLinuxAppshotRequire(\`electron\`).app.getLocale()||\`\`).toLowerCase();t.startsWith(\`es\`)&&(e=\`una ventana...\`),t.startsWith(\`zh\`)&&(e=\`窗口...\`)}catch{}return{name:e,appName:e,bundleIdentifier:\`codex-linux-appshot-picker\`,windowTitle:null,iconSmallDataURL:null,appIconDataUrl:null}}
function codexLinuxAppshotX11StackingCandidates(e){if(typeof e!==\`string\`)return[];let t=e.match(/0x[0-9a-f]+/gi)||[];return t.reverse().map(e=>({window_id:e}))}
function codexLinuxAppshotX11Stacking(){let e=codexLinuxAppshotRequire(\`node:child_process\`);return new Promise(t=>{e.execFile(\`xprop\`,[\`-root\`,\`_NET_CLIENT_LIST_STACKING\`],{encoding:\`utf8\`,timeout:2000,maxBuffer:1048576},(e,n)=>t(e==null?codexLinuxAppshotX11StackingCandidates(n):[]))})}
function codexLinuxAppshotX11Session(){let e=(process.env.XDG_SESSION_TYPE||\`\`).toLowerCase();return e===\`x11\`||e!==\`wayland\`&&!!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY}
async function codexLinuxAppshotResolvedWindow(e){let t=codexLinuxAppshotFocusedWindowFromReport(e);if(!codexLinuxAppshotOwnOrPortalWindow(t.focusedWindow))return t;let n=[];(t.backend===\`x11\`||t.backend===\`i3\`||codexLinuxAppshotX11Session())&&(n=await codexLinuxAppshotX11Stacking());t.focusedWindow=codexLinuxAppshotPreviousExternalWindow(t.windows,n);return t}
async function codexLinuxAppshotFocusedWindow(e=!1){let t=await codexLinuxAppshotBackendJson([\`windows\`],5000),n=codexLinuxAppshotFocusedWindowFromReport(t),r=n.windows.find(e=>e?.focused&&codexLinuxAppshotValidReturnWindow(e))??n.windows.find(e=>codexLinuxAppshotValidReturnWindow(e))??null,i=n.backend===\`hyprland\`&&codexLinuxAppshotHyprlandPicker()!=null&&codexLinuxAppshotHyprlandPickerData(n.windows).windowsById.size>0;if(i){if(!e)return{...n,focusedWindow:null,picker:!0,returnWindow:r};if(r==null)throw Error(\`No ChatGPT window available for AppShots restoration\`);n.focusedWindow=await codexLinuxAppshotHyprlandPickWindow(n.windows);return{...n,picker:!0,returnWindow:r}}return codexLinuxAppshotResolvedWindow(t)}
async function codexLinuxAppshotFrontmostWindow(){if(process.platform!==\`linux\`)return null;try{let e=await codexLinuxAppshotFocusedWindow();return e.picker?codexLinuxAppshotPickerWindowForRenderer():codexLinuxAppshotWindowForRenderer(e.focusedWindow)}catch{return null}}
function codexLinuxAppshotSend(e,t,n,r){try{e.sendInlineMessageForView(t,{requestId:n,type:\`computer-use-capture-updated\`,update:r})}catch{}}
let codexLinuxAppshotCaptureQueue=Promise.resolve();
function codexLinuxAppshotStartCapture({origin:e,requestId:t,bundleIdentifier:n,windowManager:r}){if(process.platform!==\`linux\`)return null;setTimeout(()=>{let i=()=>codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n,windowManager:r});codexLinuxAppshotCaptureQueue=codexLinuxAppshotCaptureQueue.then(i,i).catch(n=>{codexLinuxAppshotWarn(\`capture-failed\`,{requestId:t,message:n instanceof Error?n.message:String(n)}),codexLinuxAppshotSend(r,e,t,{type:\`failed\`,failureReason:\`linux_capture_failed\`})})},0);return{animationDuration:0,transitionSnapshotHeight:140,transitionSpringDampingFraction:1,transitionSpringResponse:0}}
async function codexLinuxAppshotCapture({origin:e,requestId:t,bundleIdentifier:n,windowManager:r}){let i=await codexLinuxAppshotFocusedWindow(!0),a=i.focusedWindow,o=i.returnWindow,s=i.backend===\`hyprland\`&&a!=null,c=null,l=null,u=null,d=!s;try{i=await codexLinuxAppshotPrepareWindowForCapture(i),a=i.focusedWindow,c=codexLinuxAppshotWindowForRenderer(a);if(c==null)throw Error(\`No selected Linux AppShot window\`);let[e,t]=await Promise.all([codexLinuxAppshotAccessibilityNodes(a,c.bundleIdentifier),codexLinuxAppshotScreenshot(a,i.windows)]);if(t==null||typeof t.dataURL!=\`string\`||t.dataURL.length===0)throw Error(\`Linux AppShot screenshot was empty\`);s&&await codexLinuxAppshotVerifyCapturedWindow(a,codexLinuxAppshotBoundsKey(a)),l=codexLinuxAppshotAccessibilityText(a,e.nodes,e.error),u=t}finally{if(s){if(o==null||!await codexLinuxAppshotRestoreWindow(o)){codexLinuxAppshotWarn(\`hyprland-restore-focus-failed\`,{windowId:o?.window_id});throw Error(\`Could not verify ChatGPT focus restoration\`)}d=!0}}if(!d)throw Error(\`ChatGPT focus restoration was not verified\`);codexLinuxAppshotSend(r,e,t,{type:\`metadata\`,app:{bundleIdentifier:c.bundleIdentifier,name:c.name,windowTitle:c.windowTitle,iconSmallDataURL:null}}),typeof l==\`string\`&&l.length>0&&codexLinuxAppshotSend(r,e,t,{type:\`axText\`,text:l}),codexLinuxAppshotSend(r,e,t,{type:\`screenshot\`,screenshotDataURL:u.dataURL}),codexLinuxAppshotSend(r,e,t,{type:\`completed\`,transitionSnapshotDataURL:u.dataURL})}
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
    pattern: /^app-initial-[^.]+\.js$/,
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
];

module.exports = {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  descriptors,
};
