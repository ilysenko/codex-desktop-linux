#!/usr/bin/env bash
set -eu

runtime_root="${XDG_RUNTIME_DIR:-${CODEX_LINUX_APP_STATE_DIR:?}}"
runtime_dir="$runtime_root/${CODEX_LINUX_APP_ID:-codex-desktop}/app-server-bridge"
socket_path="${CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET:-$runtime_dir/app-server.sock}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
reaper_path="$script_dir/orphan-reaper.js"
node_bin="$(command -v node || true)"

if [ -n "${CODEX_LINUX_APP_DIR:-}" ]; then
    staged_reaper="$CODEX_LINUX_APP_DIR/.codex-linux/features/shared-app-server-socket/orphan-reaper.js"
    managed_node="$CODEX_LINUX_APP_DIR/resources/node-runtime/bin/node"
    if [ -f "$staged_reaper" ]; then
        reaper_path="$staged_reaper"
    fi
    if [ -x "$managed_node" ]; then
        node_bin="$managed_node"
    fi
fi

if [ -n "$node_bin" ] && [ -f "$reaper_path" ]; then
    if ! "$node_bin" "$reaper_path" "$socket_path"; then
        printf 'WARN: shared app-server orphan cleanup failed closed for %s\n' "$socket_path" >&2
    fi
fi

if [ "${CODEX_LINUX_FEATURE_HOOK_PHASE:-launcher}" = "launcher" ]; then
    printf 'env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=%s\n' "$socket_path"
fi
