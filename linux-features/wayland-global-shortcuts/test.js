"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const vm = require("node:vm");
const fs = require("node:fs");
const { applyWaylandGlobalShortcutsPatch, descriptors } = require("./patch.js");
const { mainBundleFixture, applyFeatures } = require("../../scripts/patches/lib/global-shortcuts-portal.test-helpers.js");
const { loadEnabledLinuxFeatures } = require("../../scripts/lib/linux-features.js");
const { applyLinuxAppshotHotkeyPatch, descriptors: appshotsDescriptors } = require("../appshots/patch.js");
const { appshotHotkeyState, linuxAppshotWaylandHelperSource } = require("../../scripts/patches/lib/appshot-hotkey-contract.js");

function completeAppshotsFixture() {
  const native = [
    'function appshotBareAllowed(hotkey,platform=process.platform){return"darwin"===platform&&null!=appshotNormalize(hotkey)}',
    'const appshotNativeMonitor=function(hotkey,onPressed,trigger="press"){if("darwin"!==process.platform)return null;let normalized=appshotNormalize(hotkey)??appshotFallback(hotkey);return null};',
    'let nativeModifiers=new Set(["cmdorctrl","command","cmd","control","ctrl","alt","option","super"]),appshotModifiers=new Set([...nativeModifiers,"shift"]);',
    'function appshotValidate(e,t=process.platform,r){let n=e.split("+").map(e=>e.trim()).filter(e=>e.length>0);if(0===n.length)return"Shortcut cannot be empty.";let i=!1,s=null;for(let e of n){let t=e.toLowerCase();if(appshotModifiers.has(t)){nativeModifiers.has(t)&&(i=!0);continue}if(null!=s)return"Shortcut must include exactly one non-modifier key.";s=e}return null==s?"Shortcut must include a non-modifier key.":i||r?.allowUnmodified?null:"Shortcut must include Cmd/Ctrl or Alt."}',
    'class AppshotHotkeys{constructor(stored){void 0===stored?this.configuredHotkey="win32"===process.platform?"DoubleAlt":"DoubleCommand":this.configuredHotkey=stored}setHotkey(e){if(!this.getState().supported)return{success:!1,error:"Not supported.",state:this.getState()};if(null!=e){let t="win32"===process.platform&&windowsBare(e)?null:appshotValidate(e);if(null!=t)return{success:!1,error:t,state:this.getState()}}this.configuredHotkey=e;this.#setterProbe();return{success:!0,state:this.getState()}}#setterProbe(){}',
  ].join("");
  return mainBundleFixture().replace("class AppshotHotkeys{", native) +
    "\n//# sourceMappingURL=appshots-combination.js.map";
}

for (const dictation of [false, true]) {
  test(`AppShots complete contribution composes in both orders with Wayland and dictation=${dictation}`, () => {
    const source = completeAppshotsFixture();
    assert.equal(appshotHotkeyState(source).kind, "current");
    const appshots = applyLinuxAppshotHotkeyPatch(source);
    assert.notEqual(appshots, source);
    assert.equal(appshotHotkeyState(appshots).kind, "patched");
    const appshotsFirst = applyFeatures(appshots, { dictation, shortcuts: true });
    const waylandFirst = applyLinuxAppshotHotkeyPatch(applyFeatures(source, { dictation, shortcuts: true }));
    assert.notEqual(appshotsFirst, appshots);
    assert.equal(appshotsFirst, waylandFirst);
    assert.equal(appshotHotkeyState(appshotsFirst).kind, "patched");
    assert.deepEqual(quiet(() => applyWaylandGlobalShortcutsPatch(appshotsFirst)),
      { value: appshotsFirst, warnings: [] });
    assert.equal(applyLinuxAppshotHotkeyPatch(appshotsFirst), appshotsFirst);
    assert.deepEqual([...appshotsFirst.matchAll(/linuxCommandId:"([^"]+)"/gu)]
      .map(match => match[1]).filter(id => !id.startsWith("globalDictation")).sort(), ACTION_IDS);
    assert.doesNotThrow(() => new vm.Script(appshotsFirst));
  });
}

