"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const LOCAL_FEATURES_DIR = "local";
const RESERVED_TOP_LEVEL_NAMES = new Set([
  LOCAL_FEATURES_DIR,
  "README.md",
  "features.example.json",
  "features.json",
]);

const RUNTIME_HOOK_DIRS = {
  env: { dir: "env.d", executable: false },
  prelaunch: { dir: "prelaunch.d", executable: true },
  electronArgs: { dir: "electron-args.d", executable: false },
  coldStart: { dir: "cold-start.d", executable: true },
  afterExit: { dir: "after-exit.d", executable: true },
};
const STAGED_FEATURE_MANIFEST_RELATIVE_PATH = ".codex-linux/linux-features-staged.json";

function defaultLinuxFeaturesRoot() {
  return path.resolve(__dirname, "..", "..", "linux-features");
}

function linuxFeaturesRoot(options = {}) {
  if (options.featuresRoot != null) {
    return path.resolve(options.featuresRoot);
  }
  if (process.env.CODEX_LINUX_FEATURES_ROOT?.trim()) {
    return path.resolve(process.env.CODEX_LINUX_FEATURES_ROOT.trim());
  }
  return defaultLinuxFeaturesRoot();
}

function linuxFeaturesConfigPath(featuresRoot) {
  if (process.env.CODEX_LINUX_FEATURES_CONFIG?.trim()) {
    return path.resolve(process.env.CODEX_LINUX_FEATURES_CONFIG.trim());
  }
  const localConfig = path.join(featuresRoot, "features.json");
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }
  return path.join(featuresRoot, "features.example.json");
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`WARN: Could not read ${label} at ${filePath}: ${error.message}`);
    return null;
  }
}

function assertFeatureId(value, label) {
  if (typeof value !== "string" || !FEATURE_ID_PATTERN.test(value)) {
    throw new Error(`${label} must match ${FEATURE_ID_PATTERN}`);
  }
  return value;
}

function normalizeFeatureIdList(value, label, featureId) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Linux feature '${featureId}' ${label} must be an array`);
  }
  const seen = new Set();
  const result = [];
  for (const item of value) {
    assertFeatureId(item, `Linux feature '${featureId}' ${label} entry`);
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function normalizeEnabledFeatureIds(value, sourcePath) {
  if (!Array.isArray(value)) {
    console.warn(`WARN: Linux features config ${sourcePath} must contain an enabled array`);
    return [];
  }

  const seen = new Set();
  const ids = [];
  for (const item of value) {
    if (typeof item !== "string" || !FEATURE_ID_PATTERN.test(item)) {
      console.warn(`WARN: Invalid Linux feature id in ${sourcePath}: ${String(item)}`);
      continue;
    }
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function enabledLinuxFeatureIds(options = {}) {
  const featuresRoot = linuxFeaturesRoot(options);
  const configPath = linuxFeaturesConfigPath(featuresRoot);
  if (!fs.existsSync(configPath)) {
    return [];
  }

  const config = readJsonFile(configPath, "Linux features config");
  if (config == null) {
    return [];
  }
  return normalizeEnabledFeatureIds(config.enabled, configPath);
}

function isDirectory(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function featureManifestCandidates(featuresRoot) {
  if (!fs.existsSync(featuresRoot)) {
    return [];
  }

  const candidates = [];
  for (const name of fs.readdirSync(featuresRoot).sort()) {
    if (RESERVED_TOP_LEVEL_NAMES.has(name) || name.startsWith(".")) {
      continue;
    }
    const dir = path.join(featuresRoot, name);
    if (isDirectory(dir) && fs.existsSync(path.join(dir, "feature.json"))) {
      candidates.push({ dir, manifestPath: path.join(dir, "feature.json"), origin: "repo" });
    }
  }

  const localRoot = path.join(featuresRoot, LOCAL_FEATURES_DIR);
  if (isDirectory(localRoot)) {
    for (const name of fs.readdirSync(localRoot).sort()) {
      if (name.startsWith(".")) {
        continue;
      }
      const dir = path.join(localRoot, name);
      if (isDirectory(dir) && fs.existsSync(path.join(dir, "feature.json"))) {
        candidates.push({ dir, manifestPath: path.join(dir, "feature.json"), origin: "local" });
      }
    }
  }

  return candidates;
}

function normalizeLinuxFeatureManifest(featuresRoot, candidate) {
  const manifest = readJsonFile(candidate.manifestPath, "Linux feature manifest");
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Linux feature manifest ${candidate.manifestPath} must be a JSON object`);
  }

  const id = assertFeatureId(manifest.id, `Linux feature id in ${candidate.manifestPath}`);
  const readmePath = path.join(candidate.dir, "README.md");
  if (!fs.existsSync(readmePath) || isDirectory(readmePath)) {
    throw new Error(`Linux feature '${id}' must include README.md next to feature.json`);
  }
  if (manifest.defaultEnabled === true) {
    throw new Error(`Linux feature '${id}' must be disabled by default; defaultEnabled true is not allowed`);
  }

  const relativeDir = path.relative(featuresRoot, candidate.dir);
  return {
    id,
    dir: candidate.dir,
    manifestPath: candidate.manifestPath,
    readmePath,
    origin: candidate.origin,
    local: candidate.origin === "local",
    relativeDir,
    manifest: {
      ...manifest,
      defaultEnabled: false,
      requires: normalizeFeatureIdList(manifest.requires, "requires", id),
      conflicts: normalizeFeatureIdList(manifest.conflicts, "conflicts", id),
    },
  };
}

