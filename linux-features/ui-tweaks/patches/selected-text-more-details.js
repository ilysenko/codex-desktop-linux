"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  NATIVE_TRACE_HELPER_MARKER, nativeTraceHelperSource, patchNativeSenderTrace, traceRuntimeSource,
} = require("./selected-text-more-details-trace.js");

// Discovery also runs on isolated feature copies whose disabled patches never
// need the ASAR engine helpers. Load those helpers only when applying the tweak.
function minifiedJs() {
  return require("../../../scripts/patches/lib/minified-js.js");
}

function escapeRegExp(value) {
  return minifiedJs().escapeRegExp(value);
}

function findMatchingBrace(source, index) {
  return minifiedJs().findMatchingBrace(source, index);
}

const RUNTIME_MARKER = "codex-linux-selected-text-more-details:runtime";
const OVERLAY_MARKER = "codex-linux-selected-text-more-details:overlay";
const BINDINGS_EXPORT = "codexLinuxSelectedTextQuickChatBindings";
const OPEN_EXPORT = "codexLinuxOpenSelectedTextQuickChat";
const AVAILABLE_EXPORT = "codexLinuxSelectedTextQuickChatAvailable";
const DIAGNOSTICS_EXPORT = "codexLinuxReportSelectedTextQuickChatState";
const ACTION_HELPER = "codexLinuxSelectedTextMoreDetailsAction";
const RUNTIME_REQUIRE = "codexLinuxSelectedTextQuickChatRequire";
const OVERLAY_INTL = "codexLinuxSelectedTextOverlayIntl";
const CREATE_SESSION = "codexLinuxSelectedTextQuickChatCreateSession";
// The overlay and the Quick Chat runtime are rspack modules in different lazy
// chunks without an import edge. The runtime publishes itself under a global
// symbol when its module evaluates; the overlay hides More details otherwise.
const REGISTRY_KEY = "codex-linux.selected-text-more-details";
const REGISTRY = `globalThis[Symbol.for(${JSON.stringify(REGISTRY_KEY)})]`;
// Every edit is wrapped in these comments, so a patched chunk can be restored
// to the upstream bytes and re-patched to prove the complete edit is present.
const SPAN_START = "/*codex-linux-selected-text-more-details:+*/";
const SPAN_REPLACE = "/*codex-linux-selected-text-more-details:~";
const SPAN_END = "/*codex-linux-selected-text-more-details:-*/";
const IDENT = "[A-Za-z_$][\\w$]*";
const MEMBER = `${IDENT}\\.${IDENT}`;
const PARENT_CACHE_SIZE = 18;
const LEAF_CACHE_SIZE = 8;
const KEYWORDS = new Set(("break case catch class const continue debugger default delete do else export extends false " +
  "finally for function if import in instanceof let new null of return super switch this throw true try typeof var " +
  "void while with yield async await undefined").split(" "));

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

function span(text) {
  return `${SPAN_START}${text}${SPAN_END}`;
}

function replacementSpan(original, text) {
  return `${SPAN_REPLACE}${original}*/${text}${SPAN_END}`;
}

// Removes every span this patch inserted and restores replaced upstream text.
function restoreUpstream(source) {
  let result = "";
  let cursor = 0;
  for (;;) {
    const insert = source.indexOf(SPAN_START, cursor);
    const replace = source.indexOf(SPAN_REPLACE, cursor);
    const start = [insert, replace].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (start == null) return result + source.slice(cursor);
    const end = source.indexOf(SPAN_END, start);
    if (end < 0) throw new Error("Unterminated selected-text More details edit");
    const inner = source.slice(start, end);
    if (inner.indexOf(SPAN_START, 1) >= 0 || inner.indexOf(SPAN_REPLACE, 1) >= 0) {
      throw new Error("Nested selected-text More details edit");
    }
    result += source.slice(cursor, start);
    if (start === replace) {
      const close = source.indexOf("*/", start + SPAN_REPLACE.length);
      if (close < 0 || close > end) throw new Error("Malformed selected-text More details replacement");
      result += source.slice(start + SPAN_REPLACE.length, close);
    }
    cursor = end + SPAN_END.length;
  }
}

function hasPatchSpans(source) {
  return source.includes(SPAN_START) || source.includes(SPAN_REPLACE) || source.includes(SPAN_END);
}

// --- rspack chunk structure -------------------------------------------------

// Returns the module factories of an rspack ESM chunk:
// export const __webpack_modules__={id(e,t,n){...},"id"(e,t,n){...}}.
function chunkModules(source) {
  const anchor = "export const __webpack_modules__={";
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + 1) >= 0) throw new Error("Unrecognized rspack chunk");
  const modules = [];
  let cursor = first + anchor.length;
  for (;;) {
    const header = new RegExp(`^,?(?:"([^"]+)"|(${IDENT}))\\(((?:${IDENT}(?:,${IDENT})*)?)\\)\\{`, "u")
      .exec(source.slice(cursor, cursor + 512));
    if (header == null) break;
    const start = cursor + (header[0].startsWith(",") ? 1 : 0);
    const open = cursor + header[0].length - 1;
    const close = findMatchingBrace(source, open);
    if (close < 0) throw new Error("Unterminated rspack module factory");
    modules.push({ id: header[1] ?? header[2], params: header[3] ? header[3].split(",") : [],
      start, bodyStart: open + 1, bodyEnd: close, end: close + 1 });
    cursor = close + 1;
  }
  if (source[cursor] !== "}" || modules.length === 0) throw new Error("Unrecognized rspack module table");
  return modules;
}

