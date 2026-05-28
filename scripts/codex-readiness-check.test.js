"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseArgs,
  parseDoctorSummary,
  runReadinessCheck,
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

test("parseArgs supports json cwd timeout help and env cwd fallback", () => {
  assert.deepEqual(parseArgs(["--json", "--timeout-ms", "1234", "--cwd", "/tmp/repo"], {}), {
    cwd: "/tmp/repo",
    json: true,
    timeoutMs: 1234,
  });
  assert.deepEqual(parseArgs(["--help"], { CODEX_READINESS_CWD: "/env/repo" }), {
    cwd: "/env/repo",
    help: true,
    json: false,
    timeoutMs: 5000,
  });
});

test("runReadinessCheck composes package doctor services remote history and repo checks", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "dpkg-query") {
      return { code: 0, stdout: "codex-desktop 2026.05.28.042624+paritycacd32b\n", stderr: "" };
    }
    if (command === "cat") {
      return {
        code: 0,
        stdout: JSON.stringify({
          source: {
            shortCommit: "cacd32b65470",
            branch: "codex/local-parity-lab",
            dirty: true,
          },
        }),
        stderr: "",
      };
    }
    if (command === "/usr/bin/codex-desktop-doctor") {
      return { code: 0, stdout: "Summary: 25 pass, 0 warn, 0 fail, 3 info\n", stderr: "" };
    }
    if (command === "systemctl") {
      return { code: 0, stdout: "active\nactive\n", stderr: "" };
    }
    if (command === "pgrep") {
      return { code: 0, stdout: "123 codex app-server --remote-control --private-payload\n", stderr: "" };
    }
    if (command === "node") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          memoryContext: { sessionStateExists: true, currentExists: true },
          threadHistory: { responded: true, cwdFilteredThreadCount: 0 },
        }),
        stderr: "",
      };
    }
    if (command === "git") {
      return { code: 0, stdout: "## branch\n?? output/\n", stderr: "" };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const report = await runReadinessCheck({ cwd: "/repo", timeoutMs: 1000 }, runner);

  assert.equal(report.ok, true);
  assert.equal(report.summary.status, "ready-with-warnings");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["package", "build-info", "doctor", "services", "remote", "history", "repo"],
  );
  assert.ok(calls.includes("node scripts/codex-history-context-check.js --cwd /repo"));
  assert.ok(calls.includes("pgrep -af codex app-server --remote-control"));
  assert.equal(JSON.stringify(report).includes("--private-payload"), false);
});

test("runReadinessCheck fails closed when a subprocess times out", async () => {
  const runner = async (command) => {
    if (command === "dpkg-query") {
      return { code: 0, stdout: "codex-desktop 2026.05.28.042624+paritycacd32b\n", stderr: "" };
    }
    if (command === "cat") {
      return { code: 0, stdout: JSON.stringify({ source: { shortCommit: "cacd32b" } }), stderr: "" };
    }
    if (command === "/usr/bin/codex-desktop-doctor") {
      return { code: 0, stdout: "Summary: 25 pass, 0 warn, 0 fail, 3 info\n", stderr: "" };
    }
    if (command === "systemctl") {
      return { code: 0, stdout: "active\nactive\n", stderr: "" };
    }
    if (command === "pgrep") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (command === "node") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          memoryContext: { sessionStateExists: true, currentExists: true },
          threadHistory: { responded: true, cwdFilteredThreadCount: 0 },
        }),
        stderr: "",
      };
    }
    if (command === "git") {
      return { code: 124, stdout: "", stderr: "private timeout detail" };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const report = await runReadinessCheck({ cwd: "/repo", timeoutMs: 1000 }, runner);
  const repoCheck = report.checks.find((check) => check.id === "repo");

  assert.equal(report.ok, false);
  assert.equal(repoCheck.status, "fail");
  assert.equal(repoCheck.message, "repo status check timed out");
  assert.equal(JSON.stringify(report).includes("private timeout detail"), false);
});

test("runReadinessCheck supplies a user bus environment for service checks", async () => {
  let serviceOptions;
  const runner = async (command, args, options = {}) => {
    if (command === "systemctl") {
      serviceOptions = options;
    }
    if (command === "dpkg-query") {
      return { code: 0, stdout: "codex-desktop 2026.05.28.042624+paritycacd32b\n", stderr: "" };
    }
    if (command === "cat") {
      return { code: 0, stdout: JSON.stringify({ source: { shortCommit: "cacd32b" } }), stderr: "" };
    }
    if (command === "/usr/bin/codex-desktop-doctor") {
      return { code: 0, stdout: "Summary: 25 pass, 0 warn, 0 fail, 3 info\n", stderr: "" };
    }
    if (command === "systemctl") {
      return { code: 0, stdout: "active\nactive\n", stderr: "" };
    }
    if (command === "pgrep") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (command === "node") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          memoryContext: { sessionStateExists: true, currentExists: true },
          threadHistory: { responded: true, cwdFilteredThreadCount: 0 },
        }),
        stderr: "",
      };
    }
    if (command === "git") {
      return { code: 0, stdout: "## branch\n", stderr: "" };
    }
    throw new Error(`unexpected command ${command}`);
  };

  await runReadinessCheck({ cwd: "/repo", timeoutMs: 1000 }, runner);

  assert.equal(typeof serviceOptions.env.XDG_RUNTIME_DIR, "string");
  assert.equal(typeof serviceOptions.env.DBUS_SESSION_BUS_ADDRESS, "string");
});
