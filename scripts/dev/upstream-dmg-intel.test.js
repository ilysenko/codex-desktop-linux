"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const {
  buildIntelReports,
  compareProtectedSurfaces,
  createInventory,
  extractProtectedSurfaces,
  renderActionPlanMarkdown,
  resolveBaselinePath,
} = require("../lib/upstream-dmg-intel.js");

const registry = {
  version: 1,
  surfaces: [
    {
      id: "sky_computer_use_client",
      title: "Sky Computer Use client",
      category: "native",
      pathPatterns: ["SkyComputerUseClient", "native/sky\\.node"],
      contentNeedles: ["SkyComputerUseClient", "event_stream", "recording_controls"],
      nativeStringNeedles: ["SkyComputerUseClient", "recording_controls"],
      linuxSubstrate: {
        requiredPaths: ["computer-use-linux/src/server.rs"],
      },
    },
    {
      id: "record_and_replay_event_stream",
      title: "Record & Replay event stream MCP",
      category: "plugin",
      pathPatterns: ["record-and-replay"],
      contentNeedles: ["event_stream_start", "browser_trace", "speech_context"],
      pluginIds: ["record-and-replay"],
      linuxSubstrate: {
        requiredPaths: ["record-replay-linux/src/main.rs"],
      },
    },
    {
      id: "chrome_native_messaging",
      title: "Chrome native messaging plugin",
      category: "plugin",
      pathPatterns: ["plugins/openai-bundled/plugins/chrome"],
      contentNeedles: ["nativeMessaging", "codex-chrome-extension-host"],
      pluginIds: ["chrome"],
      linuxSubstrate: {
        requiredPaths: ["computer-use-linux/src/bin/codex-chrome-extension-host.rs"],
      },
    },
    {
      id: "work_louder_control_surface",
      title: "Work Louder control-surface bundle hooks",
      category: "native",
      pathPatterns: [
        "codex-micro-service.*\\.js$",
        "@worklouder/(device-kit-oai|wl-device-kit)/package\\.json$",
        "(^|/)node-hid/package\\.json$",
        "(^|/)node-hid/prebuilds/[^/]+/node-napi-v[0-9]+\\.node$",
      ],
      patchNamePatterns: ["work.*louder", "micro", "hid", "control.*surface"],
      requiredEvidence: [
        {
          id: "micro-service-entrypoint",
          pathPatterns: ["codex-micro-service.*\\.js$"],
          contentNeedles: ["@worklouder/device-kit-oai", "DeviceType", "Project2077"],
        },
        {
          id: "work-louder-device-kits",
          pathPatterns: ["@worklouder/(device-kit-oai|wl-device-kit)"],
          contentNeedles: ["@worklouder/device-kit-oai", "@worklouder/wl-device-kit", "node-hid"],
        },
        {
          id: "hid-runtime-package",
          pathPatterns: ["(^|/)node-hid/package\\.json$", "(^|/)node-hid/prebuilds/"],
          contentNeedles: ["node-hid"],
          nativeBinaryPatterns: [
            "(^|/)node-hid/prebuilds/[^/]+/node-napi-v[0-9]+\\.node$",
          ],
        },
      ],
    },
    {
      id: "dictation_transcript_finalization",
      title: "Dictation transcript finalization",
      category: "webview",
      pathPatterns: ["composer"],
      contentNeedles: ["finalizeTranscript", "dictation", "transcript"],
      linuxSubstrate: {
        requiredPaths: ["linux-features/conversation-mode/patches.js"],
      },
    },
    {
      id: "chronicle_sidecar",
      title: "Chronicle sidecar",
      category: "native",
      pathPatterns: ["codex_chronicle"],
      contentNeedles: ["codex_chronicle", "session.json", "events.jsonl"],
      nativeStringNeedles: ["codex_chronicle", "events.jsonl"],
      linuxSubstrate: {
        requiredPaths: ["record-replay-linux/src/chronicle.rs"],
      },
    },
    {
      id: "chronicle_settings_toggles",
      title: "Chronicle settings toggle paths",
      category: "webview",
      pathPatterns: ["personalization-settings"],
      contentNeedles: [
        "chronicleSidecarPresent",
        "chronicleSidecarProcessState",
        "rememberConsentAccepted",
        "mutateAsync({enabled:!0})",
        "mutateAsync({enabled:!1})",
        "chronicleDisable",
        "memoryFeatureEnabled",
        "generateMemoriesEnabled",
        "useMemoriesEnabled",
      ],
      requiredEvidence: [
        {
          id: "dedicated-chronicle-preview-row",
          pathPatterns: ["personalization-settings"],
          contentNeedles: [
            "settings.general.experimentalFeatures.chronicle.name",
            "chronicleSidecarPresent",
            "chronicleSidecarProcessState",
            "rememberConsentAccepted",
            "mutateAsync({enabled:!0})",
            "mutateAsync({enabled:!1})",
          ],
        },
        {
          id: "memory-master-toggle-chronicle-disable",
          pathPatterns: ["personalization-settings"],
          contentNeedles: [
            "function un",
            "chronicleDisable",
            "Promise.allSettled",
            "memoryFeatureEnabled",
            "generateMemoriesEnabled",
            "useMemoriesEnabled",
          ],
        },
      ],
      linuxSubstrate: {
        requiredPaths: ["linux-features/record-and-replay"],
      },
    },
    {
      id: "future_skysight_bridge",
      title: "Future Skysight bridge",
      category: "bridge",
      pathPatterns: ["future-skysight"],
      contentNeedles: ["futureSkysightBridge", "sky_snapshot_v2"],
      linuxSubstrate: {
        requiredPaths: ["linux-features/future-skysight/patch.js"],
      },
    },
  ],
};

