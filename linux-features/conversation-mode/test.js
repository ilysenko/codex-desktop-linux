#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  enabledLinuxFeatureIds,
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const {
  createPatchReport,
} = require("../../scripts/lib/patch-report.js");
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

const dictationSource =
  "function Ht(){let {recordingDurationMs:T,waveformCanvasRef:E,startWaveformCapture:Wc,stopWaveformCapture:D,resetWaveformDisplay:k}=Ve(),m={current:null},_={current:null},g={current:[]},y={current:null},C={current:null};let j=async({action:e,handlers:n})=>{let i=`hello`;i.length>0&&(j.getInstance().dispatchMessage(`global-dictation-record-history-item`,{text:i}),e===`send`?n.onTranscriptSend(i):n.onTranscriptInsert(i))};let A=async()=>{let e=y.current??`insert`;y.current=null;let r=m.current,i=g.current;g.current=[],r&&(r.ondataavailable=null,r.onstop=null),m.current=null,D();};let a=z(e=>{y.current=e;let t=m.current;if(!t){A();return}if(t.state===`inactive`){A();return}t.stop()});return{startDictation:z(async()=>{let e=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1}});let t=new MediaRecorder(e);m.current=t,g.current=[],t.ondataavailable=e=>{e.data.size>0&&g.current.push(e.data)},t.onstop=()=>{A()},t.start(),l(!0)}),stopDictation:a}}function Kt(){let p={current:null};let x=e=>{!d||p.current!==e.sessionId||(p.current=null,o(`insert`))}}";

const composerControlSource =
  "function mz(e){let {voiceControls:z}=e;let Be=ze,Ve=F===`empty-message`&&!A&&(ue.isAvailable&&ue.phase!==`active`||J),He=si(fc,`composer.startVoiceMode`),Ue;Ue=()=>{if(ue.phase===`starting`||ue.phase===`active`){ue.stopRealtime();return}if(ue.isAvailable){ue.phase===`inactive`&&ue.startRealtime(`composer_button_existing_thread`);return}ce()};let e=G.formatMessage({id:`composer.realtime.start.aria`,defaultMessage:`Start realtime voice`,description:`Aria label for the button that starts realtime voice mode in the composer`});let n=G.formatMessage({id:`composer.realtime.start.tooltip`,defaultMessage:`Start realtime voice`,description:`Tooltip for the button that starts realtime voice mode in the composer`});}";

const currentComposerControlSource =
  "function hz(e){let{conversationId:v,isResponseInProgress:A,onStop:P,submitBlockReason:F,voiceControls:z}=e,I=h===void 0?!1:h,L=mu(),R=fu(L,tg),x=fu(L,eg),{enterBehavior:B}=Ul(),V=Wt(),{canRetryDictation:K,dictationShortcutLabel:q,isDictating:J,isDictationSupported:ee,isNewRealtimeConversationAvailable:te,isRealtimeSubmitStarting:ne,isTranscribing:re,startDictation:se,startNewRealtimeConversation:ce,stopDictation:le,threadRealtime:ue}=z;let Be=ze,Ve=F===`empty-message`&&!A&&(ue.isAvailable&&ue.phase!==`active`||te),He=oi(fc,`composer.startVoiceMode`),Ue;Ue=()=>{if(ue.phase===`starting`||ue.phase===`active`){ue.stopRealtime();return}if(ue.isAvailable){ue.phase===`inactive`&&ue.startRealtime(`composer_button_existing_thread`);return}ce()};}";

const currentComposerControlSourceWithDecoyProps =
  "function decoy(e){let{conversationId:badId,isResponseInProgress:badProgress,onStop:badStop,submitBlockReason:badReason,voiceControls:badVoiceControls}=e;return badId||badProgress||badStop||badReason||badVoiceControls}" +
  currentComposerControlSource;

