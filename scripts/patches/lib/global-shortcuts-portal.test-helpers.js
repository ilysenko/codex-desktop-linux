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
function mainBundleFixture() {
  return [
    "var p=require(`node:fs`),u=require(`node:path`),h=require(`node:child_process`),c=require(`electron`),r={r:()=>({warning(){}})};",
    "var accessState={codexLocalAccess:true,workCloudAccess:false,workLocalAccess:false},accessReady=true,accessListeners=new Set;function getAccess(){if(!accessReady)return{status:`loading`};let{codexLocalAccess:e,workCloudAccess:t,workLocalAccess:n}=accessState;return{status:`ready`,codexLocalAccess:e,workCloudAccess:t,workLocalAccess:n}}function publishAccess(e){let t=!accessReady,n=true,r=true;accessState=e;return t&&(accessReady=true),accessReady&&(t||n)&&accessListeners.forEach(e=>{e()}),r}",
    "async function shutdownApp({hotkeyWindowLifecycleManager:e,globalDictationLifecycleManager:t,flushAndDisposeContext:n,disposables:r}){e.dispose(),t.dispose(),await n(),r.dispose()}",
    "function createWindowServices(V,H,ae){return{markAppQuitting:()=>{V.markAppQuitting(),H.markAppQuitting(),ae.dispose()}}}",
    "function Kk(e,t){let n=``;e.stdout?.on(`data`,e=>{n+=e.toString(`utf8`);let r=n.indexOf(`\\n`);for(;r!==-1;)t(n.slice(0,r).trim()),n=n.slice(r+1),r=n.indexOf(`\\n`)})}",
    "var managerEntries=new Set,suspendDepth=0;function suspendGlobalHotkeys(){if(suspendDepth+=1,suspendDepth===1){for(let e of managerEntries)e.onCancelled?.(),e.registered=!1,c.globalShortcut.unregister(e.registrationHotkey)}let e=!1;return()=>{if(!e&&(e=!0,--suspendDepth,suspendDepth===0)){for(let e of managerEntries)activateHotkey(e)}}}function activateHotkey(e){let t=++e.generation;return e.registered=c.globalShortcut.register(e.registrationHotkey,()=>{suspendDepth===0&&e.registered&&e.generation===t&&e.onPressed()}),e.registered}",
    "function eA(e,t,n){let r=n?.ownership,i=t.onReleased,a=t.onCancelled,o=r==null?t:{onPressed:()=>{r.isOwner()&&t.onPressed()},onReleased:i==null?void 0:()=>{r.isOwner()&&i()},onCancelled:a==null?void 0:()=>{r.isOwner()&&a()}};if(process.platform===`win32`&&uV(e))return eBe(e,o);if(Rk(e)||Tk(e))return Lk(e)||Tk(e)?Mk(e,o,n?.bareModifierTrigger):null;let s=oA(e),l=()=>{o.onPressed()};if([...managerEntries].some(e=>e.registrationHotkey===s))return null;let d={onCancelled:o.onCancelled,hotkey:e,onPressed:l,registrationHotkey:s,generation:0,registered:!1},u=activateHotkey(d);if(!u)return null;let w=null;if(process.platform===`win32`&&o.onReleased!=null){let t=lP(e);if(w=t==null?null:g._(t,!1,e=>{e===`up`&&d.registered&&suspendDepth===0&&o.onReleased?.()}),w==null)return d.registered=!1,c.globalShortcut.unregister(s),null}return managerEntries.add(d),suspendDepth>0&&(d.registered=!1,c.globalShortcut.unregister(s)),{handlesRelease:w!=null,unregister:()=>{managerEntries.delete(d)&&(d.registered=!1,w?.dispose(),c.globalShortcut.unregister(d.registrationHotkey))}}}",
    "var CaptureSession=class{constructor(origin,window){this.origin=origin;this.window=window;this.release=suspendGlobalHotkeys();this.dispose=()=>this[Symbol.dispose]();origin.once(`destroyed`,this.dispose);window.once(`blur`,this.dispose)}[Symbol.dispose](){this.origin.removeListener(`destroyed`,this.dispose);this.window.removeListener(`blur`,this.dispose);this.release?.();this.release=null}},CaptureService=class{constructor(origin){this.origin=origin}beginCapture(){if(this.origin.isDestroyed())return null;let e=c.BrowserWindow.fromWebContents(this.origin);return e==null||!e.isFocused()?null:new CaptureSession(this.origin,e)}};",
    "function fA(e){if(process.platform===`win32`&&uV(e))return null;let t=xV(e,process.platform,{allowUnmodified:!0});if(t!=null)return t;if(Lk(e))return null;return null}",
    "function pA(e,t){switch(process.platform){case`darwin`:{let n=Ik(mA(e),t);if(n==null)throw Error(`Global dictation hotkey release watching is not supported.`);return n}case`win32`:{let n=gA(e,process.platform);if(n==null)throw Error(`Global dictation hotkey release watching is not supported.`);return BA((0,h.spawn)(`powershell.exe`,[],{stdio:`ignore`}),t)}case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`)}}",
    "function mA(e){let t=[];for(let n of e.split(`+`)){let e=uA.get(n.trim().toLowerCase());e!=null&&!t.includes(e)&&t.push(e)}return t}",
    "function _A(){return [`/unrelated/native/path`]}",
    "function BA(e,t){let n=!1,i=e=>{n||(n=!0,e!=null&&r.r().warning(`Global dictation hotkey release watching failed`,{safe:{},sensitive:{error:e}}),t())};return e.once(`error`,i),e.once(`exit`,()=>i()),{dispose:()=>{n=!0,e.kill()}}}",
    "function k7(e,t,n){return{x:e.centerX-n.x-t.width/2,y:e.centerY-n.y-t.height/2,...t}}var V7=async(...e)=>globalThis.__upstreamExecFile(...e);async function P7(){switch(process.platform){case`darwin`:await V7(`/usr/bin/osascript`,[]);return;case`win32`:return;case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`)}}",
    "var H7=class{registeredHotkey=null;registeredHotkeyRegistration=null;registeredToggleHotkey=null;registeredToggleHotkeyRegistration=null;registerHotkeyOrThrow(e,t){if(this.registeredHotkey===e)return;let n=this.registeredHotkey,r=eA(e,{onPressed:()=>{this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press(`primary`,Wl(e)||process.platform===`win32`&&oP(e))},onReleased:()=>this.shortcutGestures.release(`primary`),onCancelled:()=>this.shortcutGestures.cancelPress(`primary`)},{ownership:t,bareModifierTrigger:`cancellablePress`});if(r==null)throw Error(`Unable to register global dictation hotkey: ${e}`);n!=null&&this.registeredHotkeyRegistration?.unregister(),this.registeredHotkey=e,this.registeredHotkeyRegistration=r}unregisterHotkey(){this.registeredHotkey!=null&&(this.registeredHotkeyRegistration?.unregister(),this.registeredHotkey=null,this.registeredHotkeyRegistration=null)}registerToggleHotkeyOrThrow(e,t){if(this.registeredToggleHotkey===e)return;let n=this.registeredToggleHotkey,r=eA(e,{onPressed:()=>{this.ensureHotkeyReleaseWatchers(),this.shortcutGestures.press(`single-tap`,Wl(e)||process.platform===`win32`&&oP(e))},onReleased:()=>this.shortcutGestures.release(`single-tap`),onCancelled:()=>this.shortcutGestures.cancelPress(`single-tap`)},{bareModifierTrigger:`cancellablePress`,ownership:t});if(r==null)throw Error(`Unable to register global dictation toggle hotkey: ${e}`);n!=null&&this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=e,this.registeredToggleHotkeyRegistration=r}unregisterToggleHotkey(){this.registeredToggleHotkey!=null&&(this.registeredToggleHotkeyRegistration?.unregister(),this.registeredToggleHotkey=null,this.registeredToggleHotkeyRegistration=null)}deactivateLifecycle(){this.unregisterHotkey(),this.unregisterToggleHotkey()}ensureHotkeyReleaseWatchers(){}};",
    "var OtherHotkeys=class{registerAppshot(){this.registration=eA(this.configuredHotkey,{onPressed:()=>this.#capture()},{bareModifierTrigger:`immediatePress`})}#capture(){}registerHotkeyWindowHotkeyOrThrow(e,t){return eA(e,{onPressed:()=>{this.handleHotkeyWindowHotkeyPressed()}},{ownership:t})}updateEscapeRegistration(){return eA(`Escape`,{onPressed:()=>this.shortcutGestures.cancel()},{ownership:this.lifecycleLock})}};",
    "function petHotkey(t,e,i){return eA(t,{onPressed:()=>{if(!C7()){i();return}e().catch(e=>{console.warn(`Failed to toggle pet from global hotkey`,e)})}})}",
    "function voiceHotkey(n,a){return eA(n,{onPressed:()=>{c.powerMonitor.getSystemIdleState(1)!==`locked`&&a()}})}",
    "function meetingHotkey(i,n,e){return eA(i,{onPressed:()=>{n===i&&c.powerMonitor.getSystemIdleState(1)!==`locked`&&e()}})}",
    "function W7(){return process.platform===`darwin`||process.platform===`win32`}",
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
