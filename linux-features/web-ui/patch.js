"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { connectHost } = require("./host");
const IDENT = "[A-Za-z_$][\\w$]*";
const MARKER = "/*community-web-ui-v1*/";

function one(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw Error(`Web UI: expected one ${label}, found ${matches.length}`);
  return matches[0];
}

function patchRpc(source, expression) {
  const match = one(source, /encodingLevel=`structuredClonable`/g, "MessagePort RPC codec");
  return source.replace(match[0], `encodingLevel=${expression}?\`string\`:\`structuredClonable\``);
}

function patchMain(source, wsBundle) {
  if (source.includes(MARKER)) return source;
  const header = one(source, new RegExp(`let (${IDENT})=(${IDENT})\\.u\\((${IDENT})\\);if\\(!(${IDENT})\\.app\\.isPackaged\\)`, "g"), "renderer load boundary");
  const window = one(source.slice(header.index, header.index + 600), new RegExp(`(${IDENT})\\.loadURL\\(e\\.toString\\(\\)\\)`, "g"), "renderer window")[1];
  const replacement = `if(process.env.CODEX_WEB_UI===\`1\`){` +
    `await require(require(\`node:path\`).join(process.resourcesPath,\`..\`,\`.codex-linux/features/web-ui/runtime.js\`))` +
    `.loadHost(${window},{electron:require(\`electron\`),WebSocketServer:require(${JSON.stringify(`./${wsBundle}`)}).communityWebSocketServer});return ${window}}${header[0]}`;
  let patched = source.replace(header[0], replacement);
  for (const method of ["send", "sendInline", "sendCritical"]) {
    const delivery = one(patched, new RegExp(`${method}\\(e,t,n\\)\\{e\\.isDestroyed\\(\\)\\|\\|this\\.sender\\.${method}\\(e,\\{channel:t,payload:n\\}\\)\\}`, "g"), `IPC ${method}`);
    patched = patched.replace(delivery[0], `${method}(e,t,n){if(process.env.CODEX_WEB_UI===\`1\`){if(!e.isDestroyed())e.send(t,n);return}e.isDestroyed()||this.sender.${method}(e,{channel:t,payload:n})}`);
  }
  return patchRpc(patched, "process.env.CODEX_WEB_UI===`1`") + `\n${MARKER}\n`;
}

function patchPreload(source) {
  if (source.includes(MARKER)) return source;
  const exposed = one(source, new RegExp(`(${IDENT})\\.contextBridge\\.exposeInMainWorld\\(\\\`electronBridge\\\`,(${IDENT})\\)`, "g"), "preload bridge exposure");
  const alias = exposed[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const snapshot = one(source, new RegExp(`(${IDENT})=${alias}\\.ipcRenderer\\.sendSync\\(\\\`codex_desktop:get-shared-object-snapshot\\\`\\)\\?\\?\\{\\}`, "g"), "shared-object snapshot");
  return source.replace(exposed[0], `${exposed[0]},(${connectHost.toString()})(${exposed[1]}.ipcRenderer,${exposed[2]},${snapshot[1]})`) + `\n${MARKER}\n`;
}

function patchWebSocket(source) {
  if (source.includes(MARKER)) return source;
  const server = one(source, /noServer:!1,backlog:null,server:null,host:null,path:null,port:null/g, "upstream WebSocket server");
  const prefix = source.slice(Math.max(0, server.index - 1800), server.index);
  const wrappers = [...prefix.matchAll(new RegExp(`(${IDENT})=${IDENT}\\.t\\(\\(\\(${IDENT},${IDENT}\\)=>\\{`, "g"))];
  const wrapper = wrappers.at(-1);
  if (!wrapper || !prefix.slice(wrapper.index).includes('require("http")') || !prefix.slice(wrapper.index).includes(".exports=class extends")) {
    throw Error("Web UI: upstream WebSocket server wrapper drifted");
  }
  // Reuse the signed payload's pure JS ws implementation, including its fixes.
  // No npm install, vendored library, native rebuild, or extra runtime is needed.
  return source + `\n${MARKER}\nObject.defineProperty(exports,\`communityWebSocketServer\`,{get:()=>${wrapper[1]}()});\n`;
}

function patchRenderer(source) {
  if (source.includes(MARKER)) return source;
  return patchRpc(source, "globalThis.electronBridge?.communityWebUi===true") + `\n${MARKER}\n`;
}

function apply(extractedDir) {
  const build = path.join(extractedDir, ".vite/build");
  const assets = path.join(extractedDir, "webview/assets");
  const files = dir => fs.readdirSync(dir).filter(name => name.endsWith(".js")).map(name => ({ name, file: path.join(dir, name), source: fs.readFileSync(path.join(dir, name), "utf8") }));
  const buildFiles = files(build);
  function uniqueFile(entries, match, label) {
    const candidates = entries.filter(entry => match(entry));
    if (candidates.length !== 1) throw Error(`Web UI: expected one ${label} bundle, found ${candidates.length}`);
    return candidates[0];
  }
  const main = uniqueFile(buildFiles, entry => /^main(?:-[^.]+)?\.js$/.test(entry.name), "main");
  const preload = uniqueFile(buildFiles, entry => entry.source.includes("exposeInMainWorld(`electronBridge`"), "preload");
  const imports = new Set([...main.source.matchAll(/require\("\.\/([^"/]+\.js)"\)/g)].map(match => match[1]));
  const websocket = uniqueFile(buildFiles, entry => imports.has(entry.name) && entry.source.includes("noServer:!1,backlog:null,server:null,host:null,path:null,port:null"), "WebSocket");
  const renderer = uniqueFile(files(assets), entry => entry.source.includes("connect-app-host") && (entry.source.includes("encodingLevel=`structuredClonable`") || entry.source.includes(MARKER)), "renderer RPC");
  const edits = [
    { ...main, result: patchMain(main.source, websocket.name) },
    { ...preload, result: patchPreload(preload.source) },
    { ...websocket, result: patchWebSocket(websocket.source) },
    { ...renderer, result: patchRenderer(renderer.source) },
  ];
  const html = fs.readFileSync(path.join(extractedDir, "webview/index.html"), "utf8");
  if (!html.includes("</head>") || !html.includes("connect-src ")) throw Error("Web UI: index/CSP contract drifted");
  edits.push({ file: path.join(extractedDir, "webview/community-web-host.html"), result: '<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT Community Web UI host</title></head><body>ChatGPT Community is hosting the browser interface. Open the connection URL printed in the terminal.</body></html>\n' });
  // Resolve every semantic anchor before writing anything. Drift never leaves a
  // partially adapted bundle; the enabled-feature acceptance gate rejects it.
  let changed = 0;
  for (const edit of edits) {
    const current = fs.existsSync(edit.file) ? fs.readFileSync(edit.file, "utf8") : null;
    if (current !== edit.result) { fs.writeFileSync(edit.file, edit.result); changed++; }
  }
  return { changed: changed > 0 };
}

module.exports = {
  apply, patchMain, patchPreload, patchRenderer, patchWebSocket,
  descriptors: [{ id: "browser-host-contract", phase: "extracted-app:pre-webview", order: 21_000, ciPolicy: "optional", apply }],
};
