#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  APP_PAGE_ASSET_PATTERN,
  APP_PAGE_ELIGIBILITY_MARKER,
  GENERAL_SETTINGS_ASSET_PATTERN,
  HOME_CONTENT_ASSET_PATTERN,
  HOME_CONTENT_SOURCE_MARKER,
  MAIN_ELIGIBILITY_MARKER,
  RUNTIME_MARKER,
  SETTINGS_ELIGIBILITY_MARKER,
  applySuggestedPromptsAppPagePatch,
  applySuggestedPromptsHomeContentPatch,
  applySuggestedPromptsMainPatch,
  applySuggestedPromptsSettingsPatch,
  descriptors,
  suggestedPromptsEnabled,
} = require("./patches/suggested-prompts.js");

function captureWarnings(callback) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function settingsFixture() {
  return [
    "function ki(){let e=(0,Q.c)(31),t=xe(`1372061905`),n=xe(`2425897452`),r=xe(ft),i;",
    "return n?(0,$.jsx)(H,{electron:!0,children:(0,$.jsx)(ci,{})}):null}",
    "function ci(){let e=(0,li.c)(12),t=n(m),r=R(),{authMethod:i,email:a,planAtLogin:o}=We(),",
    "s=i===`chatgpt`,l,{data:d}=N(`account-info`,{queryConfig:{enabled:s}}),f=u(b.enabled);",
    "if(!M({authMethod:i,email:d?.email??a,plan:d?.plan??o}))return null;return row()}",
  ].join("");
}

function appPageFixture() {
  return [
    "function home(){let we=es(`2425897452`),Te=es(`1857002365`),",
    "ke=ln({authMethod:_,email:j?.email??v,plan:be}),Ae=we&&ke,je=N?null:B;",
    "return jsx(bF,{generatedSuggestionsEnabled:Ae,projectRoot:je})}",
    "function sync(){let n=es(`2425897452`),r=es(`1304276663`);",
    "dispatchMessage(`electron-desktop-features-changed`,{ambientSuggestions:n,appshotsEnabled:r})}",
  ].join("");
}

function mainFixture() {
  return [
    "function nt(e){return Xe().ambientSuggestions&&e.getEffective(n.oa.enabled.key)===!0}",
    "async function rt({appServerConnection:e,settingsStore:t}){",
    "if(!nt(t))return{enabled:!1,staleTimeMs:n.ml(null)};let r=await e.getAccount();",
    "return{enabled:n.pl(r.account),staleTimeMs:n.ml(r.account)}}",
  ].join("");
}

function homeContentFixture() {
  return [
    "function ua({generatedSuggestionsEnabled:i,projectRoot:l}){",
    "let Ee=d(b.enabled)===!0,De=a(jn),Oe=a(fn),Me=i&&l!=null,",
    "Ne=De==null&&Me&&Ee,{data:Pe,isLoading:Fe}=rr({enabled:Ne}),",
    "ze=Ne&&(Fe||Le&&P)?null:ir({debugOverride:De,experimentEligible:Le,personalized:Re}),",
    "z=ze===`curated`,Be=ln(ye.email),Ve=ar({canUsePersonalizedSuggestions:Ee,",
    "generatedSuggestionsEnabled:Me,hasGeneratedSuggestionsReadSettled:x,",
    "shouldUseCuratedNewChatPageSuggestions:z});return Ve}",
  ].join("");
}

function featureContext({ defaultEnabled = false, override } = {}) {
  return {
    feature: {
      manifest: {
        tweaks: { home: { suggestedPrompts: { enabled: defaultEnabled } } },
      },
      settings: override == null
        ? {}
        : { tweaks: { home: { suggestedPrompts: { enabled: override } } } },
    },
  };
}

test("Suggested Prompts stays disabled unless its nested UI tweak is enabled", () => {
  assert.equal(suggestedPromptsEnabled(featureContext()), false);
  assert.equal(suggestedPromptsEnabled(featureContext({ override: true })), true);
  assert.equal(suggestedPromptsEnabled(featureContext({ defaultEnabled: true, override: false })), false);
  assert.equal(descriptors.every((descriptor) => descriptor.enabled(featureContext()) === false), true);
  assert.equal(
    descriptors.every((descriptor) => descriptor.enabled(featureContext({ override: true })) === true),
    true,
  );
});

