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
  if (source.includes(REMOTE_CONTROL_UI_VISIBILITY_MARKER)) {
    return source;
  }
  if (source.includes(REMOTE_MOBILE_VISIBILITY_MARKER)) {
    return source.replace(
      REMOTE_MOBILE_VISIBILITY_MARKER,
      `${REMOTE_MOBILE_VISIBILITY_MARKER}*//*${REMOTE_CONTROL_UI_VISIBILITY_MARKER}`,
    );
  }
  const patched = source.replace(
    /return\s+([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)\?\.available\?\?!0\)&&\2\?\.accessRequired!==!0(?!&&navigator\.userAgent\.includes\(`Linux`\))/g,
    `return ($1||${LINUX_GATE})&&($2?.available??!0)&&$2?.accessRequired!==!0`,
  );
  const alreadyPatched =
    /return \([A-Za-z_$][\w$]*\|\|navigator\.userAgent\.includes\(`Linux`\)\)&&\([A-Za-z_$][\w$]*\?\.available\?\?!0\)&&[A-Za-z_$][\w$]*\?\.accessRequired!==!0/.test(source);
  if (patched !== source || alreadyPatched) {
    return patched;
  }
  warn(
    "Could not find remote control connections visibility gate",
    "remote control UI remote control connections visibility patch",
  );
  return source;
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
      pattern: /^app-initial~(?:app-main~new-thread-panel-page~onboarding-page~projects-index-page~appgen-libra~cci0ubce|artifact-tab-content\.electron~notebook-preview-panel~app-main~business-checkout~d7o11fcp)-[^.]+\.js$/,
      missingDescription: "remote connection visibility bundle",
      skipDescription: "remote control UI remote connections visibility patch",
      apply: applyRemoteConnectionsVisibilityPatch,
    },
    {
      id: "remote-control-connections-visibility",
      phase: "webview-asset",
      order: 20510,
      ciPolicy: "optional",
      pattern: /^app-initial~avatarOverlayCompositionSurface~notebook-preview-panel~app-main~appgen-settings~el5fc9d5-[^.]+\.js$/,
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