function withTempDir(fn) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-intel-test-"));
  try {
    return fn(workspace);
  } finally {
    fs.rmSync(workspace, { force: true, recursive: true });
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, mode == null ? undefined : { mode });
}

function writeWorkLouderControlSurface({ asarExtracted, includeHid = true, resources }) {
  const deviceKit = path.join(
    resources,
    "app.asar.unpacked/node_modules/@worklouder/device-kit-oai",
  );
  const wlKit = path.join(deviceKit, "node_modules/@worklouder/wl-device-kit");
  const hid = path.join(wlKit, "node_modules/node-hid");

  writeFile(
    path.join(asarExtracted, ".vite/build/codex-micro-service-fixture.js"),
    [
      "import { DeviceType, WLDeviceDiscovery } from '@worklouder/device-kit-oai';",
      "const device = DeviceType.Project2077;",
      "WLDeviceDiscovery.start(device);",
      "require('node-hid');",
    ].join("\n"),
  );
  writeJson(path.join(deviceKit, "package.json"), {
    name: "@worklouder/device-kit-oai",
    dependencies: {
      "@worklouder/wl-device-kit": "1.0.0",
    },
  });
  writeFile(
    path.join(deviceKit, "dist/index.js"),
    "export { DeviceType, WLDeviceDiscovery } from '@worklouder/wl-device-kit';",
  );
  writeJson(path.join(wlKit, "package.json"), {
    name: "@worklouder/wl-device-kit",
    dependencies: {
      "node-hid": "3.1.0",
    },
  });
  writeFile(
    path.join(wlKit, "dist/index.js"),
    [
      "const HID = require('node-hid');",
      "export const DeviceType = { Project2077: 'Project2077' };",
      "export class WLDeviceDiscovery { static start() { return HID; } }",
    ].join(" "),
  );
  if (includeHid) {
    writeJson(path.join(hid, "package.json"), {
      name: "node-hid",
      version: "3.1.0",
    });
    writeFile(
      path.join(hid, "prebuilds/HID-darwin-arm64/node-napi-v4.node"),
      "Mach-O node-hid Project2077",
      0o755,
    );
  }
}

