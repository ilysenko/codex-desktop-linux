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

function shouldSkipPatch(source, skipIf) {
  if (typeof skipIf === "function") {
    return skipIf(source);
  }
  return sourceIncludesAny(source, skipIf);
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

function patchFileFirstMatch(filePath, {
  label,
  oldTexts,
  newText,
  alreadyText = newText,
  skipIf = null,
  skipDescription = "target no longer exists in this upstream bundle",
}) {
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
  const alreadyPatched = [newText, alreadyText, ...candidates.map((candidate) => candidate.newText)]
    .filter((text) => typeof text === "string" && text.length > 0)
    .some((text) => source.includes(text));
  if (alreadyPatched) {
    console.log(`${path.basename(filePath)} already patched: ${label}`);
    return;
  }

  const match = candidates.find((candidate) => source.includes(candidate.oldText));
  if (!match) {
    if (shouldSkipPatch(source, skipIf)) {
      console.log(`${path.basename(filePath)} skipped: ${label} (${skipDescription})`);
      return;
    }
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

function browserClientHasMovedChromeProfileMetadata(source) {
  return (
    source.includes("setupBrowserRuntime") &&
    !source.includes("Local Extension Settings") &&
    !source.includes("Local State") &&
    !source.includes("extensionInstanceId")
  );
}

const legacyBrowserClientChromeProfileSkip = {
  skipIf: browserClientHasMovedChromeProfileMetadata,
  skipDescription: "Chrome profile metadata now lives outside browser-client.mjs",
};

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
  ...legacyBrowserClientChromeProfileSkip,
  oldTexts: [
    {
      oldText: String.raw`var Tc=GF(VF(),WF()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var Tc=GF(VF(),WF()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>WF()==="linux"?[GF(VF(),".config","BraveSoftware","Brave-Browser"),GF(VF(),".config","google-chrome"),GF(VF(),".config","chromium")]:[Tc];`,
    },
    {
      oldText: String.raw`var Ic=eO(tO(),rO()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var Ic=eO(tO(),rO()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>rO()==="linux"?[eO(tO(),".config","BraveSoftware","Brave-Browser"),eO(tO(),".config","google-chrome"),eO(tO(),".config","chromium")]:[Ic];`,
    },
    {
      oldText: String.raw`var hl=Y5(Z5(),X5()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var hl=Y5(Z5(),X5()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>X5()==="linux"?[Y5(Z5(),".config","BraveSoftware","Brave-Browser"),Y5(Z5(),".config","google-chrome"),Y5(Z5(),".config","chromium")]:[hl];`,
    },
    {
      oldText: String.raw`var kl=M9(F9(),L9()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var kl=M9(F9(),L9()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>L9()==="linux"?[M9(F9(),".config","BraveSoftware","Brave-Browser"),M9(F9(),".config","google-chrome"),M9(F9(),".config","chromium")]:[kl];`,
    },
    {
      oldText: String.raw`var $c=Nj(Oj(),Mj()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var $c=Nj(Oj(),Mj()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>Mj()==="linux"?[Nj(Oj(),".config","BraveSoftware","Brave-Browser"),Nj(Oj(),".config","google-chrome"),Nj(Oj(),".config","chromium")]:[$c];`,
    },
    {
      oldText: String.raw`var cd=d$(p$(),f$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var cd=d$(p$(),f$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>f$()==="linux"?[d$(p$(),".config","BraveSoftware","Brave-Browser"),d$(p$(),".config","google-chrome"),d$(p$(),".config","chromium")]:[cd];`,
    },
    {
      oldText: String.raw`var ld=Xq(Qq(),e$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var ld=Xq(Qq(),e$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>e$()==="linux"?[Xq(Qq(),".config","BraveSoftware","Brave-Browser"),Xq(Qq(),".config","google-chrome"),Xq(Qq(),".config","chromium")]:[ld];`,
    },
    {
      oldText: String.raw`var md=w$(x$(),S$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome");`,
      newText: String.raw`var md=w$(x$(),S$()==="win32"?"AppData\\Local\\Google\\Chrome\\User Data":"Library/Application Support/Google/Chrome"),codexLinuxChromeUserDataDirectories=()=>S$()==="linux"?[w$(x$(),".config","BraveSoftware","Brave-Browser"),w$(x$(),".config","google-chrome"),w$(x$(),".config","chromium")]:[md];`,
    },
  ],
  alreadyText: "codexLinuxChromeUserDataDirectories",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile metadata lookup",
  ...legacyBrowserClientChromeProfileSkip,
  oldTexts: [
    {
      oldText: String.raw`var IS=async(t,e)=>{let r=Gf(Tc,t,"Local Extension Settings",e);if(!XF(r))return null;let n=await JF(Gf(QF(),"codex"));await ZF(r,n,{recursive:!0}),await kS(Gf(n,"LOCK"));let o=new KF(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await kS(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var IS=async(t,e,r=Tc)=>{let n=Gf(r,t,"Local Extension Settings",e);if(!XF(n))return null;let o=await JF(Gf(QF(),"codex"));await ZF(n,o,{recursive:!0}),await kS(Gf(o,"LOCK"));let i=new KF(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await kS(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var mT=async(e,t)=>{let r=rh(hl,e,"Local Extension Settings",t);if(!n9(r))return null;let n=await r9(rh(o9(),"codex"));await t9(r,n,{recursive:!0}),await fT(rh(n,"LOCK"));let o=new Q5(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await fT(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var mT=async(e,t,r=hl)=>{let n=rh(r,e,"Local Extension Settings",t);if(!n9(n))return null;let o=await r9(rh(o9(),"codex"));await t9(n,o,{recursive:!0}),await fT(rh(o,"LOCK"));let i=new Q5(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await fT(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var U1=async(e,t)=>{let r=hh(kl,e,"Local Extension Settings",t);if(!$9(r))return null;let n=await q9(hh(z9(),"codex"));await j9(r,n,{recursive:!0}),await B1(hh(n,"LOCK"));let o=new B9(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await B1(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var U1=async(e,t,r=kl)=>{let n=hh(r,e,"Local Extension Settings",t);if(!$9(n))return null;let o=await q9(hh(z9(),"codex"));await j9(n,o,{recursive:!0}),await B1(hh(o,"LOCK"));let i=new B9(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await B1(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var bk=async(e,t)=>{let r=Ih($c,e,"Local Extension Settings",t);if(!jj(r))return null;let n=await Uj(Ih(qj(),"codex"));await Lj(r,n,{recursive:!0}),await gk(Ih(n,"LOCK"));let o=new Fj(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await gk(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var bk=async(e,t,r=$c)=>{let n=Ih(r,e,"Local Extension Settings",t);if(!jj(n))return null;let o=await Uj(Ih(qj(),"codex"));await Lj(n,o,{recursive:!0}),await gk(Ih(o,"LOCK"));let i=new Fj(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await gk(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var ak=async(e,t)=>{let r=Zh(cd,e,"Local Extension Settings",t);if(!y$(r))return null;let n=await b$(Zh(_$(),"codex"));await g$(r,n,{recursive:!0}),await sk(Zh(n,"LOCK"));let o=new m$(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await sk(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var ak=async(e,t,r=cd)=>{let n=Zh(r,e,"Local Extension Settings",t);if(!y$(n))return null;let o=await b$(Zh(_$(),"codex"));await g$(n,o,{recursive:!0}),await sk(Zh(o,"LOCK"));let i=new m$(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await sk(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var ZA=async(e,t)=>{let r=Zh(ld,e,"Local Extension Settings",t);if(!i$(r))return null;let n=await o$(Zh(s$(),"codex"));await n$(r,n,{recursive:!0}),await YA(Zh(n,"LOCK"));let o=new t$(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await YA(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var ZA=async(e,t,r=ld)=>{let n=Zh(r,e,"Local Extension Settings",t);if(!i$(n))return null;let o=await o$(Zh(s$(),"codex"));await n$(n,o,{recursive:!0}),await YA(Zh(o,"LOCK"));let i=new t$(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await YA(o,{force:!0,recursive:!0})}}`,
    },
    {
      oldText: String.raw`var fk=async(e,t)=>{let r=og(md,e,"Local Extension Settings",t);if(!A$(r))return null;let n=await T$(og(k$(),"codex"));await C$(r,n,{recursive:!0}),await pk(og(n,"LOCK"));let o=new v$(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await pk(n,{force:!0,recursive:!0})}}`,
      newText: String.raw`var fk=async(e,t,r=md)=>{let n=og(r,e,"Local Extension Settings",t);if(!A$(n))return null;let o=await T$(og(k$(),"codex"));await C$(n,o,{recursive:!0}),await pk(og(o,"LOCK"));let i=new v$(o,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await i.open();let s=await i.get("extensionInstanceId");if(!s)return null;let a=JSON.parse(s);return typeof a!="string"?null:a}finally{await i.close(),await pk(o,{force:!0,recursive:!0})}}`,
    },
  ],
  alreadyText: "async(t,e,r=Tc)",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome profile instance matching",
  ...legacyBrowserClientChromeProfileSkip,
  oldTexts: [
    {
      oldText: String.raw`rO=async(t,e)=>(await nO(t)).find(o=>o.instanceId===e)||null,nO=async t=>{let e=await oO();return await Promise.all(e.map(async r=>({...r,instanceId:await IS(r.id,t).catch(n=>(ee(n),null))})))},oO=async()=>{let t=tO(Tc,"Local State"),e=JSON.parse(await eO(t,"utf8"));return e.profile.profiles_order.map((r,n)=>{let o=e.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:e.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`rO=async(t,e)=>{let r=(await nO(t)).filter(n=>n.instanceId===e);return r.length===1?r[0]:null},nO=async t=>{let e=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await oO(r);e.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await IS(o.id,t,r).catch(i=>(ee(i),null))}))))}catch(n){ee(n)}return e},oO=async r=>{let n=tO(r,"Local State"),o=JSON.parse(await eO(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`a9=async(e,t)=>(await u9(e)).find(o=>o.instanceId===t)||null,u9=async e=>{let t=await c9();return await Promise.all(t.map(async r=>({...r,instanceId:await mT(r.id,e).catch(n=>(ne(n),null))})))},c9=async()=>{let e=s9(hl,"Local State"),t=JSON.parse(await i9(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`a9=async(e,t)=>{let r=(await u9(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},u9=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await c9(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await mT(o.id,e,r).catch(i=>(ne(i),null))}))))}catch(n){ne(n)}return t},c9=async r=>{let n=s9(r,"Local State"),o=JSON.parse(await i9(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`V9=async(e,t)=>(await G9(e)).find(o=>o.instanceId===t)||null,G9=async e=>{let t=await K9();return await Promise.all(t.map(async r=>({...r,instanceId:await U1(r.id,e).catch(n=>(ne(n),null))})))},K9=async()=>{let e=H9(kl,"Local State"),t=JSON.parse(await W9(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`V9=async(e,t)=>{let r=(await G9(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},G9=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await K9(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await U1(o.id,e,r).catch(i=>(ne(i),null))}))))}catch(n){ne(n)}return t},K9=async r=>{let n=H9(r,"Local State"),o=JSON.parse(await W9(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`Wj=async(e,t)=>(await Hj(e)).find(o=>o.instanceId===t)||null,Hj=async e=>{let t=await Vj();return await Promise.all(t.map(async r=>({...r,instanceId:await bk(r.id,e).catch(n=>(ue(n),null))})))},Vj=async()=>{let e=zj($c,"Local State"),t=JSON.parse(await $j(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`Wj=async(e,t)=>{let r=(await Hj(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},Hj=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await Vj(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await bk(o.id,e,r).catch(i=>(ue(i),null))}))))}catch(n){ue(n)}return t},Vj=async r=>{let n=zj(r,"Local State"),o=JSON.parse(await $j(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`S$=async(e,t)=>(await v$(e)).find(o=>o.instanceId===t)||null,v$=async e=>{let t=await E$();return await Promise.all(t.map(async r=>({...r,instanceId:await ak(r.id,e).catch(n=>(ue(n),null))})))},E$=async()=>{let e=x$(cd,"Local State"),t=JSON.parse(await w$(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`S$=async(e,t)=>{let r=(await v$(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},v$=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await E$(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await ak(o.id,e,r).catch(i=>(ue(i),null))}))))}catch(n){ue(n)}return t},E$=async r=>{let n=x$(r,"Local State"),o=JSON.parse(await w$(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`l$=async(e,t)=>(await c$(e)).find(o=>o.instanceId===t)||null,c$=async e=>{let t=await d$();return await Promise.all(t.map(async r=>({...r,instanceId:await ZA(r.id,e).catch(n=>(ue(n),null))})))},d$=async()=>{let e=u$(ld,"Local State"),t=JSON.parse(await a$(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`l$=async(e,t)=>{let r=(await c$(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},c$=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await d$(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await ZA(o.id,e,r).catch(i=>(ue(i),null))}))))}catch(n){ue(n)}return t},d$=async r=>{let n=u$(r,"Local State"),o=JSON.parse(await a$(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
    {
      oldText: String.raw`P$=async(e,t)=>(await D$(e)).find(o=>o.instanceId===t)||null,D$=async e=>{let t=await N$();return await Promise.all(t.map(async r=>({...r,instanceId:await fk(r.id,e).catch(n=>(ue(n),null))})))},N$=async()=>{let e=R$(md,"Local State"),t=JSON.parse(await I$(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)}`,
      newText: String.raw`P$=async(e,t)=>{let r=(await D$(e)).filter(n=>n.instanceId===t);return r.length===1?r[0]:null},D$=async e=>{let t=[];for(let r of codexLinuxChromeUserDataDirectories())try{let n=await N$(r);t.push(...await Promise.all(n.map(async o=>({...o,userDataDir:r,instanceId:await fk(o.id,e,r).catch(i=>(ue(i),null))}))))}catch(n){ue(n)}return t},N$=async r=>{let n=R$(r,"Local State"),o=JSON.parse(await I$(n,"utf8"));return o.profile.profiles_order.map((i,s)=>{let a=o.profile.info_cache[i];return a?{id:i,name:a.name,isLastUsed:o.profile.last_used===i,orderingIndex:s,avatarUrl:a.avatar_icon}:null}).filter(i=>!!i)}`,
    },
  ],
  alreadyText: "r.length===1?r[0]:null",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux Chrome active profile backend ordering",
  ...legacyBrowserClientChromeProfileSkip,
  oldTexts: [
    {
      oldText: String.raw`d9=async e=>{let t=ST(),r=e.filter(o=>o.info.type==="iab"),n=p9(r,t);return await Promise.all(r.filter(o=>!n.includes(o)).map(async({api:o})=>o.close())),[...e.filter(o=>o.info.type!=="iab"),...n]},p9=(e,t)=>t==null?[]:e.filter(r=>r.info.metadata?.codexSessionId===t);`,
      newText: String.raw`d9=async e=>{let t=ST(),r=e.filter(o=>o.info.type==="iab"),n=p9(r,t);await Promise.all(r.filter(o=>!n.includes(o)).map(async({api:o})=>o.close()));let o=[...e.filter(i=>i.info.type!=="iab"),...n];return await codexLinuxRankBrowserBackends(o)},p9=(e,t)=>t==null?[]:e.filter(r=>r.info.metadata?.codexSessionId===t);async function codexLinuxRankBrowserBackends(e){if(yT()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ne(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
    {
      oldText: String.raw`Y9=async(e,{codexSessionId:t})=>{let r=Vd(py),n=e.filter(i=>i.info.type==="iab"),o=Z9(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},Z9=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r))`,
      newText: String.raw`Y9=async(e,{codexSessionId:t})=>{let r=Vd(py),n=e.filter(i=>i.info.type==="iab"),o=Z9(n,t,r);await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close()));let s=[...e.filter(i=>i.info.type!=="iab"),...o];return await codexLinuxRankBrowserBackends(s)},Z9=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));async function codexLinuxRankBrowserBackends(e){if(L9()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ne(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
    {
      oldText: String.raw`Kj=async(e,{codexSessionId:t})=>{let r=ap(Ey),n=e.filter(i=>i.info.type==="iab"),o=Jj(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},Jj=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`,
      newText: String.raw`Kj=async(e,{codexSessionId:t})=>{let r=ap(Ey),n=e.filter(i=>i.info.type==="iab"),o=Jj(n,t,r);await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close()));let s=[...e.filter(i=>i.info.type!=="iab"),...o];return await codexLinuxRankBrowserBackends(s)},Jj=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));async function codexLinuxRankBrowserBackends(e){if(Mj()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ue(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
    {
      oldText: String.raw`A$=async(e,{codexSessionId:t})=>{let r=Gu(Vy),n=e.filter(i=>i.info.type==="iab"),o=k$(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},k$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`,
      newText: String.raw`A$=async(e,{codexSessionId:t})=>{let r=Gu(Vy),n=e.filter(i=>i.info.type==="iab"),o=k$(n,t,r);await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close()));let s=[...e.filter(i=>i.info.type!=="iab"),...o];return await codexLinuxRankBrowserBackends(s)},k$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));async function codexLinuxRankBrowserBackends(e){if(f$()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ue(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
    {
      oldText: String.raw`f$=async(e,{codexSessionId:t})=>{let r=Vu(Vy),n=e.filter(i=>i.info.type==="iab"),o=m$(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},m$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`,
      newText: String.raw`f$=async(e,{codexSessionId:t})=>{let r=Vu(Vy),n=e.filter(i=>i.info.type==="iab"),o=m$(n,t,r);await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close()));let s=[...e.filter(i=>i.info.type!=="iab"),...o];return await codexLinuxRankBrowserBackends(s)},m$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));async function codexLinuxRankBrowserBackends(e){if(p$.platform()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ue(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
    {
      oldText: String.raw`F$=async(e,{codexSessionId:t})=>{let r=Ju(e_),n=e.filter(i=>i.info.type==="iab"),o=B$(n,t,r);return await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close())),[...e.filter(i=>i.info.type!=="iab"),...o]},B$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));`,
      newText: String.raw`F$=async(e,{codexSessionId:t})=>{let r=Ju(e_),n=e.filter(i=>i.info.type==="iab"),o=B$(n,t,r);await Promise.all(n.filter(i=>!o.includes(i)).map(async({api:i})=>i.close()));let s=[...e.filter(i=>i.info.type!=="iab"),...o];return await codexLinuxRankBrowserBackends(s)},B$=(e,t,r)=>t==null?[]:e.filter(n=>n.info.metadata?.codexSessionId===t&&(r==null||n.info.metadata.codexAppBuildFlavor===r));async function codexLinuxRankBrowserBackends(e){if(O$.platform()!=="linux")return e;let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare(e,t){let r=e.browser.info.type==="extension",n=t.browser.info.type==="extension";return!r||!n?e.index-t.index:codexLinuxExtensionBackendScore(t)-codexLinuxExtensionBackendScore(e)||e.index-t.index}async function codexLinuxExtensionUserTabCount(e){if(e.info.type!=="extension")return-1;try{let t=await Promise.race([e.api.getUserTabs(),new Promise((r,n)=>setTimeout(()=>n(new Error("Chrome profile tab probe timed out")),750))]);return Array.isArray(t)?t.length:0}catch(t){return ue(t),0}}function codexLinuxExtensionBackendScore(e){let t=e.userTabCount>0?1e4+e.userTabCount:0,r=e.browser.info.metadata??{};r.profileIsLastUsed==="true"&&(t+=100);let n=Number(r.profileOrdering);return Number.isFinite(n)?t-n:t}`,
    },
  ],
  alreadyText: "codexLinuxRankBrowserBackends",
});

patchFile(path.join(scriptsDir, "browser-client.mjs"), [
  {
    label: "Linux idle Chrome profile filtering",
    oldText: String.raw`let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return t.sort(codexLinuxBackendCompare).map(({browser:r})=>r)}function codexLinuxBackendCompare`,
    newText: String.raw`let t=await Promise.all(e.map(async(r,n)=>({browser:r,index:n,userTabCount:await codexLinuxExtensionUserTabCount(r)})));return (await codexLinuxFilterBrowserBackends(t)).sort(codexLinuxBackendCompare).map(({browser:r})=>r)}async function codexLinuxFilterBrowserBackends(e){let t=e.some(r=>r.browser.info.type==="extension"&&r.userTabCount>0);if(!t)return e;let r=e.filter(n=>n.browser.info.type!=="extension"||n.userTabCount>0),n=e.filter(o=>o.browser.info.type==="extension"&&o.userTabCount===0);return await codexLinuxCloseDiscardedBrowserBackends(n),r}async function codexLinuxCloseDiscardedBrowserBackends(e){await Promise.all(e.map(async({browser:t})=>{try{await t.api.close()}catch{}}))}function codexLinuxBackendCompare`,
    alreadyText: "codexLinuxCloseDiscardedBrowserBackends",
  },
]);

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux ambiguous active Chrome extension alias guard",
  oldTexts: [
    {
      oldText: String.raw`function lk({browserId:e,clientInfo:t,requestedBrowserId:r}){return cd(r)?eg(t.type)===r:e===r}var B$`,
      newText: String.raw`function lk({browserId:e,clientInfo:t,requestedBrowserId:r}){return cd(r)?eg(t.type)===r:e===r}function codexLinuxRejectAmbiguousBrowserAlias(e,t){if(p$.platform()!=="linux"||e!=="extension")return;let r=t.filter(n=>n.clientInfo.type==="extension");if(r.length<=1)return;let n=r.map(o=>{let i=o.clientInfo.metadata??{},s=i.profileName??i.profileDirectory??i.extensionInstanceId??"unknown-profile";return o.browserId+" ("+s+")"}).join(", ");throw new Error('Multiple Chrome extension instances are connected. Use a specific browser id instead of "extension": '+n)}var B$`,
    },
    {
      oldText: String.raw`function Ck({browserId:e,clientInfo:t,requestedBrowserId:r}){return hd(r)?ag(t.type)===r:e===r}var a7`,
      newText: String.raw`function Ck({browserId:e,clientInfo:t,requestedBrowserId:r}){return hd(r)?ag(t.type)===r:e===r}function codexLinuxRejectAmbiguousBrowserAlias(e,t){if(O$.platform()!=="linux"||e!=="extension")return;let r=t.filter(n=>n.clientInfo.type==="extension");if(r.length<=1)return;let n=r.map(o=>{let i=o.clientInfo.metadata??{},s=i.profileName??i.profileDirectory??i.extensionInstanceId??"unknown-profile";return o.browserId+" ("+s+")"}).join(", ");throw new Error('Multiple Chrome extension instances are connected. Use a specific browser id instead of "extension": '+n)}var a7`,
    },
  ],
  alreadyText: "codexLinuxRejectAmbiguousBrowserAlias",
});

patchFileFirstMatch(path.join(scriptsDir, "browser-client.mjs"), {
  label: "Linux ambiguous active Chrome extension alias check",
  oldTexts: [
    {
      oldText: String.raw`if(cd(p.browser_id)){let h=dd(p.browser_id);tg(h)||hk({diagnostics:n,reason:"backend-disabled",requestedBrowserId:p.browser_id}),ck(h)}let f=i.find`,
      newText: String.raw`if(cd(p.browser_id)){let h=dd(p.browser_id);tg(h)||hk({diagnostics:n,reason:"backend-disabled",requestedBrowserId:p.browser_id}),ck(h),codexLinuxRejectAmbiguousBrowserAlias(p.browser_id,i)}let f=i.find`,
    },
    {
      oldText: String.raw`if(hd(p.browser_id)){let h=cu(p.browser_id);ug(h)||Rk({diagnostics:n,reason:"backend-disabled",requestedBrowserId:p.browser_id}),Tk(h)}let f=i.find`,
      newText: String.raw`if(hd(p.browser_id)){let h=cu(p.browser_id);ug(h)||Rk({diagnostics:n,reason:"backend-disabled",requestedBrowserId:p.browser_id}),Tk(h),codexLinuxRejectAmbiguousBrowserAlias(p.browser_id,i)}let f=i.find`,
    },
  ],
  alreadyText: "codexLinuxRejectAmbiguousBrowserAlias(p.browser_id,i)",
});

patchFile(path.join(pluginDir, "skills", "control-chrome", "SKILL.md"), [
  {
    label: "safe multi-profile Chrome bootstrap",
    oldText: `const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
