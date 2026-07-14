#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
const {
  applyWebviewAssetPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  patchExtractedApp,
} = require("../../scripts/patches/runner.js");
const {
  applyAssistantRenderPatch,
  applyComposerControlPatch,
  applyComposerPatch,
  applyComposerRuntimePatch,
  applyDictationEndpointPatch,
  applyReadAloudMainBundlePatch,
  descriptors: featurePatches,
} = require("./patch.js");

function twice(fn, source) {
  const patched = fn(source);
  assert.equal(fn(patched), patched);
  return patched;
}

function withTempFeatureConfig(enabled, fn) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  const root = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-mode-feature-"));
  process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(tempDir, "features.json");
  try {
    fs.writeFileSync(process.env.CODEX_LINUX_FEATURES_CONFIG, JSON.stringify({ enabled }, null, 2));
    return fn(root);
  } finally {
    if (originalConfig == null) {
      delete process.env.CODEX_LINUX_FEATURES_CONFIG;
    } else {
      process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withLinuxFeatureRootEnv(root, fn) {
  const originalRoot = process.env.CODEX_LINUX_FEATURES_ROOT;
  process.env.CODEX_LINUX_FEATURES_ROOT = root;
  try {
    return fn();
  } finally {
    if (originalRoot == null) {
      delete process.env.CODEX_LINUX_FEATURES_ROOT;
    } else {
      process.env.CODEX_LINUX_FEATURES_ROOT = originalRoot;
    }
  }
}

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

const mainBundleSource =
  "function codexLinuxReadAloudHandle(e={}){return e.action===`config`?codexLinuxReadAloudConfig():e.action===`setup`?codexLinuxReadAloudSetup(e):e.action===`stop`?codexLinuxReadAloudStop():e.action===`speak`&&e.source===`button`?codexLinuxReadAloudSpeak(e.text):codexLinuxReadAloudReport({spoken:!1,reason:`not-explicit`})}var h={handlers:{\"linux-read-aloud\":async(e)=>codexLinuxReadAloudHandle(e),\"native-desktop-apps\":async()=>({apps:[]})}};";

const explicitButtonMainBundleSource =
  "function codexLinuxReadAloudHandle(e={}){return e.action===`config`?codexLinuxReadAloudConfig():e.action===`setup`?codexLinuxReadAloudSetup(e):e.action===`stop`?codexLinuxReadAloudStop():e.action===`speak`&&e.source===`button`?codexLinuxReadAloudSpeak(e.text,{requireEnabled:!1}):codexLinuxReadAloudReport({spoken:!1,reason:`not-explicit`})}var h={handlers:{\"linux-read-aloud\":async(e)=>codexLinuxReadAloudHandle(e),\"native-desktop-apps\":async()=>({apps:[]})}};";

const currentComposerAsset =
  "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-current.js";
const currentDictationAsset =
  "app-initial~app-main~onboarding-page-current.js";

const dictationSource =
  "function Lke({onTranscriptInsert:i,onTranscriptSend:a}){let h={current:null},g={current:null},y={current:[]},b={current:null};let P=async({action:t,handlers:r})=>{let a=`hello`;a.length>0&&(df.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:a}),t===`send`?r.onTranscriptSend(a):r.onTranscriptInsert(a))},F=async()=>{let e=b.current??`insert`,r=h.current,i=y.current;y.current=[],r&&(r.ondataavailable=null,r.onstop=null),h.current=null,A();await P({action:e,audio:i,handlers:{onTranscriptInsert:i,onTranscriptSend:a}})},L=e=>{b.current=e;let t=h.current;t.state!==`inactive`&&t.stop()};return{startDictation:async()=>{let e=await _Oe({channelCount:1});let t=new MediaRecorder(e);if(h.current=t,y.current=[],t.ondataavailable=e=>{e.data.size>0&&y.current.push(e.data)},t.onstop=()=>{F()},t.start(),u(!0),b.current!=null){t.stop();return}},stopDictation:L}}";

const currentComposerControlSource =
  "function Vka({isResponseInProgress:x,onStop:T,submitBlockReason:E,voiceControls:A}){let j=Nn(Bk);let M=RZ(),N=Rk(j),P=LEa(j.value,t),{canRetryDictation:B,dictationShortcutLabel:V,isDictating:U,isDictationButtonVisible:W,isDictationSupported:G,isTranscribing:ee,isVoiceFooterVisible:te,recordingDurationMs:ne,retryDictation:K,startDictation:re,stopDictation:ie,restrictedSession:ae,waveformCanvasRef:oe}=A;let je=(0,x7.jsx)(_ka,{conversationId:N,hostId:g,cwdOverride:_}),ke=(0,x7.jsx)(Twe,{isTranscribing:ee,recordingDurationMs:ne,waveformCanvasRef:oe,stopDictation:ie}),Ae=(0,x7.jsx)(Ewe,{isVisible:W,disabled:!G||ae.thread.phase!==`inactive`,isTranscribing:ee,canRetryDictation:B,shortcutLabel:V,retryDictation:K,startDictation:re,stopDictation:ie});return Ae}";

const assistantRenderSource =
  "return (0,$.jsx)(Ov,{item:n,alwaysShowActions:M,assistantCopyText:p,turnId:m,after:g,conversationId:o,cwd:u,renderCodeBlocksAsWritingBlocks:V})";

const conversationGlobals = [
  "codexLinuxConversationAvailable",
  "codexLinuxConversationAssistant",
  "codexLinuxConversationEndpoint",
  "codexLinuxConversationIsActive",
  "codexLinuxConversationIsSpeaking",
  "codexLinuxConversationStop",
  "codexLinuxConversationShouldSendTranscript",
  "codexLinuxConversationStopSpeaking",
  "codexLinuxConversationSync",
  "codexLinuxConversationToggle",
  "codexLinuxConversationToggleMute",
  "codexLinuxConversationVersion",
];

test("dictation endpoint descriptor targets the current dictation bundle", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "dictation-endpoint");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test(currentDictationAsset), true);
  assert.equal(descriptor.pattern.test(currentComposerAsset), false);
  assert.equal(descriptor.pattern.test("app-initial~app-main~onboarding-page-BUwCKIcU.js"), true);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~app-main~onboarding-page~debug-window-page~debug-modal-jrWqnMas.js",
    ),
    false,
  );
  assert.equal(descriptor.pattern.test("use-dictation-BUwCKIcU.js"), false);
  assert.equal(descriptor.pattern.test("use-dictation-hotkey-BUwCKIcU.js"), false);
});

test("composer descriptor targets only the current primary app bundle", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "composer-control");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test(currentComposerAsset), true);
  assert.equal(descriptor.pattern.test("app-initial~app-main~page-hSvsQcNf.js"), false);
  assert.equal(descriptor.pattern.test("composer-old.js"), false);
});

test("current DMG co-locates dictation and assistant ownership apart from the composer", () => {
  const dictation = featurePatches.find((patch) => patch.id === "dictation-endpoint");
  const composer = featurePatches.find((patch) => patch.id === "composer-control");
  const assistant = featurePatches.find((patch) => patch.id === "assistant-observer");
  const dictationAsset = "app-initial~app-main~onboarding-page-CIkoyvFz.js";
  const composerAsset =
    "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~iufn7mg3-DRU9Ekz0.js";
  const adjacentComposerAsset =
    "app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~lhgjoyjn-CMTECkzu.js";

  assert.equal(dictation.pattern.test(dictationAsset), true);
  assert.equal(dictation.pattern.test(composerAsset), false);
  assert.equal(assistant.pattern.test(dictationAsset), true);
  assert.equal(composer.pattern.test(composerAsset), true);
  assert.equal(composer.pattern.test(dictationAsset), false);
  assert.equal(composer.pattern.test(adjacentComposerAsset), false);
});

