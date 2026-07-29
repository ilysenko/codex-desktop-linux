#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  applyMainBundlePatchDescriptors,
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  enabledLinuxFeaturePackageDependencies,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  HANDLER_NAME,
  MAX_AUDIO_BYTES,
  SECRET_SERVICE,
  applyDictationCaptureQualityPatch,
  applyDictationMainBridgePatch,
  descriptors,
} = require("./patch.js");

const dictationSource =
  "function Gh(e){return btoa(String.fromCharCode(...e))}" +
  "async function Rrt({blob:e}){return new Uint8Array(await e.arrayBuffer())}" +
  "async function Lrt(e,t={}){let n=t.contentType??(e.type&&e.type.trim().length>0?e.type:`audio/webm`),r=n.split(/[/;]/)[1]??`webm`,i=zrt(t.filename??`codex.${r}`),a=Brt(),o=Gh(await Rrt({blob:e,boundary:a,filename:i,contentType:n,language:t.language})),s={\"Content-Type\":`multipart/form-data; boundary=${a}`};return(await Yf.getInstance().post(`/transcribe`,o,s)).body.text}" +
  "function xit(e){let n=Rh(Get);return Sit({...e,cleanupEnabled:!1,streamingEnabled:n})}" +
  "async function hook(){let I=async e=>{if(noStream)return Lrt(e);try{return await stream.finish()}catch{return Lrt(e)}};" +
  "let L=async a=>{let text=await I(a);Gf.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text})};" +
  "let recorder=new MediaRecorder(track);return L(recorder)}" +
  "function Cit(){return{stream:Knt({channelCount:1}).then(r=>r)}}" +
  "async function connect(){return post(`/codex/dictation-stream-connect-info`)}";

function syntheticMainBundle() {
  return [
    "function launchExternal(){let __codexChild=require(`node:child_process`);",
    "return __codexChild}",
    "let electron=require(`electron`);",
    "class Host{handlers(){return{",
    "\"get-global-state\":async()=>({value:null}),",
    "\"native-desktop-apps\":async()=>({apps:[]})",
    "}}}",
  ].join("");
}

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-capture-quality-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withFeatureConfig(enabled, callback) {
  const previous = process.env.CODEX_LINUX_FEATURES_CONFIG;
  return withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "features.json");
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    try {
      return callback(path.resolve(__dirname, ".."));
    } finally {
      if (previous == null) delete process.env.CODEX_LINUX_FEATURES_CONFIG;
      else process.env.CODEX_LINUX_FEATURES_CONFIG = previous;
    }
  });
}

function captureWarnings(callback) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function webmBase64(extraBytes = []) {
  return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...extraBytes]).toString("base64");
}

function createMainHarness({
  key = "unit-test-openai-key-material",
  keyError = null,
  fetchImpl = null,
} = {}) {
  const patched = applyDictationMainBridgePatch(syntheticMainBundle());
  const execCalls = [];
  const fetchCalls = [];
  const childProcess = {
    execFile(command, args, options, callback) {
      execCalls.push({ command, args, options });
      if (keyError != null) {
        callback(keyError, Buffer.alloc(0), Buffer.from("private keyring detail"));
        return;
      }
      callback(null, Buffer.from(`${key}\n`), Buffer.alloc(0));
    },
  };
  const electron = {
    net: {
      async fetch(url, options) {
        const file = options.body.get("file");
        const snapshot = {
          url,
          authorization: options.headers.Authorization,
          model: options.body.get("model"),
          language: options.body.get("language"),
          filename: file.name,
          contentType: file.type,
          fileBytes: Buffer.from(await file.arrayBuffer()),
          signal: options.signal,
        };
        fetchCalls.push(snapshot);
        if (fetchImpl != null) return fetchImpl(url, options, snapshot);
        return {
          ok: true,
          status: 200,
          async json() {
            return { text: "The morning air felt cool and fresh." };
          },
        };
      },
    },
  };
  const sandbox = {
    require(name) {
      if (name === "node:child_process") return childProcess;
      if (name === "electron") return electron;
      throw new Error(`unexpected require ${name}`);
    },
    AbortSignal,
    Blob,
    Buffer,
    FormData,
  };
  vm.runInNewContext(`${patched};this.Host=Host;`, sandbox);
  const host = new sandbox.Host();
  const primaryWebContents = { id: 1 };
  host.windowManager = {
    getPrimaryWindows() {
      return [{ webContents: primaryWebContents }];
    },
  };
  const rawHandler = host.handlers()[HANDLER_NAME];
  return {
    handler(payload) {
      return rawHandler({ ...payload, origin: primaryWebContents });
    },
    rawHandler,
    primaryWebContents,
    execCalls,
    fetchCalls,
    patched,
  };
}

