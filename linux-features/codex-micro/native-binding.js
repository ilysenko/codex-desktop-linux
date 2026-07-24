#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SUPPORTED_ARCHITECTURES = new Set(["x64", "arm64"]);
const SOURCE_BUILD_TOOLCHAIN_DIR = path.join(__dirname, "source-build");
const SOURCE_BUILD_DEPENDENCIES = Object.freeze({
  "@electron/rebuild": "4.0.4",
  "node-addon-api": "3.2.1",
  "pkg-prebuilds": "1.0.0",
});

function readPackageMetadata(packageDir, label) {
  const packagePath = path.join(packageDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`${label} package.json is missing: ${packagePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} package.json is unreadable: ${error.message}`);
  }
}

function requirePackageDirectory(packageDir, expectedName, label) {
  if (!fs.statSync(packageDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} package is missing: ${packageDir}`);
  }
  const metadata = readPackageMetadata(packageDir, label);
  if (metadata.name !== expectedName) {
    throw new Error(`${label} package identity mismatch: expected ${expectedName}, got ${metadata.name ?? "unknown"}`);
  }
  return metadata;
}

function discoverBundledNodeHid(extractedDir) {
  const deviceKitDir = path.join(
    path.resolve(extractedDir),
    "node_modules",
    "@worklouder",
    "device-kit-oai",
  );
  requirePackageDirectory(deviceKitDir, "@worklouder/device-kit-oai", "Work Louder device-kit-oai");

  const workLouderKitDir = path.join(
    deviceKitDir,
    "node_modules",
    "@worklouder",
    "wl-device-kit",
  );
  requirePackageDirectory(workLouderKitDir, "@worklouder/wl-device-kit", "Work Louder wl-device-kit");

  const nodeHidDir = path.join(workLouderKitDir, "node_modules", "node-hid");
  const nodeHid = requirePackageDirectory(nodeHidDir, "node-hid", "Work Louder nested node-hid");
  return {
    deviceKitDir,
    workLouderKitDir,
    nodeHidDir,
    packageMetadata: nodeHid,
    name: nodeHid.name,
    version: nodeHid.version,
    license: nodeHid.license,
  };
}

function normalizeArchitecture(arch) {
  if (!SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`Unsupported Codex Micro native binding architecture: ${String(arch)}`);
  }
  return arch;
}

function selectPrebuild(artifactManifest, arch) {
  normalizeArchitecture(arch);
  return artifactManifest?.prebuilds?.[arch] ?? null;
}

function inspectElf(contents) {
  if (!Buffer.isBuffer(contents) || contents.length < 20 || !contents.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error("Native binding is not an ELF binary");
  }
  if (contents[4] !== 2) {
    throw new Error(`Unsupported ELF class ${contents[4]}; expected a 64-bit ELF binary`);
  }
  if (contents[5] !== 1) {
    throw new Error(`Unsupported ELF encoding ${contents[5]}; expected little-endian`);
  }
  const machine = contents.readUInt16LE(18);
  const arch = machine === 62 ? "x64" : machine === 183 ? "arm64" : null;
  if (arch == null) {
    throw new Error(`Unsupported ELF machine ${machine}`);
  }
  return { arch, machine };
}

function digest(contents, algorithm, encoding) {
  return crypto.createHash(algorithm).update(contents).digest(encoding);
}

function integrityFor(contents) {
  return `sha512-${digest(contents, "sha512", "base64")}`;
}

function equalStringMaps(left, right) {
  if (left == null || right == null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries)
    && leftEntries.every(([, value]) => typeof value === "string");
}

function loadSourceBuildToolchain(toolchainDir = SOURCE_BUILD_TOOLCHAIN_DIR) {
  const root = path.resolve(toolchainDir);
  const packageJsonPath = path.join(root, "package.json");
  const packageLockPath = path.join(root, "package-lock.json");
  for (const filePath of [packageJsonPath, packageLockPath]) {
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Codex Micro source-build toolchain file is missing or unsafe: ${filePath}`);
    }
  }

  const packageRaw = fs.readFileSync(packageJsonPath);
  const lockRaw = fs.readFileSync(packageLockPath);
  let manifest;
  let lock;
  try {
    manifest = JSON.parse(packageRaw.toString("utf8"));
    lock = JSON.parse(lockRaw.toString("utf8"));
  } catch (error) {
    throw new Error(`Codex Micro source-build toolchain JSON is invalid: ${error.message}`);
  }

  if (manifest.private !== true || !equalStringMaps(manifest.dependencies, SOURCE_BUILD_DEPENDENCIES)) {
    throw new Error("Codex Micro source-build package.json dependencies do not match the pinned toolchain");
  }
  if (lock.lockfileVersion !== 3 || lock.packages == null || typeof lock.packages !== "object") {
    throw new Error("Codex Micro source-build package-lock.json must use lockfileVersion 3");
  }
  const lockRoot = lock.packages[""];
  if (
    lock.name !== manifest.name
    || lock.version !== manifest.version
    || lockRoot?.name !== manifest.name
    || lockRoot?.version !== manifest.version
    || !equalStringMaps(lockRoot?.dependencies, SOURCE_BUILD_DEPENDENCIES)
  ) {
    throw new Error("Codex Micro source-build package-lock root does not match package.json");
  }

  const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  const registryArtifact = /^https:\/\/registry\.npmjs\.org\//;
  const sha512Integrity = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (packagePath === "" || entry?.link === true) {
      continue;
    }
    if (
      entry == null
      || typeof entry !== "object"
      || !exactVersion.test(entry.version ?? "")
      || !registryArtifact.test(entry.resolved ?? "")
      || !sha512Integrity.test(entry.integrity ?? "")
    ) {
      throw new Error(`Codex Micro source-build lock entry is not integrity-pinned: ${packagePath}`);
    }
  }

  return {
    packageJsonPath,
    packageLockPath,
    lockSha256: digest(lockRaw, "sha256", "hex"),
  };
}

