#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED = Object.freeze({
  sourceCommit: "fa188992ef2cc800f9e65b9395139f85ef945c45",
  runtimeImplementationParent: "4996ff1d027a95d6ffb677e41236399eae400a16",
  officialPackageVersion: "26.814.41957",
  executableSha256: "85e03c4bb5814e943eb23ae7eb370ea8f7eeab67c646e46d17596a07eedfb5b6",
  sourceAsarSha256: "1a43bb2a6547cd2a4945a669fb14f0b15b6eddc1fc1177f51dffc554e3c5ad98",
  nativeSha256: "1f4713bb126bc8652d83e66d25219e0c0f3c354b3e0efeafcc2ec5e8b0bbec45",
  electron: "151.0.7922.137",
  chrome: "151.0.7922.137",
  node: "24.14.0",
  nodeApiMinimum: 6,
  targetId: "linux-x64-gnu",
});
const acceptanceDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(acceptanceDir, "../../..");
const acceptanceRequire = createRequire(import.meta.url);
const { stageWatchboundPackages } = acceptanceRequire("../watchbound-package.js");
const { codexLinuxStartDirectoryOnlyWorkingTreeWatch } = acceptanceRequire("../patch.js");
const productionAdapterSource =
  `"use strict";\nmodule.exports = ${codexLinuxStartDirectoryOnlyWorkingTreeWatch.toString()};\n`;
const productionAdapterSha256 = sha256Contents(productionAdapterSource);
const options = parseOptions(process.argv.slice(2));
const watchboundRoot = path.resolve(options["watchbound-source"]);
const signedAppRoot = path.resolve(options["signed-app"] ?? path.join(repoRoot, "codex-app"));
const signedDeb = path.resolve(options["signed-deb"]);
const sanitizedEvidencePath = path.resolve(
  options.evidence ?? path.join(acceptanceDir, "evidence", "signed-runtime-2.1.2-x64.json"),
);
const rawDir = path.resolve(
  options["raw-dir"] ?? path.join(repoRoot, "reports", "watchbound-signed-runtime", "2.1.2-x64"),
);
const rawDirRelative = path.relative(repoRoot, rawDir);
assert.ok(
  rawDirRelative !== "" &&
    !rawDirRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rawDirRelative),
  "--raw-dir must be a repository-owned ignored path",
);
const signedExecutable = path.join(signedAppRoot, "ChatGPT");
const sourceAsar = path.join(signedAppRoot, "resources", "app.asar");
const upstreamPinsPath = path.join(repoRoot, "nix", "upstream-linux-packages.json");
const upstreamPins = readJson(upstreamPinsPath);
const signedPackagePin = upstreamPins.amd64;

assert.equal(process.platform, "linux", "signed runtime acceptance requires Linux");
assert.equal(process.arch, "x64", "this acceptance record is specifically Linux x64");
assert.equal(git(watchboundRoot, "rev-parse", "HEAD"), EXPECTED.sourceCommit);
assert.equal(git(watchboundRoot, "rev-parse", "HEAD^"), EXPECTED.runtimeImplementationParent);
assert.equal(git(watchboundRoot, "status", "--porcelain"), "", "Watchbound source must stay clean");
assert.equal(upstreamPins.version, EXPECTED.officialPackageVersion);
assert.match(signedPackagePin.repositoryPath, /_amd64\.deb$/u);
assert.ok(fs.existsSync(signedDeb), `missing signed package: ${signedDeb}`);
assert.equal(
  sha256(signedDeb),
  signedPackagePin.sha256,
  "signed package does not match the checked-in stable APT pin",
);
assert.ok(fs.existsSync(signedExecutable), `missing signed executable: ${signedExecutable}`);
assert.ok(fs.existsSync(sourceAsar), `missing official ASAR: ${sourceAsar}`);
const executableSha256 = sha256(signedExecutable);
if (executableSha256 !== EXPECTED.executableSha256) {
  throw new Error(
    `signed executable digest changed: expected ${EXPECTED.executableSha256}, observed ${executableSha256}; establish a new runtime baseline before testing`,
  );
}
if (fs.existsSync(rawDir)) {
  throw new Error(`raw evidence directory already exists: ${rawDir}`);
}
fs.mkdirSync(rawDir, { recursive: true });

const asarEntry = createRequire(path.join(watchboundRoot, "package.json"))
  .resolve("@electron/asar");
