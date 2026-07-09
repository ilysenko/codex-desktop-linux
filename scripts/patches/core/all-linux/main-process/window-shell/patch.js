"use strict";

const {
  extractedAppPatch,
  mainBundlePatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxAboutDialogPatch,
  applyLinuxApplicationMenuPatch,
  applyLinuxWindowOptionsPatch,
  applyLinuxNativeTitlebarPatch,
  applyLinuxMenuPatch,
  applyLinuxSetIconPatch,
  applyLinuxReadyToShowWindowStatePatch,
  applyLinuxResizeRepaintPatch,
  applyLinuxOpaqueBackgroundPatch,
} = require("../../../../impl/main-process/window.js");
const {
  applyLinuxFileManagerPatch,
  patchLinuxWorkerFileManagerTarget,
  applyLinuxTerminalUserPathPatch,
  applyLinuxGitOriginsSourceFallbackPatch,
} = require("../../../../impl/main-process/misc.js");
const {
  applyLinuxBuildInfoTrayPatch,
  applyLinuxTrayPatch,
  applyLinuxSingleInstancePatch,
} = require("../../../../impl/main-process/tray.js");
const { applyLinuxAvatarOverlayMousePassthroughPatch } = require("../../../../impl/avatar-overlay.js");

module.exports = [
  mainBundlePatch({
    id: "linux-about-dialog",
    phase: "main-bundle",
    order: 55,
    ciPolicy: "optional",
    apply: (source, context) => applyLinuxAboutDialogPatch(source, context.iconPathExpression),
  }),
  mainBundlePatch({
    id: "linux-window-options",
    phase: "main-bundle",
    order: 50,
    ciPolicy: "required-upstream",
    apply: (source, context) => applyLinuxWindowOptionsPatch(source, context.iconAsset),
  }),
  mainBundlePatch({
    id: "linux-menu",
    phase: "main-bundle",
    order: 60,
    ciPolicy: "optional",
    apply: applyLinuxMenuPatch,
  }),
  mainBundlePatch({
    id: "linux-application-menu",
    phase: "main-bundle",
    order: 65,
    ciPolicy: "optional",
    apply: applyLinuxApplicationMenuPatch,
  }),
  mainBundlePatch({
    id: "linux-native-titlebar",
    phase: "main-bundle",
    order: 85,
    ciPolicy: "required-upstream",
    apply: applyLinuxNativeTitlebarPatch,
  }),
  mainBundlePatch({
    id: "linux-set-icon",
    phase: "main-bundle",
    order: 70,
    ciPolicy: "optional",
    apply: (source, context) => applyLinuxSetIconPatch(source, context.iconAsset),
  }),
  mainBundlePatch({
    id: "linux-ready-to-show-window-state",
    phase: "main-bundle",
    order: 75,
    ciPolicy: "optional",
    apply: applyLinuxReadyToShowWindowStatePatch,
  }),
  mainBundlePatch({
    id: "linux-resize-repaint",
    phase: "main-bundle",
    order: 78,
    ciPolicy: "optional",
    apply: applyLinuxResizeRepaintPatch,
  }),
  mainBundlePatch({
    id: "linux-opaque-background",
    phase: "main-bundle",
    order: 80,
    ciPolicy: "required-upstream",
    apply: applyLinuxOpaqueBackgroundPatch,
  }),
  mainBundlePatch({
    id: "linux-avatar-overlay-mouse-passthrough",
    phase: "main-bundle",
    order: 90,
    ciPolicy: "required-upstream",
    apply: applyLinuxAvatarOverlayMousePassthroughPatch,
  }),
  mainBundlePatch({
    id: "linux-file-manager",
    phase: "main-bundle",
    order: 100,
    ciPolicy: "optional",
    apply: applyLinuxFileManagerPatch,
  }),
  extractedAppPatch({
    id: "linux-worker-file-manager",
    phase: "extracted-app:pre-webview",
    order: 101,
    ciPolicy: "optional",
    apply: patchLinuxWorkerFileManagerTarget,
    status: (result, warnings) => {
      if (result?.changed) {
        return warnings.length > 0 ? "applied-with-warnings" : "applied";
      }
      if (warnings.length > 0 || result?.matched === 0 || result?.reason != null) {
        return { status: "skipped-optional", reason: result?.reason ?? warnings[0] };
      }
      return "already-applied";
    },
  }),
  mainBundlePatch({
    id: "linux-terminal-user-path",
    phase: "main-bundle",
    order: 105,
    ciPolicy: "optional",
    apply: applyLinuxTerminalUserPathPatch,
  }),
  mainBundlePatch({
    id: "linux-tray",
    phase: "main-bundle",
    order: 110,
    ciPolicy: "required-upstream",
    apply: (source, context) => applyLinuxTrayPatch(source, context.iconPathExpression),
  }),
  mainBundlePatch({
    id: "linux-build-info-tray",
    phase: "main-bundle",
    order: 115,
    ciPolicy: "optional",
    apply: applyLinuxBuildInfoTrayPatch,
  }),
  mainBundlePatch({
    id: "linux-single-instance",
    phase: "main-bundle",
    order: 120,
    ciPolicy: "optional",
    apply: applyLinuxSingleInstancePatch,
  }),
  mainBundlePatch({
    id: "linux-git-origins-source-fallback",
    phase: "main-bundle",
    order: 240,
    ciPolicy: "optional",
    apply: applyLinuxGitOriginsSourceFallbackPatch,
  }),
];
