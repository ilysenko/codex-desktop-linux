"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  GitHubClient,
  assertRetirementSnapshotMatches,
  assertSnapshotMatches,
  buildApplyPlan,
  buildRestorePlan,
  buildRetirementPlan,
  parseArguments,
  validatePolicy,
  validateSnapshot,
  writeSnapshot,
} = require("./manage-labels.js");

function label(name, color = "ABCDEF", description = `${name} description`) {
  return { name, color, description };
}

function association(number, kind = "issue", state = "closed") {
  return {
    kind,
    number,
    state,
    url: `https://github.com/owner/repository/${kind === "pull_request" ? "pull" : "issues"}/${number}`,
  };
}

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    staffManaged: true,
    groups: [
      {
        id: "type",
        appliesTo: ["issue", "pull_request"],
        cardinality: "exactly_one",
      },
      {
        id: "status",
        appliesTo: ["issue"],
        cardinality: "zero_or_one",
      },
    ],
    labels: [
      { ...label("type: bug", "D73A4A", "A reproducible defect."), group: "type" },
      { ...label("type: feature", "A2EEEF", "A new user-facing capability."), group: "type" },
      {
        ...label("status: needs information", "FBCA04", "Waiting for specific details."),
        group: "status",
      },
    ],
    migrations: [
      { from: "autoreview/area-bug", to: "type: bug" },
      { from: "bug", to: "type: bug" },
    ],
    retiredLabels: [
      { name: "autoreview/area-bug", reason: "Replaced by type: bug." },
      { name: "bug", reason: "Replaced by type: bug." },
      { name: "autoreview/queued", reason: "Use native checks." },
    ],
    ...overrides,
  };
}

function state({ labels = [], associations = {} } = {}) {
  return { labels, associations };
}

test("validatePolicy accepts the governed schema", () => {
  assert.doesNotThrow(() => validatePolicy(policy()));
});

test("validatePolicy enforces staff ownership and supported schema version", () => {
  assert.throws(() => validatePolicy(policy({ staffManaged: false })), /staffManaged must be true/);
  assert.throws(() => validatePolicy(policy({ schemaVersion: 2 })), /schemaVersion must be 1/);
});

test("validatePolicy rejects ambiguous names, invalid colors, and long descriptions", () => {
  const duplicate = policy();
  duplicate.labels.push({ ...label("TYPE: BUG"), group: "type" });
  assert.throws(() => validatePolicy(duplicate), /duplicate label name/i);

  const badColor = policy();
  badColor.labels[0].color = "#d73a4a";
  assert.throws(() => validatePolicy(badColor), /six uppercase hexadecimal/);

  const longDescription = policy();
  longDescription.labels[0].description = "x".repeat(101);
  assert.throws(() => validatePolicy(longDescription), /100 characters or fewer/);
});

test("validatePolicy rejects invalid group and migration references", () => {
  const unknownGroup = policy();
  unknownGroup.labels[0].group = "unknown";
  assert.throws(() => validatePolicy(unknownGroup), /unknown group/);

  const missingTarget = policy();
  missingTarget.migrations[0].to = "type: missing";
  assert.throws(() => validatePolicy(missingTarget), /migration target.*not a desired label/i);

  const duplicateSource = policy();
  duplicateSource.migrations.push({ from: "bug", to: "type: feature" });
  assert.throws(() => validatePolicy(duplicateSource), /duplicate migration source/i);
});

test("buildApplyPlan renames the primary source, creates missing labels, and transfers secondary associations", () => {
  const current = state({
    labels: [label("autoreview/area-bug", "000000", "Old"), label("bug", "111111", "Old")],
    associations: {
      "autoreview/area-bug": [association(1), association(2, "pull_request", "open")],
      bug: [association(3, "issue", "open")],
    },
  });

  assert.deepEqual(buildApplyPlan(policy(), current), {
    operations: [
      {
        kind: "rename",
        from: "autoreview/area-bug",
        to: "type: bug",
        color: "D73A4A",
        description: "A reproducible defect.",
      },
      {
        kind: "add",
        name: "type: bug",
        item: association(3, "issue", "open"),
      },
      {
        kind: "create",
        label: label("type: feature", "A2EEEF", "A new user-facing capability."),
      },
      {
        kind: "create",
        label: label(
          "status: needs information",
          "FBCA04",
          "Waiting for specific details.",
        ),
      },
    ],
  });
});

