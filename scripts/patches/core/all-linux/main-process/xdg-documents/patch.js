"use strict";

const {
  mainBundlePatch,
} = require("../../../../descriptor.js");
const { applyLinuxXdgDocumentsDirPatch } = require("../../../../impl/main-process/misc.js");

module.exports = mainBundlePatch({
  id: "linux-xdg-documents-dir",
  phase: "main-bundle",
  order: 245,
  ciPolicy: "optional",
  apply: applyLinuxXdgDocumentsDirPatch,
});
