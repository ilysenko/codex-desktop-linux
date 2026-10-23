"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadLocaleResources(directory = path.join(__dirname, "locales")) {
  const resources = Object.create(null);
  for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort()) {
    const id = name.slice(0, -5);
    const resource = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    resources[id] = resource;
  }
  const fail = (message) => { throw Error(`community-features-in-gui-settings: ${message}`); };
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const canonical = (value) => {
    if (typeof value !== "string") fail("locale IDs and aliases must be strings");
    try { return new Intl.Locale(value.replaceAll("_", "-")).baseName.toLowerCase(); }
    catch { fail(`invalid locale ID or alias: ${value}`); }
  };
  const english = resources.en?.messages;
  if (!object(english) || !Object.keys(english).length) fail("English fallback messages are required");
  const placeholders = (text) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort().join(",");
  const aliases = new Map();
  for (const [id, resource] of Object.entries(resources)) {
    if (!object(resource) || Object.keys(resource).some((key) => !["aliases", "messages", "features"].includes(key)) ||
        !object(resource.messages) || resource.aliases != null && !Array.isArray(resource.aliases) ||
        resource.features != null && !object(resource.features)) fail(`invalid locale resource: ${id}`);
    for (const alias of [id, ...(resource.aliases ?? [])]) {
      const key = canonical(alias), previous = aliases.get(key);
      if (previous != null && previous !== id) fail(`ambiguous locale alias: ${alias}`);
      aliases.set(key, id);
    }
    for (const [key, value] of Object.entries(resource.messages)) {
      if (!Object.hasOwn(english, key) || typeof value !== "string" || !value.trim() ||
          typeof english[key] !== "string" || placeholders(value) !== placeholders(english[key])) {
        fail(`invalid message or placeholders: ${id}.${key}`);
      }
    }
    for (const [featureId, feature] of Object.entries(resource.features ?? {})) {
      if (!/^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)?$/.test(featureId) || !object(feature) ||
          Object.entries(feature).some(([key, value]) => !["title", "description"].includes(key) || typeof value !== "string" || !value.trim())) {
        fail(`invalid feature translation: ${id}.${featureId}`);
      }
    }
  }
  return resources;
}

// Self-contained for embedding in the upstream renderer. Resource files are
// discovered and validated at build time; there are no runtime file/network reads.
function createTranslator(locale, resources) {
  const normalize = (tag) => new Intl.Locale(String(tag).replaceAll("_", "-"));
  const aliases = new Map();
  for (const [id, resource] of Object.entries(resources)) {
    for (const alias of [id, ...(resource.aliases ?? [])]) aliases.set(normalize(alias).baseName.toLowerCase(), id);
  }
  let resolved = "en";
  try {
    const requested = normalize(locale ?? "en"), script = requested.maximize().script;
    const candidates = [requested.baseName, [requested.language, requested.script].filter(Boolean).join("-"),
      [requested.language, requested.region].filter(Boolean).join("-"), requested.language];
    for (const candidate of candidates) {
      const id = aliases.get(candidate.toLowerCase());
      if (id != null && normalize(id).maximize().script === script) { resolved = id; break; }
    }
  } catch { /* Malformed or unsupported application locales use English. */ }
  const english = resources.en, resource = resources[resolved];
  const messages = { ...english.messages, ...resource.messages };
  const lookup = (table, id) => table && Object.hasOwn(table, id) ? table[id] : {};
  const featureText = (feature, id) => {
    const fallback = lookup(english.features, id), translated = lookup(resource.features, id);
    return { ...feature, title: translated.title ?? fallback.title ?? feature.title,
      description: translated.description ?? fallback.description ?? feature.description };
  };
  return {
    locale: resolved, messages,
    format: (key, values = {}) => messages[key].replace(/\{(\w+)\}/g,
      (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match),
    feature: (feature) => {
      return { ...featureText(feature, feature.id),
        subfeatures: (feature.subfeatures ?? []).map((item) => featureText(item, `${feature.id}/${item.id}`)) };
    },
  };
}

module.exports = { loadLocaleResources, createTranslator };
