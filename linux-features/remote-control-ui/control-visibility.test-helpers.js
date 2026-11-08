"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./fixtures/current-control-connections-visibility.json");
const { fixtureSources: entrySources, chunk } = require("./visibility.test-helpers.js");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
function fixtureSources() {
  const sources = entrySources();
  for (const [index, row] of fixture.roles.visibility.entries()) sources[`async/visibility-${index}.js`] =
    chunk(101 + index, `${row.moduleId}(${row.params}){${row.moduleSource}}`);
  const row = fixture.roles.catalog[0];
  sources["async/catalog.js"] = chunk(110, `${row.moduleId}(${row.params}){${row.moduleSource}}`);
  return sources;
}
function snapshots(sources = fixtureSources(), ids = {}) {
  const modules = Object.entries(sources).flatMap(([name, text]) => [...rspackModuleFactories(text, name)]);
  return Object.fromEntries(Object.entries(fixture.roles).map(([role, copies]) =>
    [role, modules.filter(copy => copy.moduleId === (ids[copies[0].moduleId] ?? copies[0].moduleId))]));
}
function writeApp(app, sources = fixtureSources()) {
  const assets = path.join(app, "webview/assets");
  for (const [name, text] of Object.entries(sources)) {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return assets;
}
module.exports = { fixture, fixtureSources, snapshots, writeApp };
