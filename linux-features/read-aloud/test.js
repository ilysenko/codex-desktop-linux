#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  applyAppMainRoutePatch,
  applyGeneralSettingsPatch,
  applyGeneralSettingsWrapperPatch,
  applyAssistantRenderPatch,
  applyIndexRuntimePatch,
  applyLinuxDesktopSettingsPatch,
  applyMainBundlePatch,
  applySettingsAssetPatch,
  applySettingsPageNavPatch,
  applySettingsPatch,
  applySettingsSectionsNavPatch,
  applySettingsSharedNavPatch,
  descriptors: featurePatches,
} = require("./patch.js");
const {
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  applyLinuxExternalOpenEnvPatch,
} = require("../../scripts/patches/impl/main-process/browser.js");
const { requireName } = require("../../scripts/patches/lib/minified-js.js");

function twice(fn, source) {
  const patched = fn(source);
  assert.equal(fn(patched), patched);
  return patched;
}

function captureWarnings(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function linuxDesktopSettingsFixture() {
  return 'var React={Fragment:{},Component:class{constructor(){this.state={}}setState(e){this.state={...this.state,...e}}}},$={jsx(){},jsxs(){}},KEYS={promptWindow:"codex-linux-prompt-window-enabled",systemTray:"codex-linux-system-tray-enabled",warmStart:"codex-linux-warm-start-enabled",autoUpdateOnExit:"codex-linux-auto-update-on-exit"};function codexLinuxChecked(e){return e===!0}class LinuxToggle extends React.Component{}function SettingsRow(){}function SettingsSection(){}function SettingsGroup(){}function SettingsPage(){}function Toggle(){}function LinuxBuildInfoPanel(){}function LinuxDesktopSettings(){return $.jsx(SettingsPage,{title:"Linux desktop",subtitle:"Launcher, tray, prompt window, and update behavior.",children:$.jsxs("div",{className:"flex flex-col gap-6",children:[$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Updates"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxToggle,{settingKey:KEYS.autoUpdateOnExit,label:"Install updates when you close ChatGPT",description:"When on, a ready update waits for ChatGPT to close and then installs. When off, updates wait until you click Update."})})})]}),$.jsxs(SettingsSection,{className:"gap-2",children:[$.jsx(SettingsSection.Header,{title:"Build"}),$.jsx(SettingsSection.Content,{children:$.jsx(SettingsGroup,{children:$.jsx(LinuxBuildInfoPanel,{})})})]})]})})}export{LinuxDesktopSettings,LinuxDesktopSettings as default};';
}

function createLinuxReadAloudSettings(post) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-runtime-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const asset = path.join(assets, "linux-desktop-settings-linux.js");
    fs.writeFileSync(asset, linuxDesktopSettingsFixture());
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 1 });
    const patched = fs
      .readFileSync(asset, "utf8")
      .replace(
        "export{LinuxDesktopSettings,LinuxDesktopSettings as default};",
        "globalThis.LinuxReadAloudSettings=LinuxReadAloudSettings;",
      );
    const runtime = {};
    new Function("globalThis", "__post", patched)(runtime, post);
    return new runtime.LinuxReadAloudSettings();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function settlePromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferredSettingsWrites({ writeKey, enabled = false, speed = 1.05 }) {
  const writes = [];
  const settings = createLinuxReadAloudSettings((method, { params }) => {
    if (method === "get-global-state") {
      assert.ok([
        "codex-linux-read-aloud-enabled",
        "codex-linux-read-aloud-kokoro-speed",
      ].includes(params.key));
      return Promise.resolve({
        value: params.key === "codex-linux-read-aloud-enabled" ? enabled : speed,
      });
    }
    assert.equal(method, "set-global-state");
    assert.equal(params.key, writeKey);
    const request = deferred();
    writes.push(request);
    return request.promise;
  });
  return { settings, writes };
}

test("main bundle patch adds a Linux read aloud handler", () => {
  const source = [
    "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
    "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
  ].join("");
  const patched = twice(applyMainBundlePatch, source);
  assert.match(patched, /"linux-read-aloud":async/);
  assert.match(patched, /function codexLinuxReadAloudSpeak\(input,options=\{\}\)/);
  assert.match(patched, /options\?\.requireEnabled!==!1/);
  assert.match(patched, /function codexLinuxReadAloudConfig/);
  assert.match(patched, /function codexLinuxReadAloudSetup/);
  assert.match(patched, /function codexLinuxReadAloudNativeFallbackEnabled/);
  assert.match(patched, /function codexLinuxReadAloudSetupResult/);
  assert.match(patched, /codex-linux-read-aloud-kokoro-model/);
  assert.match(patched, /codex-linux-read-aloud-kokoro-python/);
  assert.match(patched, /codex-linux-read-aloud-kokoro-speed/);
  assert.match(patched, /codex-linux-read-aloud-kokoro-voices/);
  assert.match(patched, /CODEX_LINUX_SETTINGS_FILE/);
  assert.match(patched, /CODEX_LINUX_APP_ID/);
  assert.match(patched, /CODEX_LINUX_READ_ALOUD_KOKORO_SPEED/);
  assert.match(patched, /kokoro-unavailable/);
  assert.match(patched, /piper-unavailable/);
  assert.match(patched, /not-explicit/);
  assert.match(patched, /action===`setup`/);
  assert.match(patched, /source===`button`/);
  assert.match(patched, /codexLinuxReadAloudSpeak\(e\.text,\{requireEnabled:!1\}\)/);
  assert.match(patched, /constants\.X_OK/);
  assert.match(patched, /require\(`node:child_process`\)\.spawn/);
  assert.match(patched, /kokoro-stdin/);
  assert.match(patched, /kokoro-v1\.0\.onnx/);
  assert.match(patched, /huggingface\.co\/zijuncheng\/kokoro_model_v1\.0\/resolve\/main\/kokoro-v1\.0\.onnx/);
  assert.match(patched, /huggingface\.co\/zijuncheng\/kokoro_model_v1\.0\/resolve\/main\/voices-v1\.0\.bin/);
  assert.match(patched, /download too small/);
  assert.match(patched, /User-Agent/);
  assert.doesNotMatch(patched, /readd-stdin/);
  assert.doesNotMatch(patched, /\|\|\s*`female1`/);
  assert.match(patched, /spd-say/);
  assert.match(patched, /espeak-ng/);
  // A custom voice must win, otherwise fall back by language; without the
  // parentheses any custom voice forced the Hebrew espeak voice.
  assert.match(patched, /let espeakVoice=voice\|\|\(hasHebrew\?`he`:`en-us`\);/);
  assert.doesNotThrow(() => new Function("require", "process", patched));
});

