"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  evaluateUpstreamDmg,
  httpIdentity,
  selectAcceptanceDecision,
} = require("../lib/upstream-dmg-acceptance.js");
const { parseArgs } = require("../validate-upstream-dmg.js");

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
    requirements: overrides.requirements,
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

test("rejects a missing required descriptor from an enabled feature profile", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.enabledFeatures = ["remote-mobile-control"];
  const decision = evaluate(root, dmg, {
    core,
    requirements: {
      requiredEnabledFeatures: ["remote-mobile-control"],
      requiredSuccessfulPatches: ["feature:remote-mobile-control:missing-patch"],
    },
  });
  assert.equal(decision.verdict, "rejected");
  assert.ok(decision.blockers.some((item) => item.name === "feature:remote-mobile-control:missing-patch"));
}));

test("parses repeatable feature-profile requirements", () => {
  const args = parseArgs([
    "--dmg", "/tmp/Codex.dmg",
    "--core-report", "/tmp/report.json",
    "--output", "/tmp/decision.json",
    "--require-enabled-feature", "remote-mobile-control",
    "--require-success", "feature:remote-mobile-control:first",
    "--require-success", "feature:remote-mobile-control:second",
    "--require-applied", "feature:remote-mobile-control:first",
  ]);
  assert.deepEqual(args.requirements, {
    requiredAppliedPatches: ["feature:remote-mobile-control:first"],
    requiredEnabledFeatures: ["remote-mobile-control"],
    requiredSuccessfulPatches: [
      "feature:remote-mobile-control:first",
      "feature:remote-mobile-control:second",
    ],
  });
});

test("the CLI rejects a missing required feature descriptor", () => withFixture(({ root, dmg }) => {
  const core = requiredCoreReport();
  core.enabledFeatures = ["remote-mobile-control"];
  const reportPath = writeJson(root, "required-cli-core.json", core);
  const outputPath = path.join(root, "required-cli-decision.json");
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "../validate-upstream-dmg.js"),
    "--dmg", dmg,
    "--core-report", reportPath,
    "--build-status", "success",
    "--output", outputPath,
    "--require-enabled-feature", "remote-mobile-control",
    "--require-success", "feature:remote-mobile-control:missing-patch",
    "--enforce",
  ], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  const decision = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(decision.verdict, "rejected");
  assert.ok(decision.blockers.some((item) => item.name === "feature:remote-mobile-control:missing-patch"));
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
  assert.match(
    workflow,
    /group: upstream-dmg-acceptance-\$\{\{ github\.event_name \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/,
  );
  assert.doesNotMatch(workflow, /group: upstream-dmg-acceptance-\$\{\{ github\.event_name \}\}\s*$/m);
});

test("upstream workflow pins the complete post-config-cleanup remote mobile descriptor contract", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/upstream-build-app.yml"),
    "utf8",
  );
  const required = [...workflow.matchAll(
    /--require-success feature:remote-mobile-control:([a-z0-9-]+)/g,
  )].map((match) => match[1]).sort();
  const expected = require("../../linux-features/remote-mobile-control/patch.js")
    .map((descriptor) => descriptor.id)
    .filter((id) => id !== "linux-remote-control-preserve-config")
    .sort();
  assert.deepEqual(required, expected);
});

test("reconciliation selects the most severe acceptance decision", () => {
  const accepted = { verdict: "accepted", inconclusiveReasons: [] };
  const warned = { verdict: "accepted_with_warnings", inconclusiveReasons: [] };
  const rejected = { verdict: "rejected", inconclusiveReasons: [] };
  assert.equal(selectAcceptanceDecision([accepted, warned]), warned);
  assert.equal(selectAcceptanceDecision([accepted, rejected, warned]), rejected);
});

test("a missing compatibility decision makes reconciliation inconclusive", () => {
  const accepted = { verdict: "accepted", inconclusiveReasons: [], dmg: { sha256: "a".repeat(64) } };
  const selected = selectAcceptanceDecision(
    [accepted],
    ["remote-mobile compatibility decision missing"],
  );
  assert.equal(selected.verdict, "inconclusive");
  assert.deepEqual(selected.inconclusiveReasons, ["remote-mobile compatibility decision missing"]);
  assert.equal(selected.dmg.sha256, accepted.dmg.sha256);
});

test("a proven rejection remains selected when another probe is missing", () => {
  const rejected = { verdict: "rejected", inconclusiveReasons: [] };
  assert.equal(selectAcceptanceDecision([rejected], ["probe missing"]), rejected);
});

test("an unknown decision verdict is normalized to inconclusive", () => {
  const selected = selectAcceptanceDecision([{ verdict: "partial", inconclusiveReasons: [] }]);
  assert.equal(selected.verdict, "inconclusive");
  assert.deepEqual(selected.inconclusiveReasons, ["unknown acceptance verdict: partial"]);
});