function validateArtifactManifest(artifactManifest) {
  if (artifactManifest == null || typeof artifactManifest !== "object" || Array.isArray(artifactManifest)) {
    throw new Error("Codex Micro node-hid artifact manifest is invalid");
  }
  for (const key of ["name", "version", "license", "integrity", "shasum"]) {
    if (typeof artifactManifest[key] !== "string" || artifactManifest[key].length === 0) {
      throw new Error(`Codex Micro node-hid artifact manifest is missing ${key}`);
    }
  }
  const loaderContract = artifactManifest.loaderContract;
  if (
    loaderContract == null
    || typeof loaderContract !== "object"
    || Array.isArray(loaderContract)
    || typeof loaderContract.main !== "string"
    || loaderContract.main.length === 0
    || !Array.isArray(loaderContract.napiVersions)
    || loaderContract.napiVersions.length === 0
    || !loaderContract.napiVersions.every(Number.isSafeInteger)
    || loaderContract.files == null
    || typeof loaderContract.files !== "object"
    || Array.isArray(loaderContract.files)
    || Object.keys(loaderContract.files).length === 0
  ) {
    throw new Error("Codex Micro node-hid loader contract is invalid");
  }
  for (const [relativePath, sha256] of Object.entries(loaderContract.files)) {
    if (
      path.isAbsolute(relativePath)
      || relativePath.split(/[\\/]+/).includes("..")
      || typeof sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(sha256)
    ) {
      throw new Error(`Codex Micro node-hid loader contract file is invalid: ${relativePath}`);
    }
  }
}

function validateBundledPackage(discovered, artifactManifest) {
  if (discovered.name !== artifactManifest.name) {
    throw new Error(`Bundled node-hid identity mismatch: expected ${artifactManifest.name}, got ${discovered.name}`);
  }
  if (discovered.version !== artifactManifest.version) {
    throw new Error(`Bundled node-hid version mismatch: expected ${artifactManifest.version}, got ${discovered.version}`);
  }
  if (discovered.license !== artifactManifest.license) {
    throw new Error(`Bundled node-hid license mismatch: expected ${artifactManifest.license}, got ${discovered.license}`);
  }
  const loaderContract = artifactManifest.loaderContract;
  if (discovered.packageMetadata.main !== loaderContract.main) {
    throw new Error(
      `Bundled node-hid loader entrypoint mismatch: expected ${loaderContract.main}, got ${discovered.packageMetadata.main ?? "unknown"}`,
    );
  }
  if (
    JSON.stringify(discovered.packageMetadata.binary?.napi_versions)
    !== JSON.stringify(loaderContract.napiVersions)
  ) {
    throw new Error(
      `Bundled node-hid N-API contract mismatch: expected ${JSON.stringify(loaderContract.napiVersions)}, got ${JSON.stringify(discovered.packageMetadata.binary?.napi_versions ?? null)}`,
    );
  }
  for (const [relativePath, expectedSha256] of Object.entries(loaderContract.files)) {
    const filePath = path.join(discovered.nodeHidDir, relativePath);
    const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Bundled node-hid loader contract file is missing or unsafe: ${relativePath}`);
    }
    const actualSha256 = digest(fs.readFileSync(filePath), "sha256", "hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Bundled node-hid loader contract hash mismatch for ${relativePath}: expected ${expectedSha256}, got ${actualSha256}`,
      );
    }
  }
}

