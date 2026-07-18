#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { spawnSync } = childProcess;
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DEFAULT_IGNORED_DIRECTORY_NAMES,
  codexLinuxStartDirectoryOnlyWorkingTreeWatch,
  descriptors,
  normalizedSettings,
  patchWorker,
  patchWorkerSource,
} = require("./patch.js");

const BUDGET_KEY = Symbol.for("codex-linux.directory-only-working-tree-watch.budget");

function localWorkerSource() {
  return [
    "var LocalHost=class{",
    "async platformPath(){return E.default.posix}",
    "async startFileWatch(e){let t=jH(),n=!1,r=await this.platformPath(),",
    "i=(0,w.watch)(this.getFileSystemPath(e.path),{recursive:e.recursive},()=>{});",
    "return{coverage:{recursive:e.recursive},path:e.path,closed:t.promise}}",
    "};",
  ].join("");
}

function configuration(overrides = {}) {
  return {
    maxWatches: 8192,
    honorGitIgnore: false,
    ignoredDirectoryNames: [],
    ...overrides,
  };
}

function fakeHost() {
  return {
    getFileSystemPath: (value) => value,
    platformPath: async () => path.posix,
  };
}

function resetBudget() {
  const budget = globalThis[BUDGET_KEY];
  assert.ok(budget == null || budget.active === 0, "directory watches leaked across a test");
  assert.ok(
    budget == null || budget.listeners.size === 0,
    "directory-watch budget listeners leaked across a test",
  );
  assert.ok(
    budget == null || budget.partialListeners.size === 0,
    "partial directory-watch listeners leaked across a test",
  );
  assert.ok(
    budget == null || (budget.reserved === 0 && budget.reservations.size === 0),
    "directory-watch reservations leaked across a test",
  );
  assert.ok(
    budget == null || budget.recoveringOwners.size === 0,
    "directory-watch recovery owners leaked across a test",
  );
  assert.ok(
    budget == null || budget.suspendedOwners.size === 0,
    "directory-watch suspended owners leaked across a test",
  );
  delete globalThis[BUDGET_KEY];
}

function captureWarnings(callback) {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { value: callback(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

function captureRetryTimers() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const records = [];
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay < 1000) return originalSetTimeout(callback, delay, ...args);
    const handle = { unref() {} };
    records.push({
      callback: () => callback(...args),
      cleared: false,
      delay,
      fired: false,
      handle,
    });
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const record = records.find((candidate) => candidate.handle === handle);
    if (record != null) {
      record.cleared = true;
      return;
    }
    originalClearTimeout(handle);
  };
  return {
    fire(record) {
      assert.equal(record.cleared, false, "cannot fire a cleared retry timer");
      assert.equal(record.fired, false, "cannot fire a retry timer twice");
      record.fired = true;
      record.callback();
    },
    live: () => records.filter((record) => !record.cleared && !record.fired),
    records,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

function withTempTree(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-"));
  return Promise.resolve()
    .then(() => callback(root))
    .finally(() => {
      fs.rmSync(root, { recursive: true, force: true });
      resetBudget();
    });
}

test("feature patch targets only the local recursive working-tree host", () => {
  const source = localWorkerSource();
  const settings = normalizedSettings();
  const first = patchWorkerSource(source, settings);

  assert.equal(first.matched, 1);
  assert.equal(first.changed, 1);
  assert.match(first.source, /function codexLinuxStartDirectoryOnlyWorkingTreeWatch\(/);
  assert.match(
    first.source,
    /process\.platform===`linux`&&e\.recursive&&e\.renameEventHandling===`changed-path-with-parent-directory`/,
  );
  assert.match(first.source, /return codexLinuxStartDirectoryOnlyWorkingTreeWatch\(this,e,/);
  assert.match(first.source, /\(0,w\.watch\)\(this\.getFileSystemPath/);

  const second = patchWorkerSource(first.source, settings);
  assert.equal(second.matched, 1);
  assert.equal(second.changed, 0);
  assert.equal(second.source, first.source);
});

test("feature patch reports drift instead of patching an ambiguous worker", () => {
  const source = `${localWorkerSource()}${localWorkerSource()}`;
  const result = patchWorkerSource(source, normalizedSettings());

  assert.equal(result.matched, 0);
  assert.equal(result.changed, 0);
  assert.match(result.reason, /Found 2 local startFileWatch implementations/);
  assert.equal(descriptors[0].status(result, []).status, "skipped-optional");
});

test("feature discovers the local host in the current hashed build bundle", async () => {
  await withTempTree((root) => {
    const buildDir = path.join(root, ".vite", "build");
    const workerPath = path.join(buildDir, "worker.js");
    const localHostPath = path.join(buildDir, "src-current.js");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(workerPath, "var gitWorker={startFileWatch(){}};");
    fs.writeFileSync(localHostPath, localWorkerSource());

    const first = patchWorker(root);
    assert.equal(first.matched, 1);
    assert.equal(first.changed, 1);
    assert.equal(first.target, path.join(".vite", "build", "src-current.js"));
    assert.equal(fs.readFileSync(workerPath, "utf8"), "var gitWorker={startFileWatch(){}};");
    const patched = fs.readFileSync(localHostPath, "utf8");
    assert.match(patched, /function codexLinuxStartDirectoryOnlyWorkingTreeWatch\(/);
    assert.doesNotThrow(() => new Function(patched));

    const second = patchWorker(root);
    assert.equal(second.matched, 1);
    assert.equal(second.changed, 0);
    assert.equal(second.target, path.join(".vite", "build", "src-current.js"));
  });
});

test("feature rejects multiple local host implementations across build bundles", async () => {
  await withTempTree((root) => {
    const buildDir = path.join(root, ".vite", "build");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, "src-first.js"), localWorkerSource());
    fs.writeFileSync(path.join(buildDir, "src-second.js"), localWorkerSource());

    const originalWarn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = patchWorker(root);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(result.matched, 0);
    assert.equal(result.changed, 0);
    assert.match(result.reason, /Found 2 local startFileWatch implementations across 2 build bundles/);
  });
});

test("feature settings are bounded and reject path-shaped ignore names", () => {
  assert.deepEqual(normalizedSettings(), {
    maxWatches: 8192,
    honorGitIgnore: true,
    ignoredDirectoryNames: [],
  });
  assert.deepEqual(DEFAULT_IGNORED_DIRECTORY_NAMES, []);
  const { value, warnings } = captureWarnings(() => normalizedSettings({
    feature: {
      settings: {
        maxWatches: 100_000,
        honorGitIgnore: false,
        ignoredDirectoryNames: ["node_modules", "nested/cache", "..", "node_modules"],
      },
    },
  }));
  assert.deepEqual(
    value,
    {
      maxWatches: 65_536,
      honorGitIgnore: false,
      ignoredDirectoryNames: ["node_modules"],
    },
  );
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /maxWatches is capped at 65536/);
  assert.match(warnings[1], /ignoredDirectoryNames contains invalid names/);
});

test("invalid feature settings warn and fall back to safe defaults", () => {
  const { value, warnings } = captureWarnings(() => normalizedSettings({
    feature: {
      settings: {
        maxWatches: 0,
        honorGitIgnore: "false",
        ignoredDirectoryNames: "node_modules",
      },
    },
  }));

  assert.deepEqual(value, {
    maxWatches: 8192,
    honorGitIgnore: true,
    ignoredDirectoryNames: [],
  });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /maxWatches must be a positive integer/);
  assert.match(warnings[1], /honorGitIgnore must be a boolean/);
  assert.match(warnings[2], /ignoredDirectoryNames must be an array/);
});

test("Git ignore probes are asynchronous, bounded, and fall back safely after timeout", async () => {
  await withTempTree(async (root) => {
    const originalExecFile = childProcess.execFile;
    const calls = [];
    let eventLoopTurnObserved = false;
    setImmediate(() => {
      eventLoopTurnObserved = true;
    });
    childProcess.execFile = (command, args, options, callback) => {
      calls.push({ command, args, options });
      setTimeout(() => {
        callback(Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGKILL",
        }), "", "");
      }, 10);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.ok(calls.length > 0);
      assert.equal(eventLoopTurnObserved, true);
      for (const call of calls) {
        assert.equal(call.command, "git");
        assert.deepEqual(call.args.slice(0, 2), ["-c", "core.fsmonitor=false"]);
        assert.equal(call.options.timeout, 5000);
        assert.equal(call.options.killSignal, "SIGKILL");
      }
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
    } finally {
      await session?.dispose();
      childProcess.execFile = originalExecFile;
    }
  });
});

test("a transient Git ignore query failure is retried and prunes fallback coverage", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(root, "ignored", "deep"), { recursive: true });
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    let remainingIgnoreFailures = 2;
    let rootWatchCallback = null;
    fs.watch = (directory, options, callback) => {
      const watcher = originalWatch(directory, options, callback);
      if (path.resolve(directory) === path.resolve(root)) rootWatchCallback = callback;
      return watcher;
    };
    childProcess.execFile = (command, args, options, callback) => {
      if (remainingIgnoreFailures > 0 && args.includes("ls-files")) {
        remainingIgnoreFailures -= 1;
        setImmediate(() => {
          callback(Object.assign(new Error("timed out"), {
            code: null,
            killed: true,
            signal: "SIGKILL",
          }), "", "");
        });
        return;
      }
      return originalExecFile(command, args, options, callback);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => retryTimers.live().length === 1,
        "second Git ignore retry was not scheduled",
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);
      assert.equal(retryTimers.live()[0].delay, 2000);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 1,
        "recovered Git ignore query did not prune fallback watches",
      );
      assert.deepEqual(retryTimers.live(), []);

      remainingIgnoreFailures = 1;
      rootWatchCallback("change", ".gitignore");
      await waitFor(
        () => retryTimers.live().length === 1,
        "a later Git ignore failure did not schedule another retry",
      );
      assert.equal(
        retryTimers.live()[0].delay,
        1000,
        "successful Git ignore recovery did not reset the retry backoff",
      );
    } finally {
      childProcess.execFile = originalExecFile;
      fs.watch = originalWatch;
      await session?.dispose();
      retryTimers.restore();
    }
  });
});

test("Git metadata target discovery retries after a transient timeout", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(root, "ignored"));
    const trackedPath = path.join(root, "ignored", "tracked.txt");
    fs.writeFileSync(trackedPath, "before\n");
    const originalExecFile = childProcess.execFile;
    let remainingTimeouts = 2;
    childProcess.execFile = (command, args, options, callback) => {
      if (args.includes("rev-parse") && remainingTimeouts > 0) {
        remainingTimeouts -= 1;
        setImmediate(() => {
          callback(Object.assign(new Error("timed out"), {
            code: null,
            killed: true,
            signal: "SIGKILL",
          }), "", "");
        });
        return;
      }
      return originalExecFile(command, args, options, callback);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      childProcess.execFile = originalExecFile;
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      await waitFor(
        () => session.codexLinuxDirectoryWatchBudget().active >= 3,
        "Git metadata targets were not rediscovered after the timeout",
      );
      assert.equal(spawnSync("git", ["-C", root, "add", "-f", "ignored/tracked.txt"]).status, 0);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "the recovered index watch did not restore a force-added directory",
      );
    } finally {
      childProcess.execFile = originalExecFile;
      await session?.dispose();
    }
  });
});

test("a watcher closed during startup does not leak its budget listener", async () => {
  await withTempTree(async (root) => {
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    let pendingGitCallback = null;
    let rootWatcher = null;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    childProcess.execFile = (_command, _args, _options, callback) => {
      pendingGitCallback = callback;
      return new FakeWatcher();
    };
    fs.watch = (directory) => {
      const watcher = new FakeWatcher();
      if (path.resolve(directory) === path.resolve(root)) rootWatcher = watcher;
      return watcher;
    };
    let session;
    try {
      const startPromise = codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      await waitFor(
        () => rootWatcher != null && pendingGitCallback != null,
        "watcher startup did not reach the pending Git query",
      );
      rootWatcher.emit("error", new Error("root watcher failed during startup"));
      pendingGitCallback(Object.assign(new Error("not a repository"), { code: 128 }), "", "");
      session = await startPromise;
      assert.equal(globalThis[BUDGET_KEY].listeners.size, 0);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
    } finally {
      await session?.dispose();
      childProcess.execFile = originalExecFile;
      fs.watch = originalWatch;
    }
  });
});

test("topology events coalesce while a reconciliation is queued or running", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return new FakeWatcher();
    };
    let session;
    let releaseFirstQuery = null;
    const calls = [];
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      childProcess.execFile = (command, args, options, callback) => {
        calls.push(args);
        if (releaseFirstQuery == null) {
          releaseFirstQuery = () => originalExecFile(command, args, options, callback);
          return new FakeWatcher();
        }
        return originalExecFile(command, args, options, callback);
      };

      const rootCallback = callbacks.get(path.resolve(root));
      rootCallback("change", ".gitignore");
      await waitFor(() => releaseFirstQuery != null, "topology reconciliation did not start");
      for (let index = 0; index < 4; index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        rootCallback("change", ".gitignore");
      }
      assert.equal(calls.length, 1, "events appended work while reconciliation was blocked");

      releaseFirstQuery();
      await waitFor(
        () => calls.filter((args) => args.includes("ls-files")).length >= 2,
        "the coalesced follow-up reconciliation did not run",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        calls.filter((args) => args.includes("ls-files")).length,
        2,
        "more than one follow-up reconciliation was queued",
      );
    } finally {
      childProcess.execFile = originalExecFile;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("rename-driven directory syncs queue at most one follow-up flush", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return new FakeWatcher();
    };
    let firstQueryBlocked = false;
    let releaseFirstQuery = null;
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      childProcess.execFile = (command, args, options, callback) => {
        if (!firstQueryBlocked) {
          firstQueryBlocked = true;
          releaseFirstQuery = () => {
            releaseFirstQuery = null;
            return originalExecFile(command, args, options, callback);
          };
          return new FakeWatcher();
        }
        return originalExecFile(command, args, options, callback);
      };

      const rootCallback = callbacks.get(path.resolve(root));
      fs.mkdirSync(path.join(root, "first"));
      rootCallback("rename", "first");
      await waitFor(() => releaseFirstQuery != null, "directory sync did not reach Git refresh");

      for (const name of ["second", "third", "fourth"]) {
        fs.mkdirSync(path.join(root, name));
        rootCallback("rename", name);
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(session.codexLinuxDirectorySyncFlushCount(), 1);

      releaseFirstQuery();
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 5,
        "coalesced directory-sync follow-up did not cover every pending path",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(
        session.codexLinuxDirectorySyncFlushCount(),
        2,
        "rename events queued redundant directory-sync flushes",
      );
    } finally {
      releaseFirstQuery?.();
      childProcess.execFile = originalExecFile;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a transient rename-path metadata failure restores coverage through reconciliation", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const child = path.join(root, "child");
    fs.mkdirSync(path.join(child, "nested"), { recursive: true });
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    const originalLstat = fs.lstatSync;
    const callbacks = new Map();
    const changes = [];
    let failChildMetadata = false;
    let childMetadataFailures = 0;
    let gitIgnoreRefreshes = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return new FakeWatcher();
    };
    fs.lstatSync = (candidate, ...args) => {
      if (
        failChildMetadata &&
        childMetadataFailures === 0 &&
        path.resolve(candidate) === child
      ) {
        childMetadataFailures += 1;
        const error = new Error("metadata temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalLstat.call(fs, candidate, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: (change) => changes.push(change),
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);

      childProcess.execFile = (command, args, options, callback) => {
        if (args.includes("ls-files")) gitIgnoreRefreshes += 1;
        return originalExecFile(command, args, options, callback);
      };
      failChildMetadata = true;
      callbacks.get(path.resolve(root))("rename", "child");
      await waitFor(
        () => (
          changes.some((change) => change.changedPaths.length === 0) &&
          gitIgnoreRefreshes > 0
        ),
        "transient metadata failure did not schedule full reconciliation",
      );
      assert.equal(childMetadataFailures, 1);
      assert.equal(
        session.codexLinuxDirectoryWatchCount(),
        3,
        "transient metadata failure did not restore the watched subtree",
      );
    } finally {
      childProcess.execFile = originalExecFile;
      fs.lstatSync = originalLstat;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a scan-time metadata failure after a rename schedules one full reconciliation", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    const originalWatch = fs.watch;
    const originalLstat = fs.lstatSync;
    const callbacks = new Map();
    let childMetadataReads = 0;
    let injectFailure = false;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return new FakeWatcher();
    };
    fs.lstatSync = (candidate, ...args) => {
      if (injectFailure && path.resolve(candidate) === child) {
        childMetadataReads += 1;
        if (childMetadataReads === 3) {
          const error = new Error("metadata temporarily stale during scan");
          error.code = "ESTALE";
          throw error;
        }
      }
      return originalLstat.call(fs, candidate, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);

      fs.mkdirSync(path.join(child, "nested"), { recursive: true });
      injectFailure = true;
      callbacks.get(path.resolve(root))("rename", "child");
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 3,
        "scan-time metadata failure dropped the rename-driven topology update",
      );
      assert.ok(childMetadataReads >= 4, "full reconciliation did not retry child metadata");
    } finally {
      fs.lstatSync = originalLstat;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a rename-path child watch failure schedules topology recovery", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    const originalWatch = fs.watch;
    const callbacks = new Map();
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      if (resolved === child) {
        childWatchAttempts += 1;
        if (childWatchAttempts === 1) {
          const error = new Error("child watch is temporarily unavailable");
          error.code = "EIO";
          throw error;
        }
      }
      callbacks.set(resolved, callback);
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      fs.mkdirSync(child);
      callbacks.get(path.resolve(root))("rename", "child");
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "rename-path watch failure did not recover through full reconciliation",
      );
      assert.equal(childWatchAttempts, 2);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a startup root revalidation failure schedules a bounded full-tree retry", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "child", "nested"), { recursive: true });
    const originalStat = fs.statSync;
    const retryTimers = captureRetryTimers();
    let rootMetadataReads = 0;
    fs.statSync = (candidate, ...args) => {
      if (path.resolve(candidate) === path.resolve(root)) {
        rootMetadataReads += 1;
        if (rootMetadataReads === 3) {
          const error = new Error("root metadata temporarily stale after readdir");
          error.code = "ESTALE";
          throw error;
        }
      }
      return originalStat.call(fs, candidate, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.equal(retryTimers.live().length, 1);
      assert.equal(retryTimers.live()[0].delay, 1000);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 3,
        "full-tree retry did not recover startup directory coverage",
      );
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      fs.statSync = originalStat;
      await session?.dispose();
      retryTimers.restore();
    }
  });
});

test("an initial transient root metadata failure returns a recoverable session", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "child"));
    const originalStat = fs.statSync;
    const retryTimers = captureRetryTimers();
    let rootMetadataReads = 0;
    fs.statSync = (candidate, ...args) => {
      if (path.resolve(candidate) === path.resolve(root)) {
        rootMetadataReads += 1;
        if (rootMetadataReads === 1) {
          const error = new Error("initial root metadata temporarily stale");
          error.code = "ESTALE";
          throw error;
        }
      }
      return originalStat.call(fs, candidate, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      assert.equal(retryTimers.live().length, 1);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "initial metadata retry did not establish recursive directory coverage",
      );
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      fs.statSync = originalStat;
      await session?.dispose();
      retryTimers.restore();
    }
  });
});

test("a recovering Git workspace claims its root before metadata refresh watches", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const originalStat = fs.statSync;
    const originalWarn = console.warn;
    const retryTimers = captureRetryTimers();
    let rootMetadataReads = 0;
    fs.statSync = (candidate, ...args) => {
      if (path.resolve(candidate) === path.resolve(root)) {
        rootMetadataReads += 1;
        if (rootMetadataReads === 1) {
          const error = new Error("initial root metadata temporarily stale");
          error.code = "ESTALE";
          throw error;
        }
      }
      return originalStat.call(fs, candidate, ...args);
    };
    console.warn = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ maxWatches: 1, honorGitIgnore: true }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 1,
        "Git refresh metadata consumed capacity before the working-tree root",
      );
      assert.deepEqual(session.codexLinuxDirectoryWatchBudget(), { active: 1, limit: 1 });
    } finally {
      fs.statSync = originalStat;
      console.warn = originalWarn;
      await session?.dispose();
      retryTimers.restore();
    }
  });
});

