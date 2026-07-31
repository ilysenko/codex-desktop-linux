"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PATCH_MARKER = "codexLinuxShallowRepositoryWatches";
const PARCEL_WATCH_MARKER = "codexLinuxShallowParcelWorkingTreeWatch";
const LOCAL_FILE_WATCH_METHOD =
  /async startFileWatch\((?<options>[A-Za-z_$][\w$]*)\)\{(?=let [^{}]{0,180}?await this\.platformPath\(\),[^{}]{0,180}?\(0,[A-Za-z_$][\w$]*\.watch\)\(this\.getFileSystemPath\(\k<options>\.path\),\{recursive:\k<options>\.recursive\})/gu;
const PARCEL_WORKING_TREE_WATCH =
  /process\.platform===`linux`\?[A-Za-z_$][\w$]*\((?<options>[A-Za-z_$][\w$]*),\{ignoredPaths:\[[A-Za-z_$][\w$]*\.posix\.join\(\k<options>\.path,`\.git`\)\]\}\):(?<host>[A-Za-z_$][\w$]*)\.startFileWatch\(\k<options>\)/gu;

function patchWorkerSource(source) {
  const markerCount = source.split(PATCH_MARKER).length - 1;
  if (markerCount > 1) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason: `Found ${markerCount} shallow repository-watch markers`,
    };
  }

  let patchedSource = source;
  let changed = 0;
  if (markerCount === 0) {
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
      `if(process.platform===\`linux\`&&${optionsName}.recursive){` +
      `/*${PATCH_MARKER}*/` +
      `${optionsName}={...${optionsName},recursive:!1}}`;
    const methodStart = match.index + match[0].length;
    patchedSource = source.slice(0, methodStart) + branch + source.slice(methodStart);
    changed = 1;
  }

  const parcelMarkerCount = patchedSource.split(PARCEL_WATCH_MARKER).length - 1;
  PARCEL_WORKING_TREE_WATCH.lastIndex = 0;
  const parcelMatches = [...patchedSource.matchAll(PARCEL_WORKING_TREE_WATCH)];
  if (
    parcelMarkerCount > 1 ||
    parcelMatches.length > 1 ||
    (parcelMarkerCount > 0 && parcelMatches.length > 0)
  ) {
    return {
      source,
      matched: 0,
      changed: 0,
      reason:
        `Found ${parcelMatches.length} Parcel working-tree watch branches and ` +
        `${parcelMarkerCount} markers`,
    };
  }
  const finalSource = parcelMatches.length === 0
    ? patchedSource
    : patchedSource.replace(
      PARCEL_WORKING_TREE_WATCH,
      `/*${PARCEL_WATCH_MARKER}*/$<host>.startFileWatch($<options>)`,
    );
  if (parcelMatches.length === 1) changed = 1;
  return {
    source: finalSource,
    matched: 1,
    changed,
    reason: null,
  };
}

function findLocalFileWatchBundles(extractedDir) {
  const buildDir = path.join(extractedDir, ".vite", "build");
  if (!fs.existsSync(buildDir)) {
    return { candidates: [], reason: ".vite/build directory not found" };
  }

  const bundlePaths = fs.readdirSync(buildDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => path.join(buildDir, entry.name))
    .sort();
  const candidates = [];

  for (const bundlePath of bundlePaths) {
    const source = fs.readFileSync(bundlePath, "utf8");
    const markerCount = source.split(PATCH_MARKER).length - 1;
    const parcelMarkerCount = source.split(PARCEL_WATCH_MARKER).length - 1;
    LOCAL_FILE_WATCH_METHOD.lastIndex = 0;
    const matchCount = [...source.matchAll(LOCAL_FILE_WATCH_METHOD)].length;
    PARCEL_WORKING_TREE_WATCH.lastIndex = 0;
    const parcelMatchCount = [...source.matchAll(PARCEL_WORKING_TREE_WATCH)].length;
    if (markerCount > 0 || matchCount > 0 || parcelMarkerCount > 0 || parcelMatchCount > 0) {
      candidates.push({
        bundlePath,
        markerCount,
        matchCount,
        parcelMarkerCount,
        parcelMatchCount,
        source,
      });
    }
  }

  const rawMatchCount = candidates.reduce((total, candidate) => total + candidate.matchCount, 0);
  const markerCount = candidates.reduce((total, candidate) => total + candidate.markerCount, 0);
  const parcelContractCount = candidates.reduce(
    (total, candidate) => total + candidate.parcelMatchCount + candidate.parcelMarkerCount,
    0,
  );
  if (
    candidates.length !== 2 ||
    !((rawMatchCount === 2 && markerCount === 0) || (rawMatchCount === 0 && markerCount === 2)) ||
    parcelContractCount !== 1
  ) {
    return {
      candidates: [],
      reason:
        `Found ${rawMatchCount} local startFileWatch implementations, ${markerCount} markers, ` +
        `and ${parcelContractCount} Parcel working-tree branches across ` +
        `${candidates.length} candidate bundles`,
    };
  }
  return { candidates, reason: null };
}

function patchWorker(extractedDir) {
  const discovery = findLocalFileWatchBundles(extractedDir);
  if (discovery.candidates.length !== 2) {
    const reason = discovery.reason ?? "Local startFileWatch implementations not found";
    console.warn(`WARN: ${reason} - skipping shallow repository-watch feature`);
    return { matched: 0, changed: 0, reason };
  }
  const results = discovery.candidates.map((candidate) => ({
    bundlePath: candidate.bundlePath,
    result: patchWorkerSource(candidate.source),
  }));
  const failed = results.find(({ result }) => result.matched !== 1);
  if (failed != null) {
    const reason = failed.result.reason ?? "Local startFileWatch implementation not patched";
    console.warn(`WARN: ${reason} - skipping shallow repository-watch feature`);
    return { matched: 0, changed: 0, reason };
  }
  for (const { bundlePath, result } of results) {
    if (result.changed === 1) fs.writeFileSync(bundlePath, result.source, "utf8");
  }
  return {
    matched: results.length,
    changed: results.reduce((total, { result }) => total + result.changed, 0),
    reason: null,
    targets: results.map(({ bundlePath }) => path.relative(extractedDir, bundlePath)),
  };
}

const descriptors = [
  {
    id: "local-file-watch",
    phase: "extracted-app:pre-webview",
    order: 20_935,
    ciPolicy: "optional",
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
  LOCAL_FILE_WATCH_METHOD,
  PARCEL_WATCH_MARKER,
  PATCH_MARKER,
  descriptors,
  findLocalFileWatchBundles,
  patchWorker,
  patchWorkerSource,
};
