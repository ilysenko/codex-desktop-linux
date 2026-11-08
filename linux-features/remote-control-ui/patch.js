"use strict";

const { applyRemoteConnectionsVisibility } = require("./remote-connections-visibility.js");

const { applyRemoteControlConnectionsVisibility } = require("./control-connections-visibility.js");

const { applyExperimentalFeaturesVisibility } = require("./experimental-features.js");

// Each feature-owned preparer qualifies the complete physical cohort before
// one atomic commit; all three transactions run before webview asset patches.
module.exports = {
  descriptors: [
    {
      id: "remote-connections-visibility",
      phase: "extracted-app:pre-webview",
      order: 20500,
      ciPolicy: "optional",
      apply: applyRemoteConnectionsVisibility,
    },
    {
      id: "remote-control-connections-visibility",
      phase: "extracted-app:pre-webview",
      order: 20510,
      ciPolicy: "optional",
      apply: applyRemoteControlConnectionsVisibility,
    },
    {
      id: "experimental-features",
      phase: "extracted-app:pre-webview",
      order: 20520,
      ciPolicy: "optional",
      apply: applyExperimentalFeaturesVisibility,
    },
  ],
};