const halfPatchedCurrentComposerControlSource =
  "function hz(e){let{conversationId:v,isResponseInProgress:A,onStop:P,submitBlockReason:F,voiceControls:z}=e,I=h===void 0?!1:h,L=mu(),R=fu(L,tg),x=fu(L,eg),{enterBehavior:B}=Ul(),V=Wt(),{canRetryDictation:K,dictationShortcutLabel:q,isDictating:J,isDictationSupported:ee,isNewRealtimeConversationAvailable:te,isRealtimeSubmitStarting:ne,isTranscribing:re,startDictation:se,startNewRealtimeConversation:ce,stopDictation:le,threadRealtime:ue}=z;let Be=ze,Ve=F===`empty-message`&&!A&&(ue.isAvailable&&ue.phase!==`active`||te),He=oi(fc,`composer.startVoiceMode`),Ue;Ue=()=>{if(globalThis.codexLinuxConversationToggle?.({conversationId:v,startDictation:se,stopDictation:le,onStop:P,isDictating:te,isTranscribing:re,isResponseInProgress:A,isDictationSupported:q}))return;if(ue.phase===`starting`||ue.phase===`active`){ue.stopRealtime();return}if(ue.isAvailable){ue.phase===`inactive`&&ue.startRealtime(`composer_button_existing_thread`);return}ce()};}";

const halfPatchedCurrentComposerControlSourceWithFallbackAliases =
  "function hz(e){let{conversationId:l,isResponseInProgress:T,onStop:k,submitBlockReason:A,voiceControls:F}=e,I=h===void 0?!1:h,L=mu(),R=fu(L,tg),z=fu(L,eg),{enterBehavior:B}=Ul(),V=Wt(),{canRetryDictation:ee,dictationShortcutLabel:te,isDictating:ne,isDictationSupported:re,isNewRealtimeConversationAvailable:ae,isRealtimeSubmitStarting:U,isTranscribing:W,startDictation:oe,startRealtimeConversation:se,stopDictation:ce,threadRealtime:J}=F;let Fe=Pe,Ie=A===`empty-message`&&!T&&(J.isAvailable&&J.phase!==`active`||ae),Le=a(Po,`composer.startVoiceMode`),Re;Re=()=>{if(globalThis.codexLinuxConversationToggle?.({conversationId:v,startDictation:oe,stopDictation:ce,onStop:P,isDictating:ne,isTranscribing:W,isResponseInProgress:A,isDictationSupported:re}))return;if(J.phase===`starting`||J.phase===`active`){J.stopRealtime();return}if(J.isAvailable){J.phase===`inactive`&&se();return}se()};}";

const driftedCurrentComposerControlSource =
  "function hz(e){let{conversationId:l,isResponseInProgress:T,onStop:k,submitBlockReason:A,voiceControls:F}=e,I=h===void 0?!1:h,L=mu(),R=fu(L,tg),z=fu(L,eg),{enterBehavior:B}=Ul(),V=Wt(),{canRetryDictation:ee,dictationShortcutLabel:te,isDictating:ne,isDictationSupported:re,isNewRealtimeConversationAvailable:ae,isRealtimeSubmitStarting:U,isTranscribing:W,startDictation:oe,startRealtimeConversation:se,stopDictation:ce,threadRealtime:J}=M;let Fe=Pe,Ie=A===`empty-message`&&!T&&(J.isAvailable&&J.phase!==`active`||ae),Le=a(Po,`composer.startVoiceMode`),Re;Re=()=>{if(J.phase===`starting`||J.phase===`active`){J.stopRealtime();return}if(J.isAvailable){J.phase===`inactive`&&se();return}se()};}";

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

