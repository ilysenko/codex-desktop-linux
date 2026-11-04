"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
const {
  rspackModuleFactories,
  findRspackRequireBinding,
  findUniqueRspackModuleCopies,
  patchRspackModuleCopies,
} = require("../../scripts/patches/lib/rspack-module-assets.js");

const MARKER = "function codexLinuxDilMarkdownFallback(";
const HELPER = "codexLinuxDilMarkdownFallback";
const IDENT = "[A-Za-z_$][\\w$]*";
const MODULE_ID = /^[A-Za-z0-9_$]+$/;
const RESPONSE_NEEDLES = ["model_dil_v2", "source_message_status", ".prepareDil(", "errorFallback:"];
const MARKDOWN_EXPORT_NEEDLE = "ChatGptMarkdown:";

function chunkModules(source) {
  try {
    const modules = [...rspackModuleFactories(source, "ChatGPT DIL chunk")];
    return modules.length === 0 ? null : modules;
  } catch {
    return null;
  }
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
  if (fallbacks.length !== 1) return null;
  const [fallback] = fallbacks;
  const module = moduleAt(modules, fallback.index);
  const requireName = module?.params[2];
  if (requireName == null) return null;
  // React Compiler now receives one props object and destructures the reply
  // contract inside the component. Select the unique enclosing function by
  // that semantic destructure, never by its minified name.
  const owners = [];
  const declarations = source.slice(module.start, fallback.index).matchAll(new RegExp(
    `function ${IDENT}\\((?<props>${IDENT})\\)\\{`, "g",
  ));
  for (const declaration of declarations) {
    const start = module.start + declaration.index;
    const bodyStart = start + declaration[0].length - 1;
    const end = findMatchingBrace(source, bodyStart);
    if (end < fallback.index || end >= module.end) continue;
    const ownerSource = source.slice(start, end + 1);
    const props = escapeRegExp(declaration.groups.props);
    const destructure = ownerSource.match(new RegExp(
      `\\{experiment:${IDENT},assistantMessageId:${IDENT},reference:(${IDENT}),source:${IDENT},` +
        `onAutoSafeUrls:${IDENT},dilComponents:${IDENT},loadPublicComponents:${IDENT},surface:${IDENT}\\}=${props}`,
    ));
    if (destructure != null && RESPONSE_NEEDLES.every((needle) => ownerSource.includes(needle))) {
      owners.push({ reference: destructure[1] });
    }
  }
  if (owners.length !== 1) return null;
  const [, preparing, jsx, failure, failureProps] = fallback;
  return { module, requireName, fallback, preparing, jsx, failure, failureProps, reference: owners[0].reference };
}