test("persistent initial root metadata failures close after bounded retries", async () => {
  await withTempTree(async (root) => {
    const originalStat = fs.statSync;
    const retryTimers = captureRetryTimers();
    let rootMetadataReads = 0;
    fs.statSync = (candidate, ...args) => {
      if (path.resolve(candidate) === path.resolve(root)) {
        rootMetadataReads += 1;
        const error = new Error("root metadata remains unavailable");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => retryTimers.live().length === 1,
        "second root metadata retry was not scheduled",
      );
      assert.equal(retryTimers.live()[0].delay, 2000);

      retryTimers.fire(retryTimers.live()[0]);
      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.match(closed.error.message, /Could not restore complete working-tree watch coverage/);
      assert.equal(rootMetadataReads, 3);
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      fs.statSync = originalStat;
      await session?.dispose();
      retryTimers.restore();
    }
  });
});

test("an unreadable replaced root closes its stale inode watch after bounded retries", async () => {
  await withTempTree(async (root) => {
    const movedRoot = `${root}-old`;
    const originalStat = fs.statSync;
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    const callbacks = new Map();
    let rootWatcher;
    let failRootMetadata = false;
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const watcher = new FakeWatcher();
      callbacks.set(path.resolve(directory), callback);
      if (path.resolve(directory) === path.resolve(root)) rootWatcher = watcher;
      return watcher;
    };
    fs.statSync = (candidate, ...args) => {
      if (failRootMetadata && path.resolve(candidate) === path.resolve(root)) {
        const error = new Error("replacement root metadata remains unavailable");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      fs.renameSync(root, movedRoot);
      fs.mkdirSync(root);
      failRootMetadata = true;
      callbacks.get(path.resolve(root))("rename", path.basename(root));
      await waitFor(
        () => retryTimers.live().length === 1,
        "replaced root did not schedule its first metadata retry",
      );

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => retryTimers.live().length === 1,
        "replaced root did not schedule its second metadata retry",
      );
      retryTimers.fire(retryTimers.live()[0]);

      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.equal(rootWatcher.closed, true);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      failRootMetadata = false;
      assert.equal(originalStat.call(fs, root).isDirectory(), true);
    } finally {
      failRootMetadata = false;
      fs.statSync = originalStat;
      await session?.dispose();
      fs.watch = originalWatch;
      retryTimers.restore();
      fs.rmSync(movedRoot, { recursive: true, force: true });
    }
  });
});

test("large file-rename bursts collapse before scanning every active watcher", async () => {
  await withTempTree(async (root) => {
    for (let index = 0; index < 64; index += 1) {
      fs.mkdirSync(path.join(root, `directory-${index}`));
    }
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const watchCalls = [];
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      callbacks.set(resolved, callback);
      watchCalls.push(resolved);
      return new FakeWatcher();
    };
    let session;
    const originalRelative = path.relative;
    const originalLstatSync = fs.lstatSync;
    let rootRelativeCalls = 0;
    let syntheticFileStats = 0;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 65);

      path.relative = (from, to) => {
        if (String(from).startsWith(root) && String(to).startsWith(root)) {
          rootRelativeCalls += 1;
        }
        return originalRelative(from, to);
      };
      fs.lstatSync = (target, ...args) => {
        if (path.basename(String(target)).startsWith("burst-file-")) {
          syntheticFileStats += 1;
        }
        return originalLstatSync(target, ...args);
      };

      const rootCallback = callbacks.get(path.resolve(root));
      for (let index = 0; index < 1000; index += 1) {
        rootCallback("rename", `burst-file-${index}.txt`);
      }
      await waitFor(
        () => session.codexLinuxDirectorySyncFlushCount() >= 1,
        "rename burst did not flush",
      );

      assert.ok(
        rootRelativeCalls < 5000,
        `rename burst performed ${rootRelativeCalls} root-relative subtree checks`,
      );
      assert.ok(
        syntheticFileStats < 300,
        `rename burst synchronously statted ${syntheticFileStats} individual file paths`,
      );
      assert.equal(
        watchCalls.length,
        65,
        "a pure-file rename burst rebuilt stable directory watches",
      );
    } finally {
      path.relative = originalRelative;
      fs.lstatSync = originalLstatSync;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a collapsed rename burst refreshes a replaced watched directory", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(path.join(child, "stale-nested"), { recursive: true });
    const staleIdentity = fs.lstatSync(child);
    const originalLstat = fs.lstatSync;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const watchCalls = [];
    let reuseStaleIdentity = false;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.lstatSync = (target, ...args) => {
      const metadata = originalLstat.call(fs, target, ...args);
      if (reuseStaleIdentity && path.resolve(target) === child) {
        metadata.dev = staleIdentity.dev;
        metadata.ino = staleIdentity.ino;
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      callbacks.set(resolved, callback);
      watchCalls.push(resolved);
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      const rootCallback = callbacks.get(path.resolve(root));
      fs.rmSync(child, { recursive: true, force: true });
      fs.mkdirSync(child);
      reuseStaleIdentity = true;
      rootCallback("rename", "child");
      for (let index = 0; index < 256; index += 1) {
        rootCallback("rename", `burst-file-${index}.txt`);
      }
      await waitFor(
        () => watchCalls.filter((directory) => directory === child).length === 2,
        "collapsed reconciliation retained a replaced directory watch",
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
    } finally {
      await session?.dispose();
      fs.lstatSync = originalLstat;
      fs.watch = originalWatch;
    }
  });
});

test("Git metadata discovery retries an ordinary failure while .git exists", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, ".git"));
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    let remainingFailures = 2;
    childProcess.execFile = (command, args, options, callback) => {
      if (args.includes("rev-parse") && remainingFailures > 0) {
        remainingFailures -= 1;
        setImmediate(() => callback(Object.assign(new Error("repository incomplete"), {
          code: 128,
        }), "", ""));
        return new EventEmitter();
      }
      return originalExecFile(command, args, options, callback);
    };
    fs.watch = (directory, options) => originalWatch(directory, options, () => {});
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      childProcess.execFile = originalExecFile;
      assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
      await waitFor(
        () => session.codexLinuxDirectoryWatchBudget().active >= 3,
        "metadata targets were not rediscovered after repository initialization completed",
      );
    } finally {
      childProcess.execFile = originalExecFile;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("transient Git spawn resource failures retain metadata targets and retry", async () => {
  for (const errorCode of ["EMFILE", "ENFILE", "ENOMEM"]) {
    await withTempTree(async (root) => {
      spawnSync("git", ["init", "-q", root]);
      const originalExecFile = childProcess.execFile;
      const originalWatch = fs.watch;
      const retryTimers = captureRetryTimers();
      const callbacks = new Map();
      fs.watch = (directory, options, callback) => {
        callbacks.set(path.resolve(directory), callback);
        return originalWatch(directory, options, () => {});
      };
      let remainingFailures = 2;
      let recoveredQueries = 0;
      let session;
      try {
        session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
          fakeHost(),
          {
            path: root,
            recursive: true,
            renameEventHandling: "changed-path-with-parent-directory",
            onChange: () => {},
          },
          configuration({ honorGitIgnore: true }),
        );
        assert.equal(session.codexLinuxDirectoryWatchBudget().active, 3);
        childProcess.execFile = (command, args, options, callback) => {
          if (args.includes("rev-parse") && remainingFailures > 0) {
            remainingFailures -= 1;
            setImmediate(() => callback(Object.assign(new Error(errorCode), {
              code: errorCode,
            }), "", ""));
            return new EventEmitter();
          }
          if (args.includes("rev-parse")) recoveredQueries += 1;
          return originalExecFile(command, args, options, callback);
        };
        callbacks.get(path.resolve(root))("change", ".gitignore");
        await waitFor(
          () => retryTimers.live().length === 1,
          `${errorCode} Git spawn failure did not schedule metadata rediscovery`,
        );
        assert.equal(
          session.codexLinuxDirectoryWatchBudget().active,
          3,
          `${errorCode} Git spawn failure removed established metadata watches`,
        );
        assert.equal(retryTimers.live()[0].delay, 1000);
        retryTimers.fire(retryTimers.live()[0]);
        await waitFor(
          () => recoveredQueries >= 2,
          `${errorCode} Git spawn failure did not retry metadata discovery`,
        );
        assert.deepEqual(retryTimers.live(), []);
      } finally {
        await session?.dispose();
        childProcess.execFile = originalExecFile;
        fs.watch = originalWatch;
        retryTimers.restore();
      }
    });
  }
});

test("persistently invalid Git metadata retries with capped exponential backoff", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, ".git"));
    const originalExecFile = childProcess.execFile;
    const retryTimers = captureRetryTimers();
    childProcess.execFile = (_command, _args, _options, callback) => {
      setImmediate(() => callback(Object.assign(new Error("invalid repository"), {
        code: 128,
      }), "", ""));
      return new EventEmitter();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      const expectedDelays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
      for (let index = 0; index < expectedDelays.length; index += 1) {
        await waitFor(
          () => retryTimers.live().length === 1,
          `Git retry timer ${index + 1} was not scheduled`,
        );
        const timer = retryTimers.live()[0];
        assert.equal(timer.delay, expectedDelays[index]);
        if (index + 1 < expectedDelays.length) retryTimers.fire(timer);
      }
      const pendingTimer = retryTimers.live()[0];
      await session.dispose();
      session = null;
      assert.equal(pendingTimer.cleared, true);
    } finally {
      await session?.dispose();
      childProcess.execFile = originalExecFile;
      retryTimers.restore();
    }
  });
});

test("directory-only recursion uses one watch per directory, not per file", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    for (let index = 0; index < 50; index += 1) {
      fs.writeFileSync(path.join(root, `root-${index}.txt`), "root");
      fs.writeFileSync(path.join(root, "src", `src-${index}.txt`), "src");
      fs.writeFileSync(path.join(root, "src", "nested", `nested-${index}.txt`), "nested");
    }

    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration(),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);
      assert.deepEqual(session.coverage, { recursive: false, typedPathChanges: false });
    } finally {
      await session.dispose();
    }
  });
});

test("directory traversal avoids opendir's synchronous DT_UNKNOWN fallback", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(path.join(child, "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "ordinary.txt"), "not a directory\n");
    const originalOpendir = fs.promises.opendir;
    const originalReaddir = fs.promises.readdir;
    let opendirCalls = 0;
    let readdirCalls = 0;
    fs.promises.opendir = async () => {
      opendirCalls += 1;
      throw new Error("opendir must not be used for topology traversal");
    };
    fs.promises.readdir = async (directory, options) => {
      readdirCalls += 1;
      assert.deepEqual(options, { withFileTypes: true });
      return originalReaddir.call(fs.promises, directory, options);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(
        session.codexLinuxDirectoryWatchCount(),
        3,
        "promise readdir traversal omitted recursive directory coverage",
      );
      assert.equal(readdirCalls, 3);
      assert.equal(opendirCalls, 0);
    } finally {
      await session?.dispose();
      fs.promises.opendir = originalOpendir;
      fs.promises.readdir = originalReaddir;
    }
  });
});

test("disposal does not wait for a stalled directory read", async () => {
  await withTempTree(async (root) => {
    const originalWatch = fs.watch;
    const originalReaddir = fs.promises.readdir;
    const callbacks = new Map();
    let stallReads = false;
    let stalledReadEntered = false;
    let resolveStalledRead;
    const stalledRead = new Promise((resolve) => {
      resolveStalledRead = resolve;
    });
    fs.watch = (directory, options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return originalWatch(directory, options, () => {});
    };
    fs.promises.readdir = async (directory, ...args) => {
      if (stallReads && path.resolve(directory) === path.resolve(root)) {
        stalledReadEntered = true;
        return stalledRead;
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    let session;
    let disposePromise;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      stallReads = true;
      callbacks.get(path.resolve(root))("rename", null);
      await waitFor(() => stalledReadEntered, "topology reconciliation did not reach readdir");

      let disposeResolved = false;
      disposePromise = session.dispose().then(() => {
        disposeResolved = true;
      });
      await waitFor(
        () => disposeResolved,
        "watcher disposal waited for a non-cancellable directory read",
        500,
      );
      session = null;
    } finally {
      resolveStalledRead([]);
      await disposePromise;
      await session?.dispose();
      fs.watch = originalWatch;
      fs.promises.readdir = originalReaddir;
    }
  });
});

test("a transient whole-directory readdir failure is retried in place", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "child"));
    const originalReaddir = fs.promises.readdir;
    let rootReadAttempts = 0;
    fs.promises.readdir = async (directory, ...args) => {
      if (path.resolve(directory) === path.resolve(root)) {
        rootReadAttempts += 1;
        if (rootReadAttempts === 1) {
          const error = new Error("entry disappeared during asynchronous type resolution");
          error.code = "ENOENT";
          throw error;
        }
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(rootReadAttempts, 2);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
    } finally {
      await session?.dispose();
      fs.promises.readdir = originalReaddir;
    }
  });
});

test("an exhausted transient readdir retry schedules bounded topology recovery", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "child"));
    const originalReaddir = fs.promises.readdir;
    const retryTimers = captureRetryTimers();
    let rootReadAttempts = 0;
    fs.promises.readdir = async (directory, ...args) => {
      if (path.resolve(directory) === path.resolve(root)) {
        rootReadAttempts += 1;
        if (rootReadAttempts <= 3) {
          const error = new Error("directory remains temporarily unavailable");
          error.code = "EIO";
          throw error;
        }
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(rootReadAttempts, 3);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "delayed topology recovery did not restore directory traversal coverage",
      );
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.promises.readdir = originalReaddir;
      retryTimers.restore();
    }
  });
});

test("persistent non-root identity churn closes after two full-tree recoveries", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalLstat = fs.lstatSync;
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    const childIdentity = originalLstat.call(fs, child);
    let childMetadataCalls = 0;
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.lstatSync = (target, ...args) => {
      const metadata = originalLstat.call(fs, target, ...args);
      if (path.resolve(target) === child) {
        childMetadataCalls += 1;
        metadata.dev = childIdentity.dev;
        metadata.ino = childIdentity.ino + (childMetadataCalls % 2);
      }
      return metadata;
    };
    fs.watch = (directory) => {
      if (path.resolve(directory) === child) childWatchAttempts += 1;
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(childWatchAttempts, 3);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => childWatchAttempts === 6 && retryTimers.live().length === 1,
        "persistent identity churn did not schedule its final bounded recovery",
      );
      assert.equal(retryTimers.live()[0].delay, 2000);

      retryTimers.fire(retryTimers.live()[0]);
      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.match(closed.error.message, /Could not restore complete working-tree watch coverage/);
      assert.equal(childWatchAttempts, 9);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.lstatSync = originalLstat;
      fs.watch = originalWatch;
      retryTimers.restore();
    }
  });
});

test("a filename-less rename event reconciles the watched directory topology", async () => {
  await withTempTree(async (root) => {
    const originalWatch = fs.watch;
    const callbacks = new Map();
    fs.watch = (directory, options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return originalWatch(directory, options, () => {});
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      fs.mkdirSync(path.join(root, "new-subtree", "nested"), { recursive: true });
      callbacks.get(path.resolve(root))("rename", null);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 3,
        "filename-less event did not rebuild directory watches",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a filename-less rename refreshes a replaced directory with a reused inode number", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(path.join(child, "stale-nested"), { recursive: true });
    const staleIdentity = fs.lstatSync(child);
    const originalLstat = fs.lstatSync;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const watchCalls = [];
    let reuseStaleIdentity = false;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.lstatSync = (target, ...args) => {
      const metadata = originalLstat.call(fs, target, ...args);
      if (reuseStaleIdentity && path.resolve(target) === child) {
        metadata.dev = staleIdentity.dev;
        metadata.ino = staleIdentity.ino;
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      callbacks.set(resolved, callback);
      watchCalls.push(resolved);
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      fs.rmSync(child, { recursive: true, force: true });
      fs.mkdirSync(child);
      reuseStaleIdentity = true;
      callbacks.get(path.resolve(root))("rename", null);
      await waitFor(
        () => watchCalls.filter((directory) => directory === child).length === 2,
        "filename-less reconciliation retained a replaced directory watch",
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
    } finally {
      await session?.dispose();
      fs.lstatSync = originalLstat;
      fs.watch = originalWatch;
    }
  });
});

test("a directory replaced at the same path receives a fresh watch when its inode number is reused", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    const staleNested = path.join(child, "stale-nested");
    fs.mkdirSync(staleNested, { recursive: true });
    const staleIdentity = fs.lstatSync(child);
    const originalLstat = fs.lstatSync;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const watchCalls = [];
    let reuseStaleIdentity = false;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.lstatSync = (target, ...args) => {
      const metadata = originalLstat.call(fs, target, ...args);
      if (reuseStaleIdentity && path.resolve(target) === child) {
        metadata.dev = staleIdentity.dev;
        metadata.ino = staleIdentity.ino;
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      callbacks.set(resolved, callback);
      watchCalls.push(resolved);
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      fs.rmSync(child, { recursive: true, force: true });
      fs.mkdirSync(child);
      reuseStaleIdentity = true;
      callbacks.get(path.resolve(root))("rename", "child");
      await waitFor(
        () => watchCalls.filter((directory) => directory === child).length === 2,
        "replacement directory reused its stale inode watch",
      );
      assert.equal(
        session.codexLinuxDirectoryWatchCount(),
        2,
        "replacement directory retained a descendant watch from the old inode",
      );
    } finally {
      await session?.dispose();
      fs.lstatSync = originalLstat;
      fs.watch = originalWatch;
    }
  });
});

test("full reconciliation closes descendant watches under an invalid ancestor", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    const staleNested = path.join(child, "nested");
    const moved = path.join(root, "moved");
    fs.mkdirSync(staleNested, { recursive: true });
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const watchersByPath = new Map();
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      callbacks.set(resolved, callback);
      watchersByPath.set(resolved, watcher);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      const staleNestedWatcher = watchersByPath.get(staleNested);
      assert.ok(staleNestedWatcher);

      fs.renameSync(child, moved);
      fs.symlinkSync("moved", child, "dir");
      callbacks.get(path.resolve(root))("rename", null);
      await waitFor(
        () => watchersByPath.has(path.join(moved, "nested")),
        "full reconciliation did not watch the moved subtree",
      );
      assert.equal(staleNestedWatcher.closed, true);
      assert.equal(
        session.codexLinuxDirectoryWatchCount(),
        3,
        "invalid ancestor retained a duplicate descendant watch",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("stale descendant callbacks cannot restore watches below a closed ancestor", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const child = path.join(root, "child");
    const nested = path.join(child, "nested");
    const moved = path.join(root, "moved");
    const movedLate = path.join(moved, "nested", "late");
    const aliasLate = path.join(child, "nested", "late");
    fs.mkdirSync(nested, { recursive: true });
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const watchersByPath = new Map();
    let releaseBlockedQuery;
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      callbacks.set(resolved, callback);
      watchersByPath.set(resolved, watcher);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      const staleNestedCallback = callbacks.get(nested);
      childProcess.execFile = (command, args, options, callback) => {
        if (releaseBlockedQuery == null) {
          releaseBlockedQuery = () => {
            releaseBlockedQuery = false;
            return originalExecFile(command, args, options, callback);
          };
          return new FakeWatcher();
        }
        return originalExecFile(command, args, options, callback);
      };

      fs.renameSync(child, moved);
      fs.symlinkSync("moved", child, "dir");
      fs.mkdirSync(movedLate);
      callbacks.get(path.resolve(root))("rename", null);
      await waitFor(
        () => typeof releaseBlockedQuery === "function",
        "full reconciliation did not reach the blocked Git query",
      );
      staleNestedCallback("rename", "late");
      releaseBlockedQuery();

      await waitFor(
        () => watchersByPath.has(movedLate),
        "full reconciliation did not rebuild the moved subtree",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        session.codexLinuxDirectorySyncFlushCount(),
        0,
        "a stale descendant callback queued work after its watch was invalidated",
      );
      assert.equal(
        watchersByPath.has(aliasLate),
        false,
        "queued work restored a watch through the closed symlink ancestor",
      );
    } finally {
      if (typeof releaseBlockedQuery === "function") releaseBlockedQuery();
      childProcess.execFile = originalExecFile;
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("moving the watched root closes the stale inode watch", async () => {
  await withTempTree(async (root) => {
    const movedRoot = `${root}-moved`;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      callbacks.set(path.resolve(directory), callback);
      return new FakeWatcher();
    };
    const events = [];
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: (event) => events.push(event),
        },
        configuration(),
      );
      fs.renameSync(root, movedRoot);
      callbacks.get(path.resolve(root))("rename", path.basename(root));
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 0,
        "moved working-tree root did not close",
      );
      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      assert.ok(events.some((event) => event.changedPaths.length === 0));
      assert.ok(
        !events.some((event) => event.changedPaths.includes(path.join(root, path.basename(root)))),
        "root self-rename was reported as a child path",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      fs.rmSync(movedRoot, { recursive: true, force: true });
    }
  });
});

