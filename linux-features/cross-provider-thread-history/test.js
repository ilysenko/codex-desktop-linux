#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  applyExtractedAppPatchDescriptors,
  normalizePatchDescriptors,
} = require("../../scripts/patches/engine.js");
const {
  loadLinuxFeaturePatchDescriptors,
} = require("../../scripts/lib/linux-features.js");
const { createPatchReport } = require("../../scripts/lib/patch-report.js");
const {
  ACTIVE_RESUME_PROVIDER_MARKER,
  THREAD_HISTORY_TARGETS,
  applyCrossProviderThreadHistoryAssets,
  applyCrossProviderThreadHistoryPatch,
  descriptors,
  threadHistoryCounts,
} = require("./patch.js");

const currentThreadHistorySource = [
  "async listRecentThreads({limit:e}){return(await this.sendRequest(`thread/list`,{archived:!1,cursor:null,limit:e,modelProviders:null,sortKey:`updated_at`,useStateDbOnly:!0},{priority:`background`,source:`thread_list`})).data}",
  "async listArchivedThreads(){return this.listAllThreads({modelProviders:null,archived:!0})}",
  "async listRecentThreads({cursor:e,limit:t,background:n=!1}){let r={limit:t,cursor:e,sortKey:this.recentConversationSortKey,modelProviders:null,archived:!1,sourceKinds:ie,useStateDbOnly:!0},i=await this.requestClient.sendRequest(`thread/list`,r);return i}",
  "const listActiveThreads=()=>e.listAllThreads({modelProviders:null});",
  "let r=await this.threadStore.listAllThreads({modelProviders:null,sourceKinds:j});",
  "let P=await e.buildNewConversationParams(M,N,x[0]??`/`,k,k.approvalsReviewer,{mode:l?.mode,skipDynamicTools:!0,threadId:t}),F=e.sendRequest(`thread/resume`,{threadId:t,history:null,path:l?.rolloutPath??null,model:null,modelProvider:P.modelProvider,serviceTier:P.serviceTier,cwd:P.cwd})",
].join("");

const resolverSource =
  "let[r,i]=await Promise.all([e.listAllThreads({modelProviders:null}),e.listAllThreads({modelProviders:null,archived:!0})]);";
const subagentSource =
  "let d=await r(`thread/list`,{limit:200,cursor:n,modelProviders:null,archived:!1,parentThreadId:e});";

const patchOptions = {
  expectedEnumerationCount: 5,
  expectedResumeCount: 1,
  surface: "recent-thread",
};
const fixtureAssets = new Map([
  [
    "app-initial~artifact-tab-content.electron~notebook-preview-panel~app-main~business-checkout~oxnpxkxc-fixture.js",
    currentThreadHistorySource,
  ],
  [
    "app-initial~artifact-tab-content.electron~notebook-preview-panel~app-main~pull-request-rout~jvsvjxtt-fixture.js",
    resolverSource,
  ],
  [
    "app-initial~app-main~new-thread-panel-page~onboarding-page~appgen-library-page~hotkey-windo~k4644ppc-fixture.js",
    subagentSource,
  ],
]);

