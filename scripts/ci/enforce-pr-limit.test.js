"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_MAX_OPEN_PRS,
  LIMIT_COMMENT_MARKER,
  buildLimitComment,
  enforcePullRequestLimits,
  parseMaxOpenPullRequests,
  parsePullRequestLimitOverrides,
  resolvePullRequestLimit,
  selectExcessPullRequests,
} = require("./enforce-pr-limit");

function pullRequest(number, login = "contributor", extra = {}) {
  return {
    number,
    user: { login, type: "User" },
    ...extra,
  };
}

function createHarness({
  action = "opened",
  closeError = null,
  commentsByIssue = {},
  current = pullRequest(3),
  open = [],
} = {}) {
  const calls = [];
  const messages = { info: [], notice: [], warning: [] };
  const list = Symbol("pulls.list");
  const listComments = Symbol("issues.listComments");
  const github = {
    paginate: async (method, options) => {
      if (method === list) {
        calls.push(["paginate", method, options]);
        return open;
      }
      if (method === listComments) {
        calls.push(["paginate-comments", method, options]);
        return commentsByIssue[options.issue_number] || [];
      }
      throw new Error("Unexpected pagination method");
    },
    rest: {
      issues: {
        createComment: async (options) => calls.push(["comment", options]),
        listComments,
        updateComment: async (options) => calls.push(["update-comment", options]),
      },
      pulls: {
        list,
        update: async (options) => {
          calls.push(["close", options]);
          if (closeError) throw closeError;
        },
      },
    },
  };
  const context = {
    payload: { action, pull_request: current },
    repo: { owner: "owner", repo: "repository" },
  };
  const core = {
    info: (message) => messages.info.push(message),
    notice: (message) => messages.notice.push(message),
    warning: (message) => messages.warning.push(message),
  };

  return { calls, context, core, github, list, listComments, messages };
}

test("parseMaxOpenPullRequests accepts positive integers", () => {
  assert.equal(parseMaxOpenPullRequests("1"), 1);
  assert.equal(parseMaxOpenPullRequests(" 12 "), 12);
});

test("parseMaxOpenPullRequests falls back for missing and invalid values", () => {
  for (const value of [undefined, "", "0", "-1", "1.5", "abc", "999999999999999999999"]) {
    const warnings = [];
    assert.equal(parseMaxOpenPullRequests(value, (message) => warnings.push(message)), DEFAULT_MAX_OPEN_PRS);
    assert.equal(warnings.length, 1);
  }
});

test("parsePullRequestLimitOverrides accepts an empty object and normalizes usernames", () => {
  assert.deepEqual([...parsePullRequestLimitOverrides("{}").entries()], []);
  assert.deepEqual(
    [...parsePullRequestLimitOverrides('{"One-PR-User":1,"trusted-user":4}').entries()],
    [
      ["one-pr-user", 1],
      ["trusted-user", 4],
    ],
  );
});

test("parsePullRequestLimitOverrides ignores malformed JSON", () => {
  const warnings = [];
  const overrides = parsePullRequestLimitOverrides("{broken", (message) => warnings.push(message));

  assert.deepEqual([...overrides.entries()], []);
  assert.equal(warnings.length, 1);
});

test("parsePullRequestLimitOverrides keeps valid entries and rejects invalid entries", () => {
  const warnings = [];
  const overrides = parsePullRequestLimitOverrides(
    JSON.stringify({
      valid: 3,
      zero: 0,
      negative: -1,
      fractional: 1.5,
      string: "2",
      "@invalid": 1,
      DUPLICATE: 2,
      duplicate: 4,
    }),
    (message) => warnings.push(message),
  );

  assert.deepEqual([...overrides.entries()], [
    ["valid", 3],
    ["duplicate", 2],
  ]);
  assert.equal(warnings.length, 6);
});

test("resolvePullRequestLimit prefers a case-insensitive personal override", () => {
  assert.deepEqual(
    resolvePullRequestLimit({
      author: "ONE-PR-USER",
      rawLimit: "2",
      rawOverrides: '{"one-pr-user":1}',
    }),
    { limit: 1, source: "personal override" },
  );
});

test("resolvePullRequestLimit uses the global limit or built-in fallback", () => {
  assert.deepEqual(
    resolvePullRequestLimit({ author: "unknown", rawLimit: "4", rawOverrides: '{"other":1}' }),
    { limit: 4, source: "global variable" },
  );

  const warnings = [];
  assert.deepEqual(
    resolvePullRequestLimit({
      author: "unknown",
      rawLimit: "",
      rawOverrides: "{}",
      warn: (message) => warnings.push(message),
    }),
    { limit: 2, source: "fallback" },
  );
  assert.equal(warnings.length, 1);
});

test("buildLimitComment returns the required English comment", () => {
  assert.equal(
    buildLimitComment(2, 3),
    `Thanks for contributing. This repository allows a maximum of **2 active pull requests per contributor**. You currently have **3 open pull requests**, so this pull request is being closed automatically. Please finish or close one of your existing pull requests before opening another.\n\n${LIMIT_COMMENT_MARKER}`,
  );
});

