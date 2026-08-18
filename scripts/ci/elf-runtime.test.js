"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  auditExecutableShebangs,
  auditFixedTree,
  buildPatchelfInvocations,
  inventoryTree,
  loadManifest,
  parseElf,
  planFixups,
  validateUpstreamInventory,
} = require("../../nix/elf-runtime.cjs");

const ELF_HEADER_SIZE = 64;
const PROGRAM_HEADER_SIZE = 56;
const PROGRAM_HEADER_OFFSET = ELF_HEADER_SIZE;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const DT_NULL = 0n;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;
const DT_STRSZ = 10n;
const DT_RUNPATH = 29n;
const DT_FLAGS_1 = 0x6ffffffbn;
const DF_1_PIE = 0x08000000n;

function writeProgram(buffer, index, type, offset, fileSize, vaddr = offset) {
  const header = PROGRAM_HEADER_OFFSET + index * PROGRAM_HEADER_SIZE;
  buffer.writeUInt32LE(type, header);
  buffer.writeUInt32LE(4, header + 4);
  buffer.writeBigUInt64LE(BigInt(offset), header + 8);
  buffer.writeBigUInt64LE(BigInt(vaddr), header + 16);
  buffer.writeBigUInt64LE(BigInt(vaddr), header + 24);
  buffer.writeBigUInt64LE(BigInt(fileSize), header + 32);
  buffer.writeBigUInt64LE(BigInt(fileSize), header + 40);
  buffer.writeBigUInt64LE(8n, header + 48);
}

function writeDynamic(buffer, index, tag, value) {
  const offset = 0x380 + index * 16;
  buffer.writeBigInt64LE(tag, offset);
  buffer.writeBigUInt64LE(BigInt(value), offset + 8);
}

function dynamicElf({
  machine = 62,
  interpreter = "/lib64/ld-linux-x86-64.so.2",
  needed = "libc.so.6",
  runpath = null,
  flags1 = 0,
  relativeSectionTableOffset = 0xffffffffffffn,
} = {}) {
  const buffer = Buffer.alloc(0x800);
  const hasInterpreter = interpreter !== null;
  const strings = Buffer.from(
    `\0${needed || ""}\0${runpath || ""}\0`,
  );
  const stringOffset = 0x300;
  const neededOffset = 1;
  const runpathOffset = neededOffset + (needed || "").length + 1;
  const dynamicEntries = [
    [DT_STRTAB, stringOffset],
    [DT_STRSZ, strings.length],
  ];
  if (needed) dynamicEntries.push([DT_NEEDED, neededOffset]);
  if (runpath) dynamicEntries.push([DT_RUNPATH, runpathOffset]);
  if (flags1) dynamicEntries.push([DT_FLAGS_1, flags1]);
  dynamicEntries.push([DT_NULL, 0]);

  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(3, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(BigInt(PROGRAM_HEADER_OFFSET), 32);
  // Deliberately invalid: the runtime parser must not read section headers.
  buffer.writeBigUInt64LE(BigInt(relativeSectionTableOffset), 40);
  buffer.writeUInt16LE(ELF_HEADER_SIZE, 52);
  buffer.writeUInt16LE(PROGRAM_HEADER_SIZE, 54);
  buffer.writeUInt16LE(hasInterpreter ? 3 : 2, 56);
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(99, 60);
  buffer.writeUInt16LE(98, 62);

  writeProgram(buffer, 0, PT_LOAD, 0, buffer.length, 0);
  if (hasInterpreter) {
    const interpreterBytes = Buffer.from(`${interpreter}\0`);
    interpreterBytes.copy(buffer, 0x280);
    writeProgram(buffer, 1, PT_INTERP, 0x280, interpreterBytes.length);
  }
  writeProgram(
    buffer,
    hasInterpreter ? 2 : 1,
    PT_DYNAMIC,
    0x380,
    dynamicEntries.length * 16,
  );
  strings.copy(buffer, stringOffset);
  dynamicEntries.forEach(([tag, value], index) =>
    writeDynamic(buffer, index, tag, value),
  );
  return buffer;
}

function staticElf(machine = 62) {
  const buffer = Buffer.alloc(0x200);
  buffer.writeUInt32BE(0x7f454c46, 0);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(2, 16);
  buffer.writeUInt16LE(machine, 18);
  buffer.writeUInt32LE(1, 20);
  buffer.writeBigUInt64LE(BigInt(PROGRAM_HEADER_OFFSET), 32);
  buffer.writeBigUInt64LE(0xffffffffffffn, 40);
  buffer.writeUInt16LE(ELF_HEADER_SIZE, 52);
  buffer.writeUInt16LE(PROGRAM_HEADER_SIZE, 54);
  buffer.writeUInt16LE(1, 56);
  writeProgram(buffer, 0, PT_LOAD, 0, buffer.length, 0);
  return buffer;
}

function splitDynamicStringsAcrossLoads(buffer, discontinuous = false) {
  const interpreterBytes = Buffer.from("/lib64/ld-linux-x86-64.so.2\0");
  buffer.writeUInt16LE(4, 56);
  writeProgram(buffer, 0, PT_LOAD, 0, 0x305, 0);
  writeProgram(
    buffer,
    1,
    PT_LOAD,
    discontinuous ? 0x306 : 0x305,
    buffer.length - 0x306,
    0x305,
  );
  writeProgram(buffer, 2, PT_INTERP, 0x280, interpreterBytes.length);
  writeProgram(buffer, 3, PT_DYNAMIC, 0x380, 5 * 16);
  return buffer;
}

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "elf-runtime-test-"));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeFixture(root, relativePath, contents, mode = 0o755) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents, { mode });
}

