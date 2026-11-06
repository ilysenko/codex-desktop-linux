"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");

const ID = "[A-Za-z_$][\\w$]*";
const MEMBER = `${ID}(?:\\.${ID})*`;
const MARKER = "/* linux-native-applications */";
const RUNTIME_NAME = "codexLinuxNativeApplications";
const LINUX_BRANCH = `${MARKER}if("linux"===process.platform)return ${RUNTIME_NAME}();`;
// The current desktop-services provider constructs one ordinary, directly
// invoked platform factory and returns that same binding as nativeApplications.
const FACTORY = new RegExp(
  String.raw`(?<![\w$.#])(?<binding>${ID})\s*=\s*(?<head>function\(\)\{)` +
  String.raw`(?<patched>/\* linux-native-applications \*/if\("linux"===process\.platform\)return codexLinuxNativeApplications\(\);)?` +
  String.raw`(?<original>if\("darwin"===process\.platform\|\|"win32"===process\.platform\)return\{getByBundleId:async (?<id>${ID})=>await ${ID}\(\k<id>\)\?\?await (?:\(0,${MEMBER}\)|${MEMBER})\(\k<id>\),list:${MEMBER},getIcon:async\(\{appPath:(?<app>${ID}),size:(?<size>${ID})\}\)=>"medium"===\k<size>\?\{iconSmall:null,iconMedium:await ${ID}\(\k<app>\)\}:\{iconSmall:await ${ID}\(\k<app>\)\}\})\}\(\)`, "gu");

const DEPENDENCIES = {
  childProcessVar: "codexLinuxNativeApplicationsChildProcess",
  fsVar: "codexLinuxNativeApplicationsFs",
  osVar: "codexLinuxNativeApplicationsOs",
  pathVar: "codexLinuxNativeApplicationsPath",
};

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

function runtimeSource() {
  // Reuse the existing running-window, desktop-entry and icon implementation.
  // The signed bridge returns arrays/records directly, without the retired
  // native-desktop-apps IPC envelope.
  return "function codexLinuxNativeApplications(){" +
    `const ${DEPENDENCIES.childProcessVar}=require("node:child_process"),${DEPENDENCIES.fsVar}=require("node:fs"),` +
    `${DEPENDENCIES.osVar}=require("node:os"),${DEPENDENCIES.pathVar}=require("node:path");` +
    linuxNativeDesktopAppsHelper(DEPENDENCIES) +
    "return{" +
    "list:async(e={})=>{let{apps:t}=await codexLinuxNativeDesktopApps();return e.order===`display-name`?t.sort((e,t)=>e.displayName.localeCompare(t.displayName)):t}," +
    "getByBundleId:async e=>{if(typeof e!==`string`)return null;let{apps:t}=await codexLinuxNativeDesktopApps();return t.find(t=>t.bundleId.toLowerCase()===e.toLowerCase())??null}," +
    "getIcon:async({appPath:e,size:t})=>{let{iconSmall:n}=await codexLinuxNativeDesktopAppIcon({appPath:e});return t===`medium`?{iconSmall:null,iconMedium:n||null}:{iconSmall:n||null}}}}";
}


