#!/usr/bin/env bash
set -Eeuo pipefail

: "${SCRIPT_DIR:?SCRIPT_DIR is required}"
: "${INSTALL_DIR:?INSTALL_DIR is required}"

source "$SCRIPT_DIR/linux-features/chronicle-skysight/shared-backend.sh"

backend_binary="$(build_chronicle_skysight_backend)"
native_binary="$INSTALL_DIR/resources/native/codex-record-replay-linux"
plugin_template="$SCRIPT_DIR/linux-features/chronicle-skysight/plugin-template"
plugin_dir="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/chronicle-skysight"
marketplace="$INSTALL_DIR/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

mkdir -p "$(dirname "$native_binary")" "$(dirname "$plugin_dir")" "$(dirname "$marketplace")"
cp "$backend_binary" "$native_binary"
chmod 0755 "$native_binary"

rm -rf "$plugin_dir"
cp -R "$plugin_template" "$plugin_dir"
mkdir -p "$plugin_dir/bin"
cp "$native_binary" "$plugin_dir/bin/codex-record-replay-linux"
chmod 0755 "$plugin_dir/bin/codex-record-replay-linux"

node - "$marketplace" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const marketplacePath = process.argv[2];
let marketplace = { plugins: [] };
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
} catch (_error) {
  marketplace = { plugins: [] };
}
if (!Array.isArray(marketplace.plugins)) marketplace.plugins = [];
marketplace.plugins = marketplace.plugins.filter((plugin) => plugin?.name !== "chronicle-skysight");
marketplace.plugins.push({
  name: "chronicle-skysight",
  source: { source: "local", path: "./plugins/chronicle-skysight" },
  policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
  category: "Productivity",
});
fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE

echo "Chronicle / Skysight standalone plugin and shared backend staged" >&2
