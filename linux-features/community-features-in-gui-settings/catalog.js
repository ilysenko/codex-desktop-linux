"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_ASSET = "webview/assets/community-features-in-gui-settings-catalog.json";
const CATALOG_NAME = "catalog.json";
const SNAPSHOT_NAME = "catalog-snapshot.json";
const FEATURE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_COMMIT = /^(?:[a-f0-9]{7,40}|[a-f0-9]{64})$/;
const SETTING_PATH = /^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)*\.enabled$/;

function validateSubfeatures(subfeatures = []) {
  const seen = new Set();
  if (!Array.isArray(subfeatures)) throw Error("community-features-in-gui-settings: invalid subfeatures");
  for (const item of subfeatures) {
    const inheritsParent = item?.enabledWhen === "parent";
    if (typeof item?.id !== "string" || !FEATURE_ID.test(item.id) || seen.has(item.id) ||
        typeof item.title !== "string" || !item.title.trim() || typeof item.description !== "string" ||
        (inheritsParent
          ? Object.hasOwn(item, "settingPath") || Object.hasOwn(item, "nullishFallback") || item.defaultEnabled !== true
          : typeof item.settingPath !== "string" || !SETTING_PATH.test(item.settingPath) ||
            item.settingPath.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)) ||
            !["true", "not-false"].includes(item.enabledWhen) || typeof item.nullishFallback !== "boolean") ||
        typeof item.defaultEnabled !== "boolean" || typeof item.enabled !== "boolean") {
      throw Error("community-features-in-gui-settings: invalid or duplicate subfeature");
    }
    seen.add(item.id);
  }
  return subfeatures;
}

function settingValue(settings, settingPath) {
  return settingPath.split(".").reduce((value, part) => value != null && typeof value === "object" &&
    !Array.isArray(value) && Object.hasOwn(value, part) ? value[part] : undefined, settings);
}

function catalogSubfeatures(manifest) {
  if (manifest.catalogSubfeatures == null) return [];
  if (!Array.isArray(manifest.catalogSubfeatures)) throw Error("community-features-in-gui-settings: invalid subfeatures");
  return validateSubfeatures(manifest.catalogSubfeatures.map((item) => item?.enabledWhen === "parent"
    ? { ...item, defaultEnabled: true, enabled: false }
    : {
      ...item, enabledWhen: item?.enabledWhen ?? "true", nullishFallback: item?.nullishFallback ?? false,
      defaultEnabled: typeof item?.settingPath === "string" ? settingValue(manifest, item.settingPath) : undefined,
      enabled: false,
    }));
}

function validateCatalogFeature(feature) {
  if (typeof feature?.id !== "string" || !FEATURE_ID.test(feature.id) ||
      typeof feature.title !== "string" || !feature.title.trim() ||
      typeof feature.description !== "string" ||
      !["repo", "local"].includes(feature.origin) || typeof feature.enabled !== "boolean" ||
      ["requires", "conflicts"].some((key) => !Array.isArray(feature[key]) ||
        feature[key].some((id) => typeof id !== "string" || !FEATURE_ID.test(id)))) {
    throw Error("community-features-in-gui-settings: invalid or duplicate catalog feature");
  }
  validateSubfeatures(feature.subfeatures);
  if (feature.enabled === false && feature.subfeatures?.some((item) => item.enabled)) {
    throw Error("community-features-in-gui-settings: enabled subfeature has a disabled parent");
  }
  if (feature.subfeatures?.some((item) => item.enabledWhen === "parent" && item.enabled !== feature.enabled)) {
    throw Error("community-features-in-gui-settings: subfeature must inherit its parent's build status");
  }
  return feature;
}

function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.features) ||
      !(catalog.sourceCommit === null || typeof catalog.sourceCommit === "string" && SOURCE_COMMIT.test(catalog.sourceCommit))) {
    throw Error("community-features-in-gui-settings: invalid catalog snapshot");
  }
  const seen = new Set();
  for (const feature of catalog.features) {
    validateCatalogFeature(feature);
    if (seen.has(feature.id)) {
      throw Error("community-features-in-gui-settings: invalid or duplicate catalog feature");
    }
    seen.add(feature.id);
  }
  return catalog;
}

