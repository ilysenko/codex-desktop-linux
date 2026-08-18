#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MANIFEST_PATH = path.join(
  __dirname,
  "elf-runtime-manifest.json",
);
const ELF_MAGIC = 0x7f454c46;
const ELFCLASS32 = 1;
const ELFCLASS64 = 2;
const ELFDATA2LSB = 1;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_RPATH = 15n;
const DT_RUNPATH = 29n;
const DT_FLAGS_1 = 0x6ffffffbn;
const DF_1_PIE = 0x08000000n;
const TARGET_ARCHITECTURES = Object.freeze({ amd64: 62, arm64: 183 });

function fail(message) {
  throw new Error(message);
}

function checkedNumber(value, label) {
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      fail(`${label} exceeds JavaScript's safe integer range`);
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0)
    fail(`${label} is not a safe non-negative integer`);
  return value;
}

function checkedRange(offset, size, bufferLength, label) {
  checkedNumber(offset, `${label} offset`);
  checkedNumber(size, `${label} size`);
  if (offset > bufferLength - size) fail(`${label} is outside the ELF file`);
}

function readCString(buffer, offset, limit, label) {
  if (offset < 0 || offset >= limit) fail(`${label} is outside its string table`);
  const end = buffer.indexOf(0, offset);
  if (end === -1 || end >= limit)
    fail(`${label} is not NUL-terminated inside its string table`);
  return buffer.toString("utf8", offset, end);
}

function readElfInteger(buffer, offset, width) {
  return width === 8
    ? checkedNumber(buffer.readBigUInt64LE(offset), "ELF integer")
    : buffer.readUInt32LE(offset);
}

function readElfSignedTag(buffer, offset, width) {
  return width === 8
    ? buffer.readBigInt64LE(offset)
    : BigInt(buffer.readInt32LE(offset));
}

function virtualFileRange(programs, address, size, bufferLength, label) {
  const end = address + size;
  if (!Number.isSafeInteger(end)) fail(`${label} exceeds the supported range`);
  const loads = programs
    .filter(({ type: programType }) => programType === PT_LOAD)
    .filter(
      ({ vaddr, fileSize }) => vaddr < end && address < vaddr + fileSize,
    )
    .sort((left, right) => left.vaddr - right.vaddr);
  const first = loads.find(
    ({ vaddr, fileSize }) => address >= vaddr && address < vaddr + fileSize,
  );
  if (!first) fail(`${label} is not backed by PT_LOAD`);
  const fileAddressDelta = first.offset - first.vaddr;
  let cursor = address;
  while (cursor < end) {
    const covering = loads.filter(
      ({ vaddr, fileSize, offset }) =>
        cursor >= vaddr &&
        cursor < vaddr + fileSize &&
        offset - vaddr === fileAddressDelta,
    );
    if (covering.length === 0)
      fail(`${label} is not contiguously file-backed by PT_LOAD`);
    cursor = Math.max(
      ...covering.map(({ vaddr, fileSize }) => Math.min(end, vaddr + fileSize)),
    );
  }
  const offset = address + fileAddressDelta;
  checkedRange(offset, size, bufferLength, label);
  return offset;
}

