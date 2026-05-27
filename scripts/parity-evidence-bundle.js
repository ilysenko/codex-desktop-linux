#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const REPO_DIR = path.resolve(__dirname, "..");
const PASS = "pass";
const WARN = "warn";
const FAIL = "fail";
const SKIP = "skip";
const PENDING = "pending";
const STATUSES = new Set([PASS, WARN, FAIL, SKIP, PENDING]);

function usage() {
  return [
    "Usage: parity-evidence-bundle.js [--json] [--strict] [--package-name NAME]",
    "                                 [--systemctl PATH]",
    "                                 [--computer-use-doctor PATH | --no-computer-use-doctor]",
    "                                 [--live-secret-service] [--require-secret-service-canary]",
    "",
    "Builds one redacted parity evidence summary from the local browser, service,",
    "desktop, and keyring probes. Raw command output, logs, paths, keys, browser",
    "state, and private app/session content are omitted.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    json: false,
    strict: process.env.CODEX_PARITY_EVIDENCE_STRICT === "1",
    packageName: process.env.PACKAGE_NAME || process.env.CODEX_DESKTOP_PACKAGE_NAME || "codex-desktop",
    systemctl: process.env.SYSTEMCTL || "systemctl",
    computerUseDoctor: process.env.CODEX_COMPUTER_USE_DOCTOR || "",
    noComputerUseDoctor: process.env.CODEX_PARITY_EVIDENCE_NO_COMPUTER_USE_DOCTOR === "1",
    liveSecretService: process.env.CODEX_PARITY_EVIDENCE_LIVE_SECRET_SERVICE === "1",
    requireSecretServiceCanary: process.env.CODEX_PARITY_EVIDENCE_REQUIRE_SECRET_SERVICE_CANARY === "1",
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
    } else if (arg === "--computer-use-doctor") {
      index += 1;
      options.computerUseDoctor = argv[index] || "";
      options.noComputerUseDoctor = false;
    } else if (arg === "--no-computer-use-doctor") {
      options.noComputerUseDoctor = true;
      options.computerUseDoctor = "";
    } else if (arg === "--live-secret-service") {
      options.liveSecretService = true;
    } else if (arg === "--require-secret-service-canary") {
      options.requireSecretServiceCanary = true;
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

function normalizeStatus(value, fallback = WARN) {
  const normalized = String(value || "").trim().toLowerCase();
  return STATUSES.has(normalized) ? normalized : fallback;
}

function strongestStatus(statuses) {
  const normalized = statuses.map((status) => normalizeStatus(status, SKIP));
  if (normalized.includes(FAIL)) {
    return FAIL;
  }
  if (normalized.includes(WARN)) {
    return WARN;
  }
  if (normalized.includes(PENDING)) {
    return PENDING;
  }
  if (normalized.includes(PASS)) {
    return PASS;
  }
  return SKIP;
}

function strictStatus(status, strict) {
  if (!strict) {
    return status;
  }
  return status === WARN || status === SKIP || status === PENDING ? FAIL : status;
}

function runJson(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_DIR,
    encoding: "utf8",
    timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, status: 127, data: null, issueKind: "command_failed" };
  }
  const stdout = String(result.stdout || "").trim();
  if (!stdout) {
    return { ok: false, status: result.status ?? 1, data: null, issueKind: "empty_output" };
  }
  try {
    const data = JSON.parse(stdout);
    return {
      ok: result.status === 0,
      status: result.status ?? 0,
      data,
      issueKind: result.status === 0 ? "none" : "command_failed",
    };
  } catch {
    return { ok: false, status: result.status ?? 1, data: null, issueKind: "invalid_json" };
  }
}

function failedComponent(issueKind) {
  return {
    status: FAIL,
    issueKind,
  };
}

function summarizeCounts(data) {
  const counts = data && typeof data.counts === "object" && data.counts !== null ? data.counts : {};
  return {
    passCount: Number.isInteger(counts.pass) ? counts.pass : 0,
    failCount: Number.isInteger(counts.fail) ? counts.fail : 0,
  };
}

function summarizeBrowserMatrix(result) {
  if (!result.data) {
    return failedComponent(result.issueKind);
  }
  const counts = summarizeCounts(result.data);
  return {
    status: result.data.ok === true && counts.failCount === 0 ? PASS : FAIL,
    ...counts,
  };
}

function summarizeServiceStatic(result) {
  if (!result.data) {
    return failedComponent(result.issueKind);
  }
  const counts = summarizeCounts(result.data);
  return {
    status: normalizeStatus(result.data.status, counts.failCount === 0 ? PASS : FAIL),
    ...counts,
  };
}

function summarizeServiceLive(result) {
  if (!result.data) {
    return failedComponent(result.issueKind);
  }
  const systemdUser = result.data.systemdUser && typeof result.data.systemdUser === "object" ? result.data.systemdUser : {};
  const appService = result.data.appService && typeof result.data.appService === "object" ? result.data.appService : null;
  const updaterService =
    result.data.updaterService && typeof result.data.updaterService === "object" ? result.data.updaterService : null;
  return {
    status: normalizeStatus(result.data.status, result.ok ? PASS : FAIL),
    systemdUserAvailable: systemdUser.available === true,
    systemdUserIssueKind: String(systemdUser.issueKind || "none"),
    appServiceStatus: appService ? normalizeStatus(appService.status) : SKIP,
    updaterServiceStatus: updaterService ? normalizeStatus(updaterService.status) : SKIP,
  };
}

