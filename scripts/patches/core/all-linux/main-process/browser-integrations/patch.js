"use strict";

const {
  extractedAppPatch,
  mainBundlePatch,
} = require("../../../../descriptor.js");
const { patchStatusFromChange } = require("../../../../../lib/patch-report.js");
const {
  applyBrowserUseNodeReplApprovalAssets,
  applyLinuxBundledPluginCopyPermissionsPatch,
  applyLinuxBundledPluginReconcileStaleSnapshotPatch,
  applyLinuxBrowserUseRouteLivenessPatch,
  applyLinuxBrowserUseSocketDirectoryPatch,
} = require("../../../../impl/main-process/browser.js");
const { applyLinuxChromePluginAutoInstallPatch } = require("../../../../impl/chrome-plugin.js");

module.exports = [
  mainBundlePatch({
    id: "linux-chrome-plugin-auto-install",
    phase: "main-bundle",
    order: 150,
    ciPolicy: "optional",
    apply: applyLinuxChromePluginAutoInstallPatch,
  }),
  extractedAppPatch({
    id: "browser-use-node-repl-approval",
    phase: "extracted-app:pre-webview",
    order: 160,
    ciPolicy: "optional",
    apply: applyBrowserUseNodeReplApprovalAssets,
    status: (result, warnings) => ({
      status:
        result?.matched === 0
          ? "skipped-optional"
          : patchStatusFromChange(Boolean(result?.changed), warnings, "optional"),
      reason:
        result?.matched === 0
          ? "Browser Use node_repl mcp config bundle not found"
          : warnings[0] ?? null,
    }),
  }),
  mainBundlePatch({
    id: "linux-bundled-plugin-reconcile-stale-snapshot",
    phase: "main-bundle",
    order: 164,
    ciPolicy: "optional",
    apply: applyLinuxBundledPluginReconcileStaleSnapshotPatch,
  }),
  mainBundlePatch({
    id: "linux-bundled-plugin-copy-permissions",
    phase: "main-bundle",
    order: 165,
    ciPolicy: "optional",
    apply: applyLinuxBundledPluginCopyPermissionsPatch,
  }),
  mainBundlePatch({
    id: "linux-browser-use-socket-directory",
    phase: "main-bundle",
    order: 168,
    ciPolicy: "optional",
    apply: applyLinuxBrowserUseSocketDirectoryPatch,
  }),
  mainBundlePatch({
    id: "linux-browser-use-route-liveness",
    phase: "main-bundle",
    order: 170,
    ciPolicy: "optional",
    apply: applyLinuxBrowserUseRouteLivenessPatch,
  }),
];