globalThis.browser = await agent.browsers.get("extension");
nodeRepl.write(await browser.documentation());`,
    newText: `const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
const browserInfos = await agent.browsers.list();
const extensionInfos = browserInfos.filter((info) => info.type === "extension");
if (extensionInfos.length === 0) {
  throw new Error("No Chrome extension browser is connected.");
}
if (extensionInfos.length === 1) {
  globalThis.browser = await agent.browsers.get(extensionInfos[0].id);
} else {
  const summaries = [];
  for (const info of extensionInfos) {
    const candidate = await agent.browsers.get(info.id);
    let tabs = [];
    let error;
    try {
      tabs = await Promise.race([
        candidate.user.openTabs(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Chrome profile tab probe timed out")),
            750,
          ),
        ),
      ]);
    } catch (caught) {
      error = String(caught);
    }
    summaries.push({
      id: info.id,
      metadata: info.metadata,
      tabs: Array.isArray(tabs) ? tabs : [],
      ...(error ? { error } : {}),
    });
  }
  const activeSummaries = summaries.filter(
    ({ tabs }) => Array.isArray(tabs) && tabs.length > 0,
  );
  if (activeSummaries.length === 1) {
    globalThis.browser = await agent.browsers.get(activeSummaries[0].id);
  } else {
    nodeRepl.write(JSON.stringify(summaries, null, 2));
    throw new Error(
      activeSummaries.length > 1
        ? "Multiple active Chrome extension instances are connected. Pick the id that matches the existing user tab/profile, then run globalThis.browser = await agent.browsers.get('<id>')."
        : "No active Chrome user tabs were found. Pick the profile id to use before creating a new tab.",
    );
  }
}
nodeRepl.write(await browser.documentation());`,
    alreadyText: "Multiple Chrome extension instances are connected",
  },
  {
    label: "prefer active Chrome profile bootstrap",
    oldText: `const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
