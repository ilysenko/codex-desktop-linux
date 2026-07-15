#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { patchAssetFiles } = require("../../scripts/patches/lib/assets.js");
const {
  applyDockIconMainPatch,
  applyDockIconSearchPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconEnabled,
} = require("./patches/dock-icon.js");

const currentAppInfoSource = [
  "function S_(e,t,r){return`icon-chatgpt`}",
  "function C_(e){return{dark:`icon-codex-dark-color.png`,light:`icon-codex-light.png`}}",
  "function T_(e,t){if(process.platform!==`darwin`||t==null)return null;let n=C_(e),r=E_(`${S_(e,`darwin`,t)}.png`),i=E_(n.dark),a=E_(n.light);return r==null||i==null||a==null?null:{appDefault:r,codexDark:i,codexLight:a}}",
  "function E_(e){if(e==null)return null;let t=c.app.isPackaged?(0,u.join)(process.resourcesPath,e):null,n=t!=null&&(0,p.existsSync)(t)?t:(0,u.join)(c.app.getAppPath(),`src`,`icons`,e),r=c.nativeImage.createFromPath(n);return r.isEmpty()?null:r.resize({width:128,height:128,quality:`best`}).toDataURL()}",
].join("");

const currentRuntimeSource = [
  "function Gne({appBrand:e,buildFlavor:t,settingsStore:d,repoRoot:h,isMacOS:g,onWindowRegistered:x,disposables:S}){",
  "let C=(0,u.join)(h,`electron`,`src`,`icons`),w=e=>{if(!c.app.isPackaged)return null;let t=(0,u.join)(process.resourcesPath,e);return(0,p.existsSync)(t)?t:null},",
  "T=e=>null,E=e=>w(e)??T(e),D=()=>d.get(n.Gs.DOCK_ICON_PREFERENCE)??`app-default`,",
  "O=()=>E(`${S_(t,`darwin`,e)}.png`),k=C_(t),A=()=>c.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?k.dark:k.light,",
  "j=r=>{if(r===`app-default`&&t!==i.a.Dev&&(c.app.isPackaged||e===n.Vc.ChatGPT)){let e=c.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let a=r===`codex-system`?A():null,o=(a==null?null:E(a))??O(),s=o==null?c.nativeImage.createEmpty():c.nativeImage.createFromPath(o);s.isEmpty()||c.app.dock?.setIcon(s)},",
  "M=()=>{if(!g)return;let e=D();j(e),AA({preference:e,resourceName:e===`codex-system`?k.light:null}).then(e=>{e&&j(D())})};",
  "if(g){M();let e=()=>{let e=D();e===`codex-system`&&j(e)};c.nativeTheme.on(`updated`,e),S.add(()=>{c.nativeTheme.off(`updated`,e)})}",
  "let N=null,P=new Nne({onWindowRegistered:e=>{N?.registerWindow(e),x?.(e)}});",
  "w&&process.platform===`linux`&&M.setIcon(process.resourcesPath+`/../content/webview/assets/app-current.png`);",
  "return{updateDockIcon:M,windowManager:P}}",
].join("");

const currentTraySource =
  "async function ore(e){let t=await sre(e.buildFlavor,e.appBrand,e.repoRoot),n=typeof codexLinuxRegisterTray===`function`?codexLinuxRegisterTray(new c.Tray(t.defaultIcon)):new c.Tray(t.defaultIcon);if(!W9)return n.destroy(),null;return n}";

const currentMainSource = currentAppInfoSource + currentRuntimeSource + currentTraySource;

const currentSettingsSource =
  "function na(){let e=(0,Q.c)(27),t=z(R),n=L(),{platform:r}=Bt(),{data:i}=s(Kn),a=I(P.dockIconPreference),o;e[0]===t?o=e[1]:(o=function(e){x(t,P.dockIconPreference,e)},e[0]=t,e[1]=o);let c=o;if(r!==`macOS`||Fe.ChatGPT!==`chatgpt`||st.Agent===`prod`)return null;let l=i?.dockIconPreviews;if(l==null)return null;return H(l,c)}";