function createFixtureApp(root, variant = "baseline") {
  const appDir = path.join(root, `${variant}.app`);
  const resources = path.join(appDir, "Contents/Resources");
  const asarExtracted = path.join(resources, "app.asar.extracted");
  const recordPlugin = path.join(resources, "plugins/openai-bundled/plugins/record-and-replay");
  const chromePlugin = path.join(resources, "plugins/openai-bundled/plugins/chrome");

  writeJson(path.join(resources, "package.json"), {
    name: "codex-desktop",
    version: variant === "candidate" ? "2026.7.3" : "2026.7.2",
  });

  const skyPayload =
    "Mach-O SkyComputerUseClient event_stream recording_controls metadataPath eventsPath";
  const skyPath =
    variant === "candidate"
      ? path.join(resources, "native/sky/sky.node")
      : path.join(resources, "native/sky.node");
  writeFile(skyPath, skyPayload, 0o755);

  if (variant === "candidate") {
    writeFile(
      path.join(resources, "codex_chronicle"),
      "Mach-O codex_chronicle session.json events.jsonl skysight_trace",
      0o755,
    );
    writeFile(
      path.join(asarExtracted, "future-skysight-bridge.js"),
      "ipcMain.handle('futureSkysightBridge', () => sky_snapshot_v2())",
    );
  }

  if (variant === "candidate" || variant === "missing-work-louder-hid") {
    writeWorkLouderControlSurface({
      asarExtracted,
      includeHid: variant !== "missing-work-louder-hid",
      resources,
    });
  }

  if (variant !== "candidate") {
    writeFile(
      path.join(asarExtracted, "composer/transcript.js"),
      "function finalizeTranscript(dictation, transcript) { return transcript.final; }",
    );
  }

  writeFile(
    path.join(asarExtracted, "main/bridge.js"),
    "ipcMain.handle('event_stream_start', start); ipcMain.handle('browser_trace', trace);",
  );
  writeFile(
    path.join(asarExtracted, "main/minified-bridge.js"),
    "const a='linux-record-replay-skysight-start',b=`speech_context`,c=\"focused_window\",d='computer-use-plugin-icon.png';ipcMain.handle(x,y);",
  );

  const broadMemoryToggle =
    variant === "missing-memory-chronicle-disable"
      ? ""
      : "async function un({chronicleDisable,previousState,selectedEnabled,featureWrite,configWrite}){await Promise.allSettled([featureWrite(),configWrite(),chronicleDisable?.()??Promise.resolve()]);return {memoryFeatureEnabled:selectedEnabled,generateMemoriesEnabled:selectedEnabled,useMemoriesEnabled:selectedEnabled};}";
  writeFile(
    path.join(resources, "webview/assets/personalization-settings-fixture.js"),
    [
      "function fn(){",
      "const name='settings.general.experimentalFeatures.chronicle.name';",
      "const state={chronicleSidecarPresent:true,chronicleSidecarProcessState:'running'};",
      "const enable=async({rememberConsentAccepted})=>o.mutateAsync({enabled:!0});",
      "const disable=async()=>o.mutateAsync({enabled:!1});",
      "return {name,state,enable,disable};",
      "}",
      broadMemoryToggle,
    ].join(""),
  );

  writeJson(path.join(recordPlugin, ".codex-plugin/plugin.json"), {
    id: "record-and-replay",
    name: "record-and-replay",
    version: "1.0.0",
    mcpServers: {
      "event-stream": {
        command: "SkyComputerUseClient",
      },
    },
    skills: [{ name: "record-and-replay", path: "skills/record-and-replay/SKILL.md" }],
  });
  writeJson(path.join(recordPlugin, ".mcp.json"), {
    mcpServers: {
      "event-stream": {
        command: "SkyComputerUseClient",
        tools:
          variant === "candidate"
            ? ["event_stream_start", "browser_trace", "speech_context", "skysight_snapshot"]
            : ["event_stream_start", "browser_trace", "speech_context"],
      },
    },
  });
  writeFile(
    path.join(recordPlugin, "skills/record-and-replay/SKILL.md"),
    "Use event_stream_start, browser_trace, and speech_context to compile reusable skills.",
  );

  writeJson(path.join(chromePlugin, ".codex-plugin/plugin.json"), {
    id: "chrome",
    name: "chrome",
    version: "1.0.0",
  });
  writeFile(
    path.join(chromePlugin, "browser-client.mjs"),
    "const nativeMessaging = 'codex-chrome-extension-host';",
  );

  return appDir;
}

function findClassification(driftReport, surfaceId, classification) {
  return driftReport.surfaceDrift.find(
    (entry) => entry.surfaceId === surfaceId && entry.classification === classification,
  );
}