test("AppShots combined availability retains platform, enablement, callbacks and bare-modifier policy", () => {
  const source = applyWaylandGlobalShortcutsPatch(applyLinuxAppshotHotkeyPatch(completeAppshotsFixture()));
  const registrations = [], events = [];
  const context = {
    process: { platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } },
    normalizeHotkey() {}, appshotNormalize: () => "normalized",
    __appshotPressed: () => events.push("appshot"),
    eA(accelerator, callbacks, options) {
      const record = { accelerator, callbacks, options, unregistered: false };
      registrations.push(record);
      return { unregister() { record.unregistered = true; } };
    },
  };
  vm.runInNewContext(linuxAppshotWaylandHelperSource(), context);
  const Appshot = fixtureClass(source, "AppshotHotkeys", context);
  const appshot = new Appshot();
  appshot.enabled = true;
  assert.equal(appshot.configuredHotkey, null);
  assert.equal(appshot.getState().supported, true);
  assert.equal(appshot.getState().linuxWayland, true);
  appshot.reconcile();
  assert.equal(registrations.length, 0);
  appshot.configuredHotkey = "Ctrl+Alt+A";
  appshot.reconcile();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].callbacks.linuxCommandId, "appshots");
  assert.equal(registrations[0].options.bareModifierTrigger, "immediatePress");
  registrations[0].callbacks.onPressed();
  assert.deepEqual(events, ["appshot"]);
  appshot.enabled = false;
  assert.equal(appshot.getState().supported, false);
  appshot.reconcile();
  assert.equal(registrations[0].unregistered, true);
  appshot.enabled = true;
  context.process.platform = "win32";
  assert.equal(appshot.getState().supported, false);
  appshot.windowsCaptureNativeBridge = {};
  assert.equal(appshot.getState().supported, true);
  appshot.windowsCaptureNativeBridgeFailed = true;
  assert.equal(appshot.getState().supported, false);
  context.process.platform = "darwin";
  assert.equal(appshot.getState().supported, true);
  const start = source.indexOf("function appshotBareAllowed(");
  const open = source.indexOf("{", start), end = findMatchingBrace(source, open);
  const bareAllowed = vm.runInNewContext("(" + source.slice(start, end + 1) + ")", context);
  assert.equal(bareAllowed("Control"), true);
  context.process.platform = "linux";
  assert.equal(bareAllowed("Control"), false);
  context.process.env.XDG_SESSION_TYPE = "x11";
  assert.equal(bareAllowed("Control"), true);
});

test("Wayland refuses partial, opaque, shadowed and ghost AppShots contributions before tagging", () => {
  const native = completeAppshotsFixture();
  const source = applyLinuxAppshotHotkeyPatch(native);
  const helper = linuxAppshotWaylandHelperSource();
  const ghost = source.replace(/getState\(\)\{return(\{supported:[^{}]+\})\}/u,
    (_match, result) => `getState(){const ghost=()=>(${result});return{supported:false}}`);
  const cases = [
    native + "\n" + helper,
    source.replace(helper, ""),
    source.replace(helper, "/*" + helper + "*/"),
    source.replace(helper, "function unused(){" + helper + "}"),
    source.replace(helper, "const unreturnedHelper=" + helper + ";"),
    source.replace(helper, "async " + helper),
    source.replace(helper, "0," + helper + ";"),
    source.replace(helper, "if(false)" + helper),
    source.replace(helper, helper + helper),
    source.replace('"shift","meta","win"', '"shift"'),
    source.replace('new Set([...nativeModifiers,"shift","meta","win"])', "new Set([...nativeModifiers,'shift'])") +
      '\n/*new Set([...nativeModifiers,"shift","meta","win"])*/',
    source.replace('new Set([...nativeModifiers,"shift","meta","win"])', "new Set([...nativeModifiers,'shift'])") +
      '\n;void new Set([...nativeModifiers,"shift","meta","win"]);',
    source.replace('"linux"===process.platform?null:"DoubleCommand"', '"DoubleCommand"'),
    source.replace('!this.windowsCaptureNativeBridgeFailed', 'this.windowsCaptureNativeBridgeFailed'),
    source.replace('toLowerCase()===`wayland`', 'toLowerCase()===`x11`'),
    source + "\ncodexLinuxAppshotIsWaylan\\u0064=()=>true;",
    source.replace("class AppshotHotkeys{", "var codexLinuxAppshotIsWaylan\\u0064=()=>true;class AppshotHotkeys{"),
    ghost,
  ];
  for (const candidate of cases) {
    assert.notEqual(candidate, source);
    assert.doesNotThrow(() => new vm.Script(candidate));
    refused(candidate);
  }
});

for (const dictation of [false, true]) {
  for (const shortcuts of [false, true]) {
    test(`independent feature selection: dictation=${dictation}, shortcuts=${shortcuts}`, () => {
      const source = mainBundleFixture();
      const patched = applyFeatures(source, { dictation, shortcuts });
      assert.doesNotThrow(() => new vm.Script(patched));
      assert.equal(applyFeatures(patched, { dictation, shortcuts }), patched);
      const ids = Array.from(patched.matchAll(/linuxCommandId:"([^"]+)"/g), (m) => m[1]);
      assert.deepEqual(ids.filter((id) => id.startsWith("globalDictation")).sort(), dictation
        ? ["globalDictationHold", "globalDictationSingleTap"] : []);
      assert.deepEqual(ids.filter((id) => !id.startsWith("globalDictation")).sort(), shortcuts
        ? ["appshots", "hotkeyWindow", "meetings", "openAvatarOverlay", "realtimeVoice"] : []);
      assert.equal(patched.includes("codex-linux-global-dictation-v3"), dictation);
      assert.equal(patched.includes("codex-linux-wayland-global-shortcuts-v1"), shortcuts);
      assert.equal((patched.match(/codexLinuxGlobalShortcutsPortalQueue=Promise.resolve\(\)/g) ?? []).length, dictation || shortcuts ? 1 : 0);
      const enabled = loadEnabledLinuxFeatures({ featuresRoot: path.resolve(__dirname, ".."),
        enabledFeatureIds: [...(dictation ? ["global-dictation"] : []), ...(shortcuts ? ["wayland-global-shortcuts"] : [])] });
      assert.deepEqual(enabled.map(feature => feature.id).sort(),
        [...(dictation ? ["global-dictation"] : []), ...(shortcuts ? ["wayland-global-shortcuts"] : [])]);
    });
  }
}

