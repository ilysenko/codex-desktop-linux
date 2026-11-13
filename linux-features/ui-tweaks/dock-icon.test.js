#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  enabledLinuxFeatureInstallPlan,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeatureInstall,
} = require("../../scripts/lib/linux-features.js");
const {
  findWebviewAssetsContaining,
  patchAssetFiles,
} = require("../../scripts/patches/lib/assets.js");
const {
  applyDockIconMainPatch,
  applyDockIconSettingsPatch,
  descriptors,
  dockIconEnabled,
} = require("./patches/dock-icon.js");

// Current returned window-services and connected request-host fixture.
const { currentDockMainSource } = require("./fixtures/current-dock-main.js");
const { findMatchingBrace, escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { normalizePatchDescriptors, applyExtractedAppPatchDescriptors } = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const currentMainSource = currentDockMainSource();
// Current Rspack Dock row gate, duplicated into every consuming async chunk.
const currentSettingsSource =
  'export const __rspack_esm_ids=[572868];export const __webpack_modules__={' +
  'IKhT(e,t,a){var s=a("DBCl");function n({platform:e,dockIconPreviews:t,buildFlavor:a="prod"}){return"macOS"!==e||a===s.x1u.Agent?null:t}a.d(t,{_:()=>n})},' +
  'kQ2a(e,t,a){var s=a("IKhT");function r(e,t){let n=t?.dockIconPreviews??null;return(0,s._)({platform:e,dockIconPreviews:n})}a.d(t,{r:()=>r})}};';

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

function evaluateLinuxPreviews(patchedSource, payloadDir, includePreviews = true) {
  const preview = patchedSource.match(
    /dockIconPreviews:(?<include>[A-Za-z_$][\w$]*)\?(?<expression>function\((?<arg>[A-Za-z_$][\w$]*)\)\{if\("darwin"!==process\.platform&&"linux"!==process\.platform\)return null;let (?<theme>[A-Za-z_$][\w$]*)=(?<themeHelper>[A-Za-z_$][\w$]*)\(\k<arg>\),(?<defaultIcon>[A-Za-z_$][\w$]*)=(?<resource>[A-Za-z_$][\w$]*)\(`\$\{(?<iconName>[A-Za-z_$][\w$]*)\(\k<arg>\)\}\.png`\),(?<codexDark>[A-Za-z_$][\w$]*)=\k<resource>\(\k<theme>\.dark\),(?<codexLight>[A-Za-z_$][\w$]*)=\k<resource>\(\k<theme>\.light\),(?<spaceDark>[A-Za-z_$][\w$]*)="linux"===process\.platform\?\k<codexDark>:\k<resource>\(\k<theme>\.spaceDark\),(?<spaceLight>[A-Za-z_$][\w$]*)="linux"===process\.platform\?\k<codexLight>:\k<resource>\(\k<theme>\.spaceLight\);return [^}]+\}\}\((?<preference>[A-Za-z_$][\w$]*)\)):null/,
  );
  assert.ok(preview, "expected one complete patched preview function");
  const sandbox = {
    process: { platform: "linux" },
    [preview.groups.include]: includePreviews,
    [preview.groups.preference]: "prod",
    [preview.groups.themeHelper]: () => ({
      dark: "icon-codex-dark-color.png",
      light: "icon-codex-light.png",
      spaceDark: "icon-space-dark.png",
      spaceLight: "icon-space-light.png",
    }),
    [preview.groups.iconName]: () => "icon-chatgpt",
    [preview.groups.resource]: (name) => {
      assert.equal(includePreviews, true, "disabled previews must not read icon resources");
      const resource = path.join(payloadDir, name);
      return fs.existsSync(resource) ? fs.readFileSync(resource, "utf8") : null;
    },
  };
  vm.runInNewContext(`result=${preview.groups.include}?${preview.groups.expression}:null`, sandbox);
  return sandbox.result;
}

test("native preview opt-out skips the Linux icon resource lookup", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  assert.notEqual(patched, currentMainSource);
  assert.equal(evaluateLinuxPreviews(patched, "/unused", false), null);
});

