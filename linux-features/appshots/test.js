#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  applyLinuxAppshotAvailabilityPatch,
  applyLinuxAppshotHotkeyPatch,
  applyLinuxAppshotMainProcessPatch,
  descriptors,
} = require("./patch.js");

function applyPatchTwice(patchFn, source) {
  const once = patchFn(source);
  assert.notEqual(once, source);
  assert.equal(patchFn(once), once);
  return once;
}

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

function appshotAvailabilityAtomBundleFixture() {
  return "function Zmr(e,t){return e===`macOS`||e===`windows`&&t!=null&&mu.isInternal(t)};let appshot=Zmr(platform,flavor)";
}

function appshotMainProcessBundleFixture() {
  return [
    "var FO=new Map;",
    "function HO(e,t){let n=FO.get(e);n!=null&&(n.windowManager.sendInlineMessageForView(n.origin,{requestId:e,type:`computer-use-capture-updated`,update:t}),done(e,n))}",
    "\"computer-use-frontmost-window\":async({origin:e,signal:t})=>process.platform===`win32`?bridge(e,t):process.platform===`darwin`?Xo():null,",
    "\"computer-use-start-capture\":async({animationDestination:e,animationPresentationStyle:s,bundleIdentifier:t,origin:n,requestId:r,signal:i})=>{if(process.platform!==`darwin`&&process.platform!==`win32`)return null;let a=GO({backgroundColor:e.backgroundColor,webContents:n});return a}",
  ].join("");
}

function currentAppshotHotkeyMainBundleFixture() {
  return [
    "var R8=`DoubleCommand`,T8=`DoubleAlt`;",
    "var Yk=new Set([`cmdorctrl`,`command`,`cmd`,`control`,`ctrl`,`alt`,`option`]),Jk=new Set([...Yk,`shift`]);",
    "function Lk(e,t=process.platform){return t===`darwin`&&zk(e)!=null}",
    "function Mk(e,t,n=`press`){if(process.platform!==`darwin`)return null;let r=zk(e);return r==null?null:Nk(r,t,n)}",
    "var B8=class{configuredHotkey;registration=null;windowsCaptureNativeBridgeFailed=!1;constructor(e){this.enabled=!0,this.windowsCaptureNativeBridge=null;let a=e.getStored(`appshotHotkey`);a===void 0?this.configuredHotkey=process.platform===`win32`?T8:R8:this.configuredHotkey=a}getState(){return{supported:this.enabled&&(process.platform===`darwin`||process.platform===`win32`&&this.windowsCaptureNativeBridge!=null&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:this.registration!=null}}};",
    "globalThis.AppshotHotkeys=B8;",
  ].join("");
}

test("appshots stays disabled until listed in features.json", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-feature-"));
  const configPath = path.join(tempDir, "features.json");
  const featuresRoot = path.resolve(__dirname, "..");
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;

  try {
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    fs.writeFileSync(configPath, '{"enabled":[]}\n');
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);

    fs.writeFileSync(configPath, '{"enabled":["appshots"]}\n');
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });

    assert.equal(loaded.length, 3);
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id).sort(),
      [
        "feature:appshots:linux-appshots-availability",
        "feature:appshots:linux-appshots-hotkey",
        "feature:appshots:linux-appshots-main-process",
      ].sort(),
    );
    assert.ok(loaded.every((descriptor) => descriptor.ciPolicy === "optional"));
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("appshots feature descriptors are optional", () => {
  assert.equal(descriptors.length, 3);
  assert.ok(descriptors.every((descriptor) => descriptor.ciPolicy == null));
});

test("appshots availability descriptor matches the current bundle", () => {
  const descriptor = descriptors.find(
    (descriptor) => descriptor.id === "linux-appshots-availability",
  );

  assert.equal(descriptor.pattern.test("appshot-availability-BoK-Z77O.js"), false);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~page-CMpPiY3-.js",
    ),
    false,
  );
  assert.ok(
    descriptor.pattern.test("app-initial-BTphDPeq.js"),
  );
});

