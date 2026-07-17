"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { evaluateUpstreamDmg, httpIdentity } = require("../lib/upstream-dmg-acceptance.js");

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-acceptance-"));
  try {
    const dmg = path.join(root, "Codex.dmg");
    fs.writeFileSync(dmg, "dmg fixture");
    return fn({ root, dmg });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function patch(name, extra = {}) {
  return { name, status: "applied", ...extra };
}

function requiredCoreReport() {
  const { requiredPatchNamesForProfile } = require("../patches/runner.js");
  return {
    patches: requiredPatchNamesForProfile("upstream-build").map((name) => patch(name, { ciPolicy: "required-upstream" })),
  };
}

function writeJson(root, name, value) {
  const filePath = path.join(root, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
  return filePath;
}

function evaluate(root, dmg, overrides = {}) {
  const core = writeJson(root, "core.json", overrides.core ?? requiredCoreReport());
  return evaluateUpstreamDmg({
    dmgPath: dmg,
    coreReportPath: overrides.corePath ?? core,
    buildStatus: overrides.buildStatus ?? "success",
    repoRoot: root,
  });
}

test("accepts a candidate when the shared release profile passes", () => withFixture(({ root, dmg }) => {
  const decision = evaluate(root, dmg);
  assert.equal(decision.verdict, "accepted");
  assert.equal(decision.blockers.length, 0);
}));

test("keeps optional drift non-blocking", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.patches.push(patch("optional-ui", { status: "skipped-optional", ciPolicy: "optional", reason: "needle moved" }));
  const decision = evaluate(root, dmg, { core });
  assert.equal(decision.verdict, "accepted_with_warnings");
  assert.equal(decision.warnings.length, 1);
}));

test("rejects required patch and post-patch integrity failures", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.patches[0].status = "failed-required";
  core.patches[0].reason = "needle moved";
  core.postPatchIntegrity = { findings: [{ symbol: "brokenSymbol", reason: "undeclared symbol" }] };
  const decision = evaluate(root, dmg, { core });
  assert.equal(decision.verdict, "rejected");
  assert.ok(decision.blockers.some((item) => item.code === "post-patch-integrity"));
}));

test("rejects drift from a user-enabled feature", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.enabledFeatures = ["ui-tweaks"];
  core.patches.push(patch("feature:ui-tweaks:model-picker", {
    status: "skipped-optional",
    ciPolicy: "optional",
    sourceKind: "feature",
    featureId: "ui-tweaks",
    reason: "needle moved",
  }));
  const decision = evaluate(root, dmg, { core });
  assert.equal(decision.verdict, "rejected");
  assert.ok(decision.blockers.some((item) => item.code === "enabled-feature-drift"));
}));

test("does not probe or block a disabled feature", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.enabledFeatures = [];
  core.patches.push(patch("feature:ui-tweaks:model-picker", {
    status: "skipped-disabled",
    ciPolicy: "optional",
    sourceKind: "feature",
    featureId: "ui-tweaks",
  }));
  const decision = evaluate(root, dmg, { core });
  assert.equal(decision.verdict, "accepted");
  assert.equal(decision.blockers.length, 0);
}));

test("the local and GitHub CLI surfaces use the same verdict", () => withFixture(({ root, dmg }) => {
  const core = writeJson(root, "cli-core.json", requiredCoreReport());
  const cli = path.join(__dirname, "../validate-upstream-dmg.js");
  const verdicts = [];
  for (const source of ["local", "github-actions"]) {
    const output = path.join(root, `${source}.json`);
    const result = spawnSync(process.execPath, [
      cli, "--dmg", dmg, "--core-report", core, "--build-status", "success",
      "--output", output, "--source", source, "--repo-root", root,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    verdicts.push(JSON.parse(fs.readFileSync(output, "utf8")).verdict);
  }
  assert.deepEqual(verdicts, ["accepted", "accepted"]);
}));

test("marks unstructured build failures and a missing core report inconclusive", () => withFixture(({ root, dmg }) => {
  const decision = evaluate(root, dmg, {
    buildStatus: "failure",
    corePath: path.join(root, "missing-core.json"),
  });
  assert.equal(decision.verdict, "inconclusive");
  assert.ok(decision.inconclusiveReasons.length >= 2);
}));

test("marks malformed reports inconclusive instead of throwing", () => withFixture(({ root, dmg }) => {
  const malformed = path.join(root, "malformed.json");
  fs.writeFileSync(malformed, "{not-json");
  const decision = evaluateUpstreamDmg({
    dmgPath: dmg,
    coreReportPath: malformed,
    buildStatus: "success",
    repoRoot: root,
  });
  assert.equal(decision.verdict, "inconclusive");
  assert.ok(decision.inconclusiveReasons.length > 0);
}));

test("a structured rejection wins over incomplete checks", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.patches[0].status = "failed-required";
  const decision = evaluate(root, dmg, {
    core,
    buildStatus: "failure",
  });
  assert.equal(decision.verdict, "rejected");
}));

