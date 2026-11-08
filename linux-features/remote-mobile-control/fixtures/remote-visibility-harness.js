"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./current-remote-visibility.json");
const { rspackModuleFactories } = require("../../../scripts/patches/lib/rspack-module-assets.js");
function chunk(id, modules) { return `export const __rspack_esm_id=${id};export const __webpack_modules__={${modules}};`; }
function sources() {
  const files = new Map();let id = 401;
  for (const copies of Object.values(fixture.roles)) for (const copy of copies) {
    const name = copy.sourceAsset.replace("webview/assets/", ""), modules = files.get(name) ?? new Map();
    modules.set(copy.moduleId, copy);files.set(name, modules);
  }
  return Object.fromEntries([...files].map(([name, modules]) => [name,
    chunk(id++, [...modules.values()].map(copy => `${copy.moduleId}(${copy.params}){${copy.moduleSource}}`).join(","))]));
}
function snapshots(input = sources()) {
  const modules = Object.entries(input).flatMap(([name, source]) => [...rspackModuleFactories(source, name)]);
  return Object.fromEntries(Object.entries(fixture.roles).map(([role, rows]) => [role, modules.filter(copy => copy.moduleId === rows[0].moduleId)]));
}
function applyEdits(input, plan) { return { ...input, ...Object.fromEntries(plan.edits.map(edit => [edit.assetName, edit.patchedSource])) }; }
function writeApp(root, input = sources()) {
  const assets = path.join(root, "webview/assets");
  for (const [name, text] of Object.entries(input)) {
    const file = path.join(assets, name);fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, text);
  }
  return assets;
}
function readApp(root, input) { return Object.fromEntries(Object.keys(input).map(name => [name, fs.readFileSync(path.join(root, "webview/assets", name), "utf8")])); }
function combinedSources(entry) {
  const result = { ...entry }, existing = new Set(Object.entries(entry).flatMap(([name, source]) => [...rspackModuleFactories(source, name)].map(copy => copy.moduleId)));
  for (const [name, source] of Object.entries(sources())) {
    const copies = [...rspackModuleFactories(source, name)].filter(copy => !existing.has(copy.moduleId));
    if (!copies.length) continue;
    if (result[name]) throw Error("fixture asset collision");
    result[name] = chunk(499, copies.map(copy => `${copy.moduleId}(${copy.params}){${copy.moduleSource}}`).join(","));
  }
  return result;
}
function installIntoExistingApp(root, visibilityNames = []) {
  const assets = path.join(root, "webview/assets"), existing = new Set();
  for (const name of fs.readdirSync(path.join(assets, "async"))) {
    const file = path.join(assets, "async", name);
    if (name.endsWith(".js") && fs.statSync(file).isFile()) for (const copy of rspackModuleFactories(fs.readFileSync(file, "utf8"), "async/" + name)) existing.add(copy.moduleId);
  }
  for (const [index, copy] of fixture.roles.visibility.entries()) {
    const name = visibilityNames[index] ?? `async/remote-visibility-${index}.js`, file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });fs.writeFileSync(file, chunk(510 + index, `${copy.moduleId}(${copy.params}){${copy.moduleSource}}`));
  }
  const dependencies = ["catalog", "gate", "gateHook"].flatMap(role => fixture.roles[role]).filter(copy => !existing.has(copy.moduleId));
  if (dependencies.length) fs.writeFileSync(path.join(assets, "async/remote-visibility-dependencies.js"), chunk(520,
    dependencies.map(copy => `${copy.moduleId}(${copy.params}){${copy.moduleSource}}`).join(",")));
}
module.exports = { fixture, sources, snapshots, applyEdits, writeApp, readApp, combinedSources, installIntoExistingApp };
