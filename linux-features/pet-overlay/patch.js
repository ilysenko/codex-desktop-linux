"use strict";

const VALID_GRAVITIES = new Set(["bottom-right", "bottom-left", "top-right", "top-left"]);
const DESCRIPTOR_ID = "pet-overlay-main";
const AVATAR_OVERLAY_APPEARANCE = 'appearance:"avatarOverlay"';
const WAYLAND_WINDOW = "process.platform===`linux`&&require(`electron`).app.commandLine.getSwitchValue(`ozone-platform`)===`wayland`";
const UPSTREAM_NATIVE_DRAW_CONSTRAINT = 'constrainNativeDrawWindowToDisplay:"win32"===process.platform';
const NATIVE_DRAW_CONSTRAINT = `${UPSTREAM_NATIVE_DRAW_CONSTRAINT}||${WAYLAND_WINDOW}&&!this.codexPetOverlayIsNativeKWin()`;
const KWIN_COORDINATE_CONSUMERS = [
  "updateCssPetControlsProximityTracking", "sendCursorPointToAvatarOverlay",
  "sendComputerUseCursorLocationToRenderer", "isOverlayWindowPointerDragActive",
  "publishRemoteHostedPIPContentHost", "snapQuickChatToPosition",
];

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

// The avatar overlay manager is the outermost class that creates the
// avatarOverlay window. Classes before it are skipped as whole blocks.
function findAvatarOverlayClass(source) {
  const marker = source.indexOf(AVATAR_OVERLAY_APPEARANCE);
  if (marker === -1 || source.indexOf(AVATAR_OVERLAY_APPEARANCE, marker + 1) !== -1) {
    return null;
  }
  const classRegex = /class(?:\s+[A-Za-z_$][\w$]*)?(?:\s+extends\s+[A-Za-z_$][\w$.]*)?\{/g;

  let match;
  while ((match = classRegex.exec(source)) != null && match.index < marker) {
    const openIndex = match.index + match[0].length - 1;
    const closeIndex = findMatchingBrace(source, openIndex);
    if (closeIndex === -1) {
      classRegex.lastIndex = openIndex + 1;
      continue;
    }
    if (closeIndex > marker) {
      return { start: match.index, end: closeIndex + 1, text: source.slice(match.index, closeIndex + 1) };
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

function codexPetOverlayKWinCall(path, iface, method, ...args) {
  if (this.codexPetOverlayKWinGeometryUnavailable) return null;
  try {
    const output = require("node:child_process").execFileSync("busctl", [
      "--user", "--json=short", "--timeout=750ms", "call", "org.kde.KWin",
      path, iface, method, ...(args.length ? ["s", ...args] : []),
    ], { encoding: "utf8", timeout: 1000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(output);
  } catch (error) {
    if (error?.code === "ENOENT") this.codexPetOverlayKWinGeometryUnavailable = true;
    return null;
  }
}

function codexPetOverlayKWinReadWindow(window, id) {
  if (window == null || window.isDestroyed?.() || this.window !== window ||
      typeof id !== "string" || !/^\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\}$/i.test(id)) return null;
  const reply = this.codexPetOverlayKWinCall("/KWin", "org.kde.KWin", "getWindowInfo", id);
  const info = reply?.type === "a{sv}" && reply.data?.[0];
  if (!info || info.caption?.type !== "s" || info.caption.data !== "Codex Pet Overlay" ||
      info.uuid?.type !== "s" || info.uuid.data !== id ||
      (info.pid != null && (!["i", "u", "x", "t"].includes(info.pid.type) || info.pid.data !== process.pid))) return null;
  const bounds = {};
  for (const key of ["x", "y", "width", "height"]) {
    const value = info[key];
    if (!value || !["d", "i"].includes(value.type) || typeof value.data !== "number" ||
        !Number.isFinite(value.data)) return null;
    bounds[key] = Math.round(value.data);
  }
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return { window, id, bounds };
}

function codexPetOverlayKWinFindWindow(window) {
  const reply = this.codexPetOverlayKWinCall("/WindowsRunner", "org.kde.krunner1", "Match", "Codex Pet Overlay");
  if (!/^a\(sss[iu]da\{sv\}\)$/.test(reply?.type ?? "") || !Array.isArray(reply.data?.[0])) return null;
  const matches = reply.data[0].filter(row => Array.isArray(row) && row[1] === "Codex Pet Overlay" &&
    typeof row[0] === "string" && /^0_\{[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\}$/i.test(row[0]));
  // The KWin drag script also checks the PID before moving the selected UUID.
  return matches.length === 1 ? this.codexPetOverlayKWinReadWindow(window, matches[0][0].slice(2)) : null;
}

function codexPetOverlayKWinGeometry(window) {
  const position = this.codexPetOverlayKWinPosition;
  return this.codexPetOverlayIsNativeKWin() && position?.window === window ? position.bounds : null;
}

function codexPetOverlayMoveLocalMascotDrag(callerId, event) {
  if (!this.codexPetOverlayDragFromCurrentRenderer(callerId)) return false;
  const drag = this.codexPetOverlayMascotDragState, current = this.layout, window = this.window;
  const mascot = this.codexPetOverlayMascotRect(current), bounds = this.codexPetOverlayWindowBounds(window);
  if (!drag || !current || !mascot || !bounds) return false;
  let x = Number(event?.pointerWindowX), y = Number(event?.pointerWindowY);
  if (![x, y].every(Number.isFinite)) {
    const screenX = Number(event?.pointerScreenX), screenY = Number(event?.pointerScreenY);
    if (![screenX, screenY].every(Number.isFinite)) return true;
    x = screenX - bounds.x; y = screenY - bounds.y;
  }
  const left = Math.max(0, Math.min(Math.round(bounds.width - mascot.width), Math.round(x - drag.offsetX)));
  const top = Math.max(0, Math.min(Math.round(bounds.height - mascot.height), Math.round(y - drag.offsetY)));
  this.codexPetOverlayMascotLocalPosition = { left, top };
  const layout = this.codexPetOverlayTrayAboveLeft({ ...current,
    anchor: { ...current.anchor, x: bounds.x + left, y: bounds.y + top },
    mascot: { ...current.mascot, left, top }, windowBounds: { ...current.windowBounds, ...bounds } });
  this.layout = layout;
  if (this.codexPetOverlayIsNativeKWin()) this.anchor = { ...layout.anchor };
  try { this.compositionHost.updateMascotRect?.(layout.mascot); } catch {}
  try { this.sendLayoutToRenderer(window, null); } catch {}
  return true;
}

function codexPetOverlayKWinDrawBounds(display, anchor) {
  const areas = require("electron").screen.getAllDisplays()
    .map(item => this.codexPetOverlayDisplayRect(item)).filter(Boolean);
  const area = this.codexPetOverlayDisplayRect(display);
  if (!area || !anchor) return null;
  areas.push(area);
  const width = Math.floor(Math.min(...areas.map(item => item.width)));
  const height = Math.floor(Math.min(...areas.map(item => item.height)));
  let canvas = this.codexPetOverlayKWinCanvas;
  if (canvas?.window !== this.window) canvas = this.codexPetOverlayKWinCanvas = { window: this.window, width, height };
  if (!this.nativeWindowDragActive && this.codexPetOverlayKWinDragState == null) {
    canvas.width = width;
    canvas.height = height;
  }
  const local = this.codexPetOverlayMascotLocalPosition;
  const left = Number.isFinite(local?.left) ? Math.max(0, Math.min(canvas.width - anchor.width, local.left)) : (canvas.width - anchor.width) / 2;
  const top = Number.isFinite(local?.top) ? Math.max(0, Math.min(canvas.height - anchor.height, local.top)) : (canvas.height - anchor.height) / 2;
  return { x: Math.round(anchor.x - left), y: Math.round(anchor.y - top), width: canvas.width, height: canvas.height };
}

function codexPetOverlayKWinLayout(display, layout) {
  if (!this.codexPetOverlayIsNativeKWin() || this.layoutMode !== "native") return layout;
  const bounds = this.codexPetOverlayKWinDrawBounds(display, layout.anchor);
  const area = this.codexPetOverlayDisplayRect(display);
  if (!bounds || !area) return layout;
  const dx = layout.windowBounds.x - bounds.x, dy = layout.windowBounds.y - bounds.y;
  const translate = rect => rect == null ? rect : { ...rect, left: rect.left + dx, top: rect.top + dy };
  const left = Math.max(bounds.x, area.x), top = Math.max(bounds.y, area.y);
  const visible = { left: left - bounds.x, top: top - bounds.y,
    width: Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - left),
    height: Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - top) };
  let tray = translate(layout.tray);
  if (tray) {
    const width = Math.min(tray.width, visible.width);
    const left = Math.max(visible.left, Math.min(tray.left, visible.left + visible.width - width));
    const top = Math.max(tray.top, visible.top);
    tray = { ...tray, left, top,
      width,
      height: Math.max(0, Math.min(tray.top + tray.height, visible.top + visible.height) - top) };
  }
  return { ...layout, mascot: translate(layout.mascot), tray,
    quickChat: layout.quickChat == null ? layout.quickChat : { ...layout.quickChat, workArea: visible },
    viewport: { width: bounds.width, height: bounds.height }, visibleBounds: visible, windowBounds: bounds };
}

function codexPetOverlayKWinLayoutOptions(options, layout) {
  if (!this.codexPetOverlayIsNativeKWin() || options.mode === "legacy" || !options.traySize?.height) return options;
  const canvas = options.nativeDrawWindowBounds, area = options.displayBounds;
  if (!canvas || !area) return options;
  const initial = layout(options);
  if (!initial?.anchor) return options;
  const canvasX = canvas.x + initial.anchor.x - options.anchor.x;
  const visibleWidth = Math.max(0, Math.min(canvasX + canvas.width, area.x + area.width) - Math.max(canvasX, area.x));
  const sized = { ...options, traySize: { ...options.traySize, width: Math.min(options.traySize.width, visibleWidth) } };
  const candidate = (height, previousPlacement) => {
    const fitted = { ...sized, previousPlacement, traySize: { ...sized.traySize, height } };
    const actual = layout(fitted);
    if (!actual?.tray?.height || !actual.anchor || !actual.windowBounds) return null;
    const canvasY = canvas.y + actual.anchor.y - options.anchor.y;
    const top = Math.max(canvasY, area.y), bottom = Math.min(canvasY + canvas.height, area.y + area.height);
    const trayY = actual.windowBounds.y + actual.tray.top;
    if (trayY < top || trayY + actual.tray.height > bottom) return null;
    // Upstream owns the attachment gap, including control rows, captions and docked content.
    const zero = layout({ ...fitted, previousPlacement: actual.placement, traySize: { ...fitted.traySize, height: 0 } });
    if (!zero?.tray || zero.placement !== actual.placement) return null;
    const attachment = zero.windowBounds.y + zero.tray.top;
    if (actual.placement.startsWith("top") ? trayY + actual.tray.height > attachment : trayY < attachment) return null;
    return { options: fitted, height: actual.tray.height };
  };
  if (candidate(options.traySize.height, options.previousPlacement)) return sized;
  let best = null;
  // Size and placement interact through upstream hysteresis; check both sides with bounded pure layout calls.
  for (const previousPlacement of ["top-end", "bottom-end"]) {
    let low = 1, high = Math.ceil(options.traySize.height);
    const minimum = candidate(low, previousPlacement);
    if (minimum && (!best || minimum.height > best.height)) best = minimum;
    for (let step = 0; low <= high && step < 16; step += 1) {
      const height = Math.floor((low + high) / 2), result = candidate(height, previousPlacement);
      if (result) {
        if (!best || result.height > best.height) best = result;
        low = height + 1;
      } else high = height - 1;
    }
  }
  return best?.options ?? sized;
}

function codexPetOverlayKWinScriptId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id <= 2147483647 ? id : null;
}

function codexPetOverlayKWinLegacyRun(bounds, move, complete) {
  if (!this.codexPetOverlayShouldUseKWin()) { complete?.({ code: "DISABLED" }); return; }
  const window = this.window, epoch = this.codexPetOverlayKWinEpoch;
  const valid = () => this.window === window && !window?.isDestroyed?.() && window?.isVisible?.() !== false &&
    this.codexPetOverlayKWinEpoch === epoch && this.codexPetOverlayKWinDragState == null &&
    (!move || ["x", "y", "width", "height"].every(key => bounds?.[key] === this.codexPetOverlayDesiredWindowBounds?.[key]));
  let file, name;
  const finish = error => {
    const done = () => { try { if (file) require("node:fs").unlinkSync(file); } catch {} complete?.(error); };
    if (name) this.codexPetOverlayKWinQdbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.unloadScript", name], done);
    else done();
  };
  try {
    const serial = this.codexPetOverlayKWinScriptGeneration = (this.codexPetOverlayKWinScriptGeneration ?? 0) + 1;
    name = `codex_pet_overlay_${process.pid}_${Date.now()}_${serial}`;
    file = require("node:path").join(require("node:os").tmpdir(), `${name}.js`);
    require("node:fs").writeFileSync(file, this.codexPetOverlayKWinScript(bounds, move), { encoding: "utf8", flag: "wx", mode: 384 });
    if (!valid()) { finish({ code: "CANCELLED" }); return; }
    this.codexPetOverlayKWinQdbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", file, name], (error, output) => {
      const id = this.codexPetOverlayKWinScriptId(output);
      if (error || id == null || !valid()) { finish(error ?? { code: id == null ? "INVALID_SCRIPT_ID" : "CANCELLED" }); return; }
      this.codexPetOverlayKWinQdbus(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"], finish);
    });
  } catch (error) { finish(error); }
}

function codexPetOverlayKWinExecResult(args) {
  if (this.codexPetOverlayKWinUnavailable || !this.codexPetOverlayShouldUseKWin()) return null;
  for (const command of ["qdbus6", "qdbus"]) {
    try { return String(require("node:child_process").execFileSync(command, args,
      { encoding: "utf8", timeout: 750, stdio: ["ignore", "pipe", "ignore"] }) ?? ""); }
    catch (error) { if (error?.code !== "ENOENT") return null; }
  }
  this.codexPetOverlayKWinUnavailable = true;
  return null;
}

function codexPetOverlayStartLegacyKWinDrag(window, pending) {
  let state;
  try {
    const generation = pending?.generation ?? (this.codexPetOverlayKWinDragGeneration ?? 0) + 1;
    const pluginName = `codex_pet_overlay_drag_${process.pid}_${Date.now()}_${generation}`;
    const scriptPath = require("node:path").join(require("node:os").tmpdir(), `${pluginName}.js`);
    state = { ...pending, generation, window, pluginName, scriptPath, pending: false };
    require("node:fs").writeFileSync(scriptPath, this.codexPetOverlayKWinDragScript(),
      { encoding: "utf8", flag: "wx", mode: 384 });
    const output = this.codexPetOverlayKWinExecResult(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.loadScript", scriptPath, pluginName]);
    const id = this.codexPetOverlayKWinScriptId(output);
    if (id == null || !this.codexPetOverlayKWinExecSync(["org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting.start"])) {
      this.codexPetOverlayReleaseKWinDrag(state); return null;
    }
    return state;
  } catch { this.codexPetOverlayReleaseKWinDrag(state); return null; }
}

function codexPetOverlayPumpKWinDrag(pending) {
  if (pending?.ending || !pending?.pending || !this.codexPetOverlayKWinDragCurrent(pending) || this.codexPetOverlayKWinHintInFlight) return;
  const state = this.codexPetOverlayStartKWinDrag(pending.window, pending);
  this.codexPetOverlayKWinDragState = state;
  if (!state) {
    this.dragState = null; this.nativeWindowDragActive = false; this.nativeWindowDragStart = null;
    this.clearNativeWindowDragCompletionTimer();
  }
}

function codexPetOverlayBeginKWinDrag(window, event) {
  if (window == null || window.isDestroyed?.() || this.window !== window || !this.codexPetOverlayShouldUseKWin()) return false;
  if (this.codexPetOverlayIsNativeKWin() && !this.codexPetOverlayKWinBridgeFor(window)) return false;
  if (this.codexPetOverlayKWinDragCurrent(this.codexPetOverlayKWinDragState)) return true;
  const native = this.codexPetOverlayIsNativeKWin();
  const position = native ? this.codexPetOverlayKWinFindWindow(window) : null;
  const pointer = { x: event?.pointerWindowX, y: event?.pointerWindowY };
  if (native && (!position || ![pointer.x, pointer.y].every(Number.isFinite))) return false;
  this.codexPetOverlayKWinTimers?.forEach(clearTimeout);
  this.codexPetOverlayKWinEpoch = (this.codexPetOverlayKWinEpoch ?? 0) + 1;
  this.codexPetOverlayKWinPendingBounds = null;
  const generation = this.codexPetOverlayKWinDragGeneration = (this.codexPetOverlayKWinDragGeneration ?? 0) + 1;
  const state = this.codexPetOverlayKWinDragState = { generation, window, position, id: position?.id,
    pointer: native ? pointer : null, mascot: this.layout?.mascot, pending: true,
    rendererGestureId: event?.codexPetOverlayGestureId };
  this.codexPetOverlayPumpKWinDrag(state);
  return this.codexPetOverlayKWinDragState != null;
}

function codexPetOverlayKWinFinish(window, altKey) {
  const drag = this.codexPetOverlayKWinDragState;
  if (!this.codexPetOverlayIsNativeKWin() || !this.codexPetOverlayKWinDragCurrent(drag) ||
      drag.window !== window || !drag.id) return null;
  this.codexPetOverlayKWinDragState = null;
  this.codexPetOverlayReleaseKWinDrag(drag);
  const rect = !drag.failed && drag.result?.id === drag.id ? this.codexPetOverlayRect(drag.result.bounds) : null;
  const position = rect ? { window, id: drag.id, bounds: rect } : null;
  if (position) {
    this.codexPetOverlayKWinPosition = position;
    if (this.layout && drag.mascot) this.layout = { ...this.layout, mascot: drag.mascot };
    if (drag.result.moved === false) {
      this.nativeWindowDragActive = false;
      this.nativeWindowDragStart = null;
      // Upstream records every native geometry completion as movement, including a click.
      this.dragState = null;
      this.clearNativeWindowDragCompletionTimer();
      this.suppressNextRendererThrow = false;
      if (drag.mascot) this.anchor = { ...this.anchor, x: position.bounds.x + drag.mascot.left, y: position.bounds.y + drag.mascot.top };
      if (this.hasDeferredLayout) { this.hasDeferredLayout = false; this.applyLatestElementSizes(window); }
      return { codexPetOverlayNoMovement: true };
    }
    return { bounds: position.bounds, altKey };
  }
  // Keep the last saved anchor if the compositor cannot supply a final position.
  this.clearMovedWindowPersist();
  this.clearNativeWindowDragCompletionTimer();
  this.dragState = null;
  this.nativeWindowDragActive = false;
  this.nativeWindowDragStart = null;
  const deferred = this.hasDeferredLayout;
  this.hasDeferredLayout = false;
  this.suppressNextRendererThrow = true;
  if (deferred) this.applyLatestElementSizes(window);
  if (!drag.pending) this.logger().warning?.("Could not read final KWin Pet position; preserving the saved position", { safe: {} });
  return { codexPetOverlayCancelled: true };
}

function codexPetOverlayKWinRefresh(window) {
  if (!this.codexPetOverlayIsNativeKWin()) return true;
  const previous = this.codexPetOverlayKWinPosition;
  if (previous?.window !== window) return false;
  const position = this.codexPetOverlayKWinReadWindow(window, previous.id);
  if (!position) return false;
  this.codexPetOverlayKWinPosition = position;
  this.handleNativeWindowDragMove(window, position.bounds);
  return true;
}

function codexPetOverlayKWinKeyboard(window, enabled, proceed) {
  if (!this.codexPetOverlayIsNativeKWin()) { proceed(); return; }
  const request = {}, sequence = this.windowVisibilitySequence;
  this.codexPetOverlayKWinKeyboardRequest = request;
  const pending = this.codexPetOverlayKWinPresentation;
  if (pending) { pending.keyboard = enabled ? () => this.setKeyboardInteraction(window.webContents.id, true) : null; return; }
  if (!enabled) {
    proceed();
    if (window.isVisible()) this.codexPetOverlayStartKWinPointer(window);
    return;
  }
  const pointer = this.codexPetOverlayKWinPointer;
  if (!pointer) { proceed(); return; }
  void pointer.cancel().then(released => {
    if ((released || this.codexPetOverlayKWinBridge?.closed || this.codexPetOverlayKWinBridgeFailed) && this.codexPetOverlayKWinKeyboardRequest === request && this.windowVisibilitySequence === sequence && this.window === window &&
        !window.isDestroyed() && window.isVisible() && this.shouldPresentWindow() && this.pendingQuickChatFocus == null) proceed();
  });
}

function codexPetOverlayPresentKWinWindow(window, present) {
  const pending = this.codexPetOverlayKWinPresentation, sequence = this.windowVisibilitySequence;
  if (pending?.window === window && pending.sequence === sequence) return;
  pending?.cancel();
  if (!this.codexPetOverlayIsNativeKWin() || window.isVisible() || this.codexPetOverlayKWinUnavailable) { present(); return; }
  let timer;
  const request = { window, sequence, bounds: this.codexPetOverlayDesiredWindowBounds };
  const cancel = () => {
    clearTimeout(timer);
    window.removeListener("hide", cancel);
    window.removeListener("closed", cancel);
    if (this.codexPetOverlayKWinPresentation === request) this.codexPetOverlayKWinPresentation = null;
    void request.pointer?.cancel();
  };
  request.cancel = cancel;
  request.finish = positioned => {
    const current = this.codexPetOverlayKWinPresentation === request && this.window === window &&
      !window.isDestroyed() && this.windowVisibilitySequence === sequence && this.shouldPresentWindow?.() !== false;
    clearTimeout(timer);
    window.removeListener("hide", cancel);
    window.removeListener("closed", cancel);
    if (this.codexPetOverlayKWinPresentation === request) this.codexPetOverlayKWinPresentation = null;
    if (!current || !positioned) void request.pointer?.cancel();
    if (!current) return;
    if (!positioned) this.logger().warning?.("Could not prepare Mini initial KWin placement; showing the window", { safe: {} });
    present();
    request.keyboard?.();
  };
  this.codexPetOverlayKWinPresentation = request;
  window.once("hide", cancel);
  window.once("closed", cancel);
  // KWin must receive the placement handler before the Wayland surface is mapped.
  try {
    timer = setTimeout(() => request.finish(false), 1500);
    timer.unref?.();
    void (async () => {
      const previous = this.codexPetOverlayKWinBridge;
      if (previous?.closed) await previous.stopped;
      if (this.codexPetOverlayKWinPresentation !== request) return;
      if (this.window !== window || window.isDestroyed() || this.windowVisibilitySequence !== sequence || !this.shouldPresentWindow()) {
        request.finish(false); return;
      }
      this.codexPetOverlayKWinBridgeFor(window, true);
      window.setFocusable(false);
      request.pointer = this.codexPetOverlayStartKWinPointer(window, request.bounds);
      const ready = await (request.pointer?.ready ?? false);
      if (ready && this.codexPetOverlayKWinPresentation === request && ["x", "y", "width", "height"].some(key =>
        request.bounds?.[key] !== this.codexPetOverlayDesiredWindowBounds?.[key])) {
        const keyboard = request.keyboard;
        cancel();
        this.showWindow(window);
        if (this.codexPetOverlayKWinPresentation) this.codexPetOverlayKWinPresentation.keyboard = keyboard;
      } else request.finish(ready);
    })().catch(() => request.finish(false));
  } catch { request.finish(false); }
}

function codexPetOverlayApplyKWinHints(window) {
  if (window == null || window.isDestroyed?.() || window.isVisible?.() === false || this.window !== window ||
      !this.codexPetOverlayShouldUseKWin() || this.dragState != null ||
      this.codexPetOverlayKWinDragState != null || this.codexPetOverlayKWinHintInFlight) return;
  const settings = this.codexPetOverlaySettings();
  const native = this.codexPetOverlayIsNativeKWin();
  const previous = this.codexPetOverlayKWinPosition;
  const sequence = this.windowVisibilitySequence;
  const current = native ? (previous?.window === window
    ? this.codexPetOverlayKWinReadWindow(window, previous.id) : null) ?? this.codexPetOverlayKWinFindWindow(window) : null;
  const initial = previous?.window !== window || previous?.id !== current?.id ? current : null;
  const desired = this.codexPetOverlayDesiredWindowBounds;
  const move = settings.lockPosition || native && current != null && desired != null &&
    ["x", "y", "width", "height"].some(key => current.bounds[key] !== desired[key]);
  this.codexPetOverlayKWinHintInFlight = true;
  this.codexPetOverlayKWinRun(desired, move, error => {
    this.codexPetOverlayKWinHintInFlight = false;
    if (!error && native && current && (move || initial) && this.window === window &&
        window.isVisible?.() !== false && this.windowVisibilitySequence === sequence &&
        this.codexPetOverlayKWinPosition === previous && this.dragState == null) {
      const position = this.codexPetOverlayKWinReadWindow(window, current.id);
      if (position && desired && ["x", "y", "width", "height"].every(key =>
        Math.abs(position.bounds[key] - desired[key]) <= 1)) {
        this.codexPetOverlayKWinPosition = position;
        if (["x", "y", "width", "height"].every(key => desired[key] === this.codexPetOverlayDesiredWindowBounds?.[key])) {
          this.codexPetOverlayKWinPendingBounds = null;
        }
      }
    }
    this.codexPetOverlayPumpKWinDrag(this.codexPetOverlayKWinDragState);
    const next = this.window;
    if (this.codexPetOverlayKWinDragState == null && next != null && !next.isDestroyed?.() &&
        this.codexPetOverlayKWinPendingHints) {
      this.codexPetOverlayKWinPendingHints = false;
      this.codexPetOverlayScheduleKWinHints(next);
    }
  });
}

function buildPetOverlayMethods(settings) {
  return [
    ...Object.values(require("./native-kwin.cjs")).map(method => method.toString().replace(/^(async )?function /, "$1")),
    ...[codexPetOverlayKWinCall, codexPetOverlayKWinReadWindow, codexPetOverlayKWinFindWindow,
      codexPetOverlayKWinGeometry, codexPetOverlayMoveLocalMascotDrag, codexPetOverlayKWinDrawBounds,
      codexPetOverlayKWinLayout, codexPetOverlayKWinLayoutOptions,
      codexPetOverlayKWinScriptId, codexPetOverlayKWinLegacyRun, codexPetOverlayKWinExecResult,
      codexPetOverlayStartLegacyKWinDrag, codexPetOverlayPumpKWinDrag, codexPetOverlayBeginKWinDrag,
      codexPetOverlayKWinFinish, codexPetOverlayKWinRefresh, codexPetOverlayKWinKeyboard, codexPetOverlayPresentKWinWindow, codexPetOverlayApplyKWinHints]
      .map(method => method.toString().replace(/^(async )?function /, "$1")),
    `codexPetOverlayIsNativeKWin(){return ${WAYLAND_WINDOW}&&this.codexPetOverlayShouldUseKWin()}`,
    `codexPetOverlaySettings(){let e={margin:${settings.margin},gravity:\`${settings.gravity}\`,allWorkspaces:${boolLiteral(settings.allWorkspaces)},alwaysOnTop:${boolLiteral(settings.alwaysOnTop)},skipTaskbar:${boolLiteral(settings.skipTaskbar)},lockPosition:${boolLiteral(settings.lockPosition)},mode:\`${settings.mode}\`,hyprland:${boolLiteral(settings.hyprland)},kwin:${boolLiteral(settings.kwin)},niri:${boolLiteral(settings.niri)}};try{let t=process.env.CODEX_PET_OVERLAY_MARGIN??process.env.CODEX_PET_LINUX_MARGIN,n=Number(t);Number.isFinite(n)&&(e.margin=Math.max(0,Math.min(512,Math.round(n))));let r=process.env.CODEX_PET_OVERLAY_GRAVITY??process.env.CODEX_PET_LINUX_GRAVITY;[\`bottom-right\`,\`bottom-left\`,\`top-right\`,\`top-left\`].includes(r)&&(e.gravity=r);let i=process.env.CODEX_PET_OVERLAY_MODE??process.env.CODEX_PET_LINUX_MODE;(i===\`interactive\`||i===\`passive\`)&&(e.mode=i);let a=process.env.CODEX_PET_OVERLAY_LOCK_POSITION??process.env.CODEX_PET_LINUX_LOCK_POSITION;a===\`1\`&&(e.lockPosition=!0),a===\`0\`&&(e.lockPosition=!1);let o=process.env.CODEX_PET_OVERLAY_HYPRLAND??process.env.CODEX_PET_LINUX_HYPRLAND;o===\`1\`&&(e.hyprland=!0),o===\`0\`&&(e.hyprland=!1);let s=process.env.CODEX_PET_OVERLAY_KWIN;s===\`1\`&&(e.kwin=!0),s===\`0\`&&(e.kwin=!1);let c=process.env.CODEX_PET_OVERLAY_NIRI;c===\`1\`&&(e.niri=!0),c===\`0\`&&(e.niri=!1)}catch{}return e}`,
    "codexPetOverlayRect(e){if(e==null)return null;let t=Number(e.x),n=Number(e.y),r=Number(e.width),i=Number(e.height);return[t,n,r,i].every(Number.isFinite)&&r>0&&i>0?{x:t,y:n,width:r,height:i}:null}",
    "codexPetOverlayDisplayRect(e){return this.codexPetOverlayRect(e?.workArea??e?.bounds??e)}",
    "codexPetOverlayWindowBounds(e){try{return this.codexPetOverlayKWinGeometry(e)??this.codexPetOverlayRect(e?.getBounds?.()??e?.getContentBounds?.())}catch{return null}}",
    "codexPetOverlayMoved(e,t,n=8){return e!=null&&t!=null&&(Math.abs(Number(e.x)-Number(t.x))>n||Math.abs(Number(e.y)-Number(t.y))>n)}",
    "codexPetOverlayBoundsNearDisplay(e,t,n=64){if(e==null||t==null)return!1;let r=Number(e.x)+Number(e.width)/2,i=Number(e.y)+Number(e.height)/2,a=Number(t.x),o=Number(t.y),s=Number(t.width),c=Number(t.height);return[r,i,a,o,s,c].every(Number.isFinite)&&r>=a-n&&r<=a+s+n&&i>=o-n&&i<=o+c+n}",
    "codexPetOverlayMascotRect(e){let t=e?.mascot;if(t==null)return null;let n=Number(t.left),r=Number(t.top),i=Number(t.width),a=Number(t.height);return[n,r,i,a].every(Number.isFinite)&&i>0&&a>0?{left:n,top:r,width:i,height:a}:null}",
    "codexPetOverlayLayoutAtWindowPosition(e,t){if(e==null||t==null||t.windowBounds==null)return t;let n={...t.windowBounds,x:Math.round(e.x),y:Math.round(e.y)},r=this.codexPetOverlayMascotRect(t),i=r==null?{x:n.x,y:n.y,width:t.anchor?.width??n.width,height:t.anchor?.height??n.height}:{x:n.x+r.left,y:n.y+r.top,width:r.width,height:r.height},a=t.anchor==null?t.anchor:{...t.anchor,x:Math.round(i.x),y:Math.round(i.y),width:t.anchor.width??i.width,height:t.anchor.height??i.height};return{...t,anchor:a,windowBounds:n}}",
    "codexPetOverlayGravityBounds(e,t,n){if(e==null||t==null||t.windowBounds==null)return null;let r={...t.windowBounds},i=this.codexPetOverlayMascotRect(t)??{left:0,top:0,width:Number(r.width),height:Number(r.height)},a=Number(i.left),o=Number(i.top),s=Number(i.width),c=Number(i.height);if(![a,o,s,c].every(Number.isFinite)||s<=0||c<=0)return null;let l=Math.max(0,Math.min(512,Number(n?.margin)||0)),u=String(n?.gravity??`bottom-right`);return r.x=u.endsWith(`left`)?Math.round(e.x+l-a):Math.round(e.x+e.width-l-a-s),r.y=u.startsWith(`top`)?Math.round(e.y+l-o):Math.round(e.y+e.height-l-o-c),r}",
    "codexPetOverlayTrayAboveLeft(e){if(process.platform!==`linux`||e==null||e.windowBounds==null||e.mascot==null||e.tray==null)return e;let t=Number(e.windowBounds.width),n=Number(e.windowBounds.height),r=Number(e.mascot.width),i=Number(e.mascot.height),a=Number(e.tray.width),o=Number(e.tray.height);if(![t,n,r,i,a,o].every(Number.isFinite)||t<=0||n<=0||r<=0||i<=0||a<=0||o<=0)return e;let s=4,c=Math.max(0,Math.min(Math.round(t),Math.round(a))),l=Math.max(0,Math.min(Math.max(0,Math.round(n-i-s)),Math.round(o))),u=this.codexPetOverlayMascotLocalPosition,d=Number(u?.left),p=Number(u?.top),h=[d,p].every(Number.isFinite),m=Math.max(0,Math.min(Math.round(t-r),Math.round(h?d:t-r))),f=Math.max(0,Math.min(Math.round(n-i),Math.round(h?p:n-i))),g=Math.max(0,Math.round(n-i-s-l)),v=Math.max(0,Math.min(Math.round(n-i),Math.round(l+s)));if(g<v&&f>g&&f<v){f=Math.abs(f-g)<=Math.abs(v-f)?g:v,h&&(this.codexPetOverlayMascotLocalPosition={left:m,top:f})}let w=Math.max(0,Math.min(Math.round(t-c),Math.round(m+r-c))),x=f>=l+s?f-l-s:f+i+s;x=Math.max(0,Math.min(Math.round(n-l),Math.round(x)));let y=e.anchor??{x:Number(e.windowBounds.x)+(Number(e.mascot.left)||0),y:Number(e.windowBounds.y)+(Number(e.mascot.top)||0),width:r,height:i},b=h?{...e.windowBounds}:{...e.windowBounds,x:Math.round(Number(y.x)-m),y:Math.round(Number(y.y)-f)},k={...y,x:Math.round(Number(b.x)+m),y:Math.round(Number(b.y)+f),width:y.width??r,height:y.height??i};return{...e,anchor:k,mascot:{...e.mascot,left:m,top:f,width:r,height:i},tray:{...e.tray,left:w,top:x,width:c,height:l},placement:`top-end`,windowBounds:b}}",
    "codexPetOverlayDragFromCurrentRenderer(e){let t=this.window;return!(t==null||t.isDestroyed?.()||t.webContents?.id!==e)}",
    "codexPetOverlayStartLocalMascotDrag(e,t){if(!this.codexPetOverlayDragFromCurrentRenderer(e)||process.platform!==`linux`||this.codexPetOverlayShouldLockPosition())return!1;let n=this.layout,r=this.codexPetOverlayMascotRect(n),i=Number(t?.pointerWindowX),a=Number(t?.pointerWindowY);if(r==null||![i,a].every(Number.isFinite)||i<r.left||a<r.top||i>r.left+r.width||a>r.top+r.height)return!1;" +
      `if(${WAYLAND_WINDOW}&&this.codexPetOverlayBeginKWinDrag(this.window,t))return!1;` +
      "return this.codexPetOverlayMascotDragState={offsetX:i-r.left,offsetY:a-r.top,rendererGestureId:t?.codexPetOverlayGestureId},!0}",
    "codexPetOverlayEndLocalMascotDrag(e){return!this.codexPetOverlayDragFromCurrentRenderer(e)||this.codexPetOverlayMascotDragState==null?!1:(this.codexPetOverlayMascotDragState=null,!0)}",
    "codexPetOverlayRememberLayout(e,t){let n=this.codexPetOverlayRect(t);this.codexPetOverlayDesiredDisplayBounds=n==null?null:{x:Math.round(n.x),y:Math.round(n.y),width:Math.round(n.width),height:Math.round(n.height)};let r=this.codexPetOverlayRect(e?.windowBounds);if(r!=null){let i={x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)},a=this.codexPetOverlayDesiredWindowBounds,o=a==null||a.x!==i.x||a.y!==i.y||a.width!==i.width||a.height!==i.height;this.codexPetOverlayDesiredWindowBounds=i;if(this.codexPetOverlayIsNativeKWin()){let e=this.codexPetOverlayKWinGeometry(this.window);this.codexPetOverlayKWinPendingBounds=e!=null&&[`x`,`y`,`width`,`height`].every(t=>e[t]===i[t])?null:i;}if(o&&this.window!=null){let e=this.codexPetOverlaySettings();try{e.lockPosition===!0&&this.codexPetOverlayScheduleHyprlandHints(this.window)}catch{}try{this.dragState!=null?this.codexPetOverlayQueueKWinDrag(this.window):this.codexPetOverlayScheduleKWinHints(this.window)}catch{}try{this.dragState!=null?this.codexPetOverlayQueueNiriDrag(this.window):this.codexPetOverlayScheduleNiriHints(this.window)}catch{}}}return e}",
    "codexPetOverlayLayoutForDisplay(e,t,n){if(process.platform!==`linux`||t==null||t.windowBounds==null)return this.codexPetOverlayRememberLayout(this.codexPetOverlayTrayAboveLeft(t));let r=this.codexPetOverlayDisplayRect(e);if(this.codexPetOverlayIsNativeKWin()){if(this.codexPetOverlaySettings().lockPosition&&r){let n=this.codexPetOverlayGravityBounds(r,t,this.codexPetOverlaySettings());if(n)t=this.getLayoutForDisplay(e,this.codexPetOverlayLayoutAtWindowPosition(n,t).anchor);}return this.codexPetOverlayRememberLayout(t,r);}let i=this.codexPetOverlaySettings(),a=t;if(i.lockPosition===!0&&r!=null){let e=this.codexPetOverlayGravityBounds(r,a,i);e!=null&&(a=this.codexPetOverlayLayoutAtWindowPosition(e,a))}else if(this.dragState==null&&!this.codexPetOverlayIsNativeKWin()){let e=this.codexPetOverlayWindowBounds(n),o=!1;try{o=n?.isVisible?.()===!0}catch{}e!=null&&r!=null&&this.codexPetOverlayBoundsNearDisplay(e,r)&&(o||this.codexPetOverlayInitialPositionDone===!0||this.codexPetOverlayManualPosition===!0)?(this.codexPetOverlayInitialPositionDone=!0,this.codexPetOverlayMoved(e,a.windowBounds)&&(this.codexPetOverlayManualPosition=!0),a=this.codexPetOverlayLayoutAtWindowPosition(e,a)):this.codexPetOverlayInitialPositionDone=!0}return this.codexPetOverlayRememberLayout(this.codexPetOverlayTrayAboveLeft(a),r)}",
    "codexPetOverlayShouldUseWholeWindowInput(){return process.platform===`linux`&&this.codexPetOverlaySettings().lockPosition!==!0}",
    // The KWin cursor bridge owns Wayland gestures; Chromium drag regions bypass its bounds and completion handling.
    "codexPetOverlayInstallTransparentRenderer(e){try{this.codexLinuxWholeWindowInput=this.codexPetOverlayShouldUseWholeWindowInput();if(e.__codexPetOverlayTransparentRendererInstalled)return;e.__codexPetOverlayTransparentRendererInstalled=!0;let t=e.webContents,n=()=>{try{let n=`html,body,#root,main,[data-avatar-overlay-content-frame=\"true\"]{background:transparent!important;background-color:transparent!important;}[data-codex-window-type=\"electron\"].electron-opaque,[data-codex-window-type=\"electron\"].electron-opaque body{background:transparent!important;background-color:transparent!important;background-image:none!important;}`;this.codexLinuxWholeWindowInput=this.codexPetOverlayShouldUseWholeWindowInput(),this.codexLinuxWholeWindowInput&&(n+=this.codexPetOverlayIsNativeKWin()?`html,body,#root,#root *{-webkit-app-region:no-drag!important;app-region:no-drag!important;}`:`html,body,#root,main,[data-avatar-overlay-content-frame=\"true\"]{-webkit-app-region:drag!important;app-region:drag!important;user-select:none!important;-webkit-user-select:none!important;}[data-avatar-overlay-hit-region=\"mascot\"],[data-avatar-mascot=\"true\"],.no-drag,[data-avatar-overlay-hit-region=\"notification-tray\"],[data-avatar-overlay-hit-region=\"notification-scroll-control\"]{-webkit-app-region:no-drag!important;app-region:no-drag!important;}`),t==null||t.isDestroyed?.()||t.insertCSS?.(n,{cssOrigin:`author`}),t==null||t.isDestroyed?.()||t.executeJavaScript?.(`try{document.documentElement.style.background=\"transparent\";document.body&&(document.body.style.background=\"transparent\")}catch{}`,!0)}catch{}};t?.on?.(`did-finish-load`,n),n()}catch{}}",
    "codexPetOverlayRestoreFocusableAfterInactiveShow(e){if(this.codexPetOverlayIsNativeKWin())return;try{let t=setTimeout(()=>{try{e==null||e.isDestroyed?.()||this.window!==e||this.codexPetOverlaySettings().mode===`passive`||e.setFocusable?.(!0)}catch{}},0);try{t.unref?.()}catch{}}catch{}}",
    "codexPetOverlaySyncWindow(e,t=!1){if(process.platform!==`linux`||e==null||e.isDestroyed?.())return;this.codexLinuxWholeWindowInput=this.codexPetOverlayShouldUseWholeWindowInput();let n=this.codexPetOverlaySettings(),r=n.mode!==`passive`,i=t&&r&&this.codexPetOverlayIsNativeKWin()&&e.isVisible?.()===!0;try{e.setTitle?.(`Codex Pet Overlay`)}catch{}try{!i&&e.setFocusable?.(r&&!t)}catch{}try{!i&&t&&r&&this.codexPetOverlayRestoreFocusableAfterInactiveShow(e)}catch{}try{e.setSkipTaskbar?.(!!n.skipTaskbar)}catch{}try{e.setAlwaysOnTop?.(!!n.alwaysOnTop)}catch{}try{e.setBackgroundColor?.(`#00000000`)}catch{}try{this.codexPetOverlayInstallTransparentRenderer(e)}catch{}try{e.setOpacity?.(1)}catch{}try{e.setVisibleOnAllWorkspaces?.(!!n.allWorkspaces,{visibleOnFullScreen:!!n.allWorkspaces})}catch{try{e.setVisibleOnAllWorkspaces?.(!!n.allWorkspaces)}catch{}}try{n.alwaysOnTop&&e.moveTop?.()}catch{}try{this.codexPetOverlayScheduleHyprlandHints(e)}catch{}try{this.codexPetOverlayScheduleKWinHints(e)}catch{}try{this.codexPetOverlayScheduleNiriHints(e)}catch{}}",
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
    "codexPetOverlayScheduleKWinHints(e){if(!this.codexPetOverlayShouldUseKWin()||this.dragState!=null||this.codexPetOverlayKWinDragState!=null)return;if(this.codexPetOverlayKWinHintInFlight){this.codexPetOverlayKWinPendingHints=!0;return}this.codexPetOverlayKWinPendingHints=!1;try{this.codexPetOverlayKWinTimers?.forEach(clearTimeout)}catch{}this.codexPetOverlayKWinTimers=[0,80,300,1000,2500].map(t=>{let n=setTimeout(()=>{try{this.codexPetOverlayApplyKWinHints(e)}catch{}},t);try{n.unref?.()}catch{}return n})}",
    "codexPetOverlayKWinExecSync(e){return this.codexPetOverlayKWinExecResult(e)!=null}",
    "codexPetOverlayKWinDragScript(){let e={pid:Number(process.pid),title:`Codex Pet Overlay`};return `(function(){var d=${JSON.stringify(e)};function windows(){try{if(typeof workspace.windowList==='function')return workspace.windowList()}catch(e){}try{if(typeof workspace.clientList==='function')return workspace.clientList()}catch(e){}return[]}var a=windows().filter(function(w){try{return String(w.caption||'')===d.title&&Number(w.pid)===d.pid}catch(e){return false}});if(a.length!==1)return;var w=a[0],p=workspace.cursorPos,g=w.frameGeometry,dx=Number(p.x)-Number(g.x),dy=Number(p.y)-Number(g.y),active=true;function move(){if(!active)return;try{var p=workspace.cursorPos,g=w.frameGeometry;w.frameGeometry={x:Math.round(Number(p.x)-dx),y:Math.round(Number(p.y)-dy),width:g.width,height:g.height}}catch(e){stop()}}function stop(){if(!active)return;active=false;try{workspace.cursorPosChanged.disconnect(move)}catch(e){}}try{workspace.cursorPosChanged.connect(move)}catch(e){return}try{workspace.windowRemoved.connect(function(v){if(v===w)stop()})}catch(e){}try{if(typeof workspace.raiseWindow==='function')workspace.raiseWindow(w)}catch(e){}})()`}",
    "codexPetOverlayReleaseKWinDrag(e){if(e?.native){if(!e.stopped){e.released=!0;e.stopped=!0;void e.bridge?.request(`endDrag`,{},()=>this.window===e.window&&!e.window.isDestroyed()).catch(()=>{})}return}if(e?.pluginName==null)return;try{this.codexPetOverlayKWinExecSync([`org.kde.KWin`,`/Scripting`,`org.kde.kwin.Scripting.unloadScript`,e.pluginName])}catch{}try{require(`node:fs`).unlinkSync(e.scriptPath)}catch{}}",
    "codexPetOverlayKWinDragCurrent(e){if(e==null||this.codexPetOverlayKWinDragState!==e||this.codexPetOverlayKWinDragGeneration!==e.generation)return!1;if(this.window===e.window&&!e.window?.isDestroyed?.())return!0;this.codexPetOverlayKWinDragState=null,this.codexPetOverlayReleaseKWinDrag(e);return!1}",
    "codexPetOverlayQueueKWinDrag(e){let t=this.codexPetOverlayKWinDragState;return this.codexPetOverlayKWinDragCurrent(t)&&t.window===e}",
    "codexPetOverlayEndKWinDrag(e,t){let n=this.codexPetOverlayKWinDragState;if(!this.codexPetOverlayKWinDragCurrent(n)||n.window!==e)return!1;this.codexPetOverlayKWinDragState=null,this.codexPetOverlayReleaseKWinDrag(n);try{typeof t===`function`&&t()}catch{}try{this.window!=null&&!this.window.isDestroyed?.()&&this.window.isVisible?.()!==!1&&this.codexPetOverlayScheduleKWinHints(this.window)}catch{}return!0}",
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
    "codexPetOverlayBeginCompositorDrag(e,n){let t=this.codexPetOverlayBeginKWinDrag(e,n)||this.codexPetOverlayBeginNiriDrag(e);return t&&(this.nativeWindowDragStart=null,this.nativeWindowDragActive=!0),!!t}",
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
    `${AVATAR_OVERLAY_APPEARANCE},`,
    `${AVATAR_OVERLAY_APPEARANCE},frame:process.platform===\`linux\`?!1:!0,`,
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
    const eventArg = firstMethodArgument(startMethod.match[0], "startDrag", 1);
    if (windowMatch == null || eventArg == null || !startMethod.text.includes("this.dragState=")) {
      console.warn("WARN: Could not identify current avatar overlay drag start shape - skipping compositor transport hook");
      return patched;
    }
    patched = replaceMethodText(
      patched,
      startMethod,
      `${startMethod.text.slice(0, -1)},this.codexPetOverlayIsNativeKWin()&&Object.assign(this.dragState,{codexPetOverlayGestureId:${eventArg}.codexPetOverlayGestureId,codexPetOverlayWindow:${windowMatch[1]},codexPetOverlaySequence:this.windowVisibilitySequence}),this.codexPetOverlayBeginCompositorDrag(${windowMatch[1]},${eventArg})}`,
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
    const movementIntentMatch = moveMethod.text.match(
      /([A-Za-z_$][\w$]*)\.recordMovementIntent\(\)/,
    );
    const nativeDragBoundary = ",this.nativeWindowDragActive)return;";
    if (
      windowMatch == null || eventArg == null || movementIntentMatch == null ||
      moveMethod.text.split(nativeDragBoundary).length !== 2
    ) {
      console.warn("WARN: Could not identify current avatar overlay drag move shape - skipping compositor transport hook");
      return patched;
    }
    const replacement = `,this.codexPetOverlayMoveCompositorDrag(${windowMatch[1]},${eventArg})||this.nativeWindowDragActive)return;`;
    patched = replaceMethodText(
      patched,
      moveMethod,
      moveMethod.text.replace(nativeDragBoundary, replacement),
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
    /let [A-Za-z_$][\w$]*=this\.dragState,([A-Za-z_$][\w$]*)=this\.nativeWindowDragActive,([A-Za-z_$][\w$]*)=\1\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\):null,([A-Za-z_$][\w$]*)=\2\?\.bounds,([A-Za-z_$][\w$]*)=\1\?\2\?\.altKey===!0:([A-Za-z_$][\w$]*);/,
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
  const caller = firstMethodArgument(endMethod.match[0], "endDrag", 0);
  const third = firstMethodArgument(endMethod.match[0], "endDrag", 2);
  const fourth = firstMethodArgument(endMethod.match[0], "endDrag", 3);
  if (!caller || !third || !fourth) return source;
  const nativeBoundsVar = nativeBoundsMatch[5];
  const [nativeState, nativeActive, stateVar, stateFunction, stateWindow, , , altArg] = nativeBoundsMatch;
  const start = endMethod.match[0].length;
  const gated = endMethod.text.slice(0, start) +
    `if(this.codexPetOverlayDeferKWinEnd(${caller},()=>this.endDrag(${caller},${eventArg},${third},${fourth})))return;` + endMethod.text.slice(start);
  const added = gated.length - endMethod.text.length;
  const prefix = gated.slice(0, completionStart + added).replace(nativeState,
    nativeState.replace(`${nativeActive}?${stateFunction}(${stateWindow}):null`,
      `${nativeActive}?this.codexPetOverlayKWinFinish(${stateWindow},${altArg})??${stateFunction}(${stateWindow}):null`) +
      `if(${stateVar}?.codexPetOverlayCancelled||${stateVar}?.codexPetOverlayNoMovement)return;`);
  const niriCompletion = completionNeedle.replace(
    "if(this.suppressNextRendererThrow=",
    `${nativeBoundsVar}=this.codexPetOverlayDesiredWindowBounds??this.codexPetOverlayWindowBounds(${windowVar})??${nativeBoundsVar};if(this.suppressNextRendererThrow=`,
  );
  return replaceMethodText(
    patched,
    endMethod,
    prefix +
      `this.codexPetOverlayEndKWinDrag(${windowVar},()=>{${completionNeedle}})||this.codexPetOverlayEndNiriDrag(${windowVar},${eventArg},()=>{${niriCompletion}})||(()=>{${completionNeedle}})()` +
      "}",
  );
}

function patchKWinGeometry(source) {
  let patched = source;
  for (const name of ["handleNativeWindowDragMove", "rememberMovedWindow"]) {
    const method = findAvatarOverlayMethod(patched, new RegExp(`(?<![\\w$.])${name}\\([^{}]*\\)\\{`));
    if (method?.text.includes("this.codexPetOverlayKWinGeometry(")) continue;
    const windowArg = method && firstMethodArgument(method.match[0], name, 0);
    const boundsArg = method && firstMethodArgument(method.match[0], name, 1);
    if (!windowArg || !boundsArg) return source;
    // Programmatic KWin placement must not be recorded as a user drag.
    let text = method.text.slice(0, method.match[0].length) +
      `if(this.codexPetOverlayIsNativeKWin()){if(this.codexPetOverlayKWinDragState!=null||this.codexPetOverlayKWinHintInFlight||this.codexPetOverlayKWinPendingBounds!=null)return;${boundsArg}??=this.codexPetOverlayKWinGeometry(${windowArg});if(${boundsArg}==null)return;}` +
      method.text.slice(method.match[0].length);
    if (name === "rememberMovedWindow") {
      const boundary = `?this.rememberMovedWindow(${windowArg}):(this.hasDeferredLayout&&`;
      if (text.split(boundary).length !== 2) return source;
      text = text.replace(boundary, `?this.rememberMovedWindow(${windowArg}):this.codexPetOverlayKWinRefresh(${windowArg})&&(this.hasDeferredLayout&&`);
    }
    patched = replaceMethodText(patched, method, text);
  }
  return patched;
}

function patchKWinCoordinateConsumers(source) {
  let patched = source;
  for (const name of KWIN_COORDINATE_CONSUMERS) {
    const method = findAvatarOverlayMethod(patched, new RegExp(`(?<![\\w$.])${name}\\([^{}]*\\)\\{`));
    if (method?.text.includes("this.codexPetOverlayKWinGeometry(")) continue;
    if (name === "updateCssPetControlsProximityTracking" &&
        method?.text.includes("this.codexPetOverlayKWinProximity()") &&
        /null==this\.stopPetControlsProximity&&\([^;]*?this\.stopPetControlsProximity=function\(/.test(method.text)) continue;
    const reads = method && [...method.text.matchAll(/([A-Za-z_$][\w$]*)\.getContentBounds\(\)/g)];
    const currentProximityHelper = name === "updateCssPetControlsProximityTracking" &&
      reads?.length === 0 &&
      /null==this\.stopPetControlsProximity&&\([^;]*?this\.stopPetControlsProximity=function\(/.test(method.text) &&
      /"darwin"!==process\.platform\|\|this\.isNotchEnabled\?null:this\.nativeAppearanceBridge,[A-Za-z_$][\w$]*,\(\)=>\{this\.updatePetPointerProximity\(\)\},this\.isNotchEnabled\?100:[\w$]+\)/.test(method.text);
    if (reads?.length !== 1 && !currentProximityHelper) return source;
    const [read] = reads ?? [];
    let text = read == null
      ? method.text
      : method.text.replace(read[0], `(this.codexPetOverlayKWinGeometry(${read[1]})??${read[0]})`);
    if (name === "updateCssPetControlsProximityTracking") {
      text = method.match[0] + "if(this.codexPetOverlayIsNativeKWin()&&this.codexPetOverlayKWinProximity()){if(this.stopPetControlsProximity!=null){this.stopPetControlsProximity();this.stopPetControlsProximity=null}return;}" + text.slice(method.match[0].length);
    }
    if (name === "isOverlayWindowPointerDragActive") {
      text = method.match[0] + "if(this.codexPetOverlayIsNativeKWin()&&this.codexPetOverlayKWinDragCurrent(this.codexPetOverlayKWinDragState))return!0;" +
        text.slice(method.match[0].length);
    }
    patched = replaceMethodText(patched, method, text);
  }
  return patched;
}

function patchKWinProximityPublication(source) {
  let patched = source;
  for (const name of ["setPointerRegions", "sendLayoutToRenderer"]) {
    const signature = `(?<![\\w$.])${name}\\([^{}]*\\)\\{`;
    const owner = findAvatarOverlayClass(patched);
    if (!owner || [...owner.text.matchAll(new RegExp(signature, "g"))].length !== 1) return source;
    const method = findAvatarOverlayMethod(patched, new RegExp(signature));
    if (method.text.includes("this.codexPetOverlayKWinProximity()")) continue;
    const call = "if(this.codexPetOverlayIsNativeKWin())this.codexPetOverlayKWinProximity();";
    patched = replaceMethodText(patched, method, name === "setPointerRegions" ? method.text.slice(0, -1) + ";" + call + "}" :
      method.match[0] + call + method.text.slice(method.match[0].length));
  }
  return patched;
}

function patchKWinDragCleanup(source) {
  const method = findAvatarOverlayMethod(source, /(?<![\w$.])unregisterNativeWindowDragTarget\([^{}]*\)\{/);
  if (method?.text.includes("this.codexPetOverlayEndKWinDrag(this.window);")) return source;
  const needle = method == null ? null : `${method.match[0]}try{`;
  if (method == null || !method.text.startsWith(needle)) {
    console.warn("WARN: Could not identify avatar overlay native drag cleanup - skipping KWin drag cleanup");
    return source;
  }
  return replaceMethodText(source, method, method.text.replace(needle,
    `${needle}this.codexPetOverlayKWinKeyboardRequest=null;this.codexPetOverlayKWinPresentation?.cancel();this.codexPetOverlayKWinPointer?.cancel();this.codexPetOverlayKWinActivation?.cancel();this.codexPetOverlayKWinEpoch=(this.codexPetOverlayKWinEpoch??0)+1;this.codexPetOverlayEndKWinDrag(this.window);this.codexPetOverlayKWinPosition=null;this.codexPetOverlayKWinPendingBounds=null;`));
}

// getLayoutForDisplay passes its options to an inlined pure layout function:
// `function({anchor:...}){...}({anchor:...})`. KWin layout fitting needs to
// call that same pure function repeatedly, so bind it once and hand it to the
// options helper before the real layout call.
function inlineLayoutCall(text) {
  const signatures = [...text.matchAll(/function\(\{anchor:[A-Za-z_$][\w$]*,constrainNativeDrawWindowToDisplay:/g)];
  if (signatures.length !== 1) return null;
  const start = signatures[0].index;
  const paramsOpen = start + "function(".length;
  const paramsClose = findMatchingBrace(text, paramsOpen);
  if (paramsClose < 0 || text.slice(paramsClose + 1, paramsClose + 3) !== "){") return null;
  const bodyClose = findMatchingBrace(text, paramsClose + 2);
  if (bodyClose < 0 || text.slice(bodyClose + 1, bodyClose + 9) !== "({anchor") return null;
  const optionsOpen = bodyClose + 2;
  const optionsClose = findMatchingBrace(text, optionsOpen);
  if (optionsClose < 0 || text[optionsClose + 1] !== ")") return null;
  return {
    start,
    end: optionsClose + 2,
    fn: text.slice(start, bodyClose + 1),
    options: text.slice(optionsOpen, optionsClose + 1),
  };
}

function patchNativeDrawBounds(source) {
  const method = findAvatarOverlayMethod(source, /(?<![\w$.])getLayoutForDisplay\([^{}]*\)\{/);
  if (method?.text.includes(NATIVE_DRAW_CONSTRAINT)) {
    return source;
  }
  const call = method == null ? null : inlineLayoutCall(method.text);
  if (call == null || call.options.split(UPSTREAM_NATIVE_DRAW_CONSTRAINT).length !== 2) {
    console.warn("WARN: Could not identify avatar overlay native drawing constraint - skipping pet overlay bounds patch");
    return source;
  }
  const display = firstMethodArgument(method.match[0], "getLayoutForDisplay", 0);
  const anchor = call.options.match(/^\{anchor:([A-Za-z_$][\w$]*),constrainNativeDrawWindowToDisplay:/)?.[1];
  const draw = call.options.match(/nativeDrawWindowBounds:([^,]+),displayBounds:/);
  const result = method.text.match(/return ([A-Za-z_$][\w$]*)\}$/)?.[1];
  if (!display || !anchor || !draw || !result) return source;
  const options = call.options.replace(UPSTREAM_NATIVE_DRAW_CONSTRAINT, NATIVE_DRAW_CONSTRAINT)
    .replace(draw[0], `nativeDrawWindowBounds:this.codexPetOverlayIsNativeKWin()?this.codexPetOverlayKWinDrawBounds(${display},${anchor}):${draw[1]},displayBounds:`);
  const text = method.text.slice(0, call.start) +
    `(codexPetOverlayLayout=>codexPetOverlayLayout(this.codexPetOverlayKWinLayoutOptions(${options},codexPetOverlayLayout)))(${call.fn})` +
    method.text.slice(call.end).replace(new RegExp(`return ${result}\\}$`), `return this.codexPetOverlayKWinLayout(${display},${result})}`);
  return replaceMethodText(source, method, text);
}

function patchKWinWindowSize(source) {
  const method = findAvatarOverlayMethod(source, /(?<![\w$.])setWindowBounds\([^{}]*\)\{/);
  if (method?.text.includes("this.codexPetOverlayIsNativeKWin()")) return source;
  const window = method && firstMethodArgument(method.match[0], "setWindowBounds", 0);
  const bounds = method && firstMethodArgument(method.match[0], "setWindowBounds", 1);
  if (!window || !bounds) return source;
  const body = `if(this.codexPetOverlayIsNativeKWin()){if(${window}.isDestroyed())return;let s=${window}.getContentBounds();if(s.width!==${bounds}.width||s.height!==${bounds}.height)${window}.setContentSize(${bounds}.width,${bounds}.height);return;}`;
  return replaceMethodText(source, method, method.match[0] + body + method.text.slice(method.match[0].length));
}

function patchHiddenQuickChatFocus(source) {
  const method = findAvatarOverlayMethod(source, /(?<![\w$.])focusQuickChat\([^{}]*\)\{/);
  if (method?.text.includes("codexPetOverlayHiddenFocus:")) return source;
  const windowName = method?.text.match(/\{let ([A-Za-z_$][\w$]*)=this\.window;/)?.[1];
  if (windowName == null || method.text.split("wasHidden:!0").length !== 2) {
    console.warn("WARN: Could not identify avatar overlay Quick Chat focus request - skipping hidden focus patch");
    return source;
  }
  return replaceMethodText(source, method, method.text.replace(
    "wasHidden:!0",
    `wasHidden:!0,codexPetOverlayHiddenFocus:${WAYLAND_WINDOW}&&!${windowName}.isVisible()`,
  ));
}

function patchKWinKeyboardFocus(source) {
  const method = findAvatarOverlayMethod(source, /(?<![\w$.])setKeyboardInteraction\([^{}]*\)\{/);
  if (method?.text.includes("this.codexPetOverlayActivateKWin(")) return source;
  const window = method?.text.match(/\{let ([A-Za-z_$][\w$]*)=this\.window;/)?.[1];
  const enabled = method && firstMethodArgument(method.match[0], "setKeyboardInteraction", 1);
  const focus = window && `${window}.focus(),${window}.webContents.focus()`;
  // The disabled path is the false branch of `enabled?(...):...` and runs to
  // the end of the method.
  const disabled = window && `):"on-demand"===this.visibilityMode&&!this.hiddenOnDemand&&`;
  const onDemand = window && `null==this.nativeAppearanceBridge&&${window}.isVisible()`;
  if (!window || !enabled || method.text.split(focus).length !== 2 || method.text.split(disabled).length !== 2 ||
      method.text.split(onDemand).length !== 2) return source;
  const prefix = method.text.indexOf("this.applyPointerInteractivityPolicy();");
  const branch = method.text.indexOf(`;${enabled}?(`);
  const restore = /this\.handleQuickChatKeyboardInteraction\(!1,([^;()]+)\)\)\}$/;
  if (prefix < 0 || branch < prefix || !restore.test(method.text)) return source;
  const disabledStart = method.text.indexOf(disabled) + 2;
  let text = method.text.slice(0, disabledStart) + "(this.codexPetOverlayKWinActivation?.cancel()," +
    method.text.slice(disabledStart, -1) + ")}";
  text = text
    .replace(onDemand, `${onDemand}&&!this.codexPetOverlayIsNativeKWin()`)
    .replace(/this\.handleQuickChatKeyboardInteraction\(!1,([^;()]+)\)\)\)\}$/,
      "this.handleQuickChatKeyboardInteraction(!1,$1&&!this.codexPetOverlayIsNativeKWin())))}")
    .replace(focus, `${focus},this.codexPetOverlayActivateKWin(${window}).catch(error=>{this.logger().warning?.(\`Could not activate Mini through KWin\`,{safe:{},sensitive:{error}})})`);
  return replaceMethodText(source, method, text.slice(0, prefix) +
    `return this.codexPetOverlayKWinKeyboard(${window},${enabled},()=>{` + text.slice(prefix, -1) + "})}");
}

function patchKWinGestureService(source) {
  if (source.includes("codexPetOverlayCompleteDrag(e,t,n=null){")) return source;
  const ident = "[A-Za-z_$][\\w$]*";
  const api = new RegExp(`completeQuickChatFocus\\((?<a>${ident}),(?<b>${ident})\\)\\{return this\\.(?<manager>${ident})\\.completeQuickChatFocus\\(this\\.(?<origin>${ident})\\.id,\\k<a>,\\k<b>\\)\\}`, "gu");
  const apis = [...source.matchAll(api)], routes = [...source.matchAll(/case"avatar-overlay-drag-start":\{/gu)];
  const method = findAvatarOverlayMethod(source, /(?<![\w$.])sendLayoutToRenderer\([^{}]*\)\{/);
  const serialize = new RegExp(`let (${ident})=(${ident})\\(this\\.layout\\),`, "gu");
  if (apis.length !== 1 || routes.length !== 1 || !method || [...method.text.matchAll(serialize)].length !== 1) return source;
  const open = source.indexOf("{", routes[0].index), end = findMatchingBrace(source, open);
  const route = source.slice(open, end + 1);
  const calls = [...route.matchAll(new RegExp(`(?<manager>${ident})\\.startDrag\\((?<sender>${ident})\\.id,(?<event>${ident}),(?<message>${ident})\\.usesOrbPhysics\\);return`, "gu"))];
  if (calls.length !== 1) return source;
  const text = method.text.replace(serialize,
    "let $1={...$2(this.layout),codexPetOverlayNativeDrag:this.codexPetOverlayIsNativeKWin()&&!this.codexPetOverlayShouldLockPosition()},");
  let patched = replaceMethodText(source, method, text);
  const { manager, origin } = apis[0].groups;
  patched = patched.replace(apis[0][0], apis[0][0] +
    `codexPetOverlayCompleteDrag(e,t,n=null){return this.${manager}.codexPetOverlayCompleteRendererDrag(this.${origin}.id,e,t,n)}`);
  const call = calls[0];
  return patched.replace(route, route.replace(call[0],
    `${call.groups.event}.codexPetOverlayGestureId=${call.groups.message}.codexPetOverlayGestureId;${call[0]}`));
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
  let text = method.text.replace(needle, replacement);
  const onDemand = '"on-demand"!==this.visibilityMode||null!=this.nativeAppearanceBridge||(';
  if (text.split(onDemand).length !== 2) {
    console.warn("WARN: Could not identify avatar overlay showWindow on-demand focus - skipping pet overlay window sync");
    return source;
  }
  text = text.replace(onDemand,
    '"on-demand"!==this.visibilityMode||null!=this.nativeAppearanceBridge||this.codexPetOverlayIsNativeKWin()||(');
  const prefix = text.match(/^showWindow\([^)]*\)\{if\([^;]+\)return;let [A-Za-z_$][\w$]*=this\.isOpen\(\);/);
  if (!prefix) return source;
  text = prefix[0] +
    `return this.codexPetOverlayPresentKWinWindow(${windowArg},()=>{` +
    text.slice(prefix[0].length, -1) + "})}";
  return replaceMethodText(source, method, text);
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
    const third = methodName === "startDrag" ? firstMethodArgument(method.match[0], methodName, 2) : null;
    if (methodName === "startDrag" && !third) return source;
    const startGate = methodName === "startDrag" ?
      `if(this.codexPetOverlayDeferKWinStart(${callerArg},${eventArg}?.codexPetOverlayGestureId,()=>this.startDrag(${callerArg},${eventArg},${third})))return;` : "";
    patched = replaceMethodText(
      patched,
      method,
      method.text.slice(0, method.match[0].length) + startGate + `if(${call})return;` + method.text.slice(method.match[0].length),
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

function hasCompletePetOverlayPatch(source, localMascotDragExpected) {
  const show = findAvatarOverlayMethod(source, /(?<![\w$.])showWindow\([^{}]*\)\{/);
  const requiredMarkers = [
    source.includes("codexPetOverlayCompleteDrag(e,t,n=null){"),
    /\.codexPetOverlayGestureId=[A-Za-z_$][\w$]*\.codexPetOverlayGestureId/.test(source),
    findAvatarOverlayMethod(source, /(?<![\w$.])sendLayoutToRenderer\([^{}]*\)\{/)?.text.includes("codexPetOverlayNativeDrag:"),
    ...["setPointerRegions", "sendLayoutToRenderer"].map(name => findAvatarOverlayMethod(source,
      new RegExp(`(?<![\\w$.])${name}\\([^{}]*\\)\\{`))?.text.includes("this.codexPetOverlayKWinProximity()")),
    ...KWIN_COORDINATE_CONSUMERS.map(name => {
      const method = findAvatarOverlayMethod(
        source,
        new RegExp(`(?<![\\w$.])${name}\\([^{}]*\\)\\{`),
      );
      return method?.text.includes("this.codexPetOverlayKWinGeometry(") ||
        name === "updateCssPetControlsProximityTracking" &&
          method?.text.includes("this.codexPetOverlayKWinProximity()") &&
          /null==this\.stopPetControlsProximity&&\([^;]*?this\.stopPetControlsProximity=function\(/.test(method.text) &&
          /\(\)=>\{this\.updatePetPointerProximity\(\)\},this\.isNotchEnabled\?100:[\w$]+\)/.test(method.text);
    }),
    source.includes("codexPetOverlaySettings(){"),
    findAvatarOverlayMethod(source, /(?<![\w$.])getLayoutForDisplay\([^{}]*\)\{/)?.text.includes(NATIVE_DRAW_CONSTRAINT),
    findAvatarOverlayMethod(source, /(?<![\w$.])getLayoutForDisplay\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayKWinLayout("),
    findAvatarOverlayMethod(source, /(?<![\w$.])getLayoutForDisplay\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayKWinLayoutOptions("),
    findAvatarOverlayMethod(source, /(?<![\w$.])setWindowBounds\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayIsNativeKWin()"),
    findAvatarOverlayMethod(source, /(?<![\w$.])focusQuickChat\([^{}]*\)\{/)?.text.includes("codexPetOverlayHiddenFocus:"),
    findAvatarOverlayMethod(source, /(?<![\w$.])setKeyboardInteraction\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayActivateKWin("),
    findAvatarOverlayMethod(source, /(?<![\w$.])setKeyboardInteraction\([^{}]*\)\{/)?.text.includes(".isVisible()&&!this.codexPetOverlayIsNativeKWin()"),
    show?.text.includes("this.codexPetOverlayPresentKWinWindow("),
    show?.text.includes('null!=this.nativeAppearanceBridge||this.codexPetOverlayIsNativeKWin()||('),
    /let [A-Za-z_$][\w$]*=this\.codexPetOverlayLayoutForDisplay\([A-Za-z_$][\w$]*,this\.getLayoutForDisplay\([A-Za-z_$][\w$]*\),[A-Za-z_$][\w$]*\);/.test(source),
    /process\.platform===`linux`\?this\.codexPetOverlaySyncWindow\([A-Za-z_$][\w$]*,!0\):[A-Za-z_$][\w$]*\.moveTop\(\),[A-Za-z_$][\w$]*\.showInactive\(\),/.test(source),
    source.includes("if(this.codexPetOverlayShouldLockPosition())return;"),
    source.includes("codexPetOverlayKWinQdbus("),
    source.includes("this.codexPetOverlayBeginCompositorDrag("),
    findAvatarOverlayMethod(source, /(?<![\w$.])unregisterNativeWindowDragTarget\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayEndKWinDrag(this.window);"),
    source.includes("this.codexPetOverlayMoveCompositorDrag("),
    source.includes("this.codexPetOverlayEndKWinDrag("),
    source.includes("this.codexPetOverlayEndNiriDrag("),
    findAvatarOverlayMethod(source, /(?<![\w$.])endDrag\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayKWinFinish("),
    findAvatarOverlayMethod(source, /(?<![\w$.])handleNativeWindowDragMove\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayKWinGeometry("),
    findAvatarOverlayMethod(source, /(?<![\w$.])rememberMovedWindow\([^{}]*\)\{/)?.text.includes("this.codexPetOverlayKWinRefresh("),
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
  if (!source.includes(AVATAR_OVERLAY_APPEARANCE)) {
    console.warn("WARN: Avatar overlay markers not found - skipping pet overlay patch");
    return source;
  }
  const settings = mergedPetOverlaySettings(context);
  const localMascotDragExpected = /moveDrag\([^)]*\)\{/.test(source);
  let patched = patchAvatarTransparentBackground(source);
  patched = patchCreateWindowTitle(patched);
  patched = patchCreateWindowFrame(patched);
  patched = patchNativeDrawBounds(patched);
  patched = patchHiddenQuickChatFocus(patched);
  patched = patchKWinKeyboardFocus(patched);
  patched = patchKWinGestureService(patched);
  patched = patchApplyLayout(patched);
  patched = patchShowWindow(patched);
  patched = patchLockedDrag(patched);
  patched = patchCompositorDragLifecycle(patched);
  patched = patchKWinGeometry(patched);
  patched = patchKWinCoordinateConsumers(patched);
  patched = patchKWinProximityPublication(patched);
  patched = patchKWinDragCleanup(patched);
  patched = patchKWinWindowSize(patched);
  patched = ensurePetOverlayMethods(patched, settings);
  patched = patchLocalMascotDrag(patched);
  if (localMascotDragExpected) {
    patched = patchLocalMascotDragLifecycle(patched);
  }
  if (!hasCompletePetOverlayPatch(patched, localMascotDragExpected)) {
    console.warn("WARN: Pet overlay patch is incomplete - discarding all pet overlay changes");
    return source;
  }
  return patched;
}

function codexPetOverlayScheduleQuickChatFocus(complete, hidden) {
  // A hidden Wayland window cannot paint until the native focus handshake completes.
  const schedule = hidden ? callback => window.setTimeout(callback, 0) : callback => window.requestAnimationFrame(callback);
  const cancel = hidden ? id => window.clearTimeout(id) : id => window.cancelAnimationFrame(id);
  let handle = schedule(() => { handle = schedule(complete); });
  return () => cancel(handle);
}

async function codexPetOverlayConfirmRendererDrag(gesture, api, altKey, sample) {
  try {
    const moved = await api.codexPetOverlayCompleteDrag(gesture.codexPetOverlayGestureId, altKey, sample);
    if (typeof moved !== "boolean") throw Error("Invalid Mini gesture acknowledgement");
    gesture.hasMoved ||= moved;
  } catch (error) {
    // An unconfirmed compositor gesture must not open a conversation as a click.
    gesture.hasMoved = true;
    console.warn("Could not confirm Mini gesture", error);
  }
}

function applyPetOverlayGestureRendererPatch(source) {
  if (source.includes("function codexPetOverlayConfirmRendererDrag(")) return source;
  const ident = "[A-Za-z_$][\\w$]*";
  const one = (pattern, label, text = source) => {
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) throw Error(`Pet overlay ${label} was not found uniquely`);
    return matches[0];
  };
  const prefix = new RegExp(`(?<fn>${ident})=\\((?<event>${ident}),(?<released>${ident})\\)=>\\{let (?<gesture>${ident})=(?<ref>${ident})\\.current;`, "gu");
  const finals = [...source.matchAll(prefix)].map(match => {
    const open = source.indexOf("{", match.index), end = findMatchingBrace(source, open);
    return { match, body: source.slice(match.index, end + 1) };
  }).filter(entry => entry.body.includes("`avatar-overlay-drag-end`") && entry.body.includes("beganOnQuickChatBar"));
  if (finals.length !== 1) throw Error("Pet overlay gesture finalizer was not found uniquely");
  const { match, body } = finals[0], { event, released, gesture, ref } = match.groups;
  const service = one(new RegExp(`(?<api>${ident})\\.avatarOverlay\\?\\.setQuickChatStashed\\(null\\)`, "gu"), "gesture service").groups.api;
  const layout = one(new RegExp(`let\\{isGlobalRealtimeVoicePresentation:${ident},isVisible:${ident},layout:${ident},[^{};]+\\}=(?<message>${ident});`, "gu"), "gesture layout");
  const start = one(new RegExp(`${ref.replace(/[$]/g, "\\$")}\\.current=\\{beganOnQuickChatBar:`, "gu"), "gesture start");
  const dispatch = one(new RegExp(`(?<dispatcher>${ident})\\.dispatchMessage\\(\`avatar-overlay-drag-start\`,\\{`, "gu"), "gesture dispatch");
  const finish = one(new RegExp(`let\\{hasMoved:(?<moved>${ident}),releaseSample:(?<sample>${ident}),velocity:${ident}\\}=[^;]+;`, "gu"), "gesture result", body);
  let finalizer = body.replace(match[0], match[0].replace("=(", "=async("));
  const pointer = `{pointerScreenX:codexPetOverlayReleaseSample.screenX,pointerScreenY:codexPetOverlayReleaseSample.screenY,shouldMove:${finish.groups.moved}&&!${gesture}.hasMoved&&${finish.groups.sample}!=null,...(${released}?{pointerWindowX:${event}.clientX,pointerWindowY:${event}.clientY}:{})}`;
  finalizer = finalizer.replace(finish[0],
    `${finish[0]}if(${gesture}.codexPetOverlayGestureId!=null){const codexPetOverlayReleaseSample=${finish.groups.sample}??${gesture}.samples.at(-1)??${gesture};await codexPetOverlayConfirmRendererDrag(${gesture},${service}.avatarOverlay,${released}&&!${gesture}.usesOrbPhysics&&${event}.altKey===!0,${pointer});${finish.groups.moved}||=${gesture}.hasMoved;}`);
  for (const kind of ["move", "end", "release"]) {
    const call = one(new RegExp(`${dispatch.groups.dispatcher.replace(/[$]/g, "\\$")}\\.dispatchMessage\\(\`avatar-overlay-drag-${kind}\`,`, "gu"), `gesture ${kind}`, body)[0];
    finalizer = finalizer.replace(call, `${gesture}.codexPetOverlayGestureId==null&&${call}`);
  }
  let patched = source.replace(body, finalizer)
    .replace(layout[0], `${layout[0]}codexPetOverlayNativeDrag=${layout.groups.message}.layout?.codexPetOverlayNativeDrag===!0;`)
    .replace(start[0], `${ref}.current={codexPetOverlayGestureId:codexPetOverlayNativeDrag?crypto.randomUUID():null,beganOnQuickChatBar:`)
    .replace(dispatch[0], `${dispatch[0]}codexPetOverlayGestureId:${ref}.current.codexPetOverlayGestureId,`);
  return `let codexPetOverlayNativeDrag=false;\n${codexPetOverlayConfirmRendererDrag}\n${patched}`;
}

function applyPetOverlayRendererPatch(source) {
  if (source.includes("function codexPetOverlayScheduleQuickChatFocus(")) {
    return source;
  }
  const ident = "[A-Za-z_$][\\w$]*";
  const containingBlock = index => {
    for (let start = source.lastIndexOf("{", index); start >= 0; start = source.lastIndexOf("{", start - 1)) {
      const end = findMatchingBrace(source, start);
      if (end >= index) return { start, end, body: source.slice(start, end + 1) };
      if (start === 0) break;
    }
    throw new Error("Pet overlay Quick Chat action scope was not found");
  };
  const actions = [...source.matchAll(new RegExp(`let (?<id>${ident})=(?<action>${ident})\\.requestId;`, "gu"))]
    .map(match => ({ ...containingBlock(match.index), ...match.groups }))
    .filter(block => block.body.includes(`{requestId:${block.id},layoutRevision:null}`));
  if (actions.length !== 1) throw new Error("Pet overlay Quick Chat focus action was not found uniquely");
  const action = actions[0], needle = `{requestId:${action.id},layoutRevision:null}`;
  if (action.body.split(needle).length !== 2) throw new Error("Pet overlay Quick Chat preparation was not found uniquely");
  let patched = source.slice(0, action.start) + action.body.replace(needle,
    `{requestId:${action.id},layoutRevision:null,codexPetOverlayHiddenFocus:${action.action}.codexPetOverlayHiddenFocus===!0}`) + source.slice(action.end + 1);
  const pattern = new RegExp(
    `let\\{requestId:(?<request>${ident}),layoutRevision:(?<revision>${ident})\\}=(?<preparation>${ident}),(?<timer>${ident})=window\\.requestAnimationFrame\\(\\(\\)=>\\{\\k<timer>=window\\.requestAnimationFrame\\(\\(\\)=>\\{(?<complete>[\\s\\S]{0,500}?\\.completeQuickChatFocus\\([\\s\\S]{0,500}?\\.catch\\(${ident}\\))\\}\\)\\}\\);return\\(\\)=>\\{window\\.cancelAnimationFrame\\(\\k<timer>\\)\\}`,
    "gu",
  );
  if ([...patched.matchAll(pattern)].length !== 1) {
    throw new Error("Pet overlay Quick Chat focus schedule was not found uniquely");
  }
  patched = patched.replace(pattern, (...args) => {
    const { request, revision, preparation, timer, complete } = args.at(-1);
    return `let{requestId:${request},layoutRevision:${revision}}=${preparation},${timer}=codexPetOverlayScheduleQuickChatFocus(()=>{${complete}},${preparation}.codexPetOverlayHiddenFocus===!0);return ${timer}`;
  });
  return `${codexPetOverlayScheduleQuickChatFocus}\n${patched}`;
}

const descriptors = [
  {
    id: "pet-overlay-kwin-gesture",
    phase: "webview-asset",
    order: 20_830,
    ciPolicy: "optional",
    pattern: /^avatar-overlay-native-page-[^.]+\.js$/,
    apply: applyPetOverlayGestureRendererPatch,
  },
  {
    id: DESCRIPTOR_ID,
    phase: "main-bundle",
    order: 20_500,
    ciPolicy: "optional",
    apply: applyPetOverlayPatch,
  },
  {
    id: "pet-overlay-hidden-focus",
    phase: "webview-asset",
    order: 20_820,
    ciPolicy: "optional",
    pattern: /^avatar-overlay-native-page-[^.]+\.js$/,
    apply: applyPetOverlayRendererPatch,
  },
];

module.exports = {
  DESCRIPTOR_ID,
  descriptors,
  applyPetOverlayPatch,
  applyPetOverlayRendererPatch,
  applyPetOverlayGestureRendererPatch,
  mergedPetOverlaySettings,
};
