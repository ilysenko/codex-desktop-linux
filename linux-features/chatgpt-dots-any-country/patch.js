"use strict";

const IDENT = "[A-Za-z_$][\\w$]*";
const SHARED_QUERY_STATUS =
  `(?<prefix>function ${IDENT}\\((?<owner>${IDENT})\\)\\{let (?<account>${IDENT})=` +
  `\\k<owner>\\.get\\(${IDENT}\\.chatGptAuthenticatedAccountId\\$\\);if\\(null==\\k<account>\\|\\|` +
  `null==\\k<owner>\\.get\\(${IDENT}\\.${IDENT}\\)\\|\\|` +
  `\\k<owner>\\.queryClient\\.getQueryState\\(\\k<owner>\\.query\\.snapshot\\(` +
  `(?<query>${IDENT}\\.${IDENT}),\\k<account>\\)\\.queryKey\\)\\?\\.status!=="success"\\|\\|)`;
const CONTRACTS = Object.freeze({
  landingRoute: [{
    pattern: new RegExp(
      `(?<account>${IDENT})\\?\\.tbo_config\\?\\.tbo_available==null` +
        `\\|\\|null==\\k<account>\\.structure\\|\\|null==\\k<account>\\.plan_type`,
      "gu",
    ),
    patchedPattern: new RegExp(
      `(?<account>${IDENT})\\?\\.tbo_config==null/\\*codexDotsLandingRoute\\*/` +
        `\\|\\|null==\\k<account>\\.structure\\|\\|null==\\k<account>\\.plan_type`,
      "gu",
    ),
    marker: "codexDotsLandingRoute",
    replacement: (...args) => {
      const { account } = args.at(-1);
      return `${account}?.tbo_config==null/*codexDotsLandingRoute*/||null==${account}.structure||null==${account}.plan_type`;
    },
    validate: (source, [match]) => source.split(`if(${match.groups.account}.tbo_config.tbo_available){`).length === 2,
    expected: 1,
  }],
  appShared: [{
    pattern: new RegExp(
      SHARED_QUERY_STATUS +
        `\\k<owner>\\.query\\.getData\\(\\k<query>,\\k<account>\\)\\?\\.accounts\\[\\k<account>\\]` +
        `\\?\\.account\\.tbo_config\\?\\.tbo_available!==!0`,
      "gu",
    ),
    patchedPattern: new RegExp(SHARED_QUERY_STATUS + "!1/\\*codexDotsSharedAccountGate\\*/", "gu"),
    marker: "codexDotsSharedAccountGate",
    replacement: (...args) => `${args.at(-1).prefix}!1/*codexDotsSharedAccountGate*/`,
    expected: 1,
  }, {
    pattern: new RegExp(
      `${IDENT}\\?\\.accounts\\[(?<account>${IDENT})\\]\\?\\.account\\.tbo_config` +
        `\\?\\.tbo_available===!0`,
      "gu",
    ),
    patchedPattern: /!0\/\*codexDotsSharedCapability\*\//gu,
    marker: "codexDotsSharedCapability",
    replacement: "!0/*codexDotsSharedCapability*/",
    expected: 2,
  }],
  personalization: [{
    pattern: new RegExp(
      `(?<prefix>"chatgpt"!==${IDENT}\\|\\|null==(?<account>${IDENT})\\|\\|null==${IDENT}\\|\\|)` +
        `${IDENT}\\?\\.accounts\\[\\k<account>\\]\\?\\.account\\.tbo_config\\?\\.tbo_available!==!0`,
      "gu",
    ),
    patchedPattern: new RegExp(
      `"chatgpt"!==${IDENT}\\|\\|null==${IDENT}\\|\\|null==${IDENT}\\|\\|!1/\\*codexDotsPersonalization\\*/`,
      "gu",
    ),
    marker: "codexDotsPersonalization",
    replacement: (...args) => `${args.at(-1).prefix}!1/*codexDotsPersonalization*/`,
    expected: 2,
  }],
});

function contractState(source, replacements) {
  const matches = replacements.map((contract) => [
    ...source.matchAll(new RegExp(contract.pattern.source, contract.pattern.flags)),
  ]);
  if (replacements.some(contract => contract.marker == null || contract.patchedPattern == null)) return "invalid";
  const patched = replacements.map((contract) => [
    ...source.matchAll(new RegExp(contract.patchedPattern.source, contract.patchedPattern.flags)),
  ]);
  const markers = replacements.map((contract) => source.split(contract.marker).length - 1);
  const valid = (contract, found) => contract.validate == null || contract.validate(source, found);
  if (matches.every((found) => found.length === 0) &&
      patched.every((found, index) => found.length === replacements[index].expected &&
        markers[index] === replacements[index].expected && valid(replacements[index], found))) return "patched";
  return matches.every((found, index) => found.length === replacements[index].expected &&
    patched[index].length === 0 && markers[index] === 0 && valid(replacements[index], found))
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
  if (!source.includes("tbo_config") && !contracts.some(({marker}) => marker != null && source.includes(marker))) {
    return false;
  }
  return contractState(source, contracts) !== "invalid";
}

const descriptors = [
  {
    id: "dots-landing-route",
    phase: "webview-asset",
    order: 20_900,
    ciPolicy: "optional",
    assetNeedles: [".tbo_config.tbo_available", ".structure", ".plan_type"],
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
    assetNeedles: ["chatGptAuthenticatedAccountId$", ".query.snapshot(", ".queryClient.getQueryState("],
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
    assetNeedles: ["settings.userRules.unavailable", "settings.userRules.accountLoadError"],
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
