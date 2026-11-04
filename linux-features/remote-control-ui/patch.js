"use strict";

const LINUX_GATE = "navigator.userAgent.includes(`Linux`)";
const REMOTE_MOBILE_VISIBILITY_MARKER = "codexLinuxRemoteControlVisibilityEnabled";
const REMOTE_CONTROL_UI_VISIBILITY_MARKER = "codexLinuxRemoteControlUiVisibilityEnabled";

function warn(message, patchName) {
  console.warn(`WARN: ${message} — skipping ${patchName}`);
}

// The remote connections atoms read the Statsig gate through the jotai getter:
// `get(gates.JW,"4114442250")`.
const REMOTE_CONNECTIONS_GATE_PATTERN =
  /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?),"4114442250"\)(?!\|\|navigator\.userAgent\.includes\(`Linux`\))/g;
const PATCHED_REMOTE_CONNECTIONS_GATE = `"4114442250")||${LINUX_GATE})`;

function applyRemoteConnectionsVisibilityPatch(source) {
  const patched = source.replace(
    REMOTE_CONNECTIONS_GATE_PATTERN,
    (_match, getter, gate) => `(${getter}(${gate},"4114442250")||${LINUX_GATE})`,
  );
  if (patched !== source || source.includes(PATCHED_REMOTE_CONNECTIONS_GATE)) {
    return patched;
  }
  warn("Could not find remote connections Statsig gate", "remote control UI remote connections visibility patch");
  return source;
}

function applyRemoteControlConnectionsVisibilityPatch(source) {
  const contract = remoteControlConnectionsVisibilityContract(source);
  if (contract?.state === "patched" || contract?.state === "mobile-patched") {
    return source;
  }
  if (contract?.state === "mobile") {
    const patchedBody = contract.body.replace(
      REMOTE_MOBILE_VISIBILITY_MARKER,
      `${REMOTE_MOBILE_VISIBILITY_MARKER}*//*${REMOTE_CONTROL_UI_VISIBILITY_MARKER}`,
    );
    return source.slice(0, contract.bodyIndex) + patchedBody +
      source.slice(contract.bodyIndex + contract.body.length);
  }
  if (contract?.state === "current") {
    const replacement = `return (${contract.flag}||${LINUX_GATE})&&` +
      `(${contract.connections}?.available??!0)&&${contract.connections}?.accessRequired!==!0`;
    return source.slice(0, contract.bodyIndex) + replacement +
      source.slice(contract.bodyIndex + contract.body.length);
  }
  warn(
    "Could not find remote control connections visibility gate",
    "remote control UI remote control connections visibility patch",
  );
  return source;
}

function remoteControlConnectionsVisibilityContract(source) {
  const ownerPattern = /function\s+[A-Za-z_$][\w$]*\(\{remoteControlConnectionsState:([A-Za-z_$][\w$]*),slingshotEnabled:([A-Za-z_$][\w$]*)\}\)\{([^{}]*)\}/gu;
  const owners = [...source.matchAll(ownerPattern)];
  if (owners.length !== 1) return null;

  const [owner] = owners;
  const connections = owner[1];
  const flag = owner[2];
  const body = owner[3];
  const current = `return ${flag}&&(${connections}?.available??!0)&&${connections}?.accessRequired!==!0`;
  const patched = `return (${flag}||${LINUX_GATE})&&(${connections}?.available??!0)&&${connections}?.accessRequired!==!0`;
  const escape = (value) => value.replace(/[$]/g, "\\$");
  const mobilePattern = new RegExp(
    `^let ([A-Za-z_$][\\w$]*)=typeof navigator!=\`undefined\`&&navigator\\.userAgent\\.includes\\(\`Linux\`\\);` +
      `/\\*${REMOTE_MOBILE_VISIBILITY_MARKER}(\\*/\\*${REMOTE_CONTROL_UI_VISIBILITY_MARKER})?\\*/` +
      `return\\(\\1\\|\\|${escape(flag)}\\)&&\\(\\1\\|\\|\\(${escape(connections)}\\?\\.available\\?\\?!0\\)\\)&&` +
      `${escape(connections)}\\?\\.accessRequired!==!0$`,
    "u",
  );
  const mobile = body.match(mobilePattern);
  const state = body === current ? "current" :
    body === patched ? "patched" :
    mobile != null && mobile[2] == null ? "mobile" :
    mobile != null ? "mobile-patched" : null;
  if (state == null) return null;
  return {
    body,
    bodyIndex: owner.index + owner[0].indexOf(body),
    connections,
    flag,
    state,
  };
}

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
      phase: "webview-asset",
      order: 20500,
      ciPolicy: "optional",
      assetNeedles: ['"4114442250"', '"features.remote_connections"'],
      missingDescription: "remote connection visibility bundle",
      skipDescription: "remote control UI remote connections visibility patch",
      apply: applyRemoteConnectionsVisibilityPatch,
    },
    {
      id: "remote-control-connections-visibility",
      phase: "webview-asset",
      order: 20510,
      ciPolicy: "optional",
      assetNeedles: ["remoteControlConnectionsState:", "slingshotEnabled:", "accessRequired!==!0"],
      missingDescription: "remote control connections visibility bundle",
      skipDescription: "remote control UI remote control connections visibility patch",
      apply: applyRemoteControlConnectionsVisibilityPatch,
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
