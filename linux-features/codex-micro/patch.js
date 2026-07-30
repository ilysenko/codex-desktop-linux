"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const {
  extractedAppPatch,
  webviewAssetPatch,
} = require("../../scripts/patches/descriptor.js");

const CODEX_MICRO_GATE_ID = "3207467860";
const CODEX_MICRO_ROUTE = "/settings/codex-micro";
const CODEX_MICRO_GATE_MARKER = "codexLinuxCodexMicroGateOverride";
const CODEX_MICRO_HOTPLUG_MARKER = "codexLinuxCodexMicroHotplug";
const FEATURE_GATE_WARNING = "useFeatureGate hook failed to find a valid StatsigClient";
const JS_IDENT = "[A-Za-z_$][\\w$]*";
const CODEX_MICRO_SERVICE_PATTERN =
  /^service-[A-Za-z0-9_-]+\.js$/;
const WATCH_TOPOLOGY_FUNCTION = new RegExp(
  `function (${JS_IDENT})\\((${JS_IDENT})\\)\\{return ` +
    `(${JS_IDENT})\\(\\)\\.watch\\(\\2\\)\\}`,
  "g",
);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exportedFeatureGateHook(source) {
  const exportStart = source.lastIndexOf("export{");
  const exportEnd = exportStart < 0 ? -1 : source.indexOf("}", exportStart);
  if (exportStart < 0 || exportEnd < 0) {
    return null;
  }

  const exportBlock = source.slice(exportStart, exportEnd + 1);
  const candidates = new RegExp(
    `function (${JS_IDENT})\\((${JS_IDENT})\\)\\{return ` +
      `(${JS_IDENT})\\(\\),(${JS_IDENT})\\((${JS_IDENT}),\\2\\)\\}`,
    "g",
  );
  const exportedCandidates = [];
  for (const match of source.matchAll(candidates)) {
    const hookName = match[1];
    const exportedAsGateHook = new RegExp(
      `(?:\\{|,)${escapeRegExp(hookName)} as ${JS_IDENT}(?:,|\\})`,
    );
    if (exportedAsGateHook.test(exportBlock)) {
      exportedCandidates.push({
        source: match[0],
        hookName,
        argumentName: match[2],
        contextHookName: match[3],
        atomReadName: match[4],
        gateAtomName: match[5],
      });
    }
  }
  return exportedCandidates.length === 1 ? exportedCandidates[0] : null;
}

function hasCodexMicroCallsite(source, hookName) {
  if (typeof source !== "string" || typeof hookName !== "string") {
    return false;
  }
  const gateCall = new RegExp(
    `(?:^|[^A-Za-z0-9_$.])${escapeRegExp(hookName)}\\(\`${CODEX_MICRO_GATE_ID}\`\\)`,
  );
  return gateCall.test(source)
    && source.includes(`\`${CODEX_MICRO_ROUTE}\``);
}

function matchesCodexMicroFeatureGateContract(source) {
  if (typeof source !== "string") {
    return false;
  }
  if (source.includes(CODEX_MICRO_GATE_MARKER)) {
    return true;
  }
  const hook = exportedFeatureGateHook(source);
  return source.includes(FEATURE_GATE_WARNING)
    && hook != null
    && hasCodexMicroCallsite(source, hook.hookName);
}

function applyCodexMicroFeatureGatePatch(source) {
  if (typeof source !== "string" || source.includes(CODEX_MICRO_GATE_MARKER)) {
    return source;
  }

  const hook = exportedFeatureGateHook(source);
  if (hook == null) {
    if (source.includes(FEATURE_GATE_WARNING)) {
      console.warn(
        "WARN: Could not find the current exported feature-gate hook - " +
          "skipping Codex Micro gate override",
      );
    }
    return source;
  }
  if (!hasCodexMicroCallsite(source, hook.hookName)) {
    return source;
  }

  const replacement =
    `function ${hook.hookName}(${hook.argumentName}){return ` +
    `${hook.contextHookName}(),${hook.atomReadName}(${hook.gateAtomName},${hook.argumentName})||` +
    `${hook.argumentName}===\`${CODEX_MICRO_GATE_ID}\`/*${CODEX_MICRO_GATE_MARKER}*/}`;
  return source.replace(hook.source, replacement);
}

