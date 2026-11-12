"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { escapeRegExp, findMatchingBrace, createJavaScriptLexicalIndex } = require("../../scripts/patches/lib/minified-js.js");
const { findWebviewAssetsContaining, listWebviewScriptAssets, patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const {
  rspackModuleFactories,
  findRspackRequireBinding,
  findUniqueRspackModuleCopies,
} = require("../../scripts/patches/lib/rspack-module-assets.js");

const MARKER = "function codexLinuxDilMarkdownFallback(";
const HELPER = "codexLinuxDilMarkdownFallback";
const IDENT = "[A-Za-z_$][\\w$]*";
const MODULE_ID = /^[A-Za-z0-9_$]+$/;
const OWNED = /\bcodexLinuxDil[\w$]*\b|data-dil-markdown-fallback/u;
const IDENTIFIER_TOKENS = /(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/gu;
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

function decodedIdentifier(token) {
  return token.replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
    (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
}

function hasEscapedOwnedIdentifier(source) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(IDENTIFIER_TOKENS)].some(token => token[0].includes("\\u") &&
    lexical.isCode(token.index) && /^codexLinuxDil[\w$]*$/u.test(decodedIdentifier(token[0])));
}

// Reuse the shared lexical publication proof for a static import's subsequent
// reads. Only its verified declaration leaf and the unique verified exports
// argument change in this parse-only projection. Every later use stays intact.
function importBindingProbe(module, name) {
  const binding = findRspackRequireBinding(module, name);
  const publication = findRspackExportPublication(module, "DilResponse");
  if (binding == null || publication?.expression == null || module.params.includes(name)) return null;
  const body = module.moduleSource, lexical = createJavaScriptLexicalIndex(body);
  const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(publication.requireName)}\\.d\\(${escapeRegExp(publication.exportsName)},\\{`, "gu");
  const calls = [...body.matchAll(pattern)].filter(call => lexical.isRoot(call.index));
  if (calls.length !== 1) return null;
  const declarationStart = binding.start - module.start;
  const exportsStart = calls[0].index + calls[0][0].indexOf("(") + 1;
  if (declarationStart < 0 || body.slice(declarationStart, declarationStart + name.length) !== name ||
      body[declarationStart + name.length] !== "=" ||
      body.slice(exportsStart, exportsStart + publication.exportsName.length) !== publication.exportsName) return null;
  let probeName = "__codexDilImportProbe";
  while (body.includes(probeName)) probeName += "$";
  const edits = [
    { start: declarationStart, end: declarationStart + name.length, before: name, after: probeName },
    { start: exportsStart, end: exportsStart + publication.exportsName.length, before: publication.exportsName, after: name },
  ].sort((a, b) => b.start - a.start);
  if (edits[1].end > edits[0].start) return null;
  let projected = body;
  for (const edit of edits) {
    if (body.slice(edit.start, edit.end) !== edit.before) return null;
    projected = projected.slice(0, edit.start) + edit.after + projected.slice(edit.end);
  }
  const params = [module.params[0], name, module.params[2]];
  const result = findRspackExportPublication({ moduleSource: projected, params }, "DilResponse");
  return { valid: result?.exportsName === name && result.requireName === publication.requireName &&
    result.expression === publication.expression, original: publication, result, params, edits, projected };
}

function rootFunctions(module) {
  const body = module.moduleSource, lexical = createJavaScriptLexicalIndex(body);
  const declarations = new RegExp(`(?:async )?function (?<name>${IDENT})\\((?<params>[^()]*)\\)\\{`, "gu");
  return [...body.matchAll(declarations)].filter(head => {
    if (!lexical.isRoot(head.index)) return false;
    try { new Script(`function declarationProbe(){${body.slice(0, head.index)}\nconst reached=0;}`); return true; }
    catch { return false; }
  }).map(head => {
    const open = head.index + head[0].length - 1, end = findMatchingBrace(body, open);
    return { name: head.groups.name, params: head.groups.params, start: head.index, open, end,
      nameStart: head.index + head[0].indexOf(head.groups.name, head[0].indexOf("function") + 8),
      source: body.slice(head.index, end + 1) };
  });
}

// The current exported wrapper and reply are root function declarations.
// Preserve the native reply's local same-spelled context binding while keeping
// writes to the outer declarations visible, including default/computed uses.
function stableFunctionBinding(module, declaration, functions) {
  const body = module.moduleSource, projected = body.split(""), name = declaration.name;
  const parses = source => { try { new Script(source); return true; } catch { return false; } };
  const blank = (start, end) => { for (let index = start; index < end; index++) if (!/[\r\n]/u.test(projected[index])) projected[index] = " "; };
  for (const fn of functions) {
    if (!fn.source.includes(name) || !parses(fn.source) || parses(fn.source.slice(0, -1) + `;let ${name};}`)) continue;
    const header = body.slice(fn.start, fn.open + 1);
    if (!parses(header + `let ${name};}`)) blank(fn.start + fn.source.indexOf("(") + 1, fn.open - 1);
    blank(fn.open + 1, fn.end);
  }
  const projection = projected.join(""), lexical = createJavaScriptLexicalIndex(projection);
  const scopeParses = source => parses(`function bindingProbe(${module.params.join(",")}){${source}}`);
  for (const token of projection.matchAll(IDENTIFIER_TOKENS)) {
    const decoded = decodedIdentifier(token[0]);
    if (decoded !== name || token.index === declaration.nameStart || !lexical.isCode(token.index) ||
        [".", "#"].includes(projection[token.index - 1]) || /^\s*:/u.test(projection.slice(token.index + token[0].length))) continue;
    const replace = value => projection.slice(0, token.index) + value + projection.slice(token.index + token[0].length);
    if (!scopeParses(replace("(0)")) && !scopeParses(replace(`${name}:(0)`))) return false;
  }
  return true;
}

function publishedRendererContract(module, publication, ownerName, ownerStart, jsx) {
  if (!new RegExp(`^${IDENT}$`, "u").test(publication.expression ?? "")) return false;
  const functions = rootFunctions(module);
  const declarations = name => functions.filter(fn => fn.name === name);
  const owners = declarations(ownerName), published = declarations(publication.expression);
  if (owners.length !== 1 || published.length !== 1 || owners[0].start !== ownerStart ||
      ![owners[0], published[0]].every(fn => stableFunctionBinding(module, fn, functions))) return false;
  if (published[0] === owners[0]) return true;

  const wrapper = published[0], body = module.moduleSource.slice(wrapper.open + 1, wrapper.end);
  if (!new RegExp(`^${IDENT}$`, "u").test(wrapper.params)) return false;
  const lexical = createJavaScriptLexicalIndex(body);
  const rootMatches = pattern => [...body.matchAll(pattern)].filter(match => lexical.isRoot(match.index));
  const props = rootMatches(new RegExp(`\\{experiment:(?<experiment>${IDENT}),reference:(?<reference>${IDENT}),dilComponents:(?<components>${IDENT}),surface:(?<surface>${IDENT})\\}=${escapeRegExp(wrapper.params)}(?=[,;])`, "gu"));
  if (props.length !== 1) return false;
  const fields = props[0].groups;
  const call = new RegExp(`\\(0,${escapeRegExp(jsx)}\\.jsx\\)\\(${escapeRegExp(ownerName)},\\{experiment:${escapeRegExp(fields.experiment)},assistantMessageId:(?<context>${IDENT})\\.messageId,` +
    `dilComponents:${escapeRegExp(fields.components)}\\?\\?(?<catalog>${IDENT})\\.${IDENT},loadPublicComponents:void 0===${escapeRegExp(fields.components)},` +
    `reference:${escapeRegExp(fields.reference)},source:(?<parsed>${IDENT})\\.data,onAutoSafeUrls:(?<safeUrls>${IDENT})\\.approve,surface:${escapeRegExp(fields.surface)}\\}\\)`, "gu");
  const calls = [...body.matchAll(call)].filter(match => lexical.isCode(match.index));
  if (calls.length !== 1) return false;
  const [mounted] = calls, { context, catalog, parsed, safeUrls } = mounted.groups;
  const parses = rootMatches(new RegExp(`(?<![\\w$.])${escapeRegExp(parsed)}=(?<schema>${IDENT})\\.${IDENT}\\.safeParse\\(${escapeRegExp(fields.reference)}\\),`, "gu"));
  const providers = rootMatches(new RegExp(`(?<![\\w$.])${escapeRegExp(context)}=\\(0,(?<provider>${IDENT})\\.${IDENT}\\)\\(\\)`, "gu"));
  if (parses.length !== 1 || providers.length !== 1) return false;
  const trees = rootMatches(new RegExp(`return\\(0,${escapeRegExp(jsx)}\\.jsxs\\)\\(${escapeRegExp(providers[0].groups.provider)}\\.${IDENT}\\.Provider,\\{`, "gu"));
  if (trees.length !== 1) return false;
  const tree = trees[0], open = tree.index + tree[0].length - 1, end = findMatchingBrace(body, open);
  const child = new RegExp(`children:\\[\\(0,${escapeRegExp(jsx)}\\.jsx\\)\\(${IDENT},\\{children:$`, "u");
  if (body.slice(end + 1) !== ")" || mounted.index <= open || mounted.index + mounted[0].length >= end ||
      !child.test(body.slice(open, mounted.index)) ||
      !new RegExp(`safeUrls:${escapeRegExp(safeUrls)}\\.urls,`, "u").test(body.slice(open, mounted.index))) return false;

  const safeProducers = rootMatches(new RegExp(`(?<![\\w$.])${escapeRegExp(safeUrls)}=function\\((${IDENT}),(${IDENT})\\)\\{`, "gu"));
  if (safeProducers.length !== 1) return false;
  const safe = safeProducers[0], safeOpen = safe.index + safe[0].length - 1, safeEnd = findMatchingBrace(body, safeOpen);
  if (!body.startsWith(`(${context},${parsed}.data),`, safeEnd + 1)) return false;
  const safeBody = body.slice(safeOpen + 1, safeEnd), safeLexical = createJavaScriptLexicalIndex(safeBody);
  const safeValues = [...safeBody.matchAll(new RegExp(`(?<result>${IDENT})=\\{approve:${IDENT},urls:${IDENT}\\}`, "gu"))]
    .filter(match => safeLexical.isRoot(match.index));
  const safeReturns = [...safeBody.matchAll(/\breturn\b/gu)].filter(match => safeLexical.isRoot(match.index));
  if (safeValues.length !== 1 || safeReturns.length !== 1 ||
      !new RegExp(`(?:return |,)${escapeRegExp(safeValues[0].groups.result)}$`, "u").test(safeBody) ||
      !safeBody.includes(`${safe[2]}?.source_safe_urls`)) return false;

  const imports = [...new Set([jsx, catalog, providers[0].groups.provider, parses[0].groups.schema])];
  if (!imports.every(name => importBindingProbe(module, name)?.valid === true)) return false;
  try { new Script(wrapper.source.slice(0, -1) + `;let ${ownerName};` + imports.map(name => `let ${name};`).join("") + "}"); }
  catch { return false; }
  return true;
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
  const lexical = createJavaScriptLexicalIndex(source);
  const fallbacks = [...source.matchAll(new RegExp(
    `errorFallback:(${IDENT})\\?null:\\(0,(${IDENT})\\.jsx\\)\\((${IDENT}(?:\\.${IDENT})?),\\{([^{}]{0,200})\\}\\),diagnostics:`, "g",
  ))].filter(match => lexical.isCode(match.index));
  if (fallbacks.length !== 1) return null;
  const [fallback] = fallbacks;
  const module = moduleAt(modules, fallback.index);
  const requireName = module?.params[2];
  if (requireName == null) return null;
  const owners = rootFunctions(module).flatMap(owner => {
    if (!new RegExp(`^${IDENT}$`, "u").test(owner.params) ||
        fallback.index <= module.start + owner.open || fallback.index >= module.start + owner.end) return [];
    const body = owner.source.slice(owner.source.indexOf("{") + 1, -1);
    const bodyCode = createJavaScriptLexicalIndex(body);
    const destructures = [...body.matchAll(new RegExp(
      `\\{experiment:${IDENT},assistantMessageId:${IDENT},reference:(?<reference>${IDENT}),source:${IDENT},` +
        `onAutoSafeUrls:${IDENT},dilComponents:${IDENT},loadPublicComponents:${IDENT},surface:${IDENT}\\}=${escapeRegExp(owner.params)}(?=[,;])`, "gu",
    ))].filter(match => bodyCode.isRoot(match.index));
    return destructures.length === 1 && RESPONSE_NEEDLES.every(needle => owner.source.includes(needle))
      ? [{ ...owner, reference: destructures[0].groups.reference }] : [];
  });
  if (owners.length !== 1) return null;
  const [owner] = owners;
  const publication = findRspackExportPublication(module, "DilResponse");
  const [, preparing, jsx, failure, failureProps] = fallback;
  if (publication == null || !publishedRendererContract(module, publication, owner.name, owner.start, jsx)) return null;
  if (findRspackRequireBinding(module, jsx) == null ||
      findRspackRequireBinding(module, failure.split(".")[0]) == null) return null;
  if (![jsx, failure.split(".")[0]].every(name => importBindingProbe(module, name)?.valid === true)) return null;
  try { new Script(`${owner.source.slice(0, -1)};let ${jsx};let ${failure.split(".")[0]};}`); }
  catch { return null; }
  return { module, requireName, fallback, preparing, jsx, failure, failureProps, reference: owner.reference };
}

function applyPristineDilMarkdownFallback(source, markdownModule) {
  const contract = replyContract(source);
  if (contract == null) throw new Error("ChatGPT interactive reply fallback contract changed");
  const { module, requireName, fallback, preparing, jsx, failure, failureProps, reference } = contract;
  const replacement = `errorFallback:${preparing}?null:(0,${jsx}.jsx)(codexLinuxDilMarkdownFallback,` +
    `{reference:${reference},jsx:${jsx},failure:(0,${jsx}.jsx)(${failure},{${failureProps}})}),diagnostics:`;
  return source.slice(0, module.start) + fallbackSource(requireName, markdownModule) +
    source.slice(module.start, fallback.index) + replacement +
    source.slice(fallback.index + fallback[0].length);
}

function applyDilMarkdownFallback(source, markdownModule) {
  if (!MODULE_ID.test(markdownModule)) throw new Error("Invalid native ChatGPT Markdown module id");
  if (hasEscapedOwnedIdentifier(source)) throw new Error("Incomplete escaped DIL fallback artifact");
  if (OWNED.test(source) && !source.includes(HELPER)) throw new Error("Incomplete ChatGPT DIL Markdown fallback patch");
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
  if (OWNED.test(pristine)) incomplete();
  const contract = replyContract(pristine);
  if (contract == null || contract.module.moduleId !== module.moduleId || contract.reference !== reference ||
      contract.requireName !== requireName || applyPristineDilMarkdownFallback(pristine, markdownModule) !== source) incomplete();
  return source;
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
    for (const module of modules) if (findRspackExportPublication(module, "ChatGptMarkdown") != null) ids.add(module.moduleId);
  }
  return [...ids];
}

function chunkId(copy) {
  const lexical = createJavaScriptLexicalIndex(copy.source);
  const ids = [...copy.source.matchAll(/export const __rspack_esm_ids=\[(\d+)\];/gu)]
    .filter(match => lexical.isRoot(match.index));
  if (ids.length !== 1) throw new Error(`Missing unique native chunk registration in ${copy.assetName}`);
  return ids[0][1];
}

function hasReplyLoad(source, replyId) {
  const lexical = createJavaScriptLexicalIndex(source);
  const calls = new RegExp(`(?<![\\w$.])${IDENT}(?:\\.bind\\(${IDENT},|\\()${escapeRegExp(JSON.stringify(replyId))}\\)`, "gu");
  return [...source.matchAll(calls)].some(call => lexical.isCode(call.index));
}

// The native exported lazy component owns the anonymous callback. Every chunk
// in its Promise.all settles before the callback requires DilResponse. Verify
// all same-ID loader copies, including a damaged copy that lost its load edge.
function nativeLoaderChunks(copy, replyId) {
  const publication = findRspackExportPublication(copy, "DilResponse");
  if (publication?.expression == null) throw new Error("Missing native DIL lazy publication");
  const req = escapeRegExp(copy.params[2]), out = escapeRegExp(copy.params[1]);
  const literal = '"[A-Za-z0-9_$]+"';
  const shape = new RegExp(
    `^var (?<jsx>${IDENT})=${req}\\(${literal}\\),(?<lazy>${IDENT})=${req}\\(${literal}\\),(?<failure>${IDENT})=${req}\\(${literal}\\);` +
    `let (?<component>${IDENT})=\\(0,\\k<lazy>\\.${IDENT}\\)\\(async\\(\\)=>\\(await Promise\\.all\\(\\[(?<chunks>[^\\[\\]]+)\\]\\)\\.then\\(` +
    `${req}\\.bind\\(${req},${escapeRegExp(JSON.stringify(replyId))}\\)\\)\\)\\.DilResponse,` +
    `\\{errorFallback:\\(0,\\k<jsx>\\.jsx\\)\\(\\k<failure>\\.${IDENT},\\{stage:"host_error",initialization:!0\\}\\)\\}\\);` +
    `${req}\\.d\\(${out},\\{\\},\\{DilResponse:\\k<component>\\}\\)$`, "u");
  const match = shape.exec(copy.moduleSource)?.groups;
  if (match == null || publication.expression !== match.component ||
      ![match.jsx, match.lazy, match.failure].every(name => findRspackRequireBinding(copy, name) != null)) {
    throw new Error(`Incomplete native DIL anonymous loader in ${copy.assetName}`);
  }
  try { new Script(`function loaderPromiseProbe(${copy.params.join(",")}){${copy.moduleSource};let Promise;}`); }
  catch { throw new Error("Native DIL Promise barrier is shadowed"); }
  const outer = createJavaScriptLexicalIndex(copy.source);
  if ([...copy.source.matchAll(IDENTIFIER_TOKENS)].some(token => decodedIdentifier(token[0]) === "Promise" &&
      outer.isRoot(token.index) && ![".", "#"].includes(copy.source[token.index - 1]))) {
    throw new Error("Native DIL Promise barrier has an outer binding or write");
  }
  const trivia = "(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n\\u2028\\u2029]*(?:[\\r\\n\\u2028\\u2029]|$))*";
  const property = new RegExp(`(?<![\\w$.])(?<root>${IDENTIFIER_TOKENS.source})${trivia}\\.${trivia}(?<promise>${IDENTIFIER_TOKENS.source})` +
    `(?:${trivia}\\.${trivia}(?<member>${IDENTIFIER_TOKENS.source}))?`, "gu");
  const assignment = new RegExp(`^${trivia}(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))`, "u");
  if ([...copy.source.matchAll(property)].some(match => outer.isRoot(match.index) &&
      decodedIdentifier(match.groups.root) === "globalThis" && decodedIdentifier(match.groups.promise) === "Promise" &&
      (match.groups.member == null || decodedIdentifier(match.groups.member) === "all") &&
      (assignment.test(copy.source.slice(match.index + match[0].length)) ||
        /(?:\+\+|--)\s*$/u.test(copy.source.slice(0, match.index))))) {
    throw new Error("Native DIL Promise barrier has an outer global property write");
  }
  const calls = match.chunks.split(",");
  const chunkCall = new RegExp(`^${req}\\.e\\((\\d+)\\)$`, "u");
  const chunks = calls.map(call => chunkCall.exec(call)?.[1]);
  if (chunks.some(id => id == null) || new Set(chunks).size !== chunks.length) {
    throw new Error("Incomplete native DIL chunk load set");
  }
  return chunks;
}

function findDilLoadCohort(assets, responses, markdown) {
  const replyId = responses[0].moduleId;
  const loaders = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes(JSON.stringify(replyId)),
    matchModule: source => hasReplyLoad(source, replyId), description: "native DIL anonymous loader",
  });
  const responseChunks = new Set(responses.map(chunkId)), markdownChunks = new Set(markdown.map(chunkId));
  const loaded = new Set();
  for (const copy of loaders) {
    const chunks = nativeLoaderChunks(copy, replyId);
    if (!chunks.some(id => responseChunks.has(id)) || !chunks.some(id => markdownChunks.has(id))) {
      throw new Error("Native DIL loader does not preload the reply and Markdown modules");
    }
    for (const id of chunks) loaded.add(id);
  }
  if ([...responseChunks].some(id => !loaded.has(id))) throw new Error("Unloaded native DIL reply replica");
  return loaders;
}

function patchDilMarkdownFallback(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview", "assets");
  const responses = findUniqueRspackModuleCopies(assets, {
    description: "ChatGPT interactive reply",
    sourceMatch: source => RESPONSE_NEEDLES.every(needle => source.includes(needle)),
    matchModule: source => RESPONSE_NEEDLES.every(needle => source.includes(needle)),
  });
  const markdown = findMarkdownModule(extractedDir);
  if (responses.length === 0 || markdown.length !== 1) {
    throw new Error(`Expected interactive reply modules and one native Markdown module; found ${responses.length} and ${markdown.length}`);
  }
  const markdownCopies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => source.includes(MARKDOWN_EXPORT_NEEDLE),
    matchModule: (_body, copy) => findRspackExportPublication(copy, "ChatGptMarkdown") != null,
    description: "native ChatGPT Markdown",
  });
  if (markdownCopies.some(copy => findRspackExportPublication(copy, "ChatGptMarkdown") == null)) {
    throw new Error("Incomplete native ChatGPT Markdown replica");
  }
  const loaders = findDilLoadCohort(assets, responses, markdownCopies);
  const owningAssets = new Set(responses.map(copy => copy.assetName));
  for (const assetName of listWebviewScriptAssets(extractedDir)) {
    const source = fs.readFileSync(path.join(assets, assetName), "utf8");
    if (!owningAssets.has(assetName) && (OWNED.test(source) || hasEscapedOwnedIdentifier(source))) {
      throw new Error("DIL fallback artifact escaped its reply owner");
    }
  }
  const edits = responses.map(copy => {
    const patchedSource = applyDilMarkdownFallback(copy.source, markdown[0]);
    if (applyDilMarkdownFallback(patchedSource, markdown[0]) !== patchedSource) {
      throw new Error("Incomplete generated DIL fallback state");
    }
    return { assetName: copy.assetName, source: copy.source, patchedSource };
  });
  const changed = edits.map(edit => edit.source !== edit.patchedSource);
  if (changed.some(Boolean) && !changed.every(Boolean)) throw new Error("Partially applied Rspack module copies");
  const transaction = new Map(edits.map(edit => [edit.assetName, edit]));
  for (const copy of [...markdownCopies, ...loaders]) {
    if (!transaction.has(copy.assetName)) transaction.set(copy.assetName,
      { assetName: copy.assetName, source: copy.source, patchedSource: copy.source });
  }
  const result = patchWebviewAssets(assets, [...transaction.values()], options);
  return { ...result, matched: responses.length, changed: result.changed > 0, moduleId: responses[0].moduleId };
}

module.exports = {
  fallbackSource,
  applyDilMarkdownFallback,
  findMarkdownModule,
  findDilLoadCohort,
  patchDilMarkdownFallback,
  descriptors: [{
    id: "chatgpt-dil-markdown-fallback",
    phase: "extracted-app:pre-webview",
    ciPolicy: "opt-in",
    apply: patchDilMarkdownFallback,
  }],
};