test("buildApplyPlan transfers associations when source and target both exist", () => {
  const current = state({
    labels: [
      label("type: bug", "000000", "Drifted"),
      label("autoreview/area-bug"),
      label("bug"),
      label("type: feature", "A2EEEF", "A new user-facing capability."),
      label("status: needs information", "FBCA04", "Waiting for specific details."),
    ],
    associations: {
      "type: bug": [association(1)],
      "autoreview/area-bug": [association(1), association(2)],
      bug: [association(3)],
    },
  });

  assert.deepEqual(buildApplyPlan(policy(), current), {
    operations: [
      {
        kind: "update",
        name: "type: bug",
        color: "D73A4A",
        description: "A reproducible defect.",
      },
      { kind: "add", name: "type: bug", item: association(2) },
      { kind: "add", name: "type: bug", item: association(3) },
    ],
  });
});

test("buildApplyPlan is idempotent and never prunes unknown labels", () => {
  const current = state({
    labels: [
      label("type: bug", "D73A4A", "A reproducible defect."),
      label("type: feature", "A2EEEF", "A new user-facing capability."),
      label("status: needs information", "FBCA04", "Waiting for specific details."),
      label("third-party/integration"),
    ],
  });

  assert.deepEqual(buildApplyPlan(policy(), current), { operations: [] });
});

test("buildApplyPlan blocks conflicting or inapplicable projected classifications", () => {
  const item = association(12, "issue");
  const conflictPolicy = policy();
  conflictPolicy.migrations.push({ from: "enhancement", to: "type: feature" });
  conflictPolicy.retiredLabels.push({ name: "enhancement", reason: "Replaced by type: feature." });
  const conflict = buildApplyPlan(conflictPolicy, state({
    labels: [label("type: bug"), label("enhancement")],
    associations: {
      "type: bug": [item],
      enhancement: [item],
    },
  }));
  assert.equal(conflict.operations.length, 0);
  assert.match(conflict.blockers[0].reason, /type: bug, type: feature/);

  const pullRequest = association(13, "pull_request");
  const wrongKind = buildApplyPlan(policy(), state({
    labels: [label("status: needs information")],
    associations: { "status: needs information": [pullRequest] },
  }));
  assert.equal(wrongKind.operations.length, 0);
  assert.match(wrongKind.blockers[0].reason, /does not apply to pull_request/);
});

test("buildApplyPlan reports incomplete required classification on open items", () => {
  const item = association(14, "issue", "open");
  const plan = buildApplyPlan(policy(), state({
    labels: [label(
      "status: needs information",
      "FBCA04",
      "Waiting for specific details.",
    )],
    associations: { "status: needs information": [item] },
  }));

  assert.equal(plan.operations.length, 2);
  assert.deepEqual(plan.warnings, [{
    item,
    label: "type",
    reason: "open item still needs required type classification",
  }]);
});

test("buildRetirementPlan blocks open items that have no replacement", () => {
  const current = state({
    labels: [
      label("type: bug", "D73A4A", "A reproducible defect."),
      label("autoreview/queued"),
    ],
    associations: { "autoreview/queued": [association(10, "pull_request", "open")] },
  });

  assert.deepEqual(buildRetirementPlan(policy(), current), {
    blockers: [
      {
        label: "autoreview/queued",
        item: association(10, "pull_request", "open"),
        reason: "open item has no governed replacement",
      },
    ],
    operations: [],
  });
});

test("buildRetirementPlan permits migrated open items only after the target is attached", () => {
  const sourceItem = association(12, "issue", "open");
  const current = state({
    labels: [label("type: bug", "D73A4A", "A reproducible defect."), label("bug")],
    associations: {
      bug: [sourceItem, association(13)],
      "type: bug": [sourceItem],
    },
  });

  assert.deepEqual(buildRetirementPlan(policy(), current), {
    blockers: [],
    operations: [{ kind: "delete", name: "bug", associationCount: 2 }],
  });
});

