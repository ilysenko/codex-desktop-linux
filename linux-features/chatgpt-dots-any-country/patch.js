"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const CONTRACTS = Object.freeze({
  landingRoute: [{
    pattern: new RegExp(`${IDENT}\\?\\.tbo_config\\?\\.tbo_available==null`, "gu"),
    replacement: "!1",
    expected: 1,
  }],
  appShared: [{
    pattern: new RegExp(
      `${IDENT}\\.query\\.getData\\(${IDENT},(?<account>${IDENT})\\)\\?\\.accounts\\[\\k<account>\\]` +
        `\\?\\.account\\.tbo_config\\?\\.tbo_available!==!0`,
      "gu",
    ),
    replacement: "!1",
    expected: 1,
  }, {
    pattern: new RegExp(
      `${IDENT}\\?\\.accounts\\[(?<account>${IDENT})\\]\\?\\.account\\.tbo_config` +
        `\\?\\.tbo_available===!0`,
      "gu",
    ),
    replacement: "!0",
    expected: 2,
  }],
  personalization: [{
    pattern: new RegExp(
      `${IDENT}\\?\\.accounts\\[${IDENT}\\]\\?\\.account\\.tbo_config\\?\\.tbo_available!==!0`,
      "gu",
    ),
    replacement: "!1",
    expected: 2,
  }],
});

function contractState(source, replacements) {
  const matches = replacements.map((contract) => [
    ...source.matchAll(new RegExp(contract.pattern.source, contract.pattern.flags)),
  ]);
  if (matches.every((found) => found.length === 0)) return "patched";
  return matches.every((found, index) => found.length === replacements[index].expected)
    ? "pristine"
    : "invalid";
}

function applyContract(source, replacements, description) {
  const state = contractState(source, replacements);
  if (state === "patched") return source;
  if (state !== "pristine") {
    console.warn(`WARN: Could not prove the current ChatGPT Dots ${description} contract — skipping Dots patch`);
    return source;
  }
  return replacements.reduce(
    (patched, contract) => patched.replace(contract.pattern, contract.replacement),
    source,
  );
}

function applyDotsLandingRoutePatch(source) {
  return applyContract(source, CONTRACTS.landingRoute, "landing route");
}

function applyDotsAppSharedPatch(source) {
  return applyContract(source, CONTRACTS.appShared, "capability");
}

function applyDotsPersonalizationPatch(source) {
  return applyContract(source, CONTRACTS.personalization, "personalization");
}

function matchesContract(source, contracts) {
  return contractState(source, contracts) === "pristine";
}

const descriptors = [
  {
    id: "dots-landing-route",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    pattern: /^[^.]+\.js$/,
    assetMatch: (source) => matchesContract(source, CONTRACTS.landingRoute),
    missingDescription: "ChatGPT Dots landing route bundle",
    skipDescription: "ChatGPT Dots landing route patch",
    apply: applyDotsLandingRoutePatch,
  },
  {
    id: "dots-app-shared-capability",
    phase: "webview-asset",
    order: 20_901,
    ciPolicy: "optional",
    pattern: /^[^.]+\.js$/,
    assetMatch: (source) => matchesContract(source, CONTRACTS.appShared),
    missingDescription: "ChatGPT Dots capability bundle",
    skipDescription: "ChatGPT Dots capability patch",
    apply: applyDotsAppSharedPatch,
  },
  {
    id: "dots-personalization-capability",
    phase: "webview-asset",
    order: 20_902,
    ciPolicy: "optional",
    pattern: /^[^.]+\.js$/,
    assetMatch: (source) => matchesContract(source, CONTRACTS.personalization),
    missingDescription: "ChatGPT Dots personalization bundle",
    skipDescription: "ChatGPT Dots personalization patch",
    apply: applyDotsPersonalizationPatch,
  },
];

module.exports = {
  CONTRACTS,
  applyDotsAppSharedPatch,
  applyDotsLandingRoutePatch,
  applyDotsPersonalizationPatch,
  descriptors,
};
