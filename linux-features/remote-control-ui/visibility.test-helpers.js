"use strict";
const fs = require("node:fs");
const path = require("node:path");
const fixture = require("./fixtures/current-remote-connections-visibility.json");
const { rspackModuleFactories } = require("../../scripts/patches/lib/rspack-module-assets.js");
function chunk(id, body) { return `export const __rspack_esm_id=${id};export const __webpack_modules__={${body}};`; }
function fixtureSources() {
  const result = {};
  let id = 1;
  for (const [role, rows] of Object.entries(fixture.roles)) for (const [index, row] of rows.entries()) {
    result[`async/${role}-${index}.js`] = chunk(id++, `${row.moduleId}(${row.params}){${row.moduleSource}}`);
  }
  result["async/providers.js"] = chunk(id, Object.entries({ zTeN: "un", tl5a: "Dc", B81s: "I2", OWtl: "u", OMIV: "JW" })
    .map(([moduleId, key]) => `${moduleId}(x,y,z){let value={};z.d(y,{},{${key}:value})}`).join(","));
  return result;
}
function snapshots(sources = fixtureSources()) {
  const cohort = {};
  for (const [role, rows] of Object.entries(fixture.roles)) cohort[role] = Object.entries(sources).flatMap(([assetName, source]) =>
    [...rspackModuleFactories(source, assetName)].filter(row => row.moduleId === rows[0].moduleId));
  return cohort;
}
function writeFixtureApp(app, sources = fixtureSources()) {
  const assets = path.join(app, "webview/assets");
  for (const [name, source] of Object.entries(sources)) {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return assets;
}
module.exports = { fixture, chunk, fixtureSources, snapshots, writeFixtureApp };