function discoverLinuxFeatureManifests(options = {}) {
  const featuresRoot = linuxFeaturesRoot(options);
  const features = [];
  const seen = new Map();
  for (const candidate of featureManifestCandidates(featuresRoot)) {
    const feature = normalizeLinuxFeatureManifest(featuresRoot, candidate);
    const previous = seen.get(feature.id);
    if (previous != null) {
      throw new Error(
        `Duplicate Linux feature id '${feature.id}' in ${feature.manifestPath} and ${previous.manifestPath}`,
      );
    }
    seen.set(feature.id, feature);
    features.push(feature);
  }
  return features.sort((left, right) => left.id.localeCompare(right.id));
}

function linuxFeatureManifestMap(options = {}) {
  return new Map(discoverLinuxFeatureManifests(options).map((feature) => [feature.id, feature]));
}

function loadLinuxFeatureManifest(featuresRoot, id, options = {}) {
  const feature = linuxFeatureManifestMap({ ...options, featuresRoot }).get(id);
  if (feature == null) {
    console.warn(`WARN: Enabled Linux feature '${id}' does not have feature.json`);
    return null;
  }
  return feature;
}

function validateEnabledFeatureDependencies(features) {
  const enabled = new Set(features.map((feature) => feature.id));
  for (const feature of features) {
    for (const required of feature.manifest.requires) {
      if (!enabled.has(required)) {
        throw new Error(`Linux feature '${feature.id}' requires '${required}' to be enabled`);
      }
    }
    for (const conflict of feature.manifest.conflicts) {
      if (enabled.has(conflict)) {
        throw new Error(`Linux feature '${feature.id}' conflicts with '${conflict}'`);
      }
    }
  }
}

function loadEnabledLinuxFeatures(options = {}) {
  const featuresRoot = linuxFeaturesRoot(options);
  const available = linuxFeatureManifestMap({ ...options, featuresRoot });
  const features = [];
  const missing = [];
  for (const id of enabledLinuxFeatureIds({ ...options, featuresRoot })) {
    const feature = available.get(id);
    if (feature == null) {
      missing.push(id);
    } else {
      features.push(feature);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Enabled Linux feature ids not found in this checkout: ${missing.join(", ")}`);
  }
  validateEnabledFeatureDependencies(features);
  return features;
}

function relativePathParts(relativePath) {
  return String(relativePath).split(/[\\/]+/).filter((part) => part.length > 0 && part !== ".");
}

function normalizeInstallRelativePath(relativePath, label) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new Error(`${label} must be a relative path`);
  }
  const parts = relativePathParts(relativePath);
  if (path.isAbsolute(relativePath) || parts.includes("..")) {
    throw new Error(`${label} must stay inside the install directory`);
  }
  if (parts.length === 0) {
    throw new Error(`${label} must not target the install directory root`);
  }
  return parts.join("/");
}

function resolveInstallRelativePath(installDir, relativePath, label) {
  const normalized = normalizeInstallRelativePath(relativePath, label);
  const resolved = path.resolve(installDir, normalized);
  const relative = path.relative(installDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the install directory`);
  }
  return { normalized, resolved };
}

