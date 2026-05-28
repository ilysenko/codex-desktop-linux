# Readiness Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `make readiness-check`, a sanitized one-command readiness report for a local Codex Desktop Linux install.

**Architecture:** Add one Node CLI, `scripts/codex-readiness-check.js`, that composes existing checks instead of duplicating them. The script exposes small pure helpers for parsing, aggregation, and formatting, while subprocess orchestration stays injectable for tests. `Makefile`, README, CHANGELOG, and smoke tests wire the command into the existing release workflow.

**Tech Stack:** Node.js CommonJS, `node:test`, Make, Bash smoke tests, existing `codex-desktop-doctor`, existing `scripts/codex-history-context-check.js`, `systemctl --user`, `git`.

---

## File Structure

- Create `scripts/codex-readiness-check.js`: CLI entrypoint plus exported helper functions. Responsibilities: parse args, run bounded subprocess checks, aggregate statuses, print human or JSON output, avoid private data.
- Create `scripts/codex-readiness-check.test.js`: pure unit tests for parser, aggregation, sanitization, repo status classification, JSON shape, and fake orchestration.
- Modify `Makefile`: add `readiness-check` to `.PHONY`, help output, and target body.
- Modify `tests/scripts_smoke.sh`: add a test function for syntax/unit checks and Make help coverage, then call it from `main`.
- Modify `README.md`: document `make readiness-check` near installed doctor/history-check guidance.
- Modify `CHANGELOG.md`: add an Unreleased entry.

## Task 1: Unit-Test The Readiness Helpers First

**Files:**
- Create: `scripts/codex-readiness-check.test.js`
- Create: `scripts/codex-readiness-check.js`

- [ ] **Step 1: Create a red-phase module with exported names**

Create `scripts/codex-readiness-check.js` with enough exports for tests to load:

```js
#!/usr/bin/env node
"use strict";

function parseDoctorSummary() {
  throw new Error("parseDoctorSummary red phase");
}

function aggregateChecks() {
  throw new Error("aggregateChecks red phase");
}

function classifyRepoStatus() {
  throw new Error("classifyRepoStatus red phase");
}

function formatHumanReport() {
  throw new Error("formatHumanReport red phase");
}

function sanitizeMessage(value) {
  return String(value ?? "").slice(0, 240);
}

module.exports = {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseDoctorSummary,
  sanitizeMessage,
};
```

- [ ] **Step 2: Write failing tests for pure helper behavior**

Create `scripts/codex-readiness-check.test.js`:

```js
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseDoctorSummary,
  sanitizeMessage,
} = require("./codex-readiness-check.js");

test("parseDoctorSummary extracts pass warn fail info counts", () => {
  assert.deepEqual(parseDoctorSummary("noise\nSummary: 25 pass, 0 warn, 0 fail, 3 info\n"), {
    pass: 25,
    warn: 0,
    fail: 0,
    info: 3,
  });
});

test("aggregateChecks reports ready with warnings when there are no failures", () => {
  const result = aggregateChecks([
    { id: "package", status: "pass", message: "codex-desktop 1" },
    { id: "repo", status: "warn", message: "untracked output/ is present" },
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, {
    status: "ready-with-warnings",
    pass: 1,
    warn: 1,
    fail: 0,
  });
});

test("aggregateChecks fails when any check fails", () => {
  const result = aggregateChecks([
    { id: "doctor", status: "fail", message: "doctor has failures" },
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, {
    status: "not-ready",
    pass: 0,
    warn: 0,
    fail: 1,
  });
});

test("classifyRepoStatus treats only output/ as warning", () => {
  assert.deepEqual(classifyRepoStatus("## branch\n?? output/\n"), {
    status: "warn",
    message: "untracked output/ is present",
    details: {
      untrackedOutput: true,
      otherChanges: false,
    },
  });
});

test("classifyRepoStatus fails on unrelated changes", () => {
  assert.deepEqual(classifyRepoStatus("## branch\n M README.md\n?? output/\n"), {
    status: "fail",
    message: "repo has uncommitted changes outside output/",
    details: {
      untrackedOutput: true,
      otherChanges: true,
    },
  });
});

test("sanitizeMessage removes private-looking paths and truncates", () => {
  const message = sanitizeMessage("/home/remy/.codex/sessions/private.jsonl secret ".repeat(20));

  assert.equal(message.includes(".jsonl"), false);
  assert.equal(message.includes("/home/remy/.codex/sessions"), false);
  assert.ok(message.length <= 240);
});

test("formatHumanReport prints no raw details object or private paths", () => {
  const report = aggregateChecks([
    {
      id: "history",
      status: "pass",
      message: "memory ok, thread/list responded",
      details: {
        rawPath: "/home/remy/.codex/sessions/private.jsonl",
      },
    },
  ]);

  const output = formatHumanReport(report);

  assert.match(output, /Codex Desktop Linux readiness/);
  assert.match(output, /PASS history/);
  assert.equal(output.includes("rawPath"), false);
  assert.equal(output.includes(".jsonl"), false);
});
```

