"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HELPER_NAME = "codexLinuxStartDirectoryOnlyWorkingTreeWatch";
const DEFAULT_MAX_WATCHES = 8192;
const DEFAULT_IGNORED_DIRECTORY_NAMES = [];
const LOCAL_FILE_WATCH_METHOD =
  /async startFileWatch\((?<options>[A-Za-z_$][\w$]*)\)\{(?=let [^{}]{0,180}?await this\.platformPath\(\),[^{}]{0,180}?\(0,[A-Za-z_$][\w$]*\.watch\)\(this\.getFileSystemPath\(\k<options>\.path\),\{recursive:\k<options>\.recursive\})/gu;

function codexLinuxStartDirectoryOnlyWorkingTreeWatch(host, options, configuration) {
  return (async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const childProcess = require("node:child_process");
    const GIT_QUERY_TIMEOUT_MS = 5000;
    const FAIR_RESERVATION_CHUNK = 256;
    const MAX_TRACKED_ASYNC_WATCH_FAILURES = 1024;
    const MAX_PENDING_DIRECTORY_SYNCS = 256;
    const RETRY_INITIAL_MS = 1000;
    const RETRY_MAX_MS = 30_000;
    const WATCH_ADDED = "added";
    const WATCH_BUDGET_EXHAUSTED = "budget-exhausted";
    const WATCH_ERROR = "watch-error";
    const WATCH_EXISTING = "existing";
    const WATCH_RETRY_PENDING = "retry-pending";
    const WATCH_RETRY_REQUIRED = "retry-required";
    const WATCH_RETRY_AFTER_RELEASE = "retry-after-release";
    const WATCH_SKIPPED = "skipped";
    const root = path.resolve(host.getFileSystemPath(options.path));
    const logicalPath = await host.platformPath();
    const ignoredNames = new Set(configuration.ignoredDirectoryNames);
    const budgetOwner = Symbol("directory-watch-budget-owner");
    const watchers = new Map();
    const refreshWatchers = new Map();
    const asynchronousWatchFailures = new Map();
    const asynchronousRefreshWatchFailures = new Map();
    const asynchronousWatchResourceFailures = new Map();
    const refreshTargetPaths = new Map();
    const refreshTargets = new Map();
    const lifecycleAbortController = new AbortController();
    let disposed = false;
    let directorySyncHandle = null;
    let directorySyncFlushCount = 0;
    let directorySyncNeedsFullInvalidation = false;
    let directorySyncNeedsRefreshInvalidation = false;
    let directorySyncNeedsFullReconcile = false;
    let directorySyncWorkPending = false;
    let refreshRetryTimer = null;
    let refreshRetryDelayMs = RETRY_INITIAL_MS;
    let refreshTargetsNeedRetry = false;
    let refreshTargetMappingInvalidated = false;
    let refreshWatchesNeedRetry = false;
    let rootWatchInvalidated = false;
    let rootMetadataRetryAttempts = 0;
    let rootMetadataRetryDelayMs = RETRY_INITIAL_MS;
    let rootMetadataRetryNeedsGit = false;
    let rootMetadataRetryRequiresRestart = false;
    let rootMetadataRetryTimer = null;
    let topologyRefreshTimer = null;
    let topologyRefreshNeedsGit = false;
    let topologyRefreshWorkPending = false;
    let topologyRefreshRerunRequested = false;
    let topologyWorkActive = false;
    let topologyWorkTail = Promise.resolve();
    let budgetCoveragePartial = false;
    let budgetRecoveryWorkPending = false;
    let watchResourceFailureGeneration = 0;
    let watchResourceRetryDelayMs = RETRY_INITIAL_MS;
    let watchResourceRetryProbeAllowance = 0;
    let watchResourceRetryProbeFailed = false;
    let watchResourceRetryTimer = null;
    let watchResourceRetryWorkPending = false;
    let gitIgnoresNeedRetry = false;
    const pendingDirectorySyncs = new Set();
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    function isWithin(candidate, parent) {
      const relative = path.relative(parent, candidate);
      return relative === "" || (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    }

    function hasAncestorInSet(candidate, directories) {
      if (!isWithin(candidate, root)) return false;
      let current = candidate;
      while (true) {
        if (directories.has(current)) return true;
        if (current === root) return false;
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    }

    function kernelBudget() {
      let kernelLimit = null;
      try {
        kernelLimit = Number.parseInt(
          fs.readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim(),
          10,
        );
      } catch {}
      const requested = configuration.maxWatches;
      return Number.isFinite(kernelLimit) && kernelLimit > 0
        ? Math.max(1, Math.min(requested, Math.floor(kernelLimit / 8)))
        : requested;
    }

    const budgetKey = Symbol.for("codex-linux.directory-only-working-tree-watch.budget");
    const requestedLimit = kernelBudget();
    const budget = globalThis[budgetKey] ??= {
      active: 0,
      limit: requestedLimit,
      listeners: new Set(),
      listenerOwners: new Map(),
      partialListeners: new Set(),
      fillCursor: 0,
      reservations: new Map(),
      reserved: 0,
      recoveringOwners: new Set(),
      suspendedOwners: new Set(),
      notificationQueued: false,
      notificationOwners: new Set(),
      genericNotificationQueued: false,
      wakeNotificationOwners: new Set(),
      genericWakeNotificationQueued: false,
    };
    budget.listeners ??= new Set();
    budget.listenerOwners ??= new Map();
    budget.partialListeners ??= new Set();
    budget.fillCursor ??= 0;
    budget.reservations ??= new Map();
    budget.reserved ??= 0;
    budget.recoveringOwners ??= new Set();
    budget.suspendedOwners ??= new Set();
    budget.notificationQueued ??= false;
    budget.notificationOwners ??= new Set();
    budget.genericNotificationQueued ??= false;
    budget.wakeNotificationOwners ??= new Set();
    budget.genericWakeNotificationQueued ??= false;
    budget.watchLimitErrorLogged ??= false;
    budget.limit = Math.min(budget.limit, requestedLimit);

    function markBudgetCoveragePartial() {
      budget.partialListeners.add(recoverWatchCoverageIfPossible);
      if (budgetCoveragePartial) return;
      budgetCoveragePartial = true;
      console.warn(
        `WARN: directory-only working-tree watch budget reached ` +
        `(active=${budget.active}, limit=${budget.limit}); coverage is partial for ${root}. ` +
        `Codex focus recovery remains active, and watch coverage will expand when capacity is released.`,
      );
      if (budget.active + budget.reserved < budget.limit) {
        // Another partial owner may have retained and then released an
        // unproductive reservation. A workspace that becomes newly partial
        // must wake the coordinator so idle headroom is redistributed instead
        // of remaining stranded behind the suspended owner.
        notifyBudgetListeners(budgetOwner);
      }
      // TODO(default/core rollout): if a root remains completely unwatched, surface one
      // actionable in-app notice with an Open Logs/troubleshooting action. Ordinary partial
      // coverage should remain log-only because focus recovery is intentionally retained.
    }

    function markBudgetCoverageRecovered() {
      if (!budgetCoveragePartial) return;
      budgetCoveragePartial = false;
      budget.partialListeners.delete(recoverWatchCoverageIfPossible);
      budget.suspendedOwners.delete(budgetOwner);
      console.info(
        `INFO: directory-only working-tree watch coverage recovered for ${root} ` +
        `(active=${budget.active}, limit=${budget.limit}).`,
      );
    }

    function isWatchResourceError(error) {
      return ["ENOSPC", "EMFILE", "ENFILE", "ENOMEM"].includes(error?.code);
    }

    function isTransientDirectoryReadError(error) {
      return ["EINTR", "EIO", "ENOENT", "ESTALE"].includes(error?.code);
    }

    function reportWatchLimitError(error) {
      if (!isWatchResourceError(error)) return false;
      if (budget.watchLimitErrorLogged) return true;
      budget.watchLimitErrorLogged = true;
      console.error(
        `ERROR: directory-only working-tree watch hit the operating-system watch resource ` +
        `limit (${error.code}); file-change coverage may be incomplete.`,
      );
      // TODO(default/core rollout): promote this unexpected OS-limit failure to a
      // deduplicated in-app notification. Unlike the configured budget, it means the
      // reserved headroom was unavailable and merits an actionable user warning.
      return true;
    }

    function asynchronousWatchFailureIsExhausted(kind, directory, identity) {
      const key = `${kind}\0${directory}`;
      const previous = asynchronousWatchFailures.get(key);
      const attempts = previous?.identity === identity ? previous.attempts + 1 : 1;
      rememberAsynchronousWatchFailure(
        asynchronousWatchFailures,
        key,
        { attempts, identity },
      );
      return attempts >= 3;
    }

    function rememberAsynchronousWatchFailure(failures, key, value) {
      if (failures.has(key)) {
        failures.delete(key);
      } else if (failures.size >= MAX_TRACKED_ASYNC_WATCH_FAILURES) {
        failures.delete(failures.keys().next().value);
      }
      failures.set(key, value);
    }

    function noteAsynchronousWatchResourceFailure(kind, directory, identity) {
      const key = `${kind}\0${directory}`;
      const previous = asynchronousWatchResourceFailures.get(key);
      const attempts = previous?.identity === identity ? previous.attempts + 1 : 1;
      rememberAsynchronousWatchFailure(
        asynchronousWatchResourceFailures,
        key,
        { attempts, identity },
      );
      const minimumDelay = Math.min(
        RETRY_INITIAL_MS * (2 ** (attempts - 1)),
        RETRY_MAX_MS,
      );
      const previousDelay = watchResourceRetryDelayMs;
      watchResourceRetryDelayMs = Math.max(watchResourceRetryDelayMs, minimumDelay);
      if (watchResourceRetryDelayMs > previousDelay && watchResourceRetryTimer != null) {
        clearTimeout(watchResourceRetryTimer);
        watchResourceRetryTimer = null;
      }
    }

    function noteAsynchronousRefreshWatchFailure(directory, identity) {
      const previous = asynchronousRefreshWatchFailures.get(directory);
      const attempts = previous?.identity === identity ? previous.attempts + 1 : 1;
      rememberAsynchronousWatchFailure(
        asynchronousRefreshWatchFailures,
        directory,
        { attempts, identity },
      );
      const minimumDelay = Math.min(
        RETRY_INITIAL_MS * (2 ** (attempts - 1)),
        RETRY_MAX_MS,
      );
      const previousDelay = refreshRetryDelayMs;
      refreshRetryDelayMs = Math.max(refreshRetryDelayMs, minimumDelay);
      if (refreshRetryDelayMs > previousDelay && refreshRetryTimer != null) {
        clearTimeout(refreshRetryTimer);
        refreshRetryTimer = null;
      }
    }

    function resetAsynchronousRefreshWatchFailure(directory) {
      asynchronousRefreshWatchFailures.delete(directory);
    }

    function resetAsynchronousWatchResourceFailure(kind, directory) {
      asynchronousWatchResourceFailures.delete(`${kind}\0${directory}`);
    }

    function resetWatchResourceRetry(expectedGeneration) {
      if (watchResourceFailureGeneration !== expectedGeneration) return;
      if (watchResourceRetryTimer != null) clearTimeout(watchResourceRetryTimer);
      watchResourceRetryTimer = null;
      watchResourceRetryDelayMs = RETRY_INITIAL_MS;
    }

    function scheduleWatchResourceRetry() {
      if (
        disposed ||
        watchResourceRetryTimer != null ||
        watchResourceRetryWorkPending
      ) {
        return;
      }
      const retryDelay = watchResourceRetryDelayMs;
      watchResourceRetryTimer = setTimeout(() => {
        watchResourceRetryTimer = null;
        if (disposed) return;
        if (rootMetadataRetryTimer != null) {
          // Root identity backoff owns topology recovery while it is armed.
          // Keep the resource retry pending without probing the root early.
          scheduleWatchResourceRetry();
          return;
        }
        watchResourceRetryWorkPending = true;
        watchResourceRetryProbeAllowance = 1;
        watchResourceRetryProbeFailed = false;
        enqueueTopologyWork(async () => {
          const attemptGeneration = watchResourceFailureGeneration;
          let scanResult;
          try {
            if (rootMetadataRetryTimer == null) {
              const retryGitMetadata = refreshRetryTimer == null;
              scanResult = await reconcileTopology(retryGitMetadata, retryGitMetadata);
            }
          } finally {
            watchResourceRetryProbeAllowance = 0;
            watchResourceRetryWorkPending = false;
            if (disposed) return;
            if (watchResourceFailureGeneration !== attemptGeneration) {
              watchResourceRetryDelayMs = Math.max(
                watchResourceRetryDelayMs,
                Math.min(retryDelay * 2, RETRY_MAX_MS),
              );
              scheduleWatchResourceRetry();
              return;
            }
            if (watchResourceRetryProbeFailed) {
              watchResourceRetryDelayMs = Math.max(
                watchResourceRetryDelayMs,
                Math.min(retryDelay * 2, RETRY_MAX_MS),
              );
              scheduleWatchResourceRetry();
              return;
            }
            if (scanResult?.metadataUnavailable || scanResult?.topologyRetryNeeded) {
              resetWatchResourceRetry(attemptGeneration);
              rootMetadataRetryDelayMs = Math.max(
                rootMetadataRetryDelayMs,
                Math.min(retryDelay * 2, RETRY_MAX_MS),
              );
              scheduleRootMetadataRetry(configuration.honorGitIgnore, true);
              return;
            }
            const refreshCoverageComplete = refreshRetryTimer != null || (
              !refreshTargetsNeedRetry &&
              !gitIgnoresNeedRetry &&
              [...refreshTargets.keys()].every((directory) =>
                refreshWatchers.has(directory),
              )
            );
            if (scanResult?.coverageComplete === true && refreshCoverageComplete) {
              resetWatchResourceRetry(attemptGeneration);
              return;
            }
            if (budgetCoveragePartial) {
              // A configured-budget deferral is now owned by the fair
              // coordinator. Do not poll or wake unrelated retry domains.
              resetWatchResourceRetry(attemptGeneration);
              budget.suspendedOwners.delete(budgetOwner);
              notifyBudgetListeners(budgetOwner, false);
              return;
            }
            // No resource probe was possible (for example, root metadata
            // backoff became armed while this work was queued). Retain the
            // same delay because no operating-system resource attempt failed.
            scheduleWatchResourceRetry();
          }
        });
      }, retryDelay);
      watchResourceRetryTimer.unref?.();
    }

    function noteWatchResourceFailure(error) {
      const isResourceError = isWatchResourceError(error);
      reportWatchLimitError(error);
      if (!isResourceError || disposed) return false;
      if (watchResourceRetryWorkPending) watchResourceRetryProbeFailed = true;
      watchResourceFailureGeneration += 1;
      scheduleWatchResourceRetry();
      return true;
    }

    function resetRootMetadataRetry() {
      if (rootMetadataRetryTimer != null) clearTimeout(rootMetadataRetryTimer);
      rootMetadataRetryTimer = null;
      rootMetadataRetryAttempts = 0;
      rootMetadataRetryDelayMs = RETRY_INITIAL_MS;
      rootMetadataRetryNeedsGit = false;
      rootMetadataRetryRequiresRestart = false;
    }

    function scheduleRootMetadataRetry(reloadGitIgnores, requiresRestart = false) {
      rootMetadataRetryNeedsGit ||= reloadGitIgnores;
      rootMetadataRetryRequiresRestart ||= requiresRestart;
      if (disposed || rootMetadataRetryTimer != null) {
        return;
      }
      if (rootMetadataRetryAttempts >= 2) {
        // Persistent incomplete coverage may leave stale or missing watches.
        // Hand it back to Codex's existing watcher retry path after the two
        // bounded in-feature recovery attempts.
        if (rootMetadataRetryRequiresRestart || !watchers.has(root)) {
          finish({
            reason: "watch-error",
            error: new Error(
              `Could not restore complete working-tree watch coverage: ${options.path}`,
            ),
          });
        }
        return;
      }
      const retryDelay = rootMetadataRetryDelayMs;
      rootMetadataRetryTimer = setTimeout(() => {
        rootMetadataRetryTimer = null;
        if (disposed) return;
        rootMetadataRetryAttempts += 1;
        rootMetadataRetryDelayMs = Math.min(retryDelay * 2, RETRY_MAX_MS);
        const shouldReloadGitIgnores = rootMetadataRetryNeedsGit;
        rootMetadataRetryNeedsGit = false;
        enqueueTopologyWork(async () => {
          const retryOtherDomains =
            watchResourceRetryTimer == null && !watchResourceRetryWorkPending;
          const retryGitMetadata = retryOtherDomains && refreshRetryTimer == null;
          await reconcileTopology(
            shouldReloadGitIgnores && retryGitMetadata,
            retryGitMetadata,
          );
          if (
            !disposed &&
            rootMetadataRetryTimer == null &&
            !refreshTargetsNeedRetry &&
            !gitIgnoresNeedRetry &&
            !refreshWatchesNeedRetry &&
            watchResourceRetryTimer == null &&
            !watchResourceRetryWorkPending &&
            budgetCoveragePartial &&
            budget.active + budget.reserved < budget.limit
          ) {
            budget.suspendedOwners.delete(budgetOwner);
            notifyBudgetListeners(budgetOwner, false);
          }
        });
      }, retryDelay);
      rootMetadataRetryTimer.unref?.();
    }

    function updateRootMetadataRetry(result, reloadGitIgnores) {
      if (disposed || result == null) return;
      if (result.metadataUnavailable || result.topologyRetryNeeded) {
        if (watchResourceRetryWorkPending) return;
        scheduleRootMetadataRetry(reloadGitIgnores, true);
      } else {
        resetRootMetadataRetry();
      }
    }

    function reservationCount(owner = budgetOwner) {
      return budget.reservations.get(owner) ?? 0;
    }

    function releaseReservations(owner = budgetOwner, notify = true) {
      const count = reservationCount(owner);
      if (count === 0) return;
      budget.reservations.delete(owner);
      budget.reserved = Math.max(0, budget.reserved - count);
      if (notify) notifyBudgetListeners(owner, false);
    }

    function reserveCapacity(owner, count) {
      if (count <= 0) return;
      budget.reservations.set(owner, reservationCount(owner) + count);
      budget.reserved += count;
    }

    function notifyBudgetListeners(owner = null, wakeSuspended = true) {
      if (owner == null) {
        budget.genericNotificationQueued = true;
        if (wakeSuspended) budget.genericWakeNotificationQueued = true;
      } else {
        budget.notificationOwners.add(owner);
        if (wakeSuspended) budget.wakeNotificationOwners.add(owner);
      }
      if (budget.notificationQueued) return;
      budget.notificationQueued = true;
      queueMicrotask(() => {
        budget.notificationQueued = false;
        const owners = new Set(budget.notificationOwners);
        const genericNotification = budget.genericNotificationQueued;
        const wakeOwners = new Set(budget.wakeNotificationOwners);
        const genericWakeNotification = budget.genericWakeNotificationQueued;
        budget.notificationOwners.clear();
        budget.genericNotificationQueued = false;
        budget.wakeNotificationOwners.clear();
        budget.genericWakeNotificationQueued = false;
        for (const suspendedOwner of [...budget.suspendedOwners]) {
          if (
            genericWakeNotification ||
            [...wakeOwners].some((wakeOwner) => wakeOwner !== suspendedOwner)
          ) {
            budget.suspendedOwners.delete(suspendedOwner);
          }
        }
        const listeners = [...budget.listeners];
        for (const listener of listeners) {
          const listenerOwner = budget.listenerOwners.get(listener);
          if (
            listenerOwner != null &&
            budget.suspendedOwners.has(listenerOwner)
          ) {
            continue;
          }
          listener(true, owners, genericNotification);
        }

        const partialListeners = listeners.filter((listener) => {
          const listenerOwner = budget.listenerOwners.get(listener);
          return (
            budget.partialListeners.has(listener) &&
            listenerOwner != null &&
            !budget.recoveringOwners.has(listenerOwner) &&
            !budget.suspendedOwners.has(listenerOwner)
          );
        });
        // Reservations held by an in-flight recovery are its current
        // generation. Preserve them until that recovery settles, but exclude
        // the owner above from receiving any newly released capacity. This
        // keeps self-released inode-retry slots distinguishable from capacity
        // that becomes available for the next generation.
        for (const [reservationOwner, count] of [...budget.reservations]) {
          if (budget.recoveringOwners.has(reservationOwner)) continue;
          budget.reservations.delete(reservationOwner);
          budget.reserved = Math.max(0, budget.reserved - count);
        }
        let reservableCapacity = Math.max(
          0,
          budget.limit - budget.active - budget.reserved,
        );
        if (partialListeners.length === 0 || reservableCapacity === 0) return;
        const fillStart = budget.fillCursor % partialListeners.length;
        const rotatedFillListeners = [
          ...partialListeners.slice(fillStart),
          ...partialListeners.slice(0, fillStart),
        ];
        budget.fillCursor = (fillStart + 1) % partialListeners.length;
        const fillListeners = [
          ...rotatedFillListeners.filter(
            (listener) => !owners.has(budget.listenerOwners.get(listener)),
          ),
          ...rotatedFillListeners.filter(
            (listener) => owners.has(budget.listenerOwners.get(listener)),
          ),
        ];
        const reservationLimit = Math.min(
          FAIR_RESERVATION_CHUNK,
          Math.ceil(reservableCapacity / fillListeners.length),
        );
        const selectedListeners = new Set();
        let allocationProgress = true;
        while (reservableCapacity > 0 && allocationProgress) {
          allocationProgress = false;
          for (const listener of fillListeners) {
            if (reservableCapacity <= 0) break;
            const listenerOwner = budget.listenerOwners.get(listener);
            if (reservationCount(listenerOwner) >= reservationLimit) continue;
            reserveCapacity(listenerOwner, 1);
            selectedListeners.add(listener);
            reservableCapacity -= 1;
            allocationProgress = true;
          }
        }
        for (const listener of selectedListeners) {
          const listenerOwner = budget.listenerOwners.get(listener);
          let recovery;
          try {
            recovery = listener(false, owners, genericNotification);
          } catch {
            releaseReservations(listenerOwner);
            continue;
          }
          if (recovery == null) {
            // This owner is temporarily ineligible (for example, a root
            // metadata or watch-resource retry is already armed). Keep it out
            // of virtual reallocation passes and immediately offer its unused
            // reservation to other partial owners. The real retry/topology
            // notification will wake it later.
            if (
              budget.listenerOwners.get(listener) === listenerOwner &&
              budget.partialListeners.has(listener)
            ) {
              budget.suspendedOwners.add(listenerOwner);
            }
            releaseReservations(listenerOwner);
            continue;
          }
          if (recovery === false) {
            releaseReservations(listenerOwner);
            continue;
          }
          // The listener owns its recovery lifetime and releases exactly the
          // reservation generation it consumed. Only observe rejection here;
          // a second coordinator-side release could race with the next
          // allocation pass and revoke that newer reservation.
          Promise.resolve(recovery).catch(() => {});
        }
      });
    }

    function isRetryableGitError(error) {
      return (
        ["ETIMEDOUT", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM"].includes(error?.code) ||
        (error?.killed === true && error?.signal === "SIGKILL")
      );
    }

    async function waitForFsOperation(operation) {
      if (lifecycleAbortController.signal.aborted) return { disposed: true };
      let onAbort;
      const aborted = new Promise((resolve) => {
        onAbort = () => resolve({ disposed: true });
        lifecycleAbortController.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([
          Promise.resolve(operation).then(
            (value) => ({ value }),
            (error) => ({ error }),
          ),
          aborted,
        ]);
      } finally {
        lifecycleAbortController.signal.removeEventListener("abort", onAbort);
      }
    }

    async function gitResult(args) {
      if (!configuration.honorGitIgnore) return null;
      if (disposed || lifecycleAbortController.signal.aborted) return null;
      return new Promise((resolve) => {
        try {
          childProcess.execFile("git", [
            "-c",
            "core.fsmonitor=false",
            "-C",
            root,
            ...args,
          ], {
            encoding: "utf8",
            killSignal: "SIGKILL",
            maxBuffer: 64 * 1024 * 1024,
            signal: lifecycleAbortController.signal,
            timeout: GIT_QUERY_TIMEOUT_MS,
            windowsHide: true,
          }, (error, stdout) => {
            resolve({
              error,
              retryable: isRetryableGitError(error),
              status: error == null ? 0 : (Number.isInteger(error.code) ? error.code : null),
              stdout: typeof stdout === "string" ? stdout : "",
            });
          });
        } catch (error) {
          resolve({ error, retryable: isRetryableGitError(error), status: null, stdout: "" });
        }
      });
    }

    async function loadGitIgnoredRoots() {
      const ignored = new Set([path.join(root, ".git")]);
      gitIgnoresNeedRetry = false;
      const result = await gitResult([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ]);
      if (result?.status !== 0 || typeof result.stdout !== "string") {
        gitIgnoresNeedRetry = result?.retryable === true || (
          Number.isInteger(result?.status) && gitEntryExists()
        );
        return ignored;
      }
      const relativeCandidates = result.stdout
        .split("\0")
        .filter((relative) => relative.endsWith("/"));
      if (relativeCandidates.length === 0) return ignored;
      const checkedCandidates = new Set();
      let chunk = [];
      let chunkBytes = 0;
      async function checkChunk() {
        if (chunk.length === 0) return true;
        const checkResult = await gitResult([
          "-c",
          "core.quotePath=false",
          "check-ignore",
          "--",
          ...chunk,
        ]);
        if (
          (checkResult?.status !== 0 && checkResult?.status !== 1) ||
          typeof checkResult.stdout !== "string"
        ) {
          gitIgnoresNeedRetry = checkResult?.retryable === true || (
            Number.isInteger(checkResult?.status) && gitEntryExists()
          );
          return false;
        }
        for (const relative of checkResult.stdout.split(/\r?\n/u)) {
          if (relative.length > 0) checkedCandidates.add(relative);
        }
        chunk = [];
        chunkBytes = 0;
        return true;
      }
      for (const relative of relativeCandidates) {
        if (/[\u0000-\u001f\u007f"\\]/u.test(relative)) continue;
        const relativeBytes = Buffer.byteLength(relative) + 1;
        if (
          chunk.length > 0 &&
          chunkBytes + relativeBytes > 64 * 1024 &&
          !await checkChunk()
        ) {
          return ignored;
        }
        chunk.push(relative);
        chunkBytes += relativeBytes;
      }
      if (!await checkChunk()) return ignored;
      const candidates = relativeCandidates
        .filter((relative) => checkedCandidates.has(relative))
        .map((relative) => path.resolve(root, ...relative.slice(0, -1).split("/")))
        .filter((candidate) => candidate !== root && isWithin(candidate, root))
        .sort((left, right) => left.length - right.length);
      for (const candidate of candidates) {
        if (!hasAncestorInSet(candidate, ignored)) ignored.add(candidate);
      }
      return ignored;
    }

    let gitIgnoredRoots = new Set([path.join(root, ".git")]);

    function isIgnoredDirectory(directory) {
      if (directory === root) return false;
      if (path.basename(directory) === ".git") return true;
      if (ignoredNames.has(path.basename(directory))) return true;
      return hasAncestorInSet(directory, gitIgnoredRoots);
    }

    function gitEntryExists() {
      try {
        fs.lstatSync(path.join(root, ".git"));
        return true;
      } catch {
        return false;
      }
    }

    function directoryMetadataState(directory) {
      // TODO(default/core rollout): benchmark these small identity probes on remote
      // filesystems and move them off the event loop if their tail latency is material.
      try {
        const metadata = directory === root ? fs.statSync(directory) : fs.lstatSync(directory);
        if (!metadata.isDirectory() || (directory !== root && metadata.isSymbolicLink())) {
          return { absent: true, metadata: null };
        }
        return { absent: false, metadata };
      } catch (error) {
        return {
          absent: error?.code === "ENOENT" || error?.code === "ENOTDIR",
          metadata: null,
        };
      }
    }

    function directoryMetadata(directory) {
      return directoryMetadataState(directory).metadata;
    }

    function metadataIdentity(metadata) {
      return `${metadata.dev}:${metadata.ino}`;
    }

    function validateWatchedAncestors(directory) {
      if (directory === root) return { valid: true, metadataUnavailable: false };
      let ancestor = path.dirname(directory);
      while (isWithin(ancestor, root)) {
        const entry = watchers.get(ancestor);
        if (entry == null) {
          return { valid: false, metadataUnavailable: false, ancestor };
        }
        const state = directoryMetadataState(ancestor);
        if (state.metadata == null) {
          return {
            valid: false,
            metadataUnavailable: !state.absent,
            rootMetadataUnavailable: ancestor === root && !state.absent,
            ancestor,
          };
        }
        if (
          metadataIdentity(state.metadata) !== entry.identity ||
          (ancestor !== root && isIgnoredDirectory(ancestor))
        ) {
          return { valid: false, metadataUnavailable: false, ancestor };
        }
        if (ancestor === root) return { valid: true, metadataUnavailable: false };
        const parent = path.dirname(ancestor);
        if (parent === ancestor) break;
        ancestor = parent;
      }
      return { valid: false, metadataUnavailable: false, ancestor: root };
    }

    function refreshDirectoryIdentity(directory) {
      try {
        const metadata = fs.statSync(directory);
        return metadata.isDirectory() ? metadataIdentity(metadata) : null;
      } catch {
        return null;
      }
    }

    function releaseWatchCapacity(retainForCurrentWork) {
      budget.active = Math.max(0, budget.active - 1);
      if (retainForCurrentWork && topologyWorkActive && !disposed) {
        reserveCapacity(budgetOwner, 1);
        notifyBudgetListeners(budgetOwner);
      } else {
        notifyBudgetListeners(budgetOwner);
      }
    }

    function revokeReservationForRoot() {
      if (budget.active + budget.reserved < budget.limit) return;
      const reservations = [...budget.reservations.entries()];
      const entry = reservations.find(([owner]) => owner !== budgetOwner) ?? reservations[0];
      if (entry == null) return;
      const [owner, count] = entry;
      if (count <= 1) {
        budget.reservations.delete(owner);
      } else {
        budget.reservations.set(owner, count - 1);
      }
      budget.reserved = Math.max(0, budget.reserved - 1);
      notifyBudgetListeners(owner, false);
    }

    function hasWatchCapacity(directory) {
      if (budget.active >= budget.limit) return false;
      if (directory === root) {
        revokeReservationForRoot();
        return budget.active < budget.limit;
      }
      if (reservationCount() > 0) return true;
      if (
        watchResourceRetryWorkPending &&
        watchResourceRetryProbeAllowance > 0 &&
        budget.active + budget.reserved < budget.limit
      ) {
        return true;
      }
      if (budget.partialListeners.size > 0) return false;
      return budget.active + budget.reserved < budget.limit;
    }

    function consumeWatchResourceRetryProbe() {
      if (!watchResourceRetryWorkPending || watchResourceRetryProbeAllowance === 0) return;
      watchResourceRetryProbeAllowance -= 1;
    }

    function noteWatchResourceRetryProbeFailure() {
      if (watchResourceRetryWorkPending) watchResourceRetryProbeFailed = true;
    }

    function watchResourceRetryDefersWatchAttempt() {
      return (
        (watchResourceRetryTimer != null && !watchResourceRetryWorkPending) ||
        (watchResourceRetryWorkPending && watchResourceRetryProbeFailed)
      );
    }

    function consumeReservation() {
      const count = reservationCount();
      if (count === 0) return;
      if (count === 1) {
        budget.reservations.delete(budgetOwner);
      } else {
        budget.reservations.set(budgetOwner, count - 1);
      }
      budget.reserved = Math.max(0, budget.reserved - 1);
    }

    async function yieldBudgetNotifications() {
      while (budget.notificationQueued) await Promise.resolve();
    }

    function enqueueTopologyWork(work) {
      const result = topologyWorkTail.then(async () => {
        if (disposed) return;
        topologyWorkActive = true;
        try {
          await work();
        } finally {
          topologyWorkActive = false;
          if (!budgetRecoveryWorkPending) releaseReservations(budgetOwner);
        }
      });
      topologyWorkTail = result.catch((error) => {
        if (!disposed) {
          finish({
            reason: "watch-error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
      return result;
    }

    async function resolveGitPath(gitPath) {
      const result = await gitResult(["rev-parse", "--git-path", gitPath]);
      if (result?.status == null) {
        return { resolved: !result?.retryable, target: null };
      }
      if (result.status !== 0 || typeof result.stdout !== "string") {
        return { resolved: !gitEntryExists(), target: null };
      }
      const value = result.stdout.replace(/\r?\n$/u, "");
      if (value.length === 0 || value.includes("\0")) return { resolved: true, target: null };
      return {
        resolved: true,
        target: path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value),
      };
    }

    function refreshTargetsSignature(targets) {
      return JSON.stringify(
        [...targets]
          .map(([directory, names]) => [directory, [...names].sort()])
          .sort(([left], [right]) => left.localeCompare(right)),
      );
    }

    async function loadRefreshTargets() {
      if (!configuration.honorGitIgnore || disposed) {
        return { changed: false, coverageChanged: false };
      }
      let needsRetry = false;
      for (const gitPath of ["index", "info/exclude"]) {
        const result = await resolveGitPath(gitPath);
        if (disposed) return { changed: false, coverageChanged: false };
        if (!result.resolved) {
          needsRetry = true;
          continue;
        }
        if (result.target == null) {
          refreshTargetPaths.delete(gitPath);
        } else {
          refreshTargetPaths.set(gitPath, result.target);
        }
      }
      refreshTargetsNeedRetry = needsRetry;
      const previousSignature = refreshTargetsSignature(refreshTargets);
      const nextTargets = new Map();
      for (const target of refreshTargetPaths.values()) {
        const directory = path.dirname(target);
        const names = nextTargets.get(directory) ?? new Set();
        names.add(path.basename(target));
        nextTargets.set(directory, names);
      }
      refreshTargets.clear();
      for (const [directory, names] of nextTargets) refreshTargets.set(directory, names);
      for (const directory of [...refreshWatchers.keys()]) {
        if (!refreshTargets.has(directory)) closeRefreshWatch(directory);
      }
      await yieldBudgetNotifications();
      const coverageChanged = ensureRefreshWatches();
      return {
        changed: previousSignature !== refreshTargetsSignature(refreshTargets),
        coverageChanged,
      };
    }

    function closeRefreshWatch(directory, expectedWatcher = null) {
      const entry = refreshWatchers.get(directory);
      if (entry == null || (expectedWatcher != null && entry.watcher !== expectedWatcher)) return;
      refreshWatchers.delete(directory);
      releaseWatchCapacity(true);
      try {
        entry.watcher.close();
      } catch {}
    }

    function closeRefreshSubtrees(directories) {
      const subtreeRoots = new Set(
        [...directories].filter((directory) => isWithin(directory, root)),
      );
      if (subtreeRoots.size === 0) return;
      for (const directory of [...refreshWatchers.keys()]) {
        if (hasAncestorInSet(directory, subtreeRoots)) closeRefreshWatch(directory);
      }
    }

    function hasRefreshWatchInSubtree(directory) {
      for (const refreshDirectory of refreshWatchers.keys()) {
        if (isWithin(refreshDirectory, directory)) return true;
      }
      return false;
    }

    function consumeRefreshTargetMappingInvalidation() {
      if (!refreshTargetMappingInvalidated) return false;
      refreshTargetMappingInvalidated = false;
      for (const directory of [...refreshWatchers.keys()]) closeRefreshWatch(directory);
      refreshTargetPaths.clear();
      refreshTargets.clear();
      asynchronousRefreshWatchFailures.clear();
      resetRefreshRetry();
      gitIgnoredRoots = new Set([path.join(root, ".git")]);
      refreshTargetsNeedRetry = configuration.honorGitIgnore;
      refreshWatchesNeedRetry = false;
      return true;
    }

    function scheduleRefreshRetry() {
      if (disposed || refreshRetryTimer != null) return;
      const retryDelay = refreshRetryDelayMs;
      refreshRetryTimer = setTimeout(() => {
        refreshRetryTimer = null;
        if (disposed) return;
        if (
          rootMetadataRetryTimer != null ||
          watchResourceRetryTimer != null ||
          watchResourceRetryWorkPending
        ) {
          // Metadata and operating-system resource backoffs own their domains.
          // Retain this Git retry without probing either domain early.
          scheduleRefreshRetry();
          return;
        }
        enqueueTopologyWork(async () => {
          if (
            rootMetadataRetryTimer != null ||
            watchResourceRetryTimer != null ||
            watchResourceRetryWorkPending
          ) {
            // Another retry domain may have become active while this work was
            // queued behind a reconciliation. It still owns recovery.
            refreshRetryDelayMs = retryDelay;
            scheduleRefreshRetry();
            return;
          }
          refreshRetryDelayMs = Math.min(retryDelay * 2, RETRY_MAX_MS);
          try {
            const retryingRefreshTargets = refreshTargetsNeedRetry;
            const retryingGitIgnores = gitIgnoresNeedRetry;
            const refreshResult = await loadRefreshTargets();
            if (
              disposed ||
              (
                !refreshResult.changed &&
                !refreshResult.coverageChanged &&
                !retryingRefreshTargets &&
                !retryingGitIgnores &&
                !refreshTargetsNeedRetry &&
                !gitIgnoresNeedRetry
              )
            ) {
              return;
            }
            await reloadGitIgnoresAndPrune();
            const scanResult = await scanDirectoryTree(root);
            updateRootMetadataRetry(scanResult, true);
            if (!disposed) options.onChange({ changedPaths: [] });
          } finally {
            if (
              !disposed &&
              !refreshTargetsNeedRetry &&
              !gitIgnoresNeedRetry &&
              !refreshWatchesNeedRetry &&
              rootMetadataRetryTimer == null &&
              watchResourceRetryTimer == null &&
              !watchResourceRetryWorkPending &&
              budgetCoveragePartial &&
              budget.active + budget.reserved < budget.limit
            ) {
              // A successful metadata retry may reveal a refresh target while
              // this owner is suspended after an earlier incomplete recovery.
              // Wake only this owner; the retry is not physical capacity
              // progress and must not churn unrelated stalled workspaces.
              budget.suspendedOwners.delete(budgetOwner);
              notifyBudgetListeners(budgetOwner, false);
            }
          }
        });
      }, retryDelay);
      refreshRetryTimer.unref?.();
    }

    function resetRefreshRetry() {
      if (refreshRetryTimer != null) clearTimeout(refreshRetryTimer);
      refreshRetryTimer = null;
      refreshRetryDelayMs = RETRY_INITIAL_MS;
    }

    async function reloadGitIgnoresAndPrune() {
      const nextIgnoredRoots = await loadGitIgnoredRoots();
      if (disposed) return;
      gitIgnoredRoots = nextIgnoredRoots;
      for (const directory of [...watchers.keys()]) {
        if (directory !== root && isIgnoredDirectory(directory)) closeDirectoryWatch(directory);
      }
      if (gitIgnoresNeedRetry) {
        scheduleRefreshRetry();
      } else if (!refreshTargetsNeedRetry && !refreshWatchesNeedRetry) {
        resetRefreshRetry();
      }
    }

    async function reloadGitStateAndPrune() {
      const refreshResult = await loadRefreshTargets();
      if (disposed) return refreshResult;
      await reloadGitIgnoresAndPrune();
      return refreshResult;
    }

    function ensureRefreshWatches() {
      if (!watchers.has(root)) {
        refreshWatchesNeedRetry = false;
        return false;
      }
      let coverageChanged = false;
      let needsRetry = false;
      for (const [directory, names] of refreshTargets) {
        if (disposed) break;
        const identity = refreshDirectoryIdentity(directory);
        const namesKey = [...names].sort().join("\0");
        const existing = refreshWatchers.get(directory);
        if (
          existing != null &&
          identity != null &&
          existing.identity === identity &&
          existing.namesKey === namesKey
        ) {
          continue;
        }
        if (existing != null) {
          closeRefreshWatch(directory, existing.watcher);
          coverageChanged = true;
        }
        if (identity == null) {
          needsRetry = true;
          continue;
        }
        if (refreshRetryTimer != null) {
          needsRetry = true;
          continue;
        }
        if (budget.notificationQueued) {
          needsRetry = true;
          continue;
        }
        if (watchResourceRetryDefersWatchAttempt()) {
          continue;
        }
        if (!hasWatchCapacity(directory)) {
          markBudgetCoveragePartial();
          continue;
        }
        let watcher;
        consumeWatchResourceRetryProbe();
        try {
          watcher = fs.watch(directory, { recursive: false }, (eventType, filename) => {
            if (refreshWatchers.get(directory)?.watcher !== watcher) return;
            if (
              filename == null ||
              (
                eventType === "rename" &&
                (
                  // Node reports a watched directory's self-rename with its
                  // basename, which is ambiguous with a same-named child.
                  // Conservatively rewatch the refresh directory in either case.
                  filename.toString() === path.basename(directory) ||
                  refreshDirectoryIdentity(directory) !== identity
                )
              )
            ) {
              refreshWatchesNeedRetry = true;
              closeRefreshWatch(directory, watcher);
              scheduleTopologyRefresh(true);
              scheduleRefreshRetry();
              return;
            }
            resetAsynchronousRefreshWatchFailure(directory);
            resetAsynchronousWatchResourceFailure("refresh", directory);
            if (filename == null || names.has(filename.toString())) scheduleTopologyRefresh(true);
          });
        } catch (error) {
          if (isWatchResourceError(error)) noteWatchResourceRetryProbeFailure();
          if (!noteWatchResourceFailure(error)) needsRetry = true;
          continue;
        }
        refreshWatchers.set(directory, { identity, namesKey, watcher });
        budget.active += 1;
        consumeReservation();
        coverageChanged = true;
        watcher.on("error", (error) => {
          if (refreshWatchers.get(directory)?.watcher !== watcher) return;
          if (isWatchResourceError(error)) {
            noteAsynchronousWatchResourceFailure("refresh", directory, identity);
          } else {
            noteAsynchronousRefreshWatchFailure(directory, identity);
          }
          const resourceError = noteWatchResourceFailure(error);
          refreshWatchesNeedRetry = true;
          closeRefreshWatch(directory, watcher);
          options.onChange({ changedPaths: [] });
          if (!resourceError) scheduleRefreshRetry();
        });
      }
      refreshWatchesNeedRetry = needsRetry;
      if (refreshWatchesNeedRetry || refreshTargetsNeedRetry) {
        scheduleRefreshRetry();
      } else if (!gitIgnoresNeedRetry) {
        resetRefreshRetry();
      }
      return coverageChanged;
    }

    function closeDirectoryWatch(directory, expectedWatcher = null) {
      const entry = watchers.get(directory);
      if (entry == null || (expectedWatcher != null && entry.watcher !== expectedWatcher)) return;
      watchers.delete(directory);
      releaseWatchCapacity(directory !== root);
      if (directory === root) releaseReservations(budgetOwner);
      try {
        entry.watcher.close();
      } catch {}
    }

    function closeSubtrees(directories) {
      const subtreeRoots = new Set(
        [...directories].filter((directory) => isWithin(directory, root)),
      );
      if (subtreeRoots.size === 0) return;
      for (const watchedDirectory of [...watchers.keys()]) {
        if (
          watchedDirectory !== root &&
          hasAncestorInSet(watchedDirectory, subtreeRoots)
        ) {
          closeDirectoryWatch(watchedDirectory);
        }
      }
    }

    function closeSubtree(directory) {
      closeSubtrees([directory]);
    }

    function finish(reason) {
      if (disposed) return;
      disposed = true;
      lifecycleAbortController.abort();
      budget.listeners.delete(recoverWatchCoverageIfPossible);
      budget.listenerOwners.delete(recoverWatchCoverageIfPossible);
      budget.partialListeners.delete(recoverWatchCoverageIfPossible);
      budget.recoveringOwners.delete(budgetOwner);
      budget.suspendedOwners.delete(budgetOwner);
      releaseReservations(budgetOwner);
      if (directorySyncHandle != null) clearImmediate(directorySyncHandle);
      directorySyncHandle = null;
      directorySyncNeedsFullInvalidation = false;
      directorySyncNeedsRefreshInvalidation = false;
      directorySyncNeedsFullReconcile = false;
      directorySyncWorkPending = false;
      pendingDirectorySyncs.clear();
      asynchronousWatchFailures.clear();
      asynchronousRefreshWatchFailures.clear();
      asynchronousWatchResourceFailures.clear();
      budgetRecoveryWorkPending = false;
      if (refreshRetryTimer != null) clearTimeout(refreshRetryTimer);
      refreshRetryTimer = null;
      refreshTargetMappingInvalidated = false;
      rootWatchInvalidated = false;
      if (rootMetadataRetryTimer != null) clearTimeout(rootMetadataRetryTimer);
      rootMetadataRetryTimer = null;
      if (watchResourceRetryTimer != null) clearTimeout(watchResourceRetryTimer);
      watchResourceRetryTimer = null;
      watchResourceRetryProbeAllowance = 0;
      watchResourceRetryProbeFailed = false;
      watchResourceRetryWorkPending = false;
      if (topologyRefreshTimer != null) clearTimeout(topologyRefreshTimer);
      topologyRefreshTimer = null;
      for (const directory of [...watchers.keys()]) closeDirectoryWatch(directory);
      for (const directory of [...refreshWatchers.keys()]) closeRefreshWatch(directory);
      resolveClosed(reason);
    }

    function logicalChangedPath(physicalPath) {
      const relative = path.relative(root, physicalPath);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return null;
      }
      const parts = relative === "" ? [] : relative.split(path.sep);
      return logicalPath.join(options.path, ...parts);
    }

    function emitChange(directory, eventType, filename) {
      if (disposed) return;
      if (directory === root && eventType === "rename") {
        const entry = watchers.get(root);
        const metadata = directoryMetadata(root);
        if (
          entry == null ||
          metadata == null ||
          metadataIdentity(metadata) !== entry.identity ||
          filename == null ||
          filename.toString() === path.basename(root)
        ) {
          options.onChange({ changedPaths: [] });
          // The basename self-event shape is ambiguous with a same-named
          // child. Serialize the conservative root rewatch with topology work.
          rootWatchInvalidated = true;
          refreshTargetMappingInvalidated = true;
          scheduleTopologyRefresh(true);
          return;
        }
      }
      if (filename == null) {
        options.onChange({ changedPaths: [] });
        if (directory === root) {
          rootWatchInvalidated = true;
          refreshTargetMappingInvalidated = true;
        } else {
          scheduleDirectorySync(directory);
        }
        scheduleTopologyRefresh(true);
        return;
      }
      resetAsynchronousWatchResourceFailure("working-tree", directory);
      const name = filename.toString();
      const physicalPath = path.join(directory, name);
      const changedPath = logicalChangedPath(physicalPath);
      if (changedPath == null) {
        options.onChange({ changedPaths: [] });
      } else {
        const changedPaths = [changedPath];
        if (
          eventType === "rename" &&
          options.renameEventHandling === "changed-path-with-parent-directory"
        ) {
          changedPaths.push(logicalPath.dirname(changedPath));
        }
        options.onChange({ changedPaths: [...new Set(changedPaths)] });
      }
      if (eventType === "rename") {
        scheduleDirectorySync(physicalPath);
      }
      if (
        path.basename(physicalPath) === ".gitignore" ||
        physicalPath === path.join(root, ".git")
      ) {
        if (physicalPath === path.join(root, ".git")) {
          refreshTargetMappingInvalidated = true;
        }
        scheduleTopologyRefresh(true);
      }
    }

    function addDirectoryWatch(directory, metadata = directoryMetadata(directory)) {
      if (disposed || isIgnoredDirectory(directory)) return WATCH_SKIPPED;
      if (metadata == null) return WATCH_ERROR;
      const identity = metadataIdentity(metadata);
      const existing = watchers.get(directory);
      if (existing != null) {
        if (existing.identity === identity) return WATCH_EXISTING;
        if (directory === root) refreshTargetMappingInvalidated = true;
        closeSubtree(directory);
        if (directory === root) closeDirectoryWatch(root);
        return WATCH_RETRY_AFTER_RELEASE;
      }
      if (
        directory !== root &&
        watchResourceRetryDefersWatchAttempt()
      ) {
        return WATCH_RETRY_PENDING;
      }
      if (directory !== root && budget.notificationQueued) {
        return WATCH_RETRY_AFTER_RELEASE;
      }
      if (!hasWatchCapacity(directory)) {
        markBudgetCoveragePartial();
        return WATCH_BUDGET_EXHAUSTED;
      }
      let watcher;
      if (directory !== root) consumeWatchResourceRetryProbe();
      try {
        watcher = fs.watch(directory, { recursive: false }, (eventType, filename) => {
          if (watchers.get(directory)?.watcher !== watcher) return;
          emitChange(directory, eventType, filename);
        });
      } catch (error) {
        if (directory !== root && isWatchResourceError(error)) {
          noteWatchResourceRetryProbeFailure();
        }
        if (directory === root) {
          reportWatchLimitError(error);
        } else if (!noteWatchResourceFailure(error)) {
          return WATCH_RETRY_REQUIRED;
        }
        return WATCH_ERROR;
      }
      watchers.set(directory, { identity, watcher });
      budget.active += 1;
      if (directory !== root) consumeReservation();
      watcher.on("error", (error) => {
        if (watchers.get(directory)?.watcher !== watcher) return;
        if (directory === root) {
          reportWatchLimitError(error);
          finish({ reason: "watch-error", error });
          return;
        }
        if (isWatchResourceError(error)) {
          noteAsynchronousWatchResourceFailure("working-tree", directory, identity);
        }
        const resourceError = noteWatchResourceFailure(error);
        const recoveryExhausted = !resourceError &&
          asynchronousWatchFailureIsExhausted("working-tree", directory, identity);
        closeSubtree(directory);
        options.onChange({ changedPaths: [] });
        if (recoveryExhausted) {
          finish({
            reason: "watch-error",
            error: new Error(
              `Could not restore complete working-tree watch coverage: ${options.path}`,
            ),
          });
        } else if (!resourceError) {
          scheduleTopologyRefresh(
            configuration.honorGitIgnore && refreshRetryTimer == null,
          );
        }
      });
      return WATCH_ADDED;
    }

    async function scanDirectoryTree(start) {
      const queue = [start];
      const budgetDeferredDirectories = new Set();
      const budgetRetriedDirectories = new Set();
      let budgetReplayQueued = false;
      const identityRetryCounts = new Map();
      const incompleteDirectories = new Set();
      let metadataUnavailable = false;
      let rootMetadataUnavailable = false;
      let topologyRetryNeeded = false;
      const readRetryCounts = new Map();
      const resourceFailureGenerationAtStart = watchResourceFailureGeneration;
      let index = 0;
      const startAncestorValidation = validateWatchedAncestors(start);
      if (!startAncestorValidation.valid) {
        if (startAncestorValidation.metadataUnavailable) {
          return {
            coverageComplete: false,
            metadataUnavailable: true,
            rootMetadataUnavailable:
              startAncestorValidation.rootMetadataUnavailable === true,
          };
        }
        closeSubtree(startAncestorValidation.ancestor ?? start);
        if (startAncestorValidation.ancestor === root) {
          refreshTargetMappingInvalidated = true;
          closeDirectoryWatch(root);
        }
        if (rootMetadataRetryTimer == null) {
          scheduleTopologyRefresh(configuration.honorGitIgnore);
        }
        return {
          coverageComplete: false,
          metadataUnavailable: false,
          rootMetadataUnavailable: false,
          topologyRetryNeeded: true,
        };
      }
      while (!disposed) {
        await yieldBudgetNotifications();
        if (disposed) break;
        if (index >= queue.length) {
          if (
            !budgetReplayQueued &&
            budget.active < budget.limit &&
            budgetDeferredDirectories.size > 0
          ) {
            budgetReplayQueued = true;
            for (const directory of budgetDeferredDirectories) {
              budgetRetriedDirectories.add(directory);
              queue.push(directory);
            }
          } else {
            break;
          }
        }
        const directory = queue[index];
        index += 1;
        if (isIgnoredDirectory(directory)) {
          incompleteDirectories.delete(directory);
          closeSubtree(directory);
          continue;
        }
        const initialState = directoryMetadataState(directory);
        const metadata = initialState.metadata;
        const watchStatus = addDirectoryWatch(directory, metadata);
        if (watchStatus === WATCH_RETRY_AFTER_RELEASE) {
          incompleteDirectories.add(directory);
          queue.push(directory);
          continue;
        }
        if (
          watchStatus === WATCH_BUDGET_EXHAUSTED ||
          watchStatus === WATCH_ERROR ||
          watchStatus === WATCH_RETRY_PENDING ||
          watchStatus === WATCH_RETRY_REQUIRED
        ) {
          if (
            watchStatus === WATCH_BUDGET_EXHAUSTED &&
            !budgetRetriedDirectories.has(directory)
          ) {
            budgetDeferredDirectories.add(directory);
          }
          if (
            watchStatus === WATCH_BUDGET_EXHAUSTED ||
            watchStatus === WATCH_RETRY_PENDING ||
            watchStatus === WATCH_RETRY_REQUIRED ||
            !initialState.absent
          ) {
            incompleteDirectories.add(directory);
          } else {
            incompleteDirectories.delete(directory);
          }
          if (watchStatus === WATCH_RETRY_REQUIRED) {
            topologyRetryNeeded = true;
          }
          if (watchStatus === WATCH_ERROR) {
            if (!initialState.absent && metadata == null) {
              metadataUnavailable = true;
              if (directory === root) rootMetadataUnavailable = true;
            }
            if (directory === root) {
              if (!initialState.absent && metadata == null) {
                scheduleRootMetadataRetry(configuration.honorGitIgnore, true);
                return {
                  coverageComplete: false,
                  metadataUnavailable,
                  rootMetadataUnavailable,
                };
              }
              closeSubtree(root);
              closeDirectoryWatch(root);
              finish({
                reason: "watch-error",
                error: new Error(`Could not watch working-tree root: ${options.path}`),
              });
              return { coverageComplete: false, metadataUnavailable };
            }
            if (initialState.absent || metadata != null) closeSubtree(directory);
          }
          continue;
        }
        const children = [];
        let directoryReadComplete = true;
        let retryDirectoryRead = false;
        try {
          // Promise readdir resolves DT_UNKNOWN through asynchronous lstat calls.
          // Node's streaming opendir path uses lstatSync for those entries.
          // TODO(default/core rollout): measure worst-case single-directory memory and
          // DT_UNKNOWN request fan-out before enabling this broadly; use a bounded native
          // traversal if either is material in real workspaces.
          // Node cannot cancel an in-flight readdir, but disposal must not wait
          // indefinitely for a stalled remote filesystem request.
          const readResult = await waitForFsOperation(
            fs.promises.readdir(directory, { withFileTypes: true }),
          );
          if (readResult.disposed) return;
          if (readResult.error != null) throw readResult.error;
          const entries = readResult.value;
          for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
            if (entryIndex > 0 && entryIndex % 256 === 0) {
              await new Promise((resolve) => setImmediate(resolve));
            }
            if (disposed) return;
            const entry = entries[entryIndex];
            const child = path.join(directory, entry.name);
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            if (!isIgnoredDirectory(child)) children.push(child);
          }
        } catch (error) {
          const resourceError = noteWatchResourceFailure(error);
          directoryReadComplete = false;
          incompleteDirectories.add(directory);
          const retries = readRetryCounts.get(directory) ?? 0;
          if (!resourceError && isTransientDirectoryReadError(error) && retries < 2) {
            readRetryCounts.set(directory, retries + 1);
            retryDirectoryRead = true;
          } else if (!resourceError) {
            topologyRetryNeeded = true;
          }
        }
        if (disposed) return;
        const currentState = directoryMetadataState(directory);
        const currentMetadata = currentState.metadata;
        if (currentMetadata == null) {
          if (!currentState.absent) {
            metadataUnavailable = true;
            if (directory === root) rootMetadataUnavailable = true;
            incompleteDirectories.add(directory);
            continue;
          }
          if (directory === root) {
            closeDirectoryWatch(root);
            finish({
              reason: "watch-error",
              error: new Error(`Could not watch working-tree root: ${options.path}`),
            });
            return;
          } else {
            closeSubtree(directory);
          }
          incompleteDirectories.delete(directory);
          continue;
        }
        if (metadataIdentity(currentMetadata) !== metadataIdentity(metadata)) {
          if (directory === root) {
            refreshTargetMappingInvalidated = true;
            closeDirectoryWatch(root);
            if (rootMetadataRetryTimer == null) scheduleTopologyRefresh(true);
          } else {
            closeSubtree(directory);
          }
          const retries = identityRetryCounts.get(directory) ?? 0;
          if (retries < 2) {
            identityRetryCounts.set(directory, retries + 1);
            queue.push(directory);
            incompleteDirectories.add(directory);
          } else {
            incompleteDirectories.add(directory);
            topologyRetryNeeded = true;
          }
          continue;
        }
        if (retryDirectoryRead) {
          queue.push(directory);
        } else if (directoryReadComplete) {
          incompleteDirectories.delete(directory);
        }
        for (const child of children) queue.push(child);
      }
      if (disposed) {
        return {
          coverageComplete: false,
          metadataUnavailable,
          rootMetadataUnavailable,
          topologyRetryNeeded,
        };
      }
      const coverageComplete = incompleteDirectories.size === 0;
      if (
        start === root &&
        coverageComplete &&
        !refreshTargetsNeedRetry &&
        !gitIgnoresNeedRetry &&
        [...refreshTargets.keys()].every((directory) => refreshWatchers.has(directory))
      ) {
        markBudgetCoverageRecovered();
      }
      if (
        start === root &&
        coverageComplete &&
        [...refreshTargets.keys()].every((directory) => refreshWatchers.has(directory))
      ) {
        resetWatchResourceRetry(resourceFailureGenerationAtStart);
      }
      return {
        coverageComplete,
        metadataUnavailable,
        rootMetadataUnavailable,
        topologyRetryNeeded,
      };
    }

    async function flushDirectorySyncs() {
      if (disposed) return;
      directorySyncFlushCount += 1;
      const needsFullInvalidation = directorySyncNeedsFullInvalidation;
      directorySyncNeedsFullInvalidation = false;
      const needsRefreshInvalidation = directorySyncNeedsRefreshInvalidation;
      directorySyncNeedsRefreshInvalidation = false;
      const needsFullReconcile = directorySyncNeedsFullReconcile;
      directorySyncNeedsFullReconcile = false;
      const pendingDirectories = [...pendingDirectorySyncs];
      pendingDirectorySyncs.clear();
      if (needsFullReconcile) {
        if (needsFullInvalidation) {
          // At least one discarded rename path owned a directory watch. Rebuild
          // descendants so inode-number reuse cannot hide its replacement.
          closeSubtree(root);
        }
        if (needsRefreshInvalidation) closeRefreshSubtrees([root]);
        await reconcileTopology(configuration.honorGitIgnore);
        return;
      }
      const directories = [];
      const subtreesToClose = new Set();
      let metadataRetryNeeded = false;
      // A parent rename invalidates any watch at the affected pathname. The
      // replacement may reuse the same dev/ino pair after the old inode is
      // released, so identity comparison alone cannot prove the watch is live.
      closeSubtrees(pendingDirectories);
      closeRefreshSubtrees(pendingDirectories);
      for (const directory of pendingDirectories) {
        const state = directoryMetadataState(directory);
        if (state.metadata != null) {
          directories.push(directory);
        } else if (!state.absent) {
          metadataRetryNeeded = true;
        }
      }
      const refreshCoverageChanged = ensureRefreshWatches();
      if (
        refreshCoverageChanged ||
        (directories.length > 0 && configuration.honorGitIgnore)
      ) {
        await reloadGitStateAndPrune();
      }
      const directoriesToScan = [];
      for (const directory of directories) {
        const state = directoryMetadataState(directory);
        if (state.absent || isIgnoredDirectory(directory)) {
          subtreesToClose.add(directory);
        } else if (state.metadata == null) {
          metadataRetryNeeded = true;
        } else {
          directoriesToScan.push(directory);
        }
      }
      closeSubtrees(subtreesToClose);
      for (const directory of directoriesToScan) {
        const result = await scanDirectoryTree(directory);
        metadataRetryNeeded ||=
          result?.metadataUnavailable === true ||
          result?.topologyRetryNeeded === true;
      }
      if (metadataRetryNeeded) scheduleTopologyRefresh(configuration.honorGitIgnore);
    }

    function armDirectorySyncWork() {
      if (
        disposed ||
        directorySyncHandle != null ||
        directorySyncWorkPending ||
        (!directorySyncNeedsFullReconcile && pendingDirectorySyncs.size === 0)
      ) {
        return;
      }
      directorySyncHandle = setImmediate(() => {
        directorySyncHandle = null;
        if (disposed) return;
        directorySyncWorkPending = true;
        enqueueTopologyWork(async () => {
          try {
            await flushDirectorySyncs();
          } finally {
            directorySyncWorkPending = false;
            if (
              !disposed &&
              (directorySyncNeedsFullReconcile || pendingDirectorySyncs.size > 0)
            ) {
              armDirectorySyncWork();
            }
          }
        });
      });
      directorySyncHandle.unref?.();
    }

    function scheduleDirectorySync(directory) {
      if (disposed || !isWithin(directory, root)) return;
      directorySyncNeedsFullInvalidation ||= watchers.has(directory);
      directorySyncNeedsRefreshInvalidation ||= hasRefreshWatchInSubtree(directory);
      if (budget.suspendedOwners.delete(budgetOwner) && budgetCoveragePartial) {
        notifyBudgetListeners();
      }
      if (!directorySyncNeedsFullReconcile) {
        if (
          !pendingDirectorySyncs.has(directory) &&
          pendingDirectorySyncs.size >= MAX_PENDING_DIRECTORY_SYNCS
        ) {
          pendingDirectorySyncs.clear();
          directorySyncNeedsFullReconcile = true;
        } else {
          pendingDirectorySyncs.add(directory);
        }
      }
      armDirectorySyncWork();
    }

    async function reconcileTopology(reloadGitIgnores, retryRefreshWatches = true) {
      if (disposed) return;
      await yieldBudgetNotifications();
      if (disposed) return;
      if (rootWatchInvalidated) {
        rootWatchInvalidated = false;
        refreshTargetMappingInvalidated = true;
        const entry = watchers.get(root);
        closeSubtree(root);
        closeDirectoryWatch(root, entry?.watcher);
      }
      if (!watchers.has(root)) {
        const initialRootState = directoryMetadataState(root);
        if (initialRootState.metadata == null && !initialRootState.absent) {
          scheduleRootMetadataRetry(reloadGitIgnores, true);
          return;
        }
        rootMetadataRetryRequiresRestart = false;
        const initialRootStatus = addDirectoryWatch(root, initialRootState.metadata);
        if (initialRootStatus === WATCH_ERROR) {
          finish({
            reason: "watch-error",
            error: new Error(`Could not watch working-tree root: ${options.path}`),
          });
          return;
        }
        if (initialRootStatus === WATCH_BUDGET_EXHAUSTED) {
          resetRootMetadataRetry();
          return;
        }
      }
      const refreshTargetsWereInvalidated = consumeRefreshTargetMappingInvalidation();
      if (reloadGitIgnores || refreshTargetsWereInvalidated) {
        await reloadGitStateAndPrune();
      }
      if (disposed) return;
      for (const [directory, entry] of [...watchers.entries()]) {
        const state = directoryMetadataState(directory);
        const metadata = state.metadata;
        if (
          state.absent ||
          (metadata != null && metadataIdentity(metadata) !== entry.identity) ||
          (directory !== root && isIgnoredDirectory(directory))
        ) {
          closeSubtree(directory);
          if (directory === root) {
            refreshTargetMappingInvalidated = true;
            closeDirectoryWatch(root, entry.watcher);
          }
        }
      }
      await yieldBudgetNotifications();
      if (disposed) return;
      const rootState = directoryMetadataState(root);
      if (rootState.metadata == null && !rootState.absent) {
        scheduleRootMetadataRetry(reloadGitIgnores, true);
        return;
      }
      rootMetadataRetryRequiresRestart = false;
      const rootStatus = addDirectoryWatch(root, rootState.metadata);
      if (rootStatus === WATCH_ERROR) {
        finish({
          reason: "watch-error",
          error: new Error(`Could not watch working-tree root: ${options.path}`),
        });
        return;
      }
      if (rootStatus === WATCH_BUDGET_EXHAUSTED) {
        resetRootMetadataRetry();
        return;
      }
      if (rootStatus === WATCH_RETRY_AFTER_RELEASE) {
        await yieldBudgetNotifications();
        if (disposed) return;
      }
      if (consumeRefreshTargetMappingInvalidation()) {
        await reloadGitStateAndPrune();
        if (disposed) return;
      }
      if (retryRefreshWatches && ensureRefreshWatches()) {
        await reloadGitIgnoresAndPrune();
      }
      const scanResult = await scanDirectoryTree(root);
      updateRootMetadataRetry(scanResult, configuration.honorGitIgnore);
      if (!disposed) options.onChange({ changedPaths: [] });
      return scanResult;
    }

    function scheduleTopologyRefresh(reloadGitIgnores) {
      if (disposed) return;
      if (budget.suspendedOwners.delete(budgetOwner) && budgetCoveragePartial) {
        notifyBudgetListeners();
      }
      topologyRefreshNeedsGit ||= reloadGitIgnores;
      if (topologyRefreshWorkPending) {
        topologyRefreshRerunRequested = true;
        return;
      }
      if (topologyRefreshTimer != null) return;
      topologyRefreshTimer = setTimeout(() => {
        topologyRefreshTimer = null;
        const shouldReloadGitIgnores = topologyRefreshNeedsGit;
        topologyRefreshNeedsGit = false;
        topologyRefreshWorkPending = true;
        enqueueTopologyWork(async () => {
          try {
            await reconcileTopology(shouldReloadGitIgnores);
          } finally {
            topologyRefreshWorkPending = false;
            if (
              !disposed &&
              rootMetadataRetryTimer == null &&
              !refreshTargetsNeedRetry &&
              !gitIgnoresNeedRetry &&
              !refreshWatchesNeedRetry &&
              watchResourceRetryTimer == null &&
              !watchResourceRetryWorkPending &&
              budgetCoveragePartial &&
              budget.active + budget.reserved < budget.limit
            ) {
              // A real event may resolve this owner's retry condition while a
              // generic coordinator pass correctly leaves timer-backed owners
              // suspended. Resume only this workspace once its backoff clears.
              budget.suspendedOwners.delete(budgetOwner);
              notifyBudgetListeners(budgetOwner, false);
            }
            if (!disposed && topologyRefreshRerunRequested) {
              topologyRefreshRerunRequested = false;
              scheduleTopologyRefresh(false);
            }
          }
        });
      }, 100);
      topologyRefreshTimer.unref?.();
    }

    function recoverWatchCoverageIfPossible(
      rootsOnly,
      _notificationOwners = new Set(),
      _genericNotification = false,
    ) {
      if (disposed || (!budgetCoveragePartial && watchers.has(root))) return false;
      if (
        rootMetadataRetryTimer != null ||
        watchResourceRetryTimer != null ||
        watchResourceRetryWorkPending
      ) {
        return null;
      }
      if (!watchers.has(root)) {
        const rootState = directoryMetadataState(root);
        if (rootState.metadata == null) {
          if (rootState.absent) {
            finish({
              reason: "watch-error",
              error: new Error(`Could not watch working-tree root: ${options.path}`),
            });
            return false;
          }
          scheduleRootMetadataRetry(true, true);
          return null;
        }
        resetRootMetadataRetry();
        const status = addDirectoryWatch(root, rootState.metadata);
        if (status === WATCH_ERROR) {
          finish({
            reason: "watch-error",
            error: new Error(`Could not watch working-tree root: ${options.path}`),
          });
          return false;
        }
        if (status !== WATCH_ADDED && status !== WATCH_EXISTING) return false;
        options.onChange({ changedPaths: [] });
      }
      if (rootsOnly || budgetRecoveryWorkPending || reservationCount() === 0) return false;
      if (
        rootMetadataRetryTimer != null ||
        watchResourceRetryTimer != null ||
        watchResourceRetryWorkPending
      ) {
        return null;
      }
      budgetRecoveryWorkPending = true;
      budget.recoveringOwners.add(budgetOwner);
      const recovery = enqueueTopologyWork(async () => {
        try {
          if (
            disposed ||
            (!budgetCoveragePartial && watchers.has(root)) ||
            reservationCount() === 0 ||
            rootMetadataRetryTimer != null ||
            watchResourceRetryTimer != null ||
            watchResourceRetryWorkPending
          ) {
            return;
          }
          const retryGitMetadata = refreshRetryTimer == null;
          await reconcileTopology(retryGitMetadata, retryGitMetadata);
        } finally {
          if (!disposed && budgetCoveragePartial && reservationCount() > 0) {
            budget.suspendedOwners.add(budgetOwner);
          }
        }
      });
      const settleRecovery = () => {
        const unusedReservation = reservationCount();
        budgetRecoveryWorkPending = false;
        budget.recoveringOwners.delete(budgetOwner);
        releaseReservations(budgetOwner, false);
        if (disposed) return;
        if (
          unusedReservation > 0 ||
          (
            budgetCoveragePartial &&
            budget.active + budget.reserved < budget.limit
          )
        ) {
          // A fully consumed reservation made useful progress and needs the
          // next bounded allocation pass. An allocation that made no progress
          // is suspended above; returning its unused slots only redistributes
          // them among other eligible owners and cannot wake stalled owners.
          notifyBudgetListeners(budgetOwner, false);
        }
      };
      return recovery.then(
        (value) => {
          settleRecovery();
          return value;
        },
        (error) => {
          settleRecovery();
          throw error;
        },
      );
    }

    await yieldBudgetNotifications();
    const initialRootState = directoryMetadataState(root);
    let initialRootStatus;
    if (initialRootState.metadata == null && !initialRootState.absent) {
      scheduleRootMetadataRetry(configuration.honorGitIgnore, true);
      initialRootStatus = WATCH_RETRY_AFTER_RELEASE;
    } else {
      initialRootStatus = addDirectoryWatch(root, initialRootState.metadata);
    }
    if (initialRootStatus === WATCH_ERROR) {
      throw new Error(`Could not watch working-tree root: ${options.path}`);
    }
    if (initialRootStatus === WATCH_ADDED || initialRootStatus === WATCH_EXISTING) {
      await enqueueTopologyWork(async () => {
        await reloadGitStateAndPrune();
        const scanResult = await scanDirectoryTree(root);
        updateRootMetadataRetry(scanResult, configuration.honorGitIgnore);
      });
    }
    if (!disposed) {
      budget.listeners.add(recoverWatchCoverageIfPossible);
      budget.listenerOwners.set(recoverWatchCoverageIfPossible, budgetOwner);
      if (budgetCoveragePartial && budget.active < budget.limit) {
        notifyBudgetListeners();
      }
    }

    return {
      // The directory watcher is recursive for watched paths, but reports
      // partial coverage so Codex's existing focus recovery remains active.
      coverage: { recursive: false, typedPathChanges: false },
      path: options.path,
      closed,
      dispose: async () => {
        finish({ reason: "disposed" });
        await topologyWorkTail;
      },
      codexLinuxDirectoryWatchCount: () => watchers.size,
      codexLinuxDirectoryWatchBudget: () => ({ active: budget.active, limit: budget.limit }),
      codexLinuxDirectorySyncFlushCount: () => directorySyncFlushCount,
    };
  })();
}

function normalizedSettings(context = {}) {
  const settings = context.feature?.settings ?? {};
  const hasSetting = (name) => Object.prototype.hasOwnProperty.call(settings, name);
  const configuredMax = settings.maxWatches;
  let maxWatches = DEFAULT_MAX_WATCHES;
  if (hasSetting("maxWatches")) {
    if (!Number.isInteger(configuredMax) || configuredMax <= 0) {
      console.warn(
        `WARN: directory-only-working-tree-watch maxWatches must be a positive integer; ` +
        `using ${DEFAULT_MAX_WATCHES}`,
      );
    } else {
      maxWatches = Math.min(configuredMax, 65_536);
      if (configuredMax > maxWatches) {
        console.warn(
          `WARN: directory-only-working-tree-watch maxWatches is capped at ${maxWatches}`,
        );
      }
    }
  }

  let honorGitIgnore = true;
  if (hasSetting("honorGitIgnore")) {
    if (typeof settings.honorGitIgnore === "boolean") {
      honorGitIgnore = settings.honorGitIgnore;
    } else {
      console.warn(
        "WARN: directory-only-working-tree-watch honorGitIgnore must be a boolean; using true",
      );
    }
  }

  const configuredNames = settings.ignoredDirectoryNames;
  let ignoredDirectoryNames = DEFAULT_IGNORED_DIRECTORY_NAMES;
  if (hasSetting("ignoredDirectoryNames")) {
    if (!Array.isArray(configuredNames)) {
      console.warn(
        "WARN: directory-only-working-tree-watch ignoredDirectoryNames must be an array; using []",
      );
    } else {
      ignoredDirectoryNames = configuredNames.filter((name) => (
        typeof name === "string" &&
        name.length > 0 &&
        name !== "." &&
        name !== ".." &&
        !name.includes("/") &&
        !name.includes("\\")
      ));
      if (ignoredDirectoryNames.length !== configuredNames.length) {
        console.warn(
          "WARN: directory-only-working-tree-watch ignoredDirectoryNames contains invalid names; " +
          "ignoring them",
        );
      }
    }
  }
  return {
    maxWatches,
    honorGitIgnore,
    ignoredDirectoryNames: [...new Set(ignoredDirectoryNames)],
  };
}

function patchWorkerSource(source, settings) {
  const helperCount = source.split(`function ${HELPER_NAME}(`).length - 1;
  const branchMarker = `return ${HELPER_NAME}(this,`;
  const branchCount = source.split(branchMarker).length - 1;
  if (helperCount === 1 && branchCount === 1) {
    return { source, matched: 1, changed: 0, reason: null };
  }
  if (helperCount !== 0 || branchCount !== 0) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `Found ${helperCount} helper definitions and ${branchCount} working-tree branches`,
    };
  }

  LOCAL_FILE_WATCH_METHOD.lastIndex = 0;
  const matches = [...source.matchAll(LOCAL_FILE_WATCH_METHOD)];
  if (matches.length !== 1) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `Found ${matches.length} local startFileWatch implementations`,
    };
  }

  const match = matches[0];
  const optionsName = match.groups.options;
  const branch =
    `if(process.platform===\`linux\`&&${optionsName}.recursive&&` +
    `${optionsName}.renameEventHandling===\`changed-path-with-parent-directory\`)` +
    `return ${HELPER_NAME}(this,${optionsName},${JSON.stringify(settings)});`;
  const methodStart = match.index + match[0].length;
  const withBranch = source.slice(0, methodStart) + branch + source.slice(methodStart);
  const helper = `${codexLinuxStartDirectoryOnlyWorkingTreeWatch.toString()};`;
  return { source: helper + withBranch, matched: 1, changed: 1, reason: null };
}

function findLocalFileWatchBundle(extractedDir, settings) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { target: null, result: null, reason: ".vite/build directory not found" };
  }

  const bundlePaths = fs.readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(buildDir, entry.name))
    .sort();
  const alreadyPatched = [];
  const rawMatches = [];
  let rawMatchCount = 0;

  for (const bundlePath of bundlePaths) {
    const source = fs.readFileSync(bundlePath, "utf8");
    const helperCount = source.split(`function ${HELPER_NAME}(`).length - 1;
    const branchCount = source.split(`return ${HELPER_NAME}(this,`).length - 1;
    if (helperCount > 0 || branchCount > 0) {
      alreadyPatched.push({ bundlePath, source, result: patchWorkerSource(source, settings) });
      continue;
    }
    LOCAL_FILE_WATCH_METHOD.lastIndex = 0;
    const matches = [...source.matchAll(LOCAL_FILE_WATCH_METHOD)].length;
    if (matches > 0) rawMatches.push({ bundlePath, source, matches });
    rawMatchCount += matches;
  }

  if (alreadyPatched.length > 0) {
    if (alreadyPatched.length !== 1 || rawMatchCount !== 0) {
      return {
        target: null,
        result: null,
        reason:
          `Found directory-watch patch markers in ${alreadyPatched.length} bundles ` +
          `and ${rawMatchCount} unpatched local startFileWatch implementations`,
      };
    }
    const target = alreadyPatched[0];
    return { target: target.bundlePath, result: target.result, reason: target.result.reason };
  }

  if (rawMatchCount !== 1 || rawMatches.length !== 1) {
    return {
      target: null,
      result: null,
      reason: `Found ${rawMatchCount} local startFileWatch implementations across ${bundlePaths.length} build bundles`,
    };
  }

  const target = rawMatches[0];
  const result = patchWorkerSource(target.source, settings);
  return { target: target.bundlePath, result, reason: result.reason };
}

function patchWorker(extractedDir, context = {}) {
  const discovery = findLocalFileWatchBundle(extractedDir, normalizedSettings(context));
  if (discovery.target == null || discovery.result?.matched !== 1) {
    const reason = discovery.reason ?? "Local startFileWatch implementation not found";
    console.warn(`WARN: ${reason} - skipping directory-only working-tree watch feature`);
    return { matched: discovery.result?.matched ?? 0, changed: 0, reason };
  }
  const result = discovery.result;
  if (result.changed === 1) fs.writeFileSync(discovery.target, result.source, "utf8");
  return {
    matched: result.matched,
    changed: result.changed,
    reason: result.reason,
    target: path.relative(extractedDir, discovery.target),
  };
}

const descriptors = [
  {
    id: "worker-directory-watch",
    phase: "extracted-app:pre-webview",
    order: 20_940,
    ciPolicy: "optional",
    apply: patchWorker,
    status: (result, warnings) => {
      if (result?.matched !== 1) {
        return { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null };
      }
      return result.changed === 1 ? "applied" : "already-applied";
    },
  },
];

module.exports = {
  DEFAULT_IGNORED_DIRECTORY_NAMES,
  DEFAULT_MAX_WATCHES,
  HELPER_NAME,
  LOCAL_FILE_WATCH_METHOD,
  codexLinuxStartDirectoryOnlyWorkingTreeWatch,
  descriptors,
  findLocalFileWatchBundle,
  normalizedSettings,
  patchWorker,
  patchWorkerSource,
};