function parseElf(buffer, relativePath = "<buffer>") {
  if (!Buffer.isBuffer(buffer)) fail("ELF input must be a Buffer");
  if (buffer.length < 4 || buffer.readUInt32BE(0) !== ELF_MAGIC)
    return null;
  if (buffer.length < 20) fail(`${relativePath}: truncated ELF header`);

  const elfClass = buffer[4];
  if (![ELFCLASS32, ELFCLASS64].includes(elfClass))
    fail(`${relativePath}: unsupported ELF class ${elfClass}`);
  if (buffer[5] !== ELFDATA2LSB)
    fail(`${relativePath}: only little-endian ELF files are supported`);

  const is64 = elfClass === ELFCLASS64;
  const headerSize = is64 ? 64 : 52;
  const canonicalProgramSize = is64 ? 56 : 32;
  checkedRange(0, headerSize, buffer.length, `${relativePath}: ELF header`);
  if (buffer.readUInt16LE(is64 ? 52 : 40) !== headerSize)
    fail(`${relativePath}: unexpected ELF header size`);

  const type = buffer.readUInt16LE(16);
  const machine = buffer.readUInt16LE(18);
  const programOffset = readElfInteger(buffer, is64 ? 32 : 28, is64 ? 8 : 4);
  const programEntrySize = buffer.readUInt16LE(is64 ? 54 : 42);
  const programCount = buffer.readUInt16LE(is64 ? 56 : 44);
  if (programCount === 0xffff)
    fail(`${relativePath}: extended program-header counts are unsupported`);
  if (programCount > 0 && programEntrySize !== canonicalProgramSize)
    fail(`${relativePath}: unexpected program-header entry size`);
  checkedRange(
    programOffset,
    programEntrySize * programCount,
    buffer.length,
    `${relativePath}: program-header table`,
  );

  const programs = [];
  for (let index = 0; index < programCount; index += 1) {
    const header = programOffset + index * programEntrySize;
    const program = is64
      ? {
          type: buffer.readUInt32LE(header),
          offset: readElfInteger(buffer, header + 8, 8),
          vaddr: readElfInteger(buffer, header + 16, 8),
          fileSize: readElfInteger(buffer, header + 32, 8),
          memorySize: readElfInteger(buffer, header + 40, 8),
        }
      : {
          type: buffer.readUInt32LE(header),
          offset: buffer.readUInt32LE(header + 4),
          vaddr: buffer.readUInt32LE(header + 8),
          fileSize: buffer.readUInt32LE(header + 16),
          memorySize: buffer.readUInt32LE(header + 20),
        };
    checkedRange(
      program.offset,
      program.fileSize,
      buffer.length,
      `${relativePath}: program header ${index}`,
    );
    programs.push(program);
  }

  const interpreters = programs.filter(
    ({ type: programType }) => programType === PT_INTERP,
  );
  if (interpreters.length > 1)
    fail(`${relativePath}: multiple PT_INTERP program headers`);
  let interpreter = null;
  if (interpreters.length === 1) {
    const program = interpreters[0];
    if (program.fileSize === 0 || program.fileSize !== program.memorySize)
      fail(`${relativePath}: inconsistent PT_INTERP size`);
    interpreter = readCString(
      buffer,
      program.offset,
      program.offset + program.fileSize,
      `${relativePath}: PT_INTERP`,
    );
  }

  const dynamicPrograms = programs.filter(
    ({ type: programType }) => programType === PT_DYNAMIC,
  );
  if (dynamicPrograms.length > 1)
    fail(`${relativePath}: multiple PT_DYNAMIC program headers`);
  const dynamicEntries = [];
  if (dynamicPrograms.length === 1) {
    const dynamic = dynamicPrograms[0];
    const entrySize = is64 ? 16 : 8;
    if (dynamic.fileSize % entrySize !== 0)
      fail(`${relativePath}: malformed PT_DYNAMIC size`);
    for (
      let offset = dynamic.offset;
      offset < dynamic.offset + dynamic.fileSize;
      offset += entrySize
    ) {
      const tag = readElfSignedTag(buffer, offset, is64 ? 8 : 4);
      const value = readElfInteger(
        buffer,
        offset + (is64 ? 8 : 4),
        is64 ? 8 : 4,
      );
      dynamicEntries.push({ tag, value });
      if (tag === DT_NULL) break;
    }
    if (!dynamicEntries.some(({ tag }) => tag === DT_NULL))
      fail(`${relativePath}: PT_DYNAMIC is not DT_NULL-terminated`);
  }

  const stringTags = new Set([DT_NEEDED, DT_RPATH, DT_RUNPATH]);
  const stringEntries = dynamicEntries.filter(({ tag }) => stringTags.has(tag));
  const strtabEntry = dynamicEntries.find(({ tag }) => tag === DT_STRTAB);
  const strszEntry = dynamicEntries.find(({ tag }) => tag === DT_STRSZ);
  const strings = new Map();
  if (stringEntries.length > 0) {
    if (!strtabEntry || !strszEntry || strszEntry.value === 0)
      fail(`${relativePath}: dynamic strings have no valid string table`);
    const stringOffset = virtualFileRange(
      programs,
      strtabEntry.value,
      strszEntry.value,
      buffer.length,
      `${relativePath}: dynamic string table`,
    );
    for (const entry of stringEntries) {
      if (entry.value >= strszEntry.value)
        fail(`${relativePath}: dynamic string offset is out of range`);
      strings.set(
        entry,
        readCString(
          buffer,
          stringOffset + entry.value,
          stringOffset + strszEntry.value,
          `${relativePath}: dynamic string`,
        ),
      );
    }
  }

  const needed = dynamicEntries
    .filter(({ tag }) => tag === DT_NEEDED)
    .map((entry) => strings.get(entry));
  const rpath = dynamicEntries
    .filter(({ tag }) => tag === DT_RPATH)
    .map((entry) => strings.get(entry));
  const runpath = dynamicEntries
    .filter(({ tag }) => tag === DT_RUNPATH)
    .map((entry) => strings.get(entry));
  const flags1 = BigInt(
    dynamicEntries.find(({ tag }) => tag === DT_FLAGS_1)?.value || 0,
  );
  const pathPlatform = /(?:^|\/)(?:android[^/]*|[^/]*musl[^/]*)(?:\/|$)/i.test(
    relativePath,
  )
    ? /android/i.test(relativePath)
      ? "android"
      : "musl"
    : null;
  const interpreterPlatform = interpreter
      ? /(?:^|\/)linker(?:64)?$/.test(interpreter) ||
        /\/system\//.test(interpreter)
      ? "android"
      : /musl/i.test(interpreter)
        ? "musl"
        : "glibc"
    : null;
  const platform = interpreterPlatform || pathPlatform || "glibc";
  const hasDynamic = dynamicPrograms.length === 1;
  const linkage = !hasDynamic
    ? "static"
    : !interpreter && (flags1 & DF_1_PIE) !== 0n && needed.length === 0
      ? "static-pie"
      : interpreter
        ? "dynamic-executable"
        : "dynamic-object";

  return {
    class: is64 ? 64 : 32,
    type,
    machine,
    architecture:
      Object.entries(TARGET_ARCHITECTURES).find(
        ([, value]) => value === machine,
      )?.[0] ||
      `machine-${machine}`,
    platform,
    linkage,
    interpreter,
    hasDynamic,
    needed,
    rpath,
    runpath,
  };
}

