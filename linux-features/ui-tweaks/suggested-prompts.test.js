#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  APP_PAGE_ELIGIBILITY_MARKER,
  FEATURE_SYNC_MARKER,
  HOME_CONTENT_SOURCE_MARKER,
  MAIN_ELIGIBILITY_MARKER,
  RUNTIME_MARKER,
  SETTINGS_ELIGIBILITY_MARKER,
  WORK_PAGE_ELIGIBILITY_MARKER,
  applySuggestedPromptsFeatureSyncPatch,
  applySuggestedPromptsAppPagePatch,
  applySuggestedPromptsHomeContentPatch,
  applySuggestedPromptsMainPatch,
  applySuggestedPromptsSettingsPatch,
  applySuggestedPromptsWorkPagePatch,
  descriptors,
  suggestedPromptsEnabled,
  suggestedPromptsMainContract,
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

// Fixtures follow the current rspack/SWC renderer shapes: module-member hook
// calls, double-quoted strings, and literal-first comparisons.
function settingsFixture() {
  return [
    'function ki(){let e=(0,Q.c)(31),t=(0,G.Zj)("1372061905"),n=(0,G.Zj)("2425897452"),r=(0,G.Zj)(ft),i;',
    "return n?(0,$.jsx)(H,{electron:!0,children:(0,$.jsx)(ci,{})}):null}",
    "function ci(){let e=(0,li.c)(12),t=n(m),r=R(),{authMethod:i,email:a,planAtLogin:o}=(0,tZ.As)(),",
    '{data:d}=(0,tq.U)(),f=(0,F.iK)(b.enabled);',
    "if(!(0,f.ML4)({authMethod:i,email:d?.email??a,plan:d?.plan??o}))return null;return row()}",
  ].join("");
}

function appPageFixture() {
  return [
    'function home(){let Ne=(0,eD.Zj)("2425897452"),Pe=(0,eD.Zj)("1857002365"),',
    "He=I?.email??v;oS[96]!==_?(ez=(0,c.ML4)({authMethod:_,email:He,plan:je}),oS[96]=_,oS[99]=ez):ez=oS[99];",
    "let Ue=ez,We=Ne&&Ue,lM=null!=oF;return(0,n.jsx)(eI.FU,{generatedSuggestionsEnabled:We,projectRoot:qe})}",
  ].join("");
}

function featureSyncFixture() {
  return [
    'function sync(){let u=(0,ed.Zj)("2425897452"),m=(0,ed.Zj)("2716206584");',
    't0.O1.dispatchMessage("electron-desktop-features-changed",{ambientSuggestions:u&&"enabled"===m.status,appshotsEnabled:m})}',
  ].join("");
}

function workPageFixture() {
  return [
    'function workHome(){let Pe=(0,er.Zj)("2425897452"),{authMethod:Fe,email:Le,planAtLogin:Re}=(0,f.As)(),',
    "{data:b}=(0,v.U)(),{data:Ue}=(0,w.YL)(),We=Ue?.plan_type??b?.plan??Re;",
    'return(0,r.jsx)(eh.HomeTaskSuggestions,{generatedSuggestionsEnabled:Pe&&(0,s.ML4)({authMethod:Fe,email:b?.email??Le,plan:We}),mode:"work"})}',
  ].join("");
}

function mainFixture() {
  return [
    "function Or(e){return br().ambientSuggestions&&!0===e.getEffective(n.Wi.enabled.key)}",
    "async function kr({appServerConnection:e,settingsStore:t}){",
    "let{ambientSuggestionsFeatureDiscovery:n,ambientSuggestionsStaleTimeMs:r,computerUse:i}=br();",
    "if(!Or(t)||null==r)return{enabled:!1};let{account:a}=await e.getAccount();",
    "return(0,n.ie)(a)?{enabled:!0,computerUseAvailable:i,featureDiscoveryEnabled:n,staleTimeMs:r}:{enabled:!1}}",
  ].join("");
}