- [ ] **Step 3: Run the helper tests and confirm the expected failure**

Run:

```bash
node --test scripts/codex-readiness-check.test.js
```

Expected: FAIL with `parseDoctorSummary red phase`.

- [ ] **Step 4: Implement pure helpers**

Replace `scripts/codex-readiness-check.js` with:

```js
#!/usr/bin/env node
"use strict";

const PRIVATE_PATH_PATTERN = /\/home\/[^/\s]+\/\.codex\/sessions\/[^\s]+/g;

function sanitizeMessage(value) {
  return String(value ?? "")
    .replace(PRIVATE_PATH_PATTERN, "[redacted-session-path]")
    .replace(/[^ -~\n\t]/g, "?")
    .slice(0, 240);
}

function parseDoctorSummary(stdout) {
  const match = String(stdout ?? "").match(/Summary:\s*(\d+)\s+pass,\s*(\d+)\s+warn,\s*(\d+)\s+fail,\s*(\d+)\s+info/);
  if (!match) {
    return null;
  }
  return {
    pass: Number.parseInt(match[1], 10),
    warn: Number.parseInt(match[2], 10),
    fail: Number.parseInt(match[3], 10),
    info: Number.parseInt(match[4], 10),
  };
}

function aggregateChecks(checks) {
  const normalizedChecks = checks.map((check) => ({
    id: String(check.id),
    status: check.status,
    message: sanitizeMessage(check.message),
    ...(check.details == null ? {} : { details: check.details }),
  }));
  const summary = { status: "ready", pass: 0, warn: 0, fail: 0 };
  for (const check of normalizedChecks) {
    if (check.status === "pass") summary.pass += 1;
    if (check.status === "warn") summary.warn += 1;
    if (check.status === "fail") summary.fail += 1;
  }
  if (summary.fail > 0) {
    summary.status = "not-ready";
  } else if (summary.warn > 0) {
    summary.status = "ready-with-warnings";
  }
  return {
    ok: summary.fail === 0,
    summary,
    checks: normalizedChecks,
  };
}

function classifyRepoStatus(stdout) {
  const lines = String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !line.startsWith("## "));
  const untrackedOutput = lines.some((line) => line === "?? output/" || line === "?? output");
  const otherChanges = lines.some((line) => line !== "?? output/" && line !== "?? output");
  if (otherChanges) {
    return {
      status: "fail",
      message: "repo has uncommitted changes outside output/",
      details: { untrackedOutput, otherChanges },
    };
  }
  if (untrackedOutput) {
    return {
      status: "warn",
      message: "untracked output/ is present",
      details: { untrackedOutput, otherChanges },
    };
  }
  return {
    status: "pass",
    message: "repo clean",
    details: { untrackedOutput: false, otherChanges: false },
  };
}

function formatHumanReport(report) {
  const lines = ["Codex Desktop Linux readiness", ""];
  for (const check of report.checks) {
    const label = check.status.toUpperCase().padEnd(4, " ");
    lines.push(`${label} ${check.id.padEnd(12, " ")} ${sanitizeMessage(check.message)}`);
  }
  lines.push("");
  if (report.summary.fail > 0) {
    lines.push(`Summary: not ready (${report.summary.fail} failure${report.summary.fail === 1 ? "" : "s"})`);
  } else if (report.summary.warn > 0) {
    lines.push(`Summary: ready with ${report.summary.warn} warning${report.summary.warn === 1 ? "" : "s"}`);
  } else {
    lines.push("Summary: ready");
  }
  return `${lines.join("\n")}\n`;
}

module.exports = {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseDoctorSummary,
  sanitizeMessage,
};
```

