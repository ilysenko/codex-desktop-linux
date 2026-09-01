"use strict";

const sidebarProjectName = require("./patches/sidebar-project-name.js");
const uiFontSize = require("./patches/ui-font-size.js");
const modelPickerModelList = require("./patches/model-picker-model-list.js");
const reasoningEffortLabels = require("./patches/reasoning-effort-labels.js");
const dockIcon = require("./patches/dock-icon.js");
const suggestedPrompts = require("./patches/suggested-prompts.js");

function patchesFrom(...modules) {
  return modules.flatMap((moduleExports) =>
    Array.isArray(moduleExports?.descriptors) ? moduleExports.descriptors : [],
  );
}

module.exports = {
  descriptors: patchesFrom(
    sidebarProjectName,
    uiFontSize,
    modelPickerModelList,
    reasoningEffortLabels,
    dockIcon,
    suggestedPrompts,
  ),
};
