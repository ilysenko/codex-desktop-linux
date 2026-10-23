"use strict";

const PATCH_MARKER = "codex-linux-global-dictation-v3";
const { installPortalBackend, registrationContract } = require("../../scripts/patches/lib/global-shortcuts-portal.js");
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

function applyLinuxGlobalDictationMainProcessPatch(source) {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }
  if (!source.includes("Global dictation hotkey release watching is not supported.")) {
    warn("release watcher sentinel was not found");
    return source;
  }

  try {
    const { name: registerFunction, bareModifier: bareModifierTestFunction } = registrationContract(source);
    const registerFunctionPattern = escapeRegexLiteral(registerFunction);
    let patched = helperSource() + source;
    const currentValidation = new RegExp(
      `function (${IDENT})\\(e\\)\\{(?=if\\(process\\.platform===\`win32\`&&${IDENT}\\(e\\)\\)return[\\s\\S]{0,220}?;let ${IDENT}=${IDENT}\\(e,process\\.platform,\\{allowUnmodified:!0\\}\\))`,
      "u",
    );
    patched = replaceUnique(
      patched,
      currentValidation,
      (_original, functionName) =>
        `function ${functionName}(e){if(process.platform===\`linux\`&&${bareModifierTestFunction}(e))return\`Modifier-only shortcuts are not supported for global dictation on Linux.\`;`,
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
      "case`linux`:if(codexLinuxGlobalShortcutsUsesWayland()){await codexLinuxGlobalShortcutsPaste();return}await codexLinuxGlobalDictationPasteX11();return;case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`)",
      "Linux global dictation paste branch",
    );

    const holdRegistration = new RegExp(
      `${registerFunctionPattern}\\(e,\\{((?:(?!\\},\\{(?:ownership:|bareModifierTrigger:))[\\s\\S]){0,1200}?shortcutGestures\\.press\\(\`primary\`,[\\s\\S]{0,300}?` +
        `shortcutGestures\\.release\\(\`primary\`\\)[\\s\\S]{0,300}?` +
        `shortcutGestures\\.cancelPress\\(\`primary\`\\)[\\s\\S]{0,120}?)\\},` +
        `\\{ownership:(${IDENT})(,bareModifierTrigger:\`cancellablePress\`)\\}\\)`,
      "u",
    );
    patched = replaceUnique(
      patched,
      holdRegistration,
      (_original, callbacks, ownershipVar, extraOptions) =>
        `${registerFunction}(e,{linuxCommandId:"globalDictationHold",${callbacks},onUnavailable:n=>{this.handleLinuxHotkeyUnavailable(\`hold\`,n)}},{ownership:${ownershipVar}${extraOptions}})`,
      "hold hotkey registration",
    );

    const toggleRegistration = new RegExp(
      registerFunctionPattern +
        `\\(e,\\{((?:(?!\\},\\{(?:ownership:|bareModifierTrigger:))[\\s\\S]){0,1200}?shortcutGestures\\.press\\(\`single-tap\`,[\\s\\S]{0,300}?` +
        `shortcutGestures\\.release\\(\`single-tap\`\\)[\\s\\S]{0,300}?` +
        `shortcutGestures\\.cancelPress\\(\`single-tap\`\\)[\\s\\S]{0,120}?)\\},` +
        `\\{bareModifierTrigger:\`cancellablePress\`,ownership:(${IDENT})\\}\\)`,
      "u",
    );
    patched = replaceUnique(
      patched,
      toggleRegistration,
      (_original, callbacks, ownershipVar) => registerFunction + `(e,{linuxCommandId:"globalDictationSingleTap",${callbacks},onUnavailable:n=>{this.handleLinuxHotkeyUnavailable(\`toggle\`,n)}},{bareModifierTrigger:\`cancellablePress\`,ownership:${ownershipVar}})`,
      "toggle hotkey registration",
    );

    patched = replaceUnique(
      patched,
      /unregisterHotkey\(\)\{/u,
      "handleLinuxHotkeyUnavailable(e,t){console.warn(`[linux-global-dictation] ${e} hotkey backend became unavailable`,t);if(e===`hold`)this.unregisterHotkey();else this.unregisterToggleHotkey()}unregisterHotkey(){",
      "hotkey failure cleanup method",
    );
    return installPortalBackend(patched);
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
