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
// Keep removed feature ids loadable so preserved update-builder configs still rebuild.
const LEGACY_FEATURE_ID_ALIASES = new Map([
  ["zed-opener", "open-target-discovery"],
]);

const RUNTIME_HOOK_DIRS = {
  env: { dir: "env.d", executable: false },
  prelaunch: { dir: "prelaunch.d", executable: true },
  electronArgs: { dir: "electron-args.d", executable: false },
  launcher: { dir: "launcher.d", executable: true },
  coldStart: { dir: "cold-start.d", executable: true },
  afterExit: { dir: "after-exit.d", executable: true },
};
const STAGED_FEATURE_MANIFEST_RELATIVE_PATH = ".codex-linux/linux-features-staged.json";
const BUILD_INFO_RELATIVE_PATH = ".codex-linux/build-info.json";
const SUPPORTED_PACKAGE_FORMATS = new Set(["deb", "rpm", "pacman"]);
const PACKAGE_DEPENDENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+._:@()=<>~\/-]*$/;
const RPM_ELF_DEPENDENCY_SUFFIX = "%{codex_elf_suffix}";
const PACKAGE_PATH_COMPONENT_PATTERN = /^(?!-)(?!\.\.?$)[A-Za-z0-9._+@:-]+$/;
const PACMAN_RESERVED_PACKAGE_TARGETS = new Set([
  ".BUILDINFO",
  ".CHANGELOG",
  ".INSTALL",
  ".MTREE",
  ".PKGINFO",
]);

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

function linuxFeaturesConfigPath(featuresRoot, options = {}) {
  if (options.featuresConfigPath != null) {
    return path.resolve(options.featuresConfigPath);
  }
  if (process.env.CODEX_LINUX_FEATURES_CONFIG?.trim()) {
    return path.resolve(process.env.CODEX_LINUX_FEATURES_CONFIG.trim());
  }
  const localConfig = path.join(featuresRoot, "features.json");
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }
  return path.join(featuresRoot, "features.example.json");
}

function readJsonFile(filePath, label, options = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (options.strict === true) {
      throw new Error(`Could not read ${label} at ${filePath}: ${error.message}`);
    }
    console.warn(`WARN: Could not read ${label} at ${filePath}: ${error.message}`);
    return null;
  }
}

