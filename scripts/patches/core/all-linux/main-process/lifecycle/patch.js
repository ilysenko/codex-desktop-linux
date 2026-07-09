"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxQuitGuardPatch,
  applyLinuxExplicitQuitPromptBypassPatch,
  applyLinuxWillQuitDrainTimeoutPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxExplicitIpcQuitPatch,
} = require("../../../../impl/main-process/quit-lifecycle.js");

module.exports = [
  mainBundlePatch({
    id: "linux-quit-guard",
    phase: "main-bundle",
    order: 0,
    ciPolicy: "required-upstream",
    apply: applyLinuxQuitGuardPatch,
  }),
  mainBundlePatch({
    id: "linux-explicit-quit-prompt-bypass",
    phase: "main-bundle",
    order: 10,
    ciPolicy: "required-upstream",
    apply: applyLinuxExplicitQuitPromptBypassPatch,
  }),
  mainBundlePatch({
    id: "linux-explicit-quit-drain-timeout",
    phase: "main-bundle",
    order: 20,
    ciPolicy: "required-upstream",
    apply: applyLinuxWillQuitDrainTimeoutPatch,
  }),
  mainBundlePatch({
    id: "linux-explicit-tray-quit",
    phase: "main-bundle",
    order: 30,
    ciPolicy: "required-upstream",
    apply: applyLinuxExplicitTrayQuitPatch,
  }),
  mainBundlePatch({
    id: "linux-explicit-ipc-quit",
    phase: "main-bundle",
    order: 40,
    ciPolicy: "required-upstream",
    apply: applyLinuxExplicitIpcQuitPatch,
  }),
];
