import vm from "node:vm";
import readline from "node:readline";

const MAX_LOG_LINES = 200;
const MAX_VALUE_CHARS = 32768;
// Logs share the value's budget: one line is cut at MAX_VALUE_CHARS and all logs together stop at
// four times that, so a logged tree cannot flood the result the way an uncapped line could.
const MAX_LOG_LINE_CHARS = MAX_VALUE_CHARS;
const MAX_LOG_TOTAL_CHARS = 4 * MAX_VALUE_CHARS;

const pendingRpc = new Map();
let nextRpcId = 1;
let currentEvalId = 0;
let evalActive = false;
let currentLogs = [];
let pendingUnhandledLogs = [];
let currentAttachedImages = [];
let currentCallCount = 0;
let lastSnapshotId = null;
let lastTreeNodes = [];
let lastTreeWindowId = null;
let lastTreeSpilled = false;
let lastTreeSnapshotId = null;
const activeTimeouts = new Set();
const activeIntervals = new Set();

// Cut text to at most n UTF-16 units without leaving half of a surrogate pair, which
// JSON.stringify would emit as a lone \ud83d escape that serde_json refuses.
function cut(text, n) {
  const s = String(text);
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

// A lone surrogate half (from a script's own slice() of emoji text) would be written as a
// \ud83d escape that serde_json refuses, which resets the worker. Replace it with U+FFFD.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function wellFormed(value) {
  if (typeof value !== "string") return value;
  return typeof value.toWellFormed === "function" ? value.toWellFormed() : value.replace(LONE_SURROGATE, "\uFFFD");
}

// Property names need it too: the replacer sees values only, so an object is rebuilt with
// well-formed keys before JSON.stringify walks into it.
function wellFormedReplacer(_, value) {
  if (typeof value === "string") return wellFormed(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    let changed = false;
    const keys = Object.keys(value);
    for (const key of keys) {
      if (wellFormed(key) !== key) {
        changed = true;
        break;
      }
    }
    if (!changed) return value;
    const out = {};
    for (const key of keys) out[wellFormed(key)] = value[key];
    return out;
  }
  return value;
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg, wellFormedReplacer) + "\n");
}

function formatLogArg(arg) {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

let currentLogChars = 0;
let currentLogsDropped = false;

function appendLogLine(line) {
  if (currentLogsDropped) return;
  if (currentLogs.length >= MAX_LOG_LINES || currentLogChars >= MAX_LOG_TOTAL_CHARS) {
    currentLogs.push("[logs truncated]");
    currentLogsDropped = true;
    return;
  }
  let text = line;
  if (text.length > MAX_LOG_LINE_CHARS) {
    text = `${cut(text, MAX_LOG_LINE_CHARS)} [line truncated from ${line.length} chars]`;
  }
  const room = MAX_LOG_TOTAL_CHARS - currentLogChars;
  if (text.length > room) {
    text = `${cut(text, room)} [logs truncated]`;
    currentLogsDropped = true;
  }
  currentLogChars += text.length;
  currentLogs.push(text);
}

function pushLog(level, args) {
  const prefix = level === "log" ? "" : `[${level}] `;
  appendLogLine(prefix + args.map(formatLogArg).join(" "));
}

function recordUnhandled(kind, err) {
  const line = `[${kind}] ${formatLogArg(err)}`;
  if (evalActive) {
    appendLogLine(line);
  } else if (pendingUnhandledLogs.length < 50) {
    pendingUnhandledLogs.push(cut(line, MAX_LOG_LINE_CHARS));
  }
}

process.on("unhandledRejection", (reason) => {
  recordUnhandled("unhandledRejection", reason);
});

process.on("uncaughtException", (err) => {
  recordUnhandled("uncaughtException", err);
});

function clearEvalTimers() {
  for (const timer of activeTimeouts) {
    globalThis.clearTimeout(timer);
  }
  activeTimeouts.clear();
  for (const timer of activeIntervals) {
    globalThis.clearInterval(timer);
  }
  activeIntervals.clear();
}

function trackedSetTimeout(fn, delay, ...args) {
  const originEvalId = currentEvalId;
  if (!evalActive || originEvalId === 0) {
    throw new Error("setTimeout is only allowed while a js evaluation is active");
  }
  const handle = globalThis.setTimeout(() => {
    activeTimeouts.delete(handle);
    if (!evalActive || currentEvalId !== originEvalId) return;
    if (typeof fn === "function") fn(...args);
  }, delay);
  activeTimeouts.add(handle);
  return handle;
}

function trackedClearTimeout(handle) {
  activeTimeouts.delete(handle);
  globalThis.clearTimeout(handle);
}

function trackedSetInterval(fn, delay, ...args) {
  const originEvalId = currentEvalId;
  if (!evalActive || originEvalId === 0) {
    throw new Error("setInterval is only allowed while a js evaluation is active");
  }
  const handle = globalThis.setInterval(() => {
    if (!evalActive || currentEvalId !== originEvalId) {
      activeIntervals.delete(handle);
      globalThis.clearInterval(handle);
      return;
    }
    if (typeof fn === "function") fn(...args);
  }, delay);
  activeIntervals.add(handle);
  return handle;
}

function trackedClearInterval(handle) {
  activeIntervals.delete(handle);
  globalThis.clearInterval(handle);
}

function rpcCall(tool, args = {}, options = {}) {
  const originEvalId = currentEvalId;
  if (!evalActive || originEvalId === 0) {
    return Promise.reject(new Error("desktop calls are only allowed while a js evaluation is active"));
  }
  currentCallCount += 1;
  const id = nextRpcId++;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, {
      evalId: originEvalId,
      resolve,
      reject,
      attach: options.attach !== false,
    });
    writeMessage({ type: "rpc", id, eval_id: originEvalId, tool, args });
  });
}

function rejectPendingRpcsForEval(evalId, reason) {
  for (const [id, entry] of pendingRpc.entries()) {
    if (entry.evalId === evalId) {
      pendingRpc.delete(id);
      entry.reject(new Error(reason));
    }
  }
}

function sleep(ms) {
  const clamped = Math.max(0, Math.min(30000, Number(ms) || 0));
  const originEvalId = currentEvalId;
  if (!evalActive || originEvalId === 0) {
    return Promise.reject(new Error("sleep is only allowed while a js evaluation is active"));
  }
  return new Promise((resolve) => {
    const handle = globalThis.setTimeout(() => {
      activeTimeouts.delete(handle);
      resolve();
    }, clamped);
    activeTimeouts.add(handle);
  });
}

function normalizeHotkey(keyOrChord) {
  if (Array.isArray(keyOrChord)) {
    return keyOrChord.map((part) => String(part).trim()).filter(Boolean).join("+");
  }
  return String(keyOrChord);
}

function maybeAttachSnapshotId(args) {
  if (!args || typeof args !== "object") return args;
  let normalized = args;
  const rawNode = normalized._node && typeof normalized._node === "object" ? normalized._node : normalized;
  if (
    typeof rawNode.index === "number" &&
    normalized.element_index === undefined &&
    (typeof rawNode.object_ref === "string" || typeof rawNode.role === "string")
  ) {
    normalized = { element_index: rawNode.index };
    for (const key of [
      "window_id",
      "button",
      "click_count",
      "screenshot_after",
      "include_tree",
      "format",
      "quality",
      "scale",
      "max_width",
      "max_height",
      "max_bytes",
      "screenshot_file_path",
      "snapshot_id",
    ]) {
      if (args[key] !== undefined) normalized[key] = args[key];
    }
    if (normalized.snapshot_id === undefined && typeof args._snapshotId === "string") {
      normalized.snapshot_id = args._snapshotId;
    }
  }
  const hasElementTarget =
    normalized.element_index !== undefined ||
    normalized.element_identifier !== undefined ||
    normalized.role !== undefined ||
    normalized.name !== undefined ||
    normalized.text !== undefined ||
    (Array.isArray(normalized.states) && normalized.states.length > 0);
  if (hasElementTarget && normalized.snapshot_id === undefined && lastSnapshotId) {
    return { ...normalized, snapshot_id: lastSnapshotId };
  }
  return normalized;
}

function normalizeText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (typeof value.content === "string") return value.content;
    if (typeof value.text === "string") return value.text;
    if (typeof value.value === "string") return value.value;
    return "";
  }
  return String(value);
}

// A state holds only part of the tree when the server marked it partial (also when the spill
// file could not be written) or its spill marker is still set. A search over it could report an
// element missing or a name unique when it is not.
function isPartialTree(result) {
  return Boolean(result && (result.accessibility_tree_partial === true || result.accessibility_tree_spill));
}

function assertCompleteTree(source, what) {
  if (source && typeof source === "object" && !Array.isArray(source) && isPartialTree(source)) {
    throw new Error(
      `${what} needs the whole accessibility tree, but this state holds only the part that fit inline (accessibility_tree_partial or accessibility_tree_spill is set). Call getAppState() again with the default hydrateSpill, or page the rest with desktop.getTreePage().`
    );
  }
}

