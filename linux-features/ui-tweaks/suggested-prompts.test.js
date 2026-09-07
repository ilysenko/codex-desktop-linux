#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  APP_INITIAL_ASSET_PATTERN,
  APP_PAGE_ASSET_PATTERN,
  APP_PAGE_ELIGIBILITY_MARKER,
  FEATURE_SYNC_MARKER,
  GENERAL_SETTINGS_ASSET_PATTERN,
  HOME_CONTENT_ASSET_PATTERN,
  HOME_CONTENT_SOURCE_MARKER,
  MAIN_ELIGIBILITY_MARKER,
  RUNTIME_MARKER,
  SETTINGS_ELIGIBILITY_MARKER,
  WORK_PAGE_ASSET_PATTERN,
  WORK_PAGE_ELIGIBILITY_MARKER,
  applySuggestedPromptsFeatureSyncPatch,
  applySuggestedPromptsAppPagePatch,
  applySuggestedPromptsHomeContentPatch,
  applySuggestedPromptsMainPatch,
  applySuggestedPromptsSettingsPatch,
  applySuggestedPromptsWorkPagePatch,
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
    "function home(){let Ne=xS(`2425897452`),Pe=xS(`1857002365`),Fe=xS(`3765605143`),",
    "Ie=Bh(HO),Le=Bh(EWe),He=I?.email??v,Ue=gze({authMethod:_,email:He,plan:je}),",
    "We=Ne&&Ue,return jsx(i$r,{generatedSuggestionsEnabled:We,projectRoot:qe})}",
  ].join("");
}

function featureSyncFixture() {
  return [
    "function sync(){let u=RE(`2425897452`),m=RE(`2716206584`);",
    "dispatchMessage(`electron-desktop-features-changed`,{ambientSuggestions:u&&m.status===`enabled`,appshotsEnabled:m})}",
  ].join("");
}

function workPageFixture() {
  return [
    "function workHome(){let Pe=Ee(`2425897452`),{authMethod:Fe,email:Le,planAtLogin:Re}=ne(),",
    "{data:b}=Ke(),{data:Ue}=ue(),We=Ue?.plan_type??b?.plan??Re;",
    "return jsx(At,{generatedSuggestionsEnabled:Pe&&Ye({authMethod:Fe,email:b?.email??Le,plan:We}),mode:`work`})}",
  ].join("");
}

function mainFixture() {
  return [
    "function Or(e){return br().ambientSuggestions&&e.getEffective(n.Wi.enabled.key)===!0}",
    "async function kr({appServerConnection:e,settingsStore:t}){",
    "let{ambientSuggestionsFeatureDiscovery:n,ambientSuggestionsStaleTimeMs:r,computerUse:i}=br();",
    "if(!Or(t)||r==null)return{enabled:!1};let{account:a}=await e.getAccount();",
    "return ie(a)?{enabled:!0,computerUseAvailable:i,featureDiscoveryEnabled:n,staleTimeMs:r}:{enabled:!1}}",
  ].join("");
}

function homeContentFixture() {
  return [
    "function ua({generatedSuggestionsEnabled:i,projectRoot:l}){",
    "let Ee=d(b.enabled)===!0,De=a(jn),Oe=a(fn),Me=i&&l!=null,",
    "Ne=De==null&&Me&&Ee,{data:Pe,isLoading:Fe}=rr({enabled:Ne}),",
    "ze=Ne&&(Fe||Le&&P)?null:ir({debugOverride:De,experimentEligible:Le,personalized:Re}),",
    "z=ze===`curated`,Be;e[48]===ye.email?Be=e[49]:(Be=ln(ye.email),e[48]=ye.email,e[49]=Be);",
    "let Xe=Be,Ve=ar({canUsePersonalizedSuggestions:Ee,",
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

function descriptorById(id) {
  const descriptor = descriptors.find((candidate) => candidate.id === id);
  assert.ok(descriptor, `missing descriptor ${id}`);
  return descriptor;
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

test("feature sync patch enables the renderer gate while preserving the status check", () => {
  const source = featureSyncFixture();
  const patched = applySuggestedPromptsFeatureSyncPatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(FEATURE_SYNC_MARKER, "g")) || []).length, 1);
  assert.match(
    patched,
    /u=\(RE\(`2425897452`\),function codexLinuxUiTweaksSuggestedPromptsFeatureSync\(\)\{return!0\}\(\)\)/,
  );
  assert.match(patched, /ambientSuggestions:u&&m\.status===`enabled`/);
  assert.equal(applySuggestedPromptsFeatureSyncPatch(patched), patched);
});