test("feature stays disabled until selected and loads both descriptors", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["dictation-capture-quality"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [
        descriptor.id,
        descriptor.phase,
        descriptor.ciPolicy,
      ]),
      [
        [
          "feature:dictation-capture-quality:dictation-openai-main-bridge",
          "main-bundle",
          "optional",
        ],
        [
          "feature:dictation-capture-quality:composer-dictation-capture-quality",
          "webview-asset",
          "optional",
        ],
      ],
    );
    assert.deepEqual(
      enabledLinuxFeaturePackageDependencies({
        featuresRoot,
        packageFormat: "deb",
      }),
      ["libsecret-tools"],
    );
    assert.deepEqual(
      enabledLinuxFeaturePackageDependencies({
        featuresRoot,
        packageFormat: "rpm",
      }),
      [],
    );
    assert.deepEqual(
      enabledLinuxFeaturePackageDependencies({
        featuresRoot,
        packageFormat: "pacman",
      }),
      ["libsecret"],
    );
  });
});

test("feature conflicts with conversation mode's microphone processing", () => {
  assert.throws(
    () => withFeatureConfig(
      ["read-aloud", "conversation-mode", "dictation-capture-quality"],
      (featuresRoot) => loadLinuxFeaturePatchDescriptors({ featuresRoot }),
    ),
    /conflicts with 'conversation-mode'/,
  );
});

test("descriptors target only the main bundle and current app-initial asset", () => {
  assert.equal(descriptors[0].phase, "main-bundle");
  assert.equal(descriptors[1].pattern.test("app-initial-CRKqnyc3.js"), true);
  assert.equal(descriptors[1].pattern.test("app-initial~app-main~page.js"), false);
  assert.equal(descriptors[1].pattern.test("global-dictation-page.js"), false);
});