- [ ] **Step 5: Run helper tests and syntax check**

Run:

```bash
node --check scripts/codex-readiness-check.js
node --test scripts/codex-readiness-check.test.js
```

Expected: both commands pass.

- [ ] **Step 6: Commit Task 1**

Run:

```bash
git add scripts/codex-readiness-check.js scripts/codex-readiness-check.test.js
git commit -m "test: add readiness check helpers"
```

Expected: commit succeeds.

## Task 2: Add Bounded Check Orchestration And CLI Output

**Files:**
- Modify: `scripts/codex-readiness-check.js`
- Modify: `scripts/codex-readiness-check.test.js`

- [ ] **Step 1: Add failing tests for orchestration with a fake runner**

Append to `scripts/codex-readiness-check.test.js`:

```js
const { runReadinessCheck, parseArgs } = require("./codex-readiness-check.js");

test("parseArgs supports json and timeout options", () => {
  assert.deepEqual(parseArgs(["--json", "--timeout-ms", "1234", "--cwd", "/tmp/repo"]), {
    cwd: "/tmp/repo",
    json: true,
    timeoutMs: 1234,
  });
});

test("runReadinessCheck composes package doctor services remote repo and history checks", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "dpkg-query") {
      return { code: 0, stdout: "codex-desktop 2026.05.28.042624+paritycacd32b\n", stderr: "" };
    }
    if (command === "cat") {
      return {
        code: 0,
        stdout: JSON.stringify({
          source: {
            shortCommit: "cacd32b65470",
            branch: "codex/local-parity-lab",
            dirty: true,
          },
        }),
        stderr: "",
      };
    }
    if (command === "/usr/bin/codex-desktop-doctor") {
      return { code: 0, stdout: "Summary: 25 pass, 0 warn, 0 fail, 3 info\n", stderr: "" };
    }
    if (command === "systemctl") {
      return { code: 0, stdout: "active\nactive\n", stderr: "" };
    }
    if (command === "pgrep") {
      return { code: 0, stdout: "123 codex app-server --remote-control\n", stderr: "" };
    }
    if (command === "node") {
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          memoryContext: { sessionStateExists: true, currentExists: true },
          threadHistory: { responded: true, cwdFilteredThreadCount: 0 },
        }),
        stderr: "",
      };
    }
    if (command === "git") {
      return { code: 0, stdout: "## branch\n?? output/\n", stderr: "" };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const report = await runReadinessCheck({ cwd: "/repo", timeoutMs: 1000 }, runner);

  assert.equal(report.ok, true);
  assert.equal(report.summary.status, "ready-with-warnings");
  assert.deepEqual(report.checks.map((check) => check.id), [
    "package",
    "build-info",
    "doctor",
    "services",
    "remote",
    "history",
    "repo",
  ]);
  assert.ok(calls.includes("node scripts/codex-history-context-check.js --cwd /repo"));
});
```

- [ ] **Step 2: Run tests and confirm the expected failure**

Run:

```bash
node --test scripts/codex-readiness-check.test.js
```

Expected: FAIL because `runReadinessCheck` and `parseArgs` are not exported yet.

- [ ] **Step 3: Add subprocess helper and CLI parsing**

Extend `scripts/codex-readiness-check.js` with these functions above `module.exports`:

```js
const { spawn } = require("node:child_process");
const path = require("node:path");

const DEFAULT_TIMEOUT_MS = 5000;
const BUILD_INFO_PATH = "/opt/codex-desktop/.codex-linux/build-info.json";

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env) {
  const parsed = {
    cwd: env.CODEX_READINESS_CWD || process.cwd(),
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--json":
        parsed.json = true;
        break;
      case "--cwd":
        index += 1;
        if (index >= argv.length) throw new Error("--cwd requires a value");
        parsed.cwd = argv[index];
        break;
      case "--timeout-ms":
        index += 1;
        if (index >= argv.length) throw new Error("--timeout-ms requires a value");
        parsed.timeoutMs = parsePositiveInt(argv[index], "--timeout-ms");
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(error?.message || error) });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: signal === "SIGTERM" ? 124 : (code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}
```