function validateMaterializedPackage(materialized, artifactManifest) {
  if (materialized == null || typeof materialized !== "object") {
    throw new Error("node-hid materializer returned no package");
  }
  if (materialized.integrity !== artifactManifest.integrity) {
    throw new Error(`node-hid artifact integrity mismatch: expected ${artifactManifest.integrity}, got ${materialized.integrity ?? "unknown"}`);
  }
  const metadata = readPackageMetadata(materialized.packageDir, "Materialized node-hid");
  if (metadata.name !== artifactManifest.name) {
    throw new Error(`node-hid artifact identity mismatch: expected ${artifactManifest.name}, got ${metadata.name ?? "unknown"}`);
  }
  if (metadata.version !== artifactManifest.version) {
    throw new Error(`node-hid artifact version mismatch: expected ${artifactManifest.version}, got ${metadata.version ?? "unknown"}`);
  }
  if (metadata.license !== artifactManifest.license) {
    throw new Error(`node-hid artifact license mismatch: expected ${artifactManifest.license}, got ${metadata.license ?? "unknown"}`);
  }
  return metadata;
}

function validateBinding(contents, expectedArch, expectedSha256 = null) {
  if (expectedSha256 != null) {
    const actualSha256 = digest(contents, "sha256", "hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`node-hid native binding SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`);
    }
  }
  const elf = inspectElf(contents);
  if (elf.arch !== expectedArch) {
    throw new Error(`node-hid native binding ELF architecture ${elf.arch} does not match ${expectedArch}`);
  }
  return elf;
}