test("webview patch uses clean capture and forces the trusted batch bridge", () => {
  const patched = applyDictationCaptureQualityPatch(dictationSource);

  assert.notEqual(patched, dictationSource);
  assert.match(
    patched,
    /channelCount:2,echoCancellation:!1,noiseSuppression:!1,autoGainControl:!1/,
  );
  assert.match(
    patched,
    new RegExp(`vscode://codex/${HANDLER_NAME}`),
  );
  assert.match(patched, /audioBase64:__codexAudioBase64/);
  assert.match(patched, /cleanupEnabled:!1,streamingEnabled:!1/);
  assert.match(
    patched,
    new RegExp(`e\\.size<=0\\|\\|e\\.size>${MAX_AUDIO_BYTES}`),
  );
  assert.doesNotMatch(patched, /post\(`\/transcribe`/);
  assert.equal(applyDictationCaptureQualityPatch(patched), patched);
});

test("webview patch rejects an oversized blob before reading it", async () => {
  const sandbox = { Number, Uint8Array };
  vm.runInNewContext(
    `${applyDictationCaptureQualityPatch(dictationSource)};this.fallback=Lrt;`,
    sandbox,
  );
  let read = false;

  await assert.rejects(
    () => sandbox.fallback({
      type: "audio/webm",
      size: MAX_AUDIO_BYTES + 1,
      async arrayBuffer() {
        read = true;
        return new ArrayBuffer(0);
      },
    }),
    /invalid or too large/,
  );
  assert.equal(read, false);
});

test("webview patch fails soft and atomically when anchors drift", () => {
  for (const [source, expectedWarning] of [
    [
      dictationSource.replace("channelCount:1", "sampleRate:48e3"),
      /Expected one composer microphone constraint/,
    ],
    [
      dictationSource.replace("post(`/transcribe`", "post(`/other`"),
      /Expected one multipart transcription fallback/,
    ],
    [
      dictationSource.replace("streamingEnabled:n", "streamingEnabled:gate()"),
      /Expected one composer streaming flag/,
    ],
  ]) {
    const { value, warnings } = captureWarnings(() =>
      applyDictationCaptureQualityPatch(source),
    );
    assert.equal(value, source);
    assert.match(warnings.join("\n"), expectedWarning);
    assert.doesNotMatch(value, /codexLinuxOpenAITranscription/);
  }
});

test("main bridge patch uses the trusted handler map and is idempotent", () => {
  const source = syntheticMainBundle();
  const patched = applyDictationMainBridgePatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, new RegExp(`"${HANDLER_NAME}":async`));
  assert.match(patched, /\/usr\/bin\/secret-tool/);
  assert.match(
    patched,
    /require\(`node:child_process`\)\.execFile\(`\/usr\/bin\/secret-tool`/,
  );
  assert.doesNotMatch(patched, /__codexChild\.execFile/);
  assert.match(patched, new RegExp(SECRET_SERVICE));
  assert.match(patched, /https:\/\/api\.openai\.com\/v1\/audio\/transcriptions/);
  assert.match(patched, /gpt-4o-transcribe/);
  assert.match(patched, /append\(`language`,`en`\)/);
  assert.equal(applyDictationMainBridgePatch(patched), patched);
});

test("main bridge fails soft when its handler insertion point drifts", () => {
  const source = syntheticMainBundle().replace(
    "\"native-desktop-apps\":async",
    "\"desktop-apps\":async",
  );
  const { value, warnings } = captureWarnings(() =>
    applyDictationMainBridgePatch(source),
  );

  assert.equal(value, source);
  assert.match(warnings.join("\n"), /Expected one trusted handler insertion point/);
});

test("main bridge fails soft when it finds a partial prior insertion", () => {
  const source = syntheticMainBundle().replace(
    "\"native-desktop-apps\":async",
    `"${HANDLER_NAME}":async()=>({}),"native-desktop-apps":async`,
  );
  const { value, warnings } = captureWarnings(() =>
    applyDictationMainBridgePatch(source),
  );

  assert.equal(value, source);
  assert.match(warnings.join("\n"), /incomplete.*main-process bridge/i);
});

test("main bridge rejects non-primary callers before keyring or network access", async () => {
  const { rawHandler, execCalls, fetchCalls } = createMainHarness();

  await assert.rejects(
    () => rawHandler({
      audioBase64: webmBase64(),
      contentType: "audio/webm",
      origin: { id: 2 },
    }),
    /unavailable from this window/,
  );
  assert.equal(execCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test("main bridge sends exact WebM, model, language, endpoint, and keyring credential", async () => {
  const key = "unit-test-openai-key-material";
  const { handler, execCalls, fetchCalls } = createMainHarness({ key });
  const audio = webmBase64([1, 2, 3, 4]);

  const response = await handler({
    audioBase64: audio,
    contentType: "audio/webm;codecs=opus",
  });

  assert.equal(response.text, "The morning air felt cool and fresh.");
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].command, "/usr/bin/secret-tool");
  assert.deepEqual(Array.from(execCalls[0].args), [
    "lookup",
    "service",
    SECRET_SERVICE,
  ]);
  assert.equal(execCalls[0].options.encoding, null);
  assert.equal(execCalls[0].options.shell, undefined);
  assert.equal(fetchCalls.length, 1);
  assert.equal(
    fetchCalls[0].url,
    "https://api.openai.com/v1/audio/transcriptions",
  );
  assert.equal(fetchCalls[0].authorization, `Bearer ${key}`);
  assert.equal(fetchCalls[0].model, "gpt-4o-transcribe");
  assert.equal(fetchCalls[0].language, "en");
  assert.equal(fetchCalls[0].filename, "codex.webm");
  assert.equal(fetchCalls[0].contentType, "audio/webm");
  assert.deepEqual(fetchCalls[0].fileBytes, Buffer.from(audio, "base64"));
  assert.equal(fetchCalls[0].signal instanceof AbortSignal, true);
});

test("main bridge rejects invalid, oversized, and non-WebM audio before key or network", async () => {
  const cases = [
    { audioBase64: "", contentType: "audio/webm" },
    { audioBase64: "not-base64", contentType: "audio/webm" },
    {
      audioBase64: Buffer.from("plain text").toString("base64"),
      contentType: "audio/webm",
    },
    {
      audioBase64: webmBase64(),
      contentType: "audio/wav",
    },
    {
      audioBase64: Buffer.alloc(MAX_AUDIO_BYTES + 1).toString("base64"),
      contentType: "audio/webm",
    },
  ];

  for (const payload of cases) {
    const { handler, execCalls, fetchCalls } = createMainHarness();
    await assert.rejects(() => handler(payload), /invalid|WebM\/Opus|too large/i);
    assert.equal(execCalls.length, 0);
    assert.equal(fetchCalls.length, 0);
  }
});

test("main bridge hides keyring details when the Codex credential is missing", async () => {
  const { handler, fetchCalls } = createMainHarness({
    keyError: new Error("secret-tool private backend failure"),
  });

  await assert.rejects(
    () => handler({ audioBase64: webmBase64(), contentType: "audio/webm" }),
    (error) => {
      assert.match(error.message, /key is unavailable/);
      assert.doesNotMatch(error.message, /private backend failure/);
      return true;
    },
  );
  assert.equal(fetchCalls.length, 0);
});

test("main bridge rejects empty and malformed stored credentials", async () => {
  for (const key of ["", "too-short"]) {
    const { handler, fetchCalls } = createMainHarness({ key });
    await assert.rejects(
      () => handler({ audioBase64: webmBase64(), contentType: "audio/webm" }),
      /key is unavailable/,
    );
    assert.equal(fetchCalls.length, 0);
  }
});

test("main bridge reports API statuses without returning upstream bodies", async () => {
  for (const status of [401, 429, 500]) {
    let bodyCancelled = false;
    const { handler } = createMainHarness({
      fetchImpl: async () => ({
        ok: false,
        status,
        body: {
          async cancel() {
            bodyCancelled = true;
          },
        },
        async json() {
          return { error: { message: "private upstream detail" } };
        },
      }),
    });
    await assert.rejects(
      () => handler({ audioBase64: webmBase64(), contentType: "audio/webm" }),
      (error) => {
        assert.match(error.message, new RegExp(`\\(${status}\\)`));
        assert.doesNotMatch(error.message, /private upstream detail/);
        return true;
      },
    );
    assert.equal(bodyCancelled, true);
  }
});

test("main bridge rejects invalid JSON and missing transcript text", async () => {
  const invalidJson = createMainHarness({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError("bad JSON");
      },
    }),
  });
  await assert.rejects(
    () => invalidJson.handler({
      audioBase64: webmBase64(),
      contentType: "audio/webm",
    }),
    /invalid JSON/,
  );

  const missingText = createMainHarness({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {};
      },
    }),
  });
  await assert.rejects(
    () => missingText.handler({
      audioBase64: webmBase64(),
      contentType: "audio/webm",
    }),
    /did not contain text/,
  );
});

