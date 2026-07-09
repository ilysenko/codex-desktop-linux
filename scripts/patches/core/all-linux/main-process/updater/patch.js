"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const { applyLinuxAppUpdaterMenuPatch } = require("../../../../../lib/linux-update-bridge-patch.js");

module.exports = [
  mainBundlePatch({
    id: "linux-app-updater-menu",
    phase: "main-bundle",
    order: 190,
    ciPolicy: "optional",
    apply: applyLinuxAppUpdaterMenuPatch,
  }),
];