test("app shortcut drift leaves its input unchanged", () => {
  const source = mainBundleFixture().replace("this.handleHotkeyWindowHotkeyPressed()", "this.unknownPopoutHandler()");
  assert.equal(applyFeatures(source, { dictation: false, shortcuts: true }), source);
});

const { installPortalBackend } = require("../../scripts/patches/lib/global-shortcuts-portal.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const { applyExtractedAppPatchDescriptors, normalizePatchDescriptors } = require("../../scripts/patches/engine.js");
const ACTION_IDS = ["appshots", "hotkeyWindow", "meetings", "openAvatarOverlay", "realtimeVoice"];
const MARKER = 'var codexLinuxWaylandGlobalShortcutsPatch="codex-linux-wayland-global-shortcuts-v1";';

function quiet(operation) {
  const original = console.warn, warnings = [];
  console.warn = warning => warnings.push(warning);
  try { return { value: operation(), warnings }; }
  finally { console.warn = original; }
}
function patched(source = mainBundleFixture()) {
  const result = quiet(() => applyWaylandGlobalShortcutsPatch(source));
  assert.notEqual(result.value, source);
  assert.deepEqual(result.warnings, []);
  return result.value;
}
function refused(source) {
  const result = quiet(() => applyWaylandGlobalShortcutsPatch(source));
  assert.equal(result.value, source);
  assert.equal(result.warnings.length, 1);
}
function stripOwn(source) {
  return source.replace(MARKER, "").replace(/linuxCommandId:"(?:appshots|hotkeyWindow|meetings|openAvatarOverlay|realtimeVoice)",/gu, "");
}

test("F1 complete five-action canonical state preserves the native source and shared-only input", () => {
  const source = mainBundleFixture(), result = patched(source), shared = installPortalBackend(source);
  assert.equal(stripOwn(result), shared);
  assert.equal(patched(shared), result);
  assert.deepEqual(quiet(() => applyWaylandGlobalShortcutsPatch(result)), { value: result, warnings: [] });
  assert.deepEqual([...result.matchAll(/linuxCommandId:"([^"]+)"/gu)].map(match => match[1]).sort(), ACTION_IDS);
  assert.doesNotThrow(() => new vm.Script(result));
  assert.equal(descriptors[0].id, "wayland-global-shortcuts-actions");
  assert.equal(descriptors[0].phase, "extracted-app:pre-webview");
  assert.equal(descriptors[0].order, 146);
});

test("F1 marker-only, partial, duplicate, escaped and foreign action claims refuse byte-for-byte", () => {
  const source = mainBundleFixture(), result = patched(source), shared = installPortalBackend(source);
  for (const candidate of [
    MARKER + source, MARKER + shared, result.replace('linuxCommandId:"appshots",', ""),
    result.replace('linuxCommandId:"appshots",', 'linuxCommandId:"hotkeyWindow",'),
    result.replace(MARKER, MARKER + MARKER),
    result.replace("codexLinuxWaylandGlobalShortcutsPatch", "codexLinuxWaylandGlobalShortcutsPatc\\u0068"),
    result.replace('linuxCommandId:"meetings"', 'linuxComm\\u0061ndId:"meetings"'),
    result + ';const foreign={linuxCommandId:"hotkeyWindow"};',
    result + ';const foreign={["linuxCommandId"]:"realtimeVoice"};',
    result + ';const foreign={linuxCommandId:"regionScreenshot"};',
    result + ';const foreign={linuxComm\\u0061ndId:"regionScreenshot"};',
    result + ';const foreign={linuxCommandId:"spotlight"};',
  ]) refused(candidate);
});

test("F1 Pet preferred keymap follows the live application and desktop-service chain", () => {
  const native = mainBundleFixture();
  const mutations = [
    ["keymapState:e,isMacOS", "keymapState:foreign,isMacOS"],
    ["e.syncAvatarOverlayHotkey(preferredPetKeymap(t))", "other.syncAvatarOverlayHotkey(preferredPetKeymap(t))"],
    ["this.dependencies=e,this.initialQuickChatKeybinding", "this.dependencies=foreign,this.initialQuickChatKeybinding"],
    ["{dependencies;initialQuickChatKeybinding;", "{get dependencies(){return foreign}set dependencies(value){}initialQuickChatKeybinding;"],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey})}}", "syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey});this.desktopServices=foreign}}"],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey})}}", 'syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey});this["desktopServices"]=foreign}}'],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey})}}", "syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey});delete this.desktopServices}}"],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey})}}", "syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey});({service:this.desktopServices}=foreign)}}"],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey})}}", "syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey});let alias=this;alias.desktopServices=foreign}}"],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey})}}", 'syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey});Object.defineProperty(this,"desktopServices",{value:foreign})}}'],
    ["class NativeApplication{desktopServices;", 'class NativeApplication{desktopServices;shadow=Object.defineProperty(this,"desktopServices",{get(){return foreign},set(value){}});'],
    ["class NativeApplication{desktopServices;", "class NativeApplication{get desktopServices(){return foreign}set desktopServices(value){}"],
    ["syncAvatarOverlayHotkey:options.syncAvatarOverlayHotkey", "syncAvatarOverlayHotkey:other.syncAvatarOverlayHotkey"],
    ["syncAvatarOverlayHotkey:sync}", "syncAvatarOverlayHotkey:foreign}"],
    ["syncAvatarOverlayHotkey:c.overlayHotkeyController.syncCommandKeybinding", "syncAvatarOverlayHotkey:c.realtimeVoiceHotkeyController.syncCommandKeybinding"],
    ["windowServices:windows});let nativeContext", "windowServices:other});let nativeContext"],
    ["application=new NativeApplication({syncAvatarOverlayHotkey:c.overlayHotkeyController.syncCommandKeybinding});", "false&&(application=new NativeApplication({syncAvatarOverlayHotkey:c.overlayHotkeyController.syncCommandKeybinding}));"],
    ["commandKeybindingsService:keymap", "commandKeybindingsService:foreign"],
    ["keymap=new NativeKeymap", "return;keymap=new NativeKeymap"],
    ["let r,d=!1,n=null", "let r=foreign,d=!1,n=null"],
    ["dispose:()=>{d=!0,l?.()", "dispose:()=>{d=!1,l?.()"],
    ["if(!d){void 0!==r", "if(d){void 0!==r"],
    ["void 0!==r&&null!=e", "null!=e"],
  ];
  for (const [from, to] of mutations) {
    for (const source of [native, patched(native)]) {
      const damaged = source.replace(from, to);
      assert.notEqual(damaged, source, from);
      assert.doesNotThrow(() => new vm.Script(damaged));
      refused(damaged);
    }
  }
});

