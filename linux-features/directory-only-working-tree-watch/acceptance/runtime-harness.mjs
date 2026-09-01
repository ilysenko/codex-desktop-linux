import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import exclusionSmokeHelpers from "./fixtures/exclusion-smoke-helpers.cjs";
import {
  parseInstalledSmokeWaitTimeoutMs,
  releaseCallbackGateAndJoinDisposal,
  recoverStableReplacement,
  waitForInstalledSmokeCondition,
} from "./installed-package-smoke-helpers.mjs";

const { hasInvalidatedPathAtOrBelow } = exclusionSmokeHelpers;
let productionAdapterFallbackCalls = 0;

const smokeStartedAt = Date.now();
const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const options = parseOptions(
  process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1"
    ? process.argv.slice(1)
    : process.argv.slice(2),
);
logPhase("startup");
const waitTimeoutMs = parseInstalledSmokeWaitTimeoutMs(
  options["wait-timeout-ms"],
);
const projectRoot = path.resolve(options.project);
const expectedSourceCommit = process.env.WATCHBOUND_EXPECTED_SOURCE_COMMIT;
const expectedElectron = process.env.WATCHBOUND_EXPECTED_ELECTRON;
const expectedChrome = process.env.WATCHBOUND_EXPECTED_CHROME;
const expectedNode = process.env.WATCHBOUND_EXPECTED_NODE;
const expectedNodeApiMinimum = Number(
  process.env.WATCHBOUND_EXPECTED_NODE_API_MINIMUM,
);
const expectedProductionAdapterSha256 =
  process.env.WATCHBOUND_EXPECTED_PRODUCTION_ADAPTER_SHA256;
assert.match(expectedSourceCommit ?? "", /^[0-9a-f]{40}$/u);
assert.match(expectedElectron ?? "", /^\d+(?:\.\d+){2,3}$/u);
assert.match(expectedChrome ?? "", /^\d+(?:\.\d+){2,3}$/u);
assert.match(expectedNode ?? "", /^\d+\.\d+\.\d+$/u);
assert.ok(Number.isInteger(expectedNodeApiMinimum));
assert.match(expectedProductionAdapterSha256 ?? "", /^[0-9a-f]{64}$/u);
assert.equal(process.versions.electron, expectedElectron);
assert.equal(process.versions.chrome, expectedChrome);
assert.equal(process.versions.node, expectedNode);
assert.ok(Number(process.versions.napi) >= expectedNodeApiMinimum);
logPhase("runtime-identity-complete", { versions: process.versions });
const candidateIdentity = readJson(
  path.join(projectRoot, "candidate-identity.json"),
);
assert.equal(candidateIdentity.sourceCommit, expectedSourceCommit);
logPhase("candidate-identity-complete");
const productionAdapterPath = path.join(
  projectRoot,
  "watchbound-acceptance",
  "production-adapter.cjs",
);
assert.equal(sha256(productionAdapterPath), expectedProductionAdapterSha256);
const productionAdapterRequire = createRequire(productionAdapterPath);
const startProductionWatch = productionAdapterRequire(productionAdapterPath);
assert.equal(typeof startProductionWatch, "function");
const wrapperRoot = options["wrapper-path"]
  ? path.resolve(options["wrapper-path"])
  : path.join(projectRoot, "node_modules", options.wrapper);
const wrapperEntry = fs.realpathSync(path.join(wrapperRoot, "index.js"));
logPhase("wrapper-realpath-complete", { wrapperEntry });
const wrapperRequire = createRequire(wrapperEntry);
const loaderRoot = path.dirname(
  wrapperRequire.resolve("@gadicc/watchbound-node"),
);
logPhase("loader-resolution-complete", { loaderRoot });
const nativeMatrix = readJson(path.join(loaderRoot, "native-matrix.json"));
logPhase("matrix-read-complete");
const nativeTarget = nativeMatrix.targets.find((target) =>
  target.platform === process.platform && target.architecture === process.arch);
