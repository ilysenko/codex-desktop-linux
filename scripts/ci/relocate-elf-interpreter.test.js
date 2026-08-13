"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  DETECT_LIBC_SCAN_SIZE,
  inspectInterpreter,
  relocateBuffer,
  relocateFile,
} = require("../../nix/relocate-elf-interpreter.cjs");

const PH_OFFSET = 64;
const PH_SIZE = 56;
const PH_COUNT = 4;
const SLOT_OFFSET = PH_OFFSET + PH_SIZE * PH_COUNT;
const INTERP_PH = PH_OFFSET + 2 * PH_SIZE;
const SECTION_OFFSET = 0xc00;
const INTERP_SH = SECTION_OFFSET + 64;

function writeProgram(buffer, index, type, offset, size, address = offset) {
  const header = PH_OFFSET + index * PH_SIZE;
  buffer.writeUInt32LE(type, header);
  buffer.writeUInt32LE(4, header + 4);
  buffer.writeBigUInt64LE(BigInt(offset), header + 8);
  buffer.writeBigUInt64LE(BigInt(address), header + 16);
  buffer.writeBigUInt64LE(BigInt(address), header + 24);
  buffer.writeBigUInt64LE(BigInt(size), header + 32);
  buffer.writeBigUInt64LE(BigInt(size), header + 40);
  buffer.writeBigUInt64LE(8n, header + 48);
}

function writeSection(
  buffer,
  index,
  name,
  type,
  flags,
  address,
  offset,
  size,
  alignment,
) {
  const header = SECTION_OFFSET + index * 64;
  buffer.writeUInt32LE(name, header);
  buffer.writeUInt32LE(type, header + 4);
  buffer.writeBigUInt64LE(BigInt(flags), header + 8);
  buffer.writeBigUInt64LE(BigInt(address), header + 16);
  buffer.writeBigUInt64LE(BigInt(offset), header + 24);
  buffer.writeBigUInt64LE(BigInt(size), header + 32);
  buffer.writeBigUInt64LE(BigInt(alignment), header + 48);
}