test("F1 native action callback, ownership, availability, keymap and window gates refuse drift", () => {
  const source = mainBundleFixture(), result = patched(source);
  const mutations = [
    ["this.handleHotkeyWindowHotkeyPressed()", "this.otherHandler()"],
    ["{ownership:t});if(null==n)throw Error(\"Unable to register Popout\")", "{ownership:other});if(null==n)throw Error(\"Unable to register Popout\")"],
    ['bareModifierTrigger:"immediatePress"}),null==this.registration', 'bareModifierTrigger:"release"}),null==this.registration'],
    ['"locked"!==ea.powerMonitor.getSystemIdleState(1)&&e()', '"locked"===ea.powerMonitor.getSystemIdleState(1)&&e()'],
    ["r===i&&\"locked\"", "other===i&&\"locked\""],
    ["!this.isDisposed&&this.isHotkeyWindowGateEnabled", "!this.isDisposed&&true"],
    ["!this.getState().supported||null==this.configuredHotkey", "null==this.configuredHotkey"],
    ['commandId:"openAvatarOverlay"', 'commandId:"otherAction"'],
    ["n=null,i=null,q=null,s=", "n=null,i=null,q=foreign,s="],
    ["setQuickChatHandler:e=>{q=e}", "setQuickChatHandler:e=>{other=e}"],
    ["null==q||\"locked\"!==ea.powerMonitor.getSystemIdleState(1)", "null==other||\"locked\"!==ea.powerMonitor.getSystemIdleState(1)"],
    ["null==q||\"locked\"!==ea.powerMonitor.getSystemIdleState(1)", "null==q||\"locked\"===ea.powerMonitor.getSystemIdleState(1)"],
    ["(q??e)().catch", "(q??other)().catch"],
    ["(q??e)().catch", "(other??e)().catch"],
    ["!tt().realtimeVoice&&!s", "!s"],
    ["this.isAppQuitting||this.appShellShortcutStates", "false||this.appShellShortcutStates"],
    ['"meetings.takeNotes",this.appShellCommandKeymapState', '"meetings.other",this.appShellCommandKeymapState'],
    ["j=new HotkeyWindowController(D,G)", "j=new OtherController(D,G)"],
    ["A=new AppshotHotkeys()", "A=new OtherAppshot()"],
    ["j=new HotkeyWindowController(D,G)", "j=new HotkeyWindowController(D,G);j=foreign"],
    ["j=new HotkeyWindowController(D,G)", "HotkeyWindowController=Foreign;j=new HotkeyWindowController(D,G)"],
    ["j=new HotkeyWindowController(D,G)", "HotkeyWindowControll\\u0065r=Foreign;j=new HotkeyWindowController(D,G)"],
    ["registerHotkeyWindowHotkeyOrThrow(e,t){if", "registerHotkeyWindowHotkeyOrThrow(e,t){return;if"],
    ["reconcile(){if", "reconcile(){return;if"],
    ["Q=function({toggleAvatarOverlay:", "Q=(()=>function({toggleAvatarOverlay:"],
  ];
  for (const [from, to] of mutations) {
    for (const candidate of [source, result]) {
      const damaged = candidate.replace(from, to);
      assert.notEqual(damaged, candidate, from);
      refused(damaged);
    }
  }
  const criticalMembers = [
    ["HotkeyWindowController", "registerHotkeyWindowHotkeyOrThrow"],
    ["HotkeyWindowController", "isHotkeyWindowEffectivelyEnabled"],
    ["AppshotHotkeys", "getState"],
    ["MeetingWindows", "syncMeetingsHotkey"],
  ];
  for (const [controller, name] of criticalMembers) {
    const escapedName = name.slice(0, -1) + "\\u" + name.charCodeAt(name.length - 1).toString(16).padStart(4, "0");
    const overrides = [
      name + "=()=>null;", name + ";", '"' + name + '"=null;', '["' + name + '"]=null;',
      "get " + name + "(){return null}", "set " + name + "(value){}",
      "static " + name + "(){}", "async " + name + "(){}", "*" + name + "(){}",
      '"' + name + '"(){}', '["' + name + '"](){}', escapedName + "(){}",
      "static/*native-kind*/" + name + "(){}", "get/*native-kind*/" + name + "(){return null}",
      '[unknownMemberKey](){}', '[("' + name + '")](){}',
    ];
    for (const override of overrides) {
      for (const candidate of [source, result]) {
        const damaged = candidate.replace("class " + controller + "{", "class " + controller + "{" + override);
        assert.doesNotThrow(() => new vm.Script(damaged), override);
        refused(damaged);
      }
    }
  }
  for (const kind of ["#", "get ", "static ", "async ", "*"]) {
    for (const candidate of [source, result]) {
      const damaged = candidate.replace("class AppshotHotkeys{getState(){", "class AppshotHotkeys{" + kind + "getState(){");
      assert.doesNotThrow(() => new vm.Script(damaged), kind);
      refused(damaged);
    }
  }
  const fieldSeparators = [
    "\n", "\r", "\r\n", "\u2028", "\u2029",
    "/*\n*/", "/*\r*/", "/*\r\n*/", "/*\u2028*/", "/*\u2029*/",
    "//field boundary\n", "//field boundary\r", "//field boundary\u2028", "//field boundary\u2029",
  ];
  for (const [controller, name] of criticalMembers) {
    for (const separator of [";", ...fieldSeparators]) {
      for (const candidate of [source, result]) {
        const declaration = "unrelated=0" + separator + name + "=()=>({supported:true});";
        const damaged = candidate.replace("class " + controller + "{", "class " + controller + "{" + declaration);
        assert.doesNotThrow(() => new vm.Script(damaged), declaration);
        refused(damaged);
      }
    }
  }
  const backtick = String.fromCharCode(96);
  for (const unrelated of [
    'unrelated="; getState(){ fake }";', "#unrelated=1;", "unrelated(){}", "get unrelated(){return null}",
    "set unrelated(value){}", "static unrelated(){}", "async unrelated(){}", "*unrelated(){}",
    '"unrelated"=1;', '["unrelated"](){}', "'unrelated'(){}",
    'unrelated=0/*\ngetState=()=>({supported:true});\n*/;',
    'unrelated="opaque\\\ngetState fake";',
    "unrelated=" + backtick + "opaque\ngetState fake" + backtick + ";",
    'unrelated=(\n0\n);', 'unrelated=(()=>{\nreturn "getState";\n})();',
  ]) {
    const current = source.replace("class AppshotHotkeys{", "class AppshotHotkeys{" + unrelated);
    const applied = patched(current);
    assert.deepEqual(quiet(() => applyWaylandGlobalShortcutsPatch(applied)), { value: applied, warnings: [] });
  }
  for (const key of ['"getState"', "'getState'", '["getState"]', "getStat\\u0065"]) {
    const current = source.replace("class AppshotHotkeys{getState(){", "class AppshotHotkeys{" + key + "(){");
    const applied = patched(current);
    assert.deepEqual(quiet(() => applyWaylandGlobalShortcutsPatch(applied)), { value: applied, warnings: [] });
  }
});

