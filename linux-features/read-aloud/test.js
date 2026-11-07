#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { fixture: requestGraphFixture } = require("../../scripts/patches/lib/fixtures/main-request-graph.js");
const {
  applyAssistantRenderPatch,
  applyGeneralSettingsPatch,
  applyIndexRuntimePatch,
  applyMainBundlePatch,
  applyRuntimeEntryPatch,
  descriptors: featurePatches,
  matchesAssistantRuntimeContract,
  matchesGeneralSettingsPageContract,
} = require("./patch.js");
const {
  applyWebviewAssetPatchDescriptors,
  applyExtractedAppPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
require("./main-handler.test.js");

// The complete source-local graph, including native-style startup/factory
// wiring, is shared with the foundation's tests. No real runtime is launched.
const MAIN_FIXTURE = requestGraphFixture();
let speechPid = 20000;
function fakeSpeechChild(close = false) {
  const child = new EventEmitter();
  child.pid = ++speechPid;
  child.stdin = new EventEmitter(); child.stdin.end = () => {};
  child.stdout = new EventEmitter(); child.stdout.pipe = () => {};
  child.kill = () => true; child.unref = () => {};
  queueMicrotask(() => {
    child.emit("spawn");
    if (close) queueMicrotask(() => { child.emit("exit", 0); child.emit("close", 0); });
  });
  return child;
}
function graphRuntime(patched, requireStub, processStub, sent = []) {
  const carrier = {};
  new Function("require", "process", "exports", patched)(requireStub, processStub, carrier);
  const target = {}, load = () => { throw Error("Unexpected fixture import"); };
  load.d = (out, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(out, key, { get }); };
  carrier.modules[82820]({}, target, load);
  const host = target.runMainAppStartup({ globalState: new Map(), cancelled: [],
    chunkedMessageSender: { sendInlineMessageForView: (view, message) => sent.push({ webContents: view, message }) } });
  return { host, request: (view, payload) => host.handleMessage(view, { type: "fetch", ...payload }) };
}

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

function settlePromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("language routing uses dominant letters and preserves explicit overrides", () => {
  const source = [
    "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
    MAIN_FIXTURE,
  ].join("");
  const patched = twice(applyMainBundlePatch, source);
  const env = {};
  const language = new Function("require", "process", `const exports={};${patched};return codexLinuxReadAloudLanguage;`)(
    require, { platform: "linux", env },
  );
  for (const [text, expected] of [
    ["שלום עולם", "he"],
    ["This is a test.", "en"],
    ["A test with a label and a caption.", "en"],
    ["你好，这是中文测试。", "zh"],
    ["こんにちは世界", "ja"],
    ["안녕하세요", "ko"],
    ["Привет мир", "ru"],
    ["The Chinese greeting 你好 means hello.", "en"],
    ["The Russian greeting привет means hello.", "en"],
    ["The Japanese greeting こんにちは means hello.", "en"],
    ["The Korean greeting 안녕 means hello.", "en"],
    ["The Hebrew greeting שלום means hello.", "en"],
    ["中文说明应当使用中文音色，末尾包含 Python API 术语。", "zh"],
    ["今天は晴天です。", "ja"],
    ["这是中文说明，日语字符「あ」只是一个示例，请继续使用中文朗读。", "zh"],
    ["中文回答中提到日语问候语こんにちは，但这段话的主要内容仍然是中文。", "zh"],
    ["中中中aa", "en"],
    ["中中中中aa", "zh"],
    ["中中aabb", "en"],
    ["1234，。!? שלום!", "he"],
    ["1234!?", "en"],
    ["", "en"],
    ["𠀀𠀀𠀀𠀀a", "zh"],
    ["שָׁלוֹם", "he"],
  ]) assert.equal(language(text), expected, text);
  for (const explicit of ["es", "fr", "de", "it", "pt", "he"]) {
    env.CODEX_LINUX_READ_ALOUD_LANGUAGE = ` ${explicit.toUpperCase()} `;
    assert.equal(language("This is a test."), explicit);
  }
});

test("main bundle patch adds a Linux read aloud handler", () => {
  const source = [
    "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
    MAIN_FIXTURE,
  ].join("");
  const patched = twice(applyMainBundlePatch, source);
  assert.equal(patched.split("/*codex-linux-read-aloud-route*/").length - 1, 1);
  assert.match(patched, /async handleRequest\(e,t\)\{\/\*codex-linux-read-aloud-route\*\/if\("vscode:\/\/codex\/linux-read-aloud"===t\?\.url\)return void await codexLinuxReadAloudFetch\(t,/);
  assert.match(patched, /this\.options\.chunkedMessageSender\.sendInlineMessageForView\(e,codexLinuxReadAloudMessage\)/);
  assert.doesNotMatch(patched, /"get-global-state"|"set-global-state"/);
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
  assert.match(patched, /CODEX_LINUX_READ_ALOUD_KOKORO_LANGUAGE_VOICE/);
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
  assert.match(patched, /let espeakVoice=voice\|\|\(language===`en`\?`en-us`:nativeLanguage\);/);
  assert.doesNotThrow(() => new Function("require", "process", patched));
});

test("main route answers read aloud webview fetches through the inline view sender", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-route-"));
  try {
    const patched = twice(applyMainBundlePatch, MAIN_FIXTURE);
    const sent = [];
    const requireStub = name => name === "node:child_process" ? { spawnSync: () => ({status:1}) } : require(name);
    const runtime = graphRuntime(patched, requireStub, {
      platform: "linux",
      env: { HOME: root, XDG_CONFIG_HOME: path.join(root, "config") },
    }, sent);
    const wrapper = { handleRequest: (view, payload) => runtime.request(view, payload) };
    const view = { id: 7 };
    const request = (requestId, body) => wrapper.handleRequest(view, {
      type: "fetch",
      hostId: "local",
      requestId,
      method: "POST",
      url: "vscode://codex/linux-read-aloud",
      body: JSON.stringify(body),
    });

    await request("r1", { action: "get-setting", key: "codex-linux-read-aloud-enabled" });
    await request("r2", { action: "set-setting", key: "codex-linux-read-aloud-enabled", value: true });
    await request("r3", { action: "set-setting", key: "codex-linux-read-aloud-kokoro-speed", value: 9 });
    await request("r4", { action: "get-setting", key: "codex-linux-read-aloud-kokoro-speed" });
    await request("r5", { action: "set-setting", key: "codex-linux-read-aloud-kokoro-model", value: "/tmp/x" });
    await wrapper.handleRequest(view, { requestId: "r6", url: "vscode://codex/linux-read-aloud", body: "{" });

    assert.deepEqual(sent.map(({ webContents }) => webContents), Array(6).fill(view));
    const responses = sent.map(({ message }) => message);
    assert.deepEqual(responses.map(({ requestId, responseType, type }) => [type, requestId, responseType]), [
      ["fetch-response", "r1", "success"],
      ["fetch-response", "r2", "success"],
      ["fetch-response", "r3", "success"],
      ["fetch-response", "r4", "success"],
      ["fetch-response", "r5", "error"],
      ["fetch-response", "r6", "error"],
    ]);
    assert.deepEqual(JSON.parse(responses[0].bodyJsonString), { value: false });
    assert.deepEqual(JSON.parse(responses[1].bodyJsonString), { success: true, value: true });
    assert.deepEqual(JSON.parse(responses[2].bodyJsonString), { success: true, value: 1.4 });
    assert.deepEqual(JSON.parse(responses[3].bodyJsonString), { value: 1.4 });
    assert.match(responses[4].error, /Unsupported read aloud setting/);
    assert.match(responses[5].error, /Invalid read aloud request/);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, "config", "codex-desktop", "settings.json"), "utf8")),
      { "codex-linux-read-aloud-enabled": true, "codex-linux-read-aloud-kokoro-speed": 1.4 },
    );

    sent.length = 0;
    await wrapper.handleRequest(view, { requestId: "d1", url: "/codex/dictation-stream-connect-info" });
    assert.deepEqual(sent.map(({ message }) => [message.requestId, message.responseType]), [["d1", "success"]]);
    await assert.rejects(
      wrapper.handleRequest(view, { requestId: "x1", url: "https://example.invalid/" }),
      /HTTP requests must use the HTTP fetch service/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main route fails closed on missing, duplicate or drifted fetch entries", () => {
  const missing = MAIN_FIXTURE.replace('"/codex/dictation-stream-connect-info"', '"/codex/other"');
  const duplicate = `${MAIN_FIXTURE}${MAIN_FIXTURE.replace("RequestWrapper", "OtherWrapper")}`;
  const noInlineSender = MAIN_FIXTURE.replaceAll(
    "this.options.chunkedMessageSender.sendInlineMessageForView(",
    "this.options.chunkedMessageSender.sendMessageForView(",
  );
  for (const source of [missing, duplicate, noInlineSender]) {
    const { result, warnings } = captureWarnings(() => applyMainBundlePatch(source));
    assert.equal(result, source);
    assert.match(warnings.join("\n"), /native read aloud request owner/);
  }
  const patched = applyMainBundlePatch(MAIN_FIXTURE);
  const partial = patched.replace("/*codex-linux-read-aloud-route*/", "");
  const { result, warnings } = captureWarnings(() => applyMainBundlePatch(partial));
  assert.equal(result, partial);
  assert.match(warnings.join("\n"), /native read aloud request owner|incomplete read aloud route\/helper ownership/);
});

test("main route composes with other Linux fetch routes in the same request entry", () => {
  const foreignRoute = "/*codex-linux-chronicle-skysight-route*/if(codexLinuxChronicleFetchHandler(t?.url))return void await codexLinuxChronicleFetch(t,m=>this.options.chunkedMessageSender.sendInlineMessageForView(e,m));";
  const routed = MAIN_FIXTURE.replace("async handleRequest(e,t){", `async handleRequest(e,t){${foreignRoute}`);
  const patched = applyMainBundlePatch(routed);
  assert.notEqual(patched, routed);
  assert.equal(applyMainBundlePatch(patched), patched);
  assert.ok(patched.includes(`async handleRequest(e,t){/*codex-linux-read-aloud-route*/`));
  assert.ok(patched.includes(`${foreignRoute}if("/codex/dictation-stream-connect-info"===t.url)`));
  const unknownPrefix = MAIN_FIXTURE.replace("async handleRequest(e,t){", "async handleRequest(e,t){otherCode();");
  const { result, warnings } = captureWarnings(() => applyMainBundlePatch(unknownPrefix));
  assert.equal(result, unknownPrefix);
  assert.match(warnings.join("\n"), /native read aloud request owner/);
});

