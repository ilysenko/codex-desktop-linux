"use strict";
const assert=require('node:assert/strict');
const { EventEmitter }=require('node:events');
const path=require('node:path');
const vm=require('node:vm');
const { findMatchingBrace } = require('./minified-js.js');
const {applyLinuxGlobalDictationMainProcessPatch:dictationPatch}=require('../../../linux-features/global-dictation/patch.js');
const {applyWaylandGlobalShortcutsPatch:shortcutPatch}=require('../../../linux-features/wayland-global-shortcuts/patch.js');
function applyFeatures(source,{dictation=false,shortcuts=false}={}) {
  let patched=source;
  for(const [enabled,apply,marker] of [[dictation,dictationPatch,'codex-linux-global-dictation-v3'],[shortcuts,shortcutPatch,'codex-linux-wayland-global-shortcuts-v1']]) {
    if (enabled) { patched=apply(patched); if(!patched.includes(marker)) return source; }
  }
  return patched;
}
function applyPatchTwice(source, features={dictation:true}) {
  const patched=applyFeatures(source,features);
  assert.notEqual(patched,source);
  assert.equal(applyFeatures(patched,features),patched);
  assert.doesNotThrow(()=>new vm.Script(patched));
  return patched;
}
// Mirrors the signed rspack/SWC main-process module that owns global shortcuts
// (double-quoted literals, Yoda comparisons, (e,t,r) registration parameters).
function mainBundleFixtureBody() {
  return [
    'var p=require("node:fs"),u=require("node:path"),h=require("node:child_process"),ea=require("electron"),logModule={r:()=>({warning(){}})};',
    'var accessState={codexLocalAccess:true,workCloudAccess:false,workLocalAccess:false},accessReady=true,accessListeners=new Set;function getAccess(){if(!accessReady)return{status:"loading"};let{codexLocalAccess:e,workCloudAccess:t,workLocalAccess:r}=accessState;return{status:"ready",codexLocalAccess:e,workCloudAccess:t,workLocalAccess:r}}function publishAccess(e){let t=!accessReady,r={...accessState,...e},n=!0,i=!0;return accessState=r,t&&(accessReady=!0),accessReady&&(t||i)&&accessListeners.forEach(e=>{e()}),n}',
    'function flushWithTimeout(e,t){return new Promise(r=>{let n=setTimeout(r,t),i=()=>{clearTimeout(n),r()};e().then(i,i)})}',
    'function pendingState(){return globalThis.__readPendingState?.()??null}function commitPending(e){try{globalThis.__commitPending?.(e)}catch(e){globalThis.__commitWarning?.(e)}}function privacyAddon(){return globalThis.__privacyAddon()}var forceArmed=!1,forceModule={load:()=>globalThis.__loadForceAddon()};',
    'function Kk(e,t){let r="";e.stdout?.on("data",e=>{let n=(r+=e.toString("utf8")).indexOf("\\n");for(;-1!==n;)t(r.slice(0,n).trim()),r=r.slice(n+1),n=r.indexOf("\\n")})}',
    'function pauseBareModifiers(e){}function pauseWindowsHooks(e){}var managerEntries=new Set,suspendDepth=0;function suspendGlobalHotkeys(){return function(){if(1===(suspendDepth+=1))for(let e of(pauseBareModifiers(!0),pauseWindowsHooks(!0),managerEntries))e.onCancelled?.(),e.registered=!1,c.globalShortcut.unregister(e.registrationHotkey);let e=!1;return()=>{if(!e&&(e=!0,0==(suspendDepth-=1)))for(let e of(pauseBareModifiers(!1),pauseWindowsHooks(!1),managerEntries))activateHotkey(e)}}()}',
    'function eA(e,t,r){var n;let i=r?.ownership,s=t.onReleased,a=t.onCancelled,o=null==i?t:{onRegistrationChanged:t.onRegistrationChanged,onPressed:()=>{i.isOwner()&&t.onPressed()},onReleased:null==s?void 0:()=>{i.isOwner()&&s()},onCancelled:null==a?void 0:()=>{i.isOwner()&&a()}};if("win32"===process.platform&&uV(e))return function(e,t){return null}(e,o);if(Rk(e)||Tk(e))return Lk(e)||Tk(e)?function(e,t,r="press"){return"darwin"!==process.platform?null:{handlesRelease:!0,unregister(){}}}(e,o,r?.bareModifierTrigger):null;let l=(n=e,oA(n));if([...managerEntries].some(e=>e.registrationHotkey===l))return null;let d={onCancelled:o.onCancelled,hotkey:e,onPressed:()=>{logHotkey("global_hotkey_pressed",{safe:{hotkey:e},sensitive:{}}),o.onPressed()},registrationHotkey:l,generation:0,registered:!1},m=activateHotkey(d);if(!m)return null;let w=null;if("win32"===process.platform&&null!=o.onReleased){let t=lP(e);if(null==(w=null==t?null:g._(t,!1,e=>{"up"===e&&d.registered&&0===suspendDepth&&o.onReleased?.()})))return d.registered=!1,c.globalShortcut.unregister(l),null}return managerEntries.add(d),suspendDepth>0&&(d.registered=!1,c.globalShortcut.unregister(l)),{handlesRelease:null!=w,unregister:()=>{managerEntries.delete(d)&&(d.registered=!1,w?.dispose(),c.globalShortcut.unregister(d.registrationHotkey))}}}',
    'function activateHotkey(e){let t=++e.generation;return e.registered=c.globalShortcut.register(e.registrationHotkey,()=>{0===suspendDepth&&e.registered&&e.generation===t&&e.onPressed()}),e.registered}',
    'class CaptureService{origin;constructor(e){this.origin=e}beginCapture(){if(this.origin.isDestroyed())return null;let e=c.BrowserWindow.fromWebContents(this.origin);return null!=e&&e.isFocused()?new CaptureSession(this.origin,e):null}}class CaptureSession{origin;window;#release=suspendGlobalHotkeys();#dispose=()=>this[Symbol.dispose]();constructor(e,t){this.origin=e,this.window=t,t.once("blur",this.#dispose),e.once("destroyed",this.#dispose)}[Symbol.dispose](){this.window.removeListener("blur",this.#dispose),this.origin.removeListener("destroyed",this.#dispose),this.#release?.(),this.#release=null}}',
    'function fA(e){if("win32"===process.platform&&uV(e))return N3(e)?"Alt and Windows keys alone are reserved for system menus. Choose Ctrl, Shift, or another shortcut.":null;let t=xV(e,process.platform,{allowUnmodified:!0});if(null!=t)return t;if(Lk(e))return null;return null}',
    'function pA(e,t){switch(process.platform){case"darwin":{let r=Ik(function(e){let t=[];for(let r of e.split("+")){let e=uA.get(r.trim().toLowerCase());null==e||t.includes(e)||t.push(e)}return t}(e),t,!0);if(null==r)throw Error("Global dictation hotkey release watching is not supported.");return r}case"win32":case"aix":case"android":case"cygwin":case"freebsd":case"haiku":case"linux":case"netbsd":case"openbsd":case"sunos":throw Error("Global dictation hotkey release watching is not supported.")}}',
    'function _A(){return["/unrelated/native/path"]}function logHotkey(){}',
    "class H7{registeredHotkey=null;registeredHotkeyRegistration=null;registeredToggleHotkey=null;registeredToggleHotkeyRegistration=null;setupWindowFocused=!1;options;activeHotkeyReleaseWatcher=null;toggleHotkeyReleaseWatcher=null;constructor(e){if(this.options=e,!W7()||!e?.globalState)return;let t=e.globalState.get(\"globalDictationHotkey\");this.validation=null==t?null:fA(t)}registerHotkeyOrThrow(e,t){if(this.registeredHotkey===e)return;let r=this.registeredHotkey,n=eA(e,{onRegistrationChanged:()=>this.publishShortcutRecovery(),onPressed:()=>{this.setupWindowFocused||(this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press(\"primary\",Wl(e)||\"win32\"===process.platform&&oP(e)))},onReleased:()=>{this.setupWindowFocused||this.shortcutGestures.release(\"primary\")},onCancelled:()=>{this.setupWindowFocused||this.shortcutGestures.cancelPress(\"primary\")}},{ownership:t,bareModifierTrigger:\"cancellablePress\"});if(null==n)throw Error(`Unable to register global dictation hotkey: ${e}`);null!=r&&this.unregisterHotkey(),this.registeredHotkey=e,this.registeredHotkeyRegistration=n}unregisterHotkey(){null!=this.registeredHotkey&&(this.registeredHotkeyRegistration?.unregister(),this.registeredHotkey=null,this.registeredHotkeyRegistration=null)}registerToggleHotkeyOrThrow(e,t){if(this.registeredToggleHotkey===e)return;let r=this.registeredToggleHotkey,n=eA(e,{onRegistrationChanged:()=>this.publishShortcutRecovery(),onPressed:()=>{this.setupWindowFocused||(this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press(\"single-tap\",Wl(e)||\"win32\"===process.platform&&oP(e)))},onReleased:()=>{this.setupWindowFocused||this.shortcutGestures.release(\"single-tap\")},onCancelled:()=>{this.setupWindowFocused||this.shortcutGestures.cancelPress(\"single-tap\")}},{bareModifierTrigger:\"cancellablePress\",ownership:t});if(null==n)throw Error(`Unable to register global dictation toggle hotkey: ${e}`);null!=r&&this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=e,this.registeredToggleHotkeyRegistration=n}unregisterToggleHotkey(){null!=this.registeredToggleHotkey&&(this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=null,this.registeredToggleHotkeyRegistration=null)}deactivateLifecycle(){this.unregisterHotkey(),this.unregisterToggleHotkey()}publishShortcutRecovery(){}ensureHotkeyReleaseWatchers(){null==this.registeredHotkey||this.registeredHotkeyRegistration?.handlesRelease!==!1||this.activeHotkeyReleaseWatcher?.isActive||(this.activeHotkeyReleaseWatcher?.dispose(),this.activeHotkeyReleaseWatcher=pA(this.registeredHotkey,()=>{this.setupWindowFocused||this.shortcutGestures.release(\"primary\")})),null==this.registeredToggleHotkey||this.registeredToggleHotkeyRegistration?.handlesRelease!==!1||this.toggleHotkeyReleaseWatcher?.isActive||(this.toggleHotkeyReleaseWatcher?.dispose(),this.toggleHotkeyReleaseWatcher=pA(this.registeredToggleHotkey,()=>{this.setupWindowFocused||this.shortcutGestures.release(\"single-tap\")}))}async handleTranscript(e,t){let n=this.activeSession?.type===\"overlay\"?this.activeSession.recordingStoppedAtMs:void 0,i=this.clipboardFingerprintAtStop,s=this.recordHistoryText(e,t),a=new AbortController;if(null!=s&&(this.pendingPasteSessionId=e,this.pendingPasteAbort=a),this.clearActiveSession(),this.showIdleOrHide(),null==s)return;let o=await async function(e,t,n,i){if(i?.aborted)return null;let s=\"darwin\"===process.platform&&!ea.systemPreferences.isTrustedAccessibilityClient(!1);if(null!=n&&NZ()!==n)return{text:e,copied:!1,reason:s?\"accessibility\":\"clipboard-changed\"};let a={data:{text:ea.clipboard.readText(),html:ea.clipboard.readHTML(),rtf:ea.clipboard.readRTF(),image:ea.clipboard.readImage(),bookmark:ea.clipboard.readBookmark().title},formats:ea.clipboard.availableFormats().map(e=>({format:e,data:ea.clipboard.readBuffer(e)}))};ea.clipboard.writeText(e);let o=NZ();if(s)return{text:e,copied:!0,reason:\"accessibility\"};let l=!1;try{let n=null!=t&&Number.isFinite(t)?Math.max(0,Date.now()-t):0;if(await (0,AI.setTimeout)(Math.max(0,150-n)),i?.throwIfAborted(),NZ()!==o)return{text:e,copied:!1,reason:\"clipboard-changed\"};l=!0,await async function(e){switch(e?.throwIfAborted(),process.platform){case\"darwin\":if(!ea.systemPreferences.isTrustedAccessibilityClient(!1))throw Error(\"Accessibility permission is required to paste global dictation.\");try{await async function(e){let{callFunction:t,fromPointer:n,NobjcLibrary:i}=await Promise.resolve().then(r.t.bind(r,24250,23));e?.throwIfAborted();let s=new i(\"/System/Library/Frameworks/AppKit.framework/AppKit\"),a=s.NSString,o=new Map,l=e=>{let t=o.get(e);if(null!=t)return t;let r=a.stringWithUTF8String$(e);return o.set(e,r),r},c=s.NSBundle.bundleWithIdentifier$(l(\"com.apple.AppKit\")),d=\"Paste\";null!=c&&(d=c.localizedStringForKey$value$table$(l(\"Paste\"),l(\"Paste\"),l(\"MenuCommands\")).UTF8String());let u={callFunction:t,fromPointer:n,localizedPasteTitle:d,nativeString:l},h=t(\"AXUIElementCreateSystemWide\",{returns:\"@\",args:[]});if(null==h)throw Error(\"Unable to access the macOS accessibility system.\");t(\"CFRelease\",{returns:\"v\",args:[\"@\"]},h);let p=NB(u,h,\"AXFocusedApplication\"),m=null!=p?NB(u,p,\"AXMenuBar\"):void 0;if(null==m)throw Error(\"The foreground application does not expose an accessible menu bar.\");let g=function(e,t){let r,n=[t],i=0,s=!1;for(;n.length>0;){let t=n.pop();if(null==t)continue;if((i+=1)>1e3)throw Error(\"The foreground application menu is too large to search.\");if(\"AXMenuItem\"===NW(e,t,\"AXRole\")){let n=NB(e,t,\"AXEnabled\");if(!n?.boolValue())continue;let i=NW(e,t,\"AXIdentifier\");if(null!=i&&/(?:^|[./_-])paste:?$/iu.test(i))return t;let a=NW(e,t,\"AXTitle\");if(\"Paste\"===a||a===e.localizedPasteTitle)return t;let o=NW(e,t,\"AXMenuItemCmdChar\"),l=NB(e,t,\"AXMenuItemCmdModifiers\");o?.toLowerCase()===\"v\"&&l?.intValue()===0&&(null==r?r=t:s=!0)}let a=NB(e,t,\"AXChildren\");if(null==a)continue;let o=a.count();for(let e=o-1;e>=0;e-=1){let t=a.objectAtIndex$(e);n.push(t)}}return s?void 0:r}(u,m);if(null==g)throw Error(\"The foreground application does not expose an enabled Paste command.\");e?.throwIfAborted();let f=t(\"AXUIElementPerformAction\",{returns:\"i\",args:[\"@\",\"@\"]},g,l(\"AXPress\"));if(0!==f&&-25204!==f&&-25205!==f)throw Error(`Unable to activate the foreground application's Paste command (accessibility error ${f}).`,{cause:f})}(e)}catch{e?.throwIfAborted(),await NV(\"/usr/bin/osascript\",[\"-e\",'tell application \"System Events\" to keystroke \"v\" using command down'],{signal:e})}return;case\"win32\":await NV(\"powershell.exe\",[\"-STA\",\"-NoProfile\",\"-NonInteractive\",\"-ExecutionPolicy\",\"Bypass\",\"-Command\",\"Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')\"],{signal:e});return;case\"aix\":case\"android\":case\"cygwin\":case\"freebsd\":case\"haiku\":case\"linux\":case\"netbsd\":case\"openbsd\":case\"sunos\":throw Error(\"Global dictation paste is not supported on this OS.\")}}(i),await (0,AI.setTimeout)(700)}catch(t){if(i?.aborted)return l&&await (0,AI.setTimeout)(700),NZ()===o&&NX(a,e),null;return(0,ed.tZQ)().warning(\"Global dictation paste failed\",{safe:{},sensitive:{error:t}}),{text:e,copied:NZ()===o,reason:\"darwin\"!==process.platform||ea.systemPreferences.isTrustedAccessibilityClient(!1)?\"paste\":\"accessibility\"}}return NZ()===o&&NX(a,e),null}(`${s} `,n,i,a.signal);this.pendingPasteSessionId===e&&(null!=o&&await this.windowController.showPasteFailure(o,()=>this.pendingPasteSessionId===e),this.pendingPasteSessionId===e&&(this.pendingPasteAbort=null,this.pendingPasteSessionId=null,this.updateEscapeRegistration()))}updateEscapeRegistration(){if(!this.shouldRegisterEscape()){this.escapeRegistration?.unregister(),this.escapeRegistration=null;return}null==this.escapeRegistration&&null!=this.lifecycleLock&&(this.escapeRegistration=eA(\"Escape\",{onPressed:()=>{this.shouldRegisterEscape()&&(this.activeSession?.type!==\"inApp\"||this.shortcutGestures.hasPendingStart?this.shortcutGestures.cancel():this.stopRecording(this.activeSession.id))}},{ownership:this.lifecycleLock}))}}",
    'class HotkeyWindowController{constructor(e,t){this.windowManager=e,this.globalState=t;let s=this.globalState.get("hotkeyWindowHotkey"),a=null!=s&&null==fA(s)?s:null,o=commandKeymap("hotkeyWindow");this.configuredHotkeyWindowHotkey=resolveKeymap({keymapHotkey:o,legacyHotkey:a})}isHotkeyWindowEffectivelyEnabled(){return!this.isDisposed&&this.isHotkeyWindowGateEnabled&&null!=this.configuredHotkeyWindowHotkey&&(!this.isDevMode||this.devHotkeyWindowHotkeyOverrideEnabled)}registerHotkeyWindowHotkeyOrThrow(e,t){if(this.registeredHotkeyWindowHotkey===e)return;let r=this.registeredHotkeyWindowHotkey,n=eA(e,{onPressed:()=>{this.handleHotkeyWindowHotkeyPressed()}},{ownership:t});if(null==n)throw Error("Unable to register Popout");null!=r&&this.registeredHotkeyWindowHotkeyRegistration?.unregister(),this.registeredHotkeyWindowHotkey=e,this.registeredHotkeyWindowHotkeyRegistration=n}applyLifecycle(e){this.isHotkeyWindowEffectivelyEnabled()&&this.registerHotkeyWindowHotkeyOrThrow(this.configuredHotkeyWindowHotkey,e)}handleHotkeyWindowHotkeyPressed(){globalThis.__popoutPressed?.()}dispose(){this.registeredHotkeyWindowHotkeyRegistration?.unregister()}}',
    'class AppshotHotkeys{getState(){return{supported:this.enabled&&("darwin"===process.platform||"win32"===process.platform&&null!=this.windowsCaptureNativeBridge&&!this.windowsCaptureNativeBridgeFailed),configuredHotkey:this.configuredHotkey,isActive:null!=this.registration}}reconcile(){if(this.registration?.unregister(),this.registration=null,!this.getState().supported||null==this.configuredHotkey)return;if("darwin"===process.platform&&normalizeHotkey(this.configuredHotkey,{bareModifierTrigger:"immediatePress"}),this.registration=eA(this.configuredHotkey,{onPressed:()=>this.#lU()},{bareModifierTrigger:"immediatePress"}),null==this.registration)throw Error("Unable to register Appshot")}#lU(){globalThis.__appshotPressed?.()}dispose(){this.registration?.unregister()}}',
    'class MeetingWindows{appShellCommandKeymapState={};appShellShortcutStates=new Map;meetingsHotkeyController=(function(e){let t=null,r=null,n=()=>{t?.unregister(),t=null,r=null};return{dispose:n,sync:i=>{i===r||(n(),null!=i&&null==fA(i)&&(null==(t=eA(i,{onPressed:()=>{r===i&&"locked"!==ea.powerMonitor.getSystemIdleState(1)&&e()}}))?logModule.r().warning("Unable to register Meetings shortcut",{safe:{},sensitive:{hotkey:i}}):r=i))}}})(()=>{let e=this.getPrimaryWindow();null==e||this.isAppQuitting||this.appShellShortcutStates.get(this.getActiveWebContents(e).id)?.canTakeMeetingNotes!==!0||this.sendMessageToWindow(e,{type:"run-command",id:"meetings.takeNotes"})});syncMeetingsHotkey(){let e=this.getPrimaryWindow(),t=!this.isAppQuitting&&null!=e&&this.appShellShortcutStates.get(this.getActiveWebContents(e).id)?.canTakeMeetingNotes===!0;this.meetingsHotkeyController.sync(t?commandKeymap("meetings.takeNotes",this.appShellCommandKeymapState).hotkey:null)}markAppQuitting(){this.isAppQuitting=!0}}',
    'function W7(){return"darwin"===process.platform||"win32"===process.platform}',
    // The published startup evaluates the same direct object-IIFE shape as the
    // current signed app. No test adapter invokes this complete startup.
    "function runMainAppStartup(input){let windows=function({windowManager:D,avatarOverlayManager:M,spotlightController:U,hotkeyWindowLifecycleManager:j,globalState:G}){let O;D=new MeetingWindows(); j=new HotkeyWindowController(D,G);let A=new AppshotHotkeys(),Q=function({toggleAvatarOverlay:e,notch:t}){let r=(0,ed.opO)({commandId:\"openAvatarOverlay\",isMacOS:\"darwin\"===process.platform}),n=null,i=null,q=null,s=()=>{i?.unregister(),i=null,n=null},a=()=>{if(null==r||!eCT())return void s();if(n===r)return;let t=eA(r,{onPressed:()=>{eCT()?(null==q||\"locked\"!==ea.powerMonitor.getSystemIdleState(1))&&(q??e)().catch(e=>{(0,ed.tZQ)().warning(\"Failed to open Quick Chat from global hotkey\",{safe:{},sensitive:{error:e}})}):s()}});if(null==t)throw Error(`Unable to register pet hotkey: ${r}`);s(),i=t,n=r},o=ti(()=>{try{a()}catch(e){(0,ed.tZQ)().warning(\"Failed to sync pet hotkey access\",{safe:{},sensitive:{error:e}})}}),l=t?.subscribeEnabled(()=>{});try{a()}catch(e){(0,ed.tZQ)().warning(\"Failed to register pet hotkey\",{safe:{},sensitive:{error:e}})}return{setQuickChatHandler:e=>{q=e},dispose:()=>{l?.(),o(),s()},syncCommandKeybinding:e=>{null!=e&&e!==r&&No(e),r=e;try{a()}catch(e){(0,ed.tZQ)().warning(\"Failed to sync pet hotkey\",{safe:{},sensitive:{error:e}})}}}}({toggleAvatarOverlay:()=>P.toggleFromHotkey(),notch:null==N?void 0:{toggleQuickChat:()=>N.toggleFromHotkey(),isEnabled:()=>N.isNotchEnabled,subscribeEnabled:e=>N.subscribeNotchPresentation(e),startVoice:async()=>{let e=dl(N);e.isSessionReserved()||await e.requestStart(null,{source:\"global_hotkey_new_thread\"},void 0),await N.showNotch()}}}),V=function({requestRealtimeToggle:e,subscribeRealtimeVoiceSessionReservation:t}){let r=NC(\"realtimeVoice\").hotkey,n=null,i=null,s=!1,a=()=>{e().catch(e=>{(0,ed.tZQ)().warning(\"Failed to toggle realtime voice hotkey\",{safe:{},sensitive:{error:e}})})},o=null,l=e=>{if(!e){null!=o&&(clearInterval(o),o=null);return}null==o&&(o=setInterval(()=>{\"locked\"===ea.powerMonitor.getSystemIdleState(1)&&a()},250)).unref()},c=()=>{i?.unregister(),i=null,n=null},d=()=>{if(null==r||!tt().realtimeVoice&&!s)return void c();if(n===r)return;let e=eA(r,{onPressed:()=>{\"locked\"!==ea.powerMonitor.getSystemIdleState(1)&&a()}});if(null==e)throw Error(`Unable to register voice chat hotkey: ${r}`);c(),i=e,n=r},u=()=>{try{d()}catch(e){(0,ed.tZQ)().warning(\"Failed to apply realtime voice hotkey\",{safe:{},sensitive:{error:e}})}},h=tn(u),p=t(e=>{s=e,l(e),u()});return{dispose:()=>{h(),p(),l(!1),c()},syncCommandKeybinding:e=>{null!=e&&e!==r&&No(e),r=e;try{d()}catch(e){(0,ed.tZQ)().warning(\"Failed to sync realtime voice hotkey\",{safe:{},sensitive:{error:e}})}}}}({requestRealtimeToggle:()=>J.toggleGlobalHotkeySession(),subscribeRealtimeVoiceSessionReservation:e=>J.subscribeSessionReservationChanges(e)});let L=new H7({windowManager:D,globalState:G});return{windowManager:D,avatarOverlayManager:M,notchOverlayManager:O,appshotHotkeysService:A,overlayHotkeyController:Q,realtimeVoiceHotkeyController:V,spotlightController:U,hotkeyWindowLifecycleManager:j,globalDictationLifecycleManager:L,markAppQuitting:()=>{let e=pendingState();null!=e&&commitPending(e),D.markAppQuitting(),M.markAppQuitting(),O?.markAppQuitting(),U.dispose()}}}({windowManager:input.windowManager,avatarOverlayManager:input.avatarOverlayManager,spotlightController:input.spotlightController,hotkeyWindowLifecycleManager:input.hotkeyWindowLifecycleManager,globalState:input.globalState});0,function({isWindows:e,quitState:r,windows:n,applicationMenuManager:i,ensureWindow:s,hotkeyWindowLifecycleManager:a,globalDictationLifecycleManager:o,globalState:l,settingsStore:c,stopCodexMicro:u,flushTracingBeforeQuit:h,flushAndDisposeContext:p,disposables:m,appEvent:g,onAppEntrySource:f,canAttributeAppReactivation:w}){let y=!1,v=!1;ea.app.on(\"before-quit\",i=>{!function({addon:e,electronAppPath:t=ea.app.getAppPath(),platform:r=process.platform,resourcesPath:n=process.resourcesPath}={}){if(\"darwin\"!==r)return!1;try{return(e??privacyAddon({electronAppPath:t,resourcesPath:n})).isPrivacySettingsTerminationRequest()}catch{return!1}}()?(v=!0,n.markAppQuitting()):i.preventDefault()}),ea.app.on(\"will-quit\",t=>{if(v=!0,y)return;e&&ea.app.isPackaged&&function({loadNativeAddon:e=forceModule.load,platform:t=process.platform}={}){if(\"win32\"===t&&!forceArmed)try{(function(e){let t=e();if(null==t)throw Error(\"Failed to load Windows updater addon.\");return t})(e).armTerminateCurrentProcess(1e4),forceArmed=!0}catch(e){logModule.r().warning(\"Failed to arm Windows forced exit\",{safe:{},sensitive:{error:e}})}}();let n=()=>{flushWithTimeout(p,5e3).then(()=>{m.dispose(),ea.app.quit()})};if(r.shouldSkipDrainBeforeQuit()){t.preventDefault(),y=!0,a.dispose(),o.dispose(),Promise.allSettled([l.flush(),u(),h()]).then(n);return}t.preventDefault(),y=!0,a.dispose(),o.dispose(),Promise.allSettled([l.flush(),c.flush(),u(),h()]).then(n)})}({isWindows:input.isWindows,quitState:input.quitState,windows:windows,applicationMenuManager:input.applicationMenuManager,ensureWindow:input.ensureWindow,hotkeyWindowLifecycleManager:windows.hotkeyWindowLifecycleManager,globalDictationLifecycleManager:windows.globalDictationLifecycleManager,globalState:input.globalState,settingsStore:input.settingsStore,stopCodexMicro:input.stopCodexMicro,flushTracingBeforeQuit:input.flushTracingBeforeQuit,flushAndDisposeContext:input.flushAndDisposeContext,disposables:input.disposables,appEvent:input.appEvent,onAppEntrySource:input.onAppEntrySource,canAttributeAppReactivation:input.canAttributeAppReactivation});return windows}",
    'r.d(t,{runMainAppStartup:()=>runMainAppStartup});e.exports=t;',
  ].join("").replace(/\bc\.(app|globalShortcut|BrowserWindow|powerMonitor)\b/gu, "ea.$1");
}

