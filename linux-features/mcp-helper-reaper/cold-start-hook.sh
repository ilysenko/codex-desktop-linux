#!/usr/bin/env bash
set -euo pipefail

app_dir="${CODEX_LINUX_APP_DIR:?cold-start hook requires CODEX_LINUX_APP_DIR}"
feature_dir="$app_dir/.codex-linux/mcp-helper-reaper"
reaper="$feature_dir/codex-mcp-helper-reaper"
hook_installer="$feature_dir/install-session-hook.sh"

[ "${CODEX_MCP_HELPER_REAPER_DISABLE:-}" = "1" ] && exit 0

if [ -x "$hook_installer" ]; then
    "$hook_installer" || true
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
