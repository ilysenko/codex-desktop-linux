#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_DIR = path.resolve(__dirname, "..");

function usage() {
  return [
    "Usage: service-lifecycle-smoke.js [--json]",
    "",
    "Checks committed systemd service lifecycle markers without starting services.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { json: false };
  for (const arg of argv) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_DIR, relativePath), "utf8");
}

function parseUnit(source) {
  const sections = new Map();
  let current = null;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      current = sectionMatch[1];
      if (!sections.has(current)) {
        sections.set(current, new Map());
      }
      continue;
    }
    if (!current || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    const section = sections.get(current);
    if (!section.has(key)) {
      section.set(key, []);
    }
    section.get(key).push(value);
  }
  return sections;
}

function unitValues(unit, sectionName, key) {
  return unit.get(sectionName)?.get(key) ?? [];
}

function unitValue(unit, sectionName, key) {
  return unitValues(unit, sectionName, key).join(" ");
}

function valueHasToken(value, token) {
  return value.split(/\s+/u).includes(token);
}

function evaluateCheck(name, assertions) {
  const missing = assertions
    .filter((assertion) => !assertion.ok)
    .map((assertion) => assertion.name);
  return {
    name,
    status: missing.length === 0 ? "pass" : "fail",
    missing,
  };
}

function runSmoke() {
  const appServiceSource = read("packaging/linux/codex-desktop.service");
  const updaterServiceSource = read("packaging/linux/codex-update-manager.service");
  const runtimeSource = read("packaging/linux/codex-packaged-runtime.sh");
  const parityFullSource = read("scripts/desktop-parity-full.sh");
  const readmeSource = read("README.md");
  const parityMatrixSource = read("docs/PARITY_MATRIX.md");

  const appService = parseUnit(appServiceSource);
  const updaterService = parseUnit(updaterServiceSource);
  const appAfter = unitValue(appService, "Unit", "After");
  const appPartOf = unitValue(appService, "Unit", "PartOf");
  const appWantedBy = unitValue(appService, "Install", "WantedBy");
  const appExecStart = unitValue(appService, "Service", "ExecStart");
  const updaterAfter = unitValue(updaterService, "Unit", "After");
  const updaterWants = unitValue(updaterService, "Unit", "Wants");
  const updaterExecStart = unitValue(updaterService, "Service", "ExecStart");
  const updaterWantedBy = unitValue(updaterService, "Install", "WantedBy");

  const checks = [
    evaluateCheck("desktop_app_service_session_lifecycle", [
      { name: "after_graphical_session", ok: valueHasToken(appAfter, "graphical-session.target") },
      { name: "partof_graphical_session", ok: valueHasToken(appPartOf, "graphical-session.target") },
      { name: "wanted_by_graphical_session", ok: valueHasToken(appWantedBy, "graphical-session.target") },
      { name: "restart_on_failure", ok: unitValue(appService, "Service", "Restart") === "on-failure" },
      { name: "restart_sec_5", ok: unitValue(appService, "Service", "RestartSec") === "5" },
      { name: "pid_file_wait", ok: appExecStart.includes("app.pid") && appExecStart.includes("kill -0") },
      { name: "no_debug_port", ok: !appServiceSource.includes("--remote-debugging-port") },
    ]),
    evaluateCheck("updater_service_network_lifecycle", [
      { name: "after_graphical_session", ok: valueHasToken(updaterAfter, "graphical-session.target") },
      { name: "after_network_online", ok: valueHasToken(updaterAfter, "network-online.target") },
      { name: "wants_network_online", ok: valueHasToken(updaterWants, "network-online.target") },
      { name: "daemon_exec", ok: updaterExecStart === "/usr/bin/codex-update-manager daemon" },
      { name: "restart_on_failure", ok: unitValue(updaterService, "Service", "Restart") === "on-failure" },
      { name: "restart_sec_10", ok: unitValue(updaterService, "Service", "RestartSec") === "10" },
      { name: "wanted_by_default", ok: valueHasToken(updaterWantedBy, "default.target") },
    ]),
    evaluateCheck("launcher_environment_and_update_probe", [
      { name: "systemd_environment_import", ok: runtimeSource.includes("systemctl --user import-environment") },
      { name: "dbus_activation_environment", ok: runtimeSource.includes("dbus-update-activation-environment --systemd") },
      { name: "start_or_enable_updater", ok: runtimeSource.includes("is-enabled codex-update-manager.service") && runtimeSource.includes("enable --now codex-update-manager.service") },
      { name: "oneshot_launch_check", ok: runtimeSource.includes("--unit=codex-update-manager-launch-check") && runtimeSource.includes("--collect") },
      { name: "stale_update_check", ok: runtimeSource.includes("codex-update-manager check-now --if-stale") },
      { name: "no_service_restart_on_launch", ok: !runtimeSource.includes("restart codex-update-manager.service") },
    ]),
    evaluateCheck("parity_service_status_gate", [
      { name: "skip_env", ok: parityFullSource.includes("CODEX_PARITY_SKIP_SERVICES") },
      { name: "app_active_check", ok: parityFullSource.includes('is-active "${PACKAGE_NAME}.service"') },
      { name: "updater_active_check", ok: parityFullSource.includes("is-active codex-update-manager.service") },
      { name: "app_enabled_check", ok: parityFullSource.includes('is-enabled "${PACKAGE_NAME}.service"') },
      { name: "updater_enabled_check", ok: parityFullSource.includes("is-enabled codex-update-manager.service") },
      { name: "inactive_fails", ok: parityFullSource.includes('fail "user services:') },
    ]),
    evaluateCheck("service_lifecycle_docs", [
      { name: "make_target_documented", ok: readmeSource.includes("make parity-services") },
      { name: "matrix_validation", ok: parityMatrixSource.includes("make parity-services") },
      { name: "no_live_suspend_claim", ok: parityMatrixSource.includes("live suspend/resume") },
    ]),
  ];

  const counts = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { pass: 0, fail: 0 },
  );

  return {
    status: counts.fail === 0 ? "pass" : "fail",
    counts,
    checks,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = runSmoke();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      console.log(
        `[service-lifecycle] ${check.status.toUpperCase()} ${check.name}: ${JSON.stringify({ missingCount: check.missing.length })}`,
      );
    }
    console.log(`[service-lifecycle] SUMMARY ${JSON.stringify(report.counts)}`);
  }
  if (report.status !== "pass") {
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseUnit,
  runSmoke,
};
