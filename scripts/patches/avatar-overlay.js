"use strict";

const {
  findMatchingBrace,
  requireName,
} = require("./shared.js");
const { recordStrategy } = require("./strategy-telemetry.js");

function findAvatarMethod(source, signatureRegex) {
  const match = source.match(signatureRegex);
  if (match == null) {
    return null;
  }
  const openIndex = match.index + match[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  if (closeIndex === -1) {
    return null;
  }
  return {
    match,
    start: match.index,
    end: closeIndex + 1,
    text: source.slice(match.index, closeIndex + 1),
  };
}

function replaceAvatarMethod(source, signatureRegex, replacement) {
  const method = findAvatarMethod(source, signatureRegex);
  if (method == null || method.text === replacement) {
    return source;
  }
  return source.slice(0, method.start) + replacement + source.slice(method.end);
}

function avatarCursorRegionPatch(electronVar) {
  return `codexLinuxIsCursorInAvatarInteractiveRegion(e){let t=this.layout;if(t==null)return!1;let __codexCursor=${electronVar}.screen.getCursorScreenPoint(),__codexBounds=e.getContentBounds(),__codexX=__codexCursor.x-__codexBounds.x,__codexY=__codexCursor.y-__codexBounds.y,__codexWindowHit=__codexX>=0&&__codexY>=0&&__codexX<=__codexBounds.width&&__codexY<=__codexBounds.height;if(!__codexWindowHit)return!1;let __codexHit=e=>e!=null&&__codexX>=e.left&&__codexX<=e.left+e.width&&__codexY>=e.top&&__codexY<=e.top+e.height;return __codexHit(t.mascot)||__codexHit(t.tray)||__codexWindowHit}`;
}

function avatarInputShapePatch() {
  return "codexLinuxBuildAvatarInputShape(e){let t=this.layout;if(t==null)return null;let r;try{r=e.getContentBounds()}catch{return null}if(r==null||!Number.isFinite(r.width)||!Number.isFinite(r.height))return null;if(this.dragState!=null||this.pointerInteractive)return[{x:0,y:0,width:r.width,height:r.height}];let i=e=>{if(e==null)return null;let t=Math.max(0,e.left),n=Math.max(0,e.top),i=Math.min(r.width,e.left+e.width)-t,a=Math.min(r.height,e.top+e.height)-n;return i<=0||a<=0?null:{x:t,y:n,width:i,height:a}};return[i(t.mascot),i(t.tray)].filter(Boolean)}";
}

function avatarApplyInputShapePatch() {
  return "codexLinuxApplyAvatarInputShape(e){if(process.platform!==`linux`||e==null||e.isDestroyed()||typeof e.setShape!=`function`)return!1;try{let t=this.codexLinuxBuildAvatarInputShape(e);if(t==null)return!1;let n=JSON.stringify(t);if(this.codexLinuxAvatarInputShapeKey===n)return!0;e.setShape(t),this.codexLinuxAvatarInputShapeKey=n;return!0}catch{this.codexLinuxAvatarInputShapeKey=null;return!1}}";
}

function upgradeAvatarOverlayInjectedMethods(source, electronVar) {
  let patched = source;
  patched = replaceAvatarMethod(
    patched,
    /codexLinuxBuildAvatarInputShape\(e\)\{/,
    avatarInputShapePatch(),
  );
  patched = replaceAvatarMethod(
    patched,
    /codexLinuxApplyAvatarInputShape\(e\)\{/,
    avatarApplyInputShapePatch(),
  );
  patched = replaceAvatarMethod(
    patched,
    /codexLinuxIsCursorInAvatarInteractiveRegion\(e\)\{/,
    avatarCursorRegionPatch(electronVar),
  );
  return patched;
}

function applyLinuxAvatarOverlayMousePassthroughPatch(currentSource) {
  let patchedSource = currentSource;
  const electronVar = requireName(currentSource, "electron") ?? "n";
  const childProcessVar = requireName(currentSource, "node:child_process");
  const withElectronAlias = (source) =>
    electronVar === "n" ? source : source.replaceAll("n.screen", `${electronVar}.screen`);
  const i3SessionMethod =
    "codexLinuxIsI3Session(){let e=[process.env.XDG_CURRENT_DESKTOP,process.env.DESKTOP_SESSION,process.env.I3SOCK].filter(Boolean).join(`:`).toLowerCase();return/(^|[:;/])i3([:;/.-]|$)/.test(e)}";
  const compositorHintsMethod =
    childProcessVar == null
      ? "codexLinuxApplyAvatarCompositorHints(e){}"
      : `codexLinuxApplyAvatarCompositorHints(e){if(process.platform!==\`linux\`||!this.codexLinuxIsI3Session()||this.codexLinuxAvatarCompositorHintsApplied||this.codexLinuxAvatarCompositorHintsApplying||e==null||e.isDestroyed()||!process.env.DISPLAY)return;let t;try{t=e.getBounds?.()??e.getContentBounds?.()}catch{}if(t==null||!Number.isFinite(t.x)||!Number.isFinite(t.y)||!Number.isFinite(t.width)||!Number.isFinite(t.height))return;let n=[];try{let r=e.getNativeWindowHandle?.();r!=null&&r.length>=4&&n.push(String(r.readUInt32LE(0)))}catch{}this.codexLinuxAvatarCompositorHintsApplying=!0;let r=e=>{let r=[...new Set(e)].filter(e=>/^[0-9]+$/.test(e)&&e!==\`0\`);if(r.length===0){this.codexLinuxAvatarCompositorHintsApplying=!1;return}let i=r.length,a=!1,o=()=>{i--,i===0&&(this.codexLinuxAvatarCompositorHintsApplying=!1,a&&(this.codexLinuxAvatarCompositorHintsApplied=!0))},s=e=>{try{${childProcessVar}.execFile(\`xwininfo\`,[\`-id\`,e],{timeout:1e3},(r,i)=>{if(r){o();return}let s=String(i??\`\`),c=s.match(/Absolute upper-left X:\\s+(-?\\d+)[\\s\\S]*Absolute upper-left Y:\\s+(-?\\d+)[\\s\\S]*Width:\\s+(\\d+)[\\s\\S]*Height:\\s+(\\d+)/);if(c==null||!/Override Redirect State:\\s+yes/.test(s)){o();return}let[,l,h,d,f]=c;if(Number(l)!==t.x||Number(h)!==t.y||Number(d)!==t.width||Number(f)!==t.height){o();return}try{${childProcessVar}.execFile(\`xprop\`,[\`-id\`,e,\`-f\`,\`_GTK_FRAME_EXTENTS\`,\`32c\`,\`-set\`,\`_GTK_FRAME_EXTENTS\`,\`0, 0, 0, 0\`],{timeout:1e3},e=>{e||(a=!0),o()})}catch{o()}})}catch{o()}};for(let t of r)s(t)};try{${childProcessVar}.execFile(\`xdotool\`,[\`search\`,\`--pid\`,String(process.pid)],{timeout:1e3},(e,t)=>{r([...n,...String(t??\`\`).trim().split(/\\s+/).filter(Boolean)])})}catch{r(n)}}`;

  const interactivityNeedle =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}refreshCursorAtCurrentMousePosition(e){";
  const previousShapeInteractivityNeedle =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1,this.codexLinuxStopAvatarPassthroughRecovery();return}if(process.platform===`linux`&&typeof e.setShape==`function`){this.codexLinuxStopAvatarPassthroughRecovery(),this.mousePassthroughEnabled&&(this.mousePassthroughEnabled=!1,e.setIgnoreMouseEvents(!1));if(this.codexLinuxApplyAvatarInputShape(e))return}process.platform===`linux`&&(this.codexLinuxStartAvatarPassthroughRecovery(),this.codexLinuxSyncAvatarPointerInteractivity(e));let t=!this.pointerInteractive;this.dragState!=null&&(t=!1);if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}codexLinuxStopAvatarPassthroughRecovery(){this.codexLinuxAvatarPassthroughRecoveryTimer!=null&&(clearInterval(this.codexLinuxAvatarPassthroughRecoveryTimer),this.codexLinuxAvatarPassthroughRecoveryTimer=null)}codexLinuxBuildAvatarInputShape(e){let t=this.layout;if(t==null)return null;if(this.dragState!=null){let t=e.getContentBounds();return[{x:0,y:0,width:t.width,height:t.height}]}let r=e.getContentBounds(),i=e=>{if(e==null)return null;let t=Math.max(0,e.left),n=Math.max(0,e.top),i=Math.min(r.width,e.left+e.width)-t,a=Math.min(r.height,e.top+e.height)-n;return i<=0||a<=0?null:{x:t,y:n,width:i,height:a}};return[i(t.mascot),i(t.tray)].filter(Boolean)}codexLinuxApplyAvatarInputShape(e){if(process.platform!==`linux`||e==null||e.isDestroyed()||typeof e.setShape!=`function`)return!1;let t=this.codexLinuxBuildAvatarInputShape(e);if(t==null)return!1;let n=JSON.stringify(t);if(this.codexLinuxAvatarInputShapeKey===n)return!0;try{e.setShape(t),this.codexLinuxAvatarInputShapeKey=n;return!0}catch{this.codexLinuxAvatarInputShapeKey=null;return!1}}codexLinuxStartAvatarPassthroughRecovery(){if(process.platform!==`linux`||this.codexLinuxAvatarPassthroughRecoveryTimer!=null)return;this.codexLinuxAvatarPassthroughRecoveryTimer=setInterval(()=>{let e=this.window;if(e==null||e.isDestroyed()||!e.isVisible()){this.codexLinuxStopAvatarPassthroughRecovery();return}this.codexLinuxSyncAvatarPointerInteractivity(e)&&this.applyPointerInteractivityPolicy()},32),this.codexLinuxAvatarPassthroughRecoveryTimer.unref?.()}codexLinuxSyncAvatarPointerInteractivity(e){if(process.platform!==`linux`||e==null||e.isDestroyed())return!1;if(this.dragState!=null){if(this.pointerInteractive)return!1;return this.pointerInteractive=!0,!0}let t;try{t=this.codexLinuxIsCursorInAvatarInteractiveRegion(e)}catch{t=!0}return this.pointerInteractive===t?!1:(this.pointerInteractive=t,!0)}codexLinuxIsCursorInAvatarInteractiveRegion(e){let t=this.layout;if(t==null)return!1;let r=n.screen.getCursorScreenPoint(),i=e.getContentBounds(),a=r.x-i.x,o=r.y-i.y;if(a<0||o<0||a>i.width||o>i.height)return!1;let s=e=>e!=null&&a>=e.left&&a<=e.left+e.width&&o>=e.top&&o<=e.top+e.height;return s(t.mascot)||s(t.tray)}refreshCursorAtCurrentMousePosition(e){";
  const previousSetShapePolicyPatch =
    "if(process.platform===`linux`&&typeof e.setShape==`function`){this.codexLinuxStopAvatarPassthroughRecovery(),this.mousePassthroughEnabled&&(this.mousePassthroughEnabled=!1,e.setIgnoreMouseEvents(!1));if(this.codexLinuxApplyAvatarInputShape(e))return}";
  const setShapePolicyPatch =
    "if(process.platform===`linux`&&typeof e.setShape==`function`){this.codexLinuxStartAvatarPassthroughRecovery(),this.mousePassthroughEnabled&&(this.mousePassthroughEnabled=!1,e.setIgnoreMouseEvents(!1));if(this.codexLinuxApplyAvatarInputShape(e))return}";
  // previousShapeInteractivityNeedle embeds the older Stop-based policy block;
  // finalize it at build time so the replaceAll below only fires for trees
  // patched by an older wrapper, not on every fresh DMG.
  const interactivityPatch = withElectronAlias(previousShapeInteractivityNeedle)
    .replace(
      "codexLinuxStopAvatarPassthroughRecovery(){",
      `${i3SessionMethod}${compositorHintsMethod}codexLinuxStopAvatarPassthroughRecovery(){`,
    )
    .replaceAll(previousSetShapePolicyPatch, setShapePolicyPatch);

  if (!patchedSource.includes("codexLinuxIsI3Session")) {
    if (patchedSource.includes(interactivityNeedle)) {
      recordStrategy("avatar-interactivity", "upstream");
      patchedSource = patchedSource.replace(interactivityNeedle, interactivityPatch);
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
  if (
    patchedSource.includes("codexLinuxIsI3Session") &&
    !patchedSource.includes("codexLinuxApplyAvatarCompositorHints")
  ) {
    patchedSource = patchedSource.replace(
      `${i3SessionMethod}codexLinuxStopAvatarPassthroughRecovery(){`,
      `${i3SessionMethod}${compositorHintsMethod}codexLinuxStopAvatarPassthroughRecovery(){`,
    );
  }
  patchedSource = upgradeAvatarOverlayInjectedMethods(patchedSource, electronVar);

  const startDragPatch =
    `displayBounds:${electronVar}.screen.getDisplayNearestPoint(${electronVar}.screen.getCursorScreenPoint()).bounds},process.platform===\`linux\`&&(this.pointerInteractive=!0,this.applyPointerInteractivityPolicy())}moveDrag(e){`;
  const startDragRegex =
    /displayBounds:([A-Za-z_$][\w$]*)\.screen\.getDisplayNearestPoint\(\1\.screen\.getCursorScreenPoint\(\)\)\.bounds\}\}moveDrag\(e\)\{/;
  const currentStartDragPatchRegex =
    /displayBounds:([A-Za-z_$][\w$]*)\.screen\.getDisplayNearestPoint\(\1\.screen\.getCursorScreenPoint\(\)\)\.bounds\},process\.platform===`linux`&&\(this\.pointerInteractive=!0,this\.applyPointerInteractivityPolicy\(\)\)\}moveDrag\(e\)\{/;
  if (currentStartDragPatchRegex.test(patchedSource)) {
    recordStrategy("avatar-start-drag", "already-applied");
  } else if (startDragRegex.test(patchedSource)) {
    recordStrategy("avatar-start-drag", "upstream-regex");
    patchedSource = patchedSource.replace(startDragRegex, startDragPatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes(startDragPatch)
  ) {
    recordStrategy("avatar-start-drag", "none");
    console.warn(
      "WARN: Could not find avatar overlay drag start — skipping Linux avatar overlay drag interactivity patch",
    );
  }

  const endDragNeedle =
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}))}";
  const endDragPatch =
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}),process.platform===`linux`&&this.applyPointerInteractivityPolicy())}";
  if (patchedSource.includes(endDragNeedle)) {
    recordStrategy("avatar-end-drag", "upstream");
    patchedSource = patchedSource.replace(endDragNeedle, endDragPatch);
  } else if (patchedSource.includes(endDragPatch)) {
    recordStrategy("avatar-end-drag", "already-applied");
  } else if (
    patchedSource.includes("avatar-overlay")
  ) {
    recordStrategy("avatar-end-drag", "none");
    console.warn(
      "WARN: Could not find avatar overlay drag end — skipping Linux avatar overlay drag cleanup patch",
    );
  }

  const setElementSizeMethod = findAvatarMethod(
    patchedSource,
    /setElementSize\([A-Za-z_$][\w$]*,\{(?:[^{}]*,)?mascot:[A-Za-z_$][\w$]*,tray:[A-Za-z_$][\w$]*(?:,[^{}]*)?\}\)\{/,
  );
  if (setElementSizeMethod != null) {
    if (
      !/this\.(?:applyLayout|applyLatestElementSizes)\([A-Za-z_$][\w$]*\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/.test(setElementSizeMethod.text)
    ) {
      recordStrategy("avatar-element-size", "upstream");
      const patchedMethod = setElementSizeMethod.text.replace(
        /this\.(applyLayout|applyLatestElementSizes)\(([A-Za-z_$][\w$]*)\)(?!,process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\))/g,
        "this.$1($2),process.platform===`linux`&&this.applyPointerInteractivityPolicy()",
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
    !/setElementSize\([^{}]+\)\{[^]*?this\.applyLayout\([A-Za-z_$][\w$]*\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)/.test(patchedSource)
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
    /traySize:this\.traySize\?\?([A-Za-z_$][\w$]*|\([^{};]*?\))\}\);this\.anchor=/;
  const i3TrayFallbackPatch =
    "traySize:process.platform===`linux`&&typeof this.codexLinuxIsI3Session==`function`&&this.codexLinuxIsI3Session()?this.traySize:this.traySize??$1});this.anchor=";
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

  const currentApplyLayoutPatchRegex =
    /this\.setWindowBounds\(e,([A-Za-z_$][\w$]*)\.windowBounds((?:,[A-Za-z_$][\w$]*)*)\),this\.sendLayoutToRenderer\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\)\}getLayout\(e\)\{/;
  const applyLayoutRegex =
    /this\.setWindowBounds\(e,([A-Za-z_$][\w$]*)\.windowBounds((?:,[A-Za-z_$][\w$]*)*)\),this\.sendLayoutToRenderer\(e\)\}getLayout\(e\)\{/;
  if (currentApplyLayoutPatchRegex.test(patchedSource)) {
    recordStrategy("avatar-apply-layout", "already-applied");
  } else if (applyLayoutRegex.test(patchedSource)) {
    recordStrategy("avatar-apply-layout", "upstream");
    patchedSource = patchedSource.replace(
      applyLayoutRegex,
      "this.setWindowBounds(e,$1.windowBounds$2),this.sendLayoutToRenderer(e),process.platform===`linux`&&this.applyPointerInteractivityPolicy()}getLayout(e){",
    );
  } else if (
    patchedSource.includes("avatar-overlay")
  ) {
    recordStrategy("avatar-apply-layout", "none");
    console.warn(
      "WARN: Could not find avatar overlay layout application — skipping Linux avatar overlay layout sync patch",
    );
  }

  const currentShowWindowRegex =
    /e\.moveTop\(\),e\.showInactive\(\),(![A-Za-z_$][\w$]*&&this\.isOpen\(\)&&this\.broadcastOpenState\(\)\}showWindowIfReady\([A-Za-z_$][\w$]*\)\{)/;
  const currentShowWindowPatchRegex =
    /e\.moveTop\(\),e\.showInactive\(\),process\.platform===`linux`&&this\.codexLinuxApplyAvatarCompositorHints\(e\),process\.platform===`linux`&&this\.applyPointerInteractivityPolicy\(\),![A-Za-z_$][\w$]*&&this\.isOpen\(\)&&this\.broadcastOpenState\(\)\}showWindowIfReady\([A-Za-z_$][\w$]*\)\{/;
  if (currentShowWindowPatchRegex.test(patchedSource)) {
    recordStrategy("avatar-show-window", "already-applied");
  } else if (currentShowWindowRegex.test(patchedSource)) {
    recordStrategy("avatar-show-window", "upstream-regex");
    patchedSource = patchedSource.replace(
      currentShowWindowRegex,
      "e.moveTop(),e.showInactive(),process.platform===`linux`&&this.codexLinuxApplyAvatarCompositorHints(e),process.platform===`linux`&&this.applyPointerInteractivityPolicy(),$1",
    );
  } else if (patchedSource.includes("avatar-overlay")) {
    recordStrategy("avatar-show-window", "none");
    console.warn(
      "WARN: Could not find avatar overlay show window — skipping Linux avatar overlay show sync patch",
    );
  }

  const closedPatchRegex =
    /this\.window===[A-Za-z_$][\w$]*&&\(this\.codexLinuxStopAvatarPassthroughRecovery\(\),this\.codexLinuxAvatarInputShapeKey=null,this\.codexLinuxAvatarCompositorHintsApplied=!1,this\.codexLinuxAvatarCompositorHintsApplying=!1,this\.cancelMomentum\(\),[\s\S]*?this\.window=null,/;
  if (closedPatchRegex.test(patchedSource)) {
    recordStrategy("avatar-close-cleanup", "already-applied");
  } else if (/this\.window===([A-Za-z_$][\w$]*)&&\(this\.cancelMomentum\(\),((?:(?!this\.window=null,).)*?)this\.window=null,/.test(patchedSource)) {
    recordStrategy("avatar-close-cleanup", "upstream");
    patchedSource = patchedSource.replace(
      /this\.window===([A-Za-z_$][\w$]*)&&\(this\.cancelMomentum\(\),((?:(?!this\.window=null,).)*?)this\.window=null,/,
      "this.window===$1&&(this.codexLinuxStopAvatarPassthroughRecovery(),this.codexLinuxAvatarInputShapeKey=null,this.codexLinuxAvatarCompositorHintsApplied=!1,this.codexLinuxAvatarCompositorHintsApplying=!1,this.cancelMomentum(),$2this.window=null,",
    );
  } else if (
    patchedSource.includes("avatar-overlay") &&
    patchedSource.includes("codexLinuxStartAvatarPassthroughRecovery")
  ) {
    recordStrategy("avatar-close-cleanup", "none");
    console.warn(
      "WARN: Could not find avatar overlay close cleanup — skipping Linux avatar overlay passthrough cleanup patch",
    );
  }

  return patchedSource;
}

module.exports = {
  applyLinuxAvatarOverlayMousePassthroughPatch,
};
