"use strict";

const fs = require("node:fs");

const NEW_WINDOW_PATCH = "feature:desktop-new-window:second-instance";

function hasNewWindow(reportPath) {
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    return report.enabledFeatures.includes("desktop-new-window") &&
      report.patches.some(({ name, status }) =>
        name === NEW_WINDOW_PATCH && (status === "applied" || status === "already-applied"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`[WARN] Could not read desktop action patch status from ${reportPath}: ${error.message}`);
    }
    return false;
  }
}

function renderDesktopActions(source, reportPath, withUpdater) {
  const excluded = new Set();
  if (!hasNewWindow(reportPath)) excluded.add("new-window");
  if (!withUpdater) {
    excluded.add("CheckForUpdates");
    excluded.add("InstallReadyUpdate");
  }

  const lines = [];
  let skipGroup = false;
  for (const line of source.trimEnd().split(/\r?\n/)) {
    if (line.startsWith("[")) {
      const action = /^\[Desktop Action ([^\]]+)\]$/.exec(line);
      skipGroup = action != null && excluded.has(action[1]);
    }
    if (skipGroup) continue;
    if (line.startsWith("Actions=")) {
      const actions = line.slice("Actions=".length).split(";").filter(id => id && !excluded.has(id));
      if (actions.length > 0) lines.push(`Actions=${actions.join(";")};`);
    } else {
      lines.push(line);
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}

const [reportPath, updater] = process.argv.slice(2);
process.stdout.write(renderDesktopActions(fs.readFileSync(0, "utf8"), reportPath, updater === "1"));
