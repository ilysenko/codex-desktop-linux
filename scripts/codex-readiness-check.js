#!/usr/bin/env node
"use strict";

const PRIVATE_SESSION_PATH_PATTERN = /\/home\/[^/\s]+\/\.codex\/sessions\/[^\s]+/g;

function sanitizeMessage(value) {
  return String(value ?? "")
    .replace(PRIVATE_SESSION_PATH_PATTERN, "[redacted-session-path]")
    .replace(/[^ -~\n\t]/g, "?")
    .slice(0, 240);
}

function parseDoctorSummary(stdout) {
  const match = String(stdout ?? "").match(
    /Summary:\s*(\d+)\s+pass,\s*(\d+)\s+warn,\s*(\d+)\s+fail,\s*(\d+)\s+info/,
  );
  if (!match) {
    return null;
  }

  return {
    pass: Number.parseInt(match[1], 10),
    warn: Number.parseInt(match[2], 10),
    fail: Number.parseInt(match[3], 10),
    info: Number.parseInt(match[4], 10),
  };
}

function aggregateChecks(checks) {
  const normalizedChecks = checks.map((check) => ({
    id: String(check.id),
    status: check.status,
    message: sanitizeMessage(check.message),
    ...(check.details == null ? {} : { details: check.details }),
  }));
  const summary = {
    status: "ready",
    pass: 0,
    warn: 0,
    fail: 0,
  };

  for (const check of normalizedChecks) {
    if (check.status === "pass") {
      summary.pass += 1;
    } else if (check.status === "warn") {
      summary.warn += 1;
    } else if (check.status === "fail") {
      summary.fail += 1;
    }
  }

  if (summary.fail > 0) {
    summary.status = "not-ready";
  } else if (summary.warn > 0) {
    summary.status = "ready-with-warnings";
  }

  return {
    ok: summary.fail === 0,
    summary,
    checks: normalizedChecks,
  };
}

function classifyRepoStatus(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.startsWith("## "));
  const untrackedOutput = lines.some((line) => line === "?? output/" || line === "?? output");
  const otherChanges = lines.some((line) => line !== "?? output/" && line !== "?? output");

  if (otherChanges) {
    return {
      status: "fail",
      message: "repo has uncommitted changes outside output/",
      details: {
        untrackedOutput,
        otherChanges,
      },
    };
  }

  if (untrackedOutput) {
    return {
      status: "warn",
      message: "untracked output/ is present",
      details: {
        untrackedOutput,
        otherChanges,
      },
    };
  }

  return {
    status: "pass",
    message: "repo clean",
    details: {
      untrackedOutput: false,
      otherChanges: false,
    },
  };
}

function formatHumanReport(report) {
  const lines = ["Codex Desktop Linux readiness", ""];

  for (const check of report.checks) {
    const label = String(check.status).toUpperCase().padEnd(4, " ");
    const id = sanitizeMessage(check.id).replace(/\s+/g, "-").padEnd(12, " ");
    lines.push(`${label} ${id} ${sanitizeMessage(check.message)}`);
  }

  lines.push("");
  if (report.summary.fail > 0) {
    lines.push(`Summary: not ready (${report.summary.fail} failure${report.summary.fail === 1 ? "" : "s"})`);
  } else if (report.summary.warn > 0) {
    lines.push(`Summary: ready with ${report.summary.warn} warning${report.summary.warn === 1 ? "" : "s"}`);
  } else {
    lines.push("Summary: ready");
  }

  return `${lines.join("\n")}\n`;
}

module.exports = {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseDoctorSummary,
  sanitizeMessage,
};