function extractNodes(source) {
  if (Array.isArray(source)) return source;
  if (source && typeof source === "object") {
    if (Array.isArray(source.accessibility_tree)) return source.accessibility_tree;
    if (Array.isArray(source.nodes)) return source.nodes;
  }
  return [];
}

function matchesNode(node, matcher) {
  if (!node || typeof node !== "object") return false;
  if (typeof matcher === "function") return Boolean(matcher(node));
  if (typeof matcher === "string") {
    const q = matcher.toLowerCase();
    const hay = `${node.name || ""} ${normalizeText(node.text)} ${node.description || ""}`.toLowerCase();
    return hay.includes(q);
  }
  if (!matcher || typeof matcher !== "object") return false;

  if (matcher.role !== undefined) {
    const role = String(node.role || "").toLowerCase();
    if (!role.includes(String(matcher.role).toLowerCase())) return false;
  }
  if (matcher.exactRole !== undefined) {
    if (String(node.role || "").toLowerCase() !== String(matcher.exactRole).toLowerCase()) {
      return false;
    }
  }
  if (matcher.name !== undefined) {
    const name = String(node.name || "").toLowerCase();
    if (!name.includes(String(matcher.name).toLowerCase())) return false;
  }
  if (matcher.exactName !== undefined) {
    if (String(node.name || "") !== String(matcher.exactName)) return false;
  }
  if (matcher.text !== undefined) {
    const q = String(matcher.text).toLowerCase();
    const hay = `${node.name || ""} ${normalizeText(node.text)} ${node.description || ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (matcher.action !== undefined) {
    const actions = Array.isArray(node.actions) ? node.actions.map((a) => String(a).toLowerCase()) : [];
    if (!actions.includes(String(matcher.action).toLowerCase())) return false;
  }
  const reqStates = [];
  if (matcher.state !== undefined) reqStates.push(String(matcher.state).toLowerCase());
  if (Array.isArray(matcher.states)) {
    for (const st of matcher.states) reqStates.push(String(st).toLowerCase());
  }
  if (reqStates.length > 0) {
    const nodeStates = Array.isArray(node.states) ? node.states.map((s) => String(s).toLowerCase()) : [];
    for (const req of reqStates) {
      if (!nodeStates.includes(req)) return false;
    }
  }
  return true;
}

function matchesWindow(win, query) {
  if (!win || typeof win !== "object") return false;
  if (typeof query === "number") return win.window_id === query;
  if (typeof query === "function") return Boolean(query(win));
  if (typeof query === "string") {
    const q = query.toLowerCase();
    return (
      String(win.title || "").toLowerCase().includes(q) ||
      String(win.app_id || "").toLowerCase().includes(q) ||
      String(win.wm_class || "").toLowerCase().includes(q)
    );
  }
  if (query && typeof query === "object") {
    if (query.window_id !== undefined && win.window_id !== query.window_id) return false;
    if (query.pid !== undefined && win.pid !== query.pid) return false;
    if (query.title !== undefined && !String(win.title || "").toLowerCase().includes(String(query.title).toLowerCase())) {
      return false;
    }
    if (query.app_id !== undefined && !String(win.app_id || "").toLowerCase().includes(String(query.app_id).toLowerCase())) {
      return false;
    }
    if (query.wm_class !== undefined && String(win.wm_class || "").toLowerCase() !== String(query.wm_class).toLowerCase()) {
      return false;
    }
    return true;
  }
  return false;
}

function normalizeClickArgs(targetOrX, yOrOpts, maybeOpts, baseOpts = {}) {
  const shared = { ...baseOpts };
  if (typeof targetOrX === "number" && typeof yOrOpts === "number") {
    return { ...shared, ...(maybeOpts || {}), x: targetOrX, y: yOrOpts };
  }
  if (typeof targetOrX === "string") {
    const opts = typeof yOrOpts === "object" && yOrOpts !== null ? yOrOpts : {};
    const targetWindowId = opts.window_id ?? shared.window_id;
    // Only resolve against the cached AT-SPI tree when it is complete and belongs to the requested window.
    const cacheMatchesWindow =
      targetWindowId === undefined || (lastTreeWindowId !== null && lastTreeWindowId === targetWindowId);
    // The cached nodes must come from the snapshot the click will name, or their indices point
    // into a different tree.
    const requestedSnapshot = opts.snapshot_id ?? shared.snapshot_id ?? lastSnapshotId;
    const cacheMatchesSnapshot =
      lastTreeSnapshotId !== null && requestedSnapshot === lastTreeSnapshotId;
    if (!lastTreeSpilled && cacheMatchesWindow && cacheMatchesSnapshot && lastTreeNodes.length > 0) {
      const roleFilter = opts.role || shared.role;
      const matches = lastTreeNodes.filter(
        (n) =>
          typeof n?.index === "number" &&
          n.name === targetOrX &&
          (!roleFilter || String(n.role || "").toLowerCase().includes(String(roleFilter).toLowerCase()))
      );
      if (matches.length === 1) {
        const merged = { ...shared, ...opts };
        delete merged.role;
        delete merged.name;
        return { ...merged, element_index: matches[0].index, snapshot_id: lastTreeSnapshotId };
      }
      if (matches.length > 1) {
        const preview = matches
          .slice(0, 5)
          .map((m) => `[${m.index}] ${m.role} ${JSON.stringify(m.name)}`)
          .join(", ");
        throw new Error(
          `Ambiguous exact-name click target ${JSON.stringify(targetOrX)}: matched ${matches.length} elements (${preview}). Disambiguate with element_index, role, or states.`
        );
      }
    }
    return { ...shared, ...opts, name: targetOrX };
  }
  if (typeof targetOrX === "object" && targetOrX !== null) {
    const extra = typeof yOrOpts === "object" && yOrOpts !== null ? yOrOpts : {};
    const rawNode = targetOrX._node && typeof targetOrX._node === "object" ? targetOrX._node : targetOrX;
    if (
      typeof rawNode.index === "number" &&
      targetOrX.element_index === undefined &&
      (typeof rawNode.object_ref === "string" || typeof rawNode.role === "string")
    ) {
      const merged = { ...shared, ...extra, element_index: rawNode.index };
      if (merged.snapshot_id === undefined && typeof targetOrX._snapshotId === "string") {
        merged.snapshot_id = targetOrX._snapshotId;
      }
      return merged;
    }
    return { ...shared, ...targetOrX, ...extra };
  }
  return shared;
}

function createElementHandle(api, node, windowId, snapshotId) {
  if (!node || typeof node !== "object") return null;
  const handle = {
    ...node,
    _node: node,
    _windowId: windowId ?? null,
    _snapshotId: snapshotId ?? lastSnapshotId,

    async click(opts = {}) {
      const params = {
        ...(windowId != null ? { window_id: windowId } : {}),
        ...(handle._snapshotId ? { snapshot_id: handle._snapshotId } : {}),
        ...opts,
        element_index: node.index,
      };
      return api.click(params);
    },

    async doubleClick(opts = {}) {
      return handle.click({ ...opts, click_count: 2 });
    },

    async rightClick(opts = {}) {
      return handle.click({ ...opts, button: "right" });
    },

    async performAction(action, opts = {}) {
      return api.performAction({
        ...(windowId != null ? { window_id: windowId } : {}),
        ...(handle._snapshotId ? { snapshot_id: handle._snapshotId } : {}),
        ...opts,
        element_index: node.index,
        ...(action ? { action } : {}),
      });
    },

    async setValue(value, opts = {}) {
      return api.setValue({
        ...(windowId != null ? { window_id: windowId } : {}),
        ...(handle._snapshotId ? { snapshot_id: handle._snapshotId } : {}),
        ...opts,
        element_index: node.index,
        value: String(value),
      });
    },

    async type(text, opts = {}) {
      return api.typeText({
        ...(windowId != null ? { window_id: windowId } : {}),
        ...(handle._snapshotId ? { snapshot_id: handle._snapshotId } : {}),
        ...opts,
        element_index: node.index,
        text: String(text),
      });
    },

    async press(key, opts = {}) {
      return api.pressKey({
        ...(windowId != null ? { window_id: windowId } : {}),
        ...(handle._snapshotId ? { snapshot_id: handle._snapshotId } : {}),
        ...opts,
        element_index: node.index,
        key: normalizeHotkey(key),
      });
    },

    toJSON() {
      return node;
    },
  };
  return handle;
}

// On a window handle, x/y in a target are window-relative like win.click(x, y).
function listingError(tool, res) {
  const hint = res?.permissions_hint ? ` (${res.permissions_hint})` : "";
  return new Error(`${tool} failed: ${res.error}${hint}. Check desktop.doctor(); desktop.setupWindowTargeting() may be needed.`);
}

function windowRelativeTarget(target) {
  if (
    target &&
    typeof target === "object" &&
    (target.x !== undefined || target.y !== undefined) &&
    target.relative === undefined &&
    target.coordinate_space === undefined
  ) {
    return { ...target, relative: true };
  }
  return target;
}

// The server takes integer pixels; x / shot.scale is usually fractional.
function roundCoordinates(params) {
  for (const key of ["x", "y", "start_x", "start_y", "end_x", "end_y"]) {
    if (typeof params[key] === "number" && Number.isFinite(params[key])) {
      params[key] = Math.round(params[key]);
    }
  }
  return params;
}

function createWindowHandle(api, win) {
  if (!win || typeof win !== "object") return null;
  const wid = win.window_id;
  let lastWinState = null;

  async function ensureWindowTreeCurrent() {
    if (lastTreeWindowId !== wid || !lastWinState) {
      await handle.state();
    }
  }

  const handle = {
    ...win,
    id: wid,
    window_id: wid,

    async focus(opts = {}) {
      return api.activateWindow({ ...opts, window_id: wid });
    },

    async activate(opts = {}) {
      return handle.focus(opts);
    },

    async move(x, y, opts = {}) {
      return api.moveWindow({ ...opts, window_id: wid, x, y });
    },

    async resize(width, height, opts = {}) {
      return api.resizeWindow({ ...opts, window_id: wid, width, height });
    },

    async state(opts = {}) {
      lastWinState = await api.getAppState({ ...opts, window_id: wid });
      return lastWinState;
    },

    async tree(opts = {}) {
      const st = await handle.state(opts);
      return extractNodes(st);
    },

    async summary(opts = {}) {
      const st = await handle.state(opts);
      return api.summary(st, opts);
    },

    async find(matcher, opts = {}) {
      const st =
        opts.refresh === false && lastWinState && lastTreeWindowId === wid
          ? lastWinState
          : await handle.state(opts);
      const node = api.find(st, matcher);
      return node ? createElementHandle(api, node, wid, st.snapshot_id ?? lastSnapshotId) : null;
    },

    async findAll(matcher, opts = {}) {
      const st =
        opts.refresh === false && lastWinState && lastTreeWindowId === wid
          ? lastWinState
          : await handle.state(opts);
      const snap = st.snapshot_id ?? lastSnapshotId;
      return api.findAll(st, matcher).map((node) => createElementHandle(api, node, wid, snap));
    },

    async waitFor(matcher, opts = {}) {
      const res = await api.waitFor({ ...opts, window_id: wid, matcher });
      if (res.ok && res.node) {
        lastWinState = res.state || lastWinState;
        return createElementHandle(api, res.node, wid, res.snapshot_id ?? lastSnapshotId);
      }
      throw new Error(res.error || "waitFor timed out");
    },

    async click(targetOrX, yOrOpts, maybeOpts) {
      if (typeof targetOrX === "string") {
        await ensureWindowTreeCurrent();
      }
      const params = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts, { window_id: wid });
      if (
        (params.x !== undefined || params.y !== undefined) &&
        params.relative === undefined &&
        params.coordinate_space === undefined
      ) {
        params.relative = true;
      }
      return api.click(params);
    },

    async doubleClick(targetOrX, yOrOpts, maybeOpts) {
      if (typeof targetOrX === "string") {
        await ensureWindowTreeCurrent();
      }
      const params = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts, { window_id: wid });
      if (
        (params.x !== undefined || params.y !== undefined) &&
        params.relative === undefined &&
        params.coordinate_space === undefined
      ) {
        params.relative = true;
      }
      return api.click({ ...params, click_count: 2 });
    },

    async rightClick(targetOrX, yOrOpts, maybeOpts) {
      if (typeof targetOrX === "string") {
        await ensureWindowTreeCurrent();
      }
      const params = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts, { window_id: wid });
      if (
        (params.x !== undefined || params.y !== undefined) &&
        params.relative === undefined &&
        params.coordinate_space === undefined
      ) {
        params.relative = true;
      }
      return api.click({ ...params, button: "right" });
    },

    async clickAll(targets, opts = {}) {
      if (Array.isArray(targets) && targets.some((t) => typeof t === "string")) {
        await ensureWindowTreeCurrent();
      }
      const mapped = Array.isArray(targets) ? targets.map(windowRelativeTarget) : targets;
      return api.clickAll(mapped, { ...opts, window_id: wid });
    },

    async fillForm(fields, opts = {}) {
      const mapped = Array.isArray(fields) ? fields.map(windowRelativeTarget) : fields;
      return api.fillForm(mapped, { ...opts, window_id: wid });
    },

    async type(text, opts = {}) {
      return api.typeText(text, { ...opts, window_id: wid });
    },

    async key(keyOrChord, opts = {}) {
      return api.pressKey(normalizeHotkey(keyOrChord), { ...opts, window_id: wid });
    },

    async press(keyOrChord, opts = {}) {
      return handle.key(keyOrChord, opts);
    },

    async hotkey(keys, opts = {}) {
      return handle.key(keys, opts);
    },

    async scroll(optsOrDirection = {}, pagesOrOpts) {
      let params;
      if (typeof optsOrDirection === "string") {
        const extra = typeof pagesOrOpts === "number" ? { pages: pagesOrOpts } : (pagesOrOpts || {});
        params = { ...extra, window_id: wid, direction: optsOrDirection };
      } else {
        params = { ...optsOrDirection, window_id: wid };
      }
      if ((params.x !== undefined || params.y !== undefined) && params.relative === undefined) {
        params.relative = true;
      }
      return api.scroll(params);
    },

    async drag(fromX, fromY, toX, toY, opts = {}) {
      if (typeof fromX === "object" && fromX !== null) {
        return api.drag({ ...fromX, window_id: wid });
      }
      return api.drag({ ...opts, window_id: wid, start_x: fromX, start_y: fromY, end_x: toX, end_y: toY });
    },

    async screenshot(opts = {}) {
      return api.screenshot({ ...opts, window_id: wid });
    },

    toJSON() {
      return win;
    },
  };
  return handle;
}

function viewImage(capture) {
  if (capture && typeof capture === "object" && Array.isArray(capture._imageIndices)) {
    for (const idx of capture._imageIndices) {
      if (!currentAttachedImages.includes(idx)) {
        currentAttachedImages.push(idx);
      }
    }
    return true;
  }
  return false;
}

function buildDesktopApi() {
  const api = {
    async call(tool, args = {}, options = {}) {
      const result = await rpcCall(tool, args, options);
      if (result && typeof result === "object") {
        if (typeof result.snapshot_id === "string" && result.snapshot_id) {
          lastSnapshotId = result.snapshot_id;
        }
        if (Array.isArray(result.accessibility_tree)) {
          lastTreeNodes = result.accessibility_tree;
          lastTreeWindowId = result.window_context?.window_id ?? args?.window_id ?? null;
          lastTreeSpilled = isPartialTree(result);
          lastTreeSnapshotId = typeof result.snapshot_id === "string" ? result.snapshot_id : null;
        }
      }
      return result;
    },

    sleep,
    wait: sleep,
    viewImage,

    get snapshotId() {
      return lastSnapshotId;
    },

    clearImages() {
      currentAttachedImages = [];
    },

    help() {
      return [
        "Desktop JS REPL API (`desktop` / alias `cua`, persistent bindings, top-level await, sleep(ms), viewImage(shot)):",
        "- Inventory & setup: await desktop.getState() | desktop.windows() | desktop.focused() | desktop.apps() | desktop.doctor() | desktop.setupAccessibility() | desktop.setupWindowTargeting()",
        "- Handles: const win = await desktop.window(titleOrApp) (alias desktop.app)",
        "- WindowHandle: win.focus(), win.move(x,y), win.resize(w,h), win.state(), win.tree(), win.summary()",
        "- Elements: const el = await win.find(matcher) | win.findAll(matcher) | win.waitFor(matcher)",
        "- ElementHandle: el.click(), el.doubleClick(), el.rightClick(), el.setValue(v), el.type(t), el.press(k), el.performAction(a)",
        "- Input: win.click(targetOrX, y?), win.clickAll(targets, opts?), win.fillForm(fields), win.type(text), win.press(key), win.hotkey(['Ctrl','L']), win.scroll(dir, pages), win.drag(x1,y1,x2,y2)",
        "- Coordinates: win.click(x,y) & win.scroll({x,y}) default to relative=true (window pixels; divide image pixels by shot.scale when shot.scale < 1). desktop.click(x,y) & win.drag(...) use full-capture pixels (divide image pixels by shot.scale).",
        "- Visual: await win.screenshot({ format: 'jpeg', quality: 75 }), desktop.clearImages()",
      ].join("\n");
    },

    summary(nodesOrState, opts = {}) {
      assertCompleteTree(nodesOrState, "summary");
      const maxItems = Math.max(1, Math.min(500, Number(opts.maxItems ?? opts.max_items ?? 120)));
      const nodes = extractNodes(nodesOrState);
      const out = [];
      for (const node of nodes) {
        if (out.length >= maxItems) break;
        if (!node || typeof node !== "object") continue;
        const idx = node.index !== undefined ? `[${node.index}]` : "[-]";
        const role = node.role || "unknown";
        const name = node.name ? ` ${JSON.stringify(node.name)}` : "";
        const textVal = normalizeText(node.text).trim();
        const textPart = textVal && textVal !== node.name ? ` text=${JSON.stringify(textVal.slice(0, 80))}` : "";
        const actions = Array.isArray(node.actions) && node.actions.length > 0 ? ` [${node.actions.join(",")}]` : "";
        const states = Array.isArray(node.states)
          ? node.states.filter((s) => ["editable", "focused", "checked", "selected", "disabled"].includes(String(s)))
          : [];
        const statePart = states.length > 0 ? ` (${states.join(",")})` : "";
        out.push(`${idx} ${role}${name}${textPart}${actions}${statePart}`);
      }
      return out;
    },

    async doctor() {
      return api.call("doctor", {});
    },

    async setupAccessibility() {
      return api.call("setup_accessibility", {});
    },

    async setupWindowTargeting() {
      return api.call("setup_window_targeting", {});
    },

    async listWindows() {
      return api.call("list_windows", {});
    },

    async windows() {
      const res = await api.listWindows();
      const wins = Array.isArray(res?.windows) ? res.windows : [];
      // The server reports a failed listing inside a successful result; an empty list would
      // read as an empty desktop instead of missing setup.
      if (wins.length === 0 && res?.error) throw listingError("list_windows", res);
      return wins.map((w) => createWindowHandle(api, w));
    },

    async focusedWindow() {
      return api.call("focused_window", {});
    },

    async focused() {
      const res = await api.focusedWindow();
      if (!res?.focused_window && res?.error) throw listingError("focused_window", res);
      return res?.focused_window ? createWindowHandle(api, res.focused_window) : null;
    },

    async window(query) {
      const wins = await api.windows();
      const found = wins.find((w) => matchesWindow(w, query));
      if (!found) {
        throw new Error(`No matching window found for ${JSON.stringify(query)}`);
      }
      return found;
    },

    async getWindow(query) {
      return api.window(query);
    },

    async app(query) {
      return api.window(query);
    },

    async getApp(query) {
      return api.window(query);
    },

    async listApps() {
      return api.call("list_apps", {});
    },

    async apps() {
      const res = await api.listApps();
      return Array.isArray(res?.apps) ? res.apps : [];
    },

    async getState() {
      const [wins, focused, apps] = await Promise.all([
        api.listWindows(),
        api.focusedWindow(),
        api.listApps(),
      ]);
      const state = {
        focused_window: focused?.focused_window ?? null,
        windows: wins?.windows ?? [],
        apps: apps?.apps ?? [],
      };
      // Keep the diagnostics the listings carry, so missing setup is visible.
      const errors = {};
      if (wins?.error) errors.list_windows = wins.error;
      if (focused?.error) errors.focused_window = focused.error;
      if (apps?.accessibility_error) errors.list_apps = apps.accessibility_error;
      if (Object.keys(errors).length > 0) state.errors = errors;
      const hint = wins?.permissions_hint ?? focused?.permissions_hint;
      if (hint) state.permissions_hint = hint;
      return state;
    },

    async getAppState(opts = {}) {
      const params = {
        include_screenshot: false,
        interactive_only: true,
        ...opts,
      };
      if (params.include_screenshot && params.format === undefined) {
        params.format = "jpeg";
        if (params.quality === undefined) params.quality = 75;
      }
      const attach = opts.attach !== false;
      const hydrateSpill = opts.hydrateSpill !== false && opts.hydrate_spill !== false;
      const cleanParams = { ...params };
      delete cleanParams.attach;
      delete cleanParams.hydrateSpill;
      delete cleanParams.hydrate_spill;
      const result = await api.call("get_app_state", cleanParams, { attach });
      if (
        hydrateSpill &&
        result &&
        typeof result === "object" &&
        isPartialTree(result) &&
        typeof result.snapshot_id === "string" &&
        result.snapshot_id
      ) {
        const merged = Array.isArray(result.accessibility_tree) ? [...result.accessibility_tree] : [];
        const seen = new Set(merged.map((n) => n?.index).filter((idx) => typeof idx === "number"));
        let offset = merged.length;
        let complete = false;
        // Every page holds at least one node and a tree has at most 10000, so paging until
        // next_offset is null ends; the bound only guards against a broken server.
        for (let pageNum = 0; pageNum <= 10000; pageNum += 1) {
          let page;
          try {
            page = await api.getTreePage({ snapshot_id: result.snapshot_id, offset });
          } catch {
            break;
          }
          // A refused page (a later snapshot replaced this one) has no snapshot_id and no nodes.
          // It must not count as the end of the tree.
          if (page?.snapshot_id !== result.snapshot_id) break;
          const pageNodes = Array.isArray(page?.nodes) ? page.nodes : [];
          for (const node of pageNodes) {
            if (typeof node?.index === "number") {
              if (seen.has(node.index)) continue;
              seen.add(node.index);
            }
            merged.push(node);
          }
          if (page?.next_offset === null || page?.next_offset === undefined || pageNodes.length === 0) {
            const total = Number(page?.node_count);
            complete =
              (page?.next_offset === null || page?.next_offset === undefined) &&
              (!Number.isFinite(total) || merged.length >= total);
            break;
          }
          offset = page.next_offset;
        }
        result.accessibility_tree = merged;
        if (complete) {
          delete result.accessibility_tree_spill;
          result.accessibility_tree_partial = false;
        }
        // Another state() may have finished while this one paged; only the latest snapshot
        // may feed string-click resolution.
        if (lastTreeSnapshotId === result.snapshot_id) {
          lastTreeNodes = merged;
          lastTreeSpilled = !complete;
        }
      }
      return result;
    },

    async state(opts = {}) {
      return api.getAppState(opts);
    },

    async getTreePage(opts = {}) {
      const params = opts.snapshot_id === undefined && lastSnapshotId
        ? { ...opts, snapshot_id: lastSnapshotId }
        : opts;
      return api.call("get_tree_page", params);
    },

    async treePage(opts = {}) {
      return api.getTreePage(opts);
    },

    async screenshot(opts = {}) {
      const attach = opts.attach !== false;
      const params = {
        format: "jpeg",
        quality: 75,
        ...opts,
      };
      delete params.attach;
      return api.call("screenshot", params, { attach });
    },

    async activateWindow(opts = {}) {
      const attach = opts.attach !== false;
      const params = typeof opts === "string" ? { title: opts } : { ...opts };
      delete params.attach;
      return api.call("activate_window", params, { attach });
    },

    async activate(opts = {}) {
      return api.activateWindow(opts);
    },

    async moveWindow(opts = {}) {
      return api.call("move_window", opts);
    },

    async resizeWindow(opts = {}) {
      return api.call("resize_window", opts);
    },

    async click(targetOrX = {}, yOrOpts, maybeOpts) {
      const raw = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts);
      const attach = raw.attach !== false;
      const params = roundCoordinates(maybeAttachSnapshotId({ ...raw }));
      delete params.attach;
      return api.call("click", params, { attach });
    },

    async doubleClick(targetOrX = {}, yOrOpts, maybeOpts) {
      const raw = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts);
      return api.click({ ...raw, click_count: 2 });
    },

    async rightClick(targetOrX = {}, yOrOpts, maybeOpts) {
      const raw = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts);
      return api.click({ ...raw, button: "right" });
    },

    async middleClick(targetOrX = {}, yOrOpts, maybeOpts) {
      const raw = normalizeClickArgs(targetOrX, yOrOpts, maybeOpts);
      return api.click({ ...raw, button: "middle" });
    },

    async performAction(opts = {}) {
      const attach = opts.attach !== false;
      const params = maybeAttachSnapshotId({ ...opts });
      delete params.attach;
      return api.call("perform_action", params, { attach });
    },

    async setValue(opts = {}) {
      const attach = opts.attach !== false;
      const params = maybeAttachSnapshotId({ ...opts });
      delete params.attach;
      return api.call("set_value", params, { attach });
    },

    async scroll(opts = {}) {
      const attach = opts.attach !== false;
      const params = roundCoordinates({ ...opts });
      delete params.attach;
      return api.call("scroll", params, { attach });
    },

    async drag(fromX = {}, fromY, toX, toY, extraOpts = {}) {
      const raw =
        typeof fromX === "number" && typeof fromY === "number" && typeof toX === "number" && typeof toY === "number"
          ? { ...extraOpts, start_x: fromX, start_y: fromY, end_x: toX, end_y: toY }
          : { ...fromX };
      const attach = raw.attach !== false;
      delete raw.attach;
      return api.call("drag", roundCoordinates(raw), { attach });
    },

    async typeText(textOrOpts, extraOpts = {}) {
      const raw = typeof textOrOpts === "string"
        ? { ...extraOpts, text: textOrOpts }
        : { ...textOrOpts };
      const attach = raw.attach !== false;
      delete raw.attach;
      return api.call("type_text", maybeAttachSnapshotId(raw), { attach });
    },

    async type(textOrOpts, extraOpts = {}) {
      return api.typeText(textOrOpts, extraOpts);
    },

    async pressKey(keyOrOpts, extraOpts = {}) {
      const raw = typeof keyOrOpts === "string" || Array.isArray(keyOrOpts)
        ? { ...extraOpts, key: normalizeHotkey(keyOrOpts) }
        : { ...keyOrOpts, key: keyOrOpts?.key !== undefined ? normalizeHotkey(keyOrOpts.key) : undefined };
      const attach = raw.attach !== false;
      delete raw.attach;
      return api.call("press_key", maybeAttachSnapshotId(raw), { attach });
    },

    async key(keyOrOpts, extraOpts = {}) {
      return api.pressKey(keyOrOpts, extraOpts);
    },

    async press(keyOrOpts, extraOpts = {}) {
      return api.pressKey(keyOrOpts, extraOpts);
    },

    async hotkey(keys, extraOpts = {}) {
      return api.pressKey(normalizeHotkey(keys), extraOpts);
    },

    find(nodesOrState, matcher) {
      assertCompleteTree(nodesOrState, "find");
      const nodes = extractNodes(nodesOrState);
      const found = nodes.find((node) => matchesNode(node, matcher)) || null;
      if (!found) return null;
      const snap = nodesOrState?.snapshot_id ?? lastSnapshotId;
      const wid = nodesOrState?.window_context?.window_id ?? null;
      return createElementHandle(api, found, wid, snap);
    },

    findAll(nodesOrState, matcher) {
      assertCompleteTree(nodesOrState, "findAll");
      const nodes = extractNodes(nodesOrState);
      const snap = nodesOrState?.snapshot_id ?? lastSnapshotId;
      const wid = nodesOrState?.window_context?.window_id ?? null;
      return nodes
        .filter((node) => matchesNode(node, matcher))
        .map((node) => createElementHandle(api, node, wid, snap));
    },

    async waitFor(opts = {}) {
      const timeoutMs = Math.max(100, Math.min(30000, Number(opts.timeoutMs ?? opts.timeout_ms ?? 5000)));
      const intervalMs = Math.max(50, Math.min(2000, Number(opts.intervalMs ?? opts.interval_ms ?? 150)));
      const deadline = Date.now() + timeoutMs;

      if (opts.windowOnly || opts.window_only) {
        while (true) {
          const wins = await api.windows();
          const found = wins.find((w) => matchesWindow(w, opts));
          if (found) return { ok: true, window: found };
          if (Date.now() >= deadline) {
            return { ok: false, error: `waitFor window timed out after ${timeoutMs}ms` };
          }
          await sleep(intervalMs);
        }
      }

      const stateOpts = {
        include_screenshot: false,
        interactive_only: opts.interactive_only ?? true,
      };
      for (const k of ["window_id", "pid", "app_id", "wm_class", "title", "app_name_or_bundle_identifier", "max_nodes", "max_depth"]) {
        if (opts[k] !== undefined) stateOpts[k] = opts[k];
      }
      const matcher = opts.matcher ?? {
        role: opts.role,
        exactRole: opts.exactRole,
        name: opts.name,
        exactName: opts.exactName,
        text: opts.text,
        action: opts.action,
        state: opts.state,
        states: opts.states,
      };
      while (true) {
        const st = await api.getAppState(stateOpts);
        const node = api.find(st, matcher);
        if (node) {
          return { ok: true, node, snapshot_id: st.snapshot_id ?? lastSnapshotId, state: st };
        }
        if (Date.now() >= deadline) {
          return { ok: false, error: `waitFor element timed out after ${timeoutMs}ms`, snapshot_id: st.snapshot_id ?? lastSnapshotId };
        }
        await sleep(intervalMs);
      }
    },

    async clickAll(targets, baseOpts = {}) {
      if (!Array.isArray(targets)) {
        throw new Error("clickAll expects an array of targets");
      }
      const delayMs = Number(baseOpts.delayMs ?? baseOpts.delay_ms ?? 0);
      const stopOnError = baseOpts.stopOnError ?? baseOpts.stop_on_error ?? true;
      const shared = { ...baseOpts };
      delete shared.delayMs;
      delete shared.delay_ms;
      delete shared.stopOnError;
      delete shared.stop_on_error;

      const results = [];
      let allOk = true;
      let succeeded = 0;
      for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        try {
          let stepArgs;
          if (typeof target === "number") {
            stepArgs = { ...shared, element_index: target };
          } else {
            stepArgs = normalizeClickArgs(target, undefined, undefined, shared);
          }
          const res = await api.click(stepArgs);
          const stepOk = res?.ok !== false;
          if (stepOk) {
            succeeded += 1;
          } else {
            allOk = false;
          }
          results.push({ step: i, target, ok: stepOk, message: res?.message, error: res?.error });
          if (!stepOk && stopOnError) {
            return { ok: false, completed: results.length, succeeded, total: targets.length, results };
          }
        } catch (err) {
          allOk = false;
          const message = err instanceof Error ? err.message : String(err);
          results.push({ step: i, target, ok: false, error: message });
          if (stopOnError) {
            return { ok: false, completed: results.length, succeeded, total: targets.length, results };
          }
        }
        if (delayMs > 0 && i + 1 < targets.length) {
          await sleep(delayMs);
        }
      }
      return { ok: allOk, completed: results.length, succeeded, total: targets.length, results };
    },

    async fillForm(fields, baseOpts = {}) {
      if (!Array.isArray(fields)) {
        throw new Error("fillForm expects an array of { value, ...selector } objects");
      }
      const delayMs = Number(baseOpts.delayMs ?? baseOpts.delay_ms ?? 0);
      const stopOnError = baseOpts.stopOnError ?? baseOpts.stop_on_error ?? true;
      const shared = { ...baseOpts };
      delete shared.delayMs;
      delete shared.delay_ms;
      delete shared.stopOnError;
      delete shared.stop_on_error;

      const results = [];
      let allOk = true;
      let succeeded = 0;
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i];
        const mode = field.mode || "set_value";
        const stepArgs = { ...shared, ...field };
        delete stepArgs.mode;
        try {
          let res;
          if (mode === "type") {
            // `value` is what to type. `text` is the typed text only when no `value` is given;
            // then it must not also act as a click selector.
            const typedFromText = stepArgs.value === undefined && stepArgs.text !== undefined;
            const text = String(stepArgs.value ?? stepArgs.text ?? "");
            delete stepArgs.value;
            if (typedFromText) delete stepArgs.text;
            const clickRes = await api.click(stepArgs);
            if (clickRes?.ok === false) {
              allOk = false;
              results.push({ step: i, ok: false, error: clickRes.error || clickRes.message || "prerequisite click failed" });
              if (stopOnError) {
                return { ok: false, completed: results.length, succeeded, total: fields.length, results };
              }
              continue;
            }
            res = await api.typeText(text, shared.window_id !== undefined ? { window_id: shared.window_id } : {});
          } else {
            res = await api.setValue(stepArgs);
          }
          const stepOk = res?.ok !== false;
          if (stepOk) {
            succeeded += 1;
          } else {
            allOk = false;
          }
          results.push({ step: i, ok: stepOk, message: res?.message, error: res?.error });
          if (!stepOk && stopOnError) {
            return { ok: false, completed: results.length, succeeded, total: fields.length, results };
          }
        } catch (err) {
          allOk = false;
          const message = err instanceof Error ? err.message : String(err);
          results.push({ step: i, ok: false, error: message });
          if (stopOnError) {
            return { ok: false, completed: results.length, succeeded, total: fields.length, results };
          }
        }
        if (delayMs > 0 && i + 1 < fields.length) {
          await sleep(delayMs);
        }
      }
      return { ok: allOk, completed: results.length, succeeded, total: fields.length, results };
    },
  };
  return api;
}

const sandboxConsole = {
  log: (...args) => pushLog("log", args),
  info: (...args) => pushLog("info", args),
  warn: (...args) => pushLog("warn", args),
  error: (...args) => pushLog("error", args),
};

const desktop = buildDesktopApi();

const context = vm.createContext(
  {
    desktop,
    cua: desktop,
    sleep,
    wait: sleep,
    viewImage,
    console: sandboxConsole,
    setTimeout: trackedSetTimeout,
    clearTimeout: trackedClearTimeout,
    setInterval: trackedSetInterval,
    clearInterval: trackedClearInterval,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
  },
  {
    name: "codex-computer-use-linux-repl",
    codeGeneration: { strings: false, wasm: false },
  }
);
vm.runInContext("globalThis.state = {};", context);

// Syntax-aware lexer/scanner for depth-0 top-level declarations (const/let/var/function/class).
// Handles strings, template literals (including nested `${...}`), comments, numbers, and regex
// literals so rewriting never touches non-declaration tokens or loses depth tracking.
function isIdentStart(ch) {
  return /[\p{ID_Start}$_]/u.test(ch);
}

function isIdentPart(ch) {
  return /[\p{ID_Continue}$\u200c\u200d]/u.test(ch);
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "delete",
  "void",
  "typeof",
  "in",
  "instanceof",
  "new",
  "of",
  "yield",
  "await",
  "else",
  "do",
]);

const CONTROL_PAREN_KEYWORDS = new Set(["if", "while", "for", "with"]);

const EXPR_BEFORE_DECL = new Set([
  "=",
  "(",
  "[",
  ",",
  ":",
  "?",
  "=>",
  "return",
  "throw",
  "yield",
  "await",
  "new",
  "typeof",
  "void",
  "delete",
  "export",
  "default",
  "+",
  "-",
  "!",
  "~",
  "&",
  "|",
  "^",
  "*",
  "/",
  "%",
  "<",
  ">",
]);

// Keywords after which `function`/`class`/`async` is an expression operand.
const EXPR_KEYWORDS = new Set(["in", "of", "instanceof", "case", "extends", "async"]);

const STATEMENT_START_KEYWORDS = new Set([
  "function",
  "class",
  "const",
  "let",
  "var",
  "if",
  "for",
  "while",
  "do",
  "try",
  "switch",
  "return",
  "throw",
]);

function canStartRegex(prevToken, beforePrev) {
  if (!prevToken) return true;
  if (prevToken.type === "lit") return false;
  if (prevToken.type === "ident") {
    // `obj.in / 2` divides: a keyword after `.` is a property name.
    if (beforePrev?.type === "punct" && beforePrev.value === ".") return false;
    return REGEX_PRECEDING_KEYWORDS.has(prevToken.value);
  }
  if (prevToken.type === "punct") {
    if (prevToken.value === "]") return false;
    if (prevToken.value === ")") return Boolean(prevToken.isControlClose);
    if (prevToken.value === "++" || prevToken.value === "--") return false;
    return true;
  }
  return true;
}

// Whether `function`, `class`, `async` or a statement keyword at idx starts a statement rather than
// sitting inside an expression. After `;`, `{` or `}` it does. After a token that can end an
// expression (an identifier, literal, `)`, `]`, `++`, `--`) it does only on a new line, where
// automatic semicolon insertion ends the previous statement. After an operator or an
// expression keyword it never does.
function isDeclarationPosition(tokens, idx) {
  if (idx === 0) return true;
  const prev = tokens[idx - 1];
  const onNewLine = Boolean(tokens[idx].nlBefore);
  if (prev.type === "punct") {
    if (prev.value === ";" || prev.value === "{" || prev.value === "}") return true;
    if (prev.value === ")" || prev.value === "]" || prev.value === "++" || prev.value === "--") {
      return onNewLine;
    }
    return false;
  }
  if (prev.type === "ident") {
    if (EXPR_BEFORE_DECL.has(prev.value) || EXPR_KEYWORDS.has(prev.value)) return false;
    if (tokens[idx - 2]?.type === "punct" && tokens[idx - 2].value === ".") return onNewLine;
    return onNewLine || prev.value === "else" || prev.value === "do";
  }
  return onNewLine;
}

function tokenizeJs(code) {
  const tokens = [];
  const len = code.length;
  let i = 0;
  const templateStack = [];
  const parenControlStack = [];

  while (i < len) {
    const ch = code[i];
    const next = code[i + 1];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < len && code[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i = Math.min(len, i + 2);
      continue;
    }
    if (ch === "/" && canStartRegex(tokens[tokens.length - 1] || null, tokens[tokens.length - 2] || null)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < len) {
        const c = code[j];
        if (c === "\n" || c === "\r") break;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") {
          inClass = true;
          j += 1;
          continue;
        }
        if (c === "]") {
          inClass = false;
          j += 1;
          continue;
        }
        if (c === "/" && !inClass) {
          j += 1;
          while (j < len && /[A-Za-z]/.test(code[j])) j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        tokens.push({ type: "lit", value: "/", start: i, end: j });
        i = j;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      const start = i;
      const quote = ch;
      i += 1;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: "lit", value: quote, start, end: i });
      continue;
    }
    if (ch === "`") {
      const start = i;
      i += 1;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          templateStack.push(0);
          tokens.push({ type: "punct", value: "{", start: i + 1, end: i + 2 });
          i += 2;
          break;
        }
        if (code[i] === "`") {
          i += 1;
          tokens.push({ type: "lit", value: "`", start, end: i });
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "}" && templateStack.length > 0 && templateStack[templateStack.length - 1] === 0) {
      templateStack.pop();
      tokens.push({ type: "punct", value: "}", start: i, end: i + 1 });
      const segStart = i + 1;
      i += 1;
      while (i < len) {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          templateStack.push(0);
          tokens.push({ type: "punct", value: "{", start: i + 1, end: i + 2 });
          i += 2;
          break;
        }
        if (code[i] === "`") {
          i += 1;
          tokens.push({ type: "lit", value: "`", start: segStart, end: i });
          break;
        }
        i += 1;
      }
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next || ""))) {
      const start = i;
      i += 1;
      while (i < len && /[0-9A-Za-z_.]/.test(code[i])) i += 1;
      tokens.push({ type: "lit", value: "num", start, end: i });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentPart(code[i])) i += 1;
      tokens.push({ type: "ident", value: code.slice(start, i), start, end: i });
      continue;
    }
    if ((ch === "=" && next === ">") || (ch === "+" && next === "+") || (ch === "-" && next === "-")) {
      tokens.push({ type: "punct", value: ch + next, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ch === "{" && templateStack.length > 0) {
      templateStack[templateStack.length - 1] += 1;
    } else if (ch === "}" && templateStack.length > 0) {
      templateStack[templateStack.length - 1] -= 1;
    }
    if (ch === "(") {
      const prev = tokens[tokens.length - 1];
      parenControlStack.push(Boolean(prev && prev.type === "ident" && CONTROL_PAREN_KEYWORDS.has(prev.value)));
      tokens.push({ type: "punct", value: "(", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (ch === ")") {
      const isControlClose = parenControlStack.length > 0 ? parenControlStack.pop() : false;
      tokens.push({ type: "punct", value: ")", start: i, end: i + 1, isControlClose });
      i += 1;
      continue;
    }
    tokens.push({ type: "punct", value: ch, start: i, end: i + 1 });
    i += 1;
  }
  // Mark tokens that start a new line (a comment spanning lines counts), for ASI-aware checks.
  for (let k = 1; k < tokens.length; k += 1) {
    const gap = code.slice(tokens[k - 1].end, tokens[k].start);
    tokens[k].nlBefore = /[\n\r\u2028\u2029]/.test(gap);
  }
  return tokens;
}

function collectPatternBindings(tokens, idx, names) {
  if (idx >= tokens.length) return idx;
  const tok = tokens[idx];
  if (tok.type === "ident") {
    names.add(tok.value);
    return idx + 1;
  }
  if (tok.type === "punct" && (tok.value === "{" || tok.value === "[")) {
    const open = tok.value;
    const close = open === "{" ? "}" : "]";
    let i = idx + 1;
    while (i < tokens.length) {
      const cur = tokens[i];
      if (cur.type === "punct" && cur.value === close) return i + 1;
      if (cur.type === "punct" && cur.value === ",") {
        i += 1;
        continue;
      }
      if (cur.type === "punct" && cur.value === ".") {
        while (i < tokens.length && tokens[i].type === "punct" && tokens[i].value === ".") i += 1;
        i = collectPatternBindings(tokens, i, names);
        continue;
      }
      if (open === "{") {
        if (cur.type === "ident" || cur.type === "lit") {
          const next = tokens[i + 1];
          if (next && next.type === "punct" && next.value === ":") {
            i = collectPatternBindings(tokens, i + 2, names);
          } else if (cur.type === "ident") {
            names.add(cur.value);
            i += 1;
          } else {
            i += 1;
          }
        } else if (cur.type === "punct" && cur.value === "[") {
          let bDepth = 1;
          i += 1;
          while (i < tokens.length && bDepth > 0) {
            if (tokens[i].type === "punct" && tokens[i].value === "[") bDepth += 1;
            else if (tokens[i].type === "punct" && tokens[i].value === "]") bDepth -= 1;
            i += 1;
          }
          if (tokens[i]?.type === "punct" && tokens[i].value === ":") {
            i = collectPatternBindings(tokens, i + 1, names);
          }
        } else {
          i += 1;
        }
      } else {
        i = collectPatternBindings(tokens, i, names);
      }
      if (tokens[i]?.type === "punct" && tokens[i].value === "=") {
        i += 1;
        let depth = 0;
        while (i < tokens.length) {
          const t = tokens[i];
          if (t.type === "punct") {
            if (t.value === "(" || t.value === "{" || t.value === "[") depth += 1;
            else if (t.value === ")" || t.value === "}" || t.value === "]") {
              if (depth === 0 && t.value === close) break;
              depth = Math.max(0, depth - 1);
            } else if (depth === 0 && t.value === ",") {
              break;
            }
          }
          i += 1;
        }
      }
    }
    return i;
  }
  return idx + 1;
}

function extractTopLevelBindings(tokens) {
  const varNames = new Set();
  const fnNames = new Set();
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    if (tok.type === "punct") {
      if (tok.value === "{") braceDepth += 1;
      else if (tok.value === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (tok.value === "(") parenDepth += 1;
      else if (tok.value === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (tok.value === "[") bracketDepth += 1;
      else if (tok.value === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      i += 1;
      continue;
    }

    const prevTok = i > 0 ? tokens[i - 1] : null;
    const isPropertyAccess = prevTok?.type === "punct" && prevTok.value === ".";
    if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && tok.type === "ident" && !isPropertyAccess) {
      if (tok.value === "const" || tok.value === "let" || tok.value === "var") {
        i += 1;
        while (i < tokens.length) {
          i = collectPatternBindings(tokens, i, varNames);
          let dBrace = 0;
          let dParen = 0;
          let dBracket = 0;
          let sawComma = false;
          while (i < tokens.length) {
            const t = tokens[i];
            if (t.type === "punct") {
              if (t.value === "{") dBrace += 1;
              else if (t.value === "}") dBrace = Math.max(0, dBrace - 1);
              else if (t.value === "(") dParen += 1;
              else if (t.value === ")") dParen = Math.max(0, dParen - 1);
              else if (t.value === "[") dBracket += 1;
              else if (t.value === "]") dBracket = Math.max(0, dBracket - 1);
              else if (dBrace === 0 && dParen === 0 && dBracket === 0) {
                if (t.value === ",") {
                  sawComma = true;
                  i += 1;
                  break;
                }
                if (t.value === ";") {
                  i += 1;
                  break;
                }
              }
            } else if (
              dBrace === 0 &&
              dParen === 0 &&
              dBracket === 0 &&
              t.type === "ident" &&
              (STATEMENT_START_KEYWORDS.has(t.value) || t.value === "async") &&
              isDeclarationPosition(tokens, i)
            ) {
              // A new statement after ASI. `fa = async () => 1, fb = 2` keeps scanning.
              break;
            }
            i += 1;
          }
          if (!sawComma) break;
        }
        continue;
      }

      if (tok.value === "class" && isDeclarationPosition(tokens, i)) {
        const nextIdx = i + 1;
        if (tokens[nextIdx]?.type === "ident") {
          varNames.add(tokens[nextIdx].value);
        }
        i = nextIdx + 1;
        continue;
      }

      if (
        tok.value === "function" &&
        !(prevTok?.type === "ident" && prevTok.value === "async") &&
        isDeclarationPosition(tokens, i)
      ) {
        let nextIdx = i + 1;
        if (tokens[nextIdx]?.type === "punct" && tokens[nextIdx].value === "*") {
          nextIdx += 1;
        }
        if (tokens[nextIdx]?.type === "ident") {
          fnNames.add(tokens[nextIdx].value);
        }
        i = nextIdx + 1;
        continue;
      }

      if (
        tok.value === "async" &&
        tokens[i + 1]?.type === "ident" &&
        tokens[i + 1].value === "function" &&
        isDeclarationPosition(tokens, i)
      ) {
        let nextIdx = i + 2;
        if (tokens[nextIdx]?.type === "punct" && tokens[nextIdx].value === "*") {
          nextIdx += 1;
        }
        if (tokens[nextIdx]?.type === "ident") {
          fnNames.add(tokens[nextIdx].value);
        }
        i = nextIdx + 1;
        continue;
      }
    }

    i += 1;
  }

  return { varNames: [...varNames], fnNames: [...fnNames] };
}

// Index of the `}` closing the class body that starts at or after idx (skipping an
// `extends` expression), or null when the source is cut off.
function findClassBodyEnd(tokens, idx) {
  let paren = 0;
  let bracket = 0;
  let k = idx;
  for (; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== "punct") continue;
    if (t.value === "(") paren += 1;
    else if (t.value === ")") paren = Math.max(0, paren - 1);
    else if (t.value === "[") bracket += 1;
    else if (t.value === "]") bracket = Math.max(0, bracket - 1);
    else if (t.value === "{" && paren === 0 && bracket === 0) break;
  }
  let depth = 0;
  for (; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== "punct") continue;
    if (t.value === "{") depth += 1;
    else if (t.value === "}") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return null;
}

function rewriteDepthZeroDeclarations(source, tokens) {
  const edits = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.type === "punct") {
      if (tok.value === "{") braceDepth += 1;
      else if (tok.value === "}") braceDepth = Math.max(0, braceDepth - 1);
      else if (tok.value === "(") parenDepth += 1;
      else if (tok.value === ")") parenDepth = Math.max(0, parenDepth - 1);
      else if (tok.value === "[") bracketDepth += 1;
      else if (tok.value === "]") bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0 || tok.type !== "ident") {
      continue;
    }

    const prevTok = i > 0 ? tokens[i - 1] : null;
    if (prevTok?.type === "punct" && prevTok.value === ".") continue;

    if (tok.value === "const" || tok.value === "let") {
      edits.push({ start: tok.start, end: tok.end, replacement: "var" });
    } else if (
      tok.value === "class" &&
      tokens[i + 1]?.type === "ident" &&
      isDeclarationPosition(tokens, i)
    ) {
      const nameTok = tokens[i + 1];
      edits.push({
        start: tok.start,
        end: nameTok.end,
        replacement: `var ${nameTok.value} = class ${nameTok.value}`,
      });
      // The rewrite turns the declaration into an expression, so a next line that starts with
      // `(`, `[` or a template would attach to it. End the statement after the class body.
      const close = findClassBodyEnd(tokens, i + 2);
      if (close !== null) {
        edits.push({ start: tokens[close].end, end: tokens[close].end, replacement: ";" });
      }
    }
  }

  if (edits.length === 0) return source;
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of edits) {
    out += source.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  out += source.slice(cursor);
  return out;
}

function startsWithDeclarationOrStatement(tokens) {
  if (tokens.length === 0) return false;
  const first = tokens[0];
  if (first.type !== "ident") return false;
  if (STATEMENT_START_KEYWORDS.has(first.value)) return true;
  if (first.value === "async" && tokens[1]?.type === "ident" && tokens[1].value === "function") {
    return true;
  }
  return false;
}

// Token index where a declarator's initializer starting at idx ends: a depth-0 `,` or `;`, a
// new statement after automatic semicolon insertion, or the end of input.
function initializerEnd(tokens, idx) {
  let depth = 0;
  for (let k = idx; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "{" || t.value === "[") depth += 1;
      else if (t.value === ")" || t.value === "}" || t.value === "]") {
        if (depth === 0) return k;
        depth -= 1;
      } else if (depth === 0 && (t.value === "," || t.value === ";")) {
        return k;
      }
      continue;
    }
    if (depth !== 0 || k === idx) continue;
    if (
      t.type === "ident" &&
      (STATEMENT_START_KEYWORDS.has(t.value) || t.value === "async") &&
      isDeclarationPosition(tokens, k)
    ) {
      return k;
    }
    if (t.nlBefore && asiEndsStatementBefore(tokens, k)) return k;
  }
  return tokens.length;
}