test("dictation endpoint descriptor tracks moved upstream composer bundle", () => {
  const descriptor = featurePatches.find((patch) => patch.id === "dictation-endpoint");
  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("app-initial~app-main~onboarding-page-BUwCKIcU.js"), true);
  assert.equal(descriptor.pattern.test("use-dictation-BUwCKIcU.js"), true);
  assert.equal(descriptor.pattern.test("use-dictation-hotkey-BUwCKIcU.js"), false);
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

test("conversation mode exposes optional patch descriptors when enabled", () => {
  withTempFeatureConfig(["conversation-mode"], (root) => {
    assert.deepEqual(enabledLinuxFeatureIds({ featuresRoot: root }), ["conversation-mode"]);

    const patches = loadLinuxFeaturePatchDescriptors({ featuresRoot: root });
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

test("main bundle patch upgrades older conversation speech gates", () => {
  const alreadyAllowed =
    "function codexLinuxReadAloudHandle(e={}){return e.action===`config`?codexLinuxReadAloudConfig():e.action===`setup`?codexLinuxReadAloudSetup(e):e.action===`stop`?codexLinuxReadAloudStop():e.action===`speak`&&(e.source===`button`||e.source===`conversation`)?codexLinuxReadAloudSpeak(e.text):codexLinuxReadAloudReport({spoken:!1,reason:`not-explicit`})}var h={handlers:{\"linux-read-aloud\":async(e)=>codexLinuxReadAloudHandle(e),\"native-desktop-apps\":async()=>({apps:[]})}};";
  const patched = twice(applyReadAloudMainBundlePatch, alreadyAllowed);
  assert.match(patched, /codexLinuxReadAloudSpeak\(e\.text,\{requireEnabled:!1\}\)/);
});

test("composer runtime appends one browser-side conversation controller", () => {
  const patched = twice(applyComposerRuntimePatch, "console.log(`composer`);");
  assert.match(patched, /conversation-mode-v20/);
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
  assert.match(patched, /e!==`discard`/);
  assert.match(patched, /e===`send`\?n\.onTranscriptSend\(i\):n\.onTranscriptInsert\(i\)/);
  assert.match(patched, /stop:\(\)=>a\(`send`\)/);
  assert.match(patched, /o\(e\.action===`discard`\?`discard`:e\.action===`send`\?`send`:`insert`\)/);
});

test("composer control patch repurposes the voice button for conversation mode first", () => {
  const patched = twice(applyComposerControlPatch, composerControlSource);
  assert.match(patched, /codexLinuxConversationAvailable/);
  assert.match(patched, /codexLinuxConversationSync\?\.\(v,\{isResponseInProgress:A/);
  assert.match(patched, /isDictating:J/);
  assert.match(patched, /codexLinuxConversationActive=globalThis\.codexLinuxConversationIsActive/);
  assert.match(patched, /Ve=codexLinuxConversationActive\|\|F===`empty-message`/);
  assert.match(patched, /codexLinuxConversationToggle/);
  assert.match(patched, /\(v&&globalThis\.codexLinuxConversationAvailable\?\.\(\)\)/);
  assert.match(patched, /startDictation:se/);
  assert.match(patched, /stopDictation:le/);
  assert.match(patched, /onStop:P/);
  assert.equal(
    patched.match(/defaultMessage:codexLinuxConversationActive\?`Stop conversation mode`:`Start conversation mode`/g)?.length,
    2,
  );
  assert.doesNotMatch(patched, /defaultMessage:`Start conversation mode`/);
  assert.match(patched, /ue\.startRealtime/);
});

test("composer control patch repairs stale static conversation button hints", () => {
  const once = applyComposerControlPatch(composerControlSource);
  const stale = once.replace(
    /defaultMessage:codexLinuxConversationActive\?`Stop conversation mode`:`Start conversation mode`/g,
    "defaultMessage:`Start conversation mode`",
  );
  const patched = twice(applyComposerControlPatch, stale);
  assert.equal(
    patched.match(/defaultMessage:codexLinuxConversationActive\?`Stop conversation mode`:`Start conversation mode`/g)?.length,
    2,
  );
});

test("composer control patch follows the current composer voiceControls shape", () => {
  const patched = twice(applyComposerControlPatch, currentComposerControlSource);
  assert.match(
    patched,
    /codexLinuxConversationSync\?\.\(v,\{isResponseInProgress:A,isDictating:J,isTranscribing:re,startDictation:se,stopDictation:le,onStop:P\}\)/,
  );
  assert.match(
    patched,
    /codexLinuxConversationToggle\?\.\(\{conversationId:v,startDictation:se,stopDictation:le,onStop:P,isDictating:J,isTranscribing:re,isResponseInProgress:A,isDictationSupported:ee\}\)/,
  );
  assert.match(patched, /He=oi\(fc,`composer\.startVoiceMode`\)/);
  assert.match(patched, /\|\|ue\.isAvailable&&ue\.phase!==`active`\|\|te/);
  assert.doesNotMatch(patched, /isDictating:te/);
  assert.doesNotMatch(patched, /isDictationSupported:q/);
});

test("composer control patch scopes current composer props to the composer binding", () => {
  const patched = twice(applyComposerControlPatch, currentComposerControlSourceWithDecoyProps);
  assert.match(
    patched,
    /codexLinuxConversationSync\?\.\(v,\{isResponseInProgress:A,isDictating:J,isTranscribing:re,startDictation:se,stopDictation:le,onStop:P\}\)/,
  );
  assert.match(
    patched,
    /codexLinuxConversationToggle\?\.\(\{conversationId:v,startDictation:se,stopDictation:le,onStop:P,isDictating:J,isTranscribing:re,isResponseInProgress:A,isDictationSupported:ee\}\)/,
  );
  assert.doesNotMatch(patched, /codexLinuxConversationSync\?\.\(badId/);
  assert.doesNotMatch(patched, /codexLinuxConversationToggle\?\.\(\{conversationId:badId/);
  assert.doesNotMatch(patched, /codexLinuxConversationSync\?\.\([^)]*\{[^}]*isResponseInProgress:badProgress/);
  assert.doesNotMatch(patched, /codexLinuxConversationToggle\?\.\([^)]*onStop:badStop/);
});

test("composer control patch repairs bundles where only the click handler was patched", () => {
  const patched = twice(applyComposerControlPatch, halfPatchedCurrentComposerControlSource);
  assert.match(patched, /codexLinuxConversationSync\?\.\(v,\{isResponseInProgress:A,isDictating:J/);
  assert.match(patched, /isDictationSupported:ee/);
  assert.doesNotMatch(patched, /isDictating:te/);
  assert.doesNotMatch(patched, /isDictationSupported:q/);
});

test("composer control patch repairs stale fallback aliases in existing toggle payloads", () => {
  const patched = twice(applyComposerControlPatch, halfPatchedCurrentComposerControlSourceWithFallbackAliases);
  assert.match(
    patched,
    /codexLinuxConversationSync\?\.\(l,\{isResponseInProgress:T,isDictating:ne,isTranscribing:W,startDictation:oe,stopDictation:ce,onStop:k\}\)/,
  );
  assert.match(
    patched,
    /codexLinuxConversationToggle\?\.\(\{conversationId:l,startDictation:oe,stopDictation:ce,onStop:k,isDictating:ne,isTranscribing:W,isResponseInProgress:T,isDictationSupported:re\}\)/,
  );
  assert.match(patched, /codexLinuxConversationActive=globalThis\.codexLinuxConversationIsActive/);
  assert.doesNotMatch(patched, /conversationId:v,startDictation:oe/);
  assert.doesNotMatch(patched, /onStop:P/);
  assert.doesNotMatch(patched, /isResponseInProgress:A,isDictationSupported:re/);
});

test("composer control patch skips current payloads when scoped aliases drift", () => {
  const { value: patched, warnings } = captureWarns(() =>
    twice(applyComposerControlPatch, driftedCurrentComposerControlSource),
  );
  assert.equal(patched, driftedCurrentComposerControlSource);
  assert.match(warnings.join("\n"), /Could not resolve composer prop aliases/);
  assert.match(warnings.join("\n"), /Could not find composer voice button click handler/);
  assert.doesNotMatch(patched, /codexLinuxConversationSync/);
  assert.doesNotMatch(patched, /codexLinuxConversationToggle/);
  assert.doesNotMatch(patched, /conversationId:v/);
  assert.doesNotMatch(patched, /onStop:P/);
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

test("conversation mode patches matching app assets and records report entries", () => {
  withTempFeatureConfig(["conversation-mode"], (root) => {
    withLinuxFeatureRootEnv(root, () => {
      const tempApp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-conversation-mode-app-"));
      try {
        const buildDir = path.join(tempApp, ".vite", "build");
        const assetsDir = path.join(tempApp, "webview", "assets");
        fs.mkdirSync(buildDir, { recursive: true });
        fs.mkdirSync(assetsDir, { recursive: true });
        fs.writeFileSync(path.join(buildDir, "main.js"), mainBundleSource);
        fs.writeFileSync(path.join(tempApp, "package.json"), JSON.stringify({ name: "codex" }));
        fs.writeFileSync(path.join(assetsDir, "browser-sidebar-comment-light-dismiss-test.js"), dictationSource);
        fs.writeFileSync(path.join(assetsDir, "composer-test.js"), composerControlSource);
        fs.writeFileSync(path.join(assetsDir, "local-conversation-turn-test.js"), assistantRenderSource);

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
          fs.readFileSync(path.join(assetsDir, "browser-sidebar-comment-light-dismiss-test.js"), "utf8"),
          /codexLinuxConversationEndpoint/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, "composer-test.js"), "utf8"),
          /codexLinuxConversationToggle/,
        );
        assert.match(
          fs.readFileSync(path.join(assetsDir, "local-conversation-turn-test.js"), "utf8"),
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
