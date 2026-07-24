#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  defaultBuildFromSource,
  discoverBundledNodeHid,
  inspectElf,
  loadSourceBuildToolchain,
  selectPrebuild,
  stageCodexMicroNativeBinding,
} = require("./native-binding.js");
const {
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_MARKER,
  applyCodexMicroFeatureGatePatch,
  descriptors,
  exportedFeatureGateHook,
  matchesCodexMicroFeatureGateContract,
} = require("./patch.js");
const {
  enabledLinuxFeaturePackageDependencies,
  enabledLinuxFeaturePackageFiles,
  loadLinuxFeaturePatchDescriptors,
  stageEnabledLinuxFeaturePackageResources,
} = require("../../scripts/lib/linux-features.js");

const NODE_HID_INTEGRITY =
  "sha512-j+dFgJLRAE0nufQKXk3IfS6T6YuHhCgMvz4TrG0sgtb6DSCdYpfJ1etcdmeCmPQjUgO+yo32ktVrRliNs/+fmg==";
const FIXTURE_NODE_HID_LOADER =
  "module.exports = require('pkg-prebuilds')(__dirname); // bundled loader\n";
const FIXTURE_NODE_HID_OPTIONS =
  "module.exports = { name: 'HID', tags: ['backend'] }; // bundled options\n";
const CURRENT_ARTIFACT = Object.freeze({
  name: "node-hid",
  version: "3.3.0",
  license: "(MIT OR X11)",
  integrity: NODE_HID_INTEGRITY,
  shasum: "2b00639e8bb9fc96592e8366fda7ae380826a7ee",
  loaderContract: Object.freeze({
    main: "./nodehid.js",
    napiVersions: Object.freeze([4]),
    files: Object.freeze({
      "nodehid.js": "84053a6ea19b238e61368f5220a9a8af96b27e752569f14d63dba2127a37988b",
      "binding-options.js": "e7c820107f3b6571ca1505a5ffbe17511088336e4c410ec718ea9ec200c6b1e6",
    }),
  }),
  prebuilds: Object.freeze({
    x64: Object.freeze({
      path: "prebuilds/HID_hidraw-linux-x64/node-napi-v4.node",
      sha256: "6c7f3b3fcc238a74e7e3237b50b2ff05181e94862b1963e8074ff8fc75885021",
    }),
    arm64: Object.freeze({
      path: "prebuilds/HID_hidraw-linux-arm64/node-napi-v4.node",
      sha256: "06ea97f377e2246a1e9bf3770186727e72ff3c166579d9c259c6d32a07aeaa60",
    }),
  }),
});

function currentFeatureGateFixture() {
  return [
    "const warning=`useFeatureGate hook failed to find a valid StatsigClient`;",
    "function Lh(){return zh().isLoading}",
    "function Rh(e){return bnt(),Bo(Fh,e)}",
    "function zh(){return bnt(),client()}",
    "export{zh as c,Lh as flt,Rh as rlt};",
  ].join("");
}

