#!/bin/bash
set -Eeuo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"

node - <<'NODE'
const fs = require("node:fs");
const pins = JSON.parse(fs.readFileSync("nix/upstream-linux-packages.json", "utf8"));
if (!/^\d/.test(pins.version)) throw new Error("invalid official package version pin");
for (const architecture of ["amd64", "arm64"]) {
  const pin = pins[architecture];
  if (!pin || !pin.repositoryPath.endsWith(`_${architecture}.deb`)) throw new Error(`invalid ${architecture} path pin`);
  if (!/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error(`invalid ${architecture} SHA256 pin`);
  const sri = `sha256-${Buffer.from(pin.sha256, "hex").toString("base64")}`;
  if (pin.sri !== sri) throw new Error(`invalid ${architecture} SRI pin`);
}
const flake = fs.readFileSync("flake.nix", "utf8");
if (!flake.includes("nix/upstream-linux-packages.json")) throw new Error("flake does not consume official package pins");
NODE

"$REPO_DIR/scripts/ci/update-nix-hashes.sh" check

if command -v nix >/dev/null 2>&1; then
    nix flake check --no-build
fi
