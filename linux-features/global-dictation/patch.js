"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { createJavaScriptLexicalIndex, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");

const PATCH_MARKER = "codex-linux-global-dictation-v3";
const {
  installPortalBackend,
  inspectGlobalShortcutsPortal,
  portalOwnerFailureReason,
  literal,
  platformIs,
} = require("../../scripts/patches/lib/global-shortcuts-portal.js");
const IDENT = "[A-Za-z_$][\\w$]*";

function warn(message) {
  console.warn(`WARN: ${message} - skipping Linux global dictation patch`);
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codexLinuxGlobalDictationReleaseWatcher(accelerator, onReleased) {
  const helperPath = codexLinuxGlobalShortcutsNativePath("global-dictation-release-monitor");
  if (helperPath == null) return null;
  const child = require("node:child_process").spawn(helperPath, ["--accelerator", accelerator], {
    stdio: "ignore",
    windowsHide: true,
  });
  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    if (error != null) {
      console.warn("[linux-global-dictation] Hotkey release watcher failed", error);
    }
    onReleased();
  };
  child.once("error", finish);
  child.once("exit", () => finish());
  return {
    get isActive() {
      return !finished;
    },
    dispose: () => {
      finished = true;
      child.kill();
    },
  };
}

function codexLinuxGlobalDictationClipboard(controller, bridge, text, stoppedAt, fingerprint, signal) {
  if (process.platform !== "linux") return bridge(text, stoppedAt, fingerprint, signal);
  const previous = codexLinuxGlobalDictationClipboardQueues.get(controller) ?? Promise.resolve();
  const task = previous.then(() => bridge(text, stoppedAt, fingerprint, signal));
  const settled = task.then(() => undefined, () => undefined);
  codexLinuxGlobalDictationClipboardQueues.set(controller, settled);
  settled.then(() => {
    if (codexLinuxGlobalDictationClipboardQueues.get(controller) === settled) {
      codexLinuxGlobalDictationClipboardQueues.delete(controller);
    }
  });
  return task;
}