function fetchBodies(events) {
  return events.map((event) => JSON.parse(event.body));
}

function runTimer(timers, predicate, label) {
  const timer = timers.find((entry) => !entry.cleared && predicate(entry));
  assert.ok(timer, label);
  timer.cleared = true;
  timer.callback();
}

function withConversationRuntime(fn, options = {}) {
  const originalGlobals = conversationGlobals.map((name) => [
    name,
    Object.prototype.hasOwnProperty.call(globalThis, name),
    globalThis[name],
  ]);
  const events = [];
  const messageListeners = [];
  const timers = [];
  const fakeWindow = {
    AudioContext: options.AudioContext,
    MutationObserver: options.MutationObserver,
    innerHeight: options.innerHeight ?? 900,
    innerWidth: options.innerWidth ?? 1600,
    webkitAudioContext: options.webkitAudioContext,
    addEventListener(type, callback) {
      if (type === "message") {
        messageListeners.push(callback);
      }
    },
    dispatchEvent(event) {
      events.push(event.detail);
    },
  };
  const fakeNavigator = options.navigator ?? {
    userAgent: "Codex Desktop Linux",
    mediaDevices: {},
  };
  const fakeLocalStorage = {
    getItem: options.getLocalStorageItem ?? (() => null),
  };
  const fakePerformance = options.performance ?? {
    now() {
      return Date.now();
    },
  };
  const animationFrames = [];
  function FakeMediaRecorder() {}
  function FakeCustomEvent(_type, init) {
    this.detail = init?.detail;
  }
  function fakeSetTimeout(callback, delay) {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  }
  function fakeClearTimeout(timer) {
    if (timer) {
      timer.cleared = true;
    }
  }
  function fakeRequestAnimationFrame(callback) {
    const frame = { callback, cleared: false };
    animationFrames.push(frame);
    return frame;
  }
  function fakeCancelAnimationFrame(frame) {
    if (frame) {
      frame.cleared = true;
    }
  }

  try {
    const patched = applyComposerRuntimePatch("");
    new Function(
      "window",
      "navigator",
      "localStorage",
      "MediaRecorder",
      "CustomEvent",
      "setTimeout",
      "clearTimeout",
      "performance",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "document",
      patched,
    )(
      fakeWindow,
      fakeNavigator,
      fakeLocalStorage,
      FakeMediaRecorder,
      FakeCustomEvent,
      fakeSetTimeout,
      fakeClearTimeout,
      fakePerformance,
      options.requestAnimationFrame ?? fakeRequestAnimationFrame,
      options.cancelAnimationFrame ?? fakeCancelAnimationFrame,
      options.document,
    );
    return fn({ animationFrames, events, messageListeners, timers });
  } finally {
    for (const [name, existed, value] of originalGlobals) {
      if (existed) {
        globalThis[name] = value;
      } else {
        delete globalThis[name];
      }
    }
  }
}

function createFakeClassList() {
  const values = new Set();
  return {
    contains(value) {
      return values.has(value);
    },
    add(value) {
      values.add(value);
    },
    remove(value) {
      values.delete(value);
    },
    toggle(value, force) {
      const enabled = force === undefined ? !values.has(value) : !!force;
      if (enabled) {
        values.add(value);
      } else {
        values.delete(value);
      }
      return enabled;
    },
  };
}

function createFakeDocument() {
  const nodes = new Map();
  const bodyClassList = createFakeClassList();
  const rootClassList = createFakeClassList();
  const rootStyleValues = new Map();
  const rootStyle = {
    getPropertyValue(name) {
      return rootStyleValues.get(name) ?? "";
    },
    removeProperty(name) {
      const value = rootStyleValues.get(name) ?? "";
      rootStyleValues.delete(name);
      return value;
    },
    setProperty(name, value) {
      rootStyleValues.set(name, value);
    },
  };
  const composerClassList = createFakeClassList();
  const composerSurface = {
    classList: composerClassList,
    getBoundingClientRect() {
      return { right: 1200, top: 760 };
    },
  };
  const composerAnchor = {
    parentElement: composerSurface,
    closest() {
      return composerSurface;
    },
  };
  const body = {
    appended: [],
    classList: bodyClassList,
    contains(node) {
      return node === composerSurface || this.appended.includes(node);
    },
    appendChild(node) {
      this.appended.push(node);
      if (node.id) {
        nodes.set(node.id, node);
      }
    },
  };
  const head = {
    appended: [],
    appendChild(node) {
      this.appended.push(node);
      if (node.id) {
        nodes.set(node.id, node);
      }
    },
  };

  function createElement(tagName) {
    const node = {
      tagName,
      className: "",
      dataset: {},
      hidden: false,
      listeners: {},
      setAttribute(name, value) {
        this[name] = value;
      },
      addEventListener(name, callback) {
        this.listeners[name] = callback;
      },
    };
    Object.defineProperty(node, "id", {
      get() {
        return this._id || "";
      },
      set(value) {
        this._id = value;
        if (value) {
          nodes.set(value, this);
        }
      },
    });
    return node;
  }

  return {
    body,
    bodyClassList,
    head,
    documentElement: { classList: rootClassList, clientHeight: 900, clientWidth: 1600, style: rootStyle },
    getElementById(id) {
      return nodes.get(id) ?? null;
    },
    querySelectorAll() {
      return [composerAnchor];
    },
    createElement,
    composerClassList,
    rootStyle,
  };
}

function createAudioStream() {
  return {
    getTracks() {
      return [];
    },
  };
}

function createCountingAudioContext({ level = () => 0 } = {}) {
  const stats = {
    fftSizes: [],
    sampleCalls: 0,
  };
  class FakeAudioContext {
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {},
      };
    }
    createAnalyser() {
      return {
        _fftSize: 0,
        set fftSize(value) {
          stats.fftSizes.push(value);
          this._fftSize = value;
        },
        get fftSize() {
          return this._fftSize;
        },
        getFloatTimeDomainData(data) {
          stats.sampleCalls++;
          data.fill(level());
        },
      };
    }
    close() {}
  }
  return { AudioContext: FakeAudioContext, stats };
}

test("conversation mode stays disabled until listed in features.json", () => {
  withTempFeatureConfig([], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), []);
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot: root }), []);
  });
});

test("conversation mode requires Read Aloud to be enabled explicitly", () => {
  withTempFeatureConfig(["conversation-mode"], (root) => {
    assert.throws(
      () => loadLinuxFeaturePatchDescriptors({ featuresRoot: root }),
      /requires 'read-aloud' to be enabled/,
    );
  });
});

test("conversation mode exposes optional patch descriptors when enabled", () => {
  withTempFeatureConfig(["read-aloud", "conversation-mode"], (root) => {
    assert.deepEqual(
      enabledLinuxFeatureIds({ featuresRoot: root }),
      ["read-aloud", "conversation-mode"],
    );

    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: root }).filter(
      (patch) => patch.featureId === "conversation-mode",
    );
    assert.deepEqual(
      patches.map((patch) => [patch.name, patch.phase, patch.ciPolicy]),
      [
        ["feature:conversation-mode:read-aloud-conversation-source", "main-bundle", "optional"],
        ["feature:conversation-mode:dictation-endpoint", "webview-asset", "optional"],
        ["feature:conversation-mode:composer-control", "webview-asset", "optional"],
        ["feature:conversation-mode:assistant-observer", "webview-asset", "optional"],
      ],
    );
  });
});

test("main bundle patch allows conversation mode to use Read Aloud", () => {
  const patched = twice(applyReadAloudMainBundlePatch, mainBundleSource);
  assert.match(patched, /e\.source===`button`\|\|e\.source===`conversation`/);
  assert.match(patched, /codexLinuxReadAloudSpeak\(e\.text,\{requireEnabled:!1\}\)/);
});

