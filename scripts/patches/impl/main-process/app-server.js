"use strict";

const INITIALIZE_TIMEOUT_MARKER = "codexLinuxAppServerInitializeTimeoutMs";
const initializeTimeoutNeedle =
  /(scheduleInitializeTimeout\(\)\{[\s\S]{0,4000}?this\.initializeTimeoutTimer=setTimeout\(\(\)=>\{[\s\S]{0,4000}?\}\},)([A-Za-z_$][\w$]*)(\)\}clearInitializeTimeoutTimer\(\))/u;

function applyLinuxAppServerInitializeTimeoutPatch(currentSource) {
  if (currentSource.includes(`function ${INITIALIZE_TIMEOUT_MARKER}(`)) {
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
  const directive = '"use strict";';
  const helperInsertionIndex = currentSource.startsWith(directive)
    ? directive.length
    : 0;
  const patchedSource = currentSource.replace(
    initializeTimeoutNeedle,
    (_match, prefix, timeoutVariable, suffix) =>
      `${prefix}${INITIALIZE_TIMEOUT_MARKER}(${timeoutVariable})${suffix}`,
  );

  return (
    patchedSource.slice(0, helperInsertionIndex) +
    helper +
    patchedSource.slice(helperInsertionIndex)
  );
}

module.exports = {
  applyLinuxAppServerInitializeTimeoutPatch,
};
