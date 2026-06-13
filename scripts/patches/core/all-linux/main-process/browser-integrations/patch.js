"use strict";

const {
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxChromeExtensionStatusPatch,
} = require("../../../../main-process.js");
const { applyLinuxChromePluginAutoInstallPatch } = require("../../../../chrome-plugin.js");

module.exports = [
  {
    id: "linux-chrome-plugin-auto-install",
    phase: "main-bundle",
    order: 150,
    ciPolicy: "optional",
    apply: applyLinuxChromePluginAutoInstallPatch,
  },
  {
    id: "browser-use-node-repl-approval",
    phase: "main-bundle",
    order: 160,
    ciPolicy: "optional",
    apply: applyBrowserUseNodeReplApprovalPatch,
  },
  {
    id: "linux-browser-use-route-liveness",
    phase: "main-bundle",
    order: 170,
    ciPolicy: "optional",
    apply: applyLinuxBrowserUseRouteLivenessPatch,
  },
  {
    id: "linux-chrome-extension-status",
    phase: "main-bundle",
    order: 180,
    ciPolicy: "optional",
    apply: applyLinuxChromeExtensionStatusPatch,
  },
];