function resolveFeatureRelativePath(feature, relativePath, label, { mustExist = true } = {}) {
  if (typeof relativePath !== "string" || relativePath.trim().length === 0) {
    throw new Error(`Linux feature '${feature.id}' has invalid ${label}`);
  }
  if (path.isAbsolute(relativePath) || relativePathParts(relativePath).includes("..")) {
    throw new Error(`Linux feature '${feature.id}' ${label} must stay inside the feature directory`);
  }
  const resolved = path.resolve(feature.dir, relativePath);
  const relative = path.relative(feature.dir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Linux feature '${feature.id}' ${label} must stay inside the feature directory`);
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`Linux feature '${feature.id}' ${label} not found: ${resolved}`);
  }
  return resolved;
}

function resolveFeatureEntrypoint(feature, key) {
  const relativePath = feature.manifest.entrypoints?.[key];
  if (relativePath == null) {
    return null;
  }
  try {
    return resolveFeatureRelativePath(feature, relativePath, `${key} entrypoint`);
  } catch (error) {
    console.warn(`WARN: ${error.message}`);
    return null;
  }
}

function loadFeatureEntrypointModule(feature, key) {
  const entrypoint = resolveFeatureEntrypoint(feature, key);
  if (entrypoint == null) {
    return null;
  }

  try {
    return {
      entrypoint,
      moduleExports: require(entrypoint),
    };
  } catch (error) {
    console.warn(`WARN: Could not load Linux feature '${feature.id}' ${key}: ${error.message}`);
    return null;
  }
}

function featureContext(context, feature) {
  return { ...context, feature };
}

function prefixedFeaturePatchId(feature, descriptorId) {
  return descriptorId.startsWith(`feature:${feature.id}`)
    ? descriptorId
    : `feature:${feature.id}:${descriptorId}`;
}

function wrapFeaturePatchDescriptor(feature, descriptor, sourcePath, index, featureIndex) {
  if (descriptor == null || typeof descriptor !== "object") {
    console.warn(`WARN: Linux feature '${feature.id}' patch descriptor ${index + 1} must be an object`);
    return null;
  }
  if (typeof descriptor.apply !== "function") {
    console.warn(`WARN: Linux feature '${feature.id}' patch descriptor ${index + 1} must export apply`);
    return null;
  }

  const descriptorId = descriptor.id ?? descriptor.name;
  if (typeof descriptorId !== "string" || descriptorId.length === 0) {
    console.warn(`WARN: Linux feature '${feature.id}' patch descriptor ${index + 1} must have id or name`);
    return null;
  }

  const wrappedId = prefixedFeaturePatchId(feature, descriptorId);
  const wrapped = {
    ...descriptor,
    id: wrappedId,
    name: descriptor.name ?? wrappedId,
    ciPolicy: descriptor.ciPolicy ?? "optional",
    order: descriptor.order ?? 20_000 + featureIndex * 100 + index * 10,
    sourcePath,
    apply: (target, context) => descriptor.apply(target, featureContext(context, feature)),
  };

  if (typeof descriptor.appliesTo === "function") {
    wrapped.appliesTo = (context) => descriptor.appliesTo(featureContext(context, feature));
  }
  if (typeof descriptor.enabled === "function") {
    wrapped.enabled = (context) => descriptor.enabled(featureContext(context, feature));
  }
  if (typeof descriptor.targetSummary === "function") {
    wrapped.targetSummary = (context) => descriptor.targetSummary(featureContext(context, feature));
  }
  if (typeof descriptor.status === "function") {
    wrapped.status = (result, warnings, context) =>
      descriptor.status(result, warnings, featureContext(context, feature));
  }

  return wrapped;
}

function featurePatchDescriptorListFromExports(feature, moduleExports, sourcePath, featureIndex) {
  const exported = moduleExports?.descriptors ??
    moduleExports?.patches ??
    moduleExports?.default ??
    moduleExports;
  if (exported == null) {
    console.warn(`WARN: Linux feature '${feature.id}' patchDescriptors entrypoint must export descriptors`);
    return [];
  }

  const descriptors = Array.isArray(exported) ? exported : [exported];
  return descriptors
    .map((descriptor, index) =>
      wrapFeaturePatchDescriptor(feature, descriptor, sourcePath, index, featureIndex),
    )
    .filter(Boolean);
}

function loadLinuxFeaturePatchDescriptors(options = {}) {
  const descriptors = [];
  for (const [featureIndex, feature] of loadEnabledLinuxFeatures(options).entries()) {
    const loaded = loadFeatureEntrypointModule(feature, "patchDescriptors") ??
      loadFeatureEntrypointModule(feature, "patches");
    if (loaded == null) {
      const legacyLoaded = loadFeatureEntrypointModule(feature, "mainBundlePatch");
      if (legacyLoaded == null) {
        continue;
      }

      const moduleExports = legacyLoaded.moduleExports;
      const apply = moduleExports.applyMainBundlePatch ?? moduleExports.apply ?? moduleExports;
      if (typeof apply !== "function") {
        console.warn(`WARN: Linux feature '${feature.id}' mainBundlePatch must export a function`);
        continue;
      }

      descriptors.push({
        id: `feature:${feature.id}`,
        name: `feature:${feature.id}`,
        phase: "main-bundle",
        ciPolicy: "optional",
        apply: (source, context) => apply(source, featureContext(context, feature)),
      });
      continue;
    }
    descriptors.push(
      ...featurePatchDescriptorListFromExports(
        feature,
        loaded.moduleExports,
        loaded.entrypoint,
        featureIndex,
      ),
    );
  }
  return descriptors;
}

function loadLinuxFeatureMainBundlePatches(options = {}) {
  return loadLinuxFeaturePatchDescriptors(options)
    .filter((patch) => (patch.phase ?? "main-bundle") === "main-bundle")
    .map(({ apply, ciPolicy, id, name }) => ({ apply, ciPolicy, id, name }));
}

function enabledLinuxFeatureStageHooks(options = {}) {
  return loadEnabledLinuxFeatures(options)
    .map((feature) => ({
      id: feature.id,
      path: resolveFeatureEntrypoint(feature, "stageHook"),
    }))
    .filter((hook) => hook.path != null);
}

function normalizeEntryList(value, label, feature) {
  if (value == null) {
    return [];
  }
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry, index) => {
    if (typeof entry === "string") {
      return { source: resolveFeatureRelativePath(feature, entry, `${label} ${index + 1}`) };
    }
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Linux feature '${feature.id}' ${label} ${index + 1} must be a string or object`);
    }
    const source = resolveFeatureRelativePath(feature, entry.source ?? entry.path, `${label} ${index + 1}`);
    const name = entry.name == null ? path.basename(source) : String(entry.name);
    if (name.length === 0 || path.isAbsolute(name) || relativePathParts(name).includes("..") || name.includes("/") || name.includes("\\")) {
      throw new Error(`Linux feature '${feature.id}' ${label} ${index + 1} has invalid name`);
    }
    return { ...entry, source, name };
  });
}

