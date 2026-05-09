"use strict";

const {
  TRAY_GUARD_LOOKAHEAD,
  escapeRegExp,
  findCallBlock,
  findMatchingBrace,
  inferModuleAlias,
  requireName,
} = require("./shared.js");

// Main-process patches adapt Electron shell behavior: windows, tray, menu,
// single-instance handling, file manager integration, and packaged runtime glue.
function applyLinuxFileManagerPatch(currentSource) {
  const block = findCallBlock(currentSource, "id:`fileManager`");
  if (block == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  if (block.text.includes("linux:{")) {
    return currentSource;
  }

  const electronVar = requireName(currentSource, "electron");
  const fsVar = requireName(currentSource, "node:fs");
  const pathVar = requireName(currentSource, "node:path");
  if (electronVar == null || fsVar == null || pathVar == null) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const insertionPoint = block.text.lastIndexOf("}});");
  if (insertionPoint === -1) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  const linuxFileManager =
    `,linux:{label:\`File Manager\`,icon:\`apps/file-explorer.png\`,detect:()=>\`linux-file-manager\`,args:e=>[e],open:async({path:e})=>{let __codexResolved=e;for(;;){if((0,${fsVar}.existsSync)(__codexResolved))break;let __codexParent=(0,${pathVar}.dirname)(__codexResolved);if(__codexParent===__codexResolved){__codexResolved=null;break}__codexResolved=__codexParent}let __codexOpenTarget=__codexResolved??e;if((0,${fsVar}.existsSync)(__codexOpenTarget)&&(0,${fsVar}.statSync)(__codexOpenTarget).isFile())__codexOpenTarget=(0,${pathVar}.dirname)(__codexOpenTarget);let __codexError=await ${electronVar}.shell.openPath(__codexOpenTarget);if(__codexError)throw Error(__codexError)}}`;

  const patchedBlock =
    block.text.slice(0, insertionPoint + 1) +
    linuxFileManager +
    block.text.slice(insertionPoint + 1);
  const patchedSource =
    currentSource.slice(0, block.start) + patchedBlock + currentSource.slice(block.end);

  const patchedBlockCheck = patchedSource.slice(block.start, block.start + patchedBlock.length);
  if (
    !patchedBlockCheck.includes("linux:{label:`File Manager`") ||
    !patchedBlockCheck.includes("detect:()=>`linux-file-manager`") ||
    !patchedBlockCheck.includes(`${electronVar}.shell.openPath(__codexOpenTarget)`)
  ) {
    console.warn("Failed to apply Linux File Manager Patch");
    return currentSource;
  }

  return patchedSource;
}

function applyLinuxWindowOptionsPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const windowOptionsNeedle = "...process.platform===`win32`?{autoHideMenuBar:!0}:{},";
  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  const iconPathNeedle = `icon:${iconPathExpression}`;
  const windowOptionsReplacement =
    `...process.platform===\`win32\`||process.platform===\`linux\`?{autoHideMenuBar:!0,...process.platform===\`linux\`?{${iconPathNeedle}}:{}}:{},`;

  if (currentSource.includes(iconPathNeedle)) {
    return currentSource;
  }

  if (currentSource.includes(windowOptionsNeedle)) {
    return currentSource.replace(windowOptionsNeedle, windowOptionsReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow autoHideMenuBar snippet — skipping window options patch");
  return currentSource;
}

function applyLinuxMenuPatch(currentSource) {
  const menuRegex = /process\.platform===`win32`&&([A-Za-z_$][\w$]*)\.removeMenu\(\),/g;
  let patchedAny = false;
  const patchedSource = currentSource.replace(menuRegex, (match, windowVar) => {
    const linuxPatch = `process.platform===\`linux\`&&${windowVar}.setMenuBarVisibility(!1),`;
    if (currentSource.includes(`${linuxPatch}${match}`)) {
      return match;
    }
    patchedAny = true;
    return `${linuxPatch}${match}`;
  });

  if (!patchedAny && menuRegex.test(currentSource) && !currentSource.includes("setMenuBarVisibility(!1),process.platform===`win32`")) {
    console.warn("WARN: Could not find window menu visibility snippet — skipping menu patch");
  }

  return patchedSource;
}

function applyLinuxSetIconPatch(currentSource, iconAsset) {
  if (iconAsset == null) {
    return currentSource;
  }

  const iconPathExpression = `process.resourcesPath+\`/../content/webview/assets/${iconAsset}\``;
  if (currentSource.includes(`setIcon(${iconPathExpression})`)) {
    return currentSource;
  }

  const readyRegex = /([A-Za-z_$][\w$]*)\.once\(`ready-to-show`,\(\)=>\{/;
  const match = currentSource.match(readyRegex);
  if (match == null) {
    console.warn("WARN: Could not find window setIcon insertion point — skipping setIcon patch");
    return currentSource;
  }

  const windowVar = match[1];
  return currentSource.replace(
    readyRegex,
    `process.platform===\`linux\`&&${windowVar}.setIcon(${iconPathExpression}),${match[0]}`,
  );
}

function applyLinuxAvatarOverlayMousePassthroughPatch(currentSource) {
  let patchedSource = currentSource;

  const interactivityNeedle =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}refreshCursorAtCurrentMousePosition(e){";
  const previousInteractivityNeedle =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1,this.codexLinuxStopAvatarPassthroughRecovery();return}let t=!this.pointerInteractive;if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0}),this.codexLinuxStartAvatarPassthroughRecovery();return}this.codexLinuxStopAvatarPassthroughRecovery(),e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}else t&&this.codexLinuxStartAvatarPassthroughRecovery()}codexLinuxStopAvatarPassthroughRecovery(){this.codexLinuxAvatarPassthroughRecoveryTimer!=null&&(clearInterval(this.codexLinuxAvatarPassthroughRecoveryTimer),this.codexLinuxAvatarPassthroughRecoveryTimer=null)}codexLinuxRecoverAvatarPointerInteractivity(){this.pointerInteractive=!0,this.applyPointerInteractivityPolicy()}codexLinuxStartAvatarPassthroughRecovery(){if(process.platform!==`linux`||this.codexLinuxAvatarPassthroughRecoveryTimer!=null)return;this.codexLinuxAvatarPassthroughRecoveryTimer=setInterval(()=>{let e=this.window;if(e==null||e.isDestroyed()||!this.mousePassthroughEnabled){this.codexLinuxStopAvatarPassthroughRecovery();return}let t;try{t=this.codexLinuxIsCursorInAvatarInteractiveRegion(e)}catch{this.codexLinuxRecoverAvatarPointerInteractivity();return}t&&this.codexLinuxRecoverAvatarPointerInteractivity()},80),this.codexLinuxAvatarPassthroughRecoveryTimer.unref?.()}codexLinuxIsCursorInAvatarInteractiveRegion(e){let t=this.layout;if(t==null)return!1;let r=n.screen.getCursorScreenPoint(),i=e.getContentBounds(),a=r.x-i.x,o=r.y-i.y,s=e=>e!=null&&a>=e.left&&a<=e.left+e.width&&o>=e.top&&o<=e.top+e.height;return s(t.mascot)||s(t.tray)}refreshCursorAtCurrentMousePosition(e){";
  const previousSyncInteractivityNeedle =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1,this.codexLinuxStopAvatarPassthroughRecovery();return}process.platform===`linux`&&(this.codexLinuxStartAvatarPassthroughRecovery(),this.codexLinuxSyncAvatarPointerInteractivity(e));let t=!this.pointerInteractive;this.dragState!=null&&(t=!1);if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}codexLinuxStopAvatarPassthroughRecovery(){this.codexLinuxAvatarPassthroughRecoveryTimer!=null&&(clearInterval(this.codexLinuxAvatarPassthroughRecoveryTimer),this.codexLinuxAvatarPassthroughRecoveryTimer=null)}codexLinuxStartAvatarPassthroughRecovery(){if(process.platform!==`linux`||this.codexLinuxAvatarPassthroughRecoveryTimer!=null)return;this.codexLinuxAvatarPassthroughRecoveryTimer=setInterval(()=>{let e=this.window;if(e==null||e.isDestroyed()||!e.isVisible()){this.codexLinuxStopAvatarPassthroughRecovery();return}this.codexLinuxSyncAvatarPointerInteractivity(e)&&this.applyPointerInteractivityPolicy()},32),this.codexLinuxAvatarPassthroughRecoveryTimer.unref?.()}codexLinuxSyncAvatarPointerInteractivity(e){if(process.platform!==`linux`||e==null||e.isDestroyed())return!1;if(this.dragState!=null){if(this.pointerInteractive)return!1;return this.pointerInteractive=!0,!0}let t;try{t=this.codexLinuxIsCursorInAvatarInteractiveRegion(e)}catch{t=!0}return this.pointerInteractive===t?!1:(this.pointerInteractive=t,!0)}codexLinuxIsCursorInAvatarInteractiveRegion(e){let t=this.layout;if(t==null)return!1;let r=n.screen.getCursorScreenPoint(),i=e.getContentBounds(),a=r.x-i.x,o=r.y-i.y;if(a<0||o<0||a>i.width||o>i.height)return!1;let s=e=>e!=null&&a>=e.left&&a<=e.left+e.width&&o>=e.top&&o<=e.top+e.height;return s(t.mascot)||s(t.tray)}refreshCursorAtCurrentMousePosition(e){";
  const interactivityPatch =
    "applyPointerInteractivityPolicy(){let e=this.window;if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1,this.codexLinuxStopAvatarPassthroughRecovery();return}if(process.platform===`linux`&&typeof e.setShape==`function`){this.codexLinuxStopAvatarPassthroughRecovery(),this.mousePassthroughEnabled&&(this.mousePassthroughEnabled=!1,e.setIgnoreMouseEvents(!1));if(this.codexLinuxApplyAvatarInputShape(e))return}process.platform===`linux`&&(this.codexLinuxStartAvatarPassthroughRecovery(),this.codexLinuxSyncAvatarPointerInteractivity(e));let t=!this.pointerInteractive;this.dragState!=null&&(t=!1);if(this.mousePassthroughEnabled!==t){if(this.mousePassthroughEnabled=t,t){e.setIgnoreMouseEvents(!0,{forward:!0});return}e.setIgnoreMouseEvents(!1),this.refreshCursorAtCurrentMousePosition(e)}}codexLinuxStopAvatarPassthroughRecovery(){this.codexLinuxAvatarPassthroughRecoveryTimer!=null&&(clearInterval(this.codexLinuxAvatarPassthroughRecoveryTimer),this.codexLinuxAvatarPassthroughRecoveryTimer=null)}codexLinuxBuildAvatarInputShape(e){let t=this.layout;if(t==null)return null;if(this.dragState!=null){let t=e.getContentBounds();return[{x:0,y:0,width:t.width,height:t.height}]}let r=e.getContentBounds(),i=e=>{if(e==null)return null;let t=Math.max(0,e.left),n=Math.max(0,e.top),i=Math.min(r.width,e.left+e.width)-t,a=Math.min(r.height,e.top+e.height)-n;return i<=0||a<=0?null:{x:t,y:n,width:i,height:a}};return[i(t.mascot),i(t.tray)].filter(Boolean)}codexLinuxApplyAvatarInputShape(e){if(process.platform!==`linux`||e==null||e.isDestroyed()||typeof e.setShape!=`function`)return!1;let t=this.codexLinuxBuildAvatarInputShape(e);if(t==null)return!1;let n=JSON.stringify(t);if(this.codexLinuxAvatarInputShapeKey===n)return!0;try{e.setShape(t),this.codexLinuxAvatarInputShapeKey=n;return!0}catch{this.codexLinuxAvatarInputShapeKey=null;return!1}}codexLinuxStartAvatarPassthroughRecovery(){if(process.platform!==`linux`||this.codexLinuxAvatarPassthroughRecoveryTimer!=null)return;this.codexLinuxAvatarPassthroughRecoveryTimer=setInterval(()=>{let e=this.window;if(e==null||e.isDestroyed()||!e.isVisible()){this.codexLinuxStopAvatarPassthroughRecovery();return}this.codexLinuxSyncAvatarPointerInteractivity(e)&&this.applyPointerInteractivityPolicy()},32),this.codexLinuxAvatarPassthroughRecoveryTimer.unref?.()}codexLinuxSyncAvatarPointerInteractivity(e){if(process.platform!==`linux`||e==null||e.isDestroyed())return!1;if(this.dragState!=null){if(this.pointerInteractive)return!1;return this.pointerInteractive=!0,!0}let t;try{t=this.codexLinuxIsCursorInAvatarInteractiveRegion(e)}catch{t=!0}return this.pointerInteractive===t?!1:(this.pointerInteractive=t,!0)}codexLinuxIsCursorInAvatarInteractiveRegion(e){let t=this.layout;if(t==null)return!1;let r=n.screen.getCursorScreenPoint(),i=e.getContentBounds(),a=r.x-i.x,o=r.y-i.y;if(a<0||o<0||a>i.width||o>i.height)return!1;let s=e=>e!=null&&a>=e.left&&a<=e.left+e.width&&o>=e.top&&o<=e.top+e.height;return s(t.mascot)||s(t.tray)}refreshCursorAtCurrentMousePosition(e){";

  if (!patchedSource.includes("codexLinuxApplyAvatarInputShape")) {
    if (patchedSource.includes(interactivityNeedle)) {
      patchedSource = patchedSource.replace(interactivityNeedle, interactivityPatch);
    } else if (patchedSource.includes(previousInteractivityNeedle)) {
      patchedSource = patchedSource.replace(previousInteractivityNeedle, interactivityPatch);
    } else if (patchedSource.includes(previousSyncInteractivityNeedle)) {
      patchedSource = patchedSource.replace(previousSyncInteractivityNeedle, interactivityPatch);
    } else if (
      patchedSource.includes("avatar-overlay") &&
      patchedSource.includes("applyPointerInteractivityPolicy(){let e=this.window")
    ) {
      console.warn(
        "WARN: Could not find avatar overlay mouse passthrough policy — skipping Linux avatar overlay passthrough recovery patch",
      );
      return currentSource;
    }
  }

  const previousStartDragPatch =
    "startDrag(e,{pointerWindowX:t,pointerWindowY:r}){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e)return;this.pointerInteractive=!0,this.applyPointerInteractivityPolicy(),this.cancelMomentum();";
  const originalStartDragPrefix =
    "startDrag(e,{pointerWindowX:t,pointerWindowY:r}){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e)return;this.cancelMomentum();";
  const startDragNeedle =
    "displayBounds:n.screen.getDisplayNearestPoint(n.screen.getCursorScreenPoint()).bounds}}moveDrag(e){";
  const startDragPatch =
    "displayBounds:n.screen.getDisplayNearestPoint(n.screen.getCursorScreenPoint()).bounds},process.platform===`linux`&&(this.pointerInteractive=!0,this.applyPointerInteractivityPolicy())}moveDrag(e){";
  const previousStartDragAfterStatePatch =
    "displayBounds:n.screen.getDisplayNearestPoint(n.screen.getCursorScreenPoint()).bounds},this.pointerInteractive=!0,this.applyPointerInteractivityPolicy()}moveDrag(e){";
  if (patchedSource.includes(previousStartDragPatch)) {
    patchedSource = patchedSource.replace(previousStartDragPatch, originalStartDragPrefix);
  }
  if (patchedSource.includes(previousStartDragAfterStatePatch)) {
    patchedSource = patchedSource.replace(previousStartDragAfterStatePatch, startDragPatch);
  } else if (patchedSource.includes(startDragNeedle)) {
    patchedSource = patchedSource.replace(startDragNeedle, startDragPatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes(startDragPatch)
  ) {
    console.warn(
      "WARN: Could not find avatar overlay drag start — skipping Linux avatar overlay drag interactivity patch",
    );
  }

  const endDragNeedle =
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}))}";
  const endDragPatch =
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}),process.platform===`linux`&&this.applyPointerInteractivityPolicy())}";
  const previousEndDragPatch =
    "endDrag(e){let t=this.window;t==null||t.isDestroyed()||t.webContents.id!==e||(this.dragState?.hasMoved&&this.moveDragToCurrentCursor(t),this.dragState=null,this.reclampWindowToVisibleDisplay({shouldPersist:!0}),this.codexLinuxSyncAvatarPointerInteractivity(t)&&this.applyPointerInteractivityPolicy())}";
  if (patchedSource.includes(previousEndDragPatch)) {
    patchedSource = patchedSource.replace(previousEndDragPatch, endDragPatch);
  } else if (patchedSource.includes(endDragNeedle)) {
    patchedSource = patchedSource.replace(endDragNeedle, endDragPatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes(endDragPatch)
  ) {
    console.warn(
      "WARN: Could not find avatar overlay drag end — skipping Linux avatar overlay drag cleanup patch",
    );
  }

  const setElementSizeNeedle =
    "setElementSize(e,{mascot:t,tray:n}){let r=this.window;r==null||r.isDestroyed()||r.webContents.id!==e||(this.cancelMomentum(),this.anchor={...this.anchor,width:t.width,height:t.height},this.mascotSize=t,this.traySize=n,this.applyLayout(r))}";
  const setElementSizePatch =
    "setElementSize(e,{mascot:t,tray:n}){let r=this.window;r==null||r.isDestroyed()||r.webContents.id!==e||(this.cancelMomentum(),this.anchor={...this.anchor,width:t.width,height:t.height},this.mascotSize=t,this.traySize=n,this.applyLayout(r),process.platform===`linux`&&this.applyPointerInteractivityPolicy())}";
  const previousSetElementSizePatch =
    "setElementSize(e,{mascot:t,tray:n}){let r=this.window;r==null||r.isDestroyed()||r.webContents.id!==e||(this.cancelMomentum(),this.anchor={...this.anchor,width:t.width,height:t.height},this.mascotSize=t,this.traySize=n,this.applyLayout(r),this.codexLinuxSyncAvatarPointerInteractivity(r)&&this.applyPointerInteractivityPolicy())}";
  if (patchedSource.includes(previousSetElementSizePatch)) {
    patchedSource = patchedSource.replace(previousSetElementSizePatch, setElementSizePatch);
  } else if (patchedSource.includes(setElementSizeNeedle)) {
    patchedSource = patchedSource.replace(setElementSizeNeedle, setElementSizePatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes(setElementSizePatch)
  ) {
    console.warn(
      "WARN: Could not find avatar overlay element size update — skipping Linux avatar overlay layout interactivity patch",
    );
  }

  const applyLayoutNeedle =
    "this.setWindowBounds(e,r.windowBounds),this.sendLayoutToRenderer(e)}getLayout(e){";
  const applyLayoutPatch =
    "this.setWindowBounds(e,r.windowBounds),this.sendLayoutToRenderer(e),process.platform===`linux`&&this.applyPointerInteractivityPolicy()}getLayout(e){";
  const previousApplyLayoutPatch =
    "this.setWindowBounds(e,r.windowBounds),this.sendLayoutToRenderer(e),this.codexLinuxSyncAvatarPointerInteractivity(e)&&this.applyPointerInteractivityPolicy()}getLayout(e){";
  if (patchedSource.includes(previousApplyLayoutPatch)) {
    patchedSource = patchedSource.replace(previousApplyLayoutPatch, applyLayoutPatch);
  } else if (patchedSource.includes(applyLayoutNeedle)) {
    patchedSource = patchedSource.replace(applyLayoutNeedle, applyLayoutPatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes(applyLayoutPatch)
  ) {
    console.warn(
      "WARN: Could not find avatar overlay layout application — skipping Linux avatar overlay layout sync patch",
    );
  }

  const showWindowNeedle =
    "e.moveTop(),e.showInactive(),!t&&this.isOpen()&&this.broadcastOpenState()}broadcastOpenState(){";
  const showWindowPatch =
    "e.moveTop(),e.showInactive(),process.platform===`linux`&&this.applyPointerInteractivityPolicy(),!t&&this.isOpen()&&this.broadcastOpenState()}broadcastOpenState(){";
  const previousShowWindowPatch =
    "e.moveTop(),e.showInactive(),process.platform===`linux`&&this.codexLinuxStartAvatarPassthroughRecovery(),this.codexLinuxSyncAvatarPointerInteractivity(e)&&this.applyPointerInteractivityPolicy(),!t&&this.isOpen()&&this.broadcastOpenState()}broadcastOpenState(){";
  if (patchedSource.includes(previousShowWindowPatch)) {
    patchedSource = patchedSource.replace(previousShowWindowPatch, showWindowPatch);
  } else if (patchedSource.includes(showWindowNeedle)) {
    patchedSource = patchedSource.replace(showWindowNeedle, showWindowPatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    !patchedSource.includes(showWindowPatch)
  ) {
    console.warn(
      "WARN: Could not find avatar overlay show window — skipping Linux avatar overlay show sync patch",
    );
  }

  const closedNeedle = "this.window===t&&(this.cancelMomentum(),this.window=null,";
  const closedPatch =
    "this.window===t&&(this.codexLinuxStopAvatarPassthroughRecovery(),this.codexLinuxAvatarInputShapeKey=null,this.cancelMomentum(),this.window=null,";
  const previousClosedPatch =
    "this.window===t&&(this.codexLinuxStopAvatarPassthroughRecovery(),this.cancelMomentum(),this.window=null,";
  if (patchedSource.includes(previousClosedPatch)) {
    patchedSource = patchedSource.replace(previousClosedPatch, closedPatch);
  } else if (patchedSource.includes(closedNeedle)) {
    patchedSource = patchedSource.replace(closedNeedle, closedPatch);
  } else if (
    patchedSource.includes("avatar-overlay") &&
    patchedSource.includes("codexLinuxStartAvatarPassthroughRecovery") &&
    !patchedSource.includes(closedPatch)
  ) {
    console.warn(
      "WARN: Could not find avatar overlay close cleanup — skipping Linux avatar overlay passthrough cleanup patch",
    );
  }

  return patchedSource;
}

function applyLinuxOpaqueBackgroundPatch(currentSource) {
  if (currentSource.includes("===`linux`&&!OM(")) {
    return currentSource;
  }

  const colorConstRegex =
    /([A-Za-z_$][\w$]*)=`#00000000`,([A-Za-z_$][\w$]*)=`#000000`,([A-Za-z_$][\w$]*)=`#f9f9f9`/;
  const colorMatch = currentSource.match(colorConstRegex);

  if (!colorMatch) {
    console.warn(
      "WARN: Could not find color constants (#00000000, #000000, #f9f9f9) — skipping background patch",
    );
    return currentSource;
  }

  const [, transparentVar, darkVar, lightVar] = colorMatch;
  const funcParamRegex =
    /function\s+[A-Za-z_$][\w$]*\(\{platform:([A-Za-z_$][\w$]*),appearance:([A-Za-z_$][\w$]*),opaqueWindowsEnabled:[A-Za-z_$][\w$]*,prefersDarkColors:([A-Za-z_$][\w$]*)\}\)\{return\s*\1===`win32`&&!([A-Za-z_$][\w$]*)\(\2\)/;
  const funcMatch = currentSource.match(funcParamRegex);

  if (funcMatch == null) {
    console.warn("WARN: Could not find BrowserWindow background function signature — skipping background patch");
    return currentSource;
  }

  const [, platformParam, appearanceParam, darkColorsParam, transparentAppearancePredicate] =
    funcMatch;
  const bgNeedle =
    `backgroundMaterial:\`mica\`}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const oldLinuxBgPatch =
    `backgroundMaterial:\`mica\`}:process.platform===\`linux\`?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;
  const bgReplacement =
    `backgroundMaterial:\`mica\`}:${platformParam}===\`linux\`&&!${transparentAppearancePredicate}(${appearanceParam})?{backgroundColor:${darkColorsParam}?${darkVar}:${lightVar},backgroundMaterial:null}:{backgroundColor:${transparentVar},backgroundMaterial:null}}`;

  if (currentSource.includes(bgNeedle)) {
    return currentSource.replace(bgNeedle, bgReplacement);
  }
  if (currentSource.includes(oldLinuxBgPatch)) {
    return currentSource.replace(oldLinuxBgPatch, bgReplacement);
  }

  console.warn("WARN: Could not find BrowserWindow background color needle — skipping background patch");
  return currentSource;
}

function findNamedFunctionBody(source, functionName) {
  const functionMatch = source.match(
    new RegExp(`(?:async\\s+)?function\\s+${escapeRegExp(functionName)}\\([^)]*\\)\\{`),
  );
  if (functionMatch == null) {
    return null;
  }

  const openIndex = functionMatch.index + functionMatch[0].length - 1;
  const closeIndex = findMatchingBrace(source, openIndex);
  return closeIndex === -1 ? null : source.slice(openIndex, closeIndex + 1);
}

function isTrayFactoryFunction(source, functionName) {
  const body = findNamedFunctionBody(source, functionName);
  return body != null && /new [A-Za-z_$][\w$]*\.Tray\(/.test(body);
}

function findDynamicTraySetup(source) {
  const setupRegex =
    /let ([A-Za-z_$][\w$]*)=async\(\)=>\{[A-Za-z_$][\w$]*=!0;try\{await ([A-Za-z_$][\w$]*)\(\{buildFlavor:/g;
  let match;
  while ((match = setupRegex.exec(source)) != null) {
    const [, setupFn, factoryFn] = match;
    if (isTrayFactoryFunction(source, factoryFn)) {
      return { setupFn, index: match.index };
    }
  }
  return null;
}

function findDynamicTrayStartupCall(source, setupFn, startIndex) {
  const startupRegex = new RegExp(`([A-Za-z_$][\\w$]*)&&${escapeRegExp(setupFn)}\\(\\);`, "g");
  startupRegex.lastIndex = startIndex;
  return startupRegex.exec(source);
}

function applyLinuxQuitGuardPatch(currentSource) {
  let patchedSource = currentSource;

  const quitGuardNeedle = "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);";
  const quitGuardPatch =
    "let n=require(`electron`),i=require(`node:path`),o=require(`node:fs`);let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";
  const quitGuardSuffix =
    "let codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;";

  if (patchedSource.includes("codexLinuxQuitInProgress=!1,codexLinuxMarkQuitInProgress=()=>{codexLinuxQuitInProgress=!0},codexLinuxIsQuitInProgress=()=>codexLinuxQuitInProgress===!0;")) {
    return patchedSource;
  }

  if (patchedSource.includes(quitGuardNeedle)) {
    return patchedSource.replace(quitGuardNeedle, quitGuardPatch);
  }

  const splitQuitGuardNeedle =
    /let ([A-Za-z_$][\w$]*)=require\(`electron`\);(?:\1=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:path`\);(?:\2=[^;]+;)?let ([A-Za-z_$][\w$]*)=require\(`node:fs`\);(?:\3=[^;]+;)?/;
  const splitQuitGuardMatch = patchedSource.match(splitQuitGuardNeedle);
  if (splitQuitGuardMatch != null) {
    const matchedPrefix = splitQuitGuardMatch[0];
    return patchedSource.replace(matchedPrefix, `${matchedPrefix}${quitGuardSuffix}`);
  }

  if (patchedSource.includes("require(`electron`)")) {
    return `${quitGuardSuffix}${patchedSource}`;
  }

  if (patchedSource.includes("require(`electron`)") && patchedSource.includes("require(`node:path`)")) {
    console.warn("WARN: Could not find Linux quit guard insertion point — skipping explicit quit-state patch");
  }

  return patchedSource;
}

function applyLinuxExplicitTrayQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression =
    "typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";

  const trayQuitNeedle = "{label:rB(this.appName),click:()=>{n.app.quit()}}";
  const trayQuitPatch =
    `{label:rB(this.appName),click:()=>{${quitMarkerExpression}n.app.quit()}}`;
  const trayQuitRegex =
    /\{label:rB\(([^)]+)\),click:\(\)=>\{([A-Za-z_$][\w$]*)\.app\.quit\(\)\}\}/;
  if (patchedSource.includes(trayQuitPatch)) {
    // Already patched.
  } else if (patchedSource.includes(trayQuitNeedle)) {
    patchedSource = patchedSource.replace(trayQuitNeedle, trayQuitPatch);
  } else if (trayQuitRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      trayQuitRegex,
      (_match, appNameExpr, electronVar) =>
        `{label:rB(${appNameExpr}),click:()=>{${quitMarkerExpression}${electronVar}.app.quit()}}`,
    );
  } else if (
    patchedSource.includes("getNativeTrayMenuItems(){") &&
    (patchedSource.includes("label:rB(") || patchedSource.includes("role:`quit`"))
  ) {
    console.warn("WARN: Could not find tray quit menu handler — skipping Linux explicit tray quit patch");
  }

  return patchedSource;
}

function applyLinuxExplicitIpcQuitPatch(currentSource) {
  let patchedSource = currentSource;

  const quitMarkerExpression =
    "typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress(),";

  const quitAppNeedle = "if(o.type===`quit-app`){n.app.quit();return}";
  const quitAppPatch = `if(o.type===\`quit-app\`){${quitMarkerExpression}n.app.quit();return}`;
  const quitAppRegex =
    /if\(([A-Za-z_$][\w$]*)\.type===`quit-app`\)\{([A-Za-z_$][\w$]*)\.app\.quit\(\);return\}/;
  if (patchedSource.includes(quitAppPatch)) {
    // Already patched.
  } else if (patchedSource.includes(quitAppNeedle)) {
    patchedSource = patchedSource.replace(quitAppNeedle, quitAppPatch);
  } else if (quitAppRegex.test(patchedSource)) {
    patchedSource = patchedSource.replace(
      quitAppRegex,
      (_match, messageVar, electronVar) =>
        `if(${messageVar}.type===\`quit-app\`){${quitMarkerExpression}${electronVar}.app.quit();return}`,
    );
  } else if (patchedSource.includes("type===`quit-app`")) {
    console.warn("WARN: Could not find quit-app IPC handler — skipping Linux explicit quit-app patch");
  }

  return patchedSource;
}

function applyLinuxTrayPatch(currentSource, iconPathExpression) {
  let patchedSource = currentSource;

  const trayGuardNeedle =
    "process.platform!==`win32`&&process.platform!==`darwin`?null:";
  const trayGuardPatch =
    "process.platform!==`win32`&&process.platform!==`darwin`&&process.platform!==`linux`?null:";
  const trayGuardIndex = patchedSource.indexOf(trayGuardNeedle);
  if (patchedSource.includes(trayGuardPatch)) {
    // Already patched.
  } else if (
    trayGuardIndex !== -1 &&
    patchedSource.slice(trayGuardIndex, trayGuardIndex + TRAY_GUARD_LOOKAHEAD).includes("new n.Tray")
  ) {
    patchedSource = patchedSource.replace(trayGuardNeedle, trayGuardPatch);
  } else {
    console.warn("WARN: Could not find tray platform guard — skipping Linux tray guard patch");
  }

  if (iconPathExpression != null) {
    const trayIconNeedle =
      "for(let e of o){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}return{defaultIcon:await n.app.getFileIcon(process.execPath,{size:process.platform===`win32`?`small`:`normal`}),chronicleRunningIcon:null}}";
    const trayIconPatch =
      `for(let e of o){let t=n.nativeImage.createFromPath(e);if(!t.isEmpty())return{defaultIcon:t,chronicleRunningIcon:null}}if(process.platform===\`linux\`){let e=n.nativeImage.createFromPath(${iconPathExpression});if(!e.isEmpty())return{defaultIcon:e,chronicleRunningIcon:null}}return{defaultIcon:await n.app.getFileIcon(process.execPath,{size:process.platform===\`win32\`?\`small\`:\`normal\`}),chronicleRunningIcon:null}}`;
    if (patchedSource.includes(`nativeImage.createFromPath(${iconPathExpression})`)) {
      // Already patched.
    } else if (patchedSource.includes(trayIconNeedle)) {
      patchedSource = patchedSource.replace(trayIconNeedle, trayIconPatch);
    } else {
      console.warn("WARN: Could not find tray icon fallback — skipping Linux tray icon patch");
    }
  }

  const closeToTrayNeedle =
    "if(process.platform===`win32`&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}";
  const closeToTrayExistingPatch =
    "if((process.platform===`win32`||process.platform===`linux`)&&f===`local`&&!this.isAppQuitting&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}";
  const closeToTrayPatch =
    "if((process.platform===`win32`||process.platform===`linux`)&&f===`local`&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.options.canHideLastLocalWindowToTray?.()===!0&&!t){e.preventDefault(),k.hide();return}";
  const patchedCloseToTrayRegex =
    /if\(\(process\.platform===`win32`\|\|process\.platform===`linux`\)&&[A-Za-z_$][\w$]*===`local`&&!this\.isAppQuitting&&!\(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress\(\)\)&&this\.options\.canHideLastLocalWindowToTray\?\.\(\)===!0&&![A-Za-z_$][\w$]*\)\{[A-Za-z_$][\w$]*\.preventDefault\(\),[A-Za-z_$][\w$]*\.hide\(\);return\}/;
  if (patchedSource.includes(closeToTrayPatch)) {
    // Already patched.
  } else if (patchedSource.includes(closeToTrayExistingPatch)) {
    patchedSource = patchedSource.replace(closeToTrayExistingPatch, closeToTrayPatch);
  } else if (patchedSource.includes(closeToTrayNeedle)) {
    patchedSource = patchedSource.replace(closeToTrayNeedle, closeToTrayPatch);
  } else if (patchedCloseToTrayRegex.test(patchedSource)) {
    // Already patched with a newer minifier's window variable.
  } else {
    const closeToTrayRegex =
      /if\(process\.platform===`win32`&&([A-Za-z_$][\w$]*)===`local`&&!this\.isAppQuitting&&this\.options\.canHideLastLocalWindowToTray\?\.\(\)===!0&&!([A-Za-z_$][\w$]*)\)\{([A-Za-z_$][\w$]*)\.preventDefault\(\),([A-Za-z_$][\w$]*)\.hide\(\);return\}/;
    const closeToTrayMatch = patchedSource.match(closeToTrayRegex);
    if (closeToTrayMatch != null) {
      const [, hostVar, hasOtherWindowVar, eventVar, windowVar] = closeToTrayMatch;
      patchedSource = patchedSource.replace(
        closeToTrayRegex,
        `if((process.platform===\`win32\`||process.platform===\`linux\`)&&${hostVar}===\`local\`&&!this.isAppQuitting&&!(typeof codexLinuxIsQuitInProgress===\`function\`&&codexLinuxIsQuitInProgress())&&this.options.canHideLastLocalWindowToTray?.()===!0&&!${hasOtherWindowVar}){${eventVar}.preventDefault(),${windowVar}.hide();return}`,
      );
    } else {
      console.warn("WARN: Could not find close-to-tray condition — skipping Linux close-to-tray patch");
    }
  }

  const trayContextMethodNeedle =
    "trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};constructor(";
  const trayContextMethodPatch =
    "trayMenuThreads={runningThreads:[],unreadThreads:[],pinnedThreads:[],recentThreads:[],usageLimits:[]};setLinuxTrayContextMenu(){let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());this.tray.setContextMenu?.(e);return e}constructor(";
  if (patchedSource.includes("setLinuxTrayContextMenu(){")) {
    // Already patched.
  } else if (patchedSource.includes(trayContextMethodNeedle)) {
    patchedSource = patchedSource.replace(trayContextMethodNeedle, trayContextMethodPatch);
  } else {
    console.warn("WARN: Could not find tray controller fields — skipping Linux tray context menu method patch");
  }

  const trayClickNeedle =
    "this.tray.on(`click`,()=>{this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const trayClickPatchWithoutContextSetup =
    "this.tray.on(`click`,()=>{process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const trayClickPatch =
    "process.platform===`linux`&&this.setLinuxTrayContextMenu(),this.tray.on(`click`,()=>{process.platform===`linux`?this.openNativeTrayMenu():this.onTrayButtonClick()}),this.tray.on(`right-click`,()=>{this.openNativeTrayMenu()})}";
  const canSetLinuxTrayContextMenu = patchedSource.includes("setLinuxTrayContextMenu(){");
  if (patchedSource.includes("process.platform===`linux`&&this.setLinuxTrayContextMenu(),this.tray.on(`click`")) {
    // Already patched.
  } else if (patchedSource.includes(trayClickNeedle)) {
    patchedSource = patchedSource.replace(
      trayClickNeedle,
      canSetLinuxTrayContextMenu ? trayClickPatch : trayClickPatchWithoutContextSetup,
    );
  } else if (canSetLinuxTrayContextMenu && patchedSource.includes(trayClickPatchWithoutContextSetup)) {
    patchedSource = patchedSource.replace(trayClickPatchWithoutContextSetup, trayClickPatch);
  } else {
    console.warn("WARN: Could not find tray click handler — skipping Linux tray menu click patch");
  }

  const trayMenuBuildNeedle =
    "openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());";
  const trayMenuBuildExistingPatch =
    "openNativeTrayMenu(){this.updateChronicleTrayIcon();let e=process.platform===`linux`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());";
  const trayMenuBuildPatch =
    "openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;this.updateChronicleTrayIcon();let e=process.platform===`linux`&&this.setLinuxTrayContextMenu?this.setLinuxTrayContextMenu():n.Menu.buildFromTemplate(this.getNativeTrayMenuItems());";
  if (patchedSource.includes("openNativeTrayMenu(){if(process.platform===`linux`&&(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress()))return;")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuBuildExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuBuildExistingPatch, trayMenuBuildPatch);
  } else if (patchedSource.includes(trayMenuBuildNeedle)) {
    patchedSource = patchedSource.replace(trayMenuBuildNeedle, trayMenuBuildPatch);
  } else {
    console.warn("WARN: Could not find tray native menu builder — skipping Linux tray context menu builder patch");
  }

  const trayContextMenuNeedle =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  const trayContextMenuPatch =
    "if(process.platform===`linux`)return;e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  const oldLinuxPopupPatch =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),process.platform===`linux`&&this.tray.setContextMenu?.(e),this.tray.popUpContextMenu(e)}";
  const badLinuxPopupPatch =
    "e.once(`menu-will-show`,()=>{this.isNativeTrayMenuOpen=!0}),if(process.platform===`linux`)return;e.once(`menu-will-close`,()=>{this.isNativeTrayMenuOpen=!1,this.handleNativeTrayMenuClosed()}),this.tray.popUpContextMenu(e)}";
  if (patchedSource.includes("if(process.platform===`linux`)return;e.once(`menu-will-show`")) {
    // Already patched.
  } else if (patchedSource.includes(badLinuxPopupPatch)) {
    patchedSource = patchedSource.replace(badLinuxPopupPatch, trayContextMenuPatch);
  } else if (patchedSource.includes(oldLinuxPopupPatch)) {
    patchedSource = patchedSource.replace(oldLinuxPopupPatch, trayContextMenuPatch);
  } else if (patchedSource.includes(trayContextMenuNeedle)) {
    patchedSource = patchedSource.replace(trayContextMenuNeedle, trayContextMenuPatch);
  } else {
    console.warn("WARN: Could not find tray native menu popup — skipping Linux tray popup guard patch");
  }

  const trayMenuThreadsNeedle =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads;return";
  const trayMenuThreadsExistingPatch =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&this.setLinuxTrayContextMenu?.();return";
  const trayMenuThreadsPatch =
    "case`tray-menu-threads-changed`:this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.();return";
  if (patchedSource.includes("this.trayMenuThreads=e.trayMenuThreads,process.platform===`linux`&&!(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())&&this.setLinuxTrayContextMenu?.()")) {
    // Already patched.
  } else if (patchedSource.includes(trayMenuThreadsExistingPatch)) {
    patchedSource = patchedSource.replace(trayMenuThreadsExistingPatch, trayMenuThreadsPatch);
  } else if (patchedSource.includes(trayMenuThreadsNeedle)) {
    patchedSource = patchedSource.replace(trayMenuThreadsNeedle, trayMenuThreadsPatch);
  } else {
    console.warn("WARN: Could not find tray menu thread update handler — skipping Linux tray context refresh patch");
  }

  const trayStartupNeedle = "E&&oe();";
  const previousTrayStartupPatch = "(E||process.platform===`linux`)&&oe();";
  const trayEnabledExpression = "process.platform===`linux`&&(typeof codexLinuxIsTrayEnabled!==`function`||codexLinuxIsTrayEnabled())";
  const trayStartupPatch = `(E||${trayEnabledExpression})&&oe();`;
  patchedSource = patchedSource.replaceAll(
    "process.platform===`linux`&&codexLinuxIsTrayEnabled())&&",
    `${trayEnabledExpression})&&`,
  );
  if (patchedSource.includes(trayStartupPatch)) {
    // Already patched.
  } else if (patchedSource.includes(previousTrayStartupPatch)) {
    patchedSource = patchedSource.replace(previousTrayStartupPatch, trayStartupPatch);
  } else if (patchedSource.includes(trayStartupNeedle)) {
    patchedSource = patchedSource.replace(trayStartupNeedle, trayStartupPatch);
  } else {
    const traySetup = findDynamicTraySetup(patchedSource);
    const dynamicTrayStartupMatch = traySetup == null
      ? null
      : findDynamicTrayStartupCall(patchedSource, traySetup.setupFn, traySetup.index);
    if (
      traySetup != null &&
      patchedSource.includes(`${trayEnabledExpression})&&${traySetup.setupFn}();`)
    ) {
      // Already patched with a newer minifier's tray setup identifier.
    } else if (dynamicTrayStartupMatch != null) {
      const isWindowsVar = dynamicTrayStartupMatch[1];
      patchedSource = `${patchedSource.slice(0, dynamicTrayStartupMatch.index)}(${isWindowsVar}||${trayEnabledExpression})&&${traySetup.setupFn}();${patchedSource.slice(dynamicTrayStartupMatch.index + dynamicTrayStartupMatch[0].length)}`;
    } else {
      console.warn("WARN: Could not find tray startup call — skipping Linux tray startup patch");
    }
  }

  return patchedSource;
}

function applyLinuxSingleInstancePatch(currentSource) {
  let patchedSource = currentSource;

  const singleInstanceLockNeedle =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});let A=Date.now();await n.app.whenReady()";
  const singleInstanceLockPatch =
    "agentRunId:process.env.CODEX_ELECTRON_AGENT_RUN_ID?.trim()||null}});if(process.platform===`linux`&&!n.app.requestSingleInstanceLock()){n.app.quit();return}let A=Date.now();await n.app.whenReady()";
  if (patchedSource.includes("process.platform===`linux`&&!n.app.requestSingleInstanceLock()")) {
    // Already patched.
  } else if (patchedSource.includes(singleInstanceLockNeedle)) {
    patchedSource = patchedSource.replace(singleInstanceLockNeedle, singleInstanceLockPatch);
  } else if (patchedSource.includes("setSecondInstanceArgsHandler")) {
    // Newer bundles take the single-instance lock in bootstrap.js and hand args into main here.
  } else {
    console.warn("WARN: Could not find startup handoff point — skipping Linux single-instance lock patch");
  }

  const secondInstanceHandlerNeedle =
    "l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  const secondInstanceHandlerExistingPatch =
    "let codexLinuxSecondInstanceHandler=(e,t)=>{R.deepLinks.queueProcessArgs(t)||ie()};process.platform===`linux`&&(n.app.on(`second-instance`,codexLinuxSecondInstanceHandler),k.add(()=>{n.app.off(`second-instance`,codexLinuxSecondInstanceHandler)})),l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  const secondInstanceHandlerPatch =
    "let codexLinuxSecondInstanceHandler=(e,t)=>{(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?void 0:R.deepLinks.queueProcessArgs(t)||ie()},codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()};process.platform===`linux`&&(n.app.on(`before-quit`,codexLinuxBeforeQuitHandler),k.add(()=>{n.app.off(`before-quit`,codexLinuxBeforeQuitHandler)}),n.app.on(`second-instance`,codexLinuxSecondInstanceHandler),k.add(()=>{n.app.off(`second-instance`,codexLinuxSecondInstanceHandler)})),l(e=>{R.deepLinks.queueProcessArgs(e)||ie()});let ae=";
  if (
    patchedSource.includes("codexLinuxBeforeQuitHandler=()=>{typeof codexLinuxMarkQuitInProgress===`function`&&codexLinuxMarkQuitInProgress()}") &&
    patchedSource.includes("(typeof codexLinuxIsQuitInProgress===`function`&&codexLinuxIsQuitInProgress())?void 0:R.deepLinks.queueProcessArgs(t)||ie()")
  ) {
    // Already patched.
  } else if (patchedSource.includes(secondInstanceHandlerExistingPatch)) {
    patchedSource = patchedSource.replace(secondInstanceHandlerExistingPatch, secondInstanceHandlerPatch);
  } else if (patchedSource.includes(secondInstanceHandlerNeedle)) {
    patchedSource = patchedSource.replace(secondInstanceHandlerNeedle, secondInstanceHandlerPatch);
  } else if (patchedSource.includes("setSecondInstanceArgsHandler")) {
    // bootstrap.js owns the Electron second-instance event and calls this bundle's handler.
  } else {
    console.warn("WARN: Could not find second-instance handler — skipping Linux second-instance focus patch");
  }

  return patchedSource;
}

function applyBrowserUseNodeReplApprovalPatch(currentSource) {
  const approvalPatch =
    "startup_timeout_sec:120,tools:{js:{approval_mode:`approve`}},env:{";
  if (currentSource.includes(approvalPatch)) {
    return currentSource;
  }

  const needle = "startup_timeout_sec:120,env:{";
  if (!currentSource.includes(needle)) {
    console.warn(
      "WARN: Could not find Browser Use node_repl config insertion point — skipping node_repl approval patch",
    );
    return currentSource;
  }

  return currentSource.replace(needle, approvalPatch);
}

function applyLinuxGitOriginsSourceFallbackPatch(currentSource) {
  const fallbackSource = "linux_git_origins_missing_source_fallback";
  if (currentSource.includes(`source:\`${fallbackSource}\`,requestKind:`)) {
    return currentSource;
  }

  const exactNeedle =
    "if(o==null){if(e.qt(r))throw Error(`Missing git operation source for ${r}`);return l()}return t.Gt({source:o,requestKind:r},l)";
  const exactReplacement =
    `if(o==null){if(e.qt(r)){if(r===\`git-origins\`)return t.Gt({source:\`${fallbackSource}\`,requestKind:r},l);throw Error(\`Missing git operation source for \${r}\`)}return l()}return t.Gt({source:o,requestKind:r},l)`;
  if (currentSource.includes(exactNeedle)) {
    return currentSource.replace(exactNeedle, exactReplacement);
  }

  const dynamicRegex =
    /if\(([A-Za-z_$][\w$]*)==null\)\{if\(([A-Za-z_$][\w$]*)\.qt\(([A-Za-z_$][\w$]*)\)\)throw Error\(`Missing git operation source for \$\{\3\}`\);return ([A-Za-z_$][\w$]*)\(\)\}return ([A-Za-z_$][\w$]*)\.Gt\(\{source:\1,requestKind:\3\},\4\)/;
  const dynamicMatch = currentSource.match(dynamicRegex);
  if (dynamicMatch != null) {
    const [, sourceVar, gitGuardVar, requestKindVar, callVar, operationContextVar] = dynamicMatch;
    return currentSource.replace(
      dynamicRegex,
      `if(${sourceVar}==null){if(${gitGuardVar}.qt(${requestKindVar})){if(${requestKindVar}===\`git-origins\`)return ${operationContextVar}.Gt({source:\`${fallbackSource}\`,requestKind:${requestKindVar}},${callVar});throw Error(\`Missing git operation source for \${${requestKindVar}}\`)}return ${callVar}()}return ${operationContextVar}.Gt({source:${sourceVar},requestKind:${requestKindVar}},${callVar})`,
    );
  }

  if (
    currentSource.includes("Missing git operation source for") &&
    currentSource.includes("\"git-origins\":")
  ) {
    console.warn("WARN: Could not find git operation source guard — skipping git-origins fallback patch");
  }

  return currentSource;
}

module.exports = {
  applyBrowserUseNodeReplApprovalPatch,
  applyLinuxAvatarOverlayMousePassthroughPatch,
  applyLinuxExplicitIpcQuitPatch,
  applyLinuxExplicitTrayQuitPatch,
  applyLinuxFileManagerPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
  applyLinuxMenuPatch,
  applyLinuxOpaqueBackgroundPatch,
  applyLinuxQuitGuardPatch,
  applyLinuxSetIconPatch,
  applyLinuxSingleInstancePatch,
  applyLinuxTrayPatch,
  applyLinuxWindowOptionsPatch,
};