assert.ok(nativeTarget, `no installed native target for ${process.platform}/${process.arch}`);
if (options["native-target"]) {
  assert.equal(nativeTarget.id, options["native-target"]);
}
const nativeRoot = path.dirname(
  wrapperRequire.resolve(`${nativeTarget.package}/package.json`),
);
logPhase("target-resolution-complete", { nativeRoot });
const nativePath = path.join(nativeRoot, nativeTarget.binary);
assert.ok(wrapperEntry.includes("app.asar"), "wrapper was not loaded from ASAR");
assert.ok(nativePath.includes("app.asar"), "native target was not resolved through ASAR");
if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") {
  logPhase("app-ready-wait-start");
  await wrapperRequire("electron").app.whenReady();
  logPhase("app-ready-wait-complete");
  // Let the unmodified upstream bootstrap finish opening its own persistent
  // descriptors and threads before establishing the Watchbound baseline.
  await delay(1500);
  logPhase("upstream-startup-settle-complete");
}
const evidence = {
  schemaVersion: 1,
  kind: "watchbound-installed-package-smoke",
  route: options.route,
  expectedVersion: options["package-version"],
  expectedNativeTarget: options["native-target"] ?? nativeTarget.id,
  expectedNativeSha256: options["native-sha256"],
  sourceCommit: candidateIdentity.sourceCommit,
  candidateIdentity,
  waitTimeoutMs,
  startedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    architecture: process.arch,
    armAbi: nativeTarget.armAbi ?? null,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    nodeApi: Number(process.versions.napi),
    kernel: os.release(),
    glibc: null,
  },
};

let terminalError;
try {
  Object.assign(evidence, await runSmoke());
  evidence.host.glibc = evidence.runtimeAdmission.libc.version;
  evidence.status = "passed";
  logPhase("checks-complete");
} catch (error) {
  evidence.status = "failed";
  evidence.error = {
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: error?.message ?? String(error),
    details: error?.details ?? null,
    cause: serializeCause(error?.cause),
    stack: error?.stack ?? null,
  };
  evidence.loaderFailureState = {
    loadedNativePaths: Object.keys(wrapperRequire.cache).filter((filename) =>
      filename.endsWith(nativeTarget.binary)),
  };
  logPhase("checks-failed", { errorName: error?.name ?? null });
  terminalError = error;
} finally {
  evidence.finishedAt = new Date().toISOString();
  if (options.evidence) {
    logPhase("evidence-write-start");
    const evidencePath = path.resolve(options.evidence);
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(
      evidencePath,
      `${JSON.stringify(evidence, bigintReplacer, 2)}\n`,
    );
    logPhase("evidence-write-complete");
  }
}

if (terminalError) {
  process.stdout.write(`WATCHBOUND_SIGNED_RUNTIME_FAILURE=${JSON.stringify(evidence, bigintReplacer)}\n`);
  if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") {
    wrapperRequire("electron").app.exit(1);
  } else {
    throw terminalError;
  }
} else {
  process.stdout.write(
    `Installed package smoke passed for ${options.route} ${options["package-version"]}\n`,
  );
  if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") {
    wrapperRequire("electron").app.quit();
  }
}

