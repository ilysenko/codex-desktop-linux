#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function warn(message) {
  process.stderr.write(`WARN: ${message}\n`);
}

function patchFile(filePath, patches) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    warn(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  let changed = false;
  for (const { label, oldText, newText, alreadyText = newText } of patches) {
    if (source.includes(newText) || source.includes(alreadyText)) {
      console.log(`${path.basename(filePath)} already patched: ${label}`);
      continue;
    }

    if (!source.includes(oldText)) {
      warn(`${path.basename(filePath)} missing patch target for ${label}`);
      continue;
    }

    source = source.replace(oldText, newText);
    changed = true;
    console.log(`Patched ${path.basename(filePath)}: ${label}`);
  }

  if (changed) {
    fs.writeFileSync(filePath, source, "utf8");
  }
}

function patchFileFirstMatch(filePath, { label, oldTexts, newText, alreadyText = newText }) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    warn(`Could not read ${filePath}: ${error.message}`);
    return;
  }

  if (source.includes(newText) || source.includes(alreadyText)) {
    console.log(`${path.basename(filePath)} already patched: ${label}`);
    return;
  }

  const match = oldTexts
    .map((candidate) => typeof candidate === "string" ? { oldText: candidate, newText } : candidate)
    .find((candidate) => source.includes(candidate.oldText));
  if (!match) {
    warn(`${path.basename(filePath)} missing patch target for ${label}`);
    return;
  }

  fs.writeFileSync(filePath, source.replace(match.oldText, match.newText ?? newText), "utf8");
  console.log(`Patched ${path.basename(filePath)}: ${label}`);
}

const pluginDir = process.argv[2];
if (!pluginDir) {
  throw new Error("Usage: patch-chrome-plugin.js /path/to/chrome/plugin");
}

const scriptsDir = path.resolve(pluginDir, "scripts");

const linuxExtensionAwareUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  const linuxUserDataCandidates = [
    linuxBraveUserDataDirectory,
    linuxChromeUserDataDirectory,
    linuxChromiumUserDataDirectory,
  ].filter((candidate) => fs.existsSync(candidate));
  const linuxCandidateWithInstalledExtension = linuxUserDataCandidates.find(
    (candidate) => {
      try {
        const extensionId = loadRemoteChromeExtensionId();
        return findLatestChromeProfile(candidate) != null &&
          fs.existsSync(
            path.join(
              candidate,
              resolveChromeProfileDirectory(candidate),
              "Extensions",
              extensionId,
            ),
          );
      } catch {
        return false;
      }
    },
  );
  if (linuxCandidateWithInstalledExtension) {
    return linuxCandidateWithInstalledExtension;
  }

  if (linuxUserDataCandidates.length > 0) return linuxUserDataCandidates[0];

  return linuxChromeUserDataDirectory;`;

const linuxDefaultBrowserUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  const defaultBrowser = runCommand(["xdg-settings", "get", "default-web-browser"]);
  if (
    defaultBrowser === "brave-browser.desktop" &&
    fs.existsSync(linuxBraveUserDataDirectory)
  ) {
    return linuxBraveUserDataDirectory;
  }
  if (
    ["chromium.desktop", "chromium-browser.desktop"].includes(defaultBrowser) &&
    fs.existsSync(linuxChromiumUserDataDirectory)
  ) {
    return linuxChromiumUserDataDirectory;
  }

  if (fs.existsSync(linuxBraveUserDataDirectory)) return linuxBraveUserDataDirectory;
  if (fs.existsSync(linuxChromeUserDataDirectory)) return linuxChromeUserDataDirectory;
  if (fs.existsSync(linuxChromiumUserDataDirectory)) return linuxChromiumUserDataDirectory;

  return linuxChromeUserDataDirectory;`;

const linuxNativeHostManifestFallback = `  if (process.platform === "linux") {
    const manifestPaths = [
      path.join(
        os.homedir(),
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      path.join(
        os.homedir(),
        ".config",
        "BraveSoftware",
        "Brave-Browser",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      path.join(
        os.homedir(),
        ".config",
        "chromium",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
    ];

    return {
      manifestPath:
        manifestPaths.find((candidate) => fs.existsSync(candidate)) ||
        manifestPaths[0],
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }`;

patchFileFirstMatch(path.join(scriptsDir, "installManifest.mjs"), {
  label: "Linux browser native host manifest locations",
  oldTexts: [
    'linux:[".config/google-chrome/NativeMessagingHosts"]',
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"]',
  ],
  newText:
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".config/chromium/NativeMessagingHosts"]',
});

