#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const ELF_HEADER_SIZE = 64;
const PROGRAM_HEADER_SIZE = 56;
const SECTION_HEADER_SIZE = 64;
const DETECT_LIBC_SCAN_SIZE = 2048;
const PATCHELF_FILL_BYTES = new Set([0x00, 0x58, 0x5a]);
const PT_LOAD = 1;
const PT_INTERP = 3;
const SHT_PROGBITS = 1;
const SHT_NOBITS = 8;
const SHF_ALLOC = 2n;

function fail(message) {
  throw new Error(message);
}

function checkedNumber(value, label) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${label} exceeds JavaScript's safe integer range`);
  }
  return Number(value);
}

function checkedRange(offset, size, bufferLength, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > bufferLength - size
  ) {
    fail(`${label} is outside the ELF file`);
  }
}

function rangesOverlap(startA, sizeA, startB, sizeB) {
  return (
    sizeA > 0 && sizeB > 0 && startA < startB + sizeB && startB < startA + sizeA
  );
}

function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function readCString(buffer, offset, limit, label) {
  if (offset < 0 || offset >= limit) {
    fail(`${label} starts outside its string table`);
  }
  const end = buffer.indexOf(0, offset);
  if (end === -1 || end >= limit) {
    fail(`${label} is not NUL-terminated inside its string table`);
  }
  return buffer.toString("utf8", offset, end);
}

