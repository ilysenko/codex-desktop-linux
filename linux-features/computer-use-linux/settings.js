"use strict";

const path = require("node:path");
const { findUniqueRspackModuleCopies, patchRspackModuleCopies } = require("../../scripts/patches/lib/rspack-module-assets.js");
const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const { findRspackExportPublication } = require("../../scripts/patches/lib/rspack-export-publication.js");

const IDENTIFIER = "[A-Za-z_$][\\w$]*";
const AVAILABILITY_MARKER = "/* linux-native-settings-availability */";

function availabilityOwner(source, index) {
  let owner = null;
  for (const match of source.matchAll(/function [A-Za-z_$][\w$]*\([^)]*\)\{/g)) {
    if (match.index > index) break;
    const end = findMatchingBrace(source, match.index + match[0].length - 1);
    if (end > index) owner = source.slice(match.index, end + 1);
  }
  return owner;
}

function nativeSettingsAvailabilityState(source) {
  if (source.includes("BundledMarketplaceDonor")) return { kind: "invalid" };
  // The current settings page calls Rspack-imported hooks with a memoized
  // selected-host argument. Keep that argument and every consumer unchanged.
  const pattern = new RegExp(
    `(?<setup>let (?<availability>${IDENTIFIER})=\\(0,${IDENTIFIER}\\.${IDENTIFIER}\\)\\(${IDENTIFIER}\\),` +
    `\\{platform:(?<platform>${IDENTIFIER})\\}=\\(0,${IDENTIFIER}\\.${IDENTIFIER}\\)\\(\\))` +
    `(?:,|(?<patched>;/\\* linux-native-settings-availability \\*/` +
    `if\\(\\k<platform>==="linux"\\)\\k<availability>=\\{\\.\\.\\.\\k<availability>,` +
    `available:!0,isFetching:!1,isLoading:!1\\};let ))(?<next>${IDENTIFIER})=`,
    "g",
  );
  const matches = [...source.matchAll(pattern)].filter(match => {
    const owner = availabilityOwner(source, match.index);
    return owner != null && owner.includes(`computerUseAvailability:${match.groups.availability}`) &&
      owner.includes(`${match.groups.availability}.available`);
  });
  const patchedCount = matches.filter(match => match.groups.patched != null).length;
  if (matches.length !== 1 || source.split(AVAILABILITY_MARKER).length - 1 !== patchedCount) {
    return { kind: "invalid" };
  }
  return { kind: patchedCount === 1 ? "patched" : "current", match: matches[0] };
}

function matchesNativeSettingsAvailabilityContract(source) {
  return nativeSettingsAvailabilityState(source).kind !== "invalid";
}

// The native component owns the existing plugin toggle; unified-computer-use
// owns transport. Never invent an installed/enabled Settings row.
function applyNativeSettingsAvailabilityPatch(source) {
  const state = nativeSettingsAvailabilityState(source);
  if (state.kind === "invalid") {
    throw new Error("Linux native Settings availability contract missing or ambiguous");
  }
  if (state.kind === "patched") return source;
  const { match } = state;
  const { setup, availability, platform, next } = match.groups;
  const replacement = `${setup};${AVAILABILITY_MARKER}if(${platform}==="linux")${availability}={...${availability},available:!0,isFetching:!1,isLoading:!1};let ${next}=`;
  return source.slice(0, match.index) + replacement + source.slice(match.index + match[0].length);
}

// Apply at the Plugins presentation filter, not the bundled registry's hidden
// flag: that flag drops the component from the shared Settings query too.
// rspack may emit this module into several lazily loaded chunks; every copy
// carries the same contract and is patched independently.
const NATIVE_SETTINGS_VISIBILITY_MARKER = "/* linux-native-settings-component */";
const NATIVE_SETTINGS_VISIBILITY_NEEDLES = ['"built by openai"', '"chatgpt official"'];