const browserInfos = await agent.browsers.list();
const extensionInfos = browserInfos.filter((info) => info.type === "extension");
if (extensionInfos.length === 0) {
  throw new Error("No Chrome extension browser is connected.");
}
if (extensionInfos.length === 1) {
  globalThis.browser = await agent.browsers.get(extensionInfos[0].id);
} else {
  const summaries = [];
  for (const info of extensionInfos) {
    const candidate = await agent.browsers.get(info.id);
    const tabs = await candidate.user.openTabs().catch((error) => [
      { error: String(error) },
    ]);
    summaries.push({ id: info.id, metadata: info.metadata, tabs });
  }
  nodeRepl.write(JSON.stringify(summaries, null, 2));
  throw new Error(
    "Multiple Chrome extension instances are connected. Pick the id that matches the existing user tab/profile, then run globalThis.browser = await agent.browsers.get('<id>').",
  );
}
nodeRepl.write(await browser.documentation());`,
    newText: `const { setupBrowserRuntime } = await import("<plugin root>/scripts/browser-client.mjs");
await setupBrowserRuntime({ globals: globalThis });
const browserInfos = await agent.browsers.list();
const extensionInfos = browserInfos.filter((info) => info.type === "extension");
if (extensionInfos.length === 0) {
  throw new Error("No Chrome extension browser is connected.");
}
if (extensionInfos.length === 1) {
  globalThis.browser = await agent.browsers.get(extensionInfos[0].id);
} else {
  const summaries = [];
  for (const info of extensionInfos) {
    const candidate = await agent.browsers.get(info.id);
    let tabs = [];
    let error;
    try {
      tabs = await Promise.race([
        candidate.user.openTabs(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Chrome profile tab probe timed out")),
            750,
          ),
        ),
      ]);
    } catch (caught) {
      error = String(caught);
    }
    summaries.push({
      id: info.id,
      metadata: info.metadata,
      tabs: Array.isArray(tabs) ? tabs : [],
      ...(error ? { error } : {}),
    });
  }
  const activeSummaries = summaries.filter(
    ({ tabs }) => Array.isArray(tabs) && tabs.length > 0,
  );
  if (activeSummaries.length === 1) {
    globalThis.browser = await agent.browsers.get(activeSummaries[0].id);
  } else {
    nodeRepl.write(JSON.stringify(summaries, null, 2));
    throw new Error(
      activeSummaries.length > 1
        ? "Multiple active Chrome extension instances are connected. Pick the id that matches the existing user tab/profile, then run globalThis.browser = await agent.browsers.get('<id>')."
        : "No active Chrome user tabs were found. Pick the profile id to use before creating a new tab.",
    );
  }
}
nodeRepl.write(await browser.documentation());`,
    alreadyText: "activeSummaries",
  },
  {
    label: "Chrome active profile bootstrap ignores tab probe errors",
    oldText: `    const tabs = await candidate.user.openTabs().catch((error) => [
      { error: String(error) },
    ]);
    summaries.push({ id: info.id, metadata: info.metadata, tabs });`,
    newText: `    let tabs = [];
    let error;
    try {
      tabs = await candidate.user.openTabs();
    } catch (caught) {
      error = String(caught);
    }
    summaries.push({
      id: info.id,
      metadata: info.metadata,
      tabs: Array.isArray(tabs) ? tabs : [],
      ...(error ? { error } : {}),
    });`,
    alreadyText: "tabs: Array.isArray(tabs) ? tabs : []",
  },
  {
    label: "Chrome active profile bootstrap bounds tab probes",
    oldText: `    try {
      tabs = await candidate.user.openTabs();
    } catch (caught) {`,
    newText: `    try {
      tabs = await Promise.race([
        candidate.user.openTabs(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Chrome profile tab probe timed out")),
            750,
          ),
        ),
      ]);
    } catch (caught) {`,
    alreadyText: "Chrome profile tab probe timed out",
  },
  {
    label: "Chrome profile launch guard",
    oldText: `Use the browser bound to \`browser\` for tasks in this skill.`,
    newText: `Use the browser bound to \`browser\` for tasks in this skill.

When more than one Chrome extension instance is connected, enumerate \`agent.browsers.list()\`, inspect each extension instance with \`browser.user.openTabs()\`, and bind by the active browser id that matches the user's visible tab, URL, title, or profile metadata. Ignore connected extension instances that have no user tabs when another profile has active user tabs.

Do not call \`browser.tabs.new()\` until the intended browser/profile has been selected. On Linux, creating a tab on the wrong extension backend can start a different Chrome or Brave profile instead of using the already-open user profile.`,
    alreadyText: "creating a tab on the wrong extension backend",
  },
]);

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
  ],
  newText: linuxDefaultBrowserUserDataFallback,
  alreadyText: "linuxChromiumUserDataDirectory",
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