test("assertSnapshotMatches detects label or association drift before retirement", () => {
  const snapshot = {
    schemaVersion: 1,
    repository: "owner/repository",
    state: state({
      labels: [label("bug")],
      associations: { bug: [association(1)] },
    }),
  };
  const current = state({
    labels: [label("bug")],
    associations: { bug: [association(1)] },
  });

  assert.doesNotThrow(() =>
    assertSnapshotMatches(snapshot, "owner/repository", current, ["bug"]),
  );

  current.associations.bug.push(association(2));
  assert.throws(
    () => assertSnapshotMatches(snapshot, "owner/repository", current, ["bug"]),
    /live labels changed after the snapshot/i,
  );
  assert.throws(
    () => assertSnapshotMatches(snapshot, "other/repository", snapshot.state, ["bug"]),
    /belongs to owner\/repository/,
  );
});

test("retirement snapshot matching permits a partial-delete resume but protects targets", () => {
  const snapshot = {
    schemaVersion: 1,
    repository: "owner/repository",
    state: state({
      labels: [
        label("bug"),
        label("type: bug", "D73A4A", "A reproducible defect."),
      ],
      associations: {
        bug: [association(1)],
        "type: bug": [association(1)],
      },
    }),
  };
  const afterPartialDelete = state({
    labels: [label("type: bug", "D73A4A", "A reproducible defect.")],
    associations: { "type: bug": [association(1)] },
  });

  assert.doesNotThrow(() =>
    assertRetirementSnapshotMatches(
      snapshot,
      "owner/repository",
      afterPartialDelete,
      ["bug"],
    ),
  );

  afterPartialDelete.labels[0].description = "Changed after snapshot";
  assert.throws(
    () =>
      assertRetirementSnapshotMatches(
        snapshot,
        "owner/repository",
        afterPartialDelete,
        ["bug"],
      ),
    /non-retired labels changed/i,
  );

  const unexpectedLabel = state({
    labels: [
      label("type: bug", "D73A4A", "A reproducible defect."),
      label("unexpected"),
    ],
    associations: { "type: bug": [association(1)] },
  });
  assert.throws(
    () =>
      assertRetirementSnapshotMatches(
        snapshot,
        "owner/repository",
        unexpectedLabel,
        ["bug"],
      ),
    /non-retired labels changed/i,
  );
});

test("validateSnapshot rejects path injection and cross-label association drift", () => {
  const maliciousNumber = {
    schemaVersion: 1,
    repository: "owner/repository",
    state: state({
      labels: [label("bug")],
      associations: {
        bug: [{
          kind: "issue",
          number: "../../labels",
          state: "open",
          url: "https://github.com/owner/repository/issues/../../labels",
        }],
      },
    }),
  };
  assert.throws(() => validateSnapshot(maliciousNumber), /invalid association/);

  const unknownLabel = {
    schemaVersion: 1,
    repository: "owner/repository",
    state: state({ labels: [label("bug")], associations: { unknown: [] } }),
  };
  assert.throws(() => validateSnapshot(unknownLabel), /unknown label/);

  const maliciousRepository = {
    schemaVersion: 1,
    repository: "../..",
    state: state(),
  };
  assert.throws(() => validateSnapshot(maliciousRepository), /valid repository label state/);
});

