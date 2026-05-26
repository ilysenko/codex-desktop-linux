#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  enabledLinuxFeatureIds,
  enabledLinuxFeatureStageHooks,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { applyThoriumChromeExtensionStatusPatch } = require("./patch.js");

const repoRoot = path.resolve(__dirname, "..", "..");

function withTempFeatureRoot(enabled, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thorium-feature-root-"));
  try {
    fs.writeFileSync(path.join(root, "features.example.json"), JSON.stringify({ enabled: [] }, null, 2));
    fs.writeFileSync(path.join(root, "features.json"), JSON.stringify({ enabled }, null, 2));
    fs.cpSync(__dirname, path.join(root, "thorium-chrome-plugin"), { recursive: true });
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function writeFakeChromePlugin(pluginDir) {
  const scriptsDir = path.join(pluginDir, "scripts");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, "installManifest.mjs"),
    'var n={extensionId:"hehggadaopoacecdllhhajmbjkdcmajg",extensionHostName:"com.openai.codexextension"};var p=o=>{let t=`${o.extensionHostName}.json`,r={darwin:["Library/Application Support/Google/Chrome/NativeMessagingHosts"],linux:[".config/google-chrome/NativeMessagingHosts"],win32:["AppData/Local/OpenAI/extension"]}[m.platform()];return r.map(s=>l.resolve(m.homedir(),s,t))};\n',
  );
  fs.writeFileSync(
    path.join(scriptsDir, "browser-client.mjs"),
    'import{resolve as GF}from"path";import{homedir as VF,platform as WF}from"os";var Tc=GF(VF(),WF()==="win32"?"AppData\\\\Local\\\\Google\\\\Chrome\\\\User Data":"Library/Application Support/Google/Chrome");var IS=async(t,e)=>{let r=Gf(Tc,t,"Local Extension Settings",e);if(!XF(r))return null;let n=await JF(Gf(QF(),"codex"));await ZF(r,n,{recursive:!0}),await kS(Gf(n,"LOCK"));let o=new KF(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await kS(n,{force:!0,recursive:!0})}};var AS=async t=>t,rO=async(t,e)=>(await nO(t)).find(o=>o.instanceId===e)||null,nO=async t=>{let e=await oO();return await Promise.all(e.map(async r=>({...r,instanceId:await IS(r.id,t).catch(n=>(ee(n),null))})))},oO=async()=>{let t=tO(Tc,"Local State"),e=JSON.parse(await eO(t,"utf8"));return e.profile.profiles_order.map((r,n)=>{let o=e.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:e.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};\n',
  );
  fs.writeFileSync(
    path.join(scriptsDir, "check-native-host-manifest.js"),
    `function getNativeHostManifestLocation() {
  if (process.platform === "win32") {
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
  );
}
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "installed-browsers.js"),
    `const KNOWN_BROWSERS = [
  {
    name: "Google Chrome",
    bundleIds: ["com.google.Chrome"],
    appNames: ["Google Chrome.app"],
    commands: ["google-chrome", "chrome"],
    windowsExecutable: "chrome.exe",
  },
];
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "chrome-is-running.js"),
    `const CHROME_PROCESS_NAMES_BY_PLATFORM = {
  darwin: new Set(["Google Chrome", "Google Chrome Helper"]),
  win32: new Set(["chrome.exe"]),
};
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "check-extension-installed.js"),
    `function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}
`,
  );
  fs.writeFileSync(
    path.join(scriptsDir, "open-chrome-window.js"),
    `function resolveChromeUserDataDirectory() {
  return path.join(os.homedir(), ".config", "google-chrome");
}