test("buildLimitComment uses correct singular English grammar", () => {
  assert.equal(
    buildLimitComment(1, 2),
    `Thanks for contributing. This repository allows a maximum of **1 active pull request per contributor**. You currently have **2 open pull requests**, so this pull request is being closed automatically. Please finish or close one of your existing pull requests before opening another.\n\n${LIMIT_COMMENT_MARKER}`,
  );
});

test("selectExcessPullRequests keeps the oldest PRs within the limit", () => {
  assert.deepEqual(
    selectExcessPullRequests({
      limit: 2,
      openPullRequests: [pullRequest(3), pullRequest(1), pullRequest(2)],
    }),
    [pullRequest(3)],
  );
});

test("selectExcessPullRequests returns every newer PR outside the limit", () => {
  const openPullRequests = [pullRequest(4), pullRequest(2), pullRequest(1), pullRequest(3)];
  assert.deepEqual(
    selectExcessPullRequests({ limit: 2, openPullRequests }),
    [pullRequest(3), pullRequest(4)],
  );
});

test("enforcePullRequestLimits excludes bot accounts from repository-wide reconciliation", async () => {
  const current = pullRequest(3, "automation[bot]", { user: { login: "automation[bot]", type: "Bot" } });
  const harness = createHarness({ current, open: [current] });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result, { action: "reconciled", authors: [], closedPullRequests: [] });
  assert.equal(harness.calls.length, 1);
});

test("enforcePullRequestLimits counts drafts across all base branches without closing at the limit", async () => {
  const current = pullRequest(2, "Contributor", { draft: true });
  const harness = createHarness({
    current,
    open: [pullRequest(1, "contributor"), current, pullRequest(4, "someone-else")],
  });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result.closedPullRequests, []);
  assert.deepEqual(result.authors.find(({ author }) => author === "contributor"), {
    author: "contributor",
    closedPullRequests: [],
    count: 2,
    limit: 2,
  });
});

test("enforcePullRequestLimits comments in English before closing the excess PR", async () => {
  const current = pullRequest(3);
  const harness = createHarness({
    current,
    open: [pullRequest(1), pullRequest(2, "CONTRIBUTOR", { draft: true }), current],
  });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result.closedPullRequests, [3]);
  const commentCall = harness.calls.find(([operation]) => operation === "comment");
  assert.deepEqual(commentCall[1], {
    owner: "owner",
    repo: "repository",
    issue_number: 3,
    body: buildLimitComment(2, 3),
  });
  const closeCall = harness.calls.find(([operation]) => operation === "close");
  assert.deepEqual(closeCall[1], {
    owner: "owner",
    repo: "repository",
    pull_number: 3,
    state: "closed",
  });
});

test("enforcePullRequestLimits closes against a lower personal limit", async () => {
  const current = pullRequest(2, "One-PR-User");
  const harness = createHarness({ current, open: [pullRequest(1, "one-pr-user"), current] });

  const result = await enforcePullRequestLimits({
    ...harness,
    rawLimit: "2",
    rawOverrides: '{"one-pr-user":1}',
  });

  assert.deepEqual(result.closedPullRequests, [2]);
  assert.equal(result.authors[0].limit, 1);
  assert.match(harness.messages.info[0], /effective limit 1 \(personal override\)/);
  assert.equal(
    harness.calls.find(([operation]) => operation === "comment")[1].body,
    buildLimitComment(1, 2),
  );
});

test("enforcePullRequestLimits allows more PRs under a higher personal limit", async () => {
  const current = pullRequest(3, "trusted-user");
  const harness = createHarness({
    current,
    open: [pullRequest(1, "trusted-user"), pullRequest(2, "trusted-user"), current],
  });

  const result = await enforcePullRequestLimits({
    ...harness,
    rawLimit: "2",
    rawOverrides: '{"trusted-user":3}',
  });

  assert.deepEqual(result.closedPullRequests, []);
  assert.equal(result.authors[0].limit, 3);
  assert.match(harness.messages.info[0], /effective limit 3 \(personal override\)/);
  assert.equal(harness.calls.some(([operation]) => operation === "comment"), false);
  assert.equal(harness.calls.some(([operation]) => operation === "close"), false);
});

test("enforcePullRequestLimits groups all open PRs and applies each author's limit", async () => {
  const current = pullRequest(7, "trigger-user");
  const harness = createHarness({
    current,
    open: [
      pullRequest(1, "default-user"),
      pullRequest(2, "one-pr-user"),
      pullRequest(3, "default-user"),
      pullRequest(4, "one-pr-user"),
      pullRequest(5, "default-user"),
      pullRequest(6, "automation[bot]", { user: { login: "automation[bot]", type: "Bot" } }),
    ],
  });

  const result = await enforcePullRequestLimits({
    ...harness,
    rawLimit: "2",
    rawOverrides: '{"one-pr-user":1}',
  });

  assert.deepEqual([...result.closedPullRequests].sort((left, right) => left - right), [4, 5]);
  assert.deepEqual(
    result.authors.map(({ author, count, limit }) => ({ author, count, limit })),
    [
      { author: "default-user", count: 3, limit: 2 },
      { author: "one-pr-user", count: 2, limit: 1 },
    ],
  );
});

