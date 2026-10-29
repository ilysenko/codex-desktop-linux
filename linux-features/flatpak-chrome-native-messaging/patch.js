"use strict";

const IDENTIFIER = "([A-Za-z_$][\\w$]*)";
const PATCH_MARKER = "codexLinuxFlatpakChromeProfile";
// Signed rspack/SWC shape:
// if("linux"===s){let n=(0,r0.E)({chromeConfigHome:"chrome"===e?t:void 0,homeDir:r,xdgConfigHome:a});
// return o.linux.installations.map(e=>(0,en.join)(n,e.userDataDirName))}
const LINUX_PROFILE_ROOTS = new RegExp(
  `if\\("linux"===${IDENTIFIER}\\)\\{` +
  `let ${IDENTIFIER}=\\(0,${IDENTIFIER}\\.${IDENTIFIER}\\)\\(\\{` +
  `chromeConfigHome:"chrome"===${IDENTIFIER}\\?${IDENTIFIER}:void 0,` +
  `homeDir:${IDENTIFIER},xdgConfigHome:${IDENTIFIER}\\}\\);` +
  `return ${IDENTIFIER}\\.linux\\.installations\\.map\\(${IDENTIFIER}=>` +
  `\\(0,${IDENTIFIER}\\.join\\)\\(${IDENTIFIER},${IDENTIFIER}\\.userDataDirName\\)\\)\\}`,
  "g",
);

function applyFlatpakChromeProfileRoot(source) {
  // The engine offers this descriptor every main-process chunk. A clean no-op
  // means "already applied", so a chunk without the resolver must warn.
  if (source.includes(PATCH_MARKER)) return source;
  const matches = [...source.matchAll(LINUX_PROFILE_ROOTS)];
  if (matches.length !== 1) {
    console.warn(
      `WARN: Expected exactly one Linux Chromium profile resolver, found ${matches.length} - skipping Flatpak Chrome profile patch`,
    );
    return source;
  }
  const [
    original,
    platform,
    configRoot,
    diagnosticsNamespace,
    configRootHelper,
    browserFamily,
    chromeConfigHome,
    homeDir,
    xdgConfigHome,
    browserDefinition,
    installation,
    pathNamespace,
    mappedRoot,
    mappedInstallation,
  ] = matches[0];
  if (configRoot !== mappedRoot || installation !== mappedInstallation) {
    console.warn("WARN: Linux Chromium profile resolver symbols do not match - skipping Flatpak Chrome profile patch");
    return source;
  }
  const originalRoots = `${browserDefinition}.linux.installations.map(` +
    `${installation}=>(0,${pathNamespace}.join)(` +
    `${configRoot},${installation}.userDataDirName))`;
  const replacement = `if("linux"===${platform}){let ${configRoot}=` +
    `(0,${diagnosticsNamespace}.${configRootHelper})({chromeConfigHome:"chrome"===${browserFamily}?` +
    `${chromeConfigHome}:void 0,homeDir:${homeDir},xdgConfigHome:${xdgConfigHome}}),` +
    `codexLinuxChromeProfileRoots=${originalRoots},` +
    `${PATCH_MARKER}=process.env.CODEX_CHROME_USER_DATA_DIR;` +
    `return "chrome"===${browserFamily}&&${PATCH_MARKER}?` +
    `[...codexLinuxChromeProfileRoots,${PATCH_MARKER}]:` +
    `codexLinuxChromeProfileRoots}`;
  return source.slice(0, matches[0].index) + replacement + source.slice(matches[0].index + original.length);
}

module.exports = {
  descriptors: [
    {
      id: "flatpak-chrome-profile-status",
      phase: "main-bundle",
      order: 20600,
      ciPolicy: "opt-in",
      apply: applyFlatpakChromeProfileRoot,
    },
  ],
  applyFlatpakChromeProfileRoot,
};
