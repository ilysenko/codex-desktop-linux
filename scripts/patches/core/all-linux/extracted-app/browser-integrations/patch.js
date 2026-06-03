"use strict";

const { patchLinuxChromeNativeHostRuntimeAssets } = require("../../../../chrome-plugin.js");

module.exports = [
  {
    id: "linux-chrome-native-host-runtime",
    phase: "extracted-app",
    order: 180,
    ciPolicy: "required-upstream",
    apply: patchLinuxChromeNativeHostRuntimeAssets,
    status: (result, warnings) => {
      if (result?.matched === 0) {
        return {
          status: "failed-required",
          reason: result?.reason ?? warnings[0] ?? "Chrome native host runtime resolver not found",
        };
      }

      if (warnings.length > 0) {
        return {
          status: "failed-required",
          reason: warnings[0],
        };
      }

      return {
        status: result?.changed ? "applied" : "already-applied",
        reason: null,
      };
    },
  },
];