test("stages the Linux bare modifier monitor helper and Wayland portal hook", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"));
  const helperSource = fs.readFileSync(
    path.join(__dirname, "bin", "bare-modifier-monitor"),
    "utf8",
  );
  const electronArgsSource = fs.readFileSync(path.join(__dirname, "electron-args"), "utf8");

  assert.deepEqual(manifest.resources, [
    {
      source: "bin/bare-modifier-monitor",
      target: "resources/native/bare-modifier-monitor",
      mode: "0755",
    },
  ]);
  assert.deepEqual(manifest.runtimeHooks, {
    electronArgs: {
      source: "electron-args",
      name: "electron-args",
      mode: "0644",
    },
  });
  assert.equal(electronArgsSource.trim(), "--enable-features=GlobalShortcutsPortal");
  assert.match(helperSource, /xinput test-xi2 --root/);
  assert.match(helperSource, /stdbuf -oL/);
  assert.doesNotMatch(helperSource, /\bmktemp\s+-u\b/);
  assert.doesNotMatch(helperSource, /xinput list --short/);
  assert.doesNotMatch(helperSource, /xinput test "\$device_id"/);
  assert.doesNotMatch(helperSource, /mkfifo/);
  assert.match(helperSource, /parent_pid="\$PPID"/);
  assert.match(helperSource, /kill -0 "\$parent_pid"/);
  assert.match(helperSource, /read -r -t 1 -u "\$event_fd" line/);
  assert.match(helperSource, /kill "\$monitor_pid"/);
  assert.match(helperSource, /doublealt\|doubleoption\|alt\+alt/);
  assert.match(helperSource, /doubleshift\|shift\+shift\|leftshift\+rightshift/);
  assert.match(helperSource, /Shift_L Shift_R/);
  assert.match(helperSource, /last_tap_code=""/);
  assert.match(helperSource, /\[ "\$code" != "\$last_tap_code" \]/);
  assert.match(helperSource, /date \+%s%N/);
  assert.match(helperSource, /10#\$epoch_nanoseconds \/ 1000000/);
  assert.doesNotMatch(helperSource, /date \+%s%3N/);
  assert.doesNotMatch(helperSource, /while IFS= read -r pending code/);
  execFileSync("bash", ["-n", path.join(__dirname, "bin", "bare-modifier-monitor")]);
});