- [ ] **Step 4: Add individual check functions**

Add these functions below `runCommand`:

```js
async function checkPackage(options, runner) {
  const result = await runner("dpkg-query", ["-W", "-f=${Package} ${Version}\\n", "codex-desktop"], options);
  if (result.code === 0 && result.stdout.trim()) {
    return { id: "package", status: "pass", message: result.stdout.trim() };
  }
  return { id: "package", status: "warn", message: "codex-desktop package not found by dpkg-query" };
}

async function checkBuildInfo(options, runner) {
  const result = await runner("cat", [BUILD_INFO_PATH], options);
  if (result.code !== 0) {
    return { id: "build-info", status: "fail", message: "installed Linux build metadata is missing" };
  }
  try {
    const info = JSON.parse(result.stdout);
    const source = info.source || {};
    if (!source.shortCommit) {
      return { id: "build-info", status: "fail", message: "installed Linux build metadata has no source commit" };
    }
    return {
      id: "build-info",
      status: "pass",
      message: `source=${source.shortCommit} branch=${source.branch || "unknown"} dirty=${String(source.dirty)}`,
      details: {
        shortCommit: source.shortCommit,
        branch: source.branch || null,
        dirty: source.dirty ?? null,
      },
    };
  } catch {
    return { id: "build-info", status: "fail", message: "installed Linux build metadata is invalid JSON" };
  }
}

async function checkDoctor(options, runner) {
  const result = await runner("/usr/bin/codex-desktop-doctor", [], options);
  const summary = parseDoctorSummary(result.stdout);
  if (result.code !== 0 || summary == null) {
    return { id: "doctor", status: "fail", message: "codex-desktop-doctor did not return a valid summary" };
  }
  const status = summary.fail > 0 ? "fail" : "pass";
  return {
    id: "doctor",
    status,
    message: `${summary.pass} pass / ${summary.warn} warn / ${summary.fail} fail / ${summary.info} info`,
    details: summary,
  };
}

async function checkServices(options, runner) {
  const result = await runner("systemctl", ["--user", "is-active", "codex-desktop.service", "codex-update-manager.service"], options);
  const states = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const desktop = states[0] || "unknown";
  const updater = states[1] || "unknown";
  const ok = desktop === "active" && updater === "active";
  return {
    id: "services",
    status: ok ? "pass" : "fail",
    message: `codex-desktop.service=${desktop} codex-update-manager.service=${updater}`,
    details: { desktop, updater },
  };
}

async function checkRemote(options, runner) {
  const result = await runner("pgrep", ["-af", "codex app-server --remote-control"], options);
  const present = result.code === 0 && result.stdout.trim().length > 0;
  return {
    id: "remote",
    status: present ? "pass" : "warn",
    message: present ? "app-server --remote-control present" : "app-server --remote-control not detected",
    details: { present },
  };
}

async function checkHistory(options, runner) {
  const script = path.join("scripts", "codex-history-context-check.js");
  const result = await runner("node", [script, "--cwd", options.cwd], { ...options, cwd: options.cwd });
  try {
    const payload = JSON.parse(result.stdout);
    if (result.code === 0 && payload.ok === true) {
      return {
        id: "history",
        status: "pass",
        message: "memory ok, thread/list responded",
        details: {
          memoryOk: Boolean(payload.memoryContext?.sessionStateExists && payload.memoryContext?.currentExists),
          threadListResponded: Boolean(payload.threadHistory?.responded),
          cwdFilteredThreadCount: payload.threadHistory?.cwdFilteredThreadCount ?? null,
        },
      };
    }
  } catch {
    return { id: "history", status: "fail", message: "history check printed invalid JSON" };
  }
  return { id: "history", status: "fail", message: "history check failed" };
}

async function checkRepo(options, runner) {
  const result = await runner("git", ["status", "--short", "--branch"], { ...options, cwd: options.cwd });
  const repo = classifyRepoStatus(result.stdout);
  return { id: "repo", ...repo };
}
```

