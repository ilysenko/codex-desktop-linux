#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const DEFAULT_POLICY_PATH = ".github/labels.json";
const MAX_PAGES = 100;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const VALID_APPLIES_TO = new Set(["issue", "pull_request"]);
const VALID_CARDINALITIES = new Set([
  "exactly_one",
  "one_or_more",
  "zero_or_one",
  "zero_or_more",
]);

function validRepository(value) {
  if (typeof value !== "string") return false;
  const segments = value.split("/");
  return (
    segments.length === 2 &&
    segments.every((segment) => (
      /^[A-Za-z0-9_.-]{1,100}$/.test(segment) &&
      segment !== "." &&
      segment !== ".."
    ))
  );
}

function normalizeName(value) {
  return value.toLowerCase();
}

function itemKey(item) {
  return `${item.kind}:${item.number}`;
}

function stableState(state, names) {
  const selected = new Set(names.map(normalizeName));
  const labels = state.labels
    .filter((entry) => selected.has(normalizeName(entry.name)))
    .map((entry) => ({
      color: entry.color.toUpperCase(),
      description: entry.description || "",
      name: entry.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const associations = {};

  for (const labelEntry of labels) {
    const actualName = Object.keys(state.associations || {}).find(
      (name) => normalizeName(name) === normalizeName(labelEntry.name),
    );
    associations[labelEntry.name] = [...((actualName && state.associations[actualName]) || [])]
      .map((item) => ({
        kind: item.kind,
        number: item.number,
        state: item.state,
        url: item.url,
      }))
      .sort((left, right) => itemKey(left).localeCompare(itemKey(right)));
  }

  return { associations, labels };
}

function stateFingerprint(state, names) {
  return crypto.createHash("sha256").update(JSON.stringify(stableState(state, names))).digest("hex");
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Label policy must be a JSON object.");
  }
  if (policy.schemaVersion !== 1) {
    throw new Error("schemaVersion must be 1.");
  }
  if (policy.staffManaged !== true) {
    throw new Error("staffManaged must be true.");
  }
  for (const key of ["groups", "labels", "migrations", "retiredLabels"]) {
    if (!Array.isArray(policy[key])) {
      throw new Error(`${key} must be an array.`);
    }
  }

  const groups = new Map();
  for (const group of policy.groups) {
    if (!group || typeof group !== "object" || !/^[a-z][a-z0-9-]*$/.test(group.id || "")) {
      throw new Error("Each group id must use lowercase letters, digits, and hyphens.");
    }
    if (groups.has(group.id)) {
      throw new Error(`Duplicate group id: ${group.id}.`);
    }
    if (!VALID_CARDINALITIES.has(group.cardinality)) {
      throw new Error(`Group ${group.id} has an unsupported cardinality.`);
    }
    if (
      !Array.isArray(group.appliesTo) ||
      group.appliesTo.length === 0 ||
      group.appliesTo.some((value) => !VALID_APPLIES_TO.has(value)) ||
      new Set(group.appliesTo).size !== group.appliesTo.length
    ) {
      throw new Error(`Group ${group.id} has invalid appliesTo values.`);
    }
    groups.set(group.id, group);
  }

  const desiredNames = new Map();
  for (const labelEntry of policy.labels) {
    if (!labelEntry || typeof labelEntry !== "object") {
      throw new Error("Each label must be an object.");
    }
    if (
      typeof labelEntry.name !== "string" ||
      labelEntry.name !== labelEntry.name.trim() ||
      labelEntry.name.length === 0 ||
      labelEntry.name.length > 50 ||
      /[\u0000-\u001f\u007f,]/.test(labelEntry.name)
    ) {
      throw new Error("Each label name must be printable, trimmed, and 50 characters or fewer.");
    }
    const normalized = normalizeName(labelEntry.name);
    if (desiredNames.has(normalized)) {
      throw new Error(`Duplicate label name: ${labelEntry.name}.`);
    }
    if (!/^[0-9A-F]{6}$/.test(labelEntry.color || "")) {
      throw new Error(`Label ${labelEntry.name} color must be six uppercase hexadecimal characters.`);
    }
    if (
      typeof labelEntry.description !== "string" ||
      labelEntry.description.length === 0 ||
      labelEntry.description.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(labelEntry.description)
    ) {
      throw new Error(`Label ${labelEntry.name} description must be printable and 100 characters or fewer.`);
    }
    if (!groups.has(labelEntry.group)) {
      throw new Error(`Label ${labelEntry.name} references unknown group ${labelEntry.group}.`);
    }
    desiredNames.set(normalized, labelEntry);
  }

  for (const groupId of groups.keys()) {
    if (!policy.labels.some((labelEntry) => labelEntry.group === groupId)) {
      throw new Error(`Group ${groupId} has no labels.`);
    }
  }

  const migrationSources = new Set();
  for (const migration of policy.migrations) {
    if (
      !migration ||
      typeof migration.from !== "string" ||
      typeof migration.to !== "string" ||
      migration.from.length === 0 ||
      migration.from.length > 50 ||
      /[\u0000-\u001f\u007f,]/.test(migration.from)
    ) {
      throw new Error("Each migration needs printable from and to label names.");
    }
    const source = normalizeName(migration.from);
    const target = normalizeName(migration.to);
    if (source === target) {
      throw new Error(`Migration source and target are identical: ${migration.from}.`);
    }
    if (migrationSources.has(source)) {
      throw new Error(`Duplicate migration source: ${migration.from}.`);
    }
    if (!desiredNames.has(target)) {
      throw new Error(`Migration target ${migration.to} is not a desired label.`);
    }
    migrationSources.add(source);
  }

  const retiredNames = new Set();
  for (const retired of policy.retiredLabels) {
    if (
      !retired ||
      typeof retired.name !== "string" ||
      retired.name.length === 0 ||
      retired.name.length > 50 ||
      /[\u0000-\u001f\u007f,]/.test(retired.name) ||
      typeof retired.reason !== "string" ||
      retired.reason.length === 0 ||
      retired.reason.length > 200
    ) {
      throw new Error("Each retired label needs a valid name and a reason of 200 characters or fewer.");
    }
    const normalized = normalizeName(retired.name);
    if (retiredNames.has(normalized)) {
      throw new Error(`Duplicate retired label: ${retired.name}.`);
    }
    if (desiredNames.has(normalized)) {
      throw new Error(`Desired label ${retired.name} cannot also be retired.`);
    }
    retiredNames.add(normalized);
  }

  for (const migration of policy.migrations) {
    if (!retiredNames.has(normalizeName(migration.from))) {
      throw new Error(`Migration source ${migration.from} must also be listed as retired.`);
    }
  }

  return policy;
}

function validateSnapshot(snapshot) {
  if (
    !snapshot ||
    snapshot.schemaVersion !== 1 ||
    !validRepository(snapshot.repository) ||
    !snapshot.state ||
    !Array.isArray(snapshot.state.labels) ||
    !snapshot.state.associations ||
    typeof snapshot.state.associations !== "object" ||
    Array.isArray(snapshot.state.associations)
  ) {
    throw new Error("Snapshot does not contain a valid repository label state.");
  }

  const labels = new Map();
  for (const entry of snapshot.state.labels) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      entry.name.length > 50 ||
      /[\u0000-\u001f\u007f]/.test(entry.name) ||
      !/^[0-9A-Fa-f]{6}$/.test(entry.color || "") ||
      typeof entry.description !== "string" ||
      entry.description.length > 100 ||
      /[\u0000-\u001f\u007f]/.test(entry.description)
    ) {
      throw new Error("Snapshot contains an invalid label definition.");
    }
    const normalized = normalizeName(entry.name);
    if (labels.has(normalized)) {
      throw new Error(`Snapshot contains duplicate label ${entry.name}.`);
    }
    labels.set(normalized, entry);
  }

  for (const [name, items] of Object.entries(snapshot.state.associations)) {
    if (!labels.has(normalizeName(name)) || !Array.isArray(items)) {
      throw new Error(`Snapshot associations reference unknown label ${name}.`);
    }
    const seen = new Set();
    for (const item of items) {
      const validKind = item?.kind === "issue" || item?.kind === "pull_request";
      const expectedPath = item?.kind === "pull_request" ? "pull" : "issues";
      const expectedUrl = validKind
        ? `https://github.com/${snapshot.repository}/${expectedPath}/${item.number}`
        : "";
      if (
        !validKind ||
        !Number.isSafeInteger(item.number) ||
        item.number < 1 ||
        !["open", "closed"].includes(item.state) ||
        item.url !== expectedUrl
      ) {
        throw new Error(`Snapshot contains an invalid association for ${name}.`);
      }
      const key = itemKey(item);
      if (seen.has(key)) {
        throw new Error(`Snapshot contains duplicate association ${key} for ${name}.`);
      }
      seen.add(key);
    }
  }
  return snapshot;
}