function codexLinuxGlobalDictationPasteX11(signal) {
  return new Promise((resolve, reject) => {
    try {
      signal?.throwIfAborted();
      require("node:child_process").execFile(
        "xdotool",
        ["key", "--clearmodifiers", "ctrl+v"],
        { windowsHide: true },
        (error) => {
          if (error) {
            reject(error);
            return;
          }
          try {
            signal?.throwIfAborted();
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function helperSource() {
  return [
    `var codexLinuxGlobalDictationPatch=${JSON.stringify(PATCH_MARKER)},codexLinuxGlobalDictationClipboardQueues=new WeakMap;`,
    codexLinuxGlobalDictationReleaseWatcher,
    codexLinuxGlobalDictationClipboard,
    codexLinuxGlobalDictationPasteX11,
  ].map(String).join("");
}

const UNSUPPORTED_RELEASE_WATCHING = "Global dictation hotkey release watching is not supported.";
const UNSUPPORTED_PASTE = "Global dictation paste is not supported on this OS.";

// A switch-case label run such as case"win32":case"aix":...case"linux":...
// that ends in the upstream "not supported" throw.
function unsupportedPlatformCases(message) {
  const label = `case(?:"[a-z0-9]+"|\`[a-z0-9]+\`):`;
  return new RegExp(
    `(?<before>(?:${label})*)case${literal("linux")}:(?<after>(?:${label})*)throw Error\\(${literal(message)}\\)`,
    "u",
  );
}



function codeAt(body, index) {
  return findMatchingBrace("{" + body.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}
function rootAt(body, index) {
  return findMatchingBrace("{" + body.slice(0, index) + "}", 0) === index + 1;
}
function scopedMatches(body, pattern, root = true) {
  return [...body.matchAll(pattern)].filter(match => codeAt(body, match.index) && (!root || rootAt(body, match.index)));
}
function one(values, description) {
  if (values.length !== 1) throw new Error(`${description} matched ${values.length} times`);
  return values[0];
}
function evaluatedAt(body, index) {
  if (!codeAt(body, index) || !rootAt(body, index)) return false;
  let prefix = body.slice(0, index);
  for (const returned of scopedMatches(prefix, /\breturn\b/gu)) {
    try { new Script(`async function probe(){\n${prefix.slice(0, returned.index)}\nconst beforeReturn=0;\n}`); return false; }
    catch { /* A conditional native exit does not make later code dead. */ }
  }
  if (prefix.endsWith(",")) prefix = prefix.slice(0, -1) + ";";
  try { new Script(`async function probe(){\n${prefix}\nconst evaluated=0;\n}`); return true; }
  catch { return false; }
}
function declarationAt(body, index) {
  if (!codeAt(body, index) || !rootAt(body, index)) return false;
  try { new Script(body.slice(0, index) + "\nconst declaration=0;\n"); return true; }
  catch { return false; }
}
function range(source, start, open, description) {
  const close = findMatchingBrace(source, open);
  if (close < open) throw new Error(`${description} is incomplete`);
  return { start, end: close + 1, bodyStart: open + 1, bodyEnd: close, text: source.slice(start, close + 1), body: source.slice(open + 1, close) };
}

const NATIVE_METHOD_NAMES = new Set([
  "constructor", "registerHotkeyOrThrow", "registerToggleHotkeyOrThrow", "unregisterHotkey",
  "ensureHotkeyReleaseWatchers", "handleTranscript", "updateEscapeRegistration",
]);

function classTrivia(scope, start) {
  let index = start;
  for (;;) {
    while (/\s/u.test(scope.text[index] ?? "") && index < scope.text.length) index++;
    if (scope.text.startsWith("/*", index)) {
      const close = scope.text.indexOf("*/", index + 2);
      if (close < 0) throw new Error("Incomplete dictation class member comment");
      index = close + 2;
    } else if (scope.text.startsWith("//", index)) {
      const line = scope.text.slice(index + 2).search(/[\r\n\u2028\u2029]/u);
      index = line < 0 ? scope.text.length : index + 2 + line;
    } else return index;
  }
}

function classDelimiterEnd(scope, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" }, stack = [];
  for (let index = open; index < scope.text.length; index++) {
    if (!scope.lexical.isCode(index)) continue;
    const character = scope.text[index];
    if (pairs[character]) stack.push(pairs[character]);
    else if (")]}".includes(character)) {
      if (stack.pop() !== character) throw new Error("Unbalanced dictation class member");
      if (stack.length === 0) return index;
    }
  }
  throw new Error("Incomplete dictation class member");
}

function classQuotedKey(scope, start) {
  const quote = scope.text[start];
  let end = start + 1;
  for (; end < scope.text.length; end++) {
    if (scope.text[end] === "\\") end++;
    else if (quote === "`" && scope.text.startsWith("${", end)) throw new Error("Unproven interpolated dictation class key");
    else if (scope.text[end] === quote) break;
  }
  if (end >= scope.text.length) throw new Error("Incomplete dictation class key");
  const escapes = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", 0: "\0" };
  const name = scope.text.slice(start + 1, end).replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/gu,
    (_, braced, fixed, hex, escaped) => {
      if (braced || fixed || hex) return String.fromCodePoint(parseInt(braced || fixed || hex, 16));
      if (/^[\r\n\u2028\u2029]/u.test(escaped)) return "";
      return escapes[escaped] ?? escaped;
    });
  return { name, end: end + 1 };
}

function classMemberKey(scope, start) {
  let index = start;
  const privateKey = scope.text[index] === "#";
  if (privateKey) index++;
  if (scope.text[index] === "[") {
    const close = classDelimiterEnd(scope, index), literalStart = classTrivia(scope, index + 1);
    if (!['"', "'", "`"].includes(scope.text[literalStart])) throw new Error("Unproven computed dictation class key");
    const key = classQuotedKey(scope, literalStart);
    if (classTrivia(scope, key.end) !== close) throw new Error("Unproven computed dictation class expression");
    return { name: key.name, end: close + 1, privateKey };
  }
  if (['"', "'"].includes(scope.text[index])) return { ...classQuotedKey(scope, index), privateKey };
  const identifier = /^(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[A-Za-z_$])(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])*/u.exec(scope.text.slice(index));
  if (!identifier) throw new Error("Unsupported dictation class key");
  const name = identifier[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu,
    (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16)));
  return { name, end: index + identifier[0].length, privateKey };
}

function assertClassFieldBoundary(scope, equals, end) {
  if (scope.text[equals] !== "=") return;
  const bounded = scope.text.slice(0, equals + 1) + "(" + scope.text.slice(equals + 1, end) + "\n)" + scope.text.slice(end);
  try { new Script("class DictationFieldBoundaryProbe extends Object{" + bounded + "}"); }
  catch { throw new Error("Dictation class field initializer has an unproven ASI boundary"); }
}

function classMemberDefinitions(controller) {
  const scope = { text: controller.body, lexical: createJavaScriptLexicalIndex(controller.body) };
  const members = [], modifiers = new Set(["static", "async", "get", "set"]);
  let index = 0;
  while ((index = classTrivia(scope, index)) < scope.text.length) {
    if (scope.text[index] === ";") { index++; continue; }
    const kinds = [];
    if (scope.text[index] === "*") { kinds.push("generator"); index = classTrivia(scope, index + 1); }
    let key = classMemberKey(scope, index), next = classTrivia(scope, key.end);
    while (!key.privateKey && modifiers.has(key.name) && !["(", "=", ";", undefined].includes(scope.text[next])) {
      kinds.push(key.name);
      index = next;
      if (scope.text[index] === "*") { kinds.push("generator"); index = classTrivia(scope, index + 1); }
      key = classMemberKey(scope, index);
      next = classTrivia(scope, key.end);
    }
    if (scope.text[next] === "(") {
      const parametersEnd = classDelimiterEnd(scope, next), open = classTrivia(scope, parametersEnd + 1);
      if (scope.text[open] !== "{") throw new Error("Missing dictation class method body");
      const close = scope.lexical.matchingBrace(open);
      if (close <= open) throw new Error("Incomplete dictation class method body");
      members.push({ ...key, kinds, kind: "method", bodyStart: controller.bodyStart + open + 1 });
      index = close + 1;
    } else {
      if (!["=", ";", undefined].includes(scope.text[next])) throw new Error("Unsupported dictation class field");
      members.push({ ...key, kinds, kind: "field" });
      index = next;
      while (index < scope.text.length) {
        if (scope.lexical.isCode(index) && scope.text[index] === ";") break;
        if (scope.lexical.isCode(index) && "([{".includes(scope.text[index])) index = classDelimiterEnd(scope, index);
        index++;
      }
      assertClassFieldBoundary(scope, next, index);
      index++;
    }
  }
  return members;
}

function classMethod(controller, name) {
  const trivia = "(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r?\\n|$))";
  const separator = `(?:${trivia}+|(?=\\*))`;
  let effective;
  if (NATIVE_METHOD_NAMES.has(name)) {
    controller.memberDefinitions ??= classMemberDefinitions(controller);
    effective = one(controller.memberDefinitions.filter(member => member.name === name && !member.privateKey && !member.kinds.includes("static")), `effective dictation instance member ${name}`);
    if (effective.kind !== "method") throw new Error(`Dictation own field shadows native method ${name}`);
  }
  const head = one(scopedMatches(controller.body, new RegExp(`(?<![\\w$.])(?:(static|get|set)${separator})?(?:(async)${separator})?(\\*${trivia}*)?${escapeRegexLiteral(name)}\\(([^)]*)\\)\\{`, "gu"))
    .filter(candidate => !effective || controller.bodyStart + candidate.index + candidate[0].length === effective.bodyStart), `dictation controller ${name}`);
  if (head[1] || head[3] || Boolean(head[2]) !== (name === "handleTranscript")) throw new Error(`Dictation controller ${name} is not its native instance method kind`);
  const probeName = "#codexLinuxGlobalDictationMethodProbe";
  const nameStart = controller.bodyStart - controller.start + head.index + head[0].indexOf(`${name}(`);
  if (controller.text.includes(probeName)) throw new Error("Dictation controller method probe collides with native source");
  try {
    new Script(controller.text.slice(0, nameStart) + probeName + controller.text.slice(nameStart + name.length));
  } catch {
    throw new Error(`Dictation controller ${name} is not a native class member`);
  }
  const open = controller.bodyStart + head.index + head[0].length - 1;
  return { ...range(controller.source, controller.bodyStart + head.index, open, name), parameters: head[4] };
}
function assertReadOnlyReferences(body, name, authorizedIndex, description) {
  const references = scopedMatches(body, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(name)}(?![\\w$])`, "gu"), false);
  for (const reference of references) {
    if (reference.index === authorizedIndex) continue;
    const probe = body.slice(0, reference.index) + "(0)" + body.slice(reference.index + name.length);
    try { new Script(`async function bindingReferenceProbe(){\n${probe}\n}`); }
    catch { throw new Error(`${description} has a declaration or write outside its owned initialization`); }
  }
}
function factoryFunction(source, metadata, name, required = true) {
  const scope = metadata.owner.factoryBody, body = source.slice(scope.start, scope.end);
  const heads = scopedMatches(body, new RegExp(`(?<![\\w$.])(?:async )?function ${escapeRegexLiteral(name)}\\(([^()]*)\\)\\s*\\{`, "gu"))
    .filter(head => declarationAt(body, head.index));
  if (!required && heads.length === 0) return null;
  const head = one(heads, `dictation helper ${name}`), start = scope.start + head.index, open = start + head[0].length - 1;
  return { ...range(source, start, open, name), name, parameters: head[1] };
}
function plainCalls(body, root = true) {
  return [...new Set(scopedMatches(body, new RegExp(`(?<![\\w$.])(${IDENT})\\(`, "gu"), root).map(match => match[1]))];
}
function constructorOptions(body) {
  const fields = new Map(), commas = [];
  for (const comma of scopedMatches(body, /,/gu, false)) {
    try { new Script(`async function options(){return({\n${body.slice(0, comma.index)}\n});}`); commas.push(comma.index); }
    catch { /* This comma belongs to a nested argument or expression. */ }
  }
  let start = 0;
  for (const end of [...commas, body.length]) {
    const member = body.slice(start, end).trim(); start = end + 1;
    if (!member) continue;
    const field = new RegExp(`^(${IDENT})\\s*:\\s*([\\s\\S]+)$`, "u").exec(member);
    if (!field || fields.has(field[1])) throw new Error("Dictation constructor requires unique identifier-key options");
    fields.set(field[1], field[2].trim());
  }
  return fields;
}

function callArguments(body, open) {
  const lexical = createJavaScriptLexicalIndex(body);
  if (body[open] !== "(" || !lexical.isCode(open)) throw new Error("Dictation call arguments are unavailable");
  const values = [];
  let parentheses = 1, braces = 0, brackets = 0, start = open + 1;
  for (let index = open + 1; index < body.length; index++) {
    if (!lexical.isCode(index)) continue;
    const character = body[index];
    if (character === "(") parentheses++;
    else if (character === ")") {
      parentheses--;
      if (parentheses === 0) {
        if (braces || brackets) throw new Error("Dictation call arguments are unbalanced");
        values.push(body.slice(start, index).trim());
        return { start: open, end: index + 1, body: body.slice(open + 1, index), values };
      }
    } else if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "," && parentheses === 1 && braces === 0 && brackets === 0) {
      values.push(body.slice(start, index).trim());
      start = index + 1;
    }
    if (braces < 0 || brackets < 0) throw new Error("Dictation call arguments escape their owner");
  }
  throw new Error("Dictation call arguments are incomplete");
}

function anonymousFunctions(source, scope, parameterCount, root) {
  const parameters = `${IDENT}(?:,${IDENT}){${parameterCount - 1}}`;
  const pattern = new RegExp(`(?<![\\w$.])async function\\((${parameters})\\)\\{`, "gu");
  return scopedMatches(scope.body, pattern, root).map(head => ({
    ...range(source, scope.bodyStart + head.index, scope.bodyStart + head.index + head[0].length - 1, "dictation anonymous function"),
    parameters: head[1], parameterNames: head[1].split(","),
  }));
}

function transcriptPlan(source, registration, method) {
  const bridge = one(anonymousFunctions(source, method, 4, true), "dictation four-argument clipboard IIFE");
  const [session, transcript] = method.parameters.split(",");
  if (!new RegExp(`^${IDENT}$`, "u").test(session ?? "") || !new RegExp(`^${IDENT}$`, "u").test(transcript ?? "")) {
    throw new Error("Dictation transcript method parameters changed");
  }
  const prefix = method.body.slice(0, bridge.start - method.bodyStart);
  const caller = new RegExp(
    `^let (?<stopped>${IDENT})=this\\.activeSession\\?\\.type===${literal("overlay")}\\?this\\.activeSession\\.recordingStoppedAtMs:void 0,` +
    `(?<fingerprint>${IDENT})=this\\.clipboardFingerprintAtStop,(?<text>${IDENT})=this\\.recordHistoryText\\(${escapeRegexLiteral(session)},${escapeRegexLiteral(transcript)}\\),` +
    `(?<abort>${IDENT})=new AbortController;if\\(null!=\\k<text>&&\\(this\\.pendingPasteSessionId=${escapeRegexLiteral(session)},this\\.pendingPasteAbort=\\k<abort>\\),` +
    `this\\.clearActiveSession\\(\\),this\\.showIdleOrHide\\(\\),null==\\k<text>\\)return;let (?<result>${IDENT})=await ` +
    `(?<wrapped>codexLinuxGlobalDictationClipboard\\(this,)?$`, "u").exec(prefix);
  if (!caller) throw new Error("Dictation clipboard caller/session/signal ownership changed");
  const roles = caller.groups;
  let invocation;
  if (roles.wrapped) {
    const wrapperStart = prefix.lastIndexOf("codexLinuxGlobalDictationClipboard(");
    const arguments_ = callArguments(method.body, wrapperStart + "codexLinuxGlobalDictationClipboard".length);
    if (arguments_.values.length !== 6 || arguments_.values[0] !== "this" || arguments_.values[1] !== bridge.text) {
      throw new Error("Dictation clipboard FIFO does not own its native controller/function");
    }
    const afterFunction = method.body.slice(bridge.end - method.bodyStart, arguments_.end);
    if (!afterFunction.startsWith(",") || !afterFunction.endsWith(")")) throw new Error("Dictation clipboard FIFO arguments changed");
    invocation = { start: method.bodyStart + wrapperStart, end: method.bodyStart + arguments_.end, arguments: arguments_.values.slice(2), argumentSource: afterFunction.slice(1, -1), wrapped: true };
  } else {
    const arguments_ = callArguments(method.body, bridge.end - method.bodyStart);
    invocation = { start: bridge.start, end: method.bodyStart + arguments_.end, arguments: arguments_.values, argumentSource: arguments_.body, wrapped: false };
  }
  const expectedText = "`" + "${" + roles.text + "} `";
  if (invocation.arguments.length !== 4 || invocation.arguments[0] !== expectedText || invocation.arguments[1] !== roles.stopped ||
      invocation.arguments[2] !== roles.fingerprint || invocation.arguments[3] !== `${roles.abort}.signal`) {
    throw new Error("Dictation native clipboard arguments changed");
  }
  const suffix = method.body.slice(invocation.end - method.bodyStart);
  const completion = new RegExp(
    `^;this\\.pendingPasteSessionId===${escapeRegexLiteral(session)}&&\\(null!=${escapeRegexLiteral(roles.result)}&&await this\\.windowController\\.showPasteFailure\\(${escapeRegexLiteral(roles.result)},` +
    `\\(\\)=>this\\.pendingPasteSessionId===${escapeRegexLiteral(session)}\\),this\\.pendingPasteSessionId===${escapeRegexLiteral(session)}&&` +
    `\\(this\\.pendingPasteAbort=null,this\\.pendingPasteSessionId=null,this\\.updateEscapeRegistration\\(\\)\\)\\)$`, "u");
  if (!completion.test(suffix)) throw new Error("Dictation native paste completion/session guard changed");

  const [text, , , signal] = bridge.parameterNames;
  if (!new RegExp(`^if\\(${escapeRegexLiteral(signal)}\\?\\.aborted\\)return null;`, "u").test(bridge.body)) {
    throw new Error("Dictation native clipboard abort guard changed");
  }
  const write = one(scopedMatches(bridge.body, new RegExp(`(?<![\\w$.])(${IDENT})\\.clipboard\\.writeText\\(${escapeRegexLiteral(text)}\\)`, "gu")), "dictation clipboard write");
  if (!registration.body.includes(`${write[1]}.globalShortcut`) || !evaluatedAt(bridge.body, write.index)) {
    throw new Error("Dictation clipboard write is outside its native Electron/evaluated owner");
  }
  const waits = scopedMatches(bridge.body, new RegExp(`\\(0,${IDENT}\\.setTimeout\\)\\((?:Math\\.max\\(0,150-${IDENT}\\)|700)\\)`, "gu"), false);
  if (waits.length !== 3 || !waits[0][0].includes("150-") || waits.slice(1).some(wait => !wait[0].endsWith("(700)"))) {
    throw new Error("Dictation native clipboard handoff/restore timing changed");
  }
  const paste = one(anonymousFunctions(source, bridge, 1, false).filter(candidate => candidate.body.includes(UNSUPPORTED_PASTE)), "dictation anonymous paste IIFE");
  const pasteArguments = callArguments(bridge.body, paste.end - bridge.bodyStart);
  if (pasteArguments.values.length !== 1 || pasteArguments.values[0] !== signal) throw new Error("Dictation paste IIFE lost the clipboard AbortSignal");
  const pastePrefix = bridge.body.slice(0, paste.start - bridge.bodyStart);
  const commit = new RegExp(`(?<committed>${IDENT})=!0,await $`, "u").exec(pastePrefix);
  const nativeTry = one(scopedMatches(bridge.body, /\btry\{/gu).filter(head => {
    const close = findMatchingBrace(bridge.body, head.index + head[0].length - 1);
    return head.index < paste.start - bridge.bodyStart && pasteArguments.end < close;
  }), "dictation clipboard paste try block");
  if (!commit || !evaluatedAt(bridge.body.slice(nativeTry.index + nativeTry[0].length), commit.index - nativeTry.index - nativeTry[0].length)) {
    throw new Error("Dictation paste IIFE is not its evaluated awaited commit");
  }
  if (!new RegExp(`^switch\\(${escapeRegexLiteral(paste.parameters)}\\?\\.throwIfAborted\\(\\),process\\.platform\\)\\{`, "u").test(paste.body)) {
    throw new Error("Dictation native paste signal/platform dispatch changed");
  }
  const accessibility = one(anonymousFunctions(source, paste, 1, false).filter(candidate => candidate.body.includes("AXUIElementPerformAction")), "dictation native macOS accessibility IIFE");
  const accessibilityArguments = callArguments(paste.body, accessibility.end - paste.bodyStart);
  if (accessibilityArguments.values.length !== 1 || accessibilityArguments.values[0] !== paste.parameters) {
    throw new Error("Dictation macOS accessibility IIFE lost its native signal");
  }
  return { bridge: { ...bridge, invocation }, paste, accessibility };
}

function dictationOwnerPlan(source, metadata) {
  if (!metadata.owner) throw new Error(metadata.reason || "Shared Portal owner is unavailable");
  const producerScope = metadata.owner.windowServices.body;
  const producer = source.slice(producerScope.start, producerScope.end), binding = metadata.owner.windowServices.bindings.globalDictationLifecycleManager;
  const construction = one(scopedMatches(producer, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(binding)}=new (${IDENT})\\(\\{`, "gu")), "returned global dictation controller construction");
  if (!evaluatedAt(producer, construction.index)) throw new Error("Dictation controller construction is not evaluated by its window producer");
  const optionsOpen = producerScope.start + construction.index + construction[0].length - 1, optionsClose = findMatchingBrace(source, optionsOpen);
  if (source[optionsClose + 1] !== ")") throw new Error("Dictation controller construction options are incomplete");
  const options = constructorOptions(source.slice(optionsOpen + 1, optionsClose));
  if (options.get("windowManager") !== metadata.owner.windowServices.bindings.windowManager || !options.has("globalState")) throw new Error("Dictation controller options are disconnected from native window/state owners");
  assertReadOnlyReferences(producer, binding, construction.index, "Returned dictation controller binding");
  const factory = metadata.owner.factoryBody, factoryBody = source.slice(factory.start, factory.end), name = construction[1];
  const constructorReferences = scopedMatches(producer, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(name)}(?![\\w$])`, "gu"));
  const producerHead = /function\(\{([^{}]*)\}\)\{$/u.exec(source.slice(0, producerScope.start));
  if (!producerHead || new RegExp(`(?<![\\w$])${escapeRegexLiteral(name)}(?![\\w$])`, "u").test(producerHead[1]) ||
      constructorReferences.length !== 1 || constructorReferences[0].index !== construction.index + construction[0].indexOf(name)) throw new Error("Dictation constructor is shadowed inside its window producer");
  const declaration = one(scopedMatches(factoryBody, new RegExp(`\\bclass ${escapeRegexLiteral(name)}\\{`, "gu"))
    .filter(head => declarationAt(factoryBody, head.index)), "live dictation controller declaration");
  assertReadOnlyReferences(factoryBody, name, declaration.index + "class ".length, "Native dictation controller class binding");
  const classReferences = scopedMatches(factoryBody, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(name)}(?![\\w$])`, "gu"), false);
  const expectedClassReferences = new Set([
    declaration.index + "class ".length,
    producerScope.start - factory.start + construction.index + construction[0].indexOf(name),
  ]);
  if (classReferences.length !== 2 || classReferences.some(reference => !expectedClassReferences.has(reference.index))) {
    throw new Error("Native dictation controller escapes its unique returned construction");
  }
  const classStart = factory.start + declaration.index, classOpen = classStart + declaration[0].length - 1;
  const controller = { ...range(source, classStart, classOpen, "dictation controller"), name, source };
  const methods = Object.fromEntries(["constructor", "registerHotkeyOrThrow", "registerToggleHotkeyOrThrow", "unregisterHotkey", "ensureHotkeyReleaseWatchers", "handleTranscript", "updateEscapeRegistration"]
    .map(method => [method, classMethod(controller, method)]));
  const register = metadata.owner.registration.name;
  const ownedCalls = {};
  for (const [method, gesture, key] of [["registerHotkeyOrThrow", "primary", "registeredHotkey"], ["registerToggleHotkeyOrThrow", "single-tap", "registeredToggleHotkey"]]) {
    const body = methods[method].body;
    const prefix = new RegExp(`let (${IDENT})=this\\.${key},(${IDENT})=${escapeRegexLiteral(register)}\\(`, "gu");
    const call = one(scopedMatches(body, prefix), `${gesture} live shortcut registration`);
    if (!evaluatedAt(body, call.index)) throw new Error(`${gesture} shortcut registration is not evaluated`);
    const calls = scopedMatches(body, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(register)}\\(`, "gu"), false);
    if (calls.length !== 1) throw new Error(`${gesture} shortcut registration is ambiguous`);
    const [accelerator, ownership] = methods[method].parameters.split(",");
    const id = gesture === "primary" ? "globalDictationHold" : "globalDictationSingleTap";
    const mode = gesture === "primary" ? "hold" : "toggle";
    const settings = gesture === "primary"
      ? `ownership:${escapeRegexLiteral(ownership)},bareModifierTrigger:${literal("cancellablePress")}`
      : `bareModifierTrigger:${literal("cancellablePress")},ownership:${escapeRegexLiteral(ownership)}`;
    const callback = new RegExp(`${escapeRegexLiteral(register)}\\(${escapeRegexLiteral(accelerator)},\\{(?:linuxCommandId:${literal(id)},)?` +
      `onRegistrationChanged:\\(\\)=>this\\.publishShortcutRecovery\\(\\),` +
      `onPressed:\\(\\)=>\\{this\\.setupWindowFocused\\|\\|\\(this\\.ensureHotkeyReleaseWatchers\\(\\),this\\.shortcutGestures\\.press\\(${literal(gesture)},${IDENT}\\(${escapeRegexLiteral(accelerator)}\\)\\|\\|${platformIs("win32")}&&${IDENT}\\(${escapeRegexLiteral(accelerator)}\\)\\)\\)\\},` +
      `onReleased:\\(\\)=>\\{this\\.setupWindowFocused\\|\\|this\\.shortcutGestures\\.release\\(${literal(gesture)}\\)\\},` +
      `onCancelled:\\(\\)=>\\{this\\.setupWindowFocused\\|\\|this\\.shortcutGestures\\.cancelPress\\(${literal(gesture)}\\)\\}` +
      `(?:,onUnavailable:n=>\\{this\\.handleLinuxHotkeyUnavailable\\(${literal(mode)},n\\)\\})?\\},\\{${settings}\\}\\)`, "gu");
    const nativeCall = one(scopedMatches(body, callback), `${gesture} native ownership/setup/gesture callbacks`);
    ownedCalls[gesture] = { ...methods[method], call: { start: methods[method].bodyStart + nativeCall.index, end: methods[method].bodyStart + nativeCall.index + nativeCall[0].length, text: nativeCall[0] } };
  }
  const classCalls = scopedMatches(controller.body, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(register)}\\(`, "gu"), false);
  const escapeCalls = scopedMatches(methods.updateEscapeRegistration.body, new RegExp(`${escapeRegexLiteral(register)}\\(${literal("Escape")},`, "gu"), false);
  if (classCalls.length !== 3 || escapeCalls.length !== 1 || methods.updateEscapeRegistration.text.includes("linuxCommandId:")) throw new Error("Dictation native Escape registration boundary changed");
  const nativeEscape = new RegExp(
    `^if\\(!this\\.shouldRegisterEscape\\(\\)\\)\\{this\\.escapeRegistration\\?\\.unregister\\(\\),this\\.escapeRegistration=null;return\\}` +
    `null==this\\.escapeRegistration&&null!=this\\.lifecycleLock&&\\(this\\.escapeRegistration=${escapeRegexLiteral(register)}\\(${literal("Escape")},` +
    `\\{onPressed:\\(\\)=>\\{this\\.shouldRegisterEscape\\(\\)&&\\(this\\.activeSession\\?\\.type!==${literal("inApp")}\\|\\|this\\.shortcutGestures\\.hasPendingStart\\?` +
    `this\\.shortcutGestures\\.cancel\\(\\):this\\.stopRecording\\(this\\.activeSession\\.id\\)\\)\\}\\},\\{ownership:this\\.lifecycleLock\\}\\)\\)$`, "u");
  if (methods.updateEscapeRegistration.parameters !== "" || !nativeEscape.test(methods.updateEscapeRegistration.body)) {
    throw new Error("Dictation native in-app Escape stop/cancel policy changed");
  }
  const constructorCalls = plainCalls(methods.constructor.body, false).map(helper => factoryFunction(source, metadata, helper, false)).filter(Boolean);
  const capability = one(constructorCalls.filter(helper => new RegExp(`^function ${escapeRegexLiteral(helper.name)}\\(\\)\\{return ?${platformIs("darwin")}\\|\\|${platformIs("win32")}(?:\\|\\|${platformIs("linux")})?\\}$`, "u").test(helper.text)), "dictation capability helper consumption");
  const validation = one(constructorCalls.filter(helper => helper.body.includes("allowUnmodified:!0") && new RegExp(`if\\(${platformIs("win32")}&&`, "u").test(helper.body)), "dictation validation helper consumption");
  const watcherCalls = plainCalls(methods.ensureHotkeyReleaseWatchers.body, false)
    .map(helper => factoryFunction(source, metadata, helper, false)).filter(helper => helper?.body.includes(UNSUPPORTED_RELEASE_WATCHING));
  const watcher = one(watcherCalls, "dictation release helper consumption");
  if (scopedMatches(methods.ensureHotkeyReleaseWatchers.body, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(watcher.name)}\\(`, "gu"), false).length !== 2) throw new Error("Both native dictation release-helper calls are required");
  const transcript = transcriptPlan(source, metadata.owner.registration, methods.handleTranscript);
  return { metadata, controller, methods, capability, validation, watcher, ...transcript, ownedCalls };
}

function applySourceEdits(source, edits) {
  let result = source, previous = source.length;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > previous) throw new Error("Overlapping dictation source ownership edits");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    previous = edit.start;
  }
  return result;
}

function linuxPlatformGuard(text, message, body) {
  const pattern = unsupportedPlatformCases(message);
  const match = one(scopedMatches(text, new RegExp(pattern.source, "gu"), false), "dictation native unsupported Linux dispatch");
  const throwAt = match.index + match[0].lastIndexOf("throw Error(");
  return text.slice(0, throwAt) + `if("linux"===process.platform){${body}}` + text.slice(throwAt);
}

function releaseGuard(plan) {
  const [accelerator, released] = plan.watcher.parameters.split(",");
  return `let codexLinuxGlobalDictationWatcher=codexLinuxGlobalDictationReleaseWatcher(${accelerator},${released});if(null==codexLinuxGlobalDictationWatcher)throw Error(${JSON.stringify(UNSUPPORTED_RELEASE_WATCHING)});return codexLinuxGlobalDictationWatcher`;
}

function pasteGuard(plan) {
  const signal = plan.paste.parameters;
  return `if(codexLinuxGlobalShortcutsUsesWayland()){await codexLinuxGlobalShortcutsPaste(${signal});return}await codexLinuxGlobalDictationPasteX11(${signal});return`;
}

function applyCurrentLinuxGlobalDictationPatch(source, inspectedPlan) {
  try {
    const plan = inspectedPlan ?? dictationOwnerPlan(source, inspectGlobalShortcutsPortal(source));
    const validationArgument = plan.validation.parameters.split(",")[0];
    const validationGuard = `if("linux"===process.platform&&${plan.metadata.owner.registration.bareModifier}(${validationArgument}))return${JSON.stringify(MODIFIER_ONLY_MESSAGE)};`;
    const validationAt = plan.validation.bodyStart - plan.validation.start;
    const paste = linuxPlatformGuard(plan.paste.text, UNSUPPORTED_PASTE, pasteGuard(plan));
    const bridge = plan.bridge.text.slice(0, plan.paste.start - plan.bridge.start) + paste + plan.bridge.text.slice(plan.paste.end - plan.bridge.start);
    const edits = [
      { start: plan.metadata.owner.registration.start, end: plan.metadata.owner.registration.start, text: helperSource() },
      { start: plan.validation.start, end: plan.validation.end, text: plan.validation.text.slice(0, validationAt) + validationGuard + plan.validation.text.slice(validationAt) },
      { start: plan.capability.start, end: plan.capability.end, text: plan.capability.text.slice(0, -1) + '||"linux"===process.platform}' },
      { start: plan.watcher.start, end: plan.watcher.end, text: linuxPlatformGuard(plan.watcher.text, UNSUPPORTED_RELEASE_WATCHING, releaseGuard(plan)) },
      { start: plan.bridge.invocation.start, end: plan.bridge.invocation.end, text: `codexLinuxGlobalDictationClipboard(this,${bridge},${plan.bridge.invocation.argumentSource})` },
      { start: plan.methods.unregisterHotkey.start, end: plan.methods.unregisterHotkey.start, text: 'handleLinuxHotkeyUnavailable(e,t){console.warn(`[linux-global-dictation] ${e} hotkey backend became unavailable`,t);if("hold"===e)this.unregisterHotkey();else this.unregisterToggleHotkey()}' },
    ];
    for (const [gesture, id, mode] of [["primary", "globalDictationHold", "hold"], ["single-tap", "globalDictationSingleTap", "toggle"]]) {
      const call = plan.ownedCalls[gesture].call;
      const open = call.text.indexOf("{"), close = findMatchingBrace(call.text, open);
      const unavailable = `,onUnavailable:n=>{this.handleLinuxHotkeyUnavailable(${JSON.stringify(mode)},n)}`;
      const text = call.text.slice(0, open + 1) + `linuxCommandId:${JSON.stringify(id)},` + call.text.slice(open + 1, close) + unavailable + call.text.slice(close);
      edits.push({ start: call.start, end: call.end, text });
    }
    return installPortalBackend(applySourceEdits(source, edits));
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return source;
  }
}

const MODIFIER_ONLY_MESSAGE = "Modifier-only shortcuts are not supported for global dictation on Linux.";
const OWN_HELPER_NAMES = ["codexLinuxGlobalDictationPatch", "codexLinuxGlobalDictationReleaseWatcher", "codexLinuxGlobalDictationPasteX11", "codexLinuxGlobalDictationClipboard", "codexLinuxGlobalDictationClipboardQueues"];
function hasOwnArtifact(source) {
  return source.includes(PATCH_MARKER) || source.includes("codexLinuxGlobalDictation") || source.includes("handleLinuxHotkeyUnavailable") ||
    /linuxCommandId:["`]globalDictation(?:Hold|SingleTap)["`]/u.test(source);
}
function hasEscapedOwnName(source) {
  for (const token of source.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu)) {
    if (!token[0].includes("\\u")) continue;
    let decoded;
    try { decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16))); }
    catch { continue; }
    if (OWN_HELPER_NAMES.includes(decoded) && codeAt(source, token.index)) return true;
  }
  return false;
}
function ownHelperBlock(source, metadata) {
  const scope = metadata.owner.factoryBody, body = source.slice(scope.start, scope.end);
  const head = one(scopedMatches(body, /\bvar codexLinuxGlobalDictationPatch=/gu).filter(match => declarationAt(body, match.index)), "dictation helper declaration");
  const tail = factoryFunction(source, metadata, "codexLinuxGlobalDictationPasteX11");
  const start = scope.start + head.index;
  if (tail.end > metadata.owner.registration.start || tail.end <= start) throw new Error("Dictation helpers are outside their actual registration scope");
  const block = { start, end: tail.end, text: source.slice(start, tail.end) };
  if (block.text !== helperSource()) throw new Error("Dictation helper source is incomplete or changed");
  return block;
}
function replaceCount(source, from, to, expected, description) {
  if (source.split(from).length - 1 !== expected) throw new Error(`${description} is incomplete or ambiguous`);
  return source.split(from).join(to);
}
function assertNativeBusiness(plan) {
  if (plan.capability.text.includes('||"linux"===process.platform') || plan.validation.text.includes(MODIFIER_ONLY_MESSAGE) ||
      plan.watcher.text.includes("codexLinuxGlobalDictation") || plan.paste.text.includes("codexLinuxGlobalDictation") || plan.bridge.invocation.wrapped ||
      plan.methods.registerHotkeyOrThrow.text.includes('linuxCommandId:"globalDictationHold"') ||
      plan.methods.registerToggleHotkeyOrThrow.text.includes('linuxCommandId:"globalDictationSingleTap"') ||
      plan.controller.text.includes("handleLinuxHotkeyUnavailable")) throw new Error("Partial Linux dictation adaptation without complete own authority");
  if (!unsupportedPlatformCases(UNSUPPORTED_RELEASE_WATCHING).test(plan.watcher.text) || !unsupportedPlatformCases(UNSUPPORTED_PASTE).test(plan.paste.text)) throw new Error("Native Linux dictation platform branches are unavailable");
}
function restoreNativeDictation(source, plan, block) {
  const edits = [{ start: block.start, end: block.end, text: "" }];
  const validationArg = plan.validation.parameters.split(",")[0];
  const guard = `if("linux"===process.platform&&${plan.metadata.owner.registration.bareModifier}(${validationArg}))return${JSON.stringify(MODIFIER_ONLY_MESSAGE)};`;
  edits.push({ start: plan.validation.start, end: plan.validation.end, text: replaceCount(plan.validation.text, guard, "", 1, "dictation modifier guard") });
  edits.push({ start: plan.capability.start, end: plan.capability.end, text: replaceCount(plan.capability.text, '||"linux"===process.platform', "", 1, "dictation capability") });
  const watcher = replaceCount(plan.watcher.text, `if("linux"===process.platform){${releaseGuard(plan)}}`, "", 1, "dictation release branch");
  edits.push({ start: plan.watcher.start, end: plan.watcher.end, text: watcher });
  const paste = replaceCount(plan.paste.text, `if("linux"===process.platform){${pasteGuard(plan)}}`, "", 1, "dictation paste branch");
  if (!plan.bridge.invocation.wrapped) throw new Error("Dictation clipboard FIFO wrapper is missing");
  const bridge = plan.bridge.text.slice(0, plan.paste.start - plan.bridge.start) + paste + plan.bridge.text.slice(plan.paste.end - plan.bridge.start);
  edits.push({ start: plan.bridge.invocation.start, end: plan.bridge.invocation.end, text: `${bridge}(${plan.bridge.invocation.argumentSource})` });
  for (const [method, id, mode] of [["registerHotkeyOrThrow", "globalDictationHold", "hold"], ["registerToggleHotkeyOrThrow", "globalDictationSingleTap", "toggle"]]) {
    const span = plan.methods[method];
    let text = replaceCount(span.text, `linuxCommandId:${JSON.stringify(id)},`, "", 1, `${mode} dictation identity`);
    text = replaceCount(text, `,onUnavailable:n=>{this.handleLinuxHotkeyUnavailable(${JSON.stringify(mode)},n)}`, "", 1, `${mode} dictation failure callback`);
    edits.push({ start: span.start, end: span.end, text });
  }
  const failure = classMethod(plan.controller, "handleLinuxHotkeyUnavailable");
  const expectedFailure = 'handleLinuxHotkeyUnavailable(e,t){console.warn(`[linux-global-dictation] ${e} hotkey backend became unavailable`,t);if("hold"===e)this.unregisterHotkey();else this.unregisterToggleHotkey()}';
  if (failure.text !== expectedFailure) throw new Error("Dictation failure cleanup method is changed");
  edits.push({ start: failure.start, end: failure.end, text: "" });
  const result = applySourceEdits(source, edits);
  if (hasOwnArtifact(result) || hasEscapedOwnName(result)) throw new Error("Dictation helper or binding artifacts exist outside owned source");
  return result;
}
function inspectWithPortal(source, metadata) {
  const result = { state: "unrelated", reason: metadata.reason, factoryIds: metadata.factoryIds, ownerId: metadata.owner?.id ?? null };
  if (!metadata.owner) return { ...result, state: metadata.state === "drifted" || hasOwnArtifact(source) ? "drifted" : "unrelated" };
  try {
    const plan = dictationOwnerPlan(source, metadata);
    if (!hasOwnArtifact(source) && !hasEscapedOwnName(source)) {
      assertNativeBusiness(plan);
      return { ...result, state: "current", reason: null, plan };
    }
    if (metadata.state !== "shared" || source.split(PATCH_MARKER).length - 1 !== 1) throw new Error("Dictation own marker or shared dependency is incomplete");
    const block = ownHelperBlock(source, metadata), native = restoreNativeDictation(source, plan, block);
    const nativeMetadata = inspectGlobalShortcutsPortal(native), nativePlan = dictationOwnerPlan(native, nativeMetadata);
    assertNativeBusiness(nativePlan);
    const expected = applyCurrentLinuxGlobalDictationPatch(native, nativePlan);
    if (expected === native) throw new Error("Dictation canonical reconstruction failed");
    const expectedMetadata = inspectGlobalShortcutsPortal(expected), expectedBlock = ownHelperBlock(expected, expectedMetadata);
    if (source.slice(0, block.start) + source.slice(block.end) !== expected.slice(0, expectedBlock.start) + expected.slice(expectedBlock.end)) throw new Error("Dictation native callbacks, helper calls or placement changed");
    return { ...result, state: "patched", reason: null, plan };
  } catch (error) { return { ...result, state: "drifted", reason: error.message }; }
}
function inspectGlobalDictationMainProcess(source) {
  return inspectWithPortal(source, inspectGlobalShortcutsPortal(source));
}
function applyLinuxGlobalDictationMainProcessPatch(source) {
  const inspected = inspectGlobalDictationMainProcess(source);
  if (inspected.state === "patched") return source;
  if (inspected.state !== "current") { warn(inspected.reason || "Live dictation controller is unavailable"); return source; }
  const patched = applyCurrentLinuxGlobalDictationPatch(source, inspected.plan);
  const complete = inspectGlobalDictationMainProcess(patched);
  if (complete.state !== "patched") { warn(complete.reason || "Dictation adaptation poststate is incomplete"); return source; }
  return patched;
}
function applyGlobalDictationToExtractedApp(extractedDir) {
  const reject = reason => { warn(reason); return { matched: 0, changed: 0, changedAssets: [], reason }; };
  const inventory = findMainProcessChunks(extractedDir);
  if (!inventory) return reject("Missing main-process inventory for dictation");
  const records = inventory.chunks.map(assetName => {
    const source = fs.readFileSync(path.join(inventory.buildDir, assetName), "utf8"), metadata = inspectGlobalShortcutsPortal(source);
    return { assetName, source, metadata, inspected: inspectWithPortal(source, metadata) };
  });
  const owners = records.filter(record => record.metadata.owner);
  if (owners.length !== 1) return reject(portalOwnerFailureReason(records, "Missing or ambiguous live dictation owner cohort"));
  const owner = owners[0], identity = owner.metadata.owner.id;
  const cohort = records.filter(record => record.metadata.factoryIds.includes(identity) || hasOwnArtifact(record.source) || hasEscapedOwnName(record.source) || record.metadata.state === "drifted");
  if (cohort.length !== 1 || cohort[0] !== owner) return reject("Duplicate, damaged or partial dictation owner cohort");
  if (owner.inspected.state === "drifted" || owner.inspected.state === "unrelated") return reject(owner.inspected.reason || "Incomplete dictation controller authority");
  if (owner.inspected.state === "patched") return { matched: 1, changed: 0, changedAssets: [] };
  const patchedSource = applyCurrentLinuxGlobalDictationPatch(owner.source, owner.inspected.plan);
  const complete = inspectGlobalDictationMainProcess(patchedSource);
  if (complete.state !== "patched") return reject(complete.reason || "Dictation poststate is incomplete");
  return { matched: 1, ...commitAssetEdits(inventory.buildDir, [{ assetName: owner.assetName, source: owner.source, patchedSource }]) };
}

const descriptors = [
  {
    id: "linux-global-dictation-main-process",
    phase: "extracted-app:pre-webview",
    order: 145,
    apply: applyGlobalDictationToExtractedApp,
  },
];

module.exports = {
  applyLinuxGlobalDictationMainProcessPatch,
  descriptors,
  inspectGlobalDictationMainProcess,
  applyGlobalDictationToExtractedApp,
};
