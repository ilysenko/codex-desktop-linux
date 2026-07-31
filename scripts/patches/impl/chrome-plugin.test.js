"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

process.env.CODEX_LINUX_FEATURES_CONFIG = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "linux-features",
  "features.example.json",
);

const {
  createPatchReport,
  criticalFailuresFromReport,
  optionalDriftFromReport,
} = require("../../lib/patch-report.js");
const { validateReport } = require("../../ci/validate-patch-report.js");
const {
  corePatchDescriptors,
  patchExtractedApp,
} = require("../../patches/runner.js");
const {
  applyExtractedAppPatchDescriptors,
} = require("../../patches/engine.js");
const {
  applyLinuxChromeNativeHostRuntimePatch,
  patchLinuxChromeNativeHostRuntimeAssets,
} = require("./chrome-plugin.js");
const {
  createCurrentChromeNativeHostRuntimeAssetsFixture,
  currentChromePluginAppServerSourceBundleFixture,
  electron42BrowserUseRuntimeResolverBundleFixture,
} = require("../test-fixtures/current-dmg.js");

function captureWarns(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function assetSources(candidate) {
  return new Map([
    [candidate.mainPath, fs.readFileSync(candidate.mainPath, "utf8")],
    [candidate.srcPath, fs.readFileSync(candidate.srcPath, "utf8")],
  ]);
}

test("patches the complete current Chrome runtime asset set transactionally", async () => {
  const candidate = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    const { value: first, warnings } = captureWarns(() =>
      patchLinuxChromeNativeHostRuntimeAssets(candidate.extractedDir),
    );
    assert.deepEqual(first, { matched: 2, changed: 2 });
    assert.deepEqual(warnings, []);

    const mainPatched = fs.readFileSync(candidate.mainPath, "utf8");
    const srcPatched = fs.readFileSync(candidate.srcPath, "utf8");
    assert.match(
      mainPatched,
      /codexLinuxChromeNativeHostRuntimeEntry\(codexLinuxChromeNativeHostRuntimePath\(`codex`\),`linux-path`\)/,
    );
    assert.match(
      srcPatched,
      /codexLinuxChromeNativeHostRuntimeEnv\(`CODEX_CLI_PATH`\)/,
    );
    assert.match(srcPatched, /codexLinuxChromePluginAppServerSourcePath/);

    const files = new Set([
      "/home/josh/.local/bin/codex",
      "/opt/codex/resources/node-runtime/bin/node",
      "/opt/codex/resources/node_repl",
    ]);
    const runtime = await vm.runInNewContext(
      `${srcPatched};vq({resourcesPath:"/opt/codex/resources",codexHome:"/tmp/codex",devRuntimeRepoRoot:null,nativeHostName:"com.openai.codexextension"});`,
      {
        require(moduleName) {
          if (moduleName === "node:path") return path;
          if (moduleName === "node:fs") {
            return {
              statSync(filePath) {
                if (!files.has(filePath)) {
                  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
                }
                return { isFile: () => true };
              },
            };
          }
          return require(moduleName);
        },
        process: {
          env: { CODEX_CLI_PATH: "/home/josh/.local/bin/codex", PATH: "" },
          platform: "linux",
        },
      },
    );
    assert.deepEqual(JSON.parse(JSON.stringify(runtime)), {
      codexCliPath: "/home/josh/.local/bin/codex",
      nodeModuleDirs: [],
      nodePath: "/opt/codex/resources/node-runtime/bin/node",
      nodeReplPath: "/opt/codex/resources/node_repl",
    });

    const beforeSecondPass = assetSources(candidate);
    const second = captureWarns(() =>
      patchLinuxChromeNativeHostRuntimeAssets(candidate.extractedDir),
    );
    assert.deepEqual(second.value, { matched: 2, changed: 0 });
    assert.deepEqual(second.warnings, []);
    assert.deepEqual(assetSources(candidate), beforeSecondPass);
  } finally {
    fs.rmSync(candidate.extractedDir, { recursive: true, force: true });
  }
});

