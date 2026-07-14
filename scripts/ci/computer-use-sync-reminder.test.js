"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const repositoryRoot = path.resolve(__dirname, "../..");
const workflowPath = path.join(
  repositoryRoot,
  ".github/workflows/computer-use-sync-reminder.yml",
);
const policy = require(path.join(repositoryRoot, ".github/labels.json"));

function workflowScript() {
  const lines = fs.readFileSync(workflowPath, "utf8").split("\n");
  const marker = lines.findIndex((line) => line.trim() === "script: |");
  assert.notEqual(marker, -1, "workflow must contain a github-script block");
  return lines
    .slice(marker + 1)
    .map((line) => line.replace(/^ {12}/, ""))
    .join("\n");
}

function harness({
  getLabelError = Object.assign(new Error("missing"), { status: 404 }),
  legacyIssue = { number: 944 },
} = {}) {
  const calls = [];
  const issues = {
    addLabels: async (options) => calls.push(["addLabels", options]),
    create: async (options) => calls.push(["create", options]),
    createComment: async (options) => calls.push(["createComment", options]),
    createLabel: async (options) => calls.push(["createLabel", options]),
    getLabel: async (options) => {
      calls.push(["getLabel", options]);
      if (getLabelError) throw getLabelError;
    },
    listForRepo: async (options) => {
      calls.push(["listForRepo", options]);
      if (options.labels === "computer-use-sync") {
        return { data: legacyIssue ? [legacyIssue] : [] };
      }
      return { data: [] };
    },
  };
  return {
    calls,
    core: { notice: (message) => calls.push(["notice", message]) },
    context: {
      payload: { compare: "https://github.com/owner/repository/compare/old...new" },
      repo: { owner: "owner", repo: "repository" },
      sha: "0123456789abcdef",
    },
    github: { rest: { issues } },
  };
}

async function runWorkflow(harnessValue) {
  const originalWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = repositoryRoot;
  const requirePolicy = (requestedPath) => {
    assert.equal(requestedPath, path.join(repositoryRoot, ".github/labels.json"));
    return policy;
  };
  try {
    const execute = new AsyncFunction("github", "context", "require", "core", workflowScript());
    await execute(
      harnessValue.github,
      harnessValue.context,
      requirePolicy,
      harnessValue.core,
    );
  } finally {
    if (originalWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = originalWorkspace;
  }
}

test("sync reminder adopts the legacy open issue during label rollout", async () => {
  const value = harness();

  await runWorkflow(value);

  assert.deepEqual(
    value.calls
      .filter(([operation]) => operation === "createLabel")
      .map(([, options]) => options.name),
    ["type: maintenance", "area: computer use", "status: ready for work", "sync: computer use"],
  );
  const addLabels = value.calls.find(([operation]) => operation === "addLabels");
  assert.deepEqual(addLabels[1], {
    owner: "owner",
    repo: "repository",
    issue_number: 944,
    labels: [
      "type: maintenance",
      "area: computer use",
      "status: ready for work",
      "sync: computer use",
    ],
  });
  const comment = value.calls.find(([operation]) => operation === "createComment");
  assert.equal(comment[1].issue_number, 944);
  assert.equal(value.calls.some(([operation]) => operation === "create"), false);
});

test("sync reminder creates new issues with a complete governed classification", async () => {
  const value = harness({ legacyIssue: null });

  await runWorkflow(value);

  assert.deepEqual(value.calls.find(([operation]) => operation === "create")[1].labels, [
    "type: maintenance",
    "area: computer use",
    "status: ready for work",
    "sync: computer use",
  ]);
});

test("sync reminder fails closed when label lookup fails for a non-404 reason", async () => {
  const value = harness({ getLabelError: Object.assign(new Error("forbidden"), { status: 403 }) });

  await assert.rejects(() => runWorkflow(value), /forbidden/);

  assert.equal(value.calls.some(([operation]) => operation === "createLabel"), false);
  assert.equal(value.calls.some(([operation]) => operation === "create"), false);
});

test("sync reminder preserves a manual-only item without commenting", async () => {
  const value = harness({
    legacyIssue: { number: 944, labels: [{ name: "workflow: manual only" }] },
  });

  await runWorkflow(value);

  assert.equal(value.calls.some(([operation]) => operation === "addLabels"), false);
  assert.equal(value.calls.some(([operation]) => operation === "createComment"), false);
  assert.equal(value.calls.some(([operation]) => operation === "create"), false);
});

test("sync reminder workflow serializes runs and pins third-party actions", () => {
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /group: computer-use-sync-reminder/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s]+@v\d/);
});
