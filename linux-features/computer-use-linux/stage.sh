#!/bin/bash
set -Eeuo pipefail

backend="${CODEX_COMPUTER_USE_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-linux}"
cosmic="${CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-cosmic}"
template="$SCRIPT_DIR/plugins/openai-bundled/plugins/computer-use"
target="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/computer-use"
marketplace="$INSTALL_DIR/resources/plugins/openai-bundled/.agents/plugins/marketplace.json"

write_computer_use_marketplace_entry() {
    local marketplace_path="$1"
    node - "$marketplace_path" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const marketplacePath = process.argv[2];
let marketplace = { plugins: [] };
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));
} catch (_error) {
  marketplace = { plugins: [] };
}
if (!Array.isArray(marketplace.plugins)) {
  marketplace.plugins = [];
}
marketplace.plugins = marketplace.plugins.filter((plugin) => plugin?.name !== "computer-use");
marketplace.plugins.push({
  name: "computer-use",
  source: {
    source: "local",
    path: "./plugins/computer-use",
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL",
  },
  category: "Productivity",
});
fs.mkdirSync(path.dirname(marketplacePath), { recursive: true });
fs.writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
NODE
}

[ -x "$backend" ] || {
    echo "Linux Computer Use is enabled but its release binary is missing: $backend" >&2
    exit 1
}
[ -x "$cosmic" ] || {
    echo "Linux Computer Use is enabled but its COSMIC helper is missing: $cosmic" >&2
    exit 1
}
[ -d "$template" ] || {
    echo "Linux Computer Use plugin template is missing: $template" >&2
    exit 1
}

rm -rf "$target"
mkdir -p "$(dirname "$target")"
cp -a "$template" "$target"
mkdir -p "$target/bin"
cp "$backend" "$target/bin/codex-computer-use-linux"
cp "$cosmic" "$target/bin/codex-computer-use-cosmic"
chmod 0755 "$target/bin/codex-computer-use-linux" "$target/bin/codex-computer-use-cosmic"
find "$target" \( -name '*:com.apple.*' -o -name '.gitkeep' \) -delete
write_computer_use_marketplace_entry "$marketplace"