test("F1 string and comment decoys cannot supply missing native registration owners", () => {
  const source = mainBundleFixture();
  const call = 'eA(e,{onPressed:()=>{this.handleHotkeyWindowHotkeyPressed()}},{ownership:t})';
  const missing = source.replace(call, "null");
  for (const decoy of [JSON.stringify(call), "/*" + call + "*/", "function unused(){" + call + "}"]) {
    refused(missing.replace("class HotkeyWindowController{", "const decoy=" + (decoy.startsWith("/*") ? "null;" + decoy : decoy + ";") + "class HotkeyWindowController{"));
  }
});

function fixtureClass(source, name, context) {
  const start = source.indexOf("class " + name);
  const open = source.indexOf("{", start), close = findMatchingBrace(source, open);
  return vm.runInNewContext("(" + source.slice(start, close + 1) + ")", context);
}
function fixtureClosure(source, binding, context) {
  const start = source.indexOf(binding + "=function(") + binding.length + 1;
  const open = source.indexOf("){", start) + 1, close = findMatchingBrace(source, open);
  return vm.runInNewContext("(" + source.slice(start, close + 1) + ")", context);
}

test("F1 inert bound Popout, Appshot and Meetings retain native callbacks and gating", () => {
  const source = patched(), registrations = [], events = [];
  let locked = false, valid = true, hasWindow = true;
  const context = {
    process: { platform: "darwin" },
    eA(accelerator, callbacks, options) {
      const record = { accelerator, callbacks, options, unregistered: false };
      registrations.push(record);
      return { unregister() { record.unregistered = true; } };
    },
    commandKeymap: () => ({ hotkey: "Ctrl+Alt+M" }), resolveKeymap: () => "Ctrl+Alt+P",
    fA: () => valid ? null : "invalid", normalizeHotkey() {},
    ea: { powerMonitor: { getSystemIdleState: () => locked ? "locked" : "active" } },
    logModule: { r: () => ({ warning() {} }) },
    __popoutPressed: () => events.push("popout"), __appshotPressed: () => events.push("appshot"),
  };
  const Popout = fixtureClass(source, "HotkeyWindowController", context);
  const popout = new Popout({}, { get() {} }), ownership = {};
  popout.registerHotkeyWindowHotkeyOrThrow("Ctrl+Alt+P", ownership);
  assert.equal(registrations.at(-1).options.ownership, ownership);
  assert.equal(registrations.at(-1).callbacks.linuxCommandId, "hotkeyWindow");
  registrations.at(-1).callbacks.onPressed();
  const Appshot = fixtureClass(source, "AppshotHotkeys", context), appshot = new Appshot();
  appshot.enabled = true; appshot.configuredHotkey = "Ctrl+Alt+A"; appshot.reconcile();
  assert.equal(registrations.at(-1).options.bareModifierTrigger, "immediatePress");
  assert.equal(registrations.at(-1).callbacks.linuxCommandId, "appshots");
  registrations.at(-1).callbacks.onPressed();
  const Windows = fixtureClass(source, "MeetingWindows", context), windows = new Windows();
  windows.getPrimaryWindow = () => hasWindow ? {} : null;
  windows.getActiveWebContents = () => ({ id: 1 });
  windows.sendMessageToWindow = (_window, command) => events.push(command.id);
  windows.appShellShortcutStates.set(1, { canTakeMeetingNotes: true });
  windows.syncMeetingsHotkey();
  const meeting = registrations.at(-1);
  assert.equal(meeting.callbacks.linuxCommandId, "meetings");
  meeting.callbacks.onPressed();
  locked = true; meeting.callbacks.onPressed(); locked = false;
  windows.isAppQuitting = true; meeting.callbacks.onPressed(); windows.isAppQuitting = false;
  hasWindow = false; meeting.callbacks.onPressed(); hasWindow = true;
  windows.appShellShortcutStates.set(1, { canTakeMeetingNotes: false }); meeting.callbacks.onPressed();
  windows.appShellShortcutStates.set(1, { canTakeMeetingNotes: true });
  valid = false; windows.meetingsHotkeyController.sync("Ctrl+Alt+N"); meeting.callbacks.onPressed();
  assert.equal(meeting.unregistered, true);
  assert.deepEqual(events, ["popout", "appshot", "meetings.takeNotes"]);
});

