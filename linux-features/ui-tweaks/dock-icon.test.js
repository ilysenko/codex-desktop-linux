#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const { patchUniqueAssetFile } = require("../../scripts/patches/lib/assets.js");
const {
  applyDockIconMainPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconEnabled,
} = require("./patches/dock-icon.js");

const currentAppInfoSource = [
  "function wS(e){return`icon-chatgpt`}",
  "function TS(e){return{dark:`icon-codex-dark-color.png`,light:`icon-codex-light.png`}}",
  "function wse(e){if(process.platform!==`darwin`)return null;let t=TS(e),n=DS(`${wS(e)}.png`),r=DS(t.dark),i=DS(t.light);return n==null||r==null||i==null?null:{appDefault:n,codexDark:r,codexLight:i}}",
  "function DS(e){if(e==null)return null;let t=l.app.isPackaged?(0,p.join)(process.resourcesPath,e):null,n=t!=null&&(0,_.existsSync)(t)?t:(0,p.join)(l.app.getAppPath(),`src`,`icons`,e),r=l.nativeImage.createFromPath(n);return r.isEmpty()?null:r.resize({width:128,height:128,quality:`best`}).toDataURL()}",
].join("");

const currentRuntimeSource = [
  "function TNe({buildFlavor:t,settingsStore:d,repoRoot:h,isMacOS:g,isWindows:v,onWindowRegistered:C,disposables:w}){",
  "let T=(0,p.join)(h,`electron`,`src`,`icons`),E=e=>{if(!l.app.isPackaged)return null;let t=(0,p.join)(process.resourcesPath,e);return(0,_.existsSync)(t)?t:null},",
  "D=e=>null,O=e=>E(e)??D(e),k=()=>{switch(t){case a.a.Dev:case a.a.Nightly:case a.a.InternalAlpha:case a.a.PublicBeta:case a.a.Prod:return d.get(n.lc.DOCK_ICON_PREFERENCE)??`app-default`;case a.a.Agent:return`app-default`}},A=()=>{switch(t){case a.a.Dev:return D(`icon-dev-outline.png`);case a.a.Agent:return O(`icon-agent.png`);case a.a.Nightly:case a.a.InternalAlpha:case a.a.PublicBeta:case a.a.Prod:return O(`${wS(t)}.png`)}},j=()=>null,M=process.platform===`linux`?G5(t,T):j(),N=TS(t),P=()=>l.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI?N.dark:N.light,",
  "F=e=>{if(e===`app-default`&&t!==a.a.Dev){let e=l.app.dock;e!=null&&Reflect.apply(e.setIcon.bind(e),e,[null]);return}let n=e===`codex-system`?P():null,r=(n==null?null:O(n))??A(),i=r==null?l.nativeImage.createEmpty():l.nativeImage.createFromPath(r);if(!i.isEmpty()){if(e===`codex-system`){let{width:e,height:t}=i.getSize(),n=Math.round(e/128);i=i.crop({x:n,y:n,width:e-n*2,height:t-n*2})}l.app.dock?.setIcon(i)}},",
  "I=()=>{if(!g)return;let e=k();F(e),Vde({preference:e,resourceName:e===`codex-system`?N.light:null}).then(e=>{e&&F(k())})};",
  "if(g){I();let e=()=>{let e=k();e===`codex-system`&&F(e)};l.nativeTheme.on(`updated`,e),w.add(()=>{l.nativeTheme.off(`updated`,e)})}",
  "let ee=null,L=new pNe({onWindowRegistered:e=>{ee?.registerWindow(e),C?.(e)}});return{updateDockIcon:I,windowManager:L}}",
].join("");

const currentTraySource =
  "let H9=null,G9=!1;async function ePe(e){let t=e.buildFlavor,n=await tPe(t,e.repoRoot),i=new l.Tray(n.defaultIcon,process.platform===`win32`&&l.app.isPackaged?qNe(t):void 0);if(!G9)return i.destroy(),null;return H9=new Mke(i)}";

const currentMainSource = currentAppInfoSource + currentRuntimeSource + currentTraySource;
const currentSettingsSource =
  "import{n as e}from\"./rolldown-runtime-DAXXjFlN.js\";import{$Jt as t,VWt as n}from\"./app-initial-F3TGi7uJ.js\";function r({platform:e,dockIconPreviews:n,buildFlavor:r=`prod`}){return e!==`macOS`||r===t.Agent?null:n}var i=e((()=>{n()}));export{i as n,r as t};";

