"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Script } = require("node:vm");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
const { commitAssetEdits } = require("../../scripts/patches/lib/asset-edits.js");

const PATCH_MARKER = "codex-linux-global-dictation-v3";
const {
  insertBeforeRegistration,
  installPortalBackend,
  inspectGlobalShortcutsPortal,
  literal,
  platformIs,
  registrationContract,
  replaceInRegistrationModule,
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

function codexLinuxGlobalDictationPasteX11() {
  return new Promise((resolve, reject) => {
    try {
      require("node:child_process").execFile(
        "xdotool",
        ["key", "--clearmodifiers", "ctrl+v"],
        { windowsHide: true },
        (error) => (error ? reject(error) : resolve()),
      );
    } catch (error) {
      reject(error);
    }
  });
}

function helperSource() {
  return [
    `var codexLinuxGlobalDictationPatch=${JSON.stringify(PATCH_MARKER)};`,
    codexLinuxGlobalDictationReleaseWatcher,
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

function hotkeyRegistration(registerFunction, gesture, optionsPattern) {
  return new RegExp(
    `${escapeRegexLiteral(registerFunction)}\\((?<accelerator>${IDENT}),\\{(?<callbacks>(?:(?!\\},\\{(?:ownership:|bareModifierTrigger:))[\\s\\S]){0,1200}?` +
      `shortcutGestures\\.press\\(${literal(gesture)},[\\s\\S]{0,300}?` +
      `shortcutGestures\\.release\\(${literal(gesture)}\\)[\\s\\S]{0,300}?` +
      `shortcutGestures\\.cancelPress\\(${literal(gesture)}\\)[\\s\\S]{0,120}?)\\},` +
      `\\{${optionsPattern}\\}\\)`,
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
function classMethod(controller, name) {
  const trivia = "(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r?\\n|$))";
  const separator = `(?:${trivia}+|(?=\\*))`;
  const head = one(scopedMatches(controller.body, new RegExp(`(?<![\\w$.])(?:(static|get|set)${separator})?(?:(async)${separator})?(\\*${trivia}*)?${escapeRegexLiteral(name)}\\(([^)]*)\\)\\{`, "gu")), `dictation controller ${name}`);
  if (head[1] || head[3] || Boolean(head[2]) !== (name === "handleTranscript")) throw new Error(`Dictation controller ${name} is not its native instance method kind`);
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
    one(scopedMatches(body, callback), `${gesture} native ownership/setup/gesture callbacks`);
    ownedCalls[gesture] = methods[method];
  }
  const classCalls = scopedMatches(controller.body, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(register)}\\(`, "gu"), false);
  const escapeCalls = scopedMatches(methods.updateEscapeRegistration.body, new RegExp(`${escapeRegexLiteral(register)}\\(${literal("Escape")},`, "gu"), false);
  if (classCalls.length !== 3 || escapeCalls.length !== 1 || methods.updateEscapeRegistration.text.includes("linuxCommandId:")) throw new Error("Dictation native Escape registration boundary changed");
  const constructorCalls = plainCalls(methods.constructor.body, false).map(helper => factoryFunction(source, metadata, helper, false)).filter(Boolean);
  const capability = one(constructorCalls.filter(helper => new RegExp(`^function ${escapeRegexLiteral(helper.name)}\\(\\)\\{return ?${platformIs("darwin")}\\|\\|${platformIs("win32")}(?:\\|\\|${platformIs("linux")})?\\}$`, "u").test(helper.text)), "dictation capability helper consumption");
  const validation = one(constructorCalls.filter(helper => helper.body.includes("allowUnmodified:!0") && new RegExp(`if\\(${platformIs("win32")}&&`, "u").test(helper.body)), "dictation validation helper consumption");
  const watcherCalls = plainCalls(methods.ensureHotkeyReleaseWatchers.body, false)
    .map(helper => factoryFunction(source, metadata, helper, false)).filter(helper => helper?.body.includes(UNSUPPORTED_RELEASE_WATCHING));
  const watcher = one(watcherCalls, "dictation release helper consumption");
  if (scopedMatches(methods.ensureHotkeyReleaseWatchers.body, new RegExp(`(?<![\\w$.])${escapeRegexLiteral(watcher.name)}\\(`, "gu"), false).length !== 2) throw new Error("Both native dictation release-helper calls are required");
  const bridges = plainCalls(methods.handleTranscript.body, false).map(helper => factoryFunction(source, metadata, helper, false)).filter(Boolean);
  const pasteLinks = bridges.flatMap(bridge => plainCalls(bridge.body, false).map(helper => factoryFunction(source, metadata, helper, false))
    .filter(helper => helper?.body.includes(UNSUPPORTED_PASTE)).map(paste => ({ bridge, paste })));
  const { bridge, paste } = one(pasteLinks, "dictation transcript-to-paste helper chain");
  if (!scopedMatches(bridge.body, new RegExp(`await ${escapeRegexLiteral(paste.name)}\\(`, "gu"), false).length) throw new Error("Dictation paste helper is not awaited by its transcript bridge");
  return { metadata, controller, methods, capability, validation, watcher, bridge, paste, ownedCalls };
}

function applyCurrentLinuxGlobalDictationPatch(source) {
  if (!source.includes(UNSUPPORTED_RELEASE_WATCHING)) {
    warn("release watcher sentinel was not found");
    return source;
  }

  try {
    const { name: registerFunction, bareModifier: bareModifierTestFunction } = registrationContract(source);
    let patched = insertBeforeRegistration(source, helperSource());
    const replace = (pattern, replacement, description) => {
      patched = replaceInRegistrationModule(patched, pattern, replacement, description);
    };

    replace(
      new RegExp(
        `function (${IDENT})\\((${IDENT})\\)\\{(?=if\\(${platformIs("win32")}&&${IDENT}\\(\\2\\)\\)return[\\s\\S]{0,220}?;let ${IDENT}=${IDENT}\\(\\2,process\\.platform,\\{allowUnmodified:!0\\}\\))`,
        "u",
      ),
      (_original, functionName, accelerator) =>
        `function ${functionName}(${accelerator}){if("linux"===process.platform&&${bareModifierTestFunction}(${accelerator}))return"Modifier-only shortcuts are not supported for global dictation on Linux.";`,
      "Linux modifier-only validation",
    );

    replace(
      new RegExp(
        `(?<header>function ${IDENT}\\((?<accelerator>${IDENT}),(?<onReleased>${IDENT})\\)\\{switch\\(process\\.platform\\)\\{case${literal("darwin")}:[\\s\\S]{0,1500}?)` +
          unsupportedPlatformCases(UNSUPPORTED_RELEASE_WATCHING).source,
        "u",
      ),
      (...args) => {
        const { header, accelerator, onReleased, before, after } = args.at(-1);
        return `${header}case"linux":{let n=codexLinuxGlobalDictationReleaseWatcher(${accelerator},${onReleased});if(null==n)throw Error(${JSON.stringify(UNSUPPORTED_RELEASE_WATCHING)});return n}${before}${after}throw Error(${JSON.stringify(UNSUPPORTED_RELEASE_WATCHING)})`;
      },
      "Linux release watcher platform branch",
    );

    replace(
      new RegExp(`function (${IDENT})\\(\\)\\{return ?${platformIs("darwin")}\\|\\|${platformIs("win32")}\\}`, "u"),
      (original) => `${original.slice(0, -1)}||"linux"===process.platform}`,
      "global dictation platform capability",
    );

    replace(
      unsupportedPlatformCases(UNSUPPORTED_PASTE),
      (...args) => {
        const { before, after } = args.at(-1);
        return `case"linux":if(codexLinuxGlobalShortcutsUsesWayland()){await codexLinuxGlobalShortcutsPaste();return}await codexLinuxGlobalDictationPasteX11();return;${before}${after}throw Error(${JSON.stringify(UNSUPPORTED_PASTE)})`;
      },
      "Linux global dictation paste branch",
    );

    replace(
      hotkeyRegistration(registerFunction, "primary", `ownership:(?<ownership>${IDENT}),bareModifierTrigger:${literal("cancellablePress")}`),
      (...args) => {
        const { accelerator, callbacks, ownership } = args.at(-1);
        return `${registerFunction}(${accelerator},{linuxCommandId:"globalDictationHold",${callbacks},onUnavailable:n=>{this.handleLinuxHotkeyUnavailable("hold",n)}},{ownership:${ownership},bareModifierTrigger:"cancellablePress"})`;
      },
      "hold hotkey registration",
    );

    replace(
      hotkeyRegistration(registerFunction, "single-tap", `bareModifierTrigger:${literal("cancellablePress")},ownership:(?<ownership>${IDENT})`),
      (...args) => {
        const { accelerator, callbacks, ownership } = args.at(-1);
        return `${registerFunction}(${accelerator},{linuxCommandId:"globalDictationSingleTap",${callbacks},onUnavailable:n=>{this.handleLinuxHotkeyUnavailable("toggle",n)}},{bareModifierTrigger:"cancellablePress",ownership:${ownership}})`;
      },
      "toggle hotkey registration",
    );

    replace(
      /unregisterHotkey\(\)\{/u,
      'handleLinuxHotkeyUnavailable(e,t){console.warn(`[linux-global-dictation] ${e} hotkey backend became unavailable`,t);if("hold"===e)this.unregisterHotkey();else this.unregisterToggleHotkey()}unregisterHotkey(){',
      "hotkey failure cleanup method",
    );
    return installPortalBackend(patched);
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return source;
  }
}

const MODIFIER_ONLY_MESSAGE = "Modifier-only shortcuts are not supported for global dictation on Linux.";
const OWN_HELPER_NAMES = ["codexLinuxGlobalDictationPatch", "codexLinuxGlobalDictationReleaseWatcher", "codexLinuxGlobalDictationPasteX11"];
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
      plan.watcher.text.includes("codexLinuxGlobalDictation") || plan.paste.text.includes("codexLinuxGlobalDictation") ||
      plan.methods.registerHotkeyOrThrow.text.includes('linuxCommandId:"globalDictationHold"') ||
      plan.methods.registerToggleHotkeyOrThrow.text.includes('linuxCommandId:"globalDictationSingleTap"') ||
      plan.controller.text.includes("handleLinuxHotkeyUnavailable")) throw new Error("Partial Linux dictation adaptation without complete own authority");
  if (!unsupportedPlatformCases(UNSUPPORTED_RELEASE_WATCHING).test(plan.watcher.text) || !unsupportedPlatformCases(UNSUPPORTED_PASTE).test(plan.paste.text)) throw new Error("Native Linux dictation platform branches are unavailable");
}
function restoreUnsupportedLinux(text, message) {
  const labels = `case(?:"[a-z0-9]+"|\`[a-z0-9]+\`):`;
  const pattern = new RegExp(`(?<labels>(?:${labels})+)throw Error\\(${literal(message)}\\)`, "gu");
  const match = one([...text.matchAll(pattern)], "dictation unsupported platform tail");
  return text.slice(0, match.index) + `${match.groups.labels}case"linux":throw Error(${JSON.stringify(message)})` + text.slice(match.index + match[0].length);
}
function restoreNativeDictation(source, plan, block) {
  const edits = [{ start: block.start, end: block.end, text: "" }];
  const validationArg = plan.validation.parameters.split(",")[0];
  const guard = `if("linux"===process.platform&&${plan.metadata.owner.registration.bareModifier}(${validationArg}))return${JSON.stringify(MODIFIER_ONLY_MESSAGE)};`;
  edits.push({ start: plan.validation.start, end: plan.validation.end, text: replaceCount(plan.validation.text, guard, "", 1, "dictation modifier guard") });
  edits.push({ start: plan.capability.start, end: plan.capability.end, text: replaceCount(plan.capability.text, '||"linux"===process.platform', "", 1, "dictation capability") });
  const [accelerator, released] = plan.watcher.parameters.split(",");
  const releaseBranch = `case"linux":{let n=codexLinuxGlobalDictationReleaseWatcher(${accelerator},${released});if(null==n)throw Error(${JSON.stringify(UNSUPPORTED_RELEASE_WATCHING)});return n}`;
  const watcher = replaceCount(plan.watcher.text, releaseBranch, "", 1, "dictation release branch");
  edits.push({ start: plan.watcher.start, end: plan.watcher.end, text: restoreUnsupportedLinux(watcher, UNSUPPORTED_RELEASE_WATCHING) });
  const pasteBranch = 'case"linux":if(codexLinuxGlobalShortcutsUsesWayland()){await codexLinuxGlobalShortcutsPaste();return}await codexLinuxGlobalDictationPasteX11();return;';
  const paste = replaceCount(plan.paste.text, pasteBranch, "", 1, "dictation paste branch");
  edits.push({ start: plan.paste.start, end: plan.paste.end, text: restoreUnsupportedLinux(paste, UNSUPPORTED_PASTE) });
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
  edits.sort((a, b) => b.start - a.start);
  let result = source, previous = source.length;
  for (const edit of edits) {
    if (edit.end > previous) throw new Error("Overlapping dictation source ownership edits");
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end); previous = edit.start;
  }
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
    const expected = applyCurrentLinuxGlobalDictationPatch(native);
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
  const patched = applyCurrentLinuxGlobalDictationPatch(source);
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
  if (owners.length !== 1) return reject("Missing or ambiguous live dictation owner cohort");
  const owner = owners[0], identity = owner.metadata.owner.id;
  const cohort = records.filter(record => record.metadata.factoryIds.includes(identity) || hasOwnArtifact(record.source) || hasEscapedOwnName(record.source) || record.metadata.state === "drifted");
  if (cohort.length !== 1 || cohort[0] !== owner) return reject("Duplicate, damaged or partial dictation owner cohort");
  if (owner.inspected.state === "drifted" || owner.inspected.state === "unrelated") return reject(owner.inspected.reason || "Incomplete dictation controller authority");
  if (owner.inspected.state === "patched") return { matched: 1, changed: 0, changedAssets: [] };
  const patchedSource = applyCurrentLinuxGlobalDictationPatch(owner.source);
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
