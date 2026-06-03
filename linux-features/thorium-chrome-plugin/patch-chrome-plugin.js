#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

function warn(message) {
  process.stderr.write(`WARN: ${message}\n`);
}

function sourceIncludesAny(source, texts) {
  return (Array.isArray(texts) ? texts : [texts]).some(
    (text) => typeof text === "string" && text.length > 0 && source.includes(text),
  );
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
    if (source.includes(newText) || sourceIncludesAny(source, alreadyText)) {
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

  if ((typeof newText === "string" && source.includes(newText)) || sourceIncludesAny(source, alreadyText)) {
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

const nativeHostManifestFallback = `  if (process.platform === "linux") {
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
      path.join(
        os.homedir(),
        ".config",
        "thorium",
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

const nativeHostManifestFallbackWithoutThorium = nativeHostManifestFallback.replace(
  `      path.join(
        os.homedir(),
        ".config",
        "thorium",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
`,
  "",
);

const extensionAwareUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxThoriumUserDataDirectory = path.join(os.homedir(), ".config", "thorium");
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
    linuxThoriumUserDataDirectory,
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

const extensionAwareUserDataFallbackWithoutThorium = extensionAwareUserDataFallback
  .replace('  const linuxThoriumUserDataDirectory = path.join(os.homedir(), ".config", "thorium");\n', "")
  .replace("    linuxThoriumUserDataDirectory,\n", "");

const defaultBrowserUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxThoriumUserDataDirectory = path.join(os.homedir(), ".config", "thorium");
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
  if (
    ["thorium-browser.desktop", "thorium-browser-avx2.desktop"].includes(defaultBrowser) &&
    fs.existsSync(linuxThoriumUserDataDirectory)
  ) {
    return linuxThoriumUserDataDirectory;
  }

  if (fs.existsSync(linuxBraveUserDataDirectory)) return linuxBraveUserDataDirectory;
  if (fs.existsSync(linuxChromeUserDataDirectory)) return linuxChromeUserDataDirectory;
  if (fs.existsSync(linuxChromiumUserDataDirectory)) return linuxChromiumUserDataDirectory;
  if (fs.existsSync(linuxThoriumUserDataDirectory)) return linuxThoriumUserDataDirectory;

  return linuxChromeUserDataDirectory;`;

const defaultBrowserUserDataFallbackWithoutThorium = defaultBrowserUserDataFallback
  .replace('  const linuxThoriumUserDataDirectory = path.join(os.homedir(), ".config", "thorium");\n', "")
  .replace(`  if (
    ["thorium-browser.desktop", "thorium-browser-avx2.desktop"].includes(defaultBrowser) &&
    fs.existsSync(linuxThoriumUserDataDirectory)
  ) {
    return linuxThoriumUserDataDirectory;
  }
`, "")
  .replace("  if (fs.existsSync(linuxThoriumUserDataDirectory)) return linuxThoriumUserDataDirectory;\n", "");

patchFileFirstMatch(path.join(scriptsDir, "installManifest.mjs"), {
  label: "Thorium native host manifest location",
  oldTexts: [
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".config/chromium/NativeMessagingHosts"]',
  ],
  newText:
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".config/chromium/NativeMessagingHosts",".config/thorium/NativeMessagingHosts"]',
});

patchFile(path.join(scriptsDir, "check-native-host-manifest.js"), [
  {
    label: "Thorium native host manifest fallback",
    oldText: nativeHostManifestFallbackWithoutThorium,
    newText: nativeHostManifestFallback,
    alreadyText: '"thorium",\n        "NativeMessagingHosts"',
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Thorium Chrome profile roots",
  oldTexts: [
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium")]:[Tc]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium"),GF(VF(),".config","thorium")]:[Tc]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium")]:[Ic]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium"),eO(tO(),".config","thorium")]:[Ic]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium"),Y5(Z5(),".config","thorium")]:[hl]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>L9()==="linux"?[M9(F9(),".config","BraveSoftware","Brave-Browser"),M9(F9(),".config","google-chrome"),M9(F9(),".config","chromium")]:[kl]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>L9()==="linux"?[M9(F9(),".config","BraveSoftware","Brave-Browser"),M9(F9(),".config","google-chrome"),M9(F9(),".config","chromium"),M9(F9(),".config","thorium")]:[kl]`,
    },
    {
      oldText: String.raw`var hl=Y5(Z5(),X5()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var hl=Y5(Z5(),X5()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium"),Y5(Z5(),".config","thorium")]:[hl];`,
    },
  ],
  alreadyText: '".config","thorium"',
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Thorium Chrome profile metadata lookup",
  oldTexts: [
    {
      oldText: String.raw`var mT=async(e,t)=>{let r=rh(hl,e,"Local Extension Settings",t);if(!n9(r))return null;let n=await r9(rh(o9(),"codex"));await t9(r,n,{recursive:!0}),await fT(rh(n,"LOCK"));let o=new Q5(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await fT(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var mT=async(e,t,r=hl)=>{let n=rh(r,e,"Local Extension Settings",t);if(!n9(n))return null;let o=await r9(rh(o9(),"codex"));await t9(n,o,{recursive:!0}),await fT(rh(o,"LOCK"));let i=new Q5(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await fT(o,{force:!0,recursive:!0})}}`,
    },
  ],
  alreadyText: ["async(e,t,r=hl)", `r,e,"Local Extension Settings"`],
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Thorium Chrome profile instance matching",
  oldTexts: [
    {
      oldText: String.raw`a9=async(e,t)=>(await u9(e)).find(o=>o.instanceId===t)||null,u9=async e=>{let t=await c9();return await Promise.all(t.map(async r=>({...r,instanceId:await mT(r.id,e).catch(n=>(ne(n),null))})))},c9=async()=>{let e=s9(hl,"Local State"),t=JSON.parse(await i9(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`a9=async(e,t)=>{let r=(await u9(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},u9=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await c9(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await mT(o.id,e,r).catch(i=>(ne(i),null))}))))}catch(n){ne(n)}return t},c9=async r=>{let n=s9(r,"Local State"),o=JSON.parse(await i9(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
  ],
  alreadyText: "r.length===1?r[0]:null",
});