test("F1 inert Pet and voice retain availability, sync, locked-screen and native fallback", async () => {
  const source = patched(), registrations = [], events = [], subscriptions = [];
  let available = true, voiceAvailable = false, locked = false, reserved;
  const context = {
    process: { platform: "linux" },
    eA(accelerator, callbacks) {
      const record = { accelerator, callbacks, unregistered: false }; registrations.push(record);
      return { unregister() { record.unregistered = true; } };
    },
    ed: { opO: () => "Ctrl+Alt+P", tZQ: () => ({ warning: () => events.push("warning") }) },
    eCT: () => available, ti: callback => { subscriptions.push(callback); return () => {}; },
    tn: callback => { subscriptions.push(callback); return () => {}; },
    NC: () => ({ hotkey: "Ctrl+Alt+V" }), tt: () => ({ realtimeVoice: voiceAvailable }), No() {},
    ea: { powerMonitor: { getSystemIdleState: () => locked ? "locked" : "active" } },
    setInterval: () => ({ unref() {} }), clearInterval() {},
  };
  const makePet = fixtureClosure(source, "Q", context);
  const pet = makePet({ toggleAvatarOverlay: async () => { events.push("pet"); }, notch: null });
  assert.equal(registrations.length, 0);
  pet.syncCommandKeybinding("Ctrl+Alt+P");
  const firstPet = registrations.at(-1);
  assert.equal(firstPet.callbacks.linuxCommandId, "openAvatarOverlay");
  firstPet.callbacks.onPressed();
  pet.setQuickChatHandler(async () => { events.push("quick-chat"); });
  locked = true; firstPet.callbacks.onPressed();
  locked = false; firstPet.callbacks.onPressed();
  pet.setQuickChatHandler(null);
  locked = true; firstPet.callbacks.onPressed(); locked = false;
  pet.setQuickChatHandler(async () => { throw new Error("native handler failure"); });
  firstPet.callbacks.onPressed();
  await Promise.resolve();
  available = false; firstPet.callbacks.onPressed(); assert.equal(firstPet.unregistered, true);
  available = true; pet.syncCommandKeybinding("Ctrl+Alt+N");
  assert.equal(registrations.at(-1).accelerator, "Ctrl+Alt+N");
  const makeVoice = fixtureClosure(source, "V", context), beforeVoice = registrations.length;
  const voice = makeVoice({ requestRealtimeToggle: async () => events.push("voice"),
    subscribeRealtimeVoiceSessionReservation(callback) { reserved = callback; return () => {}; } });
  assert.equal(registrations.length, beforeVoice);
  reserved(true);
  const activeVoice = registrations.at(-1);
  assert.equal(activeVoice.callbacks.linuxCommandId, "realtimeVoice");
  locked = true; activeVoice.callbacks.onPressed(); locked = false; activeVoice.callbacks.onPressed();
  voice.syncCommandKeybinding("Ctrl+Alt+R"); assert.equal(activeVoice.unregistered, true);
  voice.dispose(); pet.dispose();
  const afterDispose = registrations.length;
  pet.syncCommandKeybinding("Ctrl+Alt+Z");
  assert.equal(registrations.length, afterDispose);
  await Promise.resolve();
  assert.deepEqual(events, ["pet", "quick-chat", "pet", "warning", "voice"]);
});