test("bare modifier monitor emits one transition from one XInput2 stream", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-"));
  const binDir = path.join(tempDir, "bin");
  const helper = path.join(__dirname, "bin", "bare-modifier-monitor");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    [
      "#!/bin/sh",
      "[ \"$1 $2\" = \"test-xi2 --root\" ] || exit 2",
      "printf '%s\\n' \\",
      "  'EVENT type 13 (RawKeyPress)' '    detail: 50' \\",
      "  'EVENT type 14 (RawKeyRelease)' '    detail: 50' \\",
      "  'EVENT type 13 (RawKeyPress)' '    detail: 62' \\",
      "  'EVENT type 14 (RawKeyRelease)' '    detail: 62'",
      "sleep 0.25",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "date"),
    "#!/bin/sh\n[ \"$1\" = \"+%s%N\" ] || exit 2\nprintf '%s\\n' 1787195182868568236\n",
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(helper, ["--key", "DoubleShift", "--immediate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      timeout: 2_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), ["ready", "down", "up"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bare modifier monitor fails before ready when XInput2 exits during startup", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-xinput2-startup-"));
  const binDir = path.join(tempDir, "bin");
  const helper = path.join(__dirname, "bin", "bare-modifier-monitor");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "xmodmap"),
    "#!/bin/sh\nprintf '%s\\n' 'keycode 50 = Shift_L' 'keycode 62 = Shift_R'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "xinput"),
    "#!/bin/sh\n[ \"$1 $2\" = \"test-xi2 --root\" ] || exit 2\nexit 2\n",
    { mode: 0o755 },
  );

  try {
    const result = spawnSync(helper, ["--key", "DoubleShift", "--immediate"], {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPLAY: ":99",
        PATH: `${binDir}:${process.env.PATH}`,
      },
      timeout: 2_000,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(result.stdout, "permission-denied\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("enables AppShots availability atom on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotAvailabilityPatch,
    appshotAvailabilityAtomBundleFixture(),
  );

  assert.match(
    patched,
    /e===`linux`\/\*codexLinuxAppshotsPlatformAvailable\*\/\|\|e===`macOS`/,
  );
  assert.match(patched, /e===`windows`&&t!=null&&mu\.isInternal\(t\)/);
});

test("rejects the obsolete raw renderer message sender shape", () => {
  const obsolete = "var F=`codex_desktop:message-for-view`;function nS(e,t){e.send(F,t)}";
  assert.equal(applyLinuxAppshotMainProcessPatch(obsolete), obsolete);
});

test("routes AppShots capture through the self-contained Linux feature", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotMainProcessPatch,
    appshotMainProcessBundleFixture(),
  );

  assert.match(
    patched,
    /process\.platform===`linux`\?codexLinuxAppshotFrontmostWindow\(\):process\.platform===`win32`/,
  );
  assert.match(
    patched,
    /if\(process\.platform===`linux`\)return codexLinuxAppshotStartCapture\(\{origin:n,requestId:r,bundleIdentifier:t,windowManager:this\.windowManager\}\);/,
  );
  assert.match(patched, /function codexLinuxAppshotBackendPath/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`windows`\],5000\)/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`state`,e\],10000\)/);
  assert.match(patched, /function codexLinuxAppshotPreviousExternalWindow/);
  assert.match(patched, /function codexLinuxAppshotHyprlandPickerData/);
  assert.match(patched, /`hyprland-preview-share-picker`,`hyprland-share-picker`/);
  assert.match(patched, /function codexLinuxAppshotHyprlandPickerConfig/);
  assert.match(patched, /function codexLinuxAppshotHyprlandInstanceSignature/);
  assert.match(patched, /default_page: windows/);
  assert.match(patched, /GDK_BACKEND:`wayland`/);
  assert.match(patched, /XDPH_WINDOW_SHARING_LIST:n\.list/);
  assert.doesNotMatch(patched, /focusHistoryID/);
  assert.match(patched, /function codexLinuxAppshotHyprlandFocusWindow/);
  assert.match(patched, /\[`dispatch`,`hl\.dsp\.focus/);
  assert.match(patched, /\[`dispatch`,`focuswindow`,t\]/);
  assert.match(patched, /function codexLinuxAppshotPrepareWindowForCapture/);
  assert.match(patched, /let codexLinuxAppshotCaptureQueue=Promise\.resolve\(\)/);
  assert.match(patched, /codexLinuxAppshotVerifyCapturedWindow/);
  assert.match(patched, /codexLinuxAppshotRestoreWindow/);
  assert.match(
    patched,
    /e\.execFile\(`xprop`,\[`-root`,`_NET_CLIENT_LIST_STACKING`\]/,
  );
  assert.match(patched, /function codexLinuxAppshotX11Session/);
  assert.match(patched, /spectacle.*-b.*-n/);
  assert.match(patched, /programs:\[`spectacle`,`\/usr\/bin\/spectacle`\]/);
  assert.match(patched, /codexLinuxAppshotCropWithImageMagick/);
  assert.ok(
    patched.indexOf("await codexLinuxAppshotCropWithImageMagick") <
      patched.indexOf("codexLinuxAppshotCropNativeImage(o,d,s)"),
  );
  assert.match(patched, /\[linux-appshots\]/);
  assert.match(patched, /codexLinuxAppshotCropRects/);
  assert.match(patched, /codexLinuxAppshotFirstValidCrop/);
  assert.match(patched, /mkdtempSync\(i\.join\(r\.tmpdir\(\),`codex-appshot-`\)\)/);
  assert.match(patched, /chmodSync\(u,448\)/);
  assert.match(patched, /i\.join\(u,`source\.png`\)/);
  assert.match(patched, /i\.join\(u,`crop\.png`\)/);
  assert.match(patched, /rmSync\(u,\{recursive:true,force:true\}\)/);
  assert.doesNotMatch(patched, /i\.join\(r\.tmpdir\(\),`codex-appshot-\$\{/);
  assert.doesNotMatch(patched, /\[`appshot`/);
  assert.doesNotMatch(patched, /bare-modifier-monitor/);
  assert.match(
    patched,
    /function codexLinuxAppshotSend\(e,t,n,r\)\{try\{e\.sendInlineMessageForView\(t,\{requestId:n,type:`computer-use-capture-updated`,update:r\}\)\}catch\{\}\}/,
  );
  assert.doesNotMatch(
    patched,
    /codex_desktop:message-for-view/,
  );
  assert.match(patched, /transitionSnapshotHeight:140/);
  assert.match(patched, /type:`metadata`,app:\{bundleIdentifier:c\.bundleIdentifier/);
  assert.match(patched, /type:`axText`,text:l/);
  assert.match(patched, /type:`screenshot`,screenshotDataURL:u\.dataURL/);
  assert.match(patched, /type:`completed`,transitionSnapshotDataURL:u\.dataURL/);
});

test("AppShots maps an explicit Hyprland picker selection and keeps X11 stacking fallback", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const windows = [
    {
      app_id: "codex-desktop",
      focused: true,
      pid: 101,
      title: "ChatGPT",
      window_id: Number.parseInt("0x100", 16),
      wm_class: "codex-desktop",
    },
    {
      app_id: "chromium",
      focused: false,
      pid: 202,
      title: "Example - Chromium",
      window_id: Number.parseInt("0x200", 16),
      wm_class: "chromium",
    },
  ];
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  const portalWindow = {
    app_id: "Xdg-desktop-portal-gtk",
    focused: true,
    pid: 303,
    title: "Select Project Root",
    window_id: Number.parseInt("0x300", 16),
    wm_class: "Xdg-desktop-portal-gtk",
  };
  const pickerData = context.codexLinuxAppshotHyprlandPickerData([
    portalWindow,
    windows[0],
    { ...windows[1], title: "Example [HC>] - Chromium" },
    { ...windows[1], app_id: "hidden", hidden: true, window_id: 0x400 },
  ]);

  assert.equal(pickerData.windowsById.size, 1);
  assert.equal(pickerData.windowsById.get("1")?.app_id, "chromium");
  assert.equal(
    pickerData.list,
    "1[HC>]chromium[HT>]Example   - Chromium[HE>]512[HA>]",
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerSelection(
      "debug output\n[SELECTION]/window:1\n",
    ),
    "1",
  );
  assert.equal(context.codexLinuxAppshotHyprlandPickerSelection("cancelled"), null);
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerSelection(
      "[SELECTION]r/window:not-a-number\n",
    ),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandPickerData([portalWindow, windows[0]])
      .windowsById.size,
    0,
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandWindowAddress(windows[1]),
    "address:0x200",
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandWindowAddress({ window_id: "invalid" }),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotUsableBounds({
      bounds: { height: 100, width: 100, x: null, y: 0 },
    }),
    false,
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      windows,
      context.codexLinuxAppshotX11StackingCandidates(
        "_NET_CLIENT_LIST_STACKING(WINDOW): window id # 0x200, 0x100",
      ),
    )?.app_id,
    "chromium",
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      [windows[0]],
      [{ window_id: "0x100" }],
    ),
    null,
  );
  assert.equal(
    context.codexLinuxAppshotPreviousExternalWindow(
      [{ ...windows[1], hidden: true }],
      [{ window_id: "0x200" }],
    ),
    null,
  );
  context.process.env = { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" };
  assert.equal(context.codexLinuxAppshotX11Session(), true);
  context.process.env = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-1" };
  assert.equal(context.codexLinuxAppshotX11Session(), false);
});

