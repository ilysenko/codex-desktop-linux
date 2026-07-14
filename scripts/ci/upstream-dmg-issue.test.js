"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { fingerprintMarker, reconcileUpstreamDmgIssue } = require("./upstream-dmg-issue.js");

function decision(verdict, sha, runId = "100") {
  return {
    verdict,
    dmg: { sha256: sha, appVersion: "1.2.3", httpIdentity: { key: "current" } },
    blockers: verdict === "rejected" ? [{ check: "core", reason: "required patch failed" }] : [],
    warnings: [],
    run: { id: runId, url: `https://example.test/runs/${runId}` },
  };
}

function fakeGithub(initialIssues = []) {
  const calls = [];
  let nextNumber = 50;
  const issues = initialIssues.map((issue) => ({ ...issue }));
  const rest = { issues: {} };
  rest.issues.listForRepo = async () => ({ data: issues });
  rest.issues.getLabel = async () => ({ data: {} });
  rest.issues.createLabel = async (args) => { calls.push(["createLabel", args]); return { data: {} }; };
  rest.issues.addLabels = async (args) => { calls.push(["addLabels", args]); return { data: {} }; };
  rest.issues.createComment = async (args) => { calls.push(["comment", args]); return { data: {} }; };
  rest.issues.update = async (args) => {
    calls.push(["update", args]);
    const issue = issues.find((item) => item.number === args.issue_number);
    if (issue) Object.assign(issue, args);
    return { data: issue };
  };
  rest.issues.create = async (args) => {
    calls.push(["create", args]);
    const issue = { ...args, number: nextNumber++, state: "open" };
    issues.push(issue);
    return { data: issue };
  };
  return { github: { rest }, calls, issues };
}

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

test("accepted candidates close old drift issues without creating a new one", async () => {
  const fixture = fakeGithub([{ number: 9, state: "open", body: fingerprintMarker("e".repeat(64)) }]);
  const result = await reconcileUpstreamDmgIssue({
    github: fixture.github, repo: { owner: "o", repo: "r" }, decision: decision("accepted", "f".repeat(64)), currentHttpIdentityKey: "current",
  });
  assert.equal(result.action, "closed-resolved");
  assert.equal(fixture.calls.filter(([name]) => name === "create").length, 0);
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
