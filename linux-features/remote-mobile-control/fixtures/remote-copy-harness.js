"use strict";
const fs = require("node:fs"), path = require("node:path");
const fixture = require("./current-remote-copy.json");
const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
function sources({ settingsId = fixture.settings.moduleId } = {}) {
  return Object.fromEntries(Object.entries(fixture).map(([role, row], index) => [
    "async/remote-copy-" + role + ".js",
    `export const __rspack_esm_ids=[${role === "search" ? 948216 : index + 1}];export const __webpack_modules__={${role === "settings" ? settingsId : row.moduleId}(${row.params}){${row.moduleSource}}};`,
  ]));
}
function snapshots(input = sources(), { settingsId = fixture.settings.moduleId } = {}) {
  const copies = Object.entries(input).flatMap(([assetName, text]) => [...rspackModuleFactories(text, assetName)]);
  return Object.fromEntries(Object.entries(fixture).map(([role, row]) => [role,
    copies.filter(copy => copy.moduleId === (role === "settings" ? settingsId : row.moduleId))]));
}
function writeApp(root, input = sources()) {
  const assets = path.join(root, "webview/assets");
  for (const [name, text] of Object.entries(input)) {
    const file = path.join(assets, name);fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o640 });
  }
  return assets;
}
function installIntoExistingApp(root, options) { return writeApp(root, sources(options)); }
function readApp(root, input = sources()) {
  return Object.fromEntries(Object.keys(input).map(name => [name, fs.readFileSync(path.join(root, "webview/assets", name), "utf8")]));
}
module.exports = { fixture, sources, snapshots, writeApp, readApp, installIntoExistingApp };
