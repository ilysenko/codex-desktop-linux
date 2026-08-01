#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PatchIntegrityError,
  isPatchIntegrityError,
} = require("../../scripts/patches/integrity-error.js");

const WATCHBOUND_NODE_RANGE = ">=24.15.0 <25";

function digest(contents, algorithm, encoding) {
  return crypto.createHash(algorithm).update(contents).digest(encoding);
}

function integrityFor(contents) {
  return `sha512-${digest(contents, "sha512", "base64")}`;
}

function currentLibc() {
  try {
    const header = process.report?.getReport?.()?.header;
    if (typeof header?.glibcVersionRuntime === "string") return "glibc";
  } catch {}
  return "unknown";
}

function safeRelativeFilePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value) ||
    value.split(/[\\/]+/u).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a safe relative file path`);
  }
  return value;
}

function packageTarget(extractedDir, packageName) {
  const parts = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  return path.join(extractedDir, "node_modules", ...parts);
}

function exactVersion(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/u.test(value)) {
    throw new Error(`${label} must be an exact semantic version`);
  }
  return value;
}

function nodeVersionSupportsWatchbound(version) {
  const [major, minor, patch] = exactVersion(
    version,
    "Watchbound target Node.js version",
  ).split(".").map(Number);
  return major === 24 && (
    minor > 15 || (minor === 15 && patch >= 0)
  );
}

function extractedAppElectronVersion(extractedDir) {
  const packagePath = path.join(path.resolve(extractedDir), "package.json");
  const stat = fs.lstatSync(packagePath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(
      `Extracted app package metadata is missing or unsafe: ${packagePath}`,
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read extracted app package metadata: ${error.message}`);
  }
  return exactVersion(
    metadata.devDependencies?.electron ?? metadata.dependencies?.electron,
    "Extracted app Electron version",
  );
}

function validateTargetRuntime(
  extractedDir,
  manifest,
  targetElectronVersion,
  targetNodeVersion,
  runtimeQualificationMode = "runtime-probe",
) {
  const buildElectronVersion = exactVersion(
    targetElectronVersion,
    "Target Electron version",
  );
  const appElectronVersion = extractedAppElectronVersion(extractedDir);
  if (appElectronVersion !== buildElectronVersion) {
    throw new Error(
      `Extracted app Electron ${appElectronVersion} does not match build target ` +
        `${buildElectronVersion}`,
    );
  }
  if (buildElectronVersion !== manifest.runtime.electron) {
    throw new Error(
      `Watchbound ${manifest.version} is qualified for Electron ` +
        `${manifest.runtime.electron} / Node.js ${manifest.runtime.node}, got Electron ` +
        `${buildElectronVersion}`,
    );
  }
  if (!nodeVersionSupportsWatchbound(manifest.runtime.node)) {
    throw new Error(
      `Watchbound ${manifest.version} requires Node.js ${WATCHBOUND_NODE_RANGE}, ` +
        `but Electron ${buildElectronVersion} is qualified with Node.js ` +
        `${manifest.runtime.node}`,
    );
  }
  const buildNodeVersion = targetNodeVersion == null || targetNodeVersion === ""
    ? null
    : exactVersion(targetNodeVersion, "Target Node.js version");
  if (buildNodeVersion == null && runtimeQualificationMode !== "inspect-unprobed") {
    throw new Error(
      "Watchbound package staging requires a probed target Node.js version",
    );
  }
  if (buildNodeVersion != null && buildNodeVersion !== manifest.runtime.node) {
    throw new Error(
      `Watchbound ${manifest.version} is qualified for Electron ` +
        `${manifest.runtime.electron} / Node.js ${manifest.runtime.node}, got Node.js ` +
        `${buildNodeVersion}`,
    );
  }
  return {
    electron: buildElectronVersion,
    node: buildNodeVersion ?? manifest.runtime.node,
    nodeRuntimeProbed: buildNodeVersion != null,
  };
}

