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

  const candidates = oldTexts.map((candidate) =>
    typeof candidate === "string" ? { oldText: candidate, newText } : candidate,
  );
  const alreadyPatched =
    sourceIncludesAny(source, [newText, ...candidates.map((candidate) => candidate.newText)]) ||
    sourceIncludesAny(source, alreadyText);
  if (alreadyPatched) {
    console.log(`${path.basename(filePath)} already patched: ${label}`);
    return;
  }

  const match = candidates.find((candidate) => source.includes(candidate.oldText));
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
  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  const linuxFlatpakChromeUserDataDirectory = path.join(
    os.homedir(),
    ".var",
    "app",
    "com.google.Chrome",
    "config",
    "google-chrome",
  );
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const linuxUserDataCandidates = [
    linuxBraveUserDataDirectory,
    linuxChromeUserDataDirectory,
    linuxFlatpakChromeUserDataDirectory,
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

const linuxExtensionAwareUserDataFallbackWithoutFlatpak = linuxExtensionAwareUserDataFallback
  .replace(`  const linuxFlatpakChromeUserDataDirectory = path.join(
    os.homedir(),
    ".var",
    "app",
    "com.google.Chrome",
    "config",
    "google-chrome",
  );
`, "")
  .replace("    linuxFlatpakChromeUserDataDirectory,\n", "");

const linuxDefaultBrowserUserDataFallback = `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
  const linuxBraveUserDataDirectory = path.join(
    os.homedir(),
    ".config",
    "BraveSoftware",
    "Brave-Browser",
  );
  const linuxFlatpakChromeUserDataDirectory = path.join(
    os.homedir(),
    ".var",
    "app",
    "com.google.Chrome",
    "config",
    "google-chrome",
  );
  const linuxChromiumUserDataDirectory = path.join(os.homedir(), ".config", "chromium");
  const defaultBrowser = runCommand(["xdg-settings", "get", "default-web-browser"]);
  if (
    defaultBrowser === "brave-browser.desktop" &&
    fs.existsSync(linuxBraveUserDataDirectory)
  ) {
    return linuxBraveUserDataDirectory;
  }
  if (
    defaultBrowser === "google-chrome.desktop" &&
    fs.existsSync(linuxChromeUserDataDirectory)
  ) {
    return linuxChromeUserDataDirectory;
  }
  if (
    defaultBrowser === "com.google.Chrome.desktop" &&
    fs.existsSync(linuxFlatpakChromeUserDataDirectory)
  ) {
    return linuxFlatpakChromeUserDataDirectory;
  }
  if (
    ["chromium.desktop", "chromium-browser.desktop"].includes(defaultBrowser) &&
    fs.existsSync(linuxChromiumUserDataDirectory)
  ) {
    return linuxChromiumUserDataDirectory;
  }

  if (fs.existsSync(linuxBraveUserDataDirectory)) return linuxBraveUserDataDirectory;
  if (fs.existsSync(linuxChromeUserDataDirectory)) return linuxChromeUserDataDirectory;
  if (fs.existsSync(linuxFlatpakChromeUserDataDirectory)) return linuxFlatpakChromeUserDataDirectory;
  if (fs.existsSync(linuxChromiumUserDataDirectory)) return linuxChromiumUserDataDirectory;

  return linuxChromeUserDataDirectory;`;

const linuxRunningProfileResolver = `function resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory) {
  if (process.platform !== "linux") return null;

  const normalizedUserDataDirectory = path.resolve(userDataDirectory);
  const runningProfiles = [];
  for (const processDirectory of linuxProcessDirectories()) {
    const argv = readLinuxProcessArgv(processDirectory);
    if (argv.length === 0 || !isKnownLinuxBrowserCommand(argv[0])) continue;

    const userDataDirectoryArg = chromeArgumentValue(argv, "user-data-dir");
    const processUserDataDirectory = userDataDirectoryArg
      ? path.resolve(userDataDirectoryArg)
      : defaultLinuxUserDataDirectoryForCommand(argv[0]);
    if (processUserDataDirectory !== normalizedUserDataDirectory) continue;

    const profileDirectory = chromeArgumentValue(argv, "profile-directory");
    if (
      profileDirectory &&
      isUsableChromeProfile(userDataDirectory, profileDirectory)
    ) {
      runningProfiles.push(profileDirectory);
    }
  }

  return runningProfiles.at(-1) ?? null;
}

function linuxProcessDirectories() {
  try {
    return fs
      .readdirSync("/proc")
      .filter((entry) => /^\\d+$/.test(entry))
      .map((entry) => path.join("/proc", entry));
  } catch {
    return [];
  }
}

function readLinuxProcessArgv(processDirectory) {
  try {
    return fs
      .readFileSync(path.join(processDirectory, "cmdline"), "utf8")
      .split("\\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isKnownLinuxBrowserCommand(command) {
  return [
    "brave",
    "brave-browser",
    "chrome",
    "chrome_crashpad_handler",
    "chromium",
    "chromium-browser",
    "google-chrome",
    "google-chrome-stable",
  ].includes(path.basename(command));
}

function defaultLinuxUserDataDirectoryForCommand(command) {
  const commandName = path.basename(command);
  if (["brave", "brave-browser"].includes(commandName)) {
    return path.join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser");
  }
  if (["chromium", "chromium-browser"].includes(commandName)) {
    return path.join(os.homedir(), ".config", "chromium");
  }
  return path.join(os.homedir(), ".config", "google-chrome");
}

function chromeArgumentValue(argv, name) {
  const prefix = \`--\${name}=\`;
  const match = argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

`;

const linuxDefaultBrowserUserDataFallbackWithoutFlatpak = linuxDefaultBrowserUserDataFallback
  .replace(`  const linuxFlatpakChromeUserDataDirectory = path.join(
    os.homedir(),
    ".var",
    "app",
    "com.google.Chrome",
    "config",
    "google-chrome",
  );
`, "")
  .replace(`  if (
    defaultBrowser === "com.google.Chrome.desktop" &&
    fs.existsSync(linuxFlatpakChromeUserDataDirectory)
  ) {
    return linuxFlatpakChromeUserDataDirectory;
  }
`, "")
  .replace("  if (fs.existsSync(linuxFlatpakChromeUserDataDirectory)) return linuxFlatpakChromeUserDataDirectory;\n", "");

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
        ".var",
        "app",
        "com.google.Chrome",
        "config",
        "google-chrome",
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

const linuxNativeHostManifestFallbackWithoutFlatpak = linuxNativeHostManifestFallback.replace(
  `      path.join(
        os.homedir(),
        ".var",
        "app",
        "com.google.Chrome",
        "config",
        "google-chrome",
        "NativeMessagingHosts",
        \`\${expectedHostName}.json\`,
      ),
`,
  "",
);

patchFileFirstMatch(path.join(scriptsDir, "installManifest.mjs"), {
  label: "Linux browser native host manifest locations",
  oldTexts: [
    'linux:[".config/google-chrome/NativeMessagingHosts"]',
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"]',
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".config/chromium/NativeMessagingHosts"]',
  ],
  newText:
    'linux:[".config/google-chrome/NativeMessagingHosts",".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",".var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts",".config/chromium/NativeMessagingHosts"]',
});

