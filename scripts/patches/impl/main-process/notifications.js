"use strict";

const PATCH_MARKER = "codex-linux-notification-actions-v1";

function codexLinuxNotificationActionsNativePath() {
  const fs = require("node:fs");
  const path = require("node:path");
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "native", "codex-notification-actions-linux"));
  }
  try {
    const appPath = require("electron").app?.getAppPath?.();
    if (appPath) {
      candidates.push(path.join(appPath, "native", "codex-notification-actions-linux"));
    }
  } catch {}
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function codexLinuxNotificationActionLines(stream, onLine) {
  let buffer = "";
  stream?.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) {
      buffer = "";
      return;
    }
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") onLine(line);
      newline = buffer.indexOf("\n");
    }
  });
}

function codexLinuxCreateActionNotification(options, fallbackFactory, runtime) {
  const bridgePath = runtime?.bridgePath ?? codexLinuxNotificationActionsNativePath();
  if (bridgePath == null) return null;

  const handlers = new Map();
  let child = null;
  let fallback = null;
  let mode = "idle";
  let shown = false;
  let closed = false;
  let closeRequested = false;
  let stderr = "";

  const callHandler = (event, ...args) => {
    try {
      handlers.get(event)?.(...args);
    } catch (error) {
      console.warn("[linux-notification-actions] notification callback failed", error);
    }
  };
  const emitClose = () => {
    if (closed) return;
    closed = true;
    callHandler("close", undefined);
  };
  const startFallback = () => {
    if (closed || mode === "fallback") return;
    if (closeRequested) {
      try {
        child?.kill();
      } catch {}
      emitClose();
      return;
    }
    mode = "fallback";
    try {
      child?.kill();
    } catch {}
    fallback = fallbackFactory();
    for (const [event, handler] of handlers) fallback.on(event, handler);
    fallback.show();
  };
  const handleLine = (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (mode !== "bridge") return;
    if (closeRequested && event?.event !== "closed" && event?.event !== "unavailable") return;
    switch (event?.event) {
      case "shown":
        shown = true;
        return;
      case "click":
        callHandler("click", undefined);
        return;
      case "action":
        if (Number.isInteger(event.index) && event.index >= 0 && event.index < options.actions.length) {
          callHandler("action", undefined, event.index);
        }
        return;
      case "closed":
        emitClose();
        return;
      case "unavailable":
        startFallback();
        return;
    }
  };

  return {
    show: () => {
      if (closed || closeRequested || mode !== "idle") return;
      mode = "bridge";
      try {
        const spawn = runtime?.spawn ?? require("node:child_process").spawn;
        child = spawn(bridgePath, [], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        startFallback();
        return;
      }
      codexLinuxNotificationActionLines(child.stdout, handleLine);
      // An EPIPE can arrive before the child stdout stream is fully drained.
      // Keep the listener to avoid an unhandled stream error, but let the
      // ChildProcess "close" event make the lifecycle decision after stdio closes.
      child.stdin?.on?.("error", () => {});
      child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      });
      child.once("error", () => {
        if (!shown) startFallback();
        else emitClose();
      });
      child.once("close", (code) => {
        if (mode !== "bridge" || closed) return;
        if (!shown) {
          if (stderr.trim()) {
            console.warn("[linux-notification-actions] bridge unavailable; using Electron notification");
          }
          startFallback();
        } else {
          if (code !== 0 && stderr.trim()) {
            console.warn("[linux-notification-actions] bridge exited unexpectedly");
          }
          emitClose();
        }
      });
      child.stdin.write(
        `${JSON.stringify({
          title: String(options.title ?? ""),
          body: String(options.body ?? ""),
          actions: options.actions.map((action) => String(action?.text ?? "")),
        })}\n`,
      );
    },
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    close: () => {
      if (closed || closeRequested) return;
      if (mode === "fallback") {
        fallback?.close();
        closed = true;
        return;
      }
      closeRequested = true;
      if (mode === "idle") {
        emitClose();
        return;
      }
      try {
        child?.stdin?.end("close\n");
      } catch {
        emitClose();
      }
    },
  };
}

function bridgeSource() {
  return [
    `var codexLinuxNotificationActionsPatch=${JSON.stringify(PATCH_MARKER)};`,
    // Give Electron a Linux desktop identity so native notifications (and
    // window app_id) resolve to the installed desktop file instead of falling
    // back to the process name "electron" in Plasma/GNOME notification popups.
    `try{require("electron").app.setDesktopName("codex-desktop")}catch(e){}`,
    codexLinuxNotificationActionsNativePath,
    codexLinuxNotificationActionLines,
    codexLinuxCreateActionNotification,
  ]
    .map(String)
    .join("");
}

function applyLinuxNotificationActionsPatch(source) {
  if (source.includes(PATCH_MARKER)) return source;

  const factoryPattern =
    /e\.createNotification\?this\.createNotification=e\.createNotification:this\.createNotification=e=>\{let ([A-Za-z_$][\w$]*)=new ([A-Za-z_$][\w$]*)\.Notification\(e\);return\{show:\(\)=>\1\.show\(\),on:\(e,n\)=>\{switch\(e\)\{case`action`:return \1\.on\(`action`,\(e,t\)=>\{n\(e,t\)\}\);case`click`:return \1\.on\(`click`,\(\)=>\{n\(void 0\)\}\);case`close`:return \1\.on\(`close`,\(\)=>\{n\(void 0\)\}\)\}\},close:\(\)=>\1\.close\(\)\}\}/u;
  const match = factoryPattern.exec(source);
  if (match == null) {
    console.warn(
      "WARN: Could not find desktop notification factory - skipping Linux notification actions patch",
    );
    return source;
  }

  const originalFactory = match[0];
  const electronAlias = match[2];
  const fallbackBody = originalFactory.slice(originalFactory.indexOf("e=>") + 3);
  const replacement =
    "e.createNotification?this.createNotification=e.createNotification:this.createNotification=e=>{" +
    `let codexLinuxNotificationFallback=()=>${fallbackBody};` +
    "if(process.platform===`linux`&&Array.isArray(e.actions)&&e.actions.length>0){" +
    "let t=codexLinuxCreateActionNotification(e,codexLinuxNotificationFallback);if(t!=null)return t}" +
    "return codexLinuxNotificationFallback()}";
  const patched = `${bridgeSource()}${source.replace(factoryPattern, replacement)}`;

  if (
    !patched.includes("codexLinuxCreateActionNotification(e,codexLinuxNotificationFallback)") ||
    !patched.includes(`new ${electronAlias}.Notification(e)`)
  ) {
    console.warn("WARN: Linux notification actions patch verification failed");
    return source;
  }
  return patched;
}

module.exports = {
  PATCH_MARKER,
  applyLinuxNotificationActionsPatch,
  codexLinuxCreateActionNotification,
  codexLinuxNotificationActionLines,
};
