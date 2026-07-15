"use strict";

const {
  findMatchingBrace,
  requireName,
} = require("../lib/minified-js.js");
const { recordStrategy } = require("../strategy-telemetry.js");

function findAvatarMethodAfter(source, signatureRegex, startIndex, endIndex = source.length) {
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

function avatarOverlayRegionStart(source) {
  const routeIndex = source.indexOf("`/avatar-overlay`");
  return routeIndex === -1 ? null : routeIndex;
}

function findAvatarOverlayClass(source) {
  const regionStart = avatarOverlayRegionStart(source);
  if (regionStart == null) {
    return null;
  }
  const classRegex = /class(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[A-Za-z_$][\w$.]*)?\{/g;
  classRegex.lastIndex = regionStart;
  let match;
  while ((match = classRegex.exec(source)) != null) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex === -1) {
      // findMatchingBrace cannot balance this class (e.g. it contains a regex
      // literal with an unbalanced brace). Skip it and keep scanning instead of
      // aborting — the avatar overlay class may appear later in the bundle.
      classRegex.lastIndex = openIndex + 1;
      continue;
    }
    const text = source.slice(match.index, closeIndex + 1);
    if (text.includes("appearance:`avatarOverlay`")) {
      return {
        start: match.index,
        end: closeIndex + 1,
        text,
      };
    }
    classRegex.lastIndex = closeIndex + 1;
  }
  return null;
}

function findAvatarOverlayMethod(source, signatureRegex) {
  const overlayClass = findAvatarOverlayClass(source);
  if (overlayClass == null) {
    return null;
  }
  return findAvatarMethodAfter(source, signatureRegex, overlayClass.start, overlayClass.end);
}

function replaceAvatarMethodText(source, method, replacement) {
  if (method == null || method.text === replacement) {
    return source;
  }
  return source.slice(0, method.start) + replacement + source.slice(method.end);
}

function avatarCursorRegionPatch(electronVar) {
  return `codexLinuxIsCursorInAvatarInteractiveRegion(e){let t=this.layout;if(t==null)return!1;let __codexCursor=${electronVar}.screen.getCursorScreenPoint(),__codexBounds=e.getContentBounds(),__codexX=__codexCursor.x-__codexBounds.x,__codexY=__codexCursor.y-__codexBounds.y,__codexWindowHit=__codexX>=0&&__codexY>=0&&__codexX<=__codexBounds.width&&__codexY<=__codexBounds.height;if(!__codexWindowHit)return!1;let __codexHit=e=>e!=null&&__codexX>=e.left&&__codexX<=e.left+e.width&&__codexY>=e.top&&__codexY<=e.top+e.height;return __codexHit(t.mascot)||__codexHit(t.tray)}`;
}

function avatarInputShapePatch() {
  return "codexLinuxBuildAvatarInputShape(e){let t=this.layout;if(t==null)return null;let r;try{r=e.getContentBounds()}catch{return null}if(r==null||!Number.isFinite(r.width)||!Number.isFinite(r.height))return null;if(this.dragState!=null)return[{x:0,y:0,width:r.width,height:r.height}];let i=e=>{if(e==null)return null;let t=Math.max(0,e.left),n=Math.max(0,e.top),i=Math.min(r.width,e.left+e.width)-t,a=Math.min(r.height,e.top+e.height)-n;return i<=0||a<=0?null:{x:t,y:n,width:i,height:a}};return[i(t.mascot),i(t.tray)].filter(Boolean)}";
}

function avatarApplyInputShapePatch() {
  return "codexLinuxApplyAvatarInputShape(e){if(process.platform!==`linux`||e==null||e.isDestroyed()||typeof e.setShape!=`function`||typeof this.codexLinuxIsAvatarShapeBackend==`function`&&!this.codexLinuxIsAvatarShapeBackend())return!1;try{let t=this.codexLinuxBuildAvatarInputShape(e);if(t==null)return!1;let n=JSON.stringify(t);if(this.codexLinuxAvatarInputShapeKey===n)return!0;e.setShape(t),this.codexLinuxAvatarInputShapeKey=n;return!0}catch{this.codexLinuxAvatarInputShapeKey=null;return!1}}";
}

