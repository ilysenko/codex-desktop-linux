import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

export const DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS = 4_000;
export const MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS = 120_000;

export function parseInstalledSmokeWaitTimeoutMs(value) {
  if (value === undefined) return DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new RangeError(
      `--wait-timeout-ms must be an integer from 1 through ${MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS}`,
    );
  }
  const timeoutMs = Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs > MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `--wait-timeout-ms must be an integer from 1 through ${MAX_INSTALLED_SMOKE_WAIT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

export async function waitForInstalledSmokeCondition(
  predicate,
  message,
  {
    timeoutMs = DEFAULT_INSTALLED_SMOKE_WAIT_TIMEOUT_MS,
    retryDelayMs = 10,
    now = Date.now,
    sleep = delay,
    onDeadline = () => {},
  } = {},
) {
  const deadline = now() + timeoutMs;
  while (!predicate() && now() < deadline) await sleep(retryDelayMs);
  if (predicate()) return;

  // Report the semantic deadline synchronously. Cleanup may itself need to
  // join a stuck native operation, so an outer process timeout must not erase
  // the fact that the package smoke had already failed semantically.
  onDeadline(message, timeoutMs);
  assert.fail(message);
}

export async function releaseCallbackGateAndJoinDisposal(
  release,
  subscription,
) {
  // Harness callbacks may deliberately wait on a deferred gate. Release that
  // gate before disposal, then await the real disposal barrier. Never race or
  // detach disposal: its settlement proves callback admission and cleanup are
  // joined before the smoke can finish.
  release();
  await subscription?.dispose();
}

export async function recoverStableReplacement(
  subscription,
  {
    timeoutMs = 4_000,
    retryDelayMs = 10,
    now = Date.now,
    sleep = delay,
    deadlineSleep = delay,
    onDeadline = () => {},
  } = {},
) {
  const deadline = now() + timeoutMs;
  const deadlineController = new AbortController();
  const deadlineMessage = `root recovery did not settle within ${timeoutMs}ms`;
  const deadlineError = new Error(deadlineMessage);
  const deadlineReached = deadlineSleep(
    timeoutMs,
    undefined,
    { signal: deadlineController.signal },
  ).then(() => {
    throw deadlineError;
  });
  try {
    while (true) {
      const recovery = await Promise.race([
        Promise.resolve().then(() => subscription.recoverRoot({
          identityPolicy: "accept-replacement",
        })),
        deadlineReached,
      ]);
      if (
        recovery.attachment !== "not-attached" ||
        recovery.reason !== "identity-unstable"
      ) {
        return recovery;
      }
      if (now() >= deadline) {
        onDeadline(
          `root recovery remained identity-unstable for ${timeoutMs}ms`,
          timeoutMs,
        );
        return recovery;
      }
      await Promise.race([
        Promise.resolve().then(() => sleep(retryDelayMs)),
        deadlineReached,
      ]);
    }
  } catch (error) {
    if (error === deadlineError) onDeadline(deadlineMessage, timeoutMs);
    throw error;
  } finally {
    deadlineController.abort();
  }
}