test("a replaced root receives a fresh watch when its inode number is reused", async () => {
  await withTempTree(async (root) => {
    const movedRoot = `${root}-moved`;
    const staleIdentity = fs.statSync(root);
    const originalStat = fs.statSync;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    const rootWatchers = [];
    const events = [];
    let reuseStaleIdentity = false;
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.statSync = (target, ...args) => {
      const metadata = originalStat.call(fs, target, ...args);
      if (reuseStaleIdentity && path.resolve(target) === path.resolve(root)) {
        metadata.dev = staleIdentity.dev;
        metadata.ino = staleIdentity.ino;
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      callbacks.set(resolved, callback);
      if (resolved === path.resolve(root)) rootWatchers.push(watcher);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: (event) => events.push(event),
        },
        configuration(),
      );
      const staleRootCallback = callbacks.get(path.resolve(root));
      fs.renameSync(root, movedRoot);
      fs.mkdirSync(root);
      reuseStaleIdentity = true;
      staleRootCallback("rename", path.basename(root));
      await waitFor(
        () => rootWatchers.length === 2,
        "replacement root reused its stale watch",
      );
      assert.equal(rootWatchers[0].closed, true);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.ok(events.some((event) => event.changedPaths.length === 0));
      assert.ok(
        !events.some((event) => event.changedPaths.includes(path.join(root, path.basename(root)))),
        "root self-replacement was reported as a child path",
      );
    } finally {
      await session?.dispose();
      fs.statSync = originalStat;
      fs.watch = originalWatch;
      fs.rmSync(movedRoot, { recursive: true, force: true });
    }
  });
});

test("a replaced Git root re-watches refresh targets when inode numbers are reused", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const movedRoot = `${root}-moved`;
    const infoDirectory = path.join(root, ".git", "info");
    const staleRootIdentity = fs.statSync(root);
    const staleInfoIdentity = fs.statSync(infoDirectory);
    const originalStat = fs.statSync;
    const originalWatch = fs.watch;
    const callbacksByPath = new Map();
    const watchersByPath = new Map();
    let reuseStaleIdentities = false;
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.statSync = (target, ...args) => {
      const metadata = originalStat.call(fs, target, ...args);
      if (reuseStaleIdentities) {
        const resolved = path.resolve(target);
        if (resolved === path.resolve(root)) {
          metadata.dev = staleRootIdentity.dev;
          metadata.ino = staleRootIdentity.ino;
        } else if (resolved === infoDirectory) {
          metadata.dev = staleInfoIdentity.dev;
          metadata.ino = staleInfoIdentity.ino;
        }
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      const callbacks = callbacksByPath.get(resolved) ?? [];
      callbacks.push(callback);
      callbacksByPath.set(resolved, callbacks);
      const watched = watchersByPath.get(resolved) ?? [];
      watched.push(watcher);
      watchersByPath.set(resolved, watched);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      const staleRootCallback = callbacksByPath.get(path.resolve(root))[0];
      const staleRootWatcher = watchersByPath.get(path.resolve(root))[0];
      const staleInfoWatcher = watchersByPath.get(infoDirectory)[0];
      assert.equal(callbacksByPath.get(infoDirectory).length, 1);

      fs.renameSync(root, movedRoot);
      fs.mkdirSync(root);
      spawnSync("git", ["init", "-q", root]);
      reuseStaleIdentities = true;
      staleRootCallback("rename", path.basename(root));

      await waitFor(
        () => (
          callbacksByPath.get(path.resolve(root)).length === 2 &&
          callbacksByPath.get(infoDirectory).length === 2
        ),
        "replacement Git root retained stale working-tree or refresh watches",
      );
      assert.equal(staleRootWatcher.closed, true);
      assert.equal(staleInfoWatcher.closed, true);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
    } finally {
      await session?.dispose();
      fs.statSync = originalStat;
      fs.watch = originalWatch;
      fs.rmSync(movedRoot, { recursive: true, force: true });
    }
  });
});

test("name exclusions and Git ignore rules prune generated subtrees", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored-output/\n");
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", "package", "deep"), { recursive: true });
    fs.mkdirSync(path.join(root, "ignored-output", "deep"), { recursive: true });

    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({
        honorGitIgnore: true,
        ignoredDirectoryNames: ["node_modules"],
      }),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);
    } finally {
      await session.dispose();
    }
  });
});

test("scattered Git-ignored roots are indexed without quadratic ancestor scans", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, ".git", "info"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "index"), "");
    fs.writeFileSync(path.join(root, ".git", "info", "exclude"), "");
    const ignoredDirectories = Array.from(
      { length: 300 },
      (_value, index) => `ignored-${String(index).padStart(3, "0")}/`,
    );
    const originalExecFile = childProcess.execFile;
    const originalRelative = path.relative;
    let rootRelativeCalls = 0;
    childProcess.execFile = (_command, args, _options, callback) => {
      let stdout = "";
      if (args.includes("rev-parse")) {
        stdout = args.at(-1) === "index" ? ".git/index\n" : ".git/info/exclude\n";
      } else if (args.includes("ls-files")) {
        stdout = `${ignoredDirectories.join("\0")}\0`;
      } else if (args.includes("check-ignore")) {
        const separator = args.lastIndexOf("--");
        stdout = `${args.slice(separator + 1).join("\n")}\n`;
      }
      setImmediate(() => callback(null, stdout, ""));
      return new EventEmitter();
    };
    path.relative = (from, to) => {
      if (String(from).startsWith(root) && String(to).startsWith(root)) {
        rootRelativeCalls += 1;
      }
      return originalRelative(from, to);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.ok(
        rootRelativeCalls < 5000,
        `Git-ignore indexing performed ${rootRelativeCalls} root-relative ancestor checks`,
      );
    } finally {
      path.relative = originalRelative;
      childProcess.execFile = originalExecFile;
      await session?.dispose();
    }
  });
});

test("nested .git metadata directories never consume working-tree watches", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "embedded", ".git", "objects", "deep"), { recursive: true });
    fs.mkdirSync(path.join(root, "embedded", "src"));
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration(),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);
    } finally {
      await session.dispose();
    }
  });
});

test("an ignored file such as .env.local still emits a working-tree event", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), ".env.local\n");
    const events = [];
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: (event) => events.push(event),
      },
      configuration({ honorGitIgnore: true }),
    );
    try {
      const envPath = path.join(root, ".env.local");
      fs.writeFileSync(envPath, "LOCAL_VALUE=1\n");
      await waitFor(
        () => events.some((event) => event.changedPaths.includes(envPath)),
        "ignored root-level file change was not observed",
      );
    } finally {
      await session.dispose();
    }
  });
});

test("an ignored directory containing a forced tracked file remains watched", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(root, "ignored", "untracked-deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "ignored", "tracked.txt"), "tracked\n");
    fs.writeFileSync(path.join(root, "ignored", "untracked-deep", "ignored.txt"), "ignored\n");
    spawnSync("git", ["-C", root, "add", ".gitignore"]);
    spawnSync("git", ["-C", root, "add", "-f", "ignored/tracked.txt"]);

    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ honorGitIgnore: true }),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
    } finally {
      await session.dispose();
    }
  });
});

test("a newly restored ignored directory with a tracked file becomes watched", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(root, "ignored"));
    fs.writeFileSync(path.join(root, "ignored", "tracked.txt"), "tracked\n");
    spawnSync("git", ["-C", root, "add", ".gitignore"]);
    spawnSync("git", ["-C", root, "add", "-f", "ignored/tracked.txt"]);
    fs.rmSync(path.join(root, "ignored"), { recursive: true, force: true });

    const events = [];
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: (event) => events.push(event),
      },
      configuration({ honorGitIgnore: true }),
    );
    try {
      fs.mkdirSync(path.join(root, "ignored"));
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "restored tracked directory was not watched",
      );
      const trackedPath = path.join(root, "ignored", "tracked.txt");
      fs.writeFileSync(trackedPath, "restored\n");
      await waitFor(
        () => events.some((event) => event.changedPaths.includes(trackedPath)),
        "restored tracked file change was not observed",
      );
    } finally {
      await session.dispose();
    }
  });
});

test("a moved-in tree applies Git ignore rules before installing descendant watches", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const incoming = `${root}-incoming`;
    fs.mkdirSync(path.join(incoming, "generated", "package", "deep"), { recursive: true });
    fs.writeFileSync(path.join(incoming, ".gitignore"), "generated/\n");
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      fs.renameSync(incoming, path.join(root, "package"));
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "moved-in ignored descendants received directory watches",
      );
      assert.equal(
        spawnSync("git", ["-C", root, "check-ignore", "-q", "--", "package/generated"]).status,
        0,
      );
    } finally {
      await session?.dispose();
      fs.rmSync(incoming, { recursive: true, force: true });
    }
  });
});

test("Git metadata refresh watches are discovered when a working tree is initialized later", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "ignored"));
    const trackedPath = path.join(root, "ignored", "tracked.txt");
    fs.writeFileSync(trackedPath, "before\n");
    const events = [];
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: (event) => events.push(event),
      },
      configuration({ honorGitIgnore: true }),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
      assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
      fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
      await waitFor(
        () => (
          session.codexLinuxDirectoryWatchCount() === 1 &&
          session.codexLinuxDirectoryWatchBudget().active >= 3
        ),
        "new Git metadata targets were not discovered and ignored directories were not pruned",
      );

      assert.equal(spawnSync("git", ["-C", root, "add", "-f", "ignored/tracked.txt"]).status, 0);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "the newly discovered index watch did not restore a force-added directory",
      );
      events.length = 0;
      fs.writeFileSync(trackedPath, "after\n");
      await waitFor(
        () => events.some((event) => event.changedPaths.includes(trackedPath)),
        "force-added file was not observed after late Git initialization",
      );
    } finally {
      await session.dispose();
    }
  });
});

test("force-adding a file refreshes a previously pruned directory", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
    fs.mkdirSync(path.join(root, "ignored"));
    const trackedPath = path.join(root, "ignored", "tracked.txt");
    fs.writeFileSync(trackedPath, "before\n");
    const events = [];
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: (event) => events.push(event),
      },
      configuration({ honorGitIgnore: true }),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.equal(spawnSync("git", ["-C", root, "add", "-f", "ignored/tracked.txt"]).status, 0);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "force-added directory was not added to the watch topology",
      );
      events.length = 0;
      fs.writeFileSync(trackedPath, "after\n");
      await waitFor(
        () => events.some((event) => event.changedPaths.includes(trackedPath)),
        "force-added tracked file change was not observed",
      );
    } finally {
      await session.dispose();
    }
  });
});

test("changing .git/info/exclude refreshes the watch topology", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const excludePath = path.join(root, ".git", "info", "exclude");
    fs.writeFileSync(excludePath, "ignored/\n");
    fs.mkdirSync(path.join(root, "ignored"));
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ honorGitIgnore: true }),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      fs.writeFileSync(excludePath, "");
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        ".git/info/exclude change did not refresh directory watches",
      );
    } finally {
      await session.dispose();
    }
  });
});

test("a replaced Git refresh directory receives a fresh inode watch", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const infoDirectory = path.join(root, ".git", "info");
    const excludePath = path.join(infoDirectory, "exclude");
    fs.writeFileSync(excludePath, "");
    fs.mkdirSync(path.join(root, "foo"));
    const originalWatch = fs.watch;
    const callbacks = new Map();
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const directoryCallbacks = callbacks.get(resolved) ?? [];
      directoryCallbacks.push(callback);
      callbacks.set(resolved, directoryCallbacks);
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
      assert.equal(callbacks.get(infoDirectory).length, 1);

      fs.rmSync(infoDirectory, { recursive: true, force: true });
      callbacks.get(infoDirectory)[0]("rename", path.basename(infoDirectory));
      await waitFor(
        () => session.codexLinuxDirectoryWatchBudget().active === 3,
        "stale Git refresh inode watch was not released",
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(callbacks.get(infoDirectory).length, 1);

      fs.mkdirSync(infoDirectory);
      fs.writeFileSync(excludePath, "foo/\n");
      await waitFor(
        () => (
          session.codexLinuxDirectoryWatchCount() === 1 &&
          callbacks.get(infoDirectory).length === 2
        ),
        "recreated Git refresh directory was not watched and reconciled",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("a replaced Git refresh directory is rewatched when its inode number is reused", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const infoDirectory = path.join(root, ".git", "info");
    const excludePath = path.join(infoDirectory, "exclude");
    const ignoredDirectory = path.join(root, "ignored");
    fs.writeFileSync(excludePath, "");
    fs.mkdirSync(ignoredDirectory);
    const staleIdentity = fs.statSync(infoDirectory);
    const originalStat = fs.statSync;
    const originalWatch = fs.watch;
    const callbacks = new Map();
    let reuseStaleIdentity = false;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.statSync = (target, ...args) => {
      const metadata = originalStat.call(fs, target, ...args);
      if (reuseStaleIdentity && path.resolve(target) === infoDirectory) {
        metadata.dev = staleIdentity.dev;
        metadata.ino = staleIdentity.ino;
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const directoryCallbacks = callbacks.get(resolved) ?? [];
      directoryCallbacks.push(callback);
      callbacks.set(resolved, directoryCallbacks);
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      const staleRefreshCallback = callbacks.get(infoDirectory)[0];
      fs.rmSync(infoDirectory, { recursive: true, force: true });
      fs.mkdirSync(infoDirectory);
      fs.writeFileSync(excludePath, "ignored/\n");
      reuseStaleIdentity = true;
      staleRefreshCallback("rename", path.basename(infoDirectory));
      await waitFor(
        () => (
          callbacks.get(infoDirectory).length === 2 &&
          session.codexLinuxDirectoryWatchCount() === 1
        ),
        "replacement Git refresh directory reused its stale watch",
      );
    } finally {
      await session?.dispose();
      fs.statSync = originalStat;
      fs.watch = originalWatch;
    }
  });
});

test("replacing .git re-watches a refresh target whose inode number is reused", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const gitDirectory = path.join(root, ".git");
    const infoDirectory = path.join(gitDirectory, "info");
    const staleInfoIdentity = fs.statSync(infoDirectory);
    const originalStat = fs.statSync;
    const originalWatch = fs.watch;
    const callbacksByPath = new Map();
    const watchersByPath = new Map();
    let reuseStaleIdentity = false;
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.statSync = (target, ...args) => {
      const metadata = originalStat.call(fs, target, ...args);
      if (reuseStaleIdentity && path.resolve(target) === infoDirectory) {
        metadata.dev = staleInfoIdentity.dev;
        metadata.ino = staleInfoIdentity.ino;
      }
      return metadata;
    };
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      const callbacks = callbacksByPath.get(resolved) ?? [];
      callbacks.push(callback);
      callbacksByPath.set(resolved, callbacks);
      const watched = watchersByPath.get(resolved) ?? [];
      watched.push(watcher);
      watchersByPath.set(resolved, watched);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      const rootCallback = callbacksByPath.get(path.resolve(root))[0];
      const staleInfoWatcher = watchersByPath.get(infoDirectory)[0];
      assert.equal(callbacksByPath.get(infoDirectory).length, 1);

      fs.rmSync(gitDirectory, { recursive: true, force: true });
      spawnSync("git", ["init", "-q", root]);
      reuseStaleIdentity = true;
      rootCallback("rename", ".git");

      await waitFor(
        () => callbacksByPath.get(infoDirectory).length === 2,
        "replacement .git directory retained its stale refresh watch",
      );
      assert.equal(staleInfoWatcher.closed, true);
      assert.equal(callbacksByPath.get(path.resolve(root)).length, 1);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
    } finally {
      await session?.dispose();
      fs.statSync = originalStat;
      fs.watch = originalWatch;
    }
  });
});

test("asynchronous Git refresh watch failures retain a resettable backoff", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const infoDirectory = path.join(root, ".git", "info");
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    const infoWatchers = [];
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      if (path.resolve(directory) === infoDirectory) infoWatchers.push(watcher);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );

      const error = new Error("Git refresh watcher failed asynchronously");
      error.code = "EIO";
      infoWatchers[0].emit("error", error);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => infoWatchers.length === 2,
        "asynchronous Git refresh watch failure was not recovered",
      );
      infoWatchers[1].emit("error", error);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [2000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => infoWatchers.length === 3,
        "repeated Git refresh watch failure was not recovered",
      );
      infoWatchers[2].callback("change", "exclude");
      infoWatchers[2].emit("error", error);
      assert.deepEqual(
        retryTimers.live().map((timer) => timer.delay),
        [1000],
        "a healthy refresh event did not reset the asynchronous failure backoff",
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      retryTimers.restore();
    }
  });
});

test("a higher Git refresh failure minimum replaces another path's pending timer", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const gitDirectory = path.join(root, ".git");
    const infoDirectory = path.join(gitDirectory, "info");
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    const refreshWatchersByPath = new Map();
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      if (resolved === gitDirectory || resolved === infoDirectory) {
        const pathWatchers = refreshWatchersByPath.get(resolved) ?? [];
        pathWatchers.push(watcher);
        refreshWatchersByPath.set(resolved, pathWatchers);
      }
      return watcher;
    };
    const emitRefreshError = (watcher) => {
      const error = new Error("Git refresh watcher failed asynchronously");
      error.code = "EIO";
      watcher.emit("error", error);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(refreshWatchersByPath.get(gitDirectory).length, 1);
      assert.equal(refreshWatchersByPath.get(infoDirectory).length, 1);

      emitRefreshError(refreshWatchersByPath.get(infoDirectory).at(-1));
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => refreshWatchersByPath.get(infoDirectory).length === 2,
        "first Git info refresh failure did not recover",
      );

      emitRefreshError(refreshWatchersByPath.get(infoDirectory).at(-1));
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [2000]);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => refreshWatchersByPath.get(infoDirectory).length === 3,
        "second Git info refresh failure did not recover",
      );

      emitRefreshError(refreshWatchersByPath.get(gitDirectory).at(-1));
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      const lowerTimer = retryTimers.live()[0];

      emitRefreshError(refreshWatchersByPath.get(infoDirectory).at(-1));
      assert.equal(lowerTimer.cleared, true, "higher Git retry minimum retained a 1s timer");
      assert.deepEqual(
        retryTimers.live().map((timer) => timer.delay),
        [4000],
        "higher Git retry minimum did not rearm the pending refresh timer",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      retryTimers.restore();
    }
  });
});

