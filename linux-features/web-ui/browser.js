"use strict";

(() => {
  if (globalThis.electronBridge) return;
  // Plain HTTP on a non-loopback address (LAN IP, container name) is not a
  // secure context, so Chromium hides crypto.randomUUID from it and upstream.
  if (typeof crypto.randomUUID !== "function") {
    crypto.randomUUID = () => {
      const b = crypto.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    };
  }
  // The capability arrives in the URL fragment (never sent to the server) and
  // stays in origin-scoped storage, which other ports on this hostname cannot
  // read. It is never stored in a cookie, so browsers never attach it on
  // their own.
  const storageKey = "community-web-ui:capability";
  const store = {
    get() { try { return localStorage.getItem(storageKey); } catch { return null; } },
    set(value) { try { localStorage.setItem(storageKey, value); } catch {} },
    clear() { try { localStorage.removeItem(storageKey); } catch {} },
  };
  const fragment = new URLSearchParams(location.hash.slice(1)).get("cap");
  if (fragment !== null) {
    history.replaceState(history.state, "", location.pathname + location.search);
    store.set(fragment);
  }
  const capability = fragment ?? store.get();
  // Opening a new connection URL (after a host restart) in this tab changes
  // only the fragment and does not reload the document. Reload so the new
  // capability is consumed and the bridge reinitializes, also from the stop page.
  window.addEventListener("hashchange", () => {
    if (new URLSearchParams(location.hash.slice(1)).has("cap")) location.reload();
  });
  function blocked(text) {
    // Stop before upstream's scripts load; they need the bridge defined here.
    window.stop();
    const message = document.createElement("p");
    message.setAttribute("role", "alert");
    message.textContent = text;
    message.style.cssText = "font:16px system-ui;max-width:40em;margin:20vh auto;padding:0 16px;text-align:center";
    const body = document.createElement("body");
    body.append(message);
    document.documentElement.replaceChildren(document.head ?? document.createElement("head"), body);
    throw Error(text);
  }
  if (!capability || !/^[\w-]+$/.test(capability)) blocked("Open the complete connection URL printed by ChatGPT Community.");
  const request = new XMLHttpRequest();
  request.open("GET", "/_community/bootstrap", false);
  request.setRequestHeader("Authorization", `Bearer ${capability}`);
  request.send();
  if (request.status === 403) {
    store.clear();
    blocked("This connection URL is no longer valid. If ChatGPT Community restarted, open the new URL it printed.");
  }
  if (request.status !== 200) blocked("The Web UI host is not ready. Reload in a moment.");
  const bootstrap = JSON.parse(request.responseText);
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/_community/bridge`, ["community-web-ui", `community-web-ui.cap.${capability}`]);
  const pending = new Map(), workers = new Map();
  // Late results from a disconnected tab must not resolve a new tab's calls.
  const session = crypto.randomUUID();
  let sequence = 0, port, disconnected = false;
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(Error("Web UI connection failed")), { once: true });
  });
  // Handle failure even before the renderer makes its first request.
  opened.catch(() => {});
  async function send(value) {
    await opened;
    if (disconnected || socket.readyState !== WebSocket.OPEN) throw Error("Web UI disconnected; reload to reconnect.");
    socket.send(JSON.stringify(value));
  }
  async function invoke(method, args) {
    await opened;
    if (disconnected) throw Error("Web UI disconnected; reload to reconnect.");
    const id = `${session}:${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "invoke", id, method, args }).catch(error => { pending.delete(id); reject(error); });
    });
  }
  function setShared(key, value) {
    if (value === undefined) delete bootstrap.sharedObjectSnapshot[key];
    else bootstrap.sharedObjectSnapshot[key] = value;
  }
  function webUrl(value) {
    try {
      const url = new URL(value);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url;
    } catch {}
    return null;
  }
  function openExternal(url) {
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
  function externalLink(event) {
    if (event.defaultPrevented || ![0, 1].includes(event.button)) return;
    const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const url = link && webUrl(link.getAttribute("href"));
    if (!url || url.origin === location.origin || link.hasAttribute("download")) return;
    // Keep the browser's native click action and user activation, including
    // modified/middle clicks. Upstream's delegated desktop opener must not
    // intercept this click and round-trip through the asynchronous host.
    link.target = "_blank";
    link.relList.add("noopener", "noreferrer");
    event.stopImmediatePropagation();
  }
  window.addEventListener("click", externalLink, true);
  window.addEventListener("auxclick", externalLink, true);
  function presentDialog(dialog) {
    // Upstream's modal disables pointer events outside its content and traps
    // focus there. Keep this adapter inside that modal's DOM subtree so both
    // layers remain interactive; the native top layer handles visual stacking.
    const parent = [...document.querySelectorAll('[role="dialog"][aria-modal="true"][data-state="open"]')]
      .findLast(element => element.getClientRects().length) ?? document.body;
    dialog.style.cssText += ";position:fixed;inset:0;margin:auto;pointer-events:auto;background:Canvas;color:CanvasText";
    parent.append(dialog);
    dialog.showModal();
  }
  let folderDialog, abandonFolder;
  function chooseFolder() {
    // An upstream modal can unmount the chooser (Escape) without its cancel
    // event; settle that orphaned request instead of blocking every later pick.
    if (folderDialog && !folderDialog.isConnected) abandonFolder();
    if (folderDialog) return Promise.resolve(null);
    return new Promise(resolve => {
      const dialog = document.createElement("dialog");
      folderDialog = dialog;
      dialog.setAttribute("aria-label", "Choose a folder on the host computer");
      dialog.style.cssText = "width:min(560px,90vw);max-height:80vh;overflow:auto;border:1px solid #8886;border-radius:12px;padding:24px;font:14px system-ui;color-scheme:light dark";
      const title = document.createElement("h2"); title.textContent = "Choose a folder on the host computer";
      const form = document.createElement("form");
      const input = document.createElement("input");
      input.setAttribute("aria-label", "Host folder path");
      input.style.cssText = "width:100%;padding:8px;box-sizing:border-box";
      const error = document.createElement("p"); error.setAttribute("role", "status");
      const list = document.createElement("div"); list.style.cssText = "max-height:40vh;overflow:auto;margin:12px 0";
      const controls = document.createElement("div"); controls.style.cssText = "display:flex;gap:12px;justify-content:flex-end";
      const button = (label, action) => {
        const element = document.createElement("button"); element.type = "button"; element.textContent = label;
        element.style.cssText = "padding:8px 12px;cursor:pointer"; element.addEventListener("click", action); return element;
      };
      let selected = null, generation = 0;
      const choose = button("Use this folder", () => { if (selected) finish(selected); });
      async function browse(path) {
        const current = ++generation;
        choose.disabled = true; selected = null; error.textContent = "Loading…";
        try {
          const value = await invoke("listDirectories", [path]);
          if (current !== generation || folderDialog !== dialog) return;
          selected = value.path; input.value = value.path; list.replaceChildren();
          const up = button("Parent folder", () => browse(value.parent));
          list.append(up);
          for (const entry of value.entries) {
            const row = button(entry.name, () => browse(entry.path));
            row.style.cssText += ";display:block;width:100%;text-align:left;border:0;background:transparent";
            list.append(row);
          }
          error.textContent = value.entries.length ? "" : "No subfolders"; choose.disabled = false;
        } catch (failure) {
          if (current === generation) error.textContent = failure.message;
        }
      }
      function finish(value) { generation++; folderDialog = abandonFolder = undefined; if (dialog.open) dialog.close(); dialog.remove(); resolve(value); }
      abandonFolder = () => finish(null);
      form.addEventListener("submit", event => { event.preventDefault(); browse(input.value); });
      // Typing a path must validate it before the selection can be committed.
      input.addEventListener("input", () => { generation++; selected = null; choose.disabled = true; });
      dialog.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
      form.append(input, button("Open path", () => browse(input.value)));
      controls.append(button("Cancel", () => finish(null)), choose);
      dialog.append(title, form, error, list, controls); presentDialog(dialog);
      browse(null);
    });
  }
  function disconnect(event) {
    disconnected = true;
    port?.close(); port = undefined;
    for (const waiter of pending.values()) waiter.reject(Error("Web UI disconnected; reload to reconnect."));
    pending.clear();
    const banner = document.createElement("div");
    banner.textContent = event?.code === 1013
      ? "One browser session is already connected. Close that tab, then reload this page."
      : "Web UI disconnected. Reload to reconnect; if the app restarted, use its new connection URL.";
    banner.setAttribute("role", "alert");
    banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:12px;background:#7f1d1d;color:white;text-align:center;font:14px system-ui";
    (document.body ?? document.documentElement).append(banner);
  }
  socket.addEventListener("close", disconnect, { once: true });
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.type === "result") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) waiter?.resolve(message.value);
      else waiter?.reject(Error(message.error));
    } else if (message.type === "notification") {
      if (message.value?.type === "community-open-external") {
        const url = webUrl(message.value.url);
        if (url) openExternal(url);
        return;
      }
      if (message.value?.type === "shared-object-updated") setShared(message.value.key, message.value.value);
      window.dispatchEvent(new MessageEvent("message", { data: message.value }));
    } else if (message.type === "worker") {
      for (const callback of workers.get(message.workerId) ?? []) callback(message.value);
    } else if (message.type === "rpc") {
      port?.postMessage(message.value);
    }
  });
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.type !== "connect-app-host" || event.ports.length !== 1) return;
    port?.close();
    port = event.ports[0];
    const current = port;
    // Queue connect before starting delivery from the renderer's MessagePort.
    const connected = send({ type: "connect" });
    current.onmessage = event => {
      if ((event.data !== null && typeof event.data !== "string") || event.ports.length) {
        socket.close(1003, "Unsupported RPC encoding"); return;
      }
      connected.then(() => { if (port === current) return send({ type: "rpc", value: event.data }); }).catch(() => {});
    };
    current.start();
  });
  // Host-local previews: upstream renders app://fs/@fs/<path> (Electron's
  // protocol) and /@fs/<path>. <img> cannot send the bearer header, so fetch
  // them with it and show blob URLs instead.
  // Placeholders that load without error, so upstream's error state is not
  // entered while the authenticated fetch is pending.
  const blankImage = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const blankMedia = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  const hostMediaSelector = "img[src], audio[src], video[src], audio > source[src], video > source[src]";
  // Only concurrent loads are shared; every adaptation fetches again (the
  // server sends no-store), so an overwritten host file shows its new content.
  const inflight = new Map(), adapted = new WeakMap(), written = new WeakMap(), owned = new WeakMap();
  function hostMediaPath(source) {
    try {
      const url = new URL(source, location.href);
      const local = (url.protocol === "app:" && url.host === "fs") || url.origin === location.origin;
      if (local && url.pathname.startsWith("/@fs/")) return url.pathname.slice("/@fs".length);
    } catch {}
    return null;
  }
  function loadHostMedia(encodedPath) {
    if (!inflight.has(encodedPath)) {
      const blob = fetch(`/@fs${encodedPath}`, { headers: { Authorization: `Bearer ${capability}` } })
        .then(response => response.ok ? response.blob() : Promise.reject(Error(`HTTP ${response.status}`)))
        .finally(() => inflight.delete(encodedPath));
      inflight.set(encodedPath, blob);
    }
    return inflight.get(encodedPath);
  }
  const adaptable = element => element instanceof HTMLImageElement || element instanceof HTMLMediaElement ||
    (element instanceof HTMLSourceElement && element.parentElement instanceof HTMLMediaElement);
  function release(element) {
    const url = owned.get(element);
    if (url) { owned.delete(element); URL.revokeObjectURL(url); }
  }
  function write(element, source) {
    written.set(element, source);
    element.src = source;
    // A <source> change takes effect only when its media element reloads.
    if (element instanceof HTMLSourceElement) element.parentElement?.load();
  }
  function adaptMedia(element) {
    const source = element.getAttribute("src") ?? "";
    // Ignore the observer's echo of this adapter's own writes.
    if (written.get(element) === source) return;
    written.delete(element);
    release(element);
    const encodedPath = hostMediaPath(source);
    // Any other source (set by the renderer) supersedes a pending load.
    const generation = {};
    adapted.set(element, generation);
    if (encodedPath === null) return;
    const image = element instanceof HTMLImageElement;
    write(element, image ? blankImage : blankMedia);
    loadHostMedia(encodedPath).then(blob => {
      if (adapted.get(element) !== generation) return;
      const url = URL.createObjectURL(blob);
      if (image) {
        // Images are decoded once; release their blob URL after loading.
        const done = () => URL.revokeObjectURL(url);
        element.addEventListener("load", done, { once: true });
        element.addEventListener("error", done, { once: true });
      } else {
        // Audio/video read the blob while playing and seeking; keep it until
        // the source changes or the element leaves the document.
        owned.set(element, url);
      }
      write(element, url);
    }, () => { if (adapted.get(element) === generation) write(element, image ? "data:," : ""); });
  }
  function forEachAdaptable(node, callback) {
    if (!(node instanceof Element)) return;
    if (adaptable(node)) callback(node);
    node.querySelectorAll(hostMediaSelector).forEach(element => { if (adaptable(element)) callback(element); });
  }
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") { if (adaptable(record.target)) adaptMedia(record.target); continue; }
      for (const node of record.addedNodes) forEachAdaptable(node, adaptMedia);
      // Moves re-insert the node before this check; only release real removals.
      for (const node of record.removedNodes) queueMicrotask(() => { if (!node.isConnected) forEachAdaptable(node, release); });
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  const unsupported = () => { throw Error("This operation requires the desktop interface."); };
  const theme = matchMedia("(prefers-color-scheme: dark)");
  const bridge = {
    communityWebUi: true,
    windowType: "electron",
    acknowledgeChunkedMessage: () => {},
    getPreloadStartedAtMs: () => performance.timeOrigin,
    sendMessageFromView: message => {
      if (message.type === "open-in-browser") {
        const url = webUrl(message.url);
        if (url) { openExternal(url); return Promise.resolve(); }
      }
      // Open Folder… / Ctrl+O: main only shows its native dialog without a root.
      if (message.type === "electron-add-new-workspace-root-option" && message.root == null) {
        return chooseFolder().then(root => root ? invoke("sendMessageFromView", [{ ...message, root }]) : undefined);
      }
      if (message.type === "electron-pick-workspace-root-option") {
        return chooseFolder().then(root => {
          if (root) window.dispatchEvent(new MessageEvent("message", { data: { type: "workspace-root-option-picked", root } }));
        });
      }
      if (message.type === "shared-object-set") setShared(message.key, message.value);
      return invoke("sendMessageFromView", [message]);
    },
    sendWorkerMessageFromView: (id, message) => invoke("sendWorkerMessageFromView", [id, message]),
    subscribeToWorkerMessages: (workerId, callback) => {
      let listeners = workers.get(workerId);
      if (!listeners) {
        listeners = new Set(); workers.set(workerId, listeners);
        send({ type: "subscribe", workerId }).catch(() => {});
      }
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        if (!listeners.size) { workers.delete(workerId); send({ type: "unsubscribe", workerId }).catch(() => {}); }
      };
    },
    getFastModeRolloutMetrics: (...args) => invoke("getFastModeRolloutMetrics", args),
    getPathForFile: unsupported,
    startFileDrag: unsupported,
    startLinkDrag: unsupported,
    // Leaving showContextMenu absent selects upstream's browser menu.
    getSharedObjectSnapshotValue: key => bootstrap.sharedObjectSnapshot[key],
    getInitialSidebarBootstrap: () => null,
    getSystemThemeVariant: () => theme.matches ? "dark" : "light",
    subscribeToSystemThemeVariant: callback => {
      const update = () => callback(theme.matches ? "dark" : "light");
      theme.addEventListener("change", update);
      return () => theme.removeEventListener("change", update);
    },
    getDesktopUserAgent: () => bootstrap.desktopUserAgent,
    getAppSessionId: () => bootstrap.appSessionId,
    getBuildFlavor: () => bootstrap.buildFlavor,
    isDeviceCheckSupported: () => bootstrap.deviceCheckSupported,
    isIntelMacBuild: () => bootstrap.intelMacBuild,
    usesOwlAppShell: () => bootstrap.usesOwlAppShell,
    triggerSentryTestError: () => {},
  };
  Object.defineProperty(globalThis, "codexWindowType", { value: "electron" });
  Object.defineProperty(globalThis, "electronBridge", { value: Object.freeze(bridge) });
})();
