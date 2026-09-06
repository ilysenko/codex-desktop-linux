#!/bin/bash
set -Eeuo pipefail

backend="${CODEX_COMPUTER_USE_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-linux}"
cosmic="${CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE:-$SCRIPT_DIR/target/release/codex-computer-use-cosmic}"
target="$INSTALL_DIR/resources/plugins/openai-bundled/plugins/unified-computer-use"

[ -x "$backend" ] || {
    echo "Linux Computer Use is enabled but its release binary is missing: $backend" >&2
    exit 1
}
[ -x "$cosmic" ] || {
    echo "Linux Computer Use is enabled but its COSMIC helper is missing: $cosmic" >&2
    exit 1
}
node "$(dirname "${BASH_SOURCE[0]}")/stage.js"
mkdir -p "$target/bin"
install -m 0755 "$backend" "$target/bin/codex-computer-use-linux"
install -m 0755 "$cosmic" "$target/bin/codex-computer-use-cosmic"