test("Codex Micro locally enables only its upstream feature gate", () => {
  const source = currentFeatureGateFixture();
  const hook = exportedFeatureGateHook(source);

  assert.deepEqual(hook, {
    source: "function Rh(e){return bnt(),Bo(Fh,e)}",
    hookName: "Rh",
    argumentName: "e",
    contextHookName: "bnt",
    atomReadName: "Bo",
    gateAtomName: "Fh",
  });
  assert.equal(matchesCodexMicroFeatureGateContract(source), true);

  const patched = applyCodexMicroFeatureGatePatch(source);
  assert.match(
    patched,
    new RegExp(
      `function Rh\\(e\\)\\{return bnt\\(\\),Bo\\(Fh,e\\)\\|\\|` +
        `e===\\\`${CODEX_MICRO_GATE_ID}\\\`/\\*${CODEX_MICRO_GATE_MARKER}\\*/\\}`,
    ),
  );
  assert.equal(applyCodexMicroFeatureGatePatch(patched), patched);
  assert.equal(matchesCodexMicroFeatureGateContract(patched), true);
  assert.doesNotMatch(patched, /e===`[^`]+`\|\|/);
});

test("Codex Micro gate patch rejects a lookalike hook that is not the shared gate export", () => {
  const source = currentFeatureGateFixture().replace(",Rh as rlt", "");

  assert.equal(exportedFeatureGateHook(source), null);
  assert.equal(matchesCodexMicroFeatureGateContract(source), false);
  assert.equal(applyCodexMicroFeatureGatePatch(source), source);
});

test("Codex Micro gate patch targets only the current app-initial bundle shape", () => {
  const descriptor = descriptors.find(({ id }) => id === "webview-feature-gate");

  assert.ok(descriptor);
  assert.equal(descriptor.pattern.test("app-initial-BTphDPeq.js"), true);
  assert.equal(
    descriptor.pattern.test(
      "app-initial~avatarOverlayCompositionSurface~artifact-tab-content.electron~notebook-preview-old.js",
    ),
    false,
  );
});

test("the shipped native artifact manifest matches the focused-test contract", () => {
  const shipped = JSON.parse(fs.readFileSync(
    path.join(__dirname, "native-artifacts.json"),
    "utf8",
  ));
  assert.deepEqual(shipped, CURRENT_ARTIFACT);
});

test("the source-build toolchain is fully integrity-pinned", () => {
  const toolchain = loadSourceBuildToolchain();
  const manifest = JSON.parse(fs.readFileSync(toolchain.packageJsonPath, "utf8"));
  const lock = JSON.parse(fs.readFileSync(toolchain.packageLockPath, "utf8"));

  assert.deepEqual(manifest.dependencies, {
    "@electron/rebuild": "4.0.4",
    "node-addon-api": "3.2.1",
    "pkg-prebuilds": "1.0.0",
  });
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.match(toolchain.lockSha256, /^[0-9a-f]{64}$/);
});

test("the source-build toolchain rejects an unpinned transitive artifact", (t) => {
  const root = tempDirectory(t, "codex-micro-unpinned-toolchain-");
  const toolchainDir = path.join(root, "source-build");
  fs.cpSync(path.join(__dirname, "source-build"), toolchainDir, { recursive: true });
  const lockPath = path.join(toolchainDir, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  delete lock.packages["node_modules/@electron/rebuild"].integrity;
  writeJson(lockPath, lock);

  assert.throws(
    () => loadSourceBuildToolchain(toolchainDir),
    /lock entry is not integrity-pinned.*@electron\/rebuild/i,
  );
});

const DEVICE_KIT_RELATIVE = path.join(
  "node_modules",
  "@worklouder",
  "device-kit-oai",
);
const WORK_LOUDER_KIT_RELATIVE = path.join(
  DEVICE_KIT_RELATIVE,
  "node_modules",
  "@worklouder",
  "wl-device-kit",
);
const NODE_HID_RELATIVE = path.join(
  WORK_LOUDER_KIT_RELATIVE,
  "node_modules",
  "node-hid",
);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(filePath, contents, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, mode == null ? undefined : { mode });
}

function tempDirectory(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function makeElf(arch, marker = arch) {
  const machines = { x64: 62, arm64: 183 };
  const machine = machines[arch];
  if (machine == null) {
    throw new Error(`Unsupported ELF fixture architecture: ${arch}`);
  }

  const contents = Buffer.alloc(128);
  contents.set([0x7f, 0x45, 0x4c, 0x46], 0);
  contents[4] = 2; // ELFCLASS64
  contents[5] = 1; // ELFDATA2LSB
  contents[6] = 1; // EV_CURRENT
  contents.writeUInt16LE(3, 16); // ET_DYN
  contents.writeUInt16LE(machine, 18);
  contents.writeUInt32LE(1, 20);
  contents.write(marker, 64, "utf8");
  return contents;
}

function bindingRelativePath(arch) {
  return path.join(
    "prebuilds",
    `HID_hidraw-linux-${arch}`,
    "node-napi-v4.node",
  );
}

function createBundledFixture(t, options = {}) {
  const root = tempDirectory(t, "codex-micro-bundled-");
  const extractedDir = path.join(root, "app-extracted");
  const deviceKitDir = path.join(extractedDir, DEVICE_KIT_RELATIVE);
  const workLouderKitDir = path.join(extractedDir, WORK_LOUDER_KIT_RELATIVE);
  const nodeHidDir = path.join(extractedDir, NODE_HID_RELATIVE);

  fs.mkdirSync(extractedDir, { recursive: true });
  if (options.includeDeviceKit !== false) {
    writeJson(path.join(deviceKitDir, "package.json"), {
      name: "@worklouder/device-kit-oai",
      version: "0.4.0",
      dependencies: { "@worklouder/wl-device-kit": "0.12.0" },
    });
    writeFile(path.join(deviceKitDir, "dist/index.js"), "device-kit-oai bundled bytes\n");
  }
  if (options.includeDeviceKit !== false && options.includeWorkLouderKit !== false) {
    writeJson(path.join(workLouderKitDir, "package.json"), {
      name: "@worklouder/wl-device-kit",
      version: "0.12.0",
      dependencies: { "node-hid": options.bundledVersion ?? "3.3.0" },
    });
    writeFile(path.join(workLouderKitDir, "dist/index.js"), "wl-device-kit bundled bytes\n");
  }
  if (
    options.includeDeviceKit !== false &&
    options.includeWorkLouderKit !== false &&
    options.includeNodeHid !== false
  ) {
    writeJson(path.join(nodeHidDir, "package.json"), {
      name: "node-hid",
      version: options.bundledVersion ?? "3.3.0",
      license: "(MIT OR X11)",
      main: "./nodehid.js",
      binary: { napi_versions: [4] },
    });
    writeFile(path.join(nodeHidDir, "nodehid.js"), FIXTURE_NODE_HID_LOADER);
    writeFile(path.join(nodeHidDir, "binding-options.js"), FIXTURE_NODE_HID_OPTIONS);
    writeFile(
      path.join(nodeHidDir, "prebuilds/HID-darwin-arm64/node-napi-v4.node"),
      "bundled Mach-O bytes",
    );
  }

  // Neither a hoisted package nor a node-hid nested at the wrong Work Louder
  // level is the dependency used by the current codex-micro service.
  writeJson(path.join(extractedDir, "node_modules/node-hid/package.json"), {
    name: "node-hid",
    version: "99.0.0",
  });
  if (options.includeDeviceKit !== false) {
    writeJson(path.join(deviceKitDir, "node_modules/node-hid/package.json"), {
      name: "node-hid",
      version: "98.0.0",
    });
  }

  return {
    extractedDir,
    deviceKitDir,
    workLouderKitDir,
    nodeHidDir,
  };
}

function fixtureArtifact(binaries = {}) {
  const x64 = binaries.x64 ?? makeElf("x64", "fixture-x64");
  const arm64 = binaries.arm64 ?? makeElf("arm64", "fixture-arm64");
  return {
    ...CURRENT_ARTIFACT,
    loaderContract: {
      main: "./nodehid.js",
      napiVersions: [4],
      files: {
        "nodehid.js": sha256(FIXTURE_NODE_HID_LOADER),
        "binding-options.js": sha256(FIXTURE_NODE_HID_OPTIONS),
      },
    },
    prebuilds: {
      x64: {
        path: CURRENT_ARTIFACT.prebuilds.x64.path,
        sha256: sha256(x64),
      },
      arm64: {
        path: CURRENT_ARTIFACT.prebuilds.arm64.path,
        sha256: sha256(arm64),
      },
    },
  };
}

function createMaterializedPackage(t, options = {}) {
  const packageDir = path.join(
    tempDirectory(t, "codex-micro-node-hid-artifact-"),
    "package",
  );
  const packageMetadata = {
    name: "node-hid",
    version: "3.3.0",
    license: "(MIT OR X11)",
    main: "nodehid.js",
    scripts: { install: "this must never be run" },
    ...options.packageMetadata,
  };
  writeJson(path.join(packageDir, "package.json"), packageMetadata);
  writeFile(path.join(packageDir, "nodehid.js"), "throw new Error('artifact JS must not be copied');\n");
  writeFile(path.join(packageDir, "README.md"), "artifact documentation must not be copied\n");
  writeFile(path.join(packageDir, "src/hid.cc"), "artifact source must not be copied\n");

  for (const [arch, binary] of Object.entries(options.binaries ?? {})) {
    writeFile(path.join(packageDir, bindingRelativePath(arch)), binary, 0o755);
  }
  return packageDir;
}

function bundledSnapshots(fixture) {
  return new Map(
    [
      "package.json",
      "nodehid.js",
      "binding-options.js",
      "prebuilds/HID-darwin-arm64/node-napi-v4.node",
    ].map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(fixture.nodeHidDir, relativePath)),
    ]),
  );
}

function assertBundledSnapshots(fixture, snapshots) {
  for (const [relativePath, expected] of snapshots) {
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.nodeHidDir, relativePath)),
      expected,
      `${relativePath} changed`,
    );
  }
}

async function assertStageRejects(options, expected) {
  await assert.rejects(
    async () => stageCodexMicroNativeBinding(options),
    expected,
  );
}

test("discovers only the current nested Work Louder node-hid package", (t) => {
  const fixture = createBundledFixture(t);

  const discovered = discoverBundledNodeHid(fixture.extractedDir);

  assert.equal(discovered.deviceKitDir, fixture.deviceKitDir);
  assert.equal(discovered.workLouderKitDir, fixture.workLouderKitDir);
  assert.equal(discovered.nodeHidDir, fixture.nodeHidDir);
  assert.equal(discovered.name, "node-hid");
  assert.equal(discovered.version, "3.3.0");
  assert.equal(discovered.license, "(MIT OR X11)");
});

test("missing Work Louder packages are reported as upstream drift", (t) => {
  const missingOuter = createBundledFixture(t, { includeDeviceKit: false });
  assert.throws(
    () => discoverBundledNodeHid(missingOuter.extractedDir),
    /Work Louder.*device-kit-oai|device-kit-oai.*missing/i,
  );

  const missingNested = createBundledFixture(t, { includeWorkLouderKit: false });
  assert.throws(
    () => discoverBundledNodeHid(missingNested.extractedDir),
    /Work Louder.*wl-device-kit|wl-device-kit.*missing/i,
  );
});

test("missing nested node-hid is reported without accepting a hoisted decoy", (t) => {
  const fixture = createBundledFixture(t, { includeNodeHid: false });

  assert.throws(
    () => discoverBundledNodeHid(fixture.extractedDir),
    /nested node-hid|node-hid.*missing/i,
  );
});

test("same-version node-hid loader drift rejects candidate staging", async (t) => {
  const fixture = createBundledFixture(t);
  writeFile(
    path.join(fixture.nodeHidDir, "nodehid.js"),
    "module.exports = require('./unexpected-loader');\n",
  );

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "x64",
      electronVersion: "42.1.0",
      artifactManifest: fixtureArtifact(),
      materializePackage: async () => {
        throw new Error("loader drift must fail before materialization");
      },
    },
    /loader contract hash mismatch.*nodehid\.js/i,
  );
});

test("same-version node-hid N-API metadata drift rejects candidate staging", async (t) => {
  const fixture = createBundledFixture(t);
  const packagePath = path.join(fixture.nodeHidDir, "package.json");
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  metadata.binary.napi_versions = [5];
  writeJson(packagePath, metadata);

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "x64",
      electronVersion: "42.1.0",
      artifactManifest: fixtureArtifact(),
      materializePackage: async () => {
        throw new Error("N-API drift must fail before materialization");
      },
    },
    /N-API contract mismatch/i,
  );
});

test("selects the exact node-hid 3.3.0 hidraw prebuild for x64", () => {
  const selected = selectPrebuild(CURRENT_ARTIFACT, "x64");

  assert.equal(selected.path, "prebuilds/HID_hidraw-linux-x64/node-napi-v4.node");
  assert.equal(
    selected.sha256,
    "6c7f3b3fcc238a74e7e3237b50b2ff05181e94862b1963e8074ff8fc75885021",
  );
});

test("selects the exact node-hid 3.3.0 hidraw prebuild for arm64", () => {
  const selected = selectPrebuild(CURRENT_ARTIFACT, "arm64");

  assert.equal(selected.path, "prebuilds/HID_hidraw-linux-arm64/node-napi-v4.node");
  assert.equal(
    selected.sha256,
    "06ea97f377e2246a1e9bf3770186727e72ff3c166579d9c259c6d32a07aeaa60",
  );
});

test("prebuild selection distinguishes unavailable artifacts from unsupported architectures", () => {
  const unavailable = { ...CURRENT_ARTIFACT, prebuilds: { arm64: CURRENT_ARTIFACT.prebuilds.arm64 } };

  assert.equal(selectPrebuild(unavailable, "x64"), null);
  assert.throws(
    () => selectPrebuild(CURRENT_ARTIFACT, "riscv64"),
    /unsupported.*architecture.*riscv64/i,
  );
});

for (const arch of ["x64", "arm64"]) {
  test(`stages the verified ${arch} prebuild at the nested loader path`, async (t) => {
    const binary = makeElf(arch, `stage-${arch}`);
    const artifactManifest = fixtureArtifact({ [arch]: binary });
    const fixture = createBundledFixture(t);
    const packageDir = createMaterializedPackage(t, { binaries: { [arch]: binary } });
    const materializeCalls = [];
    let buildCalls = 0;

    const result = await stageCodexMicroNativeBinding({
      extractedDir: fixture.extractedDir,
      arch,
      electronVersion: "42.1.0",
      artifactManifest,
      materializePackage: async (request) => {
        materializeCalls.push(request);
        return { packageDir, integrity: NODE_HID_INTEGRITY };
      },
      buildFromSource: async () => {
        buildCalls += 1;
        throw new Error("source build should not run when a prebuild exists");
      },
    });

    const targetPath = path.join(fixture.nodeHidDir, bindingRelativePath(arch));
    assert.deepEqual(materializeCalls, [
      { name: "node-hid", version: "3.3.0", integrity: NODE_HID_INTEGRITY },
    ]);
    assert.equal(buildCalls, 0);
    assert.deepEqual(fs.readFileSync(targetPath), binary);
    assert.equal(result.changed, true);
    assert.equal(result.alreadyApplied, false);
    assert.equal(result.version, "3.3.0");
    assert.equal(result.targetPath, targetPath);
    assert.equal(result.source, "prebuild");
    assert.equal(result.integrity, NODE_HID_INTEGRITY);
  });
}

test("copies only the selected native subtree and preserves bundled JS byte-for-byte", async (t) => {
  const binary = makeElf("x64", "native-only");
  const artifactManifest = fixtureArtifact({ x64: binary });
  const fixture = createBundledFixture(t);
  const snapshots = bundledSnapshots(fixture);
  const packageDir = createMaterializedPackage(t, {
    binaries: {
      x64: binary,
      arm64: makeElf("arm64", "must-not-copy-arm64"),
    },
  });

  await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    electronVersion: "42.1.0",
    artifactManifest,
    materializePackage: async () => ({ packageDir, integrity: NODE_HID_INTEGRITY }),
    buildFromSource: async () => {
      throw new Error("unexpected source build");
    },
  });

  assertBundledSnapshots(fixture, snapshots);
  assert.equal(fs.existsSync(path.join(fixture.nodeHidDir, "README.md")), false);
  assert.equal(fs.existsSync(path.join(fixture.nodeHidDir, "src/hid.cc")), false);
  assert.equal(
    fs.existsSync(path.join(fixture.nodeHidDir, bindingRelativePath("arm64"))),
    false,
  );
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.nodeHidDir, bindingRelativePath("x64"))),
    binary,
  );
});

test("a hash-valid existing binding is idempotent and performs no fetch or build", async (t) => {
  const binary = makeElf("x64", "already-correct");
  const artifactManifest = fixtureArtifact({ x64: binary });
  const fixture = createBundledFixture(t);
  const targetPath = path.join(fixture.nodeHidDir, bindingRelativePath("x64"));
  writeFile(targetPath, binary, 0o755);
  const snapshots = bundledSnapshots(fixture);

  const result = await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    electronVersion: "42.1.0",
    artifactManifest,
    materializePackage: async () => {
      throw new Error("correct existing binding must not fetch");
    },
    buildFromSource: async () => {
      throw new Error("correct existing binding must not build");
    },
  });

  assert.equal(result.changed, false);
  assert.equal(result.alreadyApplied, true);
  assert.equal(result.version, "3.3.0");
  assert.equal(result.targetPath, targetPath);
  assert.equal(result.source, "existing");
  assert.equal(result.integrity, NODE_HID_INTEGRITY);
  assert.deepEqual(fs.readFileSync(targetPath), binary);
  assertBundledSnapshots(fixture, snapshots);
});

test("an unavailable prebuild invokes the injected Electron source-build fallback", async (t) => {
  const binary = makeElf("x64", "source-build");
  const artifactManifest = fixtureArtifact();
  delete artifactManifest.prebuilds.x64;
  const fixture = createBundledFixture(t);
  const toolchainDir = path.join(tempDirectory(t, "codex-micro-source-toolchain-"), "source-build");
  fs.cpSync(path.join(__dirname, "source-build"), toolchainDir, { recursive: true });
  const packageDir = createMaterializedPackage(t);
  const buildRoot = tempDirectory(t, "codex-micro-source-build-");
  const builtBindingPath = path.join(buildRoot, "build/Release/HID_hidraw.node");
  writeFile(builtBindingPath, binary, 0o755);
  const buildCalls = [];

  const result = await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    electronVersion: "42.1.0",
    sourceBuildToolchainDir: toolchainDir,
    artifactManifest,
    materializePackage: async () => ({ packageDir, integrity: NODE_HID_INTEGRITY }),
    buildFromSource: async (request) => {
      buildCalls.push(request);
      return { bindingPath: builtBindingPath };
    },
  });

  assert.equal(buildCalls.length, 1);
  assert.equal(buildCalls[0].packageDir, packageDir);
  assert.equal(buildCalls[0].name, "node-hid");
  assert.equal(buildCalls[0].version, "3.3.0");
  assert.equal(buildCalls[0].arch, "x64");
  assert.equal(buildCalls[0].electronVersion, "42.1.0");
  assert.equal(buildCalls[0].targetRelativePath, bindingRelativePath("x64"));

  const targetPath = path.join(fixture.nodeHidDir, bindingRelativePath("x64"));
  assert.deepEqual(fs.readFileSync(targetPath), binary);
  assert.equal(result.changed, true);
  assert.equal(result.alreadyApplied, false);
  assert.equal(result.targetPath, targetPath);
  assert.equal(result.source, "source-build");
  assert.equal(result.integrity, NODE_HID_INTEGRITY);

  let materializeCalls = 0;
  let repeatedBuildCalls = 0;
  const repeated = await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    electronVersion: "42.1.0",
    sourceBuildToolchainDir: toolchainDir,
    artifactManifest,
    materializePackage: async () => {
      materializeCalls += 1;
      throw new Error("valid source-build provenance must avoid materialization");
    },
    buildFromSource: async () => {
      repeatedBuildCalls += 1;
      throw new Error("valid source-build provenance must avoid recompilation");
    },
  });
  assert.equal(materializeCalls, 0);
  assert.equal(repeatedBuildCalls, 0);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.alreadyApplied, true);
  assert.equal(repeated.source, "existing-source-build");

  fs.appendFileSync(path.join(toolchainDir, "package-lock.json"), "\n");
  let lockChangeMaterializeCalls = 0;
  let lockChangeBuildCalls = 0;
  const rebuilt = await stageCodexMicroNativeBinding({
    extractedDir: fixture.extractedDir,
    arch: "x64",
    electronVersion: "42.1.0",
    sourceBuildToolchainDir: toolchainDir,
    artifactManifest,
    materializePackage: async () => {
      lockChangeMaterializeCalls += 1;
      return { packageDir, integrity: NODE_HID_INTEGRITY };
    },
    buildFromSource: async () => {
      lockChangeBuildCalls += 1;
      return { bindingPath: builtBindingPath };
    },
  });
  assert.equal(lockChangeMaterializeCalls, 1);
  assert.equal(lockChangeBuildCalls, 1);
  assert.equal(rebuilt.changed, true);
  assert.equal(rebuilt.source, "source-build");
});

test("prebuild-only environments fail before a source fallback can fetch or compile", async (t) => {
  const artifactManifest = fixtureArtifact();
  delete artifactManifest.prebuilds.x64;
  const fixture = createBundledFixture(t);
  let materializeCalls = 0;
  let buildCalls = 0;

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "x64",
      electronVersion: "42.1.0",
      requirePrebuild: true,
      artifactManifest,
      materializePackage: async () => {
        materializeCalls += 1;
      },
      buildFromSource: async () => {
        buildCalls += 1;
      },
    },
    /verified node-hid prebuild is required.*x64/i,
  );
  assert.equal(materializeCalls, 0);
  assert.equal(buildCalls, 0);
});

test("the default source builder seeds Electron rebuild with the verified node-hid package", async (t) => {
  const root = tempDirectory(t, "codex-micro-default-source-build-");
  const packageDir = path.join(root, "materialized", "package");
  const binary = makeElf("x64", "default-source-builder");
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "package.json"), {
    name: "node-hid",
    version: "3.3.0",
    license: "(MIT OR X11)",
    gypfile: true,
  });
  writeFile(path.join(packageDir, "binding.gyp"), "{}\n");
  const calls = [];
  const execute = (command, args, options) => {
    calls.push({ command, args: [...args], cwd: options?.cwd });
    if (command === "pkg-config") {
      assert.deepEqual(args, ["--exists", "libudev", "libusb-1.0"]);
      return "";
    }
    if (command === "npm") {
      assert.ok(fs.existsSync(path.join(options.cwd, "package.json")));
      assert.ok(fs.existsSync(path.join(options.cwd, "package-lock.json")));
      const cli = path.join(options.cwd, "node_modules", "@electron", "rebuild", "lib", "cli.js");
      writeFile(cli, "// deterministic electron-rebuild fixture\n");
      return "";
    }

    const value = (flag) => {
      const index = args.indexOf(flag);
      return index < 0 ? null : args[index + 1];
    };
    assert.equal(command, process.execPath);
    assert.equal(value("--which-module"), "node-hid");
    assert.equal(value("--only"), "node-hid");
    assert.ok(args.includes("--build-from-source"));
    assert.equal(value("-v"), "42.3.0");
    assert.equal(value("--arch"), "x64");
    const moduleDir = path.join(options.cwd, "node_modules", "node-hid");
    assert.ok(fs.existsSync(path.join(moduleDir, "package.json")));
    assert.ok(fs.existsSync(path.join(moduleDir, "binding.gyp")));
    writeFile(path.join(moduleDir, "build", "Release", "HID_hidraw.node"), binary, 0o755);
    return "";
  };

  let built;
  built = await defaultBuildFromSource({
    packageDir,
    name: "node-hid",
    version: "3.3.0",
    arch: "x64",
    electronVersion: "42.3.0",
    execute,
  });

  t.after(() => built?.cleanup?.());
  assert.deepEqual(fs.readFileSync(built.bindingPath), binary);
  assert.equal(calls.length, 3);
  const npmArgs = calls[1].args;
  assert.deepEqual(npmArgs, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.ok(!npmArgs.some((arg) => arg.startsWith("electron@")));
});

test("the default source builder explains missing native development prerequisites before npm", async (t) => {
  const root = tempDirectory(t, "codex-micro-source-prerequisites-");
  const packageDir = path.join(root, "package");
  writeJson(path.join(packageDir, "package.json"), {
    name: "node-hid",
    version: "3.3.0",
    license: "(MIT OR X11)",
  });
  const calls = [];

  await assert.rejects(
    defaultBuildFromSource({
      packageDir,
      name: "node-hid",
      version: "3.3.0",
      arch: "x64",
      electronVersion: "42.3.0",
      execute: (command) => {
        calls.push(command);
        throw new Error("pkg-config unavailable");
      },
    }),
    /pkg-config.*libudev.*libusb.*development packages/i,
  );
  assert.deepEqual(calls, ["pkg-config"]);
});

test("unsupported staging architectures fail before package materialization", async (t) => {
  const fixture = createBundledFixture(t);
  let materializeCalls = 0;
  let buildCalls = 0;

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "riscv64",
      electronVersion: "42.1.0",
      artifactManifest: fixtureArtifact(),
      materializePackage: async () => {
        materializeCalls += 1;
      },
      buildFromSource: async () => {
        buildCalls += 1;
      },
    },
    /unsupported.*architecture.*riscv64/i,
  );

  assert.equal(materializeCalls, 0);
  assert.equal(buildCalls, 0);
});

test("bundled node-hid version drift fails before fetch and never falls back", async (t) => {
  const fixture = createBundledFixture(t, { bundledVersion: "3.2.0" });
  let materializeCalls = 0;
  let buildCalls = 0;

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "x64",
      electronVersion: "42.1.0",
      artifactManifest: fixtureArtifact(),
      materializePackage: async () => {
        materializeCalls += 1;
      },
      buildFromSource: async () => {
        buildCalls += 1;
      },
    },
    /node-hid.*version.*3\.3\.0.*3\.2\.0|expected.*3\.3\.0.*got.*3\.2\.0/i,
  );

  assert.equal(materializeCalls, 0);
  assert.equal(buildCalls, 0);
});

for (const scenario of [
  {
    label: "package identity",
    packageMetadata: { name: "not-node-hid" },
    integrity: NODE_HID_INTEGRITY,
    expected: /node-hid.*identity|identity.*node-hid/i,
  },
  {
    label: "package version",
    packageMetadata: { version: "3.3.1" },
    integrity: NODE_HID_INTEGRITY,
    expected: /version.*3\.3\.0.*3\.3\.1|expected.*3\.3\.0.*got.*3\.3\.1/i,
  },
  {
    label: "package license",
    packageMetadata: { license: "UNLICENSED" },
    integrity: NODE_HID_INTEGRITY,
    expected: /license.*MIT OR X11|expected.*MIT OR X11.*UNLICENSED/i,
  },
  {
    label: "package integrity",
    packageMetadata: {},
    integrity: "sha512-unverified",
    expected: /integrity/i,
  },
]) {
  test(`rejects a materialized node-hid artifact with the wrong ${scenario.label}`, async (t) => {
    const binary = makeElf("x64", `wrong-${scenario.label}`);
    const artifactManifest = fixtureArtifact({ x64: binary });
    const fixture = createBundledFixture(t);
    const packageDir = createMaterializedPackage(t, {
      packageMetadata: scenario.packageMetadata,
      binaries: { x64: binary },
    });
    let buildCalls = 0;

    await assertStageRejects(
      {
        extractedDir: fixture.extractedDir,
        arch: "x64",
        electronVersion: "42.1.0",
        artifactManifest,
        materializePackage: async () => ({
          packageDir,
          integrity: scenario.integrity,
        }),
        buildFromSource: async () => {
          buildCalls += 1;
        },
      },
      scenario.expected,
    );

    assert.equal(buildCalls, 0, "metadata drift must not trigger a source build");
    assert.equal(
      fs.existsSync(path.join(fixture.nodeHidDir, bindingRelativePath("x64"))),
      false,
    );
  });
}

test("inspectElf identifies the supported 64-bit little-endian machines", () => {
  assert.equal(inspectElf(makeElf("x64")).arch, "x64");
  assert.equal(inspectElf(makeElf("arm64")).arch, "arm64");
});

test("inspectElf rejects non-ELF, 32-bit, big-endian, and unknown-machine binaries", () => {
  assert.throws(() => inspectElf(Buffer.from("not an ELF")), /ELF/i);

  const elf32 = makeElf("x64");
  elf32[4] = 1;
  assert.throws(() => inspectElf(elf32), /64-bit|ELF class/i);

  const bigEndian = makeElf("x64");
  bigEndian[5] = 2;
  assert.throws(() => inspectElf(bigEndian), /little-endian|ELF encoding/i);

  const unknownMachine = makeElf("x64");
  unknownMachine.writeUInt16LE(243, 18);
  assert.throws(() => inspectElf(unknownMachine), /unsupported.*ELF machine|machine.*243/i);
});

test("rejects a hash-valid prebuild whose ELF architecture is wrong", async (t) => {
  const arm64Binary = makeElf("arm64", "arm64-under-x64-path");
  const artifactManifest = fixtureArtifact();
  artifactManifest.prebuilds.x64.sha256 = sha256(arm64Binary);
  const fixture = createBundledFixture(t);
  const packageDir = createMaterializedPackage(t, { binaries: { x64: arm64Binary } });

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "x64",
      electronVersion: "42.1.0",
      artifactManifest,
      materializePackage: async () => ({ packageDir, integrity: NODE_HID_INTEGRITY }),
      buildFromSource: async () => {
        throw new Error("wrong architecture must not fall back");
      },
    },
    /ELF.*arm64.*x64|architecture.*arm64.*x64/i,
  );

  assert.equal(
    fs.existsSync(path.join(fixture.nodeHidDir, bindingRelativePath("x64"))),
    false,
  );
});

test("rejects a same-architecture prebuild whose SHA-256 does not match", async (t) => {
  const binary = makeElf("x64", "tampered-prebuild");
  const artifactManifest = fixtureArtifact({ x64: makeElf("x64", "expected-prebuild") });
  const fixture = createBundledFixture(t);
  const packageDir = createMaterializedPackage(t, { binaries: { x64: binary } });

  await assertStageRejects(
    {
      extractedDir: fixture.extractedDir,
      arch: "x64",
      electronVersion: "42.1.0",
      artifactManifest,
      materializePackage: async () => ({ packageDir, integrity: NODE_HID_INTEGRITY }),
      buildFromSource: async () => {
        throw new Error("hash mismatch must not fall back");
      },
    },
    /SHA-256|sha256|hash.*mismatch/i,
  );

  assert.equal(
    fs.existsSync(path.join(fixture.nodeHidDir, bindingRelativePath("x64"))),
    false,
  );
});

test("udev policy has narrow USB and Bluetooth Codex Micro hidraw rules", () => {
  const rulePath = path.join(__dirname, "resources", "70-codex-micro.rules");
  const source = fs.readFileSync(rulePath, "utf8");
  const activeRules = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  assert.equal(activeRules.length, 2, "udev policy must contain exactly two active rules");
  const [usbRule, bluetoothRule] = activeRules;
  for (const rule of activeRules) {
    assert.match(rule, /(?:^|,\s*)SUBSYSTEM=="hidraw"(?:,|$)/);
    assert.match(rule, /KERNEL=="hidraw\*"/);
    assert.match(rule, /TAG\+="uaccess"/);
    assert.match(rule, /MODE="0660"/);
  }

  assert.match(usbRule, /ENV\{ID_VENDOR_ID\}=="303a"/i);
  assert.match(usbRule, /ENV\{ID_MODEL_ID\}=="8360"/i);
  assert.match(usbRule, /ENV\{ID_USB_INTERFACE_NUM\}=="00"/);
  assert.doesNotMatch(usbRule, /KERNELS=="0005:/);

  assert.match(bluetoothRule, /KERNELS=="0005:303A:8360\.\*"/);
  assert.doesNotMatch(bluetoothRule, /ID_USB_INTERFACE_NUM/);
  assert.doesNotMatch(bluetoothRule, /HID_UNIQ|[0-9A-F]{2}(?::[0-9A-F]{2}){5}/i);

  assert.doesNotMatch(source, /MODE="0666"/);
  assert.doesNotMatch(source, /SUBSYSTEM=="usb"/);
});

test("pacman removal hook reloads only after the feature-owned rule is removed", () => {
  const hookPath = path.join(__dirname, "resources", "codex-micro-udev.hook");
  const source = fs.readFileSync(hookPath, "utf8");

  assert.match(source, /^\[Trigger\]$/m);
  assert.match(source, /^Operation = Remove$/m);
  assert.doesNotMatch(source, /^Operation = (?:Install|Upgrade)$/m);
  assert.match(source, /^Type = Path$/m);
  assert.match(source, /^Target = usr\/lib\/udev\/rules\.d\/70-codex-micro\.rules$/m);
  assert.doesNotMatch(source, /^Target = .*[*?!]/m);
  assert.match(source, /^\[Action\]$/m);
  assert.match(source, /^When = PostTransaction$/m);
  assert.match(source, /^Exec = \/bin\/sh -c ".*command -v udevadm.*--reload-rules.*\|\| true.*"$/m);
});

test("disabled codex-micro performs no patch or native package work", (t) => {
  const root = tempDirectory(t, "codex-micro-disabled-config-");
  const configPath = path.join(root, "features.json");
  writeJson(configPath, { enabled: [] });
  const frameworkOptions = {
    featuresRoot: path.resolve(__dirname, ".."),
    featuresConfigPath: configPath,
  };

  assert.deepEqual(loadLinuxFeaturePatchDescriptors(frameworkOptions), []);
  for (const packageFormat of ["deb", "rpm", "pacman"]) {
    const options = { ...frameworkOptions, packageFormat };
    assert.deepEqual(enabledLinuxFeaturePackageDependencies(options), []);
    assert.deepEqual(enabledLinuxFeaturePackageFiles(options), []);
  }
});

test("native package formats stage the exact rule and feature-only dependencies", (t) => {
  const root = tempDirectory(t, "codex-micro-package-resources-");
  const configPath = path.join(root, "features.json");
  writeJson(configPath, { enabled: ["codex-micro"] });
  const expectedDependencies = {
    deb: ["libudev1", "libusb-1.0-0"],
    rpm: [
      "libudev.so.1%{codex_elf_suffix}",
      "libusb-1.0.so.0%{codex_elf_suffix}",
    ],
    pacman: ["libusb", "systemd-libs"],
  };
  const expectedRule = fs.readFileSync(
    path.join(__dirname, "resources", "70-codex-micro.rules"),
  );
  const expectedPacmanHook = fs.readFileSync(
    path.join(__dirname, "resources", "codex-micro-udev.hook"),
  );

  for (const packageFormat of ["deb", "rpm", "pacman"]) {
    const packageRoot = path.join(root, packageFormat);
    const options = {
      featuresRoot: path.resolve(__dirname, ".."),
      featuresConfigPath: configPath,
      packageFormat,
    };
    const plan = stageEnabledLinuxFeaturePackageResources(packageRoot, options);
    const target = path.join(
      packageRoot,
      "usr",
      "lib",
      "udev",
      "rules.d",
      "70-codex-micro.rules",
    );

    assert.deepEqual(plan.dependencies, expectedDependencies[packageFormat]);
    assert.deepEqual(enabledLinuxFeaturePackageDependencies(options), expectedDependencies[packageFormat]);
    const expectedFiles = ["/usr/lib/udev/rules.d/70-codex-micro.rules"];
    if (packageFormat === "pacman") {
      expectedFiles.push("/usr/share/libalpm/hooks/codex-micro-udev.hook");
    }
    assert.deepEqual(enabledLinuxFeaturePackageFiles(options), expectedFiles);
    assert.deepEqual(fs.readFileSync(target), expectedRule);
    assert.equal(fs.statSync(target).mode & 0o777, 0o644);
    if (packageFormat === "pacman") {
      const hookTarget = path.join(
        packageRoot,
        "usr",
        "share",
        "libalpm",
        "hooks",
        "codex-micro-udev.hook",
      );
      assert.deepEqual(fs.readFileSync(hookTarget), expectedPacmanHook);
      assert.equal(fs.statSync(hookTarget).mode & 0o777, 0o644);
    }
  }
});