async function runSmoke() {
  logPhase("package-contracts-start");
  const wrapperPackage = readJson(path.join(wrapperRoot, "package.json"));
  const loaderPackage = readJson(path.join(loaderRoot, "package.json"));
  const nativePackage = readJson(path.join(nativeRoot, "package.json"));
  assert.deepEqual(candidateIdentity.packages, {
    wrapper: { name: wrapperPackage.name, version: wrapperPackage.version },
    loader: { name: loaderPackage.name, version: loaderPackage.version },
    target: { name: nativePackage.name, version: nativePackage.version },
  });
  assert.equal(wrapperPackage.version, options["package-version"]);
  assert.equal(loaderPackage.version, options["package-version"]);
  assert.equal(nativePackage.version, options["package-version"]);
  assert.equal(
    wrapperPackage.dependencies?.["@gadicc/watchbound-node"],
    options["package-version"],
  );
  assert.equal(wrapperDelivery(wrapperPackage), "bundled-native-package");
  assert.equal(loaderPackage.watchbound?.delivery, "bundled-native-package");
  assert.equal(nativePackage.watchbound?.delivery, "target-native-package");
  assert.equal(nativePackage.name, nativeTarget.package);
  assert.equal(nativePackage.watchbound?.target, nativeTarget.id);
  assert.equal(nativePackage.watchbound?.targetTriple, nativeTarget.rustTarget);
  assert.equal(
    nativePackage.watchbound?.nodeApiMinimum,
    nativeMatrix.nodeApiMinimum,
  );
  assert.equal(wrapperPackage.engines?.node, ">=18.15.0");
  assert.equal(loaderPackage.engines?.node, ">=18.15.0");
  assert.equal(nativePackage.engines?.node, ">=18.15.0");
  assert.equal(nativeMatrix.nodeRange, ">=18.15.0");
  assert.equal(nativeMatrix.nodeMinimum, "18.15.0");
  assert.equal(nativeMatrix.nodeApiMinimum, 6);
  assert.equal(nativeMatrix.nodeRange.includes("<"), false);
  assert.ok(fs.existsSync(nativePath), `missing installed native addon: ${nativePath}`);
  const nativeSha256 = sha256(nativePath);
  if (process.env.WATCHBOUND_EXPECT_NEGATIVE_LOADER_ERROR !== "1") {
    assert.equal(
      nativeSha256,
      options["native-sha256"],
      "installed native addon differs from the independently approved artifact",
    );
  }
  logPhase("package-contracts-complete");

  logPhase("production-adapter-start");
  try {
    evidence.productionAdapter = await checkProductionAdapterRoute();
  } catch (error) {
    evidence.productionAdapter = {
      status: "failed",
      exactInjectedSourceSha256: expectedProductionAdapterSha256,
      bareSpecifierAttempted: true,
      moduleOverrideUsed: false,
      fallbackCalls: productionAdapterFallbackCalls,
      errorCode: error?.code ?? null,
    };
    throw error;
  }
  logPhase("production-adapter-complete");

  logPhase("native-module-start");
  const module = await import(pathToFileURL(wrapperEntry));
  const { capabilities, createEngine, qualifyRoot } = module;
  const rawBinding = wrapperRequire("@gadicc/watchbound-node");
  const rawCapabilities = rawBinding.capabilities();
  const bindingMetadata = rawBinding.bindingMetadata();
  const deliveryMetadata = rawBinding.nativeDeliveryMetadata();
  const runtimeAdmission = rawBinding.runtimeAdmissionMetadata();
  const loadedNativePaths = Object.keys(wrapperRequire.cache).filter(
    (filename) => filename.endsWith(nativeTarget.binary),
  );
  assert.deepEqual(
    loadedNativePaths,
    [nativePath],
    "production loader did not load exactly the selected immutable native path",
  );
  assert.equal(rawCapabilities.schemaVersion, 5);
  assert.equal(bindingMetadata.schemaVersion, 1);
  assert.equal(bindingMetadata.bindingApiVersion, 5);
  assert.equal(bindingMetadata.nodeApiVersion, 6);
  assert.equal(bindingMetadata.targetTriple, nativeTarget.rustTarget);
  assert.equal(bindingMetadata.buildProfile, "release");
  assert.equal(bindingMetadata.nativeVersion, options["package-version"]);
  assert.equal(bindingMetadata.engineVersion, options["package-version"]);
  assert.equal(deliveryMetadata.schemaVersion, 1);
  assert.equal(deliveryMetadata.targetId, nativeTarget.id);
  assert.equal(deliveryMetadata.targetPackage, nativeTarget.package);
  assert.equal(deliveryMetadata.sha256, nativeSha256);
  assert.equal(runtimeAdmission.schemaVersion, 1);
  assert.equal(runtimeAdmission.platform, process.platform);
  assert.equal(runtimeAdmission.architecture, process.arch);
  assert.equal(runtimeAdmission.armAbi, null);
  assert.equal(runtimeAdmission.kernel, os.release());
  assert.deepEqual(runtimeAdmission.node, {
    version: process.versions.node,
    api: Number(process.versions.napi),
  });
  assert.equal(runtimeAdmission.libc.family, "glibc");
  assert.match(runtimeAdmission.libc.version, /^\d+\.\d+(?:\.\d+)?$/u);
  assert.equal(runtimeAdmission.libc.evidence, "elf-interpreter-version");
  assert.deepEqual(capabilities.versions, {
    wrapper: options["package-version"],
    native: options["package-version"],
    engine: options["package-version"],
    bindingApi: 5,
  });
  assert.equal(capabilities.build.delivery, "bundled-native-package");
  assert.equal(capabilities.build.prebuilt, true);
  assert.equal(capabilities.schemaVersion, 9);
  assert.equal(capabilities.support.nodeRange, ">=18.15.0");
  assert.equal(capabilities.build.nodeApi, 6);
  assert.equal(capabilities.build.profile, "release");
  assert.equal(capabilities.build.targetTriple, nativeTarget.rustTarget);
  assert.equal(capabilities.features.directoryNameExclusions, true);
  assert.equal(capabilities.features.observedExcludedPaths, true);
  assert.equal(capabilities.features.bytesOnlyInvalidations, true);
  assert.deepEqual(capabilities.observability.pathEncodingStates, [
    "complete",
    "root-collapsed",
    "bytes-only",
  ]);
  assert.equal(capabilities.build.packagedTarget.id, nativeTarget.id);
  assert.equal(capabilities.build.packagedTarget.package, nativeTarget.package);
  assert.equal(capabilities.build.packagedTarget.sha256, nativeSha256);
  assert.deepEqual(capabilities.runtime, {
    platform: runtimeAdmission.platform,
    architecture: runtimeAdmission.architecture,
    armAbi: runtimeAdmission.armAbi,
    kernel: runtimeAdmission.kernel,
    libc: {
      family: runtimeAdmission.libc.family,
      version: runtimeAdmission.libc.version,
    },
    node: runtimeAdmission.node,
  });
  assert.equal(capabilities.support.scope, "legacy-primary-target");
  const legacyX64Target = nativeMatrix.targets.find(
    (target) => target.architecture === "x64",
  );
  assert.ok(legacyX64Target, "native matrix omits its legacy x64 target");
  assert.equal(capabilities.support.status, legacyX64Target.qualification);
  // These legacy single-target fields retain their original x64/Ubuntu 24.04
  // meaning. Consumers must use support.targets and currentRuntime for the
  // additive multi-target contract.
  assert.equal(capabilities.support.operatingSystem.distribution, "ubuntu");
  assert.equal(capabilities.support.operatingSystem.version, "24.04");
  assert.equal(capabilities.support.architecture, "x64");
  assert.deepEqual(capabilities.support.libc, {
    family: "glibc",
    version: "2.39",
  });
  assert.equal(capabilities.support.targets.length, nativeMatrix.targets.length);
  assert.equal(
    capabilities.support.currentRuntime.packagedTargetId,
    nativeTarget.id,
  );
  assert.equal(
    capabilities.support.currentRuntime.runtimeMatchesPackagedTarget,
    true,
  );
  assert.equal(
    capabilities.support.currentRuntime.qualification,
    nativeTarget.qualification,
  );
  assert.equal(
    capabilities.support.currentRuntime.targetCompatible,
    nativeTarget.qualification === "supported",
  );
  const qualification = qualifyRoot(process.cwd());
  assert.equal(qualification.schemaVersion, 1);
  assert.ok(["qualified", "unqualified", "unknown"].includes(qualification.state));
  assert.equal(qualification.target.packagedTargetId, nativeTarget.id);
  assert.equal(qualification.state, "qualified", JSON.stringify(qualification));

  const engine = createEngine();
  const inactiveRuntime = {
    active: false,
    inotifyInstances: 0,
    workerThreads: 0,
    nativeWatches: 0,
    nativeWatchBudget: null,
    deferredInterests: 0,
    subscriptions: 0,
  };
  assert.deepEqual(engine.runtimeStats(), inactiveRuntime);
  const processBaseline = processResources();
  logPhase("native-module-complete");

  logPhase("real-delivery-start");
  const realDelivery = await checkRealDeliveryAndSerialization(engine);
  logPhase("real-delivery-complete");
  logPhase("exclusions-recovery-start");
  const exclusions = await checkExclusionsRecoveryAndReconciliation(engine);
  logPhase("exclusions-recovery-complete");
  logPhase("establishment-cancellation-start");
  const establishmentCancellation = await checkEstablishmentCancellation(engine);
  logPhase("establishment-cancellation-complete");
  logPhase("joined-disposal-start");
  const joinedDisposal = await checkContextAbortAndJoinedDisposal(engine);
  logPhase("joined-disposal-complete");
  logPhase("context-stop-start");
  const contextStop = await checkContextStop(engine);
  logPhase("context-stop-complete");

  logPhase("resource-return-start");
  await waitFor(
    () => deepEqual(engine.runtimeStats(), inactiveRuntime),
    "runtime resources did not return to the inactive baseline",
  );
  const processFinal = processResources();
  logPhase("resource-return-snapshot", {
    processBaseline,
    processFinal,
    runtimeFinal: engine.runtimeStats(),
  });
  assert.equal(
    processFinal.watchboundThreads,
    processBaseline.watchboundThreads,
    "Watchbound threads did not return to baseline",
  );
  assert.equal(
    processFinal.inotifyDescriptors,
    processBaseline.inotifyDescriptors,
    "inotify descriptors did not return to baseline",
  );
  assert.ok(
    processFinal.fileDescriptors <= processBaseline.fileDescriptors + 2,
    "process file descriptors did not return near baseline",
  );
  assert.ok(
    processFinal.tasks <= processBaseline.tasks + 4,
    "process tasks did not return near the cold baseline",
  );
  logPhase("resource-return-complete");

  return {
    wrapper: {
      name: wrapperPackage.name,
      version: wrapperPackage.version,
    },
    loader: {
      name: loaderPackage.name,
      version: loaderPackage.version,
    },
    native: {
      name: nativePackage.name,
      version: nativePackage.version,
      target: nativeTarget.id,
      targetTriple: nativeTarget.rustTarget,
      binary: nativeTarget.binary,
      resolvedPath: nativePath,
      loadedPath: loadedNativePaths[0],
      sha256: nativeSha256,
      bytes: fs.statSync(nativePath).size,
    },
    loaderContract: {
      javascriptAdmission: nativeMatrix.nodeRange,
      javascriptMinimum: nativeMatrix.nodeMinimum,
      runtimeAdmissionSchema: runtimeAdmission.schemaVersion,
      runtimeLibcEvidence: runtimeAdmission.libc.evidence,
      kernelMinimum: nativeMatrix.releaseBaseline.kernelMinimum,
      glibcMinimum: nativeMatrix.releaseBaseline.glibcMaximum,
      rawCapabilitySchema: rawCapabilities.schemaVersion,
      publicCapabilitySchema: capabilities.schemaVersion,
      metadataSchema: bindingMetadata.schemaVersion,
      bindingApi: bindingMetadata.bindingApiVersion,
      buildProfile: bindingMetadata.buildProfile,
      targetTriple: bindingMetadata.targetTriple,
    },
    runtimeAdmission,
    qualification,
    lifecycleAssertions: {
      expectedRuntimeIdentity: {
        expectedElectron,
        observedElectron: process.versions.electron,
        electronMatches: process.versions.electron === expectedElectron,
        expectedChrome,
        observedChrome: process.versions.chrome,
        chromeMatches: process.versions.chrome === expectedChrome,
        expectedNode,
        observedNode: process.versions.node,
        nodeMatches: process.versions.node === expectedNode,
        nodeApiMinimum: expectedNodeApiMinimum,
        observedNodeApi: Number(process.versions.napi),
        nodeApiSatisfied: Number(process.versions.napi) >= expectedNodeApiMinimum,
      },
      inactiveBaseline: true,
      completeInitialObservation: true,
      realDelivery,
      exclusions,
      establishmentCancellation,
      joinedDisposal,
      contextStop,
      resourcesReturnedToBaseline: true,
    },
    runtime: {
      baseline: inactiveRuntime,
      final: engine.runtimeStats(),
    },
    processResources: {
      baseline: processBaseline,
      final: processFinal,
      tolerance: {
        fileDescriptors: 2,
        coldTasks: 4,
      },
    },
  };
}