test("parses PT_INTERP and PT_DYNAMIC without consulting section headers", () => {
  const parsed = parseElf(
    dynamicElf({ runpath: "/nix/store/runtime/lib" }),
    "ChatGPT",
  );
  assert.deepEqual(
    {
      architecture: parsed.architecture,
      platform: parsed.platform,
      linkage: parsed.linkage,
      interpreter: parsed.interpreter,
      needed: parsed.needed,
      runpath: parsed.runpath,
    },
    {
      architecture: "amd64",
      platform: "glibc",
      linkage: "dynamic-executable",
      interpreter: "/lib64/ld-linux-x86-64.so.2",
      needed: ["libc.so.6"],
      runpath: ["/nix/store/runtime/lib"],
    },
  );
});

test("parses a dynamic string table spanning adjacent patchelf PT_LOADs", () => {
  const parsed = parseElf(
    splitDynamicStringsAcrossLoads(
      dynamicElf({ runpath: "/nix/store/runtime/lib" }),
    ),
    "patchelf-output",
  );
  assert.deepEqual(parsed.needed, ["libc.so.6"]);
  assert.deepEqual(parsed.runpath, ["/nix/store/runtime/lib"]);
});

test("rejects a dynamic string table spanning discontinuous file mappings", () => {
  assert.throws(
    () =>
      parseElf(
        splitDynamicStringsAcrossLoads(dynamicElf(), true),
        "invalid-patchelf-output",
      ),
    /not contiguously file-backed by PT_LOAD/,
  );
});

test("classifies target, foreign, static, static PIE, musl, and Android ELF", () => {
  assert.equal(parseElf(dynamicElf({ machine: 183 }), "arm").architecture, "arm64");
  assert.equal(parseElf(dynamicElf({ machine: 40 }), "foreign").architecture, "machine-40");
  assert.equal(parseElf(staticElf(), "static").linkage, "static");
  assert.equal(
    parseElf(
      dynamicElf({ interpreter: null, needed: null, flags1: DF_1_PIE }),
      "static-pie",
    ).linkage,
    "static-pie",
  );
  assert.equal(
    parseElf(
      dynamicElf({ interpreter: "/lib/ld-musl-x86_64.so.1" }),
      "linux-x64-musl/tool",
    ).platform,
    "musl",
  );
  assert.equal(
    parseElf(dynamicElf({ interpreter: "/system/bin/linker64" }), "android/tool")
      .platform,
    "android",
  );
  assert.equal(parseElf(Buffer.from("Mach-O"), "foreign"), null);
});

test("fails closed for malformed program and dynamic tables", () => {
  const truncatedProgram = dynamicElf();
  truncatedProgram.writeBigUInt64LE(0x1000n, PROGRAM_HEADER_OFFSET + 32);
  assert.throws(
    () => parseElf(truncatedProgram, "truncated"),
    /program header 0 is outside/,
  );

  const missingTerminator = dynamicElf();
  for (let offset = 0x380; offset < 0x380 + 5 * 16; offset += 16)
    missingTerminator.writeBigInt64LE(DT_NEEDED, offset);
  assert.throws(
    () => parseElf(missingTerminator, "unterminated"),
    /PT_DYNAMIC is not DT_NULL-terminated/,
  );
});

for (const architecture of ["amd64", "arm64"]) {
  test(`validates the exact ${architecture} upstream executable inventory`, () => {
    withTemporaryDirectory((root) => {
      const manifest = loadManifest();
      delete manifest.architectures[architecture].targetInventoryCount;
      delete manifest.architectures[architecture].targetInventorySha256;
      const contract = manifest.architectures[architecture];
      const interpreter =
        architecture === "amd64"
          ? "/lib64/ld-linux-x86-64.so.2"
          : "/lib/ld-linux-aarch64.so.1";
      for (const relativePath of contract.requiredDynamicExecutables) {
        writeFixture(
          root,
          relativePath,
          dynamicElf({ machine: contract.machine, interpreter }),
        );
      }
      writeFixture(root, "resources/static-helper", staticElf(contract.machine));
      if (architecture === "amd64") {
        writeFixture(
          root,
          "resources/plugins/openai-bundled/plugins/latex/bin/tectonic",
          staticElf(contract.machine),
        );
      }
      writeFixture(
        root,
        "resources/prebuilds/linux-x64-musl/addon.node",
        dynamicElf({ interpreter: "/lib/ld-musl-x86_64.so.1" }),
      );
      writeFixture(root, "resources/foreign-helper", dynamicElf({ machine: 40 }));

      const inventory = validateUpstreamInventory(root, architecture, manifest);
      assert.equal(
        inventory.filter(
          (item) =>
            item.target &&
            item.platform === "glibc" &&
            item.linkage === "dynamic-executable",
        )
          .length,
        contract.requiredDynamicExecutables.length,
      );
      const actions = planFixups(root, architecture, manifest);
      assert.equal(
        actions.find(({ path: itemPath }) => itemPath === "ChatGPT").strategy,
        "relocate-within-detect-libc-range",
      );
      if (architecture === "amd64") {
        assert.equal(
          actions.find(
            ({ path: itemPath }) =>
              itemPath === "resources/cua_node/bin/node",
          ).strategy,
          "patchelf-rpath-first",
        );
        assert.equal(
          actions.some(({ path: itemPath }) => itemPath.endsWith("/tectonic")),
          false,
        );
      }
    });
  });
}

