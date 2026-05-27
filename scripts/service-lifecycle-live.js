#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");

const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";
const SKIP = "skip";

const LOAD_STATES = new Set(["loaded", "not-found", "masked", "error", "bad-setting", "unknown"]);
const ACTIVE_STATES = new Set(["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "unknown"]);
const UNIT_FILE_STATES = new Set(["enabled", "disabled", "static", "masked", "linked", "indirect", "generated", "transient", "bad", "unknown"]);
const RESULT_STATES = new Set(["success", "failure", "timeout", "exit-code", "signal", "core-dump", "watchdog", "start-limit-hit", "resources", "unknown"]);
const RESTART_POLICIES = new Set(["no", "on-success", "on-failure", "on-abnormal", "on-watchdog", "on-abort", "always", "unknown"]);

function usage() {
  return [
    "Usage: service-lifecycle-live.js [--json] [--strict] [--package-name NAME] [--systemctl PATH]",
    "",
    "Queries sanitized systemd --user unit state without starting, stopping, restarting, or reading logs.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    json: false,
    strict: process.env.CODEX_SERVICE_LIVE_STRICT === "1",
    packageName: process.env.PACKAGE_NAME || "codex-desktop",
    systemctl: process.env.SYSTEMCTL || "systemctl",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--package-name") {
      index += 1;
      options.packageName = argv[index] || "";
    } else if (arg === "--systemctl") {
      index += 1;
      options.systemctl = argv[index] || "";
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!/^[A-Za-z0-9_.+-]+$/u.test(options.packageName)) {
    throw new Error("package name must contain only letters, numbers, dot, underscore, plus, or hyphen");
  }
  if (options.systemctl.length === 0) {
    throw new Error("systemctl command must not be empty");
  }
  return options;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, stdout: "", stderr: "", status: 127 };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

function systemctl(options, args) {
  return run(options.systemctl, ["--user", ...args]);
}

function parseProperties(stdout) {
  const props = new Map();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    if (!rawLine.includes("=")) {
      continue;
    }
    const index = rawLine.indexOf("=");
    props.set(rawLine.slice(0, index), rawLine.slice(index + 1));
  }
  return props;
}

function tokenList(value) {
  return String(value || "")
    .split(/\s+/u)
    .filter(Boolean);
}

function hasToken(props, key, token) {
  return tokenList(props.get(key)).includes(token);
}

function enumValue(value, allowed) {
  const normalized = String(value || "").trim();
  return allowed.has(normalized) ? normalized : "unknown";
}

function integerValue(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function unitIssueKinds(report, expected) {
  const issues = [];
  if (report.loadState !== "loaded") {
    issues.push("not_loaded");
  }
  if (expected.active && report.activeState !== "active") {
    issues.push("not_active");
  }
  if (expected.enabled && report.unitFileState !== "enabled") {
    issues.push("not_enabled");
  }
  if (expected.restartPolicy && report.restartPolicy !== expected.restartPolicy) {
    issues.push("restart_policy_mismatch");
  }
  for (const [key, expectedValue] of Object.entries(expected.dependencies || {})) {
    if (report.dependencies[key] !== expectedValue) {
      issues.push("dependency_missing");
      break;
    }
  }
  return Array.from(new Set(issues));
}

function statusFromIssues(issues, strict) {
  if (issues.length === 0) {
    return PASS;
  }
  return strict ? FAIL : WARN;
}

function showUnit(options, unitName) {
  return systemctl(options, [
    "show",
    unitName,
    "--no-pager",
    "--property=LoadState,ActiveState,SubState,UnitFileState,Result,Restart,NRestarts,After,Wants,PartOf",
  ]);
}

function buildUnitReport(options, result, dependencies, expected) {
  if (!result.ok) {
    const issues = ["query_failed"];
    return {
      loadState: "unknown",
      activeState: "unknown",
      unitFileState: "unknown",
      result: "unknown",
      restartPolicy: "unknown",
      restartCount: 0,
      dependencies,
      status: statusFromIssues(issues, options.strict),
      issueKinds: issues,
    };
  }

  const props = parseProperties(result.stdout);
  const report = {
    loadState: enumValue(props.get("LoadState"), LOAD_STATES),
    activeState: enumValue(props.get("ActiveState"), ACTIVE_STATES),
    unitFileState: enumValue(props.get("UnitFileState"), UNIT_FILE_STATES),
    result: enumValue(props.get("Result"), RESULT_STATES),
    restartPolicy: enumValue(props.get("Restart"), RESTART_POLICIES),
    restartCount: integerValue(props.get("NRestarts")),
    dependencies,
    status: PASS,
    issueKinds: [],
  };
  report.issueKinds = unitIssueKinds(report, expected);
  report.status = statusFromIssues(report.issueKinds, options.strict);
  return report;
}

function strongestStatus(statuses) {
  if (statuses.includes(FAIL)) {
    return FAIL;
  }
  if (statuses.includes(WARN)) {
    return WARN;
  }
  if (statuses.includes(PASS)) {
    return PASS;
  }
  return SKIP;
}

function buildReport(options) {
  const environment = systemctl(options, ["show-environment"]);
  if (!environment.ok) {
    const status = options.strict ? FAIL : SKIP;
    return {
      ok: status !== FAIL,
      date: new Date().toISOString().slice(0, 10),
      status,
      systemdUser: {
        available: false,
        status,
        issueKind: "systemd_user_unavailable",
      },
      appService: null,
      updaterService: null,
      notes: "Read-only systemd --user probe could not query the user manager; no service changes or logs were read.",
    };
  }

  const appUnitName = `${options.packageName}.service`;
  const appResult = showUnit(options, appUnitName);
  const updaterResult = showUnit(options, "codex-update-manager.service");
  const appProps = parseProperties(appResult.stdout || "");
  const updaterProps = parseProperties(updaterResult.stdout || "");
  const appDependencies = {
    afterGraphicalSession: hasToken(appProps, "After", "graphical-session.target"),
    partOfGraphicalSession: hasToken(appProps, "PartOf", "graphical-session.target"),
  };
  const updaterDependencies = {
    afterGraphicalSession: hasToken(updaterProps, "After", "graphical-session.target"),
    afterNetworkOnline: hasToken(updaterProps, "After", "network-online.target"),
    wantsNetworkOnline: hasToken(updaterProps, "Wants", "network-online.target"),
  };
  const appService = buildUnitReport(options, appResult, appDependencies, {
    active: true,
    enabled: true,
    restartPolicy: "on-failure",
    dependencies: {
      afterGraphicalSession: true,
      partOfGraphicalSession: true,
    },
  });
  const updaterService = buildUnitReport(options, updaterResult, updaterDependencies, {
    active: true,
    enabled: true,
    restartPolicy: "on-failure",
    dependencies: {
      afterGraphicalSession: true,
      afterNetworkOnline: true,
      wantsNetworkOnline: true,
    },
  });
  const status = strongestStatus([appService.status, updaterService.status]);
  return {
    ok: status !== FAIL,
    date: new Date().toISOString().slice(0, 10),
    status,
    systemdUser: {
      available: true,
      status: PASS,
      issueKind: "none",
    },
    appService,
    updaterService,
    notes: "Read-only systemctl --user show probe; no services were started, stopped, restarted, or logged.",
  };
}

function printText(report) {
  console.log("Service lifecycle live probe (redacted)");
  console.log(`Systemd user: status=${report.systemdUser.status} available=${String(report.systemdUser.available)}`);
  if (report.appService) {
    console.log(
      `App service: status=${report.appService.status} active=${report.appService.activeState} enabled=${report.appService.unitFileState} restarts=${report.appService.restartCount}`,
    );
  }
  if (report.updaterService) {
    console.log(
      `Updater service: status=${report.updaterService.status} active=${report.updaterService.activeState} enabled=${report.updaterService.unitFileState} restarts=${report.updaterService.restartCount}`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildReport(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report);
  }
  if (!report.ok) {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildReport,
  parseProperties,
};