async function checkProductionAdapterRoute() {
  const root = fs.mkdtempSync(
    path.join(process.cwd(), ".watchbound-production-adapter-"),
  );
  const moduleOverrideKey = Symbol.for(
    "codex-linux.directory-only-working-tree-watch.test-module",
  );
  const engineKey = Symbol.for(
    "codex-linux.directory-only-working-tree-watch.watchbound-engine",
  );
  assert.equal(globalThis[moduleOverrideKey], undefined);
  delete globalThis[engineKey];
  productionAdapterFallbackCalls = 0;
  const establishmentMessages = [];
  const originalInfo = console.info;
  console.info = (...args) => {
    const message = args.map(String).join(" ");
    if (message.includes("established with Watchbound")) {
      establishmentMessages.push(message);
    }
    originalInfo(...args);
  };
  let watcher;
  try {
    watcher = await startProductionWatch(
      {
        getFileSystemPath: () => root,
        platformPath: async () => path.posix,
      },
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange() {},
      },
      {
        maxWatches: 64,
        honorGitIgnore: false,
        ignoredDirectoryNames: [],
      },
      () => {
        productionAdapterFallbackCalls += 1;
        return null;
      },
    );
    assert.ok(watcher, "production adapter returned its Parcel fallback");
    assert.ok(watcher.codexLinuxDirectoryWatchCount() > 0);
    const budget = watcher.codexLinuxDirectoryWatchBudget();
    assert.equal(budget.limit, 64);
    assert.ok(budget.active > 0 && budget.active <= budget.limit);
    assert.deepEqual(establishmentMessages, [
      `INFO: directory-only working-tree watch established with Watchbound 2.1.2 ` +
        `for ${root} (target=${nativeTarget.id}, native=${budget.active}, limit=${budget.limit}).`,
    ]);
    await watcher.dispose();
    const closed = await watcher.closed;
    assert.equal(closed.reason, "disposed");
    assert.equal(productionAdapterFallbackCalls, 0);
    return {
      status: "passed",
      exactInjectedSourceSha256: expectedProductionAdapterSha256,
      bareSpecifierResolved: true,
      moduleOverrideUsed: false,
      fallbackCalls: productionAdapterFallbackCalls,
      watcherReturned: true,
      nativeSubscriptionEstablished: true,
      establishmentDiagnostic: {
        emitted: true,
        version: "2.1.2",
        target: nativeTarget.id,
        includedNativeBudget: true,
      },
      joinedDisposal: true,
    };
  } finally {
    console.info = originalInfo;
    await watcher?.dispose();
    delete globalThis[engineKey];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function logPhase(phase, details = {}) {
  process.stdout.write(
    `WATCHBOUND_INSTALLED_SMOKE_PHASE=${JSON.stringify({
      phase,
      elapsedMs: Date.now() - smokeStartedAt,
      route: options.route,
      ...details,
    })}\n`,
  );
}

async function checkExclusionsRecoveryAndReconciliation(engine) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-platform-semantics-"),
  );
  const root = path.join(parent, "root");
  const movedRoot = path.join(parent, "root-old");
  const initialExcluded = path.join(root, "initial-hidden");
  const dynamicExcluded = path.join(root, "dynamic-hidden");
  const observedGit = path.join(root, ".git");
  const nestedGit = path.join(root, "nested", ".git");
  fs.mkdirSync(initialExcluded, { recursive: true });
  fs.mkdirSync(dynamicExcluded, { recursive: true });
  fs.mkdirSync(path.join(observedGit, "objects"), { recursive: true });
  fs.mkdirSync(path.join(nestedGit, "objects"), { recursive: true });
  const batches = [];
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      (batch) => batches.push(batch),
      {
        initialExclusions: ["initial-hidden"],
        excludedDirectoryNames: [".git"],
        observedExcludedPaths: [".git"],
        batchWindowMs: 5,
        outputQueueCapacity: 16,
      },
    );
    assert.equal(subscription.initialCoverage.state, "complete");

    const initialHidden = path.join(initialExcluded, "hidden.txt");
    const initialVisible = path.join(root, "visible.txt");
    fs.writeFileSync(initialHidden, "hidden");
    fs.writeFileSync(initialVisible, "visible");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(initialVisible)),
      "initial-exclusion smoke did not deliver the visible path",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, initialExcluded),
      false,
      "initial exclusion leaked its prefix or a descendant path",
    );
    fs.writeFileSync(path.join(observedGit, "objects", "ignored"), "hidden");
    fs.writeFileSync(path.join(nestedGit, "objects", "ignored"), "hidden");
    await delay(30);
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, nestedGit),
      false,
      "nested directory-name exclusion leaked a descendant path",
    );
    fs.rmSync(observedGit, { recursive: true });
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(observedGit)),
      "observed excluded boundary deletion was not delivered",
    );

    const replacementCoverage = await subscription.replaceExclusions(
      1n,
      {
        prefixes: ["dynamic-hidden"],
        excludedDirectoryNames: [".git"],
        observedExcludedPaths: [".git"],
      },
    );
    assert.equal(replacementCoverage.state, "complete");
    const dynamicHidden = path.join(dynamicExcluded, "hidden.txt");
    const nowVisible = path.join(root, "initial-hidden", "now-visible.txt");
    fs.writeFileSync(dynamicHidden, "hidden");
    fs.writeFileSync(nowVisible, "visible");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(nowVisible)),
      "dynamic-exclusion smoke did not deliver the newly visible path",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, dynamicExcluded),
      false,
      "dynamic exclusion leaked its prefix or a descendant path",
    );

    const reconciliation = await subscription.reconcile();
    assert.equal(reconciliation.exclusionGeneration, 1n);
    assert.equal(reconciliation.coverage.state, "complete");

    fs.renameSync(root, movedRoot);
    fs.mkdirSync(path.join(root, "replacement"), { recursive: true });
    await waitFor(
      () => subscription.rootState.attachment === "lost",
      "root replacement did not become explicitly lost",
    );
    const recovery = await recoverStableReplacement(subscription, {
      timeoutMs: waitTimeoutMs,
      onDeadline: reportSemanticDeadline,
    });
    assert.equal(
      recovery.attachment,
      "replacement-adopted",
      `root recovery did not adopt the stable replacement: ${recovery.reason ?? "unknown"}`,
    );
    assert.equal(recovery.currentRootState.attachment, "attached");
    const afterRecovery = path.join(root, "replacement", "after.txt");
    fs.writeFileSync(afterRecovery, "after");
    await waitFor(
      () => batches.some((batch) => batch.invalidatedPaths.includes(afterRecovery)),
      "root-recovery smoke did not restore real delivery",
    );
    await subscription.dispose();
    subscription = undefined;
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, initialExcluded, 0n),
      false,
      "joined history exposed an initial-exclusion namespace leak",
    );
    assert.equal(
      hasInvalidatedPathAtOrBelow(batches, dynamicExcluded, 1n),
      false,
      "joined history exposed a dynamic-exclusion namespace leak",
    );
    return {
      initialPrefixHidden: true,
      directoryNameGitHidden: true,
      observedGitBoundaryDelivered: true,
      dynamicPrefixHidden: true,
      reconciliationComplete: true,
      stableRootReplacementRecovered: true,
    };
  } finally {
    await subscription?.dispose();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

function wrapperDelivery(manifest) {
  if (manifest.watchbound?.delivery !== undefined) {
    return manifest.watchbound.delivery;
  }
  if (
    manifest.name === "@jsr/gadicc__watchbound" &&
    manifest.dependencies?.["@gadicc/watchbound-node"] === manifest.version
  ) {
    return "bundled-native-package";
  }
  return undefined;
}

async function checkRealDeliveryAndSerialization(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-serialization-"),
  );
  const firstRelease = deferred();
  let subscription;
  let entered = 0;
  let active = 0;
  let maximumActive = 0;
  const invalidatedPaths = [];
  try {
    logPhase("real-delivery-subscribe-start");
    subscription = await engine.subscribe(
      root,
      async (batch) => {
        invalidatedPaths.push(...batch.invalidatedPaths);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        entered += 1;
        if (entered === 1) {
          logPhase("real-delivery-first-callback-enter");
          await firstRelease.promise;
        } else if (entered === 2) {
          logPhase("real-delivery-second-callback-enter");
        }
        active -= 1;
      },
      {
        batchWindowMs: 5,
        outputQueueCapacity: 4,
      },
    );
    logPhase("real-delivery-subscribe-complete");
    assert.equal(subscription.initialCoverage.state, "complete");
    logPhase("real-delivery-first-write");
    fs.writeFileSync(path.join(root, "first.txt"), "first");
    logPhase("real-delivery-first-callback-wait-start");
    await waitFor(
      () => entered >= 1,
      "the first serialized callback did not enter",
    );
    logPhase("real-delivery-first-callback-wait-complete");
    logPhase("real-delivery-second-write");
    fs.writeFileSync(path.join(root, "second.txt"), "second");
    await delay(75);
    assert.equal(entered, 1, "a later callback overlapped a pending callback");
    firstRelease.resolve();
    logPhase("real-delivery-second-callback-wait-start");
    await waitFor(() => entered >= 2, "the serialized callback did not resume");
    logPhase("real-delivery-second-callback-wait-complete");
    assert.equal(maximumActive, 1);
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    const beforeChange = entered;
    const firstInvalidations = invalidatedPaths.filter((value) => value === first).length;
    fs.appendFileSync(first, "-changed");
    await waitFor(
      () => entered > beforeChange &&
        invalidatedPaths.filter((value) => value === first).length > firstInvalidations,
      "the file-change callback was not delivered",
    );
    const beforeDelete = entered;
    const secondInvalidations = invalidatedPaths.filter((value) => value === second).length;
    fs.rmSync(second);
    await waitFor(
      () => entered > beforeDelete &&
        invalidatedPaths.filter((value) => value === second).length > secondInvalidations,
      "the file-deletion callback was not delivered",
    );
    return {
      createDelivered: true,
      modificationDelivered: true,
      deletionDelivered: true,
      maximumConcurrentCallbacks: maximumActive,
      callbackCount: entered,
    };
  } finally {
    logPhase("real-delivery-disposal-start");
    await releaseCallbackGateAndJoinDisposal(
      () => firstRelease.resolve(),
      subscription,
    );
    logPhase("real-delivery-disposal-complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function checkContextAbortAndJoinedDisposal(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-disposal-"),
  );
  const completionRelease = deferred();
  let callbackCompleted = false;
  let callbackCalls = 0;
  let callbackContext;
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      async (_batch, context) => {
        callbackCalls += 1;
        callbackContext = context;
        if (!context.signal.aborted) {
          await new Promise((resolve) => {
            context.signal.addEventListener("abort", resolve, { once: true });
          });
        }
        await completionRelease.promise;
        callbackCompleted = true;
      },
      { batchWindowMs: 5 },
    );
    fs.writeFileSync(path.join(root, "changed.txt"), "change");
    await waitFor(
      () => callbackContext !== undefined,
      "the joined-disposal callback did not enter",
    );
    let disposalResolved = false;
    const joined = subscription.dispose();
    assert.equal(subscription.dispose(), joined);
    assert.equal(subscription.dispose(), joined);
    const disposal = joined.then(() => {
      disposalResolved = true;
    });
    assert.equal(callbackContext.signal.aborted, true);
    await delay(50);
    assert.equal(
      disposalResolved,
      false,
      "disposal resolved before the pending callback completed",
    );
    completionRelease.resolve();
    await disposal;
    assert.equal(callbackCompleted, true);
    assert.equal(subscription.stats().disposed, true);
    assert.equal(subscription.dispose(), joined);
    const callsAtDispose = callbackCalls;
    fs.writeFileSync(path.join(root, "after-disposal.txt"), "after");
    await delay(75);
    assert.equal(callbackCalls, callsAtDispose);
    return {
      concurrentCallsSharedPromise: true,
      repeatedCallSharedPromise: true,
      callbackSignalAborted: callbackContext.signal.aborted,
      disposalJoinedPendingCallback: true,
      callbackCompletedBeforeResolution: callbackCompleted,
      callbacksAfterResolution: callbackCalls - callsAtDispose,
    };
  } finally {
    await releaseCallbackGateAndJoinDisposal(
      () => completionRelease.resolve(),
      subscription,
    );
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function checkContextStop(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-stop-"),
  );
  let calls = 0;
  let callbackContext;
  let subscription;
  try {
    subscription = await engine.subscribe(
      root,
      (_batch, context) => {
        calls += 1;
        callbackContext = context;
        context.stop();
        context.stop();
      },
      { batchWindowMs: 5 },
    );
    fs.writeFileSync(path.join(root, "changed.txt"), "change");
    await waitFor(
      () => subscription.stats().disposed,
      "context.stop() did not dispose the subscription",
    );
    assert.equal(callbackContext.signal.aborted, true);
    await subscription.dispose();
    fs.writeFileSync(path.join(root, "after-stop.txt"), "after");
    await delay(75);
    assert.equal(calls, 1, "a callback started after context.stop() disposal");
    return {
      stopIdempotent: true,
      signalAborted: callbackContext.signal.aborted,
      callbackCount: calls,
      callbacksAfterStop: 0,
    };
  } finally {
    await subscription?.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function processResources() {
  const tasks = fs.readdirSync("/proc/self/task")
    .filter((entry) => /^\d+$/u.test(entry));
  const watchboundThreads = tasks.filter((entry) => {
    try {
      return fs.readFileSync(`/proc/self/task/${entry}/comm`, "utf8")
        .trim()
        .startsWith("watchbound-");
    } catch {
      return false;
    }
  }).length;
  const descriptors = fs.readdirSync("/proc/self/fd")
    .filter((entry) => /^\d+$/u.test(entry));
  const inotifyDescriptors = descriptors.filter((entry) => {
    try {
      return fs.readlinkSync(`/proc/self/fd/${entry}`) === "anon_inode:inotify";
    } catch {
      return false;
    }
  }).length;
  return {
    fileDescriptors: descriptors.length,
    tasks: tasks.length,
    watchboundThreads,
    inotifyDescriptors,
  };
}

async function checkEstablishmentCancellation(engine) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "watchbound-installed-establishment-cancel-"),
  );
  let listener;
  const signal = {
    aborted: false,
    addEventListener(type, callback) {
      assert.equal(type, "abort");
      listener = callback;
      this.aborted = true;
      callback();
    },
    removeEventListener(type, callback) {
      assert.equal(type, "abort");
      assert.equal(callback, listener);
    },
  };
  try {
    await assert.rejects(
      engine.subscribe(root, () => {}, { signal }),
      (error) => {
        assert.equal(error?.code, "WATCHBOUND_OPERATION_CANCELLED");
        assert.equal(error?.operation, "subscribe");
        return true;
      },
    );
    assert.equal(signal.aborted, true);
    return {
      provisionalNativeCancellation: true,
      errorCode: "WATCHBOUND_OPERATION_CANCELLED",
      operation: "subscribe",
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate, message) {
  await waitForInstalledSmokeCondition(predicate, message, {
    timeoutMs: waitTimeoutMs,
    onDeadline: reportSemanticDeadline,
  });
}

function reportSemanticDeadline(message, timeoutMs) {
  process.stderr.write(
    `WATCHBOUND_INSTALLED_SMOKE_SEMANTIC_DEADLINE=${JSON.stringify({
      elapsedMs: Date.now() - smokeStartedAt,
      route: options.route,
      timeoutMs,
      message,
    })}\n`,
  );
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: check-signed-runtime.mjs --project <path> --wrapper <name> --package-version <version> --native-sha256 <digest> --route <route> [--native-target <id>] [--wrapper-path <path>] [--evidence <path>] [--wait-timeout-ms <milliseconds>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of [
    "project",
    "wrapper",
    "package-version",
    "native-sha256",
    "route",
  ]) {
    assert.ok(parsed[required], `--${required} is required`);
  }
  assert.match(parsed["native-sha256"], /^[0-9a-f]{64}$/u);
  return parsed;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(source))
    .digest("hex");
}

function deepEqual(left, right) {
  try {
    assert.deepEqual(left, right);
    return true;
  } catch {
    return false;
  }
}

function bigintReplacer(_key, value) {
  if (typeof value === "bigint") return `${value}n`;
  if (value instanceof Uint8Array) return { type: "Uint8Array", hex: Buffer.from(value).toString("hex") };
  return value;
}

function serializeCause(cause) {
  if (cause === undefined) return null;
  if (cause === null || typeof cause !== "object") return String(cause);
  return {
    name: cause.name ?? null,
    code: cause.code ?? null,
    message: cause.message ?? String(cause),
    domain: cause.domain ?? null,
    kind: cause.kind ?? null,
  };
}
