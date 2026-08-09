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

const CHROME_EXTENSION_ID = "hehggadaopoacecdllhhajmbjkdcmajg";

function createChromeRuntimeCaches(root, arch = process.arch) {
  const codexHome = path.join(root, "codex-home");
  const installedRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    "openai-bundled",
    "chrome",
  );
  const installedVersion = path.join(installedRoot, "26.test");
  const installedHost = path.join(
    installedVersion,
    "extension-host",
    "linux",
    arch,
    "extension-host",
  );
  fs.mkdirSync(path.dirname(installedHost), { recursive: true });
  fs.writeFileSync(installedHost, "TAMPERED_INSTALLED_HOST\n");
  fs.symlinkSync("26.test", path.join(installedRoot, "latest"));

  const runtimeRoot = path.join(
    codexHome,
    "plugins",
    "linux-runtime-cache",
    "openai-bundled",
    "chrome",
  );
  const runtimeVersion = path.join(runtimeRoot, "26.test");
  const runtimeHost = path.join(
    runtimeVersion,
    "extension-host",
    "linux",
    arch,
    "extension-host",
  );
  const runtimeScripts = path.join(runtimeVersion, "scripts");
  fs.mkdirSync(path.dirname(runtimeHost), { recursive: true });
  fs.mkdirSync(runtimeScripts, { recursive: true });
  fs.writeFileSync(runtimeHost, "TRUSTED_RUNTIME_HOST\n");
  fs.writeFileSync(
    path.join(runtimeScripts, "extension-ids.json"),
    `${JSON.stringify({ extensionIds: [CHROME_EXTENSION_ID] })}\n`,
  );
  fs.writeFileSync(path.join(runtimeScripts, "browser-client.mjs"), "TRUSTED_BROWSER_CLIENT\n");
  fs.symlinkSync("26.test", path.join(runtimeRoot, "latest"));

  for (const target of [
    codexHome,
    path.join(codexHome, "plugins"),
    path.join(codexHome, "plugins", "linux-runtime-cache"),
    path.join(codexHome, "plugins", "linux-runtime-cache", "openai-bundled"),
    runtimeRoot,
    runtimeVersion,
    path.join(runtimeVersion, "extension-host"),
    path.join(runtimeVersion, "extension-host", "linux"),
    path.dirname(runtimeHost),
    runtimeScripts,
  ]) {
    fs.chmodSync(target, 0o755);
  }
  fs.chmodSync(runtimeHost, 0o755);
  fs.chmodSync(path.join(runtimeScripts, "extension-ids.json"), 0o644);
  fs.chmodSync(path.join(runtimeScripts, "browser-client.mjs"), 0o644);

  return {
    arch,
    codexHome,
    installedHost,
    installedLatest: path.join(installedRoot, "latest"),
    installedRoot,
    installedVersion,
    runtimeHost,
    runtimeLatest: path.join(runtimeRoot, "latest"),
    runtimeVersion,
  };
}

function registerChromeRuntime(
  patched,
  fixture,
  geteuid = () => process.geteuid(),
  arch = fixture.arch,
  requireFn = require,
) {
  return vm.runInNewContext(
    `${patched};cq({codexHome:${JSON.stringify(fixture.codexHome)},extensionIds:["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],nativeHostName:"com.openai.codexextension",pluginRoot:${JSON.stringify(fixture.installedLatest)}});`,
    {
      process: {
        geteuid,
        platform: "linux",
        arch,
      },
      require: requireFn,
    },
  );
}

function removeChromeRegistryEntries(
  patched,
  entries,
  {
    codexHome,
    nativeHostName = "com.openai.codexextension",
    platform = "linux",
    pluginCacheRoot = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
    ),
  },
) {
  return vm.runInNewContext(
    `${patched};Eq({codexHome:${JSON.stringify(codexHome)},entries:${JSON.stringify(entries)},nativeHostName:${JSON.stringify(nativeHostName)},pluginCacheRoot:${JSON.stringify(pluginCacheRoot)}});`,
    {
      process: { platform },
      require,
    },
  );
}

function writeChromeNativeHostManifest(root, name, extensionHostPath) {
  const manifestPath = path.join(root, `${name}.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ path: extensionHostPath })}\n`,
  );
  return manifestPath;
}

