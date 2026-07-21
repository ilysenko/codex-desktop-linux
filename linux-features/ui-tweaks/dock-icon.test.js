#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  applyDockIconMainPatch,
  applyDockIconSearchPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconEnabled,
} = require("./patches/dock-icon.js");
const {
  applyLinuxSettingsSearchVisibilityPatch,
} = require("../../scripts/patches/impl/webview/index.js");

const currentAppInfoSource = [
  "function F_(e,t){return`icon-chatgpt`}",
  "function I_(e){return{dark:`icon-codex-dark-color.png`,light:`icon-codex-light.png`}}",
  "function R_(e,t){if(process.platform!==`darwin`||t==null)return null;let n=I_(e),r=z_(`${F_(e,t)}.png`),i=z_(n.dark),a=z_(n.light);return r==null||i==null||a==null?null:{appDefault:r,codexDark:i,codexLight:a}}",
  "function z_(e){if(e==null)return null;let t=l.app.isPackaged?(0,f.join)(process.resourcesPath,e):null,n=t!=null&&(0,g.existsSync)(t)?t:(0,f.join)(l.app.getAppPath(),`src`,`icons`,e),r=l.nativeImage.createFromPath(n);return r.isEmpty()?null:r.resize({width:128,height:128,quality:`best`}).toDataURL()}",
].join("");

const currentRuntimeSource = [
  "function Xie({appBrand:e,buildFlavor:r,settingsStore:p,repoRoot:_,isMacOS:v,onWindowRegistered:C,disposables:w}){",
  "let T=(0,f.join)(_,`electron`,`src`,`icons`),E=e=>{if(!l.app.isPackaged)return null;let t=(0,f.join)(process.resourcesPath,e);return(0,g.existsSync)(t)?t:null},",
  "D=e=>null,O=e=>E(e)??D(e),k=()=>p.get(n.cc.DOCK_ICON_PREFERENCE)??`app-default`,",
  "A=()=>O(`${F_(r,e)}.png`),j=I_(r),M=()=>l.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?j.dark:j.light,",
  "N=t=>{if(t===`app-default`&&r!==i.a.Dev&&(l.app.isPackaged||e===n.rl.ChatGPT)){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let a=t===`codex-system`?M():null,o=(a==null?null:O(a))??A(),s=o==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(o);s.isEmpty()||l.app.dock?.setIcon(s)},",
  "P=()=>{if(!v)return;let e=k();N(e),NZ({preference:e,resourceName:e===`codex-system`?j.light:null}).then(e=>{e&&N(k())})};",
  "if(v){P();let e=()=>{let e=k();e===`codex-system`&&N(e)};l.nativeTheme.on(`updated`,e),w.add(()=>{l.nativeTheme.off(`updated`,e)})}",
  "let F=null,I=new Rie({onWindowRegistered:e=>{F?.registerWindow(e),C?.(e)}});",
  "return{updateDockIcon:P,windowManager:I}}",
].join("");

const currentTraySource =
  "let codexLinuxTray=null,codexLinuxRegisterTray=e=>(codexLinuxTray=e,e);async function dae(e){let t=await fae(e.buildFlavor,e.appBrand,e.repoRoot),n=codexLinuxRegisterTray(new l.Tray(t.defaultIcon));if(!G9)return n.destroy(),null;return n}";

const currentMainSource = currentAppInfoSource + currentRuntimeSource + currentTraySource;

const currentSettingsSource =
  "function Xi(){let e=(0,Q.c)(27),t=n(m),r=R(),{platform:a}=Ze(),{data:o}=i(Bn),s=u(y.dockIconPreference),l;e[0]===t?l=e[1]:(l=function(e){c(t,y.dockIconPreference,e)},e[0]=t,e[1]=l);let d=l;if(a!==`macOS`||w.ChatGPT!==`chatgpt`||T.Agent===`prod`)return null;let f=o?.dockIconPreviews;if(f==null)return null;return H(f,d)}";

const currentSearchSource = applyLinuxSettingsSearchVisibilityPatch([
  "function qn(e){let t=(0,Zn.c)(17),n=re(),r=Bn(e),{data:i}=_(e),a=i?.isSystemBackdropSupported!==!1,o=i?.platform===`darwin`,{data:s}=T(k,e.selectedHostId),c,l=c;if(a){let e;e=e=>e.sectionSlug===`appearance`&&!a?{...e,messages:e.messages.filter(Jn)}:e.sectionSlug===`agent`?{...e,terms:[]}:e,m=r.map(e)}else m=r;return m}",
  "function Jn(e){return!Qn.includes(e.id)}",
].join(""));