function withFeatureConfig(config, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-config-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify(config));
    return fn();
  } finally {
    if (originalConfig == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    else process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function captureWarns(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(String(message));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function dockConfig(enabled) {
  return {
    enabled: ["ui-tweaks"],
    settings: {
      "ui-tweaks": { tweaks: { appearance: { dockIcon: { enabled } } } },
    },
  };
}

function runStage({
  enabled = true,
  officialIcon = "official-icon",
  desktopMetadata = true,
  stalePayload = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-stage-"));
  const upstream = path.join(root, "upstream");
  const install = path.join(root, "install");
  const config = path.join(root, "features.json");
  fs.mkdirSync(path.join(upstream, "resources"), { recursive: true });
  fs.mkdirSync(path.join(install, ".codex-linux", "upstream-package"), { recursive: true });
  if (stalePayload) {
    fs.mkdirSync(path.join(install, "resources", "dock-icon"), { recursive: true });
    fs.writeFileSync(path.join(install, "resources", "dock-icon", "stale"), "stale");
  }
  if (officialIcon != null) {
    fs.writeFileSync(path.join(upstream, "resources", "icon-chatgpt.png"), officialIcon);
  }
  if (desktopMetadata) {
    fs.writeFileSync(
      path.join(install, ".codex-linux", "upstream-package", "chatgpt.desktop"),
      "[Desktop Entry]\nName=ChatGPT\nExec=chatgpt %U\nIcon=chatgpt\n",
    );
  }
  fs.writeFileSync(config, JSON.stringify(dockConfig(enabled)));
  const result = childProcess.spawnSync("bash", [path.join(__dirname, "stage.sh")], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_LINUX_FEATURES_CONFIG: config,
      CODEX_UPSTREAM_APP_DIR: upstream,
      INSTALL_DIR: install,
      SCRIPT_DIR: path.resolve(__dirname, "../.."),
    },
  });
  return { root, upstream, install, result };
}

test("Dock icon descriptors remain disabled until the nested tweak is enabled", () => {
  withFeatureConfig({ enabled: ["ui-tweaks"] }, () => {
    const dockDescriptors = loadLinuxFeaturePatchDescriptors().filter((descriptor) =>
      descriptor.id.includes(":appearance-dock-icon-"),
    );
    assert.equal(dockDescriptors.length, 2);
    assert.equal(dockDescriptors.every((descriptor) => descriptor.enabled({}) === false), true);
  });
  withFeatureConfig(dockConfig(true), () => {
    const dockDescriptors = loadLinuxFeaturePatchDescriptors().filter((descriptor) =>
      descriptor.id.includes(":appearance-dock-icon-"),
    );
    assert.equal(dockDescriptors.length, 2);
    assert.equal(dockDescriptors.every((descriptor) => descriptor.enabled({}) === true), true);
  });
  assert.equal(dockIconEnabled({}), false);
});

test("ui-tweaks keeps the Dock cleanup hook staged while the nested tweak is disabled", () => {
  const featuresRoot = path.resolve(__dirname, "..");
  withFeatureConfig(dockConfig(false), () => {
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
      assert.equal(
        fs.readFileSync(hook, "utf8"),
        fs.readFileSync(path.join(__dirname, "sync-desktop-icon.sh"), "utf8"),
      );
      assert.equal(fs.statSync(hook).mode & 0o777, 0o755);
    } finally {
      fs.rmSync(appDir, { recursive: true, force: true });
    }
  });
});

test("main patch restores official previews and synchronizes Linux windows and tray", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  assert.notEqual(patched, currentMainSource);
  assert.match(patched, /function codexLinuxDockIconResourcePath/);
  assert.match(patched, /function codexLinuxApplyDockIcon/);
  assert.match(patched, /BrowserWindow\.getAllWindows\(\)/);
  assert.match(patched, /H9\.tray\.setImage\(i\)/);
  assert.match(patched, /globalThis\.codexLinuxDockIconImage/);
  assert.match(patched, /spawn\(codexLinuxSyncScript/);
  assert.equal(applyDockIconMainPatch(patched), patched);
});

test("main patch matches the current tray contract semantically across minified aliases", () => {
  const aliased = currentMainSource.replace("qNe(t)", "windowsIconHelper(t)");
  const patched = applyDockIconMainPatch(aliased);
  assert.notEqual(patched, aliased);
  assert.match(patched, /windowsIconHelper\(t\)/);
  assert.match(patched, /globalThis\.codexLinuxDockIconImage:n\.defaultIcon/);
  assert.equal(applyDockIconMainPatch(patched), patched);
});

test("main patch rejects drift at every official-package insertion point byte-identically", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  const currentPoints = [
    "function wse(e){if(process.platform!==`darwin`)return null",
    "function DS(e){if(e==null)return null;let t=l.app.isPackaged?(0,p.join)(process.resourcesPath,e):null",
    "E=e=>{if(!l.app.isPackaged)return null;let t=(0,p.join)(process.resourcesPath,e);return(0,_.existsSync)(t)?t:null}",
    "F=e=>{if(e===`app-default`",
    "I=()=>{if(!g)return;",
    "if(g){I();let e=()=>",
    "onWindowRegistered:e=>{ee?.registerWindow(e),C?.(e)}",
    "i=new l.Tray(n.defaultIcon",
  ];
  const patchedPoints = [
    "function wse(e){if(process.platform!==`darwin`&&process.platform!==`linux`)return null",
    "function codexLinuxDockIconResourcePath",
    "E=e=>{if(!l.app.isPackaged&&process.platform!==`linux`)return null",
    "F=function codexLinuxApplyDockIcon",
    "I=()=>{if(!g&&process.platform!==`linux`)return;",
    "if(g||process.platform===`linux`){I();let e=()=>",
    "onWindowRegistered:e=>{ee?.registerWindow(e),C?.(e),process.platform===`linux`&&setImmediate(I)}",
    "i=new l.Tray(process.platform===`linux`&&globalThis.codexLinuxDockIconImage",
  ];

  for (const point of currentPoints) {
    const driftedPoint = `${point.slice(0, -1)}DRIFT${point.slice(-1)}`;
    const drifted = currentMainSource.replace(point, driftedPoint);
    const result = captureWarns(() => applyDockIconMainPatch(drifted));
    assert.equal(result.value, drifted, point);
    assert.match(result.warnings.join("\n"), /complete current Dock icon main-process contract/);
  }
  for (const point of patchedPoints) {
    const driftedPoint = `${point.slice(0, -1)}DRIFT${point.slice(-1)}`;
    const drifted = patched.replace(point, driftedPoint);
    const result = captureWarns(() => applyDockIconMainPatch(drifted));
    assert.equal(result.value, drifted, point);
    assert.match(result.warnings.join("\n"), /complete current Dock icon main-process contract/);
  }

  const mixed = currentMainSource.replace(currentPoints[0], patchedPoints[0]);
  assert.equal(captureWarns(() => applyDockIconMainPatch(mixed)).value, mixed);
  const duplicate = currentMainSource + currentMainSource;
  assert.equal(captureWarns(() => applyDockIconMainPatch(duplicate)).value, duplicate);
});

