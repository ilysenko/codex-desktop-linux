"use strict";

const {
  patchLinuxMultiInstanceBootstrap,
} = require("../../../../bootstrap.js");

module.exports = {
  id: "linux-multi-instance-bootstrap-lock",
  phase: "extracted-app",
  order: 125,
  // On bundles where bootstrap.js owns the single-instance lock, this is the
  // only duplicate-instance protection Linux gets (the main-bundle patch
  // defers to it), so a drifted needle must fail the build, not warn.
  ciPolicy: "required-upstream",
  apply: patchLinuxMultiInstanceBootstrap,
};