function moduleSource(source, module) {
  return source.slice(module.start, module.end);
}

function modulesContaining(source, modules, needles) {
  return modules.filter((module) => {
    const text = moduleSource(source, module);
    return needles.every((needle) => text.includes(needle));
  });
}

function uniqueModule(source, modules, needles, label) {
  const matches = modulesContaining(source, modules, needles);
  if (matches.length !== 1) throw new Error(`Expected one ${label} module, found ${matches.length}`);
  return matches[0];
}

function requireParam(module) {
  const name = module.params[2];
  if (name == null) throw new Error(`Module ${module.id} has no require parameter`);
  return name;
}

// Module-level text with every nested block body removed, used to inspect the
// declarations that are visible to code appended to the factory body.
function topLevelSkeleton(source, module) {
  let result = "";
  let cursor = module.bodyStart;
  while (cursor < module.bodyEnd) {
    const open = source.indexOf("{", cursor);
    if (open < 0 || open >= module.bodyEnd) {
      result += source.slice(cursor, module.bodyEnd);
      break;
    }
    const close = findMatchingBrace(source, open);
    if (close < 0 || close >= module.bodyEnd) throw new Error(`Unbalanced module ${module.id}`);
    result += `${source.slice(cursor, open)}{}`;
    cursor = close + 1;
  }
  // Parameter lists of module-level functions declare nothing at module level.
  let withoutParameters = "";
  let index = 0;
  for (const match of result.matchAll(/\bfunction\*? ?(?:[A-Za-z_$][\w$]*)?\(/gu)) {
    if (match.index < index) continue;
    let depth = 0;
    let close = match.index + match[0].length - 1;
    for (; close < result.length; close += 1) {
      if (result[close] === "(") depth += 1;
      else if (result[close] === ")" && --depth === 0) break;
    }
    if (close >= result.length) throw new Error(`Unbalanced parameters in module ${module.id}`);
    withoutParameters += `${result.slice(index, match.index + match[0].length)})`;
    index = close + 1;
  }
  return withoutParameters + result.slice(index);
}

function declaresTopLevel(skeleton, name) {
  const escaped = escapeRegExp(name);
  return new RegExp(`(?:^|[;{}])\\s*(?:async )?function\\*? ?${escaped}\\(|` +
    `(?:^|[;{}])\\s*class ${escaped}\\b|(?:^|[;{},]|let |var |const )${escaped}=(?!=)`, "u").test(skeleton) ||
    new RegExp(`(?:^|[;{}])(?:let|var|const) (?:${IDENT}(?:=[^,;]*)?,)*${escaped}(?=[,;])`, "u").test(skeleton);
}

function assertRequireVisible(source, module) {
  const name = requireParam(module);
  if (declaresTopLevel(topLevelSkeleton(source, module), name)) {
    throw new Error(`Module ${module.id} redeclares its require parameter`);
  }
  return name;
}

// Resolves a module-level namespace variable such as `a` in `a.G` to the
// rspack module id assigned by `a=n("id")` in the same factory.
function requiredModuleId(source, module, namespace) {
  const text = moduleSource(source, module);
  const req = escapeRegExp(requireParam(module));
  const match = uniqueMatch(text, `(?:var |[,;])${escapeRegExp(namespace)}=${req}\\("([^"]+)"\\)`,
    `${namespace} module binding in ${module.id}`);
  return match[1];
}

function memberReference(source, module, member, modules) {
  const [namespace, exported] = member.split(".");
  const id = requiredModuleId(source, module, namespace);
  if (modules != null && !modules.some((candidate) => candidate.id === id)) {
    throw new Error(`Module ${id} is not part of the Quick Chat runtime chunk`);
  }
  return `${RUNTIME_REQUIRE}(${JSON.stringify(id)}).${exported}`;
}

// --- function helpers -------------------------------------------------------

function functionAt(source, start) {
  const header = /^(?:async )?function ?([A-Za-z_$][\w$]*)?\(/u.exec(source.slice(start));
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
  return { name: header[1] ?? null, start, paramsEnd: cursor, bodyStart: cursor + 1, end: end + 1,
    source: source.slice(start, end + 1) };
}

function containingFunction(source, marker, from = 0, to = source.length) {
  const functions = new Map();
  let index = source.indexOf(marker, from);
  while (index >= 0 && index < to) {
    let start = source.lastIndexOf("function", index);
    for (; start >= from; start = source.lastIndexOf("function", start - 1)) {
      if (/^function[ (]/u.test(source.slice(start, start + 9))) {
        const begin = source.slice(start - 6, start) === "async " ? start - 6 : start;
        const result = functionAt(source, begin);
        if (index < result.end) {
          functions.set(begin, result);
          break;
        }
      }
    }
    index = source.indexOf(marker, index + 1);
  }
  if (functions.size !== 1) throw new Error(`Expected one ${marker} function, found ${functions.size}`);
  return [...functions.values()][0];
}

function namedFunction(source, name, from = 0, to = source.length) {
  const match = uniqueMatch(source.slice(from, to), `(?:^|[^\\w$.])((?:async )?function ${escapeRegExp(name)}\\()`,
    `${name} declaration`);
  return functionAt(source, from + match.index + match[0].length - match[1].length);
}

// Identifier references of a small upstream function, excluding properties,
// object keys and keywords. Strings are skipped.
function identifierTokens(text) {
  const tokens = [];
  let previous = "";
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "'" || char === '"' || char === "`") {
      if (char === "`") throw new Error("Template literal in copied Quick Chat code");
      for (cursor += 1; cursor < text.length && text[cursor] !== char; cursor += text[cursor] === "\\" ? 2 : 1);
      previous = "value";
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/u.exec(text.slice(cursor));
    if (word != null && !/[\w$]/u.test(text[cursor - 1] ?? "")) {
      const next = text[cursor + word[0].length];
      const following = text.slice(cursor + word[0].length, cursor + word[0].length + 2);
      const property = previous === ".";
      const key = next === ":" && (previous === "{" || previous === ",");
      if (!property && !key && !KEYWORDS.has(word[0])) {
        tokens.push({ name: word[0], previous, next: following });
      }
      cursor += word[0].length - 1;
      previous = "word";
      continue;
    }
    if (!/\s/u.test(char)) previous = char;
  }
  return tokens;
}

function boundNames(params, body) {
  const bound = new Set();
  for (const token of identifierTokens(params)) {
    if (token.previous !== "=" && /^(?:=(?!=)|,|\}|\)|$)/u.test(token.next)) bound.add(token.name);
  }
  // Over-approximates local declarations: declared names, later names in a
  // declaration list, and assignment targets. More names only make the
  // module-binding check stricter.
  for (const declaration of body.matchAll(new RegExp(`(?:let|const|var) (${IDENT}(?:,${IDENT})*)`, "gu"))) {
    for (const name of declaration[1].split(",")) bound.add(name);
  }
  for (const assignment of body.matchAll(new RegExp(`(?<=[,;({])(${IDENT})=(?![=>])`, "gu"))) bound.add(assignment[1]);
  return bound;
}

