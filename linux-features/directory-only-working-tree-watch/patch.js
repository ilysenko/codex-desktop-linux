"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  findMatchingBrace,
} = require("../../scripts/patches/lib/minified-js.js");

const {
  PatchIntegrityError,
  isPatchIntegrityError,
} = require("../../scripts/patches/integrity-error.js");

const bufferEquals = Function.call.bind(Buffer.prototype.equals);

function readTrustedBytes(readFileSync, filePath) {
  const bytes = readFileSync(filePath);
  return Buffer.isBuffer(bytes) ? Buffer.from(bytes) : null;
}

function writeUtf8FileCandidatesTransactionally(candidates, options = {}) {
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const description = options.description ?? "Patch file transaction";
  const prepared = candidates.map((candidate) => {
    const sourceBytes = Buffer.from(candidate.source, "utf8");
    const patchedBytes = Buffer.from(candidate.patchedSource, "utf8");
    const currentBytes = readTrustedBytes(readFileSync, candidate.filePath);
    if (currentBytes == null || !bufferEquals(sourceBytes, currentBytes)) {
      throw new Error(`source byte verification failed for ${candidate.filePath}`);
    }
    return { ...candidate, sourceBytes, patchedBytes };
  });
  const pending = prepared.filter(({ sourceBytes, patchedBytes }) =>
    !bufferEquals(sourceBytes, patchedBytes)
  );
  const attempted = [];

  try {
    for (const candidate of pending) {
      const currentBytes = readTrustedBytes(readFileSync, candidate.filePath);
      if (currentBytes == null || !bufferEquals(candidate.sourceBytes, currentBytes)) {
        throw new Error(`source byte verification failed for ${candidate.filePath}`);
      }
      attempted.push(candidate);
      writeFileSync(candidate.filePath, Buffer.from(candidate.patchedBytes));
      const writtenBytes = readTrustedBytes(readFileSync, candidate.filePath);
      if (writtenBytes == null || !bufferEquals(candidate.patchedBytes, writtenBytes)) {
        throw new Error(`write byte verification failed for ${candidate.filePath}`);
      }
    }
  } catch (error) {
    const rollbackWriteFailures = [];
    for (const candidate of [...attempted].reverse()) {
      try {
        writeFileSync(candidate.filePath, Buffer.from(candidate.sourceBytes));
      } catch (rollbackError) {
        rollbackWriteFailures.push(rollbackError);
      }
    }

    const rollbackVerificationFailures = [];
    for (const candidate of attempted) {
      try {
        const restoredBytes = readTrustedBytes(readFileSync, candidate.filePath);
        if (restoredBytes == null || !bufferEquals(candidate.sourceBytes, restoredBytes)) {
          rollbackVerificationFailures.push(
            new Error(`rollback byte verification failed for ${candidate.filePath}`),
          );
        }
      } catch (verificationError) {
        rollbackVerificationFailures.push(
          new Error(
            `rollback byte verification failed for ${candidate.filePath}: ` +
              `${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
            { cause: verificationError },
          ),
        );
      }
    }

    if (rollbackVerificationFailures.length > 0) {
      const writeFailureContext = rollbackWriteFailures[0] == null
        ? ""
        : `; rollback write also failed: ${rollbackWriteFailures[0].message}`;
      throw new PatchIntegrityError(
        `${description} rollback could not restore original bytes: ` +
          `${rollbackVerificationFailures[0].message}${writeFailureContext}`,
        { cause: error },
      );
    }

    throw error;
  }

  return pending.length;
}

const HELPER_NAME = "codexLinuxStartDirectoryOnlyWorkingTreeWatch";
const PARCEL_WATCH_MARKER = "codexLinuxWatchboundParcelWorkingTreeWatch";
const PARCEL_FALLBACK_SYMBOL_KEY =
  "codex-linux.directory-only-working-tree-watch.parcel-fallback";
const QUALIFICATION_WARNINGS_SYMBOL_KEY =
  "codex-linux.directory-only-working-tree-watch.qualification-warnings";
const REPORT_SHIM_SYMBOL_KEY =
  "codex-linux.directory-only-working-tree-watch.process-report-shim";
const WATCHBOUND_RESULT_NAME = "codexLinuxWatchboundWatcher";
const WATCHBOUND_VERSION = "2.1.1";
const DEFAULT_MAX_WATCHES = 8192;
const DEFAULT_IGNORED_DIRECTORY_NAMES = [];
const IDENTIFIER_PATTERN = "[A-Za-z_$][\\w$]*";
const LOCAL_FILE_WATCH_METHOD_PREFIX =
  `async startFileWatch\\((?<options>${IDENTIFIER_PATTERN})\\)\\{`;
const LOCAL_FILE_WATCH_CURRENT_BODY =
  "(?=let [^{}]{0,180}?await this\\.platformPath\\(\\)," +
  "[^{}]{0,180}?\\(0,[A-Za-z_$][\\w$]*\\.watch\\)\\(" +
  "this\\.getFileSystemPath\\(\\k<options>\\.path\\)," +
  "\\{recursive:\\k<options>\\.recursive\\})";
const LOCAL_FILE_WATCH_METHOD =
  new RegExp(`${LOCAL_FILE_WATCH_METHOD_PREFIX}${LOCAL_FILE_WATCH_CURRENT_BODY}`, "gu");
const CURRENT_LOCAL_HOST_CLASS = new RegExp(
  `var (?<localHostClass>${IDENTIFIER_PATTERN})=class\\{` +
    "runsInsideWsl;hostConfig=\\{id:`local`,display_name:`Local`,kind:`local`\\};" +
    "id=`local`;isLocal=!0;",
  "gu",
);
const PARCEL_WORKING_TREE_WATCH =
  /process\.platform===`linux`\?[A-Za-z_$][\w$]*\((?<options>[A-Za-z_$][\w$]*),\{ignoredPaths:\[[A-Za-z_$][\w$]*\.posix\.join\(\k<options>\.path,`\.git`\)\]\}\):(?<host>[A-Za-z_$][\w$]*)\.startFileWatch\(\k<options>\)/gu;
const CURRENT_PARCEL_HELPER = new RegExp(
  "async function " +
    `(?<helperName>${IDENTIFIER_PATTERN})\\(` +
    `(?<helperOptions>${IDENTIFIER_PATTERN}),` +
    `(?<helperSettings>${IDENTIFIER_PATTERN})\\)\\{return new ` +
    `(?<parcelWatcher>${IDENTIFIER_PATTERN})\\(await import\\(` +
    "`@parcel/watcher`" +
    `\\),\\k<helperOptions>,\\k<helperSettings>\\)\\.start\\(\\)\\}`,
  "gu",
);
const CURRENT_GIT_ROUTE_PREFIX_PATTERN =
  "case`git`:\\{let " +
  `(?<localHost>${IDENTIFIER_PATTERN})=new ` +
  `(?<localHostClass>${IDENTIFIER_PATTERN});return\\{git:\\{createExecutionHost:` +
  `(?<executionOptions>${IDENTIFIER_PATTERN})=>\\{if\\(` +
  `(?<mainConnection>${IDENTIFIER_PATTERN})==null\\)` +
  "throw Error\\(`Git hosts require a main RPC connection`\\);return new " +
  `(?<remoteHostClass>${IDENTIFIER_PATTERN})\\(` +
  "\\k<mainConnection>,\\k<executionOptions>\\)\\},";
const CURRENT_PARCEL_ROUTE_PATTERN =
  "startWorkingTreeWatch:\\(" +
  `(?<routeHost>${IDENTIFIER_PATTERN}),` +
  `(?<routeOptions>${IDENTIFIER_PATTERN})\\)=>` +
  "\\k<routeHost>\\.isLocal\\?process\\.platform===`linux`\\?" +
  `(?<routeHelper>${IDENTIFIER_PATTERN})\\(\\k<routeOptions>,\\{ignoredPaths:\\[` +
  `(?<pathApi>${IDENTIFIER_PATTERN})\\.posix\\.join\\(` +
  "\\k<routeOptions>\\.path,`\\.git`\\)\\]\\}\\):" +
  "\\k<localHost>\\.startFileWatch\\(\\k<routeOptions>\\):" +
  "\\k<routeHost>\\.startFileWatch\\(\\k<routeOptions>\\)";
const CURRENT_WATCHBOUND_ROUTE_PATTERN =
  "startWorkingTreeWatch:\\(" +
  `(?<routeHost>${IDENTIFIER_PATTERN}),` +
  `(?<routeOptions>${IDENTIFIER_PATTERN})\\)=>` +
  "\\k<routeHost>\\.isLocal\\?process\\.platform===`linux`\\?" +
  `/\\*${PARCEL_WATCH_MARKER}\\*/` +
  "\\k<localHost>\\.startFileWatch\\(\\{\\.\\.\\.\\k<routeOptions>," +
  "\\[Symbol\\.for\\(`codex-linux\\.directory-only-working-tree-watch\\.parcel-fallback`\\)\\]:" +
  `\\(\\)=>(?<routeHelper>${IDENTIFIER_PATTERN})\\(\\k<routeOptions>,\\{ignoredPaths:\\[` +
  `(?<pathApi>${IDENTIFIER_PATTERN})\\.posix\\.join\\(` +
  "\\k<routeOptions>\\.path,`\\.git`\\)\\]\\}\\)\\}\\):" +
  "\\k<localHost>\\.startFileWatch\\(\\k<routeOptions>\\):" +
  "\\k<routeHost>\\.startFileWatch\\(\\k<routeOptions>\\)";
const CURRENT_PARCEL_ROUTE_CONTRACT = new RegExp(
  `(?<routePrefix>${CURRENT_GIT_ROUTE_PREFIX_PATTERN})${CURRENT_PARCEL_ROUTE_PATTERN}`,
  "gu",
);
const CURRENT_WATCHBOUND_ROUTE_CONTRACT = new RegExp(
  `(?<routePrefix>${CURRENT_GIT_ROUTE_PREFIX_PATTERN})${CURRENT_WATCHBOUND_ROUTE_PATTERN}`,
  "gu",
);

function codexLinuxStartDirectoryOnlyWorkingTreeWatch(
  host,
  options,
  configuration,
  fallback = null,
) {
  return (async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const childProcess = require("node:child_process");
    const GIT_QUERY_TIMEOUT_MS = 5000;
    const POLICY_PASS_TIMEOUT_MS = 1000;
    const RETRY_INITIAL_MS = 1000;
    const RETRY_MAX_MS = 30_000;
    const QUALIFICATION_WARNINGS_SYMBOL_KEY =
      "codex-linux.directory-only-working-tree-watch.qualification-warnings";
    const WATCHBOUND_VERSION = "2.1.1";
    const moduleOverrideKey = Symbol.for(
      "codex-linux.directory-only-working-tree-watch.test-module",
    );
    const moduleOverride = globalThis[moduleOverrideKey];
    // process.report.getReport() dies in a fatal CHECK trap inside the official
    // Electron binary (SIGILL; the openai/codex#38123 crash class), and both
    // watchbound/capabilities.js and @gadicc/watchbound-node/load-native.cjs
    // call it for libc detection. Replace it with the same facts from probes
    // that stay in JavaScript before any Watchbound code can run. Probe order
    // and matchers follow detect-libc (Apache-2.0, Lovell Fuller and others).
    const reportShimMarker = Symbol.for(
      "codex-linux.directory-only-working-tree-watch.process-report-shim",
    );
    if (process.report?.[reportShimMarker] !== true) {
      const elfInterpreterPath = (image) => {
        if (image.length < 64 || image.readUInt32LE(0) !== 0x464c457f) return null;
        if (image[4] !== 2 || image[5] !== 1) return null;
        const tableOffset = Number(image.readBigUInt64LE(32));
        const entrySize = image.readUInt16LE(54);
        const entryCount = image.readUInt16LE(56);
        if (entrySize < 56) return null;
        for (let index = 0; index < entryCount; index += 1) {
          const entry = tableOffset + index * entrySize;
          if (entry + 40 > image.length) break;
          if (image.readUInt32LE(entry) !== 3) continue;
          const interpOffset = Number(image.readBigUInt64LE(entry + 8));
          const interpSize = Number(image.readBigUInt64LE(entry + 32));
          if (interpSize < 2 || interpOffset + interpSize > image.length) return null;
          const segment = image.subarray(interpOffset, interpOffset + interpSize);
          const terminator = segment.indexOf(0);
          return segment.toString("utf8", 0, terminator === -1 ? segment.length : terminator);
        }
        return null;
      };
      const readLeadingBytes = (filePath, length) => {
        const descriptor = fs.openSync(filePath, "r");
        try {
          const buffer = Buffer.alloc(length);
          return buffer.subarray(0, fs.readSync(descriptor, buffer, 0, length, 0));
        } finally {
          fs.closeSync(descriptor);
        }
      };
      const probeExecutable =
        moduleOverride != null && typeof moduleOverride.reportProbeExecutable === "string"
          ? moduleOverride.reportProbeExecutable
          : "/proc/self/exe";
      let family = null;
      let glibcVersion = null;
      let interpreter = null;
      try {
        interpreter = elfInterpreterPath(readLeadingBytes(probeExecutable, 4096));
        if (interpreter?.includes("/ld-musl-")) {
          family = "musl";
        } else if (interpreter?.includes("/ld-linux-")) {
          family = "glibc";
          // Closure-only Nix launches have no /usr/bin/ldd and no getconf on
          // PATH, but the store path in PT_INTERP names the exact glibc.
          glibcVersion = interpreter.match(/-glibc-(\d+\.\d+(?:\.\d+)?)/u)?.[1] ?? null;
        }
      } catch {}
      try {
        const ldd = fs.readFileSync("/usr/bin/ldd", "latin1");
        if (family == null) {
          if (ldd.includes("musl")) family = "musl";
          else if (ldd.includes("GNU C Library")) family = "glibc";
        }
        if (family === "glibc" && glibcVersion == null) {
          glibcVersion = ldd.match(/LIBC[a-z0-9 \-).]*?(\d+\.\d+)/iu)?.[1] ?? null;
        }
      } catch {}
      if (family === "glibc" && glibcVersion == null) {
        try {
          glibcVersion = childProcess
            .execFileSync("getconf", ["GNU_LIBC_VERSION"], {
              encoding: "utf8",
              timeout: 1000,
              stdio: ["ignore", "pipe", "ignore"],
            })
            .match(/(\d+\.\d+(?:\.\d+)?)/u)?.[1] ?? null;
        } catch {}
      }
      const reportHeader = family === "glibc" && glibcVersion != null
        ? { glibcVersionRuntime: glibcVersion }
        : {};
      const reportSharedObjects = family === "musl" && interpreter != null
        ? [interpreter]
        : [];
      // The native report object stays as the prototype so every other
      // member keeps its accessor-backed behavior; only getReport is shadowed.
      Object.defineProperty(process, "report", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: Object.create(process.report ?? null, {
          [reportShimMarker]: { value: true },
          getReport: {
            configurable: true,
            enumerable: true,
            writable: true,
            value: () => ({
              header: { ...reportHeader },
              sharedObjects: [...reportSharedObjects],
            }),
          },
        }),
      });
    }
    let watchbound = moduleOverride;
    if (watchbound == null) {
      try {
        watchbound = await import("watchbound");
      } catch {
        // A refused loader (unsupported libc, missing package) must degrade to
        // the preserved route, not reject the caller's file watch.
        return typeof fallback === "function" ? fallback() : null;
      }
    }
    if (
      watchbound.capabilities?.schemaVersion !== 9 ||
      watchbound.capabilities?.versions?.wrapper !== WATCHBOUND_VERSION ||
      watchbound.capabilities?.versions?.native !== WATCHBOUND_VERSION ||
      watchbound.capabilities?.versions?.engine !== WATCHBOUND_VERSION ||
      watchbound.capabilities?.versions?.bindingApi !== 5 ||
      watchbound.capabilities?.support?.currentRuntime?.targetCompatible !== true ||
      watchbound.capabilities?.features?.initialExclusions !== true ||
      watchbound.capabilities?.features?.dynamicExclusions !== true ||
      watchbound.capabilities?.features?.directoryNameExclusions !== true ||
      watchbound.capabilities?.features?.observedExcludedPaths !== true ||
      watchbound.capabilities?.features?.automaticReconciliation !== true ||
      watchbound.capabilities?.features?.rootReplacementRecovery !== true ||
      watchbound.capabilities?.features?.physicalRootResolution !== true ||
      watchbound.capabilities?.features?.rootQualification !== true ||
      watchbound.capabilities?.features?.bytesOnlyInvalidations !== true ||
      watchbound.capabilities?.features?.exactPathBytes !== true ||
      !watchbound.capabilities?.options?.subscription?.rootPathPolicy?.values?.includes(
        "resolve-physical",
      ) ||
      typeof watchbound.qualifyRoot !== "function"
    ) {
      throw new Error(
        `directory-only working-tree watch requires watchbound ${WATCHBOUND_VERSION} ` +
          "with root qualification, physical root resolution, exact path delivery, " +
          "native exclusions, reconciliation, and root recovery",
      );
    }

    const lexicalRoot = host.getFileSystemPath(options.path);
    if (typeof lexicalRoot !== "string" || !path.isAbsolute(lexicalRoot)) {
      throw new Error("directory-only working-tree watch requires an absolute root path");
    }
    const defaultQualificationRetryDelays = [250, 500, 1000, 2000];
    const qualificationRetryDelays = (
      moduleOverride != null && Array.isArray(moduleOverride.qualificationRetryDelays)
    )
      ? moduleOverride.qualificationRetryDelays
        .filter((delay) => Number.isInteger(delay) && delay >= 0 && delay <= 30_000)
        .slice(0, 8)
      : defaultQualificationRetryDelays;
    let qualification = null;
    let qualificationError = null;
    const readQualification = () => {
      try {
        qualification = watchbound.qualifyRoot(lexicalRoot);
        qualificationError = null;
      } catch (error) {
        qualification = null;
        qualificationError = error;
      }
    };
    readQualification();
    if (qualification?.state !== "qualified" && qualification?.state !== "unqualified") {
      for (const delay of qualificationRetryDelays) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        readQualification();
        if (qualification?.state === "qualified" || qualification?.state === "unqualified") {
          break;
        }
      }
    }
    if (qualification?.state !== "qualified") {
      const state = qualification?.state === "unqualified" ? "unqualified" : "unknown";
      const reasons = Array.isArray(qualification?.reasons) && qualification.reasons.length > 0
        ? qualification.reasons.join(", ")
        : qualificationError == null
          ? "unknown qualification result"
          : `qualification error: ${qualificationError.message ?? String(qualificationError)}`;
      const warningStateKey = Symbol.for(QUALIFICATION_WARNINGS_SYMBOL_KEY);
      const warningState = globalThis[warningStateKey] ??= new Set();
      const fallbackName = typeof fallback === "function"
        ? "upstream Parcel watcher"
        : "upstream file watcher";
      const signature = `${state}\0${lexicalRoot}\0${reasons}\0${fallbackName}`;
      if (!warningState.has(signature)) {
        if (warningState.size >= 256) warningState.clear();
        warningState.add(signature);
        const retryDescription = state === "unknown"
          ? ` after ${qualificationRetryDelays.length} bounded retries`
          : "";
        console.warn(
          `WARN: directory-only working-tree watch root is ${state}${retryDescription} ` +
            `for ${lexicalRoot} (${reasons}); using the ${fallbackName}.`,
        );
      }
      return typeof fallback === "function" ? fallback() : null;
    }
    // Watchbound resolves the caller's exact lexical spelling. The physical
    // namespace becomes authoritative only after establishment returns its
    // immutable resolution snapshot.
    let root = null;
    const logicalPath = await host.platformPath();
    const excludedDirectoryNames = [...new Set([
      ".git",
      ...configuration.ignoredDirectoryNames,
    ])].sort();
    const observedExcludedPaths = [".git"];
    const lifecycleAbortController = new AbortController();
    const subscriptions = new Set();
    const metadataSubscriptions = new Map();
    let mainSubscription = null;
    let mainSubscriptionReady = false;
    let startupFatalError = null;
    let fatalDisposalError = null;
    let workingTreeCoverageEstablished = false;
    let startupPolicyReplacementError = null;
    let currentExclusions = new Set();
    let lastCompleteGitExclusions = new Set();
    let fullGitScanState = null;
    let gitPolicyEpoch = 0;
    const gitQueryWork = new Set();
    let exclusionGeneration = 0n;
    let disposed = false;
    let disposePromise = null;
    let policyWorkTail = Promise.resolve();
    let policyWorkScheduled = false;
    let policyFullRefreshRequested = false;
    let policyMetadataRefreshRequested = false;
    let policyMetadataForceRefreshRequested = false;
    let policyInvalidationRequested = false;
    const policyRetryStates = {
      full: { timer: null, delayMs: RETRY_INITIAL_MS },
      metadata: { timer: null, delayMs: RETRY_INITIAL_MS },
    };
    let metadataRetryEpoch = 0;
    let rootRecoveryTimer = null;
    let rootRecoveryDelayMs = RETRY_INITIAL_MS;
    let rootRecoveryPending = false;
    let rootRecoveryRequested = false;
    let rootRecoveryWork = Promise.resolve();
    let partialCoverageReported = false;
    let directorySyncFlushCount = 0;
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const policyReadTimedOut = Symbol("policy-read-timed-out");

    function isWithin(candidate, parent) {
      const relative = path.relative(parent, candidate);
      return relative === "" || (
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    }

    function exactBytesEqual(left, right) {
      if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
      if (left.byteLength !== right.byteLength) return false;
      for (let index = 0; index < left.byteLength; index += 1) {
        if (left[index] !== right[index]) return false;
      }
      return true;
    }

    function qualificationMatchesPhysicalRoot(candidate, physicalPathBytes) {
      return candidate?.state === "qualified" && exactBytesEqual(
        candidate?.root?.physicalPathBytes,
        physicalPathBytes,
      );
    }

    function relativePrefix(candidate) {
      const relative = path.relative(root, candidate);
      if (
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return null;
      }
      return relative === "" ? "" : relative.split(path.sep).join("/");
    }

    function prefixContains(prefix, candidate) {
      return prefix === "" || candidate === prefix || candidate.startsWith(`${prefix}/`);
    }

    function isExcludedPrefix(candidate, exclusions = currentExclusions) {
      for (const prefix of exclusions) {
        if (prefixContains(prefix, candidate)) return true;
      }
      return false;
    }

    function kernelBudget() {
      let kernelLimit = null;
      try {
        kernelLimit = Number.parseInt(
          fs.readFileSync("/proc/sys/fs/inotify/max_user_watches", "utf8").trim(),
          10,
        );
      } catch {}
      return Number.isFinite(kernelLimit) && kernelLimit > 0
        ? Math.max(1, Math.min(configuration.maxWatches, Math.floor(kernelLimit / 8)))
        : configuration.maxWatches;
    }

    const requestedLimit = kernelBudget();
    const engineKey = Symbol.for(
      "codex-linux.directory-only-working-tree-watch.watchbound-engine",
    );
    const engineState = globalThis[engineKey] ??= {
      limit: requestedLimit,
      engine: watchbound.createEngine({ nativeWatchBudget: requestedLimit }),
    };
    if (engineState.limit !== requestedLimit) {
      throw new Error(
        "directory-only working-tree watch cannot change its process watch budget " +
          `from ${engineState.limit} to ${requestedLimit} while the app is running`,
      );
    }
    const engine = engineState.engine;

    function isRetryableGitError(error) {
      return (
        ["ETIMEDOUT", "EAGAIN", "EMFILE", "ENFILE", "ENOMEM"].includes(error?.code) ||
        (error?.killed === true && error?.signal === "SIGKILL")
      );
    }

    function shouldRetryGitResult(result) {
      if (result?.retryable === true) return true;
      if (result?.status === 0 || disposed) return false;
      // A normal nonzero Git exit is definitive even while `.git` exists.
      // Retain stale policy only when the independent metadata probe cannot
      // establish whether the repository itself is still present.
      return repositoryMetadataState() === "unknown";
    }

    function repositoryMetadataState() {
      try {
        fs.lstatSync(path.join(root, ".git"));
        return "present";
      } catch (error) {
        return ["ENOENT", "ENOTDIR"].includes(error?.code) ? "absent" : "unknown";
      }
    }

    function gitResult(args, signal = lifecycleAbortController.signal) {
      if (!configuration.honorGitIgnore || disposed) return Promise.resolve(null);
      const query = new Promise((resolve) => {
        try {
          childProcess.execFile(
            "git",
            ["-c", "core.fsmonitor=false", "-C", root, ...args],
            {
              encoding: "utf8",
              killSignal: "SIGKILL",
              maxBuffer: 64 * 1024 * 1024,
              signal,
              timeout: GIT_QUERY_TIMEOUT_MS,
              windowsHide: true,
            },
            (error, stdout) => {
              resolve({
                error,
                retryable: isRetryableGitError(error),
                status: error == null
                  ? 0
                  : Number.isInteger(error.code)
                    ? error.code
                    : null,
                stdout: typeof stdout === "string" ? stdout : "",
              });
            },
          );
        } catch (error) {
          resolve({
            error,
            retryable: isRetryableGitError(error),
            status: null,
            stdout: "",
          });
        }
      });
      gitQueryWork.add(query);
      void query.finally(() => gitQueryWork.delete(query));
      return query;
    }

    function cancelGitScan(state = fullGitScanState) {
      if (state == null) return;
      if (fullGitScanState === state) fullGitScanState = null;
      state.abortController.abort();
    }

    async function awaitPolicyQuery(query, deadline) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return policyReadTimedOut;
      let timeoutId;
      try {
        return await Promise.race([
          query,
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve(policyReadTimedOut), remainingMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
    }

    async function loadGitIgnoredPrefixes(deadline = Number.POSITIVE_INFINITY) {
      const fallbackExclusions = new Set(lastCompleteGitExclusions);
      if (!configuration.honorGitIgnore) {
        return { exclusions: new Set(), retry: false };
      }
      if (fullGitScanState?.epoch !== gitPolicyEpoch) {
        cancelGitScan();
      }
      if (fullGitScanState == null && Date.now() >= deadline) {
        return { exclusions: fallbackExclusions, retry: true };
      }
      if (fullGitScanState == null) {
        const abortController = new AbortController();
        fullGitScanState = {
          abortController,
          epoch: gitPolicyEpoch,
          phase: "ls-files",
          query: gitResult([
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
          ], abortController.signal),
        };
      }
      let state = fullGitScanState;
      if (state.phase === "ls-files") {
        const result = await awaitPolicyQuery(state.query, deadline);
        if (state.epoch !== gitPolicyEpoch) {
          cancelGitScan(state);
          return loadGitIgnoredPrefixes(deadline);
        }
        if (result === policyReadTimedOut) {
          return { exclusions: fallbackExclusions, retry: true };
        }
        if (result?.status !== 0) {
          fullGitScanState = null;
          const retry = shouldRetryGitResult(result);
          if (!retry) {
            lastCompleteGitExclusions = new Set();
            return {
              exclusions: new Set(lastCompleteGitExclusions),
              retry: false,
            };
          }
          return {
            exclusions: fallbackExclusions,
            retry,
          };
        }
        state = {
          abortController: state.abortController,
          candidates: result.stdout
            .split("\0")
            .filter((relative) => (
              relative.endsWith("/") &&
              relative.length > 1 &&
              !/[\u0000-\u001f\u007f"\\\uFFFD]/u.test(relative)
            )),
          chunk: [],
          chunkBytes: 0,
          confirmed: new Set(),
          epoch: state.epoch,
          index: 0,
          phase: "check-ignore",
          query: null,
        };
        fullGitScanState = state;
      }

      while (
        state.query != null ||
        state.index < state.candidates.length ||
        state.chunk.length > 0
      ) {
        if (state.query != null) {
          const result = await awaitPolicyQuery(state.query, deadline);
          if (state.epoch !== gitPolicyEpoch) {
            cancelGitScan(state);
            return loadGitIgnoredPrefixes(deadline);
          }
          if (result === policyReadTimedOut) {
            return { exclusions: fallbackExclusions, retry: true };
          }
          state.query = null;
          if (
            (result?.status !== 0 && result?.status !== 1) ||
            typeof result.stdout !== "string"
          ) {
            fullGitScanState = null;
            const retry = shouldRetryGitResult(result);
            if (!retry) {
              lastCompleteGitExclusions = new Set();
              return {
                exclusions: new Set(lastCompleteGitExclusions),
                retry: false,
              };
            }
            return {
              exclusions: fallbackExclusions,
              retry,
            };
          }
          for (const relative of result.stdout.split(/\r?\n/u)) {
            if (relative.length > 0) state.confirmed.add(relative);
          }
          continue;
        }
        if (Date.now() >= deadline) {
          return { exclusions: fallbackExclusions, retry: true };
        }
        while (state.index < state.candidates.length) {
          const relative = state.candidates[state.index];
          const relativeBytes = Buffer.byteLength(relative) + 1;
          if (
            state.chunk.length > 0 &&
            state.chunkBytes + relativeBytes > 64 * 1024
          ) {
            break;
          }
          state.chunk.push(relative);
          state.chunkBytes += relativeBytes;
          state.index += 1;
          if ((state.index & 255) === 0 && Date.now() >= deadline) {
            return { exclusions: fallbackExclusions, retry: true };
          }
        }
        if (state.chunk.length > 0) {
          const chunk = state.chunk;
          state.chunk = [];
          state.chunkBytes = 0;
          state.query = gitResult([
            "-c",
            "core.quotePath=false",
            "check-ignore",
            "--",
            ...chunk,
          ], state.abortController.signal);
        }
      }

      if (state.epoch !== gitPolicyEpoch) {
        cancelGitScan(state);
        return loadGitIgnoredPrefixes(deadline);
      }
      const exclusions = new Set();
      const ordered = state.candidates
        .filter((relative) => state.confirmed.has(relative))
        .map((relative) => relative.slice(0, -1))
        .sort((left, right) => left.length - right.length);
      for (const relative of ordered) {
        const candidate = path.resolve(root, ...relative.split("/"));
        const prefix = relativePrefix(candidate);
        if (
          prefix != null &&
          prefix !== "" &&
          !isExcludedPrefix(prefix, exclusions)
        ) {
          exclusions.add(prefix);
        }
      }
      fullGitScanState = null;
      lastCompleteGitExclusions = new Set(exclusions);
      return { exclusions, retry: false };
    }

    async function loadPolicy() {
      const deadline = Date.now() + POLICY_PASS_TIMEOUT_MS;
      const gitPolicy = await loadGitIgnoredPrefixes(deadline);
      return {
        exclusions: gitPolicy.exclusions,
        retry: gitPolicy.retry,
      };
    }

    function exclusionsEqual(left, right) {
      if (left.size !== right.size) return false;
      for (const prefix of left) {
        if (!right.has(prefix)) return false;
      }
      return true;
    }

    async function commitExclusions(nextExclusions) {
      if (disposed) return;
      if (!mainSubscriptionReady || mainSubscription == null) {
        throw new Error("directory-only working-tree policy ran before Watchbound was ready");
      }
      if (exclusionsEqual(currentExclusions, nextExclusions)) return;
      const nextGeneration = exclusionGeneration + 1n;
      const coverage = await mainSubscription.replaceExclusions(
        nextGeneration,
        {
          prefixes: [...nextExclusions].sort(),
          excludedDirectoryNames: [...excludedDirectoryNames],
          observedExcludedPaths: [...observedExcludedPaths],
        },
      );
      currentExclusions = nextExclusions;
      exclusionGeneration = nextGeneration;
      const initialWorkingTreeCoverage = !workingTreeCoverageEstablished;
      workingTreeCoverageEstablished = true;
      reportCoverage(coverage);
      // Re-including the initially excluded root already queues Watchbound's
      // generation-boundary invalidation. Later incomplete replacements need
      // an immediate conservative notification of their own.
      if (!initialWorkingTreeCoverage && coverage?.state !== "complete" && !disposed) {
        options.onChange({ changedPaths: [] });
      }
    }

    async function resolveGitPath(gitPath) {
      const result = await gitResult(["rev-parse", "--git-path", gitPath]);
      if (result?.status !== 0 || typeof result.stdout !== "string") {
        return {
          target: null,
          retry: shouldRetryGitResult(result),
        };
      }
      const value = result.stdout.replace(/\r?\n$/u, "");
      if (value.length === 0 || value.includes("\0")) {
        return { target: null, retry: false };
      }
      return {
        target: path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value),
        retry: false,
      };
    }

    async function disposeMetadataSubscriptions() {
      const previous = [...metadataSubscriptions.values()];
      metadataSubscriptions.clear();
      for (const entry of previous) entry.active = false;
      for (const entry of previous) {
        try {
          entry.watcher.close();
        } catch {}
      }
    }

    async function refreshMetadataSubscriptions({ force = false } = {}) {
      if (!configuration.honorGitIgnore || disposed) {
        await disposeMetadataSubscriptions();
        return false;
      }

      let retry = false;
      const targetPaths = [];
      let resolutionFailed = false;
      for (const gitPath of ["index", "info/exclude"]) {
        const result = await resolveGitPath(gitPath);
        retry ||= result.retry;
        if (result.target != null) targetPaths.push(result.target);
        else resolutionFailed = true;
      }
      const targets = new Map();
      const preserveExisting = (
        resolutionFailed &&
        repositoryMetadataState() !== "absent" &&
        metadataSubscriptions.size > 0
      );
      if (preserveExisting && !force) return retry;
      if (preserveExisting) {
        for (const entry of metadataSubscriptions.values()) {
          targets.set(entry.directory, new Set(entry.names));
        }
      } else {
        for (const target of targetPaths) {
          const directory = path.dirname(target);
          const names = targets.get(directory) ?? new Set();
          names.add(path.basename(target));
          targets.set(directory, names);
        }
      }
      const nextSignature = JSON.stringify(
        [...targets]
          .map(([directory, names]) => [directory, [...names].sort()])
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      const currentSignature = JSON.stringify(
        [...metadataSubscriptions.values()]
          .map((entry) => [entry.directory, [...entry.names].sort()])
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      if (!force && nextSignature === currentSignature) return retry;

      await disposeMetadataSubscriptions();
      for (const [directory, names] of targets) {
        if (disposed) break;
        const entry = { active: true, directory, names, watcher: null };
        try {
          const watcher = fs.watch(directory, { recursive: false }, (eventType, filename) => {
            if (!entry.active || disposed) return;
            try {
              const decodedName = filename == null ? null : filename.toString();
              const directoryBoundary = (
                eventType === "rename" &&
                (decodedName == null || decodedName === path.basename(directory))
              );
              if (
                !directoryBoundary &&
                decodedName != null &&
                !names.has(decodedName)
              ) {
                return;
              }
              if (directoryBoundary) {
                entry.active = false;
                metadataSubscriptions.delete(directory);
                try {
                  watcher.close();
                } catch {}
              }
              options.onChange({ changedPaths: [] });
              schedulePolicyRefresh({
                full: true,
                metadata: true,
              });
            } catch (error) {
              entry.active = false;
              metadataSubscriptions.delete(directory);
              try {
                watcher.close();
              } catch {}
              requestFatalDisposal(error);
            }
          });
          entry.watcher = watcher;
          metadataSubscriptions.set(directory, entry);
          watcher.on("error", () => {
            if (!entry.active || disposed) return;
            entry.active = false;
            metadataSubscriptions.delete(directory);
            try {
              watcher.close();
            } catch {}
            try {
              options.onChange({ changedPaths: [] });
              schedulePolicyRefresh({ full: true });
              schedulePolicyRetry("metadata");
            } catch (error) {
              requestFatalDisposal(error);
            }
          });
        } catch {
          entry.active = false;
          retry = true;
        }
      }
      return retry;
    }

    function schedulePolicyRetry(kind) {
      const state = policyRetryStates[kind];
      if (kind === "metadata") metadataRetryEpoch += 1;
      if (disposed || state == null || state.timer != null) return;
      const delay = state.delayMs;
      state.timer = setTimeout(() => {
        state.timer = null;
        state.delayMs = Math.min(delay * 2, RETRY_MAX_MS);
        schedulePolicyRefresh({
          // A metadata-only retry could arm a watcher after an unobserved
          // interval without ever snapshotting changes from that interval.
          // Arm first, then close the gap with a fresh full Git policy pass.
          full: true,
          metadata: kind === "metadata",
          invalidate: true,
          preserveGitScan: kind === "full",
        });
      }, delay);
      state.timer.unref?.();
    }

    function resetPolicyRetry(kind) {
      const state = policyRetryStates[kind];
      if (state?.timer != null) clearTimeout(state.timer);
      if (state != null) {
        state.timer = null;
        state.delayMs = RETRY_INITIAL_MS;
      }
    }

    async function runRequestedPolicyWork() {
      while (
        !disposed &&
        (
          policyFullRefreshRequested ||
          policyMetadataRefreshRequested ||
          policyMetadataForceRefreshRequested ||
          policyInvalidationRequested
        )
      ) {
        const full = policyFullRefreshRequested;
        const metadata = policyMetadataRefreshRequested;
        const forceMetadata = policyMetadataForceRefreshRequested;
        const invalidate = policyInvalidationRequested;
        const metadataRetryEpochAtStart = metadataRetryEpoch;
        policyFullRefreshRequested = false;
        policyMetadataRefreshRequested = false;
        policyMetadataForceRefreshRequested = false;
        policyInvalidationRequested = false;
        let fullRetry = false;
        let metadataRetry = false;

        try {
          // Arm or refresh the small Git-metadata watches before the policy
          // snapshot. A subsequent index/info change is then observable, while
          // the snapshot closes the interval before those watches were ready.
          if (metadata) {
            metadataRetry ||= await refreshMetadataSubscriptions({ force: forceMetadata });
          }
          if (full) {
            const policy = await loadPolicy();
            fullRetry ||= policy.retry;
            await commitExclusions(policy.exclusions);
          }
          if (invalidate && !disposed) {
            options.onChange({ changedPaths: [] });
          }
        } catch (error) {
          if (error?.retryable === true || error?.code === "WATCHBOUND_ROOT_STATE_CONFLICT") {
            if (!workingTreeCoverageEstablished) startupPolicyReplacementError ??= error;
            fullRetry ||= full;
            metadataRetry ||= metadata;
            if (error?.code === "WATCHBOUND_ROOT_STATE_CONFLICT" && !disposed) {
              options.onChange({ changedPaths: [] });
              if (mainSubscription?.rootState?.attachment !== "attached") {
                scheduleRootRecovery();
              }
            }
          } else {
            throw error;
          }
        }

        if (full) {
          if (fullRetry) schedulePolicyRetry("full");
          else resetPolicyRetry("full");
        }
        if (metadata) {
          if (metadataRetry) schedulePolicyRetry("metadata");
          else if (metadataRetryEpoch === metadataRetryEpochAtStart) {
            // Do not cancel a retry requested by an asynchronous watcher
            // failure that arrived while this pass was still snapshotting.
            resetPolicyRetry("metadata");
          }
        }
      }
    }

    function schedulePolicyRefresh(request = {}) {
      if (disposed) return;
      if (request.full === true && request.preserveGitScan !== true) {
        gitPolicyEpoch += 1;
        cancelGitScan();
      }
      policyFullRefreshRequested ||= request.full === true;
      policyMetadataRefreshRequested ||= request.metadata === true;
      policyMetadataForceRefreshRequested ||= request.forceMetadata === true;
      policyInvalidationRequested ||= request.invalidate === true;
      if (!mainSubscriptionReady) return;
      if (policyWorkScheduled) return;
      policyWorkScheduled = true;
      policyWorkTail = policyWorkTail
        .then(runRequestedPolicyWork)
        .catch((error) => {
          if (!disposed) requestFatalDisposal(error);
        })
        .finally(() => {
          policyWorkScheduled = false;
          if (
            !disposed &&
            (
              policyFullRefreshRequested ||
              policyMetadataRefreshRequested ||
              policyMetadataForceRefreshRequested ||
              policyInvalidationRequested
            )
          ) {
            schedulePolicyRefresh();
          }
        });
    }

    function reportCoverage(coverage) {
      const complete = coverage?.state === "complete";
      if (!complete && !partialCoverageReported) {
        partialCoverageReported = true;
        const runtime = engine.runtimeStats();
        console.warn(
          "WARN: directory-only working-tree watch coverage is " +
            `${coverage?.state ?? "unknown"} for ${root ?? lexicalRoot} ` +
            `(native=${runtime.nativeWatches}, limit=${requestedLimit}); ` +
            "Codex focus recovery remains active.",
        );
      } else if (complete && partialCoverageReported) {
        partialCoverageReported = false;
        console.info(
          `INFO: directory-only working-tree watch coverage recovered for ${root ?? lexicalRoot}.`,
        );
      }
    }

    function logicalChangedPaths(batch) {
      if (
        batch.coverage.state !== "complete" ||
        batch.pathEncoding === "bytes-only" ||
        batch.pathEncodingCollapsed ||
        batch.rootState?.attachment !== "attached" ||
        root == null
      ) {
        return null;
      }
      const changedPaths = new Set();
      for (const invalidatedPath of batch.invalidatedPaths) {
        const physicalPath = path.resolve(invalidatedPath);
        const relative = path.relative(root, physicalPath);
        if (
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return null;
        }
        const logical = logicalPath.join(options.path, ...relative.split(path.sep));
        changedPaths.add(logical);
        if (options.renameEventHandling === "changed-path-with-parent-directory") {
          changedPaths.add(logicalPath.dirname(logical));
        }
      }
      return [...changedPaths];
    }

    function scheduleRootRecovery() {
      if (disposed) return;
      rootRecoveryRequested = true;
      if (!mainSubscriptionReady || mainSubscription == null) {
        return;
      }
      if (rootRecoveryPending || rootRecoveryTimer != null) return;
      rootRecoveryRequested = false;
      const delay = rootRecoveryDelayMs;
      rootRecoveryTimer = setTimeout(() => {
        rootRecoveryTimer = null;
        if (disposed || mainSubscription == null) return;
        rootRecoveryPending = true;
        let retry = false;
        rootRecoveryWork = (async () => {
          let result;
          try {
            result = await mainSubscription.recoverRoot({
              identityPolicy: "accept-replacement",
            });
          } catch (error) {
            if (disposed) return;
            if (error?.code === "WATCHBOUND_ROOT_STATE_CONFLICT") {
              rootRecoveryDelayMs = RETRY_INITIAL_MS;
              retry = mainSubscription.rootState?.attachment !== "attached";
              return;
            }
            if (error?.retryable === true) {
              rootRecoveryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
              retry = true;
              return;
            }
            requestFatalDisposal(error);
            return;
          }
          if (disposed) return;
          if (
            result.attachment === "original-restored" ||
            result.attachment === "replacement-adopted"
          ) {
            rootRecoveryDelayMs = RETRY_INITIAL_MS;
            let recoveredQualification;
            try {
              recoveredQualification = watchbound.qualifyRoot(root);
            } catch (error) {
              requestFatalDisposal(error);
              return;
            }
            if (!qualificationMatchesPhysicalRoot(
              recoveredQualification,
              mainSubscription.resolvedRoot.physicalPathBytes,
            )) {
              requestFatalDisposal(new Error(
                "directory-only working-tree watch recovered root is not qualified",
              ));
              return;
            }
            try {
              options.onChange({ changedPaths: [] });
            } catch (error) {
              requestFatalDisposal(error);
              return;
            }
            schedulePolicyRefresh({
              full: true,
              metadata: true,
              forceMetadata: true,
            });
          } else {
            rootRecoveryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
            retry = true;
          }
        })()
          .finally(() => {
            rootRecoveryPending = false;
            const stillLost = mainSubscription?.rootState?.attachment !== "attached";
            if (fatalDisposalError == null && (retry || stillLost)) {
              scheduleRootRecovery();
            } else {
              rootRecoveryRequested = false;
            }
          });
      }, delay);
      rootRecoveryTimer.unref?.();
    }

    function handleMainBatch(batch, context) {
      if (disposed) return;
      try {
        directorySyncFlushCount += 1;
        if (!Array.isArray(batch?.invalidatedPaths)) {
          throw new TypeError("Watchbound batch invalidatedPaths must be an array");
        }
        reportCoverage(batch.coverage);
        if (root == null) {
          schedulePolicyRefresh({
            full: true,
            metadata: true,
            forceMetadata: true,
          });
          if (batch.rootState?.attachment !== "attached") scheduleRootRecovery();
          options.onChange({ changedPaths: [] });
          return;
        }
        const rootBoundary = (
          batch.coverage.state !== "complete" ||
          batch.pathEncoding === "bytes-only" ||
          batch.pathEncodingCollapsed ||
          batch.rootState?.attachment !== "attached" ||
          batch.invalidatedPaths.some(
            (invalidatedPath) => path.resolve(invalidatedPath) === root,
          )
        );
        const physicalPaths = batch.invalidatedPaths
          .map((invalidatedPath) => path.resolve(invalidatedPath))
          .filter((invalidatedPath) => isWithin(invalidatedPath, root));
        const gitBoundaryChanged = physicalPaths.some(
          (invalidatedPath) => invalidatedPath === path.join(root, ".git"),
        );
        const gitIgnoreChanged = physicalPaths.some(
          (invalidatedPath) => path.basename(invalidatedPath) === ".gitignore",
        );
        if (rootBoundary || gitBoundaryChanged) {
          schedulePolicyRefresh({
            full: true,
            metadata: true,
            forceMetadata: true,
          });
        } else if (gitIgnoreChanged) {
          schedulePolicyRefresh({
            full: true,
            metadata: true,
          });
        }
        if (batch.rootState?.attachment !== "attached") scheduleRootRecovery();
        const changedPaths = rootBoundary || gitBoundaryChanged
          ? null
          : logicalChangedPaths(batch);
        options.onChange(changedPaths == null ? { changedPaths: [] } : { changedPaths });
      } catch (error) {
        context.stop();
        requestFatalDisposal(error);
      }
    }

    function requestFatalDisposal(error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      fatalDisposalError ??= normalizedError;
      if (!mainSubscriptionReady && startupFatalError == null) {
        startupFatalError = normalizedError;
      }
      queueMicrotask(() => {
        void disposeAll({
          reason: "watch-error",
          error: normalizedError,
        }).catch(() => {});
      });
    }

    async function disposeAll(reason = { reason: "disposed" }) {
      if (disposePromise != null) return disposePromise;
      disposed = true;
      cancelGitScan();
      lifecycleAbortController.abort();
      for (const state of Object.values(policyRetryStates)) {
        if (state.timer != null) clearTimeout(state.timer);
        state.timer = null;
      }
      if (rootRecoveryTimer != null) clearTimeout(rootRecoveryTimer);
      rootRecoveryTimer = null;
      for (const entry of metadataSubscriptions.values()) entry.active = false;
      const activeSubscriptions = [...subscriptions];
      subscriptions.clear();
      const metadataDisposal = disposeMetadataSubscriptions();
      const nativeDisposal = Promise.all(activeSubscriptions.map(
        (subscription) => Promise.resolve().then(() => subscription.dispose()),
      ));
      const gitQueryDisposal = Promise.all([...gitQueryWork]);
      disposePromise = Promise.resolve().then(async () => {
        let joinedFailure = null;
        try {
          await Promise.all([
            policyWorkTail.catch(() => {}),
            rootRecoveryWork.catch(() => {}),
            gitQueryDisposal,
            metadataDisposal,
            nativeDisposal,
          ]);
        } catch (error) {
          if (reason.reason === "watch-error") {
            const primary = reason.error instanceof Error
              ? reason.error
              : new Error(String(reason.error));
            joinedFailure = new Error(
              `${primary.message}; additionally, watch disposal failed: ${error.message}`,
              { cause: primary },
            );
            reason = { ...reason, error: joinedFailure };
            fatalDisposalError = joinedFailure;
          } else {
            joinedFailure = error;
          }
        } finally {
          resolveClosed(reason);
        }
        if (joinedFailure != null && reason.reason !== "watch-error") {
          throw joinedFailure;
        }
      });
      return disposePromise;
    }

    // Establish the native subscription before Git policy discovery. Excluding
    // the root keeps establishment bounded while the first snapshot is
    // computed. Watchbound forbids observing a path below an excluded proper
    // prefix, so the first complete replacement removes this root prefix and
    // atomically installs the observed `.git` boundary. A second snapshot then
    // closes the pre-observation window.
    currentExclusions = new Set([""]);
    mainSubscription = await engine.subscribe(lexicalRoot, handleMainBatch, {
      rootPathPolicy: "resolve-physical",
      initialExclusions: [""],
      excludedDirectoryNames: [...excludedDirectoryNames],
      watchLimit: requestedLimit,
      batchWindowMs: 10,
      maxBatchPaths: 1024,
      outputQueueCapacity: 64,
      automaticReconciliation: true,
    });
    subscriptions.add(mainSubscription);
    const resolvedRoot = mainSubscription.resolvedRoot;
    if (
      resolvedRoot?.policy !== "resolve-physical" ||
      resolvedRoot?.pathForm !== "physical" ||
      resolvedRoot?.aliasTracking !== "establishment-snapshot" ||
      typeof resolvedRoot?.physicalPath !== "string" ||
      !path.isAbsolute(resolvedRoot.physicalPath) ||
      !qualificationMatchesPhysicalRoot(
        qualification,
        resolvedRoot.physicalPathBytes,
      )
    ) {
      let resolutionError = new Error(
        "directory-only working-tree watch could not verify its qualified physical root",
      );
      // Remove the provisional subscription before yielding so an early fatal
      // callback cannot race disposeAll() into a second native disposal.
      subscriptions.delete(mainSubscription);
      try {
        await mainSubscription.dispose();
      } catch (error) {
        resolutionError = new Error(
          `${resolutionError.message}; additionally, watch disposal failed: ${error.message}`,
          { cause: resolutionError },
        );
      }
      throw resolutionError;
    }
    root = resolvedRoot.physicalPath;
    mainSubscriptionReady = true;
    if (disposed || startupFatalError != null) {
      let establishmentError = startupFatalError ?? new Error(
        "directory-only working-tree watch stopped during establishment",
      );
      subscriptions.delete(mainSubscription);
      try {
        await mainSubscription.dispose();
      } catch (error) {
        establishmentError = new Error(
          `${establishmentError.message}; additionally, watch disposal failed: ` +
            `${error.message}`,
          { cause: establishmentError },
        );
      }
      throw establishmentError;
    }
    exclusionGeneration = mainSubscription.exclusionGeneration;
    schedulePolicyRefresh({ full: true });
    await policyWorkTail;
    if (fatalDisposalError != null) {
      await disposeAll({ reason: "watch-error", error: fatalDisposalError });
      throw fatalDisposalError;
    }
    schedulePolicyRefresh({ full: true, metadata: true });
    await policyWorkTail;
    if (fatalDisposalError != null) {
      await disposeAll({ reason: "watch-error", error: fatalDisposalError });
      throw fatalDisposalError;
    }
    if (!workingTreeCoverageEstablished) {
      const establishmentError = new Error(
        "directory-only working-tree watch could not replace generation-zero " +
          "exclusions during establishment",
        startupPolicyReplacementError == null
          ? undefined
          : { cause: startupPolicyReplacementError },
      );
      await disposeAll({ reason: "watch-error", error: establishmentError });
      throw establishmentError;
    }
    if (
      rootRecoveryRequested ||
      mainSubscription.rootState?.attachment === "lost"
    ) {
      scheduleRootRecovery();
    }

    return {
      // Watchbound is recursive for included paths. Reporting partial recursive
      // coverage deliberately preserves Codex's existing focus recovery.
      coverage: { recursive: false, typedPathChanges: false },
      path: options.path,
      closed,
      dispose: () => disposeAll(),
      codexLinuxDirectoryWatchCount: () => {
        let count = 0;
        for (const subscription of subscriptions) {
          count += subscription.stats().watchedDirectories;
        }
        return count + metadataSubscriptions.size;
      },
      codexLinuxDirectoryWatchBudget: () => {
        const runtime = engine.runtimeStats();
        return { active: runtime.nativeWatches, limit: requestedLimit };
      },
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
        !name.includes("\0") &&
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

const WATCHBOUND_HELPER_SOURCE =
  `${codexLinuxStartDirectoryOnlyWorkingTreeWatch.toString()};`;

function countSubstring(source, value) {
  return source.split(value).length - 1;
}

function countPattern(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)].length;
}

function patternMatches(source, pattern) {
  pattern.lastIndex = 0;
  return [...source.matchAll(pattern)];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function watchboundLocalBranch(optionsName, settings) {
  return (
    `if(process.platform===\`linux\`&&${optionsName}.recursive&&` +
    `${optionsName}.renameEventHandling===\`changed-path-with-parent-directory\`)` +
    `{let ${WATCHBOUND_RESULT_NAME}=await ${HELPER_NAME}(` +
    `this,${optionsName},${JSON.stringify(settings)},` +
    `${optionsName}[Symbol.for(\`${PARCEL_FALLBACK_SYMBOL_KEY}\`)]);` +
    `if(${WATCHBOUND_RESULT_NAME}!=null)return ${WATCHBOUND_RESULT_NAME};}`
  );
}

function completedLocalFileWatchMethod(settings) {
  const branch =
    "if\\(process\\.platform===`linux`&&\\k<options>\\.recursive&&" +
    "\\k<options>\\.renameEventHandling===`changed-path-with-parent-directory`\\)\\{" +
    `let ${WATCHBOUND_RESULT_NAME}=await ${HELPER_NAME}\\(this,\\k<options>,` +
    `${escapeRegExp(JSON.stringify(settings))},` +
    `\\k<options>\\[Symbol\\.for\\(\`${escapeRegExp(PARCEL_FALLBACK_SYMBOL_KEY)}\`\\)\\]\\);` +
    `if\\(${WATCHBOUND_RESULT_NAME}!=null\\)return ${WATCHBOUND_RESULT_NAME};\\}`;
  return new RegExp(
    `${LOCAL_FILE_WATCH_METHOD_PREFIX}${branch}${LOCAL_FILE_WATCH_CURRENT_BODY}`,
    "gu",
  );
}

function currentLocalHostClassForMethod(source, classMatches, methodMatches) {
  if (classMatches.length !== 1 || methodMatches.length !== 1) return null;
  const [classMatch] = classMatches;
  const [methodMatch] = methodMatches;
  const classTokenStart = source.indexOf("=class{", classMatch.index);
  if (classTokenStart < 0) return null;
  const classOpen = classTokenStart + "=class".length;
  const classClose = findMatchingBrace(source, classOpen);
  return classClose >= 0 &&
    methodMatch.index > classOpen &&
    methodMatch.index < classClose
    ? classMatch.groups?.localHostClass ?? null
    : null;
}

function classifyCurrentBundle(bundlePath, source, settings = normalizedSettings()) {
  const pristineLocalMatches = patternMatches(source, LOCAL_FILE_WATCH_METHOD);
  const completedLocalMatches = patternMatches(
    source,
    completedLocalFileWatchMethod(settings),
  );
  const currentLocalHostMatches = patternMatches(source, CURRENT_LOCAL_HOST_CLASS);
  const localHostClass = currentLocalHostClassForMethod(
    source,
    currentLocalHostMatches,
    [...pristineLocalMatches, ...completedLocalMatches],
  );
  const helperDefinitionCount = countSubstring(source, `function ${HELPER_NAME}(`);
  const helperExactCount = countSubstring(source, WATCHBOUND_HELPER_SOURCE);
  const branchCallCount = countSubstring(source, `${HELPER_NAME}(this,`);
  const markerCount = countSubstring(source, PARCEL_WATCH_MARKER);
  const rawRouteLookalikeCount = patternMatches(source, PARCEL_WORKING_TREE_WATCH).length;
  const pristineRouteMatches = patternMatches(source, CURRENT_PARCEL_ROUTE_CONTRACT);
  const completedRouteMatches = patternMatches(source, CURRENT_WATCHBOUND_ROUTE_CONTRACT);
  const parcelHelperMatches = patternMatches(source, CURRENT_PARCEL_HELPER);
  const correlatedPristineRouteCount = pristineRouteMatches.filter((route) =>
    parcelHelperMatches.some((helper) =>
      helper.groups?.helperName === route.groups?.routeHelper &&
      route.groups?.localHostClass === localHostClass
    )
  ).length;
  const correlatedCompletedRouteCount = completedRouteMatches.filter(
    (route) =>
      route.groups?.localHostClass === localHostClass &&
      parcelHelperMatches.some(
        (helper) => helper.groups?.helperName === route.groups?.routeHelper,
      ),
  ).length;
  const parcelImportCount = countSubstring(source, "@parcel/watcher");
  const relevant =
    pristineLocalMatches.length > 0 ||
    completedLocalMatches.length > 0 ||
    currentLocalHostMatches.length > 0 ||
    helperDefinitionCount > 0 ||
    helperExactCount > 0 ||
    branchCallCount > 0 ||
    markerCount > 0 ||
    rawRouteLookalikeCount > 0 ||
    pristineRouteMatches.length > 0 ||
    completedRouteMatches.length > 0 ||
    parcelHelperMatches.length > 0 ||
    parcelImportCount > 0;
  return {
    branchCallCount,
    bundlePath,
    completedLocalCount: completedLocalMatches.length,
    completedRouteCount: completedRouteMatches.length,
    correlatedCompletedRouteCount,
    correlatedPristineRouteCount,
    currentLocalHostCount: currentLocalHostMatches.length,
    helperDefinitionCount,
    helperExactCount,
    localHostClass,
    markerCount,
    parcelHelperCount: parcelHelperMatches.length,
    parcelImportCount,
    pristineLocalCount: pristineLocalMatches.length,
    pristineRouteCount: pristineRouteMatches.length,
    rawRouteLookalikeCount,
    relevant,
    source,
    startsWithExactHelper: source.startsWith(WATCHBOUND_HELPER_SOURCE),
  };
}

function hasPristineLocalContract(record) {
  return record.pristineLocalCount === 1 &&
    record.completedLocalCount === 0 &&
    record.currentLocalHostCount === 1 &&
    record.localHostClass != null &&
    record.helperDefinitionCount === 0 &&
    record.helperExactCount === 0 &&
    record.branchCallCount === 0;
}

function hasCompletedLocalContract(record) {
  return record.pristineLocalCount === 0 &&
    record.completedLocalCount === 1 &&
    record.currentLocalHostCount === 1 &&
    record.localHostClass != null &&
    record.helperDefinitionCount === 1 &&
    record.helperExactCount === 1 &&
    record.branchCallCount === 1 &&
    record.startsWithExactHelper;
}

function hasNoParcelRouteContract(record) {
  return record.markerCount === 0 &&
    record.rawRouteLookalikeCount === 0 &&
    record.pristineRouteCount === 0 &&
    record.completedRouteCount === 0 &&
    record.parcelHelperCount === 0 &&
    record.parcelImportCount === 0;
}

function hasPristineWorkerRouteContract(record) {
  return record.pristineRouteCount === 1 &&
    record.correlatedPristineRouteCount === 1 &&
    record.completedRouteCount === 0 &&
    record.markerCount === 0 &&
    record.rawRouteLookalikeCount === 1 &&
    record.parcelHelperCount === 1 &&
    record.parcelImportCount === 1;
}

function hasCompletedWorkerRouteContract(record) {
  return record.pristineRouteCount === 0 &&
    record.completedRouteCount === 1 &&
    record.correlatedCompletedRouteCount === 1 &&
    record.markerCount === 1 &&
    record.rawRouteLookalikeCount === 0 &&
    record.parcelHelperCount === 1 &&
    record.parcelImportCount === 1;
}

function currentContractReason(records, bundleCount) {
  const relevant = records.filter(({ relevant }) => relevant);
  const targetNames = relevant.map(({ bundlePath }) => path.basename(bundlePath));
  const parcelContractCount = relevant.reduce(
    (count, record) => count + record.pristineRouteCount + record.completedRouteCount,
    0,
  );
  const workerParcelContractCount = relevant
    .filter(({ bundlePath }) => path.basename(bundlePath) === "worker.js")
    .reduce(
      (count, record) => count + record.pristineRouteCount + record.completedRouteCount,
      0,
    );
  const markerCount = relevant.reduce((count, record) => count + record.markerCount, 0);
  const correlatedRouteCount = relevant.reduce(
    (count, record) => count + record.correlatedPristineRouteCount,
    0,
  );
  const lookalikeCount = relevant.reduce(
    (count, record) => count + record.rawRouteLookalikeCount,
    0,
  );
  const helpers = relevant.reduce(
    (count, record) => count + record.helperDefinitionCount,
    0,
  );
  const branches = relevant.reduce((count, record) => count + record.branchCallCount, 0);
  return (
    "Current 26.803.41515 working-tree contract rejected: " +
    `Found ${relevant.length} current local startFileWatch bundles ` +
    `(${targetNames.join(", ") || "none"}), ${parcelContractCount} Parcel route contracts, ` +
    `and ${workerParcelContractCount} in worker.js across ${bundleCount} build bundles; ` +
    `${correlatedRouteCount} route/helper correlations, ${lookalikeCount} raw route lookalikes, ` +
    `${markerCount} Watchbound route markers, ` +
    `${helpers} helpers, and ${branches} branches`
  );
}

function watchboundWorkingTreeRoute(groups) {
  return (
    `startWorkingTreeWatch:(${groups.routeHost},${groups.routeOptions})=>` +
    `${groups.routeHost}.isLocal?process.platform===\`linux\`?` +
    `/*${PARCEL_WATCH_MARKER}*/${groups.localHost}.startFileWatch({` +
    `...${groups.routeOptions},[Symbol.for(\`${PARCEL_FALLBACK_SYMBOL_KEY}\`)]:()=>` +
    `${groups.routeHelper}(${groups.routeOptions},{ignoredPaths:[` +
    `${groups.pathApi}.posix.join(${groups.routeOptions}.path,\`.git\`)]})}):` +
    `${groups.localHost}.startFileWatch(${groups.routeOptions}):` +
    `${groups.routeHost}.startFileWatch(${groups.routeOptions})`
  );
}

function replaceCurrentParcelRoute(source) {
  CURRENT_PARCEL_ROUTE_CONTRACT.lastIndex = 0;
  return source.replace(CURRENT_PARCEL_ROUTE_CONTRACT, (...args) => {
    const groups = args[args.length - 1];
    return `${groups.routePrefix}${watchboundWorkingTreeRoute(groups)}`;
  });
}

function preparePristineBundle(record, settings) {
  LOCAL_FILE_WATCH_METHOD.lastIndex = 0;
  const [localMatch] = [...record.source.matchAll(LOCAL_FILE_WATCH_METHOD)];
  const optionsName = localMatch.groups.options;
  const insertionIndex = localMatch.index + localMatch[0].length;
  const withBranch =
    record.source.slice(0, insertionIndex) +
    watchboundLocalBranch(optionsName, settings) +
    record.source.slice(insertionIndex);
  const withRoute = path.basename(record.bundlePath) === "worker.js"
    ? replaceCurrentParcelRoute(withBranch)
    : withBranch;
  return WATCHBOUND_HELPER_SOURCE + withRoute;
}

function patchWorkerSource(source, settings) {
  const currentSettings = settings ?? normalizedSettings();
  const hasWorkerSignals =
    countPattern(source, CURRENT_PARCEL_HELPER) > 0 ||
    source.includes(PARCEL_WATCH_MARKER) ||
    countPattern(source, PARCEL_WORKING_TREE_WATCH) > 0;
  const bundlePath = hasWorkerSignals ? "worker.js" : "src-current.js";
  const record = classifyCurrentBundle(bundlePath, source, currentSettings);
  const routePristine = bundlePath === "worker.js"
    ? hasPristineWorkerRouteContract(record)
    : hasNoParcelRouteContract(record);
  const routeCompleted = bundlePath === "worker.js"
    ? hasCompletedWorkerRouteContract(record)
    : hasNoParcelRouteContract(record);

  if (hasCompletedLocalContract(record) && routeCompleted) {
    return { source, matched: 1, changed: 0, reason: null };
  }
  if (hasPristineLocalContract(record) && routePristine) {
    const patchedSource = preparePristineBundle(record, currentSettings);
    const completed = classifyCurrentBundle(bundlePath, patchedSource, currentSettings);
    const completedRoute = bundlePath === "worker.js"
      ? hasCompletedWorkerRouteContract(completed)
      : hasNoParcelRouteContract(completed);
    if (hasCompletedLocalContract(completed) && completedRoute) {
      return { source: patchedSource, matched: 1, changed: 1, reason: null };
    }
  }

  return {
    source,
    matched: 0,
    changed: 0,
    reason: currentContractReason([record], 1),
  };
}

function findLocalFileWatchBundles(extractedDir, settings) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { targets: [], reason: ".vite/build directory not found" };
  }

  const bundlePaths = fs.readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(buildDir, entry.name))
    .sort();
  const records = bundlePaths.map((bundlePath) => classifyCurrentBundle(
    bundlePath,
    fs.readFileSync(bundlePath, "utf8"),
    settings,
  ));
  const relevant = records.filter(({ relevant }) => relevant);
  const workerRecords = relevant.filter(
    ({ bundlePath }) => path.basename(bundlePath) === "worker.js",
  );
  const srcRecords = relevant.filter(({ bundlePath }) =>
    /^src-[A-Za-z0-9_-]+\.js$/u.test(path.basename(bundlePath)),
  );
  const exactPair = relevant.length === 2 &&
    workerRecords.length === 1 &&
    srcRecords.length === 1;
  if (!exactPair) {
    return { targets: [], reason: currentContractReason(records, bundlePaths.length) };
  }

  const worker = workerRecords[0];
  const src = srcRecords[0];
  const pristine =
    hasPristineLocalContract(worker) &&
    hasPristineWorkerRouteContract(worker) &&
    hasPristineLocalContract(src) &&
    hasNoParcelRouteContract(src);
  const completed =
    hasCompletedLocalContract(worker) &&
    hasCompletedWorkerRouteContract(worker) &&
    hasCompletedLocalContract(src) &&
    hasNoParcelRouteContract(src);
  if (!pristine && !completed) {
    return { targets: [], reason: currentContractReason(records, bundlePaths.length) };
  }

  const targets = [src, worker].map((record) => ({
    bundlePath: record.bundlePath,
    source: record.source,
    result: completed
      ? { source: record.source, matched: 1, changed: 0, reason: null }
      : {
        source: preparePristineBundle(record, settings),
        matched: 1,
        changed: 1,
        reason: null,
      },
  }));
  const preparedAreComplete = targets.every(({ bundlePath, result }) => {
    const prepared = classifyCurrentBundle(bundlePath, result.source, settings);
    return hasCompletedLocalContract(prepared) && (
      path.basename(bundlePath) === "worker.js"
        ? hasCompletedWorkerRouteContract(prepared)
        : hasNoParcelRouteContract(prepared)
    );
  });
  if (!preparedAreComplete) {
    return { targets: [], reason: currentContractReason(records, bundlePaths.length) };
  }
  return { targets, reason: null };
}

function patchWorker(extractedDir, context = {}, io = {}) {
  const discovery = findLocalFileWatchBundles(extractedDir, normalizedSettings(context));
  if (discovery.targets.length !== 2) {
    const reason = discovery.reason ?? "Current local startFileWatch bundles not found";
    console.warn(`WARN: ${reason} - skipping directory-only working-tree watch feature`);
    return { matched: 0, changed: 0, reason };
  }

  try {
    writeUtf8FileCandidatesTransactionally(
      discovery.targets.map(({ bundlePath, source, result }) => ({
        filePath: bundlePath,
        source,
        patchedSource: result.source,
      })),
      {
        description: "Current Watchbound bundle mutation",
        readFileSync: io.readFileSync ?? fs.readFileSync,
        writeFileSync: io.writeFileSync ?? fs.writeFileSync,
      },
    );
  } catch (error) {
    if (isPatchIntegrityError(error)) {
      throw error;
    }
    const reason =
      `Could not write current Watchbound bundle transaction: ` +
      `${error instanceof Error ? error.message : String(error)}`;
    console.warn(`WARN: ${reason} - skipping directory-only working-tree watch feature`);
    return { matched: 0, changed: 0, reason };
  }

  const changed = discovery.targets.reduce((count, { result }) => count + result.changed, 0);
  return {
    matched: discovery.targets.length,
    changed,
    reason: null,
    targets: discovery.targets.map(({ bundlePath }) => path.relative(extractedDir, bundlePath)),
  };
}

function stageWatchbound(extractedDir) {
  const helper = path.join(__dirname, "watchbound-package.js");
  try {
    const output = childProcess.execFileSync(
      process.execPath,
      [helper, "--stage", extractedDir],
      {
        encoding: "utf8",
        env: process.env,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return JSON.parse(output);
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    if (error?.status === 86 && stderr.includes("[PATCH_INTEGRITY_FAILURE]")) {
      throw new PatchIntegrityError(
        `Watchbound package helper integrity failure: ${stderr}`,
        { cause: error },
      );
    }
    throw error;
  }
}

const descriptors = [
  {
    id: "watchbound-package",
    phase: "extracted-app:pre-webview",
    order: 20_930,
    ciPolicy: "opt-in",
    apply: stageWatchbound,
    status: (result) => ({
      status: result?.changed
        ? "applied"
        : result?.alreadyApplied
          ? "already-applied"
          : "skipped-optional",
      reason: result == null
        ? "Watchbound package staging returned no result"
        : `watchbound ${result.version} (${result.source})`,
    }),
  },
  {
    id: "worker-directory-watch",
    phase: "extracted-app:pre-webview",
    order: 20_940,
    ciPolicy: "opt-in",
    apply: patchWorker,
    status: (result, warnings) => {
      if (result?.matched !== 2) {
        return { status: "skipped-optional", reason: result?.reason ?? warnings[0] ?? null };
      }
      return result.changed > 0 ? "applied" : "already-applied";
    },
  },
];

module.exports = {
  DEFAULT_IGNORED_DIRECTORY_NAMES,
  DEFAULT_MAX_WATCHES,
  HELPER_NAME,
  LOCAL_FILE_WATCH_METHOD,
  PARCEL_FALLBACK_SYMBOL_KEY,
  PARCEL_WATCH_MARKER,
  PARCEL_WORKING_TREE_WATCH,
  QUALIFICATION_WARNINGS_SYMBOL_KEY,
  REPORT_SHIM_SYMBOL_KEY,
  WATCHBOUND_VERSION,
  codexLinuxStartDirectoryOnlyWorkingTreeWatch,
  descriptors,
  findLocalFileWatchBundles,
  normalizedSettings,
  patchWorker,
  patchWorkerSource,
  stageWatchbound,
};
