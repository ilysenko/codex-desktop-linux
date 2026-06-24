#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const archMap = new Map([
  ["x64", "x86_64"],
  ["arm64", "aarch64"],
  ["arm", "arm"],
  ["armv7l", "arm"],
  ["ia32", "i386"],
]);

function usage() {
  console.error("Usage: generate-npm-cache-sources.mjs <package-lock.json> <output.json> [--allow-os=linux]");
  process.exit(1);
}

const [, , lockPath, outputPath, ...rest] = process.argv;
if (!lockPath || !outputPath) usage();

const allowOs = new Set();
for (const arg of rest) {
  if (arg.startsWith("--allow-os=")) {
    for (const value of arg.slice("--allow-os=".length).split(",")) {
      if (value) allowOs.add(value);
    }
    continue;
  }
  usage();
}

const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const packages = lock.packages ?? {};
const seen = new Set();
const sources = [];

for (const [packagePath, pkg] of Object.entries(packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!packagePath || !pkg || typeof pkg !== "object") continue;
  if (typeof pkg.resolved !== "string" || typeof pkg.integrity !== "string") continue;

  const osList = Array.isArray(pkg.os) ? pkg.os.filter((value) => typeof value === "string") : [];
  if (allowOs.size > 0 && osList.length > 0 && !osList.some((value) => allowOs.has(value))) {
    continue;
  }

  const cpuList = Array.isArray(pkg.cpu) ? pkg.cpu.filter((value) => typeof value === "string") : [];
  const arches = [...new Set(cpuList.map((value) => archMap.get(value)).filter(Boolean))];
  if (cpuList.length > 0 && arches.length === 0) {
    continue;
  }

  const [algorithm, encoded] = pkg.integrity.split("-", 2);
  if (!algorithm || !encoded) {
    throw new Error(`Unsupported integrity for ${packagePath}: ${pkg.integrity}`);
  }

  const hex = Buffer.from(encoded, "base64").toString("hex");
  const key = [pkg.resolved, algorithm, hex, arches.join(",")].join("|");
  if (seen.has(key)) continue;
  seen.add(key);

  const source = {
    type: "file",
    url: pkg.resolved,
    dest: `npm-cache/_cacache/content-v2/${algorithm}/${hex.slice(0, 2)}/${hex.slice(2, 4)}`,
    "dest-filename": hex.slice(4),
  };
  source[algorithm] = hex;
  if (arches.length > 0) {
    source["only-arches"] = arches;
  }

  sources.push(source);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(sources, null, 2)}\n`);
