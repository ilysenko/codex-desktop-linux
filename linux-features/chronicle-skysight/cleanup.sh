#!/usr/bin/env bash
set -Eeuo pipefail

: "${INSTALL_DIR:?INSTALL_DIR is required}"

native_binary="$INSTALL_DIR/resources/native/codex-record-replay-linux"
plugin_dir="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/chronicle-skysight"
marketplace="$INSTALL_DIR/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

rm -f "$native_binary"
rm -rf "$plugin_dir"

[ -f "$marketplace" ] || exit 0
node - "$marketplace" <<'NODE'
const fs = require("node:fs");
const marketplacePath = process.argv[2];
let marketplace;
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
} catch (_error) {
  process.exit(0);
}
if (!Array.isArray(marketplace.plugins)) process.exit(0);
marketplace.plugins = marketplace.plugins.filter((plugin) => plugin?.name !== "chronicle-skysight");
fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE
