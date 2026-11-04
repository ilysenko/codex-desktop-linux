#!/bin/bash
set -Eeuo pipefail

# AppShots needs window metadata and AT-SPI, without enabling the Computer Use
# plugin, host service, control UI, or activity indicator.
backend="${CODEX_COMPUTER_USE_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-linux}"
cosmic="${CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-cosmic}"
target="$INSTALL_DIR/resources/native/appshots"

for helper in "$backend" "$cosmic"; do
    [ -x "$helper" ] || {
        echo "AppShots native helper is missing or not executable: $helper" >&2
        exit 1
    }
done

# Explicit helper sources and updater-retained helpers must match the official
# package architecture, including when an arm64 package is staged on amd64.
node - "$backend" "$cosmic" "${ARCH:-$(uname -m)}" <<'NODE'
const fs = require("node:fs");
const [backend, cosmic, architecture] = process.argv.slice(2);
const machine = { x86_64: 62, amd64: 62, aarch64: 183, arm64: 183 }[architecture];
if (machine == null) throw new Error(`Unsupported AppShots architecture: ${architecture}`);
for (const file of [backend, cosmic]) {
  const descriptor = fs.openSync(file, "r");
  const header = Buffer.alloc(20);
  let length;
  try { length = fs.readSync(descriptor, header, 0, header.length, 0); }
  finally { fs.closeSync(descriptor); }
  if (length !== header.length || !header.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])) || header.readUInt16LE(18) !== machine) {
    throw new Error(`AppShots helper is not a ${architecture} Linux ELF executable: ${file}`);
  }
}
NODE

mkdir -p "$target"
install -m 0755 "$backend" "$target/codex-computer-use-linux"
install -m 0755 "$cosmic" "$target/codex-computer-use-cosmic"