function parseElf(buffer, expectedInterpreter) {
  checkedRange(0, ELF_HEADER_SIZE, buffer.length, "ELF header");
  if (buffer.readUInt32BE(0) !== 0x7f454c46) fail("not an ELF file");
  if (buffer[4] !== 2) fail("expected a 64-bit ELF file");
  if (buffer[5] !== 1) fail("expected a little-endian ELF file");

  const machine = buffer.readUInt16LE(18);
  if (machine !== 62 && machine !== 183)
    fail(`unsupported ELF machine: ${machine}`);
  if (buffer.readUInt16LE(52) !== ELF_HEADER_SIZE)
    fail("unexpected ELF header size");

  const programOffset = checkedNumber(
    buffer.readBigUInt64LE(32),
    "program header offset",
  );
  const programEntrySize = buffer.readUInt16LE(54);
  const programCount = buffer.readUInt16LE(56);
  if (
    programEntrySize !== PROGRAM_HEADER_SIZE ||
    programCount === 0 ||
    programCount === 0xffff
  ) {
    fail("unsupported program header table");
  }
  const programSize = programEntrySize * programCount;
  checkedRange(
    programOffset,
    programSize,
    buffer.length,
    "program header table",
  );

  const sectionOffset = checkedNumber(
    buffer.readBigUInt64LE(40),
    "section header offset",
  );
  const sectionEntrySize = buffer.readUInt16LE(58);
  const sectionCount = buffer.readUInt16LE(60);
  const sectionNamesIndex = buffer.readUInt16LE(62);
  if (
    sectionEntrySize !== SECTION_HEADER_SIZE ||
    sectionCount === 0 ||
    sectionCount === 0xffff ||
    sectionNamesIndex >= sectionCount ||
    sectionNamesIndex === 0xffff
  ) {
    fail("unsupported section header table");
  }
  checkedRange(
    sectionOffset,
    sectionEntrySize * sectionCount,
    buffer.length,
    "section header table",
  );

  const programs = [];
  for (let index = 0; index < programCount; index += 1) {
    const header = programOffset + index * programEntrySize;
    const item = {
      header,
      type: buffer.readUInt32LE(header),
      offset: checkedNumber(
        buffer.readBigUInt64LE(header + 8),
        `program ${index} offset`,
      ),
      vaddr: buffer.readBigUInt64LE(header + 16),
      paddr: buffer.readBigUInt64LE(header + 24),
      fileSize: checkedNumber(
        buffer.readBigUInt64LE(header + 32),
        `program ${index} file size`,
      ),
      memorySize: checkedNumber(
        buffer.readBigUInt64LE(header + 40),
        `program ${index} memory size`,
      ),
    };
    checkedRange(item.offset, item.fileSize, buffer.length, `program ${index}`);
    programs.push(item);
  }

  const interpreters = programs.filter(({ type }) => type === PT_INTERP);
  if (interpreters.length !== 1)
    fail(`expected one PT_INTERP, found ${interpreters.length}`);
  const interpreter = interpreters[0];
  if (
    interpreter.fileSize !== interpreter.memorySize ||
    interpreter.fileSize === 0
  ) {
    fail("PT_INTERP has inconsistent size");
  }
  const expectedBytes = Buffer.from(`${expectedInterpreter}\0`);
  if (
    !buffer
      .subarray(interpreter.offset, interpreter.offset + interpreter.fileSize)
      .equals(expectedBytes)
  ) {
    fail("PT_INTERP does not contain the expected dynamic linker");
  }

  const rawSections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const header = sectionOffset + index * sectionEntrySize;
    const item = {
      header,
      nameOffset: buffer.readUInt32LE(header),
      type: buffer.readUInt32LE(header + 4),
      flags: buffer.readBigUInt64LE(header + 8),
      address: buffer.readBigUInt64LE(header + 16),
      offset: checkedNumber(
        buffer.readBigUInt64LE(header + 24),
        `section ${index} offset`,
      ),
      size: checkedNumber(
        buffer.readBigUInt64LE(header + 32),
        `section ${index} size`,
      ),
      alignment: checkedNumber(
        buffer.readBigUInt64LE(header + 48),
        `section ${index} alignment`,
      ),
    };
    if (item.type !== SHT_NOBITS)
      checkedRange(item.offset, item.size, buffer.length, `section ${index}`);
    rawSections.push(item);
  }

  const names = rawSections[sectionNamesIndex];
  if (names.type !== 3 || names.size === 0)
    fail("invalid section-name string table");
  const namesLimit = names.offset + names.size;
  const sections = rawSections.map((section, index) => ({
    ...section,
    name: readCString(
      buffer,
      names.offset + section.nameOffset,
      namesLimit,
      `section ${index} name`,
    ),
  }));
  const interpreterSections = sections.filter(({ name }) => name === ".interp");
  if (interpreterSections.length !== 1) {
    fail(`expected one .interp section, found ${interpreterSections.length}`);
  }
  const interpreterSection = interpreterSections[0];
  if (
    interpreterSection.type !== SHT_PROGBITS ||
    !(interpreterSection.flags & SHF_ALLOC) ||
    interpreterSection.offset !== interpreter.offset ||
    interpreterSection.address !== interpreter.vaddr ||
    interpreterSection.size !== interpreter.fileSize
  ) {
    fail(".interp does not match PT_INTERP");
  }
  const alignment = interpreterSection.alignment;
  if (
    alignment === 0 ||
    alignment > DETECT_LIBC_SCAN_SIZE ||
    (alignment & (alignment - 1)) !== 0
  ) {
    fail(`unsupported .interp alignment: ${alignment}`);
  }

  return {
    expectedBytes,
    interpreter,
    interpreterSection,
    programs,
    sections,
    programEnd: programOffset + programSize,
    alignment,
  };
}

function inspectInterpreter(buffer, expectedInterpreter) {
  const parsed = parseElf(buffer, expectedInterpreter);
  return {
    offset: parsed.interpreter.offset,
    size: parsed.interpreter.fileSize,
    path: expectedInterpreter,
  };
}