// Whether a line break before tokens[k] ends the statement: the previous token can end an
// expression and tokens[k] cannot continue it (an identifier or a number or string literal).
function asiEndsStatementBefore(tokens, k) {
  const prev = tokens[k - 1];
  const t = tokens[k];
  const prevEnds =
    prev.type === "lit" ||
    (prev.type === "ident" && !EXPR_BEFORE_DECL.has(prev.value) && !EXPR_KEYWORDS.has(prev.value)) ||
    (prev.type === "punct" && [")", "]", "}", "++", "--"].includes(prev.value));
  if (!prevEnds) return false;
  if (t.type === "ident") return !["in", "of", "instanceof"].includes(t.value);
  return t.type === "lit" && t.value !== "`" && t.value !== "/";
}

// Plan turning depth-0 declarations into assignments to script-level `var`s, so functions
// defined in one call and later calls share the same binding. `let x = 1, y` becomes
// `;x = 1, y = void 0`, `const {a} = o` becomes `;({a} = o)` and `class A {}` becomes
// `;A = class A {};`. Returns null for a shape it does not handle.
function planGlobalDeclarations(tokens) {
  const edits = [];
  const names = new Set();
  let brace = 0;
  let paren = 0;
  let bracket = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.type === "punct") {
      if (tok.value === "{") brace += 1;
      else if (tok.value === "}") brace = Math.max(0, brace - 1);
      else if (tok.value === "(") paren += 1;
      else if (tok.value === ")") paren = Math.max(0, paren - 1);
      else if (tok.value === "[") bracket += 1;
      else if (tok.value === "]") bracket = Math.max(0, bracket - 1);
      continue;
    }
    if (brace !== 0 || paren !== 0 || bracket !== 0 || tok.type !== "ident") continue;
    const prev = tokens[i - 1];
    if (prev?.type === "punct" && prev.value === ".") continue;

    if (tok.value === "class" && tokens[i + 1]?.type === "ident" && isDeclarationPosition(tokens, i)) {
      const name = tokens[i + 1].value;
      const close = findClassBodyEnd(tokens, i + 2);
      if (close === null) return null;
      names.add(name);
      edits.push({ start: tok.start, end: tok.start, replacement: `;${name} = ` });
      edits.push({ start: tokens[close].end, end: tokens[close].end, replacement: ";" });
      i = close;
      continue;
    }
    if (tok.value !== "const" && tok.value !== "let" && tok.value !== "var") continue;

    const declEdits = [];
    let needsParens = false;
    let j = i + 1;
    let end;
    for (;;) {
      const pat = tokens[j];
      if (!pat) return null;
      const isObject = pat.type === "punct" && pat.value === "{";
      const isArray = pat.type === "punct" && pat.value === "[";
      if (!isObject && !isArray && pat.type !== "ident") return null;
      if (isObject) needsParens = true;
      const after = collectPatternBindings(tokens, j, names);
      if (tokens[after]?.type === "punct" && tokens[after].value === "=") {
        end = initializerEnd(tokens, after + 1);
      } else {
        if (pat.type !== "ident") return null;
        declEdits.push({ start: tokens[after - 1].end, end: tokens[after - 1].end, replacement: " = void 0" });
        end = after;
      }
      if (tokens[end]?.type === "punct" && tokens[end].value === ",") {
        j = end + 1;
        continue;
      }
      break;
    }
    edits.push({ start: tok.start, end: tok.end, replacement: needsParens ? ";(" : ";" });
    edits.push(...declEdits);
    if (needsParens) {
      const last = tokens[end - 1];
      edits.push({ start: last.end, end: last.end, replacement: ")" });
    }
    i = end - 1;
  }
  return { edits, names: [...names] };
}