const currentSearchSource =
  "var codexLinuxDarwinOnlySettingsSearchMessageIds=new Set([`settings.general.appearance.dockIcon.chatGPT.ariaLabel`,`settings.general.appearance.dockIcon.codex.ariaLabel`,`settings.general.appearance.dockIcon.label`,`settings.general.appearance.dockIcon.row.description`]);function codexLinuxFilterSettingsSearchSection(e,t){if(e.sectionSlug!==`appearance`||t)return e;let n=e.messages.filter(e=>!codexLinuxDarwinOnlySettingsSearchMessageIds.has(e.id));return n.length===e.messages.length?e:{...e,messages:n}}";

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
    /c\.app\.isPackaged\|\|process\.platform===`linux`\?codexLinuxDockIconResourcePath/,
  );
  assert.match(patched, /if\(!c\.app\.isPackaged&&process\.platform!==`linux`\)return null/);
  assert.match(patched, /BrowserWindow\.getAllWindows\(\)/);
  assert.match(patched, /globalThis\.codexLinuxDockIconImage=s/);
  assert.match(patched, /are\(\)\?\.tray/);
  assert.match(patched, /codexLinuxDockIconImage\.isEmpty\(\)/);
  assert.match(patched, /n\.setImage\(globalThis\.codexLinuxDockIconImage\)/);
  assert.match(
    patched,
    /onWindowRegistered:e=>\{N\?\.registerWindow\(e\),x\?\.\(e\),process\.platform===`linux`&&setImmediate\(M\)\}/,
  );
  assert.ok(
    patched.indexOf("setImmediate(M)") <
      patched.indexOf("M.setIcon(process.resourcesPath+`/../content/webview/assets/app-current.png`)"),
  );
});

test("main patch rejects partial current-DMG drift byte-identically", () => {
  const drifted = currentMainSource.replace("if(!g)return", "if(!g||disabled)return");
  const { value, warnings } = captureWarns(() => applyDockIconMainPatch(drifted));

  assert.equal(value, drifted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Dock icon main-process contract/);
});

test("main patch rejects mixed patched and clean contracts byte-identically", () => {
  const mixed = `${applyDockIconMainPatch(currentMainSource)}${currentMainSource}`;
  const { value, warnings } = captureWarns(() => applyDockIconMainPatch(mixed));

  assert.equal(value, mixed);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Dock icon main-process contract/);
});

test("settings patch exposes the native row on Linux", () => {
  const patched = applyDockIconSettingsPatch(currentSettingsSource);
  const secondPass = captureWarns(() => applyDockIconSettingsPatch(patched));

  assert.match(patched, /r!==`macOS`&&r!==`linux`/);
  assert.equal(secondPass.value, patched);
  assert.deepEqual(secondPass.warnings, []);
});

test("settings drift remains byte-identical", () => {
  const drifted = currentSettingsSource.replace("st.Agent===`prod`", "st.Agent!==`prod`");
  const { value, warnings } = captureWarns(() => applyDockIconSettingsPatch(drifted));

  assert.equal(value, drifted);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current Dock icon settings contract/);
});

test("search patch restores Dock icon results hidden by the Linux core patch", () => {
  const patched = applyDockIconSearchPatch(currentSearchSource);
  const secondPass = captureWarns(() => applyDockIconSearchPatch(patched));

  assert.match(patched, /codexLinuxDarwinOnlySettingsSearchMessageIds=new Set\(\[\]\)/);
  assert.equal(secondPass.value, patched);
  assert.deepEqual(secondPass.warnings, []);
});

test("descriptor targets current main, settings, and search assets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-assets-"));
  try {
    const assetsDir = path.join(tempDir, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const settingsPath = path.join(assetsDir, "general-settings-C0l3c9YI.js");
    const searchPath = path.join(assetsDir, "settings-page-BJ-Kp3Yv.js");
    fs.writeFileSync(settingsPath, currentSettingsSource);
    fs.writeFileSync(searchPath, currentSearchSource);

    const settingsResult = patchAssetFiles(
      tempDir,
      descriptors[1].pattern,
      descriptors[1].apply,
      "missing",
    );
    const searchResult = patchAssetFiles(
      tempDir,
      descriptors[2].pattern,
      descriptors[2].apply,
      "missing",
    );

    assert.deepEqual(settingsResult, { matched: 1, changed: 1 });
    assert.deepEqual(searchResult, { matched: 1, changed: 1 });
    assert.equal(descriptors[1].pattern.test("general-settings-C0l3c9YI.js"), true);
    assert.equal(descriptors[1].pattern.test("general-settings-DwhDXYGj.js"), false);
    assert.equal(descriptors[2].pattern.test("settings-page-BJ-Kp3Yv.js"), true);
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
    assert.deepEqual(fs.readdirSync(fixture.targetDir).sort(), fixture.iconNames.slice().sort());
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