function inventory(t, source = mainBundleFixture()) {
  const cache = process.env.TMPDIR || path.join(require("node:os").homedir(), ".cache/codex-desktop-dev/tmp");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "wayland-shortcuts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, ".vite/build"); fs.mkdirSync(build, { recursive: true });
  fs.writeFileSync(path.join(build, "early-bootstrap.js"), 'const entry="ordinary runtime";');
  for (let id = 1; id <= 19; id++) fs.writeFileSync(path.join(build, "early-bootstrap-" + id + "-abc.js"), "exports.ids=[" + id + "],exports.modules={" + id + "(){return false}};");
  const owner = path.join(build, "early-bootstrap-45-abc.js"); fs.writeFileSync(owner, source);
  return { root, build, owner };
}
function snapshot(build) {
  return Object.fromEntries(fs.readdirSync(build).map(name => [name, fs.readFileSync(path.join(build, name), "utf8")]));
}
function registered(root) {
  const report = createPatchReport();
  const selected = normalizePatchDescriptors(descriptors.map(descriptor => ({ ...descriptor,
    id: "feature:wayland-global-shortcuts:" + descriptor.id, sourceKind: "feature", featureId: "wayland-global-shortcuts" })));
  quiet(() => applyExtractedAppPatchDescriptors(root, selected, {}, report, "extracted-app:pre-webview"));
  return report.patches[0];
}

test("F1 registered twenty-one-file inventory applies once and revalidates the complete cohort", t => {
  const data = inventory(t), original = snapshot(data.build);
  assert.equal(Object.keys(original).length, 21);
  assert.equal(registered(data.root).status, "applied");
  const applied = snapshot(data.build);
  assert.deepEqual(Object.keys(applied).filter(name => applied[name] !== original[name]), [path.basename(data.owner)]);
  assert.equal(registered(data.root).status, "already-applied");
  const sibling = path.join(data.build, "early-bootstrap-1-abc.js");
  fs.writeFileSync(sibling, 'exports.ids=[1],exports.modules={0x14384(){return false}};');
  const damaged = snapshot(data.build);
  assert.equal(registered(data.root).status, "skipped-optional");
  assert.deepEqual(snapshot(data.build), damaged);
});

test("F1 registered same-ID, partial-marker and malformed siblings refuse before any write", t => {
  const data = inventory(t), sibling = path.join(data.build, "early-bootstrap-1-abc.js");
  for (const source of [
    'exports.ids=[1],exports.modules={"82820"(){return false}};',
    'exports.ids=[1],exports.modules={8.282e4(){return false}};',
    'exports.ids=[1],exports.modules={82820(){return false}};',
    MARKER + 'exports.ids=[1],exports.modules={1(){return false}};',
    'exports.ids=[1],exports.modules={82820(){',
  ]) {
    fs.writeFileSync(sibling, source); const before = snapshot(data.build);
    assert.equal(registered(data.root).status, "skipped-optional");
    assert.deepEqual(snapshot(data.build), before);
  }
});