test("main bundle patch preserves explicit button speech while adding conversation mode", () => {
  const patched = twice(applyReadAloudMainBundlePatch, explicitButtonMainBundleSource);
  assert.match(patched, /e\.source===`button`\|\|e\.source===`conversation`/);
  assert.match(patched, /codexLinuxReadAloudSpeak\(e\.text,\{requireEnabled:!1\}\)/);
});

test("composer runtime appends one browser-side conversation controller", () => {
  const patched = twice(applyComposerRuntimePatch, "console.log(`composer`);");
  assert.match(patched, /conversation-mode-v26/);
  assert.match(patched, /activeConversationId/);
  assert.match(patched, /seenAssistantKeys/);
  assert.match(patched, /assistantKey/);
  assert.match(patched, /assistantFallbackKey/);
  assert.match(patched, /assistantFinalSpoken/);
  assert.match(patched, /assistantSpokenText/);
  assert.match(patched, /cursorSentAtMs/);
  assert.match(patched, /assistantSentAtMs/);
  assert.match(patched, /beforeCursor/);
  assert.match(patched, /awaitingUserTranscript/);
  assert.match(patched, /allowAssistant/);
  assert.match(patched, /epoch/);
  assert.match(patched, /speechCooldownUntil/);
  assert.match(patched, /interruptPendingEpoch/);
  assert.match(patched, /interruptSerial/);
  assert.match(patched, /cancelInterruptMonitor/);
  assert.match(patched, /clearTimeout\(n\.timer\)/);
  assert.match(patched, /codexLinuxConversationToggle/);
  assert.match(patched, /codexLinuxConversationToggleMute/);
  assert.match(patched, /codexLinuxConversationSync/);
  assert.match(patched, /codexLinuxConversationIsActive/);
  assert.match(patched, /codexLinuxConversationStop/);
  assert.match(patched, /codexLinuxConversationIsSpeaking/);
  assert.match(patched, /codexLinuxConversationStopSpeaking/);
  assert.match(patched, /codex-linux-conversation-active/);
  assert.match(patched, /codex-linux-conversation-composer-aura/);
  assert.match(patched, /codex-linux-conversation-composer-aura::after/);
  assert.match(patched, /codex-linux-conversation-aura/);
  assert.match(patched, /codex-linux-conversation-stop/);
  assert.match(patched, /codex-linux-conversation-mute/);
  assert.match(patched, /codex-linux-conversation-muted/);
  assert.match(patched, /Stop conversation mode/);
  assert.match(patched, /Mute microphone/);
  assert.match(patched, /Unmute microphone/);
  assert.match(patched, /codexLinuxConversationEndpoint/);
  assert.match(patched, /codexLinuxConversationAssistant/);
  assert.match(patched, /codexLinuxConversationShouldSendTranscript/);
  assert.match(patched, /source:"conversation"/);
  assert.match(patched, /slice\(0,8e3\)/);
  assert.match(patched, /Math\.min\(600000,words\*430\)/);
  assert.match(patched, /codex-linux-conversation-silence-ms/);
  assert.match(patched, /\|\|1800/);
  assert.match(patched, /Math\.min\(2000,Math\.max\(900,quiet\)\)/);
  assert.match(patched, /possibleThreshold/);
  assert.match(patched, /threshold\*\.45/);
  assert.match(patched, /codex-linux-conversation-interrupt-threshold/);
  assert.match(patched, /interruptMs:420/);
  assert.match(patched, /interruptGraceMs:180/);
  assert.match(patched, /audioPollMs:32/);
  assert.match(patched, /echoCancellation:!0/);
  assert.match(patched, /resetTranscriptState/);
  assert.match(patched, /stopTracks/);
  assert.match(patched, /lastSpeech=now/);
  assert.match(patched, /waitForQuietAssistant/);
  assert.match(patched, /isResponseInProgress/);
  assert.match(patched, /startListeningSoon\(0,!0\)/);
  assert.match(patched, /spokenEchoText/);
  assert.match(patched, /isLikelySpeechEcho/);
  assert.doesNotThrow(() => new Function("window", "navigator", "localStorage", patched));
});

test("conversation runtime is scoped to the active conversation id", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(globalThis.codexLinuxConversationToggle({ conversationId: null }), false);

    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation() {},
      onStop() {},
    };
    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Please answer the current request.", "send"), true);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);

    const assistantText =
      "This is a long enough assistant sentence to stream through the active conversation voice path.";
    globalThis.codexLinuxConversationAssistant({}, assistantText, "thread-a", "current-turn", true);
    let bodies = fetchBodies(events);
    assert.equal(bodies.filter((body) => body.action === "speak").length, 0);

    globalThis.codexLinuxConversationAssistant({}, assistantText, "thread-a", "current-turn", false);
    bodies = fetchBodies(events);
    assert.ok(
      bodies.some((body) => body.action === "speak" && body.source === "conversation"),
      bodies.map((body) => body.action).join(","),
    );

    const speakCountBeforeSwitch = bodies.filter((body) => body.action === "speak").length;
    assert.equal(globalThis.codexLinuxConversationSync("thread-b"), false);
    globalThis.codexLinuxConversationAssistant(
      {},
      "This second assistant sentence belongs to another chat and must not be spoken.",
      "thread-b",
      "other-turn",
      true,
    );
    bodies = fetchBodies(events);
    assert.equal(bodies.filter((body) => body.action === "speak").length, speakCountBeforeSwitch);
    assert.ok(bodies.filter((body) => body.action === "stop").length >= 2);
  });
});

test("conversation runtime completes task switch cleanup when the dictation callback rejects render-time calls", () => {
  const fakeDocument = createFakeDocument();
  withConversationRuntime(() => {
    let stopCalls = 0;
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation() {
        stopCalls++;
        throw new Error("A function wrapped in useStableCallback can't be called during rendering.");
      },
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-active"), true);

    assert.doesNotThrow(() => globalThis.codexLinuxConversationSync("thread-b", controls));
    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), false);
    assert.equal(globalThis.codexLinuxConversationStop(), false);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-active"), false);
    assert.equal(fakeDocument.composerClassList.contains("codex-linux-conversation-composer-aura"), false);
    assert.equal(fakeDocument.getElementById("codex-linux-conversation-stop").hidden, true);
    assert.equal(fakeDocument.getElementById("codex-linux-conversation-mute").hidden, true);
    assert.equal(stopCalls, 1);
  }, { document: fakeDocument });
});

test("conversation runtime can be explicitly exited from the active voice control", () => {
  withConversationRuntime(({ events }) => {
    const stopActions = [];
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation(action) {
        stopActions.push(action);
      },
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), true);
    assert.equal(globalThis.codexLinuxConversationIsActive("thread-b"), false);

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), false);
    assert.ok(fetchBodies(events).some((body) => body.action === "stop"));
    assert.deepEqual(stopActions, ["discard"]);
  });
});

test("conversation runtime exits when the unified shell opens ChatGPT in a non-English locale", () => {
  let chatOpen = false;
  let mutationCallback = null;
  let mutationOptions = null;
  const stopActions = [];
  const queriedSelectors = [];
  const document = createFakeDocument();
  const closeButton = { getAttribute: (name) => name === "aria-label" ? "Fechar chat" : null };
  const chatSurface = { querySelector: () => closeButton };
  document.querySelector = (selector) => {
    queriedSelectors.push(selector);
    return selector === 'section[role="dialog"][data-pip-obstacle="quick-chat"][data-state="open"]' && chatOpen
      ? chatSurface
      : null;
  };
  class FakeMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
    }
    observe(_target, options) {
      mutationOptions = options;
    }
  }

  withConversationRuntime(() => {
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation(action) {
        stopActions.push(action);
      },
      onStop() {},
    };
    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), true);

    chatOpen = true;
    mutationCallback();

    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), false);
    assert.deepEqual(stopActions, ["discard"]);
    assert.equal(closeButton.getAttribute("aria-label"), "Fechar chat");
    assert.equal(queriedSelectors.some((selector) => selector.includes("aria-label")), false);
    assert.deepEqual(mutationOptions, {
      attributes: true,
      attributeFilter: ["data-state"],
      childList: true,
      subtree: true,
    });
  }, { document, MutationObserver: FakeMutationObserver });
});

