#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_REPOSITORY = "https://persistent.oaistatic.com/codex-app-prod/linux/deb";
const EXPECTED_FINGERPRINT = "3BFA0E4AE8B8CC16A2D9BA684A3B4A566C4660E4";

function mapMachineArch(machine = os.arch()) {
  const normalized = String(machine).trim().toLowerCase();
  if (["x64", "x86_64", "amd64"].includes(normalized)) return "amd64";
  if (["arm64", "aarch64"].includes(normalized)) return "arm64";
  throw new Error(`Unsupported architecture '${machine}'; official packages support amd64 and arm64 only`);
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function extractClearSignedPayload(source) {
  const lines = String(source).replace(/\r\n/g, "\n").split("\n");
  if (lines.shift() !== "-----BEGIN PGP SIGNED MESSAGE-----") {
    throw new Error("InRelease is not an OpenPGP clear-signed message");
  }
  while (lines.length > 0 && lines.shift() !== "") {}
  const payload = [];
  for (const line of lines) {
    if (line === "-----BEGIN PGP SIGNATURE-----") break;
    payload.push(line.startsWith("- ") ? line.slice(2) : line);
  }
  if (payload.length === 0) throw new Error("InRelease signed payload is empty");
  return payload.join("\n");
}

function parseReleaseSha256(payload) {
  const entries = new Map();
  let inSha256 = false;
  for (const line of String(payload).split(/\r?\n/)) {
    if (/^[A-Za-z0-9]+:/.test(line)) {
      inSha256 = line === "SHA256:";
      continue;
    }
    if (!inSha256) continue;
    const match = line.match(/^\s*([0-9a-f]{64})\s+(\d+)\s+(\S+)\s*$/i);
    if (match) entries.set(match[3], { sha256: match[1].toLowerCase(), size: Number(match[2]) });
  }
  return entries;
}

function parseDeb822(source) {
  return String(source).trim().split(/\n\s*\n/).filter(Boolean).map((paragraph) => {
    const fields = {};
    let current = null;
    for (const line of paragraph.split(/\r?\n/)) {
      if (/^[ \t]/.test(line) && current) {
        fields[current] += `\n${line.slice(1)}`;
        continue;
      }
      const separator = line.indexOf(":");
      if (separator < 1) throw new Error(`Malformed Packages line: ${line}`);
      current = line.slice(0, separator);
      fields[current] = line.slice(separator + 1).trim();
    }
    return fields;
  });
}

function selectChatgptPackage(source, architecture) {
  const matches = parseDeb822(source).filter(
    (entry) => entry.Package === "chatgpt" && entry.Architecture === architecture,
  );
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one chatgpt/${architecture} entry, found ${matches.length}`);
  }
  const entry = matches[0];
  if (!/^\d[0-9A-Za-z.+:~-]*$/.test(entry.Version ?? "")) throw new Error("Invalid chatgpt version in Packages");
  if (!/^pool\/[A-Za-z0-9._+\/-]+\.deb$/.test(entry.Filename ?? "")) throw new Error("Unsafe chatgpt Filename in Packages");
  if (!/^[0-9a-f]{64}$/i.test(entry.SHA256 ?? "")) throw new Error("Invalid chatgpt SHA256 in Packages");
  if (!/^\d+$/.test(entry.Size ?? "")) throw new Error("Invalid chatgpt Size in Packages");
  return {
    package: entry.Package,
    version: entry.Version,
    architecture: entry.Architecture,
    repositoryPath: entry.Filename,
    sha256: entry.SHA256.toLowerCase(),
    size: Number(entry.Size),
    depends: entry.Depends ?? "",
  };
}

function verifyIndexedFile(filePath, expected, label) {
  const stat = fs.statSync(filePath);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  const actual = sha256File(filePath);
  if (actual !== expected.sha256) {
    throw new Error(`${label} SHA256 mismatch: expected ${expected.sha256}, got ${actual}`);
  }
}

function verifyPackageControl(filePath, expected) {
  const result = childProcess.spawnSync("dpkg-deb", ["--field", filePath], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Could not read package control metadata for ${filePath}: ${result.stderr?.trim()}`);
  }
  const [control] = parseDeb822(result.stdout);
  for (const [field, key] of [["Package", "package"], ["Version", "version"], ["Architecture", "architecture"]]) {
    if (control?.[field] !== expected[key]) {
      throw new Error(`Package ${field} mismatch: signed index expects ${expected[key]}, got ${control?.[field] ?? "missing"}`);
    }
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, bytes, { mode: 0o600 });
}

function verifySigningKey(keyPath, expectedFingerprint = EXPECTED_FINGERPRINT) {
  const result = childProcess.spawnSync(
    "gpg", ["--batch", "--show-keys", "--with-colons", keyPath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`Could not inspect pinned signing key: ${result.stderr.trim()}`);
  const fingerprints = result.stdout.split(/\r?\n/)
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]);
  if (!fingerprints.includes(expectedFingerprint)) {
    throw new Error(`Pinned signing key does not contain expected fingerprint ${expectedFingerprint}`);
  }
}

