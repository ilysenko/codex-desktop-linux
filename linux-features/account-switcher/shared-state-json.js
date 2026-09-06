#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TOP_LEVEL_KEYS = [
  "local-projects",
  "project-order",
  "selected-project",
  "thread-project-assignments",
  "projectless-thread-ids",
  "thread-projectless-output-directories",
  "thread-writable-roots",
];
const ATOM_EXACT_KEYS = [
  "client-thread-bindings-v1",
  "thread-descriptions-v1",
  "unread-thread-ids-by-host-v1",
];
const ATOM_PREFIXES = [
  "thread-reference-capability:",
  "thread-client-id-v1:",
  "sidebar-project-expanded-v1-codex:",
];

function readJson(file, missing = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return missing;
    throw new Error(`could not read ${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const fd = fs.openSync(temporary, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

function isAtomKey(key) {
  return ATOM_EXACT_KEYS.includes(key) || ATOM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeSharedValue(previous, incoming) {
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    return [...new Set([...previous, ...incoming])];
  }
  if (isRecord(previous) && isRecord(incoming)) {
    const merged = { ...previous };
    for (const [key, value] of Object.entries(incoming)) {
      merged[key] = Object.hasOwn(previous, key) ? mergeSharedValue(previous[key], value) : value;
    }
    return merged;
  }
  return incoming;
}

function extract(globalState) {
  const state = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (Object.hasOwn(globalState, key)) state[key] = globalState[key];
  }
  const atom = globalState["electron-persisted-atom-state"];
  state.atom = {};
  if (atom && typeof atom === "object" && !Array.isArray(atom)) {
    for (const [key, value] of Object.entries(atom)) {
      if (isAtomKey(key)) state.atom[key] = value;
    }
  }
  return { version: 1, ...state };
}

function applyShared(globalState, sharedState) {
  for (const key of TOP_LEVEL_KEYS) {
    if (Object.hasOwn(sharedState, key)) {
      globalState[key] = Object.hasOwn(globalState, key)
        ? mergeSharedValue(globalState[key], sharedState[key])
        : sharedState[key];
    }
  }

  const atom = globalState["electron-persisted-atom-state"];
  const nextAtom = atom && typeof atom === "object" && !Array.isArray(atom) ? { ...atom } : {};
  if (sharedState.atom && typeof sharedState.atom === "object" && !Array.isArray(sharedState.atom)) {
    for (const [key, value] of Object.entries(sharedState.atom)) {
      nextAtom[key] = Object.hasOwn(nextAtom, key) ? mergeSharedValue(nextAtom[key], value) : value;
    }
  }
  globalState["electron-persisted-atom-state"] = nextAtom;
  return globalState;
}

function prepare(sourceFile, targetFile, sharedFile) {
  const source = readJson(sourceFile, null);
  const previousRaw = readJson(sharedFile);
  const previous = { version: 1, atom: {} };
  for (const key of TOP_LEVEL_KEYS) {
    if (Object.hasOwn(previousRaw, key)) previous[key] = previousRaw[key];
  }
  if (previousRaw.atom && typeof previousRaw.atom === "object" && !Array.isArray(previousRaw.atom)) {
    for (const [key, value] of Object.entries(previousRaw.atom)) {
      if (isAtomKey(key)) previous.atom[key] = value;
    }
  }
  const extracted = source == null ? {} : extract(source);
  const shared = mergeSharedValue(previous, extracted);
  const target = readJson(targetFile);
  applyShared(target, shared);
  writeJson(sharedFile, shared);
  writeJson(targetFile, target);
}

if (process.argv[2] !== "prepare" || process.argv.length !== 6) {
  console.error("usage: shared-state-json.js prepare SOURCE_GLOBAL TARGET_GLOBAL SHARED_STATE");
  process.exit(2);
}

try {
  prepare(process.argv[3], process.argv[4], process.argv[5]);
} catch (error) {
  console.error(`account-switcher: ${error.message}`);
  process.exit(1);
}
