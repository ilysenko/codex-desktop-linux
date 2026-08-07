"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  fingerprintMarker,
  issueBody,
  reconcileUpstreamDmgIssue,
  testRehearsalMarker,
} = require("./upstream-dmg-issue.js");

function decision(verdict, sha, runId = "100") {
  return {
    verdict,
    dmg: { sha256: sha, appVersion: "1.2.3", httpIdentity: { key: "current" } },
    blockers: verdict === "rejected" ? [{ check: "core", reason: "required patch failed" }] : [],
    warnings: [],
    run: { id: runId, url: `https://example.test/runs/${runId}` },
  };
}

function fakeGithub(initialIssues = [], { createCollisionIssue = null } = {}) {
  const calls = [];
  let nextNumber = 50;
  const issues = initialIssues.map((issue) => ({
    author_association: "OWNER",
    user: { login: "maintainer" },
    ...issue,
  }));
  const rest = { issues: {} };
  rest.issues.listForRepo = async () => ({ data: issues });
  rest.issues.getLabel = async () => ({ data: {} });
  rest.issues.createLabel = async (args) => { calls.push(["createLabel", args]); return { data: {} }; };
  rest.issues.addLabels = async (args) => { calls.push(["addLabels", args]); return { data: {} }; };
  rest.issues.addAssignees = async (args) => { calls.push(["addAssignees", args]); return { data: {} }; };
  rest.issues.createComment = async (args) => { calls.push(["comment", args]); return { data: {} }; };
  rest.issues.update = async (args) => {
    calls.push(["update", args]);
    const issue = issues.find((item) => item.number === args.issue_number);
    if (issue) Object.assign(issue, args);
    return { data: issue };
  };
  rest.issues.create = async (args) => {
    calls.push(["create", args]);
    const issue = {
      ...args,
      number: nextNumber++,
      state: "open",
      author_association: "NONE",
      user: { login: "github-actions[bot]" },
    };
    issues.push(issue);
    if (createCollisionIssue != null) {
      issues.push({
        author_association: "OWNER",
        user: { login: "maintainer" },
        ...createCollisionIssue,
      });
      createCollisionIssue = null;
    }
    return { data: issue };
  };
  return { github: { rest }, calls, issues };
}

test("scheduled reconciliation scans unlabeled watchdog issues", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/upstream-build-app.yml"),
    "utf8",
  );
  assert.match(workflow, /currentHttpIdentityKey:[\s\S]*?scanAll: true,/);
});

test("scan-all ignores a copied fingerprint marker from an untrusted issue author", async () => {
  const sha = "a".repeat(64);
  const outsider = {
    number: 33,
    state: "open",
    body: fingerprintMarker(sha),
    author_association: "CONTRIBUTOR",
    user: { login: "external-contributor" },
  };
  const fixture = fakeGithub([outsider]);

  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", sha),
    currentHttpIdentityKey: "current",
    scanAll: true,
  });

  assert.equal(result.action, "created");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(fixture.calls.some(([, args]) => args.issue_number === 33), false);
});

test("creates one issue for a rejected current fingerprint", async () => {
  const fixture = fakeGithub();
  const sha = "a".repeat(64);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github, repo: { owner: "o", repo: "r" }, decision: decision("rejected", sha), currentHttpIdentityKey: "current",
  });
  assert.equal(result.action, "created");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 1);
  assert.deepEqual(fixture.calls.find(([name]) => name === "create")[1].labels, [
    "type: bug",
    "area: upstream dmg",
    "status: ready for work",
  ]);
});

test("watchdog issue mode assigns the current user without mutating labels", async () => {
  const fixture = fakeGithub();
  const sha = "0".repeat(64);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", sha),
    currentHttpIdentityKey: "current",
    assignee: "maintainer",
    manageLabels: false,
    scanAll: true,
  });

  assert.equal(result.action, "created");
  const create = fixture.calls.find(([name]) => name === "create")[1];
  assert.deepEqual(create.assignees, ["maintainer"]);
  assert.equal("labels" in create, false);
  assert.match(create.body, /Automated repair is already in progress/);
  assert.match(create.body, /Please do not open a pull request/);
});

