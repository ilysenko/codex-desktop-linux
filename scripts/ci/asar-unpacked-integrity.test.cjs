"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const childProcess = require("node:child_process");
const test = require("node:test");
const helper = require("../../nix/asar-unpacked-integrity.cjs");

const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
function integrity(data, blockSize = 8) {
  const blocks = [];
  for (let offset = 0; offset <= data.length; offset += blockSize) blocks.push(hash(data.subarray(offset, offset + blockSize)));
  return { algorithm: "SHA256", hash: hash(data), blockSize, blocks };
}
function frame(text) {
  const json = Buffer.from(text);
  const size = 4 + Math.ceil((4 + json.length) / 4) * 4;
  const result = Buffer.alloc(8 + size);
  result.writeUInt32LE(4, 0); result.writeUInt32LE(size, 4);
  result.writeUInt32LE(size - 4, 8); result.writeUInt32LE(json.length, 12);
  json.copy(result, 16);
  return result;
}
function readArchive(fixture) {
  const bytes = fs.readFileSync(fixture.asar);
  const length = 8 + bytes.readUInt32LE(4);
  return { bytes, prefix: bytes.subarray(0, length), tail: bytes.subarray(length), text: bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString(), layout: helper.parseHeader(bytes.subarray(0, length), bytes.length) };
}
function stamp(filename) {
  const info = fs.statSync(filename, { bigint: true });
  return { bytes: fs.readFileSync(filename), mode: info.mode, mtimeNs: info.mtimeNs, ino: info.ino };
}
function sameFile(filename, expected) {
  const info = stamp(filename);
  assert.deepEqual(info, expected);
}
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p54-fixture-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, "resources");
  const unpacked = path.join(resources, "app.asar.unpacked");
  fs.mkdirSync(path.join(unpacked, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex-linux"));
  const native = Buffer.from("original native");
  const packed = Buffer.from("packed bytes\0kept");
  const empty = Buffer.alloc(0);
  const regular = { size: packed.length, offset: "0", integrity: integrity(packed), executable: true };
  const files = {
    "10": regular,
    "2": { ...regular, executable: false },
    "packed-empty": { size: 0, offset: String(packed.length), integrity: integrity(empty) },
    "inside-link": { link: "10" },
    "node_modules": { files: {
      "native.node": { size: native.length, unpacked: true, executable: true, integrity: integrity(native) },
      "empty.node": { size: 0, unpacked: true, executable: false, integrity: integrity(empty) },
    } },
  };
  let text = `{"files":{"10":${JSON.stringify(files["10"])},"2":${JSON.stringify(files["2"])},` +
    Object.entries(files).filter(([key]) => key !== "10" && key !== "2").map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",") + "}}";
  if (options.header) text = options.header(JSON.parse(text), text);
  const asar = path.join(resources, "app.asar");
  fs.writeFileSync(asar, Buffer.concat([frame(text), packed]));
  const nativePath = path.join(unpacked, "node_modules/native.node");
  const emptyPath = path.join(unpacked, "node_modules/empty.node");
  fs.writeFileSync(nativePath, native); fs.writeFileSync(emptyPath, empty);
  const report = path.join(root, ".codex-linux/patch-report.json");
  const value = {
    upstreamAppAsar: { sha256: "a".repeat(64), preservedByteForByte: options.authority === false },
    outputAppAsar: { sha256: hash(fs.readFileSync(asar)) },
    enabledFeatures: [],
    patches: options.authority === false ? [] : [{ name: "core:fixture", sourceKind: "core", ciPolicy: "required-upstream", phase: "main-bundle", status: "applied" }],
    signatureVerification: "verified",
  };
  fs.writeFileSync(report, JSON.stringify(value, null, 2) + "\n");
  return { root, resources, unpacked, asar, report, nativePath, emptyPath, packed, upstream: value.upstreamAppAsar.sha256 };
}
function assertNoTemps(fixture) {
  for (const directory of [fixture.resources, path.dirname(fixture.report)]) {
    assert.equal(fs.readdirSync(directory).some((name) => name.includes("integrity-") || name.startsWith(".patch-report-backup-")), false);
  }
}
function mutateHeader(fixture, mutate) {
  const old = readArchive(fixture);
  const value = JSON.parse(old.text); mutate(value);
  fs.writeFileSync(fixture.asar, Buffer.concat([frame(JSON.stringify(value)), old.tail]));
  const report = JSON.parse(fs.readFileSync(fixture.report)); report.outputAppAsar.sha256 = hash(fs.readFileSync(fixture.asar));
  fs.writeFileSync(fixture.report, JSON.stringify(report));
}