test("settings patch exposes the official row on Linux across minified aliases", () => {
  const patched = applyDockIconSettingsPatch(currentSettingsSource);
  assert.match(
    patched,
    /return e!==`macOS`&&e!==`linux`\|\|r===t\.Agent\?null:n/,
  );
  assert.equal(applyDockIconSettingsPatch(patched), patched);

  const aliases = currentSettingsSource
    .replace("e!==`macOS`", "platform!==`macOS`")
    .replace("r===t.Agent", "flavor===flavors.Agent")
    .replace("?null:n", "?null:previews");
  assert.match(applyDockIconSettingsPatch(aliases), /platform!==`linux`/);
});

test("settings drift, duplicates, and mixed contracts remain byte-identical", () => {
  const patched = applyDockIconSettingsPatch(currentSettingsSource);
  for (const source of [
    currentSettingsSource.replace("dockIconPreviews", "dockIconPreviewsDrift"),
    currentSettingsSource + currentSettingsSource,
    currentSettingsSource + patched,
  ]) {
    const result = captureWarns(() => applyDockIconSettingsPatch(source));
    assert.equal(result.value, source);
    assert.match(result.warnings.join("\n"), /current Dock icon settings contract/);
  }
});

test("descriptors select only current official-package contracts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dock-icon-assets-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(
      path.join(assets, "dock-icon-setting-visibility-B9IZyljn.js"),
      currentSettingsSource,
    );
    fs.writeFileSync(
      path.join(assets, "dock-icon-setting-visibility-CsA3Lt9Z.js"),
      "old DMG fixture",
    );
    const settingsDescriptor = descriptors.find((descriptor) =>
      descriptor.id.endsWith("settings-row"),
    );
    const result = patchUniqueAssetFile(
      root,
      settingsDescriptor.pattern,
      settingsDescriptor.assetMatch,
      settingsDescriptor.apply,
      settingsDescriptor.missingDescription,
      "ambiguous Dock icon Settings bundles",
    );
    assert.deepEqual(result, {
      matched: 1,
      changed: 1,
      assetName: "dock-icon-setting-visibility-B9IZyljn.js",
    });
    assert.match(
      fs.readFileSync(path.join(assets, "dock-icon-setting-visibility-B9IZyljn.js"), "utf8"),
      /!==`linux`/,
    );
    assert.equal(
      fs.readFileSync(path.join(assets, "dock-icon-setting-visibility-CsA3Lt9Z.js"), "utf8"),
      "old DMG fixture",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging copies the signed-package icon and current package metadata contract", () => {
  const { root, install, result } = runStage();
  try {
    assert.equal(result.status, 0, result.stderr);
    const target = path.join(install, "resources", "dock-icon");
    assert.equal(fs.readFileSync(path.join(target, "icon-chatgpt.png"), "utf8"), "official-icon");
    assert.deepEqual(
      fs.readFileSync(path.join(target, "icon-codex-dark-color.png")),
      fs.readFileSync(path.resolve(__dirname, "../../assets/codex-linux.png")),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(target, "icon-codex-light.png")),
      fs.readFileSync(path.resolve(__dirname, "../../assets/codex-linux.png")),
    );
    assert.equal(fs.statSync(path.join(target, "sync-desktop-icon.sh")).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging rejects an incomplete candidate when official resources or metadata drift", () => {
  for (const options of [
    { officialIcon: null, stalePayload: true },
    { desktopMetadata: false, stalePayload: true },
  ]) {
    const { root, install, result } = runStage(options);
    try {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ERROR: Official Linux Dock icon/);
      assert.equal(fs.existsSync(path.join(install, "resources", "dock-icon")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("nested disable leaves no Dock payload", () => {
  const { root, install, result } = runStage({ enabled: false });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(install, "resources", "dock-icon")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
    "[Desktop Entry]\nName=ChatGPT Community\nExec=/usr/bin/codex-desktop %u\nIcon=codex-desktop\nStartupWMClass=codex-desktop\n",
  );
  fs.writeFileSync(firstIcon, "first-icon");
  fs.writeFileSync(secondIcon, "second-icon");
  const refreshCommand = path.join(binDir, "kbuildsycoca6");
  fs.writeFileSync(
    refreshCommand,
    "#!/usr/bin/env bash\nprintf '%s\\n' kbuildsycoca6 >> \"$CODEX_TEST_CALLS\"\n",
  );
  fs.chmodSync(refreshCommand, 0o755);
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
    managedIcon: (
      selection,
      appId = "codex-desktop",
      content = selection === "chatgpt" ? "first-icon" : "second-icon",
    ) =>
      path.join(
        dataHome,
        "icons",
        "hicolor",
        "256x256",
        "apps",
        `${appId}-dock-${selection}-${crypto.createHash("sha256").update(content).digest("hex")}.png`,
      ),
    legacyIcon: (selection, appId = "codex-desktop") =>
      path.join(dataHome, "icons", "hicolor", "256x256", "apps", `${appId}-dock-${selection}.png`),
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
    [path.join(__dirname, "sync-desktop-icon.sh"), appDir],
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
      /^X-Codex-Linux-Dock-Icon-SHA256=[0-9a-f]{64}$/m,
    );
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), [
      "kbuildsycoca6",
    ]);

    const repeated = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(fs.readFileSync(fixture.callsPath, "utf8").trim().split("\n"), [
      "kbuildsycoca6",
    ]);

    const second = runDesktopSync("codex-dark", fixture.secondIcon, fixture.env);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(fs.readFileSync(fixture.managedIcon("codex-dark"), "utf8"), "second-icon");
    assert.match(
      fs.readFileSync(fixture.managedDesktop, "utf8"),
      /dock-codex-dark-[0-9a-f]{64}\.png$/m,
    );
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization leaves an unmanaged user launcher untouched", () => {
  const fixture = createDesktopSyncFixture();
  try {
    fs.mkdirSync(path.dirname(fixture.managedDesktop), { recursive: true });
    fs.writeFileSync(
      fixture.managedDesktop,
      "[Desktop Entry]\nName=Custom\nIcon=/tmp/custom.png\n",
    );

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      fs.readFileSync(fixture.managedDesktop, "utf8"),
      "[Desktop Entry]\nName=Custom\nIcon=/tmp/custom.png\n",
    );
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), false);
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization ignores unknown selections", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const result = runDesktopSync("custom", fixture.firstIcon, fixture.env);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), false);
    assert.equal(fs.existsSync(fixture.managedIcon("custom")), false);
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup removes only marker-owned Dock launcher artifacts", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  try {
    fs.mkdirSync(appDir, { recursive: true });
    assert.equal(runDesktopSync("chatgpt", fixture.firstIcon, fixture.env).status, 0);
    assert.equal(runDesktopSync("codex-dark", fixture.secondIcon, fixture.env).status, 0);

    const cleaned = runDesktopCleanup(appDir, fixture.env);

    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), false);
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), false);
    assert.equal(fs.existsSync(fixture.managedIcon("codex-dark")), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup preserves a legacy marker without full managed-state proof", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  const legacyIcon = fixture.legacyIcon("selection");
  try {
    fs.mkdirSync(path.dirname(fixture.managedDesktop), { recursive: true });
    fs.mkdirSync(path.dirname(legacyIcon), { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(legacyIcon, "legacy-icon");
    fs.writeFileSync(
      fixture.managedDesktop,
      [
        "[Desktop Entry]",
        "Name=ChatGPT Community",
        `Icon=${legacyIcon}`,
        "X-Codex-Linux-Dock-Icon=1",
      ].join("\n"),
    );

    const cleaned = runDesktopCleanup(appDir, fixture.env);

    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), true);
    assert.equal(fs.existsSync(legacyIcon), true);
    assert.equal(fs.existsSync(fixture.callsPath), false);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup preserves symlinked and customized launcher artifacts", () => {
  for (const kind of ["symlink", "customized"]) {
    const fixture = createDesktopSyncFixture();
    const appDir = path.join(fixture.tempDir, "app");
    try {
      fs.mkdirSync(path.dirname(fixture.managedDesktop), { recursive: true });
      fs.mkdirSync(path.dirname(fixture.legacyIcon("chatgpt")), { recursive: true });
      fs.mkdirSync(appDir, { recursive: true });
      fs.writeFileSync(fixture.legacyIcon("chatgpt"), "unproven-icon");
      if (kind === "symlink") {
        const outside = path.join(fixture.tempDir, "outside.desktop");
        fs.writeFileSync(outside, "[Desktop Entry]\nIcon=outside\nX-Codex-Linux-Dock-Icon=1\n");
        fs.symlinkSync(outside, fixture.managedDesktop);
      } else {
        fs.writeFileSync(
          fixture.managedDesktop,
          "[Desktop Entry]\nName=Customized\nIcon=/tmp/custom.png\nX-Codex-Linux-Dock-Icon=1\n",
        );
      }

      const cleaned = runDesktopCleanup(appDir, fixture.env);

      assert.equal(cleaned.status, 0, cleaned.stderr);
      assert.equal(fs.existsSync(fixture.managedDesktop), true);
      assert.equal(fs.readFileSync(fixture.legacyIcon("chatgpt"), "utf8"), "unproven-icon");
      assert.equal(fs.existsSync(fixture.callsPath), false);
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  }
});

test("sync and cleanup preserve user edits to a previously managed launcher", () => {
  for (const field of ["Name", "Exec", "Actions"]) {
    const fixture = createDesktopSyncFixture();
    const appDir = path.join(fixture.tempDir, "app");
    try {
      fs.mkdirSync(appDir, { recursive: true });
      assert.equal(runDesktopSync("chatgpt", fixture.firstIcon, fixture.env).status, 0);
      const original = fs.readFileSync(fixture.managedDesktop, "utf8");
      const customized = original.replace(
        new RegExp(`^${field}=.*$`, "m"),
        `${field}=User customized ${field}`,
      );
      const customizedWithField = customized === original
        ? `${original}${field}=User customized ${field}\n`
        : customized;
      fs.writeFileSync(fixture.managedDesktop, customizedWithField);

      const sync = runDesktopSync("codex-dark", fixture.secondIcon, fixture.env);
      assert.equal(sync.status, 0, `${field}: ${sync.stderr}`);
      assert.equal(fs.readFileSync(fixture.managedDesktop, "utf8"), customizedWithField, field);
      assert.equal(fs.existsSync(fixture.managedIcon("codex-dark")), false, field);

      const cleanup = runDesktopCleanup(appDir, fixture.env);
      assert.equal(cleanup.status, 0, `${field}: ${cleanup.stderr}`);
      assert.equal(fs.readFileSync(fixture.managedDesktop, "utf8"), customizedWithField, field);
      assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), "first-icon");
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  }
});