test("AppShots keeps custom pickers argument-free and forces native Wayland backends", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const pickerPath = "/test/custom-share-picker";
  let invocation = null;
  const fakeFs = {
    ...fs,
    accessSync(target, mode) {
      assert.equal(target, pickerPath);
      assert.equal(mode, fs.constants.X_OK);
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: {
      env: {
        CODEX_LINUX_APPSHOT_PICKER: pickerPath,
        GDK_BACKEND: "x11",
        HOME: "/nonexistent",
        KEEP_ME: "yes",
        QT_QPA_PLATFORM: "xcb",
      },
      pid: 101,
      platform: "linux",
      resourcesPath: "",
    },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:os") return os;
      if (moduleName === "node:path") return path;
      if (moduleName === "node:child_process") {
        return {
          execFile(program, args, options, callback) {
            invocation = { args, options, program };
            callback(null, "[SELECTION]/window:1\n", "");
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });
  const window = {
    app_id: "org.gnome.Nautilus",
    focused: false,
    title: "Documents",
    window_id: 0x200,
    wm_class: "org.gnome.Nautilus",
  };

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  const selected = await context.codexLinuxAppshotHyprlandPickWindow([window]);

  assert.equal(selected?.app_id, window.app_id);
  assert.equal(invocation?.program, pickerPath);
  assert.deepEqual(Array.from(invocation?.args ?? []), []);
  assert.equal(invocation?.options.env.GDK_BACKEND, "wayland");
  assert.equal(invocation?.options.env.QT_QPA_PLATFORM, "wayland");
  assert.equal(invocation?.options.env.KEEP_ME, "yes");
  assert.match(invocation?.options.env.XDPH_WINDOW_SHARING_LIST ?? "", /Documents/);
});

test("AppShots overrides only the picker default page and removes the temporary config", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-picker-config-"));
  const configDir = path.join(home, ".config", "hyprland-preview-share-picker");
  const configPath = path.join(configDir, "config.yaml");
  const source = [
    'stylesheets: ["../../theme/picker.css"]',
    "default_page: outputs",
    "window:",
    "  width: 1000",
    "",
  ].join("\n");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: { HOME: home }, pid: 101, platform: "linux", resourcesPath: "" },
    require,
    setTimeout,
  });

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, source);

  try {
    vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
    const override = context.codexLinuxAppshotHyprlandPickerConfig({ preview: true });
    const args = Array.from(override.args);

    assert.equal(args[0], "--config");
    assert.equal(path.dirname(args[1]), configDir);
    assert.notEqual(args[1], configPath);
    assert.equal(fs.readFileSync(configPath, "utf8"), source);
    assert.equal(
      fs.readFileSync(args[1], "utf8"),
      source.replace("default_page: outputs", "default_page: windows"),
    );

    override.cleanup();
    assert.equal(fs.existsSync(args[1]), false);

    fs.writeFileSync(configPath, source.replace("default_page: outputs", "default_page: windows"));
    const unchanged = context.codexLinuxAppshotHyprlandPickerConfig({ preview: true });
    assert.deepEqual(Array.from(unchanged.args), []);
    assert.deepEqual(
      Array.from(context.codexLinuxAppshotHyprlandPickerConfig({ preview: false }).args),
      [],
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("AppShots resolves the live Hyprland instance when Electron did not inherit it", () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const fakeFs = {
    ...fs,
    existsSync(target) {
      return target === "/proc/111" || target === "/proc/222";
    },
    readFileSync(target) {
      if (target.endsWith("/older/hyprland.lock")) return "111\nwayland-0\n";
      if (target.endsWith("/matching/hyprland.lock")) return "222\nwayland-1\n";
      throw new Error(`Unexpected read: ${target}`);
    },
    readdirSync(target) {
      assert.equal(target, "/runtime/hypr");
      return ["older", "matching"];
    },
    statSync(target) {
      if (!target.endsWith("/.socket.sock")) throw new Error(`Unexpected stat: ${target}`);
      return {
        isSocket: () => true,
        mtimeMs: target.includes("matching") ? 10 : 20,
      };
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: {
      env: { XDG_RUNTIME_DIR: "/runtime", WAYLAND_DISPLAY: "wayland-1" },
      getuid: () => 1000,
      pid: 101,
      platform: "linux",
      resourcesPath: "",
    },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:path") return path;
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  assert.equal(context.codexLinuxAppshotHyprlandInstanceSignature(), "matching");
  assert.deepEqual(
    Array.from(context.codexLinuxAppshotHyprctlArgs(["clients", "-j"])),
    ["-i", "matching", "clients", "-j"],
  );
  assert.equal(
    context.codexLinuxAppshotHyprlandEnv().HYPRLAND_INSTANCE_SIGNATURE,
    "matching",
  );

  context.process.env.HYPRLAND_INSTANCE_SIGNATURE = "inherited";
  assert.deepEqual(
    Array.from(context.codexLinuxAppshotHyprctlArgs(["clients", "-j"])),
    ["clients", "-j"],
  );
});

test("AppShots requires a safe return target before changing Hyprland focus", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  let focusCalls = 0;
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotHyprlandFocusWindow = async () => {
    focusCalls += 1;
    return true;
  };

  await assert.rejects(
    context.codexLinuxAppshotPrepareWindowForCapture({
      backend: "hyprland",
      focusedWindow: {
        app_id: "chromium",
        bounds: { height: 800, width: 1200, x: 0, y: 0 },
        focused: false,
        window_id: 0x200,
        wm_class: "chromium",
      },
      returnWindow: null,
    }),
    /No safe ChatGPT return target/,
  );
  assert.equal(focusCalls, 0);

  const hiddenReturn = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    hidden: true,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  assert.equal(context.codexLinuxAppshotValidReturnWindow(hiddenReturn), false);
  assert.equal(
    context.codexLinuxAppshotValidReturnWindow({ ...hiddenReturn, hidden: false }),
    true,
  );
});

test("AppShots rejects changed, hidden, unfocused, or moved capture targets", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    pid: 202,
    window_id: 0x200,
    wm_class: "chromium",
  };
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });

  assert.equal(
    context.codexLinuxAppshotCaptureReadyWindow([selected], selected, "0:0:1200:800")
      ?.window_id,
    0x200,
  );
  for (const changed of [
    { ...selected, app_id: "other" },
    { ...selected, focused: false },
    { ...selected, hidden: true },
    { ...selected, bounds: { ...selected.bounds, x: 20 } },
  ]) {
    assert.equal(
      context.codexLinuxAppshotCaptureReadyWindow(
        [changed],
        selected,
        "0:0:1200:800",
      ),
      null,
    );
  }

  context.codexLinuxAppshotBackendJson = async () => ({
    backend: "hyprland",
    windows: [{ ...selected, app_id: "other" }],
  });
  await assert.rejects(
    context.codexLinuxAppshotVerifyCapturedWindow(selected, "0:0:1200:800"),
    /changed during capture/,
  );
});