test("sync updates only existing external size/hash/blocks and retains packed aliases, offsets, raw order and flags", (t) => {
  const f = fixture(t); const before = readArchive(f);
  fs.writeFileSync(f.nativePath, "new native ELF bytes, with a changed length");
  const physical = stamp(f.nativePath); const result = helper.sync(f.root);
  assert.equal(result.changed, true); assert.deepEqual(result.paths, ["node_modules/native.node"]);
  const after = readArchive(f);
  assert.deepEqual(after.tail, before.tail);
  assert.deepEqual(after.layout.entries.map((entry) => entry.path), before.layout.entries.map((entry) => entry.path));
  assert.ok(after.text.indexOf('"10":') < after.text.indexOf('"2":'));
  for (const entry of after.layout.entries) {
    const old = before.layout.byPath.get(entry.path).item;
    if (entry.path === "node_modules/native.node") {
      assert.equal(entry.item.executable, old.executable); assert.equal(entry.item.unpacked, old.unpacked);
      assert.equal(entry.item.integrity.algorithm, old.integrity.algorithm);
      assert.equal(entry.item.integrity.blockSize, old.integrity.blockSize);
      assert.equal(entry.item.size, physical.bytes.length);
    } else if (entry.kind === "directory") {
      assert.deepEqual(Object.keys(entry.item), Object.keys(old));
      assert.equal(entry.item.unpacked, old.unpacked);
    } else assert.deepEqual(entry.item, old);
  }
  sameFile(f.nativePath, physical);
  const report = JSON.parse(fs.readFileSync(f.report));
  assert.equal(report.outputAppAsar.sha256, hash(after.bytes)); assert.equal(report.upstreamAppAsar.sha256, f.upstream);
  assert.equal(report.signatureVerification, "verified");
  assert.deepEqual(report.nixAsarUnpackedIntegrity.transitions[0], { beforeSha256: hash(before.bytes), afterSha256: hash(after.bytes), changedPaths: result.paths });
  assert.equal(helper.check(f.root).unpackedFiles, 2); assertNoTemps(f);
});

test("empty files and exact block boundaries retain the observed asar 3.2.4 final-empty-block convention", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.nativePath, Buffer.alloc(16, 7)); fs.writeFileSync(f.emptyPath, "x");
  helper.sync(f.root);
  const layout = readArchive(f).layout;
  assert.deepEqual(JSON.parse(JSON.stringify(layout.byPath.get("node_modules/native.node").item.integrity)), integrity(Buffer.alloc(16, 7)));
  assert.deepEqual(JSON.parse(JSON.stringify(layout.byPath.get("node_modules/empty.node").item.integrity)), integrity(Buffer.from("x")));
  helper.check(f.root);
});

test("no delta and replay preserve ASAR/report bytes, inode and mtime", (t) => {
  const f = fixture(t, { authority: false });
  const asar = stamp(f.asar); const report = stamp(f.report);
  assert.equal(helper.sync(f.root).changed, false); helper.check(f.root);
  sameFile(f.asar, asar); sameFile(f.report, report);
});

test("real delta supports readonly ASAR/report and leaves every physical unpacked file untouched", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "changed physical bytes");
  for (const name of [f.asar, f.report, f.nativePath, f.emptyPath]) fs.chmodSync(name, 0o444);
  const native = stamp(f.nativePath); const empty = stamp(f.emptyPath);
  helper.sync(f.root); helper.check(f.root);
  assert.equal(fs.statSync(f.asar).mode & 0o777, 0o444); assert.equal(fs.statSync(f.report).mode & 0o777, 0o444);
  sameFile(f.nativePath, native); sameFile(f.emptyPath, empty);
  const asar = stamp(f.asar); const report = stamp(f.report); helper.sync(f.root);
  sameFile(f.asar, asar); sameFile(f.report, report);
});

test("multiple adaptations append a linked lineage and unchanged replay adds no record", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "change one"); helper.sync(f.root);
  const one = JSON.parse(fs.readFileSync(f.report)); fs.writeFileSync(f.nativePath, "change two has another length"); helper.sync(f.root);
  const two = JSON.parse(fs.readFileSync(f.report));
  assert.equal(two.nixAsarUnpackedIntegrity.transitions.length, 2);
  assert.equal(two.nixAsarUnpackedIntegrity.transitions[1].beforeSha256, one.outputAppAsar.sha256);
  const report = stamp(f.report); helper.sync(f.root); sameFile(f.report, report);
});

