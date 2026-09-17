"use strict";

const LINUX_GATE = "navigator.userAgent.includes(`Linux`)";
const REMOTE_MOBILE_VISIBILITY_MARKER = "codexLinuxRemoteControlVisibilityEnabled";
const REMOTE_CONTROL_UI_VISIBILITY_MARKER = "codexLinuxRemoteControlUiVisibilityEnabled";

function warn(message, patchName) {
  console.warn(`WARN: ${message} — skipping ${patchName}`);
}

function applyRemoteConnectionsVisibilityPatch(source) {
  let patched = source.replace(
    /([A-Za-z_$][\w$]*)\(`4114442250`\)(?!\|\|navigator\.userAgent\.includes\(`Linux`\))/g,
    `($1(\`4114442250\`)||${LINUX_GATE})`,
  );
  patched = patched.replace(
    /([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),`4114442250`\)(?!\|\|navigator\.userAgent\.includes\(`Linux`\))/g,
    `($1($2,\`4114442250\`)||${LINUX_GATE})`,
  );
  if (patched !== source || source.includes(`\`4114442250\`)||${LINUX_GATE}`)) {
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
  const mobilePattern = new RegExp(
    `^let ([A-Za-z_$][\\w$]*)=typeof navigator!=\`undefined\`&&navigator\\.userAgent\\.includes\\(\`Linux\`\\);` +
      `/\\*${REMOTE_MOBILE_VISIBILITY_MARKER}(\\*/\\*${REMOTE_CONTROL_UI_VISIBILITY_MARKER})?\\*/` +
      `return\\(\\1\\|\\|${flag}\\)&&\\(\\1\\|\\|\\(${connections}\\?\\.available\\?\\?!0\\)\\)&&` +
      `${connections}\\?\\.accessRequired!==!0$`,
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

function matchesRemoteControlConnectionsVisibilityContract(source) {
  return remoteControlConnectionsVisibilityContract(source) != null;
}

function applyExperimentalFeaturesPatch(source) {
  const needle = "&&e.name!==`remote_control`";
  if (source.includes(needle)) {
    return source.replace(needle, "");
  }
  if (source.includes("!e.name.startsWith(`realtime_`)&&e.name!==`chronicle`")) {
    return source;
  }
  if (source.includes("remote_control")) {
    warn(
      "Could not find remote_control experimental feature filter",
      "remote control UI experimental features patch",
    );
  }
  return source;
}

module.exports = {
  descriptors: [
    {
      id: "remote-connections-visibility",
      phase: "webview-asset",
      order: 20500,
      ciPolicy: "optional",
      pattern: /^app-initial-[^.]+\.js$/,
      missingDescription: "remote connection visibility bundle",
      skipDescription: "remote control UI remote connections visibility patch",
      apply: applyRemoteConnectionsVisibilityPatch,
    },
    {
      id: "remote-control-connections-visibility",
      phase: "webview-asset",
      order: 20510,
      ciPolicy: "optional",
      pattern: /^app-initial-[^.]+\.js$/,
      assetMatch: matchesRemoteControlConnectionsVisibilityContract,
      missingDescription: "remote control connections visibility bundle",
      skipDescription: "remote control UI remote control connections visibility patch",
      apply: applyRemoteControlConnectionsVisibilityPatch,
    },
    {
      id: "experimental-features",
      phase: "webview-asset",
      order: 20520,
      ciPolicy: "optional",
      pattern: /^settings-route-state-.*\.js$/,
      missingDescription: "experimental features query bundle",
      skipDescription: "remote control UI experimental features patch",
      apply: applyExperimentalFeaturesPatch,
    },
  ],
};
