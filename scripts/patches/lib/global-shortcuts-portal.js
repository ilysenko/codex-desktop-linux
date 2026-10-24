"use strict";

const { escapeRegExp, findMatchingBrace } = require("./minified-js.js");
const PATCH_MARKER = "codex-linux-global-shortcuts-portal-v1";
const IDENT = "[A-Za-z_$][\\w$]*";

function replaceUnique(source, pattern, replacement, description) {
  const matches = [...source.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))];
  if (matches.length !== 1) throw new Error(`${description} matched ${matches.length} times`);
  return source.replace(pattern, replacement);
}

function registrationContract(source) {
  const pattern = new RegExp(
    `function (?<name>${IDENT})\\(e,t,n\\)\\{[\\s\\S]{0,500}?;` +
    `if\\(process\\.platform===\`win32\`&&${IDENT}\\(e\\)\\)return ${IDENT}\\(e,${IDENT}\\);` +
    `if\\((?<bareModifier>${IDENT})\\(e\\)\\|\\|(?<special>${IDENT})\\(e\\)\\)return ` +
    `${IDENT}\\(e\\)\\|\\|\\k<special>\\(e\\)\\?${IDENT}\\(e,${IDENT},n\\?\\.bareModifierTrigger\\):null;`, "gu");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`global shortcut registration function matched ${matches.length} times`);
  const match = matches[0];
  const end = findMatchingBrace(source, source.indexOf("{", match.index));
  if (end === -1) throw new Error("global shortcut registration function is incomplete");
  const body = source.slice(match.index, end + 1);
  const ownership = new RegExp(`let (${IDENT})=n\\?\\.ownership,(${IDENT})=t\\.onReleased,(${IDENT})=t\\.onCancelled,(${IDENT})=\\1==null\\?t:\\{` +
    `onRegistrationChanged:t\\.onRegistrationChanged,` +
    `onPressed:\\(\\)=>\\{\\1\\.isOwner\\(\\)&&t\\.onPressed\\(\\)\\},` +
    `onReleased:\\2==null\\?void 0:\\(\\)=>\\{\\1\\.isOwner\\(\\)&&\\2\\(\\)\\},` +
    `onCancelled:\\3==null\\?void 0:\\(\\)=>\\{\\1\\.isOwner\\(\\)&&\\3\\(\\)\\}\\}`, "u");
  if (!ownership.test(body)) throw new Error("global shortcut ownership callbacks drifted");
  return { ...match.groups, start: match.index, end: end + 1, body };
}