function evaluateLinuxRuntimeResourceNames(source) {
  return (preference, dark) => {
    const runtime = linuxIconRuntime(source);
    runtime.preference(preference);runtime.dark(dark);runtime.apply(preference);
    return path.basename(runtime.images.at(-1));
  };
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

function nativeMacObserver(source) {
  const head = /\(async function\(([A-Za-z_$][\w$]*)\)\{if\(26>Number\.parseInt\(process\.getSystemVersion\(\),10\)\)/u.exec(source);
  assert.ok(head, "expected the current native style observer");
  const log = source.indexOf('"Failed to observe macOS Dock icon appearance"', head.index);
  const catchAt = source.lastIndexOf(".catch(", log), open = source.indexOf("{", catchAt), close = findMatchingBrace(source, open);
  assert.ok(log > head.index && catchAt > head.index && close > open);
  return source.slice(head.index, close + 2);
}

function linuxIconRuntime(source, options = {}) {
  const id = "[A-Za-z_$][\\w$]*";
  const head = new RegExp(`(?<update>${id})=(?<isMac>${id})(?:\\|\\|"linux"===process\\.platform)?\\?function\\(\\{buildFlavor:(?<flavor>${id}),repoRoot:(?<repo>${id}),isDevMode:(?<dev>${id}),settingsStore:(?<settings>${id}),disposables:(?<disposables>${id}),errorReporter:(?<report>${id})\\}\\)\\{`, "u").exec(source);
  assert.ok(head, "expected current Dock controller");
  const open = head.index + head[0].length - 1, close = findMatchingBrace(source, open), argumentOpen = close + 2, argumentClose = findMatchingBrace(source, argumentOpen);
  const end = argumentClose + 1 + "):()=>{}".length;
  const expression = source.slice(head.index + head.groups.update.length + 1, end), body = source.slice(open + 1, close);
  const argumentsText = source.slice(argumentOpen + 1, argumentClose);
  const argument = key => new RegExp(`(?:^|,)${key}:(${id})(?=,|$)`, "u").exec(argumentsText)?.[1];
  const electron = new RegExp(`(${id})\\.nativeTheme\\.shouldUseDarkColorsForSystemIntegratedUI`, "u").exec(body)?.[1];
  const paths = new RegExp(`\\(0,(${id})\\.join\\)`, "u").exec(body)?.[1];
  const exists = new RegExp(`\\(0,(${id})\\.existsSync\\)`, "u").exec(body)?.[1];
  const theme = new RegExp(`(?:^|,)${id}=(?<helper>${id})\\(${head.groups.flavor}\\),`, "u").exec(body)?.groups.helper;
  const iconName = new RegExp("`\\$\\{(" + id + ")\\(" + head.groups.flavor + "\\)\\}\\.png`", "u").exec(body)?.[1];
  const flavor = new RegExp(`${head.groups.flavor}===(?<namespace>${id})\\.(?<field>${id})\\.Dev`, "u").exec(body)?.groups;
  const preferences = new RegExp(`${head.groups.settings}\\.getEffective\\((?<namespace>${id})\\.(?<field>${id})\\.dockIconPreference\\.key\\)`, "u").exec(body)?.groups;
  const tray = new RegExp(`null!=(${id})\\?\\.tray`, "u").exec(body)?.[1];
  const legacy = new RegExp(`getSystemVersion\\(\\),10\\)\\)return (${id})\\(${id}\\);`, "u").exec(body)?.[1];
  const macPath = new RegExp(`let ${id}=(?<tool>${id})\\(\\),(?:${id})=\\((?:${id})=(?<wrapper>${id})\\(\\)\\.dirname`, "u").exec(body)?.groups;
  assert.ok(electron && paths && exists && theme && iconName && flavor && preferences && legacy && macPath);
  const imagePaths = [], images = [], listeners = new Set(), disposers = [], dockImages = [], windowImages = [], trayImages = [], spawned = [], bundles = [], reports = [];
  let preference = options.preference ?? "codex-system", appearance, cleanups = 0, cropCalls = 0, systemVersionReads = 0, addonLoads = 0;
  const platform = options.platform ?? "linux";
  const loader = new RegExp(`\\.then\\((${id})\\.t\\.bind`, "u").exec(body)?.[1];
  const image = name => ({ name, isEmpty: () => options.emptyImage === true, toPNG: () => Buffer.from(name),
    getSize: () => ({ width: 128, height: 128 }), crop() { cropCalls++; return this; } });
  const electronMock = {
    app: { isPackaged: options.packaged !== false, getAppPath: () => "/inert/app", dock: { setIcon(value) { dockImages.push(value); } } },
    nativeTheme: { shouldUseDarkColorsForSystemIntegratedUI: options.dark !== false,
      on(event, listener) { assert.equal(event, "updated"); listeners.add(listener); },
      off(event, listener) { assert.equal(event, "updated"); assert.equal(listeners.delete(listener), true); } },
    nativeImage: { createFromPath(name) { imagePaths.push(name);images.push(path.basename(name)); return image(name); } },
    BrowserWindow: { getAllWindows: () => options.windows ?? [{ isDestroyed: () => false, setIcon(value) { windowImages.push(value); } }] },
  };
  const context = {
    process: { platform, arch: "x64", resourcesPath: "/inert/resources", execPath: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
      env: options.devPath ? { CODEX_ELECTRON_DEV_DOCK_ICONS_PATH: options.devPath } : {}, getSystemVersion() { systemVersionReads++; return options.systemVersion ?? "25"; } },
    [head.groups.isMac]: platform === "darwin",
    [argument("buildFlavor")]: options.flavor ?? "prod", [argument("repoRoot")]: "/inert/source", [argument("isDevMode")]: options.dev === true,
    [argument("settingsStore")]: { getEffective(key) { assert.equal(key, "dock-preference"); return preference; } },
    [argument("disposables")]: { add(callback) { disposers.push(callback); } },
    [argument("errorReporter")]: { reportNonFatal(error, detail) { reports.push({ error, detail }); } },
    [electron]: electronMock, [paths]: path, [exists]: { existsSync: name => options.exists?.(name) ?? true },
    [theme]: () => ({ dark: "icon-codex-dark-color.png", light: "icon-codex-light.png", spaceDark: "icon-space-dark.png", spaceLight: "icon-space-light.png", appDefaultBundle: "app-default.icon", codexBundle: "codex.icon", spaceBundle: "space.icon" }),
    [iconName]: value => value === "agent" ? "icon-agent" : "icon-chatgpt",
    [flavor.namespace]: { [flavor.field]: { Dev: "dev", Agent: "agent", Nightly: "nightly", InternalAlpha: "internal", PublicBeta: "beta", Prod: "prod" } },
    [preferences.namespace]: { [preferences.field]: { dockIconPreference: { key: "dock-preference", default: "app-default" } } },
    [legacy]: callback => { appearance = callback; return options.observerPromise ?? (() => { cleanups++; }); },
    [macPath.tool]: () => null, [macPath.wrapper]: () => path,
    codexLinuxDockIconResourcePath: name => `/inert/resources/dock-icon/${name}`,
    require(name) {
      if (name === "node:fs") return { existsSync: () => options.syncScript === true };
      assert.equal(name, "node:child_process");
      return { spawn(file, args, spawnOptions) { const child = { file, args, options: spawnOptions, png: null, unrefed: false,
        on() {}, stdin: { on() {}, end(value) { child.png = value; } }, unref() { child.unrefed = true; } };spawned.push(child);return child; } };
    },
  };
  if (loader) context[loader] = { t() { addonLoads++; throw Error("controlled macOS Dock addon failure"); } };
  if (tray) context[tray] = options.destroyedTray ? { tray: { isDestroyed: () => true, setImage() { assert.fail("Destroyed tray received an image"); } } } :
    { tray: { isDestroyed: () => false, setImage(value) { trayImages.push(value); } } };
  vm.runInNewContext("result=" + expression, context);
  return { imagePaths, images, listeners, disposers, context, windowImages, trayImages, spawned, bundles, reports, dockImages,
    dockCalls: () => dockImages.length, cropCalls: () => cropCalls, cleanups: () => cleanups,
    systemVersionReads: () => systemVersionReads, addonLoads: () => addonLoads,
    preference(value) { preference = value; },
    dark(value) { electronMock.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = value; for (const listener of [...listeners]) listener(); },
    apply(value) { preference = value; context.result(); }, update() { context.result(); },
    appearance(value, applied = true) { assert.equal(typeof appearance, "function");appearance(value, (resource, label) => { bundles.push({ resource, label });return applied; }); },
  };
}

test("current window-services patch preserves the complete macOS observer and native readiness guard", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  assert.notEqual(patched, currentMainSource);
  assert.equal(nativeMacObserver(patched), nativeMacObserver(currentMainSource));
  assert.match(patched, /if\(g\|\|null==m&&"app-default"!==t\)return;/u);
  assert.match(patched, /m="linux"===process\.platform\?\{dark:eZ\.nativeTheme\.shouldUseDarkColorsForSystemIntegratedUI,style:"regular"\}:null/u);
  assert.match(patched, /windowManager:services\.windowManager/u);
  assert.match(patched, /onWindowRegistered:e=>\{T\?\.registerWindow\(e\),v\?\.\(e\),"linux"===process\.platform&&setImmediate\(x\)\}/u);
  assert.equal(applyDockIconMainPatch(patched), patched);
  new vm.Script(patched);
  const renamed = currentMainSource.replace(/\beO\b/gu, "nativeWindowsService").replace("x=p?function", "refreshCommunityIcon=p?function").replace("updateDockIcon:x", "updateDockIcon:refreshCommunityIcon");
  const renamedPatched = applyDockIconMainPatch(renamed);
  assert.notEqual(renamedPatched, renamed);
  assert.equal(applyDockIconMainPatch(renamedPatched), renamedPatched);
});

test("Linux icon initialization and theme updates use the same ready dark/light state and remove their listener", () => {
  const patched = applyDockIconMainPatch(currentMainSource), runtime = linuxIconRuntime(patched);
  assert.equal(runtime.images.at(-1), "icon-codex-dark-color.png");
  runtime.dark(false);
  assert.equal(runtime.images.at(-1), "icon-codex-light.png");
  runtime.preference("space-system"); runtime.dark(true);
  assert.equal(runtime.images.at(-1), "icon-codex-dark-color.png");
  runtime.preference("app-default"); runtime.apply("app-default");
  assert.equal(runtime.images.at(-1), "icon-chatgpt.png");
  assert.equal(runtime.dockCalls(), 0);
  assert.equal(runtime.listeners.size, 1);
  for (const dispose of runtime.disposers) dispose();
  assert.equal(runtime.listeners.size, 0);
  const before = runtime.images.length; runtime.dark(false);
  assert.equal(runtime.images.length, before);
});

test("Linux uses PNG resources, live windows/tray and desktop sync while native Mac observation stays dormant", () => {
  const source = applyDockIconMainPatch(currentMainSource);
  let destroyedCalls = 0;
  const runtime = linuxIconRuntime(source, { syncScript: true, dev: true, devPath: "/inert/dev", windows: [
    { isDestroyed: () => false, setIcon(image) { assert.ok(image.name.includes("/dock-icon/")); } },
    { isDestroyed: () => true, setIcon() { destroyedCalls++; } },
  ] });
  assert.equal(runtime.systemVersionReads(), 0);
  assert.equal(runtime.addonLoads(), 0);
  assert.equal(runtime.cropCalls(), 0);
  assert.equal(runtime.dockCalls(), 0);
  assert.equal(runtime.images.at(-1), "icon-codex-dark-color.png");
  assert.equal(destroyedCalls, 0);
  assert.equal(runtime.trayImages.at(-1), runtime.context.codexLinuxDockIconImage);
  const child = runtime.spawned.at(-1);
  assert.equal(child.file, "/inert/resources/dock-icon/sync-desktop-icon.sh");
  assert.deepEqual(Array.from(child.args), ["codex-dark"]);
  assert.equal(child.options.detached, true);
  assert.equal(child.unrefed, true);
  assert.deepEqual(child.png, runtime.context.codexLinuxDockIconImage.toPNG());
  runtime.preference("space-system");runtime.dark(false);
  assert.equal(runtime.images.at(-1), "icon-codex-light.png");
  assert.deepEqual(Array.from(runtime.spawned.at(-1).args), ["codex-light"]);
  runtime.apply("app-default");
  assert.equal(runtime.images.at(-1), "icon-chatgpt.png");
  assert.deepEqual(Array.from(runtime.spawned.at(-1).args), ["chatgpt"]);
  const listener = [...runtime.listeners][0];
  for (const dispose of runtime.disposers) dispose();
  const before = runtime.images.length;listener();runtime.update();
  assert.equal(runtime.images.length, before);
});

test("native Mac regular, bundle, tinted and dev overlay behavior retain their source and callbacks", async () => {
  const source = applyDockIconMainPatch(currentMainSource);
  assert.equal(nativeMacObserver(source), nativeMacObserver(currentMainSource));
  const regular = linuxIconRuntime(source, { platform: "darwin", preference: "space-system" });
  assert.equal(regular.images.length, 0, "native custom preference waits for appearance readiness");
  regular.appearance({ dark: true, style: "regular" });
  assert.equal(regular.images.at(-1), "icon-space-dark.png");
  assert.equal(regular.cropCalls(), 1);
  assert.equal(regular.listeners.size, 0);
  const before = regular.images.length;regular.appearance({ dark: true, style: "regular" });
  assert.equal(regular.images.length, before);
  regular.appearance({ dark: true, style: "clear" });
  assert.equal(regular.bundles.at(-1).resource, "/inert/resources/space.icon");
  assert.equal(regular.bundles.at(-1).label, null);
  regular.appearance({ dark: true, style: "tinted" });
  const count = regular.bundles.length;regular.appearance({ dark: true, style: "tinted" });
  assert.equal(regular.bundles.length, count + 1);
  const dev = linuxIconRuntime(source, { platform: "darwin", dev: true, devPath: "/inert/dev", preference: "app-default" });
  dev.appearance({ dark: false, style: "clear" });
  assert.deepEqual(dev.bundles.at(-1), { resource: "/inert/resources/app-default.icon", label: "/inert/dev/label.png" });
  const agent = linuxIconRuntime(source, { platform: "darwin", flavor: "agent", preference: "codex-system" });
  agent.appearance({ dark: true, style: "tinted" });
  assert.equal(agent.bundles.length, 0);
  assert.equal(agent.dockImages.at(-1), null);
  assert.equal(agent.images.length, 0);
  await Promise.resolve();await Promise.resolve();
  for (const runtime of [regular, dev, agent]) for (const dispose of runtime.disposers) dispose();
  assert.equal(regular.cleanups(), 1);
});

test("native observer late completion and fallback keep their disposal contracts", async () => {
  const source = applyDockIconMainPatch(currentMainSource);
  let resolve, cleaned = 0;
  const observerPromise = new Promise(done => { resolve = done; });
  const late = linuxIconRuntime(source, { platform: "darwin", observerPromise });
  for (const dispose of late.disposers) dispose();
  resolve(() => { cleaned++; });
  await new Promise(setImmediate);
  assert.equal(cleaned, 1);
  const fallback = linuxIconRuntime(source, { platform: "darwin", systemVersion: "26" });
  await new Promise(setImmediate);
  assert.equal(fallback.addonLoads(), 1);
  assert.equal(fallback.reports.length, 1);
  fallback.appearance({ dark: false, style: "regular" });
  assert.equal(fallback.images.at(-1), "icon-codex-light.png");
  for (const dispose of fallback.disposers) dispose();
  assert.equal(fallback.cleanups(), 1);
});

test("Dock controller and forwarded window services reject captured writes while unrelated shadows retain ownership", () => {
  const source = currentMainSource;
  for (const statement of [
    "Promise.resolve().then(()=>{x=()=>{}});",
    "Promise.resolve().then(()=>{eZ=foreign});",
    "Promise.resolve().then(()=>{EH=()=>null});",
    "let require=foreign;",
  ]) {
    const damaged = source.replace("return{windowManager:X", statement + "return{windowManager:X");
    assert.notEqual(damaged, source);
    const result = captureWarns(() => applyDockIconMainPatch(damaged));
    assert.equal(result.value, damaged);assert.ok(result.warnings.length > 0);
  }
  const control = source.replace("return{windowManager:X", "Promise.resolve().then((x)=>{x=()=>{}});return{windowManager:X");
  assert.notEqual(applyDockIconMainPatch(control), control);
  for (const member of ['"updateDockIcon":foreign', '["updateDockIcon"]:foreign', 'get updateDockIcon(){return foreign}', '...unknownServices']) {
    const damaged = source.replace("updateDockIcon:x}", `updateDockIcon:x,${member}}`);
    assert.notEqual(damaged, source);assert.equal(captureWarns(() => applyDockIconMainPatch(damaged)).value, damaged);
  }
});

test("empty or missing Linux resources and the native Windows gate keep icon owners untouched", () => {
  const source = applyDockIconMainPatch(currentMainSource);
  for (const options of [{ emptyImage: true }, { exists: () => false }, { platform: "win32" }]) {
    const runtime = linuxIconRuntime(source, options);
    assert.equal(runtime.windowImages.length, 0);
    assert.equal(runtime.trayImages.length, 0);
    assert.equal(runtime.spawned.length, 0);
    assert.equal(runtime.dockCalls(), 0);
    if (options.platform === "win32") {
      assert.equal(runtime.listeners.size, 0);assert.equal(runtime.images.length, 0);assert.equal(runtime.systemVersionReads(), 0);
    }
    for (const dispose of runtime.disposers) dispose();
  }
});

test("current icon ownership and complete canonical contributions reject changed bindings and partial states", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  const cases = [
    currentMainSource.replace("windowServices:eO", "windowServices:otherService"),
    currentMainSource.replace("windowManager:services.windowManager", "windowManager:otherService.windowManager"),
    currentMainSource.replace("isMacOS:p,isWindows:m", "isMacOS:otherMac,isWindows:m"),
    currentMainSource.replace("m=null,g=!1", "m=false,g=!1"),
    currentMainSource.replace("onWindowRegistered:e=>{T?.registerWindow(e)", "onWindowRegistered:e=>{otherContext?.registerWindow(e)"),
    patched.replace("dark:eZ.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI", "dark:false"),
    patched.replace("let codexLinuxIconSelection=", "let changedSelection="),
    patched.replace("function codexLinuxDockIconResourcePath", "function missingResourceHelper"),
    patched.replace("r.d(t,{", String.raw`{\u0063odexLinuxDockIconResourcePath=()=>null;}r.d(t,{`),
    currentMainSource + currentMainSource,
  ];
  for (const source of cases) {
    assert.notEqual(source, currentMainSource);
    new vm.Script(source);
    const result = captureWarns(() => applyDockIconMainPatch(source));
    assert.ok(result.value === source, `Expected unchanged refusal for corruption ${cases.indexOf(source)}`);
    assert.ok(result.warnings.length > 0);
  }
});

test("the service's live final return rejects earlier owned completion and retains nested callable/data returns", () => {
  const patched = applyDockIconMainPatch(currentMainSource);
  function insert(source, text) {
    const head = /eO=function\(\{[^{}()]*\}\)\{/u.exec(source);
    assert.ok(head);
    const at = head.index + head[0].length;
    return source.slice(0, at) + text + source.slice(at);
  }
  for (const contribution of ['return null;', '{return null;}', 'if(true)return null;', 'throw Error("inert");', '{throw Error("inert");}']) {
    for (const source of [currentMainSource, patched]) {
      const invalid = insert(source, contribution);
      new vm.Script(invalid);
      const result = captureWarns(() => applyDockIconMainPatch(invalid));
      assert.ok(result.value === invalid, `Expected unchanged refusal for ${contribution}`);
      assert.ok(result.warnings.length > 0);
    }
  }
  for (const contribution of ['const inertNote="return null;throw Error()";', 'function inertNested(){return null;}',
    'const inertArrow=()=>{return null;};', 'const inertMethod={read(){return null;}};', 'function inertThrow(){throw Error("inert");}']) {
    const valid = insert(currentMainSource, contribution), result = captureWarns(() => applyDockIconMainPatch(valid));
    assert.ok(result.value !== valid, `Expected native service acceptance for ${contribution}`);
    assert.deepEqual(result.warnings, []);
    assert.equal(applyDockIconMainPatch(result.value), result.value);
  }
});

function mainApp(t, extra = {}, synthetic = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dock-main-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite/build"); fs.mkdirSync(build, { recursive: true });
  const files = { "early-bootstrap.js": "const inertEntry=true;", ...(synthetic ? { "early-bootstrap-747-abcd.js": currentMainSource } : {}), ...extra };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(build, name), text);
  return { root, build, files };
}
function mainReport(root, options = {}, enabled = true) {
  const report = createPatchReport();
  const [descriptor] = normalizePatchDescriptors([descriptors[0]]);
  applyExtractedAppPatchDescriptors(root, [descriptor], {
    ...options, feature: { settings: { tweaks: { appearance: { dockIcon: { enabled } } } } },
  }, report, "extracted-app:pre-webview");
  return report.patches[0];
}

test("normal Dock main descriptor is atomic over its physical factory cohort and canonical on repeat", t => {
  const { root, build } = mainApp(t);
  assert.equal(mainReport(root).status, "applied");
  const applied = fs.readFileSync(path.join(build, "early-bootstrap-747-abcd.js"), "utf8");
  assert.equal(applied, applyDockIconMainPatch(currentMainSource));
  assert.equal(mainReport(root).status, "already-applied");
  assert.equal(fs.readFileSync(path.join(build, "early-bootstrap.js"), "utf8"), "const inertEntry=true;");
  for (const extra of [currentMainSource, 'exports.ids=[3],exports.modules={14630(a,b,c){return false}};', 'function codexLinuxApplyDockIcon(){}',
    'exports.ids=[999],exports.modules={14630:function*(){}};', 'const broken=;']) {
    const invalid = mainApp(t, { "early-bootstrap-999-abcd.js": extra });
    let writes = 0;
    assert.equal(mainReport(invalid.root, { writeFileSync() { writes++; throw Error("unexpected write"); } }).status, "skipped-optional");
    assert.equal(writes, 0);
    for (const [name, text] of Object.entries(invalid.files)) assert.equal(fs.readFileSync(path.join(invalid.build, name), "utf8"), text);
  }
});

test("Dock main write interruption restores all source and disabled mode performs no discovery", t => {
  assert.equal(mainReport("/inert/nonexistent/no-discovery", {}, false).status, "skipped-disabled");
  const { root, build, files } = mainApp(t); let writes = 0;
  assert.equal(mainReport(root, { writeFileSync(file, data, ...args) {
    fs.writeFileSync(file, data, ...args);
    if (++writes === 1) throw Error("inert partial write");
  } }).status, "skipped-optional");
  assert.ok(writes > 0);
  for (const [name, text] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(build, name), "utf8"), text);
  assert.equal(mainReport(root).status, "applied");
});