function captureWarns(fn) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (message) => warnings.push(message);
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function withTempDir(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cross-provider-thread-history-"));
  try {
    return callback(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function withFeatureConfig(enabled, callback) {
  const originalConfig = process.env.CODEX_LINUX_FEATURES_CONFIG;
  return withTempDir((tempDir) => {
    const configPath = path.join(tempDir, "features.json");
    fs.writeFileSync(configPath, `${JSON.stringify({ enabled })}\n`);
    process.env.CODEX_LINUX_FEATURES_CONFIG = configPath;
    try {
      return callback(path.resolve(__dirname, ".."));
    } finally {
      if (originalConfig == null) {
        delete process.env.CODEX_LINUX_FEATURES_CONFIG;
      } else {
        process.env.CODEX_LINUX_FEATURES_CONFIG = originalConfig;
      }
    }
  });
}

function writeFixtureAssets(extractedDir, sources = fixtureAssets) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const [assetName, source] of sources) {
    fs.writeFileSync(path.join(assetsDir, assetName), source);
  }
  return assetsDir;
}

test("feature stays disabled until selected", () => {
  withFeatureConfig([], (featuresRoot) => {
    assert.deepEqual(loadLinuxFeaturePatchDescriptors({ featuresRoot }), []);
  });

  withFeatureConfig(["cross-provider-thread-history"], (featuresRoot) => {
    const loaded = loadLinuxFeaturePatchDescriptors({ featuresRoot });
    assert.deepEqual(
      loaded.map((descriptor) => [descriptor.id, descriptor.phase, descriptor.ciPolicy]),
      [
        [
          "feature:cross-provider-thread-history:all-provider-thread-history",
          "extracted-app:post-webview",
          "optional",
        ],
      ],
    );
  });
});

test("thread enumeration requests use an explicit empty provider filter", () => {
  const patched = applyCrossProviderThreadHistoryPatch(
    currentThreadHistorySource,
    patchOptions,
  );

  assert.notEqual(patched, currentThreadHistorySource);
  assert.equal(patched.includes("modelProviders:null"), false);
  assert.equal(
    patched.match(/modelProviders:\[\]\/\*codexLinuxCrossProviderThreadHistory\*\//g)?.length,
    5,
  );
  assert.equal(applyCrossProviderThreadHistoryPatch(patched, patchOptions), patched);
});

test("thread resume explicitly prefers the active configured provider", () => {
  const patched = applyCrossProviderThreadHistoryPatch(
    currentThreadHistorySource,
    patchOptions,
  );

  assert.equal(
    patched.includes("modelProvider:P.modelProvider,serviceTier:P.serviceTier"),
    false,
  );
  assert.match(
    patched,
    new RegExp(
      `modelProvider:P\\.modelProvider\\?\\?P\\.config\\?\\.model_provider` +
        `\\?\\?null/\\*${ACTIVE_RESUME_PROVIDER_MARKER}\\*/` +
        `,serviceTier:P\\.serviceTier`,
    ),
  );
  assert.deepEqual(threadHistoryCounts(patched), {
    currentEnumeration: 0,
    compliantEnumeration: 5,
    currentResume: 0,
    compliantResume: 1,
  });
});

test("resume hardening preserves explicit special-provider overrides", () => {
  const patched = applyCrossProviderThreadHistoryPatch(
    currentThreadHistorySource,
    patchOptions,
  );

  assert.match(
    patched,
    /modelProvider:P\.modelProvider\?\?P\.config\?\.model_provider/,
  );
  assert.equal(
    patched.includes("modelProvider:P.config?.model_provider??P.modelProvider"),
    false,
  );
});

test("explicit provider filters and unrelated null values remain unchanged", () => {
  const source = [
    "await sendRequest(`thread/list`,{modelProviders:[`custom`]});",
    "await sendRequest(`thread/list`,{modelProviders:[]});",
    "const unrelated={modelProviders:null};",
  ].join("");

  assert.equal(
    applyCrossProviderThreadHistoryPatch(source, {
      expectedEnumerationCount: 1,
      expectedResumeCount: 0,
      surface: "explicit-filter fixture",
    }),
    source,
  );
});

test("an upstream empty provider filter is already compliant", () => {
  const source = currentThreadHistorySource
    .replaceAll("modelProviders:null", "modelProviders:[]")
    .replace(
      "modelProvider:P.modelProvider,serviceTier:P.serviceTier",
      `modelProvider:P.modelProvider??P.config?.model_provider??null/*${ACTIVE_RESUME_PROVIDER_MARKER}*/,serviceTier:P.serviceTier`,
    );
  const { value, warnings } = captureWarns(() =>
    applyCrossProviderThreadHistoryPatch(source, patchOptions),
  );

  assert.equal(value, source);
  assert.deepEqual(warnings, []);
});

test("a drifted recent-thread provider expression fails soft with a warning", () => {
  const source = currentThreadHistorySource.replaceAll(
    "modelProviders:null",
    "modelProviders:currentProvider",
  );
  const { value, warnings } = captureWarns(() =>
    applyCrossProviderThreadHistoryPatch(source, patchOptions),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recent-thread provider filter/);
});

test("a partially patched bundle is rejected byte-identically", () => {
  const source = currentThreadHistorySource.replace(
    "modelProviders:null",
    "modelProviders:[]/*codexLinuxCrossProviderThreadHistory*/",
  );
  const { value, warnings } = captureWarns(() =>
    applyCrossProviderThreadHistoryPatch(source, patchOptions),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /current=4, compliant=1, expected=5/);
});

test("a drifted resume provider expression rejects the whole feature", () => {
  const source = currentThreadHistorySource.replace(
    "modelProvider:P.modelProvider,serviceTier:P.serviceTier",
    "modelProvider:storedThread.modelProvider,serviceTier:P.serviceTier",
  );
  const { value, warnings } = captureWarns(() =>
    applyCrossProviderThreadHistoryPatch(source, patchOptions),
  );

  assert.equal(value, source);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /resume provider/);
});

test("enabled descriptor patches matching extracted webview assets", () => {
  withFeatureConfig(["cross-provider-thread-history"], (featuresRoot) => {
    withTempDir((extractedDir) => {
      const assetsDir = writeFixtureAssets(extractedDir);
      const loaded = normalizePatchDescriptors(
        loadLinuxFeaturePatchDescriptors({ featuresRoot }),
      );
      const firstReport = createPatchReport();

      applyExtractedAppPatchDescriptors(
        extractedDir,
        loaded,
        {},
        firstReport,
        "extracted-app:post-webview",
      );

      let markerCount = 0;
      for (const assetName of fixtureAssets.keys()) {
        const patched = fs.readFileSync(path.join(assetsDir, assetName), "utf8");
        assert.equal(patched.includes("modelProviders:null"), false);
        assert.match(patched, /codexLinuxCrossProviderThreadHistory/);
        markerCount += patched.match(/codexLinuxCrossProviderThreadHistory/g)?.length ?? 0;
      }
      assert.equal(markerCount, 8);
      assert.equal(firstReport.patches[0].status, "applied");

      const secondReport = createPatchReport();
      applyExtractedAppPatchDescriptors(
        extractedDir,
        loaded,
        {},
        secondReport,
        "extracted-app:post-webview",
      );
      assert.equal(secondReport.patches[0].status, "already-applied");
    });
  });
});

test("a cross-bundle mixed state is rejected before any asset is written", () => {
  withTempDir((extractedDir) => {
    const mixed = new Map(fixtureAssets);
    const managerName = Array.from(mixed.keys())[0];
    mixed.set(
      managerName,
      applyCrossProviderThreadHistoryPatch(mixed.get(managerName), patchOptions),
    );
    const assetsDir = writeFixtureAssets(extractedDir, mixed);
    const before = new Map(
      Array.from(mixed.keys(), (assetName) => [
        assetName,
        fs.readFileSync(path.join(assetsDir, assetName)),
      ]),
    );

    const { value: result, warnings } = captureWarns(() =>
      applyCrossProviderThreadHistoryAssets(extractedDir),
    );

    assert.equal(result.matched, false);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /inconsistent cross-bundle provider filter state/);
    assert.equal(warnings.length, 1);
    for (const [assetName, original] of before) {
      assert.deepEqual(fs.readFileSync(path.join(assetsDir, assetName)), original);
    }
  });
});