for (const refreshInvalidation of [
  {
    name: "an asynchronous Git refresh error cannot lose its backoff to an in-flight ignore reload",
    invalidate(watcher) {
      const error = new Error("Git refresh watcher failed during ignore reload");
      error.code = "EIO";
      watcher.emit("error", error);
    },
    expectedChangeCount: 3,
  },
  {
    name: "Git refresh self-invalidation cannot lose its backoff to an in-flight ignore reload",
    invalidate(watcher, infoDirectory) {
      watcher.callback("rename", path.basename(infoDirectory));
    },
    expectedChangeCount: 2,
  },
]) {
  test(refreshInvalidation.name, async () => {
    await withTempTree(async (root) => {
      spawnSync("git", ["init", "-q", root]);
      const infoDirectory = path.join(root, ".git", "info");
      const originalExecFile = childProcess.execFile;
      const originalWatch = fs.watch;
      const retryTimers = captureRetryTimers();
      const callbacksByPath = new Map();
      const infoWatchers = [];
      let blockedIgnoreQuery = null;
      let ignoreQueryWasBlocked = false;
      let ignoreQueryBlocked = false;
      let releaseBlockedIgnoreQuery = () => {};
      let changeCount = 0;
      class FakeWatcher extends EventEmitter {
        close() {
          this.closed = true;
        }
      }
      fs.watch = (directory, _options, callback) => {
        const resolved = path.resolve(directory);
        const watcher = new FakeWatcher();
        watcher.callback = callback;
        callbacksByPath.set(resolved, callback);
        if (resolved === infoDirectory) infoWatchers.push(watcher);
        return watcher;
      };
      let session;
      try {
        session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
          fakeHost(),
          {
            path: root,
            recursive: true,
            renameEventHandling: "changed-path-with-parent-directory",
            onChange: () => {
              changeCount += 1;
            },
          },
          configuration({ honorGitIgnore: true }),
        );
        assert.equal(infoWatchers.length, 1);

        childProcess.execFile = (command, args, options, callback) => {
          if (!ignoreQueryWasBlocked && args.includes("ls-files")) {
            ignoreQueryWasBlocked = true;
            blockedIgnoreQuery = { command, args, options, callback };
            ignoreQueryBlocked = true;
            releaseBlockedIgnoreQuery = () => {
              const query = blockedIgnoreQuery;
              blockedIgnoreQuery = null;
              releaseBlockedIgnoreQuery = () => {};
              originalExecFile(query.command, query.args, query.options, query.callback);
            };
            return new FakeWatcher();
          }
          return originalExecFile(command, args, options, callback);
        };

        callbacksByPath.get(path.resolve(root))("change", ".gitignore");
        await waitFor(
          () => ignoreQueryBlocked,
          "Git ignore reload did not reach its blocked query",
        );
        const staleInfoWatcher = infoWatchers[0];
        refreshInvalidation.invalidate(staleInfoWatcher, infoDirectory);
        assert.equal(staleInfoWatcher.closed, true);
        assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

        releaseBlockedIgnoreQuery();
        await waitFor(
          () => changeCount >= refreshInvalidation.expectedChangeCount,
          "in-flight ignore reload did not finish after its query was released",
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(
          retryTimers.live().map((timer) => timer.delay),
          [1000],
          "in-flight ignore reload cleared the Git refresh retry",
        );
        assert.equal(
          infoWatchers.length,
          1,
          "in-flight ignore reload reinstalled the Git refresh watch before its backoff",
        );

        retryTimers.fire(retryTimers.live()[0]);
        await waitFor(
          () => infoWatchers.length === 2,
          "Git refresh watch was not restored after its retained backoff fired",
        );
      } finally {
        releaseBlockedIgnoreQuery();
        childProcess.execFile = originalExecFile;
        await session?.dispose();
        fs.watch = originalWatch;
        retryTimers.restore();
      }
    });
  });
}

test("new directories are watched and deleted subtrees release their watches", async () => {
  await withTempTree(async (root) => {
    const events = [];
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: (event) => events.push(event),
      },
      configuration(),
    );
    try {
      fs.mkdirSync(path.join(root, "new", "nested"), { recursive: true });
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 3,
        "new directory watches were not installed",
      );

      const changedFile = path.join(root, "new", "nested", "changed.txt");
      fs.writeFileSync(changedFile, "changed");
      await waitFor(
        () => events.some((event) => event.changedPaths.includes(changedFile)),
        "deep file change was not observed",
      );

      fs.rmSync(path.join(root, "new"), { recursive: true, force: true });
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 1,
        "deleted directory watches were not released",
      );
    } finally {
      await session.dispose();
    }
  });
});

test("the shared watch budget bounds large directory trees", async () => {
  await withTempTree(async (root) => {
    for (const name of ["a", "b", "c", "d"]) {
      fs.mkdirSync(path.join(root, name, "nested"), { recursive: true });
    }
    const session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: root,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    try {
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
      assert.deepEqual(session.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 2 });
      assert.equal(session.coverage.recursive, false);
    } finally {
      await session.dispose();
    }
  });
});

test("a transient non-resource child watch failure schedules bounded topology recovery", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory) => {
      if (path.resolve(directory) === child) {
        childWatchAttempts += 1;
        if (childWatchAttempts === 1) {
          const error = new Error("child watch is temporarily unavailable");
          error.code = "EIO";
          throw error;
        }
      }
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(childWatchAttempts, 1);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "delayed topology recovery did not restore the child watch",
      );
      assert.equal(childWatchAttempts, 2);
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      retryTimers.restore();
    }
  });
});

test("persistent non-resource child watch failures return recovery to Codex", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const retryTimers = captureRetryTimers();
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory) => {
      if (path.resolve(directory) === child) {
        childWatchAttempts += 1;
        const error = new Error("child watch remains unavailable");
        error.code = "EACCES";
        throw error;
      }
      return new FakeWatcher();
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => retryTimers.live().length === 1,
        "persistent child watch failure did not schedule its final bounded retry",
      );
      assert.equal(retryTimers.live()[0].delay, 2000);

      retryTimers.fire(retryTimers.live()[0]);
      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.match(closed.error.message, /Could not restore complete working-tree watch coverage/);
      assert.equal(childWatchAttempts, 3);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      retryTimers.restore();
    }
  });
});

