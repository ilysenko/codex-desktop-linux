"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { pinsFromMetadata, releaseFromMetadata, sha256Sri } = require("./watchdog.js");

test("watchdog creates architecture pins from a single signed stable version", () => {
  const amdSha = "a".repeat(64);
  const armSha = "b".repeat(64);
  const pins = pinsFromMetadata([
    { version: "26.1", architecture: "amd64", repositoryPath: "pool/amd.deb", sha256: amdSha },
    { version: "26.1", architecture: "arm64", repositoryPath: "pool/arm.deb", sha256: armSha },
  ]);
  assert.equal(pins.version, "26.1");
  assert.equal(pins.amd64.sri, sha256Sri(amdSha));
  assert.equal(pins.arm64.repositoryPath, "pool/arm.deb");
});

test("watchdog rejects a split stable version", () => {
  assert.throws(() => pinsFromMetadata([
    { version: "1", architecture: "amd64", repositoryPath: "a", sha256: "a".repeat(64) },
    { version: "2", architecture: "arm64", repositoryPath: "b", sha256: "b".repeat(64) },
  ]), /versions differ/);
});

test("release identity binds both signed package records", () => {
  const entries = [
    { version: "26.1", architecture: "amd64", repositoryPath: "pool/amd.deb", sha256: "a".repeat(64), size: 10 },
    { version: "26.1", architecture: "arm64", repositoryPath: "pool/arm.deb", sha256: "b".repeat(64), size: 20 },
  ];
  const first = releaseFromMetadata(entries, "https://example.invalid/deb/");
  const second = releaseFromMetadata([...entries].reverse(), "https://example.invalid/deb");
  assert.match(first.release.releaseId, /^[0-9a-f]{64}$/);
  assert.equal(first.release.releaseId, second.release.releaseId);
  assert.equal(first.release.releaseId, "44962ae3f86bfa3a6db2df452e9f51faa9797f44036d8845397cb92bd93d7b7b");
  assert.equal(first.release.packages.arm64.size, 20);
});

test("release identity rejects duplicate or extra architecture records", () => {
  const amd64 = { version: "26.1", architecture: "amd64", repositoryPath: "pool/amd.deb", sha256: "a".repeat(64), size: 10 };
  const arm64 = { version: "26.1", architecture: "arm64", repositoryPath: "pool/arm.deb", sha256: "b".repeat(64), size: 20 };
  assert.throws(() => releaseFromMetadata([amd64, amd64], "https://example.invalid/deb"), /exactly amd64 and arm64/);
  assert.throws(() => releaseFromMetadata([amd64, arm64, { ...arm64, architecture: "riscv64" }], "https://example.invalid/deb"), /exactly amd64 and arm64/);
});

test("pin refresh automation polls signed metadata and gates builds on changes", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../../.github/workflows/update-official-linux-pins.yml"),
    "utf8",
  );
  assert.match(workflow, /watchdog\.js --write --json/);
  assert.match(workflow, /expected_main_sha:/);
  assert.doesNotMatch(workflow, /schedule:/);
});