function inspectFile(filePath, relativePath = path.basename(filePath)) {
  return parseElf(fs.readFileSync(filePath), relativePath);
}

function walkFiles(root) {
  const results = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) results.push(absolute);
    }
  }
  visit(root);
  return results.sort();
}

function inventoryTree(root, architecture) {
  const expectedMachine = TARGET_ARCHITECTURES[architecture];
  if (!expectedMachine) fail(`unsupported target architecture: ${architecture}`);
  const absoluteRoot = path.resolve(root);
  return walkFiles(absoluteRoot).flatMap((absolutePath) => {
    const relativePath = path
      .relative(absoluteRoot, absolutePath)
      .split(path.sep)
      .join("/");
    let elf;
    try {
      elf = inspectFile(absolutePath, relativePath);
    } catch (error) {
      throw new Error(
        `${relativePath}: ${error.message.replace(`${relativePath}: `, "")}`,
      );
    }
    if (!elf) return [];
    return [
      {
        path: relativePath,
        absolutePath,
        target: elf.machine === expectedMachine,
        ...elf,
      },
    ];
  });
}

function loadManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1)
    fail("unsupported ELF runtime manifest schema");
  return manifest;
}

function manifestArchitecture(manifest, architecture) {
  const result = manifest.architectures?.[architecture];
  if (!result || result.machine !== TARGET_ARCHITECTURES[architecture])
    fail(`manifest has no valid ${architecture} contract`);
  return result;
}