test("persistent asynchronous child watch failures close after two recoveries", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const childCallbacks = [];
    const childWatchers = [];
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      if (resolved === child) {
        childCallbacks.push(callback);
        childWatchers.push(watcher);
      }
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        assert.equal(childWatchers.length, attempt + 1);
        childCallbacks[attempt]("change", "observed.txt");
        const error = new Error("child watcher failed asynchronously");
        error.code = "EIO";
        childWatchers[attempt].emit("error", error);
        if (attempt < 2) {
          await waitFor(
            () => childWatchers.length === attempt + 2,
            "asynchronous child watch failure was not recovered",
          );
        }
      }

      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.match(closed.error.message, /Could not restore complete working-tree watch coverage/);
      assert.equal(childWatchers.length, 3);
      assert.equal(childWatchers.every((watcher) => watcher.closed), true);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 0);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("child watch resource failures recover with a resettable backoff", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    const errors = [];
    let allowChildWatch = false;
    let childWatchAttempts = 0;
    let childWatcher = null;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      if (path.resolve(directory) === child) {
        childWatchAttempts += 1;
        if (!allowChildWatch) {
          const error = new Error("watch resources exhausted");
          error.code = "ENOSPC";
          throw error;
        }
      }
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      if (path.resolve(directory) === child) childWatcher = watcher;
      return watcher;
    };
    console.error = (...args) => errors.push(args.join(" "));
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      assert.equal(errors.length, 1);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(() => retryTimers.live().length === 1, "second watch retry was not scheduled");
      assert.equal(retryTimers.live()[0].delay, 2000);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(() => retryTimers.live().length === 1, "third watch retry was not scheduled");
      assert.equal(retryTimers.live()[0].delay, 4000);

      allowChildWatch = true;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "child watch did not recover after resource capacity returned",
      );
      assert.deepEqual(retryTimers.live(), []);

      allowChildWatch = false;
      const asyncError = new Error("watch resources exhausted again");
      asyncError.code = "ENFILE";
      const attemptsBeforeAsyncError = childWatchAttempts;
      childWatcher.emit("error", asyncError);
      await waitFor(
        () => retryTimers.live().length === 1,
        "asynchronous watch failure did not schedule recovery",
      );
      assert.equal(retryTimers.live()[0].delay, 1000, "successful recovery did not reset backoff");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.equal(
        childWatchAttempts,
        attemptsBeforeAsyncError,
        "asynchronous resource errors bypassed the one-second retry backoff",
      );

      allowChildWatch = true;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "asynchronous child watch failure did not eventually recover",
      );
      assert.equal(errors.length, 1, "resource-limit diagnostics were not process-deduplicated");

      allowChildWatch = false;
      childWatcher.emit("error", asyncError);
      await waitFor(
        () => retryTimers.live().length === 1,
        "repeated asynchronous resource failure did not schedule recovery",
      );
      assert.equal(
        retryTimers.live()[0].delay,
        2000,
        "repeated asynchronous resource failure reset its backoff",
      );
      allowChildWatch = true;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "repeated asynchronous resource failure did not recover",
      );

      childWatcher.callback("change", "healthy.txt");
      allowChildWatch = false;
      childWatcher.emit("error", asyncError);
      await waitFor(
        () => retryTimers.live().length === 1,
        "post-event resource failure did not schedule recovery",
      );
      assert.equal(
        retryTimers.live()[0].delay,
        1000,
        "a healthy watcher event did not reset the asynchronous resource backoff",
      );
      const pendingTimer = retryTimers.live()[0];
      await session.dispose();
      session = null;
      assert.equal(pendingTimer.cleared, true, "dispose did not clear resource retry timer");
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("resource recovery does not bypass same-owner root metadata backoff", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const originalStat = fs.statSync;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    const callbacksByPath = new Map();
    let failChildWatch = false;
    let failRootMetadata = false;
    let rootMetadataCalls = 0;
    let childWatcher;
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      if (resolved === child) {
        childWatchAttempts += 1;
        if (failChildWatch) {
          const error = new Error("watch resources exhausted");
          error.code = "ENOSPC";
          throw error;
        }
      }
      const watcher = new FakeWatcher();
      callbacksByPath.set(resolved, callback);
      if (resolved === child) childWatcher = watcher;
      return watcher;
    };
    fs.statSync = (candidate, ...args) => {
      if (path.resolve(candidate) === root) {
        rootMetadataCalls += 1;
        if (failRootMetadata) {
          const error = new Error("root metadata is temporarily stale");
          error.code = "ESTALE";
          throw error;
        }
      }
      return originalStat.call(fs, candidate, ...args);
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      failChildWatch = true;
      const resourceError = new Error("watch resources exhausted asynchronously");
      resourceError.code = "ENOSPC";
      childWatcher.emit("error", resourceError);
      await waitFor(() => retryTimers.live().length === 1, "resource retry was not armed");
      const resourceTimer = retryTimers.live()[0];

      const childAttemptsBeforeTopologyEvent = childWatchAttempts;
      callbacksByPath.get(root)("rename", "child");
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        childWatchAttempts,
        childAttemptsBeforeTopologyEvent,
        "ordinary topology work bypassed resource backoff",
      );

      failRootMetadata = true;
      callbacksByPath.get(root)("rename", "root-entry");
      await waitFor(
        () => retryTimers.live().length === 2,
        "root metadata retry was not armed beside the resource retry",
      );
      const rootTimer = retryTimers.live().find((timer) => timer !== resourceTimer);
      const rootCallsBeforeResourceRetry = rootMetadataCalls;
      const childAttemptsBeforeResourceRetry = childWatchAttempts;
      retryTimers.fire(resourceTimer);
      await waitFor(
        () => retryTimers.live().length === 2,
        "resource retry was not retained behind root metadata backoff",
      );
      assert.equal(
        rootMetadataCalls,
        rootCallsBeforeResourceRetry,
        "resource retry probed root metadata before its own retry timer",
      );
      assert.equal(
        childWatchAttempts,
        childAttemptsBeforeResourceRetry,
        "resource retry attempted a child watch while root identity was unavailable",
      );

      failRootMetadata = false;
      failChildWatch = false;
      retryTimers.fire(rootTimer);
      await waitFor(
        () => (
          retryTimers.live().length === 1 &&
          session.codexLinuxDirectoryWatchCount() === 1
        ),
        "root retry did not leave recovery to the resource timer",
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      const replacementResourceTimer = retryTimers.live()[0];
      assert.equal(replacementResourceTimer.delay, 1000);
      retryTimers.fire(replacementResourceTimer);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 2,
        "resource retry did not recover the deferred child watch",
      );
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      fs.statSync = originalStat;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("failed resource recovery does not wake another root's metadata backoff", async () => {
  const resourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-resource-"));
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-blocked-"));
  const resourceChild = path.join(resourceRoot, "child");
  fs.mkdirSync(resourceChild);
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  const originalError = console.error;
  const retryTimers = captureRetryTimers();
  let resourceChildWatcher;
  let failResourceChild = false;
  let resourceChildAttempts = 0;
  let failBlockedMetadata = false;
  let blockedMetadataCalls = 0;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory) => {
    const resolved = path.resolve(directory);
    if (resolved === resourceChild) {
      resourceChildAttempts += 1;
      if (failResourceChild) {
        const error = new Error("watch resources remain exhausted");
        error.code = "ENOSPC";
        throw error;
      }
    }
    const watcher = new FakeWatcher();
    if (resolved === resourceChild) resourceChildWatcher = watcher;
    return watcher;
  };
  fs.statSync = (candidate, ...args) => {
    if (path.resolve(candidate) === blockedRoot) {
      blockedMetadataCalls += 1;
      if (failBlockedMetadata) {
        const error = new Error("root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
    }
    return originalStat.call(fs, candidate, ...args);
  };
  console.warn = () => {};
  console.error = () => {};
  let resourceSession;
  let ownerSession;
  let blockedSession;
  try {
    const settings = configuration({ maxWatches: 3 });
    resourceSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: resourceRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    blockedSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: blockedRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);

    failBlockedMetadata = true;
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => retryTimers.live().length === 1 &&
        globalThis[BUDGET_KEY]?.suspendedOwners.size === 1,
      "blocked root did not enter metadata backoff",
    );
    const rootTimer = retryTimers.live()[0];

    failResourceChild = true;
    const resourceError = new Error("watch resources exhausted asynchronously");
    resourceError.code = "ENOSPC";
    resourceChildWatcher.emit("error", resourceError);
    await waitFor(() => retryTimers.live().length === 2, "resource retry was not armed");
    const resourceTimer = retryTimers.live().find((timer) => timer !== rootTimer);
    const blockedCallsBeforeRetry = blockedMetadataCalls;
    const resourceAttemptsBeforeRetry = resourceChildAttempts;
    retryTimers.fire(resourceTimer);
    await waitFor(
      () => retryTimers.live().some((timer) => timer.delay === 2000),
      "failed resource retry did not retain exponential backoff",
    );
    assert.equal(resourceChildAttempts, resourceAttemptsBeforeRetry + 1);
    assert.equal(
      blockedMetadataCalls,
      blockedCallsBeforeRetry,
      "failed resource retry bypassed another root's metadata backoff",
    );
    assert.equal(rootTimer.cleared, false);
    assert.equal(rootTimer.fired, false);
  } finally {
    fs.statSync = originalStat;
    await resourceSession?.dispose();
    await ownerSession?.dispose();
    await blockedSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.error = originalError;
    retryTimers.restore();
    fs.rmSync(resourceRoot, { recursive: true, force: true });
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(blockedRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a non-resource resource probe failure returns to bounded topology recovery", async () => {
  await withTempTree(async (root) => {
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    let childFailureCode = "ENOSPC";
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory) => {
      if (path.resolve(directory) === child) {
        childWatchAttempts += 1;
        const error = new Error("child watch failed");
        error.code = childFailureCode;
        throw error;
      }
      return new FakeWatcher();
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(childWatchAttempts, 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      childFailureCode = "EACCES";
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(() => retryTimers.live().length === 1, "second retry was not scheduled");
      assert.equal(childWatchAttempts, 2);
      assert.equal(retryTimers.live()[0].delay, 2000);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(() => retryTimers.live().length === 1, "third retry was not scheduled");
      assert.equal(childWatchAttempts, 3);
      assert.equal(retryTimers.live()[0].delay, 4000);

      retryTimers.fire(retryTimers.live()[0]);
      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.match(closed.error.message, /Could not restore complete working-tree watch coverage/);
      assert.equal(childWatchAttempts, 4);
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("a resource readdir probe that becomes non-resource returns to bounded recovery", async () => {
  await withTempTree(async (root) => {
    const originalReaddir = fs.promises.readdir;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    let failureCode = "ENOSPC";
    let rootReadAttempts = 0;
    fs.promises.readdir = async (directory, ...args) => {
      if (path.resolve(directory) === path.resolve(root)) {
        rootReadAttempts += 1;
        const error = new Error("root directory read failed");
        error.code = failureCode;
        throw error;
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(rootReadAttempts, 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      failureCode = "EACCES";
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => rootReadAttempts === 2 && retryTimers.live().length === 1,
        "non-resource readdir probe did not transfer to bounded recovery",
      );
      assert.equal(retryTimers.live()[0].delay, 2000);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => rootReadAttempts === 3 && retryTimers.live().length === 1,
        "first bounded readdir retry did not retain recovery",
      );
      assert.equal(retryTimers.live()[0].delay, 4000);

      retryTimers.fire(retryTimers.live()[0]);
      const closed = await session.closed;
      assert.equal(closed.reason, "watch-error");
      assert.match(closed.error.message, /Could not restore complete working-tree watch coverage/);
      assert.equal(rootReadAttempts, 4);
      assert.deepEqual(retryTimers.live(), []);
    } finally {
      await session?.dispose();
      fs.promises.readdir = originalReaddir;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("a higher asynchronous resource minimum replaces another path's pending timer", async () => {
  await withTempTree(async (root) => {
    const firstChild = path.join(root, "a");
    const secondChild = path.join(root, "b");
    fs.mkdirSync(firstChild);
    fs.mkdirSync(secondChild);
    const originalWatch = fs.watch;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    const watchersByPath = new Map();
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      const pathWatchers = watchersByPath.get(resolved) ?? [];
      pathWatchers.push(watcher);
      watchersByPath.set(resolved, pathWatchers);
      return watcher;
    };
    console.error = () => {};
    const emitResourceError = (watcher) => {
      const error = new Error("watch resources exhausted asynchronously");
      error.code = "ENOSPC";
      watcher.emit("error", error);
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      const firstPath = path.resolve(firstChild);
      const secondPath = path.resolve(secondChild);

      emitResourceError(watchersByPath.get(firstPath).at(-1));
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => watchersByPath.get(firstPath).length === 2,
        "first path did not recover from its initial resource failure",
      );

      emitResourceError(watchersByPath.get(firstPath).at(-1));
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [2000]);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => watchersByPath.get(firstPath).length === 3,
        "first path did not recover from its repeated resource failure",
      );

      emitResourceError(watchersByPath.get(secondPath).at(-1));
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      const lowerTimer = retryTimers.live()[0];

      emitResourceError(watchersByPath.get(firstPath).at(-1));
      assert.equal(lowerTimer.cleared, true, "higher resource minimum retained a 1s timer");
      assert.deepEqual(
        retryTimers.live().map((timer) => timer.delay),
        [4000],
        "higher resource minimum did not rearm the pending retry timer",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("an in-flight resource retry preserves another path's higher asynchronous backoff", async () => {
  await withTempTree(async (root) => {
    const firstChild = path.join(root, "a");
    const secondChild = path.join(root, "b");
    fs.mkdirSync(firstChild);
    fs.mkdirSync(secondChild);
    const originalWatch = fs.watch;
    const originalReaddir = fs.promises.readdir;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    const watchersByPath = new Map();
    let blockRootRead = false;
    let releaseBlockedRead = () => {};
    let resolveReadBlocked;
    const readBlocked = new Promise((resolve) => {
      resolveReadBlocked = resolve;
    });
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      const pathWatchers = watchersByPath.get(resolved) ?? [];
      pathWatchers.push(watcher);
      watchersByPath.set(resolved, pathWatchers);
      return watcher;
    };
    fs.promises.readdir = async (directory, ...args) => {
      if (blockRootRead && path.resolve(directory) === path.resolve(root)) {
        blockRootRead = false;
        resolveReadBlocked();
        await new Promise((resolve) => {
          releaseBlockedRead = resolve;
        });
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    console.error = () => {};
    let session;
    const emitResourceError = (watcher) => {
      const error = new Error("watch resources exhausted asynchronously");
      error.code = "ENOSPC";
      watcher.emit("error", error);
    };
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      const firstPath = path.resolve(firstChild);
      const secondPath = path.resolve(secondChild);
      assert.equal(watchersByPath.get(firstPath).length, 1);
      assert.equal(watchersByPath.get(secondPath).length, 1);

      emitResourceError(watchersByPath.get(firstPath).at(-1));
      await waitFor(() => retryTimers.live().length === 1, "first retry was not armed");
      assert.equal(retryTimers.live()[0].delay, 1000);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => watchersByPath.get(firstPath).length === 2 && retryTimers.live().length === 0,
        "first path did not recover from its initial resource failure",
      );

      emitResourceError(watchersByPath.get(firstPath).at(-1));
      await waitFor(() => retryTimers.live().length === 1, "second retry was not armed");
      assert.equal(retryTimers.live()[0].delay, 2000);
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => watchersByPath.get(firstPath).length === 3 && retryTimers.live().length === 0,
        "first path did not recover from its repeated resource failure",
      );

      emitResourceError(watchersByPath.get(secondPath).at(-1));
      await waitFor(() => retryTimers.live().length === 1, "other-path retry was not armed");
      assert.equal(retryTimers.live()[0].delay, 1000);
      blockRootRead = true;
      retryTimers.fire(retryTimers.live()[0]);
      await readBlocked;

      emitResourceError(watchersByPath.get(firstPath).at(-1));
      releaseBlockedRead();
      await waitFor(
        () => retryTimers.live().length === 1,
        "in-flight recovery did not retain the asynchronous resource failure",
      );
      assert.equal(
        retryTimers.live()[0].delay,
        4000,
        "another path's in-flight retry clobbered the higher asynchronous backoff",
      );
    } finally {
      releaseBlockedRead();
      await session?.dispose();
      fs.watch = originalWatch;
      fs.promises.readdir = originalReaddir;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("one failed resource probe does not scan every missing directory", async () => {
  await withTempTree(async (root) => {
    const children = Array.from({ length: 8 }, (_, index) => path.join(root, `child-${index}`));
    for (const child of children) fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    let childWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory) => {
      if (children.includes(path.resolve(directory))) {
        childWatchAttempts += 1;
        const error = new Error("watch resources exhausted");
        error.code = "ENOSPC";
        throw error;
      }
      return new FakeWatcher();
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration(),
      );
      assert.equal(childWatchAttempts, 1, "initial resource failure did not stop the scan");
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(() => retryTimers.live().length === 1, "resource retry was not retained");
      assert.equal(childWatchAttempts, 2, "one retry attempted every missing child watch");
      assert.equal(retryTimers.live()[0].delay, 2000);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("Git retry and resource retry domains do not probe each other early", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const child = path.join(root, "child");
    const infoDirectory = path.join(root, ".git", "info");
    fs.mkdirSync(child);
    const originalWatch = fs.watch;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    let childWatcher;
    let failChildWatch = false;
    let childWatchAttempts = 0;
    let refreshWatchAttempts = 0;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory) => {
      const resolved = path.resolve(directory);
      if (resolved === infoDirectory) {
        refreshWatchAttempts += 1;
        const error = new Error("refresh watch is temporarily unavailable");
        error.code = "EACCES";
        throw error;
      }
      if (resolved === child) {
        childWatchAttempts += 1;
        if (failChildWatch) {
          const error = new Error("watch resources exhausted");
          error.code = "ENOSPC";
          throw error;
        }
      }
      const watcher = new FakeWatcher();
      if (resolved === child) childWatcher = watcher;
      return watcher;
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(refreshWatchAttempts, 1);
      assert.equal(childWatchAttempts, 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      const refreshTimer = retryTimers.live()[0];

      failChildWatch = true;
      const resourceError = new Error("watch resources exhausted asynchronously");
      resourceError.code = "ENOSPC";
      childWatcher.emit("error", resourceError);
      await waitFor(() => retryTimers.live().length === 2, "resource retry was not armed");
      const resourceTimer = retryTimers.live().find((timer) => timer !== refreshTimer);

      retryTimers.fire(refreshTimer);
      await waitFor(
        () => retryTimers.live().length === 2,
        "Git retry was not retained behind resource backoff",
      );
      assert.equal(childWatchAttempts, 1, "Git retry bypassed resource backoff");
      assert.equal(refreshWatchAttempts, 1, "Git retry attempted refresh watch too early");

      const replacementRefreshTimer = retryTimers.live().find(
        (timer) => timer !== resourceTimer,
      );
      retryTimers.fire(resourceTimer);
      await waitFor(
        () => retryTimers.live().some((timer) => timer.delay === 2000),
        "resource retry did not retain backoff",
      );
      assert.equal(childWatchAttempts, 2);
      assert.equal(
        refreshWatchAttempts,
        1,
        "resource retry bypassed Git refresh-watch backoff",
      );
      assert.equal(replacementRefreshTimer.cleared, false);
      assert.equal(replacementRefreshTimer.fired, false);
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("directory traversal resource failures recover root and child coverage", async () => {
  for (const failureLocation of ["root", "child"]) {
    await withTempTree(async (root) => {
      const child = path.join(root, "child");
      fs.mkdirSync(path.join(child, "nested"), { recursive: true });
      const failedDirectory = failureLocation === "root" ? root : child;
      const originalReaddir = fs.promises.readdir;
      const originalError = console.error;
      const retryTimers = captureRetryTimers();
      let shouldFail = true;
      let failedReaddirAttempts = 0;
      fs.promises.readdir = async (directory, ...args) => {
        if (path.resolve(directory) === failedDirectory && shouldFail) {
          failedReaddirAttempts += 1;
          const error = new Error("directory traversal resources exhausted");
          error.code = "EMFILE";
          throw error;
        }
        return originalReaddir.call(fs.promises, directory, ...args);
      };
      console.error = () => {};
      let session;
      try {
        session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
          fakeHost(),
          {
            path: root,
            recursive: true,
            renameEventHandling: "changed-path-with-parent-directory",
            onChange: () => {},
          },
          configuration(),
        );
        assert.equal(
          session.codexLinuxDirectoryWatchCount(),
          failureLocation === "root" ? 1 : 2,
        );
        assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

        retryTimers.fire(retryTimers.live()[0]);
        await waitFor(
          () => retryTimers.live().length === 1,
          `${failureLocation} readdir failure did not retain bounded recovery`,
        );
        assert.equal(retryTimers.live()[0].delay, 2000);
        assert.equal(failedReaddirAttempts, 2, "persistent readdir failure retried in a loop");

        shouldFail = false;
        retryTimers.fire(retryTimers.live()[0]);
        await waitFor(
          () => session.codexLinuxDirectoryWatchCount() === 3,
          `${failureLocation} readdir resource failure did not recover recursive coverage`,
        );
        assert.deepEqual(retryTimers.live(), []);
      } finally {
        await session?.dispose();
        fs.promises.readdir = originalReaddir;
        console.error = originalError;
        retryTimers.restore();
      }
    });
  }
});

test("resource recovery reloads nested Git ignores missed without coverage", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const blocked = path.join(root, "blocked");
    const nested = path.join(blocked, "nested");
    const generated = path.join(nested, "generated");
    fs.mkdirSync(path.join(generated, "deep"), { recursive: true });
    const nestedIgnore = path.join(nested, ".gitignore");
    fs.writeFileSync(nestedIgnore, "generated/\n");
    const originalReaddir = fs.promises.readdir;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    let shouldFail = true;
    fs.promises.readdir = async (directory, ...args) => {
      if (path.resolve(directory) === blocked && shouldFail) {
        const error = new Error("directory traversal resources exhausted");
        error.code = "EMFILE";
        throw error;
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 2);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      fs.writeFileSync(nestedIgnore, "");
      shouldFail = false;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 5,
        "resource recovery retained stale nested Git-ignore state",
      );
    } finally {
      await session?.dispose();
      fs.promises.readdir = originalReaddir;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("non-resource child recovery reloads nested Git ignores missed without coverage", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const blocked = path.join(root, "blocked");
    const nested = path.join(blocked, "nested");
    const generated = path.join(nested, "generated");
    fs.mkdirSync(path.join(generated, "deep"), { recursive: true });
    const nestedIgnore = path.join(nested, ".gitignore");
    fs.writeFileSync(nestedIgnore, "generated/\n");
    const originalWatch = fs.watch;
    const watchersByPath = new Map();
    class FakeWatcher extends EventEmitter {
      close() {
        this.closed = true;
      }
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      const pathWatchers = watchersByPath.get(resolved) ?? [];
      pathWatchers.push(watcher);
      watchersByPath.set(resolved, pathWatchers);
      return watcher;
    };
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 3);

      const error = new Error("child watcher failed asynchronously");
      error.code = "EIO";
      watchersByPath.get(blocked).at(-1).emit("error", error);
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      fs.writeFileSync(nestedIgnore, "");

      await waitFor(
        () => session.codexLinuxDirectoryWatchCount() === 5,
        "non-resource recovery retained stale nested Git-ignore state",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
    }
  });
});

test("Git refresh watch resource failures retain their recovery timer", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const failedDirectory = path.join(root, ".git", "info");
    const originalWatch = fs.watch;
    const originalError = console.error;
    const retryTimers = captureRetryTimers();
    let allowRefreshWatch = false;
    let refreshWatchAttempts = 0;
    let refreshWatcher = null;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      const watcher = new FakeWatcher();
      watcher.callback = callback;
      if (path.resolve(directory) === failedDirectory) {
        refreshWatchAttempts += 1;
        if (!allowRefreshWatch) {
          const error = new Error("refresh watch resources exhausted");
          error.code = "ENOSPC";
          throw error;
        }
        refreshWatcher = watcher;
      }
      return watcher;
    };
    console.error = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => retryTimers.live().length === 1,
        "refresh watch resource retry did not remain armed after another failure",
      );
      assert.equal(retryTimers.live()[0].delay, 2000);

      allowRefreshWatch = true;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchBudget().active === 3,
        "Git refresh watch did not recover after resources became available",
      );
      assert.deepEqual(retryTimers.live(), []);

      allowRefreshWatch = false;
      const attemptsBeforeAsyncError = refreshWatchAttempts;
      const asyncError = new Error("refresh watch resources exhausted again");
      asyncError.code = "ENFILE";
      refreshWatcher.emit("error", asyncError);
      await waitFor(
        () => retryTimers.live().length === 1,
        "asynchronous Git refresh failure did not schedule recovery",
      );
      assert.equal(retryTimers.live()[0].delay, 1000);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(
        refreshWatchAttempts,
        attemptsBeforeAsyncError,
        "asynchronous Git refresh failure bypassed the one-second retry backoff",
      );

      allowRefreshWatch = true;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchBudget().active === 3,
        "asynchronous Git refresh failure did not recover",
      );

      allowRefreshWatch = false;
      refreshWatcher.emit("error", asyncError);
      await waitFor(
        () => retryTimers.live().length === 1,
        "repeated asynchronous Git refresh failure did not schedule recovery",
      );
      assert.equal(
        retryTimers.live()[0].delay,
        2000,
        "repeated asynchronous Git refresh failure reset its backoff",
      );
      allowRefreshWatch = true;
      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => session.codexLinuxDirectoryWatchBudget().active === 3,
        "repeated asynchronous Git refresh failure did not recover",
      );

      refreshWatcher.callback("change", "exclude");
      await new Promise((resolve) => setTimeout(resolve, 150));
      allowRefreshWatch = false;
      refreshWatcher.emit("error", asyncError);
      await waitFor(
        () => retryTimers.live().length === 1,
        "post-event Git refresh resource failure did not schedule recovery",
      );
      assert.equal(
        retryTimers.live()[0].delay,
        1000,
        "a healthy Git refresh target callback did not reset asynchronous backoff",
      );
    } finally {
      await session?.dispose();
      fs.watch = originalWatch;
      console.error = originalError;
      retryTimers.restore();
    }
  });
});

test("configured budget exhaustion does not start a resource retry timer", async () => {
  await withTempTree(async (root) => {
    fs.mkdirSync(path.join(root, "child"));
    const originalWarn = console.warn;
    const retryTimers = captureRetryTimers();
    console.warn = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ maxWatches: 1 }),
      );
      assert.equal(session.codexLinuxDirectoryWatchCount(), 1);
      assert.deepEqual(retryTimers.records, []);
    } finally {
      await session?.dispose();
      console.warn = originalWarn;
      retryTimers.restore();
    }
  });
});

test("budget coverage transitions are logged once until coverage recovers", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  fs.mkdirSync(path.join(secondRoot, "child"));
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const warnings = [];
  const infos = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /watch budget reached \(active=2, limit=2\)/);
    assert.match(warnings[0], new RegExp(secondRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));

    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => infos.length === 1,
      "recovered watch coverage was not logged",
    );
    assert.match(infos[0], /watch coverage recovered/);
    assert.match(infos[0], new RegExp(secondRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("Git metadata discovery must complete before budget recovery is logged", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  spawnSync("git", ["init", "-q", secondRoot]);
  fs.mkdirSync(path.join(secondRoot, "child"));
  const originalExecFile = childProcess.execFile;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  const infos = [];
  let failTargetDiscovery = false;
  childProcess.execFile = (command, args, options, callback) => {
    const rootIndex = args.indexOf("-C");
    if (
      failTargetDiscovery &&
      rootIndex >= 0 &&
      args[rootIndex + 1] === secondRoot &&
      args.includes("rev-parse")
    ) {
      setImmediate(() => {
        callback(Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGKILL",
        }), "", "");
      });
      return;
    }
    return originalExecFile(command, args, options, callback);
  };
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    const settings = configuration({ maxWatches: 5, honorGitIgnore: true });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);

    failTargetDiscovery = true;
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => (
        secondSession.codexLinuxDirectoryWatchCount() === 2 &&
        retryTimers.live().length === 1
      ),
      "partial workspace did not retain a Git metadata discovery retry",
    );
    assert.equal(
      infos.some((message) => message.includes("watch coverage recovered")),
      false,
      "budget recovery was logged while Git metadata discovery was incomplete",
    );

    failTargetDiscovery = false;
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => infos.some((message) => message.includes("watch coverage recovered")),
      "complete Git metadata recovery was not logged",
    );
    assert.equal(
      infos.filter((message) => message.includes("watch coverage recovered")).length,
      1,
    );
  } finally {
    failTargetDiscovery = false;
    childProcess.execFile = originalExecFile;
    console.warn = originalWarn;
    console.info = originalInfo;
    await firstSession?.dispose();
    await secondSession?.dispose();
    retryTimers.restore();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("operating-system watch exhaustion is logged once per process", async () => {
  await withTempTree(async (root) => {
    const originalWatch = fs.watch;
    const originalError = console.error;
    const errors = [];
    fs.watch = () => {
      const error = new Error("inotify exhausted");
      error.code = "ENOSPC";
      throw error;
    };
    console.error = (...args) => errors.push(args.join(" "));
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(
          codexLinuxStartDirectoryOnlyWorkingTreeWatch(
            fakeHost(),
            {
              path: root,
              recursive: true,
              renameEventHandling: "changed-path-with-parent-directory",
              onChange: () => {},
            },
            configuration(),
          ),
          /Could not watch working-tree root/,
        );
      }
      assert.equal(errors.length, 1);
      assert.match(errors[0], /operating-system watch resource limit \(ENOSPC\)/);
    } finally {
      fs.watch = originalWatch;
      console.error = originalError;
    }
  });
});

