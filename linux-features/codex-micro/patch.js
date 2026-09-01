"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  extractedAppPatch,
} = require("../../scripts/patches/descriptor.js");

const CODEX_MICRO_GATE_ID = "3207467860";
const CODEX_MICRO_ROUTE = "/settings/codex-micro";
const CODEX_MICRO_GATE_MARKER = "codexLinuxCodexMicroGateOverride";
const CODEX_MICRO_HOTPLUG_MARKER = "codexLinuxCodexMicroHotplug";
const JS_IDENT = "[A-Za-z_$][\\w$]*";
const CODEX_MICRO_SERVICE_PATTERN =
  /^service-[A-Za-z0-9_-]+\.js$/;
const CODEX_MICRO_GATE_CONTRACTS = [
  {
    description: "Codex Micro app-shell gates",
    gateCount: 5,
    routeCount: 2,
    anchor: (source) =>
      source.includes("codex-micro-onboarding-host-")
      && source.includes("codex-micro-bridge-"),
  },
  {
    description: "Codex Micro settings-visibility gate",
    gateCount: 1,
    routeCount: 0,
    anchor: (source) =>
      source.includes("case`codex-micro`:return")
      && source.includes('"codex-micro":'),
  },
  {
    description: "Codex Micro debug-panel gate",
    gateCount: 1,
    routeCount: 0,
    anchor: (source) =>
      source.includes("codexMicro.onboarding.debugStatus"),
  },
];
const WATCH_TOPOLOGY_FUNCTION = new RegExp(
  `function (${JS_IDENT})\\((${JS_IDENT})\\)\\{return ` +
    `(${JS_IDENT})\\(\\)\\.watch\\(\\2\\)\\}`,
  "g",
);

function occurrenceCount(source, value) {
  return source.split(value).length - 1;
}

function codexMicroFeatureGateContract(source, expected) {
  if (typeof source !== "string") {
    return null;
  }

  const routeLiteral = `\`${CODEX_MICRO_ROUTE}\``;
  if (occurrenceCount(source, routeLiteral) !== expected.routeCount) {
    return null;
  }

  const directGate = new RegExp(
    `(^|[^A-Za-z0-9_$.])(${JS_IDENT})\\(\`${CODEX_MICRO_GATE_ID}\`\\)`,
    "g",
  );
  const patchedGate = new RegExp(
    `!0/\\*${CODEX_MICRO_GATE_MARKER}\\*/`,
    "g",
  );
  const directMatches = [...source.matchAll(directGate)];
  const patchedMatches = [...source.matchAll(patchedGate)];
  const gateIdCount = occurrenceCount(source, CODEX_MICRO_GATE_ID);
  const markerCount = occurrenceCount(source, CODEX_MICRO_GATE_MARKER);

  if (
    gateIdCount === expected.gateCount
    && directMatches.length === expected.gateCount
    && markerCount === 0
    && patchedMatches.length === 0
  ) {
    return { state: "unpatched", directGate };
  }
  if (
    gateIdCount === 0
    && directMatches.length === 0
    && markerCount === expected.gateCount
    && patchedMatches.length === expected.gateCount
  ) {
    return { state: "patched", directGate };
  }
  return null;
}

function matchesCodexMicroFeatureGateContract(source, expected) {
  return codexMicroFeatureGateContract(source, expected) != null;
}

function applyCodexMicroFeatureGatePatch(source, expected) {
  const contract = codexMicroFeatureGateContract(source, expected);
  if (contract?.state === "patched") {
    return source;
  }
  if (contract?.state === "unpatched") {
    return source.replace(
      contract.directGate,
      (_match, boundary) =>
        `${boundary}!0/*${CODEX_MICRO_GATE_MARKER}*/`,
    );
  }
  if (
    typeof source === "string"
    && source.includes(`\`${CODEX_MICRO_ROUTE}\``)
  ) {
    console.warn(
      "WARN: Current Codex Micro feature-gate contract is incomplete or drifted - " +
        "skipping Codex Micro gate override",
    );
  }
  return source;
}