test("writeSnapshot uses private permissions and never overwrites an audit snapshot", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "label-snapshot-"));
  const snapshotPath = path.join(directory, "before.json");
  try {
    await writeSnapshot(snapshotPath, "owner/repository", state());
    assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
    await assert.rejects(
      writeSnapshot(snapshotPath, "owner/repository", state()),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test("label management workflow keeps writes manual, trusted, and snapshotted", async () => {
  const workflow = await fs.readFile(
    path.resolve(__dirname, "../../.github/workflows/manage-labels.yml"),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /Plan triage and catalog changes/);
  assert.doesNotMatch(workflow, /pull_request(?:_target)?:/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.equal(
    (workflow.match(/ref: \$\{\{ github\.event\.repository\.default_branch \}\}/g) || []).length,
    2,
  );
  assert.match(workflow, /issues: read\n\s+pull-requests: read/);
  assert.match(workflow, /issues: write\n\s+pull-requests: write/);
  assert.match(workflow, /apply:APPLY\|retire:RETIRE/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/);

  const snapshot = workflow.indexOf("Capture the pre-change audit snapshot");
  const artifact = workflow.indexOf("Preserve the pre-change audit snapshot");
  const apply = workflow.indexOf("Converge desired labels and migrate associations");
  const retire = workflow.indexOf("Retire obsolete labels");
  assert.ok(snapshot > 0 && snapshot < artifact && artifact < apply && apply < retire);
});

test("buildRestorePlan restores only explicitly retired labels and their saved associations", () => {
  const snapshot = {
    schemaVersion: 1,
    repository: "owner/repository",
    state: state({
      labels: [label("bug", "D73A4A", "Old bug label"), label("third-party/integration")],
      associations: {
        bug: [association(7), association(8, "pull_request", "open")],
      },
    }),
  };
  const empty = state();

  assert.deepEqual(buildRestorePlan(policy(), snapshot, empty), {
    operations: [
      { kind: "create", label: label("bug", "D73A4A", "Old bug label") },
      { kind: "add", name: "bug", item: association(7) },
      { kind: "add", name: "bug", item: association(8, "pull_request", "open") },
    ],
  });

  const restored = state({
    labels: [label("bug", "D73A4A", "Old bug label")],
    associations: { bug: [association(7), association(8, "pull_request", "open")] },
  });
  assert.deepEqual(buildRestorePlan(policy(), snapshot, restored), { operations: [] });

  restored.labels[0].color = "000000";
  assert.deepEqual(buildRestorePlan(policy(), snapshot, restored).operations[0], {
    kind: "update",
    name: "bug",
    color: "D73A4A",
    description: "Old bug label",
  });
});

test("parseArguments defaults to a read-only plan and requires typed mutation confirmation", () => {
  assert.deepEqual(parseArguments(["--repo", "owner/repository"]), {
    action: "plan",
    confirmation: "",
    policyPath: ".github/labels.json",
    repository: "owner/repository",
    snapshotPath: "",
  });
  assert.throws(
    () => parseArguments(["--repo", "owner/repository", "--apply", "--confirm", "wrong"]),
    /--confirm APPLY/,
  );
  assert.throws(
    () => parseArguments(["--repo", "owner/repository", "--retire", "snapshot.json"]),
    /--confirm RETIRE/,
  );
  assert.throws(
    () => parseArguments(["--repo", "owner/repository", "--restore", "snapshot.json"]),
    /--confirm RESTORE/,
  );
  assert.throws(() => parseArguments(["--repo", "../.."]), /owner\/repository form/);
});

test("GitHubClient paginates label associations and does not expose response bodies on errors", async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    html_url: `https://github.com/owner/repository/issues/${index + 1}`,
    number: index + 1,
    state: "closed",
  }));
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    const page = new URL(url).searchParams.get("page");
    return new Response(JSON.stringify(page === "1" ? firstPage : [{
      html_url: "https://github.com/owner/repository/pull/101",
      number: 101,
      pull_request: {},
      state: "open",
    }]), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GitHubClient({ fetchImpl, repository: "owner/repository", token: "secret" });

  const items = await client.listAssociations("type: bug");

  assert.equal(calls.length, 2);
  assert.equal(items.length, 101);
  assert.equal(items[100].kind, "pull_request");
  assert.match(calls[0][0], /labels=type%3A\+bug/);
  assert.equal(calls[0][1].headers.authorization, "Bearer secret");

  await client.updateLabel("old label", label("type: bug", "D73A4A", "A defect."));
  assert.match(calls[2][0], /labels\/old%20label$/);
  assert.deepEqual(JSON.parse(calls[2][1].body), {
    color: "D73A4A",
    description: "A defect.",
    new_name: "type: bug",
  });

  const failed = new GitHubClient({
    fetchImpl: async () => new Response('{"message":"secret leaked"}', { status: 500 }),
    repository: "owner/repository",
    token: "secret",
  });
  await assert.rejects(() => failed.listLabels(), (error) => {
    assert.doesNotMatch(error.message, /secret leaked/);
    assert.match(error.message, /GitHub API GET .* failed with HTTP 500/);
    return true;
  });
});

test("GitHubClient rejects malformed live label and association data", async () => {
  const badLabel = new GitHubClient({
    fetchImpl: async () => new Response(JSON.stringify([{
      color: "not-hex",
      description: "Broken",
      name: "bad",
    }]), { status: 200 }),
    repository: "owner/repository",
  });
  await assert.rejects(() => badLabel.listLabels(), /invalid label definition/);

  const badItem = new GitHubClient({
    fetchImpl: async () => new Response(JSON.stringify([{
      html_url: "https://example.invalid/redirect",
      number: 1,
      state: "open",
    }]), { status: 200 }),
    repository: "owner/repository",
  });
  await assert.rejects(() => badItem.listAssociations("bug"), /invalid association/);
});
