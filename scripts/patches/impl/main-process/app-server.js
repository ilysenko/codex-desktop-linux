"use strict";

const fs = require("node:fs");
const path = require("node:path");

const INITIALIZE_TIMEOUT_MARKER = "codexLinuxAppServerInitializeTimeoutMs";
const initializeTimeoutNeedle =
  /(scheduleInitializeTimeout\(\)\{[\s\S]{0,4000}?this\.initializeTimeoutTimer=setTimeout\(\(\)=>\{[\s\S]{0,4000}?\}\},)([A-Za-z_$][\w$]*)(\)\}clearInitializeTimeoutTimer\(\))/u;
const patchedInitializeTimeoutNeedle =
  /(scheduleInitializeTimeout\(\)\{[\s\S]{0,4000}?this\.initializeTimeoutTimer=setTimeout\(\(\)=>\{[\s\S]{0,4000}?\}\},)codexLinuxAppServerInitializeTimeoutMs\(([A-Za-z_$][\w$]*)\)(\)\}clearInitializeTimeoutTimer\(\))/u;

function applyLinuxAppServerInitializeTimeoutPatch(currentSource) {
  const hasHelper = currentSource.includes(
    `function ${INITIALIZE_TIMEOUT_MARKER}(`,
  );
  if (hasHelper && patchedInitializeTimeoutNeedle.test(currentSource)) {
    return currentSource;
  }

  if (!currentSource.includes("Initialize handshake still pending")) {
    return currentSource;
  }

  const timeoutMatch = currentSource.match(initializeTimeoutNeedle);
  if (timeoutMatch == null) {
    console.warn(
      "WARN: Could not find app-server initialize timeout — slow Linux profiles may fail during startup",
    );
    return currentSource;
  }

  const helper =
    "function codexLinuxAppServerInitializeTimeoutMs(e){return process.platform===`linux`&&e===3e4?3e5:e}";
  const patchedSource = currentSource.replace(
    initializeTimeoutNeedle,
    (_match, prefix, timeoutVariable, suffix) =>
      `${prefix}${INITIALIZE_TIMEOUT_MARKER}(${timeoutVariable})${suffix}`,
  );
  if (hasHelper) {
    return patchedSource;
  }

  const directive = '"use strict";';
  const helperInsertionIndex = currentSource.startsWith(directive)
    ? directive.length
    : 0;

  return (
    patchedSource.slice(0, helperInsertionIndex) +
    helper +
    patchedSource.slice(helperInsertionIndex)
  );
}

function patchLinuxAppServerInitializeTimeout(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    const reason = "Vite build directory not found";
    console.warn(
      `WARN: ${reason} — skipping Linux app-server initialize timeout patch`,
    );
    return { matched: 0, changed: 0, reason };
  }

  const candidates = fs
    .readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => {
      const filePath = path.join(buildDir, entry.name);
      return { filePath, source: fs.readFileSync(filePath, "utf8") };
    })
    .filter(
      ({ source }) =>
        source.includes("Initialize handshake still pending") ||
        source.includes(`function ${INITIALIZE_TIMEOUT_MARKER}(`),
    );

  if (candidates.length !== 1) {
    const reason =
      candidates.length === 0
        ? "app-server initialize timeout bundle not found"
        : `app-server initialize timeout bundle is ambiguous (${candidates.length} matches)`;
    console.warn(
      `WARN: ${reason} — skipping Linux app-server initialize timeout patch`,
    );
    return { matched: candidates.length, changed: 0, reason };
  }

  const [{ filePath, source }] = candidates;
  const patched = applyLinuxAppServerInitializeTimeoutPatch(source);
  if (patched === source) {
    return { matched: 1, changed: 0 };
  }

  fs.writeFileSync(filePath, patched, "utf8");
  return { matched: 1, changed: 1 };
}

module.exports = {
  applyLinuxAppServerInitializeTimeoutPatch,
  patchLinuxAppServerInitializeTimeout,
};
