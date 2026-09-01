#!/usr/bin/env bash
set -Eeuo pipefail

: "${INSTALL_DIR:?INSTALL_DIR is required}"

bin_dir="$INSTALL_DIR/resources/cua_node/bin"
node_repl="$bin_dir/node_repl"
original_node_repl="$bin_dir/node_repl.codex-linux-original"
wrapper_marker="browser-proxy-node-repl-wrapper"

is_browser_proxy_wrapper() {
    local candidate="$1"
    [ -f "$candidate" ] || return 1
    LC_ALL=C grep -a -Fq -- "$wrapper_marker" < <(head -c 512 -- "$candidate")
}

[ -e "$original_node_repl" ] || exit 0

if [ ! -e "$node_repl" ]; then
    mv -- "$original_node_repl" "$node_repl"
    exit 0
fi

if ! is_browser_proxy_wrapper "$node_repl"; then
    echo "browser-proxy cleanup: current node_repl is not this feature's wrapper; leaving both files unchanged" >&2
    exit 1
fi

mv -f -- "$original_node_repl" "$node_repl"
