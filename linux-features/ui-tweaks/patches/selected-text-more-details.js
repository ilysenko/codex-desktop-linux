"use strict";

const fs = require("node:fs");
const path = require("node:path");
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
    `function (${IDENT})\\((${IDENT}),(${IDENT})\\)\\{return ${context.name}\\(\\2,` +
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
  if (!sendInit.source.includes(`${sendInit.name}=e(`)) throw new Error("ChatGPT submission initializer drifted");
  return { init: init.name, capability, blocked, account, session, host, create: create[1], visibility,
    context: contextWrapper, send: send.name, sendInit: sendInit.name, model,
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
    submitting:${bindings.submitting}, stopping:${bindings.stopping}};
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

function overlayContract(source) {
  const header = uniqueMatch(source,
    `function (${IDENT})\\(${IDENT}\\)\\{let (${IDENT})=\\(0,${IDENT}\\.c\\)\\((8|12)\\),` +
      `\\{onAddResponseTextAnnotation:(${IDENT}),onOpenSideChat:(${IDENT}),targetContainerRefs:${IDENT},targetSelector:${IDENT}\\}=${IDENT},(${IDENT})=${IDENT}\\(\\);`,
    "Codex selected-text overlay");
  const overlay = functionAt(source, header.index);
  const parent = uniqueMatch(source,
    `function (${IDENT})\\(${IDENT}\\)\\{let ${IDENT}=\\(0,${IDENT}\\.c\\)\\(18\\),` +
      `\\{actions:${IDENT},canOpenSideChat:${IDENT},scopeToThread:${IDENT},targetSelector:${IDENT}\\}=${IDENT},` +
      `(${IDENT})=(${IDENT})\\((${IDENT})\\),`, "Codex overlay scope");
  const parentFunction = functionAt(source, parent.index);
  if (!parentFunction.source.includes(`${header[1]},{onAddResponseTextAnnotation:`)) throw new Error("Overlay caller drifted");
  const sourceId = uniqueMatch(parentFunction.source,
    `(${IDENT})=(${IDENT})\\(${parent[2]}\\)`, "Codex source conversation getter")[2];
  const query = uniqueMatch(parentFunction.source,
    `let (${IDENT})=${IDENT},${IDENT}=(${IDENT})\\(${IDENT},\\1\\),${IDENT}=\\2\\(${IDENT},\\1\\)`,
    "Codex query hook")[2];
  const actions = containingFunction(source, "selectedTextOverlay.moreDetails");
  const intl = uniqueMatch(actions.source,
    `,${IDENT}=(${IDENT})\\(\\),\\[${IDENT},${IDENT}\\]=`, "selection intl hook")[1];
  const errors = containingFunction(source, "composer.sideSlashCommand.error");
  const logger = uniqueMatch(errors.source,
    `(${IDENT})\\.error\\(\\x60\\[Composer\\] side chat failed\\x60`, "selection logger")[1];
  const stateHook = uniqueMatch(errors.source,
    `${IDENT}=(${IDENT})\\(${IDENT}\\),${IDENT}=${intl}\\(\\)`, "Codex state hook")[1];
  const toastAtoms = [...errors.source.matchAll(new RegExp(`${IDENT}\\.get\\((${IDENT})\\)\\.danger\\(`, "gu"))];
  const toasts = new Set(toastAtoms.map((match) => match[1]));
  if (toasts.size !== 1) throw new Error("Selection error toast contract drifted");
  const target = uniqueMatch(overlay.source,
    `let\\{portalTarget:${IDENT},rect:${IDENT},selectedText:(${IDENT}),selectionRange:${IDENT},target:(${IDENT})\\}=`,
    "Codex selection text and source target");
  return { overlay, header, cache: header[2], add: header[4], side: header[5], zoom: header[6],
    scopeHook: parent[3], scopeAtom: parent[4], sourceId, query, stateHook, intl, logger, toast: [...toasts][0], target: target[2] };
}