const { createPackageWithOptions, extractAll, extractFile, statFile } =
  await import(pathToFileURL(asarEntry));
const sourcePackage = JSON.parse(extractFile(sourceAsar, "package.json"));
assert.equal(sourcePackage.main, ".vite/build/early-bootstrap.js");
assert.equal(sourcePackage.version, EXPECTED.officialPackageVersion);
const sourceAsarSha256 = sha256(sourceAsar);
assert.equal(sourceAsarSha256, EXPECTED.sourceAsarSha256);
const artifactManifest = readJson(path.join(
  repoRoot,
  "linux-features",
  "directory-only-working-tree-watch",
  "watchbound-artifacts.json",
));
assert.equal(artifactManifest.version, "2.1.2");
assert.equal(artifactManifest.source.revision, EXPECTED.sourceCommit);
const sourceInputs = acceptanceSourceInputs();

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchbound-signed-acceptance-"));
let aggregate;
try {
  const signedPackageRoot = path.join(workRoot, "signed-package");
  execFileSync("dpkg-deb", ["--extract", signedDeb, signedPackageRoot]);
  const signedPackageAppRoot = path.join(signedPackageRoot, "usr", "lib", "chatgpt");
  const signedAppInventory = appPayloadInventory(signedAppRoot);
  const signedPackageInventory = appPayloadInventory(signedPackageAppRoot);
  assert.deepEqual(
    signedAppInventory,
    signedPackageInventory,
    "--signed-app does not exactly match the verified deb data payload",
  );
  const signedAppInventorySha256 = sha256Contents(JSON.stringify(signedAppInventory));
  const stagingRoot = path.join(workRoot, "app-staging");
  extractAll(sourceAsar, stagingRoot);
  for (const artifact of [
    artifactManifest.packages.wrapper,
    artifactManifest.packages.loader,
    ...Object.values(artifactManifest.packages.targets),
  ]) {
    const packageParts = artifact.name.startsWith("@")
      ? artifact.name.split("/")
      : [artifact.name];
    fs.rmSync(path.join(stagingRoot, "node_modules", ...packageParts), {
      recursive: true,
      force: true,
    });
  }
  const staged = await stageWatchboundPackages({
    extractedDir: stagingRoot,
    arch: "x64",
    libc: "glibc",
    manifest: artifactManifest,
  });
  assert.equal(staged.version, artifactManifest.version);
  const wrapperSource = path.join(stagingRoot, "node_modules", "watchbound");
  const loaderSource = path.join(
    stagingRoot,
    "node_modules",
    "@gadicc",
    "watchbound-node",
  );
  const targetSource = path.join(
    stagingRoot,
    "node_modules",
    "@gadicc",
    "watchbound-node-linux-x64-gnu",
  );
  const matrix = readJson(path.join(loaderSource, "native-matrix.json"));
  const target = matrix.targets.find(({ id }) => id === EXPECTED.targetId);
  assert.ok(target, `missing ${EXPECTED.targetId} in published native matrix`);
  const nativeSource = path.join(targetSource, target.binary);
  const wrapperPackage = readJson(path.join(wrapperSource, "package.json"));
  const loaderPackage = readJson(path.join(loaderSource, "package.json"));
  const targetPackage = readJson(path.join(targetSource, "package.json"));
  const nativeSha256 = sha256(nativeSource);
  assert.equal(nativeSha256, EXPECTED.nativeSha256);
  assert.equal(targetPackage.watchbound.nativeSha256, nativeSha256);
  assert.equal(wrapperPackage.version, artifactManifest.version);
  assert.equal(loaderPackage.version, artifactManifest.version);
  assert.equal(targetPackage.version, artifactManifest.version);
  assert.equal(
    wrapperPackage.dependencies["@gadicc/watchbound-node"],
    artifactManifest.version,
  );
  assert.equal(targetPackage.name, target.package);
  const candidateIdentity = {
    schemaVersion: 1,
    sourceCommit: EXPECTED.sourceCommit,
    runtimeImplementationParent: EXPECTED.runtimeImplementationParent,
    packages: {
      wrapper: { name: wrapperPackage.name, version: wrapperPackage.version },
      loader: { name: loaderPackage.name, version: loaderPackage.version },
      target: { name: targetPackage.name, version: targetPackage.version },
    },
    target: {
      id: target.id,
      platform: target.platform,
      architecture: target.architecture,
      armAbi: target.armAbi ?? null,
      targetTriple: target.rustTarget,
      package: target.package,
      binary: target.binary,
      nativeSha256,
    },
  };
  fs.writeFileSync(
    path.join(stagingRoot, "candidate-identity.json"),
    `${JSON.stringify(candidateIdentity, null, 2)}\n`,
  );
  copyHarness(stagingRoot);
  const earlyBootstrap = path.join(stagingRoot, sourcePackage.main);
  const officialBootstrap = fs.readFileSync(earlyBootstrap, "utf8");
  assert.match(officialBootstrap, /bootstrap-/u);
  fs.writeFileSync(
    earlyBootstrap,
    `${officialBootstrap}\nvoid import("../../watchbound-acceptance/runtime-harness.mjs").catch((error)=>{console.error("WATCHBOUND_SIGNED_HARNESS_BOOT_FAILURE",error);require("electron").app.exit(1)});\n`,
  );

  const buildRoot = path.join(workRoot, "build");
  fs.mkdirSync(buildRoot, { recursive: true });
  const generatedAsar = path.join(buildRoot, "app.asar");
  await createPackageWithOptions(stagingRoot, generatedAsar, {
    unpack: "{*.node,*.so,*.dylib}",
  });
  const archiveNative = path.join(
    "node_modules",
    "@gadicc",
    "watchbound-node-linux-x64-gnu",
    target.binary,
  );
  assert.equal(statFile(generatedAsar, archiveNative).unpacked, true);
  const generatedUnpacked = `${generatedAsar}.unpacked`;
  assert.equal(sha256(path.join(generatedUnpacked, archiveNative)), nativeSha256);
  const generatedAsarSha256 = sha256(generatedAsar);
  const positiveRuntime = path.join(workRoot, "signed-positive-runtime");
  const negativeRuntime = path.join(workRoot, "signed-negative-runtime");
  materializeRuntime({
    runtimeRoot: positiveRuntime,
    signedAppRoot,
    generatedAsar,
    generatedUnpacked,
    archiveNative,
    corruptNative: false,
  });
  materializeRuntime({
    runtimeRoot: negativeRuntime,
    signedAppRoot,
    generatedAsar,
    generatedUnpacked,
    archiveNative,
    corruptNative: true,
  });
  assert.equal(sha256(path.join(positiveRuntime, "ChatGPT")), executableSha256);
  assert.equal(sha256(path.join(negativeRuntime, "ChatGPT")), executableSha256);

  const rawArtifacts = [];
  writeRawJson("build.json", {
    sourceCommit: EXPECTED.sourceCommit,
    sourceAsar: { path: sourceAsar, sha256: sourceAsarSha256 },
    generatedAsar: { path: generatedAsar, sha256: generatedAsarSha256 },
    signedExecutable: { path: signedExecutable, sha256: executableSha256 },
    positiveExecutable: {
      path: path.join(positiveRuntime, "ChatGPT"),
      sha256: sha256(path.join(positiveRuntime, "ChatGPT")),
    },
    native: {
      sourcePath: nativeSource,
      unpackedPath: path.join(generatedUnpacked, archiveNative),
      sha256: nativeSha256,
    },
  }, rawArtifacts);

  const commonEnvironment = {
    ...process.env,
    WATCHBOUND_EXPECTED_SOURCE_COMMIT: EXPECTED.sourceCommit,
    WATCHBOUND_EXPECTED_ELECTRON: EXPECTED.electron,
    WATCHBOUND_EXPECTED_CHROME: EXPECTED.chrome,
    WATCHBOUND_EXPECTED_NODE: EXPECTED.node,
    WATCHBOUND_EXPECTED_NODE_API_MINIMUM: String(EXPECTED.nodeApiMinimum),
    WATCHBOUND_EXPECTED_PRODUCTION_ADAPTER_SHA256: productionAdapterSha256,
  };
  delete commonEnvironment.ELECTRON_RUN_AS_NODE;
  const iterations = [];
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    const stem = `cold-${iteration}`;
    const evidencePath = path.join(rawDir, `${stem}.json`);
    const result = await runSigned({
      executable: path.join(positiveRuntime, "ChatGPT"),
      project: path.join(positiveRuntime, "resources", "app.asar"),
      profile: path.join(workRoot, "profiles", stem),
      route: `signed-openai-owl-final-cold-${iteration}`,
      evidencePath,
      environment: commonEnvironment,
      version: artifactManifest.version,
      nativeSha256,
    });
    recordProcessArtifacts(stem, result, rawArtifacts);
    assert.equal(result.timedOut, false, `cold iteration ${iteration} timed out`);
    assert.equal(result.overflow, false, `cold iteration ${iteration} exceeded output limit`);
    assert.equal(result.signal, null, `cold iteration ${iteration} terminated by ${result.signal}`);
    assert.equal(result.code, 0, result.stderr);
    const evidence = readJson(evidencePath);
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.host.electron, EXPECTED.electron);
    assert.equal(evidence.host.chrome, EXPECTED.chrome);
    assert.equal(evidence.host.node, EXPECTED.node);
    assert.ok(evidence.host.nodeApi >= EXPECTED.nodeApiMinimum);
    assert.equal(evidence.native.sha256, nativeSha256);
    iterations.push({ iteration, result, evidence });
    recordExistingArtifact(`${stem}.json`, rawArtifacts);
  }

  const negativeEvidencePath = path.join(rawDir, "negative-integrity.json");
  const negative = await runSigned({
    executable: path.join(negativeRuntime, "ChatGPT"),
    project: path.join(negativeRuntime, "resources", "app.asar"),
    profile: path.join(workRoot, "profiles", "negative-integrity"),
    route: "signed-openai-owl-final-negative-integrity",
    evidencePath: negativeEvidencePath,
    environment: {
      ...commonEnvironment,
      WATCHBOUND_EXPECT_NEGATIVE_LOADER_ERROR: "1",
    },
    version: artifactManifest.version,
    nativeSha256,
  });
  recordProcessArtifacts("negative-integrity", negative, rawArtifacts);
  assert.equal(negative.timedOut, false, "negative integrity process timed out");
  assert.equal(negative.overflow, false, "negative integrity process exceeded output limit");
  assert.equal(negative.signal, null, "negative integrity process received a signal");
  assert.notEqual(negative.code, 0, "tampered native unexpectedly loaded");
  const negativeEvidence = readJson(negativeEvidencePath);
  assert.equal(negativeEvidence.error?.name, "WatchboundLoaderError");
  assert.equal(negativeEvidence.error?.code, "WATCHBOUND_NATIVE_INTEGRITY_MISMATCH");
  assert.equal(negativeEvidence.productionAdapter?.fallbackCalls, 0);
  assert.deepEqual(negativeEvidence.loaderFailureState?.loadedNativePaths, []);
  recordExistingArtifact("negative-integrity.json", rawArtifacts);

  aggregate = sanitizeAggregate({
    sourcePackage,
    sourceAsarSha256,
    generatedAsarSha256,
    executableSha256,
    candidateIdentity,
    matrix,
    target,
    nativeSha256,
    nativeSize: fs.statSync(nativeSource).size,
    iterations,
    negative,
    negativeEvidence,
    rawArtifacts,
    sourceInputs,
    signedPackagePin,
    signedDebSha256: sha256(signedDeb),
    signedAppInventorySha256,
    signedAppInventoryEntries: signedAppInventory.length,
  });
  fs.mkdirSync(path.dirname(sanitizedEvidencePath), { recursive: true });
  fs.writeFileSync(
    sanitizedEvidencePath,
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );
} finally {
  fs.rmSync(workRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  verdict: aggregate.verdict,
  sourceCommit: aggregate.watchbound.sourceCommit,
  signedExecutableSha256: aggregate.signedRuntime.executableSha256,
  nativeSha256: aggregate.native.sha256,
  runtimeVersions: aggregate.signedRuntime.processVersions,
  iterations: aggregate.iterations.map(({ iteration, exit, processResources }) => ({
    iteration,
    exit,
    processResources,
  })),
  negativeIntegrity: aggregate.negativeIntegrity,
  arm64: aggregate.arm64,
  evidence: path.relative(repoRoot, sanitizedEvidencePath),
  rawEvidence: path.relative(repoRoot, rawDir),
})}\n`);

function copyHarness(stagingRoot) {
  for (const relative of [
    "runtime-harness.mjs",
    "installed-package-smoke-helpers.mjs",
    "fixtures/exclusion-smoke-helpers.cjs",
  ]) {
    const destination = path.join(stagingRoot, "watchbound-acceptance", relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(acceptanceDir, relative), destination);
  }
  fs.writeFileSync(
    path.join(stagingRoot, "watchbound-acceptance", "production-adapter.cjs"),
    productionAdapterSource,
  );
}

function materializeRuntime({
  runtimeRoot,
  signedAppRoot: sourceRoot,
  generatedAsar,
  generatedUnpacked,
  archiveNative,
  corruptNative,
}) {
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const executable = path.join(runtimeRoot, "ChatGPT");
  fs.copyFileSync(path.join(sourceRoot, "ChatGPT"), executable);
  fs.chmodSync(executable, fs.statSync(path.join(sourceRoot, "ChatGPT")).mode);
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === "ChatGPT" || entry.name === "resources") continue;
    fs.symlinkSync(
      path.join(sourceRoot, entry.name),
      path.join(runtimeRoot, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
  const resources = path.join(runtimeRoot, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const sourceResources = path.join(sourceRoot, "resources");
  for (const entry of fs.readdirSync(sourceResources, { withFileTypes: true })) {
    if (entry.name === "app.asar" || entry.name === "app.asar.unpacked") continue;
    fs.symlinkSync(
      path.join(sourceResources, entry.name),
      path.join(resources, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
  fs.copyFileSync(generatedAsar, path.join(resources, "app.asar"));
  fs.cpSync(generatedUnpacked, path.join(resources, "app.asar.unpacked"), {
    recursive: true,
  });
  const native = path.join(resources, "app.asar.unpacked", archiveNative);
  if (corruptNative) {
    const bytes = fs.readFileSync(native);
    bytes[bytes.length - 1] ^= 0xff;
    fs.writeFileSync(native, bytes);
  }
}

async function runSigned({
  executable,
  project,
  profile,
  route,
  evidencePath,
  environment,
  version,
  nativeSha256: expectedNativeSha256,
}) {
  const args = [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--project", project,
    "--wrapper", "watchbound",
    "--package-version", version,
    "--native-target", EXPECTED.targetId,
    "--native-sha256", expectedNativeSha256,
    "--route", route,
    "--evidence", evidencePath,
    "--wait-timeout-ms", "10000",
  ];
  return collectProcess(executable, args, {
    cwd: repoRoot,
    env: environment,
    timeoutMs: 60_000,
    maxBytes: 16 * 1024 * 1024,
  });
}

function collectProcess(executable, args, { cwd, env, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let overflow = false;
    let terminationRequested = false;
    let killEscalated = false;
    let killTimer;
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminateGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killEscalated = true;
        terminateGroup(child.pid, "SIGKILL");
      }, 2_000);
    };
    const append = (current, chunk) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > maxBytes && !overflow) {
        overflow = true;
        terminate();
      }
      return next.subarray(0, maxBytes);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      resolve({
        code,
        signal,
        timedOut,
        overflow,
        terminationRequested,
        killEscalated,
        elapsedMs: Date.now() - startedAt,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
      });
    });
  });
}

function terminateGroup(pid, signal) {
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function sanitizeAggregate({
  sourcePackage,
  sourceAsarSha256,
  generatedAsarSha256,
  executableSha256,
  candidateIdentity,
  matrix,
  target,
  nativeSha256,
  nativeSize,
  iterations,
  negative,
  negativeEvidence,
  rawArtifacts,
  sourceInputs,
  signedPackagePin,
  signedDebSha256,
  signedAppInventorySha256,
  signedAppInventoryEntries,
}) {
  const first = iterations[0].evidence;
  for (const { evidence } of iterations.slice(1)) {
    assert.deepEqual(evidence.host, first.host);
    assert.deepEqual(evidence.loaderContract, first.loaderContract);
    assert.deepEqual(evidence.runtimeAdmission, first.runtimeAdmission);
    assert.deepEqual(evidence.qualification, first.qualification);
    assert.deepEqual(evidence.productionAdapter, first.productionAdapter);
  }
  const normalizedNativePath = path.posix.join(
    "resources/app.asar/node_modules/@gadicc/watchbound-node-linux-x64-gnu",
    target.binary,
  );
  const qualification = first.qualification;
  return {
    schemaVersion: 1,
    kind: "codex-watchbound-signed-runtime-acceptance",
    verdict: "passed",
    recordedAt: new Date().toISOString(),
    scope: "signed OpenAI Linux x64 executable; ARM64 unavailable",
    inputs: {
      files: sourceInputs,
      generatedProductionAdapterSha256: productionAdapterSha256,
      watchboundArchives: Object.fromEntries([
        artifactManifest.packages.wrapper,
        artifactManifest.packages.loader,
        ...Object.values(artifactManifest.packages.targets),
      ].map((artifact) => [artifact.name, {
        sha256: artifact.sha256,
        shasum: artifact.shasum,
        integrity: artifact.integrity,
      }])),
      signedStablePackage: {
        repositoryPath: signedPackagePin.repositoryPath,
        sha256: signedDebSha256,
        pinSource: "nix/upstream-linux-packages.json",
      },
    },
    watchbound: {
      version: candidateIdentity.packages.wrapper.version,
      sourceCommit: EXPECTED.sourceCommit,
      runtimeImplementationParent: EXPECTED.runtimeImplementationParent,
      sourceTreeClean: true,
    },
    signedRuntime: {
      executableSha256,
      sourceAsarSha256,
      generatedAcceptanceAsarSha256: generatedAsarSha256,
      officialPackage: {
        name: sourcePackage.name,
        version: sourcePackage.version,
        main: sourcePackage.main,
        repositoryPath: signedPackagePin.repositoryPath,
        debSha256: signedDebSha256,
        dataPayloadInventorySha256: signedAppInventorySha256,
        dataPayloadInventoryEntries: signedAppInventoryEntries,
        verifiedAgainstDebDataPayload: true,
      },
      officialMainPreserved: true,
      platform: first.host.platform,
      architecture: first.host.architecture,
      kernel: first.host.kernel,
      glibc: first.host.glibc,
      processVersions: {
        electron: first.host.electron,
        chrome: first.host.chrome,
        node: first.host.node,
        napi: first.host.nodeApi,
      },
    },
    packages: candidateIdentity.packages,
    native: {
      ...candidateIdentity.target,
      size: nativeSize,
      sha256: nativeSha256,
      resolvedPath: normalizedNativePath,
      loadedPath: normalizedNativePath,
      unpackedPath: normalizedNativePath.replace("app.asar/", "app.asar.unpacked/"),
      exactSelectionWithoutFallback: true,
      elf: target.elf,
    },
    loaderAssertions: {
      ...first.loaderContract,
      javascriptAdmissionHasNoUpperBound:
        first.loaderContract.javascriptAdmission === ">=18.15.0" &&
        !first.loaderContract.javascriptAdmission.includes("<"),
      processNodeApiMinimum: matrix.nodeApiMinimum,
      observedProcessNodeApi: first.host.nodeApi,
      processNodeApiSatisfied: first.host.nodeApi >= matrix.nodeApiMinimum,
      packageVersionLockstep: true,
      digestIntegrity: true,
      elfIdentity: true,
    },
    runtimeAdmission: first.runtimeAdmission,
    productionAdapter: first.productionAdapter,
    iterations: iterations.map(({ iteration, result, evidence }) => ({
      iteration,
      status: "passed",
      exit: {
        code: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        outputOverflow: result.overflow,
        terminationRequested: result.terminationRequested,
        killEscalated: result.killEscalated,
        elapsedMs: result.elapsedMs,
      },
      lifecycleAssertions: evidence.lifecycleAssertions,
      runtime: evidence.runtime,
      processResources: evidence.processResources,
    })),
    qualifyRoot: {
      schemaVersion: qualification.schemaVersion,
      state: qualification.state,
      reasons: qualification.reasons,
      target: qualification.target,
      host: qualification.host,
      root: {
        state: qualification.root.state,
        lexicalPath: "$CODEX_WORKSPACE",
        physicalPath: "$CODEX_WORKSPACE",
        lexicalAndPhysicalPathsEqual:
          qualification.root.lexicalPath === qualification.root.physicalPath,
        filesystem: qualification.root.filesystem,
      },
    },
    negativeIntegrity: {
      status: "passed",
      productionAdapter: negativeEvidence.productionAdapter,
      exit: {
        code: negative.code,
        signal: negative.signal,
        timedOut: negative.timedOut,
        outputOverflow: negative.overflow,
        terminationRequested: negative.terminationRequested,
        killEscalated: negative.killEscalated,
      },
      error: {
        name: negativeEvidence.error.name,
        code: negativeEvidence.error.code,
        message: negativeEvidence.error.message,
        details: negativeEvidence.error.details,
        cause: negativeEvidence.error.cause,
      },
      fallbackAddonLoaded: false,
    },
    reportFreeAdmission: {
      downstreamShimInstalled: false,
      processReportUsed: false,
      evidence: first.runtimeAdmission.libc.evidence,
      admissionSnapshotSharedWithCapabilities: true,
    },
    arm64: {
      status: "unavailable",
      reason: "no signed ARM64 executable or ARM64 execution environment",
    },
    rawArtifacts: rawArtifacts
      .sort((left, right) => left.filename.localeCompare(right.filename)),
    reproduction: {
      command:
        "node linux-features/directory-only-working-tree-watch/acceptance/run-signed-runtime.mjs --watchbound-source <WATCHBOUND_SOURCE> --signed-deb <SIGNED_AMD64_DEB> --raw-dir reports/watchbound-signed-runtime/2.1.2-x64 --evidence linux-features/directory-only-working-tree-watch/acceptance/evidence/signed-runtime-2.1.2-x64.json",
      harness: [
        "linux-features/directory-only-working-tree-watch/acceptance/run-signed-runtime.mjs",
        "linux-features/directory-only-working-tree-watch/acceptance/runtime-harness.mjs",
      ],
    },
  };
}

function recordProcessArtifacts(stem, result, artifacts) {
  for (const [suffix, contents] of [
    ["stdout.log", result.stdout],
    ["stderr.log", result.stderr],
  ]) {
    const filename = `${stem}.${suffix}`;
    fs.writeFileSync(path.join(rawDir, filename), contents);
    recordExistingArtifact(filename, artifacts);
  }
}

function writeRawJson(filename, value, artifacts) {
  fs.writeFileSync(path.join(rawDir, filename), `${JSON.stringify(value, null, 2)}\n`);
  recordExistingArtifact(filename, artifacts);
}

function recordExistingArtifact(filename, artifacts) {
  const source = path.join(rawDir, filename);
  artifacts.push({
    filename: path.posix.join(rawDirRelative.split(path.sep).join("/"), filename),
    sha256: sha256(source),
  });
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })
    .trim();
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(
        "usage: run-signed-runtime.mjs --watchbound-source <path> --signed-deb <path> [--signed-app <path>] [--raw-dir <path>] [--evidence <path>]",
      );
    }
    parsed[flag.slice(2)] = value;
  }
  assert.ok(parsed["watchbound-source"], "--watchbound-source is required");
  assert.ok(parsed["signed-deb"], "--signed-deb is required");
  return parsed;
}

function acceptanceSourceInputs() {
  const sources = [
    path.join(acceptanceDir, "run-signed-runtime.mjs"),
    path.join(acceptanceDir, "runtime-harness.mjs"),
    path.join(acceptanceDir, "installed-package-smoke-helpers.mjs"),
    path.join(acceptanceDir, "fixtures", "exclusion-smoke-helpers.cjs"),
    path.join(repoRoot, "linux-features", "directory-only-working-tree-watch", "patch.js"),
    path.join(repoRoot, "linux-features", "directory-only-working-tree-watch", "watchbound-artifacts.json"),
    upstreamPinsPath,
  ];
  return Object.fromEntries(sources.map((source) => [
    path.relative(repoRoot, source).split(path.sep).join("/"),
    sha256(source),
  ]));
}

function appPayloadInventory(root) {
  const entries = [];
  const visit = (relativeDirectory) => {
    const directory = path.join(root, relativeDirectory);
    for (const name of fs.readdirSync(directory).sort()) {
      const relativePath = path.join(relativeDirectory, name);
      const absolutePath = path.join(root, relativePath);
      const stat = fs.lstatSync(absolutePath);
      const portablePath = relativePath.split(path.sep).join("/");
      if (stat.isDirectory()) {
        visit(relativePath);
      } else if (stat.isFile()) {
        entries.push({
          path: portablePath,
          type: "file",
          mode: stat.mode & 0o7777,
          size: stat.size,
          sha256: sha256(absolutePath),
        });
      } else if (stat.isSymbolicLink()) {
        entries.push({
          path: portablePath,
          type: "symlink",
          target: fs.readlinkSync(absolutePath),
        });
      } else {
        throw new Error(`unsupported signed app payload entry: ${absolutePath}`);
      }
    }
  };
  visit("");
  return entries;
}

function readJson(source) {
  return JSON.parse(fs.readFileSync(source, "utf8"));
}

function sha256(source) {
  return crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
}

function sha256Contents(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}