patchFile(path.join(scriptsDir, "check-native-host-manifest.js"), [
  {
    label: "Linux native host manifest locations",
    oldText: `  if (process.platform === "win32") {
    const registryKey = \`\${WINDOWS_NATIVE_HOST_REGISTRY_KEY_PREFIX}\\\\\${expectedHostName}\`;
    const registryManifestPath = readWindowsRegistryDefaultValue(registryKey);

    return {
      manifestPath: registryManifestPath || getDefaultWindowsManifestPath(),
      registryKey,
      registryManifestPath,
      registryKeyExists: registryManifestPath != null,
    };
  }

  throw new Error(
    \`Unsupported platform for native host manifest check: \${process.platform}. This script supports macOS and Windows.\`,
  );`,
    newText: `  if (process.platform === "win32") {
    const registryKey = \`\${WINDOWS_NATIVE_HOST_REGISTRY_KEY_PREFIX}\\\\\${expectedHostName}\`;
    const registryManifestPath = readWindowsRegistryDefaultValue(registryKey);

    return {
      manifestPath: registryManifestPath || getDefaultWindowsManifestPath(),
      registryKey,
      registryManifestPath,
      registryKeyExists: registryManifestPath != null,
    };
  }

${linuxNativeHostManifestFallback}

  throw new Error(
    \`Unsupported platform for native host manifest check: \${process.platform}. This script supports macOS, Linux, and Windows.\`,
  );`,
    alreadyText: '"chromium",\n        "NativeMessagingHosts"',
  },
  {
    label: "Linux browser native host manifest fallback",
    oldText: `  if (process.platform === "linux") {
    return {
      manifestPath: path.join(
        os.homedir(),
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
      registryKey: null,
      registryManifestPath: null,
      registryKeyExists: null,
    };
  }`,
    newText: linuxNativeHostManifestFallback,
    alreadyText: '"chromium",\n        "NativeMessagingHosts"',
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile roots",
  oldTexts: [
    {
      oldText: String.raw`var Tc=GF(VF(),WF()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var Tc=GF(VF(),WF()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium")]:[Tc];`,
    },
    {
      oldText: String.raw`var Ic=eO(tO(),rO()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var Ic=eO(tO(),rO()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium")]:[Ic];`,
    },
  ],
  alreadyText: "codexLinuxChromeUserDataDirectories",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile metadata lookup",
  oldTexts: [
    {
      oldText: String.raw`var IS=async(t,e)=>{let r=Gf(Tc,t,"Local Extension Settings",e);if(!XF(r))return null;let n=await JF(Gf(QF(),"codex"));await ZF(r,n,{recursive:!0}),await kS(Gf(n,"LOCK"));let o=new KF(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await kS(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var IS=async(t,e,r=Tc)=>{let n=Gf(r,t,"Local Extension Settings",e);if(!XF(n))return null;let o=await JF(Gf(QF(),"codex"));await ZF(n,o,{recursive:!0}),await kS(Gf(o,"LOCK"));let i=new KF(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await kS(o,{force:!0,recursive:!0})}}`,
    },
  ],
  alreadyText: "async(t,e,r=Tc)",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile instance matching",
  oldTexts: [
    {
      oldText: String.raw`rO=async(t,e)=>(await nO(t)).find(o=>o.instanceId===e)||null,nO=async t=>{let e=await oO();return await Promise.all(e.map(async r=>({...r,instanceId:await IS(r.id,t).catch(n=>(ee(n),null))})))},oO=async()=>{let t=tO(Tc,"Local State"),e=JSON.parse(await eO(t,"utf8"));return e.profile.profiles_order.map((r,n)=>{let o=e.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:e.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`rO=async(t,e)=>{let r=(await nO(t)).filter(n=>n.instanceId===e);return r.length===1?r[0]:null},nO=async t=>{let e=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await oO(r);e.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await IS(o.id,t,r).catch(i=>(ee(i),null))}))))}catch(n){ee(n)}return e},oO=async r=>{let n=tO(r,"Local State"),o=JSON.parse(await eO(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
  ],
  alreadyText: "r.length===1?r[0]:null",
});

patchFile(path.join(scriptsDir, "installed-browsers.js"), [
  {
    label: "Linux browser inventory",
    oldText: `const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
];`,
    newText: `const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
  {
    name: "Brave Browser",
    bundleIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "brave.exe",
  },
  {
    name: "Chromium",
    bundleIds: ["org.chromium.Chromium"],
    appNames: ["Chromium.app"],
    commands: ["chromium", "chromium-browser"],
    windowsExecutable: "chrome.exe",
  },
];`,
  },
]);

patchFile(path.join(scriptsDir, "chrome-is-running.js"), [
  {
    label: "Linux browser running-process detection",
    oldText: `const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  win32: new Set(["chrome.exe"]),
};`,
    newText: `const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  linux: new Set(["chrome", "google-chrome", "brave", "brave-browser", "chromium", "chromium-browser"]),
  win32: new Set(["chrome.exe"]),
};`,
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Linux extension-aware browser profile fallback",
  oldTexts: [
    `  return path.join(os.homedir(), ".config", "google-chrome");`,
    `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  if (fs.existsSync(linuxChromeUserDataDirectory)) return linuxChromeUserDataDirectory;

  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  if (fs.existsSync(linuxBraveUserDataDirectory)) return linuxBraveUserDataDirectory;

  return linuxChromeUserDataDirectory;`,
  ],
  newText: linuxExtensionAwareUserDataFallback,
  alreadyText: "linuxChromiumUserDataDirectory",
});

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Linux default-browser profile fallback",
  oldTexts: [
    `  return path.join(os.homedir(), ".config", "google-chrome");`,
    `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  if (fs.existsSync(linuxChromeUserDataDirectory)) return linuxChromeUserDataDirectory;

  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  if (fs.existsSync(linuxBraveUserDataDirectory)) return linuxBraveUserDataDirectory;

  return linuxChromeUserDataDirectory;`,
  ],
  newText: linuxDefaultBrowserUserDataFallback,
  alreadyText: "linuxChromiumUserDataDirectory",
});

patchFile(path.join(scriptsDir, "open-chrome-window.js"), [
  {
    label: "Linux browser window command",
    oldText: `  return {
    command: "google-chrome",
    args: chromeArgs,
  };`,
    newText: `  const linuxUserDataDirectory = resolveChromeUserDataDirectory();
  let linuxCommand = commandPath("google-chrome") || commandPath("chrome") || "google-chrome";
  if (
    linuxUserDataDirectory.includes(
      path.join(".config", "BraveSoftware", "Brave-Browser"),
    )
  ) {
    linuxCommand = commandPath("brave-browser") || commandPath("brave") || "brave-browser";
  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  }

  return {
    command: linuxCommand,
    args: chromeArgs,
  };`,
  },
]);