function normalizeInstallTarget(target, featureId) {
  return normalizeInstallRelativePath(target, `Linux feature '${featureId}' resource target`);
}

function parseFileMode(value, fallback) {
  if (value == null) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid file mode: ${String(value)}; file mode must be a quoted octal string`);
  }
  const raw = value.trim();
  if (!/^[0-7]{3,4}$/.test(raw)) {
    throw new Error(`Invalid file mode: ${String(value)}; file mode must be a quoted octal string`);
  }
  return Number.parseInt(raw, 8);
}

function modeString(mode) {
  return mode == null ? null : mode.toString(8).padStart(4, "0");
}

function enabledLinuxFeatureInstallPlan(options = {}) {
  const resources = [];
  const runtimeHooks = [];
  for (const feature of loadEnabledLinuxFeatures(options)) {
    for (const [index, resource] of normalizeEntryList(feature.manifest.resources, "resource", feature).entries()) {
      const target = normalizeInstallTarget(resource.target, feature.id);
      resources.push({
        id: feature.id,
        source: resource.source,
        target,
        mode: resource.mode == null ? null : parseFileMode(resource.mode, 0o644),
        index,
      });
    }

    const hooks = feature.manifest.runtimeHooks ?? {};
    if (hooks != null && (typeof hooks !== "object" || Array.isArray(hooks))) {
      throw new Error(`Linux feature '${feature.id}' runtimeHooks must be an object`);
    }
    for (const [hookKey, hookSpec] of Object.entries(hooks ?? {})) {
      const runtimeHook = RUNTIME_HOOK_DIRS[hookKey];
      if (runtimeHook == null) {
        throw new Error(`Linux feature '${feature.id}' has unsupported runtime hook '${hookKey}'`);
      }
      for (const [index, entry] of normalizeEntryList(hookSpec, `runtimeHooks.${hookKey}`, feature).entries()) {
        const name = `${feature.id}-${entry.name ?? path.basename(entry.source)}`;
        runtimeHooks.push({
          id: feature.id,
          key: hookKey,
          source: entry.source,
          name,
          mode: parseFileMode(entry.mode, runtimeHook.executable ? 0o755 : 0o644),
          dir: runtimeHook.dir,
          target: [".codex-linux", runtimeHook.dir, name].join("/"),
          index,
        });
      }
    }
  }
  return { resources, runtimeHooks };
}

function chmodRecursive(target, mode) {
  const directory = isDirectory(target);
  const targetMode = directory
    ? mode |
      ((mode & 0o400) ? 0o100 : 0) |
      ((mode & 0o040) ? 0o010 : 0) |
      ((mode & 0o004) ? 0o001 : 0)
    : mode;
  fs.chmodSync(target, targetMode);
  if (!directory) {
    return;
  }
  for (const name of fs.readdirSync(target)) {
    chmodRecursive(path.join(target, name), mode);
  }
}

function copyInstallFile(source, target, mode) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
  if (mode != null) {
    chmodRecursive(target, mode);
  }
}

function stagedManifestPath(installDir) {
  return path.join(installDir, STAGED_FEATURE_MANIFEST_RELATIVE_PATH);
}

function stagedArtifactEntries(manifest) {
  if (manifest == null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [];
  }
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const runtimeHooks = Array.isArray(manifest.runtimeHooks) ? manifest.runtimeHooks : [];
  return [...resources, ...runtimeHooks].filter((entry) => entry != null && typeof entry === "object");
}

function readStagedFeatureManifest(installDir) {
  const manifestPath = stagedManifestPath(installDir);
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.warn(`WARN: Could not read Linux feature staged manifest at ${manifestPath}: ${error.message}`);
    return null;
  }
}

function writeStagedFeatureManifest(installDir, plan) {
  const manifestPath = stagedManifestPath(installDir);
  const manifest = {
    version: 1,
    resources: plan.resources.map((resource) => ({
      id: resource.id,
      type: "resource",
      target: resource.target,
      mode: modeString(resource.mode),
    })),
    runtimeHooks: plan.runtimeHooks.map((hook) => ({
      id: hook.id,
      type: "runtimeHook",
      key: hook.key,
      target: hook.target,
      mode: modeString(hook.mode),
    })),
  };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function removeInstallRelativePath(installDir, relativePath) {
  const { normalized, resolved } = resolveInstallRelativePath(
    installDir,
    relativePath,
    "Linux feature staged artifact target",
  );
  if (normalized === STAGED_FEATURE_MANIFEST_RELATIVE_PATH) {
    return;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function removePreviouslyStagedArtifacts(installDir, manifest) {
  for (const entry of stagedArtifactEntries(manifest)) {
    if (typeof entry.target !== "string") {
      continue;
    }
    removeInstallRelativePath(installDir, entry.target);
  }
}

function removeLegacyDeclarativeRuntimeHooks(installDir, options = {}) {
  const featureIds = discoverLinuxFeatureManifests(options).map((feature) => feature.id);
  if (featureIds.length === 0) {
    return;
  }
  for (const runtimeHook of Object.values(RUNTIME_HOOK_DIRS)) {
    const hookDir = path.join(installDir, ".codex-linux", runtimeHook.dir);
    if (!isDirectory(hookDir)) {
      continue;
    }
    for (const name of fs.readdirSync(hookDir)) {
      if (featureIds.some((id) => name.startsWith(`${id}-`))) {
        fs.rmSync(path.join(hookDir, name), { recursive: true, force: true });
      }
    }
  }
}

function stagedLinuxFeatureFiles(appDir) {
  const installDir = path.resolve(appDir);
  return stagedArtifactEntries(readStagedFeatureManifest(installDir))
    .filter((entry) => typeof entry.target === "string" && typeof entry.mode === "string")
    .map((entry) => ({
      id: entry.id ?? null,
      type: entry.type ?? null,
      key: entry.key ?? null,
      target: normalizeInstallRelativePath(entry.target, "Linux feature staged artifact target"),
      mode: entry.mode,
    }));
}

function stageEnabledLinuxFeatureInstall(appDir, options = {}) {
  const installDir = path.resolve(appDir);
  const plan = enabledLinuxFeatureInstallPlan(options);
  const previousManifest = readStagedFeatureManifest(installDir);
  if (previousManifest == null) {
    removeLegacyDeclarativeRuntimeHooks(installDir, options);
  } else {
    removePreviouslyStagedArtifacts(installDir, previousManifest);
  }
  for (const resource of plan.resources) {
    copyInstallFile(resource.source, path.join(installDir, resource.target), resource.mode);
    console.error(`Staged Linux feature resource: ${resource.id} -> ${resource.target}`);
  }
  for (const hook of plan.runtimeHooks) {
    const target = path.join(installDir, hook.target);
    copyInstallFile(hook.source, target, hook.mode);
    console.error(`Staged Linux feature ${hook.key} hook: ${hook.id} -> ${path.relative(installDir, target)}`);
  }
  writeStagedFeatureManifest(installDir, plan);
  return plan;
}

function enabledLinuxFeaturePackageHooks(options = {}) {
  const packageFormat = options.packageFormat ?? null;
  const hooks = [];
  for (const feature of loadEnabledLinuxFeatures(options)) {
    for (const [index, entry] of normalizeEntryList(feature.manifest.packageHooks, "packageHook", feature).entries()) {
      const formats = entry.formats == null
        ? []
        : normalizeFeatureIdList(entry.formats, "packageHook formats", feature.id);
      if (packageFormat != null && formats.length > 0 && !formats.includes(packageFormat)) {
        continue;
      }
      hooks.push({
        id: feature.id,
        path: entry.source,
        formats,
        index,
      });
    }
  }
  return hooks;
}

function featuresJsonSummary(options = {}) {
  return discoverLinuxFeatureManifests(options).map((feature) => ({
    id: feature.id,
    title: feature.manifest.title ?? feature.manifest.name ?? feature.id,
    name: feature.manifest.name ?? feature.manifest.title ?? feature.id,
    description: feature.manifest.description ?? "",
    origin: feature.origin,
    local: feature.local,
    relativeDir: feature.relativeDir,
    requires: feature.manifest.requires,
    conflicts: feature.manifest.conflicts,
    defaultEnabled: false,
    setup: feature.manifest.setup ?? null,
    cleanup: feature.manifest.cleanup ?? null,
  }));
}

function main() {
  const command = process.argv[2];
  if (command === "--stage-hooks") {
    for (const hook of enabledLinuxFeatureStageHooks()) {
      process.stdout.write(`${hook.id}\t${hook.path}\n`);
    }
    return;
  }
  if (command === "--package-hooks") {
    const packageFormat = process.argv[3] ?? "";
    for (const hook of enabledLinuxFeaturePackageHooks({ packageFormat })) {
      process.stdout.write(`${hook.id}\t${hook.path}\n`);
    }
    return;
  }
  if (command === "--stage-install") {
    const appDir = process.argv[3] ?? process.env.INSTALL_DIR;
    if (!appDir) {
      console.error("Usage: linux-features.js --stage-install <install-dir>");
      process.exit(1);
    }
    stageEnabledLinuxFeatureInstall(appDir);
    return;
  }
  if (command === "--staged-files-json") {
    const appDir = process.argv[3] ?? process.env.INSTALL_DIR;
    if (!appDir) {
      console.error("Usage: linux-features.js --staged-files-json <install-dir>");
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(stagedLinuxFeatureFiles(appDir), null, 2)}\n`);
    return;
  }
  if (command === "--enabled") {
    for (const id of enabledLinuxFeatureIds()) {
      process.stdout.write(`${id}\n`);
    }
    return;
  }
  if (command === "--features-json") {
    process.stdout.write(`${JSON.stringify(featuresJsonSummary(), null, 2)}\n`);
    return;
  }
  if (command === "--features-root") {
    process.stdout.write(`${linuxFeaturesRoot()}\n`);
    return;
  }
  console.error("Usage: linux-features.js --enabled | --features-json | --features-root | --stage-install <install-dir> | --staged-files-json <install-dir> | --stage-hooks | --package-hooks <format>");
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  discoverLinuxFeatureManifests,
  enabledLinuxFeatureIds,
  enabledLinuxFeatureInstallPlan,
  enabledLinuxFeaturePackageHooks,
  enabledLinuxFeatureStageHooks,
  featuresJsonSummary,
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
  loadLinuxFeatureMainBundlePatches,
  linuxFeatureManifestMap,
  linuxFeaturesConfigPath,
  linuxFeaturesRoot,
  resolveFeatureEntrypoint,
  stageEnabledLinuxFeatureInstall,
  stagedLinuxFeatureFiles,
};
