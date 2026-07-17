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
  applyLinuxAppshotSettingsHotkeyPatch,
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
  return [
    "import{c as e,l as t,t as n}from\"./app-scope.js\";",
    "import{v as r}from\"./app-server-manager-signals.js\";",
    "import{f as i}from\"./statsig.js\";",
    "import{n as a}from\"./platform.js\";",
    "import{c as o}from\"./config-queries.js\";",
    "var s=t(n,(e,{get:t})=>{if(t(a)!==`macOS`||!t(i,`1304276663`))return!1;let{data:n}=t(o,{hostId:e});return n!=null&&n.requirements?.allowAppshots!==!1}),c=e(n,({get:e})=>e(s,e(r)));export{s as n,c as t};",
  ].join("");
}

function appshotMainProcessBundleFixture() {
  return [
    "var FO=new Map;",
    "function HO(e,t){let n=FO.get(e);n!=null&&(n.windowManager.sendInlineMessageForView(n.origin,{requestId:e,type:`computer-use-capture-updated`,update:t}),done(e,n))}",
    "\"computer-use-frontmost-window\":async()=>process.platform===`darwin`?Xo():null,",
    "\"computer-use-start-capture\":async({animationDestination:e,bundleIdentifier:t,origin:n,requestId:r})=>{if(process.platform!==`darwin`||this.requestComputerUseCaptureWorker==null||this.subscribeComputerUseCaptureWorkerEvent==null)return null;let i=GO({backgroundColor:e.backgroundColor,cornerRadius:e.cornerRadius,primaryTextColor:e.primaryTextColor,viewportFrame:e.viewportFrame,webContents:n});return i==null?null:VO({animationTarget:i,bundleIdentifier:t,origin:n,requestComputerUseCaptureWorker:this.requestComputerUseCaptureWorker,requestId:r,subscribeComputerUseCaptureWorkerEvent:this.subscribeComputerUseCaptureWorkerEvent,windowManager:this.windowManager})}",
  ].join("");
}

function currentAppshotHotkeyMainBundleFixture() {
  return [
    "var R8=`DoubleCommand`;",
    "var Yk=new Set([`cmdorctrl`,`command`,`cmd`,`control`,`ctrl`,`alt`,`option`]),Jk=new Set([...Yk,`shift`]);",
    "function Lk(e,t=process.platform){return t===`darwin`&&zk(e)!=null}",
    "function Mk(e,t,n=`press`){if(process.platform!==`darwin`)return null;let r=zk(e);return r==null?null:Nk(r,t,n)}",
    "function nA(e,t=process.platform){let n=Gk(e);if(Lk(e,t))return null;if(n.some(wE))return n.length===1?t===`darwin`?Lk(e,t)?null:`This shortcut key is not supported.`:`Choose a shortcut with Ctrl or Alt plus another key.`:`Use Ctrl, Alt, or Command when combining with another key.`;return null}",
    "var B8=class{configuredHotkey;registration=null;constructor(e){this.enabled=!0;let a=e.getStored(`appshotHotkey`);this.configuredHotkey=a===void 0?R8:a}getState(){return{supported:this.enabled&&process.platform===`darwin`,configuredHotkey:this.configuredHotkey,isActive:this.registration!=null}}setHotkey(e){if(!this.enabled||process.platform!==`darwin`)return{success:!1,error:`Not supported.`,state:this.getState()};return{success:!0,state:this.getState()}}reconcile(){if(this.registration?.unregister(),this.registration=null,!this.enabled||process.platform!==`darwin`||this.configuredHotkey==null)return null;return Mk(this.configuredHotkey,()=>{})}};",
    "globalThis.AppshotHotkeys=B8;",
  ].join("");
}