function validateArtifactManifest(manifest) {
  if (
    manifest == null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.version !== "string" ||
    manifest.version.length === 0
  ) {
    throw new Error("Watchbound artifact manifest is invalid");
  }
  if (
    manifest.source == null ||
    typeof manifest.source !== "object" ||
    !/^[0-9a-f]{40}$/u.test(manifest.source.revision ?? "") ||
    typeof manifest.source.url !== "string" ||
    !/^[0-9a-f]{64}$/u.test(manifest.source.sha256 ?? "")
  ) {
    throw new Error("Watchbound source artifact contract is invalid");
  }
  if (
    manifest.runtime == null ||
    typeof manifest.runtime !== "object" ||
    Array.isArray(manifest.runtime) ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.runtime.electron ?? "") ||
    !/^\d+\.\d+\.\d+$/u.test(manifest.runtime.node ?? "") ||
    manifest.runtime.nodeRange !== WATCHBOUND_NODE_RANGE ||
    !nodeVersionSupportsWatchbound(manifest.runtime.node)
  ) {
    throw new Error("Watchbound target runtime contract is invalid");
  }
  const artifacts = [
    ["wrapper", manifest.packages?.wrapper, "watchbound"],
    ["loader", manifest.packages?.loader, "@gadicc/watchbound-node"],
    [
      "x64 target",
      manifest.packages?.targets?.x64,
      "@gadicc/watchbound-node-linux-x64-gnu",
    ],
    [
      "arm64 target",
      manifest.packages?.targets?.arm64,
      "@gadicc/watchbound-node-linux-arm64-gnu",
    ],
  ];
  for (const [key, packageArtifact, expectedName] of artifacts) {
    if (
      packageArtifact == null ||
      typeof packageArtifact !== "object" ||
      Array.isArray(packageArtifact)
    ) {
      throw new Error(`Watchbound artifact manifest is missing ${key}`);
    }
    if (packageArtifact.name !== expectedName) {
      throw new Error(`Watchbound ${key} package name is invalid`);
    }
    for (const field of [
      "name",
      "license",
      "url",
      "integrity",
      "shasum",
      "sha256",
      "archiveEnvironment",
    ]) {
      if (
        typeof packageArtifact[field] !== "string" ||
        packageArtifact[field].length === 0
      ) {
        throw new Error(`Watchbound ${key} artifact is missing ${field}`);
      }
    }
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(packageArtifact.integrity)) {
      throw new Error(`Watchbound ${key} integrity is invalid`);
    }
    if (!/^[0-9a-f]{40}$/u.test(packageArtifact.shasum)) {
      throw new Error(`Watchbound ${key} shasum is invalid`);
    }
    if (!/^[0-9a-f]{64}$/u.test(packageArtifact.sha256)) {
      throw new Error(`Watchbound ${key} archive SHA-256 is invalid`);
    }
    if (
      packageArtifact.files == null ||
      typeof packageArtifact.files !== "object" ||
      Array.isArray(packageArtifact.files) ||
      Object.keys(packageArtifact.files).length === 0
    ) {
      throw new Error(`Watchbound ${key} artifact has no file contract`);
    }
    for (const [relativePath, sha256] of Object.entries(packageArtifact.files)) {
      safeRelativeFilePath(relativePath, `Watchbound ${key} file`);
      if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(sha256)) {
        throw new Error(`Watchbound ${key} file hash is invalid: ${relativePath}`);
      }
    }
  }

  for (const [architecture, target, expected] of [
    ["x64", manifest.packages.targets.x64, {
      path: "watchbound.linux-x64-gnu.node",
      target: "linux-x64-gnu",
      targetTriple: "x86_64-unknown-linux-gnu",
      elfMachine: 62,
    }],
    ["arm64", manifest.packages.targets.arm64, {
      path: "watchbound.linux-arm64-gnu.node",
      target: "linux-arm64-gnu",
      targetTriple: "aarch64-unknown-linux-gnu",
      elfMachine: 183,
    }],
  ]) {
    const native = target.nativeBinding;
    if (
      native == null ||
      typeof native !== "object" ||
      native.architecture !== architecture ||
      safeRelativeFilePath(native.path, "Watchbound native binding") !== expected.path ||
      native.target !== expected.target ||
      native.targetTriple !== expected.targetTriple ||
      native.libc !== "glibc" ||
      native.elfMachine !== expected.elfMachine ||
      typeof native.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(native.sha256) ||
      target.files[native.path] !== native.sha256
    ) {
      throw new Error(`Watchbound ${architecture} native binding contract is invalid`);
    }
  }
}

function assertNoSymbolicLinkAncestors(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const rootStat = fs.lstatSync(resolvedRoot, { throwIfNoEntry: false });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Watchbound staging root must be a safe directory: ${resolvedRoot}`);
  }
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Watchbound package target must stay inside ${resolvedRoot}`);
  }
  let current = resolvedRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Watchbound staging path must not contain symlinks: ${current}`);
    }
  }
}

function packageFiles(packageDir) {
  const files = new Map();
  const queue = [packageDir];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Watchbound package must not contain symlinks: ${filePath}`);
      }
      if (entry.isDirectory()) {
        queue.push(filePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Watchbound package contains an unsupported entry: ${filePath}`);
      }
      files.set(
        path.relative(packageDir, filePath).split(path.sep).join("/"),
        digest(fs.readFileSync(filePath), "sha256", "hex"),
      );
    }
  }
  return files;
}

function validatePackageFileInventory(packageDir, expectedFiles, packageName) {
  const actualFiles = packageFiles(packageDir);
  if (actualFiles.size !== expectedFiles.size) {
    throw new Error(
      `Watchbound ${packageName} file count mismatch: ` +
        `expected ${expectedFiles.size}, got ${actualFiles.size}`,
    );
  }
  for (const [relativePath, expectedSha256] of expectedFiles) {
    const actualSha256 = actualFiles.get(relativePath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Watchbound ${packageName} hash mismatch for ${relativePath}: ` +
          `expected ${expectedSha256}, got ${actualSha256 ?? "missing"}`,
      );
    }
  }
}