function homeContentFixture() {
  return [
    "function ua({generatedSuggestionsEnabled:i,projectRoot:l}){",
    "let Ee=!0===(0,d.iK)(b.enabled),De=(0,a.Ul)(jn),Me=i&&null!=l,",
    "Ne=null==De&&Me&&Ee,{data:Pe,isLoading:Fe}=(0,rr.a)({enabled:Ne}),",
    "ze=Ne&&(Fe||Le&&P)?null:(0,tf.o1)({debugOverride:De,experimentEligible:Le,personalized:Re});",
    'let z="curated"===ze;e[48]!==ye.email?(Be=(0,G.rm)(ye.email),e[48]=ye.email,e[49]=Be):Be=e[49];',
    "let Xe=Be,Ve=(0,tf.b4)({canUsePersonalizedSuggestions:Ee,",
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
  assert.match(patched, /n=\(\(0,G\.Zj\)\("2425897452"\),function codexLinuxUiTweaksSuggestedPromptsEnabled\(\)\{return!0\}\(\)\)/);
  assert.match(
    patched,
    /if\(!\(\(0,f\.ML4\)\(\{authMethod:i,email:d\?\.email\?\?a,plan:d\?\.plan\?\?o\}\)\|\|function codexLinuxUiTweaksSuggestedPromptsSettingsEligible\(\)\{return!0\}\(\)\)\)return null/,
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
    /u=\(\(0,ed\.Zj\)\("2425897452"\),function codexLinuxUiTweaksSuggestedPromptsFeatureSync\(\)\{return!0\}\(\)\)/,
  );
  assert.match(patched, /ambientSuggestions:u&&"enabled"===m\.status/);
  assert.equal(applySuggestedPromptsFeatureSyncPatch(patched), patched);
});