test("one drifted bundle prevents writes to every bundle", () => {
  withTempDir((extractedDir) => {
    const drifted = new Map(fixtureAssets);
    const resolverName = Array.from(drifted.keys())[1];
    drifted.set(
      resolverName,
      drifted.get(resolverName).replace("modelProviders:null", "modelProviders:provider"),
    );
    const assetsDir = writeFixtureAssets(extractedDir, drifted);
    const before = new Map(
      Array.from(drifted.keys(), (assetName) => [
        assetName,
        fs.readFileSync(path.join(assetsDir, assetName)),
      ]),
    );

    const { value: result, warnings } = captureWarns(() =>
      applyCrossProviderThreadHistoryAssets(extractedDir),
    );

    assert.equal(result.matched, false);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /could not verify cross-host thread resolver/);
    assert.equal(warnings.length, 1);
    for (const [assetName, original] of before) {
      assert.deepEqual(fs.readFileSync(path.join(assetsDir, assetName)), original);
    }
  });
});

test("a missing target bundle prevents writes to every present bundle", () => {
  withTempDir((extractedDir) => {
    const incomplete = new Map(fixtureAssets);
    incomplete.delete(Array.from(incomplete.keys())[2]);
    const assetsDir = writeFixtureAssets(extractedDir, incomplete);
    const before = new Map(
      Array.from(incomplete.keys(), (assetName) => [
        assetName,
        fs.readFileSync(path.join(assetsDir, assetName)),
      ]),
    );

    const { value: result, warnings } = captureWarns(() =>
      applyCrossProviderThreadHistoryAssets(extractedDir),
    );

    assert.equal(result.matched, false);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /expected exactly one subagent thread enumeration bundle/);
    assert.equal(warnings.length, 1);
    for (const [assetName, original] of before) {
      assert.deepEqual(fs.readFileSync(path.join(assetsDir, assetName)), original);
    }
  });
});

