"use strict";

const { escapeRegExp, requireName } = require("../../scripts/patches/lib/minified-js.js");

const MARKER = "/* linux-native-applications */";
const FACTORY = /function (?<factory>[\w$]+)\(\)\{(?<patched>\/\* linux-native-applications \*\/if\(process\.platform===`linux`\)return codexLinuxNativeApplications\(\);)?(?<original>if\(process\.platform===`darwin`\|\|process\.platform===`win32`\)return\{getByBundleId:async (?<id>[\w$]+)=>await (?<lookup>[\w$]+)\(\k<id>\)\?\?await (?<module>[\w$]+)\.[\w$]+\(\k<id>\),list:\k<module>\.[\w$]+,getIcon:async\(\{appPath:(?<app>[\w$]+),size:(?<size>[\w$]+)\}\)=>\k<size>===`medium`\?\{iconSmall:null,iconMedium:await [\w$]+\(\k<app>\)\}:\{iconSmall:await [\w$]+\(\k<app>\)\}\})\}/g;

function linuxNativeDesktopAppsHelper({ childProcessVar, fsVar, osVar, pathVar }) {
  return [
    `function codexLinuxNativeDesktopAppsPayload(e){return e?.params??e??{}}`,
    `function codexLinuxNativeDesktopAppsHome(){return process.env.HOME||${osVar}.homedir?.()||\`\`}`,
    `function codexLinuxNativeDesktopAppsExecutable(e){if(!e)return null;if(e.includes(\`/\`)){try{return ${fsVar}.existsSync(e)&&(${fsVar}.accessSync(e,${fsVar}.constants.X_OK),!0)?e:null}catch{return null}}for(let t of(process.env.PATH||\`\`).split(\`:\`)){if(!t||!${pathVar}.isAbsolute(t))continue;let n=${pathVar}.join(t,e);try{if(${fsVar}.existsSync(n)&&(${fsVar}.accessSync(n,${fsVar}.constants.X_OK),!0))return n}catch{}}return null}`,
    `function codexLinuxNativeDesktopAppsBackendPath(){let e=process.env.CODEX_LINUX_COMPUTER_USE_BACKEND_SOURCE?.trim(),t=process.env.CODEX_ELECTRON_RESOURCES_PATH||process.resourcesPath,n=process.env.CODEX_HOME||(codexLinuxNativeDesktopAppsHome()?${pathVar}.join(codexLinuxNativeDesktopAppsHome(),\`.codex\`):\`\`),r=[e,t&&${pathVar}.join(t,\`plugins\`,\`openai-bundled\`,\`plugins\`,\`unified-computer-use\`,\`bin\`,\`codex-computer-use-linux\`),n&&${pathVar}.join(n,\`plugins\`,\`cache\`,\`openai-bundled\`,\`unified-computer-use\`,\`latest\`,\`bin\`,\`codex-computer-use-linux\`),\`codex-computer-use-linux\`];for(let e of r){if(typeof e!==\`string\`||e.length===0)continue;let t=codexLinuxNativeDesktopAppsExecutable(e);if(t)return t}return null}`,
    `function codexLinuxNativeDesktopAppsRun(e){let t=codexLinuxNativeDesktopAppsBackendPath();if(t==null)return null;try{let n=${childProcessVar}.spawnSync(t,e,{encoding:\`utf8\`,env:process.env,maxBuffer:1048576,timeout:2500});if(n.error||n.status!==0)return null;return JSON.parse(n.stdout||\`null\`)}catch{return null}}`,
    `function codexLinuxNativeDesktopAppsDataDirs(){let e=codexLinuxNativeDesktopAppsHome(),t=process.env.XDG_DATA_HOME||(e&&${pathVar}.join(e,\`.local\`,\`share\`)),n=(process.env.XDG_DATA_DIRS||\`/usr/local/share:/usr/share\`).split(\`:\`).filter(Boolean);return[...t?[t]:[],...n]}`,
    `function codexLinuxNativeDesktopAppsUnescape(e){return String(e??\`\`).replace(/\\\\s/g,\` \`).replace(/\\\\n/g,\`\\n\`).replace(/\\\\t/g,\`\\t\`).replace(/\\\\r/g,\`\\r\`).replace(/\\\\\\\\/g,\`\\\\\`)}`,
    `function codexLinuxNativeDesktopAppsParseDesktopFile(e){try{let t=${fsVar}.readFileSync(e,\`utf8\`).split(/\\r?\\n/),n=!1,r={id:${pathVar}.basename(e,\`.desktop\`),path:e};for(let e of t){let t=e.trim();if(!t||t.startsWith(\`#\`))continue;if(t.startsWith(\`[\`)&&t.endsWith(\`]\`)){n=t===\`[Desktop Entry]\`;continue}if(!n)continue;let i=t.indexOf(\`=\`);if(i<1)continue;let a=t.slice(0,i),o=codexLinuxNativeDesktopAppsUnescape(t.slice(i+1));a===\`Name\`?r.name=o:a===\`Icon\`?r.icon=o:a===\`StartupWMClass\`?r.startupWmClass=o:a===\`Exec\`?r.exec=o:a===\`NoDisplay\`?r.noDisplay=o:a===\`Hidden\`&&(r.hidden=o)}return r.hidden===\`true\`?null:r}catch{return null}}`,
    `function codexLinuxNativeDesktopAppsDesktopEntries(){let e=[];for(let t of codexLinuxNativeDesktopAppsDataDirs()){let n=${pathVar}.join(t,\`applications\`);if(!${fsVar}.existsSync(n))continue;let r=[n],i=0;for(;r.length>0&&i<2500;){let t=r.pop();i+=1;let n;try{n=${fsVar}.readdirSync(t,{withFileTypes:!0})}catch{continue}for(let i of n){let n=${pathVar}.join(t,i.name);if(i.isDirectory())r.push(n);else if(i.isFile()&&i.name.endsWith(\`.desktop\`)){let t=codexLinuxNativeDesktopAppsParseDesktopFile(n);t&&e.push(t)}}}}return e}`,
    `function codexLinuxNativeDesktopAppsNorm(e){return String(e??\`\`).trim().toLowerCase()}`,
    `function codexLinuxNativeDesktopAppsDesktopScore(e,t){let n=[t.app_id,t.wm_class,t.name].map(codexLinuxNativeDesktopAppsNorm).filter(Boolean),r=codexLinuxNativeDesktopAppsNorm(e.id),i=codexLinuxNativeDesktopAppsNorm(e.startupWmClass),a=codexLinuxNativeDesktopAppsNorm(e.name);let o=0;for(let e of n){r===e&&(o=Math.max(o,90));r===\`\${e}.desktop\`&&(o=Math.max(o,90));r.endsWith(\`.\${e}\`)&&(o=Math.max(o,70));i===e&&(o=Math.max(o,100));a===e&&(o=Math.max(o,45))}return o}`,
    `function codexLinuxNativeDesktopAppsDesktopFor(e,t){let n=null,r=0;for(let i of t){let t=codexLinuxNativeDesktopAppsDesktopScore(i,e);t>r&&(n=i,r=t)}return n}`,
    `function codexLinuxNativeDesktopAppsTitle(e){let t=String(e??\`\`).trim().split(/[._-]+/).filter(Boolean).map(e=>e.charAt(0).toUpperCase()+e.slice(1)).join(\` \`);return t||\`Desktop app\`}`,
    `function codexLinuxNativeDesktopAppsCandidate(e,t){let n=codexLinuxNativeDesktopAppsDesktopFor(e,t),r=String(e.app_id??\`\`).trim(),i=String(e.wm_class??\`\`).trim(),a=n?.id||r||i||(e.pid!=null?\`pid:\${e.pid}\`:\`\`);if(!a)return null;let o=n?.name||codexLinuxNativeDesktopAppsTitle(r||i||e.name||e.title),s=n?.path||\`linux:\${a}\`;return{bundleId:a,appPath:s,displayName:o,description:e.title?\`Window: \${e.title}\`:\`Linux desktop app\`,iconSmall:\`\`,linuxAppId:r||null,wmClass:i||null,pid:e.pid??null,windowId:e.window_id??null,focused:e.focused===!0,backend:e.backend??null,clientType:e.client_type??null}}`,
    `function codexLinuxNativeDesktopAppsAdd(e,t){if(t==null)return;let n=codexLinuxNativeDesktopAppsNorm(t.bundleId||t.appPath||t.displayName),r=e.get(n);if(r==null||t.focused&&!r.focused||r.appPath.startsWith(\`linux:\`)&&!t.appPath.startsWith(\`linux:\`))e.set(n,t)}`,
    `function codexLinuxNativeDesktopAppsFromWindows(e,t){let n=new Map;for(let r of Array.isArray(e)?e:[])codexLinuxNativeDesktopAppsAdd(n,codexLinuxNativeDesktopAppsCandidate(r,t));return[...n.values()].sort((e,t)=>Number(t.focused)-Number(e.focused)||e.displayName.localeCompare(t.displayName)).slice(0,20)}`,
    `async function codexLinuxNativeDesktopApps(){let e=codexLinuxNativeDesktopAppsRun([\`windows\`]),t=codexLinuxNativeDesktopAppsDesktopEntries(),n=codexLinuxNativeDesktopAppsFromWindows(e?.windows,t);return{apps:n}}`,
    `function codexLinuxNativeDesktopAppsIconDirs(){let e=codexLinuxNativeDesktopAppsHome(),t=codexLinuxNativeDesktopAppsDataDirs(),n=[];for(let r of t)n.push(${pathVar}.join(r,\`icons\`)),n.push(${pathVar}.join(r,\`pixmaps\`));e&&n.push(${pathVar}.join(e,\`.icons\`));return n}`,
    `function codexLinuxNativeDesktopAppsResolveIcon(e){if(!e)return null;if(${pathVar}.isAbsolute(e)){try{return ${fsVar}.existsSync(e)?e:null}catch{return null}}let t=e.match(/\\.(png|svg|xpm)$/i)?[e]:[\`\${e}.png\`,\`\${e}.svg\`,\`\${e}.xpm\`],n=[\`hicolor/512x512/apps\`,\`hicolor/256x256/apps\`,\`hicolor/128x128/apps\`,\`hicolor/64x64/apps\`,\`hicolor/48x48/apps\`,\`hicolor/scalable/apps\`,\`hicolor/symbolic/apps\`,\`.\`];for(let e of codexLinuxNativeDesktopAppsIconDirs())for(let r of n)for(let n of t){let t=${pathVar}.join(e,r,n);try{if(${fsVar}.existsSync(t))return t}catch{}}return null}`,
    `function codexLinuxNativeDesktopAppsIconDataUrl(e){try{let t=${pathVar}.extname(e).toLowerCase(),n=t===\`.svg\`?\`image/svg+xml\`:t===\`.xpm\`?\`image/x-xpixmap\`:\`image/png\`;return\`data:\${n};base64,\${${fsVar}.readFileSync(e).toString(\`base64\`)}\`}catch{return\`\`}}`,
    `async function codexLinuxNativeDesktopAppIcon(e){let t=codexLinuxNativeDesktopAppsPayload(e),n=String(t.appPath??\`\`),r=null;if(n.endsWith(\`.desktop\`)&&${fsVar}.existsSync(n))r=codexLinuxNativeDesktopAppsParseDesktopFile(n)?.icon??null;let i=codexLinuxNativeDesktopAppsResolveIcon(r);return{iconSmall:i?codexLinuxNativeDesktopAppsIconDataUrl(i):\`\`}}`,
  ].join("");
}

