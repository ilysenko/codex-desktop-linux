"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  extractedAppPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxBrowserUseWebviewHostRecoveryPatch,
  applyLinuxBrowserUseWebviewRemountStorePatch,
  hasCompleteLinuxBrowserUseWebviewRemountStorePatch,
} = require("../../../../impl/webview/index.js");

const STORE_PATTERN =
  /^app-initial~artifact-tab-content\.electron~app-main~appgen-settings-page~page~pull-request-r~mxek7o2y-[^.]+\.js$/u;
const HOST_PATTERN =
  /^app-initial~app-main~pull-request-route~onboarding-page~hotkey-window-thread-page~quick-cha~mo2avlln-[^.]+\.js$/u;

function findExactlyOneAsset(assetsDir, pattern) {
  const names = fs.readdirSync(assetsDir).filter((name) => pattern.test(name));
  return names.length === 1 ? names[0] : null;
}

function patchLinuxBrowserUseWebviewAttachRecoveryAssets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return {
      matched: 0,
      changed: 0,
      reason: "Browser sidebar retained-webview assets directory is absent",
    };
  }

  const storeName = findExactlyOneAsset(assetsDir, STORE_PATTERN);
  const hostName = findExactlyOneAsset(assetsDir, HOST_PATTERN);
  if (storeName == null || hostName == null) {
    return {
      matched: 0,
      changed: 0,
      reason: "Current Browser sidebar retained-webview store or host bundle is absent",
    };
  }

  const storePath = path.join(assetsDir, storeName);
  const hostPath = path.join(assetsDir, hostName);
  const storeSource = fs.readFileSync(storePath, "utf8");
  const hostSource = fs.readFileSync(hostPath, "utf8");
  const patchedStore = applyLinuxBrowserUseWebviewRemountStorePatch(storeSource);
  const patchedHost = applyLinuxBrowserUseWebviewHostRecoveryPatch(hostSource);

  if (
    !hasCompleteLinuxBrowserUseWebviewRemountStorePatch(patchedStore) ||
    !patchedHost.includes("function codexLinuxWatchBrowserWebviewAttachment(")
  ) {
    console.warn(
      "WARN: Browser webview store and host recovery seams did not patch atomically — skipping Linux attachment recovery patch",
    );
    return {
      matched: 2,
      changed: 0,
      reason: "Current Browser sidebar retained-webview seams did not patch atomically",
    };
  }

  let changed = 0;
  if (patchedStore !== storeSource) {
    fs.writeFileSync(storePath, patchedStore, "utf8");
    changed += 1;
  }
  if (patchedHost !== hostSource) {
    fs.writeFileSync(hostPath, patchedHost, "utf8");
    changed += 1;
  }
  return { matched: 2, changed };
}

module.exports = extractedAppPatch({
  id: "linux-browser-use-webview-attach-recovery",
  phase: "extracted-app:post-webview",
  order: 1094,
  ciPolicy: "optional",
  apply: patchLinuxBrowserUseWebviewAttachRecoveryAssets,
  status(result, warnings) {
    if (result?.changed) {
      return warnings.length > 0
        ? { status: "applied-with-warnings", reason: warnings[0] }
        : "applied";
    }
    if (result?.matched === 0 || result?.reason != null || warnings.length > 0) {
      return {
        status: "skipped-optional",
        reason: result?.reason ?? warnings[0],
      };
    }
    return "already-applied";
  },
  hostPattern: HOST_PATTERN,
  storePattern: STORE_PATTERN,
});
