"use strict";

const PATCH_MARKER = "codex-linux-global-dictation-v3";
const {
  insertBeforeRegistration,
  installPortalBackend,
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

function applyLinuxGlobalDictationMainProcessPatch(source) {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }
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
