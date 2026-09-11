"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const EAGER = new RegExp(`${IDENT}\\.name!==\\\`automation_update\\\`&&${IDENT}&&\\(!${IDENT}\\.has\\(${IDENT}\\.name\\)\\|\\|${IDENT}\\.includes\\(${IDENT}\\.name\\)\\)`);
const DYNAMIC = new RegExp(
  `\\.map\\((${IDENT})=>\\(\\{type:\`function\`,\\.\\.\\.\\1,\\.\\.\\.(` +
    `${IDENT}&&\\(!${IDENT}\\.has\\(\\1\\.name\\)\\|\\|${IDENT}\\.includes\\(\\1\\.name\\)\\)` +
    `)\\?\\{deferLoading:!0\\}:\\{\\}\\}\\)\\)`,
  "u",
);

function matchesAutomationUpdateEagerToolContract(source) {
  return EAGER.test(source) || DYNAMIC.test(source);
}

function applyAutomationUpdateEagerToolPatch(source) {
  if (EAGER.test(source)) return source;
  if (!DYNAMIC.test(source)) {
    if (source.includes("automation_update") && source.includes("deferLoading:!0")) {
      console.warn("WARN: Could not find dynamic tools construction point — skipping automation_update eager tool patch");
    }
    return source;
  }
  return source.replace(
    DYNAMIC,
    (_match, tool, deferCondition) =>
      `.map(${tool}=>({type:\`function\`,...${tool},...${tool}.name!==\`automation_update\`&&${deferCondition}?{deferLoading:!0}:{}}))`,
  );
}

module.exports = { applyAutomationUpdateEagerToolPatch, matchesAutomationUpdateEagerToolContract };