function summarizeDesktopKeyring(result) {
  if (!result.data) {
    return failedComponent(result.issueKind);
  }
  const desktop = result.data.desktop && typeof result.data.desktop === "object" ? result.data.desktop : {};
  const secretService =
    result.data.secretService && typeof result.data.secretService === "object" ? result.data.secretService : {};
  const inputBackends =
    desktop.inputBackends && typeof desktop.inputBackends === "object" ? desktop.inputBackends : {};
  const desktopStatus = normalizeStatus(desktop.status, SKIP);
  const secretServiceStatus = normalizeStatus(secretService.status, SKIP);
  return {
    status: strongestStatus([desktopStatus, secretServiceStatus]),
    desktopStatus,
    desktopFamily: String(desktop.desktopFamily || "unknown"),
    sessionType: String(desktop.sessionType || "unknown"),
    windowBackend: String(desktop.windowBackend || "unknown"),
    exactFocusSupported: desktop.exactFocusSupported === true,
    screenshotPathAvailable: desktop.screenshotPathAvailable === true,
    inputBackends: {
      absPointer: inputBackends.absPointer === true,
      portal: inputBackends.portal === true,
      ydotool: inputBackends.ydotool === true,
    },
    blockerCount: Number.isInteger(desktop.blockerCount) ? desktop.blockerCount : 0,
    secretServiceStatus,
    secretServiceIssueKind: String(secretService.issueKind || "none"),
    secretToolAvailable: secretService.secretToolAvailable === true,
    canaryStatus: normalizeStatus(secretService.canaryStatus, PENDING),
    storeAttempted: secretService.storeAttempted === true,
    lookupMatched: secretService.lookupMatched === true,
    clearSucceeded: secretService.clearSucceeded === true,
  };
}

function buildReport(options) {
  const browserMatrix = summarizeBrowserMatrix(
    runJson(process.execPath, [path.join("scripts", "browser-matrix-smoke.js"), "--json"]),
  );
  const serviceStatic = summarizeServiceStatic(
    runJson(process.execPath, [path.join("scripts", "service-lifecycle-smoke.js"), "--json"]),
  );
  const serviceLiveArgs = [
    path.join("scripts", "service-lifecycle-live.js"),
    "--json",
    "--package-name",
    options.packageName,
    "--systemctl",
    options.systemctl,
  ];
  if (options.strict) {
    serviceLiveArgs.push("--strict");
  }
  const serviceLive = summarizeServiceLive(runJson(process.execPath, serviceLiveArgs));

  const liveMatrixArgs = [
    path.join("scripts", "live-validation-matrix.py"),
    "--json",
    "--package-name",
    options.packageName,
  ];
  if (options.liveSecretService) {
    liveMatrixArgs.push("--live");
  }
  if (options.requireSecretServiceCanary) {
    liveMatrixArgs.push("--require-canary");
  }
  if (options.noComputerUseDoctor) {
    liveMatrixArgs.push("--no-computer-use-doctor");
  } else if (options.computerUseDoctor) {
    liveMatrixArgs.push("--computer-use-doctor", options.computerUseDoctor);
  }
  const desktopKeyring = summarizeDesktopKeyring(runJson(process.env.PYTHON || "python3", liveMatrixArgs));

  const componentStatuses = [
    browserMatrix.status,
    serviceStatic.status,
    serviceLive.status,
    desktopKeyring.status,
  ];
  const rawStatus = strongestStatus(componentStatuses);
  const status = strictStatus(rawStatus, options.strict);
  return {
    ok: status !== FAIL,
    date: new Date().toISOString().slice(0, 10),
    status,
    strict: options.strict,
    liveSecretServiceCanary: options.liveSecretService,
    components: {
      browserMatrix,
      serviceStatic,
      serviceLive,
      desktopKeyring,
    },
    notes:
      "Redacted parity evidence bundle; raw command output, paths, logs, keys, browser state, and private app/session content omitted.",
  };
}

function printText(report) {
  const components = report.components;
  console.log("Parity evidence bundle (redacted)");
  console.log(`Overall: status=${report.status} ok=${String(report.ok)} strict=${String(report.strict)}`);
  console.log(
    `Browser matrix: status=${components.browserMatrix.status} pass=${components.browserMatrix.passCount ?? 0} fail=${components.browserMatrix.failCount ?? 0}`,
  );
  console.log(
    `Service markers: status=${components.serviceStatic.status} pass=${components.serviceStatic.passCount ?? 0} fail=${components.serviceStatic.failCount ?? 0}`,
  );
  console.log(
    `Live services: status=${components.serviceLive.status} systemdUser=${String(components.serviceLive.systemdUserAvailable)} app=${components.serviceLive.appServiceStatus} updater=${components.serviceLive.updaterServiceStatus}`,
  );
  console.log(
    `Desktop/keyring: status=${components.desktopKeyring.status} desktop=${components.desktopKeyring.desktopStatus} secret=${components.desktopKeyring.secretServiceStatus} canary=${components.desktopKeyring.canaryStatus} issue=${components.desktopKeyring.secretServiceIssueKind}`,
  );
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
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  buildReport,
  normalizeStatus,
  strongestStatus,
};
