"use strict";

const sidebarProjectName = require("./patches/sidebar-project-name.js");
const reasoningEffortLabels = require("./patches/reasoning-effort-labels.js");

function patchesFrom(...modules) {
  return modules.flatMap((moduleExports) =>
    Array.isArray(moduleExports?.descriptors) ? moduleExports.descriptors : [],
  );
}

module.exports = {
  descriptors: patchesFrom(sidebarProjectName, reasoningEffortLabels),
};
