"use strict";

const { createHash } = require("node:crypto");
const path = require("node:path");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");
const { findUniqueRspackModuleCopies, rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { patchWebviewAssets } = require("../../scripts/patches/lib/assets.js");

const ID = "[A-Za-z_$][\\w$]*";
const MARKER = "codexLinuxUsageLimitSendAttempt";
const OWNER = "CodexComposerAdapter:";
// These factory-level ABI guards supplement the published returned-chain
// checks below. They cover both physical variants in signed 26.1106.51428.
const FACTORIES = new Map([
  ["2d7b16cd3c1adbc0facdf91b4610315eeee297e7aadf134a7be83005024cf97d", "native"],
  ["e4e37f88f5614fab8d3c20d2bec745fbc967fffb9404212ad38f0b9787270a66", "applied"],
  ["eb07bb8f36ea64a425cdcbb0c51f88e27fab527b20da2f257ffde11a3f6de33d", "native"],
  ["7dae20fbd43ec4ca2a3958d994d98c6db82cb4718f472847521fd17b6e6aa8b8", "applied"],
]);

function one(values, reason) {
  if (values.length !== 1) throw new Error(`Usage-limit send attempt: ${reason}`);
  return values[0];
}

function codeMatches(source, expression, root = false) {
  const lexical = createJavaScriptLexicalIndex(source);
  return [...source.matchAll(expression)].filter(match => lexical.isCode(match.index) &&
    (!root || lexical.isRoot(match.index)));
}

function namedFunction(source, name) {
  const head = one(codeMatches(source, new RegExp(`\\bfunction ${escapeRegExp(name)}\\((${ID})\\)\\{`, "gu"), true),
    "missing or ambiguous published component");
  const open = head.index + head[0].length - 1;
  const end = createJavaScriptLexicalIndex(source).matchingBrace(open);
  if (end < open) throw new Error("Usage-limit send attempt: incomplete component");
  return { name, parameter: head[1], start: open + 1, end, body: source.slice(open + 1, end) };
}

function composerComponent(copy) {
  const [ , exportsName, requireName ] = copy.params;
  const prefix = `${requireName}.r(${exportsName}),`;
  if (!copy.moduleSource.startsWith(prefix)) throw new Error("Usage-limit send attempt: changed namespace publication");
  // The native namespace call precedes the export call in a comma expression.
  // Project only that exact prefix to a same-length statement for the strict
  // read-only publication helper. Production bytes remain untouched.
  const projected = { ...copy, moduleSource: prefix.slice(0, -1) + ";" + copy.moduleSource.slice(prefix.length) };
  const publication = findRspackExportPublication(projected, "CodexComposerAdapter");
  if (!publication?.expression || !new RegExp(`^${ID}$`, "u").test(publication.expression)) {
    throw new Error("Usage-limit send attempt: missing composer publication");
  }
  const wrapper = namedFunction(copy.moduleSource, publication.expression);
  const child = one(codeMatches(wrapper.body, new RegExp(
    `children:\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{\\.\\.\\.${escapeRegExp(wrapper.parameter)}\\}\\)`, "gu")),
  "missing native adapter child");
  const escapedChild = escapeRegExp(child[0]);
  const wrapperReturn = new RegExp(
    `return (${ID})\\[0\\]!==${escapeRegExp(wrapper.parameter)}\\?\\((${ID})=\\(0,${escapeRegExp(child[1])}\\.jsx\\)\\(${ID}\\.DH,\\{value:${ID}\\.${ID},${escapedChild}\\}\\),` +
    `\\1\\[0\\]=${escapeRegExp(wrapper.parameter)},\\1\\[1\\]=\\2\\):\\2=\\1\\[1\\],` +
    `\\1\\[2\\]!==(${ID})\\|\\|\\1\\[3\\]!==\\2\\?\\((${ID})=\\(0,${escapeRegExp(child[1])}\\.jsx\\)\\(${ID}\\.r,\\{value:\\3,children:\\2\\}\\),` +
    `\\1\\[2\\]=\\3,\\1\\[3\\]=\\2,\\1\\[4\\]=\\4\\):\\4=\\1\\[4\\],\\4$`, "u");
  if (!wrapperReturn.test(wrapper.body)) throw new Error("Usage-limit send attempt: adapter child is not returned");
  return namedFunction(copy.moduleSource, child[2]);
}

function returnedReasonChain(body, gate) {
  const flag = escapeRegExp(gate.flag);
  const reason = one(codeMatches(body, new RegExp(`(?<![\\w$.])(${ID})=${flag}&&"usage-limit";`, "gu"), true),
    "missing native usage-limit reason");
  const list = one(codeMatches(body, new RegExp(`(?<![\\w$.])(${ID})=\\[(${ID}(?:,${ID}){10})\\]\\.filter\\(Boolean\\)`, "gu")),
    "missing native eleven-blocker list");
  const blockers = list[2].split(",");
  if (new Set(blockers).size !== 11 || blockers.at(-1) !== reason[1] || reason.index <= gate.index || list.index <= reason.index) {
    throw new Error("Usage-limit send attempt: disconnected usage-limit blocker");
  }
  const joined = one(codeMatches(body, new RegExp(`\\blet (${ID})=${escapeRegExp(list[1])}\\.join\\(","\\);`, "gu"), true),
    "missing joined disabled reasons");
  const returned = one(codeMatches(body, /\breturn\b/gu, true), "changed component return");
  if (joined.index <= list.index || returned.index <= joined.index) throw new Error("Usage-limit send attempt: disconnected disabled reasons");
  const render = one(codeMatches(body, new RegExp(`(?<![\\w$.])(${ID})=\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{`, "gu"))
    .filter(match => {
      const open = match.index + match[0].length - 1;
      const end = createJavaScriptLexicalIndex(body).matchingBrace(open);
      return codeMatches(body.slice(open + 1, end), new RegExp(`(?:^|,)submitDisabledReasons:${escapeRegExp(joined[1])}(?=,|$)`, "gu"), true).length === 1;
    }), "missing native disabled-reason JSX consumer");
  const open = render.index + render[0].length - 1;
  const close = createJavaScriptLexicalIndex(body).matchingBrace(open);
  const cache = one(codeMatches(body, new RegExp(`(${ID})=\\(0,${ID}\\.c\\)\\(265\\)`, "gu"), true),
    "missing native composer memo")[1];
  const escapedCache = escapeRegExp(cache), child = escapeRegExp(render[1]), jsx = escapeRegExp(render[2]);
  const branch = body.slice(returned.index, render.index);
  if (!new RegExp(`^return ${escapedCache}\\[177\\]!==${escapeRegExp(render[3])}`).test(branch) ||
      !branch.includes(`${cache}[236]!==${joined[1]}`) || !branch.endsWith("?(")) {
    throw new Error("Usage-limit send attempt: reason JSX is outside the return branch");
  }
  const tail = body.slice(close + 2);
  const controller = one(codeMatches(tail, new RegExp(
    `${escapedCache}\\[242\\]=${child}\\):${child}=${escapedCache}\\[242\\],[^?]+\\?\\((${ID})=\\(0,${jsx}\\.jsxs\\)\\((${ID}),\\{composerController:(${ID}),`, "gu")),
  "missing returned composer controller");
  // The controller head ends after its first property. Locate its actual
  // object, then require the disabled-reason consumer as its literal child.
  const objectOpen = tail.indexOf("{composerController:", controller.index);
  const objectClose = createJavaScriptLexicalIndex(tail).matchingBrace(objectOpen);
  const controllerProps = tail.slice(objectOpen + 1, objectClose);
  if (!new RegExp(`children:\\[${ID},${ID},${ID},${ID},${ID},${child}\\]$`, "u").test(controllerProps)) {
    throw new Error("Usage-limit send attempt: discarded reason JSX");
  }
  const container = escapeRegExp(controller[1]);
  const final = one(codeMatches(tail.slice(objectClose + 1), new RegExp(
    `${escapedCache}\\[258\\]=${container}\\):${container}=${escapedCache}\\[258\\],[^?]+\\?\\((${ID})=\\(0,${jsx}\\.jsxs\\)\\("div",\\{`, "gu")),
  "missing returned composer root");
  const finalStart = objectClose + 1 + final.index;
  const finalOpen = finalStart + final[0].length - 1;
  const finalClose = createJavaScriptLexicalIndex(tail).matchingBrace(finalOpen);
  const rootProps = tail.slice(finalOpen + 1, finalClose);
  if (!rootProps.includes('"data-codex-composer-root":""') ||
      !new RegExp(`children:\\[${ID},${ID},${container}\\]$`, "u").test(rootProps) ||
      !new RegExp(`,${escapedCache}\\[264\\]=${escapeRegExp(final[1])}\\):${escapeRegExp(final[1])}=${escapedCache}\\[264\\],${escapeRegExp(final[1])}$`, "u").test(tail.slice(finalClose + 2))) {
    throw new Error("Usage-limit send attempt: discarded composer root");
  }
  return { reason: reason[1], blockers, list: list[1], joined: joined[1], consumer: render[1], controller: controller[1], root: final[1] };
}

function inspectUsageLimitSendAttempt(copy) {
  if (!copy || typeof copy.source !== "string" || typeof copy.moduleSource !== "string" ||
      copy.source.slice(copy.start, copy.end) !== copy.moduleSource || !Array.isArray(copy.params) || copy.params.length !== 3 ||
      !copy.params.every(name => new RegExp(`^${ID}$`, "u").test(name)) || new Set(copy.params).size !== 3) {
    throw new Error("Usage-limit send attempt: invalid Rspack snapshot");
  }
  const registry = one(codeMatches(copy.source, /\bexport\s+const\s+__webpack_modules__\s*=\s*\{/gu, true),
    "missing executable Rspack registry");
  if (copy.start <= registry.index || !createJavaScriptLexicalIndex(copy.source).isCode(copy.start)) {
    throw new Error("Usage-limit send attempt: opaque composer factory");
  }
  const actual = one([...rspackModuleFactories(copy.source, copy.assetName)].filter(module =>
    module.start === copy.start && module.end === copy.end && module.moduleId === copy.moduleId &&
    module.params.join(",") === copy.params.join(",")), "snapshot does not identify a complete factory");
  if (actual.moduleSource !== copy.moduleSource) throw new Error("Usage-limit send attempt: changed factory snapshot");
  const component = composerComponent(copy);
  const native = codeMatches(component.body, new RegExp(
    `(?<![\\w$.])(?<flag>${ID})=\\(0,${ID}\\.${ID}\\)\\("local"===${ID}&&${ID}\\.${ID}\\)`, "gu"), true);
  const applied = codeMatches(component.body, new RegExp(
    `(?<![\\w$.])(?<flag>${ID})=!1/\\*${MARKER}\\*/`, "gu"), true);
  const match = one([...native, ...applied], "missing or ambiguous local usage gate");
  const state = native.length === 1 ? "native" : "applied";
  if (copy.source.split(MARKER).length - 1 !== (state === "applied" ? 1 : 0)) {
    throw new Error("Usage-limit send attempt: orphan usage marker");
  }
  const gate = { flag: match.groups.flag, index: match.index, source: match[0] };
  const chain = returnedReasonChain(component.body, gate);
  const digest = createHash("sha256").update(copy.moduleSource).digest("hex");
  if (FACTORIES.get(digest) !== state) throw new Error("Usage-limit send attempt: current composer factory ABI changed");
  const start = copy.start + component.start + match.index;
  const patchedSource = state === "applied" ? copy.source : copy.source.slice(0, start) +
    `${gate.flag}=!1/*${MARKER}*/` + copy.source.slice(start + match[0].length);
  return { state, patchedSource, gate, chain, component: component.name, factorySha256: digest };
}

function isCandidate(source) {
  return source.includes(OWNER) || source.includes(MARKER);
}

function applyUsageLimitSendAttemptPatch(source) {
  try {
    const copy = one([...rspackModuleFactories(source, "usage-limit-composer.js")].filter(module => isCandidate(module.moduleSource)),
      "missing or ambiguous composer factory");
    return inspectUsageLimitSendAttempt(copy).patchedSource;
  } catch { return source; }
}

function applyUsageLimitSendAttemptAppPatch(extractedDir, options = {}) {
  const assets = path.join(extractedDir, "webview", "assets");
  let copies, prepared;
  try {
    const markerAssets = new Set();
    copies = findUniqueRspackModuleCopies(assets, { sourceMatch: (source, name) => {
      if (source.includes(MARKER)) markerAssets.add(name);
      return isCandidate(source);
    }, matchModule: isCandidate,
      description: "local Codex usage-limit composer" });
    prepared = copies.map(copy => ({ ...copy, ...inspectUsageLimitSendAttempt(copy) }));
    if (new Set(prepared.map(result => result.state)).size !== 1) {
      throw new Error("Usage-limit send attempt: mixed native and applied composer cohort");
    }
    if ([...markerAssets].some(name => !prepared.some(copy => copy.assetName === name))) {
      throw new Error("Usage-limit send attempt: orphan usage marker asset");
    }
  } catch (error) { return { matched: 0, changed: 0, reason: error.message }; }
  const result = patchWebviewAssets(assets, prepared, options);
  return { ...result, matched: copies.length, targets: copies.map(copy => `webview/assets/${copy.assetName}`) };
}

const descriptors = [{
  id: "usage-limit-send-attempt-ui",
  phase: "extracted-app:post-webview",
  order: 20560,
  ciPolicy: "optional",
  apply: applyUsageLimitSendAttemptAppPatch,
  status: result => result.changed > 0 ? "applied" : result.matched > 0 ? "already-applied" :
    { status: "skipped-optional", reason: result.reason },
}];

module.exports = { inspectUsageLimitSendAttempt, applyUsageLimitSendAttemptPatch, applyUsageLimitSendAttemptAppPatch, descriptors };