function drift(reason) {
  return new Error(`Linux native Applications contract drift: ${reason}`);
}
function one(values, reason) {
  if (values.length !== 1) throw drift(reason);
  return values[0];
}
function previousCode(source, lexical, at) {
  while (at >= 0 && !lexical.isCode(at)) at -= 1;
  return at;
}
function nextCode(source, lexical, at) {
  while (at < source.length && !lexical.isCode(at)) at += 1;
  return at;
}
function matches(source, lexical, pattern, root = false) {
  return [...source.matchAll(pattern)].filter(match => root ? lexical.isRoot(match.index) : lexical.isCode(match.index));
}
function parameterEnd(source, lexical, open) {
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    if (!lexical.isCode(at)) continue;
    if (source[at] === "(") depth += 1;
    if (source[at] === ")" && --depth === 0) return at;
  }
  throw drift("incomplete native provider parameters");
}
function bodyAfterParameters(source, lexical, open) {
  const paramsEnd = parameterEnd(source, lexical, open);
  const bodyOpen = nextCode(source, lexical, paramsEnd + 1);
  if (source[bodyOpen] !== "{") return null;
  const close = lexical.matchingBrace(bodyOpen);
  if (close < bodyOpen) throw drift("incomplete native provider body");
  return { params: source.slice(open + 1, paramsEnd), open: bodyOpen, end: close + 1 };
}
const IDENTIFIER_TOKENS = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
function decodedIdentifier(value) {
  return value.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => {
    const point = parseInt(braced || fixed, 16);
    return point <= 0x10ffff ? String.fromCodePoint(point) : "\0";
  });
}
function requireLiteralOwnerIdentifiers(body, lexical, names) {
  const protectedNames = new Set(names);
  for (const token of body.matchAll(IDENTIFIER_TOKENS)) {
    if (token[0].includes("\\u") && lexical.isCode(token.index) && protectedNames.has(decodedIdentifier(token[0]))) {
      throw drift("native receiver uses an encoded owner identifier");
    }
  }
}
function bindingReferences(source, lexical, name, declaration) {
  const references = [];
  for (const token of source.matchAll(IDENTIFIER_TOKENS)) {
    if (token[0] !== name && !token[0].includes("\\u")) continue;
    const decoded = decodedIdentifier(token[0]);
    if (decoded !== name || token.index === declaration || !lexical.isCode(token.index) ||
        (source[token.index - 1] === "#" || source[token.index - 1] === "." && source.slice(token.index - 3, token.index) !== "...") || /^\s*:/u.test(source.slice(token.index + token[0].length))) continue;
    references.push({ start: token.index, end: token.index + token[0].length });
  }
  return references;
}
function scopeOwnsBinding(body, parameters, name) {
  try { new Script(`function nativeProvider(${parameters}){${body}\n}`); }
  catch { throw drift("invalid native provider scope"); }
  try { new Script(`function nativeParameters(${parameters}){let ${name};}`); }
  catch { return false; }
  try { new Script(`function nativeProvider(${parameters}){${body}\n;let ${name};}`); return false; }
  catch { return true; }
}
function rootDeclarator(body, lexical, at) {
  if (!lexical.isRoot(at)) return false;
  const previous = previousCode(body, lexical, at - 1);
  let boundary = previous;
  if (body[previous] !== ",") {
    while (boundary >= 0 && /[\w$]/u.test(body[boundary])) boundary -= 1;
    if (!["let", "const", "var"].includes(body.slice(boundary + 1, previous + 1))) return false;
    boundary += 1;
  }
  try { new Script(`function nativeDeclaration(){${body.slice(0, boundary)};\nconst nativeDeclarator=0;}`); return true; }
  catch { return false; }
}
function objectProperties(source, open, close, protectedKey = null, resolveSpread = null) {
  const body = source.slice(open + 1, close), lexical = createJavaScriptLexicalIndex(body);
  const parts = [], properties = new Map();
  if (skipTrivia(body, 0) === body.length) return properties;
  let begin = 0, parens = 0, brackets = 0;
  for (let at = 0; at <= body.length; at += 1) {
    if (at < body.length && !lexical.isRoot(at)) continue;
    const char = body[at];
    if (char === "(") parens += 1;
    if (char === ")") parens -= 1;
    if (char === "[") brackets += 1;
    if (char === "]") brackets -= 1;
    if (at === body.length || char === "," && parens === 0 && brackets === 0) {
      parts.push({ start: begin, end: at });
      begin = at + 1;
    }
  }
  const headers = parts.map(part => {
    const start = skipTrivia(body, part.start);
    const head = new RegExp(String.raw`^(?<key>${ID})\s*:\s*`, "u").exec(body.slice(start, part.end));
    return { part, start, head };
  });
  const protectedAt = protectedKey == null ? -1 : one(headers.map((value, index) => ({ ...value, index }))
    .filter(value => value.head?.groups.key === protectedKey), "missing or duplicated protected native property").index;
  for (const [index, { part, start: propertyStart, head }] of headers.entries()) {
    if (skipTrivia(body, part.start) === body.length) continue;
    if (body.slice(part.start, part.end).trim() === "...{}") continue;
    if (!head && protectedKey != null && index > protectedAt && body.startsWith("...", propertyStart)) {
      const expression = body.slice(propertyStart + 3, part.end).trim();
      const literal = spreadLiteral(expression) ?? resolveSpread?.(expression, open + 1 + propertyStart + 3);
      if (literal && !literal.has(protectedKey)) continue;
    }
    // Earlier spreads cannot override a later explicit nativeApplications
    // value. Unknown members after that value would make the edge ambiguous.
    if (!head && protectedKey != null && index < protectedAt) continue;
    if (!head || properties.has(head.groups.key) && (protectedKey == null || head.groups.key === protectedKey)) {
      throw drift("native record has unsupported or duplicate properties");
    }
    const start = open + 1 + propertyStart + head[0].length;
    const value = source.slice(start, open + 1 + part.end).trim();
    if (!value) throw drift("native record property has no value");
    properties.set(head.groups.key, { value, start, end: open + 1 + part.end });
  }
  return properties;
}
// A trailing spread is safe only when its value is a fully known object.
// The current AppHost also uses a parenthesized sequence ending in a literal.
function spreadLiteral(expression) {
  let value = expression.trim();
  if (value.startsWith("(")) {
    const lexical = createJavaScriptLexicalIndex(value);
    const end = parameterEnd(value, lexical, 0);
    if (skipTrivia(value, end + 1) !== value.length) return null;
    value = value.slice(1, end).trim();
  }
  const lexical = createJavaScriptLexicalIndex(value);
  const conditional = new RegExp(String.raw`^null(?:==|!=)(?:this(?:\.${ID})+|${ID})\?`, "u").exec(value);
  if (conditional && value[conditional[0].length] === "{") {
    const open = conditional[0].length, close = lexical.matchingBrace(open);
    const after = skipTrivia(value, close + 1);
    if (value[after] !== ":") return null;
    const alternate = spreadLiteral(value.slice(after + 1));
    if (!alternate) return null;
    return new Map([...objectProperties(value, open, close), ...alternate]);
  }
  const literals = [];
  for (let open = 0; open < value.length; open += 1) {
    if (value[open] !== "{" || !lexical.isRoot(open)) continue;
    const close = lexical.matchingBrace(open);
    if (skipTrivia(value, close + 1) !== value.length) continue;
    const prefix = value.slice(0, open).trim();
    if (prefix && !prefix.endsWith(",")) continue;
    try { new Script(`(${prefix}0)`); } catch { continue; }
    literals.push(objectProperties(value, open, close));
  }
  return literals.length === 1 ? literals[0] : null;
}
function returnedLiteral(body) {
  const lexical = createJavaScriptLexicalIndex(body), returned = rootReturn(body, lexical);
  const open = nextCode(body, lexical, returned.index + 6);
  if (body[open] !== "{") throw drift("native AppHost spread does not return a literal record");
  const close = lexical.matchingBrace(open);
  if (!/^\s*;?\s*$/u.test(body.slice(close + 1))) throw drift("native AppHost spread has unknown return continuation");
  return objectProperties(body, open, close);
}
function localSpreadRecord(body, parameters, name, reference) {
  if (!new RegExp(`^${ID}$`, "u").test(name)) return null;
  const lexical = createJavaScriptLexicalIndex(body);
  const head = one(matches(body, lexical, new RegExp(String.raw`(?<![\w$.#])${escapeRegExp(name)}\s*=\s*function\s*\(`, "gu"), true), "native AppHost spread binding is ambiguous");
  if (!rootDeclarator(body, lexical, head.index) || !scopeOwnsBinding(body, parameters, name)) throw drift("native AppHost spread is not a local declaration");
  const provider = bodyAfterParameters(body, lexical, head.index + head[0].lastIndexOf("("));
  if (!provider || body[provider.end] !== "(") throw drift("native AppHost spread is not a direct ordinary factory");
  const end = parameterEnd(body, lexical, provider.end);
  if (!/^(?:,|;|$)/u.test(body.slice(skipTrivia(body, end + 1)))) throw drift("native AppHost spread factory continuation changed");
  const references = bindingReferences(body, lexical, name, head.index);
  if (references.length !== 1 || references[0].start !== reference) throw drift("native AppHost spread binding is replaced or shadowed");
  return returnedLiteral(body.slice(provider.open + 1, provider.end - 1));
}
function rootReturn(source, lexical) {
  const returned = one(matches(source, lexical, /\breturn\b/gu, true), "expected one native returned value");
  const first = nextCode(source, lexical, returned.index + 6);
  if (/[\r\n\u2028\u2029]/u.test(source.slice(returned.index + 6, first))) throw drift("native return is split by ASI");
  return returned;
}
function returnedServices(body, lexical) {
  const returned = rootReturn(body, lexical);
  let final = previousCode(body, lexical, body.length - 1);
  if (body[final] === ";") final = previousCode(body, lexical, final - 1);
  const objects = [];
  for (let at = returned.index + 6; at < body.length; at += 1) {
    if (body[at] !== "{" || !lexical.isRoot(at) || lexical.matchingBrace(at) !== final) continue;
    const prefix = previousCode(body, lexical, at - 1);
    if (prefix !== returned.index + 5 && body[prefix] !== ",") continue;
    if (matches(body.slice(returned.index + 6, at), createJavaScriptLexicalIndex(body.slice(returned.index + 6, at)), /;/gu, true).length) continue;
    const properties = objectProperties(body, at, final);
    if (properties.has("globalStateService") && properties.has("nativeApplications")) objects.push({ open: at, close: final, properties });
  }
  return one(objects, "expected returned desktop-services native Applications binding");
}
function ordinaryMembers(source, owner) {
  const body = source.slice(owner.open + 1, owner.end - 1), lexical = createJavaScriptLexicalIndex(body);
  const members = [];
  for (const head of matches(body, lexical, new RegExp(String.raw`(?<![\w$.#])(?<name>${ID})\s*\(`, "gu"), true)) {
    const previous = previousCode(body, lexical, head.index - 1);
    if (previous >= 0 && ![";", "}"].includes(body[previous])) continue;
    const open = head.index + head[0].lastIndexOf("(");
    const value = bodyAfterParameters(body, lexical, open);
    if (!value) continue;
    members.push({ name: head.groups.name, start: owner.open + 1 + head.index,
      open: owner.open + 1 + value.open, end: owner.open + 1 + value.end, params: value.params });
  }
  return members;
}
function thisMemberReferences(body, lexical) {
  const references = [], identifier = new RegExp(IDENTIFIER_TOKENS.source, "uy");
  for (const receiver of matches(body, lexical, /(?<![\w$.#])this\b/gu)) {
    const members = [];
    let end = nextCode(body, lexical, receiver.index + "this".length);
    while (body[end] === ".") {
      identifier.lastIndex = nextCode(body, lexical, end + 1);
      const property = identifier.exec(body);
      if (!property) break;
      members.push(decodedIdentifier(property[0]));
      end = nextCode(body, lexical, identifier.lastIndex);
    }
    if (members.length) references.push({ start: receiver.index, end, members });
  }
  return references;
}
function memberWrite(body, reference, name) {
  return reference.members.length === 1 && reference.members[0] === name &&
    /^(?:\+\+|--|(?:\?\?|\|\||&&|[+*/%&|^\-])?=(?!=|>))/u.test(body.slice(reference.end));
}
function requirePlainStorageField(body, lexical, name) {
  requireLiteralOwnerIdentifiers(body, lexical, [name]);
  const fields = matches(body, lexical, new RegExp(String.raw`(?<![\w$.#])${escapeRegExp(name)}(?![\w$])`, "gu"), true);
  if (fields.length > 1 || fields.some(field => {
    const before = previousCode(body, lexical, field.index - 1);
    return before >= 0 && ![";", "}"].includes(body[before]) || body[nextCode(body, lexical, field.index + name.length)] !== ";";
  })) throw drift("native instance storage is not a plain own field");
}
function instanceSpreadRecord(expression, source, owner, constructor) {
  const call = new RegExp(String.raw`^this\.(?<storage>${ID})\.(?<method>${ID})\(`, "u").exec(expression);
  if (!call) return null;
  const expressionLexical = createJavaScriptLexicalIndex(expression);
  if (parameterEnd(expression, expressionLexical, call[0].length - 1) !== expression.length - 1) return null;
  const { storage, method } = call.groups;
  const classBody = source.slice(owner.open + 1, owner.end - 1), classLexical = createJavaScriptLexicalIndex(classBody);
  requirePlainStorageField(classBody, classLexical, storage);
  const writes = thisMemberReferences(classBody, classLexical).filter(reference => memberWrite(classBody, reference, storage));
  const write = one(writes, "native AppHost service spread instance is replaced");
  const at = owner.open + 1 + write.start;
  if (!(constructor.open < at && at < constructor.end)) throw drift("native AppHost service spread is disconnected from its constructor");
  const constructed = new RegExp(String.raw`^this\.${escapeRegExp(storage)}=new (?<name>${ID})\(`, "u").exec(source.slice(at));
  if (!constructed) throw drift("native AppHost service spread has an unknown constructor");
  const lexical = createJavaScriptLexicalIndex(source);
  const head = one(matches(source, lexical, new RegExp(String.raw`class ${escapeRegExp(constructed.groups.name)}\{`, "gu"), true), "native AppHost service spread class is ambiguous");
  const open = head.index + head[0].length - 1;
  const service = { open, end: lexical.matchingBrace(open) + 1 };
  const references = bindingReferences(source, lexical, constructed.groups.name, head.index + "class ".length);
  if (references.length !== 1 || references[0].start !== at + constructed[0].lastIndexOf(constructed.groups.name)) throw drift("native AppHost service spread class is replaced or aliased");
  const member = one(ordinaryMembers(source, service).filter(value => value.name === method), "native AppHost service spread method is not ordinary");
  const serviceBody = source.slice(open + 1, service.end - 1), serviceLexical = createJavaScriptLexicalIndex(serviceBody);
  if (matches(serviceBody, serviceLexical, new RegExp(String.raw`(?<![\w$])${escapeRegExp(method)}(?![\w$])`, "gu")).length !== 1) throw drift("native AppHost service spread method is replaced");
  return returnedLiteral(source.slice(member.open + 1, member.end - 1));
}
function providerOwner(factory) {
  const source = factory.body, lexical = createJavaScriptLexicalIndex(source);
  const exposure = one(matches(source, lexical, /nativeApplications:this\.desktopServices\.nativeApplications(?=[,}])/gu), "expected one desktop-services native Applications exposure");
  const classes = [];
  for (const head of matches(source, lexical, new RegExp(String.raw`class (?<name>${ID})(?: extends ${MEMBER})?\{`, "gu"), true)) {
    const open = head.index + head[0].length - 1, end = lexical.matchingBrace(open) + 1;
    if (open < exposure.index && exposure.index < end) classes.push({ name: head.groups.name, start: head.index, open, end });
  }
  const owner = one(classes, "expected native Applications instance owner");
  const beforeClass = previousCode(source, lexical, owner.start - 1);
  if (beforeClass >= 0 && ![";", "}"].includes(source[beforeClass])) throw drift("native instance owner is not a root class declaration");
  const classReferences = bindingReferences(source, lexical, owner.name, owner.start + "class ".length);
  const constructed = one(classReferences, "native Applications class has ambiguous binding uses");
  if (!/\bnew\s*$/u.test(source.slice(0, constructed.start)) || !/^\s*\(/u.test(source.slice(constructed.end))) throw drift("native Applications class binding is replaced or aliased");
  const members = ordinaryMembers(source, owner);
  const constructor = one(members.filter(member => member.name === "constructor"), "expected native instance constructor");
  const constructorBody = source.slice(constructor.open + 1, constructor.end - 1), constructorLexical = createJavaScriptLexicalIndex(constructorBody);
  const assignment = one(matches(constructorBody, constructorLexical, /this\.desktopServices\s*=\s*function\s*\(/gu, true), "expected direct desktop-services construction");
  const provider = bodyAfterParameters(constructorBody, constructorLexical, assignment.index + assignment[0].lastIndexOf("("));
  if (!provider || constructorBody.slice(provider.end, provider.end + 2) !== "({") throw drift("desktop-services provider is not directly called");
  const argsOpen = provider.end + 1, argsEnd = constructorLexical.matchingBrace(argsOpen);
  if (constructorBody[argsEnd + 1] !== ")") throw drift("desktop-services provider arguments are incomplete");
  const continuation = nextCode(constructorBody, constructorLexical, argsEnd + 2);
  if (continuation < constructorBody.length && ![",", ";"].includes(constructorBody[continuation])) throw drift("desktop-services provider assignment continuation changed");
  const args = objectProperties(constructorBody, argsOpen, argsEnd);
  if (args.get("globalState")?.value !== "this.scopedState") throw drift("desktop-services state is disconnected from its instance");
  const providerBody = constructorBody.slice(provider.open + 1, provider.end - 1), providerLexical = createJavaScriptLexicalIndex(providerBody);
  const services = returnedServices(providerBody, providerLexical);
  const binding = services.properties.get("nativeApplications");
  if (!new RegExp(`^${ID}$`, "u").test(binding.value)) throw drift("returned native Applications is not a direct binding");
  const factories = matches(providerBody, providerLexical, FACTORY, true).filter(match => match.groups.binding === binding.value);
  const native = one(factories, "expected current ordinary native Applications factory");
  const nativeContinuation = nextCode(providerBody, providerLexical, native.index + native[0].length);
  if (nativeContinuation < providerBody.length && ![",", ";"].includes(providerBody[nativeContinuation])) throw drift("native Applications factory initializer continuation changed");
  if (!rootDeclarator(providerBody, providerLexical, native.index) || !scopeOwnsBinding(providerBody, provider.params, binding.value)) throw drift("native Applications is not the provider local declaration");
  const references = bindingReferences(providerBody, providerLexical, binding.value, native.index);
  if (references.length !== 1 || references[0].start !== binding.start) throw drift("native Applications provider binding is replaced or shadowed");
  const method = one(members.filter(member => member.name !== "constructor" && member.open < exposure.index && exposure.index < member.end), "expected ordinary native AppHost metadata method");
  const methodBody = source.slice(method.open + 1, method.end - 1), methodLexical = createJavaScriptLexicalIndex(methodBody);
  const returned = rootReturn(methodBody, methodLexical);
  const calls = matches(methodBody, methodLexical, new RegExp(String.raw`new ${MEMBER}\s*\(\s*\{`, "gu"), true);
  const host = one(calls.filter(call => {
    const open = call.index + call[0].lastIndexOf("{"), close = methodLexical.matchingBrace(open);
    return method.open + 1 + open < exposure.index && exposure.index < method.open + 1 + close;
  }), "expected returned native AppHost data record");
  if (nextCode(methodBody, methodLexical, returned.index + 6) !== host.index) throw drift("native AppHost metadata is not the returned value");
  const hostOpen = host.index + host[0].lastIndexOf("{"), hostClose = methodLexical.matchingBrace(hostOpen);
  if (!/^\)\s*;?\s*$/u.test(methodBody.slice(hostClose + 1))) throw drift("native AppHost return continuation changed");
  if (objectProperties(methodBody, hostOpen, hostClose, "nativeApplications",
    (name, reference) => localSpreadRecord(methodBody, method.params, name, reference) ??
      instanceSpreadRecord(name, source, owner, constructor)).get("nativeApplications")?.value !== "this.desktopServices.nativeApplications") throw drift("native AppHost exposure is disconnected from desktop services");
  const classBody = source.slice(owner.open + 1, owner.end - 1), classLexical = createJavaScriptLexicalIndex(classBody);
  requirePlainStorageField(classBody, classLexical, "desktopServices");
  requireLiteralOwnerIdentifiers(classBody, classLexical, ["nativeApplications", method.name]);
  const receiverReferences = thisMemberReferences(classBody, classLexical);
  const methodWrites = receiverReferences.filter(reference => memberWrite(classBody, reference, method.name));
  if (methodWrites.length) throw drift("native AppHost metadata method is shadowed on its instance");
  if (matches(classBody, classLexical, new RegExp(String.raw`(?<![\w$.#])${escapeRegExp(method.name)}(?![\w$])`, "gu"), true).length !== 1) throw drift("native AppHost metadata method is replaced");
  const writes = receiverReferences.filter(reference => memberWrite(classBody, reference, "desktopServices"));
  if (writes.length !== 1 || owner.open + 1 + writes[0].start !== constructor.open + 1 + assignment.index) throw drift("desktop-services instance binding is replaced");
  const access = receiverReferences.filter(reference => reference.members[0] === "desktopServices" && reference.members[1] === "nativeApplications");
  if (access.length !== 1 || owner.open + 1 + access[0].start !== exposure.index + "nativeApplications:".length) throw drift("native Applications exposure has unknown uses");
  const insert = factory.start + constructor.open + 1 + provider.open + 1 + native.index + native[0].indexOf(native.groups.head) + native.groups.head.length;
  return { factoryId: factory.identity, insert, patched: native.groups.patched != null, className: owner.name, providerBinding: binding.value };
}
function skipTrivia(source, at) {
  for (;;) {
    while (/\s/u.test(source[at] ?? "") && at < source.length) at += 1;
    if (source.startsWith("//", at)) { const end = source.indexOf("\n", at + 2); at = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith("/*", at)) { const end = source.indexOf("*/", at + 2); if (end < 0) throw drift("incomplete source prologue comment"); at = end + 2; continue; }
    return at;
  }
}
function runtimeInsertionPoint(source) {
  let at = skipTrivia(source, 0), insertion = at;
  while (["\"", "'"].includes(source[at])) {
    const quote = source[at]; let end = at + 1;
    for (; end < source.length && source[end] !== quote; end += 1) if (source[end] === "\\") end += 1;
    if (end >= source.length) throw drift("incomplete source directive");
    const next = skipTrivia(source, end + 1);
    const continuesExpression = /^(?:[.([`*/%<>=&|^?,]|!(?==)|\+(?!\+)|-(?!-)|(?:in|instanceof)\b)/u.test(source.slice(next));
    if (source[next] === ";") insertion = next + 1;
    else if (next === source.length) insertion = next;
    else if (/[\r\n\u2028\u2029]/u.test(source.slice(end + 1, next)) && !continuesExpression) insertion = next;
    else break;
    at = skipTrivia(source, insertion);
  }
  return insertion;
}
function analyze(source) {
  const relevant = source.includes("this.desktopServices") && source.includes("nativeApplications");
  if (!relevant) return null;
  const factories = mainProcessFactories(source);
  const candidates = factories.filter(factory => factory.body.includes("nativeApplications:this.desktopServices.nativeApplications") || factory.body.includes("this.desktopServices=function("));
  const info = providerOwner(one(candidates, "missing or ambiguous native desktop-services factory"));
  const runtime = runtimeSource(), markers = source.split(MARKER).length - 1, runtimes = source.split(runtime).length - 1;
  if (!info.patched) {
    if (markers || runtimes || source.includes(RUNTIME_NAME)) throw drift("partial native Applications runtime");
    return { ...info, runtime, state: "current" };
  }
  if (markers !== 1 || runtimes !== 1) throw drift("incomplete native Applications runtime");
  const without = source.replace(runtime, ""), point = runtimeInsertionPoint(without);
  if (source !== without.slice(0, point) + runtime + without.slice(point)) throw drift("native runtime is outside the original directive prologue");
  const lexical = createJavaScriptLexicalIndex(source);
  const references = bindingReferences(source, lexical, RUNTIME_NAME, point + "function ".length);
  const expected = info.insert + LINUX_BRANCH.indexOf(RUNTIME_NAME);
  if (references.length !== 1 || references[0].start !== expected) throw drift("native runtime binding is replaced or shadowed");
  return { ...info, runtime, state: "patched" };
}
function applyNativeApplicationsPatch(source) {
  const info = analyze(source);
  if (!info) {
    console.warn("WARN: Could not find the native Applications metadata owner - skipping Linux native Applications patch");
    return source;
  }
  if (info.state === "patched") return source;
  const withBranch = source.slice(0, info.insert) + LINUX_BRANCH + source.slice(info.insert);
  const point = runtimeInsertionPoint(withBranch);
  const patched = withBranch.slice(0, point) + info.runtime + withBranch.slice(point);
  new Script(patched);
  if (analyze(patched)?.state !== "patched") throw drift("incomplete native Applications result");
  return patched;
}
function patchNativeApplicationsAssets(extractedDir) {
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) throw drift("missing native main-process inventory");
  const chunks = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8");
    return { assetName, source, factories: mainProcessFactories(source) };
  });
  const candidates = chunks.flatMap(chunk => chunk.factories.filter(factory =>
    factory.body.includes("nativeApplications:this.desktopServices.nativeApplications") || factory.body.includes("this.desktopServices=function("))
    .map(factory => ({ chunk, factory })));
  const { chunk, factory } = one(candidates, "missing or ambiguous native Applications owner");
  const cohort = chunks.flatMap(candidate => candidate.factories.filter(copy => copy.identity === factory.identity));
  if (cohort.length !== 1) throw drift("duplicate or damaged native Applications factory cohort");
  const patchedSource = applyNativeApplicationsPatch(chunk.source);
  return { matched: 1, ...commitAssetEdits(inventory.buildDir, [{ assetName: chunk.assetName, source: chunk.source, patchedSource }]),
    reason: `Native Applications factory ${factory.identity}` };
}

module.exports = { applyNativeApplicationsPatch, patchNativeApplicationsAssets };
