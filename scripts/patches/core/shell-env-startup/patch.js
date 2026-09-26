"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "/* codex-linux-shell-env-startup */";
// A microtask still runs during early browser initialization. Yield one loop
// turn before uv_spawn installs SIGCHLD, which browser startup otherwise resets.
const DEFER = `${MARKER}if(process.platform===\`linux\`)await new Promise(setImmediate);`;
const IDENT = "[A-Za-z_$][\\w$]*";
const START = new RegExp(
  `async function ${IDENT}\\(${IDENT},${IDENT}\\)\\{(?=let ${IDENT}=Date\\.now\\(\\);${IDENT}\\.app\\.isPackaged)`,
  "g",
);

function matchesShellEnvironment(source) {
  return source.includes("`Failed to load shell env`") &&
    source.includes("resultSource:`load`") &&
    source.includes("new AbortController");
}

function applyShellEnvironmentStartup(source) {
  if (!matchesShellEnvironment(source)) {
    throw new Error("Official shell environment loader contract changed");
  }
  const markerCount = source.split(MARKER).length - 1;
  const original = markerCount === 1 ? source.replace(DEFER, "") : source;
  const matches = [...original.matchAll(START)];
  if (matches.length !== 1 || markerCount > 1 ||
      (markerCount === 1 && original.includes(MARKER))) {
    throw new Error("Expected exactly one intact shell environment startup function");
  }
  const index = matches[0].index + matches[0][0].length;
  const patched = original.slice(0, index) + DEFER + original.slice(index);
  if (markerCount === 1 && patched !== source) {
    throw new Error("Shell environment startup patch is in the wrong location");
  }
  return patched;
}

function patchExtractedShellEnvironment(extractedDir) {
  const dir = path.join(extractedDir, ".vite", "build");
  const candidates = fs.readdirSync(dir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ file: path.join(dir, name), source: fs.readFileSync(path.join(dir, name), "utf8") }))
    .filter(({ source }) => matchesShellEnvironment(source));
  if (candidates.length !== 1) {
    throw new Error("Expected exactly one official shell environment module");
  }
  const { file, source } = candidates[0];
  const patched = applyShellEnvironmentStartup(source);
  if (patched !== source) fs.writeFileSync(file, patched);
  return { changed: patched !== source };
}

module.exports = {
  DEFER,
  applyShellEnvironmentStartup,
  patchExtractedShellEnvironment,
  descriptors: [{
    id: "shell-env-startup",
    phase: "extracted-app:pre-webview",
    ciPolicy: "required-upstream",
    apply: patchExtractedShellEnvironment,
  }],
};
