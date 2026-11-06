"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");

const MARKER = "function codexLinuxDilMarkdownFallback(";
const IDENT = "[A-Za-z_$][\\w$]*";
const MODULE_ID = /^[A-Za-z0-9_$]+$/;
const MODULES_MARKER = "export const __webpack_modules__={";
const RESPONSE_NEEDLES = ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"];
const MARKDOWN_EXPORT_NEEDLE = "ChatGptMarkdown:";

// Lists the module factories of one rspack chunk
// (`export const __webpack_modules__={id(e,t,n){…},…}`), or null.
function chunkModules(source) {
  const start = source.indexOf(MODULES_MARKER);
  if (start < 0) return null;
  const header = /([A-Za-z0-9_$]+|"[^"\\]*")\(([A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*)*)?\)\{/y;
  const modules = [];
  let index = start + MODULES_MARKER.length;
  while (source[index] !== "}") {
    header.lastIndex = index;
    const match = header.exec(source);
    if (match == null) return null;
    const bodyStart = index + match[0].length;
    const close = findMatchingBrace(source, bodyStart - 1);
    if (close < 0) return null;
    modules.push({
      id: match[1].replace(/^"|"$/g, ""),
      params: match[2]?.split(",") ?? [],
      start: index,
      bodyStart,
      end: close + 1,
    });
    index = close + 1;
    if (source[index] === ",") index += 1;
  }
  return modules;
}

function moduleAt(modules, index) {
  return modules.find((module) => module.start <= index && index < module.end) ?? null;
}

// The fallback is declared at the top of the reply module's factory, so the
// factory's own require parameter resolves the native Markdown module. The
// JSX runtime and the original failure element are passed in from the reply.
// The Markdown module is resolved only when a failure is rendered; any
// resolution problem keeps the original upstream failure.
function fallbackSource(requireName, markdownModule) {
  if (!MODULE_ID.test(markdownModule)) throw new Error("Invalid native ChatGPT Markdown module id");
  return `${MARKER}codexLinuxDilProps){` +
    "let codexLinuxDil=codexLinuxDilProps.reference?.model_dil_v2," +
    "codexLinuxMarkdown=codexLinuxDil?.fallbackMarkdown,codexLinuxView;" +
    "if(1!==codexLinuxDil?.fallbackMarkdownVersion||\"string\"!=typeof codexLinuxMarkdown||" +
    "0===codexLinuxMarkdown.trim().length)return codexLinuxDilProps.failure;" +
    `try{codexLinuxView=${requireName}("${markdownModule}").ChatGptMarkdown}catch{}` +
    "if(null==codexLinuxView)return codexLinuxDilProps.failure;" +
    "let codexLinuxJsx=codexLinuxDilProps.jsx.jsx;" +
    "return codexLinuxJsx(\"div\",{\"data-dil-markdown-fallback\":\"\"," +
    "children:codexLinuxJsx(codexLinuxView,{isStreaming:!1,textStyle:{kind:\"assistant-message\"}," +
    "children:codexLinuxMarkdown})})}";
}

function replyContract(source) {
  const modules = chunkModules(source);
  if (modules == null) return null;
  const fallbacks = [...source.matchAll(new RegExp(
    `errorFallback:(${IDENT})\\?null:\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}(?:\\.${IDENT})?),\\{([^{}]{0,200})\\}\\),diagnostics:`, "g",
  ))];
  const owners = [...source.matchAll(new RegExp(
    `function ${IDENT}\\(\\{(?:${IDENT}:${IDENT},)*assistantMessageId:${IDENT},reference:(${IDENT}),source:${IDENT},`, "g",
  ))];
  if (fallbacks.length !== 1 || owners.length !== 1) return null;
  const [fallback] = fallbacks;
  const [owner] = owners;
  const module = moduleAt(modules, owner.index);
  const requireName = module?.params[2];
  if (requireName == null || moduleAt(modules, fallback.index) !== module) return null;
  // The failure branch must belong to the reply renderer itself.
  const ownerBodyStart = source.indexOf("{", owner.index + owner[0].length);
  const ownerEnd = findMatchingBrace(source, ownerBodyStart);
  if (ownerEnd < 0 || fallback.index < ownerBodyStart || fallback.index > ownerEnd) return null;
  const ownerSource = source.slice(owner.index, ownerEnd);
  if (!RESPONSE_NEEDLES.every((needle) => ownerSource.includes(needle))) return null;
  const [, preparing, jsx, failure, failureProps] = fallback;
  return { module, requireName, fallback, preparing, jsx, failure, failureProps, reference: owner[1] };
}

// The current reply chunk also requires the native Markdown module from a
// sibling renderer (`N=require("id")` … `N.ChatGptMarkdown`), which proves that
// the module is loaded with this chunk.
function chunkRequiresMarkdownModule(source, markdownModule, markdownChunk) {
  const modules = chunkModules(source) ?? [];
  return modules.some((module) => {
    const requireName = module.params[2];
    if (requireName == null) return false;
    const body = source.slice(module.start, module.end);
    const binding = body.match(new RegExp(
      `(?<![\\w$.])(${IDENT})=${escapeRegExp(requireName)}\\("${escapeRegExp(markdownModule)}"\\)`,
    ));
    return binding != null && body.includes(`${binding[1]}.ChatGptMarkdown`);
  }) || (Number.isSafeInteger(markdownChunk) &&
    new RegExp(`${IDENT}\\.e\\(${markdownChunk}\\)`).test(source));
}