function atomicWriteBinding(targetPath, contents) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.codex-micro-${process.pid}`,
  );
  try {
    fs.writeFileSync(temporaryPath, contents, { mode: 0o755 });
    fs.renameSync(temporaryPath, targetPath);
    fs.chmodSync(targetPath, 0o755);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function sourceBuildProvenancePath(targetPath) {
  return `${targetPath}.codex-micro.json`;
}

function atomicWriteJson(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
    fs.renameSync(temporaryPath, targetPath);
    fs.chmodSync(targetPath, 0o644);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function validatedSourceBuildProvenance(targetPath, expected) {
  const provenancePath = sourceBuildProvenancePath(targetPath);
  const targetStat = fs.lstatSync(targetPath, { throwIfNoEntry: false });
  const provenanceStat = fs.lstatSync(provenancePath, { throwIfNoEntry: false });
  if (!targetStat?.isFile() || !provenanceStat?.isFile() || provenanceStat.size > 16 * 1024) {
    return null;
  }

  let provenance;
  try {
    provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries(expected)) {
    if (provenance?.[key] !== value) {
      return null;
    }
  }

  const contents = fs.readFileSync(targetPath);
  try {
    validateBinding(contents, expected.arch, provenance.sha256);
  } catch {
    return null;
  }
  return { contents, provenancePath };
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
    const detail = failure ? `: ${failure}` : "";
    throw new Error(`${command} ${args.join(" ")} failed${detail}`);
  }
}

async function defaultMaterializePackage(request) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-node-hid-"));
  try {
    const archiveOverride = process.env.CODEX_MICRO_NODE_HID_ARCHIVE?.trim();
    let archivePath;
    if (archiveOverride) {
      archivePath = path.resolve(archiveOverride);
      if (!fs.statSync(archivePath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`CODEX_MICRO_NODE_HID_ARCHIVE is not a file: ${archivePath}`);
      }
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
        [packResult] = JSON.parse(packOutput);
      } catch (error) {
        throw new Error(`Could not parse npm pack output: ${error.message}`);
      }
      archivePath = path.join(temporaryRoot, packResult.filename);
    }

    const archive = fs.readFileSync(archivePath);
    const actualIntegrity = integrityFor(archive);
    if (actualIntegrity !== request.integrity) {
      throw new Error(`node-hid archive integrity mismatch: expected ${request.integrity}, got ${actualIntegrity}`);
    }

    const extractRoot = path.join(temporaryRoot, "extracted");
    fs.mkdirSync(extractRoot);
    run("tar", ["-xzf", archivePath, "-C", extractRoot]);
    const packageDir = path.join(extractRoot, "package");
    if (!fs.statSync(packageDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("node-hid archive did not contain package/");
    }
    return {
      packageDir,
      integrity: actualIntegrity,
      cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function defaultBuildFromSource(request) {
  if (!request.electronVersion) {
    throw new Error("CODEX_ELECTRON_VERSION is required to build node-hid from source");
  }
  const execute = request.execute ?? run;
  if (process.platform === "linux") {
    try {
      execute("pkg-config", ["--exists", "libudev", "libusb-1.0"]);
    } catch {
      throw new Error(
        "node-hid source build requires pkg-config plus the libudev and libusb development packages; see linux-features/codex-micro/README.md",
      );
    }
  }
  const sourceBuildToolchain = request.sourceBuildToolchain
    ?? loadSourceBuildToolchain(request.sourceBuildToolchainDir);
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-node-hid-build-"));
  try {
    fs.copyFileSync(sourceBuildToolchain.packageJsonPath, path.join(buildRoot, "package.json"));
    fs.copyFileSync(sourceBuildToolchain.packageLockPath, path.join(buildRoot, "package-lock.json"));
    execute(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: buildRoot, env: { ...process.env, npm_config_ignore_scripts: "true" } },
    );
    const moduleDir = path.join(buildRoot, "node_modules", request.name);
    fs.cpSync(request.packageDir, moduleDir, { recursive: true, force: true });
    const rebuildCli = path.join(buildRoot, "node_modules", "@electron", "rebuild", "lib", "cli.js");
    const distUrl = process.env.CODEX_ELECTRON_HEADERS_URL?.trim()
      || process.env.npm_config_disturl?.trim()
      || process.env.NPM_CONFIG_DISTURL?.trim()
      || "https://artifacts.electronjs.org/headers/dist";
    execute(
      process.execPath,
      [
        rebuildCli,
        "-v",
        request.electronVersion,
        "--arch",
        request.arch,
        "--force",
        "--which-module",
        request.name,
        "--only",
        request.name,
        "--build-from-source",
        "--dist-url",
        distUrl,
      ],
      {
        cwd: buildRoot,
        env: {
          ...process.env,
          npm_config_disturl: distUrl,
          NPM_CONFIG_DISTURL: distUrl,
        },
      },
    );
    const bindingPath = path.join(moduleDir, "build", "Release", "HID_hidraw.node");
    if (!fs.statSync(bindingPath, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`node-hid source build did not produce ${bindingPath}`);
    }
    const retainedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-micro-built-binding-"));
    const retainedBinding = path.join(retainedRoot, "HID_hidraw.node");
    fs.copyFileSync(bindingPath, retainedBinding);
    return {
      bindingPath: retainedBinding,
      cleanup: () => fs.rmSync(retainedRoot, { recursive: true, force: true }),
    };
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
}

async function stageCodexMicroNativeBinding(options) {
  const {
    extractedDir,
    artifactManifest,
    materializePackage = defaultMaterializePackage,
    buildFromSource = defaultBuildFromSource,
  } = options;
  const arch = normalizeArchitecture(options.arch);
  validateArtifactManifest(artifactManifest);
  const discovered = discoverBundledNodeHid(extractedDir);
  validateBundledPackage(discovered, artifactManifest);

  const prebuild = selectPrebuild(artifactManifest, arch);
  const targetRelativePath = prebuild?.path
    ?? path.join("prebuilds", `HID_hidraw-linux-${arch}`, "node-napi-v4.node");
  const targetPath = path.join(discovered.nodeHidDir, targetRelativePath);
  if (prebuild != null && fs.statSync(targetPath, { throwIfNoEntry: false })?.isFile()) {
    const existing = fs.readFileSync(targetPath);
    if (digest(existing, "sha256", "hex") === prebuild.sha256) {
      validateBinding(existing, arch, prebuild.sha256);
      return {
        changed: false,
        alreadyApplied: true,
        version: artifactManifest.version,
        targetPath,
        source: "existing",
        integrity: artifactManifest.integrity,
      };
    }
  }
  let sourceBuildToolchain = null;
  if (prebuild == null) {
    if (options.requirePrebuild === true) {
      throw new Error(`A verified node-hid prebuild is required for ${arch} in this build environment`);
    }
    sourceBuildToolchain = loadSourceBuildToolchain(options.sourceBuildToolchainDir);
    const existing = validatedSourceBuildProvenance(targetPath, {
      schemaVersion: 2,
      name: artifactManifest.name,
      version: artifactManifest.version,
      integrity: artifactManifest.integrity,
      electronVersion: options.electronVersion,
      arch,
      targetRelativePath,
      sourceBuildLockSha256: sourceBuildToolchain.lockSha256,
    });
    if (existing != null) {
      return {
        changed: false,
        alreadyApplied: true,
        version: artifactManifest.version,
        targetPath,
        source: "existing-source-build",
        integrity: artifactManifest.integrity,
      };
    }
  }

  let materialized;
  let built;
  try {
    materialized = await materializePackage({
      name: artifactManifest.name,
      version: artifactManifest.version,
      integrity: artifactManifest.integrity,
    });
    validateMaterializedPackage(materialized, artifactManifest);

    let contents;
    let source;
    if (prebuild != null) {
      const sourcePath = path.join(materialized.packageDir, prebuild.path);
      if (!fs.statSync(sourcePath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Verified node-hid prebuild is missing: ${prebuild.path}`);
      }
      contents = fs.readFileSync(sourcePath);
      validateBinding(contents, arch, prebuild.sha256);
      source = "prebuild";
    } else {
      built = await buildFromSource({
        packageDir: materialized.packageDir,
        name: artifactManifest.name,
        version: artifactManifest.version,
        arch,
        electronVersion: options.electronVersion,
        targetRelativePath,
        sourceBuildToolchain,
      });
      if (!fs.statSync(built?.bindingPath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error("node-hid source build returned no native binding");
      }
      contents = fs.readFileSync(built.bindingPath);
      validateBinding(contents, arch);
      source = "source-build";
    }

    atomicWriteBinding(targetPath, contents);
    const provenancePath = sourceBuildProvenancePath(targetPath);
    if (source === "source-build") {
      atomicWriteJson(provenancePath, {
        schemaVersion: 2,
        name: artifactManifest.name,
        version: artifactManifest.version,
        integrity: artifactManifest.integrity,
        electronVersion: options.electronVersion,
        arch,
        targetRelativePath,
        sourceBuildLockSha256: sourceBuildToolchain.lockSha256,
        sha256: digest(contents, "sha256", "hex"),
      });
    } else {
      fs.rmSync(provenancePath, { force: true });
    }
    return {
      changed: true,
      alreadyApplied: false,
      version: artifactManifest.version,
      targetPath,
      source,
      integrity: artifactManifest.integrity,
    };
  } finally {
    built?.cleanup?.();
    materialized?.cleanup?.();
  }
}

function currentArtifactManifest() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "native-artifacts.json"), "utf8"));
}

async function main() {
  if (process.argv[2] !== "--stage" || !process.argv[3]) {
    console.error("Usage: native-binding.js --stage <extracted-app-dir>");
    process.exitCode = 1;
    return;
  }
  const arch = process.arch;
  const result = await stageCodexMicroNativeBinding({
    extractedDir: process.argv[3],
    arch,
    electronVersion: process.env.CODEX_ELECTRON_VERSION?.trim(),
    requirePrebuild: process.env.CODEX_MICRO_REQUIRE_PREBUILD === "1",
    artifactManifest: currentArtifactManifest(),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  defaultBuildFromSource,
  defaultMaterializePackage,
  discoverBundledNodeHid,
  inspectElf,
  loadSourceBuildToolchain,
  selectPrebuild,
  stageCodexMicroNativeBinding,
};
