"use strict";

const EAGER = /[A-Za-z_$][\w$]*\.name===`automation_update`&&delete [A-Za-z_$][\w$]*\.deferLoading/u;
const DYNAMIC = /\.map\(([A-Za-z_$][\w$]*)=>\(\{type:`function`,\.\.\.\1,\.\.\.(([A-Za-z_$][\w$]*)&&\(!([A-Za-z_$][\w$]*)\.has\(\1\.name\)\|\|([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\.includes\(\1\.name\)\))\?\{deferLoading:!0\}:\{\}\}\)\)/u;

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
  return source.replace(DYNAMIC, (_match, tool, deferCondition) => {
    const descriptor = tool === "t" ? "codexLinuxAutomationDescriptor" : "t";
    return `.map(${tool}=>{let ${descriptor}={type:\`function\`,...${tool},...${deferCondition}?{deferLoading:!0}:{}};return ${tool}.name===\`automation_update\`&&delete ${descriptor}.deferLoading,${descriptor}})`;
  });
}

module.exports = { applyAutomationUpdateEagerToolPatch, matchesAutomationUpdateEagerToolContract };
