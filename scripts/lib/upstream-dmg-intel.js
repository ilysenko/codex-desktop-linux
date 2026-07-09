"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TEXT_FILE_PATTERN = /\.(cjs|css|html|js|json|mjs|md|text|ts|tsx|txt|xml|yml|yaml)$/i;
const NATIVE_FILE_PATTERN = /(^|\/)(codex_chronicle|SkyComputerUseClient|sky\.node|node_repl|node|[^/]+\.(node|dylib))$/i;
const DEFAULT_MAX_TEXT_BYTES = 2_500_000;
const DEFAULT_MAX_INVENTORY_HASH_BYTES = 10_000_000;
const DRIFT_PATH_SAMPLE_LIMIT = 8;
const DRIFT_CHANGED_SAMPLE_LIMIT = 12;
const MARKDOWN_PATH_SAMPLE_LIMIT = 3;
const ACTION_PLAN_PATH_SAMPLE_LIMIT = 3;
const SUCCESSFUL_PATCH_STATUSES = new Set(["applied", "already-applied", "skipped-target", "skipped-disabled"]);
const BLOCKING_PATCH_STATUSES = new Set(["failed-required"]);
const ACTIONABLE_CLASSIFICATIONS = new Set([
  "MOVED",
  "RENAMED",
  "PAYLOAD_CHANGED",
  "REMOVED",
  "NEW_UPSTREAM_CAPABILITY",
  "PATCH_BROKEN",
  "PATCH_INTEGRITY_BROKEN",
  "PATCH_REVIEW",
  "LINUX_SUBSTRATE_GAP",
  "PROTECTED_SURFACE_PARTIAL",
  "PROTECTED_SURFACE_MISSING",
]);
const STRING_LITERAL_PATTERN = /`([^`\\]*(?:\\.[^`\\]*)*)`|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
const BRIDGE_CHANNEL_TERM_PATTERN =
  /browser[-_]trace|chrome|chronicle|computer[-_]use|desktop[-_]snapshot|dictation|event[-_]stream|focused[-_]window|global[-_]dictation|nativeMessaging|record[-_ ]?(?:and[-_ ]?)?replay|skysight|speech[-_]context|window[-_]metadata/i;
const LOWER_BRIDGE_CHANNEL_PATTERN = /^[a-z][a-z0-9_.:-]{2,119}$/;
const CAMEL_BRIDGE_CHANNEL_PATTERN = /^(?:browserTrace|computerUse|eventStream|focusedWindow|nativeMessaging|recordAndReplay|speechContext|windowMetadata)$/;
const ASSET_EXTENSION_PATTERN = /\.(?:css|dylib|exe|gif|ico|jpeg|jpg|js|json|md|node|png|svg|ts|tsx|txt|wasm|yml|yaml)$/i;
const commandPathCache = new Map();

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\/+/, "");
}