function currentAppshotSettingsBundleFixture() {
  return [
    "var J,Y,X,Se=e((()=>{J=[`appshot-hotkey-state`],Y=o(M,()=>({queryKey:J,queryFn:async()=>{let e=C.appshotHotkeys;return e==null?{supported:!1,configuredHotkey:null,isActive:!1}:e.getState()},staleTime:k.ONE_MINUTE})),X=[{hotkey:`DoubleCommand`,label:`⌘ + ⌘`},{hotkey:`DoubleOption`,label:`⌥ + ⌥`},{hotkey:`DoubleShift`,label:`⇧ + ⇧`}]}));",
    "function Te(){let e=(0,Q.c)(41),o=A(Y),i=null,a=()=>{},d=async()=>{},f=o?.configuredHotkey??null,p;e[6]===f?p=e[7]:(p=X.find(e=>e.hotkey===f)??null,e[6]=f,e[7]=p);let m=p,O;e[20]!==d||e[21]!==f||e[22]!==m?.hotkey?(O=X.map(e=>item({selected:e.hotkey===m?.hotkey,onSelect:()=>d(e.hotkey),children:e.label})),e[20]=d,e[21]=f,e[22]=m?.hotkey,e[23]=O):O=e[23];return O}",
  ].join("");
}

function currentAppshotSettingsRuntimeFixture() {
  return [
    "var J,Y,X,Se=(()=>{J=[],Y={},X=[{hotkey:`DoubleCommand`,label:`Command`},{hotkey:`DoubleOption`,label:`Option`},{hotkey:`DoubleShift`,label:`Shift`}]})();",
    "let o={configuredHotkey:`DoubleOption`,linuxWayland:!1};",
    "function render(){let f=o?.configuredHotkey??null;return{selected:X.find(e=>e.hotkey===f)??null,labels:X.map(e=>e.label)}}",
    "function unrelated(){return AX.find(e=>e)+AX.map(e=>e)}",
    "function propertyAccess(){return obj.X.find(e=>e)+obj.X.map(e=>e)}",
    "globalThis.result=render();",
    "\n//# sourceMappingURL=fixture.js.map",
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

    assert.equal(loaded.length, 4);
    assert.deepEqual(
      loaded.map((descriptor) => descriptor.id).sort(),
      [
        "feature:appshots:linux-appshots-availability",
        "feature:appshots:linux-appshots-hotkey",
        "feature:appshots:linux-appshots-main-process",
        "feature:appshots:linux-appshots-settings-hotkey",
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
  assert.equal(descriptors.length, 4);
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
    descriptor.pattern.test(
      "app-initial~app-main~settings-command-menu-section-items~new-thread-panel-page~settings-pag~unq8yzli-twtaboLE.js",
    ),
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
    /if\(t\(a\)!==`linux`&&\(t\(a\)!==`macOS`\|\|!t\(i,`1304276663`\)\)\)return!1;/,
  );
  assert.match(patched, /requirements\?\.allowAppshots!==!1/);
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
    /process\.platform===`linux`\?codexLinuxAppshotFrontmostWindow\(\):process\.platform===`darwin`\?Xo\(\):null/,
  );
  assert.match(
    patched,
    /if\(process\.platform===`linux`\)return codexLinuxAppshotStartCapture\(\{origin:n,requestId:r,bundleIdentifier:t,windowManager:this\.windowManager\}\);/,
  );
  assert.match(patched, /function codexLinuxAppshotBackendPath/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`windows`\],5000\)/);
  assert.match(patched, /codexLinuxAppshotBackendJson\(\[`state`,e\],10000\)/);
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
  assert.match(patched, /type:`metadata`,app:\{bundleIdentifier:a\.bundleIdentifier/);
  assert.match(patched, /type:`axText`,text:s/);
  assert.match(patched, /type:`screenshot`,screenshotDataURL:c\.dataURL/);
  assert.match(patched, /type:`completed`,transitionSnapshotDataURL:c\.dataURL/);
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
    /this\.configuredHotkey=a===void 0\?\(process\.platform===`linux`\?null:R8\):a/,
  );
  assert.match(
    patched,
    /supported:this\.enabled&&\(process\.platform===`darwin`\|\|process\.platform===`linux`\),configuredHotkey:this\.configuredHotkey,isActive:this\.registration!=null,linuxWayland:codexLinuxAppshotIsWayland\(\)/,
  );
  assert.match(
    patched,
    /if\(!this\.enabled\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\)return\{success:!1,error:`Not supported\.`,state:this\.getState\(\)\}/,
  );
  assert.match(
    patched,
    /!this\.enabled\|\|process\.platform!==`darwin`&&process\.platform!==`linux`\|\|this\.configuredHotkey==null/,
  );
  assert.match(
    patched,
    /return n\.length===1\?\(t===`darwin`\|\|t===`linux`\)\?Lk\(e,t\)\?null:`This shortcut key is not supported\.`/,
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
  const fullyPatched = applyLinuxAppshotHotkeyPatch(currentAppshotHotkeyMainBundleFixture());
  const partial = fullyPatched.replace(
    "if(!this.enabled||process.platform!==`darwin`&&process.platform!==`linux`)return{success:!1,error:`Not supported.`,state:this.getState()}",
    "if(!this.enabled||process.platform!==`darwin`)return{success:!1,error:`Not supported.`,state:this.getState()}",
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

test("shows Linux AppShots accelerator choices in current settings chunk", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotSettingsHotkeyPatch,
    currentAppshotSettingsBundleFixture(),
  );

  assert.match(patched, /function codexLinuxAppshotHotkeyOptions\(e\)/);
  assert.match(
    patched,
    /codexLinuxAppshotHotkeyOptions\(o\)\.find\(e=>e\.hotkey===f\)/,
  );
  assert.match(patched, /codexLinuxAppshotHotkeyOptions\(o\)\.map/);
  assert.doesNotMatch(patched, /\bX\.find\(/);
  assert.doesNotMatch(patched, /\bX\.map\(/);
  assert.match(patched, /hotkey:`DoubleOption`,label:`Alt \+ Alt`/);
  assert.match(patched, /hotkey:`Ctrl\+Super\+A`,label:`Ctrl \+ Super \+ A`/);
});

test("current AppShots settings helper is declared in strict module scope", () => {
  const patched = applyPatchTwice(
    applyLinuxAppshotSettingsHotkeyPatch,
    currentAppshotSettingsRuntimeFixture(),
  );
  const context = {
    globalThis: {},
    navigator: { userAgent: "Linux" },
  };

  vm.runInNewContext(`"use strict";${patched}`, context);

  assert.equal(context.globalThis.result.selected.hotkey, "DoubleOption");
  assert.deepEqual(
    Array.from(context.globalThis.result.labels),
    ["Alt + Alt", "Shift + Shift", "Ctrl + Super + A"],
  );
  assert.doesNotMatch(patched, /,codexLinuxAppshotHotkeyOptions=/);
  assert.match(patched, /AX\.find\(e=>e\)\+AX\.map\(e=>e\)/);
  assert.match(patched, /obj\.X\.find\(e=>e\)\+obj\.X\.map\(e=>e\)/);
  assert.ok(
    patched.indexOf("function codexLinuxAppshotHotkeyOptions") <
      patched.indexOf("//# sourceMappingURL=fixture.js.map"),
  );
  assert.ok(patched.endsWith("//# sourceMappingURL=fixture.js.map"));
});

test("AppShots settings patch fails closed when one option call site drifts", () => {
  const source = currentAppshotSettingsRuntimeFixture().replace("X.map(", "Array.from(X).map(");

  assert.deepEqual(captureWarnings(() => {
    assert.equal(applyLinuxAppshotSettingsHotkeyPatch(source), source);
  }), [
    "WARN: Could not find both AppShots settings hotkey option call sites - skipping Linux AppShots settings patch",
  ]);
});
