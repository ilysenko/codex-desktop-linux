"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./fixtures/current-experimental-features.json");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
function fixtureSources() {
  const files = new Map();let id = 201;
  for (const copies of Object.values(fixture.roles)) for (const copy of copies) {
    const name = copy.sourceAsset.replace("webview/assets/", "");
    const modules = files.get(name) ?? new Map();
    if (modules.has(copy.moduleId) && modules.get(copy.moduleId).moduleSource !== copy.moduleSource) throw Error("fixture module conflict");
    modules.set(copy.moduleId, copy);files.set(name, modules);
  }
  return Object.fromEntries([...files].map(([name, modules]) => [name,
    `export const __rspack_esm_id=${id++};export const __webpack_modules__={${[...modules.values()].map(copy => `${copy.moduleId}(${copy.params}){${copy.moduleSource}}`).join(",")}};`]));
}
function snapshots(sources = fixtureSources(), ids = {}) {
  const modules = Object.entries(sources).flatMap(([name, text]) => [...rspackModuleFactories(text, name)]);
  return Object.fromEntries(Object.entries(fixture.roles).map(([role, copies]) => [role,
    modules.filter(copy => copy.moduleId === (ids[copies[0].moduleId] ?? copies[0].moduleId))]));
}
function writeApp(app, sources = fixtureSources()) {
  const assets = path.join(app, "webview/assets");
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(assets, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, text);
  }
  return assets;
}
function assetFor(role, index = 0) { return fixture.roles[role][index].sourceAsset.replace("webview/assets/", ""); }
module.exports = { fixture, fixtureSources, snapshots, writeApp, assetFor };