test("the normal main descriptor qualifies the complete signed inventory and preserves original inputs", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, t => {
  const { findMainProcessChunks } = require("../../scripts/patches/lib/assets.js");
  const inventory = findMainProcessChunks(process.env.CODEX_SIGNED_EXTRACTED_APP);
  assert.ok(inventory);
  const sourceFiles = Object.fromEntries(inventory.chunks.map(name => [name,
    fs.readFileSync(path.join(inventory.buildDir, name), "utf8")]));
  const hashes = Object.fromEntries(Object.entries(sourceFiles).map(([name, source]) =>
    [name, crypto.createHash("sha256").update(source).digest("hex")]));
  const { root, build } = mainApp(t, sourceFiles, false);
  assert.equal(mainReport(root).status, "applied");
  const changed = inventory.chunks.filter(name => fs.readFileSync(path.join(build, name), "utf8") !== sourceFiles[name]);
  assert.equal(changed.length, 1);
  const [owner] = changed, output = fs.readFileSync(path.join(build, owner), "utf8");
  new vm.Script(output);
  assert.equal(nativeMacObserver(output), nativeMacObserver(sourceFiles[owner]));
  const runtime = linuxIconRuntime(output);
  assert.equal(runtime.images.at(-1), "icon-codex-dark-color.png");
  runtime.dark(false);
  assert.equal(runtime.images.at(-1), "icon-codex-light.png");
  assert.equal(mainReport(root).status, "already-applied");
  const { mainProcessFactories } = require("../../scripts/patches/lib/main-process-factories.js");
  const factories = mainProcessFactories(output).filter(factory => factory.body.includes("function codexLinuxApplyDockIcon("));
  assert.equal(factories.length, 1);
  fs.writeFileSync(path.join(build, "early-bootstrap-999-abcd.js"),
    `exports.ids=[999],exports.modules={${JSON.stringify(factories[0].identity)}(a,b,c){return false}};`);
  let writes = 0;
  assert.equal(mainReport(root, { writeFileSync() { writes++; throw Error("unexpected write"); } }).status, "skipped-optional");
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(path.join(build, owner), "utf8"), output);
  for (const [name, expected] of Object.entries(hashes)) assert.equal(
    crypto.createHash("sha256").update(fs.readFileSync(path.join(inventory.buildDir, name))).digest("hex"), expected,
  );
});