test("issue body includes the precise blocker name and status", () => {
  const current = decision("rejected", "a".repeat(64));
  current.blockers = [{
    check: "feature:ui-tweaks",
    name: "model-picker-model-list",
    status: "skipped-optional",
    reason: "current bundle was not found",
  }];

  const body = issueBody(current);

  assert.match(body, /feature:ui-tweaks/);
  assert.match(body, /model-picker-model-list/);
  assert.match(body, /skipped-optional/);
  assert.match(body, /current bundle was not found/);
});

test("test rehearsal issue is unmistakably marked and isolated from production issues", async () => {
  const sha = "a".repeat(64);
  const production = { number: 31, state: "open", body: fingerprintMarker("b".repeat(64)) };
  const fixture = fakeGithub([production]);
  const current = decision("rejected", sha);
  current.testRehearsal = { id: "issue-drill-1", merge_policy: "skip" };

  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: current,
    currentHttpIdentityKey: "current",
    manageLabels: false,
    scanAll: true,
  });

  assert.equal(result.action, "created");
  const create = fixture.calls.find(([name]) => name === "create")[1];
  assert.match(create.title, /^\[TEST issue-drill-1\]/);
  assert.match(create.body, /TEST REHEARSAL ONLY/);
  assert.match(create.body, /upstream-dmg-test-rehearsal:issue-drill-1/);
  assert.equal(fixture.calls.some(([, args]) => args.issue_number === 31), false);
});

test("production reconciliation ignores test rehearsal issues", async () => {
  const testIssue = {
    number: 32,
    state: "open",
    body: `${fingerprintMarker("c".repeat(64))}\n${testRehearsalMarker("issue-drill-2")}`,
  };
  const fixture = fakeGithub([testIssue]);

  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("accepted", "d".repeat(64)),
    currentHttpIdentityKey: "current",
    manageLabels: false,
    scanAll: true,
  });

  assert.equal(result.action, "closed-resolved");
  assert.equal(result.count, 0);
  assert.equal(fixture.calls.length, 0);
});

test("closes old fingerprints before creating the new issue", async () => {
  const oldSha = "b".repeat(64);
  const fixture = fakeGithub([{ number: 4, state: "open", body: fingerprintMarker(oldSha) }]);
  await reconcileUpstreamDmgIssue({
    github: fixture.github, repo: { owner: "o", repo: "r" }, decision: decision("rejected", "c".repeat(64)), currentHttpIdentityKey: "current",
  });
  assert.ok(fixture.calls.some(([name, args]) => name === "update" && args.issue_number === 4 && args.state === "closed"));
  assert.ok(fixture.calls.some(([name]) => name === "create"));
});

test("reopens the matching closed issue instead of duplicating it", async () => {
  const sha = "d".repeat(64);
  const fixture = fakeGithub([{ number: 7, state: "closed", body: fingerprintMarker(sha) }]);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github, repo: { owner: "o", repo: "r" }, decision: decision("rejected", sha), currentHttpIdentityKey: "current",
  });
  assert.equal(result.action, "reopened");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 0);
});

test("closes duplicate matching fingerprint issues and keeps the oldest canonical issue", async () => {
  const sha = "d".repeat(64);
  const fixture = fakeGithub([
    { number: 7, state: "open", body: fingerprintMarker(sha) },
    { number: 8, state: "open", body: fingerprintMarker(sha) },
  ]);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", sha),
    currentHttpIdentityKey: "current",
    scanAll: true,
  });

  assert.equal(result.action, "updated");
  assert.equal(result.issueNumber, 7);
  assert.deepEqual(result.duplicateIssueNumbers, [8]);
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "update" && args.issue_number === 8 && args.state === "closed"
  )));
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 0);
});