function validatePackageIdentity(packageDir, artifact, version) {
  const stat = fs.lstatSync(packageDir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Watchbound package is missing or unsafe: ${packageDir}`);
  }
  const packagePath = path.join(packageDir, "package.json");
  const metadata = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const native = artifact.nativeBinding;
  if (
    metadata.name !== artifact.name ||
    metadata.version !== version ||
    metadata.license !== artifact.license ||
    metadata.engines?.node !== WATCHBOUND_NODE_RANGE ||
    metadata.watchbound?.delivery !==
      (native == null ? "bundled-native-package" : "target-native-package")
  ) {
    throw new Error(`Watchbound package identity mismatch: ${artifact.name}`);
  }
  if (
    native != null &&
    (
      !Array.isArray(metadata.cpu) ||
      metadata.cpu.length !== 1 ||
      metadata.cpu[0] !== native.architecture ||
      !Array.isArray(metadata.libc) ||
      metadata.libc.length !== 1 ||
      metadata.libc[0] !== native.libc ||
      metadata.watchbound?.target !== native.target ||
      metadata.watchbound?.targetTriple !== native.targetTriple ||
      metadata.watchbound?.architecture !== native.architecture ||
      metadata.watchbound?.libc !== native.libc ||
      metadata.watchbound?.binary !== native.path ||
      metadata.watchbound?.nativeSha256 !== native.sha256
    )
  ) {
    throw new Error(`Watchbound target identity mismatch: ${artifact.name}`);
  }
  packageFiles(packageDir);
  return metadata;
}

function validatePackageTree(packageDir, artifact, version) {
  const metadata = validatePackageIdentity(packageDir, artifact, version);
  const expectedFiles = new Map(Object.entries(artifact.files));
  validatePackageFileInventory(packageDir, expectedFiles, artifact.name);
  return metadata;
}

function inspectNativeBinding(contents, expectedMachine = 62) {
  if (
    !Buffer.isBuffer(contents) ||
    contents.length < 20 ||
    !contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  ) {
    throw new Error("Watchbound native binding is not an ELF binary");
  }
  if (contents[4] !== 2 || contents[5] !== 1) {
    throw new Error("Watchbound native binding must be a little-endian 64-bit ELF binary");
  }
  const machine = contents.readUInt16LE(18);
  if (machine !== expectedMachine) {
    throw new Error(
      `Watchbound native binding has ELF machine ${machine}, expected ${expectedMachine}`,
    );
  }
}

function validateNativeBinding(packageDir, artifact) {
  const contract = artifact.nativeBinding;
  const bindingPath = path.join(packageDir, contract.path);
  const stat = fs.lstatSync(bindingPath, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Watchbound native binding is missing or unsafe: ${bindingPath}`);
  }
  const contents = fs.readFileSync(bindingPath);
  const actualSha256 = digest(contents, "sha256", "hex");
  if (actualSha256 !== contract.sha256) {
    throw new Error(
      `Watchbound native binding hash mismatch: expected ${contract.sha256}, ` +
        `got ${actualSha256}`,
    );
  }
  inspectNativeBinding(contents, contract.elfMachine);
}

function run(command, args, options = {}) {
  try {
    return childProcess.execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const failure = stderr || error?.code || error?.message || "unknown error";
    throw new Error(`${command} ${args.join(" ")} failed: ${failure}`);
  }
}

