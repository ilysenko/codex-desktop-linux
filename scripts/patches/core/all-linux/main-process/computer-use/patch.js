"use strict";

const {
  applyLinuxComputerUseFeaturePatch,
  applyLinuxComputerUsePluginGatePatch,
} = require("../../../../computer-use.js");

module.exports = [
  {
    id: "linux-computer-use-ui-feature",
    phase: "main-bundle",
    order: 130,
    ciPolicy: "opt-in",
    enabled: (context) => context.enableComputerUseUi,
    apply: applyLinuxComputerUseFeaturePatch,
  },
  {
    id: "linux-computer-use-plugin-gate",
    phase: "main-bundle",
    order: 140,
    ciPolicy: "optional",
    apply: applyLinuxComputerUsePluginGatePatch,
  },
];