test("main handler does not capture a function-local child-process alias from another feature", () => {
  const source = [
    'function injectedFeature(){let __codexChild=require(`node:child_process`);return __codexChild}',
    'let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);',
    'var h={handlers:{"set-vs-context":async()=>{},"native-desktop-apps":async()=>({apps:[]})}};',
  ].join("");
  const patched = applyMainBundlePatch(source);

  assert.match(patched, /require\(`node:child_process`\)\.spawn\(command,args/);
  assert.doesNotMatch(patched, /let child=__codexChild\.spawn\(command,args/);
});

test("main bundle helper preserves the core Electron binding across patch reruns", () => {
  const source = [
    '"use strict";',
    'let c=require("electron"),e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);',
    'var h={handlers:{"set-vs-context":async()=>{},"native-desktop-apps":async()=>({apps:[]})}};',
  ].join("");
  const withExternalOpen = applyLinuxExternalOpenEnvPatch(source);
  const patched = applyMainBundlePatch(withExternalOpen);

  assert.equal(requireName(patched, "electron"), "c");
  assert.match(patched, /let loadElectron=\(\)=>require\(`electron`\)/);
  assert.equal(applyLinuxExternalOpenEnvPatch(patched), patched);
});

test("webview runtime appends only once", () => {
  const patched = twice(applyIndexRuntimePatch, "console.log(`index`);");
  assert.match(patched, /codexLinuxReadAloudClick/);
  assert.match(patched, /vscode:\/\/codex\/"\+METHOD/);
  assert.match(patched, /codex-message-from-view/);
  assert.match(patched, /__codexForwardedViaBridge/);
  assert.match(patched, /Starting voice/);
  assert.match(patched, /kokoro-explicit-v5/);
  assert.match(patched, /codexLinuxConversationIsSpeaking/);
  assert.match(patched, /codexLinuxConversationStopSpeaking/);
  assert.match(patched, /speechSynthesis\?\.cancel/);
  assert.match(patched, /action:"speak",source:"button",text/);
  assert.match(patched, /codexLinuxReadAloudSetup/);
  assert.match(patched, /action:"setup",mode/);
  assert.match(patched, /9e5/);
  assert.match(applyIndexRuntimePatch("globalThis.codexLinuxReadAloudClick=()=>{};"), /kokoro-explicit-v5/);
  assert.doesNotMatch(patched, /SpeechSynthesisUtterance/);
  assert.doesNotMatch(patched, /browser speech/);
  assert.doesNotMatch(patched, /no-voices/);
  assert.doesNotMatch(patched, /completed===false/);
  assert.doesNotThrow(() => new Function("window", "localStorage", patched));
});

test("kokoro stdin runner compiles and makes a bounded first streaming chunk", (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.error) {
    t.skip("python3 not available");
    return;
  }

  const runner = path.join(__dirname, "bin", "kokoro_stdin.py");
  const compile = spawnSync(
    "python3",
    [
      "-c",
      [
        "import pathlib, py_compile, sys, tempfile",
        "runner = pathlib.Path(sys.argv[1])",
        "with tempfile.NamedTemporaryFile(suffix='.pyc') as out:",
        "    py_compile.compile(str(runner), cfile=out.name, doraise=True)",
      ].join("\n"),
      runner,
    ],
    { encoding: "utf8" },
  );
  assert.equal(compile.status, 0, compile.stderr);

  const chunkCheck = spawnSync(
    "python3",
    [
      "-c",
      [
        "import importlib.util, sys",
        "sys.dont_write_bytecode = True",
        "runner = sys.argv[1]",
        "spec = importlib.util.spec_from_file_location('kokoro_stdin', runner)",
        "mod = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(mod)",
        "text = ('streamingword ' * 40).strip()",
        "chunks = mod.split_for_streaming(text)",
        "assert chunks, chunks",
        "assert len(chunks[0]) <= 50, chunks[0]",
        "assert all(len(chunk) <= 100 for chunk in chunks[1:]), chunks",
      ].join("\n"),
      runner,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_LINUX_READ_ALOUD_KOKORO_FIRST_CHARS: "50",
        CODEX_LINUX_READ_ALOUD_KOKORO_CHUNK_CHARS: "100",
      },
    },
  );
  assert.equal(chunkCheck.status, 0, chunkCheck.stderr);
});

test("kokoro stdin runner waits for first PCM before launching aplay", (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.error) {
    t.skip("python3 not available");
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-kokoro-"));
  try {
    const binDir = path.join(root, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const eventsPath = path.join(root, "events.log");
    const pcmPath = path.join(root, "audio.pcm");

    fs.writeFileSync(
      path.join(root, "kokoro_onnx.py"),
      [
        "import os",
        "import time",
        "from pathlib import Path",
        "",
        "def event(name):",
        "    with open(os.environ['KOKORO_TEST_EVENTS'], 'a', encoding='utf8') as handle:",
        "        handle.write(name + '\\n')",
        "",
        "class Kokoro:",
        "    def __init__(self, model, voices):",
        "        self.model = model",
        "        self.voices = voices",
        "",
        "    def create(self, chunk, voice, speed, lang):",
        "        event('create-start')",
        "        time.sleep(0.05)",
        "        event('create-end')",
        "        import numpy as np",
        "        return np.array([0.25, -0.25]), 24000",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(root, "numpy.py"),
      [
        "class Array:",
        "    def __init__(self, values):",
        "        self.values = values",
        "",
        "    def __mul__(self, scalar):",
        "        return Array([value * scalar for value in self.values])",
        "",
        "    def astype(self, dtype):",
        "        return self",
        "",
        "    def tobytes(self):",
        "        return b'\\x01\\x00\\xff\\xff'",
        "",
        "def array(values):",
        "    return Array(values)",
        "",
        "def clip(samples, low, high):",
        "    return samples",
      ].join("\n") + "\n",
    );

    const fakeAplay = path.join(binDir, "aplay");
    fs.writeFileSync(
      fakeAplay,
      [
        "#!/usr/bin/env python3",
        "import os",
        "import sys",
        "from pathlib import Path",
        "",
        "def event(name):",
        "    with open(os.environ['KOKORO_TEST_EVENTS'], 'a', encoding='utf8') as handle:",
        "        handle.write(name + '\\n')",
        "",
        "event('aplay-start:' + ' '.join(sys.argv[1:]))",
        "data = sys.stdin.buffer.read()",
        "Path(os.environ['KOKORO_TEST_PCM']).write_bytes(data)",
        "event('aplay-bytes:' + str(len(data)))",
      ].join("\n") + "\n",
    );
    fs.chmodSync(fakeAplay, 0o755);

    const runner = path.join(__dirname, "bin", "kokoro_stdin.py");
    const result = spawnSync("python3", [runner], {
      encoding: "utf8",
      input: "First sentence for playback. ".repeat(12),
      env: {
        ...process.env,
        CODEX_LINUX_READ_ALOUD_KOKORO_MODEL: path.join(root, "model.onnx"),
        CODEX_LINUX_READ_ALOUD_KOKORO_VOICES: path.join(root, "voices.bin"),
        KOKORO_TEST_EVENTS: eventsPath,
        KOKORO_TEST_PCM: pcmPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONPATH: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const events = fs.readFileSync(eventsPath, "utf8").trim().split("\n");
    const firstCreateEnd = events.indexOf("create-end");
    const aplayStart = events.findIndex((line) => line.startsWith("aplay-start:"));
    assert.notEqual(firstCreateEnd, -1, events);
    assert.notEqual(aplayStart, -1, events);
    assert.ok(firstCreateEnd < aplayStart, events.join("\n"));
    assert.match(events[aplayStart], /--buffer-time=500000/);
    assert.match(events[aplayStart], /--period-time=100000/);
    assert.ok(events.filter((line) => line === "create-start").length > 1, events);
    assert.ok(fs.statSync(pcmPath).size > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler stores a chosen Kokoro model folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const configHome = path.join(root, "config");
    const modelDir = path.join(root, "kokoro");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "kokoro-v1.0.onnx"), "");
    fs.writeFileSync(path.join(modelDir, "voices-v1.0.bin"), "");
    const resourcesPath = path.join(root, "resources");
    const runner = path.join(resourcesPath, "read-aloud", "kokoro-stdin");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(runner, "");
    fs.chmodSync(runner, 0o755);
    const python = path.join(root, ".local", "share", "codex-desktop", "read-aloud", "kokoro-venv", "bin", "python");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "");
    fs.chmodSync(python, 0o755);

    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    assert.doesNotMatch(patched, /\bo=o\.createWriteStream\b/);
    assert.doesNotMatch(patched, /let n=[^;]*,r=p\.join\(n,[^;]*,p=p\.join/);

    const requireStub = (name) => {
      if (name === "node:child_process") {
        return {
          spawnSync: (command, args) => ({
            status: command === "which" && args?.[0] === "aplay" ? 0 : 1,
          }),
        };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      if (name === "electron") {
        return {
          dialog: {
            showOpenDialog: async () => ({ canceled: false, filePaths: [modelDir] }),
          },
        };
      }
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root, XDG_CONFIG_HOME: configHome },
      resourcesPath,
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"choose-folder"});`,
    )(requireStub, processStub);

    assert.equal(result.ok, true);
    const settings = JSON.parse(
      fs.readFileSync(path.join(configHome, "codex-desktop", "settings.json"), "utf8"),
    );
    assert.equal(settings["codex-linux-read-aloud-kokoro-model"], path.join(modelDir, "kokoro-v1.0.onnx"));
    assert.equal(settings["codex-linux-read-aloud-kokoro-voices"], path.join(modelDir, "voices-v1.0.bin"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler reports when a chosen Kokoro model folder is not speakable yet", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const configHome = path.join(root, "config");
    const modelDir = path.join(root, "kokoro");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "kokoro-v1.0.onnx"), "");
    fs.writeFileSync(path.join(modelDir, "voices-v1.0.bin"), "");

    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 1 }) };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      if (name === "electron") {
        return {
          dialog: {
            showOpenDialog: async () => ({ canceled: false, filePaths: [modelDir] }),
          },
        };
      }
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root, XDG_CONFIG_HOME: configHome },
      resourcesPath: path.join(root, "resources"),
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"choose-folder"});`,
    )(requireStub, processStub);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "voice-unavailable");
    assert.deepEqual(result.config.kokoro.missing.sort(), ["aplay", "python", "runner"].sort());
    const settings = JSON.parse(
      fs.readFileSync(path.join(configHome, "codex-desktop", "settings.json"), "utf8"),
    );
    assert.equal(settings["codex-linux-read-aloud-kokoro-model"], path.join(modelDir, "kokoro-v1.0.onnx"));
    assert.equal(settings["codex-linux-read-aloud-kokoro-voices"], path.join(modelDir, "voices-v1.0.bin"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler honors Linux app-specific settings paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const configHome = path.join(root, "config");
    const modelDir = path.join(root, "kokoro");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "kokoro-v1.0.onnx"), "");
    fs.writeFileSync(path.join(modelDir, "voices-v1.0.bin"), "");
    const resourcesPath = path.join(root, "resources");
    const runner = path.join(resourcesPath, "read-aloud", "kokoro-stdin");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(runner, "");
    fs.chmodSync(runner, 0o755);
    const python = path.join(root, ".local", "share", "codex-desktop", "read-aloud", "kokoro-venv", "bin", "python");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "");
    fs.chmodSync(python, 0o755);

    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return {
          spawnSync: (command, args) => ({
            status: command === "which" && args?.[0] === "aplay" ? 0 : 1,
          }),
        };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      if (name === "electron") {
        return {
          dialog: {
            showOpenDialog: async () => ({ canceled: false, filePaths: [modelDir] }),
          },
        };
      }
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root, XDG_CONFIG_HOME: configHome, CODEX_LINUX_APP_ID: "codex-desktop-5" },
      resourcesPath,
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"choose-folder"});`,
    )(requireStub, processStub);

    assert.equal(result.ok, true);
    assert.equal(
      fs.existsSync(path.join(configHome, "codex-desktop-5", "settings.json")),
      true,
    );
    assert.equal(fs.existsSync(path.join(configHome, "codex-desktop", "settings.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler reports missing Python during download setup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 1 }) };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root },
      resourcesPath: path.join(root, "resources"),
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"download"});`,
    )(requireStub, processStub);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "python-unavailable");
    assert.match(result.message, /Python 3\.10-3\.13/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler reads and clamps stored Kokoro pace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const configHome = path.join(root, "config");
    const settingsDir = path.join(configHome, "codex-desktop");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({ "codex-linux-read-aloud-kokoro-speed": 9 }, null, 2),
    );

    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 1 }) };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root, XDG_CONFIG_HOME: configHome },
      resourcesPath: path.join(root, "resources"),
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"config"});`,
    )(requireStub, processStub);

    assert.equal(result.kokoro.speed, 1.4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler enables native fallback by default but allows explicit disable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 1 }) };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };

    const defaultConfig = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"config"});`,
    )(requireStub, {
      platform: "linux",
      env: { HOME: root },
      resourcesPath: path.join(root, "resources"),
    });
    const disabledConfig = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"config"});`,
    )(requireStub, {
      platform: "linux",
      env: { HOME: root, CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK: "0" },
      resourcesPath: path.join(root, "resources"),
    });

    assert.equal(defaultConfig.nativeFallback, true);
    assert.equal(disabledConfig.nativeFallback, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler treats the message button as an explicit speech request", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const spawned = [];
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return {
          spawnSync: (command, args) => ({
            status: command === "which" && args?.[0] === "spd-say" ? 0 : 1,
          }),
          spawn: (command, args, options) => {
            spawned.push({ command, args, options });
            return {
              on: () => {},
              unref: () => {},
            };
          },
        };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root },
      resourcesPath: path.join(root, "resources"),
    };

    const buttonResult = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"hello"});`,
    )(requireStub, processStub);
    assert.equal(buttonResult.spoken, true);
    assert.equal(buttonResult.engine, "spd-say");
    assert.ok(spawned.some((entry) => entry.command === "spd-say" && entry.args.includes("--")));

    const directResult = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudSpeak("hello");`,
    )(requireStub, processStub);
    assert.equal(directResult.spoken, false);
    assert.equal(directResult.reason, "disabled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler passes the configured Kokoro Python to the runner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const resourcesPath = path.join(root, "resources");
    const runner = path.join(resourcesPath, "read-aloud", "kokoro-stdin");
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(runner, "");
    fs.chmodSync(runner, 0o755);
    const python = path.join(root, "venv", "bin", "python");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "");
    fs.chmodSync(python, 0o755);
    const model = path.join(root, "kokoro", "kokoro-v1.0.onnx");
    const voices = path.join(root, "kokoro", "voices-v1.0.bin");
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, "");
    fs.writeFileSync(voices, "");

    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const spawned = [];
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return {
          spawnSync: (command, args) => ({
            status: command === "which" && args?.[0] === "aplay" ? 0 : 1,
          }),
          spawn: (command, args, options) => {
            spawned.push({ command, args, options });
            return {
              on: () => {},
              unref: () => {},
              stdin: { end: () => {} },
            };
          },
        };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"hello"});`,
    )(requireStub, {
      platform: "linux",
      env: {
        HOME: root,
        CODEX_LINUX_READ_ALOUD_ENABLED: "1",
        CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON: python,
        CODEX_LINUX_READ_ALOUD_KOKORO_MODEL: model,
        CODEX_LINUX_READ_ALOUD_KOKORO_VOICES: voices,
      },
      resourcesPath,
    });

    assert.equal(result.spoken, true);
    assert.equal(result.engine, "kokoro");
    assert.equal(spawned[0]?.command, runner);
    assert.equal(spawned[0]?.options?.env?.CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON, python);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler falls back to native speech without forcing spd-say voice type", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const spawned = [];
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return {
          spawnSync: (command, args) => ({
            status: command === "which" && args?.[0] === "spd-say" ? 0 : 1,
          }),
          spawn: (command, args, options) => {
            spawned.push({ command, args, options });
            return {
              on: () => {},
              unref: () => {},
            };
          },
        };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"hello"});`,
    )(requireStub, {
      platform: "linux",
      env: { HOME: root, CODEX_LINUX_READ_ALOUD_ENABLED: "1" },
      resourcesPath: path.join(root, "resources"),
    });

    assert.equal(result.spoken, true);
    assert.equal(result.engine, "spd-say");
    const speakCall = spawned.find((entry) => entry.command === "spd-say" && entry.args.includes("--"));
    assert.ok(speakCall);
    assert.equal(speakCall.args.includes("-t"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler exposes Hugging Face Kokoro download defaults", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 1 }) };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root },
      resourcesPath: path.join(root, "resources"),
    };
    const result = await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudHandle({action:"config"});`,
    )(requireStub, processStub);

    assert.equal(
      result.kokoro.modelUrl,
      "https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/kokoro-v1.0.onnx",
    );
    assert.equal(
      result.kokoro.voicesUrl,
      "https://huggingface.co/zijuncheng/kokoro_model_v1.0/resolve/main/voices-v1.0.bin",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler downloads setup files atomically", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      "var h={handlers:{\"set-vs-context\":async()=>{},\"native-desktop-apps\":async()=>({apps:[]})}};",
    ].join("");
    const patched = twice(applyMainBundlePatch, source);
    const target = path.join(root, "kokoro", "sample.bin");
    let observedHeaders = null;
    const requireStub = (name) => {
      if (name === "node:child_process") {
        return { spawnSync: () => ({ status: 1 }) };
      }
      if (name === "node:fs") return fs;
      if (name === "node:path") return path;
      if (name === "node:os") return { homedir: () => root };
      if (name === "node:https") {
        return {
          get: (_url, options, callback) => {
            const { EventEmitter } = require("node:events");
            const { PassThrough } = require("node:stream");
            const request = new EventEmitter();
            observedHeaders = options?.headers;
            process.nextTick(() => {
              const response = new PassThrough();
              response.statusCode = 200;
              response.headers = {};
              callback(response);
              response.end(Buffer.from("downloaded voice bytes"));
            });
            return request;
          },
        };
      }
      return require(name);
    };
    const processStub = {
      platform: "linux",
      env: { HOME: root },
      resourcesPath: path.join(root, "resources"),
    };
    await new Function(
      "require",
      "process",
      `${patched};return codexLinuxReadAloudDownloadFile("https://huggingface.co/test.bin", ${JSON.stringify(target)}, 10);`,
    )(requireStub, processStub);

    assert.equal(fs.readFileSync(target, "utf8"), "downloaded voice bytes");
    assert.equal(fs.existsSync(`${target}.part`), false);
    assert.equal(observedHeaders?.["User-Agent"], "codex-desktop-read-aloud");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assistant render patch adds an explicit read aloud button under the message", () => {
  const source = "return (0,$.jsx)(Ov,{item:n,alwaysShowActions:M,assistantCopyText:p,turnId:m,autoReviewStats:y,hookStats:b,completedThreadGoal:x,after:g,conversationId:o,cwd:u,forceCodeBlockWordWrap:V,hasArtifacts:F,onAddSelectedTextToChat:H,onFileLinkOpen:v,onFork:D,renderCodeBlocksAsWritingBlocks:V})";
  const patched = twice(applyAssistantRenderPatch, source);
  assert.match(patched, /codex-linux-read-aloud-button/);
  assert.match(patched, /codex-linux-read-aloud-icon/);
  assert.match(patched, /viewBox:"0 0 24 24"/);
  assert.doesNotMatch(patched, /children:"Read aloud"/);
  assert.match(patched, /globalThis\.codexLinuxReadAloudClick\?\.\(n,p,o,e\.currentTarget\)/);
  assert.match(patched, /\$\.Fragment/);
});

