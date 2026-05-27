#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_CLIENT_REQUEST_METHODS = [
  "initialize",
  "thread/list",
  "thread/loaded/list",
  "plugin/list",
  "plugin/installed",
  "plugin/read",
  "plugin/install",
  "plugin/uninstall",
  "app/list",
  "mcpServerStatus/list",
  "mcpServer/resource/read",
  "mcpServer/tool/call",
  "skills/list",
  "skills/config/write",
  "model/list",
  "modelProvider/capabilities/read",
  "experimentalFeature/list",
  "experimentalFeature/enablement/set",
  "permissionProfile/list",
  "collaborationMode/list",
  "fs/createDirectory",
  "fs/copy",
  "fs/getMetadata",
  "fs/readDirectory",
  "fs/readFile",
  "fs/remove",
  "fs/unwatch",
  "fs/watch",
  "fs/writeFile",
  "config/read",
  "configRequirements/read",
  "externalAgentConfig/detect",
  "externalAgentConfig/import",
  "command/exec",
  "thread/start",
  "thread/read",
  "thread/goal/get",
  "thread/goal/set",
  "thread/goal/clear",
];

const REQUIRED_SERVER_NOTIFICATION_METHODS = [
  "remoteControl/status/changed",
  "app/list/updated",
  "command/exec/outputDelta",
  "fs/changed",
];

const OPTIONAL_PARITY_CLIENT_REQUEST_METHODS = [
  "remoteControl/status/read",
  "remoteControl/enable",
  "remoteControl/disable",
  "marketplace/add",
  "marketplace/upgrade",
  "thread/read",
  "thread/resume",
  "thread/fork",
  "thread/goal/get",
  "thread/goal/set",
  "thread/rollback",
  "review/start",
  "fs/readFile",
  "fs/writeFile",
  "fs/readDirectory",
  "process/spawn",
  "process/kill",
];

const REQUIRED_SCHEMA_FILES = [
  "ClientRequest.json",
  "ServerNotification.json",
  "v1/InitializeParams.json",
  "v1/InitializeResponse.json",
  "v2/ThreadListParams.json",
  "v2/ThreadLoadedListParams.json",
  "v2/PluginListParams.json",
  "v2/PluginInstalledParams.json",
  "v2/PluginInstalledResponse.json",
  "v2/PluginReadParams.json",
  "v2/PluginReadResponse.json",
  "v2/PluginInstallParams.json",
  "v2/PluginInstallResponse.json",
  "v2/PluginUninstallParams.json",
  "v2/PluginUninstallResponse.json",
  "v2/AppsListParams.json",
  "v2/ListMcpServerStatusParams.json",
  "v2/McpResourceReadParams.json",
  "v2/McpResourceReadResponse.json",
  "v2/McpServerToolCallParams.json",
  "v2/McpServerToolCallResponse.json",
  "v2/SkillsListParams.json",
  "v2/SkillsConfigWriteParams.json",
  "v2/SkillsConfigWriteResponse.json",
  "v2/ModelListParams.json",
  "v2/ModelProviderCapabilitiesReadParams.json",
  "v2/ModelProviderCapabilitiesReadResponse.json",
  "v2/ExperimentalFeatureListParams.json",
  "v2/ExperimentalFeatureListResponse.json",
  "v2/ExperimentalFeatureEnablementSetParams.json",
  "v2/ExperimentalFeatureEnablementSetResponse.json",
  "v2/PermissionProfileListParams.json",
  "v2/PermissionProfileListResponse.json",
  "v2/CollaborationModeListParams.json",
  "v2/CollaborationModeListResponse.json",
  "v2/FsCreateDirectoryParams.json",
  "v2/FsCreateDirectoryResponse.json",
  "v2/FsCopyParams.json",
  "v2/FsCopyResponse.json",
  "v2/FsGetMetadataParams.json",
  "v2/FsGetMetadataResponse.json",
  "v2/FsReadDirectoryParams.json",
  "v2/FsReadDirectoryResponse.json",
  "v2/FsReadFileParams.json",
  "v2/FsReadFileResponse.json",
  "v2/FsRemoveParams.json",
  "v2/FsRemoveResponse.json",
  "v2/FsUnwatchParams.json",
  "v2/FsUnwatchResponse.json",
  "v2/FsWatchParams.json",
  "v2/FsWatchResponse.json",
  "v2/FsWriteFileParams.json",
  "v2/FsWriteFileResponse.json",
  "v2/FsChangedNotification.json",
  "v2/ConfigReadParams.json",
  "v2/ConfigRequirementsReadResponse.json",
  "v2/ExternalAgentConfigDetectParams.json",
  "v2/ExternalAgentConfigImportParams.json",
  "v2/ExternalAgentConfigImportResponse.json",
  "v2/CommandExecParams.json",
  "v2/ThreadStartParams.json",
  "v2/ThreadStartResponse.json",
  "v2/ThreadReadParams.json",
  "v2/ThreadReadResponse.json",
  "v2/ThreadGoalGetParams.json",
  "v2/ThreadGoalGetResponse.json",
  "v2/ThreadGoalSetParams.json",
  "v2/ThreadGoalSetResponse.json",
  "v2/ThreadGoalClearParams.json",
  "v2/ThreadGoalClearResponse.json",
  "v2/RemoteControlStatusChangedNotification.json",
];