test("extracts protected surfaces, plugins, native binaries, and bridge calls from a fixture app", () =>
  withTempDir((workspace) => {
    const appDir = createFixtureApp(workspace, "baseline");

    const inventory = createInventory({ registry, sourcePath: appDir });
    const protectedSurfaces = extractProtectedSurfaces({
      inventory,
      registry,
      repoRoot: process.cwd(),
    });

    assert.equal(inventory.source.kind, "app");
    assert.ok(
      inventory.files.some((file) => file.relativePath.endsWith("plugins/openai-bundled/plugins/chrome/browser-client.mjs")),
    );
    assert.equal(protectedSurfaces.surfacesById.sky_computer_use_client.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.record_and_replay_event_stream.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chrome_native_messaging.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chronicle_settings_toggles.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chronicle_sidecar.status, "MISSING");
    assert.ok(
      protectedSurfaces.surfacesById.chronicle_settings_toggles.satisfiedAnchors.some(
        (anchor) => anchor.id === "memory-master-toggle-chronicle-disable",
      ),
    );
    assert.ok(
      protectedSurfaces.surfacesById.chronicle_settings_toggles.requiredAnchors
        .flatMap((anchor) => anchor.matchedNeedles)
        .some((hit) => hit.needle === "chronicleDisable"),
    );
    assert.ok(
      protectedSurfaces.pluginMap.plugins.some((plugin) => plugin.id === "record-and-replay"),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.handlers.some((handler) => handler.name === "event_stream_start"),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.channelCandidates.some(
        (candidate) => candidate.name === "linux-record-replay-skysight-start",
      ),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.channelCandidates.some(
        (candidate) => candidate.name === "speech_context",
      ),
    );
    assert.ok(
      protectedSurfaces.bridgeMap.channelCandidates.every(
        (candidate) => candidate.name !== "computer-use-plugin-icon.png",
      ),
    );
    assert.ok(
      protectedSurfaces.nativeBinaryMap.binaries.some((binary) =>
        binary.relativePath.endsWith("native/sky.node"),
      ),
    );
  }));

test("marks Chronicle settings toggle surface partial when the Memory master toggle path disappears", () =>
  withTempDir((workspace) => {
    const appDir = createFixtureApp(workspace, "missing-memory-chronicle-disable");
    const protectedSurfaces = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: appDir }),
      registry,
      repoRoot: process.cwd(),
    });
    const surface = protectedSurfaces.surfacesById.chronicle_settings_toggles;
    assert.equal(surface.status, "PARTIAL");
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "dedicated-chronicle-preview-row"),
    );
    assert.ok(
      surface.missingAnchors.some((anchor) => anchor.id === "memory-master-toggle-chronicle-disable"),
    );
    assert.ok(
      surface.missingAnchors
        .find((anchor) => anchor.id === "memory-master-toggle-chronicle-disable")
        .missingNeedles.includes("chronicleDisable"),
    );
  }));

test("tracks Work Louder control-surface hooks when the service, kits, and HID runtime are bundled", () =>
  withTempDir((workspace) => {
    const appDir = createFixtureApp(workspace, "candidate");
    const protectedSurfaces = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: appDir }),
      registry,
      repoRoot: process.cwd(),
    });
    const surface = protectedSurfaces.surfacesById.work_louder_control_surface;

    assert.equal(surface.status, "PRESENT");
    assert.equal(surface.linuxSubstrate.status, "UNKNOWN");
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "micro-service-entrypoint"),
    );
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "work-louder-device-kits"),
    );
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "hid-runtime-package"),
    );
    assert.ok(
      surface.evidence.some((entry) => entry.path.includes("codex-micro-service-fixture.js")),
    );
    assert.ok(
      surface.requiredAnchors
        .find((anchor) => anchor.id === "hid-runtime-package")
        .matchedPaths.some((entryPath) => entryPath.includes("node-hid/prebuilds")),
    );
  }));

test("marks Work Louder control-surface hooks partial when the HID runtime disappears", () =>
  withTempDir((workspace) => {
    const appDir = createFixtureApp(workspace, "missing-work-louder-hid");
    const protectedSurfaces = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: appDir }),
      registry,
      repoRoot: process.cwd(),
    });
    const surface = protectedSurfaces.surfacesById.work_louder_control_surface;

    assert.equal(surface.status, "PARTIAL");
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "micro-service-entrypoint"),
    );
    assert.ok(
      surface.satisfiedAnchors.some((anchor) => anchor.id === "work-louder-device-kits"),
    );
    assert.ok(surface.missingAnchors.some((anchor) => anchor.id === "hid-runtime-package"));
    assert.ok(
      surface.missingAnchors
        .find((anchor) => anchor.id === "hid-runtime-package")
        .missingNeedles.some((needle) => needle.startsWith("nativeBinary:")),
    );
  }));