function toRegex(pattern) {
  return pattern instanceof RegExp ? pattern : new RegExp(pattern, "i");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchAny(patterns, value) {
  return (patterns ?? []).some((pattern) => toRegex(pattern).test(value));
}

function textSnippet(text, needle) {
  const index = text.toLowerCase().indexOf(String(needle).toLowerCase());
  if (index < 0) {
    return null;
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + String(needle).length + 80);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function includesNeedle(value, needle) {
  const valueText = String(value);
  const needleText = String(needle);
  if (/^[A-Za-z0-9_]+$/.test(needleText) && needleText.length <= 4) {
    const escaped = needleText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`, "i").test(valueText);
  }
  return valueText.toLowerCase().includes(needleText.toLowerCase());
}

function printableStrings(buffer, minLength = 4) {
  const strings = new Set();
  let current = "";
  for (const byte of buffer) {
    if (byte >= 32 && byte <= 126) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) {
        strings.add(current);
      }
      current = "";
    }
  }
  if (current.length >= minLength) {
    strings.add(current);
  }
  return [...strings].sort();
}

function asarEntries(asarPath, prefix = "app.asar") {
  const archive = fs.readFileSync(asarPath);
  if (archive.length < 16) {
    throw new Error(`Invalid ASAR archive: ${asarPath}`);
  }

  const headerSize = archive.readUInt32LE(4);
  const jsonSize = archive.readUInt32LE(12);
  const header = JSON.parse(archive.subarray(16, 16 + jsonSize).toString("utf8"));
  const dataStart = 8 + headerSize;
  const entries = [];

  function walk(prefix, files) {
    for (const [name, entry] of Object.entries(files ?? {})) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        walk(fullPath, entry.files);
      } else {
        const size = Number(entry.size ?? 0);
        const offset = Number(entry.offset ?? 0);
        const unpacked = Boolean(entry.unpacked);
        const buffer = unpacked ? null : archive.subarray(dataStart + offset, dataStart + offset + size);
        entries.push({
          buffer,
          relativePath: `${prefix}/${fullPath}`,
          size,
          source: "asar",
          unpacked,
        });
      }
    }
  }

  walk("", header.files);
  return entries;
}

function walkFiles(rootDir, source = "filesystem", prefix = "") {
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      const fullPath = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(fullPath);
      } else if (dirent.isFile()) {
        const stat = fs.statSync(fullPath);
        const relativePath = normalizePath(path.join(prefix, path.relative(rootDir, fullPath)));
        files.push({
          absolutePath: fullPath,
          mode: stat.mode,
          relativePath,
          size: stat.size,
          source,
        });
      }
    }
  }
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function sourceKind(sourcePath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory() && /\.app$/i.test(path.basename(sourcePath))) {
    return "app";
  }
  if (stat.isDirectory()) {
    return "directory";
  }
  if (/\.dmg$/i.test(sourcePath)) {
    return "dmg";
  }
  throw new Error(`Unsupported upstream source: ${sourcePath}`);
}

function findAppDir(extractDir) {
  const stack = [extractDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of entries) {
      if (!dirent.isDirectory()) {
        continue;
      }
      const fullPath = path.join(current, dirent.name);
      if (/\.app$/i.test(dirent.name)) {
        return fullPath;
      }
      stack.push(fullPath);
    }
  }
  return null;
}

function extractDmgToApp({ dmgPath, workDir }) {
  const extractDir = path.join(workDir, "dmg-extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const sevenZipCommand = commandOnPath("7zz") ?? commandOnPath("7z");
  if (sevenZipCommand == null) {
    throw new Error("7zz or 7z is required to inspect DMG files");
  }
  const seven = spawnSync(sevenZipCommand, ["x", "-y", "-snl", dmgPath, `-o${extractDir}`], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  const appDir = findAppDir(extractDir);
  if (seven.status !== 0 && appDir == null) {
    throw new Error(`7z failed to extract DMG: ${(seven.stderr || seven.stdout || "").trim()}`);
  }
  if (appDir == null) {
    throw new Error(`Could not find .app bundle in extracted DMG: ${dmgPath}`);
  }
  return appDir;
}

function commandOnPath(command) {
  const cacheKey = `${process.env.PATH ?? ""}\0${command}`;
  if (commandPathCache.has(cacheKey)) {
    return commandPathCache.get(cacheKey);
  }
  const resolved = resolveCommandOnPath(command);
  commandPathCache.set(cacheKey, resolved);
  return resolved;
}

function resolveCommandOnPath(command) {
  if (command.includes(path.sep)) {
    return executablePathOrNull(command);
  }
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) {
      continue;
    }
    const candidate = path.join(entry, command);
    const resolved = executablePathOrNull(candidate);
    if (resolved != null) {
      return resolved;
    }
  }
  return null;
}

function executablePathOrNull(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    const stat = fs.statSync(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function collectInventoryFiles(appDir, options = {}) {
  const resourcesDir = path.join(appDir, "Contents/Resources");
  const hasAppBundleResources = fs.existsSync(resourcesDir);
  const root = hasAppBundleResources ? appDir : appDir;
  const resourcesPrefix = hasAppBundleResources ? "Contents/Resources" : "";
  const files = walkFiles(root).filter((file) => !file.relativePath.includes("app.asar.extracted/"));
  const asarPath = path.join(resourcesDir, "app.asar");
  const asarExtractedDir = path.join(resourcesDir, "app.asar.extracted");

  if (fs.existsSync(asarPath)) {
    try {
      files.push(...asarEntries(asarPath, normalizePath(path.join(resourcesPrefix, "app.asar"))));
    } catch (error) {
      files.push({
        relativePath: "app.asar",
        scanError: error.message,
        size: fs.statSync(asarPath).size,
        source: "asar",
      });
    }
  }

  if (fs.existsSync(asarExtractedDir)) {
    files.push(...walkFiles(asarExtractedDir, "asar-extracted", normalizePath(path.join(resourcesPrefix, "app.asar"))));
  }

  return files.map((file) => enrichInventoryFile(file, options));
}

function fileType(file) {
  if (file.relativePath.endsWith(".json")) {
    return "json";
  }
  if (TEXT_FILE_PATTERN.test(file.relativePath)) {
    return "text";
  }
  const executable = typeof file.mode === "number" && (file.mode & 0o111) !== 0;
  const extension = path.posix.extname(file.relativePath);
  if (NATIVE_FILE_PATTERN.test(file.relativePath) || (executable && extension === "")) {
    return "native";
  }
  return "binary";
}

function readFileBuffer(file) {
  if (file.buffer != null) {
    return file.buffer;
  }
  if (file.absolutePath != null) {
    return fs.readFileSync(file.absolutePath);
  }
  return null;
}

function runFileCommand(absolutePath) {
  if (absolutePath == null) {
    return null;
  }
  const result = spawnSync("file", ["-b", absolutePath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

function enrichInventoryFile(file, options = {}) {
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  const maxHashBytes = options.maxHashBytes ?? DEFAULT_MAX_INVENTORY_HASH_BYTES;
  const type = fileType(file);
  const buffer = file.unpacked ? null : readFileBuffer(file);
  const enriched = {
    absolutePath: file.absolutePath,
    mode: file.mode == null ? null : `0${(file.mode & 0o777).toString(8)}`,
    relativePath: normalizePath(file.relativePath),
    size: file.size ?? buffer?.length ?? 0,
    source: file.source,
    type,
  };

  if (file.scanError != null) {
    enriched.scanError = file.scanError;
  }
  if (buffer != null && enriched.size <= maxHashBytes) {
    enriched.sha256 = sha256(buffer);
  }
  if (buffer != null && (type === "text" || type === "json") && enriched.size <= maxTextBytes) {
    enriched.text = buffer.toString("utf8");
  }
  if (buffer != null && type === "native") {
    enriched.nativeStrings = printableStrings(buffer).slice(0, 5000);
    enriched.fileCommand = runFileCommand(file.absolutePath);
  }

  return enriched;
}

function createInventory({ registry = null, sourcePath, workDir = null } = {}) {
  if (sourcePath == null) {
    throw new Error("sourcePath is required");
  }
  const resolvedSourcePath = path.resolve(sourcePath);
  const kind = sourceKind(resolvedSourcePath);
  let scratchDir = workDir;
  let cleanupScratch = false;
  if (kind === "dmg" && scratchDir == null) {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-intel-"));
    cleanupScratch = true;
  }

  try {
    const appDir = kind === "dmg" ? extractDmgToApp({ dmgPath: resolvedSourcePath, workDir: scratchDir }) : resolvedSourcePath;
    const files = collectInventoryFiles(appDir).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      generatedAt: new Date().toISOString(),
      registryVersion: registry?.version ?? null,
      source: {
        kind,
        path: resolvedSourcePath,
        appDir,
      },
      counts: {
        files: files.length,
        nativeFiles: files.filter((file) => file.type === "native").length,
        textFiles: files.filter((file) => file.type === "text" || file.type === "json").length,
      },
      files,
    };
  } finally {
    if (cleanupScratch && scratchDir != null) {
      fs.rmSync(scratchDir, { force: true, recursive: true });
    }
  }
}

function fileEvidenceForSurface(inventory, surface) {
  const evidence = [];
  for (const file of inventory.files) {
    const pathHit = matchAny(surface.pathPatterns, file.relativePath);
    const contentHits = [];
    const nativeHits = [];
    if (file.text != null) {
      for (const needle of surface.contentNeedles ?? []) {
        if (includesNeedle(file.text, needle)) {
          contentHits.push({ needle, snippet: textSnippet(file.text, needle) });
        }
      }
    }
    if (Array.isArray(file.nativeStrings)) {
      for (const needle of surface.nativeStringNeedles ?? surface.contentNeedles ?? []) {
        const matched = file.nativeStrings.find((value) => includesNeedle(value, needle));
        if (matched != null) {
          nativeHits.push({ needle, value: matched });
        }
      }
    }
    if (pathHit || contentHits.length > 0 || nativeHits.length > 0) {
      evidence.push({
        path: file.relativePath,
        sha256: file.sha256 ?? null,
        size: file.size,
        source: file.source,
        type: file.type,
        pathHit,
        contentHits,
        nativeHits,
      });
    }
  }
  return evidence;
}

function anchorFileMatches(inventory, anchor) {
  return inventory.files.filter((file) => {
    const pathOk = (anchor.pathPatterns ?? []).length === 0 || matchAny(anchor.pathPatterns, file.relativePath);
    if (!pathOk) {
      return false;
    }
    if (anchor.type != null && file.type !== anchor.type) {
      return false;
    }
    return true;
  });
}

function matchPatternList(patterns, value) {
  return (patterns ?? []).every((pattern) => toRegex(pattern).test(value));
}

function pluginAnchorState(anchor, pluginMap) {
  const plugins = pluginMap?.plugins ?? [];
  const pluginIds = anchor.pluginIds ?? [];
  const scriptPatterns = anchor.pluginScriptPatterns ?? [];
  const skillPatterns = anchor.pluginSkillPatterns ?? [];
  if (pluginIds.length === 0 && scriptPatterns.length === 0 && skillPatterns.length === 0) {
    return { missing: [], matchedPaths: [] };
  }
  const missingPlugins = pluginIds.filter((pluginId) => !plugins.some((plugin) => plugin.id === pluginId));
  const missingScripts = scriptPatterns.filter((pattern) =>
    !plugins.some((plugin) => plugin.scripts.some((script) => toRegex(pattern).test(script))),
  );
  const missingSkills = skillPatterns.filter((pattern) =>
    !plugins.some((plugin) => plugin.skills.some((skill) => toRegex(pattern).test(skill))),
  );
  const matchedPaths = [];
  for (const plugin of plugins) {
    if (pluginIds.length === 0 || pluginIds.includes(plugin.id)) {
      matchedPaths.push(...plugin.manifests.map((manifest) => manifest.path));
      matchedPaths.push(...plugin.scripts.filter((script) => matchAny(scriptPatterns, script)));
      matchedPaths.push(...plugin.skills.filter((skill) => matchAny(skillPatterns, skill)));
    }
  }
  return {
    missing: [
      ...missingPlugins.map((pluginId) => `plugin:${pluginId}`),
      ...missingScripts.map((pattern) => `script:${pattern}`),
      ...missingSkills.map((pattern) => `skill:${pattern}`),
    ],
    matchedPaths,
  };
}

function mcpAnchorState(anchor, pluginMap) {
  const matchedPaths = [];
  const missing = [];
  const pluginIds = anchor.pluginIds ?? [];
  const serverNames = anchor.mcpServerNames ?? [];
  const commandPatterns = anchor.mcpCommandPatterns ?? [];
  const requiredArgs = anchor.mcpArgs ?? [];
  if (
    pluginIds.length === 0 &&
    serverNames.length === 0 &&
    commandPatterns.length === 0 &&
    requiredArgs.length === 0
  ) {
    return { missing: [], matchedPaths: [] };
  }
  const servers = [];
  for (const plugin of pluginMap?.plugins ?? []) {
    if (pluginIds.length > 0 && !pluginIds.includes(plugin.id)) {
      continue;
    }
    for (const manifest of plugin.mcpServers ?? []) {
      for (const server of manifest.servers ?? []) {
        servers.push({ pluginId: plugin.id, manifestPath: manifest.path, server });
      }
    }
  }
  if (serverNames.length > 0) {
    for (const serverName of serverNames) {
      const found = servers.some((entry) => entry.server.name === serverName);
      if (!found) {
        missing.push(`mcpServer:${serverName}`);
      }
    }
  }
  for (const pattern of commandPatterns) {
    const found = servers.some((entry) => toRegex(pattern).test(entry.server.command ?? ""));
    if (!found) {
      missing.push(`mcpCommand:${pattern}`);
    }
  }
  for (const arg of requiredArgs) {
    const found = servers.some((entry) => entry.server.args.includes(arg));
    if (!found) {
      missing.push(`mcpArg:${arg}`);
    }
  }
  for (const entry of servers) {
    if (
      (serverNames.length === 0 || serverNames.includes(entry.server.name)) &&
      matchPatternList(commandPatterns, entry.server.command ?? "") &&
      requiredArgs.every((arg) => entry.server.args.includes(arg))
    ) {
      matchedPaths.push(entry.manifestPath);
    }
  }
  return { missing, matchedPaths };
}

function bridgeAnchorState(anchor, bridgeMap) {
  const handlerNames = anchor.bridgeHandlers ?? [];
  if (handlerNames.length === 0) {
    return { missing: [], matchedPaths: [] };
  }
  const missing = handlerNames.filter((handlerName) => !bridgeMap?.handlers?.some((handler) => handler.name === handlerName));
  const matchedPaths = (bridgeMap?.handlers ?? [])
    .filter((handler) => handlerNames.length === 0 || handlerNames.includes(handler.name))
    .map((handler) => handler.path);
  return { missing: missing.map((handler) => `bridgeHandler:${handler}`), matchedPaths };
}

function nativeAnchorState(anchor, nativeBinaryMap) {
  const patterns = anchor.nativeBinaryPatterns ?? [];
  const binaries = nativeBinaryMap?.binaries ?? [];
  const missing = patterns.filter((pattern) => !binaries.some((binary) => toRegex(pattern).test(binary.relativePath)));
  return {
    missing: missing.map((pattern) => `nativeBinary:${pattern}`),
    matchedPaths: binaries.filter((binary) => matchAny(patterns, binary.relativePath)).map((binary) => binary.relativePath),
  };
}

function evaluateRequiredAnchor(inventory, anchor, context = {}) {
  const files = anchorFileMatches(inventory, anchor);
  const missingNeedles = [];
  const matchedNeedles = [];
  const matchedPathSet = new Set();
  for (const needle of anchor.contentNeedles ?? []) {
    const matchedFiles = files.filter((file) => file.text != null && includesNeedle(file.text, needle));
    if (matchedFiles.length === 0) {
      missingNeedles.push(needle);
    } else {
      matchedNeedles.push({
        needle,
        type: "content",
        paths: matchedFiles.map((file) => file.relativePath).sort().slice(0, 20),
      });
      for (const file of matchedFiles) matchedPathSet.add(file.relativePath);
    }
  }
  for (const needle of anchor.nativeStringNeedles ?? []) {
    const matchedFiles = files.filter(
      (file) => Array.isArray(file.nativeStrings) && file.nativeStrings.some((value) => includesNeedle(value, needle)),
    );
    if (matchedFiles.length === 0) {
      missingNeedles.push(needle);
    } else {
      matchedNeedles.push({
        needle,
        type: "nativeString",
        paths: matchedFiles.map((file) => file.relativePath).sort().slice(0, 20),
      });
      for (const file of matchedFiles) matchedPathSet.add(file.relativePath);
    }
  }
  const pluginState = pluginAnchorState(anchor, context.pluginMap);
  const mcpState = mcpAnchorState(anchor, context.pluginMap);
  const bridgeState = bridgeAnchorState(anchor, context.bridgeMap);
  const nativeState = nativeAnchorState(anchor, context.nativeBinaryMap);
  for (const matchedPath of [
    ...pluginState.matchedPaths,
    ...mcpState.matchedPaths,
    ...bridgeState.matchedPaths,
    ...nativeState.matchedPaths,
  ]) {
    matchedPathSet.add(matchedPath);
  }
  const requiredPathMatched = (anchor.pathPatterns ?? []).length === 0 || files.length > 0;
  if (requiredPathMatched && (anchor.pathPatterns ?? []).length > 0 && missingNeedles.length === 0) {
    for (const file of files) matchedPathSet.add(file.relativePath);
  }
  const structuralMissing = [
    ...pluginState.missing,
    ...mcpState.missing,
    ...bridgeState.missing,
    ...nativeState.missing,
  ];
  const satisfied = requiredPathMatched && missingNeedles.length === 0 && structuralMissing.length === 0;
  return {
    id: anchor.id,
    title: anchor.title ?? anchor.id,
    satisfied,
    matchedPaths: [...matchedPathSet].sort().slice(0, 50),
    matchedNeedles,
    missingNeedles: [...missingNeedles, ...structuralMissing],
    requiredPathMatched,
  };
}

function evaluateRequiredAnchors(inventory, surface, context = {}) {
  const anchors = surface.requiredEvidence ?? [];
  const evaluated = anchors.map((anchor) => evaluateRequiredAnchor(inventory, anchor, context));
  return {
    anchors: evaluated,
    satisfiedAnchors: evaluated.filter((anchor) => anchor.satisfied),
    missingAnchors: evaluated.filter((anchor) => !anchor.satisfied),
  };
}

function surfaceFingerprint(surfaceEvidence) {
  const hash = crypto.createHash("sha256");
  for (const item of surfaceEvidence) {
    hash.update(item.path);
    hash.update("\0");
    hash.update(item.sha256 ?? String(item.size));
    hash.update("\0");
    for (const hit of item.contentHits ?? []) {
      hash.update(String(hit.needle));
      hash.update("\0");
    }
    for (const hit of item.nativeHits ?? []) {
      hash.update(String(hit.needle));
      hash.update("\0");
      hash.update(String(hit.value));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function substrateStatus(surface, repoRoot) {
  const requiredPaths = surface.linuxSubstrate?.requiredPaths ?? [];
  if (requiredPaths.length === 0) {
    return {
      status: "UNKNOWN",
      missingPaths: [],
      requiredPaths,
    };
  }
  const missingPaths = requiredPaths.filter((candidatePath) => !fs.existsSync(path.join(repoRoot, candidatePath)));
  return {
    status: missingPaths.length === 0 ? "PRESENT" : "MISSING",
    missingPaths,
    requiredPaths,
  };
}

function extractProtectedSurfaces({ inventory, registry, repoRoot = process.cwd() } = {}) {
  const bridgeMap = createBridgeMap(inventory);
  const pluginMap = createPluginMap(inventory);
  const nativeBinaryMap = createNativeBinaryMap(inventory, registry);
  const postPatchIntegrity = findPostPatchIntegrityFindings(inventory);
  const surfaces = (registry.surfaces ?? []).map((surface) => {
    const evidence = fileEvidenceForSurface(inventory, surface).sort((a, b) => a.path.localeCompare(b.path));
    const anchors = evaluateRequiredAnchors(inventory, surface, { bridgeMap, pluginMap, nativeBinaryMap });
    const hasAnchorContract = (surface.requiredEvidence ?? []).length > 0;
    const status = hasAnchorContract
      ? anchors.missingAnchors.length === 0
        ? "PRESENT"
        : evidence.length > 0
          ? "PARTIAL"
          : "MISSING"
      : evidence.length > 0
        ? "PRESENT"
        : "MISSING";
    const confidence = status === "PRESENT" ? (hasAnchorContract ? "high" : "medium") : status === "PARTIAL" ? "low" : "none";
    return {
      id: surface.id,
      title: surface.title,
      category: surface.category,
      patchNamePatterns: surface.patchNamePatterns ?? [],
      status,
      confidence,
      evidence,
      evidenceCount: evidence.length,
      requiredAnchors: anchors.anchors,
      satisfiedAnchors: anchors.satisfiedAnchors,
      missingAnchors: anchors.missingAnchors,
      fingerprint: status === "PRESENT" ? surfaceFingerprint(evidence) : null,
      linuxSubstrate: substrateStatus(surface, repoRoot),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    source: inventory.source,
    registryVersion: registry.version ?? null,
    surfaces,
    surfacesById: Object.fromEntries(surfaces.map((surface) => [surface.id, surface])),
    bridgeMap,
    pluginMap,
    nativeBinaryMap,
    postPatchIntegrity,
  };
}

function createBridgeMap(inventory) {
  const handlerPattern = /\b(?:ipcMain|ipcRenderer|contextBridge)\.(?:handle|on|invoke|exposeInMainWorld)\(\s*(['"`])([^'"`]+)\1/g;
  const handlers = [];
  const channelCandidates = [];
  const seenCandidates = new Set();
  for (const file of inventory.files) {
    if (file.text == null) {
      continue;
    }
    for (const match of file.text.matchAll(handlerPattern)) {
      handlers.push({
        name: match[2],
        path: file.relativePath,
        kind: match[0].split("(")[0],
      });
    }
    for (const match of file.text.matchAll(STRING_LITERAL_PATTERN)) {
      const name = match[1] ?? match[2] ?? match[3] ?? "";
      if (!isBridgeChannelCandidate(name)) {
        continue;
      }
      const key = `${name}\0${file.relativePath}`;
      if (seenCandidates.has(key)) {
        continue;
      }
      seenCandidates.add(key);
      channelCandidates.push({
        name,
        path: file.relativePath,
        kind: "string-literal",
      });
    }
  }
  return {
    handlers: handlers.sort((a, b) => `${a.name}:${a.path}`.localeCompare(`${b.name}:${b.path}`)),
    channelCandidates: channelCandidates.sort((a, b) =>
      `${a.name}:${a.path}`.localeCompare(`${b.name}:${b.path}`),
    ),
  };
}

function isBridgeChannelCandidate(name) {
  return (
    (LOWER_BRIDGE_CHANNEL_PATTERN.test(name) || CAMEL_BRIDGE_CHANNEL_PATTERN.test(name)) &&
    BRIDGE_CHANNEL_TERM_PATTERN.test(name) &&
    !ASSET_EXTENSION_PATTERN.test(name) &&
    !/[-_.:]$/u.test(name)
  );
}

function pluginIdFromPath(relativePath) {
  const match = relativePath.match(/plugins\/openai-bundled\/plugins\/([^/]+)\//);
  return match?.[1] ?? null;
}

function createPluginMap(inventory) {
  const pluginsById = new Map();
  for (const file of inventory.files) {
    const pluginId = pluginIdFromPath(file.relativePath);
    if (pluginId == null) {
      continue;
    }
    const plugin = pluginsById.get(pluginId) ?? {
      id: pluginId,
      files: [],
      fileFingerprints: [],
      manifests: [],
      mcpServers: [],
      scripts: [],
      skills: [],
    };
    plugin.files.push(file.relativePath);
    plugin.fileFingerprints.push({
      path: file.relativePath,
      sha256: file.sha256 ?? null,
      size: file.size,
      mode: file.mode ?? null,
    });
    if (file.relativePath.endsWith(".codex-plugin/plugin.json") && file.text != null) {
      try {
        const manifest = JSON.parse(file.text);
        plugin.manifests.push({
          path: file.relativePath,
          id: manifest.id ?? manifest.name ?? pluginId,
          name: manifest.name ?? null,
          version: manifest.version ?? null,
          displayName: manifest.interface?.displayName ?? null,
          shortDescription: manifest.interface?.shortDescription ?? null,
          defaultPrompt: manifest.interface?.defaultPrompt ?? null,
          mcpServerKeys: Array.isArray(manifest.mcpServers)
            ? manifest.mcpServers.map((server) => server.name ?? server.id ?? null).filter(Boolean)
            : Object.keys(manifest.mcpServers ?? {}),
          skillCount: Array.isArray(manifest.skills) ? manifest.skills.length : 0,
        });
      } catch (error) {
        plugin.manifests.push({ path: file.relativePath, parseError: error.message });
      }
    }
    if (file.relativePath.endsWith(".mcp.json") && file.text != null) {
      try {
        const manifest = JSON.parse(file.text);
        plugin.mcpServers.push({
          path: file.relativePath,
          servers: Object.entries(manifest.mcpServers ?? {}).map(([name, server]) => ({
            name,
            command: server.command ?? null,
            args: Array.isArray(server.args) ? server.args : [],
            envKeys: Object.keys(server.env ?? {}),
            tools: Array.isArray(server.tools)
              ? server.tools.map((tool) => (typeof tool === "string" ? tool : tool.name)).filter(Boolean)
              : [],
          })),
        });
      } catch (error) {
        plugin.mcpServers.push({ path: file.relativePath, parseError: error.message });
      }
    }
    if (/\/scripts\/[^/]+\.(mjs|js|cjs)$/i.test(file.relativePath) || /\/browser-client\.mjs$/i.test(file.relativePath)) {
      plugin.scripts.push(file.relativePath);
    }
    if (/\/skills\/[^/]+\/SKILL\.md$/i.test(file.relativePath)) {
      plugin.skills.push(file.relativePath);
    }
    pluginsById.set(pluginId, plugin);
  }
  return {
    plugins: [...pluginsById.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function nativeProtectedStringHits(file, registry) {
  const strings = Array.isArray(file.nativeStrings) ? file.nativeStrings : [];
  const needles = [
    ...new Set(
      (registry?.surfaces ?? []).flatMap((surface) => [
        ...(surface.nativeStringNeedles ?? []),
        ...(surface.contentNeedles ?? []),
      ]),
    ),
  ];
  return needles
    .flatMap((needle) => {
      const value = strings.find((candidate) => includesNeedle(candidate, needle));
      return value == null ? [] : [{ needle, value }];
    })
    .slice(0, 200);
}

function runBoundedToolLines(command, args, maxLines = 200) {
  const commandPath = commandOnPath(command);
  if (commandPath == null) {
    return null;
  }
  const result = spawnSync(commandPath, args, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return null;
  }
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(0, maxLines);
}

function nativeSymbolInventory(file) {
  if (file.absolutePath == null) {
    return null;
  }
  const llvmSymbols = runBoundedToolLines("llvm-nm", ["-g", file.absolutePath]);
  if (llvmSymbols != null) {
    return { tool: "llvm-nm -g", symbols: llvmSymbols };
  }
  const nmSymbols = runBoundedToolLines("nm", ["-g", file.absolutePath]);
  if (nmSymbols != null) {
    return { tool: "nm -g", symbols: nmSymbols };
  }
  return null;
}

function nativeLinkedLibraries(file) {
  if (file.absolutePath == null) {
    return null;
  }
  const otoolLibraries = runBoundedToolLines("otool", ["-L", file.absolutePath]);
  if (otoolLibraries != null) {
    return { tool: "otool -L", libraries: otoolLibraries };
  }
  return null;
}

function createNativeBinaryMap(inventory, registry = null) {
  const binaries = inventory.files
    .filter((file) => file.type === "native")
    .map((file) => ({
      relativePath: file.relativePath,
      sha256: file.sha256 ?? null,
      size: file.size,
      fileCommand: file.fileCommand ?? null,
      protectedStringHits: nativeProtectedStringHits(file, registry),
      symbols: nativeSymbolInventory(file),
      linkedLibraries: nativeLinkedLibraries(file),
    }));
  return { binaries };
}

const LINUX_SETTINGS_PATCH_SYMBOL_PATTERN = /\bcodexLinux[A-Za-z0-9_$]*SettingsIcon\b/g;

function segmentDeclaresSymbol(segment, symbol) {
  const escaped = escapeRegExp(symbol);
  return new RegExp(`^\\s*${escaped}(?![A-Za-z0-9_$])`).test(segment);
}

function hasVariableDeclarator(source, symbol) {
  const keywordPattern = /\b(?:var|let|const)\b/g;
  let match;
  while ((match = keywordPattern.exec(source)) != null) {
    let segmentStart = keywordPattern.lastIndex;
    let depth = 0;
    let quote = null;
    let escaped = false;
    let terminated = false;
    for (let index = segmentStart; index < source.length; index += 1) {
      const char = source[index];
      if (quote != null) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(" || char === "[" || char === "{") {
        depth += 1;
        continue;
      }
      if (char === ")" || char === "]" || char === "}") {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0 && (char === "," || char === ";")) {
        if (segmentDeclaresSymbol(source.slice(segmentStart, index), symbol)) {
          return true;
        }
        if (char === ";") {
          terminated = true;
          break;
        }
        segmentStart = index + 1;
      }
    }
    if (!terminated && segmentDeclaresSymbol(source.slice(segmentStart), symbol)) {
      return true;
    }
  }
  return false;
}

function hasLocalPatchSymbolDeclaration(source, symbol) {
  const escaped = escapeRegExp(symbol);
  return (
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`).test(source) ||
    hasVariableDeclarator(source, symbol)
  );
}

function findPostPatchIntegrityFindings(inventory) {
  const findings = [];
  for (const file of inventory.files) {
    if (file.text == null) {
      continue;
    }
    const symbols = [...new Set(file.text.match(LINUX_SETTINGS_PATCH_SYMBOL_PATTERN) ?? [])];
    for (const symbol of symbols) {
      if (hasLocalPatchSymbolDeclaration(file.text, symbol)) {
        continue;
      }
      findings.push({
        path: file.relativePath,
        reason: "Linux settings patch symbol is referenced without a local declaration",
        snippet: textSnippet(file.text, symbol),
        symbol,
      });
    }
  }
  return findings.sort((a, b) => `${a.symbol}:${a.path}`.localeCompare(`${b.symbol}:${b.path}`));
}

function classifySurfaceDrift({ baselineSurface, candidateSurface }) {
  const baselinePresent = baselineSurface?.status === "PRESENT";
  const candidatePresent = candidateSurface?.status === "PRESENT";
  if (baselinePresent && candidatePresent) {
    const baselinePaths = new Set(baselineSurface.evidence.map((entry) => entry.path));
    const candidatePaths = new Set(candidateSurface.evidence.map((entry) => entry.path));
    const samePaths =
      baselinePaths.size === candidatePaths.size &&
      [...baselinePaths].every((entryPath) => candidatePaths.has(entryPath));
    if (samePaths && baselineSurface.fingerprint === candidateSurface.fingerprint) {
      return ["UNCHANGED"];
    }
    if (!samePaths) {
      return ["MOVED"];
    }
    return ["PAYLOAD_CHANGED"];
  }
  if (baselinePresent && !candidatePresent) {
    return ["REMOVED"];
  }
  if (!baselinePresent && candidatePresent) {
    return ["NEW_UPSTREAM_CAPABILITY"];
  }
  return ["UNCHANGED"];
}

function patchFindingsBySurface(patchReport, surfacesById = {}) {
  const map = new Map();
  const surfaces = Object.values(surfacesById);
  for (const patch of patchReport?.patches ?? []) {
    if (SUCCESSFUL_PATCH_STATUSES.has(patch.status)) {
      continue;
    }
    const classification = BLOCKING_PATCH_STATUSES.has(patch.status) ? "PATCH_BROKEN" : "PATCH_REVIEW";
    const explicitSurfaceId = patch.surfaceId ?? patch.protectedSurfaceId ?? null;
    const matchedSurfaceIds = new Set();
    if (explicitSurfaceId != null) {
      matchedSurfaceIds.add(explicitSurfaceId);
    }
    const patchText = [patch.name, patch.reason, patch.featureId].filter(Boolean).join(" ");
    for (const surface of surfaces) {
      if (matchAny(surface.patchNamePatterns, patchText)) {
        matchedSurfaceIds.add(surface.id);
      }
    }
    if (matchedSurfaceIds.size === 0) {
      continue;
    }
    for (const surfaceId of matchedSurfaceIds) {
      const list = map.get(surfaceId) ?? [];
      list.push({
        classification,
        name: patch.name,
        reviewOnly: classification === "PATCH_REVIEW",
        status: patch.status,
        reason: patch.reason ?? null,
      });
      map.set(surfaceId, list);
    }
  }
  return map;
}

function postPatchIntegrityFindingsFromReport(patchReport) {
  const findings = patchReport?.postPatchIntegrity?.findings ?? patchReport?.postPatchIntegrity ?? [];
  return Array.isArray(findings) ? findings : [];
}

function mergedPostPatchIntegrityFindings(...findingGroups) {
  const merged = new Map();
  for (const finding of findingGroups.flat()) {
    if (finding == null || typeof finding !== "object") {
      continue;
    }
    const symbol = finding.symbol ?? "unknown-symbol";
    const pathKey = finding.path ?? "unknown-path";
    const reason = finding.reason ?? "Linux settings patch symbol is referenced without a local declaration";
    const key = `${symbol}\0${pathKey}\0${finding.snippet ?? ""}`;
    merged.set(key, {
      path: pathKey,
      reason,
      snippet: finding.snippet ?? null,
      symbol,
    });
  }
  return [...merged.values()].sort((a, b) => `${a.symbol}:${a.path}`.localeCompare(`${b.symbol}:${b.path}`));
}

function compareProtectedSurfaces({ baseline, candidate, patchReport = null } = {}) {
  const hasBaseline = baseline != null;
  const patchFindings = patchFindingsBySurface(patchReport, {
    ...(baseline?.surfacesById ?? {}),
    ...(candidate?.surfacesById ?? {}),
  });
  const surfaceIds = new Set([
    ...Object.keys(baseline?.surfacesById ?? {}),
    ...Object.keys(candidate?.surfacesById ?? {}),
  ]);
  const surfaceDrift = [];
  for (const surfaceId of [...surfaceIds].sort()) {
    const baselineSurface = baseline?.surfacesById?.[surfaceId];
    const candidateSurface = candidate?.surfacesById?.[surfaceId];
    const classifications = hasBaseline ? classifySurfaceDrift({ baselineSurface, candidateSurface }) : [];
    if (candidateSurface?.status === "PARTIAL") {
      classifications.push("PROTECTED_SURFACE_PARTIAL");
    } else if (candidateSurface?.status === "MISSING") {
      classifications.push("PROTECTED_SURFACE_MISSING");
    }
    const evidenceDrift = compareEvidence(baselineSurface?.evidence ?? [], candidateSurface?.evidence ?? []);
    for (const classification of classifications) {
      surfaceDrift.push({
        surfaceId,
        title: candidateSurface?.title ?? baselineSurface?.title ?? surfaceId,
        category: candidateSurface?.category ?? baselineSurface?.category ?? "unknown",
        classification,
        baselineStatus: baselineSurface?.status ?? "MISSING",
        candidateStatus: candidateSurface?.status ?? "MISSING",
        evidenceSummary: {
          baseline: summarizeEvidenceState(baselineSurface?.evidence ?? []),
          candidate: summarizeEvidenceState(candidateSurface?.evidence ?? []),
        },
        evidenceDrift: summarizeEvidenceDrift(evidenceDrift),
        missingAnchors: summarizeAnchors(candidateSurface?.missingAnchors ?? []),
      });
    }
    if ((candidateSurface?.status === "PRESENT") && candidateSurface.linuxSubstrate?.status === "MISSING") {
      surfaceDrift.push({
        surfaceId,
        title: candidateSurface.title,
        category: candidateSurface.category,
        classification: "LINUX_SUBSTRATE_GAP",
        missingPaths: candidateSurface.linuxSubstrate.missingPaths,
      });
    }
    if (patchFindings.has(surfaceId)) {
      const findingsByClassification = new Map();
      for (const finding of patchFindings.get(surfaceId)) {
        const list = findingsByClassification.get(finding.classification) ?? [];
        list.push(finding);
        findingsByClassification.set(finding.classification, list);
      }
      for (const [classification, patches] of findingsByClassification) {
        surfaceDrift.push({
          surfaceId,
          title: candidateSurface?.title ?? baselineSurface?.title ?? surfaceId,
          category: candidateSurface?.category ?? baselineSurface?.category ?? "unknown",
          classification,
          patches,
        });
      }
    }
  }
  const postPatchIntegrity = mergedPostPatchIntegrityFindings(
    candidate?.postPatchIntegrity ?? [],
    postPatchIntegrityFindingsFromReport(patchReport),
  );
  if (postPatchIntegrity.length > 0) {
    surfaceDrift.push({
      surfaceId: "linux_patch_integrity",
      title: "Linux post-patch JavaScript integrity",
      category: "patch-integrity",
      classification: "PATCH_INTEGRITY_BROKEN",
      findingCount: postPatchIntegrity.length,
      findings: postPatchIntegrity.slice(0, 20),
      omittedFindingCount: Math.max(0, postPatchIntegrity.length - 20),
    });
  }

  const classificationCounts = {};
  for (const item of surfaceDrift) {
    classificationCounts[item.classification] = (classificationCounts[item.classification] ?? 0) + 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    baselineSource: baseline?.source ?? null,
    candidateSource: candidate?.source ?? null,
    classificationCounts,
    surfaceDrift,
  };
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => {
    if (entryValue == null) {
      return false;
    }
    if (Array.isArray(entryValue) && entryValue.length === 0) {
      return false;
    }
    return true;
  }));
}

function summarizeEvidenceEntry(entry, { includeNeedles = true } = {}) {
  return compactObject({
    path: entry.path,
    sha256: entry.sha256 ?? null,
    size: entry.size,
    source: entry.source,
    type: entry.type,
    contentNeedles: includeNeedles ? (entry.contentHits ?? []).map((hit) => hit.needle) : [],
    nativeNeedles: includeNeedles ? (entry.nativeHits ?? []).map((hit) => hit.needle) : [],
  });
}

function summarizeEvidenceList(evidence, maxItems = DRIFT_PATH_SAMPLE_LIMIT, options = {}) {
  return evidence.slice(0, maxItems).map((entry) => summarizeEvidenceEntry(entry, options));
}

function summarizeEvidenceState(evidence, maxItems = DRIFT_PATH_SAMPLE_LIMIT) {
  return {
    evidenceCount: evidence.length,
    pathSamples: summarizeEvidenceList(evidence, maxItems, { includeNeedles: false }),
    omittedPathCount: Math.max(0, evidence.length - maxItems),
  };
}

function summarizeChangedEvidence(entry) {
  return compactObject({
    path: entry.candidate.path === entry.baseline.path ? entry.candidate.path : undefined,
    baselinePath: entry.candidate.path === entry.baseline.path ? undefined : entry.baseline.path,
    candidatePath: entry.candidate.path === entry.baseline.path ? undefined : entry.candidate.path,
    baselineSha256: entry.baseline.sha256 ?? null,
    candidateSha256: entry.candidate.sha256 ?? null,
    baselineSize: entry.baseline.size,
    candidateSize: entry.candidate.size,
    source: entry.candidate.source ?? entry.baseline.source,
    type: entry.candidate.type ?? entry.baseline.type,
  });
}

function normalizedHashedAssetPath(entryPath) {
  const normalized = normalizePath(entryPath);
  const directory = path.posix.dirname(normalized);
  const basename = path.posix.basename(normalized);
  const match = basename.match(/^(.+)-[A-Za-z0-9_-]{6,}(\.[A-Za-z0-9.]+)$/);
  if (match == null) {
    return null;
  }
  const normalizedBasename = `${match[1]}-<hash>${match[2]}`;
  return directory === "." ? normalizedBasename : `${directory}/${normalizedBasename}`;
}

function classifyPathMovement(evidenceDrift) {
  if (evidenceDrift.addedEvidence.length === 0 && evidenceDrift.removedEvidence.length === 0) {
    return "none";
  }
  const addedKeys = evidenceDrift.addedEvidence.map((entry) => normalizedHashedAssetPath(entry.path));
  const removedKeys = evidenceDrift.removedEvidence.map((entry) => normalizedHashedAssetPath(entry.path));
  const allMovedPathsAreHashedAssets =
    addedKeys.length > 0 &&
    removedKeys.length > 0 &&
    addedKeys.every(Boolean) &&
    removedKeys.every(Boolean);
  if (!allMovedPathsAreHashedAssets) {
    return "protected_path_changed";
  }
  const addedSet = keyedSet(addedKeys);
  const removedSet = keyedSet(removedKeys);
  const sameNormalizedAssets =
    addedSet.size === removedSet.size && [...addedSet].every((entryPath) => removedSet.has(entryPath));
  return sameNormalizedAssets ? "hashed_asset_churn" : "mixed_hashed_asset_churn";
}

function summarizeEvidenceDrift(evidenceDrift) {
  return {
    pathMovementKind: classifyPathMovement(evidenceDrift),
    addedPathSamples: summarizeEvidenceList(evidenceDrift.addedEvidence, DRIFT_PATH_SAMPLE_LIMIT, { includeNeedles: false }),
    removedPathSamples: summarizeEvidenceList(evidenceDrift.removedEvidence, DRIFT_PATH_SAMPLE_LIMIT, { includeNeedles: false }),
    changedPathSamples: evidenceDrift.changedEvidence.slice(0, DRIFT_CHANGED_SAMPLE_LIMIT).map(summarizeChangedEvidence),
    unchangedEvidenceCount: evidenceDrift.unchangedEvidence.length,
    addedEvidenceCount: evidenceDrift.addedEvidence.length,
    removedEvidenceCount: evidenceDrift.removedEvidence.length,
    changedEvidenceCount: evidenceDrift.changedEvidence.length,
    omittedAddedPathCount: Math.max(0, evidenceDrift.addedEvidence.length - DRIFT_PATH_SAMPLE_LIMIT),
    omittedRemovedPathCount: Math.max(0, evidenceDrift.removedEvidence.length - DRIFT_PATH_SAMPLE_LIMIT),
    omittedChangedPathCount: Math.max(0, evidenceDrift.changedEvidence.length - DRIFT_CHANGED_SAMPLE_LIMIT),
  };
}

function summarizeAnchors(anchors) {
  return anchors.map((anchor) => ({
    id: anchor.id,
    title: anchor.title,
    missingNeedles: anchor.missingNeedles ?? [],
    matchedPaths: (anchor.matchedPaths ?? []).slice(0, 20),
    matchedPathCount: (anchor.matchedPaths ?? []).length,
  }));
}

function keyedSet(values) {
  return new Set(values.filter(Boolean).sort());
}

function diffSets(baselineValues, candidateValues) {
  const baselineSet = keyedSet(baselineValues);
  const candidateSet = keyedSet(candidateValues);
  return {
    added: [...candidateSet].filter((value) => !baselineSet.has(value)),
    removed: [...baselineSet].filter((value) => !candidateSet.has(value)),
    unchanged: [...candidateSet].filter((value) => baselineSet.has(value)),
  };
}

function compareEvidence(baselineEvidence, candidateEvidence) {
  const baselineByPath = new Map(baselineEvidence.map((entry) => [entry.path, entry]));
  const candidateByPath = new Map(candidateEvidence.map((entry) => [entry.path, entry]));
  const addedEvidence = [];
  const removedEvidence = [];
  const changedEvidence = [];
  const unchangedEvidence = [];
  for (const [entryPath, candidateEntry] of candidateByPath) {
    const baselineEntry = baselineByPath.get(entryPath);
    if (baselineEntry == null) {
      addedEvidence.push(candidateEntry);
    } else if ((baselineEntry.sha256 ?? baselineEntry.size) !== (candidateEntry.sha256 ?? candidateEntry.size)) {
      changedEvidence.push({ baseline: baselineEntry, candidate: candidateEntry });
    } else {
      unchangedEvidence.push(candidateEntry);
    }
  }
  for (const [entryPath, baselineEntry] of baselineByPath) {
    if (!candidateByPath.has(entryPath)) {
      removedEvidence.push(baselineEntry);
    }
  }
  return { addedEvidence, removedEvidence, changedEvidence, unchangedEvidence };
}

function bridgeHandlerKeys(map) {
  return (map?.handlers ?? []).map((handler) => `${handler.kind}:${handler.name}:${handler.path}`);
}

function pluginIds(map) {
  return (map?.plugins ?? []).map((plugin) => plugin.id);
}

function pluginById(map) {
  return new Map((map?.plugins ?? []).map((plugin) => [plugin.id, plugin]));
}

function mcpToolKeys(pluginMap) {
  const keys = [];
  for (const plugin of pluginMap?.plugins ?? []) {
    for (const mcpManifest of plugin.mcpServers ?? []) {
      for (const server of mcpManifest.servers ?? []) {
        for (const tool of server.tools ?? []) {
          keys.push(`${plugin.id}:${server.name}:${tool}`);
        }
      }
    }
  }
  return keys;
}

function nativeBinaryByPath(map) {
  return new Map((map?.binaries ?? []).map((binary) => [binary.relativePath, binary]));
}

function compareMaps({ baselineProtected, candidateProtected }) {
  if (baselineProtected == null) {
    return {
      mode: "inventoryOnly",
      bridgeHandlerDrift: diffSets([], bridgeHandlerKeys(candidateProtected.bridgeMap)),
      pluginDrift: diffSets([], pluginIds(candidateProtected.pluginMap)),
      mcpDrift: diffSets([], mcpToolKeys(candidateProtected.pluginMap)),
      nativeBinaryDrift: diffSets([], (candidateProtected.nativeBinaryMap?.binaries ?? []).map((binary) => binary.relativePath)),
    };
  }

  const baselinePlugins = pluginById(baselineProtected.pluginMap);
  const candidatePlugins = pluginById(candidateProtected.pluginMap);
  const pluginFileDrift = {};
  for (const pluginId of new Set([...baselinePlugins.keys(), ...candidatePlugins.keys()])) {
    pluginFileDrift[pluginId] = diffSets(
      baselinePlugins.get(pluginId)?.files ?? [],
      candidatePlugins.get(pluginId)?.files ?? [],
    );
  }

  const baselineNative = nativeBinaryByPath(baselineProtected.nativeBinaryMap);
  const candidateNative = nativeBinaryByPath(candidateProtected.nativeBinaryMap);
  const changedNative = [];
  for (const [binaryPath, candidateBinary] of candidateNative) {
    const baselineBinary = baselineNative.get(binaryPath);
    if (baselineBinary != null && baselineBinary.sha256 !== candidateBinary.sha256) {
      changedNative.push({ path: binaryPath, baselineSha256: baselineBinary.sha256, candidateSha256: candidateBinary.sha256 });
    }
  }

  return {
    mode: "baselineComparison",
    bridgeHandlerDrift: diffSets(
      bridgeHandlerKeys(baselineProtected.bridgeMap),
      bridgeHandlerKeys(candidateProtected.bridgeMap),
    ),
    pluginDrift: diffSets(pluginIds(baselineProtected.pluginMap), pluginIds(candidateProtected.pluginMap)),
    pluginFileDrift,
    mcpDrift: diffSets(mcpToolKeys(baselineProtected.pluginMap), mcpToolKeys(candidateProtected.pluginMap)),
    nativeBinaryDrift: {
      ...diffSets([...baselineNative.keys()], [...candidateNative.keys()]),
      changed: changedNative,
    },
    linuxSubstrateDrift: diffSets(
      baselineProtected.surfaces.filter((surface) => surface.linuxSubstrate.status === "MISSING").map((surface) => surface.id),
      candidateProtected.surfaces.filter((surface) => surface.linuxSubstrate.status === "MISSING").map((surface) => surface.id),
    ),
  };
}

function countDiffValues(diff) {
  return {
    addedCount: diff?.added?.length ?? 0,
    removedCount: diff?.removed?.length ?? 0,
    unchangedCount: diff?.unchanged?.length ?? 0,
  };
}

function summarizeMapDrift(mapDrift) {
  const pluginFileChanged = Object.entries(mapDrift?.pluginFileDrift ?? {}).filter(([, drift]) =>
    (drift.added?.length ?? 0) > 0 || (drift.removed?.length ?? 0) > 0,
  );
  const summary = {
    mode: mapDrift?.mode ?? "unknown",
    bridgeHandlers: countDiffValues(mapDrift?.bridgeHandlerDrift),
    plugins: countDiffValues(mapDrift?.pluginDrift),
    mcpTools: countDiffValues(mapDrift?.mcpDrift),
    nativeBinaries: {
      ...countDiffValues(mapDrift?.nativeBinaryDrift),
      changedCount: mapDrift?.nativeBinaryDrift?.changed?.length ?? 0,
    },
    linuxSubstrate: countDiffValues(mapDrift?.linuxSubstrateDrift),
    pluginFileSetsChangedCount: pluginFileChanged.length,
  };
  summary.hasStructuralAddRemove =
    summary.bridgeHandlers.addedCount > 0 ||
    summary.bridgeHandlers.removedCount > 0 ||
    summary.plugins.addedCount > 0 ||
    summary.plugins.removedCount > 0 ||
    summary.mcpTools.addedCount > 0 ||
    summary.mcpTools.removedCount > 0 ||
    summary.nativeBinaries.addedCount > 0 ||
    summary.nativeBinaries.removedCount > 0 ||
    summary.linuxSubstrate.addedCount > 0 ||
    summary.linuxSubstrate.removedCount > 0;
  return summary;
}

function markdownList(items) {
  if (items.length === 0) {
    return "- None\n";
  }
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

function renderDriftMarkdown(report) {
  const lines = ["# Upstream DMG Drift Report", ""];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Candidate: ${report.candidateSource?.path ?? "unknown"}`);
  if (report.baselineSource != null) {
    lines.push(`Baseline: ${report.baselineSource.path}`);
  }
  lines.push("");
  lines.push("## Classification Counts");
  lines.push("");
  lines.push(
    markdownList(
      Object.entries(report.classificationCounts).map(([classification, count]) => `${classification}: ${count}`),
    ).trimEnd(),
  );
  lines.push("");
  lines.push("## Protected Surface Drift");
  lines.push("");
  for (const item of report.surfaceDrift) {
    lines.push(`### ${item.surfaceId} - ${item.classification}`);
    if (item.title) {
      lines.push(`Surface: ${item.title}`);
    }
    if (item.baselineStatus || item.candidateStatus) {
      lines.push(`Status: ${item.baselineStatus ?? "n/a"} -> ${item.candidateStatus ?? "n/a"}`);
    }
    if (item.evidenceDrift != null) {
      lines.push(
        `Evidence drift: +${item.evidenceDrift.addedEvidenceCount ?? 0} / -${item.evidenceDrift.removedEvidenceCount ?? 0} / changed ${item.evidenceDrift.changedEvidenceCount ?? 0} / unchanged ${item.evidenceDrift.unchangedEvidenceCount ?? 0}`,
      );
      if (item.evidenceDrift.pathMovementKind && item.evidenceDrift.pathMovementKind !== "none") {
        lines.push(`Path movement: ${item.evidenceDrift.pathMovementKind}`);
      }
    }
    const candidatePaths = [...new Set((item.evidenceSummary?.candidate?.pathSamples ?? []).map((entry) => entry.path))]
      .slice(0, MARKDOWN_PATH_SAMPLE_LIMIT);
    const baselinePaths = [...new Set((item.evidenceSummary?.baseline?.pathSamples ?? []).map((entry) => entry.path))]
      .slice(0, MARKDOWN_PATH_SAMPLE_LIMIT);
    if (baselinePaths.length > 0) {
      lines.push(`Baseline paths: ${baselinePaths.join(", ")}`);
    }
    if (candidatePaths.length > 0) {
      lines.push(`Candidate paths: ${candidatePaths.join(", ")}`);
    }
    if (item.missingPaths?.length > 0) {
      lines.push(`Missing Linux substrate paths: ${item.missingPaths.join(", ")}`);
    }
    if (item.missingAnchors?.length > 0) {
      lines.push(`Missing required anchors: ${item.missingAnchors.map((anchor) => anchor.id).join(", ")}`);
    }
    if (item.patches?.length > 0) {
      lines.push(`Patch failures: ${item.patches.map((patch) => `${patch.name} (${patch.status})`).join(", ")}`);
    }
    if (item.evidenceDrift?.changedPathSamples?.length > 0) {
      const changedPaths = item.evidenceDrift.changedPathSamples
        .slice(0, MARKDOWN_PATH_SAMPLE_LIMIT)
        .map((entry) => `${entry.path ?? `${entry.baselinePath} -> ${entry.candidatePath}`}: ${formatHash(entry.baselineSha256)} -> ${formatHash(entry.candidateSha256)}`);
      lines.push(`Changed payload samples: ${changedPaths.join("; ")}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

function structuralSummaryLine(summary) {
  if (summary == null) {
    return null;
  }
  return [
    `bridge +/- ${summary.bridgeHandlers.addedCount}/${summary.bridgeHandlers.removedCount}`,
    `plugin +/- ${summary.plugins.addedCount}/${summary.plugins.removedCount}`,
    `MCP +/- ${summary.mcpTools.addedCount}/${summary.mcpTools.removedCount}`,
    `native +/- ${summary.nativeBinaries.addedCount}/${summary.nativeBinaries.removedCount}`,
    `native changed ${summary.nativeBinaries.changedCount}`,
  ].join("; ");
}

function formatHash(value) {
  if (value == null) {
    return "nohash";
  }
  return `${String(value).slice(0, 12)}...`;
}

function evidencePathList(entries, maxItems = ACTION_PLAN_PATH_SAMPLE_LIMIT) {
  return entries
    .slice(0, maxItems)
    .map((entry) => `${entry.path} (${formatHash(entry.sha256)})`)
    .join(", ");
}

function changedPayloadList(entries, maxItems = ACTION_PLAN_PATH_SAMPLE_LIMIT) {
  return entries
    .slice(0, maxItems)
    .map((entry) => `- ${entry.path ?? `${entry.baselinePath} -> ${entry.candidatePath}`}: ${formatHash(entry.baselineSha256)} -> ${formatHash(entry.candidateSha256)}`)
    .join("\n");
}

function renderActionPlanMarkdown(driftReport, candidateProtected, mapDrift = null) {
  const actionable = driftReport.surfaceDrift.filter((item) => ACTIONABLE_CLASSIFICATIONS.has(item.classification));
  const structuralSummary = driftReport.structuralDriftSummary ?? summarizeMapDrift(mapDrift);
  const lines = ["# Linux Substrate Action Plan", ""];
  lines.push(`Candidate: ${candidateProtected.source?.path ?? "unknown"}`);
  const summaryLine = structuralSummaryLine(structuralSummary);
  if (summaryLine != null) {
    lines.push(`Structural maps: ${summaryLine}`);
  }
  lines.push("");
  if (actionable.length === 0) {
    lines.push("No protected-surface action required by this report.");
    return `${lines.join("\n")}\n`;
  }
  for (const item of actionable) {
    lines.push(`## ${item.surfaceId}`);
    lines.push(`Classification: ${item.classification}`);
    if (item.evidenceDrift != null) {
      lines.push(
        `Evidence: +${item.evidenceDrift.addedEvidenceCount ?? 0} / -${item.evidenceDrift.removedEvidenceCount ?? 0} / changed ${item.evidenceDrift.changedEvidenceCount ?? 0}; movement ${item.evidenceDrift.pathMovementKind ?? "unknown"}`,
      );
    }
    if (item.classification === "MOVED") {
      const structuralHint =
        structuralSummary?.hasStructuralAddRemove === false
          ? " Structural bridge/plugin/MCP/native paths did not add or disappear."
          : "";
      lines.push(`Action: review candidate evidence paths before changing Linux substrate.${structuralHint} Treat this as a navigation signal unless a Linux patch, staging rule, or mirror references one of the old paths.`);
      if (item.evidenceDrift?.removedPathSamples?.length > 0) {
        lines.push(`Removed path samples: ${evidencePathList(item.evidenceDrift.removedPathSamples)}`);
      }
      if (item.evidenceDrift?.addedPathSamples?.length > 0) {
        lines.push(`Added path samples: ${evidencePathList(item.evidenceDrift.addedPathSamples)}`);
      }
    } else if (item.classification === "PAYLOAD_CHANGED") {
      lines.push("Action: review payload diffs, refresh protected needles, and run the owning Linux feature/backend tests.");
      if (item.evidenceDrift?.changedPathSamples?.length > 0) {
        lines.push("Changed payload files:");
        lines.push(changedPayloadList(item.evidenceDrift.changedPathSamples, 8));
      }
    } else if (item.classification === "REMOVED") {
      lines.push("Action: verify whether upstream intentionally removed this surface before deleting Linux compatibility code.");
    } else if (item.classification === "NEW_UPSTREAM_CAPABILITY") {
      lines.push("Action: decide whether Linux needs a port, shim, explicit unsupported gate, or new optional feature.");
    } else if (item.classification === "PATCH_BROKEN") {
      lines.push("Action: repair the patch descriptor or feature patch before accepting the DMG.");
    } else if (item.classification === "PATCH_REVIEW") {
      lines.push("Action: review optional patch warning/skip details; do not block DMG acceptance unless a protected surface is also missing or broken.");
    } else if (item.classification === "LINUX_SUBSTRATE_GAP") {
      lines.push("Action: add or map the missing Linux substrate path before claiming parity.");
      lines.push(`Missing paths: ${(item.missingPaths ?? []).join(", ")}`);
    } else if (item.classification === "PROTECTED_SURFACE_PARTIAL") {
      lines.push("Action: inspect the missing required anchors and decide whether the registry, upstream map, or Linux substrate needs updating.");
      lines.push(`Missing anchors: ${(item.missingAnchors ?? []).map((anchor) => anchor.id).join(", ")}`);
    } else if (item.classification === "PROTECTED_SURFACE_MISSING") {
      lines.push("Action: locate the upstream replacement surface or explicitly retire the Linux mirror before accepting the DMG.");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function publicInventory(inventory) {
  return {
    ...inventory,
    files: inventory.files.map((file) => {
      const publicFile = { ...file };
      delete publicFile.absolutePath;
      delete publicFile.buffer;
      delete publicFile.text;
      delete publicFile.nativeStrings;
      return publicFile;
    }),
  };
}

function sameResolvedPath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function resolveBaselinePath({ autoBaseline = false, baselinePath = null, candidatePath, repoRoot = process.cwd() } = {}) {
  if (baselinePath != null || !autoBaseline) {
    return baselinePath;
  }
  const defaultBaselinePath = path.join(repoRoot, "Codex.dmg");
  if (!fs.existsSync(defaultBaselinePath)) {
    return null;
  }
  if (candidatePath != null && sameResolvedPath(defaultBaselinePath, candidatePath)) {
    return null;
  }
  return defaultBaselinePath;
}

function buildIntelReports({
  autoBaseline = false,
  baselinePath = null,
  candidatePath,
  outputDir,
  patchReportPath = null,
  registry,
  repoRoot = process.cwd(),
  timestamp = null,
} = {}) {
  if (candidatePath == null) {
    throw new Error("candidatePath is required");
  }
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-upstream-intel-report-"));
  try {
    const resolvedBaselinePath = resolveBaselinePath({
      autoBaseline,
      baselinePath,
      candidatePath,
      repoRoot,
    });
    const reportDir =
      outputDir ??
      path.join(
        repoRoot,
        "reports/upstream-dmg",
        timestamp ?? new Date().toISOString().replace(/[:.]/g, "-"),
      );
    const candidateInventory = createInventory({
      registry,
      sourcePath: candidatePath,
      workDir: path.join(scratchRoot, "candidate"),
    });
    const candidateProtected = extractProtectedSurfaces({ inventory: candidateInventory, registry, repoRoot });
    const baselineInventory =
      resolvedBaselinePath == null
        ? null
        : createInventory({
            registry,
            sourcePath: resolvedBaselinePath,
            workDir: path.join(scratchRoot, "baseline"),
          });
    const baselineProtected =
      resolvedBaselinePath == null
        ? null
        : extractProtectedSurfaces({
            inventory: baselineInventory,
            registry,
            repoRoot,
          });
    const patchReport =
      patchReportPath != null && fs.existsSync(patchReportPath) ? readJson(patchReportPath) : null;
    const driftReport = compareProtectedSurfaces({
      baseline: baselineProtected,
      candidate: candidateProtected,
      patchReport,
    });
    const mapDrift = compareMaps({ baselineProtected, candidateProtected });
    driftReport.structuralDriftSummary = summarizeMapDrift(mapDrift);

    fs.mkdirSync(reportDir, { recursive: true });
    writeJson(path.join(reportDir, "inventory.json"), publicInventory(candidateInventory));
    writeJson(path.join(reportDir, "protected-surfaces.json"), candidateProtected);
    writeJson(path.join(reportDir, "bridge-map.json"), candidateProtected.bridgeMap);
    writeJson(path.join(reportDir, "plugin-map.json"), candidateProtected.pluginMap);
    writeJson(path.join(reportDir, "native-binary-map.json"), candidateProtected.nativeBinaryMap);
    writeJson(path.join(reportDir, "map-drift.json"), mapDrift);
    writeJson(path.join(reportDir, "drift-report.json"), driftReport);
    fs.writeFileSync(path.join(reportDir, "drift-report.md"), renderDriftMarkdown(driftReport), "utf8");
    fs.writeFileSync(
      path.join(reportDir, "substrate-action-plan.md"),
      renderActionPlanMarkdown(driftReport, candidateProtected, mapDrift),
      "utf8",
    );

    if (baselineProtected != null) {
      writeJson(path.join(reportDir, "baseline/inventory.json"), publicInventory(baselineInventory));
      writeJson(path.join(reportDir, "baseline/protected-surfaces.json"), baselineProtected);
      writeJson(path.join(reportDir, "baseline/bridge-map.json"), baselineProtected.bridgeMap);
      writeJson(path.join(reportDir, "baseline/plugin-map.json"), baselineProtected.pluginMap);
      writeJson(path.join(reportDir, "baseline/native-binary-map.json"), baselineProtected.nativeBinaryMap);
      writeJson(path.join(reportDir, "candidate/inventory.json"), publicInventory(candidateInventory));
      writeJson(path.join(reportDir, "candidate/protected-surfaces.json"), candidateProtected);
      writeJson(path.join(reportDir, "candidate/bridge-map.json"), candidateProtected.bridgeMap);
      writeJson(path.join(reportDir, "candidate/plugin-map.json"), candidateProtected.pluginMap);
      writeJson(path.join(reportDir, "candidate/native-binary-map.json"), candidateProtected.nativeBinaryMap);
    }

    return {
      outputDir: reportDir,
      inventory: candidateInventory,
      protectedSurfaces: candidateProtected,
      driftReport,
      mapDrift,
    };
  } finally {
    fs.rmSync(scratchRoot, { force: true, recursive: true });
  }
}

module.exports = {
  buildIntelReports,
  compareProtectedSurfaces,
  createBridgeMap,
  createInventory,
  createNativeBinaryMap,
  createPluginMap,
  compareMaps,
  extractProtectedSurfaces,
  findPostPatchIntegrityFindings,
  renderActionPlanMarkdown,
  renderDriftMarkdown,
  resolveBaselinePath,
};
