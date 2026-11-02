"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { PatchIntegrityError } = require("../integrity-error.js");

// Parse the final main-process modules without loading Electron, imports, or
// application code. --check respects .mjs/.cjs and the bundle's package type.
function validateMainProcessSyntax(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) return;
  for (const entry of fs.readdirSync(buildDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !/\.(?:js|cjs|mjs)$/.test(entry.name)) continue;
    const target = path.join(buildDir, entry.name);
    const result = spawnSync(process.execPath, ["--check", target], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "" },
    });
    if (result.error || result.status !== 0) {
      // Minified source lines can be megabytes long; retain the diagnostic,
      // not the complete line or caret, in build/update logs.
      const diagnostic = result.stderr?.split("\n").find((line) => line.startsWith("SyntaxError:"));
      throw new PatchIntegrityError(
        `JavaScript syntax validation failed for .vite/build/${entry.name}: ` +
        (diagnostic ?? result.error?.message ?? `parser exited ${result.status} (${result.signal ?? "no signal"})`),
      );
    }
  }
}

function moduleParses(source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    // Diagnostics echo whole minified lines; only the exit status matters.
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 30_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

// Compiles a classic script without running it. Unlike the CommonJS wrapper,
// a script rejects top-level return, so a misplaced brace cannot hide.
function scriptParses(source) {
  try {
    new vm.Script(source);
    return true;
  } catch {
    return false;
  }
}

function parseGoal(source) {
  if (moduleParses(source)) return "module";
  return scriptParses(source) ? "script" : null;
}

// Parses without evaluating. Webview chunks are ES modules; workers and
// worklets can be classic scripts.
function javascriptSourceParses(source) {
  return parseGoal(source) != null;
}

// A patch must not turn a parseable bundle into an unparseable one: a broken
// webview chunk leaves the renderer blank after ready-to-show. The patched
// source must still parse under the original's goal.
function patchBreaksJavaScriptSyntax(original, patched) {
  if (moduleParses(patched)) return false;
  const goal = parseGoal(original);
  if (goal === "module") return true;
  if (goal === "script") return !scriptParses(patched);
  return false;
}

module.exports = {
  javascriptSourceParses,
  patchBreaksJavaScriptSyntax,
  validateMainProcessSyntax,
};