test("rejects mixed or partial current Chrome runtime asset sets without writes", () => {
  const mixed = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    fs.writeFileSync(
      mixed.mainPath,
      applyLinuxChromeNativeHostRuntimePatch(
        fs.readFileSync(mixed.mainPath, "utf8"),
      ),
      "utf8",
    );
    const before = assetSources(mixed);
    const { value, warnings } = captureWarns(() =>
      patchLinuxChromeNativeHostRuntimeAssets(mixed.extractedDir),
    );
    assert.equal(value.changed, 0);
    assert.match(value.reason, /mixed current Chrome native host runtime patch state/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(assetSources(mixed), before);
  } finally {
    fs.rmSync(mixed.extractedDir, { recursive: true, force: true });
  }

  const partial = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    assert.deepEqual(
      patchLinuxChromeNativeHostRuntimeAssets(partial.extractedDir),
      { matched: 2, changed: 2 },
    );
    fs.writeFileSync(
      partial.srcPath,
      fs.readFileSync(partial.srcPath, "utf8").replace(
        "/*codexLinuxChromeNativeHostAppServerRuntime*/",
        "/*codexLinuxChromeNativeHostAppServerRuntimeCorrupt*/",
      ),
      "utf8",
    );
    const before = assetSources(partial);
    const { value, warnings } = captureWarns(() =>
      patchLinuxChromeNativeHostRuntimeAssets(partial.extractedDir),
    );
    assert.equal(value.changed, 0);
    assert.match(value.reason, /incomplete Chrome native host runtime patch/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(assetSources(partial), before);
  } finally {
    fs.rmSync(partial.extractedDir, { recursive: true, force: true });
  }
});

test("rejects current Chrome runtime markers with a damaged contract body", () => {
  const candidate = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    assert.deepEqual(
      patchLinuxChromeNativeHostRuntimeAssets(candidate.extractedDir),
      { matched: 2, changed: 2 },
    );
    const patchedSource = fs.readFileSync(candidate.srcPath, "utf8");
    const variants = [
      patchedSource.replace(
        "if(process.platform===`linux`)return codexLinuxChromePluginAppServerSourcePath(e);",
        "if(process.platform===`linux`)return e.codexCliPath;",
      ),
      patchedSource.replace(
        "??codexLinuxChromeNativeHostRuntimeEnv(`CODEX_CLI_PATH`)??codexLinuxChromeNativeHostRuntimePath(`codex`)",
        "",
      ),
      patchedSource.replace(
        "??codexLinuxChromeNativeHostRuntimeFile(e.resourcesPath,[[`node-runtime`,`bin`,process.platform===`win32`?`node.exe`:`node`]])",
        "",
      ),
      patchedSource.replace(
        "??codexLinuxChromeNativeHostRuntimeFile(e.resourcesPath,[[process.platform===`win32`?`node_repl.exe`:`node_repl`]])",
        "",
      ),
    ];

    for (const source of variants) {
      fs.writeFileSync(candidate.srcPath, source, "utf8");
      const before = assetSources(candidate);
      const { value, warnings } = captureWarns(() =>
        patchLinuxChromeNativeHostRuntimeAssets(candidate.extractedDir),
      );
      assert.equal(value.changed, 0);
      assert.match(value.reason, /incomplete Chrome native host runtime patch/);
      assert.equal(warnings.length, 1);
      assert.deepEqual(assetSources(candidate), before);
    }
  } finally {
    fs.rmSync(candidate.extractedDir, { recursive: true, force: true });
  }
});

test("restores current Chrome runtime assets after a write failure", () => {
  const candidate = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    const before = assetSources(candidate);
    let writeCount = 0;
    const { value, warnings } = captureWarns(() =>
      patchLinuxChromeNativeHostRuntimeAssets(candidate.extractedDir, {
        writeFileSync(filePath, source, encoding) {
          writeCount += 1;
          if (writeCount === 2) {
            fs.writeFileSync(filePath, "partially-written", encoding);
            throw new Error("simulated write failure");
          }
          fs.writeFileSync(filePath, source, encoding);
        },
      }),
    );
    assert.equal(value.changed, 0);
    assert.match(value.reason, /Could not write current Chrome/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(assetSources(candidate), before);
  } finally {
    fs.rmSync(candidate.extractedDir, { recursive: true, force: true });
  }
});

test("keeps a verified rollback fail-soft when a rollback write throws after restoring bytes", () => {
  const candidate = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    const before = assetSources(candidate);
    let writeCount = 0;
    const { value, warnings } = captureWarns(() =>
      patchLinuxChromeNativeHostRuntimeAssets(candidate.extractedDir, {
        writeFileSync(filePath, source, encoding) {
          writeCount += 1;
          if (writeCount === 2) {
            fs.writeFileSync(filePath, "partially-written", encoding);
            throw new Error("simulated write failure");
          }
          fs.writeFileSync(filePath, source, encoding);
          if (writeCount === 3) {
            throw new Error("rollback writer threw after restoring bytes");
          }
        },
      }),
    );

    assert.equal(value.changed, 0);
    assert.match(value.reason, /Could not write current Chrome/);
    assert.equal(warnings.length, 1);
    assert.deepEqual(assetSources(candidate), before);
  } finally {
    fs.rmSync(candidate.extractedDir, { recursive: true, force: true });
  }
});

