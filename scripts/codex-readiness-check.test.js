"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseDoctorSummary,
  sanitizeMessage,
} = require("./codex-readiness-check.js");

test("parseDoctorSummary extracts pass warn fail info counts", () => {
  assert.deepEqual(parseDoctorSummary("noise\nSummary: 25 pass, 0 warn, 0 fail, 3 info\n"), {
    pass: 25,
    warn: 0,
    fail: 0,
    info: 3,
  });
});

test("aggregateChecks reports ready with warnings when there are no failures", () => {
  const result = aggregateChecks([
    { id: "package", status: "pass", message: "codex-desktop 1" },
    { id: "repo", status: "warn", message: "untracked output/ is present" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, {
    status: "ready-with-warnings",
    pass: 1,
    warn: 1,
    fail: 0,
  });
  assert.deepEqual(
    result.checks.map((check) => check.id),
    ["package", "repo"],
  );
});

test("aggregateChecks fails when any check fails", () => {
  const result = aggregateChecks([{ id: "doctor", status: "fail", message: "doctor has failures" }]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    status: "not-ready",
    pass: 0,
    warn: 0,
    fail: 1,
  });
});

test("aggregateChecks treats unknown statuses as failures", () => {
  const result = aggregateChecks([
    {
      id: "doctor",
      status: "error",
      message: "/home/remy/.codex/sessions/private.jsonl could not be parsed",
    },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    status: "not-ready",
    pass: 0,
    warn: 0,
    fail: 1,
  });
  assert.deepEqual(result.checks, [
    {
      id: "doctor",
      status: "fail",
      message: 'unknown readiness status "error": [redacted-session-path] could not be parsed',
    },
  ]);
});

test("aggregateChecks reports ready for clean pass results", () => {
  const result = aggregateChecks([
    { id: "package", status: "pass", message: "codex-desktop 1" },
    { id: "doctor", status: "pass", message: "25 pass / 0 warn / 0 fail / 3 info" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, {
    status: "ready",
    pass: 2,
    warn: 0,
    fail: 0,
  });
});

test("classifyRepoStatus treats only output/ as warning", () => {
  assert.deepEqual(classifyRepoStatus("## branch\n?? output/\n"), {
    status: "warn",
    message: "untracked output/ is present",
    details: {
      untrackedOutput: true,
      otherChanges: false,
    },
  });
});

test("classifyRepoStatus treats output descendants as warning", () => {
  assert.deepEqual(classifyRepoStatus("## branch\n?? output/playwright/report.json\n?? output/logs/run.txt\n"), {
    status: "warn",
    message: "untracked output/ is present",
    details: {
      untrackedOutput: true,
      otherChanges: false,
    },
  });
});

test("classifyRepoStatus also treats output without a slash as warning", () => {
  assert.deepEqual(classifyRepoStatus("?? output\n"), {
    status: "warn",
    message: "untracked output/ is present",
    details: {
      untrackedOutput: true,
      otherChanges: false,
    },
  });
});

test("classifyRepoStatus reports pass when there are no changes", () => {
  assert.deepEqual(classifyRepoStatus("## branch\n"), {
    status: "pass",
    message: "repo clean",
    details: {
      untrackedOutput: false,
      otherChanges: false,
    },
  });
});

test("classifyRepoStatus fails on unrelated changes", () => {
  assert.deepEqual(classifyRepoStatus("## branch\n M README.md\n?? output/\n"), {
    status: "fail",
    message: "repo has uncommitted changes outside output/",
    details: {
      untrackedOutput: true,
      otherChanges: true,
    },
  });
});

test("sanitizeMessage removes private-looking paths, control chars, and truncates", () => {
  const message = sanitizeMessage(
    "/home/remy/.codex/sessions/private.jsonl secret \u0000binary\u001f ".repeat(20),
  );

  assert.equal(message.includes(".jsonl"), false);
  assert.equal(message.includes("/home/remy/.codex/sessions"), false);
  assert.equal(message.includes("\u0000"), false);
  assert.equal(message.includes("\u001f"), false);
  assert.ok(message.includes("?"));
  assert.ok(message.length <= 240);
});

test("formatHumanReport prints no raw details object or private paths", () => {
  const report = aggregateChecks([
    {
      id: "history",
      status: "pass",
      message: "memory ok, thread/list responded",
      details: {
        rawPath: "/home/remy/.codex/sessions/private.jsonl",
      },
    },
  ]);

  const output = formatHumanReport(report);

  assert.match(output, /Codex Desktop Linux readiness/);
  assert.match(output, /PASS history/);
  assert.equal(output.includes("rawPath"), false);
  assert.equal(output.includes(".jsonl"), false);
  assert.equal(output.includes("/home/remy/.codex/sessions"), false);
});