test("conversation runtime resets duplicate transcript guards for a fresh session", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    withConversationRuntime(() => {
      const controls = {
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      };
      const repeated = "Repeat this exact first request in a new conversation session.";

      assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
      assert.equal(globalThis.codexLinuxConversationShouldSendTranscript(repeated, "send"), true);

      Date.now = () => 1_001_000;
      assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
      assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
      assert.equal(globalThis.codexLinuxConversationShouldSendTranscript(repeated, "send"), true);
    });
  } finally {
    Date.now = originalNow;
  }
});

test("conversation runtime shows an active aura and explicit stop control", () => {
  const fakeDocument = createFakeDocument();
  withConversationRuntime(({ events }) => {
    const stopActions = [];
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation(action) {
        stopActions.push(action);
      },
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-active"), true);
    assert.equal(fakeDocument.composerClassList.contains("codex-linux-conversation-composer-aura"), true);

    const stopButton = fakeDocument.getElementById("codex-linux-conversation-stop");
    assert.ok(stopButton);
    assert.equal(stopButton.hidden, false);
    assert.equal(stopButton.title, "Stop conversation mode");

    stopButton.listeners.click({
      preventDefault() {},
      stopPropagation() {},
    });

    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), false);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-active"), false);
    assert.equal(fakeDocument.composerClassList.contains("codex-linux-conversation-composer-aura"), false);
    assert.equal(fakeDocument.rootStyle.getPropertyValue("--codex-linux-conversation-control-right"), "");
    assert.equal(stopButton.hidden, true);
    assert.ok(fetchBodies(events).some((body) => body.action === "stop"));
    assert.deepEqual(stopActions, ["discard"]);
  }, { document: fakeDocument });
});

test("conversation runtime anchors controls near the composer on wide screens", () => {
  const fakeDocument = createFakeDocument();
  withConversationRuntime(() => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    assert.equal(fakeDocument.rootStyle.getPropertyValue("--codex-linux-conversation-control-right"), "352px");
    assert.equal(fakeDocument.rootStyle.getPropertyValue("--codex-linux-conversation-stop-bottom"), "148px");
    assert.equal(fakeDocument.rootStyle.getPropertyValue("--codex-linux-conversation-mute-bottom"), "194px");
  }, { document: fakeDocument, innerHeight: 900, innerWidth: 1600 });
});

test("conversation runtime can mute the user microphone without exiting", () => {
  const fakeDocument = createFakeDocument();
  withConversationRuntime(({ timers }) => {
    let startCount = 0;
    const stopActions = [];
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {
        startCount++;
      },
      stopDictation(action) {
        stopActions.push(action);
      },
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    runTimer(timers, (timer) => timer.delay === 0, "initial listening restart");
    assert.equal(startCount, 1);

    const muteButton = fakeDocument.getElementById("codex-linux-conversation-mute");
    assert.ok(muteButton);
    assert.equal(muteButton.hidden, false);
    assert.equal(muteButton.title, "Mute microphone");
    assert.equal(muteButton["aria-pressed"], "false");

    muteButton.listeners.click({
      preventDefault() {},
      stopPropagation() {},
    });

    assert.equal(globalThis.codexLinuxConversationIsActive("thread-a"), true);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-active"), true);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-muted"), true);
    assert.equal(muteButton.title, "Unmute microphone");
    assert.equal(muteButton["aria-pressed"], "true");
    assert.deepEqual(stopActions, ["discard"]);
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("This muted audio should be ignored.", "send"), false);

    globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: false });
    assert.equal(startCount, 1);

    assert.equal(globalThis.codexLinuxConversationToggleMute(), true);
    assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-muted"), false);
    assert.equal(muteButton.title, "Mute microphone");
    assert.equal(muteButton["aria-pressed"], "false");
    runTimer(timers, (timer) => timer.delay === 0, "unmuted listening restart");
    assert.equal(startCount, 2);
  }, { document: fakeDocument });
});

test("conversation runtime unmutes into immediate listening after speech cooldown", () => {
  const fakeDocument = createFakeDocument();
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    withConversationRuntime(({ events, timers }) => {
      let startCount = 0;
      const controls = {
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {
          startCount++;
        },
        stopDictation() {},
        onStop() {},
      };

      assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
      runTimer(timers, (timer) => timer.delay === 0, "initial listening restart");
      assert.equal(startCount, 1);

      assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Please answer once.", "send"), true);
      const spoken = "Short answer creates cooldown.";
      globalThis.codexLinuxConversationAssistant({ completed: true }, spoken, "thread-a", "turn-one", false);
      assert.deepEqual(
        fetchBodies(events)
          .filter((body) => body.action === "speak")
          .map((body) => body.text),
        [spoken],
      );
      runTimer(timers, (timer) => timer.delay > 2200 && timer.delay < 4000, "speech completion");

      assert.equal(globalThis.codexLinuxConversationToggleMute(true), true);
      assert.equal(globalThis.codexLinuxConversationToggleMute(false), true);
      assert.equal(fakeDocument.bodyClassList.contains("codex-linux-conversation-muted"), false);

      runTimer(timers, (timer) => timer.delay === 0, "unmuted listening restart");
      assert.equal(startCount, 2);
    }, { document: fakeDocument });
  } finally {
    Date.now = originalNow;
  }
});

test("conversation runtime ignores completed assistant messages seen before the active stream", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    globalThis.codexLinuxConversationAssistant(
      { completed: true },
      "This older completed assistant message should not be replayed aloud.",
      "thread-a",
      "old-turn",
      true,
    );
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 0);

    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Please answer the live request.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const assistantText = "This is the current streaming assistant sentence and it should be spoken after final.";
    globalThis.codexLinuxConversationAssistant({ completed: false }, assistantText, "thread-a", "new-turn", true);
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 0);

    globalThis.codexLinuxConversationAssistant({ completed: true }, assistantText, "thread-a", "new-turn", false);
    const bodies = fetchBodies(events);
    assert.ok(bodies.some((body) => body.action === "speak" && body.source === "conversation"));
  });
});

test("conversation runtime ignores stale assistant deltas after the next user turn starts", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the first answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const firstAssistantText = "This is the current live assistant sentence and it should speak once.";
    globalThis.codexLinuxConversationAssistant({ completed: false }, firstAssistantText, "thread-a", "turn-one", true);
    globalThis.codexLinuxConversationAssistant({ completed: true }, firstAssistantText, "thread-a", "turn-one", false);
    const speakCountBeforeUserTurn = fetchBodies(events).filter((body) => body.action === "speak").length;
    assert.equal(speakCountBeforeUserTurn, 1);

    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Please answer the next thing.", "send"), true);
    globalThis.codexLinuxConversationAssistant(
      { completed: false },
      "This is the current live assistant sentence and it should speak once. This old turn must not restart aloud.",
      "thread-a",
      "turn-one",
      true,
    );
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, speakCountBeforeUserTurn);

    globalThis.codexLinuxConversationAssistant(
      { completed: false },
      "This is the next live assistant sentence and it should be allowed to speak.",
      "thread-a",
      "turn-two",
      true,
    );
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, speakCountBeforeUserTurn);
    globalThis.codexLinuxConversationAssistant(
      { completed: true },
      "This is the next live assistant sentence and it should be allowed to speak.",
      "thread-a",
      "turn-two",
      false,
    );
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, speakCountBeforeUserTurn + 1);
  });
});

