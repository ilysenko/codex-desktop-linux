"use strict";

// Embedded in the sandboxed upstream preload; it uses only the existing bridge.
function connectHost(ipc, bridge, sharedObjectSnapshot) {
  if (location.href !== "app://-/community-web-host.html") return;
  const channel = "community:web-ui";
  const subscriptions = new Map();
  // Worker requests forwarded for the current browser session. Upstream keeps
  // live queries (git watchers) until cancelled or the WebContents dies, and
  // this host outlives every browser session, so cancel them on reset.
  const outstanding = new Map();
  const requestKey = (workerId, id) => `${workerId}\0${id}`;
  let port;
  const send = message => ipc.send(channel, message);
  const closePort = () => { port?.close(); port = undefined; };
  const reset = () => {
    closePort();
    for (const dispose of subscriptions.values()) dispose();
    subscriptions.clear();
    for (const { workerId, id } of outstanding.values()) {
      try { bridge.sendWorkerMessageFromView(workerId, { type: "worker-request-cancel", workerId, id }); } catch {}
    }
    outstanding.clear();
  };
  window.addEventListener("message", event => {
    if (event.source == null) send({ type: "notification", value: event.data });
  });
  const allowed = new Set(["sendMessageFromView", "sendWorkerMessageFromView", "getFastModeRolloutMetrics"]);
  ipc.on(channel, async (_event, message) => {
    switch (message.type) {
      case "invoke":
        try {
          if (!allowed.has(message.method) || !Array.isArray(message.args)) throw Error("Unsupported browser operation");
          if (message.method === "sendMessageFromView" && message.args[0]?.type?.startsWith("browser-sidebar-")) {
            throw Error("The embedded browser is disabled in Web UI.");
          }
          if (message.method === "sendWorkerMessageFromView") {
            const [workerId, worker] = message.args;
            if (worker?.type === "worker-request" && worker.request?.id != null) outstanding.set(requestKey(workerId, worker.request.id), { workerId, id: worker.request.id });
            if (worker?.type === "worker-request-cancel") outstanding.delete(requestKey(workerId, worker.id));
          }
          const value = await bridge[message.method](...message.args);
          send({ type: "result", id: message.id, ok: true, value });
        } catch (error) {
          send({ type: "result", id: message.id, ok: false, error: String(error?.message ?? error) });
        }
        break;
      case "subscribe":
        if (typeof message.workerId === "string" && /^[\w:-]{1,128}$/.test(message.workerId) && !subscriptions.has(message.workerId)) {
          subscriptions.set(message.workerId, bridge.subscribeToWorkerMessages(message.workerId,
            value => {
              if (value?.type !== "worker-event" && value?.response?.id != null) outstanding.delete(requestKey(message.workerId, value.response.id));
              send({ type: "worker", workerId: message.workerId, value });
            }));
        }
        break;
      case "unsubscribe":
        subscriptions.get(message.workerId)?.(); subscriptions.delete(message.workerId);
        break;
      case "connect": {
        closePort();
        const pair = new MessageChannel();
        port = pair.port1;
        port.onmessage = event => {
          if ((event.data !== null && typeof event.data !== "string") || event.ports.length) {
            send({ type: "disconnect" }); reset(); return;
          }
          send({ type: "rpc", value: event.data });
        };
        port.start();
        ipc.postMessage("codex_desktop:connect-app-host", undefined, [pair.port2]);
        break;
      }
      case "rpc":
        if (message.value === null || typeof message.value === "string") port?.postMessage(message.value);
        break;
      case "disconnect": reset(); break;
    }
  });
  // The host page has no renderer to acknowledge upstream chunk envelopes.
  // Main's conditional inline delivery supplies complete messages instead.
  send({ type: "bootstrap", value: {
    sharedObjectSnapshot,
    appSessionId: bridge.getAppSessionId(),
    desktopUserAgent: bridge.getDesktopUserAgent(),
    buildFlavor: bridge.getBuildFlavor(),
    systemThemeVariant: bridge.getSystemThemeVariant(),
    deviceCheckSupported: bridge.isDeviceCheckSupported(),
    intelMacBuild: bridge.isIntelMacBuild(),
    // Browser surfaces cannot use Owl's embedded browser/native shell APIs.
    usesOwlAppShell: false,
  } });
}

module.exports = { connectHost };
