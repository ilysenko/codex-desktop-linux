"use strict";

const { Script } = require("node:vm");
const { escapeRegExp, findMatchingBrace } = require("./minified-js.js");
const PATCH_MARKER = "codex-linux-global-shortcuts-portal-v1";
const IDENT = "[A-Za-z_$][\\w$]*";

function replaceUnique(source, pattern, replacement, description) {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))];
  if (matches.length !== 1) throw new Error(`${description} matched ${matches.length} times`);
  return source.replace(pattern, replacement);
}

// Minifier-neutral fragments for the rspack/SWC main-process chunks: string
// literals may be quoted or template literals, and null checks may be Yoda.
function literal(value) {
  const escaped = escapeRegExp(value);
  return `(?:"${escaped}"|\`${escaped}\`)`;
}

function platformIs(name) {
  return `(?:${literal(name)}===process\\.platform|process\\.platform===${literal(name)})`;
}

function isNull(expression) {
  return `(?:null==${expression}|${expression}==null)`;
}

function notNull(expression) {
  return `(?:null!=${expression}|${expression}!=null)`;
}

function codeAt(body, index) {
  return findMatchingBrace("{" + body.slice(0, index) + "}".repeat(index + 2), 0) >= index + 1;
}

function rootAt(body, index) {
  return findMatchingBrace("{" + body.slice(0, index) + "}", 0) === index + 1;
}

function codeMatches(body, pattern, root = false) {
  return [...body.matchAll(pattern)].filter(match => codeAt(body, match.index) && (!root || rootAt(body, match.index)));
}

function statementAt(body, index) {
  if (!codeAt(body, index) || !rootAt(body, index)) return false;
  try { new Script(body.slice(0, index) + "\nconst __portalStatement=0;\n"); return true; }
  catch { return false; }
}

function evaluatedAt(body, index) {
  if (!codeAt(body, index) || !rootAt(body, index)) return false;
  let prefix = body.slice(0, index);
  for (const returned of codeMatches(prefix, /\breturn\b/gu, true)) {
    // A const declaration cannot be the unbraced body of an if/else. This
    // separates current native conditional exits from an unconditional return.
    try {
      new Script(`async function __portalReturn(){\n${prefix.slice(0, returned.index)}\nconst __portalBeforeReturn=0;\n}`);
      return false;
    } catch { /* The return is controlled by the preceding statement. */ }
  }
  if (prefix.endsWith(",")) prefix = prefix.slice(0, -1) + ";";
  try { new Script(`async function __portalStartup(){\n${prefix}\nconst __portalEvaluated=0;\n}`); return true; }
  catch { return false; }
}

function one(values, description) {
  if (values.length !== 1) throw new Error(`${description} matched ${values.length} times`);
  return values[0];
}

// The owning module is structural CommonJS, not the nearest numeric-looking
// text. Legal generated key spellings are normalized before duplicate checks.
function mainFactories(source) {
  new Script(source);
  const header = one(codeMatches(source, /(?<![\w$.])exports\.ids=\[[\d,eE+\-]*\],exports\.modules=\{/gu)
    .filter(match => statementAt(source, match.index)), "main CommonJS factory carrier");
  const exportsReferences = codeMatches(source, /(?<![\w$.])exports(?=\s*[.\[])/gu);
  const expectedReferences = new Set([header.index, header.index + header[0].indexOf("exports.modules")]);
  if (exportsReferences.length !== 2 || exportsReferences.some(match => !expectedReferences.has(match.index))) throw new Error("Main CommonJS carrier is overwritten or aliased");
  let cursor = header.index + header[0].length;
  const result = [], identities = new Set();
  const key = `(?:"(?:\\\\.|[^"\\\\])*"|${IDENT}|0[xX][\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`;
  const member = new RegExp(`(${key})\\((${IDENT}(?:,${IDENT}){0,2})?\\)\\{`, "uy");
  for (;;) {
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (source[cursor] === "}") return result;
    member.lastIndex = cursor;
    const found = member.exec(source);
    if (!found) throw new Error("Unsupported main CommonJS factory member");
    let identity = found[1];
    if (identity.startsWith('"')) identity = JSON.parse(identity);
    else if (/^\d/u.test(identity)) {
      const numeric = Number(identity);
      if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error("Unsafe main factory identity");
      identity = String(numeric);
    }
    if (identities.has(identity)) throw new Error("Duplicate main factory identity");
    identities.add(identity);
    const start = member.lastIndex, end = findMatchingBrace(source, start - 1);
    if (end < start) throw new Error("Incomplete main CommonJS factory");
    result.push({ identity, start, end, body: source.slice(start, end), parameters: found[2]?.split(",") ?? [] });
    cursor = end + 1;
    while (/\s/u.test(source[cursor] ?? "") && cursor < source.length) cursor++;
    if (source[cursor] === "}") return result;
    if (source[cursor++] !== ",") throw new Error("Invalid main factory separator");
  }
}

function registrationOwner(source) {
  const owners = [];
  for (const factory of mainFactories(source)) {
    for (const contract of registrationCandidates(factory.body)) {
      if (!statementAt(factory.body, contract.start)) continue;
      owners.push({ ...contract, start: factory.start + contract.start, end: factory.start + contract.end, factory });
    }
  }
  return one(owners, "global shortcut registration owner");
}

function registrationContract(source) {
  const { factory, ...contract } = registrationOwner(source);
  return contract;
}

function ownedMatches(source, pattern, factory) {
  return [...source.matchAll(pattern)].filter(match => factory.start <= match.index && match.index < factory.end && codeAt(source, match.index));
}

function assertSameModule(source, anchorIndex, index, description) {
  const owner = registrationOwner(source).factory;
  if (!(owner.start <= anchorIndex && anchorIndex < owner.end && owner.start <= index && index < owner.end) || !codeAt(source, index)) {
    throw new Error(`${description} is outside the global shortcut module`);
  }
}

function registrationCandidates(source) {
  const pattern = new RegExp(
    `function (?<name>${IDENT})\\((?<accelerator>${IDENT}),(?<callbacks>${IDENT}),(?<options>${IDENT})\\)\\{[\\s\\S]{0,500}?;` +
    `if\\(${platformIs("win32")}&&${IDENT}\\(\\k<accelerator>\\)\\)return [\\s\\S]{0,1500}?;` +
    `if\\((?<bareModifier>${IDENT})\\(\\k<accelerator>\\)\\|\\|(?<special>${IDENT})\\(\\k<accelerator>\\)\\)return ` +
    `${IDENT}\\(\\k<accelerator>\\)\\|\\|\\k<special>\\(\\k<accelerator>\\)\\?[\\s\\S]{0,4000}?` +
    `\\(\\k<accelerator>,${IDENT},\\k<options>\\?\\.bareModifierTrigger\\):null;`, "gu");
  const matches = codeMatches(source, pattern, true);
  return matches.map(match => {
  const end = findMatchingBrace(source, source.indexOf("{", match.index));
  if (end === -1) throw new Error("global shortcut registration function is incomplete");
  if (match.index > 0 && !";}".includes(source[match.index - 1])) {
    throw new Error("global shortcut registration function is not a statement-level declaration");
  }
  const body = source.slice(match.index, end + 1);
  const { callbacks: t, options: n } = match.groups;
  const ownership = new RegExp(`let (${IDENT})=${escapeRegExp(n)}\\?\\.ownership,(${IDENT})=${escapeRegExp(t)}\\.onReleased,(${IDENT})=${escapeRegExp(t)}\\.onCancelled,(${IDENT})=${isNull("\\1")}\\?${escapeRegExp(t)}:\\{` +
    `onRegistrationChanged:${escapeRegExp(t)}\\.onRegistrationChanged,` +
    `onPressed:\\(\\)=>\\{\\1\\.isOwner\\(\\)&&${escapeRegExp(t)}\\.onPressed\\(\\)\\},` +
    `onReleased:${isNull("\\2")}\\?void 0:\\(\\)=>\\{\\1\\.isOwner\\(\\)&&\\2\\(\\)\\},` +
    `onCancelled:${isNull("\\3")}\\?void 0:\\(\\)=>\\{\\1\\.isOwner\\(\\)&&\\3\\(\\)\\}\\}`, "u");
  if (!ownership.test(body)) throw new Error("global shortcut ownership callbacks drifted");
  return { ...match.groups, start: match.index, end: end + 1, body };
  });
}

function registrationFunction(source) {
  return registrationContract(source).name;
}

// Inserts statement-level code into the registration function's module scope.
function insertBeforeRegistration(source, code) {
  const { start } = registrationContract(source);
  return source.slice(0, start) + code + source.slice(start);
}

// Replaces one unique anchor that must share the registration function's
// module scope, because the replacement references injected helpers.
function replaceInRegistrationModule(source, pattern, replacement, description) {
  const { start } = registrationContract(source);
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))];
  if (matches.length !== 1) throw new Error(`${description} matched ${matches.length} times`);
  assertSameModule(source, start, matches[0].index, description);
  return source.replace(pattern, replacement);
}