// --- Quick Chat runtime contract --------------------------------------------

function quickChatContract(source, modules) {
  const quick = uniqueModule(source, modules, ["has-opened-quick-chat-v1", "preservePreviousSession:"], "Quick Chat");
  const quickText = moduleSource(source, quick);
  const offset = quick.start;
  const factoryHeader = uniqueMatch(quickText,
    `function (${IDENT})\\((${IDENT}),\\{projectId:${IDENT}=null,projectName:${IDENT}=null,` +
      `preservePreviousSession:${IDENT}=!1,\\.\\.\\.${IDENT}\\}=\\{\\}\\)`,
    "Quick Chat factory");
  const factory = functionAt(source, offset + factoryHeader.index);
  const scope = escapeRegExp(factoryHeader[2]);
  const capability = uniqueMatch(factory.source,
    `if\\(!${scope}\\.get\\((${MEMBER}),\\{name:"chatgpt\\.quick-chat"\\}\\)\\.isCapable\\)return;`,
    "Quick Chat capability")[1];
  const constructor = uniqueMatch(factory.source,
    `\\(function\\((${IDENT}),\\{conversationId:${IDENT}=\\(0,${MEMBER}\\)\\(\\),contextSourceThread:${IDENT}=null,` +
      `projectId:${IDENT}=null,projectName:${IDENT}=null,preservePreviousSession:${IDENT}=!1\\}=\\{\\}\\)\\{`,
    "Quick Chat session constructor");
  const create = functionAt(source, factory.start + constructor.index + 1);
  if (!source.startsWith(`)(${factoryHeader[2]},{contextSourceThread:`, create.end)) {
    throw new Error("Quick Chat session constructor call drifted");
  }
  const session = uniqueMatch(create.source,
    `(${IDENT})\\.set\\((${IDENT}),\\{contextSourceThread:${IDENT},conversationId:${IDENT},hasConversation:!1,`,
    "Quick Chat session atom")[2];
  const host = uniqueMatch(factory.source, `hostId:${IDENT}\\.get\\((${MEMBER}),${IDENT}\\)`, "source host atom")[1];
  const visibility = uniqueMatch(factory.source,
    `(${IDENT})\\(${scope},!1\\),\\(0,${MEMBER}\\)\\(${scope},\\{action:${MEMBER}\\.CODEX_QUICK_CHAT_LIFECYCLE_ACTION_OPENED`,
    "Quick Chat visibility helper")[1];
  const context = containingFunction(source,
    "Reply to the user query using the following additional context from their Codex conversation:", quick.start, quick.end);
  const contextWrapper = uniqueMatch(quickText,
    `function (${IDENT})\\((${IDENT}),(${IDENT})\\)\\{return ${escapeRegExp(context.name)}\\(\\2,` +
      `\\{isBackgroundSubagentsEnabled:!0,sourceThread:\\3\\}\\)\\}`,
    "Quick Chat source-context helper")[1];
  const accountContext = containingFunction(source, "Context window or account changed", quick.start, quick.end);
  const account = uniqueMatch(accountContext.source,
    `let (${IDENT})=${IDENT}\\.get\\((${MEMBER})\\);if\\(null==\\1\\)return null;`, "context account guard")[2];

  // The copied constructor must only use module-level bindings: none of the
  // factory's own locals, all visible to code appended to the module body.
  const createBound = boundNames(source.slice(create.start, create.paramsEnd),
    source.slice(create.bodyStart, create.end - 1));
  const factoryText = source.slice(factory.start, create.start) + source.slice(create.end, factory.end);
  const factoryBound = boundNames(source.slice(factory.start, factory.paramsEnd), factoryText);
  const skeleton = topLevelSkeleton(source, quick);
  for (const { name } of identifierTokens(create.source.slice("function".length))) {
    if (createBound.has(name) || ["globalThis", "Symbol"].includes(name)) continue;
    if (factoryBound.has(name) || !declaresTopLevel(skeleton, name)) {
      throw new Error(`Quick Chat session constructor uses non-module binding ${name}`);
    }
  }
  for (const name of [session, visibility, contextWrapper]) {
    if (!declaresTopLevel(skeleton, name)) throw new Error(`Quick Chat binding ${name} is not module-level`);
  }
  return { module: quick, scopeModules: modules, capability: memberReference(source, quick, capability),
    host: memberReference(source, quick, host), account: memberReference(source, quick, account), session,
    show: visibility, context: contextWrapper, createSource: create.source };
}