function nativeSettingsVisibilityState(source) {
  const marker = NATIVE_SETTINGS_VISIBILITY_MARKER;
  const pattern = /function(?: (?<fn>[\w$]+))?\((?<plugins>[\w$]+),(?<hidden>[\w$]+),(?<restrictedMode>[\w$]+)\)\{(?:if\(0===\k<hidden>\.length&&!\k<restrictedMode>\)return \k<plugins>;|(?<patched>\/\* linux-native-settings-component \*\/))let (?<set>[\w$]+)=new Set\(\k<hidden>\);return \k<plugins>\.filter\((?<entry>[\w$]+)=>(?<exclusion>!\("openai-bundled"===\k<entry>\.marketplaceName&&"computer-use"===\k<entry>\.plugin\.name\)&&)?\(!\k<restrictedMode>\|\|!(?<restricted>\(0,[\w$]+\.[\w$]+\))\(\k<entry>\.plugin\.id\)\)&&!\k<set>\.has\(\k<entry>\.plugin\.id\)\)\}/g;
  const matches = [...source.matchAll(pattern)];
  const markerCount = source.split(marker).length - 1;
  const patchedCount = matches.filter((match) => match.groups.patched != null).length;
  if (matches.length !== 1 || markerCount !== patchedCount ||
      matches.some((match) => (match.groups.patched != null) !== (match.groups.exclusion != null))) {
    return { kind: "invalid" };
  }
  return {
    kind: patchedCount === 1 ? "patched" : "current",
    match: matches[0],
    marker,
  };
}

function matchesNativeSettingsVisibilityContract(source) {
  return nativeSettingsVisibilityState(source).kind !== "invalid";
}

function applyNativeSettingsVisibilityPatch(source) {
  const state = nativeSettingsVisibilityState(source);
  if (state.kind === "invalid") {
    throw new Error("Linux native Settings visibility contract missing or ambiguous");
  }
  if (state.kind === "patched") return source;
  const { match, marker } = state;
  const { fn, plugins, hidden, restrictedMode, set, entry, restricted } = match.groups;
  const replacement = `function${fn ? ` ${fn}` : ""}(${plugins},${hidden},${restrictedMode}){${marker}let ${set}=new Set(${hidden});return ${plugins}.filter(${entry}=>!("openai-bundled"===${entry}.marketplaceName&&"computer-use"===${entry}.plugin.name)&&(!${restrictedMode}||!${restricted}(${entry}.plugin.id))&&!${set}.has(${entry}.plugin.id))}`;
  const patched = source.slice(0, match.index) + replacement +
    source.slice(match.index + match[0].length);
  if (nativeSettingsVisibilityState(patched).kind !== "patched") {
    throw new Error("Linux native Settings visibility contract missing or ambiguous");
  }
  return patched;
}

function matchesNativeSettingsVisibilityModule(moduleSource, snapshot) {
  const state = nativeSettingsVisibilityState(moduleSource);
  if (state.kind === "invalid" || !NATIVE_SETTINGS_VISIBILITY_NEEDLES.every(needle => moduleSource.includes(needle)) ||
      !moduleSource.includes('"plugins-connected"') || !moduleSource.includes('"plugins-featured"')) return false;
  if (state.match.groups.fn != null) return false;
  const key = new RegExp(`(${IDENTIFIER}):$`, "u").exec(moduleSource.slice(0, state.match.index));
  if (!key) return false;
  const publication = findRspackExportPublication({ ...snapshot, moduleSource }, key[1]);
  return publication?.fn?.start === state.match.index && publication.fn.end === state.match.index + state.match[0].length;
}

function applyNativeSettingsVisibilityAssets(extractedDir) {
  const assets = path.join(extractedDir, "webview", "assets");
  const copies = findUniqueRspackModuleCopies(assets, {
    sourceMatch: source => NATIVE_SETTINGS_VISIBILITY_NEEDLES.every(needle => source.includes(needle)),
    matchModule: matchesNativeSettingsVisibilityModule,
    description: "native Settings plugin presentation owner",
  });
  const result = patchRspackModuleCopies(assets, copies, (moduleSource, snapshot) => {
    if (!matchesNativeSettingsVisibilityModule(moduleSource, snapshot)) {
      throw new Error("Linux native Settings visibility module contract missing or partially applied");
    }
    return applyNativeSettingsVisibilityPatch(moduleSource);
  });
  return { ...result, reason: `Native Settings presentation module ${result.moduleId}: ${result.matched} copies` };
}

module.exports = {
  NATIVE_SETTINGS_VISIBILITY_NEEDLES,
  applyNativeSettingsAvailabilityPatch,
  applyNativeSettingsVisibilityPatch,
  applyNativeSettingsVisibilityAssets,
  matchesNativeSettingsAvailabilityContract,
  matchesNativeSettingsVisibilityContract,
};