function catalogFeatureFromManifest(id, manifest, origin) {
  return validateCatalogFeature({
    id, title: manifest.title ?? manifest.name ?? id,
    description: manifest.description ?? "", origin, enabled: false,
    requires: manifest.requires ?? [], conflicts: manifest.conflicts ?? [], subfeatures: catalogSubfeatures(manifest),
  });
}

function validatePackagedCatalog(catalog) {
  validateCatalog(catalog);
  if (catalog.features.some((feature) => feature.origin === "local" && !feature.enabled)) {
    throw Error("community-features-in-gui-settings: packaged catalog contains disabled local metadata");
  }
  return catalog;
}

function buildCatalog(context = {}, onWarning = console.warn) {
  // Descriptor discovery can run inside linux-features.js itself. Resolve its
  // exports only when applying the patch, after discovery has completed.
  const { discoverLinuxFeatureManifests, loadEnabledLinuxFeatures, enabledLinuxFeatureIds, linuxFeaturesRoot } = require("../../scripts/lib/linux-features.js");
  const { sourceInfo } = require("../../scripts/lib/build-info.js");
  const options = context.featurePatchOptions ?? {};
  const root = linuxFeaturesRoot(options);
  const snapshotPath = path.join(context.feature?.dir ?? __dirname, CATALOG_NAME);
  // Package staging creates this resource only in the selected feature tree.
  // The updater copies that tree but omits top-level .codex-linux metadata.
  const snapshot = fs.existsSync(snapshotPath)
    ? validatePackagedCatalog(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))) : null;
  // Never revive local metadata from a previous build's snapshot. Selected
  // local entries are recomputed below from the implementations still present.
  const features = new Map((snapshot?.features ?? []).filter((feature) => feature.origin === "repo")
    .map((feature) => [feature.id, feature]));
  const enabled = new Set(context.enabledFeatureIds ?? enabledLinuxFeatureIds(options));
  const selected = loadEnabledLinuxFeatures({ ...options, enabledFeatureIds: [...enabled] });
  const settings = new Map(selected.map((feature) => [feature.id, feature.settings]));
  // Inspect declarations only, including disabled public features. Loading a
  // patch descriptor just to discover display metadata would run feature code.
  for (const feature of discoverLinuxFeatureManifests(options)) {
    if (feature.manifest.internal || feature.origin === "local" && !enabled.has(feature.id)) {
      features.delete(feature.id);
      continue;
    }
    try {
      features.set(feature.id, catalogFeatureFromManifest(feature.id, feature.manifest, feature.origin));
    } catch (error) {
      // Display-only metadata must not add build failures for other features.
      features.delete(feature.id);
      onWarning(`WARN: community-features-in-gui-settings: skipping invalid catalog metadata for '${feature.id}': ${error.message}`);
    }
  }
  const revision = sourceInfo(path.dirname(root)).commit ?? snapshot?.sourceCommit ?? null;
  // Nix uses <commit>-dirty for a working tree; snapshots store the Git hash.
  const sourceCommit = typeof revision === "string" && revision.endsWith("-dirty") && SOURCE_COMMIT.test(revision.slice(0, -6))
    ? revision.slice(0, -6) : revision;
  return validateCatalog({
    schemaVersion: 1,
    sourceCommit,
    features: [...features.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((feature) => ({
      id: feature.id, title: feature.title, description: feature.description, origin: feature.origin,
      requires: feature.requires, conflicts: feature.conflicts, enabled: enabled.has(feature.id),
      subfeatures: (feature.subfeatures ?? []).map((item) => {
        if (item.enabledWhen === "parent") return { ...item, enabled: enabled.has(feature.id) };
        const override = settingValue(settings.get(feature.id), item.settingPath);
        const value = override === undefined || item.nullishFallback && override === null ? item.defaultEnabled : override;
        return { ...item, enabled: enabled.has(feature.id) && (item.enabledWhen === "true" ? value === true : value !== false) };
      }),
    })),
  });
}

