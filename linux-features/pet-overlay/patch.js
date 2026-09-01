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
    kwin: booleanSetting(overrides.kwin, booleanSetting(defaults.kwin, true)),
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
    `codexPetOverlaySettings(){let e={margin:${settings.margin},gravity:\`${settings.gravity}\`,allWorkspaces:${boolLiteral(settings.allWorkspaces)},alwaysOnTop:${boolLiteral(settings.alwaysOnTop)},skipTaskbar:${boolLiteral(settings.skipTaskbar)},lockPosition:${boolLiteral(settings.lockPosition)},mode:\`${settings.mode}\`,hyprland:${boolLiteral(settings.hyprland)},kwin:${boolLiteral(settings.kwin)},niri:${boolLiteral(settings.niri)}};try{let t=process.env.CODEX_PET_OVERLAY_MARGIN??process.env.CODEX_PET_LINUX_MARGIN,n=Number(t);Number.isFinite(n)&&(e.margin=Math.max(0,Math.min(512,Math.round(n))));let r=process.env.CODEX_PET_OVERLAY_GRAVITY??process.env.CODEX_PET_LINUX_GRAVITY;[\`bottom-right\`,\`bottom-left\`,\`top-right\`,\`top-left\`].includes(r)&&(e.gravity=r);let i=process.env.CODEX_PET_OVERLAY_MODE??process.env.CODEX_PET_LINUX_MODE;(i===\`interactive\`||i===\`passive\`)&&(e.mode=i);let a=process.env.CODEX_PET_OVERLAY_LOCK_POSITION??process.env.CODEX_PET_LINUX_LOCK_POSITION;a===\`1\`&&(e.lockPosition=!0),a===\`0\`&&(e.lockPosition=!1);let o=process.env.CODEX_PET_OVERLAY_HYPRLAND??process.env.CODEX_PET_LINUX_HYPRLAND;o===\`1\`&&(e.hyprland=!0),o===\`0\`&&(e.hyprland=!1);let s=process.env.CODEX_PET_OVERLAY_KWIN;s===\`1\`&&(e.kwin=!0),s===\`0\`&&(e.kwin=!1);let c=process.env.CODEX_PET_OVERLAY_NIRI;c===\`1\`&&(e.niri=!0),c===\`0\`&&(e.niri=!1)}catch{}return e}`,
    "codexPetOverlayRect(e){if(e==null)return null;let t=Number(e.x),n=Number(e.y),r=Number(e.width),i=Number(e.height);return[t,n,r,i].every(Number.isFinite)&&r>0&&i>0?{x:t,y:n,width:r,height:i}:null}",
    "codexPetOverlayDisplayRect(e){return this.codexPetOverlayRect(e?.workArea??e?.bounds??e)}",
    "codexPetOverlayWindowBounds(e){try{return this.codexPetOverlayRect(e?.getBounds?.()??e?.getContentBounds?.())}catch{return null}}",
    "codexPetOverlayMoved(e,t,n=8){return e!=null&&t!=null&&(Math.abs(Number(e.x)-Number(t.x))>n||Math.abs(Number(e.y)-Number(t.y))>n)}",
    "codexPetOverlayBoundsNearDisplay(e,t,n=64){if(e==null||t==null)return!1;let r=Number(e.x)+Number(e.width)/2,i=Number(e.y)+Number(e.height)/2,a=Number(t.x),o=Number(t.y),s=Number(t.width),c=Number(t.height);return[r,i,a,o,s,c].every(Number.isFinite)&&r>=a-n&&r<=a+s+n&&i>=o-n&&i<=o+c+n}",
    "codexPetOverlayMascotRect(e){let t=e?.mascot;if(t==null)return null;let n=Number(t.left),r=Number(t.top),i=Number(t.width),a=Number(t.height);return[n,r,i,a].every(Number.isFinite)&&i>0&&a>0?{left:n,top:r,width:i,height:a}:null}",
    "codexPetOverlayLayoutAtWindowPosition(e,t){if(e==null||t==null||t.windowBounds==null)return t;let n={...t.windowBounds,x:Math.round(e.x),y:Math.round(e.y)},r=this.codexPetOverlayMascotRect(t),i=r==null?{x:n.x,y:n.y,width:t.anchor?.width??n.width,height:t.anchor?.height??n.height}:{x:n.x+r.left,y:n.y+r.top,width:r.width,height:r.height},a=t.anchor==null?t.anchor:{...t.anchor,x:Math.round(i.x),y:Math.round(i.y),width:t.anchor.width??i.width,height:t.anchor.height??i.height};return{...t,anchor:a,windowBounds:n}}",
    "codexPetOverlayGravityBounds(e,t,n){if(e==null||t==null||t.windowBounds==null)return null;let r={...t.windowBounds},i=this.codexPetOverlayMascotRect(t)??{left:0,top:0,width:Number(r.width),height:Number(r.height)},a=Number(i.left),o=Number(i.top),s=Number(i.width),c=Number(i.height);if(![a,o,s,c].every(Number.isFinite)||s<=0||c<=0)return null;let l=Math.max(0,Math.min(512,Number(n?.margin)||0)),u=String(n?.gravity??`bottom-right`);return r.x=u.endsWith(`left`)?Math.round(e.x+l-a):Math.round(e.x+e.width-l-a-s),r.y=u.startsWith(`top`)?Math.round(e.y+l-o):Math.round(e.y+e.height-l-o-c),r}",
    "codexPetOverlayTrayAboveLeft(e){if(process.platform!==`linux`||e==null||e.windowBounds==null||e.mascot==null||e.tray==null)return e;let t=Number(e.windowBounds.width),n=Number(e.windowBounds.height),r=Number(e.mascot.width),i=Number(e.mascot.height),a=Number(e.tray.width),o=Number(e.tray.height);if(![t,n,r,i,a,o].every(Number.isFinite)||t<=0||n<=0||r<=0||i<=0||a<=0||o<=0)return e;let s=4,c=Math.max(0,Math.min(Math.round(t),Math.round(a))),l=Math.max(0,Math.min(Math.max(0,Math.round(n-i-s)),Math.round(o))),u=this.codexPetOverlayMascotLocalPosition,d=Number(u?.left),p=Number(u?.top),h=[d,p].every(Number.isFinite),m=Math.max(0,Math.min(Math.round(t-r),Math.round(h?d:t-r))),f=Math.max(0,Math.min(Math.round(n-i),Math.round(h?p:n-i))),g=Math.max(0,Math.round(n-i-s-l)),v=Math.max(0,Math.min(Math.round(n-i),Math.round(l+s)));if(g<v&&f>g&&f<v){f=Math.abs(f-g)<=Math.abs(v-f)?g:v,h&&(this.codexPetOverlayMascotLocalPosition={left:m,top:f})}let w=Math.max(0,Math.min(Math.round(t-c),Math.round(m+r-c))),x=f>=l+s?f-l-s:f+i+s;x=Math.max(0,Math.min(Math.round(n-l),Math.round(x)));let y=e.anchor??{x:Number(e.windowBounds.x)+(Number(e.mascot.left)||0),y:Number(e.windowBounds.y)+(Number(e.mascot.top)||0),width:r,height:i},b=h?{...e.windowBounds}:{...e.windowBounds,x:Math.round(Number(y.x)-m),y:Math.round(Number(y.y)-f)},k={...y,x:Math.round(Number(b.x)+m),y:Math.round(Number(b.y)+f),width:y.width??r,height:y.height??i};return{...e,anchor:k,mascot:{...e.mascot,left:m,top:f,width:r,height:i},tray:{...e.tray,left:w,top:x,width:c,height:l},placement:`top-end`,windowBounds:b}}",
    "codexPetOverlayDragFromCurrentRenderer(e){let t=this.window;return!(t==null||t.isDestroyed?.()||t.webContents?.id!==e)}",
    "codexPetOverlayStartLocalMascotDrag(e,t){if(!this.codexPetOverlayDragFromCurrentRenderer(e)||process.platform!==`linux`||this.codexPetOverlayShouldLockPosition())return!1;let n=this.layout,r=this.codexPetOverlayMascotRect(n),i=Number(t?.pointerWindowX),a=Number(t?.pointerWindowY);if(r==null||![i,a].every(Number.isFinite)||i<r.left||a<r.top||i>r.left+r.width||a>r.top+r.height)return!1;return this.codexPetOverlayMascotDragState={offsetX:i-r.left,offsetY:a-r.top},!0}",
    "codexPetOverlayMoveLocalMascotDrag(e,t){if(!this.codexPetOverlayDragFromCurrentRenderer(e))return!1;let n=this.codexPetOverlayMascotDragState,r=this.layout,i=this.window,a=this.codexPetOverlayMascotRect(r),o=this.codexPetOverlayWindowBounds(i);if(n==null||r==null||a==null||o==null)return!1;let s=Number(t?.pointerWindowX),c=Number(t?.pointerWindowY);if(![s,c].every(Number.isFinite)){let e=Number(t?.pointerScreenX),r=Number(t?.pointerScreenY);if(![e,r].every(Number.isFinite))return!0;s=e-o.x,c=r-o.y}let l=Math.max(0,Math.min(Math.round(o.width-a.width),Math.round(s-n.offsetX))),u=Math.max(0,Math.min(Math.round(o.height-a.height),Math.round(c-n.offsetY)));this.codexPetOverlayMascotLocalPosition={left:l,top:u};let d=this.codexPetOverlayTrayAboveLeft({...r,windowBounds:{...r.windowBounds,x:o.x,y:o.y,width:o.width,height:o.height}});this.layout=d;try{this.compositionHost.updateMascotRect?.(d.mascot)}catch{}try{this.sendLayoutToRenderer(i,null)}catch{}return!0}",
    "codexPetOverlayEndLocalMascotDrag(e){return!this.codexPetOverlayDragFromCurrentRenderer(e)||this.codexPetOverlayMascotDragState==null?!1:(this.codexPetOverlayMascotDragState=null,!0)}",
    "codexPetOverlayRememberLayout(e,t){let n=this.codexPetOverlayRect(t);this.codexPetOverlayDesiredDisplayBounds=n==null?null:{x:Math.round(n.x),y:Math.round(n.y),width:Math.round(n.width),height:Math.round(n.height)};let r=this.codexPetOverlayRect(e?.windowBounds);if(r!=null){let i={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},a=this.codexPetOverlayDesiredWindowBounds,o=a==null||a.x!==i.x||a.y!==i.y||a.width!==i.width||a.height!==i.height;this.codexPetOverlayDesiredWindowBounds=i;if(o&&this.window!=null){let e=this.codexPetOverlaySettings();try{e.lockPosition===!0&&this.codexPetOverlayScheduleHyprlandHints(this.window)}catch{}try{this.dragState!=null?this.codexPetOverlayQueueKWinDrag(this.window):this.codexPetOverlayScheduleKWinHints(this.window)}catch{}try{this.dragState!=null?this.codexPetOverlayQueueNiriDrag(this.window):this.codexPetOverlayScheduleNiriHints(this.window)}catch{}}}return e}",
    "codexPetOverlayLayoutForDisplay(e,t,n){if(process.platform!==`linux`||t==null||t.windowBounds==null)return this.codexPetOverlayRememberLayout(this.codexPetOverlayTrayAboveLeft(t));let r=this.codexPetOverlayDisplayRect(e),i=this.codexPetOverlaySettings(),a=t;if(i.lockPosition===!0&&r!=null){let e=this.codexPetOverlayGravityBounds(r,a,i);e!=null&&(a=this.codexPetOverlayLayoutAtWindowPosition(e,a))}else if(this.dragState==null){let e=this.codexPetOverlayWindowBounds(n),o=!1;try{o=n?.isVisible?.()===!0}catch{}e!=null&&r!=null&&this.codexPetOverlayBoundsNearDisplay(e,r)&&(o||this.codexPetOverlayInitialPositionDone===!0||this.codexPetOverlayManualPosition===!0)?(this.codexPetOverlayInitialPositionDone=!0,this.codexPetOverlayMoved(e,a.windowBounds)&&(this.codexPetOverlayManualPosition=!0),a=this.codexPetOverlayLayoutAtWindowPosition(e,a)):this.codexPetOverlayInitialPositionDone=!0}return this.codexPetOverlayRememberLayout(this.codexPetOverlayTrayAboveLeft(a),r)}",
    "codexPetOverlayShouldUseWholeWindowInput(){return process.platform===`linux`&&this.codexPetOverlaySettings().lockPosition!==!0}",
    "codexPetOverlayInstallTransparentRenderer(e){try{this.codexLinuxWholeWindowInput=this.codexPetOverlayShouldUseWholeWindowInput();if(e.__codexPetOverlayTransparentRendererInstalled)return;e.__codexPetOverlayTransparentRendererInstalled=!0;let t=e.webContents,n=()=>{try{let n=`html,body,#root,main,[data-avatar-overlay-content-frame=\"true\"]{background:transparent!important;background-color:transparent!important;}[data-codex-window-type=\"electron\"].electron-opaque,[data-codex-window-type=\"electron\"].electron-opaque body{background:transparent!important;background-color:transparent!important;background-image:none!important;}`;this.codexLinuxWholeWindowInput=this.codexPetOverlayShouldUseWholeWindowInput(),this.codexLinuxWholeWindowInput&&(n+=`html,body,#root,main,[data-avatar-overlay-content-frame=\"true\"]{-webkit-app-region:drag!important;app-region:drag!important;user-select:none!important;-webkit-user-select:none!important;}[data-avatar-overlay-hit-region=\"mascot\"],[data-avatar-mascot=\"true\"],.no-drag,[data-avatar-overlay-hit-region=\"notification-tray\"],[data-avatar-overlay-hit-region=\"notification-scroll-control\"]{-webkit-app-region:no-drag!important;app-region:no-drag!important;}`),t==null||t.isDestroyed?.()||t.insertCSS?.(n,{cssOrigin:`author`}),t==null||t.isDestroyed?.()||t.executeJavaScript?.(`try{document.documentElement.style.background=\"transparent\";document.body&&(document.body.style.background=\"transparent\")}catch{}`,!0)}catch{}};t?.on?.(`did-finish-load`,n),n()}catch{}}",
    "codexPetOverlayRestoreFocusableAfterInactiveShow(e){try{let t=setTimeout(()=>{try{e==null||e.isDestroyed?.()||this.window!==e||this.codexPetOverlaySettings().mode===`passive`||e.setFocusable?.(!0)}catch{}},0);try{t.unref?.()}catch{}}catch{}}",
    "codexPetOverlaySyncWindow(e,t=!1){if(process.platform!==`linux`||e==null||e.isDestroyed?.())return;this.codexLinuxWholeWindowInput=this.codexPetOverlayShouldUseWholeWindowInput();let n=this.codexPetOverlaySettings(),r=n.mode!==`passive`;try{e.setTitle?.(`Codex Pet Overlay`)}catch{}try{e.setFocusable?.(r&&!t)}catch{}try{t&&r&&this.codexPetOverlayRestoreFocusableAfterInactiveShow(e)}catch{}try{e.setSkipTaskbar?.(!!n.skipTaskbar)}catch{}try{e.setAlwaysOnTop?.(!!n.alwaysOnTop)}catch{}try{e.setBackgroundColor?.(`#00000000`)}catch{}try{this.codexPetOverlayInstallTransparentRenderer(e)}catch{}try{e.setOpacity?.(1)}catch{}try{e.setVisibleOnAllWorkspaces?.(!!n.allWorkspaces,{visibleOnFullScreen:!!n.allWorkspaces})}catch{try{e.setVisibleOnAllWorkspaces?.(!!n.allWorkspaces)}catch{}}try{n.alwaysOnTop&&e.moveTop?.()}catch{}try{this.codexPetOverlayScheduleHyprlandHints(e)}catch{}try{this.codexPetOverlayScheduleKWinHints(e)}catch{}try{this.codexPetOverlayScheduleNiriHints(e)}catch{}}",
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
    "codexPetOverlayKWinSession(){if(process.platform!==`linux`)return!1;let e=String(process.env.KDE_FULL_SESSION??``).toLowerCase();if(process.env.KDE_SESSION_VERSION||e===`1`||e===`true`)return!0;let t=[process.env.XDG_CURRENT_DESKTOP,process.env.DESKTOP_SESSION].filter(Boolean).join(`:`).toLowerCase();return t.includes(`kde`)||t.includes(`plasma`)}",
    "codexPetOverlayShouldUseKWin(){return process.platform===`linux`&&this.codexPetOverlaySettings().kwin===!0&&this.codexPetOverlayKWinSession()}",
    "codexPetOverlayKWinQdbus(e,t,n=!1){if(this.codexPetOverlayKWinUnavailable){try{typeof t===`function`&&t({code:`ENOENT`})}catch{}return}let r=e;try{let i=typeof require===`function`?require(`node:child_process`):null;if(typeof i?.execFile!==`function`){this.codexPetOverlayKWinUnavailable=!0;try{typeof t===`function`&&t({code:`ENOENT`})}catch{}return}i.execFile(n?`qdbus`:`qdbus6`,r,{timeout:1500},(e,...i)=>{if(e?.code===`ENOENT`&&!n){this.codexPetOverlayKWinQdbus(r,t,!0);return}e?.code===`ENOENT`&&(this.codexPetOverlayKWinUnavailable=!0);try{typeof t===`function`&&t(e,...i)}catch{}})}catch(e){if(e?.code===`ENOENT`&&!n){this.codexPetOverlayKWinQdbus(r,t,!0);return}e?.code===`ENOENT`&&(this.codexPetOverlayKWinUnavailable=!0);try{typeof t===`function`&&t(e)}catch{}}}",
    "codexPetOverlayKWinScript(e,t){let n=this.codexPetOverlayRect(e),r=this.codexPetOverlaySettings(),i={pid:Number(process.pid),title:`Codex Pet Overlay`,alwaysOnTop:!!r.alwaysOnTop,allWorkspaces:!!r.allWorkspaces,skipTaskbar:!!r.skipTaskbar,move:!!t,x:Math.round(Number(n?.x)),y:Math.round(Number(n?.y)),width:Math.round(Number(n?.width)),height:Math.round(Number(n?.height))};return `(function(){var d=${JSON.stringify(i)};function windows(){try{if(typeof workspace.windowList==='function')return workspace.windowList()}catch(e){}try{if(typeof workspace.clientList==='function')return workspace.clientList()}catch(e){}try{if(workspace.stackingOrder&&typeof workspace.stackingOrder.length==='number')return workspace.stackingOrder}catch(e){}return[]}var a=windows().filter(function(w){try{return String(w.caption||'')===d.title&&Number(w.pid)===d.pid}catch(e){return false}});if(a.length!==1)return;var w=a[0];try{w.keepAbove=d.alwaysOnTop}catch(e){}try{w.skipTaskbar=d.skipTaskbar}catch(e){}try{w.skipPager=d.skipTaskbar}catch(e){}try{w.onAllDesktops=d.allWorkspaces}catch(e){}try{w.noBorder=true}catch(e){}if(d.move&&isFinite(d.x)&&isFinite(d.y)){try{var g=w.frameGeometry;w.frameGeometry={x:d.x,y:d.y,width:isFinite(d.width)&&d.width>0?d.width:g.width,height:isFinite(d.height)&&d.height>0?d.height:g.height}}catch(e){}}if(d.alwaysOnTop){try{if(typeof workspace.raiseWindow==='function')workspace.raiseWindow(w)}catch(e){}}})()`}",
    "codexPetOverlayKWinRun(e,t,n){if(!this.codexPetOverlayShouldUseKWin()){try{typeof n===`function`&&n({code:`DISABLED`})}catch{}return}let r;try{let i=require(`node:fs`),a=require(`node:os`),o=require(`node:path`),s=(this.codexPetOverlayKWinScriptGeneration??0)+1;this.codexPetOverlayKWinScriptGeneration=s;let c=`codex_pet_overlay_${process.pid}_${Date.now()}_${s}`,l=o.join(a.tmpdir(),`${c}.js`);i.writeFileSync(l,this.codexPetOverlayKWinScript(e,t),{encoding:`utf8`,flag:`wx`,mode:384}),r=()=>{try{i.unlinkSync(l)}catch{}};let u=[`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.loadScript`,l,c];this.codexPetOverlayKWinQdbus(u,e=>{if(e){r();try{typeof n===`function`&&n(e)}catch{}return}this.codexPetOverlayKWinQdbus([`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.start`],e=>{this.codexPetOverlayKWinQdbus([`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.unloadScript`,c],()=>{r();try{typeof n===`function`&&n(e)}catch{}})})})}catch(e){try{r?.()}catch{}try{typeof n===`function`&&n(e)}catch{}}}",
    "codexPetOverlayApplyKWinHints(e){if(e==null||e.isDestroyed?.()||this.window!==e||!this.codexPetOverlayShouldUseKWin()||this.dragState!=null||this.codexPetOverlayKWinDragState!=null||this.codexPetOverlayKWinHintInFlight)return;this.codexPetOverlayKWinHintInFlight=!0;let t=this.codexPetOverlaySettings();this.codexPetOverlayKWinRun(this.codexPetOverlayDesiredWindowBounds,t.lockPosition===!0,()=>{this.codexPetOverlayKWinHintInFlight=!1,this.codexPetOverlayKWinDragState==null&&this.window===e&&!e.isDestroyed?.()&&this.codexPetOverlayKWinPendingHints&&(this.codexPetOverlayKWinPendingHints=!1,this.codexPetOverlayScheduleKWinHints(e))})}",
    "codexPetOverlayScheduleKWinHints(e){if(!this.codexPetOverlayShouldUseKWin()||this.dragState!=null||this.codexPetOverlayKWinDragState!=null)return;if(this.codexPetOverlayKWinHintInFlight){this.codexPetOverlayKWinPendingHints=!0;return}this.codexPetOverlayKWinPendingHints=!1;try{this.codexPetOverlayKWinTimers?.forEach(clearTimeout)}catch{}this.codexPetOverlayKWinTimers=[0,80,300,1000,2500].map(t=>{let n=setTimeout(()=>{try{this.codexPetOverlayApplyKWinHints(e)}catch{}},t);try{n.unref?.()}catch{}return n})}",
    "codexPetOverlayKWinExecSync(e){if(this.codexPetOverlayKWinUnavailable||!this.codexPetOverlayShouldUseKWin())return!1;try{let t=typeof require===`function`?require(`node:child_process`):null;if(typeof t?.execFileSync!==`function`)return!1;for(let n of [`qdbus6`,`qdbus`])try{t.execFileSync(n,e,{timeout:750,stdio:`ignore`});return!0}catch(e){if(e?.code!==`ENOENT`)return!1}this.codexPetOverlayKWinUnavailable=!0}catch{}return!1}",
    "codexPetOverlayKWinDragScript(){let e={pid:Number(process.pid),title:`Codex Pet Overlay`};return `(function(){var d=${JSON.stringify(e)};function windows(){try{if(typeof workspace.windowList==='function')return workspace.windowList()}catch(e){}try{if(typeof workspace.clientList==='function')return workspace.clientList()}catch(e){}return[]}var a=windows().filter(function(w){try{return String(w.caption||'')===d.title&&Number(w.pid)===d.pid}catch(e){return false}});if(a.length!==1)return;var w=a[0],p=workspace.cursorPos,g=w.frameGeometry,dx=Number(p.x)-Number(g.x),dy=Number(p.y)-Number(g.y),active=true;function move(){if(!active)return;try{var p=workspace.cursorPos,g=w.frameGeometry;w.frameGeometry={x:Math.round(Number(p.x)-dx),y:Math.round(Number(p.y)-dy),width:g.width,height:g.height}}catch(e){stop()}}function stop(){if(!active)return;active=false;try{workspace.cursorPosChanged.disconnect(move)}catch(e){}}try{workspace.cursorPosChanged.connect(move)}catch(e){return}try{workspace.windowRemoved.connect(function(v){if(v===w)stop()})}catch(e){}try{if(typeof workspace.raiseWindow==='function')workspace.raiseWindow(w)}catch(e){}})()`}",
    "codexPetOverlayReleaseKWinDrag(e){if(e==null)return;try{this.codexPetOverlayKWinExecSync([`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.unloadScript`,e.pluginName])}catch{}try{require(`node:fs`).unlinkSync(e.scriptPath)}catch{}}",
    "codexPetOverlayStartKWinDrag(e){let t;try{let n=require(`node:fs`),r=require(`node:os`),i=require(`node:path`),a=(this.codexPetOverlayKWinDragGeneration??0)+1,o=`codex_pet_overlay_drag_${process.pid}_${Date.now()}_${a}`,s=i.join(r.tmpdir(),`${o}.js`);n.writeFileSync(s,this.codexPetOverlayKWinDragScript(),{encoding:`utf8`,flag:`wx`,mode:384}),t={generation:a,window:e,pluginName:o,scriptPath:s};let c=[`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.loadScript`,s,o];if(!this.codexPetOverlayKWinExecSync(c)||!this.codexPetOverlayKWinExecSync([`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.start`])){this.codexPetOverlayReleaseKWinDrag(t);return null}return t}catch(e){this.codexPetOverlayReleaseKWinDrag(t);return null}}",
    "codexPetOverlayBeginKWinDrag(e){if(e==null||e.isDestroyed?.()||this.window!==e||!this.codexPetOverlayShouldUseKWin())return!1;try{this.codexPetOverlayKWinTimers?.forEach(clearTimeout)}catch{}let t=this.codexPetOverlayKWinDragState;t!=null&&(this.codexPetOverlayKWinDragState=null,this.codexPetOverlayReleaseKWinDrag(t));let n=this.codexPetOverlayStartKWinDrag(e);return n==null?!1:(this.codexPetOverlayKWinDragGeneration=n.generation,this.codexPetOverlayKWinDragState=n,!0)}",
    "codexPetOverlayKWinDragCurrent(e){if(e==null||this.codexPetOverlayKWinDragState!==e||this.codexPetOverlayKWinDragGeneration!==e.generation)return!1;if(this.window===e.window&&!e.window?.isDestroyed?.())return!0;this.codexPetOverlayKWinDragState=null,this.codexPetOverlayReleaseKWinDrag(e);return!1}",
    "codexPetOverlayQueueKWinDrag(e){let t=this.codexPetOverlayKWinDragState;return this.codexPetOverlayKWinDragCurrent(t)&&t.window===e}",
    "codexPetOverlayEndKWinDrag(e,t){let n=this.codexPetOverlayKWinDragState;if(!this.codexPetOverlayKWinDragCurrent(n)||n.window!==e)return!1;this.codexPetOverlayKWinDragState=null,this.codexPetOverlayReleaseKWinDrag(n);try{typeof t===`function`&&t()}catch{}try{this.window!=null&&!this.window.isDestroyed?.()&&this.codexPetOverlayScheduleKWinHints(this.window)}catch{}return!0}",
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
    "codexPetOverlayBeginNiriDrag(e){if(e==null||e.isDestroyed?.()||this.window!==e||!this.codexPetOverlayShouldUseNiri())return!1;try{this.codexPetOverlayNiriTimers?.forEach(clearTimeout),this.codexPetOverlayNiriDragState?.retryTimer!=null&&clearTimeout(this.codexPetOverlayNiriDragState.retryTimer)}catch{}this.codexPetOverlayNiriEpoch=(this.codexPetOverlayNiriEpoch??0)+1;let t=(this.codexPetOverlayNiriDragGeneration??0)+1;this.codexPetOverlayNiriDragGeneration=t;let n=this.codexPetOverlayNiriLocalMove();return this.codexPetOverlayNiriDragState={generation:t,window:e,id:null,floating:!1,latestTarget:n==null?null:{x:n.x,y:n.y},inFlight:!1,released:!1,persisted:!1,complete:null,retryIndex:0,retryTimer:null},this.codexPetOverlayPumpNiriDrag(this.codexPetOverlayNiriDragState),!0}",
    "codexPetOverlayNiriDragCurrent(e){if(e==null||this.codexPetOverlayNiriDragState!==e||this.codexPetOverlayNiriDragGeneration!==e.generation)return!1;if(this.window===e.window&&!e.window?.isDestroyed?.())return!0;try{e.retryTimer!=null&&clearTimeout(e.retryTimer)}catch{}this.codexPetOverlayNiriDragState=null,this.codexPetOverlayNiriEpoch=(this.codexPetOverlayNiriEpoch??0)+1;let t=this.window;try{t!=null&&!t.isDestroyed?.()&&this.codexPetOverlayScheduleNiriHints(t)}catch{}return!1}",
    "codexPetOverlayStartNiriDragCall(e){if(this.codexPetOverlayNiriDragCallOwner!=null)return!1;e.inFlight=!0,this.codexPetOverlayNiriDragCallOwner=e;return!0}",
    "codexPetOverlayFinishNiriDragCall(e){e.inFlight=!1,this.codexPetOverlayNiriDragCallOwner===e&&(this.codexPetOverlayNiriDragCallOwner=null);let t=this.codexPetOverlayNiriDragState;if(t!=null&&t!==e)this.codexPetOverlayPumpNiriDrag(t);else if(t==null){let e=this.window;try{e!=null&&!e.isDestroyed?.()&&this.codexPetOverlayScheduleNiriHints(e)}catch{}}}",
    "codexPetOverlayQueueNiriDrag(e){let t=this.codexPetOverlayNiriDragState;if(!this.codexPetOverlayNiriDragCurrent(t)||t.window!==e)return;let n=this.codexPetOverlayNiriLocalMove();n!=null&&(t.latestTarget={x:n.x,y:n.y}),this.codexPetOverlayPumpNiriDrag(t)}",
    "codexPetOverlayRetryNiriDrag(e,t){if(!this.codexPetOverlayNiriDragCurrent(e))return;if(t?.code===`ENOENT`){this.codexPetOverlayAbortNiriDrag(e);return}if(e.retryIndex>=3){this.codexPetOverlayAbortNiriDrag(e);return}let n=[0,80,300][e.retryIndex]??300;e.retryTimer=setTimeout(()=>{e.retryTimer=null,this.codexPetOverlayNiriDragCurrent(e)&&this.codexPetOverlayPumpNiriDrag(e)},n);try{e.retryTimer.unref?.()}catch{}}",
    "codexPetOverlayAbortNiriDrag(e){if(!this.codexPetOverlayNiriDragCurrent(e))return;try{e.retryTimer!=null&&clearTimeout(e.retryTimer)}catch{}e.inFlight=!1,e.retryTimer=null,e.released?this.codexPetOverlayFinalizeNiriDrag(e):this.codexPetOverlayNiriDragState=null}",
    "codexPetOverlayFinalizeNiriDrag(e){if(!this.codexPetOverlayNiriDragCurrent(e)||!e.released||e.persisted)return;e.persisted=!0;let t=e.complete;this.codexPetOverlayNiriDragState=null;try{typeof t==`function`&&t()}catch{}}",
    "codexPetOverlayPumpNiriDrag(e){if(!this.codexPetOverlayNiriDragCurrent(e)||e.inFlight||e.retryTimer!=null||this.codexPetOverlayNiriDragCallOwner!=null||(this.codexPetOverlayNiriProcessCount??0)>0)return;if(e.id==null){if(e.retryIndex>=3){this.codexPetOverlayAbortNiriDrag(e);return}e.retryIndex+=1;if(!this.codexPetOverlayStartNiriDragCall(e))return;this.codexPetOverlayFindNiriWindow(e.window,(t,n)=>{this.codexPetOverlayFinishNiriDragCall(e);if(!this.codexPetOverlayNiriDragCurrent(e))return;let r=this.codexPetOverlayNiriPositiveInteger(n?.id);if(t||r==null){this.codexPetOverlayRetryNiriDrag(e,t);return}e.id=r,e.floating=n.is_floating===!0,this.codexPetOverlayPumpNiriDrag(e)});return}if(!e.floating){if(!this.codexPetOverlayStartNiriDragCall(e))return;let t=e.id;this.codexPetOverlayNiri([`action`,`move-window-to-floating`,`--id`,String(t)],n=>{this.codexPetOverlayFinishNiriDragCall(e);if(!this.codexPetOverlayNiriDragCurrent(e))return;if(n){e.id=null,e.floating=!1,this.codexPetOverlayRetryNiriDrag(e,n);return}e.floating=!0,this.codexPetOverlayPumpNiriDrag(e)});return}let t=e.latestTarget;if(t!=null){e.latestTarget=null;if(!this.codexPetOverlayStartNiriDragCall(e)){e.latestTarget=t;return}let n=e.id;this.codexPetOverlayNiri([`action`,`move-floating-window`,`--id`,String(n),`-x`,String(t.x),`-y`,String(t.y)],n=>{this.codexPetOverlayFinishNiriDragCall(e);if(!this.codexPetOverlayNiriDragCurrent(e))return;if(n){e.latestTarget??=t,e.id=null,e.floating=!1,this.codexPetOverlayRetryNiriDrag(e,n);return}this.codexPetOverlayPumpNiriDrag(e)});return}e.released&&this.codexPetOverlayFinalizeNiriDrag(e)}",
    "codexPetOverlayEndNiriDrag(e,t,n){let r=this.codexPetOverlayNiriDragState;if(!this.codexPetOverlayNiriDragCurrent(r)||r.window!==e)return!1;this.codexPetOverlayMoveCompositorDrag(e,t),r.released=!0,r.complete=n;let i=this.codexPetOverlayNiriLocalMove();i!=null&&(r.latestTarget={x:i.x,y:i.y}),this.codexPetOverlayPumpNiriDrag(r);return!0}",
    "codexPetOverlayBeginCompositorDrag(e){let t=this.codexPetOverlayBeginKWinDrag(e)||this.codexPetOverlayBeginNiriDrag(e);return t&&(this.nativeWindowDragStart=null,this.nativeWindowDragActive=!0),!!t}",
    "codexPetOverlayMoveCompositorDrag(e,t){let n=this.codexPetOverlayKWinDragState;if(this.codexPetOverlayKWinDragCurrent(n)&&n.window===e)return!0;let r=this.codexPetOverlayNiriDragState;if(!this.codexPetOverlayNiriDragCurrent(r)||r.window!==e)return!1;let i=this.dragState,a=this.layout,o=this.codexPetOverlayMascotRect(a),s=this.codexPetOverlayRect(a?.windowBounds)??this.codexPetOverlayWindowBounds(e),c=Number(t?.pointerScreenX),l=Number(t?.pointerScreenY),u;try{u=require(`electron`).screen}catch{}if(![c,l].every(Number.isFinite)){let e=u?.getCursorScreenPoint?.();c=Number(e?.x),l=Number(e?.y)}let d=Number(i?.pointerAnchorX),p=Number(i?.pointerAnchorY);if(o==null||s==null||![c,l,d,p].every(Number.isFinite))return!0;let h;try{h=u?.getDisplayNearestPoint?.({x:c,y:l})}catch{}let m=this.codexPetOverlayDisplayRect(h);m!=null&&(this.codexPetOverlayDesiredDisplayBounds={x:Math.round(m.x),y:Math.round(m.y),width:Math.round(m.width),height:Math.round(m.height)}),this.codexPetOverlayDesiredWindowBounds={x:Math.round(c-o.left-d),y:Math.round(l-o.top-p),width:Math.round(s.width),height:Math.round(s.height)},this.codexPetOverlayQueueNiriDrag(e);return!0}",
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