test("enforcePullRequestLimits closes every excess PR left by a burst of events", async () => {
  const current = pullRequest(5);
  const harness = createHarness({
    current,
    open: [
      pullRequest(1),
      pullRequest(2),
      pullRequest(3),
      pullRequest(4),
      current,
    ],
  });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result.closedPullRequests, [3, 4, 5]);
  assert.deepEqual(
    harness.calls.filter(([operation]) => operation === "comment").map(([, options]) => options.issue_number),
    [3, 4, 5],
  );
  assert.deepEqual(
    harness.calls.filter(([operation]) => operation === "close").map(([, options]) => options.pull_number),
    [3, 4, 5],
  );
});

test("enforcePullRequestLimits reconciles every newer PR after a limit decrease", async () => {
  const current = pullRequest(4);
  const harness = createHarness({
    current,
    open: [pullRequest(1), pullRequest(2), pullRequest(3), current],
  });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result.closedPullRequests, [3, 4]);
  assert.deepEqual(
    harness.calls.filter(([operation]) => operation === "close").map(([, options]) => options.pull_number),
    [3, 4],
  );
});

test("enforcePullRequestLimits still reconciles when the triggering PR is already closed", async () => {
  const current = pullRequest(3);
  const harness = createHarness({
    current,
    open: [pullRequest(1), pullRequest(2), pullRequest(4)],
  });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result.closedPullRequests, [4]);
  assert.equal(harness.calls.find(([operation]) => operation === "close")[1].pull_number, 4);
});

test("enforcePullRequestLimits reuses an existing marker comment after a partial failure", async () => {
  const current = pullRequest(3);
  const harness = createHarness({
    commentsByIssue: {
      3: [{ body: buildLimitComment(2, 3), id: 1003, user: { login: "github-actions[bot]" } }],
    },
    current,
    open: [pullRequest(1), pullRequest(2), current],
  });

  const result = await enforcePullRequestLimits({ ...harness, rawLimit: "2" });

  assert.deepEqual(result.closedPullRequests, [3]);
  assert.equal(harness.calls.some(([operation]) => operation === "comment"), false);
  assert.equal(harness.calls.find(([operation]) => operation === "close")[1].pull_number, 3);
});

test("enforcePullRequestLimits updates a stale marker comment with the effective limit", async () => {
  const current = pullRequest(2, "one-pr-user");
  const harness = createHarness({
    commentsByIssue: {
      2: [{ body: buildLimitComment(2, 3), id: 1002, user: { login: "github-actions[bot]" } }],
    },
    current,
    open: [pullRequest(1, "one-pr-user"), current],
  });

  const result = await enforcePullRequestLimits({
    ...harness,
    rawLimit: "2",
    rawOverrides: '{"one-pr-user":1}',
  });

  assert.deepEqual(result.closedPullRequests, [2]);
  assert.equal(harness.calls.some(([operation]) => operation === "comment"), false);
  assert.deepEqual(harness.calls.find(([operation]) => operation === "update-comment")[1], {
    owner: "owner",
    repo: "repository",
    comment_id: 1002,
    body: buildLimitComment(1, 2),
  });
  assert.equal(harness.calls.find(([operation]) => operation === "close")[1].pull_number, 2);
});

test("enforcePullRequestLimits retries closing before failing", async () => {
  const current = pullRequest(3);
  const closeError = new Error("close failed");
  const harness = createHarness({
    closeError,
    current,
    open: [pullRequest(1), pullRequest(2), current],
  });

  await assert.rejects(
    enforcePullRequestLimits({ ...harness, rawLimit: "2" }),
    closeError,
  );

  assert.equal(harness.calls.filter(([operation]) => operation === "close").length, 3);
  assert.equal(harness.messages.warning.length, 3);
});

test("workflow uses the trusted pull_request_target configuration", () => {
  const workflow = fs.readFileSync(
    path.resolve(__dirname, "../../.github/workflows/contributor-pr-limit.yml"),
    "utf8",
  );

  assert.match(workflow, /pull_request_target:\n\s+types: \[opened, reopened\]/);
  assert.match(workflow, /contents: read\n\s+pull-requests: write/);
  assert.doesNotMatch(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /pr-limit-pending|addLabels|queue-event/);
  assert.match(
    workflow,
    /group: contributor-pr-limit\n\s+cancel-in-progress: false/,
  );
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(
    workflow,
    /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4/,
  );
  assert.match(
    workflow,
    /actions\/github-script@f28e40c7f34bde8b3046d885e986cb6290c5673b # v7/,
  );
  assert.match(
    workflow,
    /MAX_OPEN_PRS_PER_CONTRIBUTOR: \$\{\{ vars\.MAX_OPEN_PRS_PER_CONTRIBUTOR \}\}/,
  );
  assert.match(
    workflow,
    /MAX_OPEN_PRS_PER_CONTRIBUTOR_OVERRIDES: \$\{\{ vars\.MAX_OPEN_PRS_PER_CONTRIBUTOR_OVERRIDES \}\}/,
  );
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head/);
});
