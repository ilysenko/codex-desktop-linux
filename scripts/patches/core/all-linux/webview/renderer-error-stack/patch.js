"use strict";

const {
  webviewAssetPatch,
} = require("../../../../descriptor.js");
const {
  applyRendererErrorStackPreservationPatch,
} = require("../../../../impl/webview/index.js");

module.exports = [
  webviewAssetPatch({
    id: "renderer-error-stack-preservation",
    phase: "webview-asset",
    order: 1046,
    ciPolicy: "optional",
    pattern: /^app-initial~artifact-tab-content\.electron~app-main~new-thread-panel-page~onboarding-page~pr~[^.]+\.js$/,
    missingDescription: "renderer error boundary bundle",
    skipDescription: "renderer error stack preservation patch",
    apply: applyRendererErrorStackPreservationPatch,
  }),
];