function runtimeSource(source) {
  const dependencies = {
    childProcessVar: requireName(source, "node:child_process") ?? requireName(source, "child_process"),
    fsVar: requireName(source, "node:fs"),
    osVar: requireName(source, "node:os") ?? requireName(source, "os"),
    pathVar: requireName(source, "node:path"),
  };
  if (Object.values(dependencies).some(value => value == null)) {
    throw new Error("Linux native Applications contract drift: metadata dependencies unavailable");
  }
  // Reuse the existing running-window, desktop-entry and icon implementation.
  // The new signed bridge returns arrays/records directly, without the retired
  // native-desktop-apps IPC envelope.
  return linuxNativeDesktopAppsHelper(dependencies) +
    "function codexLinuxNativeApplications(){return{" +
    "list:async(e={})=>{let{apps:t}=await codexLinuxNativeDesktopApps();return e.order===`display-name`?t.sort((e,t)=>e.displayName.localeCompare(t.displayName)):t}," +
    "getByBundleId:async e=>{if(typeof e!==`string`)return null;let{apps:t}=await codexLinuxNativeDesktopApps();return t.find(t=>t.bundleId.toLowerCase()===e.toLowerCase())??null}," +
    "getIcon:async({appPath:e,size:t})=>{let{iconSmall:n}=await codexLinuxNativeDesktopAppIcon({appPath:e});return t===`medium`?{iconSmall:null,iconMedium:n||null}:{iconSmall:n||null}}}}";
}

