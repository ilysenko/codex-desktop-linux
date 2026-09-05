"use strict";

const IDENTIFIER = "([A-Za-z_$][\\w$]*)";
const LINUX_PROFILE_ROOTS = new RegExp(
  `if\\(${IDENTIFIER}===\\\`linux\\\`\\)\\{` +
  `let ${IDENTIFIER}=${IDENTIFIER}\\.F\\(\\{` +
  `chromeConfigHome:${IDENTIFIER}===\\\`chrome\\\`\\?${IDENTIFIER}:void 0,` +
  `homeDir:${IDENTIFIER},xdgConfigHome:${IDENTIFIER}\\}\\);` +
  `return ${IDENTIFIER}\\.linux\\.installations\\.map\\(${IDENTIFIER}=>` +
  `\\(0,${IDENTIFIER}\\.join\\)\\(${IDENTIFIER},${IDENTIFIER}\\.userDataDirName\\)\\)\\}`,
  "g",
);

function applyFlatpakChromeProfileRoot(source) {
  const matches = [...source.matchAll(LINUX_PROFILE_ROOTS)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one Linux Chromium profile resolver, found ${matches.length}`,
    );
  }
  LINUX_PROFILE_ROOTS.lastIndex = 0;
  return source.replace(
    LINUX_PROFILE_ROOTS,
    (
      original,
      platform,
      configRoot,
      diagnosticsNamespace,
      browserFamily,
      chromeConfigHome,
      homeDir,
      xdgConfigHome,
      browserDefinition,
      installation,
      pathNamespace,
      mappedRoot,
      mappedInstallation,
    ) => {
      if (configRoot !== mappedRoot || installation !== mappedInstallation) {
        throw new Error("Linux Chromium profile resolver symbols do not match");
      }
      const originalRoots = `${browserDefinition}.linux.installations.map(` +
        `${installation}=>(0,${pathNamespace}.join)(` +
        `${configRoot},${installation}.userDataDirName))`;
      return `if(${platform}===\`linux\`){let ${configRoot}=` +
        `${diagnosticsNamespace}.F({chromeConfigHome:${browserFamily}===\`chrome\`?` +
        `${chromeConfigHome}:void 0,homeDir:${homeDir},xdgConfigHome:${xdgConfigHome}}),` +
        `codexLinuxChromeProfileRoots=${originalRoots},` +
        `codexLinuxFlatpakChromeProfile=process.env.CODEX_CHROME_USER_DATA_DIR;` +
        `return ${browserFamily}===\`chrome\`&&codexLinuxFlatpakChromeProfile?` +
        `[...codexLinuxChromeProfileRoots,codexLinuxFlatpakChromeProfile]:` +
        `codexLinuxChromeProfileRoots}`;
    },
  );
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