function applyDilMarkdownFallback(source, markdownModule, markdownChunk) {
  if (!MODULE_ID.test(markdownModule)) throw new Error("Invalid native ChatGPT Markdown module id");
  const markerCount = source.split(MARKER).length - 1;
  if (markerCount > 0) {
    const patchedFallbacks = source.split("jsx)(codexLinuxDilMarkdownFallback,{reference:").length - 1;
    if (markerCount === 1 && patchedFallbacks === 1 && source.includes(`("${markdownModule}").ChatGptMarkdown`)) {
      return source;
    }
    throw new Error("Incomplete ChatGPT DIL Markdown fallback patch");
  }
  const contract = replyContract(source);
  if (contract == null) throw new Error("ChatGPT interactive reply fallback contract changed");
  if (!chunkRequiresMarkdownModule(source, markdownModule, markdownChunk)) {
    throw new Error("Native ChatGPT Markdown module is not loaded with the interactive reply chunk");
  }
  const { module, requireName, fallback, preparing, jsx, failure, failureProps, reference } = contract;
  const replacement = `errorFallback:${preparing}?null:(0,${jsx}.jsx)(codexLinuxDilMarkdownFallback,` +
    `{reference:${reference},jsx:${jsx},failure:(0,${jsx}.jsx)(${failure},{${failureProps}})}),diagnostics:`;
  return source.slice(0, module.bodyStart) + fallbackSource(requireName, markdownModule) +
    source.slice(module.bodyStart, fallback.index) + replacement +
    source.slice(fallback.index + fallback[0].length);
}

// Finds the unique module exporting the named ChatGptMarkdown component.
function findMarkdownModule(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const ids = new Set();
  for (const assetName of findWebviewAssetsContaining(extractedDir, [MARKDOWN_EXPORT_NEEDLE])) {
    const source = fs.readFileSync(path.join(assets, assetName), "utf8");
    const modules = chunkModules(source);
    if (modules == null) continue;
    for (const entry of source.matchAll(new RegExp(`[{,]ChatGptMarkdown:(?:\\(\\)=>)?${IDENT}(?=[,}])`, "g"))) {
      const module = moduleAt(modules, entry.index);
      const requireName = module?.params[2];
      if (requireName == null) continue;
      // The entry must be part of the factory's export definition call.
      const before = source.slice(module.bodyStart, entry.index);
      const exportCall = before.lastIndexOf(`${requireName}.d(`);
      if (exportCall < 0 || /[;]/.test(before.slice(exportCall).replace(/"[^"]*"/g, ""))) continue;
      ids.add(module.id);
    }
  }
  return [...ids];
}

function findMarkdownChunk(extractedDir, markdownModule) {
  const assets = path.join(extractedDir, "webview", "assets");
  const chunks = new Set();
  for (const assetName of findWebviewAssetsContaining(extractedDir, [MARKDOWN_EXPORT_NEEDLE])) {
    const source = fs.readFileSync(path.join(assets, assetName), "utf8");
    const modules = chunkModules(source);
    if (!modules?.some((module) => module.id === markdownModule)) continue;
    const header = source.match(/^export const __rspack_esm_ids=\[(\d+)\];/);
    if (header != null) chunks.add(Number(header[1]));
  }
  return [...chunks];
}

function patchDilMarkdownFallback(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const responses = findWebviewAssetsContaining(extractedDir, RESPONSE_NEEDLES).map((file) => ({
    file,
    source: fs.readFileSync(path.join(assets, file), "utf8"),
  })).filter(({ source }) => source.includes(MARKER) || replyContract(source) != null);
  const markdown = findMarkdownModule(extractedDir);
  const markdownChunks = markdown.length === 1 ? findMarkdownChunk(extractedDir, markdown[0]) : [];
  if (responses.length === 0 || markdown.length !== 1) {
    throw new Error(`Expected interactive reply modules and one native Markdown module; found ${responses.length} and ${markdown.length}`);
  }
  // Older reply chunks synchronously require the Markdown factory, while the
  // current bundle reaches it through one uniquely identified async chunk.
  // Duplicate exporter chunks are harmless for the synchronous contract but
  // must not be guessed for the async one.
  const markdownChunk = markdownChunks.length === 1 ? markdownChunks[0] : undefined;
  // Validate every copy of the reply module before writing any of them.
  const outputs = responses.map(({ file, source }) => ({ file, source, output: applyDilMarkdownFallback(source, markdown[0], markdownChunk) }));
  const changed = outputs.filter(({ source, output }) => output !== source);
  for (const { file, output } of changed) fs.writeFileSync(path.join(assets, file), output, "utf8");
  return { changed: changed.length > 0 };
}

module.exports = {
  fallbackSource,
  applyDilMarkdownFallback,
  findMarkdownModule,
  findMarkdownChunk,
  patchDilMarkdownFallback,
  descriptors: [{
    id: "chatgpt-dil-markdown-fallback",
    phase: "extracted-app:pre-webview",
    ciPolicy: "opt-in",
    apply: patchDilMarkdownFallback,
  }],
};
