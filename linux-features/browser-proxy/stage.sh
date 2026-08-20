#!/usr/bin/env bash
set -Eeuo pipefail

: "${SCRIPT_DIR:?SCRIPT_DIR is required}"
: "${INSTALL_DIR:?INSTALL_DIR is required}"

feature_dir="$SCRIPT_DIR/linux-features/browser-proxy"
bin_dir="$INSTALL_DIR/resources/cua_node/bin"
node_repl="$bin_dir/node_repl"
original_node_repl="$bin_dir/node_repl.codex-linux-original"
wrapper_source="$feature_dir/node-repl-proxy-wrapper.sh"
wrapper_marker="browser-proxy-node-repl-wrapper"
temporary_wrapper="$bin_dir/.node_repl.browser-proxy.$$"

is_browser_proxy_wrapper() {
    local candidate="$1"
    [ -f "$candidate" ] || return 1
    LC_ALL=C grep -a -Fq -- "$wrapper_marker" < <(head -c 512 -- "$candidate")
}

cleanup_temporary_wrapper() {
    rm -f -- "$temporary_wrapper"
    if [ ! -e "$node_repl" ] && [ -e "$original_node_repl" ]; then
        mv -- "$original_node_repl" "$node_repl" || true
    fi
}
trap cleanup_temporary_wrapper EXIT

[ -x "$wrapper_source" ] || {
    echo "browser-proxy wrapper is missing or not executable: $wrapper_source" >&2
    exit 1
}

[ -d "$bin_dir" ] || {
    echo "browser-proxy cannot find the Browser Use runtime directory: $bin_dir" >&2
    exit 1
}

if [ -e "$original_node_repl" ]; then
    if [ ! -e "$node_repl" ]; then
        mv -- "$original_node_repl" "$node_repl"
    elif ! is_browser_proxy_wrapper "$node_repl"; then
        echo "browser-proxy found an existing node_repl backup but does not own the current entrypoint" >&2
        echo "leaving both files unchanged: $node_repl" >&2
        exit 1
    fi
fi

if [ ! -e "$original_node_repl" ]; then
    [ -x "$node_repl" ] || {
        echo "browser-proxy cannot find an executable Browser Use node_repl: $node_repl" >&2
        exit 1
    }
    mv -- "$node_repl" "$original_node_repl"
fi

[ -x "$original_node_repl" ] || {
    echo "browser-proxy original node_repl is not executable: $original_node_repl" >&2
    exit 1
}

install -m 0755 -- "$wrapper_source" "$temporary_wrapper"
mv -f -- "$temporary_wrapper" "$node_repl"
trap - EXIT

echo "browser-proxy staged: Browser Use node_repl will inherit explicit proxy variables from its app-server parent" >&2