function elfFixture(
  machine,
  interpreter,
  interpreterOffset = 0x900,
  paddingByte = 0x5a,
) {
  const buffer = Buffer.alloc(4096);
  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(3, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(BigInt(PH_OFFSET), 32);
  buffer.writeBigUInt64LE(BigInt(SECTION_OFFSET), 40);
  buffer.writeUInt16LE(64, 52);
  buffer.writeUInt16LE(PH_SIZE, 54);
  buffer.writeUInt16LE(PH_COUNT, 56);
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(3, 60);
  buffer.writeUInt16LE(2, 62);

  const interpreterBytes = Buffer.from(`${interpreter}\0`);
  writeProgram(buffer, 0, 6, PH_OFFSET, PH_SIZE * PH_COUNT);
  writeProgram(buffer, 1, 1, 0, buffer.length);
  writeProgram(buffer, 2, 3, interpreterOffset, interpreterBytes.length);
  writeProgram(buffer, 3, 4, 0xb00, 16);
  buffer.fill(paddingByte, SLOT_OFFSET, DETECT_LIBC_SCAN_SIZE);
  interpreterBytes.copy(buffer, interpreterOffset);

  const sectionNames = Buffer.from("\0.interp\0.shstrtab\0");
  sectionNames.copy(buffer, 0xa00);
  writeSection(
    buffer,
    1,
    1,
    1,
    2,
    interpreterOffset,
    interpreterOffset,
    interpreterBytes.length,
    8,
  );
  writeSection(buffer, 2, 9, 3, 0, 0, 0xa00, sectionNames.length, 1);
  return buffer;
}

test("accepts zero-filled patchelf padding", () => {
  const interpreter =
    "/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-glibc/lib/ld-linux-x86-64.so.2";
  const patched = relocateBuffer(
    elfFixture(62, interpreter, 0x900, 0),
    interpreter,
  );
  assert.equal(inspectInterpreter(patched, interpreter).offset, SLOT_OFFSET);
});

test("accepts 0x58 padding from the pinned Nix patchelf", () => {
  const interpreter =
    "/nix/store/12121212121212121212121212121212-glibc/lib/ld-linux-x86-64.so.2";
  const patched = relocateBuffer(
    elfFixture(62, interpreter, 0x900, 0x58),
    interpreter,
  );
  assert.equal(inspectInterpreter(patched, interpreter).offset, SLOT_OFFSET);
});

test("accepts mixed zero and 0x5a patchelf padding", () => {
  const interpreter =
    "/nix/store/ffffffffffffffffffffffffffffffff-glibc/lib/ld-linux-x86-64.so.2";
  const fixture = elfFixture(62, interpreter);
  for (let index = SLOT_OFFSET; index < DETECT_LIBC_SCAN_SIZE; index += 2) {
    fixture[index] = 0;
  }
  const patched = relocateBuffer(fixture, interpreter);
  assert.equal(inspectInterpreter(patched, interpreter).offset, SLOT_OFFSET);
});

test("skips occupied bytes before safe patchelf padding", () => {
  const interpreter =
    "/nix/store/11111111111111111111111111111111-glibc/lib/ld-linux-x86-64.so.2";
  const fixture = elfFixture(62, interpreter);
  fixture.fill(1, SLOT_OFFSET, SLOT_OFFSET + 16);
  const patched = relocateBuffer(fixture, interpreter);
  assert.equal(
    inspectInterpreter(patched, interpreter).offset,
    SLOT_OFFSET + 16,
  );
});

function interpreterFromFirstTwoKiB(buffer) {
  const scan = buffer.subarray(0, DETECT_LIBC_SCAN_SIZE);
  const programOffset = Number(scan.readBigUInt64LE(32));
  const entrySize = scan.readUInt16LE(54);
  const count = scan.readUInt16LE(56);
  for (let index = 0; index < count; index += 1) {
    const header = programOffset + index * entrySize;
    if (scan.readUInt32LE(header) === 3) {
      const offset = Number(scan.readBigUInt64LE(header + 8));
      const size = Number(scan.readBigUInt64LE(header + 32));
      return scan
        .subarray(offset, offset + size)
        .toString()
        .replace(/\0.*$/s, "");
    }
  }
  return null;
}

for (const [name, machine, interpreter] of [
  [
    "x86_64",
    62,
    "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-glibc/lib/ld-linux-x86-64.so.2",
  ],
  [
    "aarch64",
    183,
    "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-glibc/lib/ld-linux-aarch64.so.1",
  ],
]) {
  test(`relocates ${name} PT_INTERP into detect-libc scan range`, () => {
    const original = elfFixture(machine, interpreter);
    const patched = relocateBuffer(original, interpreter);
    const inspected = inspectInterpreter(patched, interpreter);

    assert.equal(patched.length, original.length);
    assert.equal(inspected.offset, SLOT_OFFSET);
    assert.ok(inspected.offset + inspected.size <= DETECT_LIBC_SCAN_SIZE);
    assert.equal(interpreterFromFirstTwoKiB(patched), interpreter);
    assert.equal(Number(patched.readBigUInt64LE(INTERP_SH + 24)), SLOT_OFFSET);
    assert.equal(
      patched.subarray(0x900, 0x900 + interpreter.length + 1).toString(),
      `${interpreter}\0`,
    );

    const allowed = new Set();
    for (
      let index = SLOT_OFFSET;
      index < SLOT_OFFSET + interpreter.length + 1;
      index += 1
    )
      allowed.add(index);
    for (const [start, size] of [
      [INTERP_PH + 8, 40],
      [INTERP_SH + 16, 24],
    ]) {
      for (let index = start; index < start + size; index += 1)
        allowed.add(index);
    }
    for (let index = 0; index < original.length; index += 1) {
      if (!allowed.has(index))
        assert.equal(
          patched[index],
          original[index],
          `unexpected change at ${index}`,
        );
    }
  });
}

test("relocateFile preserves executable mode", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "relocate-elf-interpreter-"),
  );
  const elfPath = path.join(directory, "ChatGPT");
  const interpreter =
    "/nix/store/cccccccccccccccccccccccccccccccc-glibc/lib/ld-linux-x86-64.so.2";
  try {
    fs.writeFileSync(elfPath, elfFixture(62, interpreter), { mode: 0o755 });
    relocateFile(elfPath, interpreter);
    assert.equal(fs.statSync(elfPath).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const [name, mutate, pattern] of [
  [
    "an unsupported machine",
    (buffer) => buffer.writeUInt16LE(40, 18),
    /unsupported ELF machine/,
  ],
  [
    "duplicate PT_INTERP",
    (buffer) => buffer.writeUInt32LE(3, PH_OFFSET + 3 * PH_SIZE),
    /expected one PT_INTERP/,
  ],
  [
    "non-padding bytes",
    (buffer) => {
      buffer.fill(1, SLOT_OFFSET, DETECT_LIBC_SCAN_SIZE);
    },
    /no safe patchelf padding/,
  ],
  [
    "an already visible interpreter",
    null,
    /already inside detect-libc scan range/,
  ],
  [
    "mismatched .interp metadata",
    (buffer) => buffer.writeBigUInt64LE(0x901n, INTERP_SH + 24),
    /\.interp does not match/,
  ],
]) {
  test(`fails closed for ${name}`, () => {
    const interpreter =
      "/nix/store/dddddddddddddddddddddddddddddddd-glibc/lib/ld-linux-x86-64.so.2";
    const original = elfFixture(
      62,
      interpreter,
      name === "an already visible interpreter" ? 0x700 : 0x900,
    );
    if (mutate) mutate(original);
    const snapshot = Buffer.from(original);
    assert.throws(() => relocateBuffer(original, interpreter), pattern);
    assert.deepEqual(original, snapshot);
  });
}
