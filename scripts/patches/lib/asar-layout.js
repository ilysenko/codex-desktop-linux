#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SAFE_UNPACK_DIR = /^[A-Za-z0-9@._+/-]+$/;
const NATIVE_FILE = /\.(?:node|so|dylib)$/;

function parsePackState(source) {
  const lines = source.trimEnd().split("\n");
  if (lines.length === 1 && lines[0] === "") {
    throw new Error("Official app.asar layout is empty");
  }
  return lines.map((line) => {
    const match = /^(pack|unpack)\s+: \/(.*)$/.exec(line);
    if (match == null || match[2] === "" || match[2].split("/").includes("..")) {
      throw new Error(`Invalid app.asar layout entry: ${line}`);
    }
    return { path: match[2], unpacked: match[1] === "unpack" };
  });
}

function requireUniquePaths(entries, description) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`${description} app.asar layout contains a duplicate entry: ${entry.path}`);
    }
    seen.add(entry.path);
  }
  return seen;
}

function verifyRepackedLayout(upstreamSource, outputSource) {
  const upstream = parsePackState(upstreamSource);
  const output = parsePackState(outputSource);
  const upstreamPaths = requireUniquePaths(upstream, "Official");
  requireUniquePaths(output, "Repacked");

  let upstreamIndex = 0;
  for (const entry of output) {
    const expected = upstream[upstreamIndex];
    if (expected != null && entry.path === expected.path) {
      if (entry.unpacked !== expected.unpacked) {
        throw new Error(
          `Repacked app.asar changed official unpack metadata: ${entry.path}`,
        );
      }
      upstreamIndex += 1;
      continue;
    }
    if (upstreamPaths.has(entry.path)) {
      throw new Error(`Repacked app.asar changed official entry ordering: ${entry.path}`);
    }
  }

  if (upstreamIndex !== upstream.length) {
    throw new Error(
      `Repacked app.asar is missing official layout entry: ${upstream[upstreamIndex].path}`,
    );
  }
}

function hasAncestor(relativePath, directories) {
  return directories.some((directory) =>
    relativePath === directory || relativePath.startsWith(`${directory}/`),
  );
}

function deriveUpstreamLayout(source, extractedDir) {
  const entries = parsePackState(source);
  const unpackDirectories = [];
  const unpackFiles = [];

  for (const entry of entries) {
    const extractedPath = path.join(extractedDir, ...entry.path.split("/"));
    let stat;
    try {
      stat = fs.lstatSync(extractedPath);
    } catch (error) {
      throw new Error(`Official app.asar layout entry is missing after extraction: ${entry.path}`, {
        cause: error,
      });
    }
    if (!entry.unpacked) {
      continue;
    }
    if (stat.isDirectory()) {
      if (!hasAncestor(entry.path, unpackDirectories)) {
        if (!SAFE_UNPACK_DIR.test(entry.path)) {
          throw new Error(`Cannot safely preserve upstream unpack directory: ${entry.path}`);
        }
        unpackDirectories.push(entry.path);
      }
    } else if (!hasAncestor(entry.path, unpackDirectories)) {
      unpackFiles.push(entry.path);
    }
  }

  const unsupportedUnpackFiles = unpackFiles.filter((entry) => !NATIVE_FILE.test(entry));
  if (unsupportedUnpackFiles.length > 0) {
    throw new Error(
      `Cannot preserve non-native upstream unpack files: ${unsupportedUnpackFiles.join(", ")}`,
    );
  }
  const packedNativeFiles = entries
    .filter((entry) => !entry.unpacked && NATIVE_FILE.test(entry.path))
    .map((entry) => entry.path);
  if (packedNativeFiles.length > 0) {
    throw new Error(
      `Cannot preserve packed native upstream files with the ASAR packer: ${packedNativeFiles.join(", ")}`,
    );
  }

  return {
    ordering: entries.map((entry) => entry.path),
    unpackDirectories,
    unpackDirectoryPattern: unpackDirectories.length === 0
      ? ""
      : unpackDirectories.length === 1
        ? unpackDirectories[0]
        : `{${unpackDirectories.join(",")}}`,
  };
}

function main(args) {
  if (args[0] === "verify" && args.length === 3) {
    verifyRepackedLayout(
      fs.readFileSync(args[1], "utf8"),
      fs.readFileSync(args[2], "utf8"),
    );
    return;
  }
  if (args.length !== 4) {
    throw new Error(
      "Usage: asar-layout.js verify <upstream-pack-state> <output-pack-state> | " +
        "asar-layout.js <pack-state> <extracted-dir> <ordering-output> <unpack-dir-pattern-output>",
    );
  }
  const [packStatePath, extractedDir, orderingPath, unpackDirectoryPatternPath] = args;
  const layout = deriveUpstreamLayout(fs.readFileSync(packStatePath, "utf8"), extractedDir);
  fs.writeFileSync(orderingPath, `${layout.ordering.join("\n")}\n`);
  fs.writeFileSync(unpackDirectoryPatternPath, layout.unpackDirectoryPattern);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  deriveUpstreamLayout,
  parsePackState,
  verifyRepackedLayout,
};