function removeChromePluginManifests(
  patched,
  {
    codexHome,
    manifestPaths,
    marketplaceName = "openai-bundled",
    platform = "linux",
    pluginName = "chrome",
  },
) {
  return vm.runInNewContext(
    `${patched};Sq({codexHome:${JSON.stringify(codexHome)},marketplaceName:${JSON.stringify(marketplaceName)},pluginName:${JSON.stringify(pluginName)}});`,
    {
      fixtureManifestPaths: manifestPaths,
      process: { platform },
      require,
    },
  );
}

function discoverChromePluginManifests(
  patched,
  {
    codexHome,
    manifestPaths,
    platform = "linux",
    pluginCacheRoot = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
    ),
  },
) {
  return vm.runInNewContext(
    `${patched};nJ({codexHome:${JSON.stringify(codexHome)},nativeHostName:"com.openai.codexextension",pluginCacheRoot:${JSON.stringify(pluginCacheRoot)}});`,
    {
      fixtureManifestPaths: manifestPaths,
      process: { platform },
      require,
    },
  );
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
    assert.match(srcPatched, /codexLinuxChromePluginRuntimeConfig/);
    assert.match(
      srcPatched,
      /codexLinuxChromePluginRegistryEntryMatchesDurableRuntime/,
    );
    assert.match(
      srcPatched,
      /\/\*codexLinuxChromePluginManifestRemoval\*\/async function Sq/,
    );
    assert.match(
      srcPatched,
      /nJ\(\{codexHome:e\.codexHome,nativeHostName:t,pluginCacheRoot:r\}\)/,
    );
    assert.match(
      srcPatched,
      /rJ\(\{codexHome:e\.codexHome,manifestPath:t,pluginCacheRoot:e\.pluginCacheRoot\}\)/,
    );
    assert.match(
      srcPatched,
      /codexLinuxChromePluginPathMatchesDurableRuntime\(t\.data\.path,e,bJ\)/,
    );

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

test("registers the durable trusted Linux runtime cache instead of the installed cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-runtime-trust-"));
  try {
    const fixture = createChromeRuntimeCaches(root);
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );
    const result = await registerChromeRuntime(patched, fixture);

    const runtimeHost = path.join(
      fixture.runtimeLatest,
      "extension-host",
      "linux",
      fixture.arch,
      "extension-host",
    );
    const runtimeBrowserClient = path.join(
      fixture.runtimeLatest,
      "scripts",
      "browser-client.mjs",
    );
    assert.equal(result.extensionHostPath, runtimeHost);
    assert.equal(
      result.browserClientPath,
      runtimeBrowserClient,
    );
    assert.equal(fs.statSync(fixture.installedRoot).mode & 0o022, 0);
    assert.equal(
      fs.existsSync(path.join(fixture.installedRoot, ".codex-linux-runtime")),
      false,
    );
    assert.deepEqual(
      {
        dev: fs.statSync(runtimeHost).dev,
        ino: fs.statSync(runtimeHost).ino,
      },
      {
        dev: fs.statSync(fixture.runtimeHost).dev,
        ino: fs.statSync(fixture.runtimeHost).ino,
      },
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(result.extensionIds)),
      [CHROME_EXTENSION_ID],
    );
    assert.equal(fs.readFileSync(fixture.installedHost, "utf8"), "TAMPERED_INSTALLED_HOST\n");
    assert.equal(fs.readFileSync(fixture.runtimeHost, "utf8"), "TRUSTED_RUNTIME_HOST\n");

    fs.rmSync(fixture.installedRoot, { recursive: true, force: true });
    assert.equal(fs.readFileSync(result.extensionHostPath, "utf8"), "TRUSTED_RUNTIME_HOST\n");
    assert.equal(fs.readFileSync(result.browserClientPath, "utf8"), "TRUSTED_BROWSER_CLIENT\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit removal deletes matching durable and managed-cache registry entries only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-runtime-remove-"));
  try {
    const fixture = createChromeRuntimeCaches(root);
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );
    const registered = await registerChromeRuntime(patched, fixture);
    const entries = [
      {
        id: "durable",
        nativeHostNames: ["com.openai.codexextension"],
        paths: { extensionHostPath: registered.extensionHostPath },
      },
      {
        id: "managed-cache",
        nativeHostNames: ["com.openai.codexextension"],
        paths: { extensionHostPath: fixture.installedHost },
      },
      {
        id: "unrelated-path",
        nativeHostNames: ["com.openai.codexextension"],
        paths: { extensionHostPath: path.join(root, "unrelated", "extension-host") },
      },
      {
        id: "unrelated-host",
        nativeHostNames: ["com.openai.codexextension.dev"],
        paths: { extensionHostPath: registered.extensionHostPath },
      },
    ];

    const remaining = removeChromeRegistryEntries(patched, entries, fixture);
    assert.deepEqual(
      Array.from(remaining, ({ id }) => id),
      ["unrelated-path", "unrelated-host"],
    );

    const otherPluginRoot = path.join(
      fixture.codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "other",
    );
    const crossPluginRemaining = removeChromeRegistryEntries(
      patched,
      entries,
      { codexHome: fixture.codexHome, pluginCacheRoot: otherPluginRoot },
    );
    assert.deepEqual(
      Array.from(crossPluginRemaining, ({ id }) => id),
      entries.map(({ id }) => id),
    );

    const nonLinuxRemaining = removeChromeRegistryEntries(
      patched,
      entries,
      { codexHome: fixture.codexHome, platform: "darwin" },
    );
    assert.deepEqual(
      Array.from(nonLinuxRemaining, ({ id }) => id),
      ["durable", "unrelated-path", "unrelated-host"],
    );

    const missingHome = path.join(root, "missing-home");
    const missingHomeRemaining = removeChromeRegistryEntries(
      patched,
      [entries[0]],
      { codexHome: missingHome },
    );
    assert.deepEqual(Array.from(missingHomeRemaining, ({ id }) => id), ["durable"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit removal deletes matching durable and managed native-messaging manifests only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-manifest-remove-"));
  try {
    const fixture = createChromeRuntimeCaches(root);
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );
    const registered = await registerChromeRuntime(patched, fixture);
    const manifestRoot = path.join(root, "native-messaging-hosts");
    const durableManifest = writeChromeNativeHostManifest(
      manifestRoot,
      "durable",
      registered.extensionHostPath,
    );
    const managedManifest = writeChromeNativeHostManifest(
      manifestRoot,
      "managed",
      fixture.installedHost,
    );
    const unrelatedManifest = writeChromeNativeHostManifest(
      manifestRoot,
      "unrelated",
      path.join(root, "unrelated", "extension-host"),
    );

    await removeChromePluginManifests(patched, {
      codexHome: fixture.codexHome,
      manifestPaths: [durableManifest, managedManifest, unrelatedManifest],
    });
    assert.deepEqual(
      [durableManifest, managedManifest, unrelatedManifest].map((manifestPath) =>
        fs.existsSync(manifestPath)
      ),
      [false, false, true],
    );

    const nonLinuxDurableManifest = writeChromeNativeHostManifest(
      manifestRoot,
      "non-linux-durable",
      registered.extensionHostPath,
    );
    const nonLinuxManagedManifest = writeChromeNativeHostManifest(
      manifestRoot,
      "non-linux-managed",
      fixture.installedHost,
    );
    await removeChromePluginManifests(patched, {
      codexHome: fixture.codexHome,
      manifestPaths: [nonLinuxDurableManifest, nonLinuxManagedManifest],
      platform: "darwin",
    });
    assert.deepEqual(
      [nonLinuxDurableManifest, nonLinuxManagedManifest].map((manifestPath) =>
        fs.existsSync(manifestPath)
      ),
      [true, false],
    );

    const crossPluginManifest = writeChromeNativeHostManifest(
      manifestRoot,
      "cross-plugin",
      registered.extensionHostPath,
    );
    const crossPluginMatches = await discoverChromePluginManifests(patched, {
      codexHome: fixture.codexHome,
      manifestPaths: [crossPluginManifest],
      pluginCacheRoot: path.join(
        fixture.codexHome,
        "plugins",
        "cache",
        "openai-bundled",
        "other",
      ),
    });
    assert.deepEqual(Array.from(crossPluginMatches), []);
    assert.equal(fs.existsSync(crossPluginManifest), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps durable registration with a symlinked CODEX_HOME", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-runtime-home-link-"));
  try {
    const fixture = createChromeRuntimeCaches(root);
    const lexicalCodexHome = path.join(root, "codex-home-link");
    fs.symlinkSync(fixture.codexHome, lexicalCodexHome, "dir");
    fixture.codexHome = lexicalCodexHome;
    fixture.installedLatest = path.join(
      lexicalCodexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
      "latest",
    );
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );
    const result = await registerChromeRuntime(patched, fixture);
    const pluginCacheRoot = path.join(
      lexicalCodexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "chrome",
    );

    assert.equal(
      result.extensionHostPath,
      path.join(
        fixture.runtimeLatest,
        "extension-host",
        "linux",
        fixture.arch,
        "extension-host",
      ),
    );
    assert.equal(
      result.browserClientPath,
      path.join(fixture.runtimeLatest, "scripts", "browser-client.mjs"),
    );
    fs.rmSync(pluginCacheRoot, { recursive: true, force: true });
    assert.equal(fs.existsSync(result.extensionHostPath), true);
    assert.equal(fs.existsSync(result.browserClientPath), true);

    const remaining = removeChromeRegistryEntries(
      patched,
      [
        {
          id: "durable",
          nativeHostNames: ["com.openai.codexextension"],
          paths: { extensionHostPath: result.extensionHostPath },
        },
        {
          id: "unrelated",
          nativeHostNames: ["com.openai.codexextension"],
          paths: { extensionHostPath: path.join(root, "unrelated", "extension-host") },
        },
      ],
      { codexHome: lexicalCodexHome, pluginCacheRoot },
    );
    assert.deepEqual(Array.from(remaining, ({ id }) => id), ["unrelated"]);

    const manifestPath = writeChromeNativeHostManifest(
      path.join(root, "native-messaging-hosts"),
      "symlinked-home",
      result.extensionHostPath,
    );
    await removeChromePluginManifests(patched, {
      codexHome: lexicalCodexHome,
      manifestPaths: [manifestPath],
    });
    assert.equal(fs.existsSync(manifestPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registers the trusted arm64 runtime host", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-runtime-arm64-"));
  try {
    const fixture = createChromeRuntimeCaches(root, "arm64");
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );
    const result = await registerChromeRuntime(
      patched,
      fixture,
      () => process.geteuid(),
      "arm64",
    );

    assert.equal(result.extensionHostPath.includes("/linux/arm64/"), true);
    assert.deepEqual(
      {
        dev: fs.statSync(result.extensionHostPath).dev,
        ino: fs.statSync(result.extensionHostPath).ino,
      },
      {
        dev: fs.statSync(fixture.runtimeHost).dev,
        ino: fs.statSync(fixture.runtimeHost).ino,
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a writable Linux Chrome runtime cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-runtime-writable-"));
  try {
    const fixture = createChromeRuntimeCaches(root);
    fs.chmodSync(fixture.runtimeHost, 0o775);
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );

    await assert.rejects(
      registerChromeRuntime(patched, fixture),
      /Linux Chrome plugin runtime is not trusted/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a foreign-owned or symlinked Linux Chrome runtime cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-chrome-runtime-owner-"));
  try {
    const fixture = createChromeRuntimeCaches(root);
    const patched = applyLinuxChromeNativeHostRuntimePatch(
      currentChromePluginAppServerSourceBundleFixture(),
    );

    await assert.rejects(
      registerChromeRuntime(patched, fixture, () => process.geteuid() + 1),
      /Linux Chrome plugin runtime (?:link |parent )?is not trusted/,
    );

    fs.symlinkSync("extension-ids.json", path.join(fixture.runtimeVersion, "unsafe-link"));
    await assert.rejects(
      registerChromeRuntime(patched, fixture),
      /Linux Chrome plugin runtime is not trusted/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
      patchedSource.replace(
        "||codexLinuxChromePluginRegistryEntryMatchesDurableRuntime(n,t,bJ)",
        "",
      ),
      patchedSource.replace(
        "||codexLinuxChromePluginPathMatchesDurableRuntime(t.data.path,e,bJ)",
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
