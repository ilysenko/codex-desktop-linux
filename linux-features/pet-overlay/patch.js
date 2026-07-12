"use strict";

const VALID_GRAVITIES = new Set(["bottom-right", "bottom-left", "top-right", "top-left"]);
const DESCRIPTOR_ID = "pet-overlay-main";
const AVATAR_SELECTION_REFRESH_MARKER = "codexPetOverlayRefreshAvatarWindows";

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote != null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function integerSetting(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(number)));
}

function booleanSetting(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function mergedPetOverlaySettings(context = {}) {
  const defaults = context.feature?.manifest?.petOverlay ?? {};
  const settingsRoot = context.feature?.settings ?? {};
  const overrides = settingsRoot.petOverlay ?? settingsRoot;
  const defaultGravity = VALID_GRAVITIES.has(defaults.gravity) ? defaults.gravity : "bottom-right";
  const gravity = VALID_GRAVITIES.has(overrides.gravity) ? overrides.gravity : defaultGravity;
  const defaultMode = defaults.mode === "passive" ? "passive" : "interactive";
  const mode = overrides.mode === "passive" || overrides.mode === "interactive"
    ? overrides.mode
    : defaultMode;

  return {
    allWorkspaces: booleanSetting(overrides.allWorkspaces, booleanSetting(defaults.allWorkspaces, true)),
    alwaysOnTop: booleanSetting(overrides.alwaysOnTop, booleanSetting(defaults.alwaysOnTop, true)),
    gravity,
    hyprland: booleanSetting(overrides.hyprland, booleanSetting(defaults.hyprland, true)),
    lockPosition: booleanSetting(overrides.lockPosition, booleanSetting(defaults.lockPosition, false)),
    margin: integerSetting(overrides.margin ?? defaults.margin, 24, 0, 512),
    mode,
    niri: booleanSetting(overrides.niri, booleanSetting(defaults.niri, true)),
    skipTaskbar: booleanSetting(overrides.skipTaskbar, booleanSetting(defaults.skipTaskbar, true)),
  };
}

function boolLiteral(value) {
  return value ? "!0" : "!1";
}

function avatarOverlayRegionStart(source) {
  const routeIndex = source.indexOf("`/avatar-overlay`");
  if (routeIndex !== -1) {
    return routeIndex;
  }
  const stateIndex = source.indexOf("avatar-overlay-open-state-changed");
  return stateIndex === -1 ? 0 : stateIndex;
}

function findAvatarOverlayClass(source) {
  const classRegex = /class(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[A-Za-z_$][\w$.]*)?\{/g;
  classRegex.lastIndex = avatarOverlayRegionStart(source);

  let match;
  while ((match = classRegex.exec(source)) != null) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex === -1) {
      classRegex.lastIndex = openIndex + 1;
      continue;
    }
    const text = source.slice(match.index, closeIndex + 1);
    if (text.includes("appearance:`avatarOverlay`") || text.includes("avatar-overlay-open-state-changed")) {
      return { start: match.index, end: closeIndex + 1, text };
    }
    classRegex.lastIndex = closeIndex + 1;
  }
  return null;
}

