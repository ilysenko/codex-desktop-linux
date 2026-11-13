"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { Script } = require("node:vm");
const { findMatchingBrace } = require("./minified-js.js");
const { installPortalBackend, PATCH_MARKER, registrationContract } = require("./global-shortcuts-portal.js");
const { mainBundleFixture, mainBundleFixtureBody, applyFeatures } = require("./global-shortcuts-portal.test-helpers.js");

function assertRefused(source, name) {
  assert.doesNotThrow(() => new Script(source), `${name} is valid JavaScript`);
  assert.throws(() => installPortalBackend(source), undefined, name);
}

for (const key of ["82820", '"82820"', "8.282e4", "0x14384"]) {
  test(`Portal owns current CommonJS factory key ${key}`, () => {
    const source = mainBundleFixture({ key }), patched = installPortalBackend(source);
    assert.notEqual(patched, source); assert.doesNotThrow(() => new Script(patched));
    assert.equal(installPortalBackend(patched), patched);
    const mapped = source + "\n//# sourceMappingURL=fixture.js.map";
    const mappedPatch = installPortalBackend(mapped);
    assert.notEqual(mappedPatch, mapped); assert.equal(installPortalBackend(mappedPatch), mappedPatch);
  });
}

test("Portal preserves current privacy and review-confirmation policy and refuses dead startup", () => {
  const source = mainBundleFixture(), patched = installPortalBackend(source);
  assert.notEqual(patched, source); assert.equal(installPortalBackend(patched), patched);
  assertRefused(source.replace("function runMainAppStartup(input){", "function runMainAppStartup(input){return;"), "dead startup");
  assertRefused(source.replace('ea.app.on("before-quit",i=>{', 'ea.app.on("before-quit",i=>{return;'), "dead native accepted quit");
  assertRefused(source.replace('i=>{if(function({addon:', 'i=>{if(!function({addon:'), "changed privacy veto polarity");
  assertRefused(source.replace('return void i.preventDefault();', 'return void 0;'), "missing native privacy veto");
});

test("Portal refuses changes to the native pending-review confirmation policy", () => {
  const native = mainBundleFixture();
  for (const [name, from, to] of [
    ["pending checker alias", "&&q()){let accepted", "&&other()){let accepted"],
    ["prompt approval guard", "!v&&!r.canQuitWithoutPrompt()", "!v&&r.canQuitWithoutPrompt()"],
    ["packaged policy", 'ea.app.isPackaged||"1"!==', 'ea.app.isPackaged&&"1"!=='],
    ["development override", '"1"!==process.env.CODEX_ELECTRON_DISABLE_QUIT_CONFIRMATION', '"1"===process.env.CODEX_ELECTRON_DISABLE_QUIT_CONFIRMATION'],
    ["safe initial decision", "let accepted=!1;try", "let accepted=!0;try"],
    ["dialog affirmative response", "accepted=1===ea.dialog", "accepted=0===ea.dialog"],
    ["dialog default", "defaultId:0,cancelId:0", "defaultId:1,cancelId:0"],
    ["dialog cancellation", "defaultId:0,cancelId:0", "defaultId:0,cancelId:1"],
    ["cancellation veto", "if(!accepted)return void i.preventDefault();", "if(!accepted)return;"],
    ["approval persistence", "r.markQuitApproved()", "r.otherApproval()"],
    ["pending context disconnected", "()=>nativeContext.hasPendingLocalGitReviewComments()", "()=>foreign.hasPendingLocalGitReviewComments()"],
    ["context drain member rewritten", "let nativeContext=app.getWindowContext();", "let nativeContext=app.getWindowContext();app.flushAndDisposeContext=foreign;"],
    ["context getter member rewritten", "let nativeContext=app.getWindowContext();", "app.getWindowContext=()=>foreign;let nativeContext=app.getWindowContext();"],
    ["aliased context drain rewritten", "let nativeContext=app.getWindowContext();", "let nativeContext=app.getWindowContext();const servicesAlias=app;servicesAlias.flushAndDisposeContext=foreign;"],
    ["context services not called", "}({windowServices:windows});let nativeContext", "};let nativeContext"],
    ["context services foreign windows", "}({windowServices:windows});let nativeContext", "}({windowServices:foreign});let nativeContext"],
    ["context services rewritten", "let nativeContext=app.getWindowContext();", "let nativeContext=app.getWindowContext();app=foreign;"],
    ["pending context rewritten", "let nativeContext=app.getWindowContext();", "let nativeContext=app.getWindowContext();nativeContext=foreign;"],
    ["context drain disconnected", "flushAndDisposeContext:app.flushAndDisposeContext", "flushAndDisposeContext:foreign.flushAndDisposeContext"],
    ["pending callback argument", "hasPendingLocalGitReviewComments:()=>nativeContext.hasPendingLocalGitReviewComments(),", ""],
  ]) {
    for (const source of [native, installPortalBackend(native)]) {
      const damaged = source.replace(from, to);
      assert.notEqual(damaged, source, name);
      assertRefused(damaged, name);
    }
  }
});