function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    out += source.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return out + source.slice(cursor);
}

function compileWithGlobalBindings(source, tokens, fnNames) {
  const plan = planGlobalDeclarations(tokens);
  if (!plan) return null;
  const rewritten = applyEdits(source, plan.edits);
  const header = plan.names.length > 0 ? `var ${plan.names.join(", ")};\n` : "";
  const fnPersistLines = fnNames.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("\n");
  const candidate = `${header}(async () => {\n${fnPersistLines}\n${rewritten}\n;\n${fnPersistLines}\n})()`;
  try {
    return new vm.Script(candidate, { filename: "repl.mjs" });
  } catch {
    return null;
  }
}

function compileEvalScript(code) {
  const source = String(code || "");
  const trimmed = source.trim();
  const tokens = tokenizeJs(source);

  // Try compiling as a single expression so inputs like `1 + 2` or `await desktop.windows()`
  // return their value directly, but skip expression-first mode for top-level declarations
  // (like lone `function f() {}` or `class A {}`) so they persist across turns.
  if (trimmed && !trimmed.endsWith(";") && !startsWithDeclarationOrStatement(tokens)) {
    try {
      return new vm.Script(`(async () => { return (\n${trimmed}\n); })()`, {
        filename: "repl.mjs",
      });
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        throw err;
      }
    }
  }

  const bindings = extractTopLevelBindings(tokens);
  const wrapped = `(async () => {\n${source}\n})()`;
  if (bindings.varNames.length > 0 || bindings.fnNames.length > 0) {
    // Prefer real script-level bindings, so a persisted function and later calls share one
    // variable; fall back to copying values to globalThis when the rewrite cannot be planned.
    const shared = compileWithGlobalBindings(source, tokens, bindings.fnNames);
    if (shared) return shared;
    return compileWithTopLevelPersistence(source, tokens, bindings, wrapped);
  }

  return new vm.Script(wrapped, { filename: "repl.mjs" });
}