test("conversation runtime ignores unseen assistant messages before the speech cursor", () => {
  const originalNow = Date.now;
  try {
    Date.now = () => 1_000_000;
    withConversationRuntime(({ events }) => {
      assert.equal(
        globalThis.codexLinuxConversationToggle({
          conversationId: "thread-a",
          isResponseInProgress: false,
          startDictation() {},
          stopDictation() {},
          onStop() {},
        }),
        true,
      );

      assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start from the new cursor.", "send"), true);
      assert.equal(
        globalThis.codexLinuxConversationSync("thread-a", {
          isResponseInProgress: true,
          startDictation() {},
          stopDictation() {},
          onStop() {},
        }),
        true,
      );

      globalThis.codexLinuxConversationAssistant(
        { completed: true, sentAtMs: 900_000 },
        "This older assistant item was never seen before the cursor but must stay silent.",
        "thread-a",
        "old-unseen-turn",
        false,
      );
      assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 0);

      const current = "This assistant item is after the cursor and should be spoken.";
      globalThis.codexLinuxConversationAssistant(
        { completed: true, sentAtMs: 1_001_000 },
        current,
        "thread-a",
        "current-turn",
        false,
      );
      assert.deepEqual(
        fetchBodies(events)
          .filter((body) => body.action === "speak")
          .map((body) => body.text),
        [current],
      );
    });
  } finally {
    Date.now = originalNow;
  }
});

test("conversation runtime advances the cursor after an interrupt and never completes old silent output", () => {
  const originalNow = Date.now;
  try {
    withConversationRuntime(({ events }) => {
      assert.equal(
        globalThis.codexLinuxConversationToggle({
          conversationId: "thread-a",
          isResponseInProgress: false,
          startDictation() {},
          stopDictation() {},
          onStop() {},
        }),
        true,
      );

      Date.now = () => 1_000_000;
      assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the first answer.", "send"), true);
      assert.equal(
        globalThis.codexLinuxConversationSync("thread-a", {
          isResponseInProgress: true,
          startDictation() {},
          stopDictation() {},
          onStop() {},
        }),
        true,
      );

      const first = "This first assistant turn was spoken before the user interrupted.";
      const oldSilent = "This old follow-up arrived before the new user message and must be dropped.";
      globalThis.codexLinuxConversationAssistant({ completed: true, sentAtMs: 1_001_000 }, first, "thread-a", "turn-one", false);
      assert.deepEqual(
        fetchBodies(events)
          .filter((body) => body.action === "speak")
          .map((body) => body.text),
        [first],
      );

      Date.now = () => 1_100_000;
      assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Steer to the next answer.", "send"), true);
      globalThis.codexLinuxConversationAssistant(
        { completed: true, sentAtMs: 1_050_000 },
        oldSilent,
        "thread-a",
        "old-silent-turn",
        false,
      );
      assert.deepEqual(
        fetchBodies(events)
          .filter((body) => body.action === "speak")
          .map((body) => body.text),
        [first],
      );

      const next = "This is the assistant turn after the new user message.";
      globalThis.codexLinuxConversationAssistant({ completed: true, sentAtMs: 1_101_000 }, next, "thread-a", "turn-two", false);
      assert.deepEqual(
        fetchBodies(events)
          .filter((body) => body.action === "speak")
          .map((body) => body.text),
        [first, next],
      );
    });
  } finally {
    Date.now = originalNow;
  }
});

test("conversation runtime keeps a stable fallback key while the live turn has no exposed final id", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the fallback-key answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "This is the first assistant clause long enough to buffer now";
    const second = `${first} and this second clause should be treated as delta.`;

    globalThis.codexLinuxConversationAssistant({}, first, "thread-a", null, true);
    globalThis.codexLinuxConversationAssistant({}, second, "thread-a", null, true);
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 0);
    globalThis.codexLinuxConversationAssistant({ completed: true }, second, "thread-a", "final-turn", false);

    const spoken = fetchBodies(events)
      .filter((body) => body.action === "speak")
      .map((body) => body.text);
    assert.equal(spoken[0], second);
    assert.equal(
      spoken.filter((text) => text === first).length,
      0,
      `fallback key changed and replayed the first sentence: ${spoken.join(" | ")}`,
    );
  });
});

test("conversation runtime buffers assistant speech until the turn completes", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the buffered answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const partial = "This assistant response is still streaming and should stay silent for now";
    const final = `${partial} and the completed answer should speak once after the turn finishes. A second sentence should stay in the same voice request.`;
    globalThis.codexLinuxConversationAssistant({}, partial, "thread-a", null, true);
    globalThis.codexLinuxConversationAssistant({}, final, "thread-a", null, true);
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 0);

    globalThis.codexLinuxConversationAssistant({}, final, "thread-a", "turn-one", false);
    const spoken = fetchBodies(events)
      .filter((body) => body.action === "speak")
      .map((body) => body.text);
    assert.deepEqual(spoken, [final]);

    globalThis.codexLinuxConversationAssistant({}, final, "thread-a", "turn-one", false);
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [final],
    );
  });
});

test("conversation runtime reads each completed assistant turn in a multi-turn response", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run a multi-turn answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant turn.";
    const second = "Second completed assistant turn.";
    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first],
    );

    globalThis.codexLinuxConversationAssistant({ completed: true }, second, "thread-a", "turn-two", false);
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first],
    );

    runTimer(timers, (timer) => timer.delay === 2900, "first speech timer");
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first, second],
    );
  });
});

test("conversation runtime does not jump back to an older completed message while a newer live turn is pending", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run an answer with a tool gap.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant section.";
    const secondPartial = "Second assistant section is now being written";
    const secondFinal = `${secondPartial} and it should be the next spoken text.`;
    const old = "Older previous assistant message should never jump back into speech.";

    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: false }, secondPartial, "thread-a", "turn-two", true);
    globalThis.codexLinuxConversationAssistant({ completed: true }, old, "thread-a", "old-turn", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, secondFinal, "thread-a", "turn-two", false);

    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first],
    );

    runTimer(timers, (timer) => timer.delay === 2900, "first speech timer");
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first, secondFinal],
    );
  });
});

test("conversation runtime replaces a deferred old completed message when the next live turn appears", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run an answer across a tool gap.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant section.";
    const old = "Older completed assistant message re-rendered during the tool gap.";
    const nextPartial = "Next assistant section starts streaming after the tool gap";
    const nextFinal = `${nextPartial} and should replace the deferred old message.`;

    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, old, "thread-a", "old-turn", false);
    globalThis.codexLinuxConversationAssistant({ completed: false }, nextPartial, "thread-a", "turn-two", true);
    globalThis.codexLinuxConversationAssistant({ completed: true }, nextFinal, "thread-a", "turn-two", false);

    runTimer(timers, (timer) => timer.delay === 2900, "first speech timer");
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first, nextFinal],
    );
  });
});

test("conversation runtime speaks only the new suffix when the same assistant turn grows", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run a growing answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant turn.";
    const grown = `${first} Extra words arrive later.`;
    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, grown, "thread-a", "turn-one", false);

    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first],
    );

    runTimer(timers, (timer) => timer.delay === 2900, "first speech timer");
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first, "Extra words arrive later."],
    );
  });
});

test("conversation runtime does not duplicate a queued suffix on same-text rerender", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run a duplicate-rerender answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant turn.";
    const grown = `${first} Extra words arrive later.`;
    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, grown, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, grown, "thread-a", "turn-one", false);

    runTimer(timers, (timer) => timer.delay === 2900, "first speech timer");
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first, "Extra words arrive later."],
    );
  });
});