function patchAvatarOverlayWindowOptions(source) {
  const windowOptionsPatch =
    "appearance:`avatarOverlay`,alwaysOnTop:process.platform===`linux`,skipTaskbar:process.platform===`linux`,focusable:process.platform===`linux`?!0:!1";
  if (source.includes(windowOptionsPatch)) {
    return source;
  }
  return source.replace(
    "appearance:`avatarOverlay`,focusable:!1",
    windowOptionsPatch,
  );
}

function applyLinuxQueryCacheInvalidationBroadcastPatch(currentSource) {
  const marker = "process.platform===`linux`&&this.windowManager.sendMessageToAllRegisteredWindows({type:`ipc-broadcast`,method:`query-cache-invalidate`";
  if (currentSource.includes(marker)) {
    return currentSource;
  }

  const original =
    "case`query-cache-invalidate`:{t.queryKey[0]===`plugins`&&Sr(this.getAppServerConnection(this.hostId));let n=this.getIpcClientForWebContents(e);n&&await n.sendBroadcast(`query-cache-invalidate`,{queryKey:t.queryKey});break}";
  if (!currentSource.includes(original)) {
    console.warn(
      "WARN: Could not find query cache invalidation handler - skipping Linux avatar settings sync patch",
    );
    return currentSource;
  }

  const versionMatch = currentSource.match(
    /version:([A-Za-z_$][\w$]*)\.fc\(`query-cache-invalidate`\)/,
  );
  if (versionMatch == null) {
    console.warn(
      "WARN: Could not find query cache invalidation protocol version - skipping Linux avatar settings sync patch",
    );
    return currentSource;
  }

  const protocol = versionMatch[1];
  const replacement =
    "case`query-cache-invalidate`:{t.queryKey[0]===`plugins`&&Sr(this.getAppServerConnection(this.hostId));let r=this.getIpcClientForWebContents(e);r&&await r.sendBroadcast(`query-cache-invalidate`,{queryKey:t.queryKey});process.platform===`linux`&&this.windowManager.sendMessageToAllRegisteredWindows({type:`ipc-broadcast`,method:`query-cache-invalidate`,sourceClientId:`desktop`,version:" +
    protocol +
    ".fc(`query-cache-invalidate`),params:{queryKey:t.queryKey}});break}";
  recordStrategy("avatar-settings-sync", "upstream");
  return currentSource.replace(original, replacement);
}