function verifyInRelease(inReleasePath, keyPath, expectedFingerprint = EXPECTED_FINGERPRINT) {
  verifySigningKey(keyPath, expectedFingerprint);
  const result = childProcess.spawnSync(
    "gpgv", ["--keyring", keyPath, inReleasePath],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`InRelease signature verification failed: ${result.stderr.trim()}`);
  return extractClearSignedPayload(fs.readFileSync(inReleasePath, "utf8"));
}

function localPackageVerificationFailure(error, context) {
  return new Error(
    `${context}\n` +
    "For an intentional unverified local build, pass --skip-oai-official-sig-verification to install.sh; structural checks still apply.\n" +
    `Cause: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

async function resolveOfficialPackage(options, expectedFingerprint = EXPECTED_FINGERPRINT) {
  const architecture = mapMachineArch(options.architecture);
  if (options.localPackagePath != null && options.metadataOnly) {
    throw new Error("--local-package cannot be combined with --metadata-only");
  }
  const localPackagePath = options.localPackagePath == null ? null : path.resolve(options.localPackagePath);
  if (localPackagePath != null && !fs.statSync(localPackagePath).isFile()) {
    throw new Error(`Local package must be a file: ${localPackagePath}`);
  }
  const repository = (options.repository ?? DEFAULT_REPOSITORY).replace(/\/+$/, "");
  const outputDir = path.resolve(options.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  let metadata;
  try {
    const keyPath = path.join(outputDir, "codex-linux-repository-key.gpg");
    const keyBase64 = fs.readFileSync(options.keyBase64Path, "utf8").replace(/\s+/g, "");
    fs.writeFileSync(keyPath, Buffer.from(keyBase64, "base64"), { mode: 0o600 });

    const inReleasePath = path.join(outputDir, "InRelease");
    await download(`${repository}/dists/stable/InRelease`, inReleasePath);
    const releasePayload = verifyInRelease(inReleasePath, keyPath, expectedFingerprint);
    const releaseEntries = parseReleaseSha256(releasePayload);
    const packagesRelative = `main/binary-${architecture}/Packages`;
    const indexedPackages = releaseEntries.get(packagesRelative);
    if (!indexedPackages) throw new Error(`Signed InRelease does not index ${packagesRelative}`);

    const packagesPath = path.join(outputDir, `Packages.${architecture}`);
    await download(`${repository}/dists/stable/${packagesRelative}`, packagesPath);
    verifyIndexedFile(packagesPath, indexedPackages, packagesRelative);
    metadata = selectChatgptPackage(fs.readFileSync(packagesPath, "utf8"), architecture);
  } catch (error) {
    if (localPackagePath == null) throw error;
    throw localPackageVerificationFailure(error,
      "Could not fetch or verify the signed stable index for the local package.");
  }

  let packagePath = null;
  if (!options.metadataOnly) {
    packagePath = localPackagePath ?? path.join(outputDir, `chatgpt_${metadata.version}_${architecture}.deb`);
    if (localPackagePath == null) await download(`${repository}/${metadata.repositoryPath}`, packagePath);
    try {
      verifyIndexedFile(packagePath, metadata, path.basename(packagePath));
      verifyPackageControl(packagePath, metadata);
    } catch (error) {
      if (localPackagePath == null) throw error;
      const context = typeof error.code === "string"
        ? "Could not read the local package for verification against the current signed stable release."
        : `Local package does not match the current signed stable release (${metadata.version}, ${architecture}).`;
      throw localPackageVerificationFailure(error, context);
    }
  }
  const result = {
    ...metadata, repository, path: packagePath,
    ...(localPackagePath != null ? { explicitlyProvided: true } : {}),
    signatureVerification: "verified",
  };
  fs.writeFileSync(options.metadataPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const values = {};
  let metadataOnly = false;
  for (let i = 0; i < args.length;) {
    if (args[i] === "--metadata-only") {
      metadataOnly = true;
      i += 1;
      continue;
    }
    if (!args[i].startsWith("--") || i + 1 >= args.length) {
      throw new Error(`Invalid argument: ${args[i]}`);
    }
    values[args[i]] = args[i + 1];
    i += 2;
  }
  if (!values["--output-dir"] || !values["--metadata"] || !values["--key-base64"]) {
    throw new Error("Usage: upstream-linux-package.js --output-dir DIR --metadata FILE --key-base64 FILE [--arch ARCH] [--repository URL] [--metadata-only | --local-package FILE]");
  }
  const result = await resolveOfficialPackage({
    outputDir: values["--output-dir"],
    metadataPath: values["--metadata"],
    keyBase64Path: values["--key-base64"],
    architecture: values["--arch"] ?? os.arch(),
    repository: values["--repository"],
    metadataOnly,
    localPackagePath: values["--local-package"],
  });
  process.stdout.write(`${result.path ?? values["--metadata"]}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  EXPECTED_FINGERPRINT,
  extractClearSignedPayload,
  mapMachineArch,
  parseDeb822,
  parseReleaseSha256,
  resolveOfficialPackage,
  selectChatgptPackage,
  sha256File,
  verifyIndexedFile,
  verifyPackageControl,
  verifyInRelease,
  verifySigningKey,
};