function usage() {
  return [
    "Usage: app-server-schema-guard.js [options]",
    "",
    "Generates or reads Codex app-server JSON schemas and checks that the",
    "Linux desktop parity probes still have the protocol surface they need.",
    "",
    "Options:",
    "  --json                 Print JSON summary",
    "  --codex-bin PATH       Codex CLI binary to use (default: codex)",
    "  --schema-dir DIR       Read existing schema bundle instead of generating one",
    "  --keep-output DIR      Generate schema bundle into DIR and keep it",
    "  --timeout-ms MS        Timeout for schema generation (default: 30000)",
    "  --no-experimental      Omit --experimental when generating schemas",
    "  -h, --help             Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const timeoutMs = Number.parseInt(process.env.CODEX_SCHEMA_GUARD_TIMEOUT_MS || "30000", 10);
  const options = {
    codexBin: process.env.CODEX_PARITY_CODEX_BIN || "codex",
    experimental: true,
    json: false,
    keepOutput: null,
    schemaDir: null,
    timeoutMs,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--codex-bin") {
      options.codexBin = argv[index + 1];
      if (!options.codexBin) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--schema-dir") {
      options.schemaDir = argv[index + 1];
      if (!options.schemaDir) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--keep-output") {
      options.keepOutput = argv[index + 1];
      if (!options.keepOutput) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number.parseInt(argv[index + 1], 10);
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error(usage());
      }
      index += 1;
    } else if (arg === "--no-experimental") {
      options.experimental = false;
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(usage());
  }

  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectMethods(schemaPath) {
  const schema = readJson(schemaPath);
  const methods = [];
  for (const variant of schema.oneOf || []) {
    const method = variant?.properties?.method?.enum?.[0];
    if (typeof method === "string") {
      methods.push(method);
    }
  }
  return methods.sort();
}

function missingFrom(expected, actualSet) {
  return expected.filter((name) => !actualSet.has(name));
}

function generateSchemas(options) {
  if (options.schemaDir) {
    return { cleanup: null, schemaDir: path.resolve(options.schemaDir) };
  }

  const schemaDir = options.keepOutput
    ? path.resolve(options.keepOutput)
    : fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-schema-"));
  fs.mkdirSync(schemaDir, { recursive: true });

  const args = ["app-server", "generate-json-schema", "--out", schemaDir];
  if (options.experimental) {
    args.push("--experimental");
  }
  const result = spawnSync(options.codexBin, args, {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: options.timeoutMs,
  });
  if (result.error) {
    throw new Error(`failed to generate app-server JSON schemas: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || result.stdout || "").trim();
    throw new Error(`failed to generate app-server JSON schemas: ${stderr || `exit ${result.status}`}`);
  }

  return {
    cleanup: options.keepOutput
      ? null
      : () => fs.rmSync(schemaDir, { force: true, recursive: true }),
    schemaDir,
  };
}

function run(options) {
  const generated = generateSchemas(options);
  try {
    const requiredFileMissing = REQUIRED_SCHEMA_FILES.filter((relativePath) => {
      return !fs.existsSync(path.join(generated.schemaDir, relativePath));
    });
    const clientMethods = collectMethods(path.join(generated.schemaDir, "ClientRequest.json"));
    const serverNotifications = collectMethods(path.join(generated.schemaDir, "ServerNotification.json"));
    const clientMethodSet = new Set(clientMethods);
    const serverNotificationSet = new Set(serverNotifications);

    const missingRequiredClientMethods = missingFrom(REQUIRED_CLIENT_REQUEST_METHODS, clientMethodSet);
    const missingRequiredServerNotifications = missingFrom(
      REQUIRED_SERVER_NOTIFICATION_METHODS,
      serverNotificationSet,
    );
    const missingOptionalClientMethods = missingFrom(OPTIONAL_PARITY_CLIENT_REQUEST_METHODS, clientMethodSet);

    const ok =
      requiredFileMissing.length === 0 &&
      missingRequiredClientMethods.length === 0 &&
      missingRequiredServerNotifications.length === 0;

    return {
      ok,
      schemaDir: options.keepOutput || options.schemaDir ? generated.schemaDir : null,
      counts: {
        clientRequestMethods: clientMethods.length,
        serverNotifications: serverNotifications.length,
        requiredClientMethods: REQUIRED_CLIENT_REQUEST_METHODS.length,
        requiredServerNotifications: REQUIRED_SERVER_NOTIFICATION_METHODS.length,
        optionalClientMethods: OPTIONAL_PARITY_CLIENT_REQUEST_METHODS.length,
        optionalClientMethodsPresent:
          OPTIONAL_PARITY_CLIENT_REQUEST_METHODS.length - missingOptionalClientMethods.length,
      },
      missing: {
        requiredFiles: requiredFileMissing,
        requiredClientMethods: missingRequiredClientMethods,
        requiredServerNotifications: missingRequiredServerNotifications,
        optionalClientMethods: missingOptionalClientMethods,
      },
    };
  } finally {
    if (generated.cleanup) {
      generated.cleanup();
    }
  }
}

function printText(summary) {
  console.log(
    `[schema] result=${summary.ok ? "pass" : "fail"} ` +
      `clientMethods=${summary.counts.clientRequestMethods} ` +
      `serverNotifications=${summary.counts.serverNotifications} ` +
      `optionalPresent=${summary.counts.optionalClientMethodsPresent}/${summary.counts.optionalClientMethods}`,
  );
  for (const [key, value] of Object.entries(summary.missing)) {
    if (value.length > 0) {
      console.log(`[schema] missing ${key}: ${value.join(", ")}`);
    }
  }
  if (summary.schemaDir) {
    console.log(`[schema] output=${summary.schemaDir}`);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    const summary = run(options);
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      printText(summary);
    }
    if (!summary.ok) {
      process.exit(1);
    }
  } catch (error) {
    const summary = { ok: false, error: error.message };
    if (options?.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.error(`[schema] FAIL ${error.message}`);
    }
    process.exit(1);
  }
}

main();