function nativeSubmissionContract(source, modules) {
  const lockPattern = `(${IDENT})=(${IDENT})\\.get\\((${MEMBER}),(${IDENT})\\),(${IDENT})=\\(0,(${MEMBER})\\)\\(\\1\\);` +
    `if\\(\\2\\.get\\((${MEMBER}),\\4\\)\\|\\|\\2\\.get\\((${MEMBER}),\\4\\)\\|\\|\\5&&null==${IDENT}\\)return!1;` +
    `let (${IDENT})=\\2\\.get\\((${MEMBER}),\\4\\);\\2\\.set\\(\\7,\\4,!0\\)`;
  const followers = modulesContaining(source, modules, ["submitChatGPTCompletion)("])
    .filter((module) => new RegExp(lockPattern, "u").test(moduleSource(source, module)));
  if (followers.length !== 1) throw new Error(`Expected one native ChatGPT follow-up module, found ${followers.length}`);
  const follow = followers[0];
  const followText = moduleSource(source, follow);
  const lock = uniqueMatch(followText, lockPattern, "ChatGPT native submission locks");
  const sendCall = uniqueMatch(followText,
    `await \\(0,(${IDENT})\\.submitChatGPTCompletion\\)\\(${escapeRegExp(lock[2])},\\{[^{}]*model:` +
      `${escapeRegExp(lock[9])}\\.slug,[^{}]*thinkingEffort:${escapeRegExp(lock[9])}\\.thinkingEffort,`,
    "ChatGPT native submission call");
  const sendId = requiredModuleId(source, follow, sendCall[1]);
  const sendModule = modules.find((module) => module.id === sendId);
  if (sendModule == null) throw new Error("ChatGPT submission module is not part of the Quick Chat runtime chunk");
  const sendText = moduleSource(source, sendModule);
  const exported = uniqueMatch(sendText, `[{,]submitChatGPTCompletion:\\(\\)=>(${IDENT})[,}]`,
    "ChatGPT submission export")[1];
  const send = namedFunction(source, exported, sendModule.start, sendModule.end);
  if (!send.source.includes("Lockdown mode blocks connector approvals") ||
      !send.source.includes("extraDeveloperInstructions:") || !send.source.includes("messageMetadata:") ||
      !send.source.includes("requireResponseAcceptance:") || !send.source.includes("isRequestCurrent:")) {
    throw new Error("ChatGPT submission context contract drifted");
  }
  const blocked = uniqueMatch(send.source, `!${IDENT}&&${IDENT}\\.get\\((${MEMBER})\\)\\)throw new `,
    "ChatGPT submission guard")[1];
  const dispatch = containingFunction(source, "gizmoEditor??", sendModule.start, sendModule.end);
  if (!/\.isEventStream&&[A-Za-z_$][\w$]*\.requireResponseAcceptance[^;]{0,100}\?\.resolve\(null\)/u.test(dispatch.source)) {
    throw new Error("ChatGPT response acceptance contract drifted");
  }
  const reference = (member) => memberReference(source, follow, member, modules);
  return { sendModule, dispatch, send: `${RUNTIME_REQUIRE}(${JSON.stringify(sendId)}).submitChatGPTCompletion`,
    blocked: memberReference(source, sendModule, blocked, modules), status: reference(lock[3]), busy: reference(lock[6]),
    submitting: reference(lock[7]), stopping: reference(lock[8]), model: reference(lock[10]) };
}

function runtimeContract(source) {
  const modules = chunkModules(source);
  const quick = quickChatContract(source, modules);
  const native = nativeSubmissionContract(source, modules);
  const requireName = assertRequireVisible(source, quick.module);
  if (declaresTopLevel(topLevelSkeleton(source, native.sendModule), "codexLinuxQuickChatTraceCallback")) {
    throw new Error("Native sender already declares the trace helper");
  }
  const bindings = { capability: quick.capability, blocked: native.blocked, account: quick.account,
    session: quick.session, host: quick.host,
    create: `(scope,options)=>(${CREATE_SESSION}(scope,options),scope.get(${quick.session}).conversationId)`,
    show: quick.show, context: quick.context, send: native.send, model: native.model, status: native.status,
    busy: native.busy, submitting: native.submitting, stopping: native.stopping };
  const prelude = `var ${RUNTIME_REQUIRE}=${requireName};const ${CREATE_SESSION}=${quick.createSource};`;
  return { modules, quick: quick.module, sendModule: native.sendModule, dispatch: native.dispatch, bindings, prelude };
}