test("sync and cleanup preserve pre-existing and modified icon resources", () => {
  for (const kind of ["pre-existing", "modified"]) {
    const fixture = createDesktopSyncFixture();
    const appDir = path.join(fixture.tempDir, "app");
    try {
      fs.mkdirSync(appDir, { recursive: true });
      fs.mkdirSync(path.dirname(fixture.managedIcon("chatgpt")), { recursive: true });
      if (kind === "pre-existing") {
        fs.writeFileSync(fixture.managedIcon("chatgpt"), "user-icon");
      } else {
        assert.equal(runDesktopSync("chatgpt", fixture.firstIcon, fixture.env).status, 0);
        fs.writeFileSync(fixture.managedIcon("chatgpt"), "user-modified-icon");
      }

      const before = fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8");
      const sync = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
      assert.equal(sync.status, 0, `${kind}: ${sync.stderr}`);
      assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), before, kind);

      const cleanup = runDesktopCleanup(appDir, fixture.env);
      assert.equal(cleanup.status, 0, `${kind}: ${cleanup.stderr}`);
      assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), before, kind);
      if (kind === "modified") {
        fs.rmSync(fixture.managedIcon("chatgpt"));
        const resumed = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
        assert.equal(resumed.status, 0, resumed.stderr);
        assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), "first-icon");
      }
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  }
});

