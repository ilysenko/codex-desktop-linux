#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const clientPath = process.argv[2];
if (!clientPath) {
  throw new Error("Usage: patch-browser-client-iab-socket-scope.js /path/to/browser-client.mjs");
}

const marker = "/*codexLinuxIabSocketScope*/";
const source = fs.readFileSync(clientPath, "utf8");
if (source.includes(marker)) {
  process.exit(0);
}

const socketListingPattern =
  /([A-Za-z_$][\w$]*)=\(\)=>\s*([A-Za-z_$][\w$]*)\(\)==="win32"\?([A-Za-z_$][\w$]*)\(\):([A-Za-z_$][\w$]*)\(\),\4=async\(\)=>\(await ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\)\.map\(([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\.resolve\(\6,\7\)\),\3=async\(\)=>/g;
const matches = [...source.matchAll(socketListingPattern)];
if (matches.length !== 1) {
  if (source.includes("codex-browser-use")) {
    process.stderr.write(
      `WARN: Expected one IAB Browser socket listing target, found ${matches.length}; leaving browser-client.mjs unchanged\n`,
    );
  }
  process.exit(0);
}

const [
  target,
  dispatcher,
  platform,
  windowsListing,
  unixListing,
  readDirectory,
  socketDirectory,
  entry,
  pathModule,
] = matches[0];
const replacement =
  `${dispatcher}=()=>${platform}()==="win32"?${windowsListing}():${unixListing}(),` +
  `${unixListing}=async()=>(await ${readDirectory}(${socketDirectory}))` +
  `.filter(${entry}=>!${entry}.startsWith("extension-")${marker})` +
  `.map(${entry}=>${pathModule}.resolve(${socketDirectory},${entry})),` +
  `${windowsListing}=async()=>`;
fs.writeFileSync(clientPath, source.replace(target, replacement), "utf8");