function tagCommand(source, id, accelerator, callback) {
  return replaceUnique(source,
    new RegExp(`${escapeRegExp(registrationFunction(source))}\\(${accelerator},\\{(?=${callback})`, "u"),
    (match) => `${match}linuxCommandId:${JSON.stringify(id)},`, `${id} global shortcut identity`);
}

function codexLinuxGlobalShortcutsUsesWayland() {
  const type = String(process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
  return process.platform === "linux" && (type === "wayland" ||
    (type !== "x11" && !process.env.DISPLAY && Boolean(process.env.WAYLAND_DISPLAY)));
}

function codexLinuxGlobalShortcutsNativePath(name) {
  const fs = require("node:fs");
  const path = require("node:path");
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "native", name));
  try {
    const appPath = require("electron").app?.getAppPath?.();
    if (appPath) candidates.push(path.join(appPath, "native", name));
  } catch {}
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
  }
  return null;
}

function codexLinuxGlobalShortcutsLines(stream, onLine) {
  let buffer = "";
  stream?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) { buffer = ""; return; }
    for (let newline; (newline = buffer.indexOf("\n")) !== -1;) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
    }
  });
}

function codexLinuxGlobalShortcutsRequested() {
  const byId = new Map();
  for (const registration of codexLinuxGlobalShortcutsPortalRegistrations) {
    if (!registration.failed) byId.set(registration.id, registration);
  }
  return [...byId.values()];
}

function codexLinuxGlobalShortcutsUnavailable(registration, error) {
  registration.callbacks.onReady?.(false);
  if (registration.notified) return;
  registration.notified = true;
  console.warn(`[linux-global-shortcuts] ${registration.id}: ${error.message}`);
  setTimeout(() => {
    if (codexLinuxGlobalShortcutsPortalRegistrations.has(registration) && registration.notified && !registration.ready()) {
      registration.callbacks.onUnavailable?.(error);
    }
  }, 0);
}