async function defaultMaterializePackage(request) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-watchbound-"));
  try {
    const archiveOverride = process.env[request.archiveEnvironment]?.trim();
    let archivePath;
    let source;
    if (archiveOverride) {
      archivePath = path.resolve(archiveOverride);
      const stat = fs.lstatSync(archivePath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${request.archiveEnvironment} is not a safe file: ${archivePath}`);
      }
      source = request.archiveEnvironment;
    } else {
      const packOutput = run(
        "npm",
        [
          "pack",
          `${request.name}@${request.version}`,
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          temporaryRoot,
        ],
        { env: { ...process.env, npm_config_ignore_scripts: "true" } },
      );
      let packResult;
      try {
        const packResults = JSON.parse(packOutput);
        if (!Array.isArray(packResults) || packResults.length !== 1) {
          throw new Error("npm pack did not return exactly one archive");
        }
        [packResult] = packResults;
      } catch (error) {
        throw new Error(`Could not parse npm pack output: ${error.message}`);
      }
      archivePath = path.join(
        temporaryRoot,
        safeRelativeFilePath(packResult.filename, "Watchbound npm archive"),
      );
      source = "npm";
    }

    const archive = fs.readFileSync(archivePath);
    const integrity = integrityFor(archive);
    const shasum = digest(archive, "sha1", "hex");
    const sha256 = digest(archive, "sha256", "hex");
    if (
      integrity !== request.integrity ||
      shasum !== request.shasum ||
      sha256 !== request.sha256
    ) {
      throw new Error(
        `Watchbound ${request.name} archive verification failed: expected ` +
          `${request.integrity} / ${request.shasum} / ${request.sha256}, got ` +
          `${integrity} / ${shasum} / ${sha256}`,
      );
    }

    const extractRoot = path.join(temporaryRoot, "extracted");
    fs.mkdirSync(extractRoot);
    run("tar", ["-xzf", archivePath, "-C", extractRoot]);
    const packageDir = path.join(extractRoot, "package");
    return {
      packageDir,
      integrity,
      shasum,
      sha256,
      source,
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      throw augmentFailure(
        error,
        `Watchbound archive cleanup failed: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

function atomicCopyPackage(extractedDir, sourceDir, targetDir) {
  const extractedRoot = path.resolve(extractedDir);
  assertNoSymbolicLinkAncestors(extractedRoot, targetDir);
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  assertNoSymbolicLinkAncestors(extractedRoot, targetDir);
  const temporaryDir = path.join(
    path.dirname(targetDir),
    `.${path.basename(targetDir)}.codex-watchbound-${process.pid}-` +
      crypto.randomBytes(8).toString("hex"),
  );
  try {
    fs.cpSync(sourceDir, temporaryDir, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    assertNoSymbolicLinkAncestors(extractedRoot, targetDir);
    fs.renameSync(temporaryDir, targetDir);
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

async function preparePackage(options) {
  const targetDir = packageTarget(options.extractedDir, options.artifact.name);
  assertNoSymbolicLinkAncestors(path.resolve(options.extractedDir), targetDir);
  const existing = fs.lstatSync(targetDir, { throwIfNoEntry: false });
  if (existing != null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Existing Watchbound package target is unsafe: ${targetDir}`);
    }
    validatePackageTree(targetDir, options.artifact, options.version);
    if (options.artifact.nativeBinding != null) {
      validateNativeBinding(targetDir, options.artifact);
    }
    return {
      artifact: options.artifact,
      changed: false,
      source: "existing-package",
      targetDir,
      validate: (packageDir) => {
        validatePackageTree(packageDir, options.artifact, options.version);
        if (options.artifact.nativeBinding != null) {
          validateNativeBinding(packageDir, options.artifact);
        }
      },
    };
  }

  const materialized = await options.materializePackage({
    ...options.artifact,
    version: options.version,
  });
  if (
    materialized?.integrity !== options.artifact.integrity ||
    materialized?.shasum !== options.artifact.shasum ||
    materialized?.sha256 !== options.artifact.sha256
  ) {
    const failure = new Error(
      `Watchbound materializer identity mismatch: ${options.artifact.name}`,
    );
    try {
      materialized?.cleanup?.();
    } catch (cleanupError) {
      throw augmentFailure(
        failure,
        `Watchbound materializer cleanup failed for ${options.artifact.name}: ` +
          errorMessage(cleanupError),
      );
    }
    throw failure;
  }
  const validate = (packageDir) => {
    validatePackageTree(packageDir, options.artifact, options.version);
    if (options.artifact.nativeBinding != null) {
      validateNativeBinding(packageDir, options.artifact);
    }
  };
  try {
    validate(materialized.packageDir);
  } catch (error) {
    try {
      materialized?.cleanup?.();
    } catch (cleanupError) {
      throw augmentFailure(
        error,
        `Watchbound materializer cleanup failed for ${options.artifact.name}: ` +
          errorMessage(cleanupError),
      );
    }
    throw error;
  }
  return {
    artifact: options.artifact,
    changed: true,
    cleanup: materialized.cleanup,
    source: materialized.source ?? "verified-archive",
    sourceDir: materialized.packageDir,
    targetDir,
    validate,
  };
}

function controlledArtifact(packageDir, artifact) {
  if (artifact.nativeBinding == null) return artifact;
  const metadata = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
  );
  const nativeSha256 = metadata.watchbound?.nativeSha256;
  if (typeof nativeSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(nativeSha256)) {
    throw new Error(`Watchbound controlled target digest is invalid: ${artifact.name}`);
  }
  return {
    ...artifact,
    nativeBinding: { ...artifact.nativeBinding, sha256: nativeSha256 },
  };
}

function sourcePackageTarget(sourcePackageRoot, packageName) {
  const parts = packageName.startsWith("@") ? packageName.split("/") : [packageName];
  const target = path.join(path.resolve(sourcePackageRoot), ...parts);
  assertNoSymbolicLinkAncestors(path.resolve(sourcePackageRoot), target);
  return target;
}

function prepareControlledPackage(options) {
  const sourceDir = sourcePackageTarget(
    options.sourcePackageRoot,
    options.artifact.name,
  );
  const artifact = controlledArtifact(sourceDir, options.artifact);
  validatePackageIdentity(sourceDir, artifact, options.version);
  if (artifact.nativeBinding != null) validateNativeBinding(sourceDir, artifact);
  const sourceFiles = packageFiles(sourceDir);
  const validate = (packageDir) => {
    validatePackageIdentity(packageDir, artifact, options.version);
    if (artifact.nativeBinding != null) validateNativeBinding(packageDir, artifact);
    validatePackageFileInventory(packageDir, sourceFiles, artifact.name);
  };

  const targetDir = packageTarget(options.extractedDir, artifact.name);
  assertNoSymbolicLinkAncestors(path.resolve(options.extractedDir), targetDir);
  const existing = fs.lstatSync(targetDir, { throwIfNoEntry: false });
  if (existing != null) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error(`Existing Watchbound package target is unsafe: ${targetDir}`);
    }
    validate(targetDir);
    return {
      artifact,
      changed: false,
      source: "existing-controlled-package",
      targetDir,
      validate,
    };
  }

  return {
    artifact,
    changed: true,
    source: "nix-source-build",
    sourceDir,
    targetDir,
    validate,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function augmentFailure(primary, detail, options = {}) {
  const message = primary == null
    ? detail
    : `${errorMessage(primary)}; additionally, ${detail}`;
  if (options.integrity || isPatchIntegrityError(primary)) {
    return new PatchIntegrityError(message, primary == null ? undefined : { cause: primary });
  }
  return new Error(message, primary == null ? undefined : { cause: primary });
}

function removeAndVerifyAbsent(targetDir, remove) {
  let removalError = null;
  try {
    remove(targetDir);
  } catch (error) {
    removalError = error;
  }

  try {
    if (fs.lstatSync(targetDir, { throwIfNoEntry: false }) == null) return null;
  } catch (verificationError) {
    const removalContext = removalError == null
      ? ""
      : `${errorMessage(removalError)}; `;
    return new Error(
      `${removalContext}could not verify target absence: ${errorMessage(verificationError)}`,
      removalError == null ? { cause: verificationError } : { cause: removalError },
    );
  }

  return removalError instanceof Error
    ? removalError
    : new Error(removalError == null ? "target still exists" : errorMessage(removalError));
}

function assertUnselectedTargetAbsent(extractedDir, artifact) {
  const targetDir = packageTarget(extractedDir, artifact.name);
  assertNoSymbolicLinkAncestors(path.resolve(extractedDir), targetDir);
  if (fs.lstatSync(targetDir, { throwIfNoEntry: false }) != null) {
    throw new Error(
      `Unselected Watchbound native target must be absent: ${targetDir}`,
    );
  }
}

function createOwnedPackageParents(
  extractedRoot,
  targetDir,
  createdDirectories,
  createDirectory,
) {
  const missing = [];
  let parent = path.dirname(targetDir);
  while (parent !== extractedRoot) {
    const state = fs.lstatSync(parent, { bigint: true, throwIfNoEntry: false });
    if (state != null) {
      if (!state.isDirectory() || state.isSymbolicLink()) {
        throw new Error(`Watchbound package parent is unsafe: ${parent}`);
      }
      break;
    }
    missing.push(parent);
    parent = path.dirname(parent);
  }

  for (const directory of missing.reverse()) {
    let created = false;
    let state = null;
    try {
      createDirectory(directory);
      created = true;
    } catch (error) {
      try {
        assertNoSymbolicLinkAncestors(extractedRoot, directory);
        state = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
      } catch (verificationError) {
        throw new PatchIntegrityError(
          `Watchbound package parent creation outcome could not be proven for ${directory}: ` +
            `${errorMessage(verificationError)}`,
          { cause: error },
        );
      }
      if (error?.code !== "EEXIST") {
        if (state != null) {
          throw new PatchIntegrityError(
            `Watchbound package parent creation ownership could not be proven for ${directory}`,
            { cause: error },
          );
        }
        throw error;
      }
      if (state == null) throw error;
    }
    try {
      assertNoSymbolicLinkAncestors(extractedRoot, directory);
    } catch (error) {
      if (created) {
        throw new PatchIntegrityError(
          `Watchbound package parent ownership could not be proven for ${directory}`,
          { cause: error },
        );
      }
      throw error;
    }
    state ??= fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
    if (state == null || !state.isDirectory() || state.isSymbolicLink()) {
      const message = `Watchbound package parent is unsafe after creation: ${directory}`;
      if (created) throw new PatchIntegrityError(message);
      throw new Error(message);
    }
    if (created) {
      createdDirectories.set(directory, { dev: state.dev, ino: state.ino });
    }
  }
}

function commitPackageDirectoryNoReplace(
  sourceDir,
  targetDir,
  onReserved,
  onCreated,
) {
  // mkdir is the atomic no-replace operation for the package root. Once this
  // succeeds, only this transaction owns the target pathname; copying into the
  // reserved directory cannot replace a package created by another actor.
  fs.mkdirSync(targetDir);
  // Record the successful namespace mutation before any fallible identity
  // probe. If identity cannot subsequently be established, the caller must
  // report failed-integrity rather than forgetting the created reservation.
  onCreated?.();
  let state;
  try {
    state = fs.lstatSync(targetDir, { bigint: true });
  } catch (error) {
    throw new PatchIntegrityError(
      `Watchbound package reservation identity could not be proven for ` +
        `${targetDir}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new PatchIntegrityError(
      `Watchbound package reservation is unsafe: ${targetDir}`,
    );
  }
  const identity = { dev: state.dev, ino: state.ino };
  onReserved?.({ ...identity });
  assertPackageReservationIdentity(
    targetDir,
    identity,
    "reservation identity changed before package copy",
  );
  copyPackageIntoReservation(sourceDir, targetDir, identity);
  assertPackageReservationIdentity(
    targetDir,
    identity,
    "reservation identity changed during package copy",
  );
  return identity;
}

function copyPackageIntoReservation(sourceDir, targetDir, identity) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      targetDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const state = fs.fstatSync(descriptor, { bigint: true });
    if (
      !state.isDirectory() ||
      state.dev !== identity.dev ||
      state.ino !== identity.ino
    ) {
      throw new PatchIntegrityError(
        `Watchbound package reservation identity changed before descriptor binding: ` +
          targetDir,
      );
    }
    // Linux procfs resolves this path through the already-open directory
    // descriptor. A concurrent rename of the public target pathname therefore
    // cannot redirect package bytes into a replacement directory.
    fs.cpSync(sourceDir, `/proc/self/fd/${descriptor}/.`, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
    const copiedState = fs.fstatSync(descriptor, { bigint: true });
    if (
      !copiedState.isDirectory() ||
      copiedState.dev !== identity.dev ||
      copiedState.ino !== identity.ino
    ) {
      throw new PatchIntegrityError(
        `Watchbound package reservation descriptor identity changed during copy: ` +
          targetDir,
      );
    }
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
  }
}

function assertPackageReservationIdentity(targetDir, identity, message) {
  let state;
  try {
    state = fs.lstatSync(targetDir, { bigint: true, throwIfNoEntry: false });
  } catch (error) {
    throw new PatchIntegrityError(
      `Watchbound package ${message}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (
    state == null ||
    !state.isDirectory() ||
    state.isSymbolicLink() ||
    state.dev !== identity.dev ||
    state.ino !== identity.ino
  ) {
    throw new PatchIntegrityError(`Watchbound package ${message}: ${targetDir}`);
  }
}

function quarantinePath(quarantineRoot, purpose) {
  return path.join(
    quarantineRoot,
    `.codex-watchbound-${purpose}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
}

function quarantineOwnedDirectoryAndVerifyAbsent(options) {
  const {
    root,
    targetDir,
    identity,
    quarantineRoot,
    purpose,
    missingMessage,
    changedMessage,
    quarantineChangedMessage,
    rename,
    remove,
    preserveQuarantineRoot,
  } = options;
  if (identity == null) {
    return new Error("package directory identity could not be proven before rollback");
  }
  const quarantinedDir = quarantinePath(quarantineRoot, purpose);
  try {
    assertNoSymbolicLinkAncestors(root, targetDir);
    assertNoSymbolicLinkAncestors(root, quarantinedDir);
    const state = fs.lstatSync(targetDir, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (state == null) {
      return new Error(missingMessage);
    }
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.dev !== identity.dev ||
      state.ino !== identity.ino
    ) {
      return new Error(changedMessage);
    }
  } catch (error) {
    return error instanceof Error ? error : new Error(errorMessage(error));
  }

  let renameError = null;
  try {
    rename(targetDir, quarantinedDir);
  } catch (error) {
    renameError = error;
  }

  let sourceState;
  let quarantineState;
  try {
    sourceState = fs.lstatSync(targetDir, {
      bigint: true,
      throwIfNoEntry: false,
    });
    quarantineState = fs.lstatSync(quarantinedDir, {
      bigint: true,
      throwIfNoEntry: false,
    });
  } catch (error) {
    preserveQuarantineRoot?.();
    return new Error(
      `${quarantineChangedMessage}: ${errorMessage(error)}`,
      { cause: renameError ?? error },
    );
  }
  if (quarantineState == null) {
    const detail = sourceState == null
      ? missingMessage
      : `could not move owned directory into rollback quarantine: ` +
        errorMessage(renameError ?? "rename did not commit");
    return new Error(detail, renameError == null ? undefined : { cause: renameError });
  }
  if (
    !quarantineState.isDirectory() ||
    quarantineState.isSymbolicLink() ||
    quarantineState.dev !== identity.dev ||
    quarantineState.ino !== identity.ino
  ) {
    preserveQuarantineRoot?.();
    return new Error(quarantineChangedMessage, renameError == null
      ? undefined
      : { cause: renameError });
  }

  // Only the verified quarantine name reaches the production remover. Optional
  // injected remover functions are trusted in-process test hooks and cannot be
  // sandboxed from deliberately mutating unrelated paths.
  const removalError = removeAndVerifyAbsent(quarantinedDir, remove);
  if (removalError != null) {
    preserveQuarantineRoot?.();
    return removalError;
  }
  if (sourceState != null) {
    return new Error(`${changedMessage}; a replacement appeared during quarantine`);
  }
  return null;
}

function removeOwnedPackageAndVerifyAbsent(
  root,
  targetDir,
  identity,
  stagingRoot,
  rename,
  remove,
  preserveStagingRoot,
) {
  return quarantineOwnedDirectoryAndVerifyAbsent({
    root,
    targetDir,
    identity,
    quarantineRoot: stagingRoot,
    purpose: "package-rollback",
    missingMessage: "package directory disappeared before rollback",
    changedMessage: "package directory identity changed before rollback",
    quarantineChangedMessage:
      "package directory identity changed during rollback quarantine",
    rename,
    remove,
    preserveQuarantineRoot: preserveStagingRoot,
  });
}

function removeOwnedStagingRootAndVerifyAbsent(
  root,
  stagingRoot,
  identity,
  rename,
  remove,
) {
  return quarantineOwnedDirectoryAndVerifyAbsent({
    root,
    targetDir: stagingRoot,
    identity,
    quarantineRoot: root,
    purpose: "staging-cleanup",
    missingMessage: "staging root disappeared before cleanup",
    changedMessage: "staging root identity changed before cleanup",
    quarantineChangedMessage: "staging root identity changed during cleanup quarantine",
    rename,
    remove,
  });
}

function removeOwnedPackageParentAndVerifyAbsent(
  root,
  targetDir,
  identity,
  stagingRoot,
  rename,
  remove,
  preserveStagingRoot,
) {
  try {
    assertNoSymbolicLinkAncestors(root, targetDir);
    const state = fs.lstatSync(targetDir, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (state == null) {
      return new Error("directory disappeared before rollback");
    }
    if (
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      state.dev !== identity.dev ||
      state.ino !== identity.ino
    ) {
      return new Error("directory identity changed before rollback");
    }
    if (fs.readdirSync(targetDir).length > 0) {
      return new Error("directory is not empty before rollback");
    }
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return new Error("directory disappeared before rollback");
    }
    return error instanceof Error ? error : new Error(errorMessage(error));
  }
  return quarantineOwnedDirectoryAndVerifyAbsent({
    root,
    targetDir,
    identity,
    quarantineRoot: stagingRoot,
    purpose: "parent-rollback",
    missingMessage: "directory disappeared before rollback",
    changedMessage: "directory identity changed before rollback",
    quarantineChangedMessage: "directory identity changed during rollback quarantine",
    rename,
    remove,
    preserveQuarantineRoot: preserveStagingRoot,
  });
}

function commitPreparedPackages(extractedDir, prepared, options = {}) {
  const missing = prepared.filter((entry) => entry.changed);
  if (missing.length === 0) {
    options.validatePackageSet?.();
    for (const entry of prepared) entry.validate(entry.targetDir);
    return;
  }

  const renamePackage = options.renamePackage;
  const renameOwnedPath = fs.renameSync;
  const removePackage = options.removePackage ?? ((targetDir) => {
    fs.rmSync(targetDir, { recursive: true, force: true });
  });
  const removeStagingRoot = options.removeStagingRoot ?? ((targetDir) => {
    fs.rmSync(targetDir, { recursive: true, force: true });
  });
  const createPackageDirectory = options.createPackageDirectory ?? ((targetDir) => {
    fs.mkdirSync(targetDir);
  });
  const removePackageDirectory = options.removePackageDirectory ?? ((targetDir) => {
    fs.rmdirSync(targetDir);
  });
  const extractedRoot = path.resolve(extractedDir);
  const stagingRoot = fs.mkdtempSync(
    path.join(extractedRoot, ".codex-watchbound-package-set-"),
  );
  let stagingRootState;
  try {
    assertNoSymbolicLinkAncestors(extractedRoot, stagingRoot);
    stagingRootState = fs.lstatSync(stagingRoot, { bigint: true });
    if (!stagingRootState.isDirectory() || stagingRootState.isSymbolicLink()) {
      throw new Error(`staging root is unsafe: ${stagingRoot}`);
    }
  } catch (error) {
    throw new PatchIntegrityError(
      `Watchbound package staging-root ownership could not be proven for ` +
        `${stagingRoot}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const stagingRootIdentity = {
    dev: stagingRootState.dev,
    ino: stagingRootState.ino,
  };
  const staged = [];
  const committed = [];
  const createdDirectories = new Map();
  let preserveStagingRoot = false;
  let failure = null;
  try {
    for (const entry of prepared) {
      if (!entry.changed) entry.validate(entry.targetDir);
    }
    for (const entry of missing) {
      const stagedTarget = packageTarget(stagingRoot, entry.artifact.name);
      atomicCopyPackage(stagingRoot, entry.sourceDir, stagedTarget);
      entry.validate(stagedTarget);
      staged.push({ entry, stagedTarget });
    }

    // Recheck every destination after the potentially slow materialization and
    // copy phase. No app package has been changed before this point.
    for (const { entry } of staged) {
      assertNoSymbolicLinkAncestors(extractedRoot, entry.targetDir);
      if (fs.lstatSync(entry.targetDir, { throwIfNoEntry: false }) != null) {
        throw new Error(
          `Watchbound package target changed during staging: ${entry.targetDir}`,
        );
      }
    }
    options.validatePackageSet?.();

    for (const { entry, stagedTarget } of staged) {
      createOwnedPackageParents(
        extractedRoot,
        entry.targetDir,
        createdDirectories,
        createPackageDirectory,
      );
      assertNoSymbolicLinkAncestors(extractedRoot, entry.targetDir);
      if (renamePackage == null) {
        const committedReservation = {
          targetDir: entry.targetDir,
          identity: null,
        };
        const reservationIdentity = commitPackageDirectoryNoReplace(
          stagedTarget,
          entry.targetDir,
          (identity) => { committedReservation.identity = identity; },
          () => committed.push(committedReservation),
        );
        assertNoSymbolicLinkAncestors(extractedRoot, entry.targetDir);
        assertPackageReservationIdentity(
          entry.targetDir,
          reservationIdentity,
          "reservation identity changed before commit acceptance",
        );
        continue;
      }
      const stagedIdentity = fs.lstatSync(stagedTarget, { bigint: true });
      try {
        renamePackage(stagedTarget, entry.targetDir);
      } catch (renameError) {
        let sourceState;
        let targetState;
        try {
          sourceState = fs.lstatSync(stagedTarget, {
            bigint: true,
            throwIfNoEntry: false,
          });
          targetState = fs.lstatSync(entry.targetDir, {
            bigint: true,
            throwIfNoEntry: false,
          });
        } catch (verificationError) {
          throw new PatchIntegrityError(
            `Watchbound package rename outcome could not be proven for ${entry.targetDir}: ` +
              `${errorMessage(verificationError)}`,
            { cause: renameError },
          );
        }
        if (sourceState == null && targetState != null) {
          if (
            targetState.isDirectory() &&
            !targetState.isSymbolicLink() &&
            targetState.dev === stagedIdentity.dev &&
            targetState.ino === stagedIdentity.ino
          ) {
            committed.push({
              targetDir: entry.targetDir,
              identity: { dev: stagedIdentity.dev, ino: stagedIdentity.ino },
            });
          } else {
            throw new PatchIntegrityError(
              `Watchbound package rename ownership could not be proven for ${entry.targetDir}: ` +
                "destination identity does not match the staged package",
              { cause: renameError },
            );
          }
        } else if (sourceState != null && targetState != null) {
          throw new PatchIntegrityError(
            `Watchbound package rename ownership could not be proven for ${entry.targetDir}: ` +
              "staged source and destination both exist",
            { cause: renameError },
          );
        } else if (sourceState == null && targetState == null) {
          throw new PatchIntegrityError(
            `Watchbound package rename outcome could not be proven for ${entry.targetDir}: ` +
              "staged source and destination both disappeared",
            { cause: renameError },
          );
        }
        throw renameError;
      }
      committed.push({
        targetDir: entry.targetDir,
        identity: { dev: stagedIdentity.dev, ino: stagedIdentity.ino },
      });
    }
    options.validatePackageSet?.();
    for (const entry of prepared) entry.validate(entry.targetDir);
  } catch (error) {
    const rollbackFailures = [];
    for (const { targetDir, identity } of committed.reverse()) {
      const rollbackError = removeOwnedPackageAndVerifyAbsent(
        extractedRoot,
        targetDir,
        identity,
        stagingRoot,
        renameOwnedPath,
        removePackage,
        () => { preserveStagingRoot = true; },
      );
      if (rollbackError != null) {
        rollbackFailures.push(`${targetDir}: ${rollbackError.message}`);
      }
    }
    for (const [directory, identity] of [...createdDirectories].sort(
      ([left], [right]) => right.length - left.length,
    )) {
      const rollbackError = removeOwnedPackageParentAndVerifyAbsent(
        extractedRoot,
        directory,
        identity,
        stagingRoot,
        renameOwnedPath,
        removePackageDirectory,
        () => { preserveStagingRoot = true; },
      );
      if (rollbackError != null) {
        rollbackFailures.push(`${directory}: ${rollbackError.message}`);
      }
    }
    if (rollbackFailures.length > 0) {
      failure = new PatchIntegrityError(
        `Watchbound package transaction failed (${error.message}) and rollback ` +
          `could not be proven: ${rollbackFailures.join("; ")}`,
        { cause: error },
      );
    } else {
      failure = error;
    }
  }
  const cleanupError = preserveStagingRoot
    ? new Error("staging root cleanup skipped because rollback quarantine is untrusted")
    : removeOwnedStagingRootAndVerifyAbsent(
      extractedRoot,
      stagingRoot,
      stagingRootIdentity,
      renameOwnedPath,
      removeStagingRoot,
    );
  if (cleanupError != null) {
    failure = augmentFailure(
      failure,
      `Watchbound package staging-root cleanup failed: ${errorMessage(cleanupError)}`,
      { integrity: true },
    );
  }
  if (failure != null) throw failure;
}

async function stageWatchboundPackages(options) {
  if (options.arch !== "x64" && options.arch !== "arm64") {
    throw new Error(
      `Watchbound ${options.manifest.version} has no Linux GNU target for ${options.arch}`,
    );
  }
  const libc = options.libc ?? currentLibc();
  if (libc !== "glibc") {
    throw new Error(
      `Watchbound ${options.manifest.version} requires Linux glibc, got ${libc}`,
    );
  }
  validateArtifactManifest(options.manifest);
  const runtime = validateTargetRuntime(
    options.extractedDir,
    options.manifest,
    options.targetElectronVersion,
    options.targetNodeVersion,
    options.runtimeQualificationMode,
  );
  const materializePackage = options.materializePackage ?? defaultMaterializePackage;
  const artifacts = [
    options.manifest.packages.targets[options.arch],
    options.manifest.packages.loader,
    options.manifest.packages.wrapper,
  ];
  const unselectedArch = options.arch === "x64" ? "arm64" : "x64";
  assertUnselectedTargetAbsent(
    options.extractedDir,
    options.manifest.packages.targets[unselectedArch],
  );

  const results = [];
  let failure = null;
  try {
    for (const artifact of artifacts) {
      if (options.sourcePackageRoot) {
        results.push(prepareControlledPackage({
          extractedDir: options.extractedDir,
          version: options.manifest.version,
          artifact,
          sourcePackageRoot: options.sourcePackageRoot,
        }));
      } else {
        results.push(await preparePackage({
          extractedDir: options.extractedDir,
          version: options.manifest.version,
          artifact,
          materializePackage,
        }));
      }
    }
    const validatePackageSet = () => assertUnselectedTargetAbsent(
      options.extractedDir,
      options.manifest.packages.targets[unselectedArch],
    );
    validatePackageSet();
    commitPreparedPackages(
      options.extractedDir,
      results,
      {
        renamePackage: options.renamePackage,
        removePackage: options.removePackage,
        removeStagingRoot: options.removeStagingRoot,
        createPackageDirectory: options.createPackageDirectory,
        removePackageDirectory: options.removePackageDirectory,
        validatePackageSet,
      },
    );
    validatePackageSet();
  } catch (error) {
    failure = error;
  }
  const cleanupFailures = [];
  for (const result of results) {
    try {
      result.cleanup?.();
    } catch (cleanupError) {
      cleanupFailures.push(`${result.artifact.name}: ${errorMessage(cleanupError)}`);
    }
  }
  if (cleanupFailures.length > 0) {
    failure = augmentFailure(
      failure,
      `Watchbound materializer cleanup failed: ${cleanupFailures.join("; ")}`,
    );
  }
  if (failure != null) throw failure;
  return {
    changed: results.some((result) => result.changed),
    alreadyApplied: results.every((result) => !result.changed),
    version: options.manifest.version,
    source: [...new Set(results.map((result) => result.source))].join("+"),
    targets: results.map((result) => result.targetDir),
    runtime,
  };
}

function packageHelperExitCode(error) {
  return isPatchIntegrityError(error) ? 86 : 1;
}

function currentArtifactManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(__dirname, "watchbound-artifacts.json"), "utf8"),
  );
}

async function main() {
  if (process.argv[2] !== "--stage" || !process.argv[3]) {
    console.error("Usage: watchbound-package.js --stage <extracted-app-dir>");
    process.exitCode = 1;
    return;
  }
  const sourcePackageRoot = process.env.CODEX_WATCHBOUND_PACKAGE_ROOT?.trim() || null;
  if (
    sourcePackageRoot != null &&
    !path.resolve(sourcePackageRoot).startsWith(`${path.sep}nix${path.sep}store${path.sep}`)
  ) {
    throw new Error("CODEX_WATCHBOUND_PACKAGE_ROOT must refer to the immutable Nix store");
  }
  const result = await stageWatchboundPackages({
    extractedDir: process.argv[3],
    arch: process.arch,
    manifest: currentArtifactManifest(),
    sourcePackageRoot,
    targetElectronVersion: process.env.CODEX_TARGET_ELECTRON_VERSION,
    targetNodeVersion: process.env.CODEX_TARGET_NODE_VERSION,
    runtimeQualificationMode: process.env.CODEX_RUNTIME_QUALIFICATION_MODE,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    const integrityFailure = isPatchIntegrityError(error);
    console.error(
      `ERROR${integrityFailure ? " [PATCH_INTEGRITY_FAILURE]" : ""}: ${error.message}`,
    );
    process.exitCode = packageHelperExitCode(error);
  });
}

module.exports = {
  defaultMaterializePackage,
  currentLibc,
  commitPackageDirectoryNoReplace,
  inspectNativeBinding,
  nodeVersionSupportsWatchbound,
  packageHelperExitCode,
  packageTarget,
  stageWatchboundPackages,
  validateArtifactManifest,
  validatePackageIdentity,
  validatePackageTree,
  validateTargetRuntime,
};