function hasCodexMicroServiceContract(source) {
  return typeof source === "string"
    && source.includes("hid-topology-watcher.node")
    && source.includes("hid_topology_watcher.node")
    && source.includes(".findCodexMicroInterfaces()")
    && source.includes("scheduleTopologyFallbackScan()");
}

function codexMicroTopologyWatcher(source) {
  if (!hasCodexMicroServiceContract(source)) {
    return null;
  }
  WATCH_TOPOLOGY_FUNCTION.lastIndex = 0;
  const matches = [...source.matchAll(WATCH_TOPOLOGY_FUNCTION)]
    .filter((match) =>
      source.includes(`${match[3]}().findCodexMicroInterfaces()`),
    );
  if (matches.length !== 1) {
    return null;
  }
  const [match] = matches;
  return {
    source: match[0],
    functionName: match[1],
    callbackName: match[2],
    loaderName: match[3],
  };
}

function patchCodexMicroHotplugSource(source) {
  const markerCount = source.split(CODEX_MICRO_HOTPLUG_MARKER).length - 1;
  if (markerCount === 1) {
    return { source, matched: 1, changed: 0, reason: null };
  }
  if (markerCount !== 0) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `Found ${markerCount} Codex Micro hot-plug markers`,
    };
  }

  const watcher = codexMicroTopologyWatcher(source);
  if (watcher == null) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: "Current Codex Micro topology watcher contract not found",
    };
  }

  const replacement =
    `function ${watcher.functionName}(${watcher.callbackName}){` +
    `if(process.platform===\`linux\`){` +
    `let codexLinuxHotplugTimer=null,codexLinuxDevWatcher=null,` +
    `codexLinuxPollTimer=null,codexLinuxDisposed=!1,` +
    `codexLinuxNotify=()=>{if(codexLinuxDisposed)return;` +
    `codexLinuxHotplugTimer!=null&&` +
    `clearTimeout(codexLinuxHotplugTimer),codexLinuxHotplugTimer=setTimeout(()=>{` +
    `codexLinuxHotplugTimer=null,codexLinuxDisposed||` +
    `${watcher.callbackName}()},100)},codexLinuxStartPolling=()=>{` +
    `codexLinuxPollTimer==null&&(codexLinuxPollTimer=` +
    `setInterval(codexLinuxNotify,2e3),codexLinuxPollTimer.unref?.())};` +
    `try{codexLinuxDevWatcher=require(\`node:fs\`).watch(` +
    `\`/dev\`,{persistent:!1},(eventType,filename)=>{` +
    `(filename==null||/^hidraw[0-9]+$/.test(String(filename)))&&` +
    `codexLinuxNotify()}),codexLinuxDevWatcher.on(\`error\`,()=>{` +
    `if(codexLinuxDisposed)return;` +
    `codexLinuxDevWatcher?.close(),codexLinuxDevWatcher=null,` +
    `codexLinuxStartPolling(),codexLinuxNotify()})}catch{` +
    `codexLinuxDisposed||(` +
    `codexLinuxStartPolling(),codexLinuxNotify())}` +
    `return{dispose(){codexLinuxDisposed=!0,` +
    `codexLinuxHotplugTimer!=null&&clearTimeout(codexLinuxHotplugTimer),` +
    `codexLinuxPollTimer!=null&&clearInterval(codexLinuxPollTimer),` +
    `codexLinuxDevWatcher?.close(),` +
    `codexLinuxDevWatcher=null}}}` +
    `return ${watcher.loaderName}().watch(${watcher.callbackName})}` +
    `/*${CODEX_MICRO_HOTPLUG_MARKER}*/`;
  return {
    source: source.replace(watcher.source, replacement),
    matched: 1,
    changed: 1,
    reason: null,
  };
}

function applyCodexMicroHotplugPatch(source) {
  if (typeof source !== "string") {
    return source;
  }
  return patchCodexMicroHotplugSource(source).source;
}

