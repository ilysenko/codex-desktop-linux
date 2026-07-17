const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflow = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/cachix.yml"),
  "utf8",
);
const updateHashWorkflow = fs.readFileSync(
  path.resolve(__dirname, "../../.github/workflows/update-codex-hash.yml"),
  "utf8",
);

test("Cachix automatic population runs only for an actual Codex DMG hash change", () => {
  assert.match(workflow, /paths:\n\s+- flake\.nix/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /id: codex-dmg-hash/);
  assert.match(workflow, /if: github\.event_name != 'workflow_dispatch' \|\| github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(workflow, /BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(workflow, /if \[ "\$EVENT_NAME" = "workflow_dispatch" \]; then\n\s+changed=true/);
  assert.match(workflow, /read-flake-hash "codexDmg = pkgs\.fetchurl \{" "hash = "/);
  assert.match(workflow, /if: needs\.detect-codex-dmg-hash\.outputs\.changed == 'true'/);
});

test("Nix refresh commits allow post-merge workflows to run", () => {
  assert.doesNotMatch(updateHashWorkflow, /\[skip ci\]/);
  assert.match(updateHashWorkflow, /gh workflow run ci\.yml/);
});

test("Cachix population pushes each output before collecting the Nix store", () => {
  assert.match(workflow, /skipPush: true/);
  assert.match(workflow, /nix build "\$output"[\s\S]*--print-out-paths/);
  assert.doesNotMatch(workflow, /mapfile[^\n]*< <\(/);
  assert.match(workflow, /printf '%s\\n' "\$\{store_paths\[@\]\}" \| cachix push "\$CACHIX_CACHE_NAME"/);
  assert.match(workflow, /nix store gc/);
  assert.ok(
    workflow.indexOf("cachix push") < workflow.indexOf("nix store gc"),
    "Cachix upload must complete before garbage collection",
  );
});

test("Cachix population pins every third-party action", () => {
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/);
});
