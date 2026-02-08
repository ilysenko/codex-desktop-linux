// linux-updater.js — Linux update mechanism for Codex Desktop
// Injected into app.asar by install.sh, loaded via require() in main.js
// Provides: update checking, IPC handling, menu patching, background checks

"use strict";

if (process.platform !== "linux") {
  // Only activate on Linux — on macOS, Sparkle handles updates
  return;
}

const { app, ipcMain, dialog, Menu, BrowserWindow } = require("electron");
const https = require("https");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");

const APPCAST_URL =
  "https://persistent.oaistatic.com/codex-app-prod/appcast.xml";
const CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

let currentBuildNumber = null;
let updateAvailable = false;
let latestRemoteBuild = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstallerPath() {
  // Prefer the env var exported by start.sh
  if (process.env.CODEX_LINUX_INSTALLER_PATH) {
    return process.env.CODEX_LINUX_INSTALLER_PATH;
  }
  // Fallback: assume install.sh is two levels up from the app directory
  const appDir = path.dirname(app.getAppPath());
  return path.resolve(appDir, "..", "..", "install.sh");
}

function getCurrentBuildNumber() {
  if (currentBuildNumber !== null) return currentBuildNumber;
  try {
    const pkgPath = path.join(app.getAppPath(), "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    currentBuildNumber = parseInt(pkg.codexBuildNumber, 10) || 0;
  } catch (_e) {
    currentBuildNumber = 0;
  }
  return currentBuildNumber;
}

function fetchAppcast() {
  return new Promise((resolve, reject) => {
    https
      .get(APPCAST_URL, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Appcast HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function parseRemoteBuild(xml) {
  // Look for <sparkle:version>NNN</sparkle:version>
  const match = xml.match(/<sparkle:version>(\d+)<\/sparkle:version>/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Core update check
// ---------------------------------------------------------------------------

async function checkForUpdates(opts) {
  const silent = opts && opts.silent;
  const local = getCurrentBuildNumber();

  let xml;
  try {
    xml = await fetchAppcast();
  } catch (err) {
    if (!silent) {
      dialog.showMessageBox({
        type: "error",
        title: "Update Check Failed",
        message: `Could not reach the update server.\n\n${err.message}`,
      });
    }
    return { isUpdateAvailable: false };
  }

  const remote = parseRemoteBuild(xml);
  if (remote === null) {
    if (!silent) {
      dialog.showMessageBox({
        type: "error",
        title: "Update Check Failed",
        message: "Could not parse the update feed.",
      });
    }
    return { isUpdateAvailable: false };
  }

  latestRemoteBuild = remote;

  if (remote > local) {
    updateAvailable = true;
    notifyRendererUpdateReady();
    if (!silent) {
      promptInstallUpdate(local, remote);
    }
    return { isUpdateAvailable: true };
  }

  if (!silent) {
    dialog.showMessageBox({
      type: "info",
      title: "No Updates Available",
      message: `You are running the latest version (build ${local}).`,
    });
  }
  return { isUpdateAvailable: false };
}

// ---------------------------------------------------------------------------
// Notify renderer
// ---------------------------------------------------------------------------

function notifyRendererUpdateReady() {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send("codex_desktop:message-for-view", {
        type: "app-update-ready-changed",
        isUpdateReady: true,
      });
    } catch (_e) {
      // Window might be destroyed
    }
  }
}

// ---------------------------------------------------------------------------
// Install flow
// ---------------------------------------------------------------------------

function promptInstallUpdate(local, remote) {
  const installerPath = getInstallerPath();
  const installerExists = fs.existsSync(installerPath);

  dialog
    .showMessageBox({
      type: "info",
      title: "Update Available",
      message: `A new version is available (build ${remote}, current: ${local}).`,
      detail: installerExists
        ? "Would you like to install the update now? The app will restart."
        : `Update available, but installer not found at:\n${installerPath}\n\nPlease re-run install.sh manually.`,
      buttons: installerExists
        ? ["Install & Restart", "Later"]
        : ["OK"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (installerExists && response === 0) {
        runInstaller(installerPath);
      }
    });
}

function runInstaller(installerPath) {
  // Delete cached DMG so it re-downloads the new version
  const dmgPath = path.resolve(path.dirname(installerPath), "Codex.dmg");
  try {
    fs.unlinkSync(dmgPath);
  } catch (_e) {
    // May not exist
  }

  // Run install.sh --force detached
  const child = execFile("bash", [installerPath, "--force"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Relaunch after a short delay to let the installer start
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 1000);
}

// ---------------------------------------------------------------------------
// IPC: register codex_desktop:check-for-updates handler
// ---------------------------------------------------------------------------

// This handler is never registered on Linux because Ice.initialize() returns
// early when enableSparkle is false. We register it ourselves.
app.whenReady().then(() => {
  try {
    ipcMain.handle("codex_desktop:check-for-updates", async () => {
      return checkForUpdates({ silent: false });
    });
  } catch (_e) {
    // Handler may already be registered in some future version
  }
});

// ---------------------------------------------------------------------------
// IPC: intercept install-app-update from renderer
// ---------------------------------------------------------------------------

const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function patchedHandle(channel, handler) {
  if (channel === "codex_desktop:message-from-view") {
    // Wrap the handler to intercept install-app-update messages
    const wrappedHandler = async (event, message) => {
      if (message && message.type === "install-app-update") {
        const installerPath = getInstallerPath();
        if (fs.existsSync(installerPath)) {
          runInstaller(installerPath);
        } else {
          dialog.showMessageBox({
            type: "error",
            title: "Update Failed",
            message: `Installer not found at:\n${installerPath}\n\nPlease re-run install.sh manually.`,
          });
        }
        return;
      }
      // Pass through to original handler
      return handler(event, message);
    };
    return originalHandle(channel, wrappedHandler);
  }
  return originalHandle(channel, handler);
};

// ---------------------------------------------------------------------------
// Menu: patch "Check for Updates" menu item
// ---------------------------------------------------------------------------

const originalSetAppMenu = Menu.setApplicationMenu.bind(Menu);
Menu.setApplicationMenu = function patchedSetApplicationMenu(menu) {
  if (menu) {
    patchMenuItems(menu.items);
  }
  return originalSetAppMenu(menu);
};

function patchMenuItems(items) {
  if (!items) return;
  for (const item of items) {
    if (
      item.label &&
      item.label.toLowerCase().includes("check for update")
    ) {
      item.enabled = true;
      item.click = () => {
        checkForUpdates({ silent: false });
      };
    }
    if (item.submenu && item.submenu.items) {
      patchMenuItems(item.submenu.items);
    }
  }
}

// ---------------------------------------------------------------------------
// Background update checks (every 15 minutes)
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  // Initial check after a short delay (let the app finish loading)
  setTimeout(() => {
    checkForUpdates({ silent: true });
  }, 30000); // 30 seconds after launch

  setInterval(() => {
    checkForUpdates({ silent: true });
  }, CHECK_INTERVAL_MS);
});