patchFile(path.join(scriptsDir, "installed-browsers.js"), [
  {
    label: "Thorium browser inventory",
    oldText: `  {
    name: "Chromium",
    bundleIds: ["org.chromium.Chromium"],
    appNames: ["Chromium.app"],
    commands: ["chromium", "chromium-browser"],
    windowsExecutable: "chrome.exe",
  },
];`,
    newText: `  {
    name: "Chromium",
    bundleIds: ["org.chromium.Chromium"],
    appNames: ["Chromium.app"],
    commands: ["chromium", "chromium-browser"],
    windowsExecutable: "chrome.exe",
  },
  {
    name: "Thorium",
    bundleIds: ["org.chromium.Thorium"],
    appNames: ["Thorium.app"],
    commands: ["thorium-browser-avx2", "thorium-browser", "thorium"],
    windowsExecutable: "chrome.exe",
  },
];`,
    alreadyText: '"Thorium"',
  },
]);

patchFile(path.join(scriptsDir, "chrome-is-running.js"), [
  {
    label: "Thorium running-process detection",
    oldText: `  linux: new Set(["chrome", "google-chrome", "brave", "brave-browser", "chromium", "chromium-browser"]),`,
    newText: `  linux: new Set(["chrome", "google-chrome", "brave", "brave-browser", "chromium", "chromium-browser", "thorium", "thorium-browser", "thorium-browser-avx2"]),`,
    alreadyText: "thorium-browser-avx2",
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Thorium extension-aware browser profile fallback",
  oldTexts: [extensionAwareUserDataFallbackWithoutThorium],
  newText: extensionAwareUserDataFallback,
  alreadyText: "linuxThoriumUserDataDirectory",
});

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Thorium default-browser profile fallback",
  oldTexts: [defaultBrowserUserDataFallbackWithoutThorium],
  newText: defaultBrowserUserDataFallback,
  alreadyText: "linuxThoriumUserDataDirectory",
});

patchFile(path.join(scriptsDir, "open-chrome-window.js"), [
  {
    label: "Thorium browser window command",
    oldText: `  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  }

  return {`,
    newText: `  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  } else if (linuxUserDataDirectory.includes(path.join(".config", "thorium"))) {
    linuxCommand = commandPath("thorium-browser-avx2") || commandPath("thorium-browser") || commandPath("thorium") || "thorium-browser";
  }

  return {`,
    alreadyText: 'commandPath("thorium-browser-avx2")',
  },
]);
