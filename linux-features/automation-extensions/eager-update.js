"use strict";

// The dynamic Codex app tool catalog marks deferred tools with
// `deferLoading:!0`. Keep automation_update eager so the model can update an
// automation without first discovering the tool.
const IDENT = "[A-Za-z_$][\\w$]*";
const AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES = ["deferLoading:!0", "eagerToolNames:", "deferredToolNames:"];
const EAGER = new RegExp(
  `${IDENT}\\.name!=="automation_update"&&${IDENT}&&\\(!${IDENT}\\.has\\(${IDENT}\\.name\\)\\|\\|${IDENT}\\.includes\\(${IDENT}\\.name\\)\\)`,
  "gu",
);
const DYNAMIC = new RegExp(
  `\\.map\\((${IDENT})=>\\(\\{type:"function",\\.\\.\\.\\1,\\.\\.\\.(` +
    `${IDENT}&&\\(!${IDENT}\\.has\\(\\1\\.name\\)\\|\\|${IDENT}\\.includes\\(\\1\\.name\\)\\)` +
    `)\\?\\{deferLoading:!0\\}:\\{\\}\\}\\)\\)`,
  "gu",
);

function count(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function matchesAutomationUpdateEagerToolContract(source) {
  return count(source, EAGER) + count(source, DYNAMIC) === 1;
}

function applyAutomationUpdateEagerToolPatch(source) {
  const eager = count(source, EAGER);
  const dynamic = count(source, DYNAMIC);
  if (eager === 1 && dynamic === 0) return source;
  if (eager !== 0 || dynamic !== 1) {
    console.warn("WARN: Could not find unique dynamic tools construction point — skipping automation_update eager tool patch");
    return source;
  }
  return source.replace(
    DYNAMIC,
    (_match, tool, deferCondition) =>
      `.map(${tool}=>({type:"function",...${tool},...${tool}.name!=="automation_update"&&${deferCondition}?{deferLoading:!0}:{}}))`,
  );
}

module.exports = {
  AUTOMATION_UPDATE_EAGER_TOOL_ASSET_NEEDLES,
  applyAutomationUpdateEagerToolPatch,
  matchesAutomationUpdateEagerToolContract,
};