function runtimeSource(bindings, prelude = "") {
  return `\n/*${RUNTIME_MARKER}*/${prelude}
${traceRuntimeSource()}
const codexLinuxSelectedTextQuickChatQueues = new WeakMap();
const codexLinuxSelectedTextQuickChatVisibilityStates = new WeakMap();
function ${DIAGNOSTICS_EXPORT}(scope, state, logger) {
  const signature = JSON.stringify(state);
  if (codexLinuxSelectedTextQuickChatVisibilityStates.get(scope) === signature) return;
  codexLinuxSelectedTextQuickChatVisibilityStates.set(scope, signature);
  logger.info("[ui-tweaks] selected-text More details visibility", {safe:state, sensitive:{}});
}
function ${BINDINGS_EXPORT}() {
  return {capability:${bindings.capability}, blocked:${bindings.blocked}, account:${bindings.account},
    session:${bindings.session}, host:${bindings.host}, create:${bindings.create}, show:${bindings.show},
    context:${bindings.context}, send:${bindings.send}, model:${bindings.model}, status:${bindings.status}, busy:${bindings.busy},
    submitting:${bindings.submitting}, stopping:${bindings.stopping}};
}
function ${AVAILABLE_EXPORT}(scope, sourceConversationId, logger = console) {
  const bindings = ${BINDINGS_EXPORT}();
  const capability = scope.get(bindings.capability, {name:"chatgpt.quick-chat"}) ?? {};
  const account = scope.get(bindings.account), blocked = scope.get(bindings.blocked);
  ${DIAGNOSTICS_EXPORT}(scope, {sourceConversationId:sourceConversationId != null, account:account != null,
    capable:capability.isCapable === true, loading:capability.isLoading === true, blocked:!!blocked}, logger);
  return sourceConversationId != null && account != null && capability.isCapable === true &&
    capability.isLoading !== true && !blocked;
}
function ${OPEN_EXPORT}(scope, input) {
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
${REGISTRY}={available:${AVAILABLE_EXPORT},open:${OPEN_EXPORT},traceFor:codexLinuxQuickChatTraceFor};
`;
}

// --- selected-text overlay contract -----------------------------------------

const OVERLAY_NEEDLES = ["onAddResponseTextAnnotation:", "targetContainerRefs:", "{actions:", "canOpenSideChat:"];
const TOOLBAR_NEEDLE = 'id:"selectedTextOverlay.moreDetails"';