test("main handler does not capture a function-local child-process alias from another feature", () => {
  const source = [
    'function injectedFeature(){let __codexChild=require(`node:child_process`);return __codexChild}',
    'let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);',
    MAIN_FIXTURE,
  ].join("");
  const patched = applyMainBundlePatch(source);

  assert.match(patched, /require\(`node:child_process`\)\.spawn\(command,args/);
  assert.doesNotMatch(patched, /let child=__codexChild\.spawn\(command,args/);
});

for (const [label, prefix] of [
  ["Record & Replay helper", require("../record-and-replay/patch.js").recordReplayHelperSource({
    fsVar: "require(`node:fs`)", pathVar: "require(`node:path`)",
  }) + 'let f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);'],
  ["nested builtin aliases", 'function injectedFeature(){let nestedFs=require(`node:fs`),nestedPath=require(`node:path`),nestedOs=require(`node:os`);return [nestedFs,nestedPath,nestedOs]}'],
  ["local-name collisions", 'let e=require(`node:fs`),n=require(`node:path`),t=require(`node:os`);'],
  ["no existing builtin aliases", ""],
]) {
  test(`main helper resolves builtins independently of ${label}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-alias-"));
    try {
      const source = prefix + MAIN_FIXTURE;
      const patched = twice(applyMainBundlePatch, source);
      const runtime = new Function("require", "process", `const exports={};${patched};return {
        home:codexLinuxReadAloudHome,
        settingsPath:codexLinuxReadAloudSettingsPath,
        writeSettings:codexLinuxReadAloudWriteSettings,
        settings:codexLinuxReadAloudSettings,
        model:codexLinuxReadAloudKokoroModel,
        python:codexLinuxReadAloudKokoroPython
      };`)(name => name === "node:os" ? { homedir: () => root } : require(name), {
        platform: "linux", env: {},
      });
      assert.equal(runtime.home(), root);
      assert.equal(runtime.settingsPath(), path.join(root, ".config", "codex-desktop", "settings.json"));
      runtime.writeSettings({ "codex-linux-read-aloud-enabled": true });
      assert.deepEqual(runtime.settings(), { "codex-linux-read-aloud-enabled": true });
      assert.equal(runtime.model(), path.join(root, ".local", "share", "kokoro", "kokoro-v1.0.onnx"));
      assert.equal(runtime.python(), path.join(root, ".local", "share", "codex-desktop", "read-aloud", "kokoro-venv", "bin", "python"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("main helper requires Electron in its outer CJS scope without borrowing factory aliases", () => {
  const prefix = 'function otherFactory(){let c=require("electron");return c}';
  const source = prefix + MAIN_FIXTURE, patched = twice(applyMainBundlePatch, source);
  assert.ok(patched.includes(prefix));
  assert.match(patched, /electronApi=require\(`electron`\)/);
  assert.doesNotMatch(patched, /electronApi=c\b/);
});

test("webview runtime appends only once", () => {
  const patched = twice(applyIndexRuntimePatch, "console.log(`index`);");
  assert.match(patched, /codexLinuxReadAloudClick/);
  assert.match(patched, /vscode:\/\/codex\/"\+method/);
  assert.match(patched, /function getSetting\(key\)\{return post\(\{action:"get-setting",key\}\)/);
  assert.match(patched, /function setSetting\(key,value\)\{return post\(\{action:"set-setting",key,value\}\)/);
  assert.match(patched, /globalThis\.codexLinuxReadAloudMountSettings=mountSettings/);
  assert.doesNotMatch(patched, /get-global-state|set-global-state/);
  assert.match(patched, /codex-message-from-view/);
  assert.match(patched, /__codexForwardedViaBridge/);
  assert.match(patched, /Starting voice/);
  assert.match(patched, /kokoro-explicit-v6/);
  assert.match(patched, /codexLinuxConversationIsSpeaking/);
  assert.match(patched, /codexLinuxConversationStopSpeaking/);
  assert.match(patched, /speechSynthesis\?\.cancel/);
  assert.match(patched, /action:"speak",source:"button",text/);
  assert.match(patched, /codexLinuxReadAloudSetup/);
  assert.match(patched, /action:"setup",mode/);
  assert.match(patched, /9e5/);
  assert.throws(() => applyIndexRuntimePatch("globalThis.codexLinuxReadAloudClick=()=>{};"), /Incomplete, duplicate or misplaced Read Aloud runtime/);
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"choose-folder"});`,
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"choose-folder"});`,
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"choose-folder"});`,
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"setup",mode:"download"});`,
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"config"});`,
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"config"});`,
    )(requireStub, {
      platform: "linux",
      env: { HOME: root },
      resourcesPath: path.join(root, "resources"),
    });
    const disabledConfig = await new Function(
      "require",
      "process",
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"config"});`,
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
      MAIN_FIXTURE,
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
            return fakeSpeechChild(args?.[0] === "-C");
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"hello"});`,
    )(requireStub, processStub);
    assert.equal(buttonResult.spoken, true);
    assert.equal(buttonResult.engine, "spd-say");
    assert.ok(spawned.some((entry) => entry.command === "spd-say" && entry.args.includes("--")));

    const directResult = await new Function(
      "require",
      "process",
      `const exports={};${patched};return codexLinuxReadAloudSpeak("hello");`,
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
      MAIN_FIXTURE,
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
            return fakeSpeechChild(args?.[0] === "-C");
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"hello"});`,
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

    const chineseResult = await new Function(
      "require",
      "process",
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"你好，这是中文朗读测试。"});`,
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
    assert.equal(chineseResult.spoken, true);
    assert.equal(chineseResult.lang, "cmn");
    assert.equal(chineseResult.voice, "zf_xiaobei");
    assert.equal(spawned[1]?.options?.env?.CODEX_LINUX_READ_ALOUD_KOKORO_MODEL, model);
    assert.equal(spawned[1]?.options?.env?.CODEX_LINUX_READ_ALOUD_KOKORO_VOICES, voices);
    assert.equal(spawned[1]?.options?.env?.CODEX_LINUX_READ_ALOUD_KOKORO_LANG, "cmn");
    for (const text of ["The Chinese greeting 你好 means hello.", "The Russian greeting привет means hello."]) {
      const mixed = await new Function("require", "process", "text", `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text});`)(requireStub, {
        platform: "linux",
        env: {
          HOME: root,
          CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON: python,
          CODEX_LINUX_READ_ALOUD_KOKORO_MODEL: model,
          CODEX_LINUX_READ_ALOUD_KOKORO_VOICES: voices,
        },
        resourcesPath,
      }, text);
      assert.equal(mixed.language, "en");
      assert.equal(mixed.voice, "bm_george");
      assert.equal(mixed.lang, "en-us");
      assert.equal(spawned.at(-1).options.env.CODEX_LINUX_READ_ALOUD_KOKORO_VOICE, "bm_george");
    }

    for (const text of ["שלום עולם", "Привет мир", "안녕하세요"]) {
      const overridden = await new Function("require", "process", "text", `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text});`)(requireStub, {
        platform: "linux",
        env: {
          HOME: root,
          CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON: python,
          CODEX_LINUX_READ_ALOUD_KOKORO_MODEL: model,
          CODEX_LINUX_READ_ALOUD_KOKORO_VOICES: voices,
          CODEX_LINUX_READ_ALOUD_KOKORO_VOICE: "af_heart",
          CODEX_LINUX_READ_ALOUD_KOKORO_LANG: "en-us",
          CODEX_LINUX_READ_ALOUD_NATIVE_FALLBACK: "0",
        },
        resourcesPath,
      }, text);
      assert.equal(overridden.spoken, true);
      assert.equal(overridden.engine, "kokoro");
      assert.equal(overridden.voice, "af_heart");
      assert.equal(overridden.lang, "en-us");
    }

    for (const [overrides, expectedVoice, expectedLang] of [
      [{ CODEX_LINUX_READ_ALOUD_LANGUAGE: "en" }, "bm_george", "en-us"],
      [{ CODEX_LINUX_READ_ALOUD_KOKORO_VOICE: "af_heart", CODEX_LINUX_READ_ALOUD_KOKORO_LANG: "en-us" }, "af_heart", "en-us"],
      [{ CODEX_LINUX_READ_ALOUD_KOKORO_VOICE: "af_heart", CODEX_LINUX_READ_ALOUD_KOKORO_LANGUAGE_VOICE: "zf_xiaoni" }, "zf_xiaoni", "cmn"],
    ]) {
      const overridden = await new Function(
        "require", "process",
        `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"你好，这是中文测试。"});`,
      )(requireStub, {
        platform: "linux",
        env: {
          HOME: root,
          CODEX_LINUX_READ_ALOUD_KOKORO_PYTHON: python,
          CODEX_LINUX_READ_ALOUD_KOKORO_MODEL: model,
          CODEX_LINUX_READ_ALOUD_KOKORO_VOICES: voices,
          ...overrides,
        },
        resourcesPath,
      });
      assert.equal(overridden.voice, expectedVoice);
      assert.equal(overridden.lang, expectedLang);
      assert.equal(spawned.at(-1).options.env.CODEX_LINUX_READ_ALOUD_KOKORO_VOICE, expectedVoice);
      assert.equal(spawned.at(-1).options.env.CODEX_LINUX_READ_ALOUD_KOKORO_LANG, expectedLang);
    }

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main handler falls back to native speech without forcing spd-say voice type", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      MAIN_FIXTURE,
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
            return fakeSpeechChild(args?.[0] === "-C");
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"hello"});`,
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

    const chineseResult = await new Function(
      "require",
      "process",
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"你好，这是中文测试。"});`,
    )(requireStub, {
      platform: "linux",
      env: { HOME: root, CODEX_LINUX_READ_ALOUD_ENABLED: "1" },
      resourcesPath: path.join(root, "resources"),
    });
    assert.equal(chineseResult.spoken, true);
    assert.equal(chineseResult.engine, "spd-say");
    const chineseCall = spawned.find(
      (entry) => entry.command === "spd-say" && entry.args.includes("cmn"),
    );
    assert.ok(chineseCall);
    const hebrewResult = await new Function(
      "require", "process",
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text:"שלום עולם"});`,
    )(requireStub, {
      platform: "linux",
      env: { HOME: root, CODEX_LINUX_READ_ALOUD_ENABLED: "1" },
      resourcesPath: path.join(root, "resources"),
    });
    assert.equal(hebrewResult.language, "he");
    assert.ok(spawned.some(({ command, args }) => command === "spd-say" && args.includes("he")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native espeak fallback preserves English defaults and configured voices", async () => {
  const source = [
    "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
    MAIN_FIXTURE,
  ].join("");
  const patched = twice(applyMainBundlePatch, source);
  for (const [text, overrides, expectedVoice] of [
    ["This is a test.", {}, "en-us"],
    ["你好，这是中文测试。", {}, "cmn"],
    ["שלום עולם", {}, "he"],
    ["test", { CODEX_LINUX_READ_ALOUD_LANGUAGE: "hi" }, "hi"],
    ["שלום עולם", { CODEX_LINUX_READ_ALOUD_VOICE: "configured-voice" }, "configured-voice"],
  ]) {
    const spawned = [];
    const requireStub = (name) => {
      if (name === "node:fs") return { existsSync: () => false, accessSync() { throw Error("missing"); }, constants: fs.constants };
      if (name === "node:child_process") return {
        spawnSync: (command, args) => ({ status: command === "which" && args[0] === "espeak-ng" ? 0 : 1 }),
        spawn: (command, args) => { spawned.push({ command, args }); return fakeSpeechChild(args?.[0] === "-C"); },
      };
      return require(name);
    };
    const result = await new Function("require", "process", "text", `const exports={};${patched};return codexLinuxReadAloudHandle({action:"speak",source:"button",text});`)(
      requireStub, { platform: "linux", env: overrides, resourcesPath: "/missing" }, text,
    );
    assert.equal(result.engine, "espeak-ng");
    assert.equal(spawned.at(-1).args[1], expectedVoice);
  }
});