test("app page patch enables Home generation and desktop availability gates atomically", () => {
  const source = appPageFixture();
  const patched = applySuggestedPromptsAppPagePatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(RUNTIME_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(new RegExp(APP_PAGE_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(/xS\(`2425897452`\)/g) || []).length, 1);
  assert.match(
    patched,
    /We=Ne&&\(Ue\|\|function codexLinuxUiTweaksSuggestedPromptsAppPageEligible\(\)\{return!0\}\(\)\)/,
  );
  assert.match(patched, /generatedSuggestionsEnabled:We/);
  assert.equal(applySuggestedPromptsAppPagePatch(patched), patched);
});

test("Work Home patch enables generated suggestions while preserving account eligibility", () => {
  const source = workPageFixture();
  const patched = applySuggestedPromptsWorkPagePatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(RUNTIME_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(new RegExp(WORK_PAGE_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.match(
    patched,
    /Pe=\(Ee\(`2425897452`\),function codexLinuxUiTweaksSuggestedPromptsEnabled\(\)\{return!0\}\(\)\)/,
  );
  assert.match(
    patched,
    /generatedSuggestionsEnabled:Pe&&\(Ye\(\{authMethod:Fe,email:b\?\.email\?\?Le,plan:We\}\)\|\|function codexLinuxUiTweaksSuggestedPromptsWorkPageEligible\(\)\{return!0\}\(\)\)/,
  );
  assert.equal(applySuggestedPromptsWorkPagePatch(patched), patched);
});

test("main patch enables refresh while preserving the upstream account call", () => {
  const source = mainFixture();
  const patched = applySuggestedPromptsMainPatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(MAIN_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.match(patched, /ie\(a\)/);
  assert.match(patched, /computerUseAvailable:i/);
  assert.match(patched, /featureDiscoveryEnabled:n/);
  assert.match(patched, /staleTimeMs:r/);
  assert.match(patched, /await e\.getAccount\(\)/);
  assert.equal(applySuggestedPromptsMainPatch(patched), patched);
});

test("main patch preserves current minified aliases", () => {
  const source = [
    "async function refresh({appServerConnection:connection,settingsStore:store}){",
    "let{ambientSuggestionsFeatureDiscovery:discovery,ambientSuggestionsStaleTimeMs:stale,",
    "computerUse:computerUse}=featureState();",
    "if(!settingsEligible(store)||stale==null)return{enabled:!1};",
    "let{account:account}=await connection.getAccount();",
    "return accountEligible(account)?{enabled:!0,computerUseAvailable:computerUse,",
    "featureDiscoveryEnabled:discovery,staleTimeMs:stale}:{enabled:!1}}",
  ].join("");
  const patched = applySuggestedPromptsMainPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /featureState\(\)/);
  assert.match(patched, /settingsEligible\(store\)/);
  assert.match(patched, /await connection\.getAccount\(\)/);
  assert.match(patched, /accountEligible\(account\)/);
  assert.match(patched, /computerUseAvailable:computerUse/);
  assert.match(patched, /featureDiscoveryEnabled:discovery/);
  assert.match(patched, /staleTimeMs:stale/);
  assert.equal(applySuggestedPromptsMainPatch(patched), patched);
});

test("main patch rejects incomplete, duplicate, and mixed contracts byte-identically", () => {
  const current = mainFixture();
  const patched = applySuggestedPromptsMainPatch(current);
  const sources = [
    current.replace("ambientSuggestionsStaleTimeMs", "ambientSuggestionStaleTimeMs"),
    current.replace("ambientSuggestionsFeatureDiscovery", "ambientSuggestionFeatureDiscovery"),
    current.replace("computerUseAvailable:i", "computerUseAvailable:n"),
    current.replace("featureDiscoveryEnabled:n", "featureDiscoveryEnabled:i"),
    current.replace("await e.getAccount()", "await e.account()"),
    patched.replace("(ie(a),function", "(ie(a)&&function"),
    patched.replace("staleTimeMs:r", "staleTimeMs:refreshMs"),
    patched.replace(
      `function ${MAIN_ELIGIBILITY_MARKER}(){return!0}`,
      `function ${MAIN_ELIGIBILITY_MARKER}(){return!1}`,
    ),
    current + current,
    patched + patched,
    current + patched,
    `${current}function ${MAIN_ELIGIBILITY_MARKER}(){return!0}`,
    `${patched}function ${MAIN_ELIGIBILITY_MARKER}(){return!0}`,
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applySuggestedPromptsMainPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current Suggested Prompts main process contract/);
  }
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

test("Home content rejects incomplete, duplicate, and mixed contracts byte-identically", () => {
  const current = homeContentFixture();
  const patched = applySuggestedPromptsHomeContentPatch(current);
  const sources = [
    current.replace(
      "shouldUseCuratedNewChatPageSuggestions:z",
      "shouldUseCuratedNewChatPageSuggestions:other",
    ),
    patched.replace(
      `function ${HOME_CONTENT_SOURCE_MARKER}(){return!1}`,
      `function ${HOME_CONTENT_SOURCE_MARKER}(){return!0}`,
    ),
    patched.replace(
      "shouldUseCuratedNewChatPageSuggestions:z",
      "shouldUseCuratedNewChatPageSuggestions:other",
    ),
    current + current,
    patched + patched,
    current + patched,
    `${current}function ${HOME_CONTENT_SOURCE_MARKER}(){return!1}`,
    `${patched}function ${HOME_CONTENT_SOURCE_MARKER}(){return!1}`,
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applySuggestedPromptsHomeContentPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current Suggested Prompts Home generated-source contract/);
  }
});

test("Home content ignores unrelated curated-source lookalikes", () => {
  const source = `unrelated=source===\`curated\`;${homeContentFixture()}`;
  const patched = applySuggestedPromptsHomeContentPatch(source);

  assert.match(patched, /^unrelated=source===`curated`;/);
  assert.equal((patched.match(new RegExp(HOME_CONTENT_SOURCE_MARKER, "g")) || []).length, 1);
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

test("feature sync patch rejects incomplete, duplicate, and mixed contracts byte-identically", () => {
  const current = featureSyncFixture();
  const patched = applySuggestedPromptsFeatureSyncPatch(current);
  const sources = [
    current.replace("m.status", "m.state"),
    patched.replace("return!0", "return!1"),
    current + current,
    patched + patched,
    current + patched,
    `${current}function ${FEATURE_SYNC_MARKER}(){return!0}()`,
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applySuggestedPromptsFeatureSyncPatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current Suggested Prompts feature sync contract/);
  }
});

test("Work Home patch rejects incomplete, duplicate, and mixed contracts byte-identically", () => {
  const current = workPageFixture();
  const patched = applySuggestedPromptsWorkPagePatch(current);
  const sources = [
    current.replace("b?.email", "b.email"),
    patched.replace("return!0", "return!1"),
    current + current,
    patched + patched,
    current + patched,
    `${current}function ${WORK_PAGE_ELIGIBILITY_MARKER}(){return!0}()`,
  ];

  for (const source of sources) {
    const result = captureWarnings(() => applySuggestedPromptsWorkPagePatch(source));
    assert.equal(result.value, source);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /current Suggested Prompts Work Home page contract/);
  }
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

test("Suggested Prompts descriptors select current contracts across renderer hash changes", () => {
  const featureSyncDescriptor = descriptorById("home-suggested-prompts-feature-sync");
  assert.match("app-initial-HashNext1.js", APP_INITIAL_ASSET_PATTERN);
  assert.doesNotMatch("app-primary-HashNext1.js", APP_INITIAL_ASSET_PATTERN);
  assert.equal(featureSyncDescriptor.assetMatch(featureSyncFixture()), true);
  assert.equal(
    featureSyncDescriptor.assetMatch(applySuggestedPromptsFeatureSyncPatch(featureSyncFixture())),
    true,
  );
  assert.equal(featureSyncDescriptor.assetMatch("export{app}"), false);

  const appPageDescriptor = descriptorById("home-suggested-prompts-app-page");
  assert.match("app-primary-HashNext2.js", APP_PAGE_ASSET_PATTERN);
  assert.doesNotMatch("app-initial-HashNext2.js", APP_PAGE_ASSET_PATTERN);
  assert.equal(appPageDescriptor.assetMatch(appPageFixture()), true);
  assert.equal(appPageDescriptor.assetMatch(applySuggestedPromptsAppPagePatch(appPageFixture())), true);
  assert.equal(appPageDescriptor.assetMatch("export{app}"), false);

  const workPageDescriptor = descriptorById("home-suggested-prompts-work-page");
  assert.match("page-HashNext3.js", WORK_PAGE_ASSET_PATTERN);
  assert.equal(workPageDescriptor.assetMatch(workPageFixture()), true);
  assert.equal(workPageDescriptor.assetMatch(applySuggestedPromptsWorkPagePatch(workPageFixture())), true);
  assert.equal(workPageDescriptor.assetMatch("export{page}"), false);

  const settingsDescriptor = descriptorById("home-suggested-prompts-settings-row");
  assert.match("general-settings-HashNext4.js", GENERAL_SETTINGS_ASSET_PATTERN);
  assert.equal(settingsDescriptor.assetMatch(settingsFixture()), true);
  assert.equal(settingsDescriptor.assetMatch(applySuggestedPromptsSettingsPatch(settingsFixture())), true);
  assert.equal(settingsDescriptor.assetMatch("export{settings}"), false);

  const contentDescriptor = descriptorById("home-suggested-prompts-content");
  assert.match("home-ambient-suggestions-content-HashNext5.js", HOME_CONTENT_ASSET_PATTERN);
  assert.equal(contentDescriptor.assetMatch(homeContentFixture()), true);
  assert.equal(
    contentDescriptor.assetMatch(applySuggestedPromptsHomeContentPatch(homeContentFixture())),
    true,
  );
  assert.equal(contentDescriptor.assetMatch("export{suggestions}"), false);
});