test("conversation runtime does not reread the same completed message after speech finishes", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run one final answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const final = "This completed assistant message should be read exactly once.";
    globalThis.codexLinuxConversationAssistant({ completed: true }, final, "thread-a", "turn-one", false);
    runTimer(timers, (timer) => timer.delay > 3000, "completed answer speech timer");

    globalThis.codexLinuxConversationAssistant({ completed: true }, final, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, final, "thread-a", "rerendered-turn-key", false);

    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [final],
    );
  });
});

test("conversation runtime speaks same-turn suffix immediately after prior speech ends", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run a late-growth answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant turn.";
    const grown = `${first} Extra words arrive later.`;
    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    runTimer(timers, (timer) => timer.delay === 2900, "first speech timer");

    globalThis.codexLinuxConversationAssistant({ completed: true }, grown, "thread-a", "turn-one", false);
    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first, "Extra words arrive later."],
    );
  });
});

test("conversation runtime flushes queued old suffix when the user starts a new turn", () => {
  withConversationRuntime(({ events, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Run a flushable answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const first = "First completed assistant turn.";
    const grown = `${first} Extra words arrive later.`;
    globalThis.codexLinuxConversationAssistant({ completed: true }, first, "thread-a", "turn-one", false);
    globalThis.codexLinuxConversationAssistant({ completed: true }, grown, "thread-a", "turn-one", false);

    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Steer to a new request.", "send"), true);
    assert.equal(
      timers.some((timer) => !timer.cleared && timer.delay === 2900),
      false,
    );

    assert.deepEqual(
      fetchBodies(events)
        .filter((body) => body.action === "speak")
        .map((body) => body.text),
      [first],
    );
  });
});

test("conversation runtime lets read aloud controls stop current speech without replaying it", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the stoppable answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const partial = "This assistant response is still streaming before the stop check";
    const final = `${partial} and is long enough to be spoken once and then stopped.`;
    globalThis.codexLinuxConversationAssistant({}, partial, "thread-a", "turn-one", true);
    globalThis.codexLinuxConversationAssistant({}, final, "thread-a", "turn-one", false);
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 1);
    assert.equal(globalThis.codexLinuxConversationIsSpeaking(), true);

    assert.equal(globalThis.codexLinuxConversationStopSpeaking(), true);
    assert.equal(globalThis.codexLinuxConversationIsSpeaking(), false);
    assert.ok(fetchBodies(events).some((body) => body.action === "stop"));

    globalThis.codexLinuxConversationAssistant({}, final, "thread-a", "turn-one", false);
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 1);
  });
});

test("conversation runtime rejects transcripts that look like recent spoken output", () => {
  withConversationRuntime(({ events }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the echo rejection answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const spokenText = "This assistant sentence is long enough to be spoken and later rejected as microphone echo.";
    globalThis.codexLinuxConversationAssistant({ completed: false }, spokenText, "thread-a", "turn-one", true);
    globalThis.codexLinuxConversationAssistant({ completed: true }, spokenText, "thread-a", "turn-one", false);
    assert.equal(fetchBodies(events).filter((body) => body.action === "speak").length, 1);

    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript(spokenText, "send"), false);
    assert.equal(
      globalThis.codexLinuxConversationShouldSendTranscript("Here is a genuinely new user request.", "send"),
      true,
    );
  });
});

test("conversation runtime clears read-aloud bridge timeouts after responses", () => {
  withConversationRuntime(({ events, messageListeners, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start the bridge timeout answer.", "send"), true);
    assert.equal(
      globalThis.codexLinuxConversationSync("thread-a", {
        isResponseInProgress: true,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const spokenText = "This assistant sentence is spoken through the bridge and then acknowledged.";
    globalThis.codexLinuxConversationAssistant({ completed: true }, spokenText, "thread-a", "turn-one", false);

    const speakEvent = events.find((event) => JSON.parse(event.body).action === "speak");
    assert.ok(speakEvent);
    const speakTimeout = timers.find((timer) => timer.delay === 8000 && !timer.cleared);
    assert.ok(speakTimeout);

    assert.equal(messageListeners.length, 1);
    messageListeners[0]({
      data: {
        type: "fetch-response",
        requestId: speakEvent.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: "{}",
      },
    });

    assert.equal(speakTimeout.cleared, true);
  });
});

test("conversation runtime opens one pending interrupt monitor stream", () => {
  let getUserMediaCalls = 0;
  let resolvePendingStream;
  let stoppedTracks = 0;
  const stream = {
    getTracks() {
      return [
        {
          stop() {
            stoppedTracks++;
          },
        },
      ];
    },
  };
  const navigator = {
    userAgent: "Codex Desktop Linux",
    mediaDevices: {
      getUserMedia() {
        getUserMediaCalls++;
        return {
          then(resolve) {
            resolvePendingStream = resolve;
            return {
              catch() {},
            };
          },
        };
      },
    },
  };
  class FakeAudioContext {
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {},
      };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(data) {
          data.fill(0);
        },
      };
    }
    close() {}
  }

  withConversationRuntime(() => {
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation() {},
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start a monitor-protected response.", "send"), true);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);
    assert.equal(getUserMediaCalls, 1);

    resolvePendingStream(stream);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);
    assert.equal(getUserMediaCalls, 1);
    assert.equal(stoppedTracks, 0);

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(stoppedTracks, 1);
  }, { AudioContext: FakeAudioContext, navigator });
});

test("conversation runtime invalidates pending interrupt monitors across mute toggles", () => {
  let getUserMediaCalls = 0;
  const pendingResolvers = [];
  let stoppedTracks = 0;
  const stream = {
    getTracks() {
      return [
        {
          stop() {
            stoppedTracks++;
          },
        },
      ];
    },
  };
  const navigator = {
    userAgent: "Codex Desktop Linux",
    mediaDevices: {
      getUserMedia() {
        getUserMediaCalls++;
        return {
          then(resolve) {
            pendingResolvers.push(resolve);
            return {
              catch() {},
            };
          },
        };
      },
    },
  };
  class FakeAudioContext {
    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {},
      };
    }
    createAnalyser() {
      return {
        fftSize: 0,
        getFloatTimeDomainData(data) {
          data.fill(0);
        },
      };
    }
    close() {}
  }

  withConversationRuntime(() => {
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation() {},
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start a monitor-protected response.", "send"), true);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);
    assert.equal(getUserMediaCalls, 1);

    assert.equal(globalThis.codexLinuxConversationToggleMute(true), true);
    assert.equal(globalThis.codexLinuxConversationToggleMute(false), true);
    assert.equal(getUserMediaCalls, 2);

    pendingResolvers[0](stream);
    assert.equal(stoppedTracks, 1);
    pendingResolvers[1](stream);
    assert.equal(stoppedTracks, 1);
  }, { AudioContext: FakeAudioContext, navigator });
});

test("conversation endpoint fails closed when the audio graph cannot start", () => {
  let stoppedTracks = 0;
  const stream = {
    getTracks() {
      return [
        {
          stop() {
            stoppedTracks++;
          },
        },
      ];
    },
  };
  class BrokenAudioContext {
    constructor() {
      throw new Error("audio graph unavailable");
    }
  }

  withConversationRuntime(() => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const cleanup = globalThis.codexLinuxConversationEndpoint({
      stream,
      stop() {
        throw new Error("stop should not be called when graph setup fails");
      },
      isActive() {
        return true;
      },
    });

    assert.equal(typeof cleanup, "function");
    assert.equal(stoppedTracks, 1);
    cleanup();
    assert.equal(stoppedTracks, 1);
  }, { AudioContext: BrokenAudioContext });
});