function registrationFunction(source) {
  return registrationContract(source).name;
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
  const entryMatch = contract.body.match(new RegExp(
    `if\\(\\[\\.\\.\\.(?<registry>${IDENT})\\]\\.some\\(e=>e\\.registrationHotkey===(?<key>${IDENT})\\)\\)return null;` +
    `let (?<entry>${IDENT})=\\{onCancelled:(?<callbacks>${IDENT})\\.onCancelled,hotkey:e,onPressed:${IDENT},registrationHotkey:\\k<key>,generation:0,registered:!1\\},${IDENT}=(?<activate>${IDENT})\\(\\k<entry>\\)`, "u"));
  if (!entryMatch) throw new Error("global shortcut registry lifecycle was not found");
  const { registry, entry, callbacks, activate } = entryMatch.groups;
  const electron = contract.body.match(/([\w$]+)\.globalShortcut\.register\(/)?.[1] ??
    source.match(new RegExp(`function ${escapeRegExp(activate)}\\(e\\)\\{[^}]*?(${IDENT})\\.globalShortcut\\.register`, "u"))?.[1];
  if (!electron) throw new Error("global shortcut Electron backend was not found");
  let body = contract.body.replace(`let ${entry}={onCancelled:`,
    `let ${entry}={linuxCommandId:t.linuxCommandId,linuxCallbacks:{...${callbacks},onUnavailable:t.onUnavailable},onCancelled:`);
  body = replaceUnique(body, /handlesRelease:([\w$]+)!=null/u,
    (_match, watcher) => `handlesRelease:${watcher}!=null||${entry}.portalRegistration!=null`, "release-aware registration handle");
  body = replaceUnique(body, new RegExp(`${escapeRegExp(electron)}\\.globalShortcut\\.unregister\\(${escapeRegExp(entry)}\\.registrationHotkey\\)`, "u"),
    `${entry}.portalRegistration!=null?${entry}.portalRegistration.unregister():${electron}.globalShortcut.unregister(${entry}.registrationHotkey)`, "registration disposal");
  let patched = source.slice(0, contract.start) + body + source.slice(contract.end);
  const accessPattern = new RegExp(`function (?<getAccess>${IDENT})\\(\\)\\{if\\(!(?<accessReady>${IDENT})\\)return\\{status:\`loading\`\\};let\\{codexLocalAccess:e,workCloudAccess:t,workLocalAccess:n\\}=${IDENT};return\\{status:\`ready\`,codexLocalAccess:e,workCloudAccess:t,workLocalAccess:n\\}\\}`, "u");
  const accessMatches = [...patched.matchAll(new RegExp(accessPattern.source, "gu"))];
  if (accessMatches.length !== 1) throw new Error("application access readiness was not found uniquely");
  const { getAccess, accessReady } = accessMatches[0].groups;
  patched = replaceUnique(patched,
    new RegExp(`${escapeRegExp(accessReady)}&&\\(${IDENT}\\|\\|${IDENT}\\)&&${IDENT}\\.forEach\\(e=>\\{e\\(\\)\\}\\),${IDENT}\\}`, "u"),
    match => match.replace(/,([\w$]+)\}$/u, ",codexLinuxGlobalShortcutsPortalSchedule(),$1}"), "application access publication");
  patched = replaceUnique(patched,
    new RegExp(`markAppQuitting:\\(\\)=>\\{(?=${IDENT}\\.markAppQuitting\\(\\),${IDENT}\\.markAppQuitting\\(\\),${IDENT}\\.dispose\\(\\)\\})`, "u"),
    match => `${match}codexLinuxGlobalShortcutsPortalShutdown();`, "accepted application quit before window cleanup");
  patched = replaceUnique(patched,
    new RegExp(`async function ${IDENT}\\(\\{hotkeyWindowLifecycleManager:e,globalDictationLifecycleManager:t,flushAndDisposeContext:n,disposables:r\\}\\)\\{(?=e\\.dispose\\(\\),t\\.dispose\\(\\),await )`, "u"),
    match => `${match}await codexLinuxGlobalShortcutsPortalShutdown();`, "application shutdown before shortcut disposal");
  const suspendPattern = new RegExp(`function (?<suspend>${IDENT})\\(\\)\\{if\\((?<depth>${IDENT})\\+=1,\\k<depth>===1\\)\\{`, "u");
  const suspendMatch = patched.match(suspendPattern);
  if (!suspendMatch) throw new Error("global shortcut suspension was not found");
  const { depth } = suspendMatch.groups;
  patched = replaceUnique(patched, suspendPattern,
    (match) => `${match}codexLinuxGlobalShortcutsCaptureReady=codexLinuxGlobalShortcutsPortalPause();`, "global shortcut suspension");
  patched = replaceUnique(patched,
    new RegExp(`for\\(let e of ${escapeRegExp(registry)}\\)e\\.onCancelled\\?\\.\\(\\),e\\.registered=!1,${escapeRegExp(electron)}\\.globalShortcut\\.unregister\\(e\\.registrationHotkey\\)`, "u"),
    `for(let e of ${registry})e.onCancelled?.(),e.registered=!1,e.portalRegistration==null&&${electron}.globalShortcut.unregister(e.registrationHotkey)`, "suspended registrations");
  patched = replaceUnique(patched,
    new RegExp(`function ${escapeRegExp(activate)}\\(e\\)\\{let t=\\+\\+e\\.generation;`, "u"),
    (match) => `${match}if(codexLinuxGlobalShortcutsUsesWayland()&&e.linuxCommandId!=null&&e.hotkey.includes(\`+\`))return codexLinuxGlobalShortcutsActivate(e,t);`, "Wayland registration adapter");
  patched = replaceUnique(patched,
    new RegExp(`beginCapture\\(\\)\\{if\\(this\\.origin\\.isDestroyed\\(\\)\\)return null;let e=${escapeRegExp(electron)}\\.BrowserWindow\\.fromWebContents\\(this\\.origin\\);return e==null\\|\\|!e\\.isFocused\\(\\)\\?null:new (${IDENT})\\(this\\.origin,e\\)\\}`, "u"),
    (_match, Capture) => `async beginCapture(){if(this.origin.isDestroyed())return null;let e=${electron}.BrowserWindow.fromWebContents(this.origin);if(e==null||!e.isFocused())return null;let t=new ${Capture}(this.origin,e);try{await codexLinuxGlobalShortcutsCaptureReady;if(this.origin.isDestroyed()||e.isDestroyed()||!e.isFocused()){t[Symbol.dispose]();return null}return t}catch(n){t[Symbol.dispose]();console.warn(\`[linux-global-shortcuts] Unable to prepare shortcut capture\`,n);return null}}`, "shortcut capture readiness");
  const functions = [codexLinuxGlobalShortcutsUsesWayland, codexLinuxGlobalShortcutsNativePath,
    codexLinuxGlobalShortcutsLines, codexLinuxGlobalShortcutsRequested, codexLinuxGlobalShortcutsUnavailable,
    codexLinuxGlobalShortcutsPortalRegistration, codexLinuxGlobalShortcutsPortalPause, codexLinuxGlobalShortcutsPortalShutdown,
    codexLinuxGlobalShortcutsPortalSchedule, codexLinuxGlobalShortcutsPortalStart,
    codexLinuxGlobalShortcutsPaste, codexLinuxGlobalShortcutsActivate];
  return `var codexLinuxGlobalShortcutsPatch=${JSON.stringify(PATCH_MARKER)},codexLinuxGlobalShortcutsPortalRegistrations=new Set(),codexLinuxGlobalShortcutsPortalBackend=null,codexLinuxGlobalShortcutsPortalQueue=Promise.resolve(),codexLinuxGlobalShortcutsPortalScheduled=false,codexLinuxGlobalShortcutsShuttingDown=false,codexLinuxGlobalShortcutsCaptureReady=Promise.resolve();` +
    `function codexLinuxGlobalShortcutsAccessReady(){return ${getAccess}().status===\`ready\`}function codexLinuxGlobalShortcutsIsSuspended(){return ${depth}>0}function codexLinuxGlobalShortcutsManagerHas(e){return ${registry}.has(e)}` +
    functions.map(String).join("") + patched;
}

module.exports = { IDENT, PATCH_MARKER, replaceUnique, registrationContract, registrationFunction, tagCommand, installPortalBackend };