function applyNativeApplicationsPatch(source) {
  const fail = () => { throw new Error("Linux native Applications contract drift: missing, duplicate, or partial native metadata owner"); };
  const owners = [...source.matchAll(FACTORY)];
  if (owners.length !== 1) fail();
  const owner = owners[0];
  const calls = [...source.matchAll(new RegExp(`nativeApplications=${escapeRegExp(owner.groups.factory)}\\(\\)`, "g"))];
  const exposures = [...source.matchAll(/nativeApplications:this\.fetchHandler\.nativeApplications/g)];
  if (calls.length !== 1 || exposures.length !== 1) fail();
  const runtime = runtimeSource(source);
  const markerCount = source.split(MARKER).length - 1;
  const runtimeCount = source.split(runtime).length - 1;
  if (owner.groups.patched != null) {
    if (markerCount !== 1 || runtimeCount !== 1) fail();
    return source;
  }
  if (markerCount !== 0 || runtimeCount !== 0 || source.includes("codexLinuxNativeApplications") || source.includes("codexLinuxNativeDesktopApps(")) fail();
  const replacement = `function ${owner.groups.factory}(){${MARKER}if(process.platform===\`linux\`)return codexLinuxNativeApplications();${owner.groups.original}}`;
  const patched = source.slice(0, owner.index) + replacement + source.slice(owner.index + owner[0].length);
  const strict = patched.match(/^(?:"use strict"|'use strict');/);
  const insertAt = strict?.[0].length ?? 0;
  return patched.slice(0, insertAt) + runtime + patched.slice(insertAt);
}

module.exports = { applyNativeApplicationsPatch };
