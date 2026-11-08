"use strict";
const fs = require("node:fs"), path = require("node:path");
const copy = require("./current-remote-copy.json"), visibility = require("./current-remote-visibility.json"), bridge = require("./current-enablement-bridge.json");
const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
const roles = { owner: [copy.settings], gateHook: visibility.roles.gateHook, platform: [copy.platformHook], platformMap: [copy.platformMap],
  catalog: visibility.roles.catalog, pairing: [bridge.pairing], tabs: visibility.roles.visibility };
function sources() {
  return Object.fromEntries(Object.entries(roles).flatMap(([role, rows]) => rows.map((row, index) => [
    `async/outbound-${role}-${index}.js`, `export const __rspack_esm_ids=[${100 + index}];export const __webpack_modules__={${row.moduleId}(${row.params}){${row.moduleSource}}};`,
  ])));
}
function snapshots(input = sources()) {
  const copies = Object.entries(input).flatMap(([assetName, source]) => [...rspackModuleFactories(source, assetName)]);
  return Object.fromEntries(Object.entries(roles).map(([role, rows]) => [role, copies.filter(copy => copy.moduleId === rows[0].moduleId)]));
}
function transition(input, plan, key = "patchedSource") { return { ...input, ...Object.fromEntries(plan.edits.map(row => [row.assetName, row[key]])) }; }
function writeApp(root, input = sources()) {
  const assets = path.join(root, "webview/assets");
  for (const [name, text] of Object.entries(input)) { const file = path.join(assets, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, text, { mode: 0o640 }); }
  return assets;
}
function readApp(root, input = sources()) { return Object.fromEntries(Object.keys(input).map(name => [name, fs.readFileSync(path.join(root, "webview/assets", name), "utf8")])); }
function withCopySources() {
  return { ...require("./remote-copy-harness.js").sources(), ...Object.fromEntries(Object.entries(sources()).filter(([name]) => !name.includes("outbound-owner-"))) };
}
module.exports = { roles, sources, snapshots, transition, writeApp, readApp, withCopySources };
