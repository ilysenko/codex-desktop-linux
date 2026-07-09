"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const { applyLinuxExternalOpenEnvPatch } = require("../../../../impl/main-process/browser.js");

module.exports = mainBundlePatch({
  id: "linux-external-open-env",
  phase: "main-bundle",
  order: 900,
  ciPolicy: "optional",
  apply: applyLinuxExternalOpenEnvPatch,
});
