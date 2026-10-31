"use strict";
const assert=require('node:assert/strict');
const { EventEmitter }=require('node:events');
const path=require('node:path');
const vm=require('node:vm');
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
function mainBundleFixture() {
  return [
    'var p=require("node:fs"),u=require("node:path"),h=require("node:child_process"),c=require("electron"),r={r:()=>({warning(){}})};',
    'var accessState={codexLocalAccess:true,workCloudAccess:false,workLocalAccess:false},accessReady=true,accessListeners=new Set;function getAccess(){if(!accessReady)return{status:"loading"};let{codexLocalAccess:e,workCloudAccess:t,workLocalAccess:r}=accessState;return{status:"ready",codexLocalAccess:e,workCloudAccess:t,workLocalAccess:r}}function publishAccess(e){let t=!accessReady,r={...accessState,...e},n=!0,i=!0;return accessState=r,t&&(accessReady=!0),accessReady&&(t||i)&&accessListeners.forEach(e=>{e()}),n}',
    'async function shutdownApp({hotkeyWindowLifecycleManager:e,globalDictationLifecycleManager:t,flushAndDisposeContext:r,disposables:n}){e.dispose(),t.dispose(),await flushWithTimeout(r,5e3),n.dispose()}function flushWithTimeout(e,t){return Promise.resolve(e())}',
    'function pendingUpdate(){return null}function clearPendingUpdate(e){}function createWindowServices(D,M,U,O){return{markAppQuitting:()=>{let e=pendingUpdate();null!=e&&clearPendingUpdate(e),D.markAppQuitting(),M.markAppQuitting(),O?.markAppQuitting(),U.dispose()}}}',
    'function Kk(e,t){let r="";e.stdout?.on("data",e=>{let n=(r+=e.toString("utf8")).indexOf("\\n");for(;-1!==n;)t(r.slice(0,n).trim()),r=r.slice(n+1),n=r.indexOf("\\n")})}',
    'function pauseBareModifiers(e){}function pauseWindowsHooks(e){}var managerEntries=new Set,suspendDepth=0;function suspendGlobalHotkeys(){return function(){if(1===(suspendDepth+=1))for(let e of(pauseBareModifiers(!0),pauseWindowsHooks(!0),managerEntries))e.onCancelled?.(),e.registered=!1,c.globalShortcut.unregister(e.registrationHotkey);let e=!1;return()=>{if(!e&&(e=!0,0==(suspendDepth-=1)))for(let e of(pauseBareModifiers(!1),pauseWindowsHooks(!1),managerEntries))activateHotkey(e)}}()}',
    'function eA(e,t,r){var n;let i=r?.ownership,s=t.onReleased,a=t.onCancelled,o=null==i?t:{onRegistrationChanged:t.onRegistrationChanged,onPressed:()=>{i.isOwner()&&t.onPressed()},onReleased:null==s?void 0:()=>{i.isOwner()&&s()},onCancelled:null==a?void 0:()=>{i.isOwner()&&a()}};if("win32"===process.platform&&uV(e))return function(e,t){return null}(e,o);if(Rk(e)||Tk(e))return Lk(e)||Tk(e)?function(e,t,r="press"){return"darwin"!==process.platform?null:{handlesRelease:!0,unregister(){}}}(e,o,r?.bareModifierTrigger):null;let l=(n=e,oA(n));if([...managerEntries].some(e=>e.registrationHotkey===l))return null;let d={onCancelled:o.onCancelled,hotkey:e,onPressed:()=>{logHotkey("global_hotkey_pressed",{safe:{hotkey:e},sensitive:{}}),o.onPressed()},registrationHotkey:l,generation:0,registered:!1},m=activateHotkey(d);if(!m)return null;let w=null;if("win32"===process.platform&&null!=o.onReleased){let t=lP(e);if(null==(w=null==t?null:g._(t,!1,e=>{"up"===e&&d.registered&&0===suspendDepth&&o.onReleased?.()})))return d.registered=!1,c.globalShortcut.unregister(l),null}return managerEntries.add(d),suspendDepth>0&&(d.registered=!1,c.globalShortcut.unregister(l)),{handlesRelease:null!=w,unregister:()=>{managerEntries.delete(d)&&(d.registered=!1,w?.dispose(),c.globalShortcut.unregister(d.registrationHotkey))}}}',
    'function activateHotkey(e){let t=++e.generation;return e.registered=c.globalShortcut.register(e.registrationHotkey,()=>{0===suspendDepth&&e.registered&&e.generation===t&&e.onPressed()}),e.registered}',
    'class CaptureService{origin;constructor(e){this.origin=e}beginCapture(){if(this.origin.isDestroyed())return null;let e=c.BrowserWindow.fromWebContents(this.origin);return null!=e&&e.isFocused()?new CaptureSession(this.origin,e):null}}class CaptureSession{origin;window;#release=suspendGlobalHotkeys();#dispose=()=>this[Symbol.dispose]();constructor(e,t){this.origin=e,this.window=t,t.once("blur",this.#dispose),e.once("destroyed",this.#dispose)}[Symbol.dispose](){this.window.removeListener("blur",this.#dispose),this.origin.removeListener("destroyed",this.#dispose),this.#release?.(),this.#release=null}}',
    'function fA(e){if("win32"===process.platform&&uV(e))return N3(e)?"Alt and Windows keys alone are reserved for system menus. Choose Ctrl, Shift, or another shortcut.":null;let t=xV(e,process.platform,{allowUnmodified:!0});if(null!=t)return t;if(Lk(e))return null;return null}',
    'function pA(e,t){switch(process.platform){case"darwin":{let r=Ik(function(e){let t=[];for(let r of e.split("+")){let e=uA.get(r.trim().toLowerCase());null==e||t.includes(e)||t.push(e)}return t}(e),t,!0);if(null==r)throw Error("Global dictation hotkey release watching is not supported.");return r}case"win32":case"aix":case"android":case"cygwin":case"freebsd":case"haiku":case"linux":case"netbsd":case"openbsd":case"sunos":throw Error("Global dictation hotkey release watching is not supported.")}}',
    'function _A(){return["/unrelated/native/path"]}function logHotkey(){}',
    'var V7=async(...e)=>globalThis.__upstreamExecFile(...e);async function P7(e){switch(process.platform){case"darwin":await V7("/usr/bin/osascript",[],{signal:e});return;case"win32":await V7("powershell.exe",[],{signal:e});return;case"aix":case"android":case"cygwin":case"freebsd":case"haiku":case"linux":case"netbsd":case"openbsd":case"sunos":throw Error("Global dictation paste is not supported on this OS.")}}',
    'class H7{registeredHotkey=null;registeredHotkeyRegistration=null;registeredToggleHotkey=null;registeredToggleHotkeyRegistration=null;setupWindowFocused=!1;registerHotkeyOrThrow(e,t){if(this.registeredHotkey===e)return;let r=this.registeredHotkey,n=eA(e,{onRegistrationChanged:()=>this.publishShortcutRecovery(),onPressed:()=>{this.setupWindowFocused||(this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press("primary",Wl(e)||"win32"===process.platform&&oP(e)))},onReleased:()=>{this.setupWindowFocused||this.shortcutGestures.release("primary")},onCancelled:()=>{this.setupWindowFocused||this.shortcutGestures.cancelPress("primary")}},{ownership:t,bareModifierTrigger:"cancellablePress"});if(null==n)throw Error(`Unable to register global dictation hotkey: ${e}`);null!=r&&this.unregisterHotkey(),this.registeredHotkey=e,this.registeredHotkeyRegistration=n}unregisterHotkey(){null!=this.registeredHotkey&&(this.registeredHotkeyRegistration?.unregister(),this.registeredHotkey=null,this.registeredHotkeyRegistration=null)}registerToggleHotkeyOrThrow(e,t){if(this.registeredToggleHotkey===e)return;let r=this.registeredToggleHotkey,n=eA(e,{onRegistrationChanged:()=>this.publishShortcutRecovery(),onPressed:()=>{this.setupWindowFocused||(this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press("single-tap",Wl(e)||"win32"===process.platform&&oP(e)))},onReleased:()=>{this.setupWindowFocused||this.shortcutGestures.release("single-tap")},onCancelled:()=>{this.setupWindowFocused||this.shortcutGestures.cancelPress("single-tap")}},{bareModifierTrigger:"cancellablePress",ownership:t});if(null==n)throw Error(`Unable to register global dictation toggle hotkey: ${e}`);null!=r&&this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=e,this.registeredToggleHotkeyRegistration=n}unregisterToggleHotkey(){null!=this.registeredToggleHotkey&&(this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=null,this.registeredToggleHotkeyRegistration=null)}deactivateLifecycle(){this.unregisterHotkey(),this.unregisterToggleHotkey()}publishShortcutRecovery(){}ensureHotkeyReleaseWatchers(){}}',
    'class OtherHotkeys{registerAppshot(){this.registration=eA(this.configuredHotkey,{onPressed:()=>this.#lU()},{bareModifierTrigger:"immediatePress"})}#lU(){}registerHotkeyWindowHotkeyOrThrow(e,t){return eA(e,{onPressed:()=>{this.handleHotkeyWindowHotkeyPressed()}},{ownership:t})}updateEscapeRegistration(){return eA("Escape",{onPressed:()=>this.shortcutGestures.cancel()},{ownership:this.lifecycleLock})}}',
    'function petHotkey(r,e,s){return eA(r,{onPressed:()=>{ePO()?e().catch(e=>{(0,em.tZQ)().warning("Failed to toggle pet from global hotkey",{safe:{},sensitive:{error:e}})}):s()}})}',
    'function voiceHotkey(r,a){return eA(r,{onPressed:()=>{"locked"!==c.powerMonitor.getSystemIdleState(1)&&a()}})}',
    'function meetingHotkey(i,n,e){return eA(i,{onPressed:()=>{n===i&&"locked"!==c.powerMonitor.getSystemIdleState(1)&&e()}})}',
    'function W7(){return"darwin"===process.platform||"win32"===process.platform}',
  ].join("");
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
      if (id === "electron") return { app: { getAppPath: () => null }, BrowserWindow: {fromWebContents: origin=>origin.window},
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
    Rk: ()=>false, Tk: ()=>false, oA: key=>key,
  };
  vm.runInNewContext(applyPatchTwice(mainBundleFixture(), features), context);
  return context;
}

function registerPortal(context, accelerator, callbacks, commandId = "globalDictationHold") {
  return context.codexLinuxGlobalShortcutsPortalRegistration(accelerator, callbacks, commandId);
}


module.exports={mainBundleFixture,applyFeatures,applyPatchTwice,waylandPatchContext,fakeHelperChild,registerPortal};
