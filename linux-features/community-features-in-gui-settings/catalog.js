"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CATALOG_ASSET = "webview/assets/community-features-in-gui-settings-catalog.json";
const SNAPSHOT_NAME = "catalog-snapshot.json";
const FEATURE_ID = /^[a-z0-9][a-z0-9-]*$/;
const SETTING_PATH = /^[a-zA-Z][\w]*(?:\.[a-zA-Z][\w]*)*\.enabled$/;

function validateSubfeatures(subfeatures = []) {
  const seen = new Set();
  if (!Array.isArray(subfeatures)) throw Error("community-features-in-gui-settings: invalid subfeatures");
  for (const item of subfeatures) {
    if (typeof item?.id !== "string" || !FEATURE_ID.test(item.id) || seen.has(item.id) ||
        typeof item.title !== "string" || !item.title.trim() || typeof item.description !== "string" ||
        typeof item.settingPath !== "string" || !SETTING_PATH.test(item.settingPath) ||
        item.settingPath.split(".").some((part) => ["__proto__", "prototype", "constructor"].includes(part)) ||
        !["true", "not-false"].includes(item.enabledWhen) || typeof item.nullishFallback !== "boolean" ||
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
  return validateSubfeatures(manifest.catalogSubfeatures.map((item) => ({
    ...item, enabledWhen: item.enabledWhen ?? "true", nullishFallback: item.nullishFallback ?? false,
    defaultEnabled: typeof item.settingPath === "string" ? settingValue(manifest, item.settingPath) : undefined,
    enabled: false,
  })));
}

function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.features) ||
      !(catalog.sourceCommit === null || typeof catalog.sourceCommit === "string" && /^[a-f0-9]{7,40}$/.test(catalog.sourceCommit))) {
    throw Error("community-features-in-gui-settings: invalid catalog snapshot");
  }
  const seen = new Set();
  for (const feature of catalog.features) {
    if (typeof feature?.id !== "string" || !FEATURE_ID.test(feature.id) || seen.has(feature.id) ||
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
    seen.add(feature.id);
  }
  return catalog;
}

function buildCatalog(context = {}) {
  // Descriptor discovery can run inside linux-features.js itself. Resolve its
  // exports only when applying the patch, after discovery has completed.
  const { discoverLinuxFeatureManifests, linuxFeaturesConfig, enabledLinuxFeatureIds, linuxFeaturesRoot } = require("../../scripts/lib/linux-features.js");
  const { sourceInfo } = require("../../scripts/lib/build-info.js");
  const options = context.featurePatchOptions ?? {};
  const root = linuxFeaturesRoot(options);
  const snapshotPath = path.join(context.feature?.dir ?? __dirname, SNAPSHOT_NAME);
  const frozen = fs.existsSync(snapshotPath)
    ? validateCatalog(JSON.parse(fs.readFileSync(snapshotPath, "utf8"))) : null;
  const features = new Map((frozen?.features ?? []).map((feature) => [feature.id, feature]));
  // Only declarative manifests are inspected, including for disabled features.
  // Never load their patch descriptors just to discover UI subfeatures.
  for (const feature of discoverLinuxFeatureManifests(options)) {
    const manifest = feature.manifest;
    if (manifest.internal) { features.delete(feature.id); continue; }
    features.set(feature.id, {
      id: feature.id, title: manifest.title ?? manifest.name ?? feature.id,
      description: manifest.description ?? "", origin: feature.origin,
      requires: manifest.requires, conflicts: manifest.conflicts, subfeatures: catalogSubfeatures(manifest),
    });
  }
  const settings = linuxFeaturesConfig(options).settings;
  const enabled = new Set(context.enabledFeatureIds ?? enabledLinuxFeatureIds(options));
  const revision = frozen?.sourceCommit ?? sourceInfo(path.dirname(root)).commit ?? null;
  return validateCatalog({
    schemaVersion: 1,
    // Nix uses <commit>-dirty for a working tree; snapshots store the Git hash.
    sourceCommit: typeof revision === "string" ? revision.replace(/^([a-f0-9]{7,40})-dirty$/, "$1") : revision,
    features: [...features.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((feature) => ({
      id: feature.id, title: feature.title, description: feature.description, origin: feature.origin,
      requires: feature.requires, conflicts: feature.conflicts, enabled: enabled.has(feature.id),
      subfeatures: (feature.subfeatures ?? []).map((item) => {
        const override = settingValue(settings[feature.id], item.settingPath);
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

function preserveUpdateBuilderCatalog(appDir) {
  const builder = path.join(appDir, "update-builder");
  if (!fs.existsSync(builder)) return false; // AppImage/Nix and updater-free native packages.
  const destination = path.join(builder, "linux-features/community-features-in-gui-settings", SNAPSHOT_NAME);
  const manifest = path.join(builder, ".codex-linux/update-builder-manifest.txt");
  if (!fs.existsSync(path.dirname(destination))) throw Error("community-features-in-gui-settings: update-builder feature is missing");
  const entries = new Set(fs.readFileSync(manifest, "utf8").trim().split("\n").filter(Boolean));
  const catalog = readCatalogFromAsar(path.join(appDir, "resources/app.asar"));
  entries.add(`linux-features/community-features-in-gui-settings/${SNAPSHOT_NAME}`);
  fs.writeFileSync(destination, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(manifest, `${[...entries].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).join("\n")}\n`);
  return true;
}

if (require.main === module) {
  if (process.argv.length !== 3) throw Error("Usage: catalog.js <staged-app-dir>");
  preserveUpdateBuilderCatalog(path.resolve(process.argv[2]));
}

module.exports = { CATALOG_ASSET, SNAPSHOT_NAME, validateCatalog, buildCatalog, readCatalogFromAsar, preserveUpdateBuilderCatalog };
