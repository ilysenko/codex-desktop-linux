"use strict";

// Barrel for the Linux main-process patches, split by concern under
// main-process/. Keep this require path stable: descriptor files under
// core/ and the patcher CLI import implementations from here.
module.exports = {
  ...require("./main-process/browser.js"),
  ...require("./main-process/misc.js"),
  ...require("./main-process/quit-lifecycle.js"),
  ...require("./main-process/tray.js"),
  ...require("./main-process/window.js"),
};