function findMethodAfter(source, signatureRegex, startIndex, endIndex) {
  const match = source.slice(startIndex, endIndex).match(signatureRegex);
  if (match == null) {
    return null;
  }
  const absoluteIndex = startIndex + match.index;
  const openIndex = absoluteIndex + match[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  if (closeIndex === -1 || closeIndex + 1 > endIndex) {
    return null;
  }
  return {
    match,
    start: absoluteIndex,
    end: closeIndex + 1,
    text: source.slice(absoluteIndex, closeIndex + 1),
  };
}

function findAvatarOverlayMethod(source, signatureRegex) {
  const overlayClass = findAvatarOverlayClass(source);
  if (overlayClass == null) {
    return null;
  }
  return findMethodAfter(source, signatureRegex, overlayClass.start, overlayClass.end);
}

function replaceMethodText(source, method, replacement) {
  if (method == null || method.text === replacement) {
    return source;
  }
  return source.slice(0, method.start) + replacement + source.slice(method.end);
}

function firstMethodArgument(methodText, methodName, index) {
  const match = methodText.match(new RegExp(`${methodName}\\((.*)\\)\\{`));
  const rawArg = match?.[1]?.split(",")?.[index]?.trim() ?? "";
  return rawArg.match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? null;
}

function buildPetOverlayMethods(settings) {
  return [
    `codexPetOverlaySettings(){let e={margin:${settings.margin},gravity:\`${settings.gravity}\`,allWorkspaces:${boolLiteral(settings.allWorkspaces)},alwaysOnTop:${boolLiteral(settings.alwaysOnTop)},skipTaskbar:${boolLiteral(settings.skipTaskbar)},lockPosition:${boolLiteral(settings.lockPosition)},mode:\`${settings.mode}\`,hyprland:${boolLiteral(settings.hyprland)},niri:${boolLiteral(settings.niri)}};try{let t=process.env.CODEX_PET_OVERLAY_MARGIN??process.env.CODEX_PET_LINUX_MARGIN,n=Number(t);Number.isFinite(n)&&(e.margin=Math.max(0,Math.min(512,Math.round(n))));let r=process.env.CODEX_PET_OVERLAY_GRAVITY??process.env.CODEX_PET_LINUX_GRAVITY;[\`bottom-right\`,\`bottom-left\`,\`top-right\`,\`top-left\`].includes(r)&&(e.gravity=r);let i=process.env.CODEX_PET_OVERLAY_MODE??process.env.CODEX_PET_LINUX_MODE;(i===\`interactive\`||i===\`passive\`)&&(e.mode=i);let a=process.env.CODEX_PET_OVERLAY_LOCK_POSITION??process.env.CODEX_PET_LINUX_LOCK_POSITION;a===\`1\`&&(e.lockPosition=!0),a===\`0\`&&(e.lockPosition=!1);let o=process.env.CODEX_PET_OVERLAY_HYPRLAND??process.env.CODEX_PET_LINUX_HYPRLAND;o===\`1\`&&(e.hyprland=!0),o===\`0\`&&(e.hyprland=!1);let s=process.env.CODEX_PET_OVERLAY_NIRI;s===\`1\`&&(e.niri=!0),s===\`0\`&&(e.niri=!1)}catch{}return e}`,
    "codexPetOverlayRect(e){if(e==null)return null;let t=Number(e.x),n=Number(e.y),r=Number(e.width),i=Number(e.height);return[t,n,r,i].every(Number.isFinite)&&r>0&&i>0?{x:t,y:n,width:r,height:i}:null}",
    "codexPetOverlayDisplayRect(e){return this.codexPetOverlayRect(e?.workArea??e?.bounds??e)}",
    "codexPetOverlayWindowBounds(e){try{return this.codexPetOverlayRect(e?.getBounds?.()??e?.getContentBounds?.())}catch{return null}}",
    "codexPetOverlayMoved(e,t,n=8){return e!=null&&t!=null&&(Math.abs(Number(e.x)-Number(t.x))>n||Math.abs(Number(e.y)-Number(t.y))>n)}",
    "codexPetOverlayBoundsNearDisplay(e,t,n=64){if(e==null||t==null)return!1;let r=Number(e.x)+Number(e.width)/2,i=Number(e.y)+Number(e.height)/2,a=Number(t.x),o=Number(t.y),s=Number(t.width),c=Number(t.height);return[r,i,a,o,s,c].every(Number.isFinite)&&r>=a-n&&r<=a+s+n&&i>=o-n&&i<=o+c+n}",
    "codexPetOverlayMascotRect(e){let t=e?.mascot;if(t==null)return null;let n=Number(t.left),r=Number(t.top),i=Number(t.width),a=Number(t.height);return[n,r,i,a].every(Number.isFinite)&&i>0&&a>0?{left:n,top:r,width:i,height:a}:null}",
    "codexPetOverlayLayoutAtWindowPosition(e,t){if(e==null||t==null||t.windowBounds==null)return t;let n={...t.windowBounds,x:Math.round(e.x),y:Math.round(e.y)},r=this.codexPetOverlayMascotRect(t),i=r==null?{x:n.x,y:n.y,width:t.anchor?.width??n.width,height:t.anchor?.height??n.height}:{x:n.x+r.left,y:n.y+r.top,width:r.width,height:r.height},a=t.anchor==null?t.anchor:{...t.anchor,x:Math.round(i.x),y:Math.round(i.y),width:t.anchor.width??i.width,height:t.anchor.height??i.height};return{...t,anchor:a,windowBounds:n}}",
    "codexPetOverlayGravityBounds(e,t,n){if(e==null||t==null||t.windowBounds==null)return null;let r={...t.windowBounds},i=this.codexPetOverlayMascotRect(t)??{left:0,top:0,width:Number(r.width),height:Number(r.height)},a=Number(i.left),o=Number(i.top),s=Number(i.width),c=Number(i.height);if(![a,o,s,c].every(Number.isFinite)||s<=0||c<=0)return null;let l=Math.max(0,Math.min(512,Number(n?.margin)||0)),u=String(n?.gravity??`bottom-right`);return r.x=u.endsWith(`left`)?Math.round(e.x+l-a):Math.round(e.x+e.width-l-a-s),r.y=u.startsWith(`top`)?Math.round(e.y+l-o):Math.round(e.y+e.height-l-o-c),r}",
    "codexPetOverlayTrayAboveLeft(e){if(process.platform!==`linux`||e==null||e.windowBounds==null||e.mascot==null||e.tray==null)return e;let t=Number(e.windowBounds.width),n=Number(e.windowBounds.height),r=Number(e.mascot.width),i=Number(e.mascot.height),a=Number(e.tray.width),o=Number(e.tray.height);if(![t,n,r,i,a,o].every(Number.isFinite)||t<=0||n<=0||r<=0||i<=0||a<=0||o<=0)return e;let s=Math.max(0,Math.round(t-r)),c=Math.max(0,Math.round(n-i)),l=Math.max(0,Math.min(Math.round(t-a),Math.round(s+r-a))),u=Math.max(0,Math.min(Math.round(n-o),Math.round(c-o-4))),d=e.anchor??{x:Number(e.windowBounds.x)+(Number(e.mascot.left)||0),y:Number(e.windowBounds.y)+(Number(e.mascot.top)||0),width:r,height:i},p={...e.windowBounds,x:Math.round(Number(d.x)-s),y:Math.round(Number(d.y)-c)},h={...d,x:Math.round(Number(d.x)),y:Math.round(Number(d.y)),width:d.width??r,height:d.height??i};return{...e,anchor:h,mascot:{...e.mascot,left:s,top:c,width:r,height:i},tray:{...e.tray,left:l,top:u,width:a,height:o},placement:`top-end`,windowBounds:p}}",
    "codexPetOverlayRememberLayout(e,t){let n=this.codexPetOverlayRect(t);this.codexPetOverlayDesiredDisplayBounds=n==null?null:{x:Math.round(n.x),y:Math.round(n.y),width:Math.round(n.width),height:Math.round(n.height)};let r=this.codexPetOverlayRect(e?.windowBounds);if(r!=null){let i={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},a=this.codexPetOverlayDesiredWindowBounds,o=a==null||a.x!==i.x||a.y!==i.y||a.width!==i.width||a.height!==i.height;this.codexPetOverlayDesiredWindowBounds=i;if(o&&this.window!=null){let e=this.codexPetOverlaySettings();try{e.lockPosition===!0&&this.codexPetOverlayScheduleHyprlandHints(this.window)}catch{}try{this.dragState!=null?this.codexPetOverlayQueueNiriDrag(this.window):this.codexPetOverlayScheduleNiriHints(this.window)}catch{}}}return e}",
    "codexPetOverlayLayoutForDisplay(e,t,n){if(process.platform!==`linux`||t==null||t.windowBounds==null)return this.codexPetOverlayRememberLayout(this.codexPetOverlayTrayAboveLeft(t));let r=this.codexPetOverlayDisplayRect(e),i=this.codexPetOverlaySettings(),a=t;if(i.lockPosition===!0&&r!=null){let e=this.codexPetOverlayGravityBounds(r,a,i);e!=null&&(a=this.codexPetOverlayLayoutAtWindowPosition(e,a))}else if(this.dragState==null){let e=this.codexPetOverlayWindowBounds(n),o=!1;try{o=n?.isVisible?.()===!0}catch{}e!=null&&r!=null&&this.codexPetOverlayBoundsNearDisplay(e,r)&&(o||this.codexPetOverlayInitialPositionDone===!0||this.codexPetOverlayManualPosition===!0)?(this.codexPetOverlayInitialPositionDone=!0,this.codexPetOverlayMoved(e,a.windowBounds)&&(this.codexPetOverlayManualPosition=!0),a=this.codexPetOverlayLayoutAtWindowPosition(e,a)):this.codexPetOverlayInitialPositionDone=!0}return this.codexPetOverlayRememberLayout(this.codexPetOverlayTrayAboveLeft(a),r)}",
    "codexPetOverlayInstallTransparentRenderer(e){try{if(e.__codexPetOverlayTransparentRendererInstalled)return;e.__codexPetOverlayTransparentRendererInstalled=!0;let t=e.webContents,n=()=>{try{t==null||t.isDestroyed?.()||t.insertCSS?.(`html,body,#root,main,[data-avatar-overlay-content-frame=\"true\"]{background:transparent!important;background-color:transparent!important;}[data-codex-window-type=\"electron\"].electron-opaque,[data-codex-window-type=\"electron\"].electron-opaque body{background:transparent!important;background-color:transparent!important;background-image:none!important;}`,{cssOrigin:`author`}),t==null||t.isDestroyed?.()||t.executeJavaScript?.(`try{document.documentElement.style.background=\"transparent\";document.body&&(document.body.style.background=\"transparent\")}catch{}`,!0)}catch{}};t?.on?.(`did-finish-load`,n),n()}catch{}}",
    "codexPetOverlayRestoreFocusableAfterInactiveShow(e){try{let t=setTimeout(()=>{try{e==null||e.isDestroyed?.()||this.window!==e||this.codexPetOverlaySettings().mode===`passive`||e.setFocusable?.(!0)}catch{}},0);try{t.unref?.()}catch{}}catch{}}",
    "codexPetOverlaySyncWindow(e,t=!1){if(process.platform!==`linux`||e==null||e.isDestroyed?.())return;let n=this.codexPetOverlaySettings(),r=n.mode!==`passive`;try{e.setTitle?.(`Codex Pet Overlay`)}catch{}try{e.setFocusable?.(r&&!t)}catch{}try{t&&r&&this.codexPetOverlayRestoreFocusableAfterInactiveShow(e)}catch{}try{e.setSkipTaskbar?.(!!n.skipTaskbar)}catch{}try{e.setAlwaysOnTop?.(!!n.alwaysOnTop)}catch{}try{e.setBackgroundColor?.(`#00000000`)}catch{}try{this.codexPetOverlayInstallTransparentRenderer(e)}catch{}try{e.setOpacity?.(1)}catch{}try{e.setVisibleOnAllWorkspaces?.(!!n.allWorkspaces,{visibleOnFullScreen:!!n.allWorkspaces})}catch{try{e.setVisibleOnAllWorkspaces?.(!!n.allWorkspaces)}catch{}}try{n.alwaysOnTop&&e.moveTop?.()}catch{}try{this.codexPetOverlayScheduleHyprlandHints(e)}catch{}try{this.codexPetOverlayScheduleNiriHints(e)}catch{}}",
    "codexPetOverlayHyprlandSession(){if(process.platform!==`linux`)return!1;let e=[process.env.HYPRLAND_INSTANCE_SIGNATURE,process.env.XDG_CURRENT_DESKTOP,process.env.DESKTOP_SESSION].filter(Boolean).join(`:`).toLowerCase();return e.includes(`hyprland`)}",
    "codexPetOverlayShouldUseHyprland(){return process.platform===`linux`&&this.codexPetOverlaySettings().hyprland===!0&&this.codexPetOverlayHyprlandSession()}",
    "codexPetOverlayHyprctl(e,t){if(this.codexPetOverlayHyprctlUnavailable)return;try{let n=typeof require==`function`?require(`node:child_process`):null;if(typeof n?.execFile!=`function`){this.codexPetOverlayHyprctlUnavailable=!0;return}n.execFile(`hyprctl`,e,{timeout:1200},(e,...n)=>{e?.code===`ENOENT`&&(this.codexPetOverlayHyprctlUnavailable=!0),typeof t==`function`&&t(e,...n)})}catch(e){e?.code===`ENOENT`&&(this.codexPetOverlayHyprctlUnavailable=!0);try{typeof t==`function`&&t(e)}catch{}}}",
    "codexPetOverlayLuaString(e){return String(e).replace(/\\\\/g,`\\\\\\\\`).replaceAll(`\"`,`\\\\\"`)}",
    "codexPetOverlayShouldFallbackHyprctl(e){return e!=null&&e.killed!==!0&&e.signal==null&&e.code!==`ETIMEDOUT`&&e.code!==`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`}",
    "codexPetOverlayHyprlandDispatch(e,t){this.codexPetOverlayHyprctl([`dispatch`,e],e=>{this.codexPetOverlayShouldFallbackHyprctl(e)&&Array.isArray(t)&&this.codexPetOverlayHyprctl([`dispatch`,...t])})}",
    "codexPetOverlayHyprlandSetProp(e,t,n){let r=this.codexPetOverlayLuaString(e),i=this.codexPetOverlayLuaString(t),a=this.codexPetOverlayLuaString(n);this.codexPetOverlayHyprlandDispatch(`hl.dsp.window.set_prop({ prop = \"${i}\", value = \"${a}\", window = \"${r}\" })`,[`setprop`,e,t,String(n)])}",
    "codexPetOverlaySelectHyprlandClient(e,t){if(!Array.isArray(e))return null;let n=this.codexPetOverlayRect(t),r=[];for(let i of e){if(i==null||typeof i.address!=`string`||!/^0x[0-9a-f]{1,16}$/i.test(i.address)||String(i.title??``)!==`Codex Pet Overlay`||i.floating!==!0||!(i.fullscreen===0||i.fullscreen===!1)||Number(i.pid)!==Number(process.pid))continue;let t=i.size,a=i.at;if(!Array.isArray(t)||!Array.isArray(a))continue;let o=Number(t[0]),s=Number(t[1]),c=Number(a[0]),l=Number(a[1]);if(![o,s,c,l].every(Number.isFinite)||o<=0||s<=0)continue;r.push({client:i,sizeScore:n==null?0:Math.abs(o-n.width)+Math.abs(s-n.height),positionScore:n==null?0:Math.abs(c-n.x)+Math.abs(l-n.y),area:o*s})}if(n!=null){let e=r.filter(e=>e.sizeScore<=16);if(e.length===1)return e[0].client;let t=e.filter(e=>e.positionScore<=80);return t.length===1?t[0].client:null}let i=r.filter(e=>e.area<=300000);return i.length===1?i[0].client:null}",
    "codexPetOverlayFindHyprlandClient(e,t){if(!this.codexPetOverlayShouldUseHyprland())return;let n=this.codexPetOverlayWindowBounds(e);this.codexPetOverlayHyprctl([`clients`,`-j`],(e,r)=>{if(e)return;let i;try{i=JSON.parse(String(r??``))}catch{return}let a=this.codexPetOverlaySelectHyprlandClient(i,n);a!=null&&typeof t==`function`&&t(a)})}",
    "codexPetOverlayApplyHyprlandHints(e){let t=this.codexPetOverlaySettings();if(process.platform!==`linux`||e==null||e.isDestroyed?.()||!this.codexPetOverlayShouldUseHyprland())return;this.codexPetOverlayFindHyprlandClient(e,n=>{if(e.isDestroyed?.()||this.window!==e)return;let r=`address:${n.address}`,i=this.codexPetOverlayDesiredWindowBounds,a=Number(i?.x),o=Number(i?.y),s=Math.round(a),c=Math.round(o);t.lockPosition&&[a,o].every(Number.isFinite)&&this.codexPetOverlayHyprlandDispatch(`hl.dsp.window.move({ window = \"${r}\", x = ${s}, y = ${c} })`,[`movewindowpixel`,`exact ${s} ${c},${r}`]);t.allWorkspaces&&n.pinned!==!0&&this.codexPetOverlayHyprlandDispatch(`hl.dsp.window.pin({ action = \"on\", window = \"${r}\" })`,[`pin`,r]);this.codexPetOverlayHyprlandSetProp(r,`decorate`,`0`);this.codexPetOverlayHyprlandSetProp(r,`no_shadow`,`1`);this.codexPetOverlayHyprlandSetProp(r,`no_blur`,`1`);this.codexPetOverlayHyprlandSetProp(r,`no_anim`,`1`);this.codexPetOverlayHyprlandSetProp(r,`border_size`,`0`);this.codexPetOverlayHyprlandSetProp(r,`rounding`,`0`);this.codexPetOverlayHyprlandSetProp(r,`opacity`,`1.0 override 1.0 override 1.0 override`);this.codexPetOverlayHyprlandSetProp(r,`opaque`,`0`);this.codexPetOverlayHyprlandSetProp(r,`force_rgbx`,`0`);t.alwaysOnTop&&this.codexPetOverlayHyprlandDispatch(`hl.dsp.window.alter_zorder({ mode = \"top\", window = \"${r}\" })`,[`alterzorder`,`top,${r}`])})}",
    "codexPetOverlayScheduleHyprlandHints(e){if(!this.codexPetOverlayShouldUseHyprland())return;try{this.codexPetOverlayHyprlandTimers?.forEach(clearTimeout)}catch{}this.codexPetOverlayHyprlandTimers=[0,80,300,1000,2500,5000,10000].map(t=>{let n=setTimeout(()=>{try{e==null||e.isDestroyed?.()||this.codexPetOverlayApplyHyprlandHints(e)}catch{}},t);try{n.unref?.()}catch{}return n})}",
    "codexPetOverlayNiriSession(){if(process.platform!==`linux`)return!1;let e=[process.env.NIRI_SOCKET,process.env.XDG_CURRENT_DESKTOP,process.env.DESKTOP_SESSION].filter(Boolean).join(`:`).toLowerCase();return e.includes(`niri`)}",
    "codexPetOverlayShouldUseNiri(){return process.platform===`linux`&&this.codexPetOverlaySettings().niri===!0&&this.codexPetOverlayNiriSession()}",
    "codexPetOverlayFinishNiriProcess(){this.codexPetOverlayNiriProcessCount=Math.max(0,(this.codexPetOverlayNiriProcessCount??1)-1);if(this.codexPetOverlayNiriProcessCount===0){let e=this.codexPetOverlayNiriDragState;if(e!=null)this.codexPetOverlayPumpNiriDrag(e);else{let e=this.codexPetOverlayNiriPendingHintsWindow;this.codexPetOverlayNiriPendingHintsWindow=null;try{e!=null&&!e.isDestroyed?.()&&this.window===e&&this.codexPetOverlayScheduleNiriHints(e)}catch{}}}}",
    "codexPetOverlayNiri(e,t){if(this.codexPetOverlayNiriUnavailable){try{typeof t==`function`&&t({code:`ENOENT`})}catch{}return}let n=!1;try{let r=typeof require==`function`?require(`node:child_process`):null;if(typeof r?.execFile!=`function`){this.codexPetOverlayNiriUnavailable=!0;try{typeof t==`function`&&t({code:`ENOENT`})}catch{}return}this.codexPetOverlayNiriProcessCount=(this.codexPetOverlayNiriProcessCount??0)+1,n=!0,r.execFile(`niri`,[`msg`,...e],{timeout:1200},(e,...n)=>{e?.code===`ENOENT`&&(this.codexPetOverlayNiriUnavailable=!0);try{typeof t==`function`&&t(e,...n)}finally{this.codexPetOverlayFinishNiriProcess()}})}catch(e){e?.code===`ENOENT`&&(this.codexPetOverlayNiriUnavailable=!0),n&&this.codexPetOverlayFinishNiriProcess();try{typeof t==`function`&&t(e)}catch{}}}",
    "codexPetOverlayNiriWindowSize(e){let t=e?.layout?.window_size??e?.layout?.windowSize??e?.window_size??e?.size;if(!Array.isArray(t))return null;let n=Number(t[0]),r=Number(t[1]);return[n,r].every(Number.isFinite)&&n>0&&r>0?{width:n,height:r}:null}",
    "codexPetOverlayNiriPositiveInteger(e){return typeof e==`number`&&Number.isSafeInteger(e)&&e>0?e:null}",
    "codexPetOverlayNiriLocalMove(){let e=this.codexPetOverlayRect(this.codexPetOverlayDesiredWindowBounds),t=this.codexPetOverlayRect(this.codexPetOverlayDesiredDisplayBounds);if(e==null||t==null)return null;let n=e.x-t.x,r=e.y-t.y;return[n,r].every(Number.isFinite)?{x:Math.round(n),y:Math.round(r)}:null}",
    "codexPetOverlaySelectNiriWindow(e,t){if(!Array.isArray(e))return null;let n=this.codexPetOverlayRect(t),r=[];for(let i of e){let e=this.codexPetOverlayNiriPositiveInteger(i?.id),t=this.codexPetOverlayNiriPositiveInteger(i?.pid);if(e==null||t!==process.pid||String(i?.title??``)!==`Codex Pet Overlay`)continue;if(i.is_floating!=null&&typeof i.is_floating!=`boolean`)continue;let a=this.codexPetOverlayNiriWindowSize(i),o=a==null?0:Math.abs(a.width-Number(n?.width??a.width))+Math.abs(a.height-Number(n?.height??a.height)),s=a==null?0:a.width*a.height;r.push({window:i,id:e,sizeScore:o,area:s})}if(n!=null){let e=r.filter(e=>e.sizeScore<=16);return e.length===1?e[0].window:null}let i=r.filter(e=>e.area>0&&e.area<=300000);return i.length===1?i[0].window:r.length===1?r[0].window:null}",
    "codexPetOverlayFindNiriWindow(e,t){if(!this.codexPetOverlayShouldUseNiri()){try{typeof t==`function`&&t({code:`DISABLED`})}catch{}return}let n=this.codexPetOverlayWindowBounds(e);this.codexPetOverlayNiri([`--json`,`windows`],(e,r)=>{if(e){try{typeof t==`function`&&t(e)}catch{}return}let i;try{i=JSON.parse(String(r??``))}catch{try{typeof t==`function`&&t({code:`INVALID_JSON`})}catch{}return}let a=this.codexPetOverlaySelectNiriWindow(i,n);try{typeof t==`function`&&t(null,a)}catch{}})}",
    "codexPetOverlayApplyNiriHints(e,t=this.codexPetOverlayNiriEpoch){if(process.platform!==`linux`||e==null||e.isDestroyed?.()||!this.codexPetOverlayShouldUseNiri()||this.codexPetOverlayNiriDragState!=null||this.codexPetOverlayNiriDragCallOwner!=null)return;this.codexPetOverlayFindNiriWindow(e,(n,r)=>{if(n||e.isDestroyed?.()||this.window!==e||t!==this.codexPetOverlayNiriEpoch||this.codexPetOverlayNiriDragState!=null||this.codexPetOverlayNiriDragCallOwner!=null)return;let i=this.codexPetOverlayNiriPositiveInteger(r?.id);if(i==null)return;let a=()=>{if(e.isDestroyed?.()||this.window!==e||t!==this.codexPetOverlayNiriEpoch||this.codexPetOverlayNiriDragState!=null||this.codexPetOverlayNiriDragCallOwner!=null)return;let n=this.codexPetOverlayNiriLocalMove();n!=null&&this.codexPetOverlayNiri([`action`,`move-floating-window`,`--id`,String(i),`-x`,String(n.x),`-y`,String(n.y)])};r.is_floating===!0?a():this.codexPetOverlayNiri([`action`,`move-window-to-floating`,`--id`,String(i)],n=>{n||a()})})}",
    "codexPetOverlayScheduleNiriHints(e){let t=this.codexPetOverlayNiriDragState;if(t!=null&&(this.window!==t.window||t.window?.isDestroyed?.())){try{t.retryTimer!=null&&clearTimeout(t.retryTimer)}catch{}this.codexPetOverlayNiriDragState=null,this.codexPetOverlayNiriEpoch=(this.codexPetOverlayNiriEpoch??0)+1}if(this.codexPetOverlayNiriUnavailable||!this.codexPetOverlayShouldUseNiri()||this.dragState!=null||this.codexPetOverlayNiriDragState!=null)return;if(this.codexPetOverlayNiriDragCallOwner!=null||(this.codexPetOverlayNiriProcessCount??0)>0){this.codexPetOverlayNiriPendingHintsWindow=e;return}this.codexPetOverlayNiriPendingHintsWindow=null;try{this.codexPetOverlayNiriTimers?.forEach(clearTimeout)}catch{}let n=(this.codexPetOverlayNiriEpoch??0)+1;this.codexPetOverlayNiriEpoch=n,this.codexPetOverlayNiriTimers=[0,80,300,1000].map(t=>{let r=setTimeout(()=>{try{e==null||e.isDestroyed?.()||this.codexPetOverlayApplyNiriHints(e,n)}catch{}},t);try{r.unref?.()}catch{}return r})}",
    "codexPetOverlayBeginNiriDrag(e){if(e==null||e.isDestroyed?.()||this.window!==e||!this.codexPetOverlayShouldUseNiri())return;try{this.codexPetOverlayNiriTimers?.forEach(clearTimeout),this.codexPetOverlayNiriDragState?.retryTimer!=null&&clearTimeout(this.codexPetOverlayNiriDragState.retryTimer)}catch{}this.codexPetOverlayNiriEpoch=(this.codexPetOverlayNiriEpoch??0)+1;let t=(this.codexPetOverlayNiriDragGeneration??0)+1;this.codexPetOverlayNiriDragGeneration=t;let n=this.codexPetOverlayNiriLocalMove();this.codexPetOverlayNiriDragState={generation:t,window:e,id:null,floating:!1,latestTarget:n==null?null:{x:n.x,y:n.y},inFlight:!1,released:!1,persisted:!1,complete:null,retryIndex:0,retryTimer:null},this.codexPetOverlayPumpNiriDrag(this.codexPetOverlayNiriDragState)}",
    "codexPetOverlayNiriDragCurrent(e){if(e==null||this.codexPetOverlayNiriDragState!==e||this.codexPetOverlayNiriDragGeneration!==e.generation)return!1;if(this.window===e.window&&!e.window?.isDestroyed?.())return!0;try{e.retryTimer!=null&&clearTimeout(e.retryTimer)}catch{}this.codexPetOverlayNiriDragState=null,this.codexPetOverlayNiriEpoch=(this.codexPetOverlayNiriEpoch??0)+1;let t=this.window;try{t!=null&&!t.isDestroyed?.()&&this.codexPetOverlayScheduleNiriHints(t)}catch{}return!1}",
    "codexPetOverlayStartNiriDragCall(e){if(this.codexPetOverlayNiriDragCallOwner!=null)return!1;e.inFlight=!0,this.codexPetOverlayNiriDragCallOwner=e;return!0}",
    "codexPetOverlayFinishNiriDragCall(e){e.inFlight=!1,this.codexPetOverlayNiriDragCallOwner===e&&(this.codexPetOverlayNiriDragCallOwner=null);let t=this.codexPetOverlayNiriDragState;if(t!=null&&t!==e)this.codexPetOverlayPumpNiriDrag(t);else if(t==null){let e=this.window;try{e!=null&&!e.isDestroyed?.()&&this.codexPetOverlayScheduleNiriHints(e)}catch{}}}",
    "codexPetOverlayQueueNiriDrag(e){let t=this.codexPetOverlayNiriDragState;if(!this.codexPetOverlayNiriDragCurrent(t)||t.window!==e)return;let n=this.codexPetOverlayNiriLocalMove();n!=null&&(t.latestTarget={x:n.x,y:n.y}),this.codexPetOverlayPumpNiriDrag(t)}",
    "codexPetOverlayRetryNiriDrag(e,t){if(!this.codexPetOverlayNiriDragCurrent(e))return;if(t?.code===`ENOENT`){this.codexPetOverlayAbortNiriDrag(e);return}if(e.retryIndex>=3){this.codexPetOverlayAbortNiriDrag(e);return}let n=[0,80,300][e.retryIndex]??300;e.retryTimer=setTimeout(()=>{e.retryTimer=null,this.codexPetOverlayNiriDragCurrent(e)&&this.codexPetOverlayPumpNiriDrag(e)},n);try{e.retryTimer.unref?.()}catch{}}",
    "codexPetOverlayAbortNiriDrag(e){if(!this.codexPetOverlayNiriDragCurrent(e))return;try{e.retryTimer!=null&&clearTimeout(e.retryTimer)}catch{}e.inFlight=!1,e.retryTimer=null,e.released?this.codexPetOverlayFinalizeNiriDrag(e):this.codexPetOverlayNiriDragState=null}",
    "codexPetOverlayFinalizeNiriDrag(e){if(!this.codexPetOverlayNiriDragCurrent(e)||!e.released||e.persisted)return;e.persisted=!0;let t=e.complete;this.codexPetOverlayNiriDragState=null;try{typeof t==`function`&&t()}catch{}}",
    "codexPetOverlayPumpNiriDrag(e){if(!this.codexPetOverlayNiriDragCurrent(e)||e.inFlight||e.retryTimer!=null||this.codexPetOverlayNiriDragCallOwner!=null||(this.codexPetOverlayNiriProcessCount??0)>0)return;if(e.id==null){if(e.retryIndex>=3){this.codexPetOverlayAbortNiriDrag(e);return}e.retryIndex+=1;if(!this.codexPetOverlayStartNiriDragCall(e))return;this.codexPetOverlayFindNiriWindow(e.window,(t,n)=>{this.codexPetOverlayFinishNiriDragCall(e);if(!this.codexPetOverlayNiriDragCurrent(e))return;let r=this.codexPetOverlayNiriPositiveInteger(n?.id);if(t||r==null){this.codexPetOverlayRetryNiriDrag(e,t);return}e.id=r,e.floating=n.is_floating===!0,this.codexPetOverlayPumpNiriDrag(e)});return}if(!e.floating){if(!this.codexPetOverlayStartNiriDragCall(e))return;let t=e.id;this.codexPetOverlayNiri([`action`,`move-window-to-floating`,`--id`,String(t)],n=>{this.codexPetOverlayFinishNiriDragCall(e);if(!this.codexPetOverlayNiriDragCurrent(e))return;if(n){e.id=null,e.floating=!1,this.codexPetOverlayRetryNiriDrag(e,n);return}e.floating=!0,this.codexPetOverlayPumpNiriDrag(e)});return}let t=e.latestTarget;if(t!=null){e.latestTarget=null;if(!this.codexPetOverlayStartNiriDragCall(e)){e.latestTarget=t;return}let n=e.id;this.codexPetOverlayNiri([`action`,`move-floating-window`,`--id`,String(n),`-x`,String(t.x),`-y`,String(t.y)],n=>{this.codexPetOverlayFinishNiriDragCall(e);if(!this.codexPetOverlayNiriDragCurrent(e))return;if(n){e.latestTarget??=t,e.id=null,e.floating=!1,this.codexPetOverlayRetryNiriDrag(e,n);return}this.codexPetOverlayPumpNiriDrag(e)});return}e.released&&this.codexPetOverlayFinalizeNiriDrag(e)}",
    "codexPetOverlayEndNiriDrag(e,t){let n=this.codexPetOverlayNiriDragState;if(!this.codexPetOverlayNiriDragCurrent(n)||n.window!==e)return!1;n.released=!0,n.complete=t;let r=this.codexPetOverlayNiriLocalMove();r!=null&&(n.latestTarget={x:r.x,y:r.y}),this.codexPetOverlayPumpNiriDrag(n);return!0}",
    "codexPetOverlayShouldLockPosition(){return process.platform===`linux`&&this.codexPetOverlaySettings().lockPosition===!0}",
  ].join("");
}

function patchCreateWindowTitle(source) {
  if (source.includes("title:`Codex Pet Overlay`,width:")) {
    return source;
  }
  const method = findAvatarOverlayMethod(source, /async createWindow\([^)]*\)\{/);
  if (method == null) {
    console.warn("WARN: Could not find avatar overlay createWindow - skipping pet overlay title patch");
    return source;
  }
  const replacement = method.text.replace(
    /title:[A-Za-z_$][\w$]*\.app\.getName\(\),width:/,
    "title:`Codex Pet Overlay`,width:",
  );
  if (replacement === method.text) {
    console.warn("WARN: Could not identify avatar overlay title option - skipping pet overlay title patch");
    return source;
  }
  return replaceMethodText(source, method, replacement);
}

function ensurePetOverlayMethods(source, settings) {
  if (source.includes("codexPetOverlaySettings(){")) {
    return source;
  }
  const insertionPoint =
    findAvatarOverlayMethod(source, /(?<![\w$.])applyLayout\([^{}]*\)\{/) ??
    findAvatarOverlayMethod(source, /showWindow\([A-Za-z_$][\w$]*\)\{/) ??
    findAvatarOverlayMethod(source, /startDrag\([^)]*\)\{/);
  if (insertionPoint == null) {
    console.warn("WARN: Could not find avatar overlay insertion point - skipping pet overlay patch");
    return source;
  }
  return source.slice(0, insertionPoint.start) +
    buildPetOverlayMethods(settings) +
    source.slice(insertionPoint.start);
}

function patchNiriDragLifecycle(source) {
  let patched = source;
  const startMethod = findAvatarOverlayMethod(patched, /startDrag\([^)]*\)\{/);
  if (startMethod == null) {
    console.warn("WARN: Could not find avatar overlay startDrag for Niri transport - skipping pet overlay patch");
    return patched;
  }
  if (!startMethod.text.includes("codexPetOverlayBeginNiriDrag(")) {
    const windowMatch = startMethod.text.match(/let ([A-Za-z_$][\w$]*)=this\.window;/);
    if (windowMatch == null || !startMethod.text.includes("this.dragState=")) {
      console.warn("WARN: Could not identify current avatar overlay drag start shape - skipping Niri transport hook");
      return patched;
    }
    patched = replaceMethodText(
      patched,
      startMethod,
      `${startMethod.text.slice(0, -1)},this.codexPetOverlayBeginNiriDrag(${windowMatch[1]})}`,
    );
  }

  const endMethod = findAvatarOverlayMethod(patched, /endDrag\([^)]*\)\{/);
  if (endMethod == null) {
    console.warn("WARN: Could not find avatar overlay endDrag for Niri transport - skipping pet overlay patch");
    return patched;
  }
  if (endMethod.text.includes("codexPetOverlayEndNiriDrag(")) {
    return patched;
  }
  const completionPattern = /([A-Za-z_$][\w$]*)\?this\.persistWindowBounds\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*\?\?this\.getCurrentDisplay\(\))\):this\.reclampWindowToVisibleDisplay\(\{shouldPersist:!0\}\);let ([A-Za-z_$][\w$]*)=this\.dockTarget;\4!=null&&this\.dockPresentation\(\4\.anchor,\4\.onDock\)/;
  const completionMatch = endMethod.text.match(completionPattern);
  if (completionMatch == null) {
    console.warn("WARN: Could not identify current avatar overlay drag completion shape - skipping Niri transport hook");
    return patched;
  }
  const [completionNeedle, , windowVar] = completionMatch;
  return replaceMethodText(
    patched,
    endMethod,
    endMethod.text.replace(
      completionNeedle,
      `this.codexPetOverlayEndNiriDrag(${windowVar},()=>{${completionNeedle}})||(()=>{${completionNeedle}})()`,
    ),
  );
}

function patchApplyLayout(source) {
  if (
    source.includes("=this.codexPetOverlayLayoutForDisplay(") ||
    /let [A-Za-z_$][\w$]*=this\.codexPetOverlayLayoutForDisplay\(/.test(source)
  ) {
    return source;
  }

  const method = findAvatarOverlayMethod(source, /(?<![\w$.])applyLayout\([^{}]*\)\{/);
  if (method == null) {
    console.warn("WARN: Could not find avatar overlay applyLayout - skipping pet overlay layout patch");
    return source;
  }
  if (method.text.includes("codexPetOverlayLayoutForDisplay(")) {
    return source;
  }

  const windowArg = firstMethodArgument(method.text, "applyLayout", 0) ?? "null";
  const currentLayoutMatch = method.text.match(/let ([A-Za-z_$][\w$]*)=this\.getLayoutForDisplay\(([A-Za-z_$][\w$]*)\);/);
  if (currentLayoutMatch != null) {
    const [needle, layoutVar, displayArg] = currentLayoutMatch;
    const replacement = `let ${layoutVar}=this.codexPetOverlayLayoutForDisplay(${displayArg},this.getLayoutForDisplay(${displayArg}),${windowArg});`;
    return replaceMethodText(source, method, method.text.replace(needle, replacement));
  }

  console.warn("WARN: Could not identify avatar overlay layout variable - skipping pet overlay layout patch");
  return source;
}

function patchShowWindow(source) {
  if (source.includes("codexPetOverlaySyncWindow(")) {
    return source;
  }
  const method = findAvatarOverlayMethod(source, /showWindow\(([A-Za-z_$][\w$]*)\)\{/);
  if (method == null) {
    console.warn("WARN: Could not find avatar overlay showWindow - skipping pet overlay window sync");
    return source;
  }
  if (method.text.includes("codexPetOverlaySyncWindow")) {
    return source;
  }
  const windowArg = method.match[1];
  const needle = `${windowArg}.moveTop(),${windowArg}.showInactive(),`;
  if (!method.text.includes(needle)) {
    console.warn("WARN: Could not identify avatar overlay showWindow display point - skipping pet overlay window sync");
    return source;
  }
  const replacement = `process.platform===\`linux\`?this.codexPetOverlaySyncWindow(${windowArg},!0):${windowArg}.moveTop(),${windowArg}.showInactive(),`;
  return replaceMethodText(source, method, method.text.replace(needle, replacement));
}

function patchLockedDrag(source) {
  if (source.includes("if(this.codexPetOverlayShouldLockPosition())return;")) {
    return source;
  }
  const method = findAvatarOverlayMethod(source, /startDrag\([^)]*\)\{/);
  if (method == null) {
    console.warn("WARN: Could not find avatar overlay startDrag - skipping pet drag lock");
    return source;
  }
  return replaceMethodText(
    source,
    method,
    method.text.slice(0, method.match[0].length) +
      "if(this.codexPetOverlayShouldLockPosition())return;" +
      method.text.slice(method.match[0].length),
  );
}

function patchPassiveCreateWindow(source, settings) {
  if (settings.mode !== "passive") {
    return source;
  }
  return source
    .split("appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:process.platform===`linux`?!0:!1")
    .join("appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:!1");
}

function patchAvatarSelectionRefresh(source) {
  if (source.includes(`function ${AVATAR_SELECTION_REFRESH_MARKER}(`)) {
    return source;
  }

  const handlerRegex = /"set-setting":async\(\{key:([A-Za-z_$][\w$]*),value:([A-Za-z_$][\w$]*)\}\)=>\(this\.setSettingValue\(\1,\2\),\{success:!0\}\)/;
  const match = source.match(handlerRegex);
  if (match == null) {
    console.warn("WARN: Could not find desktop set-setting handler - skipping pet selection refresh");
    return source;
  }

  const [handler, keyVar, valueVar] = match;
  const helper = `function ${AVATAR_SELECTION_REFRESH_MARKER}(){try{setTimeout(()=>{for(let e of require(\`electron\`).BrowserWindow.getAllWindows()){if(e?.isDestroyed?.()||String(e?.getTitle?.()??\`\`)!==\`Codex Pet Overlay\`)continue;let t=e.webContents;t==null||t.isDestroyed?.()||t.reload?.()}},0)}catch{}}`;
  const replacement = `"set-setting":async({key:${keyVar},value:${valueVar}})=>(this.setSettingValue(${keyVar},${valueVar}),${keyVar}===\`selected-avatar-id\`&&${AVATAR_SELECTION_REFRESH_MARKER}(),{success:!0})`;
  return helper + source.replace(handler, replacement);
}

function hasCompletePetOverlayPatch(source, settings, avatarSelectionRefreshExpected) {
  const requiredMarkers = [
    source.includes("codexPetOverlaySettings(){"),
    /let [A-Za-z_$][\w$]*=this\.codexPetOverlayLayoutForDisplay\([A-Za-z_$][\w$]*,this\.getLayoutForDisplay\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\);/.test(source),
    /process\.platform===`linux`\?this\.codexPetOverlaySyncWindow\([A-Za-z_$][\w$]*,!0\):[A-Za-z_$][\w$]*\.moveTop\(\),[A-Za-z_$][\w$]*\.showInactive\(\),/.test(source),
    source.includes("if(this.codexPetOverlayShouldLockPosition())return;"),
    source.includes("this.codexPetOverlayBeginNiriDrag("),
    source.includes("this.codexPetOverlayEndNiriDrag("),
    source.includes("===`avatarOverlay`?{backgroundColor:`#00000000`,backgroundMaterial:null}:"),
    source.includes("title:`Codex Pet Overlay`,width:"),
  ];
  if (avatarSelectionRefreshExpected) {
    requiredMarkers.push(
      source.includes(`function ${AVATAR_SELECTION_REFRESH_MARKER}(`),
      source.includes("===`selected-avatar-id`&&codexPetOverlayRefreshAvatarWindows()"),
    );
  }
  if (settings.mode === "passive") {
    requiredMarkers.push(
      source.includes("appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:!1"),
    );
  }
  return requiredMarkers.every(Boolean);
}

function patchAvatarTransparentBackground(source) {
  if (source.includes("===`avatarOverlay`?{backgroundColor:`#00000000`,backgroundMaterial:null}:")) {
    return source;
  }
  const backgroundFunctionRegex =
    /function\s+([A-Za-z_$][\w$]*)\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowSurfaceEnabled:([A-Za-z_$][\w$]*),prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s+/;
  const match = source.match(backgroundFunctionRegex);
  if (match == null) {
    if (source.includes("opaqueWindowSurfaceEnabled") && source.includes("backgroundColor")) {
      console.warn("WARN: Could not find avatar overlay background function - skipping transparent pet background guard");
    }
    return source;
  }
  const appearanceParam = match[3];
  return source.slice(0, match.index) +
    `${match[0]}${appearanceParam}===\`avatarOverlay\`?{backgroundColor:\`#00000000\`,backgroundMaterial:null}:` +
    source.slice(match.index + match[0].length);
}

function applyPetOverlayPatch(source, context) {
  if (!source.includes("avatar-overlay") && !source.includes("avatarOverlay")) {
    console.warn("WARN: Avatar overlay markers not found - skipping pet overlay patch");
    return source;
  }
  const settings = mergedPetOverlaySettings(context);
  const avatarSelectionRefreshExpected = source.includes('"set-setting":async');
  let patched = patchAvatarTransparentBackground(source);
  patched = patchCreateWindowTitle(patched);
  patched = patchApplyLayout(patched);
  patched = patchShowWindow(patched);
  patched = patchLockedDrag(patched);
  patched = patchNiriDragLifecycle(patched);
  patched = ensurePetOverlayMethods(patched, settings);
  patched = patchPassiveCreateWindow(patched, settings);
  if (avatarSelectionRefreshExpected) {
    patched = patchAvatarSelectionRefresh(patched);
  }
  if (!hasCompletePetOverlayPatch(patched, settings, avatarSelectionRefreshExpected)) {
    console.warn("WARN: Pet overlay patch is incomplete - discarding all pet overlay changes");
    return source;
  }
  return patched;
}

const descriptors = [
  {
    id: DESCRIPTOR_ID,
    phase: "main-bundle",
    order: 20_500,
    ciPolicy: "optional",
    apply: applyPetOverlayPatch,
  },
];

module.exports = {
  DESCRIPTOR_ID,
  descriptors,
  applyPetOverlayPatch,
  mergedPetOverlaySettings,
};