test("a mid-transaction write failure restores every target asset", () => {
  withTempDir((extractedDir) => {
    const assetsDir = writeFixtureAssets(extractedDir);
    const before = new Map(
      Array.from(fixtureAssets.keys(), (assetName) => [
        assetName,
        fs.readFileSync(path.join(assetsDir, assetName)),
      ]),
    );
    const originalWriteFileSync = fs.writeFileSync;
    let failureInjected = false;
    fs.writeFileSync = (filePath, data, ...args) => {
      if (
        !failureInjected &&
        path.basename(filePath).includes("jvsvjxtt") &&
        String(data).includes("codexLinuxCrossProviderThreadHistory")
      ) {
        failureInjected = true;
        throw new Error("injected cross-provider asset write failure");
      }
      return originalWriteFileSync(filePath, data, ...args);
    };

    const report = createPatchReport();
    try {
      applyExtractedAppPatchDescriptors(
        extractedDir,
        normalizePatchDescriptors(descriptors),
        {},
        report,
        "extracted-app:post-webview",
      );
    } finally {
      fs.writeFileSync = originalWriteFileSync;
    }

    assert.equal(failureInjected, true);
    assert.equal(report.patches[0].status, "skipped-optional");
    assert.match(report.patches[0].reason, /injected cross-provider asset write failure/);
    for (const [assetName, original] of before) {
      assert.deepEqual(fs.readFileSync(path.join(assetsDir, assetName)), original);
    }
  });
});

test("descriptors target the three current thread history bundles", () => {
  assert.equal(descriptors.length, 1);
  assert.equal(THREAD_HISTORY_TARGETS.length, 3);
  assert.equal(
    THREAD_HISTORY_TARGETS[0].pattern.test(
      "app-initial~artifact-tab-content.electron~notebook-preview-panel~app-main~business-checkout~oxnpxkxc-fixture.js",
    ),
    true,
  );
  assert.equal(
    THREAD_HISTORY_TARGETS[1].pattern.test(
      "app-initial~artifact-tab-content.electron~notebook-preview-panel~app-main~pull-request-rout~jvsvjxtt-fixture.js",
    ),
    true,
  );
  assert.equal(
    THREAD_HISTORY_TARGETS[2].pattern.test(
      "app-initial~app-main~new-thread-panel-page~onboarding-page~appgen-library-page~hotkey-windo~k4644ppc-fixture.js",
    ),
    true,
  );
  for (const target of THREAD_HISTORY_TARGETS) {
    assert.equal(target.pattern.test("setting-storage-fixture.js"), false);
  }
});
