#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const REPO_DIR = path.resolve(__dirname, "..");

function usage() {
  return [
    "Usage: browser-matrix-smoke.js [--json]",
    "",
    "Checks the committed Linux browser integration matrix without reading browser profiles.",
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

function evaluateCheck(name, source, markers) {
  const missing = markers.filter((marker) => !source.includes(marker));
  return {
    name,
    status: missing.length === 0 ? "pass" : "fail",
    missing,
  };
}

function runMatrix() {
  const patcher = read("scripts/lib/patch-chrome-plugin.js");
  const launcher = read("launcher/start.sh.template");
  const doctor = read("packaging/linux/codex-desktop-doctor.py");

  const checks = [
    evaluateCheck("google_chrome", `${patcher}\n${launcher}\n${doctor}`, [
      ".config/google-chrome/NativeMessagingHosts",
      "linuxChromeUserDataDirectory",
      '"google_chrome"',
    ]),
    evaluateCheck("brave_browser", `${patcher}\n${launcher}\n${doctor}`, [
      ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      "linuxBraveUserDataDirectory",
      '"brave_browser"',
      "Brave Browser",
    ]),
    evaluateCheck("chromium", `${patcher}\n${launcher}\n${doctor}`, [
      ".config/chromium/NativeMessagingHosts",
      "linuxChromiumUserDataDirectory",
      '"chromium"',
      "Chromium",
    ]),
    evaluateCheck("flatpak_chrome", `${patcher}\n${launcher}\n${doctor}`, [
      ".var/app/com.google.Chrome/config/google-chrome/NativeMessagingHosts",
      "linuxFlatpakChromeUserDataDirectory",
      '"flatpak_chrome"',
      "extension-host-flatpak-wrapper.sh",
      "flatpak-spawn --host",
      "codexLinuxShellQuote",
    ]),
    evaluateCheck("default_browser_profile_roots", `${patcher}\n${launcher}`, [
      "xdg-settings",
      "default-web-browser",
      "defaultLinuxUserDataDirectoryForCommand",
      "resolveChromeProfileDirectoryFromRunningProcess",
    ]),
    evaluateCheck("live_bridge_validation", `${doctor}\n${read("Makefile")}`, [
      "CODEX_DESKTOP_LIVE_BROWSER_BRIDGE_VALIDATION",
      "chrome_extension_host_binary",
      "chrome_native_host_bridge_loopback",
      "socketCreated",
      "clientPing",
      "chromeToClient",
      "clientToChrome",
    ]),
  ];

  const counts = checks.reduce(
    (acc, check) => {
      acc[check.status] += 1;
      return acc;
    },
    { fail: 0, pass: 0 },
  );

  return {
    ok: counts.fail === 0,
    counts,
    checks,
  };
}

function printText(summary) {
  console.log(
    `[browser-matrix] result=${summary.ok ? "pass" : "fail"} pass=${summary.counts.pass} fail=${summary.counts.fail}`,
  );
  for (const check of summary.checks) {
    console.log(
      `[browser-matrix] ${check.status.toUpperCase()} ${check.name}: ${JSON.stringify({ missingCount: check.missing.length })}`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = runMatrix();
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printText(summary);
  }
  if (!summary.ok) {
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