function mainBundleFixture({ key = "82820", extra = "" } = {}) {
  return `exports.ids=[45],exports.modules={${key}(e,t,r){"use strict";${mainBundleFixtureBody()}}${extra}};`;
}

function fixtureFactoryBody(source) {
  const header = /82820\(e,t,r\)\{/u.exec(source);
  assert.ok(header, "Expected the test fixture's explicit CommonJS factory");
  const open = header.index + header[0].length - 1;
  const end = findMatchingBrace(source, open);
  assert.ok(end > open);
  return source.slice(open + 1, end);
}

function fixtureQuitInstaller(source) {
  const start = source.indexOf("function({isWindows:");
  assert.ok(start >= 0, "Expected the fixture's direct quit installer");
  const open = source.indexOf("){", start) + 1;
  const end = findMatchingBrace(source, open);
  assert.ok(end > open);
  return source.slice(start, end + 1);
}

function fixtureMarkProperty(source) {
  const start = source.indexOf("markAppQuitting:()=>{");
  assert.ok(start >= 0, "Expected the fixture's window mark callback");
  const open = source.indexOf("{", start);
  return source.slice(start, findMatchingBrace(source, open) + 1);
}

function fakeHelperChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = {
    writes: [],
    write(value, callback) {
      this.writes.push(value);
      callback?.();
      return true;
    },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.ready = (indices = Array.from({length: child.shortcutCount}, (_, i) => i)) => {
    child.stdout.emit('data', Buffer.from(['bindings', ...indices.map(i => `bound:${i}:System shortcut ${i}`), 'ready', ''].join('\n')));
  };
  child.kill = (signal) => {
    child.signals ??= [];
    child.signals.push(signal);
    if (!child.killed) setImmediate(() => child.emit("exit", 0));
    child.killed = true;
    return true;
  };
  return child;
}

function waylandPatchContext(children, features={dictation:true}) {
  const context = {
    Buffer,
    Symbol,
    console: { warn: (...args) => context.__warnings.push(args) },
    process: {
      env: { XDG_SESSION_TYPE: "wayland", WAYLAND_DISPLAY: "wayland-0" },
      platform: "linux",
      resourcesPath: "/test/resources",
    },
    require(id) {
      if (id === "node:fs") return { accessSync() {}, existsSync: () => true, constants: { X_OK: 1 } };
      if (id === "node:path") return path;
      if (id === "node:child_process") {
        return {
          spawn: (...args) => {
            context.__spawns.push(args);
            const child=children.shift();
            if (!child) throw new Error('Unexpected helper spawn');
            child.shortcutCount=(args[1].length-1)/4;
            return child;
          },
          execFileSync: (...args) => {
            context.__checks.push(args);
            const accelerator=args[1].at(-1);
            if (context.__validate) return context.__validate(accelerator);
            const parts=accelerator.toLowerCase().split('+').map(p => p.trim());
            const key=parts.pop();
            if (!parts.length || !/^[a-z0-9]+$/.test(key) || key === 'unsupported') throw new Error('Unsupported accelerator');
            return [...new Set(parts.map(p=>({control:'CTRL',ctrl:'CTRL',commandorcontrol:'CTRL',cmdorctrl:'CTRL',super:'LOGO',meta:'LOGO',alt:'ALT',shift:'SHIFT'}[p] ?? (()=>{throw new Error('Unsupported modifier')})())))].sort().concat(key).join('+')+'\n';
          },
          execFile: (...args) => context.__execFile(...args),
        };
      }
      if (id === "electron") return { app: Object.assign(new EventEmitter(), { getAppPath: () => null, quit() { this.emit("quit"); } }), BrowserWindow: {fromWebContents: origin=>origin.window},
        globalShortcut: {register: (key,callback) => {context.__electronRegistrations.set(key,callback);return context.process.env.XDG_SESSION_TYPE !== 'wayland'}, unregister: key=>context.__electronRegistrations.delete(key)} };
      throw new Error(`unexpected module: ${id}`);
    },
    clearTimeout,
    setTimeout,
    __spawns: [],
    __checks: [],
    __electronRegistrations: new Map(),
    __warnings: [],
    __execFile: (_file, _args, _options, callback) => callback(),
    __upstreamExecFile: async () => {},
    __privacyAddon: () => ({ isPrivacySettingsTerminationRequest: () => false }),
    __loadForceAddon: () => ({ armTerminateCurrentProcess() {} }),
    Rk: ()=>false, Tk: ()=>false, oA: key=>key, xV: ()=>null, Lk: ()=>false,
  };
  const patched = applyPatchTwice(mainBundleFixture(), features);
  const exports = {};
  context.e = { exports };
  context.t = exports;
  context.r = { d(target, getters) {
    for (const [name, getter] of Object.entries(getters)) Object.defineProperty(target, name, { get: getter });
  } };
  // Evaluate the verified fixture factory body to expose existing inert runtime
  // variables. The published Electron startup is deliberately left uncalled.
  vm.runInNewContext(fixtureFactoryBody(patched), context);
  context.createWindowServices = vm.runInNewContext(
    `(function(D,M,U,O){return{${fixtureMarkProperty(patched)}}})`, context,
  );
  const registerQuitLifecycle = vm.runInNewContext(`(${fixtureQuitInstaller(patched)})`, context);
  context.installQuitLifecycle = (options = {}) => registerQuitLifecycle({
    isWindows: false,
    quitState: { shouldSkipDrainBeforeQuit: () => false },
    windows: { markAppQuitting() {} }, applicationMenuManager: {}, ensureWindow() {},
    hotkeyWindowLifecycleManager: { dispose() {} }, globalDictationLifecycleManager: { dispose() {} },
    globalState: { flush: async () => {} }, settingsStore: { flush: async () => {} },
    stopCodexMicro: async () => {}, flushTracingBeforeQuit: async () => {},
    flushAndDisposeContext: async () => {}, disposables: { dispose() {} },
    appEvent: null, onAppEntrySource() {}, canAttributeAppReactivation: () => false,
    ...options,
  });
  context.shutdownApp = options => new Promise(resolve => {
    context.ea.app.once("quit", resolve);
    context.installQuitLifecycle(options);
    context.ea.app.emit("will-quit", { preventDefault() {} });
  });
  return context;
}

function registerPortal(context, accelerator, callbacks, commandId = "globalDictationHold") {
  return context.codexLinuxGlobalShortcutsPortalRegistration(accelerator, callbacks, commandId);
}


module.exports={mainBundleFixture,mainBundleFixtureBody,fixtureFactoryBody,fixtureQuitInstaller,fixtureMarkProperty,applyFeatures,applyPatchTwice,waylandPatchContext,fakeHelperChild,registerPortal};
