const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildThreadListRequest,
  parseArgs,
  sanitizeThreads,
  summarizeMemoryState,
} = require("./codex-history-context-check.js");

test("parseArgs keeps conservative defaults", () => {
  const parsed = parseArgs([]);

  assert.equal(parsed.codexBin, "codex");
  assert.equal(parsed.limit, 10);
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.json, true);
});

test("sanitizeThreads reports counts without leaking thread text or ids", () => {
  const summary = sanitizeThreads(
    [
      {
        id: "thread-secret",
        preview: "private user prompt",
        name: "private title",
        cwd: "/home/remy/codex-desktop-linux",
        source: { kind: "cli" },
        updatedAt: 10,
      },
      {
        id: "thread-secret-2",
        preview: "another private prompt",
        path: "/home/remy/.codex/sessions/private.jsonl",
        cwd: "/tmp/other",
        source: "app_server",
        updatedAt: 20,
      },
    ],
    "/home/remy/codex-desktop-linux",
  );

  assert.deepEqual(summary, {
    threadCount: 2,
    matchingCwdThreadCount: 1,
    sourceCounts: {
      app_server: 1,
      cli: 1,
    },
    newestUpdatedAt: 20,
  });

  const encoded = JSON.stringify(summary);
  assert.equal(encoded.includes("private"), false);
  assert.equal(encoded.includes("thread-secret"), false);
  assert.equal(encoded.includes(".jsonl"), false);
});

test("buildThreadListRequest can scope history to a workspace cwd", () => {
  assert.deepEqual(buildThreadListRequest(7, { limit: 5 }, "/home/remy/codex-desktop-linux"), {
    id: 7,
    method: "thread/list",
    params: {
      cwd: "/home/remy/codex-desktop-linux",
      limit: 5,
      useStateDbOnly: true,
    },
  });
});

test("summarizeMemoryState exposes project continuity without memory body text", () => {
  const summary = summarizeMemoryState(
    {
      active_project: "codex-desktop-linux",
      workspace: "/home/remy/codex-desktop-linux",
      current_task: "private detailed task text",
    },
    {
      sessionStateExists: true,
      currentExists: true,
      memoryIndexExists: true,
      latestDigestExists: false,
    },
    "/home/remy/codex-desktop-linux",
  );

  assert.deepEqual(summary, {
    sessionStateExists: true,
    currentExists: true,
    memoryIndexExists: true,
    latestDigestExists: false,
    activeProject: "codex-desktop-linux",
    workspaceConfigured: true,
    workspaceMatchesCwd: true,
  });

  assert.equal(JSON.stringify(summary).includes("private detailed task text"), false);
});