test("AppShots activates a selected Hyprland window and waits for stable bounds", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const selected = {
    app_id: "chromium",
    bounds: { height: 400, width: 600, x: 900, y: 100 },
    focused: false,
    window_id: 0x200,
    wm_class: "chromium",
  };
  const refreshed = {
    ...selected,
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
  };
  const ownWindow = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: false,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  const focusCalls = [];
  let windowReports = 0;

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotHyprlandFocusWindow = async (window) => {
    focusCalls.push(window.window_id);
    return true;
  };
  context.codexLinuxAppshotBackendJson = async () => {
    windowReports += 1;
    return { backend: "hyprland", windows: [ownWindow, refreshed] };
  };
  context.codexLinuxAppshotDelay = async () => {};

  const prepared = await context.codexLinuxAppshotPrepareWindowForCapture({
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [ownWindow, selected],
  });

  assert.deepEqual(focusCalls, [0x200]);
  assert.equal(windowReports, 4);
  assert.equal(prepared.focusedWindow.window_id, 0x200);
  assert.equal(prepared.focusedWindow.focused, true);
  assert.equal(prepared.focusedWindow.bounds.width, 1200);
});

test("AppShots restores ChatGPT after successful and failed Hyprland capture", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const ownWindow = {
    app_id: "codex-desktop",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    pid: 101,
    window_id: 0x100,
    wm_class: "codex-desktop",
  };
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    title: "Example - Chromium",
    window_id: 0x200,
    wm_class: "chromium",
  };
  const report = {
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [{ ...ownWindow, focused: false }, selected],
  };
  const restoreCalls = [];
  const updates = [];
  const trace = [];

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = async () => ({
    error: null,
    nodes: [],
  });
  context.codexLinuxAppshotAccessibilityText = () => "accessibility text";
  context.codexLinuxAppshotVerifyCapturedWindow = async () => {
    trace.push("verify-captured-target");
    return selected;
  };
  context.codexLinuxAppshotScreenshot = async () => ({
    dataURL: "data:image/png;base64,AA==",
  });
  context.codexLinuxAppshotSend = (_manager, _origin, _requestId, update) => {
    updates.push(update.type);
    trace.push(`send:${update.type}`);
  };
  context.codexLinuxAppshotRestoreWindow = async (window) => {
    restoreCalls.push(window.window_id);
    trace.push(`restore:${window.window_id}`);
    return true;
  };

  await context.codexLinuxAppshotCapture({
    bundleIdentifier: "chromium",
    origin: "view",
    requestId: "success",
    windowManager: {},
  });
  assert.deepEqual(updates, ["metadata", "axText", "screenshot", "completed"]);
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, [
    "verify-captured-target",
    "restore:256",
    "send:metadata",
    "send:axText",
    "send:screenshot",
    "send:completed",
  ]);

  restoreCalls.length = 0;
  trace.length = 0;
  context.codexLinuxAppshotScreenshot = async () => {
    throw new Error("Expected capture failure");
  };
  await assert.rejects(
    context.codexLinuxAppshotCapture({
      bundleIdentifier: "chromium",
      origin: "view",
      requestId: "failure",
      windowManager: {},
    }),
    /Expected capture failure/,
  );
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, ["restore:256"]);

  updates.length = 0;
  restoreCalls.length = 0;
  trace.length = 0;
  context.codexLinuxAppshotScreenshot = async () => ({
    dataURL: "data:image/png;base64,AA==",
  });
  context.codexLinuxAppshotRestoreWindow = async (window) => {
    restoreCalls.push(window.window_id);
    trace.push(`restore-failed:${window.window_id}`);
    return false;
  };
  await assert.rejects(
    context.codexLinuxAppshotCapture({
      bundleIdentifier: "chromium",
      origin: "view",
      requestId: "restore-failure",
      windowManager: {},
    }),
    /Could not verify ChatGPT focus restoration/,
  );
  assert.deepEqual(updates, []);
  assert.deepEqual(restoreCalls, [0x100]);
  assert.deepEqual(trace, ["verify-captured-target", "restore-failed:256"]);
});

