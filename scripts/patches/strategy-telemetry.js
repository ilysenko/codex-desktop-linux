"use strict";

// Match-strategy telemetry: patch implementations call recordStrategy() to
// note which needle/regex generation matched (or that none did); the engine
// drains the buffer after each descriptor.apply into the patch report entry
// as `strategies: [{group, strategy}]`. This is how dead legacy needles are
// detected against a fresh DMG before being pruned.
//
// Deliberately NOT console.warn-based: captureWarnings counts every warning
// against the patch status (see patchStatusFromChange), so warn-driven
// telemetry would flip statuses.
//
// Strategy naming convention:
//   "upstream" / "upstream-<variant>"  — matched the current upstream shape
//   "already-applied"                  — recognized this patcher's own output
//   "legacy:<generation>"              — a fallback for an older shape fired
//   "none"                             — no strategy matched (drift)

let buffer = [];

function recordStrategy(group, strategy) {
  buffer.push({ group: String(group), strategy: String(strategy) });
}

function drainStrategies() {
  if (buffer.length === 0) {
    return [];
  }
  const drained = buffer;
  buffer = [];
  const seen = new Set();
  return drained.filter((entry) => {
    const key = `${entry.group}\u0000${entry.strategy}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

module.exports = { drainStrategies, recordStrategy };