for (const name of ["../escape", "/outside", "a/b", "a\\b", "\0bad"]) {
  test(`rejects unsafe header component ${JSON.stringify(name)}`, (t) => {
    const f = fixture(t); mutateHeader(f, (header) => { header.files[name] = header.files["10"]; });
    const before = stamp(f.asar); assert.throws(() => helper.sync(f.root), /unsafe/); sameFile(f.asar, before);
  });
}
for (const scenario of ["missing", "orphan", "symlink", "directory-symlink", "root-symlink", "archive-symlink", "report-symlink"]) {
  test(`fails closed for ${scenario} filesystem input`, (t) => {
    const f = fixture(t); let target = f.root;
    if (scenario === "missing") fs.unlinkSync(f.nativePath);
    if (scenario === "orphan") fs.writeFileSync(path.join(f.unpacked, "orphan"), "orphan");
    if (scenario === "symlink") { fs.unlinkSync(f.nativePath); fs.symlinkSync(f.report, f.nativePath); }
    if (scenario === "directory-symlink") { fs.renameSync(path.join(f.unpacked, "node_modules"), path.join(f.root, "moved")); fs.symlinkSync(path.join(f.root, "moved"), path.join(f.unpacked, "node_modules")); }
    if (scenario === "root-symlink") { target = f.root + "-link"; fs.symlinkSync(f.root, target); t.after(() => fs.unlinkSync(target)); }
    if (scenario === "archive-symlink") { fs.renameSync(f.asar, f.asar + ".real"); fs.symlinkSync(f.asar + ".real", f.asar); }
    if (scenario === "report-symlink") { fs.renameSync(f.report, f.report + ".real"); fs.symlinkSync(f.report + ".real", f.report); }
    assert.throws(() => helper.sync(target));
  });
}
for (const scenario of ["partial-overlap", "out-of-range", "absent-link", "link-cycle", "bad-algorithm", "bad-blocks", "partial-unpacked", "bad-offset"]) {
  test(`rejects ${scenario} archive metadata`, (t) => {
    const f = fixture(t); mutateHeader(f, (header) => {
      if (scenario === "partial-overlap") { header.files["2"].offset = "1"; header.files["2"].size = 2; header.files["2"].integrity = integrity(f.packed.subarray(1, 3)); }
      if (scenario === "out-of-range") header.files["2"].offset = "99999";
      if (scenario === "absent-link") header.files["inside-link"].link = "absent";
      if (scenario === "link-cycle") header.files["inside-link"].link = "inside-link";
      if (scenario === "bad-algorithm") header.files["10"].integrity.algorithm = "SHA512";
      if (scenario === "bad-blocks") header.files["10"].integrity.blocks = [];
      if (scenario === "partial-unpacked") delete header.files.node_modules.files["native.node"].integrity;
      if (scenario === "bad-offset") header.files["10"].offset = "01";
    });
    const before = stamp(f.asar); assert.throws(() => helper.sync(f.root)); sameFile(f.asar, before);
  });
}

test("packed corruption and truncation fail before any publication", (t) => {
  const f = fixture(t); const bytes = fs.readFileSync(f.asar); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(f.asar, bytes);
  const before = stamp(f.asar); assert.throws(() => helper.sync(f.root), /packed integrity mismatch/); sameFile(f.asar, before);
  fs.truncateSync(f.asar, bytes.length - 2); assert.throws(() => helper.sync(f.root), /outside payload/);
});

test("duplicate JSON keys, malformed pickle/padding and truncated headers are rejected", (t) => {
  const f = fixture(t); const old = readArchive(f);
  const duplicate = old.text.replace('"size":', '"size":1,"size":');
  fs.writeFileSync(f.asar, Buffer.concat([frame(duplicate), old.tail])); assert.throws(() => helper.sync(f.root), /duplicate/);
  const invalid = Buffer.from(old.bytes); invalid.writeUInt32LE(9, 0); fs.writeFileSync(f.asar, invalid); assert.throws(() => helper.sync(f.root), /pickle/);
  fs.writeFileSync(f.asar, old.bytes.subarray(0, 12)); assert.throws(() => helper.sync(f.root), /truncated/);
});

test("delta requires active ASAR/core authority and a current patch-report output SHA", (t) => {
  const f = fixture(t, { authority: false }); fs.writeFileSync(f.nativePath, "changed");
  const before = stamp(f.asar); assert.throws(() => helper.sync(f.root), /active ASAR/); sameFile(f.asar, before);
  const report = JSON.parse(fs.readFileSync(f.report)); report.outputAppAsar.sha256 = "f".repeat(64); fs.writeFileSync(f.report, JSON.stringify(report));
  assert.throws(() => helper.sync(f.root), /bind the current ASAR/); sameFile(f.asar, before);
});

test("staging write failure preserves original ASAR/report and removes owned temporary files", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "changed"); const asar = stamp(f.asar); const report = stamp(f.report);
  const write = fs.writeSync; let count = 0;
  fs.writeSync = (...args) => { if (++count === 2) throw new Error("injected temporary write failure"); return write(...args); };
  try { assert.throws(() => helper.sync(f.root), /injected/); } finally { fs.writeSync = write; }
  sameFile(f.asar, asar); sameFile(f.report, report); assertNoTemps(f);
});

