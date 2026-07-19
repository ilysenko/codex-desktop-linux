"use strict";

const PATCH_MARKER = "codex-linux-global-dictation-v2";
const IDENT = "[A-Za-z_$][\\w$]*";

function warn(message) {
  console.warn(`WARN: ${message} - skipping Linux global dictation patch`);
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceUnique(source, pattern, replacement, description) {
  const globalPattern = new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`);
  const matches = [...source.matchAll(globalPattern)];
  if (matches.length !== 1) {
    throw new Error(`${description} matched ${matches.length} times`);
  }
  return source.replace(pattern, replacement);
}

function codexLinuxGlobalDictationUsesWayland() {
  const sessionType = String(process.env.XDG_SESSION_TYPE ?? "").toLowerCase();
  return (
    process.platform === "linux" &&
    (sessionType === "wayland" ||
      (sessionType !== "x11" && !process.env.DISPLAY && Boolean(process.env.WAYLAND_DISPLAY)))
  );
}

function codexLinuxGlobalDictationNativePath(name) {
  const fs = require("node:fs");
  const path = require("node:path");
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, "native", name));
  try {
    const appPath = require("electron").app?.getAppPath?.();
    if (appPath) candidates.push(path.join(appPath, "native", name));
  } catch {}
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function codexLinuxGlobalDictationLines(stream, onLine) {
  let buffer = "";
  stream?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) {
      buffer = "";
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      onLine(buffer.slice(0, newline).trim());
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  });
}

async function codexLinuxGlobalDictationPaste() {
  for (const registration of codexLinuxGlobalDictationPortalRegistrations) {
    if (registration.ready()) return registration.paste();
  }
  throw new Error("No ready Wayland global dictation helper is available.");
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

function codexLinuxGlobalDictationPortalRegistration(accelerator, callbacks) {
  const helperPath = codexLinuxGlobalDictationNativePath("codex-global-dictation-linux");
  if (helperPath == null) return null;

  let child = null;
  let closed = false;
  let pressed = false;
  let isReady = false;
  let stderr = "";
  let registrationTimer = null;
  let pasteTimer = null;
  let queueResolve = null;
  let pasteResolve = null;
  let pasteReject = null;
  let registration = null;

  const finishQueue = () => {
    queueResolve?.();
    queueResolve = null;
  };
  const finishPaste = (error) => {
    if (pasteTimer != null) clearTimeout(pasteTimer);
    pasteTimer = null;
    const resolve = pasteResolve;
    const reject = pasteReject;
    pasteResolve = null;
    pasteReject = null;
    if (error) reject?.(error);
    else resolve?.();
  };
  const close = (error, notifyUnavailable) => {
    if (closed) return;
    closed = true;
    if (registrationTimer != null) clearTimeout(registrationTimer);
    codexLinuxGlobalDictationPortalRegistrations.delete(registration);
    if (pressed) callbacks.onReleased?.();
    try {
      child?.kill();
    } catch {}
    finishQueue();
    finishPaste(error);
    if (notifyUnavailable) setTimeout(() => callbacks.onUnavailable?.(error), 0);
  };
  const fail = (error) => close(error, true);
  const start = () =>
    new Promise((resolve) => {
      queueResolve = resolve;
      if (closed) {
        finishQueue();
        return;
      }
      try {
        child = require("node:child_process").spawn(
          helperPath,
          ["portal", "--accelerator", accelerator],
          { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
      } catch (error) {
        fail(error);
        return;
      }
      registrationTimer = setTimeout(
        () => fail(new Error("Global shortcuts portal registration timed out.")),
        30000,
      );
      registrationTimer.unref?.();
      codexLinuxGlobalDictationLines(child.stdout, (line) => {
        if (line === "ready") {
          isReady = true;
          if (registrationTimer != null) clearTimeout(registrationTimer);
          codexLinuxGlobalDictationPortalRegistrations.add(registration);
          finishQueue();
        } else if (line === "down" && isReady && !pressed) {
          pressed = true;
          callbacks.onPressed();
        } else if (line === "up" && isReady && pressed) {
          pressed = false;
          callbacks.onReleased?.();
        } else if (line === "paste-ok") {
          finishPaste();
        } else if (line.startsWith("paste-error:")) {
          finishPaste(new Error(line.slice(12) || "Wayland paste failed."));
        } else if (line !== "") {
          console.warn("[linux-global-dictation] Ignoring helper message");
        }
      });
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      });
      child.once("error", fail);
      child.once("exit", (code) => {
        if (!closed) {
          fail(
            new Error(
              stderr.trim() ||
                `Global shortcuts portal helper exited with code ${code ?? "unknown"}.`,
            ),
          );
        }
      });
    });

  registration = {
    handlesRelease: true,
    ready: () => isReady && !closed,
    paste: () =>
      new Promise((resolve, reject) => {
        if (!isReady || closed) {
          reject(new Error("Wayland global dictation helper is not ready."));
          return;
        }
        if (pasteReject != null) {
          reject(new Error("A Wayland paste request is already pending."));
          return;
        }
        pasteResolve = resolve;
        pasteReject = reject;
        pasteTimer = setTimeout(
          () => fail(new Error("Wayland global dictation paste timed out.")),
          35000,
        );
        pasteTimer.unref?.();
        try {
          child.stdin.write("paste\n", (error) => {
            if (error) fail(error);
          });
        } catch (error) {
          fail(error);
        }
      }),
    unregister: () =>
      close(new Error("Wayland global dictation helper was stopped."), false),
  };
  codexLinuxGlobalDictationPortalQueue = codexLinuxGlobalDictationPortalQueue.then(start, start);
  return registration;
}

function codexLinuxGlobalDictationReleaseWatcher(accelerator, onReleased) {
  const helperPath = codexLinuxGlobalDictationNativePath("global-dictation-release-monitor");
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
    dispose: () => {
      finished = true;
      child.kill();
    },
  };
}

function helperSource() {
  return [
    `var codexLinuxGlobalDictationPatch=${JSON.stringify(PATCH_MARKER)};`,
    codexLinuxGlobalDictationUsesWayland,
    codexLinuxGlobalDictationNativePath,
    codexLinuxGlobalDictationLines,
    "var codexLinuxGlobalDictationPortalQueue=Promise.resolve(),codexLinuxGlobalDictationPortalRegistrations=new Set();",
    codexLinuxGlobalDictationPaste,
    codexLinuxGlobalDictationPortalRegistration,
    codexLinuxGlobalDictationReleaseWatcher,
    codexLinuxGlobalDictationPasteX11,
  ]
    .map(String)
    .join("");
}

function applyLinuxGlobalDictationMainProcessPatch(source) {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }
  if (!source.includes("Global dictation hotkey release watching is not supported.")) {
    warn("release watcher sentinel was not found");
    return source;
  }

  try {
    const registerPattern = new RegExp(
      `function (${IDENT})\\(e,t,n\\)\\{if\\((${IDENT})\\(e\\)\\)return (${IDENT})\\(e\\)\\?(${IDENT})\\(e,t,n\\?\\.bareModifierTrigger\\):null;`,
      "u",
    );
    const registerMatch = source.match(registerPattern);
    if (registerMatch == null) {
      throw new Error("global shortcut registration function was not found");
    }
    const registerFunction = registerMatch[1];
    const bareModifierSupportFunction = registerMatch[3];
    const registerFunctionPattern = escapeRegexLiteral(registerFunction);
    const bareModifierSupportPattern = escapeRegexLiteral(bareModifierSupportFunction);
    let patched = replaceUnique(
      source,
      registerPattern,
      (original) =>
        original.replace(
          "{",
          "{if(process.platform===`linux`&&codexLinuxGlobalDictationUsesWayland())return codexLinuxGlobalDictationPortalRegistration(e,t);",
        ),
      "global shortcut registration function",
    );
    patched = `${helperSource()}${patched}`;

    patched = replaceUnique(
      patched,
      new RegExp(
        `function (${IDENT})\\(e\\)\\{return (${IDENT})\\(e\\)\\?\\?\\(${bareModifierSupportPattern}\\(e\\)\\|\\|(${IDENT})\\(e,process\\.platform\\)\\?null:\u0060Shortcut key is not supported for global dictation\\.\u0060\\)\\}`,
        "u",
      ),
      (_original, functionName, baseValidationFunction, releaseValidationFunction) =>
        `function ${functionName}(e){return process.platform===\`linux\`&&${bareModifierSupportFunction}(e)?\`Modifier-only shortcuts are not supported for global dictation on Linux.\`:${baseValidationFunction}(e)??(${bareModifierSupportFunction}(e)||${releaseValidationFunction}(e,process.platform)?null:\`Shortcut key is not supported for global dictation.\`)}`,
      "Linux modifier-only validation",
    );

    patched = replaceUnique(
      patched,
      /case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error\(`Global dictation hotkey release watching is not supported\.`\)/u,
      "case`linux`:{let n=codexLinuxGlobalDictationReleaseWatcher(e,t);if(n==null)throw Error(`Global dictation hotkey release watching is not supported.`);return n}case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`)",
      "Linux release watcher platform branch",
    );

    patched = replaceUnique(
      patched,
      new RegExp(
        "function (" + IDENT + ")\\(e,t\\)\\{return t===`darwin`\\?(" + IDENT + ")\\(e\\)\\.length>0:(" + IDENT + ")\\(e,t\\)!=null\\}",
        "u",
      ),
      (_original, functionName, modifierFunction, keyFunction) =>
        "function " + functionName + "(e,t){return t===`darwin`||t===`linux`?" + modifierFunction + "(e).length>0:" + keyFunction + "(e,t)!=null}",
      "global dictation release validation",
    );

    patched = replaceUnique(
      patched,
      new RegExp(
        "function (" + IDENT + ")\\(\\)\\{return process\\.platform===`darwin`\\|\\|process\\.platform===`win32`\\}",
        "u",
      ),
      (_original, functionName) =>
        "function " + functionName + "(){return process.platform===`darwin`||process.platform===`win32`||process.platform===`linux`}",
      "global dictation platform capability",
    );

    patched = replaceUnique(
      patched,
      /case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error\(`Global dictation paste is not supported on this OS\.`\)/u,
      "case`linux`:if(codexLinuxGlobalDictationUsesWayland()){await codexLinuxGlobalDictationPaste();return}await codexLinuxGlobalDictationPasteX11();return;case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`)",
      "Linux global dictation paste branch",
    );

    const holdRegistration = new RegExp(
      `${registerFunctionPattern}\\(e,\\{onPressed:\\(\\)=>\\{this\\.handleHoldHotkeyPressed\\(\\)\\},onReleased:\\(\\)=>\\{this\\.handleHoldHotkeyReleased\\(\\)\\}\\}\\)`,
      "u",
    );
    patched = replaceUnique(
      patched,
      holdRegistration,
      `${registerFunction}(e,{onPressed:()=>{this.handleHoldHotkeyPressed()},onReleased:()=>{this.handleHoldHotkeyReleased()},onUnavailable:t=>{this.handleLinuxHotkeyUnavailable(\`hold\`,t)}})`,
      "hold hotkey registration",
    );

    const toggleRegistration = new RegExp(
      registerFunctionPattern + "\\(e,\\{onPressed:\\(\\)=>\\{this\\.handleToggleHotkeyPressed\\(\\)\\}\\},\\{bareModifierTrigger:`release`\\}\\)",
      "u",
    );
    patched = replaceUnique(
      patched,
      toggleRegistration,
      registerFunction + "(e,{onPressed:()=>{this.handleToggleHotkeyPressed()},onUnavailable:t=>{this.handleLinuxHotkeyUnavailable(`toggle`,t)}},{bareModifierTrigger:`release`})",
      "toggle hotkey registration",
    );

    patched = replaceUnique(
      patched,
      /unregisterHotkey\(\)\{/u,
      "handleLinuxHotkeyUnavailable(e,t){console.warn(`[linux-global-dictation] ${e} hotkey backend became unavailable`,t),setTimeout(()=>{let t=e===`hold`?this.registeredHotkeyRegistration:this.registeredToggleHotkeyRegistration;t!=null&&this.deactivateLifecycle()},0)}unregisterHotkey(){",
      "hotkey failure cleanup method",
    );
    return patched;
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return source;
  }
}

const descriptors = [
  {
    id: "linux-global-dictation-main-process",
    phase: "main-bundle",
    order: 145,
    apply: applyLinuxGlobalDictationMainProcessPatch,
  },
];

module.exports = {
  applyLinuxGlobalDictationMainProcessPatch,
  descriptors,
};