test("rechecks after create and closes a colliding watchdog issue", async () => {
  const sha = "c".repeat(64);
  const fixture = fakeGithub([], {
    createCollisionIssue: { number: 51, state: "open", body: fingerprintMarker(sha) },
  });
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", sha),
    currentHttpIdentityKey: "current",
    scanAll: true,
  });

  assert.equal(result.action, "created");
  assert.equal(result.issueNumber, 50);
  assert.deepEqual(result.duplicateIssueNumbers, [51]);
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "update" && args.issue_number === 51 && args.state === "closed"
  )));
});

test("normalizes an older canonical issue after losing a create race", async () => {
  const sha = "b".repeat(64);
  const fixture = fakeGithub([], {
    createCollisionIssue: {
      number: 49,
      state: "open",
      body: fingerprintMarker(sha),
      labels: [],
      assignees: [],
    },
  });
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", sha, "race-run"),
    currentHttpIdentityKey: "current",
    assignee: "maintainer",
    scanAll: true,
  });

  assert.equal(result.action, "reused-after-create-race");
  assert.equal(result.issueNumber, 49);
  assert.deepEqual(result.duplicateIssueNumbers, [50]);
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "update" && args.issue_number === 50 && args.state === "closed"
  )));
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "addLabels" && args.issue_number === 49
  )));
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "addAssignees" && args.issue_number === 49
  )));
  const canonicalUpdate = fixture.calls.find(([name, args]) => (
    name === "update" && args.issue_number === 49
  ));
  assert.equal(canonicalUpdate[1].state, "open");
  assert.match(canonicalUpdate[1].body, /<!-- upstream-dmg-run:race-run -->/);
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "comment" && args.issue_number === 49
  )));
});

test("watchdog mode finds an unlabelled closed marker and reuses it", async () => {
  const sha = "d".repeat(64);
  const fixture = fakeGithub([{ number: 8, state: "closed", body: fingerprintMarker(sha) }]);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", sha),
    currentHttpIdentityKey: "current",
    assignee: "maintainer",
    manageLabels: false,
    scanAll: true,
  });

  assert.equal(result.action, "reopened");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 0);
  assert.ok(fixture.calls.some(([name]) => name === "addAssignees"));
  assert.equal(fixture.calls.some(([name]) => name === "addLabels"), false);
});

test("accepted candidates close old drift issues without creating a new one", async () => {
  const fixture = fakeGithub([{ number: 9, state: "open", body: fingerprintMarker("e".repeat(64)) }]);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github, repo: { owner: "o", repo: "r" }, decision: decision("accepted", "f".repeat(64)), currentHttpIdentityKey: "current",
  });
  assert.equal(result.action, "closed-resolved");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 0);
});

test("accepted candidates report manual-only issues without mutating them", async () => {
  const sha = "7".repeat(64);
  const fixture = fakeGithub([{
    number: 15,
    state: "open",
    body: fingerprintMarker(sha),
    labels: [{ name: "workflow: manual only" }],
  }]);

  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("accepted", sha),
    currentHttpIdentityKey: "current",
    scanAll: true,
  });

  assert.deepEqual(result.manualOnlyIssueNumbers, [15]);
  assert.equal(fixture.calls.some(([, args]) => args.issue_number === 15), false);
});

test("does not add a duplicate comment for the same workflow run", async () => {
  const sha = "2".repeat(64);
  const current = decision("rejected", sha, "123");
  const fixture = fakeGithub([{ number: 11, state: "open", body: `${fingerprintMarker(sha)}\n<!-- upstream-dmg-run:123 -->` }]);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github, repo: { owner: "o", repo: "r" }, decision: current, currentHttpIdentityKey: "current",
  });
  assert.equal(result.action, "updated");
  assert.equal(fixture.calls.filter(([name]) => name === "comment").length, 0);
  assert.deepEqual(fixture.calls.find(([name]) => name === "addLabels")[1].labels, [
    "type: bug",
    "area: upstream dmg",
    "status: ready for work",
  ]);
});