test("conversation endpoint paces microphone analysis below display frame rate", () => {
  const stream = createAudioStream();
  const { AudioContext, stats } = createCountingAudioContext({ level: () => 0.05 });

  withConversationRuntime(({ animationFrames, timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    const cleanup = globalThis.codexLinuxConversationEndpoint({
      stream,
      stop() {
        throw new Error("stop should not be called before the silence window");
      },
      isActive() {
        return true;
      },
    });

    assert.equal(stats.fftSizes.at(-1), 512);
    assert.equal(animationFrames.length, 0);
    runTimer(timers, (timer) => timer.delay === 32, "first endpoint audio poll");
    assert.equal(stats.sampleCalls, 1);
    runTimer(timers, (timer) => timer.delay === 32, "second endpoint audio poll");
    assert.equal(stats.sampleCalls, 2);

    cleanup();
    assert.equal(timers.filter((timer) => timer.delay === 32 && !timer.cleared).length, 0);
  }, { AudioContext, performance: { now: () => 320 } });
});

test("conversation interrupt monitor paces microphone analysis below display frame rate", () => {
  let now = 0;
  let getUserMediaCalls = 0;
  const stream = createAudioStream();
  const { AudioContext, stats } = createCountingAudioContext({ level: () => 0.05 });
  const navigator = {
    userAgent: "Codex Desktop Linux",
    mediaDevices: {
      getUserMedia() {
        getUserMediaCalls++;
        return {
          then(resolve) {
            resolve(stream);
            return {
              catch() {},
            };
          },
        };
      },
    },
  };

  withConversationRuntime(({ animationFrames, timers }) => {
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation() {},
      onStop() {},
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start a monitor-protected response.", "send"), true);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);
    assert.equal(getUserMediaCalls, 1);
    assert.equal(stats.fftSizes.at(-1), 512);
    assert.equal(animationFrames.length, 0);

    runTimer(timers, (timer) => timer.delay === 32, "first monitor audio poll");
    assert.equal(stats.sampleCalls, 1);
  }, { AudioContext, navigator, performance: { now: () => (now += 320) } });
});

test("conversation endpoint still stops dictation after paced silence", () => {
  let now = 0;
  let level = 0.05;
  let stopCalls = 0;
  const stream = createAudioStream();
  const { AudioContext } = createCountingAudioContext({ level: () => level });

  withConversationRuntime(({ timers }) => {
    assert.equal(
      globalThis.codexLinuxConversationToggle({
        conversationId: "thread-a",
        isResponseInProgress: false,
        startDictation() {},
        stopDictation() {},
        onStop() {},
      }),
      true,
    );

    globalThis.codexLinuxConversationEndpoint({
      stream,
      stop() {
        stopCalls++;
      },
      isActive() {
        return true;
      },
    });

    now = 32;
    runTimer(timers, (timer) => timer.delay === 32, "initial voiced endpoint poll");
    now = 288;
    runTimer(timers, (timer) => timer.delay === 32, "speech confirmation endpoint poll");
    assert.equal(stopCalls, 0);

    level = 0;
    now = 2100;
    runTimer(timers, (timer) => timer.delay === 32, "silence endpoint poll");
    assert.equal(stopCalls, 1);
    assert.equal(timers.filter((timer) => timer.delay === 32 && !timer.cleared).length, 0);
  }, { AudioContext, performance: { now: () => now } });
});

test("conversation interrupt monitor still triggers after sustained paced speech", () => {
  let now = 0;
  let onStopCalls = 0;
  const stream = createAudioStream();
  const { AudioContext, stats } = createCountingAudioContext({ level: () => 0.06 });
  const navigator = {
    userAgent: "Codex Desktop Linux",
    mediaDevices: {
      getUserMedia() {
        return {
          then(resolve) {
            resolve(stream);
            return {
              catch() {},
            };
          },
        };
      },
    },
  };

  withConversationRuntime(({ timers }) => {
    const controls = {
      conversationId: "thread-a",
      isResponseInProgress: false,
      startDictation() {},
      stopDictation() {},
      onStop() {
        onStopCalls++;
      },
    };

    assert.equal(globalThis.codexLinuxConversationToggle(controls), true);
    assert.equal(globalThis.codexLinuxConversationShouldSendTranscript("Start a monitor-protected response.", "send"), true);
    assert.equal(globalThis.codexLinuxConversationSync("thread-a", { ...controls, isResponseInProgress: true }), true);

    now = 200;
    runTimer(timers, (timer) => timer.delay === 32, "initial monitor speech poll");
    now = 650;
    runTimer(timers, (timer) => timer.delay === 32, "sustained monitor speech poll");

    assert.equal(stats.sampleCalls, 2);
    assert.equal(onStopCalls, 1);
    assert.equal(timers.filter((timer) => timer.delay === 32 && !timer.cleared).length, 0);
  }, { AudioContext, navigator, performance: { now: () => now } });
});

test("dictation endpoint patch adds VAD stop-on-silence and send action", () => {
  const patched = twice(applyDictationEndpointPatch, dictationSource);
  assert.match(patched, /echoCancellation:!0/);
  assert.match(patched, /noiseSuppression:!0/);
  assert.match(patched, /codexLinuxConversationCleanup/);
  assert.match(patched, /codexLinuxConversationEndpoint/);
  assert.match(patched, /codexLinuxConversationShouldSendTranscript/);
  assert.match(patched, /t!==`discard`/);
  assert.match(patched, /t===`send`\?r\.onTranscriptSend\(a\):r\.onTranscriptInsert\(a\)/);
  assert.match(patched, /stop:\(\)=>\{b\.current=`send`;t\.state!==`inactive`&&t\.stop\(\)\}/);
});

test("dictation endpoint patch fails soft and atomically when the current recorder contract drifts", () => {
  const drifted = dictationSource.replace("new MediaRecorder", "new AudioRecorder");
  const { value: patched, warnings } = captureWarns(() => applyDictationEndpointPatch(drifted));

  assert.equal(patched, drifted);
  assert.match(warnings.join("\n"), /Could not resolve the current dictation contract/);
  assert.doesNotMatch(patched, /echoCancellation/);
  assert.doesNotMatch(patched, /codexLinuxConversation/);
});

test("current dictation drift is reported as skipped instead of already applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-mode-drift-"));
  try {
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const assetPath = path.join(assetsDir, currentDictationAsset);
    const drifted = dictationSource.replace("new MediaRecorder", "new AudioRecorder");
    fs.writeFileSync(assetPath, drifted);
    const descriptor = featurePatches.find((patch) => patch.id === "dictation-endpoint");
    const descriptors = normalizePatchDescriptors([
      { ...descriptor, featureId: "conversation-mode", sourceKind: "feature" },
    ]);
    const report = createPatchReport();

    applyWebviewAssetPatchDescriptors(root, descriptors, {}, report);

    assert.equal(fs.readFileSync(assetPath, "utf8"), drifted);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.match(report.patches[0].reason, /Could not resolve the current dictation contract/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("composer control patch wires the current dictation control into conversation mode", () => {
  const patched = twice(applyComposerControlPatch, currentComposerControlSource);
  assert.match(
    patched,
    /codexLinuxConversationSync\?\.\(N,\{isResponseInProgress:x,isDictating:U,isTranscribing:ee,startDictation:re,stopDictation:ie,onStop:T\}\)/,
  );
  assert.match(
    patched,
    /codexLinuxConversationToggle\?\.\(\{conversationId:N,startDictation:re,stopDictation:ie,onStop:T,isDictating:U,isTranscribing:ee,isResponseInProgress:x,isDictationSupported:G\}\)/,
  );
  assert.match(patched, /isVisible:W\|\|N&&globalThis\.codexLinuxConversationAvailable\?\.\(\)/);
  assert.match(patched, /className:N\?`codex-linux-conversation-trigger`:void 0/);
  assert.match(patched, /startDictation:\(\)=>globalThis\.codexLinuxConversationToggle/);
});

test("composer control preserves the current async startDictation contract", async () => {
  const patched = applyComposerControlPatch(currentComposerControlSource);
  const originalResult = Promise.resolve("started");
  let originalStarts = 0;
  const context = {
    Bk: {},
    Ewe: "dictation-control",
    LEa: () => ({}),
    Nn: () => ({}),
    RZ: () => ({}),
    Rk: () => "thread-a",
    Twe: "waveform",
    _ka: "composer-anchor",
    _: null,
    g: "host-a",
    t: null,
    x7: {
      jsx(component, props) {
        return component === "dictation-control" ? props : {};
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(`${patched};globalThis.renderCurrentComposer=Vka`, context);
  context.codexLinuxConversationAvailable = () => true;
  context.codexLinuxConversationSync = () => {};
  const voiceControls = {
    canRetryDictation: false,
    dictationShortcutLabel: "D",
    isDictating: false,
    isDictationButtonVisible: true,
    isDictationSupported: true,
    isTranscribing: false,
    isVoiceFooterVisible: true,
    recordingDurationMs: 0,
    retryDictation() {},
    startDictation() {
      originalStarts++;
      return originalResult;
    },
    stopDictation() {},
    restrictedSession: { thread: { phase: "inactive" } },
    waveformCanvasRef: {},
  };
  const render = () => context.renderCurrentComposer({
    isResponseInProgress: false,
    onStop() {},
    submitBlockReason: null,
    voiceControls,
  });

  context.codexLinuxConversationToggle = () => false;
  assert.equal(render().startDictation(), originalResult);
  assert.equal(originalStarts, 1);

  context.codexLinuxConversationToggle = () => true;
  const handledResult = render().startDictation();
  assert.equal(typeof handledResult?.finally, "function");
  await handledResult;
  assert.equal(originalStarts, 1);
});

test("composer control patch fails soft when the current conversation binding drifts", () => {
  const drifted = currentComposerControlSource.replace("conversationId:N,hostId:g", "conversationKey:N,hostId:g");
  const { value: patched, warnings } = captureWarns(() => twice(applyComposerPatch, drifted));

  assert.equal(patched, drifted);
  assert.match(warnings.join("\n"), /Could not resolve composer prop aliases/);
  assert.doesNotMatch(patched, /codexLinuxConversationSync/);
  assert.doesNotMatch(patched, /codexLinuxConversationToggle/);
});

test("current composer marker drift is reported as skipped instead of already applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-mode-composer-drift-"));
  try {
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const assetPath = path.join(assetsDir, currentComposerAsset);
    const drifted = "console.log(`current composer contract drifted`);";
    fs.writeFileSync(assetPath, drifted);
    const descriptor = featurePatches.find((patch) => patch.id === "composer-control");
    const descriptors = normalizePatchDescriptors([
      { ...descriptor, featureId: "conversation-mode", sourceKind: "feature" },
    ]);
    const report = createPatchReport();

    applyWebviewAssetPatchDescriptors(root, descriptors, {}, report);

    assert.equal(fs.readFileSync(assetPath, "utf8"), drifted);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.match(report.patches[0].reason, /Could not find current composer controls/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("composer patch ignores adjacent composer chunks", () => {
  assert.equal(applyComposerPatch("export const composerAtom = true;"), "export const composerAtom = true;");
});

test("assistant render patch observes assistant text for automatic speech", () => {
  const patched = twice(applyAssistantRenderPatch, assistantRenderSource);
  assert.match(patched, /codexLinuxConversationAssistant\?\.\(n,p,o,m,typeof c!="undefined"\?c:null\)/);
  assert.match(patched, /\$\.Fragment/);
});

test("assistant render patch preserves the current JSX runtime alias", () => {
  const source =
    "return (0,Q.jsx)(Ov,{item:n,alwaysShowActions:M,assistantCopyText:p,turnId:m,after:g,conversationId:o,cwd:u,renderCodeBlocksAsWritingBlocks:V})";
  const patched = twice(applyAssistantRenderPatch, source);

  assert.match(patched, /codexLinuxConversationAssistant\?\.\(n,p,o,m,typeof c!="undefined"\?c:null\)/);
  assert.match(patched, /Q\.Fragment/);
});

test("assistant observer targets only the current primary thread bundle", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "assistant-observer");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("app-initial~app-main~onboarding-page-D4eTO0KG.js"), true);
  assert.equal(descriptor.pattern.test("local-conversation-turn-old.js"), false);
  assert.equal(descriptor.pattern.test("local-conversation-thread-old.js"), false);
  assert.equal(descriptor.pattern.test("index-old.js"), false);
});

test("current assistant observer drift is reported as skipped instead of already applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-mode-assistant-drift-"));
  try {
    const assetsDir = path.join(root, "webview", "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const assetPath = path.join(assetsDir, "app-initial~app-main~onboarding-page-current.js");
    const drifted = "console.log(`current assistant renderer drifted`);";
    fs.writeFileSync(assetPath, drifted);
    const descriptor = featurePatches.find((patch) => patch.id === "assistant-observer");
    const descriptors = normalizePatchDescriptors([
      { ...descriptor, featureId: "conversation-mode", sourceKind: "feature" },
    ]);
    const report = createPatchReport();

    applyWebviewAssetPatchDescriptors(root, descriptors, {}, report);

    assert.equal(fs.readFileSync(assetPath, "utf8"), drifted);
    assert.equal(report.patches.length, 1);
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.match(report.patches[0].reason, /Could not find assistant message render call/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conversation mode patches matching app assets and records report entries", () => {
  withTempFeatureConfig(["read-aloud", "conversation-mode"], (root) => {
    withLinuxFeatureRootEnv(root, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-mode-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), mainBundleSource);
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));
        fs.writeFileSync(
          path.join(assetsDir, currentDictationAsset),
          `${dictationSource};${assistantRenderSource}`,
        );
        fs.writeFileSync(path.join(assetsDir, currentComposerAsset), currentComposerControlSource);

        const report = createPatchReport();
        const { warnings } = captureWarns(() => patchExtractedApp(tempApp, { report }));
        assert.ok(
          warnings.every((warning) => !warning.includes("conversation mode")),
          warnings.join("\n"),
        );
        assert.match(
          fs.readFileSync(path.join(buildDir, "main.js"), "utf8"),
          /codexLinuxReadAloudSpeak\(e\.text,\{requireEnabled:!1\}\)/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, currentDictationAsset), "utf8"),
          /codexLinuxConversationEndpoint/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, currentComposerAsset), "utf8"),
          /codexLinuxConversationToggle/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, currentDictationAsset), "utf8"),
          /codexLinuxConversationAssistant/,
        );
        for (const name of [
          "feature:conversation-mode:read-aloud-conversation-source",
          "feature:conversation-mode:dictation-endpoint",
          "feature:conversation-mode:composer-control",
          "feature:conversation-mode:assistant-observer",
        ]) {
          assert.ok(
            report.patches.some((patch) => patch.name === name && patch.status === "applied"),
            name,
          );
        }
      } finally {
        fs.rmSync(tempApp, { recursive: true, force: true });
      }
    });
  });
});

test("feature patch list is intentionally small", () => {
  assert.deepEqual(
    featurePatches.map((patch) => [patch.id, patch.phase]),
    [
      ["read-aloud-conversation-source", "main-bundle"],
      ["dictation-endpoint", "webview-asset"],
      ["composer-control", "webview-asset"],
      ["assistant-observer", "webview-asset"],
    ],
  );
});