function validateInventory(
  root,
  architecture,
  manifest = loadManifest(),
  { allowAdditional = false } = {},
) {
  const contract = manifestArchitecture(manifest, architecture);
  for (const forbidden of manifest.forbiddenPaths || []) {
    if (fs.existsSync(path.join(root, forbidden)))
      fail(`obsolete upstream path is present: ${forbidden}`);
  }
  const inventory = inventoryTree(root, architecture);
  const actual = inventory
    .filter(
      (item) =>
        item.target &&
        item.platform === "glibc" &&
        item.linkage === "dynamic-executable",
    )
    .map(({ path: itemPath }) => itemPath)
    .sort();
  const expected = [...contract.requiredDynamicExecutables].sort();
  const missing = expected.filter((item) => !actual.includes(item));
  const unexpected = actual.filter((item) => !expected.includes(item));
  if (missing.length > 0 || (!allowAdditional && unexpected.length > 0)) {
    fail(
      `upstream dynamic executable inventory drifted; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`,
    );
  }
  if (!allowAdditional && contract.targetInventorySha256) {
    const semanticInventory = inventory
      .filter((item) => item.target)
      .map((item) => `${item.path}|${item.platform}|${item.linkage}`)
      .sort();
    const digest = crypto
      .createHash("sha256")
      .update(semanticInventory.join("\n"))
      .digest("hex");
    if (
      semanticInventory.length !== contract.targetInventoryCount ||
      digest !== contract.targetInventorySha256
    ) {
      fail(
        `upstream target ELF semantic inventory drifted; count=${semanticInventory.length}, sha256=${digest}`,
      );
    }
  }
  return inventory;
}

function validateUpstreamInventory(root, architecture, manifest = loadManifest()) {
  return validateInventory(root, architecture, manifest);
}

function planFixups(root, architecture, manifest = loadManifest()) {
  const contract = manifestArchitecture(manifest, architecture);
  const inventory = validateInventory(root, architecture, manifest, {
    allowAdditional: true,
  });
  return inventory.flatMap((item) => {
    if (!item.target || item.platform !== "glibc") return [];
    if (!["dynamic-executable", "dynamic-object"].includes(item.linkage))
      return [];
    const strategy = contract.interpreterStrategies[item.path] || "patchelf";
    if (
      ![
        "patchelf",
        "patchelf-rpath-first",
        "preserve-upstream",
        "relocate-within-detect-libc-range",
      ].includes(strategy)
    )
      fail(`${item.path}: unsupported interpreter strategy: ${strategy}`);
    if (strategy === "preserve-upstream" && item.linkage !== "dynamic-object")
      fail(`${item.path}: preserve-upstream is only valid for dynamic objects`);
    if (strategy === "patchelf-rpath-first" && item.linkage !== "dynamic-executable")
      fail(`${item.path}: ${strategy} is only valid for dynamic executables`);
    return [
      {
        path: item.path,
        strategy,
        setInterpreter: item.interpreter !== null,
        addRpath: true,
      },
    ];
  });
}

function buildPatchelfInvocations(action, dynamicLinker, runtimeLibraryPath) {
  const interpreterArguments = action.setInterpreter
    ? ["--set-interpreter", dynamicLinker]
    : [];
  const rpathArguments = action.addRpath
    ? ["--add-rpath", runtimeLibraryPath]
    : [];
  return action.strategy === "patchelf-rpath-first"
    ? [rpathArguments, interpreterArguments]
    : [[...interpreterArguments, ...rpathArguments]];
}

