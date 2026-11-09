#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_HEADER = 64 * 1024 * 1024;
const MAX_BLOCKS = 1024 * 1024;
const CHUNK_SIZE = 64 * 1024;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const DIRECTORY = fs.constants.O_DIRECTORY;

function fail(message) {
  throw new Error(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeName(name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." ||
      /[/\\\0]/.test(name) || Buffer.from(name).toString() !== name) {
    fail(`unsafe ASAR path component: ${JSON.stringify(name)}`);
  }
}

function safePath(value) {
  if (typeof value !== "string" || path.posix.isAbsolute(value)) fail("unsafe ASAR path");
  const parts = value.split("/");
  parts.forEach(safeName);
  return parts;
}

// Keep source spans so updating three metadata values cannot reorder JSON keys,
// links, flags, or the original header's other formatting.
function parseJsonSpans(text) {
  let cursor = 0;
  function whitespace() {
    while (/[ \t\r\n]/.test(text[cursor] || "") && cursor < text.length) cursor += 1;
  }
  function string() {
    const start = cursor++;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === "\\") cursor += 1;
      else if (character === '"') return JSON.parse(text.slice(start, cursor));
    }
    fail("unterminated header string");
  }
  function value(depth) {
    if (depth > 128) fail("ASAR header nesting limit exceeded");
    whitespace();
    const start = cursor;
    let result;
    let fields;
    if (text[cursor] === "{") {
      cursor += 1;
      result = Object.create(null);
      fields = new Map();
      whitespace();
      if (text[cursor] !== "}") {
        for (;;) {
          if (text[cursor] !== '"') fail("invalid header object key");
          const key = string();
          if (fields.has(key)) fail(`duplicate header key: ${key}`);
          whitespace();
          if (text[cursor++] !== ":") fail("invalid header object separator");
          const child = value(depth + 1);
          fields.set(key, child);
          result[key] = child.value;
          whitespace();
          if (text[cursor] !== ",") break;
          cursor += 1;
          whitespace();
        }
      }
      if (text[cursor++] !== "}") fail("invalid header object end");
    } else if (text[cursor] === "[") {
      cursor += 1;
      result = [];
      whitespace();
      if (text[cursor] !== "]") {
        for (;;) {
          result.push(value(depth + 1).value);
          whitespace();
          if (text[cursor] !== ",") break;
          cursor += 1;
        }
      }
      if (text[cursor++] !== "]") fail("invalid header array end");
    } else if (text[cursor] === '"') {
      result = string();
    } else {
      const match = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(cursor));
      if (!match) fail("invalid header value");
      result = JSON.parse(match[0]);
      cursor += match[0].length;
    }
    return { value: result, fields, start, end: cursor };
  }
  const root = value(0);
  whitespace();
  if (cursor !== text.length) fail("trailing header content");
  return root;
}

function onlyKeys(node, allowed) {
  if (!record(node.value)) fail("invalid ASAR entry object");
  for (const key of node.fields.keys()) {
    if (!allowed.includes(key)) fail(`unsupported ASAR entry field: ${key}`);
  }
}

function integrityContract(value, size) {
  if (!record(value) || Object.keys(value).sort().join(",") !== "algorithm,blockSize,blocks,hash" ||
      value.algorithm !== "SHA256" || typeof value.hash !== "string" || !HEX_SHA256.test(value.hash) ||
      !Number.isSafeInteger(value.blockSize) || value.blockSize <= 0 ||
      !Array.isArray(value.blocks) || value.blocks.length > MAX_BLOCKS ||
      value.blocks.some((hash) => typeof hash !== "string" || !HEX_SHA256.test(hash))) {
    fail("unsupported or incomplete ASAR integrity metadata");
  }
  // electron/asar v3.2.4 flushes an empty final block too, including exact
  // boundaries and empty files. This is the production Nix packer's contract.
  if (value.blocks.length !== Math.floor(size / value.blockSize) + 1) {
    fail("ASAR integrity block count does not match declared size");
  }
}

