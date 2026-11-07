"use strict";

const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, escapeRegExp } = require("./minified-js.js");
const { findRspackExportPublication } = require("./rspack-export-publication.js");
const { findRspackRequireBinding } = require("./rspack-module-assets.js");

const ID = "[A-Za-z_$][\\w$]*";
const RX = (text) => new RegExp(text, "gu");
const escaped = escapeRegExp;
function unsupported(reason) { return { ok: false, reason }; }
function reject(reason) { throw new Error(reason); }
function one(values, reason) { if (values.length !== 1) reject(reason); return values[0]; }
function range(start, end) { return { start, end }; }
function hitRange(match, offset = 0) { return range(offset + match.index, offset + match.index + match[0].length); }
function frame(text, offset = 0) { return { text, offset, lexical: createJavaScriptLexicalIndex(text) }; }
function matches(owner, expression, root = false) {
  return [...owner.text.matchAll(expression)].filter(match => owner.lexical.isCode(match.index) &&
    (!root || owner.lexical.isRoot(match.index)));
}
function sole(owner, expression, reason, root = false) { return one(matches(owner, expression, root), reason); }
function scoped(owner, start, end) { return frame(owner.text.slice(start, end), owner.offset + start); }
function span(owner, match) { return hitRange(match, owner.offset); }
function functions(owner) {
  return matches(owner, RX(`\\bfunction(?: (?<name>${ID}))?\\((?<params>[^)]*)\\)\\{`)).map(head => {
    const open = head.index + head[0].length - 1, end = owner.lexical.matchingBrace(open);
    if (end < open) reject("incomplete native function");
    return { name: head.groups.name ?? null, params: head.groups.params,
      start: owner.offset + head.index, end: owner.offset + end + 1,
      body: scoped(owner, open + 1, end) };
  });
}
function blocks(owner) {
  return matches(owner, RX(`(?<name>${ID})=(?:async)?\\((?<params>${ID}(?:,${ID})*)\\)=>\\{`)).map(head => {
    const open = head.index + head[0].length - 1, end = owner.lexical.matchingBrace(open);
    if (end < open) reject("incomplete native setter");
    return { name: head.groups.name, params: head.groups.params.split(","),
      start: owner.offset + head.index, end: owner.offset + end + 1, body: scoped(owner, open + 1, end) };
  });
}
function publicFunction(module, owner, fn) {
  if (fn.name != null && (!owner.lexical.isRoot(fn.start - owner.offset) || functions(owner)
    .filter(candidate => candidate.name === fn.name && owner.lexical.isRoot(candidate.start - owner.offset)).length !== 1)) {
    reject("named publication does not identify a unique factory-root function");
  }
  const candidates = matches(owner, RX(`(?<key>${ID}):(?:\\(\\)=>${ID}|function(?: ${ID})?\\()`));
  const found = [];
  for (const key of new Set(candidates.map(candidate => candidate.groups.key))) {
    const publication = findRspackExportPublication(module, key);
    if (publication == null) continue;
    if (publication.fn?.start === fn.start && publication.fn.end === fn.end ||
        fn.name != null && publication.expression === fn.name) {
      found.push({ exportName: key, expression: publication.expression,
        requireName: publication.requireName, exportsName: publication.exportsName });
    }
  }
  return one(found, "native owner has no unique factory publication");
}
function factoryFrame(module) {
  if (typeof module?.moduleSource !== "string" || !Array.isArray(module.params) || module.params.length !== 3 ||
      !module.params.every(name => new RegExp(`^${ID}$`, "u").test(name)) || new Set(module.params).size !== 3) {
    reject("expected a current three-parameter Rspack factory snapshot");
  }
  return frame(module.moduleSource);
}
function imported(module, owner, name) {
  const binding = findRspackRequireBinding(module, name);
  if (binding == null) reject(`native role has no unique factory require binding: ${name}`);
  const assignments = writes(owner, name, true);
  if (assignments.length !== 1) reject(`native role factory binding is reassigned: ${name}`);
  return { localName: name, moduleId: binding.moduleId };
}
function alias(owner, exposed, reason) {
  return sole(owner, RX(`\\blet ${escaped(exposed)}=(?<value>${ID});`), reason, true).groups.value;
}
function functionRange(fn) { return { start: fn.start, end: fn.end, body: range(fn.body.offset, fn.body.offset + fn.body.text.length) }; }
function parsesScope(body, parameters = "", suffix = "") {
  try { new Script(`async function nativeOwnerScope(${parameters}){${body}\n${suffix}}`); return true; }
  catch { return false; }
}
function declares(body, parameters, name) {
  return parsesScope(body, parameters) && !parsesScope(body, parameters, `let ${name};`);
}
function writes(owner, name, root = false) {
  const direct = matches(owner, RX(`(?<![\\w$.])${escaped(name)}\\s*(?:\\+\\+|--|(?:\\?\\?|\\|\\||&&|[+*/%&|^\\-])?=(?!=|>))`), root);
  const destructured = matches(owner, /[\[{]([^\[\]{}]*)[\]}]\s*=(?!=|>)/gu, root).filter(match => {
    const before = owner.text.slice(0, match.index).trimEnd();
    if (/\b(?:var|let|const)$/u.test(before)) return false;
    return sourceReferences(match[1], name).length > 0;
  });
  return [...direct, ...destructured];
}
function distinctParameters(parameters, captured) {
  if (new Set(parameters).size !== parameters.length || parameters.some(name => captured.includes(name))) {
    reject("native callback parameters shadow a captured role");
  }
}
function stable(owner, name, expected) {
  if (writes(owner, name).length !== expected) reject(`native role binding is reassigned: ${name}`);
}
// Check only scopes between the recorded declaration and the selected use.
// Syntax probes detect declarations without evaluating upstream code. This is
// deliberately not a policy or general JavaScript name resolver.
function noShadow(owner, name, site, declarationBody = null) {
  const parameters = new Map(functions(owner).map(fn => [fn.body.offset - 1, fn.params]));
  for (const fn of blocks(owner)) parameters.set(fn.body.offset - 1, fn.params.join(","));
  for (const head of matches(owner, RX(`(?:(?<single>${ID})|\\((?<multiple>[^()]*)\\))=>\\{`))) {
    parameters.set(owner.offset + head.index + head[0].length - 1, head.groups.single ?? head.groups.multiple);
  }
  for (const head of matches(owner, RX(`\\bcatch\\((?<name>${ID})\\)\\{`))) {
    parameters.set(owner.offset + head.index + head[0].length - 1, head.groups.name);
  }
  for (const open of matches(owner, /\{/gu)) {
    const at = owner.offset + open.index;
    if (declarationBody != null && at < declarationBody.offset) continue;
    const end = owner.lexical.matchingBrace(open.index);
    if (at >= site || owner.offset + end < site) continue;
    const body = owner.text.slice(open.index + 1, end), params = parameters.get(at) ?? "";
    if (declares(body, params, name)) reject(`native role is shadowed at its use: ${name}`);
  }
}
function sourceReferences(expression, name) {
  const owner = frame(expression);
  return matches(owner, RX(`(?<![\\w$])${escaped(name)}(?![\\w$])`)).filter(match =>
    (owner.text[match.index - 1] !== "." || owner.text.slice(match.index - 3, match.index) === "...") &&
    !/^\s*:/u.test(owner.text.slice(match.index + match[0].length)));
}

// Pure inspection only. Every returned range is half-open and addresses the
// supplied moduleSource, just like findRspackExportPublication's function
// records. Add factory.start only when translating an edit into its asset.
// Feature policy and applied-state validation remain with each feature.
function inspectModelCatalogOwner(module) {
  try {
    const owner = factoryFrame(module);
    const inputs = RX(`^\\{additionalAvailableModels:(?<additional>${ID}),apiKeyDaybreakSupported:(?<daybreak>${ID})=!1,` +
      `authMethod:(?<auth>${ID}),availableModels:(?<available>${ID}),defaultModel:(?<defaultModel>${ID}),` +
      `enabledReasoningEfforts:(?<enabled>${ID}),hasConfiguredModelCatalog:(?<configured>${ID}),` +
      `includeUltraReasoningEffort:(?<ultra>${ID}),isCustomModelProvider:(?<custom>${ID})=!1,` +
      `models:(?<models>${ID}),useHiddenModels:(?<hidden>${ID})\\}$`);
    const candidates = functions(owner).map(fn => ({ fn, header: new RegExp(inputs.source, "u").exec(fn.params) })).filter(value => value.header);
    const { fn, header } = one(candidates, "missing or ambiguous current model catalog owner");
    const names = header.groups;
    if (new Set(Object.values(names)).size !== Object.keys(names).length) reject("model catalog inputs alias each other");
    const publication = publicFunction(module, owner, fn), body = fn.body;
    const nativeReturn = sole(body, /\breturn\b/gu, "model catalog has no unique native return", true);
    const loop = sole(body, RX(`${escaped(names.models)}\\.forEach\\((?<model>${ID})=>\\{if\\(`),
      "missing or ambiguous native catalog loop", true);
    if (body.text.slice(nativeReturn.index + nativeReturn[0].length, loop.index).trim() !== "") reject("catalog loop is not the native returned expression");
    const model = loop.groups.model, loopOpen = loop.index + loop[0].indexOf("=>{") + 2;
    const loopEnd = body.lexical.matchingBrace(loopOpen);
    if (loopEnd < loopOpen) reject("incomplete native catalog loop");
    const loopBody = scoped(body, loopOpen + 1, loopEnd);
    const predicate = one(functions(loopBody).filter(candidate => candidate.params.startsWith("{additionalAvailableModels:")),
      "missing or ambiguous catalog visibility predicate");
    const visibilityHeader = RX(`^\\{additionalAvailableModels:(?<additional>${ID}),apiKeyDaybreakSupported:(?<daybreak>${ID}),` +
      `authMethod:(?<auth>${ID}),availableModels:(?<available>${ID}),hasConfiguredModelCatalog:(?<configured>${ID}),` +
      `isCustomModelProvider:(?<custom>${ID}),model:(?<model>${ID}),useHiddenModels:(?<hidden>${ID})\\}$`).exec(predicate.params);
    if (!visibilityHeader || new Set(Object.values(visibilityHeader.groups)).size !== 8) reject("unsupported visibility inputs");
    const callText = `({additionalAvailableModels:${names.additional},apiKeyDaybreakSupported:${names.daybreak},` +
      `authMethod:${names.auth},availableModels:${names.available},hasConfiguredModelCatalog:${names.configured},` +
      `isCustomModelProvider:${names.custom},model:${model},useHiddenModels:${names.hidden}})`;
    if (!owner.text.startsWith(callText, predicate.end)) reject("visibility inputs do not come from the catalog owner");
    const output = sole(loopBody, RX(`(?<output>${ID})=\\{\\.\\.\\.${escaped(model)},supportedReasoningEfforts:(?<efforts>${ID})` +
      `(?:,[^{};]*)?\\};(?<models>${ID})\\.push\\(\\k<output>\\),${escaped(model)}\\.isDefault&&\\((?<defaultModel>${ID})=\\k<output>\\)`),
      "missing or ambiguous normalized model output");
    const out = output.groups;
    const sourceEfforts = sole(loopBody, RX(`(?<source>${ID})=${escaped(names.ultra)}\\?${escaped(model)}\\.supportedReasoningEfforts:` +
      `${escaped(model)}\\.supportedReasoningEfforts\\.filter\\(\\(\\{reasoningEffort:(?<effort>${ID})\\}\\)=>"ultra"!==\\k<effort>\\)`),
      "model efforts do not come from the current loop model");
    const filter = sole(loopBody, RX(`${escaped(out.efforts)}=(?<expression>[^;]{1,800}?)\\.filter\\(` +
      `\\(\\{reasoningEffort:(?<effort>${ID})\\}\\)=>\\(0,(?<namespace>${ID})\\.(?<exportName>${ID})\\)\\(\\k<effort>\\)&&` +
      `${escaped(names.enabled)}\\.has\\(\\k<effort>\\)\\)`), "missing or ambiguous native enabled-effort filter");
    const sourceName = sourceEfforts.groups.source;
    if (sourceReferences(filter.groups.expression, sourceName).length === 0 ||
        !loopBody.lexical.isCode(filter.index + filter[0].lastIndexOf(".filter("))) {
      reject("filtered efforts do not refer to the model effort source");
    }
    const expression = filter.groups.expression.replace(/^(?:\/\*[\s\S]*?\*\/)+/u, "");
    // These are the native branch and the feature's array-copy insertion. The
    // feature still owns which branch is allowed/applied and all effort policy.
    const nativeBranch = new RegExp(`^\\("copilot"===${escaped(names.auth)}\\?\\[${escaped(sourceName)}\\.find\\((${ID})=>"medium"===\\1\\.reasoningEffort\\)\\?\\?\\{reasoningEffort:"medium",description:"medium effort"\\}\\]:${escaped(sourceName)}\\)$`, "u");
    if (!nativeBranch.test(expression) && expression !== `[...${sourceName}]`) reject("unsupported model effort source expression");
    distinctParameters([filter.groups.effort], [filter.groups.namespace, names.enabled]);
    noShadow(owner, filter.groups.namespace, loopBody.offset + filter.index);
    stable(body, names.auth, 0);
    const result = sole(body, RX(`\\{models:${escaped(out.models)},defaultModel:${escaped(out.defaultModel)},` +
      `hasModelSupportingMaxReasoningEffort:(?<max>${ID}),hasModelSupportingUltraReasoningEffort:(?<ultra>${ID})\\}`),
      "normalized model output does not reach the catalog result", true);
    const beforeResult = body.text.slice(0, result.index).trimEnd();
    if (result.index + result[0].length !== body.text.length || !/(?:,|\breturn)$/.test(beforeResult)) {
      reject("normalized model object is not the final returned catalog value");
    }
    return { ok: true, kind: "model-catalog", moduleId: module.moduleId ?? null, publication,
      owner: functionRange(fn), inputs: { ...names }, loop: { model, range: span(body, loop) },
      visibility: { owner: functionRange(predicate), inputs: { ...visibilityHeader.groups },
        call: range(predicate.end, predicate.end + callText.length) },
      normalization: { model, sourceEfforts: sourceName, filteredEfforts: out.efforts, output: out.output,
        outputRange: span(loopBody, output), sourceRange: span(loopBody, sourceEfforts),
        enabledFilter: span(loopBody, filter), effortPredicate: {
          ...imported(module, owner, filter.groups.namespace), exportName: filter.groups.exportName } },
      result: { models: out.models, defaultModel: out.defaultModel, range: span(body, result) } };
  } catch (error) { return unsupported(error.message); }
}

function inspectModelSettingsOwner(module) {
  try {
    const owner = factoryFrame(module), allFunctions = functions(owner);
    const returned = sole(owner, RX(`\\{defaultAdvancedModel:(?<settings>${ID})\\.model,hasManagedNewThreadSettings:${ID},` +
      `hostId:(?<host>${ID}),isLunaReserveActive:${ID},usesAccountPreferences:${ID},originalAdvancedModelSettings:${ID},` +
      `setDefaultModelAndReasoningEffort:(?<defaultSetter>${ID}),setModelAndReasoningEffortForNextTurn:(?<nextSetter>${ID}),` +
      `setModelAndReasoningEffort:(?<currentSetter>${ID}),modelSettings:(?<modelSettings>${ID})\\}`),
      "missing or ambiguous current model settings result");
    const resultAt = returned.index, fields = returned.groups;
    const containers = allFunctions.filter(fn => fn.start < resultAt && resultAt < fn.end);
    const state = one(containers.filter(fn => !containers.some(other => other.start > fn.start && other.end < fn.end)),
      "model settings result has no unique function owner");
    const wrapper = one(containers.filter(fn => fn !== state && fn.name != null && owner.lexical.isRoot(fn.start) &&
      matches(owner, RX(`(?<key>${ID}):\\(\\)=>${escaped(fn.name)}(?=[,}])`)).some(candidate =>
        findRspackExportPublication(module, candidate.groups.key)?.expression === fn.name)),
      "model settings state has no unique exported hook");
    const publication = publicFunction(module, owner, wrapper), body = state.body;
    if (writes(owner, wrapper.name, true).length !== 0 || writes(wrapper.body, wrapper.name, true).length !== 0) reject("published settings hook is reassigned");
    const finalReturn = matches(body, /\breturn\b/gu, true).at(-1);
    if (finalReturn == null || body.offset + finalReturn.index > returned.index) reject("settings object does not reach the native return");
    const resultPrefix = owner.text.slice(body.offset + finalReturn.index + finalReturn[0].length, returned.index);
    const resultSuffix = owner.text.slice(returned.index + returned[0].length, body.offset + body.text.length);
    const resultBinding = new RegExp(`(?<name>${ID})=$`, "u").exec(resultPrefix);
    if (resultBinding == null ? resultPrefix.trim() !== "" || resultSuffix.trim() !== "" :
        !new RegExp(`,${escaped(resultBinding.groups.name)}$`, "u").test(resultSuffix)) {
      reject("settings object does not reach the native return");
    }
    const parameters = state.params.split(",");
    if (parameters.length !== 5 || !parameters.every(value => new RegExp(`^${ID}$`, "u").test(value))) reject("unsupported settings state parameters");
    const conversation = parameters[0];
    const context = sole(body, RX(`(?<context>${ID})=\\(0,(?<namespace>${ID})\\.(?<exportName>${ID})\\)\\(${escaped(conversation)}\\),` +
      `(?<host>${ID})=\\k<context>\\.hostId;`), "missing or ambiguous conversation host context", true);
    const active = context.groups;
    if (active.host !== fields.host) reject("settings result uses another host");
    const cwd = sole(body, RX(`(?<cwd>${ID})=${escaped(active.context)}\\.cwd(?=[,;])`), "settings cwd has another context", true).groups.cwd;
    const identity = sole(body, RX(`(?<host>${ID})=\\(0,(?<namespace>${ID})\\.(?<exportName>${ID})\\)\\(${escaped(active.host)}\\),` +
      `(?<auth>${ID})=\\k<host>\\?\\.authMethod\\?\\?null`), "settings identity uses another host", true);
    const chatgpt = sole(body, RX(`(?<chatgpt>${ID})=${escaped(identity.groups.host)}\\?\\.authMethod==="chatgpt"`),
      "settings ChatGPT identity has another owner", true).groups.chatgpt;
    const writeContext = sole(body, RX(`(?<context>${ID})=(?<resolver>${ID})\\(${escaped(active.host)},${escaped(cwd)},(?<managed>${ID})\\)`),
      "missing or ambiguous default write context", true);
    const write = sole(body, RX(`\\{hostId:(?<host>${ID}),cwd:(?<cwd>${ID})\\}=${escaped(writeContext.groups.context)}(?=[,;])`),
      "default write host and cwd have another context", true).groups;
    const routing = one(allFunctions.filter(fn => fn.name === writeContext.groups.resolver && owner.lexical.isRoot(fn.start)), "default host resolver is not factory owned");
    const route = sole(routing.body, RX(`^return (?<host>${ID})!==(?<namespace>${ID})\\.(?<exportName>${ID})\\|\\|(?<managed>${ID})\\?` +
      `\\{hostId:\\k<host>,cwd:(?<cwd>${ID})\\}:\\{hostId:"local",cwd:null\\}$`), "unsupported current default host routing");
    if (routing.params !== `${route.groups.host},${route.groups.cwd},${route.groups.managed}`) reject("default host routing parameters are mismatched");
    const readOptions = sole(body, RX(`(?<options>${ID})=\\{hostId:${escaped(active.host)},cwd:${escaped(cwd)},isChatGptAuth:${escaped(chatgpt)},` +
      `isHostRegistered:${ID},managedNewThreadModelSettings:${ID},draftModelSettings:${ID},fetchModelCatalog:${ID},` +
      `isNewThreadDraft:${ID},waitForModelFallback:${ID}\\}`), "settings read context is mismatched", true);
    const read = sole(body, RX(`\\{modelSettings:${escaped(fields.settings)}\\}=(?<reader>${ID})\\(${escaped(readOptions.groups.options)}\\)`),
      "default profile is not from the active settings read", true);
    const reader = one(allFunctions.filter(fn => fn.name === read.groups.reader && owner.lexical.isRoot(fn.start)), "settings reader is not factory owned");
    const defaultWrapper = sole(body, RX(`(?<wrapper>${ID})=\\((?<model>${ID}),(?<effort>${ID})\\)=>\\(0,(?<namespace>${ID})\\.(?<exportName>${ID})\\)` +
      `\\((?<store>${ID}),\\["default",${escaped(active.host)},${escaped(cwd)}\\],` +
      `\\{model:\\k<model>,reasoningEffort:\\k<effort>\\},\\(\\)=>(?<writer>${ID})\\(\\k<model>,\\k<effort>,"default"\\)\\)`),
      "missing or ambiguous native default setter", true);
    const defaultNames = defaultWrapper.groups;
    if (alias(body, fields.defaultSetter, "default setter alias is mismatched") !== defaultNames.wrapper) reject("default setter result is disconnected");
    const writerName = alias(body, defaultNames.writer, "shared settings writer alias is mismatched");
    stable(body, defaultNames.writer, 1);
    const arrowBlocks = blocks(body).filter(fn => body.lexical.isRoot(fn.start - body.offset));
    const writer = one(arrowBlocks.filter(fn => fn.name === writerName), "shared settings writer has no unique owner");
    if (writer.params.length !== 4) reject("unsupported shared writer parameters");
    const [model, effort] = writer.params;
    const service = sole(writer.body, RX(`\\(0,(?<namespace>${ID})\\.(?<exportName>${ID})\\)\\(${escaped(defaultNames.store)},${escaped(write.host)}\\)` +
      `\\.setDefaultModelConfig\\(${escaped(model)},${escaped(effort)},${escaped(fields.settings)}\\.profile\\)`),
      "default write loses host, model, effort, or profile");
    const serviceCall = (host) => `\\(0,${escaped(service.groups.namespace)}\\.${escaped(service.groups.exportName)}\\)` +
      `\\(${escaped(defaultNames.store)},${escaped(host)}\\)`;
    const prewarm = sole(writer.body, RX(`await ${serviceCall(write.host)}\\.clearPrewarmedThreads\\(\\),` +
      `${escaped(write.host)}!==${escaped(active.host)}&&await ${serviceCall(active.host)}\\.clearPrewarmedThreads\\(\\)`),
      "default write does not preserve both native prewarm hosts");
    const query = sole(writer.body, RX(`(?<query>${ID})=\\[\\.\\.\\.(?<namespace>${ID})\\.(?<exportName>${ID}),` +
      `${escaped(write.host)},${escaped(write.cwd)}\\]`), "default query uses another host or cwd");
    const targetText = `\\(0,${escaped(defaultNames.namespace)}\\.(?<targetExport>${ID})\\)` +
      `\\(\\{conversationId:${escaped(conversation)},hasConversation:(?<hasConversation>${ID}),` +
      `hostId:${escaped(active.host)},cwd:${escaped(cwd)}\\}\\)`;
    const currentName = alias(body, fields.currentSetter, "current setter alias is mismatched");
    const current = one(arrowBlocks.filter(fn => fn.name === currentName), "current setter has no unique owner");
    if (current.params.length !== 3) reject("unsupported current setter parameters");
    const currentTarget = sole(current.body, RX(`(?<target>${ID})=${targetText}`), "current setter target is mismatched", true);
    const currentCall = sole(current.body, RX(`return\\(0,${escaped(defaultNames.namespace)}\\.${escaped(defaultNames.exportName)}\\)` +
      `\\(${escaped(defaultNames.store)},${escaped(currentTarget.groups.target)},` +
      `\\{model:${escaped(current.params[0])},reasoningEffort:${escaped(current.params[1])},serviceTier:(?<tier>${ID})\\},` +
      `\\(\\)=>${escaped(defaultNames.writer)}\\(${escaped(current.params[0])},${escaped(current.params[1])},"current",\\k<tier>\\)\\)`),
      "current setter does not use the shared writer", true);
    const nextName = alias(body, fields.nextSetter, "next-turn setter alias is mismatched");
    const next = one(arrowBlocks.filter(fn => fn.name === nextName), "next-turn setter has no unique owner");
    if (next.params.length !== 3) reject("unsupported next-turn setter parameters");
    const nextTarget = sole(next.body, RX(`(?<target>${ID})=${targetText}`), "next-turn setter target is mismatched", true);
    if (nextTarget.groups.targetExport !== currentTarget.groups.targetExport ||
        nextTarget.groups.hasConversation !== currentTarget.groups.hasConversation) reject("current and next-turn targets are disconnected");
    const pending = sole(next.body, RX(`(?<selection>${ID})=\\{model:${escaped(next.params[0])},reasoningEffort:${escaped(next.params[1])},` +
      `serviceTier:${escaped(next.params[2])}\\?\\.threadSettings\\.serviceTier(?:,[^{};]*)?\\}`), "next-turn selection is disconnected", true);
    const pendingWrite = sole(next.body, RX(`${escaped(defaultNames.store)}\\.set\\(${escaped(defaultNames.namespace)}\\.(?<atom>${ID}),` +
      `${escaped(nextTarget.groups.target)},${escaped(pending.groups.selection)}\\)`), "next-turn optimistic write is disconnected", true);
    const cleanup = sole(next.body, RX(`${escaped(defaultNames.store)}\\.get\\(${escaped(defaultNames.namespace)}\\.${escaped(pendingWrite.groups.atom)},` +
      `${escaped(nextTarget.groups.target)}\\)===${escaped(pending.groups.selection)}&&${escaped(defaultNames.store)}\\.set\\(` +
      `${escaped(defaultNames.namespace)}\\.${escaped(pendingWrite.groups.atom)},${escaped(nextTarget.groups.target)},null\\)`),
      "next-turn optimistic cleanup is disconnected");
    const nextInvoke = sole(next.body, RX(`await (?<rpc>${ID})\\(${next.params.map(escaped).join(",")}\\)`),
      "next-turn setter does not invoke its native RPC");
    const rpcName = alias(body, nextInvoke.groups.rpc, "next-turn RPC alias is mismatched");
    stable(body, nextInvoke.groups.rpc, 1);
    const rpc = sole(body, RX(`${escaped(rpcName)}=async\\((?<model>${ID}),(?<effort>${ID}),(?<options>${ID})\\)=>` +
      `null!=${escaped(conversation)}&&!!(?<ready>${ID})&&\\(await ${serviceCall(active.host)}\\.updateThreadSettingsForNextTurn\\(` +
      `${escaped(conversation)},\\{\\.\\.\\.\\k<options>\\?\\.threadSettings,model:\\k<model>,effort:\\k<effort>,` +
      `multiAgentMode:(?<modeNamespace>${ID})\\.(?<modeExport>${ID})\\}\\),!0\\)`),
      "next-turn RPC loses active host or conversation", true);
    // The returned effective settings are a separate native memo result. Bind
    // its reader-based selection and its target-scoped optimistic inputs;
    // merely finding any local variable with the returned name is insufficient.
    const effectiveMemo = alias(body, fields.modelSettings, "effective settings have no local result alias");
    const effective = sole(body, RX(`${escaped(effectiveMemo)}=null==(?<pending>${ID})\\|\\|null!=(?<draft>${ID})\\?(?<base>${ID}):` +
      `\\{\\.\\.\\.\\k<base>,\\.\\.\\.\\k<pending>,hasPendingThreadSelection:"conversation"===(?<target>${ID})\\[0\\]\\},` +
      `(?<cache>${ID})\\[(?<draftSlot>\\d+)\\]=\\k<draft>,\\k<cache>\\[(?<pendingSlot>\\d+)\\]=\\k<pending>,` +
      `\\k<cache>\\[(?<targetSlot>\\d+)\\]=\\k<target>,\\k<cache>\\[(?<baseSlot>\\d+)\\]=\\k<base>,` +
      `\\k<cache>\\[(?<resultSlot>\\d+)\\]=${escaped(effectiveMemo)}\\):${escaped(effectiveMemo)}=\\k<cache>\\[\\k<resultSlot>\\]`),
      "effective settings have no current native selection memo", true);
    const selected = effective.groups;
    const memoGuard = `${selected.cache}[${selected.draftSlot}]!==${selected.draft}||` +
      `${selected.cache}[${selected.pendingSlot}]!==${selected.pending}||${selected.cache}[${selected.targetSlot}]!==${selected.target}||` +
      `${selected.cache}[${selected.baseSlot}]!==${selected.base}?(`;
    if (body.text.slice(effective.index - memoGuard.length, effective.index) !== memoGuard) reject("effective settings memo has another cache guard");
    const baseAlias = sole(body, RX(`\\blet ${escaped(selected.base)}=(?<source>${ID}),${escaped(selected.pending)}=` +
      `(?<pending>${ID})\\?\\?(?<committed>${ID});`), "effective settings have no native base and optimistic aliases", true);
    const base = sole(body, RX(`${escaped(baseAlias.groups.source)}=${escaped(currentTarget.groups.hasConversation)}\\?` +
      `\\{model:(?<model>${ID})\\?\\?${escaped(fields.settings)}\\.model,reasoningEffort:null==\\k<model>\\?` +
      `${escaped(fields.settings)}\\.reasoningEffort:(?<effort>${ID}),profile:${escaped(fields.settings)}\\.profile,isLoading:[^{};]+\\}:` +
      `\\{\\.\\.\\.(?<fallback>${ID}),isLoading:\\k<fallback>\\.isLoading\\|\\|${ID}\\|\\|null!=${escaped(conversation)}\\}`),
      "effective base selection is disconnected from the settings reader", true);
    const baseCache = sole(body, RX(`(?<cache>${ID})\\[(?<slot>\\d+)\\]=${escaped(baseAlias.groups.source)}\\):` +
      `${escaped(baseAlias.groups.source)}=\\k<cache>\\[\\k<slot>\\];`), "effective base selection has another cache result", true);
    const fallback = sole(body, RX(`${escaped(base.groups.fallback)}=${ID}&&null==${ID}\\?${ID}:${escaped(fields.settings)}(?=[,;])`),
      "effective base fallback is disconnected from the settings reader", true);
    const scopedTarget = sole(body, RX(`(?<target>${ID})=${targetText}`), "effective settings have no active conversation target", true);
    const targetCaches = matches(body, RX(`(?<cache>${ID})\\[(?<slot>\\d+)\\]=${escaped(scopedTarget.groups.target)}\\):` +
      `${escaped(scopedTarget.groups.target)}=\\k<cache>\\[\\k<slot>\\]`), true);
    if (targetCaches.length > 1) reject("effective target has ambiguous cache sources");
    const targetCache = targetCaches[0] ?? null;
    stable(body, scopedTarget.groups.target, targetCache == null ? 1 : 2);
    const targetAlias = sole(body, RX(`\\blet ${escaped(selected.target)}=${escaped(scopedTarget.groups.target)},`),
      "effective settings use another optimistic target", true);
    if (targetCache != null && !(scopedTarget.index < targetCache.index && targetCache.index < targetAlias.index)) {
      reject("effective target cache is disconnected from its alias");
    }
    if (scopedTarget.groups.targetExport !== currentTarget.groups.targetExport ||
        scopedTarget.groups.hasConversation !== currentTarget.groups.hasConversation) reject("effective settings target differs from setter targets");
    const pendingRead = sole(body, RX(`${escaped(baseAlias.groups.pending)}=\\(0,(?<namespace>${ID})\\.(?<exportName>${ID})\\)` +
      `\\(${escaped(defaultNames.namespace)}\\.${escaped(pendingWrite.groups.atom)},${escaped(selected.target)}\\)`),
      "effective pending settings use another target or atom", true);
    const committedRead = sole(body, RX(`${escaped(baseAlias.groups.committed)}=\\(0,${escaped(pendingRead.groups.namespace)}\\.` +
      `${escaped(pendingRead.groups.exportName)}\\)\\(${escaped(defaultNames.namespace)}\\.(?<atom>${ID}),${escaped(selected.target)}\\)`),
      "effective committed settings use another target", true);
    if (committedRead.groups.atom === pendingWrite.groups.atom || !(base.index < baseCache.index && baseCache.index < baseAlias.index &&
        baseAlias.index < effective.index && targetAlias.index < pendingRead.index && pendingRead.index < baseAlias.index &&
        committedRead.index < baseAlias.index)) reject("effective settings sources are not in native dependency order");
    for (const [name, expected] of [[fields.modelSettings, 1], [effectiveMemo, 2], [selected.base, 1], [selected.pending, 1],
      [baseAlias.groups.source, 2], [baseAlias.groups.pending, 1], [baseAlias.groups.committed, 1], [selected.target, 1]]) {
      if (!declares(body.text, state.params, name)) reject(`effective settings role is not state-local: ${name}`);
      stable(body, name, expected);
    }
    if (!declares(body.text, state.params, scopedTarget.groups.target)) reject("effective target source is not state-local");
    noShadow(owner, fields.settings, base.index + body.offset, body);
    noShadow(owner, pendingRead.groups.namespace, pendingRead.index + body.offset);
    noShadow(owner, defaultNames.namespace, pendingRead.index + body.offset);
    noShadow(owner, selected.base, effective.index + body.offset, body);
    noShadow(owner, selected.pending, effective.index + body.offset, body);
    const effectiveSettings = { binding: fields.modelSettings, memo: effectiveMemo, reader: fields.settings,
      range: range(body.offset + effective.index - memoGuard.length, body.offset + effective.index + effective[0].length),
      base: { binding: selected.base, source: baseAlias.groups.source, selection: span(body, base), cache: span(body, baseCache),
        fallback: span(body, fallback), aliases: span(body, baseAlias) },
      optimistic: { target: selected.target, targetSource: span(body, scopedTarget), targetAlias: span(body, targetAlias),
        targetCache: targetCache == null ? null : span(body, targetCache),
        pending: baseAlias.groups.pending, committed: baseAlias.groups.committed,
        pendingRead: span(body, pendingRead), committedRead: span(body, committedRead),
        reader: { ...imported(module, owner, pendingRead.groups.namespace), exportName: pendingRead.groups.exportName } } };
    for (const [name, expected] of [[active.host, 1], [cwd, 1], [write.host, 0], [write.cwd, 0],
      [fields.settings, 0], [fields.defaultSetter, 1], [fields.currentSetter, 1], [fields.nextSetter, 1]]) stable(body, name, expected);
    distinctParameters(writer.params, [service.groups.namespace, fields.settings, active.host, write.host, write.cwd,
      defaultNames.store, query.groups.namespace]);
    distinctParameters(current.params, [defaultNames.namespace, defaultNames.writer, defaultNames.store, active.host,
      cwd, conversation, currentTarget.groups.hasConversation]);
    distinctParameters(next.params, [defaultNames.namespace, nextInvoke.groups.rpc, defaultNames.store, active.host,
      cwd, conversation, nextTarget.groups.hasConversation]);
    distinctParameters([rpc.groups.model, rpc.groups.effort, rpc.groups.options], [service.groups.namespace,
      defaultNames.store, active.host, conversation, rpc.groups.modeNamespace]);
    const roleUses = [
      [active.namespace, context.index + body.offset, null],
      [identity.groups.namespace, identity.index + body.offset, null],
      [defaultNames.namespace, currentCall.index + current.body.offset, null],
      [defaultNames.namespace, nextTarget.index + next.body.offset, null],
      [defaultNames.namespace, cleanup.index + next.body.offset, null],
      [service.groups.namespace, service.index + writer.body.offset, null],
      [query.groups.namespace, query.index + writer.body.offset, null],
      [rpc.groups.modeNamespace, rpc.index + body.offset, null],
      [fields.settings, service.index + writer.body.offset, body],
      [active.host, currentTarget.index + current.body.offset, body],
      [write.host, service.index + writer.body.offset, body],
      [write.cwd, query.index + writer.body.offset, body],
      [defaultNames.writer, currentCall.index + current.body.offset, body],
      [nextInvoke.groups.rpc, nextInvoke.index + next.body.offset, body],
    ];
    for (const [name, site, declaration] of roleUses) noShadow(owner, name, site, declaration);
    return { ok: true, kind: "model-settings", moduleId: module.moduleId ?? null, publication,
      owner: functionRange(wrapper), state: functionRange(state), conversation,
      active: { context: active.context, hostId: active.host, cwd,
        source: { ...imported(module, owner, active.namespace), exportName: active.exportName },
        identity: { ...imported(module, owner, identity.groups.namespace), exportName: identity.groups.exportName,
          host: identity.groups.host, authMethod: identity.groups.auth, range: span(body, identity) } },
      write: { hostId: write.host, cwd: write.cwd, context: writeContext.groups.context,
        resolver: functionRange(routing), routingSource: {
          ...imported(module, owner, route.groups.namespace), exportName: route.groups.exportName } },
      profile: { settings: fields.settings, expression: `${fields.settings}.profile`,
        reader: functionRange(reader), options: span(body, readOptions), read: span(body, read) },
      target: { ...imported(module, owner, defaultNames.namespace), exportName: currentTarget.groups.targetExport,
        hasConversation: currentTarget.groups.hasConversation, store: defaultNames.store },
      default: { exposed: fields.defaultSetter, setter: span(body, defaultWrapper), writer: functionRange(writer),
        call: span(writer.body, service), service: { ...imported(module, owner, service.groups.namespace), exportName: service.groups.exportName },
        query: { ...imported(module, owner, query.groups.namespace), exportName: query.groups.exportName, range: span(writer.body, query) },
        prewarm: span(writer.body, prewarm) },
      current: { exposed: fields.currentSetter, setter: functionRange(current), target: span(current.body, currentTarget),
        write: span(current.body, currentCall) },
      nextTurn: { exposed: fields.nextSetter, setter: functionRange(next), target: span(next.body, nextTarget),
        rpc: span(body, rpc), invoke: span(next.body, nextInvoke), ready: rpc.groups.ready,
        mode: { ...imported(module, owner, rpc.groups.modeNamespace), exportName: rpc.groups.modeExport },
        optimistic: { selection: pending.groups.selection, atom: pendingWrite.groups.atom,
          value: span(next.body, pending), write: span(next.body, pendingWrite), cleanup: span(next.body, cleanup) } },
      effectiveSettings, result: span(owner, returned) };
  } catch (error) { return unsupported(error.message); }
}

module.exports = { inspectModelCatalogOwner, inspectModelSettingsOwner };