test("the watch budget is shared across working trees", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  fs.mkdirSync(path.join(secondRoot, "child"));
  let firstSession;
  let secondSession;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    assert.deepEqual(firstSession.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 2 });
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 2,
      "starved working tree did not acquire the released root and subtree budget",
    );
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a new workspace cannot overtake a root waiting on released capacity", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  const thirdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-third-"));
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  let firstSession;
  let secondSession;
  let thirdSession;
  let resolveThirdPlatformPath;
  const thirdPlatformPath = new Promise((resolve) => {
    resolveThirdPlatformPath = resolve;
  });
  try {
    const settings = configuration({ maxWatches: 1 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    const thirdSessionPromise = codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      {
        getFileSystemPath: (value) => value,
        platformPath: () => thirdPlatformPath,
      },
      {
        path: thirdRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    resolveThirdPlatformPath(path.posix);
    const firstDispose = firstSession.dispose();
    firstSession = null;
    thirdSession = await thirdSessionPromise;
    await firstDispose;
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 1,
      "later workspace overtook the root-first released-capacity queue",
    );
    assert.equal(thirdSession.codexLinuxDirectoryWatchCount(), 0);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 1, limit: 1 });
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    await thirdSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    fs.rmSync(thirdRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a transient root metadata failure does not close a budget-starved session", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  let failSecondRootMetadata = false;
  let secondRootMetadataFailures = 0;
  fs.statSync = (candidate, ...args) => {
    if (
      failSecondRootMetadata &&
      secondRootMetadataFailures === 0 &&
      path.resolve(candidate) === path.resolve(secondRoot)
    ) {
      secondRootMetadataFailures += 1;
      const error = new Error("root metadata temporarily stale");
      error.code = "ESTALE";
      throw error;
    }
    return originalStat.call(fs, candidate, ...args);
  };
  let firstSession;
  let secondSession;
  let secondSessionClosed = false;
  try {
    const settings = configuration({ maxWatches: 1 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession.closed.then(() => {
      secondSessionClosed = true;
    });
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    failSecondRootMetadata = true;
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 1,
      "transient root metadata failure prevented released-capacity recovery",
    );
    assert.equal(secondRootMetadataFailures, 1);
    assert.equal(secondSessionClosed, false);
  } finally {
    fs.statSync = originalStat;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("an unknown zero-watch root remains alive when another root claims the budget", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const waitingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-waiting-"));
  const winningRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-winning-"));
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  const retryTimers = captureRetryTimers();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  let injectWaitingFailures = false;
  let waitingRootStatCalls = 0;
  fs.statSync = (candidate, ...args) => {
    if (injectWaitingFailures && path.resolve(candidate) === path.resolve(waitingRoot)) {
      waitingRootStatCalls += 1;
      if (waitingRootStatCalls === 1 || waitingRootStatCalls === 3) {
        const error = new Error("root metadata temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
    }
    return originalStat.call(fs, candidate, ...args);
  };
  let firstSession;
  let waitingSession;
  let winningSession;
  let waitingSessionClosed = false;
  try {
    const settings = configuration({ maxWatches: 1 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    waitingSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: waitingRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    winningSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: winningRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    waitingSession.closed.then(() => {
      waitingSessionClosed = true;
    });

    injectWaitingFailures = true;
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => winningSession.codexLinuxDirectoryWatchCount() === 1,
      "competing root did not claim released capacity",
    );
    await waitFor(
      () => retryTimers.live().length === 1,
      "unknown waiting-root metadata did not schedule a bounded retry",
    );
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(() => waitingRootStatCalls >= 2, "waiting-root metadata retry did not run");
    assert.equal(waitingRootStatCalls, 2);
    assert.equal(waitingSession.codexLinuxDirectoryWatchCount(), 0);
    assert.equal(waitingSessionClosed, false);
    assert.deepEqual(retryTimers.live(), []);
  } finally {
    fs.statSync = originalStat;
    await firstSession?.dispose();
    await waitingSession?.dispose();
    await winningSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    retryTimers.restore();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(waitingRoot, { recursive: true, force: true });
    fs.rmSync(winningRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("capacity released during recovery is replayed after the in-flight scan", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  for (const name of ["a", "b", "c", "d"]) fs.mkdirSync(path.join(secondRoot, name));
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const watchersByPath = new Map();
  const infos = [];
  let recoveryPhase = false;
  let blockedReadEntered = false;
  let releaseBlockedRead;
  const blockedRead = new Promise((resolve) => {
    releaseBlockedRead = resolve;
  });
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, options, callback) => {
    const watcher = new FakeWatcher();
    watcher.callback = callback;
    watchersByPath.set(path.resolve(directory), watcher);
    return watcher;
  };
  fs.promises.readdir = async (directory, ...args) => {
    const resolved = path.resolve(directory);
    if (recoveryPhase && resolved === path.join(secondRoot, "b")) {
      blockedReadEntered = true;
      await blockedRead;
    }
    const entries = await originalReaddir.call(fs.promises, directory, ...args);
    if (resolved !== path.resolve(secondRoot)) return entries;
    const order = recoveryPhase ? ["a", "c", "d", "b"] : ["a", "b", "c", "d"];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return order.map((name) => byName.get(name));
  };
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    const settings = configuration({ maxWatches: 5 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 3);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 5, limit: 5 });

    recoveryPhase = true;
    fs.rmSync(path.join(firstRoot, "child"), { recursive: true, force: true });
    const childWatcher = watchersByPath.get(path.join(firstRoot, "child"));
    const error = new Error("child watch invalidated");
    error.code = "EIO";
    childWatcher.emit("error", error);
    await waitFor(() => blockedReadEntered, "budget recovery did not reach the gated directory");

    await firstSession.dispose();
    firstSession = null;
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 4, limit: 5 });
    releaseBlockedRead();
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 5,
      "capacity released during recovery was not replayed",
    );
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 5, limit: 5 });
    assert.equal(
      infos.filter((message) => message.includes("watch coverage recovered")).length,
      1,
    );
  } finally {
    releaseBlockedRead();
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("released capacity goes to a waiting partial workspace before its owner refills", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
    fs.mkdirSync(path.join(firstRoot, name));
  }
  fs.mkdirSync(path.join(secondRoot, "child"));
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const watchersByPath = new Map();
  class FakeWatcher extends EventEmitter {
    close() {
      this.closed = true;
    }
  }
  fs.watch = (directory, options, callback) => {
    const watcher = new FakeWatcher();
    watcher.callback = callback;
    watchersByPath.set(path.resolve(directory), watcher);
    return watcher;
  };
  console.warn = () => {};
  let firstSession;
  let secondSession;
  const invalidateFirstChild = () => {
    const entry = [...watchersByPath.entries()].find(([directory, watcher]) => (
      directory !== firstRoot &&
      directory.startsWith(`${firstRoot}${path.sep}`) &&
      !watcher.closed
    ));
    assert.ok(entry, "expected a watched child in the first workspace");
    const error = new Error("child watch invalidated");
    error.code = "EIO";
    entry[1].emit("error", error);
  };
  try {
    const settings = configuration({ maxWatches: 4 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 4);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    invalidateFirstChild();
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 1,
      "waiting workspace did not acquire its root",
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 3);

    invalidateFirstChild();
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 2,
      "releasing workspace reclaimed capacity before the waiting workspace",
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 4, limit: 4 });
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("released capacity is reserved fairly across queued workspace reconciliations", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const fastRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-fast-"));
  const slowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-slow-"));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(ownerRoot, name));
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const callbacksByPath = new Map();
  const warnings = [];
  let blockSlowRoot = false;
  let slowReadEntered = false;
  let releaseSlowRead;
  const slowRead = new Promise((resolve) => {
    releaseSlowRead = resolve;
  });
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, _options, callback) => {
    const watcher = new FakeWatcher();
    callbacksByPath.set(path.resolve(directory), callback);
    return watcher;
  };
  fs.promises.readdir = async (directory, ...args) => {
    if (blockSlowRoot && path.resolve(directory) === path.resolve(slowRoot)) {
      blockSlowRoot = false;
      slowReadEntered = true;
      await slowRead;
    }
    return originalReaddir.call(fs.promises, directory, ...args);
  };
  console.warn = (...args) => warnings.push(args.join(" "));
  let ownerSession;
  let fastSession;
  let slowSession;
  try {
    const settings = configuration({ maxWatches: 6 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    fastSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: fastRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    slowSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: slowRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 4);
    assert.equal(fastSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(slowSession.codexLinuxDirectoryWatchCount(), 1);

    for (const name of ["0", "1", "2", "3"]) {
      fs.mkdirSync(path.join(fastRoot, name));
      fs.mkdirSync(path.join(slowRoot, name));
    }
    callbacksByPath.get(path.resolve(fastRoot))("rename", "0");
    callbacksByPath.get(path.resolve(slowRoot))("rename", "0");
    await waitFor(
      () => warnings.some((message) => message.includes(fastRoot)) &&
        warnings.some((message) => message.includes(slowRoot)),
      "both waiting workspaces did not become partially covered",
    );

    blockSlowRoot = true;
    callbacksByPath.get(path.resolve(slowRoot))("rename", null);
    await waitFor(() => slowReadEntered, "slow workspace reconciliation did not block");

    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => fastSession.codexLinuxDirectoryWatchCount() === 3,
      "healthy workspace did not receive its fair released-capacity share",
    );
    assert.equal(slowSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(fastSession.codexLinuxDirectoryWatchBudget(), { active: 4, limit: 6 });

    releaseSlowRead();
    await waitFor(
      () => slowSession.codexLinuxDirectoryWatchCount() === 3,
      "queued slow-workspace reconciliation consumed the healthy workspace share",
    );
    assert.equal(fastSession.codexLinuxDirectoryWatchCount(), 3);
    assert.deepEqual(slowSession.codexLinuxDirectoryWatchBudget(), { active: 6, limit: 6 });
  } finally {
    releaseSlowRead();
    await ownerSession?.dispose();
    await fastSession?.dispose();
    await slowSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(fastRoot, { recursive: true, force: true });
    fs.rmSync(slowRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("released capacity recovery continues across bounded allocation chunks", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const waitingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-waiting-"));
  for (let index = 0; index < 299; index += 1) {
    fs.mkdirSync(path.join(ownerRoot, `owner-${index.toString().padStart(3, "0")}`));
  }
  for (let index = 0; index < 300; index += 1) {
    fs.mkdirSync(path.join(waitingRoot, `waiting-${index.toString().padStart(3, "0")}`));
  }
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  console.info = () => {};
  let ownerSession;
  let waitingSession;
  try {
    const settings = configuration({ maxWatches: 301 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    waitingSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: waitingRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 300);
    assert.equal(waitingSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(waitingSession.codexLinuxDirectoryWatchBudget(), {
      active: 301,
      limit: 301,
    });

    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => waitingSession.codexLinuxDirectoryWatchCount() === 301,
      "recovery stopped after consuming its first bounded allocation chunk",
      8_000,
    );
    assert.deepEqual(waitingSession.codexLinuxDirectoryWatchBudget(), {
      active: 301,
      limit: 301,
    });
  } finally {
    await ownerSession?.dispose();
    await waitingSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(waitingRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("multi-chunk recovery preserves Git discovery backoff", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-git-"));
  for (let index = 0; index < 299; index += 1) {
    fs.mkdirSync(path.join(ownerRoot, `owner-${index.toString().padStart(3, "0")}`));
    fs.mkdirSync(path.join(gitRoot, `git-${index.toString().padStart(3, "0")}`));
  }
  spawnSync("git", ["init", "-q", gitRoot]);
  const originalExecFile = childProcess.execFile;
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  console.info = () => {};
  let ownerSession;
  let gitSession;
  let discoveryFailures = 0;
  try {
    const settings = configuration({ maxWatches: 300 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    gitSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: gitRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 300, honorGitIgnore: true }),
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 300);
    assert.equal(gitSession.codexLinuxDirectoryWatchCount(), 0);

    childProcess.execFile = (command, args, options, callback) => {
      if (args.includes("rev-parse")) {
        discoveryFailures += 1;
        setImmediate(() => callback(Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGKILL",
        }), "", ""));
        return new EventEmitter();
      }
      return originalExecFile(command, args, options, callback);
    };
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => gitSession.codexLinuxDirectoryWatchCount() === 300,
      "multi-chunk fallback recovery did not fill released capacity",
      8_000,
    );
    assert.equal(
      discoveryFailures,
      2,
      "subsequent recovery chunks bypassed the live Git discovery backoff",
    );
    assert.equal(retryTimers.live().length, 1);
    assert.equal(retryTimers.live()[0].delay, 1000);
    assert.deepEqual(gitSession.codexLinuxDirectoryWatchBudget(), {
      active: 300,
      limit: 300,
    });
  } finally {
    childProcess.execFile = originalExecFile;
    await ownerSession?.dispose();
    await gitSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(gitRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("multi-chunk recovery preserves root metadata backoff", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const waitingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-waiting-"));
  for (let index = 0; index < 299; index += 1) {
    fs.mkdirSync(path.join(ownerRoot, `owner-${index.toString().padStart(3, "0")}`));
  }
  const unstableChild = path.join(waitingRoot, "unstable");
  fs.mkdirSync(unstableChild);
  for (let index = 0; index < 298; index += 1) {
    fs.mkdirSync(path.join(waitingRoot, `waiting-${index.toString().padStart(3, "0")}`));
  }
  const originalWatch = fs.watch;
  const originalLstat = fs.lstatSync;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  fs.promises.readdir = async (directory, ...args) => {
    const entries = await originalReaddir.call(fs.promises, directory, ...args);
    if (path.resolve(directory) !== path.resolve(waitingRoot)) return entries;
    return [...entries].sort((left, right) => {
      if (left.name === "unstable") return -1;
      if (right.name === "unstable") return 1;
      return left.name.localeCompare(right.name);
    });
  };
  console.warn = () => {};
  console.info = () => {};
  let ownerSession;
  let waitingSession;
  let failUnstableMetadata = true;
  let unstableMetadataFailures = 0;
  try {
    const settings = configuration({ maxWatches: 300 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    waitingSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: waitingRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    fs.lstatSync = (candidate, ...args) => {
      if (failUnstableMetadata && path.resolve(candidate) === unstableChild) {
        unstableMetadataFailures += 1;
        const error = new Error("child metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalLstat.call(fs, candidate, ...args);
    };

    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => waitingSession.codexLinuxDirectoryWatchCount() === 257 &&
        globalThis[BUDGET_KEY]?.suspendedOwners.size === 1 &&
        retryTimers.live().length === 1,
      "first recovery chunk did not suspend behind metadata backoff",
      8_000,
    );
    assert.equal(unstableMetadataFailures, 1);
    assert.equal(retryTimers.live()[0].delay, 1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      unstableMetadataFailures,
      1,
      "next recovery chunk bypassed root metadata backoff",
    );
    assert.equal(waitingSession.codexLinuxDirectoryWatchCount(), 257);

    failUnstableMetadata = false;
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => waitingSession.codexLinuxDirectoryWatchCount() === 300,
      "successful metadata retry did not resume remaining recovery chunks",
      8_000,
    );
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 0);
    assert.deepEqual(retryTimers.live(), []);
    assert.deepEqual(waitingSession.codexLinuxDirectoryWatchBudget(), {
      active: 300,
      limit: 300,
    });
  } finally {
    fs.lstatSync = originalLstat;
    await ownerSession?.dispose();
    await waitingSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(waitingRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("capacity released before recovery settlement is allocated in the next generation", async () => {
  const firstOwnerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-owner-first-"),
  );
  const secondOwnerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-owner-second-"),
  );
  const recoveringRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-recovering-"),
  );
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(recoveringRoot, name));
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  let firstOwnerSession;
  let secondOwnerSession;
  let recoveringSession;
  let disposeSecondOwnerOnRecovery = false;
  let secondOwnerDisposal = null;
  try {
    const settings = configuration({ maxWatches: 4 });
    firstOwnerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstOwnerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondOwnerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondOwnerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    recoveringSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: recoveringRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {
          if (!disposeSecondOwnerOnRecovery || secondOwnerSession == null) return;
          disposeSecondOwnerOnRecovery = false;
          const session = secondOwnerSession;
          secondOwnerSession = null;
          secondOwnerDisposal = session.dispose();
        },
      },
      settings,
    );
    assert.equal(firstOwnerSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(secondOwnerSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(recoveringSession.codexLinuxDirectoryWatchCount(), 2);

    disposeSecondOwnerOnRecovery = true;
    await firstOwnerSession.dispose();
    firstOwnerSession = null;
    await waitFor(
      () => recoveringSession.codexLinuxDirectoryWatchCount() === 4,
      "capacity released before settlement was lost with the prior reservation generation",
    );
    await secondOwnerDisposal;
    assert.deepEqual(recoveringSession.codexLinuxDirectoryWatchBudget(), {
      active: 4,
      limit: 4,
    });
  } finally {
    await firstOwnerSession?.dispose();
    await secondOwnerSession?.dispose();
    await secondOwnerDisposal;
    await recoveringSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(firstOwnerRoot, { recursive: true, force: true });
    fs.rmSync(secondOwnerRoot, { recursive: true, force: true });
    fs.rmSync(recoveringRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a newly partial workspace redistributes idle capacity from suspended owners", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const healthyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-healthy-"));
  const stalledRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-stalled-"));
  fs.mkdirSync(path.join(ownerRoot, "child"));
  fs.mkdirSync(path.join(stalledRoot, "child"));
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const callbacksByPath = new Map();
  let failStalledChild = false;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, _options, callback) => {
    const resolved = path.resolve(directory);
    if (failStalledChild && resolved === path.join(stalledRoot, "child")) {
      const error = new Error("stalled child is temporarily unwatcheable");
      error.code = "EACCES";
      throw error;
    }
    const watcher = new FakeWatcher();
    callbacksByPath.set(resolved, callback);
    return watcher;
  };
  console.warn = () => {};
  let ownerSession;
  let healthySession;
  let stalledSession;
  try {
    const settings = configuration({ maxWatches: 4 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    healthySession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: healthyRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    stalledSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: stalledRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(healthySession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(stalledSession.codexLinuxDirectoryWatchCount(), 1);

    failStalledChild = true;
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => globalThis[BUDGET_KEY]?.suspendedOwners.size === 1,
      "unproductive workspace recovery was not suspended",
    );
    assert.deepEqual(healthySession.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 4 });

    failStalledChild = false;
    fs.mkdirSync(path.join(healthyRoot, "child"));
    callbacksByPath.get(path.resolve(healthyRoot))("rename", "child");
    await waitFor(
      () => healthySession.codexLinuxDirectoryWatchCount() === 2 &&
        stalledSession.codexLinuxDirectoryWatchCount() === 2,
      "new partial coverage did not redistribute idle capacity",
    );
    assert.deepEqual(healthySession.codexLinuxDirectoryWatchBudget(), { active: 4, limit: 4 });
  } finally {
    await ownerSession?.dispose();
    await healthySession?.dispose();
    await stalledSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(healthyRoot, { recursive: true, force: true });
    fs.rmSync(stalledRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("unused reservation returns do not wake mutually stalled workspaces", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const firstStalledRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-stalled-first-"),
  );
  const secondStalledRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-stalled-second-"),
  );
  fs.mkdirSync(path.join(ownerRoot, "child"));
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const callbacksByPath = new Map();
  const stalledChildren = new Set();
  let failedWatchAttempts = 0;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, _options, callback) => {
    const resolved = path.resolve(directory);
    if (stalledChildren.has(resolved)) {
      failedWatchAttempts += 1;
      const error = new Error("child is temporarily unwatcheable");
      error.code = "EACCES";
      throw error;
    }
    const watcher = new FakeWatcher();
    callbacksByPath.set(resolved, callback);
    return watcher;
  };
  console.warn = () => {};
  let ownerSession;
  let firstStalledSession;
  let secondStalledSession;
  try {
    const settings = configuration({ maxWatches: 4 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    firstStalledSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstStalledRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondStalledSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondStalledRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    for (const stalledRoot of [firstStalledRoot, secondStalledRoot]) {
      const child = path.join(stalledRoot, "child");
      fs.mkdirSync(child);
      stalledChildren.add(child);
      callbacksByPath.get(path.resolve(stalledRoot))("rename", "child");
    }
    await waitFor(
      () => globalThis[BUDGET_KEY]?.partialListeners.size === 2,
      "both workspaces did not become partially covered",
    );

    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => {
        const budget = globalThis[BUDGET_KEY];
        return budget?.suspendedOwners.size === 2 &&
          budget.recoveringOwners.size === 0 &&
          budget.reserved === 0;
      },
      "unproductive workspace recoveries were not suspended",
    );
    const settledAttempts = failedWatchAttempts;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      failedWatchAttempts,
      settledAttempts,
      "virtual reservation returns retriggered stalled workspace recovery",
    );

    stalledChildren.clear();
    callbacksByPath.get(path.resolve(firstStalledRoot))("rename", null);
    await waitFor(
      () => firstStalledSession.codexLinuxDirectoryWatchCount() === 2 &&
        secondStalledSession.codexLinuxDirectoryWatchCount() === 2,
      "a real topology event did not wake suspended workspace recovery",
    );
    assert.deepEqual(firstStalledSession.codexLinuxDirectoryWatchBudget(), {
      active: 4,
      limit: 4,
    });
  } finally {
    await ownerSession?.dispose();
    await firstStalledSession?.dispose();
    await secondStalledSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(firstStalledRoot, { recursive: true, force: true });
    fs.rmSync(secondStalledRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("temporarily ineligible recovery redistributes its reservation", async () => {
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-blocked-"));
  const healthyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-healthy-"));
  const firstOwnerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-owner-first-"),
  );
  const secondOwnerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-owner-second-"),
  );
  const blockedExistingChild = path.join(blockedRoot, "existing");
  fs.mkdirSync(blockedExistingChild);
  fs.mkdirSync(path.join(healthyRoot, "existing"));
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const retryTimers = captureRetryTimers();
  const callbacksByPath = new Map();
  const watchersByPath = new Map();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, _options, callback) => {
    const resolved = path.resolve(directory);
    const watcher = new FakeWatcher();
    callbacksByPath.set(resolved, callback);
    watchersByPath.set(resolved, watcher);
    return watcher;
  };
  console.warn = () => {};
  let blockedSession;
  let healthySession;
  let firstOwnerSession;
  let secondOwnerSession;
  try {
    const settings = configuration({ maxWatches: 6 });
    blockedSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: blockedRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    healthySession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: healthyRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    firstOwnerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstOwnerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondOwnerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondOwnerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(healthySession.codexLinuxDirectoryWatchCount(), 2);

    fs.mkdirSync(path.join(blockedRoot, "missing"));
    for (const name of ["a", "b", "c", "d"]) fs.mkdirSync(path.join(healthyRoot, name));
    callbacksByPath.get(path.resolve(blockedRoot))("rename", "missing");
    callbacksByPath.get(path.resolve(healthyRoot))("rename", "a");
    await waitFor(
      () => globalThis[BUDGET_KEY]?.partialListeners.size === 2,
      "both workspaces did not become partially covered",
    );

    const resourceError = new Error("watch resources exhausted");
    resourceError.code = "ENOSPC";
    watchersByPath.get(blockedExistingChild).emit("error", resourceError);
    await waitFor(
      () => blockedSession.codexLinuxDirectoryWatchCount() === 1 &&
        healthySession.codexLinuxDirectoryWatchCount() === 3,
      "healthy workspace did not claim the first released slot",
    );
    assert.equal(retryTimers.live().length, 1);

    await firstOwnerSession.dispose();
    firstOwnerSession = null;
    await waitFor(
      () => healthySession.codexLinuxDirectoryWatchCount() === 4,
      "healthy workspace did not claim the second released slot",
    );
    await secondOwnerSession.dispose();
    secondOwnerSession = null;
    await waitFor(
      () => healthySession.codexLinuxDirectoryWatchCount() === 5,
      "temporarily ineligible owner stranded its released reservation",
    );
    assert.deepEqual(healthySession.codexLinuxDirectoryWatchBudget(), {
      active: 6,
      limit: 6,
    });
    assert.equal(globalThis[BUDGET_KEY].reserved, 0);
  } finally {
    await blockedSession?.dispose();
    await healthySession?.dispose();
    await firstOwnerSession?.dispose();
    await secondOwnerSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(blockedRoot, { recursive: true, force: true });
    fs.rmSync(healthyRoot, { recursive: true, force: true });
    fs.rmSync(firstOwnerRoot, { recursive: true, force: true });
    fs.rmSync(secondOwnerRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a root disposed while returning retry-pending leaves no suspended owner", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-blocked-"));
  const triggerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-trigger-"));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(ownerRoot, name));
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  let ownerSession;
  let blockedSession;
  let triggerSession;
  let injectBlockedMetadataFailure = false;
  let removeBlockedRootOnTrigger = false;
  try {
    const settings = configuration({ maxWatches: 4 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    blockedSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: blockedRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    triggerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: triggerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {
          if (!removeBlockedRootOnTrigger) return;
          removeBlockedRootOnTrigger = false;
          fs.rmSync(blockedRoot, { recursive: true, force: true });
        },
      },
      settings,
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 4);
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);
    assert.equal(triggerSession.codexLinuxDirectoryWatchCount(), 0);
    let blockedClosed = false;
    blockedSession.closed.then(() => {
      blockedClosed = true;
    });

    fs.statSync = (candidate, ...args) => {
      if (
        injectBlockedMetadataFailure &&
        path.resolve(candidate) === path.resolve(blockedRoot)
      ) {
        injectBlockedMetadataFailure = false;
        const error = new Error("root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };
    injectBlockedMetadataFailure = true;
    removeBlockedRootOnTrigger = true;
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => {
        const budget = globalThis[BUDGET_KEY];
        return blockedClosed &&
          budget?.listeners.size === 1 &&
          budget.partialListeners.size === 0 &&
          budget.suspendedOwners.size === 0 &&
          budget.reserved === 0;
      },
      "disposed retry-pending root left orphaned budget state",
    );
    assert.equal(triggerSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(triggerSession.codexLinuxDirectoryWatchBudget(), { active: 1, limit: 4 });
  } finally {
    fs.statSync = originalStat;
    await ownerSession?.dispose();
    await blockedSession?.dispose();
    await triggerSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(blockedRoot, { recursive: true, force: true });
    fs.rmSync(triggerRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("virtual redistribution does not bypass a suspended root retry", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-blocked-"));
  fs.mkdirSync(path.join(ownerRoot, "child"));
  fs.mkdirSync(path.join(blockedRoot, "child"));
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  console.info = () => {};
  let ownerSession;
  let blockedSession;
  let blockedMetadataFailures = 0;
  try {
    const settings = configuration({ maxWatches: 2 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    blockedSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: blockedRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);

    fs.statSync = (candidate, ...args) => {
      if (
        path.resolve(candidate) === path.resolve(blockedRoot) &&
        blockedMetadataFailures < 2
      ) {
        blockedMetadataFailures += 1;
        const error = new Error("root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => globalThis[BUDGET_KEY]?.suspendedOwners.size === 1 &&
        retryTimers.live().length === 1,
      "retry-pending root was not suspended",
    );
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);
    assert.deepEqual(blockedSession.codexLinuxDirectoryWatchBudget(), { active: 0, limit: 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(blockedMetadataFailures, 1, "virtual redistribution bypassed root backoff");
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);

    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => blockedMetadataFailures === 2 && retryTimers.live().length === 1,
      "failed root retry did not retain its backoff timer",
    );
    assert.equal(retryTimers.live()[0].delay, 2000);
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(blockedMetadataFailures, 2, "failed root retry bypassed its next backoff");

    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => blockedSession.codexLinuxDirectoryWatchCount() === 2,
      "root metadata retry did not recover complete directory coverage",
    );
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 0);
    assert.deepEqual(retryTimers.live(), []);
  } finally {
    fs.statSync = originalStat;
    await ownerSession?.dispose();
    await blockedSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(blockedRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("new partial work and later capacity releases respect root metadata backoff", async () => {
  const firstOwnerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-owner-first-"),
  );
  const secondOwnerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-owner-second-"),
  );
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-blocked-"));
  const newcomerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-newcomer-"),
  );
  for (const directory of [firstOwnerRoot, secondOwnerRoot, blockedRoot, newcomerRoot]) {
    fs.mkdirSync(path.join(directory, "child"));
  }
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  let failBlockedMetadata = false;
  let blockedMetadataCalls = 0;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  fs.statSync = (candidate, ...args) => {
    if (path.resolve(candidate) === blockedRoot) {
      blockedMetadataCalls += 1;
      if (failBlockedMetadata) {
        const error = new Error("root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
    }
    return originalStat.call(fs, candidate, ...args);
  };
  console.warn = () => {};
  console.info = () => {};
  let firstOwnerSession;
  let secondOwnerSession;
  let blockedSession;
  let newcomerSession;
  try {
    const settings = configuration({ maxWatches: 4 });
    firstOwnerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstOwnerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondOwnerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondOwnerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    blockedSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: blockedRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);

    failBlockedMetadata = true;
    await firstOwnerSession.dispose();
    firstOwnerSession = null;
    await waitFor(
      () => retryTimers.live().length === 1 &&
        globalThis[BUDGET_KEY]?.suspendedOwners.size === 1,
      "blocked root did not enter metadata backoff",
    );
    const rootTimer = retryTimers.live()[0];
    const callsBeforeNewcomer = blockedMetadataCalls;

    newcomerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: newcomerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    await waitFor(
      () => newcomerSession.codexLinuxDirectoryWatchCount() === 2,
      "new partial workspace did not claim idle capacity",
    );
    assert.equal(
      blockedMetadataCalls,
      callsBeforeNewcomer,
      "new partial coverage bypassed another root's metadata backoff",
    );

    await secondOwnerSession.dispose();
    secondOwnerSession = null;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      blockedMetadataCalls,
      callsBeforeNewcomer,
      "later physical capacity release bypassed root metadata backoff",
    );
    assert.equal(rootTimer.cleared, false);
    assert.equal(rootTimer.fired, false);
    assert.equal(rootTimer.delay, 1000);
    assert.equal(blockedSession.codexLinuxDirectoryWatchCount(), 0);

    failBlockedMetadata = false;
    retryTimers.fire(rootTimer);
    await waitFor(
      () => blockedSession.codexLinuxDirectoryWatchCount() === 2,
      "blocked root did not recover when its own retry fired",
    );
  } finally {
    fs.statSync = originalStat;
    await firstOwnerSession?.dispose();
    await secondOwnerSession?.dispose();
    await blockedSession?.dispose();
    await newcomerSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    for (const directory of [firstOwnerRoot, secondOwnerRoot, blockedRoot, newcomerRoot]) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    resetBudget();
  }
});

test("one root metadata retry does not bypass another root's backoff", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(ownerRoot, name));
  fs.mkdirSync(path.join(firstRoot, "child"));
  fs.mkdirSync(path.join(secondRoot, "child"));
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  console.info = () => {};
  let ownerSession;
  let firstSession;
  let secondSession;
  let injectMetadataFailures = false;
  let firstMetadataFailures = 0;
  let secondMetadataFailures = 0;
  let failSecondMetadata = true;
  try {
    const settings = configuration({ maxWatches: 4 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    fs.statSync = (candidate, ...args) => {
      const resolved = path.resolve(candidate);
      if (injectMetadataFailures && resolved === path.resolve(firstRoot)) {
        firstMetadataFailures += 1;
        if (firstMetadataFailures <= 1) {
          const error = new Error("first root metadata is temporarily stale");
          error.code = "ESTALE";
          throw error;
        }
      }
      if (
        injectMetadataFailures &&
        failSecondMetadata &&
        resolved === path.resolve(secondRoot)
      ) {
        secondMetadataFailures += 1;
        const error = new Error("second root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };

    injectMetadataFailures = true;
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => globalThis[BUDGET_KEY]?.suspendedOwners.size === 2 &&
        retryTimers.live().length === 2,
      "both retry-pending roots were not suspended",
    );
    const secondCallsBeforeFirstRetry = secondMetadataFailures;
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => firstSession.codexLinuxDirectoryWatchCount() === 2,
      "first root metadata retry did not recover coverage",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      secondMetadataFailures,
      secondCallsBeforeFirstRetry,
      "first root retry bypassed the second root's independent backoff",
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);
    assert.equal(retryTimers.live().length, 1);
    assert.equal(retryTimers.live()[0].delay, 1000);

    failSecondMetadata = false;
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 2,
      "second root did not recover when its own retry fired",
    );
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 0);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 4, limit: 4 });
  } finally {
    fs.statSync = originalStat;
    await ownerSession?.dispose();
    await firstSession?.dispose();
    await secondSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("root metadata recovery does not bypass Git discovery backoff", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-git-"));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(ownerRoot, name));
  spawnSync("git", ["init", "-q", gitRoot]);
  const originalExecFile = childProcess.execFile;
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const retryTimers = captureRetryTimers();
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  console.info = () => {};
  let ownerSession;
  let gitSession;
  let injectRootMetadataFailures = false;
  let rootMetadataFailures = 0;
  let remainingGitFailures = 2;
  let gitFailureCalls = 0;
  try {
    const settings = configuration({ maxWatches: 4 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    gitSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: gitRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 4, honorGitIgnore: true }),
    );
    fs.statSync = (candidate, ...args) => {
      if (
        injectRootMetadataFailures &&
        rootMetadataFailures < 1 &&
        path.resolve(candidate) === path.resolve(gitRoot)
      ) {
        rootMetadataFailures += 1;
        const error = new Error("root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };
    childProcess.execFile = (command, args, options, callback) => {
      if (args.includes("rev-parse") && remainingGitFailures > 0) {
        remainingGitFailures -= 1;
        gitFailureCalls += 1;
        setImmediate(() => callback(Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGKILL",
        }), "", ""));
        return new EventEmitter();
      }
      return originalExecFile(command, args, options, callback);
    };

    injectRootMetadataFailures = true;
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => globalThis[BUDGET_KEY]?.suspendedOwners.size === 1 &&
        retryTimers.live().length === 1,
      "Git root was not suspended behind its metadata retry",
    );
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => remainingGitFailures === 0 && retryTimers.live().length === 1,
      "root recovery did not retain failed Git discovery backoff",
    );
    assert.equal(retryTimers.live()[0].delay, 1000);
    assert.equal(gitFailureCalls, 2);
    assert.deepEqual(gitSession.codexLinuxDirectoryWatchBudget(), { active: 1, limit: 4 });
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(gitFailureCalls, 2, "root recovery bypassed Git discovery backoff");

    childProcess.execFile = originalExecFile;
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => gitSession.codexLinuxDirectoryWatchBudget().active === 3,
      "Git discovery did not recover on its own retry",
    );
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 0);
    assert.deepEqual(retryTimers.live(), []);
  } finally {
    childProcess.execFile = originalExecFile;
    fs.statSync = originalStat;
    await ownerSession?.dispose();
    await gitSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(gitRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("Git retry does not bypass a live root metadata timer", async () => {
  await withTempTree(async (root) => {
    spawnSync("git", ["init", "-q", root]);
    const child = path.join(root, "child");
    fs.mkdirSync(child);
    const originalExecFile = childProcess.execFile;
    const originalWatch = fs.watch;
    const originalStat = fs.statSync;
    const originalReaddir = fs.promises.readdir;
    const originalWarn = console.warn;
    const retryTimers = captureRetryTimers();
    const callbacksByPath = new Map();
    let failInitialGitQuery = true;
    let gitIgnoreQueryCalls = 0;
    let failRootMetadata = false;
    let rootMetadataCalls = 0;
    let childWatcher;
    let rootReadGate = null;
    let rootReadStarted = false;
    let releaseRootRead = null;
    class FakeWatcher extends EventEmitter {
      close() {}
    }
    fs.watch = (directory, _options, callback) => {
      const resolved = path.resolve(directory);
      callbacksByPath.set(resolved, callback);
      const watcher = new FakeWatcher();
      if (resolved === child) childWatcher = watcher;
      return watcher;
    };
    fs.statSync = (candidate, ...args) => {
      if (path.resolve(candidate) === root) {
        rootMetadataCalls += 1;
        if (failRootMetadata) {
          const error = new Error("root metadata is temporarily stale");
          error.code = "ESTALE";
          throw error;
        }
      }
      return originalStat.call(fs, candidate, ...args);
    };
    fs.promises.readdir = async (directory, ...args) => {
      if (path.resolve(directory) === root && rootReadGate != null) {
        const gate = rootReadGate;
        rootReadStarted = true;
        await gate;
      }
      return originalReaddir.call(fs.promises, directory, ...args);
    };
    childProcess.execFile = (command, args, options, callback) => {
      if (args.includes("ls-files")) {
        gitIgnoreQueryCalls += 1;
        if (failInitialGitQuery) {
          failInitialGitQuery = false;
          setImmediate(() => callback(Object.assign(new Error("timed out"), {
            code: null,
            killed: true,
            signal: "SIGKILL",
          }), "", ""));
          return new EventEmitter();
        }
      }
      return originalExecFile(command, args, options, callback);
    };
    console.warn = () => {};
    let session;
    try {
      session = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
        fakeHost(),
        {
          path: root,
          recursive: true,
          renameEventHandling: "changed-path-with-parent-directory",
          onChange: () => {},
        },
        configuration({ honorGitIgnore: true }),
      );
      assert.equal(gitIgnoreQueryCalls, 1);
      assert.deepEqual(retryTimers.live().map((timer) => timer.delay), [1000]);
      const refreshTimer = retryTimers.live()[0];

      failRootMetadata = true;
      const childError = new Error("child watch is temporarily unavailable");
      childError.code = "EACCES";
      childWatcher.emit("error", childError);
      await waitFor(
        () => retryTimers.live().length === 2,
        "root metadata retry was not armed beside Git retry",
      );
      const rootTimer = retryTimers.live().find((timer) => timer !== refreshTimer);

      failRootMetadata = false;
      rootReadGate = new Promise((resolve) => {
        releaseRootRead = () => {
          rootReadGate = null;
          resolve();
        };
      });
      retryTimers.fire(rootTimer);
      await waitFor(() => rootReadStarted, "root retry did not enter its queued traversal");
      retryTimers.fire(refreshTimer);
      failRootMetadata = true;
      releaseRootRead();
      releaseRootRead = null;
      await waitFor(
        () => retryTimers.live().length === 2,
        "queued Git retry was not retained after root backoff rearmed",
      );
      assert.equal(gitIgnoreQueryCalls, 1, "queued Git retry bypassed root metadata backoff");
      const replacementRootTimer = retryTimers.live().find((timer) => timer.delay === 2000);
      const replacementRefreshTimer = retryTimers.live().find((timer) => timer.delay === 1000);
      assert.ok(replacementRootTimer);
      assert.ok(replacementRefreshTimer);

      const rootCallsBeforeGitRetry = rootMetadataCalls;
      retryTimers.fire(replacementRefreshTimer);
      await waitFor(
        () => retryTimers.live().length === 2,
        "Git retry was not retained behind root metadata backoff",
      );
      assert.equal(
        rootMetadataCalls,
        rootCallsBeforeGitRetry,
        "Git retry probed root metadata before its own timer",
      );
      assert.equal(gitIgnoreQueryCalls, 1, "Git retry ran while root metadata was unavailable");

      failRootMetadata = false;
      retryTimers.fire(replacementRootTimer);
      await waitFor(
        () => retryTimers.live().length === 1,
        "root retry did not preserve the deferred Git retry",
      );
      assert.equal(gitIgnoreQueryCalls, 1, "root retry bypassed Git backoff");

      retryTimers.fire(retryTimers.live()[0]);
      await waitFor(
        () => gitIgnoreQueryCalls === 2 && retryTimers.live().length === 0,
        "Git retry did not recover",
      );
      assert.equal(gitIgnoreQueryCalls, 2);
    } finally {
      releaseRootRead?.();
      childProcess.execFile = originalExecFile;
      fs.statSync = originalStat;
      fs.promises.readdir = originalReaddir;
      await session?.dispose();
      fs.watch = originalWatch;
      console.warn = originalWarn;
      retryTimers.restore();
    }
  });
});

test("root-priority reservation theft does not wake unrelated root backoff", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const blockedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-blocked-"));
  const recoveringRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-directory-watch-recovering-"),
  );
  const newcomerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-newcomer-"));
  fs.mkdirSync(path.join(ownerRoot, "child"));
  fs.mkdirSync(path.join(recoveringRoot, "child"));
  const originalWatch = fs.watch;
  const originalStat = fs.statSync;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const retryTimers = captureRetryTimers();
  let releaseRecoveryRead;
  const recoveryRead = new Promise((resolve) => {
    releaseRecoveryRead = resolve;
  });
  let blockRecoveryRead = false;
  let recoveryReadEntered = false;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  fs.promises.readdir = async (directory, ...args) => {
    if (blockRecoveryRead && path.resolve(directory) === path.resolve(recoveringRoot)) {
      blockRecoveryRead = false;
      recoveryReadEntered = true;
      await recoveryRead;
    }
    return originalReaddir.call(fs.promises, directory, ...args);
  };
  console.warn = () => {};
  let ownerSession;
  let blockedSession;
  let recoveringSession;
  let newcomerSession;
  let injectBlockedFailure = false;
  let blockedMetadataFailures = 0;
  try {
    const settings = configuration({ maxWatches: 2 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    blockedSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: blockedRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    recoveringSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: recoveringRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    fs.statSync = (candidate, ...args) => {
      if (injectBlockedFailure && path.resolve(candidate) === path.resolve(blockedRoot)) {
        blockedMetadataFailures += 1;
        const error = new Error("blocked root metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalStat.call(fs, candidate, ...args);
    };

    injectBlockedFailure = true;
    blockRecoveryRead = true;
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => recoveryReadEntered &&
        globalThis[BUDGET_KEY]?.suspendedOwners.size === 1 &&
        globalThis[BUDGET_KEY]?.reserved === 1,
      "recovery reservation was not blocked behind the suspended root",
    );
    const failuresBeforeNewRoot = blockedMetadataFailures;
    assert.equal(retryTimers.live().length, 1);

    newcomerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: newcomerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(newcomerSession.codexLinuxDirectoryWatchCount(), 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      blockedMetadataFailures,
      failuresBeforeNewRoot,
      "root-priority reservation theft bypassed unrelated metadata backoff",
    );
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 1);
    assert.equal(retryTimers.live().length, 1);
    assert.equal(retryTimers.live()[0].delay, 1000);
  } finally {
    releaseRecoveryRead();
    fs.statSync = originalStat;
    await ownerSession?.dispose();
    await blockedSession?.dispose();
    await recoveringSession?.dispose();
    await newcomerSession?.dispose();
    retryTimers.restore();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(blockedRoot, { recursive: true, force: true });
    fs.rmSync(recoveringRoot, { recursive: true, force: true });
    fs.rmSync(newcomerRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("capacity released by a stale sibling retries a budget-deferred directory in-pass", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  for (const name of ["a", "b", "c", "d"]) fs.mkdirSync(path.join(secondRoot, name));
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const watchersByPath = new Map();
  const infos = [];
  let recoveryPhase = false;
  let removedStaleSibling = false;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, options, callback) => {
    const watcher = new FakeWatcher();
    watchersByPath.set(path.resolve(directory), watcher);
    return watcher;
  };
  fs.promises.readdir = async (directory, ...args) => {
    const resolved = path.resolve(directory);
    if (
      recoveryPhase &&
      !removedStaleSibling &&
      resolved === path.join(secondRoot, "b")
    ) {
      removedStaleSibling = true;
      fs.rmSync(resolved, { recursive: true, force: true });
      const error = new Error("watched sibling disappeared");
      error.code = "ENOENT";
      throw error;
    }
    const entries = await originalReaddir.call(fs.promises, directory, ...args);
    if (resolved !== path.resolve(secondRoot)) return entries;
    const order = recoveryPhase ? ["a", "c", "d", "b"] : ["a", "b", "c", "d"];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return order.map((name) => byName.get(name)).filter(Boolean);
  };
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    const settings = configuration({ maxWatches: 5 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 3);

    recoveryPhase = true;
    fs.rmSync(path.join(firstRoot, "child"), { recursive: true, force: true });
    const error = new Error("child watch invalidated");
    error.code = "EIO";
    watchersByPath.get(path.join(firstRoot, "child")).emit("error", error);
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 4,
      "self-released capacity did not cover the deferred sibling",
    );
    assert.equal(removedStaleSibling, true);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 5, limit: 5 });
    assert.equal(
      infos.filter((message) => message.includes("watch coverage recovered")).length,
      1,
    );
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a zero-watch root gets priority over an in-pass deferred-directory replay", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  const thirdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-third-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  for (const name of ["a", "b", "c", "d"]) fs.mkdirSync(path.join(secondRoot, name));
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const watchersByPath = new Map();
  let recoveryPhase = false;
  let blockedReadEntered = false;
  let releaseBlockedRead;
  const blockedRead = new Promise((resolve) => {
    releaseBlockedRead = resolve;
  });
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, options, callback) => {
    const watcher = new FakeWatcher();
    watchersByPath.set(path.resolve(directory), watcher);
    return watcher;
  };
  fs.promises.readdir = async (directory, ...args) => {
    const resolved = path.resolve(directory);
    if (recoveryPhase && resolved === path.join(secondRoot, "b")) {
      blockedReadEntered = true;
      await blockedRead;
      fs.rmSync(resolved, { recursive: true, force: true });
      const error = new Error("watched sibling disappeared");
      error.code = "ENOENT";
      throw error;
    }
    const entries = await originalReaddir.call(fs.promises, directory, ...args);
    if (resolved !== path.resolve(secondRoot)) return entries;
    const order = recoveryPhase ? ["a", "c", "d", "b"] : ["a", "b", "c", "d"];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return order.map((name) => byName.get(name));
  };
  console.warn = () => {};
  let firstSession;
  let secondSession;
  let thirdSession;
  try {
    const settings = configuration({ maxWatches: 5 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 3);

    recoveryPhase = true;
    fs.rmSync(path.join(firstRoot, "child"), { recursive: true, force: true });
    const error = new Error("child watch invalidated");
    error.code = "EIO";
    watchersByPath.get(path.join(firstRoot, "child")).emit("error", error);
    await waitFor(() => blockedReadEntered, "budget recovery did not reach the gated directory");

    thirdSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: thirdRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(thirdSession.codexLinuxDirectoryWatchCount(), 0);
    releaseBlockedRead();
    await waitFor(
      () => thirdSession.codexLinuxDirectoryWatchCount() === 1,
      "released capacity was reused before the uncovered root could claim it",
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 3);
    assert.deepEqual(thirdSession.codexLinuxDirectoryWatchBudget(), { active: 5, limit: 5 });
  } finally {
    releaseBlockedRead();
    await firstSession?.dispose();
    await secondSession?.dispose();
    await thirdSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    fs.rmSync(thirdRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a zero-watch root gets priority over the next ordinary scan directory", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  const thirdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-third-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  for (const name of ["a", "b", "x", "c"]) fs.mkdirSync(path.join(secondRoot, name));
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const watchersByPath = new Map();
  let recoveryPhase = false;
  let blockedReadEntered = false;
  let releaseBlockedRead;
  const blockedRead = new Promise((resolve) => {
    releaseBlockedRead = resolve;
  });
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory) => {
    const watcher = new FakeWatcher();
    watchersByPath.set(path.resolve(directory), watcher);
    return watcher;
  };
  fs.promises.readdir = async (directory, ...args) => {
    const resolved = path.resolve(directory);
    if (recoveryPhase && resolved === path.join(secondRoot, "a")) {
      blockedReadEntered = true;
      await blockedRead;
      fs.rmSync(resolved, { recursive: true, force: true });
      const error = new Error("watched sibling disappeared");
      error.code = "ENOENT";
      throw error;
    }
    const entries = await originalReaddir.call(fs.promises, directory, ...args);
    if (resolved !== path.resolve(secondRoot)) return entries;
    const order = recoveryPhase ? ["x", "a", "c", "b"] : ["a", "b", "x", "c"];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return order.map((name) => byName.get(name));
  };
  console.warn = () => {};
  let firstSession;
  let secondSession;
  let thirdSession;
  try {
    const settings = configuration({ maxWatches: 5 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 3);

    recoveryPhase = true;
    fs.rmSync(path.join(firstRoot, "child"), { recursive: true, force: true });
    const error = new Error("child watch invalidated");
    error.code = "EIO";
    watchersByPath.get(path.join(firstRoot, "child")).emit("error", error);
    await waitFor(() => blockedReadEntered, "budget recovery did not reach the gated directory");

    thirdSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: thirdRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(thirdSession.codexLinuxDirectoryWatchCount(), 0);
    releaseBlockedRead();
    await waitFor(
      () => thirdSession.codexLinuxDirectoryWatchCount() === 1,
      "ordinary scan work reused capacity before the uncovered root could claim it",
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 3);
    assert.deepEqual(thirdSession.codexLinuxDirectoryWatchBudget(), { active: 5, limit: 5 });
  } finally {
    releaseBlockedRead();
    await firstSession?.dispose();
    await secondSession?.dispose();
    await thirdSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    fs.rmSync(thirdRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a queued release notification beats an already-scheduled child scan continuation", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  const thirdRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-third-"));
  const child = path.join(secondRoot, "child");
  fs.mkdirSync(child);
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const callbacksByPath = new Map();
  let racePhase = false;
  let releaseQueued = false;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, options, callback) => {
    callbacksByPath.set(path.resolve(directory), callback);
    return new FakeWatcher();
  };
  fs.promises.readdir = async (directory, ...args) => {
    if (racePhase && path.resolve(directory) === path.resolve(secondRoot)) {
      return [{
        name: "child",
        isDirectory: () => {
          if (!releaseQueued) {
            releaseQueued = true;
            queueMicrotask(() => {
              void firstSession.dispose();
            });
          }
          return true;
        },
        isSymbolicLink: () => false,
      }];
    }
    return originalReaddir.call(fs.promises, directory, ...args);
  };
  console.warn = () => {};
  let firstSession;
  let secondSession;
  let thirdSession;
  try {
    const settings = configuration({ maxWatches: 2 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    thirdSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: thirdRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);
    assert.equal(thirdSession.codexLinuxDirectoryWatchCount(), 0);

    racePhase = true;
    callbacksByPath.get(path.resolve(secondRoot))("rename", null);
    await waitFor(
      () => thirdSession.codexLinuxDirectoryWatchCount() === 1,
      "child scan continuation consumed capacity before root-first notification",
    );
    assert.equal(releaseQueued, true);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(thirdSession.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 2 });
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    await thirdSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    fs.rmSync(thirdRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a recovery does not replay capacity released by its own inode retries", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  const unstableChild = path.join(secondRoot, "child");
  fs.mkdirSync(unstableChild);
  const originalWatch = fs.watch;
  const originalLstat = fs.lstatSync;
  const originalWarn = console.warn;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  let firstSession;
  let secondSession;
  let unstableMetadataReads = 0;
  try {
    const settings = configuration({ maxWatches: 2 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    fs.lstatSync = (candidate, ...args) => {
      const metadata = originalLstat.call(fs, candidate, ...args);
      if (path.resolve(candidate) !== unstableChild) return metadata;
      unstableMetadataReads += 1;
      return {
        dev: metadata.dev,
        ino: unstableMetadataReads % 2 === 0 ? metadata.ino + 1 : metadata.ino,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    };

    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => unstableMetadataReads >= 6,
      "recovery did not exhaust the bounded inode retry attempts",
    );
    const readsAfterRecovery = unstableMetadataReads;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(
      unstableMetadataReads,
      readsAfterRecovery,
      "self-released capacity caused unbounded full recovery scans",
    );
    assert.ok(unstableMetadataReads <= 8, "inode retries exceeded their per-scan bound");
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 1, limit: 2 });
  } finally {
    fs.lstatSync = originalLstat;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("successful in-pass readdir retry can complete budget recovery", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  fs.mkdirSync(path.join(secondRoot, "child"));
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const infos = [];
  let secondRootReadAttempts = 0;
  fs.promises.readdir = async (directory, ...args) => {
    if (path.resolve(directory) === path.resolve(secondRoot)) {
      secondRootReadAttempts += 1;
      if (secondRootReadAttempts === 1) {
        const error = new Error("entry disappeared during recovery");
        error.code = "ENOENT";
        throw error;
      }
    }
    return originalReaddir.call(fs.promises, directory, ...args);
  };
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 2 }),
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => infos.some((message) => message.includes("watch coverage recovered")),
      "successful readdir retry did not complete the partial-coverage episode",
    );
    assert.equal(secondRootReadAttempts, 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 2);
  } finally {
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    console.info = originalInfo;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a child removed during recovery does not leave coverage marked partial", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  const removedChild = path.join(secondRoot, "child");
  fs.mkdirSync(removedChild);
  const originalWatch = fs.watch;
  const originalReaddir = fs.promises.readdir;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const callbacksByPath = new Map();
  const infos = [];
  let removedChildRead = false;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, options, callback) => {
    callbacksByPath.set(path.resolve(directory), callback);
    return new FakeWatcher();
  };
  fs.promises.readdir = async (directory, ...args) => {
    if (!removedChildRead && path.resolve(directory) === removedChild) {
      removedChildRead = true;
      fs.rmSync(removedChild, { recursive: true, force: true });
      const error = new Error("child disappeared");
      error.code = "ENOENT";
      throw error;
    }
    return originalReaddir.call(fs.promises, directory, ...args);
  };
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    const settings = configuration({ maxWatches: 2 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => infos.some((message) => message.includes("watch coverage recovered")),
      "a vanished child kept budget coverage marked partial",
    );
    assert.equal(removedChildRead, true);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);

    const replacement = path.join(secondRoot, "replacement");
    fs.mkdirSync(replacement);
    callbacksByPath.get(path.resolve(secondRoot))("rename", "replacement");
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 2,
      "replacement child was not watched",
    );
    assert.equal(
      infos.filter((message) => message.includes("watch coverage recovered")).length,
      1,
    );
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    fs.promises.readdir = originalReaddir;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a metadata failure during recovery does not falsely mark coverage complete", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  const unreadableChild = path.join(secondRoot, "child");
  fs.mkdirSync(unreadableChild);
  const originalWatch = fs.watch;
  const originalLstat = fs.lstatSync;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const callbacksByPath = new Map();
  const infos = [];
  let failChildMetadata = false;
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = (directory, options, callback) => {
    callbacksByPath.set(path.resolve(directory), callback);
    return new FakeWatcher();
  };
  fs.lstatSync = (candidate, ...args) => {
    if (failChildMetadata && path.resolve(candidate) === unreadableChild) {
      const error = new Error("metadata temporarily unavailable");
      error.code = "EACCES";
      throw error;
    }
    return originalLstat.call(fs, candidate, ...args);
  };
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    const settings = configuration({ maxWatches: 2 });
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    failChildMetadata = true;
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 1,
      "partial recovery did not acquire the available root watch",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      infos.some((message) => message.includes("watch coverage recovered")),
      false,
      "an extant child with unavailable metadata was treated as absent",
    );

    failChildMetadata = false;
    callbacksByPath.get(path.resolve(secondRoot))("rename", null);
    await waitFor(
      () => infos.some((message) => message.includes("watch coverage recovered")),
      "successful reconciliation did not recover coverage",
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 2);
  } finally {
    fs.lstatSync = originalLstat;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("released capacity reloads ignores for an already-watched partial root", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  spawnSync("git", ["init", "-q", secondRoot]);
  const wrapper = path.join(secondRoot, "wrapper");
  const generated = path.join(wrapper, "generated");
  fs.mkdirSync(generated, { recursive: true });
  const nestedIgnore = path.join(wrapper, ".gitignore");
  fs.writeFileSync(nestedIgnore, "");
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const infos = [];
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 5 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 5, honorGitIgnore: true }),
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 5, limit: 5 });

    fs.writeFileSync(nestedIgnore, "generated/\n");
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => infos.some((message) => message.includes("watch coverage recovered")),
      "partially covered root did not finish released-capacity recovery",
    );
    assert.equal(
      secondSession.codexLinuxDirectoryWatchCount(),
      2,
      "released-capacity recovery scanned with stale nested Git-ignore state",
    );
  } finally {
    console.warn = originalWarn;
    console.info = originalInfo;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("released-capacity recovery does not queue itself again while pruning stale watches", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  spawnSync("git", ["init", "-q", secondRoot]);
  const watchedChild = path.join(secondRoot, "watched-child");
  fs.mkdirSync(path.join(watchedChild, "initial-nested"), { recursive: true });
  const originalExecFile = childProcess.execFile;
  const originalWatch = fs.watch;
  const originalWarn = console.warn;
  const originalInfo = console.info;
  const infos = [];
  class FakeWatcher extends EventEmitter {
    close() {}
  }
  fs.watch = () => new FakeWatcher();
  console.warn = () => {};
  console.info = (...args) => infos.push(args.join(" "));
  let firstSession;
  let secondSession;
  let gitCallsDuringRecovery = 0;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 6 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 6, honorGitIgnore: true }),
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 2);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 6, limit: 6 });

    fs.rmSync(watchedChild, { recursive: true, force: true });
    fs.mkdirSync(path.join(watchedChild, "replacement-nested"), { recursive: true });
    childProcess.execFile = (command, args, options, callback) => {
      const rootIndex = args.indexOf("-C");
      if (rootIndex >= 0 && args[rootIndex + 1] === secondRoot) {
        gitCallsDuringRecovery += 1;
      }
      return originalExecFile(command, args, options, callback);
    };

    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => infos.some((message) => message.includes("watch coverage recovered")),
      "stale-watch recovery did not complete",
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      gitCallsDuringRecovery,
      3,
      "released-capacity recovery queued a duplicate Git refresh behind itself",
    );
  } finally {
    childProcess.execFile = originalExecFile;
    fs.watch = originalWatch;
    console.warn = originalWarn;
    console.info = originalInfo;
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a budget-starved root reloads Git ignores before recovering coverage", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(firstRoot, name));
  spawnSync("git", ["init", "-q", secondRoot]);
  fs.writeFileSync(path.join(secondRoot, ".gitignore"), "ignored/\n");
  let firstSession;
  let secondSession;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 4 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 4, honorGitIgnore: true }),
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 4);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 0);

    fs.mkdirSync(path.join(secondRoot, "ignored", "deep"), { recursive: true });
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() > 0,
      "starved working tree did not acquire its released root watch",
    );
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a budget-starved Git refresh watch reloads ignores when coverage recovers", async () => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-first-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-second-"));
  fs.mkdirSync(path.join(firstRoot, "child"));
  spawnSync("git", ["init", "-q", secondRoot]);
  const excludePath = path.join(secondRoot, ".git", "info", "exclude");
  fs.writeFileSync(excludePath, "ignored/\n");
  fs.mkdirSync(path.join(secondRoot, "ignored"));
  let firstSession;
  let secondSession;
  try {
    firstSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: firstRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 4 }),
    );
    secondSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: secondRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 4, honorGitIgnore: true }),
    );
    assert.equal(firstSession.codexLinuxDirectoryWatchCount(), 2);
    assert.equal(secondSession.codexLinuxDirectoryWatchCount(), 1);
    assert.deepEqual(secondSession.codexLinuxDirectoryWatchBudget(), { active: 4, limit: 4 });

    fs.writeFileSync(excludePath, "");
    await firstSession.dispose();
    firstSession = null;
    await waitFor(
      () => secondSession.codexLinuxDirectoryWatchCount() === 2,
      "newly installed Git refresh watch did not reconcile missed ignore changes",
    );
  } finally {
    await firstSession?.dispose();
    await secondSession?.dispose();
    fs.rmSync(firstRoot, { recursive: true, force: true });
    fs.rmSync(secondRoot, { recursive: true, force: true });
    resetBudget();
  }
});