test("content-addressed icons recover interrupted sync and cleanup states", () => {
  const fixture = createDesktopSyncFixture();
  const appDir = path.join(fixture.tempDir, "app");
  try {
    fs.mkdirSync(appDir, { recursive: true });
    const icon = fixture.managedIcon("chatgpt");

    fs.mkdirSync(path.dirname(icon), { recursive: true });
    fs.writeFileSync(icon, "first-icon");
    const resumedInitialSync = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(resumedInitialSync.status, 0, resumedInitialSync.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), true);
    assert.equal(fs.readFileSync(icon, "utf8"), "first-icon");

    fs.rmSync(icon);
    const resumedUpdate = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(resumedUpdate.status, 0, resumedUpdate.stderr);
    assert.equal(fs.readFileSync(icon, "utf8"), "first-icon");

    fs.rmSync(icon);
    const resumedCleanup = runDesktopCleanup(appDir, fixture.env);
    assert.equal(resumedCleanup.status, 0, resumedCleanup.stderr);
    assert.equal(fs.existsSync(fixture.managedDesktop), false);
    assert.equal(fs.existsSync(icon), false);

    const orphanChatgpt = fixture.managedIcon("chatgpt");
    const orphanCodex = fixture.managedIcon("codex-dark");
    fs.writeFileSync(orphanChatgpt, "first-icon");
    fs.writeFileSync(orphanCodex, "second-icon");
    const recoveredOrphans = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(recoveredOrphans.status, 0, recoveredOrphans.stderr);
    assert.equal(fs.existsSync(orphanChatgpt), true);
    assert.equal(fs.existsSync(orphanCodex), false);

    const modifiedOrphan = fixture.managedIcon("codex-light", "codex-desktop", "owned-before-edit");
    fs.writeFileSync(modifiedOrphan, "user-modified");
    const preservedModifiedOrphan = runDesktopCleanup(appDir, fixture.env);
    assert.equal(preservedModifiedOrphan.status, 0, preservedModifiedOrphan.stderr);
    assert.equal(fs.readFileSync(modifiedOrphan, "utf8"), "user-modified");

    fs.writeFileSync(orphanCodex, "second-icon");
    const recoveredInitialOrphan = runDesktopCleanup(appDir, fixture.env);
    assert.equal(recoveredInitialOrphan.status, 0, recoveredInitialOrphan.stderr);
    assert.equal(fs.existsSync(orphanCodex), false);
    assert.equal(fs.readFileSync(modifiedOrphan, "utf8"), "user-modified");
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization serializes the per-app launcher transaction with a timeout", async () => {
  const fixture = createDesktopSyncFixture();
  const applicationsDir = path.join(fixture.dataHome, "applications");
  let holder;
  let sync;
  try {
    fs.mkdirSync(applicationsDir, { recursive: true });
    holder = childProcess.spawn("flock", [applicationsDir, "bash", "-c", "printf locked; sleep 1"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", resolve);
      holder.once("error", reject);
    });
    sync = childProcess.spawn(
      "bash",
      [path.join(__dirname, "sync-desktop-icon.sh"), "chatgpt"],
      { env: fixture.env, stdio: ["pipe", "ignore", "pipe"] },
    );
    sync.stdin.end(fs.readFileSync(fixture.firstIcon));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sync.exitCode, null);
    await new Promise((resolve, reject) => {
      sync.once("exit", resolve);
      sync.once("error", reject);
    });
    assert.equal(sync.exitCode, 0);
    assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt"), "utf8"), "first-icon");

    holder = childProcess.spawn("flock", [applicationsDir, "bash", "-c", "printf locked; sleep 7"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", resolve);
      holder.once("error", reject);
    });
    const started = Date.now();
    const timedOut = runDesktopSync("codex-dark", fixture.secondIcon, fixture.env);
    assert.equal(timedOut.status, 0, timedOut.stderr);
    assert.match(timedOut.stderr, /Could not lock Dock icon launcher state/);
    assert.ok(Date.now() - started >= 4500);
    assert.ok(Date.now() - started < 6500);
  } finally {
    holder?.kill();
    sync?.kill();
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("AppImage synchronization writes persistent launch commands for the app and action", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const sourceDir = path.join(fixture.tempDir, "mounted AppDir");
    const sourceDesktop = path.join(sourceDir, "codex-desktop.desktop");
    const appImage = path.join(fixture.tempDir, 'ChatGPT $Community "nightly" 100%.AppImage');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(appImage, "appimage");
    fs.chmodSync(appImage, 0o755);
    fs.writeFileSync(
      sourceDesktop,
      fs.readFileSync(path.resolve(__dirname, "../../packaging/appimage/codex-desktop.desktop"), "utf8")
        .replaceAll("__PACKAGE_NAME__", "codex-desktop")
        .replaceAll("__PACKAGE_DISPLAY_NAME__", "ChatGPT Community")
        .replaceAll("__PACKAGE_COMMENT__", "Community package")
        .replaceAll("__VERSION__", "test"),
    );
    fixture.env.APPIMAGE = appImage;
    fixture.env.CODEX_LINUX_DESKTOP_FILE_SOURCE = sourceDesktop;

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(result.status, 0, result.stderr);
    const managed = fs.readFileSync(fixture.managedDesktop, "utf8");
    const desktopAppImage = appImage
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("`", "\\`")
      .replaceAll("$", "\\$")
      .replaceAll("%", "%%");
    assert.doesNotMatch(managed, /\bAppRun\b/);
    assert.equal(
      managed.includes(`Exec="${desktopAppImage}" --show %u\n`),
      true,
    );
    assert.equal(
      managed.includes(
        `Exec=env CHROME_DESKTOP=codex-desktop.desktop CODEX_MULTI_LAUNCH=1 "${desktopAppImage}" --new-instance\n`,
      ),
      true,
    );
    const validation = childProcess.spawnSync("desktop-file-validate", [fixture.managedDesktop], {
      encoding: "utf8",
    });
    if (validation.error?.code !== "ENOENT") {
      assert.equal(validation.status, 0, validation.stderr);
    }
    fs.rmSync(sourceDir, { recursive: true, force: true });
    assert.equal(fs.readFileSync(fixture.managedDesktop, "utf8"), managed);
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("AppImage synchronization refuses to persist a launcher without a usable AppImage path", () => {
  const fixture = createDesktopSyncFixture();
  try {
    const sourceDir = path.join(fixture.tempDir, "mounted-AppDir");
    const sourceDesktop = path.join(sourceDir, "codex-desktop.desktop");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(
      sourceDesktop,
      fs.readFileSync(path.resolve(__dirname, "../../packaging/appimage/codex-desktop.desktop"), "utf8")
        .replaceAll("__PACKAGE_NAME__", "codex-desktop")
        .replaceAll("__PACKAGE_DISPLAY_NAME__", "ChatGPT Community")
        .replaceAll("__PACKAGE_COMMENT__", "Community package")
        .replaceAll("__VERSION__", "test"),
    );
    delete fixture.env.APPIMAGE;
    fixture.env.CODEX_LINUX_DESKTOP_FILE_SOURCE = sourceDesktop;

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /has no persistent AppImage path/);
    assert.equal(fs.existsSync(fixture.managedDesktop), false);
    assert.equal(fs.existsSync(fixture.managedIcon("chatgpt")), false);
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
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization discovers side-by-side launchers after an incompatible BAMF hint", () => {
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
      ].join("\n"),
    );
    delete fixture.env.CODEX_LINUX_DESKTOP_FILE_SOURCE;
    fixture.env.BAMF_DESKTOP_FILE_HINT = path.join(fixture.tempDir, "codex-desktop.desktop");
    fixture.env.CODEX_LINUX_APP_ID = appId;
    fixture.env.XDG_DATA_DIRS = dataDir;

    const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);
    const managedDesktop = path.join(fixture.dataHome, "applications", `${appId}.desktop`);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(fixture.managedIcon("chatgpt", appId), "utf8"), "first-icon");
    assert.match(
      fs.readFileSync(managedDesktop, "utf8"),
      /^X-Codex-Linux-Dock-Icon-SHA256=[0-9a-f]{64}$/m,
    );
  } finally {
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("desktop synchronization rejects every mismatched side-by-side identity field", () => {
  const appId = "chatgpt-dock-side";
  const validExec =
    `Exec=env BAMF_DESKTOP_FILE_HINT=/usr/share/applications/${appId}.desktop ` +
    `CHROME_DESKTOP=${appId}.desktop CODEX_APP_ID=${appId} /opt/${appId}/start.sh %u`;
  const cases = [
    [
      "Exec",
      "Exec=/usr/bin/codex-desktop %u",
      `StartupWMClass=${appId}`,
      `X-GNOME-WMClass=${appId}`,
    ],
    [
      "StartupWMClass",
      validExec,
      "StartupWMClass=codex-desktop",
      `X-GNOME-WMClass=${appId}`,
    ],
    [
      "X-GNOME-WMClass",
      validExec,
      `StartupWMClass=${appId}`,
      "X-GNOME-WMClass=codex-desktop",
    ],
    [
      "CHROME_DESKTOP",
      validExec.replace(`CHROME_DESKTOP=${appId}.desktop`, "CHROME_DESKTOP=codex-desktop.desktop"),
      `StartupWMClass=${appId}`,
      `X-GNOME-WMClass=${appId}`,
    ],
    [
      "BAMF_DESKTOP_FILE_HINT",
      validExec.replace(
        `BAMF_DESKTOP_FILE_HINT=/usr/share/applications/${appId}.desktop`,
        "BAMF_DESKTOP_FILE_HINT=/usr/share/applications/codex-desktop.desktop",
      ),
      `StartupWMClass=${appId}`,
      `X-GNOME-WMClass=${appId}`,
    ],
    [
      "CODEX_APP_ID",
      validExec.replace(`CODEX_APP_ID=${appId}`, "CODEX_APP_ID=codex-desktop"),
      `StartupWMClass=${appId}`,
      `X-GNOME-WMClass=${appId}`,
    ],
  ];

  for (const [field, execLine, startupClass, gnomeClass] of cases) {
    const fixture = createDesktopSyncFixture();
    try {
      const source = path.join(fixture.tempDir, `${appId}.desktop`);
      fs.writeFileSync(
        source,
        [
          "[Desktop Entry]",
          "Name=Wrong identity",
          execLine,
          `Icon=${appId}`,
          startupClass,
          gnomeClass,
        ].join("\n"),
      );
      fixture.env.CODEX_LINUX_APP_ID = appId;
      fixture.env.CODEX_LINUX_DESKTOP_FILE_SOURCE = source;

      const result = runDesktopSync("chatgpt", fixture.firstIcon, fixture.env);

      assert.equal(result.status, 0, `${field}: ${result.stderr}`);
      assert.equal(
        fs.existsSync(path.join(fixture.dataHome, "applications", `${appId}.desktop`)),
        false,
        field,
      );
      assert.equal(fs.existsSync(fixture.managedIcon("chatgpt", appId)), false, field);
      assert.equal(fs.existsSync(fixture.callsPath), false, field);
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  }
});