test("assistant render patch ignores normalized assistant items without render props", () => {
  const source = "case`agentMessage`:{let s=e.status===`inProgress`&&d>=0&&t===d,l=s&&Spt(i.content);a.push({type:`assistant-message`,content:m,completed:!s,renderPlaceholderWhileStreaming:l});break}";
  const { result: patched, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("assistant render patch still warns when an assistant render candidate drifts", () => {
  const source = "return (0,Q.jsx)(Ov,{item:n,assistantCopyText:p,conversationId:o,renderOptions:{writingBlocks:V}})";
  const { result: patched, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(patched, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not find assistant message render call/);
});

test("assistant render patch ignores the current shared component definition", () => {
  const source = "function Bzn({item:e,assistantCopyText:n,conversationId:l,renderCodeBlocksAsWritingBlocks:C=!1}){return e.completed&&n!=null?l:null}";
  const { result: patched, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("assistant render patch preserves the current JSX runtime alias", () => {
  const source = "return (0,Q.jsx)(Ov,{item:n,alwaysShowActions:M,assistantCopyText:p,turnId:m,autoReviewStats:y,hookStats:b,completedThreadGoal:x,after:g,conversationId:o,cwd:u,forceCodeBlockWordWrap:V,hasArtifacts:F,onAddSelectedTextToChat:H,onFileLinkOpen:v,onFork:D,renderCodeBlocksAsWritingBlocks:V})";
  const patched = twice(applyAssistantRenderPatch, source);

  assert.match(patched, /Q\.Fragment/);
  assert.match(patched, /\(0,Q\.jsx\)\("button"/);
  assert.match(patched, /globalThis\.codexLinuxReadAloudClick\?\.\(n,p,o,e\.currentTarget\)/);
});

test("assistant render patch covers the current shared assistant message call", () => {
  const source = "return (0,DX.jsx)(Jft,{item:n,alwaysShowActions:V,assistantCopyText:_,turnId:v,processTargets:b,hookStats:D,threadDetailLevel:u,completedThreadGoal:O,after:C,electronAfter:w,conversationId:l,cwd:p,hostId:m,reportEntityType:h,markdownMediaCacheKey:e,projectlessOutputDirectory:q,forceCodeBlockWordWrap:ie,hasArtifacts:J,onAddSelectedTextToChat:r,onFileLinkOpen:E,onFork:F,renderCodeBlocksAsWritingBlocks:ie,showActionRow:H,showTimestampWithoutActions:U,showProcessBadges:i})";
  const patched = twice(applyAssistantRenderPatch, source);

  assert.match(patched, /DX\.Fragment/);
  assert.match(patched, /\(0,DX\.jsx\)\("button"/);
  assert.match(patched, /globalThis\.codexLinuxReadAloudClick\?\.\(n,_,l,e\.currentTarget\)/);
});

test("assistant runtime descriptor targets current shared assistant bundles", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "assistant-runtime");
  assert.ok(descriptor);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~onboarding-page-zcfEkMl-.js",
    ),
    true,
  );
  for (const legacyName of [
    "index-current.js",
    "local-conversation-thread-current.js",
    "local-conversation-turn-current.js",
    "app-initial~app-main~onboarding-page~hotkey-window-thread-page~editor-diff-page~thread-app-~current.js",
  ]) {
    assert.equal(descriptor.pattern.test(legacyName), false, legacyName);
  }
});

test("assistant runtime descriptor fails soft and atomically when the current render contract drifts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-drift-"));
  try {
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const assetPath = path.join(
      assetsDir,
      "app-initial~app-main~onboarding-page-zcfEkMl-.js",
    );
    const source = "console.log(`assistant render contract moved`);";
    fs.writeFileSync(assetPath, source);
    const descriptor = featurePatches.find((patch) => patch.id === "assistant-runtime");
    const descriptors = normalizePatchDescriptors([
      { ...descriptor, featureId: "read-aloud", sourceKind: "feature" },
    ]);
    const report = createPatchReport();

    applyWebviewAssetPatchDescriptors(root, descriptors, {}, report);

    assert.equal(fs.readFileSync(assetPath, "utf8"), source);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.match(report.patches[0].reason, /Could not find assistant message render call/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assistant runtime descriptor reports applied then already-applied for the current contract", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-current-"));
  try {
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const assetPath = path.join(
      assetsDir,
      "app-initial~app-main~onboarding-page-zcfEkMl-.js",
    );
    fs.writeFileSync(
      assetPath,
      "return (0,DX.jsx)(Jft,{item:n,assistantCopyText:_,conversationId:l,renderCodeBlocksAsWritingBlocks:ie})",
    );
    const descriptor = featurePatches.find((patch) => patch.id === "assistant-runtime");
    const descriptors = normalizePatchDescriptors([
      { ...descriptor, featureId: "read-aloud", sourceKind: "feature" },
    ]);
    const firstReport = createPatchReport();
    const secondReport = createPatchReport();

    applyWebviewAssetPatchDescriptors(root, descriptors, {}, firstReport);
    applyWebviewAssetPatchDescriptors(root, descriptors, {}, secondReport);

    const patched = fs.readFileSync(assetPath, "utf8");
    assert.match(patched, /codex-linux-read-aloud-button/);
    assert.match(patched, /codexLinuxReadAloudVersion/);
    assert.equal(firstReport.patches[0].status, "applied");
    assert.equal(secondReport.patches[0].status, "already-applied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings patch does not add the legacy normal settings toggle", () => {
  const source = 'KEYS={promptWindow:"codex-linux-prompt-window-enabled",systemTray:"codex-linux-system-tray-enabled",warmStart:"codex-linux-warm-start-enabled"};$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."})';
  const patched = twice(applySettingsPatch, source);
  assert.equal(patched, source);
  assert.doesNotMatch(patched, /readAloud:"codex-linux-read-aloud-enabled"/);
  assert.doesNotMatch(patched, /label:"Read aloud responses"/);
});

test("settings patch removes an older legacy normal settings toggle", () => {
  const source = 'KEYS={promptWindow:"codex-linux-prompt-window-enabled",systemTray:"codex-linux-system-tray-enabled",warmStart:"codex-linux-warm-start-enabled",readAloud:"codex-linux-read-aloud-enabled"};$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."}),$.jsx(LinuxToggle,{settingKey:KEYS.readAloud,label:"Read aloud responses",description:"Show a Read aloud button on assistant responses.",defaultValue:!1})';
  const patched = twice(applySettingsPatch, source);
  assert.doesNotMatch(patched, /readAloud:"codex-linux-read-aloud-enabled"/);
  assert.doesNotMatch(patched, /label:"Read aloud responses"/);
  assert.match(patched, /KEYS=\{promptWindow/);
  assert.match(patched, /Warm start/);
});

test("general settings patch exports read aloud page without rendering it in General", () => {
  const source = "function Gn(){return (0,$.jsxs)(ht,{children:[S,C,w,T,D,O,k,A,j,M,N,P,L]})}";
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.match(patched, /function codexLinuxReadAloudSettingsRow/);
  assert.match(patched, /codex-linux-read-aloud-enabled/);
  assert.match(patched, /settings\.general\.readAloud\.label/);
  assert.match(patched, /Read aloud responses/);
  assert.match(patched, /codex-linux-read-aloud-kokoro-speed/);
  assert.match(patched, /Choose folder/);
  assert.match(patched, /Download voice/);
  assert.match(patched, /settings\.general\.readAloud\.help/);
  assert.match(patched, /Hugging Face/);
  assert.match(patched, /children:`\?`/);
  assert.match(patched, /Speech pace/);
  assert.match(patched, /function codexLinuxReadAloudSettingsPage/);
  assert.match(patched, /settings\.readAloud\.title/);
  assert.match(patched, /Listen to assistant responses with a local Kokoro voice/);
  assert.match(patched, /type:`range`/);
  assert.match(patched, /min:\.7/);
  assert.match(patched, /max:1\.4/);
  assert.match(patched, /codexLinuxReadAloudSetup/);
  assert.match(patched, /kokoro-explicit-v5/);
  assert.match(patched, /globalThis\.codexLinuxReadAloudSetup=setup/);
  assert.doesNotThrow(() => new Function("$", "w", "C", "N", "L", "F", "P", "J", "q", patched));
  assert.doesNotMatch(
    patched,
    /children:\[S,C,w,T,\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow,\{\}\),D,O,k,A,j,M,N,P,L\]/,
  );
  assert.match(patched, /children:\[S,C,w,T,D,O,k,A,j,M,N,P,L\]/);
});

test("general settings patch upgrades and removes an older injected General row", () => {
  const source = [
    "function codexLinuxReadAloudSettingsRow(){let e=(0,Q.c)(11),t=w(C),n=N(),{data:r,isLoading:i}=L(\"codex-linux-read-aloud-enabled\"),a=r===!0,o,s;e[0]===Symbol.for(`react.memo_cache_sentinel`)?(o=(0,$.jsx)(F,{id:`settings.general.readAloud.label`,defaultMessage:`Read aloud responses`,description:`Label for Linux read aloud setting`}),s=(0,$.jsx)(F,{id:`settings.general.readAloud.description`,defaultMessage:`Show a read aloud button under assistant responses`,description:`Description for Linux read aloud setting`}),e[0]=o,e[1]=s):(o=e[0],s=e[1]);let c;e[2]===t?c=e[3]:(c=e=>{P(t,\"codex-linux-read-aloud-enabled\",e)},e[2]=t,e[3]=c);let l;e[4]===n?l=e[5]:(l=n.formatMessage({id:`settings.general.readAloud.label`,defaultMessage:`Read aloud responses`,description:`Label for Linux read aloud setting`}),e[4]=n,e[5]=l);let u;return e[6]!==i||e[7]!==a||e[8]!==c||e[9]!==l?(u=(0,$.jsx)(J,{label:o,description:s,control:(0,$.jsx)(q,{checked:a,disabled:i,onChange:c,ariaLabel:l})}),e[6]=i,e[7]=a,e[8]=c,e[9]=l,e[10]=u):u=e[10],u}",
    "function Gn(){return (0,$.jsxs)(ht,{children:[S,C,w,T,D,O,k,(0,$.jsx)(codexLinuxReadAloudSettingsRow,{}),A,j,M,N,P,L]})}",
  ].join("");
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.match(patched, /codex-linux-read-aloud-kokoro-speed/);
  assert.match(patched, /Choose folder/);
  assert.match(patched, /Download voice/);
  assert.match(patched, /settings\.general\.readAloud\.help/);
  assert.match(patched, /Speech pace/);
  assert.match(patched, /function codexLinuxReadAloudSettingsPage/);
  assert.doesNotMatch(
    patched,
    /children:\[S,C,w,T,\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow,\{\}\),D,O,k,A,j,M,N,P,L\]/,
  );
  assert.doesNotMatch(
    patched,
    /children:\[S,C,w,T,D,O,k,\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow,\{\}\),A,j,M,N,P,L\]/,
  );
  assert.match(patched, /children:\[S,C,w,T,D,O,k,A,j,M,N,P,L\]/);
  assert.equal((patched.match(/function codexLinuxReadAloudSettingsRow/g) ?? []).length, 1);
});

test("general settings patch exports a dedicated read aloud settings page", () => {
  const source = [
    "function Gn(){return (0,$.jsxs)(pt,{children:[]})}",
    "export{Yn as i,Jn as n,Gn as r,fr as t};",
  ].join("");
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.match(patched, /function codexLinuxReadAloudSettingsPage/);
  assert.match(patched, /codexLinuxReadAloudSettingsPage as ReadAloudSettings/);
  assert.match(patched, /settings\.readAloud\.voice\.title/);
});

test("general settings patch exports read aloud from the current inner chunk", () => {
  const source = [
    "function $n(){return (0,$.jsxs)(vt,{children:[]})}",
    "export{ir as i,rr as n,$n as r,Cr as t};",
  ].join("");
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.match(patched, /function codexLinuxReadAloudSettingsPage/);
  assert.match(patched, /codexLinuxReadAloudSettingsPage as ReadAloudSettings/);
  assert.match(patched, /export\{ir as i,rr as n,\$n as r,Cr as t,codexLinuxReadAloudSettingsPage as ReadAloudSettings\}/);
});

test("general settings patch follows current export map instead of stale Gn aliases", () => {
  const source = [
    'import{s as e}from"./src-BRBmN298.js";',
    'import{t as xt}from"./settings-content-layout-Dm8iYKt_.js";',
    'import{a as st,r as K,t as ct}from"./dropdown-CTBRoADH.js";',
    'import{r as J}from"./settings-row-FLzCWFCC.js";',
    'import{t as Tg}from"./toggle-Cl52yCxI.js";',
    'import{i as M,l as N,s as P}from"./lib-MoKmYgcO.js";',
    'import{t as F}from"./clsx-DF17mjDp.js";',
    'import{n as I,y as L}from"./app-shell-state-Dq2x034T.js";',
    'import{n as m}from"./vscode-api-DjORcpSo.js";',
    'import{n as v,t as y}from"./jsx-runtime-CiQ1k8xo.js";',
    'import{t as St}from"./sun-BbSktlDj.js";',
    'import{a as U,i as W}from"./setting-storage-CwKZnsvR.js";',
    'import{n as wt}from"./external-agent-import-step-CfOKFuct.js";',
    "var Q=e(v(),1),$=y();",
    "function Gn(){return (0,$.jsx)(K,{label:`Service tier`})}",
    "function nr(){return (0,$.jsx)(J,{label:`General`})}",
    "export{or as i,ar as n,nr as r,Tr as t};",
  ].join("");
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.match(patched, /codexLinuxReadAloudSettingsAliasesV2/);
  assert.match(patched, /function codexLinuxReadAloudSettingsPage\(\)\{return\(0,\$\.jsx\)\(xt/);
  assert.match(patched, /\(0,\$\.jsx\)\(J,\{label:l/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(K,\{label:l/);
  assert.match(patched, /\(0,\$\.jsx\)\(Tg,\{checked:e===!0/);
  assert.match(patched, /c=N\(\);/);
  assert.match(patched, /\(0,\$\.jsx\)\(P,\{id:`settings\.general\.readAloud\.label`/);
  assert.match(patched, /\(0,\$\.jsx\)\(P,\{id:`settings\.readAloud\.title`/);
  assert.doesNotMatch(patched, /c=F\(\);/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(I,\{id:`settings\.(general\.readAloud|readAloud)\./);
  assert.match(patched, /\(0,Q\.useState\)\(!1\)/);
  assert.match(patched, /m\(`get-global-state`,\{params:\{key:"codex-linux-read-aloud-enabled"\}\}\)/);
  assert.match(patched, /m\(`set-global-state`,\{params:\{key:"codex-linux-read-aloud-enabled",value:n\}\}\)/);
  assert.match(patched, /m\(`set-global-state`,\{params:\{key:"codex-linux-read-aloud-kokoro-speed",value:t\}\}\)/);
  assert.match(patched, /codexLinuxReadAloudChooseFolderLabel=c\.formatMessage/);
  assert.doesNotMatch(patched, /m=c\.formatMessage/);
  assert.doesNotMatch(patched, /set-setting|get-setting/);
  assert.doesNotMatch(patched, /let e=S\(D\),t=F\(\),n=\{key:"codex-linux-read-aloud-enabled",default:!1\}/);
  assert.doesNotMatch(patched, /U\(e,n,t\)/);
  assert.doesNotMatch(patched, /function codexLinuxReadAloudSettingsPage\(\)\{return\(0,\$\.jsx\)\(St/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(W,\{electron:!0/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(wt,\{children:\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow,\{\}\)\}/);
  assert.doesNotMatch(patched, /function codexLinuxReadAloudSettingsPage\(\)\{return\(0,\$\.jsx\)\(pt/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(ht,\{children:\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow/);
  assert.ok(patched.indexOf("function codexLinuxReadAloudSettingsRow") > patched.indexOf("function Gn(){"));
  assert.ok(patched.indexOf("function codexLinuxReadAloudSettingsRow") < patched.indexOf("function nr(){"));
});

test("general settings patch upgrades a stale current read aloud settings page", () => {
  const source = [
    'import{s as e}from"./src-BRBmN298.js";',
    'import{t as xt}from"./settings-content-layout-Dm8iYKt_.js";',
    'import{a as st,r as K,t as ct}from"./dropdown-CTBRoADH.js";',
    'import{r as J}from"./settings-row-FLzCWFCC.js";',
    'import{t as Tg}from"./toggle-Cl52yCxI.js";',
    'import{i as M,l as N,s as P}from"./lib-MoKmYgcO.js";',
    'import{t as F}from"./clsx-DF17mjDp.js";',
    'import{n as I,y as L}from"./app-shell-state-Dq2x034T.js";',
    'import{n as m}from"./vscode-api-DjORcpSo.js";',
    'import{n as v,t as y}from"./jsx-runtime-CiQ1k8xo.js";',
    'import{t as St}from"./sun-BbSktlDj.js";',
    'import{a as U,i as W}from"./setting-storage-CwKZnsvR.js";',
    'import{n as wt}from"./external-agent-import-step-CfOKFuct.js";',
    "var Q=e(v(),1),$=y();",
    "function Gn(){return (0,$.jsx)(K,{label:`Service tier`})}",
    "function codexLinuxReadAloudPaceValue(e){return 1.05}function codexLinuxReadAloudSettingsRow(){return `codex-linux-read-aloud-enabled codex-linux-read-aloud-kokoro-speed settings.general.readAloud.chooseFolder settings.general.readAloud.help`}function codexLinuxReadAloudSettingsPage(){return(0,$.jsx)(St,{children:(0,$.jsx)(W,{electron:!0,children:(0,$.jsx)(wt,{children:(0,$.jsx)(codexLinuxReadAloudSettingsRow,{})})})})}",
    "function nr(){return (0,$.jsx)(J,{label:`General`})}",
    "export{or as i,ar as n,nr as r,Tr as t,codexLinuxReadAloudSettingsPage as ReadAloudSettings};",
  ].join("");
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.equal((patched.match(/function codexLinuxReadAloudSettingsRow/g) ?? []).length, 1);
  assert.equal((patched.match(/function codexLinuxReadAloudSettingsPage/g) ?? []).length, 1);
  assert.match(patched, /codexLinuxReadAloudSettingsAliasesV2/);
  assert.match(patched, /function codexLinuxReadAloudSettingsPage\(\)\{return\(0,\$\.jsx\)\(xt/);
  assert.match(patched, /c=N\(\);/);
  assert.match(patched, /\(0,\$\.jsx\)\(P,\{id:`settings\.readAloud\.title`/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(St,\{children:\(0,\$\.jsx\)\(W/);
});

test("general settings patch refreshes a current read aloud row with a stale settings-row alias", () => {
  const source = [
    'import{s as e}from"./src-BRBmN298.js";',
    'import{t as xt}from"./settings-content-layout-Dm8iYKt_.js";',
    'import{a as st,r as K,t as ct}from"./dropdown-CTBRoADH.js";',
    'import{r as J}from"./settings-row-FLzCWFCC.js";',
    'import{t as Tg}from"./toggle-Cl52yCxI.js";',
    'import{i as M,l as N,s as P}from"./lib-MoKmYgcO.js";',
    'import{t as F}from"./clsx-DF17mjDp.js";',
    'import{n as I,y as L}from"./app-shell-state-Dq2x034T.js";',
    'import{n as m}from"./vscode-api-DjORcpSo.js";',
    'import{n as v,t as y}from"./jsx-runtime-CiQ1k8xo.js";',
    "var Q=e(v(),1),$=y();",
    "function Gn(){return (0,$.jsx)(K,{label:`Service tier`})}",
    "/*codexLinuxReadAloudSettingsAliasesV2*/function codexLinuxReadAloudPaceValue(e){return 1.05}function codexLinuxReadAloudSettingsRow(){let e=!0,l=`codex-linux-read-aloud-enabled`,d=`codex-linux-read-aloud-kokoro-speed`;return(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(K,{label:l,description:`settings.general.readAloud.chooseFolder settings.general.readAloud.help`,control:null}),e?(0,$.jsx)(K,{label:d,description:`settings.general.readAloud.help`,control:null}):null]})}function codexLinuxReadAloudSettingsPage(){return(0,$.jsx)(xt,{children:(0,$.jsx)(codexLinuxReadAloudSettingsRow,{})})}",
    "function nr(){return (0,$.jsx)(J,{label:`General`})}",
    "export{or as i,ar as n,nr as r,Tr as t,codexLinuxReadAloudSettingsPage as ReadAloudSettings};",
  ].join("");
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.equal((patched.match(/function codexLinuxReadAloudSettingsRow/g) ?? []).length, 1);
  assert.equal((patched.match(/function codexLinuxReadAloudSettingsPage/g) ?? []).length, 1);
  assert.equal((patched.match(/codexLinuxReadAloudSettingsAliasesV2/g) ?? []).length, 1);
  assert.match(patched, /codexLinuxReadAloudSettingsAliasesV2/);
  assert.match(patched, /\(0,\$\.jsx\)\(J,\{label:l/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(K,\{label:l/);
  assert.match(patched, /\(0,\$\.jsx\)\(Tg,\{checked:e===!0/);
  assert.match(patched, /c=N\(\);/);
  assert.match(patched, /\(0,\$\.jsx\)\(P,\{id:`settings\.general\.readAloud\.label`/);
  assert.doesNotMatch(patched, /c=F\(\);/);
  assert.doesNotMatch(patched, /\(0,\$\.jsx\)\(I,\{id:`settings\.(general\.readAloud|readAloud)\./);
  assert.match(patched, /codexLinuxReadAloudChooseFolderLabel=c\.formatMessage/);
  assert.doesNotMatch(patched, /m=c\.formatMessage/);
});

test("general settings wrapper re-exports the read aloud settings page", () => {
  const source = 'import{r as e}from"./general-settings-Bvwhh0-i.js";export{e as GeneralSettings};';
  const patched = twice(applyGeneralSettingsWrapperPatch, source);
  assert.match(
    patched,
    /import\{r as e,ReadAloudSettings as codexLinuxReadAloudSettings\}from"\.\/general-settings-Bvwhh0-i\.js"/,
  );
  assert.match(patched, /export\{e as GeneralSettings,codexLinuxReadAloudSettings as ReadAloudSettings\}/);
  assert.doesNotMatch(patched, /e as GeneralSettings,e as ReadAloudSettings/);
});

test("general settings wrapper preserves an existing read aloud import", () => {
  const source =
    'import{r as e,ReadAloudSettings as t}from"./general-settings-CV9Safs7.js";export{e as GeneralSettings,t as ReadAloudSettings};';
  const patched = twice(applyGeneralSettingsWrapperPatch, source);
  assert.equal(patched, source);
  assert.match(patched, /ReadAloudSettings as t/);
  assert.doesNotMatch(patched, /e as GeneralSettings,e as ReadAloudSettings/);
});

test("general settings wrapper re-exports read aloud when side-effect imports split the wrapper", () => {
  const source =
    'import"./src-BRBmN298.js";import{r as e}from"./general-settings-DobuGNrH.js";import"./general-settings.search-BiUmOZih.js";export{e as GeneralSettings};';
  const patched = twice(applyGeneralSettingsWrapperPatch, source);
  assert.match(
    patched,
    /import\{r as e,ReadAloudSettings as codexLinuxReadAloudSettings\}from"\.\/general-settings-DobuGNrH\.js"/,
  );
  assert.match(patched, /import"\.\/general-settings\.search-BiUmOZih\.js";/);
  assert.match(patched, /export\{e as GeneralSettings,codexLinuxReadAloudSettings as ReadAloudSettings\}/);
});

test("settings nav patches add a visible read aloud section after computer use", () => {
  const sections = "var n=[{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`}];";
  const patchedSections = twice(applySettingsSectionsNavPatch, sections);
  assert.match(patchedSections, /slug:`computer-use`},{slug:`read-aloud-settings`},{slug:`mcp-settings`/);

  const shared = [
    '"computer-use":{id:`settings.nav.computer-use`,defaultMessage:`Computer use`,description:`Title for computer use settings section`},',
    "function m(e){switch(e){case`computer-use`:{return null}case`browser-use`:{return null}}}",
  ].join("");
  const patchedShared = twice(applySettingsSharedNavPatch, shared);
  assert.match(patchedShared, /settings\.nav\.read-aloud-settings/);
  assert.match(patchedShared, /defaultMessage:`Read Aloud`/);
  assert.match(patchedShared, /case`read-aloud-settings`/);

  const page = [
    'var Z={},de=null,oe=null,G=null,pe={"browser-use":de,"computer-use":oe,"local-environments":q};',
    "me=[`browser-use`,`computer-use`,`data-controls`];",
    "he=[{slugs:[`browser-use`,`computer-use`,`local-environments`]}];",
    "case`computer-use`:return A;",
    "case`computer-use`:z=k.isLoading||m.isLoading;break bb0;",
  ].join("");
  const patchedPage = twice(applySettingsPageNavPatch, page);
  assert.doesNotMatch(patchedPage, /codexLinuxReadAloudSettingsIcon=e=>/);
  assert.match(
    patchedPage,
    /"read-aloud-settings":\(e=>\{try\{return \(0,Z\.jsxs\)\(`svg`,/,
  );
  assert.match(patchedPage, /catch\(t\)\{return oe\(e\)\}\}\)/);
  assert.match(patchedPage, /`computer-use`,`read-aloud-settings`,`data-controls`/);
  assert.match(patchedPage, /`computer-use`,`read-aloud-settings`,`local-environments`/);
  assert.match(patchedPage, /case`read-aloud-settings`:return!0;case`computer-use`/);
  assert.match(patchedPage, /case`read-aloud-settings`:z=!1;break bb0;case`computer-use`/);
});

test("settings nav patch adds the read aloud icon to the current settings page icon map", () => {
  const page = [
    "var ge=f(),_e=e(r()),$=i(),ve=e=>(0,$.jsxs)(`svg`,{children:[]}),ye={\"general-settings\":q,profile:ee,\"keyboard-shortcuts\":ve,\"browser-use\":me,\"computer-use\":fe,\"local-environments\":pe,worktrees:K};",
    "xe=[`browser-use`,`computer-use`,`data-controls`];",
    "Se=[{slugs:[`browser-use`,`computer-use`,`local-environments`]}];",
    "case`computer-use`:return A;",
    "case`computer-use`:z=D.isLoading||h.isLoading;break bb0;",
  ].join("");
  const patched = twice(applySettingsPageNavPatch, page);
  assert.doesNotMatch(patched, /codexLinuxReadAloudSettingsIcon=e=>/);
  assert.match(
    patched,
    /"browser-use":me,"computer-use":fe,"read-aloud-settings":\(e=>\{try\{return \(0,\$\.jsxs\)\(`svg`,/,
  );
  assert.match(patched, /catch\(t\)\{return fe\(e\)\}\}\),"local-environments":pe/);
  assert.doesNotMatch(patched, /\(0,Z\.jsxs\)/);
  assert.match(patched, /`computer-use`,`read-aloud-settings`,`data-controls`/);
  assert.match(patched, /case`read-aloud-settings`:return!0;case`computer-use`/);
  assert.match(patched, /case`read-aloud-settings`:z=!1;break bb0;case`computer-use`/);
});

test("settings nav patch repairs stale hidden read aloud visibility gates", () => {
  const source =
    "case`profile`:return y;case`read-aloud-settings`:return a;case`computer-use`:return A;case`browser-use`:return L;";
  const patched = twice(applySettingsPageNavPatch, source);
  assert.equal(
    patched,
    "case`profile`:return y;case`read-aloud-settings`:return!0;case`computer-use`:return A;case`browser-use`:return L;",
  );
});

test("settings nav patch adds read aloud visibility before drifted computer-use aliases", () => {
  const source = "case`profile`:return b;case`computer-use`:return E;case`browser-use`:return D;";
  const patched = twice(applySettingsPageNavPatch, source);
  assert.equal(
    patched,
    "case`profile`:return b;case`read-aloud-settings`:return!0;case`computer-use`:return E;case`browser-use`:return D;",
  );
});

test("settings nav patch repairs stale read aloud icon references in var icon maps", () => {
  const page = [
    "var $=i();",
    "var codexLinuxAgentWorkspaceSettingsIcon=e=>(0,$.jsxs)(`svg`,{children:[]});",
    'var qe={"general-settings":I,profile:J,"browser-use":ke,"computer-use":De,"read-aloud-settings":codexLinuxReadAloudSettingsIcon,"local-environments":Oe,"agent-workspaces":codexLinuxAgentWorkspaceSettingsIcon,worktrees:q};',
    "Ye=[`browser-use`,`computer-use`,`data-controls`];",
    "Ze=[{slugs:[`browser-use`,`computer-use`,`local-environments`]}];",
    "case`computer-use`:return A;",
    "case`computer-use`:I=T.isLoading||g.isLoading;break bb0;",
  ].join("");
  const patched = twice(applySettingsPageNavPatch, page);
  assert.doesNotMatch(patched, /codexLinuxReadAloudSettingsIcon=e=>/);
  assert.match(
    patched,
    /"computer-use":De,"read-aloud-settings":\(e=>\{try\{return \(0,\$\.jsxs\)\(`svg`,/,
  );
  assert.match(patched, /catch\(t\)\{return De\(e\)\}\}\),"local-environments":Oe/);
  assert.match(patched, /case`read-aloud-settings`:return!0;case`computer-use`/);
  assert.match(patched, /case`read-aloud-settings`:I=!1;break bb0;case`computer-use`/);
});

test("settings nav patch declares legacy read aloud icon assignments before they can throw", () => {
  const page = [
    'import{n as e}from"./rolldown-runtime.js";',
    "var $=i(),Hn,Xn=e((()=>{Hn=null,codexLinuxReadAloudSettingsIcon=e=>(0,$.jsxs)(`svg`,{children:[]}),Hn={\"browser-use\":me,\"computer-use\":fe,\"read-aloud-settings\":codexLinuxReadAloudSettingsIcon,\"local-environments\":pe}}));",
    "xe=[`browser-use`,`computer-use`,`data-controls`];",
    "Se=[{slugs:[`browser-use`,`computer-use`,`local-environments`]}];",
    "case`computer-use`:return A;",
    "case`computer-use`:z=D.isLoading||h.isLoading;break bb0;",
  ].join("");
  const patched = twice(applySettingsPageNavPatch, page);
  assert.match(
    patched,
    /^import\{n as e\}from"\.\/rolldown-runtime\.js";var codexLinuxReadAloudSettingsIcon;/,
  );
  assert.match(patched, /codexLinuxReadAloudSettingsIcon=e=>\(0,\$\.jsxs\)/);
  assert.match(
    patched,
    /"computer-use":fe,"read-aloud-settings":\(e=>\{try\{return \(0,\$\.jsxs\)\(`svg`,/,
  );
  assert.match(patched, /catch\(t\)\{return fe\(e\)\}\}\),"local-environments":pe/);
});

test("app route patch wires read aloud settings to the generated page export", () => {
  const source =
    'var iD={"general-settings":(0,Q.lazy)(()=>Mr(()=>import(`./general-settings-B89XeV4U.js`).then(e=>({default:e.GeneralSettings})),__vite__mapDeps([1,2]),import.meta.url)),"keyboard-shortcuts":K};';
  const patched = twice(applyAppMainRoutePatch, source);
  assert.match(patched, /"read-aloud-settings":\(0,Q\.lazy\)/);
  assert.match(patched, /default:e\.ReadAloudSettings/);
  assert.match(patched, /"general-settings":\(0,Q\.lazy\)/);
});

test("settings asset patch leaves current keybinds settings file alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const asset = path.join(assets, "keybinds-settings-linux.js");
    fs.writeFileSync(
      asset,
      'KEYS={promptWindow:"codex-linux-prompt-window-enabled",systemTray:"codex-linux-system-tray-enabled",warmStart:"codex-linux-warm-start-enabled"};$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."})',
    );
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
    const patched = fs.readFileSync(asset, "utf8");
    assert.doesNotMatch(patched, /readAloud:"codex-linux-read-aloud-enabled"/);
    assert.doesNotMatch(patched, /label:"Read aloud responses"/);
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings asset patch adds read aloud controls to generated Linux desktop settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const asset = path.join(assets, "linux-desktop-settings-linux.js");
    fs.writeFileSync(asset, linuxDesktopSettingsFixture());

    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 1 });
    const patched = fs.readFileSync(asset, "utf8");
    assert.match(patched, /readAloud:"codex-linux-read-aloud-enabled"/);
    assert.match(patched, /readAloudSpeed:"codex-linux-read-aloud-kokoro-speed"/);
    assert.match(patched, /class LinuxReadAloudSettings extends React\.Component/);
    assert.doesNotMatch(patched, /useLinuxSetting/);
    assert.match(patched, /title:"Read Aloud"/);
    assert.match(patched, /label:"Read aloud responses"/);
    assert.match(patched, /children:"Choose folder"/);
    assert.match(patched, /children:"Download voice"/);
    assert.match(patched, /label:"Speech pace"/);
    assert.match(
      patched,
      /\$\.jsx\(LinuxReadAloudSettings,\{\}\),\$\.jsxs\(SettingsSection,\{className:"gap-2",children:\[\$\.jsx\(SettingsSection\.Header,\{title:"Build"/,
    );
    assert.doesNotMatch(patched, /LinuxSettingsSection/);
    assert.doesNotMatch(patched, /LinuxSettingsRow/);

    const stale = patched
      .replace("this._enabledWrite=0,this._speedWrite=0,", "")
      .replace("Promise.allSettled([", "Promise.all([");
    fs.writeFileSync(asset, stale);
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 1 });
    const refreshed = fs.readFileSync(asset, "utf8");
    assert.match(refreshed, /this\._enabledWrite=0,this\._speedWrite=0/);
    assert.match(refreshed, /Promise\.allSettled\(\[/);
    assert.doesNotMatch(refreshed, /Promise\.all\(\[/);
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Linux desktop read aloud settings refresh fails closed on a malformed class", () => {
  const patched = applyLinuxDesktopSettingsPatch(linuxDesktopSettingsFixture());
  const malformed = patched.replace(
    "}}function LinuxDesktopSettings(){",
    "}function LinuxDesktopSettings(){",
  );
  assert.notEqual(malformed, patched);

  const { result, warnings } = captureWarnings(() =>
    applyLinuxDesktopSettingsPatch(malformed));
  assert.equal(result, malformed);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not refresh existing Linux read aloud settings/);
});

test("generated Linux desktop read aloud settings preserve successful independent reads", async () => {
  const settings = createLinuxReadAloudSettings((method, { params }) => {
    assert.equal(method, "get-global-state");
    if (params.key === "codex-linux-read-aloud-enabled") {
      return Promise.resolve({ value: true });
    }
    if (params.key === "codex-linux-read-aloud-kokoro-speed") {
      return Promise.reject(new Error("speed unavailable"));
    }
    throw new Error(`Unexpected settings key: ${params.key}`);
  });

  settings.componentDidMount();
  await settlePromises();

  assert.equal(settings.state.enabled, true);
  assert.equal(settings.state.speed, 1.05);
  assert.equal(settings.state.isLoading, false);
  assert.equal(settings.state.error, "speed unavailable");
  settings.componentWillUnmount();
});

test("generated Linux desktop read aloud settings ignore superseded speed failures", async () => {
  const { settings, writes: speedWrites } = createDeferredSettingsWrites({
    writeKey: "codex-linux-read-aloud-kokoro-speed",
    enabled: true,
    speed: 1.4,
  });

  settings.componentDidMount();
  await settlePromises();
  settings.updateSpeed({ currentTarget: { value: "1.15" } });
  settings.updateSpeed({ currentTarget: { value: "1.30" } });
  assert.equal(settings.state.speed, 1.3);
  await settlePromises();
  assert.equal(speedWrites.length, 1);

  speedWrites[0].reject(new Error("older write failed"));
  await settlePromises();
  assert.equal(speedWrites.length, 2);
  speedWrites[1].resolve();
  await settlePromises();

  assert.equal(settings.state.speed, 1.3);
  assert.equal(settings.state.error, null);
  settings.componentWillUnmount();
});

test("generated Linux desktop read aloud settings ignore superseded toggle errors", async () => {
  const { settings, writes: enabledWrites } = createDeferredSettingsWrites({
    writeKey: "codex-linux-read-aloud-enabled",
  });

  settings.componentDidMount();
  await settlePromises();
  settings.updateEnabled(true);
  settings.updateEnabled(false);
  await settlePromises();
  assert.equal(enabledWrites.length, 1);
  enabledWrites[0].reject(new Error("older toggle failed"));
  await settlePromises();
  assert.equal(enabledWrites.length, 2);
  enabledWrites[1].resolve();
  await settlePromises();

  assert.equal(settings.state.enabled, false);
  assert.equal(settings.state.error, null);
  settings.componentWillUnmount();
});

test("generated Linux desktop read aloud settings roll consecutive toggle failures back to confirmed state", async () => {
  const { settings, writes: enabledWrites } = createDeferredSettingsWrites({
    writeKey: "codex-linux-read-aloud-enabled",
  });

  settings.componentDidMount();
  await settlePromises();
  settings.updateEnabled(true);
  settings.updateEnabled(false);
  assert.equal(settings.state.enabled, false);
  await settlePromises();
  assert.equal(enabledWrites.length, 1);

  enabledWrites[0].reject(new Error("first toggle failed"));
  await settlePromises();
  assert.equal(enabledWrites.length, 2);
  enabledWrites[1].reject(new Error("second toggle failed"));
  await settlePromises();

  assert.equal(settings.state.enabled, false);
  assert.equal(settings.state.error, "second toggle failed");
  settings.componentWillUnmount();
});

test("generated Linux desktop read aloud settings roll consecutive speed failures back to confirmed state", async () => {
  const { settings, writes: speedWrites } = createDeferredSettingsWrites({
    writeKey: "codex-linux-read-aloud-kokoro-speed",
    enabled: true,
  });

  settings.componentDidMount();
  await settlePromises();
  settings.updateSpeed({ currentTarget: { value: "1.15" } });
  settings.updateSpeed({ currentTarget: { value: "1.30" } });
  assert.equal(settings.state.speed, 1.3);
  await settlePromises();
  assert.equal(speedWrites.length, 1);

  speedWrites[0].reject(new Error("first speed write failed"));
  await settlePromises();
  assert.equal(speedWrites.length, 2);
  speedWrites[1].reject(new Error("second speed write failed"));
  await settlePromises();

  assert.equal(settings.state.speed, 1.05);
  assert.equal(settings.state.error, "second speed write failed");
  settings.componentWillUnmount();
});

test("generated Linux desktop read aloud settings roll a toggle failure back to the last successful write", async () => {
  const { settings, writes: enabledWrites } = createDeferredSettingsWrites({
    writeKey: "codex-linux-read-aloud-enabled",
  });

  settings.componentDidMount();
  await settlePromises();
  settings.updateEnabled(true);
  settings.updateEnabled(false);
  await settlePromises();

  enabledWrites[0].resolve();
  await settlePromises();
  enabledWrites[1].reject(new Error("latest toggle failed"));
  await settlePromises();

  assert.equal(settings.state.enabled, true);
  assert.equal(settings.state.error, "latest toggle failed");
  settings.componentWillUnmount();
});

test("generated Linux desktop read aloud settings roll a speed failure back to the last successful write", async () => {
  const { settings, writes: speedWrites } = createDeferredSettingsWrites({
    writeKey: "codex-linux-read-aloud-kokoro-speed",
    enabled: true,
  });

  settings.componentDidMount();
  await settlePromises();
  settings.updateSpeed({ currentTarget: { value: "1.15" } });
  settings.updateSpeed({ currentTarget: { value: "1.30" } });
  await settlePromises();

  speedWrites[0].resolve();
  await settlePromises();
  speedWrites[1].reject(new Error("latest speed write failed"));
  await settlePromises();

  assert.equal(settings.state.speed, 1.15);
  assert.equal(settings.state.error, "latest speed write failed");
  settings.componentWillUnmount();
});

test("settings asset patch removes an older generated keybinds read aloud toggle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const asset = path.join(assets, "keybinds-settings-linux.js");
    fs.writeFileSync(
      asset,
      'KEYS={promptWindow:"codex-linux-prompt-window-enabled",systemTray:"codex-linux-system-tray-enabled",warmStart:"codex-linux-warm-start-enabled",readAloud:"codex-linux-read-aloud-enabled"};$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."}),$.jsx(LinuxToggle,{settingKey:KEYS.readAloud,label:"Read aloud responses",description:"Show a Read aloud button on assistant responses.",defaultValue:!1})',
    );
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 1 });
    const patched = fs.readFileSync(asset, "utf8");
    assert.doesNotMatch(patched, /readAloud:"codex-linux-read-aloud-enabled"/);
    assert.doesNotMatch(patched, /label:"Read aloud responses"/);
    assert.match(patched, /Warm start/);
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings asset patch upgrades older general settings bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const asset = path.join(assets, "general-settings-current.js");
    fs.writeFileSync(
      asset,
      [
        "function codexLinuxReadAloudSettingsRow(){let e=(0,Q.c)(11),t=w(C),n=N(),{data:r,isLoading:i}=L(\"codex-linux-read-aloud-enabled\"),a=r===!0;return (0,$.jsx)(J,{control:(0,$.jsx)(q,{checked:a,disabled:i,onChange:e=>P(t,\"codex-linux-read-aloud-enabled\",e),ariaLabel:n.formatMessage({id:`settings.general.readAloud.label`,defaultMessage:`Read aloud responses`})})})}",
        "function Gn(){return (0,$.jsxs)(ht,{children:[S,C,w,T,D,O,k,(0,$.jsx)(codexLinuxReadAloudSettingsRow,{}),A,j,M,N,P,L]})}",
      ].join(""),
    );
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 1 });
    const patched = fs.readFileSync(asset, "utf8");
    assert.match(patched, /codex-linux-read-aloud-kokoro-speed/);
    assert.match(patched, /Choose folder/);
    assert.match(patched, /kokoro-explicit-v5/);
    assert.doesNotMatch(
      patched,
      /children:\[S,C,w,T,\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow,\{\}\),D,O,k,A,j,M,N,P,L\]/,
    );
    assert.match(patched, /children:\[S,C,w,T,D,O,k,A,j,M,N,P,L\]/);
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings asset patch updates current general settings bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const asset = path.join(assets, "general-settings-current.js");
    fs.writeFileSync(
      asset,
      "function Gn(){return (0,$.jsxs)(ht,{children:[S,C,w,T,D,O,k,A,j,M,N,P,L]})}",
    );
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 1 });
    const patched = fs.readFileSync(asset, "utf8");
    assert.match(patched, /codex-linux-read-aloud-enabled/);
    assert.match(patched, /codexLinuxReadAloudSettingsRow/);
    assert.match(patched, /globalThis\.codexLinuxReadAloudSetup=setup/);
    assert.doesNotMatch(
      patched,
      /children:\[S,C,w,T,\(0,\$\.jsx\)\(codexLinuxReadAloudSettingsRow,\{\}\),D,O,k,A,j,M,N,P,L\]/,
    );
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("settings asset patch creates a first-class read aloud settings section", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const assets = path.join(root, "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(
      path.join(assets, "keybinds-settings-linux.js"),
      'KEYS={promptWindow:"codex-linux-prompt-window-enabled",systemTray:"codex-linux-system-tray-enabled",warmStart:"codex-linux-warm-start-enabled"};$.jsx(LinuxToggle,{settingKey:KEYS.warmStart,label:"Warm start",description:"Use the running app for launch actions instead of starting a fresh Electron instance."})',
    );
    fs.writeFileSync(
      path.join(assets, "general-settings-inner.js"),
      [
        "function Gn(){return (0,$.jsxs)(ht,{children:[S,C,w,T,D,O,k,A,j,M,N,P,L]})}",
        "export{Yn as i,Jn as n,Gn as r,fr as t};",
      ].join(""),
    );
    fs.writeFileSync(
      path.join(assets, "general-settings-wrapper.js"),
      'import{r as e}from"./general-settings-inner.js";export{e as GeneralSettings};',
    );
    fs.writeFileSync(
      path.join(assets, "settings-sections-current.js"),
      "var n=[{slug:`browser-use`},{slug:`computer-use`},{slug:`mcp-settings`}];",
    );
    fs.writeFileSync(
      path.join(assets, "settings-shared-current.js"),
      [
        '"computer-use":{id:`settings.nav.computer-use`,defaultMessage:`Computer use`,description:`Title for computer use settings section`},',
        "function m(e){switch(e){case`computer-use`:{return null}case`browser-use`:{return null}}}",
      ].join(""),
    );
    fs.writeFileSync(
      path.join(assets, "settings-page-current.js"),
      [
        'var Z={},de=null,oe=null,G=null,pe={"browser-use":de,"computer-use":oe,"local-environments":q};',
        "me=[`browser-use`,`computer-use`,`data-controls`];",
        "he=[{slugs:[`browser-use`,`computer-use`,`local-environments`]}];",
        "case`computer-use`:return A;",
        "case`computer-use`:z=k.isLoading||m.isLoading;break bb0;",
      ].join(""),
    );
    fs.writeFileSync(
      path.join(assets, "app-main-current.js"),
      'var iD={"general-settings":(0,Q.lazy)(()=>Mr(()=>import(`./general-settings-wrapper.js`).then(e=>({default:e.GeneralSettings})),__vite__mapDeps([1,2]),import.meta.url)),"keyboard-shortcuts":K};',
    );

    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 6 });
    assert.deepEqual(applySettingsAssetPatch(root), { matched: true, changed: 0 });
    assert.match(
      fs.readFileSync(path.join(assets, "settings-page-current.js"), "utf8"),
      /"read-aloud-settings":\(e=>\{try\{return \(0,Z\.jsxs\)\(`svg`,/,
    );
    assert.match(
      fs.readFileSync(path.join(assets, "app-main-current.js"), "utf8"),
      /default:e\.ReadAloudSettings/,
    );
    assert.match(
      fs.readFileSync(path.join(assets, "general-settings-wrapper.js"), "utf8"),
      /export\{e as GeneralSettings,codexLinuxReadAloudSettings as ReadAloudSettings\}/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