test("Portal requires complete pending commit order and native Windows guard", () => {
  const source = mainBundleFixture();
  for (const [name, damaged] of [
    ["pending-prefix missing", source.replace("let e=pendingState();null!=e&&commitPending(e),", "")],
    ["pending different capture", source.replace("null!=e&&commitPending(e),D.markAppQuitting()", "null!=e&&commitPending(other),D.markAppQuitting()")],
    ["pending commit after mark", source.replace("null!=e&&commitPending(e),D.markAppQuitting()", "D.markAppQuitting(),null!=e&&commitPending(e)")],
    ["producer shadows pending reader", source.replace("{let O;D=new MeetingWindows", "{function pendingState(){}let O;D=new MeetingWindows")],
    ["startup shadows pending commit", source.replace("function runMainAppStartup(input){", "function runMainAppStartup(input){function commitPending(){}")],
    ["Windows delay changed", source.replace(".armTerminateCurrentProcess(1e4)", ".armTerminateCurrentProcess(9e3)")],
    ["Windows package guard disconnected", source.replace("e&&ea.app.isPackaged&&function", "ea.app.isPackaged&&function")],
    ["quitting flags disconnected", source.replace("if(v=!0,y)return;", "if(other=!0,y)return;")],
  ]) { assert.notEqual(damaged, source, name); assertRefused(damaged, name); }
});

test("Portal refuses duplicate, fake and disconnected factory owners", () => {
  const source = mainBundleFixture(), body = mainBundleFixtureBody();
  const start = body.indexOf("var accessState="), end = body.indexOf("function flushWithTimeout(");
  const withoutAccess = body.slice(0, start) + body.slice(end), access = body.slice(start, end);
  for (const [first, second] of [["11", "22"], ['"11"', '"22"'], ["1.1e1", "2.2e1"], ["0xb", "0x16"]]) {
    assertRefused(`exports.ids=[45],exports.modules={${first}(e,t,r){${withoutAccess}},${second}(e,t,r){${access}}};`, first);
  }
  assertRefused(mainBundleFixture({ extra: ',8.282e4(e,t,r){}' }), "normalized duplicate key");
  assertRefused(`function unused(){${source}}`, "unused carrier");
  assertRefused(source + "\nexports.modules={};", "overwritten carrier");
  assertRefused(source + '\nexports["modules"]={};', "computed carrier overwrite");
  const declaration = registrationContract(source);
  const replaced = source.slice(0, declaration.start) + `function unused(){${declaration.body}}` + source.slice(declaration.end);
  assertRefused(replaced, "unused registration declaration");
});

test("Portal requires the published startup and actual direct quit call wiring", () => {
  const source = mainBundleFixture(), start = source.indexOf("function({isWindows:"), open = source.indexOf("){", start) + 1;
  const end = findMatchingBrace(source, open) + 1, installer = source.slice(start, end);
  const detached = source.slice(0, start) + "function(){}" + source.slice(end);
  const variants = {
    unexported: source.replace("runMainAppStartup:()=>runMainAppStartup", "unrelated:()=>runMainAppStartup"),
    unusedQuit: detached.replace("r.d(t,", `const unusedQuit=${installer};r.d(t,`),
    skippedQuit: source.replace("0,function({isWindows:", "false&&function({isWindows:"),
    disconnectedWindows: source.replace("windows:windows,applicationMenuManager:", "windows:foreignWindows,applicationMenuManager:"),
    disconnectedDictation: source.replace("globalDictationLifecycleManager:windows.globalDictationLifecycleManager", "globalDictationLifecycleManager:windows.hotkeyWindowLifecycleManager"),
    windowMarkOnlyInUnusedObject: source.replace("markAppQuitting:()=>{let e=pendingState();null!=e&&commitPending(e),D.markAppQuitting(),M.markAppQuitting(),O?.markAppQuitting(),U.dispose()}", "markAppQuitting:()=>{}")
      .replace("r.d(t,", "const unusedWindows={markAppQuitting:()=>{D.markAppQuitting(),M.markAppQuitting(),O?.markAppQuitting(),U.dispose()}};r.d(t,"),
    duplicateMark: source.replace("U.dispose()}}}(", "U.dispose()},markAppQuitting:()=>{}}}("),
    computedMark: source.replace("U.dispose()}}}(", 'U.dispose()},["markAppQuitting"]:()=>{}}}('),
    overwrittenWindowRole: source.replace("U.dispose()}}}(", "U.dispose()},windowManager:null}}("),
    missingDrain: source.replace("l.flush(),c.flush(),u(),h()", "l.flush(),u(),h()"),
    missingCancel: source.replace("return void i.preventDefault();", "return void 0;"),
  };
  for (const [name, variant] of Object.entries(variants)) assertRefused(variant, name);
});

