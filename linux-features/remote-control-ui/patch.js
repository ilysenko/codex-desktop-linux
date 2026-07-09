"use strict";

const LINUX_GATE = "navigator.userAgent.includes(`Linux`)";

function warn(message, patchName) {
  console.warn(`WARN: ${message} — skipping ${patchName}`);
}

function replaceOnce(source, needle, replacement, patchName) {
  if (source.includes(replacement)) {
    return source;
  }
  if (!source.includes(needle)) {
    warn("Could not find expected needle", patchName);
    return source;
  }
  return source.replace(needle, replacement);
}

function applyRemoteConnectionsVisibilityPatch(source) {
  const patched = source.replace(
    /([A-Za-z_$][\w$]*)\(`4114442250`\)(?!\|\|navigator\.userAgent\.includes\(`Linux`\))/g,
    `($1(\`4114442250\`)||${LINUX_GATE})`,
  );
  if (patched !== source || source.includes(`||${LINUX_GATE}`)) {
    return patched;
  }
  warn("Could not find remote connections Statsig gate", "remote control UI remote connections visibility patch");
  return source;
}

function applyRemoteControlConnectionsVisibilityPatch(source) {
  let patched = source.replace(
    /return!!([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)\?\.available===!0(?!\|\|navigator\.userAgent\.includes\(`Linux`\))/g,
    `return!!$1&&$2?.available===!0||${LINUX_GATE}`,
  );
  patched = patched.replace(
    /return\s+([A-Za-z_$][\w$]*)&&\(([A-Za-z_$][\w$]*)\?\.available\?\?!0\)&&\2\?\.accessRequired!==!0(?!&&navigator\.userAgent\.includes\(`Linux`\))/g,
    `return ($1||${LINUX_GATE})&&($2?.available??!0)&&$2?.accessRequired!==!0`,
  );
  if (patched !== source || source.includes(`||${LINUX_GATE}`)) {
    return patched;
  }
  if (
    source.includes("function p(){let") &&
    source.includes("remote_control_connections") &&
    source.includes("addedRemoteControlEnvIds")
  ) {
    return source;
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
  if (source.includes("e.name!==`realtime_conversation`&&e.name!==`chronicle`")) {
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

function applyMobileStatsigLinuxPatch(source, patchName) {
  const patched = source.replace(
    /([A-Za-z_$][\w$]*)\(`2798711298`\)(?!\|\|navigator\.userAgent\.includes\(`Linux`\))/g,
    `($1(\`2798711298\`)||${LINUX_GATE})`,
  );
  if (patched !== source || source.includes(`||${LINUX_GATE}`)) {
    return patched;
  }
  if (!source.includes("2798711298") && !source.includes("CODEX_MOBILE_SETUP_COMPLETED")) {
    return source;
  }
  if (source.includes("remote-connection-visibility-")) {
    return source;
  }
  warn("Could not find mobile Statsig gate", patchName);
  return source;
}

module.exports = {
  descriptors: [
    {
      id: "remote-connections-visibility",
      phase: "webview-asset",
      order: 20500,
      ciPolicy: "optional",
      pattern: /^remote-connection-visibility-.*\.js$/,
      missingDescription: "remote connection visibility bundle",
      skipDescription: "remote control UI remote connections visibility patch",
      apply: applyRemoteConnectionsVisibilityPatch,
    },
    {
      id: "remote-control-connections-visibility",
      phase: "webview-asset",
      order: 20510,
      ciPolicy: "optional",
      pattern: /^(?:remote-control-connections-visibility|remote-connection-visibility)-.*\.js$/,
      missingDescription: "remote control connections visibility bundle",
      skipDescription: "remote control UI remote control connections visibility patch",
      apply: applyRemoteControlConnectionsVisibilityPatch,
    },
    {
      id: "experimental-features",
      phase: "webview-asset",
      order: 20520,
      ciPolicy: "optional",
      pattern: /^experimental-features-queries-.*\.js$/,
      missingDescription: "experimental features query bundle",
      skipDescription: "remote control UI experimental features patch",
      apply: applyExperimentalFeaturesPatch,
    },
    {
      id: "nux-gate",
      phase: "webview-asset",
      order: 20530,
      ciPolicy: "optional",
      pattern: /^nux-gate-.*\.js$/,
      missingDescription: "Codex mobile NUX gate bundle",
      skipDescription: "remote control UI mobile NUX gate patch",
      apply: (source) => applyMobileStatsigLinuxPatch(source, "remote control UI mobile NUX gate patch"),
    },
    {
      id: "app-main",
      phase: "webview-asset",
      order: 20540,
      ciPolicy: "optional",
      pattern: /^app-main-.*\.js$/,
      missingDescription: "Codex mobile app main bundle",
      skipDescription: "remote control UI mobile app main patch",
      apply: (source) => applyMobileStatsigLinuxPatch(source, "remote control UI mobile app main patch"),
    },
  ],
};
