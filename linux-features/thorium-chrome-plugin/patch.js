"use strict";

function warn(message) {
  console.warn(`WARN: ${message} — skipping Thorium Chrome plugin settings patch`);
}

function applyThoriumChromeExtensionStatusPatch(source) {
  let patched = source;

  patched = patched.replace(
    /(\(0,([A-Za-z_$][\w$]*)\.join\)\(([A-Za-z_$][\w$]*),`\.config`,`chromium`\))\]:\[\]/g,
    "$1,(0,$2.join)($3,`.config`,`thorium`)]:[]",
  );
  patched = patched.replace(
    /`chromium-browser`,`chromium`\]/g,
    "`chromium-browser`,`chromium`,`thorium-browser-avx2`,`thorium-browser`,`thorium`]",
  );
  patched = patched.replace(
    /Google Chrome, Brave, or Chromium is not installed/g,
    "Google Chrome, Brave, Chromium, or Thorium is not installed",
  );

  if (
    patched === source &&
    source.includes("codexLinuxChromeProfileRoots") &&
    !source.includes("`thorium`")
  ) {
    warn("Could not find Linux Chrome extension status helper shape");
  }
  return patched;
}

module.exports = {
  descriptors: [
    {
      id: "chrome-extension-status",
      phase: "main-bundle",
      order: 20500,
      ciPolicy: "optional",
      apply: applyThoriumChromeExtensionStatusPatch,
    },
  ],
  applyThoriumChromeExtensionStatusPatch,
};
