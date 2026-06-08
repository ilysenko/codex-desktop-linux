"use strict";

const {
  applyLinuxMarketplaceCatalogKindPatch,
} = require("../../../../webview-assets.js");

module.exports = [
  {
    id: "linux-plugin-marketplace-catalog-kinds",
    phase: "webview-asset",
    order: 1045,
    ciPolicy: "optional",
    pattern: /^use-plugins-.*\.js$/,
    missingDescription: "plugin marketplace bundle",
    skipDescription: "unsupported vertical marketplace catalog patch",
    apply: applyLinuxMarketplaceCatalogKindPatch,
  },
];
