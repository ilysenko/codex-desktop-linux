"use strict";

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

const MODULE_HEADER = /(?:^|[{,])\d+\((?:[A-Za-z_$][\w$]*(?:,[A-Za-z_$][\w$]*){0,2})?\)\{/g;

// rspack chunks hold many module factories. Injected code shares the module
// scope of the registration function, so every lifecycle anchor it captures
// must live in that same factory.
function moduleStartAt(source, index) {
  let start = 0;
  for (const match of source.matchAll(MODULE_HEADER)) {
    if (match.index > index) break;
    start = match.index;
  }
  return start;
}

function assertSameModule(source, anchorIndex, index, description) {
  if (moduleStartAt(source, anchorIndex) !== moduleStartAt(source, index)) {
    throw new Error(`${description} is outside the global shortcut module`);
  }
}

function registrationContract(source) {
  const pattern = new RegExp(
    `function (?<name>${IDENT})\\((?<accelerator>${IDENT}),(?<callbacks>${IDENT}),(?<options>${IDENT})\\)\\{[\\s\\S]{0,500}?;` +
    `if\\(${platformIs("win32")}&&${IDENT}\\(\\k<accelerator>\\)\\)return [\\s\\S]{0,1500}?;` +
    `if\\((?<bareModifier>${IDENT})\\(\\k<accelerator>\\)\\|\\|(?<special>${IDENT})\\(\\k<accelerator>\\)\\)return ` +
    `${IDENT}\\(\\k<accelerator>\\)\\|\\|\\k<special>\\(\\k<accelerator>\\)\\?[\\s\\S]{0,4000}?` +
    `\\(\\k<accelerator>,${IDENT},\\k<options>\\?\\.bareModifierTrigger\\):null;`, "gu");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`global shortcut registration function matched ${matches.length} times`);
  const match = matches[0];
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

function installPortalBackend(source) {
  if (source.includes(PATCH_MARKER)) return source;
  const contract = registrationContract(source);
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
  uniqueAnchor(new RegExp(`${escapeRegExp(accessReady)}&&\\(${IDENT}\\|\\|${IDENT}\\)&&${IDENT}\\.forEach\\((${IDENT})=>\\{\\1\\(\\)\\}\\),${IDENT}\\}`, "u"), "application access publication");
  patched = replaceUnique(patched,
    new RegExp(`${escapeRegExp(accessReady)}&&\\(${IDENT}\\|\\|${IDENT}\\)&&${IDENT}\\.forEach\\((${IDENT})=>\\{\\1\\(\\)\\}\\),${IDENT}\\}`, "u"),
    match => match.replace(/,([\w$]+)\}$/u, ",codexLinuxGlobalShortcutsPortalSchedule(),$1}"), "application access publication");
  const quitting = new RegExp(`markAppQuitting:\\(\\)=>\\{(?=(?:${IDENT}(?:\\?\\.|\\.)markAppQuitting\\(\\),){2,}${IDENT}\\.dispose\\(\\)\\})`, "u");
  uniqueAnchor(quitting, "accepted application quit before window cleanup");
  patched = replaceUnique(patched, quitting,
    match => `${match}codexLinuxGlobalShortcutsPortalShutdown();`, "accepted application quit before window cleanup");
  const shutdown = new RegExp(`async function ${IDENT}\\(\\{hotkeyWindowLifecycleManager:(${IDENT}),globalDictationLifecycleManager:(${IDENT}),flushAndDisposeContext:${IDENT},disposables:${IDENT}\\}\\)\\{(?=\\1\\.dispose\\(\\),\\2\\.dispose\\(\\),await )`, "u");
  uniqueAnchor(shutdown, "application shutdown before shortcut disposal");
  patched = replaceUnique(patched, shutdown,
    match => `${match}await codexLinuxGlobalShortcutsPortalShutdown();`, "application shutdown before shortcut disposal");
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
  const functions = [codexLinuxGlobalShortcutsUsesWayland, codexLinuxGlobalShortcutsNativePath,
    codexLinuxGlobalShortcutsLines, codexLinuxGlobalShortcutsRequested, codexLinuxGlobalShortcutsUnavailable,
    codexLinuxGlobalShortcutsPortalRegistration, codexLinuxGlobalShortcutsPortalPause, codexLinuxGlobalShortcutsPortalShutdown,
    codexLinuxGlobalShortcutsPortalSchedule, codexLinuxGlobalShortcutsPortalStart,
    codexLinuxGlobalShortcutsPaste, codexLinuxGlobalShortcutsActivate];
  return insertBeforeRegistration(patched,
    `var codexLinuxGlobalShortcutsPatch=${JSON.stringify(PATCH_MARKER)},codexLinuxGlobalShortcutsPortalRegistrations=new Set(),codexLinuxGlobalShortcutsPortalBackend=null,codexLinuxGlobalShortcutsPortalQueue=Promise.resolve(),codexLinuxGlobalShortcutsPortalScheduled=false,codexLinuxGlobalShortcutsShuttingDown=false,codexLinuxGlobalShortcutsCaptureReady=Promise.resolve();` +
    `function codexLinuxGlobalShortcutsAccessReady(){return"ready"===${getAccess}().status}function codexLinuxGlobalShortcutsIsSuspended(){return ${depth}>0}function codexLinuxGlobalShortcutsManagerHas(e){return ${registry}.has(e)}` +
    functions.map(String).join(""));
}

module.exports = {
  IDENT, PATCH_MARKER, literal, platformIs, replaceUnique, registrationContract, registrationFunction,
  insertBeforeRegistration, replaceInRegistrationModule, tagCommand, installPortalBackend,
};