test("AppShots captures accessibility and pixels concurrently", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout,
  });
  const ownWindow = {
    app_id: "codex-desktop",
    focused: false,
    pid: 101,
    window_id: 0x100,
  };
  const selected = {
    app_id: "chromium",
    bounds: { height: 800, width: 1200, x: 0, y: 0 },
    focused: true,
    window_id: 0x200,
  };
  const report = {
    backend: "hyprland",
    focusedWindow: selected,
    returnWindow: ownWindow,
    windows: [ownWindow, selected],
  };
  let releaseAccessibility;
  let screenshotStarted = false;

  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotFocusedWindow = async () => report;
  context.codexLinuxAppshotPrepareWindowForCapture = async () => report;
  context.codexLinuxAppshotAccessibilityNodes = () =>
    new Promise((resolve) => {
      releaseAccessibility = () => resolve({ error: null, nodes: [] });
    });
  context.codexLinuxAppshotAccessibilityText = () => "";
  context.codexLinuxAppshotVerifyCapturedWindow = async () => selected;
  context.codexLinuxAppshotScreenshot = async () => {
    screenshotStarted = true;
    return { dataURL: "data:image/png;base64,AA==" };
  };
  context.codexLinuxAppshotRestoreWindow = async () => true;
  context.codexLinuxAppshotSend = () => {};

  const capture = context.codexLinuxAppshotCapture({
    bundleIdentifier: "chromium",
    origin: "view",
    requestId: "parallel",
    windowManager: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(screenshotStarted, true);
  releaseAccessibility();
  await capture;
});