test("main handler exposes Hugging Face Kokoro download defaults", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-main-"));
  try {
    const source = [
      "let e=require(`node:child_process`),f=require(`node:fs`),p=require(`node:path`),o=require(`node:os`);",
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudHandle({action:"config"});`,
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
      MAIN_FIXTURE,
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
      `const exports={};${patched};return codexLinuxReadAloudDownloadFile("https://huggingface.co/test.bin", ${JSON.stringify(target)}, 10);`,
    )(requireStub, processStub);

    assert.equal(fs.readFileSync(target, "utf8"), "downloaded voice bytes");
    assert.equal(fs.existsSync(`${target}.part`), false);
    assert.equal(observedHeaders?.["User-Agent"], "codex-desktop-read-aloud");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function assistantRenderFixture({ jsxVar = "s", component = "eA.F" } = {}) {
  const sourceTurnCall = `(0,${jsxVar}.jsx)(${component},{item:o,alwaysShowActions:ge,assistantCopyText:a,sourceTurnId:T,savedContentResponseId:E,after:A,compactAttachment:M,electronAfter:N,autoReviewStats:L,hookStats:R,completedThreadGoal:te,conversationId:p,cwd:b,hostId:x,reportEntityType:S,markdownMediaCacheKey:e,projectlessOutputDirectory:Ee,outputFileLinks:O,forceCodeBlockWordWrap:Ye,hasArtifacts:De,onAddResponseTextAnnotation:s,onNavigateResponseTextAnnotation:qe,onFileLinkOpen:I,onFork:ie,renderCodeBlocksAsWritingBlocks:Ye,showActionRow:_e,showTimestampHeader:r,showTimestampWithoutActions:ye,timestampHoverOnly:be,trailingActions:fe})`;
  const liveTurnCall = `(0,${jsxVar}.jsx)(${component},{item:n,showShimmer:we,alwaysShowActions:ge,assistantCopyText:w,turnId:T,savedContentResponseId:E,autoReviewStats:L,hookStats:R,completedThreadGoal:te,after:A,compactAttachment:M,electronAfter:N,conversationId:p,getVisualizeTurnTriggerType:m,cwd:b,hostId:x,reportEntityType:S,markdownMediaCacheKey:e,projectlessOutputDirectory:Ee,outputFileLinks:O,forceCodeBlockWordWrap:Ye,hasArtifacts:De,onAddResponseTextAnnotation:i,onNavigateResponseTextAnnotation:qe,onFileLinkOpen:I,onFork:ie,renderCodeBlocksAsWritingBlocks:Ye,showActionRow:_e,showTimestampHeader:r,showTimestampWithoutActions:ye,timestampHoverOnly:be,allowCopyWhileStreaming:Fe,additionalActions:ce,trailingActions:fe,persistentAdditionalActions:de})`;
  const componentMatch = /^([\w$]+)\.([\w$]+)$/.exec(component);
  const namespace = componentMatch?.[1] ?? component;
  const componentExport = componentMatch?.[2] ?? "F";
  const props = [...new Set([...(`${sourceTurnCall}${liveTurnCall}`).matchAll(/(?:^|[,{}])([\w$]+):/g)].map(match => match[1]))];
  const nativeComponent = `Component(e,t,n){n.d(t,{${componentExport}:()=>row});function row(props){let{${props.map((name,index)=>`${name}:value${index}`).join(",")}}=props;return null}}`;
  const prefix = 'export const __rspack_esm_ids=[366297];export const __webpack_modules__={';
  const source = prefix + `Producer(e,t,n){n.d(t,{F:()=>render});var ${jsxVar}=n("Jsx"),${namespace}=n("Component");` +
    `const partition={collapsibleUnits:[],persistentUnits:[]};function render(props){return[${sourceTurnCall},${liveTurnCall}]}},${nativeComponent}};`;
  return { liveTurnCall, prefix, source, sourceTurnCall };
}

test("assistant render patch atomically adds buttons to the current two-call topology", () => {
  const fixture = assistantRenderFixture();
  const patched = twice(applyAssistantRenderPatch, fixture.source);
  assert.equal((patched.match(/codex-linux-read-aloud-button/g) ?? []).length, 2);
  assert.equal((patched.match(/codex-linux-read-aloud-icon/g) ?? []).length, 2);
  assert.equal((patched.match(/viewBox:"0 0 24 24"/g) ?? []).length, 2);
  assert.doesNotMatch(patched, /children:"Read aloud"/);
  assert.match(patched, /globalThis\.codexLinuxReadAloudClick\?\.\(codexLinuxReadAloudChild\.props\.item,codexLinuxReadAloudChild\.props\.assistantCopyText,codexLinuxReadAloudChild\.props\.conversationId,codexLinuxReadAloudEvent\.currentTarget\)/);
  assert.ok(patched.includes(fixture.sourceTurnCall));
  assert.ok(patched.includes(fixture.liveTurnCall));
  assert.equal(matchesAssistantRuntimeContract(patched), true);
});

test("assistant render patch ignores normalized assistant items without render props", () => {
  const source = "case`agentMessage`:{let s=e.status===`inProgress`&&d>=0&&t===d,l=s&&Spt(i.content);a.push({type:`assistant-message`,content:m,completed:!s,renderPlaceholderWhileStreaming:l});break}";
  const { result: patched, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("assistant render patch still warns when an assistant render candidate drifts", () => {
  const source = "return (0,Q.jsx)(Ov,{item:n,assistantCopyText:p,conversationId:o,renderCodeBlocksAsWritingBlocks:V})";
  const { result: patched, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(patched, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Could not find complete assistant message render call set/);
});

test("assistant render patch ignores the current shared component definition", () => {
  const source = "function Bzn({item:e,assistantCopyText:n,conversationId:l,renderCodeBlocksAsWritingBlocks:C=!1}){return e.completed&&n!=null?l:null}";
  const { result: patched, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(patched, source);
  assert.deepEqual(warnings, []);
});

test("assistant render patch preserves the current JSX runtime alias across both calls", () => {
  const patched = twice(applyAssistantRenderPatch, assistantRenderFixture({ jsxVar: "Q" }).source);

  assert.equal((patched.match(/Q\.Fragment/g) ?? []).length, 2);
  assert.equal((patched.match(/\(0,Q\.jsx\)\("button"/g) ?? []).length, 2);
});

test("assistant render patch ignores unrelated JSX calls beside the complete topology", () => {
  const fixture = assistantRenderFixture();
  const unrelated = `(0,$.jsx)(Other,{item:q,label:"Preview",conversationId:s})`;
  const source = `${fixture.source};${unrelated}`;
  const patched = applyAssistantRenderPatch(source);

  assert.equal((patched.match(/codex-linux-read-aloud-button/g) ?? []).length, 2);
  assert.equal(patched.endsWith(unrelated), true);
});

test("assistant render patch rejects a missing current render call without modifying the asset", () => {
  const fixture = assistantRenderFixture();
  const source = fixture.source.replace(fixture.sourceTurnCall, "null");
  const { result, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(result, source);
  assert.equal(matchesAssistantRuntimeContract(source), false);
  assert.equal(warnings.length, 1);
});

test("assistant render patch rejects an additional assistant-shaped call without modifying the asset", () => {
  const fixture = assistantRenderFixture();
  const extra = `(0,$.jsx)(Other,{item:q,assistantCopyText:r,conversationId:s})`;
  const source = fixture.source.replace(fixture.liveTurnCall, fixture.liveTurnCall + "," + extra);
  const { result, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(result, source);
  assert.equal(matchesAssistantRuntimeContract(source), false);
  assert.equal(warnings.length, 1);
});

test("assistant render patch rejects duplicate topology roles without modifying the asset", () => {
  const fixture = assistantRenderFixture();
  const source = fixture.source.replace(fixture.liveTurnCall, fixture.sourceTurnCall);
  const { result, warnings } = captureWarnings(() => applyAssistantRenderPatch(source));

  assert.equal(result, source);
  assert.equal(matchesAssistantRuntimeContract(source), false);
  assert.equal(warnings.length, 1);
});

test("assistant render patch rejects mixed patched and unpatched topology without modifying the asset", () => {
  const fixture = assistantRenderFixture();
  const patched = applyAssistantRenderPatch(fixture.source);
  const firstWrapperStart = patched.indexOf("/*codex-linux-read-aloud-assistant:source-turn*/");
  const firstNative = patched.indexOf(fixture.sourceTurnCall, firstWrapperStart);
  assert.ok(firstWrapperStart >= 0 && firstNative > firstWrapperStart);
  const firstWrapperEnd = firstNative + fixture.sourceTurnCall.length + 1;
  const mixed = patched.slice(0, firstWrapperStart) + fixture.sourceTurnCall + patched.slice(firstWrapperEnd);

  const { result, warnings } = captureWarnings(() => applyAssistantRenderPatch(mixed));

  assert.equal(result, mixed);
  assert.equal(matchesAssistantRuntimeContract(mixed), false);
  assert.equal(warnings.length, 1);
});

test("assistant runtime descriptor targets the current assistant render chunk by content", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "assistant-runtime");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern, undefined);
  assert.equal(descriptor.assetPattern, undefined);
  assert.deepEqual(descriptor.assetNeedles, ["collapsibleUnits:", "persistentUnits:", "assistantCopyText:"]);
  assert.equal(descriptor.assetMatch(assistantRenderFixture({ jsxVar: "Q" }).source), true);
  assert.equal(descriptor.assetMatch(assistantRenderFixture({ component: "Vb" }).source), false);
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  assert.equal(descriptor.assetMatch("const unrelated=true"), false);
});

function runtimeEntryFixture(id = 348410) {
  return 'var cache={},modules={Main(e,t,r){t.ready=true},Gav4(e,t,r){let marker="codex-host-chunked-message-v1";r.d(t,{},{I:marker,Z:function(message){return "marker"in message&&message.marker===marker&&"transferId"in message&&"sequence"in message&&Number.isSafeInteger(message.sequence)&&"kind"in message&&"tokens"in message&&Array.isArray(message.tokens)}})},Receiver(e,t,r){var codec=r("Gav4");r.d(t,{},{read:class{receive(message){return (0,codec.Z)(message)?message:null}}})},Router(e,t,r){var codec=r("Gav4"),receiver=r("Receiver");let instance=new receiver.read;r.d(t,{},{route:function(message){return message.marker===codec.I?instance.receive(message):null}})}};function req(id){var item=cache[id];if(item)return item.exports;var item=cache[id]={exports:{}};modules[id].call(item.exports,item,item.exports,req);return item.exports}var exported=req;import*as shared from"./shared.js";req.C(shared);var boot=req.O(void 0,["1"],()=>req("Main"));req.O(boot);export{exported as __webpack_require__};\n//# sourceMappingURL=' + id + '.js.map';
}

function runtimeAppFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-entry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assets = path.join(root, "webview/assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(root, "webview/index.html"), '<script type="module" src="/assets/shared.js"></script><script type="module" src="/assets/main.js"></script>');
  fs.writeFileSync(path.join(root, "webview/detached-window.html"), '<script type="module" src="/assets/shared.js"></script><script type="module" src="/assets/detached.js"></script>');
  fs.writeFileSync(path.join(assets, "main.js"), runtimeEntryFixture());
  fs.writeFileSync(path.join(assets, "detached.js"), runtimeEntryFixture(357055));
  fs.writeFileSync(path.join(assets, "shared.js"), 'export const __rspack_esm_ids=["1"];export const __webpack_modules__={Support(e,t,r){t.ready=true}};');
  const descriptor = featurePatches.find(patch => patch.id === "webview-runtime");
  const selected = normalizePatchDescriptors([{ ...descriptor, featureId: "read-aloud", sourceKind: "feature" }]);
  return { root, assets, run() {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview");
    return report.patches[0];
  } };
}

function runtimeFixtureBytes(fixture) {
  return Object.fromEntries(["webview/index.html", "webview/detached-window.html", "webview/assets/main.js", "webview/assets/detached.js", "webview/assets/shared.js"]
    .map(name => [name, fs.readFileSync(path.join(fixture.root, name), "utf8")]));
}

function assertRuntimeFixtureBytes(fixture, expected) {
  for (const [name, text] of Object.entries(expected)) assert.equal(fs.readFileSync(path.join(fixture.root, name), "utf8"), text, name);
}

test("webview runtime descriptor qualifies native entry bindings and complete source", () => {
  const descriptor = featurePatches.find(patch => patch.id === "webview-runtime");
  assert.equal(descriptor.phase, "extracted-app:pre-webview");
  const raw = runtimeEntryFixture();
  const patched = twice(applyRuntimeEntryPatch, raw);
  assert.ok(patched.startsWith(raw));
  assert.equal(patched.split('globalThis.codexLinuxReadAloudVersion=VERSION').length - 1, 1);
  for (const variant of [
    patched.replace('const METHOD="linux-read-aloud"', 'const METHOD="wrong-handler"'),
    patched + applyIndexRuntimePatch(""),
    raw.replace('var exported=req;', 'var exported=other;'),
    raw.replace('var exported=req;', 'var exported=req;exported=other;'),
    raw.replace('Array.isArray(message.tokens)', 'Array.isArray(other.tokens)'),
    raw.replace('(0,codec.Z)(message)', '(0,other.Z)(message)'),
    raw.replace('message.marker===codec.I', 'message.marker===other.I'),
    raw.replace('receiver=r("Receiver")', 'receiver=r("Other")'),
    raw.replace('new receiver.read', 'new other.read'),
    raw.replace('var boot=req.O', 'if(false)var boot=req.O'),
  ]) {
    const result = captureWarnings(() => applyRuntimeEntryPatch(variant));
    assert.equal(result.result, variant);
    assert.equal(result.warnings.length, 1);
  }
  const markerData = raw + '\n/*kokoro-explicit-v6*/';
  assert.notEqual(applyRuntimeEntryPatch(markerData), markerData);
  const unrelated = 'export const unrelated=1;';
  assert.equal(captureWarnings(() => applyRuntimeEntryPatch(unrelated)).result, unrelated);
});

function assertRuntimeAuthorityRefusal(t, source, label) {
  const result = captureWarnings(() => applyRuntimeEntryPatch(source));
  assert.equal(result.result, source, label);
  assert.equal(result.warnings.length, 1, label);
  const fixture = runtimeAppFixture(t);
  for (const name of ["main.js", "detached.js"]) fs.writeFileSync(path.join(fixture.assets, name), source);
  const bytes = runtimeFixtureBytes(fixture), oldWrite = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
  try { assert.equal(fixture.run().status, "skipped-optional", label); }
  finally { fs.writeFileSync = oldWrite; }
  assert.equal(writes, 0, label);
  assertRuntimeFixtureBytes(fixture, bytes);
}

test("UP61 authority rejects owned global destruction and nested free binding writes", t => {
  for (const tail of [
    'delete globalThis.codexLinuxReadAloudClick;',
    'delete globalThis["codexLinuxReadAloudSetup"];',
    "delete (window['codexLinuxReadAloudClick']);",
    'globalThis.codexLinuxReadAloudClick++;',
    '++globalThis.codexLinuxReadAloudClick;',
    'globalThis.codexLinuxReadAloudClick&&=null;',
    'globalThis[`codexLinuxReadAloudSetup`]||=null;',
    'Object.defineProperty(globalThis,"codexLinuxReadAloudClick",{value:null});',
    'Reflect.deleteProperty(globalThis,"codexLinuxReadAloudClick");',
    'Reflect.set(globalThis,"codexLinuxReadAloudClick",null);',
    'function rebind(){exported=other;}rebind();',
    'function rebind(){req=other;}rebind();',
    'function rebind(){modules={};}rebind();',
    'function rebind(){exported??=other;}rebind();',
    'function rebind(){(exported)=other;}rebind();',
    'function rebind(){++(exported);}rebind();',
    'function rebind(){++exported;}rebind();',
    'function rebind(){({value:exported}=other);}rebind();',
    'function rebind(){[exported]=other;}rebind();',
    'function rebind(){for(exported of other){}}rebind();',
    'function rebind(){\\u0065xported=other;}rebind();',
    'const rebind=()=>exported=other;rebind();',
  ]) {
    const raw = runtimeEntryFixture();
    const source = !tail.includes("rebind") ? applyRuntimeEntryPatch(raw) + "\n" + tail
      : raw.replace('var exported=req;', 'var exported=req;' + tail);
    assertRuntimeAuthorityRefusal(t, source, tail);
  }
});

test("UP61 authority V3 refuses optional owned deletion from the independent witness", t => {
  assertRuntimeAuthorityRefusal(t, applyRuntimeEntryPatch(runtimeEntryFixture()) + '\ndelete globalThis?.codexLinuxReadAloudClick;', "optional owned delete");
});

test("UP61 authority V3 refuses nested shift write from the independent witness", t => {
  const source = runtimeEntryFixture().replace('var exported=req;', 'var exported=req;function rebind(){exported<<=1;}rebind();');
  assertRuntimeAuthorityRefusal(t, source, "nested shift write");
});

test("UP61 authority V3 covers the complete assignment and update operator table", t => {
  const assignments = ["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "^=", "|=", "&&=", "||=", "??="];
  const expressions = assignments.map(operator => target => target + operator + "1");
  expressions.push(target => "++" + target, target => "--" + target, target => target + "++", target => target + "--");
  for (const expression of expressions) {
    const nativeTail = 'function rebind(){' + expression("exported") + ';}rebind();';
    assertRuntimeAuthorityRefusal(t, runtimeEntryFixture().replace('var exported=req;', 'var exported=req;' + nativeTail), nativeTail);
    for (const target of ['globalThis.codexLinuxReadAloudClick', 'globalThis["codexLinuxReadAloudClick"]']) {
      const tail = expression(target) + ";";
      assertRuntimeAuthorityRefusal(t, applyRuntimeEntryPatch(runtimeEntryFixture()) + "\n" + tail, tail);
    }
    const fixture = runtimeAppFixture(t), shadow = 'function shadow(exported){' + expression("exported") + ';}';
    for (const name of ["main.js", "detached.js"]) fs.appendFileSync(path.join(fixture.assets, name), "\n" + shadow);
    assert.equal(fixture.run().status, "applied", shadow);
    assert.equal(fixture.run().status, "already-applied", shadow);
  }
});

test("UP61 authority V3 covers optional static owned deletes and grouped Unicode targets", t => {
  for (const tail of [
    'delete globalThis?.codexLinuxReadAloudClick;',
    'delete window?.codexLinuxReadAloudClick;',
    'delete self?.codexLinuxReadAloudClick;',
    'delete globalThis?.["codexLinuxReadAloudClick"];',
    "delete window?.['codexLinuxReadAloudClick'];",
    'delete self?.[`codexLinuxReadAloudClick`];',
    'delete (globalThis?.codexLinuxReadAloudClick);',
    'delete ((globalThis))?.codexLinuxReadAloudClick;',
    'delete ((globalThis))?.["codexLinuxReadAloudClick"];',
    'delete globalThis?.\\u0063odexLinuxReadAloudClick;',
    'delete globalThis?.["\\u0063odexLinuxReadAloudClick"];',
    'delete globalThis?.["\\x63odexLinuxReadAloudClick"];',
  ]) assertRuntimeAuthorityRefusal(t, applyRuntimeEntryPatch(runtimeEntryFixture()) + "\n" + tail, tail);
});

test("UP61 authority V3 preserves destructuring and iteration target write boundaries", t => {
  for (const expression of [
    '({exported}=other)',
    '({value:exported}=other)',
    '[exported]=other',
    '[exported=other]=values',
    'for(exported of values){}',
    'for(exported in values){}',
    '(exported)++',
    '++(exported)',
    '\\u0065xported<<=1',
  ]) {
    const tail = 'function rebind(){' + expression + ';}rebind();';
    assertRuntimeAuthorityRefusal(t, runtimeEntryFixture().replace('var exported=req;', 'var exported=req;' + tail), tail);
  }
  for (const tail of [
    '({value:globalThis.codexLinuxReadAloudClick}=other);',
    '[globalThis.codexLinuxReadAloudClick]=other;',
    '[globalThis["codexLinuxReadAloudClick"],other]=values;',
    'for([globalThis.codexLinuxReadAloudClick] of values){}',
  ]) assertRuntimeAuthorityRefusal(t, applyRuntimeEntryPatch(runtimeEntryFixture()) + "\n" + tail, tail);
});

test("UP61 authority permits local binding shadows and inert or foreign owned-name data", () => {
  for (const tail of [
    'function shadow(exported){exported=other;}',
    'function shadow({value:exported}){exported<<=1;}',
    'const shadow=({value:exported})=>exported>>=1;',
    'function shadow(){try{}catch({message:exported}){exported>>>=1;}}',
    'const values=[globalThis.codexLinuxReadAloudClick];',
    'const values={value:globalThis.codexLinuxReadAloudClick};',
    'let local;({[globalThis.codexLinuxReadAloudClick]:local}=other);',
    'let local;[local=globalThis.codexLinuxReadAloudClick]=other;',
    'let local;[local=(globalThis.codexLinuxReadAloudClick)]=other;',
    'let local;[local=(globalThis["codexLinuxReadAloudClick"])]=other;',
    'function shadow(){let {value:exported}=other;exported<<=1;}',
    'function shadow(){let [exported]=other;exported>>>=1;}',
    'const read=()=>exported<<1;',
    'globalThis.codexLinuxReadAloudClick===undefined;',
    'globalThis.codexLinuxReadAloudClick<=1;',
    'globalThis.otherFeature<<=1;',
    '/*delete globalThis?.codexLinuxReadAloudClick; exported<<=1;*/',
    'const inert="delete globalThis?.codexLinuxReadAloudClick; exported<<=1;";',
    'function shadow(){let exported;exported=other;}',
    'function shadow(){var exported;{exported=other;}}',
    'function shadow(){if(true){let exported;exported=other;}}',
    'function shadow(){try{}catch(exported){exported=other;}}',
    'function shadow(){for(let exported of other){exported=null;}}',
    'function shadow(){for(let exported=0;exported<2;exported++){exported=1;}}',
    'const shadow=(exported)=>exported=other;',
    'const shadow=(exported=null)=>exported=other;',
    'const shadow=exported=>()=>exported=other;',
    'const shadow=function exported(){exported=other;};',
    'function shadow(req,modules){req=other;modules={};}',
    'class Shadow{static{var exported;exported=null;}}',
    '/*delete globalThis.codexLinuxReadAloudClick;*/',
    'const text="delete globalThis.codexLinuxReadAloudClick;";',
    'globalThis.otherFeature=null;',
    'Object.defineProperty(globalThis,"otherFeature",{value:null});',
  ]) {
    const source = runtimeEntryFixture() + "\n" + tail;
    const result = captureWarnings(() => applyRuntimeEntryPatch(source));
    assert.notEqual(result.result, source, tail);
    assert.equal(result.warnings.length, 0, tail);
    assert.equal(applyRuntimeEntryPatch(result.result), result.result, tail);
  }
});

test("webview runtime descriptor commits the coherent two-entry cohort and validates warm dependencies", t => {
  const fixture = runtimeAppFixture(t), before = runtimeFixtureBytes(fixture);
  assert.equal(fixture.run().status, "applied");
  assert.equal(fixture.run().status, "already-applied");
  for (const name of ["main.js", "detached.js"]) {
    const text = fs.readFileSync(path.join(fixture.assets, name), "utf8");
    assert.equal(text.split('globalThis.codexLinuxReadAloudVersion=VERSION').length - 1, 1);
  }
  assert.equal(fs.readFileSync(path.join(fixture.assets, "shared.js"), "utf8"), before['webview/assets/shared.js']);
  const otherRuntime = '\n;(()=>{globalThis.otherFeature=true})();';
  for (const name of ["main.js", "detached.js"]) fs.appendFileSync(path.join(fixture.assets, name), otherRuntime);
  assert.equal(fixture.run().status, "already-applied");
  for (const name of ["main.js", "detached.js"]) assert.ok(fs.readFileSync(path.join(fixture.assets, name), "utf8").endsWith(otherRuntime));
});

test("webview runtime descriptor resolves a startup producer registered by its imported chunk", t => {
  const fixture = runtimeAppFixture(t);
  for (const name of ["main.js", "detached.js"]) {
    const file = path.join(fixture.assets, name);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('Main(e,t,r){t.ready=true},', ''));
  }
  fs.writeFileSync(path.join(fixture.assets, "shared.js"), 'export const __rspack_esm_ids=["1"];export const __webpack_modules__={Main(e,t,r){t.ready=true}};');
  assert.equal(fixture.run().status, "applied");
  assert.equal(fixture.run().status, "already-applied");
});

test("webview runtime descriptor refuses mixed partial orphan and bad native dependency cohorts before writes", t => {
  for (const kind of ["mixed", "wrong-handler", "orphan", "hidden-peer", "hidden-single", "hidden-template", "hidden-unicode", "hidden-hex", "missing-import", "wrong-startup", "html-role", "duplicate-html"]) {
    const fixture = runtimeAppFixture(t);
    if (["mixed", "wrong-handler"].includes(kind)) {
      fs.writeFileSync(path.join(fixture.assets, "main.js"), applyRuntimeEntryPatch(runtimeEntryFixture()));
      if (kind === "wrong-handler") fs.writeFileSync(path.join(fixture.assets, "main.js"), fs.readFileSync(path.join(fixture.assets, "main.js"), "utf8").replace('const METHOD="linux-read-aloud"', 'const METHOD="wrong-handler"'));
    } else if (kind === "orphan") fs.writeFileSync(path.join(fixture.assets, "extra.js"), applyIndexRuntimePatch(""));
    else if (kind.startsWith("hidden-")) {
      const peers = {
        "hidden-peer": 'globalThis["codexLinuxReadAloudVersion"]="v6";',
        "hidden-single": "globalThis['codexLinuxReadAloudClick']=()=>{};",
        "hidden-template": 'globalThis[`codexLinuxReadAloudSetup`]=()=>{};',
        "hidden-unicode": 'globalThis.\\u0063odexLinuxReadAloudClick=()=>{};',
        "hidden-hex": "globalThis['\\x63odexLinuxReadAloudSetup']=()=>{};",
      };
      fs.writeFileSync(path.join(fixture.assets, "extra.js"), peers[kind]);
    }
    else if (kind === "missing-import") fs.writeFileSync(path.join(fixture.assets, "main.js"), runtimeEntryFixture().replace('req.C(shared);', 'other.C(shared);'));
    else if (kind === "wrong-startup") fs.writeFileSync(path.join(fixture.assets, "main.js"), runtimeEntryFixture().replace('()=>req("Main")', '()=>req("Other")'));
    else if (kind === "html-role") fs.writeFileSync(path.join(fixture.root, "webview/detached-window.html"), '<script type="module" src="/assets/main.js"></script>');
    else fs.writeFileSync(path.join(fixture.root, "webview/index.html"), '<script type="module" src="/assets/main.js" src="/assets/detached.js"></script>');
    const bytes = runtimeFixtureBytes(fixture), oldWrite = fs.writeFileSync;
    let writes = 0;
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(writes, 0, kind);
    assertRuntimeFixtureBytes(fixture, bytes);
  }
});

test("webview runtime descriptor rolls back partial writes and protects changed read dependencies", t => {
  for (const kind of ["partial", "dependency-race", "html-race", "inventory-race"]) {
    const fixture = runtimeAppFixture(t), before = runtimeFixtureBytes(fixture), oldWrite = fs.writeFileSync;
    let written = false;
    fs.writeFileSync = (file, bytes, ...options) => {
      if (String(file).endsWith('/main.js') && !written) {
        written = true;
        if (kind === "partial") { oldWrite(file, "partial"); throw Error("inert partial write"); }
        if (kind === "html-race") oldWrite(path.join(fixture.root, "webview/index.html"), before["webview/index.html"] + "<!-- concurrent -->");
        else if (kind === "dependency-race") oldWrite(path.join(fixture.assets, "shared.js"), before['webview/assets/shared.js'] + "\n// concurrent");
        else oldWrite(path.join(fixture.assets, "extra.js"), 'globalThis.codexLinuxReadAloudVersion="unexpected";');
      }
      return oldWrite(file, bytes, ...options);
    };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.writeFileSync = oldWrite; }
    assert.equal(written, true);
    assert.equal(fs.readFileSync(path.join(fixture.assets, "main.js"), "utf8"), before['webview/assets/main.js']);
    assert.equal(fs.readFileSync(path.join(fixture.assets, "detached.js"), "utf8"), before['webview/assets/detached.js']);
  }
});

test("webview runtime descriptor detects warm inventory entry HTML and dependency races without own writes", t => {
  for (const kind of ["inventory", "entry", "html", "dependency"]) {
    const fixture = runtimeAppFixture(t);
    assert.equal(fixture.run().status, "applied");
    const oldReadDirectory = fs.readdirSync, oldWrite = fs.writeFileSync;
    let scans = 0, writes = 0;
    fs.readdirSync = (directory, ...options) => {
      if (String(directory) === fixture.assets && ++scans === 2) {
        const file = kind === "inventory" ? path.join(fixture.assets, "extra.js")
          : kind === "entry" ? path.join(fixture.assets, "main.js")
          : kind === "html" ? path.join(fixture.root, "webview/index.html")
          : path.join(fixture.assets, "shared.js");
        oldWrite(file, kind === "inventory" ? "const peer=true;" : fs.readFileSync(file, "utf8") + "\n/* concurrent */");
      }
      return oldReadDirectory(directory, ...options);
    };
    fs.writeFileSync = (...args) => { writes++; return oldWrite(...args); };
    try { assert.equal(fixture.run().status, "skipped-optional", kind); }
    finally { fs.readdirSync = oldReadDirectory; fs.writeFileSync = oldWrite; }
    assert.equal(scans, 2, kind);
    assert.equal(writes, 0, kind);
  }
});

test("webview runtime descriptor propagates fatal failure when rollback cannot restore an entry", t => {
  const fixture = runtimeAppFixture(t), oldWrite = fs.writeFileSync;
  let attempts = 0;
  fs.writeFileSync = (file, bytes, ...options) => {
    if (String(file).endsWith("/main.js")) {
      if (++attempts === 1) oldWrite(file, "partial");
      throw Error("inert write and restoration failure");
    }
    return oldWrite(file, bytes, ...options);
  };
  try { assert.throws(() => fixture.run(), /rollback could not restore original bytes/u); }
  finally { fs.writeFileSync = oldWrite; }
  assert.equal(attempts, 2);
});

function assistantAppFixture(t, { source = assistantRenderFixture().source, installRuntime = true } = {}) {
  const fixture = runtimeAppFixture(t);
  if (installRuntime) assert.equal(fixture.run().status, "applied");
  const owner = path.join(fixture.assets, "assistant.js");
  fs.writeFileSync(owner, source);
  fs.writeFileSync(path.join(fixture.assets, "jsx.js"), 'export const __rspack_esm_ids=[9];export const __webpack_modules__={Jsx(e,t,n){e.exports=n("Delegate")}};');
  fs.writeFileSync(path.join(fixture.assets, "delegate.js"), 'export const __rspack_esm_ids=[10];export const __webpack_modules__={Delegate(e,t){var n=Symbol.for("react.transitional.element");function i(e,t,i){var r=null;if(void 0!==i&&(r=""+i),void 0!==t.key&&(r=""+t.key),"key"in t)for(var o in i={},t)"key"!==o&&(i[o]=t[o]);else i=t;return{$$typeof:n,type:e,key:r,ref:void 0!==(t=i.ref)?t:null,props:i}}t.Fragment=Symbol.for("react.fragment"),t.jsx=i,t.jsxs=i}};');
  const descriptor = featurePatches.find(patch => patch.id === "assistant-runtime");
  const selected = normalizePatchDescriptors([{ ...descriptor, featureId: "read-aloud", sourceKind: "feature" }]);
  return { ...fixture, owner, runAssistant(options = {}) {
    const report = createPatchReport();
    applyExtractedAppPatchDescriptors(fixture.root, selected, options, report, "extracted-app:pre-webview");
    return report.patches[0];
  } };
}

test("assistant runtime descriptor fails soft and atomically when the current render contract drifts", t => {
  const fixture = assistantAppFixture(t, { source: 'console.log("assistant render contract moved");' });
  const before = fs.readFileSync(fixture.owner, "utf8"), runtime = runtimeFixtureBytes(fixture);
  const report = fixture.runAssistant();
  assert.equal(report.status, "skipped-optional");
  assert.equal(fs.readFileSync(fixture.owner, "utf8"), before);
  assertRuntimeFixtureBytes(fixture, runtime);
});

test("assistant runtime descriptor reports applied then already-applied for the current contract", t => {
  const fixture = assistantAppFixture(t, { source: assistantRenderFixture({ jsxVar: "DX", component: "Jft.F" }).source });
  const runtime = runtimeFixtureBytes(fixture);
  assert.equal(fixture.runAssistant().status, "applied");
  assert.equal(fixture.runAssistant().status, "already-applied");
  const patched = fs.readFileSync(fixture.owner, "utf8");
  assert.equal((patched.match(/codex-linux-read-aloud-button/g) ?? []).length, 2);
  assert.doesNotMatch(patched, /codexLinuxReadAloudVersion/);
  assertRuntimeFixtureBytes(fixture, runtime);
});

function generalSettingsFixture({ page = "s=(0,n.jsxs)(eG.P,{title:t,children:[e,a]})", extra = "" } = {}) {
  return [
    "export const __rspack_esm_id=572868;export const __rspack_esm_ids=[572868];export const __webpack_modules__={qBpP(e,t,a){",
    'var n=a("ABep"),r=a("QosV");',
    "function aG(){let e,t,a,s,i=(0,r.c)(7);return e=(0,n.jsx)(aR,{}),",
    't=(0,n.jsx)(eH.s,{slug:"general-settings"}),',
    'a=(0,n.jsx)(j.m,{name:"toys",children:(0,n.jsx)(tW,{})}),',
    `${page},s}`,
    'function aR(){return(0,n.jsx)(x.A,{id:"settings.general.groupTitle",defaultMessage:"General",description:"Heading for the general settings group"})}',
    extra,
    "}};",
  ].join("");
}

function evaluateGeneralSettingsPage(source, globals) {
  const factory = source.match(/qBpP\(e,t,a\)\{([\s\S]*)\}\};$/)[1];
  const element = (type, props) => ({ type, props });
  const modules = { ABep: { jsx: element, jsxs: element }, QosV: { c: () => [] } };
  const stubs = { eH: { s: "Title" }, j: { m: "Toys" }, tW: "tW", eG: { P: "Page" }, x: { A: "Message" } };
  return new Function("a", "globalThis", ...Object.keys(stubs), `${factory};return aG();`)(
    (id) => modules[id],
    globals,
    ...Object.values(stubs),
  );
}

test("general settings patch mounts the read aloud section into the current General page", () => {
  const source = generalSettingsFixture();
  assert.equal(matchesGeneralSettingsPageContract(source), true);
  const patched = twice(applyGeneralSettingsPatch, source);
  assert.equal(matchesGeneralSettingsPageContract(patched), true);
  assert.equal(patched.split("codex-linux-read-aloud-settings-mount").length - 1, 1);
  assert.match(
    patched,
    /children:\[e,\(0,n\.jsx\)\("div",\{className:"codex-linux-read-aloud-settings-mount",ref:codexLinuxReadAloudSettingsRoot=>\{codexLinuxReadAloudSettingsRoot&&globalThis\.codexLinuxReadAloudMountSettings\?\.\(codexLinuxReadAloudSettingsRoot\)\}\}\),a\]/,
  );

  const mounted = [];
  const page = evaluateGeneralSettingsPage(patched, { codexLinuxReadAloudMountSettings: (root) => mounted.push(root) });
  assert.equal(page.type, "Page");
  const [content, mount, toys] = page.props.children;
  assert.equal(content.type.name, "aR");
  assert.equal(toys.type, "Toys");
  assert.equal(mount.type, "div");
  assert.equal(mount.props.className, "codex-linux-read-aloud-settings-mount");
  const root = { id: "root" };
  mount.props.ref(root);
  mount.props.ref(null);
  assert.deepEqual(mounted, [root]);
  // Without the runtime the host element stays empty instead of throwing.
  const withoutRuntime = evaluateGeneralSettingsPage(patched, {});
  assert.doesNotThrow(() => withoutRuntime.props.children[1].props.ref({}));
});

test("general settings mount composes with leading marked Linux page rows in either order", () => {
  // community-features-in-gui-settings leads the page children with its own
  // self-contained component; it inserts at `children:[` in either order.
  const community = "(0,n.jsx)(codexLinuxCommunityFeaturesInGuiSettings,{}),";
  const addCommunity = (source) => source.includes(community) ? source : source.replace("title:t,children:[", `title:t,children:[${community}`);
  const mount = '(0,n.jsx)("div",{className:"codex-linux-read-aloud-settings-mount",ref:codexLinuxReadAloudSettingsRoot=>{codexLinuxReadAloudSettingsRoot&&globalThis.codexLinuxReadAloudMountSettings?.(codexLinuxReadAloudSettingsRoot)}})';
  for (const order of [[applyGeneralSettingsPatch, addCommunity], [addCommunity, applyGeneralSettingsPatch]]) {
    const apply = (source) => order.reduce((current, patch) => {
      const { result, warnings } = captureWarnings(() => patch(current));
      assert.deepEqual(warnings, []);
      return result;
    }, source);
    const patched = apply(generalSettingsFixture());
    assert.equal(apply(patched), patched);
    assert.ok(patched.includes(`children:[${community}e,${mount},a]`));
    assert.equal(matchesGeneralSettingsPageContract(patched), true);
  }
  // Unmarked leading children remain upstream drift.
  const drifted = generalSettingsFixture({ page: "s=(0,n.jsxs)(eG.P,{title:t,children:[(0,n.jsx)(Other,{}),e,a]})" });
  assert.equal(matchesGeneralSettingsPageContract(drifted), false);
});

test("general settings patch fails closed when the General page contract drifts", () => {
  const sources = [
    generalSettingsFixture({ page: "s=(0,n.jsxs)(eG.P,{title:t,children:[e,a,o]})" }),
    generalSettingsFixture({ page: "s=(0,n.jsx)(eG.P,{title:t,children:e})" }),
    generalSettingsFixture({
      extra: 'function aH(){let t=(0,n.jsx)(eH.s,{slug:"general-settings"});return(0,n.jsxs)(eG.P,{title:t,children:[e,a]})}',
    }),
    generalSettingsFixture({ extra: 'const stale="codex-linux-read-aloud-settings-mount";' }),
  ];
  for (const source of sources) {
    assert.equal(matchesGeneralSettingsPageContract(source), false);
    const { result, warnings } = captureWarnings(() => applyGeneralSettingsPatch(source));
    assert.equal(result, source);
    assert.match(warnings.join("\n"), /unique General settings page contract/);
  }
});

test("settings descriptor selects the General page chunk by content and reports idempotently", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "settings-toggle");
  assert.equal(descriptor.phase, "webview-asset");
  assert.deepEqual(descriptor.assetNeedles, ['slug:"general-settings"', '"settings.general.groupTitle"']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-read-aloud-settings-"));
  try {
    const asyncDir = path.join(root, "webview", "assets", "async");
    fs.mkdirSync(asyncDir, { recursive: true });
    const pagePath = path.join(asyncDir, "572868.36a6c86221.js");
    const localePath = path.join(asyncDir, "13229.4f98ce1bef.js");
    const accountPath = path.join(asyncDir, "696466.df4f8bc083.js");
    fs.writeFileSync(pagePath, generalSettingsFixture());
    const locale = 'export const __rspack_esm_id=13229;export const __webpack_modules__={l(e){e.exports={"settings.general.groupTitle":"Allgemein"}}};';
    const account = 'export const __rspack_esm_id=696466;export const __webpack_modules__={m(e,t,a){var n=a("ABep");"settings.general.groupTitle";(0,n.jsx)(T.X.Header,{title:(0,n.jsx)(j.s,{slug:"general-settings"})})}};';
    fs.writeFileSync(localePath, locale);
    fs.writeFileSync(accountPath, account);
    const descriptors = normalizePatchDescriptors([{ ...descriptor, featureId: "read-aloud", sourceKind: "feature" }]);
    const firstReport = createPatchReport();
    const secondReport = createPatchReport();
    applyWebviewAssetPatchDescriptors(root, descriptors, {}, firstReport);
    applyWebviewAssetPatchDescriptors(root, descriptors, {}, secondReport);
    assert.equal(firstReport.patches[0].status, "applied");
    assert.equal(secondReport.patches[0].status, "already-applied");
    assert.equal(fs.readFileSync(pagePath, "utf8").split("codex-linux-read-aloud-settings-mount").length - 1, 1);
    assert.equal(fs.readFileSync(localePath, "utf8"), locale);
    assert.equal(fs.readFileSync(accountPath, "utf8"), account);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeDocument() {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.listeners = {};
      this.hidden = false;
      this.disabled = false;
      this.textContent = "";
      this.className = "";
      this.value = "";
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "value") this.value = String(value);
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    replaceChildren(...children) {
      this.children = children;
    }
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    }
    fire(type) {
      for (const listener of this.listeners[type] ?? []) listener({ currentTarget: this });
    }
    find(predicate) {
      if (predicate(this)) return this;
      for (const child of this.children) {
        const found = child.find?.(predicate);
        if (found) return found;
      }
      return null;
    }
  }
  const head = new FakeElement("head");
  return {
    FakeElement,
    document: {
      head,
      createElement: (tagName) => new FakeElement(tagName),
      getElementById: (id) => head.children.find((child) => child.id === id) ?? null,
    },
  };
}

function createSettingsRuntime(host) {
  const { FakeElement, document } = fakeDocument();
  const listeners = {};
  const requests = [];
  const window = {
    addEventListener: (type, listener) => (listeners[type] ??= []).push(listener),
    dispatchEvent() {},
    electronBridge: {
      sendMessageFromView: async (payload) => {
        if (payload.type !== "fetch") return;
        assert.equal(payload.url, "vscode://codex/linux-read-aloud");
        const body = JSON.parse(payload.body);
        requests.push(body);
        Promise.resolve()
          .then(() => host(body))
          .then(
            (value) => ({ type: "fetch-response", responseType: "success", requestId: payload.requestId, status: 200, bodyJsonString: JSON.stringify(value) }),
            (error) => ({ type: "fetch-response", responseType: "error", requestId: payload.requestId, status: 500, error: error.message }),
          )
          .then((data) => {
            for (const listener of listeners.message ?? []) listener({ data });
          });
      },
    },
  };
  class CustomEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options?.detail;
    }
  }
  const globals = {};
  new Function("window", "document", "globalThis", "CustomEvent", "setTimeout", "clearTimeout", applyIndexRuntimePatch(""))(
    window, document, globals, CustomEvent, () => 0, () => {},
  );
  const root = new FakeElement("div");
  const controller = globals.codexLinuxReadAloudMountSettings(root);
  assert.equal(globals.codexLinuxReadAloudMountSettings(root), undefined);
  return {
    controller,
    requests,
    toggle: root.find((node) => node.attributes.role === "switch"),
    range: root.find((node) => node.attributes.type === "range"),
    error: root.find((node) => node.className === "codex-linux-read-aloud-settings-error"),
    setupControls: root.find((node) => node.children.some((child) => child.textContent === "Choose folder")),
  };
}

function settingsHost({ enabled = false, speed = 1.05, failRead = null } = {}) {
  const writes = [];
  const host = (body) => {
    if (body.action === "get-setting") {
      if (body.key === failRead) throw new Error(`cannot read ${body.key}`);
      return { value: body.key === "codex-linux-read-aloud-enabled" ? enabled : speed };
    }
    assert.equal(body.action, "set-setting");
    const request = deferred();
    writes.push({ ...body, request });
    return request.promise;
  };
  return { host, writes };
}

test("runtime settings section loads stored values and writes explicit settings", async () => {
  const { host, writes } = settingsHost({ enabled: false, speed: 1.2 });
  const settings = createSettingsRuntime(host);
  assert.equal(settings.toggle.disabled, true);
  await settings.controller.load;
  assert.deepEqual(settings.requests, [
    { action: "get-setting", key: "codex-linux-read-aloud-enabled" },
    { action: "get-setting", key: "codex-linux-read-aloud-kokoro-speed" },
  ]);
  assert.equal(settings.toggle.getAttribute("aria-checked"), "false");
  assert.equal(settings.toggle.disabled, false);
  assert.equal(settings.setupControls.hidden, true);
  assert.equal(settings.range.value, "1.2");

  settings.toggle.fire("click");
  assert.equal(settings.toggle.getAttribute("aria-checked"), "true");
  assert.equal(settings.setupControls.hidden, false);
  await settlePromises();
  assert.deepEqual(writes.map(({ action, key, value }) => [action, key, value]), [
    ["set-setting", "codex-linux-read-aloud-enabled", true],
  ]);
  writes[0].request.resolve({ success: true, value: true });
  await settlePromises();
  assert.equal(settings.error.hidden, true);

  settings.range.value = "2";
  settings.range.fire("change");
  await settlePromises();
  assert.deepEqual(writes.slice(1).map(({ key, value }) => [key, value]), [["codex-linux-read-aloud-kokoro-speed", 1.4]]);
});

test("runtime settings section keeps successful independent reads", async () => {
  const { host } = settingsHost({ enabled: true, speed: 0.8, failRead: "codex-linux-read-aloud-enabled" });
  const settings = createSettingsRuntime(host);
  await settings.controller.load;
  assert.equal(settings.toggle.getAttribute("aria-checked"), "false");
  assert.equal(settings.controller.state.speed, 0.8);
  assert.equal(settings.error.hidden, false);
  assert.match(settings.error.textContent, /cannot read codex-linux-read-aloud-enabled/);
});

test("runtime settings section rolls failed writes back to the last confirmed value", async () => {
  const { host, writes } = settingsHost({ enabled: false });
  const settings = createSettingsRuntime(host);
  await settings.controller.load;
  settings.toggle.fire("click");
  await settlePromises();
  writes[0].request.resolve({ success: true, value: true });
  await settlePromises();
  settings.toggle.fire("click");
  await settlePromises();
  writes[1].request.reject(new Error("disk full"));
  await settlePromises();
  await settlePromises();
  assert.equal(settings.toggle.getAttribute("aria-checked"), "true");
  assert.match(settings.error.textContent, /disk full/);
  assert.equal(settings.error.hidden, false);
});

test("runtime settings section ignores superseded write failures", async () => {
  const { host, writes } = settingsHost({ speed: 1.05 });
  const settings = createSettingsRuntime(host);
  await settings.controller.load;
  const first = settings.controller.write("speed", 0.9);
  const second = settings.controller.write("speed", 1.3);
  await settlePromises();
  writes[0].request.reject(new Error("stale failure"));
  await settlePromises();
  writes[1].request.resolve({ success: true, value: 1.3 });
  await Promise.all([first, second]);
  assert.equal(settings.controller.state.speed, 1.3);
  assert.equal(settings.error.hidden, true);
  assert.deepEqual(writes.map(({ value }) => value), [0.9, 1.3]);
});

test("runtime settings section treats an unsuccessful host answer as a failed write", async () => {
  const { host, writes } = settingsHost({ enabled: false });
  const settings = createSettingsRuntime(host);
  await settings.controller.load;
  const write = settings.controller.write("enabled", true);
  await settlePromises();
  writes[0].request.resolve({ success: false });
  await write;
  assert.equal(settings.controller.state.enabled, false);
  assert.match(settings.error.textContent, /Could not save setting/);
});

test(
  "every read aloud contract resolves uniquely in the signed official app",
  { skip: process.env.CODEX_SIGNED_EXTRACTED_APP == null },
  () => {
    const root = process.env.CODEX_SIGNED_EXTRACTED_APP;
    const { findMainProcessChunks, findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
    const { buildDir, chunks } = findMainProcessChunks(root);
    const routed = [];
    for (const chunk of chunks) {
      const source = fs.readFileSync(path.join(buildDir, chunk), "utf8");
      const { result } = captureWarnings(() => applyMainBundlePatch(source));
      if (result === source) continue;
      routed.push(chunk);
      assert.equal(applyMainBundlePatch(result), result);
      new Function("exports", "require", "module", result);
    }
    assert.equal(routed.length, 1);

    const assetsDir = path.join(root, "webview", "assets");
    for (const descriptor of featurePatches.filter((patch) => patch.phase === "webview-asset" || patch.id === "assistant-runtime")) {
      const apply = descriptor.id === "assistant-runtime" ? applyAssistantRenderPatch : descriptor.apply;
      const candidates = findWebviewAssetsContaining(root, descriptor.assetNeedles);
      const targets = descriptor.assetMatch == null
        ? candidates
        : candidates.filter((name) => descriptor.assetMatch(fs.readFileSync(path.join(assetsDir, name), "utf8"), name));
      assert.ok(targets.length >= 1, descriptor.id);
      if (descriptor.assetMatch != null) assert.equal(targets.length, 1, descriptor.id);
      for (const name of targets) {
        const source = fs.readFileSync(path.join(assetsDir, name), "utf8");
        const { result, warnings } = captureWarnings(() => apply(source));
        assert.deepEqual(warnings, [], `${descriptor.id} ${name}`);
        assert.notEqual(result, source, `${descriptor.id} ${name}`);
        assert.equal(apply(result), result, `${descriptor.id} ${name}`);
      }
    }
  },
);

function readAloudInertRuntime({ bridge = true } = {}) {
  const { FakeElement, document } = fakeDocument(), listeners = {}, requests = [], events = [], timers = new Map();
  let now = 0, sequence = 0;
  const globals = {}, setTimer = (callback, delay = 0) => { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; };
  const window = {
    addEventListener(type, callback) { (listeners[type] ??= []).push(callback); },
    dispatchEvent(event) {
      events.push(event);
      if (event.type === "codex-message-from-view" && !event.__codexForwardedViaBridge && event.detail.type === "fetch") requests.push(event.detail);
    },
  };
  if (bridge) window.electronBridge = { sendMessageFromView(payload) { if (payload.type === "fetch") requests.push(payload); return Promise.resolve(); } };
  class CustomEvent { constructor(type, options) { this.type = type; this.detail = options.detail; } }
  const install = () => new Function("window", "document", "globalThis", "CustomEvent", "setTimeout", "clearTimeout", applyIndexRuntimePatch(""))(
    window, document, globals, CustomEvent, setTimer, id => timers.delete(id),
  );
  install();
  return { globals, requests, events, listeners, document, timers, install,
    button: () => new FakeElement("button"),
    reply(request, body = {}, extra = {}) {
      for (const listener of listeners.message ?? []) listener({ data: { type: "fetch-response", responseType: "success", status: 200, requestId: request.requestId, bodyJsonString: JSON.stringify(body), ...extra } });
    },
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback(); await settlePromises();
      }
      now = until; await settlePromises();
    },
  };
}

test("UP61 bootstrap and repeated install register one silent realm runtime", () => {
  const r = readAloudInertRuntime();
  r.install();
  assert.equal(r.requests.length, 0);
  assert.equal(r.listeners.message.length, 1);
  assert.equal(r.document.head.children.length, 1);
  for (const name of ["Click", "Setup", "MountSettings", "GetSetting", "SetSetting"]) assert.equal(typeof r.globals['codexLinuxReadAloud' + name], "function");
});

for (const bridge of [true, false]) {
  test(`UP61 explicit click uses one cleaned local request and settles owned timers with bridge=${bridge}`, async () => {
    const r = readAloudInertRuntime({ bridge }), button = r.button();
    const click = r.globals.codexLinuxReadAloudClick({}, '**hello** [world](https://example.invalid)\n```code```', 'conversation-one', button);
    assert.equal(r.requests.length, 1);
    const request = r.requests[0];
    assert.deepEqual(JSON.parse(request.body), { action: "speak", source: "button", text: "hello world\n code block." });
    assert.equal(request.hostId, "local"); assert.equal(request.method, "POST"); assert.equal(request.url, "vscode://codex/linux-read-aloud");
    assert.match(request.requestId, /^codex-linux-read-aloud-/u);
    assert.equal(r.events.find(event => event.detail.type === "fetch").__codexForwardedViaBridge === true, bridge);
    r.reply(request, { spoken: true }); await click;
    assert.equal(button.dataset.codexLinuxReadAloudState, "speaking");
    assert.equal(r.timers.size, 1, "Only the current speech estimate remains after its response");
    await r.globals.codexLinuxReadAloudClick({}, "ignored", 'conversation-one', button);
    assert.equal(button.dataset.codexLinuxReadAloudState, "ready");
    assert.deepEqual(JSON.parse(r.requests[1].body), { action: "stop" });
    r.reply(r.requests[1]); await settlePromises();
    r.reply(request, { spoken: true });
    assert.equal(button.dataset.codexLinuxReadAloudState, "ready");
    assert.equal(r.timers.size, 0);
  });
}

test("UP61 timeout malformed error and stale replies leave usable request state", async () => {
  for (const outcome of ["timeout", "malformed", "error"]) {
    const r = readAloudInertRuntime(), button = r.button();
    const pending = r.globals.codexLinuxReadAloudClick({}, "hello", "conv", button);
    r.reply({ requestId: "unknown" }, { spoken: true });
    assert.equal(button.dataset.codexLinuxReadAloudState, "loading");
    if (outcome === "timeout") await r.advance(4000);
    else if (outcome === "malformed") r.reply(r.requests[0], null, { bodyJsonString: "{" });
    else r.reply(r.requests[0], null, { responseType: "error", error: "inert failure" });
    await pending;
    assert.equal(button.dataset.codexLinuxReadAloudState, "error");
    await r.advance(1500);
    assert.equal(button.dataset.codexLinuxReadAloudState, "ready");
    r.reply(r.requests[0], { spoken: true });
    assert.equal(button.dataset.codexLinuxReadAloudState, "ready");
    assert.equal(r.timers.size, 0);
  }
});

test("UP61 newer explicit speech owns button state and late response or timer cannot replace it", async () => {
  const r = readAloudInertRuntime(), first = r.button(), second = r.button();
  const old = r.globals.codexLinuxReadAloudClick({}, "first", "old-conv", first);
  const current = r.globals.codexLinuxReadAloudClick({}, "x".repeat(9000), "new-conv", second);
  assert.equal(JSON.parse(r.requests[1].body).text.length, 8000);
  r.reply(r.requests[1], { spoken: true }); await current;
  r.reply(r.requests[0], { spoken: true }); await old;
  assert.equal(first.dataset.codexLinuxReadAloudState, "ready");
  assert.equal(second.dataset.codexLinuxReadAloudState, "speaking");
  assert.equal(r.timers.size, 1);
  await r.advance(120000);
  assert.equal(second.dataset.codexLinuxReadAloudState, "ready");
  assert.equal(r.requests.length, 2);
});

test("UP61 out-of-order failures and conversation stop cannot reclaim newer button state", async () => {
  for (const outcome of ["old-error", "new-error", "conversation-stop"]) {
    const r = readAloudInertRuntime(), first = r.button(), second = r.button();
    const old = r.globals.codexLinuxReadAloudClick({}, "first", "old", first);
    if (outcome === "conversation-stop") {
      let stopped = 0;
      r.globals.codexLinuxConversationIsSpeaking = () => true;
      r.globals.codexLinuxConversationStopSpeaking = () => stopped++;
      await r.globals.codexLinuxReadAloudClick({}, "stop", "old", first);
      assert.equal(stopped, 1);
      r.reply(r.requests[0], { spoken: true }); await old;
      assert.equal(first.dataset.codexLinuxReadAloudState, "ready");
      assert.equal(r.requests.length, 1);
      assert.equal(r.timers.size, 0);
      continue;
    }
    const current = r.globals.codexLinuxReadAloudClick({}, "second", "new", second);
    if (outcome === "new-error") r.reply(r.requests[1], null, { responseType: "error" });
    else r.reply(r.requests[1], { spoken: true });
    await current;
    if (outcome === "old-error") r.reply(r.requests[0], null, { responseType: "error" });
    else r.reply(r.requests[0], { spoken: true });
    await old;
    assert.equal(first.dataset.codexLinuxReadAloudState, "ready");
    assert.equal(second.dataset.codexLinuxReadAloudState, outcome === "new-error" ? "error" : "speaking");
    await r.advance(4000);
    assert.equal(second.dataset.codexLinuxReadAloudState, "ready");
    assert.equal(r.timers.size, 0);
  }
});

test("UP61 timed-out replies and queued stale flash or estimate callbacks cannot alter a newer speech", async () => {
  for (const outcome of ["timeout", "error", "estimate"]) {
    const r = readAloudInertRuntime(), first = r.button(), second = r.button();
    const old = r.globals.codexLinuxReadAloudClick({}, "first", "old", first);
    if (outcome === "timeout") await r.advance(4000);
    else r.reply(r.requests[0], outcome === "estimate" ? { spoken: true } : { spoken: false });
    await old;
    const staleCallback = [...r.timers.values()][0].callback;
    const current = r.globals.codexLinuxReadAloudClick({}, "second", "new", second);
    staleCallback();
    assert.equal(second.dataset.codexLinuxReadAloudState, "loading");
    r.reply(r.requests[1], { spoken: true }); await current;
    r.reply(r.requests[0], { spoken: true });
    staleCallback();
    assert.equal(first.dataset.codexLinuxReadAloudState, "ready");
    assert.equal(second.dataset.codexLinuxReadAloudState, "speaking");
    await r.advance(4000);
    assert.equal(second.dataset.codexLinuxReadAloudState, "ready");
    assert.equal(r.timers.size, 0);
  }
});

function assistantPrivateApi() {
  const Module = require("node:module"), file = path.join(__dirname, "patch.js");
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(__dirname);
  let publications = 0;
  loaded.require = function(request) {
    const value = Module.prototype.require.call(this, request);
    if (request !== "../../scripts/patches/lib/rspack-export-publication.js") return value;
    return { ...value, findRspackExportPublication(...args) { publications++; return value.findRspackExportPublication(...args); } };
  };
  loaded._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.assistantInspect=inspectAssistantRenderContract;module.exports.assistantCacheSize=()=>assistantContractCache.size;", file);
  return { ...loaded.exports, publications: () => publications };
}

test("assistant contribution cache copies facts, invalidates changed source and stays bounded after eviction", () => {
  const api = assistantPrivateApi(), source = assistantRenderFixture().source;
  const first = api.assistantInspect(source), count = api.publications();
  assert.equal(first.state, "unpatched");
  const native = first.candidates[0].match;
  first.state = "polluted"; first.candidates[0].match = "polluted";
  first.candidates[0].names.push("polluted"); first.candidates[0].fields.set("item", "polluted");
  const second = api.assistantInspect(source);
  assert.equal(api.publications(), count);
  assert.equal(second.state, "unpatched"); assert.equal(second.candidates[0].match, native);
  assert.equal(second.candidates[0].fields.get("item"), "o");
  assert.equal(second.candidates[0].names.includes("polluted"), false);
  const changed = source.replace("F:()=>render", "F:()=>renDer");
  assert.equal(api.assistantInspect(changed).state, "invalid");
  for (let index = 0; index < 5; index++) assert.equal(api.assistantInspect(source + `\nconst opaque${index}=true;`).state, "unpatched");
  assert.equal(api.assistantCacheSize(), 4);
  const before = api.publications();
  assert.equal(api.assistantInspect(source).state, "unpatched");
  assert.ok(api.publications() > before);
});

test("assistant normal warm cache still rejects changed JSX ABI and changed UP61 payload with zero writes", t => {
  const fixture = assistantAppFixture(t);
  assert.equal(fixture.runAssistant().status, "applied");
  assert.equal(fixture.runAssistant().status, "already-applied");
  const owner = fs.readFileSync(fixture.owner, "utf8"), delegate = path.join(fixture.assets, "delegate.js");
  const original = fs.readFileSync(delegate, "utf8");
  fs.writeFileSync(delegate, original.replace("t.jsx=i", "t.jsx=other"));
  let writes = 0;
  const writeFileSync = (file, bytes) => { writes++; fs.writeFileSync(file, bytes); };
  assert.equal(fixture.runAssistant({ writeFileSync }).status, "skipped-optional");
  assert.equal(writes, 0); assert.equal(fs.readFileSync(fixture.owner, "utf8"), owner);
  fs.writeFileSync(delegate, original);
  const runtime = path.join(fixture.assets, "main.js"), source = fs.readFileSync(runtime, "utf8");
  fs.writeFileSync(runtime, source.replace('const METHOD="linux-read-aloud"', 'const METHOD="wrong-read-aloud"'));
  assert.equal(fixture.runAssistant({ writeFileSync }).status, "skipped-optional");
  assert.equal(writes, 0); assert.equal(fs.readFileSync(fixture.owner, "utf8"), owner);
});

function assistantExpressionHarness(expression, fixture, role) {
  const vm = require("node:vm");
  const jsx = {}, delegate = 'var n=Symbol.for("react.transitional.element");function i(e,t,i){var r=null;if(void 0!==i&&(r=""+i),void 0!==t.key&&(r=""+t.key),"key"in t)for(var o in i={},t)"key"!==o&&(i[o]=t[o]);else i=t;return{$$typeof:n,type:e,key:r,ref:void 0!==(t=i.ref)?t:null,props:i}}t.Fragment=Symbol.for("react.fragment"),t.jsx=i,t.jsxs=i';
  vm.runInNewContext(`(function(e,t){${delegate}})`)({}, jsx);
  const values = {}, calls = [], target = { role }, ref = () => {};
  for (const match of `${fixture.sourceTurnCall}${fixture.liveTurnCall}`.matchAll(/:([A-Za-z_$][\w$]*)(?=[,}])/gu)) values[match[1]] = "value-" + match[1];
  Object.assign(values, { s: jsx, eA: { F: "NativeAssistant" }, p: "conversation-a", o: { content: "source" }, n: { content: "live" }, a: "source copy", w: "live copy", roleKey: "native-key", roleRef: ref });
  values.codexLinuxReadAloudClick = (...args) => { calls.push(args); };
  values.codexLinuxReadAloudSetup = () => { throw Error("unexpected setup"); };
  const context = vm.createContext(values), element = vm.runInContext(`(${expression})`, context);
  return { context, element, calls, target, ref };
}

test("assistant source and live buttons keep original child props/key/ref and stay silent until explicit click", () => {
  const vm = require("node:vm");
  const fixture = assistantRenderFixture();
  const source = fixture.source.replace(fixture.sourceTurnCall, fixture.sourceTurnCall.replace("item:o,", 'item:o,key:roleKey,ref:roleRef,opaque:{tag:"native",values:[1,2]},'));
  const api = assistantPrivateApi(), raw = api.assistantInspect(source), patched = api.applyAssistantRenderPatch(source);
  assert.equal(raw.state, "unpatched");
  for (const row of raw.candidates) {
    const prefix = `/*codex-linux-read-aloud-assistant:${row.role}*/`;
    const start = patched.indexOf(prefix), native = patched.indexOf(row.match, start), end = native + row.match.length + 1;
    assert.ok(start >= 0 && native > start);
    const expression = patched.slice(start, end);
    const harness = assistantExpressionHarness(expression, fixture, row.role);
    assert.equal(harness.calls.length, 0);
    const original = vm.runInContext(`(${row.match})`, harness.context), child = harness.element.props.children[0];
    assert.equal(child.type, original.type); assert.equal(child.key, original.key); assert.equal(child.ref, original.ref);
    assert.deepEqual(Object.keys(child.props), Object.keys(original.props));
    for (const key of Object.keys(original.props)) {
      if (key === "opaque") assert.equal(JSON.stringify(child.props[key]), JSON.stringify(original.props[key]));
      else assert.equal(child.props[key], original.props[key], key);
    }
    const item = child.props.item, copy = child.props.assistantCopyText, conversation = child.props.conversationId;
    const button = harness.element.props.children[1].props.children;
    vm.runInContext('o={content:"changed"};n={content:"changed"};a="changed";w="changed";p="conversation-b";', harness.context);
    let stopped = 0;
    button.props.onClick({ stopPropagation() { stopped++; }, currentTarget: harness.target });
    assert.equal(stopped, 1); assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.calls[0], [item, copy, conversation, harness.target]);
    const rerender = assistantExpressionHarness(expression, fixture, row.role);
    assert.equal(rerender.calls.length, 0);
  }
});

test("assistant published owner and captured namespace gates reject orphan, shadowed and reassigned code", t => {
  const raw = assistantRenderFixture().source;
  for (const source of [
    raw.replace("F:()=>render", "F:()=>Other").replace("function render(", "function Other(){return null}function render("),
    raw.replace('s=n("Jsx")', 's=other("Jsx")'),
    raw.replace("function render(props){", "s=other;function render(props){"),
    raw.replace("function render(props){", String.raw`\u0073=other;function render(props){`),
    raw.replace("function render(props){", "eA=other;function render(props){"),
    raw.replace("function render(props){", "function render(props){let s=other;"),
    raw.replace("function render(props){", "function render(props){let eA=other;"),
    raw.replace("function render(props){", "function render(props){let globalThis=other;"),
    raw.replace("F:()=>row", "F:()=>Other").replace("function row(", "function Other(){return null}function row("),
  ]) {
    const unchanged = captureWarnings(() => applyAssistantRenderPatch(source));
    assert.equal(unchanged.result, source);
    const fixture = assistantAppFixture(t, { source });
    let writes = 0;
    assert.equal(fixture.runAssistant({ writeFileSync() { writes++; } }).status, "skipped-optional");
    assert.equal(writes, 0); assert.equal(fs.readFileSync(fixture.owner, "utf8"), source);
  }
});

test("assistant canonical validation rejects changed, duplicate, eager and escaped owned contributions", t => {
  const raw = assistantRenderFixture().source, patched = applyAssistantRenderPatch(raw);
  const marker = '/*codex-linux-read-aloud-assistant:source-turn*/';
  for (const source of [
    patched.replace('.props.item,codexLinuxReadAloudChild.props.assistantCopyText', '.props.other,codexLinuxReadAloudChild.props.assistantCopyText'),
    patched.replace('.props.conversationId,codexLinuxReadAloudEvent.currentTarget', '.props.other,codexLinuxReadAloudEvent.currentTarget'),
    patched.replace('codexLinuxReadAloudEvent.stopPropagation(),', ''),
    patched.replace('codexLinuxReadAloudEvent.currentTarget', 'codexLinuxReadAloudEvent.target'),
    patched.replace('onClick:codexLinuxReadAloudEvent=>{', 'onClick:(codexLinuxReadAloudEvent=>{').replace('currentTarget)},children:', 'currentTarget)})({stopPropagation(){}}),children:'),
    patched.replace(marker, marker + '/* opaque owned edit */'),
    patched + ';globalThis.codexLinuxReadAloudClick?.(other,other,other,other);',
    patched + String.raw`;globalThis["codexLinuxReadAloudCl\u0069ck"]?.(other);`,
    raw.replace('function render(props){', 'function render(props){const orphan={className:"codex-linux-read-aloud-button"};'),
  ]) {
    assert.doesNotThrow(() => new (require("node:vm").Script)(source.replaceAll("export const ", "const ")));
    const result = captureWarnings(() => applyAssistantRenderPatch(source));
    assert.equal(result.result, source);
    const fixture = assistantAppFixture(t, { source });
    let writes = 0;
    assert.equal(fixture.runAssistant({ writeFileSync() { writes++; } }).status, "skipped-optional");
    assert.equal(writes, 0); assert.equal(fs.readFileSync(fixture.owner, "utf8"), source);
  }
  const inert = raw + '\n/*codex-linux-read-aloud-assistant:source-turn*/\nconst opaque="codexLinuxReadAloudClick";';
  assert.notEqual(applyAssistantRenderPatch(inert), inert);
});

test("assistant physical producer copies are coherent and malformed component or ABI peers refuse every write", t => {
  const fixture = assistantAppFixture(t), source = fs.readFileSync(fixture.owner, "utf8"), copy = path.join(fixture.assets, "assistant-copy.js");
  fs.writeFileSync(copy, source);
  assert.equal(fixture.runAssistant().status, "applied");
  assert.equal(fixture.runAssistant().status, "already-applied");
  const patched = fs.readFileSync(fixture.owner, "utf8");
  fs.writeFileSync(copy, source);
  let writes = 0;
  assert.equal(fixture.runAssistant({ writeFileSync() { writes++; } }).status, "skipped-optional");
  assert.equal(writes, 0); assert.equal(fs.readFileSync(fixture.owner, "utf8"), patched);
  fs.writeFileSync(fixture.owner, source);
  for (const damaged of [
    source.replace('F:()=>render', 'F:()=>missing'),
    source.replace('sourceTurnId:', 'retiredSourceTurnId:'),
    source.replace('F:()=>row', 'Other:()=>row'),
  ]) {
    fs.writeFileSync(copy, damaged); writes = 0;
    assert.equal(fixture.runAssistant({ writeFileSync() { writes++; } }).status, "skipped-optional");
    assert.equal(writes, 0); assert.equal(fs.readFileSync(fixture.owner, "utf8"), source); assert.equal(fs.readFileSync(copy, "utf8"), damaged);
  }
});

test("assistant two-copy writes roll back interruption and propagate unverified restoration", t => {
  for (const fatal of [false, true]) {
    const fixture = assistantAppFixture(t), source = fs.readFileSync(fixture.owner, "utf8"), copy = path.join(fixture.assets, "assistant-copy.js");
    fs.writeFileSync(copy, source);
    let attempts = 0, failed = false;
    const options = { writeFileSync(file, bytes) {
      if (++attempts === 2) { failed = true; fs.writeFileSync(file, "partial assistant"); throw Error("interrupted assistant write"); }
      if (fatal && failed && String(file).endsWith("assistant-copy.js")) throw Error("assistant restoration unavailable");
      fs.writeFileSync(file, bytes);
    } };
    if (fatal) assert.throws(() => fixture.runAssistant(options), /rollback could not restore original bytes/);
    else {
      assert.equal(fixture.runAssistant(options).status, "skipped-optional");
      assert.equal(fs.readFileSync(fixture.owner, "utf8"), source); assert.equal(fs.readFileSync(copy, "utf8"), source);
      assert.equal(fixture.runAssistant().status, "applied");
    }
  }
});

test("assistant readset rejects dependency or inventory races between physical writes", t => {
  for (const kind of ["abi", "runtime", "inventory"]) {
    const fixture = assistantAppFixture(t), source = fs.readFileSync(fixture.owner, "utf8"), copy = path.join(fixture.assets, "assistant-copy.js");
    fs.writeFileSync(copy, source);
    let changed = false;
    const report = fixture.runAssistant({ writeFileSync(file, bytes) {
      fs.writeFileSync(file, bytes);
      if (changed) return;
      changed = true;
      if (kind === "inventory") fs.writeFileSync(path.join(fixture.assets, "unexpected.js"), "const unrelated=true;");
      else fs.appendFileSync(path.join(fixture.assets, kind === "abi" ? "delegate.js" : "main.js"), "/* concurrent dependency change */");
    } });
    assert.equal(report.status, "skipped-optional");
    assert.equal(fs.readFileSync(fixture.owner, "utf8"), source); assert.equal(fs.readFileSync(copy, "utf8"), source);
  }
});

test("assistant full delegate chunk Symbol authority rejects unchanged factories with cold and warm owner facts", t => {
  const prefixes = [
    'const Symbol={for:value=>value};',
    'let Symbol={for:value=>value};',
    'var Symbol={for:value=>value};',
    'function Symbol(){}',
    'class Symbol{}',
    String.raw`const \u0053ymbol={for:value=>value};`,
    'Symbol={for:value=>value};',
    String.raw`\u0053ymbol={for:value=>value};`,
    'Symbol.for=value=>value;',
    'Symbol["for"]=value=>value;',
    String.raw`Symbol["\x66or"]||=value=>value;`,
    String.raw`\u0053ymbol.\u0066or=value=>value;`,
    '++Symbol.for;',
    'delete Symbol?.for;',
    'globalThis.Symbol={for:value=>value};',
    'window["Symbol"]={for:value=>value};',
    'self.Symbol.for^=1;',
    String.raw`globalThis["\u0053ymbol"]["\x66or"]=value=>value;`,
    String.raw`\u0067lobalThis.\u0053ymbol={for:value=>value};`,
    'delete (globalThis.Symbol).for;',
    '[Symbol.for]=[];',
    '({x:globalThis.Symbol}={});',
    'Symbol/*native authority*/.for/*write*/=value=>value;',
    'Object.defineProperty(Symbol,"for",{value:value=>value});',
    'Object["defineProperty"](globalThis,"Symbol",{value:{for:value=>value}});',
    'Reflect.set(Symbol,"for",value=>value);',
    'Reflect["deleteProperty"](globalThis.Symbol,"for");',
    'Reflect.defineProperty(window,"Symbol",{value:{for:value=>value}});',
    String.raw`Object["\u0064efineProperty"](\u0053ymbol,"\x66or",{value:value=>value});`,
    String.raw`Reflect.\u0073et(self["\u0053ymbol"],"\u0066or",value=>value);`,
    'function mutate(){Symbol.for=value=>value;}',
    'function mutate(){globalThis.Symbol={for:value=>value};}',
  ];
  const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
  for (const prefix of prefixes) for (const warm of [false, true]) {
    new (require("node:vm").Script)(prefix);
    const fixture = assistantAppFixture(t);
    if (warm) assert.equal(fixture.runAssistant().status, "applied");
    const delegate = path.join(fixture.assets, "delegate.js"), original = fs.readFileSync(delegate, "utf8");
    const source = prefix + original, before = fs.readFileSync(fixture.owner, "utf8");
    assert.equal([...rspackModuleFactories(source)].find(copy => copy.moduleId === "Delegate").moduleSource,
      [...rspackModuleFactories(original)].find(copy => copy.moduleId === "Delegate").moduleSource);
    fs.writeFileSync(delegate, source);
    let writes = 0;
    const report = fixture.runAssistant({ writeFileSync(file, bytes) { writes++; fs.writeFileSync(file, bytes); } });
    assert.equal(report.status, "skipped-optional", `${warm ? "warm" : "cold"}: ${prefix}`);
    assert.equal(writes, 0, prefix);
    assert.equal(fs.readFileSync(fixture.owner, "utf8"), before, prefix);
    assert.equal(fs.readFileSync(delegate, "utf8"), source, prefix);
  }
});

test("assistant full delegate chunk Symbol authority permits opaque data and unrelated nested local shadows", t => {
  const prefixes = [
    'const opaque="const Symbol={for:value=>value}; Symbol.for=value=>value;";',
    'const opaque=/Symbol\\.for=value/;',
    '/* Symbol.for=value=>value; Object.defineProperty(Symbol,"for",{}); */',
    'function unrelated(Symbol){Symbol.for=value=>value;return Symbol.for;}',
    'function unrelated(){const Symbol={for:value=>value};Symbol.for=value=>value;return Symbol;}',
    'function unrelated(){let Symbol;Symbol={for:value=>value};return Symbol;}',
    'function unrelated(Symbol){Object.defineProperty(Symbol,"for",{value:value=>value});}',
    'function unrelated(globalThis){Reflect.set(globalThis,"Symbol",{for:value=>value});}',
    String.raw`function unrelated(\u0053ymbol){\u0053ymbol["\x66or"]=value=>value;}`,
    'const opaque={Symbol:{for:value=>value}};opaque.Symbol.for=value=>value;',
  ];
  for (const prefix of prefixes) {
    const fixture = assistantAppFixture(t), delegate = path.join(fixture.assets, "delegate.js");
    const source = prefix + fs.readFileSync(delegate, "utf8");
    fs.writeFileSync(delegate, source);
    assert.equal(fixture.runAssistant().status, "applied", prefix);
    assert.equal(fixture.runAssistant().status, "already-applied", prefix);
    assert.equal(fs.readFileSync(delegate, "utf8"), source, prefix);
  }
});