function readLinuxFeaturesConfig(options = {}) {
  const featuresRoot = linuxFeaturesRoot(options);
  const configPath = linuxFeaturesConfigPath(featuresRoot, options);
  const strict = options.strictConfig === true;
  if (!fs.existsSync(configPath)) {
    if (strict) {
      throw new Error(`Could not read Linux features config at ${configPath}: file does not exist`);
    }
    return { config: null, configPath };
  }

  const config = readJsonFile(configPath, "Linux features config", { strict });
  if (config == null) {
    if (strict) {
      throw new Error(`Linux features config ${configPath} must be a JSON object`);
    }
    return { config: null, configPath };
  }
  if (typeof config !== "object" || Array.isArray(config)) {
    if (strict) {
      throw new Error(`Linux features config ${configPath} must be a JSON object`);
    }
    console.warn(`WARN: Linux features config ${configPath} must be a JSON object`);
    return { config: null, configPath };
  }
  return { config, configPath };
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

function normalizeEnabledFeatureIds(value, sourcePath, options = {}) {
  if (!Array.isArray(value)) {
    if (options.strict === true) {
      throw new Error(`Linux features config ${sourcePath} must contain an enabled array`);
    }
    console.warn(`WARN: Linux features config ${sourcePath} must contain an enabled array`);
    return [];
  }

  const seen = new Set();
  const ids = [];
  for (const item of value) {
    if (typeof item !== "string" || !FEATURE_ID_PATTERN.test(item)) {
      if (options.strict === true) {
        throw new Error(`Invalid Linux feature id in ${sourcePath}: ${String(item)}`);
      }
      console.warn(`WARN: Invalid Linux feature id in ${sourcePath}: ${String(item)}`);
      continue;
    }
    const id = LEGACY_FEATURE_ID_ALIASES.get(item) ?? item;
    if (seen.has(id)) {
      if (options.strict === true) {
        throw new Error(`Duplicate Linux feature id in ${sourcePath}: ${item}`);
      }
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function enabledFeatureIdsFromBuildInfo(appDir) {
  const buildInfoPath = path.join(path.resolve(appDir), BUILD_INFO_RELATIVE_PATH);
  let buildInfo;
  try {
    buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read packaged app build info at ${buildInfoPath}: ${error.message}`);
  }
  if (buildInfo == null || typeof buildInfo !== "object" || Array.isArray(buildInfo)) {
    throw new Error(`Packaged app build info at ${buildInfoPath} must be a JSON object`);
  }
  const enabled = buildInfo.linuxFeatures?.enabled;
  if (!Array.isArray(enabled)) {
    throw new Error(`Packaged app build info at ${buildInfoPath} must contain linuxFeatures.enabled`);
  }

  const seen = new Set();
  const ids = [];
  for (const rawId of enabled) {
    const id = assertFeatureId(rawId, `Linux feature id in ${buildInfoPath}`);
    if (seen.has(id)) {
      throw new Error(`Duplicate Linux feature id in ${buildInfoPath}: ${rawId}`);
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeLinuxFeatureSettings(value, sourcePath) {
  if (value == null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    console.warn(`WARN: Linux features config ${sourcePath} settings must be an object`);
    return {};
  }

  const settings = {};
  for (const [rawId, rawSettings] of Object.entries(value)) {
    if (typeof rawId !== "string" || !FEATURE_ID_PATTERN.test(rawId)) {
      console.warn(`WARN: Invalid Linux feature settings id in ${sourcePath}: ${String(rawId)}`);
      continue;
    }
    const id = LEGACY_FEATURE_ID_ALIASES.get(rawId) ?? rawId;
    if (rawSettings == null || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
      console.warn(`WARN: Linux feature '${rawId}' settings in ${sourcePath} must be an object`);
      continue;
    }
    settings[id] = rawSettings;
  }
  return settings;
}

function linuxFeaturesConfig(options = {}) {
  const { config, configPath } = readLinuxFeaturesConfig(options);
  if (config == null) {
    return { enabled: [], settings: {}, configPath };
  }
  return {
    enabled: normalizeEnabledFeatureIds(
      config.enabled,
      configPath,
      { strict: options.strictConfig === true },
    ),
    settings: normalizeLinuxFeatureSettings(config.settings, configPath),
    configPath,
  };
}

function enabledLinuxFeatureIds(options = {}) {
  return linuxFeaturesConfig(options).enabled;
}

function enabledLinuxFeaturesConfig(options = {}) {
  const { enabled, settings } = linuxFeaturesConfig(options);
  const filteredSettings = {};
  for (const id of enabled) {
    if (Object.prototype.hasOwnProperty.call(settings, id)) {
      filteredSettings[id] = settings[id];
    }
  }
  if (Object.keys(filteredSettings).length === 0) {
    return { enabled };
  }
  return { enabled, settings: filteredSettings };
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
  const config = linuxFeaturesConfig({ ...options, featuresRoot });
  const enabled = options.enabledFeatureIds ?? config.enabled;
  const features = [];
  const missing = [];
  for (const id of enabled) {
    const feature = available.get(id);
    if (feature == null) {
      missing.push(id);
    } else {
      features.push({ ...feature, settings: config.settings[id] ?? {} });
    }
  }
  if (missing.length > 0) {
    throw new Error(`Enabled Linux feature ids not found in this checkout: ${missing.join(", ")}`);
  }
  validateEnabledFeatureDependencies(features);
  return features;
}

function packageFeatureOptions(appDir, options = {}) {
  const snapshotEnabled = enabledFeatureIdsFromBuildInfo(appDir);
  const strictOptions = { ...options, strictConfig: true };
  const configuredEnabled = enabledLinuxFeatureIds(strictOptions);
  if (
    snapshotEnabled.length !== configuredEnabled.length
    || snapshotEnabled.some((id, index) => id !== configuredEnabled[index])
  ) {
    throw new Error(
      [
        `Packaged app Linux feature snapshot does not match the current feature config: ${path.resolve(appDir)}`,
        `app snapshot: ${JSON.stringify(snapshotEnabled)}`,
        `current config: ${JSON.stringify(configuredEnabled)}`,
        "Rebuild the app with the current feature config before creating a native package.",
      ].join("\n"),
    );
  }
  return {
    ...strictOptions,
    enabledFeatureIds: snapshotEnabled,
  };
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
    sourceKind: "feature",
    featureId: feature.id,
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
  if (typeof descriptor.assetMatch === "function") {
    wrapped.assetMatch = (source, assetName, context) =>
      descriptor.assetMatch(source, assetName, featureContext(context, feature));
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
    const loaded = loadFeatureEntrypointModule(feature, "patchDescriptors");
    if (loaded == null) {
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

function enabledLinuxFeatureStageHooks(options = {}) {
  return loadEnabledLinuxFeatures(options)
    .map((feature) => ({
      id: feature.id,
      path: resolveFeatureEntrypoint(feature, "stageHook"),
    }))
    .filter((hook) => hook.path != null);
}

function disabledLinuxFeatureCleanupHooks(options = {}) {
  const featuresRoot = linuxFeaturesRoot(options);
  const enabled = new Set(enabledLinuxFeatureIds({ ...options, featuresRoot }));
  return discoverLinuxFeatureManifests({ ...options, featuresRoot })
    .filter((feature) => !enabled.has(feature.id))
    .map((feature) => ({
      id: feature.id,
      path: resolveFeatureEntrypoint(feature, "cleanupHook"),
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

function parsePackageResourceMode(value) {
  const mode = parseFileMode(value, 0o644);
  if ((mode & 0o7000) !== 0) {
    throw new Error(
      `Invalid package resource file mode: ${String(value)}; special permission bits are not allowed`,
    );
  }
  return mode;
}

function modeString(mode) {
  return mode == null ? null : mode.toString(8).padStart(4, "0");
}

function enabledLinuxFeatureInstallPlan(options = {}) {
  const resources = [];
  const runtimeHooks = [];
  const installTargetOwners = new Map([
    [STAGED_FEATURE_MANIFEST_RELATIVE_PATH, "Linux feature staging framework"],
  ]);
  const claimInstallTarget = (target, owner) => {
    for (const [existingTarget, existingOwner] of installTargetOwners) {
      const duplicate = target === existingTarget;
      const overlap = duplicate
        || target.startsWith(`${existingTarget}/`)
        || existingTarget.startsWith(`${target}/`);
      if (overlap) {
        const kind = duplicate ? "Duplicate" : "Overlapping";
        throw new Error(`${kind} Linux feature install target '${target}': ${owner} conflicts with '${existingTarget}' from ${existingOwner}`);
      }
    }
    installTargetOwners.set(target, owner);
  };
  for (const feature of loadEnabledLinuxFeatures(options)) {
    for (const [index, resource] of normalizeEntryList(feature.manifest.resources, "resource", feature).entries()) {
      const target = normalizeInstallTarget(resource.target, feature.id);
      claimInstallTarget(target, `resource ${index + 1} for feature '${feature.id}'`);
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
        const target = [".codex-linux", runtimeHook.dir, name].join("/");
        claimInstallTarget(target, `runtimeHooks.${hookKey} ${index + 1} for feature '${feature.id}'`);
        runtimeHooks.push({
          id: feature.id,
          key: hookKey,
          source: entry.source,
          name,
          mode: parseFileMode(entry.mode, runtimeHook.executable ? 0o755 : 0o644),
          dir: runtimeHook.dir,
          target,
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

function pathStaysInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function assertNoSymbolicLinks(target, label) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not contain symbolic links`);
  }
  if (!stat.isDirectory()) {
    return;
  }
  for (const name of fs.readdirSync(target)) {
    assertNoSymbolicLinks(path.join(target, name), label);
  }
}

function assertNoSymbolicLinksIfPresent(target, label) {
  try {
    assertNoSymbolicLinks(target, label);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function assertNoInstallPathSymbolicLinks(installDir, relativePath, label) {
  let current = installDir;
  for (const part of relativePathParts(relativePath)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`${label} must not contain symbolic links`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function assertInstallParentInside(installDir, target, label) {
  const parent = path.dirname(target);
  const relativeParent = path.relative(installDir, parent);
  assertInstallPathInsideIfPresent(installDir, relativeParent, label);
  fs.mkdirSync(parent, { recursive: true });
  const installRoot = fs.realpathSync(installDir);
  const realParent = fs.realpathSync(parent);
  if (!pathStaysInside(installRoot, realParent)) {
    throw new Error(`${label} must stay inside the install directory`);
  }
  if (relativeParent !== "" && !relativeParent.startsWith("..") && !path.isAbsolute(relativeParent)) {
    assertNoInstallPathSymbolicLinks(installDir, relativeParent, label);
  }
}

function assertInstallPathInsideIfPresent(installDir, relativePath, label) {
  fs.mkdirSync(installDir, { recursive: true });
  const installRoot = fs.realpathSync(installDir);
  const parts = relativePathParts(relativePath);
  for (let index = parts.length; index >= 0; index -= 1) {
    const candidate = index === 0
      ? installDir
      : path.join(installDir, ...parts.slice(0, index));
    try {
      const realCandidate = fs.realpathSync(candidate);
      if (!pathStaysInside(installRoot, realCandidate)) {
        throw new Error(`${label} must stay inside the install directory`);
      }
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  assertNoInstallPathSymbolicLinks(installDir, relativePath, label);
}

function installRelativeDirectoryExists(installDir, relativePath, label) {
  const { normalized, resolved } = resolveInstallRelativePath(installDir, relativePath, label);
  assertInstallPathInsideIfPresent(installDir, normalized, label);
  try {
    return fs.lstatSync(resolved).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function copyInstallFile(installDir, source, target, mode, labels = {}) {
  const sourceLabel = labels.source ?? "Linux feature source";
  const targetLabel = labels.target ?? "Linux feature target";
  assertNoSymbolicLinks(source, sourceLabel);
  assertInstallParentInside(installDir, target, targetLabel);
  assertNoSymbolicLinksIfPresent(target, targetLabel);
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
  assertInstallPathInsideIfPresent(
    installDir,
    normalized,
    "Linux feature staged artifact target",
  );
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
    const hookDirRelative = [".codex-linux", runtimeHook.dir].join("/");
    const hookDir = path.join(installDir, hookDirRelative);
    if (!installRelativeDirectoryExists(installDir, hookDirRelative, "Linux feature runtime hook directory")) {
      continue;
    }
    for (const name of fs.readdirSync(hookDir)) {
      if (featureIds.some((id) => name.startsWith(`${id}-`))) {
        removeInstallRelativePath(installDir, path.join(hookDirRelative, name));
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
    copyInstallFile(installDir, resource.source, path.join(installDir, resource.target), resource.mode);
    console.error(`Staged Linux feature resource: ${resource.id} -> ${resource.target}`);
  }
  for (const hook of plan.runtimeHooks) {
    const target = path.join(installDir, hook.target);
    copyInstallFile(installDir, hook.source, target, hook.mode);
    console.error(`Staged Linux feature ${hook.key} hook: ${hook.id} -> ${path.relative(installDir, target)}`);
  }
  writeStagedFeatureManifest(installDir, plan);
  return plan;
}

function enabledLinuxFeaturePackageHooks(options = {}) {
  const packageFormat = options.packageFormat ?? null;
  const selectedOptions = options.appDir == null
    ? options
    : packageFeatureOptions(options.appDir, options);
  const hooks = [];
  for (const feature of loadEnabledLinuxFeatures(selectedOptions)) {
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

function normalizePackageFormat(value, label = "package format") {
  if (typeof value !== "string" || !SUPPORTED_PACKAGE_FORMATS.has(value)) {
    throw new Error(`Unsupported ${label} '${String(value)}'`);
  }
  return value;
}

function normalizePackageFormats(value, featureId, label) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Linux feature '${featureId}' ${label} formats must be an array`);
  }
  const formats = [];
  for (const rawFormat of value) {
    const format = normalizePackageFormat(rawFormat, `package format for Linux feature '${featureId}'`);
    if (!formats.includes(format)) {
      formats.push(format);
    }
  }
  return formats.sort();
}

function normalizePackageTarget(value, featureId) {
  const label = `Linux feature '${featureId}' package resource target`;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a relative path inside the package root`);
  }
  const parts = relativePathParts(value);
  if (path.isAbsolute(value) || parts.includes("..")) {
    throw new Error(`${label} must stay inside the package root`);
  }
  if (parts.length === 0) {
    throw new Error(`${label} must not target the package root`);
  }
  for (const part of parts) {
    if (!PACKAGE_PATH_COMPONENT_PATTERN.test(part)) {
      throw new Error(`${label} contains an unsafe package path component: ${JSON.stringify(part)}`);
    }
  }
  return parts.join("/");
}

function assertNoSymbolicLinkAncestors(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the feature directory`);
  }
  let current = root;
  for (const part of relativePathParts(relative)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not contain symbolic links`);
    }
  }
}

function normalizePackageDependencies(feature) {
  const value = feature.manifest.packageDependencies;
  if (value == null) {
    return new Map();
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Linux feature '${feature.id}' packageDependencies must be an object`);
  }

  const dependencies = new Map();
  for (const [rawFormat, entries] of Object.entries(value)) {
    const format = normalizePackageFormat(
      rawFormat,
      `package format in Linux feature '${feature.id}' packageDependencies`,
    );
    if (!Array.isArray(entries)) {
      throw new Error(`Linux feature '${feature.id}' dependencies for ${format} must be an array`);
    }
    const normalized = [];
    for (const entry of entries) {
      const dependencyToken = typeof entry === "string"
        && format === "rpm"
        && entry.endsWith(RPM_ELF_DEPENDENCY_SUFFIX)
        ? entry.slice(0, -RPM_ELF_DEPENDENCY_SUFFIX.length)
        : entry;
      if (
        typeof entry !== "string"
        || !PACKAGE_DEPENDENCY_PATTERN.test(dependencyToken)
      ) {
        throw new Error(`Linux feature '${feature.id}' has invalid ${format} package dependency '${String(entry)}'`);
      }
      if (!normalized.includes(entry)) {
        normalized.push(entry);
      }
    }
    dependencies.set(format, normalized.sort());
  }
  return dependencies;
}

function enabledLinuxFeaturePackagePlan(options = {}) {
  const packageFormat = normalizePackageFormat(options.packageFormat);
  const selectedOptions = options.appDir == null
    ? options
    : packageFeatureOptions(options.appDir, options);
  const resources = [];
  const dependencies = [];
  const targetOwners = new Map();

  for (const feature of loadEnabledLinuxFeatures(selectedOptions)) {
    const featureDependencies = normalizePackageDependencies(feature);
    dependencies.push(...(featureDependencies.get(packageFormat) ?? []));

    const entries = feature.manifest.packageResources;
    if (entries == null) {
      continue;
    }
    if (!Array.isArray(entries)) {
      throw new Error(`Linux feature '${feature.id}' packageResources must be an array`);
    }
    for (const [index, entry] of entries.entries()) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`Linux feature '${feature.id}' package resource ${index + 1} must be an object`);
      }
      const source = resolveFeatureRelativePath(
        feature,
        entry.source ?? entry.path,
        `package resource ${index + 1}`,
      );
      assertNoSymbolicLinkAncestors(
        feature.dir,
        source,
        `Linux feature '${feature.id}' package resource ${index + 1}`,
      );
      if (!fs.lstatSync(source).isFile()) {
        throw new Error(
          `Linux feature '${feature.id}' package resource ${index + 1} source must be a regular file`,
        );
      }
      const target = normalizePackageTarget(entry.target, feature.id);
      const formats = normalizePackageFormats(entry.formats, feature.id, `package resource ${index + 1}`);
      if (formats.length > 0 && !formats.includes(packageFormat)) {
        continue;
      }
      if (
        packageFormat === "deb"
        && (target === "DEBIAN" || target.startsWith("DEBIAN/"))
      ) {
        throw new Error(
          `Linux feature '${feature.id}' package resource target '${target}' uses the reserved Debian control namespace`,
        );
      }
      const targetRoot = target.split("/", 1)[0];
      if (
        packageFormat === "pacman"
        && PACMAN_RESERVED_PACKAGE_TARGETS.has(targetRoot)
      ) {
        throw new Error(
          `Linux feature '${feature.id}' package resource target '${target}' uses a reserved pacman package namespace`,
        );
      }
      for (const [existingTarget, previousOwner] of targetOwners) {
        const duplicate = target === existingTarget;
        const overlap = duplicate
          || target.startsWith(`${existingTarget}/`)
          || existingTarget.startsWith(`${target}/`);
        if (overlap) {
          const kind = duplicate ? "Duplicate" : "Overlapping";
          throw new Error(
            `${kind} Linux feature package target '${target}': feature '${feature.id}' conflicts with '${existingTarget}' from ${previousOwner}`,
          );
        }
      }
      targetOwners.set(target, `feature '${feature.id}'`);
      resources.push({
        id: feature.id,
        source,
        target,
        mode: parsePackageResourceMode(entry.mode),
        formats,
        index,
      });
    }
  }

  resources.sort((left, right) => left.target.localeCompare(right.target));
  return {
    resources,
    dependencies: [...new Set(dependencies)].sort(),
  };
}

function enabledLinuxFeaturePackageDependencies(options = {}) {
  return enabledLinuxFeaturePackagePlan(options).dependencies;
}

function enabledLinuxFeaturePackageFiles(options = {}) {
  return enabledLinuxFeaturePackagePlan(options).resources.map((resource) => `/${resource.target}`);
}

function assertPackageResourcesOutsideApp(packageRoot, appDir, plan) {
  const root = path.resolve(packageRoot);
  const app = path.resolve(appDir);
  const appRelative = path.relative(root, app).split(path.sep).join("/");
  if (
    appRelative === ""
    || appRelative === ".."
    || appRelative.startsWith("../")
    || path.isAbsolute(appRelative)
  ) {
    throw new Error(`Packaged app directory must stay inside the package root: ${app}`);
  }
  for (const resource of plan.resources) {
    if (
      resource.target === appRelative
      || resource.target.startsWith(`${appRelative}/`)
      || appRelative.startsWith(`${resource.target}/`)
    ) {
      throw new Error(
        `Linux feature package resource target must stay outside the packaged app directory: ${resource.target}`,
      );
    }
  }
}

function stageEnabledLinuxFeaturePackageResources(packageRoot, options = {}) {
  const installDir = path.resolve(packageRoot);
  const plan = enabledLinuxFeaturePackagePlan(options);
  if (options.appDir != null) {
    assertPackageResourcesOutsideApp(installDir, options.appDir, plan);
  }
  fs.mkdirSync(installDir, { recursive: true });
  for (const resource of plan.resources) {
    const targetPath = path.join(installDir, resource.target);
    if (fs.lstatSync(targetPath, { throwIfNoEntry: false }) != null) {
      throw new Error(
        `Linux feature package target conflicts with existing package payload: ${resource.target}`,
      );
    }
    try {
      copyInstallFile(
        installDir,
        resource.source,
        targetPath,
        resource.mode,
        {
          source: "Linux feature package source",
          target: "Linux feature package target",
        },
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("inside the install directory")) {
        throw new Error(error.message.replace("inside the install directory", "inside the package root"));
      }
      throw error;
    }
    console.error(`Staged Linux feature package resource: ${resource.id} -> ${resource.target}`);
  }
  return plan;
}

function restoreEnabledLinuxFeaturePackageResourcePermissions(packageRoot, options = {}) {
  const root = path.resolve(packageRoot);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`Linux feature package root must not be a symbolic link: ${root}`);
  }
  const realRoot = fs.realpathSync(root);
  const plan = enabledLinuxFeaturePackagePlan(options);
  if (options.appDir != null) {
    assertPackageResourcesOutsideApp(root, options.appDir, plan);
  }
  for (const resource of plan.resources) {
    const targetPath = path.join(root, resource.target);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Linux feature package resource is missing from payload: ${resource.target}`);
    }
    assertNoSymbolicLinkAncestors(
      root,
      targetPath,
      `Linux feature package resource '${resource.target}'`,
    );
    assertNoSymbolicLinks(
      targetPath,
      `Linux feature package resource '${resource.target}'`,
    );
    const realTarget = fs.realpathSync(targetPath);
    const relative = path.relative(realRoot, realTarget);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Linux feature package resource must stay inside the package root: ${resource.target}`,
      );
    }
    chmodRecursive(targetPath, resource.mode);
  }
  return plan;
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
  if (command === "--cleanup-hooks") {
    for (const hook of disabledLinuxFeatureCleanupHooks()) {
      process.stdout.write(`${hook.id}\t${hook.path}\n`);
    }
    return;
  }
  if (command === "--package-hooks") {
    const packageFormat = process.argv[3] ?? "";
    const appDir = process.argv[4] ?? process.env.PACKAGE_APP_DIR;
    if (!appDir) {
      console.error("Usage: linux-features.js --package-hooks <format> <app-dir>");
      process.exit(1);
    }
    for (const hook of enabledLinuxFeaturePackageHooks({ packageFormat, appDir })) {
      process.stdout.write(`${hook.id}\t${hook.path}\n`);
    }
    return;
  }
  if (command === "--stage-package-resources") {
    const packageFormat = process.argv[3] ?? "";
    const packageRoot = process.argv[4] ?? process.env.PACKAGE_ROOT;
    const appDir = process.argv[5] ?? process.env.PACKAGE_APP_DIR;
    if (!packageRoot || !appDir) {
      console.error("Usage: linux-features.js --stage-package-resources <format> <package-root> <app-dir>");
      process.exit(1);
    }
    stageEnabledLinuxFeaturePackageResources(packageRoot, { packageFormat, appDir });
    return;
  }
  if (command === "--package-dependencies") {
    const packageFormat = process.argv[3] ?? "";
    const appDir = process.argv[4] ?? process.env.PACKAGE_APP_DIR;
    if (!appDir) {
      console.error("Usage: linux-features.js --package-dependencies <format> <app-dir>");
      process.exit(1);
    }
    for (
      const dependency of enabledLinuxFeaturePackageDependencies(
        { packageFormat, appDir },
      )
    ) {
      process.stdout.write(`${dependency}\n`);
    }
    return;
  }
  if (command === "--package-files") {
    const packageFormat = process.argv[3] ?? "";
    const appDir = process.argv[4] ?? process.env.PACKAGE_APP_DIR;
    if (!appDir) {
      console.error("Usage: linux-features.js --package-files <format> <app-dir>");
      process.exit(1);
    }
    for (
      const file of enabledLinuxFeaturePackageFiles(
        { packageFormat, appDir },
      )
    ) {
      process.stdout.write(`${file}\n`);
    }
    return;
  }
  if (command === "--restore-package-resource-permissions") {
    const packageFormat = process.argv[3] ?? "";
    const packageRoot = process.argv[4] ?? process.env.PACKAGE_ROOT;
    const appDir = process.argv[5] ?? process.env.PACKAGE_APP_DIR;
    if (!packageRoot || !appDir) {
      console.error("Usage: linux-features.js --restore-package-resource-permissions <format> <package-root> <app-dir>");
      process.exit(1);
    }
    restoreEnabledLinuxFeaturePackageResourcePermissions(
      packageRoot,
      { packageFormat, appDir },
    );
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
  console.error("Usage: linux-features.js --enabled | --features-json | --features-root | --stage-install <install-dir> | --staged-files-json <install-dir> | --stage-hooks | --cleanup-hooks | --package-hooks <format> <app-dir> | --stage-package-resources <format> <package-root> <app-dir> | --restore-package-resource-permissions <format> <package-root> <app-dir> | --package-dependencies <format> <app-dir> | --package-files <format> <app-dir>");
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
  disabledLinuxFeatureCleanupHooks,
  discoverLinuxFeatureManifests,
  enabledLinuxFeaturesConfig,
  enabledLinuxFeatureIds,
  enabledFeatureIdsFromBuildInfo,
  enabledLinuxFeatureInstallPlan,
  enabledLinuxFeaturePackageDependencies,
  enabledLinuxFeaturePackageFiles,
  enabledLinuxFeaturePackageHooks,
  enabledLinuxFeaturePackagePlan,
  enabledLinuxFeatureStageHooks,
  featuresJsonSummary,
  loadEnabledLinuxFeatures,
  loadLinuxFeaturePatchDescriptors,
  linuxFeatureManifestMap,
  linuxFeaturesConfigPath,
  linuxFeaturesRoot,
  resolveFeatureEntrypoint,
  restoreEnabledLinuxFeaturePackageResourcePermissions,
  stageEnabledLinuxFeatureInstall,
  stageEnabledLinuxFeaturePackageResources,
  stagedLinuxFeatureFiles,
};
