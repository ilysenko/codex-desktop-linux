"use strict";

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

module.exports = {
  DEFER,
  applyShellEnvironmentStartup,
  matchesShellEnvironment,
};