function compileWithTopLevelPersistence(source, tokens, bindings, fallbackWrapped) {
  // Rewrite ONLY depth-0 `const`/`let` -> `var` and depth-0 `class Name` -> `var Name = class Name`
  // using token spans from the unified lexer so `finally` at the same function scope can copy every
  // initialized binding to `globalThis` even on `return` or mid-eval error.
  // Function declarations (`function`, `async function`, `function*`) are hoisted to the top of the
  // `try` block (even though `async function` and `function*` are block-scoped to `try`), so copying
  // them at the top of `try` persists them immediately while preserving native hoisting.
  const rewritten = rewriteDepthZeroDeclarations(source, tokens);
  const fnPersistLines = bindings.fnNames
    .map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`)
    .join("\n");
  const varPersistLines = bindings.varNames
    .map((name) => `if (typeof ${name} !== "undefined") globalThis[${JSON.stringify(name)}] = ${name};`)
    .join("\n");
  const candidate = `(async () => {\ntry {\n${fnPersistLines}\n${rewritten}\n;\n${fnPersistLines}\n} finally {\n${varPersistLines}\n}\n})()`;
  try {
    return new vm.Script(candidate, { filename: "repl.mjs" });
  } catch {
    return new vm.Script(fallbackWrapped, { filename: "repl.mjs" });
  }
}

function serializeResultValue(value) {
  if (value === undefined) return null;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = JSON.stringify(String(value));
  }
  if (json === undefined) return null;
  if (json.length > MAX_VALUE_CHARS) {
    return {
      truncated: true,
      original_chars: json.length,
      preview: cut(json, MAX_VALUE_CHARS),
    };
  }
  try {
    return JSON.parse(json);
  } catch {
    return String(value);
  }
}

async function handleEval(msg) {
  const started = Date.now();
  const evalId = Number(msg.id) || 1;
  currentEvalId = evalId;
  evalActive = true;
  currentLogs = [];
  currentLogChars = 0;
  currentLogsDropped = false;
  for (const line of pendingUnhandledLogs.splice(0)) appendLogLine(line);
  currentAttachedImages = [];
  currentCallCount = 0;

  try {
    const script = compileEvalScript(String(msg.code || ""));
    const promise = script.runInContext(context, {
      timeout: Math.max(1000, Math.min(120000, Number(msg.timeoutMs) || 30000)),
    });
    const value = await promise;
    writeMessage({
      type: "eval_result",
      id: evalId,
      ok: true,
      timed_out: false,
      value: serializeResultValue(value),
      logs: currentLogs,
      attached_images: currentAttachedImages,
      calls: currentCallCount,
      snapshot_id: lastSnapshotId,
      elapsed_ms: Date.now() - started,
    });
  } catch (err) {
    const timedOut =
      err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" ||
      String(err?.message || "").includes("Script execution timed out");
    writeMessage({
      type: "eval_result",
      id: evalId,
      ok: false,
      timed_out: timedOut,
      error: cut(err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : err, MAX_VALUE_CHARS),
      logs: currentLogs,
      attached_images: currentAttachedImages,
      calls: currentCallCount,
      snapshot_id: lastSnapshotId,
      elapsed_ms: Date.now() - started,
    });
  } finally {
    evalActive = false;
    clearEvalTimers();
    rejectPendingRpcsForEval(evalId, "js evaluation ended before pending desktop RPC completed");
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "eval") {
    handleEval(msg);
  } else if (msg.type === "rpc_result") {
    const entry = pendingRpc.get(msg.id);
    if (!entry) return;
    pendingRpc.delete(msg.id);
    if (entry.evalId !== currentEvalId || !evalActive) return;
    if (Array.isArray(msg.image_indices) && msg.image_indices.length > 0) {
      if (msg.data && typeof msg.data === "object") {
        Object.defineProperty(msg.data, "_imageIndices", {
          value: msg.image_indices,
          enumerable: false,
        });
      }
      if (entry.attach) {
        for (const idx of msg.image_indices) {
          currentAttachedImages.push(idx);
        }
      }
    }
    if (msg.ok) {
      entry.resolve(msg.data);
    } else {
      entry.reject(new Error(msg.error || "MCP tool call failed"));
    }
  }
});

rl.on("close", () => {
  process.exit(0);
});