test("a successful Git metadata retry wakes suspended budget recovery", async () => {
  const ownerRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-owner-"));
  const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-directory-watch-git-"));
  for (const name of ["a", "b", "c"]) fs.mkdirSync(path.join(ownerRoot, name));
  spawnSync("git", ["init", "-q", gitRoot]);
  const gitChild = path.join(gitRoot, "child");
  fs.mkdirSync(gitChild);
  const originalExecFile = childProcess.execFile;
  const originalLstat = fs.lstatSync;
  const originalWarn = console.warn;
  const retryTimers = captureRetryTimers();
  console.warn = () => {};
  let ownerSession;
  let gitSession;
  let remainingDiscoveryFailures = 4;
  let injectChildMetadataFailure = false;
  let childMetadataFailures = 0;
  try {
    const settings = configuration({ maxWatches: 4 });
    ownerSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: ownerRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      settings,
    );
    gitSession = await codexLinuxStartDirectoryOnlyWorkingTreeWatch(
      fakeHost(),
      {
        path: gitRoot,
        recursive: true,
        renameEventHandling: "changed-path-with-parent-directory",
        onChange: () => {},
      },
      configuration({ maxWatches: 4, honorGitIgnore: true }),
    );
    assert.equal(ownerSession.codexLinuxDirectoryWatchCount(), 4);
    assert.equal(gitSession.codexLinuxDirectoryWatchCount(), 0);

    childProcess.execFile = (command, args, options, callback) => {
      if (args.includes("rev-parse") && remainingDiscoveryFailures > 0) {
        remainingDiscoveryFailures -= 1;
        setImmediate(() => callback(Object.assign(new Error("timed out"), {
          code: null,
          killed: true,
          signal: "SIGKILL",
        }), "", ""));
        return new EventEmitter();
      }
      return originalExecFile(command, args, options, callback);
    };
    await ownerSession.dispose();
    ownerSession = null;
    await waitFor(
      () => retryTimers.live().length === 1 &&
        globalThis[BUDGET_KEY]?.suspendedOwners.size === 1,
      "incomplete Git discovery did not suspend released-capacity recovery",
    );
    assert.deepEqual(gitSession.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 4 });

    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => remainingDiscoveryFailures === 0 && retryTimers.live().length === 1,
      "failed Git discovery retry did not retain its backoff timer",
    );
    assert.equal(retryTimers.live()[0].delay, 2000);
    assert.deepEqual(gitSession.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 4 });
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      gitSession.codexLinuxDirectoryWatchBudget(),
      { active: 2, limit: 4 },
      "failed Git discovery bypassed its next backoff",
    );

    childProcess.execFile = originalExecFile;
    fs.lstatSync = (candidate, ...args) => {
      if (
        injectChildMetadataFailure &&
        childMetadataFailures === 0 &&
        path.resolve(candidate) === gitChild
      ) {
        childMetadataFailures += 1;
        const error = new Error("child metadata is temporarily stale");
        error.code = "ESTALE";
        throw error;
      }
      return originalLstat.call(fs, candidate, ...args);
    };
    injectChildMetadataFailure = true;
    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => childMetadataFailures === 1 && retryTimers.live().length === 1,
      "successful Git discovery did not retain the cross-domain metadata retry",
    );
    assert.equal(retryTimers.live()[0].delay, 1000);
    assert.deepEqual(gitSession.codexLinuxDirectoryWatchBudget(), { active: 2, limit: 4 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      gitSession.codexLinuxDirectoryWatchBudget(),
      { active: 2, limit: 4 },
      "Git retry success bypassed the newly armed root metadata backoff",
    );

    retryTimers.fire(retryTimers.live()[0]);
    await waitFor(
      () => gitSession.codexLinuxDirectoryWatchBudget().active === 4,
      "successful Git discovery retry did not wake metadata-watch recovery",
    );
    assert.equal(globalThis[BUDGET_KEY].suspendedOwners.size, 0);
    assert.deepEqual(retryTimers.live(), []);
  } finally {
    childProcess.execFile = originalExecFile;
    fs.lstatSync = originalLstat;
    await ownerSession?.dispose();
    await gitSession?.dispose();
    retryTimers.restore();
    console.warn = originalWarn;
    fs.rmSync(ownerRoot, { recursive: true, force: true });
    fs.rmSync(gitRoot, { recursive: true, force: true });
    resetBudget();
  }
});