test("blocks acceptance when Chrome runtime rollback cannot restore bytes", () => {
  const candidate = createCurrentChromeNativeHostRuntimeAssetsFixture();
  try {
    const before = assetSources(candidate);
    let writeCount = 0;
    const applyWithRollbackFailure = (extractedDir) =>
      patchLinuxChromeNativeHostRuntimeAssets(extractedDir, {
        writeFileSync(filePath, source, encoding) {
          writeCount += 1;
          if (writeCount === 2) {
            fs.writeFileSync(filePath, "corrupt-Chrome-runtime-asset", encoding);
            throw new Error("simulated write failure");
          }
          if (writeCount === 3) {
            throw new Error("simulated rollback failure");
          }
          fs.writeFileSync(filePath, source, encoding);
        },
      });
    assert.throws(
      () => applyWithRollbackFailure(candidate.extractedDir),
      (error) =>
        error?.code === "PATCH_INTEGRITY_FAILURE" &&
        /could not restore original bytes/i.test(error.message),
    );
    assert.equal(
      fs.readFileSync(candidate.mainPath, "utf8"),
      before.get(candidate.mainPath),
    );
    assert.equal(
      fs.readFileSync(candidate.srcPath, "utf8"),
      "corrupt-Chrome-runtime-asset",
    );

    const baseDescriptor = corePatchDescriptors().find(
      ({ id }) => id === "linux-chrome-native-host-runtime",
    );
    writeCount = 0;
    fs.writeFileSync(candidate.mainPath, before.get(candidate.mainPath));
    fs.writeFileSync(candidate.srcPath, before.get(candidate.srcPath));
    const descriptor = {
      ...baseDescriptor,
      apply: applyWithRollbackFailure,
    };
    const report = createPatchReport();
    assert.throws(
      () => captureWarns(() =>
        applyExtractedAppPatchDescriptors(
          candidate.extractedDir,
          [descriptor],
          {},
          report,
          descriptor.phase,
        ),
      ),
      (error) => error?.code === "PATCH_INTEGRITY_FAILURE",
    );
    const [failure] = criticalFailuresFromReport(report);
    assert.equal(failure?.name, descriptor.id);
    assert.equal(failure?.status, "failed-integrity");
    assert.match(
      failure?.reason ?? "",
      /rollback byte verification failed.*rollback write also failed: simulated rollback failure/,
    );
    assert.deepEqual(optionalDriftFromReport(report), []);
  } finally {
    fs.rmSync(candidate.extractedDir, { recursive: true, force: true });
  }
});

test("rejects partial Electron 42 Browser Use runtime markers", () => {
  const patched = applyLinuxChromeNativeHostRuntimePatch(
    electron42BrowserUseRuntimeResolverBundleFixture(),
  );
  const variants = [
    patched.replace("`linux-path`", "`linux-path-corrupt`"),
    patched.replace("`linux-node-runtime`", "`linux-node-runtime-corrupt`"),
    patched.replace("`linux-node-repl-runtime`", "`linux-node-repl-runtime-corrupt`"),
    patched.replace(
      "codexLinuxChromeNativeHostRuntimeFile(u,[[`node-runtime`",
      "codexLinuxChromeNativeHostRuntimeFileCorrupt(u,[[`node-runtime`",
    ),
  ];
  for (const source of variants) {
    const { value, warnings } = captureWarns(() =>
      applyLinuxChromeNativeHostRuntimePatch(source),
    );
    assert.equal(value, source);
    assert.equal(warnings.length, 1);
  }
});

test("reports drifted current Chrome runtime assets as optional drift", () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-patch-report-chrome-runtime-drift-"),
  );
  try {
    const buildDir = path.join(tempRoot, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(
      path.join(buildDir, "main.js"),
      electron42BrowserUseRuntimeResolverBundleFixture().replace(
        "resourcesPath:l}){let u=l??",
        "resourcesPath:l}){const u=l??",
      ),
    );
    fs.writeFileSync(
      path.join(buildDir, "src.js"),
      currentChromePluginAppServerSourceBundleFixture(),
    );

    const report = createPatchReport();
    captureWarns(() => patchExtractedApp(tempRoot, { report }));
    const runtimePatch = report.patches.find(
      ({ name }) => name === "linux-chrome-native-host-runtime",
    );
    assert.equal(runtimePatch.status, "skipped-optional");
    assert.ok(
      !validateReport(report, "upstream-build").some((failure) =>
        failure.startsWith("linux-chrome-native-host-runtime:"),
      ),
    );
    assert.ok(
      optionalDriftFromReport(report).some(
        ({ name }) => name === "linux-chrome-native-host-runtime",
      ),
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
