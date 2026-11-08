"use strict";

const { Script } = require("node:vm");
const { escapeRegExp } = require("../../scripts/patches/lib/minified-js.js");
const { findUniqueRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const IDENT = "[A-Za-z_$][\\w$]*";
function fail(reason) { throw Error(`Remote connections owners: ${reason}`); }

// The native facade is intentionally mutable: bootstrap injects services after
// this module initializes. Consumers must retain the getter at their call site.
function inspectAppServicesFacade(copy) {
  if (!copy || !Array.isArray(copy.params) || copy.params.length !== 3 ||
      new Set(copy.params).size !== 3 || Buffer.byteLength(copy.moduleSource ?? "") > 1024) fail("bounded appServices facade");
  const [, exportsName, loader] = copy.params;
  const pattern = new RegExp(String.raw`^let (?<host>${IDENT}),(?<services>${IDENT});${escapeRegExp(loader)}\.r\(${escapeRegExp(exportsName)}\),${escapeRegExp(loader)}\.d\(${escapeRegExp(exportsName)},\{appHost:\(\)=>\k<host>,appServices:\(\)=>\k<services>\},\{setAppHost:function\((?<hostArg>${IDENT})\)\{\k<host>=\k<hostArg>\},setAppServices:function\((?<servicesArg>${IDENT})\)\{\k<services>=\k<servicesArg>\}\}\)$`, "u");
  const match = pattern.exec(copy.moduleSource);
  if (!match) fail("changed native late service getter/setter");
  const r = match.groups;
  if (r.host === r.services || [r.host, r.services].some(name => copy.params.includes(name)) ||
      [r.host, r.services].includes(r.hostArg) || [r.host, r.services].includes(r.servicesArg)) fail("captured facade binding");
  new Script(`function nativeRemoteFacade(${copy.params.join(",")}){${copy.moduleSource}\n}`);
  return Object.freeze({ moduleId: copy.moduleId, host: r.host, services: r.services,
    boundary: "Exact native mutable facade only; transport/bootstrap and service permissions remain upstream-owned." });
}

function locateAppServicesCopies(assetsDir, moduleId) {
  const copies = findUniqueRspackModuleCopies(assetsDir, {
    description: "native late Remote appServices facade",
    sourceMatch: source => source.includes("setAppServices") && source.includes("appServices:"),
    matchModule: (_body, copy) => {
      if (copy.moduleId !== moduleId) return false;
      try { inspectAppServicesFacade(copy); return true; } catch { return false; }
    },
  });
  for (const copy of copies) if (copy.moduleId !== moduleId) fail("wrong appServices identity");
  return copies;
}

module.exports = { inspectAppServicesFacade, locateAppServicesCopies };