function findCodexMicroServiceBundle(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return {
      target: null,
      result: null,
      reason: ".vite/build directory not found",
    };
  }

  const candidates = fs.readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile() && CODEX_MICRO_SERVICE_PATTERN.test(entry.name),
    )
    .map((entry) => path.join(buildDir, entry.name))
    .sort()
    .map((bundlePath) => {
      const source = fs.readFileSync(bundlePath, "utf8");
      return {
        bundlePath,
        result: patchCodexMicroHotplugSource(source),
      };
    })
    .filter(({ result }) => result.matched === 1);

  if (candidates.length !== 1) {
    return {
      target: null,
      result: null,
      reason:
        `Found ${candidates.length} current Codex Micro service bundles`,
    };
  }
  return {
    target: candidates[0].bundlePath,
    result: candidates[0].result,
    reason: candidates[0].result.reason,
  };
}

function patchCodexMicroService(extractedDir) {
  const discovery = findCodexMicroServiceBundle(extractedDir);
  if (discovery.target == null || discovery.result?.matched !== 1) {
    const reason =
      discovery.reason ?? "Current Codex Micro service bundle not found";
    console.warn(`WARN: ${reason} - skipping Linux Codex Micro hot-plug patch`);
    return { matched: 0, changed: 0, reason };
  }
  if (discovery.result.changed === 1) {
    fs.writeFileSync(discovery.target, discovery.result.source, "utf8");
  }
  return {
    matched: discovery.result.matched,
    changed: discovery.result.changed,
    reason: discovery.result.reason,
    target: path.relative(extractedDir, discovery.target),
  };
}

function stageNativeBinding(extractedDir) {
  const helper = path.join(__dirname, "native-binding.js");
  const output = childProcess.execFileSync(process.execPath, [helper, "--stage", extractedDir], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output);
}

module.exports = {
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_MARKER,
  CODEX_MICRO_HOTPLUG_MARKER,
  CODEX_MICRO_ROUTE,
  applyCodexMicroFeatureGatePatch,
  applyCodexMicroHotplugPatch,
  codexMicroTopologyWatcher,
  exportedFeatureGateHook,
  findCodexMicroServiceBundle,
  hasCodexMicroCallsite,
  hasCodexMicroServiceContract,
  matchesCodexMicroFeatureGateContract,
  patchCodexMicroHotplugSource,
  patchCodexMicroService,
  descriptors: [
    extractedAppPatch({
      id: "linux-hid-hotplug",
      phase: "extracted-app:pre-webview",
      order: 28_980,
      ciPolicy: "opt-in",
      targetSummary: "current Codex Micro main-process service bundle",
      apply: patchCodexMicroService,
      status: (result, warnings) => {
        if (result?.matched !== 1) {
          return {
            status: "skipped-optional",
            reason: result?.reason ?? warnings[0] ?? null,
          };
        }
        return result.changed === 1 ? "applied" : "already-applied";
      },
    }),
    webviewAssetPatch({
      id: "webview-feature-gate",
      order: 28_990,
      ciPolicy: "opt-in",
      pattern: /^app-initial-[A-Za-z0-9_-]+\.js$/,
      assetMatch: matchesCodexMicroFeatureGateContract,
      missingDescription: "current Codex Micro feature-gate webview bundle",
      skipDescription: "Codex Micro feature-gate override",
      apply: applyCodexMicroFeatureGatePatch,
    }),
    extractedAppPatch({
      id: "linux-node-hid-binding",
      phase: "extracted-app:post-webview",
      order: 29_000,
      ciPolicy: "opt-in",
      targetSummary: "current Work Louder nested node-hid 3.3.0 dependency",
      apply: (extractedDir) => stageNativeBinding(extractedDir),
      status: (result) => ({
        status: result?.changed
          ? "applied"
          : result?.alreadyApplied
            ? "already-applied"
            : "skipped-optional",
        reason: result == null
          ? "node-hid binding staging returned no result"
          : `${result.source} node-hid ${result.version}`,
      }),
    }),
  ],
};
