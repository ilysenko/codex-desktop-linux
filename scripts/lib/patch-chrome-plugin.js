#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function warn(message) {
  process.stderr.write(`WARN: ${message}\n`);
}

function sourceIncludesAny(source, texts) {
  return (Array.isArray(texts) ? texts : [texts]).some(
    (text) => typeof text === "string" && text.length > 0 && source.includes(text),
  );
}

function shouldSkipPatch(source, skipIf) {
  if (typeof skipIf === "function") {
    return skipIf(source);
  }
  return sourceIncludesAny(source, skipIf);
}

function patchFile(filePath, patches) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    warn(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  let changed = false;
  for (const {
    label,
    oldText,
    newText,
    alreadyText = newText,
    skipIf = null,
    skipDescription = "target no longer exists in this upstream bundle",
  } of patches) {
    if (source.includes(newText) || sourceIncludesAny(source, alreadyText)) {
      console.log(`${path.basename(filePath)} already patched: ${label}`);
      continue;
    }

    if (!source.includes(oldText)) {
      if (shouldSkipPatch(source, skipIf)) {
        console.log(`${path.basename(filePath)} skipped: ${label} (${skipDescription})`);
        continue;
      }
      warn(`${path.basename(filePath)} missing patch target for ${label}`);
      continue;
    }

    source = source.replace(oldText, newText);
    changed = true;
    console.log(`Patched ${path.basename(filePath)}: ${label}`);
  }

  if (changed) {
    fs.writeFileSync(filePath, source, "utf8");
  }
}

function patchFileFirstMatch(filePath, {
  label,
  oldTexts,
  newText,
  alreadyText = newText,
  skipIf = null,
  skipDescription = "target no longer exists in this upstream bundle",
}) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    warn(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  const candidates = oldTexts.map((candidate) =>
    typeof candidate === "string" ? { oldText: candidate, newText } : candidate,
  );
  const alreadyPatched = [newText, alreadyText, ...candidates.map((candidate) => candidate.newText)]
    .filter((text) => typeof text === "string" && text.length > 0)
    .some((text) => source.includes(text));
  if (alreadyPatched) {
    console.log(`${path.basename(filePath)} already patched: ${label}`);
    return;
  }

  const match = candidates.find((candidate) => source.includes(candidate.oldText));
  if (!match) {
    if (shouldSkipPatch(source, skipIf)) {
      console.log(`${path.basename(filePath)} skipped: ${label} (${skipDescription})`);
      return;
    }
    warn(`${path.basename(filePath)} missing patch target for ${label}`);
    return;
  }

  fs.writeFileSync(filePath, source.replace(match.oldText, match.newText ?? newText), "utf8");
  console.log(`Patched ${path.basename(filePath)}: ${label}`);
}

const pluginDir = process.argv[2];
if (!pluginDir) {
  throw new Error("Usage: patch-chrome-plugin.js /path/to/chrome/plugin");
}

const scriptsDir = path.resolve(pluginDir, "scripts");

const linuxRunningProfileResolver = `function resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory) {
  if (process.platform !== "linux") return null;

  const normalizedUserDataDirectory = path.resolve(userDataDirectory);
  const runningProfiles = [];
  for (const processDirectory of linuxProcessDirectories()) {
    const argv = readLinuxProcessArgv(processDirectory);
    if (argv.length === 0 || !isKnownLinuxBrowserCommand(argv[0])) continue;

    const userDataDirectoryArg = chromeArgumentValue(argv, "user-data-dir");
    const processUserDataDirectory = userDataDirectoryArg
      ? path.resolve(userDataDirectoryArg)
      : defaultLinuxUserDataDirectoryForCommand(argv[0]);
    if (processUserDataDirectory !== normalizedUserDataDirectory) continue;

    const profileDirectory = chromeArgumentValue(argv, "profile-directory");
    if (
      profileDirectory &&
      isUsableChromeProfile(userDataDirectory, profileDirectory)
    ) {
      runningProfiles.push(profileDirectory);
    }
  }

  return runningProfiles.at(-1) ?? null;
}

function linuxProcessDirectories() {
  try {
    return fs
      .readdirSync("/proc")
      .filter((entry) => /^\\d+$/.test(entry))
      .map((entry) => path.join("/proc", entry));
  } catch {
    return [];
  }
}

function readLinuxProcessArgv(processDirectory) {
  try {
    return fs
      .readFileSync(path.join(processDirectory, "cmdline"), "utf8")
      .split("\\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isKnownLinuxBrowserCommand(command) {
  return [
    "brave",
    "brave-browser",
    "chrome",
    "chrome_crashpad_handler",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-beta",
    "google-chrome-stable",
    "google-chrome-unstable",
  ].includes(path.basename(command));
}

function defaultLinuxUserDataDirectoryForCommand(command) {
  const commandName = path.basename(command);
  if (["brave", "brave-browser"].includes(commandName)) {
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser");
  }
  if (["chromium", "chromium-browser"].includes(commandName)) {
    return path.join(os.homedir(), ".config", "chromium");
  }
  if (commandName === "google-chrome-beta") {
    return path.join(os.homedir(), ".config", "google-chrome-beta");
  }
  if (commandName === "google-chrome-unstable") {
    return path.join(os.homedir(), ".config", "google-chrome-unstable");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

function chromeArgumentValue(argv, name) {
  const prefix = \`--\${name}=\`;
  const match = argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

`;

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Linux running browser extension profile preference",
  oldTexts: [
    `function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  ],
  newText: `function resolveChromeProfileDirectory(userDataDirectory) {
  const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);
  if (runningProfile) return runningProfile;

  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  alreadyText: `const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);`,
});

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Linux running browser extension profile resolver",
  oldTexts: [`function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`],
  newText: `${linuxRunningProfileResolver}function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`,
  alreadyText: "function linuxProcessDirectories()",
});

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Linux running browser profile preference",
  oldTexts: [
    `function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  ],
  newText: `function resolveChromeProfileDirectory(userDataDirectory) {
  const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);
  if (runningProfile) return runningProfile;

  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  alreadyText: `const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);`,
});

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Linux running browser profile resolver",
  oldTexts: [`function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`],
  newText: `${linuxRunningProfileResolver}function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`,
  alreadyText: "function linuxProcessDirectories()",
});

