#!/usr/bin/env bash
set -Eeuo pipefail

node_bin="${CODEX_LINUX_APP_DIR:?}/resources/cua_node/bin/node"
service="${CODEX_LINUX_FEATURES_DIR:?}/computer-use-linux/host-service.mjs"

[ -x "$node_bin" ] || { printf 'Linux Computer Use bundled Node runtime is unavailable\n' >&2; exit 1; }
[ -f "$service" ] || { printf 'Linux Computer Use host service is unavailable\n' >&2; exit 1; }

case "${CODEX_LINUX_FEATURE_HOOK_PHASE:-}" in
  launcher)
    if [ -z "${XDG_RUNTIME_DIR:-}" ] || [ "${XDG_RUNTIME_DIR#/}" = "$XDG_RUNTIME_DIR" ]; then
      printf '%s\n' 'WARN: Linux Computer Use native access is unavailable without an absolute XDG_RUNTIME_DIR' >&2
      exit 0
    fi
    exec "$node_bin" "$service" launcher
    ;;
  after-exit)
    [ -n "${CODEX_LINUX_CUA_HOST_OWNER_TOKEN:-}" ] || exit 0
    exec "$node_bin" "$service" cleanup
    ;;
  *) printf 'Unsupported Linux Computer Use host hook phase\n' >&2; exit 1 ;;
esac