test("app page patch enables Home generation and desktop availability gates atomically", () => {
  const source = appPageFixture();
  const patched = applySuggestedPromptsAppPagePatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(RUNTIME_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(new RegExp(APP_PAGE_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.equal((patched.match(/\(0,eD\.Zj\)\("2425897452"\)/g) || []).length, 1);
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
    /Pe=\(\(0,er\.Zj\)\("2425897452"\),function codexLinuxUiTweaksSuggestedPromptsEnabled\(\)\{return!0\}\(\)\)/,
  );
  assert.match(
    patched,
    /generatedSuggestionsEnabled:Pe&&\(\(0,s\.ML4\)\(\{authMethod:Fe,email:b\?\.email\?\?Le,plan:We\}\)\|\|function codexLinuxUiTweaksSuggestedPromptsWorkPageEligible\(\)\{return!0\}\(\)\)/,
  );
  assert.equal(applySuggestedPromptsWorkPagePatch(patched), patched);
});

test("main patch enables refresh while preserving the upstream account call", () => {
  const source = mainFixture();
  const patched = applySuggestedPromptsMainPatch(source);

  assert.notEqual(patched, source);
  assert.equal((patched.match(new RegExp(MAIN_ELIGIBILITY_MARKER, "g")) || []).length, 1);
  assert.match(patched, /return\(\(0,n\.ie\)\(a\),function /);
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
    "if(!settingsEligible(store)||null==stale)return{enabled:!1};",
    "let{account:account}=await connection.getAccount();",
    "return(0,accounts.accountEligible)(account)?{enabled:!0,computerUseAvailable:computerUse,",
    "featureDiscoveryEnabled:discovery,staleTimeMs:stale}:{enabled:!1}}",
  ].join("");
  const patched = applySuggestedPromptsMainPatch(source);

  assert.notEqual(patched, source);
  assert.match(patched, /featureState\(\)/);
  assert.match(patched, /settingsEligible\(store\)/);
  assert.match(patched, /await connection\.getAccount\(\)/);
  assert.match(patched, /\(0,accounts\.accountEligible\)\(account\)/);
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
    patched.replace("((0,n.ie)(a),function", "((0,n.ie)(a)&&function"),
    current.replace("return(0,n.ie)(a)?", "return ie(a)?"),
    current.replace("null==r)return", "r==null)return"),
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
  assert.match(patched, /z=\("curated"===ze,function codexLinuxSuggestedPromptsGeneratedSource/);
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
  const source = `unrelated="curated"===source;${homeContentFixture()}`;
  const patched = applySuggestedPromptsHomeContentPatch(source);

  assert.match(patched, /^unrelated="curated"===source;/);
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
    'n=(0,G.Zj)("2425897452")',
    'n=(0,G.Zj)("replacement-rollout")',
  );
  const settingsResult = captureWarnings(() => applySuggestedPromptsSettingsPatch(driftedSettings));
  assert.equal(settingsResult.value, driftedSettings);
  assert.match(settingsResult.warnings.join("\n"), /current Suggested Prompts settings contract/);

  const driftedHome = homeContentFixture().replace(
    'z="curated"===ze',
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

test("Suggested Prompts descriptors select current contracts by content needles", () => {
  const cases = [
    ["home-suggested-prompts-feature-sync", featureSyncFixture, applySuggestedPromptsFeatureSyncPatch],
    ["home-suggested-prompts-app-page", appPageFixture, applySuggestedPromptsAppPagePatch],
    ["home-suggested-prompts-work-page", workPageFixture, applySuggestedPromptsWorkPagePatch],
    ["home-suggested-prompts-settings-row", settingsFixture, applySuggestedPromptsSettingsPatch],
    ["home-suggested-prompts-content", homeContentFixture, applySuggestedPromptsHomeContentPatch],
  ];
  for (const [id, fixture, apply] of cases) {
    const descriptor = descriptorById(id);
    assert.equal(descriptor.pattern, undefined, id);
    assert.ok(Array.isArray(descriptor.assetNeedles) && descriptor.assetNeedles.length > 0, id);
    for (const source of [fixture(), apply(fixture())]) {
      assert.equal(descriptor.assetNeedles.every((needle) => source.includes(needle)), true, id);
      assert.equal(descriptor.assetMatch(source), true, id);
    }
    assert.equal(descriptor.assetMatch("export const __webpack_modules__={}"), false, id);
    for (const [otherId, otherFixture] of cases) {
      if (otherId !== id) assert.equal(descriptor.assetMatch(otherFixture()), false, `${id} vs ${otherId}`);
    }
  }
});

test("Suggested Prompts contracts resolve uniquely in the signed official bundle", {
  skip: !process.env.CODEX_SIGNED_EXTRACTED_APP,
}, () => {
  const app = process.env.CODEX_SIGNED_EXTRACTED_APP;
  const { findWebviewAssetsContaining } = require("../../scripts/patches/lib/assets.js");
  for (const descriptor of descriptors.filter(({ phase }) => phase === "webview-asset")) {
    const owners = findWebviewAssetsContaining(app, descriptor.assetNeedles)
      .map((name) => fs.readFileSync(path.join(app, "webview", "assets", name), "utf8"))
      .filter((source) => descriptor.assetMatch(source));
    assert.equal(owners.length, 1, descriptor.id);
    const patched = descriptor.apply(owners[0]);
    assert.notEqual(patched, owners[0], descriptor.id);
    assert.equal(descriptor.apply(patched), patched, descriptor.id);
  }
  const buildDir = path.join(app, ".vite", "build");
  const mainOwners = fs.readdirSync(buildDir)
    .filter((name) => /^early-bootstrap(?:-\d+-[0-9a-f]+)?\.js$/.test(name))
    .map((name) => fs.readFileSync(path.join(buildDir, name), "utf8"))
    .filter((source) => suggestedPromptsMainContract(source) === "current");
  assert.equal(mainOwners.length, 1);
  const patchedMain = applySuggestedPromptsMainPatch(mainOwners[0]);
  assert.equal(suggestedPromptsMainContract(patchedMain), "patched");
});