// The current reply chunk also requires the native Markdown module from a
// sibling renderer (`N=require("id")` … `N.ChatGptMarkdown`), which proves that
// the module is loaded with this chunk.
function chunkRequiresMarkdownModule(source, markdownModule) {
  const modules = chunkModules(source) ?? [];
  return modules.some((module) => {
    return [...module.moduleSource.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})\\.ChatGptMarkdown\\b`, "g"))]
      .some((usage) => findRspackRequireBinding(module, usage[1])?.moduleId === markdownModule);
  });
}

function applyPristineDilMarkdownFallback(source, markdownModule) {
  const contract = replyContract(source);
  if (contract == null) throw new Error("ChatGPT interactive reply fallback contract changed");
  if (!chunkRequiresMarkdownModule(source, markdownModule)) {
    throw new Error("Native ChatGPT Markdown module is not loaded with the interactive reply chunk");
  }
  const { module, requireName, fallback, preparing, jsx, failure, failureProps, reference } = contract;
  const replacement = `errorFallback:${preparing}?null:(0,${jsx}.jsx)(codexLinuxDilMarkdownFallback,` +
    `{reference:${reference},jsx:${jsx},failure:(0,${jsx}.jsx)(${failure},{${failureProps}})}),diagnostics:`;
  return source.slice(0, module.start) + fallbackSource(requireName, markdownModule) +
    source.slice(module.start, fallback.index) + replacement +
    source.slice(fallback.index + fallback[0].length);
}

function applyDilMarkdownFallback(source, markdownModule) {
  if (!MODULE_ID.test(markdownModule)) throw new Error("Invalid native ChatGPT Markdown module id");
  if (!source.includes(HELPER)) return applyPristineDilMarkdownFallback(source, markdownModule);

  const incomplete = () => { throw new Error("Incomplete ChatGPT DIL Markdown fallback patch"); };
  if (source.split(MARKER).length - 1 !== 1 || source.split(HELPER).length - 1 !== 2) incomplete();
  const modules = chunkModules(source);
  const helperIndex = source.indexOf(MARKER);
  const module = modules == null ? null : moduleAt(modules, helperIndex);
  const requireName = module?.params[2];
  if (requireName == null || helperIndex !== module.start) incomplete();
  const helper = fallbackSource(requireName, markdownModule);
  if (source.slice(helperIndex, helperIndex + helper.length) !== helper) incomplete();

  // Undo only the exact injected seam, then require the normal contract and
  // its complete reapplication to recover this source byte-for-byte. A marker
  // or a helper in another scope cannot make damaged runtime behavior valid.
  const withoutHelper = source.slice(0, helperIndex) + source.slice(helperIndex + helper.length);
  const calls = [...withoutHelper.matchAll(new RegExp(
    `errorFallback:(${IDENT})\\?null:\\(0,(${IDENT})\\.jsx\\)\\(${HELPER},` +
    `\\{reference:(${IDENT}),jsx:(${IDENT}),failure:\\(0,(${IDENT})\\.jsx\\)\\(` +
    `(${IDENT}(?:\\.${IDENT})?),\\{([^{}]{0,200})\\}\\)\\}\\),diagnostics:`, "g",
  ))];
  if (calls.length !== 1) incomplete();
  const [call] = calls;
  const [, preparing, jsx, reference, passedJsx, failureJsx, failure, failureProps] = call;
  if (jsx !== passedJsx || jsx !== failureJsx) incomplete();
  const native = `errorFallback:${preparing}?null:(0,${jsx}.jsx)(${failure},{${failureProps}}),diagnostics:`;
  const pristine = withoutHelper.slice(0, call.index) + native + withoutHelper.slice(call.index + call[0].length);
  const contract = replyContract(pristine);
  if (contract == null || contract.module.moduleId !== module.moduleId || contract.reference !== reference ||
      contract.requireName !== requireName || applyPristineDilMarkdownFallback(pristine, markdownModule) !== source) incomplete();
  return source;
}

function completePrefix(prefix, object = false) {
  if (findMatchingBrace("{" + prefix + "}", 0) !== prefix.length + 1) return false;
  try {
    // Parsing only: an unfinished initializer, arrow, or for-condition must
    // not make a nested registration/property look like a direct one.
    new vm.Script(object ? `({${prefix}\n})` : `(function(){${prefix}\n})`);
    return true;
  } catch {
    return false;
  }
}

function markdownEntries(record, getter) {
  const value = getter ? `\\(\\s*\\)\\s*=>\\s*${IDENT}` : IDENT;
  const entries = [...record.matchAll(new RegExp(
    `(?:^|,)\\s*ChatGptMarkdown\\s*:\\s*${value}\\s*(?=,|$)`, "g",
  ))];
  return entries.filter(entry => completePrefix(record.slice(0, entry.index), true)).length;
}

function markdownExportCount(module) {
  const [, exportsName, requireName] = module.params;
  if (exportsName == null || requireName == null) return 0;
  const body = module.moduleSource;
  if (!body.includes(MARKDOWN_EXPORT_NEEDLE)) return 0;
  const calls = new RegExp(
    `(?:^|[;}])\\s*${escapeRegExp(requireName)}\\.d\\(\\s*${escapeRegExp(exportsName)}\\s*,\\s*`, "g",
  );
  let count = 0;
  for (const call of body.matchAll(calls)) {
    const callStart = call.index + call[0].indexOf(requireName);
    if (!completePrefix(body.slice(0, callStart))) continue;
    let cursor = call.index + call[0].length;
    const records = [];
    for (let record = 0; record < 2 && body[cursor] === "{"; record++) {
      const close = findMatchingBrace(body, cursor);
      if (close < 0) break;
      records.push(body.slice(cursor + 1, close));
      cursor = close + 1;
      while (/\s/.test(body[cursor] ?? "") && cursor < body.length) cursor++;
      if (body[cursor] !== "," || record === 1) break;
      cursor++;
      while (/\s/.test(body[cursor] ?? "") && cursor < body.length) cursor++;
    }
    if (body[cursor] !== ")" || records.length === 0) continue;
    count += markdownEntries(records[0], true);
    if (records.length === 2) count += markdownEntries(records[1], false);
  }
  return count;
}

// Only the actual factory exports argument and its bounded getter/value
// records establish authority for the named native Markdown component.
function findMarkdownModule(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const ids = new Set();
  for (const assetName of findWebviewAssetsContaining(extractedDir, [MARKDOWN_EXPORT_NEEDLE])) {
    const source = fs.readFileSync(path.join(assets, assetName), "utf8");
    const modules = chunkModules(source);
    if (modules == null) continue;
    for (const module of modules) if (markdownExportCount(module) === 1) ids.add(module.moduleId);
  }
  return [...ids];
}

function patchDilMarkdownFallback(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview", "assets");
  const responses = findUniqueRspackModuleCopies(assets, {
    description: "ChatGPT interactive reply",
    sourceMatch: source => RESPONSE_NEEDLES.every(needle => source.includes(needle)),
    matchModule: source => RESPONSE_NEEDLES.every(needle => source.includes(needle)) &&
      new RegExp(`\\{experiment:${IDENT},assistantMessageId:${IDENT},reference:${IDENT},source:${IDENT},onAutoSafeUrls:${IDENT},dilComponents:${IDENT},loadPublicComponents:${IDENT},surface:${IDENT}\\}`).test(source),
  });
  const markdown = findMarkdownModule(extractedDir);
  if (responses.length === 0 || markdown.length !== 1) {
    throw new Error(`Expected interactive reply modules and one native Markdown module; found ${responses.length} and ${markdown.length}`);
  }
  const result = patchRspackModuleCopies(assets, responses, (body, copy) => {
    const source = copy.source.slice(0, copy.start) + body + copy.source.slice(copy.end);
    const output = applyDilMarkdownFallback(source, markdown[0]);
    return output.slice(copy.start, output.length - (copy.source.length - copy.end));
  }, options);
  return { ...result, changed: result.changed > 0 };
}

module.exports = {
  fallbackSource,
  applyDilMarkdownFallback,
  findMarkdownModule,
  patchDilMarkdownFallback,
  descriptors: [{
    id: "chatgpt-dil-markdown-fallback",
    phase: "extracted-app:pre-webview",
    ciPolicy: "opt-in",
    apply: patchDilMarkdownFallback,
  }],
};