test("F1 registered partial writes roll back and normal retry succeeds", t => {
  const data = inventory(t), before = snapshot(data.build), original = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = (file, bytes, ...args) => {
    if (file === data.owner && !injected) {
      injected = true; original(file, bytes.subarray(0, Math.floor(bytes.length / 2))); throw Error("inert partial write");
    }
    return original(file, bytes, ...args);
  };
  try { assert.throws(() => descriptors[0].apply(data.root), /inert partial write/u); }
  finally { fs.writeFileSync = original; }
  assert.equal(injected, true); assert.deepEqual(snapshot(data.build), before);
  assert.equal(registered(data.root).status, "applied");
});

test("F1 registered preimage rechecks include every unchanged inventory member", t => {
  const data = inventory(t), before = snapshot(data.build), sibling = path.join(data.build, "early-bootstrap-1-abc.js");
  const original = fs.readFileSync; let reads = 0;
  fs.readFileSync = (file, ...args) => {
    if (file === sibling && ++reads === 2) fs.writeFileSync(file, before[path.basename(sibling)] + "/*external change*/");
    return original(file, ...args);
  };
  try { assert.throws(() => descriptors[0].apply(data.root), /changed before patch commit/u); }
  finally { fs.readFileSync = original; }
  assert.equal(fs.readFileSync(data.owner, "utf8"), before[path.basename(data.owner)]);
});

for (const variable of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  const signedApp = process.env[variable];
  test("signed twenty-one-file app-shortcut preservation and canonical registration " + variable, { skip: !signedApp }, t => {
    const directory = path.join(signedApp, ".vite/build"), data = inventory(t);
    for (const name of fs.readdirSync(data.build)) fs.unlinkSync(path.join(data.build, name));
    const names = fs.readdirSync(directory).filter(name => /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/u.test(name));
    assert.equal(names.length, 21);
    for (const name of names) fs.copyFileSync(path.join(directory, name), path.join(data.build, name));
    const originals = snapshot(data.build);
    assert.equal(registered(data.root).status, "applied");
    const applied = snapshot(data.build), changed = names.filter(name => originals[name] !== applied[name]);
    assert.equal(changed.length, 1);
    const name = changed[0];
    assert.deepEqual([...applied[name].matchAll(/linuxCommandId:"([^"]+)"/gu)].map(match => match[1]).sort(), ACTION_IDS);
    assert.equal(stripOwn(applied[name]), installPortalBackend(originals[name]));
    assert.equal(registered(data.root).status, "already-applied");
    for (const name of names) assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), originals[name]);
  });
}

for (const variable of ["CODEX_SIGNED_EXTRACTED_APP", "CODEX_SIGNED_ARM64_EXTRACTED_APP"]) {
  const signedApp = process.env[variable];
  test("signed complete AppShots and Wayland cohorts preserve both orders and replay " + variable,
    { skip: !signedApp }, t => {
      const directory = path.join(signedApp, ".vite/build"), data = inventory(t);
      for (const name of fs.readdirSync(data.build)) fs.unlinkSync(path.join(data.build, name));
      const names = fs.readdirSync(directory).filter(name => /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/u.test(name));
      assert.equal(names.length, 21);
      for (const name of names) fs.copyFileSync(path.join(directory, name), path.join(data.build, name));
      const original = snapshot(data.build);
      const applyAppshots = expectedChanges => {
        for (const descriptor of appshotsDescriptors.filter(item => item.phase === "extracted-app:pre-webview")) {
          const result = descriptor.apply(data.root);
          assert.equal(result.changed, expectedChanges, descriptor.id);
        }
      };
      applyAppshots(1);
      const appshots = snapshot(data.build);
      assert.equal(registered(data.root).status, "applied");
      const combined = snapshot(data.build);
      const changed = names.filter(name => combined[name] !== appshots[name]);
      assert.equal(changed.length, 1);
      const owner = changed[0];
      assert.equal(stripOwn(combined[owner]), installPortalBackend(appshots[owner]));
      assert.equal(appshotHotkeyState(combined[owner]).kind, "patched");
      applyAppshots(0);
      assert.equal(registered(data.root).status, "already-applied");
      assert.deepEqual(snapshot(data.build), combined);
      for (const name of names) fs.writeFileSync(path.join(data.build, name), original[name]);
      assert.equal(registered(data.root).status, "applied");
      applyAppshots(1);
      assert.deepEqual(snapshot(data.build), combined);
      assert.equal(registered(data.root).status, "already-applied");
      applyAppshots(0);
      assert.deepEqual(snapshot(data.build), combined);
      for (const name of names) assert.equal(fs.readFileSync(path.join(directory, name), "utf8"), original[name]);
    });
}
