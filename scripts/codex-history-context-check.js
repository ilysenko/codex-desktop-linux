#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 5000;

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv, env = process.env) {
  const parsed = {
    codexBin: env.CODEX_HISTORY_CHECK_CODEX_BIN || "codex",
    cwd: env.CODEX_HISTORY_CHECK_CWD || process.cwd(),
    json: true,
    limit: DEFAULT_LIMIT,
    memoryDir: env.CODEX_HISTORY_CHECK_MEMORY_DIR || path.join(env.HOME || "", ".codex", "memories"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipAppServer: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--codex-bin":
        index += 1;
        if (index >= argv.length) throw new Error("--codex-bin requires a value");
        parsed.codexBin = argv[index];
        break;
      case "--cwd":
        index += 1;
        if (index >= argv.length) throw new Error("--cwd requires a value");
        parsed.cwd = argv[index];
        break;
      case "--limit":
        index += 1;
        if (index >= argv.length) throw new Error("--limit requires a value");
        parsed.limit = parsePositiveInt(argv[index], "--limit");
        break;
      case "--memory-dir":
        index += 1;
        if (index >= argv.length) throw new Error("--memory-dir requires a value");
        parsed.memoryDir = argv[index];
        break;
      case "--timeout-ms":
        index += 1;
        if (index >= argv.length) throw new Error("--timeout-ms requires a value");
        parsed.timeoutMs = parsePositiveInt(argv[index], "--timeout-ms");
        break;
      case "--skip-app-server":
        parsed.skipAppServer = true;
        break;
      case "--json":
        parsed.json = true;
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

function usage() {
  return [
    "Usage: codex-history-context-check.js [options]",
    "",
    "Checks that local Codex session history and memory context are available.",
    "Output is redacted: no thread ids, titles, previews, message text, or log paths.",
    "",
    "Options:",
    "  --codex-bin PATH       Codex binary to run (default: codex)",
    "  --cwd PATH             Workspace path for memory comparison and cwd-filtered thread count (default: cwd)",
    "  --limit N              Thread list page size (default: 10)",
    "  --memory-dir DIR       Memory directory (default: ~/.codex/memories)",
    "  --timeout-ms MS        App-server timeout (default: 5000)",
    "  --skip-app-server      Only check memory files",
    "  --json                 Print JSON (default)",
    "  -h, --help             Show this help",
  ].join("\n");
}

function sourceKind(source) {
  if (typeof source === "string" && source.trim()) return source.trim();
  if (source && typeof source === "object") {
    for (const key of ["kind", "type", "name"]) {
      if (typeof source[key] === "string" && source[key].trim()) return source[key].trim();
    }
  }
  return "unknown";
}

function normalizePath(value) {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return path.resolve(value);
}

function sanitizeThreads(threads, currentCwd) {
  const sourceCounts = {};
  const normalizedCwd = normalizePath(currentCwd);
  let matchingCwdThreadCount = 0;
  let newestUpdatedAt = null;

  for (const thread of Array.isArray(threads) ? threads : []) {
    const kind = sourceKind(thread?.source);
    sourceCounts[kind] = (sourceCounts[kind] || 0) + 1;

    if (normalizedCwd && normalizePath(thread?.cwd) === normalizedCwd) {
      matchingCwdThreadCount += 1;
    }

    if (Number.isFinite(thread?.updatedAt)) {
      newestUpdatedAt = newestUpdatedAt == null ? thread.updatedAt : Math.max(newestUpdatedAt, thread.updatedAt);
    }
  }

  return {
    threadCount: Array.isArray(threads) ? threads.length : 0,
    matchingCwdThreadCount,
    sourceCounts: Object.fromEntries(Object.entries(sourceCounts).sort(([a], [b]) => a.localeCompare(b))),
    newestUpdatedAt,
  };
}

function buildThreadListRequest(id, options, cwdFilter = null) {
  const params = {
    limit: options.limit,
    useStateDbOnly: true,
  };
  if (typeof cwdFilter === "string" && cwdFilter.trim().length > 0) {
    params.cwd = cwdFilter;
  }
  return {
    id,
    method: "thread/list",
    params,
  };
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function summarizeMemoryState(state, files, currentCwd) {
  const configuredWorkspace = normalizePath(state?.workspace || state?.active_workspace || state?.cwd);
  const normalizedCwd = normalizePath(currentCwd);
  return {
    sessionStateExists: Boolean(files.sessionStateExists),
    currentExists: Boolean(files.currentExists),
    memoryIndexExists: Boolean(files.memoryIndexExists),
    latestDigestExists: Boolean(files.latestDigestExists),
    activeProject: typeof (state?.active_project || state?.project) === "string"
      ? (state.active_project || state.project)
      : null,
    workspaceConfigured: configuredWorkspace != null,
    workspaceMatchesCwd: configuredWorkspace != null && normalizedCwd != null && configuredWorkspace === normalizedCwd,
  };
}

function summarizeMemoryDir(memoryDir, currentCwd) {
  const sessionStatePath = path.join(memoryDir, "SESSION_STATE.json");
  const files = {
    sessionStateExists: fs.existsSync(sessionStatePath),
    currentExists: fs.existsSync(path.join(memoryDir, "current.md")),
    memoryIndexExists: fs.existsSync(path.join(memoryDir, "MEMORY_INDEX.md")),
    latestDigestExists: fs.existsSync(path.join(memoryDir, "latest_rollout_digest.md")),
  };
  return summarizeMemoryState(readJsonIfExists(sessionStatePath) || {}, files, currentCwd);
}

function classifyError(error) {
  const text = String(error?.message || error || "");
  if (text.includes("timeout")) return "timeout";
  if (text.includes("ENOENT")) return "codex_not_found";
  if (text.includes("thread/list")) return "thread_list_failed";
  if (text.includes("initialize")) return "initialize_failed";
  return "app_server_failed";
}

function requestAppServerThreads(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.codexBin, ["app-server", "--analytics-default-enabled"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const responses = [];
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("app-server timeout"));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        try {
          responses.push(JSON.parse(line));
        } catch {
          // Ignore non-JSON noise; it is not included in sanitized output.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const threadResponse = responses.find((response) => response?.id === 2);
      const cwdThreadResponse = responses.find((response) => response?.id === 3);
      if (!threadResponse?.result || !Array.isArray(threadResponse.result.data)) {
        reject(new Error(`thread/list failed; stderr lines=${stderr.trim() ? stderr.trim().split(/\n/).length : 0}`));
        return;
      }
      resolve({
        data: threadResponse.result.data,
        hasNextCursor: threadResponse.result.nextCursor != null,
        cwdData: Array.isArray(cwdThreadResponse?.result?.data) ? cwdThreadResponse.result.data : [],
        cwdHasNextCursor: cwdThreadResponse?.result?.nextCursor != null,
      });
    });

    const initialize = {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex-desktop-linux-history-context-check",
          version: "0",
        },
      },
    };
    const threadList = buildThreadListRequest(2, options);
    const cwdThreadList = buildThreadListRequest(3, options, options.cwd);

    child.stdin.write(`${JSON.stringify(initialize)}\n`);
    setTimeout(() => {
      child.stdin.write(`${JSON.stringify(threadList)}\n`);
      child.stdin.write(`${JSON.stringify(cwdThreadList)}\n`);
      setTimeout(() => child.kill("SIGTERM"), 300);
    }, 150);
  });
}