function overlayEdits(contract) {
  const { cache, add, side, zoom, scopeHook, scopeAtom, sourceId, query, stateHook, intl, logger, toast, target } = contract;
  const setup = `/*${OVERLAY_MARKER}*/const codexLinuxQuickChatScope=${scopeHook}(${scopeAtom}),` +
    `codexLinuxQuickChatIntl=${intl}(),codexLinuxQuickChatBindings=${BINDINGS_EXPORT}(),` +
    `codexLinuxQuickChatCapability=${query}(codexLinuxQuickChatBindings.capability,{name:\`chatgpt.quick-chat\`}),` +
    `codexLinuxQuickChatCapable=codexLinuxQuickChatCapability.isCapable,` +
    `codexLinuxQuickChatAccount=${stateHook}(codexLinuxQuickChatBindings.account),` +
    `codexLinuxQuickChatBlocked=${stateHook}(codexLinuxQuickChatBindings.blocked),` +
    `codexLinuxQuickChatSourceId=${sourceId}(codexLinuxQuickChatScope),` +
    `codexLinuxCanAskQuickChat=codexLinuxQuickChatCapable&&codexLinuxQuickChatAccount!=null&&!codexLinuxQuickChatBlocked&&codexLinuxQuickChatSourceId!=null;` +
    `${DIAGNOSTICS_EXPORT}(codexLinuxQuickChatScope,{kind:codexLinuxQuickChatScope.value.kind,` +
    `sourcePresent:codexLinuxQuickChatSourceId!=null,hookCapable:codexLinuxQuickChatCapable===true,` +
    `loading:codexLinuxQuickChatCapability.isLoading===true,error:codexLinuxQuickChatCapability.isError===true,` +
    `storeCapable:codexLinuxQuickChatScope.get(codexLinuxQuickChatBindings.capability,{name:\`chatgpt.quick-chat\`}).isCapable===true,` +
    `blocked:codexLinuxQuickChatBlocked===true,contextPresent:codexLinuxQuickChatScope.get(codexLinuxQuickChatBindings.account)!=null,` +
    `visible:codexLinuxCanAskQuickChat===true},${logger});`;
  const callback = `onMoreDetails:codexLinuxCanAskQuickChat?codexLinuxText=>{${OPEN_EXPORT}(codexLinuxQuickChatScope,{` +
    `sourceConversationId:codexLinuxQuickChatSourceId,selectedText:codexLinuxText,selectedMessageText:${target}.innerText,logger:${logger},` +
    `prompt:codexLinuxQuickChatIntl.formatMessage({id:\`selectedTextOverlay.quickChatPrompt\`,defaultMessage:\`Tell me more about this\`}),` +
    `targetedReplyLabel:codexLinuxQuickChatIntl.formatMessage({id:\`chatGptConversation.targetedReply.selectedText\`,defaultMessage:\`Selected text\`})` +
    `}).catch(()=>{codexLinuxQuickChatScope.get(${toast}).danger(codexLinuxQuickChatIntl.formatMessage({` +
    `id:\`selectedTextOverlay.quickChatError\`,defaultMessage:\`Failed to start chat\`}),{errorAnalytics:{toastId:\`selectedTextOverlay.quickChatError\`}})})}:void 0,`;
  return { setup, callback,
    guard: `if(${add}==null&&${side}==null`,
    dependencies: `||${cache}[8]!==codexLinuxCanAskQuickChat||${cache}[9]!==codexLinuxQuickChatIntl||${cache}[10]!==codexLinuxQuickChatScope||${cache}[11]!==codexLinuxQuickChatSourceId`,
    assignments: `${cache}[8]=codexLinuxCanAskQuickChat,${cache}[9]=codexLinuxQuickChatIntl,${cache}[10]=codexLinuxQuickChatScope,${cache}[11]=codexLinuxQuickChatSourceId,`,
    originalDependencies: `${cache}[0]!==${add}||${cache}[1]!==${side}||${cache}[2]!==${zoom}` };
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Ambiguous or missing insertion point: ${before}`);
  return source.replace(before, after);
}

function patchSources(initial, primary, initialName) {
  const bindings = runtimeContract(initial);
  const runtime = runtimeSource(bindings);
  const dispatch = namedFunction(initial, bindings.dispatch);
  const nativeTrace = patchNativeSenderTrace(dispatch);
  const contract = overlayContract(primary);
  const edits = overlayEdits(contract);
  const nativeImport = uniqueMatch(primary,
    `import\\{([^}]*)\\}from(["\\x60])\\./${escapeRegExp(initialName)}\\2`, "existing app runtime import");
  const ownImports = [BINDINGS_EXPORT, OPEN_EXPORT, DIAGNOSTICS_EXPORT];
  const importNames = nativeImport[1].split(",").filter(Boolean);
  const importWithHelpers = `import{${[...importNames, ...ownImports].join(",")}}from${nativeImport[2]}./${initialName}${nativeImport[2]}`;
  const runtimeCount = initial.split(RUNTIME_MARKER).length - 1;
  const overlayCount = primary.split(OVERLAY_MARKER).length - 1;
  if (runtimeCount || overlayCount) {
    if (runtimeCount !== 1 || overlayCount !== 1 || !initial.endsWith(runtime) || !nativeTrace.applied ||
        !ownImports.every((name) => importNames.filter((entry) => entry === name).length === 1) || contract.header[3] !== "12" ||
        !contract.overlay.source.includes(edits.setup) || !contract.overlay.source.includes(edits.callback) ||
        !contract.overlay.source.includes(edits.originalDependencies + edits.dependencies) ||
        !contract.overlay.source.includes(edits.assignments) ||
        !contract.overlay.source.includes(edits.guard + "&&!codexLinuxCanAskQuickChat)")) {
      throw new Error("Incomplete or drifted selected-text Quick Chat patch");
    }
    return { initial, primary, applied: true };
  }
  if (contract.header[3] !== "8" || primary.includes(BINDINGS_EXPORT) || initial.includes(OPEN_EXPORT) || nativeTrace.applied) {
    throw new Error("Mixed selected-text Quick Chat input");
  }
  // Both assets and every cache dependency are validated before either file is written.
  let overlay = contract.overlay.source;
  overlay = replaceOnce(overlay, ".c)(8)", ".c)(12)");
  overlay = replaceOnce(overlay, edits.guard, edits.setup + edits.guard);
  overlay = replaceOnce(overlay, edits.guard + ")", edits.guard + "&&!codexLinuxCanAskQuickChat)");
  overlay = replaceOnce(overlay, edits.originalDependencies, edits.originalDependencies + edits.dependencies);
  overlay = replaceOnce(overlay, `${contract.cache}[0]=${contract.add},`, edits.assignments + `${contract.cache}[0]=${contract.add},`);
  overlay = replaceOnce(overlay, `onOpenSideChat:${contract.side}}`, edits.callback + `onOpenSideChat:${contract.side}}`);
  const patchedPrimary = primary.slice(0, contract.overlay.start) + overlay + primary.slice(contract.overlay.end);
  return { initial: initial.slice(0, dispatch.start) + nativeTrace.source + initial.slice(dispatch.end) + runtime,
    primary: replaceOnce(patchedPrimary, nativeImport[0], importWithHelpers), applied: false };
}

function applySelectedTextMoreDetails(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  try {
    const assets = path.join(extractedDir, "webview", "assets");
    const names = fs.readdirSync(assets);
    const findAsset = (pattern, marker) => {
      const matches = names.filter((name) => pattern.test(name)).map((name) => ({ name,
        source: fs.readFileSync(path.join(assets, name), "utf8") })).filter((asset) => asset.source.includes(marker));
      if (matches.length !== 1) throw new Error(`Expected one ${marker} asset, found ${matches.length}`);
      return matches[0];
    };
    const initial = findAsset(/^app-initial-[A-Za-z0-9_-]+\.js$/u, "has-opened-quick-chat-v1");
    const primary = findAsset(/^app-primary-[A-Za-z0-9_-]+\.js$/u, "selectedTextOverlay.moreDetails");
    if (!primary.source.includes(`from"./${initial.name}"`) && !primary.source.includes(`from\`./${initial.name}\``)) {
      throw new Error("Codex overlay imports a different runtime asset");
    }
    const result = patchSources(initial.source, primary.source, initial.name);
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