test("manual-only tracking issues are never edited, commented on, or closed", async () => {
  const sha = "9".repeat(64);
  for (const verdict of ["accepted", "rejected"]) {
    const fixture = fakeGithub([{
      number: 30,
      state: "open",
      body: fingerprintMarker(sha),
      labels: [{ name: "workflow: manual only" }],
    }]);
    const result = await reconcileUpstreamDmgIssue({
      github: fixture.github,
      repo: { owner: "o", repo: "r" },
      decision: decision(verdict, sha),
      currentHttpIdentityKey: "current",
    });

    if (verdict === "rejected") assert.equal(result.action, "manual-only");
    assert.equal(
      fixture.calls.some(([name]) => ["addLabels", "comment", "update"].includes(name)),
      false,
    );
  }
});

test("does not mutate issues for stale or inconclusive runs", async () => {
  for (const [verdict, identity] of [["rejected", "newer"], ["inconclusive", "current"]]) {
    const fixture = fakeGithub();
    const result = await reconcileUpstreamDmgIssue({
      github: fixture.github, repo: { owner: "o", repo: "r" }, decision: decision(verdict, "1".repeat(64)), currentHttpIdentityKey: identity,
    });
    assert.match(result.action, /^ignored-/);
    assert.equal(fixture.calls.length, 0);
  }
});

test("does not mutate accepted or rejected issues when either HTTP identity is missing", async () => {
  for (const verdict of ["accepted", "rejected"]) {
    for (const missing of ["expected", "current"]) {
      const fixture = fakeGithub([{ number: 12, state: "open", body: fingerprintMarker("3".repeat(64)) }]);
      const candidate = decision(verdict, "4".repeat(64));
      if (missing === "expected") candidate.dmg.httpIdentity = null;
      const result = await reconcileUpstreamDmgIssue({
        github: fixture.github,
        repo: { owner: "o", repo: "r" },
        decision: candidate,
        currentHttpIdentityKey: missing === "current" ? null : "current",
      });
      assert.equal(result.action, "ignored-missing-http-identity");
      assert.equal(fixture.calls.length, 0);
    }
  }
});

test("accepted candidates ignore labeled issues without a valid automation marker", async () => {
  const fixture = fakeGithub([
    { number: 20, state: "open", body: "Manually tracked upstream investigation" },
    { number: 21, state: "open", body: "<!-- upstream-dmg-fingerprint:not-a-sha -->" },
  ]);

  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("accepted", "5".repeat(64)),
    currentHttpIdentityKey: "current",
  });

  assert.equal(result.action, "closed-resolved");
  assert.equal(result.count, 0);
  assert.equal(fixture.calls.length, 0);
});

test("rejected candidates create a managed issue without mutating an unowned labeled issue", async () => {
  const fixture = fakeGithub([
    { number: 22, state: "open", body: "Manually tracked upstream investigation" },
  ]);

  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", "6".repeat(64)),
    currentHttpIdentityKey: "current",
  });

  assert.equal(result.action, "created");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 1);
  assert.equal(
    fixture.calls.some(([, args]) => args.issue_number === 22),
    false,
  );
});

test("mixed reconciliation mutates only issues carrying a valid fingerprint marker", async () => {
  const fixture = fakeGithub([
    { number: 23, state: "open", body: "Manually tracked upstream investigation" },
    { number: 24, state: "open", body: fingerprintMarker("7".repeat(64)) },
  ]);

  await reconcileUpstreamDmgIssue({
    github: fixture.github,
    repo: { owner: "o", repo: "r" },
    decision: decision("rejected", "8".repeat(64)),
    currentHttpIdentityKey: "current",
  });

  assert.equal(
    fixture.calls.some(([, args]) => args.issue_number === 23),
    false,
  );
  assert.ok(fixture.calls.some(([name, args]) => (
    name === "update" && args.issue_number === 24 && args.state === "closed"
  )));
});
