#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const flake = fs.readFileSync(path.resolve(__dirname, "../../flake.nix"), "utf8");

test("Nix Rust dependencies use the checksum-verified static crates.io endpoint", () => {
  assert.match(flake, /staticCratesFetchurl\s*=\s*args:\s*pkgs\.fetchurl/);
  assert.match(flake, /"https:\/\/crates\.io\/api\/v1\/crates"/);
  assert.match(flake, /"https:\/\/static\.crates\.io\/crates"/);
  assert.match(
    flake,
    /staticCratesImportCargoLock\s*=\s*pkgs\.rustPlatform\.importCargoLock\.override/,
  );
  assert.match(
    flake,
    /staticCratesBuildRustPackage\s*=\s*pkgs\.rustPlatform\.buildRustPackage\.override/,
  );

  for (const lockFile of [
    "./Cargo.lock",
    "./global-dictation-linux/Cargo.lock",
    "./linux-features/mcp-helper-reaper/reaper/Cargo.lock",
    "./nix/watchbound-Cargo.lock",
  ]) {
    assert.ok(
      flake.includes(`cargoLock.lockFile = ${lockFile};`),
      `${lockFile} must use the static crates.io registry mapping`,
    );
  }

  assert.equal((flake.match(/staticCratesBuildRustPackage \{/g) ?? []).length, 4);
  assert.doesNotMatch(flake, /pkgs\.rustPlatform\.buildRustPackage \{/);
});