- [ ] **Step 5: Add orchestration, usage, and main**

Add these functions below the check functions:

```js
function usage() {
  return [
    "Usage: codex-readiness-check.js [options]",
    "",
    "Checks installed Codex Desktop Linux readiness without printing private session content.",
    "",
    "Options:",
    "  --json             Print JSON instead of human output",
    "  --cwd PATH         Repo/workspace path (default: cwd)",
    "  --timeout-ms MS    Per-command timeout (default: 5000)",
    "  -h, --help         Show this help",
  ].join("\n");
}

async function runReadinessCheck(options, runner = runCommand) {
  const commandOptions = {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
  };
  const checks = [];
  checks.push(await checkPackage(commandOptions, runner));
  checks.push(await checkBuildInfo(commandOptions, runner));
  checks.push(await checkDoctor(commandOptions, runner));
  checks.push(await checkServices(commandOptions, runner));
  checks.push(await checkRemote(commandOptions, runner));
  checks.push(await checkHistory(commandOptions, runner));
  checks.push(await checkRepo(commandOptions, runner));
  return aggregateChecks(checks);
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const report = await runReadinessCheck(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatHumanReport(report));
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const payload = { ok: false, error: sanitizeMessage(error?.message || error) };
    console.error(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
```

Update `module.exports` so it includes:

```js
module.exports = {
  aggregateChecks,
  classifyRepoStatus,
  formatHumanReport,
  parseArgs,
  parseDoctorSummary,
  runReadinessCheck,
  sanitizeMessage,
};
```

- [ ] **Step 6: Run orchestration tests**

Run:

```bash
node --check scripts/codex-readiness-check.js
node --test scripts/codex-readiness-check.test.js
```

Expected: both pass.

- [ ] **Step 7: Manually run JSON output**

Run:

```bash
node scripts/codex-readiness-check.js --json | jq '{ok, summary, checks: [.checks[].id]}'
```

Expected: valid JSON with `package`, `build-info`, `doctor`, `services`, `remote`, `history`, and `repo` check IDs. Exit code is zero when there are no failures.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add scripts/codex-readiness-check.js scripts/codex-readiness-check.test.js
git commit -m "feat: add readiness check script"
```

Expected: commit succeeds.

## Task 3: Wire Makefile And Smoke Tests

**Files:**
- Modify: `Makefile`
- Modify: `tests/scripts_smoke.sh`

- [ ] **Step 1: Write the failing smoke coverage first**

Add this function near `test_codex_history_context_checker_unit_tests` in `tests/scripts_smoke.sh`:

```bash
test_codex_readiness_checker_unit_tests() {
    info "Checking Codex Desktop readiness checker"
    node --check "$REPO_DIR/scripts/codex-readiness-check.js"
    node --check "$REPO_DIR/scripts/codex-readiness-check.test.js"
    node --test "$REPO_DIR/scripts/codex-readiness-check.test.js"
    make -C "$REPO_DIR" help | grep -Fq "make readiness-check" \
        || fail "Expected make help to list readiness-check"
}
```

Add this call after `test_codex_history_context_checker_unit_tests` in `main()`:

```bash
    test_codex_readiness_checker_unit_tests
```

- [ ] **Step 2: Run smoke test and confirm the expected failure**

Run:

```bash
bash tests/scripts_smoke.sh
```

Expected: FAIL with `Expected make help to list readiness-check`.

- [ ] **Step 3: Add `readiness-check` to `.PHONY`**

In `Makefile`, update the `.PHONY` line to include `readiness-check`:

```make
.PHONY: help check test build-updater maybe-build-updater update rebuild rebuild-install inspect-upstream build-app build-app-fresh setup-native bootstrap-native install-native update-native rebuild-next run-app build-dev-app run-dev-app deb rpm pacman appimage package install service-enable service-status app-service-enable app-service-disable app-service-status doctor history-check readiness-check clean-dist clean-state
```

- [ ] **Step 4: Add Make help output**

In `Makefile`, directly after the `history-check` help line, add:

```make
	@printf '  %-18s %s\n' "make readiness-check" "Run doctor, services, history, remote, package, and repo readiness checks"