patchFileFirstMatch(path.join(scriptsDir, "installManifest.mjs"), {
  label: "Linux Flatpak native host wrapper manifest",
  oldTexts: [
    `async function y({appServerHostConfig:t,description:e=_,extensionHostName:o,extensionHostPath:n,extensionId:s,manifestPaths:p}){let f={allowed_origins:[\`chrome-extension://\${r(s,"extensionId")}/\`],description:e,name:r(o,"extensionHostName"),path:r(n,"extensionHostPath"),type:"stdio"},m=\`\${JSON.stringify(f,null,2)}
\`,l=await T({appServerHostConfig:{...t,extensionId:r(s,"extensionId")},extensionHostPath:n});return await Promise.all(p.map(async u=>{await w(d(u),{recursive:!0}),await v(u,m,"utf8")})),{configPath:l,manifestPaths:p}}`,
  ],
  newText: `async function y({appServerHostConfig:t,description:e=_,extensionHostName:o,extensionHostPath:n,extensionId:s,manifestPaths:p}){let l=await T({appServerHostConfig:{...t,extensionId:r(s,"extensionId")},extensionHostPath:n});return await Promise.all(p.map(async u=>{await w(d(u),{recursive:!0});let g=n;if(u.includes(".var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts")){g=a(d(d(d(u))),"codex","extension-host-flatpak-wrapper.sh");await w(d(g),{recursive:!0}),await v(g,\`#!/bin/sh
exec /usr/bin/flatpak-spawn --host \${r(n,"extensionHostPath")} "$@"
\`,"utf8"),await U("chmod",["0755",g]).catch(()=>{})}let f={allowed_origins:[\`chrome-extension://\${r(s,"extensionId")}/\`],description:e,name:r(o,"extensionHostName"),path:r(g,"extensionHostPath"),type:"stdio"},m=\`\${JSON.stringify(f,null,2)}
\`;await v(u,m,"utf8")})),{configPath:l,manifestPaths:p}}`,
  alreadyText: "extension-host-flatpak-wrapper.sh",
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
    alreadyText: ['"com.google.Chrome",\n        "config",\n        "google-chrome",\n        "NativeMessagingHosts"', '"chromium",\n        "NativeMessagingHosts"'],
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
    alreadyText: ['"com.google.Chrome",\n        "config",\n        "google-chrome",\n        "NativeMessagingHosts"', '"chromium",\n        "NativeMessagingHosts"'],
  },
  {
    label: "Linux Flatpak native host manifest fallback",
    oldText: linuxNativeHostManifestFallbackWithoutFlatpak,
    newText: linuxNativeHostManifestFallback,
    alreadyText: '"com.google.Chrome",\n        "config",\n        "google-chrome",\n        "NativeMessagingHosts"',
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile roots",
  oldTexts: [
    {
      oldText: String.raw`var Tc=GF(VF(),WF()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var Tc=GF(VF(),WF()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".var","app","com.google.Chrome","config","google-chrome"),GF(VF(),".config","chromium")]:[Tc];`,
    },
    {
      oldText: String.raw`var Ic=eO(tO(),rO()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var Ic=eO(tO(),rO()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".var","app","com.google.Chrome","config","google-chrome"),eO(tO(),".config","chromium")]:[Ic];`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium")]:[Tc]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".var","app","com.google.Chrome","config","google-chrome"),GF(VF(),".config","chromium")]:[Tc]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium")]:[Ic]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".var","app","com.google.Chrome","config","google-chrome"),eO(tO(),".config","chromium")]:[Ic]`,
    },
    {
      oldText: String.raw`codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl]`,
      newText: String.raw`codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".var","app","com.google.Chrome","config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl]`,
    },
    {
      oldText: String.raw`var hl=Y5(Z5(),X5()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var hl=Y5(Z5(),X5()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".var","app","com.google.Chrome","config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl];`,
    },
  ],
  alreadyText: '".var","app","com.google.Chrome"',
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile metadata lookup",
  oldTexts: [
    {
      oldText: String.raw`var IS=async(t,e)=>{let r=Gf(Tc,t,"Local Extension Settings",e);if(!XF(r))return null;let n=await JF(Gf(QF(),"codex"));await ZF(r,n,{recursive:!0}),await kS(Gf(n,"LOCK"));let o=new KF(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await kS(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var IS=async(t,e,r=Tc)=>{let n=Gf(r,t,"Local Extension Settings",e);if(!XF(n))return null;let o=await JF(Gf(QF(),"codex"));await ZF(n,o,{recursive:!0}),await kS(Gf(o,"LOCK"));let i=new KF(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await kS(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var mT=async(e,t)=>{let r=rh(hl,e,"Local Extension Settings",t);if(!n9(r))return null;let n=await r9(rh(o9(),"codex"));await t9(r,n,{recursive:!0}),await fT(rh(n,"LOCK"));let o=new Q5(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await fT(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var mT=async(e,t,r=hl)=>{let n=rh(r,e,"Local Extension Settings",t);if(!n9(n))return null;let o=await r9(rh(o9(),"codex"));await t9(n,o,{recursive:!0}),await fT(rh(o,"LOCK"));let i=new Q5(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await fT(o,{force:!0,recursive:!0})}}`,
    },
  ],
  alreadyText: ["async(t,e,r=Tc)", "async(e,t,r=hl)"],
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile instance matching",
  oldTexts: [
    {
      oldText: String.raw`rO=async(t,e)=>(await nO(t)).find(o=>o.instanceId===e)||null,nO=async t=>{let e=await oO();return await Promise.all(e.map(async r=>({...r,instanceId:await IS(r.id,t).catch(n=>(ee(n),null))})))},oO=async()=>{let t=tO(Tc,"Local State"),e=JSON.parse(await eO(t,"utf8"));return e.profile.profiles_order.map((r,n)=>{let o=e.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:e.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`rO=async(t,e)=>{let r=(await nO(t)).filter(n=>n.instanceId===e);return r.length===1?r[0]:null},nO=async t=>{let e=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await oO(r);e.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await IS(o.id,t,r).catch(i=>(ee(i),null))}))))}catch(n){ee(n)}return e},oO=async r=>{let n=tO(r,"Local State"),o=JSON.parse(await eO(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`a9=async(e,t)=>(await u9(e)).find(o=>o.instanceId===t)||null,u9=async e=>{let t=await c9();return await Promise.all(t.map(async r=>({...r,instanceId:await mT(r.id,e).catch(n=>(ne(n),null))})))},c9=async()=>{let e=s9(hl,"Local State"),t=JSON.parse(await i9(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`a9=async(e,t)=>{let r=(await u9(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},u9=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await c9(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await mT(o.id,e,r).catch(i=>(ne(i),null))}))))}catch(n){ne(n)}return t},c9=async r=>{let n=s9(r,"Local State"),o=JSON.parse(await i9(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
  ],
  alreadyText: "r.length===1?r[0]:null",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome active profile backend ordering",
  oldTexts: [
    {
      oldText: String.raw`d9=async e=>{let t=ST(),r=e.filter(o=>o.info.type==="iab"),n=p9(r,t);return await Promise.all(r.filter(o=>!n.includes(o)).map(async({api:o})=>o.close())),[...e.filter(o=>o.info.type!=="iab"),...n]},p9=(e,t)=>t==null?[]:e.filter(r=>r.info.metadata?.codexSessionId===t);`,
      newText: String.raw`d9=async e=>{let t=ST(),r=e.filter(o=>o.info.type==="iab"),n=p9(r,t);await Promise.all(r.filter(o=>!n.includes(o)).map(async({api:o})=>o.close()));let o=[...e.filter(i=>i.info.type!=="iab"),...n];return await codexLinuxRankBrowserBackends(o)},p9=(e,t)=>t==null?[]:e.filter(r=>r.info.metadata?.codexSessionId===t);async function codexLinuxRankBrowserBackends(e){if(yT()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ne(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
  ],
  alreadyText: "codexLinuxRankBrowserBackends",
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
    flatpakAppIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
  {
    name: "Brave Browser",
    bundleIds: ["com.brave.Browser"],
    flatpakAppIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "brave.exe",
  },
  {
    name: "Chromium",
    bundleIds: ["org.chromium.Chromium"],
    flatpakAppIds: ["org.chromium.Chromium"],
    appNames: ["Chromium.app"],
    commands: ["chromium", "chromium-browser"],
    windowsExecutable: "chrome.exe",
  },
];`,
    alreadyText: '"Brave Browser"',
  },
  {
    label: "Linux Flatpak browser inventory metadata",
    oldText: `const KNOWN_BROWSERS = [
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
    newText: `const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    flatpakAppIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
  {
    name: "Brave Browser",
    bundleIds: ["com.brave.Browser"],
    flatpakAppIds: ["com.brave.Browser"],
    appNames: ["Brave Browser.app"],
    commands: ["brave-browser", "brave"],
    windowsExecutable: "brave.exe",
  },
  {
    name: "Chromium",
    bundleIds: ["org.chromium.Chromium"],
    flatpakAppIds: ["org.chromium.Chromium"],
    appNames: ["Chromium.app"],
    commands: ["chromium", "chromium-browser"],
    windowsExecutable: "chrome.exe",
  },
];`,
    alreadyText: "flatpakAppIds",
  },
  {
    label: "Linux Flatpak browser inventory detection",
    oldText: `function findCommandBrowsers() {
  const found = new Map();

  for (const browser of KNOWN_BROWSERS) {
    for (const command of browser.commands) {
      const executable = commandPath(command);
      if (!executable) continue;

      found.set(browser.name, {
        name: browser.name,
        command,
        path: executable,
        bundle_id: browser.bundleIds[0] || null,
        version: null,
      });
      break;
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}`,
    newText: `function findFlatpakBrowser(browser) {
  if (!Array.isArray(browser.flatpakAppIds)) return null;

  const flatpak = commandPath("flatpak");
  if (!flatpak) return null;

  for (const appId of browser.flatpakAppIds) {
    const info = runCommand(["flatpak", "info", appId]);
    if (info == null) continue;
    const version = info
      .split(/\\r?\\n/)
      .map((line) => line.match(/^\\s*Version:\\s*(.+?)\\s*$/)?.[1] ?? null)
      .find((value) => value != null) ?? null;

    return {
      name: browser.name,
      command: "flatpak",
      path: flatpak,
      bundle_id: appId,
      version,
      flatpak_app_id: appId,
    };
  }

  return null;
}

function findCommandBrowsers() {
  const found = new Map();

  for (const browser of KNOWN_BROWSERS) {
    let browserFound = false;
    for (const command of browser.commands) {
      const executable = commandPath(command);
      if (!executable) continue;

      found.set(browser.name, {
        name: browser.name,
        command,
        path: executable,
        bundle_id: browser.bundleIds[0] || null,
        version: null,
      });
      browserFound = true;
      break;
    }

    if (!browserFound) {
      const flatpakBrowser = findFlatpakBrowser(browser);
      if (flatpakBrowser) found.set(browser.name, flatpakBrowser);
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}`,
    alreadyText: "findFlatpakBrowser",
  },
  {
    label: "Linux Flatpak browser inventory version parsing",
    oldText: `function findFlatpakBrowser(browser) {
  if (!Array.isArray(browser.flatpakAppIds)) return null;

  const flatpak = commandPath("flatpak");
  if (!flatpak) return null;

  for (const appId of browser.flatpakAppIds) {
    const version = runCommand(["flatpak", "info", "--show-version", appId]);
    if (version == null) continue;

    return {
      name: browser.name,
      command: "flatpak",
      path: flatpak,
      bundle_id: appId,
      version,
      flatpak_app_id: appId,
    };
  }

  return null;
}`,
    newText: `function findFlatpakBrowser(browser) {
  if (!Array.isArray(browser.flatpakAppIds)) return null;

  const flatpak = commandPath("flatpak");
  if (!flatpak) return null;

  for (const appId of browser.flatpakAppIds) {
    const info = runCommand(["flatpak", "info", appId]);
    if (info == null) continue;
    const version = info
      .split(/\\r?\\n/)
      .map((line) => line.match(/^\\s*Version:\\s*(.+?)\\s*$/)?.[1] ?? null)
      .find((value) => value != null) ?? null;

    return {
      name: browser.name,
      command: "flatpak",
      path: flatpak,
      bundle_id: appId,
      version,
      flatpak_app_id: appId,
    };
  }

  return null;
}`,
    alreadyText: 'runCommand(["flatpak", "info", appId])',
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
    `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
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

  return linuxChromeUserDataDirectory;`,
    linuxExtensionAwareUserDataFallbackWithoutFlatpak,
  ],
  newText: linuxExtensionAwareUserDataFallback,
  alreadyText: "linuxFlatpakChromeUserDataDirectory",
});

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Linux running browser extension profile preference",
  oldTexts: [
    `function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  ],
  newText: `function resolveChromeProfileDirectory(userDataDirectory) {
  const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);
  if (runningProfile) return runningProfile;

  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  alreadyText: `const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);`,
});

patchFileFirstMatch(path.join(scriptsDir, "check-extension-installed.js"), {
  label: "Linux running browser extension profile resolver",
  oldTexts: [`function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`],
  newText: `${linuxRunningProfileResolver}function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`,
  alreadyText: "function linuxProcessDirectories()",
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
    `  const linuxChromeUserDataDirectory = path.join(os.homedir(), ".config", "google-chrome");
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

  return linuxChromeUserDataDirectory;`,
    linuxDefaultBrowserUserDataFallbackWithoutFlatpak,
  ],
  newText: linuxDefaultBrowserUserDataFallback,
  alreadyText: "linuxFlatpakChromeUserDataDirectory",
});

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Linux running browser profile preference",
  oldTexts: [
    `function resolveChromeProfileDirectory(userDataDirectory) {
  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  ],
  newText: `function resolveChromeProfileDirectory(userDataDirectory) {
  const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);
  if (runningProfile) return runningProfile;

  const localStateProfile =
    resolveChromeProfileDirectoryFromLocalState(userDataDirectory);
  if (localStateProfile) return localStateProfile;
`,
  alreadyText: `const runningProfile =
    resolveChromeProfileDirectoryFromRunningProcess(userDataDirectory);`,
});

patchFileFirstMatch(path.join(scriptsDir, "open-chrome-window.js"), {
  label: "Linux running browser profile resolver",
  oldTexts: [`function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`],
  newText: `${linuxRunningProfileResolver}function resolveChromeProfileDirectoryFromLocalState(userDataDirectory) {`,
  alreadyText: "function linuxProcessDirectories()",
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
  let linuxArgs = chromeArgs;
  if (
    linuxUserDataDirectory.includes(
      path.join(".config", "BraveSoftware", "Brave-Browser"),
    )
  ) {
    linuxCommand = commandPath("brave-browser") || commandPath("brave") || "brave-browser";
  } else if (
    linuxUserDataDirectory.includes(
      path.join(".var", "app", "com.google.Chrome", "config", "google-chrome"),
    )
  ) {
    linuxCommand = commandPath("flatpak") || "flatpak";
    linuxArgs = ["run", "com.google.Chrome", ...chromeArgs];
  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  }

  return {
    command: linuxCommand,
    args: linuxArgs,
  };`,
    alreadyText: ["linuxArgs", "linuxCommand"],
  },
  {
    label: "Linux Flatpak browser window command",
    oldText: `  const linuxUserDataDirectory = resolveChromeUserDataDirectory();
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
    newText: `  const linuxUserDataDirectory = resolveChromeUserDataDirectory();
  let linuxCommand = commandPath("google-chrome") || commandPath("chrome") || "google-chrome";
  let linuxArgs = chromeArgs;
  if (
    linuxUserDataDirectory.includes(
      path.join(".config", "BraveSoftware", "Brave-Browser"),
    )
  ) {
    linuxCommand = commandPath("brave-browser") || commandPath("brave") || "brave-browser";
  } else if (
    linuxUserDataDirectory.includes(
      path.join(".var", "app", "com.google.Chrome", "config", "google-chrome"),
    )
  ) {
    linuxCommand = commandPath("flatpak") || "flatpak";
    linuxArgs = ["run", "com.google.Chrome", ...chromeArgs];
  } else if (linuxUserDataDirectory.includes(path.join(".config", "chromium"))) {
    linuxCommand = commandPath("chromium") || commandPath("chromium-browser") || "chromium";
  }

  return {
    command: linuxCommand,
    args: linuxArgs,
  };`,
    alreadyText: "linuxArgs",
  },
]);