test("rejects missing, unexpected, and obsolete upstream executables", () => {
  withTemporaryDirectory((root) => {
    const manifest = loadManifest();
    const contract = manifest.architectures.amd64;
    delete contract.targetInventoryCount;
    delete contract.targetInventorySha256;
    for (const relativePath of contract.requiredDynamicExecutables) {
      writeFixture(root, relativePath, dynamicElf());
    }
    fs.unlinkSync(path.join(root, "browser_crashpad_handler"));
    writeFixture(root, "unexpected-helper", dynamicElf());
    assert.throws(
      () => validateUpstreamInventory(root, "amd64", manifest),
      /missing=\[browser_crashpad_handler\].*unexpected=\[unexpected-helper\]/,
    );
    writeFixture(root, "chrome_crashpad_handler", dynamicElf());
    assert.throws(
      () => validateUpstreamInventory(root, "amd64", manifest),
      /obsolete upstream path/,
    );
  });
});

test("the amd64 CUA Node fixup adds RUNPATH before changing PT_INTERP", () => {
  assert.deepEqual(
    buildPatchelfInvocations(
      {
        strategy: "patchelf-rpath-first",
        setInterpreter: true,
        addRpath: true,
      },
      "/nix/store/glibc/lib/ld-linux-x86-64.so.2",
      "/nix/store/runtime/lib",
    ),
    [
      ["--add-rpath", "/nix/store/runtime/lib"],
      [
        "--set-interpreter",
        "/nix/store/glibc/lib/ld-linux-x86-64.so.2",
      ],
    ],
  );
});

test("post-fix audit enforces the Nix interpreter and runtime search path", () => {
  withTemporaryDirectory((root) => {
    const manifest = loadManifest();
    const contract = manifest.architectures.amd64;
    const dynamicLinker = "/nix/store/glibc/lib/ld-linux-x86-64.so.2";
    const runtimeLibraryPath =
      "/run/opengl-driver/lib:/nix/store/runtime/lib";
    for (const relativePath of contract.requiredDynamicExecutables) {
      writeFixture(
        root,
        relativePath,
        dynamicElf({ interpreter: dynamicLinker, runpath: runtimeLibraryPath }),
      );
    }
    writeFixture(
      root,
      "resources/native/addon.node",
      dynamicElf({ interpreter: null, runpath: runtimeLibraryPath }),
    );
    writeFixture(
      root,
      "resources/cua_node/lib/node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3",
      dynamicElf({ interpreter: null, runpath: "$ORIGIN/" }),
    );
    assert.doesNotThrow(() =>
      auditFixedTree({
        root,
        architecture: "amd64",
        dynamicLinker,
        runtimeLibraryPath,
        manifest,
        checkShebangs: false,
      }),
    );

    writeFixture(root, "browser_crashpad_handler", dynamicElf());
    assert.throws(
      () =>
        auditFixedTree({
          root,
          architecture: "amd64",
          dynamicLinker,
          runtimeLibraryPath,
          manifest,
          checkShebangs: false,
        }),
      /interpreter was not fixed/,
    );
  });
});

test("executable shebang audit accepts Nix-safe scripts and rejects FHS interpreters", () => {
  withTemporaryDirectory((root) => {
    writeFixture(root, "env-script", "#!/usr/bin/env bash\nexit 0\n");
    assert.doesNotThrow(() => auditExecutableShebangs(root));
    writeFixture(root, "fhs-script", "#!/bin/bash\nexit 0\n");
    assert.throws(
      () => auditExecutableShebangs(root),
      /executable retains an FHS shebang: \/bin\/bash/,
    );
    fs.unlinkSync(path.join(root, "fhs-script"));
    writeFixture(root, "relative-script", "#!bash\nexit 0\n");
    assert.throws(
      () => auditExecutableShebangs(root),
      /shebang interpreter is not absolute: bash/,
    );
  });
});

test("inventoryTree reports native and foreign machines without following names", () => {
  withTemporaryDirectory((root) => {
    writeFixture(root, "native", dynamicElf());
    writeFixture(root, "arm64", dynamicElf({ machine: 183 }));
    const inventory = inventoryTree(root, "amd64");
    assert.deepEqual(
      inventory.map(({ path: itemPath, target }) => [itemPath, target]),
      [
        ["arm64", false],
        ["native", true],
      ],
    );
  });
});