test("main and settings repairs apply to unique semantic anchors in the signed bundle", {
  skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null,
}, () => {
  const extractedApp = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const buildDir = path.join(extractedApp, ".vite", "build");
  const mainCandidates = fs.readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => ({
      name: entry.name,
      source: fs.readFileSync(path.join(buildDir, entry.name), "utf8"),
    }))
    .filter(({ source }) =>
      source.includes("DOCK_ICON_PREFERENCE")
      && source.includes("dockIconPreviews:")
      && source.includes("CODEX_ELECTRON_DEV_DOCK_ICONS_PATH"),
    );
  assert.equal(
    mainCandidates.length,
    1,
    `expected one signed main-process Dock contract, found ${mainCandidates.map(({ name }) => name).join(", ")}`,
  );
  const mainPatched = applyDockIconMainPatch(mainCandidates[0].source);
  assert.notEqual(mainPatched, mainCandidates[0].source);
  assert.equal(applyDockIconMainPatch(mainPatched), mainPatched);
  assert.match(mainPatched, /function codexLinuxDockIconResourcePath/);
  assert.match(mainPatched, /function codexLinuxApplyDockIcon/);

  const { root, install, result } = runStage();
  try {
    assert.equal(result.status, 0, result.stderr);
    const payload = path.join(install, "resources", "dock-icon");
    const previews = evaluateLinuxPreviews(mainPatched, payload);
    assert.notEqual(previews, null);
    assert.equal(evaluateLinuxPreviews(mainPatched, payload, false), null);
    assert.equal(previews.appDefault, "official-icon");
    assert.equal(previews.codexDark, previews.spaceDark);
    assert.equal(previews.codexLight, previews.spaceLight);
    const resourceName = evaluateLinuxRuntimeResourceNames(mainPatched);
    assert.equal(resourceName("space-system", false), "icon-codex-light.png");
    assert.equal(resourceName("space-system", true), "icon-codex-dark-color.png");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const settingsDescriptor = descriptors.find((descriptor) =>
    descriptor.id.endsWith("settings-row"),
  );
  const assetsDir = path.join(extractedApp, "webview", "assets");
  const settingsCandidates = findWebviewAssetsContaining(extractedApp, settingsDescriptor.assetNeedles)
    .map((name) => ({ name, source: fs.readFileSync(path.join(assetsDir, name), "utf8") }));
  assert.ok(settingsCandidates.length >= 1, "expected at least one signed Dock settings gate chunk");
  for (const { name, source } of settingsCandidates) {
    const settingsPatched = applyDockIconSettingsPatch(source);
    assert.notEqual(settingsPatched, source, `expected one signed Dock settings contract in ${name}`);
    assert.match(settingsPatched, /return"macOS"!==([A-Za-z_$][\w$]*)&&"linux"!==\1\|\|/);
    assert.equal(applyDockIconSettingsPatch(settingsPatched), settingsPatched);
  }
});