function codexLinuxGlobalShortcutsPortalRegistration(accelerator, callbacks, commandId) {
  if (codexLinuxGlobalShortcutsShuttingDown) return null;
  // Portal IDs key saved compositor bindings; never rename them. Hold-to-talk
  // keeps the ID used before the shared backend so existing approvals survive.
  const [id, description] = {
    hotkeyWindow: ["hotkeyWindow", "Open popout chat window"],
    openAvatarOverlay: ["openAvatarOverlay", "Show Mini / Pet"],
    globalDictationHold: ["global-dictation", "Dictation: hold to talk"],
    globalDictationSingleTap: ["global-dictation-single-tap", "Dictation: start / stop"],
    appshots: ["appshots", "Capture app context (Appshots)"],
    realtimeVoice: ["realtimeVoice", "Open voice chat"],
    meetings: ["meetings", "Take meeting notes"],
  }[commandId] ?? [];
  const helper = codexLinuxGlobalShortcutsNativePath("codex-global-dictation-linux");
  if (!helper || typeof description !== "string") return null;
  let trigger;
  try {
    trigger = require("node:child_process").execFileSync(helper,
      ["check", "--shortcut", id, description, accelerator],
      { encoding: "utf8", timeout: 2000, maxBuffer: 4096, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!trigger || /[\r\n]/.test(trigger)) throw new Error("Invalid helper validation response");
    if (codexLinuxGlobalShortcutsRequested().some((r) => r.id !== id && r.trigger === trigger)) {
      throw new Error("Shortcut conflicts with another application action");
    }
  } catch (error) {
    if (/unknown command: check/.test(String(error?.stderr ?? ""))) {
      console.warn("[linux-global-shortcuts] The staged codex-global-dictation-linux helper is outdated; rebuild it with the current repository");
    }
    console.warn(`[linux-global-shortcuts] ${commandId} validation failed`, error);
    return null;
  }
  const registration = {
    id, description, accelerator, trigger, callbacks, pressed: false, notified: false, failed: false,
    handlesRelease: true,
    ready: () => codexLinuxGlobalShortcutsPortalRegistrations.has(registration) &&
      codexLinuxGlobalShortcutsPortalBackend?.ready === true &&
      codexLinuxGlobalShortcutsPortalBackend.bound.has(registration),
    unregister: () => {
      if (!codexLinuxGlobalShortcutsPortalRegistrations.delete(registration)) return;
      registration.callbacks.onReady?.(false);
      if (registration.pressed) {
        registration.pressed = false;
        registration.callbacks.onCancelled?.();
      }
      codexLinuxGlobalShortcutsPortalSchedule();
    },
  };
  codexLinuxGlobalShortcutsPortalRegistrations.add(registration);
  codexLinuxGlobalShortcutsPortalSchedule();
  return registration;
}

function codexLinuxGlobalShortcutsPortalPause() {
  const backend = codexLinuxGlobalShortcutsPortalBackend;
  const stopped = backend?.stop(new Error("Global shortcuts suspended")) ?? Promise.resolve(true);
  return stopped.then((clean) => {
    if (!clean) throw new Error("Global shortcuts helper did not release its session cleanly");
  });
}

function codexLinuxGlobalShortcutsPortalShutdown() {
  codexLinuxGlobalShortcutsShuttingDown = true;
  return codexLinuxGlobalShortcutsPortalBackend?.stop(new Error("Application is shutting down"));
}

function codexLinuxGlobalShortcutsPortalSchedule() {
  // KDE replaces saved actions with each bind set; wait for access-gated owners.
  if (codexLinuxGlobalShortcutsShuttingDown || !codexLinuxGlobalShortcutsAccessReady()) return;
  const backend = codexLinuxGlobalShortcutsPortalBackend;
  const requested = codexLinuxGlobalShortcutsRequested();
  if (backend && !backend.registrations.some((r) => requested.includes(r))) {
    backend.stop(new Error("Global shortcuts unregistered"));
  }
  if (codexLinuxGlobalShortcutsPortalScheduled) return;
  codexLinuxGlobalShortcutsPortalScheduled = true;
  const reconcile = async () => {
    try {
      for (;;) {
        const previous = codexLinuxGlobalShortcutsPortalBackend;
        if (previous) await previous.registrationFinished;
        if (codexLinuxGlobalShortcutsShuttingDown) return;
        let current = codexLinuxGlobalShortcutsRequested();
        if (codexLinuxGlobalShortcutsIsSuspended()) {
          if (previous) await previous.stop(new Error("Global shortcuts suspended"));
          codexLinuxGlobalShortcutsPortalBackend = null;
          return;
        }
        if (previous?.error) {
          const fallback = (previous.recovery ? [] : previous.everReady ? [...previous.bound.keys()] : previous.fallback)
            .filter((r) => current.includes(r));
          for (const registration of previous.registrations) {
            if (!fallback.includes(registration) && current.includes(registration)) {
              registration.failed = true;
              codexLinuxGlobalShortcutsUnavailable(registration, previous.error);
            }
          }
          await previous.stop(previous.error);
          if (codexLinuxGlobalShortcutsShuttingDown) return;
          if (codexLinuxGlobalShortcutsIsSuspended()) continue;
          const restore = fallback.filter((r) => codexLinuxGlobalShortcutsRequested().includes(r));
          codexLinuxGlobalShortcutsPortalBackend = restore.length
            ? codexLinuxGlobalShortcutsPortalStart(restore, [], true) : null;
          if (restore.length) continue;
        } else if (previous?.ready && current.length === previous.registrations.length &&
          current.every((r, i) => r === previous.registrations[i])) {
          return;
        } else {
          const fallback = previous ? [...previous.bound.keys()].filter((r) => current.includes(r)) : [];
          if (previous) await previous.stop(new Error("Global shortcuts reconfigured"));
          codexLinuxGlobalShortcutsPortalBackend = null;
          if (codexLinuxGlobalShortcutsShuttingDown) return;
          if (codexLinuxGlobalShortcutsIsSuspended()) continue;
          current = codexLinuxGlobalShortcutsRequested();
          if (current.length) {
            codexLinuxGlobalShortcutsPortalBackend = codexLinuxGlobalShortcutsPortalStart(current, fallback, false);
            continue;
          }
        }
        if (!codexLinuxGlobalShortcutsRequested().length) return;
      }
    } finally {
      codexLinuxGlobalShortcutsPortalScheduled = false;
    }
  };
  codexLinuxGlobalShortcutsPortalQueue = codexLinuxGlobalShortcutsPortalQueue.then(reconcile, reconcile);
}

function codexLinuxGlobalShortcutsPortalStart(registrations, fallback, recovery) {
  let child, closed = false, stderr = "", timer, killTimer, gone = false;
  let finishRegistration, finishExit, pasteResolve, pasteReject, pasteTimer;
  let reported = new Map();
  const registrationFinished = new Promise((resolve) => { finishRegistration = resolve; });
  // Resolves true once no helper process can hold a portal session: the portal
  // closes a session with its D-Bus connection, so any exit or signal releases it.
  const exited = new Promise((resolve) => { finishExit = resolve; });
  const released = () => child?.pid === undefined || gone;
  const finishPaste = (error) => {
    if (pasteTimer) clearTimeout(pasteTimer);
    pasteTimer = null;
    const resolve = pasteResolve, reject = pasteReject;
    pasteResolve = pasteReject = null;
    if (error) reject?.(error); else resolve?.();
  };
  const stop = (error) => {
    if (closed) return exited;
    closed = true;
    backend.ready = false;
    finishRegistration();
    if (timer) clearTimeout(timer);
    for (const r of registrations) {
      r.callbacks.onReady?.(false);
      if (r.pressed) {
        r.pressed = false;
        if (!codexLinuxGlobalShortcutsIsSuspended()) r.callbacks.onCancelled?.();
      }
    }
    finishPaste(error);
    try {
      if (released()) finishExit(true);
      else {
        child.kill("SIGINT");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
        killTimer.unref?.();
      }
    } catch { finishExit(false); }
    return exited;
  };
  const fail = (error) => {
    if (closed) return;
    backend.error = error;
    stop(error);
    codexLinuxGlobalShortcutsPortalSchedule();
  };
  const backend = { registrations, fallback, recovery, registrationFinished, bound: new Map(),
    ready: false, everReady: false, error: null, stop,
    paste: () => new Promise((resolve, reject) => {
      if (!backend.ready || closed) return reject(new Error("Wayland global shortcuts helper is not ready"));
      if (pasteReject) return reject(new Error("A Wayland paste request is already pending"));
      pasteResolve = resolve; pasteReject = reject;
      pasteTimer = setTimeout(() => fail(new Error("Wayland paste timed out")), 35000);
      pasteTimer.unref?.();
      try { child.stdin.write("paste\n", (error) => { if (error) fail(error); }); } catch (error) { fail(error); }
    }),
  };
  try {
    child = require("node:child_process").spawn(codexLinuxGlobalShortcutsNativePath("codex-global-dictation-linux"),
      ["portal", ...registrations.flatMap((r) => ["--shortcut", r.id, r.description, r.accelerator])],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    timer = setTimeout(() => fail(new Error("Global shortcuts portal registration timed out")), 30000);
    timer.unref?.();
    codexLinuxGlobalShortcutsLines(child.stdout, (line) => {
      if (closed) return;
      if (line === "bindings") reported = new Map();
      else if (line.startsWith("bound:")) {
        const match = /^bound:(\d+):(.*)$/.exec(line);
        const registration = match && registrations[Number(match[1])];
        if (!registration || reported.has(registration)) return fail(new Error("Invalid helper binding report"));
        reported.set(registration, match[2]);
      } else if (line === "ready") {
        backend.bound = reported;
        backend.ready = backend.everReady = true;
        if (timer) clearTimeout(timer);
        for (const r of registrations) {
          if (!codexLinuxGlobalShortcutsPortalRegistrations.has(r)) continue;
          if (reported.has(r)) {
            r.notified = false;
            r.callbacks.onReady?.(true, reported.get(r));
          } else {
            if (r.pressed) { r.pressed = false; r.callbacks.onCancelled?.(); }
            // Keep unbound actions available for reassignment in desktop settings.
            r.callbacks.onReady?.(false);
          }
        }
        finishRegistration();
      } else if (line === "paste-ok") finishPaste();
      else if (line.startsWith("paste-error:")) finishPaste(new Error(line.slice(12)));
      else {
        const event = /^(down|up)(?::(\d+))?$/.exec(line);
        const r = event && registrations[Number(event[2] ?? 0)];
        if (r?.ready() && !codexLinuxGlobalShortcutsIsSuspended()) {
          if (event[1] === "down" && !r.pressed) { r.pressed = true; r.callbacks.onPressed?.(); }
          else if (event[1] === "up" && r.pressed) { r.pressed = false; r.callbacks.onReleased?.(); }
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
    child.once("error", (error) => {
      if (released()) finishExit(true);
      fail(error);
    });
    child.once("exit", (code, signal) => {
      gone = true;
      if (killTimer) clearTimeout(killTimer);
      finishExit(true);
      if (!closed) fail(new Error(stderr.trim() || `Global shortcuts helper exited with ${signal ?? `code ${code}`}`));
    });
  } catch (error) {
    if (released()) finishExit(true);
    fail(error);
  }
  return backend;
}

async function codexLinuxGlobalShortcutsPaste() {
  if (![...codexLinuxGlobalShortcutsPortalRegistrations].some((r) => r.ready())) {
    throw new Error("No ready Wayland global shortcuts helper is available");
  }
  return codexLinuxGlobalShortcutsPortalBackend.paste();
}

function codexLinuxGlobalShortcutsActivate(entry, generation) {
  const current = () => codexLinuxGlobalShortcutsManagerHas(entry) && entry.generation === generation;
  const callbacks = entry.linuxCallbacks;
  const registration = codexLinuxGlobalShortcutsPortalRegistration(entry.hotkey, {
    onReady: (ready, trigger) => {
      if (!current()) return;
      entry.registered = ready && !codexLinuxGlobalShortcutsIsSuspended();
      entry.portalTriggerDescription = trigger;
    },
    onPressed: () => { if (current() && entry.registered) entry.onPressed(); },
    onReleased: () => { if (current() && entry.registered) callbacks.onReleased?.(); },
    onCancelled: () => { if (current()) entry.onCancelled?.(); },
    onUnavailable: (error) => { if (current()) callbacks.onUnavailable?.(error); },
  }, entry.linuxCommandId);
  if (!registration) return false;
  entry.portalRegistration?.unregister();
  entry.portalRegistration = registration;
  entry.registered = false;
  return true;
}

function rootProperty(properties, name) {
  const property = properties.get(name);
  if (!property || !new RegExp(`^${IDENT}(?:\\.${IDENT})*$`, "u").test(property.value)) throw new Error(`${name} owner wiring is unavailable`);
  return property.value;
}

function objectMembers(body) {
  const separators = [];
  for (const comma of codeMatches(body, /,/gu)) {
    try {
      new Script(`async function __portalObject(){return({\n${body.slice(0, comma.index)}\n});}`);
      separators.push(comma.index);
    } catch { /* A nested expression has not finished its property value. */ }
  }
  const result = []; let start = 0;
  for (const end of [...separators, body.length]) {
    const member = body.slice(start, end).trim();
    if (member) result.push(member);
    start = end + 1;
  }
  return result;
}

function objectProperties(body, description, windowResult = false) {
  const properties = new Map();
  for (const member of objectMembers(body)) {
    if (windowResult && member === "...{}") continue;
    let key, value;
    if (windowResult && new RegExp(`^get windowIconPath\\(\\)\\{return ${IDENT}\\}$`, "u").test(member)) {
      key = "windowIconPath";
    } else {
      const data = new RegExp(`^(${IDENT})\\s*:\\s*([\\s\\S]+)$`, "u").exec(member);
      if (!data) throw new Error(`${description} requires native identifier-key data properties`);
      key = data[1]; value = data[2].trim();
    }
    if (properties.has(key)) throw new Error(`${description} contains duplicate ${key}`);
    properties.set(key, { value, member });
  }
  return properties;
}

function directObjectCall(source, open) {
  const close = findMatchingBrace(source, open);
  if (close < open || !source.startsWith("({", close + 1)) throw new Error("Quit owner is not a direct object-IIFE call");
  const argumentOpen = close + 2, argumentClose = findMatchingBrace(source, argumentOpen);
  if (argumentClose < argumentOpen || source[argumentClose + 1] !== ")") throw new Error("Incomplete direct quit-owner arguments");
  return { open, close, argumentOpen, argumentClose, end: argumentClose + 2, arguments: source.slice(argumentOpen + 1, argumentClose) };
}

function publishedStartup(factory) {
  const [, exportsName, loader] = factory.parameters;
  if (!exportsName || !loader) throw new Error("Main factory export parameters are unavailable");
  const publication = one(codeMatches(factory.body, new RegExp(`(?<![\\w$.])${escapeRegExp(loader)}\\.d\\(${escapeRegExp(exportsName)},\\{runMainAppStartup:\\(\\)=>(${IDENT})\\}\\)`, "gu"), true), "published startup export");
  if (!evaluatedAt(factory.body, publication.index)) throw new Error("Startup export is not evaluated in its factory");
  const head = one(codeMatches(factory.body, new RegExp(`\\b(?:async )?function ${escapeRegExp(publication[1])}\\((?:${IDENT})?\\)\\{`, "gu"), true), "published startup declaration");
  if (!statementAt(factory.body, head.index)) throw new Error("Published startup is not a factory declaration");
  const open = head.index + head[0].length - 1, close = findMatchingBrace(factory.body, open);
  if (close < open) throw new Error("Published startup is incomplete");
  return { start: factory.start + open + 1, end: factory.start + close, body: factory.body.slice(open + 1, close), name: publication[1] };
}

function declaredBinding(body, parameters, name) {
  try { new Script(`async function __portalBindingName(${name}){}`); }
  catch { return false; }
  // A final source-map line comment must not consume the synthetic suffix.
  new Script(`async function __portalBinding(${parameters}){\n${body}\n}`);
  try { new Script(`async function __portalBinding(${parameters}){\n${body}\n;let ${name};\n}`); return false; }
  catch { return true; }
}

function windowWiringPlan(source, owner) {
  const startup = publishedStartup(owner.factory);
  const lifecycleHeader = new RegExp(`function\\(\\{((?:${IDENT}:${IDENT},)*isWindows:${IDENT},(?:${IDENT}:${IDENT},)*hotkeyWindowLifecycleManager:${IDENT},globalDictationLifecycleManager:${IDENT},(?:${IDENT}:${IDENT},)*flushAndDisposeContext:${IDENT},disposables:${IDENT}(?:,${IDENT}:${IDENT})*)\\}\\)\\{`, "gu");
  const header = one(codeMatches(startup.body, lifecycleHeader, true), "current accepted-quit installer");
  if (!evaluatedAt(startup.body, header.index)) throw new Error("Quit installer is not evaluated by published startup");
  const localOpen = header.index + header[0].length - 1;
  const call = directObjectCall(source, startup.start + localOpen);
  const parameters = header[1].split(",").map(value => value.split(":"));
  const aliases = Object.fromEntries(parameters);
  if (Object.keys(aliases).length !== parameters.length) throw new Error("Duplicate quit-installer parameter role");
  for (const name of ["isWindows", "disableQuitConfirmationPrompt", "quitState", "windows", "globalState", "settingsStore", "stopCodexMicro", "flushTracingBeforeQuit", "flushAndDisposeContext", "disposables"]) {
    if (!aliases[name]) throw new Error(`Quit installer has no ${name} parameter`);
  }
  const argumentsProperties = objectProperties(call.arguments, "Quit arguments");
  const windows = rootProperty(argumentsProperties, "windows");
  if (!new RegExp(`^${IDENT}$`, "u").test(windows) ||
      rootProperty(argumentsProperties, "hotkeyWindowLifecycleManager") !== `${windows}.hotkeyWindowLifecycleManager` ||
      rootProperty(argumentsProperties, "globalDictationLifecycleManager") !== `${windows}.globalDictationLifecycleManager`) {
    throw new Error("Quit installer is disconnected from its window shortcut owners");
  }
  const producerHead = one(codeMatches(startup.body,
    new RegExp(`(?:let|const|var) ${escapeRegExp(windows)}=function\\(\\{([^{}]*)\\}\\)\\{`, "gu"), true), "accepted-quit window producer");
  if (!evaluatedAt(startup.body, producerHead.index) || producerHead.index >= header.index) throw new Error("Window producer is not evaluated before quit installation");
  const producerOpen = startup.start + producerHead.index + producerHead[0].length - 1;
  const producer = directObjectCall(source, producerOpen);
  if (producer.end > startup.start + header.index) throw new Error("Quit installation is nested inside its window producer");
  const producerBody = source.slice(producerOpen + 1, producer.close);
  const returned = one(codeMatches(producerBody, /\breturn\{/gu, true), "returned native window services");
  const resultOpen = producerOpen + 1 + returned.index + "return".length, resultClose = findMatchingBrace(source, resultOpen);
  if (source.slice(resultClose + 1, producer.close).trim() !== "") throw new Error("Native window services are not the returned producer result");
  const resultBody = source.slice(resultOpen + 1, resultClose), roles = {};
  const windowProperties = objectProperties(resultBody, "Window services", true);
  for (const name of ["windowManager", "avatarOverlayManager", "notchOverlayManager", "spotlightController", "hotkeyWindowLifecycleManager", "globalDictationLifecycleManager"]) {
    roles[name] = rootProperty(windowProperties, name);
    if (!new RegExp(`^${IDENT}$`, "u").test(roles[name]) || !declaredBinding(producerBody, `{${producerHead[1]}}`, roles[name])) throw new Error(`Unbound native window ${name}`);
  }
  return { startup, header, call, aliases, producer, producerBody, producerParameters: producerHead[1], windowProperties, roles };
}

function lifecyclePlan(source, owner) {
  const { startup, header, call, aliases, producer, windowProperties, roles } = windowWiringPlan(source, owner);
  const mark = windowProperties.get("markAppQuitting");
  const markValue = `()=>{${roles.windowManager}.markAppQuitting(),${roles.avatarOverlayManager}.markAppQuitting(),${roles.notchOverlayManager}?.markAppQuitting(),${roles.spotlightController}.dispose()}`;
  if (!mark || mark.value !== markValue) throw new Error("Accepted application quit before window cleanup is unavailable");
  const electron = owner.body.match(new RegExp(`(${IDENT})\\.globalShortcut\\.unregister\\(`, "u"))?.[1];
  const body = source.slice(call.open + 1, call.close);
  if (declaredBinding(body, `{${header[1]}}`, electron)) throw new Error("Quit installer shadows its Electron owner");
  for (const name of ["require", "process", "Promise", "Set", "Map", "Object", "String", "Boolean", "Error", "console", "setTimeout", "clearTimeout"]) {
    if (declaredBinding(source, "", name) || declaredBinding(owner.factory.body, owner.factory.parameters.join(","), name)) throw new Error(`Shared Portal shadows ${name}`);
  }
  if (declaredBinding(startup.body, "", "Promise")) throw new Error("Quit startup shadows its drain Promise");
  const beforeHeader = one(codeMatches(body, new RegExp(`${escapeRegExp(electron)}\\.app\\.on\\(${literal("before-quit")},(${IDENT})=>\\{`, "gu"), true), "native before-quit callback");
  const beforeOpen = beforeHeader.index + beforeHeader[0].length - 1, beforeClose = findMatchingBrace(body, beforeOpen), before = body.slice(beforeOpen + 1, beforeClose);
  const bypass = new RegExp(`if\\(${aliases.isWindows}\\|\\|${aliases.quitState}\\.canQuitWithoutPrompt\\(\\)\\|\\|${aliases.disableQuitConfirmationPrompt}(?:\\|\\|!${IDENT}&&!${IDENT}&&!${IDENT})?\\)\\{(${IDENT})=!0,${aliases.windows}\\.markAppQuitting\\(\\);return\\}`, "gu");
  one(codeMatches(before, bypass, true), "accepted quit bypass and window marking");
  const rawApproval = new RegExp(`0!==${escapeRegExp(electron)}\\.dialog\\.showMessageBoxSync\\([\\s\\S]*?\\)\\?${beforeHeader[1]}\\.preventDefault\\(\\):\\(${aliases.quitState}\\.markQuitApproved\\(\\),${IDENT}=!0,${aliases.windows}\\.markAppQuitting\\(\\)\\)`, "u");
  const coreApproval = new RegExp(`Promise\\.resolve\\(\\)\\.then\\(\\(\\)=>codexLinuxParent\\?${escapeRegExp(electron)}\\.dialog\\.showMessageBox\\(codexLinuxParent,codexLinuxOptions\\):${escapeRegExp(electron)}\\.dialog\\.showMessageBox\\(codexLinuxOptions\\)\\)\\.then\\((${IDENT})=>\\{codexLinuxQuitPromptPending=!1;if\\(\\1\\.response===0\\)\\{${aliases.quitState}\\.markQuitApproved\\(\\);${escapeRegExp(electron)}\\.app\\.quit\\(\\)\\}\\}\\)`, "u");
  const corePrefix = `if(codexLinuxQuitPromptPending){${beforeHeader[1]}.preventDefault();return}`;
  const raw = codeMatches(before, new RegExp(rawApproval.source, "gu"), true).filter(match => evaluatedAt(before, match.index));
  const core = codeMatches(before, new RegExp(coreApproval.source, "gu"), true).filter(match => evaluatedAt(before, match.index));
  if (raw.length + core.length !== 1 || (core.length && (!before.startsWith(corePrefix) || !before.includes(`let codexLinuxParent=codexLinuxQuitDialogParent(${aliases.windows});`)))) throw new Error("Accepted/cancelled quit confirmation flow is unavailable");
  const willHeader = one(codeMatches(body, new RegExp(`${escapeRegExp(electron)}\\.app\\.on\\(${literal("will-quit")},(${IDENT})=>\\{`, "gu"), true), "native will-quit callback");
  const willOpen = willHeader.index + willHeader[0].length - 1, willClose = findMatchingBrace(body, willOpen), will = body.slice(willOpen + 1, willClose);
  const guard = one(codeMatches(will, new RegExp(`if\\((?:${IDENT}=!0,)?(${IDENT})\\)return;`, "gu"), true), "repeat quit guard");
  const finalizer = one(codeMatches(will, new RegExp(`let (${IDENT})=\\(\\)=>\\{(${IDENT})\\(${aliases.flushAndDisposeContext},5e3\\)\\.then\\(\\(\\)=>\\{${aliases.disposables}\\.dispose\\(\\),${escapeRegExp(electron)}\\.app\\.quit\\(\\)\\}\\)\\}`, "gu"), true), "final quit drain");
  const event = willHeader[1], hotkey = aliases.hotkeyWindowLifecycleManager, dictation = aliases.globalDictationLifecycleManager;
  const disposal = `${event}.preventDefault(),${guard[1]}=!0,${hotkey}.dispose(),${dictation}.dispose(),Promise.allSettled([`;
  const skip = `if(${aliases.quitState}.shouldSkipDrainBeforeQuit()){${disposal}${aliases.globalState}.flush(),${aliases.stopCodexMicro}(),${aliases.flushTracingBeforeQuit}()]).then(${finalizer[1]});return}`;
  const normal = `${disposal}${aliases.globalState}.flush(),${aliases.settingsStore}.flush(),${aliases.stopCodexMicro}(),${aliases.flushTracingBeforeQuit}()]).then(${finalizer[1]})`;
  if (!will.includes(skip) || !will.endsWith(normal)) throw new Error("Both native accepted-quit drain branches are required");
  return { factory: owner.factory, startup, producer, call, aliases, electron, quitStart: startup.start + header.index, quitOpen: call.open, quitClose: call.close };
}

function applyCurrentPortalBackend(source) {
  const owned = registrationOwner(source);
  lifecyclePlan(source, owned);
  const contract = owned;
  const { accelerator: e, callbacks: t } = contract;
  const entryMatch = contract.body.match(new RegExp(
    `if\\(\\[\\.\\.\\.(?<registry>${IDENT})\\]\\.some\\((?<item>${IDENT})=>\\k<item>\\.registrationHotkey===(?<key>${IDENT})\\)\\)return null;` +
    `let (?<entry>${IDENT})=\\{onCancelled:(?<callbacks>${IDENT})\\.onCancelled,hotkey:${escapeRegExp(e)},onPressed:[\\s\\S]{0,400}?,registrationHotkey:\\k<key>,generation:0,registered:!1\\},${IDENT}=(?<activate>${IDENT})\\(\\k<entry>\\)`, "u"));
  if (!entryMatch) throw new Error("global shortcut registry lifecycle was not found");
  const { registry, entry, callbacks, activate } = entryMatch.groups;
  const electron = contract.body.match(new RegExp(`(${IDENT})\\.globalShortcut\\.unregister\\(`, "u"))?.[1];
  if (!electron) throw new Error("global shortcut Electron backend was not found");
  let body = contract.body.replace(`let ${entry}={onCancelled:`,
    `let ${entry}={linuxCommandId:${t}.linuxCommandId,linuxCallbacks:{...${callbacks},onUnavailable:${t}.onUnavailable},onCancelled:`);
  body = replaceUnique(body, new RegExp(`handlesRelease:${notNull(`(${IDENT})`)}(?=,unregister:)`, "u"),
    (match) => `${match}||null!=${entry}.portalRegistration`, "release-aware registration handle");
  body = replaceUnique(body, new RegExp(`${escapeRegExp(electron)}\\.globalShortcut\\.unregister\\(${escapeRegExp(entry)}\\.registrationHotkey\\)`, "u"),
    `null!=${entry}.portalRegistration?${entry}.portalRegistration.unregister():${electron}.globalShortcut.unregister(${entry}.registrationHotkey)`, "registration disposal");
  let patched = source.slice(0, contract.start) + body + source.slice(contract.end);
  const anchorText = body.slice(0, 120);
  const uniqueAnchor = (pattern, description) => {
    const matches = [...patched.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))];
    if (matches.length !== 1) throw new Error(`${description} matched ${matches.length} times`);
    assertSameModule(patched, patched.indexOf(anchorText), matches[0].index, description);
    return matches[0];
  };
  const { getAccess, accessReady } = uniqueAnchor(new RegExp(`function (?<getAccess>${IDENT})\\(\\)\\{if\\(!(?<accessReady>${IDENT})\\)return\\{status:${literal("loading")}\\};let\\{codexLocalAccess:e,workCloudAccess:t,workLocalAccess:(?<local>${IDENT})\\}=${IDENT};return\\{status:${literal("ready")},codexLocalAccess:e,workCloudAccess:t,workLocalAccess:\\k<local>\\}\\}`, "u"),
    "application access readiness").groups;
  const accessFactory = registrationOwner(patched).factory;
  const accessDeclaration = one(codeMatches(accessFactory.body, new RegExp(`function ${escapeRegExp(getAccess)}\\(`, "gu"), true), "application access declaration");
  if (!statementAt(accessFactory.body, accessDeclaration.index)) throw new Error("Application access getter is not a factory declaration");
  uniqueAnchor(new RegExp(`${escapeRegExp(accessReady)}&&\\(${IDENT}\\|\\|${IDENT}\\)&&${IDENT}\\.forEach\\((${IDENT})=>\\{\\1\\(\\)\\}\\),${IDENT}\\}`, "u"), "application access publication");
  patched = replaceUnique(patched,
    new RegExp(`${escapeRegExp(accessReady)}&&\\(${IDENT}\\|\\|${IDENT}\\)&&${IDENT}\\.forEach\\((${IDENT})=>\\{\\1\\(\\)\\}\\),${IDENT}\\}`, "u"),
    match => match.replace(/,([\w$]+)\}$/u, ",codexLinuxGlobalShortcutsPortalSchedule(),$1}"), "application access publication");
  const quitting = new RegExp(
    `markAppQuitting:\\(\\)=>\\{(?=[^{}]{0,240}?(?:${IDENT}(?:\\?\\.|\\.)markAppQuitting\\(\\),){2,}${IDENT}\\.dispose\\(\\)\\})`,
    "u",
  );
  uniqueAnchor(quitting, "accepted application quit before window cleanup");
  patched = replaceUnique(patched, quitting,
    match => `${match}codexLinuxGlobalShortcutsPortalShutdown();`, "accepted application quit before window cleanup");
  // Accepted quit (will-quit): upstream disposes the shortcut owners and then
  // drains asynchronously. Stop the portal session before that disposal and
  // make the drain wait for the helper to release its session.
  const quitLifecycle = new RegExp(`function(?: ${IDENT})?\\(\\{(?:${IDENT}:${IDENT},)*hotkeyWindowLifecycleManager:(?<hotkey>${IDENT}),globalDictationLifecycleManager:(?<dictation>${IDENT}),(?:${IDENT}:${IDENT},)*flushAndDisposeContext:${IDENT},(?:${IDENT}:${IDENT},)*disposables:${IDENT}(?:,${IDENT}:${IDENT})*\\}\\)\\{`, "u");
  const quitHeader = uniqueAnchor(quitLifecycle, "accepted application quit lifecycle");
  const quitOpen = quitHeader.index + quitHeader[0].length - 1;
  const quitClose = findMatchingBrace(patched, quitOpen);
  if (quitClose === -1) throw new Error("accepted application quit lifecycle is incomplete");
  const quitBody = patched.slice(quitOpen, quitClose + 1);
  const willQuit = new RegExp(`\\.on\\(${literal("will-quit")},`, "u").exec(quitBody);
  const quitDisposal = `${quitHeader.groups.hotkey}.dispose(),${quitHeader.groups.dictation}.dispose(),Promise.allSettled([`;
  const quitDisposals = quitBody.split(quitDisposal).length - 1;
  if (willQuit == null || quitDisposals < 1 || quitBody.indexOf(quitDisposal) < willQuit.index) {
    throw new Error("application shutdown before shortcut disposal matched 0 times");
  }
  patched = patched.slice(0, quitOpen) + quitBody.replaceAll(quitDisposal,
    `codexLinuxGlobalShortcutsQuitStopped=codexLinuxGlobalShortcutsPortalShutdown(),${quitDisposal}codexLinuxGlobalShortcutsQuitStopped,`) +
    patched.slice(quitClose + 1);
  // Capture suspension: the first nested suspend pauses the portal session and
  // stops unregistering Electron accelerators that a portal registration owns.
  const suspend = new RegExp(`if\\(1===\\((?<depth>${IDENT})\\+=1\\)\\)for\\(let (?<item>${IDENT}) of\\((?<effects>(?:${IDENT}\\(!0\\),)*)${escapeRegExp(registry)}\\)\\)` +
    `\\k<item>\\.onCancelled\\?\\.\\(\\),\\k<item>\\.registered=!1,${escapeRegExp(electron)}\\.globalShortcut\\.unregister\\(\\k<item>\\.registrationHotkey\\)`, "u");
  const { depth } = uniqueAnchor(suspend, "global shortcut suspension").groups;
  patched = replaceUnique(patched, suspend, (_match, depthVar, item, effects) =>
    `if(1===(${depthVar}+=1))for(let ${item} of(codexLinuxGlobalShortcutsCaptureReady=codexLinuxGlobalShortcutsPortalPause(),${effects}${registry}))` +
    `${item}.onCancelled?.(),${item}.registered=!1,null==${item}.portalRegistration&&${electron}.globalShortcut.unregister(${item}.registrationHotkey)`,
  "global shortcut suspension");
  const activation = new RegExp(`function ${escapeRegExp(activate)}\\((${IDENT})\\)\\{let (${IDENT})=\\+\\+\\1\\.generation;`, "u");
  uniqueAnchor(activation, "Wayland registration adapter");
  patched = replaceUnique(patched, activation,
    (match, item, generation) => `${match}if(codexLinuxGlobalShortcutsUsesWayland()&&null!=${item}.linuxCommandId&&${item}.hotkey.includes("+"))return codexLinuxGlobalShortcutsActivate(${item},${generation});`, "Wayland registration adapter");
  const capture = new RegExp(`beginCapture\\(\\)\\{if\\(this\\.origin\\.isDestroyed\\(\\)\\)return null;let (${IDENT})=${escapeRegExp(electron)}\\.BrowserWindow\\.fromWebContents\\(this\\.origin\\);return ${notNull("\\1")}&&\\1\\.isFocused\\(\\)\\?new (${IDENT})\\(this\\.origin,\\1\\):null\\}`, "u");
  uniqueAnchor(capture, "shortcut capture readiness");
  patched = replaceUnique(patched, capture,
    (_match, _window, Capture) => `async beginCapture(){if(this.origin.isDestroyed())return null;let e=${electron}.BrowserWindow.fromWebContents(this.origin);if(null==e||!e.isFocused())return null;let t=new ${Capture}(this.origin,e);try{await codexLinuxGlobalShortcutsCaptureReady;if(this.origin.isDestroyed()||e.isDestroyed()||!e.isFocused()){t[Symbol.dispose]();return null}return t}catch(n){t[Symbol.dispose]();console.warn("[linux-global-shortcuts] Unable to prepare shortcut capture",n);return null}}`, "shortcut capture readiness");
  return insertBeforeRegistration(patched, portalHelperSource({ getAccess, depth, registry }));
}

function portalRuntimeFunctions() {
  return [codexLinuxGlobalShortcutsUsesWayland, codexLinuxGlobalShortcutsNativePath,
    codexLinuxGlobalShortcutsLines, codexLinuxGlobalShortcutsRequested, codexLinuxGlobalShortcutsUnavailable,
    codexLinuxGlobalShortcutsPortalRegistration, codexLinuxGlobalShortcutsPortalPause, codexLinuxGlobalShortcutsPortalShutdown,
    codexLinuxGlobalShortcutsPortalSchedule, codexLinuxGlobalShortcutsPortalStart,
    codexLinuxGlobalShortcutsPaste, codexLinuxGlobalShortcutsActivate];
}

function portalHelperSource({ getAccess, depth, registry }) {
  return `var codexLinuxGlobalShortcutsPatch=${JSON.stringify(PATCH_MARKER)},codexLinuxGlobalShortcutsPortalRegistrations=new Set(),codexLinuxGlobalShortcutsPortalBackend=null,codexLinuxGlobalShortcutsPortalQueue=Promise.resolve(),codexLinuxGlobalShortcutsPortalScheduled=false,codexLinuxGlobalShortcutsShuttingDown=false,codexLinuxGlobalShortcutsQuitStopped=null,codexLinuxGlobalShortcutsCaptureReady=Promise.resolve();` +
    `function codexLinuxGlobalShortcutsAccessReady(){return"ready"===${getAccess}().status}function codexLinuxGlobalShortcutsIsSuspended(){return ${depth}>0}function codexLinuxGlobalShortcutsManagerHas(e){return ${registry}.has(e)}` +
    portalRuntimeFunctions().map(String).join("");
}

function portalBlock(source) {
  const owner = registrationOwner(source), factory = owner.factory;
  const start = one(ownedMatches(source, /\bvar codexLinuxGlobalShortcutsPatch=/gu, factory)
    .filter(match => statementAt(factory.body, match.index - factory.start)), "shared Portal declaration").index;
  const last = one(ownedMatches(source, /\bfunction codexLinuxGlobalShortcutsActivate\(/gu, factory)
    .filter(match => statementAt(factory.body, match.index - factory.start)), "shared Portal runtime tail");
  const open = source.indexOf("{", last.index), end = findMatchingBrace(source, open) + 1;
  if (start >= last.index || end > owner.start) throw new Error("Shared Portal runtime is outside its registration scope");
  return { start, end, text: source.slice(start, end), owner };
}

function replaceCount(source, from, to, expected, description) {
  if (source.split(from).length - 1 !== expected) throw new Error(`${description} is incomplete or ambiguous`);
  return source.split(from).join(to);
}

function portalNames() {
  return new Set([
    ...portalRuntimeFunctions().map(fn => fn.name),
    "codexLinuxGlobalShortcutsPatch", "codexLinuxGlobalShortcutsPortalRegistrations", "codexLinuxGlobalShortcutsPortalBackend",
    "codexLinuxGlobalShortcutsPortalQueue", "codexLinuxGlobalShortcutsPortalScheduled", "codexLinuxGlobalShortcutsShuttingDown",
    "codexLinuxGlobalShortcutsQuitStopped", "codexLinuxGlobalShortcutsCaptureReady", "codexLinuxGlobalShortcutsAccessReady",
    "codexLinuxGlobalShortcutsIsSuspended", "codexLinuxGlobalShortcutsManagerHas",
  ]);
}

function assertPortalBindings(source) {
  const names = portalNames();
  for (const token of source.matchAll(/(?:\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})|[\w$])+/gu)) {
    if (!token[0].includes("\\u")) continue;
    let decoded;
    try { decoded = token[0].replace(/\\u(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{4}))/gu, (_, braced, fixed) => String.fromCodePoint(parseInt(braced || fixed, 16))); }
    catch { continue; }
    if (names.has(decoded) && codeAt(source, token.index)) throw new Error("Escaped shared Portal binding outside its runtime");
  }
  for (const name of names) {
    for (const reference of source.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "gu"))) {
      if (!codeAt(source, reference.index)) continue;
      const end = reference.index + name.length;
      const following = source.slice(end).replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*/u, "");
      if (/^(?:\.|:|\?\.)/u.test(following)) continue;
      const parses = replacement => {
        try { new Script(source.slice(0, reference.index) + replacement + source.slice(end)); return true; }
        catch { return false; }
      };
      if (!parses("(0)") && !parses(`${name}:(0)`)) throw new Error("Shared Portal binding is shadowed or reassigned");
    }
  }
}

