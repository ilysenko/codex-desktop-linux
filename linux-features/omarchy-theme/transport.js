"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const CHANNEL = "codex_desktop:linux-omarchy-theme-css";
const BRIDGE = "codexLinuxOmarchyTheme";
const THEME_CSS_ENV = "CODEX_LINUX_OMARCHY_STYLESHEET_URI";
const TRANSPORT_VERSION = "omarchy-theme-transport-v1";
const MAX_CSS_BYTES = 4 * 1024 * 1024;

function mainRuntimeSource() {
  return [
    ";(()=>{",
    `const VERSION=${JSON.stringify(TRANSPORT_VERSION)},CHANNEL=${JSON.stringify(CHANNEL)},ENV=${JSON.stringify(THEME_CSS_ENV)},MAX=${MAX_CSS_BYTES};`,
    "if(globalThis.codexLinuxOmarchyThemeMainVersion===VERSION)return;",
    "const{ipcMain}=require(`electron`),fs=require(`node:fs/promises`),{constants}=require(`node:fs`),{fileURLToPath}=require(`node:url`);",
    "globalThis.codexLinuxOmarchyThemeMainCleanup?.();",
    "ipcMain.handle(CHANNEL,async(event)=>{let file;try{const frame=event.senderFrame;if(!frame||frame.parent!=null||event.sender?.isDestroyed?.())return null;const origin=new URL(frame.url);if(origin.protocol!==`app:`||origin.hostname!==`-`||origin.port!==``||origin.username||origin.password||origin.pathname!==`/index.html`)return null;const value=process.env[ENV];if(!value)return null;const uri=new URL(value);if(uri.protocol!==`file:`)return null;file=await fs.open(fileURLToPath(uri),constants.O_RDONLY|constants.O_NONBLOCK);const stat=await file.stat();if(!stat.isFile()||stat.size>MAX)return null;const buffer=Buffer.alloc(MAX+1);let length=0;while(length<buffer.length){const{bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(bytesRead===0)break;length+=bytesRead}return length>MAX?null:buffer.subarray(0,length).toString(`utf8`)}catch{return null}finally{if(file)try{await file.close()}catch{}}});",
    "globalThis.codexLinuxOmarchyThemeMainCleanup=()=>{ipcMain.removeHandler(CHANNEL);if(globalThis.codexLinuxOmarchyThemeMainVersion===VERSION)delete globalThis.codexLinuxOmarchyThemeMainVersion};",
    "globalThis.codexLinuxOmarchyThemeMainVersion=VERSION;",
    "})();",
  ].join("");
}

function preloadRuntimeSource() {
  return [
    ";(()=>{",
    `const VERSION=${JSON.stringify(TRANSPORT_VERSION)},CHANNEL=${JSON.stringify(CHANNEL)},BRIDGE=${JSON.stringify(BRIDGE)};`,
    "if(globalThis.codexLinuxOmarchyThemePreloadVersion===VERSION)return;",
    "const{contextBridge,ipcRenderer}=require(`electron`);",
    "contextBridge.exposeInMainWorld(BRIDGE,{readStylesheet:()=>ipcRenderer.invoke(CHANNEL)});",
    "globalThis.codexLinuxOmarchyThemePreloadVersion=VERSION;",
    "})();",
  ].join("");
}

function hasTransportMarker(source) {
  return /\bcodexLinuxOmarchyTheme(?:MainVersion|MainCleanup|PreloadVersion)?\b/u.test(source) || source.includes(CHANNEL);
}

function runtimeState(source, runtime, owner) {
  if (typeof source !== "string") return "invalid";
  const offset = source.indexOf(runtime);
  if (offset < 0) return !owner(source) || hasTransportMarker(source) ? "invalid" : "current";
  if (source.indexOf(runtime, offset + runtime.length) >= 0) return "invalid";
  const before = source.slice(0, offset);
  if (findMatchingBrace("{" + before + "}", 0) !== before.length + 1) return "invalid";
  const nativeSource = before + source.slice(offset + runtime.length);
  // Injected require/bridge calls cannot prove that native bootstrap remains.
  return !owner(nativeSource) || hasTransportMarker(nativeSource) ? "invalid" : "patched";
}