```

- [ ] **Step 5: Add the target**

In `Makefile`, directly after the `history-check` target, add:

```make
readiness-check:
	@echo "[make] Checking Codex Desktop Linux readiness"
	node scripts/codex-readiness-check.js --cwd "$(CURDIR)"
```

- [ ] **Step 6: Run focused checks**

Run:

```bash
make help | grep -F "make readiness-check"
node --test scripts/codex-readiness-check.test.js
```

Expected: help line appears and unit tests pass.

- [ ] **Step 7: Commit Task 3**

Run:

```bash
git add Makefile tests/scripts_smoke.sh
git commit -m "build: wire readiness check target"
```

Expected: commit succeeds.

## Task 4: Document The Readiness Command

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add README docs near installed doctor**

In `README.md`, after the installed doctor paragraph, add:

````markdown
### Readiness check

For a handoff-safe local status report, run:

```bash
make readiness-check
node scripts/codex-readiness-check.js --json
```

The readiness check composes the installed doctor, package/build metadata,
`systemd --user` service state, remote-control app-server presence, repository
state, and the redacted Codex history/memory check. It is read-only: it does
not revoke mobile access, re-pair devices, restart services, log out, reboot,
or print private session contents.
````

- [ ] **Step 2: Add CHANGELOG entry**

In `CHANGELOG.md`, under `[Unreleased]` `### Added`, add:

```markdown
- `make readiness-check` now runs a sanitized handoff/readiness report that
  composes the installed doctor, package/build metadata, user services,
  remote-control process presence, repo status, and redacted history/memory
  continuity checks.
```

- [ ] **Step 3: Check docs diff**

Run:

```bash
git diff -- README.md CHANGELOG.md
```

Expected: docs describe only the new readiness command and do not mention secrets, screenshots, raw thread IDs, or mobile QR data.

- [ ] **Step 4: Commit Task 4**

Run:

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document readiness check"
```

Expected: commit succeeds.

## Task 5: Final Verification And Push

**Files:**
- Verify all touched files.

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
node --check scripts/codex-readiness-check.js
node --test scripts/codex-readiness-check.test.js
```

Expected: both pass.

- [ ] **Step 2: Run the full script smoke suite**

Run:

```bash
bash tests/scripts_smoke.sh
```

Expected: exits 0 and prints `All script smoke tests passed`.

- [ ] **Step 3: Run live readiness checks**

Run:

```bash
make readiness-check
node scripts/codex-readiness-check.js --json | jq '{ok, summary, checkIds: [.checks[].id]}'
```

Expected: human output is concise and redacted; JSON is valid. Exit code is zero if all checks are pass/warn and nonzero only if there is at least one fail.

- [ ] **Step 4: Run whitespace check**

Run:

```bash
git diff --check
```

Expected: no output and exit 0.

- [ ] **Step 5: Inspect final status**

Run:

```bash
git status --short --branch
git log --oneline -5
```

Expected: branch contains the readiness commits and only the pre-existing `output/` is untracked.

- [ ] **Step 6: Push**

Run:

```bash
git push fork codex/local-parity-lab
```

Expected: push succeeds.

- [ ] **Step 7: Update memory checkpoint**

Run the existing memory checkpoint workflow:

```bash
pwsh -NoProfile -ExecutionPolicy Bypass -File /home/remy/.codex/scripts/codex-memory-harness.ps1 -Action checkpoint 2>&1 | head -80
```

Then ensure `/home/remy/.codex/memories/SESSION_STATE.json` still lists only `output/` under `uncommitted_files`.

## Self-Review

- Spec coverage: every design requirement is represented. Package/build metadata, doctor, services, remote, repo status, and history checks are Task 2. Human/JSON output is Task 2. Makefile, docs, changelog, and smoke tests are Tasks 3 and 4. Verification is Task 5.
- Placeholder scan: no unfinished markers or missing code steps are present.
- Type consistency: all plan snippets use `status: "pass" | "warn" | "fail"`, `summary.status`, `checks`, `details`, and `runReadinessCheck` consistently.
- Scope check: this plan implements only the readiness command and documentation. It does not restart services, change mobile pairing, modify installed doctor behavior, or alter package build/runtime behavior.