function restoreCurrentPortalSource(source, block) {
  let restored = source.slice(0, block.start) + source.slice(block.end);
  const contract = registrationContract(restored), callbacks = contract.callbacks;
  const entry = one([...contract.body.matchAll(new RegExp(`let (${IDENT})=\\{linuxCommandId:${escapeRegExp(callbacks)}\\.linuxCommandId,linuxCallbacks:\\{\\.\\.\\.(${IDENT}),onUnavailable:${escapeRegExp(callbacks)}\\.onUnavailable\\},onCancelled:`, "gu"))], "canonical Portal registration entry");
  const electron = contract.body.match(new RegExp(`(${IDENT})\\.globalShortcut\\.unregister\\(`, "u"))?.[1];
  const injectedEntry = `linuxCommandId:${callbacks}.linuxCommandId,linuxCallbacks:{...${entry[2]},onUnavailable:${callbacks}.onUnavailable},`;
  restored = replaceCount(restored, injectedEntry, "", 1, "Portal registration callback capture");
  restored = replaceCount(restored, `||null!=${entry[1]}.portalRegistration`, "", 1, "Portal release capability");
  restored = replaceCount(restored, `null!=${entry[1]}.portalRegistration?${entry[1]}.portalRegistration.unregister():${electron}.globalShortcut.unregister(${entry[1]}.registrationHotkey)`,
    `${electron}.globalShortcut.unregister(${entry[1]}.registrationHotkey)`, 1, "Portal registration disposal");
  restored = replaceCount(restored, ",codexLinuxGlobalShortcutsPortalSchedule(),", ",", 1, "Portal access publication");
  restored = replaceCount(restored, "codexLinuxGlobalShortcutsPortalShutdown();", "", 1, "Portal accepted quit initiation");
  restored = replaceCount(restored, "codexLinuxGlobalShortcutsQuitStopped=codexLinuxGlobalShortcutsPortalShutdown(),", "", 2, "Portal quit drain initiation");
  restored = replaceCount(restored, "Promise.allSettled([codexLinuxGlobalShortcutsQuitStopped,", "Promise.allSettled([", 2, "Portal quit drain completion");
  restored = replaceCount(restored, "codexLinuxGlobalShortcutsCaptureReady=codexLinuxGlobalShortcutsPortalPause(),", "", 1, "Portal capture suspension");
  const suspend = one([...restored.matchAll(new RegExp(`null==(${IDENT})\\.portalRegistration&&${escapeRegExp(electron)}\\.globalShortcut\\.unregister\\(\\1\\.registrationHotkey\\)`, "gu"))], "Portal suspended registration disposal");
  restored = restored.slice(0, suspend.index) + suspend[0].replace(`null==${suspend[1]}.portalRegistration&&`, "") + restored.slice(suspend.index + suspend[0].length);
  const adapter = one([...restored.matchAll(new RegExp(`if\\(codexLinuxGlobalShortcutsUsesWayland\\(\\)&&null!=(${IDENT})\\.linuxCommandId&&\\1\\.hotkey\\.includes\\("\\+"\\)\\)return codexLinuxGlobalShortcutsActivate\\(\\1,${IDENT}\\);`, "gu"))], "Portal activation adapter");
  restored = restored.slice(0, adapter.index) + restored.slice(adapter.index + adapter[0].length);
  const capture = one(codeMatches(restored, /async beginCapture\(\)\{/gu).map(head => {
    const open = head.index + head[0].length - 1, close = findMatchingBrace(restored, open);
    return { start: head.index, end: close + 1, text: restored.slice(head.index, close + 1) };
  }).filter(span => span.text.includes("await codexLinuxGlobalShortcutsCaptureReady;")), "Portal asynchronous shortcut capture");
  const constructor = one([...capture.text.matchAll(new RegExp(`let t=new (${IDENT})\\(this\\.origin,e\\);`, "gu"))], "Portal capture constructor")[1];
  const originalCapture = `beginCapture(){if(this.origin.isDestroyed())return null;let e=${electron}.BrowserWindow.fromWebContents(this.origin);return null!=e&&e.isFocused()?new ${constructor}(this.origin,e):null}`;
  restored = restored.slice(0, capture.start) + originalCapture + restored.slice(capture.end);
  assertPortalBindings(restored);
  return restored;
}

function hasPortalArtifact(source) {
  return source.includes(PATCH_MARKER) || /(?:function |var |let |const )codexLinuxGlobalShortcuts/u.test(source) || source.includes("codexLinuxGlobalShortcutsQuitStopped") || source.includes("codexLinuxGlobalShortcutsPortalShutdown(");
}

function installPortalBackend(source) {
  if (!hasPortalArtifact(source)) {
    assertPortalBindings(source);
    return applyCurrentPortalBackend(source);
  }
  if (source.split(PATCH_MARKER).length - 1 !== 1) throw new Error("Shared Portal marker is incomplete or duplicated");
  const block = portalBlock(source), current = restoreCurrentPortalSource(source, block);
  const expected = applyCurrentPortalBackend(current), expectedBlock = portalBlock(expected);
  if (block.text !== expectedBlock.text ||
      source.slice(0, block.start) + source.slice(block.end) !== expected.slice(0, expectedBlock.start) + expected.slice(expectedBlock.end)) {
    throw new Error("Shared Portal payload or lifecycle hooks are incomplete");
  }
  return source;
}

// Consumer-facing semantic metadata. The source parser and validation plan stay
// private, and every range below belongs to the actual supplied source.
function inspectGlobalShortcutsPortal(source) {
  const result = { state: "unrelated", reason: null, factoryIds: [], owner: null };
  if (typeof source !== "string") return { ...result, state: "drifted", reason: "Expected main-process source text" };
  try {
    result.factoryIds = mainFactories(source).map(factory => factory.identity);
  } catch (error) {
    const authorityHint = codeMatches(source,
      /(?<![\w$.])exports\s*(?:\.\s*(?:ids|modules)|\[\s*(?:"(?:ids|modules)"|'(?:ids|modules)')\s*\])/gu).length > 0;
    return { ...result, state: error instanceof SyntaxError || authorityHint || hasPortalArtifact(source) ? "drifted" : "unrelated", reason: error.message };
  }
  let owned;
  try { owned = registrationOwner(source); }
  catch (error) {
    return { ...result, state: hasPortalArtifact(source) || !/registration owner matched 0 times/u.test(error.message) ? "drifted" : "unrelated", reason: error.message };
  }
  try {
    const installed = installPortalBackend(source);
    const wiring = windowWiringPlan(source, owned);
    const bindings = Object.fromEntries([...wiring.windowProperties]
      .filter(([name, property]) => name !== "__proto__" && typeof property.value === "string" &&
        new RegExp(`^${IDENT}$`, "u").test(property.value) &&
        declaredBinding(wiring.producerBody, `{${wiring.producerParameters}}`, property.value))
      .map(([name, property]) => [name, property.value]));
    const { factory, ...registration } = owned;
    return {
      state: installed === source ? "shared" : "current", reason: null,
      factoryIds: result.factoryIds,
      owner: {
        id: factory.identity,
        factoryBody: { start: factory.start, end: factory.end },
        registration,
        windowServices: {
          body: { start: wiring.producer.open + 1, end: wiring.producer.close },
          bindings,
        },
      },
    };
  } catch (error) { return { ...result, state: "drifted", reason: error.message }; }
}

module.exports = {
  IDENT, PATCH_MARKER, literal, platformIs, replaceUnique, registrationContract, registrationFunction,
  insertBeforeRegistration, replaceInRegistrationModule, tagCommand, installPortalBackend, inspectGlobalShortcutsPortal,
};