// Packaging reads only our small generated JSON asset; upstream JS is never
// evaluated. Bound both ASAR reads so malformed metadata fails before writes.
function readCatalogFromAsar(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const prefix = Buffer.alloc(16);
    if (fs.readSync(fd, prefix, 0, 16, 0) !== 16 || prefix.readUInt32LE(0) !== 4) {
      throw Error("community-features-in-gui-settings: invalid ASAR header");
    }
    const headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (headerSize < 8 || jsonSize > 64 * 1024 * 1024 || jsonSize + 8 > headerSize || headerSize + 8 > size) {
      throw Error("community-features-in-gui-settings: invalid ASAR header bounds");
    }
    const header = Buffer.alloc(jsonSize);
    if (fs.readSync(fd, header, 0, jsonSize, 16) !== jsonSize) throw Error("community-features-in-gui-settings: incomplete ASAR header");
    let entry = JSON.parse(header.toString("utf8"));
    for (const part of CATALOG_ASSET.split("/")) entry = entry?.files?.[part];
    if (!entry || entry.unpacked || !/^\d+$/.test(entry.offset) ||
        !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 2 * 1024 * 1024) {
      throw Error("community-features-in-gui-settings: packaged catalog missing or invalid");
    }
    const offset = 8 + headerSize + Number(entry.offset);
    if (!Number.isSafeInteger(offset) || offset + entry.size > size) throw Error("community-features-in-gui-settings: invalid catalog bounds");
    const data = Buffer.alloc(entry.size);
    if (fs.readSync(fd, data, 0, data.length, offset) !== data.length) throw Error("community-features-in-gui-settings: incomplete catalog");
    return validateCatalog(JSON.parse(data.toString("utf8")));
  } finally { fs.closeSync(fd); }
}

function prepareUpdateBuilderCatalog(appDir) {
  const builder = path.join(appDir, "update-builder");
  if (!fs.existsSync(builder)) return false; // AppImage/Nix and updater-free native packages.
  const featureDir = path.join(builder, "linux-features/community-features-in-gui-settings");
  const builderCatalogPath = path.join(featureDir, CATALOG_NAME);
  const legacySnapshot = path.join(featureDir, SNAPSHOT_NAME);
  const manifest = path.join(builder, ".codex-linux/update-builder-manifest.txt");
  if (!fs.statSync(featureDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw Error("community-features-in-gui-settings: update-builder feature is missing");
  }
  const entries = new Set(fs.readFileSync(manifest, "utf8").trim().split("\n").filter(Boolean));
  const catalog = validatePackagedCatalog(readCatalogFromAsar(path.join(appDir, "resources/app.asar")));
  // Snapshot the actual built view into package staging, never the source tree.
  fs.writeFileSync(builderCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  // The former whole-build snapshot could retain disabled private entries.
  // Remove only that owned file from package staging; never touch the source.
  fs.rmSync(legacySnapshot, { force: true });
  entries.delete(`linux-features/community-features-in-gui-settings/${SNAPSHOT_NAME}`);
  entries.add(`linux-features/community-features-in-gui-settings/${CATALOG_NAME}`);
  fs.writeFileSync(manifest, `${[...entries].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join("\n")}\n`);
  return true;
}

if (require.main === module) {
  if (process.argv.length !== 3) throw Error("Usage: catalog.js <staged-app-dir>");
  prepareUpdateBuilderCatalog(path.resolve(process.argv[2]));
}

module.exports = { CATALOG_ASSET, CATALOG_NAME, SNAPSHOT_NAME, validateCatalog,
  buildCatalog, readCatalogFromAsar, prepareUpdateBuilderCatalog };