function runChecked(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout || "no output").trim()}`,
    );
  }
}

function applyFixups({
  root,
  architecture,
  dynamicLinker,
  runtimeLibraryPath,
  patchelf = "patchelf",
  chatgptRelocator,
  manifest = loadManifest(),
}) {
  if (!path.isAbsolute(dynamicLinker)) fail("dynamic linker must be an absolute path");
  if (!runtimeLibraryPath) fail("runtime library path must not be empty");
  if (!chatgptRelocator) fail("ChatGPT interpreter relocator is required");
  const plan = planFixups(root, architecture, manifest);
  for (const action of plan) {
    const filePath = path.join(root, action.path);
    if (action.strategy === "preserve-upstream") continue;
    const invocations = buildPatchelfInvocations(
      action,
      dynamicLinker,
      runtimeLibraryPath,
    );
    const originalMode = fs.statSync(filePath).mode & 0o777;
    if ((originalMode & 0o200) === 0)
      fs.chmodSync(filePath, originalMode | 0o200);
    try {
      for (const args of invocations)
        runChecked(patchelf, [...args, filePath]);
      if (action.strategy === "relocate-within-detect-libc-range") {
        runChecked(process.execPath, [
          chatgptRelocator,
          "relocate",
          filePath,
          dynamicLinker,
        ]);
      }
    } finally {
      fs.chmodSync(filePath, originalMode);
    }
  }
  return plan;
}

function hasSearchPath(item, runtimeLibraryPath) {
  const actual = new Set(
    [...item.rpath, ...item.runpath]
      .flatMap((value) => value.split(":"))
      .filter(Boolean),
  );
  return runtimeLibraryPath
    .split(":")
    .filter(Boolean)
    .every((value) => actual.has(value));
}

function auditExecutableShebangs(root) {
  for (const filePath of walkFiles(root)) {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o111) === 0) continue;
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(Math.min(stat.size, 4096));
    try {
      fs.readSync(fd, header, 0, header.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (header.length < 2 || header[0] !== 0x23 || header[1] !== 0x21)
      continue;
    const newline = header.indexOf(0x0a);
    if (newline < 0) fail(`${path.relative(root, filePath)}: unterminated shebang`);
    const directive = header.subarray(2, newline).toString("utf8").trim();
    const [interpreter] = directive.split(/\s+/u);
    const relativePath = path.relative(root, filePath).split(path.sep).join("/");
    if (!path.isAbsolute(interpreter))
      fail(`${relativePath}: shebang interpreter is not absolute: ${interpreter}`);
    if (interpreter === "/usr/bin/env") continue;
    if (!interpreter.startsWith("/nix/store/"))
      fail(`${relativePath}: executable retains an FHS shebang: ${interpreter}`);
    let interpreterStat;
    try {
      interpreterStat = fs.statSync(interpreter);
    } catch {
      fail(`${relativePath}: Nix shebang interpreter does not exist: ${interpreter}`);
    }
    if (!interpreterStat.isFile() || (interpreterStat.mode & 0o111) === 0)
      fail(`${relativePath}: Nix shebang interpreter is not executable: ${interpreter}`);
  }
}

function auditDependencyClosure({
  root,
  inventory,
  dynamicLinker,
  runtimeLibraryPath,
}) {
  if (!fs.existsSync(dynamicLinker))
    fail(`dynamic linker does not exist for dependency audit: ${dynamicLinker}`);
  for (const item of inventory) {
    if (!item.target || item.platform !== "glibc") continue;
    if (!["dynamic-executable", "dynamic-object"].includes(item.linkage))
      continue;
    const filePath = path.join(root, item.path);
    const result = childProcess.spawnSync(
      dynamicLinker,
      ["--library-path", runtimeLibraryPath, "--list", filePath],
      {
        encoding: "utf8",
        env: { ...process.env, LD_LIBRARY_PATH: "" },
      },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const missing = [
      ...output.matchAll(/(?:^|\s)([^\s]+)\s+=>\s+not found/gm),
      ...output.matchAll(/error while loading shared libraries:\s+([^:\s]+):/gm),
    ].map((match) => match[1]);
    const optionalQtShim = /^libqt[56]_shim\.so$/.test(path.basename(item.path));
    const unexpectedMissing = missing.filter(
      (name) => !(optionalQtShim && /^libQt[56][A-Za-z0-9_-]*\.so(?:\..*)?$/.test(name)),
    );
    if (unexpectedMissing.length > 0) {
      fail(`${item.path}: unresolved dependencies: ${unexpectedMissing.join(", ")}`);
    }
    if (result.status !== 0 && !(optionalQtShim && missing.length > 0)) {
      fail(
        `${item.path}: dependency loader audit failed (${result.status}): ${output.trim() || "no output"}`,
      );
    }
  }
}

function auditFixedTree({
  root,
  architecture,
  dynamicLinker,
  runtimeLibraryPath,
  manifest = loadManifest(),
  checkDependencies = false,
  checkShebangs = true,
}) {
  const contract = manifestArchitecture(manifest, architecture);
  for (const forbidden of manifest.forbiddenPaths || []) {
    if (fs.existsSync(path.join(root, forbidden)))
      fail(`obsolete runtime path is present after fixup: ${forbidden}`);
  }
  const inventory = inventoryTree(root, architecture);
  const preservedEntries = new Set(
    Object.entries(contract.interpreterStrategies)
      .filter(([, strategy]) => strategy === "preserve-upstream")
      .map(([relativePath]) => relativePath),
  );
  for (const required of contract.requiredDynamicExecutables) {
    if (!fs.existsSync(path.join(root, required)))
      fail(`required runtime path is missing after fixup: ${required}`);
  }
  for (const relativePath of preservedEntries) {
    if (!fs.existsSync(path.join(root, relativePath)))
      fail(`preserved upstream runtime path is missing after fixup: ${relativePath}`);
  }
  for (const item of inventory) {
    if (!item.target || item.platform !== "glibc") continue;
    if (!["dynamic-executable", "dynamic-object"].includes(item.linkage))
      continue;
    if (preservedEntries.has(item.path)) continue;
    if (item.interpreter !== null && item.interpreter !== dynamicLinker)
      fail(`${item.path}: interpreter was not fixed: ${item.interpreter}`);
    if (!hasSearchPath(item, runtimeLibraryPath))
      fail(`${item.path}: runtime library path is absent from RPATH/RUNPATH`);
  }
  if (checkDependencies) {
    auditDependencyClosure({
      root,
      inventory,
      dynamicLinker,
      runtimeLibraryPath,
    });
  }
  if (checkShebangs) auditExecutableShebangs(root);
  return inventory;
}

function parseOptions(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined)
      fail(`invalid command-line option near ${key || "<end>"}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parseOptions(argv);
  if (!options.root || !options.arch)
    fail("--root and --arch are required");
  const manifest = loadManifest(options.manifest || DEFAULT_MANIFEST_PATH);
  if (command === "inventory") {
    process.stdout.write(
      `${JSON.stringify(inventoryTree(options.root, options.arch), null, 2)}\n`,
    );
  } else if (command === "validate-upstream") {
    validateUpstreamInventory(options.root, options.arch, manifest);
  } else if (command === "fix") {
    applyFixups({
      root: options.root,
      architecture: options.arch,
      dynamicLinker: options["dynamic-linker"],
      runtimeLibraryPath: options["runtime-library-path"],
      patchelf: options.patchelf,
      chatgptRelocator: options["chatgpt-relocator"],
      manifest,
    });
  } else if (command === "audit") {
    auditFixedTree({
      root: options.root,
      architecture: options.arch,
      dynamicLinker: options["dynamic-linker"],
      runtimeLibraryPath: options["runtime-library-path"],
      manifest,
      checkDependencies: options["check-dependencies"] !== "false",
      checkShebangs: options["check-shebangs"] !== "false",
    });
  } else {
    fail(
      "usage: elf-runtime.cjs <inventory|validate-upstream|fix|audit> --root DIR --arch <amd64|arm64> [options]",
    );
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`[elf-runtime] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_MANIFEST_PATH,
  TARGET_ARCHITECTURES,
  applyFixups,
  auditExecutableShebangs,
  auditFixedTree,
  auditDependencyClosure,
  buildPatchelfInvocations,
  inspectFile,
  inventoryTree,
  loadManifest,
  parseElf,
  planFixups,
  validateUpstreamInventory,
};
