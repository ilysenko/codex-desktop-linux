"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { patchNativeSenderTrace, traceRuntimeSource } = require("./selected-text-more-details-trace.js");

// Discovery also runs on isolated feature copies whose disabled patches never
// need the ASAR engine helpers. Load those helpers only when applying the tweak.
function escapeRegExp(value) {
  return require("../../../scripts/patches/lib/minified-js.js").escapeRegExp(value);
}

function findMatchingBrace(source, index) {
  return require("../../../scripts/patches/lib/minified-js.js").findMatchingBrace(source, index);
}

const RUNTIME_MARKER = "codex-linux-selected-text-more-details:runtime";
const OVERLAY_MARKER = "codex-linux-selected-text-more-details:overlay";
const BINDINGS_EXPORT = "codexLinuxSelectedTextQuickChatBindings";
const OPEN_EXPORT = "codexLinuxOpenSelectedTextQuickChat";
const DIAGNOSTICS_EXPORT = "codexLinuxReportSelectedTextQuickChatState";
const IDENT = "[A-Za-z_$][\\w$]*";

function enabled(context) {
  const defaults = context?.feature?.manifest?.tweaks?.selection?.moreDetails;
  const settings = context?.feature?.settings?.tweaks?.selection?.moreDetails;
  return (settings?.enabled ?? defaults?.enabled) === true;
}

function uniqueMatch(source, pattern, label) {
  const matches = [...source.matchAll(new RegExp(pattern, "gu"))];
  if (matches.length !== 1) throw new Error(`Expected one ${label}, found ${matches.length}`);
  return matches[0];
}

