#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  resolveOfficialPackage,
} = require("../../lib/upstream-linux-package.js");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PINS_PATH = path.join(REPO_ROOT, "nix/upstream-linux-packages.json");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Sri(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("invalid SHA256");
  return `sha256-${Buffer.from(hex, "hex").toString("base64")}`;
}

function normalizeMetadata(entries) {
  if (!Array.isArray(entries) || entries.length !== 2) {
    throw new Error("signed release must contain exactly amd64 and arm64 packages");
  }
  const normalized = new Map();
  for (const entry of entries) {
    if (!entry || !["amd64", "arm64"].includes(entry.architecture)
        || normalized.has(entry.architecture)) {
      throw new Error("signed release must contain exactly amd64 and arm64 packages");
    }
    if (typeof entry.version !== "string" || entry.version === ""
        || typeof entry.repositoryPath !== "string" || entry.repositoryPath === ""
        || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`invalid signed package metadata for ${entry.architecture}`);
    }
    normalized.set(entry.architecture, entry);
  }
  if (normalized.size !== 2) {
    throw new Error("signed release must contain exactly amd64 and arm64 packages");
  }
  return [normalized.get("amd64"), normalized.get("arm64")];
}

function pinsFromMetadata(entries) {
  const normalized = normalizeMetadata(entries);
  const versions = new Set(normalized.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error("amd64 and arm64 stable versions differ");
  const pins = { version: normalized[0].version };
  for (const entry of normalized) {
    pins[entry.architecture] = {
      repositoryPath: entry.repositoryPath,
      sha256: entry.sha256,
      sri: sha256Sri(entry.sha256),
    };
  }
  return pins;
}

function releaseFromMetadata(entries, repository) {
  const normalized = normalizeMetadata(entries);
  const pins = pinsFromMetadata(normalized);
  const packages = {};
  for (const entry of normalized) {
    const architecture = entry.architecture;
    if (!Number.isSafeInteger(Number(entry.size)) || Number(entry.size) <= 0) {
      throw new Error(`missing signed package metadata for ${architecture}`);
    }
    packages[architecture] = {
      architecture,
      version: entry.version,
      repositoryPath: entry.repositoryPath,
      sha256: entry.sha256,
      size: Number(entry.size),
    };
  }
  const identity = {
    repository: repository.replace(/\/+$/, ""),
    version: pins.version,
    packages,
  };
  const releaseManifest = {
    version: identity.version,
    packages: Object.fromEntries(["amd64", "arm64"].map((architecture) => [architecture, {
      repositoryPath: packages[architecture].repositoryPath,
      sha256: packages[architecture].sha256,
      size: packages[architecture].size,
    }])),
  };
  identity.releaseId = require("node:crypto")
    .createHash("sha256")
    .update(canonicalJson(releaseManifest))
    .digest("hex");
  return { pins, release: identity };
}

async function probe(repository) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-linux-package-watchdog-"));
  try {
    const entries = [];
    for (const architecture of ["amd64", "arm64"]) {
      const outputDir = path.join(root, architecture);
      entries.push(await resolveOfficialPackage({
        architecture,
        repository,
        outputDir,
        metadataPath: path.join(outputDir, "metadata.json"),
        keyBase64Path: path.join(REPO_ROOT, "assets/openai-codex-linux-repository-key.gpg.base64"),
        metadataOnly: true,
      }));
    }
    return releaseFromMetadata(entries, repository);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const repository = process.env.CODEX_UPSTREAM_LINUX_REPOSITORY
    ?? "https://persistent.oaistatic.com/codex-app-prod/linux/deb";
  const current = JSON.parse(fs.readFileSync(PINS_PATH, "utf8"));
  const observed = await probe(repository);
  const latest = observed.pins;
  const changed = JSON.stringify(current) !== JSON.stringify(latest);
  if (args.has("--write")) {
    fs.writeFileSync(PINS_PATH, `${JSON.stringify(latest, null, 2)}\n`);
  }
  const result = { changed, current, latest, release: observed.release, wrote: args.has("--write") };
  if (args.has("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${changed ? "changed" : "unchanged"}: ${latest.version}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { canonicalJson, pinsFromMetadata, releaseFromMetadata, sha256Sri };