test("settings patch exposes the official row on Linux across minified aliases", () => {
  const patched = applyDockIconSettingsPatch(currentSettingsSource);
  assert.match(
    patched,
    /\{platform:e,dockIconPreviews:t,buildFlavor:a="prod"\}\)\{return"macOS"!==e&&"linux"!==e\|\|a===s\.x1u\.Agent\?null:t\}/,
  );
  assert.equal(applyDockIconSettingsPatch(patched), patched);
  assert.equal(patched.replace('&&"linux"!==e', ""), currentSettingsSource);

  const aliases = currentSettingsSource
    .replace("{platform:e,", "{platform:p,")
    .replace('"macOS"!==e', '"macOS"!==p')
    .replace("dockIconPreviews:t,", "dockIconPreviews:previews,")
    .replace("?null:t}", "?null:previews}")
    .replace('buildFlavor:a="prod"', 'buildFlavor:flavor="prod"')
    .replace("a===s.x1u.Agent", "flavor===flavors.Agent");
  assert.match(applyDockIconSettingsPatch(aliases), /return"macOS"!==p&&"linux"!==p\|\|flavor===flavors\.Agent\?null:previews\}/);
});

test("settings drift, duplicates, and mixed contracts remain byte-identical", () => {
  const patched = applyDockIconSettingsPatch(currentSettingsSource);
  for (const source of [
    currentSettingsSource.replace("dockIconPreviews:t,", "dockIconPreviewsDrift:t,"),
    currentSettingsSource.replace('"macOS"!==e', '"macOS"!==t'),
    currentSettingsSource.replace("?null:t}", "?null:e}"),
    currentSettingsSource.replace("buildFlavor:a=\"prod\"", "buildFlavor:a"),
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
    fs.mkdirSync(path.join(assets, "async"), { recursive: true });
    const copies = ["async/572868.36a6c86221.js", "async/968499.fa029184f4.js"];
    for (const copy of copies) fs.writeFileSync(path.join(assets, copy), currentSettingsSource);
    // Consumers of the gate without the gate module itself are not candidates.
    fs.writeFileSync(
      path.join(assets, "async", "24191.7b05d5cf83.js"),
      'export const __webpack_modules__={x(e,t,a){let n=(0,a("IKhT")._)({platform:e,dockIconPreviews:null})}};',
    );
    const settingsDescriptor = descriptors.find((descriptor) =>
      descriptor.id.endsWith("settings-row"),
    );
    assert.equal(settingsDescriptor.assetMatch, undefined);
    assert.equal(settingsDescriptor.pattern ?? settingsDescriptor.assetPattern, undefined);
    const candidates = findWebviewAssetsContaining(root, settingsDescriptor.assetNeedles);
    assert.deepEqual(candidates, copies);
    const result = patchAssetFiles(
      root,
      null,
      settingsDescriptor.apply,
      settingsDescriptor.missingDescription,
      candidates,
    );
    assert.equal(result.matched, 2);
    assert.equal(result.changed, 2);
    for (const copy of copies) {
      assert.match(fs.readFileSync(path.join(assets, copy), "utf8"), /&&"linux"!==e\|\|/);
    }
    const again = patchAssetFiles(root, null, settingsDescriptor.apply, "missing", candidates);
    assert.equal(again.changed, 0);
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

    // flock's child holds the lock until its stdin closes or 7 s pass. The
    // test closes stdin, and so does the test process dying.
    holder = childProcess.spawn("flock", [applicationsDir, "bash", "-c", "printf locked; read -r -t 7 _"], {
      stdio: ["pipe", "pipe", "ignore"],
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
    holder?.stdin?.end();
    holder?.kill();
    sync?.kill();
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
});

test("AppImage synchronization writes persistent launch commands for the app and New Window", () => {
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
    assert.ok(managed.includes(`Exec="${desktopAppImage}" --codex-community-new-window\n`));
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


test("anonymous Dock settings export retains platform, build flavor and preview behavior", () => {
  // Current Rspack publishes this function directly in the third export map.
  const inline = 'export const __rspack_esm_ids=[7];export const __webpack_modules__={' +
    'Gate(module,exports,load){var flavors=load("flavor-values");load.d(exports,{},{_:function({platform:platform,dockIconPreviews:previews,buildFlavor:flavor="prod"}){return"macOS"!==platform||flavor===flavors.Agent?null:previews}})}};';
  const patched = applyDockIconSettingsPatch(inline);
  assert.notEqual(patched, inline);
  assert.equal(patched.replace('&&"linux"!==platform', ""), inline);
  assert.equal(applyDockIconSettingsPatch(patched), patched);
  const start = patched.indexOf("function("), open = patched.indexOf("{return", start), close = findMatchingBrace(patched, open);
  assert(close > open);
  const row = vm.runInNewContext(`(${patched.slice(start, close + 1)})`, { flavors: { Agent: "agent" } });
  const previews = { appDefault: "official", dark: "dark", light: "light" };
  for (const platform of ["linux", "macOS", "windows"]) {
    for (const buildFlavor of [undefined, "prod", "agent"]) {
      const actual = row({ platform, dockIconPreviews: previews, buildFlavor });
      const expected = platform !== "windows" && buildFlavor !== "agent" ? previews : null;
      assert.equal(actual, expected, `${platform}/${buildFlavor ?? "default"}`);
    }
  }
  const duplicate = captureWarns(() => applyDockIconSettingsPatch(inline + inline));
  assert.equal(duplicate.value, inline + inline);
  assert.match(duplicate.warnings.join(" "), /current Dock icon settings contract/);
});


test("Dock native namespace aliases include spread values and leave ambient Node globals uncaptured", () => {
  const aliases = { eZ: "nativeElectron", eJ: "nativePaths", re: "nativeFileSystem", EH: "nativeThemes", EU: "nativeDefaultIcon", tk: "nativeBuildFlavors", e0: "nativePreferences" };
  const lexical = require("../../scripts/patches/lib/minified-js.js").createJavaScriptLexicalIndex(currentMainSource);
  const renamed = currentMainSource.replace(/[A-Za-z_$][\w$]*/gu, (name, at) => lexical.isCode(at) && Object.hasOwn(aliases, name) ? aliases[name] : name);
  const result = captureWarns(() => applyDockIconMainPatch(renamed));
  assert.notEqual(result.value, renamed);assert.deepEqual(result.warnings, []);
  assert.equal(applyDockIconMainPatch(result.value), result.value);
  for (const source of [
    currentMainSource.replace("14630(e,t,r){", "14630(e,t,r){let require=foreign;"),
    currentMainSource.replace("let nativeStartup=e,", "let require=foreign;let nativeStartup=e,"),
    currentMainSource.replace("runMainAppStartup(e){", "runMainAppStartup(require){"),
  ]) {
    assert.notEqual(source, currentMainSource);
    const refused = captureWarns(() => applyDockIconMainPatch(source));
    assert.equal(refused.value, source);assert.ok(refused.warnings.length > 0);
  }
});