test("main bridge combines caller cancellation with its request timeout", async () => {
  const controller = new AbortController();
  const { handler } = createMainHarness({
    fetchImpl: async (_url, options) => {
      controller.abort(new Error("cancelled by caller"));
      assert.equal(options.signal.aborted, true);
      throw options.signal.reason;
    },
  });

  await assert.rejects(
    () => handler({
      audioBase64: webmBase64(),
      contentType: "audio/webm",
      signal: controller.signal,
    }),
    /cancelled by caller/,
  );
});

test("main bridge allows only one paid transcription at a time", async () => {
  let release;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const { handler, execCalls, fetchCalls } = createMainHarness({
    fetchImpl: async () => response,
  });
  const payload = {
    audioBase64: webmBase64(),
    contentType: "audio/webm",
  };
  const first = handler(payload);
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(() => handler(payload), /already in progress/);
  assert.equal(execCalls.length, 1);
  assert.equal(fetchCalls.length, 1);

  release({
    ok: true,
    status: 200,
    async json() {
      return { text: "First transcript." };
    },
  });
  assert.equal((await first).text, "First transcript.");
  assert.equal((await handler(payload)).text, "First transcript.");
  assert.equal(execCalls.length, 2);
  assert.equal(fetchCalls.length, 2);
});

test("enabled descriptors patch both a synthetic main bundle and webview asset", () => {
  withFeatureConfig(["dictation-capture-quality"], (featuresRoot) => {
    withTempDir((extractedDir) => {
      const assetsDir = path.join(extractedDir, "webview", "assets");
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(
        path.join(assetsDir, "app-initial-fixture.js"),
        dictationSource,
      );

      const normalized = normalizePatchDescriptors(
        loadLinuxFeaturePatchDescriptors({ featuresRoot }),
      );
      const main = applyMainBundlePatchDescriptors(
        syntheticMainBundle(),
        normalized,
        {},
        null,
      ).patchedSource;
      applyWebviewAssetPatchDescriptors(extractedDir, normalized, {}, null);
      const webview = fs.readFileSync(
        path.join(assetsDir, "app-initial-fixture.js"),
        "utf8",
      );

      assert.match(main, new RegExp(`"${HANDLER_NAME}":async`));
      assert.match(webview, new RegExp(`vscode://codex/${HANDLER_NAME}`));
      assert.match(webview, /codexLinuxDictationCaptureQuality/);
      assert.match(webview, /codexLinuxDictationBatchOnly/);
    });
  });
});

test("renderer contains no key, OpenAI endpoint, or main-process primitives", () => {
  const renderer = applyDictationCaptureQualityPatch(dictationSource);
  const featureText = [
    fs.readFileSync(path.join(__dirname, "feature.json"), "utf8"),
    fs.readFileSync(path.join(__dirname, "README.md"), "utf8"),
    fs.readFileSync(path.join(__dirname, "patch.js"), "utf8"),
  ].join("\n");

  assert.doesNotMatch(
    renderer,
    /Authorization|OPENAI_API_KEY|secret-tool|api\.openai\.com|gpt-4o-transcribe/,
  );
  assert.doesNotMatch(featureText, /OPENAI_API_KEY=/);
  assert.doesNotMatch(featureText, /\/home\/[A-Za-z0-9._-]+/);
});
