"use strict";

const { escapeRegExp, findMatchingBrace } = require("../../scripts/patches/lib/minified-js.js");

const ID = "[A-Za-z_$][\\w$]*";

function enclosingOwner(source, index) {
  let owner = null;
  for (const match of source.matchAll(/function [A-Za-z_$][\w$]*\([^)]*\)\{/g)) {
    if (match.index > index) break;
    const end = findMatchingBrace(source, match.index + match[0].length - 1);
    if (end > index) owner = source.slice(match.index, end + 1);
  }
  return owner;
}

function hostPlatformState(source) {
  // Match the current inline availability evaluator, preserving every rollout,
  // loading, policy, and enabled gate. Only its platform input is widened.
  const pattern = new RegExp(
    `function\\(\\{areRequirementsPending:(?<pending>${ID}),areRequiredFeaturesEnabled:(?<features>${ID}),` +
    `enabled:(?<enabled>${ID}),isBrowserAndComputerUseAllowed:(?<allowed>${ID}),` +
    `isAnyFeatureLoading:(?<loading>${ID}),isComputerUseGateEnabled:(?<gate>${ID}),` +
    `isHostCompatiblePlatform:(?<compatible>${ID}),isPlatformLoading:(?<platformLoading>${ID}),windowType:(?<window>${ID})\\}\\)` +
    `\\{(?<body>[^{}]+)\\}\\(\\{areRequirementsPending:${ID},areRequiredFeaturesEnabled:${ID},enabled:${ID},` +
    `isBrowserAndComputerUseAllowed:${ID},isAnyFeatureLoading:${ID},isComputerUseGateEnabled:${ID},` +
    `isHostCompatiblePlatform:(?<expression>[^,{}]+),isPlatformLoading:(?<platformPending>${ID}),windowType:"electron"\\}\\)`,
    "g",
  );
  const matches = [...source.matchAll(pattern)].filter(match => {
    const owner = enclosingOwner(source, match.index);
    return owner != null && /featureName:"computer_use",hostId:[A-Za-z_$][\w$]*/.test(owner);
  });
  if (matches.length !== 1) return { kind: "invalid" };
  const match = matches[0];
  const { pending, features, enabled, allowed, loading, gate, compatible, platformLoading, window, body, expression } = match.groups;
  const expectedBody = `return ${enabled}?"electron"!==${window}?"window-type-disabled":${pending}?"loading":` +
    `${allowed}?${gate}?${platformLoading}?"loading":${compatible}?${loading}?"loading":${features}?"available":` +
    '"config-requirement-disabled":"unsupported-platform":"statsig-disabled":"config-requirement-disabled":"disabled"';
  if (body !== expectedBody) return { kind: "invalid" };
  const pristine = new RegExp(`^"macOS"===(${ID})\\|\\|"windows"===\\1$`).exec(expression);
  const patched = new RegExp(`^"linux"===(${ID})\\|\\|"macOS"===\\1\\|\\|"windows"===\\1$`).exec(expression);
  const platform = (pristine ?? patched)?.[1];
  if (platform == null) return { kind: "invalid" };
  const owner = enclosingOwner(source, match.index);
  const platformBindings = [...owner.matchAll(new RegExp(
    `\\{isLoading:(?<pending>${ID}),platform:${escapeRegExp(platform)}\\}=\\(0,${ID}\\.${ID}\\)\\(\\)`, "g"))];
  if (platformBindings.length !== 1 || platformBindings[0].groups.pending !== match.groups.platformPending) {
    return { kind: "invalid" };
  }
  return { kind: patched != null ? "patched" : "current", match, platform };
}

function matchesLinuxComputerUseHostPlatformContract(source) {
  return hostPlatformState(source).kind !== "invalid";
}

function applyLinuxComputerUseHostPlatformPatch(source) {
  const state = hostPlatformState(source);
  if (state.kind === "invalid") throw new Error("Linux Computer Use host-platform contract missing or ambiguous");
  if (state.kind === "patched") return source;
  const { match, platform } = state;
  const prefix = "isHostCompatiblePlatform:";
  const index = match.index + match[0].lastIndexOf(prefix) + prefix.length;
  return source.slice(0, index) + `"linux"===${platform}||` + source.slice(index);
}

module.exports = { applyLinuxComputerUseHostPlatformPatch, matchesLinuxComputerUseHostPlatformContract };
