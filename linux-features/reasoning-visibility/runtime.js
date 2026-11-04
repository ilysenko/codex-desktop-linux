"use strict";

const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const STORAGE_KEY = "codex-linux-reasoning-visibility";

// Freeze one preference for the renderer session. Lazy chunks must not pick up
// a changed preference until restart while already loaded chunks keep the old one.
function reasoningVisibilitySnapshot(scope = globalThis) {
  const slot = "__codexCommunityReasoningVisibility";
  if (scope[slot] == null) {
    let enabled = false;
    try { enabled = scope.localStorage.getItem("codex-linux-reasoning-visibility") === "1"; } catch {}
    scope[slot] = { enabled };
  }
  return scope[slot].enabled === true;
}

const RUNTIME = `var codexLinuxReasoningVisibilityActive=(${reasoningVisibilitySnapshot.toString()})(globalThis);function codexLinuxReasoningVisibilityEnabled(){return codexLinuxReasoningVisibilityActive}`;

function atScopeTopLevel(source, offset) {
  // Preserve the exact prefix: adding a newline would incorrectly terminate a
  // line comment containing the apparent helper. The existing lexer also skips
  // strings, templates, comments, and nested brace scopes.
  return findMatchingBrace("{" + source.slice(0, offset) + "}", 0) === offset + 1;
}

function runtimeVisibility(source, targetIndex = 0) {
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > source.length) return "invalid";
  const offsets = [];
  for (let index = source.indexOf(RUNTIME); index !== -1; index = source.indexOf(RUNTIME, index + RUNTIME.length)) offsets.push(index);
  if (source.split("codexLinuxReasoningVisibilityActive=").length - 1 !== offsets.length ||
      source.split("function codexLinuxReasoningVisibilityEnabled(){").length - 1 !== offsets.length) {
    return "invalid";
  }
  if (offsets.length === 0) return "absent";
  let modules;
  try { modules = [...rspackModuleFactories(source, "reasoning preference runtime")]; }
  catch { return "invalid"; }
  const scopes = new Set();
  let visible = false;
  for (const offset of offsets) {
    if (atScopeTopLevel(source, offset)) {
      if (scopes.has("program")) return "invalid";
      scopes.add("program");
      visible = true;
      continue;
    }
    const owner = modules.find(module => offset >= module.start && offset < module.end);
    if (owner == null || !atScopeTopLevel(owner.moduleSource, offset - owner.start) || scopes.has(owner.start)) return "invalid";
    scopes.add(owner.start);
    if (targetIndex >= owner.start && targetIndex < owner.end) visible = true;
  }
  return visible ? "visible" : "inaccessible";
}

function withRuntime(source, targetIndex = 0) {
  const visibility = runtimeVisibility(source, targetIndex);
  if (visibility === "visible") return source;
  if (visibility === "invalid") throw Error("reasoning-visibility: incomplete or misplaced renderer preference runtime");
  return RUNTIME + "\n" + source;
}

module.exports = { STORAGE_KEY, RUNTIME, reasoningVisibilitySnapshot, runtimeVisibility, withRuntime };