function isNativePreload(source) {
  return ["exposeInMainWorld(\"electronBridge\"", "codex_desktop:get-system-theme-variant", "getDesktopUserAgent"].every((needle) => source.includes(needle));
}

function appendRuntime(source, runtime, owner) {
  const state = runtimeState(source, runtime, owner);
  if (state === "invalid") throw new Error("Incomplete or misplaced Omarchy CSS transport runtime");
  return state === "patched" ? source : source + "\n" + runtime;
}

// index.html is the authoritative renderer entry path. Its contents must also
// retain the current root bootstrap contract; a detached/async lookalike is not
// an alternative entry. Prepare every edit before the verified transaction.
function applyOmarchyThemeToApp(extractedDir, options = {}) {
  const renderer = require("./patch.js");
  const manifest = JSON.parse(fs.readFileSync(path.join(extractedDir, "package.json"), "utf8"));
  if (manifest.type === "module" || typeof manifest.main !== "string" || path.isAbsolute(manifest.main)) throw new Error("Missing Omarchy main entry");
  const mainName = path.posix.normalize(manifest.main).replace(/^\.\//u, "");
  if (!mainName.startsWith(".vite/build/") || !mainName.endsWith(".js") || mainName.split("/").includes("..")) {
    throw new Error("Unsupported Omarchy main entry");
  }
  const buildDir = path.join(extractedDir, ".vite/build");
  const preloads = fs.readdirSync(buildDir).filter((name) => name.endsWith(".js"))
    .map((name) => ({ assetName: `.vite/build/${name}`, source: fs.readFileSync(path.join(buildDir, name), "utf8") }))
    .filter(({ source }) => isNativePreload(source) || /\bcodexLinuxOmarchyThemePreloadVersion\b/u.test(source));
  if (preloads.length !== 1) throw new Error("Expected one native Omarchy preload entry");
  const html = fs.readFileSync(path.join(extractedDir, "webview/index.html"), "utf8");
  const references = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/giu)]
    .map((match) => /^(?:\.\/|\/)?assets\/([^?#]+\.js)$/u.exec(match[1])?.[1]).filter(Boolean);
  const entries = references.filter((name) => !name.includes("/"))
    .map((name) => ({ assetName: `webview/assets/${name}`, source: fs.readFileSync(path.join(extractedDir, "webview/assets", name), "utf8") }))
    .filter(({ source, assetName }) => renderer.isWebviewIndexEntry(source, path.basename(assetName)) || renderer.hasOmarchyRuntimeMarker(source));
  if (entries.length !== 1) throw new Error("Expected one loaded Omarchy renderer root entry");
  const main = { assetName: mainName, source: fs.readFileSync(path.join(extractedDir, mainName), "utf8") };
  const [preload] = preloads, [entry] = entries;
  const mainOwner = (source) => /\brequire\(/u.test(source);
  const states = [runtimeState(main.source, mainRuntimeSource(), mainOwner), runtimeState(preload.source, preloadRuntimeSource(), isNativePreload), renderer.omarchyThemeState(entry.source)];
  if (states.includes("invalid") || new Set(states).size !== 1) throw new Error("Incomplete or mixed Omarchy CSS transport/renderer state");
  const edits = [
    { ...main, patchedSource: appendRuntime(main.source, mainRuntimeSource(), mainOwner) },
    { ...preload, patchedSource: appendRuntime(preload.source, preloadRuntimeSource(), isNativePreload) },
    { ...entry, patchedSource: renderer.applyOmarchyThemeLoader(entry.source) },
  ];
  return commitAssetEdits(extractedDir, edits, options);
}

module.exports = { CHANNEL, BRIDGE, THEME_CSS_ENV, TRANSPORT_VERSION, MAX_CSS_BYTES, mainRuntimeSource, preloadRuntimeSource, runtimeState, isNativePreload, applyOmarchyThemeToApp };
