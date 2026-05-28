#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 5000;
const BUILD_INFO_PATH = "/opt/codex-desktop/.codex-linux/build-info.json";
const PRIVATE_SESSION_PATH_PATTERN = /\/home\/[^/\s]+\/\.codex\/sessions\/[^\s]+/g;
const READY_STATUSES = new Set(["pass", "warn", "fail"]);

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
  const normalizedChecks = checks.map((check) => {
    const status = String(check.status);
    const message = sanitizeMessage(check.message);
    const statusIsKnown = READY_STATUSES.has(status);
    return {
      id: String(check.id),
      status: statusIsKnown ? status : "fail",
      message: statusIsKnown
        ? message
        : sanitizeMessage(`unknown readiness status "${sanitizeMessage(status)}": ${message}`),
      ...(check.details == null ? {} : { details: check.details }),
    };
  });
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

function isOutputStatusLine(line) {
  return line === "?? output" || line === "?? output/" || line.startsWith("?? output/");
}

function classifyRepoStatus(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.startsWith("## "));
  const untrackedOutput = lines.some(isOutputStatusLine);
  const otherChanges = lines.some((line) => !isOutputStatusLine(line));

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

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env) {
  const parsed = {
    cwd: env.CODEX_READINESS_CWD || process.cwd(),
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--cwd":
        index += 1;
        if (index >= argv.length) {
          throw new Error("--cwd requires a value");
        }
        parsed.cwd = argv[index];
        break;
      case "--timeout-ms":
        index += 1;
        if (index >= argv.length) {
          throw new Error("--timeout-ms requires a value");
        }
        parsed.timeoutMs = parsePositiveInt(argv[index], "--timeout-ms");
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child;

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child?.pid != null) {
        child.kill("SIGTERM");
      }
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({ code: 127, stdout, stderr: String(error?.message || error) });
      return;
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle({ code: 127, stdout, stderr: String(error?.message || error) });
    });
    child.on("close", (code, signal) => {
      settle({
        code: timedOut || signal === "SIGTERM" ? 124 : (code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}

function isTimedOut(result) {
  return result?.code === 124;
}

function timeoutCheck(id, label) {
  return {
    id,
    status: "fail",
    message: `${label} check timed out`,
  };
}

function userBusEnv(env = process.env) {
  const next = { ...env };
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const runtimeDir = next.XDG_RUNTIME_DIR || (uid == null ? null : `/run/user/${uid}`);

  if (runtimeDir && !next.XDG_RUNTIME_DIR) {
    next.XDG_RUNTIME_DIR = runtimeDir;
  }
  if (runtimeDir && !next.DBUS_SESSION_BUS_ADDRESS) {
    next.DBUS_SESSION_BUS_ADDRESS = `unix:path=${runtimeDir}/bus`;
  }

  return next;
}

async function checkPackage(options, runner) {
  const result = await runner("dpkg-query", ["-W", "-f=${Package} ${Version}\\n", "codex-desktop"], options);
  if (isTimedOut(result)) {
    return timeoutCheck("package", "package");
  }
  if (result.code === 0 && result.stdout.trim()) {
    return {
      id: "package",
      status: "pass",
      message: result.stdout.trim(),
    };
  }

  return {
    id: "package",
    status: "warn",
    message: "codex-desktop package not found by dpkg-query",
  };
}

async function checkBuildInfo(options, runner) {
  const result = await runner("cat", [BUILD_INFO_PATH], options);
  if (isTimedOut(result)) {
    return timeoutCheck("build-info", "build metadata");
  }
  if (result.code !== 0) {
    return {
      id: "build-info",
      status: "fail",
      message: "installed Linux build metadata is missing",
    };
  }

  try {
    const info = JSON.parse(result.stdout);
    const source = info.source || {};
    if (!source.shortCommit) {
      return {
        id: "build-info",
        status: "fail",
        message: "installed Linux build metadata has no source commit",
      };
    }

    return {
      id: "build-info",
      status: "pass",
      message: `source=${source.shortCommit} branch=${source.branch || "unknown"} dirty=${String(source.dirty)}`,
      details: {
        shortCommit: source.shortCommit,
        branch: source.branch || null,
        dirty: source.dirty ?? null,
      },
    };
  } catch {
    return {
      id: "build-info",
      status: "fail",
      message: "installed Linux build metadata is invalid JSON",
    };
  }
}

async function checkDoctor(options, runner) {
  const result = await runner("/usr/bin/codex-desktop-doctor", [], options);
  if (isTimedOut(result)) {
    return timeoutCheck("doctor", "doctor");
  }
  const summary = parseDoctorSummary(result.stdout);
  if (result.code !== 0 || summary == null) {
    return {
      id: "doctor",
      status: "fail",
      message: "codex-desktop-doctor did not return a valid summary",
    };
  }

  return {
    id: "doctor",
    status: summary.fail > 0 ? "fail" : "pass",
    message: `${summary.pass} pass / ${summary.warn} warn / ${summary.fail} fail / ${summary.info} info`,
    details: summary,
  };
}

async function checkServices(options, runner) {
  const result = await runner(
    "systemctl",
    ["--user", "is-active", "codex-desktop.service", "codex-update-manager.service"],
    { ...options, env: userBusEnv(options.env) },
  );
  if (isTimedOut(result)) {
    return timeoutCheck("services", "service status");
  }
  const states = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const desktop = states[0] || "unknown";
  const updater = states[1] || "unknown";
  const active = desktop === "active" && updater === "active";

  return {
    id: "services",
    status: active ? "pass" : "fail",
    message: `codex-desktop.service=${desktop} codex-update-manager.service=${updater}`,
    details: { desktop, updater },
  };
}

async function checkRemote(options, runner) {
  const result = await runner("pgrep", ["-af", "codex app-server --remote-control"], options);
  if (isTimedOut(result)) {
    return timeoutCheck("remote", "remote-control process");
  }
  if (result.code !== 0 && result.code !== 1) {
    return {
      id: "remote",
      status: "fail",
      message: "remote-control process check failed",
    };
  }
  const present = result.code === 0 && result.stdout.trim().length > 0;

  return {
    id: "remote",
    status: present ? "pass" : "warn",
    message: present ? "app-server --remote-control present" : "app-server --remote-control not detected",
    details: { present },
  };
}

async function checkHistory(options, runner) {
  const script = path.join("scripts", "codex-history-context-check.js");
  const result = await runner("node", [script, "--cwd", options.cwd], { ...options, cwd: options.cwd });
  if (isTimedOut(result)) {
    return timeoutCheck("history", "history");
  }

  try {
    const payload = JSON.parse(result.stdout);
    if (result.code === 0 && payload.ok === true) {
      return {
        id: "history",
        status: "pass",
        message: "memory ok, thread/list responded",
        details: {
          memoryOk: Boolean(payload.memoryContext?.sessionStateExists && payload.memoryContext?.currentExists),
          threadListResponded: Boolean(payload.threadHistory?.responded),
          cwdFilteredThreadCount: payload.threadHistory?.cwdFilteredThreadCount ?? null,
        },
      };
    }
  } catch {
    return {
      id: "history",
      status: "fail",
      message: "history check printed invalid JSON",
    };
  }

  return {
    id: "history",
    status: "fail",
    message: "history check failed",
  };
}

async function checkRepo(options, runner) {
  const result = await runner("git", ["status", "--short", "--branch"], { ...options, cwd: options.cwd });
  if (isTimedOut(result)) {
    return timeoutCheck("repo", "repo status");
  }
  if (result.code !== 0) {
    return {
      id: "repo",
      status: "fail",
      message: "repo status check failed",
    };
  }
  const repo = classifyRepoStatus(result.stdout);
  return { id: "repo", ...repo };
}

function usage() {
  return [
    "Usage: codex-readiness-check.js [options]",
    "",
    "Checks installed Codex Desktop Linux readiness without printing private session content.",
    "",
    "Options:",
    "  --json             Print JSON instead of human output",
    "  --cwd PATH         Repo/workspace path (default: cwd or CODEX_READINESS_CWD)",
    "  --timeout-ms MS    Per-command timeout (default: 5000)",
    "  -h, --help         Show this help",
  ].join("\n");
}

async function runReadinessCheck(options, runner = runCommand) {
  const commandOptions = {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
  const checks = [];

  checks.push(await checkPackage(commandOptions, runner));
  checks.push(await checkBuildInfo(commandOptions, runner));
  checks.push(await checkDoctor(commandOptions, runner));
  checks.push(await checkServices(commandOptions, runner));
  checks.push(await checkRemote(commandOptions, runner));
  checks.push(await checkHistory(commandOptions, runner));
  checks.push(await checkRepo(commandOptions, runner));

  return aggregateChecks(checks);
}

async function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }

    const report = await runReadinessCheck(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatHumanReport(report));
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = sanitizeMessage(error?.message || error);
    if (options?.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(`Error: ${message}`);
      console.error("");
      console.error(usage());
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseArgs,
  parseDoctorSummary,
  runCommand,
  runReadinessCheck,
  sanitizeMessage,
  usage,
};