function patchCreateWindowFrame(source) {
  const method = findAvatarOverlayMethod(source, /async createWindow\([^)]*\)\{/);
  if (method == null) {
    console.warn("WARN: Could not find avatar overlay createWindow - skipping pet overlay frame patch");
    return source;
  }
  if (method.text.includes("frame:process.platform===`linux`?!1:!0")) {
    return source;
  }
  const replacement = method.text.replace(
    "appearance:`avatarOverlay`,",
    "appearance:`avatarOverlay`,frame:process.platform===`linux`?!1:!0,",
  );
  if (replacement === method.text) {
    console.warn("WARN: Could not identify avatar overlay appearance option - skipping pet overlay frame patch");
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

function patchCompositorDragLifecycle(source) {
  let patched = source;
  const startMethod = findAvatarOverlayMethod(patched, /startDrag\([^)]*\)\{/);
  if (startMethod == null) {
    console.warn("WARN: Could not find avatar overlay startDrag for compositor transport - skipping pet overlay patch");
    return patched;
  }
  if (!startMethod.text.includes("codexPetOverlayBeginCompositorDrag(")) {
    const windowMatch = startMethod.text.match(/let ([A-Za-z_$][\w$]*)=this\.window;/);
    if (windowMatch == null || !startMethod.text.includes("this.dragState=")) {
      console.warn("WARN: Could not identify current avatar overlay drag start shape - skipping compositor transport hook");
      return patched;
    }
    patched = replaceMethodText(
      patched,
      startMethod,
      `${startMethod.text.slice(0, -1)},this.codexPetOverlayBeginCompositorDrag(${windowMatch[1]})}`,
    );
  }

  const moveMethod = findAvatarOverlayMethod(patched, /moveDrag\([^)]*\)\{/);
  if (moveMethod == null) {
    console.warn("WARN: Could not find avatar overlay moveDrag for compositor transport - skipping pet overlay patch");
    return patched;
  }
  if (!moveMethod.text.includes("codexPetOverlayMoveCompositorDrag(")) {
    const windowMatch = moveMethod.text.match(/let ([A-Za-z_$][\w$]*)=this\.window;/);
    const eventArg = firstMethodArgument(moveMethod.match[0], "moveDrag", 1);
    const movementMatch = moveMethod.text.match(
      /if\(([A-Za-z_$][\w$]*)\.recordMovementIntent\(\),this\.nativeWindowDragActive\)return;/,
    );
    if (windowMatch == null || eventArg == null || movementMatch == null) {
      console.warn("WARN: Could not identify current avatar overlay drag move shape - skipping compositor transport hook");
      return patched;
    }
    const replacement = `if(${movementMatch[1]}.recordMovementIntent(),this.codexPetOverlayMoveCompositorDrag(${windowMatch[1]},${eventArg})||this.nativeWindowDragActive)return;`;
    patched = replaceMethodText(
      patched,
      moveMethod,
      moveMethod.text.replace(movementMatch[0], replacement),
    );
  }

  const endMethod = findAvatarOverlayMethod(patched, /endDrag\([^)]*\)\{/);
  if (endMethod == null) {
    console.warn("WARN: Could not find avatar overlay endDrag for compositor transport - skipping pet overlay patch");
    return patched;
  }
  if (
    endMethod.text.includes("codexPetOverlayEndKWinDrag(") &&
    endMethod.text.includes("codexPetOverlayEndNiriDrag(")
  ) {
    return patched;
  }
  const windowMatch = endMethod.text.match(/let ([A-Za-z_$][\w$]*)=this\.window;/u);
  const eventArg = firstMethodArgument(endMethod.match[0], "endDrag", 1);
  const nativeBoundsMatch = endMethod.text.match(
    /let [A-Za-z_$][\w$]*=this\.dragState,([A-Za-z_$][\w$]*)=this\.nativeWindowDragActive,([A-Za-z_$][\w$]*)=\1\?/,
  );
  const completionBoundary = "this.nativeWindowDragStart=null,";
  const boundaryIndex = endMethod.text.indexOf(completionBoundary);
  const completionStart = endMethod.text.lastIndexOf(
    "if(this.suppressNextRendererThrow=",
    boundaryIndex,
  );
  if (
    windowMatch == null || eventArg == null || nativeBoundsMatch == null ||
    boundaryIndex === -1 || completionStart === -1
  ) {
    console.warn("WARN: Could not identify current avatar overlay drag completion shape - skipping compositor transport hook");
    return patched;
  }
  const completionNeedle = endMethod.text.slice(completionStart, -1);
  if (
    !completionNeedle.includes(completionBoundary) ||
    !completionNeedle.includes("this.persistWindowBounds(") ||
    !completionNeedle.includes("this.reclampWindowToVisibleDisplay({shouldPersist:!0})")
  ) {
    console.warn("WARN: Could not identify current avatar overlay drag completion shape - skipping compositor transport hook");
    return patched;
  }
  const windowVar = windowMatch[1];
  const nativeBoundsVar = nativeBoundsMatch[2];
  const niriCompletion = completionNeedle.replace(
    "if(this.suppressNextRendererThrow=",
    `${nativeBoundsVar}=this.codexPetOverlayDesiredWindowBounds??this.codexPetOverlayWindowBounds(${windowVar})??${nativeBoundsVar};if(this.suppressNextRendererThrow=`,
  );
  return replaceMethodText(
    patched,
    endMethod,
    endMethod.text.slice(0, completionStart) +
      `this.codexPetOverlayEndKWinDrag(${windowVar},()=>{${completionNeedle}})||this.codexPetOverlayEndNiriDrag(${windowVar},${eventArg},()=>{${niriCompletion}})||(()=>{${completionNeedle}})()` +
      "}",
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

function patchLocalMascotDrag(source) {
  if (source.includes("if(this.codexPetOverlayStartLocalMascotDrag(")) {
    return source;
  }
  const patches = [
    ["startDrag", "codexPetOverlayStartLocalMascotDrag"],
    ["moveDrag", "codexPetOverlayMoveLocalMascotDrag"],
    ["endDrag", "codexPetOverlayEndLocalMascotDrag"],
  ];
  let patched = source;
  for (const [methodName, helperName] of patches) {
    const method = findAvatarOverlayMethod(patched, new RegExp(`${methodName}\\([^)]*\\)\\{`));
    const callerArg = method == null ? null : firstMethodArgument(method.match[0], methodName, 0);
    const eventArg = method == null ? null : firstMethodArgument(method.match[0], methodName, 1);
    if (method == null || callerArg == null || (methodName !== "endDrag" && eventArg == null)) {
      if (methodName === "moveDrag") {
        return source;
      }
      console.warn(`WARN: Could not find avatar overlay ${methodName} - skipping local pet drag patch`);
      return source;
    }
    const call = methodName === "endDrag"
      ? `this.${helperName}(${callerArg})`
      : `this.${helperName}(${callerArg},${eventArg})`;
    patched = replaceMethodText(
      patched,
      method,
      method.text.slice(0, method.match[0].length) + `if(${call})return;` + method.text.slice(method.match[0].length),
    );
  }
  return patched;
}

function patchLocalMascotDragLifecycle(source) {
  if (source.includes("this.dragState=null,this.codexPetOverlayMascotDragState=null,")) {
    return source;
  }
  const method = findAvatarOverlayMethod(source, /async createWindow\([^)]*\)\{/);
  if (method == null || !method.text.includes("this.dragState=null,")) {
    console.warn("WARN: Could not find avatar overlay lifecycle state - skipping local pet drag cleanup");
    return source;
  }
  return replaceMethodText(
    source,
    method,
    method.text.replaceAll(
      "this.dragState=null,",
      "this.dragState=null,this.codexPetOverlayMascotDragState=null,",
    ),
  );
}

function patchPassiveCreateWindow(source, settings) {
  if (settings.mode !== "passive") {
    return source;
  }
  return source
    .split("appearance:`avatarOverlay`,frame:process.platform===`linux`?!1:!0,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:process.platform===`linux`?!0:!1")
    .join("appearance:`avatarOverlay`,frame:process.platform===`linux`?!1:!0,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:!1");
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

function hasCompletePetOverlayPatch(source, settings, avatarSelectionRefreshExpected, localMascotDragExpected) {
  const requiredMarkers = [
    source.includes("codexPetOverlaySettings(){"),
    /let [A-Za-z_$][\w$]*=this\.codexPetOverlayLayoutForDisplay\([A-Za-z_$][\w$]*,this\.getLayoutForDisplay\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\);/.test(source),
    /process\.platform===`linux`\?this\.codexPetOverlaySyncWindow\([A-Za-z_$][\w$]*,!0\):[A-Za-z_$][\w$]*\.moveTop\(\),[A-Za-z_$][\w$]*\.showInactive\(\),/.test(source),
    source.includes("if(this.codexPetOverlayShouldLockPosition())return;"),
    source.includes("codexPetOverlayKWinQdbus("),
    source.includes("this.codexPetOverlayBeginCompositorDrag("),
    source.includes("this.codexPetOverlayMoveCompositorDrag("),
    source.includes("this.codexPetOverlayEndKWinDrag("),
    source.includes("this.codexPetOverlayEndNiriDrag("),
    source.includes("===`avatarOverlay`?{backgroundColor:`#00000000`,backgroundMaterial:null}:"),
    source.includes("title:`Codex Pet Overlay`,width:"),
  ];
  if (localMascotDragExpected) {
    requiredMarkers.push(
      source.includes("if(this.codexPetOverlayStartLocalMascotDrag("),
      source.includes("if(this.codexPetOverlayMoveLocalMascotDrag("),
      source.includes("if(this.codexPetOverlayEndLocalMascotDrag("),
      source.includes("this.dragState=null,this.codexPetOverlayMascotDragState=null,"),
    );
  }
  if (avatarSelectionRefreshExpected) {
    requiredMarkers.push(
      source.includes(`function ${AVATAR_SELECTION_REFRESH_MARKER}(`),
      source.includes("===`selected-avatar-id`&&codexPetOverlayRefreshAvatarWindows()"),
    );
  }
  if (settings.mode === "passive") {
    requiredMarkers.push(
      source.includes("appearance:`avatarOverlay`,frame:process.platform===`linux`?!1:!0,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:!1"),
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
  const localMascotDragExpected = /moveDrag\([^)]*\)\{/.test(source);
  let patched = patchAvatarTransparentBackground(source);
  patched = patchCreateWindowTitle(patched);
  patched = patchCreateWindowFrame(patched);
  patched = patchApplyLayout(patched);
  patched = patchShowWindow(patched);
  patched = patchLockedDrag(patched);
  patched = patchCompositorDragLifecycle(patched);
  patched = ensurePetOverlayMethods(patched, settings);
  patched = patchLocalMascotDrag(patched);
  if (localMascotDragExpected) {
    patched = patchLocalMascotDragLifecycle(patched);
  }
  patched = patchPassiveCreateWindow(patched, settings);
  if (avatarSelectionRefreshExpected) {
    patched = patchAvatarSelectionRefresh(patched);
  }
  if (!hasCompletePetOverlayPatch(patched, settings, avatarSelectionRefreshExpected, localMascotDragExpected)) {
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