test("classifies protected-surface drift from baseline to candidate", () =>
  withTempDir((workspace) => {
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const baseline = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: baselineApp }),
      registry,
      repoRoot: process.cwd(),
    });
    const candidate = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      registry,
      repoRoot: process.cwd(),
    });

    const driftReport = compareProtectedSurfaces({
      baseline,
      candidate,
      patchReport: {
        patches: [
          {
            name: "record-and-replay bridge patch",
            status: "skipped-optional",
            reason: "upstream bridge marker moved",
            surfaceId: "record_and_replay_event_stream",
          },
        ],
      },
    });

    assert.ok(findClassification(driftReport, "sky_computer_use_client", "MOVED"));
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PAYLOAD_CHANGED"));
    assert.ok(findClassification(driftReport, "chrome_native_messaging", "UNCHANGED"));
    assert.ok(findClassification(driftReport, "dictation_transcript_finalization", "REMOVED"));
    assert.ok(findClassification(driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
    assert.ok(findClassification(driftReport, "future_skysight_bridge", "LINUX_SUBSTRATE_GAP"));
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_REVIEW"));
    assert.ok(!findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
  }));

test("classifies required patch-report failures as acceptance blockers", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const candidate = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      registry,
      repoRoot: process.cwd(),
    });

    const driftReport = compareProtectedSurfaces({
      candidate,
      patchReport: {
        patches: [
          {
            name: "record-and-replay bridge patch",
            status: "failed-required",
            reason: "upstream bridge marker moved",
            surfaceId: "record_and_replay_event_stream",
          },
        ],
      },
    });

    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
    assert.ok(!findClassification(driftReport, "record_and_replay_event_stream", "PATCH_REVIEW"));
  }));

test("classifies unresolved Linux settings patch symbols as acceptance blockers", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const assetsDir = path.join(candidateApp, "Contents/Resources/webview/assets");
    writeFile(
      path.join(assetsDir, "settings-page-bad-linux-patch.js"),
      'var icons={"agent-workspaces":codexLinuxAgentWorkspaceSettingsIcon,worktrees:WorktreesIcon};',
    );
    writeFile(
      path.join(assetsDir, "settings-page-bare-assignment.js"),
      "codexLinuxReadAloudSettingsIcon=e=>null;var icons={read:codexLinuxReadAloudSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-comma-assignment.js"),
      "foo(),codexLinuxHooksSettingsIcon=e=>null;var icons={hooks:codexLinuxHooksSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-nested-assignment.js"),
      "var init=()=>{codexLinuxMcpSettingsIcon=e=>null};var icons={mcp:codexLinuxMcpSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-good-direct-declaration.js"),
      "var codexLinuxDeclaredSettingsIcon=e=>null;var icons={declared:codexLinuxDeclaredSettingsIcon};",
    );
    writeFile(
      path.join(assetsDir, "settings-page-good-comma-declaration.js"),
      "var existing=1,codexLinuxCommaDeclaredSettingsIcon=e=>null;var icons={declared:codexLinuxCommaDeclaredSettingsIcon};",
    );

    const candidate = extractProtectedSurfaces({
      inventory: createInventory({ registry, sourcePath: candidateApp }),
      registry,
      repoRoot: process.cwd(),
    });
    const driftReport = compareProtectedSurfaces({ candidate });

    const finding = findClassification(driftReport, "linux_patch_integrity", "PATCH_INTEGRITY_BROKEN");
    assert.ok(finding);
    assert.equal(finding.category, "patch-integrity");
    const findingPaths = new Set(finding.findings.map((entry) => path.basename(entry.path)));
    assert.ok(findingPaths.has("settings-page-bad-linux-patch.js"));
    assert.ok(findingPaths.has("settings-page-bare-assignment.js"));
    assert.ok(findingPaths.has("settings-page-comma-assignment.js"));
    assert.ok(findingPaths.has("settings-page-nested-assignment.js"));
    assert.equal(findingPaths.has("settings-page-good-direct-declaration.js"), false);
    assert.equal(findingPaths.has("settings-page-good-comma-declaration.js"), false);
  }));