async function run(options) {
  const memoryContext = summarizeMemoryDir(options.memoryDir, options.cwd);
  const payload = {
    ok: false,
    memoryContext,
    threadHistory: {
      checked: false,
      responded: false,
      hasNextCursor: false,
      cwdFilterApplied: normalizePath(options.cwd) != null,
      cwdHasNextCursor: false,
      threadCount: null,
      cwdFilteredThreadCount: null,
      matchingCwdThreadCount: null,
      sourceCounts: {},
      newestUpdatedAt: null,
      errorKind: null,
    },
  };

  if (!options.skipAppServer) {
    try {
      const result = await requestAppServerThreads(options);
      const allThreads = sanitizeThreads(result.data, options.cwd);
      const cwdThreads = sanitizeThreads(result.cwdData, options.cwd);
      payload.threadHistory = {
        checked: true,
        responded: true,
        hasNextCursor: result.hasNextCursor,
        cwdFilterApplied: normalizePath(options.cwd) != null,
        cwdHasNextCursor: result.cwdHasNextCursor,
        ...allThreads,
        cwdFilteredThreadCount: cwdThreads.threadCount,
        errorKind: null,
      };
    } catch (error) {
      payload.threadHistory.checked = true;
      payload.threadHistory.errorKind = classifyError(error);
    }
  }

  payload.ok = payload.memoryContext.sessionStateExists
    && payload.memoryContext.currentExists
    && (options.skipAppServer || payload.threadHistory.responded);
  return payload;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      return;
    }
    const payload = await run(options);
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = payload.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 240) }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  buildThreadListRequest,
  parseArgs,
  run,
  sanitizeThreads,
  summarizeMemoryState,
};
