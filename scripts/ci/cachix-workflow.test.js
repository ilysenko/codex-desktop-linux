"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("Cachix publishes every audited Nix runtime for both architectures", () => {
  const workflow = fs.readFileSync(".github/workflows/cachix.yml", "utf8");
  assert.doesNotMatch(workflow, /^    paths:/m);
  assert.match(workflow, /system: x86_64-linux/);
  assert.match(workflow, /system: aarch64-linux/);
  assert.match(workflow, /runner: ubuntu-24\.04-arm/);
  assert.match(workflow, /checks\.\$\{\{ matrix\.system \}\}\.modules/);
  assert.match(workflow, /Require Cachix publishing credentials/);
  assert.match(workflow, /test -n "\$CACHIX_AUTH_TOKEN"/);
  assert.match(workflow, /nix-runtime-maximal-directory-watch/);
  assert.match(workflow, /nix-runtime-maximal-shallow-watch/);
  assert.match(workflow, /codex-desktop-maximal-directory-watch/);
  assert.match(workflow, /codex-desktop-maximal-shallow-watch/);
  assert.match(workflow, /nix-installer/);
  assert.doesNotMatch(workflow, /if \[ -n "\$CACHIX_AUTH_TOKEN"/);
  assert.match(workflow, /nix build/);
  assert.doesNotMatch(workflow, /codexDmg|nativeModulesSource/);
});