test("Portal refuses every overriding critical member form at object seams", () => {
  const source = mainBundleFixture();
  for (const member of [
    '"hotkeyWindowLifecycleManager":L', '["hotkeyWindowLifecycleManager"]:L',
    'get ["hotkeyWindowLifecycleManager"](){return L}', 'get hotkeyWindowLifecycleManager(){return L}',
    'hotkeyWindowLifecycleManager(){return L}', '"markAppQuitting":()=>{}',
    '["markAppQuitting"]:()=>{}', 'get markAppQuitting(){return ()=>{}}', 'markAppQuitting(){}',
    String.raw`hotkeyWindowLifecycleManag\u0065r:L`,
  ]) assertRefused(source.replace("U.dispose()}}}(", `U.dispose()},${member}}}(`), member);
  const declaredShorthand = source.replace(";return{windowManager:D", ";const markAppQuitting=()=>{},hotkeyWindowLifecycleManager=L;return{windowManager:D");
  assert.notEqual(declaredShorthand, source, "Shorthand controls are declared in the current window producer");
  for (const member of ["markAppQuitting", "hotkeyWindowLifecycleManager", "...{}&&{hotkeyWindowLifecycleManager:L}"]) {
    const variant = declaredShorthand.replace("U.dispose()}}}(", `U.dispose()},${member}}}(`);
    assert.notEqual(variant, declaredShorthand, `The returned object contains ${member}`);
    assertRefused(variant, member);
  }
  for (const member of ['"windows":windows.windowManager', 'get windows(){return windows.windowManager}', '["windows"]:windows.windowManager', 'windows(){return windows.windowManager}']) {
    const variant = source.replace("canAttributeAppReactivation:input.canAttributeAppReactivation}", `canAttributeAppReactivation:input.canAttributeAppReactivation,${member}}`);
    assertRefused(variant, `quit argument ${member}`);
  }
});

test("Portal uses parsed member keys across separator whitespace", () => {
  const source = mainBundleFixture();
  for (const separator of [", ", ",\t", ",\n"]) {
    const formatted = source.replace("windowManager:D,avatarOverlayManager:M", `windowManager:D${separator}avatarOverlayManager:M`);
    const patched = installPortalBackend(formatted);
    assert.notEqual(patched, formatted); assert.equal(installPortalBackend(patched), patched);
    for (const member of ["hotkeyWindowLifecycleManager:L", "markAppQuitting:()=>{}"]) {
      assertRefused(source.replace("U.dispose()}}}(", `U.dispose()}${separator}${member}}}(`), member);
    }
    assertRefused(source.replace("canAttributeAppReactivation:input.canAttributeAppReactivation}", `canAttributeAppReactivation:input.canAttributeAppReactivation${separator}windows:windows.windowManager}`), "duplicate call window");
  }
});

test("Portal validates canonical payload and hooks in both consumer orders", () => {
  const source = mainBundleFixture();
  const dictation = require("../../../linux-features/global-dictation/patch.js").applyLinuxGlobalDictationMainProcessPatch;
  const shortcuts = require("../../../linux-features/wayland-global-shortcuts/patch.js").applyWaylandGlobalShortcutsPatch;
  for (const order of [[dictation, shortcuts], [shortcuts, dictation]]) {
    const canonical = order.reduce((value, apply) => apply(value), source);
    assert.notEqual(canonical, source); assert.equal(installPortalBackend(canonical), canonical);
    for (const [name, partial] of Object.entries({
      missingMarkHook: canonical.replace(",codexLinuxGlobalShortcutsPortalShutdown(),", ","),
      missingOneDrain: canonical.replace("codexLinuxGlobalShortcutsQuitStopped=codexLinuxGlobalShortcutsPortalShutdown(),", ""),
      renamedRuntime: canonical.replace("function codexLinuxGlobalShortcutsPortalShutdown()", "function unrelatedShutdown()"),
      nestedShadow: canonical.replace("function runMainAppStartup(input){", "function runMainAppStartup(input){function codexLinuxGlobalShortcutsPortalShutdown(){}"),
      commentedWrite: canonical.replace("r.d(t,", "codexLinuxGlobalShortcutsPortalShutdown/**/=()=>{};r.d(t,"),
      escapedWrite: canonical.replace("r.d(t,", String.raw`codexLinuxGlobalShortcutsPortalShutdow\u006e=()=>{};r.d(t,`),
    })) assertRefused(partial, name);
  }
  assertRefused(`const marker=${JSON.stringify(PATCH_MARKER)};`, "marker only");
  assertRefused(`/*${PATCH_MARKER}*/${source}`, "marker decoy on native source");
  assert.notEqual(applyFeatures(source, { dictation: true, shortcuts: true }), source);
});