test("AppShots serializes capture transactions", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const scheduled = [];
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: 101, platform: "linux", resourcesPath: "" },
    require() {
      throw new Error("No module access expected");
    },
    setTimeout(callback) {
      scheduled.push(callback);
      return scheduled.length;
    },
  });
  const started = [];
  const releases = [];
  vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
  context.codexLinuxAppshotCapture = ({ requestId }) =>
    new Promise((resolve) => {
      started.push(requestId);
      releases.push(resolve);
    });
  context.codexLinuxAppshotSend = () => {};

  context.codexLinuxAppshotStartCapture({
    bundleIdentifier: "first",
    origin: "view",
    requestId: "first",
    windowManager: {},
  });
  context.codexLinuxAppshotStartCapture({
    bundleIdentifier: "second",
    origin: "view",
    requestId: "second",
    windowManager: {},
  });
  scheduled.splice(0).forEach((callback) => callback());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first"]);

  releases.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "second"]);
  releases.shift()();
  await context.codexLinuxAppshotCaptureQueue;
});

test("AppShots capture uses and removes its private temporary directory", async () => {
  const patched = applyLinuxAppshotMainProcessPatch(appshotMainProcessBundleFixture());
  const helperStart = patched.lastIndexOf(";function codexLinuxAppshotRequire");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "appshots-private-capture-"));
  const captureDirs = [];
  const chmodModes = [];
  let failCaptures = false;

  assert.ok(helperStart >= 0);

  const fakeFs = {
    ...fs,
    mkdtempSync(prefix) {
      const captureDir = fs.mkdtempSync(prefix);
      captureDirs.push(captureDir);
      return captureDir;
    },
    chmodSync(target, mode) {
      chmodModes.push(mode);
      fs.chmodSync(target, mode);
    },
  };
  const fakeChildProcess = {
    execFile(program, args, options, callback) {
      if (failCaptures) {
        callback(new Error("Expected capture failure"), "", "expected failure");
        return;
      }
      if (program.endsWith("grim")) {
        fs.writeFileSync(args.at(-1), "source");
        callback(null, "", "");
        return;
      }
      if (program.endsWith("identify")) {
        callback(null, "100 100", "");
        return;
      }
      if (program.endsWith("convert")) {
        fs.writeFileSync(args.at(-1), "crop");
        callback(null, "", "");
        return;
      }
      callback(new Error(`Unexpected program: ${program}`), "", "unexpected program");
    },
  };
  const context = vm.createContext({
    Buffer,
    console: { warn() {} },
    process: { env: {}, pid: process.pid, platform: "linux", resourcesPath: "" },
    require(moduleName) {
      if (moduleName === "node:fs") return fakeFs;
      if (moduleName === "node:os") return { tmpdir: () => tempRoot };
      if (moduleName === "node:path") return path;
      if (moduleName === "node:child_process") return fakeChildProcess;
      if (moduleName === "electron") {
        return {
          nativeImage: {
            createFromPath: () => ({
              getSize: () => ({ width: 0, height: 0 }),
            }),
          },
        };
      }
      throw new Error(`Unexpected module: ${moduleName}`);
    },
    setTimeout,
  });

  try {
    vm.runInContext(patched.slice(helperStart), context, { timeout: 1_000 });
    const result = await context.codexLinuxAppshotScreenshot(
      { bounds: { height: 40, width: 50, x: 0, y: 0 } },
      [],
    );

    assert.equal(result?.width, 50);
    assert.equal(result?.height, 40);
    assert.match(result?.dataURL ?? "", /^data:image\/png;base64,/);
    assert.equal(captureDirs.length, 1);
    assert.equal(fs.existsSync(captureDirs[0]), false);

    failCaptures = true;
    const failedResult = await context.codexLinuxAppshotScreenshot(
      { bounds: { height: 40, width: 50, x: 0, y: 0 } },
      [],
    );

    assert.equal(failedResult, null);
    assert.ok(captureDirs.length > 1);
    assert.deepEqual(chmodModes, captureDirs.map(() => 0o700));
    assert.ok(captureDirs.every((captureDir) => !fs.existsSync(captureDir)));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("enables the current AppShots hotkey class and bare modifiers on Linux", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotHotkeyPatch,
    currentAppshotHotkeyMainBundleFixture(),
  );

  assert.match(
    patched,
    /function codexLinuxAppshotIsWayland\(\)\{return process\.platform===`linux`&&\(\(process\.env\.XDG_SESSION_TYPE\|\|``\)\.toLowerCase\(\)===`wayland`\|\|!!process\.env\.WAYLAND_DISPLAY\)\}/,
  );
  assert.match(
    patched,
    /function Lk\(e,t=process\.platform\)\{return \(t===`darwin`\|\|t===`linux`&&!codexLinuxAppshotIsWayland\(\)\)&&zk\(e\)!=null\}/,
  );
  assert.match(
    patched,
    /function Mk\(e,t,n=`press`\)\{if\(process\.platform!==`darwin`&&process\.platform!==`linux`\)return null;/,
  );
  assert.match(patched, /new Set\(\[\.\.\.Yk,`shift`,`super`,`meta`,`win`\]\)/);
  assert.match(
    patched,
    /a===void 0\?this\.configuredHotkey=process\.platform===`win32`\?T8:process\.platform===`linux`\?null:R8:this\.configuredHotkey=a/,
  );
  assert.match(
    patched,
    /supported:this\.enabled&&\(process\.platform===`linux`\|\|process\.platform===`darwin`\|\|process\.platform===`win32`&&this\.windowsCaptureNativeBridge!=null&&!this\.windowsCaptureNativeBridgeFailed\),configuredHotkey:this\.configuredHotkey,isActive:this\.registration!=null,linuxWayland:codexLinuxAppshotIsWayland\(\)/,
  );

  const context = {
    globalThis: {},
    process: { env: { XDG_SESSION_TYPE: "x11" }, platform: "linux" },
  };
  vm.runInNewContext(patched, context);
  const state = new context.globalThis.AppshotHotkeys({ getStored() {} }).getState();
  assert.equal(state.supported, true);
  assert.equal(state.configuredHotkey, null);
  assert.equal(state.linuxWayland, false);
});

