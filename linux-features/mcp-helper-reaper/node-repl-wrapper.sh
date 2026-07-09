#!/usr/bin/env bash
# mcp-helper-reaper-node-repl-wrapper
set -u

self="${BASH_SOURCE[0]}"
if resolved="$(readlink -f "$self" 2>/dev/null)"; then
    self="$resolved"
fi

resources_dir="$(cd "$(dirname "$self")" && pwd)"
app_dir="$(cd "$resources_dir/.." && pwd)"
original="$resources_dir/node_repl.codex-linux-original"
reaper="$app_dir/.codex-linux/mcp-helper-reaper/codex-mcp-helper-reaper"

if [ ! -x "$original" ]; then
    echo "mcp-helper-reaper: original node_repl not found at $original" >&2
    exit 127
fi

if [ "${CODEX_MCP_HELPER_REAPER_DISABLE:-}" != "1" ] && [ -x "$reaper" ]; then
    delay="${CODEX_MCP_HELPER_REAPER_DELAY:-3}"
    passes="${CODEX_MCP_HELPER_REAPER_PASSES:-3}"
    interval="${CODEX_MCP_HELPER_REAPER_INTERVAL:-2}"
    term_timeout="${CODEX_MCP_HELPER_REAPER_TERM_TIMEOUT:-2}"
    "$reaper" \
        --codex-parent "$PPID" \
        --app-dir "$app_dir" \
        --delay "$delay" \
        --passes "$passes" \
        --interval "$interval" \
        --term-timeout "$term_timeout" \
        --quiet >/dev/null 2>&1 &
fi

exec "$original" "$@"