function captureWarns(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function withFeatureConfig(config, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify(config));
    return fn();
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("Dock icon descriptors remain disabled until the nested tweak is enabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig({ enabled: ["ui-tweaks"] }, () => {
    const dockDescriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot }).filter(
      (descriptor) => descriptor.id.includes(":appearance-dock-icon-"),
    );
    assert.equal(dockDescriptors.length, 3);
    assert.equal(dockDescriptors.every((descriptor) => descriptor.enabled({}) === false), true);
  });
  withFeatureConfig(
    {
      enabled: ["ui-tweaks"],
      settings: {
        "ui-tweaks": {
          tweaks: {
            appearance: {
              dockIcon: { enabled: true },
            },
          },
        },
      },
    },
    () => {
      const dockDescriptors = loadLinuxFeaturePatchDescriptors({ featuresRoot }).filter(
        (descriptor) => descriptor.id.includes(":appearance-dock-icon-"),
      );
      assert.equal(dockDescriptors.length, 3);
      assert.equal(dockDescriptors.every((descriptor) => descriptor.enabled({}) === true), true);
    },
  );
  assert.equal(dockIconEnabled({}), false);
});

test("ui-tweaks stages a Dock icon cleanup hook while the nested tweak is disabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig(dockIconFeatureConfig(false), () => {
    const plan = enabledLinuxFeatureInstallPlan({ featuresRoot });
    assert.deepEqual(
      plan.runtimeHooks.map((hook) => [
        hook.id,
        hook.key,
        path.relative(featuresRoot, hook.source),
        hook.target,
        hook.mode,
      ]),
      [[
        "ui-tweaks",
        "prelaunch",
        path.join("ui-tweaks", "sync-desktop-icon.sh"),
        ".codex-linux/prelaunch.d/ui-tweaks-dock-icon-cleanup.sh",
        0o755,
      ]],
    );

    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-hook-stage-"));
    try {
      stageEnabledLinuxFeatureInstall(appDir, { featuresRoot });
      const hook = path.join(
        appDir,
        ".codex-linux",
        "prelaunch.d",
        "ui-tweaks-dock-icon-cleanup.sh",
      );
      assert.equal(fs.readFileSync(hook, "utf8"), fs.readFileSync(path.join(__dirname, "sync-desktop-icon.sh"), "utf8"));
      assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("main patch enables official previews and synchronizes Linux window and tray icons", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  const secondPass = captureWarns(() => applyDockIconMainPatch(patched));

  assert.notEqual(patched, currentMainSource);
  assert.equal(secondPass.value, patched);
  assert.deepEqual(secondPass.warnings, []);
  assert.match(patched, /codexLinuxDockIconResourcePath/);
  assert.match(patched, /codexLinuxApplyDockIcon/);
  assert.match(patched, /process\.platform!==`darwin`&&process\.platform!==`linux`/);
  assert.match(
    patched,
    /l\.app\.isPackaged\|\|process\.platform===`linux`\?codexLinuxDockIconResourcePath/,
  );
  assert.match(patched, /if\(!l\.app\.isPackaged&&process\.platform!==`linux`\)return null/);
  assert.match(patched, /BrowserWindow\.getAllWindows\(\)/);
  assert.match(patched, /globalThis\.codexLinuxDockIconImage=s/);
  assert.match(patched, /codexLinuxTray!=null&&!codexLinuxTray\.isDestroyed\(\)&&codexLinuxTray\.setImage\(s\)/);
  assert.doesNotMatch(patched, /dae\(\)\?\.tray/);
  assert.match(patched, /sync-desktop-icon\.sh/);
  assert.match(patched, /crop\(\{x:34,y:34,width:956,height:956\}\)/);
  assert.match(patched, /crop\(\{x:13,y:23,width:998,height:998\}\)/);
  assert.match(patched, /require\(`node:child_process`\)\.spawn\(codexLinuxSyncScript,\[codexLinuxIconSelection\]/);
  assert.match(patched, /e\.stdin\.end\(s\.toPNG\(\)\)/);
  assert.match(patched, /codexLinuxDockIconImage\.isEmpty\(\)/);
  assert.match(
    patched,
    /codexLinuxRegisterTray\(new l\.Tray\(process\.platform===`linux`&&globalThis\.codexLinuxDockIconImage/,
  );
  assert.match(
    patched,
    /onWindowRegistered:e=>\{F\?\.registerWindow\(e\),C\?\.\(e\),process\.platform===`linux`&&setImmediate\(P\)\}/,
  );
  assert.ok(
    patched.indexOf("setImmediate(P)") > 0,
  );
});

test("main patch rejects drift at every current-DMG insertion point byte-identically", () => {
  const insertionPoints = [
    "if(process.platform!==`darwin`||t==null)return null",
    "function z_(e){if(e==null)return null",
    "E=e=>{if(!l.app.isPackaged)return null",
    "N=t=>{if(t===`app-default`",
    "P=()=>{if(!v)return",
    "if(v){P();let e=()=>",
    "onWindowRegistered:e=>{F?.registerWindow(e),C?.(e)}",
    "codexLinuxRegisterTray(new l.Tray(t.defaultIcon))",
  ];

  for (const insertionPoint of insertionPoints) {
    assert.equal(currentMainSource.includes(insertionPoint), true, insertionPoint);
    const splitAt = Math.floor(insertionPoint.length / 2);
    const drifted = currentMainSource.replace(
      insertionPoint,
      `${insertionPoint.slice(0, splitAt)}drift${insertionPoint.slice(splitAt)}`,
    );
    const { value, warnings } = captureWarns(() => applyDockIconMainPatch(drifted));

    assert.equal(value, drifted, insertionPoint);
    assert.equal(warnings.length, 1, insertionPoint);
    assert.match(warnings[0], /current Dock icon main-process contract/);
  }
});

test("main patch rejects mixed patched and clean contracts byte-identically", () => {
  const mixed = applyDockIconMainPatch(currentMainSource).replace(
    "P=()=>{if(!v&&process.platform!==`linux`)return",
    "P=()=>{if(!v)return",
  );
  const { value, warnings } = captureWarns(() => applyDockIconMainPatch(mixed));

  assert.equal(value, mixed);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Dock icon main-process contract/);
});

test("settings patch exposes the native row on Linux", () => {
  const patched = applyDockIconSettingsPatch(currentSettingsSource);
  const secondPass = captureWarns(() => applyDockIconSettingsPatch(patched));

  assert.match(patched, /a!==`macOS`&&a!==`linux`/);
  assert.equal(secondPass.value, patched);
  assert.deepEqual(secondPass.warnings, []);
});

test("settings drift remains byte-identical", () => {
  const drifted = currentSettingsSource.replace("T.Agent===`prod`", "T.Agent!==`prod`");
  const { value, warnings } = captureWarns(() => applyDockIconSettingsPatch(drifted));

  assert.equal(value, drifted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Dock icon settings contract/);
});

test("search patch restores Dock icon results after the Linux core patch", () => {
  const patched = applyDockIconSearchPatch(currentSearchSource);
  const secondPass = captureWarns(() => applyDockIconSearchPatch(patched));

  assert.match(patched, /codexLinuxDarwinOnlySettingsSearchMessageIds=new Set\(\[\]\)/);
  assert.equal(secondPass.value, patched);
  assert.deepEqual(secondPass.warnings, []);
});

test("search drift remains byte-identical", () => {
  const drifted = currentSearchSource.replace(
    "settings.general.appearance.dockIcon.row.description",
    "settings.general.appearance.dockIcon.row.subtitle",
  );
  const { value, warnings } = captureWarns(() => applyDockIconSearchPatch(drifted));

  assert.equal(value, drifted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Dock icon settings search contract/);
});

test("descriptor targets the current General settings asset", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const settingsPath = path.join(assetsDir, "general-settings-BWZCvLqI.js");
    const searchPath = path.join(assetsDir, "settings-page-CpgnnFjp.js");
    fs.writeFileSync(settingsPath, currentSettingsSource);
    fs.writeFileSync(searchPath, currentSearchSource);

    const settingsResult = patchAssetFiles(
      tempDir,
      descriptors[1].pattern,
      descriptors[1].apply,
      "missing",
    );
    assert.deepEqual(settingsResult, { matched: 1, changed: 1 });
    const searchResult = patchAssetFiles(
      tempDir,
      descriptors[2].pattern,
      descriptors[2].apply,
      "missing",
    );
    assert.deepEqual(searchResult, { matched: 1, changed: 1 });
    assert.equal(descriptors[1].pattern.test("general-settings-BWZCvLqI.js"), true);
    assert.equal(descriptors[1].pattern.test("general-settings-CsA3Lt9Z.js"), false);
    assert.equal(descriptors[1].pattern.test("general-settings-stale.js"), false);
    assert.equal(descriptors[2].pattern.test("settings-page-CpgnnFjp.js"), true);
    assert.equal(descriptors[2].pattern.test("settings-page-BOdFN1v1.js"), false);
    assert.equal(descriptors[2].pattern.test("settings-page-stale.js"), false);
    assert.equal(descriptors[1].pattern.test("general-settings-DMO9G9gL.js"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function dockIconFeatureConfig(enabled) {
  const config = { enabled: ["ui-tweaks"] };
  if (enabled != null) {
    config.settings = {
      "ui-tweaks": {
        tweaks: {
          appearance: {
            dockIcon: { enabled },
          },
        },
      },
    };
  }
  return config;
}

function createDockIconHookFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-stage-"));
  const upstreamResources = path.join(tempDir, "ChatGPT.app", "Contents", "Resources");
  const installDir = path.join(tempDir, "install");
  const configPath = path.join(tempDir, "features.json");
  const iconNames = [
    "icon-chatgpt.png",
    "icon-codex-dark-color.png",
    "icon-codex-light.png",
  ];
  fs.mkdirSync(upstreamResources, { recursive: true });
  for (const name of iconNames) {
    fs.writeFileSync(path.join(upstreamResources, name), name);
  }
  return {
    configPath,
    env: {
      ...process.env,
      CODEX_LINUX_FEATURES_CONFIG: configPath,
      CODEX_UPSTREAM_APP_DIR: path.join(tempDir, "ChatGPT.app"),
      INSTALL_DIR: installDir,
      SCRIPT_DIR: path.resolve(__dirname, "..", ".."),
    },
    iconNames,
    installDir,
    targetDir: path.join(installDir, "resources", "dock-icon"),
    tempDir,
    upstreamResources,
  };
}

function runDockIconHook(name, env) {
  return childProcess.spawnSync("bash", [path.join(__dirname, name)], {
    encoding: "utf8",
    env,
  });
}

test("Dock icon staging is disabled by default and removes stale resources", () => {
  const fixture = createDockIconHookFixture();
  try {
    fs.mkdirSync(fixture.targetDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.targetDir, "stale.png"), "stale");
    fs.writeFileSync(fixture.configPath, JSON.stringify(dockIconFeatureConfig()));

    const result = runDockIconHook("stage.sh", fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fixture.targetDir), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("Dock icon staging copies only the official resources when enabled", () => {
  const fixture = createDockIconHookFixture();
  try {
    fs.writeFileSync(fixture.configPath, JSON.stringify(dockIconFeatureConfig(true)));

    const staged = runDockIconHook("stage.sh", fixture.env);

    assert.equal(staged.status, 0, staged.stderr);
    for (const name of fixture.iconNames) {
      assert.equal(
        fs.readFileSync(path.join(fixture.targetDir, name), "utf8"),
        name,
      );
    }
    assert.deepEqual(
      fs.readdirSync(fixture.targetDir).sort(),
      [...fixture.iconNames, "sync-desktop-icon.sh"].sort(),
    );
    assert.equal(
      fs.statSync(path.join(fixture.targetDir, "sync-desktop-icon.sh")).mode & 0o777,
      0o755,
    );

    const repeated = runDockIconHook("stage.sh", fixture.env);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(
      fs.readdirSync(fixture.targetDir).sort(),
      [...fixture.iconNames, "sync-desktop-icon.sh"].sort(),
    );
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("missing upstream Dock icon resources warn and do not fail the build", () => {
  const fixture = createDockIconHookFixture();
  try {
    fs.writeFileSync(fixture.configPath, JSON.stringify(dockIconFeatureConfig(true)));
    fs.rmSync(path.join(fixture.upstreamResources, fixture.iconNames[0]));
    fs.mkdirSync(fixture.targetDir, { recursive: true });
    fs.writeFileSync(path.join(fixture.targetDir, "stale.png"), "stale");

    const result = runDockIconHook("stage.sh", fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /WARN: Upstream Dock icon resource is unavailable/);
    assert.equal(fs.existsSync(fixture.targetDir), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("symbolic-link Dock icon resources warn and leave their targets untouched", () => {
  const fixture = createDockIconHookFixture();
  try {
    fs.writeFileSync(fixture.configPath, JSON.stringify(dockIconFeatureConfig(true)));
    const linkedIcon = path.join(fixture.upstreamResources, fixture.iconNames[0]);
    const linkTarget = path.join(fixture.tempDir, "outside.png");
    fs.rmSync(linkedIcon);
    fs.writeFileSync(linkTarget, "outside");
    fs.symlinkSync(linkTarget, linkedIcon);

    const result = runDockIconHook("stage.sh", fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /WARN: Upstream Dock icon resource is unavailable/);
    assert.equal(fs.existsSync(fixture.targetDir), false);
    assert.equal(fs.readFileSync(linkTarget, "utf8"), "outside");
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("disabling the Dock icon tweak removes its payload while ui-tweaks stays enabled", () => {
  const fixture = createDockIconHookFixture();
  try {
    fs.writeFileSync(fixture.configPath, JSON.stringify(dockIconFeatureConfig(true)));
    const staged = runDockIconHook("stage.sh", fixture.env);
    assert.equal(staged.status, 0, staged.stderr);
    assert.equal(fs.existsSync(fixture.targetDir), true);

    fs.writeFileSync(fixture.configPath, JSON.stringify(dockIconFeatureConfig(false)));
    const disabled = runDockIconHook("stage.sh", fixture.env);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(fs.existsSync(fixture.targetDir), false);

    const cleaned = runDockIconHook("cleanup.sh", fixture.env);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(fixture.targetDir), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

function createDesktopSyncFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-desktop-"));
  const dataHome = path.join(tempDir, "data");
  const sourceDesktop = path.join(tempDir, "codex-desktop.desktop");
  const firstIcon = path.join(tempDir, "first.png");
  const secondIcon = path.join(tempDir, "second.png");
  const binDir = path.join(tempDir, "bin");
  const callsPath = path.join(tempDir, "calls.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    sourceDesktop,
    "[Desktop Entry]\nName=ChatGPT\nExec=/usr/bin/codex-desktop\nIcon=codex-desktop\nType=Application\n",
  );
  fs.writeFileSync(firstIcon, "first-icon");
  fs.writeFileSync(secondIcon, "second-icon");
  for (const command of ["kbuildsycoca6", "qdbus6"]) {
    const commandPath = path.join(binDir, command);
    fs.writeFileSync(commandPath, `#!/usr/bin/env bash\nprintf '%s\\n' '${command}' >> "$CODEX_TEST_CALLS"\n`);
    fs.chmodSync(commandPath, 0o755);
  }
  return {
    callsPath,
    dataHome,
    env: {
      ...process.env,
      CODEX_LINUX_APP_ID: "codex-desktop",
      CODEX_LINUX_DESKTOP_FILE_SOURCE: sourceDesktop,
      CODEX_TEST_CALLS: callsPath,
      HOME: tempDir,
      PATH: `${binDir}:${process.env.PATH}`,
      XDG_CURRENT_DESKTOP: "KDE",
      XDG_DATA_HOME: dataHome,
    },
    firstIcon,
    managedDesktop: path.join(dataHome, "applications", "codex-desktop.desktop"),
    managedIcon: (selection) => path.join(
      dataHome,
      "icons",
      "hicolor",
      "256x256",
      "apps",
      `codex-desktop-dock-${selection}.png`,
    ),
    secondIcon,
    tempDir,
  };
}

function runDesktopSync(selection, iconPath, env) {
  return childProcess.spawnSync(
    "bash",
    [path.join(__dirname, "sync-desktop-icon.sh"), selection],
    { encoding: "utf8", env, input: fs.readFileSync(iconPath) },
  );
}

function runDesktopCleanup(appDir, env) {
  return childProcess.spawnSync(
    "bash",
    [path.join(__dirname, "sync-desktop-icon.sh"), appDir, "state", "log"],
    {
      encoding: "utf8",
      env: {
        ...env,
        CODEX_LINUX_APP_DIR: appDir,
        CODEX_LINUX_FEATURE_HOOK_PHASE: "prelaunch",
      },
    },
  );
}

test("desktop synchronization updates a managed KDE launcher atomically", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const first = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), "first-icon");
    assert.match(
      fs.readFileSync(fixture.managedDesktop, "utf8"),
      new RegExp(`^Icon=${fixture.managedIcon("chatgpt").replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}$`, "m"),
    );
    assert.match(fs.readFileSync(fixture.managedDesktop, "utf8"), /^X-Codex-Linux-Dock-Icon=1$/m);
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), ["kbuildsycoca6"]);

    const repeated = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), ["kbuildsycoca6"]);

    const second = runDesktopSync("codex-dark", fixture.secondIcon, fixture.env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(fixture.managedIcon("codex-dark"), "utf8"), "second-icon");
    assert.match(
      fs.readFileSync(fixture.managedDesktop, "utf8"),
      new RegExp(`^Icon=${fixture.managedIcon("codex-dark").replace(/[.*+?^\${}()|[\]\\]/g, "\\$&")}$`, "m"),
    );
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), [
      "kbuildsycoca6",
      "kbuildsycoca6",
    ]);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization leaves an unmanaged user launcher untouched", () => {
  const fixture = createDesktopSyncFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.managedDesktop), { recursive: true });
    fs.writeFileSync(fixture.managedDesktop, "[Desktop Entry]\nName=Custom\nIcon=custom\n");

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(fixture.managedDesktop, "utf8"),
      "[Desktop Entry]\nName=Custom\nIcon=custom\n",
    );
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), false);
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup removes only marker-owned Dock launcher artifacts after nested disable", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  try {
    fs.mkdirSync(appDir, { recursive: true });
    assert.equal(runDesktopSync("chatgpt", fixture.firstIcon, fixture.env).status, 0);
    assert.equal(runDesktopSync("codex-dark", fixture.secondIcon, fixture.env).status, 0);
    assert.equal(fs.existsSync(fixture.managedDesktop), true);
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), true);
    assert.equal(fs.existsSync(fixture.managedIcon("codex-dark")), true);

    const cleaned = runDesktopCleanup(appDir, fixture.env);

    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), false);
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), false);
    assert.equal(fs.existsSync(fixture.managedIcon("codex-dark")), false);
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), [
      "kbuildsycoca6",
      "kbuildsycoca6",
      "kbuildsycoca6",
    ]);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup preserves unmanaged and symlinked desktop artifacts", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  try {
    fs.mkdirSync(path.dirname(fixture.managedDesktop), { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    const outside = path.join(fixture.tempDir, "outside.desktop");
    fs.writeFileSync(outside, "[Desktop Entry]\nIcon=outside\nX-Codex-Linux-Dock-Icon=1\n");
    fs.symlinkSync(outside, fixture.managedDesktop);
    fs.mkdirSync(path.dirname(fixture.managedIcon("chatgpt")), { recursive: true });
    fs.writeFileSync(fixture.managedIcon("chatgpt"), "unproven-icon");

    const cleaned = runDesktopCleanup(appDir, fixture.env);

    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.lstatSync(fixture.managedDesktop).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outside, "utf8"), "[Desktop Entry]\nIcon=outside\nX-Codex-Linux-Dock-Icon=1\n");
    assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), "unproven-icon");
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup preserves a marker-owned launcher changed to an unmanaged icon", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  try {
    fs.mkdirSync(path.dirname(fixture.managedDesktop), { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      fixture.managedDesktop,
      "[Desktop Entry]\nName=Customized\nIcon=/tmp/custom.png\nX-Codex-Linux-Dock-Icon=1\n",
    );
    fs.mkdirSync(path.dirname(fixture.managedIcon("chatgpt")), { recursive: true });
    fs.writeFileSync(fixture.managedIcon("chatgpt"), "previous-managed-icon");

    const cleaned = runDesktopCleanup(appDir, fixture.env);

    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(
      fs.readFileSync(fixture.managedDesktop, "utf8"),
      "[Desktop Entry]\nName=Customized\nIcon=/tmp/custom.png\nX-Codex-Linux-Dock-Icon=1\n",
    );
    assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), "previous-managed-icon");
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup keeps managed artifacts while the Dock payload is enabled", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  try {
    assert.equal(runDesktopSync("chatgpt", fixture.firstIcon, fixture.env).status, 0);
    const payloadHelper = path.join(appDir, "resources", "dock-icon", "sync-desktop-icon.sh");
    fs.mkdirSync(path.dirname(payloadHelper), { recursive: true });
    fs.writeFileSync(payloadHelper, "enabled");

    const cleaned = runDesktopCleanup(appDir, fixture.env);

    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), true);
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), true);
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), ["kbuildsycoca6"]);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization discovers packaged launchers through XDG_DATA_DIRS", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const appId = "codex-dock-xdg";
    const dataDir = path.join(fixture.tempDir, "profile", "share");
    const sourceDir = path.join(dataDir, "applications");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, `${appId}.desktop`),
      [
        "[Desktop Entry]",
        "Name=Side by side",
        `Exec=env BAMF_DESKTOP_FILE_HINT=${sourceDir}/${appId}.desktop CHROME_DESKTOP=${appId}.desktop /opt/${appId}/start.sh %u`,
        `Icon=${appId}`,
        `StartupWMClass=${appId}`,
        `X-GNOME-WMClass=${appId}`,
        "Type=Application",
        "Actions=new-window;",
        "",
        "[Desktop Action new-window]",
        "Name=New Window",
        `Exec=env BAMF_DESKTOP_FILE_HINT=${sourceDir}/${appId}.desktop CHROME_DESKTOP=${appId}.desktop /opt/${appId}/start.sh --new-instance`,
        "",
      ].join("\n"),
    );
    delete fixture.env.CODEX_LINUX_DESKTOP_FILE_SOURCE;
    fixture.env.BAMF_DESKTOP_FILE_HINT = path.join(fixture.tempDir, "codex-desktop.desktop");
    fixture.env.CODEX_LINUX_APP_ID = appId;
    fixture.env.XDG_DATA_DIRS = dataDir;

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    const managedIcon = path.join(
      fixture.dataHome,
      "icons",
      "hicolor",
      "256x256",
      "apps",
      `${appId}-dock-chatgpt.png`,
    );
    const managedDesktop = path.join(fixture.dataHome, "applications", `${appId}.desktop`);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(managedIcon, "utf8"), "first-icon");
    assert.match(fs.readFileSync(managedDesktop, "utf8"), /^X-Codex-Linux-Dock-Icon=1$/m);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization rejects a default launcher copied to a side-by-side app id", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const appId = "chatgpt-dock-side";
    const mismatchedSource = path.join(fixture.tempDir, `${appId}.desktop`);
    fs.writeFileSync(
      mismatchedSource,
      [
        "[Desktop Entry]",
        "Name=ChatGPT",
        "Exec=env BAMF_DESKTOP_FILE_HINT=/usr/share/applications/codex-desktop.desktop CHROME_DESKTOP=codex-desktop.desktop /usr/bin/codex-desktop %u",
        "Icon=codex-desktop",
        "StartupWMClass=codex-desktop",
        "X-GNOME-WMClass=codex-desktop",
        "Type=Application",
        "Actions=new-window;",
        "",
        "[Desktop Action new-window]",
        "Name=New Window",
        "Exec=env BAMF_DESKTOP_FILE_HINT=/usr/share/applications/codex-desktop.desktop CHROME_DESKTOP=codex-desktop.desktop CODEX_MULTI_LAUNCH=1 /usr/bin/codex-desktop --new-instance",
        "",
      ].join("\n"),
    );
    fixture.env.CODEX_LINUX_APP_ID = appId;
    fixture.env.CODEX_LINUX_DESKTOP_FILE_SOURCE = mismatchedSource;

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    const sideDesktop = path.join(fixture.dataHome, "applications", `${appId}.desktop`);
    const sideIcon = path.join(
      fixture.dataHome,
      "icons",
      "hicolor",
      "256x256",
      "apps",
      `${appId}-dock-chatgpt.png`,
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(sideDesktop), false);
    assert.equal(fs.existsSync(sideIcon), false);
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization rejects invalid selections without touching Plasma", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const result = runDesktopSync("../../invalid", fixture.firstIcon, fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), false);
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});