test("settings patch exposes the upstream row while preserving eligibility diagnostics", () => {
  const source = settingsFixture();
  const patched = applySuggestedPromptsSettingsPatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(RUNTIME_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(new RegExp(SETTINGS_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.match(patched, /xe\(`2425897452`\)/);
  assert.match(
    patched,
    /if\(!\(M\(\{authMethod:i,email:d\?\.email\?\?a,plan:d\?\.plan\?\?o\}\)\|\|function codexLinuxUiTweaksSuggestedPromptsSettingsEligible\(\)\{return!0\}\(\)\)\)return null/,
  );
  assert.equal(applySuggestedPromptsSettingsPatch(patched), patched);
});

test("app page patch enables Home generation and desktop availability gates atomically", () => {
  const source = appPageFixture();
  const patched = applySuggestedPromptsAppPagePatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(RUNTIME_MARKER, "g")) || []).length, 2);
  assert.equal((patched.match(new RegExp(APP_PAGE_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(/es\(`2425897452`\)/g) || []).length, 2);
  assert.match(
    patched,
    /Ae=we&&\(ke\|\|function codexLinuxUiTweaksSuggestedPromptsAppPageEligible\(\)\{return!0\}\(\)\)/,
  );
  assert.match(patched, /ambientSuggestions:n/);
  assert.equal(applySuggestedPromptsAppPagePatch(patched), patched);
});

test("main patch enables refresh while preserving the upstream account call", () => {
  const source = mainFixture();
  const patched = applySuggestedPromptsMainPatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(MAIN_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.match(patched, /n\.pl\(r\.account\)/);
  assert.match(patched, /staleTimeMs:n\.ml\(r\.account\)/);
  assert.equal(applySuggestedPromptsMainPatch(patched), patched);
});

test("Home content renders generated suggestions instead of selecting curated cards", () => {
  const source = homeContentFixture();
  const patched = applySuggestedPromptsHomeContentPatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(HOME_CONTENT_SOURCE_MARKER, "g")) || []).length, 1);
  assert.match(patched, /ze===`curated`/);
  assert.match(patched, /function codexLinuxSuggestedPromptsGeneratedSource\(\)\{return!1\}/);
  assert.equal(applySuggestedPromptsHomeContentPatch(patched), patched);
});

test("multi-point patches reject mixed and drifted contracts byte-identically", () => {
  const cleanAppPage = appPageFixture();
  const patchedAppPage = applySuggestedPromptsAppPagePatch(cleanAppPage);
  const firstMarker = patchedAppPage.indexOf(RUNTIME_MARKER);
  const mixedAppPage = `${patchedAppPage.slice(0, firstMarker)}missingMarker${patchedAppPage.slice(firstMarker + RUNTIME_MARKER.length)}`;
  const mixedResult = captureWarnings(() => applySuggestedPromptsAppPagePatch(mixedAppPage));
  assert.equal(mixedResult.value, mixedAppPage);
  assert.match(mixedResult.warnings.join("\n"), /current Suggested Prompts app page contract/);

  const driftedSettings = settingsFixture().replace(
    "n=xe(`2425897452`)",
    "n=xe(`replacement-rollout`)",
  );
  const settingsResult = captureWarnings(() => applySuggestedPromptsSettingsPatch(driftedSettings));
  assert.equal(settingsResult.value, driftedSettings);
  assert.match(settingsResult.warnings.join("\n"), /current Suggested Prompts settings contract/);

  const driftedHome = homeContentFixture().replace(
    "z=ze===`curated`",
    "z=selectSuggestionSource(ze)",
  );
  const homeResult = captureWarnings(() => applySuggestedPromptsHomeContentPatch(driftedHome));
  assert.equal(homeResult.value, driftedHome);
  assert.match(homeResult.warnings.join("\n"), /current Suggested Prompts Home generated-source contract/);
});

test("unrecognized contracts warn instead of reporting false already-applied", () => {
  const cases = [
    [applySuggestedPromptsMainPatch, "main process"],
    [applySuggestedPromptsAppPagePatch, "app page"],
    [applySuggestedPromptsSettingsPatch, "settings"],
    [applySuggestedPromptsHomeContentPatch, "Home generated-source"],
  ];

  for (const [apply, target] of cases) {
    const source = `function drifted${target.replaceAll(/[^A-Za-z]/g, "")}(){return null}`;
    const result = captureWarnings(() => apply(source));
    assert.equal(result.value, source);
    assert.match(result.warnings.join("\n"), new RegExp(`current Suggested Prompts ${target} contract`));
  }
});

test("Suggested Prompts descriptors target only current-DMG active assets", () => {
  assert.match("general-settings-BWZCvLqI.js", GENERAL_SETTINGS_ASSET_PATTERN);
  assert.doesNotMatch("general-settings-CsA3Lt9Z.js", GENERAL_SETTINGS_ASSET_PATTERN);

  assert.match(
    "app-initial~app-main~appgen-settings-page~page~appgen-library-page~appgen-page~appgen-setti~ogh9jurw-DEXL3aWU.js",
    APP_PAGE_ASSET_PATTERN,
  );
  assert.doesNotMatch(
    "app-initial~app-main~appgen-settings-page~page~appgen-library-page~appgen-page~appgen-setti~ogh9jurw-CrEakH0Y.js",
    APP_PAGE_ASSET_PATTERN,
  );

  assert.match("home-ambient-suggestions-content-C7Hrlu7B.js", HOME_CONTENT_ASSET_PATTERN);
  assert.doesNotMatch("home-ambient-suggestions-content-C01Mwmkt.js", HOME_CONTENT_ASSET_PATTERN);
});