async function loadJson(filePath, maxBytes = MAX_RESPONSE_BYTES) {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`${filePath} exceeds the ${maxBytes}-byte safety limit.`);
  }
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${filePath} is not valid JSON.`);
  }
}

async function loadPolicy(filePath) {
  return validatePolicy(await loadJson(filePath, 1024 * 1024));
}

function currentLabelMap(state) {
  return new Map(state.labels.map((entry) => [normalizeName(entry.name), entry]));
}

function associationList(state, name) {
  const actualName = Object.keys(state.associations || {}).find(
    (candidate) => normalizeName(candidate) === normalizeName(name),
  );
  return actualName ? state.associations[actualName] : [];
}

function desiredLabel(labelEntry) {
  return {
    name: labelEntry.name,
    color: labelEntry.color,
    description: labelEntry.description,
  };
}

function buildClassificationAssessment(policy, state) {
  const groups = new Map(policy.groups.map((group) => [group.id, group]));
  const desired = new Map(
    policy.labels.map((labelEntry) => [normalizeName(labelEntry.name), labelEntry]),
  );
  const projected = new Map();

  function attach(labelEntry, item) {
    const key = itemKey(item);
    const classification = projected.get(key) || { groups: new Map(), item };
    const labels = classification.groups.get(labelEntry.group) || new Set();
    labels.add(labelEntry.name);
    classification.groups.set(labelEntry.group, labels);
    projected.set(key, classification);
  }

  for (const labelEntry of policy.labels) {
    for (const item of associationList(state, labelEntry.name)) attach(labelEntry, item);
  }
  for (const migration of policy.migrations) {
    const target = desired.get(normalizeName(migration.to));
    for (const item of associationList(state, migration.from)) attach(target, item);
  }

  const blockers = [];
  const warnings = [];
  for (const { groups: itemGroups, item } of projected.values()) {
    for (const [groupId, names] of itemGroups) {
      const group = groups.get(groupId);
      if (!group.appliesTo.includes(item.kind)) {
        blockers.push({
          item,
          label: groupId,
          reason: `${[...names].join(", ")} does not apply to ${item.kind}`,
        });
        continue;
      }
      if (
        ["exactly_one", "zero_or_one"].includes(group.cardinality) &&
        names.size > 1
      ) {
        blockers.push({
          item,
          label: groupId,
          reason: `projected ${groupId} labels conflict: ${[...names].sort().join(", ")}`,
        });
      }
    }
    if (item.state === "open") {
      for (const group of groups.values()) {
        if (
          group.appliesTo.includes(item.kind) &&
          ["exactly_one", "one_or_more"].includes(group.cardinality) &&
          !itemGroups.has(group.id)
        ) {
          warnings.push({
            item,
            label: group.id,
            reason: `open item still needs required ${group.id} classification`,
          });
        }
      }
    }
  }
  const order = (left, right) => (
    itemKey(left.item).localeCompare(itemKey(right.item)) ||
    left.label.localeCompare(right.label)
  );
  return { blockers: blockers.sort(order), warnings: warnings.sort(order) };
}

function buildApplyPlan(policy, state) {
  validatePolicy(policy);
  const assessment = buildClassificationAssessment(policy, state);
  if (assessment.blockers.length !== 0) {
    return { ...assessment, operations: [] };
  }
  const operations = [];
  const current = currentLabelMap(state);
  const migrationsByTarget = new Map();

  for (const migration of policy.migrations) {
    const target = normalizeName(migration.to);
    const entries = migrationsByTarget.get(target) || [];
    entries.push(migration);
    migrationsByTarget.set(target, entries);
  }

  for (const configured of policy.labels) {
    const normalizedTarget = normalizeName(configured.name);
    const migrations = migrationsByTarget.get(normalizedTarget) || [];
    let existingTarget = current.get(normalizedTarget);
    let renamedSource = null;
    let targetAssociations = new Set(associationList(state, configured.name).map(itemKey));

    if (!existingTarget) {
      const primary = migrations.find((migration) => current.has(normalizeName(migration.from)));
      if (primary) {
        const source = current.get(normalizeName(primary.from));
        operations.push({
          kind: "rename",
          from: source.name,
          to: configured.name,
          color: configured.color,
          description: configured.description,
        });
        renamedSource = normalizeName(primary.from);
        for (const item of associationList(state, source.name)) {
          targetAssociations.add(itemKey(item));
        }
        current.delete(renamedSource);
        existingTarget = desiredLabel(configured);
        current.set(normalizedTarget, existingTarget);
      } else {
        operations.push({ kind: "create", label: desiredLabel(configured) });
        existingTarget = desiredLabel(configured);
        current.set(normalizedTarget, existingTarget);
      }
    } else if (
      existingTarget.name !== configured.name ||
      existingTarget.color.toUpperCase() !== configured.color ||
      (existingTarget.description || "") !== configured.description
    ) {
      const operation = {
        kind: "update",
        name: configured.name,
        color: configured.color,
        description: configured.description,
      };
      if (existingTarget.name !== configured.name) {
        operation.from = existingTarget.name;
      }
      operations.push(operation);
    }

    for (const migration of migrations) {
      const normalizedSource = normalizeName(migration.from);
      const source = current.get(normalizedSource);
      if (!source || normalizedSource === renamedSource) {
        continue;
      }
      for (const item of associationList(state, source.name)) {
        const key = itemKey(item);
        if (!targetAssociations.has(key)) {
          operations.push({ kind: "add", name: configured.name, item });
          targetAssociations.add(key);
        }
      }
    }
  }

  return assessment.warnings.length === 0
    ? { operations }
    : { operations, warnings: assessment.warnings };
}

function buildRetirementPlan(policy, state) {
  validatePolicy(policy);
  const current = currentLabelMap(state);
  const migrationBySource = new Map(
    policy.migrations.map((migration) => [normalizeName(migration.from), migration]),
  );
  const blockers = [];
  const candidates = [];

  for (const retired of policy.retiredLabels) {
    const normalizedSource = normalizeName(retired.name);
    const source = current.get(normalizedSource);
    if (!source) {
      continue;
    }
    const sourceAssociations = associationList(state, source.name);
    const migration = migrationBySource.get(normalizedSource);
    const target = migration ? current.get(normalizeName(migration.to)) : null;
    const targetAssociations = new Set(
      target ? associationList(state, target.name).map(itemKey) : [],
    );

    for (const item of sourceAssociations.filter((entry) => entry.state === "open")) {
      if (!target || !targetAssociations.has(itemKey(item))) {
        blockers.push({
          label: source.name,
          item,
          reason: migration
            ? `open item is missing replacement ${migration.to}`
            : "open item has no governed replacement",
        });
      }
    }
    candidates.push({ kind: "delete", name: source.name, associationCount: sourceAssociations.length });
  }

  return { blockers, operations: blockers.length === 0 ? candidates : [] };
}

function buildRestorePlan(policy, snapshot, currentState) {
  validatePolicy(policy);
  validateSnapshot(snapshot);
  const current = currentLabelMap(currentState);
  const snapshotLabels = currentLabelMap(snapshot.state);
  const operations = [];

  for (const retired of policy.retiredLabels) {
    const normalized = normalizeName(retired.name);
    const saved = snapshotLabels.get(normalized);
    if (!saved) {
      continue;
    }
    const existing = current.get(normalized);
    if (!existing) {
      operations.push({ kind: "create", label: desiredLabel(saved) });
    } else if (
      existing.name !== saved.name ||
      existing.color.toUpperCase() !== saved.color.toUpperCase() ||
      (existing.description || "") !== saved.description
    ) {
      const operation = {
        kind: "update",
        name: saved.name,
        color: saved.color.toUpperCase(),
        description: saved.description,
      };
      if (existing.name !== saved.name) operation.from = existing.name;
      operations.push(operation);
    }
    const currentItems = new Set(associationList(currentState, retired.name).map(itemKey));
    for (const item of associationList(snapshot.state, saved.name)) {
      if (!currentItems.has(itemKey(item))) {
        operations.push({ kind: "add", name: saved.name, item });
      }
    }
  }
  return { operations };
}

function assertSnapshotMatches(snapshot, repository, currentState, names) {
  validateSnapshot(snapshot);
  if (!snapshot || snapshot.repository !== repository) {
    throw new Error(`Snapshot belongs to ${snapshot?.repository || "an unknown repository"}, not ${repository}.`);
  }
  if (!snapshot.state || !Array.isArray(snapshot.state.labels)) {
    throw new Error("Snapshot does not contain a valid label state.");
  }
  if (stateFingerprint(snapshot.state, names) !== stateFingerprint(currentState, names)) {
    throw new Error("Live labels changed after the snapshot; capture a new snapshot before retirement.");
  }
}

function assertRetirementSnapshotMatches(
  snapshot,
  repository,
  currentState,
  retiredNames,
) {
  validateSnapshot(snapshot);
  if (snapshot.repository !== repository) {
    throw new Error(`Snapshot belongs to ${snapshot.repository}, not ${repository}.`);
  }
  const retired = new Set(retiredNames.map(normalizeName));
  const protectedNames = new Set();
  for (const entry of [...snapshot.state.labels, ...currentState.labels]) {
    if (!retired.has(normalizeName(entry.name))) protectedNames.add(entry.name);
  }
  if (
    stateFingerprint(snapshot.state, [...protectedNames]) !==
    stateFingerprint(currentState, [...protectedNames])
  ) {
    throw new Error("Non-retired labels changed after the snapshot; capture a new snapshot.");
  }

  const current = currentLabelMap(currentState);
  for (const name of retiredNames) {
    if (!current.has(normalizeName(name))) {
      continue;
    }
    if (stateFingerprint(snapshot.state, [name]) !== stateFingerprint(currentState, [name])) {
      throw new Error(`Retired label ${name} changed after the snapshot; capture a new snapshot.`);
    }
  }
}

function parseArguments(argv) {
  const result = {
    action: "plan",
    confirmation: "",
    policyPath: DEFAULT_POLICY_PATH,
    repository: "",
    snapshotPath: "",
  };
  let explicitAction = false;

  function setAction(action, snapshotPath = "") {
    if (explicitAction) {
      throw new Error("Choose exactly one action.");
    }
    explicitAction = true;
    result.action = action;
    result.snapshotPath = snapshotPath;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${argument} requires a value.`);
      }
      return argv[index];
    };
    if (argument === "--repo") result.repository = next();
    else if (argument === "--policy") result.policyPath = next();
    else if (argument === "--confirm") result.confirmation = next();
    else if (argument === "--check") setAction("check");
    else if (argument === "--plan") setAction("plan");
    else if (argument === "--apply") setAction("apply");
    else if (argument === "--snapshot") setAction("snapshot", next());
    else if (argument === "--retire") setAction("retire", next());
    else if (argument === "--restore") setAction("restore", next());
    else throw new Error(`Unknown argument: ${argument}.`);
  }

  if (result.action !== "check" && !validRepository(result.repository)) {
    throw new Error("--repo must use the owner/repository form.");
  }
  const expectedConfirmations = { apply: "APPLY", retire: "RETIRE", restore: "RESTORE" };
  const expected = expectedConfirmations[result.action];
  if (expected && result.confirmation !== expected) {
    throw new Error(`${result.action} requires --confirm ${expected}.`);
  }
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class GitHubClient {
  constructor({ fetchImpl = globalThis.fetch, repository, token = "" }) {
    if (typeof fetchImpl !== "function") {
      throw new Error("This command requires a Node.js runtime with fetch support.");
    }
    if (!validRepository(repository)) {
      throw new Error("Repository must use the owner/repository form.");
    }
    this.fetchImpl = fetchImpl;
    this.repository = repository;
    this.token = token;
  }

  async request(method, endpoint, body = undefined) {
    const retryable = method === "GET";
    const maxAttempts = retryable ? 3 : 1;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers = {
          accept: "application/vnd.github+json",
          "x-github-api-version": API_VERSION,
        };
        if (this.token) headers.authorization = `Bearer ${this.token}`;
        if (body !== undefined) headers["content-type"] = "application/json";
        const response = await this.fetchImpl(`${API_BASE_URL}${endpoint}`, {
          body: body === undefined ? undefined : JSON.stringify(body),
          headers,
          method,
          signal: controller.signal,
        });
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > MAX_RESPONSE_BYTES) {
          throw new Error("GitHub API response exceeded the safety limit.");
        }
        const raw = await response.text();
        if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) {
          throw new Error("GitHub API response exceeded the safety limit.");
        }
        if (!response.ok) {
          const error = new Error(`GitHub API ${method} ${endpoint} failed with HTTP ${response.status}.`);
          error.status = response.status;
          throw error;
        }
        if (raw === "") return null;
        try {
          return JSON.parse(raw);
        } catch {
          throw new Error(`GitHub API ${method} ${endpoint} returned invalid JSON.`);
        }
      } catch (error) {
        lastError = error;
        const shouldRetry =
          retryable &&
          attempt < maxAttempts &&
          (error.name === "AbortError" || [429, 502, 503, 504].includes(error.status));
        if (!shouldRetry) throw error;
        await delay(250 * 4 ** (attempt - 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  async listLabels() {
    const labels = [];
    const names = new Set();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const entries = await this.request(
        "GET",
        `/repos/${this.repository}/labels?per_page=100&page=${page}`,
      );
      if (!Array.isArray(entries) || entries.length > 100) {
        throw new Error("GitHub label response was not a bounded array.");
      }
      for (const entry of entries) {
        const description = entry?.description === null ? "" : entry?.description;
        if (
          typeof entry?.name !== "string" ||
          entry.name.length === 0 ||
          entry.name.length > 50 ||
          /[\u0000-\u001f\u007f]/.test(entry.name) ||
          !/^[0-9A-Fa-f]{6}$/.test(entry.color || "") ||
          typeof description !== "string" ||
          description.length > 100 ||
          /[\u0000-\u001f\u007f]/.test(description)
        ) {
          throw new Error("GitHub returned an invalid label definition.");
        }
        const normalized = normalizeName(entry.name);
        if (names.has(normalized)) {
          throw new Error(`GitHub returned duplicate label ${entry.name}.`);
        }
        names.add(normalized);
        labels.push({
          color: entry.color.toUpperCase(),
          description,
          name: entry.name,
        });
      }
      if (entries.length < 100) return labels;
    }
    throw new Error(`GitHub label pagination exceeded ${MAX_PAGES} pages.`);
  }

  async listAssociations(labelName) {
    const items = [];
    const seen = new Set();
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        labels: labelName,
        page: String(page),
        per_page: "100",
        state: "all",
      });
      const entries = await this.request(
        "GET",
        `/repos/${this.repository}/issues?${query.toString()}`,
      );
      if (!Array.isArray(entries) || entries.length > 100) {
        throw new Error("GitHub issue response was not a bounded array.");
      }
      for (const entry of entries) {
        const kind = entry?.pull_request ? "pull_request" : "issue";
        const pathName = kind === "pull_request" ? "pull" : "issues";
        const expectedUrl = `https://github.com/${this.repository}/${pathName}/${entry?.number}`;
        const item = {
          kind,
          number: entry?.number,
          state: entry?.state,
          url: entry?.html_url,
        };
        if (
          !Number.isSafeInteger(item.number) ||
          item.number < 1 ||
          !["open", "closed"].includes(item.state) ||
          item.url !== expectedUrl
        ) {
          throw new Error(`GitHub returned an invalid association for ${labelName}.`);
        }
        const key = itemKey(item);
        if (seen.has(key)) {
          throw new Error(`GitHub returned duplicate association ${key} for ${labelName}.`);
        }
        seen.add(key);
        items.push(item);
      }
      if (entries.length < 100) return items;
    }
    throw new Error(`GitHub association pagination exceeded ${MAX_PAGES} pages for ${labelName}.`);
  }

  createLabel(labelEntry) {
    return this.request("POST", `/repos/${this.repository}/labels`, labelEntry);
  }

  updateLabel(currentName, labelEntry) {
    const { name: newName, ...properties } = labelEntry;
    return this.request(
      "PATCH",
      `/repos/${this.repository}/labels/${encodeURIComponent(currentName)}`,
      { ...properties, new_name: newName },
    );
  }

  deleteLabel(name) {
    return this.request(
      "DELETE",
      `/repos/${this.repository}/labels/${encodeURIComponent(name)}`,
    );
  }

  addLabel(number, name) {
    return this.request("POST", `/repos/${this.repository}/issues/${number}/labels`, {
      labels: [name],
    });
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;

  async function worker() {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

async function readCurrentState(client, associationNames) {
  const labels = await client.listLabels();
  const current = new Map(labels.map((entry) => [normalizeName(entry.name), entry]));
  const actualNames = [];
  const seen = new Set();
  for (const requested of associationNames) {
    const labelEntry = current.get(normalizeName(requested));
    if (labelEntry && !seen.has(normalizeName(labelEntry.name))) {
      actualNames.push(labelEntry.name);
      seen.add(normalizeName(labelEntry.name));
    }
  }
  const associationEntries = await mapWithConcurrency(actualNames, 4, async (name) => [
    name,
    await client.listAssociations(name),
  ]);
  return { associations: Object.fromEntries(associationEntries), labels };
}

function operationSummary(operation) {
  if (operation.kind === "rename") return `rename ${operation.from} -> ${operation.to}`;
  if (operation.kind === "create") return `create ${operation.label.name}`;
  if (operation.kind === "update") return `update ${operation.name}`;
  if (operation.kind === "add") {
    return `add ${operation.name} to ${operation.item.kind} #${operation.item.number}`;
  }
  if (operation.kind === "delete") {
    return `delete ${operation.name} (${operation.associationCount} historical association(s))`;
  }
  return operation.kind;
}

function printPlan(title, plan) {
  process.stdout.write(`${title}: ${plan.operations.length} operation(s)\n`);
  for (const operation of plan.operations) {
    process.stdout.write(`  - ${operationSummary(operation)}\n`);
  }
  for (const blocker of plan.blockers || []) {
    process.stdout.write(
      `  BLOCKED: ${blocker.label} on ${blocker.item.kind} #${blocker.item.number}: ${blocker.reason}\n`,
    );
  }
  for (const warning of plan.warnings || []) {
    process.stdout.write(
      `  TRIAGE: ${warning.label} on ${warning.item.kind} #${warning.item.number}: ${warning.reason}\n`,
    );
  }
}

async function executeOperations(client, operations) {
  for (const [index, operation] of operations.entries()) {
    try {
      if (operation.kind === "rename") {
        await client.updateLabel(operation.from, {
          name: operation.to,
          color: operation.color,
          description: operation.description,
        });
      } else if (operation.kind === "create") {
        await client.createLabel(operation.label);
      } else if (operation.kind === "update") {
        await client.updateLabel(operation.from || operation.name, {
          name: operation.name,
          color: operation.color,
          description: operation.description,
        });
      } else if (operation.kind === "add") {
        await client.addLabel(operation.item.number, operation.name);
      } else if (operation.kind === "delete") {
        await client.deleteLabel(operation.name);
      } else {
        throw new Error(`Unsupported operation ${operation.kind}.`);
      }
    } catch (error) {
      throw new Error(
        `Operation ${index + 1}/${operations.length} failed (${operationSummary(operation)}): ${error.message}`,
      );
    }
  }
}

async function writeSnapshot(filePath, repository, state) {
  const snapshot = {
    schemaVersion: 1,
    repository,
    capturedAt: new Date().toISOString(),
    state,
  };
  validateSnapshot(snapshot);
  const absolutePath = path.resolve(filePath);
  const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
  let created = false;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    created = true;
    await fs.link(temporaryPath, absolutePath);
    await fs.rm(temporaryPath);
    created = false;
  } catch (error) {
    if (created) await fs.rm(temporaryPath, { force: true });
    throw error;
  }
  return absolutePath;
}

function relevantNames(policy) {
  return [
    ...policy.labels.map((entry) => entry.name),
    ...policy.migrations.flatMap((entry) => [entry.from, entry.to]),
    ...policy.retiredLabels.map((entry) => entry.name),
  ];
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseArguments(argv);
  const policy = await loadPolicy(parsed.policyPath);
  if (parsed.action === "check") {
    process.stdout.write(
      `Label policy is valid: ${policy.labels.length} labels, ${policy.migrations.length} migrations, ${policy.retiredLabels.length} retirements.\n`,
    );
    return;
  }

  const credential = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  if (["apply", "snapshot", "retire", "restore"].includes(parsed.action) && !credential) {
    throw new Error("GITHUB_TOKEN or GH_TOKEN is required for this action.");
  }
  const client = new GitHubClient({ repository: parsed.repository, token: credential });

  if (parsed.action === "snapshot") {
    const state = await readCurrentState(client, relevantNames(policy));
    const written = await writeSnapshot(parsed.snapshotPath, parsed.repository, state);
    process.stdout.write(`Snapshot written to ${written}.\n`);
    return;
  }

  if (parsed.action === "restore") {
    const snapshot = validateSnapshot(await loadJson(parsed.snapshotPath));
    if (snapshot.repository !== parsed.repository) {
      throw new Error(`Snapshot belongs to ${snapshot.repository}, not ${parsed.repository}.`);
    }
    const names = policy.retiredLabels.map((entry) => entry.name);
    const current = await readCurrentState(client, names);
    const plan = buildRestorePlan(policy, snapshot, current);
    printPlan("Restore plan", plan);
    await executeOperations(client, plan.operations);
    const verified = await readCurrentState(client, names);
    const remaining = buildRestorePlan(policy, snapshot, verified);
    if (remaining.operations.length !== 0) {
      throw new Error("Restore verification found remaining operations.");
    }
    return;
  }

  const names = relevantNames(policy);
  const current = await readCurrentState(client, names);
  const applyPlan = buildApplyPlan(policy, current);
  const retirementPlan = buildRetirementPlan(policy, current);
  printPlan("Convergence plan", applyPlan);
  printPlan("Retirement plan", retirementPlan);

  if (parsed.action === "plan") return;

  if (parsed.action === "apply") {
    if ((applyPlan.blockers || []).length !== 0) {
      throw new Error("Apply is blocked by conflicting or inapplicable projected classifications.");
    }
    await executeOperations(client, applyPlan.operations);
    const verified = await readCurrentState(client, names);
    const remaining = buildApplyPlan(policy, verified);
    if (remaining.operations.length !== 0 || (remaining.blockers || []).length !== 0) {
      throw new Error("Apply verification found remaining operations.");
    }
    return;
  }

  if (parsed.action === "retire") {
    if (applyPlan.operations.length !== 0 || (applyPlan.blockers || []).length !== 0) {
      throw new Error("Desired labels are not converged; run the apply phase before retirement.");
    }
    const snapshot = await loadJson(parsed.snapshotPath);
    assertRetirementSnapshotMatches(
      snapshot,
      parsed.repository,
      current,
      policy.retiredLabels.map((entry) => entry.name),
    );
    if (retirementPlan.blockers.length !== 0) {
      throw new Error("Retirement is blocked by open items that would lose governed classification.");
    }
    await executeOperations(client, retirementPlan.operations);
    const verified = await readCurrentState(client, names);
    const remaining = buildRetirementPlan(policy, verified);
    if (remaining.operations.length !== 0 || remaining.blockers.length !== 0) {
      throw new Error("Retirement verification found remaining retired labels.");
    }
  }
}

module.exports = {
  GitHubClient,
  assertRetirementSnapshotMatches,
  assertSnapshotMatches,
  buildApplyPlan,
  buildRestorePlan,
  buildRetirementPlan,
  loadPolicy,
  main,
  parseArguments,
  readCurrentState,
  validatePolicy,
  validateSnapshot,
  writeSnapshot,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`manage-labels: ${error.message}\n`);
    process.exitCode = 1;
  });
}