function functionAt(source, start) {
  const header = /^(?:async )?function ([A-Za-z_$][\w$]*)\(/u.exec(source.slice(start));
  if (header == null) throw new Error("Missing function declaration");
  let depth = 1;
  let quote = null;
  let escaped = false;
  let cursor = start + header[0].length;
  for (; cursor < source.length && depth > 0; cursor += 1) {
    const char = source[cursor];
    if (quote != null) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
  }
  if (depth !== 0 || source[cursor] !== "{") throw new Error("Unrecognized function body");
  const end = findMatchingBrace(source, cursor);
  if (end < 0) throw new Error("Unterminated function body");
  return { name: header[1], start, end: end + 1, source: source.slice(start, end + 1) };
}

function containingFunction(source, marker) {
  const functions = new Map();
  for (const match of source.matchAll(new RegExp(escapeRegExp(marker), "gu"))) {
    let start = source.lastIndexOf("function ", match.index);
    if (source.slice(start - 6, start) === "async ") start -= 6;
    const result = functionAt(source, start);
    if (match.index >= result.end) throw new Error(`${marker} is outside its function`);
    functions.set(start, result);
  }
  if (functions.size !== 1) throw new Error(`Expected one ${marker} function, found ${functions.size}`);
  return [...functions.values()][0];
}

function namedFunction(source, name) {
  const match = uniqueMatch(source, `(?:async )?function ${escapeRegExp(name)}\\(`, `${name} declaration`);
  return functionAt(source, match.index);
}

function runtimeContract(source) {
  const init = containingFunction(source, "has-opened-quick-chat-v1");
  const factoryHeader = uniqueMatch(source,
    `function (${IDENT})\\((${IDENT}),\\{projectId:${IDENT}=null,projectName:${IDENT}=null,` +
      `preservePreviousSession:${IDENT}=!1,\\.\\.\\.${IDENT}\\}=\\{\\}\\)`,
    "Quick Chat factory");
  const factory = functionAt(source, factoryHeader.index);
  const scope = factoryHeader[2];
  const capability = uniqueMatch(factory.source,
    `if\\(!${scope}\\.get\\((${IDENT}),\\{name:\\x60chatgpt.quick-chat\\x60\\}\\)\\.isCapable\\)return;`,
    "Quick Chat capability")[1];
  const create = uniqueMatch(factory.source,
    `(${IDENT})\\(${scope},\\{contextSourceThread:(${IDENT})\\(${scope}\\),projectId:`,
    "Quick Chat session constructor");
  const sessionFactory = namedFunction(source, create[1]);
  const session = uniqueMatch(sessionFactory.source,
    `(${IDENT})\\.set\\((${IDENT}),\\{contextSourceThread:`, "Quick Chat session atom")[2];
  if (!init.source.includes(`${session}=`)) throw new Error("Quick Chat session initializer drifted");
  const currentSource = namedFunction(source, create[2]);
  const host = uniqueMatch(currentSource.source,
    `hostId:${IDENT}\\.get\\((${IDENT}),${IDENT}\\)`, "source host atom")[1];
  const visibility = uniqueMatch(factory.source,
    `(${IDENT})\\(${scope},!1\\),${IDENT}\\(${scope},\\{action:${IDENT}\\.CODEX_QUICK_CHAT_LIFECYCLE_ACTION_OPENED`,
    "Quick Chat visibility helper")[1];
  const context = containingFunction(source, "Reply to the user query using the following additional context from their Codex conversation:");
  const contextWrapper = uniqueMatch(source,
    `function (${IDENT})\\((${IDENT}),(${IDENT})\\)\\{return ${escapeRegExp(context.name)}\\(\\2,` +
      `\\{isBackgroundSubagentsEnabled:!0,sourceThread:\\3\\}\\)\\}`,
    "Quick Chat source-context helper")[1];
  const accountContext = containingFunction(source, "Context window or account changed");
  const account = uniqueMatch(accountContext.source,
    `let (${IDENT})=${IDENT}\\.get\\((${IDENT})\\);if\\(\\1==null\\)return null;`,
    "context account guard")[2];
  const send = containingFunction(source, "Lockdown mode blocks connector approvals");
  if (!send.source.includes("extraDeveloperInstructions:") || !send.source.includes("messageMetadata:") ||
      !send.source.includes("requireResponseAcceptance:") || !send.source.includes("isRequestCurrent:")) {
    throw new Error("ChatGPT submission context contract drifted");
  }
  const blocked = uniqueMatch(send.source,
    `!${IDENT}&&${IDENT}\\.get\\((${IDENT})\\)\\)throw new ${IDENT}`, "ChatGPT submission guard")[1];
  const model = uniqueMatch(source,
    `let (${IDENT})=${IDENT}\\.get\\((${IDENT}),${IDENT}\\);return ${IDENT}\\([\\s\\S]{0,450}?` +
      `model:\\1\\.slug,[\\s\\S]{0,200}?thinkingEffort:\\1\\.thinkingEffort\\}\\)`,
    "ChatGPT selected model")[2];
  const statusMatch = uniqueMatch(source,
    `(${IDENT})=${IDENT}\\(${IDENT},\\((${IDENT}),\\{get:(${IDENT})\\}\\)=>\\{` +
      `let (${IDENT})=${IDENT}\\(\\3,\\2\\);if\\(\\4==null\\)return\\x60idle\\x60;` +
      `let (${IDENT})=\\3\\(${IDENT},\\4\\),(${IDENT})=\\3\\(${IDENT},\\4\\)===\\x60tpp\\x60;` +
      `if\\(!\\6&&\\5!==\\x60idle\\x60\\)return \\5;`, "ChatGPT conversation status");
  const status = statusMatch[1];
  const statusInit = containingFunction(source, statusMatch[0]);
  const busy = containingFunction(source,
    "case`active-async-turn`:case`active-tpp-turn`:case`streaming`:return!0;case`error`:case`idle`:return!1");
  const submissionLocks = uniqueMatch(source,
    `if\\((${IDENT})\\.get\\((${IDENT}),(${IDENT})\\)\\|\\|\\1\\.get\\((${IDENT}),\\3\\)\\|\\|` +
      `${IDENT}&&${IDENT}==null\\)return!1;let ${IDENT}=\\1\\.get\\(${escapeRegExp(model)},\\3\\);` +
      `\\1\\.set\\(\\2,\\3,!0\\)`, "ChatGPT native submission locks");
  const submitting = submissionLocks[2];
  const stopping = submissionLocks[4];
  const dispatch = containingFunction(source, "gizmoEditor??");
  if (!/\.isEventStream&&[A-Za-z_$][\w$]*\.requireResponseAcceptance[^;]{0,100}\?\.resolve\(null\)/u.test(dispatch.source)) {
    throw new Error("ChatGPT response acceptance contract drifted");
  }
  const overrides = uniqueMatch(dispatch.source, `gizmoEditor\\?\\?${IDENT}\\.get\\((${IDENT}),`, "ChatGPT dispatch overrides")[1];
  const sendInit = containingFunction(source, `${overrides}=`);
  return { init: init.name, capability, blocked, account, session, host, create: create[1], visibility,
    context: contextWrapper, send: send.name, sendInit: sendInit.name, overrides, model,
    status, statusInit: statusInit.name, busy: busy.name, submitting, stopping, dispatch: dispatch.name };
}

function runtimeSource(bindings) {
  return `\n/*${RUNTIME_MARKER}*/
${traceRuntimeSource()}
const codexLinuxSelectedTextQuickChatQueues = new WeakMap();
const codexLinuxSelectedTextQuickChatVisibilityStates = new WeakMap();
export function ${DIAGNOSTICS_EXPORT}(scope, state, logger) {
  const signature = JSON.stringify(state);
  if (codexLinuxSelectedTextQuickChatVisibilityStates.get(scope) === signature) return;
  codexLinuxSelectedTextQuickChatVisibilityStates.set(scope, signature);
  logger.info("[ui-tweaks] selected-text More details visibility", {safe:state, sensitive:{}});
}
export function ${BINDINGS_EXPORT}() {
  ${bindings.init}();
  ${bindings.sendInit}();
  ${bindings.statusInit}();
  return {capability:${bindings.capability}, blocked:${bindings.blocked}, account:${bindings.account},
    session:${bindings.session}, host:${bindings.host}, create:${bindings.create}, show:${bindings.visibility},
    context:${bindings.context}, send:${bindings.send}, model:${bindings.model}, status:${bindings.status}, busy:${bindings.busy},
    submitting:${bindings.submitting}, stopping:${bindings.stopping}, overrides:${bindings.overrides}};
}
export function ${OPEN_EXPORT}(scope, input) {
  const bindings = ${BINDINGS_EXPORT}();
  const selectedText = input.selectedText.trim();
  const account = scope.get(bindings.account);
  if (!selectedText || !input.sourceConversationId || account == null ||
      !scope.get(bindings.capability, {name:"chatgpt.quick-chat"}).isCapable || scope.get(bindings.blocked)) return Promise.resolve();
  // This context identity belongs to AppScope and is shared by retained
  // ComposerScopes. Quick Chat has one session across those source chats.
  const previous = codexLinuxSelectedTextQuickChatQueues.get(account) ?? Promise.resolve();
  const trace=codexLinuxQuickChatCreateTrace(input.logger);
  trace.event("selection-queued",{queuedBehindOther:codexLinuxSelectedTextQuickChatQueues.has(account)});
  const operation = previous.catch(() => {}).then(async () => {
    const canContinue = (get = (...args) => scope.get(...args)) => get(bindings.account) === account && !get(bindings.blocked);
    const canSend = (get = (...args) => scope.get(...args)) => canContinue(get) &&
      get(bindings.capability, {name:"chatgpt.quick-chat"}).isCapable;
    const report = (phase) => { const state=scope.get(bindings.capability,{name:"chatgpt.quick-chat"});
      trace.event(phase,{loading:state.isLoading===true,capable:state.isCapable===true,error:state.isError===true}); };
    if (!canSend()) return;
    const sourceThread = {threadId:input.sourceConversationId, hostId:scope.get(bindings.host, input.sourceConversationId)};
    report("ready");
    const context = await bindings.context(scope, sourceThread);
    report("context-ready");
    if (!canSend()) return;
    let sourceMessage = input.selectedMessageText.trim() || selectedText;
    if (sourceMessage.length > 40000) {
      const offset = sourceMessage.indexOf(selectedText);
      sourceMessage = offset < 0
        ? sourceMessage.slice(0, 19980) + "\\n… source message truncated …\\n" + sourceMessage.slice(-19980)
        : sourceMessage.slice(Math.max(0, offset - 19983), offset) +
          "\\n… selected text shown above …\\n" + sourceMessage.slice(offset + selectedText.length, offset + selectedText.length + 19984);
    }
    const isBusy = (id, get = (...args) => scope.get(...args)) =>
      get(bindings.submitting, id) || get(bindings.stopping, id) || bindings.busy(get(bindings.status, id));
    let session = scope.get(bindings.session);
    // Wait before replacing the native session: its constructor disposes an
    // unfinished previous conversation, including one submitted by the editor.
    while (session != null && isBusy(session.conversationId)) {
      const pendingId = session.conversationId;
      report("waiting-for-reply");
      await scope.when(({get}) => !canSend(get) || !isBusy(pendingId, get));
      if (!canSend()) return;
      session = scope.get(bindings.session);
    }
    const conversationId = session?.selectedTextSourceConversationId === input.sourceConversationId
      ? session.conversationId : bindings.create(scope, {contextSourceThread:sourceThread});
    scope.set(bindings.session, {...scope.get(bindings.session), selectedTextSourceConversationId:input.sourceConversationId});
    if (isBusy(conversationId)) {
      report("waiting-for-reply");
      await scope.when(({get}) => !canSend(get) || !isBusy(conversationId, get));
    }
    if (!canSend()) return;
    if (scope.get(bindings.session)?.conversationId !== conversationId) {
      bindings.create(scope, {conversationId, contextSourceThread:sourceThread});
      scope.set(bindings.session, {...scope.get(bindings.session), selectedTextSourceConversationId:input.sourceConversationId});
    }
    bindings.show(scope, true);
    const model = scope.get(bindings.model, conversationId);
    report("waiting-for-response");
    const releaseTrace=codexLinuxQuickChatAttachTrace(scope,conversationId,trace);
    scope.set(bindings.submitting, conversationId, true);
    try {
      await bindings.send(scope, {conversationId, model:model.slug, thinkingEffort:model.thinkingEffort,
        requireResponseAcceptance:true, isRequestCurrent:canSend,
        prompt:input.prompt, extraDeveloperInstructions:[...context,
          "The user is referring to this in particular:\\n" + selectedText +
          "\\n\\n---\\n\\nThe selection appears in the following source message. Prioritize this source message over the broader conversation context:\\n\\n" + sourceMessage],
        messageMetadata:{is_visually_hidden_from_conversation:true, targeted_reply:selectedText, targeted_reply_label:input.targetedReplyLabel}});
    } catch (error) {
      report("failed-before-response");
      throw error;
    } finally {
      scope.set(bindings.submitting, conversationId, false);
      releaseTrace();
    }
    report("response-accepted");
    if (!canContinue()) return;
    const current = scope.get(bindings.session);
    if (current?.conversationId === conversationId) scope.set(bindings.session, {...current, hasConversation:true});
  });
  codexLinuxSelectedTextQuickChatQueues.set(account, operation);
  const cleanup = () => { if (codexLinuxSelectedTextQuickChatQueues.get(account) === operation) codexLinuxSelectedTextQuickChatQueues.delete(account); };
  operation.then(cleanup, cleanup);
  return operation;
}
`;
}

function overlayContract(source, references = []) {
  const header = uniqueMatch(source,
    `function (${IDENT})\\(${IDENT}\\)\\{let (${IDENT})=\\(0,${IDENT}\\.c\\)\\((8)\\),` +
      `\\{onAddResponseTextAnnotation:(${IDENT}),onOpenSideChat:(${IDENT}),targetContainerRefs:${IDENT},targetSelector:${IDENT}\\}=${IDENT},(${IDENT})=${IDENT}\\(\\);`,
    "Codex selected-text overlay");
  const overlay = functionAt(source, header.index);
  const parent = uniqueMatch(source,
    `function (${IDENT})\\(${IDENT}\\)\\{let (${IDENT})=\\(0,${IDENT}\\.c\\)\\((18)\\),` +
      `\\{actions:${IDENT},canOpenSideChat:${IDENT},scopeToThread:${IDENT},targetSelector:${IDENT}\\}=${IDENT},` +
      `(${IDENT})=(${IDENT})\\((${IDENT})\\),`, "Codex overlay scope");
  const parentFunction = functionAt(source, parent.index);
  if (!parentFunction.source.includes(`${header[1]},{onAddResponseTextAnnotation:`)) {
    throw new Error("Overlay caller drifted");
  }
  const sourceId = uniqueMatch(parentFunction.source,
    `(${IDENT});${parent[2]}\\[2\\]===${parent[4]}\\?\\1=${parent[2]}\\[3\\]:` +
      `\\(\\1=(${IDENT})\\(${parent[4]}\\),${parent[2]}\\[2\\]=${parent[4]},${parent[2]}\\[3\\]=\\1\\);let (${IDENT})=\\1,`,
    "Codex source conversation getter")[3];
  const selection = uniqueMatch(overlay.source,
    `let\\{portalTarget:${IDENT},rect:${IDENT},selectedText:(${IDENT}),selectionRange:${IDENT},target:(${IDENT})\\}=`,
    "Codex selection text and source target");
  const owners = overlayOwners(source, references);
  return { overlay, parent: parentFunction, header, cache: header[2], add: header[4], side: header[5],
    zoom: header[6], parentCache: parent[2], scope: parent[4], sourceId,
    selectedText: selection[1], target: selection[2], owners };
}

function overlayEdits(contract) {
  const { cache, add, side, zoom, parentCache, scope, sourceId, target, owners } = contract;
  const parentSetup = `/*${OVERLAY_MARKER}*/let codexLinuxBindings=${BINDINGS_EXPORT}(),` +
    `codexLinuxCapability=${owners.query}(codexLinuxBindings.capability,{name:\`chatgpt.quick-chat\`}),` +
    `codexLinuxAccount=${owners.read}(codexLinuxBindings.account),codexLinuxBlocked=${owners.read}(codexLinuxBindings.blocked),` +
    `codexLinuxIntl=${owners.intl}(),codexLinuxPrompt=codexLinuxIntl.formatMessage({id:\`selectedTextOverlay.quickChatPrompt\`,` +
    `defaultMessage:\`Tell me more about this\`,description:\`Prompt sent to Quick Chat for selected response text\`}),` +
    `codexLinuxTargetedReplyLabel=codexLinuxIntl.formatMessage({id:\`selectedTextOverlay.targetedReplyLabel\`,` +
    `defaultMessage:\`Selected text\`,description:\`Label for selected response text sent to Quick Chat\`}),` +
    `codexLinuxCanMoreDetails=${sourceId}!=null&&codexLinuxAccount!=null&&codexLinuxCapability.isCapable===!0&&` +
    `codexLinuxCapability.isLoading!==!0&&!codexLinuxBlocked;` +
    `${DIAGNOSTICS_EXPORT}(${scope},{sourceConversationId:${sourceId}!=null,account:codexLinuxAccount!=null,` +
    `capable:codexLinuxCapability.isCapable===!0,loading:codexLinuxCapability.isLoading===!0,blocked:!!codexLinuxBlocked},console);` +
    `let codexLinuxMoreDetails;${parentCache}[18]!==${scope}||${parentCache}[19]!==${sourceId}||` +
    `${parentCache}[20]!==codexLinuxCanMoreDetails||${parentCache}[21]!==codexLinuxPrompt||` +
    `${parentCache}[22]!==codexLinuxTargetedReplyLabel?` +
    `(codexLinuxMoreDetails=codexLinuxCanMoreDetails?(e,t)=>${OPEN_EXPORT}(${scope},{sourceConversationId:${sourceId},` +
    `selectedText:e,selectedMessageText:t,logger:console,prompt:codexLinuxPrompt,` +
    `targetedReplyLabel:codexLinuxTargetedReplyLabel}).catch(e=>console.error(` +
    `\`[ui-tweaks] selected-text More details failed\`,e)):void 0,${parentCache}[18]=${scope},` +
    `${parentCache}[19]=${sourceId},${parentCache}[20]=codexLinuxCanMoreDetails,${parentCache}[21]=codexLinuxPrompt,` +
    `${parentCache}[22]=codexLinuxTargetedReplyLabel,${parentCache}[23]=codexLinuxMoreDetails):` +
    `codexLinuxMoreDetails=${parentCache}[23];`;
  return { parentSetup, guard: `if(${add}==null&&${side}==null`,
    originalDependencies: `${cache}[0]!==${add}||${cache}[1]!==${side}||${cache}[2]!==${zoom}`,
    leafDependency: `||${cache}[8]!==codexLinuxMoreDetails`,
    leafAssignment: `${cache}[8]=codexLinuxMoreDetails,`,
    toolbarCallback: `onMoreDetails:codexLinuxMoreDetails==null?void 0:e=>codexLinuxMoreDetails(e,${target}.innerText),` };
}

function matchingOwner(sources, marker, pattern, label) {
  const matches = [];
  for (const source of sources) {
    const functions = new Map();
    for (const markerMatch of source.matchAll(new RegExp(escapeRegExp(marker), "gu"))) {
      let start = source.lastIndexOf("function ", markerMatch.index);
      if (source.slice(start - 6, start) === "async ") start -= 6;
      const owner = functionAt(source, start);
      if (markerMatch.index < owner.end) functions.set(start, owner);
    }
    for (const owner of functions.values()) {
      const ownerMatches = [...owner.source.matchAll(new RegExp(pattern, "gu"))];
      if (ownerMatches.length === 1) matches.push({ source, owner, match: ownerMatches[0] });
      else if (ownerMatches.length > 1) throw new Error(`Expected one ${label} in its owner, found ${ownerMatches.length}`);
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one ${label} owner, found ${matches.length}`);
  return matches[0];
}

function importedSymbol(source, localName, label) {
  const matches = [];
  for (const declaration of source.matchAll(/import\{([^}]*)\}from(["`])([^"`]+)\2/gu)) {
    for (const entry of declaration[1].split(",")) {
      const parsed = /^([^ ]+)(?: as ([^ ]+))?$/u.exec(entry);
      if (parsed != null && (parsed[2] ?? parsed[1]) === localName) {
        matches.push({ exported: parsed[1], module: declaration[3] });
      }
    }
  }
  if (matches.length !== 1) throw new Error(`Expected one imported ${label}, found ${matches.length}`);
  return matches[0];
}

function ownerSymbol(primary, owner, localName, alias, label) {
  if (owner.source === primary) return { name: localName, import: null };
  const imported = importedSymbol(owner.source, localName, label);
  const targetImports = [];
  for (const declaration of primary.matchAll(/import\{([^}]*)\}from(["`])([^"`]+)\2/gu)) {
    if (declaration[3] !== imported.module) continue;
    const existing = declaration[1].split(",").map((entry) => /^([^ ]+)(?: as ([^ ]+))?$/u.exec(entry))
      .filter(Boolean).filter((entry) => entry[1] === imported.exported);
    targetImports.push({ declaration, existing });
  }
  if (targetImports.length !== 1) throw new Error(`Expected one ${label} module import, found ${targetImports.length}`);
  if (targetImports[0].existing.length > 1) throw new Error(`Expected at most one imported ${label}, found ${targetImports[0].existing.length}`);
  if (targetImports[0].existing.length === 1) {
    return { name: targetImports[0].existing[0][2] ?? targetImports[0].existing[0][1], import: null };
  }
  return { name: alias, import: { declaration: targetImports[0].declaration[0], exported: imported.exported, alias } };
}

function overlayOwners(primary, references = []) {
  const sources = [...new Set([primary, ...references])];
  const availability = matchingOwner(sources, "{name:`chatgpt.quick-chat`}",
    `\\{name:\x60chatgpt.quick-chat\\x60\\}[\\s\\S]{0,400}?let (${IDENT})=(${IDENT})\\((${IDENT}),${IDENT}\\)\\.isCapable,` +
      `(${IDENT})=(${IDENT})\\((${IDENT})\\),${IDENT}=\\1&&!\\4`,
    "Quick Chat renderer availability");
  const localization = matchingOwner(sources, "id:`selectedTextOverlay.moreDetails`",
    `(${IDENT})=(${IDENT})\\(\\)[\\s\\S]{0,1800}?\\1\\.formatMessage\\(`,
    "selected-text localization hook");
  const query = ownerSymbol(primary, availability, availability.match[2], "codexLinuxCapabilityQuery", "capability query hook");
  const read = ownerSymbol(primary, availability, availability.match[5], "codexLinuxStateValue", "state value hook");
  const intl = ownerSymbol(primary, localization, localization.match[2], "codexLinuxIntlHook", "localization hook");
  return { query: query.name, read: read.name, intl: intl.name,
    imports: [query.import, read.import, intl.import].filter(Boolean) };
}

function applyOwnerImports(source, imports) {
  let result = source;
  for (const addition of imports) {
    const current = result.includes(addition.declaration) ? addition.declaration : null;
    if (current == null) throw new Error("Owner module import changed before patching");
    const close = current.indexOf("}");
    const prefix = current.slice(0, close);
    const separator = prefix.endsWith("{") ? "" : ",";
    const replacement = `${prefix}${separator}${addition.exported} as ${addition.alias}${current.slice(close)}`;
    result = replaceOnce(result, current, replacement);
    for (const later of imports) {
      if (later !== addition && later.declaration === current) later.declaration = replacement;
    }
  }
  return result;
}

function validatePatchedOverlay(source, initialName, references = []) {
  const owners = overlayOwners(source, references);
  const nativeImport = uniqueMatch(source,
    `import\\{([^}]*)\\}from(["\\x60])\\./${escapeRegExp(initialName)}\\2`, "patched app runtime import");
  const importNames = nativeImport[1].split(",").filter(Boolean);
  for (const helper of [BINDINGS_EXPORT, DIAGNOSTICS_EXPORT, OPEN_EXPORT]) {
    if (importNames.filter((name) => name === helper).length !== 1) {
      throw new Error(`Incomplete or duplicate ${helper} import`);
    }
  }

  const parent = containingFunction(source, OVERLAY_MARKER);
  const parentHeader = uniqueMatch(parent.source,
    `function (${IDENT})\\(${IDENT}\\)\\{let (${IDENT})=\\(0,${IDENT}\\.c\\)\\(25\\),` +
      `\\{actions:${IDENT},canOpenSideChat:${IDENT},scopeToThread:${IDENT},targetSelector:${IDENT}\\}=${IDENT},` +
      `(${IDENT})=(${IDENT})\\((${IDENT})\\),`, "patched Codex overlay scope");
  const parentCache = parentHeader[2];
  const scope = parentHeader[3];
  const sourceId = uniqueMatch(parent.source,
    `(${IDENT});${parentCache}\\[2\\]===${scope}\\?\\1=${parentCache}\\[3\\]:` +
      `\\(\\1=(${IDENT})\\(${scope}\\),${parentCache}\\[2\\]=${scope},${parentCache}\\[3\\]=\\1\\);let (${IDENT})=\\1,`,
    "patched Codex source conversation getter")[3];
  const leafHeader = uniqueMatch(source,
    `function (${IDENT})\\(${IDENT}\\)\\{let (${IDENT})=\\(0,${IDENT}\\.c\\)\\(9\\),` +
      `\\{onAddResponseTextAnnotation:(${IDENT}),onMoreDetails:codexLinuxMoreDetails,onOpenSideChat:(${IDENT}),` +
      `targetContainerRefs:${IDENT},targetSelector:${IDENT}\\}=${IDENT},(${IDENT})=${IDENT}\\(\\);`,
    "patched Codex selected-text overlay");
  const leaf = functionAt(source, leafHeader.index);
  const selection = uniqueMatch(leaf.source,
    `let\\{portalTarget:${IDENT},rect:${IDENT},selectedText:(${IDENT}),selectionRange:${IDENT},target:(${IDENT})\\}=`,
    "patched Codex selection text and source target");
  const contract = { cache: leafHeader[2], add: leafHeader[3], side: leafHeader[4], zoom: leafHeader[5],
    parentCache, scope, sourceId, target: selection[2], owners };
  const edits = overlayEdits(contract);
  uniqueMatch(parent.source, escapeRegExp(edits.parentSetup), "complete More details parent callback");
  uniqueMatch(parent.source,
    `${escapeRegExp(leafHeader[1])},\\{onMoreDetails:codexLinuxMoreDetails,onAddResponseTextAnnotation:`,
    "More details parent-to-leaf prop");
  uniqueMatch(parent.source,
    `${parentCache}\\[13\\]!==${IDENT}\\|\\|${parentCache}\\[14\\]!==${IDENT}\\|\\|` +
      `${parentCache}\\[15\\]!==${IDENT}\\|\\|${parentCache}\\[16\\]!==${IDENT}\\|\\|` +
      `${parentCache}\\[24\\]!==codexLinuxMoreDetails`, "More details parent memo dependency");
  uniqueMatch(parent.source,
    `${parentCache}\\[13\\]=${IDENT},${parentCache}\\[14\\]=${IDENT},${parentCache}\\[15\\]=${IDENT},` +
      `${parentCache}\\[16\\]=${IDENT},${parentCache}\\[24\\]=codexLinuxMoreDetails,`,
    "More details parent memo assignment");
  uniqueMatch(leaf.source, escapeRegExp(`${edits.guard}&&codexLinuxMoreDetails==null`), "More details leaf guard");
  uniqueMatch(leaf.source, escapeRegExp(edits.originalDependencies + edits.leafDependency),
    "More details leaf memo dependency");
  uniqueMatch(leaf.source, escapeRegExp(edits.leafAssignment + `${contract.cache}[0]=${contract.add},`),
    "More details leaf memo assignment");
  uniqueMatch(leaf.source, escapeRegExp(edits.toolbarCallback), "More details toolbar callback");
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Ambiguous or missing insertion point: ${before}`);
  return source.replace(before, after);
}

function replaceRanges(source, replacements) {
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].end > ordered[index].start) {
      throw new Error("Overlapping selected-text overlay owners");
    }
  }
  let result = source;
  for (const replacement of ordered.reverse()) {
    result = result.slice(0, replacement.start) + replacement.source + result.slice(replacement.end);
  }
  return result;
}

function validateJavaScriptModuleSyntax(source, label) {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules",
    "-e",
    "const vm=require('node:vm');let source='';process.stdin.setEncoding('utf8');" +
      "process.stdin.on('data',chunk=>source+=chunk);" +
      "process.stdin.on('end',()=>{new vm.SourceTextModule(source)})",
  ], {
    input: source,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (result.error || result.status !== 0) {
    const diagnostic = result.stderr?.split("\n").find((line) => line.startsWith("SyntaxError:"));
    throw new Error(`${label} JavaScript syntax validation failed: ${diagnostic ?? result.error?.message ??
      `parser exited ${result.status} (${result.signal ?? "no signal"})`}`);
  }
}

function patchSources(initial, primary, initialName, references = []) {
  const bindings = runtimeContract(initial);
  const runtime = runtimeSource(bindings);
  const dispatch = namedFunction(initial, bindings.dispatch);
  const nativeTrace = patchNativeSenderTrace(dispatch);
  const runtimeCount = initial.split(RUNTIME_MARKER).length - 1;
  const overlayCount = primary.split(OVERLAY_MARKER).length - 1;
  if (runtimeCount || overlayCount) {
    if (runtimeCount !== 1 || overlayCount !== 1 || !initial.endsWith(runtime) || !nativeTrace.applied) {
      throw new Error("Incomplete or drifted selected-text Quick Chat patch");
    }
    validatePatchedOverlay(primary, initialName, references);
    validateJavaScriptModuleSyntax(initial, "selected-text runtime");
    validateJavaScriptModuleSyntax(primary, "selected-text overlay");
    return { initial, primary, applied: true };
  }
  const contract = overlayContract(primary, references);
  const edits = overlayEdits(contract);
  const nativeImport = uniqueMatch(primary,
    `import\\{([^}]*)\\}from(["\\x60])\\./${escapeRegExp(initialName)}\\2`, "existing app runtime import");
  const importNames = nativeImport[1].split(",").filter(Boolean);
  const importWithHelper = `import{${[...importNames, BINDINGS_EXPORT, DIAGNOSTICS_EXPORT, OPEN_EXPORT].join(",")}}` +
    `from${nativeImport[2]}./${initialName}${nativeImport[2]}`;
  if (contract.header[3] !== "8" || contract.parent.source.includes("codexLinuxMoreDetails") ||
      primary.includes(OPEN_EXPORT) || initial.includes(OPEN_EXPORT) || nativeTrace.applied) {
    throw new Error("Mixed selected-text Quick Chat input");
  }

  let parent = contract.parent.source;
  parent = replaceOnce(parent, ".c)(18)", ".c)(25)");
  const returnMatch = uniqueMatch(parent, `let (${IDENT});return ${escapeRegExp(contract.parentCache)}\\[13\\]`, "overlay parent return");
  parent = replaceOnce(parent, returnMatch[0], `${edits.parentSetup}${returnMatch[0]}`);
  parent = replaceOnce(parent,
    `${contract.header[1]},{onAddResponseTextAnnotation:`,
    `${contract.header[1]},{onMoreDetails:codexLinuxMoreDetails,onAddResponseTextAnnotation:`);
  const parentDependencies = uniqueMatch(parent,
    `${escapeRegExp(contract.parentCache)}\\[13\\]!==${IDENT}\\|\\|${escapeRegExp(contract.parentCache)}\\[14\\]!==${IDENT}\\|\\|` +
      `${escapeRegExp(contract.parentCache)}\\[15\\]!==${IDENT}\\|\\|${escapeRegExp(contract.parentCache)}\\[16\\]!==${IDENT}`,
    "overlay parent memo dependencies")[0];
  parent = replaceOnce(parent, parentDependencies,
    `${parentDependencies}||${contract.parentCache}[24]!==codexLinuxMoreDetails`);
  const parentAssignments = uniqueMatch(parent,
    `${escapeRegExp(contract.parentCache)}\\[13\\]=${IDENT},${escapeRegExp(contract.parentCache)}\\[14\\]=${IDENT},` +
      `${escapeRegExp(contract.parentCache)}\\[15\\]=${IDENT},${escapeRegExp(contract.parentCache)}\\[16\\]=${IDENT},`,
    "overlay parent memo assignments")[0];
  parent = replaceOnce(parent, parentAssignments,
    `${parentAssignments}${contract.parentCache}[24]=codexLinuxMoreDetails,`);

  let overlay = contract.overlay.source;
  overlay = replaceOnce(overlay, ".c)(8)", ".c)(9)");
  overlay = replaceOnce(overlay,
    `{onAddResponseTextAnnotation:${contract.add},onOpenSideChat:${contract.side},`,
    `{onAddResponseTextAnnotation:${contract.add},onMoreDetails:codexLinuxMoreDetails,onOpenSideChat:${contract.side},`);
  overlay = replaceOnce(overlay, edits.guard, `${edits.guard}&&codexLinuxMoreDetails==null`);
  overlay = replaceOnce(overlay, edits.originalDependencies, edits.originalDependencies + edits.leafDependency);
  overlay = replaceOnce(overlay, `${contract.cache}[0]=${contract.add},`, edits.leafAssignment + `${contract.cache}[0]=${contract.add},`);
  overlay = replaceOnce(overlay, `selectedText:${contract.selectedText},onAddSelectedText:`,
    `selectedText:${contract.selectedText},${edits.toolbarCallback}onAddSelectedText:`);

  let patchedPrimary = replaceRanges(primary, [
    { start: contract.parent.start, end: contract.parent.end, source: parent },
    { start: contract.overlay.start, end: contract.overlay.end, source: overlay },
  ]);
  patchedPrimary = applyOwnerImports(patchedPrimary, contract.owners.imports);
  patchedPrimary = replaceOnce(patchedPrimary, nativeImport[0], importWithHelper);
  const patchedInitial = initial.slice(0, dispatch.start) + nativeTrace.source + initial.slice(dispatch.end) + runtime;
  validatePatchedOverlay(patchedPrimary, initialName, references.filter((source) => source !== primary));
  validateJavaScriptModuleSyntax(patchedInitial, "selected-text runtime");
  validateJavaScriptModuleSyntax(patchedPrimary, "selected-text overlay");
  return { initial: patchedInitial, primary: patchedPrimary, applied: false };
}

function applySelectedTextMoreDetails(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  try {
    const assets = path.join(extractedDir, "webview", "assets");
    const names = fs.readdirSync(assets);
    const findAsset = (pattern, marker) => {
      const markers = Array.isArray(marker) ? marker : [marker];
      const matches = names.filter((name) => pattern.test(name)).map((name) => ({ name,
        source: fs.readFileSync(path.join(assets, name), "utf8") }))
        .filter((asset) => markers.every((entry) => asset.source.includes(entry)));
      if (matches.length !== 1) throw new Error(`Expected one ${markers.join(" + ")} asset, found ${matches.length}`);
      return matches[0];
    };
    const initial = findAsset(/^app-initial-[A-Za-z0-9_-]+\.js$/u, "has-opened-quick-chat-v1");
    const primaryMatches = [];
    const references = [];
    for (const name of names.filter((entry) => /^[A-Za-z0-9_-]+\.js$/u.test(entry))) {
      const source = name === initial.name ? initial.source : fs.readFileSync(path.join(assets, name), "utf8");
      if (source.includes("onAddResponseTextAnnotation:") && source.includes("targetContainerRefs:")) {
        primaryMatches.push({ name, source });
      }
      if (source.includes("{name:`chatgpt.quick-chat`}") || source.includes("id:`selectedTextOverlay.moreDetails`")) {
        references.push(source);
      }
    }
    if (primaryMatches.length !== 1) {
      throw new Error(`Expected one onAddResponseTextAnnotation: + targetContainerRefs: asset, found ${primaryMatches.length}`);
    }
    const primary = primaryMatches[0];
    if (!primary.source.includes(`from"./${initial.name}"`) && !primary.source.includes(`from\`./${initial.name}\``)) {
      throw new Error("Codex overlay imports a different runtime asset");
    }
    const result = patchSources(initial.source, primary.source, initial.name, references);
    const targets = [initial.name, primary.name].map((name) => path.join("webview", "assets", name));
    if (!result.applied) {
      fs.writeFileSync(path.join(assets, initial.name), result.initial);
      fs.writeFileSync(path.join(assets, primary.name), result.primary);
    }
    return { matched: 2, changed: result.applied ? 0 : 2, targets };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`WARN: Could not restore selected-text More details: ${reason} - skipping ui-tweaks patch`);
    return { matched: 0, changed: 0, reason };
  }
}

const descriptors = [{
  id: "selected-text-more-details",
  phase: "extracted-app:post-webview",
  order: 21_010,
  ciPolicy: "optional",
  enabled,
  apply: applySelectedTextMoreDetails,
  status: (result, warnings) => result?.matched !== 2
    ? { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null }
    : result.changed > 0 ? "applied" : "already-applied",
}];

module.exports = { RUNTIME_MARKER, OVERLAY_MARKER, BINDINGS_EXPORT, OPEN_EXPORT, DIAGNOSTICS_EXPORT, enabled,
  runtimeContract, runtimeSource, patchSources, applySelectedTextMoreDetails, descriptors };