test("ASAR atomic rename failure rolls patch report back before returning failure", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "changed"); const asar = stamp(f.asar); const report = stamp(f.report);
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => { if (destination.endsWith("/app.asar")) throw new Error("injected archive publication failure"); return rename(source, destination); };
  try { assert.throws(() => helper.sync(f.root), /injected/); } finally { fs.renameSync = rename; }
  sameFile(f.asar, asar); sameFile(f.report, report); assertNoTemps(f);
});

test("physical mutation during preparation refuses publication", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "changed"); const asar = stamp(f.asar); const report = stamp(f.report);
  const write = fs.writeSync; let changed = false;
  fs.writeSync = (...args) => { const result = write(...args); if (!changed) { changed = true; fs.appendFileSync(f.nativePath, "raced"); } return result; };
  try { assert.throws(() => helper.sync(f.root), /input changed/); } finally { fs.writeSync = write; }
  sameFile(f.asar, asar); sameFile(f.report, report); assertNoTemps(f);
});

test("normal CLI sync/check entrypoints use the same strict implementation", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "CLI changed bytes");
  const filename = path.resolve(__dirname, "../../nix/asar-unpacked-integrity.cjs");
  for (const command of ["sync", "check"]) {
    const result = childProcess.spawnSync(process.execPath, [filename, command, "--root", f.root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); assert.ok(JSON.parse(result.stdout).sha256 || JSON.parse(result.stdout).afterSha256);
  }
});


test("nonzero pickle padding, invalid JSON whitespace and incomplete report lineage fail closed", (t) => {
  const f = fixture(t); const old = readArchive(f);
  let text = old.text;
  while ((4 + Buffer.byteLength(text)) % 4 === 0) text += " ";
  const prefix = frame(text); prefix[prefix.length - 1] = 1;
  fs.writeFileSync(f.asar, Buffer.concat([prefix, old.tail]));
  assert.throws(() => helper.sync(f.root), /padding/);
  fs.writeFileSync(f.asar, Buffer.concat([frame(old.text + "\u00a0"), old.tail]));
  assert.throws(() => helper.sync(f.root), /trailing/);
  fs.writeFileSync(f.asar, old.bytes);
  const report = JSON.parse(fs.readFileSync(f.report));
  report.nixAsarUnpackedIntegrity = { schemaVersion: 1, transitions: [{ beforeSha256: "a".repeat(64), afterSha256: report.outputAppAsar.sha256, changedPaths: [] }] };
  fs.writeFileSync(f.report, JSON.stringify(report));
  assert.throws(() => helper.check(f.root), /lineage/);
});

test("a partial provenance publication is rejected, never accepted as a successful final archive", (t) => {
  const f = fixture(t); const report = JSON.parse(fs.readFileSync(f.report));
  report.outputAppAsar.sha256 = "f".repeat(64);
  report.nixAsarUnpackedIntegrity = { schemaVersion: 1, transitions: [{ beforeSha256: hash(fs.readFileSync(f.asar)), afterSha256: report.outputAppAsar.sha256, changedPaths: ["node_modules/native.node"] }] };
  fs.writeFileSync(f.report, JSON.stringify(report));
  assert.throws(() => helper.check(f.root), /bind the current ASAR/);
  assert.throws(() => helper.sync(f.root), /bind the current ASAR/);
});

test("patch-report publication failure leaves the archive and report original", (t) => {
  const f = fixture(t); fs.writeFileSync(f.nativePath, "changed"); const asar = stamp(f.asar); const report = stamp(f.report);
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => { if (destination.endsWith("/patch-report.json")) throw new Error("injected report publication failure"); return rename(source, destination); };
  try { assert.throws(() => helper.sync(f.root), /injected/); } finally { fs.renameSync = rename; }
  sameFile(f.asar, asar); sameFile(f.report, report); assertNoTemps(f);
});


test("FIFO archive/report inputs fail closed without blocking", (t) => {
  const filename = path.resolve(__dirname, "../../nix/asar-unpacked-integrity.cjs");
  for (const kind of ["asar", "report"]) {
    const f = fixture(t); fs.unlinkSync(f[kind]);
    const make = childProcess.spawnSync("mkfifo", [f[kind]], { encoding: "utf8" });
    assert.equal(make.status, 0, make.stderr);
    const result = childProcess.spawnSync(process.execPath, [filename, "check", "--root", f.root], { encoding: "utf8", timeout: 2000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /bounded regular file/);
  }
});