function relocateBuffer(buffer, expectedInterpreter) {
  const parsed = parseElf(buffer, expectedInterpreter);
  const { expectedBytes, interpreter, interpreterSection, programs, sections } =
    parsed;
  if (interpreter.offset + interpreter.fileSize <= DETECT_LIBC_SCAN_SIZE) {
    fail("PT_INTERP is already inside detect-libc scan range");
  }

  const firstCandidate = alignUp(parsed.programEnd, parsed.alignment);
  const lastCandidate =
    Math.min(buffer.length, DETECT_LIBC_SCAN_SIZE) - expectedBytes.length;
  let targetOffset;
  let load;
  for (
    let candidate = firstCandidate;
    candidate <= lastCandidate;
    candidate += parsed.alignment
  ) {
    const relocationSlot = buffer.subarray(
      candidate,
      candidate + expectedBytes.length,
    );
    if (!relocationSlot.every((byte) => PATCHELF_FILL_BYTES.has(byte)))
      continue;

    const loads = programs.filter(
      ({ type, offset, fileSize }) =>
        type === PT_LOAD &&
        candidate >= offset &&
        candidate + expectedBytes.length <= offset + fileSize,
    );
    if (loads.length !== 1) continue;

    const overlapsProgram = programs.some(
      (program) =>
        program.type !== PT_LOAD &&
        program !== interpreter &&
        rangesOverlap(
          candidate,
          expectedBytes.length,
          program.offset,
          program.fileSize,
        ),
    );
    if (overlapsProgram) continue;

    const overlapsSection = sections.some(
      (section) =>
        section.type !== SHT_NOBITS &&
        section !== interpreterSection &&
        rangesOverlap(
          candidate,
          expectedBytes.length,
          section.offset,
          section.size,
        ),
    );
    if (overlapsSection) continue;

    targetOffset = candidate;
    load = loads[0];
    break;
  }
  if (targetOffset === undefined || load === undefined) {
    fail(
      "no safe patchelf padding for PT_INTERP inside detect-libc scan range",
    );
  }

  const delta = BigInt(targetOffset - load.offset);
  const targetAddress = load.vaddr + delta;
  const targetPhysicalAddress = load.paddr + delta;
  const patched = Buffer.from(buffer);
  expectedBytes.copy(patched, targetOffset);
  patched.writeBigUInt64LE(BigInt(targetOffset), interpreter.header + 8);
  patched.writeBigUInt64LE(targetAddress, interpreter.header + 16);
  patched.writeBigUInt64LE(targetPhysicalAddress, interpreter.header + 24);
  patched.writeBigUInt64LE(
    BigInt(expectedBytes.length),
    interpreter.header + 32,
  );
  patched.writeBigUInt64LE(
    BigInt(expectedBytes.length),
    interpreter.header + 40,
  );
  patched.writeBigUInt64LE(targetAddress, interpreterSection.header + 16);
  patched.writeBigUInt64LE(
    BigInt(targetOffset),
    interpreterSection.header + 24,
  );
  patched.writeBigUInt64LE(
    BigInt(expectedBytes.length),
    interpreterSection.header + 32,
  );

  const verified = parseElf(patched, expectedInterpreter);
  if (
    verified.interpreter.offset !== targetOffset ||
    targetOffset + verified.interpreter.fileSize > DETECT_LIBC_SCAN_SIZE ||
    patched.length !== buffer.length
  ) {
    fail("relocated PT_INTERP verification failed");
  }
  return patched;
}

function relocateFile(elfPath, expectedInterpreter) {
  const original = fs.readFileSync(elfPath);
  const patched = relocateBuffer(original, expectedInterpreter);
  const temporaryPath = `${elfPath}.codex-desktop-${process.pid}.tmp`;
  const mode = fs.statSync(elfPath).mode;
  try {
    fs.writeFileSync(temporaryPath, patched, { mode });
    fs.renameSync(temporaryPath, elfPath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

function checkFile(elfPath, expectedInterpreter) {
  const result = inspectInterpreter(
    fs.readFileSync(elfPath),
    expectedInterpreter,
  );
  if (result.offset + result.size > DETECT_LIBC_SCAN_SIZE) {
    fail("PT_INTERP is outside detect-libc scan range");
  }
  return result;
}

function main(argv) {
  const [command, elfPath, expectedInterpreter] = argv;
  if (
    !["relocate", "check"].includes(command) ||
    !elfPath ||
    !expectedInterpreter
  ) {
    fail(
      "usage: relocate-elf-interpreter.cjs <relocate|check> <elf> <expected-dynamic-linker>",
    );
  }
  if (command === "relocate") {
    relocateFile(elfPath, expectedInterpreter);
  } else {
    checkFile(elfPath, expectedInterpreter);
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[relocate-elf-interpreter] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DETECT_LIBC_SCAN_SIZE,
  checkFile,
  inspectInterpreter,
  relocateBuffer,
  relocateFile,
};
