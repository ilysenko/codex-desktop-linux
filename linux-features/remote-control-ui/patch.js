"use strict";

function warn(message, patchName) {
  console.warn(`WARN: ${message} — skipping ${patchName}`);
}

const { applyRemoteConnectionsVisibility } = require("./remote-connections-visibility.js");

const { applyRemoteControlConnectionsVisibility } = require("./control-connections-visibility.js");

// The experimental features settings list hides beta features through one
// filter: `"beta"===e.stage&&...&&"remote_control"!==e.name&&!e.name.startsWith("realtime_")`.
const EXPERIMENTAL_FEATURES_FILTER =
  /("beta"===([A-Za-z_$][\w$]*)\.stage&&[^;{}]*?"plugin"!==\2\.name)&&"remote_control"!==\2\.name(&&!\2\.name\.startsWith\("realtime_"\))/g;
const PATCHED_EXPERIMENTAL_FEATURES_FILTER =
  /"beta"===([A-Za-z_$][\w$]*)\.stage&&[^;{}]*?"plugin"!==\1\.name&&!\1\.name\.startsWith\("realtime_"\)/g;

function applyExperimentalFeaturesPatch(source) {
  const filters = [...source.matchAll(EXPERIMENTAL_FEATURES_FILTER)];
  if (filters.length === 1) {
    return source.replace(EXPERIMENTAL_FEATURES_FILTER, "$1$3");
  }
  if (filters.length === 0 && [...source.matchAll(PATCHED_EXPERIMENTAL_FEATURES_FILTER)].length === 1 &&
      !source.includes('"remote_control"!==')) {
    return source;
  }
  warn(
    "Could not find remote_control experimental feature filter",
    "remote control UI experimental features patch",
  );
  return source;
}

// rspack duplicates shared modules into every async chunk that uses them, so
// these descriptors patch each chunk that carries the contract.
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
      phase: "webview-asset",
      order: 20520,
      ciPolicy: "optional",
      assetNeedles: ['"multi_agent"!==', 'startsWith("realtime_")'],
      missingDescription: "experimental features query bundle",
      skipDescription: "remote control UI experimental features patch",
      apply: applyExperimentalFeaturesPatch,
    },
  ],
};
