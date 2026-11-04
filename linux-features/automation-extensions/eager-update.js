"use strict";

// The dynamic Codex app tool catalog marks deferred tools with
// `deferLoading:!0`. Keep automation_update eager so the model can update an
// automation without first discovering the tool.
const AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES = ["deferLoading:!0", "eagerToolNames:", "deferredToolNames:"];
const IDENT = "[A-Za-z_$][\\w$]*";
const catalogPrefix = `\\.map\\((?<tool>${IDENT})=>\\(\\{type:"function",\\.\\.\\.\\k<tool>,\\.\\.\\.`;
const deferCondition = `(?<condition>${IDENT}&&\\(!${IDENT}\\.has\\(\\k<tool>\\.name\\)\\|\\|${IDENT}\\.includes\\(\\k<tool>\\.name\\)\\))`;
const catalogSuffix = `\\?\\{deferLoading:!0\\}:\\{\\}\\}\\)\\)`;
const CURRENT = new RegExp(catalogPrefix + deferCondition + catalogSuffix, "g");
const PATCHED = new RegExp(catalogPrefix + `\\k<tool>\\.name!=="automation_update"&&` + deferCondition + catalogSuffix, "g");

function catalogState(source) {
  return {
    current: [...source.matchAll(CURRENT)],
    patched: [...source.matchAll(PATCHED)],
  };
}

function matchesAutomationUpdateEagerToolContract(source) {
  const { current, patched } = catalogState(source);
  return current.length + patched.length === 1;
}

function applyAutomationUpdateEagerToolPatch(source) {
  const { current, patched } = catalogState(source);
  if (current.length === 0 && patched.length === 1) return source;
  if (current.length !== 1 || patched.length !== 0) {
    console.warn("WARN: Could not find one complete dynamic tools construction point — skipping automation_update eager tool patch");
    return source;
  }
  return source.replace(
    CURRENT,
    (...args) => {
      const { tool, condition } = args.at(-1);
      return `.map(${tool}=>({type:"function",...${tool},...${tool}.name!=="automation_update"&&${condition}?{deferLoading:!0}:{}}))`;
    },
  );
}

module.exports = {
  AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
};