test("HTTP identity requires an ETag or Last-Modified plus Content-Length", () => {
  assert.equal(httpIdentity({ contentLength: 42 }), null);
  assert.equal(httpIdentity({ lastModified: "today" }), null);
  assert.ok(httpIdentity({ etag: "strong" })?.key);
  assert.ok(httpIdentity({ lastModified: "today", contentLength: 42 })?.key);
});

test("upstream workflow concurrency is isolated per PR or ref", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/upstream-build-app.yml"),
    "utf8",
  );
  assert.match(workflow, /cron: '30 \* \* \* \*'/);
  assert.match(
    workflow,
    /group: upstream-dmg-acceptance-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
  );
  assert.doesNotMatch(workflow, /group: upstream-dmg-acceptance-\$\{\{ github\.event_name \}\}\s*$/m);
  assert.equal((workflow.match(/- linux-features\/\*\*/g) ?? []).length, 2);
  assert.equal((workflow.match(/- scripts\/lib\/linux-features\.js/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
});

test("Nix refresh serializes campaigns and deduplicates refresh and exact-head CI", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/update-codex-hash.yml"),
    "utf8",
  );

  assert.match(workflow, /expected_main_sha:/);
  assert.match(workflow, /expected_dmg_sha256:/);
  assert.match(workflow, /run-name: Nix refresh \$\{\{ inputs\.expected_main_sha \}\}:\$\{\{ inputs\.expected_dmg_sha256 \}\}/);
  assert.match(workflow, /ref: \$\{\{ inputs\.expected_main_sha \}\}/);
  assert.equal((workflow.match(/required: true/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.doesNotMatch(workflow, /cron:/);
  assert.match(workflow, /group: update-nix-upstream-hashes/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /Source-Main-SHA:/);
  assert.match(workflow, /Source-Main-SHA: \$EXPECTED_MAIN_SHA/);
  assert.match(workflow, /Upstream-DMG-SHA256:/);
  assert.match(workflow, /git push --force-with-lease origin "\$REFRESH_BRANCH"/);
  assert.match(workflow, /Exact-head CI already exists/);
  assert.doesNotMatch(workflow, /git push --force origin "\$REFRESH_BRANCH"/);
});

test("Nix hash refresh accepts a validated focused output override", () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, "update-nix-hashes.sh"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/ci.yml"),
    "utf8",
  );
  const refreshWorkflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/update-codex-hash.yml"),
    "utf8",
  );
  const watchdogProfile = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, "watchdog-linux-features.json"),
    "utf8",
  ));

  assert.deepEqual(watchdogProfile.enabled, [
    "appshots",
    "codex-wrapper-updater",
    "directory-only-working-tree-watch",
    "frameless-titlebar",
    "global-dictation",
    "mcp-helper-reaper",
    "node-repl-reaper",
    "open-target-discovery",
    "persistent-status-panel",
    "remote-control-ui",
    "remote-mobile-control",
    "ui-tweaks",
  ]);
  assert.match(script, /NIX_VERIFY_OUTPUTS/);
  assert.match(script, /NIX_COMPARE_REF/);
  assert.match(workflow, /\.#checks\.x86_64-linux\.watchdog-linux-features/);
  assert.match(refreshWorkflow, /NIX_VERIFY_OUTPUTS/);
  assert.match(refreshWorkflow, /\.#checks\.x86_64-linux\.watchdog-linux-features/);
  assert.match(script, /Invalid Nix verification output/);
  assert.match(script, /run_nix_build "\$VERIFY_LOG" "\$\{PACKAGE_OUTPUTS\[@\]\}"/);
});

test("local Node syntax checks parse native .js ESM in module mode", () => {
  const script = fs.readFileSync(
    path.resolve(__dirname, "run-node-checks.sh"),
    "utf8",
  );

  assert.match(script, /node --input-type=module --check/);
  assert.match(script, /grep -Eq .*import.*export/);
});