function parseHeader(prefix, archiveSize) {
  if (!Number.isSafeInteger(archiveSize) || archiveSize < 0) fail("invalid archive size");
  if (prefix.length < 16 || prefix.readUInt32LE(0) !== 4) fail("invalid ASAR size pickle");
  const headerSize = prefix.readUInt32LE(4);
  const stringSize = prefix.readUInt32LE(12);
  if (headerSize < 8 || headerSize > MAX_HEADER || headerSize % 4 !== 0 ||
      prefix.length !== 8 + headerSize || prefix.readUInt32LE(8) !== headerSize - 4 ||
      stringSize === 0 || headerSize !== 4 + Math.ceil((4 + stringSize) / 4) * 4 ||
      prefix.subarray(16 + stringSize).some((byte) => byte !== 0) || archiveSize < prefix.length) {
    fail("invalid ASAR header pickle or padding");
  }
  const raw = prefix.subarray(16, 16 + stringSize);
  const text = raw.toString("utf8");
  if (!Buffer.from(text).equals(raw)) fail("header is not valid UTF-8");
  const header = parseJsonSpans(text);
  onlyKeys(header, ["files"]);
  const entries = [];
  const byPath = new Map();
  function visit(filesNode, ancestors, parentUnpacked) {
    if (!filesNode || !record(filesNode.value)) fail("missing ASAR files object");
    for (const [name, node] of filesNode.fields) {
      safeName(name);
      const parts = [...ancestors, name];
      const relative = parts.join("/");
      const item = node.value;
      if (!record(item)) fail("invalid ASAR entry");
      for (const flag of ["unpacked", "executable"]) {
        if (Object.hasOwn(item, flag) && typeof item[flag] !== "boolean") fail(`invalid ${flag} flag`);
      }
      let kind;
      if (Object.hasOwn(item, "files")) {
        onlyKeys(node, ["files", "unpacked"]);
        kind = "directory";
      } else if (Object.hasOwn(item, "link")) {
        onlyKeys(node, ["link", "unpacked", "executable"]);
        safePath(item.link);
        kind = "link";
      } else {
        onlyKeys(node, ["size", "offset", "integrity", "unpacked", "executable"]);
        if (!Number.isSafeInteger(item.size) || item.size < 0) fail("invalid file size");
        integrityContract(item.integrity, item.size);
        if (parentUnpacked && item.unpacked !== true) fail("incomplete unpack directory metadata");
        if (item.unpacked === true) {
          if (Object.hasOwn(item, "offset")) fail("unpacked file has a packed offset");
          kind = "unpacked";
        } else {
          if (typeof item.offset !== "string" || !/^(?:0|[1-9]\d*)$/.test(item.offset)) fail("invalid packed offset");
          const offset = Number(item.offset);
          if (!Number.isSafeInteger(offset) || offset + item.size > archiveSize - prefix.length ||
              !Number.isSafeInteger(offset + item.size)) fail("packed range is outside payload");
          kind = "packed";
        }
      }
      const entry = { path: relative, parts, node, item, kind };
      entries.push(entry);
      byPath.set(relative, entry);
      if (kind === "directory") visit(node.fields.get("files"), parts, parentUnpacked || item.unpacked === true);
    }
  }
  visit(header.fields.get("files"), [], false);
  for (const entry of entries.filter((item) => item.kind === "link")) {
    const seen = new Set([entry.path]);
    let current = entry;
    while (current.kind === "link") {
      if (seen.has(current.item.link)) fail("ASAR link cycle");
      seen.add(current.item.link);
      current = byPath.get(current.item.link);
      if (!current) fail("ASAR link target is absent");
    }
  }
  const ranges = entries.filter((entry) => entry.kind === "packed" && entry.item.size > 0)
    .map((entry) => ({ start: Number(entry.item.offset), end: Number(entry.item.offset) + entry.item.size }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let previous;
  for (const range of ranges) {
    if (previous && range.start < previous.end &&
        (range.start !== previous.start || range.end !== previous.end)) fail("partially overlapping packed ranges");
    previous = range;
  }
  return { prefix, text, entries, byPath, payloadOffset: prefix.length, archiveSize };
}

function fdPath(fd, name = "") {
  return `/proc/self/fd/${fd}${name ? `/${name}` : ""}`;
}

function openBeneath(rootFd, parts, directory = false) {
  let parent = rootFd;
  const opened = [];
  try {
    for (let index = 0; index < parts.length; index += 1) {
      safeName(parts[index]);
      const isDirectory = index < parts.length - 1 || directory;
      const fd = fs.openSync(fdPath(parent, parts[index]), fs.constants.O_RDONLY | NOFOLLOW | fs.constants.O_NONBLOCK | (isDirectory ? DIRECTORY : 0));
      opened.push(fd);
      parent = fd;
    }
    return opened.pop();
  } finally {
    for (const fd of opened) fs.closeSync(fd);
  }
}

function snapshot(fd) {
  const value = fs.fstatSync(fd, { bigint: true });
  if (!value.isFile() || value.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("expected a bounded regular file");
  return { dev: value.dev, ino: value.ino, size: value.size, mtime: value.mtimeNs, ctime: value.ctimeNs, mode: Number(value.mode & 0o7777n) };
}

function unchanged(fd, expected) {
  const current = snapshot(fd);
  if (["dev", "ino", "size", "mtime", "ctime"].some((key) => current[key] !== expected[key])) fail("input changed while it was read");
}

function readExact(fd, length, position) {
  const result = Buffer.alloc(length);
  let count = 0;
  while (count < length) {
    const read = fs.readSync(fd, result, count, length - count, position + count);
    if (read === 0) fail("truncated ASAR input");
    count += read;
  }
  return result;
}

function eachChunk(fd, start, size, callback) {
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  for (let offset = 0; offset < size;) {
    const length = Math.min(buffer.length, size - offset);
    const count = fs.readSync(fd, buffer, 0, length, start + offset);
    if (count === 0) fail("truncated file data");
    callback(buffer.subarray(0, count));
    offset += count;
  }
}

function sha256(fd, start, size) {
  const hash = crypto.createHash("sha256");
  eachChunk(fd, start, size, (chunk) => hash.update(chunk));
  return hash.digest("hex");
}

function calculateIntegrity(fd, start, size, blockSize) {
  if (Math.floor(size / blockSize) + 1 > MAX_BLOCKS) fail("integrity block count limit exceeded");
  const whole = crypto.createHash("sha256");
  let block = crypto.createHash("sha256");
  let used = 0;
  const blocks = [];
  eachChunk(fd, start, size, (chunk) => {
    whole.update(chunk);
    for (let offset = 0; offset < chunk.length;) {
      const length = Math.min(blockSize - used, chunk.length - offset);
      block.update(chunk.subarray(offset, offset + length));
      offset += length;
      used += length;
      if (used === blockSize) {
        blocks.push(block.digest("hex"));
        block = crypto.createHash("sha256");
        used = 0;
      }
    }
  });
  blocks.push(block.digest("hex"));
  return { hash: whole.digest("hex"), blocks };
}

function sameIntegrity(actual, expected) {
  return actual.hash === expected.hash && actual.blocks.length === expected.blocks.length &&
    actual.blocks.every((hash, index) => hash === expected.blocks[index]);
}

function physicalInventory(context) {
  const expected = new Set(context.layout.entries.filter((entry) => entry.kind === "unpacked").map((entry) => entry.path));
  if (context.unpackedFd === null) {
    if (expected.size) fail("ASAR unpacked directory is missing");
    return;
  }
  const found = new Set();
  function visit(fd, ancestors) {
    for (const item of fs.readdirSync(fdPath(fd), { withFileTypes: true })) {
      safeName(item.name);
      const parts = [...ancestors, item.name];
      const relative = parts.join("/");
      if (item.isDirectory()) {
        if (context.layout.byPath.get(relative)?.kind !== "directory") fail(`orphan unpacked directory: ${relative}`);
        const child = openBeneath(fd, [item.name], true);
        try { visit(child, parts); } finally { fs.closeSync(child); }
      } else if (item.isFile()) {
        if (!expected.has(relative)) fail(`orphan unpacked file: ${relative}`);
        found.add(relative);
      } else {
        fail(`unsafe unpacked filesystem entry: ${relative}`);
      }
    }
  }
  visit(context.unpackedFd, []);
  if (found.size !== expected.size) fail("ASAR unpacked files are missing");
}

function openContext(root) {
  root = path.resolve(root);
  if (fs.realpathSync(root) !== root || !NOFOLLOW || !DIRECTORY) fail("root must be a real Linux directory");
  const opened = [];
  try {
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY | NOFOLLOW | DIRECTORY); opened.push(rootFd);
    const resourcesFd = openBeneath(rootFd, ["resources"], true); opened.push(resourcesFd);
    const archiveFd = openBeneath(resourcesFd, ["app.asar"]); opened.push(archiveFd);
    const archiveStat = snapshot(archiveFd);
    const first = readExact(archiveFd, 8, 0);
    const length = first.readUInt32LE(4);
    if (length < 8 || length > MAX_HEADER) fail("invalid ASAR header length");
    const layout = parseHeader(Buffer.concat([first, readExact(archiveFd, length, 8)]), Number(archiveStat.size));
    let unpackedFd = null;
    try { unpackedFd = openBeneath(resourcesFd, ["app.asar.unpacked"], true); opened.push(unpackedFd); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const context = { root, rootFd, resourcesFd, archiveFd, archiveStat, unpackedFd, layout, opened };
    physicalInventory(context);
    return context;
  } catch (error) {
    for (const fd of opened.reverse()) fs.closeSync(fd);
    throw error;
  }
}

function inspect(context) {
  const changes = [];
  const observed = [];
  const packedCache = new Map();
  for (const entry of context.layout.entries) {
    if (entry.kind === "packed") {
      const key = `${entry.item.offset}:${entry.item.size}:${entry.item.integrity.blockSize}`;
      if (!packedCache.has(key)) packedCache.set(key, calculateIntegrity(context.archiveFd, context.layout.payloadOffset + Number(entry.item.offset), entry.item.size, entry.item.integrity.blockSize));
      if (!sameIntegrity(packedCache.get(key), entry.item.integrity)) fail(`packed integrity mismatch: ${entry.path}`);
    } else if (entry.kind === "unpacked") {
      const fd = openBeneath(context.unpackedFd, entry.parts);
      try {
        const before = snapshot(fd);
        const actual = calculateIntegrity(fd, 0, Number(before.size), entry.item.integrity.blockSize);
        unchanged(fd, before);
        observed.push({ entry, stat: before });
        if (Number(before.size) !== entry.item.size || !sameIntegrity(actual, entry.item.integrity)) {
          changes.push({ entry, size: Number(before.size), ...actual });
        }
      } finally { fs.closeSync(fd); }
    }
  }
  unchanged(context.archiveFd, context.archiveStat);
  return { changes, observed };
}

function verifyObservations(context, observations) {
  physicalInventory(context);
  unchanged(context.archiveFd, context.archiveStat);
  const current = openBeneath(context.resourcesFd, ["app.asar"]);
  try { unchanged(current, context.archiveStat); } finally { fs.closeSync(current); }
  for (const item of observations) {
    const fd = openBeneath(context.unpackedFd, item.entry.parts);
    try { unchanged(fd, item.stat); } finally { fs.closeSync(fd); }
  }
  if (context.unpackedFd !== null) {
    const named = fs.lstatSync(fdPath(context.resourcesFd, "app.asar.unpacked"), { bigint: true });
    const held = fs.fstatSync(context.unpackedFd, { bigint: true });
    if (!named.isDirectory() || named.dev !== held.dev || named.ino !== held.ino) fail("unpacked directory identity changed");
  }
  if (fs.realpathSync(context.root) !== context.root) fail("root changed while processing");
  for (const [relative, fd] of [[[], context.rootFd], [["resources"], context.resourcesFd]]) {
    const named = fs.lstatSync(path.join(context.root, ...relative), { bigint: true });
    if (!named.isDirectory()) fail("root directory was replaced by a non-directory");
    const held = fs.fstatSync(fd, { bigint: true });
    if (named.dev !== held.dev || named.ino !== held.ino) fail("root directory identity changed");
  }
}

function hasAsarAuthority(report) {
  const success = new Set(["applied", "already-applied"]);
  const phases = new Set(["main-bundle", "extracted-app:pre-webview", "webview-asset", "extracted-app:post-webview"]);
  return report.patches.some((item) => success.has(item.status) &&
    ((item.sourceKind === "core" && item.ciPolicy === "required-upstream") ||
     (item.sourceKind === "feature" && report.enabledFeatures.includes(item.featureId) && phases.has(item.phase))));
}

function readReport(context, beforeHash) {
  const directory = openBeneath(context.rootFd, [".codex-linux"], true);
  let fd;
  try {
    fd = openBeneath(directory, ["patch-report.json"]);
    const details = snapshot(fd);
    if (details.size > 16n * 1024n * 1024n) fail("patch report is too large");
    const bytes = readExact(fd, Number(details.size), 0);
    const report = JSON.parse(bytes.toString());
    if (!record(report) || !record(report.upstreamAppAsar) || !HEX_SHA256.test(report.upstreamAppAsar.sha256) ||
        typeof report.upstreamAppAsar.preservedByteForByte !== "boolean" || !record(report.outputAppAsar) ||
        report.outputAppAsar.sha256 !== beforeHash || !Array.isArray(report.patches) || !Array.isArray(report.enabledFeatures)) {
      fail("patch report does not bind the current ASAR");
    }
    const lineage = report.nixAsarUnpackedIntegrity;
    if (lineage !== undefined) {
      if (!record(lineage) || lineage.schemaVersion !== 1 || !Array.isArray(lineage.transitions) ||
          !lineage.transitions.length || report.upstreamAppAsar.preservedByteForByte || !hasAsarAuthority(report)) fail("invalid Nix ASAR metadata lineage");
      let previous;
      for (const transition of lineage.transitions) {
        if (!record(transition) || !HEX_SHA256.test(transition.beforeSha256) || !HEX_SHA256.test(transition.afterSha256) ||
            transition.beforeSha256 === transition.afterSha256 || (previous && transition.beforeSha256 !== previous) ||
            !Array.isArray(transition.changedPaths) || !transition.changedPaths.length ||
            new Set(transition.changedPaths).size !== transition.changedPaths.length) fail("invalid Nix ASAR metadata lineage");
        transition.changedPaths.forEach(safePath);
        previous = transition.afterSha256;
      }
      if (previous !== beforeHash) fail("invalid Nix ASAR metadata lineage tail");
    }
    return { directory, fd, details, report };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(directory);
    throw error;
  }
}

function verifyReport(context, binding) {
  unchanged(binding.fd, binding.details);
  const directory = fs.lstatSync(fdPath(context.rootFd, ".codex-linux"), { bigint: true });
  const held = fs.fstatSync(binding.directory, { bigint: true });
  if (!directory.isDirectory() || directory.dev !== held.dev || directory.ino !== held.ino) fail("report directory identity changed");
  const current = openBeneath(binding.directory, ["patch-report.json"]);
  try { unchanged(current, binding.details); } finally { fs.closeSync(current); }
}

function encodeHeader(text) {
  const bytes = Buffer.from(text);
  const headerSize = 4 + Math.ceil((4 + bytes.length) / 4) * 4;
  if (headerSize > MAX_HEADER) fail("updated header is too large");
  const result = Buffer.alloc(8 + headerSize);
  result.writeUInt32LE(4, 0);
  result.writeUInt32LE(headerSize, 4);
  result.writeUInt32LE(headerSize - 4, 8);
  result.writeUInt32LE(bytes.length, 12);
  bytes.copy(result, 16);
  return result;
}

function tempFile(directory, prefix, mode) {
  const name = `.${prefix}-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`;
  const filename = fdPath(directory, name);
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, mode | 0o200);
  return { filename, fd, mode };
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (count <= 0) fail("short temporary archive write");
    offset += count;
  }
}

function finishTemp(item) {
  fs.fchmodSync(item.fd, item.mode);
  fs.fsyncSync(item.fd);
  fs.closeSync(item.fd);
  item.fd = null;
}

function closeContext(context) {
  for (const fd of context.opened.reverse()) fs.closeSync(fd);
}

function check(root) {
  const context = openContext(root);
  let binding;
  try {
    const result = inspect(context);
    if (result.changes.length) fail(`unpacked integrity mismatch: ${result.changes.map((item) => item.entry.path).join(", ")}`);
    const hash = sha256(context.archiveFd, 0, Number(context.archiveStat.size));
    binding = readReport(context, hash);
    verifyReport(context, binding);
    verifyObservations(context, result.observed);
    return { changed: false, sha256: hash, unpackedFiles: result.observed.length, entries: context.layout.entries.length };
  } finally {
    if (binding) { fs.closeSync(binding.fd); fs.closeSync(binding.directory); }
    closeContext(context);
  }
}

function sync(root) {
  const context = openContext(root);
  const temporary = [];
  let binding;
  let backup;
  let retainBackup = false;
  try {
    const result = inspect(context);
    const beforeHash = sha256(context.archiveFd, 0, Number(context.archiveStat.size));
    binding = readReport(context, beforeHash);
    if (!result.changes.length) {
      verifyObservations(context, result.observed);
      verifyReport(context, binding);
      return { changed: false, sha256: beforeHash, paths: [] };
    }
    if (!hasAsarAuthority(binding.report)) fail("ASAR metadata adaptation requires an active ASAR feature or required core patch");
    const edits = [];
    for (const change of result.changes) {
      const fields = change.entry.node.fields;
      const integrity = fields.get("integrity").fields;
      edits.push({ ...fields.get("size"), replacement: String(change.size) });
      edits.push({ ...integrity.get("hash"), replacement: JSON.stringify(change.hash) });
      edits.push({ ...integrity.get("blocks"), replacement: JSON.stringify(change.blocks) });
    }
    let text = context.layout.text;
    for (const edit of edits.sort((left, right) => right.start - left.start)) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
    const prefix = encodeHeader(text);
    const payloadSize = Number(context.archiveStat.size) - context.layout.payloadOffset;
    parseHeader(prefix, prefix.length + payloadSize);
    const archive = tempFile(context.resourcesFd, "app.asar-unpacked-integrity", context.archiveStat.mode); temporary.push(archive);
    const after = crypto.createHash("sha256");
    writeAll(archive.fd, prefix); after.update(prefix);
    eachChunk(context.archiveFd, context.layout.payloadOffset, payloadSize, (chunk) => { writeAll(archive.fd, chunk); after.update(chunk); });
    finishTemp(archive);
    const afterHash = after.digest("hex");
    const paths = result.changes.map((change) => change.entry.path);
    binding.report.outputAppAsar.sha256 = afterHash;
    binding.report.upstreamAppAsar.preservedByteForByte = false;
    binding.report.nixAsarUnpackedIntegrity ??= { schemaVersion: 1, transitions: [] };
    binding.report.nixAsarUnpackedIntegrity.transitions.push({ beforeSha256: beforeHash, afterSha256: afterHash, changedPaths: paths });
    const report = tempFile(binding.directory, "patch-report-unpacked-integrity", binding.details.mode); temporary.push(report);
    writeAll(report.fd, Buffer.from(`${JSON.stringify(binding.report, null, 2)}\n`)); finishTemp(report);
    verifyObservations(context, result.observed);
    verifyReport(context, binding);
    backup = fdPath(binding.directory, `.patch-report-backup-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    fs.linkSync(fdPath(binding.directory, "patch-report.json"), backup);
    fs.renameSync(report.filename, fdPath(binding.directory, "patch-report.json"));
    try {
      fs.renameSync(archive.filename, fdPath(context.resourcesFd, "app.asar"));
    } catch (error) {
      try { fs.renameSync(backup, fdPath(binding.directory, "patch-report.json")); backup = null; }
      catch (rollback) { retainBackup = true; throw new AggregateError([error, rollback], `report rollback failed; recovery copy retained at ${backup}`); }
      throw error;
    }
    fs.fsyncSync(context.resourcesFd); fs.fsyncSync(binding.directory);
    return { changed: true, beforeSha256: beforeHash, afterSha256: afterHash, paths };
  } finally {
    for (const item of temporary) {
      if (item.fd !== null) fs.closeSync(item.fd);
      fs.rmSync(item.filename, { force: true });
    }
    if (backup && !retainBackup) fs.rmSync(backup, { force: true });
    if (binding) { fs.closeSync(binding.fd); fs.closeSync(binding.directory); }
    closeContext(context);
  }
}

if (require.main === module) {
  try {
    const [command, flag, root, ...extra] = process.argv.slice(2);
    if (!["sync", "check"].includes(command) || flag !== "--root" || !root || extra.length) fail("usage: asar-unpacked-integrity.cjs <sync|check> --root APP_ROOT");
    process.stdout.write(`${JSON.stringify(command === "sync" ? sync(root) : check(root))}\n`);
  } catch (error) {
    console.error(`[asar-unpacked-integrity] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { sync, check, parseHeader };