function findCodexMicroFeatureGateAssets(extractedDir) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  if (!fs.existsSync(assetsDir)) {
    return {
      matches: null,
      reason: "webview/assets directory not found",
    };
  }

  const candidates = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => {
      const assetPath = path.join(assetsDir, entry.name);
      return {
        assetName: entry.name,
        assetPath,
        source: fs.readFileSync(assetPath, "utf8"),
      };
    })
    .filter(({ source }) =>
      source.includes(CODEX_MICRO_GATE_ID)
      || source.includes(CODEX_MICRO_GATE_MARKER),
    );

  const matches = [];
  for (const expected of CODEX_MICRO_GATE_CONTRACTS) {
    const contractMatches = candidates
      .filter(({ source }) => expected.anchor(source))
      .map((candidate) => ({
        ...candidate,
        contract: codexMicroFeatureGateContract(candidate.source, expected),
        expected,
      }))
      .filter(({ contract }) => contract != null);
    if (contractMatches.length !== 1) {
      return {
        matches: null,
        reason:
          `Found ${contractMatches.length} current ${expected.description} bundles`,
      };
    }
    matches.push(contractMatches[0]);
  }

  if (new Set(matches.map(({ assetName }) => assetName)).size !== matches.length) {
    return {
      matches: null,
      reason: "Current Codex Micro feature-gate contracts overlap",
    };
  }
  if (candidates.length !== matches.length) {
    return {
      matches: null,
      reason:
        `Found ${candidates.length} Codex Micro feature-gate bundles; expected ${matches.length}`,
    };
  }

  const states = new Set(matches.map(({ contract }) => contract.state));
  if (states.size !== 1) {
    return {
      matches: null,
      reason: "Current Codex Micro feature-gate bundles have mixed patch state",
    };
  }
  return { matches, reason: null };
}

function patchCodexMicroFeatureGateAssets(extractedDir) {
  const discovery = findCodexMicroFeatureGateAssets(extractedDir);
  if (discovery.matches == null) {
    console.warn(
      `WARN: ${discovery.reason} - skipping Codex Micro feature-gate override`,
    );
    return { matched: 0, changed: 0, reason: discovery.reason };
  }

  const pendingWrites = discovery.matches
    .map((match) => ({
      ...match,
      patchedSource: applyCodexMicroFeatureGatePatch(
        match.source,
        match.expected,
      ),
    }))
    .filter(({ source, patchedSource }) => source !== patchedSource);
  for (const { assetPath, patchedSource } of pendingWrites) {
    fs.writeFileSync(assetPath, patchedSource, "utf8");
  }
  return {
    matched: 1,
    changed: pendingWrites.length,
    reason: null,
    targets: discovery.matches.map(({ assetName }) => assetName),
  };
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

module.exports = {
  CODEX_MICRO_GATE_ID,
  CODEX_MICRO_GATE_CONTRACTS,
  CODEX_MICRO_GATE_MARKER,
  CODEX_MICRO_HOTPLUG_MARKER,
  CODEX_MICRO_ROUTE,
  applyCodexMicroFeatureGatePatch,
  applyCodexMicroHotplugPatch,
  codexMicroTopologyWatcher,
  findCodexMicroFeatureGateAssets,
  findCodexMicroServiceBundle,
  hasCodexMicroServiceContract,
  matchesCodexMicroFeatureGateContract,
  patchCodexMicroHotplugSource,
  patchCodexMicroFeatureGateAssets,
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
    extractedAppPatch({
      id: "webview-feature-gate",
      phase: "extracted-app:pre-webview",
      order: 28_990,
      ciPolicy: "opt-in",
      targetSummary: "current Codex Micro feature-gate webview bundles",
      apply: patchCodexMicroFeatureGateAssets,
      status: (result, warnings) => {
        if (result?.matched !== 1) {
          return {
            status: "skipped-optional",
            reason: result?.reason ?? warnings[0] ?? null,
          };
        }
        return result.changed > 0 ? "applied" : "already-applied";
      },
    }),
  ],
};
