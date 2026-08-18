"use strict";

const { mainBundlePatch } = require("../../scripts/patches/descriptor.js");
const { findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const BT = String.fromCharCode(96);
const OVERLAY_APPEARANCE_ANCHOR = "appearance:" + BT + "avatarOverlay" + BT;
const PATCH_MARKER = "codexPetOverlayStabilityPatchV2";
const STABILITY_PREFIX = "codexPetOverlayStability";
const REQUIRED_METHODS = [
  "startDrag",
  "moveDrag",
  "endDrag",
  "throwWithVelocity",
  "cancelMomentum",
  "setElementSize",
  "applyLatestElementSizes",
  "applyLayout",
  "setWindowBounds",
  "getCurrentDisplay",
  "restoreBoundsForDisplay",
  "applyPointerInteractivityPolicy",
  "applyInputShape",
  "setInputShape",
  "rememberMovedWindow",
  "createWindow",
  "getDevelopmentDiagnostics",
];
const RUNTIME_METHODS = [
  "codexPetOverlayStabilityData",
  "codexPetOverlayStabilityFinitePositive",
  "codexPetOverlayStabilityFiniteRect",
  "codexPetOverlayStabilityClone",
  "codexPetOverlayStabilityDisplayBounds",
  "codexPetOverlayStabilitySameGeometry",
  "codexPetOverlayStabilityClipInputShape",
  "codexPetOverlayStabilityBoundsSafe",
  "codexPetOverlayStabilityLayoutSafe",
  "codexPetOverlayStabilityClampAnchor",
  "codexPetOverlayStabilityClearGeometryTimer",
  "codexPetOverlayStabilityCancelDragWork",
  "codexPetOverlayStabilityCancelFling",
  "codexPetOverlayStabilityResetForWindow",
  "codexPetOverlayStabilityPrepareDrag",
  "codexPetOverlayStabilityBeginDrag",
  "codexPetOverlayStabilityQueueDragPoint",
  "codexPetOverlayStabilityFlushDrag",
  "codexPetOverlayStabilityFinishDrag",
  "codexPetOverlayStabilityApplySize",
  "codexPetOverlayStabilityNormalizeSize",
  "codexPetOverlayStabilityApplyPendingSize",
  "codexPetOverlayStabilityHandleSize",
  "codexPetOverlayStabilityRememberProgrammaticMove",
  "codexPetOverlayStabilityForgetProgrammaticMove",
  "codexPetOverlayStabilityConsumeProgrammaticMove",
  "codexPetOverlayStabilityRecordCommit",
  "codexPetOverlayStabilitySetClickThrough",
  "codexPetOverlayStabilityRememberStable",
  "codexPetOverlayStabilityRecover",
  "codexPetOverlayStabilityStartFling",
  "codexPetOverlayStabilityCancelForDisplayChange",
  "codexPetOverlayStabilityCancelTransient",
  "codexPetOverlayStabilityDiagnostics",
];
const WRAPPED_METHODS = [
  "setElementSize",
  "cancelMomentum",
  "throwWithVelocity",
  "applyLayout",
  "setWindowBounds",
  "restoreBoundsForDisplay",
  "applyPointerInteractivityPolicy",
  "applyInputShape",
  "setInputShape",
  "getDevelopmentDiagnostics",
];
const ORIGINAL_METHODS = [
  "codexPetOverlayStabilityOriginalSetElementSize",
  "codexPetOverlayStabilityOriginalCancelMomentum",
  "codexPetOverlayStabilityOriginalThrowWithVelocity",
  "codexPetOverlayStabilityOriginalApplyLayout",
  "codexPetOverlayStabilityOriginalSetWindowBounds",
  "codexPetOverlayStabilityOriginalRestoreBoundsForDisplay",
  "codexPetOverlayStabilityOriginalApplyPointerPolicy",
  "codexPetOverlayStabilityOriginalApplyInputShape",
  "codexPetOverlayStabilityOriginalSetInputShape",
  "codexPetOverlayStabilityOriginalGetDevelopmentDiagnostics",
];

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar) {
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
    if (char === "'" || char === '"' || char === BT) {
      quote = char;
    } else if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function findMethodInClass(source, classOpen, classClose, name) {
  const needle = name + "(";
  const matches = [];
  let cursor = classOpen + 1;
  while (cursor < classClose) {
    const start = source.indexOf(needle, cursor);
    if (start < 0 || start >= classClose) {
      break;
    }
    const previous = source[start - 1];
    if (previous != null && /[A-Za-z0-9_$./]/u.test(previous)) {
      cursor = start + needle.length;
      continue;
    }
    const closeParen = findMatchingDelimiter(source, start + name.length, "(", ")");
    if (closeParen < 0 || closeParen >= classClose) {
      cursor = start + needle.length;
      continue;
    }
    let bodyOpen = closeParen + 1;
    while (bodyOpen < classClose && /\s/u.test(source[bodyOpen])) {
      bodyOpen += 1;
    }
    if (source[bodyOpen] !== "{") {
      cursor = start + needle.length;
      continue;
    }
    const bodyClose = findMatchingBrace(source, bodyOpen);
    if (bodyClose < 0 || bodyClose > classClose) {
      throw new Error("Could not parse avatar overlay method " + name);
    }
    matches.push({
      name,
      start,
      open: bodyOpen,
      end: bodyClose,
      text: source.slice(start, bodyClose + 1),
    });
    cursor = bodyClose + 1;
  }
  return matches;
}

function findOverlayClass(source, requireCurrentContract = false) {
  const candidates = [];
  let cursor = 0;
  while (true) {
    const appearance = source.indexOf(OVERLAY_APPEARANCE_ANCHOR, cursor);
    if (appearance < 0) {
      break;
    }
    const classAssignment = source.lastIndexOf("=class", appearance);
    if (classAssignment >= 0) {
      const classOpen = source.indexOf("{", classAssignment);
      if (classOpen >= 0 && classOpen < appearance) {
        const classClose = findMatchingBrace(source, classOpen);
        if (classClose >= appearance) {
          const key = classAssignment + ":" + classClose;
          if (!candidates.some((candidate) => candidate.key === key)) {
            candidates.push({
              key,
              assignment: classAssignment,
              open: classOpen,
              close: classClose,
            });
          }
        }
      }
    }
    cursor = appearance + OVERLAY_APPEARANCE_ANCHOR.length;
  }

  if (candidates.length !== 1) {
    throw new Error(
      "Expected exactly one avatar overlay class, found " + candidates.length,
    );
  }

  const candidate = candidates[0];
  const classSource = source.slice(candidate.open, candidate.close + 1);
  if (countOccurrences(classSource, OVERLAY_APPEARANCE_ANCHOR) !== 1) {
    throw new Error("Avatar overlay appearance anchor is not unique");
  }

  if (requireCurrentContract) {
    for (const method of REQUIRED_METHODS) {
      const matches = findMethodInClass(
        source,
        candidate.open,
        candidate.close,
        method,
      );
      if (matches.length !== 1) {
        throw new Error(
          "Expected exactly one current avatar overlay method " +
            method +
            ", found " +
            matches.length,
        );
      }
    }
    for (const anchor of [
      "recordMovementIntent",
      "getCursorPointForSource",
      "setContentBounds",
      "inputShape",
      "sendLayoutToRenderer",
      "rememberMovedWindow",
    ]) {
      if (!classSource.includes(anchor)) {
        throw new Error("Missing current avatar overlay anchor " + anchor);
      }
    }
  }

  return candidate;
}

function findUniqueMethod(source, name) {
  const overlay = findOverlayClass(source, false);
  const matches = findMethodInClass(source, overlay.open, overlay.close, name);
  if (matches.length !== 1) {
    throw new Error(
      "Expected exactly one avatar overlay method " +
        name +
        ", found " +
        matches.length,
    );
  }
  return matches[0];
}

function replaceMethod(source, name, replacement) {
  const method = findUniqueMethod(source, name);
  return source.slice(0, method.start) + replacement + source.slice(method.end + 1);
}

function renameMethod(source, name, replacementName) {
  const method = findUniqueMethod(source, name);
  return (
    source.slice(0, method.start) +
    replacementName +
    source.slice(method.start + name.length)
  );
}

function replaceUnique(source, needle, replacement, description) {
  const count = countOccurrences(source, needle);
  if (count !== 1) {
    throw new Error(
      "Expected exactly one " + description + " anchor, found " + count,
    );
  }
  return source.replace(needle, replacement);
}

function replaceInMethod(source, name, transform, description) {
  const method = findUniqueMethod(source, name);
  const replacement = transform(method.text);
  if (replacement === method.text) {
    throw new Error("Avatar overlay " + description + " did not change the method");
  }
  return source.slice(0, method.start) + replacement + source.slice(method.end + 1);
}

function replaceInOverlayClass(source, needle, replacement, description) {
  const overlay = findOverlayClass(source, false);
  const classSource = source.slice(overlay.open, overlay.close + 1);
  const patchedClass = replaceUnique(classSource, needle, replacement, description);
  return source.slice(0, overlay.open) + patchedClass + source.slice(overlay.close + 1);
}

function insertOverlayMethod(source, methodText) {
  const overlay = findOverlayClass(source, false);
  const match = /^([A-Za-z_$][\w$]*)\(/u.exec(methodText);
  if (match == null || findMethodInClass(source, overlay.open, overlay.close, match[1]).length !== 0) {
    throw new Error("Cannot insert duplicate avatar overlay method");
  }
  return source.slice(0, overlay.open + 1) + methodText + source.slice(overlay.open + 1);
}

function captureUnique(texts, expression, description) {
  const values = new Set();
  for (const text of texts) {
    for (const match of text.matchAll(expression)) {
      values.add(match[1]);
    }
  }
  if (values.size !== 1) {
    throw new Error(
      "Expected exactly one current " + description + " dependency, found " +
        [...values].join(", "),
    );
  }
  return [...values][0];
}

function captureCurrentDependencies(source, overlay) {
  const method = (name) => findMethodInClass(source, overlay.open, overlay.close, name)[0].text;
  const start = method("startDrag");
  const move = method("moveDrag");
  const end = method("endDrag");
  const layout = method("applyLayout");
  const input = method("applyInputShape");
  return {
    screenBinding: captureUnique(
      [start, move, end],
      /\b([A-Za-z_$][\w$]*)\.screen\.getCursorScreenPoint\(\)/g,
      "screen binding",
    ),
    cursorNormalizer: captureUnique(
      [start, move, end],
      /\b([A-Za-z_$][\w$]*)\(this\.compositionHost\.getCursorPosition\(\)\)/g,
      "cursor normalizer",
    ),
    dragConstructor: captureUnique(
      [start],
      /\bnew\s+([A-Za-z_$][\w$]*)\(/g,
      "drag-state constructor",
    ),
    dockingHelper: captureUnique(
      [end],
      /\b([A-Za-z_$][\w$]*)\(this\.anchor,this\.presentationOffset\)/g,
      "docking helper",
    ),
    dockingDecision: captureUnique(
      [end],
      /\b([A-Za-z_$][\w$]*)\(\{current:/g,
      "docking decision helper",
    ),
    resolutionKey: captureUnique(
      [layout],
      /this\.resolutionKey=([A-Za-z_$][\w$]*)\(t\.bounds\)/g,
      "resolution-key helper",
    ),
    inputShapeHelper: captureUnique(
      [input],
      /\blet\s+[A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)\(e,this\.inputShape\.map/g,
      "native input-shape helper",
    ),
  };
}

function finitePositive(value) {
  return Number.isFinite(value) && value > 0;
}

function capFlingVelocity(vx, vy, maximum = 1_400) {
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
    return { x: 0, y: 0 };
  }
  const magnitude = Math.hypot(vx, vy);
  if (magnitude === 0 || magnitude <= maximum) {
    return { x: vx, y: vy };
  }
  const scale = maximum / magnitude;
  return { x: vx * scale, y: vy * scale };
}

function clipInputShape(rectangles, bounds) {
  if (!Array.isArray(rectangles) || !finitePositive(bounds?.width) || !finitePositive(bounds?.height)) {
    return null;
  }
  const clipped = [];
  for (const rectangle of rectangles) {
    if (rectangle == null) {
      continue;
    }
    const left = Number(rectangle.left ?? rectangle.x);
    const top = Number(rectangle.top ?? rectangle.y);
    const width = Number(rectangle.width);
    const height = Number(rectangle.height);
    if (!Number.isFinite(left) || !Number.isFinite(top) || !finitePositive(width) || !finitePositive(height)) {
      continue;
    }
    const right = Math.min(bounds.width, left + width);
    const bottom = Math.min(bounds.height, top + height);
    const clippedLeft = Math.max(0, left);
    const clippedTop = Math.max(0, top);
    if (right <= clippedLeft || bottom <= clippedTop) {
      continue;
    }
    clipped.push({
      left: clippedLeft,
      top: clippedTop,
      width: right - clippedLeft,
      height: bottom - clippedTop,
    });
  }
  return clipped.length > 0 ? clipped : null;
}

function acceptsNativeBounds(bounds, display) {
  const displayBounds = display?.bounds ?? display;
  if (
    !Number.isFinite(bounds?.x) ||
    !Number.isFinite(bounds?.y) ||
    !finitePositive(bounds?.width) ||
    !finitePositive(bounds?.height) ||
    !Number.isFinite(displayBounds?.x) ||
    !Number.isFinite(displayBounds?.y) ||
    !finitePositive(displayBounds?.width) ||
    !finitePositive(displayBounds?.height)
  ) {
    return false;
  }
  const maximumWidth = Math.min(384, displayBounds.width);
  const maximumHeight = Math.min(400, displayBounds.height);
  return (
    bounds.width <= maximumWidth &&
    bounds.height <= maximumHeight &&
    bounds.x >= displayBounds.x - 1 &&
    bounds.y >= displayBounds.y - 1 &&
    bounds.x + bounds.width <= displayBounds.x + displayBounds.width + 1 &&
    bounds.y + bounds.height <= displayBounds.y + displayBounds.height + 1
  );
}

function createLatestWinsScheduler(schedule, cancel, interval = 16) {
  let timer = null;
  let generation = 0;
  let latest = null;
  let scheduled = 0;
  const scheduler = {
    onCommit: null,
    push(value) {
      latest = value;
      if (timer != null) {
        return;
      }
      const capturedGeneration = generation;
      scheduled += 1;
      timer = schedule(() => {
        timer = null;
        if (capturedGeneration !== generation) {
          return;
        }
        const valueToCommit = latest;
        latest = null;
        if (valueToCommit != null) {
          scheduler.onCommit?.(valueToCommit);
        }
      }, interval);
    },
    cancel() {
      generation += 1;
      latest = null;
      if (timer != null) {
        cancel(timer);
        timer = null;
      }
    },
    flush() {
      if (timer != null) {
        cancel(timer);
        timer = null;
      }
      const value = latest;
      latest = null;
      if (value != null) {
        scheduler.onCommit?.(value);
      }
      return value;
    },
    get scheduled() {
      return scheduled;
    },
  };
  return scheduler;
}

function buildRuntime(captures) {
  const captured = JSON.stringify({
    screenBinding: captures.screenBinding,
    cursorNormalizer: captures.cursorNormalizer,
    dragConstructor: captures.dragConstructor,
    dockingHelper: captures.dockingHelper,
    dockingDecision: captures.dockingDecision,
    resolutionKey: captures.resolutionKey,
    inputShapeHelper: captures.inputShapeHelper,
  });
  return String.raw`
codexPetOverlayStabilityData(){
  if(this.codexPetOverlayStabilityState==null){
    this.codexPetOverlayStabilityState={
      windowGeneration:0,dragGeneration:0,flingGeneration:0,
      windowId:null,rendererId:null,dragActive:!1,finalDragFlushed:!1,
      activeDisplayId:null,activeDisplayBounds:null,pointerOffset:null,
      preDragStableLayout:null,
      pendingDragPoint:null,geometryTimer:null,geometryKind:null,fling:null,
      programmaticMoves:[],programmaticSequence:0,
      acknowledgedProgrammaticMoves:0,coalescedDragMoves:0,
      deferredSizeUpdates:0,pendingSize:null,lastAppliedSizeRevision:null,
      geometryReconciliation:!1,pendingRecoveryReason:null,recovering:!1,
      stableLayout:null,lastValidInputShape:null,lastDisplayId:null,commitTimes:[],
      peakGeometryCommitsPerSecond:0,recoveries:0,lastRecoveryReason:null,
      invalidStoredPosition:!1,capturedContracts:${captured}
    };
  }
  return this.codexPetOverlayStabilityState;
}
codexPetOverlayStabilityFinitePositive(e){return Number.isFinite(e)&&e>0}
codexPetOverlayStabilityFiniteRect(e){return e!=null&&Number.isFinite(e.x)&&Number.isFinite(e.y)&&this.codexPetOverlayStabilityFinitePositive(e.width)&&this.codexPetOverlayStabilityFinitePositive(e.height)}
codexPetOverlayStabilityClone(e){if(e==null)return e;try{return JSON.parse(JSON.stringify(e))}catch{return null}}
codexPetOverlayStabilityDisplayBounds(e){return e?.bounds??e??this.displayBounds}
codexPetOverlayStabilitySameGeometry(e,t){return e!=null&&t!=null&&e.x===t.x&&e.y===t.y&&e.width===t.width&&e.height===t.height}
codexPetOverlayStabilityClipInputShape(e,t){if(!Array.isArray(e)||t==null||!this.codexPetOverlayStabilityFinitePositive(t.width)||!this.codexPetOverlayStabilityFinitePositive(t.height))return null;let n=[];for(let r of e){if(r==null)continue;let i=Number(r.left??r.x),a=Number(r.top??r.y),o=Number(r.width),s=Number(r.height);if(!Number.isFinite(i)||!Number.isFinite(a)||!this.codexPetOverlayStabilityFinitePositive(o)||!this.codexPetOverlayStabilityFinitePositive(s))continue;let c=Math.min(t.width,i+o),l=Math.min(t.height,a+s),u=Math.max(0,i),d=Math.max(0,a);c>u&&l>d&&n.push({left:u,top:d,width:c-u,height:l-d})}return n.length>0?n:null}
codexPetOverlayStabilityBoundsSafe(e,t){
  let n=this.codexPetOverlayStabilityDisplayBounds(t);
  if(!this.codexPetOverlayStabilityFiniteRect(e)||!this.codexPetOverlayStabilityFiniteRect(n))return!1;
  let r=Math.min(384,n.width),i=Math.min(400,n.height);
  return e.width<=r&&e.height<=i&&e.x>=n.x-1&&e.y>=n.y-1&&e.x+e.width<=n.x+n.width+1&&e.y+e.height<=n.y+n.height+1;
}
codexPetOverlayStabilityLayoutSafe(e,t){
  let n=this.codexPetOverlayStabilityDisplayBounds(t),r=e?.windowBounds,i=e?.mascot;
  if(!this.codexPetOverlayStabilityBoundsSafe(r,n)||i==null||!this.codexPetOverlayStabilityFinitePositive(i.width)||!this.codexPetOverlayStabilityFinitePositive(i.height)||!Number.isFinite(i.left)||!Number.isFinite(i.top))return!1;
  let a=r.x+i.left,o=r.y+i.top;
  return a>=n.x-1&&o>=n.y-1&&a+i.width<=n.x+n.width+1&&o+i.height<=n.y+n.height+1;
}
codexPetOverlayStabilityClampAnchor(e,t){
  let n=this.codexPetOverlayStabilityDisplayBounds(t),r=this.mascotSize??{},i=Number(r.width),a=Number(r.height);
  if(!this.codexPetOverlayStabilityFiniteRect(n)||!this.codexPetOverlayStabilityFinitePositive(i)||!this.codexPetOverlayStabilityFinitePositive(a))return e;
  let o=e==null?{}:e,s=Number.isFinite(o.x)?o.x:n.x,c=Number.isFinite(o.y)?o.y:n.y;
  return{...o,x:Math.min(Math.max(s,n.x),Math.max(n.x,n.x+n.width-i)),y:Math.min(Math.max(c,n.y),Math.max(n.y,n.y+n.height-a)),width:i,height:a};
}
codexPetOverlayStabilityClearGeometryTimer(e=!0){let t=this.codexPetOverlayStabilityData();if(t.geometryTimer!=null){clearTimeout(t.geometryTimer);t.geometryTimer=null}t.geometryKind=null;e&&(t.pendingDragPoint=null)}
codexPetOverlayStabilityCancelDragWork(){let e=this.codexPetOverlayStabilityData();e.dragGeneration+=1;this.codexPetOverlayStabilityClearGeometryTimer();e.dragActive=!1;e.finalDragFlushed=!1;e.pendingDragPoint=null;e.activeDisplayId=null;e.activeDisplayBounds=null;e.pointerOffset=null;e.preDragStableLayout=null}
codexPetOverlayStabilityCancelFling(){let e=this.codexPetOverlayStabilityData();if(e.geometryKind==="fling"||e.fling!=null)this.codexPetOverlayStabilityClearGeometryTimer();e.flingGeneration+=1;e.fling=null;this.momentumActive=!1}
codexPetOverlayStabilityResetForWindow(e){let t=this.codexPetOverlayStabilityData();this.codexPetOverlayStabilityCancelDragWork();this.codexPetOverlayStabilityCancelFling();t.windowGeneration+=1;t.windowId=e?.webContents?.id??null;t.rendererId=t.windowId;t.programmaticMoves=[];t.pendingSize=null;t.lastAppliedSizeRevision=null;t.stableLayout=null;t.lastValidInputShape=null;t.lastDisplayId=null;t.activeDisplayId=null;t.activeDisplayBounds=null;t.pointerOffset=null;t.preDragStableLayout=null;t.commitTimes=[];t.recoveries=0;t.lastRecoveryReason=null;t.invalidStoredPosition=!1;t.pendingRecoveryReason=null;t.recovering=!1}
codexPetOverlayStabilityPrepareDrag(e){let t=this.codexPetOverlayStabilityData();this.codexPetOverlayStabilityCancelFling();this.codexPetOverlayStabilityCancelDragWork();t.windowId=this.window?.webContents?.id??t.windowId;t.rendererId=e;t.finalDragFlushed=!1;if(typeof this.clearMovedWindowPersist==="function")this.clearMovedWindowPersist();if(this.hasDeferredLayout&&this.pendingElementSizeRevision!=null&&this.window!=null&&!this.window.isDestroyed()){this.hasDeferredLayout=!1;this.applyLatestElementSizes(this.window)}}
codexPetOverlayStabilityBeginDrag(e){let t=this.codexPetOverlayStabilityData();if(this.window==null||this.window.isDestroyed()||this.window.webContents.id!==e||this.dragState==null)return;let n=this.getCurrentDisplay?.(),r=this.codexPetOverlayStabilityDisplayBounds(n);t.dragActive=!0;t.rendererId=e;t.windowId=this.window.webContents.id;t.dragGeneration+=1;t.finalDragFlushed=!1;t.pendingDragPoint=null;t.activeDisplayId=n?.id??this.displayId??null;t.activeDisplayBounds=this.codexPetOverlayStabilityClone(r);t.pointerOffset={x:Number(this.dragState.pointerAnchorX),y:Number(this.dragState.pointerAnchorY)};t.preDragStableLayout=this.codexPetOverlayStabilityClone(t.stableLayout)}
codexPetOverlayStabilityQueueDragPoint(e,t){let n=this.codexPetOverlayStabilityData(),r=this.window;if(!n.dragActive||n.rendererId!==e||t==null||!Number.isFinite(t.x)||!Number.isFinite(t.y)||r==null||r.isDestroyed()||r.webContents.id!==e)return;if(n.pendingDragPoint!=null)n.coalescedDragMoves+=1;n.pendingDragPoint={x:t.x,y:t.y};if(n.geometryTimer!=null)return;let i=n.windowGeneration,a=n.dragGeneration,o=r;n.geometryKind="drag";n.geometryTimer=setTimeout(()=>{let e=this.codexPetOverlayStabilityData();e.geometryTimer=null;e.geometryKind=null;if(!e.dragActive||e.windowGeneration!==i||e.dragGeneration!==a||this.window!==o||o.isDestroyed()||o.webContents.id!==e.rendererId)return;let t=e.pendingDragPoint;e.pendingDragPoint=null;t!=null&&this.moveDragToPointer(o,t)},16)}
codexPetOverlayStabilityFlushDrag(e,t){let n=this.codexPetOverlayStabilityData(),r=this.window;if(!n.dragActive||n.rendererId!==e||r==null||r.isDestroyed()||r.webContents.id!==e)return;if(this.windowServerDragActive){n.finalDragFlushed=!0;return}this.codexPetOverlayStabilityClearGeometryTimer(!1);let i=${captures.screenBinding}.screen.getCursorScreenPoint(),a=Number(t?.pointerScreenX),o=Number(t?.pointerScreenY),s=Number.isFinite(a)?a:i.x,c=Number.isFinite(o)?o:i.y,l=this.dragState;if(l!=null){let e=${captures.cursorNormalizer}(this.compositionHost.getCursorPosition()),t=l.getCursorPointForSource({native:l.cursorSource==="native"?e:null,renderer:{x:s,y:c}});t!=null&&(n.pendingDragPoint={x:t.x,y:t.y})}let u=n.pendingDragPoint;n.pendingDragPoint=null;u!=null&&this.moveDragToPointer(r,u);n.finalDragFlushed=!0}
codexPetOverlayStabilityFinishDrag(e){let t=this.codexPetOverlayStabilityData();if(!t.dragActive)return;this.codexPetOverlayStabilityClearGeometryTimer();t.dragActive=!1;t.dragGeneration+=1;t.rendererId=null;t.pendingDragPoint=null;t.finalDragFlushed=!0;t.activeDisplayId=null;t.activeDisplayBounds=null;t.pointerOffset=null;t.preDragStableLayout=null;this.codexPetOverlayStabilityApplyPendingSize(e)}
codexPetOverlayStabilityApplySize(e,t){let n=this.codexPetOverlayStabilityData();if(t==null||n.lastAppliedSizeRevision!=null&&t.hasRevision&&t.revision<=n.lastAppliedSizeRevision)return;let r=n.geometryReconciliation;n.geometryReconciliation=!0;try{this.codexPetOverlayStabilityOriginalSetElementSize(e,t.message);n.lastAppliedSizeRevision=t.revision}catch(i){n.pendingRecoveryReason="size-update-exception";throw i}finally{n.geometryReconciliation=r}}
codexPetOverlayStabilityNormalizeSize(e,t){if(t==null||t.mascot==null||!this.codexPetOverlayStabilityFinitePositive(Number(t.mascot.width))||!this.codexPetOverlayStabilityFinitePositive(Number(t.mascot.height)))return null;let n=Number.isFinite(t.elementSizeRevision)?Number(t.elementSizeRevision):(e.pendingSize?.revision??e.lastAppliedSizeRevision??-1)+1;if(!Number.isSafeInteger(n)||n<0)return null;if(t.tray!=null&&(!this.codexPetOverlayStabilityFinitePositive(Number(t.tray.width))||!this.codexPetOverlayStabilityFinitePositive(Number(t.tray.height))))return null;return{revision:n,hasRevision:Number.isFinite(t.elementSizeRevision),message:{...t,mascot:{...t.mascot,width:Number(t.mascot.width),height:Number(t.mascot.height)}}}}
codexPetOverlayStabilityApplyPendingSize(e){let t=this.codexPetOverlayStabilityData(),n=t.pendingSize;t.pendingSize=null;if(n!=null)this.codexPetOverlayStabilityApplySize(e,n)}
codexPetOverlayStabilityHandleSize(e,t){let n=this.codexPetOverlayStabilityData(),r=this.codexPetOverlayStabilityNormalizeSize(n,t);if(r==null)return;if(n.lastAppliedSizeRevision!=null&&r.hasRevision&&r.revision<=n.lastAppliedSizeRevision)return;if(n.pendingSize!=null&&r.revision<=n.pendingSize.revision)return;let i=n.fling!=null;if(i)this.codexPetOverlayStabilityCancelFling();let a=n.dragActive||n.geometryReconciliation||this.movedWindowPersistTimer!=null;if(a&&!i){n.pendingSize=r;n.deferredSizeUpdates+=1;return}this.codexPetOverlayStabilityApplySize(e,r)}
codexPetOverlayStabilityRememberProgrammaticMove(e,t){let n=this.codexPetOverlayStabilityData(),r=Date.now(),i=t?.webContents?.id;if(i==null||e==null)return null;n.programmaticMoves=n.programmaticMoves.filter(e=>e.expiresAt>r&&e.windowGeneration===n.windowGeneration&&e.windowId===i);let a={sequence:++n.programmaticSequence,windowGeneration:n.windowGeneration,windowId:i,bounds:{x:e.x,y:e.y,width:e.width,height:e.height},expiresAt:r+250};n.programmaticMoves.push(a);if(n.programmaticMoves.length>4)n.programmaticMoves.splice(0,n.programmaticMoves.length-4);return a.sequence}
codexPetOverlayStabilityForgetProgrammaticMove(e){let t=this.codexPetOverlayStabilityData();if(e==null)return;t.programmaticMoves=t.programmaticMoves.filter(t=>t.sequence!==e)}
codexPetOverlayStabilityConsumeProgrammaticMove(e){let t=this.codexPetOverlayStabilityData();if(e==null||e.isDestroyed())return!1;let n;try{n=e.getContentBounds()}catch{return!1}if(!this.codexPetOverlayStabilityFiniteRect(n))return!1;let r=Date.now();for(let i=t.programmaticMoves.length-1;i>=0;i-=1){let a=t.programmaticMoves[i];if(a.expiresAt<=r||a.windowGeneration!==t.windowGeneration||a.windowId!==e.webContents.id){t.programmaticMoves.splice(i,1);continue}let o=Math.abs(n.x-a.bounds.x)<=1&&Math.abs(n.y-a.bounds.y)<=1&&Math.abs(n.width-a.bounds.width)<=1&&Math.abs(n.height-a.bounds.height)<=1;if(o){t.programmaticMoves.splice(i,1);t.acknowledgedProgrammaticMoves+=1;return!0}}return!1}
codexPetOverlayStabilityRecordCommit(e,t,n,r=null){let i=this.codexPetOverlayStabilityData();if(i.recovering||!n)return!0;let a=Date.now();i.commitTimes=i.commitTimes.filter(e=>a-e<1000);i.commitTimes.push(a);i.peakGeometryCommitsPerSecond=Math.max(i.peakGeometryCommitsPerSecond,i.commitTimes.length);if(i.commitTimes.length>75){i.pendingRecoveryReason="geometry-commit-loop";return!1}r==null&&this.codexPetOverlayStabilityRememberProgrammaticMove(t,e);return!0}
codexPetOverlayStabilitySetClickThrough(e){if(e==null||e.isDestroyed())return;try{e.setIgnoreMouseEvents(!0,{forward:!0})}catch{}this.mousePassthroughEnabled=!0}
codexPetOverlayStabilityRememberStable(){let e=this.codexPetOverlayStabilityData(),t=this.displayBounds??this.getCurrentDisplay?.()?.bounds,n=this.layout;if(e.recovering||!this.codexPetOverlayStabilityLayoutSafe(n,t))return;let r=this.codexPetOverlayStabilityDisplayBounds(t);e.stableLayout={anchor:this.codexPetOverlayStabilityClone(this.anchor),layout:this.codexPetOverlayStabilityClone(n),displayId:this.displayId,displayBounds:this.codexPetOverlayStabilityClone(r),windowBounds:this.codexPetOverlayStabilityClone(n.windowBounds),inputShape:this.codexPetOverlayStabilityClone(e.lastValidInputShape),resolutionKey:r==null?null:${captures.resolutionKey}(r)};}
codexPetOverlayStabilityRecover(e,t){let n=this.codexPetOverlayStabilityData(),r=e??this.window;if(n.recovering||r==null||r.isDestroyed())return!1;n.recovering=!0;n.recoveries+=1;n.lastRecoveryReason=t;n.pendingRecoveryReason=null;let i=!1;try{this.codexPetOverlayStabilityCancelDragWork();this.codexPetOverlayStabilityCancelFling();if(typeof this.clearMovedWindowPersist==="function")this.clearMovedWindowPersist();n.programmaticMoves=[];n.pendingSize=null;n.commitTimes=[];this.codexPetOverlayStabilitySetClickThrough(r);let e=this.getCurrentDisplay?.(),t=e??(n.stableLayout?.displayBounds==null?null:{id:n.stableLayout.displayId,bounds:n.stableLayout.displayBounds});if(t==null)throw Error("No display available for overlay recovery");let a=n.stableLayout?.anchor??this.anchor;this.anchor=this.codexPetOverlayStabilityClampAnchor(a,t);this.lastSentRendererState=null;this.codexPetOverlayStabilityOriginalApplyLayout(r,t,!1,!0,null);if(!this.codexPetOverlayStabilityLayoutSafe(this.layout,t))throw Error("Overlay recovery produced invalid layout");this.inputShape=n.stableLayout?.inputShape??null;this.applyPointerInteractivityPolicy();this.persistWindowBounds(r,t);i=!0}catch{}finally{n.recovering=!1;n.pendingRecoveryReason=null;n.geometryTimer=null;n.geometryKind=null;n.pendingDragPoint=null;n.fling=null;this.momentumActive=!1}if(i)this.codexPetOverlayStabilityRememberStable();return!1}
codexPetOverlayStabilityStartFling(e,t,n,r=!1){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e||!Number.isFinite(t)||!Number.isFinite(n))return;let a=Math.hypot(t,n);if(a===0)return;let o=a>1400?1400/a:1,s={x:t*o,y:n*o},c=this.codexPetOverlayStabilityData();this.codexPetOverlayStabilityCancelFling();this.codexPetOverlayStabilityClearGeometryTimer();c.flingGeneration+=1;let l=c.flingGeneration,u=Date.now();c.fling={generation:l,startedAt:u,lastAt:u,vx:s.x,vy:s.y,bounced:!1,allowBounce:r===!0};this.momentumActive=!0;let d=()=>{let t=this.codexPetOverlayStabilityData(),n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e||t.fling==null||t.fling.generation!==l||t.windowGeneration!==c.windowGeneration){this.codexPetOverlayStabilityClearGeometryTimer();return}t.geometryTimer=null;t.geometryKind=null;let r=Date.now(),i=Math.min(350,r-t.fling.startedAt);if(i>=350){t.fling=null;this.momentumActive=!1;this.persistWindowBounds(n);return}let a=Math.max(.001,Math.min(.016,(r-t.fling.lastAt)/1000));t.fling.lastAt=r;let dx=t.fling.vx*a,dy=t.fling.vy*a,magnitude=Math.hypot(dx,dy);if(magnitude>24){let scale=24/magnitude;dx*=scale;dy*=scale}let nextAnchor={...this.anchor,x:this.anchor.x+dx,y:this.anchor.y+dy};this.anchor=nextAnchor;let display=this.getCurrentDisplay();this.applyLayout(n,display,!1,!1);if(t.fling==null)return;let uX=!Number.isFinite(this.anchor.x)||Math.abs(this.anchor.x-nextAnchor.x)>1,uY=!Number.isFinite(this.anchor.y)||Math.abs(this.anchor.y-nextAnchor.y)>1;if((uX||uY)&&!t.fling.bounced&&t.fling.allowBounce){t.fling.bounced=!0;uX&&(t.fling.vx=-t.fling.vx*.35);uY&&(t.fling.vy=-t.fling.vy*.35)}else if(uX||uY){uX&&(t.fling.vx=0);uY&&(t.fling.vy=0)}t.fling.vx*=.86;t.fling.vy*=.86;if(i>=350||Math.hypot(t.fling.vx,t.fling.vy)<55){t.fling=null;this.momentumActive=!1;this.persistWindowBounds(n);return}t.geometryKind="fling";t.geometryTimer=setTimeout(d,16)};c.geometryKind="fling";c.geometryTimer=setTimeout(d,16)}
codexPetOverlayStabilityCancelForDisplayChange(){let e=this.codexPetOverlayStabilityData();this.codexPetOverlayStabilityCancelFling();if(!e.dragActive)this.codexPetOverlayStabilityClearGeometryTimer();e.programmaticMoves=[];if(typeof this.clearMovedWindowPersist==="function")this.clearMovedWindowPersist()}
codexPetOverlayStabilityCancelTransient(e){let t=this.codexPetOverlayStabilityData();this.codexPetOverlayStabilityCancelDragWork();this.codexPetOverlayStabilityCancelFling();t.rendererId=null;t.pendingSize=null;t.finalDragFlushed=!1;t.programmaticMoves=[];if(typeof this.clearMovedWindowPersist==="function")this.clearMovedWindowPersist();if(e!=null&&!e.isDestroyed())this.codexPetOverlayStabilitySetClickThrough(e)}
codexPetOverlayStabilityDiagnostics(){let e=this.codexPetOverlayStabilityData();return{coalescedDragMoves:e.coalescedDragMoves,acknowledgedProgrammaticMoves:e.acknowledgedProgrammaticMoves,deferredSizeUpdates:e.deferredSizeUpdates,geometryRecoveryCount:e.recoveries,lastGeometryRecoveryReason:e.lastRecoveryReason,peakGeometryCommitsPerSecond:e.peakGeometryCommitsPerSecond}}
`;
}

function isCompletePatchedContract(source) {
  let overlay;
  try {
    overlay = findOverlayClass(source, false);
  } catch {
    return false;
  }
  const classSource = source.slice(overlay.open, overlay.close + 1);
  if (countOccurrences(classSource, PATCH_MARKER) !== 1) {
    return false;
  }
  for (const method of [...RUNTIME_METHODS, ...WRAPPED_METHODS, ...ORIGINAL_METHODS]) {
    const count = findMethodInClass(source, overlay.open, overlay.close, method).length;
    if (count !== 1) {
      return false;
    }
  }
  return (
    classSource.includes("linuxStability:") &&
    classSource.includes("codexPetOverlayStabilityConsumeProgrammaticMove") &&
    classSource.includes("codexPetOverlayStabilityQueueDragPoint") &&
    classSource.includes("codexPetOverlayStabilityFlushDrag") &&
    classSource.includes("codexPetOverlayStabilityRecover")
  );
}

function applyPetOverlayStabilityPatch(source) {
  if (typeof source !== "string") {
    throw new TypeError("Expected main bundle source text");
  }

  const markerCount = countOccurrences(source, PATCH_MARKER);
  const stabilityTokenCount = countOccurrences(source, STABILITY_PREFIX);
  if (markerCount !== 0 || stabilityTokenCount !== 0) {
    if (markerCount === 1 && isCompletePatchedContract(source)) {
      return source;
    }
    throw new Error(
      "Refusing partial, duplicate, or mixed pet-overlay-stability patch state",
    );
  }

  const currentOverlay = findOverlayClass(source, true);
  if (countOccurrences(source, "avatar-overlay-element-size-changed") !== 1) {
    throw new Error("Expected exactly one avatar overlay element-size IPC anchor");
  }
  const captures = captureCurrentDependencies(source, currentOverlay);
  let patched =
    source.slice(0, currentOverlay.open + 1) +
    PATCH_MARKER + "=!0;" +
    buildRuntime(captures) +
    source.slice(currentOverlay.open + 1);

  for (const [name, replacement] of [
    ["setElementSize", "codexPetOverlayStabilityOriginalSetElementSize"],
    ["cancelMomentum", "codexPetOverlayStabilityOriginalCancelMomentum"],
    ["throwWithVelocity", "codexPetOverlayStabilityOriginalThrowWithVelocity"],
    ["applyLayout", "codexPetOverlayStabilityOriginalApplyLayout"],
    ["setWindowBounds", "codexPetOverlayStabilityOriginalSetWindowBounds"],
    ["restoreBoundsForDisplay", "codexPetOverlayStabilityOriginalRestoreBoundsForDisplay"],
    ["applyPointerInteractivityPolicy", "codexPetOverlayStabilityOriginalApplyPointerPolicy"],
    ["applyInputShape", "codexPetOverlayStabilityOriginalApplyInputShape"],
    ["setInputShape", "codexPetOverlayStabilityOriginalSetInputShape"],
    ["getDevelopmentDiagnostics", "codexPetOverlayStabilityOriginalGetDevelopmentDiagnostics"],
  ]) {
    patched = renameMethod(patched, name, replacement);
  }

  patched = insertOverlayMethod(
    patched,
    "setElementSize(e,t){let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;try{this.codexPetOverlayStabilityHandleSize(e,t)}catch{this.codexPetOverlayStabilityRecover(n,\"size-update-exception\")}}",
  );
  patched = insertOverlayMethod(
    patched,
    "cancelMomentum(){this.codexPetOverlayStabilityCancelFling();this.codexPetOverlayStabilityOriginalCancelMomentum()}",
  );
  patched = insertOverlayMethod(
    patched,
    "throwWithVelocity(e,t,n,r=!1){let i=this.window;if(i==null||i.isDestroyed()||i.webContents.id!==e||!Number.isFinite(t)||!Number.isFinite(n)||t===0&&n===0)return;if(process.platform===\"linux\"){let a=this.suppressNextRendererThrow;this.suppressNextRendererThrow=!1;!(a&&!r)&&this.codexPetOverlayStabilityStartFling(e,t,n,r);return}this.codexPetOverlayStabilityOriginalThrowWithVelocity(e,t,n,r)}",
  );
  patched = insertOverlayMethod(
    patched,
    "applyLayout(e,t=this.getCurrentDisplay(),n=!1,r=!0,i=null){let a=this.codexPetOverlayStabilityData();if(e.isDestroyed())return;let o=t?.bounds??t;if(a.lastDisplayId!=null&&t?.id!=null&&a.lastDisplayId!==t.id)this.codexPetOverlayStabilityCancelFling();a.lastDisplayId=t?.id??null;a.pendingRecoveryReason=null;let s=a.geometryReconciliation;a.geometryReconciliation=!0;try{let c=this.codexPetOverlayStabilityClampAnchor(this.anchor,o);if(c!=null&&this.codexPetOverlayStabilityFiniteRect(o)&&(Math.abs((this.anchor?.x??0)-c.x)>1||Math.abs((this.anchor?.y??0)-c.y)>1))this.anchor={...this.anchor,x:c.x,y:c.y};this.codexPetOverlayStabilityOriginalApplyLayout(e,t,n,r,i);this.applyPointerInteractivityPolicy();let u=a.pendingRecoveryReason;if(u!=null){this.codexPetOverlayStabilityRecover(e,u);return}if(!this.codexPetOverlayStabilityLayoutSafe(this.layout,o)){this.codexPetOverlayStabilityRecover(e,\"invalid-layout\");return}this.codexPetOverlayStabilityRememberStable();if(a.invalidStoredPosition){a.invalidStoredPosition=!1;this.persistWindowBounds(e,t)}}catch(d){this.codexPetOverlayStabilityRecover(e,\"layout-exception\")}finally{a.geometryReconciliation=s}}",
  );
  patched = insertOverlayMethod(
    patched,
    "setWindowBounds(e,t,n,r){if(e.isDestroyed())return;let i=this.codexPetOverlayStabilityData(),a=this.displayBounds??this.getCurrentDisplay?.()?.bounds;if(!this.codexPetOverlayStabilityBoundsSafe(t,a)){i.pendingRecoveryReason=\"invalid-window-bounds\";return}let o;try{o=e.getContentBounds()}catch{o=null}let s=!this.codexPetOverlayStabilitySameGeometry(o,t),c=s?this.codexPetOverlayStabilityRememberProgrammaticMove(t,e):null;try{this.codexPetOverlayStabilityOriginalSetWindowBounds(e,t,n,r)}catch(l){c!=null&&this.codexPetOverlayStabilityForgetProgrammaticMove(c);i.pendingRecoveryReason=\"set-content-bounds-exception\";return}this.codexPetOverlayStabilityRecordCommit(e,t,s,c)}",
  );
  patched = insertOverlayMethod(
    patched,
    "restoreBoundsForDisplay(e,t){let n=this.codexPetOverlayStabilityData(),r=t?.bounds??t,i=this.mascotSize??{};if(!this.codexPetOverlayStabilityFiniteRect(r)||!this.codexPetOverlayStabilityFinitePositive(Number(i.width))||!this.codexPetOverlayStabilityFinitePositive(Number(i.height))||!Number.isFinite(e?.x)||!Number.isFinite(e?.y)||Math.abs(e.x)>1e7||Math.abs(e.y)>1e7||e.x+Number(i.width)<=r.x||e.y+Number(i.height)<=r.y||e.x>=r.x+r.width||e.y>=r.y+r.height){n.invalidStoredPosition=!0;this.resetToDefaultAnchor(t);return}this.codexPetOverlayStabilityOriginalRestoreBoundsForDisplay(e,t)}",
  );
  patched = insertOverlayMethod(
    patched,
    "applyInputShape(e){if(process.platform!==\"linux\")return this.codexPetOverlayStabilityOriginalApplyInputShape(e);let t=this.codexPetOverlayStabilityData();if(e==null||e.isDestroyed()){this.codexPetOverlayStabilitySetClickThrough(e);return!0}if(!this.supportsInputShape){this.codexPetOverlayStabilitySetClickThrough(e);return!0}let n;try{n=e.getContentBounds()}catch{n=null}let shape=this.codexPetOverlayStabilityClipInputShape(this.inputShape,n);shape==null&&t.lastValidInputShape!=null&&(shape=this.codexPetOverlayStabilityClipInputShape(t.lastValidInputShape,n));if(shape==null){this.codexPetOverlayStabilitySetClickThrough(e);return!0}this.inputShape=shape;try{let i=this.mousePassthroughEnabled;e.setIgnoreMouseEvents(!1);let a=" + captures.inputShapeHelper + "(e,shape.map(({height:e,left:t,top:n,width:r})=>({height:e,width:r,x:t,y:n})));if(a){this.mousePassthroughEnabled=!1;t.lastValidInputShape=this.codexPetOverlayStabilityClone(shape);return!0}this.mousePassthroughEnabled=i}catch{}this.codexPetOverlayStabilitySetClickThrough(e);return!0}",
  );
  patched = insertOverlayMethod(
    patched,
    "applyPointerInteractivityPolicy(){let e=this.window;if(process.platform!==\"linux\")return this.codexPetOverlayStabilityOriginalApplyPointerPolicy();if(e==null||e.isDestroyed()){this.mousePassthroughEnabled=!1;return}if(this.applyInputShape(e))return;this.codexPetOverlayStabilitySetClickThrough(e)}",
  );
  patched = insertOverlayMethod(
    patched,
    "setInputShape(e,t){if(process.platform!==\"linux\")return this.codexPetOverlayStabilityOriginalSetInputShape(e,t);if(!this.supportsInputShape)return;let n=this.window;if(n==null||n.isDestroyed()||n.webContents.id!==e)return;let r;try{r=this.codexPetOverlayStabilityClipInputShape(t,n.getContentBounds())}catch{r=null}this.inputShape=r;this.applyPointerInteractivityPolicy()}",
  );
  patched = insertOverlayMethod(
    patched,
    "getDevelopmentDiagnostics(e=\"include\"){return{...this.codexPetOverlayStabilityOriginalGetDevelopmentDiagnostics(e),linuxStability:this.codexPetOverlayStabilityDiagnostics()}}",
  );

  patched = replaceInMethod(
    patched,
    "startDrag",
    (method) => {
      let result = replaceUnique(
        method,
        "if(r==null||r.isDestroyed()||r.webContents.id!==e)return;",
        "if(r==null||r.isDestroyed()||r.webContents.id!==e)return;this.codexPetOverlayStabilityPrepareDrag(e);",
        "drag preparation",
      );
      result = replaceUnique(
        result,
        "this.windowServerDragActive||(this.windowServerDragWindowX=null)",
        "this.windowServerDragActive||(this.windowServerDragWindowX=null);this.codexPetOverlayStabilityBeginDrag(e)",
        "drag activation",
      );
      return result;
    },
    "drag preparation",
  );
  patched = replaceInMethod(
    patched,
    "moveDrag",
    (method) =>
      replaceUnique(
        method,
        "a!=null&&this.moveDragToPointer(n,a)",
        "a!=null&&this.codexPetOverlayStabilityQueueDragPoint(e,a)",
        "latest-wins drag commit",
      ),
    "latest-wins drag commit",
  );
  patched = replaceInMethod(
    patched,
    "endDrag",
    (method) => {
      let result = replaceUnique(
        method,
        "if(n==null||n.isDestroyed()||n.webContents.id!==e)return;",
        "if(n==null||n.isDestroyed()||n.webContents.id!==e)return;this.codexPetOverlayStabilityFlushDrag(e,t);",
        "final drag flush",
      );
      result = replaceUnique(
        result,
        "r?.hasMovementIntent)",
        "r?.hasMovementIntent&&!this.codexPetOverlayStabilityData().finalDragFlushed)",
        "duplicate final drag suppression",
      );
      result = replaceUnique(
        result,
        "this.dragState=null,this.windowServerDragActive=!1,this.windowServerDragWindowX=null,",
        "this.dragState=null,this.windowServerDragActive=!1,this.windowServerDragWindowX=null,this.codexPetOverlayStabilityFinishDrag(e),",
        "drag completion",
      );
      return result;
    },
    "drag completion",
  );

  patched = replaceInMethod(
    patched,
    "createWindow",
    (method) =>
      replaceUnique(
        method,
        "this.window=e,this.lastSentRendererState",
        "this.window=e,this.codexPetOverlayStabilityResetForWindow(e),this.lastSentRendererState",
        "window-generation initialization",
      ),
    "window-generation initialization",
  );
  patched = replaceInMethod(
    patched,
    "createWindow",
    (method) =>
      replaceUnique(
        method,
        "e.on(" + BT + "move" + BT + ",()=>{if(!this.nativePositionController.handleWindowMove(e)){",
        "e.on(" + BT + "move" + BT + ",()=>{if(this.codexPetOverlayStabilityConsumeProgrammaticMove(e))return;if(!this.nativePositionController.handleWindowMove(e)){",
        "programmatic move acknowledgement",
      ),
    "programmatic move acknowledgement",
  );
  patched = replaceInMethod(
    patched,
    "createWindow",
    (method) =>
      replaceUnique(
        method,
        "e.on(" + BT + "close" + BT + ",()=>{",
        "e.on(" + BT + "close" + BT + ",()=>{this.codexPetOverlayStabilityCancelTransient(e);",
        "close lifecycle",
      ),
    "close lifecycle",
  );
  patched = replaceInMethod(
    patched,
    "createWindow",
    (method) =>
      replaceUnique(
        method,
        "e.on(" + BT + "hide" + BT + ",()=>{",
        "e.on(" + BT + "hide" + BT + ",()=>{this.codexPetOverlayStabilityCancelTransient(e);",
        "hide lifecycle",
      ),
    "hide lifecycle",
  );
  patched = replaceInMethod(
    patched,
    "createWindow",
    (method) =>
      replaceUnique(
        method,
        "e.on(" + BT + "closed" + BT + ",()=>{",
        "e.on(" + BT + "closed" + BT + ",()=>{this.codexPetOverlayStabilityCancelTransient(e);",
        "closed lifecycle",
      ),
    "closed lifecycle",
  );

  patched = replaceInOverlayClass(
    patched,
    "handleDisplayChanged=()=>{if(this.isSuspended)return;",
    "handleDisplayChanged=()=>{this.codexPetOverlayStabilityCancelForDisplayChange();if(this.isSuspended)return;",
    "display-change lifecycle",
  );
  patched = replaceInOverlayClass(
    patched,
    "handleSuspend=()=>{let e=this.window;",
    "handleSuspend=()=>{this.codexPetOverlayStabilityCancelTransient(this.window);let e=this.window;",
    "suspend lifecycle",
  );
  patched = replaceInOverlayClass(
    patched,
    "handleResume=()=>{this.isSuspended=!1;",
    "handleResume=()=>{this.codexPetOverlayStabilityCancelForDisplayChange();this.isSuspended=!1;",
    "resume lifecycle",
  );

  if (patched === source || !isCompletePatchedContract(patched)) {
    throw new Error("Pet overlay stability patch did not produce a complete contract");
  }
  return patched;
}

const descriptors = [
  mainBundlePatch({
    id: "main-process-stability",
    order: 20_080,
    ciPolicy: "required-upstream",
    apply: applyPetOverlayStabilityPatch,
  }),
];

module.exports = {
  acceptsNativeBounds,
  capFlingVelocity,
  clipInputShape,
  createLatestWinsScheduler,
  descriptors,
  applyPetOverlayStabilityPatch,
  findOverlayClass,
};
