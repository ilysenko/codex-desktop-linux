"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyLinuxAppSunsetPatch,
  applyLinuxOpaqueWindowsDefaultPatch,
  applyLinuxThreadSidePanelNativeTooltipPatch,
  applyLinuxTooltipWindowControlsCollisionPatch,
  applyLinuxWindowControlsSafeAreaPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "linux-app-sunset-gate",
    phase: "webview-asset",
    order: 1000,
    ciPolicy: "required-upstream",
    pattern: /^index-.*\.js$/,
    missingDescription: "webview index bundle",
    skipDescription: "app sunset gate patch",
    apply: applyLinuxAppSunsetPatch,
  }),
  webviewAssetPatch({
    id: "opaque-window-default-general-settings",
    phase: "webview-asset",
    order: 1010,
    ciPolicy: "optional",
    pattern: /^general-settings-.*\.js$/,
    missingDescription: "general settings bundle",
    skipDescription: "translucent sidebar default patch",
    apply: applyLinuxOpaqueWindowsDefaultPatch,
  }),
  webviewAssetPatch({
    id: "opaque-window-default-webview-index",
    phase: "webview-asset",
    order: 1020,
    ciPolicy: "optional",
    pattern: /^(app-main|index)-.*\.js$/,
    missingDescription: "webview index bundle",
    skipDescription: "translucent sidebar default patch",
    apply: applyLinuxOpaqueWindowsDefaultPatch,
  }),
  webviewAssetPatch({
    id: "linux-window-controls-safe-area",
    phase: "webview-asset",
    order: 1040,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~new-thread-panel-page~appgen-library-page~hotkey-window-thread-page~ho~.*\.js$/,
    missingDescription: "window controls safe-area bundle",
    skipDescription: "Linux window controls safe-area patch",
    apply: applyLinuxWindowControlsSafeAreaPatch,
  }),
  webviewAssetPatch({
    id: "linux-tooltip-window-controls-collision",
    phase: "webview-asset",
    order: 1050,
    ciPolicy: "optional",
    pattern: /^app-initial~app-main~hotkey-window-thread-page~thread-app-shell-chrome~header~remote-conver~.*\.js$/,
    missingDescription: "tooltip bundle",
    skipDescription: "Linux tooltip titlebar collision patch",
    apply: applyLinuxTooltipWindowControlsCollisionPatch,
  }),
  webviewAssetPatch({
    id: "linux-thread-side-panel-native-tooltip",
    phase: "webview-asset",
    order: 1060,
    ciPolicy: "optional",
    pattern: /^thread-app-shell-chrome-.*\.js$/,
    missingDescription: "thread app shell chrome bundle",
    skipDescription: "Linux thread side panel native tooltip patch",
    apply: applyLinuxThreadSidePanelNativeTooltipPatch,
  }),
];
