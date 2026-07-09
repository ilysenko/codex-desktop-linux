#!/usr/bin/env bash
set -euo pipefail

app_dir="${1:?usage: cold-start hook <app-dir> <state-dir> <log-dir>}"
state_dir="${2:?usage: cold-start hook <app-dir> <state-dir> <log-dir>}"
log_dir="${3:-}"
feature_dir="$app_dir/.codex-linux/mcp-helper-reaper"
reaper="$feature_dir/codex-mcp-helper-reaper"
hook_installer="$feature_dir/install-session-hook.sh"

[ "${CODEX_MCP_HELPER_REAPER_DISABLE:-}" = "1" ] && exit 0

if [ -x "$hook_installer" ]; then
    "$hook_installer" "$app_dir" "$state_dir" "$log_dir" || true
fi

[ -x "$reaper" ] || exit 0

delay="${CODEX_MCP_HELPER_REAPER_DELAY:-3}"
passes="${CODEX_MCP_HELPER_REAPER_PASSES:-3}"
interval="${CODEX_MCP_HELPER_REAPER_INTERVAL:-2}"
term_timeout="${CODEX_MCP_HELPER_REAPER_TERM_TIMEOUT:-2}"

"$reaper" \
    --all-codex-parents \
    --include-orphans \
    --app-dir "$app_dir" \
    --delay "$delay" \
    --passes "$passes" \
    --interval "$interval" \
    --term-timeout "$term_timeout" \
    --quiet >/dev/null 2>&1 &