test("folds patch-report post-patch integrity findings into candidate-only reports", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "post-patch-integrity-report");
    const patchReportPath = path.join(workspace, "patch-report.json");
    writeJson(patchReportPath, {
      patches: [],
      postPatchIntegrity: {
        sourcePath: path.join(workspace, "app-extracted"),
        findingCount: 1,
        findings: [
          {
            path: "webview/assets/settings-page-patched.js",
            reason: "Linux settings patch symbol is referenced without a local declaration",
            snippet: '"agent-workspaces":codexLinuxAgentWorkspaceSettingsIcon',
            symbol: "codexLinuxAgentWorkspaceSettingsIcon",
          },
        ],
      },
    });

    const reports = buildIntelReports({
      autoBaseline: false,
      candidatePath: candidateApp,
      outputDir,
      patchReportPath,
      registry,
      repoRoot: process.cwd(),
    });

    const finding = findClassification(reports.driftReport, "linux_patch_integrity", "PATCH_INTEGRITY_BROKEN");
    assert.ok(finding);
    assert.equal(finding.findingCount, 1);
    assert.equal(finding.findings[0].path, "webview/assets/settings-page-patched.js");
  }));

test("keeps drift report evidence compact and marks hashed asset churn", () => {
  const baseline = {
    source: { path: "baseline.app" },
    surfacesById: {
      vite_chunk_bridge: {
        id: "vite_chunk_bridge",
        title: "Vite chunk bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/main-CNod9zFW.js",
            sha256: "baseline-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };
  const candidate = {
    source: { path: "candidate.app" },
    surfacesById: {
      vite_chunk_bridge: {
        id: "vite_chunk_bridge",
        title: "Vite chunk bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/main-z6HVz-xR.js",
            sha256: "candidate-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };

  const driftReport = compareProtectedSurfaces({ baseline, candidate });
  const drift = findClassification(driftReport, "vite_chunk_bridge", "MOVED");
  assert.ok(drift);
  assert.equal(drift.baselineEvidence, undefined);
  assert.equal(drift.candidateEvidence, undefined);
  assert.equal(drift.evidenceSummary.baseline.evidenceCount, 1);
  assert.equal(drift.evidenceSummary.candidate.evidenceCount, 1);
  assert.equal(drift.evidenceDrift.pathMovementKind, "hashed_asset_churn");
  assert.equal(drift.evidenceDrift.addedEvidence, undefined);
  assert.equal(drift.evidenceDrift.removedEvidence, undefined);

  const actionPlan = renderActionPlanMarkdown(
    {
      ...driftReport,
      structuralDriftSummary: {
        bridgeHandlers: { addedCount: 0, removedCount: 0 },
        plugins: { addedCount: 0, removedCount: 0 },
        mcpTools: { addedCount: 0, removedCount: 0 },
        nativeBinaries: { addedCount: 0, removedCount: 0, changedCount: 0 },
        hasStructuralAddRemove: false,
      },
    },
    { source: { path: "candidate.app" } },
  );
  assert.match(actionPlan, /review candidate evidence paths before changing Linux substrate/);
  assert.match(actionPlan, /Treat this as a navigation signal/);
  assert.doesNotMatch(
    actionPlan,
    /update patch descriptors, staging paths, and Linux mirror code to the candidate evidence paths/,
  );
});

test("does not collapse multi-hyphen hashed asset stems", () => {
  const baseline = {
    source: { path: "baseline.app" },
    surfacesById: {
      record_asset_bridge: {
        id: "record_asset_bridge",
        title: "Record asset bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/record-and-replay-CNod9zFW.js",
            sha256: "baseline-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };
  const candidate = {
    source: { path: "candidate.app" },
    surfacesById: {
      record_asset_bridge: {
        id: "record_asset_bridge",
        title: "Record asset bridge",
        category: "bridge",
        status: "PRESENT",
        evidence: [
          {
            path: ".vite/build/record-settings-NsW8qoL2.js",
            sha256: "candidate-hash",
            size: 100,
            source: "asar",
            type: "text",
          },
        ],
      },
    },
  };

  const driftReport = compareProtectedSurfaces({ baseline, candidate });
  const drift = findClassification(driftReport, "record_asset_bridge", "MOVED");
  assert.ok(drift);
  assert.equal(drift.evidenceDrift.pathMovementKind, "mixed_hashed_asset_churn");
});

test("writes the expected report bundle for candidate-only and comparison runs", () =>
  withTempDir((workspace) => {
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "reports");
    const fakeBin = path.join(workspace, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    for (const tool of ["llvm-nm", "nm"]) {
      writeFile(
        path.join(fakeBin, tool),
        `#!/usr/bin/env bash
set -euo pipefail
test -f "$2"
printf '00000000 T _SkyComputerUseClient\\n'
`,
        0o755,
      );
    }
    const oldPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${oldPath ?? ""}`;

    let reports;
    try {
      reports = buildIntelReports({
        baselinePath: baselineApp,
        candidatePath: candidateApp,
        outputDir,
        registry,
        repoRoot: process.cwd(),
        timestamp: "2026-07-03T12-00-00Z",
      });
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
    }

    for (const reportName of [
      "inventory.json",
      "protected-surfaces.json",
      "bridge-map.json",
      "plugin-map.json",
      "native-binary-map.json",
      "map-drift.json",
      "drift-report.json",
      "drift-report.md",
      "substrate-action-plan.md",
      "baseline/inventory.json",
      "baseline/plugin-map.json",
      "candidate/inventory.json",
      "candidate/plugin-map.json",
    ]) {
      assert.ok(fs.existsSync(path.join(reports.outputDir, reportName)), reportName);
    }

    const driftReport = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "drift-report.json"), "utf8"),
    );
    const inventory = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "inventory.json"), "utf8"),
    );
    const nativeBinaryMap = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "native-binary-map.json"), "utf8"),
    );
    const mapDrift = JSON.parse(
      fs.readFileSync(path.join(reports.outputDir, "map-drift.json"), "utf8"),
    );
    const actionPlan = fs.readFileSync(path.join(reports.outputDir, "substrate-action-plan.md"), "utf8");
    const skyDrift = findClassification(driftReport, "sky_computer_use_client", "MOVED");
    assert.ok(findClassification(driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
    assert.equal(skyDrift.baselineEvidence, undefined);
    assert.equal(skyDrift.candidateEvidence, undefined);
    assert.ok(skyDrift.evidenceSummary.baseline.evidenceCount > 0);
    assert.ok(skyDrift.evidenceDrift.addedPathSamples.length > 0);
    assert.equal(skyDrift.evidenceDrift.addedEvidence, undefined);
    assert.ok(inventory.files.every((file) => file.text == null && file.nativeStrings == null));
    assert.ok(
      nativeBinaryMap.binaries.some((binary) =>
        binary.protectedStringHits.some((hit) => hit.needle === "recording_controls"),
      ),
    );
    assert.ok(
      nativeBinaryMap.binaries.some(
        (binary) =>
          binary.symbols?.tool === "llvm-nm -g" &&
          binary.symbols.symbols.includes("00000000 T _SkyComputerUseClient"),
      ),
    );
    assert.equal(mapDrift.mode, "baselineComparison");
    assert.ok(mapDrift.mcpDrift.added.includes("record-and-replay:event-stream:skysight_snapshot"));
    assert.match(actionPlan, /review candidate evidence paths/);
    assert.doesNotMatch(
      actionPlan,
      /update patch descriptors, staging paths, and Linux mirror code to the candidate evidence paths/,
    );
  }));

test("auto-baseline uses repo Codex.dmg when candidate is different", () =>
  withTempDir((workspace) => {
    const repoRoot = path.join(workspace, "repo");
    fs.mkdirSync(repoRoot, { recursive: true });
    const baselineApp = createFixtureApp(workspace, "baseline");
    const candidateApp = createFixtureApp(workspace, "candidate");
    const baselineCache = path.join(repoRoot, "Codex.dmg");
    fs.cpSync(baselineApp, baselineCache, { recursive: true });

    assert.equal(
      resolveBaselinePath({
        autoBaseline: true,
        candidatePath: candidateApp,
        repoRoot,
      }),
      baselineCache,
    );
    assert.equal(
      resolveBaselinePath({
        autoBaseline: true,
        candidatePath: baselineCache,
        repoRoot,
      }),
      null,
    );

    const outputDir = path.join(workspace, "auto-baseline-report");
    const reports = buildIntelReports({
      autoBaseline: true,
      candidatePath: candidateApp,
      outputDir,
      registry,
      repoRoot,
    });

    assert.equal(reports.mapDrift.mode, "baselineComparison");
    assert.ok(fs.existsSync(path.join(outputDir, "baseline/inventory.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "candidate/inventory.json")));
    assert.ok(findClassification(reports.driftReport, "chronicle_sidecar", "NEW_UPSTREAM_CAPABILITY"));
  }));

test("CLI loads the checked-in registry and writes the report bundle", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "cli-report");
    const cliPath = path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--candidate",
        candidateApp,
        "--output-dir",
        outputDir,
        "--timestamp",
        "2026-07-03T12-00-00Z",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.outputDir, outputDir);
    assert.equal(summary.decision.acceptance, "blocked");
    assert.ok(summary.decision.blockersCount > 0);
    assert.equal(summary.decision.allProtectedSurfacesPresent, false);
    assert.ok(fs.existsSync(path.join(outputDir, "inventory.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "protected-surfaces.json")));
    assert.ok(fs.existsSync(path.join(outputDir, "substrate-action-plan.md")));
    const protectedSurfaces = JSON.parse(
      fs.readFileSync(path.join(outputDir, "protected-surfaces.json"), "utf8"),
    );
    assert.equal(protectedSurfaces.surfacesById.record_and_replay_plugin.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.codex_chronicle.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.chronicle_settings_toggles.status, "PRESENT");
    assert.equal(protectedSurfaces.surfacesById.work_louder_control_surface.status, "PRESENT");
  }));

test("CLI exits nonzero with --fail-on-blockers when acceptance blockers are present", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "cli-fail-report");
    const cliPath = path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js");

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--candidate",
        candidateApp,
        "--output-dir",
        outputDir,
        "--fail-on-blockers",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 2, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.decision.acceptance, "blocked");
    assert.ok(summary.decision.blockersCount > 0);
    assert.match(result.stderr, /protected-surface acceptance blocker/);
    assert.ok(fs.existsSync(path.join(outputDir, "drift-report.json")));
  }));

test("CLI keeps optional patch-report skips review-only under --fail-on-blockers", () =>
  withTempDir((workspace) => {
    const candidateApp = createFixtureApp(workspace, "candidate");
    const outputDir = path.join(workspace, "cli-optional-patch-report");
    const cliPath = path.join(process.cwd(), "scripts/dev/upstream-dmg-intel.js");
    const registryPath = path.join(workspace, "registry.json");
    const patchReportPath = path.join(workspace, "patch-report.json");

    writeJson(registryPath, {
      version: 1,
      surfaces: [
        {
          id: "record_and_replay_event_stream",
          title: "Record & Replay event stream MCP",
          category: "plugin",
          pathPatterns: ["record-and-replay"],
          contentNeedles: ["event_stream_start", "browser_trace", "speech_context"],
          pluginIds: ["record-and-replay"],
          linuxSubstrate: {
            requiredPaths: ["record-replay-linux/src/main.rs"],
          },
        },
      ],
    });
    writeJson(patchReportPath, {
      patches: [
        {
          name: "record-and-replay bridge patch",
          status: "skipped-optional",
          reason: "upstream bridge marker moved",
          surfaceId: "record_and_replay_event_stream",
        },
      ],
    });

    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        "--candidate",
        candidateApp,
        "--no-baseline",
        "--registry",
        registryPath,
        "--patch-report",
        patchReportPath,
        "--output-dir",
        outputDir,
        "--fail-on-blockers",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.decision.acceptance, "review");
    assert.equal(summary.decision.blockersCount, 0);
    assert.equal(summary.decision.reviewItemsCount, 1);
    const driftReport = JSON.parse(fs.readFileSync(path.join(outputDir, "drift-report.json"), "utf8"));
    assert.ok(findClassification(driftReport, "record_and_replay_event_stream", "PATCH_REVIEW"));
    assert.ok(!findClassification(driftReport, "record_and_replay_event_stream", "PATCH_BROKEN"));
  }));