function applyLinuxAvatarOverlayMousePassthroughPatch(currentSource) {
  if (!currentSource.includes("`/avatar-overlay`")) {
    return currentSource;
  }

  let patchedSource = currentSource;
  const electronVar = requireName(currentSource, "electron");
  const childProcessVar = requireName(currentSource, "node:child_process");
  if (electronVar == null || childProcessVar == null) {
    console.warn(
      "WARN: Could not find avatar overlay module bindings — skipping Linux avatar overlay passthrough recovery patch",
    );
    return currentSource;
  }
  const i3SessionMethod =
    "codexLinuxIsI3Session(){let e=[process.env.XDG_CURRENT_DESKTOP,process.env.DESKTOP_SESSION,process.env.I3SOCK].filter(Boolean).join(`:`).toLowerCase();return/(^|[:;/])i3([:;/.-]|$)/.test(e)}";
  const compositorHintsMethod =
    `codexLinuxApplyAvatarCompositorHints(e){if(process.platform!==\`linux\`||!this.codexLinuxIsI3Session()||this.codexLinuxAvatarCompositorHintsApplied||this.codexLinuxAvatarCompositorHintsApplying||e==null||e.isDestroyed()||!process.env.DISPLAY)return;let t;try{t=e.getBounds?.()??e.getContentBounds?.()}catch{}if(t==null||!Number.isFinite(t.x)||!Number.isFinite(t.y)||!Number.isFinite(t.width)||!Number.isFinite(t.height))return;let n=[];try{let r=e.getNativeWindowHandle?.();r!=null&&r.length>=4&&n.push(String(r.readUInt32LE(0)))}catch{}this.codexLinuxAvatarCompositorHintsApplying=!0;let r=e=>{let r=[...new Set(e)].filter(e=>/^[0-9]+$/.test(e)&&e!==\`0\`);if(r.length===0){this.codexLinuxAvatarCompositorHintsApplying=!1;return}let i=r.length,a=!1,o=()=>{i--,i===0&&(this.codexLinuxAvatarCompositorHintsApplying=!1,a&&(this.codexLinuxAvatarCompositorHintsApplied=!0))},s=e=>{try{${childProcessVar}.execFile(\`xwininfo\`,[\`-id\`,e],{timeout:1e3},(r,i)=>{if(r){o();return}let s=String(i??\`\`),c=s.match(/Absolute upper-left X:\\s+(-?\\d+)[\\s\\S]*Absolute upper-left Y:\\s+(-?\\d+)[\\s\\S]*Width:\\s+(\\d+)[\\s\\S]*Height:\\s+(\\d+)/);if(c==null||!/Override Redirect State:\\s+yes/.test(s)){o();return}let[,__codexAvatarX,__codexAvatarY,__codexAvatarWidth,__codexAvatarHeight]=c;if(Number(__codexAvatarX)!==t.x||Number(__codexAvatarY)!==t.y||Number(__codexAvatarWidth)!==t.width||Number(__codexAvatarHeight)!==t.height){o();return}try{${childProcessVar}.execFile(\`xprop\`,[\`-id\`,e,\`-f\`,\`_GTK_FRAME_EXTENTS\`,\`32c\`,\`-set\`,\`_GTK_FRAME_EXTENTS\`,\`0, 0, 0, 0\`],{timeout:1e3},e=>{e||(a=!0),o()})}catch{o()}})}catch{o()}};for(let t of r)s(t)};try{${childProcessVar}.execFile(\`xdotool\`,[\`search\`,\`--pid\`,String(process.pid)],{timeout:1e3},(e,t)=>{r([...n,...String(t??\`\`).trim().split(/\\s+/).filter(Boolean)])})}catch{r(n)}}`;
  const shapeBackendMethod =
    `codexLinuxIsAvatarShapeBackend(){if(process.platform!==\`linux\`)return!1;let e=\`\`;try{e=${electronVar}.app.commandLine.getSwitchValue(\`ozone-platform\`)}catch{}return e===\`x11\`||e===\`\`&&!process.env.WAYLAND_DISPLAY}`;

  const interactivityNeedle =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}";
  const interactivityMethodPatch =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1,this.codexLinuxStopAvatarPassthroughRecovery();return}if(this.codexLinuxIsAvatarShapeBackend()&&typeof e.setShape==`function`){this.codexLinuxStartAvatarPassthroughRecovery(),this.mousePassthroughEnabled&&(this.mousePassthroughEnabled=!1,e.setIgnoreMouseEvents(!1));if(this.codexLinuxApplyAvatarInputShape(e))return}process.platform===`linux`&&(this.codexLinuxStartAvatarPassthroughRecovery(),this.codexLinuxSyncAvatarPointerInteractivity(e));let t=!this.pointerInteractive;this.dragState!=null&&(t=!1);if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}";
  const stopRecoveryMethod =
    "codexLinuxStopAvatarPassthroughRecovery(){this.codexLinuxAvatarPassthroughRecoveryTimer!=null&&(clearInterval(this.codexLinuxAvatarPassthroughRecoveryTimer),this.codexLinuxAvatarPassthroughRecoveryTimer=null)}";
  const startRecoveryMethod =
    "codexLinuxStartAvatarPassthroughRecovery(){if(process.platform!==`linux`||this.codexLinuxAvatarPassthroughRecoveryTimer!=null)return;this.codexLinuxAvatarPassthroughRecoveryTimer=setInterval(()=>{let e=this.window;if(e==null||e.isDestroyed()||!e.isVisible()){this.codexLinuxStopAvatarPassthroughRecovery();return}this.codexLinuxSyncAvatarPointerInteractivity(e)&&this.applyPointerInteractivityPolicy()},32),this.codexLinuxAvatarPassthroughRecoveryTimer.unref?.()}";
  const syncInteractivityMethod =
    "codexLinuxSyncAvatarPointerInteractivity(e){if(process.platform!==`linux`||e==null||e.isDestroyed())return!1;if(this.dragState!=null){if(this.pointerInteractive)return!1;return this.pointerInteractive=!0,!0}let t;try{t=this.codexLinuxIsCursorInAvatarInteractiveRegion(e)}catch{t=!0}return this.pointerInteractive===t?!1:(this.pointerInteractive=t,!0)}";
  const interactivityPatch =
    interactivityMethodPatch +
    i3SessionMethod +
    compositorHintsMethod +
    shapeBackendMethod +
    stopRecoveryMethod +
    avatarInputShapePatch() +
    avatarApplyInputShapePatch() +
    startRecoveryMethod +
    syncInteractivityMethod +
    avatarCursorRegionPatch(electronVar);

  if (!patchedSource.includes("codexLinuxIsI3Session")) {
    const interactivityMethod = findAvatarOverlayMethod(
      patchedSource,
      /applyPointerInteractivityPolicy\(\)\{/,
    );
    if (interactivityMethod?.text === interactivityNeedle) {
      recordStrategy("avatar-interactivity", "upstream");
      patchedSource = replaceAvatarMethodText(
        patchedSource,
        interactivityMethod,
        interactivityPatch,
      );
    } else if (
      patchedSource.includes("avatar-overlay") &&
      patchedSource.includes("applyPointerInteractivityPolicy(){let e=this.window")
    ) {
      recordStrategy("avatar-interactivity", "none");
      console.warn(
        "WARN: Could not find avatar overlay mouse passthrough policy — skipping Linux avatar overlay passthrough recovery patch",
      );
      return currentSource;
    }
  } else {
    recordStrategy("avatar-interactivity", "already-applied");
  }
  const beforeFocusablePatch = patchedSource;
  patchedSource = patchAvatarOverlayWindowOptions(patchedSource);
  recordStrategy(
    "avatar-window-options",
    patchedSource === beforeFocusablePatch
      ? patchedSource.includes("appearance:`avatarOverlay`") ? "already-applied" : "none"
      : "upstream",
  );

  const startDragMethod = findAvatarOverlayMethod(
    patchedSource,
    /startDrag\([^)]*\)\{/,
  );
  if (startDragMethod?.text.includes(
    "process.platform===`linux`&&(this.pointerInteractive=!0,this.applyPointerInteractivityPolicy())",
  )) {
    recordStrategy("avatar-start-drag", "already-applied");
  } else if (startDragMethod?.text.includes("this.dragState=")) {
    recordStrategy("avatar-start-drag", "upstream-method");
    patchedSource = replaceAvatarMethodText(
      patchedSource,
      startDragMethod,
      `${startDragMethod.text.slice(0, -1)},process.platform===\`linux\`&&(this.pointerInteractive=!0,this.applyPointerInteractivityPolicy())}`,
    );
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes("process.platform===`linux`&&(this.pointerInteractive=!0,this.applyPointerInteractivityPolicy())")
  ) {
    recordStrategy("avatar-start-drag", "none");
    console.warn(
      "WARN: Could not find avatar overlay drag start — skipping Linux avatar overlay drag interactivity patch",
    );
  }

  const endDragMethod = findAvatarOverlayMethod(
    patchedSource,
    /endDrag\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{/,
  );
  if (endDragMethod?.text.includes(
    "process.platform===`linux`&&this.applyPointerInteractivityPolicy()",
  )) {
    recordStrategy("avatar-end-drag", "already-applied");
  } else if (endDragMethod?.text.includes("this.dragState=null")) {
    recordStrategy("avatar-end-drag", "upstream-method");
    patchedSource = replaceAvatarMethodText(
      patchedSource,
      endDragMethod,
      `${endDragMethod.text.slice(0, -1)},process.platform===\`linux\`&&this.applyPointerInteractivityPolicy()}`,
    );
  } else if (patchedSource.includes("avatar-overlay")) {
    recordStrategy("avatar-end-drag", "none");
    console.warn(
      "WARN: Could not find avatar overlay drag end — skipping Linux avatar overlay drag cleanup patch",
    );
  }

  const setElementSizeMethod = findAvatarOverlayMethod(
    patchedSource,
    /setElementSize\([^)]*\)\{/,
  );
  if (setElementSizeMethod != null) {
    if (
      !/this\.applyLatestElementSizes\([A-Za-z_$][\w$]*\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/.test(setElementSizeMethod.text)
    ) {
      recordStrategy("avatar-element-size", "upstream");
      const patchedMethod = setElementSizeMethod.text.replace(
        /this\.applyLatestElementSizes\(([A-Za-z_$][\w$]*)\)(?!,process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\))/g,
        "this.applyLatestElementSizes($1),process.platform===`linux`&&this.applyPointerInteractivityPolicy()",
      );
      if (patchedMethod !== setElementSizeMethod.text) {
        patchedSource =
          patchedSource.slice(0, setElementSizeMethod.start) +
          patchedMethod +
          patchedSource.slice(setElementSizeMethod.end);
      }
    } else {
      recordStrategy("avatar-element-size", "already-applied");
    }
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !/setElementSize\([^{}]+\)\{[^]*?this\.applyLatestElementSizes\([A-Za-z_$][\w$]*\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/.test(patchedSource)
  ) {
    recordStrategy("avatar-element-size", "none");
    console.warn(
      "WARN: Could not find avatar overlay element size update — skipping Linux avatar overlay layout interactivity patch",
    );
  }

  if (!patchedSource.includes("this.codexLinuxAvatarCompositorHintsApplied=!1")) {
    patchedSource = patchedSource.replace(
      /return this\.window=([A-Za-z_$][\w$]*),/,
      "return this.window=$1,this.codexLinuxAvatarCompositorHintsApplied=!1,this.codexLinuxAvatarCompositorHintsApplying=!1,",
    );
  }

  const i3TrayFallbackRegex =
    /traySize:this\.traySize\?\?(\([^{};]*?\))(?=\}\))/;
  const i3TrayFallbackPatch =
    "traySize:process.platform===`linux`&&typeof this.codexLinuxIsI3Session==`function`&&this.codexLinuxIsI3Session()?this.traySize:this.traySize??$1";
  if (
    !patchedSource.includes(
      "traySize:process.platform===`linux`&&typeof this.codexLinuxIsI3Session==`function`&&this.codexLinuxIsI3Session()",
    )
  ) {
    if (i3TrayFallbackRegex.test(patchedSource)) {
      recordStrategy("avatar-i3-tray-fallback", "upstream");
      patchedSource = patchedSource.replace(i3TrayFallbackRegex, i3TrayFallbackPatch);
    } else if (patchedSource.includes("avatar-overlay")) {
      recordStrategy("avatar-i3-tray-fallback", "none");
      console.warn(
        "WARN: Could not find avatar overlay default tray layout — skipping Linux i3 hidden tray layout patch",
      );
    }
  } else {
    recordStrategy("avatar-i3-tray-fallback", "already-applied");
  }

  const applyLayoutMethod = findAvatarOverlayMethod(
    patchedSource,
    /(?<![\w$.])applyLayout\([^{}]*\)\{/,
  );
  if (applyLayoutMethod?.text.includes(
    "this.applyPointerInteractivityPolicy()",
  )) {
    recordStrategy("avatar-apply-layout", "already-applied");
  } else if (
    applyLayoutMethod != null &&
    applyLayoutMethod.text.includes("this.setWindowBounds(") &&
    applyLayoutMethod.text.includes("this.sendLayoutToRenderer(")
  ) {
    recordStrategy("avatar-apply-layout", "upstream");
    patchedSource = replaceAvatarMethodText(
      patchedSource,
      applyLayoutMethod,
      `${applyLayoutMethod.text.slice(0, -1)},process.platform===\`linux\`&&this.applyPointerInteractivityPolicy()}`,
    );
  } else if (
    patchedSource.includes("avatar-overlay")
  ) {
    recordStrategy("avatar-apply-layout", "none");
    console.warn(
      "WARN: Could not find avatar overlay layout application — skipping Linux avatar overlay layout sync patch",
    );
  }

  const showWindowMethod = findAvatarOverlayMethod(
    patchedSource,
    /showWindow\(([A-Za-z_$][\w$]*)\)\{/,
  );
  const showWindowArg = showWindowMethod?.match[1] ?? null;
  if (showWindowMethod?.text.includes("codexLinuxApplyAvatarCompositorHints")) {
    recordStrategy("avatar-show-window", "already-applied");
  } else if (
    showWindowMethod != null &&
    showWindowArg != null &&
    showWindowMethod.text.includes(`${showWindowArg}.moveTop(),${showWindowArg}.showInactive(),`)
  ) {
    recordStrategy("avatar-show-window", "upstream-regex");
    patchedSource = replaceAvatarMethodText(
      patchedSource,
      showWindowMethod,
      showWindowMethod.text.replace(
        `${showWindowArg}.moveTop(),${showWindowArg}.showInactive(),`,
        `${showWindowArg}.moveTop(),${showWindowArg}.showInactive(),process.platform===\`linux\`&&this.codexLinuxApplyAvatarCompositorHints(${showWindowArg}),process.platform===\`linux\`&&this.applyPointerInteractivityPolicy(),`,
      ),
    );
  } else if (patchedSource.includes("avatar-overlay")) {
    recordStrategy("avatar-show-window", "none");
    console.warn(
      "WARN: Could not find avatar overlay show window — skipping Linux avatar overlay show sync patch",
    );
  }

  const createWindowMethod = findAvatarOverlayMethod(
    patchedSource,
    /async createWindow\([^)]*\)\{/,
  );
  const closedHandlerMarker = ".on(`closed`,()=>{";
  const closedHandlerIndex = createWindowMethod?.text.indexOf(closedHandlerMarker) ?? -1;
  const closedHandlerOpenIndex = closedHandlerIndex + closedHandlerMarker.length - 1;
  const closedHandlerCloseIndex = closedHandlerIndex === -1
    ? -1
    : findMatchingBrace(createWindowMethod.text, closedHandlerOpenIndex);
  const closedHandler = closedHandlerCloseIndex === -1
    ? null
    : createWindowMethod.text.slice(closedHandlerOpenIndex, closedHandlerCloseIndex + 1);
  const closeCleanup =
    "this.codexLinuxStopAvatarPassthroughRecovery(),this.codexLinuxAvatarInputShapeKey=null,this.codexLinuxAvatarCompositorHintsApplied=!1,this.codexLinuxAvatarCompositorHintsApplying=!1,";
  if (closedHandler?.includes(closeCleanup)) {
    recordStrategy("avatar-close-cleanup", "already-applied");
  } else if (
    createWindowMethod != null &&
    closedHandler != null &&
    closedHandler.includes("this.cancelMomentum(),") &&
    closedHandler.includes("this.window=null,")
  ) {
    recordStrategy("avatar-close-cleanup", "upstream");
    const patchedClosedHandler = closedHandler.replace(
      "this.cancelMomentum(),",
      `${closeCleanup}this.cancelMomentum(),`,
    );
    const patchedCreateWindowMethod =
      createWindowMethod.text.slice(0, closedHandlerOpenIndex) +
      patchedClosedHandler +
      createWindowMethod.text.slice(closedHandlerCloseIndex + 1);
    patchedSource = replaceAvatarMethodText(
      patchedSource,
      createWindowMethod,
      patchedCreateWindowMethod,
    );
  } else if (patchedSource.includes("avatar-overlay")) {
    recordStrategy("avatar-close-cleanup", "none");
    console.warn(
      "WARN: Could not find avatar overlay close cleanup — skipping Linux avatar overlay passthrough cleanup patch",
    );
  }

  return patchedSource;
}

module.exports = {
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyLinuxQueryCacheInvalidationBroadcastPatch,
};