// rspack may duplicate the overlay module into several lazy chunks, each
// copy minified independently. `toolbarCopies(id)` returns every copy of a
// module from all provided chunks.
function overlayContract(source, modules, toolbarCopies) {
  const candidates = modulesContaining(source, modules, OVERLAY_NEEDLES);
  if (candidates.length !== 1) throw new Error(`Expected one Codex selected-text overlay module, found ${candidates.length}`);
  const module = candidates[0];
  const text = moduleSource(source, module);
  const leafHeader = uniqueMatch(text,
    `function (${IDENT})\\(${IDENT}\\)\\{let (?:${IDENT},)*(${IDENT})=\\(0,${IDENT}\\.c\\)\\((\\d+)\\),` +
      `\\{onAddResponseTextAnnotation:(${IDENT}),onOpenSideChat:(${IDENT}),targetContainerRefs:${IDENT},` +
      `targetSelector:${IDENT}\\}=${IDENT},(${IDENT})=\\(0,${MEMBER}\\)\\(\\);`,
    "Codex selected-text overlay");
  const leaf = functionAt(source, module.start + leafHeader.index);
  const parentHeader = uniqueMatch(text,
    `function (${IDENT})\\(${IDENT}\\)\\{let (?:${IDENT},)*(${IDENT})=\\(0,${IDENT}\\.c\\)\\((\\d+)\\),` +
      `\\{actions:${IDENT},canOpenSideChat:${IDENT},scopeToThread:${IDENT},targetSelector:${IDENT}\\}=${IDENT},` +
      `(${IDENT})=\\(0,${MEMBER}\\)\\(${MEMBER}\\)[,;]`,
    "Codex overlay scope");
  const parent = functionAt(source, module.start + parentHeader.index);
  const parentCache = escapeRegExp(parentHeader[2]);
  const scope = escapeRegExp(parentHeader[4]);
  const sourceId = uniqueMatch(parent.source,
    `${parentCache}\\[2\\]!==${scope}\\?\\((${IDENT})=\\(0,${MEMBER}\\)\\(${scope}\\),${parentCache}\\[2\\]=${scope},` +
      `${parentCache}\\[3\\]=\\1\\):\\1=${parentCache}\\[3\\];let (${IDENT})=\\1[,;]`,
    "Codex source conversation getter")[2];
  const leafJsx = uniqueMatch(parent.source,
    `((?:${parentCache}\\[\\d+\\]!==${IDENT}\\|\\|)*${parentCache}\\[\\d+\\]!==${IDENT})\\?\\((${IDENT})=` +
      `\\(0,${MEMBER}\\)\\(${escapeRegExp(leafHeader[1])},\\{onAddResponseTextAnnotation:${IDENT},` +
      `onOpenSideChat:${IDENT},targetContainerRefs:${IDENT},targetSelector:${IDENT}\\}\\),` +
      `((?:${parentCache}\\[\\d+\\]=${IDENT},)+)${parentCache}\\[\\d+\\]=\\2\\)`,
    "Codex overlay leaf render");
  const parentReturn = uniqueMatch(parent.source, `;return ${parentCache}\\[\\d+\\]!==`, "overlay parent return");
  const leafCache = escapeRegExp(leafHeader[2]);
  const add = escapeRegExp(leafHeader[4]);
  const side = escapeRegExp(leafHeader[5]);
  const zoom = escapeRegExp(leafHeader[6]);
  const leafGuard = uniqueMatch(leaf.source, `return null==${add}&&null==${side}\\?null:`, "overlay leaf guard");
  const leafDependencies = uniqueMatch(leaf.source,
    `${leafCache}\\[0\\]!==${add}\\|\\|${leafCache}\\[1\\]!==${side}\\|\\|${leafCache}\\[2\\]!==${zoom}\\?`,
    "overlay leaf memo dependencies");
  const leafAssignments = uniqueMatch(leaf.source,
    `${leafCache}\\[0\\]=${add},${leafCache}\\[1\\]=${side},${leafCache}\\[2\\]=${zoom},`,
    "overlay leaf memo assignments");
  const selection = uniqueMatch(leaf.source,
    `let\\{portalTarget:${IDENT},rect:${IDENT},selectedText:(${IDENT}),selectionRange:${IDENT},target:(${IDENT})\\}=`,
    "Codex selection text and source target");
  const toolbar = uniqueMatch(leaf.source,
    `\\(0,${MEMBER}\\)\\((${IDENT})\\.(${IDENT}),\\{selectedText:${escapeRegExp(selection[1])},onAddSelectedText:`,
    "selected-text toolbar render");

  // The toolbar renders the upstream onMoreDetails action. Its owner module
  // localizes that action, and the overlay requires it at module evaluation,
  // so the same localization hook is available to the overlay module.
  // The toolbar renders the upstream onMoreDetails action and localizes it.
  // The overlay requires the toolbar module, which requires its localization
  // module, at module evaluation; requiring the latter at the end of the
  // overlay factory therefore never loads anything new.
  const toolbarId = requiredModuleId(source, module, toolbar[1]);
  const copies = toolbarCopies(toolbarId);
  if (copies.length === 0) throw new Error("Selected-text toolbar module is missing");
  const intlIds = new Set();
  for (const copy of copies) {
    const ownerText = moduleSource(copy.source, copy.module);
    if (!ownerText.includes(TOOLBAR_NEEDLE) || !/[{,]onMoreDetails:/u.test(ownerText)) {
      throw new Error("Selected-text toolbar no longer offers More details");
    }
    if (!new RegExp(`[{,]${escapeRegExp(toolbar[2])}:\\(\\)=>`, "u").test(ownerText)) {
      throw new Error("Selected-text toolbar export drifted");
    }
    const hook = uniqueMatch(ownerText,
      `(${IDENT})=\\(0,(${IDENT})\\.(${IDENT})\\)\\(\\)[\\s\\S]{0,1800}?\\1\\.formatMessage\\(\\{id:"selectedTextOverlay\\.`,
      "selected-text localization hook");
    intlIds.add(`${requiredModuleId(copy.source, copy.module, hook[2])}\u0000${hook[3]}`);
  }
  if (intlIds.size !== 1) throw new Error("Selected-text toolbar copies disagree on localization");
  const [intlId, intlExport] = [...intlIds][0].split("\u0000");
  return { module, requireName: assertRequireVisible(source, module), parent, leaf,
    parentCacheName: parentHeader[2], parentCacheSize: Number(parentHeader[3]), scope: parentHeader[4], sourceId,
    leafName: leafHeader[1], leafCacheName: leafHeader[2], leafCacheSize: Number(leafHeader[3]),
    leafJsx, parentReturn, leafGuard, leafDependencies, leafAssignments, target: selection[2],
    selectedText: selection[1], intl: `${OVERLAY_INTL}.${intlExport}`, intlId };
}

function overlayEdits(source, contract) {
  if (contract.parentCacheSize !== PARENT_CACHE_SIZE || contract.leafCacheSize !== LEAF_CACHE_SIZE) {
    throw new Error("Selected-text overlay memo cache drifted");
  }
  const cache = contract.parentCacheName;
  const leafCache = contract.leafCacheName;
  const { scope, sourceId } = contract;
  const edits = [];
  const at = (owner, offset) => owner.start + offset;
  const insert = (index, text) => edits.push({ start: index, end: index, text: span(text) });
  const replace = (index, original, text) =>
    edits.push({ start: index, end: index + original.length, text: replacementSpan(original, text) });

  const parentCacheSize = `.c)(${PARENT_CACHE_SIZE})`;
  replace(at(contract.parent, contract.parent.source.indexOf(parentCacheSize) + 4), String(PARENT_CACHE_SIZE),
    String(PARENT_CACHE_SIZE + 6));
  const setup = `/*${OVERLAY_MARKER}*/let codexLinuxIntl=(0,${contract.intl})(),` +
    `codexLinuxPrompt=codexLinuxIntl.formatMessage({id:"selectedTextOverlay.quickChatPrompt",` +
    `defaultMessage:"Tell me more about this",description:"Prompt sent to Quick Chat for selected response text"}),` +
    `codexLinuxTargetedReplyLabel=codexLinuxIntl.formatMessage({id:"selectedTextOverlay.targetedReplyLabel",` +
    `defaultMessage:"Selected text",description:"Label for selected response text sent to Quick Chat"}),codexLinuxMoreDetails;` +
    `${cache}[18]!==${scope}||${cache}[19]!==${sourceId}||${cache}[20]!==codexLinuxPrompt||` +
    `${cache}[21]!==codexLinuxTargetedReplyLabel?(codexLinuxMoreDetails=${ACTION_HELPER}(${scope},${sourceId},` +
    `codexLinuxPrompt,codexLinuxTargetedReplyLabel),${cache}[18]=${scope},${cache}[19]=${sourceId},` +
    `${cache}[20]=codexLinuxPrompt,${cache}[21]=codexLinuxTargetedReplyLabel,${cache}[22]=codexLinuxMoreDetails):` +
    `codexLinuxMoreDetails=${cache}[22];`;
  insert(at(contract.parent, contract.parentReturn.index + 1), setup);
  const jsx = contract.leafJsx;
  insert(at(contract.parent, jsx.index + jsx[1].length), `||${cache}[23]!==codexLinuxMoreDetails`);
  const leafProps = jsx[0].indexOf("{onAddResponseTextAnnotation:") + 1;
  insert(at(contract.parent, jsx.index + leafProps), "onMoreDetails:codexLinuxMoreDetails,");
  const assignments = jsx[0].lastIndexOf(jsx[3]) + jsx[3].length;
  insert(at(contract.parent, jsx.index + assignments), `${cache}[23]=codexLinuxMoreDetails,`);

  const leafCacheSize = `.c)(${LEAF_CACHE_SIZE})`;
  replace(at(contract.leaf, contract.leaf.source.indexOf(leafCacheSize) + 4), String(LEAF_CACHE_SIZE),
    String(LEAF_CACHE_SIZE + 1));
  const leafProp = contract.leaf.source.indexOf(",onOpenSideChat:");
  insert(at(contract.leaf, leafProp + 1), "onMoreDetails:codexLinuxMoreDetails,");
  const guard = contract.leafGuard;
  insert(at(contract.leaf, guard.index + guard[0].length - "?null:".length), "&&null==codexLinuxMoreDetails");
  const dependencies = contract.leafDependencies;
  insert(at(contract.leaf, dependencies.index + dependencies[0].length - 1), `||${leafCache}[8]!==codexLinuxMoreDetails`);
  insert(at(contract.leaf, contract.leafAssignments.index), `${leafCache}[8]=codexLinuxMoreDetails,`);
  const toolbar = contract.leaf.source.indexOf(`{selectedText:${contract.selectedText},onAddSelectedText:`) +
    `{selectedText:${contract.selectedText},`.length;
  insert(at(contract.leaf, toolbar), `onMoreDetails:null!=codexLinuxMoreDetails&&codexLinuxMoreDetails.available()?` +
    `codexLinuxSelection=>codexLinuxMoreDetails.open(codexLinuxSelection,${contract.target}.innerText):void 0,`);

  insert(contract.module.bodyEnd, `;var ${OVERLAY_INTL}=${contract.requireName}(${JSON.stringify(contract.intlId)});` +
    `function ${ACTION_HELPER}(scope,sourceConversationId,prompt,targetedReplyLabel){` +
    `const runtime=()=>${REGISTRY};` +
    `return{available(){try{return runtime()?.available?.(scope,sourceConversationId,console)===!0}catch(error){` +
    `console.error("[ui-tweaks] selected-text More details availability failed",error);return!1}},` +
    `open(selectedText,selectedMessageText){const current=runtime();if(current?.open==null)return;` +
    `Promise.resolve().then(()=>current.open(scope,{sourceConversationId,selectedText,selectedMessageText,` +
    `logger:console,prompt,targetedReplyLabel})).catch(error=>console.error(` +
    `"[ui-tweaks] selected-text More details failed",error))}}}`);
  return edits;
}

function applyEdits(source, edits) {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].end > ordered[index].start) throw new Error("Overlapping selected-text edits");
  }
  let result = source;
  for (const edit of ordered.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function validateJavaScriptModuleSyntax(source, label) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 60_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} JavaScript syntax validation failed: ${result.error?.message ??
      `parser exited ${result.status} (${result.signal ?? "no signal"})`}`);
  }
}

// Patches the upstream runtime and overlay chunk sources (which may be the
// same chunk). Both inputs must be unpatched upstream bytes.
function moduleCopies(chunks, id) {
  const copies = [];
  for (const source of chunks) {
    for (const module of chunkModules(source)) if (module.id === id) copies.push({ source, module });
  }
  return copies;
}

// Patches unpatched upstream chunks: { [assetName]: source }. `references`
// are further chunk sources that may hold the toolbar module.
function patchUpstream(chunks, references = []) {
  const names = Object.keys(chunks).sort();
  for (const name of names) {
    if (hasPatchSpans(chunks[name]) || /codexLinux(?:SelectedText|QuickChat|MoreDetails)/u.test(chunks[name])) {
      throw new Error("Mixed selected-text Quick Chat input");
    }
  }
  const parsed = new Map(names.map((name) => [name, chunkModules(chunks[name])]));
  const runtimeNames = names.filter((name) =>
    modulesContaining(chunks[name], parsed.get(name), ["has-opened-quick-chat-v1"]).length > 0);
  if (runtimeNames.length !== 1) throw new Error(`Expected one Quick Chat runtime chunk, found ${runtimeNames.length}`);
  const overlayNames = names.filter((name) =>
    modulesContaining(chunks[name], parsed.get(name), OVERLAY_NEEDLES).length > 0);
  if (overlayNames.length === 0) throw new Error("Expected a selected-text overlay chunk, found 0");
  const edits = new Map(names.map((name) => [name, []]));
  const runtimeName = runtimeNames[0];
  const runtimeChunk = chunks[runtimeName];
  const contract = runtimeContract(runtimeChunk);
  const trace = patchNativeSenderTrace(contract.dispatch, span);
  if (trace.applied) throw new Error("Mixed native sender trace");
  edits.get(runtimeName).push(
    { start: contract.dispatch.start, end: contract.dispatch.end, text: trace.source },
    { start: contract.sendModule.bodyEnd, end: contract.sendModule.bodyEnd, text: span(nativeTraceHelperSource()) },
    { start: contract.quick.bodyEnd, end: contract.quick.bodyEnd, text: span(runtimeSource(contract.bindings, contract.prelude)) },
  );
  const allChunks = [...names.map((name) => chunks[name]), ...references];
  const overlayIds = new Set();
  for (const name of overlayNames) {
    const contractForCopy = overlayContract(chunks[name], parsed.get(name), (id) => moduleCopies(allChunks, id));
    overlayIds.add(contractForCopy.module.id);
    edits.get(name).push(...overlayEdits(chunks[name], contractForCopy));
  }
  if (overlayIds.size !== 1) throw new Error("Selected-text overlay copies are different modules");
  return Object.fromEntries(names.map((name) => [name, applyEdits(chunks[name], edits.get(name))]));
}

// Returns { chunks: { [assetName]: patched }, applied }. A chunk that already
// carries edits is restored to upstream bytes and must re-patch identically.
function patchSources(chunks, references = []) {
  const names = Object.keys(chunks).sort();
  const marked = names.some((name) => hasPatchSpans(chunks[name]));
  const upstream = marked
    ? Object.fromEntries(names.map((name) => [name, restoreUpstream(chunks[name])]))
    : chunks;
  const patched = patchUpstream(upstream, references.map((source) => restoreUpstream(source)));
  if (marked && names.some((name) => patched[name] !== chunks[name])) {
    throw new Error("Incomplete or drifted selected-text Quick Chat patch");
  }
  for (const name of names) {
    if (patched[name] !== upstream[name]) validateJavaScriptModuleSyntax(patched[name], `selected-text ${name}`);
  }
  return { chunks: patched, applied: marked };
}

function listScriptAssets(extractedDir) {
  return require("../../../scripts/patches/lib/assets.js").listWebviewScriptAssets(extractedDir);
}

function applySelectedTextMoreDetails(extractedDir, context = {}) {
  if (!enabled(context)) return { matched: 0, changed: 0 };
  try {
    const assets = path.join(extractedDir, "webview", "assets");
    const targets = {};
    const references = [];
    for (const name of listScriptAssets(extractedDir)) {
      const source = fs.readFileSync(path.join(assets, name), "utf8");
      if (source.includes("has-opened-quick-chat-v1") || OVERLAY_NEEDLES.every((needle) => source.includes(needle))) {
        targets[name] = source;
      } else if (source.includes(TOOLBAR_NEEDLE) && source.includes("onMoreDetails:")) {
        references.push(source);
      }
    }
    const result = patchSources(targets, references);
    const changed = Object.keys(targets).filter((name) => result.chunks[name] !== targets[name]);
    if (result.applied && changed.length > 0) throw new Error("Unexpected selected-text re-patch");
    for (const name of changed) fs.writeFileSync(path.join(assets, name), result.chunks[name]);
    const patchedNames = Object.keys(targets).filter((name) => hasPatchSpans(result.chunks[name])).sort();
    return { matched: patchedNames.length, changed: changed.length,
      targets: patchedNames.map((name) => path.join("webview", "assets", name)) };
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
  status: (result, warnings) => !(result?.matched >= 2)
    ? { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null }
    : result.changed > 0 ? "applied" : "already-applied",
}];

module.exports = { RUNTIME_MARKER, OVERLAY_MARKER, BINDINGS_EXPORT, OPEN_EXPORT, AVAILABLE_EXPORT, DIAGNOSTICS_EXPORT,
  ACTION_HELPER, REGISTRY_KEY, NATIVE_TRACE_HELPER_MARKER, enabled, chunkModules, restoreUpstream, runtimeContract,
  overlayContract, runtimeSource, patchUpstream, patchSources, applySelectedTextMoreDetails, descriptors };