test("AppShots hotkey patch fails closed when one current class shape drifts", () => {
  const source = currentAppshotHotkeyMainBundleFixture().replace(
    "new Set([...Yk,`shift`])",
    "new Set([...Yk,`shift`,`alt`])",
  );

  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyLinuxAppshotHotkeyPatch(source), source);
  }), [
    "WARN: Could not find current AppShots hotkey class - skipping Linux AppShots hotkey patch",
  ]);
});

test("AppShots hotkey patch rejects a partially patched setter", () => {
  const partial = currentAppshotHotkeyMainBundleFixture().replace(
    "this.windowsCaptureNativeBridge!=null&&!this.windowsCaptureNativeBridgeFailed",
    "this.windowsCaptureNativeBridge!=null",
  );

  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyLinuxAppshotHotkeyPatch(partial), partial);
  }), [
    "WARN: Could not find current AppShots hotkey class - skipping Linux AppShots hotkey patch",
  ]);
});

test("AppShots hotkey patch rejects duplicate current class contracts", () => {
  const source = currentAppshotHotkeyMainBundleFixture();
  const duplicate = `${source}${source}`;

  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyLinuxAppshotHotkeyPatch(duplicate), duplicate);
  }), [
    "WARN: Could not find current AppShots hotkey class - skipping Linux AppShots hotkey patch",
  ]);
});