function getOpenChromeCommand(profileDirectory) {
  const chromeArgs = [
    \`--profile-directory=\${profileDirectory}\`,
    "--new-window",
    ABOUT_BLANK_URL,
  ];

  return {
    command: "google-chrome",
    args: chromeArgs,
  };
}
`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

test("Thorium Chrome plugin feature stays disabled until listed in features.json", () => {
  withTempFeatureRoot([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(enabledLinuxFeatureStageHooks({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("Thorium Chrome plugin feature exposes its patch and stage hook when enabled", () => {
  withTempFeatureRoot(["thorium-chrome-plugin"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["thorium-chrome-plugin"]);
    assert.equal(enabledLinuxFeatureStageHooks({ featuresRoot: root }).length, 1);
    assert.equal(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }).length, 1);
  });
});

test("Thorium settings patch extends the core Linux Chrome status helper", () => {
  const source =
    "function codexLinuxChromeProfileRoots({homeDir:e,platform:t}){return t===`linux`?[(0,p.join)(e,`.config`,`BraveSoftware`,`Brave-Browser`),(0,p.join)(e,`.config`,`google-chrome`),(0,p.join)(e,`.config`,`google-chrome-beta`),(0,p.join)(e,`.config`,`google-chrome-unstable`),(0,p.join)(e,`.var`,`app`,`com.google.Chrome`,`config`,`google-chrome`),(0,p.join)(e,`.config`,`chromium`)]:[]}function codexLinuxChromeCommand(){for(let t of[`brave-browser`,`brave`,`google-chrome`,`google-chrome-stable`,`chromium-browser`,`chromium`]){}}throw Error(`Google Chrome, Brave, or Chromium is not installed`)";
  const patched = applyThoriumChromeExtensionStatusPatch(source);

  assert.match(patched, /`\.var`,`app`,`com\.google\.Chrome`,`config`,`google-chrome`/);
  assert.match(patched, /`\.config`,`thorium`/);
  assert.match(patched, /`thorium-browser-avx2`/);
  assert.match(patched, /Google Chrome, Brave, Chromium, or Thorium is not installed/);
});

test("Thorium stage hook upgrades a core Linux-patched Chrome plugin", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thorium-stage-"));
  try {
    const installDir = path.join(workspace, "install");
    const workDir = path.join(workspace, "work");
    const chromePlugin = path.join(installDir, "resources", "plugins", "openai-bundled", "plugins", "chrome");
    const featuresConfig = path.join(workspace, "features.json");

    fs.mkdirSync(workDir, { recursive: true });
    writeFakeChromePlugin(chromePlugin);
    fs.writeFileSync(featuresConfig, JSON.stringify({ enabled: ["thorium-chrome-plugin"] }, null, 2));

    run("node", [path.join(repoRoot, "scripts", "lib", "patch-chrome-plugin.js"), chromePlugin]);
    run("bash", [
      "-lc",
      [
        "source \"$LINUX_FEATURES_RUNNER\"",
        "info(){ echo \"$*\" >&2; }",
        "warn(){ echo \"$*\" >&2; }",
        "SCRIPT_DIR=\"$REPO_ROOT\"",
        "INSTALL_DIR=\"$INSTALL_DIR\"",
        "WORK_DIR=\"$WORK_DIR\"",
        "ARCH=x86_64",
        "run_linux_feature_stage_hooks",
      ].join("\n"),
    ], {
      env: {
        ...process.env,
        CODEX_LINUX_FEATURES_CONFIG: featuresConfig,
        LINUX_FEATURES_RUNNER: path.join(repoRoot, "scripts", "lib", "linux-features.sh"),
        REPO_ROOT: repoRoot,
        INSTALL_DIR: installDir,
        WORK_DIR: workDir,
      },
    });

    const scriptsDir = path.join(chromePlugin, "scripts");
    assert.match(fs.readFileSync(path.join(scriptsDir, "installManifest.mjs"), "utf8"), /thorium\/NativeMessagingHosts/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "installManifest.mjs"), "utf8"), /com\.google\.Chrome\/config\/google-chrome\/NativeMessagingHosts/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "check-native-host-manifest.js"), "utf8"), /"thorium"/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "check-native-host-manifest.js"), "utf8"), /"com\.google\.Chrome"/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8"), /"\.config","thorium"/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8"), /"com\.google\.Chrome","config","google-chrome"/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "installed-browsers.js"), "utf8"), /Thorium/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "installed-browsers.js"), "utf8"), /flatpakAppIds/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "chrome-is-running.js"), "utf8"), /thorium-browser-avx2/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "check-extension-installed.js"), "utf8"), /linuxThoriumUserDataDirectory/);
    assert.match(fs.readFileSync(path.join(scriptsDir, "open-chrome-window.js"), "utf8"), /commandPath\("thorium-browser-avx2"\)/);
    assert.equal(
      fs.readFileSync(path.join(installDir, ".codex-linux", "chrome-native-host-manifest-paths"), "utf8").trim(),
      ".config/thorium/NativeMessagingHosts",
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("Thorium patcher handles the current browser-client metadata shape", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thorium-current-browser-client-"));
  try {
    const chromePlugin = path.join(workspace, "chrome");
    const scriptsDir = path.join(chromePlugin, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(scriptsDir, "browser-client.mjs"),
      'import{readFile as i9}from"fs/promises";import{resolve as s9}from"path";import{resolve as Y5}from"path";import{homedir as Z5,platform as X5}from"os";var hl=Y5(Z5(),X5()==="win32"?"AppData\\\\Local\\\\Google\\\\Chrome\\\\User Data":"Library/Application Support/Google/Chrome");import{ClassicLevel as Q5}from"./node_modules/classic-level.mjs";import{resolve as rh}from"path";import{tmpdir as e9}from"os";import{cp as t9,mkdtemp as r9,rm as fT}from"fs/promises";import{existsSync as n9}from"fs";var mT=async(e,t)=>{let r=rh(hl,e,"Local Extension Settings",t);if(!n9(r))return null;let n=await r9(rh(o9(),"codex"));await t9(r,n,{recursive:!0}),await fT(rh(n,"LOCK"));let o=new Q5(n,{createIfMissing:!1,keyEncoding:"utf8",valueEncoding:"utf8"});try{await o.open();let i=await o.get("extensionInstanceId");if(!i)return null;let s=JSON.parse(i);return typeof s!="string"?null:s}finally{await o.close(),await fT(n,{force:!0,recursive:!0})}},o9=()=>"nodeRepl"in globalThis&&globalThis.nodeRepl?globalThis.nodeRepl.tmpDir:e9();var hT=async e=>e,a9=async(e,t)=>(await u9(e)).find(o=>o.instanceId===t)||null,u9=async e=>{let t=await c9();return await Promise.all(t.map(async r=>({...r,instanceId:await mT(r.id,e).catch(n=>(ne(n),null))})))},c9=async()=>{let e=s9(hl,"Local State"),t=JSON.parse(await i9(e,"utf8"));return t.profile.profiles_order.map((r,n)=>{let o=t.profile.info_cache[r];return o?{id:r,name:o.name,isLastUsed:t.profile.last_used===r,orderingIndex:n,avatarUrl:o.avatar_icon}:null}).filter(r=>!!r)};\n',
    );

    run("node", [path.join(repoRoot, "linux-features", "thorium-chrome-plugin", "patch-chrome-plugin.js"), chromePlugin]);

    const patched = fs.readFileSync(path.join(scriptsDir, "browser-client.mjs"), "utf8");
    assert.match(patched, /codexLinuxChromeUserDataDirectories/);
    assert.match(patched, /"com\.google\.Chrome","config","google-chrome"/);
    assert.match(patched, /"\.config","thorium"/);
    assert.match(patched, /async\(e,t,r=hl\)/);
    assert.match(patched, /r\.length===1\?r\[0\]:null/);
    assert.match(patched, /instanceId:await mT\(o\.id,e,r\)/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
